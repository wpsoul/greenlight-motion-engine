/*
 * GPU EMISSION, the free list, and the reaper — Phase 2 of
 * PLANS/VIDEO_EDITOR_PARTICLE_GPU_SCALE_PLAN.md.
 *
 * WHAT MAKES THIS PORTABLE AT ALL. Everything about a particle's birth —
 * where it appears, which way it launches, how fast, how long it lives — is a
 * pure function of (seed, uid) and the emitter config. Nothing about it depends
 * on what any other particle did. So the CPU keeps only the part that is
 * genuinely sequential (how many are born this step, which is one accumulator)
 * and the GPU does the rest, in parallel, for however many that is.
 *
 * THE RANDOM STREAMS ARE THE CONTRACT. Stream indices 1, 2, 3 are the shape's
 * offsets; 11 and 12 are the direction cone; 13 is speed variance; 14 is
 * lifetime variance. Those numbers are load-bearing: emission.js draws from
 * exactly those streams for exactly those quantities, and a particle's look has
 * to be the same whether it came from the bake or from here. The gate in
 * tests/particles-gpu-scale/run_emit.js compares against the real module rather
 * than a restatement of it.
 *
 * THREE PASSES, IN ORDER, ONCE PER SIMULATION STEP:
 *
 *   reap      a particle past its life dies and its slot is PUSHED to the free
 *             list. Runs first so the slot it frees is available this same step.
 *   emit      each new particle POPS a slot and writes itself into it.
 *   integrate forces and the position update.
 *
 * THE FREE LIST REPLACES A LINEAR SCAN. emission.js walks the pool from a
 * cursor looking for an empty slot — O(maxParticles) per birth, which at a
 * million-particle pool is the whole frame for a handful of spawns. Here a
 * birth is one atomicSub and a death is one atomicAdd.
 *
 * WHAT IT DOES NOT THROTTLE BY. The cap throttles emission; it never overwrites
 * a particle that is still alive. Recycling the oldest slot — the obvious
 * ring-buffer implementation — silently caps every particle's real life at
 * maxParticles/rate seconds no matter what lifetime says, and a long lifetime
 * would just quietly not happen. The free list gets this right by construction:
 * an occupied slot is simply not in it.
 *
 * ONE ACCEPTED DIFFERENCE FROM THE BAKE. Which SLOT a uid lands in differs —
 * the bake scans, this pops, and the pops race. Nothing about a particle's
 * appearance depends on its slot (position, velocity and life all come from its
 * uid), so this is invisible in the picture. It is visible in one place: the
 * first 24 spawn sites feed the fluid splats, and "first 24" means something
 * different when slots are handed out in a different order. Recorded in the
 * plan rather than left to be discovered.
 *
 * NOT PORTED: container clipping (collMode 2), which rejection-samples against
 * a collider SDF. That stays a Tier 1 feature until Phase 5 brings the SDF onto
 * this device.
 */

/** Emitter shapes, as integers. Mirrors the string switch in emission.js. */
export const SHAPE = { point: 0, box: 1, sphere: 2, cone: 3, ring: 4, block: 5, layer: 6, path: 7 };
/** Direction modes for ring and path emitters. */
export const DIR_MODE = { fixed: 0, outward: 1, tangent: 2 };

export const EMIT_U_FLOATS = 68;
export const EMIT_U_BYTES = EMIT_U_FLOATS * 4;

/** Distribution modes and fill orders, as integers. Mirrors distribution.js. */
export const DIST_MODE = {
  random: 0, stratified: 1, grid: 2, packed: 3, lowdisc: 4,
  sunflower: 5, rings: 6, clustered: 7, falloff: 8, shell: 9,
  relaxed: 10,
};

/** Lane order of the emit uniform block — mirrored by the JS packer. */
export const EMIT_KEYS = [
  'seed', 'cap', 'shape', 'dirMode',
  'posX', 'posY', 'posZ', 'sizeX',
  'sizeY', 'sizeZ', 'dirX', 'dirY',
  'dirZ', 'spread', 'speed', 'speedRandom',
  'lifetime', 'lifetimeRandom', 'ringRadius', 'ringThickness',
  'firstUid', 'spawnCount', 'tableCount', 'pathN',
  'dt', 't', 'gravX', 'gravY',
  'gravZ', 'drag', 'boundsMode', 'boxX',
  'boxY', 'boxZ', 'restitution', 'sizeMinXY',
  'fluidOn', 'relax', 'turbOn', 'turbStr',
  'turbScale', 'turbSpeed', 'turbPat', 'turbOct',
  'turbSeed', 'turbDir', 'vortOn', 'vortStr',
  'vortScale', 'vortMode', 'vortAxis', 'vortLift',
  // CHUNKING. A pool too big for one storage binding is split into slabs, each
  // with its own pool, free list and instance buffer, and each dispatched with
  // its own bind group. A slab therefore emits a STRIDED subsequence of the
  // step's uids — slab s takes every uid congruent to s — so it needs to know
  // where its subsequence starts and how far apart its members are. Unchunked,
  // these are (firstUid, 1) and the shader does exactly what it did before.
  'uidBase', 'uidStride', '_c0', '_c1',
  /*
   * DISTRIBUTION. The lattice dims are computed on the CPU and passed in rather
   * than derived here: round(cbrt(x)) evaluated on two different devices is not
   * guaranteed to land on the same integer, and one cell of difference is a
   * different lattice — which would show up as the bake and the live engine
   * disagreeing about where particles are.
   */
  'distMode', 'distJitter', 'distOrder', 'distSites',
  'distGx', 'distGy', 'distGz', 'distP0',
  'distP1', 'distSeq', 'distAxis', '_d0',
];

/*
 * The shader in three named pieces, so a test can compile the DISTRIBUTION
 * block on its own against the JS it has to equal. Concatenated verbatim into
 * EMIT_WGSL below — there is one copy of every line, and it is this one.
 */
export const WGSL_U_STRUCT = /* wgsl */ `
struct U {
  seed: f32, cap: f32, shape: f32, dirMode: f32,
  posX: f32, posY: f32, posZ: f32, sizeX: f32,
  sizeY: f32, sizeZ: f32, dirX: f32, dirY: f32,
  dirZ: f32, spread: f32, speed: f32, speedRandom: f32,
  lifetime: f32, lifetimeRandom: f32, ringRadius: f32, ringThickness: f32,
  firstUid: f32, spawnCount: f32, tableCount: f32, pathN: f32,
  dt: f32, t: f32, gravX: f32, gravY: f32,
  gravZ: f32, drag: f32, boundsMode: f32, boxX: f32,
  boxY: f32, boxZ: f32, restitution: f32, sizeMinXY: f32,
  fluidOn: f32, relax: f32, turbOn: f32, turbStr: f32,
  turbScale: f32, turbSpeed: f32, turbPat: f32, turbOct: f32,
  turbSeed: f32, turbDir: f32, vortOn: f32, vortStr: f32,
  vortScale: f32, vortMode: f32, vortAxis: f32, vortLift: f32,
  uidBase: f32, uidStride: f32, _c0: f32, _c1: f32,
  distMode: f32, distJitter: f32, distOrder: f32, distSites: f32,
  distGx: f32, distGy: f32, distGz: f32, distP0: f32,
  distP1: f32, distSeq: f32, distAxis: f32, _d0: f32,
};
`;

export const WGSL_RNG = /* wgsl */ `
fn hash32(x: u32) -> u32 {
  var v = x;
  v = (v ^ 61u) ^ (v >> 16u);
  v = v + (v << 3u);
  v = v ^ (v >> 4u);
  v = v * 0x27d4eb2du;
  v = v ^ (v >> 15u);
  return v;
}
fn rand(seed: u32, uid: u32, stream: u32) -> f32 {
  let mixed = (seed * 374761393u) ^ (uid * 668265263u) ^ ((stream + 1u) * 2246822519u);
  // SHIFT BEFORE CONVERTING, and this is not a micro-optimisation. f32 carries
  // 24 mantissa bits, so f32(h) for a full 32-bit h must ROUND — discarding the
  // low 8 bits of the hash, and doing it in a way two GPU vendors could resolve
  // differently at a tie. h >> 8u is below 2^24 and therefore exact on every
  // implementation, which is what a seeded simulation needs. The CPU divides the
  // full 32 bits in f64; the two agree to f32 precision (~6e-8), which is as
  // close as f32 arithmetic can get to an f64 reference.
  return f32(hash32(mixed) >> 8u) * (1.0 / 16777216.0);
}
fn srand(seed: u32, uid: u32, stream: u32) -> f32 { return rand(seed, uid, stream) * 2.0 - 1.0; }
fn seedU() -> u32 { return bitcast<u32>(i32(u.seed)); }
`;

export const WGSL_DIST = /* wgsl */ `
/* ── distribution.js, ported ──────────────────────────────────────────────
   Where inside the shape a particle is born. Produces the three unit-cube
   coordinates the shape maps below; mode 0 (random) returns exactly the
   rand(seed, uid, 1..3) the emitter always used, so a system that never touches
   this feature is untouched by it.

   THE JS IS THE REFERENCE. Every constant, every integer operation and every
   branch order here mirrors distribution.js line for line, because a system
   under the GPU threshold bakes there and one above it runs here — and a
   difference between the two is a system that changes appearance when you raise
   its particle count. The lattice dims and the bit width are computed on the CPU
   and arrive as uniforms for exactly that reason. */

fn distBitReverse(i: u32, bits: u32) -> u32 {
  var r = 0u;
  for (var b = 0u; b < bits; b++) { r = (r << 1u) | ((i >> b) & 1u); }
  return r;
}

/* frac(n * A / 2^32) in 32-bit fixed point. A plain f32 multiply cannot hold
   this: at a million particles n*alpha is ~7.5e5, where f32's spacing is
   0.0625, so the fractional part would have sixteen distinct values and the
   sequence would collapse into planes. The u32 wraparound IS the fraction, and
   the >> 8 before the divide keeps it under 2^24 so the value is exact in f32 —
   which is what lets this equal distribution.js rather than merely approximate
   it. Constants are 1/phi and 1/phi3^1..3; see the JS for why three different
   ones are needed. */
const FX_GOLD: u32 = 2654435769u;
const FX_A1: u32 = 3518319155u;
const FX_A2: u32 = 2882110345u;
const FX_A3: u32 = 2360945575u;
/* The 2-D pair. The 3-D triple's PROJECTION onto a plane is worse than white
   noise (measured: 0.46 of the ideal gap against 0.51), and on a flat emitter
   the projection is what you look at. Flatness is the same gz == 1 the lattice
   uses. */
const FX_B1: u32 = 3242174889u;
const FX_B2: u32 = 2447445414u;
const FX_HALF: u32 = 2147483648u;

fn fxFrac(n: u32, A: u32, phase: u32) -> f32 {
  return f32(((n * A) + phase) >> 8u) * (1.0 / 16777216.0);
}

fn distRadical(i: u32, base: u32) -> f32 {
  var f = 1.0 / f32(base);
  var r = 0.0;
  var n = i;
  // Bounded rather than a data-dependent while loop, which is a hazard in a
  // shader: 2^32 in base 2 needs 32 steps at most.
  for (var k = 0u; k < 32u; k++) {
    if (n == 0u) { break; }
    r = r + f * f32(n % base);
    n = n / base;
    f = f / f32(base);
  }
  return r;
}

/* The fill ORDER. A lattice walked in reading order fills the emitter one
   corner at a time — the single most consequential line in this file for
   anything that emits over seconds rather than all at once.

   CYCLE WALKING, and it has to be the OUTPUT that walks. Padding the set to a
   power of two leaves indices with no site; walking the INPUT forward until the
   output lands in range is not a permutation, because many indices converge on
   the same landing spot and pile particles onto one cell. Walking the output
   through a bijection is a permutation by construction. The step must also not
   be an involution — bit-reversal alone is its own inverse, so a pair of
   out-of-range values would ping-pong for ever. */
fn distStep(x: u32, order: u32, bits: u32, mask: u32, seed: u32) -> u32 {
  if (order == 1u) { return distBitReverse((x + 1u) & mask, bits); }
  return distBitReverse(((x * 0x9E3779B1u) + seed * 2u + 1u) & mask, bits);
}

fn distOrdered(k: u32, total: u32, order: u32, seed: u32) -> u32 {
  if (total <= 1u || order == 0u) { return select(k, 0u, total <= 1u); }
  let bits = u32(u._d0 + 0.5);
  let mask = (1u << bits) - 1u;
  var r = distStep(k, order, bits, mask, seed);
  var guard = 0u;
  loop {
    if (r < total || guard >= 256u) { break; }
    r = distStep(r, order, bits, mask, seed);
    guard = guard + 1u;
  }
  return select(k, r, r < total);
}

fn distSample(uid: u32) -> vec3f {
  let seed = seedU();
  let mode = u32(u.distMode + 0.5);
  if (mode == 0u) {
    return vec3f(rand(seed, uid, 1u), rand(seed, uid, 2u), rand(seed, uid, 3u));
  }
  let idx = uid;                       // container clipping is not ported here,
                                       // so the retry counter is always zero
  let j = u.distJitter;
  let axis = u32(u.distAxis + 0.5);
  var o = vec3f(0.0);

  if (mode <= 3u) {                    // stratified / grid / packed
    let gx = max(1u, u32(u.distGx + 0.5));
    let gy = max(1u, u32(u.distGy + 0.5));
    let gz = max(1u, u32(u.distGz + 0.5));
    let total = max(1u, gx * gy * gz);
    let k = distOrdered(idx % total, total, u32(u.distOrder + 0.5), seed);
    let cz = k / (gx * gy);
    let rest = k - cz * gx * gy;
    let cx = rest % gx;
    let cy = rest / gx;
    var ox = 0.0;
    var oy = 0.0;
    if (mode == 3u) {                  // packed: hexagonal rows, tetrahedral layers
      ox = select(0.0, 0.5, (cy & 1u) == 1u) + select(0.0, 0.25, (cz & 1u) == 1u);
      oy = select(0.0, 0.3333333333, (cz & 1u) == 1u);
    }
    if (mode == 1u) {                  // stratified: anywhere inside its OWN cell
      let s = select(1.0, j, j > 0.0);
      o.x = (f32(cx) + 0.5 + (rand(seed, idx, 1u) - 0.5) * s) / f32(gx);
      o.y = (f32(cy) + 0.5 + (rand(seed, idx, 2u) - 0.5) * s) / f32(gy);
      o.z = select(rand(seed, idx, 3u),
        (f32(cz) + 0.5 + (rand(seed, idx, 3u) - 0.5) * s) / f32(gz), gz > 1u);
    } else {
      o.x = clamp((f32(cx) + 0.5 + ox) / f32(gx) + (rand(seed, idx, 1u) - 0.5) * j / f32(gx), 0.0, 0.999999);
      o.y = clamp((f32(cy) + 0.5 + oy) / f32(gy) + (rand(seed, idx, 2u) - 0.5) * j / f32(gy), 0.0, 0.999999);
      o.z = select(0.5 + (rand(seed, idx, 3u) - 0.5) * j,
        clamp((f32(cz) + 0.5) / f32(gz) + (rand(seed, idx, 3u) - 0.5) * j / f32(gz), 0.0, 0.999999), gz > 1u);
    }
    return o;
  }

  if (mode == 4u) {                    // low-discrepancy
    let n = idx + 1u;
    if (u.distSeq > 0.5) {
      o = vec3f(distRadical(n, 2u), distRadical(n, 3u), distRadical(n, 5u));
    } else {
      let flat = u32(u.distGz + 0.5) == 1u;
      o = vec3f(fxFrac(n, select(FX_A1, FX_B1, flat), FX_HALF),
                fxFrac(n, select(FX_A2, FX_B2, flat), FX_HALF),
                fxFrac(n, FX_A3, FX_HALF));
    }
    if (j > 0.0) {
      // Cranley–Patterson rotation — keeps the spacing, decorrelates the phase.
      o = fract(o + vec3f(rand(seed, 0u, 61u), rand(seed, 0u, 62u), rand(seed, 0u, 63u)) * j);
    }
    return o;
  }

  if (mode == 5u) {                    // sunflower
    let n = max(1u, u32(u.distSites + 0.5));
    let k = idx % n;
    if (axis == 0u) {
      // A box has no radius: spending the even run on x alone lays every point
      // on its own plane, so use the R2 lattice, which is the same idea in 3-D.
      let m = k + 1u;
      let flat2 = u32(u.distGz + 0.5) == 1u;
      o = vec3f(fxFrac(m, select(FX_A1, FX_B1, flat2), FX_HALF),
                fxFrac(m, select(FX_A2, FX_B2, flat2), FX_HALF),
                fxFrac(m, FX_A3, FX_HALF));
    } else {
      o = vec3f((f32(k) + 0.5) / f32(n), fxFrac(k, FX_GOLD, 0u), fxFrac(k, FX_A1, 0u));
    }
    if (j > 0.0) {
      o.x = clamp(o.x + (rand(seed, idx, 1u) - 0.5) * j / f32(n), 0.0, 0.999999);
      o.y = fract(o.y + (rand(seed, idx, 2u) - 0.5) * j * 0.15);
      o.z = fract(o.z + (rand(seed, idx, 3u) - 0.5) * j * 0.15);
    }
    return o;
  }

  if (mode == 6u) {                    // concentric
    let rings = max(1u, u32(u.distP0 + 0.5));
    let per = max(1u, u32(round(u.distSites / f32(rings))));
    let k = idx % (rings * per);
    let q = k % rings;
    let s = k / rings;
    let rEven = (f32(q) + 0.5) / f32(rings);
    let ang = fract(f32(s) / f32(per) + fxFrac(q, FX_GOLD, 0u));
    if (axis == 1u) {
      // a is the radius CDF and the map takes its sqrt/cbrt, so squaring here
      // is what makes the rings evenly SPACED rather than even in area.
      o = vec3f(rEven * rEven, ang, rand(seed, idx, 3u));
    } else {
      o = vec3f(ang, rEven, rand(seed, idx, 3u));
    }
    if (j > 0.0) {
      o.x = clamp(o.x + (rand(seed, idx, 1u) - 0.5) * j * 0.5 / f32(rings), 0.0, 0.999999);
      o.y = fract(o.y + (rand(seed, idx, 2u) - 0.5) * j * 0.5 / f32(per));
    }
    return o;
  }

  if (mode == 7u) {                    // clustered
    let nc = max(1u, u32(u.distP0 + 0.5));
    let cid = hash32(((idx + 1u) * 2246822519u) ^ (seed * 668265263u)) % nc;
    let c = vec3f(rand(seed, cid, 201u), rand(seed, cid, 202u), rand(seed, cid, 203u));
    let s = u.distP1;
    let u1 = max(1e-6, rand(seed, idx, 1u));
    let u2 = rand(seed, idx, 2u);
    let u3 = max(1e-6, rand(seed, idx, 3u));
    let u4 = rand(seed, idx, 4u);
    let r1 = sqrt(-2.0 * log(u1));
    let r2 = sqrt(-2.0 * log(u3));
    // FOLDED at the wall, not clipped: clipping piles the overshoot onto the
    // faces and reads as a crust around the emitter.
    var v = vec3f(c.x + r1 * cos(u2 * 6.283185307179586) * s,
                  c.y + r1 * sin(u2 * 6.283185307179586) * s,
                  c.z + r2 * cos(u4 * 6.283185307179586) * s);
    v = abs(v);
    v = select(v, 2.0 - v, v > vec3f(1.0));
    return clamp(v, vec3f(0.0), vec3f(0.999999));
  }

  if (mode == 8u) {                    // falloff
    o = vec3f(rand(seed, idx, 1u), rand(seed, idx, 2u), rand(seed, idx, 3u));
    let p = pow(3.0, -u.distP0);
    if (axis == 1u) { o.x = pow(o.x, p); }
    else if (axis == 2u) { o.y = pow(o.y, p); }
    else {
      let c3 = o * 2.0 - vec3f(1.0);
      let a3 = pow(abs(c3), vec3f(p));
      o = select(a3, -a3, c3 < vec3f(0.0)) * 0.5 + vec3f(0.5);
    }
    return o;
  }

  if (mode == 10u) {                   // relaxed — a baked set, not a formula
    /* THE SET LIVES IN tablePos, the buffer shape:'layer' owns.
       That sharing is the whole reason this mode needed no new binding, and it
       is safe because the two can never both be on: prepareDistribution refuses
       relaxed on a layer emitter. The layer table is 2 floats per site and this
       one is 3 — another reason they must never overlap. */
    let cnt = max(1u, u32(u.distSites + 0.5));
    let k = distOrdered(idx % cnt, cnt, u32(u.distOrder + 0.5), seed);
    let b = k * 3u;
    let j2 = j * 0.5 / pow(f32(cnt), 1.0 / 3.0);
    o = vec3f(tablePos[b], tablePos[b + 1u], tablePos[b + 2u])
      + (vec3f(rand(seed, idx, 1u), rand(seed, idx, 2u), rand(seed, idx, 3u)) - vec3f(0.5)) * j2;
    return clamp(o, vec3f(0.0), vec3f(0.999999));
  }

  // mode 9 — shell
  o = vec3f(rand(seed, idx, 1u), rand(seed, idx, 2u), rand(seed, idx, 3u));
  let t = u.distP0;
  if (axis == 1u) { o.x = 1.0 - rand(seed, idx, 4u) * t; }
  else if (axis == 2u) {
    o.y = select(1.0 - rand(seed, idx, 5u) * t, rand(seed, idx, 5u) * t, rand(seed, idx, 4u) < 0.5);
  } else {
    let f = u32(floor(rand(seed, idx, 4u) * 6.0));
    let ax = f >> 1u;
    let hi = (f & 1u) == 1u;
    let v = select(rand(seed, idx, 5u) * t, 1.0 - rand(seed, idx, 5u) * t, hi);
    if (ax == 0u) { o.x = v; } else if (ax == 1u) { o.y = v; } else { o.z = v; }
  }
  return o;
}
`;

export const EMIT_WGSL = /* wgsl */ `
struct Part { pos: vec4f, vel: vec4f, aux: vec4f };

${WGSL_U_STRUCT}

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> parts: array<Part>;
@group(0) @binding(2) var<storage, read_write> freeSlots: array<u32>;
@group(0) @binding(3) var<storage, read_write> freeCount: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> tablePos: array<f32>;
@group(0) @binding(5) var<storage, read> pathS: array<f32>;
/* The fluid, for coupling. Bound by all three entry points because they share
   one explicit layout; only integrate reads it. A 1x1x1 dummy stands in when
   the system has no fluid, so the bind group is always complete. */
@group(0) @binding(6) var fieldVel: texture_3d<f32>;
@group(0) @binding(7) var fieldSamp: sampler;
/* [dispatchX, dispatchY, dispatchZ, highWater] — the first three are read by
   dispatchWorkgroupsIndirect, the fourth is how far up the pool has ever been
   used. See 'prepare'. */
@group(0) @binding(8) var<storage, read_write> poolArgs: array<atomic<u32>>;

/* ── rng.js, ported bit-exactly (same as deriveWgsl.js) ───────────────────── */

${WGSL_RNG}

${WGSL_DIST}

/* A 2D dispatch, because a pool of millions exceeds the 65535-groups-per-
   dimension limit in one row. The row stride is derived from num_workgroups
   rather than hardcoded: a constant here has to agree with whatever the JS
   passed to dispatchWorkgroups, and when it does not, rows OVERLAP — the same
   slots are processed many times over and the atomic counter reports more
   particles than the pool contains. That failure is invisible below a million
   (one row) and silent above it. */
fn gid1(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 64u; }

/* ── spawnDirection: a cone of spreadDeg around dir ──────────────────────── */

fn spawnDirection(dir: vec3f, spreadDeg: f32, seed: u32, uid: u32) -> vec3f {
  let dl = max(length(dir), 1e-20);
  let d = dir / dl;
  let cosMax = cos(clamp(spreadDeg, 0.0, 180.0) * 0.017453292519943295);
  let cosT = mix(cosMax, 1.0, rand(seed, uid, 11u));
  let sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  let phi = rand(seed, uid, 12u) * 6.283185307179586;
  // Orthonormal basis around the axis — the same degenerate-case branch the CPU
  // takes, so a straight-up emitter picks the same fallback basis and its cone
  // lands in the same place.
  var uu = vec3f(1.0, 0.0, 0.0);
  if (abs(d.y) < 0.99) { uu = vec3f(d.z, 0.0, -d.x); }
  uu = uu / max(length(uu), 1e-20);
  let vv = cross(d, uu);
  return d * cosT + (uu * cos(phi) + vv * sin(phi)) * sinT;
}


/* ── GLOBAL FORCES, LIFTED VERBATIM FROM gpuEngine.js ─────────────────────────
 *
 * Turbulence and the vortex field are not incidental: eight of the ten shipped
 * presets use one of them. Dust, Stars, Snow, Sparks and Bokeh are turbulence;
 * Ember Swirl is a vortex, and that vortex IS its look — without it the plume
 * stands up as a symmetric fountain instead of curling over.
 *
 * Copied rather than re-derived from fields.js. These are five noise patterns
 * with measured per-pattern gain constants and five vortex modes; a second
 * translation from the JS would be a second chance to get one of those constants
 * wrong, and the difference would show up as "the preview and the render
 * disagree" rather than as anything obviously broken. The uniform names below
 * bridge gpuEngine's block to this one so the bodies stay untouched.
 */
fn vortAxisU() -> u32 { return u32(u.vortAxis + 0.5); }
fn vortModeU() -> u32 { return u32(u.vortMode + 0.5); }
fn turbPatU() -> u32 { return u32(u.turbPat + 0.5); }
fn turbOctU() -> u32 { return max(1u, u32(u.turbOct + 0.5)); }
fn turbSeedU() -> u32 { return bitcast<u32>(i32(u.turbSeed)); }

fn fieldAccel(p: vec3f) -> vec3f {
  var ax: f32; var ay: f32;
  if (vortAxisU() == 0u) { ax = p.y; ay = p.z; }
  else if (vortAxisU() == 2u) { ax = p.x; ay = p.y; }
  else { ax = p.x; ay = p.z; }
  let r0 = length(vec2f(ax, ay));
  let r = select(r0, 1e-3, r0 == 0.0);
  let k = r / u.vortScale;
  let fall = 1.0 / (1.0 + k * k);
  let s = u.vortStr * fall;
  let rx = ax / r; let ry = ay / r;
  let tx = -ry; let ty = rx;
  var a = 0.0; var b = 0.0; var w = 0.0;
  if (vortModeU() == 3u) { a = -rx * s; b = -ry * s; }
  else if (vortModeU() == 4u) { a = rx * s; b = ry * s; }
  else if (vortModeU() == 1u) { a = tx * s; b = ty * s; }
  else if (vortModeU() == 2u) { a = tx * s; b = ty * s; w = s * u.vortLift * fall; }
  else { a = tx * s - rx * s * 0.18; b = ty * s - ry * s * 0.18; }
  if (vortAxisU() == 0u) { return vec3f(w, a, b); }
  if (vortAxisU() == 2u) { return vec3f(a, b, w); }
  return vec3f(a, w, b);
}

fn ihash3(x: i32, y: i32, z: i32, s: u32) -> f32 {
  var h = u32(x) * 374761393u + u32(y) * 668265263u + u32(z) * 2147483647u + s * 974711369u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return f32(h ^ (h >> 16u)) * (1.0 / 4294967296.0);
}
fn vnoise3(p: vec3f, s: u32) -> f32 {
  let pi = floor(p);
  var f = p - pi;
  f = f * f * (3.0 - 2.0 * f);
  let xi = i32(pi.x); let yi = i32(pi.y); let zi = i32(pi.z);
  let c000 = ihash3(xi, yi, zi, s);     let c100 = ihash3(xi+1, yi, zi, s);
  let c010 = ihash3(xi, yi+1, zi, s);   let c110 = ihash3(xi+1, yi+1, zi, s);
  let c001 = ihash3(xi, yi, zi+1, s);   let c101 = ihash3(xi+1, yi, zi+1, s);
  let c011 = ihash3(xi, yi+1, zi+1, s); let c111 = ihash3(xi+1, yi+1, zi+1, s);
  return mix(mix(mix(c000,c100,f.x), mix(c010,c110,f.x), f.y), mix(mix(c001,c101,f.x), mix(c011,c111,f.x), f.y), f.z);
}
fn fbm3(p0: vec3f, s: u32, oct: u32, shape: u32) -> f32 {
  var p = p0; var v = 0.0; var amp = 0.5; var norm = 0.0;
  for (var i = 0u; i < oct; i++) {
    var n = vnoise3(p, s + i * 17u);
    if (shape == 1u) { n = abs(n * 2.0 - 1.0); }
    else if (shape == 2u) { n = 1.0 - abs(n * 2.0 - 1.0); }
    v += n * amp; norm += amp;
    p = p * 2.03 + vec3f(7.1, -3.7, 1.9);
    amp *= 0.5;
  }
  return v / max(norm, 1e-4);
}
fn turbulence(p: vec3f, phase: f32) -> vec3f {
  let sc = u.turbScale;
  let evo = u.t * u.turbSpeed;
  if (turbPatU() == 0u) {
    return vec3f(
      sin(p.y * sc * 1.3 + evo * 1.10 + phase) - sin(p.z * sc * 0.9 - evo * 0.70 + phase * 0.7),
      sin(p.z * sc * 1.1 - evo * 0.90 + phase) - sin(p.x * sc * 1.2 + evo * 1.30 + phase * 1.3),
      sin(p.x * sc * 0.8 + evo * 0.80 + phase) - sin(p.y * sc * 1.4 - evo * 1.20 + phase * 0.4));
  }
  if (turbPatU() == 1u) {
    let dx = cos(u.turbDir); let dy = sin(u.turbDir);
    let ph = (p.x * dx + p.y * dy) * sc * 6.0 - evo * 3.0 + phase * 0.15;
    let s = sin(ph);
    return vec3f(-dy * s * 2.24, dx * s * 2.24, sin(ph * 0.6 + p.z * sc * 3.0) * 0.45 * 2.24);
  }
  let q = p * (sc * 1.6) + vec3f(0.0, 0.0, evo * 0.35);
  if (turbPatU() == 2u) {
    let e = 0.55; let g = 1.33 * 3.2; let oct = turbOctU(); let sd = turbSeedU();
    let nyp = fbm3(q + vec3f(0.0, e, 0.0), sd, oct, 0u); let nym = fbm3(q - vec3f(0.0, e, 0.0), sd, oct, 0u);
    let nzp = fbm3(q + vec3f(0.0, 0.0, e), sd, oct, 0u); let nzm = fbm3(q - vec3f(0.0, 0.0, e), sd, oct, 0u);
    let nxp = fbm3(q + vec3f(e, 0.0, 0.0), sd, oct, 0u); let nxm = fbm3(q - vec3f(e, 0.0, 0.0), sd, oct, 0u);
    return vec3f(((nyp - nym) - (nzp - nzm)) * g, ((nzp - nzm) - (nxp - nxm)) * g, ((nxp - nxm) - (nyp - nym)) * g);
  }
  let shape = select(1u, 2u, turbPatU() == 4u);
  let g = 2.03; let oct = turbOctU(); let sd = turbSeedU();
  return vec3f(
    (fbm3(q, sd, oct, shape) * 2.0 - 1.0) * g,
    (fbm3(q + vec3f(41.7, -17.3, 0.0), sd + 91u, oct, shape) * 2.0 - 1.0) * g,
    (fbm3(q + vec3f(-23.1, 63.9, 0.0), sd + 173u, oct, shape) * 2.0 - 1.0) * g);
}

/* ── reap: a particle past its life frees its slot ───────────────────────── */

@compute @workgroup_size(64)
fn reap(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let id = gid1(gid, nwg);
  if (id >= u32(u.cap)) { return; }
  var p = parts[id];
  if (p.pos.w < 0.5) { return; }
  let age = u.t - p.aux.x;
  if (age < max(p.aux.y, 1e-4)) { return; }
  parts[id].pos.w = 0.0;
  let at = atomicAdd(&freeCount[0], 1u);
  if (at < u32(u.cap)) { freeSlots[at] = id; }
}

/* ── emit: one invocation per particle being born this step ──────────────── */

/*
 * HOW MANY SLOTS ARE WORTH VISITING.
 *
 * Every pool pass used to dispatch over the CAP. Raising Max particles to a
 * million therefore cost a million invocations per pass per step even with a
 * thousand particles alive — the editor got slow the moment the number was
 * typed, before a single extra particle existed. That is the wrong shape: the
 * cost must follow what is IN the pool, not what the pool could hold.
 *
 * 'emit' records the highest slot it has ever handed out; this turns that into
 * dispatch arguments the passes then use indirectly. It never shrinks, because a
 * slot below the mark may still be occupied — the free list reuses in LIFO
 * order, so occupancy is not contiguous. It only has to be an upper bound, and a
 * tight one.
 */
@compute @workgroup_size(1)
fn prepare() {
  let hw = atomicLoad(&poolArgs[3]);
  let groups = (hw + 63u) / 64u;
  let x = min(256u, max(1u, groups));
  atomicStore(&poolArgs[0], x);
  atomicStore(&poolArgs[1], (groups + x - 1u) / x);
  atomicStore(&poolArgs[2], 1u);
}

@compute @workgroup_size(64)
fn emit(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = gid1(gid, nwg);
  if (k >= u32(u.spawnCount)) { return; }
  let seed = seedU();
  // Slab s takes every uidStride'th uid starting at uidBase; unchunked that is
  // (firstUid, 1), which is the identity this replaced.
  let uid = u32(u.uidBase) + k * u32(u.uidStride);

  // Pop a slot. THE CAP THROTTLES EMISSION: when the free list is empty the
  // birth is simply dropped, never written over a living particle.
  let prev = atomicSub(&freeCount[0], 1u);
  if (prev == 0u || prev > u32(u.cap)) {
    atomicAdd(&freeCount[0], 1u);       // underflowed: put it back
    return;
  }
  let slot = freeSlots[prev - 1u];
  if (slot >= u32(u.cap)) { return; }
  atomicMax(&poolArgs[3], slot + 1u);

  var off = vec3f(0.0);
  var axis = vec3f(u.dirX, u.dirY, u.dirZ);
  let shape = i32(u.shape);

  // The three unit-cube coordinates this birth is mapped from. Every branch
  // below consumes them exactly as it consumed its raw rand() calls before.
  let ds = distSample(uid);

  if (shape == 1 || shape == 5) {                 // box, block
    off = vec3f(
      (ds.x - 0.5) * u.sizeX,
      (ds.y - 0.5) * u.sizeY,
      (ds.z - 0.5) * u.sizeZ);
  } else if (shape == 2) {                        // sphere
    let r = pow(ds.x, 1.0 / 3.0) * (u.sizeX * 0.5);
    let ct = ds.y * 2.0 - 1.0;
    let st = sqrt(max(0.0, 1.0 - ct * ct));
    let ph = ds.z * 6.283185307179586;
    off = vec3f(r * st * cos(ph), r * ct, r * st * sin(ph));
  } else if (shape == 3) {                        // cone
    let r = sqrt(ds.x) * (u.sizeX * 0.5);
    let ph = ds.y * 6.283185307179586;
    off = vec3f(r * cos(ph), (ds.z - 0.5) * u.sizeY, r * sin(ph));
  } else if (shape == 4) {                        // ring: an annulus in the comp plane
    let th = ds.x * 6.283185307179586;
    let rr = u.ringRadius + (ds.y * 2.0 - 1.0) * u.ringThickness * 0.5;
    off = vec3f(cos(th) * rr, sin(th) * rr, (ds.z * 2.0 - 1.0) * u.ringThickness * 0.5);
    if (i32(u.dirMode) == 1) { axis = vec3f(cos(th), sin(th), 0.0); }
    else if (i32(u.dirMode) == 2) { axis = vec3f(-sin(th), cos(th), 0.0); }
  } else if (shape == 6 && u.tableCount >= 1.0) { // layer: the artwork's opaque pixels
    let site = (uid % u32(u.tableCount)) * 2u;
    off = vec3f(tablePos[site] * u.sizeX, tablePos[site + 1u] * u.sizeY,
      (rand(seed, uid, 3u) - 0.5) * u.sizeZ);
  } else if (shape == 7 && u.pathN >= 2.0) {      // path: uniform along arc length
    let n = u32(u.pathN);
    let f = ds.x * f32(n - 1u);
    let i0 = u32(floor(f));
    let fr = f - floor(f);
    let o0 = i0 * 6u;
    let o1 = min(n - 1u, i0 + 1u) * 6u;
    let jr = min(u.sizeX, u.sizeY) * 0.02;
    off = vec3f(
      mix(pathS[o0], pathS[o1], fr) - u.posX + (ds.y * 2.0 - 1.0) * jr,
      mix(pathS[o0 + 1u], pathS[o1 + 1u], fr) - u.posY + (ds.z * 2.0 - 1.0) * jr,
      // z keeps its own stream: the ribbon's depth, not one of the three
      // coordinates the distribution places.
      srand(seed, uid, 4u) * u.sizeZ * 0.5);
    let tx = mix(pathS[o0 + 3u], pathS[o1 + 3u], fr);
    let ty = mix(pathS[o0 + 4u], pathS[o1 + 4u], fr);
    if (i32(u.dirMode) == 1) { axis = vec3f(-ty, tx, 0.0); }
    else if (i32(u.dirMode) == 2) { axis = vec3f(tx, ty, 0.0); }
  }
  // 'point' keeps its exact zero offset — a saved project's point emitter must
  // behave byte-identically to how it always has.

  let dir = spawnDirection(axis, u.spread, seed, uid);
  let sp = max(0.0, u.speed + srand(seed, uid, 13u) * u.speedRandom);
  let life = max(0.06, u.lifetime + srand(seed, uid, 14u) * u.lifetimeRandom);

  var p: Part;
  p.pos = vec4f(vec3f(u.posX, u.posY, u.posZ) + off, f32(uid));
  p.vel = vec4f(dir * sp, -1.0);
  p.aux = vec4f(u.t, life, 0.0, 0.0);
  parts[slot] = p;
}

/* ── integrate: forces and the position update ───────────────────────────── */

@compute @workgroup_size(64)
fn integrate(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let id = gid1(gid, nwg);
  if (id >= u32(u.cap)) { return; }
  var p = parts[id];
  if (p.pos.w < 0.5) { return; }

  var vel = p.vel.xyz;
  var pos = p.pos.xyz;
  // THE SAME ORDER gpuEngine.js applies them in: gravity, turbulence, vortex,
  // then drag, then the fluid. Reordering these changes the result — drag after
  // the forces damps them, drag before does not.
  vel += vec3f(u.gravX, u.gravY, u.gravZ) * u.dt;
  if (u.turbOn > 0.5) {
    // Per-particle decorrelation, so neighbours do not march in lockstep.
    let phase = f32(u32(p.pos.w + 0.5) % 97u) * 0.41;
    vel += turbulence(pos, phase) * u.turbStr * u.dt;
  }
  if (u.vortOn > 0.5) { vel += fieldAccel(pos) * u.dt; }
  if (u.drag > 0.0) { vel *= max(0.0, 1.0 - u.drag * u.dt); }

  // COUPLING. A particle in a fluid is dragged toward the local flow, not
  // pushed by it — the same relaxation the CPU solver uses:
  //     vel += (fieldVel - vel) * relax,   relax = 1 - exp(-force * 0.03 * dt)
  // A relaxation rather than an acceleration is what makes a particle settle
  // INTO the flow and travel with it; an added force would leave it forever
  // overshooting the medium it is supposed to be suspended in.
  if (u.fluidOn > 0.5) {
    let half3 = vec3f(u.boxX, u.boxY, u.boxZ) * 0.5;
    let uvw = pos / (half3 * 2.0) + vec3f(0.5);
    if (all(uvw >= vec3f(0.0)) && all(uvw <= vec3f(1.0))) {
      let fv = textureSampleLevel(fieldVel, fieldSamp, uvw, 0.0).xyz;
      vel += (fv - vel) * u.relax;
    }
  }

  pos += vel * u.dt;

  let half = vec3f(u.boxX, u.boxY, u.boxZ) * 0.5;
  let mode = i32(u.boundsMode);
  if (mode == 1) {                                   // wrap
    for (var a = 0; a < 3; a = a + 1) {
      if (pos[a] > half[a]) { pos[a] -= half[a] * 2.0; }
      else if (pos[a] < -half[a]) { pos[a] += half[a] * 2.0; }
    }
  } else if (mode == 2) {                            // bounce
    // REFLECT, do not clamp. Clamping to the wall leaves a particle sitting on
    // it with its velocity reversed but its position frozen at the boundary,
    // which reads as a film of particles stuck to the edges of the box. The bake
    // reflects the overshoot back inside (solver.js), so the particle turns
    // around and keeps moving.
    for (var a = 0; a < 3; a = a + 1) {
      if (pos[a] > half[a]) { pos[a] = half[a] - (pos[a] - half[a]); vel[a] = -vel[a] * u.restitution; }
      else if (pos[a] < -half[a]) { pos[a] = -half[a] + (-half[a] - pos[a]); vel[a] = -vel[a] * u.restitution; }
    }
  } else {                                           // kill — mode 0
    /*
     * KILL AT THE BOUNDS WAS NEVER IMPLEMENTED HERE, and it is the DEFAULT
     * behaviour of the Solver Box.
     *
     * Only wrap and bounce had branches, so on this engine a particle that left
     * the box simply carried on and went on being drawn. The bake removes it —
     * its own readout says so, "6,661 at bounds" — and the result was that Live
     * and Baked showed visibly different pictures of the same system: Live
     * spread past the edges of frame, Baked stayed inside its box. That is not a
     * tolerance between two solvers, it is one of them ignoring the setting.
     *
     * Freeing the slot here is the same move the reap pass makes for a particle
     * that dies of old age: clear the alive flag and push the slot back to the
     * free list so this step's births can use it.
     *
     * NO BACKTICKS IN HERE — this whole shader is a template literal, and one
     * would end it mid-comment. That is what happened writing this very note.
     */
    if (pos.x > half.x || pos.x < -half.x
      || pos.y > half.y || pos.y < -half.y
      || pos.z > half.z || pos.z < -half.z) {
      parts[id].pos.w = 0.0;
      let at = atomicAdd(&freeCount[0], 1u);
      if (at < u32(u.cap)) { freeSlots[at] = id; }
      return;
    }
  }

  parts[id].pos = vec4f(pos, p.pos.w);
  parts[id].vel = vec4f(vel, p.vel.w);
}
`;
