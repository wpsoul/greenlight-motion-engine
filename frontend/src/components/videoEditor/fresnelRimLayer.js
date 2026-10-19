/*
 * Fresnel Rim — layer effect in the Depth pack (look-dev: html/fresnel-rim-lab).
 *
 * Light that hugs the edges of a subject, read from its SHAPE rather than its
 * outline. Two renderings of one idea, picked by the layer type:
 *
 *   3D model   the real surface rim: 1 − n·v from the model's own normals, inside
 *              its 3D pass (model3dFx.js), with its own halo pass. It turns with
 *              the model and lights the edges INSIDE the outline too.
 *   image /    an EDGE rim on the depth map (Build Depth Map): only edges glow —
 *   video      wherever depth falls away behind a pixel — and, like Depth Scan, a
 *              depth window (Position) picks WHICH edges, swept by Speed.
 *
 * This module is DATA ONLY (ids, defaults, field lists, the per-frame resolver)
 * so the registry, the sanitizer and the inspector can import it without pulling
 * in any shader; the passes live in model3dFx.js and fresnelRimFlat.js, both
 * loaded on first use.
 */
import { getItemDepthMap } from './depthMapEffect';

export const FRESNEL_RIM_LAYER_EFFECT_ID = 'fresnelRim';

// Free, like Depth Scan.
export const FR_IS_PRO = false;

export const FR_DEFAULTS = {
  // look — both renderings
  frColorA: '#e8f6ff',
  frColorB: '#4aa8ff',
  frIntensity: 2.2,     // × emission
  frHalo: 0.6,          // × halo strength; 0 skips the halo pass
  frPulse: 0,           // %
  frDirMix: 0,          // % — keep the rim to one side
  frAngle: 0,           // ° — that side
  // 3D model
  frWidth: 45,          // % — rim width (Fresnel exponent 8 → 0.8)
  frSoftness: 60,       // % — hard band → raw falloff
  frBody: 100,          // % — the model's own light under the rim (the lab's Base light); 100 = untouched
  // image / video — the depth sweep (Depth Scan's model)
  frPhase: 30,          // % — the depth level whose edges glow
  frSpeed: 22,          // %/s
  frEase: 1,            // 0 linear, 1 hold ends
  frRimPx: 12,          // px of a 1080-tall frame — how far the glow reaches in
  frEdgeMin: 2,         // % — smallest depth drop that counts as an edge
  frWindow: 14,         // % — depth window around the level
  frFeather: 4,         // % — its softness
  frGamma: 1,           // depth curve
  frLow: 30,            // % — far cut
  frHigh: 99.5,         // % — near cut
  frBgDim: 100,         // % — brightness kept outside the light (100 = untouched)
  frAmount: 100,        // % master mix; 0 is an exact bypass
};

// `kf: true` → keyframable (registered in keyframeProps.js). `only` marks a field
// that applies to one rendering — the inspector hides the other's.
export const FR_NUMBER_FIELDS = [
  { key: 'frIntensity', label: 'Intensity', min: 0, max: 6, step: 0.05, kf: true },
  { key: 'frWidth', label: 'Width', min: 0, max: 100, step: 1, suffix: '%', kf: true, only: 'model' },
  { key: 'frSoftness', label: 'Softness', min: 0, max: 100, step: 1, suffix: '%', only: 'model' },
  { key: 'frHalo', label: 'Halo', min: 0, max: 3, step: 0.05, kf: true },
  { key: 'frBody', label: 'Body Light', min: 0, max: 100, step: 1, suffix: '%', kf: true, only: 'model' },
  { key: 'frPulse', label: 'Pulse', min: 0, max: 100, step: 1, suffix: '%' },
  { key: 'frDirMix', label: 'From a Side', min: 0, max: 100, step: 1, suffix: '%', kf: true },
  { key: 'frAngle', label: 'Side Angle', min: 0, max: 360, step: 1, suffix: '°', kf: true },
  { key: 'frPhase', label: 'Position', min: 0, max: 100, step: 0.1, suffix: '%', kf: true, only: 'flat' },
  { key: 'frSpeed', label: 'Speed', min: -100, max: 100, step: 1, suffix: '%/s', only: 'flat' },
  { key: 'frRimPx', label: 'Rim Width', min: 2, max: 40, step: 0.5, suffix: 'px', kf: true, only: 'flat' },
  { key: 'frEdgeMin', label: 'Edge Pick-up', min: 0.3, max: 10, step: 0.1, suffix: '%', only: 'flat' },
  { key: 'frWindow', label: 'Depth Window', min: 1, max: 60, step: 0.5, suffix: '%', kf: true, only: 'flat' },
  { key: 'frFeather', label: 'Window Softness', min: 0, max: 20, step: 0.1, suffix: '%', only: 'flat' },
  { key: 'frGamma', label: 'Depth Curve', min: 0.25, max: 3, step: 0.01, only: 'flat' },
  { key: 'frLow', label: 'Far Cut', min: 0, max: 40, step: 0.5, suffix: '%', only: 'flat' },
  { key: 'frHigh', label: 'Near Cut', min: 60, max: 100, step: 0.5, suffix: '%', only: 'flat' },
  { key: 'frBgDim', label: 'Background', min: 0, max: 100, step: 1, suffix: '%', only: 'flat' },
  { key: 'frAmount', label: 'Amount', min: 0, max: 100, step: 1, suffix: '%', kf: true },
];

export const FR_ENUM_FIELDS = [
  { key: 'frEase', label: 'Sweep', options: [[0, 'Linear'], [1, 'Hold Ends']], only: 'flat' },
];

export const FR_COLOR_FIELDS = [
  { key: 'frColorA', label: 'Edge Color' },
  { key: 'frColorB', label: 'Falloff Color' },
];

export const FR_KF_KEYS = FR_NUMBER_FIELDS.filter((f) => f.kf).map((f) => f.key);

// Looks (the lab's four), shared by both renderings.
export const FR_PRESETS = [
  { name: 'Backlight', colors: ['#e8f6ff', '#4aa8ff'], params: { frColorA: '#e8f6ff', frColorB: '#4aa8ff', frIntensity: 2.2, frWidth: 45, frSoftness: 60, frHalo: 0.5, frBody: 40, frPulse: 0, frDirMix: 0, frAngle: 0 } },
  { name: 'Neon Edge', colors: ['#ff4fd8', '#7b3cff'], params: { frColorA: '#ff4fd8', frColorB: '#7b3cff', frIntensity: 5.2, frWidth: 42, frSoftness: 40, frHalo: 1.2, frBody: 25, frPulse: 0, frDirMix: 0, frAngle: 0 } },
  { name: 'Ember', colors: ['#ffd27a', '#ff3d1f'], params: { frColorA: '#ffd27a', frColorB: '#ff3d1f', frIntensity: 3, frWidth: 45, frSoftness: 55, frHalo: 0.8, frBody: 30, frPulse: 25, frDirMix: 85, frAngle: 210 } },
  { name: 'Glacier', colors: ['#bffcff', '#1f5bff'], params: { frColorA: '#bffcff', frColorB: '#1f5bff', frIntensity: 2.6, frWidth: 70, frSoftness: 80, frHalo: 0.7, frBody: 35, frPulse: 0, frDirMix: 40, frAngle: 120 } },
];

export function getFresnelRimEffect(item) {
  const list = item?.layerEffects;
  if (!Array.isArray(list)) return null;
  return list.find((effect) => effect?.id === FRESNEL_RIM_LAYER_EFFECT_ID) || null;
}

/**
 * Live on this layer? `mediaType` picks the rendering: a model needs nothing else;
 * an image or video needs a depth map, exactly like Depth Scan.
 */
export function isFresnelRimEnabled(item, mediaType) {
  const effect = getFresnelRimEffect(item);
  if (!effect || effect.enabled === false) return false;
  if (mediaType !== 'model3d' && !getItemDepthMap(item)) return false;
  const amount = Number(effect.params?.frAmount);
  return (Number.isFinite(amount) ? amount : FR_DEFAULTS.frAmount) > 0.01;
}

export function resolveFresnelRimParams(item, keyframeProps) {
  const params = getFresnelRimEffect(item)?.params || {};
  const out = { ...FR_DEFAULTS };
  for (const key of Object.keys(FR_DEFAULTS)) {
    const stored = params[key];
    if (typeof FR_DEFAULTS[key] === 'string') {
      if (typeof stored === 'string' && stored) out[key] = stored;
    } else if (Number.isFinite(Number(stored))) {
      out[key] = Number(stored);
    }
  }
  for (const key of FR_KF_KEYS) {
    const kf = keyframeProps?.[key];
    if (Number.isFinite(kf)) out[key] = kf;
  }
  // Amount scales the light, so 0 is the exact bypass the gate above already took.
  out.frIntensity *= Math.max(0, Math.min(1, out.frAmount / 100));
  return out;
}

/** Depth Scan's sweep, closed form (depthScanLayer.depthScanPhase) on fr* params. */
export function fresnelRimPhase(params, clipSeconds) {
  const linear = (params.frPhase / 100) + (params.frSpeed / 100) * Math.max(0, clipSeconds);
  const u = linear - Math.floor(linear);
  if (!(params.frEase > 0.5)) return u;
  const eased = (0.59 * u - (0.82 * Math.sin(2 * Math.PI * u)) / (4 * Math.PI)) / 0.59;
  return eased - Math.floor(eased);
}

// ── The passes, loaded on first use ─────────────────────────────────────────
// model3dFx.js holds both renderings (the model rim and this edge rim share its
// light pass, blur pyramid and add-light pass). A project without Fresnel Rim
// never imports it.
let fxModule = null;
let fxModulePromise = null;
/** The loaded pass module, or null — starting the import, and calling `onReady` when it lands. */
export function fresnelRimFxModule(onReady) {
  if (fxModule) return fxModule;
  if (!fxModulePromise) {
    fxModulePromise = import('./model3dFx')
      .then((m) => { fxModule = m; onReady?.(); return m; })
      .catch(() => { fxModulePromise = null; return null; });
  }
  return null;
}
/** For the render page: the module AND its backend twin, before the first frame. */
export async function preloadFresnelRimFx() {
  fresnelRimFxModule();
  const m = await fxModulePromise;
  if (m) await m.modelFxWhenReady();
  return m;
}
