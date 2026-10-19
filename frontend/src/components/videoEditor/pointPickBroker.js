/*
 * One owner for the preview's "click to place a point" mode.
 *
 * A point control lives in the properties panel; the surface you actually click
 * is the preview stage, several components away. Rather than thread a callback
 * through everything, a control ARMS a request here and the stage serves it.
 * Keeping it in one module is the point: the rig-pin, motion-path and crop
 * overlays all want the same gesture, and two of them armed at once would leave
 * the preview with an ambiguous click target.
 *
 * Coordinates are percent of the composition (0–100, top-left origin) — the
 * same space every point-valued option stores, so the stage never has to know
 * what it is picking for.
 */

let active = null; // { id, label, onPick, onCancel }
let nextId = 1;
const listeners = new Set();

function emit() {
  for (const listener of listeners) listener(active);
}

/** Subscribe to arm/disarm. Returns an unsubscribe. */
export function subscribePointPick(listener) {
  listeners.add(listener);
  listener(active);
  return () => listeners.delete(listener);
}

export function getActivePointPick() {
  return active;
}

/**
 * Arm the preview for one pick. Any request already armed is cancelled first —
 * clicking a second picker moves the crosshair to it rather than stacking.
 * Returns the request id, which is what a caller compares against to know
 * whether the armed request is still its own.
 */
export function requestPointPick({ label = 'point', onPick, onCancel } = {}) {
  const displaced = active;
  const id = nextId++;
  active = { id, label, onPick, onCancel };
  // Notify the displaced owner AFTER the swap, so its handler sees the new
  // request as active and doesn't clear the one that just replaced it.
  displaced?.onCancel?.();
  emit();
  return id;
}

export function cancelPointPick(id) {
  if (!active || (id != null && active.id !== id)) return;
  const request = active;
  active = null;
  emit();
  request.onCancel?.();
}

/** Called by the stage. `x`/`y` are percent of the composition. */
export function deliverPointPick(x, y) {
  if (!active) return false;
  const request = active;
  active = null;
  emit();
  request.onPick?.({ x, y });
  return true;
}
