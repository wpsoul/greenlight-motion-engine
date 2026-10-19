import * as THREE from 'three';
import { setFxBoxUniforms } from './homography';
import { getRampTexture, sanitizeEffectGradient } from './adjustmentEffects';
import { getDepthTexture, getItemDepthMap, resolveDepthMapParams } from './depthMapEffect';

/*
 * Depth Scan — layer effect (port of html/depth-scan-lab.html).
 *
 * A LiDAR-style sweep, and the thing to understand about it is that it is NOT a
 * screen wipe. The band is a narrow SLICE THROUGH DEPTH: every pixel whose depth
 * sits within `width` of the moving threshold lights up, so the contour crawls
 * over the subject's real surface — around a cheek, along a shoulder — instead
 * of marching across the frame as a straight line. That is the whole look, and
 * it is why the effect needs a depth map at all.
 *
 * COLOUR — the one thing the lab did not have (10.4.89).
 * The reference is an RGB split: three slices at slightly different depths, red
 * behind, blue in front, which reads as chromatic aberration on the contour.
 * `scnColorMode` generalises that to three ways of colouring the same slice:
 *
 *   0 RGB Split   three bands at phase-split / phase / phase+split. The default,
 *                 byte-identical to the lab.
 *   1 Flat Color  ONE band at phase, tinted by scnColor.
 *   2 Gradient    ONE band, WIDENED to width+split so it occupies the same depth
 *                 footprint the split did, with the ramp laid across it. This is
 *                 the honest generalisation of mode 0: an RGB split IS a
 *                 red-green-blue ramp across the slice, so `scnSplit` keeps
 *                 meaning "how far the colours spread through depth" in both.
 *
 * SPACE. The pass runs on the layer's ISOLATE, so its uv is the frame's — but
 * depth is a property of the LAYER's artwork, so the depth read goes through
 * fxLocal(), the same box-space mapping Auto Fill and the overlay chain use
 * (origin + projected axes, so a rotated or scaled layer still lines up). Like
 * those, it assumes plate uv ≈ media uv, which holds for the image and video
 * layers this effect is available on — a video's frozen depth map is measured
 * off a decoded source frame, so it lands in the same media uv an image's does.
 *
 * ORIENTATION. The pass reads its plate at PLAIN uv and takes no flip flag. A
 * camera-rendered isolate is normalised by the caller with the same blit Auto
 * Fill uses, so this shader always sees a WebGL-layout plate — and the caller
 * then makes exactly TWO quad hops on both backends, which is what keeps the
 * result upright on WebGPU. A single hop came out vertically MIRRORED there:
 * measured, not reasoned (tests/depth-scan/verify_render.js, check 9).
 *
 * BORDER REJECT is not a nicety. A monocular depth map has a cliff at the
 * subject's silhouette, so the slice would cross the whole jump every frame and
 * paint a permanent outline that never moves — the one thing that makes the
 * effect look like a filter rather than a scan. Measuring the local depth jump
 * and suppressing the band there is what keeps the contour travelling. Lower it
 * if you actually want the rim light back.
 */

export const DEPTH_SCAN_LAYER_EFFECT_ID = 'depthScan';

// Free, like Chroma Key. Flip this to gate the RENDER the way Droste and Running
// Glow do (VideoEditor's handleRenderInBackground walks the chain for PRO ids).
export const SCN_IS_PRO = false;

// CSS-gradient form, which is what the shared GradientPicker reads and writes.
export const SCN_RAMPS = {
  thermal: 'linear-gradient(90deg, #000010 0%, #5b0b8a 25%, #e0355a 50%, #ffb020 75%, #fffbe6 100%)',
  lidar: 'linear-gradient(90deg, #001b2e 0%, #0aa6b8 40%, #b8ff52 70%, #ffffff 100%)',
  neon: 'linear-gradient(90deg, #ff2bd6 0%, #8b5cf6 33%, #22d3ee 66%, #ff2bd6 100%)',
  ice: 'linear-gradient(90deg, #04263f 0%, #19a0c4 45%, #d0f6ff 100%)',
};

export const SCN_DEFAULTS = {
  // sweep
  scnSpeed: 83.33,      // %/s — 1.20 s for a full pass, the lab's default
  scnPhase: 4,          // % — where the slice starts (and the keyframable handle)
  scnEase: 0,           // 0 linear, 1 hold ends
  // slice
  scnWidth: 1.1,        // % of the depth range
  scnSplit: 2.4,        // % — RGB separation / gradient spread
  scnFeather: 0.35,     // %
  scnGrain: 22,         // % — point-cloud speckle
  scnPixel: 1,          // × — quantise the depth read into cells
  // colour
  scnColorMode: 0,      // 0 RGB split, 1 flat, 2 gradient
  scnColor: '#b8ff52',
  scnRamp: SCN_RAMPS.lidar,
  // depth field
  scnGamma: 1,          // depth curve
  scnLow: 1.5,          // % — far cut
  scnHigh: 99.5,        // % — near cut
  scnBorder: 100,       // % — silhouette rejection
  // composite
  scnBrightness: 125,   // %
  scnSource: 0,         // % of the original image kept under the scan
  scnAmount: 100,       // % master mix; 0 is an exact bypass
  scnView: 0,           // 0 result, 1 depth map, 2 original — RENDERS
};

export const SCN_NUMBER_FIELDS = [
  { key: 'scnSpeed', label: 'Speed', min: -250, max: 250, step: 0.1, suffix: '%/s', group: 'sweep' },
  { key: 'scnPhase', label: 'Phase', min: 0, max: 100, step: 0.1, suffix: '%', kf: true, group: 'sweep' },
  { key: 'scnWidth', label: 'Slice Width', min: 0.1, max: 10, step: 0.1, suffix: '%', kf: true, group: 'slice' },
  { key: 'scnSplit', label: 'Spread', min: 0, max: 12, step: 0.1, suffix: '%', kf: true, group: 'slice' },
  { key: 'scnFeather', label: 'Softness', min: 0, max: 5, step: 0.1, suffix: '%', kf: true, group: 'slice' },
  { key: 'scnGrain', label: 'Point Noise', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'slice' },
  { key: 'scnPixel', label: 'Depth Pixels', min: 1, max: 8, step: 1, suffix: '×', group: 'slice' },
  { key: 'scnGamma', label: 'Depth Curve', min: 0.25, max: 3, step: 0.01, kf: true, group: 'field' },
  { key: 'scnLow', label: 'Far Cut', min: 0, max: 40, step: 0.5, suffix: '%', kf: true, group: 'field' },
  { key: 'scnHigh', label: 'Near Cut', min: 60, max: 100, step: 0.5, suffix: '%', kf: true, group: 'field' },
  { key: 'scnBorder', label: 'Border Reject', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'field' },
  { key: 'scnBrightness', label: 'Brightness', min: 0, max: 300, step: 1, suffix: '%', kf: true, group: 'composite' },
  { key: 'scnSource', label: 'Original Image', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'composite' },
  { key: 'scnAmount', label: 'Amount', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'composite' },
];

export const SCN_ENUM_FIELDS = [
  {
    key: 'scnColorMode',
    label: 'Color',
    options: [[0, 'RGB Split'], [1, 'Flat Color'], [2, 'Gradient']],
  },
  { key: 'scnEase', label: 'Sweep', options: [[0, 'Linear'], [1, 'Hold Ends']] },
  { key: 'scnView', label: 'View', options: [[0, 'Result'], [1, 'Depth Map'], [2, 'Original']] },
];

export const SCN_COLOR_FIELDS = [
  { key: 'scnColor', label: 'Scan Color' },
];

export const SCN_GRADIENT_FIELDS = [
  { key: 'scnRamp', label: 'Scan Gradient' },
];

export const SCN_KF_KEYS = SCN_NUMBER_FIELDS.filter((f) => f.kf).map((f) => f.key);

export const SCN_PRESETS = [
  { name: 'Reference', colors: ['#ff173d', '#40ff79', '#2d7cff'], params: {} },
  {
    name: 'Needle LiDAR',
    colors: ['#b8ff52', '#0aa6b8', '#ffffff'],
    params: { scnWidth: 0.45, scnSplit: 1.25, scnFeather: 0.1, scnGrain: 48, scnPixel: 2, scnBrightness: 175, scnColorMode: 2, scnRamp: SCN_RAMPS.lidar },
  },
  {
    name: 'RGB Shells',
    colors: ['#ff173d', '#40ff79', '#2d7cff'],
    params: { scnSpeed: 55, scnWidth: 2.6, scnSplit: 5.5, scnFeather: 0.8, scnGrain: 8, scnBrightness: 105 },
  },
  {
    name: 'Soft Tomography',
    colors: ['#000010', '#e0355a', '#fffbe6'],
    params: { scnSpeed: 38, scnWidth: 4.2, scnSplit: 1.2, scnFeather: 2.2, scnGrain: 0, scnBrightness: 90, scnSource: 14, scnColorMode: 2, scnRamp: SCN_RAMPS.thermal },
  },
  {
    name: 'Source Reveal',
    colors: ['#b8ff52', '#ffffff', '#8b5cf6'],
    params: { scnSpeed: 83.33, scnWidth: 1.4, scnSplit: 2.8, scnFeather: 0.45, scnGrain: 18, scnBrightness: 110, scnSource: 42, scnAmount: 88 },
  },
  {
    name: 'Single Blade',
    colors: ['#b8ff52', '#17200d', '#ffffff'],
    params: { scnColorMode: 1, scnColor: '#b8ff52', scnWidth: 0.8, scnSplit: 0, scnFeather: 0.25, scnGrain: 30, scnBrightness: 165 },
  },
];

export function getDepthScanEffect(item) {
  const list = item?.layerEffects;
  if (!Array.isArray(list)) return null;
  return list.find((effect) => effect?.id === DEPTH_SCAN_LAYER_EFFECT_ID) || null;
}

export function isDepthScanEnabled(item) {
  const effect = getDepthScanEffect(item);
  if (!effect || effect.enabled === false) return false;
  // Without a map there is no field to slice; the panel says so rather than
  // rendering a dead pass.
  if (!getItemDepthMap(item)) return false;
  const amount = Number(effect.params?.scnAmount);
  return (Number.isFinite(amount) ? amount : SCN_DEFAULTS.scnAmount) > 0.01;
}

export function resolveDepthScanParams(item, keyframeProps) {
  const params = getDepthScanEffect(item)?.params || {};
  const out = { ...SCN_DEFAULTS };
  for (const key of Object.keys(SCN_DEFAULTS)) {
    const stored = params[key];
    if (typeof SCN_DEFAULTS[key] === 'string') {
      if (typeof stored === 'string' && stored) out[key] = stored;
    } else if (Number.isFinite(Number(stored))) {
      out[key] = Number(stored);
    }
  }
  for (const key of SCN_KF_KEYS) {
    const kf = keyframeProps?.[key];
    if (Number.isFinite(kf)) out[key] = kf;
  }
  return out;
}

/*
 * The sweep, closed form.
 *
 * Linear phase is just (start + speed x seconds) wrapped to 0..1. "Hold ends"
 * asks the slice to crawl at the extremes and hurry through the middle, which in
 * the lab was a per-frame rate multiplier of 0.18 + 0.82 sin^2(pi q) — an
 * INTEGRATION, and a frame-rate-dependent one at that. Integrating it by hand
 * gives a closed form, which is what a deterministic export needs: a rendered
 * frame must be a pure function of time, not of how many frames preceded it.
 *
 *   integral of 0.18 + 0.82 sin^2(pi q) dq = 0.59 q - 0.82 sin(2 pi q) / (4 pi)
 *
 * normalised by 0.59 so a full turn stays a full turn.
 */
export function depthScanPhase(params, clipSeconds) {
  const linear = (params.scnPhase / 100) + (params.scnSpeed / 100) * Math.max(0, clipSeconds);
  const u = linear - Math.floor(linear);
  if (!(params.scnEase > 0.5)) return u;
  const eased = (0.59 * u - (0.82 * Math.sin(2 * Math.PI * u)) / (4 * Math.PI)) / 0.59;
  return eased - Math.floor(eased);
}

// ── GLSL ────────────────────────────────────────────────────────────────────

const SCN_VERTEX = /* glsl */`
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const SCN_FRAGMENT = /* glsl */`
precision highp float;
uniform sampler2D uTexture;    // the premultiplied isolate
uniform sampler2D uDepth;
uniform sampler2D uRamp;
uniform vec2 uResolution;
uniform vec2 uDepthSize;
uniform vec2 uFxOrigin;
uniform vec2 uFxAxisX;
uniform vec2 uFxAxisY;
uniform mat3 uFxHom;      // fx box uv (p) -> frame uv, homogeneous (the plane's projective map)
uniform mat3 uFxHomInv;   // frame uv -> fx box uv, homogeneous
uniform float uPhase, uWidth, uSplit, uFeather, uGrain, uPixel;
uniform float uGamma, uLow, uHigh, uBorder, uInvert;
uniform float uColorMode;
uniform vec3 uColor;
uniform float uBrightness, uSourceMix, uAmount, uView;

float scnHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

vec2 fxLocal(vec2 uvn){
  // Through the layer plane's own projective map. A point past the camera plane is
  // nowhere on the layer, so it lands far outside the unit box.
  vec3 h = uFxHomInv * vec3(uvn, 1.0);
  if (h.z < 1e-6) return vec2(-1e3);
  return h.xy / h.z;
}

float readDepth(vec2 p){
  vec2 cells = max(vec2(1.0), uDepthSize / max(1.0, uPixel));
  vec2 q = (floor(p * cells) + 0.5) / cells;
  float d = texture2D(uDepth, clamp(q, 0.0, 1.0)).r;
  if (uInvert > 0.5) d = 1.0 - d;
  return pow(clamp(d, 0.0, 1.0), uGamma);
}

float band(float d, float center, float noise, float w){
  float soft = max(uFeather, fwidth(d) * 0.35);
  return 1.0 - smoothstep(w, w + soft, abs(d - center + noise));
}

void main(){
  vec2 uvn = gl_FragCoord.xy / uResolution;
  vec4 s = texture2D(uTexture, uvn);
  float cov = s.a;
  vec3 src = cov > 1e-4 ? s.rgb / cov : vec3(0.0);

  vec2 p = fxLocal(uvn);
  float d = readDepth(p);

  if (uView > 1.5) { gl_FragColor = vec4(src * cov, cov); return; }
  if (uView > 0.5) { gl_FragColor = vec4(vec3(d) * cov, cov); return; }

  float n = (scnHash(floor(gl_FragCoord.xy / max(1.0, uPixel))) - 0.5) * uGrain * (uWidth + uFeather) * 1.6;

  vec3 scan;
  if (uColorMode < 0.5) {
    float r = band(d, clamp(uPhase - uSplit, 0.0, 1.0), n, uWidth);
    float g = band(d, uPhase, n * 0.35, uWidth);
    float b = band(d, clamp(uPhase + uSplit, 0.0, 1.0), -n, uWidth);
    scan = vec3(r, g, b);
  } else if (uColorMode < 1.5) {
    scan = uColor * band(d, uPhase, n * 0.35, uWidth);
  } else {
    // One slice occupying the split's whole depth footprint, with the ramp laid
    // across it — mode 0's red/green/blue ramp, made authorable.
    float ext = max(uSplit, uWidth);
    float m = band(d, uPhase, n * 0.35, uWidth + uSplit);
    float t = clamp(0.5 + (d - uPhase + n * 0.35) / (2.0 * ext), 0.0, 1.0);
    scan = texture2D(uRamp, vec2(t, 0.5)).rgb * m;
  }

  float valid = smoothstep(uLow, uLow + 0.012, d) * (1.0 - smoothstep(uHigh - 0.012, uHigh, d));
  vec2 texel = max(vec2(2.0), vec2(uPixel * 2.0)) / uDepthSize;
  float jump = max(
    max(abs(d - readDepth(p + vec2(texel.x, 0.0))), abs(d - readDepth(p - vec2(texel.x, 0.0)))),
    max(abs(d - readDepth(p + vec2(0.0, texel.y))), abs(d - readDepth(p - vec2(0.0, texel.y))))
  );
  float interior = 1.0 - smoothstep(0.018, 0.09, jump);
  float borderMask = mix(1.0, interior, uBorder);

  scan *= valid * borderMask * uBrightness;
  vec3 effected = src * uSourceMix + scan;
  vec3 result = clamp(mix(src, effected, uAmount), 0.0, 1.0);
  gl_FragColor = vec4(result * cov, cov);
}
`;

export function createDepthScanMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: SCN_VERTEX,
    fragmentShader: SCN_FRAGMENT,
    uniforms: {
      uTexture: { value: null },
      uDepth: { value: null },
      uRamp: { value: null },
      uResolution: { value: new THREE.Vector2(1280, 720) },
      uDepthSize: { value: new THREE.Vector2(384, 216) },
      uFxOrigin: { value: new THREE.Vector2(0.5, 0.5) },
      uFxAxisX: { value: new THREE.Vector2(0.5, 0) },
      uFxAxisY: { value: new THREE.Vector2(0, 0.5) },
      uFxHom: { value: new THREE.Matrix3() },
      uFxHomInv: { value: new THREE.Matrix3() },
      uPhase: { value: 0 },
      uWidth: { value: 0.011 },
      uSplit: { value: 0.024 },
      uFeather: { value: 0.0035 },
      uGrain: { value: 0.22 },
      uPixel: { value: 1 },
      uGamma: { value: 1 },
      uLow: { value: 0.015 },
      uHigh: { value: 0.995 },
      uBorder: { value: 1 },
      uInvert: { value: 0 },
      uColorMode: { value: 0 },
      uColor: { value: new THREE.Vector3(0.72, 1, 0.32) },
      uBrightness: { value: 1.25 },
      uSourceMix: { value: 0 },
      uAmount: { value: 1 },
      uView: { value: 0 },
    },
    transparent: true,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

const _scnColor = new THREE.Color();

/** Drives either the GLSL material or its TSL twin — same `.uniforms.x.value` surface. */
export function applyDepthScanUniforms(material, params, { width, height, box, phase, depthTexture, depthSize, invert }) {
  const u = material.uniforms;
  u.uResolution.value.set(width, height);
  u.uDepthSize.value.set(Math.max(1, depthSize?.[0] || 384), Math.max(1, depthSize?.[1] || 216));
  setFxBoxUniforms(u, box);
  u.uDepth.value = depthTexture || null;
  u.uRamp.value = getRampTexture(sanitizeEffectGradient(params.scnRamp, SCN_RAMPS.lidar), 0);
  u.uPhase.value = phase;
  u.uWidth.value = params.scnWidth / 100;
  u.uSplit.value = params.scnSplit / 100;
  u.uFeather.value = params.scnFeather / 100;
  u.uGrain.value = params.scnGrain / 100;
  u.uPixel.value = Math.max(1, params.scnPixel);
  u.uGamma.value = params.scnGamma;
  u.uLow.value = params.scnLow / 100;
  u.uHigh.value = params.scnHigh / 100;
  u.uBorder.value = params.scnBorder / 100;
  u.uInvert.value = invert ? 1 : 0;
  u.uColorMode.value = params.scnColorMode;
  _scnColor.set(params.scnColor || SCN_DEFAULTS.scnColor);
  u.uColor.value.set(_scnColor.r, _scnColor.g, _scnColor.b);
  u.uBrightness.value = params.scnBrightness / 100;
  u.uSourceMix.value = params.scnSource / 100;
  u.uAmount.value = Math.max(0, Math.min(1, params.scnAmount / 100));
  u.uView.value = params.scnView;
}

/** The depth texture + its pixel size for an item, or null when there is no map. */
export function depthScanSource(item) {
  const map = getItemDepthMap(item);
  if (!map) return null;
  const texture = getDepthTexture(map);
  if (!texture) return null;
  return {
    texture,
    size: [map.w || 384, map.h || 216],
    invert: resolveDepthMapParams(item).dmInvert > 0.5,
  };
}
