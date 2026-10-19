/*
 * Pointer ergonomics shared by the on-canvas path editors (layer masks, object
 * motion paths). Look-dev: the "Path Draw" artifact.
 *
 * Every anchor and tangent knob keeps its drawn size but gets an INVISIBLE hit
 * disc around it — 9 px for a mouse, 22 px for a finger — so grabbing a knob
 * stops being a precision task. On touch the dragged point also rides above
 * the fingertip (the offset ramps in over the first 40 px of travel, so nothing
 * jumps at the start of a drag), a long press deletes an anchor and a second
 * tap on one toggles smooth ↔ corner — the gestures a phone has instead of
 * Alt-click and the Delete key.
 *
 * The coarse-pointer read happens once at load: a desktop with a mouse keeps its
 * exact sizes, a phone or tablet gets the fingertip ones.
 */

export const COARSE_POINTER = typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches;

/** Drawn-size multiplier for anchors and knobs (touch only). */
export const HANDLE_SCALE = COARSE_POINTER ? 1.6 : 1;

/** Radius of the invisible hit disc, in screen px (multiply by cssUnit). */
export const HIT_PX = COARSE_POINTER ? 22 : 9;

export const LONG_PRESS_MS = 650;
export const DOUBLE_TAP_MS = 320;
const LIFT_PX = 34;
const LIFT_RAMP_PX = 40;

export const isTouchEvent = (event) => event?.pointerType === 'touch';

/**
 * The finger offset. `p` and `start` come from an overlay's eventPoint(), whose
 * `threshold` is 5 screen px expressed in frame units — the conversion the
 * offset needs. Returns `p` moved up by up to LIFT_PX screen px, scaled in over
 * the first LIFT_RAMP_PX of travel from `start`.
 */
export function liftForTouch(p, start) {
  if (!p || !start || !Number.isFinite(start.threshold) || start.threshold <= 0) return p;
  const unit = start.threshold / 5;                       // frame units per screen px
  const dist = Math.hypot(p.x - start.x, p.y - start.y) / unit;
  const k = Math.min(1, dist / LIFT_RAMP_PX);
  return { ...p, y: p.y - LIFT_PX * k * unit };
}
