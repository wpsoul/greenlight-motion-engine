/*
 * The first-use warm-up. Effects, transitions and text build their GPU programs the first time a frame draws them —
 * on purpose, so an effect a project never uses costs nothing (./effectPasses.js) — and that build (three's node graph
 * → WGSL, then the pipeline) is 30–85 ms inside ONE frame. So the first play of a project hitched where each new
 * effect began, and the second play was smooth (tests/motion-engine/verify_warm_up.mjs measures both).
 *
 * While the preview is paused and nobody is touching it, the engine draws one hidden frame inside each layer it has
 * not drawn yet — in its entrance, its middle and its exit — then the frame on screen again, in the same task, so the
 * canvas never shows a hidden one. Layers that build the same programs (same media type, effects, transitions and
 * modes) are drawn once, and each timeline row once more for its own layer materials. Hidden frames leave the media
 * where they are: they don't seek or re-source a video, step a live html page or park a sound (syncVideo /
 * syncTransitionSounds are no-ops, audio channels and live html are skipped — `engine.warmUp.hidden`, read in
 * ./channelRender.js — and shortAudio is held back).
 *
 * Cost: one flag check per frame while playing or exporting, nothing else. After a load or an edit, a hidden frame
 * per NEW kind of layer or row, in idle moments (a project with ten effects on one row is about thirty frames, once).
 * Playing before it finishes simply builds the rest on first use, as before.
 */
const QUIET_MS = 150;        // no new frame (another time, another project state) in this long: the preview is idle
const STEP_BUDGET_MS = 12;   // hidden frames per task until this much time went (always at least one)
const MAX_PLAN = 600;        // sample times per plan
const EDGE_S = 0.2;          // how far into its entrance / before its end a layer with no transition is sampled
const MAX_TRIES = 4;         // a frame drawn while its pictures were still loading is tried again
const LOAD_WAIT_MS = 1500;   // the longest a retry waits for those pictures
const IDLE_TIMEOUT_MS = 250; // a page that is never idle (an animation running elsewhere) still steps this often
const MODE_KEY = /(type|mode|transition|preset|kind)$/i;
const noop = () => {};

function warmState(engine) {
  if (!engine.warmUp) {
    engine.warmUp = {
      hidden: false, busy: false, timer: null, lastOther: 0, env: null, time: null, render: null,
      renderer: null, quad: null, channels: null, queue: [], done: new Set(),
    };
  }
  return engine.warmUp;
}

// What decides a layer's programs: its media type and shape, the effect chains (in order), its transitions, modes and
// enabled features. Numbers (positions, amounts, times) are uniforms and never part of it.
export function layerKind(item, clip) {
  const parts = [clip?.mediaType || '', clip?.shapeType || ''];
  for (const key of Object.keys(item).sort()) {
    const v = item[key];
    if (v == null || v === false || typeof v === 'number') continue;
    if (Array.isArray(v)) {
      const ids = v.filter((e) => e && typeof e === 'object' && e.enabled !== false)
        .map((e) => e.id ?? e.type ?? e.name ?? '?');
      if (ids.length) parts.push(`${key}:${ids.join(',')}`);
    } else if (typeof v === 'object') {
      if (v.enabled !== false) parts.push(key);
    } else if (v === true) {
      parts.push(key);
    } else if (typeof v === 'string' && MODE_KEY.test(key) && v !== 'none') {
      parts.push(`${key}=${v}`);
    }
  }
  return parts.join('|');
}

// The hidden frames to draw, in timeline order. A frame is needed while one of its keys is new:
//   - a kind of layer and phase (`<kind>#in|mid|out|cross`): the shared effect passes, transitions, text paths;
//   - a timeline row (`row:<id>`, and `row:<id>:prev` for its first cross transition): every row has its own layer
//     materials, and three builds each material instance on its first draw (~50 ms for the layer material), even
//     when another row's identical one is built already.
// Frames closer than half a project frame are drawn as one.
export function planWarmUp(env, done = new Set()) {
  const half = 0.5 / (env.projectFps || 30);
  const seen = new Set(done);
  const jobs = [];
  const add = (t, keys) => {
    const fresh = keys.filter((k) => !seen.has(k));
    if (!fresh.length) return;
    for (const k of fresh) seen.add(k);
    jobs.push({ t, keys: fresh, tries: 0 });
  };
  const has = (type) => type && type !== 'none';
  for (const channel of env.channels || []) {
    if (channel.visible === false) continue;
    const layout = env.layoutMap?.get(channel.id);
    if (!layout) continue;
    const row = `row:${channel.id}`;
    channel.items.forEach((item, i) => {
      const entry = layout[i];
      const clip = env.clipsMap?.get(item.clipId);
      if (!entry || !clip || clip.mediaType === 'audio') return;
      const start = entry.startTime;
      const dur = entry.endTime - start;
      if (!(dur > 0)) return;
      const kind = layerKind(item, clip);
      const inLen = has(item.transitionInType) ? Number(item.transitionInDuration) || 1 : 0;
      const outLen = has(item.transitionOutType) ? Number(item.transitionOutDuration) || 1 : 0;
      // the entrance and the exit draw through other paths than the settled middle (a text animator's words in
      // flight, a transition's passes), so each gets its own frame
      const edge = (len) => Math.max(half, Math.min(dur / 4, len > 0 ? len / 2 : EDGE_S));
      add(start + edge(inLen), [`${kind}#in`, row]);
      add(start + dur / 2, [`${kind}#mid`]);
      add(entry.endTime - edge(outLen), [`${kind}#out`]);
      if (entry.overlapIn > 0) add(start + Math.min(entry.overlapIn, dur) / 2, [`${kind}#cross`, `${row}:prev`]);
    });
  }
  jobs.sort((a, b) => a.t - b.t);
  const merged = [];
  for (const job of jobs) {
    const last = merged[merged.length - 1];
    if (last && job.t - last.t < half) last.keys.push(...job.keys);
    else merged.push(job);
  }
  return merged.slice(0, MAX_PLAN);
}

function cancel(w) {
  if (!w.timer) return;
  if (w.timer.idle != null && typeof cancelIdleCallback === 'function') cancelIdleCallback(w.timer.idle);
  if (w.timer.t != null) clearTimeout(w.timer.t);
  w.timer = null;
}

function arm(engine, w, delay = 0) {
  if (w.timer) return;
  const run = () => { w.timer = null; step(engine, w); };
  if (delay > 0 || typeof requestIdleCallback !== 'function') w.timer = { t: setTimeout(run, Math.max(delay, 16)) };
  else w.timer = { idle: requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS }) };
}

function blocked(engine) {
  return !engine.renderer || !engine.rendererReady || engine.isPlaying || engine.exporting || engine.exportActive
    || engine.worldActive;
}

function step(engine, w) {
  if (!w.queue.length || blocked(engine)) return;   // the next paused frame plans and arms again
  const quiet = performance.now() - w.lastOther;
  if (quiet < QUIET_MS) { arm(engine, w, QUIET_MS - quiet); return; }
  const env = w.env;
  const hiddenEnv = { ...env, isPlaying: false, syncVideo: noop, syncTransitionSounds: noop };
  const t0 = engine.currentTime;
  const scrub = engine.scrubPlate;
  const scrubT = scrub ? scrub.t : null;
  const shortAudio = engine.shortAudio;
  const began = performance.now();
  let retry = false;
  let left = w.queue.length;   // each job at most once per step
  w.busy = true;
  w.hidden = true;
  engine.shortAudio = null;
  try {
    do {
      const job = w.queue.shift();
      left -= 1;
      engine.currentTime = job.t;
      // the hidden frame is not a scrub: no thinned plates, no settle repaint
      if (scrub) scrub.t = job.t;
      try { w.render(engine, hiddenEnv); } catch { /* a frame that fails is not tried again */ }
      // its pictures were still decoding, so the layer may not have drawn: again once they land, the others first
      if (engine.imageTextureLoads?.size && job.tries + 1 < MAX_TRIES) {
        job.tries += 1;
        w.queue.push(job);
        retry = true;
      } else {
        for (const k of job.keys) w.done.add(k);
      }
    } while (left > 0 && performance.now() - began < STEP_BUDGET_MS);
  } finally {
    engine.currentTime = t0;
    if (scrub) scrub.t = scrubT;
    engine.shortAudio = shortAudio;
    w.hidden = false;
  }
  // the frame on screen again, in the same task: the canvas never presents a hidden one
  try { engine.renderFrame?.(); } finally { w.busy = false; }
  if (!w.queue.length) return;
  const loads = retry && engine.imageTextureLoads?.size ? [...engine.imageTextureLoads.values()] : null;
  if (!loads) { arm(engine, w); return; }
  // again once those pictures land (or after LOAD_WAIT_MS), whichever comes first
  const resume = () => {
    if (w.timer?.t !== wait) return;
    clearTimeout(wait);
    w.timer = null;
    arm(engine, w);
  };
  const wait = setTimeout(resume, LOAD_WAIT_MS);
  w.timer = { t: wait };
  Promise.all(loads).then(resume, resume);
}

// Called by every frame (./frameRender.js). Plans when the project changed, and arms the idle steps.
export function scheduleWarmUp(engine, env, render) {
  const w = warmState(engine);
  if (w.busy) return;
  // a repaint of the same frame (a picture or a font landed) is not someone using the preview
  if (env !== w.env || engine.currentTime !== w.time) w.lastOther = performance.now();
  w.time = engine.currentTime;
  w.env = env;
  if (blocked(engine)) return;
  w.render = render;
  // a new renderer or composite pipeline builds every program again
  if (w.renderer !== engine.renderer || w.quad !== engine.fsQuadGeo) {
    w.renderer = engine.renderer;
    w.quad = engine.fsQuadGeo;
    w.done.clear();
    w.channels = null;
  }
  if (w.channels !== env.channels) {
    w.channels = env.channels;
    w.queue = planWarmUp(env, w.done);
  }
  if (w.queue.length) arm(engine, w, QUIET_MS);
}

export function disposeWarmUp(engine) {
  const w = engine.warmUp;
  if (!w) return;
  cancel(w);
  w.queue = [];
  w.env = null;
  w.render = null;
}
