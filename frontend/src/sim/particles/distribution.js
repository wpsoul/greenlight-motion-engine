// Emission DISTRIBUTION — how spawn sites are spread inside the emitter shape.
//
// Look-dev and the measurements behind every choice here: html/particle-distribution-lab.html.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CONTRACT, AND WHY THE FEATURE IS THIS SMALL
//
// Every shape branch in emission.js opens with the same three draws:
//
//     rnd(seed, uid, 1)   rnd(seed, uid, 2)   rnd(seed, uid, 3)
//
// and then maps them into its own geometry. That mapping is an INVERSE-CDF
// transform in every case — cbrt for a sphere's radius, sqrt for a disc's — and
// an inverse-CDF transform preserves how uniformly a sequence covers its domain.
// So if those three numbers come from an even sequence instead of white noise,
// the result is even inside the shape too, with no per-shape code at all.
//
// This module is therefore the ONLY thing that changes: it produces
// [a, b, c] in [0,1)^3 and every existing shape map is untouched.
//
// A PURE FUNCTION OF (seed, uid, try). Not a stylistic preference — emission.js
// and gpu/emitWgsl.js both compute a particle's birth, independently, and have
// to agree bit for bit or a system looks one way cached and another way live.
// Nothing here may depend on where any other particle landed.
//
// MODE 'random' RETURNS EXACTLY THOSE THREE rnd() CALLS, retry streams and all,
// so it is byte-identical to the code this replaced and no saved project moves.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE MODE IS NOT A FORMULA
//
// 'relaxed' is Houdini's Scatter ▸ Relax Iterations, and relaxation is global
// and iterative — point 900 moves because of point 12 — so it cannot be
// computed from a uid. It is a baked set of points instead (relaxTable.js),
// which both runtimes build from the same pure function and therefore agree on
// without anything being serialised between them. On the GPU the shader reads
// it out of the storage buffer shape:'layer' already owns, which is idle for
// every other shape — so it costs an upload call, not a new binding.
//
// Still not here: a DENSITY-MAP mode. That needs a texture and a sampler, not a
// point list, and rejection sampling in the shader on top. shape:'layer'
// already covers the artwork case it would serve.

import { rnd, hash32 } from './rng.js';
import { ensureRelaxTable, RELAX_MAX_SITES } from './relaxTable.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const frac = (x) => x - Math.floor(x);

/*
 * THE LOW-DISCREPANCY CONSTANTS, IN 32-BIT FIXED POINT.
 *
 * Two things forced this, and both are silent failures:
 *
 * 1. f32 CANNOT HOLD frac(n * α) AT SCALE. The shader works in f32, and for
 *    n around a million the product is ~7.5e5, where f32's spacing is 0.0625 —
 *    so the fractional part has SIXTEEN distinct values, and at four million
 *    particles it has four. The sequence collapses into a handful of planes
 *    exactly where a big system needs it most. Multiplying in u32 instead makes
 *    the wraparound itself the fractional part: exact at every n, and identical
 *    on both runtimes, which the f64-vs-f32 version could never be.
 *
 * 2. THE THREE AXES HAVE TO BE THREE DIFFERENT SEQUENCES. These are 1/φ₃^1..3
 *    for the 3-D plastic number (the root of x⁴ = x + 1). The 2-D pair reads
 *    plausibly — but 1/φ₂ squared IS the second 2-D term, so using
 *    (1/φ₂, 1/φ₂², 1/φ₂²) put axes 2 and 3 on the same sequence and every
 *    particle on the plane y = z.
 */
const FX_GOLD = 2654435769;   // 1/φ    · 2³²  (the golden angle, for spirals)
const FX_A1 = 3518319155;     // 1/φ₃   · 2³²   the 3-D triple
const FX_A2 = 2882110345;     // 1/φ₃²  · 2³²
const FX_A3 = 2360945575;     // 1/φ₃³  · 2³²
/*
 * THE 2-D PAIR, AND WHY BOTH SETS ARE NEEDED.
 *
 * The 3-D triple is even in three dimensions, and its PROJECTION onto two is
 * not: measured on 2,500 points, the (1/φ₃, 1/φ₃²) plane has a mean
 * nearest-neighbour gap of 0.46 of the ideal spacing — worse than white noise
 * at 0.51 — because the points pair up along the collapsed axis. On a flat
 * emitter the projection IS what you look at, so a flat one gets the 2-D
 * optimum instead, which measures 0.84. Which set is used follows the same
 * flatness the lattice uses (gz === 1), so one decision covers both.
 */
const FX_B1 = 3242174889;     // 1/φ₂   · 2³²
const FX_B2 = 2447445414;     // 1/φ₂²  · 2³²
const FX_HALF = 2147483648;   // the ½ phase offset, so index 0 is not a corner

/**
 * frac(n · A / 2³²), shifted down to 24 bits before the divide.
 *
 * The shift is the same trick rng.js's `rnd` uses and for the same reason: a
 * value below 2²⁴ converts to f32 exactly, so the shader and this file produce
 * the identical number rather than two roundings of one.
 */
const fxFrac = (n, A, phase = 0) => (((Math.imul(n, A) + phase) >>> 0) >>> 8) / 16777216;

/**
 * Which cube axis a shape wants an even RUN spent on, for the shape-aware modes.
 *
 *   0  none         a box has no radius and no arc
 *   1  radial       `a` is the radius CDF        (sphere, cone)
 *   2  angular/arc  `a` is an angle or arc length (ring, path)
 *
 * Getting this wrong is not subtle: spend the even run on a disc's ANGLE and
 * you get a fan, not a fill; spend it on a box's x and every point lands on its
 * own plane.
 */
export const DIST_AXIS = { none: 0, radial: 1, angular: 2 };

export function shapeAxis(shape) {
  if (shape === 'sphere' || shape === 'cone') return DIST_AXIS.radial;
  if (shape === 'ring' || shape === 'path') return DIST_AXIS.angular;
  return DIST_AXIS.none;
}

/**
 * The shapes a distribution can act on at all.
 *
 * 'point' has no offset to place. 'layer' takes its sites from the artwork's
 * opaque pixels — the picture IS the distribution, and the colour lookup in
 * deriveWgsl indexes that same table by uid, so choosing positions any other
 * way would decouple a particle's colour from where it sits.
 */
export const DIST_SHAPES = ['box', 'block', 'sphere', 'cone', 'ring', 'path'];
export const shapeTakesDistribution = (shape) => DIST_SHAPES.includes(shape);

/** Whether a shape is thin enough that its lattice should be 2-D. */
const isFlat = (shape) => shape === 'ring' || shape === 'path';

/* ── Integer helpers, shared with the WGSL ──────────────────────────────── */

/** van der Corput radical inverse — the engine under Halton. */
export function radicalInverse(i, base) {
  let f = 1 / base, r = 0, n = i >>> 0;
  while (n > 0) { r += f * (n % base); n = Math.floor(n / base); f /= base; }
  return r;
}

/** Reverse the low `bits` bits of `i`. */
export function bitReverse(i, bits) {
  let r = 0, v = i >>> 0;
  for (let b = 0; b < bits; b++) { r = (r << 1) | ((v >>> b) & 1); }
  return r >>> 0;
}

/**
 * A balanced factorisation of `n` cells across the emitter's proportions.
 *
 * COMPUTED ON THE CPU AND PASSED TO THE SHADER AS UNIFORMS, deliberately: a
 * round(cbrt(x)) evaluated twice on two different devices is not guaranteed to
 * land on the same integer, and one cell of difference is a different lattice.
 *
 * The proportions matter as much as the count. A lattice built in an isotropic
 * unit cube and then mapped onto a ring gave 64 rings 1.7px apart and 29px
 * along — and scored a PERFECT evenness, because every point's nearest
 * neighbour was the same 1.7px away. Anisotropy ruins the picture and fools the
 * measurement at the same time.
 */
export function latticeDims(n, span, flat) {
  const N = Math.max(1, Math.round(n));
  const sx = Math.max(1e-6, span[0]), sy = Math.max(1e-6, span[1]), sz = Math.max(1e-6, span[2]);
  // Solve for the cell EDGE, not for a normalised aspect. Normalising and then
  // clamping the smallest axis to a floor is what put two lattice layers half a
  // pixel apart inside a box one pixel deep: the floor decided the emitter had
  // depth worth dividing when it had none.
  if (!flat) {
    const h = Math.cbrt((sx * sy * sz) / N);
    // Fewer than two cells deep is not a 3-D lattice, it is a 2-D one with a
    // rounding artefact — a slab, a plane, anything the user has flattened.
    if (sz / h >= 1.5) {
      const gx = clamp(Math.round(sx / h), 1, 100000);
      const gy = clamp(Math.round(sy / h), 1, 100000);
      const gz = clamp(Math.ceil(N / (gx * gy)), 1, 100000);
      return [gx, gy, gz];
    }
  }
  const h2 = Math.sqrt((sx * sy) / N);
  const gx = clamp(Math.round(sx / h2), 1, 100000);
  const gy = clamp(Math.ceil(N / gx), 1, 100000);
  return [gx, gy, 1];
}

/**
 * The world extent each cube axis covers, for the shape's own geometry. Used
 * only to keep a lattice's cells roughly square — see latticeDims.
 */
export function shapeSpan(shape, size, ring) {
  const sx = Math.max(1, size?.x || 1), sy = Math.max(1, size?.y || 1), sz = Math.max(1, size?.z || 1);
  if (shape === 'ring') {
    const r = Math.max(1, ring?.radius || 1), t = Math.max(1, ring?.thickness || 1);
    return [2 * Math.PI * r, t, t];
  }
  // A path's `a` is arc length, which is longer than the box it is drawn in; b
  // and c are the ±jr ribbon jitter emission.js adds either side of the spline.
  if (shape === 'path') {
    const jr = Math.max(1, Math.min(sx, sy) * 0.04);
    return [Math.max(sx, sy) * 2.4, jr, jr];
  }
  // Polar shapes have no honest span: cells that are square in the cube come
  // out as arcs of wildly different area. Isotropic is the least-wrong answer,
  // and the panel points at Sunflower, which is even there.
  if (shape === 'sphere' || shape === 'cone') return [1, 1, 1];
  return [sx, sy, sz];
}

/* ── Preparing a system's distribution ─────────────────────────────────── */

/**
 * Resolve the stored block into everything the sampler and the shader need.
 * One place, so the bake and the GPU engine cannot disagree about it.
 *
 * `poolSize` is what "auto" sites means: as many distinct places as there are
 * particles. Below that, particles double up on sites — 4096 sites under 6000
 * particles is 1,904 exact overlaps, which is what the default used to do.
 */
export function prepareDistribution(em, seed, poolSize) {
  const d = em?.distribution;
  let mode = d?.mode || 'random';
  const shape = em?.shape || 'box';
  if (mode === 'random' || !shapeTakesDistribution(shape)) {
    return { mode: 'random', seed, axis: 0, jitter: 0, order: 0, sites: 0, gx: 1, gy: 1, gz: 1, p0: 0, p1: 0, seq: 0, bits: 1, relax: null };
  }
  const flat = isFlat(shape);
  const sites = Math.max(16, Math.round(d.sites > 0 ? d.sites : poolSize));
  const span = shapeSpan(shape, em.size, em.ring);
  const [gx, gy, gz] = latticeDims(sites, span, flat);
  const order = ORDER_INDEX[d.order] ?? 0;

  // RELAXED is a baked set rather than a formula. It is built here, by the same
  // call on both runtimes, so the bake and the live engine hold the identical
  // points without anything crossing between them — see relaxTable.js.
  let relax = null;
  if (mode === 'relaxed') {
    relax = ensureRelaxTable(Math.min(RELAX_MAX_SITES, sites), d.relaxIters, seed, span);
  }

  let p0 = 0, p1 = 0;
  if (mode === 'rings') p0 = Math.max(1, Math.round(d.rings || 1));
  else if (mode === 'clustered') { p0 = Math.max(1, Math.round(d.clusters || 1)); p1 = Math.max(0.001, d.tightness || 0.05); }
  else if (mode === 'falloff') p0 = clamp(d.bias || 0, -1, 1);
  else if (mode === 'shell') p0 = clamp(d.thickness || 0.08, 0.002, 0.5);
  return {
    mode,
    seed,
    axis: shapeAxis(shape),
    jitter: clamp(d.jitter ?? 0, 0, 1),
    order,
    // A lattice repeats over the cells it actually has, which after rounding is
    // not exactly `sites`; the shape-aware modes repeat over `sites` itself,
    // and a relaxed set over however many points were actually baked.
    sites: relax ? relax.count
      : (mode === 'stratified' || mode === 'grid' || mode === 'packed') ? gx * gy * gz
      : sites,
    gx, gy, gz, p0, p1,
    relax,
    seq: d.sequence === 'halton' ? 1 : 0,
    // The fill order pads to a power of two, and for a relaxed set the thing
    // being permuted is the TABLE, not the lattice.
    bits: clamp(Math.ceil(Math.log2(Math.max(2, relax ? relax.count : gx * gy * gz))), 1, 30),
  };
}

export const MODE_INDEX = {
  random: 0, stratified: 1, grid: 2, packed: 3, lowdisc: 4,
  sunflower: 5, rings: 6, clustered: 7, falloff: 8, shell: 9,
  relaxed: 10,
};
export const ORDER_INDEX = { scan: 0, scramble: 1, shuffle: 2 };

/* ── The sampler ────────────────────────────────────────────────────────── */

/**
 * The index a mode actually reads, honouring the fill ORDER.
 *
 * THE ONE LINE THAT MATTERS MOST IN THIS FILE. A lattice walked in reading
 * order fills the emitter one corner at a time: measured in the lab, a Grid
 * emitter had reached 39% of its own box after 1,940 births while a progressive
 * mode was at 100% from the start. Fine for a one-shot burst, wrong for
 * anything that emits over seconds. 'scramble' (bit-reversal) walks the same
 * set in maximally spread order; 'shuffle' hashes it.
 */
function orderedIndex(k, total, order, seed, bits) {
  if (total <= 1 || order === 0) return 0 * k + (total <= 1 ? 0 : k);
  const mask = (1 << bits) - 1;
  // A bijection on the PADDED power-of-two range. Not an involution — that
  // matters: bit-reversal alone is its own inverse, so cycle-walking it would
  // ping-pong between two out-of-range values for ever.
  const step = order === 1
    ? (x) => bitReverse((x + 1) & mask, bits)
    : (x) => bitReverse((Math.imul(x, 0x9E3779B1) + (seed | 0) * 2 + 1) & mask, bits);
  // The SAME bijection has to be used for the first hop as for the walk. Using
  // bitReverse(k) to start and a different map to walk broke the permutation at
  // exactly one index — a single duplicated site, which no visual check would
  // ever have found.
  let r = step(k);
  // CYCLE WALKING, and it has to be this rather than "try the next index".
  // Walking the INPUT forward (j = j + 1) until the output lands in range is
  // not a permutation: many k converge on the same landing spot, and the
  // duplicates pile particles onto the same lattice cell. Measured, that made
  // Grid four times denser than its own spacing and worse than Random.
  // Walking the OUTPUT through a bijection is a permutation by construction.
  let guard = 0;
  while (r >= total && guard++ < 256) r = step(r);
  return r < total ? r : k;
}

/** Index -> lattice cell. */
function cellOf(k, gx, gy) {
  const z = Math.floor(k / (gx * gy));
  const rest = k - z * gx * gy;
  return [rest % gx, Math.floor(rest / gx), z];
}

/**
 * Write the three unit-cube coordinates for particle `uid` into `out`.
 *
 * `tt` is the retry counter the container-clipping loop in emission.js spins
 * (see collMode 2). For 'random' it shifts the stream by 53 exactly as the
 * original code did, so clipped systems are byte-identical too. For every other
 * mode it must be a HASH of (uid, tt), never a fixed stride: a constant stride
 * walks a quasi-random sequence in lockstep, and measured that way 2,421 of
 * 3,000 particles came out coincident.
 */
export function distributionSample(out, P, uid, tt = 0) {
  const seed = P.seed;
  const cc = tt * 53;

  if (P.mode === 'random') {
    out[0] = rnd(seed, uid, 1 + cc);
    out[1] = rnd(seed, uid, 2 + cc);
    out[2] = rnd(seed, uid, 3 + cc);
    return out;
  }

  const idx = tt === 0 ? uid
    : hash32(Math.imul(uid + 1, 2246822519) ^ Math.imul(tt, 668265263)) % 8388608;
  const j = P.jitter;

  switch (P.mode) {
    // ── Lattices ────────────────────────────────────────────────────────
    // Houdini: Points from Volume ▸ Grid / Tetrahedral, + Jitter Scale.
    case 'stratified':
    case 'grid':
    case 'packed': {
      const total = Math.max(1, P.gx * P.gy * P.gz);
      const k = orderedIndex(idx % total, total, P.order, seed, P.bits);
      const [cx, cy, cz] = cellOf(k, P.gx, P.gy);
      let ox = 0, oy = 0;
      if (P.mode === 'packed') {
        // Rows offset half a cell (hexagonal in plane) and layers a third
        // (tetrahedral through depth): every point equidistant from its
        // nearest three, the densest arrangement that is still even.
        ox = ((cy & 1) ? 0.5 : 0) + ((cz & 1) ? 0.25 : 0);
        oy = (cz & 1) ? 0.3333333333 : 0;
      }
      if (P.mode === 'stratified') {
        // One point anywhere inside its OWN cell. That full-cell jitter IS the
        // mode — without it, stratified is just grid, and the two measured
        // identically until this was separated out.
        const s = j > 0 ? j : 1;
        out[0] = (cx + 0.5 + (rnd(seed, idx, 1) - 0.5) * s) / P.gx;
        out[1] = (cy + 0.5 + (rnd(seed, idx, 2) - 0.5) * s) / P.gy;
        out[2] = P.gz > 1 ? (cz + 0.5 + (rnd(seed, idx, 3) - 0.5) * s) / P.gz : rnd(seed, idx, 3);
      } else {
        out[0] = clamp((cx + 0.5 + ox) / P.gx + (rnd(seed, idx, 1) - 0.5) * j / P.gx, 0, 0.999999);
        out[1] = clamp((cy + 0.5 + oy) / P.gy + (rnd(seed, idx, 2) - 0.5) * j / P.gy, 0, 0.999999);
        out[2] = P.gz > 1
          ? clamp((cz + 0.5) / P.gz + (rnd(seed, idx, 3) - 0.5) * j / P.gz, 0, 0.999999)
          : 0.5 + (rnd(seed, idx, 3) - 0.5) * j;
      }
      return out;
    }

    // ── Low-discrepancy ─────────────────────────────────────────────────
    // Houdini: the quasi-random sampler under Scatter (VEX nrandom "qstrat").
    // The one mode that is even AND progressive: the first fifty births are
    // already spread, and so are the first fifty thousand, without either
    // knowing the total. For an emitter — which never knows N — that property
    // is the whole game.
    case 'lowdisc': {
      const n = idx + 1;
      if (P.seq === 1) {
        out[0] = radicalInverse(n, 2); out[1] = radicalInverse(n, 3); out[2] = radicalInverse(n, 5);
      } else if (P.gz === 1) {
        out[0] = fxFrac(n, FX_B1, FX_HALF);
        out[1] = fxFrac(n, FX_B2, FX_HALF);
        out[2] = fxFrac(n, FX_A3, FX_HALF);
      } else {
        out[0] = fxFrac(n, FX_A1, FX_HALF);
        out[1] = fxFrac(n, FX_A2, FX_HALF);
        out[2] = fxFrac(n, FX_A3, FX_HALF);
      }
      if (j > 0) {
        // Cranley–Patterson rotation: a per-seed shift that keeps the
        // sequence's spacing but decorrelates it, so two emitters with the
        // same settings do not spawn in lockstep.
        out[0] = frac(out[0] + rnd(seed, 0, 61) * j);
        out[1] = frac(out[1] + rnd(seed, 0, 62) * j);
        out[2] = frac(out[2] + rnd(seed, 0, 63) * j);
      }
      return out;
    }

    // ── Sunflower ───────────────────────────────────────────────────────
    // The golden angle, 137.5°. The only closed form that fills a disc or a
    // sphere perfectly evenly at any count, with no table and no relaxation.
    case 'sunflower': {
      const n = Math.max(1, P.sites);
      const k = idx % n;
      const even = (k + 0.5) / n;
      if (P.axis === DIST_AXIS.none) {
        // No radial or arc axis (a box). Spending the even run on x alone lays
        // every point on its own plane; the golden sequence generalised to
        // three dimensions is the R2 lattice, so use that and stay even in all
        // of them.
        const m = k + 1;
        out[0] = fxFrac(m, P.gz === 1 ? FX_B1 : FX_A1, FX_HALF);
        out[1] = fxFrac(m, P.gz === 1 ? FX_B2 : FX_A2, FX_HALF);
        out[2] = fxFrac(m, FX_A3, FX_HALF);
      } else {
        out[0] = even;
        out[1] = fxFrac(k, FX_GOLD);
        out[2] = fxFrac(k, FX_A1);
      }
      if (j > 0) {
        out[0] = clamp(out[0] + (rnd(seed, idx, 1) - 0.5) * j / n, 0, 0.999999);
        out[1] = frac(out[1] + (rnd(seed, idx, 2) - 0.5) * j * 0.15);
        out[2] = frac(out[2] + (rnd(seed, idx, 3) - 0.5) * j * 0.15);
      }
      return out;
    }

    // ── Concentric ──────────────────────────────────────────────────────
    // A built pattern rather than a scatter: rings evenly spaced by AREA, each
    // offset from the last by the golden angle so the spokes never line up.
    case 'rings': {
      const rings = Math.max(1, P.p0);
      const per = Math.max(1, Math.round(P.sites / rings));
      const k = idx % (rings * per);
      const q = k % rings;
      const s = Math.floor(k / rings);
      const rEven = (q + 0.5) / rings;
      const ang = frac(s / per + fxFrac(q, FX_GOLD));
      if (P.axis === DIST_AXIS.radial) {
        // `a` is the radius CDF and the maps take sqrt/cbrt of it, so squaring
        // here is what makes the rings evenly SPACED rather than evenly in area.
        out[0] = rEven * rEven; out[1] = ang; out[2] = rnd(seed, idx, 3);
      } else {
        out[0] = ang; out[1] = rEven; out[2] = rnd(seed, idx, 3);
      }
      if (j > 0) {
        out[0] = clamp(out[0] + (rnd(seed, idx, 1) - 0.5) * j * 0.5 / rings, 0, 0.999999);
        out[1] = frac(out[1] + (rnd(seed, idx, 2) - 0.5) * j * 0.5 / per);
      }
      return out;
    }

    // ── Clustered ───────────────────────────────────────────────────────
    // Houdini: Scatter By Density with a noise attribute. The deliberate
    // opposite of even — sparks off an impact, embers, flocks, debris.
    case 'clustered': {
      const nc = Math.max(1, P.p0);
      const cid = hash32(Math.imul(idx + 1, 2246822519) ^ Math.imul(seed | 0, 668265263)) % nc;
      const cx = rnd(seed, cid, 201), cy = rnd(seed, cid, 202), cz = rnd(seed, cid, 203);
      const s = P.p1;
      // Box–Muller off the deterministic streams: a real gaussian, so a cluster
      // has a soft falloff instead of a hard disc edge.
      const u1 = Math.max(1e-6, rnd(seed, idx, 1)), u2 = rnd(seed, idx, 2);
      const u3 = Math.max(1e-6, rnd(seed, idx, 3)), u4 = rnd(seed, idx, 4);
      const r1 = Math.sqrt(-2 * Math.log(u1)), r2 = Math.sqrt(-2 * Math.log(u3));
      // FOLDED at the wall, not clipped. Clipping piles the overshoot onto the
      // faces and reads as a crust around the emitter.
      const fold = (v) => { let x = v < 0 ? -v : v; if (x > 1) x = 2 - x; return clamp(x, 0, 0.999999); };
      out[0] = fold(cx + r1 * Math.cos(u2 * 6.283185307179586) * s);
      out[1] = fold(cy + r1 * Math.sin(u2 * 6.283185307179586) * s);
      out[2] = fold(cz + r2 * Math.cos(u4 * 6.283185307179586) * s);
      return out;
    }

    // ── Falloff ─────────────────────────────────────────────────────────
    // Houdini: Scatter ▸ By Density with a ramp. The radial axis already holds
    // the area CDF, so a power on it is an exact density ramp, not an
    // approximation of one.
    case 'falloff': {
      out[0] = rnd(seed, idx, 1); out[1] = rnd(seed, idx, 2); out[2] = rnd(seed, idx, 3);
      const p = Math.pow(3, -P.p0);
      if (P.axis === DIST_AXIS.radial) out[0] = Math.pow(out[0], p);
      else if (P.axis === DIST_AXIS.angular) out[1] = Math.pow(out[1], p);
      else {
        // No radial axis: bias towards the centre of the box on every axis.
        for (let k = 0; k < 3; k++) {
          const c = out[k] * 2 - 1;
          out[k] = (c < 0 ? -Math.pow(-c, p) : Math.pow(c, p)) * 0.5 + 0.5;
        }
      }
      return out;
    }

    // ── Relaxed ─────────────────────────────────────────────────────────
    // Houdini: Scatter 2.0 ▸ Relax Iterations. Not computed — looked up. The
    // fill order permutes the table, though it matters less here than for a
    // lattice: Mitchell best-candidate places each point as far as it can from
    // everything already placed, so the table's own order is already spread.
    case 'relaxed': {
      const T = P.relax;
      if (!T) { out[0] = rnd(seed, idx, 1); out[1] = rnd(seed, idx, 2); out[2] = rnd(seed, idx, 3); return out; }
      const k = orderedIndex(idx % T.count, T.count, P.order, seed, P.bits);
      // Jitter is scaled by the set's own spacing, so the slider means the same
      // thing at 500 sites as at 8,000 rather than obliterating a dense set.
      const j2 = j * 0.5 / Math.cbrt(T.count);
      out[0] = clamp(T.points[k * 3] + (rnd(seed, idx, 1) - 0.5) * j2, 0, 0.999999);
      out[1] = clamp(T.points[k * 3 + 1] + (rnd(seed, idx, 2) - 0.5) * j2, 0, 0.999999);
      out[2] = clamp(T.points[k * 3 + 2] + (rnd(seed, idx, 3) - 0.5) * j2, 0, 0.999999);
      return out;
    }

    // ── Shell ───────────────────────────────────────────────────────────
    // Houdini: POP Source ▸ Emission Type "Surfaces" instead of "Volume".
    // Thickness is never zero: a mathematically thin surface aliases into a
    // flickering wire as the camera moves, because sprite centres land either
    // side of the same pixel.
    case 'shell': {
      out[0] = rnd(seed, idx, 1); out[1] = rnd(seed, idx, 2); out[2] = rnd(seed, idx, 3);
      const t = P.p0;
      if (P.axis === DIST_AXIS.radial) out[0] = 1 - rnd(seed, idx, 4) * t;
      else if (P.axis === DIST_AXIS.angular) {
        out[1] = rnd(seed, idx, 4) < 0.5 ? rnd(seed, idx, 5) * t : 1 - rnd(seed, idx, 5) * t;
      } else {
        const f = Math.floor(rnd(seed, idx, 4) * 6);
        const axis = f >> 1, side = f & 1;
        out[axis] = side ? 1 - rnd(seed, idx, 5) * t : rnd(seed, idx, 5) * t;
      }
      return out;
    }

    default:
      out[0] = rnd(seed, uid, 1 + cc);
      out[1] = rnd(seed, uid, 2 + cc);
      out[2] = rnd(seed, uid, 3 + cc);
      return out;
  }
}

/* ── Panel metadata ─────────────────────────────────────────────────────── */

/**
 * What the inspector needs to draw the section: the label, the Houdini node it
 * corresponds to, which extra rows to show, whether the mode needs a site count
 * and which shapes it actually suits.
 */
export const DISTRIBUTION_META = {
  random: {
    label: 'Random', houdini: 'Scatter, no relaxation',
    needsSites: false, jitterDefault: 0,
    hint: 'Three independent draws — every particle placed knowing nothing about any other, so clumps and holes are not a defect, they are what independence looks like. This is what the emitter has always done.',
  },
  stratified: {
    label: 'Stratified', houdini: 'Points from Volume ▸ Grid + Jitter',
    needsSites: true, jitterDefault: 1,
    hint: 'One particle anywhere inside its own cell of a lattice. Keeps the organic look of Random but cannot clump across a cell wall, which removes the worst gaps for free. The drop-in upgrade.',
  },
  grid: {
    label: 'Grid (equal)', houdini: 'Points from Volume ▸ Grid, Jitter 0',
    needsSites: true, jitterDefault: 0,
    hint: 'Exact cell centres. Perfectly regular and perfectly artificial — a dot matrix, a formation, a wall of tiles, or beads threaded evenly along a path.',
  },
  packed: {
    label: 'Packed', houdini: 'Points from Volume ▸ Tetrahedral',
    needsSites: true, jitterDefault: 0,
    hint: 'Rows offset by half a cell — hexagonal in plane, tetrahedral through depth. The densest arrangement that is still perfectly even, and the one that reads as a solid surface rather than a grid.',
  },
  relaxed: {
    label: 'Relaxed', houdini: 'Scatter 2.0 ▸ Relax Iterations (blue noise)',
    needsSites: true, jitterDefault: 0, params: ['relaxIters'],
    hint: 'Points dropped at random, then pushed off each other until nothing is clumped. Even like a lattice but with no direction and no repeating cell — what "scattered evenly" looks like when nobody is meant to notice the scattering. Houdini\'s default answer.',
  },
  lowdisc: {
    label: 'Low-discrepancy', houdini: 'the quasi-random sampler under Scatter',
    needsSites: false, jitterDefault: 0, params: ['sequence'],
    hint: 'A quasi-random sequence instead of white noise: looks random, spaces like a lattice, and is even at ANY count without knowing the total. The one to reach for on a continuously emitting system.',
  },
  sunflower: {
    label: 'Sunflower', houdini: 'the closed form behind an even disc',
    needsSites: true, jitterDefault: 0, bestOn: ['sphere', 'cone', 'ring', 'path'],
    hint: 'The golden angle, 137.5°, one turn per particle. The only way to fill a disc or a sphere perfectly evenly in closed form. It fills CENTRE-OUTWARD, which is lovely as a growth and wrong if the shape is meant to be populated all at once.',
  },
  rings: {
    label: 'Concentric', houdini: 'a built pattern, not a scatter',
    needsSites: true, jitterDefault: 0, params: ['rings'], bestOn: ['sphere', 'cone', 'ring'],
    hint: 'Rings evenly spaced by area, each offset from the last so the spokes never line up. Reads as designed rather than scattered: targets, radar, ripples, a dial.',
  },
  clustered: {
    label: 'Clustered', houdini: 'Scatter By Density with a noise attribute',
    needsSites: false, jitterDefault: 0, params: ['clusters', 'tightness'],
    hint: 'Cluster seeds scattered first, then every particle born near one of them — clumping as a look. Sparks off an impact, embers, flocks, a debris field.',
  },
  falloff: {
    label: 'Falloff', houdini: 'Scatter ▸ By Density with a ramp',
    needsSites: false, jitterDefault: 0, params: ['bias'],
    hint: 'Random, but the density is biased along the shape’s radial axis: packed into the core, or hollowed out towards the rim.',
  },
  shell: {
    label: 'Shell', houdini: 'POP Source ▸ Emission Type "Surfaces"',
    needsSites: false, jitterDefault: 0, params: ['thickness'],
    hint: 'The skin only. A sphere becomes a bubble, a disc a rim, a box six faces. Different from Falloff at full edge bias: every particle sits at the same depth rather than merely crowding near it.',
  },
};
