/*
 * Text-animation glow = Deep Glow over the text plate (html/deep-glow-lab.html, "text" scenes).
 *
 * The text animator's Glow effect (colour · size · strength per unit) used to be canvas shadows behind each glyph —
 * one to three Gaussian shadow blurs per glyph per glow, i.e. a short, soft blob that cost the most exactly when a
 * preset was busiest. Now the painter writes each distinct glow SIZE into its own glow-source plate (the glyph in
 * the glow colour, alpha = the unit's strength / TEXT_GLOW_PLATE_MAX) and this module runs the Deep Glow passes
 * (deepGlowEffect.js, through the chain's own runner) over the text plate once per plate: the plate is the base,
 * the glow-source plate is what glows, so per-unit colour and strength survive and every size keeps its radius.
 * The result is premultiplied, in a target that rides the text cache entry: it is recomputed only when the plate
 * repaints (a settled caption keeps its glow for free) and is released with the entry.
 *
 * Size → radius: a glow Size of s (composition px) lights out to TEXT_GLOW_RADIUS_PER_SIZE·s, which matches what
 * the old shadow glow's visible halo read as at its core while the inverse-square tail runs on past it.
 */
import * as THREE from 'three';
import { getAdjustmentEffect, resolveEffectParams } from '../adjustmentEffects';
import { runDeclarativePasses } from './declarativePasses';

export const TEXT_GLOW_PLATE_MAX = 4;     // a plate's alpha holds strength / 4 (up to 400 %)
const TEXT_GLOW_GAIN = 1.75;              // Strength → exposure, so the presets keep their brightness
const TEXT_GLOW_RADIUS_PER_SIZE = 5;
export const TEXT_GLOW_MAX_PLATES = 3;
// Whether the lit plate (a quad-written target) needs the mesh's V correction on WebGPU — measured by
// tests/deep-glow/verify_text_glow.js.
export const TEXT_GLOW_FLIP_ON_WEBGPU = false;

function canvasTexture(canvas, premultiplied) {
  const t = new THREE.CanvasTexture(canvas);
  t.premultiplyAlpha = premultiplied;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

/**
 * The glow-source canvas for plate `j` of a text cache entry, the size of the text canvas, cleared. Allocated once
 * and kept with the entry (released by its `release`).
 */
export function textGlowPlate(entry, j) {
  if (!entry.glow) {
    entry.glow = { plates: [], targets: [], src: null };
    entry.release = () => releaseTextGlow(entry);
  }
  const { glow } = entry;
  const { canvas } = entry;
  let plate = glow.plates[j];
  if (!plate || plate.canvas.width !== canvas.width || plate.canvas.height !== canvas.height) {
    plate?.texture?.dispose();
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    plate = { canvas: c, ctx: c.getContext('2d'), texture: canvasTexture(c, true) };
    glow.plates[j] = plate;
  }
  plate.ctx.setTransform(1, 0, 0, 1, 0, 0);
  plate.ctx.clearRect(0, 0, plate.canvas.width, plate.canvas.height);
  return plate;
}

function ensureTarget(glow, j, w, h, mipmaps) {
  let rt = glow.targets[j];
  if (rt && (rt.width !== w || rt.height !== h || rt.texture.generateMipmaps !== mipmaps)) { rt.dispose(); rt = null; }
  if (!rt) {
    rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: mipmaps,
    });
    glow.targets[j] = rt;
  }
  return rt;
}

/** Free everything the glow keeps on a text cache entry. */
export function releaseTextGlow(entry) {
  const glow = entry?.glow;
  if (!glow) return;
  for (const p of glow.plates) p?.texture?.dispose();
  for (const t of glow.targets) t?.dispose();
  glow.src?.dispose();
  entry.glow = null;
  entry.glowTexture = null;
}

/**
 * Run the glow over the entry's text plate. `sizes[j]` is plate j's glow Size (composition px) and `compH` the
 * composition height — the plate's raster density cancels out of the radius, which is a fraction of the plate.
 * Returns the premultiplied text + glow texture, or null when nothing glowed (the caller shows the plain plate).
 */
export function renderTextDeepGlow(engine, entry, sizes, compH, mipmaps = false) {
  const def = getAdjustmentEffect('glow');
  const glow = entry.glow;
  const renderer = engine.renderer;
  if (!def || !glow || !renderer || !sizes.length) return null;
  const W = entry.canvas.width;
  const H = entry.canvas.height;
  // The text canvas as the chain's input: premultiplied like every chain plate (the plain text texture stays
  // straight for the regular path), uploaded only when a glow actually runs.
  if (!glow.src || glow.src.image !== entry.canvas) { glow.src?.dispose(); glow.src = canvasTexture(entry.canvas, true); }
  glow.src.needsUpdate = true;
  const prevTarget = renderer.getRenderTarget();
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  let read = { texture: glow.src, width: W, height: H };
  let out = null;
  const ref = H / 1080;
  for (let j = 0; j < sizes.length; j += 1) {
    const plate = glow.plates[j];
    if (!plate) continue;
    plate.texture.needsUpdate = true;
    const eff = {
      id: 'glow',
      params: { glowRadius: (sizes[j] * TEXT_GLOW_RADIUS_PER_SIZE * 1080) / Math.max(1, compH), thresholdBy: 2 },
    };
    const params = resolveEffectParams(def, eff);
    const setCtx = { ref, width: W, height: H, box: null, time: 0, duration: 0, glowSource: true, glowGain: TEXT_GLOW_PLATE_MAX * TEXT_GLOW_GAIN };
    if (def.bypassIf && def.bypassIf(params, setCtx)) continue;
    const write = ensureTarget(glow, out === glow.targets[0] ? 1 : 0, W, H, mipmaps);
    const uniformCtx = { time: 0, progress: 0, duration: 0, width: W, height: H, quality: 1, mix: 1, box: null };
    const buffers = {
      source: { tex: read.texture, isRT: false, box: null },
      matte: { tex: read.texture, isRT: false },
      glowSource: { tex: plate.texture, isRT: false },
    };
    const ok = runDeclarativePasses(engine, { def, eff, effForUniforms: eff, params, setCtx, uniformCtx, read, write, buffers });
    if (!ok) continue;
    out = write;
    read = { texture: write.texture, width: W, height: H };
  }
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  return out ? out.texture : null;
}
