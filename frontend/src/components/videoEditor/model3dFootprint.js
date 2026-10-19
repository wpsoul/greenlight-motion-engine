// On-screen footprint of each 3D model layer, in composition pixels.
//
// The transform gizmo draws a layer's selection box from a centre plus a width and
// height. A plane layer's size is the frame; a shape's comes from its own fields; a
// model's is only known once its asset has parsed and been fitted, which happens
// inside the render pass. The pass publishes it here and the overlay reads it.
//
// This module exists purely so those two can share a value without the overlay
// importing model3dLayer — that module pulls GLTFLoader/RGBELoader/PMREMGenerator and
// is deliberately lazy-loaded, and a static import from the overlay would drag the
// whole thing into the main editor chunk. Nothing here has any dependency at all.

const footprints = new Map();

/** Called by the render pass each frame for every visible model layer. */
export function setModelFootprint(itemId, width, height) {
  if (!itemId || !(width > 0) || !(height > 0)) return;
  const prev = footprints.get(itemId);
  // Rewriting an identical value every frame would churn nothing, but skipping the
  // write keeps the map's identity stable for anything that memoises on it.
  if (prev && Math.abs(prev.width - width) < 0.01 && Math.abs(prev.height - height) < 0.01) return;
  footprints.set(itemId, { width, height });
}

/** The layer's fitted size, or null before its asset has been parsed and drawn once. */
export function getModelFootprint(itemId) {
  return itemId ? footprints.get(itemId) || null : null;
}

export function clearModelFootprint(itemId) {
  footprints.delete(itemId);
}
