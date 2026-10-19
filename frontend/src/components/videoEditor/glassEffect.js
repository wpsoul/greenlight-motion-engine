/*
 * Glass — a shape layer that IS a pane of glass over everything behind it.
 * Look-dev and the source of every number here: html/glass-lab (presets, the
 * fold guard, the march). Ported to the compositor on the Backdrop Blur model.
 *
 * A TYPED LAYER EFFECT (`item.layerEffects` entry `{ id: 'glass', params }`)
 * THAT RUNS IN THE COMPOSITOR, NOT ON THE ISOLATE. Glass never touches the
 * shape's own pixels — it bends, frosts and shadows the stack accumulated
 * BELOW the shape, which only the multi-pass compositor owns. So the Player
 * runs it as a pre-step on the channel, in Backdrop Blur's slot: the glass
 * pass replaces the stack inside (and the shadow around) the outline, then the
 * shape's own paint — usually just a border — draws over it. It is NOT one of
 * the isolate stages (hasLayerEffectStack / the exact-bypass list / the
 * pre-transition bake): a plain glass shape keeps its direct draw. Stacked
 * glass falls out of the pass order: a sheet higher in the timeline refracts,
 * frosts and shadows the sheets under it.
 *
 * ONE PASS PER GLASS LAYER, all in layer-local px (shape centre, y up, z
 * toward the viewer):
 *   - the pixel's ray is unprojected through the layer's own plane mesh and
 *     the channel camera (P·V·M·S), so 2D, 3D-rotated and camera-moved layers
 *     share one code path;
 *   - a height field: bevel (round / squircle / chamfer) or lens (dome /
 *     concave), plus an optional surface (fluted / hammered / ripple);
 *   - Snell refraction per wavelength (5 spectral taps) down to the glass's
 *     bottom, projected back to the stack — the "lens" on what is behind;
 *   - frost (the Backdrop Blur chain's blur of the same stack), Beer–Lambert
 *     tint, milk, Fresnel studio environment, specular, rim light, and the
 *     pane's soft shadow on the backdrop;
 *   - a tilted layer marches its slab to find the side walls.
 *
 * THE LAYER'S VISIBILITY travels in with the pass, because the pane never draws
 * from the layer's own plate: its opacity, its track matte, and its Layer Mask.
 * The mask is the coverage plate the mask pass cut the layer's isolate with this
 * frame (Player.applyLayerMask), read through the same frame uv → layer box map
 * the cut uses — so the pane keeps exactly what the layer keeps. The shadow reads
 * it at the point that casts it: a cut-away part casts no shadow.
 *
 * FOLD GUARD. Physical squircle/round bevels fold the image (a mirrored band
 * and an infinitely magnified blob at the fold line). glassGuardLUT caps how
 * fast the edge displacement grows (tanh soft-compression) and the shader
 * scales its bend by the stored ratio: the edge stretches instead of folding.
 *
 * Shapes: rectangle (all four corner radii), ellipse and circle. Paths,
 * triangles, arrows and SVG shapes have no analytic outline here.
 */
import * as THREE from 'three';
import { fxBoxHomographies } from './homography';

export const GLASS_LAYER_EFFECT_ID = 'glass';

// ── Parameters ──────────────────────────────────────────────────────────────
// `key` is the engine name (the lab's), `field` the entry's param name — which is
// also the keyframe track name (`propertyKeyframes.glassFrost`), the Pryzm way. Geometry that
// should follow the shape's size (bevel, heights, shadow, clear border) is in
// % of the shape's SHORTER side, so one preset reads the same on a button and
// on a full-width card. Frost, rim width and the surface pattern are absolute
// px: they describe the material, not the object.
export const GLASS_PARAMS = [
  { key: 'profile', field: 'glassProfile', label: 'Profile', group: 'Shape', type: 'select', options: [
    ['circle', 'Round bevel'], ['squircle', 'Squircle bevel'], ['chamfer', 'Chamfer'], ['dome', 'Dome lens'], ['concave', 'Concave lens']] },
  { key: 'bevel', field: 'glassBevel', label: 'Bevel', group: 'Shape', min: 0.5, max: 40, step: 0.5, unit: '%' },
  { key: 'thick', field: 'glassHeight', label: 'Height', group: 'Shape', min: 0, max: 50, step: 0.5, unit: '%' },
  { key: 'body', field: 'glassDepth', label: 'Depth', group: 'Shape', min: 0, max: 50, step: 0.5, unit: '%' },
  { key: 'corner', field: 'glassCorner', label: 'Smoothing', group: 'Shape', min: 2, max: 6, step: 0.1, unit: '' },

  { key: 'ior', field: 'glassIor', label: 'IOR', group: 'Refraction', min: 1, max: 2.4, step: 0.01, unit: '', kf: true },
  { key: 'disp', field: 'glassDispersion', label: 'Dispersion', group: 'Refraction', min: 0, max: 1, step: 0.01, unit: '', kf: true },
  { key: 'magnify', field: 'glassMagnify', label: 'Magnify', group: 'Refraction', min: 0.5, max: 2.5, step: 0.01, unit: '×', kf: true },

  { key: 'frost', field: 'glassFrost', label: 'Frost', group: 'Frost', min: 0, max: 60, step: 0.5, unit: 'px', kf: true },
  { key: 'grain', field: 'glassGrain', label: 'Grain', group: 'Frost', min: 0, max: 1, step: 0.01, unit: '' },
  { key: 'frostEdge', field: 'glassClearBorder', label: 'Clear border', group: 'Frost', min: 0, max: 20, step: 0.5, unit: '%' },

  { key: 'surface', field: 'glassPattern', label: 'Pattern', group: 'Surface', type: 'select', options: [
    ['none', 'None'], ['fluted', 'Fluted'], ['hammered', 'Hammered'], ['ripple', 'Ripple']] },
  { key: 'surfScale', field: 'glassPatternScale', label: 'Scale', group: 'Surface', min: 4, max: 160, step: 1, unit: 'px' },
  { key: 'surfDepth', field: 'glassPatternDepth', label: 'Depth', group: 'Surface', min: 0, max: 40, step: 0.5, unit: 'px' },
  { key: 'surfAngle', field: 'glassPatternAngle', label: 'Angle', group: 'Surface', min: 0, max: 180, step: 1, unit: '°' },

  { key: 'tint', field: 'glassTint', label: 'Tint', group: 'Colour', type: 'color' },
  { key: 'tintAmt', field: 'glassTintAmount', label: 'Tint amount', group: 'Colour', min: 0, max: 1, step: 0.01, unit: '', kf: true },
  { key: 'absorption', field: 'glassTintDepth', label: 'Tint depth', group: 'Colour', min: 0, max: 1, step: 0.01, unit: '' },
  { key: 'milk', field: 'glassMilk', label: 'Milk', group: 'Colour', min: 0, max: 1, step: 0.01, unit: '', kf: true },
  { key: 'sat', field: 'glassSaturation', label: 'Saturation', group: 'Colour', min: 0, max: 2, step: 0.01, unit: '' },
  { key: 'bright', field: 'glassBrightness', label: 'Brightness', group: 'Colour', min: -0.5, max: 0.5, step: 0.01, unit: '' },
  { key: 'edge', field: 'glassEdgeShade', label: 'Edge shade', group: 'Colour', min: 0, max: 1, step: 0.01, unit: '' },

  { key: 'lightAngle', field: 'glassLightAngle', label: 'Light angle', group: 'Light', min: 0, max: 360, step: 1, unit: '°', kf: true },
  { key: 'lightElev', field: 'glassLightElevation', label: 'Elevation', group: 'Light', min: 5, max: 85, step: 1, unit: '°' },
  { key: 'spec', field: 'glassSpecular', label: 'Specular', group: 'Light', min: 0, max: 3, step: 0.01, unit: '' },
  { key: 'shine', field: 'glassShininess', label: 'Shininess', group: 'Light', min: 4, max: 400, step: 1, unit: '' },
  { key: 'rim', field: 'glassRim', label: 'Rim light', group: 'Light', min: 0, max: 2, step: 0.01, unit: '' },
  { key: 'rimWidth', field: 'glassRimWidth', label: 'Rim width', group: 'Light', min: 0.5, max: 20, step: 0.1, unit: 'px' },
  { key: 'refl', field: 'glassReflection', label: 'Reflection', group: 'Light', min: 0, max: 1.5, step: 0.01, unit: '' },
  { key: 'roughness', field: 'glassSoftness', label: 'Softness', group: 'Light', min: 0, max: 1, step: 0.01, unit: '' },

  { key: 'shadow', field: 'glassShadow', label: 'Shadow', group: 'Shadow', min: 0, max: 0.8, step: 0.01, unit: '', kf: true },
  { key: 'shadowBlur', field: 'glassShadowBlur', label: 'Blur', group: 'Shadow', min: 0, max: 30, step: 0.5, unit: '%' },
  { key: 'shadowY', field: 'glassShadowOffset', label: 'Offset', group: 'Shadow', min: 0, max: 20, step: 0.5, unit: '%' },
];
export const GLASS_PARAM_GROUPS = ['Shape', 'Refraction', 'Frost', 'Surface', 'Colour', 'Light', 'Shadow'];
export const GLASS_FIELDS = GLASS_PARAMS.map((p) => p.field);

/** The animation-worthy subset, registered in keyframeProps.js (group Effects). */
export const GLASS_KF_PROPS = GLASS_PARAMS.filter((p) => p.kf).map((p) => ({
  label: p.field, displayLabel: `Glass ${p.label}`, group: 'Effects', placeholder: '',
  unit: p.unit === '×' ? '' : p.unit, type: 'number', min: p.min, max: p.max, step: p.step,
}));

// ── Presets ─────────────────────────────────────────────────────────────────
// Ported from html/glass-lab/presets.js (lab px at a 400 px short side → %).
export const GLASS_PRESETS = [
  { id: 'liquid', name: 'Liquid', note: 'Clear, squircle edge that curls the backdrop',
    params: {profile: 'squircle', bevel: 11, thick: 9.5, body: 4.5, corner: 4, ior: 1.5, disp: 0.14, magnify: 1, frost: 0, grain: 0, frostEdge: 0, surface: 'none', surfScale: 30, surfDepth: 10, surfAngle: 0, tint: '#ffffff', tintAmt: 0, absorption: 0, milk: 0.015, sat: 1.08, bright: 0.008, edge: 0, lightAngle: 120, lightElev: 40, spec: 0.48, shine: 120, rim: 0.52, rimWidth: 1.8, refl: 0.72, roughness: 0.12, shadow: 0.1, shadowBlur: 7, shadowY: 3} },
  { id: 'frosted', name: 'Frosted', note: 'Soft blur, milky body, light edge',
    params: {profile: 'squircle', bevel: 5.5, thick: 4.5, body: 2.5, corner: 4, ior: 1.38, disp: 0, magnify: 1, frost: 24, grain: 0.08, frostEdge: 0, surface: 'none', surfScale: 30, surfDepth: 10, surfAngle: 0, tint: '#f3f6ff', tintAmt: 0.12, absorption: 0, milk: 0.24, sat: 1.12, bright: 0.035, edge: 0, lightAngle: 120, lightElev: 40, spec: 0.6, shine: 90, rim: 0.75, rimWidth: 2.2, refl: 0.45, roughness: 0.65, shadow: 0.18, shadowBlur: 10, shadowY: 4} },
  { id: 'slab', name: 'Crystal Slab', note: 'Thick block, small chamfer, visible walls',
    params: {profile: 'chamfer', bevel: 2.25, thick: 2, body: 16, corner: 4.5, ior: 1.62, disp: 0.22, magnify: 1, frost: 1.5, grain: 0, frostEdge: 0, surface: 'none', surfScale: 30, surfDepth: 10, surfAngle: 0, tint: '#ffffff', tintAmt: 0, absorption: 0, milk: 0.06, sat: 1, bright: 0, edge: 0.35, lightAngle: 120, lightElev: 40, spec: 0.9, shine: 180, rim: 1.15, rimWidth: 1.6, refl: 0.95, roughness: 0.12, shadow: 0.12, shadowBlur: 13.5, shadowY: 6.5} },
  { id: 'opal', name: 'Opal', note: 'Milky white tile, edges still bend',
    params: {profile: 'squircle', bevel: 7, thick: 5.5, body: 8.5, corner: 4, ior: 1.45, disp: 0, magnify: 1, frost: 9, grain: 0.03, frostEdge: 0, surface: 'none', surfScale: 30, surfDepth: 10, surfAngle: 0, tint: '#ffffff', tintAmt: 0, absorption: 0, milk: 0.3, sat: 0.92, bright: 0.04, edge: 0.18, lightAngle: 120, lightElev: 40, spec: 0.45, shine: 90, rim: 0.85, rimWidth: 3, refl: 0.5, roughness: 0.12, shadow: 0.16, shadowBlur: 11.5, shadowY: 5} },
  { id: 'magnifier', name: 'Magnifier', note: 'Dome lens that enlarges what is under it',
    params: {profile: 'dome', bevel: 3.5, thick: 22.5, body: 12.5, corner: 4, ior: 1.55, disp: 0.12, magnify: 1, frost: 0, grain: 0, frostEdge: 0, surface: 'none', surfScale: 30, surfDepth: 10, surfAngle: 0, tint: '#ffffff', tintAmt: 0, absorption: 0, milk: 0, sat: 1, bright: 0, edge: 0, lightAngle: 120, lightElev: 40, spec: 0.7, shine: 320, rim: 0.85, rimWidth: 2.4, refl: 0.7, roughness: 0.12, shadow: 0.18, shadowBlur: 10, shadowY: 4.5} },
  { id: 'fisheye', name: 'Fisheye', note: 'Concave lens, pulls the scene inward',
    params: {profile: 'concave', bevel: 4.5, thick: 22.5, body: 10, corner: 4, ior: 1.5, disp: 0.12, magnify: 1, frost: 0, grain: 0, frostEdge: 0, surface: 'none', surfScale: 30, surfDepth: 10, surfAngle: 0, tint: '#ffffff', tintAmt: 0, absorption: 0, milk: 0, sat: 1, bright: 0, edge: 0.15, lightAngle: 120, lightElev: 40, spec: 0.3, shine: 260, rim: 0.9, rimWidth: 2.4, refl: 0.7, roughness: 0.12, shadow: 0.16, shadowBlur: 10, shadowY: 4} },
  { id: 'prism', name: 'Prism', note: 'Wide cut edge with spectral split',
    params: {profile: 'chamfer', bevel: 11.5, thick: 11.5, body: 6, corner: 3, ior: 1.85, disp: 1, magnify: 1, frost: 0, grain: 0, frostEdge: 0, surface: 'none', surfScale: 30, surfDepth: 10, surfAngle: 0, tint: '#ffffff', tintAmt: 0, absorption: 0, milk: 0, sat: 1, bright: 0, edge: 0, lightAngle: 120, lightElev: 40, spec: 0.8, shine: 160, rim: 0.9, rimWidth: 1.6, refl: 0.55, roughness: 0.12, shadow: 0.12, shadowBlur: 8.5, shadowY: 3.5} },
  { id: 'fluted', name: 'Fluted', note: 'Reeded ribs, each one a small lens',
    params: {profile: 'circle', bevel: 4, thick: 3.5, body: 5, corner: 4, ior: 1.5, disp: 0, magnify: 1, frost: 3, grain: 0, frostEdge: 0, surface: 'fluted', surfScale: 24, surfDepth: 13, surfAngle: 0, tint: '#ffffff', tintAmt: 0, absorption: 0, milk: 0.04, sat: 1, bright: 0, edge: 0, lightAngle: 120, lightElev: 40, spec: 0.25, shine: 90, rim: 0.85, rimWidth: 2, refl: 0.55, roughness: 0.12, shadow: 0.15, shadowBlur: 8.5, shadowY: 3.5} },
  { id: 'hammered', name: 'Hammered', note: 'Dimpled cast glass',
    params: {profile: 'squircle', bevel: 5, thick: 4.5, body: 4.5, corner: 4, ior: 1.52, disp: 0, magnify: 1, frost: 2.5, grain: 0, frostEdge: 0, surface: 'hammered', surfScale: 44, surfDepth: 14, surfAngle: 0, tint: '#ffffff', tintAmt: 0, absorption: 0, milk: 0.05, sat: 1.05, bright: 0, edge: 0, lightAngle: 120, lightElev: 40, spec: 0.16, shine: 140, rim: 0.8, rimWidth: 2, refl: 0.35, roughness: 0.12, shadow: 0.15, shadowBlur: 8.5, shadowY: 3.5} },
  { id: 'smoked', name: 'Smoked', note: 'Dark tint, hard specular',
    params: {profile: 'squircle', bevel: 7, thick: 6.5, body: 4.5, corner: 4, ior: 1.5, disp: 0.06, magnify: 1, frost: 0, grain: 0, frostEdge: 0, surface: 'none', surfScale: 30, surfDepth: 10, surfAngle: 0, tint: '#1d2129', tintAmt: 0.64, absorption: 0.22, milk: 0, sat: 0.85, bright: -0.03, edge: 0, lightAngle: 120, lightElev: 40, spec: 1.3, shine: 220, rim: 1.1, rimWidth: 2.2, refl: 0.9, roughness: 0.05, shadow: 0.24, shadowBlur: 9, shadowY: 4} },
  { id: 'etched', name: 'Etched', note: 'Sandblasted face inside a clear polished border',
    params: {profile: 'chamfer', bevel: 3, thick: 3, body: 4, corner: 4, ior: 1.55, disp: 0, magnify: 1, frost: 12, grain: 0.45, frostEdge: 5.5, surface: 'none', surfScale: 30, surfDepth: 10, surfAngle: 0, tint: '#eef6ff', tintAmt: 0.08, absorption: 0, milk: 0.14, sat: 1, bright: 0.02, edge: 0, lightAngle: 120, lightElev: 40, spec: 0.7, shine: 200, rim: 1.35, rimWidth: 1.2, refl: 0.6, roughness: 0.5, shadow: 0.14, shadowBlur: 7.5, shadowY: 3} },
  { id: 'gel', name: 'Gel', note: 'Soft tinted bubble, wide highlight',
    params: {profile: 'circle', bevel: 17.5, thick: 16, body: 2.5, corner: 4, ior: 1.34, disp: 0.08, magnify: 1, frost: 0, grain: 0, frostEdge: 0, surface: 'none', surfScale: 30, surfDepth: 10, surfAngle: 0, tint: '#7ff0cb', tintAmt: 0.42, absorption: 0.4, milk: 0.05, sat: 1.3, bright: 0.02, edge: 0, lightAngle: 120, lightElev: 40, spec: 1.5, shine: 50, rim: 0.6, rimWidth: 5, refl: 0.5, roughness: 0.12, shadow: 0.2, shadowBlur: 10, shadowY: 4.5} },
];
export const GLASS_PRESET_IDS = GLASS_PRESETS.map((p) => p.id);
const PRESET_BY_ID = new Map(GLASS_PRESETS.map((p) => [p.id, p]));
export const getGlassPreset = (id) => PRESET_BY_ID.get(id) || null;

/** Shape kinds with an analytic outline the pass can bevel. */
export const GLASS_SHAPE_KINDS = new Set(['rectangle', 'ellipse', 'circle']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const HEX = /^#[0-9a-fA-F]{6}$/;

/** One preset as a complete set of entry params (what picking it writes). */
export function glassPresetParams(id) {
  const preset = PRESET_BY_ID.get(id) || GLASS_PRESETS[0];
  const out = { glassPreset: preset.id };
  for (const p of GLASS_PARAMS) out[p.field] = preset.params[p.key];
  return out;
}
/** A new Glass entry starts as Liquid. */
export const GLASS_DEFAULTS = Object.freeze(glassPresetParams('liquid'));

/** The item's Glass entry (present or muted), or null. */
export function getGlassEffect(item) {
  const list = Array.isArray(item?.layerEffects) ? item.layerEffects : null;
  return list ? list.find((e) => e?.id === GLASS_LAYER_EFFECT_ID) || null : null;
}

/** Glass renders: an enabled entry on a shape that is not a clip mask. */
export function hasGlass(item) {
  const e = getGlassEffect(item);
  return !!e && e.enabled !== false && !item.shapeClipMask;
}

/** A shape layer whose kind has an outline the pass understands. */
export function isGlassLayer(item, clip) {
  return clip?.mediaType === 'shape' && hasGlass(item) && GLASS_SHAPE_KINDS.has(item.shapeType || 'rectangle');
}

/**
 * The project sanitizer's per-id whitelist for the entry: `glassPreset` (unknown →
 * liquid) and every field re-emitted — a valid stored value, else that preset's
 * value. So `{ id: 'glass', params: { glassPreset: 'frosted' } }` is a complete
 * Frosted pane, and a key this list does not name is dropped on load.
 */
export function sanitizeGlassParams(raw) {
  const id = PRESET_BY_ID.has(raw?.glassPreset) ? raw.glassPreset : 'liquid';
  const out = glassPresetParams(id);
  for (const p of GLASS_PARAMS) {
    const v = raw?.[p.field];
    if (v === undefined || v === null) continue;
    if (p.type === 'select') {
      if (p.options.some(([o]) => o === v)) out[p.field] = v;
    } else if (p.type === 'color') {
      if (typeof v === 'string' && HEX.test(v)) out[p.field] = v.toLowerCase();
    } else if (isNum(v)) {
      out[p.field] = clamp(v, p.min, p.max);
    }
  }
  return out;
}

/**
 * This frame's material in engine units. Precedence per parameter: keyframe
 * value → the entry's param → the preset's value. `shortSide` (local px) turns
 * the % geometry into px.
 */
export function resolveGlassParams(item, kf, shortSide) {
  const params = getGlassEffect(item)?.params || {};
  const preset = PRESET_BY_ID.get(params.glassPreset) || GLASS_PRESETS[0];
  const m = {};
  for (const p of GLASS_PARAMS) {
    const k = kf && isNum(kf[p.field]) ? kf[p.field] : undefined;
    const v = k !== undefined ? k : params[p.field];
    let val = preset.params[p.key];
    if (p.type === 'select') { if (p.options.some(([id]) => id === v)) val = v; }
    else if (p.type === 'color') { if (typeof v === 'string' && HEX.test(v)) val = v; }
    else if (isNum(v)) val = clamp(v, p.min, p.max);
    m[p.key] = val;
  }
  const side = Math.max(1, shortSide || 1);
  const pct = (v) => (v || 0) * side / 100;
  const isLens = m.profile === 'dome' || m.profile === 'concave';
  m.bevelPx = Math.min(pct(m.bevel), side * (isLens ? 0.3 : 0.25));
  m.thickPx = pct(m.thick);
  m.bodyPx = pct(m.body);
  m.shadowBlurPx = pct(m.shadowBlur);
  m.shadowYPx = pct(m.shadowY);
  m.frostEdgePx = pct(m.frostEdge);
  return m;
}

// ── Fold guard ──────────────────────────────────────────────────────────────
/* Seen straight on, a bevel point r px out from the plateau samples the backdrop
 * D(r) further in (Snell). Where D grows faster than r the image folds. D is
 * soft-compressed under FOLD_CAP·r (tanh, so a higher IOR still bends more until
 * it saturates), remaining growth over 0.95/px is capped and the ratio smoothed.
 * G = D_guarded / D_physical per x/B; the shader scales its bend by G. Lenses and
 * chamfers skip it (a chamfer's facet jump IS its look). */
const FOLD_CAP = 0.85;
const GUARD_ONES = new Float32Array(64).fill(1);
const guardCache = new Map();
function profileH(kind, t) {
  const u = 1 - clamp(t, 0, 1);
  if (kind === 'circle') return Math.sqrt(Math.max(1 - u * u, 0));
  if (kind === 'squircle') return Math.pow(Math.max(1 - u * u * u * u, 0), 0.25);
  return 1 - u;
}
export function glassGuardLUT(m) {
  if (m.profile === 'dome' || m.profile === 'concave' || m.profile === 'chamfer' || m.bevelPx < 0.5 || m.thickPx < 0.01) return GUARD_ONES;
  const key = `${m.profile}|${m.bevelPx.toFixed(2)}|${m.thickPx.toFixed(2)}|${m.bodyPx.toFixed(2)}|${m.ior}`;
  let lut = guardCache.get(key);
  if (lut) return lut;
  const N = 256, B = m.bevelPx, T = m.thickPx, S = m.bodyPx, eta = 1 / m.ior;
  const D = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const t = 1 - i / N;
    const e = 0.5 / N;
    const slope = T * (profileH(m.profile, t + e) - profileH(m.profile, t - e)) / (2 * e * B);
    const th = Math.atan(Math.abs(slope));
    const st = Math.min(Math.sin(th) * eta, 1);
    const dev = th - Math.asin(st);
    const dz = T * profileH(m.profile, t) + S;
    D[i] = Math.sin(dev) * dz / Math.max(Math.cos(dev), 0.25);
  }
  const dr = B / N;
  const Dg = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const lim = FOLD_CAP * Math.max(i * dr, 1e-3);
    Dg[i] = lim * Math.tanh(D[i] / lim);
    if (i > 0) Dg[i] = Math.min(Dg[i], Dg[i - 1] + 0.95 * dr);
  }
  const G = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) G[i] = D[i] > 1e-4 ? Math.min(Dg[i] / D[i], 1) : 1;
  for (let pass = 0; pass < 3; pass++) {
    const c = G.slice();
    for (let i = 1; i < N; i++) G[i] = Math.min(c[i], (c[i - 1] + c[i] * 2 + c[i + 1]) / 4);
  }
  lut = new Float32Array(64);
  for (let j = 0; j < 64; j++) {
    const f = (1 - j / 63) * N, i = Math.floor(f), w = f - i;
    lut[j] = G[Math.min(i, N)] * (1 - w) + G[Math.min(i + 1, N)] * w;
  }
  if (guardCache.size > 256) guardCache.clear();
  guardCache.set(key, lut);
  return lut;
}

// ── Shape and frame ─────────────────────────────────────────────────────────
/**
 * The outline in local px: kind 0 = rounded box (radii TL, TR, BR, BL), 1 = ellipse.
 * `width`/`height` is the shape box, `plateW`/`plateH` the padded plate the mesh carries.
 */
export function glassShapeOf(item, width, height, radii, plateW, plateH) {
  const type = item?.shapeType || 'rectangle';
  const halfW = Math.max(0.5, width / 2);
  const halfH = Math.max(0.5, height / 2);
  if (type === 'circle' || (type === 'ellipse' && Math.abs(width - height) < 0.5)) {
    const r = Math.min(halfW, halfH);
    return { kind: 0, halfW, halfH, radii: [r, r, r, r], plateW, plateH };
  }
  if (type === 'ellipse') return { kind: 1, halfW, halfH, radii: [0, 0, 0, 0], plateW, plateH };
  return { kind: 0, halfW, halfH, radii: (radii || [0, 0, 0, 0]).slice(0, 4), plateW, plateH };
}

const _A = new THREE.Matrix4();
const _MV = new THREE.Matrix4();
const _S = new THREE.Matrix4();
const _m3 = new THREE.Matrix3();
const _m3i = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _c = new THREE.Vector4();

/**
 * The layer-local frame of this frame's draw: local px → clip (and back),
 * local → view directions, the light and the shadow direction in local space,
 * whether the plane faces the camera square-on, and the pass bounds in target
 * uv. `ndcZ` is the clip-space depth range of the renderer ([-1, 1] WebGL,
 * [0, 1] WebGPU) and `flipV` whether target v runs top-down (WebGPU).
 * Null when the plane is edge-on or behind the camera.
 */
export function computeGlassFrame(mesh, camera, shape, m, { ndcZ = [-1, 1], flipV = false } = {}) {
  if (!mesh?.geometry || !camera) return null;
  const geo = mesh.geometry;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const geoW = bb.max.x - bb.min.x, geoH = bb.max.y - bb.min.y;
  if (!(geoW > 0 && geoH > 0)) return null;
  _A.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
  const e = _A.elements;
  const lenX = Math.hypot(e[0], e[1], e[2]) * geoW / shape.plateW;
  const lenZ = Math.hypot(e[8], e[9], e[10]);
  if (!(lenX > 1e-9 && lenZ > 1e-9)) return null;
  const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2;
  _S.makeScale(geoW / shape.plateW, geoH / shape.plateH, lenX / lenZ).setPosition(cx, cy, 0);
  _MV.multiplyMatrices(_A, _S);
  const localToClip = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, _MV);
  const det = localToClip.determinant();
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
  const clipToLocal = localToClip.clone().invert();

  _m3.setFromMatrix4(_MV);
  const localToView = _m3.clone();
  const le = localToView.elements;
  for (let c = 0; c < 3; c++) {
    const n = Math.hypot(le[c * 3], le[c * 3 + 1], le[c * 3 + 2]) || 1;
    le[c * 3] /= n; le[c * 3 + 1] /= n; le[c * 3 + 2] /= n;
  }
  _m3i.copy(_m3).invert();
  const la = THREE.MathUtils.degToRad(m.lightAngle), lel = THREE.MathUtils.degToRad(m.lightElev);
  const lightView = new THREE.Vector3(Math.cos(la) * Math.cos(lel), Math.sin(la) * Math.cos(lel), Math.sin(lel));
  const lightLocal = lightView.clone().applyMatrix3(_m3i).normalize();
  _v.set(0, -1, 0).applyMatrix3(_m3i);
  const sl = Math.hypot(_v.x, _v.y) || 1;
  const shadowDir = new THREE.Vector2(_v.x / sl, _v.y / sl);

  // Square-on: the plane's normal IS the camera's view axis (a 2D layer, wherever
  // it sits in frame) → straight rays, no march. Any rotation out of the screen
  // plane, the layer's or the camera's, makes it a 3D pane.
  const tilted = Math.abs(le[8]) < 0.99995;

  // Bounds: the slab's corners, top and bottom, padded by the shadow's reach.
  const depth = m.thickPx + m.bodyPx;
  const pad = m.shadowBlurPx * 3.2 + m.shadowYPx + 4;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const z of [0, -depth]) {
    _c.set(sx * (shape.halfW + pad), sy * (shape.halfH + pad), z, 1).applyMatrix4(localToClip);
    if (_c.w <= 1e-6) { behind = true; continue; }
    const u = _c.x / _c.w * 0.5 + 0.5;
    const v = _c.y / _c.w * 0.5 + 0.5;
    x0 = Math.min(x0, u); x1 = Math.max(x1, u);
    y0 = Math.min(y0, v); y1 = Math.max(y1, v);
  }
  if (behind) { x0 = 0; y0 = 0; x1 = 1; y1 = 1; }
  if (!(x1 > 0 && y1 > 0 && x0 < 1 && y0 < 1)) return null;
  const bounds = flipV ? [x0, 1 - y1, x1, 1 - y0] : [x0, y0, x1, y1];
  return { localToClip, clipToLocal, localToView, lightLocal, lightView, shadowDir, tilted, bounds, ndcZ };
}

const PROFILE = { circle: 0, squircle: 1, chamfer: 2, dome: 3, concave: 4 };
const SURFACE = { none: 0, fluted: 1, hammered: 2, ripple: 3 };
const tintColor = new THREE.Color();

/**
 * Write one layer's uniforms. Works for the GLSL material and its TSL twin: both
 * expose the same names with `.value` (the TSL guard array is a uniformArray,
 * updated through `.array`).
 */
export function setGlassUniforms(u, { m, shape, frame, frosted, resolution, opacity = 1, matte = null, layerMask = null }) {
  u.uResolution.value.set(resolution[0], resolution[1]);
  u.uOpacity.value = clamp(opacity, 0, 1);
  // Unmatted → nothing bound (see the uBlur note in Player.applyGlass).
  u.uMatte.value = matte?.texture || null;
  u.uMatteOn.value = matte?.texture ? 1 : 0;
  u.uMatteLuma.value = matte?.luma ? 1 : 0;
  u.uMatteInvert.value = matte?.invert ? 1 : 0;
  // Layer Mask: this frame's cut { texture, box, amount } — the coverage plate and
  // the layer box it was cut through (computeLayerBox). Unmasked → nothing bound.
  u.uLMask.value = layerMask?.texture || null;
  u.uLMaskOn.value = layerMask?.texture ? 1 : 0;
  u.uLMaskAmount.value = clamp(layerMask?.amount ?? 1, 0, 1);
  if (layerMask?.texture) {
    const { Hi } = fxBoxHomographies(layerMask.box);
    u.uLMaskHomInv.value.set(Hi[0], Hi[1], Hi[2], Hi[3], Hi[4], Hi[5], Hi[6], Hi[7], Hi[8]);
  }
  u.uBounds.value.set(frame.bounds[0], frame.bounds[1], frame.bounds[2], frame.bounds[3]);
  u.uLocalToClip.value.copy(frame.localToClip);
  u.uClipToLocal.value.copy(frame.clipToLocal);
  u.uLocalToView.value.copy(frame.localToView);
  u.uLightLocal.value.copy(frame.lightLocal);
  u.uLightView.value.copy(frame.lightView);
  u.uShadowDir.value.copy(frame.shadowDir);
  u.uNdcZ.value.set(frame.ndcZ[0], frame.ndcZ[1]);
  u.uMarch.value = frame.tilted ? 1 : 0;
  u.uShapeKind.value = shape.kind;
  u.uHalf.value.set(shape.halfW, shape.halfH);
  const minHalf = Math.min(shape.halfW, shape.halfH);
  const r = shape.radii.map((v) => clamp(v || 0, 0, minHalf));
  u.uRadii.value.set(r[0], r[1], r[2], r[3]);
  // Corner smoothing fades out as the radius reaches half the short side: a disc stays a disc.
  const rf = Math.max(...r) / Math.max(minHalf, 1e-3);
  const fade = clamp((rf - 0.55) / 0.43, 0, 1);
  u.uCornerN.value = 2 + ((m.corner || 2) - 2) * (1 - fade * fade * (3 - 2 * fade));
  u.uLensM.value = shape.kind === 1 || rf > 0.95 ? -1 : Math.SQRT2;
  u.uProfile.value = PROFILE[m.profile] ?? 1;
  u.uBevel.value = m.bevelPx;
  u.uThick.value = m.thickPx;
  u.uBody.value = m.bodyPx;
  u.uIor.value = m.ior;
  u.uDisp.value = m.disp;
  u.uMagnify.value = m.magnify || 1;
  u.uFrost.value = frosted ? 1 : 0;
  u.uGrain.value = m.grain || 0;
  u.uFrostEdge.value = m.frostEdgePx;
  u.uSurface.value = SURFACE[m.surface] ?? 0;
  u.uSurfScale.value = Math.max(m.surfScale || 20, 2);
  u.uSurfDepth.value = m.surfDepth || 0;
  u.uSurfAngle.value = THREE.MathUtils.degToRad(m.surfAngle || 0);
  tintColor.set(m.tint || '#ffffff');
  u.uTint.value.set(tintColor.r, tintColor.g, tintColor.b);
  u.uTintAmt.value = m.tintAmt;
  u.uAbsorption.value = m.absorption || 0;
  u.uMilk.value = m.milk;
  u.uSat.value = m.sat;
  u.uBright.value = m.bright;
  u.uEdge.value = m.edge;
  u.uSpec.value = m.spec;
  u.uShine.value = m.shine;
  u.uRim.value = m.rim;
  u.uRimWidth.value = m.rimWidth;
  u.uRefl.value = m.refl;
  u.uRoughness.value = m.roughness || 0;
  u.uShadow.value.set(m.shadow, Math.max(m.shadowBlurPx, 0.5), m.shadowYPx);
  const lut = glassGuardLUT(m);
  if (u.uGuard.array) { for (let i = 0; i < 64; i++) u.uGuard.array[i] = lut[i]; }
  else u.uGuard.value = lut;
}

/** The uniform set both materials declare (TSL builds its own nodes from the same names). */
export function glassUniformValues() {
  return {
    uStack: { value: null },
    uBlur: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
    uLocalToClip: { value: new THREE.Matrix4() },
    uClipToLocal: { value: new THREE.Matrix4() },
    uLocalToView: { value: new THREE.Matrix3() },
    uLightLocal: { value: new THREE.Vector3(0, 0, 1) },
    uLightView: { value: new THREE.Vector3(0, 0, 1) },
    uShadowDir: { value: new THREE.Vector2(0, -1) },
    uNdcZ: { value: new THREE.Vector2(-1, 1) },
    uMarch: { value: 0 },
    uShapeKind: { value: 0 },
    uHalf: { value: new THREE.Vector2(1, 1) },
    uRadii: { value: new THREE.Vector4() },
    uCornerN: { value: 2 },
    uLensM: { value: -1 },
    uProfile: { value: 1 },
    uBevel: { value: 1 },
    uThick: { value: 0 },
    uBody: { value: 0 },
    uIor: { value: 1.5 },
    uDisp: { value: 0 },
    uMagnify: { value: 1 },
    uFrost: { value: 0 },
    uGrain: { value: 0 },
    uFrostEdge: { value: 0 },
    uSurface: { value: 0 },
    uSurfScale: { value: 20 },
    uSurfDepth: { value: 0 },
    uSurfAngle: { value: 0 },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
    uTintAmt: { value: 0 },
    uAbsorption: { value: 0 },
    uMilk: { value: 0 },
    uSat: { value: 1 },
    uBright: { value: 0 },
    uEdge: { value: 0 },
    uSpec: { value: 0 },
    uShine: { value: 90 },
    uRim: { value: 0 },
    uRimWidth: { value: 2 },
    uRefl: { value: 0 },
    uRoughness: { value: 0 },
    uShadow: { value: new THREE.Vector3(0, 1, 0) },
    uGuard: { value: GUARD_ONES },
    uOpacity: { value: 1 },
    uMatte: { value: null },
    uMatteOn: { value: 0 },
    uMatteLuma: { value: 0 },
    uMatteInvert: { value: 0 },
    uLMask: { value: null },
    uLMaskHomInv: { value: new THREE.Matrix3() },
    uLMaskOn: { value: 0 },
    uLMaskAmount: { value: 1 },
  };
}

// ── WebGL material ──────────────────────────────────────────────────────────
// Premultiplied throughout (the compositor's stack is): the refracted backdrop
// keeps its alpha, milk / reflection / highlights add light AND coverage, and
// the shadow lands as black-over so it shows on a transparent frame too.
const vertexShader = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uStack;
uniform sampler2D uBlur;
uniform vec2 uResolution;
uniform vec4 uBounds;
uniform mat4 uLocalToClip;
uniform mat4 uClipToLocal;
uniform mat3 uLocalToView;
uniform vec3 uLightLocal;
uniform vec3 uLightView;
uniform vec2 uShadowDir;
uniform vec2 uNdcZ;
uniform float uMarch;
uniform int uShapeKind;
uniform vec2 uHalf;
uniform vec4 uRadii;
uniform float uCornerN, uLensM;
uniform int uProfile;
uniform float uBevel, uThick, uBody;
uniform float uIor, uDisp, uMagnify;
uniform float uFrost, uGrain, uFrostEdge;
uniform int uSurface;
uniform float uSurfScale, uSurfDepth, uSurfAngle;
uniform vec3 uTint;
uniform float uTintAmt, uAbsorption, uMilk, uSat, uBright, uEdge;
uniform float uSpec, uShine, uRim, uRimWidth, uRefl, uRoughness;
uniform vec3 uShadow;
uniform float uGuard[64];
// The layer's own visibility: its effective opacity (fades and keyframes
// included) and its track matte (camera-axis, read at the pixel like the stack).
uniform float uOpacity;
uniform sampler2D uMatte;
uniform float uMatteOn, uMatteLuma, uMatteInvert;
// …and its Layer Mask: the coverage plate the mask pass cut the isolate with,
// and frame uv (y up) → layer box 0..1 through the plane's projective map.
uniform sampler2D uLMask;
uniform mat3 uLMaskHomInv;
uniform float uLMaskOn, uLMaskAmount;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
float gSide = 1.0;
float gFrostMask = 1.0;
float gGuard = 1.0;

vec2 hash22(vec2 p){
  vec3 a = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  a += dot(a, a.yzx + 33.33);
  return fract((a.xx + a.yz) * a.zy);
}
float hash12(vec2 p){
  vec3 a = fract(vec3(p.xyx) * 0.1031);
  a += dot(a, a.yzx + 33.33);
  return fract((a.x + a.y) * a.z);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

float sdShape(vec2 p){
  if (uShapeKind == 1){
    vec2 r = uHalf;
    float k0 = length(p / r);
    float k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / max(k1, 1e-6);
  }
  vec2 b = uHalf;
  float r = p.x > 0.0 ? (p.y > 0.0 ? uRadii.y : uRadii.z) : (p.y > 0.0 ? uRadii.x : uRadii.w);
  r = min(r, min(b.x, b.y));
  vec2 q = abs(p) - b + r;
  vec2 m = max(q, 0.0);
  float c;
  if (uCornerN > 2.01 && r > 0.5){
    vec2 mn = pow(m / r, vec2(uCornerN));
    c = r * pow(mn.x + mn.y, 1.0 / uCornerN);
  } else c = length(m);
  return c + min(max(q.x, q.y), 0.0) - r;
}

float macroH(vec2 p, float d){
  float x = -d;
  if (x <= 0.0) return 0.0;
  if (uProfile >= 3){
    float r2;
    if (uLensM < 0.0){
      float r = 1.0 - min(x / min(uHalf.x, uHalf.y), 1.0);
      r2 = r * r;
    } else {
      vec2 a = p / (uHalf * uLensM);
      r2 = min(dot(a, a), 1.0);
    }
    float h = uProfile == 3 ? 1.0 - r2 : r2;
    float rt = clamp(x / max(uBevel, 1.0), 0.0, 1.0);
    float cap = sqrt(1.0 - (1.0 - rt) * (1.0 - rt));
    return uThick * (uProfile == 3 ? h : (0.15 + 0.85 * h) * cap);
  }
  float t = clamp(x / max(uBevel, 0.5), 0.0, 1.0);
  float u = 1.0 - t;
  float h;
  if (uProfile == 0) h = sqrt(max(1.0 - u * u, 0.0));
  else if (uProfile == 1) h = pow(max(1.0 - u * u * u * u, 0.0), 0.25);
  else h = t;
  return uThick * h;
}

float surfH(vec2 p){
  if (uSurface == 0) return 0.0;
  float ca = cos(uSurfAngle), sa = sin(uSurfAngle);
  vec2 r = vec2(ca * p.x + sa * p.y, -sa * p.x + ca * p.y) / uSurfScale;
  if (uSurface == 1){
    float f = fract(r.x) * 2.0 - 1.0;
    return uSurfDepth * (1.0 - f * f);
  }
  if (uSurface == 2){
    vec2 i = floor(r), fr = fract(r);
    float d1 = 9.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
      vec2 g = vec2(float(x), float(y));
      vec2 h = 0.15 + 0.7 * hash22(i + g);
      float d = length(g + h - fr);
      float blend = max(0.18 - abs(d1 - d), 0.0) / 0.18;
      d1 = min(d1, d) - blend * blend * 0.045;
    }
    return uSurfDepth * d1 * d1 * 1.6;
  }
  float n = vnoise(r) * 0.65 + vnoise(r * 2.1 + 7.3) * 0.35;
  return uSurfDepth * n;
}

float fullH(vec2 p){
  float d = sdShape(p);
  float h = macroH(p, d);
  if (uSurface != 0) h += surfH(p) * smoothstep(0.0, 3.0, -d);
  return h;
}

vec3 heightNormal(vec2 p){
  const float e = 0.75;
  float hx = fullH(p + vec2(e, 0.0)) - fullH(p - vec2(e, 0.0));
  float hy = fullH(p + vec2(0.0, e)) - fullH(p - vec2(0.0, e));
  return normalize(vec3(-hx / (2.0 * e), -hy / (2.0 * e), 1.0));
}

vec3 macroNormal(vec2 p){
  const float e = 0.75;
  float hx = macroH(p + vec2(e, 0.0), sdShape(p + vec2(e, 0.0))) - macroH(p - vec2(e, 0.0), sdShape(p - vec2(e, 0.0)));
  float hy = macroH(p + vec2(0.0, e), sdShape(p + vec2(0.0, e))) - macroH(p - vec2(0.0, e), sdShape(p - vec2(0.0, e)));
  return normalize(vec3(-hx / (2.0 * e), -hy / (2.0 * e), 1.0));
}

vec2 sdGrad(vec2 p){
  const float e = 0.5;
  return normalize(vec2(sdShape(p + vec2(e, 0.0)) - sdShape(p - vec2(e, 0.0)),
                        sdShape(p + vec2(0.0, e)) - sdShape(p - vec2(0.0, e))) + 1e-6);
}

// A square-on pane (uMarch 0) behaves like the 2D glass it is: rays run straight
// down the local z axis and land on the pane's own plane, so a flat plateau shows
// the backdrop exactly where it is. Only a tilted pane uses the camera's true
// (perspective) ray and depth — that is what reveals a slab's thickness.
vec2 projectUV(vec3 q){
  vec4 c = uLocalToClip * vec4(q.xy, uMarch < 0.5 ? 0.0 : q.z * gSide, 1.0);
  return (c.xy / max(c.w, 1e-5)) * 0.5 + 0.5;
}
vec3 dirToView(vec3 v){ return normalize(uLocalToView * vec3(v.xy, v.z * gSide)); }

float shadowAt(vec2 p){
  if (uShadow.x <= 0.0) return 0.0;
  float d = sdShape(p - uShadowDir * uShadow.z);
  return uShadow.x / (1.0 + exp(d * 1.8 / max(uShadow.y, 1.0)));
}
vec4 shadowOver(vec4 c, float s){ return vec4(c.rgb * (1.0 - s), c.a * (1.0 - s) + s); }

// Layer Mask coverage at a frame uv — createLayerMaskMaterial's read verbatim:
// no plate data outside the box (0, not the clamped edge texel), and Amount
// mixes toward "no mask".
float layerMaskAt(vec2 f){
  if (uLMaskOn < 0.5) return 1.0;
  vec3 h = uLMaskHomInv * vec3(f, 1.0);
  vec2 p = h.z < 1e-6 ? vec2(-1e3) : h.xy / h.z;
  float c = (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) ? 0.0 : texture2D(uLMask, p).a;
  return clamp(mix(1.0, c, clamp(uLMaskAmount, 0.0, 1.0)), 0.0, 1.0);
}
// A point on the layer plane (local px, z = 0) → frame uv, y up.
vec2 frameUV(vec2 l){
  vec4 c = uLocalToClip * vec4(l, 0.0, 1.0);
  return (c.xy / max(c.w, 1e-5)) * 0.5 + 0.5;
}
// How much of the pane that casts the shadow at p survives the mask: read where
// the occluder sits, softened across the shadow's blur so a cut edge throws a
// soft shadow edge like the outline does.
float shadowMaskAt(vec2 p){
  vec2 o = p - uShadowDir * uShadow.z;
  float r = max(uShadow.y, 1.0) * 0.6;
  return 0.2 * (layerMaskAt(frameUV(o))
    + layerMaskAt(frameUV(o + vec2(r, 0.0))) + layerMaskAt(frameUV(o - vec2(r, 0.0)))
    + layerMaskAt(frameUV(o + vec2(0.0, r))) + layerMaskAt(frameUV(o - vec2(0.0, r))));
}

float zBottom(){ return -(uThick + uBody); }

vec4 backdrop(vec3 e){
  vec2 ex = e.xy / uMagnify;
  vec2 uv = projectUV(vec3(ex, e.z));
  if (uGrain > 0.0 && gFrostMask > 0.0){
    uv += (hash22(floor(ex)) - 0.5) * uGrain * gFrostMask * 9.0 / uResolution;
  }
  vec4 c = texture2D(uStack, uv);
  if (uFrost > 0.0) c = mix(c, texture2D(uBlur, uv), uFrost * gFrostMask);
  return shadowOver(c, 0.5 * shadowAt(ex));
}

float guardAt(float xIn){
  float f = clamp(xIn / max(uBevel, 0.5), 0.0, 1.0) * 63.0;
  int i = int(floor(f));
  int j = min(i + 1, 63);
  return mix(uGuard[i], uGuard[j], f - float(i));
}

vec4 refractTo(vec3 w, vec3 N, vec3 I, float ior){
  vec3 R = refract(I, N, 1.0 / ior);
  if (dot(R, R) < 1e-6) R = reflect(I, N);
  float dz = max(w.z - zBottom(), 0.0);
  vec3 straight = I * (dz / -I.z);
  vec3 bent = R * (dz / max(-R.z, 0.25));
  return backdrop(w + straight + (bent - straight) * gGuard);
}

// The studio the glass reflects, in VIEW space (y up, z toward the viewer).
vec3 envColor(vec3 r){
  float up = r.y;
  vec3 sky = vec3(1.0), hor = vec3(0.80, 0.81, 0.84), gnd = vec3(0.34, 0.35, 0.37);
  vec3 c = up > 0.0 ? mix(hor, sky, smoothstep(0.0, 0.65, up)) : mix(hor, gnd, smoothstep(0.0, 0.55, -up));
  float k = dot(r, uLightView);
  float softness = uRoughness * 0.22;
  c += smoothstep(0.82 - softness, 0.97, k) * (1.0 - uRoughness * 0.55);
  vec3 axis = normalize(vec3(0.85, 0.25, 0.45));
  vec3 across = normalize(cross(axis, vec3(0.0, 1.0, 0.0)));
  vec3 along = cross(across, axis);
  float strip = 1.0 - smoothstep(0.035, 0.10 + softness, abs(dot(r, across)));
  strip *= 1.0 - smoothstep(0.28, 0.65 + softness, abs(dot(r, along)));
  c += strip * smoothstep(0.4, 0.8, dot(r, axis)) * (0.75 - uRoughness * 0.4);
  return c;
}

vec4 shade(vec3 w, vec3 N, vec3 Nm, vec3 I, float hN, float xIn, bool sideHit){
  vec4 col;
  if (uDisp > 0.001){
    vec3 acc = vec3(0.0);
    float accA = 0.0;
    for (int i = 0; i < 5; i++){
      float f = float(i) * 0.25;
      vec3 wt = max(vec3(1.0 - abs(f) * 2.0, 1.0 - abs(f - 0.5) * 2.0, 1.0 - abs(f - 1.0) * 2.0), 0.0);
      vec4 s = refractTo(w, N, I, max(1.0, uIor + (f - 0.5) * uDisp * 0.7));
      acc += wt * s.rgb;
      accA += s.a * (wt.r + wt.g + wt.b);
    }
    col = vec4(acc / vec3(1.5, 2.0, 1.5), accA / 5.0);
  } else {
    col = refractTo(w, N, I, uIor);
  }

  float l = dot(col.rgb, LUMA);
  col.rgb = clamp(mix(vec3(l), col.rgb, uSat) + uBright * col.a, vec3(0.0), vec3(col.a));
  vec3 ray = refract(I, N, 1.0 / max(uIor, 1.0));
  float depth = max(w.z - zBottom(), 0.0) / max(uThick + uBody, 1.0);
  float path = depth / max(abs(ray.z), 0.25);
  vec3 transmission = max(mix(vec3(1.0), uTint, uTintAmt), vec3(0.001));
  col.rgb *= pow(transmission, vec3(1.0 + uAbsorption * path * 2.0));
  col = mix(col, vec4(mix(vec3(1.0), uTint, 0.25), 1.0), uMilk);
  float rimT = 1.0 - hN;
  col.rgb *= 1.0 - uEdge * rimT * rimT * 0.6;
  if (sideHit) col.rgb = mix(col.rgb, col.rgb * mix(vec3(1.0), uTint, 0.6) * 0.82, 0.6);

  vec3 V = -I;
  float cosv = clamp(dot(N, V), 0.0, 1.0);
  float f0 = pow((uIor - 1.0) / (uIor + 1.0), 2.0);
  float F = f0 + (1.0 - f0) * pow(1.0 - cosv, 5.0);
  vec3 env = envColor(dirToView(reflect(I, N)));
  if (sideHit){ F *= 0.4; col += vec4(0.06 * mix(vec3(1.0), uTint, 0.5), 0.06); }
  col = mix(col, vec4(env, 1.0), clamp(F * uRefl, 0.0, 1.0));

  vec3 L = normalize(vec3(uLightLocal.xy, uLightLocal.z * gSide));
  vec3 Hh = normalize(L + V);
  float shine = mix(uShine, 8.0, uRoughness * uRoughness);
  float energy = (shine + 2.0) / (uShine + 2.0);
  float sp = uSpec * energy * pow(max(dot(N, Hh), 0.0), shine);
  col += vec4(sp * vec3(1.0, 0.99, 0.97), sp);

  float slope = length(Nm.xy);
  if (slope > 1e-3){
    vec2 nd = Nm.xy / slope;
    vec2 ld = normalize(L.xy + 1e-5);
    float f = dot(nd, ld);
    float band = exp(-max(xIn, 0.0) / max(uRimWidth, 0.3));
    float rim = pow(max(f, 0.0), 2.0) + 0.30 * pow(max(-f, 0.0), 2.0) + 0.025;
    float rl = uRim * band * rim * smoothstep(0.0, 0.35, slope) * 0.9;
    col += vec4(vec3(rl), rl);
  }
  col.a = clamp(col.a, 0.0, 1.0);
  col.rgb = clamp(col.rgb, vec3(0.0), vec3(col.a));
  return col;
}

void main(){
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 ndc = uv * 2.0 - 1.0;
  vec4 h0 = uClipToLocal * vec4(ndc, uNdcZ.x, 1.0);
  vec4 h1 = uClipToLocal * vec4(ndc, uNdcZ.y, 1.0);
  vec3 ol = h0.xyz / h0.w;
  vec3 dl = normalize(h1.xyz / h1.w - ol);
  if (dl.z > 0.0){ ol.z = -ol.z; dl.z = -dl.z; gSide = -1.0; }
  dl.z = min(dl.z, -1e-4);
  vec3 q0 = ol + dl * (-ol.z / dl.z);
  float zb = zBottom();
  vec3 q1 = ol + dl * ((zb - ol.z) / dl.z);
  float sd0 = sdShape(q0.xy);
  float fw = max(fwidth(sd0), 1e-3);
  float pxl = max(length(fwidth(q0.xy)) * 0.7071, 1e-3);

  vec4 stackPx = texture2D(uStack, uv);
  if (uv.x < uBounds.x || uv.y < uBounds.y || uv.x > uBounds.z || uv.y > uBounds.w){
    gl_FragColor = stackPx;
    return;
  }
  // How much of the pane this pixel keeps: the layer's opacity × its track matte
  // (the same value the matte scales an ordinary layer's plate by).
  float keep = uOpacity;
  if (uMatteOn > 0.5){
    vec4 ms = texture2D(uMatte, uv);
    float mv = mix(ms.a, dot(ms.rgb, vec3(0.299, 0.587, 0.114)), uMatteLuma);
    keep *= mix(mv, 1.0 - mv, uMatteInvert);
  }
  if (keep <= 0.0){
    gl_FragColor = stackPx;
    return;
  }
  // The Layer Mask cuts the pane where this pixel sees it, and the shadow where
  // its occluder sits. A cut-away pixel shows the stack (with whatever shadow
  // the kept part throws on it) and skips the shading entirely.
  float lmPane = layerMaskAt(uv);
  float lmShade = (uLMaskOn > 0.5 && uShadow.x > 0.0) ? shadowMaskAt(q1.xy) : 1.0;
  vec4 outside = mix(stackPx, shadowOver(stackPx, shadowAt(q1.xy)), keep * lmShade);
  if (lmPane <= 0.0){
    gl_FragColor = outside;
    return;
  }

  vec3 I = uMarch < 0.5 ? vec3(0.0, 0.0, -1.0) : dl;
  vec3 w; vec3 N; bool sideHit = false; float cov;
  if (uMarch < 0.5){
    cov = clamp(0.5 - sd0 / fw, 0.0, 1.0);
    if (cov <= 0.0){ gl_FragColor = outside; return; }
    vec2 pin = q0.xy;
    if (sd0 > -0.5) pin -= sdGrad(pin) * (sd0 + 0.5);
    w = vec3(pin, fullH(pin) - uThick);
    N = heightNormal(pin);
  } else {
    bool hit = false;
    vec3 prev = q0, hp = q0;
    float minG = 1e9; vec3 best = q0;
    for (int i = 0; i <= 28; i++){
      vec3 p = mix(q0, q1, float(i) / 28.0);
      float sd = sdShape(p.xy);
      float surf = macroH(p.xy, sd) - uThick;
      float g = max(sd, p.z - surf);
      if (g < minG){ minG = g; best = p; }
      if (sd <= 0.0 && p.z <= surf){ hit = true; hp = p; break; }
      prev = p;
    }
    if (hit){
      vec3 a = prev, b = hp;
      for (int k = 0; k < 6; k++){
        vec3 m = 0.5 * (a + b);
        float sd = sdShape(m.xy);
        if (sd <= 0.0 && m.z <= macroH(m.xy, sd) - uThick) b = m; else a = m;
      }
      w = b;
      cov = 1.0;
    } else {
      w = best;
      cov = clamp(0.5 - minG / pxl, 0.0, 1.0);
      if (cov <= 0.0){ gl_FragColor = outside; return; }
    }
    float sdm = sdShape(w.xy);
    sideHit = w.z < -uThick - 0.75 && uBody > 0.5;
    if (sideHit) N = normalize(vec3(sdGrad(w.xy), 0.06));
    else {
      vec2 pin = w.xy;
      if (sdm > -0.5) pin -= sdGrad(pin) * (sdm + 0.5);
      N = heightNormal(pin);
    }
  }

  float sdw = sdShape(w.xy);
  float xIn = max(-sdw, 0.0);
  float hN = uProfile >= 3 ? clamp(xIn / max(uBevel, 1.0), 0.0, 1.0) : clamp(macroH(w.xy, sdw) / max(uThick, 1e-3), 0.0, 1.0);
  if (uThick < 0.01) hN = clamp(xIn / max(uBevel, 1.0), 0.0, 1.0);
  gGuard = sideHit ? 1.0 : guardAt(xIn);
  gFrostMask = uFrostEdge > 0.5 ? smoothstep(uFrostEdge - 0.75, uFrostEdge + 0.75, xIn) : 1.0;
  vec3 Nm = (sideHit || uSurface == 0) ? N : macroNormal(w.xy - sdGrad(w.xy) * max(sdw + 0.5, 0.0));
  vec4 g = shade(w, N, Nm, I, hN, sideHit ? 0.0 : xIn, sideHit);
  gl_FragColor = mix(outside, mix(stackPx, g, keep), cov * lmPane);
}
`;

export function createGlassMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: glassUniformValues(),
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}
