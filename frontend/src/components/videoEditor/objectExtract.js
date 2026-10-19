/*
 * OBJECT EXTRACTION — the shared feature pass the geometry programs draw from.
 *
 * The reference states its own pipeline: RAW FRAME → SOBEL X/Y → LOCAL MAX →
 * DELAUNAY. Everything the geometry family draws comes out of that one pass, so
 * it runs ONCE per (layer, frame, params) and every effect on that layer reads
 * the same cache entry.
 *
 * Ported from the html/object-effects-lab.html look-dev harness (since removed;
 * this module is the source of truth). The two
 * measured findings that changed the port are both here:
 *
 *   - OCCUPANCY. Only about a THIRD of thinning cells contain an NMS ridge at
 *     all, so sizing cells as area/budget delivers a third of the requested
 *     density (191 points for a budget of 1100) and the slider stops meaning
 *     anything above ~300. The cell carries that measured factor.
 *   - Density is a CAP, NOT A TARGET. The point count saturates against the
 *     threshold and the analysis resolution (838 → 1182 points across 256 → 768
 *     px), which is why the panel labels it Max points.
 *
 * WHERE THE PIXELS COME FROM. The layer's own media element, drawn into a small
 * analysis canvas — not a readback of the composited isolate. A readback is a
 * GPU→CPU sync in the middle of the render tick; the media element is already
 * decoded and already seeked to this frame.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

export function mulberry32(a) {
  return function rnd() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleAt(arr, w, h, x, y) {
  const xi = clamp(Math.round(x), 0, w - 1);
  const yi = clamp(Math.round(y), 0, h - 1);
  return arr[yi * w + xi];
}

function boxBlur(src, w, h, r) {
  const a = new Float32Array(src.length);
  const b = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[y * w + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      a[y * w + x] = acc / (2 * r + 1);
      acc += src[y * w + clamp(x + r + 1, 0, w - 1)] - src[y * w + clamp(x - r, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += a[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      b[y * w + x] = acc / (2 * r + 1);
      acc += a[clamp(y + r + 1, 0, h - 1) * w + x] - a[clamp(y - r, 0, h - 1) * w + x];
    }
  }
  return b;
}

/* One analysis canvas for the whole app: every extraction downsamples to at most
   768px and they never overlap in time (this all runs inside one render tick). */
let anaCanvas = null;
let anaCtx = null;
function analysisCanvas(w, h) {
  if (!anaCanvas) {
    // The roto WORKER imports this too. There `document` is the empty object
    // rotoProcessor shims for MediaPipe's probe, so `document.createElement`
    // "is not a function" — decide by `window`, like rotoProcessor's makeCanvas.
    anaCanvas = (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof document.createElement === 'function')
      ? document.createElement('canvas')
      : new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    anaCtx = anaCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (anaCanvas.width !== w || anaCanvas.height !== h) {
    anaCanvas.width = w;
    anaCanvas.height = h;
  }
  return anaCtx;
}

/** The weight at a point, from a decoded track field. No field → 1 everywhere. */
function weightAt(field, fw, fh, u, v) {
  if (!field) return 1;
  const x = clamp(Math.floor(u * fw), 0, fw - 1);
  const y = clamp(Math.floor(v * fh), 0, fh - 1);
  return field[y * fw + x] / 255;
}

/**
 * Run the extraction.
 *
 *   media          HTMLVideoElement / HTMLImageElement / ImageBitmap / canvas
 *   analysis       long edge in px (the lab measured 4.9 ms at 384, 15.2 at 768)
 *   preBlur        DETECTION pre-blur in analysis px — never reaches any output
 *   threshold      NMS floor, 0..1 of the normalised gradient
 *   density        MAX points (a cap, not a target)
 *   bias           0..1, how hard the subject field shrinks thinning cells
 *   field/fw/fh    the decoded subject weight field, or null
 *   face           [x,y,w,h,score] in media uv, or null
 *   faceProtect    0 none · 1 reduce · 2 exclude
 */
export function extractFeatures(media, {
  analysis = 384, preBlur = 1, threshold = 0.05, density = 600, bias = 0.7,
  field = null, fieldW = 64, fieldH = 64, face = null, faceProtect = 0, seed = 7,
  centroid = 0, normState = null,
} = {}) {
  const sw = media?.videoWidth || media?.naturalWidth || media?.width || 0;
  const sh = media?.videoHeight || media?.naturalHeight || media?.height || 0;
  if (!sw || !sh) return null;
  const sc = analysis / Math.max(sw, sh);
  const aw = Math.max(8, Math.round(sw * sc));
  const ah = Math.max(8, Math.round(sh * sc));
  const ctx = analysisCanvas(aw, ah);
  try {
    ctx.drawImage(media, 0, 0, aw, ah);
  } catch {
    return null;                    // a video with no decoded frame yet
  }
  const img = ctx.getImageData(0, 0, aw, ah);
  const px = img.data;

  const lum = new Float32Array(aw * ah);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = (px[p] * 0.2126 + px[p + 1] * 0.7152 + px[p + 2] * 0.0722) / 255;
  }

  const r = Math.round(preBlur * sc * 2);
  const blurred = r > 0 ? boxBlur(lum, aw, ah, r) : lum;

  const mag = new Float32Array(aw * ah);
  const ang = new Float32Array(aw * ah);
  let maxMag = 1e-6;
  for (let y = 1; y < ah - 1; y++) {
    for (let x = 1; x < aw - 1; x++) {
      const i = y * aw + x;
      const a = blurred[i - aw - 1]; const b = blurred[i - aw]; const c = blurred[i - aw + 1];
      const d = blurred[i - 1]; const e = blurred[i + 1];
      const f = blurred[i + aw - 1]; const g = blurred[i + aw]; const h = blurred[i + aw + 1];
      const gx = (c + 2 * e + h) - (a + 2 * d + f);
      const gy = (f + 2 * g + h) - (a + 2 * b + c);
      const m = Math.hypot(gx, gy);
      mag[i] = m;
      ang[i] = Math.atan2(gy, gx);
      if (m > maxMag) maxMag = m;
    }
  }
  /*
   * CHURN SOURCE 1 · the gradient normaliser. Dividing by maxMag means the single
   * strongest edge IN THIS FRAME sets the scale for every point in it, so one
   * specular highlight or one blink rescales the whole field and the entire set
   * crosses the threshold together. With a normState the scale is an EMA across
   * frames instead, and a bright frame moves it by `ease` rather than by all of
   * it. normState is a property of the PICTURE, not of an effect, so it is
   * carried per extraction key below — two effects on one layer share it.
   */
  let scale = maxMag;
  if (normState) {
    const ease = clamp(normState.ease ?? 1, 0.01, 1);
    scale = normState.scale > 0 ? lerp(normState.scale, maxMag, ease) : maxMag;
    normState.scale = scale;
  }
  for (let i = 0; i < mag.length; i++) mag[i] /= scale;

  // Non-max suppression along the gradient, then subject-weighted thinning.
  const OCCUPANCY = 0.33;
  const budget = Math.max(40, density);
  const baseCell = Math.max(1.6, Math.sqrt((aw * ah) * OCCUPANCY / budget));
  const cells = new Map();
  for (let y = 2; y < ah - 2; y++) {
    for (let x = 2; x < aw - 2; x++) {
      const i = y * aw + x;
      const m = mag[i];
      if (m < threshold) continue;
      const a = ang[i];
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      if (m < sampleAt(mag, aw, ah, x + dx, y + dy)) continue;
      if (m < sampleAt(mag, aw, ah, x - dx, y - dy)) continue;
      const u = x / aw;
      const v = y / ah;
      const w = weightAt(field, fieldW, fieldH, u, v);
      const cell = baseCell * lerp(1.45, 0.55, bias * w + (1 - bias) * 0.5);
      const key = ((y / cell) | 0) * 100000 + ((x / cell) | 0);
      let prev = cells.get(key);
      if (!prev) { prev = { x, y, u, v, m, a, w, sx: 0, sy: 0, sm: 0 }; cells.set(key, prev); }
      /*
       * CHURN SOURCE 2 · the cell's point. Keeping only the argmax pixel makes
       * the position a STEP function of the picture: a sub-pixel change flips
       * the winner to a neighbouring ridge pixel and the mark teleports by up to
       * a cell width. The running sums let it sit at the magnitude-weighted
       * centroid instead, which is continuous. Strength and angle still come
       * from the argmax — those are what the drawing reads as "how strong".
       */
      prev.sx += m * x; prev.sy += m * y; prev.sm += m;
      if (m > prev.m) { prev.x = x; prev.y = y; prev.m = m; prev.a = a; prev.w = w; }
    }
  }
  let pts = [];
  for (const c of cells.values()) {
    let { x, y } = c;
    if (centroid > 0 && c.sm > 0) {
      x = lerp(c.x, c.sx / c.sm, centroid);
      y = lerp(c.y, c.sy / c.sm, centroid);
    }
    pts.push({ x, y, u: x / aw, v: y / ah, m: c.m, a: c.a, w: c.w });
  }

  if (faceProtect > 0 && face) {
    const cx = face[0] + face[2] / 2;
    const cy = face[1] + face[3] / 2;
    const rand = mulberry32(Math.round(seed * 71) || 71);
    pts = pts.filter((p) => {
      const d = Math.hypot((p.u - cx) / (face[2] * 0.75), (p.v - cy) / (face[3] * 0.75));
      if (d > 1) return true;
      return faceProtect > 1 ? false : rand() > 0.72;
    });
  }
  pts.sort((a, b) => b.m - a.m);
  /*
   * CHURN SOURCE 3 lives in these two lines: a hard rank cut, so every point
   * near the budget boundary pops in and out as the ranking reshuffles. The
   * shipped path keeps them; the stabiliser needs the pool the cut DISCARDS,
   * because incumbency is decided against it — hence `cand` below.
   */
  const cand = pts;
  if (pts.length > budget) pts = pts.slice(0, budget);

  // `lum` is the picture; `blurred` is the field the DETECTOR works on. Nothing
  // downstream may draw with the blurred copy, or the pre-blur slider — a
  // detection control — silently softens the output.
  return { aw, ah, lum: blurred, raw: lum, mag, ang, pts, cand, img, budget, threshold };
}

/* ── Delaunay (Bowyer–Watson), capped ───────────────────────────────────────
   The cap is the reason the family has a point budget at all: this is O(n²)-ish
   in the worst case, and the lab's bench is what set 700. */
export function delaunayTris(points, cap) {
  const pts = points.length > cap ? points.slice(0, cap) : points;
  const n = pts.length;
  if (n < 3) return [];
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const dx = maxX - minX || 1;
  const dy = maxY - minY || 1;
  const dmax = Math.max(dx, dy) * 10;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const P = pts.map((p) => ({ x: p.x, y: p.y }));
  P.push({ x: cx - dmax, y: cy - dmax }, { x: cx + dmax, y: cy - dmax }, { x: cx, y: cy + dmax });
  const si = n;
  const tris = [[si, si + 1, si + 2]];

  const circum = (a, b, c) => {
    const ax = P[a].x; const ay = P[a].y;
    const bx = P[b].x; const by = P[b].y;
    const cxx = P[c].x; const cyy = P[c].y;
    const d = 2 * (ax * (by - cyy) + bx * (cyy - ay) + cxx * (ay - by));
    if (Math.abs(d) < 1e-12) return null;
    const ux = ((ax * ax + ay * ay) * (by - cyy) + (bx * bx + by * by) * (cyy - ay)
      + (cxx * cxx + cyy * cyy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cxx - bx) + (bx * bx + by * by) * (ax - cxx)
      + (cxx * cxx + cyy * cyy) * (bx - ax)) / d;
    return { x: ux, y: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };

  for (let i = 0; i < n; i++) {
    const edges = [];
    for (let t = tris.length - 1; t >= 0; t--) {
      const tri = tris[t];
      const cc = circum(tri[0], tri[1], tri[2]);
      if (!cc) { tris.splice(t, 1); continue; }
      if ((P[i].x - cc.x) ** 2 + (P[i].y - cc.y) ** 2 < cc.r2) {
        tris.splice(t, 1);
        edges.push([tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]);
      }
    }
    for (let a = 0; a < edges.length; a++) {
      let dup = false;
      for (let b = 0; b < edges.length; b++) {
        if (a === b) continue;
        if ((edges[a][0] === edges[b][0] && edges[a][1] === edges[b][1])
          || (edges[a][0] === edges[b][1] && edges[a][1] === edges[b][0])) { dup = true; break; }
      }
      if (!dup) tris.push([edges[a][0], edges[a][1], i]);
    }
  }
  const out = [];
  for (const t of tris) {
    if (t[0] >= si || t[1] >= si || t[2] >= si) continue;   // the super-triangle fan
    out.push([pts[t[0]], pts[t[1]], pts[t[2]]]);
  }
  return out;
}

/** Unique sides of the triangulation — the link graph and the filled plates share one. */
export function delaunayEdges(points, cap, maxDist = Infinity) {
  const seen = new Set();
  const out = [];
  for (const t of delaunayTris(points, cap)) {
    for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
      // ⚠️ Raw Delaunay draws its HULL SLIVERS — long rays from the subject to the
      // frame corners that read as a bug, not a look. The reference never shows
      // them, so Max distance caps the triangulation as well as proximity mode.
      if (Math.hypot(a.x - b.x, a.y - b.y) > maxDist) continue;
      const k = a.x < b.x || (a.x === b.x && a.y < b.y)
        ? `${a.x},${a.y},${b.x},${b.y}` : `${b.x},${b.y},${a.x},${a.y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([a, b]);
    }
  }
  return out;
}

export function proximityEdges(pts, maxDist) {
  const cell = Math.max(4, maxDist);
  const grid = new Map();
  const out = [];
  pts.forEach((p, i) => {
    const k = ((p.y / cell) | 0) * 100000 + ((p.x / cell) | 0);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const d2 = maxDist * maxDist;
  pts.forEach((p, i) => {
    const gx = (p.x / cell) | 0;
    const gy = (p.y / cell) | 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const list = grid.get((gy + oy) * 100000 + (gx + ox));
        if (!list) continue;
        for (const j of list) {
          if (j <= i) continue;
          const q = pts[j];
          const dd = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
          if (dd <= d2) out.push([p, q]);
        }
      }
    }
  });
  return out;
}

/* Greedy nearest-neighbour walks that also respect the contour tangent, so a
   chain follows an outline instead of hopping across the frame. */
export function chainEdges(pts, maxDist) {
  const used = new Uint8Array(pts.length);
  const out = [];
  const cell = Math.max(4, maxDist);
  const grid = new Map();
  pts.forEach((p, i) => {
    const k = ((p.y / cell) | 0) * 100000 + ((p.x / cell) | 0);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const near = (p) => {
    const gx = (p.x / cell) | 0;
    const gy = (p.y / cell) | 0;
    const res = [];
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const l = grid.get((gy + oy) * 100000 + (gx + ox));
        if (l) res.push(...l);
      }
    }
    return res;
  };
  for (let i = 0; i < pts.length; i++) {
    if (used[i]) continue;
    let cur = i;
    used[i] = 1;
    for (let step = 0; step < 40; step++) {
      const p = pts[cur];
      let best = -1;
      let bestScore = Infinity;
      for (const j of near(p)) {
        if (used[j]) continue;
        const q = pts[j];
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d > maxDist) continue;
        const tang = p.a + Math.PI / 2;
        const dir = Math.atan2(q.y - p.y, q.x - p.x);
        let turn = Math.abs(((dir - tang + Math.PI * 3) % TAU) - Math.PI);
        turn = Math.min(turn, Math.PI - turn);
        const score = d * (1 + turn * 1.6);
        if (score < bestScore) { bestScore = score; best = j; }
      }
      if (best < 0) break;
      out.push([pts[cur], pts[best]]);
      used[best] = 1;
      cur = best;
    }
  }
  return out;
}

/* Points spaced at least minDist apart — the anchor picker every program that
   places MARKS rather than strokes uses, so two of them on one layer do not
   stack their motifs on the same feature. */
export function spacedPoints(pts, n, minDist) {
  const out = [];
  for (const p of pts) {
    if (out.length >= n) break;
    let ok = true;
    for (const q of out) {
      if (Math.hypot(p.x - q.x, p.y - q.y) < minDist) { ok = false; break; }
    }
    if (ok) out.push(p);
  }
  return out;
}

/* ── The cache ──────────────────────────────────────────────────────────────
   One entry per (media, frame, extraction params). Every geometry effect on a
   layer reads the same one, which is the whole reason the extraction is a
   module and not a method on an effect.

   The key MUST carry the media's identity. It is a module-global map shared by
   every layer in the project, and a key of "video at 0.0s" matched a second,
   entirely different video sitting at the same source time — the second layer
   was drawn from the first layer's pixels. mediaToken() below is that identity:
   the element itself (a replaced file is a new element) plus its current src, so
   a src swapped into the same element is not the same picture either. */
const CACHE = new Map();
let seq = 0;
const MAX_ENTRIES = 6;

const MEDIA_IDS = new WeakMap();
let mediaSeq = 0;

/** A stable, collision-free identity for one decoded media element. */
export function mediaToken(media) {
  if (!media || typeof media !== 'object') return 'none';
  let id = MEDIA_IDS.get(media);
  if (!id) { id = `m${++mediaSeq}`; MEDIA_IDS.set(media, id); }
  const src = media.currentSrc || media.src || '';
  return `${id}:${src.length}:${src.slice(-48)}`;
}

export function getExtraction(key, media, opts) {
  const hit = CACHE.get(key);
  if (hit) { hit.used = ++seq; return hit.ex; }
  const ex = extractFeatures(media, opts);
  if (!ex) return null;
  CACHE.set(key, { ex, used: ++seq });
  while (CACHE.size > MAX_ENTRIES) {
    let oldest = null;
    let oldestUsed = Infinity;
    for (const [k, v] of CACHE) if (v.used < oldestUsed) { oldestUsed = v.used; oldest = k; }
    CACHE.delete(oldest);
  }
  return ex;
}

/*
 * The gradient normaliser's memory, and why it is HERE rather than on an effect:
 * it is a property of the picture, so two geometry effects on one layer must
 * share it exactly as they share the extraction itself. Keyed by the same string
 * as the extraction minus its frame.
 */
const NORMS = new Map();
const MAX_NORMS = 8;

export function normStateFor(key, ease) {
  let n = NORMS.get(key);
  if (!n) {
    n = { scale: 0, ease };
    NORMS.set(key, n);
    while (NORMS.size > MAX_NORMS) NORMS.delete(NORMS.keys().next().value);
  }
  n.ease = ease;
  return n;
}

/** Forget the running scale — a seek, a new clip, a changed rung. */
export function resetNormState(key) {
  const n = NORMS.get(key);
  if (n) n.scale = 0;
}

export function clearExtractionCache() {
  CACHE.clear();
  NORMS.clear();
}
