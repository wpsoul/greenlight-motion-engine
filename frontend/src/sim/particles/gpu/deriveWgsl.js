/*
 * The DERIVE pass — Phase 1 of PLANS/VIDEO_EDITOR_PARTICLE_GPU_SCALE_PLAN.md.
 *
 * This is what removes the CPU instance fill. `fillInstances` in
 * particleLayer.js walks every living particle each frame and writes ~20 floats
 * per particle into five instanced attribute banks; at a million particles that
 * loop alone costs more than the whole frame budget. Every line of it is a pure
 * function of the pool, the clock and the seed, so it moves here.
 *
 * THE POOL IT READS. Tier 2 defines its own layout — 12 floats, three vec4s:
 *   pos  xyz = position   w = uid (0 = dead slot)
 *   vel  xyz = velocity   w = near-index
 *   aux  x = birthTime    y = life    z = releaseAt    w = spare
 *
 * `birthTime`, not `age`, and that is the point of the extra vec4: age is
 * `t - birthTime` against a uniform the pass already has, so nothing writes it
 * per step and the O(N) JavaScript ageing loop in gpuEngine's `cpuStep()`
 * disappears without being replaced by a GPU one.
 *
 * RANDOMS ARE NOT STORED. Size jitter, twinkle phase and the preview-subset
 * test are pure functions of (seed, uid), computed identically on the CPU today
 * (rnd(seed, u, 21), rnd(seed, u, 22), rnd(seed, u, 31)). `rand()` below is a
 * bit-exact port of rng.js — same avalanche, same stream mixing — because a
 * particle's own look has to be stable across preview, scrubbing, a range
 * render and the headless render, and a "close enough" hash makes it
 * machine-dependent instead.
 *
 * THE COUNT NEVER REACHES THE CPU. The atomic counter is lane 1 of a
 * draw-indirect argument buffer ([vertexCount, instanceCount, firstVertex,
 * firstInstance]), reset to [4, 0, 0, 0] before the pass and passed straight to
 * drawIndirect afterwards. No readback, no mapAsync, no stall — which was
 * problem #1 in the plan's audit.
 *
 * COMPACTION IS ATOMIC, SO OUTPUT ORDER IS NOT STABLE. Survivors claim an
 * output slot with atomicAdd, which is what makes the instance count a GPU
 * value the draw can read indirectly (Phase 3) instead of a CPU one. The cost
 * is that two frames may order the same particles differently, so THE DRAW MUST
 * BE ORDER-INDEPENDENT — additive, or the weighted-blended OIT the plan
 * specifies for alpha. It must never be paired with a back-to-front sort.
 *
 * WHAT TIER 2 DELIBERATELY DOES NOT DERIVE:
 *   * object mode (facing, spin, tumble squash) — capped at 260 particles by
 *     OBJECT_DENSITY_CAP, so it never needs Tier 2 and stays on Tier 1;
 *   * Grow Points — already bake-only, refused by liveCapability;
 *   * colour-at-birth from a video source — a CPU cache keyed by uid, Tier 1.
 * Each falls back rather than being half-implemented here.
 */

/** Floats per pool slot. Three vec4s — declared in layout.js, see its header. */
export { PART_FLOATS, PART_BYTES } from './layout.js';

/** Uniform block for the derive pass, in floats. */
export const DERIVE_U_FLOATS = 24;
export const DERIVE_U_BYTES = DERIVE_U_FLOATS * 4;

/** Lane order of the derive uniform block — mirrored by the JS packer. */
export const DERIVE_KEYS = [
  't', 'seed', 'cap', 'sizeRandom',
  'velMin', 'velSpan', 'byVelocity', 'killFade',
  'killScale', 'igniteFor', 'igniteBoost', 'holdOn',
  'previewFraction', 'colorFromTable', 'tableCount', 'growSites',
  'ttlAlive', 'spare0', 'spare1', 'spare2',
  'spare3', 'spare4', 'spare5', 'spare6',
];

export const DERIVE_WGSL = /* wgsl */ `
struct Part { pos: vec4f, vel: vec4f, aux: vec4f };
struct Inst { a: vec4f, b: vec4f, c: vec4f, d: vec4f };

struct U {
  t: f32, seed: f32, cap: f32, sizeRandom: f32,
  velMin: f32, velSpan: f32, byVelocity: f32, killFade: f32,
  killScale: f32, igniteFor: f32, igniteBoost: f32, holdOn: f32,
  previewFraction: f32, colorFromTable: f32, tableCount: f32, growSites: f32,
  ttlAlive: f32, _s0: f32, _s1: f32, _s2: f32,
  _s3: f32, _s4: f32, _s5: f32, _s6: f32,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> parts: array<Part>;
@group(0) @binding(2) var<storage, read_write> inst: array<Inst>;
@group(0) @binding(3) var<storage, read_write> drawArgs: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> tableColors: array<f32>;

/* ── rng.js, ported bit-exactly ───────────────────────────────────────────── */

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

/* A 2D dispatch, because a pool of millions exceeds the 65535-groups-per-
   dimension limit in one row. The row stride is derived from num_workgroups
   rather than hardcoded: a constant here has to agree with whatever the JS
   passed to dispatchWorkgroups, and when it does not, rows OVERLAP — the same
   slots are processed many times over and the atomic counter reports more
   particles than the pool contains. That failure is invisible below a million
   (one row) and silent above it. */
fn gid1(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 64u; }

@compute @workgroup_size(64)
fn derive(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let id = gid1(gid, nwg);
  if (id >= u32(u.cap)) { return; }

  let p = parts[id];
  let uidF = p.pos.w;
  if (uidF < 0.5) { return; }              // dead slot
  let uid = u32(uidF + 0.5);
  let seed = bitcast<u32>(i32(u.seed));

  // Deterministic preview subset: a stable hash of the uid, never a shuffle, so
  // reducing density thins the system without reshuffling which particles exist.
  if (u.previewFraction < 1.0 && rand(seed, uid, 31u) >= u.previewFraction) { return; }

  let birth = p.aux.x;
  let life = max(p.aux.y, 1e-4);
  let age = max(0.0, u.t - birth);
  if (age >= life) { return; }

  // Claim a slot. See the header: this is what makes the count a GPU value, and
  // why the draw must be order-independent.
  //
  // The counter IS the indirect draw-args buffer, at its instanceCount lane —
  // so the number of particles drawn never reaches the CPU at all. The buffer is
  // reset to [6, 0, 0, 0] before each derive and handed straight to drawIndirect.
  let slot = atomicAdd(&drawArgs[1], 1u);
  if (slot >= arrayLength(&inst)) {
    atomicSub(&drawArgs[1], 1u);   // never report more instances than exist
    return;
  }

  var o: Inst;

  // a: position, speedT
  var speedT = 0.0;
  if (u.byVelocity > 0.5) {
    let sp = length(p.vel.xyz);
    speedT = clamp((sp - u.velMin) / max(u.velSpan, 1e-3), 0.0, 1.0);
  }
  o.a = vec4f(p.pos.xyz, speedT);

  // b: age, life, size jitter, twinkle phase
  o.b = vec4f(age, life,
    1.0 + (rand(seed, uid, 21u) * 2.0 - 1.0) * u.sizeRandom,
    rand(seed, uid, 22u) * 6.283185);

  // 'leaving' is 1 while the particle has a future, ramping to 0 as it is
  // removed. Tier 1 reads a baked ttl that can anticipate a bounds kill; a live
  // engine cannot see one coming, so this is life-based — the one deliberate
  // difference, noted in the plan.
  var leaving = 1.0;
  if (u.killFade > 0.0) {
    let ttl = life - age;
    if (ttl < u.ttlAlive) { leaving = min(1.0, ttl / u.killFade); }
  }
  let kScale = select(1.0, 1.0 - u.killScale * (1.0 - leaving), u.killScale > 0.0);

  // c: velocity, kill scale
  o.c = vec4f(p.vel.xyz, kScale);

  // d: emitted colour, kill alpha
  var col = vec3f(0.0);
  if (u.colorFromTable > 0.5 && u.tableCount >= 1.0) {
    // THE SITE INDEX MUST BE THE ONE THE BAKE USED. Rate/burst emission recycles
    // slots, so the site is uid % count; Grow Points makes slot i site i
    // (uid = i + 1). Off by one here and every particle wears an unrelated
    // pixel's colour — the picture comes apart into confetti.
    let count = u32(u.tableCount);
    let idx = select(uid, uid - 1u, u.growSites > 0.5);
    let site = (idx % count) * 3u;
    col = vec3f(tableColors[site], tableColors[site + 1u], tableColors[site + 2u]) / 255.0;
  }
  o.d = vec4f(col, leaving);

  inst[slot] = o;
}
`;
