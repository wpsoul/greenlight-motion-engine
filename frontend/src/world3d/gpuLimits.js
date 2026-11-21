// (gaps1) How big a picture a WebGPU device may draw. A device gets WebGPU's default limits unless it asks for more: 8192 px a side for a
// 2D texture, although this machine's GPU (and most desktop GPUs) offer 16384. Every target of a render bigger than that was invalid and
// the picture came back black. Each device that draws a render's picture (the editor's compositor, videoRenderer.js; the 3D world,
// render/WorldRenderer.js) asks for what its adapter offers, up to what the render page can need. Plain numbers, no GPU here.

/** The largest picture side a render asks for, px: a 16K still. */
export const PICTURE_MAX = 16384;
/** WebGPU's default `maxTextureDimension2D`: what a device has without asking. */
export const DEFAULT_TEXTURE_SIDE = 8192;

/** The `maxTextureDimension2D` a device should ask for, given its adapter's limits: what the adapter offers, up to `need` px (the
 *  compositor draws the picture itself, PICTURE_MAX; the world hands its picture over its depth, twice as tall). Null where the adapter
 *  offers no more than the default: nothing to ask for. */
export function textureSideLimit(adapterLimits, need = PICTURE_MAX) {
  const offered = Number(adapterLimits?.maxTextureDimension2D);
  if (!(offered > DEFAULT_TEXTURE_SIDE)) return null;
  return Math.min(offered, Math.max(DEFAULT_TEXTURE_SIDE, need));
}

/** The largest array a page can make, bytes (measured in this Chrome: 2.14e9 made, 2^31 - 1 refused). The path tracer's per-pixel buffers
 *  are made from one (WaveFrontPathTracer._zeroView). */
export const ARRAY_MAX = 2 ** 31 - 2 ** 20;
/** Bytes a pixel the path tracer's largest per-pixel buffer holds: the denoiser's guides, four vec4 where one binding holds them at 4K
 *  (the tracer's "Soft"), two elsewhere. */
export const guideBytes = (soft) => (soft ? 64 : 32);

/** (leftovers-tile) The most pixels one trace (a frame, or one window of a frame traced in tiles, traceTiles.js) holds: its largest
 *  per-pixel buffer is made from one array of at most ARRAY_MAX bytes and bound whole (a device binding of `binding` bytes). The largest
 *  is the denoiser's guides (two vec4 more a pixel in their tail for render passes, `split`), or the light groups' sums (a vec4 a group,
 *  `passGroups`), whichever is bigger. */
export function tracePixelsMost({ binding = 0, soft = false, split = false, passGroups = 0 } = {}) {
  const most = Math.min(binding > 0 ? binding : ARRAY_MAX, ARRAY_MAX);
  return Math.floor(most / Math.max(guideBytes(soft) + (split ? 32 : 0), 16 * (passGroups | 0)));
}

/** The words a Final render stops with when a `width` x `height` picture is more pixels than the path tracer's largest per-pixel buffer
 *  can hold: a device binding of `binding` bytes, an array of ARRAY_MAX. Null when it fits. Draft has no such buffer. */
export function traceSizeError(width, height, { binding = 0, soft = false } = {}) {
  const most = Math.min(binding > 0 ? binding : ARRAY_MAX, ARRAY_MAX);
  const pixels = Math.floor(most / guideBytes(soft));
  if (width * height <= pixels) return null;
  const k = Math.sqrt(pixels / (width * height));
  const w = Math.floor(width * k), h = Math.floor(height * k);
  return `[GPU_BUFFER_LIMIT] Final traces at most ${(pixels / 1e6).toFixed(1)} million pixels a frame on this GPU (its largest buffer, the `
    + `denoiser's guides, holds ${Math.round(most / 1048576)} MB); this picture is ${width}x${height} (${(width * height / 1e6).toFixed(1)} million). `
    + `Render it at ${w}x${h} or less, or render the Scene in Draft (no such limit).`;
}

/** The words a render stops with when the 3D world's picture for a `width` x `height` frame is past `max` px a side (the same
 *  machine-readable code the exporter uses for the compositor's own picture). The world draws the picture, its depth and its passes at
 *  the frame's size; the canvas it hands them over on holds the picture over its depth (`handoff`), twice the height, and a picture too
 *  tall for that hands over in slices (WorldRenderer #planHandoff, leftovers-tile): so the frame itself is the limit. Null when it fits or
 *  the limit is unknown. */
export function worldTextureLimitError(width, height, handoff, max) {
  if (!(max > 0) || (width <= max && height <= max)) return null;
  return `[GPU_TEXTURE_LIMIT] The 3D Scene's picture is ${width}x${height}, past the largest this GPU draws on the WebGPU engine (${max} px a side). `
    + `Render a 3D Scene at ${max} px a side or less${handoff ? ` (a 16K still: ${max}x${Math.round(max * 9 / 16)})` : ''}.`;
}
