import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target, StreamTarget as Mp4StreamTarget } from 'mp4-muxer';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget, StreamTarget as WebmStreamTarget } from 'webm-muxer';
import { audioFadeGainWindow } from './audioFade';
import { estimateDetailBitrate } from './renderBitrate';
import { measureEncoderDelay, insertAudioEditList, createPrimingStreamPatcher } from './mp4AudioPriming';

const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_BITRATE = 128000;
// How many muxed-but-unwritten bytes the frame loop tolerates before it stops
// producing. The muxer emits 16 MiB chunks, so this has to be a few of them or
// the loop parks on every single write; 96 MB is six chunks of slack. Measured
// without it: 50.5% of everything produced was still queued when the frame loop
// ended, and each queued 16 MiB chunk carries ~73 MB of transient allocation
// through the base64 sink — which is how a long 4K render reaches
// `RangeError: Array buffer allocation failed`.
export const DEFAULT_MAX_QUEUED_OUTPUT_BYTES = 96 * 1024 * 1024;

/**
 * `?audio=1` asks the media server for an audio-only copy of a clip (see the
 * audio-sidecar block in backend/main.py). Only local /media URLs can answer it;
 * anything else — blob:, data:, a remote CDN — is fetched as-is.
 */
function audioSidecarUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('/media/')) return null;
  return url + (url.includes('?') ? '&' : '?') + 'audio=1';
}

async function decodeAudioResponse(resp) {
  const arrayBuffer = await resp.arrayBuffer();
  const ctx = new OfflineAudioContext(AUDIO_CHANNELS, 1, AUDIO_SAMPLE_RATE);
  return ctx.decodeAudioData(arrayBuffer);
}

/**
 * Fetch and decode an audio file URL into an AudioBuffer, or null when the
 * source carries no audio track.
 *
 * decodeAudioData needs the bytes in one ArrayBuffer, so pointing this at a
 * clip's video meant buffering the ENTIRE file to read its soundtrack — and a
 * response past the browser's single-buffer ceiling fails outright ("Failed to
 * fetch"), which is how a 5.2GB / 43-minute take came out of the render mute
 * while shorter clips on the same timeline kept their sound. Ask the media
 * server for the audio track alone instead: ~2% of the bytes, and stream-copied,
 * so the samples are identical to the ones inside the source.
 */
async function fetchAndDecodeAudio(url) {
  // cache:'no-store' — Chromium fails large responses with
  // ERR_CACHE_WRITE_FAILURE while writing them to its HTTP disk cache (see
  // webcodecsClipDecoder.js), which would drop the audio just as silently.
  const fetchOpts = { mode: 'cors', cache: 'no-store' };
  const sidecar = audioSidecarUrl(url);
  if (sidecar) {
    let resp = null;
    try {
      resp = await fetch(sidecar, fetchOpts);
    } catch {
      resp = null; // sidecar route unreachable (old backend) — fall through
    }
    // 204: the server probed the source and it has no audio stream at all.
    if (resp && resp.status === 204) return null;
    // Any 2xx body IS the authoritative audio for this clip — either the sidecar
    // or the original, which the server serves back when a sidecar would save
    // nothing. Re-fetching the original after a decode failure would only
    // re-download the same bytes, so let the error propagate.
    if (resp && resp.ok) return decodeAudioResponse(resp);
  }
  const resp = await fetch(url, fetchOpts);
  if (!resp.ok) throw new Error(`Failed to fetch audio: ${resp.status}`);
  return decodeAudioResponse(resp);
}

/**
 * `?audio=pcm` streams a clip's decoded soundtrack as headerless s16le at
 * AUDIO_SAMPLE_RATE/AUDIO_CHANNELS, so the mixer never holds a whole clip.
 * Only local /media URLs can answer it; blob:, data: and remote CDNs cannot.
 */
function audioPcmUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('/media/')) return null;
  return url + (url.includes('?') ? '&' : '?') + 'audio=pcm';
}

/**
 * Mix one clip straight off the PCM stream. Returns false when the source has
 * no audio track at all, true when something was mixed.
 *
 * The whole point is that nothing whole is ever resident: a 43-minute clip
 * decodes to ~990MB as an AudioBuffer, which — held next to the mix buffers and
 * the video pipeline — is what pushed a 2560x1440 render to ~4.6GB RSS and into
 * swap thrash. Here the working set is one 256KB chunk.
 */
async function mixClipFromPcmStream(clip, mixL, mixR, totalSamples, pcmUrl) {
  const resp = await fetch(pcmUrl, { mode: 'cors', cache: 'no-store' });
  if (resp.status === 204) return false; // silent source
  if (!resp.ok) throw new Error(`Failed to stream audio: ${resp.status}`);
  if (!resp.body?.getReader) throw new Error('Streaming audio unsupported');

  const vol = clip.volume ?? 1;
  const fadeSpan = (clip.placedEnd ?? 0) - (clip.placedStart ?? 0);
  const hasFade = ((clip.fadeIn > 0 || clip.fadeOut > 0) && fadeSpan > 0);
  // The stream is 1:1 with the mix rate, so source and destination advance
  // together — no resampling term, and no seek that could land off-sample.
  const srcStartFrame = Math.round((clip.trimStart || 0) * AUDIO_SAMPLE_RATE);
  const srcEndFrame = clip.trimEnd
    ? Math.round(clip.trimEnd * AUDIO_SAMPLE_RATE)
    : Number.MAX_SAFE_INTEGER;
  const destStartSample = Math.round(clip.startTime * AUDIO_SAMPLE_RATE);

  const BYTES_PER_FRAME = 2 * AUDIO_CHANNELS; // s16 interleaved stereo
  const reader = resp.body.getReader();
  const carry = new Uint8Array(BYTES_PER_FRAME);
  let carryLen = 0;
  let srcFrame = 0;
  let done = false;

  const mixFrame = (l, r) => {
    if (srcFrame >= srcStartFrame && srcFrame < srcEndFrame) {
      const destIdx = destStartSample + (srcFrame - srcStartFrame);
      if (destIdx >= totalSamples) { done = true; return; }
      if (destIdx >= 0) {
        let gain = vol;
        if (hasFade) {
          gain *= audioFadeGainWindow(
            clip.fadeIn, clip.fadeOut, clip.fadeCurve,
            destIdx / AUDIO_SAMPLE_RATE - clip.placedStart, fadeSpan
          );
        }
        mixL[destIdx] += (l / 32768) * gain;
        mixR[destIdx] += (r / 32768) * gain;
      }
    }
    srcFrame += 1;
    if (srcFrame >= srcEndFrame) done = true;
  };

  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone || !value) break;
      let offset = 0;
      // A chunk boundary can fall mid-frame; carry the partial frame forward.
      if (carryLen > 0) {
        const need = BYTES_PER_FRAME - carryLen;
        if (value.length < need) {
          carry.set(value, carryLen);
          carryLen += value.length;
          continue;
        }
        carry.set(value.subarray(0, need), carryLen);
        const dv = new DataView(carry.buffer, carry.byteOffset, BYTES_PER_FRAME);
        mixFrame(dv.getInt16(0, true), dv.getInt16(2, true));
        carryLen = 0;
        offset = need;
      }
      const whole = (value.length - offset) - ((value.length - offset) % BYTES_PER_FRAME);
      const view = new DataView(value.buffer, value.byteOffset + offset, whole);
      for (let b = 0; b < whole && !done; b += BYTES_PER_FRAME) {
        mixFrame(view.getInt16(b, true), view.getInt16(b + 2, true));
      }
      const tailStart = offset + whole;
      if (tailStart < value.length) {
        carryLen = value.length - tailStart;
        carry.set(value.subarray(tailStart), 0);
      }
    }
  } finally {
    // Past the trim end there is nothing left to mix — stop ffmpeg rather than
    // let it decode the rest of a 43-minute file for nobody.
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return true;
}

/**
 * Mix all audio clips into a single interleaved Float32 PCM buffer.
 * Each entry in audioClips: { url, startTime, trimStart, trimEnd, volume,
 *   fadeIn?, fadeOut?, fadeCurve?, placedStart?, placedEnd? }
 * `dropped` collects the URLs of clips whose audio could not be read, so the
 * caller can report a partially-silent render instead of shipping one quietly.
 */
async function mixAudioClips(audioClips, duration, dropped = []) {
  if (audioClips.length === 0) return null;

  const totalSamples = Math.ceil(duration * AUDIO_SAMPLE_RATE);
  const mixL = new Float32Array(totalSamples);
  const mixR = new Float32Array(totalSamples);

  for (const clip of audioClips) {
    const pcmUrl = audioPcmUrl(clip.url);
    if (pcmUrl) {
      try {
        await mixClipFromPcmStream(clip, mixL, mixR, totalSamples, pcmUrl);
        continue;
      } catch (e) {
        // Old backend, or a source ffmpeg could not open. Fall through to the
        // whole-file decode — correct, just far heavier.
        console.warn('[export] PCM stream unavailable, decoding whole clip:', clip.url, e.message);
      }
    }

    let decoded;
    try {
      decoded = await fetchAndDecodeAudio(clip.url);
    } catch (e) {
      // console.error, not warn: the render still completes — just without this
      // clip's sound — and a warning buried in a 43-minute render log is exactly
      // how a mute export reached playback before anyone noticed.
      console.error('[export] AUDIO DROPPED — this clip contributes no sound to the render:', clip.url, e.message);
      dropped.push(clip.url);
      continue;
    }
    // No audio track in the source: normal for silent footage, nothing to report.
    if (!decoded) continue;

    const srcL = decoded.getChannelData(0);
    const srcR = decoded.numberOfChannels >= 2 ? decoded.getChannelData(1) : srcL;
    const vol = clip.volume ?? 1;

    // Intro/outro fade: the envelope runs over the clip's placed timeline span
    // (placedStart/placedEnd, output time), so a partial render that clamped the
    // trims still fades in the right places.
    const fadeSpan = (clip.placedEnd ?? 0) - (clip.placedStart ?? 0);
    const hasFade = ((clip.fadeIn > 0 || clip.fadeOut > 0) && fadeSpan > 0);

    const srcStartSample = Math.round((clip.trimStart || 0) * decoded.sampleRate);
    const srcEndSample = Math.round((clip.trimEnd || decoded.duration) * decoded.sampleRate);
    const destStartSample = Math.round(clip.startTime * AUDIO_SAMPLE_RATE);

    for (let srcIdx = srcStartSample; srcIdx < srcEndSample; srcIdx++) {
      const destIdx = destStartSample + Math.round((srcIdx - srcStartSample) * (AUDIO_SAMPLE_RATE / decoded.sampleRate));
      if (destIdx < 0) continue;
      if (destIdx >= totalSamples) break;
      let gain = vol;
      if (hasFade) {
        gain *= audioFadeGainWindow(
          clip.fadeIn, clip.fadeOut, clip.fadeCurve,
          destIdx / AUDIO_SAMPLE_RATE - clip.placedStart, fadeSpan
        );
      }
      mixL[destIdx] += (srcL[srcIdx] || 0) * gain;
      mixR[destIdx] += (srcR[srcIdx] || 0) * gain;
    }
  }

  // Interleave for AudioData (planar float)
  return { left: mixL, right: mixR, totalSamples };
}

/**
 * Encode mixed audio and feed chunks to the muxer.
 */
async function encodeAudioToMuxer(muxer, mixedAudio, isWebm, audioBitrate = 0, onPriming = null) {
  if (!mixedAudio) return;

  const { left, right, totalSamples } = mixedAudio;
  const codecString = isWebm ? 'opus' : 'mp4a.40.2';
  const requested = Math.max(64_000, Math.min(Number(audioBitrate) || AUDIO_BITRATE, 512_000));

  // The platform encoder may reject high bitrates (Chromium's AAC caps below
  // 320k on some OSes). Silently dropping the audio track would be far worse
  // than a lower bitrate, so step down until a config is accepted.
  const candidates = [...new Set([requested, 256_000, 192_000, AUDIO_BITRATE])]
    .filter((b) => b <= requested)
    .sort((a, b) => b - a);
  let targetBitrate = 0;
  for (const b of candidates) {
    try {
      const s = await AudioEncoder.isConfigSupported({
        codec: codecString,
        sampleRate: AUDIO_SAMPLE_RATE,
        numberOfChannels: AUDIO_CHANNELS,
        bitrate: b,
      });
      if (s.supported) { targetBitrate = b; break; }
    } catch { /* try the next lower bitrate */ }
  }

  if (!targetBitrate) {
    console.warn('AudioEncoder not supported for codec:', codecString);
    return;
  }
  if (targetBitrate !== requested) {
    console.warn(`AudioEncoder rejected ${requested} bps for ${codecString}; using ${targetBitrate} bps`);
  }

  // AAC starts with the encoder's priming (2112 samples on macOS): measured here, before the first chunk
  // reaches the muxer, so the MP4 can carry an edit list that skips it (mp4AudioPriming.js) — without it
  // every exported video's sound played ~44 ms late.
  if (!isWebm && onPriming) {
    onPriming(await measureEncoderDelay({
      codec: codecString, sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: AUDIO_CHANNELS, bitrate: targetBitrate,
    }));
  }

  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => {
      muxer.addAudioChunk(chunk, meta);
    },
    error: (e) => {
      console.error('AudioEncoder error:', e);
    },
  });

  audioEncoder.configure({
    codec: codecString,
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfChannels: AUDIO_CHANNELS,
    bitrate: targetBitrate,
  });

  // Encode in chunks of 1024 samples
  const chunkSize = 1024;
  for (let offset = 0; offset < totalSamples; offset += chunkSize) {
    const count = Math.min(chunkSize, totalSamples - offset);
    const interleaved = new Float32Array(count * AUDIO_CHANNELS);
    for (let i = 0; i < count; i++) {
      interleaved[i * 2] = left[offset + i];
      interleaved[i * 2 + 1] = right[offset + i];
    }

    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfFrames: count,
      numberOfChannels: AUDIO_CHANNELS,
      timestamp: Math.round((offset / AUDIO_SAMPLE_RATE) * 1_000_000),
      data: (() => {
        // f32-planar: left channel then right channel
        const planar = new Float32Array(count * AUDIO_CHANNELS);
        planar.set(left.subarray(offset, offset + count), 0);
        planar.set(right.subarray(offset, offset + count), count);
        return planar;
      })(),
    });

    audioEncoder.encode(audioData);
    audioData.close();

    // Back-pressure
    while (audioEncoder.encodeQueueSize > 10) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  await audioEncoder.flush();
  audioEncoder.close();
}

/**
 * Serialize mixed audio ({left,right,totalSamples}) as a 32-bit float WAV. Used by
 * the alpha frames route, where the audio is muxed by ffmpeg server-side instead of
 * being Opus-encoded into a WebM here. Float (not 16-bit) because the mixer sums
 * clips with per-clip gain and can legitimately exceed 1.0 — ffmpeg limits later.
 */
function encodeWavFloat32(mixedAudio) {
  const { left, right, totalSamples } = mixedAudio;
  const bytesPerSample = 4;
  const dataBytes = totalSamples * AUDIO_CHANNELS * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // WAVE_FORMAT_IEEE_FLOAT
  view.setUint16(22, AUDIO_CHANNELS, true);
  view.setUint32(24, AUDIO_SAMPLE_RATE, true);
  view.setUint32(28, AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * bytesPerSample, true);
  view.setUint16(32, AUDIO_CHANNELS * bytesPerSample, true);
  view.setUint16(34, 32, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < totalSamples; i++) {
    view.setFloat32(offset, left[i] || 0, true);
    offset += 4;
    view.setFloat32(offset, right[i] || 0, true);
    offset += 4;
  }
  return new Uint8Array(buffer);
}

/** Encode a canvas to PNG bytes (works for both HTMLCanvasElement and OffscreenCanvas). */
// A source can go straight into VideoFrame only if it is a same-size image
// source the constructor accepts. Anything else (a scaled or unknown-size
// custom source) falls back to the drawImage + getImageData copy path.
function canEncodeDirectly(source, w, h) {
  if (!source || typeof VideoFrame !== 'function') return false;
  const sw = source.width ?? source.videoWidth ?? source.displayWidth ?? source.codedWidth;
  const sh = source.height ?? source.videoHeight ?? source.displayHeight ?? source.codedHeight;
  if (sw !== w || sh !== h) return false;
  return typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement
    || typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas
    || typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap
    || typeof VideoFrame !== 'undefined' && source instanceof VideoFrame
    || typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement;
}

async function canvasToPngBytes(cv) {
  const blob = typeof cv.convertToBlob === 'function'
    ? await cv.convertToBlob({ type: 'image/png' })
    : await new Promise((resolve, reject) => {
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas PNG encode failed'))), 'image/png');
    });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Frame-by-frame video export using WebCodecs + mp4-muxer/webm-muxer.
 * Renders each frame via Three.js at full resolution without realtime playback.
 *
 * @param {object} opts
 * @param {Function} opts.renderFrameAtTime - async (time: number) => void — seeks videos + renders scene
 * @param {HTMLCanvasElement} opts.canvas - the Three.js canvas to capture frames from
 * @param {number} opts.duration - total duration in seconds
 * @param {number} opts.fps - frames per second (default 30)
 * @param {number} opts.width - output width
 * @param {number} opts.height - output height
 * @param {'mp4'|'webm'|'webm-alpha'} opts.format - output format
 * @param {Array} [opts.audioClips] - audio clips to mix: [{ url, startTime, trimStart, trimEnd, volume }]
 * @param {number} [opts.bitrate] - target video bitrate in bits per second
 * @param {Function} [opts.captureFrame] - async () => ImageBitmapSource for custom compositing
 * @param {Function} [opts.onProgress] - (progress: 0..1, totalFrames: number) => void.
 *   totalFrames lets a driver report "frame N of M" rather than a bare percentage.
 * @param {AbortSignal} [opts.signal] - abort signal to cancel export
 * @param {Function} [opts.onFrameImage] - webm-alpha only: async (pngBytes, index) => void.
 *   When provided, transparency is preserved by emitting RGBA PNG frames instead of
 *   encoding video here — WebCodecs has no alpha encoder (see the frames-mode note below).
 * @param {Function} [opts.onAudioData] - webm-alpha frames mode: async (wavBytes) => void
 * @returns {Promise<Blob>}
 */
export async function exportVideo(opts) {
  const {
    renderFrameAtTime,
    canvas,
    duration,
    fps = 30,
    width,
    height,
    format = 'mp4',
    audioClips = [],
    bitrate,
    audioBitrate,
    captureFrame,
    onProgress,
    signal,
    onOutputChunk, // when set, stream output chunks (avoids a >2GB in-memory buffer)
    onFrameImage, // when set (webm-alpha), emit PNG frames instead of encoding video
    onAudioData,
    // Server render on a browser without an H.264 encoder (open-source Chromium on
    // Linux): emit PNG frames for ANY format and let ffmpeg encode (plan §10.4).
    forceFrames = false,
    // Partial ("time range") renders: frame 0 legitimately does the decoder
    // cold-start work a full render spreads over many frames (mid-clip entry),
    // so it gets a bigger watchdog budget. displayTimeOffset shifts times in
    // messages back into absolute timeline time (the export clock starts at the
    // range start, so "0.07s" would otherwise mislead).
    firstFrameTimeoutMs = 0,
    displayTimeOffset = 0,
    // () => string|null — what the renderer was actually doing when a frame
    // stalled. The old message said "a clip likely can't be decoded" for every
    // cause, including a source that was still downloading and had never been
    // handed to a decoder; that one sentence sent a bug reporter through days of
    // container forensics on a file that decodes perfectly.
    describeStall = null,
    // () => string|null — checked once per frame. A non-null return aborts the
    // render. A prepared segment that fails to decode must STOP the export, not
    // let it continue drawing blank frames for that layer: the resulting file
    // looks finished, and nothing downstream can tell that a clip is missing.
    checkFatal = null,
    // () => number — GPU contexts the page has lost so far (gpuReset.js). A GPU
    // reset takes the hardware encoder's input with it and the encoder never
    // errors, it just stops draining; knowing the reset happened turns a 30 s
    // "encoder stall" blamed on resolution into a fast error naming the cause.
    gpuResetCount = null,
    // (timelineSeconds) => string|null — what was on screen when the GPU reset.
    describeGpuReset = null,
    // Phase 7 backpressure budget (RENDER_MAX_QUEUED_OUTPUT_BYTES). The frame
    // loop stops producing while more than this many muxed bytes are waiting on
    // the sink, so the render runs at the speed of its slowest stage instead of
    // banking the difference in memory.
    maxQueuedOutputBytes = DEFAULT_MAX_QUEUED_OUTPUT_BYTES,
  } = opts;
  // `undefined` (nobody set it) means the default; 0 is a deliberate "off".
  const queuedOutputBudget = Number.isFinite(maxQueuedOutputBytes)
    ? maxQueuedOutputBytes
    : DEFAULT_MAX_QUEUED_OUTPUT_BYTES;

  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  console.warn(`[export-phase] exportVideo: ${totalFrames} frames, ${audioClips.length} audio clips, format=${format}, ${width}x${height}`);
  const frameDuration = 1_000_000 / fps; // microseconds per frame
  const useAlpha = format === 'webm-alpha';
  const isWebm = format === 'webm' || format === 'webm-alpha';

  // Frames mode. Chromium's WebCodecs VideoEncoder rejects EVERY alpha:'keep'
  // config (vp8 and vp9 alike, hardware or software) — there is no in-browser
  // encoder that can carry an alpha channel. So for webm-alpha we don't encode
  // here at all: each composited frame is emitted as an RGBA PNG and the caller
  // (the headless render driver) pipes them into ffmpeg's libvpx-vp9 yuva420p
  // encoder, which is the only path that produces a real transparent WebM.
  const framesMode = (useAlpha || forceFrames) && typeof onFrameImage === 'function';
  if (useAlpha && !framesMode) {
    throw new Error('Transparent WebM export is only available through the server render (no in-browser alpha encoder).');
  }

  // Mix audio in parallel with setup
  const hasAudio = audioClips.length > 0 && typeof AudioEncoder !== 'undefined';
  const droppedAudioUrls = [];
  const mixedAudioPromise = hasAudio
    ? mixAudioClips(audioClips, duration, droppedAudioUrls)
    : Promise.resolve(null);

  // Create muxer
  let muxer = null;
  let target = null;

  const audioMuxConfig = hasAudio ? {
    codec: isWebm ? 'A_OPUS' : 'aac',
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfChannels: AUDIO_CHANNELS,
  } : undefined;

  // When a chunk sink is provided, mux to a StreamTarget so output flows out in
  // sequential pieces — a single in-memory ArrayBuffer can't exceed ~2GB in V8, so
  // long renders OOM otherwise. onData is synchronous; queue chunks and drain them
  // through onOutputChunk with backpressure. (mp4 uses 'fragmented' fastStart so
  // writes are append-only — no seek-back to patch the mdat size.)
  const streaming = !framesMode && typeof onOutputChunk === 'function';
  const outQueue = [];
  let pumpWake = null;
  let muxFinished = false;
  // Byte accounting, not just a chunk count: the muxer emits 16 MiB pieces and
  // each one costs roughly 73 MB in transient allocations on its way through the
  // base64 sink, so the number that matters is bytes resident, not items queued.
  let queuedBytes = 0;
  let producedBytes = 0;
  let writtenBytes = 0;
  let drainWake = null;
  const wakeDrain = () => { const d = drainWake; drainWake = null; if (d) d(); };
  const pump = streaming ? (async () => {
    for (;;) {
      if (outQueue.length === 0) {
        if (muxFinished) return;
        await new Promise((resolve) => { pumpWake = resolve; });
        continue;
      }
      const chunk = outQueue.shift();
      await onOutputChunk(chunk);
      queuedBytes -= chunk.byteLength;
      writtenBytes += chunk.byteLength;
      wakeDrain(); // the frame loop may be parked on the byte budget
    }
  })() : null;
  // onData MUST declare two params (data, position) or the muxer rejects it. For
  // fragmented mp4 / webm the writes are sequential (append-only), so `position`
  // can be ignored — we just append in call order.
  const enqueue = (chunk) => {
    outQueue.push(chunk);
    queuedBytes += chunk.byteLength;
    producedBytes += chunk.byteLength;
    if (pumpWake) { pumpWake(); pumpWake = null; }
  };
  // The audio's AAC priming (encodeAudioToMuxer measures it before the first audio chunk) — an MP4 gets an
  // edit list that skips it: patched into the finished buffer, or, streamed, into the moov of the first piece
  // (later pieces shift by its size and the closing mfra is corrected; the last two pieces wait for finish()).
  let audioPrimingSamples = 0;
  const primingPatcher = streaming && !isWebm
    ? createPrimingStreamPatcher(() => audioPrimingSamples, enqueue)
    : null;
  const makeStreamTarget = (Ctor) => new Ctor({
    onData: (data, _position) => {
      const chunk = data.slice(); // copy: the muxer may reuse the buffer
      if (primingPatcher) primingPatcher.push(chunk);
      else enqueue(chunk);
    },
    chunked: true,
  });

  if (framesMode) {
    // No muxer: frames go out as PNGs and ffmpeg builds the file server-side.
  } else if (isWebm) {
    target = streaming ? makeStreamTarget(WebmStreamTarget) : new WebmTarget();
    muxer = new WebmMuxer({
      target,
      video: {
        codec: 'V_VP9',
        width,
        height,
        alpha: useAlpha,
      },
      ...(audioMuxConfig ? { audio: audioMuxConfig } : {}),
    });
  } else {
    target = streaming ? makeStreamTarget(Mp4StreamTarget) : new Mp4Target();
    muxer = new Mp4Muxer({
      target,
      video: {
        codec: 'avc',
        width,
        height,
      },
      ...(audioMuxConfig ? { audio: audioMuxConfig } : {}),
      fastStart: streaming ? 'fragmented' : 'in-memory',
    });
  }

  const h264LevelForSize = (w, h, rate) => {
    const macroblocks = Math.ceil(w / 16) * Math.ceil(h / 16);
    const macroblocksPerSecond = macroblocks * Math.max(1, rate || 30);

    if (macroblocks <= 8192 && macroblocksPerSecond <= 245760) return '28'; // 4.0, up to 1080p30
    if (macroblocks <= 8704 && macroblocksPerSecond <= 522240) return '2A'; // 4.2, up to 1080p60
    if (macroblocks <= 22080 && macroblocksPerSecond <= 589824) return '32'; // 5.0, covers 1440p30
    if (macroblocks <= 36864 && macroblocksPerSecond <= 983040) return '33'; // 5.1, covers 4K30
    return '34'; // 5.2
  };

  const unique = (values) => values.filter((value, index) => value && values.indexOf(value) === index);
  const h264Level = h264LevelForSize(width, height, fps);
  const codecCandidates = isWebm
    ? unique(['vp09.00.10.08', 'vp8'])
    : unique([
        `avc1.6400${h264Level}`, // High profile at the level required by this render size.
        'avc1.640033', // High 5.1: broadly supported for 4K30 on Chrome/macOS.
        'avc1.640034', // High 5.2: fallback for larger/high-fps exports.
        `avc1.4D00${h264Level}`, // Main profile fallback.
        `avc1.4200${h264Level}`, // Baseline fallback at the same level.
        'avc1.640028', // Legacy 1080p fallback.
        'avc1.42001E',
      ]);

  let encoderError = null;

  const encoder = framesMode ? null : new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      encoderError = e;
    },
  });

  const baseConfig = {
    width,
    height,
    bitrate: Math.round(bitrate || estimateDetailBitrate(width, height, fps, duration)),
    bitrateMode: 'variable',
    framerate: fps,
  };

  // Try the codec/level required for the requested output size, then fall back to
  // nearby profiles. A fixed H.264 level 4.0 string works for 1080p but is rejected
  // by WebCodecs for 1440p/4K because the frame size exceeds that level.
  if (typeof window !== 'undefined') window.__exportPhase = framesMode ? 'Rendering frames' : 'Checking codec';
  let selectedConfig = null;
  const rejectedCodecs = [];

  // One ordered list: each codec is tried with the requested bitrateMode first, then
  // without it (older encoders reject the property outright).
  const { bitrateMode, ...compatBaseConfig } = baseConfig;
  const configQueue = [];
  for (const codec of (framesMode ? [] : codecCandidates)) {
    configQueue.push({ ...baseConfig, codec });
    configQueue.push({ ...compatBaseConfig, codec });
  }
  const configLabel = (c) => c.codec + (c.bitrateMode ? ` bitrateMode=${c.bitrateMode}` : '');

  const tryConfigure = (config) => {
    try {
      encoder.configure(config);
      selectedConfig = config;
      return true;
    } catch (e) {
      rejectedCodecs.push(configLabel(config));
      console.warn('[export-phase] codec configure failed: ' + configLabel(config) + ' ' + (e?.message || e));
      return false;
    }
  };

  // isConfigSupported occasionally never resolves (Windows MediaFoundation encoder
  // enumeration is a known offender). Treating a hung probe as "supported" — what this
  // used to do — configures an encoder the hardware may never accept, and because the
  // loop stops at the first "supported" candidate the working fallbacks below it are
  // never reached; the failure then surfaces hundreds of frames later as an encoder
  // stall. So: two passes. Prefer any candidate that ANSWERS, and only gamble on the
  // timed-out ones if nothing answered at all (that gamble is the old behaviour, kept
  // as the escape hatch for setups where every probe hangs).
  const deferred = [];
  let selectedVia = 'probe';

  for (const config of configQueue) {
    const label = configLabel(config);
    console.warn('[export-phase] checking codec support: ' + label);
    let supported = false;
    let timedOut = false;
    try {
      const support = await Promise.race([
        VideoEncoder.isConfigSupported(config),
        new Promise((resolve) => setTimeout(() => resolve({ __probeTimedOut: true }), 8000)),
      ]);
      timedOut = Boolean(support?.__probeTimedOut);
      supported = !timedOut && Boolean(support?.supported);
    } catch {
      supported = false;
    }
    if (timedOut) {
      // Unknown, not unsupported — keep it as a last-resort candidate.
      deferred.push(config);
      console.warn('[export-phase] codec probe TIMED OUT, deferred: ' + label);
      continue;
    }
    console.warn('[export-phase] codec supported=' + supported + ' codec=' + label);
    if (!supported) {
      rejectedCodecs.push(label);
      continue;
    }
    if (tryConfigure(config)) break;
  }

  if (!selectedConfig && deferred.length) {
    selectedVia = 'deferred (probe timed out)';
    for (const config of deferred) {
      console.warn('[export-phase] no codec probed clean; trying deferred candidate: ' + configLabel(config));
      if (tryConfigure(config)) break;
    }
  }

  if (!selectedConfig && !framesMode) {
    throw new Error(`No supported video codec found for ${isWebm ? 'WebM' : 'MP4'} export at ${width}x${height}. Tried: ${rejectedCodecs.join(', ')}`);
  }

  // Audio goes into the muxer BEFORE the first video frame, and the ordering is
  // not cosmetic. In a fragmented MP4 the muxer interleaves the two tracks: a
  // video sample is only written out once audio has reached that timestamp
  // (mp4-muxer's `videoSample.decodeTimestamp <= audioTrack.lastDecodeTimestamp`),
  // otherwise it is parked in an in-memory queue. Adding all the audio AFTER the
  // frame loop — which is what this used to do — meant audio's timestamp never
  // advanced, so every video sample of the entire render stayed queued in RAM and
  // finalize() tried to write the whole file in a single allocation: ~14GB for a
  // 43-minute 2560x1440 export, i.e. "RangeError: Array buffer allocation failed"
  // at 99%. Feeding audio first inverts it — the queue that fills is the AUDIO
  // one, which is the whole timeline's AAC (tens of MB, bounded) — and each video
  // sample then drains audio up to its own timestamp and gets written straight
  // out, so fragments stream to disk every couple of seconds as they should.
  if (!framesMode) {
    if (typeof window !== 'undefined') window.__exportPhase = 'Mixing audio';
    const preMixedAudio = await mixedAudioPromise;
    if (preMixedAudio) {
      await encodeAudioToMuxer(muxer, preMixedAudio, isWebm, audioBitrate, (n) => { audioPrimingSamples = n; });
      console.warn('[export-phase] audio muxed ahead of video ('
        + (preMixedAudio.totalSamples / AUDIO_SAMPLE_RATE).toFixed(1) + 's)');
    }
  }

  if (typeof window !== 'undefined') window.__exportPhase = framesMode ? 'Rendering frames' : 'Encoder configured';
  console.warn(framesMode
    ? '[export-phase] alpha frames mode (PNG → ffmpeg), entering frame loop'
    : '[export-phase] encoder configured codec=' + selectedConfig.codec
      + ' via=' + selectedVia + ' size=' + width + 'x' + height
      + ' bitrate=' + selectedConfig.bitrate + ', entering frame loop');

  // Per-frame watchdog: in the headless renderer a clip's seek occasionally never
  // resolves, which would hang the whole export (and freeze the progress bar). Cap
  // each frame's render; on timeout, warn (captured in the backend log via the page
  // console) and continue with the current canvas. Bail out if several frames in a
  // row stall — the timeline can't be decoded, so failing fast beats a 15-min hang.
  const FRAME_RENDER_TIMEOUT_MS = 15000;
  // The encoder queue normally drains in well under a second, so 30s of zero
  // drain means the hardware encoder is wedged (seen at high resolutions / very
  // long timelines under memory pressure — e.g. a huge 4K source clip), not just
  // slow. Flushing a full queue can legitimately take longer, so it gets a bigger
  // budget. Without these, a wedged encoder spins the back-pressure loop forever
  // and freezes the progress bar until the server-side render timeout.
  const ENCODER_STALL_MS = 30000;
  const ENCODER_FLUSH_TIMEOUT_MS = 120000;
  // The sink can legitimately be slow (a 16 MiB base64 hop, a busy disk), so this
  // is deliberately generous — it exists to turn a wedged writer into an error
  // instead of an eternal wait, not to police throughput.
  const OUTPUT_STALL_MS = 120000;
  // After a GPU reset the encoder never drains again (30 s of nothing, every time
  // it was seen), so there is no reason to wait out the full stall budget.
  const GPU_RESET_STALL_MS = 5000;
  let stalledFrames = 0;

  const gpuResetBase = gpuResetCount?.() ?? 0;
  let gpuReset = null; // { frame, time, tlTime, lost } — first frame that saw it
  const checkGpuReset = (i, time, tlTime) => {
    if (!gpuResetCount) return;
    const lost = gpuResetCount() - gpuResetBase;
    if (lost <= 0) return;
    if (gpuReset) { gpuReset.lost = lost; return; }
    gpuReset = { frame: i, time, tlTime, lost };
    console.warn(`[export] GPU reset while rendering frame ${i} @ ${tlTime}s — ${lost} GPU context(s) lost`);
  };
  const gpuResetError = () => {
    let detail = null;
    try { detail = describeGpuReset?.(gpuReset.time); } catch { /* diagnosis must never mask the failure */ }
    return new Error(`GPU reset at ${gpuReset.tlTime}s (frame ${gpuReset.frame}): the graphics driver dropped `
      + `${gpuReset.lost} GPU context${gpuReset.lost > 1 ? 's' : ''} and the video encoder stopped with them — `
      + `this part of the timeline needs more GPU than is available. ${detail ? detail + ' ' : ''}`
      + 'Prerender the heaviest layer, lower or turn off motion blur, or render this part as its own time range.');
  };

  // Keyframe every ~2 seconds — ROUNDED to whole frames. `i % (fps * 2)` with a
  // fractional rate is only ever 0 at i=0: at 23.976 the divisor is
  // 47.952047952..., so a 9,408-frame render shipped with exactly ONE sync
  // sample, at t=0. Every 23.976 / 29.97 / 59.94 export was affected, and since
  // renders get dropped back on the timeline as edit sources, the app was
  // manufacturing precisely the files its own seek path cannot handle.
  const keyFrameInterval = Math.max(1, Math.round(fps * 2));

  // CPU pixel capture. VideoFrames built from any GPU-backed source (the WebGL
  // canvas itself, an ImageBitmap of it, even a 2D canvas copy) intermittently
  // encode the WRONG GPU surface in headless Chromium: the hardware encoder ends
  // up sampling the source clip's decoder output instead of the composited frame,
  // silently dropping shapes, clipping masks, text — everything the compositor
  // drew. Reading the pixels into JS memory and building the VideoFrame from the
  // raw buffer forces a real copy the encoder can't alias. Costs one GPU readback
  // per frame; correctness over speed.
  const captureCanvas = typeof document !== 'undefined'
    ? document.createElement('canvas')
    : new OffscreenCanvas(width, height); // worker context (no DOM)
  captureCanvas.width = width;
  captureCanvas.height = height;
  const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });
  // A frame source of another size (a scaled render: the composition is drawn at
  // its own size and resampled to the output here) must not be point-sampled —
  // 'low' aliases 1px strokes on a 2:1 downscale. Same-size frames copy 1:1, so
  // this changes nothing for them.
  if (captureCtx) {
    captureCtx.imageSmoothingEnabled = true;
    captureCtx.imageSmoothingQuality = 'high';
  }

  // Render frame by frame
  for (let i = 0; i < totalFrames; i++) {
    if (signal?.aborted) {
      encoder?.close();
      throw new DOMException('Export cancelled', 'AbortError');
    }

    const time = i / fps;
    // Absolute timeline time for logs/errors (equals `time` for a full render).
    const tlTime = (time + displayTimeOffset).toFixed(2);
    // Granular phase markers for frame 0 (read by the backend phase-poller) so a
    // hang here is pinned to seek vs. capture vs. encode. Other frames just show the
    // steady "Rendering frames" label.
    if (typeof window !== 'undefined') window.__exportPhase = i === 0 ? 'frame0: seeking' : 'Rendering frames';
    if (checkFatal) {
      const fatal = checkFatal();
      if (fatal) {
        encoder?.close();
        throw new Error(`Render stopped at ${tlTime}s — ${fatal}`);
      }
    }
    const mark0 = (s) => { if (i === 0 && typeof window !== 'undefined') window.__exportPhase = s; };
    if (i === 0) console.warn('[export-phase] rendering frame 0 (seeking videos)');

    // Await the render — this seeks all videos and waits for decoded frames.
    const frameBudgetMs = (i === 0 && firstFrameTimeoutMs > FRAME_RENDER_TIMEOUT_MS)
      ? firstFrameTimeoutMs
      : FRAME_RENDER_TIMEOUT_MS;
    let frameTimedOut = false;
    await Promise.race([
      Promise.resolve()
        .then(() => renderFrameAtTime(time))
        .catch((e) => { console.warn(`[export] renderFrameAtTime(${i}) @ ${tlTime}s errored: ${e?.message || e}`); }),
      new Promise((resolve) => setTimeout(() => { frameTimedOut = true; resolve(); }, frameBudgetMs)),
    ]);
    mark0(frameTimedOut ? 'frame0: seek TIMED OUT' : 'frame0: seek ok');
    checkGpuReset(i, time, tlTime);
    if (frameTimedOut) {
      stalledFrames += 1;
      console.warn(`[export] frame ${i} @ ${tlTime}s stalled >${frameBudgetMs}ms (${stalledFrames} in a row)`);
      if (stalledFrames >= 3) {
        encoder?.close();
        if (gpuReset) throw gpuResetError();
        let detail = null;
        try { detail = describeStall?.(); } catch { /* diagnosis must never mask the failure */ }
        throw new Error(detail
          ? `Render stalled near ${tlTime}s — ${detail}`
          : `Render stalled near ${tlTime}s — ${stalledFrames} consecutive frames failed to render in the headless browser. Try re-encoding that clip or rendering in a different format.`);
      }
    } else {
      stalledFrames = 0;
    }


    // Capture frame from canvas or a custom composited source. A custom source is
    // still guarded by a timeout — it may await GPU work that never resolves in a
    // headless browser.
    mark0('frame0: capturing');
    const frameSource = captureFrame
      ? await Promise.race([
        Promise.resolve(captureFrame()),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`Capture stalled at frame ${i} (${tlTime}s): the frame source timed out.`)),
          FRAME_RENDER_TIMEOUT_MS,
        )),
      ])
      : canvas;
    // Handing the source straight to VideoFrame skips a full-frame drawImage +
    // getImageData round trip. Measured on this very canvas: readback 3.03ms ->
    // 0.04ms at 720p (76x) and 5.97ms -> 0.07ms at 1080p (89x), saving ~5.9ms
    // PER FRAME at 1080p. The direct cost is also flat in resolution while the
    // copy path scales with pixel count, so the win grows with output size.
    //
    // The copy path stays for the two cases that need it: frames mode emits its
    // PNGs from the 2D canvas, and a custom captureFrame source of a different
    // size still needs drawImage to scale it (VideoFrame cannot).
    const directEncode = !framesMode && canEncodeDirectly(frameSource, width, height);
    if (i === 0 && typeof window !== 'undefined') {
      // Chosen at runtime from the frame source and the output size, so it is not
      // derivable from the render settings — and it is the first thing to check
      // when output looks wrong rather than merely slow.
      window.__exportCaptureMode = directEncode ? 'direct' : 'cpu';
      console.warn('[export-phase] capture mode: ' + window.__exportCaptureMode
        + (directEncode ? ' (VideoFrame from the canvas)' : ' (CPU pixel readback)'));
    }
    if (!directEncode) {
      captureCtx.clearRect(0, 0, width, height);
      captureCtx.drawImage(frameSource, 0, 0, width, height);
      if (frameSource !== canvas && typeof frameSource.close === 'function') frameSource.close();
    }

    // Frames mode (webm-alpha): hand the RGBA frame to the caller as a PNG and
    // skip everything encoder-related. Awaiting the sink is the back-pressure —
    // it resolves once ffmpeg has taken the bytes.
    if (framesMode) {
      const png = await canvasToPngBytes(captureCanvas);
      mark0('frame0: captured');
      await onFrameImage(png, i);
      mark0('frame0: sent');
      onProgress?.(i / totalFrames, totalFrames);
      continue;
    }

    // useAlpha can only be true in framesMode (a non-frames webm-alpha throws
    // above), so the encoder path is always opaque.
    let frame;
    if (directEncode) {
      frame = new VideoFrame(frameSource, {
        timestamp: i * frameDuration,
        duration: frameDuration,
        alpha: 'discard',
      });
      // Constructing the VideoFrame copies, so the source can be released now.
      if (frameSource !== canvas && typeof frameSource.close === 'function') frameSource.close();
    } else {
      const pixels = captureCtx.getImageData(0, 0, width, height);
      frame = new VideoFrame(pixels.data, {
        format: useAlpha ? 'RGBA' : 'RGBX',
        codedWidth: width,
        codedHeight: height,
        timestamp: i * frameDuration,
        duration: frameDuration,
      });
    }
    mark0('frame0: captured');

    const keyFrame = i % keyFrameInterval === 0;
    encoder.encode(frame, { keyFrame });
    frame.close();
    mark0('frame0: encoded');

    // Back-pressure: if the encoder queue builds up, wait for it to drain. Bail
    // out if the encoder errored or stops draining entirely for ENCODER_STALL_MS
    // (a wedged hardware encoder) — failing fast with a clear message beats
    // spinning here silently until the render times out minutes later.
    let lastQueueSize = encoder.encodeQueueSize;
    let lastDrainAt = Date.now();
    while (encoder.encodeQueueSize > 5) {
      if (encoderError) throw encoderError;
      checkGpuReset(i, time, tlTime);
      if (encoder.encodeQueueSize < lastQueueSize) {
        lastQueueSize = encoder.encodeQueueSize;
        lastDrainAt = Date.now();
      } else if (Date.now() - lastDrainAt > (gpuReset ? GPU_RESET_STALL_MS : ENCODER_STALL_MS)) {
        try { encoder.close(); } catch { /* encoder already in an error state */ }
        if (gpuReset) throw gpuResetError();
        throw new Error(`Encoder stalled at frame ${i} (${tlTime}s): the video encoder stopped draining at ${width}x${height} — likely out of GPU/memory. Try a lower export resolution, or re-encode/downscale oversized source clips (a very large 4K clip can wedge the encoder).`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    // Output back-pressure. The encoder gate above only bounds frames waiting to
    // be ENCODED; nothing bounded the muxed bytes waiting to be WRITTEN, so the
    // render banked the difference between produce and drain rate in memory for
    // its whole length. Park here instead: the render then runs at the speed of
    // its slowest stage, which is the honest speed.
    if (streaming && queuedOutputBudget > 0 && queuedBytes > queuedOutputBudget) {
      let lastWritten = writtenBytes;
      let lastProgressAt = Date.now();
      while (queuedBytes > queuedOutputBudget) {
        if (signal?.aborted) { encoder?.close(); throw new DOMException('Export cancelled', 'AbortError'); }
        if (encoderError) throw encoderError;
        if (writtenBytes > lastWritten) {
          lastWritten = writtenBytes;
          lastProgressAt = Date.now();
        } else if (Date.now() - lastProgressAt > OUTPUT_STALL_MS) {
          try { encoder.close(); } catch { /* already errored */ }
          throw new Error(`Output stalled at frame ${i} (${tlTime}s): ${(queuedBytes / 1e6).toFixed(0)} MB of rendered video has been waiting ${Math.round(OUTPUT_STALL_MS / 1000)}s to be written. The render is producing faster than the destination can accept — check free disk space on the output volume.`);
        }
        if (typeof window !== 'undefined') {
          window.__exportPhase = `Writing output (${(writtenBytes / 1e6).toFixed(0)} of ${(producedBytes / 1e6).toFixed(0)} MB)`;
        }
        await new Promise((resolve) => {
          drainWake = resolve;
          setTimeout(() => { if (drainWake === resolve) { drainWake = null; resolve(); } }, 250);
        });
      }
      if (typeof window !== 'undefined') window.__exportPhase = 'Rendering frames';
    }

    // Report progress
    onProgress?.(i / totalFrames, totalFrames);

    if (encoderError) throw encoderError;
  }

  // Frames mode: every frame is out; ship the mixed audio as a WAV so ffmpeg can
  // mux it alongside the VP9-alpha video, then we're done (no muxer here).
  if (framesMode) {
    if (typeof window !== 'undefined') window.__exportPhase = 'Mixing audio';
    const mixedAudio = await mixedAudioPromise;
    if (mixedAudio && typeof onAudioData === 'function') {
      await onAudioData(encodeWavFloat32(mixedAudio));
    }
    if (typeof window !== 'undefined') window.__exportPhase = 'Encoding alpha video';
    onProgress?.(1, totalFrames);
    return { framesMode: true, frames: totalFrames, mime: 'video/webm' };
  }

  // Flush the video encoder. Guarded — a wedged encoder can hang flush() forever,
  // which would otherwise freeze the export near 100% with no recourse.
  const lastFrame = totalFrames - 1;
  const recheckGpuReset = () => checkGpuReset(lastFrame, lastFrame / fps, (lastFrame / fps + displayTimeOffset).toFixed(2));
  recheckGpuReset();
  let flushTimer = null;
  try {
    await Promise.race([
      encoder.flush(),
      new Promise((_, reject) => {
        flushTimer = setTimeout(() => {
          recheckGpuReset();
          reject(gpuReset
            ? gpuResetError()
            : new Error(`Encoder flush stalled at ${width}x${height} — the video encoder stopped responding, likely out of GPU/memory. Try a lower export resolution.`));
        }, gpuReset ? GPU_RESET_STALL_MS : ENCODER_FLUSH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(flushTimer);
  }
  encoder.close();

  // Audio was already muxed, ahead of the first frame — see the comment there.

  // Finalize muxer
  muxer.finalize();
  primingPatcher?.finish();

  // A render that lost a clip's sound is still a finished file, so the only way
  // the user learns about it is if we say so. Carried out with the result.
  const audioWarning = droppedAudioUrls.length
    ? `${droppedAudioUrls.length} clip${droppedAudioUrls.length > 1 ? 's' : ''} exported without audio: `
      + droppedAudioUrls.map((u) => u.split('/').pop()).join(', ')
    : null;
  if (audioWarning) console.error('[export] ' + audioWarning);

  const mimeType = isWebm ? 'video/webm' : 'video/mp4';
  if (streaming) {
    // Drain any remaining queued chunks, then signal completion. This is its own
    // PHASE, not a silent tail: measured at 5.96s on a 25-second timeline, it
    // scales with output size and ran for minutes on a 392-second 4K render —
    // indistinguishable from a hang, at what the progress bar showed as 91%.
    muxFinished = true;
    if (pumpWake) { pumpWake(); pumpWake = null; }
    const drainStart = Date.now();
    const drainTotal = producedBytes;
    const reportDrain = () => {
      if (typeof window === 'undefined') return;
      const doneMb = (writtenBytes / 1e6).toFixed(0);
      const totalMb = (drainTotal / 1e6).toFixed(0);
      window.__exportPhase = `Writing output (${doneMb} of ${totalMb} MB)`;
    };
    reportDrain();
    const drainTicker = setInterval(reportDrain, 500);
    try {
      await pump;
    } finally {
      clearInterval(drainTicker);
    }
    console.warn(`[export-phase] output drained: ${(writtenBytes / 1e6).toFixed(1)} MB in `
      + `${((Date.now() - drainStart) / 1000).toFixed(1)}s (${(producedBytes / 1e6).toFixed(1)} MB produced, `
      + `queue budget ${(queuedOutputBudget / 1e6).toFixed(0)} MB)`);
    if (typeof window !== 'undefined') window.__exportPhase = 'Finishing file';
    onProgress?.(1, totalFrames);
    return { streamed: true, mime: mimeType, audioWarning };
  }

  const bytes = !isWebm && audioPrimingSamples > 0 ? insertAudioEditList(target.buffer, audioPrimingSamples) : target.buffer;
  const blob = new Blob([bytes], { type: mimeType });
  onProgress?.(1, totalFrames);
  return { blob, audioWarning };
}

/**
 * Check if WebCodecs-based export is available in this browser.
 */
export function isWebCodecsSupported() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}
