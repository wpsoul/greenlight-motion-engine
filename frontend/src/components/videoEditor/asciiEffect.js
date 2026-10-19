import * as THREE from 'three';

/*
 * ASCII — rebuilds the picture from characters, as an Overlay Effect.
 *
 * Look-dev and gates: html/overlay-effects-lab.html +
 * tests/layer-effect-labs/verify_overlay_effects.js.
 *
 * Passes (all in the layer's own box, so on a layer the character grid is
 * printed on the artwork and moves, rotates and scales with it — same rule as
 * Halftone; an adjustment layer's box is the frame):
 *
 *   cells  one texel per character: stratified taps average the premultiplied
 *          colour under the cell (inside the box and the frame only).
 *   sobel  ½ res, only with Edge Lines: box-space luminance gradient → a
 *          one-hot vote for the contour direction (– / | \).
 *   votes  one texel per character, only with Edge Lines: the votes averaged;
 *          the winning direction and its share.
 *   main   full res: tone → glyph from a density-sorted ramp (or an edge
 *          glyph), sampled from a cached, mipmapped atlas with ANALYTIC
 *          derivatives (fract() breaks automatic LOD at every cell border).
 *
 * The atlas is a canvas bake keyed by (font, characters) — rebuilt only when
 * one of those changes, never per frame; a small LRU disposes the rest.
 * Glyphs are sorted by MEASURED ink, so any custom string maps dark → light.
 * The shade blocks ░▒▓█ are drawn, not typeset: font block glyphs rarely fill
 * the line height, which leaves a dark seam between every row.
 *
 * Box maths goes through fxLocal/fxFrame, which are orientation-normalised on
 * both backends — the TSL twin (asciiNodes.js) ports it verbatim.
 */

export const ASCII_CHARSETS = [
  { value: 0, label: 'Standard', chars: ' .:-=+*#%@' },
  { value: 1, label: 'Detailed', chars: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$" },
  { value: 2, label: 'Blocks', chars: ' ░▒▓█' },
  { value: 3, label: 'Binary', chars: ' 01' },
  { value: 4, label: 'Dots', chars: ' ·•●' },
  { value: 5, label: 'Matrix', chars: ' .:ｦｱｳｴｵｶｷｹｺｻｼｽｾｿﾀﾂﾃﾅﾆﾇﾈﾊﾋﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ01' },
  { value: 6, label: 'Custom', chars: null },
];
const MONO = 'Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';
export const ASCII_FONTS = [
  { value: 0, label: 'Mono', family: MONO, weight: 500 },
  { value: 1, label: 'Mono Bold', family: MONO, weight: 800 },
  { value: 2, label: 'Sans Bold', family: '"Helvetica Neue", Arial, "Hiragino Sans", sans-serif', weight: 800 },
  { value: 3, label: 'Serif', family: 'Georgia, "Times New Roman", "Hiragino Mincho ProN", serif', weight: 500 },
];

// Atlas geometry — fixed so the shader needs only the glyph count, the glyph
// width and the row count (slots 18–20). Glyph box E px tall, padded against
// mip bleed, ATLAS_COLS slots per row.
const E = 64;
const FONT_PX = 54;
const PAD = 12;
const ATLAS_COLS = 16;
const MAX_GLYPHS = 96;
const EDGE_GLYPHS = ['-', '/', '|', '\\'];   // contour 0°, 45°, 90°, 135° (box y up)
const SHADES = { '░': 0.25, '▒': 0.5, '▓': 0.75, '█': 1 };
export const ASCII_CUSTOM_MAX = 80;

export function asciiCharsFor(p) {
  const set = ASCII_CHARSETS.find((c) => c.value === Number(p?.charset)) || ASCII_CHARSETS[0];
  const raw = set.chars == null
    ? ` ${String(p?.customChars ?? '').slice(0, ASCII_CUSTOM_MAX)}`
    : set.chars;
  const glyphs = Array.from(new Set(Array.from(raw))).filter((g) => g !== '\n' && g !== '\t');
  return glyphs.slice(0, MAX_GLYPHS);
}

const ATLAS_LRU = 4;
const atlasCache = new Map();

function drawGlyph(ctx, g, x, y, gw) {
  const lvl = SHADES[g];
  if (lvl == null) { ctx.fillText(g, x + gw / 2, y + E / 2 + E * 0.04); return; }
  if (lvl >= 1) { ctx.fillRect(x, y, gw, E); return; }
  const nx = 4;
  const ny = 8;
  const sw = gw / nx;
  const sh = E / ny;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = (i & 1) + 2 * (j & 1);
      const on = lvl === 0.5 ? ((i + j) & 1) === 0 : (lvl < 0.5 ? k === 0 : k !== 3);
      if (on) ctx.fillRect(x + i * sw, y + j * sh, sw, sh);
    }
  }
}

/*
 * The glyph atlas for these params: { texture, n, gw, rows, aspect }. `n` ramp
 * glyphs (sorted by ink) come first, then the four edge glyphs. Null where
 * there is no DOM (SSR, the capabilities generator).
 */
export function getAsciiAtlas(p) {
  if (typeof document === 'undefined') return null;
  const glyphs = asciiCharsFor(p);
  const font = ASCII_FONTS.find((f) => f.value === Number(p?.font)) || ASCII_FONTS[1];
  const key = `${font.value}|${glyphs.join('')}`;
  const hit = atlasCache.get(key);
  if (hit) {
    atlasCache.delete(key);
    atlasCache.set(key, hit);
    return hit;
  }
  const fontCss = `${font.weight} ${FONT_PX}px ${font.family}`;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = fontCss;
  let maxAdv = 0;
  for (const g of [...glyphs, ...EDGE_GLYPHS]) maxAdv = Math.max(maxAdv, measure.measureText(g).width);
  const aspect = Math.min(1.2, Math.max(0.45, maxAdv / E));
  const gw = Math.ceil(aspect * E);

  const dc = document.createElement('canvas');
  dc.width = gw;
  dc.height = E;
  const dx = dc.getContext('2d', { willReadFrequently: true });
  const ink = glyphs.map((g) => {
    dx.clearRect(0, 0, gw, E);
    dx.font = fontCss;
    dx.fillStyle = '#fff';
    dx.textAlign = 'center';
    dx.textBaseline = 'middle';
    drawGlyph(dx, g, 0, 0, gw);
    const d = dx.getImageData(0, 0, gw, E).data;
    let s = 0;
    for (let i = 3; i < d.length; i += 4) s += d[i];
    return s;
  });
  const order = glyphs.map((g, i) => ({ g, d: ink[i], i }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.g);
  const all = [...order, ...EDGE_GLYPHS];
  const slotW = gw + 2 * PAD;
  const slotH = E + 2 * PAD;
  const rows = Math.ceil(all.length / ATLAS_COLS);
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * slotW;
  canvas.height = rows * slotH;
  const ax = canvas.getContext('2d');
  ax.font = fontCss;
  ax.fillStyle = '#fff';
  ax.textAlign = 'center';
  ax.textBaseline = 'middle';
  all.forEach((g, i) => {
    const sx = (i % ATLAS_COLS) * slotW + PAD;
    const sy = Math.floor(i / ATLAS_COLS) * slotH + PAD;
    ax.save();
    ax.beginPath();
    ax.rect(sx, sy, gw, E);
    ax.clip();
    drawGlyph(ax, g, sx, sy, gw);
    ax.restore();
  });
  const texture = new THREE.CanvasTexture(canvas);
  // NOT flipped: v = canvas row / height on both backends. A flipY canvas
  // upload samples upright on WebGL and upside down on WebGPU (measured: every
  // glyph inverted), while an unflipped one is row 0 = v 0 on both.
  texture.flipY = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  const entry = { key, texture, n: order.length, gw, rows, aspect, order };
  atlasCache.set(key, entry);
  while (atlasCache.size > ATLAS_LRU) {
    const [oldKey, old] = atlasCache.entries().next().value;
    atlasCache.delete(oldKey);
    old.texture.dispose();
  }
  return entry;
}

/*
 * Character-grid geometry in BOX px (y up), shared by every pass's set():
 * the box size, cell size (Cell Size is px at 1080p of the box, like
 * Halftone), the centred grid and the per-cell tap count.
 */
const gridCache = new WeakMap();
export function asciiGrid(p, ctx) {
  const box = ctx?.box && Array.isArray(ctx.box.sizePx) ? ctx.box.sizePx : null;
  const S = box ? [Math.max(1, box[0]), Math.max(1, box[1])] : [Math.max(1, ctx?.width || 1), Math.max(1, ctx?.height || 1)];
  const cached = p ? gridCache.get(p) : null;
  if (cached && cached.S[0] === S[0] && cached.S[1] === S[1]) return cached;
  const atlas = getAsciiAtlas(p);
  const aspect = atlas ? atlas.aspect : 0.6;
  const ch = Math.max(2, (Number(p?.cellSize) || 14) * (S[1] / 1080));
  const cw = Math.max(1, ch * aspect);
  const cols = Math.min(2048, Math.max(1, Math.ceil(S[0] / cw)));
  const rows = Math.min(2048, Math.max(1, Math.ceil(S[1] / ch)));
  const grid = {
    S, cw, ch, cols, rows,
    ox: (S[0] - cols * cw) / 2,
    oy: (S[1] - rows * ch) / 2,
    taps: Math.max(2, Math.min(8, Math.ceil(ch / 4))),
    atlas,
  };
  if (p) gridCache.set(p, grid);
  return grid;
}

// Slots 12–25 carry the per-frame geometry (set() writes them after the
// registry params 0–11 are applied).
function gridSlots(p, c) {
  const g = asciiGrid(p, c);
  const e01 = Math.max(0, Math.min(1, (Number(p?.edgeLines) || 0) / 100));
  return {
    12: g.cw, 13: g.ch, 14: g.ox, 15: g.oy, 16: g.cols, 17: g.rows,
    18: g.atlas ? g.atlas.n : 1, 19: g.atlas ? g.atlas.gw : 38, 20: g.atlas ? g.atlas.rows : 1,
    21: g.taps, 22: g.S[0], 23: g.S[1],
    24: 0.9 - 0.78 * e01,     // Sobel magnitude threshold
    25: 0.3 - 0.18 * e01,     // share of a cell's votes that makes an edge glyph
  };
}

// ── GLSL ────────────────────────────────────────────────────────────────────
const AS_LIB = /* glsl */ `
vec2 asS() { return vec2(uParams[22], uParams[23]); }
vec2 asCell() { return vec2(uParams[12], uParams[13]); }
vec2 asOrigin() { return vec2(uParams[14], uParams[15]); }
vec2 asGrid() { return vec2(uParams[16], uParams[17]); }
`;

// Average of one cell's taps from uTexture (colour for 'cells', votes for
// 'votes'), inside the box and the frame only.
const AS_AVERAGE = /* glsl */ `
vec4 asAverage(vec2 uv) {
  vec2 grid = asGrid();
  vec2 S = asS();
  vec2 cellPx = asCell();
  float nt = uParams[21];
  vec2 ci = min(floor(uv * grid), grid - 1.0);
  vec2 p0 = asOrigin() + ci * cellPx;
  vec4 acc = vec4(0.0);
  float cnt = 0.0;
  for (int y = 0; y < 8; y++) {
    if (float(y) >= nt) break;
    for (int x = 0; x < 8; x++) {
      if (float(x) >= nt) break;
      vec2 bu = (p0 + (vec2(float(x), float(y)) + 0.5) / nt * cellPx) / S;
      vec2 fu = fxFrame(bu);
      float inside = step(0.0, bu.x) * step(0.0, bu.y) * step(bu.x, 1.0) * step(bu.y, 1.0)
        * step(0.0, fu.x) * step(0.0, fu.y) * step(fu.x, 1.0) * step(fu.y, 1.0);
      acc += texture2D(uTexture, clamp(fu, 0.0, 1.0)) * inside;
      cnt += inside;
    }
  }
  return cnt > 0.0 ? acc / cnt : vec4(0.0);
}
`;

const AS_CELLS_FX = `${AS_LIB}${AS_AVERAGE}
vec4 fx(vec2 uv) { return asAverage(uv); }
`;

const AS_VOTES_FX = `${AS_LIB}${AS_AVERAGE}
vec4 fx(vec2 uv) {
  vec4 a = asAverage(uv);
  float m = a.r;
  float d = 0.0;
  if (a.g > m) { m = a.g; d = 1.0; }
  if (a.b > m) { m = a.b; d = 2.0; }
  if (a.a > m) { m = a.a; d = 3.0; }
  return vec4(m, d * 0.25, 0.0, 1.0);
}
`;

// Box-space luminance gradient (2 box px steps at ½ res), quantised to four
// contour directions and written as a one-hot vote.
const AS_SOBEL_FX = `${AS_LIB}
float asLum(vec2 bu) { return luma(texture2D(uTexture, clamp(fxFrame(bu), 0.0, 1.0)).rgb); }
vec4 fx(vec2 uv) {
  vec2 bu = fxLocal(uv);
  vec2 t = 2.0 / asS();
  float tl = asLum(bu + vec2(-t.x, t.y));
  float tc = asLum(bu + vec2(0.0, t.y));
  float tr = asLum(bu + t);
  float l = asLum(bu - vec2(t.x, 0.0));
  float r = asLum(bu + vec2(t.x, 0.0));
  float bl = asLum(bu - t);
  float bc = asLum(bu - vec2(0.0, t.y));
  float br = asLum(bu + vec2(t.x, -t.y));
  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
  if (length(vec2(gx, gy)) < uParams[24]) return vec4(0.0);
  float e = mod(atan(gy, gx) + 1.5707963, 3.1415927);
  float q = mod(floor(e / 0.78539816 + 0.5), 4.0);
  if (q < 0.5) return vec4(1.0, 0.0, 0.0, 0.0);
  if (q < 1.5) return vec4(0.0, 1.0, 0.0, 0.0);
  if (q < 2.5) return vec4(0.0, 0.0, 1.0, 0.0);
  return vec4(0.0, 0.0, 0.0, 1.0);
}
`;

const AS_MAIN_FX = `${AS_LIB}
float asBayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float asBayer4(vec2 a) { return asBayer2(0.5 * a) * 0.25 + asBayer2(a); }
vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  vec2 grid = asGrid();
  float N = max(uParams[18], 1.0);
  float gw = uParams[19];
  float atlasRows = max(uParams[20], 1.0);
  vec2 cc = (fxLocal(uv) * asS() - asOrigin()) / asCell();
  vec2 cf = floor(cc);
  vec2 ci = clamp(cf, vec2(0.0), grid - 1.0);
  vec2 f = cc - cf;
  vec2 cuv = (ci + 0.5) / grid;
  vec4 cell = texture2D(uTexture1, cuv);
  vec4 edge = texture2D(uTexture2, cuv);
  // Analytic LOD: derivatives of the CONTINUOUS cell coordinate, taken here at
  // the top level before any branch.
  vec2 ddx = dFdx(cc);
  vec2 ddy = dFdy(cc);

  vec3 c3 = unpremult(cell);
  float v = clamp((luma(c3) - 0.5) * (uParams[7] / 100.0) + 0.5 + uParams[8] / 200.0, 0.0, 1.0);
  if (uParams[10] > 0.5) v = 1.0 - v;
  v *= clamp(cell.a, 0.0, 1.0);
  // Ordered dither per CELL: a slow gradient otherwise switches glyph along one
  // iso-line, which reads as a drawn contour. Fixed per cell, so video is stable.
  float dith = uParams[9] / 100.0;
  if (dith > 0.0 && v > 0.0) v += (asBayer4(ci) - 0.46875) * dith / N;
  float g = clamp(floor(v * N), 0.0, N - 1.0);
  if (uParams[11] > 0.0 && edge.r > uParams[25] && cell.a > 0.05) g = N + floor(edge.g * 4.0 + 0.5);

  float col = mod(g, 16.0);
  float row = floor((g + 0.5) / 16.0);
  float slotW = gw + 24.0;
  float atlasW = 16.0 * slotW;
  float atlasH = atlasRows * 88.0;
  // Atlas rows run top-down (unflipped upload); the cell's f.y runs up.
  vec2 auv = vec2((col * slotW + 12.0 + f.x * gw) / atlasW,
                  (row * 88.0 + 12.0 + (1.0 - f.y) * 64.0) / atlasH);
  vec2 gdx = vec2(ddx.x * gw / atlasW, -ddx.y * 64.0 / atlasH);
  vec2 gdy = vec2(ddy.x * gw / atlasW, -ddy.y * 64.0 / atlasH);
  float cov = textureGrad(uLUT, auv, gdx, gdy).a;

  vec3 fg;
  float mode = uParams[3];
  if (mode < 0.5) {
    float m = max(max(c3.r, c3.g), c3.b);
    fg = mix(c3, c3 / max(m, 1e-3), uParams[4] / 100.0);
  } else if (mode < 1.5) {
    fg = uColors[0];
  } else {
    fg = mix(uColors[0], uColors[1], v);
  }
  float bgMode = uParams[5];
  vec4 bg = bgMode < 0.5 ? vec4(uColors[2], 1.0)
    : (bgMode < 1.5 ? vec4(src.rgb * (uParams[6] / 100.0), src.a) : vec4(0.0));
  return vec4(clamp(fg, 0.0, 1.0), 1.0) * cov + bg * (1.0 - cov);
}
`;

const edgesOff = (p) => !((Number(p?.edgeLines) || 0) > 0);
const gridSize = (p, c) => { const g = asciiGrid(p, c); return [g.cols, g.rows]; };

export const ASCII_EFFECT = {
  id: 'ascii',
  name: 'ASCII',
  group: 'Print',
  animated: false,
  // The background paints the whole box; on a layer it is cut back to the
  // layer's shape (the output's alpha is not the source's, so the matte clip
  // multiplies once — no squaring).
  layerMatte: 'clip',
  usesGlyphAtlas: true,
  params: [
    { key: 'cellSize', slot: 0, label: 'Cell Size', min: 6, max: 400, step: 1, default: 14, suffix: 'px' },
    { key: 'charset', slot: 1, label: 'Characters', type: 'select', default: 0, primary: true,
      options: ASCII_CHARSETS.map(({ value, label }) => ({ value, label })) },
    { key: 'customChars', type: 'text', label: 'Custom Characters', default: 'GREENLIGHT', maxLength: ASCII_CUSTOM_MAX,
      showIf: { key: 'charset', equals: 6 } },
    { key: 'font', slot: 2, label: 'Font', type: 'select', default: 1,
      options: ASCII_FONTS.map(({ value, label }) => ({ value, label })) },
    { key: 'colorMode', slot: 3, label: 'Color', type: 'select', default: 0,
      options: [{ value: 0, label: 'Source' }, { value: 1, label: 'Single Color' }, { value: 2, label: 'Gradient' }] },
    { key: 'colorBoost', slot: 4, label: 'Color Boost', min: 0, max: 100, step: 1, default: 60, suffix: '%',
      showIf: { key: 'colorMode', equals: 0 } },
    { key: 'background', slot: 5, label: 'Background', type: 'select', default: 0,
      options: [{ value: 0, label: 'Solid' }, { value: 1, label: 'Source' }, { value: 2, label: 'None' }] },
    { key: 'sourceLevel', slot: 6, label: 'Source Level', min: 0, max: 100, step: 1, default: 20, suffix: '%',
      showIf: { key: 'background', equals: 1 } },
    { key: 'contrast', slot: 7, label: 'Contrast', min: 0, max: 300, step: 1, default: 120, suffix: '%' },
    { key: 'brightness', slot: 8, label: 'Brightness', min: -100, max: 100, step: 1, default: 0 },
    { key: 'dither', slot: 9, label: 'Dither', min: 0, max: 100, step: 1, default: 60, suffix: '%' },
    { key: 'invert', slot: 10, label: 'Invert Ramp', type: 'select', default: 0,
      options: [{ value: 0, label: 'Off' }, { value: 1, label: 'On' }] },
    { key: 'edgeLines', slot: 11, label: 'Edge Lines', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
    { key: 'glyphColor', type: 'color', colorSlot: 0, label: 'Glyph Color', default: '#39ff7a',
      showIf: { key: 'colorMode', oneOf: [1, 2] } },
    { key: 'lightColor', type: 'color', colorSlot: 1, label: 'Light Color', default: '#eaffd6',
      showIf: { key: 'colorMode', equals: 2 } },
    { key: 'backgroundColor', type: 'color', colorSlot: 2, label: 'Background Color', default: '#050505',
      showIf: { key: 'background', equals: 0 } },
  ],
  colorPresets: [
    { name: 'Terminal', params: { cellSize: 14, charset: 0, font: 1, colorMode: 1, glyphColor: '#39ff7a', background: 0, backgroundColor: '#040806', contrast: 130, brightness: 0, invert: 0, edgeLines: 0 } },
    { name: 'Color', params: { cellSize: 12, charset: 1, font: 1, colorMode: 0, colorBoost: 60, background: 0, backgroundColor: '#050505', contrast: 120, brightness: 0, invert: 0, edgeLines: 0 } },
    { name: 'Blocks', params: { cellSize: 16, charset: 2, font: 0, colorMode: 0, colorBoost: 30, background: 1, sourceLevel: 12, contrast: 110, brightness: 0, invert: 0, edgeLines: 0 } },
    { name: 'Binary', params: { cellSize: 12, charset: 3, font: 1, colorMode: 2, glyphColor: '#0f5c34', lightColor: '#b8ffd8', background: 0, backgroundColor: '#020604', contrast: 140, brightness: 5, invert: 0, edgeLines: 0 } },
    { name: 'Matrix', params: { cellSize: 16, charset: 5, font: 2, colorMode: 2, glyphColor: '#0a6b2a', lightColor: '#d6ffe0', background: 0, backgroundColor: '#010402', contrast: 150, brightness: 0, invert: 0, edgeLines: 0 } },
    { name: 'Edges', params: { cellSize: 12, charset: 0, font: 1, colorMode: 1, glyphColor: '#f4f1ea', background: 0, backgroundColor: '#070707', contrast: 120, brightness: -10, invert: 0, edgeLines: 65 } },
    { name: 'Paper', params: { cellSize: 11, charset: 1, font: 3, colorMode: 1, glyphColor: '#1d1b18', background: 0, backgroundColor: '#f1ece2', contrast: 130, brightness: 0, invert: 1, edgeLines: 0 } },
  ],
  passes: [
    { key: 'cells', target: 'asC', size: gridSize, inputs: { uTexture: 'source' }, fragment: AS_CELLS_FX, set: gridSlots },
    { key: 'sobel', target: 'asS', scale: 0.5, inputs: { uTexture: 'source' }, fragment: AS_SOBEL_FX,
      set: gridSlots, skipIf: edgesOff, alias: 'asC' },
    { key: 'votes', target: 'asE', size: gridSize, inputs: { uTexture: 'asS' }, fragment: AS_VOTES_FX,
      set: gridSlots, skipIf: edgesOff, alias: 'asC' },
    { key: 'main', target: 'out', main: true,
      inputs: { uTexture: 'source', uTexture1: 'asC', uTexture2: 'asE' },
      fragment: AS_MAIN_FX, set: gridSlots },
  ],
};
