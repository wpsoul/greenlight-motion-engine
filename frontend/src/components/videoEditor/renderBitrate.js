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

// Constant-quality encoding for the AUTOMATIC setting. Under a bitrate target
// (bitrateMode 'variable') Chromium's hardware H.264 encoder alternates sharp and
// starved frames: on V2.8's grainy opening (720x1280, 30 fps, 11 Mbps) every
// other frame came out at SSIM 0.88-0.92 against 0.99 for its neighbours, a 15 Hz
// shimmer over the whole picture (min SSIM 0.76), and doubling the target only
// narrowed the gap (0.98 / 0.92). A fixed quantizer has no rate loop to
// oscillate: same frames, SSIM 0.955 (min 0.940), frame-to-frame jitter 0.068 ->
// 0.001. H.264 QP 18 and VP9 quantizer 36 measured the same quality there.
export const AUTO_QUANTIZER = { avc: 18, vp9: 36 };

// A quantizer has no size ceiling, and grain-heavy footage at QP 18 ran at 2x the
// detail estimate. Keep the AUTO_BITRATE_MAX_OUTPUT_BYTES promise with room to
// spare: only renders that would stay under it at this multiple of the detail
// estimate get the quantizer; longer ones keep the capped variable bitrate.
export const AUTO_QUANTIZER_RATE_HEADROOM = 3;

/**
 * The per-frame quantizer for an automatic-bitrate render, or null when the
 * render should keep a bitrate target (unknown length, too long for the size
 * ceiling, or a codec WebCodecs has no quantizer option for).
 *
 * @param {string} codec  WebCodecs codec string ('avc1.640028', 'vp09.00.10.08', ...)
 */
export function autoQuantizerFor(codec, width, height, fps, durationSec = 0) {
  const kind = /^avc1\./.test(codec || '') ? 'avc' : (/^vp09\./.test(codec || '') ? 'vp9' : null);
  if (!kind || !(durationSec > 0)) return null;
  const detail = estimateDetailBitrate(width, height, fps);
  const bytes = (detail * AUTO_QUANTIZER_RATE_HEADROOM * durationSec) / 8;
  if (bytes > AUTO_BITRATE_MAX_OUTPUT_BYTES) return null;
  return { kind, quantizer: AUTO_QUANTIZER[kind] };
}
