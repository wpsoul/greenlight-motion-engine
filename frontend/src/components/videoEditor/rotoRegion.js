/*
 * Small, DOM-free helpers for the RotoScope subject region.
 *
 * A freehand lasso can easily contain hundreds of two-pixel samples. That is
 * useful while drawing, but miserable to fine-tune afterwards. Simplify it to
 * a faithful, bounded polygon before it enters editor state so every remaining
 * point is a useful on-canvas handle.
 */

const distanceToSegment = (p, a, b) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const den = dx * dx + dy * dy;
  if (den <= 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / den));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
};

function simplifyOpen(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let best = tolerance;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = distanceToSegment(points[i], points[lo], points[hi]);
      if (d > best) { best = d; at = i; }
    }
    if (at >= 0) {
      keep[at] = 1;
      stack.push([lo, at], [at, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const ringArea = (points) => {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area * 0.5;
};

/**
 * Simplify a closed lasso while preserving its winding and a hard point cap.
 * Coordinates can be pixels or any other common unit; `tolerance` uses it too.
 */
export function simplifyRotoRegion(points, { tolerance = 2.5, maxPoints = 48 } = {}) {
  const clean = [];
  for (const raw of Array.isArray(points) ? points : []) {
    const p = { x: Number(raw?.x), y: Number(raw?.y) };
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.25) clean.push(p);
  }
  if (clean.length < 3) return clean;

  // A closed ring has no natural first point. Split at the sample furthest
  // from point 0, simplify both arcs, then join them without duplicate ends.
  let split = 1;
  let far = -1;
  for (let i = 1; i < clean.length; i++) {
    const d = Math.hypot(clean[i].x - clean[0].x, clean[i].y - clean[0].y);
    if (d > far) { far = d; split = i; }
  }
  const a = simplifyOpen(clean.slice(0, split + 1), tolerance);
  const b = simplifyOpen([...clean.slice(split), clean[0]], tolerance);
  let out = [...a.slice(0, -1), ...b.slice(0, -1)];

  if (out.length > maxPoints) {
    const capped = [];
    for (let i = 0; i < maxPoints; i++) capped.push(out[Math.floor(i * out.length / maxPoints)]);
    out = capped;
  }
  if (out.length < 3) return clean.slice(0, Math.min(clean.length, maxPoints));
  if (ringArea(out) * ringArea(clean) < 0) out.reverse();
  return out;
}


// ── Pen-drawn regions ────────────────────────────────────────────────────────
//
// A region drawn with the pen is a CLOSED cubic outline: anchors in layer uv
// with tangent offsets (also uv), exactly the shape a layer mask carries. The
// tracker only understands polygons, so the outline is flattened into `pts`
// and the nodes ride alongside it for editing.

/** Tangent lengths for anchors the user did not shape: Catmull-Rom, closed. */
export function smoothRotoNodes(nodes) {
  const list = (Array.isArray(nodes) ? nodes : []).map((q) => ({ ...q }));
  const n = list.length;
  if (n < 2) return list;
  for (let i = 0; i < n; i++) {
    if (list[i].manual) continue;
    const prev = list[(i - 1 + n) % n];
    const next = list[(i + 1) % n];
    const mu = (next.u - prev.u) / 6;
    const mv = (next.v - prev.v) / 6;
    list[i].hOut = { u: mu, v: mv };
    list[i].hIn = { u: -mu, v: -mv };
  }
  return list;
}

const cubic = (a, b, c, d, t) => {
  const s = 1 - t;
  return s * s * s * a + 3 * s * s * t * b + 3 * s * t * t * c + t * t * t * d;
};

/**
 * Closed outline → polygon, `perSegment` samples per cubic (the anchor itself
 * first, so every anchor is a vertex of the polygon and a corner stays sharp).
 * Straight segments (no tangents on either end) contribute only their anchor.
 */
export function flattenRotoNodes(nodes, { perSegment = 12 } = {}) {
  const list = smoothRotoNodes(nodes);
  const n = list.length;
  if (n < 3) return list.map((q) => ({ u: q.u, v: q.v }));
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = list[i];
    const b = list[(i + 1) % n];
    const ho = a.hOut || { u: 0, v: 0 };
    const hi = b.hIn || { u: 0, v: 0 };
    out.push({ u: a.u, v: a.v });
    const straight = !ho.u && !ho.v && !hi.u && !hi.v;
    if (straight) continue;
    const c1u = a.u + ho.u, c1v = a.v + ho.v;
    const c2u = b.u + hi.u, c2v = b.v + hi.v;
    for (let k = 1; k < perSegment; k++) {
      const t = k / perSegment;
      out.push({ u: cubic(a.u, c1u, c2u, b.u, t), v: cubic(a.v, c1v, c2v, b.v, t) });
    }
  }
  return out;
}

/** A polygon (lasso / legacy box) as corner nodes, so it edits like a drawn one. */
export function cornerRotoNodes(pts) {
  return (Array.isArray(pts) ? pts : []).map((p) => ({
    u: Number(p.u ?? p.x), v: Number(p.v ?? p.y),
    hIn: { u: 0, v: 0 }, hOut: { u: 0, v: 0 }, manual: true,
  }));
}
