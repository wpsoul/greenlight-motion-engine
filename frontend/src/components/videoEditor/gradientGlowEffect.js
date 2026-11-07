/*
 * Gradient Glow (PRO) — the AE→GLEA "Countdown Animation (Horizontal)" look as an Overlay Effect, without its zoom
 * and without its blur-in: the layer keeps its own transform, the effect only recolours it and lights around it.
 *
 * Look-dev: html/gradient-glow-pro-lab.html (tests/gradient-glow/verify_lab.mjs). The Countdown's layer stack,
 * folded into passes:
 *
 *   brightness  a ramp across the layer box (CSS angle, Ramp Start → Ramp End) — or the layer's own luminance —
 *               on the shape widened by a soft edge glow, with a white INNER RIM on top: glyph × (1 − blurred
 *               glyph), the AE Inner Shadow formula.
 *   colour      that brightness runs through a cyclic 4-stop palette (AE Colorama's output cycle). The phase sweeps
 *               like the Countdown's Phase Shift (400° in 1.833 s at Speed 1, its measured ease) and then HOLDS —
 *               the Gradient Beam rhythm. Softness blurs only the brightness that picks the colour, so the rim's
 *               colour band melts while the shape keeps its edge.
 *   halo        the coloured layer blurred wide (the Countdown's 'Numbers Blur' copy), normal under the layer.
 *
 * Every size is a percentage of the layer box's SHORT side (the plate px of `ctx.box.sizePx`, or the frame in
 * adjustment scope), so a 1500 px digit and a 90 px caption get the same look. On the Countdown's own box (1440 px)
 * the defaults reproduce the decode's pixels: rim σ 33, halo σ 446.
 *
 * Blurs: plain 2× downsamples to the level where σ is 3–6 texels, one separable Gaussian there (the decimation
 * variance subtracted), B-spline upsample where the result is read. Nothing runs for what is not used: Edge Glow,
 * Inner Rim, Softness and Halo at 0 skip their passes, and only the levels a blur needs are built.
 *
 * Timing is a pure function of uTime (the layer clock; an Active Range rebases it), so preview and export agree.
 */

export const GRADIENT_GLOW_MAX_LEVEL = 8;
const SWEEP_S = 1.8333;          // the Countdown's Phase Shift: −49° → −449° over 1.833 s
const EDGE_SIGMA = 0.0125;       // edge glow σ × S (AE Glow 2, radius 30 at the digit's rest size)
const LEVEL_SIGMA = 3;           // a blur runs at the level where σ is 3–6 texels

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (s) => ((ax * s + bx) * s + cx) * s;
  const Y = (s) => ((ay * s + by) * s + cy) * s;
  const dX = (s) => (3 * ax * s + 2 * bx) * s + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let s = x;
    for (let i = 0; i < 8; i += 1) {
      const e = X(s) - x;
      const d = dX(s);
      if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break;
      s -= e / d;
    }
    if (Math.abs(X(s) - x) > 1e-4) {
      let lo = 0;
      let hi = 1;
      s = x;
      for (let i = 0; i < 40; i += 1) { if (X(s) < x) lo = s; else hi = s; s = (lo + hi) / 2; }
    }
    return Y(s);
  };
}
// Easing options: Countdown (the AE Phase Shift curve, measured), Smooth, Linear.
const EASES = [bezier(0.1214, 0, 0.0951, 1), bezier(0.45, 0, 0.55, 1), (x) => Math.min(1, Math.max(0, x))];

// The palette phase (turns, wrapped to 0..1) at layer time t. Each cycle is one eased sweep of Colour Travel
// followed by Hold; the phase carries on from where the last sweep ended, so cycle boundaries are seamless.
export function gradientGlowPhase(p, t) {
  const speed = Math.max(0.01, num(p?.speed, 0.6));
  const sweep = SWEEP_S / speed;
  const cycle = sweep + Math.max(0, num(p?.hold, 0.5));
  const tt = Math.max(0, num(t, 0));
  const n = Math.floor(tt / cycle);
  const tau = tt - n * cycle;
  const ease = EASES[Math.min(2, Math.max(0, Math.round(num(p?.easing, 0))))];
  const turns = (num(p?.phase, 311) - num(p?.travel, 400) * (n + ease(Math.min(1, tau / sweep)))) / 360;
  return turns - Math.floor(turns);
}

const planCache = new WeakMap();

// σ (plate px) → the level it runs at and its σ there, in that level's texels.
function blurAt(sigma, W, H) {
  if (!(sigma >= 0.5)) return null;
  const k = Math.min(GRADIENT_GLOW_MAX_LEVEL, Math.max(0, Math.floor(Math.log2(sigma / LEVEL_SIGMA))));
  const texel = 2 ** k;
  const downVar = (4 ** k - 1) / 12;   // the box decimation chain's own variance, px²
  return {
    k,
    st: Math.sqrt(Math.max(sigma * sigma - downVar, 0.25)) / texel,
    size: [Math.max(1, Math.round(W / texel)), Math.max(1, Math.round(H / texel))],
  };
}

export function gradientGlowPlan(p, ctx) {
  const W = Math.max(1, ctx?.width || 1);
  const H = Math.max(1, ctx?.height || 1);
  const bs = ctx?.box?.sizePx;
  const S = Math.max(1, bs ? Math.min(bs[0], bs[1]) : Math.min(W, H));
  const cached = p ? planCache.get(p) : null;
  if (cached && cached.W === W && cached.H === H && cached.S === S) return cached;
  const edge = num(p?.edgeGlow, 60) > 0 ? blurAt(EDGE_SIGMA * S, W, H) : null;
  const rim = num(p?.rim, 100) > 0 ? blurAt((num(p?.rimWidth, 2.3) / 100) * S, W, H) : null;
  const soft = num(p?.softness, 0) > 0 ? blurAt((num(p?.softness, 0) / 100) * S, W, H) : null;
  const halo = num(p?.halo, 100) > 0 ? blurAt((num(p?.haloSize, 31) / 100) * S, W, H) : null;
  const plan = { W, H, S, edge, rim, soft, halo, srcTop: Math.max(edge ? edge.k : 0, rim ? rim.k : 0) };
  if (p) planCache.set(p, plan);
  return plan;
}

// ── GLSL ────────────────────────────────────────────────────────────────────
const GG_LIB = /* glsl */ `
vec4 ggCubicW(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x;
  float y = s.y - 4.0 * s.x;
  float z = s.z - 4.0 * s.y + 6.0 * s.x;
  float w = 6.0 - x - y - z;
  return vec4(x, y, z, w) * (1.0 / 6.0);
}
// Cubic B-spline in 4 bilinear taps (ts = the texture's size in texels): a coarse level upsamples without kinks.
vec4 ggBspline(sampler2D t, vec2 uv, vec2 ts) {
  vec2 inv = 1.0 / ts;
  vec2 c = uv * ts - 0.5;
  vec2 f = fract(c);
  c -= f;
  vec4 xc = ggCubicW(f.x);
  vec4 yc = ggCubicW(f.y);
  vec4 cc = c.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 off = (cc + vec4(xc.yw, yc.yw) / s) * inv.xxyy;
  vec4 s0 = texture2D(t, off.xz);
  vec4 s1 = texture2D(t, off.yz);
  vec4 s2 = texture2D(t, off.xw);
  vec4 s3 = texture2D(t, off.yw);
  float sx = s.x / (s.x + s.y);
  float sy = s.z / (s.z + s.w);
  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}
`;

// 2× down: one bilinear tap on the corner of each 2×2 block = its box average.
const GG_DOWN_FX = /* glsl */ `
vec4 fx(vec2 uv) { return texture2D(uTexture, uv); }
`;

// Separable Gaussian at one level. [20] σ in this level's texels, [21] 0 horizontal / 1 vertical.
const GG_BLUR_FX = /* glsl */ `
vec4 fx(vec2 uv) {
  float s = max(uParams[20], 1e-3);
  vec2 st = (uParams[21] > 0.5 ? vec2(0.0, 1.0) : vec2(1.0, 0.0)) / uResolution;
  float r = ceil(s * 3.0);
  vec4 acc = texture2D(uTexture, uv);
  float ws = 1.0;
  for (int i = 1; i <= 48; i++) {
    float fi = float(i);
    if (fi > r) break;
    float w = exp(-0.5 * fi * fi / (s * s));
    acc += (texture2D(uTexture, uv + st * fi) + texture2D(uTexture, uv - st * fi)) * w;
    ws += 2.0 * w;
  }
  return acc / ws;
}
`;

// The brightness stack, premultiplied grey. uTexture1 = edge-glow blur, uTexture2 = rim blur.
// [20] edge on, [21] rim on. Slots: 5 colour by, 6 angle, 7/8 ramp start/end %, 10 rim %, 12 edge glow %.
// The ramp lives in the layer box (fxLocal, y up): Ramp Direction is a CSS angle — 0° up, 90° right.
const GG_LUM_FX = /* glsl */ `
vec4 fx(vec2 uv) {
  vec4 s = texture2D(uTexture, uv);
  float A = s.a;
  vec2 q = (fxLocal(uv) - 0.5) * uFxSizePx;
  float ang = radians(uParams[6]);
  vec2 d = vec2(sin(ang), cos(ang));
  float len = abs(uFxSizePx.x * d.x) + abs(uFxSizePx.y * d.y);
  float t = clamp(dot(q, d) / max(len, 1.0) + 0.5, 0.0, 1.0);
  float lo = uParams[7] / 100.0;
  float hi = uParams[8] / 100.0;
  float L = uParams[5] > 0.5 ? mix(lo, hi, luma(unpremult(s))) : mix(lo, hi, t);
  float eb = uParams[20] > 0.5 ? texture2D(uTexture1, uv).a : 0.0;
  float Ag = clamp(A + (1.0 - A) * min(1.0, 2.0 * (uParams[12] / 100.0) * eb), 0.0, 1.0);
  float rb = uParams[21] > 0.5 ? texture2D(uTexture2, uv).a : 1.0;
  float rimA = clamp(A * (1.0 - rb) * (uParams[10] / 100.0), 0.0, 1.0);
  float a = Ag + rimA * (1.0 - Ag);
  float lp = L * Ag * (1.0 - rimA) + rimA;
  return vec4(vec3(lp), a);
}
`;

// The colour cycle. uTexture = brightness, uTexture1 = its softness blur. [20] phase (turns), [21] softness on,
// [22..23] the softness level's size. Slot 9 colour blend (0 Linear = AE Colorama, 1 Smooth = cyclic Catmull-Rom).
const GG_COLOR_FX = /* glsl */ `${GG_LIB}
vec3 ggStop(float i) {
  i = mod(i, 4.0);
  return i < 0.5 ? uColors[0] : i < 1.5 ? uColors[1] : i < 2.5 ? uColors[2] : uColors[3];
}
vec3 ggCycle(float u) {
  u = fract(u) * 4.0;
  float i = floor(u);
  float f = u - i;
  vec3 p1 = ggStop(i);
  vec3 p2 = ggStop(i + 1.0);
  if (uParams[9] < 0.5) return mix(p1, p2, f);
  vec3 p0 = ggStop(i + 3.0);
  vec3 p3 = ggStop(i + 2.0);
  vec3 c = 0.5 * (2.0 * p1 + (p2 - p0) * f + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * f * f
                + (3.0 * p1 - p0 - 3.0 * p2 + p3) * f * f * f);
  return clamp(c, 0.0, 1.0);
}
vec4 fx(vec2 uv) {
  vec4 I = texture2D(uTexture, uv);
  float a = clamp(I.a, 0.0, 1.0);
  float L = clamp(I.r / max(a, 1e-5), 0.0, 1.0);
  if (uParams[21] > 0.5) {
    vec4 B = ggBspline(uTexture1, uv, vec2(uParams[22], uParams[23]));
    L = clamp(B.r / max(B.a, 1e-4), 0.0, 1.0);
  }
  return a < 1e-5 ? vec4(0.0) : vec4(ggCycle(L + uParams[20]) * a, a);
}
`;

// Layer = colour over its halo. uTexture = colour, uTexture1 = halo blur. [20] halo on, [21..22] its level size.
// Slot 14 halo %. The halo tail is dithered (integer hash: bit-exact on WebGL and WebGPU) so it never bands.
const GG_MAIN_FX = /* glsl */ `${GG_LIB}
float ggHashU(vec2 p) {
  uvec2 q = uvec2(max(p, vec2(0.0)));
  uint h = q.x * 1973u + q.y * 9277u + 26699u;
  h = (h ^ (h >> 16u)) * 73244475u;
  h = (h ^ (h >> 16u)) * 73244475u;
  h ^= h >> 16u;
  return float(h & 65535u) / 65535.0;
}
vec4 fx(vec2 uv) {
  vec4 C = texture2D(uTexture, uv);
  if (uParams[20] < 0.5) return C;
  vec4 H = ggBspline(uTexture1, uv, vec2(uParams[21], uParams[22])) * (uParams[14] / 100.0);
  H.a = clamp(H.a, 0.0, 1.0);
  H.rgb = clamp(H.rgb, vec3(0.0), vec3(H.a));
  vec2 px = floor(uv * uResolution);
  float nz = (ggHashU(px) + ggHashU(px + vec2(7919.0, 104729.0)) - 1.0) / 255.0 * clamp(H.a * 255.0, 0.0, 1.0);
  H = clamp(H + vec4(vec3(nz), nz), 0.0, 1.0);
  H.rgb = min(H.rgb, vec3(H.a));
  return C + H * (1.0 - C.a);
}
`;

// ── Passes ──────────────────────────────────────────────────────────────────
const plan = gradientGlowPlan;
const level = (name, k) => (k === 0 ? (name === 'S' ? 'source' : `gg${name}0`) : `gg${name}D${k}`);

// One downsample chain per source: S = the layer, L = brightness, C = colour. `need` = the deepest level a blur
// of that chain asks for (−1 = none).
const downPass = (name, i, need) => ({
  key: `${name.toLowerCase()}D${i}`,
  target: `gg${name}D${i}`,
  hdr: true,
  scale: 2 ** -i,
  inputs: { uTexture: i === 1 ? level(name, 0) : `gg${name}D${i - 1}` },
  fragment: GG_DOWN_FX,
  skipIf: (p, c) => need(plan(p, c)) < i,
  alias: 'source',
});

// The H and V halves of one blur (`which` = edge / rim / soft / halo) on chain `name`.
const blurPasses = (which, name) => [false, true].map((vert) => ({
  key: `${which}${vert ? 'V' : 'H'}`,
  target: `gg${which}${vert ? 'V' : 'H'}`,
  hdr: true,
  scale: (p, c) => { const b = plan(p, c)[which]; return b ? 2 ** -b.k : 1; },
  inputs: (p, c) => {
    const b = plan(p, c)[which];
    if (vert) return { uTexture: `gg${which}H` };
    return { uTexture: b ? level(name, b.k) : 'source' };
  },
  fragment: GG_BLUR_FX,
  skipIf: (p, c) => !plan(p, c)[which],
  alias: 'source',
  set: (p, c) => { const b = plan(p, c)[which]; return { 20: b ? b.st : 1, 21: vert ? 1 : 0 }; },
}));

const range = (n, f) => Array.from({ length: n }, (_, k) => f(k + 1));
const EASING_OPTIONS = [
  { value: 0, label: 'Countdown' },
  { value: 1, label: 'Smooth' },
  { value: 2, label: 'Linear' },
];

export const GRADIENT_GLOW_EFFECT = {
  id: 'gradientGlow',
  name: 'Gradient Glow',
  group: 'Gradient',
  animated: true,
  pro: true,
  // The halo and the edge glow light up past the silhouette; clipping would erase exactly what they add.
  layerMatte: 'expand',
  params: [
    { key: 'color1', type: 'color', colorSlot: 0, label: 'Color 1', default: '#ffd470' },
    { key: 'color2', type: 'color', colorSlot: 1, label: 'Color 2', default: '#ce6dff' },
    { key: 'color3', type: 'color', colorSlot: 2, label: 'Color 3', default: '#ff0000' },
    { key: 'color4', type: 'color', colorSlot: 3, label: 'Color 4', default: '#c172f7' },
    { key: 'speed', slot: 0, label: 'Speed', min: 0.05, max: 3, step: 0.05, default: 0.6, suffix: 'x' },
    { key: 'hold', slot: 1, label: 'Hold', min: 0, max: 6, step: 0.1, default: 0.5, suffix: 's' },
    { key: 'travel', slot: 2, label: 'Colour Travel', min: -720, max: 720, step: 5, default: 400, suffix: '°' },
    { key: 'phase', slot: 3, label: 'Phase', min: 0, max: 360, step: 1, default: 311, suffix: '°' },
    { key: 'easing', slot: 4, label: 'Easing', type: 'select', default: 0, options: EASING_OPTIONS },
    { key: 'colorBy', slot: 5, label: 'Colour By', type: 'select', default: 0,
      options: [{ value: 0, label: 'Shape Ramp' }, { value: 1, label: 'Layer Brightness' }] },
    { key: 'angle', slot: 6, label: 'Ramp Direction', min: 0, max: 360, step: 1, default: 108, suffix: '°',
      showIf: { key: 'colorBy', equals: 0 } },
    { key: 'rampLow', slot: 7, label: 'Ramp Start', min: 0, max: 100, step: 1, default: 28, suffix: '%' },
    { key: 'rampHigh', slot: 8, label: 'Ramp End', min: 0, max: 100, step: 1, default: 70, suffix: '%' },
    { key: 'colorBlend', slot: 9, label: 'Colour Blend', type: 'select', default: 0,
      options: [{ value: 0, label: 'Linear' }, { value: 1, label: 'Smooth' }] },
    { key: 'rim', slot: 10, label: 'Inner Rim', min: 0, max: 200, step: 1, default: 100, suffix: '%' },
    { key: 'rimWidth', slot: 11, label: 'Rim Width', min: 0.2, max: 12, step: 0.1, default: 2.3, suffix: '%' },
    { key: 'edgeGlow', slot: 12, label: 'Edge Glow', min: 0, max: 100, step: 1, default: 60, suffix: '%' },
    { key: 'softness', slot: 13, label: 'Softness', min: 0, max: 8, step: 0.1, default: 0, suffix: '%' },
    { key: 'halo', slot: 14, label: 'Halo', min: 0, max: 150, step: 1, default: 100, suffix: '%' },
    { key: 'haloSize', slot: 15, label: 'Halo Size', min: 4, max: 60, step: 1, default: 31, suffix: '%' },
  ],
  // Three independent rows in one: colour looks (colours only), edge looks and motions (params only), so one of
  // each stays lit.
  colorPresets: [
    { name: 'Countdown', colors: ['#ffd470', '#ce6dff', '#ff0000', '#c172f7'] },
    { name: 'Mint', colors: ['#eafff6', '#33efab', '#0a7d5c', '#5fd4ff'] },
    { name: 'Aurora', colors: ['#c9fff2', '#4affd4', '#3f7bff', '#9b5cff'] },
    { name: 'Ember', colors: ['#fff0b3', '#ffb02e', '#ff3b2f', '#a8325e'] },
    { name: 'Glacier', colors: ['#ffffff', '#8fe3ff', '#2f5bff', '#b3a6ff'] },
    { name: 'Candy', colors: ['#ffe3f5', '#ff5fd2', '#7b5cff', '#4ad8ff'] },
    { name: 'Crisp', params: { softness: 0, rim: 100, rimWidth: 2.3, edgeGlow: 60, colorBlend: 0 } },
    { name: 'Soft', params: { softness: 1, rim: 85, rimWidth: 4, edgeGlow: 70, colorBlend: 1 } },
    { name: 'Velvet', params: { softness: 2.5, rim: 70, rimWidth: 6.5, edgeGlow: 85, colorBlend: 1 } },
    { name: 'Mist', params: { softness: 5, rim: 55, rimWidth: 10, edgeGlow: 100, colorBlend: 1 } },
    { name: 'Pulse', params: { easing: 0, speed: 0.6, hold: 0.5, travel: 400 } },
    { name: 'Drift', params: { easing: 2, speed: 0.3, hold: 0, travel: 360 } },
    { name: 'Breathe', params: { easing: 1, speed: 0.5, hold: 0.8, travel: 180 } },
    { name: 'Still', params: { travel: 0 } },
  ],
  passes: [
    ...range(GRADIENT_GLOW_MAX_LEVEL, (i) => downPass('S', i, (pl) => (pl.edge || pl.rim ? pl.srcTop : -1))),
    ...blurPasses('edge', 'S'),
    ...blurPasses('rim', 'S'),
    {
      key: 'lum',
      target: 'ggL0',
      hdr: true,
      inputs: (p, c) => {
        const pl = plan(p, c);
        return { uTexture: 'source', uTexture1: pl.edge ? 'ggedgeV' : 'source', uTexture2: pl.rim ? 'ggrimV' : 'source' };
      },
      fragment: GG_LUM_FX,
      set: (p, c) => { const pl = plan(p, c); return { 20: pl.edge ? 1 : 0, 21: pl.rim ? 1 : 0 }; },
    },
    ...range(GRADIENT_GLOW_MAX_LEVEL, (i) => downPass('L', i, (pl) => (pl.soft ? pl.soft.k : -1))),
    ...blurPasses('soft', 'L'),
    {
      key: 'color',
      target: 'ggC0',
      hdr: true,
      inputs: (p, c) => ({ uTexture: 'ggL0', uTexture1: plan(p, c).soft ? 'ggsoftV' : 'ggL0' }),
      fragment: GG_COLOR_FX,
      set: (p, c) => {
        const pl = plan(p, c);
        const sz = pl.soft ? pl.soft.size : [1, 1];
        return { 20: gradientGlowPhase(p, c?.time), 21: pl.soft ? 1 : 0, 22: sz[0], 23: sz[1] };
      },
    },
    ...range(GRADIENT_GLOW_MAX_LEVEL, (i) => downPass('C', i, (pl) => (pl.halo ? pl.halo.k : -1))),
    ...blurPasses('halo', 'C'),
    {
      key: 'main',
      target: 'out',
      main: true,
      inputs: (p, c) => ({ uTexture: 'ggC0', uTexture1: plan(p, c).halo ? 'gghaloV' : 'ggC0' }),
      fragment: GG_MAIN_FX,
      set: (p, c) => {
        const pl = plan(p, c);
        const sz = pl.halo ? pl.halo.size : [1, 1];
        return { 20: pl.halo ? 1 : 0, 21: sz[0], 22: sz[1] };
      },
    },
  ],
};
