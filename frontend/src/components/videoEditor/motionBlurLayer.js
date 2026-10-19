// Motion Blur — a per-LAYER typed effect (item.layerEffects, like Running Glow):
// the layer is smeared along its own screen-space motion, computed analytically
// from the transform it had one timeline frame earlier. Position/rotation/scale
// keyframes, motion paths and parenting all contribute; rotation produces the
// correct per-pixel tangential streaks because a rigid velocity field is linear
// in position, so mapping each pixel through (previous transform ∘ current⁻¹)
// IS the exact field — no velocity buffer, tiles or dilation needed on an
// isolated layer plate. Prototyped in html/motion-blur-lab.html (the lab is the
// look reference; its Velocity Buffer method is this, minus the machinery a
// flattened multi-object scene forces).
//
// Runs LAST in the per-layer pipeline — after DoF, Running Glow and the Overlay
// Effects chain — because a shutter smears the finished look of the layer, not
// the artwork that look was built from. See the call site in Player.jsx.
//
// What it cannot see: motion INSIDE the clip's pixels (someone walking in a
// static video). That needs optical flow, which was prototyped and dropped —
// too many artifacts against the exact vectors the runner gets for free.

import * as THREE from 'three';

export const MOTION_BLUR_LAYER_EFFECT_ID = 'motionBlur';

// Stored in item.layerEffects as one { id, eid, enabled, params } entry. The
// `mblur` prefix routes panel writes into that entry (see LayerEffectsSection).
export const MBLUR_DEFAULTS = {
  mblurMode: 0,        // 0 = Accumulation (true shutter), 1 = Velocity smear (fast)
  mblurPhase: 0,       // 0 = Trailing (streak behind), 1 = Centered, 2 = Leading
  mblurShutter: 180,   // ° — 360 = the full inter-frame displacement
  mblurSamples: 24,    // sub-frames (accumulation) / gather taps (velocity)
  mblurMaxBlur: 120,   // px @1080 — streak length ceiling (velocity mode)
  mblurFalloff: 250,   // % — 250+ ≈ flat physical shutter; low = soft smear (velocity mode)
  mblurAmount: 100,    // % — master mix (keyframable)
};

export const MBLUR_NUMBER_FIELDS = [
  { key: 'mblurShutter', label: 'Shutter', min: 0, max: 720, step: 5, suffix: '°', kf: true },
  { key: 'mblurSamples', label: 'Samples', min: 8, max: 48, step: 1 },
  { key: 'mblurMaxBlur', label: 'Max Blur', min: 8, max: 300, step: 1, suffix: 'px', velocityOnly: true, kf: true },
  // The lab's falloff trade-off: low values center-weight the kernel, which
  // keeps a sharp core inside the streak (a stylized smear); high values are a
  // flat box like true accumulation.
  { key: 'mblurFalloff', label: 'Falloff', min: 10, max: 300, step: 5, suffix: '%', velocityOnly: true, kf: true },
  { key: 'mblurAmount', label: 'Effect Amount', min: 0, max: 100, step: 2, suffix: '%', kf: true },
];

export const MBLUR_ENUM_FIELDS = [
  {
    key: 'mblurMode',
    label: 'Mode',
    options: [
      [0, 'Accumulation (true shutter)'],
      [1, 'Velocity smear (fast)'],
    ],
  },
  // Where the shutter window sits relative to the current frame. Trailing puts
  // the whole streak BEHIND the motion (object sharp at its lead, comet tail
  // where it came from) — the look people mean by "motion blur". Centered is
  // the symmetric physical convention; Leading anticipates ahead.
  {
    key: 'mblurPhase',
    label: 'Phase',
    options: [
      [0, 'Trailing (behind motion)'],
      [1, 'Centered'],
      [2, 'Leading (ahead)'],
    ],
  },
];

// Keyframable params, registered in keyframeProps.js.
export const MBLUR_KF_KEYS = MBLUR_NUMBER_FIELDS.filter((f) => f.kf).map((f) => f.key);

// The nominal timeline frame the velocity is measured over. The VE's keyframe
// clock is authored against 30fps steps; using a fixed dt keeps the blur length
// identical between preview and export whatever the display refresh is.
export const MBLUR_FRAME_DT = 1 / 30;

export function getMotionBlurEffect(item) {
  const list = item?.layerEffects;
  if (!Array.isArray(list)) return null;
  return list.find((effect) => effect?.id === MOTION_BLUR_LAYER_EFFECT_ID) || null;
}

export function isMotionBlurEnabled(item) {
  const effect = getMotionBlurEffect(item);
  if (!effect || effect.enabled === false) return false;
  const amount = Number.isFinite(effect.params?.mblurAmount)
    ? effect.params.mblurAmount
    : MBLUR_DEFAULTS.mblurAmount;
  // A static 0 is an exact bypass — but a keyframed amount can ramp up from it.
  if (amount > 0.01) return true;
  const track = item?.propertyKeyframes?.mblurAmount;
  return Array.isArray(track) && track.length > 0;
}

// Effective params for a frame: keyframe track ?? stored param ?? default.
export function resolveMotionBlurParams(item, keyframeProps) {
  const effect = getMotionBlurEffect(item);
  const params = effect?.params || {};
  const out = {};
  for (const [key, fallback] of Object.entries(MBLUR_DEFAULTS)) {
    const kf = keyframeProps?.[key];
    if (Number.isFinite(kf)) { out[key] = kf; continue; }
    const raw = params[key];
    out[key] = Number.isFinite(raw) ? raw : fallback;
  }
  return out;
}

// Accumulation mode: running-mean combine of one sub-frame over the
// accumulated plate. `mix(acc, sub, 1/(k+1))` in a shader rather than constant
// blending — additive 1/K into an 8-bit target posterizes dark values, and
// constant-alpha blend factors need a newer three than a shared material can
// assume (the lab hit both).
const MIX_FRAGMENT = /* glsl */ `
precision mediump float;
uniform sampler2D uAcc;
uniform sampler2D uSub;
uniform vec2 uResolution;
uniform float uW;
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  gl_FragColor = mix(texture2D(uAcc, uv), texture2D(uSub, uv), uW);
}
`;

export function createMotionBlurMixMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: MIX_FRAGMENT,
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uAcc: { value: null },
      uSub: { value: null },
      uResolution: { value: new THREE.Vector2(1920, 1080) },
      uW: { value: 0.5 },
    },
  });
}

// ── GLSL ────────────────────────────────────────────────────────────────────
// One gather pass over the finished full-frame layer plate. The two affine
// boxes (computeLayerBox at t and t − dt, both projected through the channel's
// own camera) define the exact screen-space map current → previous; each pixel
// solves its quad-local coords in the current basis and re-projects them
// through the previous one. All premultiplied: alpha smears with color, so the
// streak composites correctly over the stack.

const VERTEX = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform vec2 uCurrO, uCurrX, uCurrY;   // current box: origin + half-axes, frame uv
uniform vec2 uPrevO, uPrevX, uPrevY;   // the same box one timeline frame earlier
uniform float uShutter;                // frames (° / 360)
uniform float uSamples;
uniform float uMaxBlur;                // px at this plate's resolution
uniform float uFall;                   // falloff exponent base (1/uFall applied)
uniform float uMix;
uniform float uPhase;                  // 0 trailing, 1 centered, 2 leading

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec4 tapClamped(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture2D(uTexture, uv);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 src = texture2D(uTexture, uv);
  float det = uCurrX.x * uCurrY.y - uCurrX.y * uCurrY.x;
  if (abs(det) < 1e-9 || uMix <= 0.001) { gl_FragColor = src; return; }

  // Quad-local coords in the current basis, re-projected through the previous.
  vec2 d = uv - uCurrO;
  float a = ( d.x * uCurrY.y - d.y * uCurrY.x) / det;
  float b = (-d.x * uCurrX.y + d.y * uCurrX.x) / det;
  vec2 prevUv = uPrevO + a * uPrevX + b * uPrevY;

  vec2 blurPx = (uv - prevUv) * uResolution * uShutter;
  float len = length(blurPx);
  if (len > uMaxBlur) { blurPx *= uMaxBlur / len; len = uMaxBlur; }
  if (len < 0.5) { gl_FragColor = src; return; }

  vec2 stepUv = blurPx / uResolution;
  float taps = clamp(floor(uSamples), 7.0, 64.0);
  // Deterministic per-pixel comb jitter (pure function of the pixel) hides
  // banding between taps without breaking preview/export agreement.
  float j = hash21(gl_FragCoord.xy) - 0.5;
  // Phase places the shutter window relative to now. s is the fraction of the
  // full inter-frame displacement to step BACK along the motion: trailing
  // covers [0, 1] (the whole streak behind), centered [-0.5, 0.5], leading
  // [-1, 0] (extrapolated ahead).
  float s0 = uPhase < 0.5 ? 0.0 : (uPhase < 1.5 ? -0.5 : -1.0);
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i < 64; i++) {
    if (float(i) >= taps) break;
    float u01 = (float(i) + 0.5 + j) / taps;
    float s = s0 + u01;
    // Envelope over the window, peaking at the CURRENT position (e = 0) so the
    // object stays anchored and the tail fades. No bonus center weight — that
    // re-prints the original silhouette inside the streak (the lab's "two
    // textures" artifact).
    float e = uPhase < 0.5 ? u01 : (uPhase < 1.5 ? abs(s) * 2.0 : -s);
    float w = pow(max(1.0 - e, 0.0), 1.0 / max(uFall, 0.05));
    acc += tapClamped(uv - stepUv * s) * w;
    ws += w;
  }
  vec4 blurred = ws > 1e-4 ? acc / ws : src;
  gl_FragColor = mix(src, blurred, uMix);
}
`;

export function createMotionBlurMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uTexture: { value: null },
      uResolution: { value: new THREE.Vector2(1920, 1080) },
      uCurrO: { value: new THREE.Vector2() },
      uCurrX: { value: new THREE.Vector2() },
      uCurrY: { value: new THREE.Vector2() },
      uPrevO: { value: new THREE.Vector2() },
      uPrevX: { value: new THREE.Vector2() },
      uPrevY: { value: new THREE.Vector2() },
      uShutter: { value: 0.5 },
      uSamples: { value: 24 },
      uMaxBlur: { value: 120 },
      uFall: { value: 2.5 },
      uMix: { value: 1 },
      uPhase: { value: 0 },
    },
  });
}

// `boxNow` / `boxPrev` are computeLayerBox results ({ origin, axisX, axisY }).
// Returns the peak corner displacement in plate px so the caller can skip the
// pass entirely on a static frame.
export function applyMotionBlurUniforms(material, params, { width, height, quality = 1, boxNow, boxPrev }) {
  const u = material.uniforms;
  u.uResolution.value.set(width, height);
  u.uCurrO.value.set(boxNow.origin[0], boxNow.origin[1]);
  u.uCurrX.value.set(boxNow.axisX[0], boxNow.axisX[1]);
  u.uCurrY.value.set(boxNow.axisY[0], boxNow.axisY[1]);
  u.uPrevO.value.set(boxPrev.origin[0], boxPrev.origin[1]);
  u.uPrevX.value.set(boxPrev.axisX[0], boxPrev.axisX[1]);
  u.uPrevY.value.set(boxPrev.axisY[0], boxPrev.axisY[1]);
  u.uShutter.value = Math.max(0, params.mblurShutter) / 360;
  u.uPhase.value = params.mblurPhase;
  // Full slider value at render quality; halved only during interactive playback.
  u.uSamples.value = Math.max(7, Math.round(params.mblurSamples * (quality < 0.75 ? 0.5 : 1)));
  // px params are authored @1080 and scale with the actual plate.
  u.uMaxBlur.value = Math.max(1, params.mblurMaxBlur) * (height / 1080);
  u.uFall.value = Math.max(0.05, params.mblurFalloff / 100);
  u.uMix.value = Math.min(1, Math.max(0, params.mblurAmount / 100));
}

// Peak displacement (px) between the two boxes over one full frame, measured at
// the quad corners — the caller's cheap "is anything actually moving" gate.
export function motionBlurPeakDisplacement(boxNow, boxPrev, width, height) {
  let peak = 0;
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const nx = boxNow.origin[0] + a * boxNow.axisX[0] + b * boxNow.axisY[0];
    const ny = boxNow.origin[1] + a * boxNow.axisX[1] + b * boxNow.axisY[1];
    const px = boxPrev.origin[0] + a * boxPrev.axisX[0] + b * boxPrev.axisY[0];
    const py = boxPrev.origin[1] + a * boxPrev.axisX[1] + b * boxPrev.axisY[1];
    peak = Math.max(peak, Math.hypot((nx - px) * width, (ny - py) * height));
  }
  return peak;
}
