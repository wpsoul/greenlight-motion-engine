// SVG media as a VECTOR layer.
//
// An .svg dropped on the timeline is still an image clip — same panel, same
// filters, transitions and effects — but it must never behave like a bitmap:
//
//   1. Its plate is its OWN size, not the composition frame. A logo authored at
//      600x180 lands at 600x180 instead of being letterbox-fitted up to the frame
//      height, and the transform gizmo hugs the artwork.
//   2. It is rasterized at the resolution it occupies ON SCREEN (rasterDensity.js),
//      re-drawn whenever the camera pushes in, exactly like a shape or text layer.
//      Chromium re-renders an SVG <img> at the destination rect of drawImage, so a
//      bigger backing canvas resolves real vector detail rather than magnifying
//      texels.
//
// This module owns the decode side of that: it resolves an SVG url to a decoded
// <img> plus the intrinsic size the plate is built from. Player.jsx does the
// density measurement and the raster; PreviewTransformOverlay.jsx reads the size so
// selection geometry matches what was drawn.

const DEFAULT_WIDTH = 300; // CSS default sizing for an SVG with neither size nor viewBox
const DEFAULT_HEIGHT = 150;
const MAX_CACHE = 48;

// url -> { status, img, width, height, key }
const assetCache = new Map();
const listeners = new Set();

/** CSS absolute units, in px. Percentages and font-relative units are unresolvable
 * for a standalone document, so they fall through to the viewBox instead. */
const UNIT_PX = { px: 1, pt: 96 / 72, pc: 16, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, in: 96 };

function parseLength(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text.endsWith('%')) return null;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)$/i.exec(text);
  if (!match) return null;
  const n = parseFloat(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (match[2] || 'px').toLowerCase();
  const factor = UNIT_PX[unit];
  return factor ? n * factor : null;
}

function parseViewBox(value) {
  if (!value) return null;
  const parts = String(value).trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [, , w, h] = parts;
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

/**
 * Resolve an SVG document to (a) the size it declares and (b) a form that scales.
 *
 * Both halves matter. The declared size is what "import at original size" means, and
 * `naturalWidth` on a plain <img> cannot supply it: an SVG with only a viewBox gets
 * the 300px default-sizing width, which is not the artwork's size. And an SVG with
 * width/height but NO viewBox has no way to scale — drawing it into a larger rect
 * leaves the artwork at its declared size in the corner — so one is written in.
 *
 * Returns null when the text is not an SVG document at all.
 */
export function normalizeSvgText(text) {
  let doc;
  try { doc = new DOMParser().parseFromString(text, 'image/svg+xml'); } catch { return null; }
  const svg = doc?.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== 'svg' || svg.getElementsByTagName('parsererror').length) return null;

  const box = parseViewBox(svg.getAttribute('viewBox'));
  const declaredW = parseLength(svg.getAttribute('width'));
  const declaredH = parseLength(svg.getAttribute('height'));

  let width = declaredW;
  let height = declaredH;
  if (!width || !height) {
    if (box) {
      // One axis given plus a viewBox: the other follows the aspect ratio.
      if (width) height = (width * box.height) / box.width;
      else if (height) width = (height * box.width) / box.height;
      else { width = box.width; height = box.height; }
    } else {
      width = width || DEFAULT_WIDTH;
      height = height || DEFAULT_HEIGHT;
    }
  }

  if (!box) svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  // Pin the intrinsic size so the decoded <img> reports exactly what was measured
  // here — the plate and the raster have to agree to the pixel.
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  return { text: new XMLSerializer().serializeToString(svg), width, height };
}

/** True for anything the vector path should own: a .svg file or an inline SVG data url. */
export function isVectorMediaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('data:image/svg+xml')) return true;
  return /\.svg$/i.test(url.split(/[?#]/)[0]);
}

/** An image clip whose source is vector artwork. */
export function isVectorMediaClip(clip) {
  return !!clip && clip.mediaType === 'image' && isVectorMediaUrl(clip.url);
}

function notifyReady() {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* a dead subscriber must not stall the rest */ }
  }
}

/**
 * Re-render hook for the Player: decoding is async, and a frame drawn before it
 * finishes skips the layer entirely. Without this the layer would stay blank until
 * something else happened to trigger a redraw (the 3D-model layers learned the same
 * lesson).
 */
export function subscribeVectorMedia(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function evict() {
  while (assetCache.size > MAX_CACHE) {
    const oldest = assetCache.keys().next().value;
    assetCache.delete(oldest);
  }
}

/**
 * Decoded vector asset for `url`, or an entry still loading/failed.
 *
 * The document is fetched and re-serialized as a data url rather than pointed at
 * directly, which buys three things at the cost of one request: the declared size
 * above, a guaranteed viewBox, and same-origin pixels — drawing a cross-origin <img>
 * into a canvas taints it, and uploading a tainted canvas to WebGL throws.
 *
 * A fetch that fails (an offline media root, an exotic scheme) falls back to loading
 * the url directly; that still rasterizes at the destination size whenever the file
 * carries its own viewBox, which is the overwhelming majority.
 */
export function getVectorAsset(url) {
  if (!url || typeof url !== 'string') return null;
  let entry = assetCache.get(url);
  if (entry) return entry;
  entry = { status: 'loading', img: null, width: 0, height: 0, key: null };
  assetCache.set(url, entry);
  evict();

  const decode = (src, width, height) => {
    const img = new Image();
    img.onload = () => {
      entry.img = img;
      entry.width = width || img.naturalWidth || DEFAULT_WIDTH;
      entry.height = height || img.naturalHeight || DEFAULT_HEIGHT;
      entry.key = `${entry.width}x${entry.height}:${src.length}`;
      entry.status = 'ready';
      notifyReady();
    };
    img.onerror = () => {
      entry.status = 'failed';
      notifyReady();
    };
    if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.src = src;
  };

  (async () => {
    try {
      const text = await (await fetch(url)).text();
      const normalized = normalizeSvgText(text);
      if (!normalized) { entry.status = 'failed'; notifyReady(); return; }
      decode(
        `data:image/svg+xml;charset=utf-8,${encodeURIComponent(normalized.text)}`,
        normalized.width,
        normalized.height
      );
    } catch {
      decode(url, 0, 0);
    }
  })();

  return entry;
}

/**
 * Resolve once `url` is decoded (or has failed), for the render page's media warm-up.
 *
 * A headless render draws its first frame the moment the gate opens, and a vector
 * layer that is still decoding draws nothing at all — so the plain image warm-up
 * (which only primes the HTTP cache) is not enough on its own. The timeout is the
 * same defensive shape the rest of that gate uses: a stuck asset must not hang an
 * export forever.
 */
export function preloadVectorMedia(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const entry = getVectorAsset(url);
    if (!entry || entry.status !== 'loading') { resolve(); return; }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      off();
      clearTimeout(timer);
      resolve();
    };
    const off = subscribeVectorMedia(() => { if (entry.status !== 'loading') finish(); });
    const timer = setTimeout(finish, timeoutMs);
  });
}

/**
 * The artwork's own size in composition px, or null while it is still decoding.
 * This IS the layer's box — see the plate note at the top of the file.
 */
export function getVectorMediaSize(url) {
  const entry = isVectorMediaUrl(url) ? getVectorAsset(url) : null;
  return entry?.status === 'ready' ? { width: entry.width, height: entry.height } : null;
}
