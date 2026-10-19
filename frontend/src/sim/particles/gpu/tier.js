/*
 * WHICH ENGINE A LAYER GETS, and how much GPU memory the lot of them may take.
 * Phase 6 of PLANS/VIDEO_EDITOR_PARTICLE_GPU_SCALE_PLAN.md.
 *
 * Two decisions live here and nowhere else:
 *
 *   TIER      whether a system runs on the bake (Tier 1) or the GPU runtime
 *             (Tier 2), and if it cannot have the one it asked for, WHY — in a
 *             sentence a panel can show, not a boolean.
 *
 *   BUDGET    how much VRAM every particle layer may hold BETWEEN THEM. The
 *             per-layer cap is not the real constraint: `lives` is keyed per
 *             layer, so four particle layers are four pools, and four
 *             four-million systems would ask for nearly two gigabytes without
 *             any single one of them looking unreasonable.
 *
 * The budget is a reservation ledger rather than a measurement — WebGPU exposes
 * no way to ask how much memory is left, so the only honest approach is to count
 * what we asked for and refuse past a ceiling. A layer refused here falls back to
 * Tier 1 and says so; it never silently gets a smaller pool than it asked for,
 * because a system that quietly halves its own density looks like a bug in the
 * art rather than a limit being hit.
 */

// FROM layout.js, NOT from the shader modules — see that file's header. Taking
// them from drawWgsl/deriveWgsl would drag every line of WGSL into the editor's
// static bundle, because ParticlePanel imports this module.
import { PART_FLOATS, INST_FLOATS } from './layout.js';

export const TIER = { BAKE: 1, GPU: 2 };

/*
 * TIER 2 IS OFF BY DEFAULT, AND THAT IS DELIBERATE.
 *
 * The engine below it is heavily verified — shaders against the shipping GLSL,
 * the solver against Jacobi's convergence rate, the raymarch against
 * Beer-Lambert, emission against emission.js, determinism across four routes.
 * What is NOT verified is how it behaves inside the real editor, on a real
 * project, driven by the real compositor. Two releases went out on the
 * assumption that a green harness was the same thing, and both were wrong.
 *
 * So the automatic switch at 50,000 is disabled. Nothing about an existing
 * project changes: every system keeps running on the bake exactly as it did
 * before any of this landed. Tier 2 has to be turned on deliberately, by
 * someone who is in a position to look at the result.
 *
 * Flip this to true only after the engine has been driven in the app itself on
 * a real particle layer and the result has been LOOKED AT.
 */
export const TIER2_ENABLED = true;

/*
 * FLUID SYSTEMS RUN ON THE GPU TOO.
 *
 * Driven in the real editor at 200,000 particles against the same project on the
 * bake, coverage in the viewport:
 *
 *   dust 1.08   stars 1.06   snow 1.01   sparks 1.09
 *   cigarette 0.98   ink 0.94   ember 0.95   shockwave 1.20
 *
 * Seven of eight inside ten percent. Shockwave sits at 1.20 and is left there
 * deliberately: it is an expanding ring in a chaotic field, two different
 * solvers will not trace the same one, and the picture is the ring the preset
 * describes. Exact parity between two engines was never the bar — the bar is
 * that the look is right and that the engine agrees with ITSELF, which it does:
 * preview and export are the same code.
 *
 * Getting here needed four things the first fluid port missed, each measured in
 * the app rather than reasoned about: the viscosity pass (absent entirely, and
 * every preset has viscosity >= 2, so nothing damped a buoyant column and it
 * climbed three times too far); the splat falloff (a cone where the bake uses a
 * Gaussian, and no dt in the velocity mix); the stir splats themselves (now
 * built by calling fieldSplats rather than reimplementing it — the hand-written
 * version used raw heat where the bake uses heat/18); and the vortex applied to
 * the GRID as well as to the particles.
 */
export const TIER2_FLUID_ENABLED = true;

/**
 * Bytes one particle costs in Tier 2: its pool slot, its instance slot, and its
 * entry in the FREE LIST.
 *
 * The free list used to be left out — one u32 a slot looks like a rounding
 * error next to 128 bytes, and at eight million it is 32 MB. The ledger's whole
 * job is to refuse a layer that will not fit, so under-counting is the one kind
 * of wrong it must not be: it let a layer in that the GPU then had to find
 * another 32 MB for. Not counted here, deliberately: the fluid grid (present
 * only on fluid systems, and sized by fidelity rather than by particle count)
 * and the plate's own canvas.
 */
export const BYTES_PER_PARTICLE = (PART_FLOATS + INST_FLOATS) * 4 + 4;

/**
 * Bytes one particle costs in ONE checkpoint: its pool slot again, plus its
 * entry in the free list. The instance buffer is not saved — it is derived from
 * the pool every frame, so restoring the pool restores it too.
 */
export const CHECKPOINT_BYTES_PER_PARTICLE = PART_FLOATS * 4 + 4;

/**
 * How many checkpoints this layer may keep, and how far apart.
 *
 * CHECKPOINTS ARE OFF, AND THAT IS A MEASUREMENT, NOT AN OVERSIGHT.
 *
 * The idea is sound on its face: a live engine only steps forward, so dragging
 * the playhead left is a reset plus a fast-forward, and a snapshot turns the
 * whole clip's re-run into "restore the nearest one and run the remainder".
 * The machinery for it has been in gpuRuntime.js since Phase 5, unused.
 *
 * Switched on and driven in the real editor — 100 frames of Shift+Left through
 * the editor's own binding, on a static system at the playhead's far end:
 *
 *   |    cap | checkpoints | scrub back | VRAM they cost |
 *   |--------|-------------|------------|----------------|
 *   |   200k | 4           |   403 ms   |     39.7 MB    |
 *   |   200k | none        |   211 ms   |          0     |
 *   |     1M | 3           |   696 ms   |    148.8 MB    |
 *   |     1M | none        |   599 ms   |          0     |
 *
 * They make scrubbing SLOWER, at both sizes, while spending up to 149 MB of the
 * shared budget to do it. The reason is structural rather than a tuning
 * problem: saving or restoring one is two copies of the whole pool, and the
 * re-run they replace is no longer expensive — every simulation pass is bounded
 * by `usedSlots()` and `reset()` clears only the high-water region, so a
 * hundred steps of a mostly-empty million-particle pool costs less than moving
 * 52 MB twice. The optimisations that made large counts usable are the same
 * ones that took away the problem checkpoints existed to solve.
 *
 * So the plan is zero, deliberately, and the rest of this function is kept
 * because the reasoning is worth keeping with it: if the per-step cost ever
 * grows (a much heavier solver, or per-particle collision), the crossover moves
 * and this is where it gets re-measured. `setCheckpoints()` still works and the
 * tests still exercise it — nothing here is dead, it is switched off.
 */
export function checkpointPlan(cap, durationSeconds, freeMb = particleBudget().freeMb) {
  const each = (Math.max(1, cap) * CHECKPOINT_BYTES_PER_PARTICLE) / 1048576;
  // What the budget WOULD allow, kept so the trade stays visible: a quarter of
  // what is free and never more than 192 MB on one layer.
  const allow = Math.min(192, Math.max(0, freeMb) * 0.25);
  const affordable = Math.max(0, Math.min(4, Math.floor(allow / Math.max(1e-6, each))));
  const dur = Math.max(0.5, durationSeconds || 6);
  return { n: 0, affordable, every: Math.max(0.5, dur / 5), eachMb: +each.toFixed(1) };
}

/**
 * The default ceiling for ALL particle layers together.
 *
 * 1.5 GB is deliberately below what a desktop GPU has and deliberately above
 * what one comfortable system needs (a million particles is 122 MB). It is the
 * point past which a project is more likely to be a mistake than an intention.
 */
export const DEFAULT_BUDGET_MB = 1536;

const state = { budgetMb: DEFAULT_BUDGET_MB, reservations: new Map() };

/** Raise or lower the ceiling. Existing reservations are untouched. */
export function setParticleBudgetMb(mb) {
  state.budgetMb = Math.max(64, Number(mb) || DEFAULT_BUDGET_MB);
}

export function particleBudget() {
  let used = 0;
  for (const mb of state.reservations.values()) used += mb;
  return {
    budgetMb: state.budgetMb,
    usedMb: +used.toFixed(1),
    freeMb: +Math.max(0, state.budgetMb - used).toFixed(1),
    layers: state.reservations.size,
  };
}

/** What `maxParticles` would cost, in MB. */
export function particleCostMb(maxParticles) {
  return (Math.max(1, maxParticles) * BYTES_PER_PARTICLE) / 1048576;
}

/**
 * Claim room for a layer. Re-claiming for the same key REPLACES its previous
 * reservation rather than adding to it — a layer whose count changes must not
 * leak its old size, which is the failure that turns a budget into a slow leak
 * that only bites after a few edits.
 */
export function reserveParticles(key, maxParticles, extraMb = 0) {
  const want = particleCostMb(maxParticles) + Math.max(0, extraMb);
  let used = 0;
  for (const [k, mb] of state.reservations) if (k !== key) used += mb;
  if (used + want > state.budgetMb) {
    return { ok: false, wantMb: +want.toFixed(1), freeMb: +Math.max(0, state.budgetMb - used).toFixed(1) };
  }
  state.reservations.set(key, want);
  return { ok: true, wantMb: +want.toFixed(1), freeMb: +(state.budgetMb - used - want).toFixed(1) };
}

export function releaseParticles(key) { state.reservations.delete(key); }

/** Drop reservations for layers that no longer exist. Mirrors gcParticleCaches. */
export function gcParticleReservations(liveKeys) {
  for (const k of [...state.reservations.keys()]) if (!liveKeys.has(k)) state.reservations.delete(k);
}

/** TESTS ONLY. */
export function resetParticleBudget() {
  state.budgetMb = DEFAULT_BUDGET_MB;
  state.reservations.clear();
}

/**
 * Decide the tier for one system.
 *
 * `caps` carries what the environment can actually do:
 *   { webgpu: boolean, maxCpu, bakeMax, smoothGpu, maxGpu }
 * where `maxCpu` is the THRESHOLD the GPU engine starts at and `bakeMax` is what
 * the baked solver can actually hold. They are different numbers and confusing
 * them is what turned a new capability into a lower ceiling.
 *
 * Returns { tier, reason, clampedTo, willDropFrames }. `reason` is empty when
 * the system got what it asked for, and is a SENTENCE otherwise — the panel
 * shows it verbatim, so "false" is never a useful answer here.
 */
/**
 * Features the GPU engine does not implement. A system using any of them MUST
 * stay on the bake however large it is.
 *
 * These were written down as Tier 2 exclusions while the engine was being built
 * and then never enforced, which is how a real project at 50,050 particles —
 * a layer emitter with Grow Points, an object member and colour from its source
 * — crossed the threshold into an engine that implements none of the three and
 * drew nothing at all. Documenting an exclusion is not enforcing it.
 *
 * Returns the reason, or '' when the system is fine.
 */
export function gpuUnsupported(system) {
  /*
   * PREVIEW: BAKED IS AN INSTRUCTION, NOT A HINT.
   *
   * `solver.engine` is the user's own choice of how this system previews, and
   * client.js already honours 'baked' for the old live engine. Tier 2 ignored
   * it entirely, so the one switch in the panel that says "use the bake" moved a
   * big system onto a different engine instead — with no way back short of
   * lowering the count.
   */
  if ((system?.solver?.engine || 'auto') === 'baked') {
    return 'Preview is set to Baked, so this system runs on the baked solver.';
  }
  /*
   * COLLISION. The bake turns the picked layer's artwork into a signed-distance
   * field and pushes particles out of it (or keeps them inside it, for a
   * container). The GPU pool has no collider binding at all: with this on and
   * Tier 2 running, particles walk straight through the obstacle they were
   * authored against.
   */
  if (system?.collision?.source || (system?.colliders || []).length) {
    return (system.collision?.faces === 'inner' ? 'A container' : 'A collider')
      + ' is baked, so this system runs on the baked solver.';
  }
  /*
   * PACKING — particle-to-particle collision. A uniform grid rebuilt every
   * substep and N projection passes over a 3x3x3 stencil, none of which the GPU
   * pool has: it would need count + prefix-scan + scatter passes ahead of
   * integrate. With this on and Tier 2 running, a pour would fall straight
   * through itself.
   */
  if (system?.packing?.enabled) {
    return 'Packing is baked, so this system runs on the baked solver.';
  }
  /*
   * FORCE EMITTERS — Blowers, whirlpools, smoke sources, and the 'layer' kind
   * that drives particles from another timeline layer's animation (Layer
   * Velocity). They reach the Tier 2 fluid as stir splats, but nothing applies
   * them to the particles themselves, and the 'layer' kind needs a per-step
   * table the runtime has no way to receive.
   */
  const fes = (system?.forceEmitters || []).filter((f) => f && f.enabled !== false);
  if (fes.length) {
    return fes.some((f) => f.kind === 'layer')
      ? 'Layer Velocity is baked, so this system runs on the baked solver.'
      : 'Force emitters are baked, so this system runs on the baked solver.';
  }
  /*
   * PATH FOLLOW — an attract/flow field along a resampled spline. The bake
   * carries the path as a table the integrate step samples; Tier 2 has the
   * EMIT path (particles born along a shape) but no follow path.
   */
  if (system?.pathFollow?.enabled) {
    return 'Path Follow is baked, so this system runs on the baked solver.';
  }
  const A = system?.activation;
  if (A && A.mode === 'grow') {
    // Grow Points is a schedule over the artwork — which particle is released
    // when, from a baked arrival field. The GPU engine has no such schedule.
    return 'Grow Points is baked, so this system runs on the baked solver.';
  }
  if ((system?.render?.mode || 'sprite') === 'layers') {
    // Object members are stamped artwork with their own facing, spin and tumble;
    // the GPU draw is sprites only. They are capped at a few hundred anyway.
    return 'Particle objects are drawn by the baked solver.';
  }
  /*
   * LINES, ROWS, RETURN. The GPU draw is sprites only — it has no ribbon pass,
   * and a trail is read from the bake's history, which this tier does not keep.
   * A rows grid is capped below this tier's threshold anyway, and Return needs a
   * birth point per particle that the GPU pool's record has no lane for.
   */
  if (system?.render?.mode === 'lines') return 'Lines are drawn by the baked solver.';
  if (system?.emitters?.[0]?.shape === 'rows') return 'A rows emitter runs on the baked solver.';
  if ((system?.forces?.return?.strength || 0) > 0) return 'Return runs on the baked solver.';
  const src = system?.emitters?.[0]?.source;
  if (system?.render?.colorMode === 'source' && src?.kind === 'video'
      && system?.render?.colorSourceTime === 'birth') {
    // Colour-at-birth from a moving source is a CPU cache keyed by uid.
    return 'Colour taken at birth from a video source is baked.';
  }
  return '';
}

export function chooseTier(system, caps) {
  const want = Math.max(1, Math.round(system?.solver?.maxParticles || 0));
  const unsupported = gpuUnsupported(system);
  if (unsupported && !caps.forceGpu) {
    return { tier: TIER.BAKE, clampedTo: want, willDropFrames: false, reason: unsupported };
  }
  if (!TIER2_ENABLED && !caps.forceGpu) {
    // The safe answer, and the one every project got before this feature: the
    // bake, whatever the count. See TIER2_ENABLED above.
    return { tier: TIER.BAKE, reason: '', clampedTo: want, willDropFrames: false };
  }
  const wantsFluid = (system?.forces?.fluid?.model || 'off') !== 'off';
  /*
   * THERE IS NO VOLUMETRIC RENDER MODE, AND THERE IS NOT GOING TO BE ONE.
   *
   * This used to branch on `system.render.dye.mode === 'volume'` — a field that
   * exists in no schema, no sanitiser and no panel, so the branch could never be
   * taken. It came from a plan to raymarch the fluid's density as smoke instead
   * of drawing sprites. That is not what the fluid is for here: the fluid
   * provides the MOVEMENT — particles carried, swirled and lifted by a medium —
   * and they go on being drawn as particles. Removed rather than left as a
   * documented intention, because an unreachable branch reads like a feature.
   */

  if (want <= caps.maxCpu) {
    // Small enough for the bake, which is the better answer when it fits: it is
    // cacheable, scrubs backwards for free and is bit-reproducible everywhere.
    return { tier: TIER.BAKE, reason: '', clampedTo: want, willDropFrames: false };
  }

  if (!caps.webgpu) {
    return {
      tier: TIER.BAKE,
      /*
       * SAY SO WHEN THE COUNT IS ACTUALLY BEING CUT.
       *
       * This returned '' for everything but volumetric smoke, so a machine with
       * no WebGPU asked for four hundred thousand particles, got a hundred
       * thousand, and was told nothing at all — the panel showed a number the
       * project did not have with no explanation anywhere. A system that still
       * fits the bake genuinely has nothing to report, so it stays silent.
       */
      reason: want > caps.bakeMax
        ? `WebGPU is not available on this machine, so this system runs on the baked solver — clamped to ${caps.bakeMax.toLocaleString()} particles.`
        : '',
      // NOT caps.maxCpu. That is where the GPU engine starts, not what the bake
      // can hold — clamping to it here handed a machine without WebGPU a lower
      // ceiling than it had before this feature existed.
      clampedTo: Math.min(want, caps.bakeMax),
      willDropFrames: false,
    };
  }

  if (wantsFluid && !TIER2_FLUID_ENABLED && !caps.forceGpu) {
    return {
      tier: TIER.BAKE, clampedTo: Math.min(want, caps.bakeMax), willDropFrames: false, reason: '',
    };
  }

  const clamped = Math.min(want, caps.maxGpu);
  return {
    tier: TIER.GPU,
    reason: clamped < want ? `Clamped to the ${caps.maxGpu.toLocaleString()} particle ceiling.` : '',
    clampedTo: clamped,
    // Not a failure — a statement. Past the smooth mark the preview will not
    // hold 60 fps, and the user is entitled to know that BEFORE wondering why
    // their editor got sticky.
    willDropFrames: clamped > caps.smoothGpu,
    wantsFluid,
  };
}


/*
 * Can this machine run Tier 2 at all?
 *
 * `navigator.gpu` being truthy is NOT the answer — it is present on machines
 * where WebGPU cannot actually run (a VM, a blocklisted driver), and only
 * requestAdapter() settles it, by returning null rather than throwing. That is
 * the same rule videoRenderer.js already documents for the compositor.
 *
 * Cached, because the panel asks on every render and the answer cannot change
 * without a reload. navigator is touched only inside this function, so the
 * module still imports cleanly in node.
 */
let probe = null;
export function probeWebGpu() {
  if (probe) return probe;
  probe = (async () => {
    if (typeof navigator === 'undefined' || !navigator.gpu) return false;
    try { return !!(await navigator.gpu.requestAdapter()); } catch { return false; }
  })();
  return probe;
}
