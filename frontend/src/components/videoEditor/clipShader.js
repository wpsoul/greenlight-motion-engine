import * as THREE from 'three';
import { normalizeBlendMode, isShaderBlendMode } from './blendModes.js';
import { withBorderKeyframes } from './borderKeyframes.js';
import { ccUniformValues, applyCcKeyframes } from './colorCorrection.js';

const vertexShader = /* glsl */ `
varying vec2 vUv;
// Clip-space position for Color Correction's Before/After split. Interpolated as
// a vec4 and divided per fragment, so the frame x is exact on a perspective plane
// too — and, unlike gl_FragCoord, it is still the FRAME's x when the layer is
// drawn into an intermediate plate.
varying vec4 vCcClip;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vCcClip = gl_Position;
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D uTexture;
uniform float uOpacity;
uniform float uDepthCut;   // 1 in the 3D view: discard transparent fragments so depth writes stay honest
// Blend modes (see applyBlendMode). uBlendCustom = 1 when a non-normal mode is
// active; uBlendIdentity is that mode's NEUTRAL colour — the value that leaves
// the destination untouched (black for screen/add/lighten, white for
// multiply/darken).
uniform float uBlendCustom;
uniform vec3 uBlendIdentity;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uHueRotate;
uniform float uGrayscale;
uniform float uSepia;
uniform float uInvert;
// Color Correction (colorCorrection.js — a Lumetri-style per-layer fix, lab:
// html/color-correction-lab.html). uCcCtl.x = 1 runs the stage at all; .y = the
// Before/After split in frame x (0..1, < 0 = no split); .z = Mix; .w = 1 stops at
// the input to Levels (the pickers' probe). Every other field is neutral when its
// section is off or at defaults, and the whole block is skipped when x = 0.
uniform vec4 uCcCtl;
uniform vec3 uCcGain;   // white balance × exposure, linear light
uniform vec4 uCcTone;   // contrast, highlights, shadows, whites (-1..1)
uniform vec4 uCcTone2;  // blacks, curve on, saturation, vibrance
uniform vec4 uCcFlags;  // levels, colour, wheels, hsl on
uniform vec4 uCcLvInB;  // x = RGB master, yzw = R G B (0..1)
uniform vec4 uCcLvInW;
uniform vec4 uCcLvGam;
uniform vec4 uCcLvOutB;
uniform vec4 uCcLvOutW;
uniform vec3 uCcWhS;    // shadows / midtones / highlights wheel offsets
uniform vec3 uCcWhM;
uniform vec3 uCcWhH;
uniform vec4 uCcHslH0;  // HSL bands 0-3 / 4-7 (-1..1): hue, saturation, luminance
uniform vec4 uCcHslH1;
uniform vec4 uCcHslS0;
uniform vec4 uCcHslS1;
uniform vec4 uCcHslL0;
uniform vec4 uCcHslL1;
varying vec4 vCcClip;
uniform float uBlur;
uniform float uZoomBlur; // transient radial sampling trail used by advanced transitions
// Point-aimed transitions: the radial trail's centre (frame UV, 0.5 = middle),
// a directional trail for translating transitions, the per-channel ray spread,
// and the switch between the legacy weighted kernel and the box one.
uniform vec2 uZoomCenter;
uniform vec2 uMoveBlur;
// RGB split: radial (scales with distance from the centre) for the zoom, a flat
// vector for the move. Both are independent of the blur length.
uniform float uRgbSplit;
uniform vec2 uSplitMove;
// Darkens the mirror-tiled ring. A perfect mirror of the frame edge reads as a
// second subject; knocking it back says "this is fill" without leaving a hole.
uniform float uTileFade;
uniform float uClipPathInset;
uniform float uLetterSpacing;
uniform vec3 uTintColor;
uniform vec4 uBgColor;
// Exposure flash (custom transition builder): washes the layer's own pixels
// toward the colour. White reads as a flash, black as a dip, anything else as
// a colour flash. Applied after the colour adjustments so it sits on the final
// grade, and only inside the layer's alpha (it rides the same fragment).
uniform vec3 uFlashColor;
uniform float uFlashAmount;
// Transition bloom (Advanced Zoom / Advanced Movement): highlights of the clip
// leak over their surroundings while the move is at speed. A 16-tap golden-angle
// spiral over the plate around this fragment, thresholded and added — a real
// pyramid would need render targets the clip material doesn't own, and at
// transition radii a fixed spiral is indistinguishable in motion.
uniform float uBloomAmount;     // strength, already enveloped (0 = off)
uniform float uBloomThreshold;  // 0..1 luminance knee
uniform float uBloomRadius;     // px at the 1080p reference height
uniform vec2 uResolution;
uniform vec2 uCanvasSize;
// Whole-shot video stabilization. The analyser stores a FORWARD source-pixel
// warp exactly like Canvas2D.setTransform; sampling needs its inverse, supplied
// here as two affine rows. Coordinates are display-oriented (Y down), so this
// runs after fit-contain has produced source UV and flips Y only for the math.
uniform float uStabilizeOn;
uniform vec4 uStabilizeLinear; // inverse rows: a,b,c,d
uniform vec2 uStabilizeOffset; // inverse tx,ty in analysis pixels
uniform vec2 uStabilizeSize;   // analysis width,height
// Grid Builder "Cover" fit: the fraction of the media CONTENT rect that stays
// visible, so a cell scaled to fill its box cannot bleed over its neighbours.
// (1,1) — the reset value — is no crop at all, i.e. every non-grid layer.
uniform vec2 uCellCrop;
// 1 while the layer is drawn as a grid CELL member: its letterbox bars must
// stay transparent — the cell floats in an arrangement over the project
// backdrop, so the full-frame "video player bars" treatment would paint an
// opaque comp-aspect plate behind every mismatched member.
uniform float uGridCell;
uniform vec2 uUvOffset;
uniform vec2 uUvScale;
// Advanced Zoom / Advanced Movement, camera side. These run in FRAME space,
// before uUvScale/uUvOffset, so the lens and the tremble belong to the camera
// and the transition's zoom or travel slides content through them. Applied
// after, the lens would be a property of the source and its bulge would grow
// with the ramp.
uniform float uFisheye;       // signed, already enveloped: -2 .. 2
uniform float uFisheyeFit;    // 1 = normalise so the farthest corner holds still
uniform int uFisheyeModel;    // 0 spherical (tan/atan), 1 barrel (k·r²)
uniform vec2 uFisheyeCenter;  // frame UV
uniform vec2 uUvPreOffset;    // camera tremble, screen space
uniform float uUvRotate;      // camera roll, radians
// What the roll turns about, frame UV. The camera tremble rolls about the frame
// centre (0.5, 0.5) — the reset value — while Advanced Zoom's Rotation turns
// about the zoom point, so the spin and the zoom share one pivot and whatever
// the transition is aimed at holds still while the frame turns around it.
uniform vec2 uUvRotateCenter;
// Advanced Movement's Perspective option: the lane's plate is a card tilted by
// uPerspTilt about the in-plane axis uPerspAxis through uPerspPivot (frame UV),
// seen by a camera uPerspDist frame-heights away. Per-lane by construction —
// each lane is its own material. It sits BETWEEN the camera chain above and the
// lane's UV window below: the tilt belongs to the plate, so it composes with
// the lane's own travel, and whatever it pushes past the source edge is still
// caught by the mirror fill. Closed form — no matrices (see the lab notes in
// html/movement-perspective-lab.html).
uniform float uPerspTilt;     // radians, signed; 0 = off
uniform vec2 uPerspAxis;      // tilt axis, unit, aspect space
uniform float uPerspDist;     // camera distance, frame heights
uniform vec2 uPerspPivot;     // frame UV
uniform float uPerspShade;    // 0..1 — darken the receding half like a lit card
uniform float uMirrorTile;
uniform float uAlphaExport; // 1 during a transparent (webm-alpha) render
uniform float uInputPremultiplied; // 1 when a precomposed effect plate is fed back into this material
// 1 on WebGPU when uTexture is a compositor render target (particles / 3D /
// sequence plates). Their V axis is opposite WebGL's when sampled on this
// perspective plane — see Player flipAdjustmentGeoV and lab pair 15.
uniform float uInputFlipV;

// Extra margin (canvas px) the mesh quad is grown by so drop shadows can paint
// beyond the content plate instead of clipping at the layer boundary. The UV
// remap below keeps the content itself at its original size/position.
uniform float uPlaneExpand;

// Card framing: rounded corners (per-corner radii), border ring (solid /
// dashed / dotted / double), drop + inset shadows (up to 4) — all in canvas
// px, applied to the media's content rect (the letterbox-fitted plate).
uniform vec4 uCornerRadii;      // TL, TR, BR, BL (y-up space: +y = top)
uniform float uBorderWidth;
uniform int uBorderStyle;       // 0 solid, 1 dashed, 2 dotted, 3 double
uniform vec4 uBorderColor;
uniform int uShadowCount;       // 0..4 active shadows
uniform vec4 uShadowColors[4];
uniform vec4 uShadowParams[4];  // x offset, y offset, blur, spread
uniform float uShadowInset[4];  // 1.0 = inset (inner) shadow

// Wipe masking: 0=none, 1=left, 2=right, 3=up, 4=down, 5=radial
uniform int uWipeType;
uniform float uWipeProgress;

// 3D Depth (2.5D parallax) — still-image layers only. uDepthMap is a greyscale
// depth plate (bright = near) generated once per photo and stored on the item;
// the shift/dolly terms come from the PROJECT CAMERA's move for this frame, so
// the parallax is driven by the camera rather than by anything in the shader.
// uDepthOn = 0 is an exact bypass. See depthParallax.js.
uniform float uDepthOn;
uniform sampler2D uDepthMap;
uniform vec2 uDepthShift;   // UV offset at (depth - focus) = 1
uniform float uDepthDolly;  // radial term, same scaling
uniform float uDepthFocus;  // depth value that stays pinned, 0..1

const float HALF_PI = 1.5707963;

// ── Color Correction ─────────────────────────────────────────────────────────
// Ported verbatim from html/color-correction-lab.html; the JS twins in
// colorCorrection.js (which Auto and the pickers solve through) use the same
// formulas, and clipShaderNodes.js carries the TSL twin. Input and output are the
// straight-alpha display values this shader grades everywhere else.
vec3 ccToLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 ccToDisp(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
// Tone: one curve on the RGB power norm; the colour rides the ratio, so lifting
// shadows does not shift hue (chroma ratio capped ×3 so a black lift cannot turn
// sensor noise into colour).
float ccContrast(float x, float k) {
  float y = clamp(x, 0.0, 1.0);
  float g = k > 0.0 ? 1.0 + 2.0 * k : 1.0 / (1.0 - 1.2 * k);
  float sc = y < 0.45 ? 0.45 * pow(y / 0.45, g) : 1.0 - 0.55 * pow((1.0 - y) / 0.55, g);
  return x + (sc - y) * 0.8;
}
float ccHigh(float x, float h) {
  float y = clamp(x, 0.0, 1.0);
  float up = x + h * 3.1572 * y * y * y * pow(1.0 - y, 1.5);
  float sc = x < 0.5 ? x : 0.5 + 0.5 * (1.0 - exp(-(x - 0.5) / 0.5));
  return h >= 0.0 ? up : mix(x, sc, -h);
}
float ccShad(float x, float s) { float y = clamp(x, 0.0, 1.0); float iy = 1.0 - y; return x + s * 3.1572 * pow(y, 1.5) * iy * iy * iy; }
float ccWhites(float x, float w) { float m = clamp(x, 0.0, 1.0); m *= m; return x * mix(1.0, 1.0 / (1.0 - 0.3 * w), m); }
float ccBlacks(float x, float b) { return x + b * 0.1 * (1.0 - smoothstep(0.0, 0.6, x)); }
vec3 ccTone(vec3 c) {
  vec3 p = max(c, 0.0);
  float d = dot(p, p);
  float n = d > 1e-10 ? dot(p * p, p) / d : 0.0;
  float m = ccContrast(n, uCcTone.x);
  m = ccHigh(m, uCcTone.y);
  m = ccShad(m, uCcTone.z);
  m = ccWhites(m, uCcTone.w);
  m = ccBlacks(m, uCcTone2.x);
  float r = n > 1e-6 ? m / n : 1.0;
  return vec3(m) + (c - vec3(n)) * clamp(r, 0.0, 3.0);
}
vec3 ccLevels(vec3 c) {
  c = clamp((c - uCcLvInB.yzw) / max(uCcLvInW.yzw - uCcLvInB.yzw, vec3(1e-4)), 0.0, 1.0);
  c = pow(c, 1.0 / uCcLvGam.yzw);
  c = uCcLvOutB.yzw + c * (uCcLvOutW.yzw - uCcLvOutB.yzw);
  c = clamp((c - uCcLvInB.x) / max(uCcLvInW.x - uCcLvInB.x, 1e-4), 0.0, 1.0);
  c = pow(c, vec3(1.0 / uCcLvGam.x));
  return uCcLvOutB.x + c * (uCcLvOutW.x - uCcLvOutB.x);
}
vec3 ccColor(vec3 c) {
  float Y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float s = mx > 1e-5 ? (mx - mn) / mx : 0.0;
  // Vibrance protects skin: hues between red and yellow (r >= g >= b, g mid-way).
  float q = (c.g - c.b) / max(c.r - c.b, 1e-5);
  float skin = (c.r >= c.g && c.g >= c.b) ? 1.0 - smoothstep(0.08, 0.32, abs(q - 0.45)) : 0.0;
  float v = uCcTone2.w * (1.0 - s) * (1.0 - s);
  if (uCcTone2.w > 0.0) v *= 1.0 - 0.6 * skin;
  return vec3(Y) + (c - vec3(Y)) * (uCcTone2.z * (1.0 + v));
}
vec3 ccWheels(vec3 c) {
  float Y = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  float ws = (1.0 - Y) * (1.0 - Y), wh = Y * Y;
  return c + ws * uCcWhS + (1.0 - ws - wh) * uCcWhM + wh * uCcWhH;
}
vec3 ccRgb2Hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 ccHsv2Rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
// One band's weight: rises a -> c, falls c -> b. Adjacent bands share the same
// smoothstep, so their weights always sum to 1.
float ccHat(float h, float a, float c, float b) { return h < c ? smoothstep(a, c, h) : 1.0 - smoothstep(c, b, h); }
vec3 ccHsl(vec3 c) {
  vec3 h = ccRgb2Hsv(clamp(c, 0.0, 1.0));
  float d = h.x * 360.0;
  vec4 w0 = vec4(max(ccHat(d, -60.0, 0.0, 30.0), ccHat(d, 300.0, 360.0, 390.0)),
                 ccHat(d, 0.0, 30.0, 60.0), ccHat(d, 30.0, 60.0, 120.0), ccHat(d, 60.0, 120.0, 180.0));
  vec4 w1 = vec4(ccHat(d, 120.0, 180.0, 240.0), ccHat(d, 180.0, 240.0, 270.0),
                 ccHat(d, 240.0, 270.0, 300.0), ccHat(d, 270.0, 300.0, 360.0));
  float dh = dot(w0, uCcHslH0) + dot(w1, uCcHslH1);
  float ds = dot(w0, uCcHslS0) + dot(w1, uCcHslS1);
  float dl = dot(w0, uCcHslL0) + dot(w1, uCcHslL1);
  float w = smoothstep(0.0, 0.12, h.y * h.z);   // chroma: greys are never touched
  vec3 r = ccHsv2Rgb(vec3(fract(h.x + dh * w * (30.0 / 360.0)), clamp(h.y * (1.0 + ds * w), 0.0, 1.0), h.z));
  return r * (1.0 + dl * 0.5 * w);
}
vec3 ccGrade(vec3 src) {
  vec3 c = ccToDisp(ccToLin(src) * uCcGain);   // display-referred, may exceed 1 until the end
  if (uCcTone2.y > 0.5) c = ccTone(c);
  if (uCcCtl.w < 0.5) {
    if (uCcFlags.x > 0.5) c = ccLevels(c);
    if (uCcFlags.y > 0.5) c = ccColor(c);
    if (uCcFlags.z > 0.5) c = ccWheels(c);
    if (uCcFlags.w > 0.5) c = ccHsl(c);
  }
  return mix(src, clamp(c, 0.0, 1.0), uCcCtl.z);
}

// CSS-style pairwise clamp so adjacent corner radii never overlap.
vec4 clampRadii(vec4 r, vec2 halfSize) {
  float w = 2.0 * halfSize.x;
  float h = 2.0 * halfSize.y;
  float s = 1.0;
  s = min(s, w / max(r.x + r.y, 1e-3));
  s = min(s, w / max(r.w + r.z, 1e-3));
  s = min(s, h / max(r.x + r.w, 1e-3));
  s = min(s, h / max(r.y + r.z, 1e-3));
  return r * s;
}

// Signed distance to a rounded rect with per-corner radii (r = TL,TR,BR,BL; y-up).
float roundedRectSDF(vec2 p, vec2 halfSize, vec4 r) {
  float rad = p.x < 0.0 ? (p.y > 0.0 ? r.x : r.w) : (p.y > 0.0 ? r.y : r.z);
  vec2 q = abs(p) - halfSize + rad;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - rad;
}

// Arc-length coordinate along the rounded-rect boundary (clockwise, starting at
// the top edge's left end). Places dashes/dots at a steady rhythm around the
// full outline, corners included.
float perimeterCoord(vec2 p, vec2 b, vec4 r) {
  float lTop = 2.0 * b.x - r.x - r.y;
  float lRight = 2.0 * b.y - r.y - r.z;
  float lBot = 2.0 * b.x - r.z - r.w;
  float sTR = lTop;
  float sRight = sTR + HALF_PI * r.y;
  float sBR = sRight + lRight;
  float sBot = sBR + HALF_PI * r.z;
  float sBL = sBot + lBot;
  float sLeft = sBL + HALF_PI * r.w;
  float sTL = sLeft + (2.0 * b.y - r.w - r.x);

  vec2 cTL = vec2(-b.x + r.x,  b.y - r.x);
  vec2 cTR = vec2( b.x - r.y,  b.y - r.y);
  vec2 cBR = vec2( b.x - r.z, -b.y + r.z);
  vec2 cBL = vec2(-b.x + r.w, -b.y + r.w);

  if (p.x > cTR.x && p.y > cTR.y) {
    float a = atan(p.y - cTR.y, p.x - cTR.x);
    return sTR + (HALF_PI - a) * r.y;
  }
  if (p.x > cBR.x && p.y < cBR.y) {
    float a = atan(cBR.y - p.y, p.x - cBR.x);
    return sBR + a * r.z;
  }
  if (p.x < cBL.x && p.y < cBL.y) {
    float a = atan(cBL.y - p.y, cBL.x - p.x);
    return sBL + (HALF_PI - a) * r.w;
  }
  if (p.x < cTL.x && p.y > cTL.y) {
    float a = atan(p.y - cTL.y, cTL.x - p.x);
    return sTL + a * r.x;
  }
  float dTop = b.y - p.y;
  float dBot = p.y + b.y;
  float dLeft = p.x + b.x;
  float dRight = b.x - p.x;
  float m = min(min(dTop, dBot), min(dLeft, dRight));
  if (m == dTop) return p.x - (-b.x + r.x);
  if (m == dRight) return sRight + (cTR.y - p.y);
  if (m == dBot) return sBot + (cBR.x - p.x);
  return sLeft + (p.y - cBL.y);
}

// 0..1 mask shaping the border ring into its style's pattern.
float borderPatternMask(vec2 p, vec2 b, vec4 r, float d, float w) {
  if (uBorderStyle == 1) { // dashed: 3w dash / 2w gap
    float s = perimeterCoord(p, b, r);
    float t = abs(mod(s, 5.0 * w) - 1.5 * w);
    return 1.0 - smoothstep(1.5 * w - 0.75, 1.5 * w + 0.75, t);
  }
  if (uBorderStyle == 2) { // dotted: round dots of diameter w, gap w
    float s = perimeterCoord(p, b, r);
    float along = mod(s, 2.0 * w) - w;
    float across = d + 0.5 * w;
    float dd = length(vec2(along, across)) - 0.5 * w;
    return 1.0 - smoothstep(-0.75, 0.75, dd);
  }
  if (uBorderStyle == 3) { // double: outer + inner thirds of the ring
    float t = -d / max(w, 1e-3);
    return clamp(1.0 - smoothstep(0.31, 0.36, t) + smoothstep(0.64, 0.69, t), 0.0, 1.0);
  }
  return 1.0;
}

// Straight-alpha "src over dst".
vec4 overComposite(vec4 src, vec4 dst) {
  float a = src.a + dst.a * (1.0 - src.a);
  if (a < 1e-5) return vec4(0.0);
  vec3 rgb = (src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / a;
  return vec4(rgb, a);
}

// Blend modes: fade the source toward the mode's IDENTITY by its own alpha
// (coverage × layer opacity) before the hardware blend sees it. GPU blending
// cannot do this for us — Min/Max ignore the blend factors entirely, and
// screen's OneMinusSrcColor factor never looks at alpha — so without this a
// layer at 30% opacity would still screen/lighten/darken at FULL strength, and
// its transparent pixels would blend too. Fading to the identity makes every
// mode collapse to "no change" at alpha 0 and to the exact mode at alpha 1
// (multiply/screen/add are then exact at every opacity in between).
vec4 blendFade(vec4 c) {
  if (uBlendCustom < 0.5) return c;
  return vec4(mix(uBlendIdentity, c.rgb, c.a), c.a);
}

float mirrorRepeat(float v) {
  float t = fract(v * 0.5);
  return 1.0 - abs(t * 2.0 - 1.0);
}

vec2 mirrorRepeat2(vec2 uv) {
  return vec2(mirrorRepeat(uv.x), mirrorRepeat(uv.y));
}

vec3 applyHueRotation(vec3 color, float angle) {
  float rad = angle * 3.14159265 / 180.0;
  float cosA = cos(rad);
  float sinA = sin(rad);
  mat3 hueRotMat = mat3(
    0.213 + cosA * 0.787 - sinA * 0.213,
    0.213 - cosA * 0.213 + sinA * 0.143,
    0.213 - cosA * 0.213 - sinA * 0.787,
    0.715 - cosA * 0.715 - sinA * 0.715,
    0.715 + cosA * 0.285 + sinA * 0.140,
    0.715 - cosA * 0.715 + sinA * 0.715,
    0.072 - cosA * 0.072 + sinA * 0.928,
    0.072 - cosA * 0.072 - sinA * 0.283,
    0.072 + cosA * 0.928 + sinA * 0.072
  );
  return clamp(hueRotMat * color, 0.0, 1.0);
}

// Layer blur = a real 2D Gaussian with CSS semantics (blur(r): σ = r px — the same number blurs the
// same amount here, in an HTML page and in the UI kit lab). 48 taps on a golden-angle spiral out to
// 2.5σ, Gaussian-weighted; the spiral turns per pixel so what little structure is left becomes fine
// grain. The old kernel sampled only a + cross, a whole blur radius apart, so a big blur showed as
// offset copies of the layer. Zero blur is one tap (the common case costs nothing).
vec4 sampleBlurred(vec2 uv) {
  if (uBlur <= 0.0) return texture2D(uTexture, uv);
  float sigma = uBlur;
  float reach = 2.5 * sigma;
  float spin = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec4 sum = texture2D(uTexture, uv);
  float wsum = 1.0;
  for (int i = 0; i < 48; i++) {
    float fi = float(i) + 0.5;
    float r = reach * sqrt(fi / 48.0);
    float a = fi * 2.39996323 + spin;
    float w = exp(-(r * r) / (2.0 * sigma * sigma));
    sum += texture2D(uTexture, uv + vec2(cos(a), sin(a)) * r / uResolution) * w;
    wsum += w;
  }
  return sum / wsum;
}

/*
 * Fisheye radial gain at normalised radius r, where r = 1 is the farthest corner
 * from the lens centre. A factor BELOW 1 magnifies that ring (we look up nearer
 * the middle); ABOVE 1 squeezes it.
 *
 *   spherical  tan(x)/x grows with r → the dome; atan(x)/x shrinks → its exact
 *              inverse, the pinch. One signed control, two directions.
 *   barrel     1 + k·r², the cheap polynomial lens — softer shoulder, no
 *              asymptote, and what most "lens distortion" sliders actually are.
 *
 * Two of the four quadrants stop being a lens if pushed far enough — tan blows
 * through its asymptote past x = π/2, and the barrel's polynomial crosses zero —
 * and past those the sampled radius stops growing with r, so the image mirrors
 * through the centre instead of bulging. Both are held off with a soft cap that
 * is the IDENTITY over the amounts the slider used to reach (|k| ≤ 1) and only
 * bends above them, so widening the range cannot restyle a saved transition.
 */
const float LENS_X_SOFT = 1.35;   // = |k| 1.0 at the corner: the old ceiling
const float LENS_X_MAX  = 1.53;   // < π/2, so tan stays finite and positive
const float LENS_G_SOFT = 0.35;
const float LENS_G_MIN  = 0.12;   // the barrel's gain floor: never reaches zero

// Exponential soft cap/floor: identity on the safe side of the soft knee,
// asymptotic to the limit on the other, and C1 across the join (the exponent's
// scale IS the gap between them).
float lensSoftCap(float v, float soft, float limit) {
  if (v <= soft) return v;
  return limit - (limit - soft) * exp(-(v - soft) / (limit - soft));
}

float lensSoftFloor(float v, float soft, float limit) {
  if (v >= soft) return v;
  return limit + (soft - limit) * exp((v - soft) / (soft - limit));
}

float transitionLensProfile(float r, float k) {
  if (uFisheyeModel == 1) return lensSoftFloor(1.0 + k * 1.7 * r * r, LENS_G_SOFT, LENS_G_MIN);
  float a = abs(k) * 1.35;
  float x = r * a;
  if (x < 0.0008) return 1.0;
  // atan has no asymptote, so only the dome needs capping — the pinch keeps
  // squeezing for as far as the slider goes.
  if (k > 0.0) { x = lensSoftCap(x, LENS_X_SOFT, LENS_X_MAX); return tan(x) / x; }
  return atan(x) / x;
}

vec2 applyTransitionLens(vec2 p, vec2 frameAspect) {
  if (abs(uFisheye) < 0.0015) return p;
  vec2 d = (p - uFisheyeCenter) * frameAspect;
  // Farthest corner FROM THE LENS CENTRE, so the normalisation follows an
  // off-centre lens instead of assuming it sits in the middle of the frame.
  vec2 far = max(uFisheyeCenter, vec2(1.0) - uFisheyeCenter) * frameAspect;
  float f = transitionLensProfile(length(d) / max(length(far), 0.0001), uFisheye);
  if (uFisheyeFit > 0.5) f /= transitionLensProfile(1.0, uFisheye);
  return uFisheyeCenter + (d * f) / frameAspect;
}

vec2 applyTransitionRoll(vec2 p, vec2 frameAspect) {
  if (abs(uUvRotate) < 0.00002) return p;
  vec2 d = (p - uUvRotateCenter) * frameAspect;
  float s = sin(uUvRotate);
  float c = cos(uUvRotate);
  return uUvRotateCenter + vec2(d.x * c - d.y * s, d.x * s + d.y * c) / frameAspect;
}

/*
 * Inverse perspective tilt: screen point p back onto a plate rotated by
 * uPerspTilt about the in-plane axis uPerspAxis through uPerspPivot, camera at
 * uPerspDist. With t = dot(s, axis) and w = dot(s, axis-perp):
 *
 *     w0 = w·d / (cosθ·d + w·sinθ)        t0 = t·(d − w0·sinθ) / d
 *
 * and the source depth is z = w0·sinθ (+ = toward camera). Since
 * d − z = d²cosθ / den, ONE guard on the denominator covers both fractions for
 * any |θ| < 90°. Past it (den ≤ 0) the ray never meets the plate — that wedge
 * holds no image whatever the edge fill, so the caller discards it.
 *
 * Returns warped point in .xy, depth in .z, and .w = 0 past the horizon.
 */
vec4 applyTransitionPerspective(vec2 p, vec2 frameAspect) {
  vec2 q = (p - uPerspPivot) * frameAspect;
  vec2 axis = uPerspAxis;
  vec2 tdir = vec2(axis.y, -axis.x);
  float tp = dot(q, axis);
  float wp = dot(q, tdir);
  float cs = cos(uPerspTilt);
  float sn = sin(uPerspTilt);
  float d = max(uPerspDist, 0.2);
  float den = cs * d + wp * sn;
  if (den < 0.03) return vec4(0.0, 0.0, 0.0, 0.0);
  float w0 = wp * d / den;
  float z = w0 * sn;
  float t0 = tp * (d - z) / d;
  return vec4(uPerspPivot + (axis * t0 + tdir * w0) / frameAspect, z, 1.0);
}

/*
 * One march serves both transition blurs. Each tap steps along
 *
 *     (uv - centre) · zoom   +   move
 *
 * so a zoom-only vector gives the radial streak of the Radial Blur overlay
 * effect and a move-only vector gives a directional smear along the travel —
 * they are the same integral, only the direction field differs.
 *
 * The spread argument shifts every tap's ray length, which is how the RGB split
 * is done:
 * three marches at slightly different lengths, one per channel, so the fringe
 * follows the same geometry as the blur instead of being a flat pixel offset.
 */
vec4 marchTransitionBlur(vec2 uv, vec2 centre, vec2 move, vec2 splitMove, float channel) {
  // Per-channel displacement for the RGB split. It is its OWN offset rather than
  // a scale on the blur ray, so the split is usable with the blur at zero — the
  // two are separate controls and one must not silently disable the other.
  vec2 split = ((uv - centre) * uRgbSplit + splitMove) * channel;
  vec2 walk = (uv - centre) * uZoomBlur + move;

  if (dot(walk, walk) < 0.0000001) return texture2D(uTexture, clamp(uv - split, 0.0, 1.0));

  vec4 sum = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    float t = float(i) / 15.0 - 0.5;
    sum += texture2D(uTexture, clamp(uv - walk * t - split, 0.0, 1.0));
  }
  return sum / 16.0;
}

vec4 sampleWithZoomBlur(vec2 uv, vec2 centre, vec2 move, vec2 splitMove) {
  bool blurred = uZoomBlur > 0.0001 || dot(move, move) > 0.0000001;
  bool split = uRgbSplit > 0.00001 || dot(splitMove, splitMove) > 0.0000001;
  if (!blurred && !split) return sampleBlurred(uv);
  if (!split) return marchTransitionBlur(uv, centre, move, splitMove, 0.0);

  vec4 r = marchTransitionBlur(uv, centre, move, splitMove,  1.0);
  vec4 g = marchTransitionBlur(uv, centre, move, splitMove,  0.0);
  vec4 b = marchTransitionBlur(uv, centre, move, splitMove, -1.0);
  return vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}

void main() {
  // Map the (possibly expanded) quad's UVs back onto the logical canvas rect —
  // fragments in the margin land outside [0,1] and only the shadow paints there.
  vec2 sampleUv = vUv;
  if (uPlaneExpand > 0.5 && uCanvasSize.x > 0.0 && uCanvasSize.y > 0.0) {
    vec2 expanded = uCanvasSize + 2.0 * uPlaneExpand;
    sampleUv = 0.5 + (vUv - 0.5) * (expanded / uCanvasSize);
  }
  // Camera tremble, roll and lens, in that order — all in frame space, all
  // BEFORE the layer's UV transform and the mirror fold below, so whatever they
  // push past the source edge is still caught by the fill. One branch, false for
  // every layer that is not mid-transition.
  if (abs(uFisheye) > 0.0 || abs(uUvRotate) > 0.0 || dot(uUvPreOffset, uUvPreOffset) > 0.0) {
    vec2 frameAspect = vec2(1.0);
    if (uCanvasSize.x > 0.0 && uCanvasSize.y > 0.0) {
      frameAspect.x = max(uCanvasSize.x / uCanvasSize.y, 0.0001);
    }
    sampleUv = applyTransitionLens(applyTransitionRoll(sampleUv + uUvPreOffset, frameAspect), frameAspect);
  }

  // Perspective tilt (Advanced Movement). After the camera chain — the tilted
  // plate is seen THROUGH the lens/roll — and before the lane's UV window, so
  // the tilt composes with the travel and the mirror fold still fills what it
  // exposes. The past-horizon wedge holds no image at all: discarded, never
  // routed into the letterbox path (which paints opaque black).
  float perspDepth = 0.0;
  if (abs(uPerspTilt) > 0.0005) {
    vec2 frameAspect = vec2(1.0);
    if (uCanvasSize.x > 0.0 && uCanvasSize.y > 0.0) {
      frameAspect.x = max(uCanvasSize.x / uCanvasSize.y, 0.0001);
    }
    vec4 warped = applyTransitionPerspective(sampleUv, frameAspect);
    if (warped.w < 0.5) discard;
    sampleUv = warped.xy;
    perspDepth = warped.z;
  }

  vec2 transformedUv = sampleUv * uUvScale + uUvOffset;

  // How far past the source this fragment landed, before the mirror folds it
  // back — i.e. whether we are looking at real image or at tiled fill.
  float tileFill = 0.0;
  // Set where a transition's UV window pushed this fragment past the source and
  // there is no fill to catch it. The letterbox path below paints opaque BLACK,
  // which is what a clip's own bars want — but a transition lane set to "No
  // fill" would then black out the clip it is crossing with, i.e. read as a crop
  // instead of simply not filling. Those fragments stay EMPTY.
  float uvPushedOut = 0.0;
  if (uMirrorTile > 0.5) {
    vec2 over = max(vec2(0.0) - transformedUv, transformedUv - vec2(1.0));
    tileFill = clamp(max(over.x, over.y) * 3.0, 0.0, 1.0);
    sampleUv = mirrorRepeat2(transformedUv);
  } else {
    vec2 over = max(vec2(0.0) - transformedUv, transformedUv - vec2(1.0));
    uvPushedOut = step(0.0001, max(over.x, over.y));
    // Under that threshold the fragment is ON the plate's edge: a pixel centre
    // that lands exactly on the quad's edge is rasterized with a UV a float-error
    // hair past 0 or 1. Clamp it back, or the letterbox path below paints it
    // opaque black — a 1px black line down the whole edge of a shape or text plate
    // at whatever preview sizes put that edge on a pixel centre. A real letterbox
    // bar stays black: the clamped UV still lands in the bar after the fit.
    sampleUv = uvPushedOut > 0.5 ? transformedUv : clamp(transformedUv, 0.0, 1.0);
  }

  // Render-target plates on WebGPU arrive V-flipped relative to WebGL. Apply
  // AFTER the UV transform so transitions that write uUvScale/Offset still land
  // on the right texels of an upright plate.
  if (uInputFlipV > 0.5) {
    sampleUv.y = 1.0 - sampleUv.y;
  }

  if (abs(uLetterSpacing) > 0.001) {
    float spread = clamp(uLetterSpacing / 1000.0, -0.2, 0.2);
    sampleUv.x = 0.5 + (sampleUv.x - 0.5) * (1.0 + spread);
  }

  if (uClipPathInset > 0.001) {
    float inset = clamp(uClipPathInset / 100.0, 0.0, 0.49);
    if (
      sampleUv.x < inset ||
      sampleUv.x > 1.0 - inset ||
      sampleUv.y < inset ||
      sampleUv.y > 1.0 - inset
    ) {
      discard;
    }
  }

  // Wipe masking
  if (uWipeType > 0 && uWipeProgress < 1.0) {
    bool masked = false;
    if (uWipeType == 1) masked = sampleUv.x > uWipeProgress;       // wipe left
    else if (uWipeType == 2) masked = sampleUv.x < 1.0 - uWipeProgress; // wipe right
    else if (uWipeType == 3) masked = sampleUv.y < 1.0 - uWipeProgress; // wipe up (UV y is flipped)
    else if (uWipeType == 4) masked = sampleUv.y > uWipeProgress;       // wipe down
    else if (uWipeType == 5) {                                      // radial
      float dist = length(sampleUv - vec2(0.5));
      masked = dist > uWipeProgress * 0.7071; // 0.7071 = sqrt(0.5) = max corner dist
    }
    if (masked) discard;
  }

  // Fit-contain: keep the FULL media plate visible (never crop). When the media
  // aspect ratio differs from the frame, letterbox the spare axis instead of
  // filling+cropping — a wide clip in a tall frame pillarboxes, a tall clip in a
  // wide frame letterboxes. The frame (visible area) can still hide parts once
  // the layer is zoomed/panned, but the underlying plate stays whole.
  vec2 texUv = sampleUv;
  vec2 contentHalf = 0.5 * uCanvasSize; // media content rect half-size in px
  // The letterbox is a scale about the middle, kept here so anything else that
  // has to live in texture space — the transition blur's centre and direction —
  // can be carried through the identical remap instead of guessing.
  vec2 fitScale = vec2(1.0);
  if (uResolution.x > 0.0 && uResolution.y > 0.0 && uCanvasSize.x > 0.0 && uCanvasSize.y > 0.0) {
    float mediaAR = uResolution.x / uResolution.y;
    float canvasAR = uCanvasSize.x / uCanvasSize.y;
    if (abs(mediaAR - canvasAR) > 0.01) {
      if (mediaAR > canvasAR) {
        // Media is wider than the frame → fit width, letterbox top/bottom.
        fitScale.y = mediaAR / canvasAR;
        texUv.y = 0.5 + (sampleUv.y - 0.5) * fitScale.y;
        contentHalf.y = 0.5 * uCanvasSize.y * (canvasAR / mediaAR);
      } else {
        // Media is taller than the frame → fit height, pillarbox left/right.
        fitScale.x = canvasAR / mediaAR;
        texUv.x = 0.5 + (sampleUv.x - 0.5) * fitScale.x;
        contentHalf.x = 0.5 * uCanvasSize.x * (mediaAR / canvasAR);
      }
    }
  }

  // Independent source warp: no mesh/camera/motion-track transform is touched.
  // Applying the INVERSE is the raster rule: for each output pixel, ask which
  // decoded source pixel the lab's forward warp placed here.
  if (uStabilizeOn > 0.5 && uStabilizeSize.x > 0.0 && uStabilizeSize.y > 0.0) {
    vec2 outPx = vec2(texUv.x * uStabilizeSize.x, (1.0 - texUv.y) * uStabilizeSize.y);
    vec2 srcPx = vec2(
      uStabilizeLinear.x * outPx.x + uStabilizeLinear.y * outPx.y,
      uStabilizeLinear.z * outPx.x + uStabilizeLinear.w * outPx.y
    ) + uStabilizeOffset;
    texUv = vec2(srcPx.x / uStabilizeSize.x, 1.0 - srcPx.y / uStabilizeSize.y);
  }

  // Crop the content rect to the grid cell (see uCellCrop). Done here, on the
  // rect the letterbox just resolved, so it hugs the DRAWN pixels rather than
  // the quad — a pillarboxed clip crops its picture, not its empty bars.
  if (uCellCrop.x < 0.999 || uCellCrop.y < 0.999) {
    vec2 pCell = (sampleUv - 0.5) * uCanvasSize;
    if (abs(pCell.x) > contentHalf.x * uCellCrop.x || abs(pCell.y) > contentHalf.y * uCellCrop.y) discard;
  }

  // Card framing (rounded corners / border / shadow) needs the letterbox area to
  // stay transparent so what's below shows through, so it opts out of the early
  // return the plain path uses.
  bool hasShadow = uShadowCount > 0;
  bool hasFraming = (uCornerRadii.x + uCornerRadii.y + uCornerRadii.z + uCornerRadii.w) > 0.25
    || uBorderWidth > 0.25 || hasShadow;

  bool insideMedia = true;
  if (uMirrorTile > 0.5) {
    texUv = mirrorRepeat2(texUv);
  } else if (texUv.x < 0.0 || texUv.x > 1.0 || texUv.y < 0.0 || texUv.y > 1.0) {
    if (!hasFraming) {
      // Letterbox/pillarbox area of a clip that doesn't match the canvas aspect.
      // Normally opaque black — the bars read like a video player's and hide the
      // layers below. In a transparent export they must stay empty instead, or a
      // single mismatched clip would make the whole alpha channel opaque. Grid
      // cell members keep them empty too (uGridCell): a cell is not the frame.
      vec4 empty = vec4(0.0, 0.0, 0.0,
        uOpacity * (1.0 - uAlphaExport) * (1.0 - uGridCell) * (1.0 - uvPushedOut));
      if (uBgColor.a > 0.001 && uvPushedOut < 0.5) {
        empty.rgb = mix(uBgColor.rgb, empty.rgb, empty.a);
        empty.a = max(empty.a, uBgColor.a);
      }
      gl_FragColor = blendFade(empty);
      return;
    }
    insideMedia = false;
    texUv = clamp(texUv, 0.0, 1.0);
  }

  // 3D Depth: displace the sampling UV by this pixel's depth, so the camera's
  // move parts near pixels from far ones. Applied AFTER the letterbox/insideMedia
  // decision and clamped, so it only ever changes which part of the plate a
  // fragment reads — never the layer's geometry, framing or alpha.
  //
  // The loop is the point: one lookup would use the depth of the pixel we
  // started from, so a silhouette drags its own background along with it. Each
  // iteration re-reads depth at the displaced position and converges on the
  // surface actually visible along that ray.
  if (uDepthOn > 0.5 && insideMedia) {
    vec2 shifted = texUv;
    for (int i = 0; i < 3; i++) {
      float d = texture2D(uDepthMap, shifted).r - uDepthFocus;
      // Dolly MAGNIFIES the near plane, and magnifying means sampling closer to
      // the centre — hence the minus. Adding would shrink what the camera is
      // pushing into.
      shifted = texUv + uDepthShift * d - (texUv - 0.5) * (uDepthDolly * d);
    }
    texUv = clamp(shifted, 0.0, 1.0);
  }

  // The zoom pivot is a FIXED POINT of the layer's UV transform (scaling about
  // it leaves it where it is), so it needs no un-zooming here — only the
  // letterbox remap that separates frame space from texture space.
  vec4 color = sampleWithZoomBlur(
    texUv,
    0.5 + (uZoomCenter - 0.5) * fitScale,
    uMoveBlur * fitScale,
    uSplitMove * fitScale
  );
  if (!insideMedia) color = vec4(0.0);
  // Per-layer Overlay Effects render into a transparent framebuffer, whose RGB is
  // premultiplied by alpha. Transitions reuse this clip shader, which normally
  // accepts straight-alpha media, so recover straight RGB before its own opacity,
  // wipe and blend stage. This keeps soft edges from being multiplied twice.
  if (uInputPremultiplied > 0.5 && color.a > 0.00001) color.rgb /= color.a;

  if (uTileFade > 0.001 && tileFill > 0.0) color.rgb *= 1.0 - uTileFade * tileFill;

  // Lit-card shading from the perspective tilt's source depth: the receding
  // half falls into shadow, the near half gets a whisper of lift.
  if (uPerspShade > 0.001 && abs(uPerspTilt) > 0.0005) {
    float shadeR = perspDepth / (0.35 * max(uPerspDist, 0.2));
    color.rgb *= 1.0 - uPerspShade * 0.85 * clamp(-shadeR, 0.0, 1.0);
    color.rgb *= 1.0 + uPerspShade * 0.15 * clamp(shadeR, 0.0, 1.0);
  }

  // Color Correction fixes the SOURCE, so it runs ahead of the stylising
  // filters below. Before/After: frame x left of the split keeps the original.
  if (uCcCtl.x > 0.5 && (uCcCtl.y < 0.0 || vCcClip.x / vCcClip.w * 0.5 + 0.5 >= uCcCtl.y)) {
    color.rgb = ccGrade(clamp(color.rgb, 0.0, 1.0));
  }

  // Brightness
  color.rgb *= uBrightness;

  // Contrast
  color.rgb = (color.rgb - 0.5) * uContrast + 0.5;

  // Saturation
  float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
  color.rgb = mix(vec3(luminance), color.rgb, uSaturation);

  // Hue rotation
  if (abs(uHueRotate) > 0.5) {
    color.rgb = applyHueRotation(color.rgb, uHueRotate);
  }

  // Grayscale
  if (uGrayscale > 0.0) {
    float gray = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    color.rgb = mix(color.rgb, vec3(gray), uGrayscale);
  }

  // Sepia
  if (uSepia > 0.0) {
    vec3 sepiaColor = vec3(
      dot(color.rgb, vec3(0.393, 0.769, 0.189)),
      dot(color.rgb, vec3(0.349, 0.686, 0.168)),
      dot(color.rgb, vec3(0.272, 0.534, 0.131))
    );
    color.rgb = mix(color.rgb, sepiaColor, uSepia);
  }

  // Invert (CSS invert(): mix toward 1 - c)
  if (uInvert > 0.0) {
    color.rgb = mix(color.rgb, 1.0 - color.rgb, uInvert);
  }

  color.rgb *= uTintColor;
  // Bloom sits under the flash: leaked light is still light, so the wash blows
  // it out with everything else. Taps read the RAW plate (not the graded colour)
  // — bloom is additive light, and grading 16 taps would cost 16× the grade.
  if (uBloomAmount > 0.001) {
    vec2 rad = uBloomRadius / 1080.0 * vec2(uCanvasSize.y / max(uCanvasSize.x, 1.0), 1.0) * fitScale;
    vec3 acc = vec3(0.0);
    float ws = 0.0;
    for (int i = 0; i < 16; i++) {
      float fi = float(i);
      float ang = fi * 2.39996;
      float rr = sqrt((fi + 0.5) / 16.0);
      vec3 s = texture2D(uTexture, clamp(texUv + vec2(cos(ang), sin(ang)) * rr * rad, 0.0, 1.0)).rgb;
      float w = 1.0 - rr * 0.7;
      float bright = max(0.0, dot(s, vec3(0.2126, 0.7152, 0.0722)) - uBloomThreshold)
        / max(1.0 - uBloomThreshold, 1e-3);
      acc += s * bright * w;
      ws += w;
    }
    color.rgb += acc / max(ws, 1e-3) * uBloomAmount;
  }
  if (uFlashAmount > 0.001) {
    color.rgb = mix(color.rgb, uFlashColor, uFlashAmount);
  }
  color.rgb = clamp(color.rgb, 0.0, 1.0);
  color.a *= uOpacity;

  if (hasFraming) {
    // p = px from the content-rect center, in this layer's (possibly UV-shifted) space.
    vec2 p = (sampleUv - 0.5) * uCanvasSize;
    float maxR = min(contentHalf.x, contentHalf.y);
    vec4 radii = clampRadii(clamp(uCornerRadii, vec4(0.0), vec4(maxR)), contentHalf);
    float d = roundedRectSDF(p, contentHalf, radii);
    float aa = 1.5;

    // Clip the content to the rounded rect.
    color.a *= 1.0 - smoothstep(-aa, aa, d);

    // Drop shadows under the content (same rounded rect, offset + softened).
    // Loop order preserves CSS semantics: the first shadow sits on top.
    for (int i = 0; i < 4; i++) {
      if (i >= uShadowCount) break;
      if (uShadowInset[i] > 0.5) continue;
      vec4 sp = uShadowParams[i];
      float ds = roundedRectSDF(
        p - vec2(sp.x, -sp.y),
        max(contentHalf + vec2(sp.w), vec2(0.5)),
        max(radii + vec4(sp.w), vec4(0.0))
      );
      float soft = max(sp.z, 1.0);
      float shadowMask = 1.0 - smoothstep(-soft, soft, ds);
      color = overComposite(color, vec4(uShadowColors[i].rgb, uShadowColors[i].a * shadowMask * uOpacity));
    }

    // Inset shadows drawn over the content, clipped to the rounded rect.
    for (int i = 0; i < 4; i++) {
      if (i >= uShadowCount) break;
      if (uShadowInset[i] < 0.5) continue;
      vec4 sp = uShadowParams[i];
      float ds = roundedRectSDF(
        p - vec2(sp.x, -sp.y),
        max(contentHalf - vec2(sp.w), vec2(0.5)),
        max(radii - vec4(sp.w), vec4(0.0))
      );
      float soft = max(sp.z, 1.0);
      float shadowMask = smoothstep(-soft, soft, ds) * (1.0 - smoothstep(-aa, aa, d));
      color = overComposite(vec4(uShadowColors[i].rgb, uShadowColors[i].a * shadowMask * uOpacity), color);
    }

    // Border ring drawn on top, hugging the inside of the rounded edge.
    if (uBorderWidth > 0.25) {
      float ring = (1.0 - smoothstep(-aa, aa, d)) * smoothstep(-uBorderWidth - aa, -uBorderWidth + aa, d);
      ring *= borderPatternMask(p, contentHalf, radii, d, uBorderWidth);
      color = overComposite(vec4(uBorderColor.rgb, uBorderColor.a * ring * uOpacity), color);
    }
  }

  if (uBgColor.a > 0.001) {
    vec3 outRgb = mix(uBgColor.rgb, color.rgb, color.a);
    float outA = max(color.a, uBgColor.a);
    gl_FragColor = vec4(outRgb, outA);
  } else {
    gl_FragColor = color;
  }

  gl_FragColor = blendFade(gl_FragColor);

  // Depth mode (the 3D view). Layers normally never touch the depth buffer — the
  // compositor decides order — but in the 3D view they share a scene with real model
  // geometry, and a quad that ignores depth flips in front of or behind a solid as the
  // orbit camera swings past its centre. With depth writing on, transparent fragments
  // must be discarded or a layer would occlude with its empty pixels.
  if (uDepthCut > 0.5 && gl_FragColor.a < 0.02) discard;
}
`;

// Transparent-render switch. Set for the duration of a webm-alpha export; every
// clip material picks it up on its next per-frame reset, so one call covers all
// channels and nested sequences.
let alphaExportMode = false;

/**
 * Read the flag. Exported because the NODE clip material has to seed
 * `uAlphaExport` at construction exactly as `createClipMaterial` does below —
 * a material built mid-export and used before the next
 * `resetMaterialUniforms()` would otherwise start with letterboxing ON and fill
 * its bars opaque black in a transparent render.
 */
export function isAlphaExportMode() {
  return alphaExportMode;
}

export function setAlphaExportMode(enabled) {
  alphaExportMode = Boolean(enabled);
}

// The Color Correction uniform set, shared by the GLSL material's constructor;
// the TSL twin builds the same names with the same defaults.
function createColorCorrectionUniforms() {
  return {
    uCcCtl: { value: new THREE.Vector4(0, -1, 0, 0) },
    uCcGain: { value: new THREE.Vector3(1, 1, 1) },
    uCcTone: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCcTone2: { value: new THREE.Vector4(0, 0, 1, 0) },
    uCcFlags: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCcLvInB: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCcLvInW: { value: new THREE.Vector4(1, 1, 1, 1) },
    uCcLvGam: { value: new THREE.Vector4(1, 1, 1, 1) },
    uCcLvOutB: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCcLvOutW: { value: new THREE.Vector4(1, 1, 1, 1) },
    uCcWhS: { value: new THREE.Vector3(0, 0, 0) },
    uCcWhM: { value: new THREE.Vector3(0, 0, 0) },
    uCcWhH: { value: new THREE.Vector3(0, 0, 0) },
    uCcHslH0: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCcHslH1: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCcHslS0: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCcHslS1: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCcHslL0: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCcHslL1: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
}

export function createClipMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uTexture: { value: null },
      uOpacity: { value: 1.0 },
      uBlendCustom: { value: 0.0 },
      uBlendIdentity: { value: new THREE.Vector3(0, 0, 0) },
      uBrightness: { value: 1.0 },
      uContrast: { value: 1.0 },
      uSaturation: { value: 1.0 },
      uHueRotate: { value: 0.0 },
      uGrayscale: { value: 0.0 },
      uSepia: { value: 0.0 },
      uInvert: { value: 0.0 },
      ...createColorCorrectionUniforms(),
      uBlur: { value: 0.0 },
      uZoomBlur: { value: 0.0 },
      uZoomCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uMoveBlur: { value: new THREE.Vector2(0, 0) },
      uRgbSplit: { value: 0.0 },
      uSplitMove: { value: new THREE.Vector2(0, 0) },
      uTileFade: { value: 0.0 },
      uClipPathInset: { value: 0.0 },
      uLetterSpacing: { value: 0.0 },
      uTintColor: { value: new THREE.Color(0xffffff) },
      uBgColor: { value: new THREE.Vector4(0, 0, 0, 0) },
      uFlashColor: { value: new THREE.Color(0xffffff) },
      uFlashAmount: { value: 0.0 },
      uBloomAmount: { value: 0.0 },
      uBloomThreshold: { value: 0.6 },
      uBloomRadius: { value: 36.0 },
      uResolution: { value: new THREE.Vector2(1280, 720) },
      uCanvasSize: { value: new THREE.Vector2(1280, 720) },
      uStabilizeOn: { value: 0.0 },
      uStabilizeLinear: { value: new THREE.Vector4(1, 0, 0, 1) },
      uStabilizeOffset: { value: new THREE.Vector2(0, 0) },
      uStabilizeSize: { value: new THREE.Vector2(1, 1) },
      uCellCrop: { value: new THREE.Vector2(1, 1) },
      uGridCell: { value: 0.0 },
      uUvOffset: { value: new THREE.Vector2(0, 0) },
      uUvScale: { value: new THREE.Vector2(1, 1) },
      uFisheye: { value: 0.0 },
      uFisheyeFit: { value: 1.0 },
      uFisheyeModel: { value: 0 },
      uFisheyeCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uUvPreOffset: { value: new THREE.Vector2(0, 0) },
      uUvRotate: { value: 0.0 },
      uUvRotateCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uPerspTilt: { value: 0.0 },
      uPerspAxis: { value: new THREE.Vector2(0, 1) },
      uPerspDist: { value: 1.8 },
      uPerspPivot: { value: new THREE.Vector2(0.5, 0.5) },
      uPerspShade: { value: 0.0 },
      uMirrorTile: { value: 0.0 },
      uAlphaExport: { value: alphaExportMode ? 1.0 : 0.0 },
      uInputPremultiplied: { value: 0.0 },
      // WebGPU only: perspective clip planes that sample a compositor RT (particles,
      // 3D models, sequences) need a V flip — same §3.4 defect as the adjustment
      // layer. Canvas/video uploads do not. Set from setupMesh when overrideTexture
      // is bound on the WebGPU backend; always 0 on classic.
      uInputFlipV: { value: 0.0 },
      uPlaneExpand: { value: 0.0 },
      uWipeType: { value: 0 },
      uWipeProgress: { value: 1.0 },
      uCornerRadii: { value: new THREE.Vector4(0, 0, 0, 0) },
      uBorderWidth: { value: 0.0 },
      uBorderStyle: { value: 0 },
      uBorderColor: { value: new THREE.Vector4(1, 1, 1, 1) },
      uShadowCount: { value: 0 },
      uShadowColors: { value: [new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0)] },
      uShadowParams: { value: [new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0)] },
      uShadowInset: { value: [0, 0, 0, 0] },
      uDepthOn: { value: 0.0 },
      uDepthMap: { value: null },
      uDepthShift: { value: new THREE.Vector2(0, 0) },
      uDepthDolly: { value: 0.0 },
      uDepthFocus: { value: 0.45 },
      uDepthCut: { value: 0.0 },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/*
 * TEMPORARY §5 instrument — describe the texture each clip material is actually
 * given, rather than reasoning about what should be bound. Four hypotheses have
 * now died on this one symptom; this reports the thing itself.
 * Remove once the export A/B is green.
 */
function probeClipTexture(mat) {
  const dump = globalThis.__veClipDump;
  if (!Array.isArray(dump) || dump.length > 4000) return;
  const u = mat.uniforms || {};
  const t = u.uTexture?.value;
  const v3 = (x) => (x ? [Math.round(x.r * 100) / 100, Math.round(x.g * 100) / 100,
    Math.round(x.b * 100) / 100, x.w !== undefined ? Math.round(x.w * 100) / 100 : undefined] : null);
  dump.push({
    node: !!mat.isNodeMaterial,
    tex: t ? (t.constructor?.name || 'Texture') : 'NULL',
    // Everything that can turn a plate into an opaque fill, read at the moment
    // the material is reset rather than inferred from the call sites.
    alphaExp: u.uAlphaExport?.value ?? null,
    gridCell: u.uGridCell?.value ?? null,
    opacity: u.uOpacity?.value ?? null,
    bg: v3(u.uBgColor?.value),
    tint: v3(u.uTintColor?.value),
    flash: u.uFlashAmount?.value ?? null,
    bright: u.uBrightness?.value ?? null,
    contrast: u.uContrast?.value ?? null,
    sat: u.uSaturation?.value ?? null,
  });
}

export function resetMaterialUniforms(mat) {
  if (globalThis.__veClipDump) probeClipTexture(mat);
  // Default compositing is straight "over" (NormalBlending). A per-layer blend
  // mode (applyBlendMode) may override this after the uniforms are set, so reset
  // it here every frame — otherwise a layer that once had e.g. Multiply would
  // keep it after the mode is cleared or when the material is reused as a
  // placeholder/thumbnail (paths that return before applyBlendMode runs).
  mat.blending = THREE.NormalBlending;
  const u = mat.uniforms;
  if (u.uAlphaExport) u.uAlphaExport.value = alphaExportMode ? 1.0 : 0.0;
  if (u.uBlendCustom) u.uBlendCustom.value = 0.0;
  u.uOpacity.value = 1.0;
  u.uBrightness.value = 1.0;
  u.uContrast.value = 1.0;
  u.uSaturation.value = 1.0;
  u.uHueRotate.value = 0.0;
  u.uGrayscale.value = 0.0;
  u.uSepia.value = 0.0;
  if (u.uInvert) u.uInvert.value = 0.0;
  // Pooled materials must not carry one layer's grade onto the next.
  if (u.uCcCtl) u.uCcCtl.value.set(0, -1, 0, 0);
  u.uBlur.value = 0.0;
  u.uZoomBlur.value = 0.0;
  if (u.uZoomCenter) u.uZoomCenter.value.set(0.5, 0.5);
  if (u.uMoveBlur) u.uMoveBlur.value.set(0, 0);
  if (u.uRgbSplit) u.uRgbSplit.value = 0.0;
  if (u.uSplitMove) u.uSplitMove.value.set(0, 0);
  if (u.uTileFade) u.uTileFade.value = 0.0;
  u.uClipPathInset.value = 0.0;
  u.uLetterSpacing.value = 0.0;
  u.uTintColor.value.setRGB(1, 1, 1);
  u.uBgColor.value.set(0, 0, 0, 0);
  // Transition-only flash: pooled materials would carry a stale wash onto the
  // next layer without this.
  if (u.uFlashColor) u.uFlashColor.value.setRGB(1, 1, 1);
  if (u.uFlashAmount) u.uFlashAmount.value = 0.0;
  // Transition-only bloom — same pooling hazard as the flash and the lens.
  if (u.uBloomAmount) u.uBloomAmount.value = 0.0;
  if (u.uStabilizeOn) u.uStabilizeOn.value = 0.0;
  if (u.uStabilizeLinear) u.uStabilizeLinear.value.set(1, 0, 0, 1);
  if (u.uStabilizeOffset) u.uStabilizeOffset.value.set(0, 0);
  if (u.uStabilizeSize) u.uStabilizeSize.value.set(1, 1);
  u.uUvOffset.value.set(0, 0);
  u.uUvScale.value.set(1, 1);
  // Transition-only camera warps. Materials are pooled and reused, so a lens or
  // a tremble left set here would ride onto the next ordinary layer drawn with
  // this material — the reset is what scopes them to the transition.
  if (u.uFisheye) u.uFisheye.value = 0.0;
  if (u.uFisheyeFit) u.uFisheyeFit.value = 1.0;
  if (u.uFisheyeModel) u.uFisheyeModel.value = 0;
  if (u.uFisheyeCenter) u.uFisheyeCenter.value.set(0.5, 0.5);
  if (u.uUvPreOffset) u.uUvPreOffset.value.set(0, 0);
  if (u.uUvRotate) u.uUvRotate.value = 0.0;
  if (u.uUvRotateCenter) u.uUvRotateCenter.value.set(0.5, 0.5);
  // The perspective tilt is transition-only — same pooling hazard as the lens.
  if (u.uPerspTilt) u.uPerspTilt.value = 0.0;
  if (u.uPerspAxis) u.uPerspAxis.value.set(0, 1);
  if (u.uPerspDist) u.uPerspDist.value = 1.8;
  if (u.uPerspPivot) u.uPerspPivot.value.set(0.5, 0.5);
  if (u.uPerspShade) u.uPerspShade.value = 0.0;
  u.uMirrorTile.value = 0.0;
  if (u.uCellCrop) u.uCellCrop.value.set(1, 1);
  if (u.uGridCell) u.uGridCell.value = 0.0;
  u.uInputPremultiplied.value = 0.0;
  if (u.uInputFlipV) u.uInputFlipV.value = 0.0;
  u.uPlaneExpand.value = 0.0;
  u.uWipeType.value = 0;
  u.uWipeProgress.value = 1.0;
  u.uCornerRadii.value.set(0, 0, 0, 0);
  u.uBorderWidth.value = 0.0;
  u.uBorderStyle.value = 0;
  u.uBorderColor.value.set(1, 1, 1, 1);
  u.uShadowCount.value = 0;
  for (let i = 0; i < 4; i++) {
    u.uShadowColors.value[i].set(0, 0, 0, 0);
    u.uShadowParams.value[i].set(0, 0, 0, 0);
    u.uShadowInset.value[i] = 0;
  }
  // 3D Depth is off unless this frame's setup re-enables it (materials are
  // reused across clips, so a stale depth plate would leak onto the next layer).
  if (u.uDepthOn) {
    u.uDepthOn.value = 0.0;
    u.uDepthMap.value = null;
    u.uDepthShift.value.set(0, 0);
    u.uDepthDolly.value = 0.0;
  }
}

// Push the per-frame 3D Depth state onto a clip material. `shift` is the camera's
// depth-dependent residual (null = no camera move this frame → exact bypass).
export function applyDepthUniforms(mat, { texture, shift, focusPct }) {
  const u = mat.uniforms;
  if (!u.uDepthOn) return;
  if (!texture || !shift) {
    u.uDepthOn.value = 0.0;
    u.uDepthMap.value = null;
    return;
  }
  u.uDepthOn.value = 1.0;
  u.uDepthMap.value = texture;
  u.uDepthShift.value.set(shift.shiftX, shift.shiftY);
  u.uDepthDolly.value = shift.dolly;
  u.uDepthFocus.value = Math.max(0, Math.min(1, focusPct / 100));
}

export const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double'];
const BORDER_STYLE_INDEX = { solid: 0, dashed: 1, dotted: 2, double: 3 };

// Resolve an item's shadow list: the `shadows` array is authoritative; items
// saved before multi-shadow support carry the legacy single-shadow fields
// (shadowX/Y/Blur/Spread/Color), which map onto one drop shadow.
export function getItemShadows(item) {
  if (Array.isArray(item?.shadows)) return item.shadows;
  const x = Number.isFinite(item?.shadowX) ? item.shadowX : 0;
  const y = Number.isFinite(item?.shadowY) ? item.shadowY : 0;
  const blur = Number.isFinite(item?.shadowBlur) ? item.shadowBlur : 0;
  const spread = Number.isFinite(item?.shadowSpread) ? item.shadowSpread : 0;
  const on = blur > 0.01 || spread > 0.01 || Math.abs(x) > 0.01 || Math.abs(y) > 0.01;
  if (!on) return [];
  return [{ x, y, blur, spread, color: item?.shadowColor || 'rgba(0,0,0,0.65)', inset: false }];
}

// Margin (canvas px) a layer's quad must grow by so its drop shadows can paint
// past the content plate instead of clipping at the layer boundary. 0 when the
// item has no outward-reaching shadow.
export function getFramingExpansion(item) {
  let m = 0;
  for (const s of getItemShadows(item)) {
    if (!s || s.inset) continue;
    const reach = Math.max(Math.abs(s.x || 0), Math.abs(s.y || 0)) + Math.max(0, s.blur || 0) + Math.max(0, s.spread || 0);
    if (reach > m) m = reach;
  }
  return m > 0.01 ? Math.ceil(m + 4) : 0; // +4px anti-aliasing headroom
}

// Resolve an item's corner radii as [TL, TR, BR, BL] honoring the link toggle.
export function getItemCornerRadii(item) {
  const base = Number.isFinite(item?.borderRadius) ? Math.max(0, item.borderRadius) : 0;
  if (item?.borderRadiusLinked !== false) return [base, base, base, base];
  const c = (v) => (Number.isFinite(v) ? Math.max(0, v) : base);
  return [c(item?.borderRadiusTL), c(item?.borderRadiusTR), c(item?.borderRadiusBR), c(item?.borderRadiusBL)];
}

export function applyFilterUniforms(mat, item, keyframeProps, options = {}) {
  const u = mat.uniforms;
  const { reducedMotionPreview = false, disableFraming = false, silhouetteFraming = false, disableLetterSpacing = false } = options;
  const brightness = keyframeProps?.brightness ?? (Number.isFinite(item?.filterBrightness) ? item.filterBrightness : 100);
  const contrast = keyframeProps?.contrast ?? (Number.isFinite(item?.filterContrast) ? item.filterContrast : 100);
  const saturation = keyframeProps?.saturate ?? (Number.isFinite(item?.filterSaturation) ? item.filterSaturation : 100);
  const hueRotate = keyframeProps?.['hue-rotate'] ?? (Number.isFinite(item?.filterHueRotate) ? item.filterHueRotate : 0);
  const grayscale = keyframeProps?.grayscale ?? (Number.isFinite(item?.filterGrayscale) ? item.filterGrayscale : 0);
  const sepia = keyframeProps?.sepia ?? (Number.isFinite(item?.filterSepia) ? item.filterSepia : 0);
  const invert = keyframeProps?.invert ?? (Number.isFinite(item?.filterInvert) ? item.filterInvert : 0);
  const blur = keyframeProps?.blur ?? (Number.isFinite(item?.filterBlur) ? item.filterBlur : 0);
  const effectiveBlur = reducedMotionPreview ? Math.min(blur, 2) : blur;
  const clipPath = keyframeProps?.clipPath ?? 0;
  // Text layers get real letter spacing baked into their canvas texture (Player's
  // text draw re-measures with the keyframed value), so the UV-stretch approximation
  // must stay off for them or the glyphs would also be squeezed horizontally.
  const letterSpacing = disableLetterSpacing ? 0 : (keyframeProps?.letterSpacing ?? 0);

  u.uBrightness.value = brightness / 100;
  u.uContrast.value = contrast / 100;
  u.uSaturation.value = saturation / 100;
  u.uHueRotate.value = hueRotate;
  u.uGrayscale.value = grayscale / 100;
  u.uSepia.value = sepia / 100;
  if (u.uInvert) u.uInvert.value = Math.max(0, Math.min(100, invert)) / 100;
  u.uBlur.value = effectiveBlur;
  u.uClipPathInset.value = Math.max(0, Math.min(45, clipPath));
  u.uLetterSpacing.value = Math.max(-80, Math.min(200, letterSpacing));

  const tintColor = parseCssColor(keyframeProps?.color, { r: 1, g: 1, b: 1, a: 1 });
  const bgColor = parseCssColor(keyframeProps?.backgroundColor, { r: 0, g: 0, b: 0, a: 0 });
  u.uTintColor.value.setRGB(tintColor.r, tintColor.g, tintColor.b);
  u.uBgColor.value.set(bgColor.r, bgColor.g, bgColor.b, bgColor.a);

  let opacity = Number.isFinite(item?.opacity) ? item.opacity / 100 : 1;
  if (Number.isFinite(keyframeProps?.opacity)) opacity *= keyframeProps.opacity;
  // Opacity scales COVERAGE, so it stops at 1 — the same clamp the adjustment
  // material below applies. Unclamped, an opacity track above 1 (the track takes
  // 0–2, and an API-written track holding 100 meant "100 %") multiplies every
  // soft alpha by that factor: a VP9-alpha cut-out's feathered glow went fully
  // opaque out to its blocky near-zero tail, a hard stair-stepped halo in the
  // preview and the render alike (V2.8 clover bulb, 2026-10-21).
  u.uOpacity.value = Math.max(0, Math.min(1, opacity));

  // `cc:` tracks (any number of the correction can be keyframed) merge over the
  // static object for this frame; with none, the object passes through unchanged.
  applyColorCorrectionUniforms(mat, applyCcKeyframes(item?.colorCorrection, keyframeProps), options);

  // Card framing: rounded corners / border / shadows (canvas px). Shape layers
  // opt out — they draw framing along their own outline on the canvas texture.
  if (disableFraming) {
    u.uCornerRadii.value.set(0, 0, 0, 0);
    u.uBorderWidth.value = 0;
    u.uBorderStyle.value = 0;
    u.uShadowCount.value = 0;
    u.uPlaneExpand.value = 0;
    return;
  }
  const radii = getItemCornerRadii(item);
  u.uCornerRadii.value.set(radii[0], radii[1], radii[2], radii[3]);
  // A keyed layer draws its border and shadows along the keyed silhouette in a
  // pass after the key (silhouetteFraming.js), so the box ring and box shadows
  // stay off here. The corner radius above is kept: it clips the plate.
  if (silhouetteFraming) {
    u.uBorderWidth.value = 0;
    u.uBorderStyle.value = 0;
    u.uShadowCount.value = 0;
    u.uPlaneExpand.value = 0;
    return;
  }
  // Quad expansion for outward shadows (the mesh scale is grown to match in
  // the Player's setupMesh — the shader remaps UVs so content stays put).
  u.uPlaneExpand.value = getFramingExpansion(item);
  // borderWidth / borderColor keyframe tracks override the static fields (borderKeyframes.js).
  const bItem = withBorderKeyframes(item, keyframeProps);
  const borderStyle = bItem?.borderStyle;
  const borderWidth = borderStyle === 'none' ? 0 : (Number.isFinite(bItem?.borderWidth) ? bItem.borderWidth : 0);
  u.uBorderWidth.value = Math.max(0, borderWidth);
  u.uBorderStyle.value = BORDER_STYLE_INDEX[borderStyle] ?? 0;
  if (borderWidth > 0) {
    const bc = parseCssColor(bItem?.borderColor, { r: 1, g: 1, b: 1, a: 1 });
    u.uBorderColor.value.set(bc.r, bc.g, bc.b, bc.a);
  }
  // Shadows: skip zero-effect entries (a shadow with no offset/blur/spread sits
  // exactly under the content and would only leave a faint SDF rim).
  const shadows = getItemShadows(item).filter((s) => {
    const blur = Number.isFinite(s?.blur) ? s.blur : 0;
    const spread = Number.isFinite(s?.spread) ? s.spread : 0;
    const x = Number.isFinite(s?.x) ? s.x : 0;
    const y = Number.isFinite(s?.y) ? s.y : 0;
    return blur > 0.01 || Math.abs(spread) > 0.01 || Math.abs(x) > 0.01 || Math.abs(y) > 0.01;
  }).slice(0, 4);
  u.uShadowCount.value = shadows.length;
  for (let i = 0; i < 4; i++) {
    const s = shadows[i];
    if (!s) {
      u.uShadowColors.value[i].set(0, 0, 0, 0);
      u.uShadowParams.value[i].set(0, 0, 0, 0);
      u.uShadowInset.value[i] = 0;
      continue;
    }
    const sc = parseCssColor(s.color, { r: 0, g: 0, b: 0, a: 0.65 });
    u.uShadowColors.value[i].set(sc.r, sc.g, sc.b, sc.a);
    u.uShadowParams.value[i].set(
      Number.isFinite(s.x) ? s.x : 0,
      Number.isFinite(s.y) ? s.y : 0,
      Math.max(0, Number.isFinite(s.blur) ? s.blur : 0),
      Number.isFinite(s.spread) ? s.spread : 0
    );
    u.uShadowInset.value[i] = s.inset ? 1 : 0;
  }
}

// Color Correction. Values are derived once per stored object (items are
// immutable, so identity is the cache key) — a layer without a correction, or
// with every section at defaults, writes ONE uniform and the shader skips the
// block. `ccSplit` (frame x 0..1, preview Before/After only) and `ccStage`
// ('src' = bypass, 'pre' = stop at the input to Levels, for the pickers' probe)
// come from the Player; export never passes either.
const ccValueCache = new WeakMap();
const ccPreCache = new WeakMap();
function ccValuesFor(cc, stage) {
  if (stage === 'pre') {
    let v = ccPreCache.get(cc);
    if (!v) { v = ccUniformValues({ ...cc, enabled: true, mix: 100 }); ccPreCache.set(cc, v); }
    return v;
  }
  let v = ccValueCache.get(cc);
  if (!v) { v = ccUniformValues(cc); ccValueCache.set(cc, v); }
  return v;
}
export function applyColorCorrectionUniforms(mat, cc, { ccSplit = -1, ccStage = null } = {}) {
  const u = mat.uniforms;
  if (!u.uCcCtl) return;
  if (!cc || typeof cc !== 'object' || ccStage === 'src') { u.uCcCtl.value.set(0, -1, 0, 0); return; }
  const v = ccValuesFor(cc, ccStage);
  if (!v.live) { u.uCcCtl.value.set(0, -1, 0, 0); return; }
  const pre = ccStage === 'pre';
  u.uCcCtl.value.set(1, Number.isFinite(ccSplit) && ccSplit >= 0 && !pre ? ccSplit : -1, pre ? 1 : v.mix, pre ? 1 : 0);
  u.uCcGain.value.set(v.wb[0] * v.expo, v.wb[1] * v.expo, v.wb[2] * v.expo);
  u.uCcTone.value.set(v.tone[0], v.tone[1], v.tone[2], v.tone[3]);
  u.uCcTone2.value.set(v.blacks, v.toneOn ? 1 : 0, v.colOn ? v.sat : 1, v.colOn ? v.vib : 0);
  u.uCcFlags.value.set(v.lvOn ? 1 : 0, v.colOn ? 1 : 0, v.whOn ? 1 : 0, v.hslOn ? 1 : 0);
  u.uCcLvInB.value.fromArray(v.lvInB);
  u.uCcLvInW.value.fromArray(v.lvInW);
  u.uCcLvGam.value.fromArray(v.lvGam);
  u.uCcLvOutB.value.fromArray(v.lvOutB);
  u.uCcLvOutW.value.fromArray(v.lvOutW);
  u.uCcWhS.value.fromArray(v.whS);
  u.uCcWhM.value.fromArray(v.whM);
  u.uCcWhH.value.fromArray(v.whH);
  u.uCcHslH0.value.set(v.hslH[0], v.hslH[1], v.hslH[2], v.hslH[3]);
  u.uCcHslH1.value.set(v.hslH[4], v.hslH[5], v.hslH[6], v.hslH[7]);
  u.uCcHslS0.value.set(v.hslS[0], v.hslS[1], v.hslS[2], v.hslS[3]);
  u.uCcHslS1.value.set(v.hslS[4], v.hslS[5], v.hslS[6], v.hslS[7]);
  u.uCcHslL0.value.set(v.hslL[0], v.hslL[1], v.hslL[2], v.hslL[3]);
  u.uCcHslL1.value.set(v.hslL[4], v.hslL[5], v.hslL[6], v.hslL[7]);
}

// Blend modes. The catalogue lives in blendModes.js: the six HARDWARE modes
// below map onto GPU blending (THREE.CustomBlending) and compose a layer against
// whatever is already drawn below it with no extra pass — identical in the live
// preview and the headless export. Every other Photoshop mode (overlay, soft
// light, hue…) must READ the destination, so the compositor routes such a layer
// through its isolate branch and the blendComposite pass; on the clip material
// itself those modes are plain Normal (see applyBlendMode).
export { BLEND_MODES, BLEND_MODE_GROUPS, BLEND_MODE_INDEX, HW_BLEND_MODES, isShaderBlendMode, normalizeBlendMode } from './blendModes.js';

// Each mode's NEUTRAL colour — the source value that leaves the destination
// exactly as it was. Both blend paths fade the source toward it by the source's
// own alpha (coverage × layer opacity) BEFORE the hardware blend, which is what
// makes opacity work: hardware blending can't apply it for us here, because
// Min/Max ignore the blend factors outright and screen's OneMinusSrcColor factor
// never looks at alpha. Fading to the identity instead means alpha 0 → untouched
// destination, alpha 1 → the exact mode, and multiply/screen/add come out exact
// at every value in between (lighten/darken are monotonic approximations, which
// is the best a Min/Max equation can do without a destination read).
const BLEND_IDENTITY = { multiply: 1, darken: 1 }; // everything else = 0 (black)

// The hardware factors, written for a source already faded toward the identity.
// That fade also removes the two forms' only difference (a premultiplied source
// is the identity-0 fade), so straight-alpha and premultiplied clips now share
// one table. Alpha always composites with standard "over" so layer coverage
// still accumulates normally.
function setBlendFactors(mat, mode) {
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendEquationAlpha = THREE.AddEquation;
  mat.blendSrcAlpha = THREE.OneFactor;
  mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  switch (mode) {
    case 'multiply': // out = dst·src — src is white where the layer is absent
      mat.blendSrc = THREE.DstColorFactor;
      mat.blendDst = THREE.ZeroFactor;
      break;
    case 'screen': // out = src + dst − src·dst
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneMinusSrcColorFactor;
      break;
    case 'add': // out = src + dst (linear dodge)
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneFactor;
      break;
    case 'lighten': // out = max(src, dst) — factors are IGNORED by MaxEquation
      mat.blendEquation = THREE.MaxEquation;
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneFactor;
      break;
    case 'darken': // out = min(src, dst) — src is white where the layer is absent
      mat.blendEquation = THREE.MinEquation;
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneFactor;
      break;
    default: // 'normal' — premultiplied over
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneMinusSrcAlphaFactor;
      break;
  }
}

// Configure a clip material's GPU blend state for the given mode, and hand its
// shader the identity it has to fade toward (see uBlendCustom in the fragment
// shader — the clip shader emits STRAIGHT alpha, so it does the fade itself).
export function applyBlendMode(mat, blendMode) {
  const mode = normalizeBlendMode(blendMode);
  // Remembered so the compositor can suspend the hardware blend while it draws
  // the layer ALONE into a plate (suspendBlendMode / resumeBlendMode below).
  mat.userData.blendMode = mode;
  setMaterialBlend(mat, mode);
}

// The actual GPU state for `mode`. A SHADER mode is Normal here on purpose:
// the layer never meets the stack through this material — the blendComposite
// pass does the blend from the layer's isolate plate.
function setMaterialBlend(mat, mode) {
  const u = mat.uniforms;
  if (mode === 'normal' || isShaderBlendMode(mode)) {
    mat.blending = THREE.NormalBlending;
    if (u?.uBlendCustom) u.uBlendCustom.value = 0.0;
    return;
  }
  setBlendFactors(mat, mode);
  if (u?.uBlendCustom) {
    u.uBlendCustom.value = 1.0;
    const k = BLEND_IDENTITY[mode] || 0;
    u.uBlendIdentity.value.setScalar(k);
  }
}

// Draw the layer ALONE: a hardware mode rendered into a freshly cleared plate
// blends against transparent black — multiply/darken paint the layer's own
// footprint solid BLACK (the long-standing "multiply + layer effect" defect).
// The compositor suspends the mode for every isolate render and applies it
// itself when the plate meets the stack (overBlit / blendComposite), then
// resumes so the fast direct draw keeps its hardware blend.
export function suspendBlendMode(mat) {
  if (!mat || !mat.userData || mat.blending === THREE.NormalBlending) return;
  setMaterialBlend(mat, 'normal');
}
export function resumeBlendMode(mat) {
  if (!mat || !mat.userData) return;
  const mode = mat.userData.blendMode || 'normal';
  if (mode !== 'normal') setMaterialBlend(mat, mode);
}

// Same modes, for a PREMULTIPLIED source — i.e. a layer that was rendered alone into
// a render target (camera DOF, Running Glow, Layer Effects) and is being composited
// back over the accumulated stack by the over-blit quad. Its RGB is already scaled by
// its own coverage — which IS the identity-0 fade — so the blit shader only has to
// add back `identity · (1 − alpha)` for the white-identity modes, and the factor
// table above then applies unchanged. Using applyBlendMode()'s straight-alpha
// handling here would fade already-faded pixels twice. A SHADER mode is Normal
// here too — the caller routes those through the blendComposite pass instead.
export function applyPremultipliedBlendMode(mat, blendMode) {
  const mode = normalizeBlendMode(blendMode);
  setBlendFactors(mat, isShaderBlendMode(mode) ? 'normal' : mode);
  const u = mat.uniforms;
  if (u?.uBlendIdentity) u.uBlendIdentity.value.setScalar(BLEND_IDENTITY[mode] || 0);
}

// Plain pass-through used to copy/blit a render target onto another target or the canvas.
const blitFragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTexture;
void main() {
  gl_FragColor = texture2D(uTexture, vUv);
}
`;

export function createBlitMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: blitFragmentShader,
    uniforms: { uTexture: { value: null } },
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

// Picture plate copy (Copy Color Profile's off-screen reference): an UPLOADED
// image texture cover-fitted onto a frame-sized plate. uUvScale/uUvOffset pick
// the centred sub-rect of the picture that fills the plate without stretching.
// WebGL samples the picture plain; the WebGPU twin (createPictureCopyNodeMaterial)
// reads it flipped so the plate lands on the same V axis as every other chain
// plate — an uploaded texture through the plain blit came out mirrored there.
const pictureCopyFragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uUvScale;
uniform vec2 uUvOffset;
void main() {
  gl_FragColor = texture2D(uTexture, vUv * uUvScale + uUvOffset);
}
`;

export function createPictureCopyMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: pictureCopyFragmentShader,
    uniforms: {
      uTexture: { value: null },
      uUvScale: { value: new THREE.Vector2(1, 1) },
      uUvOffset: { value: new THREE.Vector2(0, 0) },
    },
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

// The over-blit's own pass-through. Its source RGB is premultiplied — already the
// fade-toward-black that the identity-0 blend modes want — so all this adds is the
// missing half for the white-identity modes (multiply / darken): where the layer is
// absent the source has to read WHITE, or those modes would blacken the frame
// outside the layer instead of leaving it alone. uBlendIdentity 0 makes it a
// byte-for-byte no-op, which is the 'normal' case.
const overBlitFragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform vec3 uBlendIdentity;
void main() {
  vec4 src = texture2D(uTexture, vUv);
  gl_FragColor = vec4(src.rgb + uBlendIdentity * (1.0 - src.a), src.a);
}
`;

// Same blit, but composited OVER whatever is already in the target instead of
// replacing it. The source is a render target written by alpha-blended passes, so
// its RGB is already multiplied by its own coverage — hence One (not SrcAlpha) for
// the source factor; using SrcAlpha would darken every antialiased edge twice.
// Used to flatten the mask/adjustment composite onto an opaque backdrop so an
// exported frame carries no partial alpha (see the flatten step in Player.jsx).
export function createOverBlitMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: overBlitFragmentShader,
    uniforms: { uTexture: { value: null }, uBlendIdentity: { value: new THREE.Vector3(0, 0, 0) } },
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    depthTest: false,
    depthWrite: false,
  });
}

// ── Adjustment layer material ──────────────────────────────────────────────
// Renders the already-composited "layers below" texture re-graded. The plane's
// own transform (zoom/pan/rotate via the perspective camera) IS the geometry, so
// the grade is applied to the actual below pixels — it does NOT overlay a copy.
// Opacity blends the grade strength in RGB (not alpha); alpha stays = the below's
// coverage so the covered area fully REPLACES the layers below (no ghosting), and
// any area the transformed plane doesn't cover falls back to the untouched below.
const adjustmentFragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform float uOpacity;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uHueRotate;
uniform float uGrayscale;
uniform float uSepia;
uniform float uInvert;
uniform float uBlur;
uniform vec3 uTintColor;

vec3 applyHueRotation(vec3 color, float angle) {
  float rad = angle * 3.14159265 / 180.0;
  float cosA = cos(rad);
  float sinA = sin(rad);
  mat3 m = mat3(
    0.213 + cosA * 0.787 - sinA * 0.213,
    0.213 - cosA * 0.213 + sinA * 0.143,
    0.213 - cosA * 0.213 - sinA * 0.787,
    0.715 - cosA * 0.715 - sinA * 0.715,
    0.715 + cosA * 0.285 + sinA * 0.140,
    0.715 - cosA * 0.715 + sinA * 0.715,
    0.072 - cosA * 0.072 + sinA * 0.928,
    0.072 - cosA * 0.072 - sinA * 0.283,
    0.072 + cosA * 0.928 + sinA * 0.072
  );
  return clamp(m * color, 0.0, 1.0);
}

// Layer blur = a real 2D Gaussian with CSS semantics (blur(r): σ = r px — the same number blurs the
// same amount here, in an HTML page and in the UI kit lab). 48 taps on a golden-angle spiral out to
// 2.5σ, Gaussian-weighted; the spiral turns per pixel so what little structure is left becomes fine
// grain. The old kernel sampled only a + cross, a whole blur radius apart, so a big blur showed as
// offset copies of the layer. Zero blur is one tap (the common case costs nothing).
vec4 sampleBlurred(vec2 uv) {
  if (uBlur <= 0.0) return texture2D(uTexture, uv);
  float sigma = uBlur;
  float reach = 2.5 * sigma;
  float spin = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec4 sum = texture2D(uTexture, uv);
  float wsum = 1.0;
  for (int i = 0; i < 48; i++) {
    float fi = float(i) + 0.5;
    float r = reach * sqrt(fi / 48.0);
    float a = fi * 2.39996323 + spin;
    float w = exp(-(r * r) / (2.0 * sigma * sigma));
    sum += texture2D(uTexture, uv + vec2(cos(a), sin(a)) * r / uResolution) * w;
    wsum += w;
  }
  return sum / wsum;
}

void main() {
  vec4 raw = sampleBlurred(vUv);
  // The stack below is PREMULTIPLIED, and this material's blending multiplies by
  // alpha again on write. Grade the straight colour, or every semi-transparent
  // pixel (a sequence's inner stack, a transparent render) darkens by its own
  // alpha. Opaque pixels divide by 1 — unchanged.
  vec3 c = raw.rgb / max(raw.a, 0.0001);
  c *= uBrightness;
  c = (c - 0.5) * uContrast + 0.5;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(lum), c, uSaturation);
  if (abs(uHueRotate) > 0.5) c = applyHueRotation(c, uHueRotate);
  if (uGrayscale > 0.0) { float g = dot(c, vec3(0.2126, 0.7152, 0.0722)); c = mix(c, vec3(g), uGrayscale); }
  if (uSepia > 0.0) {
    vec3 s = vec3(
      dot(c, vec3(0.393, 0.769, 0.189)),
      dot(c, vec3(0.349, 0.686, 0.168)),
      dot(c, vec3(0.272, 0.534, 0.131))
    );
    c = mix(c, s, uSepia);
  }
  if (uInvert > 0.0) c = mix(c, 1.0 - c, uInvert);
  c *= uTintColor;
  c = clamp(c, 0.0, 1.0);
  // Real layer opacity: the graded result's alpha = coverage * opacity, so at 50%
  // the whole adjusted frame is 50% transparent over the canvas (no blend with the
  // original below, no duplicate).
  gl_FragColor = vec4(c, raw.a * uOpacity);
}
`;

export function createAdjustmentMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: adjustmentFragmentShader,
    uniforms: {
      uTexture: { value: null },
      uResolution: { value: new THREE.Vector2(1280, 720) },
      uOpacity: { value: 1.0 },
      uBrightness: { value: 1.0 },
      uContrast: { value: 1.0 },
      uSaturation: { value: 1.0 },
      uHueRotate: { value: 0.0 },
      uGrayscale: { value: 0.0 },
      uSepia: { value: 0.0 },
      uInvert: { value: 0.0 },
      uBlur: { value: 0.0 },
      uTintColor: { value: new THREE.Color(0xffffff) },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// Map a timeline item's filter props (+ interpolated keyframes) onto the adjustment
// material: the colour grade and the layer opacity (applied as the result's alpha).
// Geometry (zoom/pan/rotate) comes from the mesh transform.
export function applyAdjustmentUniforms(mat, item, keyframeProps, rttW, rttH, options = {}) {
  const u = mat.uniforms;
  const { reducedMotionPreview = false } = options;
  const brightness = keyframeProps?.brightness ?? (Number.isFinite(item?.filterBrightness) ? item.filterBrightness : 100);
  const contrast = keyframeProps?.contrast ?? (Number.isFinite(item?.filterContrast) ? item.filterContrast : 100);
  const saturation = keyframeProps?.saturate ?? (Number.isFinite(item?.filterSaturation) ? item.filterSaturation : 100);
  const hueRotate = keyframeProps?.['hue-rotate'] ?? (Number.isFinite(item?.filterHueRotate) ? item.filterHueRotate : 0);
  const grayscale = keyframeProps?.grayscale ?? (Number.isFinite(item?.filterGrayscale) ? item.filterGrayscale : 0);
  const sepia = keyframeProps?.sepia ?? (Number.isFinite(item?.filterSepia) ? item.filterSepia : 0);
  const invert = keyframeProps?.invert ?? (Number.isFinite(item?.filterInvert) ? item.filterInvert : 0);
  const blur = keyframeProps?.blur ?? (Number.isFinite(item?.filterBlur) ? item.filterBlur : 0);
  const effectiveBlur = reducedMotionPreview ? Math.min(blur, 2) : blur;
  u.uBrightness.value = brightness / 100;
  u.uContrast.value = contrast / 100;
  u.uSaturation.value = saturation / 100;
  u.uHueRotate.value = hueRotate;
  u.uGrayscale.value = grayscale / 100;
  u.uSepia.value = sepia / 100;
  if (u.uInvert) u.uInvert.value = Math.max(0, Math.min(100, invert)) / 100;
  u.uBlur.value = effectiveBlur;
  u.uResolution.value.set(rttW || 1280, rttH || 720);
  const tintColor = parseCssColor(keyframeProps?.color, { r: 1, g: 1, b: 1, a: 1 });
  u.uTintColor.value.setRGB(tintColor.r, tintColor.g, tintColor.b);
  let opacity = Number.isFinite(item?.opacity) ? item.opacity / 100 : 1;
  if (Number.isFinite(keyframeProps?.opacity)) opacity *= keyframeProps.opacity;
  u.uOpacity.value = Math.max(0, Math.min(1, opacity));
}

// Clip-mask pass: keeps the accumulated below-composite only where the mask
// texture (a shape or text layer rendered offscreen) has coverage. RGB is
// multiplied by the same coverage as alpha so transparent antialiased edge texels
// cannot leak their hidden colour into later post-processing/export passes. Used by
// shapes with `shapeClipMask` and text with `textClipMask` ("Use as clipping mask
// for layers below"). `uInvert` flips the matte for a knockout/stencil look.
const maskCompositeFragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTexture; // accumulated layers below
uniform sampler2D uMask;    // mask layer coverage
uniform float uInvert;      // 1.0 = show OUTSIDE the mask instead of inside
void main() {
  vec4 below = texture2D(uTexture, vUv);
  float m = texture2D(uMask, vUv).a;
  m = mix(m, 1.0 - m, uInvert);
  gl_FragColor = vec4(below.rgb * m, below.a * m);
}
`;

export function createMaskCompositeMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: maskCompositeFragmentShader,
    uniforms: { uTexture: { value: null }, uMask: { value: null }, uInvert: { value: 0 } },
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

// Track-matte pass: multiplies ONE layer's finished isolate by another layer's
// coverage (AE's Track Matte). Differs from the clip-mask pass above in scope
// (one consumer layer, not the whole below-stack) and in supporting luma modes.
// Both textures are premultiplied; luma on premultiplied RGB equals
// straight-luma × alpha, which is exactly AE's behaviour — fully transparent
// matte texels contribute nothing regardless of their hidden colour.
// Proven in html/track-matte-lab.html before this shipped.
const trackMatteFragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTexture; // consumer layer isolate (premultiplied)
uniform sampler2D uMatte;   // matte source isolate (premultiplied)
uniform float uLuma;        // 0 = alpha matte, 1 = luma matte
uniform float uInvert;      // 1 = inverted matte
void main() {
  vec4 c = texture2D(uTexture, vUv);
  vec4 s = texture2D(uMatte, vUv);
  float m = mix(s.a, dot(s.rgb, vec3(0.299, 0.587, 0.114)), uLuma);
  m = mix(m, 1.0 - m, uInvert);
  gl_FragColor = c * m; // premultiplied: scale rgb AND alpha together
}
`;

export function createTrackMatteMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: trackMatteFragmentShader,
    uniforms: {
      uTexture: { value: null },
      uMatte: { value: null },
      uLuma: { value: 0 },
      uInvert: { value: 0 },
    },
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

// Blends two render targets: result = mix(uTexA, uTexB, uMix). Kept for reuse.
const mixFragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform float uMix;
void main() {
  gl_FragColor = mix(texture2D(uTexA, vUv), texture2D(uTexB, vUv), uMix);
}
`;

export function createMixMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: mixFragmentShader,
    uniforms: {
      uTexA: { value: null },
      uTexB: { value: null },
      uMix: { value: 1.0 },
    },
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

export function parseCssColor(value, fallback = { r: 1, g: 1, b: 1, a: 1 }) {
  if (typeof value !== 'string') return fallback;
  const str = value.trim();
  if (!str) return fallback;

  const hex = str.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const r = parseInt(h[0] + h[0], 16) / 255;
      const g = parseInt(h[1] + h[1], 16) / 255;
      const b = parseInt(h[2] + h[2], 16) / 255;
      const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16) / 255;
      const g = parseInt(h.slice(2, 4), 16) / 255;
      const b = parseInt(h.slice(4, 6), 16) / 255;
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
  }

  const rgba = str.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(',').map((s) => s.trim());
    if (parts.length === 3 || parts.length === 4) {
      const r = clamp01((Number.parseFloat(parts[0]) || 0) / 255);
      const g = clamp01((Number.parseFloat(parts[1]) || 0) / 255);
      const b = clamp01((Number.parseFloat(parts[2]) || 0) / 255);
      const a = parts.length === 4 ? clamp01(Number.parseFloat(parts[3])) : 1;
      return { r, g, b, a };
    }
  }

  try {
    const color = new THREE.Color(str);
    return { r: color.r, g: color.g, b: color.b, a: 1 };
  } catch {
    return fallback;
  }
}


/*
 * Depth stamp.
 *
 * Copies a model pass's depth into whatever depth buffer is currently bound, writing
 * gl_FragDepth directly and touching no colour. That is what lets a 2D layer be
 * occluded by a model's real SURFACE rather than by its flat silhouette — a card can
 * pass through a phone and be cut by it per pixel.
 *
 * Both sides must share one projection for this to mean anything: the model pass is
 * given the compositor's near/far, so the values copied here are already in the right
 * encoding and need no linearisation.
 */
export function createDepthStampMaterial() {
  return new THREE.ShaderMaterial({
    // GLSL ES 3.00 is REQUIRED here: gl_FragDepth does not exist in ES 1.00, which is
    // what three compiles a ShaderMaterial as by default even on a WebGL2 context, and
    // the EXT_frag_depth fallback is not exposed on WebGL2. Written as ES 1.00 this
    // silently fails to link and every draw raises GL_INVALID_OPERATION.
    glslVersion: THREE.GLSL3,
    uniforms: { uDepth: { value: null }, uResolution: { value: new THREE.Vector2(1, 1) } },
    vertexShader: `
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`,
    fragmentShader: `
precision highp float;
uniform sampler2D uDepth;
uniform vec2 uResolution;
out vec4 fragColor;
void main() {
  float d = texture(uDepth, gl_FragCoord.xy / uResolution).r;
  // 1.0 is the cleared far plane: nothing was drawn there, so leave the buffer alone
  // rather than stamping the far plane over whatever else is in it.
  if (d >= 0.999999) discard;
  gl_FragDepth = d;
  fragColor = vec4(0.0);
}
`,
    // Depth only. The test is ON so a model cannot stamp itself over something already
    // nearer; the write is what later layers are then cut against.
    colorWrite: false,
    depthTest: true,
    depthWrite: true,
    transparent: false,
  });
}

/*
 * Colour + real depth for a camera-baked 3D pass.
 *
 * A model/plate reaches the timeline compositor as a full-frame colour texture; its
 * proxy quad is only a carrier and has no useful Z of its own. Stamping depth after
 * drawing colour lets the whole proxy overwrite an earlier 3D layer before the
 * depth test ever runs. This pass writes the source fragment's sampled depth at the
 * SAME time as its premultiplied colour, so two crossing model/plate surfaces are
 * resolved per pixel rather than by channel centre/order.
 */
export function createDepthCompositeMaterial() {
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uColor: { value: null },
      uDepth: { value: null },
      // Depth for the pixels the source left at the cleared far plane. A model or a
      // filmed plate has nothing there and discards (-1); an ordinary layer's glow,
      // shadow and blur spill DO belong to the frame, and belong at the depth of the
      // plane they spilled from — anything else makes an effect change what occludes
      // what.
      uFallback: { value: -1 },
      // One depth texel, for the silhouette-edge probe below.
      uDepthTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      // A 3D pass's opaque + transparent depth (model3dLayer renderTransparentDepth).
      // uPass 0: every pixel, as always. 1: all but the cards (a transparent surface
      // with no opaque surface of the pass behind it). 2: only those, at their own
      // depth — written only while the stack under the 3D layers is still transparent
      // (see compositeWithDepth and cardsWriteDepth).
      uTDepth: { value: null },
      uPass: { value: 0 },
      // Blend-mode identity for the premultiplied source — see overBlitFragmentShader.
      uBlendIdentity: { value: new THREE.Vector3(0, 0, 0) },
    },
    vertexShader: `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
    fragmentShader: `
precision highp float;
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform float uFallback;
uniform vec2 uDepthTexel;
uniform sampler2D uTDepth;
uniform float uPass;
uniform vec3 uBlendIdentity;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 color = texture(uColor, vUv);
  // Transparent pixels must never become an invisible depth wall.
  if (color.a < 0.02) discard;
  float depth = texture(uDepth, vUv).r;
  if (uPass > 0.5) {
    // A CARD: a transparent surface where the pass has no opaque surface of its own
    // (a soft contact shadow on the page, a glass pane over nothing). It composites at
    // its own depth, in pass 2. A transparent surface over the pass's own opaque one
    // (stacked image planes, a tint over a wall) is NOT a card: the model pass already
    // blended it over that surface, and the pixel stands at the opaque depth like any
    // other — as a card it lost that depth, and a layer composited after it (a page
    // behind) painted over the whole stack.
    float tdepth = texture(uTDepth, vUv).r;
    bool card = tdepth < 0.999999 && depth >= 0.999999;
    if (uPass < 1.5 && card) discard;
    if (uPass > 1.5) {
      if (!card) discard;
      // Nudged ~0.2 % of its distance toward the camera, as a decal is: a card lies
      // ON a surface (a contact shadow on the page) and coplanar it would z-fight.
      gl_FragDepth = tdepth - (1.0 - tdepth) * 0.002;
      fragColor = vec4(color.rgb + uBlendIdentity * (1.0 - color.a), color.a);
      return;
    }
  }
  if (depth >= 0.999999) {
    if (uFallback < 0.0) discard;
    // A pixel that keeps colour where the pass wrote no depth is either spill (a
    // glow, a defocus blur: the fallback) or an antialiased silhouette edge the
    // depth resolve missed — that one stands with the surface beside it, or a sharp
    // edge drawn at the fallback would show through whatever is in front of it.
    float edge = min(
      min(texture(uDepth, vUv + vec2(uDepthTexel.x, 0.0)).r, texture(uDepth, vUv - vec2(uDepthTexel.x, 0.0)).r),
      min(texture(uDepth, vUv + vec2(0.0, uDepthTexel.y)).r, texture(uDepth, vUv - vec2(0.0, uDepthTexel.y)).r));
    depth = edge < 0.999999 ? edge : uFallback;
  }
  gl_FragDepth = depth;
  fragColor = vec4(color.rgb + uBlendIdentity * (1.0 - color.a), color.a);
}
`,
    transparent: true,
    depthTest: true,
    depthWrite: true,
  });
  // The isolated source texture is premultiplied by its coverage.
  applyPremultipliedBlendMode(material, 'normal');
  return material;
}
