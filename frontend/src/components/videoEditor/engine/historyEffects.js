/*
 * The chain's history effects (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 15 — moved verbatim out of the
 * Player by tests' convert_leaf.py: `xRef.current` → `engine.x`, `ensurePassTarget(` → `ensurePassTarget(engine, `):
 * Echo (a ring of recorded plates or an analytic re-pose), TimeShift (a ring atlas the streak samples) and Repetile
 * (a tile field with a delay ring). Their rings live in the pass pool (./passPool.js) under their owners' keys, and
 * the owners' state (echoState / timeshiftState / repetileHist) is what the pool's sweep judges them by.
 *
 *   renderEchoStack(engine, read, write, eff, def, ctx)        → true when it drew into `write`, false = bypass
 *   renderTimeShift(engine, …) / renderLayerRepetile(engine, …)  same contracts as before the move
 */
import { resolveEffectParams } from '../adjustmentEffects';
import { hashAlphaSource, sampleAlphaBounds } from '../alphaOutline';
import { ECHO_ENGINE_ANALYTIC, ECHO_FRAME_DT, ECHO_IDENTITY_BOX, ECHO_RING_MAX, echoRingSignature, echoRingSize, planEchoTaps } from '../echoEffect';
import { createEchoAccMaterial } from '../echoMaterial';
import { applyTrailWarpUniforms, createTrailComposeMaterial, createTrailWarpMaterial } from '../motionTrailLayer';
import { REP_DELAY_RING, REP_FLOATS_PER_TILE, REP_FRAME_DT, REP_HISTORY_SCALE, applyRepetileBlendMode, buildRepetileField, createRepetilePass, repetileDelayStride, repetileFeatherLocal } from '../repetileLayer';
import { TIMESHIFT_FRAME_DT, timeshiftAtlas, timeshiftIsBypass, timeshiftPlan, timeshiftRingSignature } from '../timeshiftEffect';
import { createTimeShiftRecordMaterial, createTimeShiftStreakMaterial } from '../timeshiftMaterial';
import { computeLayerBox } from './layerWarps';
import { ensurePassTarget as ensurePassTargetInEngine } from './passPool';

// Scratch, written by every buildRepetileField call and read on the next line —
// it tells "the reveal has not started" apart from "the box collapsed", which
// are the same zero count with opposite outcomes.
const repFieldInfo = { hidden: false, groups: [] };

// Tight content bounds of a canvas-backed layer (text / motion), same cache
// discipline as the outlines above: keyed by item, invalidated by content hash,
// so animated text re-measures only on frames whose raster actually changed.
const canvasBoundsCache = new Map(); // itemId -> { hash, res }
function getCanvasAlphaBounds(itemId, canvas) {
  const hash = hashAlphaSource(canvas);
  if (!hash) return null;
  let entry = canvasBoundsCache.get(itemId);
  if (!entry || entry.hash !== hash) {
    entry = { hash, res: sampleAlphaBounds(canvas) };
    canvasBoundsCache.set(itemId, entry);
    if (canvasBoundsCache.size > 24) {
      const first = canvasBoundsCache.keys().next().value;
      if (first !== itemId) canvasBoundsCache.delete(first);
    }
  }
  return entry.res;
}

// Shrink a quad box onto a sub-rect of itself, given as fractions of the quad
// (0..1, y DOWN like a canvas). The quad's own local +Y is UP, hence the flip on
// the vertical centre. Returns a box in exactly the shape computeLayerBox emits.
function narrowBoxToRect(box, rect) {
  const fw = rect.x1 - rect.x0;
  const fh = rect.y1 - rect.y0;
  if (!(fw > 0.001) || !(fh > 0.001)) return box;
  if (fw > 0.999 && fh > 0.999) return box; // already the whole quad
  const cx = rect.x0 + rect.x1 - 1;
  const cy = 1 - (rect.y0 + rect.y1);
  return {
    origin: [
      box.origin[0] + box.axisX[0] * cx + box.axisY[0] * cy,
      box.origin[1] + box.axisX[1] * cx + box.axisY[1] * cy,
    ],
    axisX: [box.axisX[0] * fw, box.axisX[1] * fw],
    axisY: [box.axisY[0] * fh, box.axisY[1] * fh],
    sizePx: [box.sizePx[0] * fw, box.sizePx[1] * fh],
  };
}

export function renderEchoStack(engine, read, write, eff, def, ctx) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  const scene = engine.effectScene;
  const mesh = engine.effectMesh;
  if (!renderer || !orthoCamera || !scene || !mesh) return false;

  const params = resolveEffectParams(def, eff);
  const taps = planEchoTaps(params);
  // One image at full strength is the input itself. Bypass rather than spend
  // two passes copying it, so Echoes 0 is free instead of merely cheap.
  if (taps.length <= 1 && Math.abs((taps[0]?.weight ?? 1) - 1) < 1e-3) return false;

  // First real draw builds the materials. Safe here and not in the setup
  // block: rendering only ever runs after materialsReady has resolved, which
  // is what makes the WebGPU node factories available.
  let pass = engine.echoPass;
  if (!pass) {
    pass = {
      warp: createTrailWarpMaterial(),
      acc: createEchoAccMaterial(),
      compose: createTrailComposeMaterial(),
    };
    engine.echoPass = pass;
  }

  const w = read.width, h = read.height;
  /*
   * EVERY box comes from ONE source. `ctx.box` is measured from the layer
   * mesh as the CHANNEL posed it, where the on-screen size sits in the mesh
   * SCALE over a frame-sized plane; boxAt() re-poses that mesh with
   * applyMeshTransform, which writes the item's own transform and therefore
   * resets that scale to 1. Mixing the two put a 772x436 source box against a
   * 1920x1080 destination and magnified every echo by 2.5x.
   *
   * So when the evaluator is available the CURRENT box comes from it too, the
   * way renderLayerTrail derives its own boxNow. Both boxes then live in the
   * same space and an unmoved layer warps to an exact identity. boxAt() puts
   * the channel's size factor back (makePlateScale), so the box is the layer's
   * real extent — the warp clips to it, and a frame-sized box cut every layer
   * bigger than the frame — and a shape's keyframed Width / Height is followed.
   */
  const boxAt = typeof ctx.boxAt === 'function' ? ctx.boxAt : null;
  const boxNow = (boxAt && boxAt(ctx.clock)) || ctx.box || ECHO_IDENTITY_BOX;
  // Analytic needs a pose. Adjustment scope has none — "everything below" is
  // not a layer — so it falls back to the ring rather than stacking N
  // identical copies and calling it an echo.
  const analytic = Math.round(params.engine) === ECHO_ENGINE_ANALYTIC && !!boxAt;
  const colorize = Math.min(1, Math.max(0, params.colorize / 100));
  const op = Math.round(params.operator);
  const key = eff.eid || 'echo';

  const drawPass = (material, target) => {
    mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, orthoCamera);
  };
  // Every plate on this path is quad-written, so nothing here is on the
  // camera's V axis and the flip stays off (see motionTrailNodes.js).
  const warpInto = (dst, texture, srcBox, dstBox, weight, depth, width, height) => {
    pass.warp.uniforms.uTexture.value = texture;
    applyTrailWarpUniforms(pass.warp, {
      width, height, srcBox, dstBox, weight, colorize, depth, tint: params.tint,
    });
    if (pass.warp.uniforms.uFlipV) pass.warp.uniforms.uFlipV.value = 0;
    drawPass(pass.warp, dst);
  };

  // The clock is the UNREBASED clip-local time. An Active Range rebases the
  // shader clock so cyclic effects start at phase 0, but rebasing the ring's
  // frame identity would renumber every recorded plate the moment a window is
  // dragged — the history must survive the edit that changes only the window.
  const frameIdx = Math.round(ctx.clock / ECHO_FRAME_DT);
  let state = null;
  if (!analytic) {
    const sig = echoRingSignature(w, h, params);
    state = engine.echoState.get(key);
    if (!state || state.sig !== sig) {
      state = { sig, ring: new Map(), ringBox: new Map(), order: [] };
      engine.echoState.set(key, state);
    }
    state.seen = engine.passFrame;
    state.seenAt = performance.now();
    const cap = Math.max(4, Math.min(ECHO_RING_MAX, Math.round(params.capacity)));
    const ring = echoRingSize(w, h, params.resolution);
    // Record this frame BEFORE folding, or the ring feeds on its own output
    // and turns to mush after a few seconds.
    if (!state.ring.has(frameIdx)) {
      let slot = state.ring.size;
      if (state.order.length >= cap) {
        const evict = state.order.shift();
        slot = state.ring.get(evict);
        state.ring.delete(evict);
        state.ringBox.delete(evict);
      }
      const target = ensurePassTargetInEngine(engine, `echo:hist:${key}:${slot}`, ring.width, ring.height, false);
      if (target) {
        warpInto(target, read.texture, boxNow, boxNow, 1, 0, ring.width, ring.height);
        state.ring.set(frameIdx, slot);
        state.ringBox.set(frameIdx, boxNow);
        state.order.push(frameIdx);
      }
    }
  }

  const accA = ensurePassTargetInEngine(engine, `echo:acc:a:${w}x${h}`, w, h, false);
  const accB = ensurePassTargetInEngine(engine, `echo:acc:b:${w}x${h}`, w, h, false);
  const tapTarget = ensurePassTargetInEngine(engine, `echo:tap:${w}x${h}`, w, h, false);
  if (!accA || !accB || !tapTarget) return false;

  let accRead = accA, accWrite = accB;
  let folded = 0;
  for (const tap of taps) {
    let texture = read.texture;
    let srcBox = boxNow;
    let dstBox = boxNow;
    if (tap.index > 0) {
      const at = ctx.clock + tap.dt;
      let recorded = null;
      if (!analytic && state) {
        const f = Math.round(at / ECHO_FRAME_DT);
        const slot = state.ring.get(f);
        const hist = slot === undefined ? null : engine.passPool.get(`echo:hist:${key}:${slot}`);
        if (hist) recorded = { texture: hist.texture, box: state.ringBox.get(f) || boxNow };
      }
      if (recorded) {
        // Recorded pixels already carry that frame's pose, so src and dst are
        // the same box and the warp is a straight copy.
        texture = recorded.texture;
        srcBox = recorded.box;
        dstBox = recorded.box;
      } else if (boxAt) {
        const posed = boxAt(at);
        // Before the clip starts there is no layer to echo. AE gives
        // transparent there too, so the stack simply stops growing.
        if (!posed) break;
        dstBox = posed;
      }
    }
    warpInto(tapTarget, texture, srcBox, dstBox, tap.weight, tap.depth, w, h);

    const u = pass.acc.uniforms;
    u.uAcc.value = accRead.texture;
    u.uTap.value = tapTarget.texture;
    u.uResolution.value.set(w, h);
    u.uOp.value = op;
    // The first image is written straight through: an operator like Minimum or
    // Blend against a cleared target would collapse the whole stack.
    u.uFirst.value = folded === 0 ? 1 : 0;
    u.uFolded.value = folded;
    drawPass(pass.acc, accWrite);
    const swap = accRead; accRead = accWrite; accWrite = swap;
    folded++;
  }
  if (folded === 0) return false;

  // The stack already contains the live image at Starting Intensity, so the
  // compose has nothing to blend in — it only crossfades to the untouched
  // input by mix, which keeps mix 0 an exact bypass however many images ran.
  const cu = pass.compose.uniforms;
  cu.uSrc.value = read.texture;
  cu.uTrail.value = accRead.texture;
  cu.uResolution.value.set(w, h);
  cu.uBlend.value = 0;
  cu.uMix.value = ctx.mix;
  cu.uHasSource.value = 1;
  if (cu.uFlipSrc) cu.uFlipSrc.value = 0;
  drawPass(pass.compose, write);
  return true;
}

export function renderTimeShift(engine, read, write, eff, def, ctx) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  const scene = engine.effectScene;
  const mesh = engine.effectMesh;
  if (!renderer || !orthoCamera || !scene || !mesh) return false;

  const params = resolveEffectParams(def, eff);
  // No travel and no shutter is the identity, so skip rather than spend two
  // passes reproducing the input.
  if (timeshiftIsBypass(params)) return false;

  // Built on first draw, not in the setup block: a project that never uses
  // TimeShift should not pay to compile a 48-tap shader it will never draw.
  let pass = engine.timeshiftPass;
  if (!pass) {
    pass = { record: createTimeShiftRecordMaterial(), streak: createTimeShiftStreakMaterial() };
    engine.timeshiftPass = pass;
  }
  if (!pass.record || !pass.streak) return false;

  const w = read.width, h = read.height;
  const maxEdge = renderer.capabilities?.maxTextureSize || 0;
  const atlas = timeshiftAtlas(w, h, params.resolution, params.capacity, maxEdge);
  const key = eff.eid || 'timeshift';
  const ring = ensurePassTargetInEngine(engine, `ts:ring:${key}`, atlas.atlasW, atlas.atlasH, false);
  if (!ring) return false;

  const sig = timeshiftRingSignature(w, h, params, maxEdge);
  let state = engine.timeshiftState.get(key);
  if (!state || state.sig !== sig) {
    state = { sig, head: -1, filled: 0, lastFrame: null };
    engine.timeshiftState.set(key, state);
  }
  state.frame = engine.passFrame;
  state.frameAt = performance.now();

  // The UNREBASED clip-local time, for the same reason Echo uses it: an Active
  // Range rebases the shader clock, and renumbering recorded frames when a
  // window is dragged would throw the history away on an edit that should not
  // touch it.
  const frameIdx = Math.round(ctx.clock / TIMESHIFT_FRAME_DT);

  const drawInto = (material, target, clear) => {
    mesh.material = material;
    renderer.setRenderTarget(target);
    if (clear) {
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
    }
    renderer.render(scene, orthoCamera);
  };

  const recordSlot = (slot) => {
    const ru = pass.record.uniforms;
    ru.uPlate.value = read.texture;
    ru.uAtlasPx.value.set(atlas.atlasW, atlas.atlasH);
    ru.uGrid.value.set(atlas.cols, atlas.rows);
    ru.uSlot.value = slot;
    drawInto(pass.record, ring, false);
  };

  // autoClear is toggled per block elsewhere in this file, so it is pinned
  // here rather than assumed: one automatic clear would wipe the whole ring,
  // because the tiles this pass does NOT write are the history.
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  const gap = state.lastFrame === null ? Infinity : frameIdx - state.lastFrame;
  if (state.filled === 0 || gap < 0 || gap > atlas.cap) {
    for (let i = 0; i < atlas.cap; i++) {
      state.head = (state.head + 1) % atlas.cap;
      recordSlot(state.head);
    }
    state.filled = atlas.cap;
  } else if (gap > 0) {
    // Only the newest plate exists, so a multi-frame step advances the head
    // once rather than stamping the same image into several slots.
    state.head = (state.head + 1) % atlas.cap;
    recordSlot(state.head);
    state.filled = Math.min(atlas.cap, state.filled + 1);
  }
  renderer.autoClear = prevAutoClear;
  state.lastFrame = frameIdx;

  /*
   * Release the ring of any instance that has stopped drawing — a deleted
   * effect, a deleted layer, a scope change. echoStateRef deliberately has no
   * such path and leaks a pooled target per removed Echo until the renderer is
   * rebuilt; at ~18 MB per ring this one cannot afford to copy that.
   *
   * Keyed on "has not drawn for a while" rather than on walking the item tree,
   * because the effect chain is the only place an eid is visible from here and
   * a stale entry is cheap to carry for a few seconds.
   */
  state.seen = ++engine.timeshiftSweep;
  if (engine.timeshiftState.size > 1) {
    for (const [otherKey, other] of engine.timeshiftState) {
      if (otherKey === key) continue;
      if (state.seen - (other.seen || 0) < 240) continue;   // ~8s at 30fps
      const stale = engine.passPool.get(`ts:ring:${otherKey}`);
      if (stale) {
        stale.dispose();
        engine.passPool.delete(`ts:ring:${otherKey}`);
      }
      engine.timeshiftState.delete(otherKey);
    }
  }

  const plan = timeshiftPlan(params, frameIdx);
  const su = pass.streak.uniforms;
  su.uAtlas.value = ring.texture;
  su.uPlate.value = read.texture;
  su.uResolution.value.set(w, h);
  su.uGrid.value.set(atlas.cols, atlas.rows);
  su.uTilePx.value.set(atlas.tileW, atlas.tileH);
  su.uHead.value = state.head;
  su.uFilled.value = state.filled;
  su.uCap.value = atlas.cap;
  su.uDir.value.set(plan.dirX, plan.dirY);
  su.uShift.value = plan.shift;
  su.uShutter.value = plan.shutterFrames;
  su.uTaps.value = plan.samples;
  su.uFall.value = plan.falloff;
  su.uWrap.value = plan.wrap;
  su.uGap.value = plan.gap;
  su.uGain.value = plan.gain;
  su.uHeadroom.value = plan.headroom;
  su.uRange.value = plan.range;
  su.uRLo.value = plan.rangeLo;
  su.uRHi.value = plan.rangeHi;
  su.uRSoft.value = plan.rangeSoft;
  su.uRHue.value = plan.rangeHue;
  su.uRHueW.value = plan.rangeHueW;
  su.uRSat.value = plan.rangeSat;
  su.uRInvert.value = plan.rangeInvert;
  su.uMix.value = ctx.mix;
  // Seeded on the FRAME, not on wall time, so a re-render of the same frame
  // dithers identically — an export must not shimmer against its own preview.
  su.uSeed.value = (frameIdx % 1024) * 91.3;
  drawInto(pass.streak, write, true);
  return true;
}

export function renderLayerRepetile(engine, srcTarget, outTarget, params, layerMesh, chCam, time, item, clip, scroll, flipPlate = false, boxOverride = null) {
  const renderer = engine.renderer;
  if (!renderer || !layerMesh || !chCam) return srcTarget;
  let box = boxOverride || computeLayerBox(layerMesh, chCam, srcTarget.width, srcTarget.height);
  if (!box) return srcTarget;
  // A text or motion layer's plate is comp-sized by construction — its geometry
  // box is the whole frame, so tiling it yields one frame-sized tile and the
  // effect looks dead. Tile the CONTENT instead: the tight alpha bounds of the
  // layer's own raster. Opaque media is unaffected (its bounds are the plate).
  if (Math.round(params.repBounds) === 1 && (clip?.mediaType === 'text' || clip?.mediaType === 'motion')) {
    const canvas = engine.textTextureCache.get(item?.id)?.canvas;
    const rect = canvas ? getCanvasAlphaBounds(item.id, canvas) : null;
    if (rect) box = narrowBoxToRect(box, rect);
  }
  let pass = engine.repetilePass;
  if (!pass) {
    pass = createRepetilePass();
    engine.repetilePass = pass;
  }
  const ref = srcTarget.height / 1080;
  // The field is BUILT into the scratch and copied into the GPU buffer group by
  // group — see createRepetilePass on why it cannot be built in place.
  const info = repFieldInfo;
  const count = buildRepetileField(pass.scratch, params, box.sizePx, time, ref, scroll, info);
  if (count <= 0) {
    // A sound grid that drew nothing means the reveal is still at zero with the
    // original included: the layer has to go too. Falling back to the plate here
    // is what made Reveal 0 show the untouched layer and then blink it away on
    // the first frame that had a tile.
    if (!info.hidden) return srcTarget;
    renderer.setRenderTarget(outTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    return outTarget;
  }
  const groups = info.groups.length > 0 ? info.groups : [{ steps: 0, count }];

  // ── Play Delay ──
  // Record this frame's plate, so the tiles that lag have something to read.
  // BEFORE the field is drawn, or the tiles feed back into their own history and
  // the ring turns to mush — the same order Frame Echo records in. The copy is
  // an IDENTITY one: the plate keeps whatever V axis it arrived on and the flag
  // rides along in the ring, so a delayed tile samples it exactly as it would
  // have sampled the live plate. Flipping on the way in instead would need a
  // flipping blit that neither renderer's blit material has.
  let history = null;
  if (groups.length > 1) {
    const key = item?.id || 'repetile';
    const stride = repetileDelayStride(params);
    const stamp = Math.round(Math.round(time / REP_FRAME_DT) / stride);
    const hw = Math.max(8, Math.round(srcTarget.width * REP_HISTORY_SCALE));
    const hh = Math.max(8, Math.round(srcTarget.height * REP_HISTORY_SCALE));
    const sig = `${hw}x${hh}|${stride}`;
    let state = engine.repetileHist.get(key);
    // A resize or a changed stride means every recorded plate is the wrong
    // shape or the wrong moment: start the ring over rather than mix them.
    if (!state || state.sig !== sig) {
      state = { ring: new Map(), flip: new Map(), order: [], sig };
      engine.repetileHist.set(key, state);
    }
    state.seen = engine.passFrame;
    state.seenAt = performance.now();
    if (!state.ring.has(stamp)) {
      let slot = state.ring.size;
      if (state.order.length >= REP_DELAY_RING) {
        const evict = state.order.shift();
        slot = state.ring.get(evict);
        state.ring.delete(evict);
        state.flip.delete(evict);
      }
      const target = ensurePassTargetInEngine(engine, `rep:hist:${key}:${slot}`, hw, hh, false);
      /*
       * The STORAGE-IDENTITY copy, not the plain blit. The flag recorded next
       * to the slot describes the plate's V axis AS STORED, and on WebGPU the
       * plain uv() blit re-stores a plate on the OPPOSITE axis (see
       * createBlitNodeMaterial) — so every recorded plate sat in the ring
       * mirrored against its own flag, and once the ring filled during
       * playback the tiles sampled the glyphs upside down through the box
       * window: only the strip nearest the box edge survived, which read as
       * "the tiles are cut to the tops of the letters" and healed on pause,
       * when a fresh seek falls back to the live plate. Motion Trail's ring
       * had the same bug (see warpInto's record note). WebGL: the identity
       * refs alias the plain blit, so nothing changes there.
       */
      const blitScene = engine.seqPlateCopyScene || engine.blitScene;
      const blitMaterial = engine.seqPlateCopyMaterial || engine.blitMaterial;
      if (target && blitScene && blitMaterial) {
        blitMaterial.uniforms.uTexture.value = srcTarget.texture;
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.render(blitScene, engine.orthoCamera);
        state.ring.set(stamp, slot);
        state.flip.set(stamp, flipPlate);
        state.order.push(stamp);
      }
    }
    history = { state, stamp, key };
  }

  const u = pass.material.uniforms;
  u.uOrigin.value.set(box.origin[0], box.origin[1]);
  u.uAxisX.value.set(box.axisX[0], box.axisX[1]);
  u.uAxisY.value.set(box.axisY[0], box.axisY[1]);
  u.uHalfPx.value.set(box.sizePx[0] / 2, box.sizePx[1] / 2);
  u.uFeather.value = repetileFeatherLocal(params);
  u.uClipCell.value = params.repClipCell > 0.5 ? 1 : 0;
  u.uEdgeMode.value = Math.round(params.repEdgeMode);
  applyRepetileBlendMode(pass.material, Math.round(params.repBlendMode));
  renderer.setRenderTarget(outTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  // One draw per delay group. Groups are contiguous in the scratch and each one
  // is copied to instance 0, because three has no instance-start offset. The
  // chain runs with autoClear off, so the groups after the first accumulate
  // rather than wiping what the earlier ones drew.
  let offset = 0;
  for (const g of groups) {
    pass.data.set(
      pass.scratch.subarray(offset * REP_FLOATS_PER_TILE, (offset + g.count) * REP_FLOATS_PER_TILE), 0);
    pass.buffer.needsUpdate = true;
    pass.geometry.instanceCount = g.count;
    let tex = srcTarget.texture;
    let axisFlip = flipPlate;
    if (history) {
      // Every group reads the ring while a delay is on — including the undelayed
      // one, whose slot was just recorded — so the whole field carries the same
      // half-res softness instead of one sharp group among blurry neighbours.
      const want = history.stamp - g.steps;
      const slot = history.state.ring.get(want);
      const rec = slot === undefined ? null : engine.passPool.get(`rep:hist:${history.key}:${slot}`);
      // No slot means a fresh seek: the ring has not reached back that far yet,
      // so the tile shows the live plate until it has.
      if (rec) { tex = rec.texture; axisFlip = history.state.flip.get(want); }
    }
    u.uTexture.value = tex;
    if (u.uFlipV) u.uFlipV.value = axisFlip ? 1 : 0;
    renderer.render(pass.scene, engine.orthoCamera);
    offset += g.count;
  }
  return outTarget;
}
