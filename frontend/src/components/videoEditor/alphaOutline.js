// Alpha-silhouette outlines for Neon Glow on non-shape layers: trace the
// contours of a CPU-readable pixel source (a text/motion canvas, a decoded
// image) and concatenate them into ONE arc-length parameterised run the
// path-following shader can sample. Text is many contours (one or more per
// glyph); they are ordered left→right so the runner writes across the line like
// a single neon wire, with straight bridges between glyphs where the window
// crosses a gap — that is the intended look, not an artifact.

// Downsampled tracing resolution. Higher is crisper but the trace is O(w·h) and
// re-runs whenever the source's content hash changes (animated text).
const TRACE_MAX_DIM = 224;
const HASH_DIM = 48;

let traceCanvas = null;
function getTraceContext(w, h) {
  if (!traceCanvas) traceCanvas = document.createElement('canvas');
  if (traceCanvas.width !== w) traceCanvas.width = w;
  if (traceCanvas.height !== h) traceCanvas.height = h;
  const ctx = traceCanvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

// Cheap content signature of a drawable, for cache invalidation.
export function hashAlphaSource(source) {
  const sw = source.width || source.naturalWidth || 1;
  const sh = source.height || source.naturalHeight || 1;
  const w = HASH_DIM;
  const h = Math.max(1, Math.round((HASH_DIM * sh) / sw));
  const ctx = getTraceContext(w, h);
  try {
    ctx.drawImage(source, 0, 0, w, h);
  } catch {
    return null;
  }
  const data = ctx.getImageData(0, 0, w, h).data;
  let hash = 5381;
  for (let i = 3; i < data.length; i += 4) hash = ((hash << 5) + hash + data[i]) | 0;
  // ASPECT, not raw dimensions. Text and shape plates are now allocated at an
  // adaptive raster density, so the same artwork legitimately arrives at 1x, 2x or 4x
  // the pixel size; keying on sw/sh would throw the traced outline away on every
  // density change and re-run an O(w·h) trace mid-zoom. The content hash above is
  // taken from a fixed-size downsample, so it is already density-independent in
  // content terms — resampling noise can still shift it occasionally, but that costs
  // one re-trace per bucket change rather than a guaranteed one.
  return `${(sw / Math.max(1, sh)).toFixed(4)}:${hash >>> 0}`;
}

// Moore-neighbour boundary tracing over the alpha mask. Returns closed contours
// as arrays of [x, y] in downsampled pixel coords, largest structures first.
function traceContours(mask, w, h) {
  const idx = (x, y) => y * w + x;
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[idx(x, y)] === 1;
  // Moore neighbourhood, clockwise starting east.
  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DY = [0, 1, 1, 1, 0, -1, -1, -1];
  const visited = new Uint8Array(w * h);
  const contours = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!inside(x, y) || visited[idx(x, y)]) continue;
      // A boundary start: filled pixel whose left neighbour is empty.
      if (inside(x - 1, y)) { continue; }
      const contour = [];
      let cx = x;
      let cy = y;
      // Backtrack direction: we entered from the west.
      let dir = 4;
      const maxSteps = w * h * 4;
      for (let step = 0; step < maxSteps; step += 1) {
        visited[idx(cx, cy)] = 1;
        contour.push(cx, cy);
        // Scan clockwise from just past the backtrack.
        let found = -1;
        for (let k = 1; k <= 8; k += 1) {
          const d = (dir + k) % 8;
          if (inside(cx + DX[d], cy + DY[d])) { found = d; break; }
        }
        if (found < 0) break; // isolated pixel
        cx += DX[found];
        cy += DY[found];
        dir = (found + 4) % 8; // new backtrack = where we came from
        if (cx === x && cy === y && contour.length > 4) break;
      }
      if (contour.length >= 8) contours.push(contour);
    }
  }
  return contours;
}

function contourLength(pts) {
  let len = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const j = (i + 2) % pts.length;
    len += Math.hypot(pts[j] - pts[i], pts[j + 1] - pts[i + 1]);
  }
  return len;
}

// Light closed-loop smoothing to knock the pixel staircase off the trace.
function smoothContour(pts, iterations = 2) {
  let cur = pts;
  const n = pts.length / 2;
  if (n < 6) return pts;
  for (let it = 0; it < iterations; it += 1) {
    const out = new Array(cur.length);
    for (let i = 0; i < n; i += 1) {
      const p = ((i - 1 + n) % n) * 2;
      const c = i * 2;
      const nx = ((i + 1) % n) * 2;
      out[c] = (cur[p] + cur[c] * 2 + cur[nx]) / 4;
      out[c + 1] = (cur[p + 1] + cur[c + 1] * 2 + cur[nx + 1]) / 4;
    }
    cur = out;
  }
  return cur;
}

/**
 * Trace `source` (canvas or decoded image) and concatenate its contours into
 * `n` positions at equal arc length, as fractions (0..1, y down) of the source.
 * Returns { frac: Float32Array(n*2), closed: true, hasAlpha } or null when the
 * source has no usable silhouette (fully transparent, or fully opaque — the
 * caller falls back to the media rect for those).
 */
export function sampleAlphaOutline(source, n, { threshold = 0.5 } = {}) {
  const sw = source.width || source.naturalWidth || 0;
  const sh = source.height || source.naturalHeight || 0;
  if (!(sw > 1) || !(sh > 1)) return null;
  const scale = Math.min(1, TRACE_MAX_DIM / Math.max(sw, sh));
  const w = Math.max(2, Math.round(sw * scale));
  const h = Math.max(2, Math.round(sh * scale));
  const ctx = getTraceContext(w, h);
  let data = null;
  try {
    ctx.drawImage(source, 0, 0, w, h);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
  const thr = Math.round(threshold * 255);
  const mask = new Uint8Array(w * h);
  let filled = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (data[i * 4 + 3] >= thr) { mask[i] = 1; filled += 1; }
  }
  if (filled === 0) return null;
  // Fully opaque source: the "outline" would be the raster border — that is the
  // media rect's job, with real corner radii, so report it instead of tracing.
  if (filled === mask.length) return { frac: null, closed: true, hasAlpha: false };

  let contours = traceContours(mask, w, h);
  if (contours.length === 0) return null;
  const measured = contours
    .map((pts) => ({ pts: smoothContour(pts), len: 0 }))
    .map((c) => ({ ...c, len: contourLength(c.pts) }))
    .filter((c) => c.len > 4);
  if (measured.length === 0) return null;
  const longest = measured.reduce((m, c) => Math.max(m, c.len), 0);
  // Drop specks, keep at most 16 structures, and order them left→right (then
  // top→bottom) so a text line is written in reading order.
  const kept = measured
    .filter((c) => c.len >= longest * 0.04)
    .slice(0, 64)
    .sort((a, b) => {
      const ax = a.pts[0];
      const bx = b.pts[0];
      return Math.abs(ax - bx) > 2 ? ax - bx : a.pts[1] - b.pts[1];
    })
    .slice(0, 16);
  const total = kept.reduce((sum, c) => sum + c.len, 0);
  if (!(total > 0)) return null;

  const frac = new Float32Array(n * 2);
  // 1 marks the FIRST sample of each contour: the segment arriving there is a
  // bridge between glyphs/blobs, which the full-outline shader mode must skip.
  const breaks = new Uint8Array(n);
  let out = 0;
  let remaining = n;
  for (let ci = 0; ci < kept.length; ci += 1) {
    const c = kept[ci];
    const quota = ci === kept.length - 1
      ? remaining
      : Math.max(2, Math.min(remaining - (kept.length - 1 - ci) * 2, Math.round((c.len / total) * n)));
    remaining -= quota;
    breaks[out] = 1;
    // Walk this closed contour at equal arc length, including its closing edge.
    const pts = c.pts;
    const m = pts.length / 2;
    const step = c.len / quota;
    let target = 0;
    let acc = 0;
    let seg = 0;
    for (let s = 0; s < quota; s += 1) {
      while (seg < m) {
        const i = seg * 2;
        const j = ((seg + 1) % m) * 2;
        const d = Math.hypot(pts[j] - pts[i], pts[j + 1] - pts[i + 1]);
        if (acc + d >= target || seg === m - 1) {
          const f = d > 1e-6 ? Math.max(0, Math.min(1, (target - acc) / d)) : 0;
          frac[out * 2] = (pts[i] + (pts[j] - pts[i]) * f + 0.5) / w;
          frac[out * 2 + 1] = (pts[i + 1] + (pts[j + 1] - pts[i + 1]) * f + 0.5) / h;
          out += 1;
          break;
        }
        acc += d;
        seg += 1;
      }
      target += step;
    }
  }
  // Numerical stragglers: pad with the last written sample.
  for (; out < n; out += 1) {
    frac[out * 2] = frac[(out - 1) * 2];
    frac[out * 2 + 1] = frac[(out - 1) * 2 + 1];
  }
  return { frac, breaks, closed: true, hasAlpha: true };
}

/**
 * Tight bounding box of everything non-transparent in `source`, as fractions of
 * the source (0..1, y down): { x0, y0, x1, y1 }.
 *
 * Repetile needs this because a text or motion layer's plate is comp-sized by
 * construction — the glyphs occupy a fraction of it — so the quad's geometry box
 * is the whole frame and tiling it produces one frame-sized tile. Fully opaque
 * sources return the full rect, which makes the caller a no-op for ordinary video
 * and photos: the plate already IS the content there.
 *
 * Same downsampled raster and threshold as the outline tracer, so a glyph edge
 * lands in the same place for both.
 */
export function sampleAlphaBounds(source, { threshold = 0.5 } = {}) {
  const sw = source.width || source.naturalWidth || 0;
  const sh = source.height || source.naturalHeight || 0;
  if (!(sw > 1) || !(sh > 1)) return null;
  const scale = Math.min(1, TRACE_MAX_DIM / Math.max(sw, sh));
  const w = Math.max(2, Math.round(sw * scale));
  const h = Math.max(2, Math.round(sh * scale));
  const ctx = getTraceContext(w, h);
  let data = null;
  try {
    ctx.drawImage(source, 0, 0, w, h);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
  const thr = Math.round(threshold * 255);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * 4 + 3] < thr) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null; // fully transparent — nothing to bound
  // Cover the sampled texels, not their centres, so the box does not clip the
  // outermost row/column of pixels it found.
  return {
    x0: minX / w,
    y0: minY / h,
    x1: (maxX + 1) / w,
    y1: (maxY + 1) / h,
  };
}
