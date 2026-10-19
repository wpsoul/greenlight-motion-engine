// Which text layer (item id) is being edited inline in the preview, if any.
//
// Double-clicking a text layer in the preview (PreviewTransformOverlay) opens a
// DOM editor over the canvas showing the live text. While it is open the Player
// still runs the edited layer's full layout pass — the editor's box and the
// selection footprint come from it — but withholds the glyph paint, so the
// words aren't drawn twice (once by the browser, once by the plate texture).
//
// Module state rather than React state on purpose, the textFootprint.js
// arrangement in reverse: here the OVERLAY writes and the render loop reads,
// and the subscription lets the Player repaint the plate on enter/leave even
// when nothing else is invalidating frames (paused playhead, no edits yet).

const listeners = new Set();
let editingItemId = null;

/** The overlay's write. Pass an item id to start suppressing, null to stop. */
export function setInlineTextEdit(itemId) {
  const next = itemId || null;
  if (next === editingItemId) return;
  editingItemId = next;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* a dead subscriber must not stall the rest */ }
  }
}

/** The render loop's read: the item id being edited, or null. */
export function getInlineTextEditId() {
  return editingItemId;
}

export function subscribeInlineTextEdit(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
