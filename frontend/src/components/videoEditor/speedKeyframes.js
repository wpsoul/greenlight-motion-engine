// The speed curve, expressed as a KEYFRAME TRACK — the bridge that lets the
// Keyframe Builder drive a clip's retiming.
//
// The two shapes hold the same curve:
//
//   speedPoints          `{ x: 0-1 progress, y: rate }` anchors with tangent
//                        handles stored as OFFSETS (see speedUtils.js). This is
//                        what every consumer of the retiming reads — the timeline
//                        layout, the player, the exporter.
//   propertyKeyframes.speed
//                        `{ position: 0-100, value, easing }` keys, the shape the
//                        Keyframe Builder, the graph editor and the timeline
//                        pills already know how to edit.
//
// The track is AUTHORITATIVE whenever it exists: VideoEditor re-derives
// `speedPoints` from it on every write, so nothing downstream has to learn about
// keyframed speed, and the Speed Curve panel keeps drawing the same curve it
// always did (read-only, because the keys are the thing being edited).
//
// The mapping is exact, not an approximation. A keyframe's easing is a cubic
// bezier in the segment's unit box (easingCurves.js), and a speed-curve segment
// IS a cubic bezier between two anchors — so the easing's control points are the
// segment's control points, scaled by the segment's own dx / dy.
//
// A LEAF, like easingCurves.js: `easeFnFor` is passed in rather than imported,
// so this module stays loadable under `node --test` without GSAP.

import { TransitionEasing } from './types.js';
import { EASING_BEZIER, bezierHandlesFor, sanitizeBezier } from './easingCurves.js';
import { resolveSpeedCurve, getSpeedAtTime, splitSpeedSegmentAt, SPEED_MIN, SPEED_MAX } from './speedUtils.js';

// The track key. Deliberately a plain name rather than a namespaced one
// (`rig:`, `msk:`, `mp:`): there is exactly one speed track per layer, and the
// ƒx expression language reads it by this name.
export const SPEED_KF_KEY = 'speed';

// KF_PROPS-shaped entry, published to the builder only while the track exists —
// the buildLayerMaskKfProps pattern. Its own group so the row never hides among
// the transform properties.
export const SPEED_KF_PROP = {
  label: SPEED_KF_KEY,
  displayLabel: 'Speed',
  group: 'Time',
  placeholder: '1',
  unit: '×',
  type: 'number',
  min: SPEED_MIN,
  max: SPEED_MAX,
  step: 0.05,
  precision: 3,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, dp) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

// A hold has no bezier — it steps. The nearest thing a speed segment can do is
// sit on the old rate for the whole span and snap at the very end, which is what
// these controls draw. x stays monotonic (0 → .98 → .98 → 1), so the curve is
// still a function of time.
const HOLD_BEZIER = [0.98, 0, 0.98, 0];

const LINEAR_BEZIER = EASING_BEZIER[TransitionEasing.LINEAR];
const isLinearBezier = (b) => b.every((v, i) => Math.abs(v - LINEAR_BEZIER[i]) < 5e-4);

export const hasSpeedTrack = (item) => Array.isArray(item?.propertyKeyframes?.[SPEED_KF_KEY])
  && item.propertyKeyframes[SPEED_KF_KEY].length > 0;

/**
 * Keyframe track → speed-curve anchors.
 *
 * Keys hold their value BEFORE the first one and AFTER the last one (ordinary
 * keyframe semantics), so a track that does not span the whole clip gets flat
 * anchors pinned to x=0 / x=1 rather than being stretched to fit.
 *
 * `easeFnFor` resolves the easings that are not themselves a cubic bezier
 * (Bounce, Elastic) — pass gsapTransitions' `resolveKeyEase`. Without it those
 * fall back to a Smooth-shaped fit, which is the same fallback the graph editor's
 * handles use.
 */
export function speedTrackToPoints(track, easeFnFor = null) {
  if (!Array.isArray(track) || track.length === 0) return null;

  const keys = track
    .filter((k) => k && Number.isFinite(Number(k.position)))
    .map((k) => ({
      x: clamp(Number(k.position) / 100, 0, 1),
      y: clamp(Number.parseFloat(k.value) || 0, SPEED_MIN, SPEED_MAX),
      easing: k.easing || TransitionEasing.EASE_IN_OUT,
      bezier: k.bezier,
    }))
    .sort((a, b) => a.x - b.x);
  if (keys.length === 0) return null;

  // Hold before the first key / after the last one. The added anchor carries no
  // handles, so the run up to the first key is exactly flat.
  const anchors = keys.map((k) => ({ x: k.x, y: k.y }));
  if (keys[0].x > 0) anchors.unshift({ x: 0, y: keys[0].y });
  if (keys[keys.length - 1].x < 1) anchors.push({ x: 1, y: keys[keys.length - 1].y });

  // Which key's easing shapes each segment: the key at the segment's LEFT end,
  // exactly as gsapTransitions reads `low.easing`. The synthetic hold anchors
  // have none, and stay straight.
  const easeAt = new Map(keys.map((k) => [k.x, k]));

  for (let i = 0; i < anchors.length - 1; i += 1) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const key = easeAt.get(a.x);
    if (!key) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx <= 0) continue;
    const handles = key.easing === TransitionEasing.HOLD
      ? HOLD_BEZIER
      : bezierHandlesFor(key, easeFnFor || undefined);
    if (!handles) continue;
    const [x1, y1, x2, y2] = handles;
    // The easing box is normalised on the segment; scaling by (dx, dy) puts the
    // control points back where the speed curve wants them, as offsets from
    // their own anchor. resolveSpeedCurve clamps them into the legal box.
    a.manual = true;
    b.manual = true;
    a.hOut = { x: x1 * dx, y: y1 * dy };
    b.hIn = { x: (x2 - 1) * dx, y: (y2 - 1) * dy };
  }

  // An anchor is only `manual` if it actually carries a shaped handle; without
  // both, resolveSpeedCurve would replace the missing one with an auto tangent
  // anyway, so the flag is just noise on the ends.
  return anchors.map((a) => {
    const out = { x: round(a.x, 6), y: round(a.y, 6) };
    if (a.hIn) out.hIn = { x: round(a.hIn.x, 6), y: round(a.hIn.y, 6) };
    if (a.hOut) out.hOut = { x: round(a.hOut.x, 6), y: round(a.hOut.y, 6) };
    if (a.manual && (a.hIn || a.hOut)) out.manual = true;
    return out;
  });
}

/**
 * Speed-curve anchors → keyframe track. The inverse of the above, used once when
 * the clip's speed is handed to the Keyframe Builder and again whenever a preset
 * is applied while it is keyed.
 *
 * A segment whose anchors sit at the SAME rate but whose handles bulge cannot be
 * written as an easing at all — an easing is normalised by the value delta, and
 * that one is zero. Those segments come back as Linear, which is what the curve
 * looked like before anyone dragged a handle onto a flat run.
 */
export function speedPointsToTrack(points) {
  const curve = resolveSpeedCurve(points);
  if (!curve) return null;
  const { anchors } = curve;
  const track = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const position = round(clamp(a.x, 0, 1) * 100, 3);
    // The sanitizer drops duplicate positions; rounding two anchors onto the
    // same one would silently lose a key, so skip it here instead.
    if (track.length && track[track.length - 1].position === position) continue;
    const key = {
      position,
      value: String(round(clamp(a.y, SPEED_MIN, SPEED_MAX), 4)),
      easing: TransitionEasing.LINEAR,
    };
    if (b) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const bezier = (dx > 1e-9 && Math.abs(dy) > 1e-9)
        ? sanitizeBezier([
          (a.hOut?.x ?? dx / 3) / dx,
          (a.hOut?.y ?? dy / 3) / dy,
          1 + ((b.hIn?.x ?? -dx / 3) / dx),
          1 + ((b.hIn?.y ?? -dy / 3) / dy),
        ])
        : null;
      // A straight segment IS cubic-bezier(1/3, 1/3, 2/3, 2/3) — name it Linear
      // rather than storing a custom curve that says the same thing.
      if (bezier && !isLinearBezier(bezier)) {
        key.easing = TransitionEasing.CUSTOM;
        key.bezier = bezier;
      }
    }
    track.push(key);
  }
  return track.length ? track : null;
}

/**
 * Cut a speed track in two at clip progress `u` (0-1) — what splitting a keyed clip
 * does to its Speed keys, and the track twin of speedUtils.splitSpeedPoints.
 *
 * Keys keep their value and easing; only their position is re-expressed as a % of
 * the piece they fall in. A cut BETWEEN two keys adds a key at the cut on both
 * sides, at the rate the curve plays there, and the segment's two halves become
 * CUSTOM beziers cut out of the played curve — so neither piece retimes. A cut ON a
 * key just shares that key; a cut in the hold before the first key or after the last
 * one adds a single holding key to the piece that has none.
 *
 * Returns [firstTrack, secondTrack], or null when there is nothing to split.
 */
export function splitSpeedTrack(track, u, easeFnFor = null) {
  const points = speedTrackToPoints(track, easeFnFor);
  if (!points || !(u > 0) || !(u < 1)) return null;
  const keys = track
    .filter((k) => k && Number.isFinite(Number(k.position)))
    .map((k) => ({ k, pos: clamp(Number(k.position), 0, 100) }))
    .sort((a, b) => a.pos - b.pos);
  const cut = u * 100;
  const EPS = 1e-6;
  const before = keys.filter((e) => e.pos < cut - EPS);
  const after = keys.filter((e) => e.pos > cut + EPS);
  const on = keys.find((e) => Math.abs(e.pos - cut) <= EPS);
  const first = before.map(({ k, pos }) => ({ ...k, position: round(clamp(pos / u, 0, 100), 6) }));
  const second = after.map(({ k, pos }) => ({ ...k, position: round(clamp((pos - cut) / (1 - u), 0, 100), 6) }));

  if (on) {
    first.push({ ...on.k, position: 100 });
    second.unshift({ ...on.k, position: 0 });
  } else if (before.length && after.length) {
    const halves = splitSpeedSegmentAt(points, u);
    const left = before[before.length - 1].k;
    // A half of a straight segment is straight; anything else is the half's own
    // control points in its unit box (the inverse of speedTrackToPoints' scaling).
    const easeOf = (ctrl) => {
      const [p0, c1, c2, p3] = ctrl || [];
      const dx = p3 ? p3.x - p0.x : 0;
      const dy = p3 ? p3.y - p0.y : 0;
      if (left.easing === TransitionEasing.LINEAR || !(dx > 1e-9) || Math.abs(dy) < 1e-9) {
        return { easing: TransitionEasing.LINEAR };
      }
      const bezier = sanitizeBezier([
        (c1.x - p0.x) / dx, (c1.y - p0.y) / dy, (c2.x - p0.x) / dx, (c2.y - p0.y) / dy,
      ]);
      return bezier ? { easing: TransitionEasing.CUSTOM, bezier } : { easing: TransitionEasing.LINEAR };
    };
    const value = String(round(getSpeedAtTime(points, u), 6));
    const leftKey = { ...first[first.length - 1] };
    delete leftKey.bezier;
    first[first.length - 1] = { ...leftKey, ...easeOf(halves?.left) };
    first.push({ position: 100, value, easing: TransitionEasing.LINEAR });
    second.unshift({ position: 0, value, ...easeOf(halves?.right) });
  } else if (!before.length) {
    first.push({ position: 0, value: keys[0].k.value, easing: TransitionEasing.LINEAR });
  } else {
    second.unshift({ position: 0, value: keys[keys.length - 1].k.value, easing: TransitionEasing.LINEAR });
  }
  return [first, second];
}

/**
 * The `speedPoints` an item should carry, given its keyframes. Returns null when
 * the item has no speed track, i.e. when the stored curve is the authority.
 * Called from the single item-write choke point, so every editing surface —
 * the builder, the graph editor, a keyframe dragged on the timeline — retimes
 * the clip the same way.
 */
export function deriveSpeedPoints(item, easeFnFor = null) {
  if (!hasSpeedTrack(item)) return null;
  return speedTrackToPoints(item.propertyKeyframes[SPEED_KF_KEY], easeFnFor);
}
