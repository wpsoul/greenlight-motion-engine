/*
 * The waits around a still's or a render's warm-ups (renderWarmup.waitForMediaReady). No imports: unit-tested in node
 * (renderSettle.test.mjs); end to end by the frame-accuracy gate (tests/still-frame-accuracy) and the warm-render checks.
 *
 * They used to be fixed screen refreshes: two paints (four animation frames) before the warm-ups and two after, ~130 ms of every
 * still, and on a warm page most of a 2D still. A caller that can say when React has committed (`settle`: the headless render
 * page) waits for what a capture actually needs instead:
 *   - before the warm-ups, nothing: that caller has just committed its project (VideoProjectRenderPage.setConfig);
 *   - before the capture, the renderer up (a WebGPU renderer draws nothing until its init() resolves: a cold page), one frame at
 *     a time, and then every update the warm-ups scheduled inside the Player committed (a font that landed bumps its repaint
 *     version: a text plate painted before it must be painted again).
 * Without `settle` (the Motion Engine's pages), the fixed paints, as always.
 */

// ~5 s at 60 Hz: a renderer that is not up by then will not be, and the capture goes on as it always did.
export const RENDERER_WAIT_FRAMES = 300;

export async function settleBeforeWarmups({ settle = null, paint }) {
  if (settle) return;
  await paint();
  await paint();
}

export async function settleBeforeCapture({ settle = null, paint, getPlayer = null }) {
  if (!settle) {
    await paint();
    await paint();
    return;
  }
  for (let i = 0; i < RENDERER_WAIT_FRAMES && getPlayer?.()?.isRendererReady?.() === false; i += 1) await paint();
  await settle();
}
