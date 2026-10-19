// The laid-out box of each text layer, in composition pixels.
//
// A text layer draws on a COMPOSITION-SIZED canvas with the glyph run positioned
// inside it — unlike a shape, whose plate is its geometry. So the selection box had
// nothing to report but the frame, and the gizmo swallowed the whole preview no
// matter how small the words were.
//
// Only the text draw knows better: the block's extent falls out of the same line
// wrapping and alignment pass that positions the glyphs (fonts, letter spacing and
// the randomizer's per-unit sizes all move it). That pass publishes the box here and
// PreviewTransformOverlay reads it — the arrangement model3dFootprint.js already
// uses, plus an OFFSET, because a left- or right-aligned block does not sit on the
// layer's origin the way a shape or a model does.
//
// The box is the resting LAYOUT: per-token split animation and text-on-path move
// glyphs away from it, so path text publishes nothing and falls back to the frame.

const boxes = new Map();
const listeners = new Set();

/**
 * Repaint hook for the overlay. The box lands from the render loop, outside React —
 * without this the gizmo would keep the frame-sized fallback until some unrelated
 * state change happened to recompute it, which is exactly what a freshly added text
 * layer (selected before its first draw) never gets.
 */
export function subscribeTextFootprint(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Called by the text draw each frame for every visible text layer.
 * `offsetX/offsetY` are the box centre relative to the plate centre, y down.
 * `plateWidth/plateHeight` are the plate the block sits on (it can be wider than the
 * frame) — what an effect needs to turn the block into a fraction of the layer quad.
 */
export function setTextFootprint(itemId, box) {
  if (!itemId || !box || !(box.width > 0) || !(box.height > 0)) return;
  const prev = boxes.get(itemId);
  // Sub-pixel churn is not worth a React render: text whose size is keyframed would
  // otherwise notify on every single frame of the ramp.
  if (prev
    && Math.abs(prev.width - box.width) < 0.5
    && Math.abs(prev.height - box.height) < 0.5
    && Math.abs(prev.offsetX - box.offsetX) < 0.5
    && Math.abs(prev.offsetY - box.offsetY) < 0.5
    && Math.abs((prev.plateWidth || 0) - (box.plateWidth || 0)) < 0.5
    && Math.abs((prev.plateHeight || 0) - (box.plateHeight || 0)) < 0.5) return;
  boxes.set(itemId, {
    width: box.width,
    height: box.height,
    offsetX: box.offsetX || 0,
    offsetY: box.offsetY || 0,
    plateWidth: box.plateWidth > 0 ? box.plateWidth : 0,
    plateHeight: box.plateHeight > 0 ? box.plateHeight : 0,
  });
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* a dead subscriber must not stall the rest */ }
  }
}

/** The layer's laid-out box, or null before it has been drawn once. */
export function getTextFootprint(itemId) {
  return itemId ? boxes.get(itemId) || null : null;
}

export function clearTextFootprint(itemId) {
  if (!itemId || !boxes.has(itemId)) return;
  boxes.delete(itemId);
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* as above */ }
  }
}
