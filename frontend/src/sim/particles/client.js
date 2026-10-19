// Bake cache for particle systems.
//
// One cache per particle layer, keyed by its runtime key (item id, scoped by the
// sequence path — a nested item's bare id can collide with a top-level one). The
// bake is invalidated by the SIMULATION hash only: recolouring, resizing sprites,
// swapping objects and changing blend mode all keep the existing cache, which is
// what makes those edits instant.
//
// WHEN THE BAKE RUNS WHERE
// ------------------------
// A frame can never be drawn from a cache that has not arrived, so the rule is:
//
//   * no cache yet, or the caller says `sync` (export, a still) → bake HERE, now.
//     Export gets one pass per frame; there is nothing to come back to.
//   * a usable cache already exists → keep drawing it and bake the replacement in
//     a worker, swapping atomically when it lands. This is the case that used to
//     stall the UI for 30-110 ms on every solver edit.
//
// The worker is a bonus, never a dependency: if it cannot be created (or dies),
// everything falls back to baking on this thread and the only difference is the
// hitch.

import { bakeParticles, STRIDE } from './solver.js';
import { particleSimHash, PARTICLE_MAX_PARTICLES, PARTICLE_MAX_CPU, PARTICLE_SMOOTH_GPU, PARTICLE_MAX_GPU } from './schema.js';
/*
 * STATIC, AND THAT IS SAFE. tier.js is the decision and the budget ledger; it
 * imports layout.js for two integers and nothing else. None of the WGSL, the
 * pipelines or the device request are behind it — those live in gpu/manager.js,
 * which stays a dynamic import for exactly that reason. ParticlePanel already
 * imports this module statically, and tests/particles-gpu-scale/verify_lazy_particles.mjs
 * is the gate that keeps the distinction honest.
 */
import { chooseTier, TIER } from './gpu/tier.js';

// Total bytes of cached simulation before the least-recently-used entries go.
//
// Sized against the particle cap, not picked round: a 6 s solver at 100,000
// particles is ~420 MB, so a small budget would evict it the moment a second
// solver appeared and the two would re-bake each other for ever. 768 MB holds
// one system at the cap plus several ordinary ones (a 6 s / 2000-particle cache
// is ~8 MB). The cap is a ceiling for one heavy system, not a size to build a
// whole project out of — see the panel's warning when a cache gets large.
const BUDGET_BYTES = 768 * 1024 * 1024;

const caches = new Map();    // key -> { hash, cache, used }
const pending = new Map();   // key -> { hash, id } — one job per layer at a time
// Progressive results: key -> { hash, id, cache } — the chunks of an in-flight
// bake assembled into a PARTIAL cache (cache.baked = snapshots present), drawn
// while the rest arrives. Replaced by the final cache when it lands.
const partials = new Map();
// Debounce: key -> { hash, since } — a slider drag changes the hash sixty times
// a second; the worker is only asked once the hash has held for DEBOUNCE_MS.
const debounce = new Map();
const DEBOUNCE_MS = 250;
let clock = 0;
let jobSeq = 0;
let worker = null;
let workerDead = false;
let onBaked = null;

/**
 * The spawn table, as the worker must see it: everything the solver could read,
 * with anything unclonable (a memo, a canvas, a function) left behind. Copying
 * the table wholesale is deliberate — see the note at the postMessage below.
 */
function spawnPayload(table) {
  if (!table) return null;
  const out = {};
  for (const [k, v] of Object.entries(table)) {
    if (k.startsWith('__')) continue;                       // private memos
    const t = typeof v;
    if (v == null || t === 'number' || t === 'string' || t === 'boolean' || ArrayBuffer.isView(v)) out[k] = v;
  }
  return out;
}

/*
 * PROXIMITY: a pose track plus one distance field per source.
 *
 * `spawnPayload` flattens ONE object and this is a nested pair, so it needs its
 * own wrapper rather than being quietly dropped on the way to the worker — which
 * would show up as "the effector works in the preview and does nothing in the
 * export", the worst class of bug this codebase has.
 *
 * Cloned, not transferred: the fields are cached on the main thread and read by
 * the renderer every frame, and a transfer would detach them from under it.
 */
function proxPayload(prox) {
  if (!prox?.track || !Array.isArray(prox.tables)) return null;
  return {
    track: spawnPayload(prox.track),
    tables: prox.tables.map((t) => (t ? spawnPayload(t) : null)),
  };
}

function evictIfNeeded() {
  let total = 0;
  for (const entry of caches.values()) total += entry.cache.bytes;
  if (total <= BUDGET_BYTES) return;
  const byAge = [...caches.entries()].sort((a, b) => a[1].used - b[1].used);
  for (const [key, entry] of byAge) {
    caches.delete(key);
    total -= entry.cache.bytes;
    if (total <= BUDGET_BYTES) break;
  }
}

function getWorker() {
  if (worker || workerDead) return worker;
  try {
    worker = new Worker(new URL('./bakeWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const { id, key, cache, chunk, error } = event.data || {};
      const job = pending.get(key);
      // A result whose job is gone was superseded — by a newer edit, by a
      // synchronous bake (export), or by the layer being deleted. Dropping it is
      // the whole of cancellation: an older cache must never replace a newer one.
      if (!job || job.id !== id) return;
      if (chunk) {
        // Assemble the partial cache in place. Full-size arrays from the first
        // chunk (sized by maxP × snapCount), filled as chunks arrive.
        let part = partials.get(key);
        if (!part || part.id !== id) {
          part = {
            hash: job.hash, id,
            cache: {
              maxP: chunk.maxP, cacheHz: chunk.cacheHz, snapCount: chunk.snapCount, duration: chunk.duration,
              data: new Float32Array(chunk.snapCount * chunk.maxP * STRIDE),
              uids: new Int32Array(chunk.snapCount * chunk.maxP),
              rot: chunk.rot ? new Float32Array(chunk.snapCount * chunk.maxP) : null,
              lifeOf: chunk.lifeOf, releaseOf: chunk.releaseOf, wrap: chunk.wrap,
              baked: 0, partial: true, bytes: 0, bakeMs: 0,
              deaths: { age: 0, bounds: 0, dropped: 0 }, grow: null,
            },
          };
          partials.set(key, part);
        }
        const c = part.cache;
        c.data.set(chunk.data, chunk.from * c.maxP * STRIDE);
        c.uids.set(chunk.uids, chunk.from * c.maxP);
        if (c.rot && chunk.rot) c.rot.set(chunk.rot, chunk.from * c.maxP);
        c.lifeOf = chunk.lifeOf; c.releaseOf = chunk.releaseOf;
        c.baked = chunk.to;
        try { onBaked?.(key); } catch { /* a dead listener must not stall bakes */ }
        return;
      }
      pending.delete(key);
      partials.delete(key);
      if (error || !cache) return;
      caches.set(key, { hash: job.hash, cache, used: ++clock });
      evictIfNeeded();
      // The frame that asked for this drew the previous cache; ask for a repaint
      // now that the real one is here.
      try { onBaked?.(key); } catch { /* a dead listener must not stall bakes */ }
    };
    worker.onerror = () => {
      // Fall back to this thread for the rest of the session rather than leaving
      // layers showing a stale simulation forever.
      workerDead = true;
      worker = null;
      pending.clear();
    };
  } catch {
    workerDead = true;
    worker = null;
  }
  return worker;
}

/** Called when an off-thread bake lands, so the caller can repaint. */
export function setParticleBakeListener(fn) {
  onBaked = fn;
}

/**
 * Hand a bake to the worker, CANCELLING whatever it was doing.
 *
 * A worker cannot be interrupted mid-bake, and a bake is tens of seconds for a
 * fluid system — so a slider drag used to queue a dozen bakes that all had to
 * finish before the one that mattered started. Terminating and respawning the
 * worker (~50 ms) is the only real cancel there is. Jobs of OTHER layers die
 * with it; they are re-requested by their next frame, as always.
 */
function postBake(key, hash, system, duration, spawnTable, collider, layerDrive, proximity, colliderTrack, emitterGate, colliderTables, colliderTracks, objectShapes) {
  // Only a job THIS layer already has in flight is worth killing the worker
  // for. Terminating whenever anything was pending made two particle layers
  // (or two keys for one layer) cancel each other forever — neither bake could
  // ever finish. Other layers' jobs that die with the worker are re-requested
  // by their next frame, which does not terminate anything (no pending job).
  if (pending.has(key) && worker) {
    try { worker.terminate(); } catch { /* already gone */ }
    worker = null;
    pending.clear();
    partials.clear();
  }
  const w = getWorker();
  if (!w) return false;
  const id = ++jobSeq;
  pending.set(key, { hash, id });
  w.postMessage({ id, key, system, duration, spawn: spawnPayload(spawnTable), collider: spawnPayload(collider), colliderTrack: spawnPayload(colliderTrack), colliderTables: (colliderTables || []).map(spawnPayload), colliderTracks: (colliderTracks || []).map(spawnPayload), emitterGate: spawnPayload(emitterGate), layerDrive: spawnPayload(layerDrive), proximity: proxPayload(proximity), objectShapes: spawnPayload(objectShapes) });
  return true;
}

/**
 * Debounce that finishes on its own. True when `hash` has already held for
 * DEBOUNCE_MS (post now). Otherwise it arms a timer that runs `post` itself
 * once the hash has held that long, then asks for a repaint — because a paused
 * editor draws a fresh layer exactly ONCE, and a debounce that merely checks
 * "has it held?" on each frame never gets its second frame: the bake was never
 * requested and the layer stayed empty (a bake-only system showed nothing at
 * all until something else happened to trigger a repaint).
 */
function settleThen(key, hash, post) {
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const d = debounce.get(key);
  if (d && d.hash === hash && now - d.since >= DEBOUNCE_MS) return true;
  if (d?.timer) clearTimeout(d.timer);
  const since = d && d.hash === hash ? d.since : now;
  const entry = { hash, since, timer: 0 };
  entry.timer = setTimeout(() => {
    const cur = debounce.get(key);
    if (cur !== entry) return;            // superseded by a newer hash
    entry.timer = 0;
    post();
    try { onBaked?.(key); } catch { /* listener gone */ }
  }, Math.max(0, DEBOUNCE_MS - (now - since)) + 1);
  debounce.set(key, entry);
  return false;
}

/**
 * The cache to draw this layer from.
 *
 * Always returns something usable. With `opts.sync` (or with nothing cached yet)
 * that is the exact simulation for this config; otherwise it may be the previous
 * one while its replacement bakes — which is why the panel reports "Updating".
 */
export function ensureParticleCache(key, system, duration, spawnTable = null, opts = {}) {
  /*
   * THE BAKE CLAMPS ITS OWN SIZE. The sanitiser's ceiling is the GPU engine's,
   * because a count has to survive a save for that engine to use it — so the
   * limit on what gets SNAPSHOTTED lives here, where the memory is actually
   * spent. Eight million particles over six seconds at 30 Hz is 33 GB of cache;
   * the bake will simulate a hundred thousand of them and no more.
   */
  if (system?.solver && system.solver.maxParticles > PARTICLE_MAX_PARTICLES) {
    system = { ...system, solver: { ...system.solver, maxParticles: PARTICLE_MAX_PARTICLES } };
  }
  // The collider table (an SDF baked from the picked layer, see particleLayer)
  // rides in on opts, and identifies itself by its own key — like the spawn table.
  const collider = opts.collider || null;
  // A followed collider's per-step poses. Part of the simulation's identity, so
  // it rides in on the collider key the way a Layer Velocity track does.
  const colliderTrack = opts.colliderTrack || null;
  const emitterGate = opts.emitterGate || null;
  // Every collider's field and pose track, positional. The singular pair is kept
  // for the fluid mask and the live engine, which take one collider each.
  const colliderTables = opts.colliderTables || null;
  const colliderTracks = opts.colliderTracks || null;
  // Layer Velocity: another layer's animation, sampled per step by the caller
  // (layerVelocity.js). Same contract as the collider — a flat bag of typed
  // arrays that identifies itself by key.
  const layerDrive = opts.layerDrive || null;
  // PROXIMITY (v4): the source layers' per-step poses plus their baked distance
  // fields. Only ever handed in when something in the block drives MOTION — a
  // look-only effector is read at draw time and never reaches the bake.
  const proximity = opts.proximity || null;
  // Packing's object-shape mode: one clump per included member, built from the
  // artwork by the caller (particleLayer.js objectShapesFor). Null for every
  // other system, and then it adds nothing to the key.
  const objectShapes = opts.objectShapes || null;
  const hash = particleSimHash(system, duration, spawnTable?.key || '', `${(colliderTables || [collider]).map((t) => t?.key || '').join(',')}`
    + `${(colliderTracks || [colliderTrack]).map((t) => t?.key || '').join(',')}`
    + `${emitterGate ? '|' + emitterGate.key : ''}`
    + `${objectShapes ? '|shapes:' + objectShapes.key : ''}`, layerDrive?.key || '', proximity?.track?.key || '');
  const existing = caches.get(key);
  if (existing && existing.hash === hash) {
    existing.used = ++clock;
    return existing.cache;
  }

  const w = opts.sync ? null : getWorker();

  // THE FIRST BAKE OF A BIG SYSTEM GOES OFF-THREAD TOO.
  //
  // With nothing cached there is nothing to keep drawing, so this used to bake on
  // the spot — fine at two thousand particles (~0.3 s), a frozen editor at a
  // hundred thousand (~13 s). Past a size threshold the job is handed to the
  // worker and the layer draws NOTHING until it lands; the editor stays live and
  // the "Updating the simulation…" toast says why. An export never takes this
  // path (opts.sync), because a render gets one pass per frame and an empty
  // frame would be encoded.
  // The partial cache of an in-flight bake for THIS hash: drawn while it fills.
  const part = partials.get(key);
  const partial = part && part.hash === hash && part.cache.baked > 0 ? part.cache : null;

  // A fluid system is heavy whatever its count: its grid steps 360 times a
  // second of clip, seconds of work that must never block the main thread.
  /*
   * PACKING IS HEAVY WHATEVER ITS COUNT, for the same reason a fluid system is:
   * the cost is per STEP and per CONTACT, not per particle. A dense 2,000
   * particle 3D system over 6 s measured 4.64 s of bake and sat well under the
   * particle-seconds threshold, so it ran synchronously on the main thread and
   * froze the editor on first load.
   */
  const packingOn = !!system.packing?.enabled;
  const heavy = Math.round(system.solver.maxParticles) * Math.max(0.1, duration) > 30000
    || (system.forces?.fluid?.model || 'off') !== 'off'
    || packingOn;
  if (!existing && w && heavy) {
    const job = pending.get(key);
    // Debounced like every other worker bake, so a drag on a fresh heavy system
    // does not restart the worker on every tick.
    if (!job || job.hash !== hash) {
      const post = () => postBake(key, hash, system, duration, spawnTable, collider, layerDrive, proximity, colliderTrack, emitterGate, colliderTables, colliderTracks, objectShapes);
      if (settleThen(key, hash, post)) post();
    }
    return partial;
  }

  if (!existing || !w) {
    const cache = bakeParticles(system, duration, spawnTable, collider, { layerDrive, proximity, colliderTrack, colliderTables, colliderTracks, emitterGate, objectShapes });
    caches.set(key, { hash, cache, used: ++clock });
    // Anything in flight for this layer is now stale by definition.
    pending.delete(key);
    partials.delete(key);
    evictIfNeeded();
    return cache;
  }

  const job = pending.get(key);
  if (!job || job.hash !== hash) {
    // The spawn table's arrays are copied rather than transferred: the renderer on
    // this thread still needs them for the particles' colours.
    //
    // THE WHOLE TABLE GOES, never a hand-picked list of its fields.
    //
    // It used to be a list, and the day the table grew an `arrival` array — the
    // one thing Grow Points activates on — the worker stopped receiving it. It
    // then baked a completely different clip (every particle emitted at once) and
    // replaced the correct cache the moment it landed, so a solver looked right
    // until you touched any control. The two bakes MUST be the same function of
    // the same input; the only way to guarantee that is to not restate the input.
    const post = () => postBake(key, hash, system, duration, spawnTable, collider, layerDrive, proximity, colliderTrack, emitterGate, colliderTables, colliderTracks, objectShapes);
    if (settleThen(key, hash, post)) post();
  }
  existing.used = ++clock;
  // Prefer the fresh partial over the stale full cache once it has something:
  // the clip fills in with the NEW simulation instead of showing the old one.
  return partial || existing.cache;
}

/** The cache for `key` without baking — for status readouts. */
export function peekParticleCache(key) {
  return caches.get(key)?.cache || null;
}

/** 'baking' while a replacement is in flight, 'ready' once it has landed. */
export function particleBakeStatus(key) {
  if (pending.has(key)) return 'baking';
  return caches.has(key) ? 'ready' : 'idle';
}

/** 0..1 of the in-flight bake that has arrived (1 when nothing is in flight). */
export function particleBakeProgress(key) {
  if (!pending.has(key)) return 1;
  const part = partials.get(key);
  if (!part || !part.cache.snapCount) return 0;
  return Math.min(1, part.cache.baked / part.cache.snapCount);
}

export function releaseParticleCache(key) {
  caches.delete(key);
  pending.delete(key);
  partials.delete(key);
  const d = debounce.get(key);
  if (d?.timer) clearTimeout(d.timer);
  debounce.delete(key);
  dropLive(key, '');
}

export function disposeAllParticleCaches() {
  for (const key of [...lives.keys()]) dropLive(key, '');
  caches.clear();
  pending.clear();
  partials.clear();
  for (const d of debounce.values()) if (d?.timer) clearTimeout(d.timer);
  debounce.clear();
  try { worker?.terminate(); } catch { /* already gone */ }
  worker = null;
  workerDead = false;
}

/** Drop caches for layers that are no longer on the timeline. */
export function gcParticleCaches(liveKeys) {
  for (const key of [...caches.keys()]) {
    if (!liveKeys.has(key)) caches.delete(key);
  }
  for (const key of [...pending.keys()]) {
    if (!liveKeys.has(key)) pending.delete(key);
  }
  for (const key of [...partials.keys()]) {
    if (!liveKeys.has(key)) partials.delete(key);
  }
  gcLives(liveKeys);
}

// ── LIVE preview (WebGPU) ────────────────────────────────────────────────────
//
// One engine per layer, stepped by the Player each frame. The bake above is
// what an export draws and what the preview falls back to; this is what the
// preview draws when it can. The governor is the engine's own step timing —
// nothing here polls anything: a layer that is not being drawn is not stepped.

const lives = new Map();   // key -> { engine, hash, fell, fellHash, reason, unavailable }

const lastLiveReason = new Map();

// The engine itself (gpuEngine.js: the WGSL, the pipelines, the device) is a
// SEPARATE chunk, loaded on the first frame a particle layer asks for a live
// preview. This module is imported statically by the editor for its status
// readouts, so a static import here would put the whole engine into the
// editor's bundle for every project — including the ones with no Solver Box.
let gpuMod = null;
let gpuLoad = null;
let gpuFailed = false;
function loadGpuEngine() {
  if (gpuMod) return Promise.resolve(gpuMod);
  if (!gpuLoad) {
    gpuLoad = import('./gpuEngine.js')
      .then((m) => { gpuMod = m; return m; })
      .catch(() => { gpuFailed = true; return null; });
  }
  return gpuLoad;
}
/** The engine module, or null while it loads — the layer draws from the bake meanwhile. */
function gpuEngineModule(key) {
  if (gpuMod) return gpuMod;
  if (gpuFailed) { lastLiveReason.set(key, 'the live engine failed to load'); return null; }
  lastLiveReason.set(key, 'starting the live engine');
  // Repaint once it lands, the same way a finished bake does.
  loadGpuEngine().then((m) => { if (m) { try { onBaked?.(key); } catch { /* listener gone */ } } });
  return null;
}
function dropLive(key, reason) {
  if (reason) lastLiveReason.set(key, reason);
  const L = lives.get(key);
  if (!L) return;
  try { L.engine?.dispose(); } catch { /* already gone */ }
  lives.delete(key);
}

/**
 * The live engine for `key`, advanced toward `opts.time`, or null when the
 * layer should draw from the bake instead (Preview: Baked, no WebGPU, a
 * bake-only feature, or the governor tripped since the last solver edit).
 *
 * The returned object is drawable immediately (it is its own pool); the frame
 * after an advance lands is repainted through the bake listener when paused.
 */
export function ensureParticleLive(key, system, duration, spawnTable, opts = {}) {
  const pref = system.solver?.engine || 'auto';
  if (pref === 'baked') { dropLive(key, 'Preview is set to Baked'); return null; }
  if (typeof navigator === 'undefined' || !navigator.gpu) { lastLiveReason.set(key, 'WebGPU is not available here'); return null; }
  const gpu = gpuEngineModule(key);
  if (!gpu) return null;
  const cap = gpu.liveCapability(system, spawnTable);
  if (!cap.ok) { dropLive(key, cap.reason); return null; }
  const collider = opts.collider || null;
  // A followed collider's per-step poses. Part of the simulation's identity, so
  // it rides in on the collider key the way a Layer Velocity track does.
  const colliderTrack = opts.colliderTrack || null;
  const emitterGate = opts.emitterGate || null;
  // Every collider's field and pose track, positional. The singular pair is kept
  // for the fluid mask and the live engine, which take one collider each.
  const colliderTables = opts.colliderTables || null;
  const colliderTracks = opts.colliderTracks || null;
  const layerDrive = opts.layerDrive || null;
  const proximity = opts.proximity || null;
  const hash = particleSimHash(system, duration, spawnTable?.key || '', `${(colliderTables || [collider]).map((t) => t?.key || '').join(',')}`
    + `${(colliderTracks || [colliderTrack]).map((t) => t?.key || '').join(',')}`
    + `${emitterGate ? '|' + emitterGate.key : ''}`, layerDrive?.key || '', proximity?.track?.key || '');
  let L = lives.get(key);
  if (L && L.unavailable) return null;
  // AUTO: the bake is the smoother thing to scrub (any time is one read), so
  // once it is complete for these settings the layer reads it, and live only
  // covers the gap between an edit and its bake landing. Not mid-playback,
  // though — the two simulations agree in shape, not particle for particle,
  // and a swap while the clip plays would pop.
  if (pref === 'auto') {
    const done = caches.get(key);
    const complete = !!(done && done.hash === hash && !done.cache.partial);
    if (complete && !(L && L.engine && L.drawing && opts.playing)) {
      if (L) L.drawing = false;
      return null;
    }
  }
  // Governor hysteresis: once a configuration proved too slow it stays baked
  // until the solver is edited (a new hash) or Preview is forced to Live.
  if (L && L.fell && L.fellHash === hash && pref !== 'live') return null;
  const make = () => {
    const engine = gpu.createParticleGpuEngine({ system, duration, spawnTable, colliderTable: collider, layerDrive });
    engine.ready.then((ok) => {
      const cur = lives.get(key);
      if (!cur || cur.engine !== engine) return;
      if (!ok) { cur.unavailable = true; cur.reason = engine.error ? 'WebGPU error: ' + engine.error : 'WebGPU is not available here'; lastLiveReason.set(key, cur.reason); }
      try { onBaked?.(key); } catch { /* listener gone */ }
    });
    return engine;
  };
  if (!L || !L.engine) {
    // First frame, or the governor sent this layer to the bake and the solver
    // has since been edited (or Preview forced to Live): start a fresh engine.
    L = { engine: make(), hash, fell: false, fellHash: '', reason: '', unavailable: false };
    lives.set(key, L);
  } else if (L.hash !== hash) {
    const kept = L.engine.ok && L.engine.update({ system, duration, spawnTable, colliderTable: collider, layerDrive });
    if (!kept) { try { L.engine.dispose(); } catch { /* gone */ } L.engine = make(); }
    L.hash = hash;
    L.fell = false;
    L.engine.stats.tooSlow = false;
    L.engine.stats.slowRun = 0;
  }
  const eng = L.engine;
  L.drawing = true;
  if (!eng.ok) return eng;   // still initialising: draws nothing for a frame or two
  if (!eng.busy) {
    const playing = !!opts.playing;
    eng.advanceTo(opts.time || 0, playing ? 3 : 8).then((changed) => {
      const cur = lives.get(key);
      if (!cur || cur.engine !== eng) return;
      if (eng.stats.tooSlow && pref !== 'live') {
        // The step cannot hold a frame: hand this layer to the bake until the
        // next edit. Measured by the engine on its own steps — no polling.
        // The entry STAYS, engine-less, carrying the hash that proved too slow:
        // that is what keeps the layer on the bake until the next edit.
        cur.fell = true;
        cur.fellHash = hash;
        cur.reason = 'the live simulation could not hold 60 fps (' + eng.stats.stepMs.toFixed(1) + ' ms per step)';
        lastLiveReason.set(key, cur.reason);
        try { eng.dispose(); } catch { /* gone */ }
        cur.engine = null;
        try { onBaked?.(key); } catch { /* listener gone */ }
        return;
      }
      if (changed && !playing) { try { onBaked?.(key); } catch { /* listener gone */ } }
    });
  }
  return eng;
}

/**
 * What the preview is doing for this layer, for the panel's status line:
 *   { mode: 'live' | 'starting' | 'cache' | 'baked', stepMs, alive, reason, bake }
 * 'cache' = the bake is complete and drawn, the live engine stands by for the
 * next edit; 'baked' = live is not possible (reason says why). `bake` is the
 * background bake's progress, 0..1, or null when none is in flight.
 */
export function particleLiveStatus(key) {
  const L = lives.get(key);
  const bake = pending.has(key) ? particleBakeProgress(key) : null;
  if (L && !L.unavailable && L.engine) {
    const e = L.engine;
    if (!L.drawing) return { mode: 'cache', stepMs: 0, alive: 0, reason: '', bake };
    if (!e.ok) return { mode: 'starting', stepMs: 0, alive: 0, reason: '', bake };
    return { mode: 'live', stepMs: e.stats.stepMs, alive: e.alive(), reason: '', bake };
  }
  return { mode: 'baked', stepMs: 0, alive: 0, reason: lastLiveReason.get(key) || '', bake };
}

function gcLives(liveKeys) {
  for (const key of [...lives.keys()]) if (!liveKeys.has(key)) dropLive(key, '');
}

/*
 * THE DEBUG HOOK, AND WHY EVERY PARTICLE PROBE HAS TO COME THROUGH IT.
 *
 * `__particleLive.setSlowThreshold(1)` from the console forces the governor to
 * trip on the next frames, to see the fallback without a slow GPU.
 *
 * It also carries the Tier 2 accessors, and that is not for convenience. In dev,
 * vite serves an HMR-touched module under a timestamped URL and PROPAGATES that
 * timestamp to what it imports — so a test that does
 * `import('/src/sim/particles/client.js')` from the page gets a SECOND
 * evaluation of this file with its own empty `caches`, and a second gpu/manager
 * with its own empty `runtimes`. Which of the two the app is using flips
 * depending on which file was edited last, so a probe written that way passes
 * and fails for reasons that have nothing to do with the editor.
 *
 * This object is installed by whichever instance the APP loaded, and reading it
 * is the only way to ask the running editor what it actually believes.
 */
if (typeof window !== 'undefined') {
  window.__particleLive = {
    setSlowThreshold: (ms) => loadGpuEngine().then((m) => m?.setLiveSlowThreshold(ms)),
    status: particleLiveStatus,
    bake: bakeParticles,
    makeSystem: (...a) => import('./presets.js').then((m) => m.makeParticleSystem(...a)),
    // Tier 2, from the app's own instance — see the note above.
    gpu: () => debugParticleGpu(),
    gpuBudget: () => particleGpuBudget(),
    gpuOwns: (key) => particleGpuOwns(key),
    gpuReason: (key) => particleGpuReason(key),
    dropGpu: (liveKeys) => gcParticleGpu(liveKeys),
    debug: () => ({
      jobSeq, workerAlive: !!worker, workerDead,
      pending: [...pending.entries()].map(([k, j]) => ({ key: k, id: j.id, hash: j.hash.slice(0, 80) })),
      partials: [...partials.entries()].map(([k, p]) => ({ key: k, id: p.id, baked: p.cache.baked, snapCount: p.cache.snapCount })),
      // maxP is the POOL THE BAKE ACTUALLY BUILT, which is not `maxParticles`:
      // solver.js sizes it to what the emitter can reach (see reachableParticles).
      // It is the number that decides the snapshot cache's size, so it is the one
      // worth being able to read from outside.
      caches: [...caches.entries()].map(([k, c]) => ({ key: k, hash: c.hash.slice(0, 80), maxP: c.cache.maxP, snapCount: c.cache.snapCount, partial: !!c.cache.partial, bakeMs: c.cache.bakeMs })),
      lives: [...lives.entries()].map(([k, l]) => ({ key: k, drawing: l.drawing, fell: l.fell, hasEngine: !!l.engine, t: l.engine?.t })),
    }),
  };
}


/*
 * ── TIER 2 ────────────────────────────────────────────────────────────────────
 *
 * Thin pass-throughs to gpu/manager.js, so the Player talks to ONE module for
 * particles however a given system happens to run.
 *
 * Loaded on demand for the same reason gpuEngine.js is: a static import would
 * put the whole GPU engine into the editor's bundle for every project,
 * including the ones with no Solver Box.
 */
let gpuTierMod = null;
let gpuTierLoad = null;
let gpuTierFailed = false;
/** The module once loaded, or null while it is still coming. */
function gpuTierNow() {
  if (gpuTierMod || gpuTierFailed) return gpuTierMod;
  loadGpuTier();
  return null;
}

/** The load itself, awaitable. */
function loadGpuTier() {
  if (gpuTierMod) return Promise.resolve(gpuTierMod);
  if (gpuTierFailed) return Promise.resolve(null);
  if (!gpuTierLoad) {
    gpuTierLoad = import('./gpu/manager.js')
      .then((m) => {
        gpuTierMod = m;
        // A runtime landing is the same event as a bake landing, from the
        // layer's point of view: the pixels it should be drawing have just
        // become available and nothing has asked for a frame since.
        m.setGpuReadyListener?.((key) => { try { onBaked?.(key); } catch { /* listener gone */ } });
        return m;
      })
      .catch(() => { gpuTierFailed = true; return null; });
  }
  return gpuTierLoad;
}

let webgpuOk = false;
let webgpuProbed = false;
/** Resolve once whether Tier 2 can run here. Cheap after the first call. */
export function probeParticleGpu() {
  if (webgpuProbed) return Promise.resolve(webgpuOk);
  // AWAIT THE CHUNK, do not answer "no" because it has not arrived yet. The
  // first version returned false the moment the import was still in flight and
  // never marked itself probed — so a caller that awaited this once, which is
  // exactly how a panel uses it, was told this machine has no WebGPU forever.
  return loadGpuTier().then((m) => {
    if (!m) { webgpuProbed = true; webgpuOk = false; return false; }
    return m.probeWebGpu().then((ok) => { webgpuOk = ok; webgpuProbed = true; return ok; });
  });
}

/**
 * The GPU runtime for this layer, stepped to `opts.time`, or null.
 *
 * Null on every failure and on every frame before the runtime is ready, so the
 * layer simply draws from the bake until it is. `particleGpuReason(key)` says
 * why when it stays null.
 */
export function ensureParticleGpu(key, system, duration, opts = {}) {
  const m = gpuTierNow();
  if (!m) return null;
  if (!webgpuProbed) { probeParticleGpu(); return null; }
  return m.ensureParticleGpu(key, system, duration, { ...opts, webgpu: webgpuOk });
}

/**
 * Whether the Tier 2 runtime owns this layer, so the bake can be skipped.
 *
 * FALSE until the module and the probe have landed, and false again the moment
 * a runtime fails — a system that cannot get its pool must still have a bake to
 * fall back to, and answering "yes" optimistically is how a refused reservation
 * turns into a layer that draws nothing for the rest of the session.
 */
export function particleGpuOwns(key, system = null) {
  if (gpuTierMod && webgpuProbed) return gpuTierMod.gpuOwnsLayer(key);
  /*
   * THE ANSWER HAS NOT ARRIVED YET, AND THE COLD START IS THE WHOLE PROBLEM.
   *
   * Returning false here — "no runtime exists, so bake" — is technically true
   * and practically wrong. The engine chunk and the adapter probe take a few
   * hundred milliseconds, and the layer is rendered on every one of the frames
   * in between. One of those frames starts a bake, the bake completes, and it
   * then sits in the cache for the rest of the session: a Tier 2 layer with a
   * hundred-thousand-particle snapshot cache underneath it, which is precisely
   * what this was supposed to stop. It looked fixed because the probe that
   * checked it was reading a different module instance (see the note on
   * __particleLive) and never saw the cache at all.
   *
   * So during the gap the question is answered from the SYSTEM instead of from
   * the runtime: would this system go to Tier 2 on a machine that has WebGPU?
   * If yes, no bake is started — and if the probe comes back saying this machine
   * has none, the very next frame falls through to the bake as usual. The cost
   * of being wrong is a few hundred milliseconds; the cost of being right is a
   * bake that never happens.
   */
  return !!system && chooseTier(system, {
    webgpu: true, maxCpu: PARTICLE_MAX_CPU, bakeMax: PARTICLE_MAX_PARTICLES,
    smoothGpu: PARTICLE_SMOOTH_GPU, maxGpu: PARTICLE_MAX_GPU,
  }).tier === TIER.GPU;
}

/** Export waits on this: every runtime created so far has answered. */
export function particleGpuSettled() {
  return gpuTierMod ? gpuTierMod.gpuRuntimesSettled() : Promise.resolve([]);
}

/** True while any runtime is still starting — see gpuRuntimesPending. */
export function particleGpuPending() {
  return !!(gpuTierMod && gpuTierMod.gpuRuntimesPending());
}

/**
 * Has this session settled whether Tier 2 can run here?
 *
 * FALSE MEANS NO RUNTIME CAN EXIST YET — ensureParticleGpu returns null before
 * the engine chunk and the adapter probe have landed, without creating
 * anything. So "is a runtime still starting?" is false at that point for the
 * uninteresting reason, and an export that trusts it captures a blank frame.
 * Resolves once per session.
 */
export function particleGpuProbed() { return webgpuProbed; }

export function particleGpuReason(key) { return gpuTierMod ? gpuTierMod.gpuTierReason(key) : ''; }
export function gcParticleGpu(liveKeys) { if (gpuTierMod) gpuTierMod.gcParticleGpu(liveKeys); }
export function disposeAllParticleGpu() { if (gpuTierMod) gpuTierMod.disposeAllParticleGpu(); }
/** Export awaits this before compositing; the preview does not. */
export function pumpParticleGpu() { return gpuTierMod ? gpuTierMod.pumpParticleGpu() : Promise.resolve(0); }
/** TESTS ONLY — see manager.debugRuntimes. */
export function debugParticleGpu() { return gpuTierMod ? gpuTierMod.debugRuntimes() : []; }
/** The shared particle VRAM ledger — what every Tier 2 layer holds between them. */
export function particleGpuBudget() {
  return gpuTierMod ? gpuTierMod.particleGpuBudget() : { budgetMb: 0, usedMb: 0, freeMb: 0, layers: 0 };
}
