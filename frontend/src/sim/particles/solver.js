// Particle solver — fixed step, seeded, baked to a snapshot cache.
//
// THE RULE THIS FILE EXISTS FOR
// -----------------------------
//     BAKE ONCE (fixed 1/60 s)  ->  SAMPLE ANY TIME
//
// The simulation never advances from a requestAnimationFrame delta. The editor can
// seek backwards, jump to an arbitrary time, render only a range, and ask for
// non-monotonic sub-frame samples during export motion blur; a delta-driven
// simulation would disagree between preview, Download and /video-render. So the
// whole clip is simulated forward once into a cache, and every draw is a read.
//
// No DOM, no React, no three.js in here — it is a pure function of its config, and
// that is what makes it testable and (later) movable into a worker.

import { rnd, srnd } from './rng.js';
import { turbulenceAccel, fieldAccel } from './fields.js';
import { createEmission, spawnDirection, fieldSplats, forceEmitterSetup, burstEnvelope, burstAccel, forcePointAccel } from './emission.js';
import { applyLayerDrives, layerDriveSplats } from './layerDrive.js';
import {
  proxInfluence, proxPosesAtStep, proxMotionAmounts, proxNeedsNormal, proxParamsAtStep,
  resolveCollisionPosed, insideCollisionPosed, makeProxPose, PROX_POSE_STRIDE,
} from './proximity.js';
import {
  createPacking, packingStep, setRadii, markWall, occupied, reindexOccupancy,
  bindShapeAngles, setShapeBodies, shapeWallPush, occupiedShape, SHAPE_BIRTH_K,
} from './packing.js';
import { objectPickTable, objectMemberOf, clumpsOverlap } from './shapes.js';
import { collidersOf, particleRowsTotal } from './schema.js';
import {
  makeFluidGrid, fluidStep, fluidVelocityAt, resamplePath, pathFollowStep,
  gridInkMask, resolveCollision, insideCollider, PATH_N, collisionOpenAmount,
  vortexPointAccel, jetPointPush,
} from './fluid.js';

/** Simulation step. Fixed: emission and motion must not depend on output fps. */
export const STEP_DT = 1 / 60;

/**
 * Floats per particle slot in a snapshot: x, y, z, age, ttl.
 *
 * `ttl` is the time left before this particle is REMOVED, for any reason — its
 * lifetime running out, or a Solver Box wall taking it. A forward simulation
 * cannot know that; a BAKED one can, because the whole clip already exists by the
 * time anything is drawn. It is what lets a particle start fading or shrinking
 * before it goes, instead of blinking out mid-flight. Survivors carry TTL_ALIVE.
 *
 * WHAT IS NOT HERE, AND WHY. `life` and `release` are constant for a particle's
 * whole life, and storing them in every snapshot cost two floats per slot per
 * thirtieth of a second — 29% of the whole cache — to repeat a number that never
 * changed. They live in per-UID tables instead (one float per particle EVER
 * spawned, a few hundred KB for a busy clip), which is what makes a six-figure
 * particle count affordable at all.
 */
export const STRIDE = 5;

/**
 * Floats per particle in a SAMPLE (what sampleParticles writes, not what the cache
 * stores): x, y, z, age, life, vx, vy, vz, ttl, release. Exported so no caller has
 * to hard-code it — the last time this number changed, three consumers silently
 * read the wrong floats.
 */
export const SAMPLE_STRIDE = 10;

/** ttl for a particle that outlives the clip — nothing is coming for it. */
export const TTL_ALIVE = 1e9;

/** Snapshots per progressive chunk: half a second of clip at 30 Hz. */
export const CHUNK_SNAPS = 15;

/**
 * Snapshots are SLOT-ALIGNED rather than compacted: slot i in snapshot A and slot i
 * in snapshot B are the same particle if and only if their uids match. That makes
 * interpolation an index lookup instead of a per-frame id map, which is the whole
 * reason sampling is cheap enough to do twice per frame under motion blur.
 * A dead slot has uid 0.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Simulate `system` over [-preRoll, duration] and return the snapshot cache.
 *
 * Coordinates are composition pixels in the 3D pass's space (+x right, +y UP,
 * +z toward the viewer), local to the Solver Box — V1 simulates in local space, so
 * moving the layer moves the box and everything in it.
 */
/**
 * How many particles this emitter can have ALIVE AT ONCE — the size the pool
 * actually needs, rather than the ceiling the user typed.
 *
 * MAX PARTICLES IS A CEILING, NOT A REQUEST. Every array here is sized to it and
 * every step loops over it, so a system emitting 300 a second with a 3 second
 * lifetime — 900 alive, ever — paid for a hundred thousand slots the moment
 * someone raised the number "in case". The snapshot cache is the worst of it:
 * `snapCount x maxP x STRIDE` floats, hundreds of megabytes for a pool that is
 * more than 99% empty in every frame. That is the whole of "I set Max particles
 * to a million and the editor crawls even though there are a thousand on
 * screen": the crawl is this allocation and this loop, not the particles.
 *
 * The bound is exact rather than a guess. Only particles born in the last
 * `maxLife` seconds can still be alive, so rate emission can never hold more
 * than `rate x maxLife`; pulses are bounded by their own total, since at worst
 * every one of them fired inside that same window. Lifetime randomness is
 * `value + srnd x random` with srnd in [-1, 1], so the longest possible life is
 * `value + random` — the sum, not the mean. The margin on top is for the
 * accumulator's rounding, not for the bound.
 *
 * STATIC emission is exempt: it fills the pool once by definition, so its count
 * IS the ceiling.
 */
export function reachableParticles(em, cap) {
  // A rows emitter places exactly its grid, once — the pool is the grid.
  if (em && em.shape === 'rows') return Math.max(1, particleRowsTotal(em));
  if (!em || em.emit === 'static') return Math.max(1, cap);
  const life = em.lifetime || {};
  const maxLife = Math.max(0.06, (life.value || 0) + Math.max(0, life.random || 0));
  const start = Math.max(0, em.start || 0);
  const end = Number.isFinite(em.end) ? em.end : Infinity;
  // A rate that stops before a lifetime has passed cannot reach the steady state.
  const emitFor = Math.max(0, end - start) + STEP_DT;
  const fromRate = Math.max(0, em.rate || 0) * Math.min(maxLife, emitFor);
  let fromBursts = 0;
  for (const b of em.bursts || []) fromBursts += Math.max(0, b.count || 0);
  const need = Math.ceil((fromRate + fromBursts) * 1.15) + 16;
  return Math.max(1, Math.min(cap, need));
}

export function bakeParticles(system, duration, spawnTable = null, colliderTable = null, opts = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);

  const solver = system.solver;
  const em0 = system.emitters[0];
  const A = system.activation || null;

  // PARTICLE ACTIVATION — "Grow Points".
  //
  // Only a `layer` emitter can grow: the front travels through ARTWORK, and a box
  // has none. With it on, emission stops being a rate and becomes a schedule —
  // site i is born (or released) at the instant the front reaches it — so the
  // cap is the number of sites, and every slot belongs to one site for the whole
  // clip. That one-to-one mapping is what lets the renderer look a particle's
  // release time up without knowing anything about the field.
  const growOn = !!(A && A.mode === 'grow' && em0.shape === 'layer'
    && spawnTable && spawnTable.arrival && spawnTable.arrival.length);
  const frozen = growOn && A.inactive === 'frozen';

  const maxP = growOn
    ? Math.max(1, Math.min(Math.round(solver.maxParticles), spawnTable.count))
    : reachableParticles(em0, Math.max(1, Math.round(solver.maxParticles)));
  const cacheHz = solver.cacheHz;
  // A grown clip has nothing to pre-roll: the front starts at t = 0 by
  // definition, and simulating before it would just run particles that the front
  // has not reached yet.
  const preRoll = growOn ? 0 : Math.max(0, solver.preRoll);
  const dur = Math.max(0.1, duration);
  const snapCount = Math.floor(dur * cacheHz) + 2;

  const px = new Float32Array(maxP), py = new Float32Array(maxP), pz = new Float32Array(maxP);
  const vx = new Float32Array(maxP), vy = new Float32Array(maxP), vz = new Float32Array(maxP);
  const age = new Float32Array(maxP), life = new Float32Array(maxP);
  const release = new Float32Array(maxP);
  const launched = new Uint8Array(maxP);
  const uid = new Int32Array(maxP);

  const data = new Float32Array(snapCount * maxP * STRIDE);
  const uids = new Int32Array(snapCount * maxP);
  // Shape mode's per-snapshot angle (packing.shape 'object'). Allocated below,
  // once the mode is known; null for every other system, which is what keeps the
  // cache format and its size exactly what they were.
  let shRot = null;

  // Per-UID constants, indexed by particle id rather than by slot-and-snapshot.
  // One float each per particle EVER spawned, grown by doubling — a busy six
  // second clip spawns a few tens of thousands, so this is a few hundred KB
  // against the tens of MB it takes out of the snapshot cache.
  let lifeOf = new Float32Array(Math.max(1024, maxP + 1));
  let releaseOf = new Float32Array(lifeOf.length);
  const noteConstants = (u, lifeSec, releaseSec) => {
    if (u >= lifeOf.length) {
      const grown = new Float32Array(Math.max(u + 1, lifeOf.length * 2));
      grown.set(lifeOf); lifeOf = grown;
      const grownR = new Float32Array(grown.length);
      grownR.set(releaseOf); releaseOf = grownR;
    }
    lifeOf[u] = lifeSec;
    releaseOf[u] = releaseSec;
  };

  const em = system.emitters[0];
  const F = system.forces;
  const bx = solver.bounds.size.x / 2, by = solver.bounds.size.y / 2, bz = solver.bounds.size.z / 2;
  const wrap = solver.bounds.behavior === 'wrap';
  const bounce = solver.bounds.behavior === 'bounce';
  // How much speed survives a wall. Not a user control yet: 0.6 is the value that
  // reads as "solid but not rubber" across the presets, and a second slider for it
  // buys less than it costs in panel space.
  const RESTITUTION = 0.6;
  const seed = system.seed | 0;
  const turbOn = F.turbulence.strength > 0.01;
  const vortOn = F.vortex.strength > 0.01;
  const tmp = [0, 0, 0], dir = [0, 0, 0];

  /*
   * RETURN (forces.return) — after a particle moves, close 1 − e^(−k·dt) of the
   * gap back to where it was born. Positional and velocity-free on purpose: the
   * particle keeps riding whatever pushes it, so in a flow of speed v it settles
   * about v / k from home instead of springing past it. The birth point is
   * recorded at spawn; the arrays exist only while the force is on, so a system
   * without it pays one null check per particle.
   */
  const retK = F.return && F.return.strength > 0 ? 1 - Math.exp(-F.return.strength * STEP_DT) : 0;
  const homeX = retK ? new Float32Array(maxP) : null;
  const homeY = retK ? new Float32Array(maxP) : null;
  const homeZ = retK ? new Float32Array(maxP) : null;
  const noteHome = (i) => { if (homeX) { homeX[i] = px[i]; homeY[i] = py[i]; homeZ[i] = pz[i]; } };

  // ── THE FLUID FIELD (v3) ────────────────────────────────────────────────
  // A grid the size of the box, stepped with the particles. It is bake STATE,
  // not cache: only the particle snapshots are kept, so a fluid system costs
  // the cache nothing extra — it costs bake time (see fluid.js for the passes).
  const FL = F.fluid || { model: 'off' };
  const fluidOn = FL.model !== 'off';
  const smoke = FL.model === 'smoke';
  const G = fluidOn ? makeFluidGrid(FL.fidelity, solver.bounds.size) : null;
  const fluidCfg = fluidOn ? {
    smoke,
    buoyancy: FL.smoke.buoyancy, weight: FL.smoke.weight, cooling: FL.smoke.cooling, dissipate: FL.smoke.dissipate,
    swirl: FL.swirl, swirlSize: FL.swirlSize, viscosity: FL.viscosity, fade: FL.fade, sharp: !!FL.sharp,
    open: FL.bounds === 'open', pressureSteps: FL.pressureSteps,
    draft: F.draft || { strength: 0, direction: 0, gust: 0 },
    colliderMode: 0, colliderHalfDepth: 0,
  } : null;
  const relax = fluidOn ? 1 - Math.exp(-FL.force * 0.03 * STEP_DT) : 0;
  const fvel = [0, 0, 0];
  const splats = [];

  // Collision: the SDF arrives like the spawn table (baked by the caller from
  // the picked layer's artwork); mode 1 = obstacle, 2 = container.
  const C = system.collision;
  /*
   * A FOLLOWED collider arrives differently from a fixed one: `colliderTable` is
   * the artwork's LOCAL-space field (the same bake a proximity source uses) and
   * `opts.colliderTrack` carries where that artwork is at every step. A fixed
   * collider keeps the box-space field it always had — a field baked over the
   * whole Solver Box is right for something that never moves and is invalidated
   * by every frame of motion, which is the whole reason following needed a
   * different bake rather than a different lookup.
   */
  /*
   * EVERY COLLIDER ON THIS SYSTEM, as a list.
   *
   * `collision` is the first and `colliders[]` the rest (see collidersOf), and
   * everything below reads the list. The tables and the pose tracks arrive as
   * arrays in the same order; a caller that still passes the singular
   * `colliderTable` / `colliderTrack` is read as a list of one, so nothing that
   * calls this the old way has to change.
   *
   * THE THREE SEMANTICS, and they are decisions rather than fallout:
   *
   *   - A particle must be OUTSIDE every obstacle and INSIDE every container.
   *     That is the only reading under which each collider means on its own what
   *     it means alone. Two containers that do not overlap are then
   *     unsatisfiable, which is a thing to see on screen rather than something
   *     to average away.
   *   - Emission is clipped to the INTERSECTION of the containers, for the same
   *     reason.
   *   - Resolution is SEQUENTIAL. Each collider corrects the position in turn
   *     and the last one to have something to say gets the last word. Iterating
   *     to a joint solution is what a real constraint solver does and is not
   *     worth it here: colliders rarely overlap, and packing's substep loop
   *     already re-runs the whole clamp several times a frame.
   */
  const collCfgs = collidersOf(system);
  const collTables = opts.colliderTables
    || (colliderTable ? [colliderTable] : []);
  const collTracks = opts.colliderTracks
    || (opts.colliderTrack ? [opts.colliderTrack] : []);

  const COLL = [];
  for (let i = 0; i < collCfgs.length; i++) {
    const cfg = collCfgs[i];
    const table = collTables[i] || null;
    if (!table) continue;                       // artwork still decoding
    const track = collTracks[i] || null;
    const follow = !!(track && cfg.follow);
    const entry = {
      cfg,
      table,
      track,
      follow,
      mode: cfg.faces === 'inner' ? 2 : 1,
      halfD: cfg.depth / 2,
      bounce: cfg.bounce,
      // The doorway. Null unless a side is actually open, so a closed collider
      // pays one property read; the amount is a function of time alone and is
      // evaluated once per STEP rather than per particle.
      open: cfg.open && cfg.open.side !== 'none' ? cfg.open : null,
      release: !!cfg.releaseOutside,
      openAmt: 0,
      pose: null,
    };
    // Pose for the step being simulated. A collider following a STILL layer is
    // resolved once and reused, so following costs nothing beyond being right.
    entry.poseAt = (step) => {
      if (!entry.follow) return null;
      if (entry.pose && !track.moves) return entry.pose;
      const n = track.n | 0;
      const sIdx = step < 0 ? 0 : step >= n ? n - 1 : step | 0;
      const o = sIdx * PROX_POSE_STRIDE;
      const d = track.data;
      // `on` is presence on the TIMELINE: a followed collider only exists while
      // the layer it follows does. resolveCollisionPosed / insideCollisionPosed
      // both treat `on: false` as no collider at all.
      const live = track.on ? track.on[sIdx] !== 0 : true;
      entry.pose = makeProxPose(table, d[o], d[o + 1], d[o + 2], d[o + 3], live);
      return entry.pose;
    };
    COLL.push(entry);
  }
  const collAny = COLL.length > 0;
  // Any container at all? Emission only has to test when there is one.
  const collHasContainer = COLL.some((e) => e.mode === 2);

  /*
   * The fluid grid's ink mask is a box-space rasterisation, so it can only be
   * built from a box-space field — and there is only one grid, so it can take
   * only ONE collider. The first FIXED one shapes the flow; the rest steer
   * particles alone. A followed collider's field is local-space and cannot go in
   * at all. Said on the row in the panel, not left to be discovered.
   */
  const flowColl = COLL.find((e) => !e.follow) || null;
  if (flowColl && G) {
    G.maskInk = gridInkMask(G, flowColl.table);
    fluidCfg.colliderMode = flowColl.mode;
    fluidCfg.colliderHalfDepth = flowColl.halfD;
  }

  const cp = [0, 0, 0], cv = [0, 0, 0];
  // Contact normal out of the collider, for packing's deferred wall response.
  const cn = [0, 0, 0];

  /*
   * PACKING — particle-to-PARTICLE collision. Null unless the block is enabled,
   * so a system that does not use it pays one null check per step.
   *
   * The RADIUS is the drawn size, reproduced here rather than stored: the draw
   * builds its per-particle multiplier as srnd(seed, uid, 21) * size.random
   * (particleLayer.js), and this has both the seed and the uid, so the two agree
   * exactly without a byte in the snapshot cache. That is also why `render.size`
   * enters particleSimHash only while packing is on — see the note there.
   */
  /*
   * SHAPE MODE — `packing.shape: 'object'`: each particle collides as the
   * silhouette of the layer object it stamps, and has an angle and a spin the
   * simulation owns (see the shape section of packing.js).
   *
   * Needs all four: packing on, a layer-objects system, a FLAT box (a clump is
   * a flat thing) and the clumps themselves, which the caller builds from the
   * members' artwork (particleLayer.js objectShapesFor) and hands in like the
   * collider's field. Until every member has rasterised there are no clumps and
   * the system packs as circles; the clumps' key is in the bake hash, so their
   * arrival re-bakes it.
   *
   * WHICH MEMBER a particle is must match the draw exactly, so both read the
   * same pick table over the same INCLUDED members (shapes.js).
   */
  const shapesIn = opts.objectShapes || null;
  const shIncluded = system.render.mode === 'layers' && Array.isArray(system.objects?.members)
    ? system.objects.members.filter((m) => m && m.included !== false) : [];
  const shapeOn = !!(system.packing?.enabled && system.packing.shape === 'object'
    && shIncluded.length > 0 && bz <= 1
    && shapesIn && shapesIn.count === shIncluded.length);
  const PK = createPacking(system.packing, maxP, shapeOn ? shapesIn : null);
  /*
   * WHICH size the radius comes from, because there are two and they are not
   * interchangeable.
   *
   * A sprite system draws `render.size` lerped start -> end over life, with
   * `render.size.random` per particle. A LAYER-OBJECTS system (`render.mode:
   * 'layers'`) ignores all of that and draws `objects.size x member.sizeScale`,
   * constant over life, with `objects.sizeRandom` — see particleLayer.js's
   * object batches. Reading render.size for an object system would collide at a
   * radius that has nothing to do with what is on screen.
   *
   * `sizeScale` is per MEMBER, and which member a particle gets is decided at
   * draw time from a weight table over the members whose artwork actually
   * rasterised — render-side state the solver deliberately does not have
   * ("objects are a render-only concern; the solver moves anonymous points").
   * So the radius folds in the WEIGHTED MEAN sizeScale across included members.
   * That is exact for a single member, which is the common case and both of the
   * shipped examples; a mix of members with very different sizeScale collides at
   * an averaged radius, which is worth knowing and not worth coupling the solver
   * to the rasteriser for.
   */
  const objMode = PK && system.render.mode === 'layers'
    && Array.isArray(system.objects?.members) && system.objects.members.some((m) => m && m.included !== false);
  const objScale = objMode ? (() => {
    const inc = system.objects.members.filter((m) => m && m.included !== false);
    let wsum = 0, acc = 0;
    for (const m of inc) {
      const w = Math.max(0, m.weight ?? 1) || 1;
      wsum += w; acc += w * (m.sizeScale ?? 1);
    }
    return wsum > 0 ? acc / wsum : 1;
  })() : 1;
  const RS = system.render.size;
  const OB = system.objects;
  const pkLive = PK ? new Int32Array(maxP) : null;
  const pkTravel = PK ? new Float32Array(maxP) : null;
  const pkDvx = PK ? new Float32Array(maxP) : null;
  const pkDvy = PK ? new Float32Array(maxP) : null;
  const pkDvz = PK ? new Float32Array(maxP) : null;
  // A flat solver box is the 2D read, and it is a third of the cost of the 3D
  // one — the grid drops from a 3x3x3 stencil to 3x3.
  const pkZOn = PK ? bz > 1 : false;
  const pkScale = PK ? system.packing.radiusScale : 1;
  let pkN = 0;
  /*
   * THE UID, NOT THE SLOT. `uid[i]`, never `i + 1`.
   *
   * The two agree only until the first slot is recycled, and then they diverge
   * for good: the draw seeds its per-particle size from the real uid
   * (particleLayer.js), so a slot on its second tenant would have collided at
   * the size of its FIRST one. Measured on a high-randomness system, every
   * radius after reuse was wrong, by up to 7.2x. `i + 1` is right in `launch`
   * and `placeAtSite` — where slot and site are one-to-one by construction —
   * and copying it here was the mistake.
   */
  const pkRadius = objMode
    ? (i) => {
      // Constant over life, like the object batch's uSizeStart === uSizeEnd.
      let dia = OB.size * objScale * (1 + srnd(seed, uid[i], 21) * OB.sizeRandom);
      if (pkPxU) dia *= Math.max(0, 1 + pkProxSize * pkPxU[i]);
      return Math.max(0.05, dia * 0.5 * pkScale);
    }
    : (i) => {
      const k = life[i] > 0 ? clamp01(age[i] / life[i]) : 0;
      let dia = lerp(RS.start, RS.end, k) * (1 + srnd(seed, uid[i], 21) * RS.random);
      // Exactly the renderer's own expression (particleLayer.js): the drawn size
      // and the collision radius have to be one number, not two that agree.
      if (pkPxU) dia *= Math.max(0, 1 + pkProxSize * pkPxU[i]);
      return Math.max(0.05, dia * 0.5 * pkScale);
    };

  /*
   * Shape mode's per-slot state. The angle is SIMULATED — it is snapshotted
   * beside the position and the draw reads it — so these exist only while the
   * mode is on and a circle system allocates nothing.
   *
   * A particle is born at the same random angle and with the same spin the
   * draw has always given it (particleLayer.js: rnd 24 for the angle, 23 and 26
   * for the spin), so a letter in free flight turns exactly as it did before;
   * what changes is that a contact can now turn it, and a letter at rest stops.
   */
  const shAng = shapeOn ? new Float32Array(maxP) : null;
  const shAngv = shapeOn ? new Float32Array(maxP) : null;
  const shMemSlot = shapeOn ? new Int32Array(maxP) : null;
  const shTable = shapeOn ? objectPickTable(shIncluded) : null;
  const shRandom = system.objects?.pick === 'random';
  /*
   * FACING ▸ VELOCITY survives shape mode — as STEERING, not a pose.
   *
   * The draw used to point each object along its travel outright. With the
   * angle simulated that would draw a letter at an angle it never collided at,
   * so instead the simulation turns each body toward its travel, like a vane in
   * the wind. A contact can still knock it round; the flow brings it back.
   *
   * THE TURN RATE IS CAPPED BY THE TRAVEL SPEED, and that is not a nicety. The
   * first version was a stiff angle spring (~4 Hz), and on the user's 24-letter
   * swirl it snapped each 250 x 400 px letter round in a tenth of a second: the
   * tips swept into the neighbours at ~3,000 px/s, every contact became a kick,
   * and the swirl flung most of its letters out of the box (mean speed 970 px/s
   * at 0.1 s; circles 122, the same system facing the camera 116). Now the rim
   * may turn no faster than the body itself travels — a letter at rest barely
   * turns, one in the flow turns as fast as the flow does. Tuned on that swirl:
   * moving letters sit ~10 degrees off their travel (a looser 0.6x cap and a
   * softer gain left them at 24), and speeds stay within a few % of circles.
   *
   * Tumble has no flat equivalent and reads as Camera facing here.
   */
  const shFaceVel = shapeOn && system.objects?.facing === 'velocity';
  const SH_FACE_RATE = 40;    // 1/s: how hard the angle error is closed when allowed
  const SH_FACE_GAIN = 30;    // 1/s: how fast the spin follows what steering wants
  if (shapeOn) bindShapeAngles(PK, shAng, shAngv);
  if (shapeOn) shRot = new Float32Array(snapCount * maxP);
  const shInit = shapeOn
    ? (i, u) => {
      const m = objectMemberOf(u, shTable, shRandom);
      shMemSlot[i] = m;
      shAng[i] = rnd(seed, u, 24) * 6.283185;
      const dirSign = rnd(seed, u, 23) < 0.5 ? -1 : 1;
      const spin = OB.spin * (shIncluded[m].spinScale ?? 1);
      shAngv[i] = spin * (0.6 + rnd(seed, u, 26) * 1.1) * dirSign * 2.2;
    }
    : null;

  // Paths: the emitter's own (unit space of the emitter) and path-follow's
  // (unit space of the box); follow falls back to the emitter's path.
  const toWorldPath = (anchors, size, origin) => resamplePath(anchors.map((a) => ({
    x: origin.x + a.x * size.x, y: origin.y + a.y * size.y,
  })));
  const emitPathS = em.shape === 'path' && em.path && em.path.anchors.length >= 2
    ? toWorldPath(em.path.anchors, em.size, em.position) : null;
  const PF = system.pathFollow;
  const followS = PF && PF.enabled
    ? (PF.anchors && PF.anchors.length >= 2
      ? toWorldPath(PF.anchors, solver.bounds.size, { x: 0, y: 0 })
      : emitPathS)
    : null;
  const near = new Int32Array(maxP).fill(-1);
  const pv = [0, 0, 0];

  // Force emitters: jets and vortices. They stir the field whenever it is on;
  // `detach` only switches the particle emitter's OWN stirring off. Without a
  // field, a vortex emitter drives the particles directly — the same rigid-core
  // rotation, applied per particle instead of per cell.
  const { jets, smokers, pushers, vortices, blasts, drivers, influences, feAmp, fePos } = forceEmitterSetup(system, fluidOn);
  // LAYER VELOCITY: another layer's animation, sampled per step by the caller
  // and handed in like the collider SDF. Rows are in `drivers` order.
  const LD = opts.layerDrive && opts.layerDrive.count > 0 ? opts.layerDrive : null;
  const ldOn = !!LD && drivers.length > 0;
  const ldScratch = [0, 0, 0];
  /*
   * PROXIMITY EFFECTORS (v4) — another layer's SHAPE as a force.
   *
   * Arrives exactly like the collider and Layer Velocity: the caller
   * (particleProxTrack.js) samples where each source layer is per step, and
   * bakes the distance field from its artwork, because the solver has no
   * timeline and no canvas.
   *
   * Two gates, both worth having. `pxOn` is false unless something in `fx`
   * actually drives motion, so a look-only effector costs this loop nothing at
   * all. `pxNeedsN` is false unless a target reads a DIRECTION, and the surface
   * normal is four extra field samples — a 5x difference in the per-particle
   * cost of the whole feature.
   */
  const PXsrc = system.proximity && system.proximity.enabled ? system.proximity : null;
  const PXtrack = opts.proximity?.track || null;
  const PXtables = opts.proximity?.tables || null;
  /*
   * A WORKING COPY, not the block itself: `range`, `falloff`, `depth` and every
   * motion amount may be KEYFRAMED, and the editor hands those over as a flat
   * per-step table (`track.pdata`) for the same reason it hands over per-step
   * poses — a force is integrated, so one static number for the whole clip is
   * not an answer. Refreshed once per step below; the enum-ish fields
   * (measure / shape / combine / invert) are never animated and are seeded here
   * once.
   */
  const PXcfg = PXsrc ? { ...PXsrc } : null;
  const PXamt = PXsrc ? proxMotionAmounts(PXsrc.fx) : null;
  const pxKeyed = !!(PXtrack && PXtrack.pdata);
  // With a params table the track carries the verdict — computed over EVERY step
  // by particleProxTrack.js, so an amount that is zero at t=0 and keyed up later
  // still switches the effector on. Without one the stored numbers are the whole
  // story, exactly as before.
  const pxAnyMotion = pxKeyed
    ? PXtrack.pmotion === true
    : !!(PXamt && (PXamt.attract || PXamt.flow || PXamt.orbit || PXamt.drag
      || PXamt.speed || PXamt.turb || PXamt.freeze || PXamt.life));
  const pxOn = !!(PXcfg && PXtrack && PXtables && PXtables.some(Boolean) && pxAnyMotion);
  // The surface normal is four extra field samples per particle, so it stays a
  // per-STEP decision once the amounts can change: a clip that only attracts in
  // its last second pays for the normal in that second alone.
  let pxNeedsN = pxOn && proxNeedsNormal(PXamt);

  /*
   * A PROXIMITY SIZE EFFECTOR IS GEOMETRY ONCE PACKING IS ON.
   *
   * `size` is a LOOK target: the renderer multiplies each particle's drawn size
   * by (1 + fx.size/100 * u) at draw time, and it is deliberately kept out of the
   * simulation so that tuning it never re-bakes. With packing on that stops
   * being tenable — a bead drawn at twice its size still collided at its base
   * radius, so an effector that swells the cloud left it overlapping and one
   * that shrinks it left visible gaps.
   *
   * Same trade `render.size` already makes: while packing is enabled the size
   * effector is a simulation input and enters the hash; while it is off, nothing
   * changes and a size tweak is still free.
   *
   * Only SIZE. Rotation, stretch, colour and the rest are drawn and cannot
   * matter here — a contact in this solver is between two circles, so nothing
   * that turns or recolours a sprite changes what it collides with.
   */
  const pkProxSize = PK && PXsrc ? (Number.isFinite(PXsrc.fx?.size) ? PXsrc.fx.size : 0) / 100 : 0;
  const pkSizeFromProx = !!(PK && pkProxSize && PXtables && PXtables.some(Boolean));
  const pkPxU = pkSizeFromProx ? new Float32Array(maxP) : null;
  // A size effector can grow a SLEEPING letter into its sleeping neighbour, so
  // shape mode's projection must keep checking sleeper pairs in that one case.
  if (shapeOn && pkSizeFromProx) PK.shape.scaleMoves = true;
  /*
   * Shape mode: the DRAWN width of particle i (member m, uid u) — the quad the
   * artwork is stamped on is this wide and `aspect` times this tall, and the
   * clump is in units of it. Exactly the draw's expression, like pkRadius.
   */
  const shDrawW = shapeOn
    ? (i, u, m) => OB.size * (shIncluded[m].sizeScale ?? 1) * (1 + srnd(seed, u, 21) * OB.sizeRandom)
      * (pkPxU ? Math.max(0, 1 + pkProxSize * pkPxU[i]) : 1)
    : null;

  const pxPoses = (pxOn || pkSizeFromProx) && PXtrack ? new Array(PXtrack.count).fill(null) : null;
  const pxOut = { nx: 0, ny: 0 };
  // Pulse forces: a radial shove at a point, at its own times. Live per step —
  // position (it may orbit) and envelope (which impulse, how far into it).
  const blastNow = blasts.map(() => ({ x: 0, y: 0, env: 0 }));
  const bAcc = [0, 0];
  // Local coupling: only particles near a force emitter ride the flow. Falls
  // back to the whole box when there is nothing to be near.
  // Only when the emitter has handed the forces over (Force source: Force
  // emitters). While the emitter is itself the force source, the field is the
  // whole medium and everything in the box rides it.
  // A rows emitter is a tracer grid: it never drives the field, so for coupling
  // it counts as detached exactly like an emitter that handed the forces over.
  const reachSources = fluidOn && FL.reach === 'sources' && influences.length > 0 && (!!em.detach || em.shape === 'rows');
  const infPos = influences.map(() => [0, 0]);
  const influenceAt = (x, y) => {
    let w = 0;
    for (let k = 0; k < infPos.length; k++) {
      const r = Math.max(1, influences[k].radius);
      const dx = (x - infPos[k][0]) / r, dy = (y - infPos[k][1]) / r;
      const g = Math.exp(-(dx * dx + dy * dy));
      if (g > w) w = g;
    }
    return w;
  };
  /*
   * MAY THE EMITTER EMIT AT THIS STEP?
   *
   * `emitters[0].followTimeline` gates emission on the source layer's own span
   * on the timeline, resolved by the caller (it has the timeline; this does
   * not). Absent, everything emits exactly as it always has — which is the
   * default, because the artwork is a snapshot and the usual dissolve recipe
   * trims the donor layer away after picking it.
   */
  const emitGate = opts.emitterGate || null;
  const emitAllowed = emitGate
    ? (step) => {
      const n = emitGate.n | 0;
      const i = step < 0 ? 0 : step >= n ? n - 1 : step | 0;
      return emitGate.on[i] !== 0;
    }
    : () => true;

  // Slot/uid counters, shared with the emission module.
  const S = { nextUid: 1, cursor: 0, aliveCount: 0, dropped: 0, blocked: 0 };
  /*
   * BIRTHS THE PACK HAD NO ROOM FOR, waiting for some.
   *
   * A rate emitter recovers on its own: it asks again next frame. A BURST does
   * not — it fires once, and whatever the occupancy check refused used to be
   * gone for good. That is the wrong answer to "fill this mould with 900": a
   * burst into a container that holds 550 placed 76, dropped 824, and never
   * looked again even after the container's floor opened and it emptied.
   *
   * So a blocked birth is REMEMBERED and retried, a slice at a time. The budget
   * backs off while nothing is fitting and snaps back the moment something does,
   * so a mould that is simply full costs a few rejection samples a step rather
   * than a few thousand.
   */
  let pendingSpawn = 0;
  let retryBudget = 96;
  // Which step emission is running for, so a followed container tests against
  // the pose of the frame the particle is actually being born into.
  let emitStep = 0;
  /*
   * PACKING: this frame's OWN spawns, which the grid cannot know about.
   *
   * The packing grid is rebuilt inside the step and emission runs before it, so
   * `occupied()` sees the pool as it was one step ago. That is close enough to
   * refuse a spawn onto a settled pack, and NOT enough on its own: everything
   * born in this same frame is invisible to it, which is exactly the case that
   * stacks a nozzle's whole frame on one point. So births are recorded here as
   * they happen and tested linearly — a frame holds tens of them, not
   * thousands, so a list beats a second grid.
   */
  /*
   * THIS FRAME'S OWN BIRTHS, IN A GRID — not in a list.
   *
   * Two rewrites, both from measurement. It began as a 512-entry list on the
   * reasoning that "a frame holds tens of births, not thousands", which is true
   * of a rate emitter and false of the two cases that need this most: a STATIC
   * system is one burst of the whole pool. Past the cap the check silently
   * stopped seeing new births and the self-throttle stopped applying — a 1,600
   * particle burst came out with 5,008 overlapping pairs.
   *
   * Sizing the list to the pool fixed the correctness and left the cost O(n^2):
   * every birth scanned every earlier birth in the same frame. Measured on a
   * sparse burst, packing on vs off:
   *
   *     16k    280 ms  vs   42 ms
   *     32k   2.32 s   vs   34 ms
   *     64k   9.20 s   vs   57 ms
   *
   * The worker keeps that off the editor's main thread, but an export and the
   * first cache build both wait on it, and 9 s for one frame of emission is not
   * a cost anyone agreed to.
   *
   * So the same uniform grid the contact solver uses, built INCREMENTALLY: a
   * birth is inserted as it happens (bucket head + next chain, both O(1)) and
   * queried over the 3x3x3 stencil around its own point. Cleared per frame by
   * walking only the buckets that were touched, so an empty frame costs nothing
   * and a frame of 64k births costs 64k.
   */
  // Shape mode births are tested against the object's BOUNDING circle: coarse,
  // but a birth must never land inside a letter, and a spawn it refuses is
  // retried, not lost.
  const pkBirthRadius = shapeOn
    ? (u) => {
      const m = objectMemberOf(u, shTable, shRandom);
      return Math.max(0.05, shapesIn.bound[m] * OB.size * (shIncluded[m].sizeScale ?? 1)
        * (1 + srnd(seed, u, 21) * OB.sizeRandom));
    }
    : objMode
      ? (u) => Math.max(0.05, OB.size * objScale * (1 + srnd(seed, u, 21) * OB.sizeRandom) * 0.5 * pkScale)
      : (u) => Math.max(0.05, RS.start * (1 + srnd(seed, u, 21) * RS.random) * 0.5 * pkScale);
  // The widest a birth can be, so one cell always covers the 3x3x3 query.
  const pkBirthRMax = PK
    ? Math.max(0.05, shapeOn
      ? shIncluded.reduce((mx, mm, m) => Math.max(mx, shapesIn.bound[m] * OB.size * (mm.sizeScale ?? 1)), 0)
        * (1 + Math.abs(OB.sizeRandom))
      : (objMode
        ? OB.size * objScale * (1 + Math.abs(OB.sizeRandom))
        : RS.start * (1 + Math.abs(RS.random))) * 0.5 * pkScale)
    : 0;
  /*
   * THE CELL GROWS TO FIT THE CAPS — it does not get clamped against them.
   *
   * The first grid took its cell from the particle radius and then clamped the
   * DIMENSIONS at 512x512x64. That is the quadratic scan wearing a grid's
   * clothes: with a 10,000 px box and 2 px particles the honest grid is 5,000
   * cells wide, the clamp cut it to 512, and every position past the represented
   * range collapsed into the last bucket — one bucket holding most of the pool,
   * walked linearly by every subsequent birth. Measured on exactly that setup:
   * 16k 408 ms, 32k 2.47 s, 64k 9.56 s, which is the curve the grid replaced.
   *
   * So the cap sets a FLOOR on the cell size instead. Bigger cells hold more
   * candidates per query, which is linear and bounded; a clamped index is not.
   * Correctness is unaffected either way: a cell at least 2 x the widest birth
   * means the 3x3x3 stencil always spans the furthest pair that can touch, and
   * making cells larger only ever adds candidates.
   *
   * The span covers the emitter as well as the box, because an emitter may be
   * larger than the box it fires into and those births are exactly the ones that
   * would pile into an edge bucket.
   */
  const emHalf = PK && em ? {
    x: Math.abs(em.position?.x || 0) + Math.abs(em.size?.x || 0) * 0.5,
    y: Math.abs(em.position?.y || 0) + Math.abs(em.size?.y || 0) * 0.5,
    z: Math.abs(em.position?.z || 0) + Math.abs(em.size?.z || 0) * 0.5,
  } : { x: 0, y: 0, z: 0 };
  const pkSpanX = Math.max(1e-3, Math.max(bx, emHalf.x) * 2);
  const pkSpanY = Math.max(1e-3, Math.max(by, emHalf.y) * 2);
  const pkSpanZ = Math.max(1e-3, Math.max(bz, emHalf.z) * 2);
  const PK_FG_CAP = 512, PK_FG_CAP_Z = 64;
  const pkFreshCS = Math.max(
    1e-3,
    pkBirthRMax * 2,
    pkSpanX / (PK_FG_CAP - 1),
    pkSpanY / (PK_FG_CAP - 1),
    pkZOn ? pkSpanZ / (PK_FG_CAP_Z - 1) : 0,
  );
  const pkGridHalfX = Math.max(bx, emHalf.x);
  const pkGridHalfY = Math.max(by, emHalf.y);
  const pkGridHalfZ = Math.max(bz, emHalf.z);
  const pkFGX = PK ? Math.max(1, Math.min(PK_FG_CAP, Math.ceil(pkSpanX / pkFreshCS) + 1)) : 1;
  const pkFGY = PK ? Math.max(1, Math.min(PK_FG_CAP, Math.ceil(pkSpanY / pkFreshCS) + 1)) : 1;
  const pkFGZ = PK && pkZOn ? Math.max(1, Math.min(PK_FG_CAP_Z, Math.ceil(pkSpanZ / pkFreshCS) + 1)) : 1;
  const pkFreshHead = PK ? new Int32Array(pkFGX * pkFGY * pkFGZ).fill(-1) : null;
  const pkFreshNext = PK ? new Int32Array(maxP) : null;
  const pkFreshX = PK ? new Float32Array(maxP) : null;
  const pkFreshY = PK ? new Float32Array(maxP) : null;
  const pkFreshZ = PK ? new Float32Array(maxP) : null;
  const pkFreshR = PK ? new Float32Array(maxP) : null;
  // Shape mode: which particle each fresh birth is, so its outline can be posed.
  const pkFreshU = shapeOn ? new Int32Array(maxP) : null;
  // Buckets written this frame, so the reset is O(births) and not O(cells).
  const pkFreshTouched = PK ? new Int32Array(maxP) : null;
  let pkFreshN = 0;
  let pkTouchedN = 0;

  const pkFreshCell = (x, y, z) => {
    const cx = clamp((((x + pkGridHalfX) / pkFreshCS) | 0), 0, pkFGX - 1);
    const cy = clamp((((y + pkGridHalfY) / pkFreshCS) | 0), 0, pkFGY - 1);
    const cz = pkZOn ? clamp((((z + pkGridHalfZ) / pkFreshCS) | 0), 0, pkFGZ - 1) : 0;
    return (cz * pkFGY + cy) * pkFGX + cx;
  };
  const pkFreshClear = () => {
    for (let k = 0; k < pkTouchedN; k++) pkFreshHead[pkFreshTouched[k]] = -1;
    pkTouchedN = 0;
    pkFreshN = 0;
  };
  const pkFreshAdd = (x, y, z, r, u) => {
    if (pkFreshN >= maxP) return;
    const i = pkFreshN++;
    pkFreshX[i] = x; pkFreshY[i] = y; pkFreshZ[i] = z; pkFreshR[i] = r;
    if (pkFreshU) pkFreshU[i] = u;
    const c = pkFreshCell(x, y, z);
    if (pkFreshHead[c] === -1 && pkTouchedN < maxP) pkFreshTouched[pkTouchedN++] = c;
    pkFreshNext[i] = pkFreshHead[c];
    pkFreshHead[c] = i;
  };

  /*
   * SHAPE MODE'S BIRTH TEST is the outlines, not the bounding circles: a birth
   * is posed exactly as it will be born (member, drawn size, the random angle
   * shInit gives it) and tested against every body in the grid and every birth
   * already made this frame. Its bounding circle is only the broad phase.
   */
  const shPose = shapeOn
    ? (u) => {
      const m = objectMemberOf(u, shTable, shRandom);
      const sc = OB.size * (shIncluded[m].sizeScale ?? 1) * (1 + srnd(seed, u, 21) * OB.sizeRandom);
      return { m, sc, a: rnd(seed, u, 24) * 6.283185 };
    }
    : null;
  const shapeSpawnBlocked = shapeOn ? (x, y, u) => {
    const P = shPose(u);
    if (occupiedShape(PK, x, y, P.m, P.sc, P.a)) return true;
    const r = shapesIn.bound[P.m] * P.sc;
    const ac = Math.cos(P.a), as = Math.sin(P.a);
    const cx = clamp((((x + pkGridHalfX) / pkFreshCS) | 0), 0, pkFGX - 1);
    const cy = clamp((((y + pkGridHalfY) / pkFreshCS) | 0), 0, pkFGY - 1);
    for (let dy = -1; dy <= 1; dy++) {
      const gy = cy + dy; if (gy < 0 || gy >= pkFGY) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx; if (gx < 0 || gx >= pkFGX) continue;
        for (let k = pkFreshHead[gy * pkFGX + gx]; k !== -1; k = pkFreshNext[k]) {
          const lim = r + pkFreshR[k];
          if ((pkFreshX[k] - x) ** 2 + (pkFreshY[k] - y) ** 2 > lim * lim) continue;
          const F = shPose(pkFreshU[k]);
          if (clumpsOverlap(shapesIn, P.m, x, y, ac, as, P.sc, F.m, pkFreshX[k], pkFreshY[k],
            Math.cos(F.a), Math.sin(F.a), F.sc, SHAPE_BIRTH_K)) return true;
        }
      }
    }
    return false;
  } : null;

  const spawnBlocked = PK ? (x, y, z, u) => {
    if (shapeSpawnBlocked) return shapeSpawnBlocked(x, y, u);
    const r = pkBirthRadius(u);
    if (occupied(PK, x, y, z, r, pkZOn)) return true;
    const cx = clamp((((x + pkGridHalfX) / pkFreshCS) | 0), 0, pkFGX - 1);
    const cy = clamp((((y + pkGridHalfY) / pkFreshCS) | 0), 0, pkFGY - 1);
    const cz = pkZOn ? clamp((((z + pkGridHalfZ) / pkFreshCS) | 0), 0, pkFGZ - 1) : 0;
    for (let dz = pkZOn ? -1 : 0; dz <= (pkZOn ? 1 : 0); dz++) {
      const gz = cz + dz; if (gz < 0 || gz >= pkFGZ) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const gy = cy + dy; if (gy < 0 || gy >= pkFGY) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const gx = cx + dx; if (gx < 0 || gx >= pkFGX) continue;
          for (let k = pkFreshHead[(gz * pkFGY + gy) * pkFGX + gx]; k !== -1; k = pkFreshNext[k]) {
            const ddx = pkFreshX[k] - x, ddy = pkFreshY[k] - y, ddz = pkZOn ? pkFreshZ[k] - z : 0;
            // The same 10% interlock `occupied` allows: a pack is beads
            // touching, not beads held apart.
            const rest = (r + pkFreshR[k]) * 0.9;
            if (ddx * ddx + ddy * ddy + ddz * ddz < rest * rest) return true;
          }
        }
      }
    }
    return false;
  } : null;

  const emission = createEmission({
    arrays: { px, py, pz, vx, vy, vz, age, life, uid, near },
    S, em, seed, maxP, spawnTable,
    // The emission module only needs to know THAT there is a container; which
    // ones, and where they are this step, is decided here.
    colliderTable: null,
    collMode: collHasContainer ? 2 : 0,
    collHalfD: 0,
    emitPathS,
    /*
     * INSIDE EVERY CONTAINER, not inside any. Each container means on its own
     * what it means alone, so a birth has to satisfy all of them — the same
     * reading the resolve below uses. Obstacles are not consulted: a birth
     * inside one is pushed out on the first step, which is what an obstacle has
     * always done.
     */
    insideContainer: collHasContainer
      ? (x, y, z) => {
        for (let ci = 0; ci < COLL.length; ci++) {
          const e = COLL[ci];
          if (e.mode !== 2) continue;
          const ok = e.follow
            ? insideCollisionPosed(e.poseAt(emitStep), e.halfD, x, y, z)
            : insideCollider(e.table, e.halfD, x, y, z);
          if (!ok) return false;
        }
        return true;
      }
      : null,
    // The setting, not this bake's reduced pool — see createEmission.
    distPool: Math.max(1, Math.round(solver.maxParticles)),
    spawnBlocked,
    onSpawn: (i, u) => {
      noteConstants(u, life[i], 0);
      noteHome(i);
      if (shInit) shInit(i, u);
      if (PK) pkFreshAdd(px[i], py[i], pz[i], pkBirthRadius(u), u);
    },
  });
  const spawn = (n) => emission.spawn(n);
  const stepSites = emission.sites;
  // What the emitter and the jets push into the field each step — shared with
  // the live GPU engine, so a preset stirs the same way live and baked.
  const splatCtx = fluidOn ? { em, smoke, heat: FL.smoke.heat, jets, smokers, fePos, seed, arrays: { px, py, pz, vx, vy, vz }, sites: stepSites } : null;

  // THE VORTEX STIRS THE FLUID. forces.vortex used to move particles only; with
  // the field on it is a force on the grid as well, from the same fieldAccel
  // the particles feel — so the smoke rolls with the vortex instead of the
  // particles sliding through a still field. Vortex emitters join it here.
  if (fluidOn && (vortOn || vortices.length || blasts.length)) {
    const vAcc = [0, 0, 0];
    fluidCfg.pointForce = (out, x, y, z, t) => {
      out[0] = 0; out[1] = 0; out[2] = 0;
      if (vortOn) {
        fieldAccel(vAcc, F.vortex, x, y, z);
        out[0] += vAcc[0]; out[1] += vAcc[1]; out[2] += vAcc[2];
      }
      for (let v = 0; v < vortices.length; v++) {
        const fe = vortices[v];
        const p = fePos(fe, v, t);
        forcePointAccel(vAcc, fe, p[0], p[1], x, y, z);
        out[0] += vAcc[0]; out[1] += vAcc[1]; out[2] += vAcc[2];
      }
      // A pulse blasts the medium as well as the particles, so smoke gets
      // shoved out of the way instead of the particles sliding through it.
      for (let b = 0; b < blasts.length; b++) {
        if (blastNow[b].env <= 0) continue;
        burstAccel(bAcc, blastNow[b].x, blastNow[b].y, blasts[b].radius, blasts[b].push, blastNow[b].env, x, y);
        out[0] += bAcc[0]; out[1] += bAcc[1];
      }
    };
  }
  const feAcc = [0, 0, 0];

  let acc = 0, snap = 0;
  const onChunk = typeof opts.onChunk === 'function' ? opts.onChunk : null;
  let chunkFrom = 0;
  let diedOfAge = 0, diedAtBounds = 0;
  const steps = Math.ceil((preRoll + dur) / STEP_DT) + 1;

  // STATIC emission: the system is filled once and never emits again — one cloud,
  // born together, which is what you want for a shatter, a title made of dust, or
  // anything the front is going to release. It is expressed as a burst rather than
  // as a special case in the loop, so bounds, ageing and death are unchanged.
  // A rows emitter is static by definition: the grid is placed once, whole.
  const staticEmit = em.emit === 'static' || em.shape === 'rows';
  const bursts = staticEmit
    ? [{ time: Math.max(0, em.start), count: maxP, fired: false }]
    : (em.bursts || [])
      // Bursts fire once, on the first step at or after their time. Firing is part
      // of the forward pass, so it is as deterministic as the rest of the bake.
      .filter((b) => b.count > 0)
      .map((b) => ({ time: b.time, count: b.count, fired: false }));

  // ── The activation schedule ─────────────────────────────────────────────────
  // progress(t) = start + speed x t, clamped: the same pair Grow Fill animates
  // with. A site is reached when progress passes its arrival, and `softness`
  // dithers that by a deterministic per-site jitter so the front comes apart as
  // a band rather than a cut line. Sorted once, so the step loop only ever looks
  // at its head — 6000 sites must not become a 6000-wide scan every 1/60 s.
  let schedule = null, head = 0, neverActivated = 0;
  if (growOn) {
    const start = A.start / 100;
    const rate = A.speed / 100;
    const soft = A.softness / 100;
    const times = new Float32Array(maxP);
    for (let i = 0; i < maxP; i++) {
      let a = A.reverse ? 1 - spawnTable.arrival[i] : spawnTable.arrival[i];
      if (soft > 0) a += (rnd(seed, i + 1, 41) - 0.5) * soft;
      a = clamp01(a);
      if (a <= start) times[i] = 0;
      else if (rate <= 1e-6) times[i] = Infinity;   // never reached: stays dark
      else times[i] = (a - start) / rate;
      if (!Number.isFinite(times[i])) neverActivated++;
    }
    if (frozen) {
      for (let i = 0; i < maxP; i++) release[i] = Number.isFinite(times[i]) ? times[i] : TTL_ALIVE;
    } else {
      schedule = [];
      for (let i = 0; i < maxP; i++) if (Number.isFinite(times[i])) schedule.push([times[i], i]);
      schedule.sort((a, b) => a[0] - b[0]);
    }
  }

  /** Position a slot on its own emission site, at rest. */
  function placeAtSite(i) {
    const u = i + 1;
    uid[i] = u;
    S.aliveCount++;
    const site = i * 2;
    px[i] = em.position.x + spawnTable.positions[site] * em.size.x;
    py[i] = em.position.y + spawnTable.positions[site + 1] * em.size.y;
    pz[i] = em.position.z + (rnd(seed, u, 3) - 0.5) * em.size.z;
    vx[i] = 0; vy[i] = 0; vz[i] = 0;
    life[i] = Math.max(0.06, em.lifetime.value + srnd(seed, u, 14) * em.lifetime.random);
    age[i] = 0;
    near[i] = -1;
    if (shInit) shInit(i, u);
    noteConstants(u, life[i], release[i]);
    noteHome(i);
  }

  /** The kick a particle gets the moment the front reaches it. */
  function launch(i) {
    const u = i + 1;
    spawnDirection(dir, em.direction, em.spread, seed, u);
    const sp = Math.max(0, em.speed.value + srnd(seed, u, 13) * em.speed.random);
    vx[i] = dir[0] * sp; vy[i] = dir[1] * sp; vz[i] = dir[2] * sp;
    launched[i] = 1;
  }

  // 'frozen': every particle exists from frame 0, standing on the pixel it came
  // from, so the layer READS as the artwork until its moment. It does not age
  // either — a site at the far end of a slow sweep would otherwise die of old age
  // before it ever moved.
  if (frozen) for (let i = 0; i < maxP; i++) { placeAtSite(i); noteConstants(i + 1, life[i], release[i]); }

  for (let s = 0; s < steps; s++) {
    const t = s * STEP_DT - preRoll;   // clip-local time; negative during pre-roll
    emitStep = s;
    // The door's position this step. Pre-roll is before the clip starts, so it
    // holds shut: a system that pre-rolls settles into a closed container rather
    // than one that has already emptied itself before frame 0.
    // Each door's position this step. Pre-roll is before the clip starts, so a
    // door holds shut through it: a system that pre-rolls settles into a closed
    // container rather than one that has already emptied itself before frame 0.
    for (let ci = 0; ci < COLL.length; ci++) {
      const e = COLL[ci];
      if (e.open) e.openAmt = collisionOpenAmount(e.open, t);
    }
    if (PK) pkFreshClear();

    // ── emit ────────────────────────────────────────────────────────────────
    // Grow Points replaces rate and bursts entirely: the front decides. Leaving
    // the rate running as well would fill the frame with particles the sweep has
    // not reached yet, which is the one thing this feature exists to prevent.
    if (schedule) {
      while (head < schedule.length && schedule[head][0] <= t) {
        const i = schedule[head][1];
        head++;
        placeAtSite(i);
        launch(i);
      }
    } else if (!growOn && emitAllowed(s)) {
      if (!staticEmit && t >= em.start - preRoll && t <= em.end) {
        acc += em.rate * STEP_DT;
        const n = Math.floor(acc);
        acc -= n;
        if (n > 0) spawn(n);
      }
      for (let b = 0; b < bursts.length; b++) {
        if (!bursts[b].fired && t >= bursts[b].time) {
          bursts[b].fired = true;
          const before = S.blocked;
          spawn(bursts[b].count);
          pendingSpawn += S.blocked - before;
        }
      }
      // The remainder of a burst the pack had no room for, retried while there
      // is any chance of room. Only ever non-zero with packing on.
      if (pendingSpawn > 0 && S.aliveCount < maxP) {
        const want = Math.min(pendingSpawn, retryBudget);
        const made = spawn(want);
        pendingSpawn -= made;
        // Back off while nothing fits, snap back the moment something does.
        retryBudget = made > 0 ? 96 : Math.max(8, retryBudget >> 1);
      }
    }

    for (let b = 0; b < blasts.length; b++) {
      const p = fePos(blasts[b], b, t);
      blastNow[b].x = p[0]; blastNow[b].y = p[1];
      blastNow[b].env = burstEnvelope(blasts[b], t);
    }

    // ── the field ───────────────────────────────────────────────────────────
    if (fluidOn) {
      fieldSplats(splats, splatCtx, t, s);
      // A layer sweeping through shoves the MEDIUM out of its way, not only the
      // particles that happen to be in it. One splat per source, carrying the
      // centre's velocity (a splat has one velocity; the gradient stays on the
      // direct particle drive below).
      if (ldOn) layerDriveSplats(splats, LD, s, drivers);
      if (reachSources) for (let k = 0; k < influences.length; k++) { const p = fePos(influences[k], k, t); infPos[k][0] = p[0]; infPos[k][1] = p[1]; }
      fluidStep(G, fluidCfg, splats, STEP_DT * FL.timeFactor, t);
    }
    stepSites.length = 0;

    // ── integrate (semi-implicit Euler) ─────────────────────────────────────
    // Where each proximity source is THIS step. Four poses at most, so this is
    // free next to the per-particle sampling it feeds.
    if (pxOn || pkSizeFromProx) {
      proxPosesAtStep(pxPoses, PXtrack, PXtables, s);
      if (pxKeyed) {
        proxParamsAtStep(PXtrack, s, PXcfg, PXamt);
        pxNeedsN = proxNeedsNormal(PXamt);
      }
    }
    for (let i = 0; i < maxP; i++) {
      if (!uid[i]) continue;
      if (frozen) {
        // Held: no ageing, no forces, no integration. It is the picture, not a
        // simulation, until its own instant.
        if (t < release[i]) continue;
        if (!launched[i]) launch(i);
      }
      // PROXIMITY. Read once, before anything uses it — Turbulence x needs it
      // at the turbulence line and Lifetime x needs it at the ageing line, so
      // there is no ordering that lets it be computed lazily.
      // Evaluated when the effector drives MOTION, and also when packing needs it
      // for the radius. A look-only effector has every motion amount at zero, so
      // running it here changes nothing below and costs one field sample.
      const pxU = (pxOn || pkSizeFromProx)
        ? proxInfluence(PXcfg, pxPoses, px[i], py[i], pz[i], pxNeedsN ? pxOut : null) : 0;
      if (pkPxU) pkPxU[i] = pxU;

      age[i] += STEP_DT * (pxU > 0 && PXamt.life ? Math.max(0.02, 1 + PXamt.life * pxU) : 1);
      if (age[i] >= life[i]) { uid[i] = 0; S.aliveCount--; diedOfAge++; continue; }

      // Packing re-applies the frame's force impulse once per SUBSTEP, so it
      // needs the delta rather than the result. Recorded here and closed below,
      // around the whole pipeline, so no force can be left out by accident.
      if (PK) { pkDvx[i] = vx[i]; pkDvy[i] = vy[i]; pkDvz[i] = vz[i]; }

      vx[i] += F.gravity.x * STEP_DT; vy[i] += F.gravity.y * STEP_DT; vz[i] += F.gravity.z * STEP_DT;
      vx[i] += F.wind.x * STEP_DT; vy[i] += F.wind.y * STEP_DT; vz[i] += F.wind.z * STEP_DT;

      if (turbOn) {
        const phase = (uid[i] % 97) * 0.41;
        turbulenceAccel(tmp, F.turbulence, px[i], py[i], pz[i], t, phase);
        // Turbulence x: agitation that has a shape.
        const tStr = F.turbulence.strength * (pxU > 0 && PXamt.turb ? Math.max(0, 1 + PXamt.turb * pxU) : 1);
        vx[i] += tmp[0] * tStr * STEP_DT;
        vy[i] += tmp[1] * tStr * STEP_DT;
        vz[i] += tmp[2] * tStr * STEP_DT;
      }

      /*
       * The proximity forces themselves, in the comp plane.
       *
       *   Attract  along the field GRADIENT — the true surface normal — so a
       *            particle leaves a letterform perpendicular to its edge
       *            instead of radially from its centre. Positive pulls in.
       *   Flow     tangential to the CONTOUR: particles run around the outline
       *            of a shape rather than around its middle.
       *   Orbit    tangential about the source ORIGIN, a plain whirlpool. Kept
       *            separate because it is the one the grid's point-based
       *            effector could also express, and they read differently.
       */
      if (pxU > 0.0005 && pxNeedsN) {
        const nx = pxOut.nx, ny = pxOut.ny;
        if (PXamt.attract) {
          vx[i] -= nx * PXamt.attract * pxU * STEP_DT;
          vy[i] -= ny * PXamt.attract * pxU * STEP_DT;
        }
        if (PXamt.flow) {
          vx[i] += -ny * PXamt.flow * pxU * STEP_DT;
          vy[i] += nx * PXamt.flow * pxU * STEP_DT;
        }
        if (PXamt.orbit) {
          const P0 = pxPoses.find(Boolean);
          if (P0) {
            const dx = px[i] - P0.x, dy = py[i] - P0.y;
            const L = Math.hypot(dx, dy) || 1;
            vx[i] += (-dy / L) * PXamt.orbit * pxU * STEP_DT;
            vy[i] += (dx / L) * PXamt.orbit * pxU * STEP_DT;
          }
        }
      }
      if (vortOn) {
        // Tangential / radial pull about one of the box's own axes. Pattern
        // 'vortex' is the shipped one — tangential with a gentle inward bias so
        // the swirl gathers instead of flinging outward.
        fieldAccel(tmp, F.vortex, px[i], py[i], pz[i]);
        vx[i] += tmp[0] * STEP_DT; vy[i] += tmp[1] * STEP_DT; vz[i] += tmp[2] * STEP_DT;
      }
      // PULSE FORCES: the shove itself, on the particles, field or no field.
      for (let b = 0; b < blasts.length; b++) {
        if (blastNow[b].env <= 0) continue;
        burstAccel(bAcc, blastNow[b].x, blastNow[b].y, blasts[b].radius, blasts[b].push, blastNow[b].env, px[i], py[i]);
        vx[i] += bAcc[0] * STEP_DT; vy[i] += bAcc[1] * STEP_DT;
      }
      // Drag +: thicker air near the shape, so an Attract bubble catches what
      // it pulls in instead of slingshotting it straight back out.
      const dragNow = F.drag + (pxU > 0 ? PXamt.drag * pxU : 0);
      if (dragNow > 0) {
        const d = Math.max(0, 1 - dragNow * STEP_DT);
        vx[i] *= d; vy[i] *= d; vz[i] *= d;
        // Thick air slows a spin as it slows travel.
        if (shAngv) shAngv[i] *= d;
      }
      if (fluidOn) {
        // Ride the field: trade own velocity for the field's at Fluid Force's rate.
        fluidVelocityAt(G, fvel, px[i], py[i], pz[i]);
        const rl = reachSources ? relax * influenceAt(px[i], py[i]) : relax;
        vx[i] += (fvel[0] - vx[i]) * rl;
        vy[i] += (fvel[1] - vy[i]) * rl;
        vz[i] += (fvel[2] - vz[i]) * rl;
      } else if (vortices.length || pushers.length) {
        // No field: the force emitters act on the particles directly — a
        // vortex spins them, a blower blends them toward its push.
        for (let v = 0; v < vortices.length; v++) {
          const fe = vortices[v];
          const p = fePos(fe, v, t);
          forcePointAccel(feAcc, fe, p[0], p[1], px[i], py[i], pz[i]);
          vx[i] += feAcc[0] * STEP_DT; vy[i] += feAcc[1] * STEP_DT; vz[i] += feAcc[2] * STEP_DT;
        }
        for (let j = 0; j < pushers.length; j++) {
          const fe = pushers[j];
          const p = fePos(fe, j, t);
          feAcc[0] = vx[i]; feAcc[1] = vy[i];
          jetPointPush(feAcc, p[0], p[1], fe.radius, fe.strength, fe.direction, fe.push, px[i], py[i], STEP_DT);
          vx[i] = feAcc[0]; vy[i] = feAcc[1];
        }
      }
      // LAYER VELOCITY. Applied AFTER the fluid ride, so close to the moving
      // layer the layer wins: it is the thing physically displacing the medium
      // there, and letting the field's own (one step stale) velocity override it
      // makes the drag lag visibly behind the layer.
      if (ldOn) {
        pv[0] = vx[i]; pv[1] = vy[i]; pv[2] = vz[i];
        applyLayerDrives(pv, LD, s, drivers, px[i], py[i], pz[i], STEP_DT, ldScratch);
        vx[i] = pv[0]; vy[i] = pv[1]; vz[i] = pv[2];
      }
      if (followS) {
        pv[0] = vx[i]; pv[1] = vy[i]; pv[2] = vz[i];
        near[i] = pathFollowStep(followS, near[i], px[i], py[i], pz[i], pv, PF, STEP_DT);
        vx[i] = pv[0]; vy[i] = pv[1]; vz[i] = pv[2];
      }

      /*
       * Speed x and Freeze both scale HOW FAR the particle travels this step,
       * not its velocity: a frozen particle keeps the momentum it arrived with,
       * so it resumes when it leaves the field instead of having to be
       * re-accelerated from nothing. At Freeze 100 % it stops dead on the shape
       * and paints the silhouette.
       */
      const travel = pxU > 0 && (PXamt.speed || PXamt.freeze)
        ? STEP_DT * Math.max(0, 1 + PXamt.speed * pxU) * Math.max(0, 1 - PXamt.freeze * pxU)
        : STEP_DT;
      if (shFaceVel) {
        const sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
        if (sp > 1) {
          const m = shMemSlot[i];
          const rim = Math.max(1, shapesIn.bound[m] * shDrawW(i, uid[i], m));
          const wMax = sp / rim;
          // Same target the draw's Face velocity used: the artwork's UP along travel.
          let d = Math.atan2(vy[i], vx[i]) - Math.PI / 2 - shAng[i];
          d -= 6.283185307179586 * Math.round(d / 6.283185307179586);
          const want = clamp(d * SH_FACE_RATE, -wMax, wMax);
          shAngv[i] += (want - shAngv[i]) * Math.min(1, SH_FACE_GAIN * STEP_DT);
        }
      }
      /*
       * PACKING TAKES THE TAIL. Everything above is unchanged and runs exactly
       * as it always has; what changes is that the position update, the
       * collider and the walls stop being per-particle work done here and
       * become a pass over the whole live set below — because a contact is
       * between TWO particles and cannot be resolved one at a time.
       */
      if (PK) {
        pkDvx[i] = vx[i] - pkDvx[i];
        pkDvy[i] = vy[i] - pkDvy[i];
        pkDvz[i] = vz[i] - pkDvz[i];
        pkTravel[i] = travel;
        pkLive[pkN++] = i;
        continue;
      }

      px[i] += vx[i] * travel; py[i] += vy[i] * travel; pz[i] += vz[i] * travel;
      if (retK) {
        px[i] += (homeX[i] - px[i]) * retK;
        py[i] += (homeY[i] - py[i]) * retK;
        pz[i] += (homeZ[i] - pz[i]) * retK;
      }

      if (collAny) {
        cp[0] = px[i]; cp[1] = py[i]; cp[2] = pz[i];
        cv[0] = vx[i]; cv[1] = vy[i]; cv[2] = vz[i];
        // Sequential: each collider corrects in turn, last word to the last one
        // with something to say. See the note where COLL is built.
        let touched = false;
        for (let ci = 0; ci < COLL.length; ci++) {
          const e = COLL[ci];
          const hit = e.follow
            ? resolveCollisionPosed(e.poseAt(s), e.mode, e.halfD, 6, cp, cn, e.open, e.openAmt, e.release)
            : resolveCollision(e.table, e.mode, e.halfD, e.bounce, cp, cv, 6, null, e.open, e.openAmt, e.release);
          if (!hit) continue;
          touched = true;
          if (e.follow) {
            // The posed resolver deliberately leaves velocity alone (packing
            // needs that), so this path applies the bounce itself, exactly as
            // resolveCollision would have.
            const vn = cv[0] * cn[0] + cv[1] * cn[1] + cv[2] * cn[2];
            if (vn < 0) {
              cv[0] -= cn[0] * vn * (1 + e.bounce);
              cv[1] -= cn[1] * vn * (1 + e.bounce);
              cv[2] -= cn[2] * vn * (1 + e.bounce);
            }
          }
          if (e.mode === 2) {
            // The container is a 2.5D extrusion: the box's z walls reflect, so a
            // contained cloud never leaks out of the screen plane.
            if (cp[2] > bz) { cp[2] = bz - (cp[2] - bz); cv[2] = -cv[2] * 0.5; }
            else if (cp[2] < -bz) { cp[2] = -bz + (-bz - cp[2]); cv[2] = -cv[2] * 0.5; }
          }
        }
        if (touched) {
          px[i] = cp[0]; py[i] = cp[1]; pz[i] = cp[2];
          vx[i] = cv[0]; vy[i] = cv[1]; vz[i] = cv[2];
        }
      }

      if (wrap) {
        if (px[i] > bx) px[i] -= bx * 2; else if (px[i] < -bx) px[i] += bx * 2;
        if (py[i] > by) py[i] -= by * 2; else if (py[i] < -by) py[i] += by * 2;
        if (pz[i] > bz) pz[i] -= bz * 2; else if (pz[i] < -bz) pz[i] += bz * 2;
      } else if (bounce) {
        // Reflect position AND velocity, so the particle turns around at the wall
        // instead of sticking to it. Position stays continuous, which is what keeps
        // sampling free to interpolate across the moment (unlike a wrap).
        if (px[i] > bx) { px[i] = bx - (px[i] - bx); vx[i] = -vx[i] * RESTITUTION; }
        else if (px[i] < -bx) { px[i] = -bx + (-bx - px[i]); vx[i] = -vx[i] * RESTITUTION; }
        if (py[i] > by) { py[i] = by - (py[i] - by); vy[i] = -vy[i] * RESTITUTION; }
        else if (py[i] < -by) { py[i] = -by + (-by - py[i]); vy[i] = -vy[i] * RESTITUTION; }
        if (pz[i] > bz) { pz[i] = bz - (pz[i] - bz); vz[i] = -vz[i] * RESTITUTION; }
        else if (pz[i] < -bz) { pz[i] = -bz + (-bz - pz[i]); vz[i] = -vz[i] * RESTITUTION; }
      } else if (px[i] > bx || px[i] < -bx || py[i] > by || py[i] < -by || pz[i] > bz || pz[i] < -bz) {
        uid[i] = 0; S.aliveCount--; diedAtBounds++;
      }
    }

    /* ── PACKING ──────────────────────────────────────────────────────────────
     * The tail the loop above skipped, run over the whole live set at once.
     *
     * ORDER IS THE WHOLE POINT OF THIS BLOCK, and it is the order the lab had to
     * be rebuilt into:
     *
     *   predict -> pairs -> POSITION clamps -> derive v -> wall response -> wrap
     *
     * The clamps here move positions and record a normal; they must not write
     * velocity, because the derivation a line later would throw it away. That is
     * not a theoretical concern — it is how the shipped collider's `bounce` and
     * the box's RESTITUTION both became dead code in the lab, and inert wall
     * friction is why a sand pile slid out flat instead of heaping. The velocity
     * half runs inside packingStep, after the derivation.
     *
     * `wrap` is excluded from the clamp for the same reason and a worse one: it
     * teleports a particle by the width of the box, and (q - p)/h would read
     * that as 2*bx*60 px/s and launch it. It runs after, on committed positions.
     */
    if (PK && pkN > 0) {
      if (shapeOn) {
        // No Radius scale here: it sizes a CIRCLE against a sprite whose visible
        // mass is smaller than its quad. An outline is the artwork's own edge,
        // and scaling it down is exactly the overlap this mode exists to remove.
        setShapeBodies(PK, pkLive, pkN, (i) => shMemSlot[i], (i) => shDrawW(i, uid[i], shMemSlot[i]));
      } else {
        setRadii(PK, pkLive, pkN, pkRadius, pkZOn);
      }
      /*
       * Shape mode's walls and colliders: every circle of the clump is tested
       * on its own, and a hit pushes the BODY at that circle's contact point —
       * so a letter that lands on a corner is turned by it, and one resting on
       * the floor rests on its actual edge rather than on a circle round it.
       * The z walls do not apply: shape mode is flat by definition.
       */
      const SHs = PK.shape;
      const clampShape = (i) => {
        const D = SHs.D;
        const m = SHs.mem[i], sc = SHs.sc[i];
        for (let a = D.offs[m], ae = D.offs[m + 1]; a < ae; a++) {
          const r = D.cr[a] * sc;
          const lx = D.cx[a] * sc, ly = D.cy[a] * sc;
          let x = PK.qx[i] + SHs.cs[i] * lx - SHs.sn[i] * ly;
          let y = PK.qy[i] + SHs.sn[i] * lx + SHs.cs[i] * ly;
          if (collAny) {
            for (let ci = 0; ci < COLL.length; ci++) {
              const e = COLL[ci];
              cp[0] = x; cp[1] = y; cp[2] = PK.qz[i];
              const hit = e.follow
                ? resolveCollisionPosed(e.poseAt(s), e.mode, e.halfD, r, cp, cn, e.open, e.openAmt, e.release)
                : resolveCollision(e.table, e.mode, e.halfD, e.bounce, cp, cv, r, cn, e.open, e.openAmt, e.release);
              if (!hit) continue;
              const depth = (cp[0] - x) * cn[0] + (cp[1] - y) * cn[1];
              if (depth <= 0) continue;
              shapeWallPush(PK, i, x - cn[0] * r, y - cn[1] * r, cn[0], cn[1], depth);
              x = PK.qx[i] + SHs.cs[i] * lx - SHs.sn[i] * ly;
              y = PK.qy[i] + SHs.sn[i] * lx + SHs.cs[i] * ly;
            }
          }
          if (bounce) {
            if (x > bx - r) shapeWallPush(PK, i, x + r, y, -1, 0, x - (bx - r));
            else if (x < -bx + r) shapeWallPush(PK, i, x - r, y, 1, 0, (-bx + r) - x);
            x = PK.qx[i] + SHs.cs[i] * lx - SHs.sn[i] * ly;
            y = PK.qy[i] + SHs.sn[i] * lx + SHs.cs[i] * ly;
            if (y > by - r) shapeWallPush(PK, i, x, y + r, 0, -1, y - (by - r));
            else if (y < -by + r) shapeWallPush(PK, i, x, y - r, 0, 1, (-by + r) - y);
          }
        }
      };
      const clampPos = shapeOn ? clampShape : (i) => {
        const r = PK.rad[i];
        if (collAny) {
          cp[0] = PK.qx[i]; cp[1] = PK.qy[i]; cp[2] = PK.qz[i];
          let anyContainer = false;
          for (let ci = 0; ci < COLL.length; ci++) {
            const e = COLL[ci];
            // The collider's skin is the particle's own radius, not the fixed
            // 6 px: a radius-blind mould lets beads sink half-way into its wall.
            const hit = e.follow
              ? resolveCollisionPosed(e.poseAt(s), e.mode, e.halfD, r, cp, cn, e.open, e.openAmt, e.release)
              : resolveCollision(e.table, e.mode, e.halfD, e.bounce, cp, cv, r, cn, e.open, e.openAmt, e.release);
            if (hit) {
              PK.qx[i] = cp[0]; PK.qy[i] = cp[1]; PK.qz[i] = cp[2];
              markWall(PK, i, cn[0], cn[1], cn[2]);
            }
            if (e.mode === 2) anyContainer = true;
          }
          // The container's z walls, but only on a box with depth to speak of.
          // On a FLAT box (the 2D read) `bz` is under a particle radius, so this
          // fired every frame on every particle and recorded a z normal that
          // wallResponse then discarded — harmless, and a phantom wall hit is
          // not something to leave lying next to a real one.
          if (anyContainer && pkZOn) {
            if (PK.qz[i] > bz - r) { PK.qz[i] = bz - r; markWall(PK, i, 0, 0, -1); }
            else if (PK.qz[i] < -bz + r) { PK.qz[i] = -bz + r; markWall(PK, i, 0, 0, 1); }
          }
        }
        // The solver box. Only 'bounce' is a wall — 'wrap' and 'kill' let the
        // particle through and are settled after the step.
        if (bounce) {
          if (PK.qx[i] > bx - r) { PK.qx[i] = bx - r; markWall(PK, i, -1, 0, 0); }
          else if (PK.qx[i] < -bx + r) { PK.qx[i] = -bx + r; markWall(PK, i, 1, 0, 0); }
          if (PK.qy[i] > by - r) { PK.qy[i] = by - r; markWall(PK, i, 0, -1, 0); }
          else if (PK.qy[i] < -by + r) { PK.qy[i] = -by + r; markWall(PK, i, 0, 1, 0); }
          if (pkZOn) {
            if (PK.qz[i] > bz - r) { PK.qz[i] = bz - r; markWall(PK, i, 0, 0, -1); }
            else if (PK.qz[i] < -bz + r) { PK.qz[i] = -bz + r; markWall(PK, i, 0, 0, 1); }
          }
        }
      };
      packingStep(
        PK, px, py, pz, vx, vy, vz, pkLive, pkN, STEP_DT, pkZOn,
        clampPos, (i) => pkTravel[i], pkDvx, pkDvy, pkDvz,
      );
      // Wrap and kill, on committed positions, after the derivation. Either one
      // invalidates the occupancy index — see reindexOccupancy.
      let pkDirty = false;
      // RETURN on the committed positions too, as the loop above does for every
      // particle packing does not own. It moves positions, so the occupancy the
      // next birth reads has to follow — the same rule as the wrap below.
      if (retK) {
        for (let k = 0; k < pkN; k++) {
          const i = pkLive[k];
          px[i] += (homeX[i] - px[i]) * retK;
          py[i] += (homeY[i] - py[i]) * retK;
          pz[i] += (homeZ[i] - pz[i]) * retK;
          PK.qx[i] = px[i]; PK.qy[i] = py[i]; PK.qz[i] = pz[i];
        }
        pkDirty = true;
      }
      if (wrap) {
        for (let k = 0; k < pkN; k++) {
          const i = pkLive[k];
          if (px[i] > bx) px[i] -= bx * 2; else if (px[i] < -bx) px[i] += bx * 2;
          if (py[i] > by) py[i] -= by * 2; else if (py[i] < -by) py[i] += by * 2;
          if (pz[i] > bz) pz[i] -= bz * 2; else if (pz[i] < -bz) pz[i] += bz * 2;
          /*
           * THE OCCUPANCY GRID HAS TO FOLLOW THE WRAP.
           *
           * `occupied()` reads PK.qx/qy/qz — the positions the contact grid was
           * built from — and next frame's emission asks it whether a point is
           * free. Wrapping moved the particle and left those behind, so emission
           * would defend the place it USED to be and hand out the place it now
           * IS. Both halves are wrong, and the second one puts a birth inside a
           * live particle, which is the exact failure this check exists for.
           */
          PK.qx[i] = px[i]; PK.qy[i] = py[i]; PK.qz[i] = pz[i];
          pkDirty = true;
          // A wrapped particle is somewhere else entirely; its sleep anchor and
          // its neighbours are both stale, so it must not stay asleep on them.
          PK.slept[i] = 0; PK.sleepT[i] = 0;
          PK.anx[i] = px[i]; PK.any[i] = py[i]; PK.anz[i] = pz[i];
        }
      } else if (!bounce) {
        for (let k = 0; k < pkN; k++) {
          const i = pkLive[k];
          if (px[i] > bx || px[i] < -bx || py[i] > by || py[i] < -by || pz[i] > bz || pz[i] < -bz) {
            uid[i] = 0; S.aliveCount--; diedAtBounds++;
            pkDirty = true;
            // A dead slot is reused by the next spawn, so its sleep state has to
            // go with it or the new particle is born frozen.
            PK.slept[i] = 0; PK.sleepT[i] = 0;
          }
        }
      }
      /*
       * Re-index, but only when something actually moved or left. Writing
       * PK.qx/qy/qz for a wrapped particle fixes what `occupied` READS and not
       * where the grid FILED it — the buckets still point at the old cell, so a
       * query at the new position looks in the right bucket and finds nothing.
       * Reproduced with a wrapped particle at x = -4.9 that `occupied` reported
       * as free.
       */
      if (pkDirty) {
        let m = 0;
        for (let k = 0; k < pkN; k++) { const i = pkLive[k]; if (uid[i]) pkLive[m++] = i; }
        reindexOccupancy(PK, pkLive, m, pkZOn);
      }
      pkN = 0;
    }

    // ── snapshot ────────────────────────────────────────────────────────────
    while (snap < snapCount && t >= snap / cacheHz - 1e-9) {
      const base = snap * maxP;
      uids.set(uid, base);
      for (let i = 0; i < maxP; i++) {
        const o = (base + i) * STRIDE;
        data[o] = px[i]; data[o + 1] = py[i]; data[o + 2] = pz[i];
        data[o + 3] = age[i];
        data[o + 4] = TTL_ALIVE;   // filled by the backward pass below
      }
      if (shRot) {
        /*
         * The body turns about its CENTRE OF MASS; the artwork is drawn about
         * the middle of its quad, and for a K or an L those are not the same
         * point. The snapshot stores where the QUAD goes, so the draw needs
         * nothing but the angle.
         */
        for (let i = 0; i < maxP; i++) {
          if (!uid[i]) continue;
          const m = shMemSlot[i];
          const w = shDrawW(i, uid[i], m);
          const c = Math.cos(shAng[i]), sn = Math.sin(shAng[i]);
          const ox = shapesIn.comX[m] * w, oy = shapesIn.comY[m] * w;
          const o = (base + i) * STRIDE;
          data[o] = px[i] - (c * ox - sn * oy);
          data[o + 1] = py[i] - (sn * ox + c * oy);
          shRot[base + i] = shAng[i];
        }
      }
      snap++;
      if (onChunk && snap % CHUNK_SNAPS === 0) {
        const from = chunkFrom;
        onChunk({
          from, to: snap, maxP, cacheHz, snapCount, duration: dur,
          data: data.subarray(from * maxP * STRIDE, snap * maxP * STRIDE),
          uids: uids.subarray(from * maxP, snap * maxP),
          rot: shRot ? shRot.subarray(from * maxP, snap * maxP) : null,
          lifeOf, releaseOf,
          wrap: wrap ? { x: bx, y: by, z: bz } : null,
        });
        chunkFrom = snap;
      }
    }
    if (snap >= snapCount) break;
  }

  // The remainder: the step loop ends before the padded tail (snapCount holds
  // two spare snapshots), so the last chunk is flushed here, not on a boundary.
  if (onChunk && snap > chunkFrom) {
    onChunk({
      from: chunkFrom, to: snap, maxP, cacheHz, snapCount, duration: dur,
      data: data.subarray(chunkFrom * maxP * STRIDE, snap * maxP * STRIDE),
      uids: uids.subarray(chunkFrom * maxP, snap * maxP),
      rot: shRot ? shRot.subarray(chunkFrom * maxP, snap * maxP) : null,
      lifeOf, releaseOf,
      wrap: wrap ? { x: bx, y: by, z: bz } : null,
    });
    chunkFrom = snap;
  }

  // The padded tail (snapCount holds two spare snapshots the step loop never
  // reaches) repeats the last written snapshot, so a read at exactly t =
  // duration — where the playhead rests after playback — shows the final
  // frame instead of interpolating toward an empty one and drawing nothing.
  if (snap > 0) {
    for (let s2 = snap; s2 < snapCount; s2++) {
      data.copyWithin(s2 * maxP * STRIDE, (snap - 1) * maxP * STRIDE, snap * maxP * STRIDE);
      uids.copyWithin(s2 * maxP, (snap - 1) * maxP, snap * maxP);
      if (shRot) shRot.copyWithin(s2 * maxP, (snap - 1) * maxP, snap * maxP);
    }
  }

  // ── Progressive delivery ──────────────────────────────────────────────────
  // opts.onChunk({ from, to, ... }) is called as snapshots complete (every
  // CHUNK_SNAPS), so a caller baking off-thread can show the clip filling in
  // instead of nothing for thirty seconds. Chunks carry no TTL yet (that needs
  // the whole clip — see the backward pass below); the final cache replaces them.
  // (The calls happen inside the step loop above; the constant lives here so the
  // two are read together.)

  // ── Time-to-live, walking the finished cache BACKWARDS ────────────────────
  //
  // The first time a particle is met going backwards is its LAST snapshot, and a
  // particle is only ever drawn while two snapshots agree about it (see
  // sampleParticles) — so that snapshot is the moment it stops being drawn, and
  // ttl there is 0. Anchoring on the step after it instead leaves ttl at a 30th of
  // a second on the last visible frame, which makes a fade end at 13% and pop.
  // A particle still present in the final snapshot is left as TTL_ALIVE: the clip
  // ends before anything happens to it, and fading it out there would be inventing
  // a death the simulation never had.
  {
    const lastUid = new Int32Array(maxP);
    const deathAt = new Float64Array(maxP);
    for (let sIdx = snapCount - 1; sIdx >= 0; sIdx--) {
      const t = sIdx / cacheHz;
      const base = sIdx * maxP;
      for (let i = 0; i < maxP; i++) {
        const u = uids[base + i];
        if (!u) { lastUid[i] = 0; continue; }
        if (u !== lastUid[i]) {
          lastUid[i] = u;
          deathAt[i] = sIdx === snapCount - 1 ? Infinity : t;
        }
        data[(base + i) * STRIDE + 4] = deathAt[i] === Infinity
          ? TTL_ALIVE
          : Math.max(0, deathAt[i] - t);
      }
    }
  }

  return {
    maxP,
    cacheHz,
    snapCount,
    data,
    uids,
    // Shape mode only: the angle of every slot in every snapshot, beside `data`.
    rot: shRot,
    lifeOf,
    releaseOf,
    duration: dur,
    // Half-extents when the box WRAPS, so sampling can tell a teleport from
    // motion. Null for kill bounds, where no position is ever discontinuous.
    wrap: wrap ? { x: bx, y: by, z: bz } : null,
    bytes: data.byteLength + uids.byteLength + lifeOf.byteLength + releaseOf.byteLength + (shRot ? shRot.byteLength : 0),
    bakeMs: (typeof performance !== 'undefined' ? performance.now() : 0) - t0,
    // Why particles ended, so "they keep disappearing" is answerable from the
    // inspector instead of by reading this file.
    deaths: { age: diedOfAge, bounds: diedAtBounds, dropped: S.dropped, blocked: S.blocked, pending: pendingSpawn },
    // Grow Points: how the front got on. `neverActivated` is the honest count of
    // sites the sweep never reaches at this Speed, which is the difference
    // between "my dissolve is incomplete" and "my Speed is too low".
    grow: growOn ? { on: true, frozen, sites: maxP, neverActivated } : null,
  };
}

/**
 * Read the cache at an absolute clip-local time into `out`, a flat Float32Array of
 * 9 floats per live particle: x, y, z, age, life, vx, vy, vz, ttl — plus the uid in
 * a parallel Int32Array `outUid`. Returns the number of live particles written.
 *
 * Velocity is differenced from the two surrounding snapshots (it is not stored),
 * which is exactly what velocity stretch needs and costs nothing to keep.
 */
// `outRot` (optional, one float per particle) receives the simulated angle when
// the cache has one — Packing's object-shape mode. Left untouched otherwise.
export function sampleParticles(cache, time, out, outUid, outRot = null) {
  const { maxP, cacheHz, snapCount, data, uids, lifeOf, releaseOf } = cache;
  // Shape mode's simulated angle, when the cache has one and the caller wants it.
  const rot = outRot && cache.rot ? cache.rot : null;
  const t = clamp(time, 0, cache.duration);
  const f = t * cacheHz;
  // A PARTIAL cache (still baking, delivered in chunks) draws nothing beyond
  // its last snapshot — the clip fills in behind the bake rather than showing
  // a frozen frame where nothing has been simulated yet.
  if (cache.baked != null && f > cache.baked - 1) return 0;
  const i0 = Math.min(snapCount - 1, Math.floor(f));
  const i1 = Math.min(snapCount - 1, i0 + 1);
  const fr = clamp01(f - i0);
  const b0 = i0 * maxP, b1 = i1 * maxP;

  const wrap = cache.wrap;
  let n = 0;
  for (let i = 0; i < maxP; i++) {
    const u0 = uids[b0 + i], u1 = uids[b1 + i];
    // Only what BOTH snapshots agree is the same particle gets drawn.
    //
    // The tempting fallbacks — hold a dying particle's last state, show a newborn
    // from the later snapshot — each put a frozen stamp on screen for up to a
    // 30th of a second. On a dust mote that is invisible; on a spinning layer
    // object it reads as the thing stopping dead, snapping, and being deleted.
    // Both ends of a life sit where the colour ramp is transparent anyway, so
    // skipping costs nothing and removes the artefact.
    if (!u0 || u0 !== u1) continue;
    const o0 = (b0 + i) * STRIDE, o1 = (b1 + i) * STRIDE;
    let x, y, z, a, l, dx = 0, dy = 0, dz = 0;
    const u = u0;

    // A WRAPPED particle teleports from one wall to the other between snapshots.
    // Interpolating across that draws it streaking through the whole box in a
    // single frame — the "fast travelling" particle. Take the nearer snapshot
    // whole instead, and report no velocity for that frame.
    const wrapped = wrap
      && (Math.abs(data[o1] - data[o0]) > wrap.x
        || Math.abs(data[o1 + 1] - data[o0 + 1]) > wrap.y
        || Math.abs(data[o1 + 2] - data[o0 + 2]) > wrap.z);

    let ttl;
    // Constant for this particle's whole life, so it is looked up by uid rather
    // than read out of the snapshot it no longer lives in.
    const life = lifeOf[u] || 1e-4;
    const rel = releaseOf[u] || 0;
    if (wrapped) {
      const o = fr < 0.5 ? o0 : o1;
      x = data[o]; y = data[o + 1]; z = data[o + 2]; a = data[o + 3];
      l = life;
      ttl = data[o + 4];
    } else {
      x = lerp(data[o0], data[o1], fr);
      y = lerp(data[o0 + 1], data[o1 + 1], fr);
      z = lerp(data[o0 + 2], data[o1 + 2], fr);
      a = lerp(data[o0 + 3], data[o1 + 3], fr);
      l = life;
      dx = (data[o1] - data[o0]) * cacheHz;
      dy = (data[o1 + 1] - data[o0 + 1]) * cacheHz;
      dz = (data[o1 + 2] - data[o0 + 2]) * cacheHz;
      // Counts down between snapshots, so a fade is smooth rather than stepped.
      ttl = Math.min(data[o0 + 4], data[o1 + 4] + (1 / cacheHz)) - fr / cacheHz;
      if (data[o0 + 4] >= TTL_ALIVE) ttl = TTL_ALIVE;
    }
    const k = n * SAMPLE_STRIDE;
    out[k] = x; out[k + 1] = y; out[k + 2] = z;
    out[k + 3] = a; out[k + 4] = l;
    out[k + 5] = dx; out[k + 6] = dy; out[k + 7] = dz;
    out[k + 8] = Math.max(0, ttl);
    out[k + 9] = rel;
    if (rot) {
      // Stored unwrapped (it is integrated, never reduced mod 2pi), so a plain
      // lerp turns the short way and needs no special case.
      outRot[n] = wrapped ? rot[fr < 0.5 ? b0 + i : b1 + i] : lerp(rot[b0 + i], rot[b1 + i], fr);
    }
    outUid[n] = u;
    n++;
  }
  return n;
}
