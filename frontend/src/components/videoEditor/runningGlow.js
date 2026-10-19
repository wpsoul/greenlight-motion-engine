// Running Glow Edge — a per-LAYER GPU effect: a bright light runs along the
// contour of whatever the layer contains (text, a logo, a shape, footage),
// dragging a coloured comet trail and a soft bloom with it and leaving a faint
// static rim behind.
//
// Unlike the adjustment-layer chain in adjustmentEffects.js (which restyles the
// composited layers BELOW it), this runs on one layer's own pixels: the Player
// renders that layer alone into a render target, runs the two passes here, and
// composites the premultiplied result back over the accumulated stack — the same
// shape as the camera-DOF per-layer branch.
//
// Two passes, mirroring html/running-glow-edge.html (the prototype is the source
// of truth for the look — tune there first):
//
//   pass 1 (pre)   horizontal Gaussian of the CONTENT MASK at two radii
//                  -> .r = narrow field, .g = wide field
//   pass 2 (main)  vertical completion of both fields, then:
//                    - a blurred mask is a cheap signed distance field: the
//                      contour is wherever field == 0.5, so a Gaussian BAND
//                      around 0.5 IS the outline. Narrow field -> the crisp core
//                      line, wide field -> the bloom. The glow needs no extra
//                      blur pass; it is analytically wide because its field is.
//                    - a phase runs around the shape (angle about the centre) or
//                      across it (linear sweep); the wrapped distance from the
//                      head becomes a head + decaying trail.
//                    - core and halo are multiplied by that runner and added
//                      emissively over the layer, premultiplied.
//
// Everything is a pure function of uTime, so preview and the deterministic
// WebCodecs export agree frame for frame.

import * as THREE from 'three';
import { STABLE_ATAN2_GLSL } from './stableAtan2Glsl.js';

// px params are authored against this frame height and scaled by the real one.
const REF_H = 1080;

// Stored in item.layerEffects as one { id, eid, enabled, params } entry. Keeping
// the settings inside the effect instance prevents the Layer Effects section from
// leaking glow-specific fields onto every timeline item.
export const RUNNING_GLOW_LAYER_EFFECT_ID = 'runningGlow';

// Defaults = the prototype's "Neon Circuit" preset.
export const GLOW_DEFAULTS = {
  glowEdgeWidth: 4,      // px @1080 — thickness of the crisp running line
  glowRadius: 34,        // px @1080 — bloom reach
  glowEdgeLevel: 1.6,    // core brightness
  glowLevel: 1.3,        // halo brightness
  glowSpeed: 0.5,        // loops per second (negative = reverse)
  glowCount: 2,          // runners on the path
  glowTrail: 52,         // % — comet tail length
  glowStaticRim: 14,     // % — rim left behind everywhere
  glowOffset: 0,         // px — + pushes the line outside the shape
  glowPathMode: 0,       // 0 = around the shape, 1 = linear sweep
  glowAngle: 0,          // deg (sweep mode)
  glowFlicker: 0,        // %
  glowMaskMode: 0,       // 0 alpha / 1 luminance / 2 alpha x luma
  glowMaskThreshold: 8,  // % (luminance modes)
  glowSourceLevel: 100,  // % of the layer itself kept under the glow
  glowCenterX: 0,        // % offset of the orbit centre
  glowCenterY: 0,        // %
  glowSoftness: 50,      // %
  glowHeadGlint: 60,     // %
  glowSpread: 40,        // % — -100 inward … 0 both sides … +100 outward
  glowTraceThin: 0,      // 0 = filled shape, 1 = thin lines/outlines
  glowAmount: 100,       // % — master mix (keyframable master intensity)
  glowHeadColor: '#ffffff',
  glowTailColor: '#37d6ff',
  glowGlowColor: '#1f6bff',
};

// Panel presets. Each is a full parameter set (minus the master amount) so
// picking one is predictable rather than a partial merge onto whatever was there.
export const GLOW_PRESETS = [
  {
    name: 'Neon Circuit',
    values: {
      glowEdgeWidth: 4, glowRadius: 34, glowEdgeLevel: 1.6, glowLevel: 1.3, glowSpeed: 0.5, glowCount: 2,
      glowTrail: 52, glowStaticRim: 14, glowOffset: 0, glowPathMode: 0, glowFlicker: 0, glowSoftness: 50,
      glowSpread: 45, glowHeadGlint: 70, glowSourceLevel: 100,
      glowHeadColor: '#ffffff', glowTailColor: '#37d6ff', glowGlowColor: '#1f6bff',
    },
  },
  {
    name: 'Laser Sweep',
    values: {
      glowEdgeWidth: 6, glowRadius: 52, glowEdgeLevel: 1.8, glowLevel: 1.4, glowSpeed: 0.75, glowCount: 1,
      glowTrail: 74, glowStaticRim: 6, glowOffset: 0, glowPathMode: 1, glowAngle: 18, glowFlicker: 0,
      glowSoftness: 62, glowSpread: 35, glowHeadGlint: 120, glowSourceLevel: 100,
      glowHeadColor: '#ffffff', glowTailColor: '#ff5ce0', glowGlowColor: '#7a1fd0',
    },
  },
  {
    name: 'Ember Trace',
    values: {
      glowEdgeWidth: 3, glowRadius: 60, glowEdgeLevel: 1.3, glowLevel: 1.5, glowSpeed: 0.28, glowCount: 1,
      glowTrail: 82, glowStaticRim: 18, glowOffset: 4, glowPathMode: 0, glowFlicker: 22, glowSoftness: 78,
      glowSpread: 75, glowHeadGlint: 40, glowSourceLevel: 100,
      glowHeadColor: '#fff3cf', glowTailColor: '#ff8a2b', glowGlowColor: '#c1240a',
    },
  },
  {
    name: 'Chrome Pulse',
    values: {
      glowEdgeWidth: 7, glowRadius: 26, glowEdgeLevel: 2.1, glowLevel: 0.9, glowSpeed: 1.2, glowCount: 3,
      glowTrail: 30, glowStaticRim: 38, glowOffset: 0, glowPathMode: 0, glowFlicker: 0, glowSoftness: 40,
      glowSpread: 20, glowHeadGlint: 150, glowSourceLevel: 100,
      glowHeadColor: '#ffffff', glowTailColor: '#cfe3ff', glowGlowColor: '#5c86c9',
    },
  },
  {
    name: 'Halo Orbit',
    values: {
      glowEdgeWidth: 2, glowRadius: 90, glowEdgeLevel: 0.8, glowLevel: 1.7, glowSpeed: 0.22, glowCount: 1,
      glowTrail: 90, glowStaticRim: 30, glowOffset: 12, glowPathMode: 0, glowFlicker: 0, glowSoftness: 100,
      glowSpread: 90, glowHeadGlint: 20, glowSourceLevel: 100,
      glowHeadColor: '#eafff6', glowTailColor: '#59f5c0', glowGlowColor: '#0f9c8a',
    },
  },
  {
    name: 'Edge Only',
    values: {
      glowEdgeWidth: 5, glowRadius: 44, glowEdgeLevel: 1.7, glowLevel: 1.3, glowSpeed: 0.45, glowCount: 1,
      glowTrail: 60, glowStaticRim: 10, glowOffset: 0, glowPathMode: 0, glowFlicker: 0, glowSoftness: 55,
      glowSpread: 0, glowHeadGlint: 80, glowSourceLevel: 0,
      glowHeadColor: '#ffffff', glowTailColor: '#8affc1', glowGlowColor: '#12b981',
    },
  },
];

// Panel/sanitizer metadata for every numeric field: range + step + label.
// Single source of truth — the panel builds rows from it and the sanitizer clamps
// with it, so the two can't drift.
export const GLOW_NUMBER_FIELDS = [
  { key: 'glowEdgeWidth', label: 'Edge Width', min: 0.5, max: 40, step: 0.5, suffix: 'px', group: 'Edge', kf: true },
  { key: 'glowOffset', label: 'Edge Offset', min: -40, max: 40, step: 1, suffix: 'px', group: 'Edge', kf: true },
  { key: 'glowEdgeLevel', label: 'Edge Level', min: 0, max: 3, step: 0.05, group: 'Edge', kf: true },
  { key: 'glowStaticRim', label: 'Static Rim', min: 0, max: 100, step: 1, suffix: '%', group: 'Edge', kf: true },
  { key: 'glowRadius', label: 'Glow Radius', min: 0, max: 160, step: 1, suffix: 'px', group: 'Glow', kf: true },
  { key: 'glowLevel', label: 'Glow Level', min: 0, max: 3, step: 0.05, group: 'Glow', kf: true },
  { key: 'glowSoftness', label: 'Softness', min: 0, max: 100, step: 2, suffix: '%', group: 'Glow', kf: true },
  { key: 'glowSpread', label: 'Spread', min: -100, max: 100, step: 5, suffix: '%', group: 'Glow', kf: true },
  { key: 'glowHeadGlint', label: 'Head Glint', min: 0, max: 200, step: 5, suffix: '%', group: 'Glow', kf: true },
  { key: 'glowAngle', label: 'Sweep Angle', min: 0, max: 360, step: 5, suffix: '°', group: 'Run', kf: true },
  { key: 'glowCenterX', label: 'Centre X', min: -50, max: 50, step: 1, suffix: '%', group: 'Run', kf: true },
  { key: 'glowCenterY', label: 'Centre Y', min: -50, max: 50, step: 1, suffix: '%', group: 'Run', kf: true },
  // Stored signed (negative = reverse) for back-compat; the panel shows the
  // magnitude and puts the sign behind a Direction control. Deliberately NOT
  // keyframable: the runner's phase is uTime * speed, so a keyed value would
  // jump the phase rather than accelerate the light. `glowCount` neither — an
  // animated integer pops a whole runner into existence per step.
  { key: 'glowSpeed', label: 'Speed', min: -3, max: 3, step: 0.05, suffix: 'x', group: 'Run', magnitude: true },
  { key: 'glowCount', label: 'Runners', min: 1, max: 8, step: 1, group: 'Run' },
  { key: 'glowTrail', label: 'Trail', min: 0, max: 100, step: 2, suffix: '%', group: 'Run', kf: true },
  { key: 'glowFlicker', label: 'Flicker', min: 0, max: 100, step: 2, suffix: '%', group: 'Run', kf: true },
  { key: 'glowMaskThreshold', label: 'Threshold', min: 0, max: 100, step: 1, suffix: '%', group: 'Source', kf: true },
  // How much of the layer itself survives under the glow. 0 = glow only: the
  // shape vanishes but is still what the glow traces, so a "bare" running light
  // needs this rather than a transparent fill (which erases the trace too).
  { key: 'glowSourceLevel', label: 'Layer Opacity', min: 0, max: 100, step: 2, suffix: '%', group: 'Source', kf: true },
  { key: 'glowAmount', label: 'Effect Amount', min: 0, max: 100, step: 2, suffix: '%', group: 'Source', kf: true },
];

export const GLOW_COLOR_FIELDS = [
  { key: 'glowHeadColor', label: 'Head' },
  { key: 'glowTailColor', label: 'Trail' },
  { key: 'glowGlowColor', label: 'Glow' },
];

// Enumerated (select) fields, kept out of GLOW_NUMBER_FIELDS so the panel can
// render them as dropdowns and the sanitizer can snap them to a legal index.
export const GLOW_ENUM_FIELDS = [
  { key: 'glowPathMode', label: 'Path', options: [[0, 'Around the shape'], [1, 'Linear sweep']] },
  {
    key: 'glowTraceThin',
    label: 'Trace',
    options: [[0, 'Filled shape'], [1, 'Thin lines / outlines']],
  },
  { key: 'glowMaskMode', label: 'Mask', options: [[0, 'Alpha (shape)'], [1, 'Luminance'], [2, 'Alpha × Luma']] },
];

// Keyframable glow params, as registered in keyframeProps.js.
export const GLOW_KF_KEYS = GLOW_NUMBER_FIELDS.filter((f) => f.kf).map((f) => f.key);

export function getRunningGlowEffect(item) {
  const list = item?.layerEffects;
  if (!Array.isArray(list)) return null;
  return list.find((effect) => effect?.id === RUNNING_GLOW_LAYER_EFFECT_ID) || null;
}

export function isRunningGlowEnabled(item) {
  const effect = getRunningGlowEffect(item);
  if (!effect || effect.enabled === false) return false;
  // An amount of 0 is an exact bypass, not a slow no-op pass.
  const amount = Number.isFinite(effect.params?.glowAmount)
    ? effect.params.glowAmount
    : GLOW_DEFAULTS.glowAmount;
  return amount > 0.01;
}

// ── PRO gating ──────────────────────────────────────────────────────────────
// Running Glow is a PRO effect, gated exactly like a PRO motion template: free
// to design and play back in the preview, paywalled at render. The check lives
// here rather than in a list of feature ids because there is nothing to keep in
// sync — the effect IS the flag. See containsProMotionTemplate in
// motionTemplates/index.js and the gate in VideoEditor's handleRenderInBackground.
export const GLOW_IS_PRO = true;

// `isRunningGlowEnabled` short-circuits a static amount of 0, but a KEYFRAMED
// amount can ramp up from a zero static field, so an animated track counts as in
// use too — otherwise a fade-in glow would render for free.
function glowGatesRender(item) {
  const effect = getRunningGlowEffect(item);
  if (!effect || effect.enabled === false) return false;
  const track = item.propertyKeyframes?.glowAmount;
  if (Array.isArray(track) && track.length > 0) return true;
  return isRunningGlowEnabled(item);
}

// Project sequences can nest other sequences, so inspect the complete saved
// editor state rather than only the currently visible timeline level.
export function containsProGlowEffect(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (glowGatesRender(value)) return true;
  if (Array.isArray(value)) return value.some((entry) => containsProGlowEffect(entry, seen));
  return Object.values(value).some((entry) => containsProGlowEffect(entry, seen));
}

// Resolve the effective parameter set for a frame: effect param ?? default, with
// keyframe tracks winning where present.
export function resolveGlowParams(item, keyframeProps) {
  const effect = getRunningGlowEffect(item);
  const params = effect?.params || {};
  const out = {};
  for (const [key, fallback] of Object.entries(GLOW_DEFAULTS)) {
    const kf = keyframeProps?.[key];
    if (Number.isFinite(kf)) { out[key] = kf; continue; }
    const raw = params[key];
    out[key] = typeof fallback === 'string'
      ? (typeof raw === 'string' && raw ? raw : fallback)
      : (Number.isFinite(raw) ? raw : fallback);
  }
  return out;
}

// ── GLSL ────────────────────────────────────────────────────────────────────
// gl_FragCoord (no varyings) so these bodies stay copy-pasteable between the
// prototype harness, the adjustment-effect registry and here.

const VERTEX = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const PRELUDE = /* glsl */ `
precision highp float;
uniform sampler2D uTexture;
uniform sampler2D uSource;
uniform vec2 uResolution;
uniform float uTime;
uniform float uMix;
uniform float uQuality;
uniform float uEdgeWidth;
uniform float uGlowRadius;
uniform float uEdgeLevel;
uniform float uGlowLevel;
uniform float uSpeed;
uniform float uCount;
uniform float uTrail;
uniform float uStaticRim;
uniform float uEdgeOffset;
uniform float uPathMode;
uniform float uAngle;
uniform float uFlicker;
uniform float uMaskMode;
uniform float uMaskThreshold;
uniform float uSourceLevel;
uniform float uCenterX;
uniform float uCenterY;
uniform float uSoftness;
uniform float uHeadGlint;
uniform float uSpread;
uniform float uTraceThin;
uniform vec3 uHeadColor;
uniform vec3 uTailColor;
uniform vec3 uGlowColor;
// Alpha of each colour, 0-1. The light is ADDITIVE, so an alpha here scales how
// much that component contributes rather than blending it — 0 removes it entirely.
uniform float uHeadAlpha;
uniform float uTailAlpha;
uniform float uGlowAlpha;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec3 unpremult(vec4 c) { return c.rgb / max(c.a, 1e-4); }
`;

// Shared between the two passes: the mask definition and the two field radii.
//
// A Gaussian-blurred step only carries usable distance information within about
// its own radius — further out the field flattens to 0 or 1 and all distance is
// lost. So each band derives its radius FROM the thickness it has to draw
// (x1.55) and from how far Edge Offset pushes it, never the other way round; the
// band width itself stays a constant in field units. Get this backwards and the
// "band" never decays, which paints the whole frame.
const SHARED = /* glsl */ `
// Band half-width in FIELD units. 0.22 keeps the tails ~1e-4 at the ends of the
// field's range, and makes the drawn thickness ~= (radius / 1.55) px.
#define GE_BW 0.22

// Content coverage. Alpha finds the contour of anything over a transparent stack
// (text, logos, shapes) whatever its colour; Luminance finds it inside opaque
// footage, where alpha is 1 everywhere and carries no shape at all.
float geMask(vec4 s) {
  float thr = clamp(uMaskThreshold / 100.0, 0.0, 0.99);
  float lum = smoothstep(thr, min(thr + 0.30, 1.0), luma(unpremult(s))) * s.a;
  if (uMaskMode > 1.5) return min(s.a, lum);
  if (uMaskMode > 0.5) return lum;
  return s.a;
}
float geScale() { return uResolution.y / 1080.0; }
float geNarrowR() { return max(max(uEdgeWidth * 1.55, abs(uEdgeOffset) * 1.35), 1.2) * geScale(); }
float geWideR()   { return max(max(uGlowRadius * 1.55, abs(uEdgeOffset) * 1.35), 4.0) * geScale(); }

// Half-tap-count for the wide field. Blurring a HARD edge with N point taps
// spanning +/-2r makes each tap cross that edge 4r/(N-1) px apart, and the field
// comes out as an N-step staircase — at a 90px radius with 33 taps that is a
// visible 12px blocky grid through the whole bloom. So the count follows the
// radius (keeping the step near 2px) instead of being a constant.
int geWideHalf() {
  return int(clamp(geWideR() * 0.55, 12.0, 48.0) * mix(0.6, 1.0, clamp(uQuality, 0.0, 1.0)));
}
`;

// Pass 1 — horizontal Gaussian of the mask at both radii.
//
// Out-of-frame taps CLAMP to the boundary pixel instead of reading 0. The
// isolate is frame-sized, so a layer pushed partly out of view by the camera is
// cut at the target boundary; zero taps made the field cross 0.5 right there
// and the contour band traced the EDGE OF THE VIEW. Clamping continues the
// clipped content outward, so the cut is invisible — and where the layer never
// touches the boundary the edge pixels are transparent and clamping reads the
// same 0 the guard did.
const PRE_FX = /* glsl */ `
vec4 fx(vec2 uv) {
  float rN = geNarrowR();
  float rW = geWideR();

  const int MAX_N = 33;
  int halfN = 16;
  float accN = 0.0, wsN = 0.0;
  for (int i = 0; i < MAX_N; i++) {
    float q = (float(i) - float(halfN)) / float(halfN);
    float w = exp(-2.0 * q * q);
    vec2 s = uv + vec2(q * 2.0 * rN / uResolution.x, 0.0);
    accN += geMask(texture2D(uTexture, clamp(s, 0.0, 1.0))) * w;
    wsN += w;
  }

  const int MAX_W = 97;
  int halfW = geWideHalf();
  float accW = 0.0, wsW = 0.0;
  // Radius 0 disables the bloom, so don't pay for its taps.
  if (uGlowRadius >= 0.5) {
    for (int i = 0; i < MAX_W; i++) {
      if (i > 2 * halfW) break;
      float q = (float(i) - float(halfW)) / float(halfW);
      float w = exp(-2.0 * q * q);
      vec2 s = uv + vec2(q * 2.0 * rW / uResolution.x, 0.0);
      accW += geMask(texture2D(uTexture, clamp(s, 0.0, 1.0))) * w;
      wsW += w;
    }
  }
  return vec4(accN / max(wsN, 1e-4), accW / max(wsW, 1e-4), 0.0, 1.0);
}

void main() {
  gl_FragColor = fx(gl_FragCoord.xy / uResolution);
}
`;

// Pass 2 — vertical completion + the edge bands, the runner and the composite.
const MAIN_FX = /* glsl */ `
${STABLE_ATAN2_GLSL}
// Gaussian band around a field level: 1 on the contour, falling off either side.
// The pedestal — what the Gaussian still reads where the field has saturated to
// 0 or 1 — is subtracted out, so far from the contour the band is exactly 0
// instead of a constant wash over the whole frame.
float geBand(float f, float c, float w) {
  float iw = 1.0 / max(w, 0.015);
  float d = (f - c) * iw;
  float raw = exp(-2.0 * d * d);
  float p0 = c * iw, p1 = (1.0 - c) * iw;
  float ped = max(exp(-2.0 * p0 * p0), exp(-2.0 * p1 * p1));
  return clamp((raw - ped) / max(1.0 - ped, 1e-3), 0.0, 1.0);
}

// The comet, as a function of the SIGNED WRAPPED phase distance from the head
// (negative = the head has gone past, positive = it has not arrived yet).
// Working in wrapped distance rather than in raw fract() is what keeps this
// continuous across the loop point: a plain pow(fract(x), k) steps from 1 to 0
// at the head, and over a wide halo that step reads as a hard slash cutting
// across the glow. Here the tail's residue at the far side is subtracted, so the
// function reaches exactly 0 half a cycle away and the loop closes.
float geComet(float w, float lenT, float lenF) {
  float v = (w < 0.0) ? exp(w / max(lenT, 1e-4))
                      : exp(-(w * w) / max(lenF * lenF, 1e-8));
  float ped = exp(-0.5 / max(lenT, 1e-4));
  return clamp((v - ped) / max(1.0 - ped, 1e-3), 0.0, 1.0);
}

vec4 fx(vec2 uv) {
  // ---- vertical half of both blurs ------------------------------------------
  float rN = geNarrowR();
  float rW = geWideR();

  const int MAX_N = 33;
  int halfN = 16;
  float accN = 0.0, wsN = 0.0;
  for (int i = 0; i < MAX_N; i++) {
    float q = (float(i) - float(halfN)) / float(halfN);
    float w = exp(-2.0 * q * q);
    vec2 s = uv + vec2(0.0, q * 2.0 * rN / uResolution.y);
    accN += texture2D(uTexture, clamp(s, 0.0, 1.0)).r * w;
    wsN += w;
  }

  const int MAX_W = 97;
  int halfW = geWideHalf();
  float accW = 0.0, wsW = 0.0;
  if (uGlowRadius >= 0.5) {
    for (int i = 0; i < MAX_W; i++) {
      if (i > 2 * halfW) break;
      float q = (float(i) - float(halfW)) / float(halfW);
      float w = exp(-2.0 * q * q);
      vec2 s = uv + vec2(0.0, q * 2.0 * rW / uResolution.y);
      accW += texture2D(uTexture, clamp(s, 0.0, 1.0)).g * w;
      wsW += w;
    }
  }
  float fN = accN / max(wsN, 1e-4);
  float fW = accW / max(wsW, 1e-4);

  // NOTE: no dither here. The intermediate target is 8-bit and the band is
  // steep, so a sub-LSB dither looks like the obvious fix for contouring — but
  // hash21 is not white noise, and a wide bloom amplifies its structure into
  // visible blocks. Plain quantisation reads better than structured noise at
  // this radius.

  // ---- the two bands --------------------------------------------------------
  // A blurred step sits at 0.5 on the contour and moves ~0.4 of a unit per
  // radius of distance, which is how Edge Offset converts from px to field
  // units. The widths are constants (see GE_BW) — thickness lives in the radii.
  float offPx = uEdgeOffset * geScale();
  float soft = mix(0.7, 1.6, clamp(uSoftness / 100.0, 0.0, 1.0));

  float cN = clamp(0.5 + 0.4 * offPx / rN, 0.06, 0.94);
  float core = geBand(fN, cN, GE_BW);

  float cW = clamp(0.5 + 0.4 * offPx / rW, 0.06, 0.94);
  float haloW = GE_BW * soft;
  float halo = geBand(fW, cW, haloW);

  // THIN mode. Everything above assumes the content is a FILLED region, whose
  // blurred mask sweeps 0 → 1 and therefore crosses 0.5 exactly on the contour.
  // Thin content breaks that assumption completely: blur a 3px outline stroke at a
  // 50px glow radius and the field peaks near 0.05, so a band centred on 0.5 finds
  // nothing at all and the effect silently disappears — and because the radii scale
  // with frame height, it can look right at 960px and vanish at 1920px.
  //
  // For a stroke the field IS the line: it peaks on the stroke and falls away, which
  // is exactly the shape a core line and a bloom want. So use the fields directly,
  // normalised by the peak a stroke of Edge Width would actually reach at each
  // radius (≈ w / 1.6r), which is what puts them back into 0..1.
  if (uTraceThin > 0.5) {
    float w = max(uEdgeWidth, 0.5) * geScale();
    float peakN = clamp(w / max(1.6 * rN, 1e-3), 0.02, 1.0);
    float peakW = clamp(w / max(1.6 * rW, 1e-3), 0.01, 1.0);
    core = clamp(fN / peakN, 0.0, 1.0);
    halo = clamp(fW / peakW, 0.0, 1.0);
    // Edge Offset can't shift a ridge the way it shifts a 0.5 crossing, so it
    // fades the inner side instead — the same "push the light outward" intent.
    if (offPx > 0.001) halo *= clamp(1.0 - core * 0.85, 0.0, 1.0);
  }

  // Glow Radius 0 means "no bloom at all", leaving just the running line. The wide
  // field's radius has a 4px floor (a Gaussian needs some support to be meaningful),
  // so without this gate a radius of 0 would still paint a tight halo and the
  // control could never actually reach off.
  if (uGlowRadius < 0.5) halo = 0.0;

  // Spread: which side of the contour the bloom is allowed to land on. Without
  // it a wide glow floods the whole interior of a filled shape.
  float bias = clamp(uSpread / 100.0, -1.0, 1.0);
  if (abs(bias) > 0.001) {
    float outward = (cW - fW) / max(haloW, 1e-3);   // + outside, - inside
    halo *= mix(1.0, smoothstep(-0.9, 0.9, outward * sign(bias)), abs(bias));
  }

  // ---- the runner -----------------------------------------------------------
  float ar = uResolution.x / uResolution.y;
  vec2 ctr = vec2(0.5 + uCenterX / 100.0, 0.5 + uCenterY / 100.0);
  vec2 p = (uv - ctr) * vec2(ar, 1.0);

  float phase;
  if (uPathMode < 0.5) {
    // Orbit: the light travels around the shape, lighting the contour it passes.
    // Polynomial, not hardware atan2 — see stableAtan2.js. Both sides must
    // change together or they compute different values by design.
    phase = veStableAtan2(p.y, p.x) / 6.2831853 + 0.5;
  } else {
    // Sweep: a straight bar of light crosses the frame at a chosen angle.
    float a = radians(uAngle);
    vec2 dir = vec2(cos(a), sin(a));
    float span = abs(dir.x) * ar + abs(dir.y);
    phase = dot(p, dir) / max(span, 1e-3) + 0.5;
  }

  float count = max(1.0, floor(uCount + 0.5));
  float x = fract(phase * count - uTime * uSpeed);
  float wrapped = x - floor(x + 0.5);                       // [-0.5, 0.5)
  if (uSpeed < 0.0) wrapped = -wrapped;                     // trail follows the head

  float trail = clamp(uTrail / 100.0, 0.0, 1.0);
  float lenT = mix(0.012, 0.34, trail);
  float lenF = mix(0.006, 0.05, trail);
  float comet = geComet(wrapped, lenT, lenF);
  // The halo runs a softer, slightly longer comet than the core: a razor head is
  // right on a 4px line and wrong across a 60px bloom.
  float cometH = geComet(wrapped, lenT * 1.3, lenF * 3.2);

  float baseLvl = clamp(uStaticRim / 100.0, 0.0, 1.0);
  float run  = baseLvl + (1.0 - baseLvl) * comet;
  float runH = baseLvl + (1.0 - baseLvl) * cometH;

  float flick = clamp(uFlicker / 100.0, 0.0, 1.0);
  if (flick > 0.001) {
    float tn = uTime * 13.0;
    float n = mix(hash21(vec2(floor(tn), 3.7)),
                  hash21(vec2(floor(tn) + 1.0, 3.7)),
                  smoothstep(0.0, 1.0, fract(tn)));
    float fmul = mix(1.0, 0.4 + 0.85 * n, flick);
    run *= fmul;
    runH *= fmul;
  }

  // ---- colour ---------------------------------------------------------------
  // Head white-hot, cooling into the trail colour behind it.
  float hotness = geComet(wrapped, lenT * 0.34, lenF * 1.6);
  vec3 lineCol = mix(uTailColor, uHeadColor, hotness);
  // The running line fades from trail to head, so its alpha has to travel with it
  // — otherwise a transparent trail would still show at full strength up front.
  float lineAlpha = mix(uTailAlpha, uHeadAlpha, hotness);
  float glint = geComet(wrapped, lenF * 1.2, lenF * 0.7)
              * clamp(uHeadGlint / 100.0, 0.0, 2.0);
  lineCol = mix(lineCol, vec3(1.0), clamp(glint, 0.0, 1.0));

  // ---- composite ------------------------------------------------------------
  vec4 base = texture2D(uSource, uv) * clamp(uSourceLevel / 100.0, 0.0, 1.0);

  // Colour alpha folds into the intensity: additive light has no "behind" to blend
  // against, so less alpha simply means less of that component. It must also come
  // off addA, or a fully transparent glow would still punch opaque pixels through.
  float coreI = core * run * max(uEdgeLevel, 0.0) * (1.0 + glint) * lineAlpha;
  float haloI = halo * runH * max(uGlowLevel, 0.0) * uGlowAlpha;

  vec3 add = lineCol * coreI + uGlowColor * haloI;
  float addA = clamp(coreI + haloI, 0.0, 1.0);
  float outA = clamp(base.a + addA, 0.0, 1.0);
  return vec4(min(base.rgb + add, vec3(outA)), outA);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 srcCol = texture2D(uSource, uv);
  vec4 fxCol = fx(uv);
  gl_FragColor = mix(srcCol, fxCol, clamp(uMix, 0.0, 1.0));
}
`;

function baseUniforms() {
  return {
    uTexture: { value: null },
    uSource: { value: null },
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uTime: { value: 0 },
    uMix: { value: 1 },
    uQuality: { value: 1 },
    uEdgeWidth: { value: GLOW_DEFAULTS.glowEdgeWidth },
    uGlowRadius: { value: GLOW_DEFAULTS.glowRadius },
    uEdgeLevel: { value: GLOW_DEFAULTS.glowEdgeLevel },
    uGlowLevel: { value: GLOW_DEFAULTS.glowLevel },
    uSpeed: { value: GLOW_DEFAULTS.glowSpeed },
    uCount: { value: GLOW_DEFAULTS.glowCount },
    uTrail: { value: GLOW_DEFAULTS.glowTrail },
    uStaticRim: { value: GLOW_DEFAULTS.glowStaticRim },
    uEdgeOffset: { value: GLOW_DEFAULTS.glowOffset },
    uPathMode: { value: GLOW_DEFAULTS.glowPathMode },
    uAngle: { value: GLOW_DEFAULTS.glowAngle },
    uFlicker: { value: GLOW_DEFAULTS.glowFlicker },
    uMaskMode: { value: GLOW_DEFAULTS.glowMaskMode },
    uMaskThreshold: { value: GLOW_DEFAULTS.glowMaskThreshold },
    uSourceLevel: { value: GLOW_DEFAULTS.glowSourceLevel },
    uCenterX: { value: GLOW_DEFAULTS.glowCenterX },
    uCenterY: { value: GLOW_DEFAULTS.glowCenterY },
    uSoftness: { value: GLOW_DEFAULTS.glowSoftness },
    uHeadGlint: { value: GLOW_DEFAULTS.glowHeadGlint },
    uSpread: { value: GLOW_DEFAULTS.glowSpread },
    uTraceThin: { value: GLOW_DEFAULTS.glowTraceThin },
    uHeadColor: { value: new THREE.Color(0xffffff) },
    uTailColor: { value: new THREE.Color(0x37d6ff) },
    uGlowColor: { value: new THREE.Color(0x1f6bff) },
    uHeadAlpha: { value: 1 },
    uTailAlpha: { value: 1 },
    uGlowAlpha: { value: 1 },
  };
}

// Both passes write straight into a cleared target (NoBlending) — the "over"
// composite back onto the stack is the caller's separate overBlit pass.
export function createRunningGlowMaterials() {
  const common = {
    vertexShader: VERTEX,
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  };
  return {
    pre: new THREE.ShaderMaterial({
      ...common,
      fragmentShader: PRELUDE + SHARED + PRE_FX,
      uniforms: baseUniforms(),
    }),
    main: new THREE.ShaderMaterial({
      ...common,
      fragmentShader: PRELUDE + SHARED + MAIN_FX,
      uniforms: baseUniforms(),
    }),
  };
}

const _tmpColor = new THREE.Color();
// THREE.Color drops alpha, so the colour and its alpha are split across two
// uniforms. `rgba()` and 8-digit hex both carry one; anything else is fully opaque.
function parseCssAlpha(css) {
  if (typeof css !== 'string') return 1;
  const s = css.trim();
  const rgba = /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/i.exec(s);
  if (rgba) return Math.min(1, Math.max(0, parseFloat(rgba[1])));
  const hex8 = /^#([0-9a-f]{8})$/i.exec(s);
  if (hex8) return parseInt(hex8[1].slice(6), 16) / 255;
  const hex4 = /^#([0-9a-f]{4})$/i.exec(s);
  if (hex4) return parseInt(hex4[1][3] + hex4[1][3], 16) / 255;
  return 1;
}

function setColor(uniform, css, alphaUniform = null) {
  try {
    // THREE.Color can't parse an 8-digit hex; hand it the RGB half.
    const rgbOnly = typeof css === 'string' && /^#([0-9a-f]{8})$/i.test(css.trim())
      ? css.trim().slice(0, 7)
      : css;
    _tmpColor.set(rgbOnly);
    uniform.value.copy(_tmpColor);
  } catch {
    uniform.value.setRGB(1, 1, 1);
  }
  if (alphaUniform) alphaUniform.value = parseCssAlpha(css);
}

// Push a resolved parameter set onto both pass materials. `quality` drops the
// wide field's tap count during interactive playback (see geWideHalf).
export function applyRunningGlowUniforms(materials, params, { width, height, time, quality = 1 }) {
  for (const mat of [materials.pre, materials.main]) {
    const u = mat.uniforms;
    u.uResolution.value.set(width, height);
    u.uTime.value = time;
    u.uQuality.value = quality;
    u.uMix.value = Math.max(0, Math.min(1, params.glowAmount / 100));
    u.uEdgeWidth.value = params.glowEdgeWidth;
    u.uGlowRadius.value = params.glowRadius;
    u.uEdgeLevel.value = params.glowEdgeLevel;
    u.uGlowLevel.value = params.glowLevel;
    u.uSpeed.value = params.glowSpeed;
    u.uCount.value = params.glowCount;
    u.uTrail.value = params.glowTrail;
    u.uStaticRim.value = params.glowStaticRim;
    u.uEdgeOffset.value = params.glowOffset;
    u.uPathMode.value = params.glowPathMode;
    u.uAngle.value = params.glowAngle;
    u.uFlicker.value = params.glowFlicker;
    u.uMaskMode.value = params.glowMaskMode;
    u.uMaskThreshold.value = params.glowMaskThreshold;
    u.uSourceLevel.value = params.glowSourceLevel;
    u.uCenterX.value = params.glowCenterX;
    u.uCenterY.value = params.glowCenterY;
    u.uSoftness.value = params.glowSoftness;
    u.uHeadGlint.value = params.glowHeadGlint;
    u.uSpread.value = params.glowSpread;
    u.uTraceThin.value = params.glowTraceThin;
    setColor(u.uHeadColor, params.glowHeadColor, u.uHeadAlpha);
    setColor(u.uTailColor, params.glowTailColor, u.uTailAlpha);
    setColor(u.uGlowColor, params.glowGlowColor, u.uGlowAlpha);
  }
}

// Margin (in canvas px, at REF_H authoring scale) the glow paints outside the
// layer's own silhouette. The per-layer render target is full-frame so nothing
// clips, but the panel uses this to warn when the bloom would reach past the
// frame edge.
export function getGlowReach(params) {
  return Math.ceil(Math.max(params.glowRadius, params.glowEdgeWidth) * 1.55 + Math.abs(params.glowOffset));
}

export { REF_H as GLOW_REFERENCE_HEIGHT };
