/*
 * Small helpers the render loop shares (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 14 — moved verbatim out
 * of Player.jsx, which imports them back for the code that has not moved yet).
 */
import * as THREE from 'three';

// `mipmaps` is for SUPERSAMPLED plates only ("smooth edges" mode), where the canvas
// is deliberately denser than the screen and has to be averaged back down. Plain
// LinearFilter minification is a 4-tap point sample: at the ~1.33x ratio a one-bucket
// supersample produces, it averages almost nothing and the antialiasing edge stays
// one pixel wide — measured, not assumed. A mip chain is what actually widens it.
// Off everywhere else, because the chain is rebuilt on every upload and these
// canvases are redrawn every frame.
export function ensureTextTexture(cacheRef, key, width, height, mipmaps = false) {
  const existing = cacheRef.current.get(key);
  if (existing
    && existing.canvas.width === width
    && existing.canvas.height === height
    && existing.mipmaps === mipmaps) return existing;
  existing?.texture?.dispose();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = mipmaps;
  const created = { canvas, ctx, texture, mipmaps };
  cacheRef.current.set(key, created);
  return created;
}

// Fraction of the layer box a fit-contained media picture covers (the shader's
// fit-contain branch): media whose aspect differs from its plate is letterboxed.
// A video's quad is only its fitted picture, inside the frame-sized box its
// effects keep (layerMesh.js `mediaFrac`).
export function mediaContentFrac(layerMesh) {
  const frac = layerMesh?.userData?.mediaFrac;
  if (frac) return { cw: frac.cw, ch: frac.ch };
  const u = layerMesh?.material?.uniforms;
  const canvasSize = u?.uCanvasSize?.value;
  const mediaSize = u?.uResolution?.value;
  let cw = 1;
  let ch = 1;
  if (canvasSize && mediaSize && canvasSize.x > 1 && canvasSize.y > 1 && mediaSize.x > 0 && mediaSize.y > 0) {
    const mediaAR = mediaSize.x / mediaSize.y;
    const canvasAR = canvasSize.x / canvasSize.y;
    if (Math.abs(mediaAR - canvasAR) > 0.01) {
      if (mediaAR > canvasAR) ch = canvasAR / mediaAR;
      else cw = mediaAR / canvasAR;
    }
  }
  return { cw, ch };
}

// Cheap stable hash for cache keys built from (possibly huge data-URL) strings.
export function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ── Layer Mask coverage plate ───────────────────────────────────────────────
// Quantized plate sizes. The long edge snaps to a rung and the short edge
// follows the box aspect, so plate pixels stay square in layer space (the
// Minkowski offset stroke and the feather blur are only correct if they are).
// 2048 is the cap: a mask edge is geometry, and past ~2K plate pixels the extra
// resolution buys nothing a 4K frame can show.
export const MASK_PLATE_STEPS = [64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048];
export const MASK_PLATE_CAP = 2048;

// The shape's outline baked GPU-readable: PATH_FX_SAMPLES positions at equal arc
// length in PLATE uv (0..1 across the padded plate, y up to match fxLocal), as a
// float N×1 DataTexture the chain binds to uLUT.
export const PATH_FX_SAMPLES = 256;

// Draw an uploaded picture cover-fitted (centred, aspect kept) onto a plate.
// Returns false when the material set is not ready.
export function drawPicturePlate(renderer, orthoCamera, mat, scene, tex, target) {
  if (!mat || !scene || !tex?.image || !target) return false;
  const iw = tex.image.width || tex.image.videoWidth || 1;
  const ih = tex.image.height || tex.image.videoHeight || 1;
  const imgAspect = iw / Math.max(1, ih);
  const plateAspect = target.width / Math.max(1, target.height);
  let sx = 1; let sy = 1;
  if (imgAspect > plateAspect) sx = plateAspect / imgAspect; else sy = imgAspect / plateAspect;
  mat.uniforms.uTexture.value = tex;
  mat.uniforms.uUvScale.value.set(sx, sy);
  mat.uniforms.uUvOffset.value.set((1 - sx) / 2, (1 - sy) / 2);
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(scene, orthoCamera);
  return true;
}
