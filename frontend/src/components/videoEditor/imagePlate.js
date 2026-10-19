// The plate an IMAGE layer draws on.
//
// An image clip normally draws on a COMPOSITION-SIZED plate and the clip shader
// fit-contains the picture into it (clipShader.js). That fit works both ways, so
// a photo smaller than the frame is blown UP to it: a 400x300 snapshot dropped on
// a 1920x1080 project landed as 1440x1080, soft and cropped-looking, and the only
// way back was to dial the Scale slider down by hand.
//
// Vector media already opted out of that (vectorMedia.js): its plate is the
// artwork's own size, which is what makes a 600x180 logo import at 600x180.
//
// A raster image now draws on the picture's own rect too — THE PLATE KEEPS THE
// PICTURE'S ASPECT RATIO, never the project's:
//
//   * Smaller than the frame → its original pixel size. A 400x300 snapshot on a
//     1080p project stays 400x300 instead of being blown up to 1440x1080.
//   * Larger than the frame → shrunk to fit, ratio intact. A 3000x1200 panorama on
//     a 1080x1920 project becomes 1080x432 — the picture, not a 1080x1920 plate
//     with the panorama letterboxed into it.
//
// The second case is why the bars are gone. Fitting into a frame-shaped plate left
// the spare axis painted opaque black (the "video player bars" branch in
// clipShader), so the LAYER read as the project's aspect ratio however the picture
// was shaped, and that black covered whatever sat below it. With the plate equal to
// the drawn picture there is no spare axis to fill: the layers underneath (and the
// project background) show around it, and the transform gizmo hugs the artwork.
//
// Only DOWNSCALING to fit survives, and only because at 1:1 a 6000px photo would
// cover the composition several times over, showing a random crop of itself.
//
// This module owns the decode side: it resolves a raster url to its intrinsic size
// and republishes it. Player.jsx builds the plate from it; PreviewTransformOverlay
// reads it so selection geometry matches what was drawn.

import { isVectorMediaUrl, getVectorMediaSize, subscribeVectorMedia } from './vectorMedia';

const MAX_CACHE = 96;

// url -> { status: 'loading' | 'ready' | 'failed', width, height }
const sizeCache = new Map();
const listeners = new Set();

function notifyReady() {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* a dead subscriber must not stall the rest */ }
  }
}

/**
 * Re-render hook: decoding is async, and a frame drawn before it finishes still
 * uses the frame-sized plate. Without this the layer would keep the fitted size
 * until something else happened to trigger a redraw (the same lesson vector media
 * and the 3D model layers each learned).
 *
 * Covers vector media too, so a caller that reads `imagePlateSize` needs exactly
 * one subscription to stay in sync with every image plate.
 */
export function subscribeImagePlate(listener) {
  listeners.add(listener);
  const offVector = subscribeVectorMedia(listener);
  return () => {
    listeners.delete(listener);
    offVector();
  };
}

function evict() {
  while (sizeCache.size > MAX_CACHE) {
    const oldest = sizeCache.keys().next().value;
    sizeCache.delete(oldest);
  }
}

/**
 * Intrinsic size of a raster url, or null while it is still decoding (or failed).
 *
 * The decode is a plain <img>, deliberately separate from the WebGL texture: the
 * plate has to be known by the transform overlay as well, which has no access to
 * the Player's texture cache. Both hit the same HTTP cache entry.
 */
function getRasterSize(url) {
  if (!url || typeof url !== 'string') return null;
  let entry = sizeCache.get(url);
  if (!entry) {
    entry = { status: 'loading', width: 0, height: 0 };
    sizeCache.set(url, entry);
    evict();
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w > 0 && h > 0) {
        entry.width = w;
        entry.height = h;
        entry.status = 'ready';
      } else {
        entry.status = 'failed';
      }
      notifyReady();
    };
    img.onerror = () => {
      entry.status = 'failed';
      notifyReady();
    };
    img.src = url;
  }
  return entry.status === 'ready' ? { width: entry.width, height: entry.height } : null;
}

/**
 * The plate this image clip draws on, in composition px — always the picture's own
 * rect, or null while it is still decoding (then the frame stands in, as before).
 *
 * Vector artwork draws at its declared size whatever the frame is; raster artwork
 * keeps its pixels up to the frame and is shrunk to fit beyond it. Either way the
 * returned rect has the ARTWORK's aspect ratio — see the note at the top of the file.
 */
export function imagePlateSize(clip, frameW, frameH) {
  if (!clip || clip.mediaType !== 'image' || !clip.url) return null;
  if (isVectorMediaUrl(clip.url)) return getVectorMediaSize(clip.url);
  if (!(frameW > 0) || !(frameH > 0)) return null;
  const size = getRasterSize(clip.url);
  if (!size) return null;
  // Downscale only: shrink exactly as far as the frame demands, never enlarge.
  const fit = Math.min(1, frameW / size.width, frameH / size.height);
  return fit >= 1 ? size : { width: size.width * fit, height: size.height * fit };
}

/**
 * Resolve once `url` is decoded (or has failed), for the render page's media
 * warm-up: a headless render draws its first frame the moment the gate opens, and
 * a plate resolved one frame late would export those frames at the fitted size.
 * The timeout is the same defensive shape the rest of that gate uses.
 */
export function preloadImagePlate(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    // Vector artwork has its own decode and its own warm-up (preloadVectorMedia);
    // rasterizing it here would only fill this cache with a size nothing reads.
    if (!url || isVectorMediaUrl(url)) { resolve(); return; }
    getRasterSize(url);
    const entry = sizeCache.get(url);
    if (!entry || entry.status !== 'loading') { resolve(); return; }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      off();
      clearTimeout(timer);
      resolve();
    };
    const off = subscribeImagePlate(() => { if (entry.status !== 'loading') finish(); });
    const timer = setTimeout(finish, timeoutMs);
  });
}
