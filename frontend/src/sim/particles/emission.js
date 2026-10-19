// Emission — where and how particles are born. Shared by the CPU bake
// (solver.js) and the live GPU engine (gpuEngine.js), so the two cannot drift
// on shapes, direction modes, container clipping or the seeded random streams.
//
// A leaf module: no DOM, no three.js. Everything it touches is handed in as a
// context — the pool's typed arrays, the emitter, the seed, the tables.

import { rnd, srnd } from './rng.js';
import { prepareDistribution, distributionSample } from './distribution.js';
import { PATH_N, insideCollider } from './fluid.js';
import { fieldAccel } from './fields.js';
import { vortexPointAccel } from './fluid.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** A rows tracer lives for the whole clip: its line must never lose a point. */
export const ROWS_LIFE = 1e9;

/**
 * Where grid site `site` of a rows emitter sits, relative to the emitter centre.
 * Row 0 is the TOP row (+y up), point 0 the left end; a single row sits on the
 * centre line. The renderer uses the same mapping to rebuild each row from the
 * particles, so the two can never disagree about which point is which.
 */
export function rowsSiteOffset(out, em, site) {
  const R = Math.max(1, em.rows.count | 0), P = Math.max(2, em.rows.points | 0);
  const r = Math.floor(site / P), c = site - r * P;
  out[0] = (c / (P - 1) - 0.5) * em.size.x;
  out[1] = R > 1 ? (0.5 - r / (R - 1)) * em.size.y : 0;
  out[2] = 0;
  return out;
}

/**
 * Sample a direction inside a cone of `spreadDeg` around `dir` (180° = full sphere).
 * Writes into `out` (length 3).
 */
export function spawnDirection(out, dir, spreadDeg, seed, uid) {
  let dx = dir.x, dy = dir.y, dz = dir.z;
  const dl = Math.hypot(dx, dy, dz) || 1;
  dx /= dl; dy /= dl; dz /= dl;

  const cosMax = Math.cos(clamp(spreadDeg, 0, 180) * (Math.PI / 180));
  const cosT = lerp(cosMax, 1, rnd(seed, uid, 11));
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = rnd(seed, uid, 12) * Math.PI * 2;

  // Orthonormal basis around the axis.
  let ux, uy, uz;
  if (Math.abs(dy) < 0.99) { ux = dz; uy = 0; uz = -dx; } else { ux = 1; uy = 0; uz = 0; }
  const bl = Math.hypot(ux, uy, uz) || 1;
  ux /= bl; uy /= bl; uz /= bl;
  const vx = dy * uz - dz * uy;
  const vy = dz * ux - dx * uz;
  const vz = dx * uy - dy * ux;

  const cp = Math.cos(phi), sp = Math.sin(phi);
  out[0] = dx * cosT + (ux * cp + vx * sp) * sinT;
  out[1] = dy * cosT + (uy * cp + vy * sp) * sinT;
  out[2] = dz * cosT + (uz * cp + vz * sp) * sinT;
}

/**
 * Create the emitter for one pool.
 *
 *   ctx.arrays   { px, py, pz, vx, vy, vz, age, life, uid, near }
 *   ctx.S        counters, shared with the caller: { nextUid, cursor, aliveCount, dropped }
 *   ctx.em       the emitter config (system.emitters[0])
 *   ctx.seed, ctx.maxP
 *   ctx.spawnTable, ctx.colliderTable, ctx.collMode (0/1/2), ctx.collHalfD, ctx.emitPathS
 *   ctx.onSpawn(i, uid)   optional, called for every particle born
 *
 * `spawn(n)` births up to n particles (throttled at the cap — never recycling a
 * live slot) and records up to 24 of the slots in `sites` for the field's
 * splats; the caller clears `sites` each step.
 */
export function createEmission(ctx) {
  const { px, py, pz, vx, vy, vz, age, life, uid, near } = ctx.arrays;
  const { S, em, seed, maxP, spawnTable, colliderTable, collMode, collHalfD, emitPathS, onSpawn } = ctx;
  /*
   * PACKING: emission must refuse to spawn into occupied space.
   *
   * Not a polish item. With particle-to-particle collision on and no such check,
   * a fast nozzle stacks a frame's worth of grains on one point — 43 of them in
   * the lab — and the solver answers the resulting deep overlap with a
   * 10,000 px/s ejection. Measured here through a real bake: an over-filled jar
   * came out with pairs at 200% overlap, which is two beads at the same point.
   *
   * `spawnBlocked(x, y, z, uid)` is supplied only when packing is on. A birth
   * that cannot find room after `tries` attempts is REFUSED rather than placed,
   * so the rate self-throttles to what physically fits — which is the correct
   * behaviour and worth saying in the panel rather than hiding.
   */
  const spawnBlocked = ctx.spawnBlocked || null;
  /*
   * The container test, overridable. A FOLLOWED collider's field is in the
   * artwork's local space and only the solver knows where that artwork is this
   * step, so it hands the test in rather than this module reaching for a
   * box-space table that would be the wrong shape.
   */
  const insideTest = ctx.insideContainer
    || ((x, y, z) => insideCollider(colliderTable, collHalfD, x, y, z));
  const sites = [];
  const dir = [0, 0, 0];
  /*
   * WHERE inside the shape a particle is born. `dist` turns (uid, retry) into a
   * point in the unit cube and each shape branch below maps it exactly as it
   * always did — see distribution.js for why that one substitution is the whole
   * feature. Under mode 'random' the sampler returns the same
   * rnd(seed, uid, 1..3) values this code used to call inline, retry streams
   * included, so a saved system bakes byte-identically.
   *
   * `distPool` is what "auto sites" resolves to, and it is deliberately NOT
   * `maxP`. The bake shrinks its pool to what the emitter can actually reach
   * (reachableParticles), the live engine does not, and the stir-site provider
   * in gpu/manager.js runs this module against a throwaway 24-slot pool — three
   * different numbers for the same system. Auto sites has to come from the
   * SETTING every runtime shares, `solver.maxParticles`, or the same emitter
   * gets a different lattice depending on which engine drew it.
   */
  const dist = prepareDistribution(em, seed, ctx.distPool || maxP);
  const ds = [0, 0, 0];

  /** @returns {number} how many were actually placed. */
  function spawn(n) {
    let made = 0;
    for (let k = 0; k < n; k++) {
      // THE CAP THROTTLES EMISSION; it never overwrites a particle that is still
      // alive. Recycling the oldest slot (the obvious ring-buffer implementation)
      // silently caps every particle's real life at maxParticles/rate seconds no
      // matter what `lifetime` says — a long lifetime would just quietly not happen.
      if (S.aliveCount >= maxP) { S.dropped++; continue; }
      let i = -1;
      for (let s = 0; s < maxP; s++) {
        const j = S.cursor + s >= maxP ? S.cursor + s - maxP : S.cursor + s;
        if (!uid[j]) { i = j; S.cursor = j + 1 >= maxP ? 0 : j + 1; break; }
      }
      if (i < 0) { S.dropped++; continue; }

      const u = S.nextUid++;
      uid[i] = u;
      S.aliveCount++;

      // The launch direction's AXIS: the emitter's own, unless a ring or path
      // emitter asks for outward / tangent, which the shape decides per site.
      let ax = em.direction.x, ay = em.direction.y, az = em.direction.z;
      let ox = 0, oy = 0, oz = 0;
      // With an INNER-faces collider, emission is CLIPPED BY THE CONTAINER:
      // rejection-sample until the site lands inside. Deterministic — the retry
      // just shifts the rnd stream. A block over text fills the letterforms
      // instead of crusting onto their nearest edges.
      const tries = spawnBlocked ? 40 : (collMode === 2 ? 40 : 1);
      let placed = false;
      // Did ANY try land inside the container? The two rejections mean different
      // things and must not be collapsed — see the refusal below.
      let everInside = collMode !== 2;
      for (let tt = 0; tt < tries; tt++) {
        const cc = tt * 53;
        // The three unit-cube coordinates this birth is mapped from.
        distributionSample(ds, dist, u, tt);
        if (em.shape === 'box') {
          ox = (ds[0] - 0.5) * em.size.x;
          oy = (ds[1] - 0.5) * em.size.y;
          oz = (ds[2] - 0.5) * em.size.z;
        } else if (em.shape === 'sphere') {
          const r = Math.cbrt(ds[0]) * (em.size.x / 2);
          const ct = ds[1] * 2 - 1;
          const st = Math.sqrt(Math.max(0, 1 - ct * ct));
          const ph = ds[2] * Math.PI * 2;
          ox = r * st * Math.cos(ph); oy = r * ct; oz = r * st * Math.sin(ph);
        } else if (em.shape === 'layer' && spawnTable) {
          // Emit from a LAYER: the artwork's opaque pixels are the emission sites.
          // Indexed by uid so the renderer can look up the same site's COLOUR without
          // any of it travelling through the snapshot cache (see ensureSpawnTable).
          const site = ((u + tt) % spawnTable.count) * 2;
          ox = spawnTable.positions[site] * em.size.x;
          oy = spawnTable.positions[site + 1] * em.size.y;
          oz = (rnd(seed, u, 3 + cc) - 0.5) * em.size.z;
        } else if (em.shape === 'cone') {
          const r = Math.sqrt(ds[0]) * (em.size.x / 2);
          const ph = ds[1] * Math.PI * 2;
          ox = r * Math.cos(ph); oz = r * Math.sin(ph); oy = (ds[2] - 0.5) * em.size.y;
        } else if (em.shape === 'ring') {
          // RING: an annulus in the comp plane — radius ± thickness/2.
          const th = ds[0] * Math.PI * 2;
          const rr = em.ring.radius + (ds[1] * 2 - 1) * em.ring.thickness * 0.5;
          ox = Math.cos(th) * rr; oy = Math.sin(th) * rr;
          oz = (ds[2] * 2 - 1) * em.ring.thickness * 0.5;
          if (em.dirMode === 'outward') { ax = Math.cos(th); ay = Math.sin(th); az = 0; }
          else if (em.dirMode === 'tangent') { ax = -Math.sin(th); ay = Math.cos(th); az = 0; }
        } else if (em.shape === 'path' && emitPathS) {
          // PATH: uniform along arc length (the samples ARE even arc length).
          const f = ds[0] * (PATH_N - 1);
          const i0 = Math.floor(f), fr = f - i0, o0 = i0 * 6, o1 = Math.min(PATH_N - 1, i0 + 1) * 6;
          const PS = emitPathS;
          const jr = Math.min(em.size.x, em.size.y) * 0.02;
          ox = lerp(PS[o0], PS[o1], fr) - em.position.x + (ds[1] * 2 - 1) * jr;
          oy = lerp(PS[o0 + 1], PS[o1 + 1], fr) - em.position.y + (ds[2] * 2 - 1) * jr;
          // z keeps its own stream: it is the ribbon's depth, not one of the
          // three coordinates the distribution places.
          oz = srnd(seed, u, 4 + cc) * em.size.z * 0.5;
          const tx = lerp(PS[o0 + 3], PS[o1 + 3], fr), ty = lerp(PS[o0 + 4], PS[o1 + 4], fr);
          if (em.dirMode === 'outward') { ax = -ty; ay = tx; az = 0; }
          else if (em.dirMode === 'tangent') { ax = tx; ay = ty; az = 0; }
        } else if (em.shape === 'rows') {
          // ROWS: uid u is grid site u − 1, so emission order IS the grid order
          // and every particle can be found again from its uid alone.
          const total = Math.max(1, em.rows.count | 0) * Math.max(2, em.rows.points | 0);
          rowsSiteOffset(ds, em, (u - 1) % total);
          ox = ds[0]; oy = ds[1]; oz = ds[2];
        } else if (em.shape === 'block') {
          // BLOCK: a filled slab — the "layer of particles" source.
          ox = (ds[0] - 0.5) * em.size.x;
          oy = (ds[1] - 0.5) * em.size.y;
          oz = (ds[2] - 0.5) * em.size.z;
        }
        // ('point' keeps its exact zero offset — a saved project's point emitter
        // must bake byte-identically to how it always has.)
        const wx = em.position.x + ox, wy = em.position.y + oy, wz = em.position.z + oz;
        if (collMode === 2 && !insideTest(wx, wy, wz)) continue;
        everInside = true;
        if (spawnBlocked && spawnBlocked(wx, wy, wz, u)) continue;
        placed = true;
        break;
      }
      /*
       * REFUSE ONLY WHAT PACKING REFUSED.
       *
       * "Outside the container" and "there is no room" are different failures.
       * The container's rejection has always fallen through and placed the
       * particle anyway, letting the collider pull it inside on the first step —
       * that is the shipped behaviour of an inner-faces collider and packing has
       * no business changing it. Refusing both collapsed them, and an emitter
       * that sat outside its container emitted NOTHING instead of being pulled
       * in: measured as an empty frame on a text container.
       *
       * So: a birth is refused only when the emitter did find room inside the
       * container and every such point was already occupied. That is the
       * self-throttle, and it is the only case where dropping the slot is right.
       */
      if (!placed && spawnBlocked && everInside) {
        uid[i] = 0;
        S.aliveCount--;
        /*
         * BLOCKED IS NOT DROPPED, and deliberately does not count as one.
         * `dropped` is the number of particles this system LOST; a blocked birth
         * is retried and usually lands, so counting it there turned a stat the
         * panel shows into the number of rejection samples taken — 24,000 for a
         * burst that ended up placing every one of its 900. A particle refused for want of room may fit
         * later — the mould drains, a side opens, a collider leaves — so this is
         * counted separately from a slot that was refused because the pool is
         * full. The caller retries what was blocked; see the burst remainder in
         * solver.js.
         */
        S.blocked++;
        continue;
      }
      px[i] = em.position.x + ox;
      py[i] = em.position.y + oy;
      pz[i] = em.position.z + oz;

      if (em.shape === 'rows') {
        // Tracers: born at rest, never die of age — only forces move a line.
        vx[i] = 0; vy[i] = 0; vz[i] = 0;
        life[i] = ROWS_LIFE;
      } else {
        spawnDirection(dir, { x: ax, y: ay, z: az }, em.spread, seed, u);
        const sp = Math.max(0, em.speed.value + srnd(seed, u, 13) * em.speed.random);
        vx[i] = dir[0] * sp; vy[i] = dir[1] * sp; vz[i] = dir[2] * sp;
        life[i] = Math.max(0.06, em.lifetime.value + srnd(seed, u, 14) * em.lifetime.random);
      }
      age[i] = 0;
      near[i] = -1;
      if (onSpawn) onSpawn(i, u);
      made++;
      if (sites.length < 24) sites.push(i);
    }
    return made;
  }

  return { spawn, sites };
}

/**
 * The splats one step pushes into the field: the jets (always), then either the
 * emitter's own stir (from actual spawn sites, with emission variance) or — when
 * detached — material only. `c` = { em, smoke, heat, jets, fePos, seed,
 * arrays: { px, py, pz, vx, vy, vz }, sites }; `s` is the step index (the
 * per-step random stream). Clears and fills `out`.
 */
export function fieldSplats(out, c, t, s) {
  const { em, smoke, heat, jets, smokers, fePos, seed, sites } = c;
  const { px, py, pz, vx, vy, vz } = c.arrays;
  const STEP_DT = 1 / 60;
  out.length = 0;
  const stir = em.stir || { strength: 0, radius: 100 };
  // Jets: splatted whenever the field is on, whatever the emitter does.
  for (let f = 0; f < jets.length; f++) {
    const fe = jets[f];
    const p0 = fePos(fe, f, Math.max(0, t - STEP_DT)), p1 = fePos(fe, f, t);
    let mvx = (p1[0] - p0[0]) / STEP_DT, mvy = (p1[1] - p0[1]) / STEP_DT;
    const mm = Math.hypot(mvx, mvy);
    if (mm > 2500) { mvx *= 2500 / mm; mvy *= 2500 / mm; }
    const a = fe.direction * (Math.PI / 180);
    out.push({ x: p1[0], y: p1[1], z: 0, r: fe.radius, tvx: Math.cos(a) * fe.push + mvx, tvy: Math.sin(a) * fe.push + mvy, tvz: 0, k: fe.strength / 100, den: 0, heat: 0 });
  }
  // SMOKE SOURCES: material at a point. This is what makes the fluid a local
  // effect rather than a property of the whole layer — the field still spans
  // the box (incompressible flow has to), but the smoke in it comes only from
  // the sources you place. Deposits density + heat, plus whatever push it has.
  if (smokers) {
    for (let m = 0; m < smokers.length; m++) {
      const fe = smokers[m];
      const p0 = fePos(fe, m, Math.max(0, t - STEP_DT)), p1 = fePos(fe, m, t);
      let mvx = (p1[0] - p0[0]) / STEP_DT, mvy = (p1[1] - p0[1]) / STEP_DT;
      const mm = Math.hypot(mvx, mvy);
      if (mm > 2500) { mvx *= 2500 / mm; mvy *= 2500 / mm; }
      const a = fe.direction * (Math.PI / 180);
      // A steady round source reads as a carpet; wobble it on smooth time
      // noise, the same trick emission variance uses.
      const dm = Math.max(0.25, 1 + 0.45 * Math.sin(t * 2.1 + m * 1.7) + 0.2 * Math.sin(t * 3.9 + m * 0.6));
      const den = (fe.density ?? 2.2) * dm;
      out.push({
        x: p1[0], y: p1[1], z: 0, r: fe.radius,
        tvx: Math.cos(a) * fe.push + mvx, tvy: Math.sin(a) * fe.push + mvy, tvz: 0,
        k: fe.strength / 100,
        den, heat: smoke ? ((fe.heat ?? 55) / 18) * dm : 0,
      });
    }
  }
  if (em.shape === 'rows') {
    // Rows are TRACERS: they ride the field and put nothing into it — no
    // momentum, no material. Smoke sources and jets above are what move them.
  } else if (em.detach) {
    // Detached: emission deposits MATERIAL where it spawns but carries no
    // momentum — the force emitters own the field's motion. The SAME amount
    // of material as attached emission (four splats, with the variance
    // wobble): detaching changes who moves the smoke, not how much there is.
    // It used to be one splat, so a detached cigarette was a quarter as dense.
    // Stir still says HOW MUCH material (detaching only gave away the
    // momentum), so Stir 0 is "this emitter makes no smoke" — which is what
    // leaves smoke sources as the only material in the layer.
    if (smoke && sites.length && stir.strength > 0.5) {
      const ev = em.variance || 0;
      for (let q = 0; q < Math.min(4, sites.length); q++) {
        const i = sites[Math.floor(rnd(seed, s + 1, 21 + q) * sites.length)];
        const dm = Math.max(0.2, 1 + ev * 0.5 * Math.sin(t * 2.3 + q * 1.7));
        out.push({ x: px[i], y: py[i], z: pz[i], r: stir.radius, tvx: 0, tvy: 0, tvz: 0, k: 0, den: 2.2 * dm, heat: (heat / 18) * dm });
      }
    }
  } else if (stir.strength > 0.5 && sites.length) {
    // Emission stirs the field: up to 4 splats per step, taken FROM actual
    // spawn positions so ring and path emitters stir where they emit.
    const k = stir.strength / 100;
    const denAmt = smoke ? 2.2 : 0.9;
    const heatAmt = smoke ? heat / 18 : 0;
    const ev = em.variance || 0;
    for (let q = 0; q < Math.min(4, sites.length); q++) {
      const i = sites[Math.floor(rnd(seed, s + 1, 21 + q) * sites.length)];
      // EMISSION VARIANCE: a perfectly steady round source feeds no structure
      // at plume scale — only confinement's cell-scale curls survive, and the
      // plume reads as a uniform carpet. Wobbling each splat's direction,
      // strength and heat on smooth TIME noise makes puffs and thermals
      // whose billows cascade downscale. Deterministic in t.
      const g1 = Math.sin(t * 1.9 + q * 2.1) + 0.5 * Math.sin(t * 3.7 + q * 0.9);
      const rot = ev * 0.5 * g1;
      const mag = 1 + ev * 0.4 * Math.sin(t * 2.7 + q * 1.3);
      const dm = Math.max(0.2, 1 + ev * 0.5 * Math.sin(t * 2.3 + q * 1.7));
      const ca = Math.cos(rot), sa = Math.sin(rot);
      const svx = vx[i] * mag, svy = vy[i] * mag;
      out.push({ x: px[i], y: py[i], z: pz[i], r: stir.radius, tvx: svx * ca - svy * sa, tvy: svx * sa + svy * ca, tvz: vz[i], k, den: denAmt * dm, heat: heatAmt * dm });
    }
  }
}

/**
 * A force emitter's pull at a point, in whichever of GLOBAL FORCE's shapes it
 * is set to — the same `fieldAccel` maths, centred on the emitter instead of on
 * the box. `vortex` keeps its own rigid-core profile (zero at the eye, peak at
 * the radius) so systems saved before modes existed are untouched.
 * Writes into `out` (length 3).
 */
export function forcePointAccel(out, fe, cx, cy, x, y, z = 0) {
  const mode = fe.mode || 'vortex';
  const rot = mode === 'vortex' || mode === 'orbit' || mode === 'twist';
  const amp = fe.strength * 1.2 * (rot && fe.spin === 'cw' ? -1 : 1);
  if (mode === 'vortex') {
    vortexPointAccel(out, cx, cy, fe.radius, amp, x, y);
    return out;
  }
  fieldAccel(out, { mode, axis: 'z', scale: Math.max(1, fe.radius), strength: amp, lift: fe.lift ?? 0.5 }, x - cx, y - cy, z);
  return out;
}

/** How long one impulse takes — a shove, not a teleport. */
export const BURST_WINDOW = 0.12;

/**
 * A burst's strength right now, 0..1, as a half-sine over its window: 0 before
 * its first impulse, rising and falling through each one, 0 between them.
 * `pulseEvery` 0 means it fires once and is done.
 */
export function burstEnvelope(fe, t) {
  const start = fe.pulseStart ?? 0;
  const every = fe.pulseEvery ?? 0;
  if (t < start - 1e-6) return 0;
  let phase = t - start;
  if (every > 0.01) phase %= every;
  else if (phase > BURST_WINDOW) return 0;
  if (phase > BURST_WINDOW) return 0;
  return Math.sin(Math.PI * (phase / BURST_WINDOW));
}

/**
 * The outward kick a burst gives at a point: an acceleration whose integral
 * over one impulse is `push` × falloff, so Push speed reads as "how fast this
 * throws what it catches". Written into `out` (length 2); zero outside.
 */
export function burstAccel(out, cx, cy, radius, push, env, x, y) {
  out[0] = 0; out[1] = 0;
  if (env <= 0 || push <= 0) return out;
  const r = Math.max(1, radius);
  const dx = x - cx, dy = y - cy;
  const d = Math.hypot(dx, dy) + 1e-4;
  const q = d / r;
  const fall = Math.exp(-q * q);
  const a = push * fall * env * (Math.PI / 2) / BURST_WINDOW;
  out[0] = (dx / d) * a;
  out[1] = (dy / d) * a;
  return out;
}

/**
 * Force emitters, split by kind. Jets only exist to the FIELD (no field, no
 * jet); vortices act on the field when there is one and on the particles
 * directly when there is not. `feAmp` is the signed rotation (spin), `fePos`
 * the emitter's position at time t under its motion (static / orbit / sweep).
 */
export function forceEmitterSetup(system, fluidOn) {
  // A smoke SOURCE earns its place with material, not with push — so it is kept
  // even at strength 0 (a puff that only deposits, lifted by buoyancy).
  const FE = Array.isArray(system.forceEmitters)
    ? system.forceEmitters.filter((f) => f.strength > 0
      || (f.kind === 'smoke' && (f.density ?? 0) > 0)
      // A pulse's force is its blast speed; Strength means nothing to it.
      || (f.kind === 'burst' && (f.push ?? 0) > 0))
    : [];
  const jets = fluidOn ? FE.filter((f) => f.kind === 'jet' || f.kind === 'burst') : [];
  const vortices = FE.filter((f) => f.kind === 'vortex');
  // LAYER VELOCITY sources. They carry no position of their own — the layer
  // they follow is where they are — so they are kept apart from everything that
  // reads `position`, and the solver drives them off the sampled track instead
  // (layerDrive.js). Order here IS the order of rows in that table.
  const drivers = FE.filter((f) => f.kind === 'layer');
  // Sources inject into the FIELD, so they exist only when there is one.
  const smokers = fluidOn ? FE.filter((f) => f.kind === 'smoke') : [];
  // Blowers act on the particles directly when there is no field (see
  // jetPointPush); `jets` above is the splat list, empty without a field.
  const pushers = FE.filter((f) => f.kind === 'jet');
  const feAmp = (fe) => fe.strength * 1.2 * (fe.spin === 'cw' ? -1 : 1);
  const fePos = (fe, idx, t) => {
    const w = t * fe.motionSpeed * Math.PI * 0.5 + idx * 2.09, r = fe.motionRadius;
    if (fe.motion === 'orbit') return [fe.position.x + Math.cos(w) * r, fe.position.y + Math.sin(w) * r];
    if (fe.motion === 'sweep') return [fe.position.x + Math.sin(w) * r, fe.position.y];
    return [fe.position.x, fe.position.y];
  };
  // Every force emitter is also an influence POINT: with fluid.reach = 'sources'
  // a particle only rides the flow near one of these, so the field drives what
  // is close to a source instead of the whole box. Layer sources are excluded:
  // their `position` is a placeholder, so using it would put the coupling
  // gaussian at the box centre rather than on the moving layer.
  const influences = FE.filter((f) => f.kind !== 'layer');
  // Pulse forces: a radial shove at a point, at its own times. Deliberately NOT
  // called `bursts` — engineConfig spreads this object over one that already has
  // the EMITTER's bursts, and the collision silently emptied them (static
  // emission stopped spawning on the live preview).
  const blasts = FE.filter((f) => f.kind === 'burst');
  return { jets, smokers, pushers, vortices, blasts, drivers, influences, feAmp, fePos };
}
