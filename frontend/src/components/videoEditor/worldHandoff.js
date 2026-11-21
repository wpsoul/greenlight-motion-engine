/*
 * When a render may read the 3D Scene's picture (world3dLayer.js). No imports: unit-tested in node (worldHandoff.test.mjs); end to end
 * by tests/still-time.
 *
 * The world draws on a GPU device of its own and the compositor takes each picture as an image of the world's canvas (the plate's
 * CanvasTexture: copyExternalImageToTexture). With the GPU free every read is the frame just drawn; with the GPU behind (a heavy Scene
 * whose shaders are still compiling, another job on the GPU), every read inside one browser rendering update gave the picture the canvas
 * held at its first read since the last update, and Chrome then makes few updates (none for over a second was seen). A still's warm-up
 * puts the page back at its playhead (t = 0) and draws it between its own frames, so a still of a keyed Scene came back as frame 0
 * (2 of 5 pink desk stills; tests/still-time).
 *
 * So the plate notes each read (`read`), and a render's frame, before its last repaint, waits for the next rendering update when the
 * canvas has been read since the last one (`fresh`): that repaint is then the canvas's first read since an update and hands over the
 * frame it drew. One update is ~16 ms on a free GPU, and nothing is waited for when an update has passed since the last read anyway.
 * The wait runs while the frame settles (`watch`). Exported frames do not wait at all (world3dLayer.settleWorldFrame with `fps`): an
 * export's frames follow one another and nothing draws another time between them, and without any wait every exported frame was right
 * (stilltime2: 16.4.35's exports, 480 frames under a busy GPU on fresh browsers, though consecutive frames shared one rendering update),
 * while the wait cost a light Scene's export ~8 ms a frame.
 *
 *   now()        the current rendering update (document.timeline.currentTime: the same number until the next update), null if unknown
 *   nextUpdate() resolves after the next rendering update (its frame callbacks, then the task after them)
 *   clock()      ms, for the limit
 *   hidden()     the page makes no rendering updates now (a hidden tab, a minimised window): nothing is waited for, as before
 *   maxWaitMs    a page whose updates stop coming goes on after this, as before
 */
export function createWorldHandoff({ now, nextUpdate, clock = () => Date.now(), hidden = () => false, maxWaitMs = 3000 }) {
  let readAt = null;
  const until = async (at) => {
    const t0 = clock();
    while (now() === at && clock() - t0 < maxWaitMs) await nextUpdate();
  };
  const handoff = {
    /** The plate has just read the world's canvas. */
    read() { readAt = now(); },
    /** Whether the next read must wait for a rendering update: the canvas was read since the last one. */
    needs() {
      const at = now();
      return at != null && readAt === at && !hidden();
    },
    /** Resolves true after waiting for a rendering update (the caller draws its frame again), false at once when no wait is needed. */
    async fresh() {
      if (!handoff.needs()) return false;
      await until(now());
      return true;
    },
    /** Starts waiting now for the next rendering update when the canvas has been read since the last one, so a still can settle its
     *  frame meanwhile; resolves when it has passed (at once when there was nothing to wait for). */
    watch() {
      return handoff.needs() ? until(now()) : Promise.resolve();
    },
  };
  return handoff;
}

/** The browser's: document.timeline's time and requestAnimationFrame, each wait capped at `stepMs` (a page whose frames are throttled). */
export function browserHandoffClock(stepMs = 250) {
  return {
    now: () => (typeof document !== 'undefined' ? document.timeline?.currentTime ?? null : null),
    hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    nextUpdate: () => new Promise((resolve) => {
      let done = false;
      const go = () => { if (!done) { done = true; resolve(); } };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(go, 0));
      setTimeout(go, stepMs);
    }),
    clock: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  };
}
