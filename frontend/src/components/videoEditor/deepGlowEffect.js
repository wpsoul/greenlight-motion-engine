/*
 * Deep Glow — the light glow that replaced the one-Gaussian Glow (same id, 'glow').
 *
 * Look-dev: html/deep-glow-lab.html (tests/deep-glow/verify_lab.mjs). A clean-room rebuild of what the After
 * Effects plug-in Deep Glow publishes about itself — never of its code.
 *
 * THE FALLOFF IS INVERSE-SQUARE. The glow is a sum of Gaussians one octave apart (σ doubles per level of a
 * pyramid), each carrying the SAME energy — which is exactly a 1/r² kernel between the smallest and the largest
 * octave. Falloff f gives an octave the weight 2^(i·(2−f)), renormalised, so it reshapes the curve without dimming
 * it. Radius sets how many octaves run (fractional at the tip, so the slider never steps), and each channel's
 * radius multiplier moves where ITS octaves taper off (a red-wide, blue-tight glow).
 *
 * IT RUNS IN LINEAR LIGHT. The source is unpremultiplied, decoded from sRGB, thresholded (soft, on brightness or
 * luminance) and the glow is added before the sRGB curve goes back on — the faint tail is what turns into the
 * smooth halo. Intermediate passes are half-float (pass.hdr), so values above 1 and the tail survive.
 *
 * HOT CORE. The default tonemap is the identity up to 1 (the picture under the glow is untouched) and past it
 * keeps the hue at full level and spills the excess into the other channels: over-bright colour turns white like
 * film instead of clipping flat.
 *
 * Aspect / Angle squeeze the buffer the isotropic pyramid runs in (q = (R·S)⁻¹·(p − centre)), so the glow is an
 * ellipse along any axis at the cost of nothing. Every pass after the first runs at a fraction of the frame; the
 * per-level Gaussian is a 9-tap pair split across two passes and the upsample a 4-tap cubic B-spline, so octave
 * boundaries never show as pyramid shapes.
 *
 * Nothing runs for what is not used: Exposure 0 bypasses the effect outright (`bypassIf` — zero passes), and the
 * octaves past the radius never render. Text animations reuse these passes over the text plate
 * (engine/textDeepGlow.js) — `ctx.glowSource` points the first pass at the glow-source plate instead.
 */

export const DEEP_GLOW_MAX_LEVELS = 11;
const QUALITY_D = [2, 1];   // level-0 texel size in plate px: Draft, Standard
const SIG0 = 1.6;           // nominal σ of level 0, in its own texels (pre footprint + the 9-tap Gaussian)
const NREF = 7;             // octaves whose sum is 1 (≈ the default radius): Exposure 1 = the source's energy, once

const smooth01 = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const hexRgb = (h) => {
  const n = parseInt(String(h || '#ffffff').replace('#', '').slice(0, 6), 16);
  return Number.isFinite(n) ? [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] : [1, 1, 1];
};

// One plan per (params object, plate): the chain resolves params once per effect per frame and asks every pass's
// hooks in turn.
const planCache = new WeakMap();

export function deepGlowPlan(p, ctx) {
  const W = Math.max(1, ctx?.width || 1);
  const H = Math.max(1, ctx?.height || 1);
  const ref = ctx && Number.isFinite(ctx.ref) && ctx.ref > 0 ? ctx.ref : H / 1080;
  const cached = p ? planCache.get(p) : null;
  if (cached && cached.W === W && cached.H === H && cached.ref === ref) return cached;
  const exposure = Math.max(0, Number(p?.exposure) || 0);
  const d = QUALITY_D[Math.round(Number(p?.quality) || 0) === 0 ? 0 : 1];
  // Glow space: stretch along the glow's own axis, then turn it. Identity at 1× / 0°.
  const a = Math.max(0.01, Number(p?.aspect) || 1);
  // Positive Angle turns the glow CLOCKWISE on screen, like After Effects (the maths here is y-up, hence the minus).
  const ang = (-(Number(p?.angle) || 0) * Math.PI) / 180;
  const sx = a >= 1 ? a : 1;
  const sy = a >= 1 ? 1 : 1 / a;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const RS = [c * sx, s * sx, -s * sy, c * sy];          // column-major mat2: q → p
  const det = RS[0] * RS[3] - RS[2] * RS[1];
  const RSinv = [RS[3] / det, -RS[1] / det, -RS[2] / det, RS[0] / det];
  let bw = 0;
  let bh = 0;
  for (const [px, py] of [[W / 2, H / 2], [W / 2, -H / 2]]) {
    bw = Math.max(bw, Math.abs(RSinv[0] * px + RSinv[2] * py));
    bh = Math.max(bh, Math.abs(RSinv[1] * px + RSinv[3] * py));
  }
  const sizes = [[Math.max(1, Math.ceil((2 * bw) / d)), Math.max(1, Math.ceil((2 * bh) / d))]];
  for (let i = 1; i < DEEP_GLOW_MAX_LEVELS; i += 1) {
    const [pw, ph] = sizes[i - 1];
    sizes.push([Math.max(1, Math.ceil(pw / 2)), Math.max(1, Math.ceil(ph / 2))]);
  }
  const maxLv = Math.min(DEEP_GLOW_MAX_LEVELS, 1 + Math.floor(Math.log2(Math.max(1, Math.min(sizes[0][0], sizes[0][1]) / 2))));
  // Octaves per channel: the largest σ is a third of the radius.
  const radiusPx = Math.max(0, Number(p?.glowRadius) || 0) * ref;
  const mul = [p?.radiusRed, p?.radiusGreen, p?.radiusBlue].map((m) => Math.max(0.05, Number(m) || 1));
  const nc = mul.map((m) => Math.log2(Math.max((radiusPx * m) / (3 * SIG0 * d), 1)) + 1);
  const n = Math.max(1, Math.min(maxLv, Math.ceil(Math.max(...nc) - 1e-6)));
  const falloff = Number.isFinite(Number(p?.falloff)) ? Number(p.falloff) : 2;
  const base = [];
  for (let i = 0; i < n; i += 1) base.push(2 ** (i * (2 - falloff)));
  const bsum = base.reduce((x, y) => x + y, 0) || 1;
  const gain = exposure / NREF;
  const weights = [];
  let any = false;
  for (let i = 0; i < n; i += 1) {
    const b = (base[i] * n) / bsum;
    const w = nc.map((nn) => b * smooth01(nn - i) * gain);
    if (w[0] + w[1] + w[2] > 0) any = true;
    weights.push(w);
  }
  const plan = {
    W, H, ref, d, n, sizes, RS, RSinv, weights,
    off: exposure <= 0 || !any,
  };
  if (p) planCache.set(p, plan);
  return plan;
}

// Linear-space colour for the CPU side (tint previews in tests); the shaders do their own.
export const deepGlowTintAt = (p, t) => {
  const a = hexRgb(p?.tintInner);
  const b = hexRgb(p?.tintOuter);
  return a.map((v, j) => v + (b[j] - v) * t);
};

// ── GLSL ────────────────────────────────────────────────────────────────────
// Shared by the passes that need them (each pass compiles on its own).
const DG_LIB = /* glsl */ `
vec3 dgToLin(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 dgToSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec4 dgCubicW(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x;
  float y = s.y - 4.0 * s.x;
  float z = s.z - 4.0 * s.y + 6.0 * s.x;
  float w = 6.0 - x - y - z;
  return vec4(x, y, z, w) * (1.0 / 6.0);
}
// Cubic B-spline in 4 bilinear taps (ts = the texture's size in texels).
vec4 dgBspline(sampler2D t, vec2 uv, vec2 ts) {
  vec2 inv = 1.0 / ts;
  vec2 c = uv * ts - 0.5;
  vec2 f = fract(c);
  c -= f;
  vec4 xc = dgCubicW(f.x);
  vec4 yc = dgCubicW(f.y);
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
// 9-tap Gaussian (σ 1.4 texels) as 5 bilinear fetches.
vec4 dgBlur9(sampler2D t, vec2 uv, vec2 dir) {
  vec2 d1 = dir * 1.3174924;
  vec2 d2 = dir * 3.1435410;
  return texture2D(t, uv) * 0.2852592
    + (texture2D(t, uv + d1) + texture2D(t, uv - d1)) * 0.3238312
    + (texture2D(t, uv + d2) + texture2D(t, uv - d2)) * 0.0335392;
}
`;

// [20..23] (R·S) column-major, [24] level-0 texel in plate px, [25] source gain, [26..27] plate size.
// The source is averaged over the glow texel's footprint in the plate (a squeezed glow space covers several plate
// px per texel), so thin strokes do not alias. Slots: 3 threshold %, 4 smooth %, 5 threshold by, 16 linear light.
const DG_PRE_FX = /* glsl */ `${DG_LIB}
vec4 fx(vec2 uv) {
  vec2 res = uResolution;
  vec2 g = uv * res;
  vec2 c0 = vec2(uParams[20], uParams[21]);
  vec2 c1 = vec2(uParams[22], uParams[23]);
  float d = uParams[24];
  vec2 frame = vec2(uParams[26], uParams[27]);
  float nx = clamp(ceil(length(c0) * d), 1.0, 8.0);
  float ny = clamp(ceil(length(c1) * d), 1.0, 8.0);
  float thr = uParams[3] / 100.0;
  float sm = uParams[4] / 100.0;
  float mode = uParams[5];
  bool lin = uParams[16] > 0.5;
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 8; j++) {
    if (float(j) >= ny) break;
    for (int i = 0; i < 8; i++) {
      if (float(i) >= nx) break;
      vec2 sub = (vec2(float(i), float(j)) + 0.5) / vec2(nx, ny) - 0.5;
      vec2 q = (g + sub - 0.5 * res) * d;
      vec4 s = sampleClamped(uTexture, (c0 * q.x + c1 * q.y + 0.5 * frame) / frame);
      vec3 c = unpremult(s);
      if (lin) c = dgToLin(c);
      float m = mode < 0.5 ? max(c.r, max(c.g, c.b)) : luma(c);
      float w = mode > 1.5 ? 1.0 : smoothstep(thr - 0.5 * sm, thr + 0.5 * sm + 1e-4, m);
      acc += vec4(c * s.a * w, s.a * w);
    }
  }
  return acc / (nx * ny) * vec4(vec3(uParams[25]), 1.0);
}
`;

// One octave down: a 13-tap filter centred on the 2×2 block. [20..21] the source level's size.
const DG_DOWN_FX = /* glsl */ `
vec4 fx(vec2 uv) {
  vec2 ts = 1.0 / vec2(uParams[20], uParams[21]);
  vec2 c = 2.0 * uv * uResolution * ts;
  vec4 a = texture2D(uTexture, c + ts * vec2(-2.0, 2.0));
  vec4 b = texture2D(uTexture, c + ts * vec2(0.0, 2.0));
  vec4 cc = texture2D(uTexture, c + ts * vec2(2.0, 2.0));
  vec4 d = texture2D(uTexture, c + ts * vec2(-2.0, 0.0));
  vec4 e = texture2D(uTexture, c);
  vec4 f = texture2D(uTexture, c + ts * vec2(2.0, 0.0));
  vec4 g = texture2D(uTexture, c + ts * vec2(-2.0, -2.0));
  vec4 h = texture2D(uTexture, c + ts * vec2(0.0, -2.0));
  vec4 i = texture2D(uTexture, c + ts * vec2(2.0, -2.0));
  vec4 j = texture2D(uTexture, c + ts * vec2(-1.0, 1.0));
  vec4 k = texture2D(uTexture, c + ts * vec2(1.0, 1.0));
  vec4 l = texture2D(uTexture, c + ts * vec2(-1.0, -1.0));
  vec4 m = texture2D(uTexture, c + ts * vec2(1.0, -1.0));
  return e * 0.125 + (a + cc + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
}
`;

const DG_BLUR_H_FX = /* glsl */ `${DG_LIB}
vec4 fx(vec2 uv) { return dgBlur9(uTexture, uv, vec2(1.0, 0.0) / uResolution); }
`;

// One octave of the sum: the vertical half of this level's Gaussian, saturation and the inner→outer tint at this
// octave, the per-channel weight (radius taper × exposure), plus the coarser sum upsampled.
// [20..22] weight rgb, [23] t (0 inner … 1 outer), [24] 1 = a coarser level exists, [25..26] its size.
// Slots: 8 tint %, 9 tint mode, 10 saturation %, 16 linear light; colours 0 inner, 1 outer.
const DG_UP_FX = /* glsl */ `${DG_LIB}
vec4 fx(vec2 uv) {
  vec4 b = dgBlur9(uTexture, uv, vec2(0.0, 1.0) / uResolution);
  vec3 v = b.rgb;
  float L = luma(v);
  v = mix(vec3(L), v, uParams[10] / 100.0);
  float ta = uParams[8] / 100.0;
  if (ta > 0.0) {
    vec3 tint = mix(uColors[0], uColors[1], uParams[23]);
    if (uParams[16] > 0.5) tint = dgToLin(tint);
    float L2 = luma(v);
    vec3 tv = uParams[9] < 0.5 ? L2 * tint / max(luma(tint), 0.15) : v * tint;
    v = mix(v, tv, ta);
  }
  vec3 w = vec3(uParams[20], uParams[21], uParams[22]);
  vec4 r = vec4(max(v, 0.0) * w, b.a * (w.r + w.g + w.b) / 3.0);
  if (uParams[24] > 0.5) r += dgBspline(uTexture1, uv * uResolution * 0.5 / vec2(uParams[25], uParams[26]), vec2(uParams[25], uParams[26]));
  return r;
}
`;

// The composite. [20..23] (R·S)⁻¹ column-major, [24] level-0 texel in plate px, [25..26] level-0 size.
// Slots: 14 aberration %, 15 tonemap, 16 linear light, 17 blend, 18 dither.
// Inside the layer (coverage a) the glow adds onto its colour; outside it is light on its own, with coverage =
// its brightest channel, so a glow off a transparent layer composites as light over whatever is below. With no
// glow the output IS the input (Hot core / Clamp), whatever the alpha.
const DG_MAIN_FX = /* glsl */ `${DG_LIB}
// Dither noise from an INTEGER hash of the pixel: bit-exact on WebGL and WebGPU (a float hash rounds differently
// on the two, and at a 1/255 tail over transparency that flips a pixel between 0 and full straight colour).
float dgHashU(vec2 p) {
  uvec2 q = uvec2(max(p, vec2(0.0)));
  uint h = q.x * 1973u + q.y * 9277u + 26699u;
  h = (h ^ (h >> 16u)) * 73244475u;
  h = (h ^ (h >> 16u)) * 73244475u;
  h ^= h >> 16u;
  return float(h & 65535u) / 65535.0;
}
vec3 dgSpectral(float t) { return clamp(vec3(0.2 + 1.3 * t, 1.0 - 1.2 * abs(t), 0.2 - 1.3 * t), 0.0, 1.0); }
vec3 dgHable(vec3 x) {
  const float A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
vec3 dgTonemap(vec3 x, float m) {
  x = max(x, 0.0);
  if (m < 0.5) return min(x, vec3(1.0));
  if (m < 1.5) {
    vec3 y = 0.8 + 0.2 * (1.0 - exp(-(x - 0.8) / 0.2));
    return min(mix(x, y, step(0.8, x)), vec3(1.0));
  }
  if (m < 2.5) {
    float pk = max(x.r, max(x.g, x.b));
    if (pk <= 1.0) return x;
    vec3 y = x / pk;
    return y + (1.0 - y) * (1.0 - exp(-(pk - 1.0) * 1.1));
  }
  if (m < 3.5) {
    float L = luma(x);
    float Ld = L * (1.0 + L / 36.0) / (1.0 + L);
    return min(x * (Ld / max(L, 1e-5)), vec3(1.0));
  }
  if (m < 4.5) {
    vec3 y = x * 0.8;
    return clamp((y * (2.51 * y + 0.03)) / (y * (2.43 * y + 0.59) + 0.14), 0.0, 1.0);
  }
  return clamp(dgHable(x * 2.0) / dgHable(vec3(11.2)), 0.0, 1.0);
}
vec3 dgGlowAt(vec2 p) {
  vec2 res = uResolution;
  vec2 q = vec2(uParams[20], uParams[21]) * (p.x - 0.5 * res.x) + vec2(uParams[22], uParams[23]) * (p.y - 0.5 * res.y);
  vec2 size0 = vec2(uParams[25], uParams[26]);
  vec2 g = q / uParams[24] + 0.5 * size0;
  return dgBspline(uTexture1, g / size0, size0).rgb;
}
vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  vec2 res = uResolution;
  vec2 p = uv * res;
  float ca = uParams[14] / 100.0;
  vec3 g;
  if (ca > 0.001) {
    vec2 dp = p - 0.5 * res;
    vec3 acc = vec3(0.0);
    vec3 ws = vec3(0.0);
    for (int k = 0; k < 5; k++) {
      float t = float(k) * 0.5 - 1.0;
      vec3 sw = dgSpectral(t);
      acc += dgGlowAt(0.5 * res + dp * (1.0 + ca * 0.045 * t)) * sw;
      ws += sw;
    }
    g = acc / ws;
  } else {
    g = dgGlowAt(p);
  }
  bool lin = uParams[16] > 0.5;
  float tm = uParams[15];
  float a = src.a;
  vec3 s = unpremult(src);
  vec3 L = lin ? dgToLin(s) : s;
  vec3 cov;
  vec3 unc;
  if (uParams[17] < 0.5) {
    cov = L + g;
    unc = g;
  } else {
    vec3 gs = min(g, vec3(1.0));
    cov = L + gs * (1.0 - min(L, vec3(1.0)));
    unc = gs;
  }
  cov = dgTonemap(cov, tm);
  unc = dgTonemap(unc, tm);
  vec3 ec = lin ? dgToSrgb(cov) : cov;
  vec3 eu = lin ? dgToSrgb(unc) : unc;
  if (uParams[18] > 0.5) {
    vec2 px = floor(p);
    // Only where the glow reaches an output level: the base picture stays exact, the faint tail does not band.
    float nz = (dgHashU(px) + dgHashU(px + vec2(7919.0, 104729.0)) - 1.0) / 255.0 * clamp(max(eu.r, max(eu.g, eu.b)) * 255.0, 0.0, 1.0);
    ec += nz;
    eu += nz;
  }
  ec = clamp(ec, 0.0, 1.0);
  eu = clamp(eu, 0.0, 1.0);
  float outA = clamp(a + (1.0 - a) * max(eu.r, max(eu.g, eu.b)), 0.0, 1.0);
  vec3 rgb = a * ec + (1.0 - a) * eu;
  return vec4(min(rgb, vec3(outA)), outA);
}
`;

const levelSize = (i) => (p, c) => deepGlowPlan(p, c).sizes[i];
const beyond = (i) => (p, c) => { const plan = deepGlowPlan(p, c); return plan.off || i >= plan.n; };

const prePass = {
  key: 'pre',
  target: 'dgD0',
  hdr: true,
  size: levelSize(0),
  inputs: (p, c) => ({ uTexture: c?.glowSource ? 'glowSource' : 'source' }),
  fragment: DG_PRE_FX,
  set: (p, c) => {
    const plan = deepGlowPlan(p, c);
    return {
      20: plan.RS[0], 21: plan.RS[1], 22: plan.RS[2], 23: plan.RS[3],
      24: plan.d, 25: Number.isFinite(c?.glowGain) ? c.glowGain : 1, 26: plan.W, 27: plan.H,
    };
  },
};

const downPass = (i) => ({
  key: `down${i}`,
  target: `dgD${i}`,
  hdr: true,
  size: levelSize(i),
  inputs: { uTexture: `dgD${i - 1}` },
  fragment: DG_DOWN_FX,
  skipIf: beyond(i),
  alias: 'source',
  set: (p, c) => {
    const [w, h] = deepGlowPlan(p, c).sizes[i - 1];
    return { 20: w, 21: h };
  },
});

const blurPass = (i) => ({
  key: `blur${i}`,
  target: `dgH${i}`,
  hdr: true,
  size: levelSize(i),
  inputs: { uTexture: `dgD${i}` },
  fragment: DG_BLUR_H_FX,
  skipIf: beyond(i),
  alias: 'source',
});

const upPass = (i) => ({
  key: `up${i}`,
  target: `dgA${i}`,
  hdr: true,
  size: levelSize(i),
  inputs: (p, c) => {
    const plan = deepGlowPlan(p, c);
    return { uTexture: `dgH${i}`, uTexture1: i + 1 < plan.n ? `dgA${i + 1}` : 'source' };
  },
  fragment: DG_UP_FX,
  skipIf: beyond(i),
  alias: 'source',
  set: (p, c) => {
    const plan = deepGlowPlan(p, c);
    const w = plan.weights[i] || [0, 0, 0];
    const prev = i + 1 < plan.n ? plan.sizes[i + 1] : [1, 1];
    return {
      20: w[0], 21: w[1], 22: w[2], 23: plan.n > 1 ? i / (plan.n - 1) : 0,
      24: i + 1 < plan.n ? 1 : 0, 25: prev[0], 26: prev[1],
    };
  },
});

const ONOFF = [{ value: 1, label: 'On' }, { value: 0, label: 'Off' }];

export const DEEP_GLOW_EFFECT = {
  id: 'glow',
  name: 'Deep Glow',
  group: 'Glow',
  animated: false,
  // A growth effect: the light spreads past the silhouette, so it is never cut back to the layer's shape.
  layerMatte: 'expand',
  params: [
    { key: 'glowRadius', slot: 0, label: 'Radius', min: 10, max: 2000, step: 1, default: 420, suffix: 'px' },
    { key: 'exposure', slot: 1, label: 'Exposure', min: 0, max: 4, step: 0.01, default: 1 },
    { key: 'falloff', slot: 2, label: 'Falloff', min: 1.3, max: 3.5, step: 0.01, default: 2 },
    { key: 'glowThreshold', slot: 3, label: 'Threshold', min: 0, max: 100, step: 1, default: 72, suffix: '%' },
    { key: 'thresholdSmooth', slot: 4, label: 'Smooth', min: 0, max: 100, step: 1, default: 30, suffix: '%' },
    { key: 'thresholdBy', slot: 5, label: 'Threshold By', type: 'select', default: 0,
      options: [
        { value: 0, label: 'Brightness' },
        { value: 1, label: 'Luminance' },
        { value: 2, label: 'Everything' },
      ] },
    { key: 'aspect', slot: 6, label: 'Aspect', min: 0.25, max: 16, step: 0.01, default: 1, suffix: '×' },
    { key: 'angle', slot: 7, label: 'Angle', min: -90, max: 90, step: 1, default: 0, suffix: '°' },
    { key: 'tintAmount', slot: 8, label: 'Tint', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
    { key: 'tintInner', type: 'color', colorSlot: 0, label: 'Inner Colour', default: '#ffffff' },
    { key: 'tintOuter', type: 'color', colorSlot: 1, label: 'Outer Colour', default: '#ffffff' },
    { key: 'tintMode', slot: 9, label: 'Tint Mode', type: 'select', default: 0,
      options: [{ value: 0, label: 'Colorize' }, { value: 1, label: 'Multiply' }] },
    { key: 'saturation', slot: 10, label: 'Saturation', min: 0, max: 200, step: 1, default: 100, suffix: '%' },
    { key: 'radiusRed', slot: 11, label: 'Radius Red', min: 0.3, max: 2.5, step: 0.01, default: 1, suffix: '×' },
    { key: 'radiusGreen', slot: 12, label: 'Radius Green', min: 0.3, max: 2.5, step: 0.01, default: 1, suffix: '×' },
    { key: 'radiusBlue', slot: 13, label: 'Radius Blue', min: 0.3, max: 2.5, step: 0.01, default: 1, suffix: '×' },
    { key: 'aberration', slot: 14, label: 'Aberration', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
    { key: 'tonemap', slot: 15, label: 'Tonemap', type: 'select', default: 2,
      options: [
        { value: 0, label: 'Clamp' },
        { value: 1, label: 'Soft Clip' },
        { value: 2, label: 'Hot Core' },
        { value: 3, label: 'Reinhard' },
        { value: 4, label: 'ACES Filmic' },
        { value: 5, label: 'Hable Filmic' },
      ] },
    { key: 'linearLight', slot: 16, label: 'Linear Light', type: 'select', default: 1, options: ONOFF },
    { key: 'blend', slot: 17, label: 'Blend', type: 'select', default: 0,
      options: [{ value: 0, label: 'Add' }, { value: 1, label: 'Screen' }] },
    { key: 'dither', slot: 18, label: 'Dither', type: 'select', default: 1, options: ONOFF },
    { key: 'quality', slot: 19, label: 'Quality', type: 'select', default: 1,
      options: [{ value: 0, label: 'Draft' }, { value: 1, label: 'Standard' }] },
  ],
  // Whole looks: each sets every option (colours are [inner, outer]).
  colorPresets: [
    { name: 'Natural', colors: ['#ffffff', '#ffffff'], params: { glowRadius: 420, exposure: 1, falloff: 2, glowThreshold: 72, thresholdSmooth: 30, thresholdBy: 0, aspect: 1, angle: 0, tintAmount: 0, tintMode: 0, saturation: 100, radiusRed: 1, radiusGreen: 1, radiusBlue: 1, aberration: 0, tonemap: 2, linearLight: 1, blend: 0 } },
    { name: 'Neon Tube', colors: ['#ffffff', '#ffffff'], params: { glowRadius: 260, exposure: 1.7, falloff: 2.15, glowThreshold: 35, thresholdSmooth: 25, thresholdBy: 0, aspect: 1, angle: 0, tintAmount: 0, tintMode: 0, saturation: 125, radiusRed: 1, radiusGreen: 1, radiusBlue: 1, aberration: 0, tonemap: 2, linearLight: 1, blend: 0 } },
    { name: 'Haze', colors: ['#ffffff', '#ffffff'], params: { glowRadius: 1500, exposure: 1.1, falloff: 1.65, glowThreshold: 20, thresholdSmooth: 60, thresholdBy: 0, aspect: 1, angle: 0, tintAmount: 0, tintMode: 0, saturation: 100, radiusRed: 1, radiusGreen: 1, radiusBlue: 1, aberration: 0, tonemap: 2, linearLight: 1, blend: 0 } },
    { name: 'Anamorphic', colors: ['#ffffff', '#3d7bff'], params: { glowRadius: 130, exposure: 1.5, falloff: 1.9, glowThreshold: 72, thresholdSmooth: 30, thresholdBy: 0, aspect: 11, angle: 0, tintAmount: 75, tintMode: 0, saturation: 100, radiusRed: 1, radiusGreen: 1, radiusBlue: 1, aberration: 0, tonemap: 2, linearLight: 1, blend: 0 } },
    { name: 'Prism', colors: ['#ffffff', '#ffffff'], params: { glowRadius: 520, exposure: 1.2, falloff: 2, glowThreshold: 72, thresholdSmooth: 30, thresholdBy: 0, aspect: 1, angle: 0, tintAmount: 0, tintMode: 0, saturation: 100, radiusRed: 1.5, radiusGreen: 1, radiusBlue: 0.68, aberration: 50, tonemap: 2, linearLight: 1, blend: 0 } },
    { name: 'Ember', colors: ['#fff0cc', '#ff4a12'], params: { glowRadius: 650, exposure: 1.3, falloff: 2, glowThreshold: 72, thresholdSmooth: 30, thresholdBy: 0, aspect: 1, angle: 0, tintAmount: 85, tintMode: 0, saturation: 100, radiusRed: 1, radiusGreen: 1, radiusBlue: 1, aberration: 0, tonemap: 2, linearLight: 1, blend: 0 } },
  ],
  bypassIf: (p, c) => deepGlowPlan(p, c).off,
  passes: [
    prePass,
    ...Array.from({ length: DEEP_GLOW_MAX_LEVELS - 1 }, (_, k) => downPass(k + 1)),
    ...Array.from({ length: DEEP_GLOW_MAX_LEVELS }, (_, k) => blurPass(k)),
    ...Array.from({ length: DEEP_GLOW_MAX_LEVELS }, (_, k) => upPass(DEEP_GLOW_MAX_LEVELS - 1 - k)),
    {
      key: 'main',
      target: 'out',
      main: true,
      inputs: { uTexture: 'source', uTexture1: 'dgA0' },
      fragment: DG_MAIN_FX,
      set: (p, c) => {
        const plan = deepGlowPlan(p, c);
        return {
          20: plan.RSinv[0], 21: plan.RSinv[1], 22: plan.RSinv[2], 23: plan.RSinv[3],
          24: plan.d, 25: plan.sizes[0][0], 26: plan.sizes[0][1],
        };
      },
    },
  ],
};
