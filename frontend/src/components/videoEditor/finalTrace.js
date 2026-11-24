/*
 * (lookfix) What a render's Final frame tells the world's tracer, in one place: the app's render page (world3dLayer.js settleWorldFrame,
 * the editor's Final toggle) reads it, and a render farm's pod is that same render page (farmparity: VideoProjectRenderPage.jsx farmFrames).
 * A plain module (no three, no editor state). The farm's pod page once kept a copy whose unset denoise look was still "natural" after the
 * app's became "clean", and every farm frame of a Scene that left it unset mixed a fifth of the raw trace back over the denoised picture.
 */
import { DENOISE_LOOK_DEFAULT } from '../../world3d/render/denoiseLook.js';

/** Trace options a Scene's `rig.render` may leave out, at the defaults its schema gives them (`spp` 32, not 64: on four kinds of
 *  scene 32 samples flickered no more than 64 and traced 1.55 to 1.93 times faster, html/INTERFACE/final-spp-lab) (rig3d.js normalizeRigRender; the tracer's own
 *  defaults, WorldRenderer's `trace`): a render after the preview, a farm frame after another Scene's, or the preview after a render, must
 *  not keep the other's samples, bounce limits, clamp, denoise or denoise look (WorldRenderer.setTraceOptions merges). */
export const TRACE_UNSET = Object.freeze({
  spp: 32, bounces: 8, transparentBounces: 5, glossy: 0.5, clamp: 0, denoise: true,
  diffuseBounces: null, specularBounces: null, transmissionBounces: null, volumeBounces: null,
  denoiseLook: DENOISE_LOOK_DEFAULT, lightPasses: false,
});

/** The options a render's Final frame traces with (WorldRenderer.setTraceOptions), from the Scene's `rig.render` and the export's `fps`
 *  (0 for a still). The radiance cache unless `render.radianceCache` is false: on the owner's desk move, 32 samples with it match 64 without
 *  at 2.2 times the speed, with no more flicker (tests/world3d-lab/s4, RESULTS.md S4.25). A video frame (the export gives its fps) is
 *  steadied against the frame before it after its denoiser ("Steady"), and carries that frame's soft light only where `render.softReuse`
 *  is true (S4.28; flicker1 round 2: through the export the carried light boiled more than it cleaned on four of five scenes,
 *  WorldRenderer videoCarry). `mode` and `exposure` are the frame's, not the tracer's. */
export function finalTraceOptions(render, fps = 0) {
  const { mode: _mode, exposure: _exposure, ...trace } = { ...TRACE_UNSET, ...(render || {}) };
  return { ...trace, radianceCache: trace.radianceCache !== false, softReuse: !!fps, videoCarry: trace.softReuse === true, fps: fps || 24 };
}

// How long one Final frame of a render may trace before it counts as stuck. A render waits for the trace itself (the frame ends with the
// samples and the denoiser's own end), so this is only a safety net: never under the ten minutes it always was, plus a cold build of the
// tracer's kernels (up to 296 s seen, tests/world3d-lab/s4 RESULTS.md S4.28b) and ten times the slowest frame measured per sample and pixel
// (an SSS candle, 1080p at 128 samples in 65 s: 2.5e-7 s; S4.39).
const FINAL_FRAME_FLOOR_MS = 600000;
const FINAL_FRAME_FIXED_MS = 300000;
const FINAL_MS_PER_SAMPLE_PIXEL = 0.0025;
export function finalFrameBudgetMs(spp, width, height) {
  const samples = Math.max(1, Number(spp) || 32), pixels = Math.max(1, (Number(width) || 1920) * (Number(height) || 1080));
  return Math.max(FINAL_FRAME_FLOOR_MS, FINAL_FRAME_FIXED_MS + samples * pixels * FINAL_MS_PER_SAMPLE_PIXEL);
}

/** How long a render's first trace waits for the tracer's prep made in workers (WorldRenderer.prepareTrace): the owner's pink desk (5.6 M
 *  triangles) takes 2.8 s there; past this the trace starts and the tracer builds the meshes the workers have not finished itself. */
export const PREP_WAIT_MS = 120000;
