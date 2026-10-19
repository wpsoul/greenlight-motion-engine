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
