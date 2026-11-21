/*
 * A channel's active clip at a time, and (filmbugs) which clip a sub-frame of a render's motion blur draws. Pure (no three, no DOM): the
 * compositor imports them through engine/compositeHelpers.js; node tests in shutterHold.test.mjs.
 */
export function resolveActiveIndex(layout, time) {
  // Small epsilon so float rounding exactly at a shot boundary doesn't momentarily
  // resolve to no clip (which would blank the channel for a frame). Inclusive bounds
  // bias toward the incoming clip at an exact boundary, which is what we want.
  const EPS = 1e-6;
  for (let i = layout.length - 1; i >= 0; i -= 1) {
    if (time >= layout[i].startTime - EPS && time <= layout[i].endTime + EPS) return i;
  }
  return -1;
}

/**
 * (filmbugs) The time a channel is drawn at in a sub-frame of a render's motion blur (`frameTime`: the frame's own time, exporter.js
 * engine.shutterFrameTime): the clip showing at the frame's own time stays for the whole shutter, at the sub-frame's time held inside its
 * span, and a channel empty at the frame's time stays empty. A cut, an in or out point is never blurred (as a Scene object's `visible` keys
 * and the Scene layer itself: rig3d.js shutterEntries); a clip's motion inside its span still is. A page ending 4 ms after a frame showed
 * at 76 % over what lay under it, and a clip starting mid-shutter came in half-transparent: a soft dip at every cut of a film.
 */
export function shutterTimeIn(layout, frameTime, time) {
  if (!Number.isFinite(frameTime) || !Number.isFinite(time) || !Array.isArray(layout)) return time;
  const i = resolveActiveIndex(layout, frameTime);
  if (i < 0) return frameTime;
  // inside the span by more than resolveActiveIndex's EPS, so a clip starting where this one ends does not take the boundary
  const lo = layout[i].startTime + 2e-6, hi = layout[i].endTime - 2e-6;
  return hi < lo ? frameTime : Math.min(hi, Math.max(lo, time));
}

