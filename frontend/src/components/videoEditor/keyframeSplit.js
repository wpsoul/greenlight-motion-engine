// Splitting a layer at the playhead: what happens to its keyframes.
//
// Keys sit at a % of the clip's TIMELINE span (the Player samples tracks at
// (t − start) / duration), so a cut at fraction `u` of the clip puts each key in one
// half, re-expressed as a % of that half. A cut BETWEEN two keys adds a key at the
// cut to both halves, holding the value the track has there, and cuts the segment's
// easing in two (cutSegment), so the two halves together replay the uncut animation
// exactly instead of each replaying all of it. A cut ON a key shares that key. A cut
// before the first key or after the last gives the piece that has none a single
// holding key: a track with no keys falls back to the layer's static value, which is
// not what was on screen.
//
// The track twin of speedKeyframes.splitSpeedTrack, for every other track. A LEAF,
// like easingCurves.js: the ease resolver and the track sampler are passed in
// (gsapTransitions' resolveKeyEase / evaluatePropertyTrack), so this module loads
// under `node --test` without GSAP.

import { TransitionEasing } from './types.js';
import { sanitizeBezier, sanitizeEaseSlice } from './easingCurves.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round6 = (v) => Math.round(v * 1e6) / 1e6;

// A window whose eased ends sit this many times closer together than the curve
// swings between them gets an extra key at its turn (see easeWindows).
const MAX_SPREAD = 8;
const SPREAD_SAMPLES = 128;
const BREAK_SAMPLES = 512;

const withoutEase = (key) => {
  const { easing: _e, bezier: _b, easeSlice: _s, ...rest } = key;
  return rest;
};

// The key's easing with no slice, as the whole-segment easing it plays. A CUSTOM key
// whose curve is unusable plays Smooth (resolveKeyEase's fallback), so it is cut as one.
function wholeEase(key) {
  const easing = key?.easing || TransitionEasing.LINEAR;
  if (easing !== TransitionEasing.CUSTOM) return { easing };
  const bezier = sanitizeBezier(key.bezier);
  return bezier ? { easing, bezier } : { easing: TransitionEasing.EASE_IN_OUT };
}

// Where `ease` turns, or crosses 0 or 1, strictly inside (a, b): the cuts that leave
// every piece monotone and either inside [0, 1] or wholly outside it.
function clampBreaks(ease, a, b) {
  const step = (b - a) / BREAK_SAMPLES;
  const breaks = [];
  const bisect = (lo, hi, level) => {
    const below = ease(lo) < level;
    for (let i = 0; i < 60; i += 1) {
      const mid = (lo + hi) / 2;
      if ((ease(mid) < level) === below) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const extremum = (lo, hi, isMax) => {
    for (let i = 0; i < 60; i += 1) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      if ((ease(m1) < ease(m2)) === isMax) lo = m1;
      else hi = m2;
    }
    return (lo + hi) / 2;
  };
  let prevT = a;
  let prevE = ease(a);
  let dir = 0;
  for (let i = 1; i <= BREAK_SAMPLES; i += 1) {
    const t = i === BREAK_SAMPLES ? b : a + step * i;
    const e = ease(t);
    for (const level of [0, 1]) {
      if ((prevE - level) * (e - level) < 0) breaks.push(bisect(prevT, t, level));
      else if (e === level && i < BREAK_SAMPLES) breaks.push(t);
    }
    const d = Math.sign(e - prevE);
    if (d !== 0 && dir !== 0 && d !== dir) breaks.push(extremum(Math.max(a, prevT - step), t, dir > 0));
    if (d !== 0) dir = d;
    prevT = t;
    prevE = e;
  }
  const inside = breaks.filter((t) => t > a + 1e-9 && t < b - 1e-9).sort((x, y) => x - y);
  return inside.filter((t, i) => i === 0 || t - inside[i - 1] > 1e-9);
}

const sliceFields = (base, a, b) => ({
  ...base,
  easeSlice: { of: base.easing, from: a, to: b, ...(base.bezier ? { bezier: [...base.bezier] } : null) },
});

/**
 * The easing fields that make a segment play window [a, b] of `base`'s whole easing,
 * as one or more pieces covering the window in order: [{ from, to, fields }].
 *
 * Every shaped easing is SLICED (easingCurves.js), CUSTOM and the bezier-drawn named
 * ones included. Re-fitting part of a bezier as a new bezier looks exact on paper but
 * is not in playback: bezierEase solves x only to 1e-4, and a different curve takes a
 * different error, which measured up to 0.3% of the move. A slice plays the original
 * function through the original solver.
 *
 * A window is normally one piece. It is cut again where it would be ill-conditioned:
 * a segment eases between its two keys' values, so a window whose eased ends nearly
 * coincide (a Bounce cut where it touches 1, a Back In cut where it crosses 0) has
 * keys holding nearly the same value and an easing that swings far beyond them. The
 * values are stored to finite precision (colours to 8 bits, paths to 4 decimals), and
 * that swing multiplies the rounding. A key at the turn keeps every piece's swing
 * within a couple of times its own span.
 *
 * `clampedT` tracks (shape and mask paths) blend with the eased t CLAMPED to [0, 1]
 * (interpolateShapePaths), so they never overshoot, and clamping does not survive a
 * slice: part of a Back, Elastic or Bounce curve re-normalized between new ends
 * clamps at different places. There the window is cut at every turn and every
 * crossing of 0 and 1. A piece inside [0, 1] is then monotone and slices exactly; a
 * piece outside it is held, which is what the clamp showed.
 */
function easeWindows(base, a, b, easeFnFor, { clampedT = false } = {}, depth = 0) {
  const { easing } = base;
  const one = (fields) => [{ from: a, to: b, fields }];
  if (easing === TransitionEasing.LINEAR || easing === TransitionEasing.HOLD) return one({ easing });

  const ease = easeFnFor(base);
  if (clampedT) {
    const bounds = [a, ...clampBreaks(ease, a, b), b];
    return bounds.slice(0, -1).map((from, i) => {
      const to = bounds[i + 1];
      const mid = ease((from + to) / 2);
      if (!(mid > 0 && mid < 1)) return { from, to, fields: { easing: TransitionEasing.LINEAR } };
      return { from, to, fields: from <= 0 && to >= 1 ? { ...base } : sliceFields(base, from, to) };
    });
  }
  if (a <= 0 && b >= 1) return one({ ...base });

  const e0 = ease(a);
  const span = ease(b) - e0;
  let lo = Math.min(e0, e0 + span);
  let hi = Math.max(e0, e0 + span);
  let turn = null;
  let far = 0;
  for (let i = 1; i < SPREAD_SAMPLES; i += 1) {
    const t = a + ((b - a) * i) / SPREAD_SAMPLES;
    const e = ease(t);
    lo = Math.min(lo, e);
    hi = Math.max(hi, e);
    if (Math.abs(e - e0) > far) {
      far = Math.abs(e - e0);
      turn = t;
    }
  }
  const swing = hi - lo;
  if (depth < 4 && turn != null && swing > 1e-9 && swing > MAX_SPREAD * Math.abs(span)) {
    return [
      ...easeWindows(base, a, turn, easeFnFor, {}, depth + 1),
      ...easeWindows(base, turn, b, easeFnFor, {}, depth + 1),
    ];
  }
  return one(sliceFields(base, a, b));
}

/**
 * Cut the segment that follows key `low` at `t` (0-1 of the segment). Returns the
 * pieces of each side; `at` is a piece's start as a fraction of the segment.
 */
function cutSegment(low, t, easeFnFor, opts) {
  const prior = sanitizeEaseSlice(low);
  const from = prior ? prior.from : 0;
  const to = prior ? prior.to : 1;
  const cut = from + (to - from) * t;
  const base = wholeEase(low);
  const local = (pieces) => pieces.map((p) => ({ ...p, at: (p.from - from) / (to - from) }));
  return {
    left: local(easeWindows(base, from, cut, easeFnFor, opts)),
    right: local(easeWindows(base, cut, to, easeFnFor, opts)),
  };
}

/**
 * Split one track at clip progress `u` (0-1). `valueAt(track, pct)` samples the track
 * the way the renderer does and returns a number (stored to 6 decimals) or the
 * string a key would hold (a colour, an encoded path). `easeFnFor` is
 * resolveKeyEase. `clampedT`: the track blends with the eased t clamped to [0, 1]
 * (shape and mask paths; see easeWindows).
 *
 * Returns [firstTrack, secondTrack], or null when the track cannot be cut (no usable
 * keys, or a value the sampler cannot produce). The caller then keeps it whole.
 */
export function splitKeyframeTrack(track, u, { easeFnFor, valueAt, clampedT = false }) {
  if (!Array.isArray(track) || !(u > 0) || !(u < 1)) return null;
  const keys = track
    .filter((k) => k && Number.isFinite(Number(k.position)))
    .map((k) => ({ k, pos: clamp(Number(k.position), 0, 100) }))
    .sort((a, b) => a.pos - b.pos);
  if (!keys.length) return null;
  const cut = u * 100;
  const EPS = 1e-6;
  // Positions keep full precision: a Hold steps exactly AT its next key, and a key
  // sitting on a frame would otherwise step a frame late once rounding nudged it.
  const firstPos = (pos) => clamp(pos / u, 0, 100);
  const secondPos = (pos) => clamp((pos - cut) / (1 - u), 0, 100);
  const sample = (pct) => {
    const v = valueAt(track, pct);
    if (typeof v === 'number') return Number.isFinite(v) ? String(round6(v)) : undefined;
    return typeof v === 'string' && v !== '' ? v : undefined;
  };

  const before = keys.filter((e) => e.pos < cut - EPS);
  const after = keys.filter((e) => e.pos > cut + EPS);
  const on = keys.find((e) => Math.abs(e.pos - cut) <= EPS);
  const first = before.map(({ k, pos }) => ({ ...k, position: firstPos(pos) }));
  const second = after.map(({ k, pos }) => ({ ...k, position: secondPos(pos) }));

  if (on) {
    first.push({ ...on.k, position: 100 });
    second.unshift({ ...on.k, position: 0 });
    return [first, second];
  }
  if (!before.length) {
    first.push({ position: 0, value: keys[0].k.value, easing: TransitionEasing.LINEAR });
    return [first, second];
  }
  if (!after.length) {
    second.unshift({ position: 0, value: keys[keys.length - 1].k.value, easing: TransitionEasing.LINEAR });
    return [first, second];
  }

  const low = before[before.length - 1];
  const high = after[0];
  const width = high.pos - low.pos;
  const value = sample(cut);
  if (value === undefined) return null;
  const { left, right } = cutSegment(low.k, (cut - low.pos) / width, easeFnFor, { clampedT });
  // Keys at the turns easeWindows added, at their place on the uncut track.
  const turns = (pieces, toPos) => {
    const out = [];
    for (const p of pieces.slice(1)) {
      const pct = low.pos + p.at * width;
      const v = sample(pct);
      if (v === undefined) return null;
      out.push({ position: toPos(pct), value: v, ...p.fields });
    }
    return out;
  };
  const leftTurns = turns(left, firstPos);
  const rightTurns = turns(right, secondPos);
  if (!leftTurns || !rightTurns) return null;

  first[first.length - 1] = { ...withoutEase(first[first.length - 1]), ...left[0].fields };
  first.push(...leftTurns, { position: 100, value, easing: TransitionEasing.LINEAR });
  second.unshift({ position: 0, value, ...right[0].fields }, ...rightTurns);
  return [first, second];
}

/**
 * Split every track of a `propertyKeyframes`-shaped map. `splitOne(prop, track)` may
 * claim a track (the Speed track has its own splitter); it returns [a, b] or
 * undefined to fall through to splitKeyframeTrack. `clampedT(prop)` names the tracks
 * that clamp their eased t. A track that cannot be cut is kept whole on both halves.
 */
export function splitKeyframeTracks(tracks, u, { easeFnFor, valueAt, splitOne = null, clampedT = null }) {
  const first = {};
  const second = {};
  for (const [prop, track] of Object.entries(tracks || {})) {
    const claimed = splitOne ? splitOne(prop, track) : undefined;
    const halves = claimed !== undefined
      ? claimed
      : splitKeyframeTrack(track, u, {
        easeFnFor,
        valueAt: (t, pct) => valueAt(prop, t, pct),
        clampedT: !!clampedT?.(prop),
      });
    first[prop] = halves ? halves[0] : track;
    second[prop] = halves ? halves[1] : track;
  }
  return [first, second];
}
