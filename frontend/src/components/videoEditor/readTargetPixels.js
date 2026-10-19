/*
 * The one render-target readback for both backends.
 *
 * `renderer.readRenderTargetPixels()` is synchronous and DOES NOT EXIST on a
 * WebGPURenderer. Three call sites still used it — Auto Fill's matte crop, the
 * Rig deform bake, and the effect histogram/Extract probe — and two of them
 * carried a detailed comment describing this exact fix as though it had been
 * done. It had not. On WebGPU those bakes silently produced nothing usable:
 * Auto Fill exported plain white text instead of the coloured fill, and Rig
 * exported the undeformed layer.
 *
 * WHAT THE WEBGPU BUFFER ACTUALLY IS — measured, not assumed
 * (html/webgpu-migration/port/readback.html, and the regression test
 * tests/webgpu-migration/verify_readback.js):
 *
 *   width 37, height 8, RGBA8 → tight would be 1184 bytes; three returns 1940.
 *
 *   1. ROWS ARE PADDED to a 256-byte stride, WebGPU's copy alignment
 *      requirement. 1940 = 256×7 + 148: every row but the last is padded.
 *   2. ROWS ARE IN THE OPPOSITE ORDER. Reading at the padded stride recovers
 *      the written row ramp as 140,120,…,0 where WebGL gives 0,20,…,140.
 *
 * Both defects produce a plausible-looking buffer rather than an error, which is
 * how they survived: an alpha mask read out of a smeared buffer is still a mask,
 * just the wrong one.
 *
 * WHY THIS WAS NOT CAUGHT EARLIER, and it is worth knowing: every readback
 * comparison in this port used width 640. A 640-wide RGBA row is 2560 bytes,
 * which is ALREADY a multiple of 256 — so the padding could not show up, and
 * 39 composite states scored Δ 0 while the bug sat there. The regression test
 * therefore uses a deliberately unaligned width, and so should anything else
 * that checks readback.
 */

/**
 * Read a render target into a tight, WebGL-oriented `Uint8Array`.
 *
 * Always async, on both backends, so callers have one shape to await.
 *
 * @param {object} renderer  WebGLRenderer or WebGPURenderer
 * @param {object} target    the render target to read
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Uint8Array>} `width * height * 4` bytes, row 0 first,
 *   matching what `readRenderTargetPixels` hands back on WebGL.
 */
export async function readTargetPixels(renderer, target, width, height) {
  const tight = width * height * 4;

  // WebGL: the sync method exists and already returns exactly this layout.
  if (typeof renderer.readRenderTargetPixels === 'function') {
    const pixels = new Uint8Array(tight);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    return pixels;
  }

  if (typeof renderer.readRenderTargetPixelsAsync !== 'function') {
    throw new Error('readTargetPixels: renderer has neither readRenderTargetPixels '
      + 'nor readRenderTargetPixelsAsync');
  }

  // WebGPU: the promise RESOLVES to the buffer. Passing a destination array
  // instead makes three treat it as a texture handle and the read dies inside
  // its backend WeakMap, which reads as "Invalid value used as weak map key".
  const raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
  const rowBytes = width * 4;

  // A row already on the 256 boundary needs no unpacking — and that is the case
  // every previous test happened to use, so do not treat it as the normal one.
  if (raw.length === tight) return flipRows(raw, rowBytes, height);

  const stride = Math.ceil(rowBytes / 256) * 256;
  const out = new Uint8Array(tight);
  for (let row = 0; row < height; row += 1) {
    const src = row * stride;
    // Destination row is mirrored: the returned buffer's row 0 is the texture's
    // TOP row, where WebGL hands back the BOTTOM.
    const dst = (height - 1 - row) * rowBytes;
    out.set(raw.subarray(src, src + rowBytes), dst);
  }
  return out;
}

function flipRows(buf, rowBytes, height) {
  const out = new Uint8Array(buf.length);
  for (let row = 0; row < height; row += 1) {
    out.set(buf.subarray(row * rowBytes, (row + 1) * rowBytes), (height - 1 - row) * rowBytes);
  }
  return out;
}
