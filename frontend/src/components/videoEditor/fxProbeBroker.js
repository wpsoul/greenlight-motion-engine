/*
 * One owner for "hand me the pixels this effect actually sees".
 *
 * Extract is a histogram key, and a histogram of the wrong pixels is worse than
 * no histogram: reading the finished preview would show the result AFTER the key,
 * so every drag would move the very bars you are aiming at. What the panel needs
 * is the effect's INPUT — the buffer the chain holds just before that entry runs.
 *
 * That buffer only exists for a few microseconds inside Player.runEffectChain, so
 * the panel cannot go and fetch it. It arms a request here instead; the Player
 * serves it on the next frame that reaches the matching entry and resolves with a
 * small RGBA readback. Same shape as pointPickBroker: the component that owns the
 * gesture arms, the component that owns the surface serves.
 *
 * A request that is never reached (effect disabled, clip off-screen, playhead
 * outside the entry) resolves `null` on the timeout rather than hanging.
 */

let provider = null;      // installed by the Player
let pending = null;       // { eid, width, settle }

const PROBE_TIMEOUT_MS = 500;

/** The Player installs its server here. Returns an unsubscribe. */
export function setFxProbeProvider(fn) {
  provider = fn;
  return () => { if (provider === fn) provider = null; };
}

export function isFxProbeAvailable() {
  return !!provider;
}

/**
 * Ask for the input of one effect entry.
 * @param {string} eid  the entry's stable id (item.effects[].eid)
 * @param {{width?: number}} [opts] readback width; height follows the frame aspect
 * @returns {Promise<{data: Uint8Array, width: number, height: number}|null>}
 */
export function probeFxInput(eid, { width = 192 } = {}) {
  if (!provider || !eid) return Promise.resolve(null);
  // Only one probe can be in flight — a second ask supersedes the first rather
  // than queueing readbacks the panel would throw away anyway.
  pending?.settle(null);
  return new Promise((resolve) => {
    let done = false;
    const settle = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (pending && pending.settle === settle) pending = null;
      resolve(payload);
    };
    const timer = setTimeout(() => settle(null), PROBE_TIMEOUT_MS);
    pending = { eid, width, settle };
    if (!provider(pending)) settle(null);
  });
}

/** Called by the Player when the chain reaches the armed entry. */
export function takeFxProbeRequest(eid) {
  if (!pending || pending.eid !== eid) return null;
  return pending;
}

/** Drop any armed request (panel closed, effect removed). */
export function cancelFxProbe() {
  pending?.settle(null);
}
