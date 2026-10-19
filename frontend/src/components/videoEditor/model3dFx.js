/*
 * REAL-3D EFFECTS ON A MODEL LAYER — run INSIDE the model's own 3D pass.
 *
 * A model layer reaches the compositor as a finished picture, so any Overlay
 * Effect run on that picture treats it as flat: a pattern swims across the body
 * as it turns, a glow traces the outline the camera happens to see. The effects
 * here run where the 3D is still known — between the model's HDR render and its
 * tone pass (model3dLayer.renderModelLayer) — and read three surface buffers:
 *
 *   gN  view-space NORMAL (+ coverage in alpha)    — which way the surface faces
 *   gP  MODEL-space POSITION (normalised to the     — where on the body a pixel is,
 *       asset's bounding box, + coverage)              so patterns stick to the
 *                                                      surface as it moves
 *   the HDR pass's own DEPTH texture                — how far away it is
 *
 * Each buffer is drawn only when an active effect asks for it, with the scene's
 * overrideMaterial — NO material of the model is ever cloned or spliced. That is
 * deliberate: Grow Fill, device screens and ground AO already swap or splice the
 * model's materials, and three features fighting over one mesh's material is the
 * failure the Grow Fill notes warn about. A buffer pass sidesteps all of it.
 *
 * COSTS NOTHING UNUSED. This module is imported lazily by model3dLayer.js the
 * first time a layer carries a live 3D effect, and its WebGPU twin
 * (model3dFxNodes.js) through materialFactory.loadModelFxNodes() on that backend
 * only. A layer without one never reaches runModelFx, and a layer that loses its
 * last one releases every target here (releaseModelFx).
 *
 * ORIENTATION. Every target is rendered by the same camera as the HDR pass, and
 * every full-screen pass reads its inputs at the fragment's own frame position
 * (gl_FragCoord here, screenUV in the TSL twin — the tone pass's convention,
 * model3dNodes.js), so the chain is an identity on both backends and the tone
 * pass sees an upright picture exactly as it does without effects.
 */
import * as THREE from 'three';
import { selectedBackend } from './videoRenderer';
import { loadModelFxNodes } from './materialFactory';
import { notifyModelAssetLoaded } from './model3dEvents';
import { fxBoxHomographies } from './homography';
import { getRampTexture, sanitizeEffectGradient, getCurvesTexture } from './adjustmentEffects';
import { getAsciiAtlas } from './asciiEffect';
import { linesDrawRunnerState } from './linesDrawProfiles';
import { SHAPE_RULERS_GLSL } from './shapeRulersGlsl';
import { DISPLAY_TRANSFORM_GLSL } from './threeDisplayTransform';

const usesNodes = () => selectedBackend() === 'webgpu';

// ── WebGPU twin, loaded on first use ────────────────────────────────────────
let fxNodes = null;
let fxNodesPromise = null;
/** True when the pass materials for the active backend are available. */
export function modelFxReady() {
  if (!usesNodes()) return true;
  if (fxNodes) return true;
  if (!fxNodesPromise) {
    fxNodesPromise = loadModelFxNodes()
      .then((m) => { fxNodes = m; notifyModelAssetLoaded(); })
      .catch(() => { fxNodesPromise = null; });
  }
  return false;
}
/** For the export settle loop: a twin that has started loading but not landed. */
export function modelFxPending() {
  return usesNodes() && !!fxNodesPromise && !fxNodes;
}

// ── GLSL ─────────────────────────────────────────────────────────────────────
// Full-screen passes draw a 2×2 plane with an identity position; the frame uv is
// gl_FragCoord / uRes so a read lands on the pixel the write lands on.
const VERT = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// View ray through a frame uv: the far-plane point of the inverse projection.
// Exact for a perspective camera and needs no depth.
const RAY = /* glsl */ `
vec3 fxViewRay(vec2 uv, mat4 invProj) {
  vec4 r = invProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  return normalize(r.xyz / r.w);
}`;

/*
 * SURFACE CELLS — a grid LOCKED TO THE MODEL (Pixelate, Pixel Matrix). The cell
 * lattice lives in model space on the dominant plane of the surface normal
 * (triplanar, hard-switched), so it rides the body as it turns instead of
 * swimming across it. Each cell's colour is the lit picture at the cell's own
 * centre, projected back to the frame — a flat block that still carries the
 * real light. uMode 1 is the screen grid (the flat effect's "Frame" grid).
 */
const SURFACE_CELL = /* glsl */ `
uniform sampler2D tColor; uniform sampler2D tN; uniform sampler2D tP;
uniform vec2 uRes; uniform mat3 uViewToModel; uniform mat4 uPosToClip;
uniform float uCell; uniform vec2 uCellAspect; uniform vec2 uOffset; uniform float uMode; uniform float uCellPx; uniform float uAvg;
vec4 fxProject(vec3 pc) {
  vec4 clip = uPosToClip * vec4(pc, 1.0);
  return texture2D(tColor, clip.xy / clip.w * 0.5 + 0.5);
}
vec4 fxCell(vec2 uv, out vec2 local, out vec2 cid) {
  vec4 own = texture2D(tColor, uv);
  if (uMode > 0.5) {
    vec2 g = (uv * uRes + uOffset * uCellPx) / (uCellPx * uCellAspect);
    cid = floor(g); local = fract(g);
    vec2 c = ((cid + 0.5) * uCellPx * uCellAspect - uOffset * uCellPx) / uRes;
    return texture2D(tColor, c);
  }
  vec3 p = texture2D(tP, uv).xyz;
  vec3 n = normalize(uViewToModel * (texture2D(tN, uv).rgb * 2.0 - 1.0));
  vec3 an = abs(n);
  float ax = an.x > an.y && an.x > an.z ? 0.0 : (an.y > an.z ? 1.0 : 2.0);
  vec2 q = ax < 0.5 ? p.yz : (ax < 1.5 ? p.xz : p.xy);
  vec2 g = (q + uOffset * uCell) / (uCell * uCellAspect);
  cid = floor(g) + ax * 4096.0; local = fract(g);
  vec2 qc = (floor(g) + 0.5) * uCell * uCellAspect - uOffset * uCell;
  vec3 pc = p;
  if (ax < 0.5) pc.yz = qc; else if (ax < 1.5) pc.xz = qc; else pc.xy = qc;
  vec4 c = fxProject(pc);
  if (uAvg > 0.5) {
    // "Average": four points inside the cell rather than its one centre, so a
    // block is the surface's mean colour, not a single noisy sample.
    vec2 h = 0.25 * uCell * uCellAspect;
    vec3 pa = pc, pb = pc, pcc = pc, pd = pc;
    if (ax < 0.5) { pa.yz += vec2(-h.x, -h.y); pb.yz += vec2(h.x, -h.y); pcc.yz += vec2(-h.x, h.y); pd.yz += h; }
    else if (ax < 1.5) { pa.xz += vec2(-h.x, -h.y); pb.xz += vec2(h.x, -h.y); pcc.xz += vec2(-h.x, h.y); pd.xz += h; }
    else { pa.xy += vec2(-h.x, -h.y); pb.xy += vec2(h.x, -h.y); pcc.xy += vec2(-h.x, h.y); pd.xy += h; }
    c = 0.25 * (fxProject(pa) + fxProject(pb) + fxProject(pcc) + fxProject(pd));
  }
  // A centre that projects off the body (an occluded or edge cell) keeps the
  // pixel's own colour rather than borrowing the background.
  return c.a > 0.5 ? c : own;
}
float fxHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
`;

/*
 * The common surface toolkit for the print / pattern effects: model-space
 * position and normal, the dominant plane (a hard triplanar switch — the
 * pattern is drawn ON the surface, so a seam where the plane changes reads as
 * an edge of the object, which it is), and the lit picture as TONE.
 */
const FX_SURF = /* glsl */ `
uniform sampler2D tColor; uniform sampler2D tN; uniform sampler2D tP;
uniform vec2 uRes; uniform mat3 uViewToModel; uniform mat4 uPosToClip; uniform float uMix; uniform float uTime;
uniform float uCell;
float fxLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 fxUnpre(vec4 c) { return c.a > 1e-4 ? c.rgb / c.a : vec3(0.0); }
vec3 fxNormalM(vec2 uv) { return normalize(uViewToModel * (texture2D(tN, uv).rgb * 2.0 - 1.0)); }
float fxAxis(vec3 n) { vec3 a = abs(n); return a.x > a.y && a.x > a.z ? 0.0 : (a.y > a.z ? 1.0 : 2.0); }
vec2 fxPlane(vec3 p, float ax) { return ax < 0.5 ? p.yz : (ax < 1.5 ? p.xz : p.xy); }
vec3 fxUnplane(vec3 p, float ax, vec2 q) { vec3 r = p; if (ax < 0.5) r.yz = q; else if (ax < 1.5) r.xz = q; else r.xy = q; return r; }
vec4 fxProject(vec3 pc) { vec4 clip = uPosToClip * vec4(pc, 1.0); return texture2D(tColor, clip.xy / clip.w * 0.5 + 0.5); }
vec2 fxRot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
// HDR light → a 0..1 tone that keeps highlights apart instead of clipping them.
float fxTone(vec3 c) { return 1.0 - exp(-1.6 * fxLuma(c)); }
float fxBayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float fxBayer4(vec2 a) { return fxBayer2(0.5 * a) * 0.25 + fxBayer2(a); }
float fxBayer8(vec2 a) { return fxBayer4(0.5 * a) * 0.25 + fxBayer2(a); }
float fxH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
`;

// Separable blend modes on 0..1 colours (Fill, Colorama, Fractal Noise).
const FX_BLEND = /* glsl */ `
vec3 fxBlend(vec3 b, vec3 s, float m) {
  if (m < 0.5) return s;
  if (m < 1.5) return b * s;
  if (m < 2.5) return 1.0 - (1.0 - b) * (1.0 - s);
  if (m < 3.5) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (m < 4.5) return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b), b + (2.0 * s - 1.0) * (sqrt(b) - b), step(0.5, s));
  if (m < 5.5) return min(b + s, vec3(1.0));
  return abs(b - s);
}`;

// Geometry edges from the surface buffers (Neon Glow, Edge Detect). Needs FX_SURF.
const EDGE3D = /* glsl */ `
uniform mat4 uPosToView; uniform vec2 uZRange;
float e3Z(vec2 uv) { return -(uPosToView * vec4(texture2D(tP, uv).xyz, 1.0)).z; }
// Steps on a ring of r px around uv: x silhouette (coverage), y crease (the
// normal turning), z depth step (one part in front of another); w = coverage
// around. col = the covered neighbours' straight colour, so an outline pixel
// just OUTSIDE the body still knows the body's colour.
vec4 e3Edges(vec2 uv, float r, out vec3 col) {
  vec4 c0 = texture2D(tN, uv);
  vec3 n0 = c0.rgb * 2.0 - 1.0;
  float z0 = e3Z(uv);
  float zs = max(uZRange.y - uZRange.x, 1e-4);
  vec4 e = vec4(0.0);
  vec4 acc = texture2D(tColor, uv);
  for (int i = 0; i < 8; i++) {
    float ang = float(i) * 0.78539816;
    vec2 q = uv + vec2(cos(ang), sin(ang)) * r / uRes;
    vec4 nq = texture2D(tN, q);
    float both = c0.a * nq.a;
    e.x = max(e.x, abs(nq.a - c0.a));
    e.y = max(e.y, both * (1.0 - dot(n0, nq.rgb * 2.0 - 1.0)));
    e.z = max(e.z, both * abs(e3Z(q) - z0) / zs);
    acc += texture2D(tColor, q);
  }
  col = acc.a > 1e-4 ? acc.rgb / acc.a : vec3(0.0);
  e.w = acc.a / 9.0;
  return e;
}`;

const GLSL = {
  /*
   * HALFTONE in 3D — the screen is a lattice ON the surface (rotated by Angle in
   * its plane), each cell's dot sized by the real light at its centre. Dots,
   * lines, crosshatch, CMYK (four rotated screens, subtractive on paper) and an
   * engraving whose lines bend with the body.
   */
  halftone3d: /* glsl */ `
${FX_SURF}
uniform float uPattern, uAngle, uContrast, uChanRot, uMisreg, uDrift; uniform vec3 uInk, uPaper;
float toneAt(vec3 p, float ax, vec2 qc) {
  float t = fxTone(fxUnpre(fxProject(fxUnplane(p, ax, qc * uCell))));
  return clamp((t - 0.5) * uContrast + 0.5, 0.0, 1.0);
}
// Ink coverage of a dot screen at angle a for an INK amount k (0 = none).
float dotScreen(vec2 q, float a, float k) {
  vec2 r = fxRot(q, a);
  float d = length(fract(r) - 0.5);
  float rad = sqrt(clamp(k, 0.0, 1.0)) * 0.7071;
  float aa = max(fwidth(d), 1e-3);
  return 1.0 - smoothstep(rad - aa, rad + aa, d);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 own = texture2D(tColor, uv);
  if (own.a < 0.001) { gl_FragColor = own; return; }
  vec3 p = texture2D(tP, uv).xyz;
  float ax = fxAxis(fxNormalM(uv));
  vec2 q = fxPlane(p, ax) / uCell + uDrift * uTime * vec2(0.6, 0.2);
  // Tone at the centre of this pixel's cell in the rotated lattice.
  vec2 r = fxRot(q, uAngle);
  vec2 qc = fxRot(floor(r) + 0.5, -uAngle);
  float tone = toneAt(p, ax, qc - uDrift * uTime * vec2(0.6, 0.2));
  vec3 col;
  if (uPattern < 0.5) {
    col = mix(uPaper, uInk, dotScreen(q, uAngle, 1.0 - tone));
  } else if (uPattern < 1.5 || uPattern > 3.5) {
    // Lines; the engraving's bend with the surface coordinate across them.
    float y = r.y + (uPattern > 3.5 ? 0.18 * sin(r.x * 0.9 + p.y * 6.0) : 0.0);
    float f = abs(fract(y) - 0.5);
    float w = (1.0 - tone) * 0.5;
    float aa = max(fwidth(f), 1e-3);
    col = mix(uPaper, uInk, 1.0 - smoothstep(w - aa, w + aa, f));
  } else if (uPattern < 2.5) {
    float f1 = abs(fract(r.y) - 0.5);
    float f2 = abs(fract(fxRot(q, uAngle + 1.5707963).y) - 0.5);
    float aa = max(fwidth(f1), 1e-3);
    float c1 = (1.0 - smoothstep(0.12 - aa, 0.12 + aa, f1)) * step(tone, 0.66);
    float c2 = (1.0 - smoothstep(0.12 - aa, 0.12 + aa, f2)) * step(tone, 0.36);
    col = mix(uPaper, uInk, max(c1, c2));
  } else {
    vec3 c = clamp(fxUnpre(own), 0.0, 1.0);
    float k = 1.0 - max(c.r, max(c.g, c.b));
    vec3 cmy = (1.0 - c - k) / max(1.0 - k, 1e-3);
    vec2 mis = vec2(uMisreg * 0.05, 0.0);
    float cC = dotScreen(q + mis, uAngle + uChanRot, cmy.x);
    float cM = dotScreen(q - mis, uAngle + 2.0 * uChanRot, cmy.y);
    float cY = dotScreen(q, uAngle, cmy.z);
    float cK = dotScreen(q, uAngle + 3.0 * uChanRot, k);
    col = uPaper * (1.0 - cC * vec3(1.0, 0.0, 0.0)) * (1.0 - cM * vec3(0.0, 1.0, 0.0)) * (1.0 - cY * vec3(0.0, 0.0, 1.0)) * (1.0 - cK);
  }
  gl_FragColor = mix(own, vec4(col * own.a, own.a), uMix);
}`,

  /*
   * DITHER PRINT in 3D — an ordered dither whose matrix is locked to the
   * surface at Pitch, thresholding the real light; ink marks the lit areas on
   * paper (the flat effect's look), plus an optional ink outline where the
   * surface turns away. The model IS the subject: no scan needed.
   */
  dither3d: /* glsl */ `
${FX_SURF}
uniform float uThreshold, uContrast, uEdge, uPaperAmt, uAlgo; uniform vec3 uInk, uPaper; uniform mat4 uInvProj;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 own = texture2D(tColor, uv);
  if (own.a < 0.001) { gl_FragColor = own; return; }
  vec3 p = texture2D(tP, uv).xyz;
  float ax = fxAxis(fxNormalM(uv));
  vec2 q = fxPlane(p, ax) / uCell;
  float tone = clamp((fxTone(fxUnpre(own)) - 0.5) * uContrast + 0.5, 0.0, 1.0);
  float th;
  if (uAlgo < 0.5) th = fxBayer4(q);
  else if (uAlgo < 1.5) th = fxBayer8(q);
  else if (uAlgo < 2.5) th = fxH(floor(q));
  else th = length(fract(q) - 0.5) * 1.41;
  float lit = step(th + (uThreshold - 0.5), tone);
  // Ink outline on the edges that turn away from the camera.
  vec3 nv = normalize(texture2D(tN, uv).rgb * 2.0 - 1.0);
  vec4 r = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  float facing = clamp(dot(nv, -normalize(r.xyz / r.w)), 0.0, 1.0);
  float edge = uEdge * smoothstep(0.35, 0.1, facing);
  vec3 col = mix(uPaper, uInk, max(lit, edge));
  vec3 outc = mix(fxUnpre(own), col, uPaperAmt);
  gl_FragColor = mix(own, vec4(outc * own.a, own.a), uMix);
}`,

  /*
   * ASCII in 3D — the glyph grid on the surface (cells keep the glyph aspect),
   * each glyph picked by the real light at the cell's centre, from the flat
   * effect's own atlas (asciiEffect.getAsciiAtlas).
   */
  ascii3d: /* glsl */ `
${FX_SURF}
uniform sampler2D tAtlas; uniform float uN, uGw, uRows, uAspect;
uniform float uColorMode, uBoost, uBg, uSrcLevel, uContrast, uBright, uDither, uInvert;
uniform vec3 uGlyph, uLight, uBgColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 own = texture2D(tColor, uv);
  if (own.a < 0.001) { gl_FragColor = own; return; }
  vec3 p = texture2D(tP, uv).xyz;
  float ax = fxAxis(fxNormalM(uv));
  vec2 cellSz = vec2(uAspect, 1.0) * uCell;
  vec2 cc = fxPlane(p, ax) / cellSz;
  vec2 ci = floor(cc);
  vec2 f = cc - ci;
  vec4 cell = fxProject(fxUnplane(p, ax, (ci + 0.5) * cellSz));
  if (cell.a < 0.5) cell = own;
  vec3 c3 = fxUnpre(cell);
  float v = clamp((fxTone(c3) - 0.5) * uContrast + 0.5 + uBright, 0.0, 1.0);
  if (uInvert > 0.5) v = 1.0 - v;
  if (uDither > 0.0) v += (fxBayer4(ci) - 0.46875) * uDither / max(uN, 1.0);
  float g = clamp(floor(v * uN), 0.0, uN - 1.0);
  float col = mod(g, 16.0);
  float row = floor((g + 0.5) / 16.0);
  float slotW = uGw + 24.0;
  vec2 auv = vec2((col * slotW + 12.0 + f.x * uGw) / (16.0 * slotW),
                  (row * 88.0 + 12.0 + (1.0 - f.y) * 64.0) / (max(uRows, 1.0) * 88.0));
  float cov = texture2D(tAtlas, auv).a;
  vec3 fg = uColorMode < 0.5 ? c3 * (1.0 + uBoost) : (uColorMode < 1.5 ? uGlyph : mix(uGlyph, uLight, v));
  vec3 bg = uBg < 0.5 ? uBgColor : fxUnpre(own) * uSrcLevel;
  vec4 outc = uBg > 1.5 ? vec4(fg * cov * own.a, cov * own.a) : vec4(mix(bg, fg, cov) * own.a, own.a);
  gl_FragColor = mix(own, outc, uMix);
}`,

  /*
   * FRACTAL NOISE in 3D — the field is evaluated AT THE MODEL'S OWN POSITION in
   * 3D, so it wraps the body with no seams and flows through it as it drifts.
   * Basic / turbulent / ridged fBm, then the flat effect's tone controls and
   * blend modes over the lit picture; Light shades the field by the surface.
   */
  fractal3d: /* glsl */ `
${FX_SURF}
${FX_BLEND}
uniform float uType, uOctaves, uGain, uRidge, uContrast, uBright, uFloor, uLightAmt, uBlendMode, uInvertF;
uniform vec3 uDrift; uniform vec3 uShadow, uLightC; uniform vec3 uLightDir;
float h3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123); }
float vn3(vec3 x) {
  vec3 i = floor(x); vec3 f = x - i; f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 own = texture2D(tColor, uv);
  if (own.a < 0.001) { gl_FragColor = own; return; }
  vec3 p = texture2D(tP, uv).xyz / uCell + uDrift;
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int o = 0; o < 8; o++) {
    if (float(o) >= uOctaves) break;
    float n = vn3(p);
    if (uType > 1.5) n = pow(1.0 - abs(n * 2.0 - 1.0), uRidge);
    else if (uType > 0.5) n = abs(n * 2.0 - 1.0);
    sum += n * amp; norm += amp;
    amp *= uGain;
    p = p * 2.03 + vec3(17.1, 5.3, 11.7);
  }
  float v = sum / max(norm, 1e-4);
  v = clamp((v - 0.5) * uContrast + 0.5 + uBright, 0.0, 1.0);
  v = smoothstep(uFloor * 0.5, 1.0, v);
  if (uInvertF > 0.5) v = 1.0 - v;
  vec3 nv = normalize(texture2D(tN, uv).rgb * 2.0 - 1.0);
  v *= mix(1.0, clamp(dot(nv, uLightDir) * 0.5 + 0.5, 0.0, 1.0), uLightAmt);
  vec3 field = mix(uShadow, uLightC, v);
  vec3 base = clamp(fxUnpre(own), 0.0, 1.0);
  vec3 mixed;
  if (uBlendMode < 0.5) mixed = fxBlend(base, field, 2.0);
  else if (uBlendMode < 1.5) mixed = fxBlend(base, field, 5.0);
  else if (uBlendMode < 2.5) mixed = fxBlend(base, field, 1.0);
  else if (uBlendMode < 3.5) mixed = fxBlend(base, field, 3.0);
  else if (uBlendMode < 4.5) mixed = fxBlend(base, field, 4.0);
  else mixed = mix(base, field, v);
  gl_FragColor = mix(own, vec4(mixed * own.a, own.a), uMix);
}`,

  /*
   * FILL in 3D — the fill keeps the model's real light: "Normal" paints the
   * colour SHADED by the surface's own lighting rather than flat, and every
   * other mode blends against the lit picture.
   */
  fill3d: /* glsl */ `
${FX_SURF}
${FX_BLEND}
uniform vec3 uFill; uniform float uBlendMode;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 own = texture2D(tColor, uv);
  if (own.a < 0.001) { gl_FragColor = own; return; }
  vec3 lit = fxUnpre(own);
  vec3 base = clamp(lit, 0.0, 1.0);
  float shade = clamp(fxTone(lit) * 1.6, 0.0, 1.4);
  vec3 c;
  float m = uBlendMode;
  if (m < 0.5) c = uFill * shade;
  else if (m < 1.5) c = fxBlend(base, uFill, 1.0);
  else if (m < 2.5) c = fxBlend(base, uFill, 2.0);
  else if (m < 3.5) c = fxBlend(base, uFill, 3.0);
  else if (m < 4.5) c = fxBlend(base, uFill, 4.0);
  else if (m < 5.5) c = fxBlend(uFill, base, 3.0);
  else if (m < 6.5) c = fxBlend(base, uFill, 5.0);
  else if (m < 7.5) c = max(base, uFill);
  else if (m < 8.5) c = min(base, uFill);
  else if (m < 9.5) c = fxBlend(base, uFill, 6.0);
  else c = uFill * (fxLuma(base) / max(fxLuma(uFill), 1e-3));
  gl_FragColor = mix(own, vec4(c * own.a, own.a), uMix);
}`,

  /*
   * COLORAMA in 3D — the gradient map, with three inputs only a model has:
   * Height (along its own Y), Depth (distance from the camera across it) and
   * Facing (how squarely the surface looks at the camera).
   */
  colorama3d: /* glsl */ `
${FX_SURF}
${FX_BLEND}
uniform sampler2D tRamp; uniform mat4 uPosToView; uniform vec2 uZRange; uniform mat4 uInvProj;
uniform float uInput, uPhase, uCycle, uRepeat, uPreserveLuma, uPreserveAlpha, uDither, uBlendMode, uOriginal;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 own = texture2D(tColor, uv);
  if (own.a < 0.001) { gl_FragColor = own; return; }
  vec3 base = clamp(fxUnpre(own), 0.0, 1.0);
  vec3 p = texture2D(tP, uv).xyz;
  float x;
  if (uInput < 0.5) x = fxLuma(base);
  else if (uInput < 1.5) x = base.r;
  else if (uInput < 2.5) x = base.g;
  else if (uInput < 3.5) x = base.b;
  else if (uInput < 4.5) x = own.a;
  else if (uInput < 5.5) x = clamp(p.y + 0.5, 0.0, 1.0);
  else if (uInput < 6.5) {
    float z = -(uPosToView * vec4(p, 1.0)).z;
    x = 1.0 - clamp((z - uZRange.x) / max(1e-4, uZRange.y - uZRange.x), 0.0, 1.0);
  } else {
    vec3 nv = normalize(texture2D(tN, uv).rgb * 2.0 - 1.0);
    vec4 r = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
    x = clamp(dot(nv, -normalize(r.xyz / r.w)), 0.0, 1.0);
  }
  x += (fxH(floor(gl_FragCoord.xy)) - 0.5) * uDither * 0.02;
  float t = fract((x + uPhase + uCycle * uTime) * uRepeat);
  vec3 g = texture2D(tRamp, vec2(t, 0.5)).rgb;
  if (uPreserveLuma > 0.0) g = mix(g, g * (fxLuma(base) / max(fxLuma(g), 1e-3)), uPreserveLuma);
  vec3 c;
  float m = uBlendMode;
  if (m < 0.5) c = g;
  else if (m < 1.5) c = fxBlend(base, g, 1.0);
  else if (m < 2.5) c = fxBlend(base, g, 2.0);
  else if (m < 3.5) c = fxBlend(base, g, 3.0);
  else if (m < 4.5) c = fxBlend(base, g, 4.0);
  else if (m < 5.5) c = fxBlend(base, g, 5.0);
  else c = fxBlend(base, g, 6.0);
  c = mix(c, base, uOriginal);
  gl_FragColor = mix(own, vec4(c * own.a, own.a), uMix);
}`,

  /*
   * FRESNEL RIM — the surface turning away from the camera, lit. The same term
   * the lab (html/fresnel-rim-lab) splices into the material, read here from the
   * normal buffer: 1 − n·v, shaped by Width (exponent) and Softness, faded out on
   * the last sliver of the silhouette (single pixels there spike and bloom into
   * beads), optionally kept to one side.
   */
  rim: /* glsl */ `
uniform sampler2D tN; uniform vec2 uRes; uniform mat4 uInvProj;
uniform vec3 uColorA; uniform vec3 uColorB;
uniform float uIntensity, uPower, uSoft, uDirMix, uPulse, uTime;
uniform vec2 uDir;
${RAY}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 nt = texture2D(tN, uv);
  if (nt.a < 0.001) { gl_FragColor = vec4(0.0); return; }
  vec3 n = normalize(nt.rgb * 2.0 - 1.0);
  float facing = clamp(dot(n, -fxViewRay(uv, uInvProj)), 0.0, 1.0);
  float fres = pow(1.0 - facing, uPower);
  fres *= smoothstep(0.0, 0.12, facing);
  fres = mix(smoothstep(0.45, 0.55, fres), fres, uSoft);
  vec2 n2 = n.xy / max(length(n.xy), 1e-4);
  fres *= mix(1.0, smoothstep(-0.25, 0.9, dot(n2, uDir)), uDirMix);
  float pulse = 1.0 - uPulse * (0.5 - 0.5 * sin(uTime * 3.0));
  vec3 col = mix(uColorB, uColorA, smoothstep(0.0, 1.0, fres));
  gl_FragColor = vec4(col * fres * uIntensity * pulse * nt.a, 1.0);
}`,

  /*
   * RGB SPLIT in 3D — three FILMINGS, not three offsets of one picture: red and
   * blue come from the model re-rendered with the camera moved, so near parts
   * split more than far ones and the copies overlap in real depth.
   */
  rgbCombine: /* glsl */ `
uniform sampler2D tR; uniform sampler2D tG; uniform sampler2D tB; uniform sampler2D tP;
uniform vec2 uRes; uniform float uMix; uniform mat4 uPosToClip; uniform vec2 uShiftR, uShiftB;
vec3 unpre(vec4 c) { return c.a > 1e-4 ? c.rgb / c.a : vec3(0.0); }
// The PROCESSED picture as one shifted copy sees it. tR / tB hold the surface
// point that copy shows at each pixel (its position buffer); that point is
// looked up where it sits in the main view, so everything the effects before
// this one did rides along with real parallax. Light that is not on the
// surface (a halo) follows the model's centre instead.
vec4 viewFrom(sampler2D copyTex, vec2 uv, vec2 shift) {
  vec4 q = texture2D(copyTex, uv);
  float cov = clamp(q.a, 0.0, 1.0);
  vec4 surf = vec4(0.0);
  if (cov > 0.001) {
    vec4 clip = uPosToClip * vec4(q.xyz / q.a, 1.0);
    surf = vec4(unpre(texture2D(tG, clip.xy / clip.w * 0.5 + 0.5)), 1.0) * cov;
  }
  vec2 o = uv - shift;
  vec4 off = texture2D(tG, o) * (1.0 - clamp(texture2D(tP, o).a, 0.0, 1.0));
  return surf + off * (1.0 - cov);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 g = texture2D(tG, uv);
  vec4 r = viewFrom(tR, uv, uShiftR);
  vec4 b = viewFrom(tB, uv, uShiftB);
  float a = (r.a + g.a + b.a) / 3.0;
  vec4 fx = vec4(vec3(unpre(r).r, unpre(g).g, unpre(b).b) * a, a);
  gl_FragColor = mix(g, fx, uMix);
}`,

  /* PIXELATE in 3D — flat blocks locked to the surface (see SURFACE_CELL). */
  pixelate3d: /* glsl */ `
${SURFACE_CELL}
uniform float uMix;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 own = texture2D(tColor, uv);
  if (own.a < 0.001) { gl_FragColor = own; return; }
  vec2 local; vec2 cid;
  vec4 c = fxCell(uv, local, cid);
  vec4 fx = vec4(c.rgb / max(c.a, 1e-4) * own.a, own.a);
  gl_FragColor = mix(own, fx, uMix);
}`,

  /*
   * PIXEL MATRIX in 3D — the display's sub-pixels drawn on the model's own
   * surface cells: each cell shows its colour through R/G/B elements (stripes,
   * grille, triads, LED dots, LCD bars), with scanlines and a rolling bar that
   * travels along the body.
   */
  crtMatrix3d: /* glsl */ `
${SURFACE_CELL}
uniform float uMix; uniform float uDisplay; uniform float uScan; uniform float uSub; uniform float uSoft;
uniform float uFlicker; uniform float uRoll; uniform float uTime;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 own = texture2D(tColor, uv);
  if (own.a < 0.001) { gl_FragColor = own; return; }
  vec2 local; vec2 cid;
  vec4 c = fxCell(uv, local, cid);
  vec3 col = c.rgb / max(c.a, 1e-4);
  float soft = mix(0.04, 0.3, uSoft);
  vec3 mask = vec3(1.0);
  if (uDisplay > 2.5 && uDisplay < 3.5) {
    // LED: one round emitter per cell, white of the cell's colour.
    float d = length(local - 0.5);
    mask = vec3(1.0 - smoothstep(0.32 - soft, 0.36 + soft, d));
  } else {
    // Three vertical elements per cell; CRT staggers its triads by row.
    float x = local.x;
    if (uDisplay < 0.5) x = fract(x + 0.5 * mod(cid.y, 2.0));
    float k = floor(x * 3.0);
    float fx = fract(x * 3.0);
    float edge = smoothstep(0.0, soft, fx) * smoothstep(1.0, 1.0 - soft, fx);
    vec3 el = k < 0.5 ? vec3(1.0, 0.0, 0.0) : (k < 1.5 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));
    // Row gaps for the triad, stripe and LCD panels; an aperture grille's wires run unbroken.
    if (uDisplay < 1.5 || uDisplay > 3.5) edge *= smoothstep(0.0, soft, local.y) * smoothstep(1.0, 1.0 - soft, local.y);
    mask = el * edge * 3.0;
  }
  mask = mix(vec3(1.0), mask, uSub);
  float scan = 1.0 - uScan * (0.5 - 0.5 * cos(local.y * 6.2831853));
  float flick = 1.0 - uFlicker * 0.5 * fxHash(vec2(floor(uTime * 24.0), 3.0));
  vec3 p = texture2D(tP, uv).xyz;
  float bar = 1.0 + uRoll * 0.6 * smoothstep(0.08, 0.0, abs(fract(p.y + 0.5 - uTime * 0.25) - 0.5));
  vec3 lit = col * mask * scan * flick * bar;
  vec4 fx = vec4(lit * own.a, own.a);
  gl_FragColor = mix(own, fx, uMix);
}`,

  /*
   * GRADIENT MOTION BEAM in 3D — the flat beam's cloud (same timing, lobes and
   * falloff) as a SLAB moving through the model's own space: Directional sweeps
   * a plane along Angle in the model's XY, From Center grows a shell from the
   * model's middle. It lights the surface where the slab crosses it.
   */
  beam3d: /* glsl */ `
${FX_SURF}
${FX_BLEND}
uniform vec3 uC1, uC2, uC3;
uniform float uSpeed, uAngle, uBlur, uWidth, uHold, uOpacity, uBlendMode, uType, uKeepLayer;
vec3 gmbRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  float a = smoothstep(0.0, 1.0, clamp(t * 2.0, 0.0, 1.0));
  float b = smoothstep(0.0, 1.0, clamp(t * 2.0 - 1.0, 0.0, 1.0));
  return mix(mix(uC1, uC2, a), uC3, b);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 own = texture2D(tColor, uv);
  if (own.a < 0.001) { gl_FragColor = own; return; }
  vec3 p = texture2D(tP, uv).xyz;
  vec3 dir = vec3(cos(uAngle), sin(uAngle), 0.0);
  vec3 nrm = vec3(-dir.y, dir.x, 0.0);
  float halfDiag = 0.7071;
  float halfW = uWidth * halfDiag * 1.6;
  float travel = 2.6 / max(uSpeed, 0.05);
  float cycle = travel + uHold;
  float prog = clamp(mod(uTime, cycle) / travel, 0.0, 1.0);
  float glide = mix(prog, prog * prog * (3.0 - 2.0 * prog), 0.65);
  float d, rampPos;
  if (uType < 0.5) {
    float centre = -(halfDiag + halfW) + 2.0 * (halfDiag + halfW) * glide;
    float sd = dot(p, dir) - centre;
    float q = dot(p, nrm) + p.z * 0.6;
    float wob = 0.5 * sin(q * 2.3 + uTime * 0.5) + 0.5 * sin(q * 4.1 - uTime * 0.31);
    d = (sd + wob * halfW * 0.22) / halfW;
    rampPos = 0.5 + 0.52 * (q / halfDiag) + 0.26 * d + wob * 0.1;
  } else {
    halfW = uWidth * halfDiag * 0.9;
    float centre = -halfW * 0.72 + (halfDiag + halfW * 1.35) * glide;
    float radius = length(p);
    d = (radius - centre) / max(halfW, 1e-4);
    rampPos = 0.5 + d * 0.55;
  }
  float shape = mix(7.0, 1.6, uBlur);
  float env = exp(-pow(max(abs(d), 1e-4), shape) * 2.2);
  env *= 1.0 - smoothstep(1.7, 3.1, abs(d));
  float fade = smoothstep(0.0, 0.16, prog) * (1.0 - smoothstep(0.66, 1.0, prog));
  float k = clamp(env * fade * uOpacity, 0.0, 1.0);
  float keep = mix(clamp(env * fade, 0.0, 1.0), 1.0, uKeepLayer);
  vec3 beam = gmbRamp(rampPos);
  vec3 b = fxUnpre(own);
  vec3 outCol;
  if (uBlendMode < 0.5) outCol = b + beam * k * (1.0 - clamp(b, 0.0, 1.0));
  else if (uBlendMode < 1.5) outCol = b + beam * k;
  else if (uBlendMode < 2.5) outCol = mix(b, max(b, beam), k);
  else if (uBlendMode < 3.5) outCol = mix(b, fxBlend(clamp(b, 0.0, 1.0), beam, 4.0), k);
  else outCol = mix(b, beam, k);
  float a = own.a * keep;
  gl_FragColor = mix(own, vec4(outCol * a, a), uMix);
}`,

  /*
   * GRADIENT SWEEP in 3D — a band crossing the model in its own space. Reveal:
   * the part not yet reached is dimmed and cooled, the band burns through it.
   * Silhouette: the band lights the edges that turn away. Sheen: a specular
   * band riding the surface, strongest where it grazes. uStage 0 writes only the
   * light (for the glow pyramid), 1 composites.
   */
  sweep3d: /* glsl */ `
${FX_SURF}
uniform sampler2D tLight; uniform sampler2D tHalo; uniform mat4 uInvProj;
uniform vec3 uCore, uWarm, uHot, uCool, uDeep, uStroke;
uniform float uStage, uMode, uAngle, uBand, uCoreW, uFront, uStrength, uBlendMode, uCoolFill, uDim, uSheenFade, uGlow, uStrokeOp, uStrokeW;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 own = texture2D(tColor, uv);
  if (own.a < 0.001) {
    // Past the silhouette the glow is the only light: its strength is its coverage.
    vec3 hOut = texture2D(tHalo, uv).rgb * uGlow;
    gl_FragColor = uStage < 0.5 ? vec4(0.0) : mix(own, vec4(hOut, clamp(max(hOut.r, max(hOut.g, hOut.b)), 0.0, 1.0)), uMix);
    return;
  }
  vec3 p = texture2D(tP, uv).xyz;
  vec3 dir = vec3(cos(uAngle), sin(uAngle), 0.0);
  float s01 = dot(p, dir) / 1.4142 + 0.5;
  float x = (uFront - s01) / max(uBand, 1e-3);   // > 0: already passed
  float bandEnv = exp(-x * x * 3.0);
  float core = 1.0 - smoothstep(uCoreW * 0.5, uCoreW * 0.5 + 0.15, abs(x));
  vec3 bandCol = mix(mix(uHot, uWarm, smoothstep(-0.4, 0.6, x)), uCore, core);
  vec3 nv = normalize(texture2D(tN, uv).rgb * 2.0 - 1.0);
  vec4 r = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  float facing = clamp(dot(nv, -normalize(r.xyz / r.w)), 0.0, 1.0);
  vec3 light;
  if (uMode < 0.5) light = bandCol * bandEnv * uStrength;
  else if (uMode < 1.5) {
    float edge = 1.0 - smoothstep(0.0, max(uStrokeW, 0.02), facing);
    light = (bandCol * bandEnv * uStrength + uStroke * uStrokeOp * step(0.0, x)) * edge;
  } else {
    float graze = pow(1.0 - facing, uSheenFade * 2.0 + 0.5);
    light = bandCol * bandEnv * uStrength * (0.25 + graze);
  }
  if (uStage < 0.5) { gl_FragColor = vec4(light, 1.0); return; }
  vec3 b = fxUnpre(own);
  // Reveal: ahead of the band the body waits dimmed and cooled.
  float ahead = uMode < 0.5 ? smoothstep(0.0, -1.0, x) : 0.0;
  vec3 waiting = mix(b * (1.0 - uDim), mix(uDeep, uCool, fxTone(b)), uCoolFill);
  vec3 base = mix(b, waiting, ahead);
  vec3 c;
  if (uBlendMode < 0.5) c = base + light;
  else if (uBlendMode < 1.5) c = base + light * (1.0 - clamp(base, 0.0, 1.0));
  else c = mix(base, bandCol, clamp(bandEnv * uStrength, 0.0, 1.0));
  vec3 halo = texture2D(tHalo, uv).rgb * uGlow;
  gl_FragColor = mix(own, vec4((c + halo) * own.a, own.a), uMix);
}`,

  /*
   * CONTOUR STUDIO in 3D — Topographic: iso-height lines wrapping the body
   * (levels across its height, nudged by the light with Detail). Flow
   * engraving: lines running AROUND the body, thickened by shadow. Lines keep a
   * constant on-screen width (fwidth), every fifth one in the accent colour.
   */
  contour3d: /* glsl */ `
${FX_SURF}
uniform float uMethod, uLevels, uDetail, uWeight, uDensity, uDrift; uniform vec3 uInk, uAccent;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 own = texture2D(tColor, uv);
  if (own.a < 0.001) { gl_FragColor = own; return; }
  vec3 p = texture2D(tP, uv).xyz;
  vec3 b = fxUnpre(own);
  float tone = fxTone(b);
  float h;
  float w = uWeight;
  if (uMethod < 0.5) {
    h = (p.y + 0.5 + (tone - 0.5) * uDetail * 0.15) * uLevels + uDrift * uTime;
  } else {
    h = (atan(p.z, p.x) / 6.2831853 + 0.5) * uDensity * 0.25 + uDrift * uTime;
    w = uWeight * mix(0.4, 1.6, 1.0 - tone);
  }
  float f = abs(fract(h) - 0.5);
  float fw = max(fwidth(h), 1e-4);
  float line = 1.0 - smoothstep(w * fw * 0.5, w * fw * 0.5 + fw, f);
  float major = step(mod(floor(h + 0.5), 5.0), 0.5);
  vec3 ink = mix(uInk, uAccent, major);
  vec3 c = mix(b, ink, line);
  gl_FragColor = mix(own, vec4(c * own.a, own.a), uMix);
}`,

  /*
   * SPECTRAL CURTAIN in 3D — the flat effect's idea (colour hanging off strong
   * contours) along the model's OWN down, projected to the frame this frame.
   * Bands are locked to the frame across that direction; a fragment marches
   * back along it to the first strong step in premultiplied luma — so the
   * silhouette is a contour too — and takes the lit side's colour, fading with
   * the distance travelled. Up / Both run it the other way (Both: the nearer
   * contour wins). Streaks leave the silhouette, so they carry their own coverage.
   */
  curtain3d: /* glsl */ `
uniform sampler2D tColor; uniform vec2 uRes; uniform float uMix;
uniform vec2 uFall; uniform float uDir, uDensity, uLength, uColW, uThreshold, uColorMode; uniform vec3 uTint;
vec3 cUnpre(vec4 c) { return c.a > 1e-4 ? c.rgb / c.a : vec3(0.0); }
float cLuma(vec4 c) { return dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)); }
float cHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
// x = distance travelled to the contour (-1: none), y = its strength; col = the lit side.
vec2 march(vec2 c, vec2 dir, out vec3 col) {
  col = vec3(0.0);
  vec4 prevC = texture2D(tColor, c / uRes);
  float prev = cLuma(prevC);
  for (int i = 1; i <= 32; i++) {
    float t = float(i) / 32.0 * uLength;
    vec2 q = c - dir * t;
    vec4 s = texture2D(tColor, q / uRes);
    float l = cLuma(s);
    float e = abs(l - prev) * 32.0 * 0.08;
    bool inside = q.x >= 0.0 && q.y >= 0.0 && q.x <= uRes.x && q.y <= uRes.y;
    if (inside && e > uThreshold) { col = cUnpre(l > prev ? s : prevC); return vec2(t, e); }
    prev = l; prevC = s;
  }
  return vec2(-1.0, 0.0);
}
void main() {
  vec2 px = gl_FragCoord.xy;
  vec4 own = texture2D(tColor, px / uRes);
  vec2 perp = vec2(-uFall.y, uFall.x);
  float across = dot(px, perp);
  float bi = floor(across / uColW);
  // Density thins the lattice: a hashed subset of bands lights, as the flat effect.
  if (cHash(vec2(bi, 7.3)) > clamp(uDensity / 400.0, 0.01, 1.0)) { gl_FragColor = own; return; }
  vec2 c = px + perp * ((bi + 0.5) * uColW - across);
  vec3 colD = vec3(0.0), colU = vec3(0.0);
  vec2 hD = vec2(-1.0, 0.0), hU = vec2(-1.0, 0.0);
  if (uDir < 0.5 || uDir > 1.5) hD = march(c, uFall, colD);
  if (uDir > 0.5) hU = march(c, -uFall, colU);
  bool useU = hU.x >= 0.0 && (hD.x < 0.0 || hU.x < hD.x);
  vec2 h = useU ? hU : hD;
  vec3 band = uColorMode > 0.5 ? uTint : (useU ? colU : colD);
  float a = h.x < 0.0 ? 0.0 : clamp((1.0 - h.x / uLength) * clamp(h.y, 0.0, 1.0), 0.0, 1.0);
  vec4 outc = own * (1.0 - a) + vec4(band * a, a);
  gl_FragColor = mix(own, outc, uMix);
}`,

  /*
   * BLOOM in 3D — the bright pass reads the model's HDR light BEFORE the tone
   * pass. Threshold / Soft Knee are judged on the DISPLAYED value (the tone
   * pass's own transform at the model's exposure), so the slider means what it
   * means on the flat effect; the light it lets through is the HDR light, so a
   * specular at 4× white blooms like one, not like a clipped 1.0. The halo is
   * the shared dual-Kawase pyramid; Anamorphic marches its first octave along
   * the lens axis, like the flat effect's streak.
   */
  bloomBright3d: /* glsl */ `
${DISPLAY_TRANSFORM_GLSL}
uniform sampler2D tColor; uniform vec2 uRes; uniform float uThr, uKnee, uExposure;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 s = texture2D(tColor, uv);
  vec3 c = s.a > 1e-4 ? s.rgb / s.a : vec3(0.0);
  vec3 shown = veDisplayTransform(c, uExposure);
  float br = max(shown.r, max(shown.g, shown.b));
  float knee = max(uThr * uKnee, 1e-4);
  float soft = clamp(br - uThr + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float w = max(max(soft, br - uThr) / max(br, 1e-4), 0.0);
  gl_FragColor = vec4(c * w * s.a, w * s.a);
}`,
  bloom3d: /* glsl */ `
uniform sampler2D tColor; uniform sampler2D tBloom; uniform sampler2D tStreak;
uniform vec2 uRes; uniform float uMix, uGain, uSat, uTintAmt, uAnamorph, uBlendMode; uniform vec3 uTint;
float bH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 src = texture2D(tColor, uv);
  vec3 bl = texture2D(tBloom, uv).rgb;
  float an = abs(uAnamorph);
  if (an > 0.01) {
    vec2 dir = uAnamorph >= 0.0 ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    float len = 0.10 + an * 0.35;
    float jit = bH(gl_FragCoord.xy) - 0.5;
    vec3 acc = vec3(0.0);
    float ws = 0.0, w = 1.0;
    for (int i = 1; i <= 16; i++) {
      w *= 0.91;
      vec2 o = dir * len * ((float(i) + jit) / 16.0);
      acc += (texture2D(tStreak, uv + o).rgb + texture2D(tStreak, uv - o).rgb) * w;
      ws += 2.0 * w;
    }
    bl += acc / max(ws, 1.0) * 2.0 * an * 1.2;
  }
  vec3 b = bl * uGain;
  float l = dot(b, vec3(0.2126, 0.7152, 0.0722));
  b = max(mix(vec3(l), b, uSat), 0.0);
  b = mix(b, vec3(l) * uTint * 1.6, uTintAmt);
  float ba = clamp(max(b.r, max(b.g, b.b)), 0.0, 1.0);
  vec3 sc = src.rgb;
  float outA = max(src.a, ba);
  vec3 col;
  if (uBlendMode < 0.5) col = sc + b;
  else if (uBlendMode < 1.5) col = sc + b * (1.0 - clamp(sc, 0.0, 1.0));
  else if (uBlendMode < 2.5) col = max(sc, b);
  else if (uBlendMode < 3.5) col = mix(sc + b, sc / max(vec3(1.0) - min(b, vec3(0.96)), vec3(0.04)), src.a);
  else { col = b; outA = ba; }
  gl_FragColor = mix(src, vec4(col, outA), uMix);
}`,

  /*
   * FLASH BLINK in 3D — the flat effect's clock (Strobe / Pulse / Flicker, the
   * same formulas), but Exposure Pop is a LIGHT: it lands on the side of the
   * body facing Light From (half-wrapped Lambert on the real normals). Blink
   * Out hides the model as the flat effect does.
   */
  flash3d: /* glsl */ `
${FX_SURF}
uniform float uSpeed, uMode, uStyle, uDuty, uSoft; uniform vec3 uFlash, uLightDir;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 own = texture2D(tColor, uv);
  if (own.a < 0.001) { gl_FragColor = own; return; }
  float ph = uTime * max(uSpeed, 0.05);
  float f = fract(ph);
  float duty = clamp(uDuty, 0.02, 0.98);
  float k;
  if (uMode < 0.5) {
    float e = max(uSoft * 0.5 * min(duty, 1.0 - duty), 1e-4);
    k = smoothstep(0.0, e, f) * (1.0 - smoothstep(duty - e, duty, f));
  } else if (uMode < 1.5) {
    k = pow(0.5 - 0.5 * cos(f * 6.2831853), mix(2.4, 0.45, duty));
  } else {
    float tick = floor(ph);
    k = step(1.0 - duty, fxH(vec2(tick, 3.7))) * mix(0.4, 1.0, fxH(vec2(tick, 9.1)));
  }
  k = clamp(k, 0.0, 1.0);
  vec3 nv = normalize(texture2D(tN, uv).rgb * 2.0 - 1.0);
  float lam = clamp(dot(nv, uLightDir) * 0.7 + 0.3, 0.0, 1.0);
  vec4 outc = (uStyle > 0.5 && uStyle < 1.5)
    ? own * (1.0 - k)
    : vec4(own.rgb + uFlash * (k * lam * 1.6) * own.a, own.a);
  gl_FragColor = mix(own, outc, uMix);
}`,

  /*
   * LIGHT RAYS in 3D — the flat effect's three passes (emit, march to the
   * origin, composite) with the origin placed IN THE MODEL'S SPACE (Origin X/Y
   * across its box, so the source turns and travels with it) and the body
   * occluding its own rays: Alpha and Behind light comes from behind the model,
   * so the model hides it. Behind (3D only) is a light disc behind the body —
   * rays escape only around the silhouette.
   */
  raysEmit3d: /* glsl */ `
${FX_SURF}
uniform float uSource, uThr, uDisc; uniform vec2 uOrigin;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 s = texture2D(tColor, uv);
  vec3 lit = fxUnpre(s);
  vec3 col = clamp(lit, 0.0, 1.0);
  float tone = fxTone(lit);
  float lvl;
  if (uSource < 0.5) lvl = s.a;
  else if (uSource < 1.5) lvl = smoothstep(uThr, 1.0, tone) * s.a;
  else if (uSource < 2.5) lvl = smoothstep(max(uThr, 0.55), 1.0, tone) * s.a;
  else {
    vec2 d = (uv - uOrigin) * vec2(uRes.x / uRes.y, 1.0);
    lvl = exp(-dot(d, d) / max(uDisc * uDisc, 1e-6)) * (1.0 - s.a);
    col = vec3(1.0);
  }
  gl_FragColor = vec4(col * lvl, lvl);
}`,
  raysMarch3d: /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uRes; uniform vec2 uOrigin; uniform float uLen, uTaps, uDecay;
float rH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 delta = uv - uOrigin;
  float jitter = (rH(gl_FragCoord.xy) - 0.5) / uTaps;
  float fall = mix(1.0, 0.82, uDecay);
  vec4 acc = vec4(0.0);
  float w = 1.0, ws = 0.0;
  for (int i = 0; i < 48; i++) {
    float on = step(float(i) + 0.5, uTaps);
    float t = (float(i) / uTaps + jitter) * uLen;
    acc += texture2D(tSrc, uv - delta * t) * (w * on);
    ws += w * on;
    w *= mix(1.0, fall, on);
  }
  gl_FragColor = acc / max(ws, 1e-4);
}`,
  raysComp3d: /* glsl */ `
uniform sampler2D tColor; uniform sampler2D tRays; uniform vec2 uRes;
uniform float uMix, uExpo, uSrcLevel, uOcclude; uniform vec3 uRayColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 src = texture2D(tColor, uv);
  vec4 rays = texture2D(tRays, uv);
  vec3 rc = (rays.a > 1e-4 ? rays.rgb / rays.a : vec3(0.0)) * uRayColor;
  float ra = clamp(rays.a * uExpo, 0.0, 2.0) * (1.0 - src.a * uOcclude);
  vec3 col = src.rgb * uSrcLevel + rc * ra;
  float outA = clamp(src.a * uSrcLevel + ra, 0.0, 1.0);
  gl_FragColor = mix(src, vec4(col, outA), uMix);
}`,

  /*
   * NEON GLOW in 3D — the line is the model's REAL outline and creases this
   * frame (silhouette, normal turns, one part in front of another), not a
   * traced 2D path; the light runs around it by angle about the model's centre
   * on screen (Trim / Trail / Speed as the flat effect, Speed in laps per s).
   * Writes the core light; the glow is the shared pyramid (glowComp3d).
   */
  neon3d: /* glsl */ `
${FX_SURF}
${EDGE3D}
uniform vec2 uCenter; uniform float uCorePx, uHead, uTrail, uTrimS, uTrimE, uFull, uIntensity, uHue; uniform vec3 uGlow;
vec3 n3Hue(vec3 c, float a) {
  const vec3 k = vec3(0.57735027);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 near;
  vec4 e = e3Edges(uv, uCorePx, near);
  float edge = max(e.x, max(smoothstep(0.25, 0.6, e.y), smoothstep(0.03, 0.08, e.z)));
  vec2 d = (uv - uCenter) * uRes;
  float s = atan(d.y, d.x) / 6.2831853 + 0.5;
  float lit = 1.0;
  if (uFull < 0.5) {
    float span = max(uTrimE - uTrimS, 0.005);
    float sl = (s - uTrimS) / span;
    float inside = step(0.0, sl) * step(sl, 1.0);
    float dist = fract(uHead - sl);
    lit = inside * pow(clamp(1.0 - dist / max(uTrail, 1e-3), 0.0, 1.0), 1.5);
  }
  vec3 col = max(n3Hue(uGlow, uHue), 0.0);
  gl_FragColor = vec4(col * edge * lit * uIntensity, 1.0);
}`,

  /*
   * LINES DRAW in 3D — the flat effect's runner (Lap, Profile, Direction,
   * width from speed) on the model's real silhouette this frame: each line
   * rides the outline offset outward by Line Spread, lagging the one before by
   * Line Lag, tapering to its tail.
   */
  lines3d: /* glsl */ `
${FX_SURF}
uniform vec2 uCenter; uniform float uLines, uHead, uTrail, uWidthPx, uMinW, uWf, uTaper, uSpreadPx, uLag, uHeadBright, uIntensity, uDirSign;
uniform vec3 uC1, uC2, uC3;
// The most coverage within r px: the silhouette dilated by r.
float l3Cov(vec2 uv, float r) {
  float m = texture2D(tN, uv).a;
  for (int i = 0; i < 8; i++) {
    float ang = float(i) * 0.78539816;
    m = max(m, texture2D(tN, uv + vec2(cos(ang), sin(ang)) * r / uRes).a);
  }
  return m;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 d = (uv - uCenter) * uRes;
  float s = atan(d.y, d.x) / 6.2831853 + 0.5;
  vec3 L = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    float on = step(fi + 0.5, uLines);
    float dist = fract((uHead - fi * uLag - s) * uDirSign);
    float tr = clamp(1.0 - dist / max(uTrail, 1e-3), 0.0, 1.0);
    float w = max(uWidthPx * max(uWf, uMinW) * smoothstep(0.0, max(uTaper, 1e-3), tr), 0.75);
    float off = fi * uSpreadPx;
    float ring = clamp(l3Cov(uv, off + w) - l3Cov(uv, off), 0.0, 1.0);
    float headGlow = 1.0 + uHeadBright * 3.0 * smoothstep(0.94, 1.0, tr);
    float slot = mod(fi, 3.0);
    vec3 c = slot < 0.5 ? uC1 : (slot < 1.5 ? uC2 : uC3);
    L += c * ring * step(1e-4, tr) * mix(0.35, 1.0, tr) * headGlow * on;
  }
  gl_FragColor = vec4(L * uIntensity, 1.0);
}`,

  // Core light + its pyramid glow over the model, the model at Layer Opacity.
  glowComp3d: /* glsl */ `
uniform sampler2D tColor; uniform sampler2D tLight; uniform sampler2D tHalo;
uniform vec2 uRes; uniform float uMix, uCore, uHalo, uSrcLevel;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 c = texture2D(tColor, uv);
  vec3 L = texture2D(tLight, uv).rgb * uCore + texture2D(tHalo, uv).rgb * uHalo;
  float la = clamp(max(L.r, max(L.g, L.b)), 0.0, 1.0);
  vec4 o = vec4(c.rgb * uSrcLevel + L, max(c.a * uSrcLevel, la));
  gl_FragColor = mix(c, o, uMix);
}`,

  /*
   * EDGE DETECT in 3D — edges from the GEOMETRY (silhouette, creases, depth
   * steps), so a smooth gradient on the surface is not an edge and a limb in
   * front of the torso is, whatever the lighting. Detectors: Gradient (soft),
   * Thin Line (strong / weak like Canny), Ink Sketch (XDoG on the lit tone +
   * the outline), Contour Bands (level sets of REAL depth). Colour: Direction
   * Hue reads the surface normal; Duo Ramp runs near → far. The sweep and the
   * scanner run across the model's box on screen. Writes the edge light (alpha
   * = edge); edgeComp3d blends it.
   */
  edge3d: /* glsl */ `
${FX_SURF}
${EDGE3D}
uniform vec2 uCenter, uHalf;
uniform float uMethod, uThr, uKnee, uLow, uThick, uGain, uColorMode, uInvert, uBands;
uniform float uSigma, uK, uTau, uPhi, uEps, uAnim, uSpd, uProgress, uSweepAngle, uSweepSoft;
uniform vec3 uEdgeA, uEdgeB;
vec3 e3Hue(float h) { vec3 p3 = abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0); return clamp(p3 - 1.0, 0.0, 1.0); }
float e3Ring(vec2 uv, float r) {
  float s = fxTone(fxUnpre(texture2D(tColor, uv))) * 2.0;
  for (int i = 0; i < 8; i++) {
    float ang = float(i) * 0.78539816;
    s += fxTone(fxUnpre(texture2D(tColor, uv + vec2(cos(ang), sin(ang)) * r / uRes)));
  }
  return s / 10.0;
}
float e3VN(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(fxH(i), fxH(i + vec2(1.0, 0.0)), w.x), mix(fxH(i + vec2(0.0, 1.0)), fxH(i + vec2(1.0, 1.0)), w.x), w.y);
}
float e3Level(vec2 uv, float bands) {
  return floor(clamp((e3Z(uv) - uZRange.x) / max(uZRange.y - uZRange.x, 1e-4), 0.0, 0.9999) * bands);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 q = (uv - uCenter) / max(uHalf * 2.0, vec2(1e-4));
  vec2 axis = vec2(cos(uSweepAngle), sin(uSweepAngle));
  float asp = (uHalf.x * uRes.x) / max(uHalf.y * uRes.y, 1e-4);
  float span = 0.5 * (abs(axis.x) * asp + abs(axis.y)) + 1e-5;
  float sweep = dot(q * vec2(asp, 1.0), axis) / (2.0 * span) + 0.5;
  vec2 euv = uv;
  if (uAnim > 4.5) {
    float bt = floor(uTime * 8.0 * uSpd);
    euv = uv + (vec2(e3VN(q * 14.0 + bt * 7.13), e3VN(q * 14.0 + 91.7 - bt * 3.31)) - 0.5) * (3.5 / uRes);
  }
  vec3 near;
  vec4 g = e3Edges(euv, 1.0 + uThick, near);
  float cov = texture2D(tN, euv).a;
  float geo = max(g.x, max(g.y * 1.2, g.z * 6.0));
  float th = uThr * 0.7;
  float e;
  if (uMethod < 0.5) {
    e = smoothstep(th * (1.0 - uKnee), th * (1.0 + uKnee) + 0.003, geo);
  } else if (uMethod < 1.5) {
    e = geo >= th ? 1.0 : (geo >= th * uLow ? 0.5 : 0.0);
  } else if (uMethod < 2.5) {
    float a = e3Ring(euv, uSigma);
    float b = e3Ring(euv, uSigma * uK);
    float S = (1.0 + uTau) * a - uTau * b;
    float x = clamp(uPhi * (S - uEps), -8.0, 8.0);
    float t2 = exp(2.0 * x);
    float T = S >= uEps ? 1.0 : 1.0 + (t2 - 1.0) / (t2 + 1.0);
    e = max(clamp(1.0 - T, 0.0, 1.0) * cov, g.x);
  } else {
    float bands = max(floor(uBands + 0.5), 2.0);
    vec2 px = 1.0 / uRes;
    float l0 = e3Level(euv, bands);
    float lr = e3Level(euv + vec2(px.x, 0.0), bands);
    float lu = e3Level(euv + vec2(0.0, px.y), bands);
    float c3 = cov * texture2D(tN, euv + vec2(px.x, 0.0)).a * texture2D(tN, euv + vec2(0.0, px.y)).a;
    e = max((abs(lr - l0) > 0.5 || abs(lu - l0) > 0.5) ? c3 : 0.0, g.x);
  }
  if (uInvert > 0.5) e = (1.0 - e) * max(cov, g.x);
  e = clamp(e * uGain, 0.0, 1.0);
  float show = 1.0, scan = 0.0;
  if (uAnim > 0.5 && uAnim < 1.5) {
    float s2 = uSweepSoft + 0.02;
    float pp = mix(-s2, 1.0 + s2, clamp(uProgress * uSpd, 0.0, 1.0));
    show = 1.0 - smoothstep(pp - s2, pp + s2, sweep);
  } else if (uAnim > 1.5 && uAnim < 2.5) {
    float sd = sweep - (clamp(uProgress * uSpd, 0.0, 1.0) * 1.1 - 0.05);
    show = sd < 0.0 ? 1.0 : 0.0;
    scan = exp(-abs(sd) * 90.0) * max(cov, g.x);
  } else if (uAnim > 2.5 && uAnim < 3.5) {
    float f = fxH(vec2(floor(uTime * 24.0 * uSpd), 7.0));
    show = 0.45 + 0.55 * f * f;
  }
  e *= show;
  vec3 col;
  if (uColorMode < 0.5) col = uEdgeA;
  else if (uColorMode < 1.5) col = clamp(pow(clamp(near, 0.0, 1.0), vec3(0.6)) * 1.25, 0.0, 1.0);
  else if (uColorMode < 2.5) {
    vec3 n = texture2D(tN, euv).rgb * 2.0 - 1.0;
    col = e3Hue(fract(atan(n.y, n.x) / 6.2831853 + 0.5));
  } else {
    float z01 = clamp((e3Z(euv) - uZRange.x) / max(uZRange.y - uZRange.x, 1e-4), 0.0, 1.0);
    col = mix(uEdgeA, uEdgeB, z01);
  }
  gl_FragColor = vec4(col * e + (col * 0.85 + 0.15) * scan, clamp(e + scan * 0.5, 0.0, 1.0));
}`,
  edgeComp3d: /* glsl */ `
uniform sampler2D tColor; uniform sampler2D tLight; uniform sampler2D tHalo;
uniform vec2 uRes; uniform float uMix, uSrcLevel, uGlow, uBlendMode;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 src = texture2D(tColor, uv);
  vec4 ed = texture2D(tLight, uv);
  float e = clamp(ed.a, 0.0, 1.0);
  vec4 base = src * uSrcLevel;
  vec3 rgb;
  float a;
  if (uBlendMode < 0.5) { rgb = ed.rgb + base.rgb * (1.0 - e); a = e + base.a * (1.0 - e); }
  else if (uBlendMode < 1.5) { rgb = base.rgb + ed.rgb; a = base.a + e; }
  else { rgb = base.rgb + ed.rgb * (1.0 - clamp(base.rgb, 0.0, 1.0)); a = base.a + e * (1.0 - base.a); }
  vec3 h = texture2D(tHalo, uv).rgb * uGlow;
  rgb += h;
  a += clamp(max(h.r, max(h.g, h.b)), 0.0, 1.0) * 0.8;
  gl_FragColor = mix(src, vec4(rgb, clamp(a, 0.0, 1.0)), uMix);
}`,

  /*
   * AURA BLUR in 3D — the halo is the model's own blurred silhouette (the
   * pyramid of its picture, coverage and all), coloured inner → outer and
   * dispersed about its centre; the core melts the lit model towards its blur
   * and is tinted left → right ACROSS THE MODEL (its own X, so the gradient
   * turns with it). Unevenness is 3D noise on the body, flowing.
   */
  aura3d: /* glsl */ `
${FX_SURF}
uniform sampler2D tNarrow; uniform sampler2D tWide; uniform vec2 uCenter;
uniform vec3 uCL, uCM, uCR, uHI, uHO;
uniform float uGradL, uGradR, uMelt, uBase, uVary, uVaryScale, uFlow, uChroma, uHaloLevel, uShiftPx, uBreath, uCoreLevel, uSrcMode, uSrcThr;
float a3H(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123); }
float a3N(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 w = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(a3H(i), a3H(i + vec3(1.0, 0.0, 0.0)), w.x), mix(a3H(i + vec3(0.0, 1.0, 0.0)), a3H(i + vec3(1.0, 1.0, 0.0)), w.x), w.y);
  float b = mix(mix(a3H(i + vec3(0.0, 0.0, 1.0)), a3H(i + vec3(1.0, 0.0, 1.0)), w.x), mix(a3H(i + vec3(0.0, 1.0, 1.0)), a3H(i + vec3(1.0, 1.0, 1.0)), w.x), w.y);
  return mix(a, b, w.z);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 own = texture2D(tColor, uv);
  vec4 nar = texture2D(tNarrow, uv);
  vec4 wide = texture2D(tWide, uv);
  vec3 p = texture2D(tP, uv).xyz;
  vec3 frameP = vec3((uv - uCenter) * vec2(uRes.x / uRes.y, 1.0) * 1.5, 0.0);
  vec3 np = mix(frameP, p * 2.0, step(0.5, own.a)) * uVaryScale;
  float nz = a3N(np + vec3(0.0, uTime * uFlow, uTime * uFlow * 0.6));
  float vary = mix(1.0, 0.35 + 1.3 * nz, uVary);
  vec2 sh = vec2(uShiftPx / uRes.x, 0.0);
  vec3 sharp = vec3(fxUnpre(texture2D(tColor, uv + sh)).r, fxUnpre(own).g, fxUnpre(texture2D(tColor, uv - sh)).b);
  vec3 soft = nar.a > 1e-4 ? nar.rgb / nar.a : sharp;
  float melt = clamp(uMelt * (uBase + (1.0 - uBase) * nz * uVary * 1.5), 0.0, 1.0);
  vec3 core = mix(sharp, soft, melt);
  float gx = smoothstep(uGradL, max(uGradR, uGradL + 1e-3), p.x + 0.5);
  vec3 grad = gx < 0.5 ? mix(uCL, uCM, gx * 2.0) : mix(uCM, uCR, gx * 2.0 - 1.0);
  core = mix(core, vec3(fxLuma(core)) * grad * 1.4, 0.7) * uCoreLevel;
  float dR = texture2D(tWide, uCenter + (uv - uCenter) * (1.0 - uChroma * 0.04)).a;
  float dB = texture2D(tWide, uCenter + (uv - uCenter) * (1.0 + uChroma * 0.04)).a;
  vec3 hm = vec3(dR, wide.a, dB);
  if (uSrcMode < 0.5 || uSrcMode > 1.5) {
    float lt = smoothstep(uSrcThr, 1.0, fxTone(wide.a > 1e-4 ? wide.rgb / wide.a : vec3(0.0)));
    hm *= uSrcMode > 1.5 ? lt : mix(1.0, lt, 0.5);
  }
  vec3 hc = mix(uHO, uHI, clamp(nar.a * 1.6, 0.0, 1.0));
  vec3 halo = hc * hm * uHaloLevel * uBreath * vary;
  vec3 col = core * own.a + halo * (1.0 - own.a * 0.6);
  float a = max(own.a, clamp(max(halo.r, max(halo.g, halo.b)), 0.0, 1.0));
  gl_FragColor = mix(own, vec4(col, a), uMix);
}`,

  /*
   * DIGITAL GLITCH in 3D — the flat tear (rows, per-tick hash, chroma) cut in
   * the MODEL'S frame: rows run across its own up axis on screen and a torn
   * row slides along its own X and Z (projected, so a turned model tears in
   * depth, foreshortened). Chroma splits along its X.
   */
  glitch3d: /* glsl */ `
uniform sampler2D tColor; uniform vec2 uRes; uniform float uMix, uTime;
uniform vec2 uCenterPx, uUp, uAxX, uAxZ; uniform float uAmt, uBlk, uSpeed, uShift;
float gH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
vec3 gUn(vec4 c) { return c.a > 1e-4 ? c.rgb / c.a : vec3(0.0); }
void main() {
  vec2 px = gl_FragCoord.xy;
  vec4 own = texture2D(tColor, px / uRes);
  float t = floor(uTime * (uSpeed * 6.0 + 0.001));
  float row = floor(dot(px - uCenterPx, uUp) / max(uBlk, 2.0));
  float lineG = step(1.0 - uAmt * 0.6, gH(vec2(row, t)));
  float sx = (gH(vec2(row * 1.7, t * 0.3)) - 0.5) * uAmt * 0.12 * lineG;
  float sz = (gH(vec2(row * 2.3, t * 0.7)) - 0.5) * uAmt * 0.12 * lineG;
  vec2 q = px - (uAxX * sx + uAxZ * sz);
  vec2 cs = normalize(uAxX + 1e-6) * uShift * (0.3 + uAmt);
  vec4 g = texture2D(tColor, q / uRes);
  vec4 r = texture2D(tColor, (q + cs) / uRes);
  vec4 b = texture2D(tColor, (q - cs) / uRes);
  float a = (r.a + g.a + b.a) / 3.0;
  vec3 col = vec3(gUn(r).r, gUn(g).g, gUn(b).b);
  col = max(col + lineG * (gH(vec2(row, t * 2.1)) - 0.5) * uAmt * 0.35, 0.0);
  gl_FragColor = mix(own, vec4(col * a, a), uMix);
}`,

  /*
   * SLIT SCAN in 3D — strips cut across the model's own X (Vertical) or Y
   * (Horizontal) on screen, each slid along the strip and wrapped. The span is
   * the frame's (a model layer's box IS the frame), so strip counts read as on
   * the flat effect; the cut turns with the model. Driven by:
   * Subject field = the model's coverage at the strip's centre line, Edge
   * strength = its geometry turning there (normals), Standing wave, Random.
   */
  slit3d: /* glsl */ `
uniform sampler2D tColor; uniform sampler2D tN; uniform vec2 uRes; uniform float uMix, uTime;
uniform vec2 uCenterPx, uAcross, uAlong; uniform float uExtA, uExtB, uCount, uShift, uDrive, uHold, uGap, uWave, uSeed;
float sH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
void main() {
  vec2 px = gl_FragCoord.xy;
  vec4 own = texture2D(tColor, px / uRes);
  vec2 d = px - uCenterPx;
  float a = dot(d, uAcross) / max(uExtA * 2.0, 1.0) + 0.5;
  float n = max(2.0, floor(uCount + 0.5));
  float idx = floor(a * n);
  vec2 probe = uCenterPx + uAcross * ((idx + 0.5) / n - 0.5) * uExtA * 2.0;
  vec4 pn = texture2D(tN, probe / uRes);
  float field = pn.a;
  float f;
  if (uDrive < 0.5) f = field * 2.0 - 1.0;
  else if (uDrive < 1.5) {
    vec2 o = uAlong * 3.0;
    vec4 n1 = texture2D(tN, (probe + o) / uRes), n2 = texture2D(tN, (probe - o) / uRes);
    float e = abs(n1.a - n2.a) + n1.a * n2.a * (1.0 - dot(n1.rgb * 2.0 - 1.0, n2.rgb * 2.0 - 1.0));
    f = clamp(e * 4.0, 0.0, 2.0) - 1.0;
  } else if (uDrive < 2.5) f = sin(idx * 0.35 + uTime * max(uWave, 0.0));
  else f = sH(vec2(idx * 0.013 + uSeed, idx * 0.07)) * 2.0 - 1.0;
  float hold = 1.0 - uHold * clamp(field, 0.0, 1.0);
  float off = f * uShift * hold;
  // Slide along the strip and WRAP inside the span, as the flat effect wraps in its box.
  float b = fract(dot(d, uAlong) / max(uExtB * 2.0, 1.0) + 0.5 - off + 2.0);
  vec2 q = uCenterPx + uAcross * dot(d, uAcross) + uAlong * (b - 0.5) * uExtB * 2.0;
  vec4 moved = texture2D(tColor, q / uRes);
  float inGap = step(1.0 - uGap * n, fract(a * n));
  vec4 o = moved * (1.0 - inGap);
  gl_FragColor = mix(own, o, uMix);
}`,

  /*
   * PIXEL STRETCH in 3D — the flat stretch (runs inside the luminance band hold
   * the colour where they entered it; runs drag past their end) along the
   * model's own axes: Horizontal = its X, Vertical = its up, Radial = from its
   * centre on screen. Lanes are cut across that axis. The band is judged on the
   * DISPLAYED luma (the tone pass's own transform at the model's exposure), as
   * the flat effect judges the picture: a 1 − e^−x guess put a dim-lit model
   * that shows mid-grey below 35% and the effect did nothing.
   */
  stretch3d: /* glsl */ `
${DISPLAY_TRANSFORM_GLSL}
uniform sampler2D tColor; uniform vec2 uRes; uniform float uMix, uTime, uExposure;
uniform vec2 uCenterPx, uDirA; uniform float uMode, uLo, uHi, uSpan, uJitter, uBand, uFlip, uRef;
float pH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float pLum(vec2 px) {
  vec4 s = texture2D(tColor, px / uRes);
  vec3 c = s.a > 1e-4 ? s.rgb / s.a : vec3(0.0);
  return dot(veDisplayTransform(c, uExposure), vec3(0.2126, 0.7152, 0.0722)) * s.a;
}
bool pIn(vec2 px) { return px.x >= 0.0 && px.y >= 0.0 && px.x <= uRes.x && px.y <= uRes.y; }
void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 dir;
  float lane;
  if (uMode < 1.5) { dir = uDirA; lane = dot(px - uCenterPx, vec2(-uDirA.y, uDirA.x)); }
  else {
    vec2 rel = px - uCenterPx;
    dir = normalize(rel + 1e-5);
    lane = (atan(rel.y, rel.x) / 6.2831853 + 0.5) * uRes.y;
  }
  if (uFlip > 0.5) dir = -dir;
  float laneId = floor(lane / max(uBand, 1.0));
  float span = uSpan * (1.0 - uJitter * pH(vec2(laneId, 17.0)));
  vec2 stepv = dir * (span / 48.0);
  vec4 cur = texture2D(tColor, px / uRes);
  float l = pLum(px);
  vec4 res = cur;
  if (l >= uLo && l <= uHi) {
    vec2 origin = px;
    bool alive = true;
    for (int i = 1; i <= 48; i++) {
      vec2 q = px - stepv * float(i);
      float sl = pLum(q);
      alive = alive && pIn(q) && sl >= uLo && sl <= uHi;
      if (alive) origin = q;
    }
    res = texture2D(tColor, origin / uRes);
  } else {
    bool found = false;
    for (int i = 1; i <= 48; i++) {
      vec2 q = px - stepv * float(i);
      float sl = pLum(q);
      vec4 s = texture2D(tColor, q / uRes);
      bool hit = !found && pIn(q) && sl >= uLo && sl <= uHi;
      if (hit) { res = mix(cur, s, 1.0 - float(i) / 48.0); found = true; }
    }
  }
  gl_FragColor = mix(cur, res, uMix);
}`,

  /*
   * SHAPE RULERS in 3D — the model's REAL bounding box: its 12 edges projected
   * this frame (packed uSeg: ax, ay, bx, by, front per edge, px), drawn with
   * the flat effect's guide and mark functions. Edges on the far side of the
   * box are dimmed and pass BEHIND the model. Frame-aligned packs the
   * projection's 2D bounds instead, so it draws exactly like the flat effect.
   */
  rulers3d: /* glsl */ `
${SHAPE_RULERS_GLSL}
uniform sampler2D tColor; uniform vec2 uRes; uniform float uMix;
uniform float uSeg[60]; uniform float uCor[16]; uniform vec2 uCenterPx;
uniform float uLw, uExt, uDash, uShape, uMarkR, uMarkT, uMid, uLineOp, uCorners;
uniform vec2 uMarkHs; uniform vec3 uLineC, uMarkC;
void main() {
  vec2 px = gl_FragCoord.xy;
  vec4 src = texture2D(tColor, px / uRes);
  float front = 0.0, back = 0.0, mark = 0.0;
  for (int i = 0; i < 12; i++) {
    vec2 a = vec2(uSeg[i * 5], uSeg[i * 5 + 1]);
    vec2 b = vec2(uSeg[i * 5 + 2], uSeg[i * 5 + 3]);
    float vis = uSeg[i * 5 + 4];
    vec2 ab = b - a;
    float L = length(ab);
    if (L < 0.5) continue;
    vec2 t = ab / L;
    vec2 m = (a + b) * 0.5;
    float along = dot(px - m, t);
    float across = abs(dot(px - m, vec2(-t.y, t.x)));
    float g = srGuide(across, along, L * 0.5, uLw, uExt, uDash);
    if (vis > 0.5) front = max(front, g); else back = max(back, g);
    if (uMid > 0.5 && uShape < 6.5) {
      vec2 q = vec2(dot(px - m, vec2(-t.y, t.x)), along);
      mark = max(mark, clamp(0.5 - srMark(q, uMarkHs, 1.0, uShape, uMarkR, uMarkT), 0.0, 1.0));
    }
  }
  if (uShape < 6.5) {
    for (int k = 0; k < 8; k++) {
      if (float(k) >= uCorners) break;
      vec2 c = vec2(uCor[k * 2], uCor[k * 2 + 1]);
      vec2 sgn = vec2(c.x >= uCenterPx.x ? 1.0 : -1.0, c.y >= uCenterPx.y ? 1.0 : -1.0);
      mark = max(mark, clamp(0.5 - srMark((px - c) * sgn, uMarkHs, 0.0, uShape, uMarkR, uMarkT), 0.0, 1.0));
    }
  }
  float lines = max(front, back * 0.45 * (1.0 - src.a)) * uLineOp;
  vec4 o = src * (1.0 - lines) + vec4(uLineC * lines, lines);
  o = o * (1.0 - mark) + vec4(uMarkC * mark, mark);
  gl_FragColor = mix(src, o, uMix);
}`,

  /*
   * CURVES in 3D — the curve applies to the model's LIGHT before the tone
   * pass: each channel goes to a 0..1 tone (1 − e^−1.6x), through the curve,
   * and back to scene light, so a lifted highlight stays a highlight instead
   * of clipping at 1.0 the way a curve on the finished picture does.
   */
  curves3d: /* glsl */ `
uniform sampler2D tColor; uniform sampler2D tLUT; uniform vec2 uRes; uniform float uMix;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 s = texture2D(tColor, uv);
  if (s.a < 0.001) { gl_FragColor = s; return; }
  vec3 c = max(s.rgb / s.a, 0.0);
  vec3 t = clamp(1.0 - exp(-1.6 * c), 0.0, 1.0);
  t = vec3(
    texture2D(tLUT, vec2((t.r * 255.0 + 0.5) / 256.0, 0.5)).r,
    texture2D(tLUT, vec2((t.g * 255.0 + 0.5) / 256.0, 0.5)).g,
    texture2D(tLUT, vec2((t.b * 255.0 + 0.5) / 256.0, 0.5)).b);
  vec3 c2 = -log(max(1.0 - min(t, vec3(0.9985)), 1e-4)) / 1.6;
  gl_FragColor = mix(s, vec4(c2 * s.a, s.a), uMix);
}`,

  /*
   * PIXELATE as VOXELS (Grid: Voxels, 3D only) — the view ray walks a 3D grid
   * in the model's own space (Amanatides–Woo). A cell is solid where the
   * surface passes through it: its centre, projected, lands on a pixel whose
   * surface point lies in that cell. The first solid cell is drawn as a cube
   * face — the colour at its centre, flat-lit by the face it was entered
   * through, its edges darkened — so the silhouette itself turns blocky.
   */
  voxel3d: /* glsl */ `
${FX_SURF}
uniform mat4 uInvProj; uniform mat4 uViewToModel4; uniform vec3 uBoxH; uniform float uVox, uEdge;
uniform vec3 uLightM;
bool vSolid(vec3 c) {
  vec4 clip = uPosToClip * vec4(c, 1.0);
  vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
  if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) return false;
  vec3 q = texture2D(tP, suv).xyz;
  float cov = texture2D(tN, suv).a;
  vec3 dd = abs(q - c);
  return cov > 0.5 && max(dd.x, max(dd.y, dd.z)) <= uVox * 0.75;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 own = texture2D(tColor, uv);
  vec4 r = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dv = normalize(r.xyz / r.w);
  vec3 O = (uViewToModel4 * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 D = normalize((uViewToModel4 * vec4(dv, 0.0)).xyz);
  vec3 bmin = -uBoxH - uVox, bmax = uBoxH + uVox;
  vec3 inv = 1.0 / mix(vec3(1e-6), D, step(vec3(1e-6), abs(D)));
  vec3 t0 = (bmin - O) * inv, t1 = (bmax - O) * inv;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  float tEnter = max(max(tn.x, tn.y), max(tn.z, 0.0));
  float tExit = min(tf.x, min(tf.y, tf.z));
  vec4 outc = vec4(0.0);
  if (tExit > tEnter) {
    vec3 P = O + D * (tEnter + 1e-4);
    vec3 cell = floor(P / uVox);
    vec3 st = sign(D);
    vec3 tMax = ((cell + max(st, 0.0)) * uVox - O) * inv;
    vec3 tDel = abs(uVox * inv);
    float face = tn.x > tn.y && tn.x > tn.z ? 0.0 : (tn.y > tn.z ? 1.0 : 2.0);
    bool hit = false;
    float tHit = tEnter;
    for (int i = 0; i < 64; i++) {
      bool solid = vSolid((cell + 0.5) * uVox);
      if (!hit && solid) { hit = true; }
      if (!hit) {
        if (tMax.x < tMax.y && tMax.x < tMax.z) { tHit = tMax.x; cell.x += st.x; tMax.x += tDel.x; face = 0.0; }
        else if (tMax.y < tMax.z) { tHit = tMax.y; cell.y += st.y; tMax.y += tDel.y; face = 1.0; }
        else { tHit = tMax.z; cell.z += st.z; tMax.z += tDel.z; face = 2.0; }
      }
    }
    if (hit) {
      vec3 c = (cell + 0.5) * uVox;
      vec4 clip = uPosToClip * vec4(c, 1.0);
      vec4 sc = texture2D(tColor, clip.xy / clip.w * 0.5 + 0.5);
      vec3 col = sc.a > 1e-4 ? sc.rgb / sc.a : vec3(0.0);
      vec3 nrm = face < 0.5 ? vec3(-st.x, 0.0, 0.0) : (face < 1.5 ? vec3(0.0, -st.y, 0.0) : vec3(0.0, 0.0, -st.z));
      float shade = 0.55 + 0.45 * max(dot(nrm, uLightM), 0.0);
      vec3 hp = (O + D * tHit) / uVox - cell;
      vec2 f2 = face < 0.5 ? hp.yz : (face < 1.5 ? hp.xz : hp.xy);
      vec2 e2 = min(f2, 1.0 - f2);
      float edge = 1.0 - uEdge * (1.0 - smoothstep(0.02, 0.09, min(e2.x, e2.y)));
      outc = vec4(col * shade * edge, 1.0);
    }
  }
  gl_FragColor = mix(own, outc, uMix);
}`,

  /*
   * DEPTH SCAN in 3D — Depth Scan's slice, through EXACT depth. uSpace 0 slices
   * by distance from the camera across the model's own depth range; 1–3 sweep a
   * plane along the model's X, Y or Z, so the light runs over the body however
   * it is posed. Colour modes as the flat effect: RGB split, flat, gradient.
   */
  depthScan3d: /* glsl */ `
uniform sampler2D tColor; uniform sampler2D tP; uniform sampler2D tRamp;
uniform vec2 uRes; uniform mat4 uPosToView; uniform float uSpace; uniform vec2 uZRange;
uniform float uPhase, uWidth, uSplit, uFeather, uGrain, uGamma, uLow, uHigh;
uniform float uColorMode; uniform vec3 uColor; uniform float uBrightness, uSourceMix, uAmount;
float scnHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float band(float d, float c, float n, float w) {
  float soft = max(uFeather, fwidth(d) * 0.35);
  return 1.0 - smoothstep(w, w + soft, abs(d - c + n));
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 s = texture2D(tColor, uv);
  float cov = s.a;
  if (cov < 0.001) { gl_FragColor = s; return; }
  vec3 src = s.rgb / cov;
  vec3 p = texture2D(tP, uv).xyz;
  float d;
  if (uSpace < 0.5) {
    float z = -(uPosToView * vec4(p, 1.0)).z;
    d = 1.0 - clamp((z - uZRange.x) / max(1e-4, uZRange.y - uZRange.x), 0.0, 1.0);
  } else {
    d = clamp((uSpace < 1.5 ? p.x : (uSpace < 2.5 ? p.y : p.z)) + 0.5, 0.0, 1.0);
  }
  d = pow(d, uGamma);
  float n = (scnHash(floor(gl_FragCoord.xy)) - 0.5) * uGrain * (uWidth + uFeather) * 1.6;
  vec3 scan;
  if (uColorMode < 0.5) {
    scan = vec3(band(d, clamp(uPhase - uSplit, 0.0, 1.0), n, uWidth), band(d, uPhase, n * 0.35, uWidth),
      band(d, clamp(uPhase + uSplit, 0.0, 1.0), -n, uWidth));
  } else if (uColorMode < 1.5) {
    scan = uColor * band(d, uPhase, n * 0.35, uWidth);
  } else {
    float ext = max(uSplit, uWidth);
    float m = band(d, uPhase, n * 0.35, uWidth + uSplit);
    float t = clamp(0.5 + (d - uPhase + n * 0.35) / (2.0 * ext), 0.0, 1.0);
    scan = texture2D(tRamp, vec2(t, 0.5)).rgb * m;
  }
  float valid = smoothstep(uLow, uLow + 0.012, d) * (1.0 - smoothstep(uHigh - 0.012, uHigh, d));
  scan *= valid * uBrightness;
  vec3 effected = src * uSourceMix + scan;
  vec3 result = mix(src, effected, uAmount);
  gl_FragColor = vec4(result * cov, cov);
}`,

  /*
   * Dual-Kawase blur pyramid: half-resolution steps down, tent steps back up.
   * Wide and smooth for a handful of taps per level — the halo has to be an even
   * glow along the whole rim, not the bead-per-hot-pixel a threshold bloom gives.
   * RGBA: a blurred picture keeps its blurred coverage (Aura Blur's halo).
   */
  down: /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uRes; uniform vec2 uSrcTexel;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 o = uSrcTexel;
  vec4 s = texture2D(tSrc, uv) * 4.0;
  s += texture2D(tSrc, uv + vec2(-o.x, -o.y));
  s += texture2D(tSrc, uv + vec2( o.x, -o.y));
  s += texture2D(tSrc, uv + vec2(-o.x,  o.y));
  s += texture2D(tSrc, uv + vec2( o.x,  o.y));
  gl_FragColor = s / 8.0;
}`,
  up: /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uRes; uniform vec2 uSrcTexel;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 o = uSrcTexel;
  vec4 s = texture2D(tSrc, uv + vec2(-2.0 * o.x, 0.0));
  s += texture2D(tSrc, uv + vec2( 2.0 * o.x, 0.0));
  s += texture2D(tSrc, uv + vec2(0.0, -2.0 * o.y));
  s += texture2D(tSrc, uv + vec2(0.0,  2.0 * o.y));
  s += texture2D(tSrc, uv + vec2(-o.x, -o.y)) * 2.0;
  s += texture2D(tSrc, uv + vec2( o.x, -o.y)) * 2.0;
  s += texture2D(tSrc, uv + vec2(-o.x,  o.y)) * 2.0;
  s += texture2D(tSrc, uv + vec2( o.x,  o.y)) * 2.0;
  gl_FragColor = s / 12.0;
}`,

  /*
   * Light ADDED to the picture. The HDR target is premultiplied, so light on the
   * surface simply adds; light that lands OUTSIDE the model (a halo) has no
   * coverage of its own there, and the tone pass would divide it by alpha ≈ 0 and
   * drop it — so the result takes the light's own strength as coverage.
   */
  addLight: /* glsl */ `
uniform sampler2D tColor; uniform sampler2D tLight; uniform sampler2D tHalo;
uniform vec2 uRes; uniform float uHalo; uniform float uBase; uniform float uLight;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 c = texture2D(tColor, uv);
  vec3 L = texture2D(tLight, uv).rgb * uLight + texture2D(tHalo, uv).rgb * uHalo;
  float la = clamp(max(L.r, max(L.g, L.b)), 0.0, 1.0);
  gl_FragColor = vec4(c.rgb * uBase + L, max(c.a, la));
}`,

  /*
   * FRESNEL RIM on a FLAT picture (image / video layer) — the lab's edge rim.
   * A picture has no surface, but it has a depth map: a pixel lights up only
   * where depth DROPS AWAY behind it (a silhouette, a surface turning away), on
   * the near side, brightest at the edge and fading inward over the reach. Like
   * Depth Scan, a window around one depth level (the swept phase) picks WHICH
   * edges glow. The depth is read through the layer box (fxLocal, the projective
   * map Depth Scan uses), so it travels with the layer.
   */
  flatRim: /* glsl */ `
uniform sampler2D tDepth; uniform vec2 uRes; uniform mat3 uFxHomInv;
uniform float uInvert, uGamma, uLow, uHigh, uPhase, uWindow, uFeather, uEdgeMin;
uniform vec2 uRimUv;
uniform vec3 uColorA; uniform vec3 uColorB;
uniform float uIntensity, uDirMix, uPulse, uTime;
uniform vec2 uDir;
vec2 fxLocal(vec2 uvn) {
  vec3 h = uFxHomInv * vec3(uvn, 1.0);
  if (h.z < 1e-6) return vec2(-1e3);
  return h.xy / h.z;
}
float depthAt(vec2 p) {
  float d = texture2D(tDepth, clamp(p, 0.0, 1.0)).r;
  if (uInvert > 0.5) d = 1.0 - d;
  return pow(clamp(d, 0.0, 1.0), uGamma);
}
void main() {
  vec2 uvn = gl_FragCoord.xy / uRes;
  vec2 p = fxLocal(uvn);
  if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) { gl_FragColor = vec4(0.0); return; }
  float d = depthAt(p);
  float best = 0.0;
  vec2 outward = vec2(0.0);
  for (int k = 0; k < 12; k++) {
    float a = 6.2831853 * (float(k) + 0.5) / 12.0;
    vec2 dir = vec2(cos(a), sin(a));
    for (int r = 1; r <= 5; r++) {
      float fr = float(r) / 5.0;
      float drop = d - depthAt(p + dir * uRimUv * fr);
      float e = smoothstep(uEdgeMin, uEdgeMin * 3.0, drop) * (1.0 - fr * fr * 0.85);
      if (e > best) { best = e; outward = dir; }
    }
  }
  float soft = max(uFeather, 0.002);
  float win = 1.0 - smoothstep(uWindow * 0.5, uWindow * 0.5 + soft, abs(d - uPhase));
  float valid = smoothstep(uLow, uLow + 0.012, d) * (1.0 - smoothstep(uHigh - 0.012, uHigh, d));
  float light = best * win * valid;
  light *= mix(1.0, smoothstep(-0.25, 0.9, dot(outward, uDir)), uDirMix);
  float pulse = 1.0 - uPulse * (0.5 - 0.5 * sin(uTime * 3.0));
  vec3 col = mix(uColorB, uColorA, smoothstep(0.2, 1.0, best));
  gl_FragColor = vec4(col * light * uIntensity * pulse, 1.0);
}`,
};

// Model-space position for the gP buffer: world position brought back into the
// asset root's own frame and normalised to its bounding box, so 0.5 is the edge
// of the asset on every axis however the layer is fitted, posed or scaled.
// Written on top of MeshBasicMaterial so skinning and morphs come for free.
function makePositionMaterialGLSL(uniforms) {
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uFxRootInv; uniform vec3 uFxCenter; uniform float uFxScale;\nvarying vec3 vFxPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvFxPos = ((uFxRootInv * modelMatrix * vec4(transformed, 1.0)).xyz - uFxCenter) * uFxScale;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFxPos;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor = vec4(vFxPos, 1.0);');
  };
  m.customProgramCacheKey = () => 'model3dFx-gpos-v1';
  return m;
}

// ── Per-renderer resources (materials, the full-screen quad) ────────────────
const shared = new WeakMap();
function resourcesFor(renderer) {
  let r = shared.get(renderer);
  if (r) return r;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  r = {
    quad,
    scene,
    camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    materials: new Map(),
    posUniforms: {
      uFxRootInv: { value: new THREE.Matrix4() },
      uFxCenter: { value: new THREE.Vector3() },
      uFxScale: { value: 1 },
    },
    normalMat: null,
    posMat: null,
  };
  shared.set(renderer, r);
  return r;
}

// The surface toolkit's uniforms (FX_SURF), shared by the print / pattern passes.
const surfUniforms = () => ({
  tColor: { value: null }, tN: { value: null }, tP: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
  uViewToModel: { value: new THREE.Matrix3() }, uPosToClip: { value: new THREE.Matrix4() },
  uMix: { value: 1 }, uTime: { value: 0 }, uCell: { value: 0.03 },
});

const cellUniforms = () => ({
  tColor: { value: null }, tN: { value: null }, tP: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
  uViewToModel: { value: new THREE.Matrix3() }, uPosToClip: { value: new THREE.Matrix4() },
  uCell: { value: 0.03 }, uCellAspect: { value: new THREE.Vector2(1, 1) }, uOffset: { value: new THREE.Vector2(0, 0) },
  uMode: { value: 0 }, uCellPx: { value: 24 }, uAvg: { value: 0 },
});

// Uniform surfaces per pass. The TSL twin mirrors these names exactly, so one
// writer drives both backends.
const PASS_UNIFORMS = {
  rim: () => ({
    tN: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uInvProj: { value: new THREE.Matrix4() },
    uColorA: { value: new THREE.Color() }, uColorB: { value: new THREE.Color() },
    uIntensity: { value: 1 }, uPower: { value: 2 }, uSoft: { value: 0.5 }, uDirMix: { value: 0 },
    uPulse: { value: 0 }, uTime: { value: 0 }, uDir: { value: new THREE.Vector2(1, 0) },
  }),
  down: () => ({ tSrc: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uSrcTexel: { value: new THREE.Vector2(1, 1) } }),
  up: () => ({ tSrc: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uSrcTexel: { value: new THREE.Vector2(1, 1) } }),
  addLight: () => ({
    tColor: { value: null }, tLight: { value: null }, tHalo: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) }, uHalo: { value: 0 }, uBase: { value: 1 }, uLight: { value: 1 },
  }),
  rgbCombine: () => ({
    tR: { value: null }, tG: { value: null }, tB: { value: null }, tP: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uMix: { value: 1 },
    uPosToClip: { value: new THREE.Matrix4() }, uShiftR: { value: new THREE.Vector2() }, uShiftB: { value: new THREE.Vector2() },
  }),
  pixelate3d: () => ({ ...cellUniforms(), uMix: { value: 1 } }),
  crtMatrix3d: () => ({
    ...cellUniforms(), uMix: { value: 1 }, uDisplay: { value: 0 }, uScan: { value: 0.3 }, uSub: { value: 0.5 },
    uSoft: { value: 0.4 }, uFlicker: { value: 0 }, uRoll: { value: 0 }, uTime: { value: 0 },
  }),
  halftone3d: () => ({
    ...surfUniforms(), uPattern: { value: 0 }, uAngle: { value: 0 }, uContrast: { value: 1 }, uChanRot: { value: 0.4 },
    uMisreg: { value: 0 }, uDrift: { value: 0 }, uInk: { value: new THREE.Color() }, uPaper: { value: new THREE.Color() },
  }),
  dither3d: () => ({
    ...surfUniforms(), uThreshold: { value: 0.5 }, uContrast: { value: 1 }, uEdge: { value: 0.3 }, uPaperAmt: { value: 1 },
    uAlgo: { value: 0 }, uInk: { value: new THREE.Color() }, uPaper: { value: new THREE.Color() }, uInvProj: { value: new THREE.Matrix4() },
  }),
  ascii3d: () => ({
    ...surfUniforms(), tAtlas: { value: null }, uN: { value: 1 }, uGw: { value: 38 }, uRows: { value: 1 }, uAspect: { value: 0.6 },
    uColorMode: { value: 0 }, uBoost: { value: 0.6 }, uBg: { value: 0 }, uSrcLevel: { value: 0.2 }, uContrast: { value: 1.2 },
    uBright: { value: 0 }, uDither: { value: 0.6 }, uInvert: { value: 0 },
    uGlyph: { value: new THREE.Color() }, uLight: { value: new THREE.Color() }, uBgColor: { value: new THREE.Color() },
  }),
  fractal3d: () => ({
    ...surfUniforms(), uType: { value: 0 }, uOctaves: { value: 4 }, uGain: { value: 0.55 }, uRidge: { value: 2.5 },
    uContrast: { value: 1 }, uBright: { value: 0 }, uFloor: { value: 0.35 }, uLightAmt: { value: 0 }, uBlendMode: { value: 0 },
    uInvertF: { value: 0 }, uDrift: { value: new THREE.Vector3() }, uShadow: { value: new THREE.Color() },
    uLightC: { value: new THREE.Color() }, uLightDir: { value: new THREE.Vector3(0, 0, 1) },
  }),
  fill3d: () => ({ ...surfUniforms(), uFill: { value: new THREE.Color() }, uBlendMode: { value: 0 } }),
  colorama3d: () => ({
    ...surfUniforms(), tRamp: { value: null }, uPosToView: { value: new THREE.Matrix4() }, uZRange: { value: new THREE.Vector2(0, 1) },
    uInvProj: { value: new THREE.Matrix4() }, uInput: { value: 0 }, uPhase: { value: 0 }, uCycle: { value: 0 }, uRepeat: { value: 1 },
    uPreserveLuma: { value: 0 }, uPreserveAlpha: { value: 1 }, uDither: { value: 0.25 }, uBlendMode: { value: 0 }, uOriginal: { value: 0 },
  }),
  beam3d: () => ({
    ...surfUniforms(), uC1: { value: new THREE.Color() }, uC2: { value: new THREE.Color() }, uC3: { value: new THREE.Color() },
    uSpeed: { value: 1 }, uAngle: { value: 0 }, uBlur: { value: 0.6 }, uWidth: { value: 0.5 }, uHold: { value: 1.4 },
    uOpacity: { value: 0.75 }, uBlendMode: { value: 0 }, uType: { value: 0 }, uKeepLayer: { value: 1 },
  }),
  sweep3d: () => ({
    ...surfUniforms(), tLight: { value: null }, tHalo: { value: null }, uInvProj: { value: new THREE.Matrix4() },
    uCore: { value: new THREE.Color() }, uWarm: { value: new THREE.Color() }, uHot: { value: new THREE.Color() },
    uCool: { value: new THREE.Color() }, uDeep: { value: new THREE.Color() }, uStroke: { value: new THREE.Color() },
    uStage: { value: 1 }, uMode: { value: 0 }, uAngle: { value: 0 }, uBand: { value: 0.2 }, uCoreW: { value: 1 }, uFront: { value: 0 },
    uStrength: { value: 1 }, uBlendMode: { value: 0 }, uCoolFill: { value: 0.34 }, uDim: { value: 0.45 }, uSheenFade: { value: 0.5 },
    uGlow: { value: 0 }, uStrokeOp: { value: 0.9 }, uStrokeW: { value: 0.1 },
  }),
  contour3d: () => ({
    ...surfUniforms(), uMethod: { value: 0 }, uLevels: { value: 14 }, uDetail: { value: 0.6 }, uWeight: { value: 1 },
    uDensity: { value: 120 }, uDrift: { value: 0 }, uInk: { value: new THREE.Color() }, uAccent: { value: new THREE.Color() },
  }),
  curtain3d: () => ({
    tColor: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uMix: { value: 1 }, uFall: { value: new THREE.Vector2(0, -1) },
    uDir: { value: 0 }, uDensity: { value: 400 }, uLength: { value: 100 }, uColW: { value: 6 }, uThreshold: { value: 0.18 },
    uColorMode: { value: 0 }, uTint: { value: new THREE.Color() },
  }),
  bloomBright3d: () => ({ tColor: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uThr: { value: 0.62 }, uKnee: { value: 0.5 }, uExposure: { value: 1 } }),
  bloom3d: () => ({
    tColor: { value: null }, tBloom: { value: null }, tStreak: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
    uMix: { value: 1 }, uGain: { value: 1 }, uSat: { value: 1 }, uTintAmt: { value: 0 }, uAnamorph: { value: 0 }, uBlendMode: { value: 0 },
    uTint: { value: new THREE.Color() },
  }),
  flash3d: () => ({
    ...surfUniforms(), uSpeed: { value: 3 }, uMode: { value: 0 }, uStyle: { value: 2 }, uDuty: { value: 0.5 }, uSoft: { value: 0.15 },
    uFlash: { value: new THREE.Color() }, uLightDir: { value: new THREE.Vector3(0, 0, 1) },
  }),
  raysEmit3d: () => ({ ...surfUniforms(), uSource: { value: 0 }, uThr: { value: 0.4 }, uDisc: { value: 0.08 }, uOrigin: { value: new THREE.Vector2(0.5, 0.5) } }),
  raysMarch3d: () => ({
    tSrc: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
    uLen: { value: 0.55 }, uTaps: { value: 48 }, uDecay: { value: 0.55 },
  }),
  raysComp3d: () => ({
    tColor: { value: null }, tRays: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uMix: { value: 1 },
    uExpo: { value: 1.2 }, uSrcLevel: { value: 1 }, uOcclude: { value: 1 }, uRayColor: { value: new THREE.Color() },
  }),
  neon3d: () => ({
    ...surfUniforms(), uPosToView: { value: new THREE.Matrix4() }, uZRange: { value: new THREE.Vector2(0, 1) },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) }, uCorePx: { value: 1.5 }, uHead: { value: 0 }, uTrail: { value: 0.4 },
    uTrimS: { value: 0 }, uTrimE: { value: 1 }, uFull: { value: 0 }, uIntensity: { value: 1 }, uHue: { value: 0 }, uGlow: { value: new THREE.Color() },
  }),
  lines3d: () => ({
    ...surfUniforms(), uCenter: { value: new THREE.Vector2(0.5, 0.5) }, uLines: { value: 4 }, uHead: { value: 0 }, uTrail: { value: 0.35 },
    uWidthPx: { value: 7 }, uMinW: { value: 0.06 }, uWf: { value: 1 }, uTaper: { value: 0.12 }, uSpreadPx: { value: 8 }, uLag: { value: 0 },
    uHeadBright: { value: 0.3 }, uIntensity: { value: 1 }, uDirSign: { value: 1 },
    uC1: { value: new THREE.Color() }, uC2: { value: new THREE.Color() }, uC3: { value: new THREE.Color() },
  }),
  glowComp3d: () => ({
    tColor: { value: null }, tLight: { value: null }, tHalo: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
    uMix: { value: 1 }, uCore: { value: 1 }, uHalo: { value: 0 }, uSrcLevel: { value: 1 },
  }),
  edge3d: () => ({
    ...surfUniforms(), uPosToView: { value: new THREE.Matrix4() }, uZRange: { value: new THREE.Vector2(0, 1) },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) }, uHalf: { value: new THREE.Vector2(0.25, 0.25) },
    uMethod: { value: 0 }, uThr: { value: 0.12 }, uKnee: { value: 0.35 }, uLow: { value: 0.4 }, uThick: { value: 0 }, uGain: { value: 1 },
    uColorMode: { value: 0 }, uInvert: { value: 0 }, uBands: { value: 8 }, uSigma: { value: 2 }, uK: { value: 1.6 }, uTau: { value: 15 },
    uPhi: { value: 25 }, uEps: { value: 0 }, uAnim: { value: 0 }, uSpd: { value: 1 }, uProgress: { value: 0 }, uSweepAngle: { value: 0 },
    uSweepSoft: { value: 0.1 }, uEdgeA: { value: new THREE.Color() }, uEdgeB: { value: new THREE.Color() },
  }),
  edgeComp3d: () => ({
    tColor: { value: null }, tLight: { value: null }, tHalo: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
    uMix: { value: 1 }, uSrcLevel: { value: 0 }, uGlow: { value: 0 }, uBlendMode: { value: 0 },
  }),
  aura3d: () => ({
    ...surfUniforms(), tNarrow: { value: null }, tWide: { value: null }, uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uCL: { value: new THREE.Color() }, uCM: { value: new THREE.Color() }, uCR: { value: new THREE.Color() },
    uHI: { value: new THREE.Color() }, uHO: { value: new THREE.Color() },
    uGradL: { value: 0.16 }, uGradR: { value: 0.94 }, uMelt: { value: 1 }, uBase: { value: 0.46 }, uVary: { value: 0.48 },
    uVaryScale: { value: 6 }, uFlow: { value: 0.35 }, uChroma: { value: 0.41 }, uHaloLevel: { value: 1.3 }, uShiftPx: { value: 3 },
    uBreath: { value: 1 }, uCoreLevel: { value: 1.15 }, uSrcMode: { value: 0 }, uSrcThr: { value: 0 },
  }),
  glitch3d: () => ({
    tColor: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uMix: { value: 1 }, uTime: { value: 0 },
    uCenterPx: { value: new THREE.Vector2() }, uUp: { value: new THREE.Vector2(0, 1) }, uAxX: { value: new THREE.Vector2(1, 0) },
    uAxZ: { value: new THREE.Vector2(0, 0) }, uAmt: { value: 0.5 }, uBlk: { value: 24 }, uSpeed: { value: 4 }, uShift: { value: 8 },
  }),
  slit3d: () => ({
    tColor: { value: null }, tN: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uMix: { value: 1 }, uTime: { value: 0 },
    uCenterPx: { value: new THREE.Vector2() }, uAcross: { value: new THREE.Vector2(1, 0) }, uAlong: { value: new THREE.Vector2(0, 1) },
    uExtA: { value: 100 }, uExtB: { value: 100 }, uCount: { value: 84 }, uShift: { value: 0.035 }, uDrive: { value: 1 }, uHold: { value: 0.61 },
    uGap: { value: 0 }, uWave: { value: 1.6 }, uSeed: { value: 7 },
  }),
  stretch3d: () => ({
    tColor: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uMix: { value: 1 }, uTime: { value: 0 }, uExposure: { value: 1 },
    uCenterPx: { value: new THREE.Vector2() }, uDirA: { value: new THREE.Vector2(0, 1) }, uMode: { value: 1 }, uLo: { value: 0.35 },
    uHi: { value: 1 }, uSpan: { value: 240 }, uJitter: { value: 0.4 }, uBand: { value: 3 }, uFlip: { value: 0 }, uRef: { value: 1 },
  }),
  rulers3d: () => ({
    tColor: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uMix: { value: 1 },
    uSeg: { value: new Float32Array(60) }, uCor: { value: new Float32Array(16) }, uCenterPx: { value: new THREE.Vector2() },
    uLw: { value: 1.5 }, uExt: { value: 1e6 }, uDash: { value: 0 }, uShape: { value: 0 }, uMarkR: { value: 1 }, uMarkT: { value: 2.5 },
    uMid: { value: 0 }, uLineOp: { value: 0.9 }, uCorners: { value: 8 }, uMarkHs: { value: new THREE.Vector2(7.5, 7.5) },
    uLineC: { value: new THREE.Color() }, uMarkC: { value: new THREE.Color() },
  }),
  curves3d: () => ({ tColor: { value: null }, tLUT: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uMix: { value: 1 } }),
  voxel3d: () => ({
    ...surfUniforms(), uInvProj: { value: new THREE.Matrix4() }, uViewToModel4: { value: new THREE.Matrix4() },
    uBoxH: { value: new THREE.Vector3(0.5, 0.5, 0.5) }, uVox: { value: 0.05 }, uEdge: { value: 0.35 }, uLightM: { value: new THREE.Vector3(0, 0, 1) },
  }),
  depthScan3d: () => ({
    tColor: { value: null }, tP: { value: null }, tRamp: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
    uPosToView: { value: new THREE.Matrix4() }, uSpace: { value: 0 }, uZRange: { value: new THREE.Vector2(0, 1) },
    uPhase: { value: 0 }, uWidth: { value: 0.011 }, uSplit: { value: 0.024 }, uFeather: { value: 0.0035 }, uGrain: { value: 0.22 },
    uGamma: { value: 1 }, uLow: { value: 0 }, uHigh: { value: 1 }, uColorMode: { value: 0 }, uColor: { value: new THREE.Color() },
    uBrightness: { value: 1.25 }, uSourceMix: { value: 0 }, uAmount: { value: 1 },
  }),
  flatRim: () => ({
    tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uFxHomInv: { value: new THREE.Matrix3() },
    uInvert: { value: 0 }, uGamma: { value: 1 }, uLow: { value: 0 }, uHigh: { value: 1 }, uPhase: { value: 0 },
    uWindow: { value: 0.14 }, uFeather: { value: 0.04 }, uEdgeMin: { value: 0.02 }, uRimUv: { value: new THREE.Vector2(0.01, 0.01) },
    uColorA: { value: new THREE.Color() }, uColorB: { value: new THREE.Color() },
    uIntensity: { value: 1 }, uDirMix: { value: 0 }, uPulse: { value: 0 }, uTime: { value: 0 },
    uDir: { value: new THREE.Vector2(1, 0) },
  }),
};

function passMaterial(res, name) {
  let m = res.materials.get(name);
  if (m) return m;
  if (usesNodes()) {
    m = fxNodes.createPassNodeMaterial(name);
  } else {
    m = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: GLSL[name],
      uniforms: PASS_UNIFORMS[name](),
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
  }
  res.materials.set(name, m);
  return m;
}

function drawPass(renderer, res, material, target) {
  res.quad.material = material;
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  renderer.render(res.scene, res.camera);
}

// ── Per-entry targets ───────────────────────────────────────────────────────
function hdrTarget(w, h, { depth = false, msaa = false } = {}) {
  const t = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    depthBuffer: depth,
    samples: msaa && !usesNodes() ? 4 : 0,
  });
  t.texture.minFilter = THREE.LinearFilter;
  t.texture.magFilter = THREE.LinearFilter;
  t.texture.generateMipmaps = false;
  return t;
}

const PYRAMID_LEVELS = 5;

// Every entry's live target set, for the debug read below.
const liveFx = new Set();
// Debug / gate hook (like __modelFxView): how many targets the real-3D effects
// hold right now and their colour memory (half-float RGBA; depth / MSAA extra).
globalThis.__modelFxStats = () => {
  let targets = 0, bytes = 0;
  for (const fx of liveFx) {
    for (const t of Object.values(fx.targets)) { targets += 1; bytes += t.width * t.height * 8; }
  }
  return { entries: liveFx.size, targets, mib: Math.round(bytes / 1048576) };
};

function ensureTargets(entry, w, h, needs) {
  const fx = entry.fx || (entry.fx = { w: 0, h: 0, targets: {} });
  liveFx.add(fx);
  if (fx.w !== w || fx.h !== h) {
    for (const t of Object.values(fx.targets)) t?.dispose?.();
    fx.targets = {};
    fx.w = w;
    fx.h = h;
  }
  const T = fx.targets;
  // Keep only what THIS frame's stack needs: a stack that drops its heavy effects
  // (down to Curves, say) must not hold their buffers — at 4K each full-size
  // target here is ~63 MiB. a / b are the chain's ping-pong and always stay.
  const drop = (k) => { if (T[k]) { T[k].dispose(); delete T[k]; } };
  if (!needs.normal) drop('gN');
  if (!needs.pos) drop('gP');
  if (!needs.light) drop('light');
  if (!needs.aux) drop('aux');
  if (!needs.copies) { drop('copyR'); drop('copyB'); }
  if (!needs.pyramid) for (let i = 0; i < PYRAMID_LEVELS; i += 1) { drop(`down${i}`); drop(`up${i}`); }
  if (needs.normal && !T.gN) T.gN = hdrTarget(w, h, { depth: true, msaa: true });
  if (needs.pos && !T.gP) T.gP = hdrTarget(w, h, { depth: true, msaa: true });
  if (!T.a) T.a = hdrTarget(w, h);
  if (!T.b) T.b = hdrTarget(w, h);
  if (needs.light && !T.light) T.light = hdrTarget(w, h);
  if (needs.aux && !T.aux) T.aux = hdrTarget(w, h);
  if (needs.copies && !T.copyR) {
    T.copyR = hdrTarget(w, h, { depth: true, msaa: true });
    T.copyB = hdrTarget(w, h, { depth: true, msaa: true });
  }
  if (needs.pyramid && !T.down0) {
    let lw = w, lh = h;
    for (let i = 0; i < PYRAMID_LEVELS; i += 1) {
      lw = Math.max(1, Math.round(lw / 2));
      lh = Math.max(1, Math.round(lh / 2));
      T[`down${i}`] = hdrTarget(lw, lh);
      T[`up${i}`] = hdrTarget(lw, lh);
    }
  }
  return fx;
}

/** Release every target this module holds for an entry (no live 3D effect). */
export function releaseModelFx(entry) {
  if (!entry?.fx) return;
  for (const t of Object.values(entry.fx.targets)) t?.dispose?.();
  liveFx.delete(entry.fx);
  entry.fx = null;
}

// ── Surface buffers ─────────────────────────────────────────────────────────
// The contact shadow and contact-occlusion patches sit in the model's own pass
// on the same camera layer; they are not the body and must not enter a buffer.
function withHelpersHidden(entry, fn) {
  const hidden = [];
  for (const m of [entry.shadowMesh, entry.aoMesh]) {
    if (m?.visible) { m.visible = false; hidden.push(m); }
  }
  try { fn(); } finally { for (const m of hidden) m.visible = true; }
}

function renderBuffer(renderer, ctx, material, target) {
  const { scene, cam, entry } = ctx;
  const prevOverride = scene.overrideMaterial;
  const prevBg = scene.background;
  scene.overrideMaterial = material;
  scene.background = null;
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  try {
    withHelpersHidden(entry, () => renderer.render(scene, cam));
  } finally {
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
  }
}

const _rootInv = new THREE.Matrix4();
const _size = new THREE.Vector3();
function renderSurfaceBuffers(renderer, res, ctx, fx, needs) {
  if (needs.normal) {
    if (!res.normalMat) {
      res.normalMat = usesNodes() ? fxNodes.createNormalNodeMaterial() : new THREE.MeshNormalMaterial();
    }
    renderBuffer(renderer, ctx, res.normalMat, fx.targets.gN);
  }
  if (needs.pos) {
    const u = res.posUniforms;
    ctx.entry.root.updateMatrixWorld(true);
    u.uFxRootInv.value.copy(_rootInv.copy(ctx.entry.root.matrixWorld).invert());
    ctx.entry.box.getCenter(u.uFxCenter.value);
    ctx.entry.box.getSize(_size);
    u.uFxScale.value = 1 / Math.max(1e-6, _size.x, _size.y, _size.z);
    if (!res.posMat) {
      res.posMat = usesNodes() ? fxNodes.createPositionNodeMaterial(u) : makePositionMaterialGLSL(u);
    }
    res.posMat.syncPos?.();
    renderBuffer(renderer, ctx, res.posMat, fx.targets.gP);
  }
}

// ── Blur pyramid ────────────────────────────────────────────────────────────
// How many pyramid levels reach `px` (each level about doubles the reach).
function levelsForPx(px) {
  return Math.max(1, Math.min(PYRAMID_LEVELS, Math.round(Math.log2(Math.max(1, px)))));
}

function blurPyramid(renderer, res, fx, srcTexture, srcW, srcH, levels = PYRAMID_LEVELS) {
  const T = fx.targets;
  const target = fx.target || ((name) => T[name]);
  const down = passMaterial(res, 'down');
  const up = passMaterial(res, 'up');
  let src = srcTexture, sw = srcW, sh = srcH;
  for (let i = 0; i < levels; i += 1) {
    const t = target(`down${i}`, i);
    down.uniforms.tSrc.value = src;
    down.uniforms.uRes.value.set(t.width, t.height);
    down.uniforms.uSrcTexel.value.set(1 / sw, 1 / sh);
    drawPass(renderer, res, down, t);
    src = t.texture; sw = t.width; sh = t.height;
  }
  for (let i = levels - 2; i >= 0; i -= 1) {
    const t = target(`up${i}`, i);
    up.uniforms.tSrc.value = src;
    up.uniforms.uRes.value.set(t.width, t.height);
    up.uniforms.uSrcTexel.value.set(0.5 / sw, 0.5 / sh);
    drawPass(renderer, res, up, t);
    src = t.texture; sw = t.width; sh = t.height;
  }
  return src;
}

// ── Model ↔ frame matrices for the surface buffers ──────────────────────────
// gP holds model-space position normalised to the asset box: p = (root − c)·s.
// These undo that and carry it to view / clip space, and bring a view-space
// normal back into the model's frame (for the triplanar cell plane).
const _denorm = new THREE.Matrix4();
const _rootCam = new THREE.Matrix4();
function surfaceMatrices(ctx, res) {
  const { entry, cam } = ctx;
  const pu = res.posUniforms;
  const k = 1 / Math.max(1e-6, pu.uFxScale.value);
  _denorm.makeScale(k, k, k).setPosition(pu.uFxCenter.value);
  const posToView = new THREE.Matrix4().multiplyMatrices(cam.matrixWorldInverse, entry.root.matrixWorld).multiply(_denorm);
  const posToClip = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, posToView);
  _rootCam.copy(entry.root.matrixWorld).invert().multiply(cam.matrixWorld);
  const viewToModel = new THREE.Matrix3().setFromMatrix4(_rootCam);
  return { posToView, posToClip, viewToModel };
}

// Cell size: authored in composition px; the model's normalised max extent (1.0
// in gP units) spans ctx.fitPx composition px, so a cell is size / fitPx units.
function writeCellUniforms(u, ctx, res, fx, src, { size, stretch = 0, offsetX = 0, offsetY = 0, mode = 0, avg = 0 }) {
  const T = fx.targets;
  const m = surfaceMatrices(ctx, res);
  u.tColor.value = src;
  u.tN.value = T.gN.texture;
  u.tP.value = T.gP.texture;
  u.uRes.value.set(fx.w, fx.h);
  u.uViewToModel.value.copy(m.viewToModel);
  u.uPosToClip.value.copy(m.posToClip);
  u.uCell.value = Math.max(1e-4, size / Math.max(1, ctx.fitPx || ctx.H || 1080));
  const st = stretch / 100;
  u.uCellAspect.value.set(1 + Math.max(0, st) * 3, 1 + Math.max(0, -st) * 3);
  u.uOffset.value.set(offsetX / 100, offsetY / 100);
  u.uMode.value = mode;
  u.uCellPx.value = Math.max(1, size * (fx.h / Math.max(1, ctx.H || fx.h)));
  u.uAvg.value = avg;
}

function writeSurfUniforms(u, ctx, res, fx, src, p, cellPx) {
  const T = fx.targets;
  const m = surfaceMatrices(ctx, res);
  u.tColor.value = src;
  u.tN.value = T.gN.texture;
  u.tP.value = T.gP.texture;
  u.uRes.value.set(fx.w, fx.h);
  u.uViewToModel.value.copy(m.viewToModel);
  u.uPosToClip.value.copy(m.posToClip);
  u.uMix.value = p.__mix;
  u.uTime.value = ctx.time;
  u.uCell.value = Math.max(1e-4, (cellPx || 20) / Math.max(1, ctx.fitPx || ctx.H || 1080));
  return m;
}

// The model's depth range in view space this frame: its asset box's corners.
const _zCorner = new THREE.Vector3();
function modelZRange(ctx, out) {
  const b = ctx.entry.box;
  let zMin = Infinity, zMax = -Infinity;
  const v = new THREE.Matrix4().multiplyMatrices(ctx.cam.matrixWorldInverse, ctx.entry.root.matrixWorld);
  for (let i = 0; i < 8; i += 1) {
    _zCorner.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(v);
    zMin = Math.min(zMin, -_zCorner.z); zMax = Math.max(zMax, -_zCorner.z);
  }
  return out.set(zMin, zMax);
}

// The model's box on screen this frame, in the passes' bottom-up frame uv:
// { cx, cy } its centre (the box centre projected) and { hx, hy } half its
// extent (the projected corners). Needs the position buffer's box uniforms.
const _cornerClip = new THREE.Vector4();
function modelScreenBox(ctx, res, mats) {
  const pu = res.posUniforms;
  ctx.entry.box.getSize(_size);
  const k = pu.uFxScale.value * 0.5;
  const toUv = (x, y, z) => {
    _cornerClip.set(x, y, z, 1).applyMatrix4(mats.posToClip);
    const w = Math.abs(_cornerClip.w) > 1e-6 ? _cornerClip.w : 1e-6;
    return [_cornerClip.x / w * 0.5 + 0.5, _cornerClip.y / w * 0.5 + 0.5];
  };
  const [cx, cy] = toUv(0, 0, 0);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i += 1) {
    const [u, v] = toUv((i & 1 ? 1 : -1) * _size.x * k, (i & 2 ? 1 : -1) * _size.y * k, (i & 4 ? 1 : -1) * _size.z * k);
    x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v);
  }
  return { cx, cy, hx: Math.max(1e-4, (x1 - x0) / 2), hy: Math.max(1e-4, (y1 - y0) / 2) };
}

// The model's centre and its own axes on screen, in px of the pass target
// (bottom-up): x / y / z are how far one normalised model unit along each axis
// moves on screen — foreshortened as the model turns.
const _axClip = new THREE.Vector4();
function modelScreenAxes(mats, fx) {
  const toPx = (x, y, z) => {
    _axClip.set(x, y, z, 1).applyMatrix4(mats.posToClip);
    const w = Math.abs(_axClip.w) > 1e-6 ? _axClip.w : 1e-6;
    return [(_axClip.x / w * 0.5 + 0.5) * fx.w, (_axClip.y / w * 0.5 + 0.5) * fx.h];
  };
  const c = toPx(0, 0, 0);
  const d = (q) => [q[0] - c[0], q[1] - c[1]];
  return { c, x: d(toPx(1, 0, 0)), y: d(toPx(0, 1, 0)), z: d(toPx(0, 0, 1)), toPx };
}
const unit2 = (v) => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};
// The shaders' hash, for a value the CPU needs (a flicker level per tick).
const hashJs = (x, y) => {
  const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return v - Math.floor(v);
};

const D2R = Math.PI / 180;
// A surface pass whose only work is "write the uniforms, draw once".
function surfacePass(name, write) {
  return {
    needs: () => ({ normal: true, pos: true }),
    run(renderer, res, ctx, fx, src, dst, p) {
      const m = passMaterial(res, name);
      if (write(m.uniforms, ctx, res, fx, src, p) === false) return src;
      drawPass(renderer, res, m, dst);
      return dst.texture;
    },
  };
}

const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();

// Pixelate's Grid: Voxels — the model as cubes on a grid in its own space.
const _viewLight = new THREE.Vector3();
function runVoxels(renderer, res, ctx, fx, src, dst, p) {
  const m = passMaterial(res, 'voxel3d');
  const u = m.uniforms;
  const mats = writeSurfUniforms(u, ctx, res, fx, src, p, p.size);
  u.uInvProj.value.copy(ctx.cam.projectionMatrixInverse);
  u.uViewToModel4.value.copy(mats.posToView).invert();
  ctx.entry.box.getSize(_size);
  u.uBoxH.value.copy(_size).multiplyScalar(res.posUniforms.uFxScale.value * 0.5);
  u.uVox.value = Math.max(0.004, (p.size ?? 22) / Math.max(1, ctx.fitPx || ctx.H || 1080));
  u.uEdge.value = 0.35;
  _viewLight.set(-0.45, 0.65, 0.6).normalize().applyMatrix3(mats.viewToModel).normalize();
  u.uLightM.value.copy(_viewLight);
  drawPass(renderer, res, m, dst);
  return dst.texture;
}

// T.light (a core line) + its pyramid glow over the model at `srcLevel`.
function glowComposite(renderer, res, fx, src, dst, p, halo, srcLevel) {
  const c = passMaterial(res, 'glowComp3d');
  const u = c.uniforms;
  u.tColor.value = src;
  u.tLight.value = fx.targets.light.texture;
  u.tHalo.value = halo || fx.targets.light.texture;
  u.uRes.value.set(fx.w, fx.h);
  u.uMix.value = p.__mix;
  u.uCore.value = 1;
  u.uHalo.value = halo ? 1.4 : 0;
  u.uSrcLevel.value = Math.max(0, Math.min(1, srcLevel));
  drawPass(renderer, res, c, dst);
  return dst.texture;
}

// ── Effects ─────────────────────────────────────────────────────────────────
const EFFECTS = {
  /*
   * RGB Split (overlay `rgbSplit`, real3d). The model is FILMED twice more with
   * the camera moved — sideways along Angle (Linear) or along the view axis
   * (Radial) — and the combine pass takes red from one, green from the main
   * pass, blue from the other. Amount is the split at the model's centre in px
   * of a 1080-tall frame; nearer parts split more, farther parts less.
   */
  rgbSplit: {
    needs: () => ({ pos: true, copies: true }),
    spills: true,
    run(renderer, res, ctx, fx, src, dst, p) {
      const T = fx.targets;
      const cam = ctx.cam;
      const camR = res.camR || (res.camR = new THREE.PerspectiveCamera());
      const camB = res.camB || (res.camB = new THREE.PerspectiveCamera());
      camR.copy(cam); camB.copy(cam);
      const Z = Math.max(1, ctx.viewDistance || 1000);
      const fPx = (fx.h / 2) / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
      const shiftPx = (p.amount || 0) * (fx.h / 1080);
      cam.matrixWorld.extractBasis(_right, _up, _fwd);
      if ((p.mode || 0) > 0.5) {
        // Radial: dolly so the frame edge splits by ~Amount; parallax by depth.
        const dz = Z * Math.min(0.5, shiftPx / Math.max(1, fx.h * 0.5));
        camR.position.addScaledVector(_fwd, -dz);
        camB.position.addScaledVector(_fwd, dz);
      } else {
        const a = THREE.MathUtils.degToRad(p.angle || 0);
        const d = (shiftPx * Z) / fPx;
        const ox = Math.cos(a) * d, oy = Math.sin(a) * d;
        camR.position.addScaledVector(_right, -ox).addScaledVector(_up, -oy);
        camB.position.addScaledVector(_right, ox).addScaledVector(_up, oy);
      }
      camR.updateMatrixWorld(true); camB.updateMatrixWorld(true);
      // The copies film the model's POSITIONS (not its light): the combine looks
      // each point up in `src`, so earlier effects in the stack keep their look in
      // red and blue too. Same buffers as gP, so no lighting is redone.
      renderBuffer(renderer, { ...ctx, cam: camR }, res.posMat, T.copyR);
      renderBuffer(renderer, { ...ctx, cam: camB }, res.posMat, T.copyB);
      const main = surfaceMatrices(ctx, res);
      const centreUv = (posToClip) => {
        _cornerClip.set(0, 0, 0, 1).applyMatrix4(posToClip);
        const w = Math.abs(_cornerClip.w) > 1e-6 ? _cornerClip.w : 1e-6;
        return [_cornerClip.x / w * 0.5 + 0.5, _cornerClip.y / w * 0.5 + 0.5];
      };
      const c0 = centreUv(main.posToClip);
      const cR = centreUv(surfaceMatrices({ ...ctx, cam: camR }, res).posToClip);
      const cB = centreUv(surfaceMatrices({ ...ctx, cam: camB }, res).posToClip);
      const m = passMaterial(res, 'rgbCombine');
      m.uniforms.tR.value = T.copyR.texture;
      m.uniforms.tG.value = src;
      m.uniforms.tB.value = T.copyB.texture;
      m.uniforms.tP.value = T.gP.texture;
      m.uniforms.uPosToClip.value.copy(main.posToClip);
      m.uniforms.uShiftR.value.set(cR[0] - c0[0], cR[1] - c0[1]);
      m.uniforms.uShiftB.value.set(cB[0] - c0[0], cB[1] - c0[1]);
      m.uniforms.uRes.value.set(fx.w, fx.h);
      m.uniforms.uMix.value = p.__mix;
      drawPass(renderer, res, m, dst);
      return dst.texture;
    },
  },

  /* Pixelate (overlay `pixelate`, real3d): flat blocks locked to the surface. */
  pixelate: {
    needs: () => ({ normal: true, pos: true }),
    spills: (p) => (p.grid || 0) > 1.5,
    run(renderer, res, ctx, fx, src, dst, p) {
      if ((p.grid || 0) > 1.5) return runVoxels(renderer, res, ctx, fx, src, dst, p);
      const m = passMaterial(res, 'pixelate3d');
      writeCellUniforms(m.uniforms, ctx, res, fx, src, {
        size: p.size, stretch: p.stretch, offsetX: p.offsetX, offsetY: p.offsetY,
        mode: p.grid > 0.5 ? 1 : 0, avg: p.sampling > 0.5 ? 0 : 1,
      });
      m.uniforms.uMix.value = p.__mix;
      drawPass(renderer, res, m, dst);
      return dst.texture;
    },
  },

  /* Pixel Matrix (overlay `crtMatrix`, real3d): sub-pixels on the surface cells. */
  crtMatrix: {
    needs: (p) => ({ normal: true, pos: true, pyramid: (p.glow || 0) > 0.5, light: (p.glow || 0) > 0.5 }),
    run(renderer, res, ctx, fx, src, dst, p) {
      const T = fx.targets;
      const m = passMaterial(res, 'crtMatrix3d');
      writeCellUniforms(m.uniforms, ctx, res, fx, src, { size: p.cellSize, mode: 0, avg: 0 });
      const u = m.uniforms;
      u.uMix.value = p.__mix;
      u.uDisplay.value = p.display || 0;
      u.uScan.value = (p.scanStrength || 0) / 100;
      u.uSub.value = (p.subpixel || 0) / 100;
      u.uSoft.value = (p.beamSoftness || 0) / 100;
      u.uFlicker.value = (p.flicker || 0) / 100;
      u.uRoll.value = (p.rollingBar || 0) / 100;
      u.uTime.value = ctx.time;
      if (!((p.glow || 0) > 0.5)) {
        drawPass(renderer, res, m, dst);
        return dst.texture;
      }
      // Glow: the panel's own light bleeding — the matrix result through the
      // pyramid, added back (no threshold, so it is an even phosphor glow).
      drawPass(renderer, res, m, T.light);
      const halo = blurPyramid(renderer, res, fx, T.light.texture, fx.w, fx.h);
      const add = passMaterial(res, 'addLight');
      add.uniforms.tColor.value = T.light.texture;
      add.uniforms.tLight.value = T.light.texture;
      add.uniforms.tHalo.value = halo;
      add.uniforms.uRes.value.set(fx.w, fx.h);
      add.uniforms.uHalo.value = (p.glow / 100) * 1.2;
      add.uniforms.uBase.value = 1;
      add.uniforms.uLight.value = 0;
      drawPass(renderer, res, add, dst);
      return dst.texture;
    },
  },

  /* Halftone (overlay `halftone`, real3d). */
  halftone: surfacePass('halftone3d', (u, ctx, res, fx, src, p) => {
    writeSurfUniforms(u, ctx, res, fx, src, p, p.cellSize);
    u.uPattern.value = p.pattern || 0;
    u.uAngle.value = (p.angle || 0) * D2R;
    u.uContrast.value = (p.contrast ?? 125) / 100;
    u.uChanRot.value = (p.channelRotation ?? 22) * D2R;
    u.uMisreg.value = p.misregistration || 0;
    u.uDrift.value = (p.patternDrift || 0) / 100;
    u.uInk.value.set(p.ink);
    u.uPaper.value.set(p.paper);
  }),

  /* Dither Print (overlay `objectDither`, real3d) — the model is the subject. */
  objectDither: surfacePass('dither3d', (u, ctx, res, fx, src, p) => {
    writeSurfUniforms(u, ctx, res, fx, src, p, (p.pitch || 6) * 2);
    u.uThreshold.value = (p.threshold ?? 52) / 100;
    u.uContrast.value = 0.5 + ((p.contrast ?? 55) / 100) * 2.5;
    u.uEdge.value = (p.edge ?? 30) / 100;
    u.uPaperAmt.value = (p.paperAmount ?? 100) / 100;
    u.uAlgo.value = p.algo || 0;
    u.uInk.value.set(p.ink);
    u.uPaper.value.set(p.paper);
    u.uInvProj.value.copy(ctx.cam.projectionMatrixInverse);
  }),

  /* ASCII (overlay `ascii`, real3d) — the flat effect's glyph atlas. */
  ascii: surfacePass('ascii3d', (u, ctx, res, fx, src, p) => {
    const atlas = getAsciiAtlas(p);
    if (!atlas) return false;
    writeSurfUniforms(u, ctx, res, fx, src, p, p.cellSize);
    u.tAtlas.value = atlas.texture;
    u.uN.value = atlas.n;
    u.uGw.value = atlas.gw;
    u.uRows.value = atlas.rows;
    u.uAspect.value = atlas.aspect;
    u.uColorMode.value = p.colorMode || 0;
    u.uBoost.value = (p.colorBoost ?? 60) / 100;
    u.uBg.value = p.background || 0;
    u.uSrcLevel.value = (p.sourceLevel ?? 20) / 100;
    u.uContrast.value = (p.contrast ?? 120) / 100;
    u.uBright.value = (p.brightness || 0) / 200;
    u.uDither.value = (p.dither ?? 60) / 100;
    u.uInvert.value = p.invert || 0;
    u.uGlyph.value.set(p.glyphColor);
    u.uLight.value.set(p.lightColor);
    u.uBgColor.value.set(p.backgroundColor);
  }),

  /* Fractal Noise (overlay `fractalNoise`, real3d) — 3D noise at the model's position. */
  fractalNoise: surfacePass('fractal3d', (u, ctx, res, fx, src, p) => {
    writeSurfUniforms(u, ctx, res, fx, src, p, (p.scale || 260) * 0.5);
    u.uType.value = p.type || 0;
    u.uOctaves.value = Math.max(1, Math.min(8, Math.round(p.octaves || 4)));
    u.uGain.value = p.gain ?? 0.55;
    u.uRidge.value = p.ridge ?? 2.5;
    u.uContrast.value = p.contrast ?? 1;
    u.uBright.value = p.brightness || 0;
    u.uFloor.value = p.floor ?? 0.35;
    u.uLightAmt.value = p.light || 0;
    u.uBlendMode.value = p.blend || 0;
    u.uInvertF.value = p.invert || 0;
    const t = ctx.time;
    const a = (p.driftAngle || 0) * D2R;
    const sp = (p.driftSpeed ?? 0.25) * t;
    u.uDrift.value.set(Math.cos(a) * sp, Math.sin(a) * sp, (p.churn ?? 1) * 0.15 * t);
    u.uShadow.value.set(p.colorShadow);
    u.uLightC.value.set(p.colorLight);
    const la = (p.lightAngle ?? 120) * D2R;
    u.uLightDir.value.set(Math.cos(la), Math.sin(la), 0.8).normalize();
  }),

  /* Fill (overlay `fill`, real3d) — shaded by the model's own light. */
  fill: surfacePass('fill3d', (u, ctx, res, fx, src, p) => {
    writeSurfUniforms(u, ctx, res, fx, src, p, 20);
    u.uFill.value.set(p.color);
    u.uBlendMode.value = p.blend || 0;
  }),

  /* Colorama (overlay `colorama`, real3d) — with Height / Depth / Facing inputs. */
  colorama: surfacePass('colorama3d', (u, ctx, res, fx, src, p) => {
    const m = writeSurfUniforms(u, ctx, res, fx, src, p, 20);
    u.tRamp.value = getRampTexture(sanitizeEffectGradient(p.ramp, p.ramp), p.interpolation || 0);
    u.uPosToView.value.copy(m.posToView);
    modelZRange(ctx, u.uZRange.value);
    u.uInvProj.value.copy(ctx.cam.projectionMatrixInverse);
    u.uInput.value = p.input || 0;
    u.uPhase.value = p.phase || 0;
    u.uCycle.value = p.cycle || 0;
    u.uRepeat.value = Math.max(1, p.repeat || 1);
    u.uPreserveLuma.value = (p.preserveLuma || 0) / 100;
    u.uPreserveAlpha.value = p.preserveAlpha ?? 1;
    u.uDither.value = (p.dither ?? 25) / 100;
    u.uBlendMode.value = p.blend || 0;
    u.uOriginal.value = (p.original || 0) / 100;
  }),

  /* Gradient Motion Beam (overlay `gradientBeam`, real3d) — a slab through the model. */
  gradientBeam: surfacePass('beam3d', (u, ctx, res, fx, src, p) => {
    writeSurfUniforms(u, ctx, res, fx, src, p, 20);
    u.uC1.value.set(p.color1); u.uC2.value.set(p.color2); u.uC3.value.set(p.color3);
    u.uSpeed.value = p.speed ?? 1;
    u.uAngle.value = (p.angle ?? 32) * D2R;
    u.uBlur.value = (p.blur ?? 62) / 100;
    u.uWidth.value = Math.max(0.02, (p.width ?? 48) / 100);
    u.uHold.value = p.hold ?? 1.4;
    u.uOpacity.value = (p.opacity ?? 75) / 100;
    u.uBlendMode.value = p.blend || 0;
    u.uType.value = p.type || 0;
    u.uKeepLayer.value = (p.layerMask ?? 100) / 100;
  }),

  /*
   * Gradient Sweep (overlay `gradientSweep`, real3d). The band's position is a
   * pure function of time (Duration, Easing, Loop + Loop Gap), so preview and
   * export agree. Glow runs the band light through the pyramid; 0 skips it.
   */
  gradientSweep: {
    needs: (p) => ({ normal: true, pos: true, light: (p.glow || 0) > 0.5, pyramid: (p.glow || 0) > 0.5 }),
    spills: (p) => (p.glow || 0) > 0.5,
    run(renderer, res, ctx, fx, src, dst, p) {
      const T = fx.targets;
      const m = passMaterial(res, 'sweep3d');
      const u = m.uniforms;
      writeSurfUniforms(u, ctx, res, fx, src, p, 20);
      const band = Math.max(0.02, ((p.bandWidth ?? 78) / Math.max(1, ctx.fitPx || 1080)) * 1.6);
      const dur = Math.max(0.1, p.duration ?? 1.4);
      const gap = Math.max(0, p.loopGap ?? 0.6);
      const t = (p.loop || 0) > 0.5 ? ctx.time % (dur + gap) : ctx.time;
      const pr = Math.min(1, Math.max(0, t / dur));
      const e = p.easing || 0;
      const eased = e < 0.5 ? 0.5 - 0.5 * Math.cos(Math.PI * pr) : e < 1.5 ? pr : e < 2.5 ? pr * pr * (3 - 2 * pr) : 1 - (1 - pr) ** 3;
      u.uFront.value = -band * 1.5 + (1 + band * 3) * eased;
      u.uBand.value = band;
      u.uCoreW.value = (p.coreWidth ?? 20) / 20;
      u.uMode.value = p.mode || 0;
      u.uAngle.value = (p.angle ?? 14) * D2R;
      u.uStrength.value = (p.bandStrength ?? 100) / 100;
      u.uBlendMode.value = p.blend || 0;
      u.uCoolFill.value = (p.coolFill ?? 34) / 100;
      u.uDim.value = (p.dimOutside ?? 45) / 100;
      u.uSheenFade.value = p.sheenFade ?? 0.5;
      u.uStrokeOp.value = (p.strokeOpacity ?? 90) / 100;
      u.uStrokeW.value = ((p.strokeWidth ?? 3.2) / 14) * 0.5;
      u.uCore.value.set(p.colorCore); u.uWarm.value.set(p.colorWarm); u.uHot.value.set(p.colorHot);
      u.uCool.value.set(p.colorCool); u.uDeep.value.set(p.colorDeep); u.uStroke.value.set(p.strokeColor);
      u.uInvProj.value.copy(ctx.cam.projectionMatrixInverse);
      let halo = null;
      if ((p.glow || 0) > 0.5) {
        u.uStage.value = 0;
        drawPass(renderer, res, m, T.light);
        halo = blurPyramid(renderer, res, fx, T.light.texture, fx.w, fx.h);
      }
      u.uStage.value = 1;
      u.tLight.value = halo || src;
      u.tHalo.value = halo || src;
      u.uGlow.value = halo ? (p.glow / 100) * 1.4 : 0;
      drawPass(renderer, res, m, dst);
      return dst.texture;
    },
  },

  /* Contour Studio (overlay `objectContour`, real3d) — lines by real height / around the body. */
  objectContour: surfacePass('contour3d', (u, ctx, res, fx, src, p) => {
    writeSurfUniforms(u, ctx, res, fx, src, p, 20);
    u.uMethod.value = p.method || 0;
    u.uLevels.value = p.levels ?? 14;
    u.uDetail.value = (p.detail ?? 60) / 100;
    u.uWeight.value = (p.weight ?? 1) * 1.5;
    u.uDensity.value = p.density ?? 120;
    u.uDrift.value = ((p.drift || 0) / 100) * 0.5;
    u.uInk.value.set(p.ink);
    u.uAccent.value.set(p.accent);
  }),

  /*
   * Spectral Curtain (overlay `objectCurtain`, real3d) — streaks along the
   * model's own down, projected to the frame this frame.
   */
  objectCurtain: {
    needs: () => ({ pos: true }),
    spills: true,
    run(renderer, res, ctx, fx, src, dst, p) {
      const m = passMaterial(res, 'curtain3d');
      const u = m.uniforms;
      const mats = surfaceMatrices(ctx, res);
      const a = new THREE.Vector4(0, 0, 0, 1).applyMatrix4(mats.posToClip);
      const b = new THREE.Vector4(0, -0.5, 0, 1).applyMatrix4(mats.posToClip);
      const dx = (b.x / b.w - a.x / a.w) * fx.w, dy = (b.y / b.w - a.y / a.w) * fx.h;
      const len = Math.hypot(dx, dy) || 1;
      u.uFall.value.set(dx / len, dy / len);
      u.tColor.value = src;
      u.uRes.value.set(fx.w, fx.h);
      u.uMix.value = p.__mix;
      u.uDir.value = p.dir || 0;
      u.uDensity.value = p.density ?? 400;
      u.uLength.value = ((p.length ?? 19) / 100) * fx.h;
      u.uColW.value = Math.max(1, (p.width ?? 6) * (fx.h / 1080));
      u.uThreshold.value = (p.threshold ?? 18) / 100;
      u.uColorMode.value = p.colorMode || 0;
      u.uTint.value.set(p.tint);
      drawPass(renderer, res, m, dst);
      return dst.texture;
    },
  },

  /*
   * Bloom (overlay `bloom`, real3d) — from the model's HDR light (bloomBright3d
   * → pyramid → bloom3d). Radius picks the pyramid depth; Intensity 0 skips it.
   */
  bloom: {
    needs: () => ({ light: true, pyramid: true }),
    spills: true,
    run(renderer, res, ctx, fx, src, dst, p) {
      const T = fx.targets;
      const gain = (p.intensity ?? 100) / 100;
      if (!(gain > 0)) return src;
      const br = passMaterial(res, 'bloomBright3d');
      br.uniforms.tColor.value = src;
      br.uniforms.uRes.value.set(fx.w, fx.h);
      br.uniforms.uThr.value = Math.min(0.99, Math.max(0, p.threshold ?? 0.62));
      br.uniforms.uKnee.value = Math.min(1, Math.max(0.01, p.knee ?? 0.5));
      br.uniforms.uExposure.value = Number.isFinite(ctx.exposure) ? ctx.exposure : 1;
      drawPass(renderer, res, br, T.light);
      const levels = Math.max(2, Math.min(PYRAMID_LEVELS, Math.round((p.radius ?? 3) + 1)));
      const bloomTex = blurPyramid(renderer, res, fx, T.light.texture, fx.w, fx.h, levels);
      const m = passMaterial(res, 'bloom3d');
      const u = m.uniforms;
      u.tColor.value = src;
      u.tBloom.value = bloomTex;
      u.tStreak.value = T.down1.texture;
      u.uRes.value.set(fx.w, fx.h);
      u.uMix.value = p.__mix;
      u.uGain.value = gain * 1.5;
      u.uSat.value = (p.saturation ?? 100) / 100;
      u.uTint.value.set(p.tint || '#ffffff');
      u.uTintAmt.value = Math.min(1, Math.max(0, (p.tintAmount ?? 0) / 100));
      u.uAnamorph.value = Math.min(1, Math.max(-1, (p.anamorphic ?? 0) / 100));
      u.uBlendMode.value = p.blend || 0;
      drawPass(renderer, res, m, dst);
      return dst.texture;
    },
  },

  /* Flash Blink (overlay `flashBlink`, real3d) — the flash is a light from Light From. */
  flashBlink: {
    needs: () => ({ normal: true }),
    run(renderer, res, ctx, fx, src, dst, p) {
      const m = passMaterial(res, 'flash3d');
      const u = m.uniforms;
      u.tColor.value = src;
      u.tN.value = fx.targets.gN.texture;
      u.uRes.value.set(fx.w, fx.h);
      u.uMix.value = p.__mix;
      u.uTime.value = ctx.time;
      u.uSpeed.value = p.speed ?? 3;
      u.uMode.value = p.mode || 0;
      u.uStyle.value = p.style ?? 2;
      u.uDuty.value = (p.duty ?? 50) / 100;
      u.uSoft.value = (p.softness ?? 15) / 100;
      u.uFlash.value.set(p.color || '#ffffff');
      const az = (p.lightAngle ?? 135) * D2R, el = 25 * D2R;
      u.uLightDir.value.set(Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)).normalize();
      drawPass(renderer, res, m, dst);
      return dst.texture;
    },
  },

  /*
   * Light Rays (overlay `lightRays`, real3d). Origin X/Y sit across the
   * model's box in its own space (Y up, as the flat layer box), so the
   * source turns and travels with the model; Behind puts a light disc behind
   * the body. Softness blurs the rays through the pyramid.
   */
  lightRays: {
    needs: (p) => ({ pos: true, light: true, aux: true, pyramid: (p.softness ?? 6) >= 0.5 }),
    spills: true,
    run(renderer, res, ctx, fx, src, dst, p) {
      const T = fx.targets;
      const mats = surfaceMatrices(ctx, res);
      ctx.entry.box.getSize(_size);
      const sc = res.posUniforms.uFxScale.value;
      const source = p.source || 0;
      const behind = source > 2.5;
      _cornerClip.set(
        ((p.originX ?? 0.5) - 0.5) * _size.x * sc,
        ((p.originY ?? 0.85) - 0.5) * _size.y * sc,
        behind ? -0.5 * _size.z * sc - 0.15 : 0,
        1,
      ).applyMatrix4(mats.posToClip);
      const w = Math.abs(_cornerClip.w) > 1e-6 ? _cornerClip.w : 1e-6;
      const ox = _cornerClip.x / w * 0.5 + 0.5, oy = _cornerClip.y / w * 0.5 + 0.5;
      const em = passMaterial(res, 'raysEmit3d');
      em.uniforms.tColor.value = src;
      em.uniforms.uRes.value.set(fx.w, fx.h);
      em.uniforms.uSource.value = source;
      em.uniforms.uThr.value = (p.threshold ?? 40) / 100;
      // Behind: a small hot disc, so the rays read as streaks escaping the body.
      em.uniforms.uDisc.value = 0.03 + 0.04 * Math.min(1, (p.sourceLevel ?? 100) / 100);
      em.uniforms.uOrigin.value.set(ox, oy);
      drawPass(renderer, res, em, T.light);
      const mr = passMaterial(res, 'raysMarch3d');
      mr.uniforms.tSrc.value = T.light.texture;
      mr.uniforms.uRes.value.set(fx.w, fx.h);
      mr.uniforms.uOrigin.value.set(ox, oy);
      mr.uniforms.uLen.value = (p.length ?? 55) / 100;
      mr.uniforms.uTaps.value = Math.max(8, Math.floor(48 * Math.min(p.density ?? 1, 1) + 0.5));
      mr.uniforms.uDecay.value = (p.decay ?? 55) / 100;
      drawPass(renderer, res, mr, T.aux);
      const soft = p.softness ?? 6;
      const rays = soft >= 0.5 ? blurPyramid(renderer, res, fx, T.aux.texture, fx.w, fx.h, levelsForPx(soft * (fx.h / 1080))) : T.aux.texture;
      const cm = passMaterial(res, 'raysComp3d');
      const u = cm.uniforms;
      u.tColor.value = src;
      u.tRays.value = rays;
      u.uRes.value.set(fx.w, fx.h);
      u.uMix.value = p.__mix;
      let expo = (p.exposure ?? 120) / 100;
      const flick = (p.flicker || 0) / 100;
      if (flick > 0.001) expo *= 1 - flick * 0.65 * hashJs(Math.floor(ctx.time * 24), 7);
      u.uExpo.value = expo;
      u.uSrcLevel.value = behind ? 1 : (p.sourceLevel ?? 100) / 100;
      u.uOcclude.value = source < 0.5 || behind ? 1 : 0;
      u.uRayColor.value.set(p.rayColor || '#ffe9c4');
      drawPass(renderer, res, cm, dst);
      return dst.texture;
    },
  },

  /*
   * Neon Glow (overlay `neonGlow`, real3d) — the model's real outline and
   * creases, a light running around them (laps per second = Speed).
   */
  neonGlow: {
    needs: (p) => ({ normal: true, pos: true, light: true, pyramid: (p.pathGlowRadius ?? 30) > 0.5 }),
    spills: true,
    run(renderer, res, ctx, fx, src, dst, p) {
      const T = fx.targets;
      const m = passMaterial(res, 'neon3d');
      const u = m.uniforms;
      const mats = writeSurfUniforms(u, ctx, res, fx, src, p, 20);
      u.uPosToView.value.copy(mats.posToView);
      modelZRange(ctx, u.uZRange.value);
      const box = modelScreenBox(ctx, res, mats);
      u.uCenter.value.set(box.cx, box.cy);
      const k = fx.h / 1080;
      u.uCorePx.value = Math.max(0.75, (p.pathCoreSize ?? 3) * k * 0.5);
      const speed = p.pathSpeed ?? 0.35;
      const ts = Math.min(1, Math.max(0, Math.min(p.pathTrimStart ?? 0, p.pathTrimEnd ?? 100) / 100));
      const te = Math.min(1, Math.max(ts + 0.005, Math.max(p.pathTrimStart ?? 0, p.pathTrimEnd ?? 100) / 100));
      const trail = Math.min(1, Math.max(0.01, (p.pathTrail ?? 40) / 100));
      const phase = speed * ctx.time;
      u.uHead.value = Math.abs(speed) < 1e-4 ? 1 : phase - Math.floor(phase);
      u.uTrail.value = trail;
      u.uTrimS.value = ts;
      u.uTrimE.value = te;
      u.uFull.value = te - ts >= 0.999 && trail >= 0.995 ? 1 : 0;
      u.uIntensity.value = ((p.pathIntensity ?? 100) / 100) * 1.6;
      u.uHue.value = (p.pathHueCycle || 0) * ctx.time * D2R;
      u.uGlow.value.set(p.pathColor1 || '#ff00ff');
      drawPass(renderer, res, m, T.light);
      const glowPx = (p.pathGlowRadius ?? 30) * k;
      const halo = glowPx > 0.5 ? blurPyramid(renderer, res, fx, T.light.texture, fx.w, fx.h, levelsForPx(glowPx)) : null;
      return glowComposite(renderer, res, fx, src, dst, p, halo, (p.pathSourceLevel ?? 100) / 100);
    },
  },

  /*
   * Lines Draw (overlay `linesDraw`, real3d) — the flat runner (lap, profile,
   * direction, width from speed: linesDrawRunnerState) on the model's outline.
   */
  linesDraw: {
    needs: (p) => ({ normal: true, pos: true, light: true, pyramid: (p.ldGlow ?? 20) > 0.5 }),
    spills: true,
    run(renderer, res, ctx, fx, src, dst, p) {
      const T = fx.targets;
      const m = passMaterial(res, 'lines3d');
      const u = m.uniforms;
      u.tColor.value = src;
      u.tN.value = T.gN.texture;
      u.uRes.value.set(fx.w, fx.h);
      u.uMix.value = p.__mix;
      u.uTime.value = ctx.time;
      const mats = surfaceMatrices(ctx, res);
      const box = modelScreenBox(ctx, res, mats);
      u.uCenter.value.set(box.cx, box.cy);
      const run = linesDrawRunnerState(p, ctx.time, true);
      const k = fx.h / 1080;
      const lines = Math.max(1, Math.min(8, Math.round(p.ldLines ?? 4)));
      u.uLines.value = lines;
      u.uHead.value = run.pathPhase;
      u.uDirSign.value = run.pathAux < 0 ? -1 : 1;
      u.uWf.value = Math.abs(run.pathAux);
      u.uTrail.value = Math.min(1, Math.max(0.05, (p.ldTrail ?? 35) / 100));
      u.uWidthPx.value = Math.max(0.75, (p.ldWidth ?? 14) * k * 0.5);
      u.uMinW.value = (p.ldMinWidth ?? 6) / 100;
      u.uTaper.value = p.ldTaper ?? 0.12;
      u.uSpreadPx.value = (p.ldSpread ?? 16) * k * 0.5;
      u.uLag.value = ((p.ldLag || 0) / 100) * (u.uTrail.value / lines);
      u.uHeadBright.value = (p.ldHeadBright ?? 30) / 100;
      u.uIntensity.value = ((p.ldIntensity ?? 100) / 100) * 1.4;
      u.uC1.value.set(p.ldColor1 || '#00ff88');
      u.uC2.value.set(p.ldColor2 || '#88ff00');
      u.uC3.value.set(p.ldColor3 || '#44ff88');
      drawPass(renderer, res, m, T.light);
      const glowPx = (p.ldGlow ?? 20) * k;
      const halo = glowPx > 0.5 ? blurPyramid(renderer, res, fx, T.light.texture, fx.w, fx.h, levelsForPx(glowPx)) : null;
      return glowComposite(renderer, res, fx, src, dst, p, halo, (p.ldSourceLevel ?? 100) / 100);
    },
  },

  /*
   * Edge Detect (overlay `edgeDetect`, real3d) — edges of the geometry
   * (edge3d), glow through the pyramid, blended by edgeComp3d.
   */
  edgeDetect: {
    needs: (p) => ({ normal: true, pos: true, light: true, pyramid: (p.glowInt ?? 80) > 0.5 }),
    spills: true,
    run(renderer, res, ctx, fx, src, dst, p) {
      const T = fx.targets;
      const m = passMaterial(res, 'edge3d');
      const u = m.uniforms;
      const mats = writeSurfUniforms(u, ctx, res, fx, src, p, 20);
      u.uPosToView.value.copy(mats.posToView);
      modelZRange(ctx, u.uZRange.value);
      const box = modelScreenBox(ctx, res, mats);
      u.uCenter.value.set(box.cx, box.cy);
      u.uHalf.value.set(box.hx, box.hy);
      const k = fx.h / 1080;
      u.uMethod.value = p.method || 0;
      u.uThr.value = (p.threshold ?? 12) / 100;
      u.uKnee.value = (p.knee ?? 35) / 100;
      u.uLow.value = (p.lowRatio ?? 40) / 100;
      u.uThick.value = (p.thickness || 0) * k;
      u.uGain.value = (p.gain ?? 100) / 100;
      u.uColorMode.value = p.colorMode || 0;
      u.uInvert.value = p.invert || 0;
      u.uBands.value = p.bands ?? 8;
      u.uSigma.value = Math.max(0.5, (p.dogSigma ?? 1) * 2 * k);
      u.uK.value = p.dogK ?? 1.6;
      u.uTau.value = p.dogTau ?? 15;
      u.uPhi.value = p.dogPhi ?? 25;
      u.uEps.value = (p.dogEps || 0) * 0.002;
      const anim = p.animMode || 0;
      const spd = Math.max(0.01, p.animSpeed ?? 1);
      u.uAnim.value = anim;
      u.uSpd.value = spd;
      u.uProgress.value = p.__progress || 0;
      u.uSweepAngle.value = (p.sweepAngle || 0) * D2R;
      u.uSweepSoft.value = (p.sweepSoft ?? 10) / 100;
      u.uEdgeA.value.set(p.edgeColor || '#ffffff');
      u.uEdgeB.value.set(p.edgeColor2 || '#3d8dff');
      drawPass(renderer, res, m, T.light);
      const glowInt = (p.glowInt ?? 80) / 100;
      const halo = glowInt > 0.005
        ? blurPyramid(renderer, res, fx, T.light.texture, fx.w, fx.h, levelsForPx((p.glowRad ?? 12) * k))
        : null;
      const c = passMaterial(res, 'edgeComp3d');
      const cu = c.uniforms;
      cu.tColor.value = src;
      cu.tLight.value = T.light.texture;
      cu.tHalo.value = halo || T.light.texture;
      cu.uRes.value.set(fx.w, fx.h);
      cu.uMix.value = p.__mix;
      cu.uSrcLevel.value = (p.sourceLevel ?? 0) / 100;
      const pulse = anim > 3.5 && anim < 4.5 ? 0.55 + 0.45 * Math.sin(ctx.time * 3.5 * spd) : 1;
      cu.uGlow.value = halo ? glowInt * 1.2 * pulse : 0;
      cu.uBlendMode.value = p.blend || 0;
      drawPass(renderer, res, c, dst);
      return dst.texture;
    },
  },

  /*
   * Aura Blur (overlay `auraBlur`, real3d) — one pyramid of the model's own
   * picture: its second level is the narrow blur (the melted core, the halo's
   * inner colour), its top the wide halo. Blur Size picks the depth.
   */
  auraBlur: {
    needs: () => ({ pos: true, pyramid: true }),
    spills: true,
    run(renderer, res, ctx, fx, src, dst, p) {
      const T = fx.targets;
      const k = fx.h / 1080;
      const levels = Math.max(2, levelsForPx((p.blurSize ?? 60) * 0.35 * k));
      const wide = blurPyramid(renderer, res, fx, src, fx.w, fx.h, levels);
      const m = passMaterial(res, 'aura3d');
      const u = m.uniforms;
      const mats = surfaceMatrices(ctx, res);
      const box = modelScreenBox(ctx, res, mats);
      u.tColor.value = src;
      u.tP.value = T.gP.texture;
      u.tNarrow.value = T.down1.texture;
      u.tWide.value = wide;
      u.uRes.value.set(fx.w, fx.h);
      u.uMix.value = p.__mix;
      u.uTime.value = ctx.time;
      u.uCenter.value.set(box.cx, box.cy);
      u.uCL.value.set(p.colorL || '#d9c7dd');
      u.uCM.value.set(p.colorM || '#d9c7dd');
      u.uCR.value.set(p.colorR || '#d9c7dd');
      u.uHI.value.set(p.haloInner || '#f19be0');
      u.uHO.value.set(p.haloOuter || '#3d5ef5');
      u.uGradL.value = (p.gradientLeft ?? 16) / 100;
      u.uGradR.value = (p.gradientRight ?? 94) / 100;
      u.uMelt.value = (p.coreSoft ?? p.melt ?? 100) / 100;
      u.uBase.value = (p.blurBase ?? 46) / 100;
      u.uVary.value = (p.blurVary ?? 48) / 100;
      u.uVaryScale.value = p.varyScale ?? 6;
      u.uFlow.value = p.flowSpeed ?? 0.35;
      u.uChroma.value = (p.chroma ?? 41) / 100;
      u.uHaloLevel.value = (p.haloLevel ?? 130) / 100;
      u.uShiftPx.value = ((p.microShift ?? 30) / 100) * 6 * k;
      u.uBreath.value = 1 + ((p.breathe ?? 6) / 100) * Math.sin(2 * Math.PI * (p.breatheRate ?? 0.4) * ctx.time);
      u.uCoreLevel.value = (p.coreLevel ?? 115) / 100;
      u.uSrcMode.value = p.sourceMode || 0;
      u.uSrcThr.value = (p.sourceThreshold || 0) / 100;
      drawPass(renderer, res, m, dst);
      return dst.texture;
    },
  },

  /* Digital Glitch (overlay `glitch`, real3d) — tears in the model's own frame. */
  glitch: {
    needs: () => ({ pos: true }),
    spills: true,
    run(renderer, res, ctx, fx, src, dst, p) {
      const m = passMaterial(res, 'glitch3d');
      const u = m.uniforms;
      const ax = modelScreenAxes(surfaceMatrices(ctx, res), fx);
      const k = fx.h / 1080;
      u.tColor.value = src;
      u.uRes.value.set(fx.w, fx.h);
      u.uMix.value = p.__mix;
      u.uTime.value = ctx.time;
      u.uCenterPx.value.set(ax.c[0], ax.c[1]);
      const up = unit2(ax.y);
      u.uUp.value.set(up[0], up[1]);
      u.uAxX.value.set(ax.x[0], ax.x[1]);
      u.uAxZ.value.set(ax.z[0], ax.z[1]);
      u.uAmt.value = p.amount ?? 0.5;
      u.uBlk.value = Math.max(2, (p.blockSize ?? 24) * k);
      u.uSpeed.value = p.speed ?? 4;
      u.uShift.value = (p.colorShift ?? 8) * k;
      drawPass(renderer, res, m, dst);
      return dst.texture;
    },
  },

  /* Slit Scan (overlay `objectSlitScan`, real3d) — strips across the model's own axes. */
  objectSlitScan: {
    needs: () => ({ normal: true, pos: true }),
    spills: true,
    run(renderer, res, ctx, fx, src, dst, p) {
      const m = passMaterial(res, 'slit3d');
      const u = m.uniforms;
      const ax = modelScreenAxes(surfaceMatrices(ctx, res), fx);
      const vertical = (p.dir ?? 1) < 0.5;
      const across = unit2(vertical ? ax.x : ax.y);
      // The slide runs square to the cut (an exact split of the offset), on the
      // side of the model's own axis.
      const ref = vertical ? ax.y : ax.x;
      const sgn = -across[1] * ref[0] + across[0] * ref[1] >= 0 ? 1 : -1;
      const along = [-across[1] * sgn, across[0] * sgn];
      const frameHalf = (d) => (Math.abs(d[0]) * fx.w + Math.abs(d[1]) * fx.h) / 2;
      const extA = frameHalf(across);
      const k = fx.h / 1080;
      u.tColor.value = src;
      u.tN.value = fx.targets.gN.texture;
      u.uRes.value.set(fx.w, fx.h);
      u.uMix.value = p.__mix;
      u.uTime.value = ctx.time;
      u.uCenterPx.value.set(ax.c[0], ax.c[1]);
      u.uAcross.value.set(across[0], across[1]);
      u.uAlong.value.set(along[0], along[1]);
      u.uExtA.value = extA;
      u.uExtB.value = frameHalf(along);
      u.uCount.value = p.count ?? 84;
      u.uShift.value = (p.shift ?? 3.5) / 100;
      u.uDrive.value = p.drive ?? 1;
      u.uHold.value = (p.hold ?? 61) / 100;
      u.uGap.value = ((p.gap ?? 5) * k) / Math.max(1, extA * 2);
      u.uWave.value = p.waveSpeed ?? 1.6;
      u.uSeed.value = p.seed ?? 7;
      drawPass(renderer, res, m, dst);
      return dst.texture;
    },
  },

  /* Pixel Stretch (overlay `pixelStretch`, real3d) — streaks along the model's own axes. */
  pixelStretch: {
    needs: () => ({ pos: true }),
    spills: true,
    run(renderer, res, ctx, fx, src, dst, p) {
      const m = passMaterial(res, 'stretch3d');
      const u = m.uniforms;
      const ax = modelScreenAxes(surfaceMatrices(ctx, res), fx);
      const mode = p.direction ?? 1;
      const dir = unit2(mode < 0.5 ? ax.x : ax.y);
      const k = fx.h / 1080;
      const anim = p.animate || 0;
      const a = ctx.time * anim / 100;
      u.tColor.value = src;
      u.uRes.value.set(fx.w, fx.h);
      u.uMix.value = p.__mix;
      u.uTime.value = ctx.time;
      u.uExposure.value = Number.isFinite(ctx.exposure) ? ctx.exposure : 1;
      u.uCenterPx.value.set(ax.c[0], ax.c[1]);
      u.uDirA.value.set(dir[0], dir[1]);
      u.uMode.value = mode;
      u.uLo.value = Math.min(1, Math.max(0, (p.thresholdLow ?? 35) / 100 + Math.sin(a * 2 * Math.PI) * anim / 600));
      u.uHi.value = Math.min(1, Math.max(0, (p.thresholdHigh ?? 100) / 100));
      u.uSpan.value = (p.span ?? 240) * k;
      u.uJitter.value = (p.jitter ?? 40) / 100;
      u.uBand.value = Math.max(1, (p.bandSize ?? 3) * k);
      u.uFlip.value = p.flip || 0;
      drawPass(renderer, res, m, dst);
      return dst.texture;
    },
  },

  /*
   * Shape Rulers (overlay `shapeRulers`, real3d) — the model's 3D box. Spacing
   * grows the box (composition px at the model's scale); Rotation: Frame-
   * aligned draws the projection's 2D bounds, like the flat effect.
   */
  shapeRulers: {
    needs: () => ({ pos: true }),
    spills: true,
    run(renderer, res, ctx, fx, src, dst, p) {
      const m = passMaterial(res, 'rulers3d');
      const u = m.uniforms;
      const mats = surfaceMatrices(ctx, res);
      const ax = modelScreenAxes(mats, fx);
      const k = Math.min(fx.w, fx.h) / 1080;
      const fitPx = Math.max(1, ctx.fitPx || ctx.H || 1080);
      const compK = (ctx.H || 1080) / 1080;
      ctx.entry.box.getSize(_size);
      const sc = res.posUniforms.uFxScale.value;
      const hx = _size.x * sc * 0.5 + ((p.spacingX || 0) * compK) / fitPx;
      const hy = _size.y * sc * 0.5 + ((p.spacingY || 0) * compK) / fitPx;
      const hz = _size.z * sc * 0.5 + ((p.spacingX || 0) * compK) / fitPx;
      const C = [];
      for (let i = 0; i < 8; i += 1) C.push(ax.toPx(i & 1 ? hx : -hx, i & 2 ? hy : -hy, i & 4 ? hz : -hz));
      const seg = u.uSeg.value;
      const cor = u.uCor.value;
      seg.fill(0);
      cor.fill(0);
      if ((p.rotation ?? 1) > 0.5) {
        // Which box faces look at the camera (view space): an edge is drawn in
        // front when either face it borders does.
        const faceFront = {};
        for (const [axis, sign] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
          const c = [0, 0, 0];
          c[axis] = sign * [hx, hy, hz][axis];
          const n = [0, 0, 0];
          n[axis] = sign;
          const pc = new THREE.Vector3(...c).applyMatrix4(mats.posToView);
          const pn = new THREE.Vector3(c[0] + n[0] * 0.01, c[1] + n[1] * 0.01, c[2] + n[2] * 0.01).applyMatrix4(mats.posToView).sub(pc);
          faceFront[`${axis}${sign}`] = pn.dot(pc) < 0;
        }
        let e = 0;
        for (let a = 0; a < 8; a += 1) {
          for (const bit of [1, 2, 4]) {
            if (a & bit) continue;
            const b = a | bit;
            const axis = bit === 1 ? 0 : bit === 2 ? 1 : 2;
            const others = [0, 1, 2].filter((q) => q !== axis);
            const front = others.some((q) => faceFront[`${q}${(a & (1 << q)) ? 1 : -1}`]);
            seg.set([C[a][0], C[a][1], C[b][0], C[b][1], front ? 1 : 0], e * 5);
            e += 1;
          }
        }
        C.forEach((q, i) => { cor[i * 2] = q[0]; cor[i * 2 + 1] = q[1]; });
        u.uCorners.value = 8;
      } else {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const q of C) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
        const R = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        for (let i = 0; i < 4; i += 1) {
          const a = R[i], b = R[(i + 1) % 4];
          seg.set([a[0], a[1], b[0], b[1], 1], i * 5);
          cor[i * 2] = a[0]; cor[i * 2 + 1] = a[1];
        }
        u.uCorners.value = 4;
      }
      u.tColor.value = src;
      u.uRes.value.set(fx.w, fx.h);
      u.uMix.value = p.__mix;
      u.uCenterPx.value.set(ax.c[0], ax.c[1]);
      const extend = p.extend || 0;
      u.uLw.value = (p.lineWidth ?? 1.5) * k;
      u.uExt.value = extend < 0.5 ? 1e6 : (extend < 1.5 ? (p.extendLength ?? 90) * k : 0);
      u.uDash.value = (p.dash || 0) * k;
      u.uShape.value = p.markShape || 0;
      u.uMarkHs.value.set(Math.max(0.25, (p.markWidth ?? 15) * 0.5 * k), Math.max(0.25, (p.markHeight ?? 15) * 0.5 * k));
      u.uMarkR.value = (p.markRadius ?? 1) * k;
      u.uMarkT.value = Math.max(0.25, (p.markStroke ?? 2.5) * k);
      u.uMid.value = p.midMarks || 0;
      u.uLineOp.value = Math.min(1, Math.max(0, (p.lineOpacity ?? 90) / 100));
      u.uLineC.value.set(p.lineColor || '#ffffff');
      u.uMarkC.value.set(p.markColor || '#ffffff');
      drawPass(renderer, res, m, dst);
      return dst.texture;
    },
  },

  /* Curves (overlay `curves`, real3d) — on the model's light, in tone space. */
  curves: {
    needs: () => ({}),
    run(renderer, res, ctx, fx, src, dst, p) {
      const m = passMaterial(res, 'curves3d');
      m.uniforms.tColor.value = src;
      m.uniforms.tLUT.value = getCurvesTexture(p.curves);
      m.uniforms.uRes.value.set(fx.w, fx.h);
      m.uniforms.uMix.value = p.__mix;
      drawPass(renderer, res, m, dst);
      return dst.texture;
    },
  },

  /*
   * Depth Scan (layer effect `depthScan`) on a model: the slice through EXACT
   * depth. scnSpace 0 = distance from the camera across the model's own depth
   * range (its box's nearest and farthest corners this frame); 1–3 = a plane
   * along the model's X / Y / Z.
   */
  depthScan: {
    needs: () => ({ pos: true }),
    run(renderer, res, ctx, fx, src, dst, p) {
      const T = fx.targets;
      const m = passMaterial(res, 'depthScan3d');
      const u = m.uniforms;
      const mats = surfaceMatrices(ctx, res);
      u.tColor.value = src;
      u.tP.value = T.gP.texture;
      u.tRamp.value = getRampTexture(sanitizeEffectGradient(p.scnRamp, p.scnRamp), 0);
      u.uRes.value.set(fx.w, fx.h);
      u.uPosToView.value.copy(mats.posToView);
      u.uSpace.value = p.scnSpace || 0;
      modelZRange(ctx, u.uZRange.value);
      u.uPhase.value = p.__phase || 0;
      u.uWidth.value = p.scnWidth / 100;
      u.uSplit.value = p.scnSplit / 100;
      u.uFeather.value = p.scnFeather / 100;
      u.uGrain.value = p.scnGrain / 100;
      u.uGamma.value = p.scnGamma;
      u.uLow.value = p.scnLow / 100;
      u.uHigh.value = p.scnHigh / 100;
      u.uColorMode.value = p.scnColorMode;
      u.uColor.value.set(p.scnColor);
      u.uBrightness.value = p.scnBrightness / 100;
      u.uSourceMix.value = p.scnSource / 100;
      u.uAmount.value = Math.max(0, Math.min(1, p.scnAmount / 100));
      drawPass(renderer, res, m, dst);
      return dst.texture;
    },
  },

  /*
   * Fresnel Rim (layer effect `fresnelRim`, model branch). Rim light from the
   * normal buffer, then its OWN halo: the rim alone through the blur pyramid, so
   * the glow is even along the whole line. Halo 0 skips the pyramid outright.
   */
  fresnelRim: {
    needs: (p) => ({ normal: true, light: true, pyramid: p.frHalo > 0.001 }),
    spills: (p) => p.frHalo > 0.001,
    run(renderer, res, ctx, fx, src, dst, p) {
      const T = fx.targets;
      const rim = passMaterial(res, 'rim');
      const u = rim.uniforms;
      u.tN.value = T.gN.texture;
      u.uRes.value.set(fx.w, fx.h);
      u.uInvProj.value.copy(ctx.cam.projectionMatrixInverse);
      u.uColorA.value.set(p.frColorA);
      u.uColorB.value.set(p.frColorB);
      u.uIntensity.value = p.frIntensity;
      u.uPower.value = THREE.MathUtils.lerp(8, 0.8, p.frWidth / 100);
      u.uSoft.value = THREE.MathUtils.lerp(0.02, 1, p.frSoftness / 100);
      const a = THREE.MathUtils.degToRad(p.frAngle);
      u.uDir.value.set(Math.cos(a), Math.sin(a));
      u.uDirMix.value = p.frDirMix / 100;
      u.uPulse.value = p.frPulse / 100;
      u.uTime.value = ctx.time;
      drawPass(renderer, res, rim, T.light);
      const halo = p.frHalo > 0.001 ? blurPyramid(renderer, res, fx, T.light.texture, fx.w, fx.h) : null;
      const add = passMaterial(res, 'addLight');
      add.uniforms.tColor.value = src;
      add.uniforms.tLight.value = T.light.texture;
      add.uniforms.tHalo.value = halo || T.light.texture;
      add.uniforms.uRes.value.set(fx.w, fx.h);
      add.uniforms.uHalo.value = halo ? p.frHalo : 0;
      // Body Light dims the model's own light under the rim (the lab's Base
      // light), eased back to untouched with Amount.
      const amt = Math.max(0, Math.min(1, (p.frAmount ?? 100) / 100));
      add.uniforms.uBase.value = 1 - (1 - Math.max(0, Math.min(1, (p.frBody ?? 100) / 100))) * amt;
      add.uniforms.uLight.value = 1;
      drawPass(renderer, res, add, dst);
      return dst.texture;
    },
  },
};

/** Whether this module renders the given effect id on a model layer. */
export function modelFxSupports(id) {
  return Object.prototype.hasOwnProperty.call(EFFECTS, id);
}

/**
 * Run a layer's live 3D effects on its freshly rendered HDR target.
 *
 * `list` is [{ id, params, mix }] in stack order, already resolved for this frame
 * by the caller (Player via renderModelLayer). Returns the texture the tone pass
 * should read, or null to leave the HDR target as it is (nothing live, or the
 * backend twin still loading — the frame then draws plain and repaints).
 */
export function runModelFx(renderer, entry, ctx) {
  const list = (ctx.list || []).filter((e) => EFFECTS[e.id]);
  if (!list.length) { releaseModelFx(entry); return null; }
  if (!modelFxReady()) return null;
  const w = entry.hdr.width;
  const h = entry.hdr.height;
  const needs = { normal: false, pos: false, light: false, aux: false, pyramid: false, copies: false };
  for (const e of list) {
    const n = EFFECTS[e.id].needs(e.params || {});
    for (const k of Object.keys(needs)) needs[k] = needs[k] || !!n[k];
  }
  const fx = ensureTargets(entry, w, h, needs);
  // Light past the silhouette (a halo, a parallax copy, a streak) has no surface
  // depth; the model pass reads this to give it one (see modelSpillDepth).
  fx.spill = list.some((e) => {
    const s = EFFECTS[e.id].spills;
    return typeof s === 'function' ? !!s(e.params || {}) : !!s;
  });
  const res = resourcesFor(renderer);
  const run = { ...ctx, entry };
  renderSurfaceBuffers(renderer, res, run, fx, needs);
  // Look-dev / gate hook: show a raw buffer ('gN', 'gP', 'light') instead.
  const view = globalThis.__modelFxView;
  if (view && fx.targets[view]) return fx.targets[view].texture;
  let src = entry.hdr.texture;
  let flip = false;
  for (const e of list) {
    const dst = flip ? fx.targets.b : fx.targets.a;
    // Each entry carries its own clock (an Active Range rebases it).
    const at = Number.isFinite(e.time) ? { ...run, time: e.time } : run;
    // Mix and the swept phase ride along with the effect's own params.
    const params = { ...e.params, __mix: Number.isFinite(e.mix) ? e.mix : 1, __phase: e.phase, __progress: e.progress };
    src = EFFECTS[e.id].run(renderer, res, at, fx, src, dst, params) || src;
    flip = !flip;
  }
  return src;
}

/** Resolves once this backend's pass materials can be built (the WebGPU twin). */
export function modelFxWhenReady() {
  if (modelFxReady()) return Promise.resolve(true);
  return fxNodesPromise ? fxNodesPromise.then(() => true, () => false) : Promise.resolve(false);
}

/**
 * Fresnel Rim on an IMAGE / VIDEO layer (the depth-map edge rim). Called by the
 * Player's per-layer stack with its own pooled targets:
 *
 *   src      the normalised isolate (frame-space plate, WebGL layout)
 *   dst      where the lit plate goes
 *   target   (name, level) → a pooled target: 'light' at plate size, and
 *            'down0..4' / 'up0..3' halving per level for the halo
 *   box      computeLayerBox() for the layer, placing the depth map
 *   depth    { texture, size: [w, h], invert }
 *   params   resolveFresnelRimParams(); phase is the swept level 0..1
 *
 * Returns the texture holding the result, or null when the backend twin is not
 * loaded yet (the caller then passes the plate through and repaints).
 */
export function runFlatFresnelRim(renderer, { src, dst, target, box, depth, params: p, phase, time }) {
  if (!modelFxReady()) return null;
  const res = resourcesFor(renderer);
  const w = src.width, h = src.height;
  const light = target('light', -1, w, h);
  const rim = passMaterial(res, 'flatRim');
  const u = rim.uniforms;
  u.tDepth.value = depth.texture;
  u.uRes.value.set(w, h);
  // Same projective map Depth Scan places its map with (homography.js).
  const { Hi } = fxBoxHomographies(box);
  u.uFxHomInv.value.set(Hi[0], Hi[1], Hi[2], Hi[3], Hi[4], Hi[5], Hi[6], Hi[7], Hi[8]);
  u.uInvert.value = depth.invert ? 1 : 0;
  u.uGamma.value = p.frGamma;
  u.uLow.value = p.frLow / 100;
  u.uHigh.value = p.frHigh / 100;
  u.uPhase.value = phase;
  u.uWindow.value = p.frWindow / 100;
  u.uFeather.value = p.frFeather / 100;
  u.uEdgeMin.value = p.frEdgeMin / 100;
  // Reach is authored in px of a 1080-tall frame; in box uv it is a circle in
  // PLATE pixels, so each axis divides by the box's own projected size.
  const reachPx = p.frRimPx * (h / 1080);
  const size = box.sizePx || [w, h];
  u.uRimUv.value.set(reachPx / Math.max(1, size[0]), reachPx / Math.max(1, size[1]));
  u.uColorA.value.set(p.frColorA);
  u.uColorB.value.set(p.frColorB);
  // The presets are tuned on the model; a photo shows the same light about three times as hot.
  u.uIntensity.value = p.frIntensity * 0.3;
  const a = THREE.MathUtils.degToRad(p.frAngle);
  u.uDir.value.set(Math.cos(a), Math.sin(a));
  u.uDirMix.value = p.frDirMix / 100;
  u.uPulse.value = p.frPulse / 100;
  u.uTime.value = time;
  drawPass(renderer, res, rim, light);
  let halo = null;
  if (p.frHalo > 0.001) {
    const fx = {
      targets: {},
      target: (name, level) => {
        let lw = w, lh = h;
        for (let i = 0; i <= level; i += 1) { lw = Math.max(1, Math.round(lw / 2)); lh = Math.max(1, Math.round(lh / 2)); }
        return target(name, level, lw, lh);
      },
    };
    halo = blurPyramid(renderer, res, fx, light.texture, w, h);
  }
  const add = passMaterial(res, 'addLight');
  add.uniforms.tColor.value = src.texture;
  add.uniforms.tLight.value = light.texture;
  add.uniforms.tHalo.value = halo || light.texture;
  add.uniforms.uRes.value.set(w, h);
  add.uniforms.uHalo.value = halo ? p.frHalo : 0;
  add.uniforms.uBase.value = Math.max(0, Math.min(1, p.frBgDim / 100));
  add.uniforms.uLight.value = 1;
  drawPass(renderer, res, add, dst);
  return dst.texture;
}
