/*
 * Encode a roto track's per-frame matte into a small grayscale MP4.
 *
 * Why a file at all: a raster mask has to survive a project save AND be
 * readable by the export renderer, which is a separate browser page that can
 * only reach media by URL. Nothing in the project JSON can hold frames.
 *
 * Why MP4/H.264 and not an alpha format: Chromium's WebCodecs VideoEncoder
 * rejects every `alpha: 'keep'` configuration (see the WebM-alpha route in
 * backend/main.py, which exists precisely because of that), so the matte
 * travels as LUMA and layerMask.js lifts it back into coverage. H.264 is also
 * what mp4box can demux, which is what makes the matte readable through
 * motionVideo.js's existing frame-exact lane in both preview and export.
 *
 * Every frame is a keyframe. A matte is scrubbed, not streamed: a random seek
 * then costs one frame of decode instead of a GOP, and at this resolution the
 * size penalty is a few hundred KB.
 */
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer';

export function matteEncoderSupported() {
  return typeof VideoEncoder === 'function' && typeof VideoFrame === 'function'
    && (typeof OffscreenCanvas === 'function');
}

function h264Level(w, h, fps) {
  const mb = Math.ceil(w / 16) * Math.ceil(h / 16);
  const mbs = mb * Math.max(1, fps || 30);
  if (mb <= 1620 && mbs <= 40500) return '1F';   // 3.1 — covers 720p30
  if (mb <= 8192 && mbs <= 245760) return '28';  // 4.0
  return '32';                                   // 5.0
}

async function pickCodec(config) {
  for (const codec of config.candidates) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({ ...config.base, codec });
      if (supported) return codec;
    } catch { /* try the next one */ }
  }
  return null;
}

/**
 * createMatteEncoder({ w, h, fps }) — feed it `add(gray)` once per frame, in
 * order, then `finish()`. `gray` is a w*h Uint8 coverage plane.
 *
 * Dimensions are padded to even: 4:2:0 has no odd-sized chroma plane, and an
 * odd analysis grid (a 16:9 512 long edge gives 512×288, but 4:3 gives 512×384
 * and a 1.85 source gives 512×277) would otherwise fail to configure.
 */
export async function createMatteEncoder({ w, h, fps = 30 }) {
  if (!matteEncoderSupported()) throw new Error('This browser cannot encode a matte (WebCodecs missing).');
  const ew = Math.max(2, w + (w & 1));
  const eh = Math.max(2, h + (h & 1));
  const rate = Math.max(1, Math.round(fps));

  const canvas = new OffscreenCanvas(ew, eh);
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  const img = ctx.createImageData(ew, eh);
  const px = img.data;
  for (let i = 3; i < px.length; i += 4) px[i] = 255;   // opaque once, forever

  const target = new Mp4Target();
  const muxer = new Mp4Muxer({
    target,
    video: { codec: 'avc', width: ew, height: eh },
    fastStart: 'in-memory',
  });

  let encoderError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encoderError = e; },
  });

  const level = h264Level(ew, eh, rate);
  const base = {
    width: ew,
    height: eh,
    framerate: rate,
    // All-intra needs a real budget or the edge — the only thing in the frame
    // that carries information — is the first thing the quantizer spends.
    bitrate: Math.max(900_000, Math.round(ew * eh * rate * 0.35)),
    avc: { format: 'avc' },
  };
  const codec = await pickCodec({
    base,
    candidates: [`avc1.6400${level}`, `avc1.4D00${level}`, `avc1.4200${level}`, 'avc1.42001E'],
  });
  if (!codec) throw new Error('No H.264 encoder is available for the matte.');
  encoder.configure({ ...base, codec });

  let count = 0;

  return {
    width: ew,
    height: eh,
    fps: rate,
    get frames() { return count; },

    /* One frame. `gray` is w*h (the UNPADDED analysis grid); the pad column /
       row is left black, which is "no coverage" and therefore harmless. */
    add(gray) {
      if (encoderError) throw encoderError;
      for (let y = 0; y < h; y++) {
        const src = y * w;
        const dst = y * ew * 4;
        for (let x = 0; x < w; x++) {
          const v = gray ? gray[src + x] : 0;
          const o = dst + x * 4;
          px[o] = v; px[o + 1] = v; px[o + 2] = v;
        }
      }
      ctx.putImageData(img, 0, 0);
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((count * 1e6) / rate),
        duration: Math.round(1e6 / rate),
      });
      // keyFrame on every frame: see the module header.
      encoder.encode(frame, { keyFrame: true });
      frame.close();
      count += 1;
      // Never let the queue run away on a long track — the frames are cheap to
      // hold but the encoder's internal buffers are not.
      return encoder.encodeQueueSize > 12 ? encoder.flush() : null;
    },

    async finish() {
      await encoder.flush();
      if (encoderError) throw encoderError;
      encoder.close();
      muxer.finalize();
      return {
        bytes: new Uint8Array(target.buffer),
        width: ew, height: eh, fps: rate, frames: count,
      };
    },

    abort() {
      try { encoder.close(); } catch { /* already closed */ }
    },
  };
}
