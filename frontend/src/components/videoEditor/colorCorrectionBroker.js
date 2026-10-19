/*
 * One owner for the pixels Color Correction's Auto buttons and pickers need.
 *
 * The panel owns the gesture; the Player owns the textures and the canvas. Same
 * shape as fxProbeBroker / pointPickBroker: the panel ASKS here, the Player serves.
 *
 *   readCcSource(itemId)        the layer's SOURCE picture (the texture its clip
 *                               material samples, before any grade), small RGBA —
 *                               what Auto White Balance / Auto Tone / Auto Levels
 *                               and the Levels histogram analyse.
 *   sampleCcFrame(itemId, x, y, stage)
 *                               the composited preview colour under a point
 *                               (percent of the composition), rendered once with
 *                               this layer's correction bypassed ('src') or
 *                               stopped at the input to Levels ('pre') — what the
 *                               white-balance and Levels pickers sample.
 *
 * Both resolve null when there is nothing to read (no renderer, the layer is not
 * on screen at the playhead, a render-target texture the 2D canvas cannot draw).
 */

let provider = null;

/** The Player installs `{ readSource, sampleFrame }`. Returns an unsubscribe. */
export function setColorCorrectionProvider(next) {
  provider = next;
  return () => { if (provider === next) provider = null; };
}

export function readCcSource(itemId, { width = 320 } = {}) {
  if (!provider || !itemId) return Promise.resolve(null);
  return provider.readSource(itemId, width);
}

export function sampleCcFrame(itemId, x, y, stage = 'src') {
  if (!provider || !itemId) return Promise.resolve(null);
  return provider.sampleFrame(itemId, x, y, stage);
}

/**
 * Draw a texture's source (video element, image, canvas, ImageBitmap, VideoFrame)
 * into a small 2D canvas and read it back. Render-target textures have no
 * drawable image and come back null.
 */
export function readTextureImagePixels(texture, width = 320) {
  const src = texture?.image;
  if (!src || texture.isRenderTargetTexture) return null;
  const w0 = src.videoWidth || src.naturalWidth || src.displayWidth || src.width;
  const h0 = src.videoHeight || src.naturalHeight || src.displayHeight || src.height;
  if (!(w0 > 0) || !(h0 > 0)) return null;
  const w = Math.max(1, Math.min(width, w0));
  const h = Math.max(1, Math.round((w * h0) / w0));
  try {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
  } catch {
    return null;   // tainted / not drawable
  }
}

/** Average a (2r+1)² block of a data-URL picture at (u, v) in 0..1. Resolves [r, g, b] 0..255. */
export function sampleDataUrl(url, u, v, r = 2) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        const cx = Math.round(Math.min(1, Math.max(0, u)) * (w - 1));
        const cy = Math.round(Math.min(1, Math.max(0, v)) * (h - 1));
        const x0 = Math.max(0, cx - r), y0 = Math.max(0, cy - r);
        const bw = Math.min(w, cx + r + 1) - x0, bh = Math.min(h, cy + r + 1) - y0;
        const c = document.createElement('canvas');
        c.width = bw; c.height = bh;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, x0, y0, bw, bh, 0, 0, bw, bh);
        const d = ctx.getImageData(0, 0, bw, bh).data;
        const s = [0, 0, 0]; let n = 0;
        for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 8) continue; s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; n++; }
        resolve(n ? s.map((x) => x / n) : null);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
