// Wheel-zoom rate limiting, shared by the board canvas (hooks/useCanvas.js) and
// the Video Editor preview (videoEditor/usePreviewViewport.js).
//
// Both coalesce wheel events into one rAF and apply the PRODUCT of every event
// in the batch. That is correct only while frames are cheap. Wheel events keep
// arriving at a hardware rate — 15-50 notches/s for a mouse, 60-120 events/s
// for a trackpad pinch — no matter how slow the frames are, and the browser
// queues (never drops) the ones that land while the main thread is busy. So on
// a machine under memory pressure, where a canvas frame can take 300-500ms, a
// single flush absorbs 20+ notches: 1.1^20 ≈ 6.7x, applied in one step. The
// user sees no intermediate state, gets no chance to steer, and the zoom reads
// as "harsh, too quick, not responsive" — which is exactly the burst, not a
// slow frame rate on its own.
//
// Capping what ONE frame may apply converts that burst back into a steady rate.
// The cap is deliberately generous enough never to bind on a healthy machine:
// at 60fps even a fast wheel spin is ~1-2 notches per frame, well under the
// limit, so nothing about the normal feel changes.

// Per-notch factors at speed 1 — the values the canvas has always used. They
// are intentionally asymmetric (0.9 * 1.1 = 0.99), preserved here so the
// default zoom feel is unchanged.
const STEP_IN = 1.1;
const STEP_OUT = 0.9;

// Most notches a single frame is allowed to apply. Three is above anything a
// 60fps frame collects from real input and far below the 20+ a stalled frame
// collects, so it only ever bites during a stall.
const MAX_NOTCHES_PER_FRAME = 3;

// A trackpad swipe is one continuous gesture, including its momentum tail.
// Chromium does not expose the input-device type, so remember how the gesture
// began instead of re-classifying every delta independently. 160ms is long
// enough to bridge momentum events while still letting the next deliberate
// wheel/trackpad action choose its own mode.
const WHEEL_GESTURE_GAP_MS = 160;

// App-settings key: multiplier on the per-notch step. 1 = the historical rate.
export const ZOOM_SPEED_PREF = "canvasZoomSpeed";
export const ZOOM_SPEED_DEFAULT = 1;

/**
 * Decide whether non-pinch wheel input should zoom (physical wheel) or pan
 * (trackpad), keeping that decision stable for the whole gesture.
 *
 * Large integer pixel deltas are ambiguous: a mouse wheel commonly sends them,
 * but a trackpad's vertical swipe also reaches them once it accelerates. The
 * old per-event heuristic therefore changed a fast swipe from pan into zoom
 * halfway through. A swipe normally starts with a small, fractional, or
 * diagonal delta; once that evidence selects pan, later large momentum deltas
 * stay pan until the gesture ends.
 */
export function createWheelGestureClassifier(gestureGapMs = WHEEL_GESTURE_GAP_MS) {
  let mode = null;
  let lastTime = -Infinity;

  return (event) => {
    const eventTime = Number.isFinite(event?.timeStamp)
      ? event.timeStamp
      : (typeof performance !== "undefined" ? performance.now() : Date.now());
    const newGesture = eventTime < lastTime || eventTime - lastTime > gestureGapMs;
    lastTime = eventTime;

    // Line-unit deltas are the only unambiguous physical-wheel signal.
    if (event?.deltaMode === 1) {
      mode = "zoom";
      return mode;
    }

    const deltaX = Number(event?.deltaX) || 0;
    const deltaY = Number(event?.deltaY) || 0;
    const trackpadEvidence = deltaX !== 0
      || !Number.isInteger(deltaY)
      || Math.abs(deltaY) < 40;

    if (newGesture || mode === null) {
      mode = trackpadEvidence ? "pan" : "zoom";
    } else if (mode === "zoom" && trackpadEvidence) {
      // Recover if the first event was an ambiguous large integer. Once pan is
      // known, never switch back during the momentum tail.
      mode = "pan";
    }

    return mode;
  };
}

function speedOf(speed) {
  return Number.isFinite(speed) && speed > 0 ? speed : ZOOM_SPEED_DEFAULT;
}

/** Factor for one mouse-wheel notch. `deltaY > 0` is zoom out. */
export function wheelNotchFactor(deltaY, speed = ZOOM_SPEED_DEFAULT) {
  return Math.pow(deltaY > 0 ? STEP_OUT : STEP_IN, speedOf(speed));
}

/** Factor for one pinch/ctrl-wheel event, scaled by the speed preference. */
export function pinchFactor(deltaY, speed = ZOOM_SPEED_DEFAULT) {
  return 1 + -deltaY * 0.01 * speedOf(speed);
}

/**
 * Clamp the zoom accumulated across one rAF batch. The excess is discarded
 * rather than carried into the next frame: carrying it would keep the canvas
 * zooming after the user's fingers stopped, which is the same loss of control
 * in a different costume.
 */
export function clampZoomFactor(factor, speed = ZOOM_SPEED_DEFAULT) {
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  const notches = MAX_NOTCHES_PER_FRAME * speedOf(speed);
  const maxIn = Math.pow(STEP_IN, notches);
  const maxOut = Math.pow(STEP_OUT, notches);
  return Math.min(maxIn, Math.max(maxOut, factor));
}
