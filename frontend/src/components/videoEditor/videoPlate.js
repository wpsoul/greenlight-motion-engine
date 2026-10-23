// The plate a VIDEO layer draws on, in composition pixels.
//
// A video used to draw on a COMPOSITION-SIZED plate with the clip shader
// fit-containing the picture into it, and the spare axis of a clip whose aspect
// ratio differs from the project's painted OPAQUE BLACK (the "video player bars"
// branch in clipShader). The layer read as the project's shape however the footage
// was shaped, and those bars covered everything below it. It also blew every small
// clip up to the frame: a 720p clip in a 1080p project filled it, soft.
//
// Now a video draws exactly as an image does (imagePlate.js) — THE PLATE IS THE
// PICTURE, at its own aspect ratio and its REAL SIZE:
//
//   * Smaller than the frame → its original pixel size. A 1280x720 clip in a
//     1920x1080 project stays 1280x720.
//   * Larger than the frame → shrunk to fit, ratio intact (the contain-fit rect the
//     bars used to surround, minus the bars).
//
// The real size comes from the ORIGINAL file's own metadata, never from the
// texture: the preview plays a proxy whose pixels are smaller, and the plate must
// not change between the preview and an export. Until the size has loaded (or when
// it cannot be read) the clip fits the frame as before.
//
// Everything the layer's effects measure against — masks, roto, motion tracking,
// effects, rig pins, AutoFill, the transform origin — keeps the frame-shaped box
// they were authored against, scaled with the picture by the same real-size factor
// (`videoPlateScale`; layerMesh.js `fxFrame`). They stay on the same pixels of the
// footage however the picture is now sized.

const MAX_CACHE = 96;

// url -> { status: 'loading' | 'ready' | 'failed', width, height }
const sizeCache = new Map();
const sizeListeners = new Set();
// itemId -> { width, height, frameWidth, frameHeight }, published by the render pass
const plates = new Map();
const plateListeners = new Set();

function notify(set) {
  for (const listener of [...set]) {
    try { listener(); } catch { /* a dead subscriber must not stall the rest */ }
  }
}

/** Repaint hook for the renderer: a video's real size has loaded (or failed). */
export function subscribeVideoSize(listener) {
  sizeListeners.add(listener);
  return () => sizeListeners.delete(listener);
}

/** Repaint hook for the overlay: a size has loaded, or the render pass published a plate. */
export function subscribeVideoPlate(listener) {
  sizeListeners.add(listener);
  plateListeners.add(listener);
  return () => {
    sizeListeners.delete(listener);
    plateListeners.delete(listener);
  };
}

function evict() {
  while (sizeCache.size > MAX_CACHE) {
    const oldest = sizeCache.keys().next().value;
    sizeCache.delete(oldest);
  }
}

/**
 * Display size of a video url (rotation applied, as the browser presents it), or
 * null while it is still loading, when it failed, or outside a browser.
 */
function getVideoSize(url) {
  if (!url || typeof url !== 'string' || typeof document === 'undefined') return null;
  let entry = sizeCache.get(url);
  if (!entry) {
    entry = { status: 'loading', width: 0, height: 0 };
    sizeCache.set(url, entry);
    evict();
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    const settle = (ok) => {
      const w = video.videoWidth || 0;
      const h = video.videoHeight || 0;
      if (ok && w > 0 && h > 0) {
        entry.width = w;
        entry.height = h;
        entry.status = 'ready';
      } else {
        entry.status = 'failed';
      }
      video.onloadedmetadata = null;
      video.onerror = null;
      // Only the header was wanted: let go of the decoder and the connection.
      video.removeAttribute('src');
      try { video.load(); } catch { /* nothing to release */ }
      notify(sizeListeners);
    };
    video.onloadedmetadata = () => settle(true);
    video.onerror = () => settle(false);
    video.src = url;
  }
  return entry.status === 'ready' ? { width: entry.width, height: entry.height } : null;
}

/** The url whose pixels define a clip's real size: the original, not its proxy. */
function sourceUrl(clip) {
  return clip?.url || clip?.proxyUrl || '';
}

/**
 * How much smaller than its frame-fitted size a video draws: 1 when the clip
 * reaches the frame on either axis (it is shrunk to fit, exactly as before), below
 * 1 when it is smaller than the frame both ways (it keeps its own pixel size).
 * 1 for anything that is not a plain video, and while the size is still loading.
 */
export function videoPlateScale(clip, frameW, frameH) {
  if (!clip || clip.mediaType !== 'video' || clip.htmlSource) return 1;
  if (!(frameW > 0) || !(frameH > 0)) return 1;
  const url = sourceUrl(clip);
  let size = getVideoSize(url);
  // An original the browser cannot open (a camera codec — the reason it has a
  // proxy) still has the size the import probed. Never the proxy's: it is smaller.
  if (!size && sizeCache.get(url)?.status === 'failed' && clip.width > 0 && clip.height > 0) {
    size = { width: clip.width, height: clip.height };
  }
  if (!size) return 1;
  return Math.min(1, Math.max(size.width / frameW, size.height / frameH));
}

/**
 * Resolve once `url`'s size is known (or has failed), for the render warm-up: a
 * headless render draws its first frame the moment the gate opens, and a plate
 * resolved one frame late would export those frames blown up to the frame.
 */
export function preloadVideoPlate(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    getVideoSize(url);
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
    const off = subscribeVideoSize(() => { if (entry.status !== 'loading') finish(); });
    const timer = setTimeout(finish, timeoutMs);
  });
}

/**
 * Called by the render pass each frame for every drawn video layer: the picture's
 * rect (`width/height`) and the frame-shaped box its effects use
 * (`frameWidth/frameHeight`), both in composition px before the layer's own scale.
 */
export function setVideoPlate(itemId, plate) {
  if (!itemId || !plate || !(plate.width > 0) || !(plate.height > 0)) return;
  const prev = plates.get(itemId);
  if (prev
    && Math.abs(prev.width - plate.width) < 0.5
    && Math.abs(prev.height - plate.height) < 0.5
    && Math.abs(prev.frameWidth - plate.frameWidth) < 0.5
    && Math.abs(prev.frameHeight - plate.frameHeight) < 0.5) return;
  plates.set(itemId, {
    width: plate.width,
    height: plate.height,
    frameWidth: plate.frameWidth,
    frameHeight: plate.frameHeight,
  });
  notify(plateListeners);
}

/** The layer's published plate, or null before it has been drawn once. */
export function getVideoPlate(itemId) {
  return itemId ? plates.get(itemId) || null : null;
}
