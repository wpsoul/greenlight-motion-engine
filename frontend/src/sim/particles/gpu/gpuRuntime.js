/*
 * The Tier 2 RUNTIME — pool, derive, draw, wired together on one private
 * device. Phase 1 of PLANS/VIDEO_EDITOR_PARTICLE_GPU_SCALE_PLAN.md.
 *
 * This is the object particleLayer.js talks to, and its whole surface is:
 *   ready, canvas, resize, setRamp, setArt, setSpawnTable, writePool,
 *   render(...), settle, stats, dispose.
 * Nothing else about Tier 2 is visible outside this directory — which is the
 * isolation contract the plan is built on.
 *
 * WHERE THE FRAME GOES. render() paints into `canvas`, a WebGPU canvas on the
 * engine's own device. particleLayer.js wraps that in a CanvasTexture and hands
 * it to the compositor exactly where it used to hand over a render target's
 * texture. The compositor cannot tell the difference: it always received a flat
 * plate from a solver and never a depth texture (see Player.jsx's note on
 * viewDistance). Phase 0 measured the hand-off at 0.6 ms on WebGPU and 0.3 ms on
 * WebGL, flat in particle count.
 *
 * NOTHING IS READ BACK. The derive pass compacts survivors with an atomic whose
 * counter IS the draw's indirect argument buffer, so the CPU submits a draw for
 * a number of particles it never learns. That is the single change that lifts
 * the ceiling from ~20k to millions; everything else is bandwidth.
 *
 * THE SIMULATION. `step()` runs reap -> emit -> integrate once per fixed
 * STEP_DT. Fixed, not by a frame delta: the determinism model depends on step
 * count being a function of time and nothing else, so preview, scrubbing and
 * export agree on what the system looks like at a given moment.
 *
 * The CPU's whole remaining job is ONE ACCUMULATOR — how many particles are
 * born this step — plus a flag per burst. Everything else about a birth is a
 * pure function of (seed, uid), so it happens on the GPU in parallel for
 * however many that is. Phase 5's fluid passes slot in between emit and
 * integrate.
 */

import { createPlateRenderer, plateDevice, SCALAR_KEYS } from './plateRenderer.js';
import { INST_FLOATS } from './drawWgsl.js';
import { DERIVE_WGSL, DERIVE_U_FLOATS, DERIVE_U_BYTES, DERIVE_KEYS, PART_FLOATS } from './deriveWgsl.js';
import { EMIT_WGSL, EMIT_U_FLOATS, EMIT_U_BYTES, EMIT_KEYS, SHAPE, DIR_MODE, DIST_MODE } from './emitWgsl.js';
import { prepareDistribution } from '../distribution.js';
import { reserveParticles, releaseParticles, particleCostMb, CHECKPOINT_BYTES_PER_PARTICLE } from './tier.js';
import { FLUID_WGSL, FLUID_U_FLOATS, FLUID_U_BYTES, FLUID_KEYS, SPLAT_FLOATS,
  VEL_FORMAT, MAT_FORMAT, PRS_FORMAT } from './fluidWgsl.js';
import { fluidGridDims, draftVec } from '../fluid.js';

export { PART_FLOATS, INST_FLOATS, DERIVE_KEYS, SCALAR_KEYS, EMIT_KEYS, SHAPE, DIR_MODE };

/** The bake's fixed step. Live and baked must agree on it or nothing else lines up. */
export const STEP_DT = 1 / 60;

/** Slabs never exceed this, so the default 128 MiB storage-binding limit is
 *  never the thing that stops a pool from allocating. */
const SLAB_BYTES = 120 * 1024 * 1024;

const DERIVE_PIPES = new WeakMap();
const EMIT_PIPES = new WeakMap();
const FLUID_PIPES = new WeakMap();

async function fluidPipelinesFor(device) {
  const hit = FLUID_PIPES.get(device);
  if (hit) return hit;
  const module = device.createShaderModule({ code: FLUID_WGSL });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) {
    throw new Error('particle fluid WGSL: ' + errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join(' | '));
  }
  // One explicit layout for all six passes — `auto` would give each entry point
  // its own, containing only what it happens to touch, and a bind group built
  // from one would be invalid for the others (the same trap the emit passes hit).
  const bgl = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '3d' } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: VEL_FORMAT, viewDimension: '3d' } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '3d' } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: MAT_FORMAT, viewDimension: '3d' } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: PRS_FORMAT, viewDimension: '3d' } },
    { binding: 7, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
    { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
  ] });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const mk = (entryPoint) => device.createComputePipeline({ layout, compute: { module, entryPoint } });
  const pipes = { bgl, splat: mk('splat'), forces: mk('forces'), advect: mk('advect'),
    diffuse: mk('diffuse'), divergence: mk('divergence'), jacobi: mk('jacobi'), project: mk('project') };
  FLUID_PIPES.set(device, pipes);
  return pipes;
}

async function emitPipelinesFor(device) {
  const hit = EMIT_PIPES.get(device);
  if (hit) return hit;
  const module = device.createShaderModule({ code: EMIT_WGSL });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) {
    throw new Error('particle emit WGSL: ' + errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join(' | '));
  }
  // AN EXPLICIT LAYOUT, SHARED BY ALL THREE. `layout: 'auto'` would give each
  // entry point its OWN generated layout containing only the bindings that entry
  // point happens to use — reap touches neither the spawn table nor the path, so
  // its auto layout omits bindings 4 and 5 entirely. A bind group built from one
  // pipeline's auto layout is then invalid for the others, and the dispatch fails
  // validation without throwing anywhere the caller can see it: the passes simply
  // do nothing and the pool stays empty.
  const bgl = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '3d' } },
    { binding: 7, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
    { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
  ] });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const mk = (entryPoint) => device.createComputePipeline({ layout, compute: { module, entryPoint } });
  const pipes = { bgl, prepare: mk('prepare'), reap: mk('reap'), emit: mk('emit'), integrate: mk('integrate') };
  EMIT_PIPES.set(device, pipes);
  return pipes;
}

async function derivePipelineFor(device) {
  const hit = DERIVE_PIPES.get(device);
  if (hit) return hit;
  const module = device.createShaderModule({ code: DERIVE_WGSL });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) {
    throw new Error('particle derive WGSL: ' + errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join(' | '));
  }
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'derive' } });
  DERIVE_PIPES.set(device, pipeline);
  return pipeline;
}

/**
 * @param {object} o
 * @param {number} o.maxParticles pool capacity
 * @param {number} o.width  plate width in pixels
 * @param {number} o.height plate height in pixels
 * @param {number} o.seed   the system seed — the same one the bake uses
 */
export function createGpuParticleRuntime({ maxParticles, width, height, seed = 0, canvas = null, key = null }) {
  const cap = Math.max(1, Math.round(maxParticles));
  const runtime = {
    ok: false, error: '', disposed: false, canvas: null, device: null,
    cap,
    stats: { drawMs: 0, deriveMs: 0, frames: 0, vramMb: 0 },
  };

  let device = null;
  let plate = null;
  let derivePipe = null;
  /*
   * SLABS. The pool is split into `S` independent partitions, each with its own
   * pool, free list, instance buffer and indirect args, because one adapter's
   * storage BINDING may be as small as 128 MiB and its largest BUFFER 256 MiB —
   * the spec minimums, and what integrated GPUs generally report. Eight million
   * particles is 384 MB of pool and 512 MB of instances, so on such a machine
   * the layer used to refuse outright and fall back to a hundred-thousand bake.
   *
   * WHAT MAKES A SLAB INDEPENDENT is that the free list is per-slab and a
   * particle's slab is decided by its uid: slab s owns every uid congruent to s
   * modulo S. Emission for a step is therefore a strided subsequence per slab
   * (see uidBase/uidStride in emitWgsl.js), a birth only ever pops a slot from
   * its own slab, and the derive pass compacts into its own instance buffer with
   * its own atomic. Nothing crosses a slab boundary, so a slab is just a smaller
   * copy of the whole thing and every pass runs once per slab with its own bind
   * group.
   *
   * S is 1 on any adapter that can address the whole pool, and then every one of
   * these arrays has one element and the code path is what it always was.
   */
  let S = 1;
  let slabCap = cap;
  const slabs = [];         // { pool, inst, args, free, freeCnt, poolArgs, emitBind, deriveBind, issued }
  let argsBuf = null;       // slab 0's, kept for __debugBuffers and the tests
  let tableBuf = null;
  let deriveU = null;
  let deriveBind = null;
  let emitPipes = null;
  let emitU = null;
  let emitBind = null;
  let poolBuf = null;      // slab 0's pool — tests and checkpoints only
  let instBuf = null;      // slab 0's instances — tests only
  let freeBuf = null;      // slab 0's free list
  let freeCntBuf = null;   // slab 0's free count
  /*
   * THE EMIT PASS'S INDIRECT ARGS, AND IT HAD NO DECLARATION AT ALL.
   *
   * Every assignment to it was an assignment to an undeclared name, which in a
   * module — always strict — is a ReferenceError, not an implicit global. It is
   * first written inside the `ready` block's try/catch, so the throw was caught
   * and turned into `runtime.error = 'poolArgsBuf is not defined'`: the runtime
   * reported itself as failed, every layer fell back to the bake, and the whole
   * of Tier 2 was unreachable in the app. Harnesses that load these files as
   * classic scripts create the global instead and never see it.
   */
  let poolArgsBuf = null;
  let tablePosBuf = null;  // spawn-table POSITIONS (emit) — colours live in tableBuf (derive)
  let pathBuf = null;
  /* THE FLUID. Six passes over a 3D grid, ping-ponged between two sets of
     textures. `fluid` is null until configureFluid is given a model other than
     'off'; the particles read the settled velocity through setFluidField. */
  let fluid = null;
  let fluidPipes = null;
  let fieldVelTex = null;  // the fluid's velocity, when there is a fluid
  let dummyField = null;   // a 1x1x1 stand-in, so the bind group is always complete
  let fieldSampler = null;
  /** How far up the pool has ever been used — the dispatch bound for every pass
   *  that walks it. Never beyond the cap, never below one workgroup. */
  const usedSlots = (sl) => Math.max(64, Math.min(slabCap, sl.issued));
  /** How far up this slab has EVER been written, for the reset clear. */
  const highWater = (sl) => Math.max(1, Math.min(slabCap, sl.issued));
  /**
   * The 1-based step a pulse at clip time `bt` fires on.
   *
   * Step k lands at t = k*STEP_DT - preRoll, so the first step at or after `bt`
   * is ceil((bt + preRoll) / STEP_DT), never below 1 — a pulse at t = 0 (which
   * is what a static emitter is) fires on the first step rather than being
   * treated as already past. The epsilon is because (bt + preRoll) / STEP_DT
   * lands a hair above an integer often enough to matter, and rounding the
   * wrong way there puts the pulse one step late.
   */
  const burstStepFor = (bt) => Math.max(1, Math.ceil(((bt + preRollT) / STEP_DT) - 1e-6));
  const eArray = new Float32Array(EMIT_U_FLOATS);
  const eIdx = (k) => EMIT_KEYS.indexOf(k);

  /* The emitter schedule — the only genuinely sequential part of emission, and
     the only part that stays on the CPU. One accumulator and a burst flag each;
     O(1) per step however many particles are born. */
  let sched = { rate: 0, start: 0, end: 1e9, staticEmit: false, bursts: [], preRoll: 0 };
  let acc = 0;
  /*
   * WHICH STEP A PULSE FIRES ON, NOT WHETHER IT HAS FIRED YET.
   *
   * This used to be `firedBursts`, a latch per pulse. The latch was correct in
   * isolation and wrong in the editor, because configureEmitter cleared it and
   * the manager calls configureEmitter on EVERY rendered frame — so a pulse
   * past its time re-armed sixty times a second and fired again on every step
   * after it. A static emitter, which is expressed as one pulse of `cap`, spent
   * the whole clip re-filling the pool: the free list drained, births were
   * dropped, and the system looked like it was emitting far more than it was
   * told to while running far slower than its count justified.
   *
   * Firing is now a pure function of the step INDEX, which is a function of
   * time and nothing else — the same rule the rest of the runtime lives by. It
   * cannot be re-armed by a reconfiguration, it survives a checkpoint restore,
   * and a pulse whose time has passed stays passed however many times a slider
   * moves. `stepIndex` is also what simT is derived FROM rather than the other
   * way round, so a thousand steps do not accumulate a thousand rounding errors.
   */
  let stepIndex = 0;
  let nextUid = 1;
  /*
   * THE CLOCK STARTS AT -preRoll, NOT AT ZERO.
   *
   * `preRoll` is simulation time before the clip begins, so the box is already
   * populated at frame 0. The bake's own definition is
   * `t = s * STEP_DT - preRoll` (solver.js) — clip-local time, negative during
   * the pre-roll — and this has to match it or the two disagree about what the
   * system looks like at every single frame.
   *
   * Starting at zero instead is not a small error. Dust has a 5.5 s pre-roll and
   * Snow has 7 s; at a few hundred particles a second, that IS the picture. With
   * the clock starting at 0 those presets draw a bare handful of particles still
   * bunched at the emitter, which reads as "the layer is empty" — and every
   * preset with preRoll 0 looks perfectly fine, which is why a harness built on
   * one of those never saw it.
   */
  let siteProvider = null;
  let currentRelax = 0;
  let preRollT = 0;
  let simT = 0;

  /* CHECKPOINTS. A live engine only steps forward, so a backward seek is a reset
     plus a fast-forward — at a million particles and 4 ms a step, scrubbing back
     six seconds is over a second of re-simulation. A checkpoint is a copy of the
     pool, the free list and the four numbers of CPU state, so a seek restores
     the nearest one and re-runs only the remainder.

     They are OPT-IN and cost 52 bytes per particle each (pool + free list), so a
     million-particle system with four of them spends 208 MB. Above roughly a
     million the re-run is cheaper than the memory, which is why the caller
     chooses rather than this module. */
  let checkpoints = [];   // [{ t, pool, free, freeCount, acc, nextUid, fired }]
  const uArray = new Float32Array(DERIVE_U_FLOATS);
  const ARGS_RESET = new Uint32Array([4, 0, 0, 0]);   // vertexCount (a 4-vertex strip), instanceCount, first*, first*

  runtime.ready = (async () => {
    /*
     * CREATION CAN OUTLIVE DISPOSAL, AND USED TO.
     *
     * Everything below is asynchronous — the device request, three pipeline
     * compilations, the plate. Meanwhile the layer it belongs to can be deleted,
     * or its particle count edited (which rebuilds the runtime and disposes this
     * one). dispose() sets a flag and destroys the buffers that exist AT THAT
     * MOMENT; this function then carried on and allocated the rest of them,
     * claimed the shared budget, and left both behind with nothing holding a
     * reference. At eight million that is a gigabyte and a 977 MB reservation
     * stranded until reload — by deleting a layer while it was still starting,
     * which is exactly when someone realises the number was too big.
     *
     * So every await is followed by a check, and the abort releases whatever has
     * been claimed so far.
     */
    const abort = () => {
      if (runtime.claimKey) { releaseParticles(runtime.claimKey); runtime.claimKey = null; }
      runtime.disposeGpuObjects();
      return false;
    };
    try {
      device = await plateDevice();
      if (runtime.disposed) return abort();
      if (!device) { runtime.error = 'WebGPU is not available here'; return false; }
      runtime.device = device;

      // CLAIM THE MEMORY BEFORE ALLOCATING IT. The per-layer count is not the
      // real constraint — several particle layers are several pools — so the
      // ledger is shared and a layer refused here falls back to Tier 1 and says
      // so. It never silently gets a smaller pool than it asked for: a system
      // that quietly halves its own density reads as a bug in the art rather
      // than a limit being hit.
      const claimKey = key || `runtime:${cap}:${seed}:${Math.round(width)}x${Math.round(height)}`;
      const claim = reserveParticles(claimKey, cap);
      if (!claim.ok) {
        runtime.error = `${cap.toLocaleString()} particles needs ${claim.wantMb} MB and only ${claim.freeMb} MB of the particle budget is free`;
        return false;
      }
      runtime.claimKey = claimKey;

      /*
       * HOW MANY SLABS. The binding limit and the buffer limit are different
       * numbers and either can be the one that bites — an adapter may allow a
       * 1 GB buffer but only bind 128 MiB of it — so the smaller decides. The
       * instance slot is the larger of the two per-particle arrays, so it sets
       * the slab size; the free list is 4 bytes a slot and never the constraint.
       *
       * `__particleSlabBytes` forces a small limit so the chunked path can be
       * exercised on a machine whose adapter would never take it. A capability
       * that only runs on hardware nobody testing it owns is a capability nobody
       * has tested.
       */
      const forced = Number(globalThis.__particleSlabBytes) || 0;
      const limBind = device.limits?.maxStorageBufferBindingSize ?? SLAB_BYTES;
      const limBuf = device.limits?.maxBufferSize ?? SLAB_BYTES;
      const lim = Math.max(1 << 20, forced > 0 ? forced : Math.min(limBind, limBuf));
      const perSlot = Math.max(PART_FLOATS, INST_FLOATS) * 4;
      S = Math.max(1, Math.ceil((cap * perSlot) / lim));
      slabCap = Math.ceil(cap / S);
      runtime.slabs = S;
      runtime.slabCap = slabCap;

      const poolBytes = slabCap * PART_FLOATS * 4;
      const instBytes = slabCap * INST_FLOATS * 4;

      // Catch an out-of-memory as an ERROR rather than as a lost device: the
      // engine's device is private, but losing it still takes every particle
      // layer with it, and a caught allocation failure can fall back instead.
      device.pushErrorScope('out-of-memory');
      const ST = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      for (let i = 0; i < S; i++) {
        slabs.push({
          pool: device.createBuffer({ size: poolBytes, usage: ST | GPUBufferUsage.COPY_SRC }),
          inst: device.createBuffer({ size: instBytes, usage: ST }),
          free: device.createBuffer({ size: slabCap * 4, usage: ST | GPUBufferUsage.COPY_SRC }),
          freeCnt: device.createBuffer({ size: 4, usage: ST | GPUBufferUsage.COPY_SRC }),
          poolArgs: device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
          args: device.createBuffer({ size: 16, usage: ST | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC }),
          // ONE UNIFORM BLOCK PER SLAB. Two lanes differ between slabs — where
          // its uid subsequence starts and how many it gets — and a queue write
          // cannot be interleaved with dispatches inside a single submit, so a
          // shared block would hand every slab whichever value was written last.
          emitU: device.createBuffer({ size: EMIT_U_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
          emitBind: null, deriveBind: null, issued: 0,
        });
      }
      poolBuf = slabs[0].pool; instBuf = slabs[0].inst;
      freeBuf = slabs[0].free; freeCntBuf = slabs[0].freeCnt;
      argsBuf = slabs[0].args; poolArgsBuf = slabs[0].poolArgs; emitU = slabs[0].emitU;
      tablePosBuf = device.createBuffer({ size: 16, usage: ST });
      pathBuf = device.createBuffer({ size: 16, usage: ST });
      dummyField = device.createTexture({ size: [1, 1, 1], dimension: '3d', format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      fieldSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear',
        addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
      tableBuf = device.createBuffer({ size: 16, usage: ST });
      deriveU = device.createBuffer({ size: DERIVE_U_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const oom = await device.popErrorScope();
      if (runtime.disposed) return abort();
      if (oom) {
        releaseParticles(claimKey);
        runtime.error = 'out of GPU memory for ' + cap + ' particles';
        return false;
      }
      /*
       * COUNT THE FREE LIST. It is one u32 per slot — 32 MB at eight million,
       * which is not a rounding error — and it was left out of both this readout
       * and the shared ledger, so the panel under-reported what a big layer
       * actually holds and the budget let one more in than it had room for.
       */
      runtime.stats.vramMb = +(((poolBytes + instBytes + slabCap * 4) * S) / 1048576).toFixed(1);
      runtime.stats.claimedMb = +particleCostMb(cap).toFixed(1);

      derivePipe = await derivePipelineFor(device);
      if (runtime.disposed) return abort();
      emitPipes = await emitPipelinesFor(device);
      if (runtime.disposed) return abort();
      fluidPipes = await fluidPipelinesFor(device);
      if (runtime.disposed) return abort();
      plate = await createPlateRenderer({ device, width, height, canvas });
      if (runtime.disposed) return abort();
      if (!plate) { runtime.error = 'could not create the particle plate'; return false; }
      runtime.canvas = plate.canvas;

      uArray[DERIVE_KEYS.indexOf('seed')] = seed | 0;
      // THE SHADERS SEE THE SLAB, NOT THE POOL. Every bound in the WGSL — the
      // dispatch guard, the free-list underflow check, the slot range — is
      // against `u.cap`, and a slab's cap is its own.
      uArray[DERIVE_KEYS.indexOf('cap')] = slabCap;
      uArray[DERIVE_KEYS.indexOf('ttlAlive')] = 1e9;
      // PREVIEW FRACTION DEFAULTS TO 1, and this is the one lane where zero is
      // not a safe default. The derive pass reads it as "keep a hash-stable
      // subset this large", so a zero left in the block rejects EVERY particle —
      // the pool fills, the sim runs, and the draw is silently empty. Every other
      // lane means "off" at zero; this one means "draw nothing".
      uArray[DERIVE_KEYS.indexOf('previewFraction')] = 1;
      eArray[eIdx('seed')] = seed | 0;
      eArray[eIdx('cap')] = slabCap;
      eArray[eIdx('uidStride')] = 1;
      eArray[eIdx('dt')] = STEP_DT;
      rebindDerive();
      rebindEmit();
      runtime.reset();
      runtime.ok = true;
      return true;
    } catch (e) {
      runtime.error = String(e?.message || e);
      return false;
    }
  })();

  let ckMax = 0;
  let ckEvery = 1;

  function nearestCheckpoint(t) {
    let best = null;
    for (const c of checkpoints) if (c.t <= t + 1e-9 && (!best || c.t > best.t)) best = c;
    return best;
  }

  /** Snapshot the whole simulation state at the current time. */
  function takeCheckpoint() {
    if (!ckMax) return;
    const last = checkpoints.length ? checkpoints[checkpoints.length - 1] : null;
    if (last && simT < last.t + ckEvery - 1e-9) return;
    let slot;
    if (checkpoints.length >= ckMax) {
      // Drop the OLDEST, never the newest: the newest is the one a small scrub
      // back will land on, and it is the one that saves the most work.
      slot = checkpoints.shift();
    } else {
      const B = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
      slot = {
        pool: device.createBuffer({ size: cap * PART_FLOATS * 4, usage: B }),
        free: device.createBuffer({ size: cap * 4, usage: B }),
        freeCount: device.createBuffer({ size: 4, usage: B }),
      };
    }
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(poolBuf, 0, slot.pool, 0, slot.pool.size);
    enc.copyBufferToBuffer(freeBuf, 0, slot.free, 0, slot.free.size);
    enc.copyBufferToBuffer(freeCntBuf, 0, slot.freeCount, 0, 4);
    device.queue.submit([enc.finish()]);
    slot.t = simT; slot.acc = acc; slot.nextUid = nextUid; slot.step = stepIndex;
    checkpoints.push(slot);
  }

  function restoreCheckpoint(c) {
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(c.pool, 0, poolBuf, 0, c.pool.size);
    enc.copyBufferToBuffer(c.free, 0, freeBuf, 0, c.free.size);
    enc.copyBufferToBuffer(c.freeCount, 0, freeCntBuf, 0, 4);
    device.queue.submit([enc.finish()]);
    simT = c.t; acc = c.acc; nextUid = c.nextUid; stepIndex = c.step;
  }

  /**
   * One fluid step: splat, forces, advect, divergence, Jacobi, project.
   *
   * Every pass reads one set of textures and writes the other, and the sets swap
   * afterwards — a WGSL storage texture is write-only, and a bind group may not
   * carry the same texture as both a sampled source and a write target. The
   * ping-pong is what keeps those apart.
   */
  function stepFluid(enc, t) {
    const F = fluid;
    const d = F.dims;
    // The emitter stirs the medium it is emitting into. The bake builds these
    // from actual spawn SITES; Tier 2 has no CPU pool to read sites from, so it
    // uses one splat at the emitter, which is what dominates the look.
    // WHERE THE ASYMMETRY COMES FROM.
    //
    // The bake stirs the medium at the actual SPAWN SITES — up to 24 of them,
    // each at its own seeded position with its own velocity. Vorticity
    // confinement then amplifies the difference between them, and that is what
    // makes Ember Swirl curl to one side instead of standing up as a fountain.
    //
    // One splat at the emitter centre is perfectly symmetric, so there is
    // nothing for the confinement to amplify: the plume stays a fountain however
    // strong the swirl is turned up. The sites are supplied by the caller, which
    // gets them from the SAME emission module the bake uses so the two cannot
    // drift.
    const sites = F.sites;
    let nSplats = 0;
    if (sites && sites.length) {
      const S = F.splats;
      nSplats = Math.min(12, sites.length);   // gpuEngine.js MAX_SPLATS
      for (let i = 0; i < nSplats; i++) {
        const o = i * SPLAT_FLOATS, q = sites[i];
        S[o] = q.x; S[o + 1] = q.y; S[o + 2] = q.z; S[o + 3] = Math.max(1, q.r);
        S[o + 4] = q.vx; S[o + 5] = q.vy; S[o + 6] = q.vz; S[o + 7] = Math.min(1, q.k);
        S[o + 8] = q.den || 0; S[o + 9] = q.heat || 0; S[o + 10] = 0; S[o + 11] = 0;
      }
      device.queue.writeBuffer(F.splatBuf, 0, S, 0, nSplats * SPLAT_FLOATS);
    }
    F.u[FLUID_KEYS.indexOf('nSplats')] = nSplats;
    /*
     * THE DRAFT — a gusting wind on the MEDIUM, uniform in space and varying
     * only with time. The shader already had the two lanes and nothing ever
     * wrote them, so a preset with a draft (Rising Smoke's is 30) ran with a
     * perfectly still room: its column went straight up and never leaned, which
     * reads as "the smoke looks stiff" rather than as a missing force.
     *
     * draftVec is the bake's own function, called rather than transcribed —
     * its gust is two seeded noise terms and a direction jitter in degrees, and
     * a second implementation of that would drift on the first edit.
     */
    const [dwx, dwy] = draftVec(F.draft, t);
    F.u[FLUID_KEYS.indexOf('windX')] = dwx;
    F.u[FLUID_KEYS.indexOf('windY')] = dwy;
    device.queue.writeBuffer(F.uBuf, 0, F.u);

    const wg = [Math.ceil(d.nx / 4), Math.ceil(d.ny / 4), Math.ceil(d.nz / 4)];
    /*
     * EACH RESOURCE PING-PONGS ON ITS OWN, and that is not fussiness.
     *
     * A single shared flag looks right and is wrong: `divergence` writes mat and
     * pressure but NOT velocity, so swapping velocity after it points the next
     * passes at the pre-advection field. Advection's result is discarded every
     * step, the solve never sees the velocity it was supposed to correct, and
     * energy accumulates until the whole thing detonates — which is exactly what
     * it did: Ember Swirl came out as a starburst filling the frame.
     *
     * So a pass declares which resources it writes, and only those swap.
     */
    const pass = (pipeline, writes) => {
      const [vS, vD] = F.velCur ? [F.velB, F.velA] : [F.velA, F.velB];
      const [mS, mD] = F.matCur ? [F.matB, F.matA] : [F.matA, F.matB];
      const [pS, pD] = F.prsCur ? [F.prsB, F.prsA] : [F.prsA, F.prsB];
      const p = enc.beginComputePass();
      p.setPipeline(pipeline);
      p.setBindGroup(0, F.bind(vS, vD, mS, mD, pS, pD));
      p.dispatchWorkgroups(wg[0], wg[1], wg[2]);
      p.end();
      if (writes.vel) F.velCur = 1 - F.velCur;
      if (writes.mat) F.matCur = 1 - F.matCur;
      if (writes.prs) F.prsCur = 1 - F.prsCur;
    };

    const BOTH = { vel: true, mat: true };
    if (nSplats) pass(fluidPipes.splat, BOTH);
    pass(fluidPipes.forces, BOTH);
    pass(fluidPipes.advect, BOTH);
    // Viscosity, twice — the bake's own count. Below 0.5 it is off entirely.
    if (F.viscOn) { pass(fluidPipes.diffuse, BOTH); pass(fluidPipes.diffuse, BOTH); }
    // Divergence lands in mat.z and clears the pressure it will be solved into.
    pass(fluidPipes.divergence, { mat: true, prs: true });
    for (let i = 0; i < F.pressureSteps; i++) pass(fluidPipes.jacobi, { prs: true });
    pass(fluidPipes.project, BOTH);
    // The particles read whichever velocity texture the solve just settled into.
    runtime.setFluidField(F.velCur ? F.velB : F.velA, currentRelax);
  }

  function rebindEmit() {
    if (!device || !emitPipes || !slabs.length) return;
    const view = (fieldVelTex || dummyField).createView({ dimension: '3d' });
    for (const sl of slabs) {
      sl.emitBind = device.createBindGroup({ layout: emitPipes.bgl, entries: [
        { binding: 0, resource: { buffer: sl.emitU } },
        { binding: 1, resource: { buffer: sl.pool } },
        { binding: 2, resource: { buffer: sl.free } },
        { binding: 3, resource: { buffer: sl.freeCnt } },
        { binding: 4, resource: { buffer: tablePosBuf } },
        { binding: 5, resource: { buffer: pathBuf } },
        { binding: 6, resource: view },
        { binding: 7, resource: fieldSampler },
        { binding: 8, resource: { buffer: sl.poolArgs } },
      ] });
    }
    emitBind = slabs[0].emitBind;
  }

  function rebindDerive() {
    if (!device || !derivePipe || !slabs.length) return;
    for (const sl of slabs) {
      sl.deriveBind = device.createBindGroup({ layout: derivePipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: deriveU } },
        { binding: 1, resource: { buffer: sl.pool } },
        { binding: 2, resource: { buffer: sl.inst } },
        { binding: 3, resource: { buffer: sl.args } },
        { binding: 4, resource: { buffer: tableBuf } },
      ] });
    }
    deriveBind = slabs[0].deriveBind;
  }

  Object.assign(runtime, {
    resize(w, h) { return plate ? plate.resize(w, h) : false; },
    setRamp(which, px) { if (plate) plate.setRamp(which, px); },
    setArt(px, w, h) { if (plate) plate.setArt(px, w, h); },

    /** The spawn table's colours, as the bake numbers them. Rebinds. */
    setSpawnTable(colors) {
      if (!device || !colors) return;
      /*
       * THE TABLE'S COLOURS ARE BYTES, AND THE SHADER READS FLOATS.
       *
       * `particleObjectRaster.js` builds them as `Uint8Array(count * 3)`. Handing
       * that to writeBuffer failed outright — its byte length is a multiple of 4
       * only when the site count happens to be, so a layer emitter threw
       * "Number of bytes to write must be a multiple of 4" and took the frame
       * with it. And had it not thrown, deriveWgsl declares
       * `tableColors: array<f32>` and would have read those bytes as floats:
       * every particle wearing a colour assembled from four unrelated channels.
       *
       * One conversion fixes both. The 0-255 range is kept because the shader
       * divides by 255, exactly as the CPU path does.
       */
      const f = colors instanceof Float32Array ? colors : Float32Array.from(colors);
      const bytes = Math.max(16, f.byteLength);
      tableBuf.destroy();
      tableBuf = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(tableBuf, 0, f);
      rebindDerive();
    },

    /**
     * Build (or tear down) the fluid grid for this system.
     *
     * `F` is `system.forces` and `box` the solver bounds. A model of 'off'
     * releases everything and uncouples the particles. Everything else is a
     * uniform, so changing buoyancy or swirl costs nothing.
     */
    configureFluid(F, box, seedOpts = {}) {
      const FL = (F && F.fluid) || { model: 'off' };
      const on = FL.model !== 'off';
      if (!on) {
        if (fluid) { for (const t of fluid.textures) { try { t.destroy(); } catch { /* gone */ } } fluid = null; }
        runtime.setFluidField(null, 0);
        return false;
      }
      const dims = fluidGridDims(FL.fidelity, box);
      const key = `${dims.nx}x${dims.ny}x${dims.nz}`;
      if (!fluid || fluid.key !== key) {
        if (fluid) for (const t of fluid.textures) { try { t.destroy(); } catch { /* gone */ } }
        const TU = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST;
        const tex = (fmt) => device.createTexture({ size: [dims.nx, dims.ny, dims.nz], dimension: '3d', format: fmt, usage: TU });
        const velA = tex(VEL_FORMAT), velB = tex(VEL_FORMAT);
        const matA = tex(MAT_FORMAT), matB = tex(MAT_FORMAT);
        const prsA = tex(PRS_FORMAT), prsB = tex(PRS_FORMAT);
        const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear',
          addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
        const uBuf = device.createBuffer({ size: FLUID_U_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const splatBuf = device.createBuffer({ size: SPLAT_FLOATS * 4 * 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        const view = (t) => t.createView({ dimension: '3d' });
        const bind = (vS, vD, mS, mD, pS, pD) => device.createBindGroup({ layout: fluidPipes.bgl, entries: [
          { binding: 0, resource: { buffer: uBuf } },
          { binding: 1, resource: view(vS) }, { binding: 2, resource: view(vD) },
          { binding: 3, resource: view(mS) }, { binding: 4, resource: view(mD) },
          { binding: 5, resource: view(pS) }, { binding: 6, resource: view(pD) },
          { binding: 7, resource: samp }, { binding: 8, resource: { buffer: splatBuf } },
        ] });
        fluid = { key, dims, velA, velB, matA, matB, prsA, prsB, samp, uBuf, splatBuf, bind,
          textures: [velA, velB, matA, matB, prsA, prsB],
          u: new Float32Array(FLUID_U_FLOATS), splats: new Float32Array(SPLAT_FLOATS * 12),
          velCur: 0, matCur: 0, prsCur: 0 };
      }
      const u = fluid.u;
      const set = (k, v) => { u[FLUID_KEYS.indexOf(k)] = Number.isFinite(v) ? v : 0; };
      set('nx', dims.nx); set('ny', dims.ny); set('nz', dims.nz); set('dt', STEP_DT);
      set('hx', box.x / dims.nx); set('hy', box.y / dims.ny); set('hz', box.z / dims.nz);
      /*
       * THE BAKE'S OWN SCALE FACTORS, transcribed rather than invented.
       *
       * Every one of these is a magic constant that exists only in
       * gpuEngine.js's packUniforms and fluid.js, and a slider's number means
       * nothing without it. The first version of this guessed at them and the
       * result was a fluid that ran but did almost nothing: swirl was written as
       * `swirl * 0.01` where the bake uses `swirl * 2.4` — **240 times too
       * weak** — so vorticity confinement produced no visible curl at all and
       * Ember Swirl, whose entire look IS that curl, came out as a symmetric
       * fountain.
       *
       * The decay terms are `1 / (1 + k*dt)`, not `1 - k*dt`. They agree to
       * first order and diverge over hundreds of steps, which is exactly the
       * timescale a plume lives on.
       */
      const smoke = FL.model === 'smoke';
      set('smoke', smoke ? 1 : 0);
      set('buoy', smoke ? (FL.smoke?.buoyancy || 0) * 1.6 : 0);
      set('weight', smoke ? (FL.smoke?.weight || 0) * 1.6 : 0);
      set('cooling', FL.smoke?.cooling); set('dissipate', FL.smoke?.dissipate);
      set('fade', FL.fade);
      set('swirlEps', FL.swirl > 0.5 ? FL.swirl * 2.4 : 0);
      set('swirlR', Math.max(1, Math.round(FL.swirlSize || 1)));
      set('boundsOpen', FL.bounds === 'open' ? 1 : 0);
      set('viscA', Math.max(0, Math.min(0.92, (FL.viscosity || 0) * 0.02 * STEP_DT * 60)));
      set('boxX', box.x); set('boxY', box.y); set('boxZ', box.z);
      set('denK', smoke ? 1 / (1 + (FL.smoke?.dissipate || 0) * STEP_DT) : 1);
      set('heatK', smoke ? 1 / (1 + (FL.smoke?.cooling || 0) * STEP_DT) : 1);
      set('fadeK', 1 / (1 + (FL.fade || 0) * STEP_DT));
      // The vortex acts on the medium too, not only on the particles in it.
      const FV = F.vortex || {};
      const VMODE = { vortex: 0, orbit: 1, twist: 2, attract: 3, repel: 4 };
      const VAXIS = { x: 0, y: 1, z: 2 };
      set('vortOn', (FV.strength || 0) > 0.01 ? 1 : 0);
      set('vortStr', FV.strength);
      set('vortScale', Math.max(1e-3, FV.scale || 1));
      set('vortMode', VMODE[FV.mode] ?? 0);
      set('vortAxis', VAXIS[FV.axis] ?? 2);
      set('vortLift', FV.lift);
      fluid.pressureSteps = Math.max(0, FL.pressureSteps | 0);
      fluid.viscOn = (FL.viscosity || 0) >= 0.5;
      fluid.sites = null;
      fluid.draft = F.draft || null;
      fluid.smoke = FL.model === 'smoke';
      fluid.heat = FL.smoke?.heat || 0;
      // Couple the particles to the settled field, at the bake's own strength.
      runtime.setFluidField(fluid.velA, 1 - Math.exp(-(FL.force || 0) * 0.03 * STEP_DT));
      return true;
    },

    /**
     * A provider called ONCE PER STEP with (t, firstUid, spawnCount), returning
     * the stir sites for that step. A callback rather than a setter because the
     * sites are per-step and a single advanceTo runs hundreds of steps — handing
     * over one list would stir every one of them with the same stale positions.
     */
    setSiteProvider(fn) { siteProvider = typeof fn === 'function' ? fn : null; },

    /**
     * Hand the particles a fluid to be carried by. `relax` is the CPU solver's
     * own coupling strength, `1 - exp(-force * 0.03 * dt)`; pass null to
     * uncouple. Rebinds, because the texture is part of the bind group.
     */
    setFluidField(velTexture, relax) {
      if (fieldVelTex === (velTexture || null) && (!Number.isFinite(relax) || relax === currentRelax)) return;
      if (Number.isFinite(relax)) currentRelax = relax;
      fieldVelTex = velTexture || null;
      eArray[eIdx('fluidOn')] = velTexture ? 1 : 0;
      eArray[eIdx('relax')] = currentRelax;
      rebindEmit();
    },

    /** The spawn table's POSITIONS, in emitter unit space — what a 'layer'
     *  emitter fires from. Separate from the colours the derive pass reads. */
    setSpawnPositions(positions) {
      if (!device || !positions) return;
      // Float32 already, but coerced anyway: the colours next door were bytes and
      // the shader reads f32 here too. Making the whole path take one type is
      // cheaper than remembering which of the two is which.
      const f = positions instanceof Float32Array ? positions : Float32Array.from(positions);
      tablePosBuf.destroy();
      tablePosBuf = device.createBuffer({ size: Math.max(16, f.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(tablePosBuf, 0, f);
      rebindEmit();
    },

    /** The resampled emit path (fluid.js's layout: PATH_N x 6 floats). */
    setEmitPath(pathS) {
      if (!device) return;
      pathBuf.destroy();
      pathBuf = device.createBuffer({ size: Math.max(16, pathS.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(pathBuf, 0, pathS);
      rebindEmit();
    },

    /**
     * The emitter and the forces. Everything here is a uniform, so changing any
     * of it is free — no rebuild, no re-bake. `emitter` mirrors the schema's
     * `system.emitters[0]`; `forces` carries gravity, drag and the bounds.
     */
    configureEmitter(emitter, forces = {}, opts = {}) {
      const e = emitter;
      const set = (k, v) => { eArray[eIdx(k)] = Number.isFinite(v) ? v : 0; };
      set('shape', SHAPE[e.shape] ?? 0);
      set('dirMode', DIR_MODE[e.dirMode] ?? 0);
      set('posX', e.position?.x); set('posY', e.position?.y); set('posZ', e.position?.z);
      set('sizeX', e.size?.x); set('sizeY', e.size?.y); set('sizeZ', e.size?.z);
      set('dirX', e.direction?.x); set('dirY', e.direction?.y); set('dirZ', e.direction?.z);
      set('spread', e.spread);
      set('speed', e.speed?.value); set('speedRandom', e.speed?.random);
      set('lifetime', e.lifetime?.value); set('lifetimeRandom', e.lifetime?.random);
      set('ringRadius', e.ring?.radius); set('ringThickness', e.ring?.thickness);
      /*
       * DISTRIBUTION. Resolved by the SAME prepareDistribution the bake calls,
       * so the lattice dims, the resolved site count and the bit width are one
       * computation shared by both runtimes rather than two that have to agree.
       * `opts.poolSize` is what "auto sites" resolves to — the pool this engine
       * actually owns, which is the only count at which nothing doubles up.
       */
      // The seed lane is already set by setSeed; read it back rather than
      // taking a second copy that could disagree with it.
      const dp = prepareDistribution(e, eArray[eIdx('seed')] | 0, opts.poolSize || 0);
      set('distMode', DIST_MODE[dp.mode] ?? 0);
      set('distJitter', dp.jitter);
      set('distOrder', dp.order);
      set('distSites', dp.sites);
      set('distGx', dp.gx); set('distGy', dp.gy); set('distGz', dp.gz);
      set('distP0', dp.p0); set('distP1', dp.p1);
      set('distSeq', dp.seq);
      set('distAxis', dp.axis);
      set('_d0', dp.bits);
      set('tableCount', opts.tableCount || 0);
      set('pathN', opts.pathN || 0);
      set('gravX', forces.gravity?.x); set('gravY', forces.gravity?.y); set('gravZ', forces.gravity?.z);
      set('drag', forces.drag);
      /*
       * THE GLOBAL FORCES. Eight of the ten shipped presets use one of these,
       * and without them a system runs on gravity and drag alone — which for
       * Ember Swirl means no curl at all, and for Dust, Snow and Sparks means
       * motes that fall straight instead of drifting.
       *
       * The index maps mirror gpuEngine.js's, which the WGSL bodies came from.
       */
      const T = forces.turbulence || {};
      const V = forces.vortex || {};
      const TURB_PATTERN = { smooth: 0, wave: 1, swirl: 2, billow: 3, ridged: 4 };
      const VORT_MODE = { vortex: 0, orbit: 1, twist: 2, attract: 3, repel: 4 };
      const VORT_AXIS = { x: 0, y: 1, z: 2 };
      const turbOn = (T.strength || 0) > 0.01;
      set('turbOn', turbOn ? 1 : 0);
      set('turbStr', T.strength);
      set('turbScale', T.scale);
      set('turbSpeed', T.speed);
      set('turbPat', TURB_PATTERN[T.pattern] ?? 0);
      set('turbOct', Math.max(1, Math.round(T.complexity || 1)));
      set('turbSeed', seed | 0);
      set('turbDir', (T.direction || 0) * Math.PI / 180);
      const vortOn = (V.strength || 0) > 0.01;
      set('vortOn', vortOn ? 1 : 0);
      set('vortStr', V.strength);
      set('vortScale', Math.max(1e-3, V.scale || 1));
      set('vortMode', VORT_MODE[V.mode] ?? 0);
      set('vortAxis', VORT_AXIS[V.axis] ?? 2);
      set('vortLift', V.lift);
      set('boundsMode', forces.boundsMode || 0);
      set('boxX', forces.box?.x); set('boxY', forces.box?.y); set('boxZ', forces.box?.z);
      set('restitution', Number.isFinite(forces.restitution) ? forces.restitution : 0.6);
      sched = {
        rate: e.rate || 0,
        start: Number.isFinite(e.start) ? e.start : 0,
        end: Number.isFinite(e.end) ? e.end : 1e9,
        staticEmit: e.emit === 'static',
        bursts: (e.bursts || []).filter((b) => b.count > 0).map((b) => ({ time: b.time, count: b.count })),
        preRoll: opts.preRoll || 0,
      };
      if (sched.staticEmit) sched.bursts = [{ time: Math.max(0, sched.start), count: cap }];
      // NOTHING IS RE-ARMED HERE. See the note on `stepIndex` — a pulse fires on
      // one step index and this function runs every frame.
      // A changed pre-roll moves the start of time itself, so the run so far is
      // no longer the same simulation. Rewind rather than splice.
      const nextPreRoll = Math.max(0, sched.preRoll);
      if (nextPreRoll !== preRollT) { preRollT = nextPreRoll; runtime.reset(); }
    },

    /**
     * Rewind to t = 0: every slot empty, every slot free, no uid issued.
     *
     * A live engine can only step forward, so a backward seek is a reset plus a
     * fast-forward — see the plan's Part 5 on what that costs and where
     * checkpoints come in.
     */
    reset() {
      if (!device || !slabs.length) return;
      checkpoints.length = 0;
      // DESCENDING, so popping from the top of the stack yields slot 0, then 1,
      // then 2. That is what makes usedSlots() an exact bound instead of a guess.
      const free = new Uint32Array(slabCap);
      for (let i = 0; i < slabCap; i++) free[i] = slabCap - 1 - i;
      const args0 = new Uint32Array([1, 1, 1, 0]);
      const cnt0 = new Uint32Array([slabCap]);
      for (const sl of slabs) {
        device.queue.writeBuffer(sl.free, 0, free);
        device.queue.writeBuffer(sl.freeCnt, 0, cnt0);
        device.queue.writeBuffer(sl.poolArgs, 0, args0);
      }
      /*
       * CLEAR ONLY WHAT WAS EVER WRITTEN.
       *
       * This allocated and uploaded `cap * PART_FLOATS` floats — 1 GB of zeros
       * for an eight-million pool — on every reset, and a reset happens on every
       * backward seek and every pre-roll change. Slots above the high-water mark
       * have never been written since the buffer was created, so they are
       * already zero; clearing them is pure cost, and at a million particles it
       * was the single most expensive thing a scrub could do.
       */
      for (const sl of slabs) {
        device.queue.writeBuffer(sl.pool, 0, new Float32Array(highWater(sl) * PART_FLOATS));
        sl.issued = 0;
      }
      /*
       * AND THE MEDIUM. A reset used to clear the particles and leave the fluid
       * exactly as it was, which quietly broke determinism for every fluid
       * system: seek to four seconds and back to two, and the smoke is carried
       * by a field that has been running for four — not the one a fresh run to
       * two would have built. Preview and export then disagree about the same
       * timecode, and so do two exports.
       *
       * Measured before the fix on Rising Smoke through the real render page:
       * the same timecode rendered twice differed on 1.5% of its pixels, and two
       * back-to-back captures on 3.0%. A particle system with no fluid was exact
       * to 0.000% throughout, which is what pointed at the medium.
       *
       * Six textures on a medium grid is about a megabyte — a reset is already
       * the expensive path, and correctness is not optional here.
       */
      if (fluid) {
        const d = fluid.dims;
        const texels = d.nx * d.ny * d.nz;
        const zero16 = new Uint8Array(texels * 8);   // rgba16float
        const zero32 = new Uint8Array(texels * 4);   // r32float
        for (const t of [fluid.velA, fluid.velB, fluid.matA, fluid.matB]) {
          device.queue.writeTexture({ texture: t }, zero16,
            { bytesPerRow: d.nx * 8, rowsPerImage: d.ny }, [d.nx, d.ny, d.nz]);
        }
        for (const t of [fluid.prsA, fluid.prsB]) {
          device.queue.writeTexture({ texture: t }, zero32,
            { bytesPerRow: d.nx * 4, rowsPerImage: d.ny }, [d.nx, d.ny, d.nz]);
        }
        // The ping-pong parity is part of the state: a solve that starts on the
        // other side of the swap reads and writes a different pair.
        fluid.velCur = 0; fluid.matCur = 0; fluid.prsCur = 0;
      }
      acc = 0; nextUid = 1;
      stepIndex = 0;
      simT = -preRollT;          // the bake's time base, see preRollT above
    },

    /** Clip-local time the simulation has reached, and how many uids have been
     *  issued. METHODS, not getters: Object.assign reads a source getter and
     *  copies its VALUE, so an accessor here would freeze at whatever simT held
     *  when this literal was evaluated — which is zero, forever. */
    now() { return simT; },
    uidIssued() { return nextUid - 1; },

    /**
     * Advance ONE fixed step. Fixed, not by a frame delta: the whole
     * determinism model depends on step count being a function of time and
     * nothing else, so preview, scrubbing and export agree.
     */
    step() {
      if (!runtime.ok || runtime.disposed) return false;
      const si = stepIndex + 1;
      const t = si * STEP_DT - preRollT;

      // How many are born this step — one accumulator, O(1).
      let spawnCount = 0;
      if (!sched.staticEmit && t >= sched.start - sched.preRoll && t <= sched.end) {
        acc += sched.rate * STEP_DT;
        const n = Math.floor(acc);
        acc -= n;
        spawnCount += n;
      }
      // Pulses fire on their own step index and on no other — see burstStepFor.
      for (let b = 0; b < sched.bursts.length; b++) {
        if (si === burstStepFor(sched.bursts[b].time)) spawnCount += sched.bursts[b].count;
      }
      spawnCount = Math.min(spawnCount, cap);

      /*
       * SPLITTING THE STEP'S BIRTHS ACROSS SLABS.
       *
       * Slab s owns every uid congruent to s modulo S, so the uids born this
       * step are dealt out to the slabs like cards: each takes a strided
       * subsequence of [firstUid, firstUid + spawnCount). Which slab a uid lands
       * in is a function of the uid alone, so the split is deterministic and
       * every particle's appearance — position, direction, speed, life, all pure
       * functions of (seed, uid) — is exactly what it would have been unchunked.
       *
       * With S = 1 the arithmetic below yields (firstUid, 1, spawnCount), which
       * is what the single-pool version did.
       */
      const A = nextUid;
      for (const sl of slabs) {
        const idx = slabs.indexOf(sl);
        const first = A + (((idx - A) % S) + S) % S;
        const n = first >= A + spawnCount ? 0 : Math.floor((A + spawnCount - 1 - first) / S) + 1;
        eArray[eIdx('t')] = t;
        eArray[eIdx('firstUid')] = A;
        eArray[eIdx('uidBase')] = first;
        eArray[eIdx('uidStride')] = S;
        eArray[eIdx('spawnCount')] = n;
        device.queue.writeBuffer(sl.emitU, 0, eArray);
        sl.spawnThisStep = n;
        sl.issued += n;
      }
      nextUid += spawnCount;

      const enc = device.createCommandEncoder();
      const run = (pipe, count, bind) => {
        if (count <= 0) return;
        const pass = enc.beginComputePass();
        pass.setPipeline(pipe);
        pass.setBindGroup(0, bind);
        const g = Math.ceil(count / 64);
        pass.dispatchWorkgroups(Math.min(256, g), Math.ceil(g / 256));
        pass.end();
      };
      // OVER THE USED PART OF THE POOL, NOT OVER THE CAP.
      //
      // Every pool pass used to dispatch over `cap`, so raising Max particles to
      // a million cost a million invocations per pass per step even with a
      // thousand particles alive — the editor got slow the moment the number was
      // typed, before a single extra particle existed.
      //
      // The bound is `usedSlots()`, and it is exact rather than a guess: the free
      // list is built in DESCENDING order so popping from its top hands out slot
      // 0, then 1, then 2. Occupancy therefore never reaches beyond the number of
      // uids ever issued, which the CPU already knows without asking the GPU
      // anything.
      // REAP FIRST, so a slot freed this step is available to this step's births
      // — which is what keeps a system at its cap from stuttering every time a
      // wave of particles expires together. Per slab, because each has its own
      // pool and its own free list.
      for (const sl of slabs) {
        run(emitPipes.reap, usedSlots(sl), sl.emitBind);
        run(emitPipes.emit, sl.spawnThisStep, sl.emitBind);
      }

      // THE FLUID, BETWEEN EMISSION AND INTEGRATION. The medium is advanced
      // first so the particles are carried by THIS step's field rather than
      // last one's, and the emitter's stir goes in before the solve so the
      // pressure projection sees it.
      if (fluid) {
        fluid.sites = siteProvider ? siteProvider(t, nextUid - spawnCount, spawnCount) : null;
        stepFluid(enc, t);
      }

      for (const sl of slabs) run(emitPipes.integrate, usedSlots(sl), sl.emitBind);
      device.queue.submit([enc.finish()]);

      stepIndex = si;
      simT = t;
      runtime.stats.steps = (runtime.stats.steps || 0) + 1;
      takeCheckpoint();
      return true;
    },

    /**
     * Bring the simulation to clip time `t`.
     *
     * Forward is just steps. BACKWARD restores the nearest checkpoint at or
     * before `t` and re-runs the remainder; with no checkpoint it resets and
     * re-runs from zero. Returns how many steps it actually ran, which is what
     * a progress indicator should show — a long seek is seconds of work and the
     * editor must say so rather than appear to hang.
     */
    advanceTo(t, maxSteps = 200000) {
      if (t < simT - 1e-9) {
        const c = nearestCheckpoint(t);
        if (c) restoreCheckpoint(c); else runtime.reset();
      }
      // Never fewer steps than the pre-roll: a target of 0 still has to run the
      // whole pre-roll to arrive at the populated box frame 0 is supposed to show.
      let n = 0;
      while (simT < t - 1e-9 && n < maxSteps) { runtime.step(); n++; }
      return n;
    },

    /** Upload pool slots. `offsetSlot` is in particles, not bytes. */
    writePool(floats, offsetSlot = 0) {
      if (device && poolBuf) device.queue.writeBuffer(poolBuf, offsetSlot * PART_FLOATS * 4, floats);
    },

    /**
     * Derive this frame's instances and paint them. `t` is clip-local seconds —
     * the same clock the bake uses, so age is t - birthTime and no counter can
     * drift out of step with the playhead.
     */
    render({ t, mv, proj, derive = {}, scalars = {}, igniteColor, blend = 'alpha' }) {
      if (!runtime.ok || runtime.disposed) return false;
      uArray[DERIVE_KEYS.indexOf('t')] = t;
      for (const k of Object.keys(derive)) {
        const i = DERIVE_KEYS.indexOf(k);
        if (i >= 0) uArray[i] = derive[k];
      }
      device.queue.writeBuffer(deriveU, 0, uArray);

      // ONE DERIVE PER SLAB, each compacting its own survivors into its own
      // instance buffer with its own atomic — so each slab ends the pass holding
      // its own instance count, and the draw issues one indirect call per slab
      // inside a single render pass.
      const enc = device.createCommandEncoder();
      for (const sl of slabs) {
        device.queue.writeBuffer(sl.args, 0, ARGS_RESET);
        const pass = enc.beginComputePass();
        pass.setPipeline(derivePipe);
        pass.setBindGroup(0, sl.deriveBind);
        // The same bound the sim passes use — see usedSlots().
        const groups = Math.ceil(usedSlots(sl) / 64);
        pass.dispatchWorkgroups(Math.min(256, groups), Math.ceil(groups / 256));
        pass.end();
      }
      device.queue.submit([enc.finish()]);

      plate.draw({ slabs: slabs.map((sl) => ({ inst: sl.inst, args: sl.args })),
        mv, proj, scalars, igniteColor, blend });
      runtime.stats.frames++;
      return true;
    },

    /**
     * Keep up to `n` checkpoints, one every `everySeconds` of clip time. Pass 0
     * to turn them off and free the memory.
     */
    setCheckpoints(n, everySeconds = 1) {
      const want = Math.max(0, n | 0);
      if (want === ckMax && Math.abs(ckEvery - Math.max(0.05, everySeconds)) < 1e-6) return ckMax;
      for (const c of checkpoints) { try { c.pool.destroy(); c.free.destroy(); c.freeCount.destroy(); } catch { /* gone */ } }
      checkpoints = [];
      /*
       * CLAIM THE MEMORY BEFORE PROMISING IT, exactly as the pool does.
       *
       * Checkpoints are the largest optional allocation a layer makes — 52 bytes
       * a particle EACH — so they go through the same shared ledger as the pool
       * rather than being spent quietly on the side. Refused, the layer keeps
       * none and scrubs the slow way, which is the correct trade rather than an
       * out-of-memory a few edits later.
       */
      // A checkpoint copies the pool and the free list, and a chunked pool has
      // one of each PER SLAB. They are switched off by policy (see
      // checkpointPlan), so rather than carry an untested multi-slab copy path,
      // a chunked runtime simply keeps none and says so by returning 0.
      if (S > 1) { ckMax = 0; runtime.stats.checkpointMb = 0; return 0; }
      const extraMb = (want * cap * CHECKPOINT_BYTES_PER_PARTICLE) / 1048576;
      const claim = runtime.claimKey ? reserveParticles(runtime.claimKey, cap, extraMb) : { ok: true };
      ckMax = claim.ok ? want : 0;
      if (!claim.ok && runtime.claimKey) reserveParticles(runtime.claimKey, cap, 0);
      ckEvery = Math.max(0.05, everySeconds);
      runtime.stats.checkpointMb = +((ckMax * cap * CHECKPOINT_BYTES_PER_PARTICLE) / 1048576).toFixed(1);
      return ckMax;
    },

    /** How many checkpoints are actually held, for the tests and the readout. */
    checkpointCount() { return checkpoints.length; },

    /** How much a seek would have to re-simulate from the nearest checkpoint. */
    seekCostSteps(t) {
      const from = nearestCheckpoint(t);
      const base = from ? from.t : 0;
      return t < simT - 1e-9 || !from ? Math.max(0, Math.round((t - base) / STEP_DT)) : Math.max(0, Math.round((t - simT) / STEP_DT));
    },

    /** TESTS ONLY — the invariant audit in tests/particles-gpu-scale/ reads the
     *  free list and the pool back to check them. Nothing on the shipped path
     *  reads any of this: that is the whole point of the design. */
    __debugBuffers() { return { pool: poolBuf, free: freeBuf, freeCount: freeCntBuf, inst: instBuf, args: argsBuf }; },

    /** Export awaits this so the plate is finished before the frame is composited.
     *  The preview does not, and is one frame stale as a result — invisible. */
    settle() { return device ? device.queue.onSubmittedWorkDone() : Promise.resolve(); },

    /**
     * Release every GPU object this runtime owns. Separate from dispose() so the
     * aborted-creation path can use it too — that path has to free things
     * dispose() could not have seen, because they did not exist when it ran.
     *
     * THE FLUID WAS NOT IN HERE. Six 3D textures, a uniform buffer and a splat
     * buffer per fluid layer, and nothing ever destroyed any of them: a project
     * whose smoke systems were repeatedly re-configured (any bounds or fidelity
     * edit rebuilds the grid) leaked a full set each time. They are the largest
     * thing after the pool.
     */
    disposeGpuObjects() {
      for (const sl of slabs) {
        for (const b of [sl.pool, sl.inst, sl.free, sl.freeCnt, sl.poolArgs, sl.args, sl.emitU]) {
          try { b?.destroy(); } catch { /* gone */ }
        }
      }
      slabs.length = 0;
      for (const b of [tableBuf, deriveU, tablePosBuf, pathBuf]) {
        try { b?.destroy(); } catch { /* gone */ }
      }
      poolBuf = instBuf = argsBuf = tableBuf = deriveU = emitU = null;
      freeBuf = freeCntBuf = tablePosBuf = pathBuf = poolArgsBuf = null;
      for (const c of checkpoints) { try { c.pool.destroy(); c.free.destroy(); c.freeCount.destroy(); } catch { /* gone */ } }
      checkpoints = [];
      if (fluid) {
        for (const t of fluid.textures) { try { t.destroy(); } catch { /* gone */ } }
        try { fluid.uBuf?.destroy(); } catch { /* gone */ }
        try { fluid.splatBuf?.destroy(); } catch { /* gone */ }
        fluid = null;
      }
      try { dummyField?.destroy(); } catch { /* gone */ }
      dummyField = null;
      fieldVelTex = null;
      plate?.destroy();
      plate = null;
      runtime.canvas = null;
    },

    dispose() {
      runtime.disposed = true;
      runtime.ok = false;
      if (runtime.claimKey) { releaseParticles(runtime.claimKey); runtime.claimKey = null; }
      runtime.disposeGpuObjects();
    },
  });

  return runtime;
}
