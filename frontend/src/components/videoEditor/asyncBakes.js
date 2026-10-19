/*
 * Settle registry for render-loop bakes that cannot finish inline.
 *
 * Two effects bake CPU-side data from the layer's own matte — Auto Fill's
 * geodesic arrival field (autofillField.js) and the Rig tool's deform mesh
 * (rigDeform.js) — and both start by reading a render target back. That read is
 * synchronous on a WebGL renderer and CANNOT be on a WebGPU one: there is no
 * `readRenderTargetPixels` there at all, only `readRenderTargetPixelsAsync`
 * (see html/webgpu-migration/PORTING-GUIDE.md §3.4). So the bakes are async, the
 * frame that asks for one paints with the previous result, and whoever needs a
 * frame to be EXACT — an export, a still capture — waits here first.
 *
 * The gate a caller tests is `consumeBakeChange()`, not `bakesPending()`:
 * "is a bake in flight right now" is a race with microtask timing (on WebGL the
 * read resolves during whichever await happens to come next, so the in-flight
 * window can close before the caller looks), while "has a bake landed that no
 * render has painted yet" is sticky and cannot be missed.
 */

const inFlight = new Set();
const listeners = new Set();
let unpaintedChange = false;

/**
 * Register a bake. `promise` resolves to whether the bake CHANGED anything —
 * false (e.g. the silhouette hashed the same) means no repaint is owed. A
 * rejection is logged and counted as no change; a broken bake must not wedge an
 * export waiting for it.
 */
export function trackBake(promise, label = 'bake') {
  let entry;
  entry = Promise.resolve(promise)
    .then(
      (changed) => {
        if (!changed) return;
        unpaintedChange = true;
        for (const cb of listeners) {
          try { cb(); } catch { /* a listener must not break the queue */ }
        }
      },
      (err) => { console.warn(`[${label}] failed: ` + (err?.message || err)); },
    )
    .then(() => { inFlight.delete(entry); });
  inFlight.add(entry);
  return entry;
}

/** True while any bake is outstanding. */
export function bakesPending() {
  return inFlight.size > 0;
}

/** Resolves once every bake outstanding RIGHT NOW has landed. */
export function bakesSettled() {
  return Promise.all(Array.from(inFlight)).then(() => undefined);
}

/**
 * Has a bake changed something since the last time a caller took this? Reading
 * CLEARS it — the caller is saying "I am about to paint with what is there now".
 * A landed bake can reveal the next one (a repaint asks for data the first pass
 * could not have asked for), so callers loop until this returns false.
 */
export function consumeBakeChange() {
  const changed = unpaintedChange;
  unpaintedChange = false;
  return changed;
}

/** Fires when a bake changed something, i.e. when a repaint would show it. */
export function onBakeLanded(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
