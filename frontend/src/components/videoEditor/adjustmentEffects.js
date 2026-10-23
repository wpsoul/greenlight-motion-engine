import * as THREE from 'three';
import { setFxBoxUniforms } from './homography';
import { validateShaderCode, mergePrelude } from '../../utils/shaderBackground';
import { isCssGradient, parseGradient } from '../../utils/cssGradient';
import { MOTION_EFFECTS } from './motionEffects';
import { ECHO_EFFECT_ID, ECHO_PARAMS } from './echoEffect';
import { TIMESHIFT_EFFECT_ID, TIMESHIFT_PARAMS } from './timeshiftEffect';
import { DOUBLE_EXPOSURE_EFFECT } from './doubleExposureEffect';
import { FILM_STOCK_EFFECT } from './filmStockEffect';
import { OBJECT_EFFECTS } from './objectEffects';
import { OBJECT_GEOMETRY_EFFECTS } from './objectGeometryEffects';
import { writeTrackSlots } from './objectTracking';
import { SHAPE_RULERS_GLSL } from './shapeRulersGlsl';
import { FAST_BLUR_EFFECT } from './fastBlurEffect';
import { RADIAL_FAST_BLUR_EFFECT } from './radialFastBlurEffect';
import { GRID_LINES_EFFECT } from './gridLinesEffect';
import { ASCII_EFFECT, getAsciiAtlas } from './asciiEffect';
import { PIXELATE_EFFECT } from './pixelateEffect';
import { POSTERIZE_EFFECT } from './posterizeEffect';
import { STRIP_EFFECT } from './stripEffect';

/*
 * Overlay Effects — the shared GPU chain for adjustment and regular layers.
 *
 * "Overlay" is the user-facing name: every effect here restyles the layers BELOW
 * the adjustment layer, as opposed to the per-layer EFFECTS panel (runningGlow.js
 * / depthParallax.js), which processes a single layer's own pixels.
 *
 * A registry of single-pass, full-screen GLSL effects that run *after* the
 * adjustment grade in the RTT compositor (Player.renderAdjustmentComposite /
 * compositeSequenceStack). Each effect samples the already-composited
 * "layers below" texture (uTexture) and writes a re-styled version; the Player
 * ping-pongs them through the same rt.a/rt.b pair the grade pass uses, so the
 * chain adds no render targets and works identically in live preview and the
 * deterministic WebCodecs export (every animated effect derives its time from
 * the playhead via uTime — never a wall clock).
 *
 * Shared fragment contract (all effects, built-in and custom):
 *   uTexture     sampler2D  layers-below composite (premultiplied colour)
 *   uResolution  vec2       ACTUAL render-target size (incl. supersample factor)
 *   uTime        float      clip-local seconds (t - clip.startTime)
 *   uProgress    float      0..1 across the clip
 *   uMix         float      per-effect intensity × keyframable master (0 = bypass)
 *   uQuality     float      1 full / 0.5 interactive preview (scales tap counts)
 *   uParams[28]  float      per-effect scalar params (by `slot`; 24–27 internal)
 *   uColor       vec3       per-effect colour (white when unused)
 *   uColors[5]   vec3[]     multi-colour effects (by `colorSlot`; white when unused)
 *
 * Alpha discipline: the RT holds PREMULTIPLIED colour. Sampling/offset effects
 * are premult-safe as-is; anything doing non-linear colour maths unpremultiplies
 * (rgb / max(a,1e-4)), operates, then re-premultiplies — otherwise transparent
 * adjustment areas get dark fringes (visible in webm-alpha exports).
 */

const MAX_EFFECTS = 4;
const PARAM_SLOTS = 28;
const COLOR_SLOTS = 5;

// Trivial pass-through — the full-screen quad is a PlaneGeometry(2,2) drawn with
// the ortho camera, so no projection maths is needed beyond the standard MVP.
// No varyings: fragments derive uv from gl_FragCoord so the exact same source
// compiles in three.js AND in the raw-WebGL validation harness (whose vertex
// shader provides no varyings).
const EFFECT_VERTEX = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Declarations + helpers shared by every built-in effect. `fx(vec2 uv)` is the
// per-effect body appended after this; the main() wrapper crossfades src↔fx by uMix.
export const EFFECT_PRELUDE = /* glsl */ `
precision highp float;
uniform sampler2D uTexture;
uniform sampler2D uSource;
uniform sampler2D uTexture1;
uniform sampler2D uTexture2;
uniform sampler2D uTexture3;
uniform sampler2D uLUT;
uniform vec2 uResolution;
uniform float uTime;
uniform float uProgress;
uniform float uMix;
uniform float uQuality;
uniform float uParams[28];
uniform vec3 uColor;
uniform vec3 uColors[5];

// ── The effect's coordinate space ───────────────────────────────────────────
// The chain always runs on a full-frame plate, so a layer effect would centre
// and phase itself on the FRAME — the effect stands still while the shape slides
// through it, which reads as a window-sized effect cut out by the shape. These
// uniforms describe the layer's own box on that plate (centre + half-axes in
// frame uv, so rotation and scale come along), and the helpers below re-express a
// fragment in it. Layer scope sets them from the layer's projected quad;
// adjustment scope leaves them at the identity, where every helper collapses to
// the frame maths the effects were authored against.
uniform vec2 uFxOrigin;   // box centre, frame uv
uniform vec2 uFxAxisX;    // half-axis along the layer's local +x, frame uv
uniform vec2 uFxAxisY;    // half-axis along the layer's local +y, frame uv
uniform mat3 uFxHom;      // fx box uv (p) -> frame uv, homogeneous (the plane's projective map)
uniform mat3 uFxHomInv;   // frame uv -> fx box uv, homogeneous
uniform vec2 uFxSizePx;   // box size in plate pixels — patterns scale with it
uniform float uFxLayer;   // 1 in layer scope, 0 when the box IS the frame

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec3 unpremult(vec4 c) { return c.rgb / max(c.a, 1e-4); }
vec4 premult(vec3 c, float a) { return vec4(c * clamp(a, 0.0, 1.0), clamp(a, 0.0, 1.0)); }
vec4 sampleClamped(sampler2D tex, vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  return texture2D(tex, uv);
}
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
vec3 hueShift(vec3 col, float a) {
  const vec3 k = vec3(0.57735);
  float c = cos(a);
  return col * c + cross(k, col) * sin(a) + k * dot(k, col) * (1.0 - c);
}

// Frame uv → the layer box's own 0..1 space. Identity when the box is the frame.
// The EXACT inverse of fxFrame, through the layer plane's projective map: the
// old per-axis projection was only right while the two projected axes were
// perpendicular, and even an exact affine inverse cannot describe the trapezoid
// a 3D tilt projects — every effect that resamples through the box (CRT Matrix,
// VHS) drew the artwork sheared, magnified and clipped on a tilted layer. For a
// flat layer the map is the affine frame and nothing changes.
vec2 fxLocal(vec2 uv) {
  // Through the layer plane's own projective map. A point past the camera plane is
  // nowhere on the layer, so it lands far outside the unit box.
  vec3 h = uFxHomInv * vec3(uv, 1.0);
  if (h.z < 1e-6) return vec2(-1e3);
  return h.xy / h.z;
}
// …and back, so a warp can displace in layer space and still sample the plate.
vec2 fxFrame(vec2 p) {
  vec3 h = uFxHom * vec3(p, 1.0);
  return h.xy / max(h.z, 1e-6);
}
// A direction/offset in layer space → the same step in frame uv (rotates with
// the layer, unlike fxFrame it carries no origin).
vec2 fxDir(vec2 v) { return (uFxAxisX * v.x + uFxAxisY * v.y) * 2.0; }
// Pixel geometry of the box. Anything authored against uResolution — grain
// cells, halftone screens, the 1080p reference — uses these so the pattern is
// printed on the layer at the layer's size instead of the frame's.
vec2 fxRes() { return uFxSizePx; }
float fxAspect() { return uFxSizePx.x / max(uFxSizePx.y, 1e-6); }
// The layer-space stand-in for gl_FragCoord — so it lands on a pixel lattice like
// the real thing. That matters beyond tidiness: in layer space the coordinate is
// RECONSTRUCTED from the box, so its last bits drift as the layer moves, and the
// effects that hash it (grain, VHS noise, Colorama's dither) would re-randomise
// on every move instead of riding the layer. The 0.25 bias keeps the rounding
// boundary off the whole and half pixels the box lands on. Frame scope keeps the
// raw value, so an adjustment layer is untouched.
vec2 fxCoord(vec2 uv) {
  vec2 c = fxLocal(uv) * uFxSizePx;
  return uFxLayer > 0.5 ? floor(c + 0.25) + 0.5 : c;
}
`;

export const EFFECT_MAIN = /* glsl */ `
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 srcCol = texture2D(uTexture, uv);
  vec4 fxCol = fx(uv);
  gl_FragColor = mix(srcCol, fxCol, clamp(uMix, 0.0, 1.0));
}
`;

// Two-pass effects (def.prePass): the pre-pass renders an intermediate into the
// scratch target — no mix, it is never shown directly — and the main pass reads
// it via uTexture while uSource holds the effect's ORIGINAL input, which is what
// the uMix bypass must fade back to (mixing to the intermediate would show the
// half-built pass at low mix).
const EFFECT_PRE_MAIN = /* glsl */ `
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  gl_FragColor = fx(uv);
}
`;

const EFFECT_MAIN_FROM_SOURCE = /* glsl */ `
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 srcCol = texture2D(uSource, uv);
  vec4 fxCol = fx(uv);
  gl_FragColor = mix(srcCol, fxCol, clamp(uMix, 0.0, 1.0));
}
`;

// Custom (Shadertoy-style) wrapper: iChannel0 = layers below, plus iResolution /
// iTime / iProgress. Same premult mix so 0% is an exact bypass.
const CUSTOM_PRELUDE = /* glsl */ `
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform float uTime;
uniform float uProgress;
uniform float uMix;
uniform float uQuality;
uniform float uParams[28];
uniform vec3 uColor;
uniform vec3 uColors[5];
uniform vec2 uFxOrigin;
uniform vec2 uFxAxisX;
uniform vec2 uFxAxisY;
uniform mat3 uFxHom;      // fx box uv (p) -> frame uv, homogeneous (the plane's projective map)
uniform mat3 uFxHomInv;   // frame uv -> fx box uv, homogeneous
uniform vec2 uFxSizePx;
uniform float uFxLayer;
#define iChannel0 uTexture
vec3 iResolution;
float iTime;
float iProgress;
// Derived from uTime/uResolution so a pasted Shadertoy shader compiles without
// edits. There is no pointer here, so iMouse is a constant zero (same as the
// shader-background path with no mouse). iChannel1..3 are deliberately absent:
// there is no second texture to bind them to.
float iTimeDelta;
float iFrameRate;
int iFrame;
vec4 iMouse;
vec4 iDate;
vec3 iChannelResolution[4];
float iChannelTime[4];
// Same layer-box helpers the built-ins use — a custom effect that wants to ride
// its layer works in fxLocal()/fxCoord() space and maps back with fxFrame().
// On an adjustment layer these are the identity.
vec2 fxLocal(vec2 uv) {
  // Through the layer plane's own projective map. A point past the camera plane is
  // nowhere on the layer, so it lands far outside the unit box.
  vec3 h = uFxHomInv * vec3(uv, 1.0);
  if (h.z < 1e-6) return vec2(-1e3);
  return h.xy / h.z;
}
vec2 fxFrame(vec2 p) {
  vec3 h = uFxHom * vec3(p, 1.0);
  return h.xy / max(h.z, 1e-6);
}
vec2 fxDir(vec2 v) { return (uFxAxisX * v.x + uFxAxisY * v.y) * 2.0; }
vec2 fxRes() { return uFxSizePx; }
float fxAspect() { return uFxSizePx.x / max(uFxSizePx.y, 1e-6); }
vec2 fxCoord(vec2 uv) {
  vec2 c = fxLocal(uv) * uFxSizePx;
  return uFxLayer > 0.5 ? floor(c + 0.25) + 0.5 : c;
}
`;

const CUSTOM_MAIN = /* glsl */ `
void main() {
  iResolution = vec3(uResolution, 1.0);
  iTime = uTime;
  iProgress = uProgress;
  iTimeDelta = 1.0 / 60.0;
  iFrameRate = 60.0;
  // Frame index from timeline time, not a render counter — scrub, play and
  // export must agree on the frame for a given timestamp.
  iFrame = int(floor(uTime * 60.0 + 1e-6));
  iMouse = vec4(0.0);
  iDate = vec4(0.0, 0.0, 0.0, uTime);
  iChannelResolution[0] = iResolution;
  iChannelResolution[1] = iResolution;
  iChannelResolution[2] = iResolution;
  iChannelResolution[3] = iResolution;
  iChannelTime[0] = uTime;
  iChannelTime[1] = uTime;
  iChannelTime[2] = uTime;
  iChannelTime[3] = uTime;
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 fragColor = texture2D(uTexture, uv);
  mainImage(fragColor, gl_FragCoord.xy);
  vec4 srcCol = texture2D(uTexture, uv);
  gl_FragColor = mix(srcCol, fragColor, clamp(uMix, 0.0, 1.0));
}
`;

// Identity tone curves — the Curves effect's registry default. Channels are
// point lists in the unit box ([x in, y out], 0..1), master (`m`) folded over
// r/g/b at bake time. Referenced from the registry literal below, so it must be
// initialised before the array evaluates.
export const DEFAULT_CURVES = {
  m: [[0, 0], [1, 1]],
  r: [[0, 0], [1, 1]],
  g: [[0, 0], [1, 1]],
  b: [[0, 0], [1, 1]],
};

/*
 * Bloom's pyramid legs, shared by its three down and three up passes. Each pass
 * renders at half its source's resolution, so one texel of the SOURCE level is
 * 1/(2·uResolution) here — the dual-filter offsets are derived from that, which
 * keeps the kernel correct at every level without a per-pass uniform. The
 * anamorphic stretch (uParams[6]) widens the lattice mildly on the smearing
 * axis; the real smear is the streak pass — the lab measured that stretching
 * the pyramid alone skips small highlights entirely.
 */
const BLOOM_DOWN_FX = /* glsl */ `
vec4 fx(vec2 uv){
  float an = clamp(uParams[6] / 100.0, -1.0, 1.0);
  vec2 stretch = vec2(1.0 + max(an, 0.0) * 1.2, 1.0 + max(-an, 0.0) * 1.2);
  vec2 h = stretch / (2.0 * uResolution);
  vec4 s = texture2D(uTexture, uv) * 4.0
    + texture2D(uTexture, uv + vec2(-h.x, -h.y)) + texture2D(uTexture, uv + vec2(h.x, -h.y))
    + texture2D(uTexture, uv + vec2(-h.x,  h.y)) + texture2D(uTexture, uv + vec2(h.x,  h.y));
  return s / 8.0;
}
`;

// Tent-filter the coarser level (uTexture1, at half this pass's res) and add it,
// weighted by uParams[24] — the runner's `set` writes Radius's per-octave gate
// there — onto this level's own down texture (uTexture).
const BLOOM_UP_FX = /* glsl */ `
vec4 fx(vec2 uv){
  float an = clamp(uParams[6] / 100.0, -1.0, 1.0);
  vec2 stretch = vec2(1.0 + max(an, 0.0) * 1.2, 1.0 + max(-an, 0.0) * 1.2);
  vec2 h = stretch * 2.0 / uResolution;
  vec4 s = texture2D(uTexture1, uv + vec2(-h.x * 2.0, 0.0)) + texture2D(uTexture1, uv + vec2(h.x * 2.0, 0.0))
    + texture2D(uTexture1, uv + vec2(0.0, -h.y * 2.0)) + texture2D(uTexture1, uv + vec2(0.0, h.y * 2.0))
    + 2.0 * (texture2D(uTexture1, uv + vec2(-h.x, h.y)) + texture2D(uTexture1, uv + vec2(h.x, h.y))
           + texture2D(uTexture1, uv + vec2(-h.x, -h.y)) + texture2D(uTexture1, uv + vec2(h.x, -h.y)));
  return texture2D(uTexture, uv) + (s / 12.0) * uParams[24];
}
`;

// Bloom's pass gates (see the `passes` comment on the descriptor). Params here
// are the resolved ones (keyframed values already merged by the Player).
const bloomOff = (p) => !(Number(p.intensity) > 0);
const bloomDepth = (p) => Math.max(1, Math.min(4, Number.isFinite(Number(p.radius)) ? Number(p.radius) : 3));
const bloomStreakLive = (p) => Math.abs(Number(p.anamorphic) || 0) >= 1;

// ── Copy Color Profile (html/copy-color-profile.html) ───────────────────────
// Colour spaces + the 16-bit packing shared by its stats and main passes.
// space: 0 = Oklab, 1 = YCbCr (BT.709 on the gamma-encoded signal), 2 = sRGB as is.
// Channel 0 is always the brightness axis, 1..2 the chroma axes (RGB: all colour).
const CCP_LIB = /* glsl */ `
vec3 ccpSrgbToLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 ccpLinToSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 ccpLinToOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  l = pow(max(l, 0.0), 1.0 / 3.0); m = pow(max(m, 0.0), 1.0 / 3.0); s = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
              1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
              0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
vec3 ccpOklabToLin(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3( 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
              -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
              -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
vec3 ccpToSpace(vec3 c, float space) {
  if (space < 0.5) return ccpLinToOklab(ccpSrgbToLin(c));
  if (space < 1.5) { float y = luma(c); return vec3(y, (c.b - y) / 1.8556, (c.r - y) / 1.5748); }
  return c;
}
vec3 ccpFromSpace(vec3 c, float space) {
  if (space < 0.5) return ccpLinToSrgb(ccpOklabToLin(c));
  if (space < 1.5) { float r = c.x + 1.5748 * c.z; float b = c.x + 1.8556 * c.y; float g = (c.x - 0.2126 * r - 0.0722 * b) / 0.7152; return vec3(r, g, b); }
  return c;
}
// 16-bit in two RGBA8 channels (hi, lo). Values are stored as (v + 1) / 2 so
// chroma axes centred on 0 and spreads both fit.
vec2 ccpEnc16(float v) { float q = clamp(v, 0.0, 1.0) * 65535.0; float hi = floor(q / 256.0); float lo = floor(q - hi * 256.0 + 0.5); return vec2(hi, lo) / 255.0; }
float ccpDec16(vec2 e) { return (floor(e.x * 255.0 + 0.5) * 256.0 + floor(e.y * 255.0 + 0.5)) / 65535.0; }
vec2 ccpEncS(float v) { return ccpEnc16(v * 0.5 + 0.5); }
float ccpDecS(vec2 e) { return ccpDec16(e) * 2.0 - 1.0; }
`;

// Stats pass → a 4×1 target. Each texel walks an N×N grid over the plate's
// region (uParams[24..27], frame uv), alpha-weighted, and packs two values:
//   px0 = mean.x, mean.y   px1 = mean.z, sd.x   px2 = sd.y, sd.z   px3 = coverage
const CCP_STATS_FX = /* glsl */ `
vec4 fx(vec2 uv) {
  int idx = int(floor(gl_FragCoord.x));
  float space = uParams[0];
  float n = max(uParams[1], 2.0);
  if (uQuality < 0.75) n = min(n, 32.0);
  vec2 r0 = vec2(uParams[24], uParams[25]);
  vec2 r1 = vec2(uParams[26], uParams[27]);
  vec3 s1 = vec3(0.0);
  vec3 s2 = vec3(0.0);
  float sw = 0.0;
  for (int j = 0; j < 64; j++) {
    if (float(j) >= n) break;
    for (int i = 0; i < 64; i++) {
      if (float(i) >= n) break;
      vec2 q = mix(r0, r1, (vec2(float(i), float(j)) + 0.5) / n);
      vec4 p = texture2D(uTexture, q);
      float w = p.a;
      if (w < 0.002) continue;
      vec3 c = ccpToSpace(clamp(p.rgb / w, 0.0, 1.0), space);
      s1 += c * w;
      s2 += c * c * w;
      sw += w;
    }
  }
  float inv = 1.0 / max(sw, 1e-5);
  vec3 mean = s1 * inv;
  vec3 sd = sqrt(max(s2 * inv - mean * mean, 0.0));
  float cov = sw / max(n * n, 1.0);
  vec2 a; vec2 b;
  if (idx == 0)      { a = ccpEncS(mean.x); b = ccpEncS(mean.y); }
  else if (idx == 1) { a = ccpEncS(mean.z); b = ccpEncS(sd.x); }
  else if (idx == 2) { a = ccpEncS(sd.y);   b = ccpEncS(sd.z); }
  else               { a = ccpEnc16(cov);   b = ccpEnc16(0.0); }
  return vec4(a, b);
}
`;

// Main pass. uTexture = this content, uTexture1 = reference stats, uTexture2 =
// its own stats. Statistics = Reinhard-style mean/std transfer (contrast is the
// exponent on the spread gain, clamped by Max Gain); Ratio = grey-world multiply.
const CCP_MAIN_FX = /* glsl */ `
void ccpReadStats(sampler2D t, out vec3 mean, out vec3 sd, out float cov) {
  vec4 p0 = texture2D(t, vec2(0.125, 0.5));
  vec4 p1 = texture2D(t, vec2(0.375, 0.5));
  vec4 p2 = texture2D(t, vec2(0.625, 0.5));
  vec4 p3 = texture2D(t, vec2(0.875, 0.5));
  mean = vec3(ccpDecS(p0.rg), ccpDecS(p0.ba), ccpDecS(p1.rg));
  sd = vec3(ccpDecS(p1.ba), ccpDecS(p2.rg), ccpDecS(p2.ba));
  cov = ccpDec16(p3.rg);
}
vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  if (src.a < 0.002) return src;
  float space = uParams[0];
  float transfer = uParams[2];
  float lumAmt = uParams[3] / 100.0;
  float colAmt = uParams[4] / 100.0;
  float contrast = uParams[5] / 100.0;
  float sat = uParams[6] / 100.0;
  float maxGain = max(uParams[7], 1.0);
  float protHi = uParams[8] / 100.0;
  float protLo = uParams[9] / 100.0;
  vec3 mR; vec3 sR; float cR;
  vec3 mS; vec3 sS; float cS;
  ccpReadStats(uTexture1, mR, sR, cR);
  ccpReadStats(uTexture2, mS, sS, cS);
  if (cR < 1e-4 || cS < 1e-4) return src;   // nothing sampled on either side = exact bypass
  vec3 rgb = clamp(unpremult(src), 0.0, 1.0);
  vec3 c = ccpToSpace(rgb, space);
  bool isRgb = space > 1.5;
  vec3 o;
  if (transfer < 0.5) {
    vec3 gain = clamp(sR / max(sS, 1e-3), vec3(1.0 / maxGain), vec3(maxGain));
    gain = pow(gain, vec3(contrast));
    o = (c - mS) * gain + mR;
  } else {
    vec3 ratio = clamp(mR / max(mS, vec3(1e-3)), vec3(1.0 / maxGain), vec3(maxGain));
    o = isRgb ? c * ratio : vec3(c.x * ratio.x, c.yz + (mR.yz - mS.yz));
  }
  vec3 amt = isRgb ? vec3(colAmt) : vec3(lumAmt, colAmt, colAmt);
  o = mix(c, o, amt);
  if (!isRgb) o.yz *= (1.0 + sat);
  vec3 outRgb = ccpFromSpace(o, space);
  if (isRgb) {
    float yo = luma(outRgb);
    outRgb = mix(vec3(yo), outRgb, 1.0 + sat);
    outRgb *= mix(luma(rgb) / max(yo, 1e-3), 1.0, lumAmt);
  }
  outRgb = clamp(outRgb, 0.0, 1.0);
  float y = luma(rgb);
  float keep = 1.0 - protHi * smoothstep(0.7, 1.0, y) - protLo * (1.0 - smoothstep(0.0, 0.25, y));
  outRgb = mix(rgb, outRgb, clamp(keep, 0.0, 1.0));
  return premult(outRgb, src.a);
}
`;

// ── Effect registry ─────────────────────────────────────────────────────────
// Each param: { key, slot?, label, min, max, step, default, suffix?, type?, options? }
//   - slot: index into uParams[] the fragment reads (float params only)
//   - type: 'color' → routed to uColor, or to uColors[colorSlot] when `colorSlot`
//     is set (multi-stop effects); 'select' → rendered as a dropdown
export const ADJUSTMENT_EFFECTS = [
  // ── Glow ──────────────────────────────────────────────────────────────────
  {
    id: 'glow',
    name: 'Glow',
    group: 'Glow',
    animated: false,
    params: [
      { key: 'intensity', slot: 0, label: 'Intensity', min: 0, max: 3, step: 0.05, default: 1.1 },
      { key: 'threshold', slot: 1, label: 'Threshold', min: 0, max: 1, step: 0.01, default: 0.55 },
      { key: 'radius', slot: 2, label: 'Radius', min: 1, max: 80, step: 1, default: 26, suffix: 'px' },
      { key: 'color', type: 'color', label: 'Color', default: '#ffffff' },
    ],
    // True separable Gaussian bloom. The old single-pass spiral sampled only
    // 18–48 isolated points across the disc, which made wide glows visibly
    // different from the reference and changed between preview qualities.
    // Radius is authored at the prototypes' 1080px reference height.
    prePass: /* glsl */ `
vec4 fx(vec2 uv) {
  float radius = max(uParams[2], 0.5) * (uResolution.y / 1080.0);
  float thr = clamp(uParams[1], 0.0, 0.999);
  const int MAX_TAPS = 49;
  int half_ = 24;
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i < MAX_TAPS; i++) {
    if (i > 2 * half_) break;
    float t = (float(i) - float(half_)) / float(half_);
    float w = exp(-2.0 * t * t);
    vec2 suv = uv + vec2(t * 2.0 * radius / uResolution.x, 0.0);
    vec4 s = (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0)
      ? vec4(0.0)
      : texture2D(uTexture, suv);
    vec3 straight = unpremult(s);
    float bright = max(0.0, luma(straight) - thr) / max(1.0 - thr, 1e-3);
    vec3 premultBright = straight * bright * s.a;
    acc += vec4(premultBright, bright * s.a) * w;
    ws += w;
  }
  return acc / max(ws, 1e-4);
}
`,
    fragment: /* glsl */ `
vec4 fx(vec2 uv) {
  float radius = max(uParams[2], 0.5) * (uResolution.y / 1080.0);
  const int MAX_TAPS = 49;
  int half_ = 24;
  vec4 bloom = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i < MAX_TAPS; i++) {
    if (i > 2 * half_) break;
    float t = (float(i) - float(half_)) / float(half_);
    float w = exp(-2.0 * t * t);
    vec2 suv = uv + vec2(0.0, t * 2.0 * radius / uResolution.y);
    vec4 s = (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0)
      ? vec4(0.0)
      : texture2D(uTexture, suv);
    bloom += s * w;
    ws += w;
  }
  bloom /= max(ws, 1e-4);

  vec4 base = texture2D(uSource, uv);
  vec3 glow = bloom.rgb * uParams[0] * uColor;
  vec3 outPre = base.rgb + glow;
  float outA = clamp(base.a + bloom.a * uParams[0], 0.0, 1.0);
  return vec4(min(outPre, vec3(outA)), outA);
}
`,
  },

  // ── Bloom ─────────────────────────────────────────────────────────────────
  // Ported from html/bloom-lab.html (minus its star-streaks mode). Bloom here is
  // never blur(bright): the soft-knee bright pass is folded down a dual-filter
  // octave pyramid (down1..3 at 1/4, 1/8, 1/16 of the frame) and folded back up
  // with tent taps, so Radius is CHAIN DEPTH in octaves, not a kernel size — a
  // 2px highlight and a 200px halo cost the same and the falloff is the physical
  // one. Anamorphic is the lab's settled recipe: a 2-arm jittered march along
  // the lens axis over the first octave, on top of a mildly (≤1.2×) stretched
  // pyramid — stretching the lattice alone was measured to skip small lights.
  {
    id: 'bloom',
    name: 'Bloom',
    group: 'Glow',
    animated: false,
    layerMatte: 'expand',
    params: [
      { key: 'threshold', slot: 0, label: 'Threshold', min: 0, max: 1, step: 0.005, default: 0.62 },
      { key: 'knee', slot: 1, label: 'Soft Knee', min: 0.01, max: 1, step: 0.01, default: 0.5 },
      { key: 'intensity', slot: 2, label: 'Intensity', min: 0, max: 600, step: 1, default: 100, suffix: '%' },
      { key: 'radius', slot: 3, label: 'Radius', min: 1, max: 4, step: 0.1, default: 3 },
      { key: 'saturation', slot: 4, label: 'Saturation', min: 0, max: 200, step: 1, default: 100, suffix: '%' },
      { key: 'tint', type: 'color', label: 'Tint', default: '#ffffff' },
      { key: 'tintAmount', slot: 5, label: 'Tint Amount', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'anamorphic', slot: 6, label: 'Anamorphic', min: -100, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'blend', slot: 7, label: 'Blend', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Add' },
          { value: 1, label: 'Screen' },
          { value: 2, label: 'Lighten' },
          { value: 3, label: 'Color Dodge' },
          { value: 4, label: 'Bloom Only' },
        ] },
    ],
    colorPresets: [
      { name: 'Soft Glow', colors: ['#ffffff'], params: { threshold: 0.62, knee: 0.5, intensity: 100, radius: 3, saturation: 100, tintAmount: 0, anamorphic: 0, blend: 0 } },
      { name: 'Dreamy Haze', colors: ['#ffffff'], params: { threshold: 0.28, knee: 0.8, intensity: 62, radius: 4, saturation: 80, tintAmount: 0, anamorphic: 0, blend: 1 } },
      { name: 'Anamorphic Blue', colors: ['#6fa8ff'], params: { threshold: 0.7, knee: 0.35, intensity: 170, radius: 3.2, saturation: 100, tintAmount: 60, anamorphic: 72, blend: 0 } },
      { name: 'Furnace', colors: ['#ff9a3d'], params: { threshold: 0.5, knee: 0.6, intensity: 200, radius: 3.5, saturation: 100, tintAmount: 45, anamorphic: 0, blend: 0 } },
    ],
    // ZERO COST FOR WHAT IS NOT USED (user audit, 2026-09-11):
    //  * Intensity 0 skips every pass — the main pass reads `source` as the
    //    pyramid and multiplies it by gain 0, which every blend mode maps to
    //    identity (Bloom Only to transparent, exactly as the live pyramid does).
    //  * Radius gates the DEPTH: a level whose per-octave gate is 0 contributes
    //    `uTexture + tent·0`, i.e. an exact copy of the finer level, so those
    //    down/up legs are skipped and their targets alias the finer level. The
    //    streak keeps down1 alive at Radius ≤ 1 because it marches over bB.
    //  Measured byte-identical against the un-skipped chain (tests/bloom-skip).
    passes: [
      // Soft-knee bright pass (Jimenez curve), premultiplied by its own energy so
      // transparent areas stay dark. Half res — the pyramid never needs more.
      { key: 'bright', target: 'bA', scale: 0.5, inputs: { uTexture: 'source' }, skipIf: bloomOff, alias: 'source', fragment: /* glsl */ `
vec4 fx(vec2 uv){
  vec4 s = texture2D(uTexture, uv);
  vec3 straight = unpremult(s);
  float br = max(straight.r, max(straight.g, straight.b));
  float thr = clamp(uParams[0], 0.0, 0.99);
  float knee = max(thr * clamp(uParams[1], 0.01, 1.0), 1e-4);
  float soft = clamp(br - thr + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float w = max(max(soft, br - thr) / max(br, 1e-4), 0.0);
  return vec4(straight * w * s.a, w * s.a);
}
` },
      { key: 'down1', target: 'bB', scale: 0.25, inputs: { uTexture: 'bA' }, fragment: BLOOM_DOWN_FX,
        skipIf: (p) => bloomOff(p) || (bloomDepth(p) <= 1 && !bloomStreakLive(p)), alias: 'bA' },
      { key: 'down2', target: 'bC', scale: 0.125, inputs: { uTexture: 'bB' }, fragment: BLOOM_DOWN_FX,
        skipIf: (p) => bloomOff(p) || bloomDepth(p) <= 2, alias: 'bB' },
      { key: 'down3', target: 'bD', scale: 0.0625, inputs: { uTexture: 'bC' }, fragment: BLOOM_DOWN_FX,
        skipIf: (p) => bloomOff(p) || bloomDepth(p) <= 3, alias: 'bC' },
      // Walk back up: each level = its own down texture + the tent-filtered level
      // below, the deeper contribution gated by Radius (fractional at the tip, so
      // the slider morphs continuously instead of stepping an octave at a time).
      { key: 'up2', target: 'bE', scale: 0.125, inputs: { uTexture: 'bC', uTexture1: 'bD' }, fragment: BLOOM_UP_FX,
        skipIf: (p) => bloomOff(p) || bloomDepth(p) <= 3, alias: 'bC',
        set: (p) => ({ 24: Math.max(0, Math.min(1, (p.radius ?? 3) - 3)) }) },
      { key: 'up1', target: 'bF', scale: 0.25, inputs: { uTexture: 'bB', uTexture1: 'bE' }, fragment: BLOOM_UP_FX,
        skipIf: (p) => bloomOff(p) || bloomDepth(p) <= 2, alias: 'bB',
        set: (p) => ({ 24: Math.max(0, Math.min(1, (p.radius ?? 3) - 2)) }) },
      { key: 'up0', target: 'bG', scale: 0.5, inputs: { uTexture: 'bA', uTexture1: 'bF' }, fragment: BLOOM_UP_FX,
        skipIf: (p) => bloomOff(p) || bloomDepth(p) <= 1, alias: 'bA',
        set: (p) => ({ 24: Math.max(0, Math.min(1, (p.radius ?? 3) - 1)) }) },
      // The anamorphic march: 2 arms along the lens axis over the first octave,
      // start jittered per pixel so 20 taps read as a smear, not a dotted trail.
      { key: 'streak', target: 'bH', scale: 0.25, inputs: { uTexture: 'bB' },
        skipIf: (p) => bloomOff(p) || !bloomStreakLive(p), alias: 'bB', fragment: /* glsl */ `
vec4 fx(vec2 uv){
  float an = clamp(uParams[6] / 100.0, -1.0, 1.0);
  vec2 dir = an >= 0.0 ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  float len = 0.10 + abs(an) * 0.35;
  float jit = hash21(gl_FragCoord.xy) - 0.5;
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int arm = 0; arm < 2; arm++){
    vec2 d = arm == 0 ? dir : -dir;
    float w = 1.0;
    for (int s = 1; s <= 20; s++){
      w *= 0.93;
      acc += sampleClamped(uTexture, uv + d * len * ((float(s) + jit) / 20.0)) * w;
      ws += w;
    }
  }
  return acc / max(ws, 1.0) * 2.0;
}
` },
      { key: 'main', target: 'out', main: true, inputs: { uTexture1: 'bG', uTexture2: 'bH' }, fragment: /* glsl */ `
vec4 fx(vec2 uv){
  vec4 src = texture2D(uSource, uv);
  float radius = clamp(uParams[3], 1.0, 4.0);
  float norm = 1.0 + clamp(radius - 1.0, 0.0, 1.0) + clamp(radius - 2.0, 0.0, 1.0) + clamp(radius - 3.0, 0.0, 1.0);
  vec4 bl = texture2D(uTexture1, uv) / norm;
  float an = clamp(uParams[6] / 100.0, -1.0, 1.0);
  bl += texture2D(uTexture2, uv) * step(0.01, abs(an)) * abs(an) * 1.2;
  float gain = uParams[2] / 100.0;
  vec3 b = bl.rgb * gain;
  float l = luma(b);
  b = max(mix(vec3(l), b, uParams[4] / 100.0), 0.0);
  b = mix(b, vec3(l) * uColor * 1.6, clamp(uParams[5] / 100.0, 0.0, 1.0));
  float outA = clamp(src.a + clamp(bl.a * gain, 0.0, 1.0), 0.0, 1.0);
  // Every mode is identity at zero bloom, and hands transparent pixels the raw
  // glow so the halo outside a layer's edge survives (Dodge falls back to Add
  // there — premult rgb is 0 where alpha is, and 0/(1-b) would eat the halo).
  float bm = uParams[7];
  vec3 col;
  if (bm < 0.5) col = src.rgb + b;
  else if (bm < 1.5) col = src.rgb + b * (1.0 - src.rgb);
  else if (bm < 2.5) col = max(src.rgb, b);
  else if (bm < 3.5) {
    vec3 dodge = min(src.rgb / max(vec3(1.0) - min(b, vec3(0.96)), vec3(0.04)), vec3(1.0));
    col = mix(src.rgb + b, dodge, src.a);
  } else {
    col = b;
    outA = clamp(bl.a * gain, 0.0, 1.0);
  }
  return vec4(min(col, vec3(outA)), outA);
}
` },
    ],
  },

  // ── Aura Blur ─────────────────────────────────────────────────────────────
  {
    id: 'auraBlur',
    name: 'Aura Blur',
    group: 'Glow',
    animated: true,
    pyramid: true,
    params: [
      { key: 'blurSize', slot: 0, label: 'Blur Size', min: 20, max: 220, step: 5, default: 60, suffix: 'px' },
      { key: 'blurBase', slot: 1, label: 'Base Blur', min: 0, max: 100, step: 2, default: 46, suffix: '%' },
      { key: 'blurVary', slot: 2, label: 'Unevenness', min: 0, max: 100, step: 2, default: 48, suffix: '%' },
      { key: 'varyScale', slot: 3, label: 'Patch Scale', min: 0.5, max: 6, step: 0.1, default: 6 },
      { key: 'flowSpeed', slot: 4, label: 'Flow Speed', min: 0, max: 2, step: 0.05, default: 0.35, suffix: 'x' },
      { key: 'coreSoft', legacyKey: 'melt', slot: 5, label: 'Core Melt', min: 0, max: 100, step: 2, default: 100, suffix: '%' },
      { key: 'chroma', slot: 6, label: 'Dispersion', min: 0, max: 100, step: 2, default: 41, suffix: '%' },
      { key: 'haloLevel', slot: 7, label: 'Halo Level', min: 0, max: 250, step: 5, default: 130, suffix: '%' },
      { key: 'microShift', slot: 8, label: 'RGB Shift', min: 0, max: 100, step: 2, default: 30, suffix: '%' },
      { key: 'breathe', slot: 9, label: 'Breathing', min: 0, max: 60, step: 2, default: 6, suffix: '%' },
      { key: 'breatheRate', slot: 10, label: 'Breath Rate', min: 0, max: 2, step: 0.05, default: 0.4, suffix: 'Hz' },
      { key: 'coreLevel', slot: 11, label: 'Core Level', min: 0, max: 200, step: 5, default: 115, suffix: '%' },
      { key: 'gradientLeft', slot: 12, label: 'Gradient Left', min: 0, max: 100, step: 1, default: 16, suffix: '%' },
      { key: 'gradientRight', slot: 13, label: 'Gradient Right', min: 0, max: 100, step: 1, default: 94, suffix: '%' },
      { key: 'sourceMode', slot: 14, label: 'Source Mask', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Auto / luminance' },
          { value: 1, label: 'Alpha' },
          { value: 2, label: 'Luminance' },
        ] },
      { key: 'sourceThreshold', slot: 15, label: 'Mask Threshold', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'colorL', type: 'color', colorSlot: 0, label: 'Core Left', default: '#d9c7dd' },
      { key: 'colorM', type: 'color', colorSlot: 1, label: 'Core Middle', default: '#d9c7dd' },
      { key: 'colorR', type: 'color', colorSlot: 2, label: 'Core Right', default: '#d9c7dd' },
      { key: 'haloInner', type: 'color', colorSlot: 3, label: 'Halo Inner', default: '#f19be0' },
      { key: 'haloOuter', type: 'color', colorSlot: 4, label: 'Halo Outer', default: '#3d5ef5' },
    ],
    colorPresets: [
      {
        name: 'Aura',
        colors: ['#d9c7dd', '#d9c7dd', '#d9c7dd', '#f19be0', '#3d5ef5'],
        params: {
          blurSize: 60, blurBase: 46, blurVary: 48, varyScale: 6, flowSpeed: 0.35,
          coreSoft: 100, chroma: 41, microShift: 30, haloLevel: 130, breathe: 6,
          breatheRate: 0.4, coreLevel: 115, gradientLeft: 16, gradientRight: 94,
          sourceThreshold: 0,
        },
      },
      {
        name: 'Flow',
        colors: ['#ffe9c9', '#ff9bd5', '#ff7a3c', '#c65cff', '#7a1fd0'],
        params: {
          blurSize: 110, blurBase: 22, blurVary: 75, varyScale: 1.6, flowSpeed: 0.5,
          coreSoft: 85, chroma: 45, microShift: 20, haloLevel: 95, coreLevel: 100,
        },
      },
      { name: 'Ember', colors: ['#fff0d8', '#ffc07a', '#ff765c', '#ffb46e', '#ff3b6b'] },
      { name: 'Ice', colors: ['#f2fbff', '#d7e8ff', '#b9c7ff', '#bfefff', '#3b6bff'] },
    ],
    // Exact four-level blur-pyramid contract from html/aura-blur-text.html.
    // Player renders this separable Gaussian pass three times at radii
    // [0.14, 0.40, 1.00] × Blur Size and binds the results to uTexture1..3.
    pyramidPass: /* glsl */ `
float abMask(vec4 s) {
  float mode = uParams[14];
  if (mode > 0.5 && mode < 1.5) return s.a;
  float threshold = clamp(uParams[15] / 100.0, 0.0, 0.99);
  float lumMask = smoothstep(threshold, 1.0, luma(unpremult(s))) * s.a;
  if (mode > 1.5) return lumMask;
  return min(s.a, lumMask);
}

vec4 fx(vec2 uv) {
  float radius = max(uParams[24], 0.0);
  float vertical = uParams[25];
  float extractMask = uParams[26];
  const int MAX_TAPS = 49;
  int half_ = 24;
  float acc = 0.0;
  float ws = 0.0;
  for (int i = 0; i < MAX_TAPS; i++) {
    if (i > 2 * half_) break;
    float t = (float(i) - float(half_)) / float(half_);
    float w = exp(-2.0 * t * t);
    vec2 off = vertical > 0.5
      ? vec2(0.0, t * 2.0 * radius / uResolution.y)
      : vec2(t * 2.0 * radius / uResolution.x, 0.0);
    vec2 suv = uv + off;
    vec4 s = (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0)
      ? vec4(0.0)
      : texture2D(uTexture, suv);
    float mask = extractMask > 0.5 ? abMask(s) : s.a;
    acc += mask * w;
    ws += w;
  }
  float a = acc / max(ws, 1e-4);
  return vec4(a);
}
`,
    fragment: /* glsl */ `
float abNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float abFbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { v += a * abNoise(p); p *= 2.03; a *= 0.5; }
  return v;
}

float abMask(vec4 s) {
  float mode = uParams[14];
  if (mode > 0.5 && mode < 1.5) return s.a;
  float threshold = clamp(uParams[15] / 100.0, 0.0, 0.99);
  float lumMask = smoothstep(threshold, 1.0, luma(unpremult(s))) * s.a;
  if (mode > 1.5) return lumMask;
  return min(s.a, lumMask);
}

float abLevel(vec2 uv, float k) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  float level = clamp(k, 0.0, 1.0) * 3.0;
  float a = 0.0;
  a += abMask(texture2D(uSource, uv)) * max(0.0, 1.0 - abs(level));
  a += texture2D(uTexture1, uv).a * max(0.0, 1.0 - abs(level - 1.0));
  a += texture2D(uTexture2, uv).a * max(0.0, 1.0 - abs(level - 2.0));
  a += texture2D(uTexture3, uv).a * max(0.0, 1.0 - abs(level - 3.0));
  return a;
}

vec4 fx(vec2 uv) {
  float t = uTime;
  // The unevenness field and the core gradient below are read in the layer's own
  // box, so the aura's patchwork and its left→right ramp travel with the artwork.
  vec2 lp = fxLocal(uv);
  float aspect = fxAspect();
  vec2 pos = vec2(lp.x * aspect, lp.y);
  float n = abFbm(vec2(
    pos.x * max(uParams[3], 0.2) - t * uParams[4],
    pos.y * max(uParams[3], 0.2) * 0.35 + 3.7
  ));
  float k = uParams[1] / 100.0
          + (n - 0.5) * 2.0 * (uParams[2] / 100.0)
          + sin(t * uParams[10] * 6.2831853) * (uParams[9] / 100.0) * 0.5;
  k = clamp(k, 0.0, 1.0);

  float ca = clamp(uParams[6] / 100.0, 0.0, 1.0);
  float kR = clamp(k * (1.0 - 0.35 * ca), 0.0, 1.0);
  float kG = k;
  float kB = clamp(k * (1.0 + 0.70 * ca) + 0.04 * ca, 0.0, 1.0);
  vec2 shift = vec2((uParams[8] / 100.0) * 0.004, 0.0) * k;
  vec3 aura = vec3(
    abLevel(uv + shift, kR),
    abLevel(uv, kG),
    abLevel(uv - shift, kB)
  );

  float core = abLevel(uv, k * clamp(uParams[5] / 100.0, 0.0, 1.0));
  core = smoothstep(0.12, 0.85, core);

  float left = uParams[12] / 100.0;
  float right = max(left + 0.001, uParams[13] / 100.0);
  float gx = clamp((lp.x - left) / (right - left), 0.0, 1.0);
  vec3 coreColor = gx < 0.5
    ? mix(uColors[0], uColors[1], gx * 2.0)
    : mix(uColors[1], uColors[2], (gx - 0.5) * 2.0);

  vec3 haloField = aura * (1.0 - core);
  vec3 haloTint = mix(uColors[4], uColors[3], smoothstep(0.06, 0.55, aura.g));
  vec3 color = coreColor * core * (uParams[11] / 100.0)
             + haloTint * haloField * (uParams[7] / 100.0);
  color = min(color, vec3(1.0));
  float alpha = clamp(max(color.r, max(color.g, color.b)), 0.0, 1.0);
  return vec4(color, alpha);
}
`,
  },

  // ── Gradient ──────────────────────────────────────────────────────────────
  {
    id: 'gradientBeam',
    name: 'Gradient Motion Beam',
    group: 'Gradient',
    animated: true,
    params: [
      { key: 'color1', type: 'color', colorSlot: 0, label: 'Color 1', default: '#ffc93f' },
      { key: 'color2', type: 'color', colorSlot: 1, label: 'Color 2', default: '#2fd07a' },
      { key: 'color3', type: 'color', colorSlot: 2, label: 'Color 3', default: '#3f7bff' },
      { key: 'type', slot: 8, label: 'Type', type: 'select', default: 0, primary: true,
        options: [
          { value: 0, label: 'Directional' },
          { value: 1, label: 'From Center' },
        ] },
      { key: 'blend', slot: 6, label: 'Blend Mode', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Screen' },
          { value: 1, label: 'Add' },
          { value: 2, label: 'Lighten' },
          { value: 3, label: 'Soft Light' },
          { value: 4, label: 'Normal' },
        ] },
      { key: 'speed', slot: 0, label: 'Speed', min: 0.2, max: 10, step: 0.05, default: 1, suffix: 'x' },
      { key: 'angle', slot: 1, label: 'Direction', min: 0, max: 360, step: 1, default: 32, suffix: '°',
        showIf: { key: 'type', equals: 0 } },
      { key: 'blur', slot: 2, label: 'Blur', min: 0, max: 100, step: 1, default: 62, suffix: '%' },
      { key: 'width', slot: 3, label: 'Width', min: 5, max: 140, step: 1, default: 48, suffix: '%' },
      { key: 'hold', slot: 4, label: 'Hold', min: 0, max: 6, step: 0.1, default: 1.4, suffix: 's' },
      { key: 'opacity', slot: 5, label: 'Intensity', min: 0, max: 100, step: 1, default: 75, suffix: '%' },
      { key: 'frost', slot: 7, label: 'Frost', min: 0, max: 60, step: 1, default: 0, suffix: 'px' },
      // Show the original layer outside the beam. 100 = the layer stays as it is
      // (every project saved before this shipped); 0 = the beam IS the mask — the
      // layer is only visible where the beam passes, so a sweep reveals it.
      // `tail: true` seats it under Mix at the bottom of the card.
      { key: 'layerMask', slot: 9, label: 'Mask Original Layer', min: 0, max: 100, step: 1, default: 100, suffix: '%', tail: true },
    ],
    // Palette shortcuts. Purely a panel convenience — clicking one writes the
    // colour params, nothing extra is persisted. Positional: colors[i] maps to
    // the i-th `type:'color'` param in registry order.
    colorPresets: [
      { name: 'Studio', colors: ['#ffc93f', '#2fd07a', '#3f7bff'] },
      { name: 'Aurora', colors: ['#4affd4', '#3f7bff', '#b95cff'] },
      { name: 'Sunset', colors: ['#ffd36e', '#ff6f61', '#a83fd6'] },
      { name: 'Ember', colors: ['#fff0b3', '#ff9d2e', '#e0344f'] },
      { name: 'Ice', colors: ['#e8fbff', '#7fd9ff', '#3b6bff'] },
      { name: 'Mono', colors: ['#ffffff', '#cfd6de', '#7d8794'] },
    ],
    // A soft blurred three-stop gradient cloud either sweeps corner to corner or
    // expands from the target's centre, fades out, holds, and goes again. Tuned in
    // html/gradient-motion-beam.html. Type lives in slot 8; the original eight
    // slots stay byte-for-byte compatible with effects saved before Center shipped.
    fragment: /* glsl */ `
// Smoothed joins — a hard lerp between stops creases visibly at this scale.
vec3 gmbRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  float a = smoothstep(0.0, 1.0, clamp(t * 2.0, 0.0, 1.0));
  float b = smoothstep(0.0, 1.0, clamp(t * 2.0 - 1.0, 0.0, 1.0));
  return mix(mix(uColors[0], uColors[1], a), uColors[2], b);
}

vec4 fx(vec2 uv) {
  vec4 base = texture2D(uTexture, uv);

  float speed   = max(uParams[0], 0.05);
  float angle   = radians(uParams[1]);
  float blur01  = clamp(uParams[2] / 100.0, 0.0, 1.0);
  float width01 = clamp(uParams[3] / 100.0, 0.02, 2.0);
  float hold    = max(uParams[4], 0.0);
  float opacity = clamp(uParams[5] / 100.0, 0.0, 1.0);
  float mode    = uParams[6];
  float frostPx = max(uParams[7], 0.0);
  float beamType = uParams[8];
  float layerShow = clamp(uParams[9] / 100.0, 0.0, 1.0);

  // Aspect-corrected space, so the beam keeps its angle and thickness on any
  // ratio (9:16 verticals included). On a layer the space IS the layer's box, so
  // the beam sweeps across the artwork and travels with it.
  float ar = fxAspect();
  vec2 p = (fxLocal(uv) - 0.5) * vec2(ar, 1.0);
  vec2 dir = vec2(cos(angle), sin(angle));
  vec2 nrm = vec2(-dir.y, dir.x);

  float halfDiag = 0.5 * length(vec2(ar, 1.0));
  float halfW = width01 * halfDiag * 1.6;

  // One pass = travel + hold, off mod(uTime) — a pure function of the playhead,
  // so preview and the deterministic export agree frame for frame.
  float travel = 2.6 / speed;
  float cycle  = travel + hold;
  float prog   = clamp(mod(uTime, cycle) / travel, 0.0, 1.0);
  float glide  = mix(prog, prog * prog * (3.0 - 2.0 * prog), 0.65);
  float d;
  float rampPos;

  if (beamType < 0.5) {
    // Original Directional behavior. Keep this branch unchanged so old projects
    // and newly-added Directional beams remain frame-for-frame identical.
    float centre = -(halfDiag + halfW) + 2.0 * (halfDiag + halfW) * glide;
    float s = dot(p, dir) - centre;   // across the beam
    float q = dot(p, nrm);            // along it

    // Two slow folds so the leading edge is a lobed cloud, not a ruler line.
    float wob = 0.5 * sin(q * 2.3 + uTime * 0.5) + 0.5 * sin(q * 4.1 - uTime * 0.31);
    d = (s + wob * halfW * 0.22) / halfW;

    // The directional ramp runs along the beam, with a smaller travel drift.
    rampPos = 0.5 + 0.52 * (q / max(halfDiag, 1e-3)) + 0.26 * d + wob * 0.1;
  } else {
    // From Center uses the same aspect-corrected target space. On an adjustment
    // that is the full view; on a regular layer fxLocal() makes it the layer box,
    // so the origin follows the layer through moves, scale and rotation.
    halfW = width01 * halfDiag * 0.9;
    float centre = -halfW * 0.72 + (halfDiag + halfW * 1.35) * glide;
    float radius = length(p);
    float theta = atan(p.y, p.x);

    // Ease the organic contour in only after the wave has a safe radius. Without
    // both guards, angular displacement at radius zero becomes visible spokes.
    float contourIn = smoothstep(halfW * 0.22, halfW * 1.05, centre);
    float originGuard = smoothstep(halfW * 0.05, halfW * 0.35, radius);
    float fold = 0.55 * sin(theta * 3.0 + uTime * 0.7)
               + 0.26 * sin(theta * 5.0 - uTime * 0.42)
               + 0.19 * sin(theta * 2.0 + 1.2);
    float radialWob = fold * halfW * 0.10 * contourIn * originGuard;
    d = (radius - centre + radialWob) / max(halfW, 1e-4);

    // Three palette stops run from the inside of the expanding wave to its
    // outside edge: Color 1 → Color 2 → Color 3.
    rampPos = 0.5 + d * 0.55;
  }

  // Blur reshapes the falloff: low = flat-topped band with a defined edge, high
  // = a diffuse cloud. The tail cut stops a heavily blurred beam from leaving a
  // faint wash over the whole frame between passes.
  float shape = mix(7.0, 1.6, blur01);
  float env = exp(-pow(max(abs(d), 1e-4), shape) * 2.2);
  env *= 1.0 - smoothstep(1.7, 3.1, abs(d));

  // Appear → travel → disappear; the hold then leaves prog pinned at 1 (fade 0).
  float fade = smoothstep(0.0, 0.16, prog) * (1.0 - smoothstep(0.66, 1.0, prog));
  float k = clamp(env * fade * opacity, 0.0, 1.0);

  // Mask Original Layer: below 100 % the layer only survives where the beam
  // covers it. Coverage ignores Intensity on purpose — a faint beam still masks
  // by its full shape, and at Intensity 0 the effect is a pure travelling reveal.
  float cover = clamp(env * fade, 0.0, 1.0);
  float keep = mix(cover, 1.0, layerShow);

  vec3 beam = gmbRamp(rampPos);

  vec3 baseCol = unpremult(base);
  float baseA = base.a;

  // Frost: blur the layers below, strongest at the beam's core.
  if (frostPx > 0.01 && k > 0.002) {
    vec2 rad = (frostPx * k) / fxRes();
    const int MAXF = 24;
    int n = int(mix(10.0, 24.0, clamp(uQuality, 0.0, 1.0)));
    vec4 acc = vec4(0.0);
    for (int i = 0; i < MAXF; i++) {
      if (i >= n) break;
      float fi = float(i);
      float rr = sqrt((fi + 0.5) / float(n));
      float aa = fi * 2.399963;
      acc += texture2D(uTexture, uv + fxDir(vec2(cos(aa), sin(aa)) * rr * rad));
    }
    acc /= float(n);
    baseCol = unpremult(acc);
    baseA = acc.a;
  }
  baseA *= keep;

  vec3 outCol;
  if (mode < 0.5)       outCol = 1.0 - (1.0 - baseCol) * (1.0 - beam * k);
  else if (mode < 1.5)  outCol = baseCol + beam * k;
  else if (mode < 2.5)  outCol = mix(baseCol, max(baseCol, beam), k);
  else if (mode < 3.5) {
    vec3 b = mix(vec3(0.5), beam, k);
    outCol = mix(2.0 * baseCol * b + baseCol * baseCol * (1.0 - 2.0 * b),
                 sqrt(max(baseCol, 0.0)) * (2.0 * b - 1.0) + 2.0 * baseCol * (1.0 - b),
                 step(0.5, b));
  }
  else                  outCol = mix(baseCol, beam, k);

  // Where the layers below have no coverage the result is the beam itself, and
  // the beam lifts alpha — otherwise it vanishes in a webm-alpha export.
  vec3 straight = mix(beam, clamp(outCol, 0.0, 1.0), baseA);
  float outA = clamp(baseA + k * (1.0 - baseA), 0.0, 1.0);
  return vec4(straight * outA, outA);
}
`,
  },
  {
    id: 'gradientSweep',
    name: 'Gradient Sweep',
    group: 'Gradient',
    animated: true,
    pro: true,
    // The bloom and the lead-focus blur deliberately spill past the layer's
    // alpha; clipping would shave them to the silhouette.
    layerMatte: 'expand',
    params: [
      { key: 'mode', slot: 0, label: 'Mode', type: 'select', default: 0, primary: true,
        options: [
          { value: 0, label: 'Reveal' },
          { value: 1, label: 'Silhouette' },
          { value: 2, label: 'Sheen' },
        ] },
      { key: 'colorCore', type: 'color', colorSlot: 0, label: 'Core', default: '#ffe2a4' },
      { key: 'colorWarm', type: 'color', colorSlot: 1, label: 'Warm', default: '#ffa05c' },
      { key: 'colorHot', type: 'color', colorSlot: 2, label: 'Hot', default: '#ef3f7f' },
      { key: 'colorCool', type: 'color', colorSlot: 3, label: 'Cool', default: '#4a82e6' },
      { key: 'colorDeep', type: 'color', colorSlot: 4, label: 'Deep', default: '#16305e' },
      { key: 'angle', slot: 1, label: 'Angle', min: -180, max: 180, step: 1, default: 14, suffix: '°' },
      { key: 'bandWidth', slot: 2, label: 'Band Width', min: 20, max: 220, step: 2, default: 78, suffix: '%' },
      { key: 'coreWidth', slot: 3, label: 'Core Width', min: 0, max: 60, step: 1, default: 20, suffix: '%' },
      { key: 'easing', slot: 4, label: 'Easing', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Sine' },
          { value: 1, label: 'Linear' },
          { value: 2, label: 'Smooth' },
          { value: 3, label: 'Ease Out' },
        ] },
      { key: 'duration', slot: 5, label: 'Duration', min: 0.4, max: 4, step: 0.05, default: 1.4, suffix: 's' },
      { key: 'loop', slot: 6, label: 'Repeat', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Once' },
          { value: 1, label: 'Loop' },
        ] },
      { key: 'loopGap', slot: 7, label: 'Loop Gap', min: 0, max: 3, step: 0.05, default: 0.6, suffix: 's',
        showIf: { key: 'loop', equals: 1 } },
      { key: 'bandStrength', slot: 8, label: 'Band Strength', min: 0, max: 100, step: 1, default: 100, suffix: '%' },
      { key: 'blend', slot: 9, label: 'Band Blend', type: 'select', default: 0,
        showIf: { key: 'mode', equals: 2 },
        options: [
          { value: 0, label: 'Add' },
          { value: 1, label: 'Screen' },
          { value: 2, label: 'Normal' },
        ] },
      { key: 'coolFill', slot: 10, label: 'Cool Fill', min: 0, max: 100, step: 1, default: 34, suffix: '%',
        showIf: { key: 'mode', equals: 1 } },
      { key: 'dimOutside', slot: 11, label: 'Dim Outside', min: 0, max: 100, step: 1, default: 45, suffix: '%',
        showIf: { key: 'mode', equals: 2 } },
      { key: 'sheenFade', slot: 12, label: 'Fade Duration', min: 0.1, max: 2, step: 0.05, default: 0.5, suffix: 's',
        showIf: { key: 'mode', equals: 2 } },
      { key: 'leadBlur', slot: 13, label: 'Lead Blur', min: 0, max: 120, step: 2, default: 46, suffix: 'px' },
      { key: 'trailBlur', slot: 14, label: 'Trail Blur', min: 0, max: 60, step: 1, default: 10, suffix: 'px' },
      { key: 'glow', slot: 15, label: 'Bloom', min: 0, max: 150, step: 5, default: 30, suffix: '%' },
      { key: 'glowRadius', slot: 16, label: 'Bloom Radius', min: 2, max: 120, step: 2, default: 60, suffix: 'px' },
      { key: 'strokeWidth', slot: 17, label: 'Outline Width', min: 0, max: 14, step: 0.2, default: 3.2, suffix: 'px' },
      { key: 'strokeOpacity', slot: 18, label: 'Outline Opacity', min: 0, max: 100, step: 1, default: 90, suffix: '%' },
      { key: 'strokeFade', slot: 19, label: 'Outline Fade', min: 5, max: 250, step: 5, default: 90, suffix: '%' },
      { key: 'strokeColor', type: 'color', label: 'Outline Color', default: '#78b0ff' },
    ],
    colorPresets: [
      { name: 'Lovable', colors: ['#ffe2a4', '#ffa05c', '#ef3f7f', '#4a82e6', '#16305e', '#78b0ff'] },
      { name: 'Aurora', colors: ['#eafff7', '#4affd4', '#3f7bff', '#7d5cff', '#131b4a', '#6fd9ff'] },
      { name: 'Ember', colors: ['#fff3c9', '#ffc93f', '#ff6f2e', '#a8324a', '#3a1020', '#ffb37d'] },
      { name: 'Mono', colors: ['#ffffff', '#e7ecf2', '#aab6c4', '#5d6d80', '#1a2230', '#cfe0f2'] },
    ],
    // The Gradient Sweep Text motion template generalised to any layer: one light
    // band crosses the layer's alpha. Reveal uncovers the real pixels behind it,
    // Silhouette is the text template's look (band + cooled outline, content never
    // shown), Sheen is a looping glare over the visible layer. Tuned in
    // html/gradient-sweep-overlay.html — the palette ramp, focus falloffs and the
    // trailing-outline maths mirror gradientSweepText.js so the two stay visually
    // identical. Timing is a pure function of uTime, and an Active Range rebases
    // uTime onto its own start, so the one-shot fires exactly where it is placed.
    fragment: /* glsl */ `
// 5-stop symmetric palette across the band. u = 0 at the flat core's edge → 1 at
// the band edge; alpha dies to 0 there so the band has no hard rim.
vec3 gswRamp(float u, out float aOut) {
  vec3 c = mix(uColors[0], uColors[1], smoothstep(0.02, 0.24, u));
  c = mix(c, uColors[2], smoothstep(0.24, 0.50, u));
  c = mix(c, uColors[3], smoothstep(0.50, 0.76, u));
  c = mix(c, uColors[4], smoothstep(0.76, 0.94, u));
  float a = mix(1.0, 0.92, smoothstep(0.50, 0.76, u));
  a = mix(a, 0.45, smoothstep(0.76, 0.94, u));
  a *= 1.0 - smoothstep(0.92, 1.0, u);
  aOut = a;
  return c;
}

vec4 fx(vec2 uv) {
  vec4 base = texture2D(uTexture, uv);

  float mode = uParams[0];
  float ar = fxAspect();
  vec2 p = (fxLocal(uv) - 0.5) * vec2(ar, 1.0);
  vec2 dir = vec2(cos(radians(uParams[1])), sin(radians(uParams[1])));
  // Sweep length = the layer box's extent along the sweep axis, so a diagonal
  // band still starts and ends fully off the artwork.
  float span = abs(dir.x) * ar + abs(dir.y);
  float R = max(span * uParams[2] / 200.0, 1e-3);
  // Full-band overshoot: the beam starts entirely off one edge and travels until
  // its trailing edge has left the other, so it visibly slides away instead of
  // parking on the layer and fading in place. The end dissolve only mops up the
  // faint bloom tail (its profile is wider than the band).
  float over = R * 1.15;

  // ── travel ──
  float dur = max(uParams[5], 0.2);
  float gap = max(uParams[7], 0.0);
  float tt = uParams[6] > 0.5 ? mod(uTime, dur + gap) : uTime;
  float raw = tt / dur;                    // >1 during the gap / after the pass
  float rc = clamp(raw, 0.0, 1.0);
  float e = uParams[4];
  float eased = e < 0.5 ? (1.0 - cos(3.14159265 * rc)) * 0.5
              : e < 1.5 ? rc
              : e < 2.5 ? (rc < 0.5 ? 4.0 * rc * rc * rc : 1.0 - pow(-2.0 * rc + 2.0, 3.0) / 2.0)
              : 1.0 - pow(1.0 - rc, 3.0);
  float bandD = mix(-span * 0.5 - over, span * 0.5 + over, eased);
  float d = dot(p, dir) - bandD;           // signed dist from band centre; + = ahead
  float back = -d;

  // ── envelopes (the anti-snap machinery from the lab) ──
  // Trailing leftovers (outline, cool fill) ramp in over the first beat and
  // dissolve over the tail / loop gap instead of switching off in one frame.
  float sAfter = max(raw - 1.0, 0.0) * dur;
  float tailLen = uParams[6] > 0.5 ? max(gap, 0.05) : 0.45;
  float fadeSec = min(0.6, tailLen * 0.85);
  float endK = 1.0 - smoothstep(0.0, 1.0, sAfter / max(fadeSec, 1e-3));
  float inK = smoothstep(0.0, 1.0, (rc * dur) / min(0.35, dur * 0.25));
  float env = min(inK, endK);
  // Sheen: the object dim rides time-anchored ramps of its own Fade Duration so
  // opacity finishes returning exactly when the beam lands — never in the gap.
  float sf = clamp(uParams[12], 0.05, dur * 0.5);
  float sNow = rc * dur;
  float dimEnv = smoothstep(0.0, sf, sNow) * (1.0 - smoothstep(dur - sf, dur, sNow));
  float bf = min(0.2, sf);
  float beamEnv = smoothstep(0.0, bf, sNow) * (1.0 - smoothstep(dur - bf, dur, sNow));

  // ── focus ramp: out of focus ahead of the band, soft ONLY just behind it ──
  // The trail is a localized bump — it must die back to sharp as the content
  // settles, and the whole ramp dissolves with the pass, or the layer keeps a
  // permanent defocus after the sweep (the lab never blurred settled content).
  float sc = fxRes().y / 1080.0;
  float blurPx = d >= 0.0
    ? uParams[13] * sc * smoothstep(0.10 * R, 1.00 * R, d)
    : uParams[14] * sc * smoothstep(0.30 * R, 1.10 * R, -d) * (1.0 - smoothstep(1.10 * R, 2.40 * R, -d));
  blurPx *= endK;
  if (mode > 1.5) blurPx = 0.0;            // sheen never defocuses the content

  float glowAmt = uParams[15] / 100.0;
  float glowPx = uParams[16] * sc;
  vec4 plate = base;
  float glowA = base.a;
  if (blurPx > 0.4 || glowAmt > 0.01) {
    const int MAXB = 28;
    int n = int(mix(14.0, 28.0, clamp(uQuality, 0.0, 1.0)));
    vec4 acc = vec4(0.0);
    float accG = 0.0;
    float ws = 0.0;
    for (int i = 0; i < MAXB; i++) {
      if (i >= n) break;
      float fi = float(i);
      float rr = sqrt((fi + 0.5) / float(n));
      float aa = fi * 2.399963;
      vec2 o = vec2(cos(aa), sin(aa)) * rr;
      float w = exp(-2.2 * rr * rr);
      acc += sampleClamped(uTexture, uv + fxDir(o * (blurPx / fxRes()))) * w;
      accG += sampleClamped(uTexture, uv + fxDir(o * (glowPx / fxRes()))).a * w;
      ws += w;
    }
    if (blurPx > 0.4) plate = acc / max(ws, 1e-4);
    glowA = accG / max(ws, 1e-4);
  }

  // ── the band, masked by the (defocused) layer alpha ──
  float core = clamp(uParams[3] / 100.0, 0.0, 0.95);
  float u = clamp((clamp(abs(d) / R, 0.0, 1.0) - core) / max(1.0 - core, 1e-3), 0.0, 1.0);
  float rampA;
  vec3 bandC = gswRamp(u, rampA);
  // Sheen's beam rides its own short envelope; reveal/silhouette scale by the
  // end dissolve so the trailing half of a parked band cannot survive the pass
  // (the lab could switch to plain content after the sweep — a shader must
  // converge to it).
  float strength = clamp(uParams[8] / 100.0, 0.0, 1.0) * (mode > 1.5 ? beamEnv : endK);
  float bandA = rampA * strength * plate.a;

  // Analytic bloom: the band's own colour under a widened alpha profile, times
  // the alpha blurred at the bloom radius — spreads past the silhouette like the
  // lab's additive blur. Colour must stay the band's local colour: sampling the
  // ramp at the widened profile shifts everything toward the core and paints a
  // pale ring across the hot zone.
  float uG = clamp((clamp(abs(d) / (R * 1.6), 0.0, 1.0) - core) / max(1.0 - core, 1e-3), 0.0, 1.0);
  float rampAG;
  gswRamp(uG, rampAG);
  vec3 bloomC = bandC;
  float bloomA = rampAG * strength * glowA * glowAmt;

  // ── trailing edge outline: dilated alpha minus alpha, cooled and fading ──
  float fadeLen = max(span * uParams[19] / 100.0, 0.02);
  float alive = 1.0 - smoothstep(0.0, fadeLen, back - R);
  float ringA = 0.0;
  float swPx = uParams[17] * sc;
  if (swPx > 0.1 && mode < 1.5) {
    float dil = 0.0;
    for (int i = 0; i < 12; i++) {
      float aa = float(i) * 0.5235988;
      dil = max(dil, sampleClamped(uTexture, uv + fxDir(vec2(cos(aa), sin(aa)) * (swPx / fxRes()))).a);
    }
    float onS = smoothstep(R * 0.42, R * 0.92, back);
    ringA = clamp(dil - base.a, 0.0, 1.0) * (uParams[18] / 100.0) * onS * alive * env;
  }

  // ── compose ──
  if (mode < 0.5) {
    // Reveal: real pixels ramp in behind the band; band + outline + bloom add.
    float behind = smoothstep(R * 0.05, R * 0.75, -d);
    vec3 rgb = plate.rgb * behind + bandC * bandA + uColor * ringA + bloomC * bloomA;
    float aa = clamp(plate.a * behind + bandA + ringA + bloomA, 0.0, 1.0);
    return vec4(min(rgb, vec3(aa)), aa);
  } else if (mode < 1.5) {
    // Silhouette: the text template's look — cool fill + band + outline only.
    float onC = smoothstep(R * 0.35, R * 0.90, back);
    float coolA = (uParams[10] / 100.0) * onC * alive * env * base.a;
    vec3 rgb = uColors[4] * coolA + bandC * bandA + uColor * ringA + bloomC * bloomA;
    float aa = clamp(coolA + bandA + ringA + bloomA, 0.0, 1.0);
    return vec4(min(rgb, vec3(aa)), aa);
  }
  // Sheen: content stays, dims away from the band, and the beam blends over it.
  float dim = (uParams[11] / 100.0) * dimEnv * smoothstep(R * 0.5, R * 1.4, abs(d));
  vec3 st = unpremult(base) * (1.0 - dim);
  float w = rampA * clamp(uParams[8] / 100.0, 0.0, 1.0) * beamEnv;
  float bm = uParams[9];
  if (bm < 0.5)      st = st + bandC * w;
  else if (bm < 1.5) st = 1.0 - (1.0 - st) * (1.0 - bandC * w);
  else               st = mix(st, bandC, w);
  vec3 rgb = clamp(st, 0.0, 1.0) * base.a + bloomC * bloomA * beamEnv;
  float aa = clamp(base.a + bloomA * beamEnv, 0.0, 1.0);
  return vec4(min(rgb, vec3(aa)), aa);
}
`,
  },

  {
    id: 'fractalNoise',
    name: 'Fractal Noise',
    group: 'Pattern',
    desc: 'Fog, smoke, cloud, light leaks and grain from one looping noise field',
    // Defaults ARE the Drifting Fog preset, so a fresh entry is usable at once.
    animated: true,
    // The field is painted INSIDE the plate's alpha (and Over mode composites a
    // cloud body over it). Clip by default so a layer keeps its silhouette;
    // untick Clip to let an Over-blend cloud spill past the artwork.
    layerMatte: 'clip',
    params: [
      { key: 'type', slot: 0, label: 'Fractal Type', type: 'select', default: 0, primary: true,
        options: [
          { value: 0, label: 'Basic' },
          { value: 1, label: 'Turbulent' },
          { value: 2, label: 'Ridged' },
        ] },
      { key: 'colorShadow', type: 'color', colorSlot: 0, label: 'Shadow', default: '#000000' },
      { key: 'colorLight',  type: 'color', colorSlot: 1, label: 'Light',  default: '#ffffff' },
      { key: 'scale',     slot: 1,  label: 'Scale', min: 15, max: 600, step: 1, default: 260, suffix: '%' },
      { key: 'stretch',   slot: 2,  label: 'Stretch', min: -2, max: 2, step: 0.01, default: 0 },
      { key: 'rotation',  slot: 3,  label: 'Rotation', min: -180, max: 180, step: 1, default: 0, suffix: '°' },
      { key: 'octaves',   slot: 4,  label: 'Complexity', min: 1, max: 8, step: 1, default: 4 },
      { key: 'gain',      slot: 5,  label: 'Sub Influence', min: 0.1, max: 1, step: 0.01, default: 0.55 },
      { key: 'subRot',    slot: 6,  label: 'Sub Rotation', min: -90, max: 90, step: 1, default: 24, suffix: '°' },
      { key: 'soft',      slot: 7,  label: 'Crease Softness', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'ridge',     slot: 8,  label: 'Ridge Sharpness', min: 1, max: 5, step: 0.05, default: 2.5,
        showIf: { key: 'type', equals: 2 } },
      { key: 'mass',      slot: 9,  label: 'Mass Detail', min: 0, max: 1, step: 0.01, default: 0 },
      { key: 'edge',      slot: 10, label: 'Edge Softness', min: 0, max: 1, step: 0.01, default: 0 },
      { key: 'wisp',      slot: 11, label: 'Wisp Warp', min: 0, max: 2, step: 0.01, default: 0 },
      { key: 'churn',     slot: 12, label: 'Churn Speed', min: 0, max: 6, step: 0.05, default: 1, suffix: ' turns' },
      { key: 'driftSpeed', slot: 13, label: 'Drift Speed', min: 0, max: 1.5, step: 0.01, default: 0.25 },
      { key: 'driftAngle', slot: 14, label: 'Drift Angle', min: -180, max: 180, step: 1, default: 0, suffix: '°' },
      { key: 'contrast',  slot: 15, label: 'Contrast', min: 0.2, max: 4, step: 0.01, default: 1 },
      { key: 'brightness', slot: 16, label: 'Brightness', min: -0.5, max: 0.5, step: 0.01, default: 0 },
      { key: 'floor',     slot: 17, label: 'Levels Floor', min: 0, max: 1, step: 0.01, default: 0.35 },
      { key: 'density',   slot: 18, label: 'Density', min: 0, max: 1, step: 0.01, default: 0 },
      { key: 'light',     slot: 19, label: 'Lighting', min: 0, max: 1, step: 0.01, default: 0 },
      { key: 'lightAngle', slot: 20, label: 'Light Angle', min: -180, max: 180, step: 1, default: 120, suffix: '°' },
      { key: 'blend', slot: 21, label: 'Blend Mode', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Screen' },
          { value: 1, label: 'Add' },
          { value: 2, label: 'Multiply' },
          { value: 3, label: 'Overlay' },
          { value: 4, label: 'Soft Light' },
          { value: 5, label: 'Over (field = alpha)' },
        ] },
      { key: 'maskLayer', slot: 22, label: 'Mask Layer by Noise', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Off' },
          { value: 1, label: 'On' },
        ] },
      { key: 'invert', slot: 23, label: 'Invert', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Off' },
          { value: 1, label: 'On' },
        ] },
    ],
    colorPresets: [
      { name: 'Drifting Fog', colors: ['#000000', '#ffffff'],
        params: { type: 0, scale: 260, stretch: 0, octaves: 4, gain: 0.55, soft: 0.5, mass: 0, edge: 0, wisp: 0, churn: 1, driftSpeed: 0.25, driftAngle: 0, contrast: 1, brightness: 0, floor: 0.35, density: 0, light: 0, blend: 0, maskLayer: 0, invert: 0 } },
      { name: 'Rolling Smoke', colors: ['#26282c', '#e2e6ea'],
        params: { type: 1, scale: 200, stretch: 0.3, octaves: 8, gain: 0.65, subRot: 24, soft: 0.4, mass: 0.8, edge: 0.85, wisp: 0.2, churn: 2, driftSpeed: 0, contrast: 1.25, brightness: 0, floor: 0.1, density: 0.25, light: 0.6, lightAngle: 100, blend: 5, maskLayer: 0, invert: 0 } },
      { name: 'Smoke Veins', colors: ['#26282c', '#e2e6ea'],
        params: { type: 2, scale: 419, stretch: -0.19, rotation: -83, octaves: 8, gain: 0.65, subRot: -90, soft: 0.64, ridge: 2.5, mass: 0.8, edge: 0, wisp: 0.39, churn: 2, driftSpeed: 0, contrast: 1.25, brightness: 0, floor: 0.1, density: 0.25, light: 0.6, lightAngle: 100, blend: 5, maskLayer: 0, invert: 0 } },
      { name: 'Cloud Bed', colors: ['#4a4d55', '#f0f2f5'],
        params: { type: 1, scale: 300, stretch: 0.3, octaves: 8, gain: 0.62, subRot: 24, soft: 0.4, mass: 0.9, edge: 0.8, wisp: 0.25, churn: 1, driftSpeed: 0, contrast: 1.15, brightness: 0, floor: 0.12, density: 0.3, light: 0.7, lightAngle: 120, blend: 5, maskLayer: 0, invert: 0 } },
      { name: 'Light Leak', colors: ['#200600', '#ff9a3d'],
        params: { type: 0, scale: 480, stretch: 0, rotation: -25, octaves: 2, gain: 0.5, soft: 0.5, mass: 0, edge: 0, wisp: 0, churn: 1, driftSpeed: 0, contrast: 1.7, brightness: 0, floor: 0.6, density: 0, light: 0, blend: 1, maskLayer: 0, invert: 0 } },
      { name: 'Film Wash', colors: ['#000000', '#ffffff'],
        params: { type: 1, scale: 60, stretch: 0, octaves: 6, gain: 0.6, subRot: 24, soft: 0.6, mass: 0, edge: 0, wisp: 0, churn: 3, driftSpeed: 0, contrast: 0.9, brightness: 0, floor: 0, density: 0, light: 0, blend: 3, maskLayer: 0, invert: 0 } },
      { name: 'Heat Veil', colors: ['#000000', '#ffb37a'],
        params: { type: 1, scale: 200, stretch: -1.4, octaves: 5, gain: 0.55, subRot: 24, soft: 0.6, mass: 0, edge: 0, wisp: 0, churn: 1, driftSpeed: 0.4, driftAngle: -90, contrast: 1.1, brightness: 0, floor: 0, density: 0, light: 0, blend: 4, maskLayer: 0, invert: 0 } },
    ],
    // Ported from html/fractal-noise-lab.html. One full-screen pass: 4D Perlin
    // gradient noise summed across octaves, the evolution walking a circle in
    // the two extra dimensions so `churn` whole turns per clip loop seam-free.
    // Bubbles/blobs were engineered out in the lab and the fixes ride along:
    // a soft fold instead of abs(), a Musgrave mass gate, a fine-octave edge
    // roll-off, a wisp domain warp, extinction density and low-octave lighting
    // — the lab header documents each. Lighting reads the slope by finite
    // differences of the low field (this chain is ES 1.00: no derivatives).
    fragment: /* glsl */ `
float fnHash41(vec4 p) {
  p = fract(p * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p += dot(p, p.wzxy + 33.33);
  return fract((p.x + p.y) * (p.z + p.w));
}
vec4 fnHash44(vec4 p) {
  p = fract(p * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p += dot(p, p.wzxy + 33.33);
  return fract((p.xxyz + p.yzzw) * p.zywx);
}
float fnCorner(vec4 i, vec4 f, vec4 c) {
  vec4 g = normalize(fnHash44(i + c) * 2.0 - 1.0 + 1e-4);
  return dot(g, f - c);
}
// 4D Perlin gradient noise, quintic fade; ×1.75 puts it in the ±1 working range
// the fold and the recentre constants were measured against.
float fnNoise(vec4 p) {
  vec4 i = floor(p), f = fract(p);
  vec4 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float x00 = mix(mix(fnCorner(i, f, vec4(0,0,0,0)), fnCorner(i, f, vec4(1,0,0,0)), u.x),
                  mix(fnCorner(i, f, vec4(0,1,0,0)), fnCorner(i, f, vec4(1,1,0,0)), u.x), u.y);
  float x01 = mix(mix(fnCorner(i, f, vec4(0,0,1,0)), fnCorner(i, f, vec4(1,0,1,0)), u.x),
                  mix(fnCorner(i, f, vec4(0,1,1,0)), fnCorner(i, f, vec4(1,1,1,0)), u.x), u.y);
  float x10 = mix(mix(fnCorner(i, f, vec4(0,0,0,1)), fnCorner(i, f, vec4(1,0,0,1)), u.x),
                  mix(fnCorner(i, f, vec4(0,1,0,1)), fnCorner(i, f, vec4(1,1,0,1)), u.x), u.y);
  float x11 = mix(mix(fnCorner(i, f, vec4(0,0,1,1)), fnCorner(i, f, vec4(1,0,1,1)), u.x),
                  mix(fnCorner(i, f, vec4(0,1,1,1)), fnCorner(i, f, vec4(1,1,1,1)), u.x), u.y);
  return mix(mix(x00, x01, u.z), mix(x10, x11, u.z), u.w) * 1.75;
}
// Soft fold: sqrt(n²+s²)−s, abs() at s = 0; the divisor keeps its maximum at 1.
float fnFold(float n, float s) {
  return (sqrt(n * n + s * s) - s) / (sqrt(1.0 + s * s) - s);
}
float fnShaped(float n, float s) {
  float type = uParams[0];
  if (type < 0.5) return n;
  if (type < 1.5) return fnFold(n, s);
  return pow(clamp(1.0 - fnFold(n * 2.0, s), 0.0, 1.0), uParams[8]);
}
// Mean/std fits (5 octaves, gain 0.6) across the softness slider, so type and
// softness change the texture, never the exposure.
float fnRecentre(float v) {
  float type = uParams[0];
  float x = uParams[7];
  if (type < 0.5) return 0.5 + v * 1.2;
  if (type < 1.5) {
    float m = 0.2480 - 0.2673 * x + 0.1447 * x * x;
    float sd = 0.0986 - 0.0148 * x - 0.0024 * x * x;
    return 0.42 + (v - m) / sd * 0.2;
  }
  float m = 0.3680 + 0.2878 * x - 0.1408 * x * x;
  float sd = 0.1651 + 0.0765 * x - 0.0494 * x * x;
  return 0.5 + (v - m) / sd * 0.2;
}
// Three signed octaves — the field that bends the sampling point for Wisp warp.
float fnLite(vec2 q, vec2 evo) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += fnNoise(vec4(q, evo)) * a; q = q * 2.0 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}
// The octave sum at field coordinate q, limited to maxOct octaves (the lighting
// reads the first three). Mass gate + edge roll-off exactly as the lab.
float fnFbm(vec2 q, vec2 evo, int maxOct) {
  int oct = int(min(uParams[4], float(maxOct)) + 0.5);
  float gain = uParams[5];
  float mass = uParams[9];
  float edge = uParams[10];
  float type = uParams[0];
  float s0 = uParams[7] * 0.6;
  float amp = 1.0, tot = 0.0, sum = 0.0, weight = 1.0;
  float ca = cos(radians(uParams[6])), sa = sin(radians(uParams[6]));
  mat2 R = mat2(ca, sa, -sa, ca);
  float er = 1.0;
  float octs = max(uParams[4] - 1.0, 1.0);
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    float depth = float(i) / octs;
    float n = fnShaped(fnNoise(vec4(q, evo * er)), s0 + edge * 0.5 * depth);
    float w = amp * mix(1.0, weight, mass);
    sum += n * w;
    tot += amp;
    float dens = type < 0.5 ? (n * 0.5 + 0.5) * 1.6 : n * 3.0;
    float x = min(weight * (dens + mix(0.3, 0.05, edge)), 1.0);
    weight = x * (2.0 - x);
    amp *= gain * mix(1.0, 0.72, edge * step(2.0, float(i)));
    er *= 1.35;
    q = R * q * 2.0 + vec2(3.7, -2.1);
  }
  return fnRecentre(sum / max(tot, 1e-5));
}
// Layer-local point → field coordinate (scale, stretch, rotation, drift, wisp).
vec2 fnField(vec2 p, vec2 evo) {
  float k = 300.0 / max(uParams[1], 1.0);
  vec2 fs2 = vec2(pow(2.0, -uParams[2]), pow(2.0, uParams[2]));
  float cr = cos(radians(uParams[3])), sr = sin(radians(uParams[3]));
  float dv = uParams[13] * uTime;
  vec2 drift = vec2(dv * cos(radians(uParams[14])), dv * sin(radians(uParams[14])));
  vec2 q = mat2(cr, sr, -sr, cr) * (p * k * fs2) + drift;
  if (uParams[11] > 0.0) {
    vec2 e = evo * 0.8 + vec2(3.1, 7.7);
    q += uParams[11] * vec2(fnLite(q + vec2(11.3, 4.2), e), fnLite(q + vec2(-6.1, 8.9), e * 1.07));
  }
  return q;
}
float fnTone(float v) {
  v = (v - 0.5) * uParams[15] + 0.5 + uParams[16];
  v = (v - uParams[17]) / max(1.0 - uParams[17], 1e-4);
  float k = uParams[18] * 5.0;
  if (k > 0.0) v = (1.0 - exp(-k * max(v, 0.0))) / (1.0 - exp(-k));
  // tanh highlight shoulder — a hard clamp turns bright masses into plates.
  if (v > 0.85) { float t = (v - 0.85) / 0.15; float e2 = exp(2.0 * t); v = 0.85 + 0.15 * (e2 - 1.0) / (e2 + 1.0); }
  return clamp(v, 0.0, 1.0);
}
vec3 fnBlend(float m, vec3 b, vec3 s) {
  if (m < 0.5) return 1.0 - (1.0 - b) * (1.0 - s);
  if (m < 1.5) return b + s;
  if (m < 2.5) return b * s;
  if (m < 3.5) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(vec3(0.5), b));
  return (1.0 - 2.0 * s) * b * b + 2.0 * s * b;
}

vec4 fx(vec2 uv) {
  vec4 base = texture2D(uTexture, uv);
  vec2 p = (fxLocal(uv) - 0.5) * vec2(fxAspect(), 1.0);
  // Evolution walks a circle: 'churn' whole turns per clip loop seam-free.
  float theta = 6.28318530718 * uParams[12] * uProgress;
  vec2 evo = 0.75 * vec2(cos(theta), sin(theta));
  float v = fnTone(fnFbm(fnField(p, evo), evo, 8));
  v = mix(v, 1.0 - v, step(0.5, uParams[23]));
  // Lighting: the low-octave field is a height map lit from one side. Finite
  // differences two pixels apart, scaled to the layer height so the look does
  // not change with resolution; it shades the COLOUR only, alpha stays v.
  float shade = 0.0;
  if (uParams[19] > 0.0) {
    float dp = 2.0 / max(fxRes().y, 1.0);
    float l0 = fnFbm(fnField(p, evo), evo, 3);
    float lx = fnFbm(fnField(p + vec2(dp, 0.0), evo), evo, 3);
    float ly = fnFbm(fnField(p + vec2(0.0, dp), evo), evo, 3);
    vec2 g = vec2(lx - l0, ly - l0) / dp * 0.7;
    g /= 1.0 + 0.5 * length(g);
    vec3 N = normalize(vec3(-g, 1.0));
    float la = radians(uParams[20]);
    vec3 L = normalize(vec3(cos(la), sin(la), 0.9));
    shade = (dot(N, L) - L.z) * uParams[19];
  }
  float vc = clamp(v + shade * v, 0.0, 1.0);
  vec3 nc = mix(uColors[0], uColors[1], vc);
  vec3 st = unpremult(base);
  float maskA = mix(1.0, v, step(0.5, uParams[22]));
  if (uParams[21] > 4.5) {
    // Over: the field is the cloud's alpha and it composites IN FRONT of the
    // plate (exact premultiplied over), so dense cores occlude and — with Clip
    // off — the cloud can spill past the silhouette.
    vec3 rgb = base.rgb * (1.0 - v) + nc * v;
    float a = base.a * (1.0 - v) + v;
    return vec4(rgb * maskA, a * maskA);
  }
  vec3 outc = clamp(fnBlend(uParams[21], st, nc), 0.0, 1.0);
  float a = base.a * maskA;
  return vec4(outc * a, a);
}
`,
  },

  // ── Glitch pack ─────────────────────────────────────────────────────────────
  {
    id: 'rgbSplit',
    name: 'RGB Split',
    group: 'Glitch',
    animated: false,
    params: [
      { key: 'amount', slot: 0, label: 'Amount', min: 0, max: 60, step: 0.5, default: 8, suffix: 'px' },
      { key: 'angle', slot: 1, label: 'Angle', min: 0, max: 360, step: 1, default: 0, suffix: '°' },
      { key: 'mode', slot: 2, label: 'Mode', type: 'select', default: 0,
        options: [{ value: 0, label: 'Linear' }, { value: 1, label: 'Radial' }] },
    ],
    fragment: /* glsl */ `
vec4 fx(vec2 uv) {
  // Radial mode splits away from the layer's own centre; the offset is a step in
  // layer pixels, so it turns and scales with the layer.
  vec2 dir = uParams[2] > 0.5
    ? normalize(fxLocal(uv) - 0.5 + 1e-5)
    : vec2(cos(radians(uParams[1])), sin(radians(uParams[1])));
  vec2 off = fxDir(dir * (uParams[0] / fxRes()));
  vec4 r = texture2D(uTexture, uv + off);
  vec4 g = texture2D(uTexture, uv);
  vec4 b = texture2D(uTexture, uv - off);
  float a = (r.a + g.a + b.a) / 3.0;
  vec3 col = vec3(unpremult(r).r, unpremult(g).g, unpremult(b).b);
  return vec4(col * a, a);
}
`,
  },
  {
    id: 'glitch',
    name: 'Digital Glitch',
    group: 'Glitch',
    animated: true,
    params: [
      { key: 'amount', slot: 0, label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'blockSize', slot: 1, label: 'Block', min: 2, max: 120, step: 1, default: 24, suffix: 'px' },
      { key: 'speed', slot: 2, label: 'Speed', min: 0, max: 10, step: 0.1, default: 4 },
      { key: 'colorShift', slot: 3, label: 'Color Shift', min: 0, max: 40, step: 0.5, default: 8, suffix: 'px' },
    ],
    fragment: /* glsl */ `
vec4 fx(vec2 uv) {
  float amt = uParams[0];
  float blk = max(2.0, uParams[1]);
  float t = floor(uTime * (uParams[2] * 6.0 + 0.001));
  // Scanline rows, the torn-line shift and the chroma offset are all measured
  // across the layer, so the tear rides the artwork instead of the frame.
  vec2 lp = fxLocal(uv);
  float row = floor(fxCoord(uv).y / blk);
  float rnd = hash21(vec2(row, t));
  float lineGlitch = step(1.0 - amt * 0.6, rnd);
  float shift = (hash21(vec2(row * 1.7, t * 0.3)) - 0.5) * amt * 0.12 * lineGlitch;
  vec2 uv2 = fxFrame(vec2(fract(lp.x + shift), lp.y));
  vec2 cs = fxDir(vec2(uParams[3] / fxRes().x * (0.3 + amt), 0.0));
  vec4 g = texture2D(uTexture, uv2);
  vec4 r = texture2D(uTexture, uv2 + cs);
  vec4 b = texture2D(uTexture, uv2 - cs);
  float a = (r.a + g.a + b.a) / 3.0;
  vec3 col = vec3(unpremult(r).r, unpremult(g).g, unpremult(b).b);
  col += lineGlitch * (hash21(vec2(row, t * 2.1)) - 0.5) * amt * 0.35;
  return vec4(clamp(col, 0.0, 1.0) * a, a);
}
`,
  },
  {
    id: 'scanlines',
    name: 'Scanlines',
    group: 'Glitch',
    animated: true,
    params: [
      { key: 'count', slot: 0, label: 'Lines', min: 40, max: 1200, step: 10, default: 340 },
      { key: 'intensity', slot: 1, label: 'Intensity', min: 0, max: 1, step: 0.01, default: 0.4 },
      { key: 'roll', slot: 2, label: 'Roll', min: -5, max: 5, step: 0.1, default: 0 },
    ],
    fragment: /* glsl */ `
vec4 fx(vec2 uv) {
  vec4 base = texture2D(uTexture, uv);
  float s = sin((fxLocal(uv).y + uTime * uParams[2] * 0.1) * uParams[0] * 3.14159);
  float scan = 1.0 - uParams[1] * (0.5 - 0.5 * s);
  return vec4(unpremult(base) * scan * base.a, base.a);
}
`,
  },
  {
    id: 'grain',
    name: 'Film Grain',
    group: 'Glitch',
    animated: true,
    // The look the user picked in html/film-grain-lab.html: a quiet, still grain.
    // A fresh entry starts at this Mix (makeDefaultEffect); a saved one keeps its own.
    defaultMix: 32,
    params: [
      { key: 'amount', slot: 0, label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.2 },
      // Grain px at 1080p (the frame's short side), so preview and export match.
      { key: 'size', slot: 1, label: 'Size', min: 1, max: 8, step: 0.5, default: 2, suffix: 'px' },
      { key: 'animate', slot: 2, label: 'Animate', type: 'select', default: 0,
        options: [{ value: 1, label: 'On' }, { value: 0, label: 'Off' }] },
      { key: 'color', slot: 3, label: 'Color', min: 0, max: 1, step: 0.01, default: 0.1 },
    ],
    // Grain that reads as film, not as sensor noise: soft clumped grains (two
    // rotated layers of smooth noise plus a little per-pixel bite) with a bell-
    // shaped value spread, strongest in the midtones, thinning in the
    // highlights, and squeezed to nothing at 0 and 1 so it never clips black
    // to grey or white to grey. Color splits it per dye layer. The lattice is
    // integer-hashed (bit-exact on both backends) and printed on the layer.
    fragment: /* glsl */ `
vec4 grHash4(vec2 p, float seed) {
  uvec2 v = uvec2(ivec2(floor(p)) + 32768);
  v.x += uint(seed) * 747796405u;
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return vec4(vec2(v & 65535u), vec2(v >> 16u)) / 65536.0;
}
// One corner's grain values: luma, and two chroma axes when Color is on.
vec3 grCorner(vec2 c, float seed, float chroma) {
  vec4 h = grHash4(c, seed * 2.0);
  vec3 g = vec3(h.x + h.y - 1.0, 0.0, 0.0);
  if (chroma > 0.001) {
    vec4 h2 = grHash4(c, seed * 2.0 + 1.0);
    g.yz = vec2(h.z + h.w - 1.0, h2.x + h2.y - 1.0);
  }
  return g;
}
// Value noise over the corner values, divided by the interpolation's own
// spread: plain value noise swells on the lattice and dips mid-cell, and that
// periodic swell is the grid the eye picks out of fake grain.
vec3 grLayer(vec2 p, float seed, float chroma) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  vec4 k = vec4((1.0 - w.x) * (1.0 - w.y), w.x * (1.0 - w.y), (1.0 - w.x) * w.y, w.x * w.y);
  vec3 s = grCorner(i, seed, chroma) * k.x
    + grCorner(i + vec2(1.0, 0.0), seed, chroma) * k.y
    + grCorner(i + vec2(0.0, 1.0), seed, chroma) * k.z
    + grCorner(i + vec2(1.0, 1.0), seed, chroma) * k.w;
  return s * inversesqrt(max(dot(k, k), 1e-4));
}
vec4 fx(vec2 uv) {
  vec4 base = texture2D(uTexture, uv);
  float amt = uParams[0];
  if (amt <= 0.001) return base;
  float chroma = clamp(uParams[3], 0.0, 1.0);
  float frame = uParams[2] > 0.5 ? floor(uTime * 24.0) : 0.0;
  vec4 jit = grHash4(vec2(frame, 17.0), 3.0) * 64.0;
  // 1080p-reference px on the layer's own lattice.
  float pxScale = max(min(uResolution.x, uResolution.y) / 1080.0, 1e-3);
  vec2 p = fxCoord(uv) / pxScale;
  float size = max(uParams[1], 1.0);
  vec2 pa = rot2(0.41) * p / size + jit.xy;
  vec2 pb = rot2(-0.93) * p / (size * 2.1) + jit.zw + 517.0;
  vec3 n = grLayer(pa, frame, chroma) + 0.42 * grLayer(pb, frame + 9973.0, chroma);
  // Coarse grain still has fine grains inside it; without them a big grain
  // reads as a watery blur. Fades in above ~2 px, skipped below.
  float wc = 0.6 * smoothstep(1.5, 4.0, size);
  if (wc > 0.001) {
    vec2 pc = rot2(2.17) * p / (size * 0.45) + jit.yx + 1291.0;
    n.x += wc * grLayer(pc, frame + 19937.0, 0.0).x;
  }
  // Per-pixel bite, so the grain keeps a crisp edge.
  vec4 hf = grHash4(fxCoord(uv), frame * 2.0 + 7.0);
  n.x += 0.3 * (hf.x + hf.y - 1.0);
  n *= inversesqrt((1.2664 + wc * wc) / 6.0);
  vec3 c = clamp(unpremult(base), 0.0, 1.0);
  float l = luma(c);
  float resp = mix(0.55, 1.0, smoothstep(0.0, 0.3, l)) * (1.0 - 0.7 * smoothstep(0.5, 1.0, l));
  vec3 room = max(sqrt(clamp(4.0 * c * (1.0 - c), 0.0, 1.0)), vec3(0.18));
  vec3 rgb = vec3(n.x) + chroma * 1.3 * (n.y * vec3(0.7071, -0.7071, 0.0) + n.z * vec3(0.4082, 0.4082, -0.8165));
  vec3 col = clamp(c + rgb * (amt * 0.22 * resp) * room, 0.0, 1.0);
  return vec4(col * base.a, base.a);
}
`,
  },
  {
    id: 'flashBlink',
    name: 'Flash Blink',
    group: 'Glitch',
    animated: true,
    params: [
      { key: 'speed', slot: 0, label: 'Speed', min: 0.2, max: 20, step: 0.1, default: 3, suffix: '/s' },
      { key: 'mode', slot: 1, label: 'Mode', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Strobe' },
          { value: 1, label: 'Pulse' },
          { value: 2, label: 'Flicker' },
        ] },
      { key: 'style', slot: 2, label: 'Style', type: 'select', default: 2,
        options: [
          { value: 1, label: 'Blink Out' },
          { value: 2, label: 'Exposure Pop' },
        ] },
      { key: 'duty', slot: 3, label: 'On Time', min: 5, max: 95, step: 1, default: 50, suffix: '%' },
      { key: 'softness', slot: 4, label: 'Softness', min: 0, max: 100, step: 1, default: 15, suffix: '%' },
      // Real 3D only (a model layer): the side of the body the flash lands on.
      { key: 'lightAngle', label: 'Light From', min: 0, max: 360, step: 1, default: 135, suffix: '°', model3d: true },
      { key: 'color', type: 'color', label: 'Color', default: '#ffffff' },
    ],
    // Periodic blink driven purely by uTime, so preview and the deterministic
    // export agree frame for frame (Flicker quantises time before hashing for the
    // same reason). Blink Out hides the content; Exposure Pop pumps brightness
    // additively and is the default.
    fragment: /* glsl */ `
vec4 fx(vec2 uv) {
  vec4 base = texture2D(uTexture, uv);
  float speed = max(uParams[0], 0.05);
  float mode  = uParams[1];
  float style = uParams[2];
  float duty  = clamp(uParams[3] / 100.0, 0.02, 0.98);
  float soft  = clamp(uParams[4] / 100.0, 0.0, 1.0);

  float ph = uTime * speed;
  float f = fract(ph);
  float k;
  if (mode < 0.5) {
    // Strobe: on for the duty fraction of each cycle, edges softened symmetrically.
    float e = max(soft * 0.5 * min(duty, 1.0 - duty), 1e-4);
    k = smoothstep(0.0, e, f) * (1.0 - smoothstep(duty - e, duty, f));
  } else if (mode < 1.5) {
    // Pulse: raised cosine, duty skews it brighter-longer or snappier.
    k = pow(0.5 - 0.5 * cos(f * 6.2831853), mix(2.4, 0.45, duty));
  } else {
    // Flicker: random on/off per tick with a random level, duty = on-probability.
    float tick = floor(ph);
    k = step(1.0 - duty, hash21(vec2(tick, 3.7))) * mix(0.4, 1.0, hash21(vec2(tick, 9.1)));
  }
  k = clamp(k, 0.0, 1.0);

  vec3 baseCol = unpremult(base);
  if (style > 0.5 && style < 1.5) {
    // Blink out: premultiplied scale, so fringes stay clean as content vanishes.
    return base * (1.0 - k);
  }
  // Exposure Pop is also the safe fallback for removed legacy style value 0.
  vec3 col = clamp(baseCol + uColor * k, 0.0, 1.0);
  return vec4(col * base.a, base.a);
}
`,
  },
  {
    id: 'vhs',
    name: 'VHS',
    group: 'Glitch',
    animated: true,
    params: [
      { key: 'amount', slot: 0, label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'wobble', slot: 1, label: 'Wobble', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'chroma', slot: 2, label: 'Chroma', min: 0, max: 30, step: 0.5, default: 6, suffix: 'px' },
      { key: 'noise', slot: 3, label: 'Noise', min: 0, max: 1, step: 0.01, default: 0.25 },
    ],
    fragment: /* glsl */ `
vec4 fx(vec2 uv) {
  float amt = uParams[0];
  vec2 lp = fxLocal(uv);
  float w = sin(lp.y * 120.0 + uTime * 4.0) * 0.5 + sin(lp.y * 13.0 - uTime * 2.0) * 0.5;
  float dx = w * uParams[1] * 0.01 * amt;
  float band = smoothstep(0.4, 0.5, sin(lp.y * 3.0 - uTime * 1.3)) * step(0.6, fract(uTime * 0.7));
  dx += band * amt * 0.03;
  vec2 uv2 = fxFrame(vec2(fract(lp.x + dx), lp.y));
  vec2 cs = fxDir(vec2(uParams[2] / fxRes().x, 0.0));
  vec4 g = texture2D(uTexture, uv2);
  vec4 r = texture2D(uTexture, uv2 + cs);
  vec4 b = texture2D(uTexture, uv2 - cs);
  float a = (r.a + g.a + b.a) / 3.0;
  vec3 col = vec3(unpremult(r).r, unpremult(g).g, unpremult(b).b);
  col += (hash21(fxCoord(uv) * 0.5 + floor(uTime * 24.0)) - 0.5) * uParams[3];
  col *= 1.0 - 0.15 * amt * (0.5 - 0.5 * sin(lp.y * fxRes().y));
  return vec4(clamp(col, 0.0, 1.0) * a, a);
}
`,
  },

  // ── Lens pack ────────────────────────────────────────────────────────────────
  {
    id: 'fisheye',
    name: 'Fisheye',
    group: 'Lens',
    animated: false,
    params: [
      { key: 'distortion', slot: 0, label: 'Distortion', min: -1, max: 1, step: 0.01, default: 0.4 },
      { key: 'zoom', slot: 1, label: 'Zoom', min: 0.5, max: 2, step: 0.01, default: 1 },
    ],
    fragment: /* glsl */ `
vec4 fx(vec2 uv) {
  float ar = fxAspect();
  vec2 c = (fxLocal(uv) - 0.5) * vec2(ar, 1.0);
  c *= (1.0 + uParams[0] * dot(c, c));
  c /= max(uParams[1], 0.01);
  c.x /= ar;
  vec2 p = c + 0.5;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return vec4(0.0);
  return texture2D(uTexture, fxFrame(p));
}
`,
  },
  {
    id: 'opticsCompensation',
    name: 'Optics Compensation',
    group: 'Lens',
    animated: false,
    params: [
      { key: 'fov', slot: 0, label: 'Field of View', min: 0, max: 160, step: 0.5, default: 45, suffix: '°' },
      { key: 'reverse', slot: 2, label: 'Lens Distortion', type: 'select', default: 0, primary: true,
        options: [
          { value: 0, label: 'Add (barrel)' },
          { value: 1, label: 'Remove (reverse)' },
        ] },
      { key: 'orientation', slot: 1, label: 'FOV Orientation', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Horizontal' },
          { value: 1, label: 'Vertical' },
          { value: 2, label: 'Diagonal' },
        ] },
      { key: 'resize', slot: 5, label: 'Resize', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Off' },
          { value: 1, label: 'Fit' },
        ] },
      { key: 'zoom', slot: 6, label: 'Zoom', min: 0.5, max: 2, step: 0.01, default: 1 },
      { key: 'centerX', slot: 3, label: 'Center X', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'centerY', slot: 4, label: 'Center Y', min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
    // AE's Optics Compensation, i.e. the rectilinear ↔ equidistant lens mapping
    // rather than Fisheye's `r·(1 + k·r²)` polynomial. Field of View is a real
    // angle: the focal length that spans it across the chosen dimension is
    // `f = halfDim / tan(fov/2)`, and the radial map is `f·tan(r/f)` to ADD
    // barrel or `f·atan(r/f)` to REMOVE it — exact inverses, so stacking the two
    // at the same FOV returns the plate. Distances are aspect-corrected half-height
    // units in the layer's own box, so the lens rides a moving/rotating layer.
    fragment: /* glsl */ `
vec4 fx(vec2 uv) {
  float fovDeg = clamp(uParams[0], 0.0, 179.0);
  if (fovDeg < 0.05) return texture2D(uTexture, uv);
  float ar = fxAspect();
  vec2 ctr = vec2(uParams[3], uParams[4]);
  vec2 p = (fxLocal(uv) - ctr) * vec2(ar, 1.0);
  float halfW = 0.5 * ar;
  int orient = int(uParams[1] + 0.5);
  float halfDim = orient == 0 ? halfW : (orient == 1 ? 0.5 : length(vec2(halfW, 0.5)));
  float f = halfDim / max(tan(0.5 * radians(fovDeg)), 1e-5);
  bool rev = uParams[2] > 0.5;
  // Fit solves s so the source's far corner lands exactly on the frame corner:
  // g(s·rc) = rc, i.e. s = g⁻¹(rc)/rc. Adding barrel that scales the plate down
  // (no empty corners); removing it scales up, so the pincushioned edges stay in.
  float s = 1.0;
  float rc = length(vec2(max(ctr.x, 1.0 - ctr.x) * ar, max(ctr.y, 1.0 - ctr.y)));
  if (uParams[5] > 0.5) {
    float inv = rev ? f * tan(min(rc / f, 1.5533)) : f * atan(rc / f);
    s = inv / max(rc, 1e-6);
  }
  s /= max(uParams[6], 0.01);
  float len = length(p);
  if (len > 1e-6) {
    float r = len * s;
    float rs = rev ? f * atan(r / f) : f * tan(min(r / f, 1.5533));
    p *= rs / len;
  }
  vec2 dst = vec2(p.x / ar, p.y) + ctr;
  if (dst.x < 0.0 || dst.x > 1.0 || dst.y < 0.0 || dst.y > 1.0) return vec4(0.0);
  return sampleClamped(uTexture, fxFrame(dst));
}
`,
  },
  {
    id: 'vignette',
    name: 'Vignette',
    group: 'Lens',
    animated: false,
    params: [
      { key: 'amount', slot: 0, label: 'Amount', min: 0, max: 1, step: 0.01, default: 0.6 },
      { key: 'radius', slot: 1, label: 'Radius', min: 0.1, max: 1.5, step: 0.01, default: 0.9 },
      { key: 'softness', slot: 2, label: 'Softness', min: 0.05, max: 1, step: 0.01, default: 0.45 },
    ],
    fragment: /* glsl */ `
vec4 fx(vec2 uv) {
  vec4 base = texture2D(uTexture, uv);
  float d = length(fxLocal(uv) - 0.5) * 1.41421;
  float v = smoothstep(uParams[1], uParams[1] - max(uParams[2], 1e-3), d);
  float vig = mix(1.0, v, clamp(uParams[0], 0.0, 1.0));
  return vec4(unpremult(base) * vig * base.a, base.a);
}
`,
  },
  {
    /*
     * Echo — the only TEMPORAL entry in this registry. It has no fx() of its
     * own: `temporal` routes it to Player.renderEchoStack, which owns the frame
     * ring, the pose evaluator and the fold. The pass-through fragment below is
     * a safety net, not the implementation — if the temporal branch is ever
     * skipped the effect renders as a no-op instead of throwing, which is the
     * failure mode a user can actually report.
     *
     * See echoEffect.js for the two engines and why the second one re-poses
     * rather than re-renders.
     */
    id: ECHO_EFFECT_ID,
    name: 'Echo',
    group: 'Motion',
    animated: true,
    temporal: 'echo',
    params: ECHO_PARAMS,
    fragment: /* glsl */ `
vec4 fx(vec2 uv) { return texture2D(uTexture, uv); }
`,
  },
  {
    /*
     * TimeShift — the ARRI TSB timing-shift box. The second TEMPORAL entry, and
     * it is temporal for a different reason than Echo: Echo needs the same plate
     * at N different times, this needs a DIFFERENT time at every pixel, because
     * travelling past a frame boundary in space means moving one frame back in
     * time. `temporal` routes it to Player.renderTimeShift, which owns the ring
     * atlas and the single streak pass.
     *
     * The pass-through fragment below is a safety net, not the implementation —
     * exactly as for Echo, so a missed dispatch is a no-op rather than a throw.
     *
     * See timeshiftEffect.js for why the ring is an atlas rather than N targets,
     * and why it is shallow enough to afford one.
     */
    id: TIMESHIFT_EFFECT_ID,
    name: 'TimeShift',
    group: 'Motion',
    animated: true,
    temporal: 'timeshift',
    params: TIMESHIFT_PARAMS,
    fragment: /* glsl */ `
vec4 fx(vec2 uv) { return texture2D(uTexture, uv); }
`,
  },
  {
    id: 'radialBlur',
    name: 'Radial Blur',
    group: 'Lens',
    animated: false,
    params: [
      { key: 'strength', slot: 0, label: 'Strength', min: 0, max: 60, step: 0.5, default: 16 },
      { key: 'centerX', slot: 1, label: 'Center X', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'centerY', slot: 2, label: 'Center Y', min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
    fragment: /* glsl */ `
vec4 fx(vec2 uv) {
  // Centre is authored in the layer's box, so it stays on the same part of the
  // artwork wherever the layer sits.
  vec2 dir = uv - fxFrame(vec2(uParams[1], uParams[2]));
  float strength = uParams[0] / 100.0;
  const int MAXN = 32;
  int n = int(mix(12.0, 32.0, clamp(uQuality, 0.0, 1.0)));
  vec4 acc = vec4(0.0);
  for (int i = 0; i < MAXN; i++) {
    if (i >= n) break;
    float t = float(i) / float(n - 1) - 0.5;
    acc += texture2D(uTexture, uv - dir * t * strength);
  }
  return acc / float(n);
}
`,
  },
  {
    id: 'sharpen',
    name: 'Sharpen',
    group: 'Lens',
    animated: false,
    params: [
      { key: 'amount', slot: 0, label: 'Amount', min: 0, max: 3, step: 0.05, default: 0.8 },
    ],
    fragment: /* glsl */ `
vec4 fx(vec2 uv) {
  vec2 px = 1.0 / uResolution;
  vec4 c = texture2D(uTexture, uv);
  vec3 cc = unpremult(c);
  vec3 nn = unpremult(texture2D(uTexture, uv + vec2(0.0, px.y)));
  vec3 ss = unpremult(texture2D(uTexture, uv - vec2(0.0, px.y)));
  vec3 ee = unpremult(texture2D(uTexture, uv + vec2(px.x, 0.0)));
  vec3 ww = unpremult(texture2D(uTexture, uv - vec2(px.x, 0.0)));
  vec3 col = clamp(cc + uParams[0] * (4.0 * cc - nn - ss - ee - ww), 0.0, 1.0);
  return vec4(col * c.a, c.a);
}
`,
  },

  // ── Distortion pack ──────────────────────────────────────────────────────────
  {
    id: 'mirror',
    name: 'Mirror',
    group: 'Distortion',
    animated: false,
    params: [
      { key: 'centerX', slot: 0, label: 'Center X', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'centerY', slot: 1, label: 'Center Y', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'angle', slot: 2, label: 'Angle', min: -180, max: 180, step: 1, default: 90, suffix: '°' },
      { key: 'side', slot: 3, label: 'Copy Side', type: 'select', default: 1,
        options: [
          { value: 1, label: 'Positive side' },
          { value: -1, label: 'Negative side' },
        ] },
      { key: 'feather', slot: 4, label: 'Seam Feather', min: 0, max: 12, step: 0.1, default: 0.8, suffix: '%' },
      { key: 'fade', slot: 5, label: 'Fade', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'fadeFrom', slot: 6, label: 'Fade From', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Seam outward' },
          { value: 1, label: 'Edge inward' },
          { value: 2, label: 'Down' },
          { value: 3, label: 'Up' },
          { value: 4, label: 'Left' },
          { value: 5, label: 'Right' },
        ] },
      { key: 'fadeLength', slot: 7, label: 'Fade Length', min: 1, max: 200, step: 1, default: 60, suffix: '%' },
      { key: 'fadeCurve', slot: 8, label: 'Fade Curve', min: 20, max: 400, step: 5, default: 100, suffix: '%' },
    ],
    // AE-style mirror: reflect one side of an arbitrary line across the other.
    // Work in aspect-correct coordinates so angles stay geometrically accurate.
    //
    // Fade dissolves the REFLECTED half only, which is what turns a mirror into a
    // floor reflection: the copy leaves the seam at full strength and falls away with
    // distance, so the original is never touched. "Seam outward" is measured along the
    // mirror normal (so it follows the seam at any angle); the compass directions are
    // frame-aligned for the common horizontal-floor case.
    fragment: /* glsl */ `
vec4 fx(vec2 uv) {
  float ar = fxAspect();
  vec2 center = vec2(uParams[0], uParams[1]);
  vec2 lp = fxLocal(uv);
  vec2 p = (lp - center) * vec2(ar, 1.0);
  float angle = radians(uParams[2]);
  vec2 normal = vec2(cos(angle), sin(angle));
  float distanceToLine = dot(p, normal);
  vec2 reflectedPoint = p - 2.0 * distanceToLine * normal;
  vec2 reflectedUv = fxFrame(reflectedPoint / vec2(ar, 1.0) + center);

  vec4 original = texture2D(uTexture, uv);
  vec4 reflected = texture2D(uTexture, clamp(reflectedUv, 0.0, 1.0));

  float fadeAmt = clamp(uParams[5] / 100.0, 0.0, 1.0);
  if (fadeAmt > 0.001) {
    float span = max(uParams[7] / 100.0, 0.001);
    float mode = uParams[6];
    float d;
    if (mode < 0.5)      d = abs(distanceToLine) / span;          // seam outward
    else if (mode < 1.5) d = 1.0 - abs(distanceToLine) / span;    // edge inward
    else if (mode < 2.5) d = (1.0 - lp.y) / span;                 // down (lp.y is up)
    else if (mode < 3.5) d = lp.y / span;                         // up
    else if (mode < 4.5) d = lp.x / span;                         // left
    else                 d = (1.0 - lp.x) / span;                 // right
    float k = pow(clamp(d, 0.0, 1.0), max(uParams[8] / 100.0, 0.05));
    // Premultiplied fade: scaling rgba together keeps edges clean over transparency.
    reflected *= 1.0 - fadeAmt * k;
  }

  float copiedSide = step(0.0, distanceToLine * uParams[3]);
  vec4 mirrored = mix(original, reflected, copiedSide);

  float feather = max(uParams[4] / 100.0, 1e-5);
  float awayFromSeam = smoothstep(0.0, feather, abs(distanceToLine));
  vec4 seamAverage = mix(original, reflected, 0.5);
  return mix(seamAverage, mirrored, awayFromSeam);
}
`,
  },
  {
    id: 'waveWarp',
    name: 'Wave Warp',
    group: 'Distortion',
    animated: true,
    params: [
      { key: 'waveType', slot: 0, label: 'Wave Type', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Sine' },
          { value: 1, label: 'Triangle' },
          { value: 2, label: 'Square' },
          { value: 3, label: 'Sawtooth' },
        ] },
      { key: 'height', slot: 1, label: 'Wave Height', min: 0, max: 30, step: 0.5, default: 7.5, suffix: '%' },
      { key: 'width', slot: 2, label: 'Wave Width', min: 3, max: 150, step: 0.5, default: 28, suffix: '%' },
      { key: 'direction', slot: 3, label: 'Direction', min: -180, max: 180, step: 1, default: 0, suffix: '°' },
      { key: 'phase', slot: 4, label: 'Phase', min: -180, max: 180, step: 1, default: 0, suffix: '°' },
      { key: 'speed', slot: 5, label: 'Wave Speed', min: -3, max: 3, step: 0.05, default: 0.8, suffix: 'x' },
      { key: 'pinning', slot: 6, label: 'Edge Pinning', min: 0, max: 30, step: 0.5, default: 6, suffix: '%' },
      { key: 'antialias', slot: 7, label: 'Antialias', min: 0, max: 100, step: 1, default: 100, suffix: '%' },
    ],
    // Core AE Wave Warp model: a travelling waveform displaces pixels
    // perpendicular to its direction, with optional damping at the frame edges.
    fragment: /* glsl */ `
float wwWave(float x, float waveType, float antialias) {
  float sineWave = sin(x);
  if (waveType < 0.5) return sineWave;
  if (waveType < 1.5) return asin(sineWave) * 0.63661977;
  if (waveType < 2.5) return mix(sign(sineWave), sineWave, antialias * 0.08);
  return 2.0 * fract(x / 6.2831853) - 1.0;
}

vec4 fx(vec2 uv) {
  float ar = fxAspect();
  vec2 lp = fxLocal(uv);
  vec2 p = (lp - 0.5) * vec2(ar, 1.0);
  float direction = radians(uParams[3]);
  vec2 travel = vec2(cos(direction), sin(direction));
  vec2 displacementDirection = vec2(-travel.y, travel.x);
  float coordinate = dot(p, travel);
  float waveWidth = max(uParams[2] / 100.0, 0.001);
  float wavePhase = coordinate / waveWidth * 6.2831853
    - uTime * uParams[5] * 6.2831853
    + radians(uParams[4]);
  float wave = wwWave(wavePhase, uParams[0], uParams[7] / 100.0);

  // Pinning damps the wave at the edges of the layer's own box, so a warped
  // shape stays anchored at its own border rather than at the frame's.
  float edgeDistance = min(min(lp.x, 1.0 - lp.x), min(lp.y, 1.0 - lp.y));
  float pinning = uParams[6] / 100.0;
  float pinned = pinning <= 0.0001 ? 1.0 : smoothstep(0.0, pinning, edgeDistance);
  vec2 sampleLocal = lp - displacementDirection * wave * (uParams[1] / 100.0)
    * pinned / vec2(ar, 1.0);
  return texture2D(uTexture, clamp(fxFrame(sampleLocal), 0.0, 1.0));
}
`,
  },
  {
    id: 'warpStyles',
    name: 'Warp Styles',
    group: 'Distortion',
    animated: false,
    // A warp deliberately pushes artwork outside the box it started in — an arc
    // lifts the middle of the layer clear of its own top edge — so it must not be
    // held inside the matte.
    layerMatte: 'expand',
    params: [
      { key: 'style', slot: 0, label: 'Style', type: 'select', default: 0, primary: true,
        options: [
          { value: 0, label: 'Arc' },
          { value: 1, label: 'Arc Upper' },
          { value: 2, label: 'Arc Lower' },
          { value: 3, label: 'Arch' },
          { value: 4, label: 'Bulge' },
          { value: 5, label: 'Flag' },
          { value: 6, label: 'Wave' },
          { value: 7, label: 'Fish' },
          { value: 8, label: 'Rise' },
          { value: 9, label: 'Inflate' },
          { value: 10, label: 'Squeeze' },
          { value: 11, label: 'Twist' },
        ] },
      { key: 'bend', slot: 1, label: 'Bend', min: -100, max: 100, step: 1, default: 40, suffix: '%' },
      { key: 'distortH', slot: 2, label: 'Horizontal Distortion', min: -100, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'distortV', slot: 3, label: 'Vertical Distortion', min: -100, max: 100, step: 1, default: 0, suffix: '%' },
    ],
    // The AE "Warp" effect's preset shapes, ported from html/distort-lab.html
    // (`wStyle`). The lab draws them as a FORWARD warp — it moves the vertices of
    // a 168² mesh — which this chain has no way to do: it is fragment-only over a
    // full-frame plate. So the map is INVERTED here instead, per fragment, and the
    // inversion is exact rather than iterative for nine of the twelve styles:
    // every bend style leaves x untouched and is affine in y (cy = y·(1+k1) + k0),
    // and the two perspective lines invert in closed form because the second one
    // already uses the FINAL x. Inflate, Squeeze and Twist keep a small solver
    // each, and every style is gated on a forward re-check (see fx below).
    // Working in the layer box's own 0..1 space, +y down, is what let the lab
    // maths port with no sign flips.
    fragment: /* glsl */ `
float wsSafe(float d) { return abs(d) < 1e-4 ? (d < 0.0 ? -1e-4 : 1e-4) : d; }

vec2 wsFwd(vec2 p) {
  int st = int(uParams[0] + 0.5);
  float bend = uParams[1] * 0.01, dh = uParams[2] * 0.01, dv = uParams[3] * 0.01;
  vec2 c = p * 2.0 - 1.0;
  float x = c.x, y = c.y, off = 0.0;
  if (st == 0) off = -bend * (1.0 - x * x);
  else if (st == 1) off = -bend * (1.0 - x * x) * (0.5 - 0.5 * y);
  else if (st == 2) off = -bend * (1.0 - x * x) * (0.5 + 0.5 * y);
  else if (st == 3) off = -bend * (1.0 - x * x) * (0.75 - 0.25 * y);
  else if (st == 4) off = bend * (1.0 - x * x) * y;
  else if (st == 5) off = bend * sin(x * 4.71238898) * (0.55 + 0.45 * (0.5 + 0.5 * y));
  else if (st == 6) off = bend * sin(x * 6.28318531);
  else if (st == 7) off = bend * y * (1.0 - abs(x));
  else if (st == 8) off = -bend * (0.5 + 0.5 * x) * (0.5 + 0.5 * x);
  c.y += off;
  if (st == 9) c *= 1.0 + bend * (1.0 - 0.35 * (x * x + y * y));
  else if (st == 10) {
    c.x *= 1.0 - bend * (1.0 - y * y);
    c.y *= 1.0 - bend * 0.35 * (1.0 - x * x);
  } else if (st == 11) {
    float a = bend * y * 1.4, sa = sin(a), ca = cos(a);
    c = vec2(ca * c.x - sa * c.y, sa * c.x + ca * c.y);
  }
  c.x *= 1.0 + dh * c.y * 0.6;
  c.y *= 1.0 + dv * c.x * 0.6;
  return c * 0.5 + 0.5;
}

vec2 wsInv(vec2 p) {
  int st = int(uParams[0] + 0.5);
  float bend = uParams[1] * 0.01, dh = uParams[2] * 0.01, dv = uParams[3] * 0.01;
  vec2 d = p * 2.0 - 1.0;
  // Perspective first, and exactly: the forward pass scales y by the ALREADY
  // scaled x, so that x is the destination's own and both lines just divide out.
  float cy = d.y / wsSafe(1.0 + dv * d.x * 0.6);
  float cx = d.x / wsSafe(1.0 + dh * cy * 0.6);
  float x = cx, y = cy;
  if (st < 9) {
    // Bend styles: x survives, and the y offset is affine in y for every one of
    // them, so a single divide undoes all nine.
    float A = -bend * (1.0 - x * x);
    float k0 = 0.0, k1 = 0.0;
    if (st == 0) k0 = A;
    else if (st == 1) { k0 = 0.5 * A; k1 = -0.5 * A; }
    else if (st == 2) { k0 = 0.5 * A; k1 = 0.5 * A; }
    else if (st == 3) { k0 = 0.75 * A; k1 = -0.25 * A; }
    else if (st == 4) k1 = bend * (1.0 - x * x);
    else if (st == 5) { float C = bend * sin(x * 4.71238898); k0 = 0.775 * C; k1 = 0.225 * C; }
    else if (st == 6) k0 = bend * sin(x * 6.28318531);
    else if (st == 7) k1 = bend * (1.0 - abs(x));
    else if (st == 8) k0 = -bend * (0.5 + 0.5 * x) * (0.5 + 0.5 * x);
    y = (cy - k0) / wsSafe(1.0 + k1);
  } else if (st == 9) {
    // Inflate is radial: the direction is untouched and the radius follows
    // r' = r(1+bend) - 0.35·bend·r³. Newton on that cubic, clamped to the branch
    // where it still rises — past the turning point the corners fold over and no
    // preimage exists at all.
    float rp = length(vec2(cx, cy));
    if (rp > 1e-5) {
      float rmax = 4.0;
      if (bend > 1e-4) rmax = sqrt((1.0 + bend) / (1.05 * bend));
      float r = min(rp / max(1.0 + bend, 0.05), rmax);
      for (int i = 0; i < 8; i++) {
        float g = r * (1.0 + bend) - 0.35 * bend * r * r * r - rp;
        float gp = (1.0 + bend) - 1.05 * bend * r * r;
        r = clamp(r - g / wsSafe(gp), 0.0, rmax);
      }
      x = cx * (r / rp);
      y = cy * (r / rp);
    } else { x = 0.0; y = 0.0; }
  } else if (st == 10) {
    // Squeeze is the one style whose axes are coupled — each is scaled by a
    // function of the OTHER — so it needs a real 2D Newton. Eight steps; the
    // clamp only keeps a folded setting from running off to infinity.
    for (int i = 0; i < 8; i++) {
      float sx = 1.0 - bend * (1.0 - y * y);
      float sy = 1.0 - bend * 0.35 * (1.0 - x * x);
      float rx = x * sx - cx, ry = y * sy - cy;
      float j01 = 2.0 * bend * x * y, j10 = 0.7 * bend * x * y;
      float det = wsSafe(sx * sy - j01 * j10);
      x = clamp(x - (sy * rx - j01 * ry) / det, -4.0, 4.0);
      y = clamp(y - (sx * ry - j10 * rx) / det, -4.0, 4.0);
    }
  } else {
    // Twist only turns a point about the centre, so the radius survives and only
    // the angle is unknown: with u the source angle it reads phi = u + e·sin(u),
    // e = 1.4·bend·r — Kepler's equation. Bisection rather than Newton, because
    // past |e| = 1 the twist folds over itself and Newton bolts to a far branch,
    // while the bracket [phi-|e|, phi+|e|] always straddles a root.
    float r = length(vec2(cx, cy));
    if (r > 1e-6) {
      float phi = atan(cy, cx);
      float e = 1.4 * bend * r;
      float lo = phi - abs(e), hi = phi + abs(e);
      for (int i = 0; i < 24; i++) {
        float m = 0.5 * (lo + hi);
        if (m + e * sin(m) - phi < 0.0) lo = m; else hi = m;
      }
      float u = 0.5 * (lo + hi);
      x = r * cos(u);
      y = r * sin(u);
    } else { x = 0.0; y = 0.0; }
  }
  return vec2(x, y) * 0.5 + 0.5;
}

vec4 fx(vec2 uv) {
  if (abs(uParams[1]) + abs(uParams[2]) + abs(uParams[3]) < 0.05) return texture2D(uTexture, uv);
  // fxLocal is y-UP (it comes from the projected quad, and frame uv puts 1 at the
  // top); the lab's box space is y-DOWN. Without this flip every style is mirrored
  // vertically — Arc Upper would bend the bottom and Rise would drop the right.
  vec2 lp = fxLocal(uv);
  lp.y = 1.0 - lp.y;
  vec2 src = wsInv(lp);
  if (src.x < -0.002 || src.x > 1.002 || src.y < -0.002 || src.y > 1.002) return vec4(0.0);
  // Re-applying the forward map is the cheap proof that this fragment really has
  // a preimage. Three styles fold at extreme settings, and a folded fragment's
  // solve lands somewhere arbitrary; without this it would smear that wrong
  // sample across the frame instead of drawing nothing.
  vec2 back = wsFwd(src);
  if (distance(back, lp) > 0.01) return vec4(0.0);
  // One-pixel feather on the source box's edge, so a layer whose artwork runs to
  // its own border does not come back with a hard stair-stepped rim. The width
  // comes from the forward Jacobian (two more evaluations of a few flops each)
  // rather than fwidth(), which needs a derivatives extension this ES 1.00 chain
  // does not enable — and it has to, because a warp magnifies locally and a
  // fixed feather would smear where it stretches.
  float h = 1e-3;
  vec2 jx = (wsFwd(src + vec2(h, 0.0)) - back) / h;
  vec2 jy = (wsFwd(src + vec2(0.0, h)) - back) / h;
  float det = abs(wsSafe(jx.x * jy.y - jx.y * jy.x));
  vec2 texel = 1.0 / max(uFxSizePx, vec2(1.0));
  vec2 w = clamp(vec2(
    abs(jy.y) * texel.x + abs(jy.x) * texel.y,
    abs(jx.y) * texel.x + abs(jx.x) * texel.y
  ) / det, vec2(1e-4), vec2(0.25));
  vec2 m = smoothstep(vec2(0.0), w, src) * (1.0 - smoothstep(1.0 - w, vec2(1.0), src));
  float edge = m.x * m.y;
  if (edge <= 0.0) return vec4(0.0);
  return texture2D(uTexture, fxFrame(vec2(src.x, 1.0 - src.y))) * edge;
}
`,
  },
  {
    id: 'shockwave',
    name: 'Shockwave',
    group: 'Distortion',
    animated: true,
    params: [
      { key: 'speed', slot: 0, label: 'Speed', min: 0.1, max: 3, step: 0.05, default: 1 },
      { key: 'width', slot: 1, label: 'Width', min: 0.01, max: 0.3, step: 0.005, default: 0.08 },
      { key: 'amplitude', slot: 2, label: 'Amplitude', min: 0, max: 60, step: 1, default: 24, suffix: 'px' },
      { key: 'centerX', slot: 3, label: 'Center X', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'centerY', slot: 4, label: 'Center Y', min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
    fragment: /* glsl */ `
vec4 fx(vec2 uv) {
  float ar = fxAspect();
  vec2 lp = fxLocal(uv);
  vec2 d = (lp - vec2(uParams[3], uParams[4])) * vec2(ar, 1.0);
  float dist = length(d);
  float ring = fract(uTime * uParams[0] * 0.35);
  float edge = smoothstep(max(uParams[1], 1e-3), 0.0, abs(dist - ring));
  float fade = 1.0 - ring;
  vec2 push = (d / max(dist, 1e-4)) / vec2(ar, 1.0) * edge * fade * (uParams[2] / 100.0);
  return texture2D(uTexture, fxFrame(lp - push));
}
`,
  },

  // ── Wave Lines ──────────────────────────────────────────────────────────────
  {
    id: 'waveLines',
    name: 'Wave Lines',
    group: 'Distortion',
    animated: true,
    params: [
      { key: 'lines', slot: 0, label: 'Line Count', min: 20, max: 300, step: 2, default: 170 },
      { key: 'lineSharp', slot: 1, label: 'Line Thinness', min: 0.5, max: 8, step: 0.1, default: 3 },
      { key: 'lineMix', slot: 2, label: 'Line Mix', min: 0, max: 100, step: 2, default: 90, suffix: '%' },
      { key: 'contourMix', slot: 3, label: 'Contour Rings', min: 0, max: 100, step: 2, default: 55, suffix: '%' },
      { key: 'rings', slot: 4, label: 'Ring Count', min: 6, max: 80, step: 1, default: 44 },
      { key: 'waveAmp', slot: 5, label: 'Wave Amount', min: 0, max: 150, step: 2, default: 40, suffix: '%' },
      { key: 'waveScale', slot: 6, label: 'Wave Scale', min: 1, max: 16, step: 0.5, default: 5.5 },
      { key: 'waveSpeed', slot: 7, label: 'Wave Drift', min: 0, max: 2, step: 0.05, default: 0.55, suffix: 'x' },
      { key: 'fieldSize', slot: 8, label: 'Contour Field', min: 8, max: 140, step: 2, default: 46, suffix: 'px' },
      { key: 'sourceMode', slot: 9, label: 'Source Mask', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Auto / luminance' },
          { value: 1, label: 'Alpha' },
          { value: 2, label: 'Luminance' },
        ] },
      { key: 'sourceThreshold', slot: 10, label: 'Mask Threshold', min: 0, max: 100, step: 1, default: 8, suffix: '%' },
    ],
    // The reference first creates a true blurred coverage field, then bends a
    // horizontal scanline phase toward contour rings from that field. Keep the
    // same two-stage structure here: horizontal Gaussian mask pass followed by
    // the vertical completion and the original line equations.
    prePass: /* glsl */ `
float wlMask(vec4 s) {
  float mode = uParams[9];
  if (mode > 0.5 && mode < 1.5) return s.a;
  float threshold = clamp(uParams[10] / 100.0, 0.0, 0.99);
  float lumMask = smoothstep(threshold, 1.0, luma(unpremult(s))) * s.a;
  if (mode > 1.5) return lumMask;
  return min(s.a, lumMask);
}

vec4 fx(vec2 uv) {
  float radius = max(uParams[8], 1.0) * (uResolution.y / 1080.0);
  const int MAX_TAPS = 49;
  int half_ = 24;
  float acc = 0.0;
  float ws = 0.0;
  for (int i = 0; i < MAX_TAPS; i++) {
    if (i > 2 * half_) break;
    float q = (float(i) - float(half_)) / float(half_);
    float w = exp(-2.0 * q * q);
    vec2 suv = uv + vec2(q * 2.0 * radius / uResolution.x, 0.0);
    vec4 sampleColor = (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0)
      ? vec4(0.0)
      : texture2D(uTexture, suv);
    acc += wlMask(sampleColor) * w;
    ws += w;
  }
  float field = acc / max(ws, 1e-4);
  return vec4(field);
}
`,
    fragment: /* glsl */ `
float wlNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float wlFbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { v += a * wlNoise(p); p *= 2.03; a *= 0.5; }
  return v;
}

float wlField(vec2 uv) {
  float radius = max(uParams[8], 1.0) * (uResolution.y / 1080.0);
  const int MAX_TAPS = 49;
  int half_ = 24;
  float acc = 0.0;
  float ws = 0.0;
  for (int i = 0; i < MAX_TAPS; i++) {
    if (i > 2 * half_) break;
    float q = (float(i) - float(half_)) / float(half_);
    float w = exp(-2.0 * q * q);
    vec2 suv = uv + vec2(0.0, q * 2.0 * radius / uResolution.y);
    float sampleField = (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0)
      ? 0.0
      : texture2D(uTexture, suv).a;
    acc += sampleField * w;
    ws += w;
  }
  return acc / max(ws, 1e-4);
}

vec4 fx(vec2 uv) {
  float lines = max(uParams[0], 1.0);
  float lineSharp = max(uParams[1], 0.5);
  float lineMix = clamp(uParams[2] / 100.0, 0.0, 1.0);
  float contourMix = clamp(uParams[3] / 100.0, 0.0, 1.0);
  float rings = max(uParams[4], 1.0);
  float waveAmp = uParams[5] / 100.0;
  float waveScale = max(uParams[6], 0.2);
  float t = uTime * uParams[7];

  // Line phase and the wobble noise live in the layer's box; the coverage field
  // is read from the plate, since it is the layer's own alpha either way.
  vec2 lp = fxLocal(uv);
  float aspect = fxAspect();
  vec2 pos = vec2(lp.x * aspect, lp.y);
  float wob = (
    wlFbm(vec2(pos.x * waveScale * 1.4, pos.y * waveScale * 0.5 + t * 0.35)) - 0.5
  ) * waveAmp;
  float field = wlField(uv);

  float horizontal = (lp.y + wob * 0.05) * lines;
  float contour = (1.0 - field) * rings + wob * 2.0;
  float phase = mix(horizontal, contour, contourMix);
  float stripeWave = 0.5 + 0.5 * cos(phase * 6.2831853);
  float stripes = pow(stripeWave, lineSharp);

  vec4 base = texture2D(uSource, uv);
  return base * mix(1.0, stripes, lineMix);
}
`,
  },

  // ── Wave Ripple ─────────────────────────────────────────────────────────────
  {
    id: 'waveRipple',
    name: 'Wave Ripple',
    group: 'Distortion',
    animated: true,
    params: [
      { key: 'lines', slot: 0, label: 'Line Count', min: 40, max: 600, step: 5, default: 300 },
      { key: 'thinness', slot: 1, label: 'Line Thinness', min: 0.5, max: 8, step: 0.1, default: 4.8 },
      { key: 'lineMix', slot: 2, label: 'Line Mix', min: 0, max: 100, step: 2, default: 42, suffix: '%' },
      { key: 'contourMix', slot: 3, label: 'Contour Rings', min: 0, max: 100, step: 2, default: 30, suffix: '%' },
      { key: 'rings', slot: 4, label: 'Ring Count', min: 6, max: 120, step: 1, default: 43 },
      { key: 'waveAmp', slot: 5, label: 'Wave Amount', min: 0, max: 150, step: 2, default: 40, suffix: '%' },
      { key: 'waveScale', slot: 6, label: 'Wave Scale', min: 1, max: 16, step: 0.5, default: 7.5 },
      { key: 'drift', slot: 7, label: 'Wave Drift', min: 0, max: 2, step: 0.05, default: 0.3, suffix: 'x' },
    ],
    // The "arena" wave-line stage, ported from html/wave-ripple-text.html: the
    // content is carved into fine scanlines whose phase wobbles on drifting fbm
    // noise, blended with contour rings derived from a cheap blurred-coverage
    // field, and the content itself undulates slightly with the same waves.
    // Coverage is alpha × brightness, so the rings bend around text over a
    // transparent stack and around bright shapes over opaque footage. Line
    // carving scales the premultiplied colour, so gaps go transparent where
    // the stack is transparent and read as dark scanlines over video.
    fragment: /* glsl */ `
float wrNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float wrFbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { v += a * wrNoise(p); p *= 2.03; a *= 0.5; }
  return v;
}

vec4 fx(vec2 uv) {
  float lines  = max(uParams[0], 1.0);
  float sharpv = max(uParams[1], 0.5);
  float lnMix  = clamp(uParams[2] / 100.0, 0.0, 1.0);
  float ctMix  = clamp(uParams[3] / 100.0, 0.0, 1.0);
  float rings  = max(uParams[4], 1.0);
  float amp    = uParams[5] / 100.0;
  float wscale = max(uParams[6], 0.2);
  float t      = uTime * uParams[7];
  vec2 lp = fxLocal(uv);
  float ar = fxAspect();
  vec2 pos = vec2(lp.x * ar, lp.y);

  // Shared wobble (same formula as the prototype) + a gentle content warp.
  float wob = (wrFbm(vec2(pos.x * wscale * 1.4, pos.y * wscale * 0.5 + t * 0.35)) - 0.5) * amp;
  float wob2 = (wrFbm(vec2(pos.y * wscale * 0.9 + 7.3, t * 0.28)) - 0.5) * amp;
  vec2 wuv = uv + fxDir(vec2(wob * 0.012, wob2 * 0.008));
  vec4 base = texture2D(uTexture, wuv);

  // Contour field: blurred coverage of the content (alpha × brightness), the
  // cheap stand-in for the prototype's pre-blurred text raster.
  // NOTE: no per-pixel spiral jitter here — the field feeds the ring phase
  // (× ring count), so any pixel-level noise in it scrambles the stripes into
  // speckle. A fixed spiral keeps the field smooth; its residual pattern only
  // wiggles the rings slightly, which the waves hide anyway.
  const int MAXN = 20;
  int n = int(mix(10.0, 20.0, clamp(uQuality, 0.0, 1.0)));
  vec2 px = (uResolution.y * 0.05) / uResolution;
  float fsum = 0.0, fw = 0.0;
  for (int i = 0; i < MAXN; i++) {
    if (i >= n) break;
    float fi = float(i);
    float r = sqrt((fi + 0.5) / float(n));
    float an = fi * 2.399963;
    vec4 s = texture2D(uTexture, wuv + vec2(cos(an), sin(an)) * r * px);
    float w = 1.0 - r * 0.7;
    fsum += s.a * clamp(luma(unpremult(s)) * 1.5, 0.0, 1.0) * w;
    fw += w;
  }
  float field = fsum / max(fw, 1e-4);

  // Scanline phase: wavy horizontal lines blended with contour rings.
  float horiz = (lp.y + wob * 0.05) * lines;
  float cont = (1.0 - field) * rings + wob * 2.0;
  float phase = mix(horiz, cont, ctMix);
  float s01 = 0.5 + 0.5 * cos(phase * 6.2831853);
  float stripes = pow(s01, sharpv);

  return base * mix(1.0, stripes, lnMix);
}
`,
  },

  // ── Fill ──────────────────────────────────────────────────────────────────
  {
    /*
     * Fill — After Effects' Fill: paint one colour over everything the layer
     * (or, on an adjustment layer, the stack below) covers, keeping its alpha.
     * The colour meets the original through a blend mode, so Multiply tints and
     * Screen lifts instead of flattening; Normal is the flat AE default. The
     * card's Mix is the fill's opacity, which is why there is no second knob.
     *
     * Alpha discipline: the blend runs on unpremultiplied colour and the result
     * is premultiplied by the SOURCE alpha untouched — so a soft edge, a keyed
     * subject or a text outline stays exactly as transparent as it was, and a
     * fully transparent pixel stays transparent whatever the colour. The Color
     * mode is the HSL "setLum + clipColor" pair, so the fill's hue and
     * saturation land at the source's own luminance.
     *
     * Deliberately NOT in LAYER_CLIP_BY_DEFAULT: the body never writes outside
     * the source alpha, and the matte clip multiplies premultiplied rgba by
     * matte.a a second time, which squares the alpha of a half-transparent
     * layer (measured: a 50 % plate came back at 25 %). Self-clipping is exact.
     */
    id: 'fill',
    name: 'Fill',
    group: 'Color',
    animated: false,
    params: [
      { key: 'color', type: 'color', label: 'Color', default: '#ff3d3d' },
      { key: 'blend', slot: 0, label: 'Blend Mode', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Normal' },
          { value: 1, label: 'Multiply' },
          { value: 2, label: 'Screen' },
          { value: 3, label: 'Overlay' },
          { value: 4, label: 'Soft Light' },
          { value: 5, label: 'Hard Light' },
          { value: 6, label: 'Add' },
          { value: 7, label: 'Lighten' },
          { value: 8, label: 'Darken' },
          { value: 9, label: 'Difference' },
          { value: 10, label: 'Color' },
        ] },
    ],
    fragment: /* glsl */ `
// HSL clip after a luminance move: pull the colour back into 0..1 toward its
// luma without changing that luma (the W3C compositing clipColor).
vec3 fillClipColor(vec3 c) {
  float l = luma(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-5);
  x = max(c.r, max(c.g, c.b));
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-5);
  return c;
}
vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  vec3 b = clamp(unpremult(src), 0.0, 1.0);
  vec3 s = clamp(uColor, 0.0, 1.0);
  float bm = uParams[0];
  vec3 r;
  if (bm < 0.5)      r = s;
  else if (bm < 1.5) r = b * s;
  else if (bm < 2.5) r = 1.0 - (1.0 - b) * (1.0 - s);
  else if (bm < 3.5) r = mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(vec3(0.5), b));
  else if (bm < 4.5) r = mix(2.0 * b * s + b * b * (1.0 - 2.0 * s),
                             sqrt(b) * (2.0 * s - 1.0) + 2.0 * b * (1.0 - s), step(vec3(0.5), s));
  else if (bm < 5.5) r = mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(vec3(0.5), s));
  else if (bm < 6.5) r = min(b + s, 1.0);
  else if (bm < 7.5) r = max(b, s);
  else if (bm < 8.5) r = min(b, s);
  else if (bm < 9.5) r = abs(b - s);
  else               r = fillClipColor(s + (luma(b) - luma(s)));
  return premult(clamp(r, 0.0, 1.0), src.a);
}
`,
  },

  // ── Shape Rulers ──────────────────────────────────────────────────────────
  {
    /*
     * Shape Rulers — full-frame guide lines on the layer's four edges with a mark
     * on every corner, like a design tool's selection guides. Look-dev:
     * html/shape-rulers-lab.html (the reference is an After Effects edit).
     *
     * It has NO animation of its own. Every frame the guides are rebuilt from the
     * layer's projected box (fxLocal / uFxSizePx), so moving, scaling or rotating
     * the layer is the only thing that moves them — and a keyframed layer drags
     * them along exactly. Maths is in box pixels (y up) so it ports to the TSL
     * twin verbatim; sizes are authored at 1080p and scale with the target's
     * short side.
     *
     * `usesContentBox`: a text layer draws on a plate far bigger than its words,
     * so the Player narrows the box to the laid-out block (the rect the selection
     * gizmo shows) through uParams[24..27], in box uv. Every other layer fills its
     * plate and gets the whole box.
     *
     * `layerMatte: 'expand'` — the guides run far outside the layer's silhouette,
     * which is the point; clipping would leave only the part over the artwork.
     * Layer scope only: an adjustment layer has no box to measure.
     */
    id: 'shapeRulers',
    name: 'Shape Rulers',
    group: 'Graphic',
    scopes: ['layer'],
    layerMatte: 'expand',
    usesContentBox: true,
    animated: false,
    params: [
      { key: 'spacingX', slot: 0, label: 'Spacing Horizontal', min: -200, max: 400, step: 1, default: 0, suffix: 'px' },
      { key: 'spacingY', slot: 1, label: 'Spacing Vertical', min: -200, max: 400, step: 1, default: 0, suffix: 'px' },
      { key: 'rotation', slot: 13, label: 'Rotation', type: 'select', default: 1,
        options: [
          { value: 1, label: 'Follow the layer' },
          { value: 0, label: 'Frame-aligned bounds' },
        ] },
      { key: 'lineColor', type: 'color', colorSlot: 0, label: 'Line Color', default: '#ffffff' },
      { key: 'lineWidth', slot: 2, label: 'Line Width', min: 0.5, max: 12, step: 0.25, default: 1.5, suffix: 'px' },
      { key: 'lineOpacity', slot: 3, label: 'Line Opacity', min: 0, max: 100, step: 1, default: 90, suffix: '%' },
      { key: 'extend', slot: 4, label: 'Lines Extend', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Full frame' },
          { value: 1, label: 'Past the corners' },
          { value: 2, label: 'Box outline only' },
        ] },
      { key: 'extendLength', slot: 5, label: 'Extend Length', min: 0, max: 1000, step: 1, default: 90, suffix: 'px',
        showIf: { key: 'extend', equals: 1 } },
      { key: 'dash', slot: 6, label: 'Dash', min: 0, max: 60, step: 1, default: 0, suffix: 'px' },
      { key: 'markShape', slot: 7, label: 'Corner Shape', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Square' },
          { value: 1, label: 'Circle' },
          { value: 2, label: 'Diamond' },
          { value: 3, label: 'Square outline' },
          { value: 4, label: 'Circle outline' },
          { value: 5, label: 'Cross' },
          { value: 6, label: 'Corner bracket' },
          { value: 7, label: 'None' },
        ] },
      { key: 'markColor', type: 'color', colorSlot: 1, label: 'Corner Color', default: '#ffffff' },
      { key: 'markWidth', slot: 8, label: 'Corner Width', min: 2, max: 120, step: 1, default: 15, suffix: 'px',
        showIf: { key: 'markShape', oneOf: [0, 1, 2, 3, 4, 5, 6] } },
      { key: 'markHeight', slot: 9, label: 'Corner Height', min: 2, max: 120, step: 1, default: 15, suffix: 'px',
        showIf: { key: 'markShape', oneOf: [0, 1, 2, 3, 4, 5, 6] } },
      { key: 'markRadius', slot: 10, label: 'Corner Radius', min: 0, max: 60, step: 0.5, default: 1, suffix: 'px',
        showIf: { key: 'markShape', oneOf: [0, 3] } },
      { key: 'markStroke', slot: 11, label: 'Corner Stroke', min: 0.5, max: 16, step: 0.25, default: 2.5, suffix: 'px',
        showIf: { key: 'markShape', oneOf: [3, 4, 5, 6] } },
      { key: 'midMarks', slot: 12, label: 'Mid-edge Marks', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Off' },
          { value: 1, label: 'On' },
        ] },
    ],
    fragment: /* glsl */ `
${SHAPE_RULERS_GLSL}
vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  float k = min(uResolution.x, uResolution.y) / 1080.0;
  // The layer's own rect inside its box (box uv, y up); unset = the whole box.
  vec4 rc = vec4(uParams[24], uParams[25], uParams[26], uParams[27]);
  if (rc.z - rc.x < 1e-5 || rc.w - rc.y < 1e-5) rc = vec4(0.0, 0.0, 1.0, 1.0);
  vec2 q = (fxLocal(uv) - 0.5 * (rc.xy + rc.zw)) * uFxSizePx;
  vec2 hb = 0.5 * (rc.zw - rc.xy) * uFxSizePx;
  if (uParams[13] < 0.5) {
    // Frame-aligned: turn box pixels back to frame axes, and frame the rotated
    // rect with its axis-aligned bounds.
    vec2 ax = uFxAxisX * uResolution;
    float th = atan(ax.y, ax.x);
    float c = cos(th), s = sin(th);
    q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
    hb = vec2(abs(c) * hb.x + abs(s) * hb.y, abs(s) * hb.x + abs(c) * hb.y);
  }
  vec2 H = max(hb + vec2(uParams[0], uParams[1]) * k, vec2(0.5));
  float ext = uParams[4] < 0.5 ? 1e6 : (uParams[4] < 1.5 ? uParams[5] * k : 0.0);
  vec2 cov = srCoverage(q, H, uParams[2] * k, ext, uParams[6] * k, uParams[7],
    max(vec2(uParams[8], uParams[9]) * 0.5 * k, vec2(0.25)), uParams[10] * k,
    max(uParams[11] * k, 0.25), uParams[12]);
  float lines = cov.x * clamp(uParams[3] / 100.0, 0.0, 1.0);
  // Premultiplied "over": the guides land on the transparent field around the
  // layer as much as on the artwork.
  vec4 o = src * (1.0 - lines) + vec4(uColors[0] * lines, lines);
  return o * (1.0 - cov.y) + vec4(uColors[1] * cov.y, cov.y);
}
`,
  },

  // ── Copy Color Profile ────────────────────────────────────────────────────
  {
    /*
     * Copy Color Profile — take another LAYER's colour profile (mean + spread per
     * channel, alpha-weighted) and move this content's distribution onto it.
     * Ported verbatim from html/copy-color-profile.html (tune there first).
     *
     * `usesLayerRef` names the param that holds the reference layer's item id.
     * The Player pre-renders that layer's isolate into a keyed pass-pool target
     * each frame and hands it to the chain as the `ref` buffer (with its
     * projected box); no reference under the playhead = exact bypass.
     *
     * Two stats passes write a 4×1 RGBA8 target each (`size`), walking an N×N
     * grid over the plate's box (`region` → uParams[24..27]) and packing
     * mean.xyz / sd.xyz / coverage as 16-bit pairs — the pass pool is 8-bit and
     * a mean at 1/255 steps is visibly coarse once it feeds a gain. The main
     * pass reads both and premultiplies by the source alpha itself, so like
     * Fill it stays OUT of LAYER_CLIP_BY_DEFAULT.
     */
    id: 'copyColor',
    name: 'Copy Color Profile',
    group: 'Color',
    animated: false,
    usesLayerRef: 'sourceLayer',
    // Always the clip's own picture, never the live isolate: the reference can
    // sit anywhere on the timeline and its channel can stay hidden (the user's
    // rule — a colour reference is not meant to be in shot).
    layerRefMode: 'picture',
    params: [
      { key: 'sourceLayer', type: 'layer', label: 'Reference Layer', default: '',
        note: 'The clip\'s source picture is measured (a video: its thumbnail). The layer can sit anywhere on the timeline and its channel can stay hidden.' },
      { key: 'space', slot: 0, label: 'Colour Space', type: 'select', default: 0, primary: true,
        options: [
          { value: 0, label: 'Oklab (perceptual)' },
          { value: 1, label: 'YCbCr (video)' },
          { value: 2, label: 'RGB' },
        ] },
      { key: 'transfer', slot: 2, label: 'Transfer', type: 'select', default: 0,
        options: [
          { value: 0, label: 'Statistics (mean + spread)' },
          { value: 1, label: 'Ratio (multiply by mean)' },
        ] },
      { key: 'lum', slot: 3, label: 'Luminance', min: 0, max: 100, step: 1, default: 60, suffix: '%' },
      { key: 'col', slot: 4, label: 'Colour', min: 0, max: 100, step: 1, default: 100, suffix: '%' },
      { key: 'contrast', slot: 5, label: 'Match Contrast', min: 0, max: 100, step: 1, default: 50, suffix: '%' },
      { key: 'sat', slot: 6, label: 'Saturation', min: -100, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'maxGain', slot: 7, label: 'Max Gain', min: 1, max: 8, step: 0.1, default: 4 },
      { key: 'protHi', slot: 8, label: 'Protect Highlights', min: 0, max: 100, step: 1, default: 30, suffix: '%' },
      { key: 'protLo', slot: 9, label: 'Protect Shadows', min: 0, max: 100, step: 1, default: 20, suffix: '%' },
      { key: 'inset', slot: 10, label: 'Sample Inset', min: 0, max: 45, step: 1, default: 0, suffix: '%' },
      // Grid = taps per axis of the stats pass; an allocation-like count, kept static.
      { key: 'grid', slot: 1, label: 'Sample Grid', min: 8, max: 64, step: 1, default: 48, static: true },
    ],
    passes: [
      { key: 'statsRef', target: 'ccR', size: [4, 1], nearest: true, region: 'ref', inputs: { uTexture: 'ref' }, fragment: CCP_LIB + CCP_STATS_FX },
      { key: 'statsSrc', target: 'ccS', size: [4, 1], nearest: true, region: 'source', inputs: { uTexture: 'source' }, fragment: CCP_LIB + CCP_STATS_FX },
      { key: 'main', target: 'out', main: true, inputs: { uTexture: 'source', uTexture1: 'ccR', uTexture2: 'ccS' }, fragment: CCP_LIB + CCP_MAIN_FX },
    ],
  },

  // ── Curves ────────────────────────────────────────────────────────────────
  {
    id: 'curves',
    name: 'Curves',
    group: 'Color',
    animated: false,
    // The panel's spline editor lives in `params.curves` (type 'curves'); the
    // four channels are baked into a 256×1 LUT (master folded into each channel,
    // monotone-cubic between points) so the shader stays three texture reads.
    usesCurves: 'curves',
    params: [
      { key: 'curves', type: 'curves', label: 'Curves', default: DEFAULT_CURVES },
    ],
    // Colour maths on unpremultiplied values, per the alpha discipline above.
    // Lookups hit texel centres, so an identity curve is an exact pass-through
    // (the baked ramp is linear and LinearFilter interpolates it exactly).
    // uParams[24] is the loaded flag — without it a missing texture samples black.
    fragment: /* glsl */ `
vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  if (uParams[24] < 0.5) return src;
  vec3 c = clamp(unpremult(src), 0.0, 1.0);
  c = vec3(
    texture2D(uLUT, vec2((c.r * 255.0 + 0.5) / 256.0, 0.5)).r,
    texture2D(uLUT, vec2((c.g * 255.0 + 0.5) / 256.0, 0.5)).g,
    texture2D(uLUT, vec2((c.b * 255.0 + 0.5) / 256.0, 0.5)).b
  );
  return premult(c, src.a);
}
`,
  },

  // ── Color ─────────────────────────────────────────────────────────────────
  {
    id: 'lut',
    name: 'LUT (.cube)',
    group: 'Color',
    animated: false,
    // NOT in the effects picker (its group isn't in EFFECT_GROUP_ORDER). This is
    // the shader behind the panel's dedicated LUT section on adjustment layers:
    // the Player runs it as an implicit pass right after the grade, driven by
    // item.lut / item.lutAmount. applyEffectUniforms binds the lattice:
    // uLUT = flattened 2D strip (width N*N, height N; slice = blue, x = r, y = g),
    // uParams[24] = N (0 = nothing loaded, exact pass-through),
    // uParams[25] / uParams[26] = DOMAIN_MIN / DOMAIN_MAX.
    usesLut: true,
    params: [],
    // Classic 2D-strip trilinear lookup: bilinear inside two adjacent blue slices
    // (hardware, via LinearFilter) + manual lerp across the slice pair. Colour math
    // on unpremultiplied values, per the alpha discipline above.
    fragment: /* glsl */ `
vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  float N = uParams[24];
  if (N < 2.0) return src;
  vec3 c = unpremult(src);
  c = clamp((c - uParams[25]) / max(uParams[26] - uParams[25], 1e-5), 0.0, 1.0);
  float b = c.b * (N - 1.0);
  float b0 = floor(b);
  float bf = b - b0;
  float b1 = min(b0 + 1.0, N - 1.0);
  float x = c.r * (N - 1.0) + 0.5;
  float y = (c.g * (N - 1.0) + 0.5) / N;
  float w = N * N;
  vec3 s0 = texture2D(uLUT, vec2((b0 * N + x) / w, y)).rgb;
  vec3 s1 = texture2D(uLUT, vec2((b1 * N + x) / w, y)).rgb;
  vec3 graded = mix(s0, s1, bf);
  return vec4(graded * src.a, src.a);
}
`,
  },

  /*
   * ── Custom GLSL — WITHDRAWN FROM THE PICKER ───────────────────────────────
   *
   * `hidden: true` rather than deleted, deliberately. The entry still has to
   * RESOLVE, because a project saved earlier may contain an effect with this id
   * and `getAdjustmentEffect('custom')` returning null would make that layer
   * unresolvable rather than merely unsupported. Hiding it removes it from
   * `effectsForScope()`, so it cannot be ADDED, while existing ones stay
   * addressable.
   *
   * Why it goes: its body is shader source supplied at runtime, which the new
   * renderer cannot compile at all, and supporting it meant maintaining a
   * validator whose only job was to make that input safe.
   */
  {
    id: 'custom',
    name: 'Custom GLSL',
    group: 'Custom',
    animated: true,
    isCustom: true,
    hidden: true,
    params: [],
    fragment: null,
  },
];

// The Motion Effects pack (ported from html/motion-effects-lookdev.html) lives in its
// own module — same descriptor shape, plus the declarative `passes` form — and is
// spliced in before the hidden internal entries so the picker groups read naturally.
ADJUSTMENT_EFFECTS.splice(ADJUSTMENT_EFFECTS.findIndex((e) => e.id === 'lut'), 0, ...MOTION_EFFECTS);
// Double Exposure (PRO, its own module): another layer's picture inside this
// layer's silhouette, on the Copy Color Profile layer-reference plumbing.
ADJUSTMENT_EFFECTS.splice(ADJUSTMENT_EFFECTS.findIndex((e) => e.id === 'lut'), 0, DOUBLE_EXPOSURE_EFFECT);
ADJUSTMENT_EFFECTS.splice(ADJUSTMENT_EFFECTS.findIndex((e) => e.id === 'lut'), 0, FILM_STOCK_EFFECT);
// Fast Blur (Lens), Grid (Graphic) and ASCII (Print) — each in its own module
// with its lab-verified maths; html/overlay-effects-lab.html is the look-dev.
ADJUSTMENT_EFFECTS.splice(ADJUSTMENT_EFFECTS.findIndex((e) => e.id === 'lut'), 0,
  FAST_BLUR_EFFECT, GRID_LINES_EFFECT, ASCII_EFFECT);
// Mosaic (`pixelate`; html/pixelate-lab is the look-dev) sits beside CRT Pixel Matrix in Display.
ADJUSTMENT_EFFECTS.splice(ADJUSTMENT_EFFECTS.findIndex((e) => e.id === 'crtMatrix') + 1, 0, PIXELATE_EFFECT);
// Posterize (AE Posterize, html/posterize-lab is the look-dev) sits beside Colorama in Color.
ADJUSTMENT_EFFECTS.splice(ADJUSTMENT_EFFECTS.findIndex((e) => e.id === 'colorama') + 1, 0, POSTERIZE_EFFECT);
// Strip (top + bottom bars, html/strip-lab is the look-dev) sits beside Grid in Graphic.
ADJUSTMENT_EFFECTS.splice(ADJUSTMENT_EFFECTS.findIndex((e) => e.id === 'gridLines') + 1, 0, STRIP_EFFECT);
// Radial Fast Blur (AE CC Radial Fast Blur port) sits beside Radial Blur in Lens.
ADJUSTMENT_EFFECTS.splice(ADJUSTMENT_EFFECTS.findIndex((e) => e.id === 'radialBlur') + 1, 0, RADIAL_FAST_BLUR_EFFECT);
// The Object family (geometric-art). Each entry carries its OWN subject scan on
// the effect instance, so they register as ordinary Overlay Effects — see
// objectEffects.js for why this is not a section of its own.
for (const eff of [...OBJECT_EFFECTS, ...OBJECT_GEOMETRY_EFFECTS]) {
  ADJUSTMENT_EFFECTS.splice(ADJUSTMENT_EFFECTS.findIndex((e) => e.id === 'lut'), 0, eff);
}

const EFFECT_BY_ID = new Map(ADJUSTMENT_EFFECTS.map((e) => [e.id, e]));

/*
 * INSTALLED EFFECT PACKAGES (Effects SDK).
 *
 * An agent or a user installs an effect as a package (`local:<id>`); its def
 * joins the registry at runtime, held apart from the built-ins in this map and
 * resolved by the same getAdjustmentEffect(), so the panel, keyframes, the chain
 * and export treat it exactly like a built-in. ./localEffects builds the defs:
 * the list registers metadata-only placeholders (`lazy`, not `ready`), and a
 * package's code loads the first time something asks for it. A placeholder has
 * no shading, so the chain skips it until it is ready; listeners re-render then.
 */
const localEffectDefs = new Map();
const effectRegistryListeners = new Set();
let localEffectsLoad = null;
let localEffectsListPending = false;
let lastLocalEffectsListAt = 0;

export function isLocalEffectId(id) {
  return typeof id === 'string' && /^local:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
}

function notifyEffectRegistry() {
  for (const listener of effectRegistryListeners) {
    try { listener(); } catch { /* a listener's failure is its own */ }
  }
}

// Whether the installed list has arrived at least once — before that, an unknown
// `local:` id may simply not be listed yet (the panel says "loading", not "missing").
let localEffectsListed = false;
export function localEffectsListedOnce() {
  return localEffectsListed;
}

export function replaceLocalEffects(defs) {
  localEffectsListed = true;
  localEffectDefs.clear();
  for (const def of defs || []) if (isLocalEffectId(def?.id)) localEffectDefs.set(def.id, def);
  notifyEffectRegistry();
}

// One package graduating from placeholder to loaded (or to failed).
export function upsertLocalEffect(def) {
  if (!isLocalEffectId(def?.id)) return;
  localEffectDefs.set(def.id, def);
  notifyEffectRegistry();
}

export function onEffectRegistryChanged(listener) {
  effectRegistryListeners.add(listener);
  return () => effectRegistryListeners.delete(listener);
}

export function getLocalEffects() {
  return [...localEffectDefs.values()];
}

// The installed list is read once and re-read when a package can have arrived
// from outside the editor (an agent installs over the API): the picker opening,
// the editor reloading after an API change, and a project naming a `local:` id
// this session has not listed. One request; never overlapping, ≥1 s apart.
export function loadLocalEffectPackages({ force = false } = {}) {
  if (!localEffectsLoad || force) {
    localEffectsListPending = true;
    lastLocalEffectsListAt = Date.now();
    localEffectsLoad = import('./localEffects')
      .then((m) => m.loadAndRegisterLocalEffects())
      .catch((error) => {
        console.warn('[effects] Could not load installed effect packages:', error?.message || error);
        return [];
      })
      .finally(() => { localEffectsListPending = false; });
  }
  return localEffectsLoad;
}

export function refreshLocalEffectPackages() {
  if (localEffectsListPending || Date.now() - lastLocalEffectsListAt < 1000) return loadLocalEffectPackages();
  return loadLocalEffectPackages({ force: true });
}

// The chain looks effects up every frame, so an unknown `local:` id is re-asked
// with a growing gap — found on the first try when just installed, settling at a
// request a minute when the package really is gone.
const unknownLocalEffects = new Map(); // id → { nextAt, delay }
function relistForUnknownLocalEffect(id) {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  const seen = unknownLocalEffects.get(id);
  if (seen && now < seen.nextAt) return;
  const delay = seen ? Math.min(seen.delay * 2, 60000) : 3000;
  unknownLocalEffects.set(id, { nextAt: now + delay, delay });
  refreshLocalEffectPackages();
}

// Before an export's first frame: list the installed packages, then load every
// one `value` (a project's channels, or any part of them) uses, so a package is
// never still a placeholder when the deterministic render starts.
export async function prepareLocalEffectsFor(value) {
  const ids = new Set();
  const stack = [value];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) { stack.push(...node); continue; }
    if (!node || typeof node !== 'object') continue;
    if ('eid' in node && isLocalEffectId(node.id)) ids.add(node.id);
    for (const child of Object.values(node)) if (child && typeof child === 'object') stack.push(child);
  }
  if (!ids.size) return;
  await refreshLocalEffectPackages();
  const { ensureLocalEffectLoaded } = await import('./localEffects');
  await Promise.all([...ids].map((id) => (localEffectDefs.get(id)?.lazy ? ensureLocalEffectLoaded(id) : null)));
}

export function getAdjustmentEffect(id) {
  const builtIn = EFFECT_BY_ID.get(id);
  if (builtIn) return builtIn;
  const local = localEffectDefs.get(id);
  if (local) {
    if (unknownLocalEffects.size) unknownLocalEffects.delete(id);
    // A placeholder asked for by name starts its own load (deduplicated).
    if (local.lazy && typeof local.load === 'function') local.load();
    return local;
  }
  if (isLocalEffectId(id)) relistForUnknownLocalEffect(id);
  return null;
}

// ── Scopes ──────────────────────────────────────────────────────────────────
// The same registry drives two panels:
//
//   'adjustment'  item.effects  — restyles the composited layers BELOW
//   'layer'       item.effects  — restyles ONE regular layer, clipped to its shape
//
// Nothing in an fx() body knows which it is: the Player binds either the
// below-stack or an isolated single-layer plate to uTexture. What differs is
// whether the result should be held inside the layer's silhouette. A generator
// (scanlines, a gradient beam, a vignette) paints the whole target and MUST be
// clipped or it covers the frame as a rectangle; a growth effect (glow, blur,
// displacement) deliberately writes outside the alpha and must NOT be, or the
// effect is erased. The per-effect default below is the sensible start; each
// instance carries its own `clip` override from the panel's Clip to layer box.
// A descriptor may also state it directly (`layerMatte: 'clip' | 'expand'`), which is
// what the ported motion effects do; this list covers the original registry.
const LAYER_CLIP_BY_DEFAULT = new Set([
  'gradientBeam', 'scanlines', 'grain', 'flashBlink', 'vignette', 'sharpen', 'lut', 'curves',
]);

// Effects that only make sense over a below-stack. Empty today — all 17 work on a
// single layer — but the field exists so a future descriptor that needs a scene
// behind it can opt out.
export function effectSupportsScope(def, scope) {
  if (!def) return false;
  if (!Array.isArray(def.scopes)) return true;
  return def.scopes.includes(scope);
}

// Picker contents for a scope, minus the hidden internal entries (the LUT pass is
// driven by its own panel section, never added by hand).
// An installed package whose check failed on every engine it was checked on
// draws nowhere (its `status`, published by localEffects.js).
const failedEverywhere = (e) => e.status?.ok === false
  && !Object.values(e.status.engines || {}).some((result) => result?.ok);

export function effectsForScope(scope) {
  // An installed package that failed to load is not offered; its error shows on
  // the card of any project that already uses it.
  return [...ADJUSTMENT_EFFECTS, ...localEffectDefs.values()]
    .filter((e) => !e.hidden && !e.error && !failedEverywhere(e) && e.id !== 'lut' && effectSupportsScope(e, scope));
}

// Does this instance clip to the layer matte? Explicit `clip` wins; otherwise the
// registry default. Only consulted in layer scope.
export function effectClipsToLayer(eff) {
  if (!eff) return false;
  if (eff.clip === true || eff.clip === false) return eff.clip;
  const def = getAdjustmentEffect(eff.id);
  if (def?.layerMatte) return def.layerMatte === 'clip';
  return LAYER_CLIP_BY_DEFAULT.has(eff.id);
}

// PRO overlay effects (Neon Glow): free in the preview, gated at the render —
// the same contract as Running Glow. Walks the complete saved editor state, so
// sequence-nested layers count too. An enabled entry counts even at mix 0 when
// a keyframed mix track could ramp it up mid-clip.
export function containsProOverlayEffect(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value.effects) && value.effects.some((e) => {
    if (!e || e.enabled === false) return false;
    if (!getAdjustmentEffect(e.id)?.pro) return false;
    const mix = Number.isFinite(e.mix) ? e.mix : 100;
    if (mix > 0.01) return true;
    const track = e.eid ? value.propertyKeyframes?.[`fx:${e.eid}:mix`] : null;
    return Array.isArray(track) && track.length > 0;
  })) return true;
  if (Array.isArray(value)) return value.some((entry) => containsProOverlayEffect(entry, seen));
  return Object.values(value).some((entry) => containsProOverlayEffect(entry, seen));
}

// True when a regular layer carries at least one enabled Overlay Effect. This makes
// renderFrame route the frame through the multi-pass compositor — an Overlay Effect
// needs the layer rendered ALONE, which the single-pass path cannot do.
export function hasActiveLayerOverlayEffects(item, at = null) {
  const list = item?.effects;
  if (!Array.isArray(list) || list.length === 0) return false;
  if (!at) return list.some((e) => e && e.enabled !== false && getAdjustmentEffect(e.id));
  return list.some((e) => effectIsLiveAt(e, at, item));
}

// The chain's own per-frame liveness, usable BEFORE the chain runs: enabled and
// registered, mix > 0 right now (a keyed mix wins over the static one), and inside
// the effect's active window. `at` = { kf, time, duration, master }: `kf` is
// getItemKeyframeValues(item, progress) or null, time/duration the item's clip
// clock. Anything that prepares an INPUT for an effect (a reference isolate, a
// picture plate, the multi-pass detour itself) must gate on this rather than on
// `enabled` alone — otherwise a bypassed effect still costs a pre-render every
// frame. With no `kf`, a keyed mix track is taken as "possibly live" (the track
// may ramp up later in the clip); a static mix 0 with no track is not live.
export function effectIsLiveAt(eff, at = {}, item = null) {
  if (!eff || eff.enabled === false) return false;
  if (!getAdjustmentEffect(eff.id)) return false;
  const { kf = null, time = null, duration = null, master = 1 } = at || {};
  if (!(master > 0)) return false;
  const mixKey = eff.eid ? `fx:${eff.eid}:mix` : null;
  const mixKf = mixKey && kf ? kf[mixKey] : undefined;
  let baseMix;
  if (Number.isFinite(mixKf)) baseMix = mixKf;
  else if (!kf && mixKey && Array.isArray(item?.propertyKeyframes?.[mixKey]) && item.propertyKeyframes[mixKey].length > 0) baseMix = 100;
  else baseMix = Number.isFinite(eff.mix) ? eff.mix : 100;
  if (!(baseMix > 0)) return false;
  if (time != null) {
    const win = effectWindowAt(eff, time, duration);
    if (win && win.amount <= 0) return false;
  }
  return true;
}

// Does this chain need the blur-pyramid targets (Aura Blur)? Used to decide
// whether the second, larger render-target bank has to be allocated at all.
export function chainNeedsPyramid(effects) {
  if (!Array.isArray(effects)) return false;
  return effects.some((e) => e && e.enabled !== false && getAdjustmentEffect(e.id)?.pyramidPass);
}

export const DEFAULT_CUSTOM_EFFECT_CODE = `// iChannel0 = layers below. Uniforms: iResolution, iTime, iProgress.
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec4 src = texture2D(iChannel0, uv);
  // Simple wave distortion:
  uv.x += sin(uv.y * 40.0 + iTime * 3.0) * 0.01;
  fragColor = texture2D(iChannel0, uv);
}`;

// ── 3D LUTs (.cube) ─────────────────────────────────────────────────────────
// A .cube file is parsed client-side into a Uint8 RGB lattice (r-fastest order,
// exactly the file's data order), stored on the effect entry as
// eff.lut = { name, size, domainMin, domainMax, data: <base64> } so it round-trips
// through project JSON with no backend involvement. Lattices larger than
// MAX_LUT_SIZE are trilinearly resampled down at import to keep saves light
// (33³ ≈ 145 KB base64 — the standard realtime-grading resolution).

export const MAX_LUT_SIZE = 33;
const MAX_LUT_DATA_CHARS = 200000;

function base64FromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}

function bytesFromBase64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Trilinear resample of an r-fastest float lattice from n³ to m³.
function resampleLutLattice(src, n, m) {
  const out = new Float32Array(m * m * m * 3);
  const at = (r, g, b, ch) => src[((b * n + g) * n + r) * 3 + ch];
  let di = 0;
  for (let b = 0; b < m; b++) {
    for (let g = 0; g < m; g++) {
      for (let r = 0; r < m; r++) {
        const fr = (r / (m - 1)) * (n - 1);
        const fg = (g / (m - 1)) * (n - 1);
        const fb = (b / (m - 1)) * (n - 1);
        const r0 = Math.min(Math.floor(fr), n - 2); const rt = fr - r0;
        const g0 = Math.min(Math.floor(fg), n - 2); const gt = fg - g0;
        const b0 = Math.min(Math.floor(fb), n - 2); const bt = fb - b0;
        for (let ch = 0; ch < 3; ch++) {
          const c00 = at(r0, g0, b0, ch) * (1 - rt) + at(r0 + 1, g0, b0, ch) * rt;
          const c10 = at(r0, g0 + 1, b0, ch) * (1 - rt) + at(r0 + 1, g0 + 1, b0, ch) * rt;
          const c01 = at(r0, g0, b0 + 1, ch) * (1 - rt) + at(r0 + 1, g0, b0 + 1, ch) * rt;
          const c11 = at(r0, g0 + 1, b0 + 1, ch) * (1 - rt) + at(r0 + 1, g0 + 1, b0 + 1, ch) * rt;
          out[di++] = (c00 * (1 - gt) + c10 * gt) * (1 - bt) + (c01 * (1 - gt) + c11 * gt) * bt;
        }
      }
    }
  }
  return out;
}

// Parse .cube text into a storable lut object. Throws Error with a user-facing
// message on malformed input. Values outside [0,1] (HDR shaper LUTs) are clamped.
export function parseCubeLut(text) {
  const lines = String(text || '').split(/\r?\n/);
  let size = 0;
  let domainMin = 0;
  let domainMax = 1;
  const values = [];
  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const up = line.toUpperCase();
    if (up.startsWith('TITLE')) continue;
    if (up.startsWith('LUT_1D_SIZE')) throw new Error('1D LUTs are not supported — use a 3D .cube (LUT_3D_SIZE).');
    if (up.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (up.startsWith('DOMAIN_MIN')) { domainMin = parseFloat(line.split(/\s+/)[1]); continue; }
    if (up.startsWith('DOMAIN_MAX')) { domainMax = parseFloat(line.split(/\s+/)[1]); continue; }
    if (up.startsWith('LUT_')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const r = Number(parts[0]); const g = Number(parts[1]); const b = Number(parts[2]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      throw new Error('Malformed data line in .cube file.');
    }
    values.push(r, g, b);
  }
  if (!Number.isInteger(size) || size < 2) throw new Error('Missing or invalid LUT_3D_SIZE.');
  if (size > 128) throw new Error('LUT too large (max 128 per axis).');
  const expected = size * size * size;
  if (values.length !== expected * 3) {
    throw new Error(`Expected ${expected} entries for a ${size} LUT, found ${Math.floor(values.length / 3)}.`);
  }
  if (!Number.isFinite(domainMin)) domainMin = 0;
  if (!Number.isFinite(domainMax) || domainMax <= domainMin) { domainMin = 0; domainMax = 1; }
  let lattice = values;
  let n = size;
  if (n > MAX_LUT_SIZE) {
    lattice = resampleLutLattice(values, n, MAX_LUT_SIZE);
    n = MAX_LUT_SIZE;
  }
  const bytes = new Uint8Array(n * n * n * 3);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.round(Math.min(1, Math.max(0, lattice[i])) * 255);
  }
  return { name: '', size: n, domainMin, domainMax, data: base64FromBytes(bytes) };
}

// Load-time whitelist for a persisted eff.lut (mirrors sanitizeAdjustmentEffects'
// param clamping): wrong shape / oversized / length-mismatched data → dropped.
export function sanitizeEffectLut(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const size = Math.round(Number(raw.size));
  if (!Number.isInteger(size) || size < 2 || size > MAX_LUT_SIZE) return null;
  const data = typeof raw.data === 'string' ? raw.data : '';
  if (!data || data.length > MAX_LUT_DATA_CHARS || data.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const decoded = (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (decoded !== size * size * size * 3) return null;
  let domainMin = Number(raw.domainMin);
  let domainMax = Number(raw.domainMax);
  if (!Number.isFinite(domainMin)) domainMin = 0;
  if (!Number.isFinite(domainMax) || domainMax <= domainMin) { domainMin = 0; domainMax = 1; }
  return {
    name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : '',
    size,
    domainMin,
    domainMax,
    data,
  };
}

// base64 lattice → cached DataTexture in the 2D-strip layout the shader samples
// (width N*N, height N; texel x = blueSlice*N + r, y = g). Keyed by the data
// string itself, so two effects sharing one LUT share one texture; bounded LRU.
const lutTextureCache = new Map();
let _lutSeq = 0;
export function getLutTexture(lut) {
  if (!lut || typeof lut.data !== 'string' || !lut.data) return null;
  const n = Math.round(Number(lut.size));
  if (!Number.isInteger(n) || n < 2 || n > MAX_LUT_SIZE) return null;
  let entry = lutTextureCache.get(lut.data);
  if (!entry) {
    let bytes;
    try { bytes = bytesFromBase64(lut.data); } catch { return null; }
    if (bytes.length !== n * n * n * 3) return null;
    const rgba = new Uint8Array(n * n * n * 4);
    for (let b = 0; b < n; b++) {
      for (let g = 0; g < n; g++) {
        for (let r = 0; r < n; r++) {
          const s = ((b * n + g) * n + r) * 3;
          const d = (g * n * n + b * n + r) * 4;
          rgba[d] = bytes[s];
          rgba[d + 1] = bytes[s + 1];
          rgba[d + 2] = bytes[s + 2];
          rgba[d + 3] = 255;
        }
      }
    }
    const texture = new THREE.DataTexture(rgba, n * n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    entry = { texture, size: n };
    lutTextureCache.set(lut.data, entry);
    if (lutTextureCache.size > 6) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [k, v] of lutTextureCache) {
        if (k === lut.data) continue;
        if ((v.lastUsed ?? 0) < oldest) { oldest = v.lastUsed ?? 0; oldestKey = k; }
      }
      if (oldestKey) {
        try { lutTextureCache.get(oldestKey).texture.dispose(); } catch { /* no-op */ }
        lutTextureCache.delete(oldestKey);
      }
    }
  }
  entry.lastUsed = ++_lutSeq;
  return entry;
}

// ── Gradient ramps ──────────────────────────────────────────────────────────
// A `type: 'gradient'` param stores a CSS gradient string — the exact value the
// shared GradientPicker produces, so an effect ramp is authored with the same
// component (and the same stops, drag handles and colour popover) as a text fill or
// a project background. The string is baked into a 256×1 RGBA texture bound to uLUT.
// Only the stop list and the interpolation mode matter here; the gradient's angle and
// type are the picker's business and are ignored, because a ramp is a 1-D lookup.

export const DEFAULT_RAMP = 'linear-gradient(90deg, #05121f 0%, #1b6f6a 45%, #7dd3c0 78%, #f4fff9 100%)';

export function sanitizeEffectGradient(value, fallback = DEFAULT_RAMP) {
  return typeof value === 'string' && isCssGradient(value) && value.length <= 2048 ? value : fallback;
}

const RAMP_SIZE = 256;
const rampTextureCache = new Map();
let _rampSeq = 0;

function rampStops(css) {
  const parsed = parseGradient(css);
  const stops = (parsed?.stops || [])
    .map((s) => ({ ...parseHexColor(s.color), pos: Math.max(0, Math.min(1, Number(s.position) / 100)) }))
    .sort((a, b) => a.pos - b.pos);
  if (stops.length === 0) return [{ r: 0, g: 0, b: 0, pos: 0 }, { r: 1, g: 1, b: 1, pos: 1 }];
  if (stops.length === 1) return [{ ...stops[0], pos: 0 }, { ...stops[0], pos: 1 }];
  return stops;
}

// interpolation: 0 linear, 1 smooth (smoothstep between stops), 2 constant (hard steps)
export function getRampTexture(css, interpolation = 0) {
  const key = `${css}|${interpolation}`;
  let entry = rampTextureCache.get(key);
  if (!entry) {
    const stops = rampStops(css);
    const data = new Uint8Array(RAMP_SIZE * 4);
    let seg = 0;
    for (let i = 0; i < RAMP_SIZE; i++) {
      const x = i / (RAMP_SIZE - 1);
      while (seg < stops.length - 2 && x > stops[seg + 1].pos) seg++;
      const a = stops[seg];
      const b = stops[seg + 1] || a;
      const span = Math.max(b.pos - a.pos, 1e-4);
      let t = Math.max(0, Math.min(1, (x - a.pos) / span));
      if (interpolation > 1.5) t = t >= 1 ? 1 : 0;
      else if (interpolation > 0.5) t = t * t * (3 - 2 * t);
      const o = i * 4;
      data[o] = Math.round(255 * (a.r + (b.r - a.r) * t));
      data[o + 1] = Math.round(255 * (a.g + (b.g - a.g) * t));
      data[o + 2] = Math.round(255 * (a.b + (b.b - a.b) * t));
      data[o + 3] = 255;
    }
    const texture = new THREE.DataTexture(data, RAMP_SIZE, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    entry = { texture };
    rampTextureCache.set(key, entry);
    // Dragging a stop mints a new string every mousemove, so the cache is capped
    // tightly and the coldest entry disposed rather than left to accumulate.
    if (rampTextureCache.size > 8) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [k, v] of rampTextureCache) {
        if (k === key) continue;
        if ((v.lastUsed ?? 0) < oldest) { oldest = v.lastUsed ?? 0; oldestKey = k; }
      }
      if (oldestKey) {
        try { rampTextureCache.get(oldestKey).texture.dispose(); } catch { /* no-op */ }
        rampTextureCache.delete(oldestKey);
      }
    }
  }
  entry.lastUsed = ++_rampSeq;
  return entry.texture;
}

// ── Tone curves ─────────────────────────────────────────────────────────────
// The Curves effect's `type: 'curves'` param stores four point lists (master +
// r/g/b) in the unit box. The panel's spline editor and the texture bake below
// share one evaluator, so what the user drags is exactly what the shader reads.

const CURVES_CHANNELS = ['m', 'r', 'g', 'b'];
const MAX_CURVE_POINTS = 16;

function sanitizeCurveChannel(raw) {
  if (!Array.isArray(raw)) return [[0, 0], [1, 1]];
  const pts = raw
    .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .map((p) => [
      Math.round(Math.max(0, Math.min(1, Number(p[0]))) * 1000) / 1000,
      Math.round(Math.max(0, Math.min(1, Number(p[1]))) * 1000) / 1000,
    ])
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_CURVE_POINTS);
  return pts.length >= 2 ? pts : [[0, 0], [1, 1]];
}

export function sanitizeEffectCurves(value, fallback = DEFAULT_CURVES) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  const out = {};
  for (const ch of CURVES_CHANNELS) out[ch] = sanitizeCurveChannel(src?.[ch] ?? fallback?.[ch]);
  return out;
}

export function isIdentityCurveChannel(pts) {
  return pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1;
}

// Monotone cubic Hermite (Fritsch–Carlson) through the channel's points, clamped
// to 0..1 and held flat outside the first/last point. Monotone on purpose: a
// natural spline overshoots between close points, which reads as banding in the
// baked LUT rather than the drawn curve.
export function makeCurveEvaluator(points) {
  const pts = sanitizeCurveChannel(points);
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = Math.max(xs[i + 1] - xs[i], 1e-6);
    slope[i] = (ys[i + 1] - ys[i]) / dx[i];
  }
  const tan = [slope[0]];
  for (let i = 1; i < n - 1; i++) tan[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  tan[n - 1] = slope[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { tan[i] = 0; tan[i + 1] = 0; continue; }
    const a = tan[i] / slope[i];
    const b = tan[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const f = 3 / Math.sqrt(s);
      tan[i] = f * a * slope[i];
      tan[i + 1] = f * b * slope[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return Math.max(0, Math.min(1, ys[0]));
    if (x >= xs[n - 1]) return Math.max(0, Math.min(1, ys[n - 1]));
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / dx[i];
    const t2 = t * t;
    const t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * ys[i]
      + (t3 - 2 * t2 + t) * dx[i] * tan[i]
      + (-2 * t3 + 3 * t2) * ys[i + 1]
      + (t3 - t2) * dx[i] * tan[i + 1];
    return Math.max(0, Math.min(1, y));
  };
}

// 256×1 RGBA bake: texel x holds master(red(x)) in R, master(green(x)) in G,
// master(blue(x)) in B — three lookups replace four spline evaluations. Same
// tightly-capped LRU as the ramp cache: dragging a point mints a new object
// every mousemove.
const curvesTextureCache = new Map();
let _curvesSeq = 0;

export function getCurvesTexture(curves) {
  const clean = sanitizeEffectCurves(curves);
  const key = JSON.stringify(clean);
  let entry = curvesTextureCache.get(key);
  if (!entry) {
    const master = makeCurveEvaluator(clean.m);
    const evals = [makeCurveEvaluator(clean.r), makeCurveEvaluator(clean.g), makeCurveEvaluator(clean.b)];
    const data = new Uint8Array(RAMP_SIZE * 4);
    for (let i = 0; i < RAMP_SIZE; i++) {
      const x = i / (RAMP_SIZE - 1);
      const o = i * 4;
      for (let c = 0; c < 3; c++) data[o + c] = Math.round(255 * master(evals[c](x)));
      data[o + 3] = 255;
    }
    const texture = new THREE.DataTexture(data, RAMP_SIZE, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    entry = { texture };
    curvesTextureCache.set(key, entry);
    if (curvesTextureCache.size > 8) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [k, v] of curvesTextureCache) {
        if (k === key) continue;
        if ((v.lastUsed ?? 0) < oldest) { oldest = v.lastUsed ?? 0; oldestKey = k; }
      }
      if (oldestKey) {
        try { curvesTextureCache.get(oldestKey).texture.dispose(); } catch { /* no-op */ }
        curvesTextureCache.delete(oldestKey);
      }
    }
  }
  entry.lastUsed = ++_curvesSeq;
  return entry.texture;
}

// Default params object for a freshly-added effect (registry defaults).
export function defaultEffectParams(id) {
  const def = getAdjustmentEffect(id);
  if (!def) return {};
  const out = {};
  for (const p of def.params) out[p.key] = p.default;
  return out;
}

// Stable per-effect instance id. Keyframe tracks are keyed by this (`fx:<eid>:<param>`)
// so they survive reorder and don't collide across two `custom` slots. Persisted once
// assigned; only needs to be unique within one item's effects array.
let _eidSeq = 0;
export function makeEid() {
  _eidSeq = (_eidSeq + 1) % 1e6;
  const rand = Math.floor(Math.random() * 1e6).toString(36);
  return `e${_eidSeq.toString(36)}${rand}`;
}

export function makeDefaultEffect(id) {
  const def = getAdjustmentEffect(id);
  if (!def) return null;
  const mix = Number.isFinite(def.defaultMix) ? def.defaultMix : 100;
  const eff = { id, eid: makeEid(), enabled: true, mix, params: defaultEffectParams(id) };
  if (def.isCustom) eff.code = DEFAULT_CUSTOM_EFFECT_CODE;
  return eff;
}

// ── Active range ────────────────────────────────────────────────────────────
// An effect can be scoped to a slice of its layer via `start`/`end`, both in
// clip-local seconds — the same clock as uTime. Neither field present means "the
// whole layer", which is what every effect authored before this feature has, so
// old projects keep their exact look.
//
// Inside the window the clock is REBASED: uTime restarts at 0 and uProgress runs
// 0→1 across the window rather than the clip. Without that a cyclic effect would
// enter its window mid-animation, which is the whole reason windows exist.

// Resolved window bounds, defaulted and sanity-checked. `duration` (clip length)
// is only needed to close an open-ended window; pass 0 if unknown.
export function effectRange(eff, duration) {
  const hasStart = Number.isFinite(eff?.start);
  const hasEnd = Number.isFinite(eff?.end);
  if (!hasStart && !hasEnd) return null;
  const start = hasStart ? Math.max(0, eff.start) : 0;
  const far = duration > 0 ? duration : Infinity;
  const end = hasEnd ? eff.end : far;
  // A degenerate or inverted window is treated as no window at all rather than
  // as "never on" — silently killing an effect would read as a broken render.
  if (!(end > start)) return null;
  return { start, end };
}

export function hasEffectRange(eff) {
  return effectRange(eff, 0) != null;
}

// Per-frame gate. Returns null when the effect has no window (caller keeps the
// clip clock untouched), otherwise { amount, time, progress }.
export function effectWindowAt(eff, time, duration) {
  const range = effectRange(eff, duration);
  if (!range) return null;
  const { start, end } = range;
  if (time < start || time > end) return { amount: 0, time: 0, progress: 0 };
  const span = end - start;
  return {
    amount: 1,
    time: time - start,
    progress: Number.isFinite(span) && span > 0 ? Math.min(1, Math.max(0, (time - start) / span)) : 0,
  };
}

// ── Keyframe integration ────────────────────────────────────────────────────
// Effect params (and the per-effect mix) are animatable via the shared
// propertyKeyframes system under keys `fx:<eid>:<paramKey>`. The interpolator is
// registry-agnostic so these tracks flow through for free; the helpers below let
// the panel/sanitizer/timeline resolve them without hard-coding.

export const EFFECT_MIX_PARAM = 'mix';

export function effectKfKey(eid, paramKey) {
  return `fx:${eid}:${paramKey}`;
}

export function parseEffectKfKey(label) {
  if (typeof label !== 'string') return null;
  const m = /^fx:([^:]+):([A-Za-z0-9_]+)$/.exec(label);
  return m ? { eid: m[1], paramKey: m[2] } : null;
}

export function isEffectKfKey(label) {
  return parseEffectKfKey(label) != null;
}

// Number params (the only keyframable param kind in v1 — selects/colours excluded).
// `static: true` opts a number param out: Auto Fill's bake-side params shape a
// CPU bake, and a keyframed one would force that bake to rerun every frame.
export function keyframableParams(def) {
  return def ? def.params.filter((p) => (!p.type || p.type === 'number') && !p.static) : [];
}

// Meta ({min,max,step,label,unit}) for one keyframable param of a concrete effect
// instance, or null if that param isn't keyframable. `mix` is the synthetic pseudo-param.
export function effectParamKfMeta(effect, paramKey) {
  const def = getAdjustmentEffect(effect?.id);
  if (!def) return null;
  if (paramKey === EFFECT_MIX_PARAM) return { min: 0, max: 100, step: 1, label: 'Mix', unit: '%' };
  const p = def.params.find((x) => x.key === paramKey && (!x.type || x.type === 'number') && !x.static);
  return p ? { min: p.min, max: p.max, step: p.step, label: p.label, unit: p.suffix || '' } : null;
}

function makeEffectKfProp(eff, effName, paramKey, meta, currentValue, group = 'Overlay Effects') {
  return {
    label: effectKfKey(eff.eid, paramKey),   // the track key (unique id)
    // UI grouping only (never persisted) — kept distinct from the per-layer
    // 'Effects' group in keyframeProps.js so the two never merge in the builder.
    group,
    displayLabel: `${effName} · ${meta.label}`,
    placeholder: String(currentValue),
    unit: meta.unit || '',
    type: 'number',
    min: meta.min,
    max: meta.max,
    step: meta.step,
    eid: eff.eid,
    paramKey,
  };
}

// Overlay Effect instances always live in item.effects, on both adjustment layers
// and regular visual layers. item.layerEffects belongs to the separate Layer Effects
// section (Running Glow / 3D Depth) and is intentionally not part of this registry.
export function allItemEffects(item) {
  return Array.isArray(item?.effects) ? item.effects : [];
}

// All keyframable Overlay Effect tracks an item exposes (per-effect mix + number
// params), each shaped like a KF_PROPS entry plus a human `displayLabel`. Placeholder =
// the current value, so seeding a new track (addPropertyTrack / promote) starts constant.
export function buildEffectKfProps(item) {
  const out = [];
  const collect = (list, group) => {
    if (!Array.isArray(list)) return;
    for (const eff of list) {
      const def = getAdjustmentEffect(eff?.id);
      if (!def || !eff.eid) continue;
      out.push(makeEffectKfProp(eff, def.name, EFFECT_MIX_PARAM,
        { min: 0, max: 100, step: 1, label: 'Mix', unit: '%' },
        Number.isFinite(eff.mix) ? eff.mix : 100, group));
      for (const p of keyframableParams(def)) {
        out.push(makeEffectKfProp(eff, def.name, p.key,
          { min: p.min, max: p.max, step: p.step, label: p.label, unit: p.suffix || '' },
          Number.isFinite(eff.params?.[p.key]) ? eff.params[p.key] : p.default, group));
      }
    }
  };
  collect(item?.effects, 'Overlay Effects');
  return out;
}

// Full fragment source for a built-in effect / custom code. `pass` is 'main'
// (default) or 'pre' for the optional preparatory pass of a two-pass effect.
function buildEffectFragment(def, pass) {
  if (pass === 'pre') return `${EFFECT_PRELUDE}\n${def.prePass}\n${EFFECT_PRE_MAIN}`;
  if (pass === 'pyramid') return `${EFFECT_PRELUDE}\n${def.pyramidPass}\n${EFFECT_PRE_MAIN}`;
  // Declarative multi-pass form: `pass:<key>` builds that entry from def.passes.
  // Only the pass flagged `main` crossfades against uSource, so an effect is an exact
  // bypass at mix 0 no matter how many intermediate passes ran.
  if (typeof pass === 'string' && pass.startsWith('pass:')) {
    const entry = getEffectPass(def, pass.slice(5));
    if (!entry) return null;
    return `${EFFECT_PRELUDE}\n${entry.fragment}\n${entry.main ? EFFECT_MAIN_FROM_SOURCE : EFFECT_PRE_MAIN}`;
  }
  const main = (def.prePass || def.pyramidPass) ? EFFECT_MAIN_FROM_SOURCE : EFFECT_MAIN;
  return `${EFFECT_PRELUDE}\n${def.fragment}\n${main}`;
}

export function getEffectPass(def, key) {
  return Array.isArray(def?.passes) ? def.passes.find((p) => p.key === key) || null : null;
}

// A named easing param's value: one of its `options` (the TransitionEasing display
// names), else its default.
export function sanitizeEffectEasing(raw, p) {
  return typeof raw === 'string' && Array.isArray(p?.options) && p.options.includes(raw) ? raw : p?.default;
}

// Resolved param values for an effect instance (registry defaults + clamped overrides),
// which is what a pass's `set(params, ctx)` hook reads.
export function resolveEffectParams(def, eff) {
  const out = {};
  if (!def) return out;
  for (const p of def.params) {
    const raw = eff?.params?.[p.key] ?? (p.legacyKey ? eff?.params?.[p.legacyKey] : undefined);
    if (p.type === 'color') out[p.key] = typeof raw === 'string' && raw ? raw : p.default;
    else if (p.type === 'gradient') out[p.key] = sanitizeEffectGradient(raw, p.default);
    // A layer reference is an item id string (Copy Color Profile).
    else if (p.type === 'layer') out[p.key] = typeof raw === 'string' ? raw : '';
    // Free text (ASCII's custom characters), length-capped like the sanitizer.
    else if (p.type === 'text') out[p.key] = typeof raw === 'string' ? raw.slice(0, p.maxLength || 200) : p.default;
    // A named easing (Strip's entrance/outro curves), one of the descriptor's options.
    else if (p.type === 'easing') out[p.key] = sanitizeEffectEasing(raw, p);
    else out[p.key] = clampParam(raw, p);
  }
  return out;
}

// Must stay byte-identical to what validateCustomEffect() compiles, or the
// panel can report "ok" for code the material then fails to build — hence the
// same mergePrelude() dedupe the validator gets via buildFragmentSource().
export function buildCustomEffectSource(code) {
  const body = String(code || '');
  return `${mergePrelude(CUSTOM_PRELUDE, body)}\n${body}\n${CUSTOM_MAIN}`;
}

function freshUniforms() {
  return {
    uTexture: { value: null },
    uSource: { value: null },
    uTexture1: { value: null },
    uTexture2: { value: null },
    uTexture3: { value: null },
    uLUT: { value: null },
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uTime: { value: 0 },
    uProgress: { value: 0 },
    uMix: { value: 1 },
    uQuality: { value: 1 },
    uParams: { value: new Array(PARAM_SLOTS).fill(0) },
    // Identity box = the whole frame, which is what every fx() helper collapses to.
    uFxOrigin: { value: new THREE.Vector2(0.5, 0.5) },
    uFxAxisX: { value: new THREE.Vector2(0.5, 0) },
    uFxAxisY: { value: new THREE.Vector2(0, 0.5) },
    uFxHom: { value: new THREE.Matrix3() },
    uFxHomInv: { value: new THREE.Matrix3() },
    uFxSizePx: { value: new THREE.Vector2(1280, 720) },
    uFxLayer: { value: 0 },
    uColor: { value: new THREE.Color(0xffffff) },
    // Flat vec3[] — three.js uploads a plain numeric array straight through,
    // so the per-frame write below is a few stores with no allocation.
    uColors: { value: new Float32Array(COLOR_SLOTS * 3).fill(1) },
  };
}

// An installed package's images (localEffects.js decodes them) as WebGL
// textures, one per loaded revision, bound as `T_<key>` — upright under the same
// uv the layer is sampled with, premultiplied like every plate in the chain.
const PACKAGE_WRAPS = { clamp: THREE.ClampToEdgeWrapping, repeat: THREE.RepeatWrapping, mirror: THREE.MirroredRepeatWrapping };
function packageImageUniforms(def) {
  const out = {};
  for (const spec of def?.textures || []) {
    if (!spec.image) continue;
    if (!spec.glTexture) {
      const tex = new THREE.Texture(spec.image);
      tex.flipY = true;
      tex.premultiplyAlpha = true;
      tex.colorSpace = THREE.NoColorSpace;
      tex.wrapS = tex.wrapT = PACKAGE_WRAPS[spec.wrap] || THREE.ClampToEdgeWrapping;
      const filter = spec.filter === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter;
      tex.magFilter = filter;
      tex.minFilter = filter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      spec.glTexture = tex;
    }
    out[`T_${spec.key}`] = { value: spec.glTexture };
  }
  return out;
}

// Build a ShaderMaterial for an effect. For the custom slot, pass the user code.
// pass = 'pre' builds the preparatory pass of a two-pass effect (def.prePass).
export function createEffectMaterial(effect, code, pass = 'main') {
  const def = typeof effect === 'string' ? getAdjustmentEffect(effect) : effect;
  if (!def) return null;
  if (pass === 'pre' && !def.prePass) return null;
  if (pass === 'pyramid' && !def.pyramidPass) return null;
  const fragmentShader = def.isCustom ? buildCustomEffectSource(code) : buildEffectFragment(def, pass);
  if (!fragmentShader) return null;
  return new THREE.ShaderMaterial({
    vertexShader: EFFECT_VERTEX,
    fragmentShader,
    uniforms: def.isLocal ? { ...freshUniforms(), ...packageImageUniforms(def) } : freshUniforms(),
    transparent: true,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

// Matte clip — the pass that makes a layer effect stay inside the layer's real
// shape. `uMatte` is the layer rendered ALONE before DOF/glow, so its alpha is the
// genuine silhouette: glyph outlines, a traced path, a stroke, a PNG's cutout.
// Both textures are premultiplied, so scaling rgba by coverage is the correct and
// fringe-free way to cut (no unpremultiply round trip). Runs on the same
// full-screen quad as the effect passes, hence the same no-varyings/gl_FragCoord
// convention as EFFECT_VERTEX.
export function createMatteClipMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: EFFECT_VERTEX,
    fragmentShader: /* glsl */ `
precision highp float;
uniform sampler2D uTexture;
uniform sampler2D uMatte;
uniform vec2 uResolution;
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  gl_FragColor = texture2D(uTexture, uv) * texture2D(uMatte, uv).a;
}
`,
    uniforms: {
      uTexture: { value: null },
      uMatte: { value: null },
      uResolution: { value: new THREE.Vector2(1280, 720) },
    },
    transparent: true,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

function parseHexColor(hex) {
  const s = String(hex || '#ffffff').replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n)) return { r: 1, g: 1, b: 1 };
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function clampParam(val, p) {
  const n = Number.isFinite(val) ? val : p.default;
  const lo = Number.isFinite(p.min) ? p.min : -Infinity;
  const hi = Number.isFinite(p.max) ? p.max : Infinity;
  return Math.min(hi, Math.max(lo, n));
}

// Push an effect config + frame context onto its material's uniforms.
// ctx = { time, progress, width, height, quality, mix, box? }
// `box` is the layer's projected quad ({ origin, axisX, axisY, sizePx }, all in
// frame uv but sizePx in plate pixels) — present in layer scope, absent for an
// adjustment layer, where the effect's space IS the frame.
// `defOverride`: a def not in the registry yet (an effect package being proven).
export function applyEffectUniforms(mat, eff, ctx, defOverride = null) {
  const def = defOverride || getAdjustmentEffect(eff?.id);
  if (!def || !mat) return;
  const u = mat.uniforms;
  const w = ctx.width || 1280;
  const h = ctx.height || 720;
  u.uResolution.value.set(w, h);
  if (u.uFxOrigin) {
    const box = ctx.box;
    setFxBoxUniforms(u, box || null);
    u.uFxSizePx.value.set(box ? box.sizePx[0] : w, box ? box.sizePx[1] : h);
    u.uFxLayer.value = box ? 1 : 0;
  }
  u.uTime.value = ctx.time || 0;
  u.uProgress.value = ctx.progress || 0;
  u.uMix.value = ctx.mix != null ? ctx.mix : 1;
  u.uQuality.value = ctx.quality != null ? ctx.quality : 1;
  const arr = u.uParams.value;
  for (let i = 0; i < PARAM_SLOTS; i++) arr[i] = 0;
  const cols = u.uColors.value;
  cols.fill(1);
  let hasColor = false;
  for (const p of def.params) {
    if (p.type === 'color') {
      const raw = eff?.params?.[p.key] ?? (p.legacyKey ? eff?.params?.[p.legacyKey] : undefined);
      const c = parseHexColor(raw ?? p.default);
      if (Number.isInteger(p.colorSlot) && p.colorSlot < COLOR_SLOTS) {
        const i = p.colorSlot * 3;
        cols[i] = c.r; cols[i + 1] = c.g; cols[i + 2] = c.b;
      } else {
        u.uColor.value.setRGB(c.r, c.g, c.b);
        hasColor = true;
      }
    } else if (Number.isInteger(p.slot)) {
      const raw = eff?.params?.[p.key] ?? (p.legacyKey ? eff?.params?.[p.legacyKey] : undefined);
      arr[p.slot] = clampParam(raw, p);
    }
  }
  if (!hasColor) u.uColor.value.setRGB(1, 1, 1);
  // LUT effects: bind the lattice texture + pass its geometry through the
  // internal param slots (24 = N, 25/26 = domain). No lattice → N stays 0 and
  // the shader is an exact pass-through.
  // Gradient-ramp effects (Colorama): bake the picker's CSS gradient into the 256×1
  // uLUT the shader samples. Interpolation is baked in too, so the shader stays a
  // single texture read.
  if (def.usesRamp && u.uLUT) {
    const interpParam = def.params.find((p) => p.key === 'interpolation');
    const mode = interpParam && Number.isInteger(interpParam.slot) ? arr[interpParam.slot] : 0;
    u.uLUT.value = getRampTexture(
      sanitizeEffectGradient(eff?.params?.[def.usesRamp]),
      mode
    );
  }
  // Curves: bake the four spline channels into the 256×1 uLUT (master folded
  // into each channel). uParams[24] is the loaded flag — the shader passes the
  // source through untouched when no texture is bound.
  if (def.usesCurves && u.uLUT) {
    u.uLUT.value = getCurvesTexture(eff?.params?.[def.usesCurves]);
    arr[24] = 1;
  }
  // ASCII: the glyph atlas for this instance's characters + font — a cached
  // canvas bake (rebuilt only when either changes), bound where the ramp /
  // curves LUTs go. Its geometry reaches the shader through the passes' set().
  if (def.usesGlyphAtlas && u.uLUT) {
    const atlas = getAsciiAtlas(resolveEffectParams(def, eff));
    u.uLUT.value = atlas ? atlas.texture : null;
  }
  if (def.usesLut && u.uLUT) {
    const entry = getLutTexture(eff?.lut);
    u.uLUT.value = entry ? entry.texture : null;
    arr[24] = entry ? entry.size : 0;
    arr[25] = entry ? Number(eff.lut.domainMin) || 0 : 0;
    const dmax = entry ? Number(eff.lut.domainMax) : 1;
    arr[26] = Number.isFinite(dmax) && dmax > arr[25] ? dmax : arr[25] + 1;
  }
  /*
   * Object effects: THIS INSTANCE's subject scan. The Player resolves the field
   * for the current source time (objectTracking.resolveTrackFrame) and hands it
   * through ctx; the texture goes to uTexture1 and the geometry to the track
   * block, slots 18–27.
   *
   * No track (never scanned, or the entry was just added) leaves uTexture1 null
   * and slot 18 at 0 — every body reads a flat weight of 1.0 and works as a plain
   * picture program, which is the family's designed no-scan behaviour.
   */
  if (def.usesTrack) {
    const track = ctx.track || null;
    if (u.uTexture1) u.uTexture1.value = track ? track.texture : null;
    writeTrackSlots(arr, track);
  }
  /*
   * Geometry effects (objectGeometryEffects.js): the Canvas2D plate this INSTANCE
   * drew. Slot 16 is the "there is a plate this frame" flag — with no plate the
   * body is an exact pass-through, which is what a program that cannot draw yet
   * (media still decoding) has to look like.
   */
  if (def.usesPlate) {
    const plate = ctx.plate || null;
    if (u.uTexture2) u.uTexture2.value = plate ? plate.texture : null;
    arr[16] = plate ? 1 : 0;
  }
  // Content-box effects (Shape Rulers): the part of the layer box the layer
  // actually occupies, box uv (y up) — a text layer's laid-out block. The Player
  // resolves it per frame; null means the whole box.
  if (def.usesContentBox) {
    const cb = Array.isArray(ctx.contentBox) ? ctx.contentBox : null;
    arr[24] = cb ? cb[0] : 0;
    arr[25] = cb ? cb[1] : 0;
    arr[26] = cb ? cb[2] : 1;
    arr[27] = cb ? cb[3] : 1;
  }
  // Path-driven effects (Neon Glow): the Player bakes the layer's outline into
  // a float 1-D texture and pre-integrates the runner's rate keyframe tracks;
  // both arrive through ctx (per effect INSTANCE — each entry has its own eid
  // tracks and therefore its own phase). Sample count 0 is the shader's bypass.
  if (def.usesPath && u.uLUT) {
    const path = ctx.path;
    u.uLUT.value = path ? path.texture : null;
    arr[24] = path ? path.count : 0;
    arr[25] = path && path.closed ? 1 : 0;
    arr[26] = path ? path.plateWidth : 1;
    arr[27] = path ? path.plateHeight : 1;
    arr[20] = ctx.pathPhase || 0;
    arr[21] = ctx.pathMoving ? 1 : 0;
    arr[22] = ctx.pathHueAngle || 0;
    // Lines Draw: the runner's speed-derived width factor (0..1).
    arr[23] = ctx.pathAux || 0;
  }
  // Time-driven internal slots computed on the CPU each frame (Strip's eased
  // entrance/outro reach), from the resolved — keyframed — params and the
  // effect's own clock: ctx.time / ctx.duration, rebased onto an Active Range.
  if (typeof def.frameUniforms === 'function') {
    def.frameUniforms(arr, resolveEffectParams(def, eff), ctx);
  }
}

// Stable cache key for a custom effect's compiled material (code-hashed).
export function customEffectKey(code) {
  const s = String(code || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `custom:${h >>> 0}`;
}

// Compile-check custom GLSL in a throwaway 8×8 GL context (reuses the shader
// background harness). Returns an error string, or null when it compiles clean.
export function validateCustomEffect(code) {
  const body = String(code || '');
  if (!/\bvoid\s+mainImage\s*\(/.test(body)) {
    return 'Missing "void mainImage(out vec4 fragColor, in vec2 fragCoord)".';
  }
  return validateShaderCode(body, { prelude: CUSTOM_PRELUDE, wrapper: CUSTOM_MAIN });
}
