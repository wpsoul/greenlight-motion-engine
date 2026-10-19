/*
 * The motion passes (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 20 — moved verbatim out of Player.jsx with
 * tests/engine-extraction/tools/convert_leaf.py): Running Glow over one layer, Motion Blur (measured velocity or the
 * sub-frame accumulation), Motion Trail (the analytic repeats + its temporal Frame Echo / Trail Buffer ring), and the
 * export-side motion blur pipeline.
 *
 * These read two LIVE values of the editor — `interactivePreviewEnabled` (lighter passes while playing) and
 * `parentIndex` (layer parenting) — through `env`. The Player builds each env with useMemo over exactly the values the
 * old callback listed as dependencies, so its handles re-create exactly when they used to.
 * Also exported for the Player's own pose save/restore: the Motion Blur / Motion Trail scratch below.
 */
import * as THREE from 'three';
import { getItemKeyframeValues } from '../gsapTransitions';
import { MBLUR_FRAME_DT, applyMotionBlurUniforms, motionBlurPeakDisplacement, resolveMotionBlurParams } from '../motionBlurLayer';
import { TRAIL_FRAME_DT, TRAIL_HISTORY_SCALE, TRAIL_MAX_TAPS, TRAIL_METHOD_BUFFER, TRAIL_METHOD_REPEATS, TRAIL_REBUILD_MAX, TRAIL_RING_MAX, applyTrailDrift, applyTrailWarpUniforms, resolveMotionTrailParams, trailBoxDisplacement } from '../motionTrailLayer';
import { applyRunningGlowUniforms, resolveGlowParams } from '../runningGlow';
import { ensureGlowMaterials as ensureGlowMaterialsInEngine, ensureMotionBlurMaterial as ensureMotionBlurMaterialInEngine, ensureTrailPass as ensureTrailPassInEngine } from './effectPasses';
import { computeLayerBox, renderLayerMotionTrail as renderLayerMotionTrailInEngine } from './layerWarps';
import { applyMeshTransform, makePlateScale, resolveFollow, resolveParenting } from './meshTransform';
import { ensurePassTarget as ensurePassTargetInEngine } from './passPool';

// Motion Blur pose save/restore scratch — synthetic poses are measured on the
// REAL mesh (so the rig's parent chain stays identical) and restored before
// anything else reads it. The proxy carries evaluator output for the
// accumulation mode's pose deltas without touching the mesh per sub-frame ref.
export const _mbPos = new THREE.Vector3();
export const _mbEuler = new THREE.Euler();
export const _mbScale = new THREE.Vector3();
export const _mbProxy = new THREE.Object3D();
// Motion Trail borrows the same "save pose → evaluate synthetic poses → restore"
// dance, and runs in the same frame, so it gets its own scratch.
export const _mtPos = new THREE.Vector3();
export const _mtEuler = new THREE.Euler();
export const _mtScale = new THREE.Vector3();
export const _mbRefPos = new THREE.Vector3();
export const _mbRefEuler = new THREE.Euler();
export const _mbRefScale = new THREE.Vector3();

export function renderLayerGlow(engine, env, srcTarget, fieldTarget, outTarget, glow, t) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  const materials = ensureGlowMaterialsInEngine(engine);
  const scene = engine.glowScene;
  const mesh = engine.glowMesh;
  if (!renderer || !orthoCamera || !scene || !mesh || !materials) return srcTarget;

  const { item, entry } = glow;
  const duration = entry.endTime - entry.startTime;
  const progress = duration > 0 ? Math.max(0, Math.min(1, (t - entry.startTime) / duration)) : 0;
  const params = resolveGlowParams(item, getItemKeyframeValues(item, progress));
  applyRunningGlowUniforms(materials, params, {
    width: srcTarget.width,
    height: srcTarget.height,
    // Clip-relative so the runner starts with the clip and stays deterministic
    // between preview and export.
    time: t - entry.startTime,
    quality: env.interactivePreviewEnabled ? 0 : 1,
  });

  // Pass 1: horizontal Gaussian of the content mask at both radii.
  materials.pre.uniforms.uTexture.value = srcTarget.texture;
  materials.pre.uniforms.uSource.value = srcTarget.texture;
  mesh.material = materials.pre;
  renderer.setRenderTarget(fieldTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(scene, orthoCamera);

  /*
   * TEMPORARY §5 instrument. running-glow differs between backends in the app
   * while its lab passes 40/40, and three bindings have been guessed and
   * eliminated. This hands the PRE pass's own output to a probe so the two
   * passes can be compared separately instead of inferring across both.
   * Gated on ?veDebug=1; remove with the other hooks.
   */
  if (typeof window !== 'undefined' && window.__veDebug) {
    window.__veDebug.glowFieldTarget = fieldTarget;
    window.__veDebug.glowSrcTarget = srcTarget;
  }

  // Pass 2: vertical completion of both fields, then the bands, the runner and
  // the emissive composite over the layer itself.
  materials.main.uniforms.uTexture.value = fieldTarget.texture;
  materials.main.uniforms.uSource.value = srcTarget.texture;
  mesh.material = materials.main;
  renderer.setRenderTarget(outTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(scene, orthoCamera);
  return outTarget;
}

export function measureMotionBlur(engine, env, mblur, cs, chCam, t, pixelW, pixelH) {
  const { item, entry, clip } = mblur;
  const duration = entry.endTime - entry.startTime;
  const progress = duration > 0 ? Math.max(0, Math.min(1, (t - entry.startTime) / duration)) : 0;
  const params = resolveMotionBlurParams(item, getItemKeyframeValues(item, progress));
  if (params.mblurAmount <= 0.01 || params.mblurShutter <= 0.01) return null;

  const layerMesh = cs.currMesh?.visible ? cs.currMesh : (cs.prevMesh?.visible ? cs.prevMesh : null);
  if (!layerMesh) return null;

  const { w: W, h: H } = engine.videoSize;
  const tPrev = t - MBLUR_FRAME_DT;
  const progressPrev = duration > 0 ? Math.max(0, Math.min(1, (tPrev - entry.startTime) / duration)) : 0;
  const kfNow = getItemKeyframeValues(item, progress);
  const kfPrev = getItemKeyframeValues(item, progressPrev);
  _mbPos.copy(layerMesh.position);
  _mbEuler.copy(layerMesh.rotation);
  _mbScale.copy(layerMesh.scale);
  applyMeshTransform(layerMesh, item, kfNow, W, H, resolveParenting(engine, env.parentIndex, item, t), clip,
    resolveFollow(engine, env.parentIndex, item, t));
  const boxNow = computeLayerBox(layerMesh, chCam, pixelW, pixelH);
  applyMeshTransform(layerMesh, item, kfPrev, W, H, resolveParenting(engine, env.parentIndex, item, tPrev), clip,
    resolveFollow(engine, env.parentIndex, item, tPrev));
  const boxPrev = computeLayerBox(layerMesh, chCam, pixelW, pixelH);
  layerMesh.position.copy(_mbPos);
  layerMesh.rotation.copy(_mbEuler);
  layerMesh.scale.copy(_mbScale);
  layerMesh.updateWorldMatrix(true, false);
  if (!boxNow || !boxPrev) return null;

  // Static frame → exact bypass for both modes.
  const peak = motionBlurPeakDisplacement(boxNow, boxPrev, pixelW, pixelH)
    * (params.mblurShutter / 360);
  if (peak < 0.5) return null;
  return { params, boxNow, boxPrev };
}

export function renderLayerMotionBlur(engine, env, srcTarget, outTarget, frame, flipPlate = false) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  const material = ensureMotionBlurMaterialInEngine(engine);
  const scene = engine.motionBlurScene;
  if (!renderer || !orthoCamera || !scene || !material) return srcTarget;
  applyMotionBlurUniforms(material, frame.params, {
    width: srcTarget.width,
    height: srcTarget.height,
    quality: env.interactivePreviewEnabled ? 0.5 : 1,
    boxNow: frame.boxNow,
    boxPrev: frame.boxPrev,
  });
  // flipPlate: srcTarget is the camera-rendered isolate (opposite V axis).
  // Only the node material carries uFlipV, so this guard doubles as the
  // WebGL/WebGPU split — the GLSL twin needs no flip.
  if (material.uniforms.uFlipV) material.uniforms.uFlipV.value = flipPlate ? 1 : 0;
  material.uniforms.uTexture.value = srcTarget.texture;
  renderer.setRenderTarget(outTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(scene, orthoCamera);
  return outTarget;
}

export function renderLayerAccumBlur(engine, env, rt, cs, chCam, mblur, frame, t) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  const mixScene = engine.motionBlurMixScene;
  const mixMaterial = engine.motionBlurMixMaterial;
  if (!renderer || !orthoCamera || !mixScene || !mixMaterial) return false;
  const { item, entry, clip } = mblur;
  const { params } = frame;
  const mesh = cs.currMesh?.visible ? cs.currMesh : (cs.prevMesh?.visible ? cs.prevMesh : null);
  if (!mesh) return false;

  const { w: W, h: H } = engine.videoSize;
  const duration = entry.endTime - entry.startTime;
  const shutterFrames = params.mblurShutter / 360;
  // The Samples slider is the sub-frame count, verbatim, at render quality —
  // halved only during interactive playback.
  const K = Math.max(4, Math.round(params.mblurSamples * (env.interactivePreviewEnabled ? 0.5 : 1)));
  // Phase: where the shutter window sits. Trailing exposes [t − w, t] so the
  // whole streak lands BEHIND the motion; centered [t − w/2, t + w/2];
  // leading [t, t + w].
  const phaseBase = params.mblurPhase === 0 ? -1 : (params.mblurPhase === 2 ? 0 : -0.5);
  const kfAt = (tt) => {
    const p = duration > 0 ? Math.max(0, Math.min(1, (tt - entry.startTime) / duration)) : 0;
    return getItemKeyframeValues(item, p);
  };

  _mbPos.copy(mesh.position);
  _mbEuler.copy(mesh.rotation);
  _mbScale.copy(mesh.scale);
  // Reference: the evaluator's pose at t — deltas are measured against it.
  applyMeshTransform(_mbProxy, item, kfAt(t), W, H, resolveParenting(engine, env.parentIndex, item, t), clip,
    resolveFollow(engine, env.parentIndex, item, t));
  _mbRefPos.copy(_mbProxy.position);
  _mbRefEuler.copy(_mbProxy.rotation);
  _mbRefScale.copy(_mbProxy.scale);

  let acc = rt.c;
  let spare = rt.d;
  for (let k = 0; k < K; k++) {
    const ts = t + MBLUR_FRAME_DT * shutterFrames * (phaseBase + (k + 0.5) / K);
    applyMeshTransform(_mbProxy, item, kfAt(ts), W, H, resolveParenting(engine, env.parentIndex, item, ts), clip,
      resolveFollow(engine, env.parentIndex, item, ts));
    mesh.position.set(
      _mbPos.x + _mbProxy.position.x - _mbRefPos.x,
      _mbPos.y + _mbProxy.position.y - _mbRefPos.y,
      _mbPos.z + _mbProxy.position.z - _mbRefPos.z
    );
    mesh.rotation.set(
      _mbEuler.x + _mbProxy.rotation.x - _mbRefEuler.x,
      _mbEuler.y + _mbProxy.rotation.y - _mbRefEuler.y,
      _mbEuler.z + _mbProxy.rotation.z - _mbRefEuler.z
    );
    mesh.scale.set(
      _mbScale.x * (_mbProxy.scale.x / (Math.abs(_mbRefScale.x) > 1e-9 ? _mbRefScale.x : 1)),
      _mbScale.y * (_mbProxy.scale.y / (Math.abs(_mbRefScale.y) > 1e-9 ? _mbRefScale.y : 1)),
      _mbScale.z
    );
    renderer.setRenderTarget(k === 0 ? acc : rt.f);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(cs.rig, chCam);
    if (k > 0) {
      // Running mean in a shader — additive 1/K into an 8-bit target
      // posterizes dark values (the lab hit this).
      mixMaterial.uniforms.uAcc.value = acc.texture;
      mixMaterial.uniforms.uSub.value = rt.f.texture;
      mixMaterial.uniforms.uResolution.value.set(acc.width, acc.height);
      mixMaterial.uniforms.uW.value = 1 / (k + 1);
      // Provenance flips (node material only): rt.f is always the
      // camera-rendered sub-frame; the accumulator is too at k === 1
      // (rt.c's k=0 render) and a quad-written mix output afterwards.
      if (mixMaterial.uniforms.uFlipA) mixMaterial.uniforms.uFlipA.value = k === 1 ? 1 : 0;
      if (mixMaterial.uniforms.uFlipB) mixMaterial.uniforms.uFlipB.value = 1;
      renderer.setRenderTarget(spare);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(mixScene, orthoCamera);
      const tmp = acc; acc = spare; spare = tmp;
    }
  }
  mesh.position.copy(_mbPos);
  mesh.rotation.copy(_mbEuler);
  mesh.scale.copy(_mbScale);
  mesh.updateWorldMatrix(true, false);

  const mix = Math.min(1, Math.max(0, params.mblurAmount / 100));
  if (mix < 0.999) {
    // Blend back toward a sharp isolate at reduced Effect Amount.
    renderer.setRenderTarget(rt.f);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(cs.rig, chCam);
    mixMaterial.uniforms.uAcc.value = rt.f.texture;
    mixMaterial.uniforms.uSub.value = acc.texture;
    mixMaterial.uniforms.uResolution.value.set(acc.width, acc.height);
    mixMaterial.uniforms.uW.value = mix;
    // rt.f is the fresh camera render; acc is the quad-written mean.
    if (mixMaterial.uniforms.uFlipA) mixMaterial.uniforms.uFlipA.value = 1;
    if (mixMaterial.uniforms.uFlipB) mixMaterial.uniforms.uFlipB.value = 0;
    renderer.setRenderTarget(spare);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(mixScene, orthoCamera);
    const tmp = acc; acc = spare; spare = tmp;
  }
  if (acc !== rt.c) {
    // Land the result in rt.c (the branch's isolate/matte target): uW = 0
    // makes the mix pass a plain copy of uAcc.
    mixMaterial.uniforms.uAcc.value = acc.texture;
    mixMaterial.uniforms.uSub.value = acc.texture;
    mixMaterial.uniforms.uResolution.value.set(acc.width, acc.height);
    mixMaterial.uniforms.uW.value = 0;
    // Both bindings are the quad-written accumulator here.
    if (mixMaterial.uniforms.uFlipA) mixMaterial.uniforms.uFlipA.value = 0;
    if (mixMaterial.uniforms.uFlipB) mixMaterial.uniforms.uFlipB.value = 0;
    renderer.setRenderTarget(rt.c);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(mixScene, orthoCamera);
  }
  return true;
}

export function renderLayerTrail(engine, env, srcTarget, outTarget, trail, cs, chCam, t, channelId, flipPlate = false) {
  const { item, entry, clip } = trail;
  const duration = entry.endTime - entry.startTime;
  const progress = duration > 0 ? Math.max(0, Math.min(1, (t - entry.startTime) / duration)) : 0;
  const params = resolveMotionTrailParams(item, getItemKeyframeValues(item, progress));
  if (params.trailAmount <= 0.01) return srcTarget;
  const method = Math.round(params.trailMethod);
  const count = Math.min(TRAIL_MAX_TAPS, Math.max(0, Math.round(params.trailCount)));
  if (method !== TRAIL_METHOD_BUFFER && (count < 1 || params.trailDecay <= 0.01)) return srcTarget;
  if (method === TRAIL_METHOD_BUFFER && params.trailPersist <= 0.01) return srcTarget;

  const layerMesh = cs.currMesh?.visible ? cs.currMesh : (cs.prevMesh?.visible ? cs.prevMesh : null);
  if (!layerMesh || !outTarget) return srcTarget;

  const pixelW = srcTarget.width, pixelH = srcTarget.height;
  const { w: W, h: H } = engine.videoSize;
  _mtPos.copy(layerMesh.position);
  _mtEuler.copy(layerMesh.rotation);
  _mtScale.copy(layerMesh.scale);
  // What the channel scaled on top of NOW's transform (makePlateScale); every
  // pose below re-poses the mesh anyway and restore() puts it back.
  const kfNow = getItemKeyframeValues(item, progress);
  applyMeshTransform(layerMesh, item, kfNow, W, H, resolveParenting(engine, env.parentIndex, item, t), clip,
    resolveFollow(engine, env.parentIndex, item, t));
  const plateScale = makePlateScale(layerMesh, _mtScale, item, clip, kfNow, W, H);
  const boxAtTime = (time) => {
    const p = duration > 0 ? Math.max(0, Math.min(1, (time - entry.startTime) / duration)) : 0;
    const kf = getItemKeyframeValues(item, p);
    applyMeshTransform(layerMesh, item, kf, W, H, resolveParenting(engine, env.parentIndex, item, time), clip,
      resolveFollow(engine, env.parentIndex, item, time));
    plateScale(kf);
    return computeLayerBox(layerMesh, chCam, pixelW, pixelH);
  };
  const restore = () => {
    layerMesh.position.copy(_mtPos);
    layerMesh.rotation.copy(_mtEuler);
    layerMesh.scale.copy(_mtScale);
    layerMesh.updateWorldMatrix(true, false);
  };
  const boxNow = boxAtTime(t);
  if (!boxNow) { restore(); return srcTarget; }

  // Nominal-30fps frame grid. History slots, buffer steps and echo taps all key
  // off it, so a 24fps export and a 60fps preview build the same trail.
  const frameIdx = Math.round(t / TRAIL_FRAME_DT);
  const boxCache = new Map([[frameIdx, boxNow]]);
  const boxAtFrame = (f) => {
    if (boxCache.has(f)) return boxCache.get(f);
    const time = f * TRAIL_FRAME_DT;
    // Before the clip starts there is no layer to trail — AE's Echo gives
    // transparent there too, so the trail simply stops growing.
    const box = time < entry.startTime ? null : boxAtTime(time);
    boxCache.set(f, box);
    return box;
  };
  const driftAt = (f, k) => {
    const box = boxAtFrame(f);
    return box ? applyTrailDrift(box, k, params, pixelW, pixelH) : null;
  };

  let out = srcTarget;
  if (method === TRAIL_METHOD_REPEATS) {
    const boxes = [];
    let moved = 0;
    const spacing = Math.max(0.05, params.trailSpacing);
    for (let k = 1; k <= count; k++) {
      const box = boxAtFrame(Math.round(frameIdx - k * spacing));
      if (!box) break;
      moved = Math.max(moved, trailBoxDisplacement(boxNow, box, pixelW, pixelH));
      boxes.push(applyTrailDrift(box, k, params, pixelW, pixelH));
    }
    // A still layer whose repeats carry no drift lands every copy exactly under
    // the identical layer, so Behind is an exact bypass. The additive blends are
    // NOT — a stack of identical copies is genuinely brighter, as in AE — so
    // only Behind may skip the pass.
    const drifts = params.trailScale !== 0 || params.trailRotate !== 0
      || params.trailOffsetX !== 0 || params.trailOffsetY !== 0 || params.trailColorize > 0.01;
    if (boxes.length && (drifts || params.trailBlend !== 0 || moved >= 0.5)) {
      out = renderLayerMotionTrailInEngine(engine, srcTarget, outTarget, { params, boxNow, boxes }, flipPlate);
    }
  } else {
    out = renderLayerTrailTemporal(engine, env, srcTarget, outTarget, {
      params, boxNow, frameIdx, method, boxAt: boxAtFrame, driftAt,
    }, channelId, flipPlate);
  }
  restore();
  return out;
}

export function renderLayerTrailTemporal(engine, env, srcTarget, outTarget, frame, channelId, flipPlate = false) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  const pass = ensureTrailPassInEngine(engine);
  if (!renderer || !orthoCamera || !pass || !outTarget) return srcTarget;
  const { params, boxNow, boxAt, driftAt, frameIdx, method } = frame;
  const w = srcTarget.width, h = srcTarget.height;
  const blend = params.trailBlend;
  const colorize = Math.min(1, Math.max(0, params.trailColorize / 100));

  const drawPass = (material, target) => {
    pass.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(pass.scene, orthoCamera);
  };
  // Reproject the current plate (or a recorded one) into `dst`. The sample
  // flip follows the BOUND plate: the live isolate is camera-axis and flips;
  // ring/history plates were written by these same quad passes and do not.
  // `width`/`height` default to the plate; the ring records at half size.
  const warpInto = (dst, texture, srcBox, dstBox, weight, depth, width = w, height = h) => {
    applyTrailWarpUniforms(pass.warp, {
      width, height, srcBox, dstBox, weight, colorize, depth, tint: params.trailTint,
    });
    pass.warp.uniforms.uTexture.value = texture;
    if (pass.warp.uniforms.uFlipV) {
      pass.warp.uniforms.uFlipV.value = flipPlate && texture === srcTarget.texture ? 1 : 0;
    }
    drawPass(pass.warp, dst);
  };

  let state = engine.trailState.get(channelId);
  if (!state) { state = { ring: new Map(), ringBox: new Map(), order: [], buf: { frame: null, parity: 0, sig: '' } }; engine.trailState.set(channelId, state); }
  state.seen = engine.passFrame;
  state.seenAt = performance.now();

  if (method === TRAIL_METHOD_BUFFER) {
    const sig = `${w}x${h}|${params.trailPersist}|${params.trailTaper}|${blend}|${colorize}|${params.trailTint}`;
    const a = ensurePassTargetInEngine(engine, `trail:buf:${channelId}:a`, w, h, false);
    const b = ensurePassTargetInEngine(engine, `trail:buf:${channelId}:b`, w, h, false);
    const plate = ensurePassTargetInEngine(engine, 'trail:plate', w, h, false);
    if (!a || !b || !plate) return srcTarget;
    const buf = state.buf;
    // A jump backwards, a long gap, a resize or a parameter edit all mean what
    // is in the accumulator no longer belongs to this frame.
    const stale = buf.frame === null || buf.sig !== sig || frameIdx < buf.frame || frameIdx - buf.frame > 4;

    // SUB-FRAME STEPPING. Union-ing the layer once per frame only looks like a
    // smear while the layer moves a small fraction of its own size per frame —
    // any faster and the result is a row of discrete copies with scalloped
    // edges, which is exactly what this method exists NOT to be. So the step is
    // subdivided until each one advances a few pixels, with the taper and the
    // persistence divided across the substeps so the shape of the trail does
    // not change with speed.
    const prevBox = boxAt(frameIdx - 1);
    const perFrame = prevBox ? trailBoxDisplacement(boxNow, prevBox, w, h) : 0;
    const stepPx = Math.max(2, 5 * (h / 1080));
    const sub = Math.max(1, Math.min(16, Math.ceil(perFrame / stepPx)));
    const persistSub = Math.pow(Math.min(1, Math.max(0, params.trailPersist / 100)), 1 / sub);
    const taperSub = (Math.max(0, params.trailTaper) * (h / 1080)) / sub;
    const step = (srcTex) => {
      const read = buf.parity === 0 ? a : b;
      const write = buf.parity === 0 ? b : a;
      const u = pass.erode.uniforms;
      u.uSrc.value = srcTex;
      if (u.uFlipSrc) u.uFlipSrc.value = flipPlate && srcTex === srcTarget.texture ? 1 : 0;
      u.uAcc.value = read.texture;
      u.uResolution.value.set(w, h);
      u.uPersist.value = persistSub;
      // Taper is authored in composition px; scale it into plate texels or the
      // trail is twice as short at half resolution as it is in the export.
      u.uTaper.value = taperSub;
      u.uColorize.value = colorize;
      u.uTint.value.set(params.trailTint);
      u.uBlend.value = blend;
      drawPass(pass.erode, write);
      buf.parity ^= 1;
    };
    // One timeline frame, advanced in `sub` reprojected substeps. The last
    // substep of the current frame is the real plate, not a resample of it.
    const runFrame = (f) => {
      for (let i = sub - 1; i >= 0; i--) {
        if (i === 0 && f === frameIdx) { step(srcTarget.texture); continue; }
        const box = boxAt(f - i / sub);
        if (!box) continue;
        warpInto(plate, srcTarget.texture, boxNow, box, 1, 0);
        step(plate.texture);
      }
    };
    if (stale) {
      // Clear both slots, then replay the run-up from reprojected poses. This
      // is the one place preview can differ from a sequential export: the
      // replayed plates are the current pixels moved, not the pixels that were
      // really there. For a transform-driven layer they are the same thing.
      renderer.setRenderTarget(a); renderer.setClearColor(0x000000, 0); renderer.clear(true, true, true);
      renderer.setRenderTarget(b); renderer.clear(true, true, true);
      buf.parity = 0;
      // Budget the replay in PASSES, not frames: a fast layer subdivides more,
      // so the same budget buys fewer frames of run-up rather than a stall.
      const budget = env.interactivePreviewEnabled ? 96 : 192;
      const frames = Math.max(4, Math.min(TRAIL_REBUILD_MAX, Math.floor(budget / sub)));
      for (let f = frameIdx - frames + 1; f <= frameIdx; f++) runFrame(f);
    } else {
      for (let f = buf.frame + 1; f <= frameIdx; f++) runFrame(f);
    }
    buf.frame = frameIdx;
    buf.sig = sig;
    const acc = buf.parity === 0 ? a : b;
    const u = pass.compose.uniforms;
    u.uSrc.value = srcTarget.texture;
    if (u.uFlipSrc) u.uFlipSrc.value = flipPlate ? 1 : 0;
    u.uTrail.value = acc.texture;
    u.uResolution.value.set(w, h);
    u.uBlend.value = blend;
    u.uMix.value = Math.min(1, Math.max(0, params.trailAmount / 100));
    u.uHasSource.value = 1;     // the erode step already unioned the plate in
    drawPass(pass.compose, outTarget);
    return outTarget;
  }

  // ── Frame Echo ──
  const hw = Math.max(8, Math.round(w * TRAIL_HISTORY_SCALE));
  const hh = Math.max(8, Math.round(h * TRAIL_HISTORY_SCALE));
  // Record this frame's plate BEFORE the trail is added, or the echoes feed
  // back on themselves and the ring turns to mush after a few seconds.
  if (!state.ring.has(frameIdx)) {
    let slot = state.ring.size;
    if (state.order.length >= TRAIL_RING_MAX) {
      const evict = state.order.shift();
      slot = state.ring.get(evict);
      state.ring.delete(evict);
      state.ringBox.delete(evict);
    }
    const target = ensurePassTargetInEngine(engine, `trail:hist:${channelId}:${slot}`, hw, hh, false);
    if (target) {
      /*
       * THROUGH warpInto, so the plate is WRITTEN by the same flip rule the
       * taps READ it back with. This used to set the uniforms by hand and
       * never touched uFlipV, so the record inherited whatever the previous
       * draw left there — always 0, because the last tap of the previous
       * frame read a history plate. On WebGL that was harmless (the GLSL warp
       * has no uFlipV at all), but on WebGPU it stored the CAMERA-RENDERED
       * isolate without its flip, so every recorded plate went into the ring
       * vertically mirrored while the reprojected fallbacks stayed upright.
       * The tell was a divergence that GREW as the ring filled and vanished
       * on a fresh seek, when every tap is a fallback.
       *
       * depth 0 makes colorize a no-op, so this is identical to the old call
       * in every respect but the flip.
       */
      warpInto(target, srcTarget.texture, boxNow, boxNow, 1, 0, hw, hh);
      state.ring.set(frameIdx, slot);
      state.ringBox.set(frameIdx, boxNow);
      state.order.push(frameIdx);
    }
  }

  const accA = ensurePassTargetInEngine(engine, 'trail:acc:a', w, h, false);
  const accB = ensurePassTargetInEngine(engine, 'trail:acc:b', w, h, false);
  const tap = ensurePassTargetInEngine(engine, 'trail:tap', w, h, false);
  if (!accA || !accB || !tap) return srcTarget;
  renderer.setRenderTarget(accA); renderer.setClearColor(0x000000, 0); renderer.clear(true, true, true);
  let read = accA, write = accB;
  const count = Math.min(TRAIL_MAX_TAPS, Math.max(1, Math.round(params.trailCount)));
  const spacing = Math.max(0.25, params.trailSpacing);
  const decay = Math.min(1, Math.max(0, params.trailDecay / 100));
  // Near → far: each new repeat goes BEHIND what is already accumulated.
  for (let k = 1; k <= count; k++) {
    const weight = Math.pow(decay, k);
    if (weight < 0.004) break;
    const tapFrame = Math.round(frameIdx - k * spacing);
    const dst = driftAt(tapFrame, k);
    if (!dst) break;
    const slot = state.ring.get(tapFrame);
    const hist = slot === undefined ? null : engine.passPool.get(`trail:hist:${channelId}:${slot}`);
    // Recorded pixels when the ring has them, the reprojected plate when it
    // does not (a fresh seek). The source box differs: recorded pixels already
    // carry that frame's pose, the current plate carries this frame's.
    const srcBox = hist ? (state.ringBox.get(tapFrame) || boxNow) : boxNow;
    warpInto(tap, hist ? hist.texture : srcTarget.texture, srcBox, dst, weight, k / count);
    const u = pass.acc.uniforms;
    u.uAcc.value = read.texture;
    u.uTap.value = tap.texture;
    u.uResolution.value.set(w, h);
    u.uBlend.value = blend;
    drawPass(pass.acc, write);
    const swap = read; read = write; write = swap;
  }
  const u = pass.compose.uniforms;
  u.uSrc.value = srcTarget.texture;
  if (u.uFlipSrc) u.uFlipSrc.value = flipPlate ? 1 : 0;
  u.uTrail.value = read.texture;
  u.uResolution.value.set(w, h);
  u.uBlend.value = blend;
  u.uMix.value = Math.min(1, Math.max(0, params.trailAmount / 100));
  u.uHasSource.value = 0;
  drawPass(pass.compose, outTarget);
  return outTarget;
}

export function getMotionBlurPipeline(engine) {
  const mod = engine.motionBlurModule;
  const renderer = engine.renderer;
  if (!mod || !renderer) return null;
  let pipeline = engine.motionBlurPipeline;
  if (!pipeline || pipeline.renderer !== renderer) {
    try { pipeline?.dispose(); } catch { /* no-op */ }
    pipeline = mod.createMotionBlurPipeline(renderer, {
      setOutputTarget: (target) => { engine.outputTarget = target || null; },
    });
    engine.motionBlurPipeline = pipeline;
  }
  return pipeline;
}
