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
export const GUARD_REASONS = Object.freeze(['device', 'timeout', 'error', 'samples', 'corrupt', 'empty']);

const CODES = {
  device: 'GPU_DEVICE_LOST',
  timeout: 'FRAME_TIMEOUT',
  error: 'RENDER_FAILED',
  samples: 'TRACE_INCOMPLETE',
  corrupt: 'FRAME_CORRUPT',
  empty: 'FRAME_EMPTY',
};

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

const STRIPE_MAX_SAMPLES = 96;

function scanStripeAxis(rgba, width, height, horizontal) {
  const major = horizontal ? height : width;
  const minor = horizontal ? width : height;
  const M = Math.min(minor, STRIPE_MAX_SAMPLES);
  const pos = new Int32Array(M);
  for (let k = 0; k < M; k += 1) pos[k] = Math.min(minor - 1, Math.floor(((k + 0.5) * minor) / M));
  const idx = (s, p) => (horizontal ? (s * width + p) * 4 : (p * width + s) * 4);

  const U = new Float32Array(major * M);
  const V = new Float32Array(major * M);
  const C = new Float32Array(major * M);
  const A = new Uint8Array(major * M);
  const sliceAlong = new Float32Array(major);

  for (let s = 0; s < major; s += 1) {
    const base = s * M;
    let alongSum = 0;
    let alongN = 0;
    for (let k = 0; k < M; k += 1) {
      const p = pos[k];
      const i = idx(s, p);
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], a = rgba[i + 3];
      const u = r - g;
      const v = b - 0.5 * (r + g);
      U[base + k] = u;
      V[base + k] = v;
      C[base + k] = Math.max(r, g, b) - Math.min(r, g, b);
      A[base + k] = a;
      if (a >= 16) {
        if (p + 1 < minor) {
          const ni = idx(s, p + 1);
          if (rgba[ni + 3] >= 16) {
            const nu = rgba[ni] - rgba[ni + 1];
            const nv = rgba[ni + 2] - 0.5 * (rgba[ni] + rgba[ni + 1]);
            alongSum += Math.hypot(u - nu, v - nv);
            alongN += 1;
          }
        }
        if (k > 0 && A[base + k - 1] >= 16) {
          alongSum += Math.hypot(u - U[base + k - 1], v - V[base + k - 1]);
          alongN += 1;
        }
      }
    }
    sliceAlong[s] = alongN ? alongSum / alongN : 0;
  }

  const sliceCross = new Float32Array(Math.max(1, major - 1));
  const transitions = [];
  for (let s = 0; s < major - 1; s += 1) {
    const b0 = s * M;
    const b1 = (s + 1) * M;
    let valid = 0, jumpCount = 0, coherentJumpCount = 0;
    let crossSum = 0, duSum = 0, dvSum = 0, jumpEnergySum = 0;
    for (let k = 0; k < M; k += 1) {
      if (A[b0 + k] < 16 && A[b1 + k] < 16) continue;
      valid += 1;
      const du = U[b1 + k] - U[b0 + k];
      const dv = V[b1 + k] - V[b0 + k];
      const cJump = Math.hypot(du, dv);
      const maxC = Math.max(C[b0 + k], C[b1 + k]);
      crossSum += cJump;
      if (cJump >= 75 && maxC >= 55) {
        jumpCount += 1;
        duSum += du;
        dvSum += dv;
        jumpEnergySum += cJump;
        const prev0 = k > 0 ? Math.hypot(U[b0 + k] - U[b0 + k - 1], V[b0 + k] - V[b0 + k - 1]) : 0;
        const next0 = k + 1 < M ? Math.hypot(U[b0 + k] - U[b0 + k + 1], V[b0 + k] - V[b0 + k + 1]) : 0;
        const prev1 = k > 0 ? Math.hypot(U[b1 + k] - U[b1 + k - 1], V[b1 + k] - V[b1 + k - 1]) : 0;
        const next1 = k + 1 < M ? Math.hypot(U[b1 + k] - U[b1 + k + 1], V[b1 + k] - V[b1 + k + 1]) : 0;
        if (Math.min(Math.max(prev0, next0), Math.max(prev1, next1)) <= cJump * 0.4) coherentJumpCount += 1;
      }
    }
    sliceCross[s] = valid ? crossSum / valid : 0;
    if (!valid || !jumpCount) continue;
    const cohFrac = coherentJumpCount / valid;
    const avgJump = jumpEnergySum / jumpCount;
    // Directional net-jump gate rejects checkerboards whose opposite-phase cells cancel out across a boundary.
    const netFrac = Math.hypot(duSum, dvSum) / jumpEnergySum;
    const minSideAlong = Math.min(sliceAlong[s], sliceAlong[s + 1]);
    if (cohFrac >= 0.35 && avgJump >= 85 && netFrac >= 0.5 && minSideAlong <= avgJump * 0.35) {
      transitions.push({ s, cohFrac, avgJump, du: duSum / jumpCount, dv: dvSum / jumpCount, minSideAlong });
    }
  }

  const anisoTrans = [];
  for (const t of transitions) {
    const lo = Math.max(0, t.s - 2);
    const hi = Math.min(major - 1, t.s + 3);
    let wCross = 0, wAlong = 0;
    for (let q = lo; q <= hi; q += 1) {
      if (q < major - 1) wCross += sliceCross[q];
      wAlong += sliceAlong[q];
    }
    const stripeClean = t.minSideAlong <= t.avgJump * 0.15 && t.avgJump * t.cohFrac >= 75;
    if (wCross / Math.max(1, wAlong) >= 2.2 || stripeClean) anisoTrans.push(t);
  }

  let reversals = 0, activeCross = 0, activeAlong = 0;
  for (let i = 0; i < anisoTrans.length; i += 1) {
    const t = anisoTrans[i];
    activeCross += t.avgJump * t.cohFrac;
    activeAlong += t.minSideAlong;
    if (i > 0) {
      const p = anisoTrans[i - 1];
      if (p.du * t.du + p.dv * t.dv < 0 || p.du * t.du < -1600 || p.dv * t.dv < -1600) reversals += 1;
    }
  }

  const transRatio = anisoTrans.length / Math.max(1, major - 1);
  const revRatio = reversals / Math.max(1, major - 2);
  const localAniso = activeCross / Math.max(1, activeAlong);
  const score = anisoTrans.length ? (activeCross / anisoTrans.length) / 255 : 0;
  const hit = anisoTrans.length >= 5
    && reversals >= 4
    && (transRatio >= 0.15 || (anisoTrans.length >= 8 && revRatio >= 0.10) || (major >= 64 && reversals >= 12))
    && localAniso >= 2.5
    && score >= 0.25;
  if (!hit) return null;
  return {
    axis: horizontal ? 'horizontal' : 'vertical',
    ratio: Math.min(1, Math.round(transRatio * 1000) / 1000),
    score: Math.round(score * 1000) / 1000,
  };
}

export function sameStripePicture(a, b, { maxMeanDiff = 6 } = {}) {
  if (!a || !b || !a.length || a.length !== b.length) return false;
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 3 < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    count += 3;
  }
  return count > 0 && (sum / count) <= maxMeanDiff;
}

/**
 * Detect colored horizontal or vertical GPU-load stripe corruption in an RGBA buffer, returning `{ axis, ratio, score }` or `null`.
 */
export function detectStripeCorruption(rgba, width, height) {
  const w = Math.trunc(Number(width) || 0);
  const h = Math.trunc(Number(height) || 0);
  if (!rgba || w < 4 || h < 4 || rgba.length < w * h * 4) return null;
  const hor = scanStripeAxis(rgba, w, h, true);
  const ver = scanStripeAxis(rgba, w, h, false);
  if (hor && (!ver || hor.ratio * hor.score >= ver.ratio * ver.score)) return hor;
  return ver || null;
}

const where = (frame, time) => `${frame != null ? `frame ${frame}` : 'the frame'}${Number.isFinite(time) ? ` (${Number(time).toFixed(3)} s)` : ''}`;

/**
 * What went wrong with one attempt at a frame, or null when it may leave. `facts`:
 *   error      a message: the frame's draw threw
 *   gpuReset   a message: a GPU device or context was lost or rebuilt while the frame was drawn
 *   timedOut   truthy / ms / message: the frame timed out before finishing its draw
 *   final      { finished, minSpp, spp, why? } a Final Scene's kept picture: finished = it is the trace's finished picture
 *   plate      { kind: emptyKind of the Scene's picture as read, objects: the objects the world drew in its camera's view, corrupt? }
 * Returns { reason, detail } (reason one of GUARD_REASONS).
 */
export function frameFault(facts = {}) {
  // (simgaps) a lost device first: a draw that threw while its device was being lost ("mapAsync: Device was lost") is the loss, and only
  // a 'device' retry gives the Scene a new device (exporter: releaseLostWorld). As an 'error' its retry traced on the dead device until
  // the frame's time limit (TRACE_STALLED after 10-11 min on the bubble shot)
  if (facts.gpuReset) return { reason: 'device', detail: String(facts.gpuReset) };
  if (facts.timedOut) {
    const ms = Number(facts.timedOut);
    const detail = Number.isFinite(ms) && ms >= 1000
      ? `the frame timed out after ${Math.round(ms / 1000)} s while drawing`
      : typeof facts.timedOut === 'string'
        ? facts.timedOut
        : 'the frame did not finish drawing before the timeout';
    return { reason: 'timeout', detail };
  }
  if (facts.error) return { reason: 'error', detail: String(facts.error) };
  const f = facts.final;
  if (f && (!f.finished || (Number.isFinite(f.minSpp) && Number.isFinite(f.spp) && f.minSpp < f.spp))) {
    const counts = Number.isFinite(f.minSpp) && Number.isFinite(f.spp) ? `${f.minSpp} of ${f.spp} samples in its least-sampled pixel` : 'its trace not finished';
    return { reason: 'samples', detail: f.why ? `${counts} (${f.why})` : counts };
  }
  const p = facts.plate;
  if (p && p.corrupt && !p.corrupt.deterministic) return { reason: 'corrupt', detail: "the 3D Scene's picture had GPU stripe corruption" };
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
    corrupt: 'Close other apps that use the GPU, render again, or render that part as its own range (rangeStart / rangeEnd).',
    timeout: 'Render again; if it repeats at this frame, check the frame with a still (render-still at this time) or re-encode heavy source clips.',
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
 *   stripeCorrupt    the Scene's plate is flagged with colored GPU stripe corruption
 *   frameTimeout     the frame is flagged as timed out before finishing its draw
 *   after            that many attempts go by first (a fault in the middle of a render)
 * Unset (always, outside the tests) arming costs one property read a frame. `fired` on the object lists what fired.
 */
const FAULT_NAMES = ['blankWorld', 'blankPlate', 'loseWorldDevice', 'finalUnfinished', 'gpuReset', 'guardOff', 'stripeCorrupt', 'frameTimeout'];
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
          corrupt: "the 3D Scene's picture had GPU stripe corruption",
          timeout: 'the frame timed out while drawing',
          device: 'a GPU device was lost or rebuilt',
          samples: 'the Final trace was not finished',
          error: 'its draw failed',
        }[r];
        return `frame guard: ${n} draw${n === 1 ? '' : 's'} redone because ${what} (the frame handed out is whole)`;
      });
    },
  };
}
