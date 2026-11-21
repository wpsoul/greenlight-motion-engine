/*
 * The frame guard: no render hands back a silently broken picture (render-still, every frame of a render or a test render, the Motion
 * Engine's stills and renders, a render farm pod's Final frames: engine/exporter.js). No imports: unit-tested in node
 * (frameGuard.test.mjs); end to end by tests/badframes.
 *
 * Each frame, before it leaves, is judged on what the render already knows:
 *   - its draw threw (an error that does not stop the render by itself),
 *   - a GPU device or context was lost or rebuilt while it was drawn (the compositor's, or the 3D Scene's own device),
 *   - a Final 3D Scene's kept picture is not its finished trace (the least-sampled pixel short of the samples, the trace started over by
 *     the repaint, the denoiser not done),
 *   - the 3D Scene's picture, as the compositor read it, is empty (every sampled pixel one value: a blank canvas read) while the world
 *     drew objects in its camera's view on that frame. A Scene that shows nothing there, a black set, a fade of the layer, an empty time
 *     range: all legal, because the check is on the world's own picture against the world's own draw, not on the finished frame.
 * A frame that fails is drawn again (RETRIES times at most); one that still fails stops the render with a sentence an agent can act on
 * (a `[CODE]` first). A render that needed retries still succeeds, and its report says how many and why (`log.summary()`).
 *
 * Free on a good frame: the checks read state the render keeps anyway (a counter, a flag, the trace's last count) and the Scene's picture
 * is sampled by a tiny copy on the GPU (worldPlateSample: a 16 x 16 point grid of the plate, 1 KB read back) only where a Scene is drawn.
 */

export const FRAME_GUARD_RETRIES = 2;

/** The reasons a frame is drawn again, in the report's order. */
export const GUARD_REASONS = Object.freeze(['empty', 'device', 'samples', 'error']);

const CODES = { empty: 'FRAME_EMPTY', device: 'GPU_DEVICE_LOST', samples: 'TRACE_INCOMPLETE', error: 'RENDER_FAILED' };

/**
 * The spread of an RGBA sample (Uint8 bytes, 4 per pixel): its darkest and brightest value per channel. `pixels` = how many were read.
 */
export function pixelSpread(rgba) {
  const lo = [255, 255, 255, 255], hi = [0, 0, 0, 0];
  const n = Math.floor((rgba?.length || 0) / 4);
  for (let i = 0; i < n * 4; i += 4) {
    for (let c = 0; c < 4; c += 1) {
      const v = rgba[i + c];
      if (v < lo[c]) lo[c] = v;
      if (v > hi[c]) hi[c] = v;
    }
  }
  return { pixels: n, lo, hi };
}

/** The kind of an RGBA picture read whole anyway (a farm frame's canvas, a frames-mode PNG's pixels), stopping at the first pixel that
 *  differs from the first one: a picture costs a few pixels' look, an empty one a pass over it. `pixels` limits the look to the first
 *  `pixels` pixels (a band of the picture). Same kinds as emptyKind. */
export function readEmptyKind(rgba, { pixels = null, tolerance = 1 } = {}) {
  const n = Math.min(pixels ?? Infinity, Math.floor((rgba?.length || 0) / 4));
  if (!n) return null;
  const r = rgba[0], g = rgba[1], b = rgba[2], a = rgba[3];
  for (let i = 4; i < n * 4; i += 4) {
    if (Math.abs(rgba[i] - r) > tolerance || Math.abs(rgba[i + 1] - g) > tolerance || Math.abs(rgba[i + 2] - b) > tolerance
      || Math.abs(rgba[i + 3] - a) > tolerance) return null;
  }
  return emptyKind({ pixels: 1, lo: [r, g, b, a], hi: [r, g, b, a] }, { tolerance });
}

/** What a sample says: null when it shows something (its pixels differ), else 'transparent', 'black' or 'flat' (one colour). */
export function emptyKind(spread, { tolerance = 1 } = {}) {
  if (!spread || !spread.pixels) return null;
  const { lo, hi } = spread;
  for (let c = 0; c < 4; c += 1) if (hi[c] - lo[c] > tolerance) return null;
  if (hi[3] <= tolerance) return 'transparent';
  if (hi[0] <= tolerance && hi[1] <= tolerance && hi[2] <= tolerance) return 'black';
  return 'flat';
}

const where = (frame, time) => `${frame != null ? `frame ${frame}` : 'the frame'}${Number.isFinite(time) ? ` (${Number(time).toFixed(3)} s)` : ''}`;

/**
 * What went wrong with one attempt at a frame, or null when it may leave. `facts`:
 *   error      a message: the frame's draw threw
 *   gpuReset   a message: a GPU device or context was lost or rebuilt while the frame was drawn
 *   final      { finished, minSpp, spp, why? } a Final Scene's kept picture: finished = it is the trace's finished picture
 *   plate      { kind: emptyKind of the Scene's picture as read, objects: the objects the world drew in its camera's view }
 * Returns { reason, detail } (reason one of GUARD_REASONS).
 */
export function frameFault(facts = {}) {
  // (simgaps) a lost device first: a draw that threw while its device was being lost ("mapAsync: Device was lost") is the loss, and only
  // a 'device' retry gives the Scene a new device (exporter: releaseLostWorld). As an 'error' its retry traced on the dead device until
  // the frame's time limit (TRACE_STALLED after 10-11 min on the bubble shot)
  if (facts.gpuReset) return { reason: 'device', detail: String(facts.gpuReset) };
  if (facts.error) return { reason: 'error', detail: String(facts.error) };
  const f = facts.final;
  if (f && (!f.finished || (Number.isFinite(f.minSpp) && Number.isFinite(f.spp) && f.minSpp < f.spp))) {
    const counts = Number.isFinite(f.minSpp) && Number.isFinite(f.spp) ? `${f.minSpp} of ${f.spp} samples in its least-sampled pixel` : 'its trace not finished';
    return { reason: 'samples', detail: f.why ? `${counts} (${f.why})` : counts };
  }
  const p = facts.plate;
  if (p && p.kind && p.objects > 0) return { reason: 'empty', detail: `the 3D Scene's picture came out ${p.kind} while the world drew ${p.objects} object${p.objects === 1 ? '' : 's'} in view` };
  return null;
}

/**
 * The verdict on attempt `attempt` (0 = the first draw) of a frame: { ok: true }, { retry: reason, detail }, or, past `retries`,
 * { fail: true, reason, code, message } with the sentence that stops the render.
 */
export function frameVerdict(facts, attempt = 0, { retries = FRAME_GUARD_RETRIES, frame = null, time = null } = {}) {
  const fault = frameFault(facts);
  if (!fault) return { ok: true };
  if (attempt < retries) return { retry: fault.reason, detail: fault.detail };
  const at = where(frame, time);
  const tries = attempt + 1;
  const code = CODES[fault.reason];
  const tail = {
    empty: 'The picture was not handed over. Render again; if it repeats at this frame, render that part as its own range (rangeStart / rangeEnd), and check the frame with a still (render-still at this time).',
    device: 'Close other apps that use the GPU (or wait for a render that runs), lower the output size or the Scene\'s samples, and render again.',
    samples: 'Lower the Scene\'s samples (rig.render.spp) or the video size, render this part in Draft, or render again with the GPU free.',
    error: 'Fix what the message names, or render that part as its own range to find the layer.',
  }[fault.reason];
  return { fail: true, reason: fault.reason, code,
    message: `[${code}] ${at[0].toUpperCase()}${at.slice(1)} failed ${tries} time${tries === 1 ? '' : 's'}: ${fault.detail}. ${tail}` };
}

/**
 * Fault injection for the guard's tests (tests/badframes). `globalThis.__glFrameFaults = { blankWorld: 1, ... }` makes the next N frames
 * (stills or a render's frames; each attempt at a frame takes one) fail on purpose, in every draw of that attempt:
 *   blankWorld       the Scene's frame never reaches its canvas (a dropped submit: the compositor reads a blank canvas)
 *   blankPlate       the compositor's copy of the Scene's picture blanked (a blank target)
 *   loseWorldDevice  the Scene's GPU device destroyed (lost)
 *   finalUnfinished  a Final frame's kept repaint does not show its finished trace (as when a repaint restarted it)
 *   gpuReset         a GPU context of the page counted as lost during the frame
 *   guardOff         the frame is not checked (a broken frame reaches the file: the video check's test)
 *   after            that many attempts go by first (a fault in the middle of a render)
 * Unset (always, outside the tests) arming costs one property read a frame. `fired` on the object lists what fired.
 */
const FAULT_NAMES = ['blankWorld', 'blankPlate', 'loseWorldDevice', 'finalUnfinished', 'gpuReset', 'guardOff'];
let armed = null;
/** At the start of an attempt at a frame: the faults asked for take this attempt. */
export function armFrameFaults() {
  armed = null;
  const f = globalThis.__glFrameFaults;
  if (!f) return;
  // `after`: that many attempts go by untouched first (a fault in the middle of a render)
  if (f.after > 0) { f.after -= 1; return; }
  for (const name of FAULT_NAMES) {
    if (!(f[name] > 0)) continue;
    f[name] -= 1;
    (armed ||= new Set()).add(name);
    (f.fired ||= []).push(name);
  }
}
/** Whether `name` is armed for the attempt under way. */
export const frameFaultOn = (name) => !!armed && armed.has(name);
/** The attempt is over. */
export function disarmFrameFaults() { armed = null; }

/** The error a failed frame stops the render with: the exporter rethrows it at once (never encodes the frame) and the backend reads its
 *  `[CODE]`. */
export function frameGuardError(verdict) {
  const error = new Error(verdict.message);
  error.code = verdict.code;
  error.frameGuard = true;
  error.finalStall = true;      // the exporter's stop-the-render flag (exporter.js worldFatal)
  return error;
}

/** A render's (or a still's) record of the frames drawn again: counts per reason, the first events, and the report's lines. */
export function createFrameGuardLog({ keep = 20 } = {}) {
  const byReason = {};
  const events = [];
  let retried = 0;
  const frames = new Set();
  return {
    note(reason, { frame = null, time = null, detail = '' } = {}) {
      byReason[reason] = (byReason[reason] || 0) + 1;
      retried += 1;
      frames.add(frame ?? time ?? retried);
      if (events.length < keep) events.push({ frame, time: Number.isFinite(time) ? Math.round(time * 1000) / 1000 : null, reason, detail: String(detail).slice(0, 300) });
    },
    get retried() { return retried; },
    /** null when nothing was drawn again, else { retries, frames, byReason, events } (the job's stats.frameGuard, a still's scene.frameGuard). */
    summary() {
      if (!retried) return null;
      return { retries: retried, frames: frames.size, byReason: { ...byReason }, events: events.slice() };
    },
    /** One line a reason, for `scene.warnings` / the job's warnings: what was drawn again and why; the picture handed out is whole. */
    warnings() {
      return GUARD_REASONS.filter((r) => byReason[r]).map((r) => {
        const n = byReason[r];
        const what = {
          empty: "the 3D Scene's picture came out empty",
          device: 'a GPU device was lost or rebuilt',
          samples: 'the Final trace was not finished',
          error: 'its draw failed',
        }[r];
        return `frame guard: ${n} draw${n === 1 ? '' : 's'} redone because ${what} (the frame handed out is whole)`;
      });
    },
  };
}
