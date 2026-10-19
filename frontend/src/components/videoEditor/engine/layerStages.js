/*
 * The per-layer stages around the effect chain (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 19 — moved
 * verbatim out of the Player with tests/engine-extraction/tools/convert_leaf.py): a layer's Layer Mask on its isolate
 * (applyLayerMask), the Rig (Puppet) warp (renderLayerRig), Glass and Backdrop Blur behind a shape (applyGlass,
 * applyBackdropBlur), and the geometry stages — the warps, Pryzm, Repetile and Mockup Frame in the order the layer
 * lists them (runLayerGeometryStages).
 */
import * as THREE from 'three';
import { BACKDROP_MIN_SIGMA } from '../backdropBlur';
import { resolveBendParams } from '../bendLayer';
import { resolveBezierWarpParams } from '../bezierWarp';
import { resolveCornerPinParams } from '../cornerPinLayer';
import { resolveDrosteParams } from '../drosteLayer';
import { computeGlassFrame, setGlassUniforms } from '../glassEffect';
import { getItemKeyframeValues, integratePathRate } from '../gsapTransitions';
import { setFxBoxUniforms } from '../homography';
import { createLayerMaskMaterial } from '../layerMask';
import { materials as makeMaterial } from '../materialFactory';
import { resolveMeshWarpParams } from '../meshWarp';
import { resolveMockupFrameParams } from '../mockupFrame';
import { resolvePryzmParams } from '../pryzmLayer';
import { resolveRegionDistortParams } from '../regionDistort';
import { resolveRepetileParams } from '../repetileLayer';
import { createRigCopyMaterial, createRigWarpMaterial, deformRig, getRigDeformState, getRigEffect, isRigPoseNeutral, resolveRigPoses } from '../rigDeform';
import { blurBackdropStack as blurBackdropStackInEngine } from './compositeOps';
import { ensureBackdropPass as ensureBackdropPassInEngine, ensureGlassPass as ensureGlassPassInEngine } from './effectPasses';
import { renderLayerMockupFrame as renderLayerMockupFrameInEngine, resolveMockupStageParams as resolveMockupStageParamsInEngine } from './gridMockup';
import { renderLayerRepetile as renderLayerRepetileInEngine } from './historyEffects';
import { resolveMaskCoveragePlate as resolveMaskCoveragePlateInEngine } from './layerMasks';
import { plateToCameraAxis as plateToCameraAxisInEngine, renderLayerPryzm as renderLayerPryzmInEngine } from './layerPasses';
import { computeLayerBox, renderLayerBend as renderLayerBendInEngine, renderLayerBezierWarp as renderLayerBezierWarpInEngine, renderLayerCornerPin as renderLayerCornerPinInEngine, renderLayerDroste as renderLayerDrosteInEngine, renderLayerMeshWarp as renderLayerMeshWarpInEngine, renderLayerRegionDistort as renderLayerRegionDistortInEngine } from './layerWarps';
import { ensurePassTarget as ensurePassTargetInEngine } from './passPool';

export function runLayerGeometryStages(engine, out0, stack, ctx) {
  const { mesh, cam, t, ping, pong, camAxisTarget, cacheKey } = ctx;
  let out = out0;
  let camAxis = ctx.camAxis;
  const progressOf = (entry) => {
    const dur = entry.endTime - entry.startTime;
    return dur > 0 ? Math.max(0, Math.min(1, (t - entry.startTime) / dur)) : 0;
  };
  const step = (fx, resolve, run) => {
    if (!fx || !mesh) return;
    const params = resolve(fx.item, getItemKeyframeValues(fx.item, progressOf(fx.entry)));
    const dest = out === ping ? pong : ping;
    if (!dest) return;
    const res = run(out, dest, params, fx, out === camAxisTarget && camAxis);
    if (res == null) return;
    if (dest === camAxisTarget && res === camAxisTarget) camAxis = false;   // a quad pass rewrote it
    out = res;
  };
  // Mockup Frame runs FIRST: the framed device is one image, and every reshaping
  // stage after it (a pin, a bend, a lattice) must move the chassis with the screen.
  // The stages that follow work on the layer box grown to cover the seated chassis
  // (`mfInfo.box`), so a chassis that overflows the box is reshaped whole rather than
  // clipped at the box edge.
  const mfInfo = {};
  step(stack.mockupFrame, resolveMockupFrameParams, (src, dest, p, fx, flip) => {
    const params = resolveMockupStageParamsInEngine(engine, fx, t);
    // `ctx.mockupSeated`: the isolate was rendered with the layer posed INTO the
    // screen (renderStyledLayerIsolate), so the pass reads the artwork at identity.
    return renderLayerMockupFrameInEngine(engine, src, dest, params, mesh, cam, cacheKey, flip, mfInfo, ctx.mockupSeated === true);
  });
  const geoBox = mfInfo.box || null;
  step(stack.regionDistort, resolveRegionDistortParams,
    (src, dest, p, fx, flip) => renderLayerRegionDistortInEngine(engine, src, dest, p, mesh, cam, flip, geoBox));
  step(stack.bend, resolveBendParams,
    (src, dest, p, fx, flip) => renderLayerBendInEngine(engine, src, dest, p, mesh, cam, flip, geoBox));
  step(stack.meshWarp, resolveMeshWarpParams,
    (src, dest, p, fx, flip) => renderLayerMeshWarpInEngine(engine, src, dest, p, mesh, cam, flip, geoBox));
  step(stack.bezierWarp, resolveBezierWarpParams,
    (src, dest, p, fx, flip) => renderLayerBezierWarpInEngine(engine, src, dest, p, mesh, cam, flip, geoBox));
  step(stack.droste, resolveDrosteParams,
    (src, dest, p, fx, flip) => (p.droAmount > 0.01
      ? renderLayerDrosteInEngine(engine, src, dest, p, mesh, cam, t - fx.entry.startTime, flip, geoBox)
      : null));
  step(stack.pryzm, resolvePryzmParams,
    (src, dest, p, fx, flip) => (p.pzAmount > 0.01
      ? renderLayerPryzmInEngine(engine, src, dest, p, mesh, cam, t - fx.entry.startTime, flip, geoBox)
      : null));
  step(stack.cornerPin, resolveCornerPinParams,
    (src, dest, p, fx, flip) => renderLayerCornerPinInEngine(engine, src, dest, p, mesh, cam, flip, geoBox));
  step(stack.repetile, resolveRepetileParams, (src, dest, p, fx, flip) => {
    if (!(p.repAmount > 0.01)) return null;
    const repDur = fx.entry.endTime - fx.entry.startTime;
    const repNow = t - fx.entry.startTime;
    // Scroll X/Y are rates: keyframed, the offset is the INTEGRAL of the
    // track, or the field jumps every time the rate changes.
    const scroll = {
      x: integratePathRate(fx.item, 'repScrollX', p.repScrollX, repNow, repDur),
      y: integratePathRate(fx.item, 'repScrollY', p.repScrollY, repNow, repDur),
    };
    return renderLayerRepetileInEngine(engine, src, dest, p, mesh, cam, repNow, fx.item, fx.clip, scroll, flip, geoBox);
  });
  return { out, camAxis };
}

export function renderLayerRig(engine, rt, rigFx, layerMesh, t, camAxis = true) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  if (!renderer || !orthoCamera || !layerMesh) return false;
  const { item, entry } = rigFx;
  const effect = getRigEffect(item);
  if (!effect) return false;
  const box = computeLayerBox(layerMesh, engine.camera, rt.c.width, rt.c.height);
  if (!box) return false;
  const duration = entry.endTime - entry.startTime;
  const progress = duration > 0 ? Math.max(0, Math.min(1, (t - entry.startTime) / duration)) : 0;
  const poses = resolveRigPoses(effect, getItemKeyframeValues(item, progress));
  if (!poses.length || isRigPoseNeutral(poses)) return false; // exact identity — skip
  // The bake and the warp read the isolate as the CAMERA stored it; a masked or
  // keyed isolate was rewritten through a quad, which WebGPU stores mirrored —
  // the pins then warped (and copied back) an upside-down layer.
  const src = camAxis ? rt.c : plateToCameraAxisInEngine(engine, rt.c);
  // Same reason as Grow Fill above: the rig's mesh + weights are baked off
  // rt.c's alpha, which an animated mask changes every frame without touching
  // the item object. Handed over separately from the instance key because the
  // bake is async — while a new stamp's mesh builds, the module serves this
  // item's previous state rather than nothing.
  const state = getRigDeformState(
    renderer, src.texture, box, effect,
    effect.eid || item.id,
    item,
    engine.maskCoverageStamp.get(item.id)
  );
  if (!state || !deformRig(state, poses)) return false;
  let pass = engine.rigPass;
  if (!pass) {
    const warpMaterial = createRigWarpMaterial();
    const warpMesh = new THREE.Mesh(new THREE.BufferGeometry(), warpMaterial);
    warpMesh.frustumCulled = false;
    const warpScene = new THREE.Scene();
    warpScene.add(warpMesh);
    const copyMaterial = createRigCopyMaterial();
    const copyScene = new THREE.Scene();
    copyScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), copyMaterial));
    pass = { warpScene, warpMesh, warpMaterial, copyScene, copyMaterial };
    engine.rigPass = pass;
  }
  pass.warpMesh.geometry = state.geo;
  const u = pass.warpMaterial.uniforms;
  u.uTexture.value = src.texture;
  u.uFxOrigin.value.set(box.origin[0], box.origin[1]);
  u.uFxAxisX.value.set(box.axisX[0], box.axisX[1]);
  u.uFxAxisY.value.set(box.axisY[0], box.axisY[1]);
  const dest = ensurePassTargetInEngine(engine, `rig:${item.id}`, rt.c.width, rt.c.height, false);
  if (!dest) return false;
  renderer.setRenderTarget(dest);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(pass.warpScene, orthoCamera);
  // Copy back into rt.c — the isolate and the matte are now the warped plate.
  pass.copyMaterial.uniforms.uTexture.value = dest.texture;
  renderer.setRenderTarget(rt.c);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(pass.copyScene, orthoCamera);
  return true; // rt.c was rewritten through an ortho quad — quad V axis now
}

export function applyLayerMask(engine, src, lm, layerMesh, cam, t, ss = 1, camAxis = true) {
  if (lm?.item) engine.layerMaskCut.delete(lm.item.id);
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  if (!renderer || !orthoCamera || !src) return false;
  const cov = resolveMaskCoveragePlateInEngine(engine, src, lm, layerMesh, cam, t, ss);
  if (!cov) return false;
  // The cut maps frame pixels to the layer box as the CAMERA stored them. A
  // plate the key already rewrote through a quad is mirrored on WebGPU, and
  // the mask landed on the mirrored spot — re-store it camera-axis first.
  const input = camAxis ? src : plateToCameraAxisInEngine(engine, src);

  let pass = engine.layerMaskPass;
  if (!pass) {
    const material = makeMaterial.layerMask() ?? createLayerMaskMaterial();
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
    pass = { scene, material };
    engine.layerMaskPass = pass;
  }
  const u = pass.material.uniforms;
  u.uTexture.value = input.texture;
  u.uMask.value = cov.plate.texture;
  u.uResolution.value.set(src.width, src.height);
  setFxBoxUniforms(u, cov.box);
  u.uAmount.value = cov.amount;

  // Keyed by LIFETIME, not by item. This target is consumed and copied back
  // inside this call and is never read across layers, so keying it by item
  // (the `af:`/`rig:` precedent) would pin ~65 MB per masked 4K layer until
  // unmount. Keyed by size instead, so the three compositor flows share it
  // when their plates match and never thrash setSize when they don't.
  const dest = ensurePassTargetInEngine(engine, `lm:apply:${src.width}x${src.height}`, src.width, src.height, false);
  const blitScene = engine.blitScene;
  const blitMaterial = engine.blitMaterial;
  if (!dest || !blitScene || !blitMaterial) return false;
  renderer.setRenderTarget(dest);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(pass.scene, orthoCamera);
  // Copy back — `src` IS the masked plate from here on.
  blitMaterial.uniforms.uTexture.value = dest.texture;
  renderer.setRenderTarget(src);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(blitScene, orthoCamera);
  engine.layerMaskCut.set(lm.item.id, cov);
  return true;
}

export function applyGlass(engine, read, write, glass, cs, root, camera, projectW, matte = null, maskItem = null) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  const pass = ensureGlassPassInEngine(engine, );
  if (!renderer || !orthoCamera || !pass || !read || !write || !glass || !cs || !camera) return false;
  const mesh = cs.currMesh?.visible ? cs.currMesh : (cs.prevMesh?.visible ? cs.prevMesh : null);
  if (!mesh) return false;
  // The pane fades with its layer: the clip material's uOpacity is the layer's
  // effective opacity this frame (static × keyframes × reveal), the value its
  // plate is scaled by (the applySilhouetteFraming precedent). Invisible = no work.
  const opacityUniform = mesh.material?.uniforms?.uOpacity?.value;
  const opacity = Number.isFinite(opacityUniform) ? Math.min(1, Math.max(0, opacityUniform)) : 1;
  if (opacity <= 0.001) return false;
  root?.updateMatrixWorld?.();
  camera.updateMatrixWorld();
  const ndcZ = camera.coordinateSystem === THREE.WebGPUCoordinateSystem ? [0, 1] : [-1, 1];
  const frame = computeGlassFrame(mesh, camera, glass.shape, glass.m, { ndcZ, flipV: ndcZ[0] === 0 });
  if (!frame) return false;
  // Frost: the Backdrop Blur chain's blur of the same stack (project px → target px).
  const sigma = glass.m.frost * (read.width / Math.max(1, projectW || read.width));
  const blurT = sigma >= 1 ? blurBackdropStackInEngine(engine, read, sigma, 2) : null;
  const { material, mesh: quad, scene } = pass;
  quad.material = material;
  const u = material.uniforms;
  u.uStack.value = read.texture;
  // Unfrosted → nothing bound (the shader never reads it). Binding the stack to
  // BOTH samplers left WebGPU's blur binding stale for the NEXT glass pane in the
  // frame: it went on reading the target that pass was writing (measured:
  // tests/glass-effect/verify_still.mjs `stack`, a frosted disc over a clear card).
  u.uBlur.value = blurT ? blurT.texture : null;
  // Layer Mask: the cut the mask pass just gave this layer's isolate (`maskItem`
  // is passed only where that pass ran). Same plate, same layer box — the box map
  // is in frame uv, so the isolate's supersample does not matter.
  const cut = maskItem ? engine.layerMaskCut.get(maskItem.id) : null;
  const layerMask = cut?.plate?.texture ? { texture: cut.plate.texture, box: cut.box, amount: cut.amount } : null;
  setGlassUniforms(u, { m: glass.m, shape: glass.shape, frame, frosted: !!blurT, resolution: [read.width, read.height], opacity, matte, layerMask });
  renderer.setRenderTarget(write);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(scene, orthoCamera);
  return true;
}

export function applyBackdropBlur(engine, read, write, matte, matteQuadPlate, params, projectW) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  const pass = ensureBackdropPassInEngine(engine, );
  if (!renderer || !orthoCamera || !pass || !matte?.texture || !read || !write) return false;
  const sigma = params.blurPx * (read.width / Math.max(1, projectW || read.width));
  if (!(sigma >= BACKDROP_MIN_SIGMA)) return false;
  const vT = blurBackdropStackInEngine(engine, read, sigma);
  if (!vT) return false;
  const { mesh, scene } = pass;
  // 3. the stack, replaced by the blur where the shape covers it.
  const mixMat = matteQuadPlate ? pass.mixFlip : pass.mix;
  mesh.material = mixMat;
  mixMat.uniforms.uTexture.value = read.texture;
  mixMat.uniforms.uBlur.value = vT.texture;
  mixMat.uniforms.uMatte.value = matte.texture;
  mixMat.uniforms.uResolution.value.set(read.width, read.height);
  mixMat.uniforms.uAlphaRef.value = params.alphaRef;
  mixMat.uniforms.uSaturation.value = params.saturation;
  renderer.setRenderTarget(write);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(scene, orthoCamera);
  return true;
}
