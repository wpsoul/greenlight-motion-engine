// GPU half of the Path Stroke engine (pathStroke.js builds the geometry).
//
// One shared offscreen WebGL2 context renders a stroke scene and hands back a
// source rect the shape painter drawImage()s into its Canvas 2D plate — the plate
// pipeline, its cache and its upload stay exactly as they are.
//
// Why a GPU pass at all: a width that varies along the line, a colour or alpha
// that varies along it, and joins/caps/arrowheads that must merge into ONE shape
// cannot be drawn seam-free with Canvas 2D fills. Inside one layer the geometry is
// unioned with MAX blending, so folds and overlaps never double the alpha; layers
// (copies, the ghost track, stamps) then composite over each other. The outline
// style draws the same buffers shrunk by the outline width into a second target
// and keeps A × (1 − B), so the outline follows the union — arrowheads included.
//
// Lazy: nothing is created until a stroke that needs the engine is painted.

import { STROKE_RIBBON_STRIDE as RS, STROKE_INSTANCE_STRIDE as IS } from './pathStroke.js';

const PAINT_GLSL = `
uniform int uPaint; uniform vec3 uC0, uC1, uC2, uSolid; uniform int uStops;
uniform float uRep, uOff; uniform bool uMirror;
uniform bool uCore; uniform vec3 uCoreC; uniform float uCoreW, uCoreSoft;
uniform int uOut; // 0 colour · 1 white mask (fill painted by the caller) · 2 core mask
vec3 hsv2rgb(vec3 c) { vec3 p = abs(fract(c.xxx + vec3(1., 2. / 3., 1. / 3.)) * 6. - 3.); return c.z * mix(vec3(1.), clamp(p - 1., 0., 1.), c.y); }
vec3 grad(float t) {
  if (uStops <= 2) return mix(uC0, uC1, t);
  float x = t * 2.; return x < 1. ? mix(uC0, uC1, x) : mix(uC1, uC2, x - 1.);
}
float coreMix(float k) { return 1. - smoothstep(uCoreW - uCoreSoft, uCoreW + uCoreSoft, k); }
vec4 shade(float u, float k, float a) {
  if (uOut == 1) return vec4(a);
  if (uOut == 2) { float m = uCore ? coreMix(k) * a : 0.; return vec4(m); }
  vec3 c = uSolid;
  if (uPaint > 0) {
    float x = u * uRep + uOff, t;
    if (uRep <= 1.0 && uOff == 0.) t = clamp(u, 0., 1.);
    else t = uMirror ? 1. - abs(fract(x * .5) * 2. - 1.) : fract(x);
    c = uPaint == 1 ? grad(t) : hsv2rgb(vec3(t, .72, 1.));
  }
  if (uCore) c = mix(c, uCoreC, coreMix(k));
  return vec4(c * a, a);
}`;
const RIB_VS = `#version 300 es
layout(location=0) in vec2 aPos; layout(location=1) in vec2 aE; layout(location=2) in vec3 aK;
uniform vec2 uRes; uniform float uScale; out vec2 vE; out vec3 vK;
void main() { vE = aE; vK = aK; vec2 c = aPos * uScale / uRes * 2. - 1.; gl_Position = vec4(c.x, -c.y, 0., 1.); }`;
const RIB_FS = `#version 300 es
precision highp float;
in vec2 vE; in vec3 vK; uniform float uInset, uScale; out vec4 o;
${PAINT_GLSL}
void main() {
  float cov = clamp((vE.x - uInset) * uScale + .5, 0., 1.) * clamp((vE.y - uInset) * uScale + .5, 0., 1.);
  float a = cov * vK.z;
  if (a <= .002) discard;
  o = shade(vK.y, vK.x, a);
}`;
const INST_VS = `#version 300 es
layout(location=0) in vec4 iA; layout(location=1) in vec4 iB; layout(location=2) in float iC;
uniform vec2 uRes; uniform float uScale; out vec2 vQ; flat out vec4 vA; flat out vec4 vB; flat out float vAl;
const vec2 C[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(1,1), vec2(-1,-1), vec2(1,1), vec2(-1,1));
void main() {
  float ext = max(iA.z, iA.w) * (iB.y == 8. ? 1.6 : 1.) + iB.z + 2. / uScale;
  vec2 q = C[gl_VertexID] * ext;
  float cr = cos(iB.x), sr = sin(iB.x);
  vec2 w = iA.xy + vec2(q.x * cr - q.y * sr, q.x * sr + q.y * cr);
  vQ = q; vA = iA; vB = iB; vAl = iC;
  vec2 c = w * uScale / uRes * 2. - 1.; gl_Position = vec4(c.x, -c.y, 0., 1.);
}`;
const INST_FS = `#version 300 es
precision highp float;
in vec2 vQ; flat in vec4 vA; flat in vec4 vB; flat in float vAl; uniform float uInset, uScale; out vec4 o;
${PAINT_GLSL}
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.)) + min(max(d.x, d.y), 0.); }
float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.); return length(pa - ba * h); }
float sdTri(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2, v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 q0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0., 1.);
  vec2 q1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0., 1.);
  vec2 q2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0., 1.);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(q0, q0), s * (v0.x * e0.y - v0.y * e0.x)), vec2(dot(q1, q1), s * (v1.x * e1.y - v1.y * e1.x))), vec2(dot(q2, q2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}
float ndot(vec2 a, vec2 b) { return a.x * b.x - a.y * b.y; }
float sdRhombus(vec2 p, vec2 b) { p = abs(p); float h = clamp(ndot(b - 2. * p, b) / dot(b, b), -1., 1.); return length(p - .5 * b * vec2(1. - h, 1. + h)) * sign(p.x * b.y + p.y * b.x - b.x * b.y); }
float sdStar5(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(.809016994375, -.587785252292); vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x); p -= 2. * max(dot(k1, p), 0.) * k1; p -= 2. * max(dot(k2, p), 0.) * k2;
  p.x = abs(p.x); p.y -= r; vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0, 1);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0., r); return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
float dot2(vec2 v) { return dot(v, v); }
float sdHeart(vec2 p) {
  p.x = abs(p.x);
  if (p.y + p.x > 1.) return sqrt(dot2(p - vec2(.25, .75))) - sqrt(2.) / 4.;
  return sqrt(min(dot2(p - vec2(0., 1.)), dot2(p - .5 * max(p.x + p.y, 0.)))) * sign(p.x - p.y);
}
void main() {
  vec2 q = vQ, h = vA.zw; int sh = int(vB.y + .5); float pr = vB.z, d, k;
  if (sh == 0) { d = length(q) - h.x; }
  else if (sh == 1) { d = abs(length(q) - h.x + pr * .5) - pr * .5; }
  else if (sh == 2) { float r = min(pr, min(h.x, h.y)); d = sdBox(q, h - r) - r; }
  else if (sh == 3) { d = sdRhombus(q, h); }
  else if (sh == 4) { d = sdTri(q, vec2(h.x, 0.), vec2(-h.x, h.y), vec2(-h.x, -h.y)); }
  else if (sh == 5) { vec2 tip = vec2(h.x - pr * .5, 0.); d = min(sdSeg(q, tip, vec2(-h.x + pr * .5, h.y - pr * .5)), sdSeg(q, tip, vec2(-h.x + pr * .5, -h.y + pr * .5))) - pr * .5; }
  else if (sh == 6) { float s = max(h.x, h.y); d = sdStar5(vec2(q.y, q.x) / s, 1., .45) * s; }
  else if (sh == 7) { vec2 n = vec2(-.1 * h.x, 0.); d = min(sdTri(q, vec2(h.x, 0.), vec2(-h.x, h.y), n), sdTri(q, vec2(h.x, 0.), n, vec2(-h.x, -h.y))); }
  else if (sh == 8) { float s = max(h.x, h.y) * 1.25; d = sdHeart(vec2(q.y, -q.x) / s * 1.1 + vec2(0., .55)) * s / 1.1; }
  else { float t = max(1., min(h.x, h.y) * .3); d = min(sdBox(q, vec2(h.x, t)), sdBox(q, vec2(t, h.y))); }
  k = sh == 0 ? length(q) / max(h.x, .5) : 1. - clamp(-d / max(.5, min(h.x, h.y)), 0., 1.);
  float cov = clamp(.5 - (d + uInset) * uScale, 0., 1.);
  float a = cov * vAl;
  if (a <= .002) discard;
  o = shade(vB.w, k, a);
}`;
const COMP_VS = `#version 300 es
const vec2 C[3] = vec2[3](vec2(-1,-1), vec2(3,-1), vec2(-1,3)); uniform vec2 uUv; out vec2 vUv;
void main() { vUv = (C[gl_VertexID] * .5 + .5) * uUv; gl_Position = vec4(C[gl_VertexID], 0., 1.); }`;
const COMP_FS = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uA, uB; uniform bool uUseB; uniform float uAlpha; out vec4 o;
void main() { vec4 a = texture(uA, vUv); if (uUseB) a *= 1. - texture(uB, vUv).a; o = a * uAlpha; }`;

let R = null; // { canvas, gl, progs, vaos, bufs, targets, size }
let unavailable = false;

function compile(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
  const u = {};
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i += 1) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

function init() {
  if (R) return R;
  if (unavailable || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
  if (!gl) { unavailable = true; return null; }
  try {
    const progs = { rib: compile(gl, RIB_VS, RIB_FS), inst: compile(gl, INST_VS, INST_FS), comp: compile(gl, COMP_VS, COMP_FS) };
    const ribVao = gl.createVertexArray(); const ribBuf = gl.createBuffer();
    gl.bindVertexArray(ribVao); gl.bindBuffer(gl.ARRAY_BUFFER, ribBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, RS * 4, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, RS * 4, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, RS * 4, 16);
    const instVao = gl.createVertexArray(); const instBuf = gl.createBuffer();
    gl.bindVertexArray(instVao); gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, IS * 4, 0); gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, IS * 4, 16); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, IS * 4, 32); gl.vertexAttribDivisor(2, 1);
    const emptyVao = gl.createVertexArray();
    gl.bindVertexArray(null);
    const maxDim = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
    R = { canvas, gl, progs, ribVao, ribBuf, instVao, instBuf, emptyVao, targets: null, tw: 0, th: 0, maxDim };
    canvas.addEventListener('webglcontextlost', (ev) => { ev.preventDefault(); R = null; }, { once: true });
    return R;
  } catch (err) {
    console.warn('[pathStroke] WebGL2 renderer unavailable:', err);
    unavailable = true;
    return null;
  }
}

function mkTarget(gl, w, h) {
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fb };
}
// Grow-only: plates of every size share one canvas and one pair of targets.
function ensureSize(r, w, h) {
  const { gl } = r;
  if (r.canvas.width < w || r.canvas.height < h) {
    r.canvas.width = Math.max(r.canvas.width, w); r.canvas.height = Math.max(r.canvas.height, h);
  }
  if (!r.targets || r.tw < w || r.th < h) {
    if (r.targets) for (const t of r.targets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    r.tw = Math.max(r.tw, w); r.th = Math.max(r.th, h);
    r.targets = [mkTarget(gl, r.tw, r.th), mkTarget(gl, r.tw, r.th)];
  }
}

const rgbCache = new Map();
export function strokeHexRgb(hex) {
  let v = rgbCache.get(hex);
  if (!v) {
    const x = parseInt(String(hex).slice(1), 16) || 0;
    v = [((x >> 16) & 255) / 255, ((x >> 8) & 255) / 255, (x & 255) / 255];
    rgbCache.set(hex, v);
  }
  return v;
}

function setPaint(r, pr, layerPaint, opts) {
  const { gl } = r; const u = pr.u;
  const card = opts.paintCard;
  gl.uniform2f(u.uRes, opts.width, opts.height);
  gl.uniform1f(u.uScale, opts.px);
  gl.uniform1i(u.uOut, opts.out);
  const mode = layerPaint.mode;
  let solid = opts.fillRgb || [1, 1, 1];
  if (mode === 'solid') solid = strokeHexRgb(layerPaint.color);
  gl.uniform3fv(u.uSolid, solid);
  const along = mode === 'gradient' || mode === 'rainbow';
  gl.uniform1i(u.uPaint, !along ? 0 : mode === 'gradient' ? 1 : 2);
  const cols = card ? card.colors : ['#ffffff', '#ffffff'];
  gl.uniform3fv(u.uC0, strokeHexRgb(cols[0])); gl.uniform3fv(u.uC1, strokeHexRgb(cols[1] || cols[0])); gl.uniform3fv(u.uC2, strokeHexRgb(cols[2] || cols[1] || cols[0]));
  gl.uniform1i(u.uStops, cols.length);
  gl.uniform1f(u.uRep, card ? card.repeat : 1);
  gl.uniform1f(u.uOff, card ? card.offset / 100 + card.flow * opts.time : 0);
  gl.uniform1i(u.uMirror, card && card.mirror ? 1 : 0);
  gl.uniform1i(u.uCore, card && card.core ? 1 : 0);
  gl.uniform3fv(u.uCoreC, strokeHexRgb(card ? card.coreColor : '#ffffff'));
  gl.uniform1f(u.uCoreW, card ? card.coreWidth / 100 : 0);
  gl.uniform1f(u.uCoreSoft, Math.max(0.005, ((card ? card.coreSoftness : 0) / 100) * 0.5));
}
function drawGeom(r, G, layerPaint, opts, inset) {
  const { gl, progs } = r;
  if (G.rib.n) {
    gl.useProgram(progs.rib.p); setPaint(r, progs.rib, layerPaint, opts); gl.uniform1f(progs.rib.u.uInset, inset);
    gl.bindVertexArray(r.ribVao); gl.bindBuffer(gl.ARRAY_BUFFER, r.ribBuf);
    gl.bufferData(gl.ARRAY_BUFFER, G.rib.a.subarray(0, G.rib.n * RS), gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, G.rib.n);
  }
  if (G.inst.n) {
    gl.useProgram(progs.inst.p); setPaint(r, progs.inst, layerPaint, opts); gl.uniform1f(progs.inst.u.uInset, inset);
    gl.bindVertexArray(r.instVao); gl.bindBuffer(gl.ARRAY_BUFFER, r.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, G.inst.a.subarray(0, G.inst.n * IS), gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, G.inst.n);
  }
}

/**
 * Give back the memory a big plate left behind: the canvas and both targets are
 * grow-only while strokes are being painted (every plate shares them), so once
 * painting goes quiet they shrink back to nothing. The Player calls this from a
 * wall-clock idle timer — never from the render loop, which stops when paused.
 */
export function releaseStrokeRenderer() {
  if (!R) return;
  const { gl } = R;
  if (R.targets) for (const t of R.targets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
  R.targets = null; R.tw = 0; R.th = 0;
  R.canvas.width = 1; R.canvas.height = 1;
}

/**
 * Render a buildStrokeScene() result at raster size `width × height` (`px` raster
 * pixels per plate pixel). Returns { canvas, sx, sy, sw, sh } — the source rect to
 * drawImage() SYNCHRONOUSLY (the next render reuses the canvas) — or null when
 * WebGL2 is unavailable, in which case the caller falls back to a plain stroke.
 *   fillRgb — the shape's solid fill for paint mode 'fill' (null → out 'mask')
 *   out — 'color' (default), 'mask' (white, the caller paints its own fill into
 *         it) or 'core' (the core highlight's coverage only)
 */
export function renderStrokeScene(scene, { width, height, px = 1, fillRgb = null, fillAlpha = 1, paintCard = null, time = 0, outlineWidth = 0, out = 'color' }) {
  const r = init();
  if (!r) return null;
  const { gl } = r;
  const w = Math.max(1, Math.min(r.maxDim, Math.ceil(width)));
  const h = Math.max(1, Math.min(r.maxDim, Math.ceil(height)));
  ensureSize(r, w, h);
  const opts = { width: w, height: h, px, fillRgb, paintCard, time, out: out === 'mask' ? 1 : out === 'core' ? 2 : 0 };
  gl.viewport(0, 0, w, h);
  gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  const [TA, TB] = r.targets;
  const outline = outlineWidth > 0;
  for (const L of scene.layers) {
    if (!L.G.rib.n && !L.G.inst.n) continue;
    gl.bindFramebuffer(gl.FRAMEBUFFER, TA.fb); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE);
    drawGeom(r, L.G, L.paint, opts, 0);
    if (outline) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, TB.fb); gl.clear(gl.COLOR_BUFFER_BIT);
      drawGeom(r, L.G, L.paint, opts, outlineWidth);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.blendEquation(gl.FUNC_ADD);
    if (L.add && opts.out === 0) gl.blendFunc(gl.ONE, gl.ONE); else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const pc = r.progs.comp;
    gl.useProgram(pc.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, TA.tex); gl.uniform1i(pc.u.uA, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, TB.tex); gl.uniform1i(pc.u.uB, 1);
    gl.uniform1i(pc.u.uUseB, outline ? 1 : 0);
    gl.uniform2f(pc.u.uUv, w / r.tw, h / r.th);
    gl.uniform1f(pc.u.uAlpha, L.alpha * (L.paint.mode === 'fill' ? fillAlpha : 1));
    gl.bindVertexArray(r.emptyVao); gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  gl.bindVertexArray(null);
  gl.disable(gl.SCISSOR_TEST);
  return { canvas: r.canvas, sx: 0, sy: r.canvas.height - h, sw: w, sh: h };
}
