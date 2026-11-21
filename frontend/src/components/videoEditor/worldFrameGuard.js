/**
 * (engine100) The 3D Scene's preview when its world cannot draw a frame, and its loading notice when it stays up.
 *
 * The owner's night desk "loaded forever" after its monitor was hidden and shown. Two ways led there (tests/world3d-recover): a world
 * frame that threw (three reading a light's shadow disposed by the rebuild before) went up through the editor, which then showed "The
 * Video Editor could not be loaded"; and a failed step of the world's shader preparation left every later frame waiting on it, under
 * "Preparing the picture" for good. The preview now draws again by itself after a frame that threw (sooner first, then less often; the
 * sixth fault in a row, about 4 s on, builds the scene anew: new lights, materials and shaders), and says in one line when a notice has shown 20 s.
 * Renders keep throwing: a render stops with its error rather than wait.
 */

/** How long one notice may show before the world says so (world3dLayer reportLoad). */
export const NOTICE_STUCK_MS = 20000;

/** The `n`-th frame in a row that threw (1 = the first): when to draw again, whether to build the scene anew first, whether to log it. */
export function frameFaultPlan(n) {
  // (the count goes on until a frame is really drawn again: one rebuild an episode, however long it lasts; a fault that passes within
  // a few seconds, as work left over from the build before settles, costs no rebuild)
  const k = Math.max(1, Math.floor(Number(n) || 1));
  return { delay: Math.min(4000, 125 * 2 ** Math.min(5, k - 1)), rebuild: k === 6, log: k === 1 || k === 6 || k % 25 === 0 };
}

/** Watches the loading notice: `onStuck(stage, ms)` once when it has shown `limit` ms without going (whatever stages it went through:
 *  the stage it shows then is named). `note(load)` with each report; null: the notice is gone, and the count starts again. */
export function noticeWatch({ onStuck, limit = NOTICE_STUCK_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let stage = null, timer = null;
  return {
    note(load) {
      stage = load?.stage ?? null;
      if (stage === null) {
        if (timer !== null) { clearTimer(timer); timer = null; }
      } else if (timer === null) timer = setTimer(() => { onStuck(stage, limit); }, limit);
    },
    get stage() { return stage; },
  };
}
