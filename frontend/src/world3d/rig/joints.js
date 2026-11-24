// (rigging) A rig's joints: written out (`joints`), or a template (`biped`, `quadruped`) placed by landmark points the agent gives or this
// module finds from the mesh's own shape. Pure: plain arrays, no three.
//
// Space: the mesh's own (a Scene object's local metres; a model file's own units, before the layer's fit). Y is up, the figure faces +Z,
// its left is +X (".L" names). A joint is { name, parent, at, tail?, rot? }: `at` is where it turns, `parent` the joint it hangs from,
// `tail` where a joint with no children ends (a hand's fingertips, the top of the head), `rot` its rest turn in degrees (none: the
// joint's axes are the mesh's, so `rot: [x, 0, 0]` on a knee turns it about the mesh's X like every other joint).

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const lerp3 = (a, b, k) => add(a, mul(sub(b, a), k));
const isPoint = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

/**
 * Templates: each joint's place comes from a landmark (`at`) or between two (`between: [a, b, k]`); `tail` likewise. Landmarks are named by
 * where they are on a body (a knee, a wrist), joints by the part that turns there (shin, hand).
 */
export const TEMPLATES = {
  biped: {
    landmarks: ['hips', 'spine', 'chest', 'neck', 'head', 'headTop', 'shoulder.L', 'elbow.L', 'wrist.L', 'handTip.L', 'hip.L', 'knee.L', 'ankle.L', 'ball.L', 'toe.L',
      'shoulder.R', 'elbow.R', 'wrist.R', 'handTip.R', 'hip.R', 'knee.R', 'ankle.R', 'ball.R', 'toe.R'],
    joints: [
      { name: 'hips', parent: null, at: 'hips' },
      { name: 'spine', parent: 'hips', at: 'spine' },
      { name: 'chest', parent: 'spine', at: 'chest' },
      { name: 'neck', parent: 'chest', at: 'neck' },
      { name: 'head', parent: 'neck', at: 'head', tail: 'headTop' },
      ...['L', 'R'].flatMap((s) => [
        { name: `upperArm.${s}`, parent: 'chest', at: `shoulder.${s}` },
        { name: `forearm.${s}`, parent: `upperArm.${s}`, at: `elbow.${s}` },
        { name: `hand.${s}`, parent: `forearm.${s}`, at: `wrist.${s}`, tail: `handTip.${s}` },
        { name: `thigh.${s}`, parent: 'hips', at: `hip.${s}` },
        { name: `shin.${s}`, parent: `thigh.${s}`, at: `knee.${s}` },
        { name: `foot.${s}`, parent: `shin.${s}`, at: `ankle.${s}` },
        { name: `toe.${s}`, parent: `foot.${s}`, at: `ball.${s}`, tail: `toe.${s}` },
      ]),
    ],
  },
  quadruped: {
    landmarks: ['hips', 'spine', 'chest', 'neck', 'head', 'nose', 'tail', 'tailTip',
      'shoulder.L', 'elbow.L', 'wrist.L', 'frontFoot.L', 'hip.L', 'knee.L', 'hock.L', 'hindFoot.L',
      'shoulder.R', 'elbow.R', 'wrist.R', 'frontFoot.R', 'hip.R', 'knee.R', 'hock.R', 'hindFoot.R'],
    joints: [
      { name: 'hips', parent: null, at: 'hips' },
      { name: 'spine', parent: 'hips', at: 'spine' },
      { name: 'chest', parent: 'spine', at: 'chest' },
      { name: 'neck', parent: 'chest', at: 'neck' },
      { name: 'head', parent: 'neck', at: 'head', tail: 'nose' },
      { name: 'tail', parent: 'hips', at: 'tail', tail: 'tailTip' },
      ...['L', 'R'].flatMap((s) => [
        { name: `upperArm.${s}`, parent: 'chest', at: `shoulder.${s}` },
        { name: `forearm.${s}`, parent: `upperArm.${s}`, at: `elbow.${s}` },
        { name: `frontFoot.${s}`, parent: `forearm.${s}`, at: `wrist.${s}`, tail: `frontFoot.${s}` },
        { name: `thigh.${s}`, parent: 'hips', at: `hip.${s}` },
        { name: `shin.${s}`, parent: `thigh.${s}`, at: `knee.${s}` },
        { name: `hindFoot.${s}`, parent: `shin.${s}`, at: `hock.${s}`, tail: `hindFoot.${s}` },
      ]),
    ],
  },
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

/** The other side's name: "knee.L" ⇄ "knee.R" (also _L / -L / Left), or null. */
export function mirrorName(name) {
  const m = /^(.*?)([._-])(L|R|Left|Right)$/.exec(name);
  if (!m) return null;
  const other = { L: 'R', R: 'L', Left: 'Right', Right: 'Left' }[m[3]];
  return `${m[1]}${m[2]}${other}`;
}

// ── finding landmarks from the shape ───────────────────────────────────────────────────────────────────────────────────────────

/** Points of S within `half` of height y, as [x, y, z] triples. */
function band(S, axis, at, half) {
  const out = [];
  const { P, m } = S;
  for (let i = 0; i < m; i += 1) if (Math.abs(P[i * 3 + axis] - at) <= half) out.push([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
  return out;
}

/**
 * The mesh cut by the plane `axis` = at: each closed loop of the cut (a leg, an arm, the torso) as its own list of points, sorted along
 * `sortAxis`. Loops come from the triangles' own edges (two triangles that share a cut edge share its point), so a coarse mesh with long
 * triangles is cut as cleanly as a fine one.
 */
export function sections(S, axis, at, sortAxis = 0) {
  const { P, T, m } = S;
  const keyOf = new Map(), pts = [], up = [];
  const find = (x) => { while (up[x] !== x) { up[x] = up[up[x]]; x = up[x]; } return x; };
  const edgePoint = (a, b) => {
    const key = a < b ? a * m + b : b * m + a;
    let k = keyOf.get(key);
    if (k === undefined) {
      const ta = P[a * 3 + axis], tb = P[b * 3 + axis];
      const f = (at - ta) / (tb - ta);
      pts.push([P[a * 3] + (P[b * 3] - P[a * 3]) * f, P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * f, P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * f]);
      k = pts.length - 1;
      up.push(k);
      keyOf.set(key, k);
    }
    return k;
  };
  for (let t = 0; t < T.length; t += 3) {
    const v = [T[t], T[t + 1], T[t + 2]];
    const above = v.map((i) => P[i * 3 + axis] >= at);
    if (above[0] === above[1] && above[1] === above[2]) continue;
    const cut = [];
    for (let e = 0; e < 3; e += 1) { const a = v[e], b = v[(e + 1) % 3]; if (above[e] !== above[(e + 1) % 3]) cut.push(edgePoint(a, b)); }
    if (cut.length === 2) { const ra = find(cut[0]), rb = find(cut[1]); if (ra !== rb) up[rb] = ra; }
  }
  const groups = new Map();
  pts.forEach((p, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(p); });
  return [...groups.values()].map((g) => g.sort((a, b) => a[sortAxis] - b[sortAxis]));
}

/** Splits points into runs along an axis wherever two neighbours are more than `gap` apart. */
function runs(points, axis, gap) {
  if (!points.length) return [];
  const sorted = [...points].sort((a, b) => a[axis] - b[axis]);
  const out = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i][axis] - sorted[i - 1][axis] > gap) out.push([]);
    out[out.length - 1].push(sorted[i]);
  }
  return out;
}

/** Splits points into groups on the XZ plane: points closer than `gap` (through a chain of such neighbours) are one group. */
function clusters2d(points, gap) {
  const n = points.length;
  const cell = gap;
  const grid = new Map();
  const key = (x, z) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
  points.forEach((p, i) => { const k = key(p[0], p[2]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  const seen = new Int8Array(n);
  const out = [];
  for (let s = 0; s < n; s += 1) {
    if (seen[s]) continue;
    const group = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop();
      group.push(points[i]);
      const gx = Math.floor(points[i][0] / cell), gz = Math.floor(points[i][2] / cell);
      for (let a = -1; a <= 1; a += 1) {
        for (let b = -1; b <= 1; b += 1) {
          for (const j of grid.get(`${gx + a},${gz + b}`) || []) {
            if (seen[j]) continue;
            const dx = points[j][0] - points[i][0], dz = points[j][2] - points[i][2];
            if (dx * dx + dz * dz <= gap * gap) { seen[j] = 1; stack.push(j); }
          }
        }
      }
    }
    out.push(group);
  }
  return out;
}

// (leftovers-rig) where an arm's joints sit: the shoulder this many of the arm's radii on from where the arm stops being alone (the
// armpit's cut), the elbow and wrist these shares of the way from the shoulder to the fingertips (a person's: upper arm 0.186, forearm
// 0.146, hand 0.108 of the height, Drillis & Contini 1966)
const SHOULDER_IN = 0.5;
const ARM_ELBOW = 0.42, ARM_WRIST = 0.76;

/**
 * (smallfix) The wrist from the arm's own shape, when its hand is flat: a palm's cut is flat (its perimeter long for its area), a forearm's
 * round, so where the cuts flatten toward the fingertips the line has a hand on it, and the wrist joint is where the round forearm turns
 * into it: halfway up the rise from the narrowest cut above the hand to the palm's broadest. `cuts` [{ share (0 shoulder .. 1 fingertips),
 * r, len, c }]. Null when the hand is as round as the forearm (a drawn tube, a mitten ball): the person's proportions stand.
 */
export function wristFromShape(cuts) {
  const roundness = (k) => (k.len > 0 ? (2 * Math.PI * k.r) / k.len : 1);
  const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[v.length >> 1] : NaN; };
  const sorted = cuts.filter((k) => Number.isFinite(k.share) && k.r > 0).sort((a, b) => a.share - b.share);
  const forearm = median(sorted.filter((k) => k.share >= 0.5 && k.share <= 0.65).map(roundness));
  const hand = median(sorted.filter((k) => k.share >= 0.75 && k.share <= 0.92).map(roundness));
  if (!(forearm - hand > 0.03)) return null;
  // the palm's broadest cut, then the narrowest between the forearm and it (the fingers taper again past the palm)
  let hi = null;
  for (const k of sorted) if (k.share >= 0.65 && k.share <= 0.92 && (!hi || k.r > hi.r)) hi = k;
  if (!hi) return null;
  let lo = null;
  for (const k of sorted) if (k.share >= 0.5 && k.share < hi.share && (!lo || k.r < lo.r)) lo = k;
  if (!lo || !(hi.r > lo.r * 1.05)) return null;
  const half = (lo.r + hi.r) / 2;
  for (let i = sorted.indexOf(lo); i < sorted.length - 1 && sorted[i].share < hi.share; i += 1) {
    const a = sorted[i], b = sorted[i + 1];
    if (b.r >= half) {
      const f = b.r > a.r ? (half - a.r) / (b.r - a.r) : 0;
      return { share: a.share + (b.share - a.share) * f, c: lerp3(a.c, b.c, f) };
    }
  }
  return null;
}

const mean = (pts) => { const s = [0, 0, 0]; for (const p of pts) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; } return pts.length ? mul(s, 1 / pts.length) : null; };
/** The middle of a ring of surface points: halfway between its extremes on x and z (a ring's mean leans toward where it is densest). */
const middle = (pts) => {
  if (!pts.length) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y = 0;
  for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); y += p[1]; }
  return [(x0 + x1) / 2, y / pts.length, (z0 + z1) / 2];
};

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const unit3 = (a) => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// each triangle's bounding sphere (centre, radius), once per surface: a cut near a point skips the triangles out of reach
const triSpheres = new WeakMap();
function spheresOf(S) {
  let b = triSpheres.get(S);
  if (b) return b;
  const { P, T } = S;
  b = new Float64Array((T.length / 3) * 4);
  for (let t = 0, o = 0; t < T.length; t += 3, o += 4) {
    const a = T[t] * 3, c = T[t + 1] * 3, d = T[t + 2] * 3;
    const x = (P[a] + P[c] + P[d]) / 3, y = (P[a + 1] + P[c + 1] + P[d + 1]) / 3, z = (P[a + 2] + P[c + 2] + P[d + 2]) / 3;
    let r = 0;
    for (const k of [a, c, d]) r = Math.max(r, Math.hypot(P[k] - x, P[k + 1] - y, P[k + 2] - z));
    b[o] = x; b[o + 1] = y; b[o + 2] = z; b[o + 3] = r;
  }
  triSpheres.set(S, b);
  return b;
}

/**
 * (leftovers-rig) The mesh cut by the plane through `o` with unit normal `n`, only within `reach` of o: each closed curve of the cut as
 * { c: the middle of the area it encloses (so a finely tessellated side does not pull it, and a thin flap such as an ear barely does),
 * len: its length, r: the radius of a disc of that area (a round limb's own radius), open: true when the curve runs out of reach (a body
 * bigger than the reach: a limb that has joined the torso) }. A curve whose area cannot be measured (an open or inside-out surface) falls
 * back to the middle of its length and len / 2π.
 */
export function planeCuts(S, o, n, reach) {
  const { P, T, m } = S;
  const sph = spheresOf(S);
  const keyOf = new Map(), up = [], deg = [], at = [];
  const find = (x) => { while (up[x] !== x) { up[x] = up[up[x]]; x = up[x]; } return x; };
  const point = (a, b, da, db) => {
    const key = a < b ? a * m + b : b * m + a;
    let k = keyOf.get(key);
    if (k === undefined) {
      const f = da / (da - db);
      at.push([P[a * 3] + (P[b * 3] - P[a * 3]) * f, P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * f, P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * f]);
      k = at.length - 1;
      up.push(k); deg.push(0);
      keyOf.set(key, k);
    }
    return k;
  };
  const segs = [];
  const v = [0, 0, 0], d = [0, 0, 0];
  for (let t = 0, s = 0; t < T.length; t += 3, s += 4) {
    const cx = sph[s] - o[0], cy = sph[s + 1] - o[1], cz = sph[s + 2] - o[2];
    const r = sph[s + 3];
    // out of reach, or wholly on one side of the plane
    if (cx * cx + cy * cy + cz * cz > (reach + r) * (reach + r)) continue;
    if (Math.abs(cx * n[0] + cy * n[1] + cz * n[2]) > r) continue;
    for (let e = 0; e < 3; e += 1) { v[e] = T[t + e]; const p = v[e] * 3; d[e] = (P[p] - o[0]) * n[0] + (P[p + 1] - o[1]) * n[1] + (P[p + 2] - o[2]) * n[2]; }
    const cut = [];
    for (let e = 0; e < 3; e += 1) {
      const a = e, b = (e + 1) % 3;
      if ((d[a] >= 0) !== (d[b] >= 0)) cut.push(point(v[a], v[b], d[a], d[b]));
    }
    if (cut.length !== 2) continue;
    // each piece of the cut runs the same way round (anticlockwise about n for an outward-facing surface): by the triangle's own turn
    const a3 = v[0] * 3, b3 = v[1] * 3, c3 = v[2] * 3;
    const ux = P[b3] - P[a3], uy = P[b3 + 1] - P[a3 + 1], uz = P[b3 + 2] - P[a3 + 2];
    const wx = P[c3] - P[a3], wy = P[c3 + 1] - P[a3 + 1], wz = P[c3 + 2] - P[a3 + 2];
    const tn = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
    const run = [n[1] * tn[2] - n[2] * tn[1], n[2] * tn[0] - n[0] * tn[2], n[0] * tn[1] - n[1] * tn[0]];
    let [p, q] = cut;
    if (dot3(sub(at[q], at[p]), run) < 0) [p, q] = [q, p];
    deg[p] += 1; deg[q] += 1;
    segs.push(p, q);
    const rp = find(p), rq = find(q);
    if (rp !== rq) up[rq] = rp;
  }
  // the plane's own axes, to measure each curve's area (the shoelace sum over its pieces, in any order)
  const e1 = unit3(Math.abs(n[0]) < 0.9 ? [0, n[2], -n[1]] : [-n[2], 0, n[0]]);
  const e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
  const loops = new Map();
  for (let i = 0; i < segs.length; i += 2) {
    const a = at[segs[i]], b = at[segs[i + 1]];
    const l = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const g = find(segs[i]);
    let L = loops.get(g);
    if (!L) { L = { sx: 0, sy: 0, sz: 0, len: 0, open: false, far: 0, area: 0, ax: 0, ay: 0 }; loops.set(g, L); }
    L.sx += (a[0] + b[0]) * 0.5 * l; L.sy += (a[1] + b[1]) * 0.5 * l; L.sz += (a[2] + b[2]) * 0.5 * l; L.len += l;
    const pa = sub(a, o), pb = sub(b, o);
    const xa = dot3(pa, e1), ya = dot3(pa, e2), xb = dot3(pb, e1), yb = dot3(pb, e2);
    const cr = xa * yb - xb * ya;
    L.area += cr / 2; L.ax += (xa + xb) * cr; L.ay += (ya + yb) * cr;
  }
  for (let k = 0; k < at.length; k += 1) {
    const L = loops.get(find(k));
    if (!L) continue;
    if (deg[k] === 1) L.open = true;
    const p = at[k];
    L.far = Math.max(L.far, Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2]));
  }
  const out = [];
  for (const L of loops.values()) {
    if (!(L.len > 0)) continue;
    const cLen = [L.sx / L.len, L.sy / L.len, L.sz / L.len];
    // by area where the surface is closed and turned one way (a thin flap, an ear, adds length but next to no area); by length otherwise
    const byArea = !L.open && L.area > (L.len * L.len) / (4 * Math.PI) * 0.02;
    const c = byArea ? add(o, add(mul(e1, L.ax / (6 * L.area)), mul(e2, L.ay / (6 * L.area)))) : cLen;
    out.push({ c, len: L.len, r: byArea ? Math.sqrt(L.area / Math.PI) : L.len / (2 * Math.PI), open: L.open || L.far > reach });
  }
  return out;
}

/**
 * (leftovers-rig) A limb's centre line from its tip inward: planes across the limb, each a step further along it and square to the line so
 * far, each taking the curve nearest the line. Stops where the cut stops being the limb alone: the curve opens out of reach or grows past
 * twice the limb's usual size (it has met the torso: an armpit, the root of a neck). Returns { line: [{ c, r, s }] from the tip (s = how far
 * along), dir (the line's direction at its end, inward), merged }.
 */
export function marchLimb(S, tip, dir, { step, maxLen, reach, settle = 0 }) {
  let d = unit3(dir);
  const line = [];
  let c = tip, merged = false, miss = 0;
  for (let s = step; s <= maxLen; s += step) {
    const o = add(c, mul(d, step));
    const cuts = planeCuts(S, o, d, reach);
    let pick = null, best = Infinity;
    for (const k of cuts) { const dd = len3(sub(k.c, o)); if (dd < best) { best = dd; pick = k; } }
    // nothing near the line: the plane has passed a thin tip, or missed it; a few steps on before giving up
    if (!pick || best > Math.max(reach * 0.5, 3 * (line.length ? line[line.length - 1].r : 0))) {
      if ((miss += 1) > 3) break;
      c = o;
      continue;
    }
    miss = 0;
    if (line.length >= 3 && s > settle) {
      const recent = line.slice(-6).map((x) => x.r).sort((a, b) => a - b);
      const usual = recent[recent.length >> 1];
      if (pick.open || pick.r > usual * 2) { merged = true; break; }
    } else if (pick.open && s > settle) { merged = true; break; }
    line.push({ c: pick.c, r: pick.r, s, len: pick.len });
    // the direction: from a few cuts back to this one, turned at most 20 degrees a step
    const back = line[Math.max(0, line.length - 5)].c;
    if (line.length >= 3) {
      const nd = unit3(sub(pick.c, back));
      const cos = dot3(nd, d);
      if (cos > 0.94) d = nd;
      else if (cos > 0) d = unit3(add(mul(d, 0.7), mul(nd, 0.3)));
    }
    c = pick.c;
  }
  return { line, dir: d, merged };
}

/** The height of the surface straight above point p (the first crossing of the mesh going up from it), or null. */
function surfaceAbove(S, p) {
  const { P, T } = S;
  let best = null;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    // p's (x, z) inside the triangle's shadow on the ground, by barycentric weights
    const d = (P[b + 2] - P[c + 2]) * (P[a] - P[c]) + (P[c] - P[b]) * (P[a + 2] - P[c + 2]);
    if (Math.abs(d) < 1e-18) continue;
    const u = ((P[b + 2] - P[c + 2]) * (p[0] - P[c]) + (P[c] - P[b]) * (p[2] - P[c + 2])) / d;
    const v = ((P[c + 2] - P[a + 2]) * (p[0] - P[c]) + (P[a] - P[c]) * (p[2] - P[c + 2])) / d;
    if (u < 0 || v < 0 || u + v > 1) continue;
    const y = u * P[a + 1] + v * P[b + 1] + (1 - u - v) * P[c + 1];
    if (y > p[1] && (best === null || y < best)) best = y;
  }
  return best;
}

/** The point of a centre line `share` of the way from its first point to its last, measured along the straight line between them (the
 *  centres' small zigzags add no length). */
function alongLine(pts, share) {
  if (!pts.length) return null;
  const a = pts[0], u = sub(pts[pts.length - 1], a);
  const L2 = dot3(u, u);
  if (!(L2 > 0)) return a.slice();
  const want = Math.min(1, Math.max(0, share));
  let prev = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const t = dot3(sub(pts[i], a), u) / L2;
    if (t >= want) return lerp3(pts[i - 1], pts[i], t > prev ? (want - prev) / (t - prev) : 0);
    prev = t;
  }
  return pts[pts.length - 1].slice();
}

/**
 * A standing biped's landmarks from its surface: the legs are where a slice is two rings, the crotch where they join, the arms the far
 * left and right of a T or A pose, the head the top. Proportions fill what a slice cannot say (a knee halfway down the leg). Landmarks
 * the agent gave are kept as they are. Returns { points, found: [names], warnings }.
 */
export function findBipedLandmarks(S, given = {}, { symmetric = true } = {}) {
  const warnings = [];
  const found = [];
  const L = { ...given };
  const put = (name, p) => { if (!isPoint(L[name]) && p) { L[name] = p.map((v) => +v.toFixed(5)); found.push(name); } };
  const y0 = S.min[1], H = S.max[1] - S.min[1];
  if (!(H > 0)) return { points: L, found, warnings: ['skeleton: the mesh has no height to find a biped in'] };
  const half = H / 120, gap = H * 0.012;
  const all = band(S, 1, y0 + H / 2, H);
  // Torso-core centerline X when `hips` is not given: avoids raised asymmetric arms/props pulling cx sideways
  const cx = (() => {
    if (isPoint(L.hips)) return L.hips[0];
    const samples = [];
    for (const frac of [0.42, 0.50, 0.58, 0.66]) {
      const gs = sections(S, 1, y0 + H * frac, 0).filter((g) => g.length >= 3);
      if (!gs.length) continue;
      // Pick the largest span/central group (torso), not thin arms
      const pick = gs.reduce((best, g) => (!best || g.length > best.length ? g : best), null);
      if (pick) samples.push(middle(pick)[0]);
    }
    if (samples.length) {
      samples.sort((a, b) => a - b);
      return samples[samples.length >> 1];
    }
    return (S.min[0] + S.max[0]) / 2;
  })();
  // Longest contiguous two-leg run (tolerates touching ankles/base below 16% height and picks top of leg separation as crotch)
  let bestRun = { L: [], R: [], topY: null };
  let curRun = { L: [], R: [] };
  const commitRun = (topY) => {
    if (curRun.L.length > bestRun.L.length) bestRun = { L: curRun.L, R: curRun.R, topY };
    curRun = { L: [], R: [] };
  };
  let firstAcrossAboveFoot = null;
  for (let k = 2; k < 70; k += 1) {
    const y = y0 + (H * k) / 120;
    const groups = sections(S, 1, y, 0);
    const left = groups.filter((g) => middle(g)[0] > cx), right = groups.filter((g) => middle(g)[0] < cx);
    const across = groups.some((g) => g[0][0] < cx && g[g.length - 1][0] > cx);
    if (across) {
      if (k > 10 && firstAcrossAboveFoot === null) firstAcrossAboveFoot = y;
      if (curRun.L.length >= 4) { commitRun(y); if (k > 25) break; }
      else curRun = { L: [], R: [] };
      continue;
    }
    if (left.length && right.length) {
      const inner = (gs, sign) => gs.sort((a, b) => sign * (middle(a)[0] - middle(b)[0]))[0];
      curRun.L.push(middle(inner(left, 1)));
      curRun.R.push(middle(inner(right, -1)));
    } else if (curRun.L.length >= 4) {
      commitRun(y);
    } else {
      curRun = { L: [], R: [] };
    }
  }
  commitRun(bestRun.topY ?? firstAcrossAboveFoot);
  const legs = { L: bestRun.L, R: bestRun.R };
  const crotch = bestRun.topY;
  if (crotch === null || legs.L.length < 4) warnings.push('skeleton: no two legs found (give hip.L, knee.L, ankle.L and their .R)');
  const crotchY = crotch ?? y0 + H * 0.47;
  const legAt = (side, y) => {
    const list = legs[side];
    if (!list.length) return null;
    let best = list[0];
    for (const p of list) if (Math.abs(p[1] - y) < Math.abs(best[1] - y)) best = p;
    return [best[0], y, best[2]];
  };
  // the torso's middle, slice by slice, between the crotch and the shoulders
  const torsoAt = (y) => {
    const groups = sections(S, 1, y, 0);
    const g = groups.find((r) => r[0][0] <= cx && r[r.length - 1][0] >= cx) || groups[0];
    if (!g) return [cx, y, (S.min[2] + S.max[2]) / 2];
    // only the points within the torso's own width (a T pose's arms are in the same run)
    const zs = g.map((p) => p[2]);
    return [cx, y, (Math.min(...zs) + Math.max(...zs)) / 2];
  };
  // Orientation sanity check: chest should be wider along X than deep along Z (+Z forward)
  const chestSlice = sections(S, 1, crotchY + H * 0.30, 0).find((r) => r[0][0] <= cx && r[r.length - 1][0] >= cx);
  if (chestSlice && chestSlice.length >= 4) {
    const wx = chestSlice[chestSlice.length - 1][0] - chestSlice[0][0];
    const czs = chestSlice.map((p) => p[2]);
    const dz = Math.max(...czs) - Math.min(...czs);
    if (dz > wx * 1.35 && wx > 0) warnings.push('skeleton: mesh appears deeper along Z than wide along X (biped expects facing +Z, left +X)');
  }
  const sides = symmetric ? ['L'] : ['L', 'R'];
  const torsoZ0 = torsoAt(crotchY)[2];
  for (const s of sides) {
    const sign = s === 'L' ? 1 : -1;
    // a hip joint stands a little above where the legs part (the leg's ring just below, raised), an ankle over the foot's ring
    const ring = legAt(s, crotchY - H * 0.02);
    put(`hip.${s}`, (ring && [ring[0], crotchY + H * 0.05, ring[2]]) || (legs.L.length < 4 ? [cx + sign * H * 0.055, crotchY + H * 0.05, torsoZ0] : null));
    const shin = legAt(s, y0 + H * 0.1);
    put(`ankle.${s}`, (shin && [shin[0], y0 + H * 0.045, shin[2]]) || (legs.L.length < 4 ? [cx + sign * H * 0.06, y0 + H * 0.045, torsoZ0] : null));
    if (isPoint(L[`hip.${s}`]) && isPoint(L[`ankle.${s}`])) {
      // (leftovers-rig) a knee bent forward (or back) is where the leg's centre line strays furthest from straight; a straight leg's halfway
      const lo = L[`ankle.${s}`][1], hi = L[`hip.${s}`][1];
      const run = legs[s].filter((p) => p[1] >= lo + (hi - lo) * 0.2 && p[1] <= hi - (hi - lo) * 0.2);
      let bend = null, most = 0;
      if (run.length >= 3) {
        const a = run[0], b = run[run.length - 1];
        for (const p of run) { const dz = p[2] - (a[2] + ((b[2] - a[2]) * (p[1] - a[1])) / (b[1] - a[1] || 1)); if (Math.abs(dz) > most) { most = Math.abs(dz); bend = p; } }
      }
      put(`knee.${s}`, bend && most > H * 0.004 ? bend : legAt(s, (hi + lo) / 2) || lerp3(L[`hip.${s}`], L[`ankle.${s}`], 0.5));
    }
    // the toe: the foot's front-most point near the floor, on the ankle's side
    const ankle = L[`ankle.${s}`];
    if (isPoint(ankle)) {
      const sole = band(S, 1, y0 + H * 0.02, H * 0.02).filter((p) => (s === 'L' ? p[0] > cx : p[0] < cx));
      const front = sole.reduce((best, p) => (!best || p[2] > best[2] ? p : best), null);
      if (front) {
        put(`toe.${s}`, [ankle[0], y0 + H * 0.02, front[2]]);
        put(`ball.${s}`, [ankle[0], y0 + H * 0.025, ankle[2] + (front[2] - ankle[2]) * 0.65]);
      } else if (legs.L.length < 4) {
        put(`toe.${s}`, [ankle[0], y0 + H * 0.02, ankle[2] + H * 0.09]);
        put(`ball.${s}`, [ankle[0], y0 + H * 0.025, ankle[2] + H * 0.058]);
      }
    }
  }
  const hipsY = crotchY + H * 0.07;
  put('hips', torsoAt(hipsY));
  put('headTop', (() => { let top = null; for (const p of all) if (!top || p[1] > top[1]) top = p; return top && [cx, top[1], torsoAt(top[1] - H * 0.06)[2]]; })());
  const topY = isPoint(L.headTop) ? L.headTop[1] : y0 + H;
  // a person's proportions between the crotch and the top of the head (the spine is placed halfway between hips and chest later)
  const at = (k) => crotchY + (topY - crotchY) * k;
  put('chest', torsoAt(at(0.52)));
  // the neck: the narrowest cut of the middle between the shoulders and the top of the head (a cartoon's big head as a person's); its
  // joint at the neck's foot, the head's at its top
  let neckY = at(0.76), narrow = Infinity;
  for (let y = at(0.6); y < topY - H * 0.06; y += H / 200) {
    const g = sections(S, 1, y, 0).find((q) => q[0][0] <= cx && q[q.length - 1][0] >= cx);
    if (g && g[g.length - 1][0] - g[0][0] < narrow) { narrow = g[g.length - 1][0] - g[0][0]; neckY = y; }
  }
  put('neck', torsoAt(neckY - H * 0.025));
  put('head', torsoAt(neckY + H * 0.02));
  // the arms (leftovers-rig): scan multiple torso heights for hanging arms, relax T/A-pose reach to 1.25*torsoHalf, and detect bent elbows
  const torsoHalf = (() => {
    const g = sections(S, 1, at(0.4), 0).find((r) => r[0][0] <= cx && r[r.length - 1][0] >= cx);
    if (!g) return H * 0.1;
    return Math.max(cx - g[0][0], g[g.length - 1][0] - cx);
  })();
  const step = H / 160, reach = H * 0.16;
  for (const s of sides) {
    const sign = s === 'L' ? 1 : -1;
    const side = s === 'L' ? 'left' : 'right';
    let beside = null, besideDown = null;
    for (const hf of [0.30, 0.22, 0.36, 0.44]) {
      const rings = sections(S, 1, at(hf), 0);
      const tRing = rings.find((r) => r[0][0] <= cx && r[r.length - 1][0] >= cx) || null;
      const wall = tRing ? (sign > 0 ? tRing[tRing.length - 1][0] : tRing[0][0]) : cx;
      const half = Math.abs(wall - cx) || torsoHalf;
      const cand = rings.filter((r) => r !== tRing).map((r) => middle(r))
        .filter((c) => sign * (c[0] - wall) > 0 && sign * (c[0] - wall) < half * 1.7)
        .sort((a, b) => sign * (a[0] - b[0]))[0];
      if (!cand) continue;
      // Only treat as a hanging arm if marching straight down follows an arm downward (not slicing across an A-pose cylinder)
      const down = marchLimb(S, cand, [0, -1, 0], { step, maxLen: H * 0.5, reach });
      const end = down.line.length ? down.line[down.line.length - 1] : { c: cand, r: half * 0.3 };
      if (down.line.length >= 6 && cand[1] - end.c[1] > H * 0.09) {
        beside = { center: cand, half };
        besideDown = down;
        break;
      }
    }
    let tip = null, dir = null;
    if (beside) {
      const end = besideDown.line[besideDown.line.length - 1];
      const near = end.r * 3 + step * 4;
      for (let i = 0; i < S.m; i += 1) {
        const y = S.P[i * 3 + 1];
        if (y > end.c[1] + step || Math.hypot(S.P[i * 3] - end.c[0], S.P[i * 3 + 2] - end.c[2]) > near) continue;
        if (!tip || y < tip[1]) tip = [S.P[i * 3], y, S.P[i * 3 + 2]];
      }
      dir = [0, 1, 0];
    } else {
      for (const p of all) if (p[1] > crotchY && (!tip || sign * p[0] > sign * tip[0])) tip = p;
      if (!tip || sign * (tip[0] - cx) < torsoHalf * 1.25) {
        warnings.push(`skeleton: the ${side} arm is not found (out from the body, or hanging clear of it): give shoulder.${s}, elbow.${s}, wrist.${s}, handTip.${s}`);
        continue;
      }
      dir = [cx - tip[0], at(0.62) - tip[1], 0];
    }
    if (!tip) { warnings.push(`skeleton: the ${side} arm's hand was not found: give handTip.${s}`); continue; }
    const arm = marchLimb(S, tip, dir, { step, maxLen: H * 0.6, reach, settle: H * 0.12 });
    if (!arm.merged || arm.line.length < 6) { warnings.push(`skeleton: the ${side} shoulder was not found: give shoulder.${s}`); continue; }
    const last = arm.line[arm.line.length - 1];
    const sh = add(last.c, mul(arm.dir, last.r * SHOULDER_IN));
    const top = surfaceAbove(S, sh);
    if (top !== null && top - sh[1] < last.r * 4) sh[1] = Math.max(sh[1], top - last.r);
    put(`shoulder.${s}`, sh);
    put(`handTip.${s}`, tip);
    const shoulder = L[`shoulder.${s}`], ht = L[`handTip.${s}`];
    if (isPoint(shoulder) && isPoint(ht)) {
      const pts = [shoulder, ...arm.line.map((x) => x.c).reverse(), ht];
      const u = sub(ht, shoulder), uu = dot3(u, u);
      const wrist = uu > 0 ? wristFromShape(arm.line.map((x) => ({ ...x, share: dot3(sub(x.c, shoulder), u) / uu }))) : null;
      const wrPt = wrist ? wrist.c : alongLine(pts, ARM_WRIST);
      // Detect clearly bent elbow along shoulder->wrist line via chord deviation
      let elbowPt = null;
      if (wrPt && arm.line.length >= 6) {
        const sw = sub(wrPt, shoulder), swLen = len3(sw) || 1, swDir = mul(sw, 1 / swLen);
        let bestDev = 0;
        for (const q of pts) {
          const d = sub(q, shoulder);
          const proj = dot3(d, swDir);
          if (proj < swLen * 0.25 || proj > swLen * 0.78) continue;
          const perp = len3(sub(d, mul(swDir, proj)));
          if (perp > bestDev) { bestDev = perp; elbowPt = q; }
        }
        if (bestDev <= H * 0.015) elbowPt = null;
      }
      put(`elbow.${s}`, elbowPt || alongLine(pts, wrist ? (wrist.share * ARM_ELBOW) / ARM_WRIST : ARM_ELBOW));
      put(`wrist.${s}`, wrPt);
    }
  }
  // a symmetric figure: each .R found is the .L mirrored across the middle
  if (symmetric) mirrorFound(L, found, cx, put);
  return { points: L, found, warnings };
}

function mirrorFound(L, found, cx, put) {
  for (const name of [...found]) {
    const other = mirrorName(name);
    if (other && isPoint(L[name])) put(other, [2 * cx - L[name][0], L[name][1], L[name][2]]);
  }
}

/**
 * A standing quadruped's landmarks: four legs where a slice near the ground is four groups (front pair toward +Z), the body above them,
 * the head the front's top, the tail the back. Returns { points, found, warnings }.
 */
export function findQuadrupedLandmarks(S, given = {}, { symmetric = true } = {}) {
  const warnings = [];
  const found = [];
  const L = { ...given };
  const put = (name, p) => { if (!isPoint(L[name]) && p) { L[name] = p.map((v) => +v.toFixed(5)); found.push(name); } };
  const y0 = S.min[1], H = S.max[1] - S.min[1];
  const cx = (S.min[0] + S.max[0]) / 2;
  if (!(H > 0)) return { points: L, found, warnings: ['skeleton: the mesh has no height to find a quadruped in'] };
  const size = Math.max(S.max[0] - S.min[0], S.max[2] - S.min[2], H);
  const gap = size * 0.015;
  // the legs: the highest slice that is still four groups
  let legTop = null, feet = null;
  for (let k = 1; k < 60; k += 1) {
    const y = y0 + (H * k) / 100;
    const groups = sections(S, 1, y, 0).filter((g) => g.length >= 3);
    if (groups.length === 4) { legTop = y; if (!feet) feet = groups.map(middle); } else if (legTop !== null && groups.length < 4) break;
  }
  if (legTop === null) {
    warnings.push('skeleton: no four legs found near the ground (give shoulder.L, elbow.L, wrist.L, frontFoot.L, hip.L, knee.L, hock.L, hindFoot.L and their .R)');
    return { points: L, found, warnings };
  }
  const groupsAt = (y) => sections(S, 1, y, 0).filter((g) => g.length >= 3).map(middle);
  const cz = feet.reduce((s, p) => s + p[2], 0) / 4;
  const leg = (front, side) => (p) => (front ? p[2] > cz : p[2] < cz) && (side === 'L' ? p[0] > cx : p[0] < cx);
  const legAt = (front, side, y) => groupsAt(y).find(leg(front, side));
  // the body: a slice over the legs' tops, front and back
  const bodyBand = band(S, 1, legTop + (S.max[1] - legTop) * 0.35, H * 0.08);
  const bodyFront = Math.max(...bodyBand.map((p) => p[2])), bodyBack = Math.min(...bodyBand.map((p) => p[2]));
  const bodyY = legTop + (S.max[1] - legTop) * 0.3;
  const front = feet.filter((p) => p[2] > cz), back = feet.filter((p) => p[2] < cz);
  const zf = front.reduce((s, p) => s + p[2], 0) / Math.max(1, front.length), zb = back.reduce((s, p) => s + p[2], 0) / Math.max(1, back.length);
  put('hips', [cx, bodyY, zb]);
  put('chest', [cx, bodyY, zf]);
  put('spine', [cx, bodyY, (zb + zf) / 2]);
  // the head: the highest point toward the front, the nose its front-most point
  let nose = null;
  for (let i = 0; i < S.m; i += 1) {
    const p = [S.P[i * 3], S.P[i * 3 + 1], S.P[i * 3 + 2]];
    if (p[1] > bodyY && (!nose || p[2] > nose[2])) nose = p;
  }
  if (nose) put('nose', [cx, nose[1], nose[2]]);
  // (leftovers-rig) the head and neck from the shape: the centre line from the nose back by cuts square to it (marchLimb) until the cut meets
  // the body; the head joint where the neck is narrowest behind the skull's widest cut (the top of the neck), the neck joint where the neck
  // meets the body, on by half its radius (as an arm's shoulder)
  if (isPoint(L.nose)) {
    const line = marchLimb(S, L.nose, [0, 0, -1], { step: size / 200, maxLen: size * 0.6, reach: size * 0.2, settle: size * 0.12 });
    const pts = line.line;
    if (pts.length > 8) {
      let w = 0;
      for (let i = 0; i < pts.length / 2; i += 1) if (pts[i].r > pts[w].r) w = i;
      let k = w;
      for (let i = w; i < pts.length; i += 1) if (pts[i].r < pts[k].r) k = i;
      // the neck's foot: going back from its top, where it has spread to 1.3 times its narrowest, or reached the front of the front legs
      const front = sections(S, 1, legTop, 0).filter((g) => g.length >= 3 && middle(g)[2] > cz);
      let edge = -Infinity;
      for (const g of front) for (const p of g) edge = Math.max(edge, p[2]);
      let e = k;
      while (e < pts.length - 1 && pts[e].r < pts[k].r * 1.3 && pts[e].c[2] > edge) e += 1;
      if (k < pts.length - 1) {
        put('head', [cx, pts[k].c[1], pts[k].c[2]]);
        put('neck', [cx, pts[e].c[1], pts[e].c[2]]);
      }
    }
  }
  if (isPoint(L.nose) && isPoint(L.chest)) {
    put('neck', [cx, L.chest[1] + (S.max[1] - L.chest[1]) * 0.25, L.chest[2] + (bodyFront - L.chest[2]) * 0.6]);
    put('head', lerp3(L.neck, L.nose, 0.35));   // the skull's back, behind the snout
  }
  let tailTip = null;
  for (let i = 0; i < S.m; i += 1) { const z = S.P[i * 3 + 2]; if (!tailTip || z < tailTip[2]) tailTip = [S.P[i * 3], S.P[i * 3 + 1], z]; }
  if (tailTip && tailTip[2] < bodyBack + gap) put('tailTip', [cx, tailTip[1], tailTip[2]]);
  // the tail starts behind the hind legs by a quarter of the gap between the leg pairs
  if (isPoint(L.hips) && isPoint(L.tailTip)) put('tail', [cx, L.hips[1], zb - (zf - zb) * 0.25]);
  for (const s of symmetric ? ['L'] : ['L', 'R']) {
    const f = legAt(true, s, y0 + H * 0.02), b = legAt(false, s, y0 + H * 0.02);
    if (!f || !b) { warnings.push(`skeleton: the ${s === 'L' ? 'left' : 'right'} legs were not found`); continue; }
    const len = legTop - y0;
    const fAt = (y) => legAt(true, s, y) || [f[0], y, f[2]];
    const bAt = (y) => legAt(false, s, y) || [b[0], y, b[2]];
    put(`frontFoot.${s}`, [f[0], y0 + H * 0.01, f[2] + gap]);
    // (leftovers-rig) a four-legged animal's proportions (the elbow at about the chest's underside, the wrist a quarter of the way up); a
    // hind leg zigzags, its hock the furthest back and its knee the furthest forward of its centre line where the leg is that clear
    put(`wrist.${s}`, fAt(y0 + len * 0.25));
    put(`elbow.${s}`, fAt(y0 + len * 0.8));
    put(`shoulder.${s}`, [fAt(legTop)[0], bodyY, fAt(legTop)[2]]);
    put(`hindFoot.${s}`, [b[0], y0 + H * 0.01, b[2] + gap]);
    const hind = [];
    // (the ring nearest the foot across: a tail hanging between the hind legs is not the leg)
    for (let k = 1; k <= 40; k += 1) { const p = groupsAt(y0 + (len * k) / 40).filter(leg(false, s)).sort((u, v) => Math.abs(u[0] - b[0]) - Math.abs(v[0] - b[0]))[0]; if (p) hind.push(p); }
    const extreme = (from, to, sign) => hind.filter((p) => p[1] >= y0 + len * from && p[1] <= y0 + len * to).reduce((m, p) => (!m || sign * p[2] > sign * m[2] ? p : m), null);
    const back = extreme(0.15, 0.7, -1), fore = extreme(0.5, 1, 1);
    const ends = hind.length ? (hind[0][2] + hind[hind.length - 1][2]) / 2 : 0;
    const legR = gap * 2;
    put(`hock.${s}`, back && ends - back[2] > legR * 0.5 ? back : bAt(y0 + len * 0.4));
    put(`knee.${s}`, fore && fore[2] - (back ? back[2] : ends) > legR ? fore : bAt(y0 + len * 0.88));
    put(`hip.${s}`, [bAt(legTop)[0], bodyY, bAt(legTop)[2]]);
  }
  if (symmetric) mirrorFound(L, found, cx, put);
  return { points: L, found, warnings };
}

// ── the joints ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The rig's joints in parent-first order: [{ name, parent (index, -1 for a root), at, tail, rot }] plus the landmarks used and found.
 * `S` (weights.js surfaceOf, in the same space) lets a template find what the agent left out; without it a template needs every landmark.
 */
export function resolveJoints(spec, S = null) {
  const warnings = [];
  const out = [];
  let landmarks = null, found = [];
  const given = spec?.landmarks && typeof spec.landmarks === 'object' ? { ...spec.landmarks } : {};
  if (spec?.template) {
    const tpl = TEMPLATES[spec.template];
    if (!tpl) return { joints: [], landmarks: null, found, warnings: [`skeleton: no template "${spec.template}" (${TEMPLATE_NAMES.join(', ')})`] };
    // one side given, the other mirrored across the middle (the hips', or the mesh's)
    const cx = isPoint(given.hips) ? given.hips[0] : S ? (S.min[0] + S.max[0]) / 2 : 0;
    if (spec.symmetric !== false) {
      for (const [name, p] of Object.entries({ ...given })) {
        const other = mirrorName(name);
        if (other && isPoint(p) && !isPoint(given[other])) given[other] = [2 * cx - p[0], p[1], p[2]];
      }
    }
    let L = given;
    if (S) {
      const opts = { symmetric: spec.symmetric !== false };
      const f = spec.template === 'biped' ? findBipedLandmarks(S, given, opts) : findQuadrupedLandmarks(S, given, opts);
      L = f.points; found = f.found; warnings.push(...f.warnings);
    }
    if (spec.template === 'biped') {
      // between-points the shape does not say: the spine halfway, the head over the neck
      if (!isPoint(L.spine) && isPoint(L.hips) && isPoint(L.chest)) { L.spine = lerp3(L.hips, L.chest, 0.5); found.push('spine'); }
      for (const s of ['L', 'R']) {
        if (!isPoint(L[`ball.${s}`]) && isPoint(L[`ankle.${s}`]) && isPoint(L[`toe.${s}`])) { L[`ball.${s}`] = lerp3(L[`ankle.${s}`], L[`toe.${s}`], 0.65); found.push(`ball.${s}`); }
      }
    }
    landmarks = L;
    for (const j of tpl.joints) {
      const at = L[j.at];
      if (!isPoint(at)) { warnings.push(`skeleton: template ${spec.template} needs landmark "${j.at}" (for joint ${j.name})`); continue; }
      out.push({ name: j.name, parentName: j.parent, at: at.slice(), tail: j.tail && isPoint(L[j.tail]) ? L[j.tail].slice() : null, rot: null });
    }
  }
  // joints written out: a template's joint of the same name is replaced, any other is added
  for (const j of Array.isArray(spec?.joints) ? spec.joints : []) {
    if (!j || typeof j.name !== 'string' || !j.name) { warnings.push('skeleton: a joint needs a name'); continue; }
    if (!isPoint(j.at)) { warnings.push(`skeleton: joint "${j.name}" needs at: [x, y, z]`); continue; }
    const entry = { name: j.name, parentName: j.parent ?? null, at: j.at.slice(), tail: isPoint(j.tail) ? j.tail.slice() : null, rot: Array.isArray(j.rot) && j.rot.length === 3 ? j.rot.map(Number) : null };
    const k = out.findIndex((o) => o.name === j.name);
    if (k >= 0) out[k] = { ...out[k], ...entry, parentName: j.parent === undefined ? out[k].parentName : entry.parentName, tail: entry.tail || out[k].tail };
    else out.push(entry);
  }
  // parents first; a name used twice, an unknown parent or a loop is a warning, and that joint hangs from the root instead
  const byName = new Map();
  for (const j of out) { if (byName.has(j.name)) warnings.push(`skeleton: joint "${j.name}" is named twice`); else byName.set(j.name, j); }
  const placed = [];
  const index = new Map();
  const visit = (j, depth = 0) => {
    if (index.has(j.name)) return index.get(j.name);
    if (depth > 256) { warnings.push(`skeleton: joint "${j.name}" is in a loop`); return -1; }
    let parent = -1;
    if (j.parentName != null) {
      const p = byName.get(j.parentName);
      if (!p) warnings.push(`skeleton: joint "${j.name}" has no parent "${j.parentName}"`);
      else parent = visit(p, depth + 1);
    }
    const i = placed.length;
    placed.push({ name: j.name, parent, at: j.at, tail: j.tail, rot: j.rot });
    index.set(j.name, i);
    return i;
  };
  for (const j of byName.values()) visit(j);
  return { joints: placed, landmarks, found, warnings };
}

/** The bones heat flows from: each joint owns the segment to each child, or to its tail; a joint with neither is a point. */
export function jointSegments(joints) {
  const segs = [];
  joints.forEach((j, i) => {
    const kids = joints.filter((c) => c.parent === i);
    for (const c of kids) segs.push({ joint: i, a: j.at, b: c.at });
    if (j.tail) segs.push({ joint: i, a: j.at, b: j.tail });
    if (!kids.length && !j.tail) segs.push({ joint: i, a: j.at, b: j.at });
  });
  return segs;
}
