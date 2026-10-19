/*
 * AAC priming in exported MP4s.
 *
 * An AAC encoder puts a few thousand samples of its own start-up ("priming") before the first real
 * sample — Chromium's on macOS 2112 samples, 44 ms at 48 kHz. mp4-muxer writes no edit list, so every
 * player played that priming as part of the track and every exported video's sound came 44 ms late
 * (measured on a click: 5.555 s in the project, 5.599 s in the file). The standard cure is an edit
 * list on the audio track — `edts/elst` with media_time = the priming — which tells players (QuickTime,
 * Chromium, ffmpeg, Premiere…) to start the track that many samples in. Nothing is cut or moved.
 *
 *   measureEncoderDelay(config)            the encoder's priming on THIS machine (encode a click, decode
 *                                          it, see where it lands; cached per config) — platforms differ
 *   insertAudioEditList(bytes, priming)    an in-memory MP4 (moov before mdat): edts in the audio trak,
 *                                          box sizes and every chunk offset (stco/co64) shifted to match
 *   createPrimingStreamPatcher(…)          the same for a fragmented MP4 streamed in pieces: the moov in the
 *                                          first piece gets the edts, later pieces move by its size, and the
 *                                          closing mfra's absolute moof offsets are corrected
 */

const EDTS_SIZE = 36;   // edts header 8 + elst (full box 12 + entry_count 4 + one v0 entry 12)
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'moof', 'traf', 'mfra', 'dinf']);

// ── encoder delay ───────────────────────────────────────────────────────────────────────────────

const delayCache = new Map();

/** Samples of priming this platform's AudioEncoder puts before the signal, or 0 when it can't be measured. */
export function measureEncoderDelay({ codec, sampleRate, numberOfChannels, bitrate }) {
  const key = `${codec}|${sampleRate}|${numberOfChannels}|${bitrate}`;
  if (!delayCache.has(key)) delayCache.set(key, measure({ codec, sampleRate, numberOfChannels, bitrate }).catch(() => 0));
  return delayCache.get(key);
}

async function measure({ codec, sampleRate, numberOfChannels, bitrate }) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined' || typeof AudioData === 'undefined') return 0;
  const total = 16384;
  const at = 6144;   // the click, well clear of both ends
  const chunks = [];
  let decoderConfig = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => { chunks.push(chunk); if (meta?.decoderConfig) decoderConfig = meta.decoderConfig; },
    error: () => {},
  });
  encoder.configure({ codec, sampleRate, numberOfChannels, bitrate });
  for (let offset = 0; offset < total; offset += 1024) {
    const planar = new Float32Array(1024 * numberOfChannels);
    for (let c = 0; c < numberOfChannels; c += 1) {
      for (let i = 0; i < 1024; i += 1) {
        const n = offset + i;
        // a 6-sample click: sharp enough to find, not a lone sample the codec smears away
        if (n >= at && n < at + 6) planar[c * 1024 + i] = 0.9 * (n % 2 ? -1 : 1);
      }
    }
    const data = new AudioData({
      format: 'f32-planar', sampleRate, numberOfFrames: 1024, numberOfChannels,
      timestamp: Math.round((offset / sampleRate) * 1e6), data: planar,
    });
    encoder.encode(data);
    data.close();
  }
  await encoder.flush();
  encoder.close();
  if (!decoderConfig || !chunks.length) return 0;

  const decoded = [];
  const decoder = new AudioDecoder({
    output: (data) => {
      const ch = new Float32Array(data.numberOfFrames);
      data.copyTo(ch, { planeIndex: 0, format: 'f32-planar' });
      decoded.push(ch);
      data.close();
    },
    error: () => {},
  });
  decoder.configure(decoderConfig);
  for (const chunk of chunks) decoder.decode(chunk);
  await decoder.flush();
  decoder.close();
  const flat = new Float32Array(decoded.reduce((n, d) => n + d.length, 0));
  let o = 0;
  for (const d of decoded) { flat.set(d, o); o += d.length; }
  let peak = 0;
  let where = -1;
  for (let i = 0; i < flat.length; i += 1) if (Math.abs(flat[i]) > peak) { peak = Math.abs(flat[i]); where = i; }
  const delay = where - at;
  if (peak < 0.05 || delay < 0 || delay > 4096) return 0;
  // the click spans a few samples: snap to the common encoder delays when that close
  for (const known of [2112, 2048, 1600, 1024, 0]) if (Math.abs(delay - known) <= 4) return known;
  return delay;
}

// ── box helpers ─────────────────────────────────────────────────────────────────────────────────

const typeAt = (b, o) => String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);

function boxAt(view, o, end) {
  let size = view.getUint32(o);
  let header = 8;
  if (size === 1) { size = Number(view.getBigUint64(o + 8)); header = 16; } else if (size === 0) size = end - o;
  return { start: o, size, header, end: o + size, type: typeAt(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), o) };
}

function children(view, box) {
  const out = [];
  let o = box.start + box.header;
  while (o + 8 <= box.end) {
    const b = boxAt(view, o, box.end);
    if (b.size < 8) break;
    out.push(b);
    o = b.end;
  }
  return out;
}

function topLevel(view, from = 0, to = view.byteLength) {
  const out = [];
  let o = from;
  while (o + 8 <= to) {
    const b = boxAt(view, o, to);
    if (b.size < 8 || b.end > to) { out.push({ ...b, partial: true }); break; }
    out.push(b);
    o = b.end;
  }
  return out;
}

const find = (view, box, type) => children(view, box).find((b) => b.type === type) || null;

function audioTrak(view, moov) {
  for (const trak of children(view, moov).filter((b) => b.type === 'trak')) {
    const mdia = find(view, trak, 'mdia');
    const hdlr = mdia && find(view, mdia, 'hdlr');
    if (hdlr && typeAt(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), hdlr.start + hdlr.header + 4) === 'soun') return { trak, mdia };
  }
  return null;
}

// version/timescale/duration of an mvhd or mdhd (same layout up to duration)
function timescaleOf(view, box) {
  const v = view.getUint8(box.start + box.header);
  const base = box.start + box.header + 4;
  return v === 1
    ? { v, timescale: view.getUint32(base + 16), duration: Number(view.getBigUint64(base + 20)), durationAt: base + 20 }
    : { v, timescale: view.getUint32(base + 8), duration: view.getUint32(base + 12), durationAt: base + 12 };
}

function edtsBox(segmentDuration, mediaTime) {
  const b = new Uint8Array(EDTS_SIZE);
  const v = new DataView(b.buffer);
  v.setUint32(0, EDTS_SIZE); b.set([0x65, 0x64, 0x74, 0x73], 4);            // 'edts'
  v.setUint32(8, EDTS_SIZE - 8); b.set([0x65, 0x6c, 0x73, 0x74], 12);       // 'elst'
  v.setUint32(16, 0);                                                        // version 0, flags 0
  v.setUint32(20, 1);                                                        // one entry
  v.setUint32(24, Math.max(0, Math.round(segmentDuration)));                 // segment duration (movie timescale)
  v.setInt32(28, Math.round(mediaTime));                                     // media time (track timescale)
  v.setUint16(32, 1); v.setUint16(34, 0);                                    // rate 1.0
  return b;
}

// Insert the edts into the audio trak of the moov that starts at `moov` in `bytes` (fully contained).
// Returns the new moov bytes, or null when there is no audio track.
function patchMoov(bytes, moovStart, primingSamples, { fragmented }) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = boxAt(view, moovStart, bytes.byteLength);
  const found = audioTrak(view, moov);
  if (!found || find(view, found.trak, 'edts')) return null;
  const mvhd = timescaleOf(view, find(view, moov, 'mvhd'));
  const mdhd = timescaleOf(view, find(view, found.mdia, 'mdhd'));
  const tkhd = find(view, found.trak, 'tkhd');
  // the audio a player should play: the track minus its priming, in the movie timescale (0 = all of it, for
  // a fragmented file whose length lives in its fragments)
  const playable = fragmented ? 0 : Math.max(0, mdhd.duration - primingSamples) * (mvhd.timescale / mdhd.timescale);
  // mp4-muxer's audio timescale is the sample rate, so the priming in samples IS the media time
  const edts = edtsBox(playable, primingSamples);
  const out = new Uint8Array(moov.size + EDTS_SIZE);
  const rel = (abs) => abs - moov.start;
  out.set(bytes.subarray(moov.start, tkhd.end), 0);
  out.set(edts, rel(tkhd.end));
  out.set(bytes.subarray(tkhd.end, moov.end), rel(tkhd.end) + EDTS_SIZE);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, moov.size + EDTS_SIZE);                                    // moov (mp4-muxer writes 32-bit sizes)
  ov.setUint32(rel(found.trak.start), found.trak.size + EDTS_SIZE);         // trak
  if (!fragmented) {
    // the track's (and, if it was the longest, the movie's) duration is what the edit plays
    const tv = view.getUint8(tkhd.start + tkhd.header);
    const tkDurAt = tkhd.start + tkhd.header + 4 + (tv === 1 ? 24 : 16);
    if (tv === 1) ov.setBigUint64(rel(tkDurAt), BigInt(Math.round(playable)));
    else ov.setUint32(rel(tkDurAt), Math.round(playable));
    let longest = Math.round(playable);
    for (const trak of children(view, moov).filter((b) => b.type === 'trak' && b.start !== found.trak.start)) {
      const t = find(view, trak, 'tkhd');
      const v = view.getUint8(t.start + t.header);
      const at = t.start + t.header + 4 + (v === 1 ? 24 : 16);
      longest = Math.max(longest, v === 1 ? Number(view.getBigUint64(at)) : view.getUint32(at));
    }
    const mvDurAt = rel(mvhd.durationAt);
    if (mvhd.v === 1) ov.setBigUint64(mvDurAt, BigInt(longest)); else ov.setUint32(mvDurAt, longest);
  }
  return out;
}

// Add `delta` to every chunk offset of every track (stco / co64) inside the moov `out`.
function shiftChunkOffsets(moovBytes, delta) {
  const view = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  const moov = boxAt(view, 0, moovBytes.byteLength);
  for (const trak of children(view, moov).filter((b) => b.type === 'trak')) {
    const stbl = [find(view, trak, 'mdia')].map((m) => m && find(view, m, 'minf')).map((m) => m && find(view, m, 'stbl'))[0];
    if (!stbl) continue;
    for (const b of children(view, stbl)) {
      if (b.type !== 'stco' && b.type !== 'co64') continue;
      const n = view.getUint32(b.start + b.header + 4);
      let o = b.start + b.header + 8;
      for (let i = 0; i < n; i += 1) {
        if (b.type === 'stco') { view.setUint32(o, view.getUint32(o) + delta); o += 4; }
        else { view.setBigUint64(o, view.getBigUint64(o) + BigInt(delta)); o += 8; }
      }
    }
  }
}

/** An in-memory MP4 (ftyp, moov, mdat …) with the audio priming skipped by an edit list. Input untouched. */
export function insertAudioEditList(input, primingSamples) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!(primingSamples > 0)) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = topLevel(view);
  const moov = top.find((b) => b.type === 'moov' && !b.partial);
  if (!moov || top.some((b) => b.type === 'moof')) return bytes;   // not the in-memory layout
  const patched = patchMoov(bytes, moov.start, primingSamples, { fragmented: false });
  if (!patched) return bytes;
  // media that comes after the moov moves by the edts' size
  if (top.some((b) => b.type === 'mdat' && b.start > moov.start)) shiftChunkOffsets(patched, EDTS_SIZE);
  const out = new Uint8Array(bytes.byteLength + EDTS_SIZE);
  out.set(bytes.subarray(0, moov.start), 0);
  out.set(patched, moov.start);
  out.set(bytes.subarray(moov.end), moov.start + patched.byteLength);
  return out;
}

/**
 * For a fragmented MP4 written in sequential pieces: push(piece) each one in order, finish() after the muxer
 * has finalized. Pieces come back through `emit` — the first (which holds ftyp + moov) with the edts, the
 * last two held back until finish() so the closing mfra's absolute moof offsets can be corrected.
 * `primingSamples()` is read when the moov goes by (the audio is encoded before the first fragment).
 */
export function createPrimingStreamPatcher(primingSamples, emit) {
  let delta = 0;
  let first = true;
  const held = [];
  const release = (keep) => { while (held.length > keep) emit(held.shift()); };
  return {
    push(piece) {
      let out = piece;
      if (first) {
        first = false;
        const priming = primingSamples();
        if (priming > 0) {
          const view = new DataView(piece.buffer, piece.byteOffset, piece.byteLength);
          const moov = topLevel(view).find((b) => b.type === 'moov');
          if (moov && !moov.partial) {
            const patched = patchMoov(piece, moov.start, priming, { fragmented: true });
            if (patched) {
              out = new Uint8Array(piece.byteLength + EDTS_SIZE);
              out.set(piece.subarray(0, moov.start), 0);
              out.set(patched, moov.start);
              out.set(piece.subarray(moov.end), moov.start + patched.byteLength);
              delta = EDTS_SIZE;
            }
          }
        }
      }
      held.push(out);
      release(2);
    },
    finish() {
      if (delta && held.length) {
        const total = held.reduce((n, p) => n + p.byteLength, 0);
        const tail = new Uint8Array(total);
        let o = 0;
        for (const p of held) { tail.set(p, o); o += p.byteLength; }
        const view = new DataView(tail.buffer);
        // mfro (last 16 bytes) holds the mfra's size
        if (total >= 16 && typeAt(tail, total - 16) === 'mfro') {
          const mfraSize = view.getUint32(total - 4);
          const start = total - mfraSize;
          if (start >= 0 && typeAt(tail, start) === 'mfra') {
            const mfra = boxAt(view, start, total);
            for (const tfra of children(view, mfra).filter((b) => b.type === 'tfra')) {
              const v = view.getUint8(tfra.start + tfra.header);
              const sizes = view.getUint32(tfra.start + tfra.header + 8);
              const extra = (((sizes >> 4) & 3) + 1) + (((sizes >> 2) & 3) + 1) + ((sizes & 3) + 1);
              const n = view.getUint32(tfra.start + tfra.header + 12);
              let p = tfra.start + tfra.header + 16;
              for (let i = 0; i < n; i += 1) {
                if (v === 1) { p += 8; view.setBigUint64(p, view.getBigUint64(p) + BigInt(delta)); p += 8; }
                else { p += 4; view.setUint32(p, view.getUint32(p) + delta); p += 4; }
                p += extra;
              }
            }
          }
        }
        held.length = 0;
        held.push(tail);
      }
      release(0);
    },
  };
}
