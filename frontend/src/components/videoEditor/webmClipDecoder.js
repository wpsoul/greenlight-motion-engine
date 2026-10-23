// Frame-exact WebM decode for export (VP8 / VP9, with or without an alpha plane) —
// the WebM counterpart of ClipSource + ClipDecoder (webcodecsClipDecoder.js).
//
// WHY THIS EXISTS. The export used to read WebM through WebmFrameCache, which PLAYS
// the clip in real time and keeps whatever requestVideoFrameCallback reports. That
// callback runs on the main thread, once per rendering opportunity, and reports only
// the newest presented frame: while the exporter holds the main thread (one frame's
// render, or 16 of them for a motion-blurred frame) the video keeps playing and the
// frames it presented in between are never seen. drawFrameAt then serves the newest
// frame it DID see — 1 to 5 frames old, measured on V2.8's burst cut-out (VP9 alpha)
// — so a cut-out drifted off the plate it was cut from, and froze for a few frames
// before jumping. Motion blur made it common (the main thread is blocked 16x longer
// per frame); without blur it still happened now and then.
//
// Here the file is demuxed once (a small EBML/Matroska reader below) and decoded
// with WebCodecs exactly like an MP4: every requested time gets the frame whose
// interval holds it, however long the render takes. The alpha plane rides in each
// block's BlockAdditional (BlockAddID 1) as a second VP8/VP9 stream; it gets its own
// decoder, and its luma becomes the colour frame's alpha — what Chrome's <video>
// does internally, so the preview and the export read the same pixels.
//
// Anything this reader does not handle (laced blocks, content encodings, other
// codecs, a file the browser cannot decode) makes WebmSource.init() return false and
// the exporter keeps using WebmFrameCache, as before.

import { ClipDecoder, ClipSource, FRAME_PICK_SLACK_US } from './webcodecsClipDecoder';
import { demuxWebm } from './webmDemux';

// Memory ceiling: the whole file is held while the export runs (as ClipSource holds
// an MP4's samples). Alpha overlays are short; a WebM above this keeps the old path.
const MAX_WEBM_BYTES = 600e6;

// What a VP9 keyframe's uncompressed header says about the stream: profile and bit
// depth (for the codec string WebCodecs wants, vp09.PP.LL.DD) and its color_space
// field (0 = unknown, 1 = BT.601, 2 = BT.709, 3 = SMPTE 170, 4 = SMPTE 240,
// 5 = BT.2020, 7 = RGB).
function vp9Header(keyData) {
  const out = { profile: 0, depth: 8, colorSpace: null };
  if (!keyData || keyData.length < 6) return out;
  let bit = 0;
  const read = (n) => {
    let v = 0;
    for (let i = 0; i < n; i += 1) {
      const byte = keyData[bit >> 3];
      v = (v << 1) | ((byte >> (7 - (bit & 7))) & 1);
      bit += 1;
    }
    return v;
  };
  read(2); // frame_marker
  const lo = read(1);
  const hi = read(1);
  out.profile = (hi << 1) | lo;
  if (out.profile === 3) read(1);
  if (read(1)) return out; // show_existing_frame
  if (read(1)) return out; // frame_type: not a keyframe
  read(1); read(1); // show_frame, error_resilient_mode
  read(24); // sync code
  if (out.profile >= 2) out.depth = read(1) ? 12 : 10;
  out.colorSpace = read(3);
  return out;
}

// The colour space Chrome's <video> converts this stream with, for the decoder
// config. WebCodecs labels an untagged VP9 frame BT.709 while <video> reads it as
// BT.601 — measured: the burst cut-out, the bulb and the crest all came out 1-5
// levels off (green -4.7 on the bulb) until the frames carried BT.601 too. The
// container's Colour element wins, then the VP9 header; untagged (and VP8, which
// has no colour signalling) is BT.601. null = leave what the bitstream says.
const MATRIX = { 0: 'rgb', 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020-ncl' };
const PRIMARIES = { 1: 'bt709', 5: 'bt470bg', 6: 'smpte170m', 9: 'bt2020', 12: 'smpte432' };
const TRANSFER = { 1: 'bt709', 6: 'smpte170m', 8: 'linear', 13: 'iec61966-2-1', 16: 'pq', 18: 'hlg' };
const REC601 = { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false };
function streamColorSpace(codecId, colour, header) {
  if (colour && MATRIX[colour.matrix]) {
    return {
      matrix: MATRIX[colour.matrix],
      primaries: PRIMARIES[colour.primaries] || (colour.matrix === 1 ? 'bt709' : 'smpte170m'),
      transfer: TRANSFER[colour.transfer] || (colour.matrix === 1 ? 'bt709' : 'smpte170m'),
      fullRange: colour.range === 2,
    };
  }
  if (codecId === 'V_VP8') return REC601;
  if (header.colorSpace === 0 || header.colorSpace === 1 || header.colorSpace === 3) return REC601;
  return null;
}

async function supportedConfig(codecId, sample, width, height, colorSpace = null) {
  const header = codecId === 'V_VP9' ? vp9Header(sample?.data) : null;
  const candidates = codecId === 'V_VP8'
    ? ['vp8']
    : ['10', '21', '31', '41', '51', '62'].map((lv) => `vp09.0${header.profile}.${lv}.${header.depth === 8 ? '08' : String(header.depth)}`);
  // Software first: Chrome's <video> decodes alpha VP9 with libvpx too, and a CPU
  // frame is what VideoFrame.copyTo needs for the alpha plane.
  for (const hardwareAcceleration of ['prefer-software', 'no-preference']) {
    for (const codec of candidates) {
      const config = { codec, codedWidth: width, codedHeight: height, hardwareAcceleration };
      if (colorSpace) config.colorSpace = colorSpace;
      try {
        const support = await VideoDecoder.isConfigSupported(config);
        if (support?.supported) return config;
      } catch { /* try the next one */ }
    }
  }
  return null;
}

// The ClipSource contract ClipDecoder reads: url, ready, width, height, rotation,
// samples ({ type, ts, dur, data, isKey }), keyIndices, config, keyIndexFor().
class StreamSource {
  constructor(url, samples, config, width, height) {
    this.url = url;
    this.ready = true;
    this.width = width;
    this.height = height;
    this.rotation = 0;
    this.config = config;
    this.samples = samples.map((s) => ({ type: s.key ? 'key' : 'delta', ts: s.ts, dur: s.dur, data: s.data, isKey: s.key }));
    this.keyIndices = [];
    for (let i = 0; i < this.samples.length; i += 1) if (this.samples[i].isKey) this.keyIndices.push(i);
    if (!this.keyIndices.length || this.keyIndices[0] !== 0) this.keyIndices.unshift(0);
  }
}
StreamSource.prototype.keyIndexFor = ClipSource.prototype.keyIndexFor;

export class WebmSource {
  constructor(url) {
    this.url = url;
    this.ready = false;
    this.failed = false;
    this.error = null;
    this.errorKind = null;
    this.width = 0;
    this.height = 0;
    this.color = null; // StreamSource
    this.alpha = null; // StreamSource | null
  }

  async init(signal = null) {
    const name = (this.url || '').split('/').pop().split('?')[0];
    const fail = (kind, message) => {
      this.failed = true;
      this.errorKind = kind;
      this.error = message;
      return false;
    };
    try {
      if (typeof VideoDecoder === 'undefined') return fail('config', 'no WebCodecs');
      const size = await ClipSource.probeSize(this.url, signal);
      if (size > MAX_WEBM_BYTES) return fail('too_large', `${(size / 1e6).toFixed(0)} MB`);
      const resp = await fetch(this.url, { cache: 'no-store', signal });
      if (!resp.ok) return fail('fetch', 'fetch ' + resp.status);
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > MAX_WEBM_BYTES) return fail('too_large', `${(buf.byteLength / 1e6).toFixed(0)} MB`);
      let demuxed;
      try {
        demuxed = demuxWebm(buf);
      } catch (e) {
        return fail('demux', e?.message || String(e));
      }
      const { codecId, color, alpha } = demuxed;
      this.width = demuxed.width;
      this.height = demuxed.height;
      const firstKey = color.find((s) => s.key) || color[0];
      const colorSpace = streamColorSpace(codecId, demuxed.colour,
        codecId === 'V_VP9' ? vp9Header(firstKey?.data) : {});
      const config = await supportedConfig(codecId, firstKey, this.width, this.height, colorSpace);
      if (!config) return fail('config', `VideoDecoder cannot decode ${codecId}`);
      this.color = new StreamSource(this.url, color, config, this.width, this.height);
      if (alpha) {
        const alphaKey = alpha.find((s) => s.key) || alpha[0];
        const alphaConfig = await supportedConfig(codecId, alphaKey, this.width, this.height);
        if (!alphaConfig) return fail('config', `VideoDecoder cannot decode the alpha of ${codecId}`);
        this.alpha = new StreamSource(this.url, alpha, alphaConfig, this.width, this.height);
      }
      this.ready = true;
      console.warn(`[export] WebmSource ready ${name}: ${(buf.byteLength / 1e6).toFixed(1)} MB, `
        + `${this.width}x${this.height} ${config.codec}${this.alpha ? ' + alpha' : ''}`
        + `${config.colorSpace ? ` (${config.colorSpace.matrix})` : ''}, `
        + `${color.length} frames, ${this.color.keyIndices.length} sync — frame-exact decode`);
      return true;
    } catch (e) {
      return fail(/cancel|abort/i.test(e?.message || '') ? 'cancelled' : 'fetch', e?.message || String(e));
    }
  }
}

/**
 * One consumer's decoder for a WebmSource — the ClipDecoder API: drawFrameAt(sec)
 * draws the frame for that clip-local time onto `canvas` (with its alpha) and
 * returns true when a frame was drawn.
 */
export class WebmClipDecoder {
  constructor(source) {
    this.source = source;
    this.url = source.url;
    this.ready = source.ready;
    this.width = source.width;
    this.height = source.height;
    this.error = null;
    this.color = new ClipDecoder(source.color);
    this._alphaFrame = null;
    this.alpha = source.alpha
      ? new ClipDecoder(source.alpha, { drawFrame: (frame) => { this._alphaFrame = frame; } })
      : null;
    this.canvas = this.alpha
      ? (typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(this.width, this.height))
      : this.color.canvas;
    if (this.alpha) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      this.ctx = this.canvas.getContext('2d');
    }
    this._mask = null;
    this._maskCtx = null;
    this._maskImage = null;
    this._composedUs = null;
    this.drawnTimestampUs = null;
  }

  async drawFrameAt(targetSec) {
    if (!this.ready) return false;
    const [drew] = await Promise.all([
      this.color.drawFrameAt(targetSec),
      this.alpha ? this.alpha.drawFrameAt(targetSec) : Promise.resolve(true),
    ]);
    this.error = this.color.error || this.alpha?.error || null;
    this.drawnTimestampUs = this.color.drawnTimestampUs;
    if (!drew || !this.alpha) return drew;
    const ts = this.color.drawnTimestampUs;
    // Motion blur asks for the same frame up to 16 times: compose it once.
    if (ts === this._composedUs) return true;
    const alphaFrame = this._alphaFrame;
    if (!alphaFrame || Math.abs(alphaFrame.timestamp - ts) > FRAME_PICK_SLACK_US) {
      // Never expected (both streams share every timestamp): draw it opaque rather
      // than with another frame's matte.
      this.ctx.clearRect(0, 0, this.width, this.height);
      this.ctx.drawImage(this.color.canvas, 0, 0, this.width, this.height);
      this._composedUs = null;
      return true;
    }
    await this._applyAlpha(alphaFrame);
    this._composedUs = ts;
    return true;
  }

  // The alpha stream's luma IS the alpha (full range, as Chrome's <video> reads it):
  // copy the Y plane out raw — drawImage would run it through a YUV->RGB matrix.
  async _applyAlpha(frame) {
    const w = frame.visibleRect?.width || frame.codedWidth;
    const h = frame.visibleRect?.height || frame.codedHeight;
    if (!this._mask || this._mask.width !== w || this._mask.height !== h) {
      this._mask = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(w, h);
      this._mask.width = w;
      this._mask.height = h;
      this._maskCtx = this._mask.getContext('2d');
      this._maskImage = this._maskCtx.createImageData(w, h);
      this._planes = new Uint8Array(frame.allocationSize());
    }
    if (this._planes.length < frame.allocationSize()) this._planes = new Uint8Array(frame.allocationSize());
    const layout = await frame.copyTo(this._planes);
    const { offset, stride } = layout[0];
    const px = this._maskImage.data;
    const y = this._planes;
    for (let row = 0; row < h; row += 1) {
      let src = offset + row * stride;
      let dst = row * w * 4 + 3;
      for (let col = 0; col < w; col += 1, src += 1, dst += 4) px[dst] = y[src];
    }
    this._maskCtx.putImageData(this._maskImage, 0, 0);
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(this.color.canvas, 0, 0, this.width, this.height);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this._mask, 0, 0, this.width, this.height);
    ctx.restore();
  }

  close() {
    try { this.color.close(); } catch { /* ignore */ }
    try { this.alpha?.close(); } catch { /* ignore */ }
    this._alphaFrame = null;
  }
}
