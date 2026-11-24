// Deterministic audio-reactive clock envelopes for World3D scenes & sims.
// Pure, worker-free ESM so node --test, the isolate worker, Live Editor,
// MotionEngine3D, and headless /video-render evaluate identical curves at any t.
// Nothing here runs on import: a scene with no audio clock pays for none of it.

export const AUDIO_BANDS = Object.freeze({
  full: [20, 20000],
  sub: [20, 60],
  bass: [60, 250],
  lowMid: [250, 500],
  mid: [500, 2000],
  highMid: [2000, 6000],
  treble: [6000, 20000],
  // (lipsync) a voice: its vowels and loud consonants, what a jaw follows
  speech: [150, 3000],
});

export const AUDIO_MODES = Object.freeze(['rms', 'peak', 'flux', 'onset']);

const FFT_SIZE = 1024;
let hann = null;
const hannWindow = () => {
  if (hann) return hann;
  hann = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i += 1) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  return hann;
};

/** Parse RIFF/WAVE (8/16/24-bit PCM or 32-bit IEEE float, mono or multi-channel) to mono Float32Array. */
export function parseWavPcm(buffer) {
  const ab = buffer instanceof ArrayBuffer ? buffer : buffer?.buffer?.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  if (!(ab instanceof ArrayBuffer) || ab.byteLength < 12) throw new Error('Audio WAV buffer is invalid or too short');
  const view = new DataView(ab);
  if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
    throw new Error('Not a RIFF/WAVE buffer');
  }
  let offset = 12;
  let formatTag = 0;
  let channels = 1;
  let sampleRate = 0;
  let bitsPerSample = 16;
  let dataStart = -1;
  let dataLen = 0;
  while (offset + 8 <= view.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    if (id === 0x666d7420 && size >= 16 && offset + 8 + size <= view.byteLength) { // 'fmt '
      formatTag = view.getUint16(offset + 8, true);
      channels = Math.max(1, view.getUint16(offset + 10, true));
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
      if (formatTag === 0xfffe && size >= 26) {
        formatTag = view.getUint16(offset + 32, true);
      }
    } else if (id === 0x64617461) { // 'data'
      dataStart = offset + 8;
      dataLen = Math.min(size, view.byteLength - dataStart);
      break;
    }
    offset += 8 + size + (size & 1);
  }
  if (dataStart < 0 || !(sampleRate > 0)) throw new Error('Malformed WAV header');
  const bytesPerSample = Math.max(1, bitsPerSample >> 3);
  const frameStride = bytesPerSample * channels;
  const frameCount = Math.floor(dataLen / frameStride);
  const samples = new Float32Array(frameCount);
  const invCh = 1 / channels;
  for (let i = 0; i < frameCount; i += 1) {
    let sum = 0;
    const base = dataStart + i * frameStride;
    for (let ch = 0; ch < channels; ch += 1) {
      const p = base + ch * bytesPerSample;
      let v = 0;
      if (formatTag === 3 && bitsPerSample === 32) {
        v = view.getFloat32(p, true);
      } else if (formatTag === 1 && bitsPerSample === 16) {
        v = view.getInt16(p, true) / 32768;
      } else if (formatTag === 1 && bitsPerSample === 8) {
        v = (view.getUint8(p) - 128) / 128;
      } else if (formatTag === 1 && bitsPerSample === 24) {
        let raw = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16);
        if (raw & 0x800000) raw |= 0xff000000;
        v = raw / 8388608;
      } else if (formatTag === 1 && bitsPerSample === 32) {
        v = view.getInt32(p, true) / 2147483648;
      } else {
        throw new Error(`Unsupported WAV format=${formatTag} bits=${bitsPerSample}`);
      }
      sum += v;
    }
    samples[i] = sum * invCh;
  }
  return { samples, sampleRate };
}

/** Iterative in-place radix-2 Cooley-Tukey FFT. `re.length === im.length` must be a power of 2. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k += 1) {
        const a = i + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function resolveBand(band, sampleRate) {
  let lo = 20;
  let hi = 20000;
  if (typeof band === 'string' && AUDIO_BANDS[band]) {
    [lo, hi] = AUDIO_BANDS[band];
  } else if (Array.isArray(band) && band.length >= 2) {
    lo = Math.max(0, Number(band[0]) || 0);
    hi = Math.max(lo + 1, Number(band[1]) || 20000);
  }
  const hzPerBin = sampleRate / FFT_SIZE;
  const maxBin = (FFT_SIZE >> 1) - 1;
  const binLo = Math.max(1, Math.min(maxBin, Math.floor(lo / hzPerBin)));
  const binHi = Math.max(binLo, Math.min(maxBin, Math.ceil(hi / hzPerBin)));
  return [binLo, binHi];
}

/** An envelope's rate, frames a second (`fps`, 10..240, 60 by default): the spectrum it is read from is taken at that rate. */
export const envelopeFps = (opts = {}) => Math.max(10, Math.min(240, Number(opts?.fps) || 60));

/**
 * The magnitude spectrum of mono PCM, one 1024-sample Hann window centred on each frame at `fps` (|X| * 2 / N for bins 0..511, in `mags`,
 * frame after frame). It is all an envelope reads, so every band, mode, gain or follower of one song at one rate comes from one of these
 * (envelopeFromSpectrum), never another FFT. Returns `{ fps, sampleRate, duration, frames, bins, mags }`.
 */
export function audioSpectrum(samples, sampleRate, opts = {}) {
  const sr = Math.max(1000, Number(sampleRate) || 44100);
  const src = samples instanceof Float32Array ? samples : Float32Array.from(samples || []);
  const duration = src.length / sr;
  const fps = envelopeFps(opts);
  const frames = Math.max(1, Math.ceil(duration * fps) + 1);
  const bins = FFT_SIZE >> 1;
  if (!src.length) return { fps, sampleRate: sr, duration: 0, frames, bins, mags: new Float32Array(0) };
  const win = hannWindow();
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const mags = new Float32Array(frames * bins);
  const scale = 2 / FFT_SIZE;
  for (let f = 0; f < frames; f += 1) {
    const start = Math.round((f / fps) * sr) - (FFT_SIZE >> 1);
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const si = start + i;
      re[i] = si >= 0 && si < src.length ? src[si] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    const o = f * bins;
    for (let k = 0; k < bins; k += 1) mags[o + k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * scale;
  }
  return { fps, sampleRate: sr, duration, frames, bins, mags };
}

/**
 * A deterministic scalar envelope table from a song's spectrum (audioSpectrum): its band, measured by `mode`, smoothed, normalized, gated,
 * scaled and followed (`attack` / `release`). Returns `{ fps, values: number[], peak, duration }`.
 */
export function envelopeFromSpectrum(spectrum, opts = {}) {
  const { fps, frames, bins, mags, sampleRate: sr, duration } = spectrum;
  const mode = AUDIO_MODES.includes(opts.mode) ? opts.mode : 'rms';
  const attack = Math.max(1e-4, Number(opts.attack ?? 0.01));
  const release = Math.max(1e-4, Number(opts.release ?? 0.12));
  const threshold = Math.max(0, Math.min(0.99, Number(opts.threshold ?? 0)));
  const gain = Math.max(0, Number(opts.gain ?? 1));
  const normalize = opts.normalize !== false;
  const smooth = Math.max(0, Math.min(12, Math.round(Number(opts.smooth ?? 0))));
  if (!mags.length) return { fps, values: new Array(frames).fill(0), peak: 0, duration: 0 };

  const [binLo, binHi] = resolveBand(opts.band ?? 'bass', sr);
  const raw = new Float32Array(frames);
  const isFlux = mode === 'flux' || mode === 'onset';
  const prevMag = isFlux ? new Float32Array(binHi - binLo + 1) : null;
  const binCount = Math.max(1, binHi - binLo + 1);

  for (let f = 0; f < frames; f += 1) {
    const o = f * bins;
    let val = 0;
    if (mode === 'peak') {
      for (let b = binLo; b <= binHi; b += 1) if (mags[o + b] > val) val = mags[o + b];
    } else if (isFlux) {
      let flux = 0;
      for (let b = binLo; b <= binHi; b += 1) {
        const k = b - binLo;
        const mag = Math.log1p(mags[o + b] * 8);
        const diff = mag - prevMag[k];
        if (f > 0 && diff > 0) flux += diff;
        prevMag[k] = mag;
      }
      val = flux / binCount;
    } else {
      let sumSq = 0;
      for (let b = binLo; b <= binHi; b += 1) sumSq += mags[o + b] * mags[o + b];
      val = Math.sqrt(sumSq / binCount);
    }
    raw[f] = val;
  }

  let work = raw;
  if (smooth > 0) {
    const sm = new Float32Array(frames);
    for (let f = 0; f < frames; f += 1) {
      let acc = 0;
      let cnt = 0;
      const lo = Math.max(0, f - smooth);
      const hi = Math.min(frames - 1, f + smooth);
      for (let j = lo; j <= hi; j += 1) { acc += raw[j]; cnt += 1; }
      sm[f] = acc / cnt;
    }
    work = sm;
  }

  let peak = 0;
  for (let f = 0; f < frames; f += 1) if (work[f] > peak) peak = work[f];
  const normScale = normalize && peak > 1e-7 ? 1 / peak : 1;

  const dt = 1 / fps;
  const alphaA = 1 - Math.exp(-dt / attack);
  const alphaR = 1 - Math.exp(-dt / release);
  const values = new Array(frames);
  let env = 0;
  for (let f = 0; f < frames; f += 1) {
    let x = work[f] * normScale;
    if (threshold > 0) x = Math.max(0, x - threshold) / (1 - threshold);
    const target = Math.max(0, x * gain);
    const a = target > env ? alphaA : alphaR;
    env += (target - env) * a;
    values[f] = Math.round(env * 1e6) / 1e6;
  }
  return { fps, values, peak, duration };
}

/** An envelope table straight from mono PCM: audioSpectrum, then envelopeFromSpectrum. Returns `{ fps, values: number[], peak, duration }`. */
export function computeAudioEnvelope(samples, sampleRate, opts = {}) {
  return envelopeFromSpectrum(audioSpectrum(samples, sampleRate, opts), opts);
}

/** Sample an envelope table deterministically at time `t` (seconds). */
export function sampleAudioEnvelope(envelope, t, { offset = 0 } = {}) {
  if (!envelope || !Array.isArray(envelope.values) && !(envelope.values instanceof Float32Array)) return 0;
  const vals = envelope.values;
  const n = vals.length;
  if (!n) return 0;
  const fps = Math.max(1, Number(envelope.fps) || 60);
  const u = (Number(t) - Number(offset || 0)) * fps;
  if (!(u >= 0)) return Number(vals[0]) || 0;
  if (u >= n - 1) return Number(vals[n - 1]) || 0;
  const i0 = Math.floor(u);
  const f = u - i0;
  return (Number(vals[i0]) || 0) * (1 - f) + (Number(vals[i0 + 1]) || 0) * f;
}

export const isAudioClock = (def) => !!(def && typeof def === 'object' && def.audio && typeof def.audio === 'object');

/** Whether a scene has any audio clock: the one check a scene without them pays. */
export const hasAudioClocks = (scene) => !!scene?.clocks && typeof scene.clocks === 'object' && Object.values(scene.clocks).some(isAudioClock);

const withClocks = new WeakMap();
/**
 * The Rig's own `scene` with the audio clocks the world was given (`built`, host.js setScene: each one's envelope and its place on the
 * timeline), for what the editor reads of the Scene on its side (an object's place, a rig's pose): one source of truth with the world. The
 * same object for the same two scenes, so a clock's cache (keys.js clockAt) holds frame after frame; `scene` itself when it has no audio
 * clock or the world has not been built.
 */
export function withWorldClocks(scene, built) {
  if (!hasAudioClocks(scene) || !built?.clocks || typeof built.clocks !== 'object') return scene;
  const kept = withClocks.get(scene);
  if (kept && kept.built === built) return kept.out;
  const clocks = { ...scene.clocks };
  for (const [name, def] of Object.entries(built.clocks)) if (isAudioClock(def) && isAudioClock(clocks[name])) clocks[name] = def;
  const out = { ...scene, clocks };
  withClocks.set(scene, { built, out });
  return out;
}

/** Where in its file an audio clock is at Scene time t (seconds of the file): `offset` delays the song; `placed` (placeAudioClocks: its
 *  timeline item) has the file's `from` play at Scene time `at`, `rate` seconds of the file a second. */
function songTime(audio, t) {
  const time = (Number(t) || 0) - (Number(audio?.offset) || 0);
  const p = audio?.placed && typeof audio.placed === 'object' ? audio.placed : null;
  if (!p) return { s: time, from: 0, to: Infinity };
  const from = Number(p.from) || 0;
  return { s: from + (time - (Number(p.at) || 0)) * (Number(p.rate) > 0 ? Number(p.rate) : 1), from, to: Number.isFinite(+p.to) ? +p.to : Infinity };
}

/** Where in its file an audio clock is at Scene time t (seconds of the file), or null where its clip is not playing. */
export function audioClockSongTime(audio, t) {
  const { s, from, to } = songTime(audio, t);
  return s < from - 1e-9 || s > to + 1e-9 ? null : s;
}

// A release runs three of its time constants past the end of the sound, then the clock is 0 (the follower's own curve, lowered so it lands
// there: still 37 % of the last value after one release, 14 % after two).
const RELEASE_TAIL = 3;
const TAIL_FLOOR = Math.exp(-RELEASE_TAIL);

/**
 * Evaluate a scene clock that carries `audio` (reading pre-baked `_envelope` or `envelope`): 0 before its sound starts; past its end (the
 * file's, or its timeline item's) it falls to 0 through its own `release`, as its follower does on silence.
 */
export function audioClockValue(def, t) {
  if (!isAudioClock(def)) return undefined;
  const env = def._envelope || def.envelope;
  if (!env) return 0;
  const { s, from, to } = songTime(def.audio, t);
  if (!(s >= from - 1e-9)) return 0;
  const n = Array.isArray(env.values) || env.values instanceof Float32Array ? env.values.length : 0;
  const length = Number(env.duration) > 0 ? Number(env.duration) : Math.max(0, n - 1) / Math.max(1, Number(env.fps) || 60);
  const end = Math.min(length, to);
  if (s <= end) return sampleAudioEnvelope(env, s);
  const x = (s - end) / Math.max(1e-4, Number(def.audio.release ?? 0.12));
  if (x >= RELEASE_TAIL - 1e-9) return 0;
  return sampleAudioEnvelope(env, end) * Math.max(0, (Math.exp(-x) - TAIL_FLOOR) / (1 - TAIL_FLOOR));
}

/** Resolve the media URL for an audio clock definition given optional timeline clips list. */
export function audioClockUrl(def, clips = null) {
  if (!isAudioClock(def)) return null;
  const a = def.audio;
  if (typeof a.url === 'string' && a.url) return a.url;
  if (Array.isArray(clips)) {
    if (typeof a.clipId === 'string' && a.clipId) {
      const c = clips.find((x) => x?.id === a.clipId || x?.name === a.clipId);
      if (c?.url) return c.url;
    }
    if (a.source === 'timeline') {
      const c = clips.find((x) => (x?.mediaType === 'audio' || x?.mediaType === 'video') && typeof x.url === 'string' && x.url);
      if (c?.url) return c.url;
    }
  }
  return null;
}

/** Deterministic content key for an audio clock's DSP settings (for caching baked envelopes). */
export function audioClockSpecKey(audio, url = '') {
  if (!audio || typeof audio !== 'object') return '';
  return JSON.stringify([
    url || audio.url || audio.clipId || audio.source || '',
    audio.band || 'bass',
    audio.mode || 'rms',
    Number(audio.fps ?? 60),
    Number(audio.attack ?? 0.01),
    Number(audio.release ?? 0.12),
    Number(audio.threshold ?? 0),
    Number(audio.gain ?? 1),
    audio.normalize !== false,
    Number(audio.smooth ?? 0),
  ]);
}

/**
 * Every item of a timeline whose clip has sound to read, and where that sound plays: [{ url, clipId, name, mediaType, start, from, to,
 * rate, channel, index }], `start` in timeline seconds, `from`..`to` seconds of the file. `channels` and `clipsMap` (a Map of clips by id)
 * as the editor holds them, `layoutFor(channel)` its layout (speedUtils.js getTimelineLayout: { startTime, duration } per item). An audio
 * clip plays at its own pace from its trim, as the editor plays it (channelRender.js); a video's sound at its speed (a ramp's average).
 */
export function timelineAudioItems(channels, clipsMap, layoutFor) {
  const out = [];
  (channels || []).forEach((ch, c) => {
    const layout = layoutFor?.(ch) || [];
    (ch?.items || []).forEach((item, i) => {
      const clip = clipsMap?.get?.(item?.clipId);
      const e = layout[i];
      if (!e || !clip || (clip.mediaType !== 'audio' && clip.mediaType !== 'video') || typeof clip.url !== 'string' || !clip.url) return;
      const from = Math.max(0, Number(item.trimStart) || 0);
      const end = Number.isFinite(+item.trimEnd) ? +item.trimEnd : Infinity;
      const duration = Math.max(0, Number(e.duration) || 0);
      const rate = clip.mediaType === 'audio' || !(duration > 0) || !Number.isFinite(end) ? 1 : Math.max(0.01, (end - from) / duration);
      out.push({ url: clip.url, clipId: clip.id, name: clip.name, mediaType: clip.mediaType, start: Number(e.startTime) || 0,
        from, to: Math.min(end, from + duration * rate), rate, channel: c, index: i });
    });
  });
  return out;
}

const earliest = (a, b) => a.start - b.start || a.channel - b.channel || a.index - b.index;

/**
 * The timeline item an audio clock reads: for `clipId`, the earliest item of that clip (by id or name); for `source: "timeline"`, the
 * earliest audio item, or the earliest video item when the timeline has no audio. Earliest: by start, then the channel's place in the
 * list, then the item's in its channel. Null when there is none.
 */
export function pickAudioItem(audio, items) {
  const list = items || [];
  if (typeof audio?.clipId === 'string' && audio.clipId) {
    return list.filter((x) => x.clipId === audio.clipId || x.name === audio.clipId).sort(earliest)[0] || null;
  }
  if (audio?.source === 'timeline') {
    return list.filter((x) => x.mediaType === 'audio').sort(earliest)[0] || list.filter((x) => x.mediaType === 'video').sort(earliest)[0] || null;
  }
  return null;
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * The Scene's clocks with each `clipId` / `source: "timeline"` audio clock bound to the timeline (one with its own `url` is left as it is):
 * its clip's `url`, and `placed` { at, from, to, rate } from its item (pickAudioItem), `at` in the Scene's time: the timeline's less
 * `sceneStart`, where the Scene's own item starts. A `clipId` in the pool (`clips`) with no item on the timeline plays from the Scene's 0.
 * The same object back when nothing changes.
 */
export function placeAudioClocks(clocks, { items = [], clips = null, sceneStart = 0 } = {}) {
  let out = clocks;
  for (const [name, def] of Object.entries(clocks || {})) {
    if (!isAudioClock(def) || def.audio.url) continue;
    const item = pickAudioItem(def.audio, items);
    let audio = null;
    if (item) {
      audio = { ...def.audio, url: item.url,
        placed: { at: r6(item.start - (Number(sceneStart) || 0)), from: r6(item.from), to: Number.isFinite(item.to) ? r6(item.to) : null, rate: r6(item.rate) } };
    } else {
      const url = audioClockUrl(def, clips);
      if (url) audio = { ...def.audio, url };
    }
    if (!audio) continue;
    if (out === clocks) out = { ...clocks };
    out[name] = { ...def, audio };
  }
  return out;
}
