/*
 * Compositing operations (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 17 — moved verbatim out of the Player
 * with tests/engine-extraction/tools/convert_leaf.py): Backdrop Blur's blur of what is behind a shape
 * (blurBackdropStack), the destination-reading shader blend modes (applyShaderBlend), a track matte's clip
 * (applyMatteClip), an adjustment layer's Layer Mask (applyAdjustmentMask) and the plate a picture reference reads
 * (ensurePictureRefPlate — its image texture repaints the frame when it lands, exactly as the Player's handle did).
 *
 * Engine fields: renderer, orthoCamera, the composite pipeline's materials/scenes, the lazily built passes,
 * adjustmentMaskPass (released with the renderer), renderFrame.
 */
import * as THREE from 'three';
import { BACKDROP_MAX_HALF_TAPS, planBackdropBlur } from '../backdropBlur';
import { BLEND_MODE_INDEX } from '../blendModes';
import { setFxBoxUniforms } from '../homography';
import { createAdjustmentMaskMixMaterial } from '../layerMask';
import { materials as makeMaterial } from '../materialFactory';
import { ensureBackdropPass as ensureBackdropPassInEngine, ensureBlendPass as ensureBlendPassInEngine } from './effectPasses';
import { resolveMaskCoveragePlate as resolveMaskCoveragePlateInEngine } from './layerMasks';
import { getImageTexture as getImageTextureInEngine } from './mediaTextures';
import { ensurePassTarget as ensurePassTargetInEngine } from './passPool';
import { drawPicturePlate } from './canvasHelpers';

export function blurBackdropStack(engine, read, sigma, minDs = 1) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  const pass = ensureBackdropPassInEngine(engine, );
  if (!renderer || !orthoCamera || !pass || !read) return null;
  const plan = planBackdropBlur(sigma, read.width, read.height);
  // A caller may floor the downsample (Glass frosts at half res or coarser —
  // a 1.5 px frost at full res cost two full-frame passes per pane).
  if (minDs > plan.ds) {
    plan.ds = minDs;
    plan.sigmaS = sigma / minDs;
    plan.halfTaps = Math.min(BACKDROP_MAX_HALF_TAPS, Math.max(1, Math.ceil(plan.sigmaS * 3)));
  }
  const { blur, mesh, scene } = pass;
  const draw = (target) => {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, orthoCamera);
  };
  // 1. ×2 box downsamples until the sigma is a few small pixels.
  mesh.material = blur;
  blur.uniforms.uHalfTaps.value = 0;
  blur.uniforms.uStep.value.set(0, 0);
  blur.uniforms.uSigma.value = 1;
  let src = read;
  let w = read.width;
  let h = read.height;
  for (let d = 2; d <= plan.ds; d *= 2) {
    w = Math.max(1, Math.round(read.width / d));
    h = Math.max(1, Math.round(read.height / d));
    const t = ensurePassTargetInEngine(engine, `backdrop:ds${d}`, w, h, false);
    if (!t) return null;
    blur.uniforms.uTexture.value = src.texture;
    blur.uniforms.uResolution.value.set(w, h);
    draw(t);
    src = t;
  }
  // 2. separable gaussian at the small size. Keyed by SIZE: two panes in one
  // frame with different blurs used to resize one shared pair back and forth
  // (240×135 ↔ 1920×1080, four reallocations a frame).
  const hT = ensurePassTargetInEngine(engine, `backdrop:h:${w}x${h}`, w, h, false);
  const vT = ensurePassTargetInEngine(engine, `backdrop:v:${w}x${h}`, w, h, false);
  if (!hT || !vT) return null;
  blur.uniforms.uSigma.value = plan.sigmaS;
  blur.uniforms.uHalfTaps.value = plan.halfTaps;
  blur.uniforms.uResolution.value.set(w, h);
  blur.uniforms.uTexture.value = src.texture;
  blur.uniforms.uStep.value.set(1 / w, 0);
  draw(hT);
  blur.uniforms.uTexture.value = hT.texture;
  blur.uniforms.uStep.value.set(0, 1 / h);
  draw(vT);
  return vT;
}

export function applyShaderBlend(engine, read, write, plate, plateQuad, mode) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  const pass = ensureBlendPassInEngine(engine, );
  if (!renderer || !orthoCamera || !pass || !plate?.texture || !read || !write) return false;
  const idx = BLEND_MODE_INDEX[mode];
  if (!(idx > 0)) return false;
  const mat = plateQuad ? pass.flip : pass.plain;
  pass.mesh.material = mat;
  mat.uniforms.uTexture.value = read.texture;
  mat.uniforms.uLayer.value = plate.texture;
  mat.uniforms.uResolution.value.set(read.width, read.height);
  mat.uniforms.uMode.value = idx;
  renderer.setRenderTarget(write);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(pass.scene, orthoCamera);
  return true;
}

export function applyMatteClip(engine, read, write, matte, mesh, scene, plainMatte = false) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  const clipMat = plainMatte
    ? (engine.matteClipPlainMaterial || engine.matteClipMaterial)
    : engine.matteClipMaterial;
  if (!renderer || !orthoCamera || !clipMat) return { read, write };
  clipMat.uniforms.uTexture.value = read.texture;
  clipMat.uniforms.uMatte.value = matte;
  clipMat.uniforms.uResolution.value.set(read.width, read.height);
  mesh.material = clipMat;
  renderer.setRenderTarget(write);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(scene, orthoCamera);
  return { read: write, write: read };
}

export function applyAdjustmentMask(engine, graded, original, dest, lm, layerMesh, cam, t, ss = 1) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  if (!renderer || !orthoCamera || !graded || !original || !dest) return false;
  const cov = resolveMaskCoveragePlateInEngine(engine, graded, lm, layerMesh, cam, t, ss);
  if (!cov) return false;

  let pass = engine.adjustmentMaskPass;
  if (!pass) {
    const material = makeMaterial.adjustmentMaskMix() ?? createAdjustmentMaskMixMaterial();
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
    pass = { scene, material };
    engine.adjustmentMaskPass = pass;
  }
  const u = pass.material.uniforms;
  u.uTexture.value = graded.texture;
  u.uSource.value = original.texture;
  u.uMask.value = cov.plate.texture;
  u.uResolution.value.set(graded.width, graded.height);
  setFxBoxUniforms(u, cov.box);
  u.uAmount.value = cov.amount;
  renderer.setRenderTarget(dest);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(pass.scene, orthoCamera);
  return true;
}

export function ensurePictureRefPlate(engine, srcItemId, clip, w, h) {
  const url = clip?.mediaType === 'image' ? clip.url
    : (clip?.mediaType === 'video' ? clip.thumbnailUrl : null);
  const tex = url ? getImageTextureInEngine(engine, url, () => engine.renderFrame()) : null;
  if (!tex?.image) return null;
  const key = `colorRef:item:${srcItemId}`;
  const target = ensurePassTargetInEngine(engine, key, w, h, false);
  if (!target) return null;
  const cached = engine.colorRefStatic.get(srcItemId);
  if (!(cached && cached.tex === tex && cached.w === target.width && cached.h === target.height)) {
    if (!drawPicturePlate(engine.renderer, engine.orthoCamera, engine.pictureCopyMaterial, engine.pictureCopyScene, tex, target)) return null;
    engine.colorRefStatic.set(srcItemId, { tex, w: target.width, h: target.height });
  }
  return { key, plate: { texture: target.texture, box: null, isStatic: true } };
}
