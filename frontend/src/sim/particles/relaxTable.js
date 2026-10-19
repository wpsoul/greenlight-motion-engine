// The RELAXED site set — Houdini's Scatter ▸ Relax Iterations, baked.
//
// Every other distribution mode is a closed form: f(uid) -> a point, evaluated
// from the particle's own id and nothing else, which is what lets the CPU bake
// and the GPU engine each compute it independently and agree.
//
// Relaxation is not a formula. Points are dropped, then pushed off each other
// until nothing is clumped — point 900's final position depends on where point
// 12 ended up. There is no expression for "the 900th relaxed point"; you have to
// run the algorithm and KEEP the answer. So this mode is a dataset, and the
// dataset has to reach both runtimes.
//
// HOW IT REACHES THEM, CHEAPLY. The set is a pure function of
// (count, iterations, seed, span) — no DOM, no time, no Math.random — so both
// runtimes simply BUILD IT, from this module, and get the same bytes. Nothing is
// serialised to the bake worker and nothing new is bound on the GPU: the shader
// reads it out of `tablePos`, the storage buffer shape:'layer' already owns,
// which is idle for every other shape. That is why this mode costs one upload
// call instead of a bind-group layout change.
//
// THE COROLLARY, AND IT IS A REAL LIMIT. shape:'layer' and mode:'relaxed'
// cannot both be on, because they would want the same buffer. The panel says so
// and prepareDistribution refuses the combination rather than drawing something
// wrong. Relaxed on artwork is the one case where relaxation clearly beats every
// closed form (0.075 spacing variance against the next best 0.43), so it is
// worth doing properly later — with its own binding, not by sharing this one.

import { rnd } from './rng.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * The most points a relaxed set will hold.
 *
 * Not a memory limit — 8,192 points is 96 KB, nothing. It is a TIME limit: the
 * build is O(n · candidates) plus O(n · neighbours) per iteration, and it runs
 * on whichever thread asked for it. Above this the one-off cost starts to be
 * felt as a hitch when the mode is picked.
 *
 * A pool larger than this reuses sites, which the panel reports rather than
 * hiding — at 100,000 particles over 8,192 sites, twelve particles share each.
 */
export const RELAX_MAX_SITES = 8192;
export const RELAX_MAX_ITERS = 40;

const cache = new Map();
const CACHE_MAX = 8;

/** Identity of a set, for the cache and for the GPU's upload key. */
export function relaxTableKey(count, iters, seed, span) {
  const s = spanWeights(span);
  return `${count}:${iters}:${seed | 0}:${s[0].toFixed(3)},${s[1].toFixed(3)},${s[2].toFixed(3)}`;
}

/**
 * The emitter's proportions, normalised so the largest axis is 1.
 *
 * Relaxation has to measure distance in the SHAPE's proportions, not the unit
 * cube's. A set relaxed as a cube and then stretched onto a ring is not
 * relaxed: measured, that gave 0.41 spacing variance where the corrected
 * version gives 0.09 — and it is the same failure a lattice has there, for the
 * same reason.
 */
function spanWeights(span) {
  const sx = Math.max(1e-6, span?.[0] ?? 1);
  const sy = Math.max(1e-6, span?.[1] ?? 1);
  const sz = Math.max(1e-6, span?.[2] ?? 1);
  const mx = Math.max(sx, sy, sz);
  return [sx / mx, sy / mx, sz / mx];
}

/**
 * Build (or fetch) a relaxed set of `count` points in the unit cube.
 *
 * Returns { points: Float32Array(count * 3), count, key, ms, flat }.
 * Deterministic in every argument, and identical on every machine.
 */
export function ensureRelaxTable(count, iters, seed, span) {
  const n = clamp(Math.round(count) || 1, 8, RELAX_MAX_SITES);
  const it = clamp(Math.round(iters) || 0, 0, RELAX_MAX_ITERS);
  const key = relaxTableKey(n, it, seed, span);
  const hit = cache.get(key);
  if (hit) return hit;

  const t0 = Date.now();
  const [wx, wy, wz0] = spanWeights(span);
  // A set two cells deep is a plane with a rounding artefact, not a volume. The
  // same test the lattice uses, so a slab gets a 2-D relaxation and a sphere a
  // 3-D one without either being told which it is.
  const flat = wz0 < 0.02;
  const wz = flat ? 0 : wz0;
  const dims = flat ? 2 : 3;

  const P = new Float32Array(n * 3);

  // ── Accelerator ─────────────────────────────────────────────────────────
  // Cells cubical IN THE STRETCHED METRIC. A uniform grid over the unit cube
  // would put every point of a 17:1 domain in one row of cells, and the 27-cell
  // neighbour search would then miss the true nearest neighbour along the
  // compressed axis — which is every axis that matters on a ring.
  const vol = flat ? wx * wy : wx * wy * wz;
  const g0 = Math.pow(Math.max(1e-9, vol) * 2 / n, -1 / dims);
  const gx = clamp(Math.round(g0 * wx), 1, 64);
  const gy = clamp(Math.round(g0 * wy), 1, 64);
  const gz = flat ? 1 : clamp(Math.round(g0 * wz), 1, 64);
  const head = new Int32Array(gx * gy * gz).fill(-1);
  const next = new Int32Array(n).fill(-1);
  const cellOf = (x, y, z) =>
    (clamp(Math.floor(x * gx), 0, gx - 1) * gy + clamp(Math.floor(y * gy), 0, gy - 1)) * gz
    + clamp(Math.floor(z * gz), 0, gz - 1);
  const insert = (i) => {
    const c = cellOf(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    next[i] = head[c]; head[c] = i;
  };

  /** Squared distance to the nearest already-placed point, in the stretched metric. */
  const nearest2 = (x, y, z) => {
    const bx = clamp(Math.floor(x * gx), 0, gx - 1);
    const by = clamp(Math.floor(y * gy), 0, gy - 1);
    const bz = clamp(Math.floor(z * gz), 0, gz - 1);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      const X = bx + dx; if (X < 0 || X >= gx) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const Y = by + dy; if (Y < 0 || Y >= gy) continue;
        for (let dz = -1; dz <= 1; dz++) {
          const Z = bz + dz; if (Z < 0 || Z >= gz) continue;
          for (let j = head[(X * gy + Y) * gz + Z]; j !== -1; j = next[j]) {
            const ex = (P[j * 3] - x) * wx;
            const ey = (P[j * 3 + 1] - y) * wy;
            const ez = (P[j * 3 + 2] - z) * wz;
            const d2 = ex * ex + ey * ey + ez * ez;
            if (d2 < best) best = d2;
          }
        }
      }
    }
    return best;
  };

  // ── 1 · Mitchell best-candidate ─────────────────────────────────────────
  // Each new point is the best of K darts — already close to blue noise before
  // a single relaxation pass, and (usefully) PROGRESSIVE by construction: point
  // i is placed as far as possible from everything already placed, so the first
  // half of the table is itself a well-spread set. That is why the fill order
  // matters less for this mode than for a lattice.
  const K = 10;
  for (let i = 0; i < n; i++) {
    let bx = 0.5, by = 0.5, bz = 0.5, bd = -1;
    for (let k = 0; k < K; k++) {
      const x = rnd(seed, i * 137 + k, 101);
      const y = rnd(seed, i * 137 + k, 102);
      const z = flat ? 0.5 : rnd(seed, i * 137 + k, 103);
      const d = i === 0 ? 1 : nearest2(x, y, z);
      if (d > bd) { bd = d; bx = x; by = y; bz = z; }
    }
    P[i * 3] = bx; P[i * 3 + 1] = by; P[i * 3 + 2] = bz;
    insert(i);
  }

  // ── 2 · Relax ───────────────────────────────────────────────────────────
  // Push each point off the neighbours closer than the target spacing. The
  // target is derived from the OCCUPIED volume in the stretched metric; getting
  // it wrong is not subtle — too large and every push is refused, so the passes
  // cost time and buy nothing.
  const target = Math.pow(Math.max(1e-9, vol) / n, 1 / dims) * 0.9;
  const step = target * 0.35;
  const D = it > 0 ? new Float32Array(n * 3) : null;
  for (let pass = 0; pass < it; pass++) {
    head.fill(-1); next.fill(-1);
    for (let i = 0; i < n; i++) insert(i);
    D.fill(0);
    for (let i = 0; i < n; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const bx = clamp(Math.floor(x * gx), 0, gx - 1);
      const by = clamp(Math.floor(y * gy), 0, gy - 1);
      const bz = clamp(Math.floor(z * gz), 0, gz - 1);
      let ax = 0, ay = 0, az = 0;
      for (let dx = -1; dx <= 1; dx++) {
        const X = bx + dx; if (X < 0 || X >= gx) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const Y = by + dy; if (Y < 0 || Y >= gy) continue;
          for (let dz = -1; dz <= 1; dz++) {
            const Z = bz + dz; if (Z < 0 || Z >= gz) continue;
            for (let j = head[(X * gy + Y) * gz + Z]; j !== -1; j = next[j]) {
              if (j === i) continue;
              const ex = (x - P[j * 3]) * wx;
              const ey = (y - P[j * 3 + 1]) * wy;
              const ez = (z - P[j * 3 + 2]) * wz;
              const d = Math.sqrt(ex * ex + ey * ey + ez * ez) + 1e-9;
              if (d >= target) continue;
              const push = (target - d) / target;
              // Measured in the stretched metric, applied in CUBE units — the
              // point is stored in the cube, and dividing the push back by the
              // axis weight is what keeps a squashed axis from being shoved
              // proportionally further than a long one.
              ax += (ex / d) * push / (wx || 1);
              ay += (ey / d) * push / (wy || 1);
              az += wz ? (ez / d) * push / wz : 0;
            }
          }
        }
      }
      D[i * 3] = ax; D[i * 3 + 1] = ay; D[i * 3 + 2] = az;
    }
    for (let i = 0; i < n; i++) {
      P[i * 3] = clamp(P[i * 3] + D[i * 3] * step, 0.0005, 0.9995);
      P[i * 3 + 1] = clamp(P[i * 3 + 1] + D[i * 3 + 1] * step, 0.0005, 0.9995);
      if (!flat) P[i * 3 + 2] = clamp(P[i * 3 + 2] + D[i * 3 + 2] * step, 0.0005, 0.9995);
    }
  }

  const table = { points: P, count: n, key, flat, ms: Date.now() - t0 };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, table);
  return table;
}

/** For tests and for a panel that wants to know what a change will cost. */
export function relaxCacheSize() { return cache.size; }
export function clearRelaxTables() { cache.clear(); }
