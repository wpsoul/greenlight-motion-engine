/*
 * Smooth & reduce anchors on any bezier path in the editor.
 *
 * Every path the app owns stores the same point shape — object motion paths
 * (objectMotionPath.js), shape/line paths and layer masks (shapePath.js), the
 * project camera path (projectCamera.js) and the Flipbook's camera + Line Path
 * objects — so one module serves all of them:
 *
 *   { x, y, z?, hIn:{…}, hOut:{…}, manual?, rx?, ry?, rz? }   // handles are OFFSETS
 *
 * Nothing here knows about units. Tolerances are expressed as a fraction of the
 * path's own bounding-box diagonal, which is what makes the same "Smoothing 34%"
 * mean the same thing on a 1920px motion path and a ±0.5 unit-box mask.
 *
 * Four modes, because "too many points" has four different right answers:
 *
 *   fit     — refit the curve with as few cubics as the tolerance allows. Fewest
 *             anchors, but they land in NEW places.
 *   reduce  — drop only the redundant anchors and refit the handles around them.
 *             Survivors keep their exact coordinates, rotations and per-point
 *             keyframe meaning, so this is the keyframe-safe reduction.
 *   even    — rebuild with exactly N anchors at equal arc length.
 *   relax   — keep every anchor, average out the shake (tracked/hand-drawn input).
 *
 * The fit is Schneider's least-squares cubic fitter, the same one rasterTracer.js
 * uses to turn traced bitmaps into outlines — deliberately shared maths, so a
 * traced shape and a smoothed shape have the same character.
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round4 = (n) => Math.round(n * 10000) / 10000;
const num = (v, fallback = 0) => {
  const parsed = Number.parseFloat(v);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/* ── 3-component vector helpers (z is 0 for 2D paths) ────────────────────── */
const V = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  mul: (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
  neg: (a) => ({ x: -a.x, y: -a.y, z: -a.z }),
  dot: (a, b) => (a.x * b.x) + (a.y * b.y) + (a.z * b.z),
  len: (a) => Math.sqrt((a.x * a.x) + (a.y * a.y) + (a.z * a.z)),
  norm: (a) => {
    const l = V.len(a) || 1;
    return { x: a.x / l, y: a.y / l, z: a.z / l };
  },
};
const vec = (v) => ({ x: num(v?.x), y: num(v?.y), z: num(v?.z) });

export const SMOOTH_MODES = ['fit', 'reduce', 'even', 'relax'];

// Modes that cannot change the anchor count, and are therefore always legal on a
// keyframed path (shape morphs, mask path keys and one-key-per-anchor progress
// tracks all require every key to hold the same number of points).
export const COUNT_SAFE_MODES = ['relax'];

export const SMOOTH_DEFAULTS = {
  mode: 'fit',
  amount: 34,        // 0-100, the single knob; maps to the fit tolerance
  limitPoints: true,
  maxPoints: 24,
  evenCount: 12,
  cornerDeg: 34,     // keep turns sharper than this as corners
  relaxStrength: 45, // 0-100
  relaxPasses: 4,
  relaxPinCorners: true,
};

/**
 * Amount (0-100) → tolerance, as a fraction of the bbox diagonal.
 *
 * Quadratic-ish so the low half of the slider is fine control (the useful range
 * for "tidy this up") and the top half is aggressive compression.
 */
export const amountToEpsilon = (amount, diagonal) => (
  (0.0006 + (clamp(num(amount), 0, 100) / 100) ** 2.2 * 0.055) * (diagonal || 1)
);

/* ── geometry basics ─────────────────────────────────────────────────────── */
export function pathBounds(points) {
  let x0 = Infinity; let y0 = Infinity; let z0 = Infinity;
  let x1 = -Infinity; let y1 = -Infinity; let z1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); z0 = Math.min(z0, num(p.z));
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); z1 = Math.max(z1, num(p.z));
  }
  if (!Number.isFinite(x0)) return { w: 0, h: 0, d: 0, diagonal: 1 };
  const w = x1 - x0; const h = y1 - y0; const d = z1 - z0;
  const diagonal = Math.sqrt((w * w) + (h * h) + (d * d));
  return { w, h, d, diagonal: diagonal > 1e-9 ? diagonal : 1 };
}

const bezierAt = (b, t) => {
  const u = 1 - t;
  const b0 = u * u * u; const b1 = 3 * u * u * t; const b2 = 3 * u * t * t; const b3 = t * t * t;
  return {
    x: (b[0].x * b0) + (b[1].x * b1) + (b[2].x * b2) + (b[3].x * b3),
    y: (b[0].y * b0) + (b[1].y * b1) + (b[2].y * b2) + (b[3].y * b3),
    z: (b[0].z * b0) + (b[1].z * b1) + (b[2].z * b2) + (b[3].z * b3),
  };
};
const bezierTangentAt = (b, t) => {
  const u = 1 - t;
  const k = (i) => (3 * u * u * (b[1][i] - b[0][i])) + (6 * u * t * (b[2][i] - b[1][i])) + (3 * t * t * (b[3][i] - b[2][i]));
  return { x: k('x'), y: k('y'), z: k('z') };
};

const segmentCount = (points, closed) => {
  const n = points.length;
  if (n < 2) return 0;
  return closed ? n : n - 1;
};

/** The four control points of segment `i`, handles resolved to absolute space. */
export function segmentOf(points, i) {
  const a = points[i];
  const b = points[(i + 1) % points.length];
  const ah = vec(a.hOut); const bh = vec(b.hIn);
  const A = vec(a); const B = vec(b);
  return [A, V.add(A, ah), V.add(B, bh), B];
}

/**
 * Dense polyline for a path, plus the sample index each anchor landed on.
 *
 * Every mode starts here: deviation cannot be measured on anchors, only on the
 * curve, and `anchorAt` is what lets Reduce map a run of samples back to the
 * anchors that bound it.
 */
export function flattenPath(points, closed, step) {
  const segs = segmentCount(points, closed);
  const pts = []; const anchorAt = [];
  if (segs < 1) return { pts: points.map(vec), anchorAt: points.map((_, i) => i) };
  for (let i = 0; i < segs; i += 1) {
    const b = segmentOf(points, i);
    const poly = V.len(V.sub(b[1], b[0])) + V.len(V.sub(b[2], b[1])) + V.len(V.sub(b[3], b[2]));
    const n = clamp(Math.ceil(poly / Math.max(1e-6, step)), 4, 400);
    anchorAt.push(pts.length);
    for (let k = 0; k < n; k += 1) pts.push(bezierAt(b, k / n));
  }
  if (!closed) { anchorAt.push(pts.length); pts.push(vec(points[points.length - 1])); }
  return { pts, anchorAt };
}

const polylineLength = (pts, closed) => {
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) total += V.len(V.sub(pts[i], pts[i - 1]));
  if (closed && pts.length > 1) total += V.len(V.sub(pts[0], pts[pts.length - 1]));
  return total;
};

/* ── Ramer-Douglas-Peucker, index preserving ─────────────────────────────── */
function rdpIdx(pts, idxs, eps) {
  const m = idxs.length;
  if (m < 3) return idxs.slice();
  const keep = new Uint8Array(m); keep[0] = 1; keep[m - 1] = 1;
  const stack = [[0, m - 1]]; const eps2 = eps * eps;
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const p0 = pts[idxs[a]]; const p1 = pts[idxs[b]];
    const d = V.sub(p1, p0); const den = V.dot(d, d);
    let best = -1; let bestD = -1;
    for (let i = a + 1; i < b; i += 1) {
      const p = pts[idxs[i]];
      const rel = V.sub(p, p0);
      let dist2;
      if (den < 1e-12) dist2 = V.dot(rel, rel);
      else {
        const t = clamp(V.dot(rel, d) / den, 0, 1);
        const q = V.sub(rel, V.mul(d, t));
        dist2 = V.dot(q, q);
      }
      if (dist2 > bestD) { bestD = dist2; best = i; }
    }
    if (bestD > eps2 && best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = [];
  for (let i = 0; i < m; i += 1) if (keep[i]) out.push(idxs[i]);
  return out;
}

function rdpIndices(pts, closed, eps) {
  const n = pts.length;
  if (n < 4) return pts.map((_, i) => i);
  if (!closed) return rdpIdx(pts, pts.map((_, i) => i), eps);
  // A ring has no natural first point. Seed with two vertices certainly on the
  // hull so the first chord cannot shortcut a whole side.
  let c = { x: 0, y: 0, z: 0 };
  for (const p of pts) c = V.add(c, p);
  c = V.mul(c, 1 / n);
  let i0 = 0; let far = -1;
  for (let i = 0; i < n; i += 1) { const d = V.len(V.sub(pts[i], c)); if (d > far) { far = d; i0 = i; } }
  let i1 = i0; far = -1;
  for (let i = 0; i < n; i += 1) { const d = V.len(V.sub(pts[i], pts[i0])); if (d > far) { far = d; i1 = i; } }
  const wrap = (a, b) => { const out = []; for (let i = a; ; i = (i + 1) % n) { out.push(i); if (i === b) break; } return out; };
  const a = rdpIdx(pts, wrap(i0, i1), eps);
  const b = rdpIdx(pts, wrap(i1, i0), eps);
  return a.slice(0, -1).concat(b.slice(0, -1)).sort((p, q) => p - q);
}

/* ── corner detection ────────────────────────────────────────────────────── */
// Direction out of sample `i`, measured across an arc-length WINDOW rather than
// to the next sample: a rounded 90° turn reads as a run of gentle bends when
// measured between neighbours, and no corner is ever found.
function dirFrom(pts, i, step, closed, minDist) {
  const n = pts.length; let j = i;
  for (let g = 0; g < n; g += 1) {
    const k = j + step;
    if (closed) j = ((k % n) + n) % n;
    else { if (k < 0 || k >= n) break; j = k; }
    if (V.len(V.sub(pts[j], pts[i])) >= minDist) break;
  }
  const v = V.sub(pts[j], pts[i]);
  return V.len(v) < 1e-9 ? { x: 1, y: 0, z: 0 } : V.norm(v);
}

function arcTable(pts, closed) {
  const acc = [0];
  for (let i = 1; i < pts.length; i += 1) acc.push(acc[i - 1] + V.len(V.sub(pts[i], pts[i - 1])));
  const total = acc[acc.length - 1] + (closed && pts.length > 1 ? V.len(V.sub(pts[0], pts[pts.length - 1])) : 0);
  return { acc, total: total || 1 };
}

function findCorners(pts, closed, { cornerDeg, cornerWindow, epsilon }) {
  if (cornerDeg >= 180) return [];
  const sparse = rdpIndices(pts, closed, epsilon);
  const { acc, total } = arcTable(pts, closed);
  const gap = (i, j) => {
    let d = acc[j] - acc[i];
    if (closed) { d = ((d % total) + total) % total; return Math.min(d, total - d); }
    return Math.abs(d);
  };
  const turnAt = (idx) => {
    const a = dirFrom(pts, idx, -1, closed, cornerWindow);
    const b = dirFrom(pts, idx, 1, closed, cornerWindow);
    return 180 - ((Math.acos(clamp(V.dot(a, b), -1, 1)) * 180) / Math.PI); // 0 = straight through
  };
  const from = closed ? 0 : 1;
  const to = closed ? sparse.length - 1 : sparse.length - 2;
  const cand = [];
  for (let k = from; k <= to; k += 1) {
    const turn = turnAt(sparse[k]);
    if (turn >= cornerDeg) cand.push({ i: sparse[k], turn });
  }
  if (!cand.length) return [];
  // One anchor per rounded corner — a smoothed 90° turn is several candidates a
  // few pixels apart. Candidates only merge when they are within a corner WINDOW
  // of each other ALONG THE CURVE; merging by adjacency in the list instead
  // collapses every vertex of a zigzag into a single corner.
  const groups = [];
  let cur = null;
  for (const cd of cand) {
    if (cur && gap(cur.last, cd.i) <= cornerWindow * 2) {
      cur.last = cd.i;
      if (cd.turn > cur.turn) { cur.best = cd.i; cur.turn = cd.turn; }
    } else { cur = { best: cd.i, turn: cd.turn, last: cd.i }; groups.push(cur); }
  }
  if (closed && groups.length > 1) {
    const a = groups[0]; const b = groups[groups.length - 1];
    if (gap(b.last, a.best) <= cornerWindow * 2) { if (b.turn > a.turn) a.best = b.best; groups.pop(); }
  }
  return groups.map((g) => g.best).sort((a, b) => a - b);
}

/* ── Schneider least-squares cubic fit ───────────────────────────────────── */
function chordParams(pts) {
  const u = [0];
  for (let i = 1; i < pts.length; i += 1) u.push(u[i - 1] + V.len(V.sub(pts[i], pts[i - 1])));
  const total = u[u.length - 1] || 1;
  return u.map((x) => x / total);
}

function generateBezier(pts, u, t1, t2) {
  const n = pts.length; const first = pts[0]; const last = pts[n - 1];
  let c00 = 0; let c01 = 0; let c11 = 0; let x0 = 0; let x1 = 0;
  for (let i = 0; i < n; i += 1) {
    const t = u[i]; const om = 1 - t;
    const a0 = V.mul(t1, 3 * om * om * t); const a1 = V.mul(t2, 3 * om * t * t);
    c00 += V.dot(a0, a0); c01 += V.dot(a0, a1); c11 += V.dot(a1, a1);
    const b0 = om * om * om; const b1 = 3 * om * om * t; const b2 = 3 * om * t * t; const b3 = t * t * t;
    const tmp = V.sub(pts[i], V.add(V.mul(first, b0 + b1), V.mul(last, b2 + b3)));
    x0 += V.dot(a0, tmp); x1 += V.dot(a1, tmp);
  }
  const det = (c00 * c11) - (c01 * c01);
  let a0 = 0; let a1 = 0;
  if (Math.abs(det) > 1e-12) { a0 = ((x0 * c11) - (x1 * c01)) / det; a1 = ((c00 * x1) - (c01 * x0)) / det; }
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
    const d = V.sub(bezierAt(bez, u[i]), pts[i]);
    const d2 = V.dot(d, d);
    if (d2 > max) { max = d2; split = i; }
  }
  return { max, split };
}

function reparameterize(pts, bez, u) {
  return u.map((t, i) => {
    const p = bezierAt(bez, t); const d1 = bezierTangentAt(bez, t); const um = 1 - t;
    const d2 = V.add(
      V.mul(V.add(V.sub(bez[2], V.mul(bez[1], 2)), bez[0]), 6 * um),
      V.mul(V.add(V.sub(bez[3], V.mul(bez[2], 2)), bez[1]), 6 * t)
    );
    const diff = V.sub(p, pts[i]);
    const den = V.dot(d1, d1) + V.dot(diff, d2);
    if (Math.abs(den) < 1e-12) return t;
    return t - (V.dot(diff, d1) / den);
  });
}

/** One cubic through a run, Newton-refined. Returns { bez, err } with err in path units. */
function fitOne(pts, t1, t2) {
  if (pts.length === 2) {
    const d = V.len(V.sub(pts[1], pts[0])) / 3;
    return { bez: [pts[0], V.add(pts[0], V.mul(t1, d)), V.add(pts[1], V.mul(t2, d)), pts[1]], err: 0, split: 0 };
  }
  let u = chordParams(pts);
  let bez = generateBezier(pts, u, t1, t2);
  let e = maxError(pts, bez, u);
  for (let i = 0; i < 8 && e.max > 1e-12; i += 1) {
    const up = reparameterize(pts, bez, u);
    const nb = generateBezier(pts, up, t1, t2);
    const ne = maxError(pts, nb, up);
    if (ne.max >= e.max) break;
    u = up; bez = nb; e = ne;
  }
  return { bez, err: Math.sqrt(e.max), split: e.split };
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

const beziersToAnchors = (beziers, closed) => {
  const out = beziers.map((b, i) => {
    const prev = beziers[(i - 1 + beziers.length) % beziers.length];
    return {
      x: b[0].x, y: b[0].y, z: b[0].z,
      hOut: V.sub(b[1], b[0]),
      hIn: (closed || i > 0) ? V.sub(prev[2], prev[3]) : { x: 0, y: 0, z: 0 },
      manual: true,
    };
  });
  if (!closed) {
    const last = beziers[beziers.length - 1];
    out.push({
      x: last[3].x, y: last[3].y, z: last[3].z,
      hIn: V.sub(last[2], last[3]),
      hOut: { x: 0, y: 0, z: 0 },
      manual: true,
    });
  }
  return out;
};

/* ══ MODE 1 · FIT ════════════════════════════════════════════════════════ */
function modeFit(dense, closed, opts) {
  const { pts } = dense;
  const n = pts.length;
  const corners = findCorners(pts, closed, opts);
  const build = (errPx) => {
    const errSq = errPx * errPx;
    const beziers = [];
    if (closed && corners.length < 2) {
      const loop = pts.concat([pts[0]]);
      const t1 = V.norm(V.sub(pts[1], pts[n - 1]));
      fitCubic(loop, t1, V.neg(t1), errSq, beziers);
    } else if (closed) {
      for (let c = 0; c < corners.length; c += 1) {
        const a = corners[c]; const b = corners[(c + 1) % corners.length];
        const run = [];
        for (let i = a; ; i = (i + 1) % n) { run.push(pts[i]); if (i === b) break; }
        if (run.length < 2) continue;
        fitCubic(run, dirFrom(run, 0, 1, false, opts.cornerWindow),
          dirFrom(run, run.length - 1, -1, false, opts.cornerWindow), errSq, beziers);
      }
    } else {
      const cuts = [0, ...corners.filter((i) => i > 0 && i < n - 1), n - 1];
      for (let c = 0; c < cuts.length - 1; c += 1) {
        const run = pts.slice(cuts[c], cuts[c + 1] + 1);
        if (run.length < 2) continue;
        fitCubic(run, dirFrom(run, 0, 1, false, opts.cornerWindow),
          dirFrom(run, run.length - 1, -1, false, opts.cornerWindow), errSq, beziers);
      }
    }
    return beziers;
  };
  let epsilon = opts.errPx;
  let beziers = build(epsilon);
  const cap = opts.maxPoints || Infinity;
  // Over the cap: loosen and refit rather than deleting anchors, so what survives
  // is still the best fit for the count it ends up with.
  for (let guard = 0; beziers.length + (closed ? 0 : 1) > cap && guard < 9; guard += 1) {
    epsilon *= 1.7;
    beziers = build(epsilon);
  }
  if (!beziers.length) return null;
  return { points: beziersToAnchors(beziers, closed), corners: corners.length, epsilon };
}

/* ══ MODE 2 · REDUCE ═════════════════════════════════════════════════════
 * Splits are only allowed AT original anchors — that is the whole difference
 * from Fit. Fewer degrees of freedom, a few more points for the same error, and
 * every surviving anchor is still the same anchor it was.                     */
function modeReduce(source, dense, closed, opts) {
  const { pts, anchorAt } = dense;
  const nA = source.length;
  const sampleRange = (i, j) => {
    const a = anchorAt[i]; const b = anchorAt[j];
    if (!closed || a < b) return pts.slice(a, b + 1);
    const run = [];
    for (let k = a; ; k = (k + 1) % pts.length) { run.push(pts[k]); if (k === b) break; }
    return run;
  };
  const tanOut = (i) => {
    const h = vec(source[i].hOut);
    if (V.len(h) > 1e-9) return V.norm(h);
    return dirFrom(pts, anchorAt[i], 1, closed, opts.cornerWindow * 0.2);
  };
  const tanIn = (j) => {
    const h = vec(source[j].hIn);
    if (V.len(h) > 1e-9) return V.norm(h);
    return dirFrom(pts, anchorAt[j], -1, closed, opts.cornerWindow * 0.2);
  };
  const spanFit = (i, j) => {
    const run = sampleRange(i, j);
    if (run.length < 2) return null;
    return fitOne(run, tanOut(i), tanIn(j));
  };
  const keptFor = (errPx) => {
    const kept = new Set();
    const walk = (i, j, depth) => {
      kept.add(i); kept.add(j);
      const steps = closed ? ((j - i + nA) % nA) : (j - i);
      if (steps <= 1) return;
      const fit = spanFit(i, j);
      if (!fit || fit.err <= errPx || depth > 40) return;
      const run = sampleRange(i, j);
      const frac = clamp((fit.split || Math.floor(run.length / 2)) / Math.max(1, run.length - 1), 0.001, 0.999);
      let mid = i + clamp(Math.round(steps * frac), 1, steps - 1);
      if (closed) mid %= nA;
      walk(i, mid, depth + 1); walk(mid, j, depth + 1);
    };
    if (closed) {
      let far = -1; let i1 = 1;
      for (let i = 1; i < nA; i += 1) {
        const d = V.len(V.sub(vec(source[i]), vec(source[0])));
        if (d > far) { far = d; i1 = i; }
      }
      walk(0, i1, 0); walk(i1, 0, 0);
    } else walk(0, nA - 1, 0);
    return [...kept].sort((a, b) => a - b);
  };

  let epsilon = opts.errPx;
  let kept = keptFor(epsilon);
  const cap = opts.maxPoints || Infinity;
  for (let guard = 0; kept.length > cap && guard < 9; guard += 1) { epsilon *= 1.7; kept = keptFor(epsilon); }

  const points = kept.map((idx, k) => {
    const next = kept[(k + 1) % kept.length];
    const prev = kept[(k - 1 + kept.length) % kept.length];
    const src = source[idx];
    const fOut = (closed || k < kept.length - 1) ? spanFit(idx, next) : null;
    const fIn = (closed || k > 0) ? spanFit(prev, idx) : null;
    return {
      ...src,
      x: src.x, y: src.y, z: num(src.z),
      hOut: fOut ? V.sub(fOut.bez[1], fOut.bez[0]) : { x: 0, y: 0, z: 0 },
      hIn: fIn ? V.sub(fIn.bez[2], fIn.bez[3]) : { x: 0, y: 0, z: 0 },
      manual: true,
    };
  });
  return { points, corners: 0, epsilon, keptIndexes: kept };
}

/* ══ MODE 3 · EVEN — the resampleShapePath maths, in 3D ══════════════════ */
export function evaluatePathAt(points, closed, u) {
  const segments = segmentCount(points, closed);
  if (segments < 1) return null;
  const cl = closed ? ((u % 1) + 1) % 1 : clamp(u, 0, 1);
  const scaled = cl * segments;
  let index = Math.floor(scaled);
  if (index >= segments) index = segments - 1;
  const t = scaled - index;
  const b = segmentOf(points, index);
  return { position: bezierAt(b, t), derivative: V.mul(bezierTangentAt(b, t), segments) };
}

function modeEven(source, closed, count) {
  const n = clamp(Math.round(count), 2, 400);
  if (source.length < 2) return null;
  const segments = segmentCount(source, closed);
  const STEPS = Math.max(400, segments * 80);
  const us = [0]; const lens = [0];
  let prev = evaluatePathAt(source, closed, 0).position; let total = 0;
  for (let i = 1; i <= STEPS; i += 1) {
    const u = i / STEPS;
    const p = evaluatePathAt(source, closed, u).position;
    total += V.len(V.sub(p, prev));
    us.push(u); lens.push(total); prev = p;
  }
  if (total <= 1e-9) return null;
  const uAt = (target) => {
    for (let i = 1; i < lens.length; i += 1) {
      if (lens[i] >= target) {
        const span = lens[i] - lens[i - 1] || 1;
        return us[i - 1] + (us[i] - us[i - 1]) * ((target - lens[i - 1]) / span);
      }
    }
    return 1;
  };
  const intervals = closed ? n : n - 1;
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const u = i === 0 ? 0 : uAt((total * i) / intervals);
    samples.push({ u, hit: evaluatePathAt(source, closed, Math.min(u, 1)) });
  }
  const points = samples.map((s, i) => {
    const next = samples[(i + 1) % samples.length];
    const prevS = samples[(i - 1 + samples.length) % samples.length];
    const spanOut = (closed && i === samples.length - 1) ? (1 - s.u) + next.u : next.u - s.u;
    const spanIn = (closed && i === 0) ? s.u + (1 - prevS.u) : s.u - prevS.u;
    const dOut = (closed || i < samples.length - 1) ? Math.max(spanOut, 0) / 3 : 0;
    const dIn = (closed || i > 0) ? Math.max(spanIn, 0) / 3 : 0;
    return {
      x: s.hit.position.x, y: s.hit.position.y, z: s.hit.position.z,
      hOut: V.mul(s.hit.derivative, dOut),
      hIn: V.mul(s.hit.derivative, -dIn),
      manual: true,
      _u: s.u,
    };
  });
  return { points, corners: 0, epsilon: 0 };
}

/* ══ MODE 4 · RELAX ══════════════════════════════════════════════════════ */
function modeRelax(source, closed, opts) {
  const n = source.length;
  if (n < 3) return null;
  const strength = clamp(num(opts.relaxStrength, 45) / 100, 0, 1);
  const passes = clamp(Math.round(num(opts.relaxPasses, 4)), 1, 40);
  const pinned = new Uint8Array(n);
  if (opts.relaxPinCorners) {
    if (!closed) { pinned[0] = 1; pinned[n - 1] = 1; }
    for (let i = 0; i < n; i += 1) {
      if (!closed && (i === 0 || i === n - 1)) continue;
      const a = vec(source[(i - 1 + n) % n]); const b = vec(source[(i + 1) % n]); const p = vec(source[i]);
      const d1 = V.norm(V.sub(p, a)); const d2 = V.norm(V.sub(b, p));
      const turn = (Math.acos(clamp(V.dot(d1, d2), -1, 1)) * 180) / Math.PI;
      if (turn >= opts.cornerDeg) pinned[i] = 1;
    }
  } else if (!closed) { pinned[0] = 1; pinned[n - 1] = 1; }

  let pts = source.map((p) => vec(p));
  for (let pass = 0; pass < passes; pass += 1) {
    const next = pts.map((p, i) => {
      if (pinned[i]) return p;
      const a = pts[(i - 1 + n) % n]; const b = pts[(i + 1) % n];
      const mid = V.mul(V.add(a, b), 0.5);
      return V.add(p, V.mul(V.sub(mid, p), strength));
    });
    pts = next;
  }
  // Relax keeps the anchor list, so everything a point carries rides along; only
  // the coordinates and the auto tangents change.
  const points = source.map((src, i) => ({
    ...src, x: pts[i].x, y: pts[i].y, z: pts[i].z, manual: false, hIn: undefined, hOut: undefined,
  }));
  refreshAutoHandles(points, closed);
  return { points, corners: 0, epsilon: 0, pinned: Array.from(pinned) };
}

/** Catmull-Rom auto tangents — the same maths as refreshShapePathHandles, in 3D. */
export function refreshAutoHandles(points, closed) {
  const n = points.length;
  if (n < 2) return points;
  const at = (i) => points[closed ? ((i % n) + n) % n : clamp(i, 0, n - 1)];
  for (let i = 0; i < n; i += 1) {
    if (points[i].manual) continue;
    const prev = vec(at(i - 1)); const next = vec(at(i + 1)); const cur = vec(points[i]);
    let m;
    if (!closed && i === 0) m = V.sub(next, cur);
    else if (!closed && i === n - 1) m = V.sub(cur, prev);
    else m = V.mul(V.sub(next, prev), 0.5);
    m = V.mul(m, 1 / 3);
    points[i].hOut = { x: m.x, y: m.y, z: m.z };
    points[i].hIn = { x: -m.x, y: -m.y, z: -m.z };
  }
  return points;
}

/* ── deviation between two dense polylines ───────────────────────────────────
 * Uniform-grid nearest-segment lookup rather than a marching pointer. A pointer
 * that walks both curves in step is cheaper, but it silently loses its place on a
 * noisy path — once it falls behind it measures the distance to a different part
 * of the curve and reports a deviation the size of the whole path.
 */
function buildSegGrid(poly, closed) {
  const segs = closed ? poly.length : poly.length - 1;
  const b = pathBounds(poly);
  let x0 = Infinity; let y0 = Infinity; let z0 = Infinity;
  for (const p of poly) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); z0 = Math.min(z0, p.z); }
  const cell = clamp(b.diagonal / 90, 1e-6, Infinity);
  const map = new Map();
  const cellOf = (v, base) => Math.floor((v - base) / cell);
  for (let i = 0; i < segs; i += 1) {
    const a = poly[i]; const c = poly[(i + 1) % poly.length];
    const xa = cellOf(Math.min(a.x, c.x), x0); const xb = cellOf(Math.max(a.x, c.x), x0);
    const ya = cellOf(Math.min(a.y, c.y), y0); const yb = cellOf(Math.max(a.y, c.y), y0);
    const za = cellOf(Math.min(a.z, c.z), z0); const zb = cellOf(Math.max(a.z, c.z), z0);
    for (let cx = xa; cx <= xb; cx += 1) {
      for (let cy = ya; cy <= yb; cy += 1) {
        for (let cz = za; cz <= zb; cz += 1) {
          const key = `${cx},${cy},${cz}`;
          const list = map.get(key);
          if (list) list.push(i); else map.set(key, [i]);
        }
      }
    }
  }
  return { map, cell, x0, y0, z0, poly, segs, span: b.diagonal };
}

function gridNearest(g, p) {
  const cx = Math.floor((p.x - g.x0) / g.cell);
  const cy = Math.floor((p.y - g.y0) / g.cell);
  const cz = Math.floor((p.z - g.z0) / g.cell);
  let best = Infinity;
  const test = (i) => {
    const a = g.poly[i]; const b = g.poly[(i + 1) % g.poly.length];
    const d = V.sub(b, a); const den = V.dot(d, d);
    const rel = V.sub(p, a);
    const t = den <= 1e-12 ? 0 : clamp(V.dot(rel, d) / den, 0, 1);
    const q = V.sub(rel, V.mul(d, t));
    const dist = V.len(q);
    if (dist < best) best = dist;
  };
  const maxRing = Math.ceil(g.span / g.cell) + 2;
  for (let r = 0; r <= maxRing; r += 1) {
    for (let ix = cx - r; ix <= cx + r; ix += 1) {
      for (let iy = cy - r; iy <= cy + r; iy += 1) {
        for (let iz = cz - r; iz <= cz + r; iz += 1) {
          if (r > 0 && Math.abs(ix - cx) !== r && Math.abs(iy - cy) !== r && Math.abs(iz - cz) !== r) continue;
          const list = g.map.get(`${ix},${iy},${iz}`);
          if (list) for (const i of list) test(i);
        }
      }
    }
    // A hit inside ring r is only provably nearest once the searched block
    // extends past it — hence the extra ring before stopping.
    if (best < Infinity && best <= r * g.cell) break;
  }
  return best;
}

function deviation(origPts, resPts, closed) {
  if (resPts.length < 2 || origPts.length < 2) return { max: 0, mean: 0 };
  const gRes = buildSegGrid(resPts, closed);
  let max = 0; let sum = 0;
  for (const p of origPts) {
    const d = gridNearest(gRes, p);
    sum += d;
    if (d > max) max = d;
  }
  // Symmetric: a result that bulges into a new loop stays close to the original
  // measured one way, and is only caught measuring the other.
  const gOrig = buildSegGrid(origPts, closed);
  const stride = Math.max(1, Math.round(resPts.length / 400));
  for (let i = 0; i < resPts.length; i += stride) {
    const d = gridNearest(gOrig, resPts[i]);
    if (d > max) max = d;
  }
  return { max, mean: sum / origPts.length };
}

/* ── per-point extras (rotations) carried onto moved anchors ─────────────── */
const ROT_KEYS = ['rx', 'ry', 'rz'];
const hasRotations = (points) => points.some((p) => ROT_KEYS.some((k) => num(p[k]) !== 0));

function carryRotations(source, closed, out) {
  if (!hasRotations(source)) return out;
  const segments = segmentCount(source, closed);
  if (!segments) return out;
  // Each new anchor takes the rotation the old path had at the same place along
  // the curve, so a path whose points turn the layer keeps turning it.
  const sampleAt = (u) => {
    const scaled = clamp(u, 0, 1) * segments;
    let i = Math.floor(scaled);
    if (i >= segments) i = segments - 1;
    const t = scaled - i;
    const a = source[i]; const b = source[(i + 1) % source.length];
    const mix = {};
    for (const k of ROT_KEYS) mix[k] = num(a[k]) + ((num(b[k]) - num(a[k])) * t);
    return mix;
  };
  const uOf = uParamsFor(source, closed, out);
  return out.map((p, i) => {
    const rot = sampleAt(uOf[i]);
    if (ROT_KEYS.every((k) => Math.abs(rot[k]) < 1e-6)) return p;
    return { ...p, rx: round4(rot.rx), ry: round4(rot.ry), rz: round4(rot.rz) };
  });
}

/** Approximate 0-1 parameter of each output anchor on the SOURCE curve. */
function uParamsFor(source, closed, out) {
  const dense = flattenPath(source, closed, pathBounds(source).diagonal / 400);
  const { pts } = dense;
  const { acc, total } = arcTable(pts, closed);
  return out.map((p) => {
    if (Number.isFinite(p._u)) return p._u;
    const target = vec(p);
    let best = Infinity; let at = 0;
    for (let i = 0; i < pts.length; i += 1) {
      const d = V.len(V.sub(pts[i], target));
      if (d < best) { best = d; at = i; }
    }
    return clamp(acc[at] / total, 0, 1);
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * Entry point
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Smooth / reduce a path.
 *
 * `points` and the result use the caller's own units and dimensionality — a 2D
 * path in, a 2D path out (no `z` is invented). Returns null when the path is too
 * short to touch.
 */
export function smoothPath(points, closed = false, options = {}) {
  const source = Array.isArray(points) ? points.filter((p) => Number.isFinite(Number(p?.x)) && Number.isFinite(Number(p?.y))) : [];
  if (source.length < 3) return null;

  const opts = { ...SMOOTH_DEFAULTS, ...options };
  const mode = SMOOTH_MODES.includes(opts.mode) ? opts.mode : 'fit';
  const is3d = source.some((p) => p.z !== undefined && p.z !== null);

  const bounds = pathBounds(source);
  const diag = bounds.diagonal;
  const errPx = Number.isFinite(Number(options.epsilon))
    ? Number(options.epsilon)
    : amountToEpsilon(opts.amount, diag);
  const runOpts = {
    errPx,
    maxPoints: opts.limitPoints ? clamp(Math.round(num(opts.maxPoints, 24)), 2, 400) : 0,
    cornerDeg: clamp(num(opts.cornerDeg, 34), 0, 180),
    cornerWindow: Math.max(diag * 0.01, 1e-6),
    epsilon: clamp(errPx * 0.4, diag * 0.0004, diag * 0.02),
    relaxStrength: opts.relaxStrength,
    relaxPasses: opts.relaxPasses,
    relaxPinCorners: opts.relaxPinCorners !== false,
  };

  const flattenStep = diag / 300;
  const dense = flattenPath(source, closed, flattenStep);

  let out = null;
  if (mode === 'fit') out = modeFit(dense, closed, runOpts);
  else if (mode === 'reduce') out = modeReduce(source, dense, closed, runOpts);
  else if (mode === 'even') out = modeEven(source, closed, opts.evenCount);
  else out = modeRelax(source, closed, runOpts);
  if (!out || !Array.isArray(out.points) || out.points.length < 2) return null;

  let result = out.points;
  if (mode === 'fit' || mode === 'even') result = carryRotations(source, closed, result);

  // Measure BEFORE rounding and stripping, on the curves themselves.
  const resDense = flattenPath(result, closed, flattenStep);
  const dev = deviation(dense.pts, resDense.pts, closed);
  const lenA = polylineLength(dense.pts, closed);
  const lenB = polylineLength(resDense.pts, closed);

  const clean = result.map((p) => {
    const point = { x: round4(p.x), y: round4(p.y) };
    if (is3d) point.z = round4(num(p.z));
    const hIn = vec(p.hIn); const hOut = vec(p.hOut);
    point.hIn = is3d ? { x: round4(hIn.x), y: round4(hIn.y), z: round4(hIn.z) } : { x: round4(hIn.x), y: round4(hIn.y) };
    point.hOut = is3d ? { x: round4(hOut.x), y: round4(hOut.y), z: round4(hOut.z) } : { x: round4(hOut.x), y: round4(hOut.y) };
    if (p.manual === true) point.manual = true;
    for (const k of ROT_KEYS) if (num(p[k]) !== 0) point[k] = round4(num(p[k]));
    return point;
  });

  return {
    points: clean,
    stats: {
      mode,
      // The resolved settings, so a caller with several keyframes to smooth can
      // replay exactly this operation on each of them.
      options: { ...opts, mode },
      before: source.length,
      after: clean.length,
      removed: source.length - clean.length,
      corners: out.corners || 0,
      epsilon: out.epsilon || 0,
      maxDeviation: dev.max,
      meanDeviation: dev.mean,
      // Unit-free, and the only deviation number worth showing on a unit-box path.
      maxDeviationPct: (dev.max / diag) * 100,
      meanDeviationPct: (dev.mean / diag) * 100,
      lengthDeltaPct: lenA > 1e-9 ? ((lenB - lenA) / lenA) * 100 : 0,
      diagonal: diag,
      keptIndexes: out.keptIndexes || null,
    },
  };
}

/**
 * Preview a range of settings cheaply — used by the popover to label the modes
 * with the count each would produce before the user commits to one.
 */
export function smoothPreviewCount(points, closed, options) {
  const res = smoothPath(points, closed, options);
  return res ? res.stats.after : (points?.length || 0);
}

/**
 * Drop everything except `indexes`, refitting the handles of the spans that
 * merged — Reduce, but with the surviving anchors chosen elsewhere.
 *
 * This is what keeps a KEYFRAMED path legal. A shape morph, a mask path track and
 * a one-key-per-anchor progress track all pair up point 3 of one key with point 3
 * of the next, so a reduction must remove the same INDEXES from every key. Run
 * smoothPath() on the key under the playhead, then replay its `keptIndexes` over
 * the other keys with this.
 */
export function reduceToIndexes(points, closed, indexes) {
  const source = Array.isArray(points) ? points : [];
  const kept = (Array.isArray(indexes) ? indexes : [])
    .map((i) => Math.round(num(i, -1)))
    .filter((i) => i >= 0 && i < source.length);
  if (source.length < 3 || kept.length < 2 || kept.length >= source.length) return null;

  const diag = pathBounds(source).diagonal;
  const dense = flattenPath(source, closed, diag / 300);
  const { pts, anchorAt } = dense;
  const window = Math.max(diag * 0.002, 1e-9);
  const sampleRange = (i, j) => {
    const a = anchorAt[i]; const b = anchorAt[j];
    if (!closed || a < b) return pts.slice(a, b + 1);
    const run = [];
    for (let k = a; ; k = (k + 1) % pts.length) { run.push(pts[k]); if (k === b) break; }
    return run;
  };
  const tanOut = (i) => {
    const h = vec(source[i].hOut);
    return V.len(h) > 1e-9 ? V.norm(h) : dirFrom(pts, anchorAt[i], 1, closed, window);
  };
  const tanIn = (j) => {
    const h = vec(source[j].hIn);
    return V.len(h) > 1e-9 ? V.norm(h) : dirFrom(pts, anchorAt[j], -1, closed, window);
  };
  const spanFit = (i, j) => {
    const run = sampleRange(i, j);
    if (run.length < 2) return null;
    return fitOne(run, tanOut(i), tanIn(j));
  };
  const is3d = source.some((p) => p.z !== undefined && p.z !== null);

  return kept.map((idx, k) => {
    const next = kept[(k + 1) % kept.length];
    const prev = kept[(k - 1 + kept.length) % kept.length];
    const src = source[idx];
    const fOut = (closed || k < kept.length - 1) ? spanFit(idx, next) : null;
    const fIn = (closed || k > 0) ? spanFit(prev, idx) : null;
    const hOut = fOut ? V.sub(fOut.bez[1], fOut.bez[0]) : { x: 0, y: 0, z: 0 };
    const hIn = fIn ? V.sub(fIn.bez[2], fIn.bez[3]) : { x: 0, y: 0, z: 0 };
    const point = { ...src, x: round4(num(src.x)), y: round4(num(src.y)), manual: true };
    if (is3d) point.z = round4(num(src.z));
    point.hOut = is3d
      ? { x: round4(hOut.x), y: round4(hOut.y), z: round4(hOut.z) }
      : { x: round4(hOut.x), y: round4(hOut.y) };
    point.hIn = is3d
      ? { x: round4(hIn.x), y: round4(hIn.y), z: round4(hIn.z) }
      : { x: round4(hIn.x), y: round4(hIn.y) };
    return point;
  });
}
