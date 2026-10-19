/*
 * The layer effect chain (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 22 — moved verbatim out of Player.jsx with
 * tests/engine-extraction/tools/stage9_step.py): runEffectChain runs a layer's Overlay Effects in order on a bank of
 * targets; runLayerOverlayEffectsInBank prepares one layer for it (keyframes, the path a path effect runs along, Echo
 * poses, the content box), runLayerOverlayEffects picks the bank, and preparePreTransitionOverlayEffects bakes a
 * layer's effects before a cross transition reads it.
 *
 * `env` carries the live editor values these read (`interactivePreviewEnabled`, `parentIndex`); the Player memoizes it
 * over exactly the values the old callbacks listed as dependencies.
 */
import * as THREE from 'three';
import { applyEffectUniforms, chainNeedsPyramid, effectClipsToLayer, effectIsLiveAt, effectRange, effectWindowAt, getAdjustmentEffect, resolveEffectParams } from '../adjustmentEffects';
import { applyBlendMode, resetMaterialUniforms } from '../clipShader';
import { takeFxProbeRequest } from '../fxProbeBroker';
import { getItemKeyframeValues, integratePathRate, itemHasKeyframes } from '../gsapTransitions';
import { isLayerMaskEnabled } from '../layerMask';
import { linesDrawRunnerState } from '../linesDrawProfiles';
import { withFlatEffects } from '../model3dFxCatalog';
import { resolveObjectPlate } from '../objectPlate';
import { resolveTrackFrame } from '../objectTracking';
import { isCameraBaked3dPlate } from '../rig3d';
import { selectedBackend } from '../videoRenderer';
import { applyMatteClip as applyMatteClipInEngine, ensurePictureRefPlate as ensurePictureRefPlateInEngine } from './compositeOps';
import { captureFxProbe as captureFxProbeInEngine, getEffectMaterial as getEffectMaterialInEngine } from './effectMaterials';
import { renderEchoStack as renderEchoStackInEngine, renderTimeShift as renderTimeShiftInEngine } from './historyEffects';
import { maskVisibleShape as maskVisibleShapeInEngine } from './layerMasks';
import { plateToCameraAxis as plateToCameraAxisInEngine } from './layerPasses';
import { applyLayerMask as applyLayerMaskInEngine } from './layerStages';
import { computeLayerBox } from './layerWarps';
import { applyMeshTransform, makePlateScale, resolveFollow as resolveFollowInEngine, resolveParenting as resolveParentingInEngine } from './meshTransform';
import { ensurePassTarget as ensurePassTargetInEngine } from './passPool';
import { resolveLayerPathFx as resolveLayerPathFxInEngine } from './pathFx';
import { ensureLayerFxTargets as ensureLayerFxTargetsInEngine } from './renderTargets';
import { ensurePreTransitionFxTargets as ensurePreTransitionFxTargetsInEngine } from './transitions';
import { _echoEuler, _echoPos, _echoScale, bakeableLayerStack, boxAabb, calculateVideoTime, clamp01, layerContentBox, maskSilhouetteFraming } from './layerHelpers';

export function runEffectChain(engine, env, item, kf, ctx) {
  let { read, write } = ctx;
  // Both scopes read item.effects; layer scope passes the same array explicitly
  // because it renders against an isolated regular layer rather than the stack.
  const effects = ctx.effects || item?.effects;
  const layerScope = ctx.scope === 'layer';
  const hasEffects = Array.isArray(effects) && effects.length > 0;
  // The item-level LUT belongs to the adjustment panel's own section; a layer's
  // chain must not pick it up.
  const hasLut = !layerScope && !!item?.lut;
  if (!hasEffects && !hasLut) return { read, write };
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  const scene = engine.effectScene;
  const mesh = engine.effectMesh;
  if (!renderer || !orthoCamera || !scene || !mesh) return { read, write };
  const master = clamp01(Number.isFinite(kf?.effectAmount) ? kf.effectAmount : 1);
  const quality = env.interactivePreviewEnabled ? 0.5 : 1;
  // Item-level LUT (the panel's dedicated LUT section, not part of the effect
  // chain): one implicit colour pass straight after the grade, before any
  // stacked effects, so effects style the already-graded look. Reuses the
  // registry's hidden `lut` shader; intensity = lutAmount (keyframable).
  if (hasLut) {
    const lutBase = Number.isFinite(kf?.lutAmount) ? kf.lutAmount : (Number.isFinite(item.lutAmount) ? item.lutAmount : 100);
    const lutMix = clamp01(lutBase / 100);
    if (lutMix > 0) {
      const pseudo = { id: 'lut', lut: item.lut };
      const mat = getEffectMaterialInEngine(engine, pseudo);
      if (mat) {
        applyEffectUniforms(mat, pseudo, {
          time: ctx.time,
          progress: ctx.progress,
          width: read.width,
          height: read.height,
          quality,
          mix: lutMix,
          box: ctx.box,
        });
        mat.uniforms.uTexture.value = read.texture;
        if (mat.uniforms.uSource) mat.uniforms.uSource.value = read.texture;
        mesh.material = mat;
        renderer.setRenderTarget(write);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.render(scene, orthoCamera);
        const tmp = read; read = write; write = tmp;
      }
    }
  }
  if (!hasEffects) return { read, write };
  /*
   * WebGPU, ADJUSTMENT scope: the chain input is the grade pass rendered through
   * the CAMERA, so it is stored camera-axis — the opposite V of the quad plate a
   * layer's chain opens with (runLayerOverlayEffectsInBank's plain blit), which is
   * what every node body was ported and verified against. Measured on a real
   * adjustment layer: 26 of 49 effects came out mirrored or offset the wrong way
   * (Mirror copied the other half, lattices, bands and directional offsets
   * flipped), while the same effects on a layer matched WebGL. One plain blit
   * re-stores the input as a quad plate, the chain runs exactly as in layer scope,
   * and one more plain blit stores the result back camera-axis for the composite.
   * Only when an effect is live now — a fully bypassed chain costs nothing — and
   * never on WebGL, where the plain blit is the identity.
   */
  const blitScene = engine.blitScene;
  const blitMaterial = engine.blitMaterial;
  const liveNow = (eff) => {
    if (!eff || eff.enabled === false || !getAdjustmentEffect(eff.id)) return false;
    const mk = eff.eid && kf ? kf[`fx:${eff.eid}:mix`] : undefined;
    const bm = Number.isFinite(mk) ? mk : (Number.isFinite(eff.mix) ? eff.mix : 100);
    const w = effectWindowAt(eff, ctx.time, ctx.duration);
    return clamp01(bm / 100) * master * (w ? w.amount : 1) > 0;
  };
  const axisFlip = !layerScope && selectedBackend() === 'webgpu' && !!blitScene && !!blitMaterial
    && effects.some(liveNow);
  const flipPlate = () => {
    blitMaterial.uniforms.uTexture.value = read.texture;
    renderer.setRenderTarget(write);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(blitScene, orthoCamera);
    const tmp = read; read = write; write = tmp;
  };
  if (axisFlip) flipPlate();
  let applied = 0;
  for (const eff of effects) {
    if (applied >= 4) break;
    if (!eff || eff.enabled === false) continue;
    const def = getAdjustmentEffect(eff.id);
    if (!def) continue;
    // The panel's histogram wants THIS effect's input, which is `read` right
    // now — before the entry runs, and before an early `continue` below can
    // skip it. Served at most once per request.
    if (eff.eid) {
      const probeReq = takeFxProbeRequest(eff.eid);
      if (probeReq) captureFxProbeInEngine(engine, probeReq, read);
    }
    // Path-driven effects need a baked outline; nothing traceable this frame
    // (media still decoding, no canvas yet) means an exact bypass.
    if (def.usesPath && !ctx.path) continue;
    // Keyframed overrides: `fx:<eid>:mix` animates this effect's mix (fade in/out),
    // `fx:<eid>:<param>` animates individual params. Fall back to the static config.
    const mixKf = eff.eid && kf ? kf[`fx:${eff.eid}:mix`] : undefined;
    const baseMix = Number.isFinite(mixKf) ? mixKf : (Number.isFinite(eff.mix) ? eff.mix : 100);
    // Active range: outside its window an effect is an exact bypass; inside, the
    // clock is rebased onto the window so cyclic effects start at phase 0. The
    // window MULTIPLIES the mix rather than replacing it, so a hand-animated mix
    // track keeps producing exactly what it produces today.
    const win = effectWindowAt(eff, ctx.time, ctx.duration);
    const mix = clamp01(baseMix / 100) * master * (win ? win.amount : 1);
    if (mix <= 0) continue; // exact bypass
    let effForUniforms = eff;
    if (eff.eid && kf) {
      let overridden = null;
      for (const p of def.params) {
        if (p.type && p.type !== 'number') continue;
        if (p.static) continue; // bake-side params never ride keyframe tracks
        const v = kf[`fx:${eff.eid}:${p.key}`];
        if (!Number.isFinite(v)) continue;
        if (!overridden) overridden = { ...eff, params: { ...eff.params } };
        overridden.params[p.key] = v;
      }
      if (overridden) effForUniforms = overridden;
    }
    // Zero-amount bypass (Fast Blur at Blurriness 0, Grid at Line Width 0): the
    // descriptor states when its output IS its input, and the effect then costs
    // no pass at all — not even a main pass copying the plate.
    const fxParams = (def.bypassIf || Array.isArray(def.passes)) ? resolveEffectParams(def, effForUniforms) : null;
    // The effect's own clock: the layer's, or its Active Range's (rebased to 0,
    // and the range's length as the duration) — Strip's outro ends on the range's
    // last frame, not the layer's.
    const winRange = win ? effectRange(eff, ctx.duration) : null;
    const fxTime = win ? win.time : ctx.time;
    const fxDuration = winRange ? winRange.end - winRange.start : ctx.duration;
    // What a pass's hooks (set / skipIf / scale / size / inputs) may read: the
    // 1080p reference, the plate, the layer box in layer scope, and the clock.
    const fxSetCtx = { ref: read.height / 1080, width: read.width, height: read.height, box: ctx.box || null, time: fxTime, duration: fxDuration };
    if (def.bypassIf && def.bypassIf(fxParams, fxSetCtx)) continue;
    const uniformCtx = {
      time: fxTime,
      progress: win ? win.progress : ctx.progress,
      duration: fxDuration,
      width: read.width,
      height: read.height,
      quality,
      mix,
      // Layer scope hands the chain the layer's own box, so fxLocal()/fxCoord()
      // in the shaders resolve to the artwork instead of the frame. Absent for
      // an adjustment layer, whose effect really does own the whole frame.
      box: ctx.box,
      // Neon Glow: the baked outline plus THIS instance's integrated run
      // phase (per-eid rate tracks → per-entry runner).
      ...(def.usesPath && typeof ctx.pathPhase === 'function'
        ? { path: ctx.path, ...ctx.pathPhase(eff) }
        : {}),
      // Object effects: this INSTANCE's subject field + boxes for this frame.
      // Resolved here, inside the loop, so only an entry that actually renders
      // pays for its decode and upload.
      ...(def.usesTrack && typeof ctx.trackFor === 'function'
        ? { track: ctx.trackFor(eff) }
        : {}),
      // The geometry plate reads the KEYFRAMED params, so an animated control
      // redraws the canvas rather than being quietly ignored by the CPU side.
      ...(def.usesPlate && typeof ctx.plateFor === 'function'
        ? { plate: ctx.plateFor(effForUniforms) }
        : {}),
      // Shape Rulers: the layer's own rect inside its box (a text block).
      ...(def.usesContentBox ? { contentBox: ctx.contentBox || null } : {}),
    };

    // Temporal effect (Echo): it needs N images from N different times, which
    // no fx(uv) over one plate can express, so the whole pipeline lives in
    // renderEchoStack. Checked BEFORE the material path — the descriptor's
    // pass-through fragment exists only so a miss here is a no-op, not a throw.
    // Deliberately NOT matte-clipped: an echo's whole point is the pixels that
    // fall OUTSIDE the layer's current silhouette.
    // An Active Range (or a mix of 0) bypasses above before reaching here, so
    // the ring records only inside the window. Entering one mid-shot therefore
    // starts from the analytic fallback and fills in with real pixels over the
    // next capacity/30 seconds — the alternative is every windowed or muted
    // Echo paying a record pass per frame to do nothing.
    if (def.temporal === 'echo') {
      const drew = renderEchoStackInEngine(engine, read, write, effForUniforms, def, {
        mix,
        // The shader clock may be rebased by an Active Range; the ring and the
        // pose evaluator must not be. Both are passed.
        clock: ctx.time,
        box: ctx.box,
        boxAt: layerScope ? ctx.boxAt : null,
      });
      if (drew) {
        const tmp = read; read = write; write = tmp;
        applied++;
      }
      continue;
    }

    // The second temporal effect. Dispatched by VALUE, not by the presence of
    // `temporal`, so adding one can never silently reroute the other.
    if (def.temporal === 'timeshift') {
      const drew = renderTimeShiftInEngine(engine, read, write, effForUniforms, def, {
        mix,
        clock: ctx.time,
      });
      if (drew) {
        const tmp = read; read = write; write = tmp;
        applied++;
      }
      continue;
    }

    // Declarative multi-pass effect (motionEffects.js): walk def.passes, writing
    // each intermediate into a pooled target and binding it by name to whichever
    // later pass asks for it. Only the `main` pass writes the effect's output.
    //
    // WebGPU: each buffer is a handle `{ tex, isRT, flip? }`. Quad-written
    // plates — the chain input and every pass target — sample upright under
    // plain UV (measured across the catalogue). The ONE exception is the
    // camera-rendered isolate, which lands on the opposite V axis and needs
    // the structural flipY, exactly like matteClip's uMatte. Materials are
    // cached per resolved flip map because flipY is fixed at TSL construction.
    if (Array.isArray(def.passes)) {
      const params = fxParams;
      const setCtx = fxSetCtx;
      // Another layer as an input (Copy Color Profile): the Player pre-rendered
      // the referenced layer's isolate into colorRefPlatesRef this frame, keyed
      // by item id, and blitted it to a quad plate — so it samples plain, like
      // 'source', on both backends. No plate (layer gone, not under the
      // playhead, or referencing itself) = exact bypass.
      let refPlate = null;
      if (def.usesLayerRef) {
        const refId = effForUniforms.params?.[def.usesLayerRef];
        refPlate = typeof refId === 'string' && refId && refId !== item?.id
          ? engine.colorRefPlates.get(refId) || null : null;
        if (!refPlate) continue;
      }
      // 'source' is this effect's input (a quad-written chain plate, plain).
      // 'matte' is the isolated layer's silhouette in layer scope — the
      // camera-rendered isolate, so flip:true, unless a stage already rewrote it
      // through a quad (ctx.matteCamAxis: the mask, the rig, the key) — and the
      // effect's own input in adjustment scope (no ctx.matte), which is
      // quad-written and stays plain.
      // The flag rides the HANDLE so a skipIf alias to the matte inherits it.
      const buffers = {
        source: { tex: read.texture, isRT: false, box: ctx.box || null },
        matte: { tex: ctx.matte || read.texture, isRT: false, flip: !!ctx.matte && ctx.matteCamAxis !== false },
        ...(refPlate ? { ref: { tex: refPlate.texture, isRT: false, box: refPlate.box || null } } : {}),
      };
      let autoSlot = 0;
      let ok = true;
      for (const pass of def.passes) {
        if (!pass.main && pass.skipIf && pass.skipIf(params, setCtx)) {
          buffers[pass.target] = buffers[pass.alias] ?? null;
          continue;
        }
        const bind = { uSource: buffers.source };
        // `inputs` may be a function of the params: Fast Blur reads whichever
        // pyramid level this frame's Blurriness picked.
        const passInputs = typeof pass.inputs === 'function' ? pass.inputs(params, setCtx) : pass.inputs;
        for (const [uniform, buffer] of Object.entries(passInputs || {})) {
          bind[uniform] = buffers[buffer] ?? null;
        }
        // The flip map resolves from the BOUND HANDLES, not the pass def's
        // names: a skipped pass aliases its target straight to the matte plate
        // (longShadow with Softness 0 reads the isolate as `sB`), so only the
        // texture's provenance says which axis a binding is on.
        const flips = {};
        for (const [uniform, handle] of Object.entries(bind)) {
          if (handle?.flip) flips[uniform] = true;
        }
        // Which bound samplers share ONE texture, as a pattern (uniform → index
        // of the first sampler holding the same texture). A pass material is
        // built per pattern: on WebGPU a material first built while two of its
        // samplers held one texture (a skipIf alias) kept reading that texture
        // through both after the alias ended — ASCII's edge votes came back as
        // the cell plate. Measured; the porting guide's "key on the resolved
        // binding" rule (§7).
        const shared = new Map();
        const variant = Object.keys(bind).sort().map((uniform) => {
          const tex = bind[uniform]?.tex ?? null;
          if (!shared.has(tex)) shared.set(tex, shared.size);
          return `${uniform}:${shared.get(tex)}`;
        }).join(',');
        const passMat = getEffectMaterialInEngine(engine, eff, `pass:${pass.key}`,
          Object.keys(flips).length ? flips : null, variant);
        if (!passMat) { ok = false; break; }
        // Per-pass resolution (the roadmap's `pass.scale`): a downsampled pass
        // renders into a smaller target, and its uResolution must be THAT size
        // (fragments derive uv from gl_FragCoord). Later passes just sample the
        // texture by uv, so mixed sizes compose transparently.
        // `scale` may be per axis ([sx, sy]: Fast Blur halves only the axes it
        // blurs) and a function of the params (the pyramid level).
        const rawScale = pass.main ? 1
          : (typeof pass.scale === 'function' ? pass.scale(params, setCtx) : (pass.scale || 1));
        const sx = Array.isArray(rawScale) ? rawScale[0] : rawScale;
        const sy = Array.isArray(rawScale) ? rawScale[1] : rawScale;
        // pass.size = a FIXED target (Copy Color Profile's 4×1 stats strip),
        // independent of the plate; its uResolution is that size too. A function
        // sizes it from the params (ASCII's one texel per character) and keeps ONE
        // pool slot that resizes in place, so an animated Cell Size never piles up
        // a target per size.
        const dynamicSize = !pass.main && typeof pass.size === 'function';
        const fixedRaw = pass.main ? null : (dynamicSize ? pass.size(params, setCtx) : pass.size);
        const fixed = Array.isArray(fixedRaw) ? fixedRaw : null;
        const pw = fixed ? Math.max(1, Math.round(fixed[0])) : Math.max(1, Math.round(read.width * sx));
        const ph = fixed ? Math.max(1, Math.round(fixed[1])) : Math.max(1, Math.round(read.height * sy));
        applyEffectUniforms(passMat, effForUniforms,
          sx === 1 && sy === 1 && !fixed ? uniformCtx : { ...uniformCtx, width: pw, height: ph });
        if (pass.set) {
          const slots = pass.set(params, setCtx);
          for (const [slot, value] of Object.entries(slots)) passMat.uniforms.uParams.value[Number(slot)] = value;
        }
        // pass.region names a buffer whose projected box bounds the pass's
        // sampling: its frame-uv AABB (inset by params.inset %) lands in
        // uParams[24..27]. A buffer without a box means the whole frame.
        if (pass.region) {
          const aabb = boxAabb(buffers[pass.region]?.box || null, Number(params.inset) || 0);
          const up = passMat.uniforms.uParams.value;
          up[24] = aabb[0]; up[25] = aabb[1]; up[26] = aabb[2]; up[27] = aabb[3];
        }
        // uSource is what the main pass's uMix bypass fades back to; an explicit
        // `inputs.uSource` (the choker) overrides it below.
        if (passMat.uniforms.uSource) passMat.uniforms.uSource.value = bind.uSource?.tex ?? buffers.source.tex;
        for (const [uniform, handle] of Object.entries(bind)) {
          if (uniform === 'uSource') continue;
          if (passMat.uniforms[uniform]) passMat.uniforms[uniform].value = handle?.tex ?? null;
        }
        let target;
        if (pass.main) {
          target = write;
        } else {
          // poolSlot lets a chain reuse two targets as a ping-pong (the jump-flood
          // steps); unnamed passes get their own auto slot. The key carries scale
          // and filtering so unlike targets never fight over one allocation.
          const slot = pass.poolSlot != null ? `s${pass.poolSlot}` : `a${autoSlot++}`;
          const sizeKey = dynamicSize ? 'dyn' : (fixed ? `${pw}x${ph}` : `${sx}x${sy}`);
          target = ensurePassTargetInEngine(engine,
            `${slot}:${sizeKey}:${pass.nearest ? 'n' : 'l'}`,
            pw, ph, !!pass.nearest
          );
          if (!target) { ok = false; break; }
        }
        mesh.material = passMat;
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.render(scene, orthoCamera);
        if (!pass.main) buffers[pass.target] = { tex: target.texture, isRT: true };
      }
      if (!ok) continue;
      let tmp = read; read = write; write = tmp;
      if (layerScope && ctx.matte && effectClipsToLayer(eff)) {
        const res = applyMatteClipInEngine(engine, read, write, ctx.matte, mesh, scene, ctx.mattePlain);
        read = res.read; write = res.write;
      }
      applied++;
      continue;
    }

    const mat = getEffectMaterialInEngine(engine, eff);
    if (!mat) continue; // custom compile error → skip this pass
    applyEffectUniforms(mat, effForUniforms, uniformCtx);
    // Aura Blur uses the reference's real four-level blur pyramid. Build the
    // three blurred mask levels into dedicated scratch targets, preserving all
    // of them until the final shader samples continuously between levels.
    const pyramidTargets = Array.isArray(ctx.pyramid) ? ctx.pyramid : null;
    const pyramidMat = def.pyramidPass && pyramidTargets?.length >= 4
      ? getEffectMaterialInEngine(engine, eff, 'pyramid')
      : null;
    if (pyramidMat) {
      const levels = pyramidTargets.slice(0, 3);
      const scratch = pyramidTargets[3];
      const authoredRadius = Number(effForUniforms?.params?.blurSize);
      const maxRadius = (Number.isFinite(authoredRadius) ? authoredRadius : 130) * (read.height / 1080);
      const fractions = [0.14, 0.4, 1];
      let previousRadius = 0;
      let inputTexture = read.texture;
      for (let level = 0; level < levels.length; level++) {
        const targetRadius = maxRadius * fractions[level];
        // Levels are built cumulatively; convolving by sqrt(B²-A²) advances
        // an existing Gaussian A to the target Gaussian B.
        const passRadius = Math.sqrt(Math.max(0, targetRadius * targetRadius - previousRadius * previousRadius));

        applyEffectUniforms(pyramidMat, effForUniforms, uniformCtx);
        pyramidMat.uniforms.uParams.value[24] = passRadius;
        pyramidMat.uniforms.uParams.value[25] = 0; // horizontal
        pyramidMat.uniforms.uParams.value[26] = level === 0 ? 1 : 0; // source → mask once
        pyramidMat.uniforms.uTexture.value = inputTexture;
        mesh.material = pyramidMat;
        renderer.setRenderTarget(scratch);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.render(scene, orthoCamera);

        applyEffectUniforms(pyramidMat, effForUniforms, uniformCtx);
        pyramidMat.uniforms.uParams.value[24] = passRadius;
        pyramidMat.uniforms.uParams.value[25] = 1; // vertical
        pyramidMat.uniforms.uParams.value[26] = 0;
        pyramidMat.uniforms.uTexture.value = scratch.texture;
        renderer.setRenderTarget(levels[level]);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.render(scene, orthoCamera);

        previousRadius = targetRadius;
        inputTexture = levels[level].texture;
      }
      mat.uniforms.uTexture.value = read.texture;
      mat.uniforms.uSource.value = read.texture;
      mat.uniforms.uTexture1.value = levels[0].texture;
      mat.uniforms.uTexture2.value = levels[1].texture;
      mat.uniforms.uTexture3.value = levels[2].texture;
    }
    // Two-pass effect (def.prePass): render the preparatory pass into the
    // scratch target, then the main pass reads it via uTexture while uSource
    // still holds the effect's original input (also the uMix bypass source).
    const preMat = !pyramidMat && def.prePass && ctx.scratch ? getEffectMaterialInEngine(engine, eff, 'pre') : null;
    if (preMat) {
      applyEffectUniforms(preMat, effForUniforms, uniformCtx);
      preMat.uniforms.uTexture.value = read.texture;
      mesh.material = preMat;
      renderer.setRenderTarget(ctx.scratch);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(scene, orthoCamera);
      mat.uniforms.uTexture.value = ctx.scratch.texture;
      mat.uniforms.uSource.value = read.texture;
    } else if (!pyramidMat) {
      // Single-pass (or scratch unavailable): uSource degrades to the input.
      mat.uniforms.uTexture.value = read.texture;
      if (mat.uniforms.uSource) mat.uniforms.uSource.value = read.texture;
    }
    mesh.material = mat;
    renderer.setRenderTarget(write);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, orthoCamera);
    const tmp = read; read = write; write = tmp;

    // Layer scope: hold the result inside the layer's own silhouette. Applied per
    // effect rather than once at the end so a stack reads the way it looks in the
    // panel — a clipped generator can't leak past the shape, and an effect below it
    // that grows (a glow) still blooms from the already-clipped result.
    if (layerScope && ctx.matte && effectClipsToLayer(eff)) {
      const res = applyMatteClipInEngine(engine, read, write, ctx.matte, mesh, scene, ctx.mattePlain);
      read = res.read; write = res.write;
    }
    applied++;
  }
  if (axisFlip) flipPlate();
  return { read, write };
}

export function runLayerOverlayEffectsInBank(engine, env, srcTarget, matteTarget, fx, t, layerMesh, bank, boxCamera = null,
    { srcCamAxis = true, matteCamAxis = true } = {}) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  const blitScene = engine.blitScene;
  const blitMaterial = engine.blitMaterial;
  if (!renderer || !orthoCamera || !blitScene || !blitMaterial) return srcTarget;
  const { item, entry } = fx;
  const effects = item?.effects;
  if (!Array.isArray(effects) || effects.length === 0) return srcTarget;
  const needPyramid = chainNeedsPyramid(effects);

  const identityOpen = !srcCamAxis && selectedBackend() === 'webgpu'
    && engine.seqPlateCopyMaterial && engine.seqPlateCopyScene;
  const openMaterial = identityOpen ? engine.seqPlateCopyMaterial : blitMaterial;
  openMaterial.uniforms.uTexture.value = srcTarget.texture;
  renderer.setRenderTarget(bank.a);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(identityOpen ? engine.seqPlateCopyScene : blitScene, orthoCamera);

  const duration = entry.endTime - entry.startTime;
  const progress = duration > 0 ? Math.max(0, Math.min(1, (t - entry.startTime) / duration)) : 0;
  const kf = getItemKeyframeValues(item, progress);
  // Neon Glow: bake this layer's outline once per chain run (this call site
  // feeds all three flows — top-level, sequence-nested, pre-transition), and
  // expose a per-INSTANCE phase integrator: each entry's `fx:<eid>:pathSpeed`
  // / `pathHueCycle` tracks give it its own runner. Rates are integrated so a
  // ramp accelerates the light smoothly; an Active Range rebases the phase
  // onto its own start, like the chain rebases the clock.
  const needsPath = Array.isArray(effects)
    && effects.some((e) => e && e.enabled !== false && getAdjustmentEffect(e.id)?.usesPath);
  const path = needsPath ? resolveLayerPathFxInEngine(engine, item, fx.clip, kf, layerMesh) : null;
  const clipNow = t - entry.startTime;
  /*
   * Object effects: each LIVE entry's own subject scan, resolved for this frame.
   * Per-eid, never shared — two Object effects on one layer can be tracking
   * different things with different settings, which is the whole point of the
   * family (objectTracking.js).
   *
   * COSTS NOTHING UNUSED: no entry with a stored track → no closure, no decode,
   * no texture. The chain calls this only for entries that survived the enabled
   * / mix / Active-Range gates, so a muted or windowed-out card pays nothing
   * either. Inside, the field is re-uploaded only when the sample pair actually
   * moves — once for a still, at the scan rate (not the frame rate) for video.
   *
   * The time is SOURCE seconds: the same calculateVideoTime() the video texture
   * uses, so a trimmed or speed-ramped clip keeps the track in sync.
   */
  const needsTrack = effects.some((e) => (
    e && e.enabled !== false && e.track && getAdjustmentEffect(e.id)?.usesTrack
  ));
  const trackFor = needsTrack ? (eff) => {
    if (!eff?.track || !eff.eid) return null;
    const sourceTime = eff.track.kind === 'video' && fx.clip?.mediaType === 'video'
      ? calculateVideoTime(item, clipNow)
      : 0;
    return resolveTrackFrame(eff.eid, eff.track, sourceTime);
  } : null;
  const pathPhase = path ? (eff) => {
    const p = eff?.params || {};
    // Lines Draw drives its head from an eased lap progress, not an integrated
    // speed rate — a pure function of clip time (rebased onto the Active Range
    // like the integrator below), so range renders cold-start exactly.
    if (eff?.id === 'linesDraw') {
      const range = effectRange(eff, duration);
      const local = Math.max(0, clipNow - (range ? Math.max(0, range.start) : 0));
      return linesDrawRunnerState(p, local, !!path.closed);
    }
    const staticSpeed = Number.isFinite(p.pathSpeed) ? p.pathSpeed : 0.35;
    const staticHue = Number.isFinite(p.pathHueCycle) ? p.pathHueCycle : 0;
    const speedKey = eff?.eid ? `fx:${eff.eid}:pathSpeed` : null;
    const hueKey = eff?.eid ? `fx:${eff.eid}:pathHueCycle` : null;
    const range = effectRange(eff, duration);
    const startT = range ? Math.min(Math.max(0, range.start), Math.max(0, clipNow)) : 0;
    const integ = (key, stat, tt) => integratePathRate(item, key, stat, tt, duration);
    const phase = integ(speedKey, staticSpeed, clipNow)
      - (startT > 0 ? integ(speedKey, staticSpeed, startT) : 0);
    const hue = (integ(hueKey, staticHue, clipNow)
      - (startT > 0 ? integ(hueKey, staticHue, startT) : 0)) * (Math.PI / 180);
    const hasTrack = !!(speedKey && item.propertyKeyframes?.[speedKey]?.length);
    return {
      pathPhase: phase,
      pathMoving: hasTrack || Math.abs(staticSpeed) > 1e-4,
      pathHueAngle: hue,
    };
  } : null;
  /*
   * Echo's pose evaluator. The chain normally sees one box — the layer as it
   * is NOW — but a temporal effect needs the box at times it is not being
   * rendered at, including sub-frame ones and (with a positive Echo Time)
   * times in the future. This is the same evaluator Motion Trail reprojects
   * with, exposed to the chain as boxAt(clip-local seconds).
   *
   * Built only when a temporal effect is actually present: it mutates the
   * layer mesh to pose it, and the isolate has ALREADY been filmed with the
   * pose the mesh is holding, so the transform is snapshotted here and
   * restored the moment the chain returns.
   */
  const boxCam = boxCamera || engine.camera;
  const needsPose = layerMesh && boxCam
    && effects.some((e) => e && e.enabled !== false && getAdjustmentEffect(e.id)?.temporal);
  let boxAt = null;
  if (needsPose) {
    const { w: frameW, h: frameH } = engine.videoSize;
    _echoPos.copy(layerMesh.position);
    _echoEuler.copy(layerMesh.rotation);
    _echoScale.copy(layerMesh.scale);
    // Measure what the channel scaled on top of NOW's transform (makePlateScale),
    // then put the pose back: the chain's own layerBox below reads this mesh.
    applyMeshTransform(layerMesh, item, kf, frameW, frameH,
      resolveParentingInEngine(engine, env.parentIndex, item, t), fx.clip, resolveFollowInEngine(engine, env.parentIndex, item, t));
    const plateScale = makePlateScale(layerMesh, _echoScale, item, fx.clip, kf, frameW, frameH);
    layerMesh.position.copy(_echoPos);
    layerMesh.rotation.copy(_echoEuler);
    layerMesh.scale.copy(_echoScale);
    layerMesh.updateWorldMatrix(true, false);
    boxAt = (clipLocal) => {
      // Before the clip starts there is no layer to echo — transparent, which
      // is what AE gives and what stops the stack growing off the front.
      if (clipLocal < 0) return null;
      const time = entry.startTime + clipLocal;
      const p = duration > 0 ? Math.max(0, Math.min(1, clipLocal / duration)) : 0;
      const poseKf = getItemKeyframeValues(item, p);
      applyMeshTransform(layerMesh, item, poseKf, frameW, frameH,
        resolveParentingInEngine(engine, env.parentIndex, item, time), fx.clip,
        resolveFollowInEngine(engine, env.parentIndex, item, time));
      plateScale(poseKf);
      return computeLayerBox(layerMesh, boxCam, srcTarget.width, srcTarget.height);
    };
  }

  /*
   * Geometry effects: this instance's Canvas2D plate (objectPlate.js). The
   * extraction reads the layer's OWN MEDIA ELEMENT — already decoded, already
   * seeked to this frame — rather than reading back the composited isolate,
   * which would be a GPU→CPU sync in the middle of the render tick.
   *
   * Costs nothing unused, on the same terms as the field: no live entry with a
   * plate program → no closure, no extraction, no canvas. Inside, the plate is
   * redrawn only when its key moves (size, frame, params, or the scan).
   */
  // ONE box for the frame: the chain's fx helpers and the geometry plate must
  // agree about where the layer is, or the plate lands beside its own drawing.
  const layerBox = computeLayerBox(
    layerMesh, boxCamera || engine.camera, srcTarget.width, srcTarget.height,
  );
  const needsPlate = effects.some((e) => (
    e && e.enabled !== false && getAdjustmentEffect(e.id)?.usesPlate
  ));
  const plateMedia = needsPlate
    ? (layerMesh?.material?.uniforms?.uTexture?.value?.image || null)
    : null;
  const plateFor = (needsPlate && plateMedia) ? (eff) => {
    const def = getAdjustmentEffect(eff?.id);
    if (!def?.usesPlate || !eff?.eid) return null;
    const params = resolveEffectParams(def, eff);
    const frame = trackFor ? trackFor(eff) : null;
    const sizePx = layerBox?.sizePx || [srcTarget.width, srcTarget.height];
    /*
     * WHICH picture at WHICH frame. The clip id is not decoration: the plate and
     * extraction caches are global, and a key of "video at 0.0s" matched a
     * second, different video at the same source time — the second layer drew
     * the first one's geometry. (resolveObjectPlate also folds in the media
     * element's own identity, so a replaced file is never the same key either.)
     */
    const isVideo = fx.clip?.mediaType === 'video';
    const timeMs = isVideo ? Math.round(calculateVideoTime(item, clipNow) * 1000) : 0;
    const frameKey = isVideo
      ? `v${fx.clip?.id || 'clip'}@${timeMs}`
      : `s${fx.clip?.id || 'still'}`;
    return resolveObjectPlate({
      id: def.id,
      eid: eff.eid,
      isVideo,
      timeMs,
      media: plateMedia,
      boxPx: [Math.max(16, sizePx[0]), Math.max(16, sizePx[1])],
      params,
      colors: {
        ink: params.ink, ink2: params.ink2, accent: params.accent, paper: params.paper,
      },
      field: frame?.field || null,
      fieldW: frame?.w || 64,
      fieldH: frame?.h || 64,
      face: frame?.face || null,
      box: frame?.box || null,
      coverage: frame?.coverage || 0,
      frameKey: `${frameKey}|${frame?.key || 'nofield'}`,
      // The same interactive flag the chain's uQuality carries, plus the scrub
      // detector above, so the plate thins while PLAYING OR SCRUBBING and comes
      // back at full density when the playhead settles (and for every export).
      quality: (env.interactivePreviewEnabled || engine.scrubPlate.active) ? 0.5 : 1,
    });
  } : null;

  // Shape Rulers frames the layer's own rect, which for text is smaller than
  // its plate. Looked up only when such an entry is live — a map read.
  const needsContentBox = effects.some((e) => (
    e && e.enabled !== false && getAdjustmentEffect(e.id)?.usesContentBox
  ));
  let contentBox = needsContentBox ? layerContentBox(item, fx.clip) : null;
  // A masked layer is framed where the mask leaves it visible (box uv, y up,
  // clipped to the laid-out text block when there is one).
  const maskedBox = needsContentBox ? maskVisibleShapeInEngine(engine, item, fx.clip, layerMesh)?.bounds : null;
  if (maskedBox) {
    const m = [maskedBox.x0, 1 - maskedBox.y1, maskedBox.x1, 1 - maskedBox.y0];
    const c = contentBox || [0, 0, 1, 1];
    const cut = [Math.max(m[0], c[0]), Math.max(m[1], c[1]), Math.min(m[2], c[2]), Math.min(m[3], c[3])];
    contentBox = cut[2] > cut[0] && cut[3] > cut[1] ? cut : m;
  }

  const res = runEffectChain(engine, env, item, kf, {
    scope: 'layer',
    effects,
    path,
    pathPhase,
    trackFor,
    plateFor,
    contentBox,
    read: bank.a,
    write: bank.b,
    scratch: bank.c,
    // Levels 0–2 plus a working target; bank.c is free between passes.
    pyramid: needPyramid ? [bank.d, bank.e, bank.f, bank.c] : null,
    matte: matteTarget.texture,
    // See createMatteClipNodeMaterial: a model/rig isolate is already in the
    // chain's orientation and must not be cut by a flipped copy of itself —
    // and neither is an isolate a stage rewrote in place (the mask, the rig).
    mattePlain: isCameraBaked3dPlate(fx.clip, item) || !matteCamAxis,
    matteCamAxis,
    // The layer's on-screen quad. Everything spatial in the chain is expressed
    // in it, so an effect is painted ON the layer and travels, turns and scales
    // with it instead of being a frame-sized field the layer cuts a hole in.
    // The box MUST be projected through the same camera the isolate was
    // rendered with — with a camera rig posed, the neutral camera puts the box
    // at the layer's un-rigged position (for a frame-filling layer, the frame
    // itself), and Neon Glow traced the edge of the view instead of the layer.
    box: layerBox,
    // Temporal effects only (Echo). Null everywhere else, and null in
    // adjustment scope, where "everything below" has no single pose.
    boxAt,
    // Clip-relative, like every other animated effect, so preview and the
    // deterministic export agree frame for frame.
    time: t - entry.startTime,
    progress,
    duration,
  });
  if (needsPose) {
    layerMesh.position.copy(_echoPos);
    layerMesh.rotation.copy(_echoEuler);
    layerMesh.scale.copy(_echoScale);
    layerMesh.updateWorldMatrix(true, false);
  }
  return res.read;
}

export function runLayerOverlayEffects(engine, env, srcTarget, matteTarget, fx, t, layerMesh = null, boxCamera = null, axes = undefined) {
  const effects = fx?.item?.effects;
  if (!Array.isArray(effects) || effects.length === 0) return srcTarget;
  const bank = ensureLayerFxTargetsInEngine(engine, srcTarget.width, srcTarget.height, chainNeedsPyramid(effects));
  return runLayerOverlayEffectsInBank(engine, env, srcTarget, matteTarget, fx, t, layerMesh, bank, boxCamera, axes);
}

export function preparePreTransitionOverlayEffects(engine, env, {
    key,
    mesh,
    material,
    item,
    clip,
    entry,
    time,
    baseZ,
    // id → clip of an item on this level (top level or the sequence the bake
    // runs in) — how a picture reference finds its picture.
    refClipOf = null,
  }) {
  const renderer = engine.renderer;
  const camera = engine.camera;
  // A model's 3D entries render in its own pass, never in this bake.
  item = withFlatEffects(item, clip);
  const effects = item?.effects;
  const hasChain = Array.isArray(effects) && effects.length > 0;
  // A layer mask enters this path too, chain or no chain. Without that, a
  // masked layer with no Overlay Effects would skip the prepare entirely and
  // its mask would silently VANISH for the length of the transition and snap
  // back at the cut — the transition path replaces the mesh with a full-frame
  // carrier, so there is no layer box left for flow 1 to cut against.
  const hasMask = isLayerMaskEnabled(item);
  // Every bakeable per-layer effect enters this path on the same terms: the effect
  // is part of the LAYER, so the transition moves/wipes the effected plate.
  const stack = bakeableLayerStack(item, clip, entry);
  const stages = engine.layerStack;
  if (!renderer || !camera || !mesh?.visible || !material || !entry
    || (!hasChain && !hasMask && !(stack && stages))) return false;

  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const bank = ensurePreTransitionFxTargetsInEngine(engine,
    key,
    size.x,
    size.y,
    hasChain && chainNeedsPyramid(effects)
  );
  const proxy = bank.proxy;
  proxy.geometry = mesh.geometry;
  proxy.material = material;
  proxy.position.copy(mesh.position);
  proxy.quaternion.copy(mesh.quaternion);
  proxy.scale.copy(mesh.scale);
  proxy.visible = true;
  proxy.renderOrder = mesh.renderOrder;

  const previousTarget = renderer.getRenderTarget();
  const previousAutoClear = renderer.autoClear;
  const previousClearColor = renderer.getClearColor(new THREE.Color());
  const previousClearAlpha = renderer.getClearAlpha();

  // Isolate the fully styled source layer through the neutral project camera.
  // Its item transform and filters are baked here; the project camera and the
  // transition are intentionally still downstream.
  applyBlendMode(material, 'normal');
  renderer.autoClear = false;
  renderer.setRenderTarget(bank.source);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(bank.scene, camera);

  // The mask runs HERE — on bank.source, while `proxy` still carries the
  // layer's real transform. Below, the mesh becomes a neutral full-frame
  // carrier and the box would describe the frame instead of the artwork.
  // V-axis provenance: bank.source is a camera render until a pass rewrites
  // it through an ortho quad (mask, rig) — same rule as the compositor's rt.c.
  let camAxis = true;
  // Chroma Key first — the keyed silhouette is what the mask and every later
  // stage must see (the compositor's order, mirrored).
  if (stack?.chromaKey && stages?.chromaKey && stages.chromaKey(bank.source, stack.chromaKey, time, camAxis)) camAxis = false;
  if (hasMask && applyLayerMaskInEngine(engine, bank.source, { item, entry }, proxy, camera, time, 1, camAxis)) camAxis = false;
  // Silhouette framing after the key and the mask — the compositor's order.
  const framed = stack?.chromaKey || (hasMask && maskSilhouetteFraming(item, clip) ? { item, entry, clip } : null);
  if (framed && stages?.silhouetteFraming && stages.silhouetteFraming(bank.source, framed, mesh, time, camAxis)) camAxis = false;

  // The per-layer stack, in the compositor's order — mask → rig → auto fill →
  // glow → overlay chain → the geometry stages — every one of them while `proxy`
  // still carries the real transform. Same renderers, same order, so a clip
  // looks identical the frame before the transition starts and the frame after.
  let out = bank.source;
  let sourceCamAxis = camAxis;
  // A stage that hands back a DIFFERENT target wrote it through an ortho quad,
  // so the plate is no longer camera-axis. The in-place rewrites above (mask,
  // rig, keying) say so themselves; this covers every stage that returns one.
  const advance = (next) => { if (next !== out) camAxis = false; out = next; };
  if (stack && stages) {
    if (stack.rig && stages.rig({ c: bank.source }, stack.rig, proxy, time, camAxis)) camAxis = false;
    // bank.source is the chain's matte: its axis after the in-place rewrites.
    sourceCamAxis = camAxis;
    if (stack.autoFill) {
      // `flipPlate` tells Auto Fill to normalise a camera-axis source IN PLACE
      // before it reads it — so when it is true, bank.source has been rewritten
      // through an ortho quad whether or not the bake itself produced a target.
      const flipPlate = out === bank.source && camAxis;
      advance(stages.autoFill(out, stack.autoFill, proxy, time, flipPlate));
      if (flipPlate) camAxis = false;
    }
    if (stack.depthScan) {
      const flipPlate = out === bank.source && camAxis;
      advance(stages.depthScan(out, stack.depthScan, proxy, camera, time, flipPlate));
    }
    if (stack.fresnelRim && stages.fresnelRim) {
      const flipPlate = out === bank.source && camAxis;
      advance(stages.fresnelRim(out, stack.fresnelRim, proxy, camera, time, flipPlate));
    }
    // Glow lands in bank.c: the chain below starts by copying its source into
    // bank.a, so the source must not already be bank.a.
    if (stack.glow) {
      // Glow wants a camera-axis source (plateToCameraAxis).
      const glowSrc = out === bank.source && camAxis ? out : plateToCameraAxisInEngine(engine, out);
      advance(stages.glow(glowSrc, bank.b, bank.c, stack.glow, time));
    }
  }
  if (hasChain && refClipOf) {
    // Copy Color Profile's picture reference, resolved HERE. This bake runs in
    // the channel pass, before the frame's composite draws its reference
    // plates, and a baked item is never collected for that pre-pass — so the
    // chain read whatever plate the previous composite had left: none for an
    // incoming clip or an entrance, and none from the second frame on once
    // anything else forced the multi-pass compositor (it clears the map and
    // releases the plate). The colour match dropped out for the transition.
    const dur = entry.endTime - entry.startTime;
    const kf = itemHasKeyframes(item) ? getItemKeyframeValues(item, dur > 0 ? clamp01((time - entry.startTime) / dur) : 0) : null;
    const at = { kf, time: time - entry.startTime, duration: dur, master: Number.isFinite(kf?.effectAmount) ? clamp01(kf.effectAmount) : 1 };
    for (const eff of effects) {
      const def = getAdjustmentEffect(eff?.id);
      if (def?.layerRefMode !== 'picture' || !effectIsLiveAt(eff, at, item)) continue;
      const srcId = eff.params?.[def.usesLayerRef];
      if (typeof srcId !== 'string' || !srcId || srcId === item.id) continue;
      // Take the plate at the size the composite gave it, if it has one, so a
      // supersampled composite and this bake never resize it back and forth.
      const pooled = engine.passPool.get(`colorRef:item:${srcId}`);
      const ref = ensurePictureRefPlateInEngine(engine, srcId, refClipOf(srcId),
        pooled?.width || bank.source.width, pooled?.height || bank.source.height);
      if (!ref) { engine.colorRefPlates.delete(srcId); continue; }
      engine.colorRefBakeKeys.add(ref.key);
      engine.colorRefPlates.set(srcId, ref.plate);
    }
  }
  if (hasChain) {
    advance(runLayerOverlayEffectsInBank(engine, env,
      out,
      bank.source,
      { item, entry, clip },
      time,
      proxy,
      bank,
      camera,
      { srcCamAxis: out === bank.source && camAxis, matteCamAxis: sourceCamAxis }
    ));
  }
  if (stack && stages) {
    const geo = stages.geometry(out, stack, {
      mesh: proxy, cam: camera, t: time,
      ping: bank.a, pong: bank.b,
      camAxisTarget: bank.source, camAxis,
      cacheKey: `pretx:${item.id}`,
    });
    out = geo.out;
    // KEEP THE RUNNER'S VERDICT. The compositor does (renderAdjustmentComposite:
    // `rtcCameraAxis = geo.camAxis`) and then normalises; this path used to drop
    // it, and every geometry stage can BYPASS — `droAmount > 0.01`,
    // `repAmount > 0.01`, a renderer returning null — leaving the plate exactly
    // as the camera rendered it while the carrier below claimed otherwise.
    camAxis = geo.camAxis;
  }

  // Turn the original mesh into a neutral full-frame carrier for the effected
  // plate. The transition now mutates this carrier, so its geometry/opacity/wipe
  // happens after fisheye, blur, glow, or any other Overlay Effect.
  resetMaterialUniforms(material);
  material.uniforms.uTexture.value = out.texture;
  material.uniforms.uResolution.value.set(out.width, out.height);
  material.uniforms.uCanvasSize.value.set(engine.videoSize.w, engine.videoSize.h);
  material.uniforms.uInputPremultiplied.value = 1;
  // V axis. This is the same arrangement as the adjustment quad and the
  // override plates in setupMesh: a perspective-camera plane textured from one
  // of this compositor's render targets, which on WebGPU reads on the opposite
  // V axis when the plate is camera-axis. resetMaterialUniforms just cleared
  // the flag, so it has to be re-asserted HERE, against this plate's actual
  // provenance — the stack above may have left the camera's own isolate
  // (nothing rewrote it) or a finished quad plate.
  //
  // Measured, tests/webgpu-migration/verify_export_orientation.js `tx-bypass`
  // (a Droste held under its own 0.01 bypass threshold by a keyframe track, so
  // the effect counts as enabled and the pass never runs): 13 of 27 frames
  // mid-transition were an exact vertical mirror of WebGL's before this, and
  // none after. The `tx-chain` twin was always upright — an Overlay Effects
  // chain opens with a normalising blit — which is why this only ever hit
  // SOME transitions.
  if (selectedBackend() === 'webgpu' && material.uniforms.uInputFlipV && camAxis && out === bank.source) {
    material.uniforms.uInputFlipV.value = 1;
  }
  material.userData.textureSource = `__pretransition_fx__:${key}`;
  mesh.position.set(0, 0, baseZ);
  mesh.rotation.set(0, 0, 0);
  mesh.scale.set(1, 1, 1);
  mesh.visible = true;
  applyBlendMode(material, clip?.mediaType === 'text' ? 'normal' : item?.blendMode);

  renderer.setRenderTarget(previousTarget || null);
  renderer.setClearColor(previousClearColor, previousClearAlpha);
  renderer.autoClear = previousAutoClear;

  engine.preTransitionFxUsed.add(key);
  engine.preTransitionFxItemIds.add(item.id);
  return true;
}
