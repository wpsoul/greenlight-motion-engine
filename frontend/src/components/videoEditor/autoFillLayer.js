import * as THREE from 'three';
import { setFxBoxUniforms } from './homography';
import { getRampTexture, sanitizeEffectGradient } from './adjustmentEffects';

/*
 * Auto Fill ("Grow Fill") — typed Layer Effect (item.layerEffects, id 'autoFill'). PRO.
 *
 * Growing "infection" fill spreading through the layer's alpha from infection
 * points, an analog of the AutoFill 2 AE plugin. The geodesic arrival-time
 * field is CPU-baked (autofillField.js) from the matte cropped to the layer's
 * box; this module owns the effect's data contract (defaults / fields /
 * presets / resolver) and the standalone render material the Player's
 * per-layer pass uses. Look-dev source of truth: html/finished/autofill-lab.html.
 *
 * Infection points: `points: [{ x, y, delay }]` live TOP-LEVEL on the effect
 * entry (like depth3d's depthMap), in layer-box space — x/y 0..1 with y DOWN
 * (0 = visual top), delay 0..1 as a fraction of the total growth. When the
 * seed mode is Manual the points drive the bake; the preview overlay
 * (AutoFillPointsOverlay) edits them on canvas.
 */

export const AUTOFILL_LAYER_EFFECT_ID = 'autoFill';
export const AF_SEED_MODE_MANUAL = 6;
export const AF_MAX_POINTS = 32;

// Preset ramps (CSS-gradient form the shared GradientPicker reads/writes) —
// hexes ported verbatim from the lab.
export const AF_RAMPS = {
  thermal: 'linear-gradient(90deg, #000010 0%, #5b0b8a 25%, #e0355a 50%, #ffb020 75%, #fffbe6 100%)',
  fire: 'linear-gradient(90deg, #0d0503 0%, #48100a 20%, #a12708 40%, #ff6a00 60%, #ffc933 80%, #fff6d0 100%)',
  ocean: 'linear-gradient(90deg, #04263f 0%, #0a5c8a 20%, #19a0c4 40%, #7fe3d2 60%, #d0f6ff 80%, #04263f 100%)',
  electric: 'linear-gradient(90deg, #0a1a3f 0%, #1d4fd8 20%, #7aa8ff 40%, #ffffff 60%, #b06aff 80%, #0a1a3f 100%)',
  neon: 'linear-gradient(90deg, #ff2bd6 0%, #8b5cf6 33%, #22d3ee 66%, #ff2bd6 100%)',
  candy: 'linear-gradient(90deg, #ff5f6d 0%, #ffc371 25%, #47e5bc 50%, #5b8cff 75%, #ff5f6d 100%)',
  mono: 'linear-gradient(90deg, #20242c 0%, #e9edf5 100%)',
};

export const AF_DEFAULTS = {
  afProgress: 0,
  afSpeed: 25,
  afMode: 0,
  afStyle: 0,
  afFillColor: '#7dd3c0',
  afRamp: AF_RAMPS.thermal,
  afLoops: 3,
  afFlow: 1,
  afSoftness: 6,
  afWavAmp: 8,
  afWavScale: 60,
  afFeWidth: 0,
  afFeColorMode: 0,
  afFeColor: '#ffd9a0',
  afFeRamp: AF_RAMPS.neon,
  afFeGlowW: 14,
  afFeGlowI: 80,
  afBeEnable: 0,
  afBeOffset: 60,
  afBeWidth: 4,
  afBeColorMode: 0,
  afBeColor: '#ffffff',
  afBeRamp: AF_RAMPS.mono,
  afBeGlowW: 10,
  afBeGlowI: 60,
  afSeedMode: 0,
  afSeedCount: 1,
  afSeedSeed: 7,
  afSeedStagger: 0,
  afSpeedType: 0,
  afNoiseScale: 140,
  afNoiseContrast: 55,
  afNoiseSeed: 7,
  afContourBias: 40,
  afBridges: 1,
  afBridgeReach: 18,
  afBridgeSlow: 2.5,
};

// Grouped like the lab's panel sections. `kf` marks the one keyframable param
// (afProgress is the animation driver — bake-side params must never be keyed:
// a keyed bake param would force a ~30 ms CPU rebake every frame).
export const AF_NUMBER_FIELDS = [
  // Grow Speed is the everyday animator: the fill advances by afSpeed %/s of
  // clip time on its own, no keyframes needed. Keying it accelerates the growth
  // smoothly — the Player INTEGRATES the track (integratePathRate) rather than
  // multiplying, so a ramp never teleports the front. Start Fill offsets where
  // the growth begins (and can itself be keyed for hand-authored timing).
  { key: 'afSpeed', label: 'Grow Speed', min: 0, max: 200, step: 1, suffix: '%/s', group: 'Fill', kf: true },
  { key: 'afProgress', label: 'Start Fill', min: 0, max: 100, step: 1, suffix: '%', group: 'Fill', kf: true },
  { key: 'afLoops', label: 'Loops', min: 1, max: 8, step: 1, group: 'Fill' },
  { key: 'afFlow', label: 'Flow Speed', min: -4, max: 4, step: 0.1, group: 'Fill' },
  { key: 'afSoftness', label: 'Edge Softness', min: 0, max: 40, step: 1, suffix: 'px', group: 'Front', kf: true },
  { key: 'afWavAmp', label: 'Waviness', min: 0, max: 40, step: 1, suffix: 'px', group: 'Front', kf: true },
  { key: 'afWavScale', label: 'Wave Scale', min: 10, max: 200, step: 2, suffix: 'px', group: 'Front', kf: true },
  { key: 'afFeWidth', label: 'Edge Width', min: 0, max: 40, step: 1, suffix: 'px', group: 'Front Edge', kf: true },
  { key: 'afFeGlowW', label: 'Glow Width', min: 0, max: 80, step: 1, suffix: 'px', group: 'Front Edge', kf: true },
  { key: 'afFeGlowI', label: 'Glow Intensity', min: 0, max: 250, step: 2, suffix: '%', group: 'Front Edge', kf: true },
  { key: 'afBeOffset', label: 'Offset', min: 4, max: 240, step: 2, suffix: 'px', group: 'Back Edge', kf: true },
  { key: 'afBeWidth', label: 'Edge Width', min: 0, max: 40, step: 1, suffix: 'px', group: 'Back Edge', kf: true },
  { key: 'afBeGlowW', label: 'Glow Width', min: 0, max: 80, step: 1, suffix: 'px', group: 'Back Edge', kf: true },
  { key: 'afBeGlowI', label: 'Glow Intensity', min: 0, max: 250, step: 2, suffix: '%', group: 'Back Edge', kf: true },
  { key: 'afSeedCount', label: 'Seed Count', min: 1, max: 8, step: 1, group: 'Points' },
  { key: 'afSeedSeed', label: 'Variation', min: 0, max: 99, step: 1, group: 'Points' },
  { key: 'afSeedStagger', label: 'Stagger', min: 0, max: 100, step: 1, suffix: '%', group: 'Points' },
  { key: 'afNoiseScale', label: 'Noise Scale', min: 20, max: 400, step: 2, suffix: 'px', group: 'Speed Map' },
  { key: 'afNoiseContrast', label: 'Contrast', min: 0, max: 100, step: 1, group: 'Speed Map' },
  { key: 'afNoiseSeed', label: 'Noise Seed', min: 0, max: 99, step: 1, group: 'Speed Map' },
  { key: 'afContourBias', label: 'Contour Bias', min: -100, max: 100, step: 1, group: 'Speed Map' },
  { key: 'afBridgeReach', label: 'Reach', min: 0, max: 60, step: 1, suffix: 'px', group: 'Bridges' },
  { key: 'afBridgeSlow', label: 'Slowness', min: 1, max: 8, step: 0.1, suffix: 'x', group: 'Bridges' },
];

export const AF_ENUM_FIELDS = [
  { key: 'afMode', label: 'Mode', options: [
    { value: 0, label: 'Fill' }, { value: 1, label: 'Unfill' }, { value: 2, label: 'Reveal' }] },
  { key: 'afStyle', label: 'Fill Style', options: [
    { value: 0, label: 'Solid Color' }, { value: 1, label: 'Gradient by Age' },
    { value: 2, label: 'Gradient Loop' }, { value: 3, label: 'Noise Texture' },
    { value: 4, label: 'None (edges only)' }] },
  { key: 'afFeColorMode', label: 'Edge Color', options: [
    { value: 0, label: 'Solid' }, { value: 1, label: 'Gradient' }] },
  { key: 'afBeEnable', label: 'Back Edge', options: [
    { value: 0, label: 'Off' }, { value: 1, label: 'On' }] },
  { key: 'afBeColorMode', label: 'Back Color', options: [
    { value: 0, label: 'Solid' }, { value: 1, label: 'Gradient' }] },
  { key: 'afSeedMode', label: 'Seeds From', options: [
    { value: 0, label: 'Left' }, { value: 1, label: 'Center' }, { value: 2, label: 'Right' },
    { value: 3, label: 'Top' }, { value: 4, label: 'Bottom' }, { value: 5, label: 'Scatter' },
    { value: AF_SEED_MODE_MANUAL, label: 'Manual (on canvas)' }] },
  { key: 'afSpeedType', label: 'Type', options: [
    { value: 0, label: 'Uniform' }, { value: 1, label: 'Turbulent Noise' },
    { value: 2, label: 'Shape Flow' }, { value: 3, label: 'Combine' }] },
  { key: 'afBridges', label: 'Enable', options: [
    { value: 0, label: 'Off' }, { value: 1, label: 'On' }] },
];

export const AF_COLOR_FIELDS = [
  { key: 'afFillColor', label: 'Fill Color' },
  { key: 'afFeColor', label: 'Edge Tint' },
  { key: 'afBeColor', label: 'Back Tint' },
];

export const AF_GRADIENT_FIELDS = [
  { key: 'afRamp', label: 'Fill Gradient' },
  { key: 'afFeRamp', label: 'Edge Gradient' },
  { key: 'afBeRamp', label: 'Back Gradient' },
];

// Sampled per frame by resolveAutoFillParams. afSpeed is deliberately NOT
// here even though its field shows the clock — its track is INTEGRATED by
// the Player (integratePathRate), never point-sampled.
export const AF_KF_KEYS = AF_NUMBER_FIELDS.filter((f) => f.kf && f.key !== 'afSpeed').map((f) => f.key);

// Presets, ported from the lab. Applied on top of a look baseline so switching
// presets never leaks a stray back edge or speed map from the previous one.
// Seeds/points/speed/progress are deliberately untouched — they are the user's.
const AF_PRESET_BASE = {
  afMode: 0, afStyle: 0, afFillColor: '#7dd3c0', afRamp: AF_RAMPS.thermal, afLoops: 3, afFlow: 1,
  afSoftness: 6, afWavAmp: 8, afWavScale: 60,
  afFeWidth: 0, afFeColorMode: 0, afFeColor: '#ffd9a0', afFeRamp: AF_RAMPS.neon, afFeGlowW: 0, afFeGlowI: 0,
  afBeEnable: 0, afBeOffset: 60, afBeWidth: 4, afBeColorMode: 0, afBeColor: '#ffffff',
  afBeRamp: AF_RAMPS.mono, afBeGlowW: 10, afBeGlowI: 60,
  afSpeedType: 0, afNoiseScale: 140, afNoiseContrast: 55, afNoiseSeed: 7, afContourBias: 40,
  afBridges: 1, afBridgeReach: 18, afBridgeSlow: 2.5,
};
const preset = (name, colors, patch) => ({ name, colors, params: { ...AF_PRESET_BASE, ...patch } });
export const AF_PRESETS = [
  preset('Ink', ['#12151c', '#ffd9a0', '#ffffff'], {
    afFillColor: '#12151c', afSpeedType: 3, afNoiseScale: 90, afNoiseContrast: 70, afContourBias: 55,
    afSoftness: 10, afWavAmp: 14, afWavScale: 50 }),
  preset('Glow Sweep', ['#7dd3c0', '#8ab8ff', '#ffffff'], {
    afMode: 2, afSoftness: 4, afWavAmp: 4, afFeColor: '#8ab8ff', afFeGlowW: 30, afFeGlowI: 140 }),
  preset('Electric', ['#1d4fd8', '#9fd0ff', '#ffffff'], {
    afStyle: 2, afRamp: AF_RAMPS.electric, afLoops: 6, afFlow: 2.5, afSpeedType: 1, afNoiseScale: 50,
    afNoiseContrast: 85, afSoftness: 2, afWavAmp: 16, afWavScale: 24,
    afFillColor: '#1d4fd8', afFeColor: '#9fd0ff', afFeGlowW: 8, afFeGlowI: 120 }),
  preset('Fire', ['#a12708', '#ff9a3c', '#ffc933'], {
    afStyle: 1, afRamp: AF_RAMPS.fire, afSpeedType: 1, afNoiseScale: 80, afNoiseContrast: 60,
    afSoftness: 8, afWavAmp: 18, afWavScale: 36,
    afFillColor: '#a12708', afFeColor: '#ff9a3c', afBeColor: '#ffc933', afFeGlowW: 16, afFeGlowI: 120 }),
  preset('Ocean Wave', ['#0a5c8a', '#9fe8ff', '#d0f6ff'], {
    afStyle: 2, afRamp: AF_RAMPS.ocean, afLoops: 3, afFlow: 1.5, afSpeedType: 2, afContourBias: -40,
    afSoftness: 12, afWavAmp: 6, afWavScale: 80,
    afFillColor: '#0a5c8a', afFeColor: '#9fe8ff', afBeColor: '#d0f6ff', afFeGlowW: 6, afFeGlowI: 40 }),
  preset('Neon Gradient', ['#8b5cf6', '#ff4fd8', '#22d3ee'], {
    afStyle: 2, afRamp: AF_RAMPS.neon, afLoops: 4, afFlow: 2, afSoftness: 4, afWavAmp: 6,
    afFillColor: '#8b5cf6', afFeColor: '#ff4fd8', afBeColor: '#22d3ee', afFeGlowW: 22, afFeGlowI: 150 }),
  preset('Neon Edge', ['#101318', '#ff2bd6', '#22d3ee'], {
    afFillColor: '#101318', afFeColor: '#ff2bd6', afBeColor: '#22d3ee',
    afFeWidth: 6, afFeColorMode: 1, afFeRamp: AF_RAMPS.neon, afFeGlowW: 26, afFeGlowI: 180,
    afSoftness: 3, afWavAmp: 6 }),
  preset('Scan Sweep', ['#0a1a3f', '#7aa8ff', '#ffffff'], {
    afMode: 2, afFillColor: '#0a1a3f', afFeColor: '#7aa8ff',
    afFeWidth: 4, afFeColorMode: 1, afFeRamp: AF_RAMPS.electric, afFeGlowW: 30, afFeGlowI: 160,
    afSoftness: 2, afWavAmp: 4 }),
  preset('Echo', ['#2f5d54', '#ffffff', '#ffffff'], {
    afFillColor: '#2f5d54', afSoftness: 3, afFeWidth: 4, afFeColor: '#ffffff', afFeGlowW: 8, afFeGlowI: 70,
    afBeEnable: 1, afBeOffset: 80, afBeWidth: 5, afBeGlowW: 10, afBeGlowI: 90 }),
  preset('Magic Mist', ['#ff5f6d', '#ffc371', '#5b8cff'], {
    afMode: 2, afSoftness: 16, afWavAmp: 12, afWavScale: 44, afSpeedType: 1, afNoiseScale: 120,
    afNoiseContrast: 50, afFillColor: '#ff5f6d', afFeColor: '#ffc371', afBeColor: '#5b8cff',
    afFeColorMode: 1, afFeRamp: AF_RAMPS.candy, afFeGlowW: 46, afFeGlowI: 170 }),
  preset('Handwriting', ['#14171f', '#39424f', '#ffffff'], {
    afFillColor: '#14171f', afFeColor: '#39424f', afSpeedType: 3, afNoiseScale: 60, afNoiseContrast: 75,
    afContourBias: 65, afSoftness: 4, afWavAmp: 16, afWavScale: 34, afFeWidth: 2 }),
  preset('Frost', ['#bfe3ff', '#ffffff', '#e9f6ff'], {
    afStyle: 3, afFillColor: '#bfe3ff', afFeColor: '#ffffff', afBeColor: '#e9f6ff', afSpeedType: 1,
    afNoiseScale: 60, afNoiseContrast: 70, afSoftness: 14, afWavAmp: 18, afWavScale: 40,
    afFeWidth: 5, afFeGlowW: 18, afFeGlowI: 90 }),
  preset('Burn Out', ['#1a0d06', '#ff8a3c', '#ffc933'], {
    afMode: 1, afFillColor: '#1a0d06', afFeColor: '#ff8a3c', afBeColor: '#ffc933', afSpeedType: 1,
    afNoiseScale: 70, afNoiseContrast: 65, afSoftness: 6, afWavAmp: 12, afWavScale: 40,
    afFeGlowW: 10, afFeGlowI: 160 }),
  preset('Disintegrate', ['#20242c', '#c9a06a', '#ffffff'], {
    afMode: 1, afFillColor: '#20242c', afFeColor: '#c9a06a', afSpeedType: 1, afNoiseScale: 40,
    afNoiseContrast: 90, afSoftness: 18, afWavAmp: 24, afWavScale: 26, afFeGlowW: 4, afFeGlowI: 50 }),
];

// ── Entry access + resolution ───────────────────────────────────────────────

export function getAutoFillEffect(item) {
  const list = Array.isArray(item?.layerEffects) ? item.layerEffects : [];
  return list.find((e) => e?.id === AUTOFILL_LAYER_EFFECT_ID) || null;
}

export function isAutoFillEnabled(item) {
  const eff = getAutoFillEffect(item);
  return !!eff && eff.enabled !== false;
}

// ── PRO render gate (containsProGlowEffect precedent) ──────────────────────
// Grow Fill is a PRO effect on the Running Glow / Rig / Motion Trail footing:
// free to design, scrub and play back in the preview, paywalled at render. The
// check lives here rather than in a list of feature ids because there is
// nothing to keep in sync — the effect IS the flag. See the gate in
// VideoEditor's handleRenderInBackground.
export const AF_IS_PRO = true;

// Presence + not muted is the whole test: unlike the glow's amount or the
// trail's Effect Amount there is no parameter that bypasses the pass, and the
// model3d version (model3dGrowFill.js) rides the same entry, so this counts it
// too. Progress 0 still grows once Speed drives it, so it is not a bypass.
function autoFillGatesRender(item) {
  if (!AF_IS_PRO) return false;
  return isAutoFillEnabled(item);
}

// Project sequences can nest other sequences, so inspect the complete saved
// editor state rather than only the currently visible timeline level.
export function containsProAutoFillEffect(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (autoFillGatesRender(value)) return true;
  if (Array.isArray(value)) return value.some((entry) => containsProAutoFillEffect(entry, seen));
  return Object.values(value).some((entry) => containsProAutoFillEffect(entry, seen));
}

// 3D infection points for model layers — ROOT-LOCAL coords (arbitrary model
// units, NOT 0..1), stored as `points3d` on the entry. Separate from the 2D
// sanitizer, which clamps to the layer box and would destroy these.
export function sanitizeAutoFillPoints3d(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const cap = (v) => Math.max(-1e6, Math.min(1e6, v));
  for (const p of raw) {
    if (out.length >= AF_MAX_POINTS) break;
    const x = Number(p?.x); const y = Number(p?.y); const z = Number(p?.z);
    const delay = Number(p?.delay);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    out.push({
      x: cap(x), y: cap(y), z: cap(z),
      delay: Number.isFinite(delay) ? Math.min(1, Math.max(0, delay)) : 0,
    });
  }
  return out;
}

export function sanitizeAutoFillPoints(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw) {
    if (out.length >= AF_MAX_POINTS) break;
    const x = Number(p?.x); const y = Number(p?.y); const delay = Number(p?.delay);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
      delay: Number.isFinite(delay) ? Math.min(1, Math.max(0, delay)) : 0,
    });
  }
  return out;
}

// kf ?? stored ?? default per key; only afProgress is keyframable today.
export function resolveAutoFillParams(item, keyframeProps) {
  const eff = getAutoFillEffect(item);
  const stored = eff?.params || {};
  const out = {};
  for (const [key, def] of Object.entries(AF_DEFAULTS)) {
    if (typeof def === 'string') {
      out[key] = typeof stored[key] === 'string' && stored[key] ? stored[key] : def;
    } else {
      const kf = AF_KF_KEYS.includes(key) ? keyframeProps?.[key] : undefined;
      const v = Number.isFinite(kf) ? kf : Number(stored[key]);
      out[key] = Number.isFinite(v) ? v : def;
    }
  }
  out.points = sanitizeAutoFillPoints(eff?.points);
  out.points3d = sanitizeAutoFillPoints3d(eff?.points3d);
  return out;
}

// The bake-side subset in autofillField.js's un-prefixed vocabulary. Manual
// seed mode with no points degrades to Center so the effect never goes blank.
export function autoFillBakeParams(params) {
  const manual = params.afSeedMode === AF_SEED_MODE_MANUAL;
  return {
    seedMode: manual && !params.points.length ? 1 : params.afSeedMode,
    seedCount: params.afSeedCount,
    seedSeed: params.afSeedSeed,
    seedStagger: params.afSeedStagger,
    speedType: params.afSpeedType,
    noiseScale: params.afNoiseScale,
    noiseContrast: params.afNoiseContrast,
    noiseSeed: params.afNoiseSeed,
    contourBias: params.afContourBias,
    bridges: params.afBridges,
    bridgeReach: params.afBridgeReach,
    bridgeSlow: params.afBridgeSlow,
    points: manual ? params.points : [],
  };
}

// ── Render material ─────────────────────────────────────────────────────────
// Standalone port of the lab shader. Runs full-frame on the isolated layer
// plate (premultiplied RGBA); the box uniforms re-express fragments in the
// layer's own space, identical to the overlay chain's fxLocal/fxCoord.

const AF_VERTEX = /* glsl */ `
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const AF_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uTexture;
uniform sampler2D uField;
uniform sampler2D uRamp;
uniform sampler2D uRampFE;
uniform sampler2D uRampBE;
uniform vec2 uResolution;
uniform vec2 uFxOrigin;
uniform vec2 uFxAxisX;
uniform vec2 uFxAxisY;
uniform mat3 uFxHom;      // fx box uv (p) -> frame uv, homogeneous (the plane's projective map)
uniform mat3 uFxHomInv;   // frame uv -> fx box uv, homogeneous
uniform vec2 uFxSizePx;
uniform vec2 uGrid;
uniform float uSpan;
uniform float uReady;
uniform float uProgress;   // 0..1
uniform float uMode;
uniform float uStyle;
uniform float uLoops;
uniform float uFlow;
uniform float uSoftPx;
uniform float uWavAmpPx;
uniform float uWavScalePx;
uniform float uFeWidthPx;
uniform float uFeMode;
uniform float uFeGlowWPx;
uniform float uFeGlowI;
uniform float uBeOn;
uniform float uBeOffsetPx;
uniform float uBeWidthPx;
uniform float uBeMode;
uniform float uBeGlowWPx;
uniform float uBeGlowI;
uniform vec3 uFillColor;
uniform vec3 uFeColor;
uniform float uFeAlpha;   // opacity of the front-edge BAND (its glow has its own)
uniform vec3 uBeColor;
uniform float uBeAlpha;

float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec3 unpremult(vec4 c){ return c.rgb / max(c.a, 1e-4); }
vec4 premult(vec3 c, float a){ return vec4(c * clamp(a, 0.0, 1.0), clamp(a, 0.0, 1.0)); }
vec2 fxLocal(vec2 uv){
  // Through the layer plane's own projective map. A point past the camera plane is
  // nowhere on the layer, so it lands far outside the unit box.
  vec3 h = uFxHomInv * vec3(uv, 1.0);
  if (h.z < 1e-6) return vec2(-1e3);
  return h.xy / h.z;
}
vec2 fxCoord(vec2 uv){
  vec2 c = fxLocal(uv) * uFxSizePx;
  return floor(c + 0.25) + 0.5;
}
float afDec(vec4 t){ return (floor(t.r*255.0+0.5)*256.0 + floor(t.g*255.0+0.5))/65535.0; }
vec4 afTap(vec2 g){ return texture2D(uField, (g + 0.5) / uGrid); }
float afCubw(float t){
  t = abs(t); float t2 = t * t;
  if (t < 1.0) return (4.0 - 6.0 * t2 + 3.0 * t2 * t) / 6.0;
  if (t < 2.0){ float k = 2.0 - t; return k * k * k / 6.0; }
  return 0.0;
}
float afVn(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i); float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)); float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main(){
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 src = texture2D(uTexture, uv);
  if (uReady < 0.5){ gl_FragColor = src; return; }
  vec2 local = fxLocal(uv);
  if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0){ gl_FragColor = src; return; }
  float span = max(uSpan, 1e-3);
  float ref = uResolution.y / 1080.0;
  float cellPx = 0.5 * (uFxSizePx.x / uGrid.x + uFxSizePx.y / uGrid.y);
  float normPerPx = ref / (span * max(cellPx, 1e-3));

  // 4x4 bicubic B-spline over reachable taps — C1-smooth field so the front
  // isoline is automatically smooth; the 1.0 sentinel never bleeds in.
  vec2 g = local * uGrid - 0.5;
  vec2 g0 = floor(g);
  vec2 f = fract(g);
  float csum = 0.0; float cw = 0.0; float reach = 0.0;
  for (int dy = -1; dy <= 2; dy++){
    for (int dx = -1; dx <= 2; dx++){
      vec2 o = vec2(float(dx), float(dy));
      float a = afDec(afTap(g0 + o));
      if (a < 0.995){
        float w = afCubw(o.x - f.x) * afCubw(o.y - f.y);
        csum += a * w; cw += w;
        if (dx >= 0 && dx <= 1 && dy >= 0 && dy <= 1) reach = 1.0;
      }
    }
  }
  if (cw <= 0.0 || reach < 0.5){ gl_FragColor = src; return; }
  float arr = csum / cw;

  float softN = uSoftPx * normPerPx;
  float wavN = uWavAmpPx * normPerPx;
  float pad = softN + wavN + 0.03;
  float endPad = pad + (uBeOn > 0.5 ? uBeOffsetPx * normPerPx : 0.0);
  float p = -pad + clamp(uProgress, 0.0, 1.0) * (0.98 + pad + endPad);

  float wn = afVn(fxCoord(uv) / max(uWavScalePx * ref, 4.0) + vec2(uProgress * uFlow * 0.7, 0.0)) - 0.5;
  float arrE = arr + wn * 2.0 * wavN;
  float soft = max(softN, 0.002);
  float fill = 1.0 - smoothstep(p - soft, p + soft, arrE);

  vec3 styleCol = uFillColor;
  if (uStyle > 0.5 && uStyle < 1.5){
    float age = clamp((p - arrE) / 0.35, 0.0, 1.0);
    styleCol = texture2D(uRamp, vec2(1.0 - age, 0.5)).rgb;
  } else if (uStyle > 1.5 && uStyle < 2.5){
    float ph = fract(arrE * uLoops - uProgress * uFlow);
    styleCol = texture2D(uRamp, vec2(ph, 0.5)).rgb;
  } else if (uStyle > 2.5 && uStyle < 3.5){
    float tn = afVn(fxCoord(uv) / max(34.0 * ref, 4.0)) * 0.9 + 0.25;
    styleCol = uFillColor * tn;
  }

  // Front edge: crisp band (solid or ramp across the band) + additive glow.
  float aa = 1.5 * normPerPx;
  float feHalf = uFeWidthPx * 0.5 * normPerPx;
  float feBand = uFeWidthPx < 0.5 ? 0.0 : 1.0 - smoothstep(feHalf - aa, feHalf + aa, abs(arrE - p));
  float feT = clamp((p + feHalf - arrE) / max(feHalf * 2.0, 1e-5), 0.0, 1.0);
  vec3 feCol = uFeMode > 0.5 ? texture2D(uRampFE, vec2(feT, 0.5)).rgb : uFeColor;
  float feGw = max(uFeGlowWPx * normPerPx, 1e-3);
  float feGlow = uFeGlowWPx < 0.5 ? 0.0 : exp(-abs(arrE - p) / feGw) * uFeGlowI;
  // Back edge: trailing band at an offset behind the front.
  float beC = p - uBeOffsetPx * normPerPx;
  float beHalf = uBeWidthPx * 0.5 * normPerPx;
  float beBand = (uBeOn < 0.5 || uBeWidthPx < 0.5) ? 0.0 : 1.0 - smoothstep(beHalf - aa, beHalf + aa, abs(arrE - beC));
  float beT = clamp((beC + beHalf - arrE) / max(beHalf * 2.0, 1e-5), 0.0, 1.0);
  vec3 beCol = uBeMode > 0.5 ? texture2D(uRampBE, vec2(beT, 0.5)).rgb : uBeColor;
  float beGw = max(uBeGlowWPx * normPerPx, 1e-3);
  float beGlow = (uBeOn < 0.5 || uBeGlowWPx < 0.5) ? 0.0 : exp(-abs(arrE - beC) / beGw) * uBeGlowI;

  // Premultiplied composite: paint the fill inside the alpha, lay the edge
  // bands over it, then add the glows as light (clipped to the silhouette).
  float alpha = src.a;
  float paint = uStyle > 3.5 ? 0.0 : fill;
  vec4 outC;
  if (uMode < 0.5) outC = premult(mix(unpremult(src), styleCol, paint), alpha);
  else if (uMode < 1.5) outC = src * (1.0 - fill);
  else outC = src * fill;
  // The band's own opacity, separate from the glow's intensity: a soft tint on
  // the leading edge is a different thing from how brightly it throws light.
  float beA = beBand * alpha * uBeAlpha;
  outC = premult(beCol, beA) + outC * (1.0 - beA);
  float feA = feBand * alpha * uFeAlpha;
  outC = premult(feCol, feA) + outC * (1.0 - feA);
  outC.rgb += beCol * beGlow * alpha;
  outC.rgb += feCol * feGlow * alpha;
  gl_FragColor = outC;
}
`;

/**
 * Split an edge colour into the rgb THREE can take and the alpha the band uses.
 *
 * BOTH FORMS ARE REAL: a project saved before edge opacity existed holds
 * '#rrggbb', and the shared ColorPicker switches to 'rgba(r, g, b, a)' the moment
 * a colour carries alpha. Reading only the hex form is the bug the particle ramp
 * already had once — a transparent pick silently reverted to opaque.
 */
export function splitEdgeColor(v) {
  const s = String(v || '').trim();
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) {
    const hx = (n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0');
    const a = m[4] === undefined ? 1 : Number(m[4]);
    return { rgb: `#${hx(m[1])}${hx(m[2])}${hx(m[3])}`, alpha: Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1 };
  }
  if (/^#[0-9a-fA-F]{8}$/.test(s)) return { rgb: s.slice(0, 7), alpha: parseInt(s.slice(7, 9), 16) / 255 };
  return { rgb: /^#[0-9a-fA-F]{6}$/.test(s) ? s : '#ffffff', alpha: 1 };
}

export function createAutoFillMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTexture: { value: null },
      uField: { value: null },
      uRamp: { value: null },
      uRampFE: { value: null },
      uRampBE: { value: null },
      uResolution: { value: new THREE.Vector2(1280, 720) },
      uFxOrigin: { value: new THREE.Vector2(0.5, 0.5) },
      uFxAxisX: { value: new THREE.Vector2(0.5, 0) },
      uFxAxisY: { value: new THREE.Vector2(0, 0.5) },
      uFxHom: { value: new THREE.Matrix3() },
      uFxHomInv: { value: new THREE.Matrix3() },
      uFxSizePx: { value: new THREE.Vector2(1280, 720) },
      uGrid: { value: new THREE.Vector2(1, 1) },
      uSpan: { value: 1 },
      uReady: { value: 0 },
      uProgress: { value: 0 },
      uMode: { value: 0 },
      uStyle: { value: 0 },
      uLoops: { value: 3 },
      uFlow: { value: 1 },
      uSoftPx: { value: 6 },
      uWavAmpPx: { value: 8 },
      uWavScalePx: { value: 60 },
      uFeWidthPx: { value: 0 },
      uFeMode: { value: 0 },
      uFeGlowWPx: { value: 14 },
      uFeGlowI: { value: 0.8 },
      uBeOn: { value: 0 },
      uBeOffsetPx: { value: 60 },
      uBeWidthPx: { value: 4 },
      uBeMode: { value: 0 },
      uBeGlowWPx: { value: 10 },
      uBeGlowI: { value: 0.6 },
      uFillColor: { value: new THREE.Color('#7dd3c0') },
      uFeColor: { value: new THREE.Color('#ffd9a0') },
      uFeAlpha: { value: 1 },
      uBeColor: { value: new THREE.Color('#ffffff') },
      uBeAlpha: { value: 1 },
    },
    vertexShader: AF_VERTEX,
    fragmentShader: AF_FRAGMENT,
    transparent: true,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

export function applyAutoFillUniforms(mat, params, { width, height, box, field }) {
  const u = mat.uniforms;
  u.uResolution.value.set(width, height);
  setFxBoxUniforms(u, box);
  u.uFxSizePx.value.set(box.sizePx[0], box.sizePx[1]);
  u.uField.value = field ? field.texture : null;
  u.uGrid.value.set(field ? field.gridW : 1, field ? field.gridH : 1);
  u.uSpan.value = field ? field.span : 1;
  u.uReady.value = field ? 1 : 0;
  u.uRamp.value = getRampTexture(sanitizeEffectGradient(params.afRamp), 0);
  u.uRampFE.value = getRampTexture(sanitizeEffectGradient(params.afFeRamp), 0);
  u.uRampBE.value = getRampTexture(sanitizeEffectGradient(params.afBeRamp), 0);
  u.uProgress.value = Math.min(1, Math.max(0, params.afProgress / 100));
  u.uMode.value = params.afMode;
  u.uStyle.value = params.afStyle;
  u.uLoops.value = params.afLoops;
  u.uFlow.value = params.afFlow;
  u.uSoftPx.value = params.afSoftness;
  u.uWavAmpPx.value = params.afWavAmp;
  u.uWavScalePx.value = params.afWavScale;
  u.uFeWidthPx.value = params.afFeWidth;
  u.uFeMode.value = params.afFeColorMode;
  u.uFeGlowWPx.value = params.afFeGlowW;
  u.uFeGlowI.value = params.afFeGlowI / 100;
  u.uBeOn.value = params.afBeEnable;
  u.uBeOffsetPx.value = params.afBeOffset;
  u.uBeWidthPx.value = params.afBeWidth;
  u.uBeMode.value = params.afBeColorMode;
  u.uBeGlowWPx.value = params.afBeGlowW;
  u.uBeGlowI.value = params.afBeGlowI / 100;
  u.uFillColor.value.set(params.afFillColor);
  const fe = splitEdgeColor(params.afFeColor);
  const be = splitEdgeColor(params.afBeColor);
  u.uFeColor.value.set(fe.rgb);
  u.uFeAlpha.value = fe.alpha;
  u.uBeColor.value.set(be.rgb);
  u.uBeAlpha.value = be.alpha;
}
