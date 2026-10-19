// Motion Trail — a per-LAYER typed effect (item.layerEffects, like Motion Blur):
// N copies of the finished layer plate, each drawn where the layer WAS a few
// frames ago, fading and shrinking into the distance. The comet/smear trail
// behind a moving object.
//
// All three methods from html/motion-trail-lab.html ship here, because they are
// different machines and each one wins somewhere:
//
//   * Frame Echo replays a ring of PAST PLATES — the roadmap's Echo Trail (§6.7).
//     It is the only method that carries motion from INSIDE the footage, since it
//     is real recorded pixels. A seek has no history to read, so its taps fall
//     back to reprojection (below) until the ring refills.
//   * Trail Buffer keeps one feedback accumulator and erodes it a few pixels per
//     frame, so the taper is a shape operation and the smear is continuous no
//     matter how fast the layer moves. Strictly ordered: a seek replays it.
//   * Transform Repeats needs no buffers at all — the layer's transform is a pure
//     function of time, so the pose at t − k·Δ is simply evaluated and the copy is
//     the CURRENT plate mapped through (past transform ∘ current⁻¹), the same
//     affine delta Motion Blur measures over one frame. Exact under any scrub.
//
// That last mapping is the shared primitive: it is also how the other two rebuild
// themselves after a seek, which is what keeps a scrubbed frame usable instead of
// blank while their history is cold.
//
// Runs after the Overlay Effects chain and just BEFORE Motion Blur, so every
// copy carries the layer's finished look (glow, defocus, chain, tiles) and a
// shutter still smears the whole trail. See the call site in Player.jsx.

import * as THREE from 'three';
import { materials as makeMaterial } from './materialFactory.js';

export const MOTION_TRAIL_LAYER_EFFECT_ID = 'motionTrail';

// The three ways to build a trail, all three shipped from html/motion-trail-lab.html.
// They are genuinely different machines, not presets of one:
//
//   0 Frame Echo      — N taps into a ring of PAST PLATES. The only method that
//                       can smear motion inside the footage, because it replays
//                       real pixels. Costs the ring, and a seek has no history to
//                       read, so taps fall back to reprojection until it refills.
//   1 Trail Buffer    — one feedback accumulator, eroded a few px per frame. The
//                       taper is a shape operation, so the smear is continuous by
//                       construction and its length costs nothing. Strictly
//                       ordered: a seek rebuilds it from reprojected poses.
//   2 Transform Repeats — the analytic one. No buffers at all, exact at any time.
export const TRAIL_METHOD_ECHO = 0;
export const TRAIL_METHOD_BUFFER = 1;
export const TRAIL_METHOD_REPEATS = 2;

// Ring capacity for Frame Echo, in nominal 30fps frames. Slots are half-res
// (echo ghosts are soft, and full-res would be 4× the VRAM for no visible gain).
export const TRAIL_RING_MAX = 24;
export const TRAIL_HISTORY_SCALE = 0.5;
// How many frames a Trail Buffer seek replays before it is considered settled.
export const TRAIL_REBUILD_MAX = 32;

// Hard ceiling on repeats. Each tap costs one evaluator pose + one layer-box
// projection on the CPU and one gather in the shader, and the uniform arrays are
// sized to it — raising it is a shader edit, not a slider edit.
export const TRAIL_MAX_TAPS = 32;

// The nominal timeline frame the spacing is counted in. The VE's keyframe clock
// is authored against 30fps steps, so a fixed dt keeps a trail the same length
// in preview, in a 24fps export and in a 60fps export.
export const TRAIL_FRAME_DT = 1 / 30;

// Stored in item.layerEffects as one { id, eid, enabled, params } entry. The
// `trail` prefix routes panel writes into that entry (see LayerEffectsSection).
export const TRAIL_DEFAULTS = {
  trailMethod: 1,        // 0 Frame Echo, 1 Trail Buffer, 2 Transform Repeats
  trailPersist: 96,      // % of the accumulator kept each frame (buffer)
  trailTaper: 1.6,       // px @1080 eaten off the silhouette each frame (buffer)
  trailCount: 12,        // repeats behind the layer
  trailSpacing: 1.5,     // frames @30 between repeats — fractional is fine, it is a seek
  trailDecay: 88,        // % opacity kept per repeat
  // SIGNED per repeat: 0 = no change, negative shrinks, positive grows. Stored
  // as the delta rather than a 80–120 multiplier so the neutral is zero and both
  // directions are one control (legacy 9.6.35 values are migrated by the
  // sanitizer — see sanitizeLayerEffectChain).
  trailScale: -3,
  trailRotate: 0,        // ° per repeat
  trailOffsetX: 0,       // px @1080 per repeat
  trailOffsetY: 0,
  trailBlend: 0,         // 0 Behind, 1 Add, 2 Screen, 3 Maximum
  trailColorize: 0,      // % toward the tint at the tail
  trailTint: '#4fd6ff',
  trailAmount: 100,      // % master mix (keyframable)
};

export const TRAIL_NUMBER_FIELDS = [
  // Trail Buffer only — Persistence is how much survives per frame, Taper is how
  // many pixels the silhouette loses per frame. Taper alone shapes the cone.
  { key: 'trailPersist', label: 'Persistence', min: 50, max: 100, step: 0.5, suffix: '%', kf: true, bufferOnly: true },
  { key: 'trailTaper', label: 'Taper', min: 0, max: 8, step: 0.1, suffix: 'px/f', kf: true, bufferOnly: true },
  { key: 'trailCount', label: 'Repeats', min: 1, max: TRAIL_MAX_TAPS, step: 1, repeatOnly: true },
  // Sub-frame spacing is the difference between a continuous smear and a row of
  // stepped ghosts, and it is free here — the pose is evaluated, not recalled
  // from a frame cache, so 0.25 costs exactly what 4 costs.
  { key: 'trailSpacing', label: 'Spacing', min: 0.25, max: 8, step: 0.25, suffix: 'f', kf: true, repeatOnly: true },
  { key: 'trailDecay', label: 'Opacity Decay', min: 0, max: 100, step: 1, suffix: '%', kf: true, repeatOnly: true },
  { key: 'trailScale', label: 'Scale Decay', min: -25, max: 25, step: 0.5, suffix: '%', kf: true, repeatOnly: true },
  { key: 'trailRotate', label: 'Rotation Drift', min: -20, max: 20, step: 0.5, suffix: '°', kf: true, repeatOnly: true },
  { key: 'trailOffsetX', label: 'Offset X', min: -60, max: 60, step: 1, suffix: 'px', repeatOnly: true, kf: true },
  { key: 'trailOffsetY', label: 'Offset Y', min: -60, max: 60, step: 1, suffix: 'px', repeatOnly: true, kf: true },
  { key: 'trailColorize', label: 'Colorize', min: 0, max: 100, step: 1, suffix: '%', kf: true },
  { key: 'trailAmount', label: 'Effect Amount', min: 0, max: 100, step: 2, suffix: '%', kf: true },
];

export const TRAIL_ENUM_FIELDS = [
  {
    key: 'trailMethod',
    label: 'Method',
    options: [
      [TRAIL_METHOD_ECHO, 'Frame Echo (real pixels)'],
      [TRAIL_METHOD_BUFFER, 'Trail Buffer (smear)'],
      [TRAIL_METHOD_REPEATS, 'Transform Repeats'],
    ],
  },
  {
    key: 'trailBlend',
    label: 'Blend',
    options: [
      [0, 'Behind (trail under layer)'],
      [1, 'Add'],
      [2, 'Screen'],
      [3, 'Maximum'],
    ],
  },
];

export const TRAIL_COLOR_FIELDS = [
  { key: 'trailTint', label: 'Tint' },
];

export const TRAIL_KF_KEYS = TRAIL_NUMBER_FIELDS.filter((f) => f.kf).map((f) => f.key);

export function getMotionTrailEffect(item) {
  const list = item?.layerEffects;
  if (!Array.isArray(list)) return null;
  return list.find((effect) => effect?.id === MOTION_TRAIL_LAYER_EFFECT_ID) || null;
}

export function isMotionTrailEnabled(item) {
  const effect = getMotionTrailEffect(item);
  if (!effect || effect.enabled === false) return false;
  const amount = Number.isFinite(effect.params?.trailAmount)
    ? effect.params.trailAmount
    : TRAIL_DEFAULTS.trailAmount;
  // A static 0 is an exact bypass — but a keyframed amount can ramp up from it.
  if (amount > 0.01) return true;
  const track = item?.propertyKeyframes?.trailAmount;
  return Array.isArray(track) && track.length > 0;
}

// ── PRO gating (containsProGlowEffect precedent) ────────────────────────────
// Motion Trail is a PRO effect, gated exactly like Running Glow and the Rig:
// free to design and play back in the preview, paywalled at render. The check
// lives here rather than in a list of feature ids because there is nothing to
// keep in sync — the effect IS the flag. See the gate in VideoEditor's
// handleRenderInBackground.
export const TRAIL_IS_PRO = true;

// `isMotionTrailEnabled` already counts a keyframed Effect Amount that ramps up
// from a static 0, so a fade-in trail cannot render for free.
function trailGatesRender(item) {
  if (!TRAIL_IS_PRO) return false;
  return isMotionTrailEnabled(item);
}

// Project sequences can nest other sequences, so inspect the complete saved
// editor state rather than only the currently visible timeline level.
export function containsProTrailEffect(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (trailGatesRender(value)) return true;
  if (Array.isArray(value)) return value.some((entry) => containsProTrailEffect(entry, seen));
  return Object.values(value).some((entry) => containsProTrailEffect(entry, seen));
}

// Effective params for a frame: keyframe track ?? stored param ?? default.
export function resolveMotionTrailParams(item, keyframeProps) {
  const effect = getMotionTrailEffect(item);
  const params = effect?.params || {};
  const out = {};
  for (const [key, fallback] of Object.entries(TRAIL_DEFAULTS)) {
    if (typeof fallback === 'string') {
      const raw = params[key];
      out[key] = typeof raw === 'string' && raw ? raw : fallback;
      continue;
    }
    const kf = keyframeProps?.[key];
    if (Number.isFinite(kf)) { out[key] = kf; continue; }
    const raw = params[key];
    out[key] = Number.isFinite(raw) ? raw : fallback;
  }
  return out;
}

// Per-repeat drift, applied to the layer box the evaluator produced for that
// tap. Scale is about the box ORIGIN — the layer's own centre — which is the
// one thing a pixel-history echo cannot do: it has no idea where the object is
// inside the frame, so it can only scale about a manual anchor.
//
// `box` is a computeLayerBox result ({ origin, axisX, axisY } in frame uv with
// half-axes). k is 1-based. Returns a new box; the input is untouched.
export function applyTrailDrift(box, k, params, width, height) {
  // Signed: −4 shrinks each repeat by 4%, +4 grows it. Clamped so a wild value
  // cannot invert the box (a negative scale would mirror the artwork).
  const s = Math.pow(Math.max(0.05, 1 + params.trailScale / 100), k);
  const rot = (params.trailRotate * Math.PI / 180) * k;
  // px params are authored @1080 and scale with the actual plate, like every
  // other px control in the per-layer stack.
  const pxScale = height / 1080;
  const ox = (params.trailOffsetX * pxScale * k) / Math.max(1, width);
  const oy = -(params.trailOffsetY * pxScale * k) / Math.max(1, height);
  let [ax, ay] = box.axisX;
  let [bx, by] = box.axisY;
  if (rot !== 0) {
    // uv is anisotropic — rotate in pixel space or a square becomes a rhombus.
    const c = Math.cos(rot), sn = Math.sin(rot);
    const aspect = Math.max(1e-6, width / height);
    const rotate = (x, y) => {
      const px = x * aspect;
      return [(px * c - y * sn) / aspect, px * sn + y * c];
    };
    [ax, ay] = rotate(ax, ay);
    [bx, by] = rotate(bx, by);
  }
  return {
    origin: [box.origin[0] + ox, box.origin[1] + oy],
    axisX: [ax * s, ay * s],
    axisY: [bx * s, by * s],
  };
}

// Peak corner displacement (px) between a tap box and the current one. The
// caller's cheap "is this layer actually moving" gate.
export function trailBoxDisplacement(boxNow, box, width, height) {
  let peak = 0;
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const nx = boxNow.origin[0] + a * boxNow.axisX[0] + b * boxNow.axisY[0];
    const ny = boxNow.origin[1] + a * boxNow.axisX[1] + b * boxNow.axisY[1];
    const px = box.origin[0] + a * box.axisX[0] + b * box.axisY[0];
    const py = box.origin[1] + a * box.axisX[1] + b * box.axisY[1];
    peak = Math.max(peak, Math.hypot((nx - px) * width, (ny - py) * height));
  }
  return peak;
}

// ── GLSL ────────────────────────────────────────────────────────────────────
// One gather pass over the finished full-frame layer plate. For every repeat,
// the output pixel is solved into that repeat's quad-local coordinates and the
// plate is sampled at the same coordinates in the CURRENT box — i.e. the copy
// is the plate re-projected through (tap box ∘ current box⁻¹). Everything is
// premultiplied, so the trail composites over the stack correctly and a
// transparent export keeps its edges.

const VERTEX = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform vec2 uCurrO, uCurrX, uCurrY;               // current box: origin + half-axes, frame uv
uniform vec2 uTapO[${TRAIL_MAX_TAPS}];             // the same box at t - k*spacing, drifted
uniform vec2 uTapX[${TRAIL_MAX_TAPS}];
uniform vec2 uTapY[${TRAIL_MAX_TAPS}];
uniform float uCount;
uniform float uDecay;
uniform float uColorize;
uniform vec3 uTint;
uniform float uBlend;                              // 0 behind, 1 add, 2 screen, 3 max
uniform float uMix;

const vec3 LW = vec3(0.299, 0.587, 0.114);

vec4 tapClamped(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture2D(uTexture, uv);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 src = texture2D(uTexture, uv);
  if (uMix <= 0.001 || uCount < 0.5) { gl_FragColor = src; return; }

  vec4 trail = vec4(0.0);
  for (int i = 0; i < ${TRAIL_MAX_TAPS}; i++) {
    if (float(i) >= uCount) break;
    vec2 O = uTapO[i], X = uTapX[i], Y = uTapY[i];
    float det = X.x * Y.y - X.y * Y.x;
    if (abs(det) < 1e-9) continue;
    vec2 d = uv - O;
    float a = ( d.x * Y.y - d.y * Y.x) / det;
    float b = (-d.x * X.y + d.y * X.x) / det;
    // Outside this repeat's own quad. Required, not an optimisation: a text or
    // motion layer's plate is comp-sized, so without it a far-away pixel would
    // sample a real part of the artwork instead of nothing.
    if (abs(a) > 1.0 || abs(b) > 1.0) continue;
    vec4 c = tapClamped(uCurrO + a * uCurrX + b * uCurrY);
    if (c.a <= 0.0) continue;
    if (uColorize > 0.0) {
      float l = dot(c.rgb, LW);
      c.rgb = mix(c.rgb, l * uTint * 1.35, uColorize * (float(i) + 1.0) / uCount);
    }
    c *= pow(uDecay, float(i) + 1.0);
    if (uBlend < 0.5) trail = trail + c * (1.0 - trail.a);   // nearer repeats stay in front
    else if (uBlend < 1.5) trail += c;
    else if (uBlend < 2.5) trail = vec4(1.0) - (vec4(1.0) - trail) * (vec4(1.0) - c);
    else trail = max(trail, c);
  }
  trail = clamp(trail, 0.0, 1.0);

  vec4 outc;
  if (uBlend < 0.5) outc = src + trail * (1.0 - src.a);
  else if (uBlend < 1.5) outc = src + trail;
  else if (uBlend < 2.5) outc = vec4(1.0) - (vec4(1.0) - src) * (vec4(1.0) - trail);
  else outc = max(src, trail);
  outc = clamp(outc, 0.0, 1.0);
  outc.rgb = min(outc.rgb, vec3(outc.a));           // premultiplied: colour never exceeds alpha
  gl_FragColor = mix(src, outc, uMix);
}
`;

// Shared GLSL: the four trail blend modes, all premultiplied.
const BLEND_GLSL = /* glsl */ `
vec4 trailBlend(vec4 under, vec4 over, float mode) {
  if (mode < 0.5) return over + under * (1.0 - over.a);   // Behind: over stays in front
  if (mode < 1.5) return under + over;                    // Add
  if (mode < 2.5) return vec4(1.0) - (vec4(1.0) - under) * (vec4(1.0) - over);
  return max(under, over);                                // Maximum
}
`;

// ── Frame Echo / Trail Buffer rebuild: warp one plate through a box pair ─────
// `src` box is the pose the tap's pixels ALREADY have (the current box for a
// reprojected plate, the historical box for a real recorded frame); `dst` is
// where the repeat should land. Identical boxes are a straight copy, which is
// what an undrifted history tap wants.
const WARP_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform vec2 uSrcO, uSrcX, uSrcY;
uniform vec2 uDstO, uDstX, uDstY;
uniform float uWeight, uColorize, uDepth;
uniform vec3 uTint;
const vec3 LW = vec3(0.299, 0.587, 0.114);
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float det = uDstX.x * uDstY.y - uDstX.y * uDstY.x;
  if (abs(det) < 1e-9) { gl_FragColor = vec4(0.0); return; }
  vec2 d = uv - uDstO;
  float a = ( d.x * uDstY.y - d.y * uDstY.x) / det;
  float b = (-d.x * uDstX.y + d.y * uDstX.x) / det;
  if (abs(a) > 1.0 || abs(b) > 1.0) { gl_FragColor = vec4(0.0); return; }
  vec2 s = uSrcO + a * uSrcX + b * uSrcY;
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) { gl_FragColor = vec4(0.0); return; }
  vec4 c = texture2D(uTexture, s);
  if (uColorize > 0.0) {
    float l = dot(c.rgb, LW);
    c.rgb = mix(c.rgb, l * uTint * 1.35, uColorize * uDepth);
  }
  gl_FragColor = c * uWeight;
}
`;

// Accumulate one warped repeat into the running trail.
const ACC_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uAcc;
uniform sampler2D uTap;
uniform vec2 uResolution;
uniform float uBlend;
${BLEND_GLSL}
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 acc = texture2D(uAcc, uv);
  vec4 tap = texture2D(uTap, uv);
  // The trail stacks front-to-back, so a nearer repeat already in acc wins.
  vec4 outc = clamp(trailBlend(tap, acc, uBlend), 0.0, 1.0);
  outc.rgb = min(outc.rgb, vec3(outc.a));
  gl_FragColor = outc;
}
`;

// ── Trail Buffer: one feedback step ─────────────────────────────────────────
// The accumulator is eroded (a morphological min over its alpha) and faded, then
// the current plate is unioned back in. Erosion is what tapers the tail: it eats
// a fixed number of pixels off the silhouette every frame, so the oldest part is
// the thinnest — a continuous smear no repeat count can produce.
const ERODE_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uAcc;
uniform vec2 uResolution;
uniform float uPersist, uTaper, uColorize, uBlend;
uniform vec3 uTint;
const vec3 LW = vec3(0.299, 0.587, 0.114);
${BLEND_GLSL}
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 texel = uTaper / uResolution;
  vec4 src = texture2D(uSrc, uv);
  vec4 c0 = texture2D(uAcc, uv);
  float mn = c0.a;
  for (int i = 0; i < 8; i++) {
    float a = float(i) / 8.0 * 6.2831853;
    vec2 dir = vec2(cos(a), sin(a));
    mn = min(mn, texture2D(uAcc, uv + dir * texel).a);
    mn = min(mn, texture2D(uAcc, uv + dir * texel * 0.5).a);
  }
  float k = c0.a > 0.002 ? mn / c0.a : 0.0;
  vec4 aged = c0 * (k * uPersist);
  if (uColorize > 0.0) {
    float l = dot(aged.rgb, LW);
    aged.rgb = mix(aged.rgb, l * uTint * 1.35, uColorize * 0.16);
  }
  aged.rgb = min(aged.rgb, vec3(aged.a));
  vec4 outc = clamp(trailBlend(aged, src, uBlend), 0.0, 1.0);
  outc.rgb = min(outc.rgb, vec3(outc.a));
  gl_FragColor = outc;
}
`;

// Final composite: the finished trail under (or added to) the untouched plate,
// crossfaded by Effect Amount so mix 0 is an exact bypass.
const COMPOSE_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uTrail;
uniform vec2 uResolution;
uniform float uBlend, uMix, uHasSource;
${BLEND_GLSL}
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 src = texture2D(uSrc, uv);
  vec4 trail = texture2D(uTrail, uv);
  // The buffer step already unioned the source in; the echo accumulator has not.
  vec4 outc = uHasSource > 0.5 ? trail : trailBlend(trail, src, uBlend);
  outc = clamp(outc, 0.0, 1.0);
  outc.rgb = min(outc.rgb, vec3(outc.a));
  gl_FragColor = mix(src, outc, uMix);
}
`;

function shader(fragment, uniforms) {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: fragment,
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    uniforms,
  });
}

export function createTrailWarpMaterial() {
  return makeMaterial.trailWarp() ?? shader(WARP_FRAGMENT, {
    uTexture: { value: null },
    uResolution: { value: new THREE.Vector2(1920, 1080) },
    uSrcO: { value: new THREE.Vector2() },
    uSrcX: { value: new THREE.Vector2() },
    uSrcY: { value: new THREE.Vector2() },
    uDstO: { value: new THREE.Vector2() },
    uDstX: { value: new THREE.Vector2() },
    uDstY: { value: new THREE.Vector2() },
    uWeight: { value: 1 },
    uColorize: { value: 0 },
    uDepth: { value: 0 },
    uTint: { value: new THREE.Color(0x4fd6ff) },
  });
}
export function createTrailAccMaterial() {
  return makeMaterial.trailAcc() ?? shader(ACC_FRAGMENT, {
    uAcc: { value: null },
    uTap: { value: null },
    uResolution: { value: new THREE.Vector2(1920, 1080) },
    uBlend: { value: 0 },
  });
}
export function createTrailErodeMaterial() {
  return makeMaterial.trailErode() ?? shader(ERODE_FRAGMENT, {
    uSrc: { value: null },
    uAcc: { value: null },
    uResolution: { value: new THREE.Vector2(1920, 1080) },
    uPersist: { value: 0.96 },
    uTaper: { value: 1.6 },
    uColorize: { value: 0 },
    uTint: { value: new THREE.Color(0x4fd6ff) },
    uBlend: { value: 0 },
  });
}
export function createTrailComposeMaterial() {
  return makeMaterial.trailCompose() ?? shader(COMPOSE_FRAGMENT, {
    uSrc: { value: null },
    uTrail: { value: null },
    uResolution: { value: new THREE.Vector2(1920, 1080) },
    uBlend: { value: 0 },
    uMix: { value: 1 },
    uHasSource: { value: 0 },
  });
}

// Set the warp for one repeat. `srcBox` is the pose the pixels already carry.
export function applyTrailWarpUniforms(material, { width, height, srcBox, dstBox, weight, colorize, depth, tint }) {
  const u = material.uniforms;
  u.uResolution.value.set(width, height);
  u.uSrcO.value.set(srcBox.origin[0], srcBox.origin[1]);
  u.uSrcX.value.set(srcBox.axisX[0], srcBox.axisX[1]);
  u.uSrcY.value.set(srcBox.axisY[0], srcBox.axisY[1]);
  u.uDstO.value.set(dstBox.origin[0], dstBox.origin[1]);
  u.uDstX.value.set(dstBox.axisX[0], dstBox.axisX[1]);
  u.uDstY.value.set(dstBox.axisY[0], dstBox.axisY[1]);
  u.uWeight.value = weight;
  u.uColorize.value = colorize;
  u.uDepth.value = depth;
  if (tint) u.uTint.value.set(tint);
}

export function createMotionTrailMaterial() {
  const nodeMat = makeMaterial.motionTrail();
  if (nodeMat) return nodeMat;
  // One fresh Vector2 per slot per array — three uploads the array by reading
  // each element, so shared instances would tie the three axes together.
  const slots = () => Array.from({ length: TRAIL_MAX_TAPS }, () => new THREE.Vector2());
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
      uTapO: { value: slots() },
      uTapX: { value: slots() },
      uTapY: { value: slots() },
      uCount: { value: 0 },
      uDecay: { value: 0.88 },
      uColorize: { value: 0 },
      uTint: { value: new THREE.Color(0x4fd6ff) },
      uBlend: { value: 0 },
      uMix: { value: 1 },
    },
  });
}

// `boxNow` is the computeLayerBox result for this frame; `boxes` are the
// already-drifted tap boxes, nearest repeat first.
export function applyMotionTrailUniforms(material, params, { width, height, boxNow, boxes }) {
  const u = material.uniforms;
  u.uResolution.value.set(width, height);
  u.uCurrO.value.set(boxNow.origin[0], boxNow.origin[1]);
  u.uCurrX.value.set(boxNow.axisX[0], boxNow.axisX[1]);
  u.uCurrY.value.set(boxNow.axisY[0], boxNow.axisY[1]);
  const n = Math.min(TRAIL_MAX_TAPS, boxes.length);
  for (let i = 0; i < n; i++) {
    u.uTapO.value[i].set(boxes[i].origin[0], boxes[i].origin[1]);
    u.uTapX.value[i].set(boxes[i].axisX[0], boxes[i].axisX[1]);
    u.uTapY.value[i].set(boxes[i].axisY[0], boxes[i].axisY[1]);
  }
  u.uCount.value = n;
  u.uDecay.value = Math.min(1, Math.max(0, params.trailDecay / 100));
  u.uColorize.value = Math.min(1, Math.max(0, params.trailColorize / 100));
  u.uTint.value.set(params.trailTint || TRAIL_DEFAULTS.trailTint);
  u.uBlend.value = params.trailBlend;
  u.uMix.value = Math.min(1, Math.max(0, params.trailAmount / 100));
}
