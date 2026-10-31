// Render output size vs composition size.
//
// A server render (render-still, render-onserver, the Render Settings "Resolution"
// choice) may ask for an output size other than the project's own. Two meanings are
// possible, and they are NOT interchangeable:
//
//   • SAME SHAPE (720p / 4K of a 1080p project, 540×960 of 1080×1920): a SCALED copy
//     of the project. The composition stays at the project's size so every px value
//     (translate tracks, stroke widths, shape px, font px, motion paths, …) keeps its
//     meaning, and only the output is smaller or larger — what a user picking a
//     resolution expects.
//   • DIFFERENT SHAPE (16:9 out of a 9:16 project): there is no scale that maps one
//     frame onto the other, so it stays what it always was — the composition itself
//     is resized to the requested frame and the layout reflows.
//
// This module only DECIDES; the render page and Player apply it. Pure, no DOM.

const MIN_SIDE = 16;

/**
 * @param {{w:number,h:number}|null|undefined} output requested output size
 * @param {number} compW composition width (the project's videoSize.w)
 * @param {number} compH composition height
 * @returns {{w:number,h:number,upscale:boolean}|null} the scaled output, or null when
 *   there is nothing to scale (no request, the project's own size, or a different
 *   aspect ratio — the caller keeps its composition-resize behaviour then).
 */
export function resolveScaledOutputSize(output, compW, compH) {
  const w = Math.round(Number(output?.w));
  const h = Math.round(Number(output?.h));
  const cw = Math.round(Number(compW));
  const ch = Math.round(Number(compH));
  if (!(w >= MIN_SIDE && h >= MIN_SIDE && cw >= MIN_SIDE && ch >= MIN_SIDE)) return null;
  if (w === cw && h === ch) return null;
  // Same aspect within integer rounding: |w/h − cw/ch| expressed without division.
  // Each side may be off by ≤0.5 px from the exact scale, so the cross-product may
  // differ by up to ½(cw + ch); allow the larger side as the (still tight) bound.
  if (Math.abs(w * ch - h * cw) > Math.max(cw, ch)) return null;
  return { w, h, upscale: w > cw || h > ch };
}

/**
 * The drawing buffer a DOWNSCALED render draws one frame at, given the camera's
 * magnification of that frame.
 *
 * A downscale renders at the composition size and resamples to the output. Under a
 * camera zoom that resamples the footage twice: the GPU first magnifies it `zoom`×
 * into the composition-sized buffer (interpolated pixels, no new detail), and the
 * resampler then shrinks it back. A 2× zoom on a 4K recording in a 4K project
 * delivered at 1080p is a pixel-for-pixel crop of the source; magnify-then-shrink
 * turned its 1 px lines grey (a third of the edge sharpness — plan 1.8 of
 * PLANS/SCREEN_RECORDER_SMOOTH_MOTION_PLAN.md).
 *
 * So the buffer shrinks with the zoom, to the size at which a composition pixel
 * under the camera is one buffer pixel again (composition / zoom), and never below
 * the output, where the resample disappears altogether. It never grows: no zoom, a
 * zoom-out or an upscale keep today's buffer, and a zoomed frame draws fewer pixels.
 *
 * @param {{w:number,h:number,upscale:boolean}|null} scaled resolveScaledOutputSize's answer
 * @param {number} compW composition width
 * @param {number} compH composition height
 * @param {number} zoom the camera's magnification of the picture plane in this frame
 * @returns {{w:number,h:number}|null} the buffer, or null to keep the composition size
 */
export function resolveScaledRenderSize(scaled, compW, compH, zoom) {
  if (!scaled || scaled.upscale) return null;
  const cw = Math.round(Number(compW));
  const ch = Math.round(Number(compH));
  const z = Number(zoom);
  if (!(cw >= MIN_SIDE && ch >= MIN_SIDE) || !(z > 1)) return null;
  if (cw / z <= scaled.w || ch / z <= scaled.h) return { w: scaled.w, h: scaled.h };
  const w = Math.round(cw / z);
  const h = Math.round(ch / z);
  return w < cw || h < ch ? { w, h } : null;
}
