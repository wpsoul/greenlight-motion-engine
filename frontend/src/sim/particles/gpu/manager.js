/*
 * The Tier 2 runtime manager — one runtime per particle layer, created on
 * demand, advanced to the playhead, and released when the layer goes away.
 * Phase 6 of PLANS/VIDEO_EDITOR_PARTICLE_GPU_SCALE_PLAN.md.
 *
 * This is the mirror of `lives` in client.js and follows the same discipline:
 * NOTHING HERE POLLS ANYTHING. A layer that is not being drawn is not stepped,
 * so a project with a Solver Box costs nothing while the playhead sits still.
 *
 * It is a separate module from client.js for the reason client.js gives about
 * gpuEngine.js: the editor imports client.js statically for its status
 * readouts, and a static import of the runtime would put the whole engine — the
 * WGSL, the pipelines, the device request — into the editor's bundle for every
 * project, including the ones with no particles at all.
 */

import { createGpuParticleRuntime, STEP_DT } from './gpuRuntime.js';
import { createEmission, fieldSplats, forceEmitterSetup } from '../emission.js';
import { prepareDistribution } from '../distribution.js';
import { chooseTier, TIER, gcParticleReservations, probeWebGpu, particleBudget, checkpointPlan } from './tier.js';
import { PARTICLE_MAX_CPU, PARTICLE_SMOOTH_GPU, PARTICLE_MAX_GPU, PARTICLE_MAX_PARTICLES } from '../schema.js';

const runtimes = new Map();   // key -> { rt, hash, w, h, failed, reason }
const reasons = new Map();

/*
 * REPAINT WHEN A RUNTIME LANDS.
 *
 * Creating the device, the pipelines and the pool is asynchronous, so the frame
 * that asked for a runtime is always drawn without one. Something has to repaint
 * when it arrives, and for a Tier 2 layer there is no bake underneath to show
 * meanwhile — the layer is simply EMPTY until the next repaint happens for some
 * other reason.
 *
 * At two hundred thousand the device is up in a few hundred milliseconds and
 * some later frame always caught it. At eight million the pool is a gigabyte:
 * the runtime landed after the editor had gone idle, nothing repainted, and the
 * layer stayed blank for good — with `ready: true` and no error anywhere,
 * which is the worst possible way for this to fail.
 *
 * The same listener the bake uses, for the same reason.
 */
let onReady = null;
export function setGpuReadyListener(fn) { onReady = typeof fn === 'function' ? fn : null; }

/** Why `key` is not on Tier 2, in a sentence, or '' when it is. */
export function gpuTierReason(key) { return reasons.get(key) || ''; }

/**
 * Whether this system wants Tier 2, and whether it can have it.
 * `webgpu` must be the resolved answer from probeWebGpu().
 */
export function gpuTierFor(system, webgpu) {
  return chooseTier(system, {
    webgpu, maxCpu: PARTICLE_MAX_CPU, bakeMax: PARTICLE_MAX_PARTICLES,
    smoothGpu: PARTICLE_SMOOTH_GPU, maxGpu: PARTICLE_MAX_GPU,
  });
}

/**
 * Everything about the system a runtime cannot change without being rebuilt.
 *
 * THE PLATE'S SIZE IS NOT ONE OF THOSE THINGS, and having it here made every
 * Tier 2 layer INVISIBLE WHILE THE CLIP PLAYED. The size passed in is the
 * renderer's drawing buffer, and the editor lowers its raster density during
 * playback — so the hash changed, the runtime was disposed and rebuilt, and a
 * rebuild answers `null` until its device comes back. At sixty frames a second
 * that is a runtime destroyed and recreated before any of them ever became
 * ready: the layer drew nothing for the whole of playback and then appeared the
 * moment the playhead stopped and the size settled.
 *
 * The contradiction was visible in this very function's caller, which calls
 * `rt.resize(width, height)` two lines later — the plate was always meant to
 * follow the layer's size rather than be rebuilt for it.
 *
 * What genuinely cannot change under a running runtime: the pool size, the seed,
 * and the emitter shape and direction mode, which are baked into its pipelines.
 */
/**
 * Which set is currently loaded in the shared position buffer, or null for
 * neither. Exported only so it can be tested: the failure it guards against is
 * a STALE buffer — an emitter firing from the previous occupant's points —
 * which draws a perfectly plausible picture of the wrong thing, and would never
 * throw. Namespaced prefixes so a relaxed key can never collide with an artwork
 * key that happens to read the same.
 */
export function spawnPositionsKey(dist, spawnTable, tableKey) {
  if (dist?.relax) return `relax:${dist.relax.key}`;
  if (spawnTable?.positions) return `spawn:${tableKey}`;
  return null;
}

function buildHash(system) {
  const s = system.solver;
  const e = system.emitters[0] || {};
  return JSON.stringify([s.maxParticles, system.seed, e.shape, e.dirMode]);
}

/**
 * The runtime for `key`, advanced to `time`, or null.
 *
 * Returns null rather than throwing on every failure path — no WebGPU, a pool
 * past the shared budget, a device lost. The layer falls back to the bake and
 * `gpuTierReason(key)` says why, which is what the panel shows.
 */
export function ensureParticleGpu(key, system, duration, opts = {}) {
  const { width, height, time = 0, webgpu = false, spawnTable = null, emitPath = null } = opts;
  const decision = gpuTierFor(system, webgpu);
  if (decision.tier !== TIER.GPU) {
    reasons.set(key, decision.reason);
    dropParticleGpu(key);
    return null;
  }

  const hash = buildHash(system);
  let L = runtimes.get(key);
  if (L && L.hash !== hash) { L.rt?.dispose(); runtimes.delete(key); L = null; }
  if (L && L.failed) return null;

  if (!L) {
    const rt = createGpuParticleRuntime({
      key, maxParticles: decision.clampedTo, width, height, seed: system.seed | 0,
    });
    L = { rt, hash, failed: false, ready: false };
    runtimes.set(key, L);
    rt.ready.then((ok) => {
      if (!ok) {
        L.failed = true;
        reasons.set(key, rt.error || 'the GPU particle engine could not start');
      } else {
        L.ready = true;
        reasons.set(key, '');
      }
      // Either way the layer must be redrawn: ready means it can finally paint,
      // failed means it has to fall back to the bake, and both are invisible
      // until something asks for a frame.
      try { onReady?.(key); } catch { /* listener gone */ }
    });
    return null;   // the layer draws from the bake until the runtime lands
  }
  if (!L.ready) return null;

  const rt = L.rt;
  if (rt.resize(width, height)) { /* the plate follows the layer's render size */ }
  // The artwork COLOURS ride in their own buffer, read by the derive pass.
  if (spawnTable?.colors && L.colorKey !== opts.tableKey) {
    rt.setSpawnTable(spawnTable.colors);
    L.colorKey = opts.tableKey;
  }
  if (emitPath && L.pathKey !== opts.pathKey) { rt.setEmitPath(emitPath); L.pathKey = opts.pathKey; }

  // Uniforms are free to change every frame — the emitter, the forces and the
  // schedule are all re-read here, so a slider moves the system NOW rather than
  // after a rebuild.
  const e = system.emitters[0] || {};
  const poolN = Math.max(1, Math.round(system.solver.maxParticles));

  /*
   * ONE BUFFER, TWO POSSIBLE OCCUPANTS.
   *
   * `tablePos` holds either a LAYER emitter's artwork sites or a RELAXED set —
   * never both, because prepareDistribution refuses relaxed on a layer emitter
   * (they would want the same buffer, and the two even have different strides:
   * 2 floats a site against 3). Sharing it is what let the relaxed mode ship
   * without a new binding and a bind-group layout change.
   *
   * ONE key records which is loaded, rather than one key each. With separate
   * keys, switching from a layer emitter to a relaxed box would leave the layer
   * table's key satisfied, the relaxed set never uploaded, and the emitter
   * quietly firing from artwork positions it no longer has anything to do with.
   *
   * Keyed rather than unconditional because setSpawnPositions DESTROYS and
   * recreates the buffer and rebinds every slab; doing that per frame would be
   * a rebind storm on a path this function runs sixty times a second.
   */
  const dist = prepareDistribution(e, system.seed | 0, poolN);
  const wantPos = spawnPositionsKey(dist, spawnTable, opts.tableKey);
  if (wantPos && L.posKey !== wantPos) {
    rt.setSpawnPositions(dist.relax ? dist.relax.points : spawnTable.positions);
    L.posKey = wantPos;
  }
  const F = system.forces || {};
  const box = system.solver.bounds.size;
  rt.configureEmitter(e, {
    // SPREAD THE WHOLE FORCES BLOCK. Listing fields by hand is how turbulence
    // and the vortex went missing: the runtime read `forces.turbulence`, this
    // object never carried it, and eight of the ten presets quietly ran on
    // gravity and drag alone. Anything the runtime learns to read is now already
    // here.
    ...F,
    /*
     * WIND IS FOLDED INTO GRAVITY, which is what both other engines do —
     * solver.js adds `F.wind * dt` in the same place it adds gravity, and
     * gpuEngine.js packs `gravity + wind` into one lane. A constant acceleration
     * plus a constant acceleration is a constant acceleration.
     *
     * This matters more than it looks: the default wind is (8, 0, 0), NON-ZERO,
     * so every system in the app has some. Dropping it silently made every Tier 2
     * layer drift straight where the bake drifted sideways, and treating it as an
     * unsupported feature instead would have sent every project back to Tier 1.
     */
    gravity: {
      x: (F.gravity?.x || 0) + (F.wind?.x || 0),
      y: (F.gravity?.y || 0) + (F.wind?.y || 0),
      z: (F.gravity?.z || 0) + (F.wind?.z || 0),
    },
    drag: F.drag || 0,
    boundsMode: system.solver.bounds.behavior === 'wrap' ? 1 : system.solver.bounds.behavior === 'bounce' ? 2 : 0,
    box,
    restitution: 0.6,
  }, {
    preRoll: system.solver.preRoll || 0,
    // The LAYER table's length, and only that: the shape 6 branch gates on it.
    // A relaxed set has its own count in distSites, so the two cannot be
    // confused even though they share the buffer.
    tableCount: (e.shape === 'layer' && spawnTable?.count) || 0,
    pathN: emitPath ? emitPath.length / 6 : 0,
    seed: system.seed | 0,
    poolSize: Math.max(1, Math.round(system.solver.maxParticles)),
  });

  // THE FLUID. Without this the medium never advances and every preset whose
  // look comes from it — Rising Smoke, Ember Swirl, Shockwave, Ink Drop,
  // Cigarette — moves like a system with no fluid at all: nothing slows the
  // particles and nothing swirls them, so they simply fly out.
  const fluidOn = rt.configureFluid(F, box, {});
  if (fluidOn) {
    /*
     * THE STIR SITES, FROM THE REAL EMISSION CODE.
     *
     * The bake stirs the medium where particles are actually born. Re-deriving
     * those positions here by hand would be a second implementation of emission
     * that could drift from the first, so `createEmission` — the very module the
     * bake and the old live engine share — is run against a THROWAWAY 24-slot
     * pool with its uid counter synced to the GPU's. It computes the same births
     * from the same seed, and only the first two dozen are needed: the splats
     * are what the field feels, not a particle census.
     *
     * ~24 hash evaluations a step. The GPU still owns every real particle.
     */
    const N = 24;
    const mk = (n) => new Float32Array(n);
    const arrays = { px: mk(N), py: mk(N), pz: mk(N), vx: mk(N), vy: mk(N), vz: mk(N),
      age: mk(N), life: mk(N), uid: new Int32Array(N), near: new Int32Array(N).fill(-1) };
    const smoke = F.fluid?.model === 'smoke';
    const { jets, smokers, fePos } = forceEmitterSetup(system, true);
    const splatOut = [];
    const preRoll = system.solver.preRoll || 0;
    const NO_SITES = [];

    /*
     * A STEP WITH NO BIRTHS STILL HAS A MEDIUM TO STIR.
     *
     * This used to open with `if (!spawnCount) return null`, which skipped the
     * whole splat build — and with it the BLOWERS AND THERMALS, which are
     * sources in their own right and know nothing about emission. The result
     * was that the field was only ever pushed on the steps a particle happened
     * to be born on: a burst-only emitter (or one whose rate is 0) stirred the
     * medium on exactly the one step its burst fired and never again, so the
     * plume never rose and the burst's own particles sat still. Only the SITES
     * are conditional; fieldSplats runs every step, as it does in the bake
     * (solver.js) and in the live engine (gpuEngine.js).
     */
    rt.setSiteProvider((t, firstUid, spawnCount) => {
      let sites = NO_SITES;
      if (spawnCount > 0) {
        arrays.uid.fill(0);
        const S = { nextUid: firstUid, cursor: 0, aliveCount: 0, dropped: 0 };
        const emitter = createEmission({ arrays, S, em: e, seed: system.seed | 0, maxP: N,
          // N is 24 — a throwaway pool for the splats. Auto sites must still
          // resolve to the real setting or the stir happens at different
          // positions from the particles it is supposed to follow.
          distPool: Math.max(1, Math.round(system.solver.maxParticles)),
          spawnTable, colliderTable: null, collMode: 0, collHalfD: 0, emitPathS: emitPath });
        emitter.spawn(Math.min(N, spawnCount));
        sites = emitter.sites;
      }

      // CALL fieldSplats, DO NOT REIMPLEMENT IT.
      //
      // The first version of this built the splats by hand and got two things
      // wrong that a reading would not have caught: it used `heat` raw where the
      // bake uses `heat / 18`, so a Cigarette got eighteen times the buoyancy and
      // its laminar column blew apart into a cloud three times too wide; and it
      // took the FIRST few sites where the bake takes a seeded random pick, which
      // loses the emission-variance wobble that makes puffs instead of a carpet.
      //
      // Both are the kind of constant that only exists in this function. Calling
      // it is the only way the two stay the same thing.
      const step = Math.round((t + preRoll) / STEP_DT);
      fieldSplats(splatOut, {
        em: e, smoke, heat: F.fluid?.smoke?.heat ?? 55, jets, smokers, fePos,
        seed: system.seed | 0, arrays, sites,
      }, t, step);
      if (!splatOut.length) return null;
      return splatOut.map((q) => ({ x: q.x, y: q.y, z: q.z, r: q.r,
        vx: q.tvx, vy: q.tvy, vz: q.tvz, k: q.k, den: q.den, heat: q.heat }));
    });
  }

  /*
   * CHECKPOINTS, SIZED TO WHAT THE BUDGET WILL BEAR.
   *
   * The runtime has had these since Phase 5 and nothing ever turned them on, so
   * every backward scrub re-ran the clip from zero — at a million particles and
   * a few milliseconds a step, dragging the playhead back six seconds was over a
   * second of dead editor, every time.
   *
   * Set once per runtime — setCheckpoints tears down and re-allocates, so calling
   * it every frame would be worse than not having them at all.
   *
   * THE PLAN CURRENTLY COMES BACK ZERO, from measurement rather than from
   * caution: see checkpointPlan in tier.js for the table. Driven in the editor
   * they made scrubbing slower at every size that could afford them, because the
   * re-run they replace stopped being expensive once every pass became bounded
   * by usedSlots(). The call stays here so that turning them back on is a
   * one-line change in one place if the per-step cost ever grows.
   */
  if (!L.ckPlanned) {
    L.ckPlanned = true;
    const plan = checkpointPlan(rt.cap, duration);
    L.ckAffordable = plan.affordable;
    L.checkpoints = plan.n ? rt.setCheckpoints(plan.n, plan.every) : 0;
  }

  // Step to the playhead. A backward seek restores the nearest checkpoint; with
  // none it re-runs from zero, which is why seekCostSteps exists for the panel.
  const target = Math.max(0, Math.min(time, duration + STEP_DT));
  rt.advanceTo(target);
  return rt;
}

/**
 * Whether Tier 2 owns this layer's pixels — a runtime exists for it and has not
 * failed, so nothing else should be simulating the same system.
 *
 * `true` covers the frames between "the runtime was created" and "the device
 * answered", which is when the layer draws nothing at all. That gap is a few
 * frames; the alternative is baking a hundred thousand particles the runtime is
 * about to make redundant, on every layer, for the whole session.
 */
export function gpuOwnsLayer(key) {
  const L = runtimes.get(key);
  return !!L && !L.failed;
}

/** Resolves once every runtime created so far has answered ready-or-failed. */
export function gpuRuntimesSettled() {
  return Promise.all([...runtimes.values()].map((L) => L.rt?.ready).filter(Boolean));
}

/**
 * Is any runtime still being created?
 *
 * A COLD PAGE HAS NO RUNTIMES AT ALL, which is why waiting before the first
 * render cannot work: there is nothing to wait for until a frame has asked for
 * one. The export path therefore renders first and asks this afterwards — a
 * layer whose runtime is mid-construction draws nothing, and on Tier 2 there is
 * no bake underneath to cover for it, so the frame would encode empty.
 */
export function gpuRuntimesPending() {
  for (const L of runtimes.values()) if (!L.ready && !L.failed) return true;
  return false;
}

/** Drop one layer's runtime and its share of the budget. */
export function dropParticleGpu(key) {
  const L = runtimes.get(key);
  if (!L) return;
  L.rt?.dispose();
  runtimes.delete(key);
}

/** Mirrors gcParticleCaches: anything not in `liveKeys` is gone. */
export function gcParticleGpu(liveKeys) {
  for (const k of [...runtimes.keys()]) if (!liveKeys.has(k)) dropParticleGpu(k);
  gcParticleReservations(liveKeys);
}

export function disposeAllParticleGpu() {
  for (const k of [...runtimes.keys()]) dropParticleGpu(k);
  reasons.clear();
}

/**
 * Wait for every runtime to finish the frames it has submitted.
 *
 * EXPORT AWAITS THIS AND THE PREVIEW DOES NOT. `renderParticleLayer` is called
 * synchronously inside the frame build, so the step cannot be awaited there;
 * the export loop pumps here instead, before the composite. In the preview the
 * plate is one frame stale, which is invisible.
 */
export async function pumpParticleGpu() {
  const live = [...runtimes.values()].filter((L) => L.ready && L.rt?.ok);
  await Promise.all(live.map((L) => L.rt.settle()));
  return live.length;
}

/** TESTS ONLY — what each layer's runtime believes, read from the real app. */
export function debugRuntimes() {
  const out = [];
  for (const [key, L] of runtimes) {
    out.push({ key, ready: !!L.ready, failed: !!L.failed, error: L.rt?.error || '',
      simT: L.rt?.now ? +L.rt.now().toFixed(3) : null,
      uids: L.rt?.uidIssued ? L.rt.uidIssued() : null,
      cap: L.rt?.cap ?? null, vramMb: L.rt?.stats?.vramMb ?? null,
      slabs: L.rt?.slabs ?? 1, slabCap: L.rt?.slabCap ?? null,
      ckMax: L.checkpoints ?? 0,
      ckHeld: L.rt?.checkpointCount ? L.rt.checkpointCount() : 0,
      ckMb: L.rt?.stats?.checkpointMb ?? 0,
      canvas: L.rt?.canvas ? `${L.rt.canvas.width}x${L.rt.canvas.height}` : null });
  }
  return out;
}

/** TESTS AND THE PANEL — the shared VRAM ledger's current state. */
export function particleGpuBudget() { return particleBudget(); }

export { probeWebGpu };
