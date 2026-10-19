// Raster → editable bezier outline, entirely on this device.
//
// Written against html/image-vectorize.html, which benches this against VTracer
// and Potrace on real logos — that harness stays the place to tune it.
//
// Why not a WASM tracer: both of the obvious ones lose. VTracer's binary mode
// collapses a logo on an opaque background into one convex blob (52% IoU on the
// bench — the "it traced an octagon" bug), and Potrace, while excellent, is
// GPL-2.0 and needs a DOM so it cannot run in this worker. This does ~99.5% IoU
// with fewer anchors, no download, and no licence entanglement.
//
// The pipeline, and why each stage exists:
//   1. a CONTINUOUS 0..1 inside-ness field, not a binary mask — the 0.5 iso-line
//      of an anti-aliased logo IS its true edge, so the trace comes out smooth
//      instead of stair-stepped and needing to be smoothed back
//   2. sub-pixel marching squares → every contour, outer and holes
//   3. light smoothing + RDP → corner detection
//   4. Schneider least-squares cubic fit against the DENSE contour
//   5. holes bridged into the single point list the editor can store
//
// No DOM, no network: safe in a worker, works offline.

/* ── vector helpers ──────────────────────────────────────────────────────── */

const V = {
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  mul: (a, s) => ({ x: a.x * s, y: a.y * s }),
  dot: (a, b) => (a.x * b.x) + (a.y * b.y),
  len: (a) => Math.hypot(a.x, a.y),
  neg: (a) => ({ x: -a.x, y: -a.y }),
  norm: (a) => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; },
};

const round4 = (n) => Math.round(n * 10000) / 10000;

export const TRACE_DEFAULTS = {
  channel: 'auto',      // auto | alpha | color | luma
  autoThreshold: true,
  threshold: 0.5,
  invert: false,
  blur: 0,
  reach: 0.4,           // hysteresis low bar, as a share of the threshold
  maskSmooth: 4,        // px @ 1024 — 2D mask smoothing, the anti-wobble control
  speckle: 40,          // px² — contours smaller than this are noise
  smooth: 1,            // moving-average radius on the raw contour
  epsilon: 0.4,         // px — simplify tolerance, drives corner detection
  cornerDeg: 40,        // turn angle that counts as a corner
  fitError: 0.8,        // px — cubic fit tolerance
  maxAnchors: 160,
  bridgeHoles: true,
  pieces: 'all',        // all | largest
};

// A piece below this share of the biggest one is noise, not part of the mark.
const MIN_PIECE_FRACTION = 0.01;
const MAX_PIECES = 24;

// Detail presets for the panel. Anchor budget is what actually decides how
// editable the result is, so it leads.
export const TRACE_DETAIL = {
  low: { maxAnchors: 48, epsilon: 0.9, fitError: 1.6, smooth: 2, maskSmooth: 5 },
  medium: { maxAnchors: 120, epsilon: 0.4, fitError: 0.8, smooth: 1, maskSmooth: 4 },
  high: { maxAnchors: 320, epsilon: 0.25, fitError: 0.4, smooth: 1, maskSmooth: 3 },
};

/* ── 1 · mask field ──────────────────────────────────────────────────────── */

function otsu(values) {
  const bins = new Float64Array(256);
  for (let i = 0; i < values.length; i += 1) {
    bins[Math.max(0, Math.min(255, Math.round(values[i] * 255)))] += 1;
  }
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * bins[i];
  let sumB = 0; let wB = 0; let best = 0; let bestVar = -1;
  for (let t = 0; t < 256; t += 1) {
    wB += bins[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * bins[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = t; }
  }
  return best / 255;
}

function boxBlurField(field, w, h, radius) {
  if (radius <= 0) return field;
  const tmp = new Float32Array(field.length);
  const out = new Float32Array(field.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let s = 0; let n = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        s += field[(y * w) + xx]; n += 1;
      }
      tmp[(y * w) + x] = s / n;
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let s = 0; let n = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        s += tmp[(yy * w) + x]; n += 1;
      }
      out[(y * w) + x] = s / n;
    }
  }
  return out;
}

/** Box blur repeated 3× ≈ gaussian, and separable, so it stays cheap. */
function gaussianField(field, w, h, radius) {
  if (radius <= 0) return field;
  let out = field;
  for (let i = 0; i < 3; i += 1) out = boxBlurField(out, w, h, radius);
  return out;
}

/**
 * Hysteresis: seed on pixels clearly inside, then grow through anything above a
 * lower bar that CONNECTS to a seed.
 *
 * A single threshold is what makes a shaded or compressed logo come out ragged —
 * its darker folds dip under the cut, so the boundary meanders in and out of the
 * shading instead of following the silhouette. Canny solved this for edges; the
 * same trick works on a fill mask.
 */
function hysteresisMask(field, w, h, hi, lo) {
  const n = w * h;
  const out = new Uint8Array(n);
  const stack = [];
  for (let i = 0; i < n; i += 1) if (field[i] >= hi) { out[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w; const y = (i / w) | 0;
    if (x > 0 && !out[i - 1] && field[i - 1] >= lo) { out[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && !out[i + 1] && field[i + 1] >= lo) { out[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && !out[i - w] && field[i - w] >= lo) { out[i - w] = 1; stack.push(i - w); }
    if (y < h - 1 && !out[i + w] && field[i + w] >= lo) { out[i + w] = 1; stack.push(i + w); }
  }
  return out;
}

/**
 * Boundary cleanup, done in 2D on the MASK rather than on the traced polyline.
 *
 * This is what makes the outline smooth, and no choice of tracer substitutes for
 * it: on a compressed video frame Potrace wobbles just as badly off the same
 * ragged mask. Smoothing a contour after the fact can drag it through itself and
 * cannot undo a boundary that wandered into the shading; blurring the mask and
 * re-cutting at 0.5 is area-preserving, cannot self-intersect, and still leaves a
 * sub-pixel ramp to trace.
 *
 * Measured on the bench (html/image-vectorize.html), across five logos: total
 * turning drops from 23.6× to 4.3× while IoU RISES 99.1% → 99.6% and the anchor
 * count roughly halves.
 */
function cleanField(field, w, h, reach, smoothPx) {
  const lo = Math.max(0.02, Math.min(1, reach));
  if (lo >= 0.999 && smoothPx <= 0) return field;
  const mask = hysteresisMask(field, w, h, 0.5, 0.5 * lo);
  const binary = new Float32Array(field.length);
  // Keep the original anti-aliased value wherever it already agrees with the
  // mask — that is where the true sub-pixel edge lives.
  for (let i = 0; i < binary.length; i += 1) {
    binary[i] = mask[i] ? Math.max(field[i], 0.5) : Math.min(field[i], 0.5);
  }
  return gaussianField(binary, w, h, smoothPx);
}

/**
 * rgba → a 0..1 field whose 0.5 iso-line is the shape edge.
 *
 * The boundary is remapped to exactly 0.5 whichever way the image was keyed, so
 * every stage downstream can assume one iso value.
 */
export function buildMaskField(rgba, w, h, opts = {}) {
  const o = { ...TRACE_DEFAULTS, ...opts };
  const at = (x, y) => (((y * w) + x) * 4);

  // Transparency is measured over the WHOLE image, not the border ring: a logo
  // whose artwork bleeds to the frame still has opaque edge pixels, and keying
  // such a clean cut-out by colour traces it against its own gradient instead.
  let transparent = 0;
  for (let p = 3; p < rgba.length; p += 4) if (rgba[p] < 128) transparent += 1;
  const transparentFraction = transparent / (w * h);

  const ringR = []; const ringG = []; const ringB = [];
  const sampleRing = (x, y) => {
    const i = at(x, y);
    ringR.push(rgba[i]); ringG.push(rgba[i + 1]); ringB.push(rgba[i + 2]);
  };
  for (let x = 0; x < w; x += 1) { sampleRing(x, 0); sampleRing(x, h - 1); }
  for (let y = 0; y < h; y += 1) { sampleRing(0, y); sampleRing(w - 1, y); }
  const median = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
  const bg = [median(ringR), median(ringG), median(ringB)];

  let channel = o.channel;
  if (channel === 'auto') channel = transparentFraction > 0.02 ? 'alpha' : 'color';

  const raw = new Float32Array(w * h);
  if (channel === 'alpha') {
    for (let i = 0, p = 0; i < raw.length; i += 1, p += 4) raw[i] = rgba[p + 3] / 255;
  } else if (channel === 'luma') {
    for (let i = 0, p = 0; i < raw.length; i += 1, p += 4) {
      const a = rgba[p + 3] / 255;
      raw[i] = (((0.2126 * rgba[p]) + (0.7152 * rgba[p + 1]) + (0.0722 * rgba[p + 2])) / 255) * a;
    }
  } else {
    const MAX = Math.sqrt(3) * 255;
    for (let i = 0, p = 0; i < raw.length; i += 1, p += 4) {
      const a = rgba[p + 3] / 255;
      const r = (rgba[p] * a) + (bg[0] * (1 - a));
      const g = (rgba[p + 1] * a) + (bg[1] * (1 - a));
      const b = (rgba[p + 2] * a) + (bg[2] * (1 - a));
      raw[i] = Math.hypot(r - bg[0], g - bg[1], b - bg[2]) / MAX;
    }
  }

  const blurred = boxBlurField(raw, w, h, o.blur);
  let threshold = o.autoThreshold ? otsu(blurred) : o.threshold;
  if (!(threshold > 0.005) || threshold > 0.995) threshold = 0.5;

  // Piecewise-linear remap: monotonic, so sub-pixel interpolation near the edge
  // keeps its meaning, and the boundary lands on 0.5.
  const field = new Float32Array(blurred.length);
  for (let i = 0; i < field.length; i += 1) {
    const v = blurred[i];
    const m = v < threshold ? (0.5 * v) / threshold : 0.5 + ((0.5 * (v - threshold)) / (1 - threshold));
    field[i] = o.invert ? 1 - m : m;
  }

  // The smoothing radius is quoted for a 1024px edge, so a small source is not
  // scrubbed proportionally harder than a large one.
  const smoothPx = o.maskSmooth > 0
    ? Math.max(1, Math.round(o.maskSmooth * (Math.max(w, h) / 1024)))
    : 0;
  const cleaned = cleanField(field, w, h, o.reach, smoothPx);
  return { field: cleaned, channel, threshold, transparentFraction, smoothPx };
}

/** Mean colour of the foreground, for the silhouette preview. */
export function dominantColor(rgba, field) {
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let i = 0, p = 0; i < field.length; i += 1, p += 4) {
    if (field[i] < 0.75) continue;
    const a = rgba[p + 3] / 255;
    if (a < 0.5) continue;
    r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2]; n += 1;
  }
  if (!n) return '#8b5cf6';
  const hex = (v) => Math.max(0, Math.min(255, Math.round(v / n))).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/* ── 2 · sub-pixel marching squares ──────────────────────────────────────── */

const EDGE_T = 0; const EDGE_R = 1; const EDGE_B = 2; const EDGE_L = 3;
// case → [[fromEdge, toEdge], …], oriented so the inside stays on one side.
const MS_TABLE = {
  1: [[EDGE_L, EDGE_T]],
  2: [[EDGE_T, EDGE_R]],
  3: [[EDGE_L, EDGE_R]],
  4: [[EDGE_R, EDGE_B]],
  6: [[EDGE_T, EDGE_B]],
  7: [[EDGE_L, EDGE_B]],
  8: [[EDGE_B, EDGE_L]],
  9: [[EDGE_B, EDGE_T]],
  11: [[EDGE_B, EDGE_R]],
  12: [[EDGE_R, EDGE_L]],
  13: [[EDGE_R, EDGE_T]],
  14: [[EDGE_T, EDGE_L]],
};

/**
 * All contours at the iso level, as dense sub-pixel polylines.
 *
 * Cell segments are linked by shared EDGE ID rather than by comparing endpoint
 * coordinates, so loops close exactly and no float fuzz can leave a gap.
 */
export function traceContours(field, w, h, iso = 0.5) {
  // 1px background pad so a shape touching the frame still closes.
  const W = w + 2; const H = h + 2;
  const S = new Float32Array(W * H);
  for (let y = 0; y < h; y += 1) S.set(field.subarray(y * w, (y + 1) * w), ((y + 1) * W) + 1);

  const edgeCount = W * H * 2;
  const px = new Float32Array(edgeCount);
  const py = new Float32Array(edgeCount);
  const next = new Int32Array(edgeCount).fill(-1);
  const seen = new Uint8Array(edgeCount);
  const hId = (i, j) => (((j * W) + i) * 2);
  const vId = (i, j) => ((((j * W) + i) * 2) + 1);

  const lerp = (a, b) => {
    const d = b - a;
    if (Math.abs(d) < 1e-9) return 0.5;
    return Math.min(1, Math.max(0, (iso - a) / d));
  };

  for (let j = 0; j < H - 1; j += 1) {
    for (let i = 0; i < W - 1; i += 1) {
      const vTL = S[(j * W) + i];
      const vTR = S[(j * W) + i + 1];
      const vBR = S[((j + 1) * W) + i + 1];
      const vBL = S[((j + 1) * W) + i];
      let code = 0;
      if (vTL >= iso) code |= 1;
      if (vTR >= iso) code |= 2;
      if (vBR >= iso) code |= 4;
      if (vBL >= iso) code |= 8;
      if (code === 0 || code === 15) continue;

      let segs;
      if (code === 5 || code === 10) {
        // Saddle: the cell centre decides whether the two inside corners are one
        // shape pinching through or two separate nubs.
        const centre = (vTL + vTR + vBR + vBL) / 4;
        if (code === 5) {
          segs = centre >= iso ? [[EDGE_L, EDGE_B], [EDGE_R, EDGE_T]] : [[EDGE_L, EDGE_T], [EDGE_R, EDGE_B]];
        } else {
          segs = centre >= iso ? [[EDGE_T, EDGE_L], [EDGE_B, EDGE_R]] : [[EDGE_T, EDGE_R], [EDGE_B, EDGE_L]];
        }
      } else {
        segs = MS_TABLE[code];
      }
      if (!segs) continue;

      const x0 = i - 0.5; const y0 = j - 0.5;
      const idOf = (edge) => {
        if (edge === EDGE_T) return hId(i, j);
        if (edge === EDGE_B) return hId(i, j + 1);
        if (edge === EDGE_L) return vId(i, j);
        return vId(i + 1, j);
      };
      const place = (edge, id) => {
        if (edge === EDGE_T) { px[id] = x0 + lerp(vTL, vTR); py[id] = y0; return; }
        if (edge === EDGE_B) { px[id] = x0 + lerp(vBL, vBR); py[id] = y0 + 1; return; }
        if (edge === EDGE_L) { px[id] = x0; py[id] = y0 + lerp(vTL, vBL); return; }
        px[id] = x0 + 1; py[id] = y0 + lerp(vTR, vBR);
      };
      for (let s = 0; s < segs.length; s += 1) {
        const a = idOf(segs[s][0]); const b = idOf(segs[s][1]);
        place(segs[s][0], a); place(segs[s][1], b);
        next[a] = b;
      }
    }
  }

  const loops = [];
  for (let start = 0; start < edgeCount; start += 1) {
    if (next[start] < 0 || seen[start]) continue;
    const pts = [];
    let e = start;
    let guard = 0;
    while (e >= 0 && !seen[e] && guard <= edgeCount) {
      seen[e] = 1;
      pts.push({ x: px[e], y: py[e] });
      e = next[e];
      guard += 1;
    }
    if (pts.length >= 3) loops.push(pts);
  }
  return loops;
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i += 1) {
    const p = pts[i]; const q = pts[(i + 1) % n];
    a += (p.x * q.y) - (q.x * p.y);
  }
  return a / 2;
}

/* ── 3 · simplify ────────────────────────────────────────────────────────── */

function smoothClosed(pts, radius) {
  if (radius <= 0 || pts.length < 8) return pts;
  const n = pts.length;
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    let sx = 0; let sy = 0; let c = 0;
    for (let k = -radius; k <= radius; k += 1) {
      const p = pts[(((i + k) % n) + n) % n];
      sx += p.x; sy += p.y; c += 1;
    }
    out[i] = { x: sx / c, y: sy / c };
  }
  return out;
}

/** RDP over an index list, so the mapping back to the dense polyline survives. */
function rdpIdx(pts, idxs, eps) {
  const m = idxs.length;
  if (m < 3) return idxs.slice();
  const keep = new Uint8Array(m);
  keep[0] = 1; keep[m - 1] = 1;
  const stack = [[0, m - 1]];
  const eps2 = eps * eps;
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const p0 = pts[idxs[a]]; const p1 = pts[idxs[b]];
    const dx = p1.x - p0.x; const dy = p1.y - p0.y;
    const den = (dx * dx) + (dy * dy);
    let best = -1; let bestD = -1;
    for (let i = a + 1; i < b; i += 1) {
      const p = pts[idxs[i]];
      let d;
      if (den < 1e-12) {
        d = ((p.x - p0.x) ** 2) + ((p.y - p0.y) ** 2);
      } else {
        const t = Math.max(0, Math.min(1, ((((p.x - p0.x) * dx) + ((p.y - p0.y) * dy)) / den)));
        const qx = p0.x + (t * dx); const qy = p0.y + (t * dy);
        d = ((p.x - qx) ** 2) + ((p.y - qy) ** 2);
      }
      if (d > bestD) { bestD = d; best = i; }
    }
    if (bestD > eps2 && best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out = [];
  for (let i = 0; i < m; i += 1) if (keep[i]) out.push(idxs[i]);
  return out;
}

function rdpClosedIndices(pts, eps) {
  const n = pts.length;
  if (n < 6) return pts.map((_, i) => i);
  // Two anchors certainly on the hull, so the split can't shortcut a whole side.
  let cx = 0; let cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;
  let i0 = 0; let far = -1;
  for (let i = 0; i < n; i += 1) {
    const d = ((pts[i].x - cx) ** 2) + ((pts[i].y - cy) ** 2);
    if (d > far) { far = d; i0 = i; }
  }
  let i1 = i0; far = -1;
  for (let i = 0; i < n; i += 1) {
    const d = ((pts[i].x - pts[i0].x) ** 2) + ((pts[i].y - pts[i0].y) ** 2);
    if (d > far) { far = d; i1 = i; }
  }
  const wrap = (a, b) => {
    const out = [];
    for (let i = a; ; i = (i + 1) % n) { out.push(i); if (i === b) break; }
    return out;
  };
  const a = rdpIdx(pts, wrap(i0, i1), eps);
  const b = rdpIdx(pts, wrap(i1, i0), eps);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

function rdpClosed(pts, eps) {
  return rdpClosedIndices(pts, eps).map((i) => pts[i]);
}

/**
 * Re-seed points along any segment longer than `maxSeg`.
 *
 * RDP collapses a straight edge to its two endpoints, which is correct as
 * geometry but leaves the curve fit unconstrained in between: give it slightly
 * wrong end tangents — which rounded corners do — and it bows tens of pixels off
 * the edge while still scoring zero error, because there is no sample there to
 * catch it. These collinear points cost almost nothing and pin the fit down.
 */
function densifyClosed(pts, maxSeg) {
  const n = pts.length;
  if (n < 2 || !(maxSeg > 0)) return pts;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const a = pts[i]; const b = pts[(i + 1) % n];
    out.push(a);
    const steps = Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / maxSeg);
    for (let k = 1; k < steps; k += 1) {
      out.push({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps });
    }
  }
  return out;
}

/* ── 4 · Schneider cubic fit ─────────────────────────────────────────────── */

function bezierAt(bez, t) {
  const u = 1 - t;
  const b0 = u * u * u; const b1 = 3 * u * u * t; const b2 = 3 * u * t * t; const b3 = t * t * t;
  return {
    x: (bez[0].x * b0) + (bez[1].x * b1) + (bez[2].x * b2) + (bez[3].x * b3),
    y: (bez[0].y * b0) + (bez[1].y * b1) + (bez[2].y * b2) + (bez[3].y * b3),
  };
}

function bezierTangentAt(bez, t) {
  const u = 1 - t;
  return {
    x: (3 * u * u * (bez[1].x - bez[0].x)) + (6 * u * t * (bez[2].x - bez[1].x)) + (3 * t * t * (bez[3].x - bez[2].x)),
    y: (3 * u * u * (bez[1].y - bez[0].y)) + (6 * u * t * (bez[2].y - bez[1].y)) + (3 * t * t * (bez[3].y - bez[2].y)),
  };
}

function chordParams(pts) {
  const u = [0];
  for (let i = 1; i < pts.length; i += 1) u.push(u[i - 1] + V.len(V.sub(pts[i], pts[i - 1])));
  const total = u[u.length - 1] || 1;
  return u.map((x) => x / total);
}

function generateBezier(pts, u, t1, t2) {
  const n = pts.length;
  const first = pts[0]; const last = pts[n - 1];
  let c00 = 0; let c01 = 0; let c11 = 0; let x0 = 0; let x1 = 0;
  for (let i = 0; i < n; i += 1) {
    const t = u[i]; const om = 1 - t;
    const a0 = V.mul(t1, 3 * om * om * t);
    const a1 = V.mul(t2, 3 * om * t * t);
    c00 += V.dot(a0, a0); c01 += V.dot(a0, a1); c11 += V.dot(a1, a1);
    const b0 = om * om * om; const b1 = 3 * om * om * t; const b2 = 3 * om * t * t; const b3 = t * t * t;
    const tmp = {
      x: pts[i].x - ((first.x * (b0 + b1)) + (last.x * (b2 + b3))),
      y: pts[i].y - ((first.y * (b0 + b1)) + (last.y * (b2 + b3))),
    };
    x0 += V.dot(a0, tmp); x1 += V.dot(a1, tmp);
  }
  const det = (c00 * c11) - (c01 * c01);
  let a0 = 0; let a1 = 0;
  if (Math.abs(det) > 1e-12) {
    a0 = ((x0 * c11) - (x1 * c01)) / det;
    a1 = ((c00 * x1) - (c01 * x0)) / det;
  }
  const seg = V.len(V.sub(last, first));
  const eps = 1e-6 * seg;
  // Schneider only guards alpha <= 0. A near-singular system also produces
  // ENORMOUS positive alphas, and a handle far longer than its chord draws a
  // spike the sample-point error metric barely registers — so cap it too.
  const maxAlpha = seg * 1.6;
  if (!(a0 > eps) || !(a1 > eps) || a0 > maxAlpha || a1 > maxAlpha) {
    const d = seg / 3;
    return [first, V.add(first, V.mul(t1, d)), V.add(last, V.mul(t2, d)), last];
  }
  return [first, V.add(first, V.mul(t1, a0)), V.add(last, V.mul(t2, a1)), last];
}

function maxError(pts, bez, u) {
  let max = 0; let split = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i += 1) {
    const p = bezierAt(bez, u[i]);
    const d = ((p.x - pts[i].x) ** 2) + ((p.y - pts[i].y) ** 2);
    if (d > max) { max = d; split = i; }
  }
  return { max, split };
}

function reparameterize(pts, bez, u) {
  return u.map((t, i) => {
    const p = bezierAt(bez, t);
    const d1 = bezierTangentAt(bez, t);
    const um = 1 - t;
    const d2 = {
      x: (6 * um * (bez[2].x - (2 * bez[1].x) + bez[0].x)) + (6 * t * (bez[3].x - (2 * bez[2].x) + bez[1].x)),
      y: (6 * um * (bez[2].y - (2 * bez[1].y) + bez[0].y)) + (6 * t * (bez[3].y - (2 * bez[2].y) + bez[1].y)),
    };
    const diff = V.sub(p, pts[i]);
    const num = V.dot(diff, d1);
    const den = V.dot(d1, d1) + V.dot(diff, d2);
    if (Math.abs(den) < 1e-12) return t;
    return t - (num / den);
  });
}

function fitCubic(pts, t1, t2, errSq, out, depth = 0) {
  if (pts.length < 2) return;
  if (pts.length === 2) {
    const d = V.len(V.sub(pts[1], pts[0])) / 3;
    out.push([pts[0], V.add(pts[0], V.mul(t1, d)), V.add(pts[1], V.mul(t2, d)), pts[1]]);
    return;
  }
  let u = chordParams(pts);
  let bez = generateBezier(pts, u, t1, t2);
  let { max, split } = maxError(pts, bez, u);
  if (max < errSq) { out.push(bez); return; }
  if (max < errSq * 16 && depth < 12) {
    for (let i = 0; i < 12; i += 1) {
      const up = reparameterize(pts, bez, u);
      const nb = generateBezier(pts, up, t1, t2);
      const e = maxError(pts, nb, up);
      u = up; bez = nb; max = e.max; split = e.split;
      if (max < errSq) { out.push(bez); return; }
    }
  }
  if (depth > 24 || split <= 0 || split >= pts.length - 1) { out.push(bez); return; }
  const centre = V.norm(V.sub(pts[split - 1], pts[split + 1]));
  fitCubic(pts.slice(0, split + 1), t1, centre, errSq, out, depth + 1);
  fitCubic(pts.slice(split), V.neg(centre), t2, errSq, out, depth + 1);
}

/** Direction out of `from` along an open run, measured over at least minDist px. */
function dirAlong(run, from, step, minDist = 2.5) {
  let i = from;
  for (let guard = 0; guard < run.length; guard += 1) {
    const j = i + step;
    if (j < 0 || j >= run.length) break;
    i = j;
    if (V.len(V.sub(run[i], run[from])) >= minDist) break;
  }
  const v = V.sub(run[i], run[from]);
  return V.len(v) < 1e-9 ? { x: 1, y: 0 } : V.norm(v);
}

/**
 * Dense closed polyline → cubic anchors, split at detected corners.
 *
 * The dense contour stays the fitting input; the simplified copy is used only to
 * FIND corners. Fitting the simplified points instead is the subtle killer — a
 * long straight edge reduces to its two endpoints, the fit is then exact at both
 * while free to bow tens of pixels in between, and the error metric never sees it.
 */
function fitClosedLoop(pts, { cornerDeg, fitError, maxAnchors, epsilon, cornerWindow = 2.5 }) {
  const n = pts.length;
  if (n < 4) return null;
  const sparse = rdpClosedIndices(pts, epsilon);
  const m = sparse.length;
  // Turn measured across an arc-length WINDOW, not between adjacent vertices.
  // Mask smoothing rounds a 90° corner into a short arc; with immediate
  // neighbours that arc reads as a run of gentle bends, every one of them under
  // the threshold, so no corner is found — and the whole side then gets fitted as
  // one smooth run that bows off the straight edge.
  const dirWrap = (i, step) => {
    let j = i;
    for (let g = 0; g < n; g += 1) {
      j = (((j + step) % n) + n) % n;
      if (V.len(V.sub(pts[j], pts[i])) >= cornerWindow) break;
    }
    const v = V.sub(pts[j], pts[i]);
    return V.len(v) < 1e-9 ? { x: 1, y: 0 } : V.norm(v);
  };
  const turnAt = (k) => {
    const a = dirWrap(sparse[k], -1);
    const b = dirWrap(sparse[k], 1);
    const cos = Math.max(-1, Math.min(1, V.dot(a, b)));
    return 180 - ((Math.acos(cos) * 180) / Math.PI); // 0 = straight through
  };
  // Keep only the sharpest vertex of each rounded corner, or the arc contributes
  // several anchors a few pixels apart.
  const corners = [];
  let run = null;
  for (let k = 0; k <= m; k += 1) {
    const turn = k < m ? turnAt(k) : -1;
    if (turn >= cornerDeg) {
      if (!run) run = { best: k, turn };
      else if (turn > run.turn) { run.best = k; run.turn = turn; }
    } else if (run) {
      corners.push(sparse[run.best]);
      run = null;
    }
  }

  const build = (errPx) => {
    const errSq = errPx * errPx;
    const beziers = [];
    if (corners.length < 2) {
      // No corner anywhere: one closed run, seam tangent taken across the wrap so
      // the join stays smooth.
      const loop = pts.concat([pts[0]]);
      const t1 = V.norm(V.sub(pts[1], pts[n - 1]));
      fitCubic(loop, t1, V.neg(t1), errSq, beziers);
    } else {
      for (let c = 0; c < corners.length; c += 1) {
        const a = corners[c];
        const b = corners[(c + 1) % corners.length];
        const run = [];
        for (let i = a; ; i = (i + 1) % n) { run.push(pts[i]); if (i === b) break; }
        if (run.length < 2) continue;
        // Tangents measured past the rounded corner, not out of it.
        fitCubic(
          run,
          dirAlong(run, 0, 1, cornerWindow),
          dirAlong(run, run.length - 1, -1, cornerWindow),
          errSq, beziers
        );
      }
    }
    return beziers;
  };

  let errPx = fitError;
  let beziers = build(errPx);
  for (let guard = 0; beziers.length > maxAnchors && guard < 9; guard += 1) {
    errPx *= 1.7;
    beziers = build(errPx);
  }
  if (!beziers.length) return null;

  return beziers.map((b, i) => {
    const prev = beziers[(i - 1 + beziers.length) % beziers.length];
    return {
      x: b[0].x,
      y: b[0].y,
      hOut: { x: b[1].x - b[0].x, y: b[1].y - b[0].y },
      hIn: { x: prev[2].x - prev[3].x, y: prev[2].y - prev[3].y },
      manual: true,
    };
  });
}

/* ── 5 · contour selection, holes, unit box ──────────────────────────────── */

function anchorCurvePoints(anchors, steps = 4) {
  const pts = [];
  const n = anchors.length;
  for (let i = 0; i < n; i += 1) {
    const a = anchors[i]; const b = anchors[(i + 1) % n];
    const bez = [
      { x: a.x, y: a.y },
      { x: a.x + (a.hOut?.x || 0), y: a.y + (a.hOut?.y || 0) },
      { x: b.x + (b.hIn?.x || 0), y: b.y + (b.hIn?.y || 0) },
      { x: b.x, y: b.y },
    ];
    for (let k = 0; k < steps; k += 1) pts.push(bezierAt(bez, k / steps));
  }
  return pts;
}

function anchorArea(anchors) {
  return polygonArea(anchorCurvePoints(anchors, 4));
}

export function anchorBounds(list) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const anchors of list) {
    for (const p of anchorCurvePoints(anchors, 8)) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: Math.max(1e-6, maxX - minX), h: Math.max(1e-6, maxY - minY) };
}

/**
 * Splice extra rings into a ring through zero-width bridges.
 *
 * The editor stores ONE point list, so anything the trace found beyond a single
 * contour has to be cut into it: a counter (the hole in a G, an O, an ampersand)
 * or a whole separate PIECE of the mark. Joining at the closest anchor pair keeps
 * one closed path whose winding still renders both — a hole is wound the other
 * way so it knocks through, a piece is wound the same way so it fills.
 *
 * Costs two duplicated anchors per splice, and only reads correctly when FILLED —
 * a stroked path draws the bridges as thin connecting lines.
 */
function spliceRings(base, parts) {
  let ring = base.map((p) => ({ ...p }));
  const sorted = parts.slice().sort((a, b) => Math.abs(anchorArea(b)) - Math.abs(anchorArea(a)));
  for (const hole of sorted) {
    let bi = 0; let hi = 0; let best = Infinity;
    for (let i = 0; i < ring.length; i += 1) {
      for (let j = 0; j < hole.length; j += 1) {
        const d = ((ring[i].x - hole[j].x) ** 2) + ((ring[i].y - hole[j].y) ** 2);
        if (d < best) { best = d; bi = i; hi = j; }
      }
    }
    const zero = (p) => ({ x: p.x, y: p.y, hIn: { x: 0, y: 0 }, hOut: { x: 0, y: 0 }, manual: true });
    const rotated = hole.slice(hi).concat(hole.slice(0, hi)).map((p) => ({ ...p }));
    const merged = [];
    for (let i = 0; i <= bi; i += 1) merged.push({ ...ring[i] });
    merged[merged.length - 1] = { ...merged[merged.length - 1], hOut: { x: 0, y: 0 } };
    merged.push({ ...rotated[0], hIn: { x: 0, y: 0 } });
    for (let i = 1; i < rotated.length; i += 1) merged.push({ ...rotated[i] });
    merged.push(zero(rotated[0]));   // close the hole …
    merged.push(zero(ring[bi]));     // … and come back along the bridge
    for (let i = bi + 1; i < ring.length; i += 1) merged.push({ ...ring[i] });
    ring = merged;
  }
  return ring;
}

function boundsContain(outer, inner, pad = 1) {
  return !!outer && !!inner
    && inner.x >= outer.x - pad && inner.y >= outer.y - pad
    && inner.x + inner.w <= outer.x + outer.w + pad
    && inner.y + inner.h <= outer.y + outer.h + pad;
}

/**
 * Contours → the one closed ring a shape layer can store.
 *
 * Marks are very often several DISJOINT pieces: a frame grab split in two by a
 * shadow band, a dotted i, a two-part logo. Keeping only the biggest contour
 * (what 8.4.0 did) silently returns a fragment for all of those — so every piece
 * above the floor is kept and spliced together, exactly like the holes.
 */
function selectShape(contours, { bridgeHoles: allowBridge = true, pieces = 'all' } = {}) {
  const scored = contours.map((anchors) => ({
    anchors,
    area: anchorArea(anchors),
    bounds: anchorBounds([anchors]),
  }));
  // With a consistent winding the signed areas sum to ±(foreground area), so the
  // total's sign is what says which way round this image came out.
  const total = scored.reduce((s, c) => s + c.area, 0);
  const flip = total < 0 ? -1 : 1;
  for (const c of scored) c.area *= flip;

  let outers = scored.filter((c) => c.area > 0).sort((a, b) => b.area - a.area);
  if (!outers.length) {
    outers = scored.slice().sort((a, b) => Math.abs(b.area) - Math.abs(a.area)).slice(0, 1);
  }
  const largest = Math.abs(outers[0].area) || 1;
  const kept = (pieces === 'largest' || !allowBridge)
    ? outers.slice(0, 1)
    : outers.filter((c) => c.area >= largest * MIN_PIECE_FRACTION).slice(0, MAX_PIECES);

  // A hole belongs to the SMALLEST kept piece that contains it, so a neighbouring
  // larger piece cannot steal a counter that is not its own.
  const holesFor = kept.map(() => []);
  for (const c of scored) {
    if (c.area >= 0) continue;
    let best = -1;
    for (let i = 0; i < kept.length; i += 1) {
      if (!boundsContain(kept[i].bounds, c.bounds)) continue;
      if (best < 0 || kept[i].area < kept[best].area) best = i;
    }
    if (best >= 0) holesFor[best].push(c.anchors);
  }

  let ring = null;
  const holes = [];
  for (let i = 0; i < kept.length; i += 1) {
    let piece = kept[i].anchors;
    if (allowBridge && holesFor[i].length) piece = spliceRings(piece, holesFor[i]);
    holes.push(...holesFor[i]);
    ring = ring === null ? piece : spliceRings(ring, [piece]);
  }
  return {
    points: ring,
    outers: kept.map((c) => c.anchors),
    holes,
    pieceCount: kept.length,
    bridged: allowBridge ? holes.length + Math.max(0, kept.length - 1) : 0,
  };
}

/** Pixel-space anchors → the editor's unit box (centre 0, ±0.5 at the edge). */
export function toUnitBox(points, box) {
  return points.map((p) => ({
    x: round4(((p.x - box.x) / box.w) - 0.5),
    y: round4(((p.y - box.y) / box.h) - 0.5),
    hIn: { x: round4((p.hIn?.x || 0) / box.w), y: round4((p.hIn?.y || 0) / box.h) },
    hOut: { x: round4((p.hOut?.x || 0) / box.w), y: round4((p.hOut?.y || 0) / box.h) },
    manual: true,
  }));
}

/* ── preview SVG ─────────────────────────────────────────────────────────── */

function contourToPathData(anchors, box) {
  const n = anchors.length;
  const fx = (v) => Math.round((v - box.x) * 100) / 100;
  const fy = (v) => Math.round((v - box.y) * 100) / 100;
  let d = `M${fx(anchors[0].x)} ${fy(anchors[0].y)}`;
  for (let i = 0; i < n; i += 1) {
    const a = anchors[i]; const b = anchors[(i + 1) % n];
    const ah = a.hOut || { x: 0, y: 0 };
    const bh = b.hIn || { x: 0, y: 0 };
    d += `C${fx(a.x + ah.x)} ${fy(a.y + ah.y)} ${fx(b.x + bh.x)} ${fy(b.y + bh.y)} ${fx(b.x)} ${fy(b.y)}`;
  }
  return `${d}Z`;
}

/** Every piece + its holes as one even-odd path — the preview of the trace. */
export function contoursToSvg(outers, holes, box, color) {
  const d = [...outers, ...holes].map((c) => contourToPathData(c, box)).join(' ');
  const w = Math.max(1, Math.round(box.w));
  const h = Math.max(1, Math.round(box.h));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${box.w} ${box.h}">`
    + `<path d="${d}" fill="${color}" fill-rule="evenodd"/></svg>`;
}

/* ── entry point ─────────────────────────────────────────────────────────── */

/**
 * rgba → { points, closed, svg, box, … }.
 *
 * `points` are already in the editor's unit-box format, sized to the CONTENT
 * bounds rather than the image — a logo with padding around it should not be
 * handed to the shape layer as mostly empty space.
 */
export function traceRaster(rgba, w, h, opts = {}, onStage) {
  const o = { ...TRACE_DEFAULTS, ...opts };
  onStage?.('mask');
  const { field, channel, threshold, smoothPx } = buildMaskField(rgba, w, h, o);

  onStage?.('trace');
  const loops = traceContours(field, w, h, 0.5);
  if (!loops.length) throw new Error('No shape was found in this image. Try a different threshold, or an image with a clearer background.');

  onStage?.('fit');
  const contours = [];
  for (const loop of loops) {
    if (Math.abs(polygonArea(loop)) < o.speckle) continue;
    const smoothed = smoothClosed(loop, o.smooth);
    // A hair of decimation keeps the dense fit input cheap; far below the
    // simplify epsilon, so the fit still sees the true edge.
    const dense = densifyClosed(rdpClosed(smoothed, Math.min(0.15, o.epsilon * 0.3)), 2);
    // The corner window has to grow with the smoothing, since that is what sets
    // how wide a rounded corner ends up.
    const anchors = fitClosedLoop(dense, { ...o, cornerWindow: Math.max(2.5, smoothPx * 1.6) });
    // Two anchors is a legitimate closed contour — a small circle fits in two
    // cubics — and demanding three silently drops every round counter.
    if (anchors && anchors.length >= 2) contours.push(anchors);
  }
  if (!contours.length) throw new Error('The shapes in this image are too small to trace. Try lowering the speckle filter.');

  const shape = selectShape(contours, o);
  const box = anchorBounds([...shape.outers, ...shape.holes]);
  const color = dominantColor(rgba, field);

  return {
    points: toUnitBox(shape.points, box),
    closed: true,
    svg: contoursToSvg(shape.outers, shape.holes, box, color),
    color,
    box,
    width: Math.max(1, Math.round(box.w)),
    height: Math.max(1, Math.round(box.h)),
    pathCount: shape.outers.length + shape.holes.length,
    pieceCount: shape.pieceCount,
    holeCount: shape.holes.length,
    bridged: shape.bridged,
    contourCount: contours.length,
    channel,
    threshold,
  };
}
