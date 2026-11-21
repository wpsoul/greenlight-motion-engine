/*
 * (farmparity) A render farm pod's frame as pictures: the world's handoff canvas (WorldRenderer.readHandoff: the picture band over its
 * depth band — each pixel's distance in its R and G, its coverage in B — and the masks band below while world mattes ask). Pure: a pod's
 * render page (exporter.js `farmPod`) uses it, and the node tests.
 */

/** A frame's sub-frames (handoffs) as one, as the exporter averages a frame's sub-frames (motionBlur.js renderAccumulated): the picture and
 *  its coverage averaged, the nearest surface any of them saw as the depth, and empty where none saw one; the masks band (world mattes)
 *  averaged too. `meta` is the first's, with `motion: 'sub-frames'`. */
export function averageHandoffs(frames) {
  const { width: w, height: h, bands = 2 } = frames[0];
  const rows = Math.floor(h / bands), k = frames.length, px = w * rows;
  const out = new Uint8Array(frames[0].data.length);
  for (let i = 0; i < px * 4; i += 4) {
    let r = 0, g = 0, b = 0;
    for (const f of frames) { r += f.data[i]; g += f.data[i + 1]; b += f.data[i + 2]; }
    out[i] = Math.round(r / k); out[i + 1] = Math.round(g / k); out[i + 2] = Math.round(b / k); out[i + 3] = 255;
  }
  for (let i = px * 4; i < 2 * px * 4; i += 4) {
    let near = Infinity, cover = 0;
    for (const f of frames) {
      const hi = f.data[i], lo = f.data[i + 1];
      cover += f.data[i + 2];
      if (!(hi === 255 && lo === 255)) near = Math.min(near, hi * 256 + lo);
    }
    out[i] = near === Infinity ? 255 : Math.floor(near / 256); out[i + 1] = near === Infinity ? 255 : near % 256;
    out[i + 2] = Math.round(cover / k); out[i + 3] = 255;
  }
  for (let i = 2 * px * 4; i < out.length; i += 4) {
    let r = 0, g = 0, b = 0;
    for (const f of frames) { r += f.data[i]; g += f.data[i + 1]; b += f.data[i + 2]; }
    out[i] = Math.round(r / k); out[i + 1] = Math.round(g / k); out[i + 2] = Math.round(b / k); out[i + 3] = 255;
  }
  return { width: w, height: h, bands, data: out, meta: { ...frames[0].meta, motion: 'sub-frames', subFrames: k } };
}
