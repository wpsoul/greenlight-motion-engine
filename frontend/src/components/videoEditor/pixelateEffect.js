import { fxBoxHomographies, homographyApply, invertHomography } from './homography';

/*
 * Pixelate — the picture rebuilt from flat blocks, as an Overlay Effect.
 *
 * Look-dev and gates: html/pixelate-lab/ + tests/pixelate-lab/verify_lab.mjs
 * (the maths), tests/pixelate/ (the app, both backends).
 *
 * Grid: Layer — the cells sit on the item's own box: they move, turn and tilt with
 * it, are clipped to the box like After Effects' Mosaic (an edge cell averages only
 * its inside part, so the item's edge never fades into a grey frame), and whatever
 * an earlier effect drew outside the box passes through untouched.
 * Grid: Frame — the cells are fixed to the frame and the item moves THROUGH them,
 * like a low-res screen; a cell the item only partly covers averages in the
 * transparency around it, so the item's edge becomes soft blocks.
 * An adjustment item has no box, so both grids are the frame there.
 *
 * Size is px at 1080p of the FRAME in both grids (what you set is what you see on
 * an item at 100 %). One cell is centred on the box / frame centre, so a keyed Size
 * grows the blocks out of the middle; Offset slides the grid in % of a cell (+Y =
 * down), so a keyed 0 → 100 loops pixel-identically.
 *
 * Passes (one texel per cell, never per pixel; total taps ≈ frame px / 4 whatever
 * the size):
 *   sub    Average only. One texel per SUB-cell: K×K taps 2 px apart, so each
 *          bilinear tap is a 2×2 box and the mean is exact up to 256 px cells.
 *          A big cell is split into S×S sub-cells (S = ceil(K / 8)) so no fragment
 *          loops more than 8×8 taps — one fragment looping 48×48 for a 120 px cell
 *          cost ~2 ms in the lab, latency-bound. Taps off the plate read its edge
 *          pixel, so a cell the frame cuts does not darken.
 *   cells  Average only, cells over 16 px: the S×S sub-cells → one texel per cell.
 *          Smaller cells: `sub` writes the cells directly and this pass aliases it.
 *   main   Full res: each pixel reads its cell's texel (2×2 supersampled, so cell
 *          edges on a turned or fractional grid are anti-aliased). Center reads the
 *          plate at the cell centre instead and skips `sub` / `cells`.
 *   Size < 1.5 → bypassIf: no pass at all.
 *
 * Box maths goes through fxLocal/fxFrame and the Frame grid is plain plate uv; both
 * port verbatim to the TSL twin (pixelateNodes.js), measured on both backends.
 */

export const PIXELATE_PARAMS = [
  { key: 'size', slot: 0, label: 'Size', min: 1, max: 400, step: 0.5, default: 24, suffix: 'px' },
  { key: 'stretch', slot: 1, label: 'Stretch', min: -100, max: 100, step: 1, default: 0, suffix: '%' },
  { key: 'sampling', slot: 2, label: 'Sampling', type: 'select', default: 0,
    options: [{ value: 0, label: 'Average' }, { value: 1, label: 'Center' }] },
  { key: 'grid', slot: 3, label: 'Grid', type: 'select', default: 0,
    options: [{ value: 0, label: 'Layer' }, { value: 1, label: 'Frame' }, { value: 2, label: 'Voxels', model3d: true }] },
  { key: 'offsetX', slot: 4, label: 'Offset X', min: -100, max: 100, step: 1, default: 0, suffix: '%' },
  { key: 'offsetY', slot: 5, label: 'Offset Y', min: -100, max: 100, step: 1, default: 0, suffix: '%' },
];

const MAX_TAPS = 128;   // per cell and axis
const SUB_TAPS = 8;     // per sub-cell and axis: the longest loop any fragment runs
const MAX_CELLS = 4096; // per axis

const clampN = (v, a, b, d) => {
  const n = Number(v);
  return Math.min(b, Math.max(a, Number.isFinite(n) ? n : d));
};

// The part of the box [0,S] the frame can see, in box px — a layer zoomed far past
// the frame must not ask for a grid of millions of cells it would never show.
function visibleBoxRect(box, S) {
  const { H } = fxBoxHomographies(box);
  const Hi = invertHomography(H);
  if (!Hi) return [0, 0, S[0], S[1]];
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    const [x, y, w] = homographyApply(Hi, u, v);
    if (!(w > 1e-9)) return [0, 0, S[0], S[1]];   // a corner behind the camera
    x0 = Math.min(x0, x / w); x1 = Math.max(x1, x / w);
    y0 = Math.min(y0, y / w); y1 = Math.max(y1, y / w);
  }
  const r = [Math.max(0, x0 * S[0]), Math.max(0, y0 * S[1]), Math.min(S[0], x1 * S[0]), Math.min(S[1], y1 * S[1])];
  return r[2] > r[0] && r[3] > r[1] ? r : null;
}

/*
 * The grid for these params on this plate, in GRID px (y up): the box's own px on
 * a Layer grid, plate px on a Frame grid. `ctx` is the chain's per-effect hook
 * context ({ ref, width, height, box }) — one object for all of this instance's
 * passes in a frame, so the grid is computed once per frame.
 */
const gridCache = new WeakMap();
export function pixelateGrid(p, ctx) {
  const hit = ctx ? gridCache.get(ctx) : null;
  if (hit && hit.p === p) return hit.grid;
  const W = Math.max(1, Number(ctx?.width) || 1);
  const H = Math.max(1, Number(ctx?.height) || 1);
  const ref = Number(ctx?.ref) > 0 ? Number(ctx.ref) : H / 1080;
  const box = ctx?.box && Array.isArray(ctx.box.sizePx) ? ctx.box : null;
  const frame = !box || Number(p?.grid) === 1;
  const S = frame ? [W, H] : [Math.max(1, box.sizePx[0]), Math.max(1, box.sizePx[1])];
  const size = clampN(p?.size, 1, 400, 24) * ref;
  const aspect = Math.pow(8, clampN(p?.stretch, -100, 100, 0) / 100);
  const cell = [Math.max(1, size * Math.sqrt(aspect)), Math.max(1, size / Math.sqrt(aspect))];
  const origin = [
    S[0] / 2 - cell[0] / 2 + (clampN(p?.offsetX, -100, 100, 0) / 100) * cell[0],
    S[1] / 2 - cell[1] / 2 - (clampN(p?.offsetY, -100, 100, 0) / 100) * cell[1],
  ];
  const region = frame ? [0, 0, W, H] : visibleBoxRect(box, S);
  let cMin = [0, 0];
  let count = [1, 1];
  if (region) {
    cMin = [Math.floor((region[0] - origin[0]) / cell[0]), Math.floor((region[1] - origin[1]) / cell[1])];
    const cMax = [Math.floor((region[2] - 1e-3 - origin[0]) / cell[0]), Math.floor((region[3] - 1e-3 - origin[1]) / cell[1])];
    count = [
      Math.min(MAX_CELLS, Math.max(1, cMax[0] - cMin[0] + 1)),
      Math.min(MAX_CELLS, Math.max(1, cMax[1] - cMin[1] + 1)),
    ];
  }
  const K = cell.map((c) => Math.min(MAX_TAPS, Math.max(1, Math.ceil(c / 2))));
  const sub = K.map((k) => Math.ceil(k / SUB_TAPS));
  const taps = K.map((k, i) => Math.ceil(k / sub[i]));
  const grid = { frame, S, cell, origin, cMin, count, sub, taps, visible: !!region };
  if (ctx) gridCache.set(ctx, { p, grid });
  return grid;
}

// Slots 6–21 carry the per-frame grid (set() writes them after the registry
// params 0–5 are applied); 24–27 stay the chain's own.
function gridSlots(p, c) {
  const g = pixelateGrid(p, c);
  return {
    6: g.frame ? 1 : 0,
    8: g.S[0], 9: g.S[1],
    10: g.cell[0], 11: g.cell[1],
    12: g.origin[0], 13: g.origin[1],
    14: g.cMin[0], 15: g.cMin[1],
    16: g.count[0], 17: g.count[1],
    18: g.sub[0], 19: g.sub[1],
    20: g.taps[0], 21: g.taps[1],
  };
}

// ── GLSL ────────────────────────────────────────────────────────────────────
const PX_LIB = /* glsl */ `
vec2 pxS() { return vec2(uParams[8], uParams[9]); }
vec2 pxCell() { return vec2(uParams[10], uParams[11]); }
vec2 pxOrigin() { return vec2(uParams[12], uParams[13]); }
vec2 pxCMin() { return vec2(uParams[14], uParams[15]); }
vec2 pxCount() { return vec2(uParams[16], uParams[17]); }
vec2 pxSub() { return vec2(uParams[18], uParams[19]); }
// Grid px (y up) <-> plate uv: the frame itself, or the item's box.
vec2 pxToUv(vec2 g) { return uParams[6] > 0.5 ? g / pxS() : fxFrame(g / pxS()); }
vec2 pxToGrid(vec2 uv) { return uParams[6] > 0.5 ? uv * pxS() : fxLocal(uv) * pxS(); }
`;

const PX_SUB_FX = `${PX_LIB}
vec4 fx(vec2 uv) {
  vec2 sub = pxSub();
  vec2 ij = floor(uv * pxCount() * sub);
  vec2 cell = floor((ij + 0.5) / sub);
  vec2 s = ij - cell * sub;
  vec2 lo = pxOrigin() + (pxCMin() + cell) * pxCell();
  vec2 hi = lo + pxCell();
  if (uParams[6] < 0.5) { lo = max(lo, vec2(0.0)); hi = min(hi, pxS()); }
  vec2 span = (hi - lo) / sub;
  vec2 base = lo + s * span;
  vec2 nt = vec2(uParams[20], uParams[21]);
  vec4 acc = vec4(0.0);
  for (int y = 0; y < ${SUB_TAPS}; y++) {
    if (float(y) >= nt.y) break;
    for (int x = 0; x < ${SUB_TAPS}; x++) {
      if (float(x) >= nt.x) break;
      acc += texture2D(uTexture, clamp(pxToUv(base + (vec2(float(x), float(y)) + 0.5) / nt * span), 0.0, 1.0));
    }
  }
  return acc / (nt.x * nt.y);
}
`;

const PX_CELLS_FX = `${PX_LIB}
vec4 fx(vec2 uv) {
  vec2 sub = pxSub();
  vec2 size = pxCount() * sub;
  vec2 first = floor(uv * pxCount()) * sub;
  vec4 acc = vec4(0.0);
  for (int y = 0; y < ${MAX_TAPS / SUB_TAPS}; y++) {
    if (float(y) >= sub.y) break;
    for (int x = 0; x < ${MAX_TAPS / SUB_TAPS}; x++) {
      if (float(x) >= sub.x) break;
      acc += texture2D(uTexture, (first + vec2(float(x), float(y)) + 0.5) / size);
    }
  }
  return acc / (sub.x * sub.y);
}
`;

const PX_MAIN_FX = `${PX_LIB}
vec4 pxAt(vec2 uv, vec4 src) {
  vec2 S = pxS();
  vec2 g = pxToGrid(uv);
  vec2 c = floor((g - pxOrigin()) / pxCell());
  vec2 k = c - pxCMin();
  vec2 count = pxCount();
  vec4 avg = texture2D(uTexture1, (clamp(k, vec2(0.0), count - 1.0) + 0.5) / count);
  vec2 lo = pxOrigin() + c * pxCell();
  vec2 hi = lo + pxCell();
  if (uParams[6] < 0.5) { lo = max(lo, vec2(0.0)); hi = min(hi, S); }
  vec4 ctr = texture2D(uTexture, clamp(pxToUv(0.5 * (lo + hi)), 0.0, 1.0));
  bool inBox = uParams[6] > 0.5 || (g.x >= 0.0 && g.y >= 0.0 && g.x < S.x && g.y < S.y);
  bool inGrid = k.x >= 0.0 && k.y >= 0.0 && k.x < count.x && k.y < count.y;
  return (inBox && inGrid) ? (uParams[2] > 0.5 ? ctr : avg) : src;
}
vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  vec2 h = 0.25 / uResolution;
  return 0.25 * (pxAt(uv - h, src) + pxAt(uv + vec2(h.x, -h.y), src)
    + pxAt(uv + vec2(-h.x, h.y), src) + pxAt(uv + h, src));
}
`;

const centerMode = (p) => Number(p?.sampling) === 1;
const noSplit = (p, c) => { const g = pixelateGrid(p, c); return g.sub[0] === 1 && g.sub[1] === 1; };
const subSize = (p, c) => { const g = pixelateGrid(p, c); return [g.count[0] * g.sub[0], g.count[1] * g.sub[1]]; };
const cellsSize = (p, c) => pixelateGrid(p, c).count;

export const PIXELATE_EFFECT = {
  id: 'pixelate',
  name: 'Pixelate',
  group: 'Display',
  animated: false,
  // The blocks ARE the new edge: clipping them back to the item's smooth
  // silhouette would undo the look. Clip to layer stays available per instance.
  layerMatte: 'expand',
  params: PIXELATE_PARAMS,
  colorPresets: [
    { name: 'Soft Blocks', params: { size: 36, stretch: 0, sampling: 0, grid: 1, offsetX: 0, offsetY: 0 } },
    { name: 'Mosaic', params: { size: 22, stretch: 0, sampling: 0, grid: 0, offsetX: 0, offsetY: 0 } },
    { name: '8-bit', params: { size: 10, stretch: 0, sampling: 1, grid: 1, offsetX: 0, offsetY: 0 } },
    { name: 'Giant Pixels', params: { size: 120, stretch: 0, sampling: 0, grid: 0, offsetX: 0, offsetY: 0 } },
    { name: 'Columns', params: { size: 30, stretch: -80, sampling: 0, grid: 1, offsetX: 0, offsetY: 0 } },
    { name: 'Rows', params: { size: 26, stretch: 80, sampling: 0, grid: 1, offsetX: 0, offsetY: 0 } },
  ],
  bypassIf: (p, c) => !(Number(p?.size) >= 1.5) || !pixelateGrid(p, c).visible,
  passes: [
    { key: 'sub', target: 'pxS', size: subSize, nearest: true, inputs: { uTexture: 'source' },
      fragment: PX_SUB_FX, set: gridSlots, skipIf: centerMode, alias: 'source' },
    { key: 'cells', target: 'pxC', size: cellsSize, nearest: true, inputs: { uTexture: 'pxS' },
      fragment: PX_CELLS_FX, set: gridSlots, skipIf: (p, c) => centerMode(p) || noSplit(p, c), alias: 'pxS' },
    { key: 'main', target: 'out', main: true, inputs: { uTexture: 'source', uTexture1: 'pxC' },
      fragment: PX_MAIN_FX, set: gridSlots },
  ],
};
