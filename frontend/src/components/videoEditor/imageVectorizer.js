// Client-only raster → vector tracing (main-thread facade).
//
// The tracing itself lives in rasterTracer.js and runs in a worker, so a big
// logo never blocks the timeline. Nothing is downloaded and nothing is uploaded:
// this works offline and the user's image stays on the device.

export const VECTOR_MAX_EDGE = 1024;

export const VECTOR_DETAIL_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

export const VECTOR_CHANNELS = ['auto', 'alpha', 'color', 'luma'];

/**
 * The trace settings a shape layer stores, clamped.
 *
 * One object rather than seven item fields, so the VideoEditor sanitizer has a
 * single thing to whitelist — an unlisted item field is silently dropped on
 * autosave.
 */
export const VECTOR_TRACE_DEFAULTS = {
  detail: 'medium',
  channel: 'auto',
  autoThreshold: true,
  threshold: 0.5,
  pieces: 'all',
  holes: true,
  invert: false,
  speckle: 40,
  // Null means "follow the Detail preset" — the usual case. A number is an
  // explicit override from the Smoothing slider.
  maskSmooth: null,
  reach: 0.4,
};

export function sanitizeVectorTrace(value) {
  const v = value && typeof value === 'object' ? value : {};
  const num = (x, fallback, min, max) => {
    const n = Number.parseFloat(x);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    detail: VECTOR_DETAIL_OPTIONS.some((o) => o.value === v.detail) ? v.detail : 'medium',
    channel: VECTOR_CHANNELS.includes(v.channel) ? v.channel : 'auto',
    autoThreshold: v.autoThreshold !== false,
    threshold: num(v.threshold, 0.5, 0.01, 0.99),
    pieces: v.pieces === 'largest' ? 'largest' : 'all',
    holes: v.holes !== false,
    invert: v.invert === true,
    speckle: Math.round(num(v.speckle, 40, 0, 20000)),
    maskSmooth: v.maskSmooth === null || v.maskSmooth === undefined
      ? null
      : Math.round(num(v.maskSmooth, 4, 0, 12)),
    reach: num(v.reach, 0.4, 0.05, 1),
  };
}

/** Stored settings → the tracer's own option names. */
export function vectorTraceOverrides(trace) {
  const t = sanitizeVectorTrace(trace);
  return {
    channel: t.channel,
    autoThreshold: t.autoThreshold,
    threshold: t.threshold,
    invert: t.invert,
    speckle: t.speckle,
    pieces: t.pieces,
    bridgeHoles: t.holes,
    reach: t.reach,
    ...(t.maskSmooth === null ? {} : { maskSmooth: t.maskSmooth }),
  };
}

/** Effective smoothing shown in the panel when the preset is in charge. */
export function vectorMaskSmooth(trace) {
  const t = sanitizeVectorTrace(trace);
  if (t.maskSmooth !== null) return t.maskSmooth;
  return { low: 5, medium: 4, high: 3 }[t.detail] ?? 4;
}

let worker = null;
let workerApi = null;

/**
 * Trace an image into the editor's unit-box bezier format.
 *
 * Resolves to { points, closed, svg, width, height, pathCount, … } — `points` is
 * already a shapePath point list, so callers store it directly.
 */
export async function vectorizeImage(imageUrl, { onProgress, detail = 'medium', overrides } = {}) {
  const Comlink = await import('comlink');
  if (!workerApi) {
    worker = new Worker(new URL('./imageVectorWorker.js', import.meta.url), { type: 'module' });
    workerApi = Comlink.wrap(worker);
  }
  const proxied = onProgress ? Comlink.proxy(onProgress) : undefined;
  return workerApi.vectorize(imageUrl, VECTOR_MAX_EDGE, { detail, overrides }, proxied);
}

export function svgTextToDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function releaseVectorWorker() {
  if (worker) {
    try { worker.terminate(); } catch { /* no-op */ }
  }
  worker = null;
  workerApi = null;
}
