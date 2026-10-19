/*
 * Film Stock — Dehancer-style analog camera profiles as one Overlay Effect.
 * Ported from html/film-stock-overlay.html (tune there first). PRO.
 *
 * THE ONE IDEA
 * ------------
 * A film look is a RECIPE, not a LUT: white balance, a dye cross-talk matrix,
 * a toe/shoulder curve, a split tone, emulsion halation, bloom, grain and a
 * lens vignette. Every stock below is that recipe as numbers, so the whole
 * catalogue is a few kilobytes and every stock is resolution-independent
 * (radii and grain size are px at 1080p, scaled by the plate height).
 *
 * THE USER SEES TWO THINGS
 * ------------------------
 * A stock and Mix. Four Balance multipliers (grain / halation / bloom /
 * vignette) ride on top of the stock's own amounts, and a Film Damage block
 * (flicker, gate weave, light leak — all 0 by default) is projection wear
 * that belongs to no stock. Painted-on print damage was tried and rejected.
 *
 * WHY EIGHT PASSES (and when they are seven fewer)
 * -------------------------------------------------
 * Halation and bloom are glows, and a glow is a threshold FOLLOWED by a blur —
 * never the other way round (the lab's first single-pass version thresholded a
 * mip-averaged tap of a small specular, which never crosses the threshold, so
 * nothing glowed). The same dual-filter pyramid Bloom uses: `bright` (½ res,
 * soft-knee threshold: rgb = bloom energy in linear light, a = halation
 * energy) → down1..3 → up2..0 (tent + add, per-octave gates from the stock's
 * two radii via `set`) → `main`, which reads the ½-res sum, adds the glows in
 * linear light BEFORE the curve so the shoulder rolls them off, then grades.
 * Halation AND bloom at zero skip all seven glow passes (`skipIf`); grain at
 * zero skips its 32 hashes. Cost when used: ~0.66 of a full-res pass for the
 * pyramid + the main pass; unused = exactly what the chain would cost anyway.
 *
 * STOCK CONSTANTS LIVE IN THE SHADER
 * ----------------------------------
 * A recipe is ~35 numbers and the uniform bank has 24 free slots, so the
 * stock table is compiled into both shader languages as an id ladder from ONE
 * JS array (FILM_STOCKS). The TSL twin (filmStockNodes.js) reads the same
 * array; only the per-pass thresholds / gates / norms travel through uParams.
 *
 * ALPHA
 * -----
 * Premultiplied in and out. Glow energy is premultiplied by the source alpha
 * in the bright pass and ADDS coverage in the main pass (like Bloom), so
 * halation bleeds past a cutout's edge — hence `layerMatte: 'expand'`, and the
 * effect stays out of LAYER_CLIP_BY_DEFAULT. Grain is multiplied back by the
 * output alpha; the light leak is fog over the print and never adds coverage.
 */

export const FILM_STOCK_ID = 'filmStock';

/*
 * The stocks. Each field is a shader constant (see the lab header for units):
 *   temp / tint       white balance in linear light (+temp warm, +tint magenta)
 *   exposure          stops
 *   contrast          linear contrast about a 0.45 pivot (display space)
 *   curve             S-curve blend 0..1
 *   lift              black fade
 *   roll              highlight shoulder 0..1
 *   sat               saturation
 *   matrix            3×3 dye cross-talk, ROW-major, applied in linear light
 *                     (B&W stocks put the same weights on every row)
 *   shadowCol/Amt, highCol/Amt   split tone (hue only — the colour's luma is removed)
 *   grainAmt / grainSize / grainChroma
 *   halAmt / halRad / halThr / halCol
 *   bloomAmt / bloomRad / bloomThr
 *   vigAmt / vigRad / vigSoft
 */
export const FILM_STOCKS = [
  { id: 'v250d', name: 'Kodak Vision3 250D', group: 'Cine negative',
    temp: .05, tint: 0, exposure: 0, contrast: 1.05, curve: .25, lift: .02, roll: .25, sat: 1.0,
    matrix: [1.03, -.02, -.01, -.02, 1.02, 0, 0, -.02, 1.02],
    shadowCol: '#1d3a4a', shadowAmt: .18, highCol: '#ffe7c8', highAmt: .12,
    grainAmt: .18, grainSize: 1.2, grainChroma: .35,
    halAmt: .25, halRad: 18, halThr: .72, halCol: '#ff5a2a',
    bloomAmt: .08, bloomRad: 28, bloomThr: .78,
    vigAmt: .18, vigRad: .95, vigSoft: .5 },
  { id: 'v500t', name: 'Kodak Vision3 500T', group: 'Cine negative',
    temp: -.06, tint: .02, exposure: 0, contrast: 1.0, curve: .2, lift: .04, roll: .3, sat: .95,
    matrix: [1.04, -.02, -.02, -.03, 1.03, 0, 0, -.03, 1.03],
    shadowCol: '#173447', shadowAmt: .3, highCol: '#ffd9a8', highAmt: .16,
    grainAmt: .32, grainSize: 1.5, grainChroma: .4,
    halAmt: .35, halRad: 22, halThr: .68, halCol: '#ff5028',
    bloomAmt: .1, bloomRad: 32, bloomThr: .75,
    vigAmt: .22, vigRad: .92, vigSoft: .5 },
  { id: 'eterna', name: 'Fuji Eterna 500', group: 'Cine negative',
    temp: -.02, tint: -.02, exposure: .05, contrast: .82, curve: .1, lift: .07, roll: .4, sat: .78,
    matrix: [1.0, 0, 0, -.02, 1.0, .04, 0, .02, .98],
    shadowCol: '#1a3538', shadowAmt: .25, highCol: '#f5e6d2', highAmt: .1,
    grainAmt: .22, grainSize: 1.5, grainChroma: .3,
    halAmt: .25, halRad: 24, halThr: .7, halCol: '#ff6a3a',
    bloomAmt: .12, bloomRad: 36, bloomThr: .72,
    vigAmt: .2, vigRad: .95, vigSoft: .55 },
  { id: 'cine800t', name: 'CineStill 800T', group: 'Cine negative',
    temp: -.12, tint: .04, exposure: 0, contrast: 1.0, curve: .2, lift: .05, roll: .25, sat: 1.02,
    matrix: [1.05, -.03, -.02, -.03, 1.02, .01, -.02, -.02, 1.06],
    shadowCol: '#0f2a3f', shadowAmt: .35, highCol: '#ffd2a0', highAmt: .2,
    grainAmt: .36, grainSize: 1.6, grainChroma: .45,
    halAmt: .8, halRad: 30, halThr: .55, halCol: '#ff3a1a',
    bloomAmt: .18, bloomRad: 40, bloomThr: .7,
    vigAmt: .22, vigRad: .92, vigSoft: .5 },
  { id: 'portra', name: 'Kodak Portra 400', group: 'Colour negative',
    temp: .18, tint: .04, exposure: .08, contrast: .92, curve: .15, lift: .05, roll: .3, sat: .9,
    matrix: [1.06, -.03, -.03, .02, .98, 0, 0, 0, .98],
    shadowCol: '#3a3325', shadowAmt: .2, highCol: '#ffe3c9', highAmt: .2,
    grainAmt: .22, grainSize: 1.4, grainChroma: .4,
    halAmt: .18, halRad: 20, halThr: .72, halCol: '#ff7a3a',
    bloomAmt: .12, bloomRad: 30, bloomThr: .72,
    vigAmt: .2, vigRad: .95, vigSoft: .55 },
  { id: 'pro400h', name: 'Fuji Pro 400H', group: 'Colour negative',
    temp: -.08, tint: -.06, exposure: .08, contrast: .9, curve: .12, lift: .06, roll: .3, sat: .92,
    matrix: [1.0, 0, 0, -.03, 1.0, .06, 0, .06, .96],
    shadowCol: '#1f3d3a', shadowAmt: .22, highCol: '#e8f2ff', highAmt: .14,
    grainAmt: .2, grainSize: 1.3, grainChroma: .35,
    halAmt: .12, halRad: 20, halThr: .74, halCol: '#ff8a5a',
    bloomAmt: .14, bloomRad: 34, bloomThr: .7,
    vigAmt: .16, vigRad: .97, vigSoft: .55 },
  { id: 'vista', name: 'Agfa Vista 200', group: 'Colour negative',
    temp: .1, tint: .02, exposure: 0, contrast: 1.12, curve: .3, lift: .03, roll: .2, sat: 1.2,
    matrix: [1.1, -.06, -.04, -.02, 1.02, 0, 0, -.04, 1.04],
    shadowCol: '#2a1a2f', shadowAmt: .2, highCol: '#fff5d0', highAmt: .12,
    grainAmt: .28, grainSize: 1.4, grainChroma: .4,
    halAmt: .2, halRad: 18, halThr: .72, halCol: '#ff4a2a',
    bloomAmt: .08, bloomRad: 26, bloomThr: .78,
    vigAmt: .28, vigRad: .9, vigSoft: .5 },
  { id: 'e100', name: 'Kodak Ektachrome E100', group: 'Slide',
    temp: -.06, tint: 0, exposure: 0, contrast: 1.18, curve: .35, lift: 0, roll: .12, sat: 1.15,
    matrix: [1.04, -.02, -.02, -.02, 1.02, 0, -.02, -.06, 1.08],
    shadowCol: '#10233f', shadowAmt: .22, highCol: '#ffffff', highAmt: 0,
    grainAmt: .1, grainSize: 1.0, grainChroma: .2,
    halAmt: .12, halRad: 16, halThr: .78, halCol: '#ff6a3a',
    bloomAmt: .06, bloomRad: 24, bloomThr: .8,
    vigAmt: .15, vigRad: .97, vigSoft: .5 },
  { id: 'kchrome', name: 'Kodachrome 64', group: 'Slide',
    temp: .12, tint: 0, exposure: -.04, contrast: 1.22, curve: .4, lift: 0, roll: .1, sat: 1.1,
    matrix: [1.14, -.08, -.06, -.04, 1.0, 0, -.02, -.08, 1.06],
    shadowCol: '#1c130c', shadowAmt: .25, highCol: '#fff1d6', highAmt: .15,
    grainAmt: .14, grainSize: 1.1, grainChroma: .15,
    halAmt: .15, halRad: 16, halThr: .76, halCol: '#ff3c1e',
    bloomAmt: .05, bloomRad: 22, bloomThr: .8,
    vigAmt: .3, vigRad: .9, vigSoft: .5 },
  { id: 'velvia', name: 'Fuji Velvia 50', group: 'Slide',
    temp: .02, tint: .02, exposure: -.06, contrast: 1.3, curve: .45, lift: 0, roll: .08, sat: 1.45,
    matrix: [1.1, -.06, -.04, -.06, 1.1, -.04, -.04, -.06, 1.1],
    shadowCol: '#12103a', shadowAmt: .2, highCol: '#ffffff', highAmt: 0,
    grainAmt: .08, grainSize: 1.0, grainChroma: .15,
    halAmt: .1, halRad: 14, halThr: .8, halCol: '#ff5a3a',
    bloomAmt: .04, bloomRad: 20, bloomThr: .82,
    vigAmt: .3, vigRad: .9, vigSoft: .5 },
  { id: 'hp5', name: 'Ilford HP5 Plus', group: 'Black & white',
    temp: 0, tint: 0, exposure: 0, contrast: 1.08, curve: .3, lift: .04, roll: .25, sat: 1,
    matrix: [.28, .6, .12, .28, .6, .12, .28, .6, .12],
    shadowCol: '#000000', shadowAmt: 0, highCol: '#ffffff', highAmt: 0,
    grainAmt: .42, grainSize: 1.5, grainChroma: 0,
    halAmt: .12, halRad: 20, halThr: .74, halCol: '#ffffff',
    bloomAmt: .1, bloomRad: 30, bloomThr: .76,
    vigAmt: .25, vigRad: .92, vigSoft: .5 },
  { id: 'trix', name: 'Kodak Tri-X 400', group: 'Black & white',
    temp: 0, tint: 0, exposure: 0, contrast: 1.25, curve: .45, lift: .02, roll: .15, sat: 1,
    matrix: [.36, .52, .12, .36, .52, .12, .36, .52, .12],
    shadowCol: '#000000', shadowAmt: 0, highCol: '#ffffff', highAmt: 0,
    grainAmt: .5, grainSize: 1.7, grainChroma: 0,
    halAmt: .08, halRad: 16, halThr: .78, halCol: '#ffffff',
    bloomAmt: .06, bloomRad: 26, bloomThr: .8,
    vigAmt: .3, vigRad: .9, vigSoft: .5 },
  { id: 'polaroid', name: 'Polaroid 600', group: 'Instant & alt',
    temp: .08, tint: .08, exposure: .05, contrast: .84, curve: .05, lift: .08, roll: .4, sat: .85,
    matrix: [1.0, .02, 0, .02, .96, .02, 0, .04, .96],
    shadowCol: '#1f4a55', shadowAmt: .32, highCol: '#fff0cf', highAmt: .18,
    grainAmt: .16, grainSize: 2.2, grainChroma: .5,
    halAmt: .2, halRad: 26, halThr: .66, halCol: '#ff9a6a',
    bloomAmt: .14, bloomRad: 50, bloomThr: .62,
    vigAmt: .55, vigRad: .8, vigSoft: .6 },
  { id: 'xpro', name: 'Cross Process', group: 'Instant & alt',
    temp: .05, tint: -.1, exposure: 0, contrast: 1.35, curve: .5, lift: .03, roll: .1, sat: 1.3,
    matrix: [1.08, -.04, -.04, -.06, 1.12, -.06, -.04, 0, 1.04],
    shadowCol: '#0a1a55', shadowAmt: .4, highCol: '#ffee88', highAmt: .4,
    grainAmt: .3, grainSize: 1.4, grainChroma: .5,
    halAmt: .15, halRad: 18, halThr: .74, halCol: '#ff4a2a',
    bloomAmt: .1, bloomRad: 28, bloomThr: .76,
    vigAmt: .35, vigRad: .88, vigSoft: .45 },
];

// Scalar and colour fields the shader ladder assigns, in a fixed order shared
// with filmStockNodes.js.
export const FILM_STOCK_SCALARS = [
  'temp', 'tint', 'exposure', 'contrast', 'curve', 'lift', 'roll', 'sat',
  'shadowAmt', 'highAmt', 'grainAmt', 'grainSize', 'grainChroma',
  'halAmt', 'bloomAmt', 'vigAmt', 'vigRad', 'vigSoft',
];
export const FILM_STOCK_COLORS = ['shadowCol', 'highCol', 'halCol'];

export function hexToRgb01(hex) {
  const s = String(hex || '#ffffff').replace('#', '');
  const n = parseInt(s.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function filmStockOf(params) {
  const i = Math.round(Number(params?.preset) || 0);
  return FILM_STOCKS[Math.max(0, Math.min(FILM_STOCKS.length - 1, i))];
}

/*
 * Pyramid gates. A radius in px @1080p becomes a chain DEPTH in octaves of the
 * plate (1 = the half-res level alone, 4 = all four levels), fractional at the
 * tip so a radius change morphs the halo instead of stepping. Halation's radius
 * is widened first: film halation has a long soft tail past its visible core.
 */
const depthOf = (px, ref) => Math.max(1, Math.min(4, 1 + Math.log2(Math.max(px * (ref || 1), 1) / 5)));
const gateAt = (depth, k) => Math.max(0, Math.min(1, depth - k));
const gatesFor = (params, ctx) => {
  const s = filmStockOf(params);
  return { b: depthOf(s.bloomRad, ctx?.ref), h: depthOf(s.halRad * 1.8, ctx?.ref) };
};
// Both glows off (stock amount × Balance = 0 for halation AND bloom) → the
// seven pyramid passes are skipped and the main pass reads `source` as the
// pyramid; its glow terms are multiplied by those same zero amounts, so the
// frame is identical and the effect costs one full-res pass. An effect must
// cost nothing for what it is not doing.
const glowsOff = (params) => {
  const s = filmStockOf(params);
  return !(s.halAmt * (Number(params.halation) || 0) > 0) && !(s.bloomAmt * (Number(params.bloom) || 0) > 0);
};
const upSet = (k) => (params, ctx) => {
  const d = gatesFor(params, ctx);
  return { 24: gateAt(d.b, k), 25: gateAt(d.h, k) };
};
const mainSet = (params, ctx) => {
  const d = gatesFor(params, ctx);
  // Quarter-weight the deeper octaves in the norm: a full 1/(L+1) keeps a large
  // light's core honest but dilutes the tail the halo IS (the lab reads one
  // deep octave; the user's first verdict on the app was "does nothing").
  const norm = (depth) => 1 + 0.25 * (gateAt(depth, 1) + gateAt(depth, 2) + gateAt(depth, 3));
  return { 24: norm(d.b), 25: norm(d.h) };
};

// ── GLSL ──────────────────────────────────────────────────────────────────
const g = (v) => {
  const s = String(Number(v));
  return /[.e]/.test(s) ? s : `${s}.0`;
};
const gv3 = (arr) => `vec3(${g(arr[0])}, ${g(arr[1])}, ${g(arr[2])})`;

// The stock table as an id ladder writing module-scope globals.
function stockLadderGlsl() {
  const decl = `float ${FILM_STOCK_SCALARS.map((k) => `s_${k}`).join(', ')};\n`
    + `vec3 ${FILM_STOCK_COLORS.map((k) => `s_${k}`).join(', ')}, s_m0, s_m1, s_m2;\n`;
  const branches = FILM_STOCKS.map((s, i) => {
    const body = [
      ...FILM_STOCK_SCALARS.map((k) => `s_${k} = ${g(s[k])};`),
      ...FILM_STOCK_COLORS.map((k) => `s_${k} = ${gv3(hexToRgb01(s[k]))};`),
      `s_m0 = ${gv3(s.matrix.slice(0, 3))}; s_m1 = ${gv3(s.matrix.slice(3, 6))}; s_m2 = ${gv3(s.matrix.slice(6, 9))};`,
    ].join(' ');
    if (i === 0) return `  if (id < 0.5) { ${body} }`;
    if (i === FILM_STOCKS.length - 1) return `  else { ${body} }`;
    return `  else if (id < ${i}.5) { ${body} }`;
  }).join('\n');
  return `${decl}void fsStock(float id) {\n${branches}\n}\n`;
}

const FS_LIB = /* glsl */ `
vec3 fsS2L(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 fsL2S(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
// Integer-lattice hash in uint arithmetic (LCG + xorshift mixer). Integer
// maths is bit-exact on both backends, which a float hash is not: the Hoskins
// float hash diverged on ~7k pixels between WebGL and WebGPU, and the prelude's
// hash21 is periodic on an integer lattice (visible banding in per-pixel grain).
float fsHash(vec2 p) {
  uvec2 v = uvec2(ivec2(floor(p)) + 32768);
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return float(v.x ^ v.y) / 4294967296.0;
}
float fsHash1(float x) { return fsHash(vec2(x, 7.0)); }
float fsKnee(float l, float thr) {
  float k = max(thr * 0.5, 1e-4);
  float soft = clamp(l - thr + k, 0.0, 2.0 * k);
  soft = soft * soft / (4.0 * k);
  return max(max(soft, l - thr) / max(l, 1e-4), 0.0);
}
`;

// Bright pass, half res. uParams[24] = the stock's bloom threshold, [25] = its
// halation threshold (via `set`). Energy is halved so four accumulated octaves
// fit an 8-bit target; the main pass doubles it back.
const FS_BRIGHT_FX = /* glsl */ `
vec4 fx(vec2 uv) {
  vec4 s = texture2D(uTexture, uv);
  vec3 st = clamp(unpremult(s), 0.0, 1.0);
  float l = luma(st);
  vec3 lin = fsS2L(st);
  return vec4(lin * fsKnee(l, uParams[24]) * s.a * 0.5, luma(lin) * fsKnee(l, uParams[25]) * s.a * 0.5);
}
`;

// Dual-filter down: one SOURCE texel is 1/(2·uResolution) at this level.
const FS_DOWN_FX = /* glsl */ `
vec4 fx(vec2 uv) {
  vec2 h = 1.0 / (2.0 * uResolution);
  vec4 s = texture2D(uTexture, uv) * 4.0
    + texture2D(uTexture, uv + vec2(-h.x, -h.y)) + texture2D(uTexture, uv + vec2(h.x, -h.y))
    + texture2D(uTexture, uv + vec2(-h.x,  h.y)) + texture2D(uTexture, uv + vec2(h.x,  h.y));
  return s / 8.0;
}
`;

// Tent-filter the coarser level (uTexture1) and add it onto this level's own
// down texture (uTexture). rgb (bloom) and a (halation) have their own gates.
const FS_UP_FX = /* glsl */ `
vec4 fx(vec2 uv) {
  vec2 h = 2.0 / uResolution;
  vec4 s = texture2D(uTexture1, uv + vec2(-h.x * 2.0, 0.0)) + texture2D(uTexture1, uv + vec2(h.x * 2.0, 0.0))
    + texture2D(uTexture1, uv + vec2(0.0, -h.y * 2.0)) + texture2D(uTexture1, uv + vec2(0.0, h.y * 2.0))
    + 2.0 * (texture2D(uTexture1, uv + vec2(-h.x, h.y)) + texture2D(uTexture1, uv + vec2(h.x, h.y))
           + texture2D(uTexture1, uv + vec2(-h.x, -h.y)) + texture2D(uTexture1, uv + vec2(h.x, -h.y)));
  return texture2D(uTexture, uv) + (s / 12.0) * vec4(uParams[24], uParams[24], uParams[24], uParams[25]);
}
`;

const FS_MAIN_FX = /* glsl */ `
float fsVnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = fsHash(i), b = fsHash(i + vec2(1.0, 0.0)), c = fsHash(i + vec2(0.0, 1.0)), d = fsHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// Static grain (the seed is a constant): the user chose a still lattice over
// the boiling of projected film.
float fsGrain(vec2 p, float seed) {
  vec2 s = vec2(seed * 17.0 + 3.0, seed * 9.0 + 5.0);
  float n = fsVnoise(p + s) + 0.5 * fsVnoise(p * 1.93 + s * 1.7 + 31.0);
  return (n / 1.5 - 0.5) * 2.4;
}
// tanh is unavailable in GLSL ES 1.00; the TSL twin builds the same exp form.
float fsTanh(float x) { float t = exp(clamp(x, -8.0, 8.0) * 2.0); return (t - 1.0) / (t + 1.0); }
vec3 fsShoulder(vec3 d) {
  const float k = 0.62;
  vec3 hi = vec3(k) + (1.0 - k) * vec3(fsTanh((d.r - k) / (1.0 - k)), fsTanh((d.g - k) / (1.0 - k)), fsTanh((d.b - k) / (1.0 - k)));
  return mix(d, hi, step(vec3(k), d));
}
vec4 fx(vec2 uv0) {
  fsStock(uParams[0]);
  float grainX = uParams[1] / 100.0, halX = uParams[2] / 100.0, bloomX = uParams[3] / 100.0, vigX = uParams[4] / 100.0;
  float flick = uParams[5] / 100.0, weave = uParams[6] / 100.0, leak = uParams[7] / 100.0;
  float leakSpeed = uParams[8] / 100.0 * 2.0;
  float normB = max(uParams[24], 1.0), normH = max(uParams[25], 1.0);
  float frame = floor(uTime * 24.0);
  float pxScale = uResolution.y / 1080.0;

  // gate weave: slow drift + per-frame jitter, px @1080p
  vec2 wv = weave * (vec2(sin(uTime * 1.3) * 1.2, cos(uTime * 0.9) * 1.6)
          + (vec2(fsHash(vec2(frame, 3.0)), fsHash(vec2(frame, 7.0))) - 0.5) * 1.6);
  vec2 uv = uv0 + wv * pxScale / uResolution;

  vec4 src = texture2D(uTexture, uv);
  vec4 pyr = texture2D(uTexture1, uv);
  float a = src.a;
  vec3 st = clamp(unpremult(src), 0.0, 1.0);

  // exposure, flicker, white balance, dye matrix — linear light, premultiplied
  float fl = 1.0 + flick * 0.16 * ((fsHash(vec2(frame, 11.0)) - 0.5) * 1.4 + (fsHash(vec2(floor(frame / 3.0), 13.0)) - 0.5) * 0.6);
  vec3 c = fsS2L(st) * exp2(s_exposure) * fl;
  c *= vec3(1.0 + 0.16 * s_temp, 1.0 - 0.10 * s_tint, 1.0 - 0.16 * s_temp);
  c = vec3(dot(s_m0, c), dot(s_m1, c), dot(s_m2, c)) * a;

  // emulsion glows (premultiplied energy from the pyramid) — they add coverage
  vec3 halC = fsS2L(s_halCol) * (pyr.a * 2.0 / normH) * s_halAmt * halX * 2.6;
  vec3 bloomC = (pyr.rgb * 2.0 / normB) * s_bloomAmt * bloomX * 2.2;
  vec3 glow = halC + bloomC;
  float outA = clamp(a + min(luma(glow), 1.0), 0.0, 1.0);
  c += glow;

  // light leak: warm/magenta fog breathing in from the right; never adds coverage
  // (smoothstep edges are always written low < high: Tint in Chromium ≤131
  // rejects a constant reversed pair at compile time and the whole module,
  // hence the whole layer, goes black on WebGPU in the packaged app.)
  if (leak > 0.001) {
    float lt = uTime * leakSpeed;
    vec2 lp = vec2(0.92 + 0.08 * sin(lt * 0.37), 0.5 + 0.38 * sin(lt * 0.23 + 1.0));
    float dd = length((uv0 - lp) * vec2(1.0, 1.5));
    float lk = (1.0 - smoothstep(0.0, 0.85, dd)) * (0.55 + 0.45 * sin(lt * 0.9));
    lk += smoothstep(0.72, 1.0, uv0.x) * (0.5 + 0.5 * sin(lt * 0.5 + 2.0)) * 0.5;
    vec3 lc = mix(vec3(1.0, 0.36, 0.08), vec3(1.0, 0.14, 0.45), 0.5 + 0.5 * sin(lt * 0.31));
    c += lc * lk * leak * 0.7 * outA;
  }
  c /= max(outA, 1e-4);

  // the film curve, in display space
  vec3 d = fsL2S(c);
  d = (d - 0.45) * s_contrast + 0.45;
  d = clamp(d, 0.0, 1.0);
  d = mix(d, d * d * (3.0 - 2.0 * d), s_curve);
  d = mix(d, fsShoulder(d), s_roll);
  d = s_lift + d * (1.0 - s_lift);

  // split tone, hue only
  float lum = luma(d);
  float ws = 1.0 - smoothstep(0.0, 0.6, lum);
  float wh = smoothstep(0.4, 1.0, lum);
  d += (s_shadowCol - luma(s_shadowCol)) * ws * s_shadowAmt;
  d += (s_highCol - luma(s_highCol)) * wh * s_highAmt;
  lum = luma(d);
  d = mix(vec3(lum), d, s_sat);

  // lens vignette, centred on the layer's box
  vec2 lp0 = fxLocal(uv0);
  float dist = length((lp0 - 0.5) * vec2(fxAspect(), 1.0)) * 1.2;
  float v = 1.0 - smoothstep(s_vigRad - max(s_vigSoft, 1e-3), s_vigRad, dist);
  d *= mix(1.0, v, s_vigAmt * vigX);

  // grain, quieter in the highlights like a negative; lattice rides the layer
  // Snapped to 1/8 px: the box maths differs by ~1e-6 between backends, and an
  // integer lattice must not floor into different cells for that.
  if (s_grainAmt * grainX > 0.001) {
    vec2 p1080 = floor(fxCoord(uv0) / pxScale * 8.0 + 0.5) / 8.0;
    vec2 gp = p1080 / max(s_grainSize, 0.5);
    float gm = fsGrain(gp, 1.0);
    vec3 gc = vec3(fsGrain(gp, 4.0), fsGrain(gp, 8.0), fsGrain(gp, 12.0));
    vec3 gn = mix(vec3(gm), gc, s_grainChroma);
    float gw = mix(1.0, 1.0 - smoothstep(0.4, 1.0, luma(d)), 0.7);
    d += gn * s_grainAmt * grainX * 0.3 * gw;
  }

  return premult(clamp(d, 0.0, 1.0), outA);
}
`;

const FS_MAIN = FS_LIB + stockLadderGlsl() + FS_MAIN_FX;

export const FILM_STOCK_EFFECT = {
  id: FILM_STOCK_ID,
  name: 'Film Stock',
  group: 'Color',
  // Damage and weave ride the clip clock; the grain itself is static.
  animated: true,
  pro: true,
  // Halation and bloom bleed past the layer's alpha on purpose.
  layerMatte: 'expand',
  params: [
    // `popover`: our own list, so ↑/↓ swap the stock live with the list open.
    { key: 'preset', slot: 0, label: 'Stock', type: 'select', default: 0, primary: true, popover: true,
      options: FILM_STOCKS.map((s, i) => ({ value: i, label: s.name, group: s.group })) },
    { key: 'grain', slot: 1, label: 'Grain', min: 0, max: 300, step: 1, default: 100, suffix: '%' },
    { key: 'halation', slot: 2, label: 'Halation', min: 0, max: 300, step: 1, default: 100, suffix: '%' },
    { key: 'bloom', slot: 3, label: 'Bloom', min: 0, max: 300, step: 1, default: 100, suffix: '%' },
    { key: 'vignette', slot: 4, label: 'Vignette', min: 0, max: 300, step: 1, default: 100, suffix: '%' },
    { key: 'flicker', slot: 5, label: 'Flicker', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
    { key: 'weave', slot: 6, label: 'Gate Weave', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
    { key: 'leak', slot: 7, label: 'Light Leak', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
    { key: 'leakSpeed', slot: 8, label: 'Leak Speed', min: 10, max: 2000, step: 5, default: 100, suffix: '%' },
  ],
  colorPresets: [
    { name: 'Clean Scan', colors: [], params: { grain: 100, halation: 100, bloom: 100, vignette: 100, flicker: 0, weave: 0, leak: 0, leakSpeed: 100 } },
    { name: 'Projected Print', colors: [], params: { grain: 110, halation: 100, bloom: 100, vignette: 120, flicker: 20, weave: 25, leak: 0, leakSpeed: 100 } },
    { name: 'Worn Reel', colors: [], params: { grain: 130, halation: 110, bloom: 100, vignette: 140, flicker: 35, weave: 40, leak: 25, leakSpeed: 100 } },
    { name: 'Light Leak', colors: [], params: { grain: 100, halation: 100, bloom: 120, vignette: 100, flicker: 10, weave: 0, leak: 70, leakSpeed: 150 } },
  ],
  passes: [
    { key: 'bright', target: 'fsA', scale: 0.5, inputs: { uTexture: 'source' }, fragment: FS_LIB + FS_BRIGHT_FX,
      skipIf: glowsOff, alias: 'source',
      set: (p) => { const s = filmStockOf(p); return { 24: s.bloomThr, 25: s.halThr }; } },
    { key: 'down1', target: 'fsB', scale: 0.25, inputs: { uTexture: 'fsA' }, fragment: FS_DOWN_FX, skipIf: glowsOff, alias: 'source' },
    { key: 'down2', target: 'fsC', scale: 0.125, inputs: { uTexture: 'fsB' }, fragment: FS_DOWN_FX, skipIf: glowsOff, alias: 'source' },
    { key: 'down3', target: 'fsD', scale: 0.0625, inputs: { uTexture: 'fsC' }, fragment: FS_DOWN_FX, skipIf: glowsOff, alias: 'source' },
    { key: 'up2', target: 'fsE', scale: 0.125, inputs: { uTexture: 'fsC', uTexture1: 'fsD' }, fragment: FS_UP_FX, set: upSet(3), skipIf: glowsOff, alias: 'source' },
    { key: 'up1', target: 'fsF', scale: 0.25, inputs: { uTexture: 'fsB', uTexture1: 'fsE' }, fragment: FS_UP_FX, set: upSet(2), skipIf: glowsOff, alias: 'source' },
    { key: 'up0', target: 'fsG', scale: 0.5, inputs: { uTexture: 'fsA', uTexture1: 'fsF' }, fragment: FS_UP_FX, set: upSet(1), skipIf: glowsOff, alias: 'source' },
    { key: 'main', target: 'out', main: true, inputs: { uTexture: 'source', uTexture1: 'fsG' }, fragment: FS_MAIN, set: mainSet },
  ],
};
