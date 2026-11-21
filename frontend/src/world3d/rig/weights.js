// (rigging) Skin weights for a mesh and a joint tree: automatic (heat diffusion over the surface), rigid (each part follows one joint),
// manual fixes, and the last step that keeps four influences a vertex.
//
// Heat diffusion is the method of Baran & Popović, "Automatic Rigging and Animation of 3D Characters" (SIGGRAPH 2007), written here
// from the paper: every joint's weight is the steady temperature of the surface when that joint's bone is held hot and the others cold,
// -Δw + Hw = Hp, where H_jj = 1/d_j² for d_j the distance from vertex j to the nearest bone it can SEE (the segment from the vertex to the
// bone stays inside the body) and p_j = 1 where that bone is this joint's. Heat flows along the surface, never through the air, so two legs
// or two fingers that nearly touch share nothing; the visibility test keeps a vertex from being bound to a bone across a gap; and a
// joint between two bones gets a smooth blend over the bend. Solved with the cotangent Laplacian and a preconditioned conjugate gradient,
// one solve per joint, each only over the parts of the mesh that joint's bones reach.
//
// Pure: plain arrays in, plain arrays out; no three, no DOM.

import { weld } from '../mesh.js';

/** The closest point's share t along segment a→b to p (0 at a, 1 at b). */
export function segmentT(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len2 = dx * dx + dy * dy + dz * dz;
  if (!(len2 > 0)) return 0;
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy + (p[2] - a[2]) * dz) / len2;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// ── the welded surface ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The mesh as one surface: points welded by position (a uv seam or a split normal is still one point), triangles over them without the
 * degenerate ones, connected parts (`island` per point), and each point's area-weighted normal.
 */
export function surfaceOf(position, index) {
  const n = position.length / 3;
  const ids = weld(position);
  const pid = new Int32Array(n);
  let m = 0;
  for (let v = 0; v < n; v += 1) pid[v] = ids[v] === v ? m++ : -1;
  for (let v = 0; v < n; v += 1) if (ids[v] !== v) pid[v] = pid[ids[v]];
  const P = new Float64Array(m * 3);
  for (let v = 0; v < n; v += 1) if (ids[v] === v) { const p = pid[v] * 3; P[p] = position[v * 3]; P[p + 1] = position[v * 3 + 1]; P[p + 2] = position[v * 3 + 2]; }
  const I = index || Uint32Array.from({ length: n }, (_, i) => i);
  const tris = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = pid[I[t]], b = pid[I[t + 1]], c = pid[I[t + 2]];
    if (a === b || b === c || a === c) continue;
    tris.push(a, b, c);
  }
  const T = Int32Array.from(tris);
  // connected parts, by union-find over the triangles
  const up = Int32Array.from({ length: m }, (_, i) => i);
  const find = (x) => { while (up[x] !== x) { up[x] = up[up[x]]; x = up[x]; } return x; };
  for (let t = 0; t < T.length; t += 3) {
    const a = find(T[t]), b = find(T[t + 1]), c = find(T[t + 2]);
    up[b] = a; up[find(c)] = a;
  }
  const islandOf = new Map();
  const island = new Int32Array(m);
  for (let i = 0; i < m; i += 1) {
    const r = find(i);
    if (!islandOf.has(r)) islandOf.set(r, islandOf.size);
    island[i] = islandOf.get(r);
  }
  const N = new Float64Array(m * 3);
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { N[k] += nx; N[k + 1] += ny; N[k + 2] += nz; }
  }
  for (let i = 0; i < m; i += 1) {
    const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
    N[i * 3] /= l; N[i * 3 + 1] /= l; N[i * 3 + 2] /= l;
  }
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m; i += 1) for (let k = 0; k < 3; k += 1) { lo[k] = Math.min(lo[k], P[i * 3 + k]); hi[k] = Math.max(hi[k], P[i * 3 + k]); }
  if (!m) { lo = [0, 0, 0]; hi = [0, 0, 0]; }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  return { n, m, pid, P, T, island, islands: islandOf.size, N, diag, min: lo, max: hi };
}

// ── a small BVH for the visibility rays ────────────────────────────────────────────────────────────────────────────────────────

function buildBVH(P, T) {
  const count = T.length / 3;
  const order = Int32Array.from({ length: count }, (_, i) => i);
  const cx = new Float64Array(count * 3);
  for (let t = 0; t < count; t += 1) {
    for (let k = 0; k < 3; k += 1) cx[t * 3 + k] = (P[T[t * 3] * 3 + k] + P[T[t * 3 + 1] * 3 + k] + P[T[t * 3 + 2] * 3 + k]) / 3;
  }
  const box = [], left = [], right = [], start = [], size = [];
  const make = (lo, hiEnd) => {
    const node = start.length;
    let b0 = Infinity, b1 = Infinity, b2 = Infinity, b3 = -Infinity, b4 = -Infinity, b5 = -Infinity;
    for (let i = lo; i < hiEnd; i += 1) {
      const t = order[i];
      for (let c = 0; c < 3; c += 1) {
        const p = T[t * 3 + c] * 3;
        if (P[p] < b0) b0 = P[p]; if (P[p] > b3) b3 = P[p];
        if (P[p + 1] < b1) b1 = P[p + 1]; if (P[p + 1] > b4) b4 = P[p + 1];
        if (P[p + 2] < b2) b2 = P[p + 2]; if (P[p + 2] > b5) b5 = P[p + 2];
      }
    }
    box.push(b0, b1, b2, b3, b4, b5);
    start.push(lo); size.push(hiEnd - lo); left.push(-1); right.push(-1);
    if (hiEnd - lo <= 4) return node;
    // split at the median centroid along the longest side
    let c0 = Infinity, c1 = Infinity, c2 = Infinity, c3 = -Infinity, c4 = -Infinity, c5 = -Infinity;
    for (let i = lo; i < hiEnd; i += 1) {
      const t = order[i] * 3;
      if (cx[t] < c0) c0 = cx[t]; if (cx[t] > c3) c3 = cx[t];
      if (cx[t + 1] < c1) c1 = cx[t + 1]; if (cx[t + 1] > c4) c4 = cx[t + 1];
      if (cx[t + 2] < c2) c2 = cx[t + 2]; if (cx[t + 2] > c5) c5 = cx[t + 2];
    }
    const ext = [c3 - c0, c4 - c1, c5 - c2];
    const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
    const part = Array.from(order.subarray(lo, hiEnd)).sort((a, b) => cx[a * 3 + axis] - cx[b * 3 + axis]);
    order.set(part, lo);
    const mid = (lo + hiEnd) >> 1;
    const l = make(lo, mid), r = make(mid, hiEnd);
    left[node] = l; right[node] = r;
    return node;
  };
  if (count) make(0, count);
  return { box: Float64Array.from(box), left: Int32Array.from(left), right: Int32Array.from(right), start: Int32Array.from(start), size: Int32Array.from(size), order };
}

/** Whether the segment o → o + d·(0..1) crosses a triangle of `island` (not one touching point `skip`), away from both its ends. */
function blocked(bvh, P, T, triIsland, island, skip, ox, oy, oz, dx, dy, dz) {
  if (!bvh.start.length) return false;
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  const stack = [0];
  const EPS = 1e-6;
  while (stack.length) {
    const node = stack.pop();
    const b = node * 6;
    // slab test against [0, 1]
    let t0 = 0, t1 = 1;
    let a = (bvh.box[b] - ox) * ix, c = (bvh.box[b + 3] - ox) * ix;
    if (a > c) { const s = a; a = c; c = s; }
    if (a > t0) t0 = a; if (c < t1) t1 = c;
    a = (bvh.box[b + 1] - oy) * iy; c = (bvh.box[b + 4] - oy) * iy;
    if (a > c) { const s = a; a = c; c = s; }
    if (a > t0) t0 = a; if (c < t1) t1 = c;
    a = (bvh.box[b + 2] - oz) * iz; c = (bvh.box[b + 5] - oz) * iz;
    if (a > c) { const s = a; a = c; c = s; }
    if (a > t0) t0 = a; if (c < t1) t1 = c;
    if (!(t0 <= t1)) continue;
    if (bvh.left[node] >= 0) { stack.push(bvh.left[node], bvh.right[node]); continue; }
    for (let i = bvh.start[node], e = i + bvh.size[node]; i < e; i += 1) {
      const t = bvh.order[i];
      if (triIsland[t] !== island) continue;
      const pa = T[t * 3], pb = T[t * 3 + 1], pc = T[t * 3 + 2];
      if (pa === skip || pb === skip || pc === skip) continue;
      // Möller–Trumbore
      const e1x = P[pb * 3] - P[pa * 3], e1y = P[pb * 3 + 1] - P[pa * 3 + 1], e1z = P[pb * 3 + 2] - P[pa * 3 + 2];
      const e2x = P[pc * 3] - P[pa * 3], e2y = P[pc * 3 + 1] - P[pa * 3 + 1], e2z = P[pc * 3 + 2] - P[pa * 3 + 2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-18) continue;
      const inv = 1 / det;
      const sx = ox - P[pa * 3], sy = oy - P[pa * 3 + 1], sz = oz - P[pa * 3 + 2];
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < -EPS || u > 1 + EPS) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < -EPS || u + v > 1 + EPS) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (tt > 1e-4 && tt < 1 - 1e-4) return true;
    }
  }
  return false;
}

// ── the cotangent Laplacian and the solve ──────────────────────────────────────────────────────────────────────────────────────

/** Stiffness (cotangent weights, each edge at least a hair above 0) as rows, and each point's lumped area (a third of its triangles'). */
function laplacian(S) {
  const { m, P, T } = S;
  const edges = new Map();
  const mass = new Float64Array(m);
  const add = (i, j, w) => { const k = i < j ? i * m + j : j * m + i; edges.set(k, (edges.get(k) || 0) + w); };
  const cot = (o, a, b) => {
    const ux = P[a * 3] - P[o * 3], uy = P[a * 3 + 1] - P[o * 3 + 1], uz = P[a * 3 + 2] - P[o * 3 + 2];
    const vx = P[b * 3] - P[o * 3], vy = P[b * 3 + 1] - P[o * 3 + 1], vz = P[b * 3 + 2] - P[o * 3 + 2];
    const dot = ux * vx + uy * vy + uz * vz;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const cross = Math.hypot(cx, cy, cz);
    return { c: cross > 1e-30 ? dot / cross : 0, area: cross / 2 };
  };
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t], b = T[t + 1], c = T[t + 2];
    const A = cot(a, b, c), B = cot(b, c, a), C = cot(c, a, b);
    add(b, c, A.c / 2); add(c, a, B.c / 2); add(a, b, C.c / 2);
    const third = A.area / 3;
    mass[a] += third; mass[b] += third; mass[c] += third;
  }
  // an obtuse pair can make an edge's weight negative: kept just above zero, so the maximum principle holds (every weight in 0..1)
  let mean = 0;
  for (const w of edges.values()) mean += Math.abs(w);
  mean = edges.size ? mean / edges.size : 1;
  const floor = mean * 1e-4;
  const rows = Array.from({ length: m }, () => []);
  const diag = new Float64Array(m);
  for (const [k, w0] of edges) {
    const i = Math.floor(k / m), j = k - i * m;
    const w = Math.max(w0, floor);
    rows[i].push(j, w); rows[j].push(i, w);
    diag[i] += w; diag[j] += w;
  }
  const ptr = new Int32Array(m + 1);
  for (let i = 0; i < m; i += 1) ptr[i + 1] = ptr[i] + rows[i].length / 2;
  const col = new Int32Array(ptr[m]), val = new Float64Array(ptr[m]);
  for (let i = 0; i < m; i += 1) {
    const r = rows[i];
    for (let k = 0, at = ptr[i]; k < r.length; k += 2, at += 1) { col[at] = r[k]; val[at] = -r[k + 1]; }
  }
  return { ptr, col, val, diag, mass };
}

/**
 * Conjugate gradient on (L + D) x = b over the points `region` alone (a list of point indices; `inside` marks them), every point outside held
 * at 0 (a cold edge), with a Jacobi preconditioner, from x as given (local: x[k] is region[k]'s). Stops when the residual is `tol` of the
 * first one (the start is the step p: what is left to diffuse). Returns the iterations used.
 */
function solveRegion(L, D, region, inside, b, x, { tol = 1e-4, maxIter = 2000 } = {}) {
  const n = region.length;
  const { ptr, col, val, diag } = L;
  const local = inside;   // global -> local index + 1 (0: outside)
  const r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n), inv = new Float64Array(n);
  for (let k = 0; k < n; k += 1) { const i = region[k]; const d = diag[i] + D[i]; inv[k] = d > 0 ? 1 / d : 0; }
  const mul = (v, out) => {
    for (let k = 0; k < n; k += 1) {
      const i = region[k];
      let s = (diag[i] + D[i]) * v[k];
      for (let e = ptr[i], end = ptr[i + 1]; e < end; e += 1) { const c = local[col[e]]; if (c) s += val[e] * v[c - 1]; }
      out[k] = s;
    }
  };
  mul(x, Ap);
  let rz = 0, rn = 0;
  for (let k = 0; k < n; k += 1) { r[k] = b[k] - Ap[k]; z[k] = r[k] * inv[k]; p[k] = z[k]; rz += r[k] * z[k]; rn += r[k] * r[k]; }
  const r0 = Math.sqrt(rn) || 1;
  let it = 0;
  for (; it < maxIter && Math.sqrt(rn) / r0 >= tol; it += 1) {
    mul(p, Ap);
    let pAp = 0;
    for (let k = 0; k < n; k += 1) pAp += p[k] * Ap[k];
    if (!(pAp > 0)) break;
    const alpha = rz / pAp;
    let rz2 = 0;
    rn = 0;
    for (let k = 0; k < n; k += 1) {
      x[k] += alpha * p[k];
      r[k] -= alpha * Ap[k];
      z[k] = r[k] * inv[k];
      rz2 += r[k] * z[k];
      rn += r[k] * r[k];
    }
    const beta = rz2 / rz;
    rz = rz2;
    for (let k = 0; k < n; k += 1) p[k] = z[k] + beta * p[k];
  }
  return it;
}

// ── weights ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Heat weights of every joint at every point of surface S (surfaceOf). `segments`: [{ joint, a: [x, y, z], b: [x, y, z] }], each a bone
 * a joint owns (a joint owns the segment to each child, or to its tail). Returns a dense Float32Array (points × joints) and numbers.
 */
export function heatWeights(S, segments, jointCount, { tol = 1e-4, maxIter = 3000, visibility = true, parents = null } = {}) {
  const { m, P, T, island } = S;
  const J = jointCount;
  const W = new Float32Array(m * J);
  const stats = { points: m, triangles: T.length / 3, islands: S.islands, unseen: 0, iterations: 0, solves: 0, fallback: 0 };
  if (!m || !segments.length) return { W, stats };
  const L = laplacian(S);
  const triIsland = new Int32Array(T.length / 3);
  for (let t = 0; t < triIsland.length; t += 1) triIsland[t] = island[T[t * 3]];
  const bvh = visibility ? buildBVH(P, T) : null;
  const H = new Float64Array(m);
  const nearest = new Int32Array(m * 4).fill(-1);   // up to four joints sharing the nearest visible bone
  const share = new Float64Array(m);
  const nearestAny = new Int32Array(m);
  const seg = segments.map((s) => ({ joint: s.joint, a: s.a, b: s.b }));
  const dist = new Float64Array(seg.length);
  const order = Array.from({ length: seg.length }, (_, i) => i);
  const cp = [0, 0, 0];
  const nudge = S.diag * 1e-5;
  for (let i = 0; i < m; i += 1) {
    const p = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
    for (let s = 0; s < seg.length; s += 1) {
      const t = segmentT(p, seg[s].a, seg[s].b);
      const dx = seg[s].a[0] + (seg[s].b[0] - seg[s].a[0]) * t - p[0];
      const dy = seg[s].a[1] + (seg[s].b[1] - seg[s].a[1]) * t - p[1];
      const dz = seg[s].a[2] + (seg[s].b[2] - seg[s].a[2]) * t - p[2];
      dist[s] = Math.hypot(dx, dy, dz);
    }
    order.sort((x, y) => dist[x] - dist[y]);
    nearestAny[i] = seg[order[0]].joint;
    let dmin = -1, k = 0;
    // the nearest bones in turn (at most eight looked at), the first one this point can see is its own; ties within a hair share it
    for (let r = 0; r < order.length && r < 8; r += 1) {
      const s = order[r];
      if (dmin >= 0 && dist[s] > dmin * (1 + 1e-6) + 1e-12) break;
      const t = segmentT(p, seg[s].a, seg[s].b);
      cp[0] = seg[s].a[0] + (seg[s].b[0] - seg[s].a[0]) * t;
      cp[1] = seg[s].a[1] + (seg[s].b[1] - seg[s].a[1]) * t;
      cp[2] = seg[s].a[2] + (seg[s].b[2] - seg[s].a[2]) * t;
      let ok = true;
      if (bvh) {
        // from a hair inside the surface toward the bone
        const ox = p[0] - S.N[i * 3] * nudge, oy = p[1] - S.N[i * 3 + 1] * nudge, oz = p[2] - S.N[i * 3 + 2] * nudge;
        ok = !blocked(bvh, P, T, triIsland, island[i], i, ox, oy, oz, cp[0] - ox, cp[1] - oy, cp[2] - oz);
      }
      if (!ok) continue;
      if (dmin < 0) dmin = dist[s];
      if (k < 4 && !Array.from(nearest.subarray(i * 4, i * 4 + k)).includes(seg[s].joint)) nearest[i * 4 + k++] = seg[s].joint;
    }
    if (dmin < 0) { stats.unseen += 1; continue; }
    const d = Math.max(dmin, S.diag * 1e-4);
    H[i] = 1 / (d * d);
    share[i] = 1 / k;
  }
  const D = new Float64Array(m);
  for (let i = 0; i < m; i += 1) D[i] = L.mass[i] * H[i];
  // the joints some point is nearest to (the others are cold everywhere: their weight is 0), solved together
  const active = [];
  for (let j = 0; j < J; j += 1) {
    let any = false;
    for (let i = 0; i < m * 4 && !any; i += 1) if (nearest[i] === j) any = true;
    if (any) active.push(j);
  }
  // (our addition to the paper) a joint's heat spreads only where the nearest joint is itself, its parent or one of its children:
  // elsewhere the point is held cold. Heat crossing the crotch from one leg into the other, or from one finger round the palm into the
  // next, then dies out smoothly at the edge of that neighbourhood instead of reaching down the other limb. Each joint is solved over its
  // own neighbourhood alone, a sixth of the body or so, which is what keeps a big mesh quick.
  const near = parents ? Array.from({ length: J }, (_, j) => new Set([j, ...(parents[j] >= 0 ? [parents[j]] : []), ...parents.flatMap((p, c) => (p === j ? [c] : []))])) : null;
  const own = Array.from({ length: m }, (_, i) => {
    const list = [];
    for (let k = 0; k < 4; k += 1) if (nearest[i * 4 + k] >= 0) list.push(nearest[i * 4 + k]);
    if (!list.length) list.push(nearestAny[i]);
    return list;
  });
  const inside = new Int32Array(m);
  for (const j of active) {
    const region = [];
    for (let i = 0; i < m; i += 1) if (!near || own[i].some((n) => near[n].has(j))) region.push(i);
    inside.fill(0);
    region.forEach((i, k) => { inside[i] = k + 1; });
    const b = new Float64Array(region.length), x = new Float64Array(region.length);
    region.forEach((i, k) => {
      for (let q = 0; q < 4; q += 1) if (nearest[i * 4 + q] === j) { x[k] = share[i]; b[k] = D[i] * share[i]; }
    });
    stats.iterations += solveRegion(L, D, region, inside, b, x, { tol, maxIter });
    stats.solves += 1;
    region.forEach((i, k) => { const v = x[k]; W[i * J + j] = v < 0 ? 0 : v > 1 ? 1 : v; });
  }
  // a part no bone can see from anywhere (a loose bit outside the body) follows the nearest bone
  for (let i = 0; i < m; i += 1) {
    let s = 0;
    for (let j = 0; j < J; j += 1) s += W[i * J + j];
    if (s < 1e-6) { W[i * J + nearestAny[i]] = 1; stats.fallback += 1; }
  }
  return { W, stats };
}

/** Rigid binding: every connected part follows the one joint that holds most of it (by heat weight times area). In place. */
export function rigidWeights(S, W, J) {
  const { m, island, islands } = S;
  const area = new Float64Array(m);
  const { T, P } = S;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 6;
    area[T[t]] += ar; area[T[t + 1]] += ar; area[T[t + 2]] += ar;
  }
  const sum = new Float64Array(islands * J);
  for (let i = 0; i < m; i += 1) for (let j = 0; j < J; j += 1) sum[island[i] * J + j] += W[i * J + j] * (area[i] || 1e-12);
  const owner = new Int32Array(islands);
  for (let g = 0; g < islands; g += 1) {
    let best = 0;
    for (let j = 1; j < J; j += 1) if (sum[g * J + j] > sum[g * J + best]) best = j;
    owner[g] = best;
  }
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < J; j += 1) W[i * J + j] = 0;
    W[i * J + owner[island[i]]] = 1;
  }
  return owner;
}

/** Each point's weights back to 1 in total (a point with none keeps what it had). In place. */
export function normalizeRows(W, m, J) {
  for (let i = 0; i < m; i += 1) {
    let s = 0;
    for (let j = 0; j < J; j += 1) s += W[i * J + j];
    if (s > 0) for (let j = 0; j < J; j += 1) W[i * J + j] /= s;
  }
}

/** Blurs every joint's weights over the surface (each pass moves a point toward its neighbours' mean by `strength`), only where `mask`
 *  (0..1 per point, null = everywhere) lets it. In place. */
export function smoothWeights(S, W, J, { iterations = 2, strength = 0.5, mask = null } = {}) {
  const { m, T } = S;
  const nb = Array.from({ length: m }, () => new Set());
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t], b = T[t + 1], c = T[t + 2];
    nb[a].add(b).add(c); nb[b].add(a).add(c); nb[c].add(a).add(b);
  }
  const next = new Float32Array(W.length);
  for (let it = 0; it < iterations; it += 1) {
    for (let i = 0; i < m; i += 1) {
      const k = (mask ? mask[i] : 1) * strength;
      const list = nb[i];
      for (let j = 0; j < J; j += 1) {
        const own = W[i * J + j];
        if (!(k > 0) || !list.size) { next[i * J + j] = own; continue; }
        let s = 0;
        for (const q of list) s += W[q * J + j];
        next[i * J + j] = own + (s / list.size - own) * k;
      }
    }
    W.set(next);
  }
}

/**
 * Four influences a point at most (the largest), the rest dropped when under `threshold`, the kept ones back to 1 in total. Out:
 * per VERTEX (through S.pid) skinIndex (Uint16, 4 a vertex) and skinWeight (Float32, 4 a vertex), as three's skinning reads them.
 */
export function packInfluences(S, W, J, { threshold = 0.01, max = 4 } = {}) {
  const { n, m, pid } = S;
  const pIndex = new Uint16Array(m * 4), pWeight = new Float32Array(m * 4);
  const cand = [];
  let dropped = 0, most = 0;
  for (let i = 0; i < m; i += 1) {
    cand.length = 0;
    for (let j = 0; j < J; j += 1) { const w = W[i * J + j]; if (w > 0) cand.push(j); }
    cand.sort((a, b) => W[i * J + b] - W[i * J + a]);
    let keep = cand.slice(0, max).filter((j, r) => r === 0 || W[i * J + j] >= threshold);
    if (!keep.length) keep = [0];
    if (cand.length > keep.length) dropped += 1;
    most = Math.max(most, Math.min(cand.length, max));
    let s = 0;
    for (const j of keep) s += W[i * J + j];
    for (let k = 0; k < 4; k += 1) {
      const j = keep[k];
      pIndex[i * 4 + k] = j ?? 0;
      pWeight[i * 4 + k] = j === undefined ? 0 : s > 0 ? W[i * J + j] / s : (k === 0 ? 1 : 0);
    }
    // the four add up to EXACTLY 1 in float32, in any order: each a whole number of 2^-24 (every partial sum is then a float32 too),
    // the largest takes what is left. The rest pose is then the mesh to the last bit (max vertex move 0).
    let f = 0;
    for (let k = 1; k < 4; k += 1) { const q = Math.round(pWeight[i * 4 + k] * 16777216) / 16777216; pWeight[i * 4 + k] = q; f += q; }
    pWeight[i * 4] = 1 - f;
  }
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);
  for (let v = 0; v < n; v += 1) {
    const p = pid[v];
    skinIndex.set(pIndex.subarray(p * 4, p * 4 + 4), v * 4);
    skinWeight.set(pWeight.subarray(p * 4, p * 4 + 4), v * 4);
  }
  return { skinIndex, skinWeight, dropped, most };
}
