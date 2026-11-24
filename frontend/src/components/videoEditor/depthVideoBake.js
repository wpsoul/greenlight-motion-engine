/*
 * Per-frame Video Depth bake & temporal stabilization (depthVideoBake.js).
 *
 * `stabilizeDepthFrames` is pure JS (zero DOM/Worker) so Node tests exercise the
 * exact temporal normalization + edge-preserving EMA used during browser baking.
 * `bakeDepthVideo` steps the video in the browser, feeds frames to depthWorker
 * (`estimateRaw`), stabilizes across time, and encodes an all-intra grayscale
 * H.264 MP4 via rotoMatteEncode.js.
 */

function quantileSorted(sorted, q) {
  if (!sorted.length) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
}

function normalizeFrame01(src, N) {
  const out = new Float32Array(N);
  const sampleStep = Math.max(1, Math.floor(N / 4096));
  const samples = [];
  for (let i = 0; i < N; i += sampleStep) {
    const v = Number(src[i]);
    if (Number.isFinite(v)) samples.push(v);
  }
  if (!samples.length) return out;
  samples.sort((a, b) => a - b);
  const lo = quantileSorted(samples, 0.02);
  const hi = quantileSorted(samples, 0.98);
  const span = hi - lo;
  if (!(span > 1e-6)) {
    const inv = hi > 1 ? 1 / 255 : 1;
    for (let i = 0; i < N; i += 1) out[i] = Math.max(0, Math.min(1, (Number(src[i]) || 0) * inv));
    return out;
  }
  const invSpan = 1 / span;
  for (let i = 0; i < N; i += 1) {
    const v = (Number(src[i]) || lo) - lo;
    out[i] = Math.max(0, Math.min(1, v * invSpan));
  }
  return out;
}

/**
 * Temporally stabilize raw monocular depth frames:
 *  1) Robust percentile [2%, 98%] normalization per frame.
 *  2) Affine scale/shift alignment of each frame to the running temporal state
 *     over persistent background/low-change samples, removing Depth Anything's
 *     per-frame global range flicker.
 *  3) Edge-preserving temporal EMA so static regions lock rock-steady without
 *     motion-ghosting moving subjects.
 */
export function stabilizeDepthFrames(frames, { w, h, emaAlpha = 0.22, edgeSigma = 0.14 } = {}) {
  if (!Array.isArray(frames) || !frames.length) return [];
  const N = Math.max(1, w * h);
  const normFrames = frames.map((f) => normalizeFrame01(f, N));
  const out = new Array(normFrames.length);
  const ema = new Float32Array(normFrames[0]);
  const twoSigma2 = Math.max(1e-4, 2 * edgeSigma * edgeSigma);

  const quantize = (buf) => {
    const u8 = new Uint8Array(N);
    for (let i = 0; i < N; i += 1) u8[i] = Math.max(0, Math.min(255, Math.round(buf[i] * 255)));
    return u8;
  };
  out[0] = quantize(ema);

  const sampleStep = Math.max(1, Math.floor(N / 4096));
  const curSamples = [];
  const refSamples = [];
  for (let f = 1; f < normFrames.length; f += 1) {
    const cur = normFrames[f];
    curSamples.length = 0;
    refSamples.length = 0;
    for (let i = 0; i < N; i += sampleStep) {
      curSamples.push(cur[i]);
      refSamples.push(ema[i]);
    }
    // Match 25th/75th percentiles (robust to localized foreground motion!)
    const curSorted = Float32Array.from(curSamples).sort();
    const refSorted = Float32Array.from(refSamples).sort();
    const c25 = quantileSorted(curSorted, 0.25);
    const c75 = quantileSorted(curSorted, 0.75);
    const r25 = quantileSorted(refSorted, 0.25);
    const r75 = quantileSorted(refSorted, 0.75);
    const cIqr = c75 - c25;
    const rIqr = r75 - r25;
    const scale = cIqr > 0.04 ? Math.max(0.5, Math.min(2.0, rIqr / cIqr)) : 1;
    const cMed = quantileSorted(curSorted, 0.5);
    const rMed = quantileSorted(refSorted, 0.5);
    const shift = rMed - scale * cMed;

    for (let i = 0; i < N; i += 1) {
      const aligned = Math.max(0, Math.min(1, cur[i] * scale + shift));
      const diff = aligned - ema[i];
      // Bilateral temporal filter: small frame-to-frame deltas lock to EMA (zero flicker),
      // large real motion deltas snap cleanly to `aligned` (zero ghosting).
      const flatWeight = Math.exp(-(diff * diff) / twoSigma2);
      const updateAlpha = Math.max(0.05, Math.min(1, 1 - flatWeight * (1 - emaAlpha)));
      ema[i] = Math.max(0, Math.min(1, ema[i] * (1 - updateAlpha) + aligned * updateAlpha));
    }
    out[f] = quantize(ema);
  }
  return out;
}

function seekVideoFrame(v, timeSec, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Cancelled')); return; }
    let done = false;
    const finish = (err = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => finish(), 400);
    const afterSeek = () => {
      if (typeof v.requestVideoFrameCallback === 'function') {
        v.requestVideoFrameCallback(() => finish());
      } else {
        finish();
      }
    };
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const t = Math.max(0, Math.min(dur > 0 ? dur - 0.02 : 0, timeSec));
    if (Math.abs(v.currentTime - t) < 0.002 && v.readyState >= 2) {
      finish();
      return;
    }
    v.addEventListener('seeked', afterSeek, { once: true });
    v.currentTime = t;
  });
}

function loadVideoForBake(url, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Cancelled')); return; }
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    const onErr = () => reject(new Error('Could not load video for depth baking.'));
    v.addEventListener('error', onErr, { once: true });
    v.addEventListener('loadedmetadata', () => {
      v.removeEventListener('error', onErr);
      resolve(v);
    }, { once: true });
    v.src = url;
  });
}

/**
 * Sample every frame over [startTime, startTime + duration] at `fps`, estimate
 * raw monocular depth via `depthWorker.estimateRaw`, temporally stabilize, and
 * encode an all-intra grayscale H.264 MP4 for preview & export.
 */
export async function bakeDepthVideo({
  videoUrl, startTime = 0, duration = 5, fps = 15, maxSide = 384, onProgress = null, signal = null,
}) {
  const [{ createMatteEncoder }, Comlink] = await Promise.all([
    import('./rotoMatteEncode.js'),
    import('comlink'),
  ]);
  const worker = new Worker(new URL('./depthWorker.js', import.meta.url), { type: 'module' });
  const api = Comlink.wrap(worker);
  let v = null;
  let encoder = null;
  try {
    onProgress?.({ stage: 'frame', pct: 0 });
    v = await loadVideoForBake(videoUrl, signal);
    const sw = Math.max(16, v.videoWidth || 640);
    const sh = Math.max(16, v.videoHeight || 360);
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const even = (n) => Math.max(16, Math.round(n / 2) * 2);
    const w = even(sw * scale);
    const h = even(sh * scale);

    const clipDur = Math.max(0.1, duration || (v.duration ? Math.max(0.1, v.duration - startTime) : 5));
    const safeFps = Math.max(8, Math.min(30, Math.round(fps || 15)));
    const maxFrames = 450;
    const count = Math.min(maxFrames, Math.max(2, Math.round(clipDur * safeFps)));
    const effectiveFps = count > 1 ? Math.max(1, Math.round(count / clipDur)) : safeFps;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });

    const rawFrames = [];
    const proxied = onProgress
      ? Comlink.proxy((p) => { if (p?.stage === 'model') onProgress(p); })
      : undefined;

    for (let i = 0; i < count; i += 1) {
      if (signal?.aborted) throw new Error('Cancelled');
      const t = startTime + (count > 1 ? (i / (count - 1)) * clipDur : 0);
      await seekVideoFrame(v, t, signal);
      ctx.drawImage(v, 0, 0, w, h);
      const frameUrl = canvas.toDataURL('image/jpeg', 0.9);
      const res = await api.estimateRaw(frameUrl, Math.max(w, h), i === 0 ? proxied : undefined);
      rawFrames.push({ w: res.w, h: res.h, data: res.data });
      onProgress?.({ stage: 'infer', pct: Math.round(((i + 1) / count) * 90), frame: i + 1, total: count });
    }

    const outW = rawFrames[0].w + (rawFrames[0].w & 1);
    const outH = rawFrames[0].h + (rawFrames[0].h & 1);
    onProgress?.({ stage: 'stabilize', pct: 92 });
    const stabilized = stabilizeDepthFrames(rawFrames.map((r) => r.data), { w: rawFrames[0].w, h: rawFrames[0].h });

    onProgress?.({ stage: 'encode', pct: 95 });
    encoder = await createMatteEncoder({ w: outW, h: outH, fps: effectiveFps });
    for (const gray of stabilized) encoder.add(gray);
    const encoded = await encoder.finish();
    encoder = null;
    onProgress?.({ stage: 'encode', pct: 100 });
    return {
      bytes: encoded.bytes,
      w: encoded.width,
      h: encoded.height,
      fps: encoded.fps,
      frames: encoded.frames,
      duration: clipDur,
      startTime,
    };
  } finally {
    if (encoder) { try { encoder.abort(); } catch { /* ignore */ } }
    if (v) { try { v.src = ''; v.load(); } catch { /* ignore */ } }
    try { worker.terminate(); } catch { /* ignore */ }
  }
}
