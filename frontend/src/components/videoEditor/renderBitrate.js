// The automatic ("quality-based") output bitrate, and the ceiling that keeps it
// from picking a file nobody asked for.
//
// This lives on its own so the exporter and the Render Settings modal can share
// ONE definition. They previously had a copy each, which is how the modal could
// quote a size the render would not produce — and importing the exporter into a
// settings dialog would drag mp4-muxer/webm-muxer along with it.

const DETAIL_BITRATE_BPP = 0.4;

// Ceiling on the file the AUTOMATIC bitrate is allowed to aim for. The detail
// formula below has no duration term of its own, so it picks the same
// bits-per-second for a 5-second clip and a 45-minute cut: 3840x1814 @ 23.976
// comes out at 66.87 Mbps, 3.4x the source's own rate, and roughly 3.4 GB across
// a 392-second timeline. An explicit bitrate from Render Settings is never
// touched by this.
export const AUTO_BITRATE_MAX_OUTPUT_BYTES = 2e9;

// ...but the ceiling must never be allowed to gut the picture on a long render.
// Below this fraction of the detail estimate the automatic value stops falling
// and the file is simply allowed to be larger.
export const AUTO_BITRATE_MIN_FRACTION = 0.25;

/**
 * Automatic video bitrate in bits per second.
 *
 * @param {number} width      output width in pixels
 * @param {number} height     output height in pixels
 * @param {number} fps        output frame rate
 * @param {number} durationSec  length of the render. Omit (or 0) for the
 *   unbounded detail estimate — callers that genuinely do not know the duration
 *   get the old behaviour rather than a wrong ceiling.
 */
export function estimateDetailBitrate(width, height, fps, durationSec = 0) {
  const pixels = Math.max(1, Math.round(width) * Math.round(height));
  const rate = Math.max(1, Math.round(fps || 30));
  const detail = Math.max(8_000_000, Math.round(pixels * rate * DETAIL_BITRATE_BPP));
  if (!(durationSec > 0)) return detail;
  const sizeCapped = Math.floor((AUTO_BITRATE_MAX_OUTPUT_BYTES * 8) / durationSec);
  const floor = Math.max(8_000_000, Math.round(detail * AUTO_BITRATE_MIN_FRACTION));
  return Math.max(Math.min(detail, floor), Math.min(detail, sizeCapped));
}
