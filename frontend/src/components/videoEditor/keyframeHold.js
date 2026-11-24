// Hold Keys: trimming a layer with Shift held leaves its keyframes where they are.
//
// A key's `position` is a % of the layer, so a plain trim stretches every track with
// the layer. Held, each track is re-expressed against the layer's new span instead,
// so every key keeps its moment (and the animation its pace); the edge only opens or
// closes the track.
//
// A key the edge closes over is not lost. Stored positions must stay inside 0-100
// (sanitizePropertyKeyframes clamps them on load, and every editing surface draws
// that range), so the visible track is CUT at the edge (keyframeSplit.js: a key at
// the edge holding the value the track has there, the segment's easing cut with it,
// which replays the same motion) and the whole track is kept beside it in
// `heldKeyframes`. The next held trim starts from the kept track, so pulling the
// edge back out brings the keys back.
//
// `heldKeyframes` = { from, to, trimStart, trimEnd, tracks: { <field>: { <prop>: track } } }
//   - a kept track's positions are a % of the span W the layer had before anything
//     was closed over (they may run below 0 or above 100: nothing but this file
//     reads them);
//   - the layer now shows [from, to] of W, as fractions;
//   - trimStart / trimEnd are the trims it was written for. A trim, split or retime
//     made any other way changes them, and the kept tracks then no longer describe
//     the layer: they are ignored, and dropped at the next save;
//   - a kept track is used only while the visible track is still the one it gives.
//     A track edited after the trim wins, as it stands.
//
// A LEAF, like keyframeSplit.js: the ease resolver and the track sampler are passed
// in, so this loads under `node --test`.

import { splitKeyframeTrack } from './keyframeSplit.js';

export const HELD_KEYFRAMES_FIELD = 'heldKeyframes';
export const HOLD_TRACK_FIELDS = ['propertyKeyframes', 'hiddenPropertyKeyframes'];

const CUT_EPS = 1e-9;      // a window edge this close to the track's end needs no cut
const POS_EPS = 1e-6;      // % of the layer: a key this far past an edge is on it
const TRIM_EPS = 1e-6;     // seconds
const SAME_POS = 1e-4;     // % of the layer: two positions that are one key
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finitePos = (k) => k && Number.isFinite(Number(k.position));

/**
 * Re-express a track against a new window. Its positions are a % of some base span
 * (any finite number); the result's are a % of [from, to], given as fractions of
 * that span, and always inside 0-100: where the window closes over keys the track is
 * cut at the edge. Null when a needed cut cannot be made (the sampler has no value
 * there); the caller then leaves the track as it was.
 */
export function rewindowTrack(track, from, to, { easeFnFor, valueAt, clampedT = false }) {
  const span = to - from;
  if (!Array.isArray(track) || !(span > 0)) return null;
  const keys = track.filter(finitePos);
  if (!keys.length) return track;
  const moved = keys.map((k) => ({ ...k, position: ((Number(k.position) / 100 - from) / span) * 100 }));
  let lo = Infinity;
  let hi = -Infinity;
  for (const k of moved) {
    lo = Math.min(lo, k.position);
    hi = Math.max(hi, k.position);
  }
  if (lo >= -POS_EPS && hi <= 100 + POS_EPS) {
    return moved.map((k) => ({ ...k, position: clamp(k.position, 0, 100) }));
  }
  // Keys lie outside the window: put the track and the window on one 0-100 scale,
  // then cut at the window's edges with the splitter a layer split uses.
  const start = Math.min(lo, 0);
  const width = Math.max(hi, 100) - start;
  let cutTrack = moved.map((k) => ({ ...k, position: clamp(((k.position - start) / width) * 100, 0, 100) }));
  const head = -start / width;
  let tail = (100 - start) / width;
  const opts = { easeFnFor, valueAt, clampedT };
  if (head > CUT_EPS) {
    const halves = splitKeyframeTrack(cutTrack, head, opts);
    if (!halves) return null;
    cutTrack = halves[1];
    tail = (tail - head) / (1 - head);
  }
  if (tail < 1 - CUT_EPS) {
    const halves = splitKeyframeTrack(cutTrack, tail, opts);
    if (!halves) return null;
    cutTrack = halves[0];
  }
  return cutTrack;
}

const asNumber = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const sameValue = (a, b) => {
  const x = asNumber(a);
  const y = asNumber(b);
  if (x === null || y === null) return String(a ?? '') === String(b ?? '');
  return Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x), Math.abs(y));
};

const sameNumbers = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((v, i) => Math.abs(Number(v) - Number(b[i])) <= 1e-6);

const sameEase = (a, b) => {
  if ((a.easing || '') !== (b.easing || '')) return false;
  if (!!a.bezier !== !!b.bezier || (a.bezier && !sameNumbers(a.bezier, b.bezier))) return false;
  const s = a.easeSlice;
  const t = b.easeSlice;
  if (!s !== !t) return false;
  return !s || (Math.abs(Number(s.from) - Number(t.from)) <= 1e-6 && Math.abs(Number(s.to) - Number(t.to)) <= 1e-6);
};

/**
 * The same track, as far as playback goes: a save and load re-types values and
 * re-sorts keys, which is not an edit.
 */
export function sameTrack(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const sort = (t) => t.filter(finitePos).sort((x, y) => Number(x.position) - Number(y.position));
  const x = sort(a);
  const y = sort(b);
  if (x.length !== y.length) return false;
  return x.every((k, i) => Math.abs(Number(k.position) - Number(y[i].position)) <= SAME_POS
    && sameValue(k.value, y[i].value) && sameEase(k, y[i]));
}

const cleanKey = (k) => {
  const key = { position: Number(k.position), value: typeof k.value === 'number' ? String(k.value) : String(k.value ?? '') };
  if (typeof k.easing === 'string') key.easing = k.easing;
  if (Array.isArray(k.bezier) && k.bezier.length === 4 && k.bezier.every((v) => Number.isFinite(Number(v)))) {
    key.bezier = k.bezier.map(Number);
  }
  const s = k.easeSlice;
  if (s && typeof s === 'object' && Number.isFinite(Number(s.from)) && Number.isFinite(Number(s.to))) {
    key.easeSlice = {
      ...(typeof s.of === 'string' ? { of: s.of } : null),
      from: Number(s.from),
      to: Number(s.to),
      ...(Array.isArray(s.bezier) && s.bezier.length === 4 && s.bezier.every((v) => Number.isFinite(Number(v)))
        ? { bezier: s.bezier.map(Number) } : null),
    };
  }
  return key;
};

/**
 * `heldKeyframes` as it may be stored on `item`, or null: well-formed, written for
 * the item's present trims, and only tracks the item still has. (The project
 * sanitizer's whitelist entry, and the reader this file uses itself.)
 */
export function sanitizeHeldKeyframes(held, item) {
  if (!held || typeof held !== 'object' || !item) return null;
  const from = Number(held.from);
  const to = Number(held.to);
  const trimStart = Number(held.trimStart);
  const trimEnd = Number(held.trimEnd);
  if (![from, to, trimStart, trimEnd].every(Number.isFinite) || !(to > from)) return null;
  if (Math.abs(trimStart - Number(item.trimStart)) > TRIM_EPS || Math.abs(trimEnd - Number(item.trimEnd)) > TRIM_EPS) return null;
  const tracks = {};
  for (const field of HOLD_TRACK_FIELDS) {
    const kept = held.tracks?.[field];
    const live = item[field];
    if (!kept || typeof kept !== 'object' || !live || typeof live !== 'object') continue;
    const out = {};
    for (const [prop, track] of Object.entries(kept)) {
      if (!Array.isArray(track) || !Array.isArray(live[prop]) || !live[prop].length) continue;
      const keys = track.filter(finitePos).map(cleanKey);
      if (keys.length) out[prop] = keys;
    }
    if (Object.keys(out).length) tracks[field] = out;
  }
  return Object.keys(tracks).length ? { from, to, trimStart, trimEnd, tracks } : null;
}

/**
 * What a held trim of `item` starts from, read once when the drag begins: every
 * track in full, on one span. Null when the item has no keys to hold.
 *
 * opts: { easeFnFor, valueAt(prop, track, pct), clampedT(prop), skip(prop) }.
 * `skip` names the tracks that are not layer animation (the Speed track is the
 * retime curve itself and stretches with the clip).
 */
export function buildKeyHoldBase(item, opts) {
  const trimStart = Number(item?.trimStart);
  const trimEnd = Number(item?.trimEnd);
  if (!(trimEnd - trimStart > 0)) return null;
  const held = sanitizeHeldKeyframes(item[HELD_KEYFRAMES_FIELD], item);
  const from = held ? held.from : 0;
  const to = held ? held.to : 1;
  const trackOpts = (prop) => ({
    easeFnFor: opts.easeFnFor,
    valueAt: (track, pct) => opts.valueAt(prop, track, pct),
    clampedT: !!opts.clampedT?.(prop),
  });
  const fields = {};
  let any = false;
  for (const field of HOLD_TRACK_FIELDS) {
    const tracks = item[field];
    if (!tracks || typeof tracks !== 'object') continue;
    const full = {};
    for (const [prop, track] of Object.entries(tracks)) {
      if (opts.skip?.(prop) || !Array.isArray(track) || !track.some(finitePos)) continue;
      const kept = held?.tracks?.[field]?.[prop];
      const shown = kept ? rewindowTrack(kept, from, to, trackOpts(prop)) : null;
      full[prop] = shown && sameTrack(shown, track)
        ? kept
        : track.filter(finitePos).map((k) => ({ ...k, position: (from + (Number(k.position) / 100) * (to - from)) * 100 }));
      any = true;
    }
    fields[field] = full;
  }
  return any ? { item, trimStart, trimEnd, from, to, fields, trackOpts } : null;
}

/** The three fields a held trim writes, as `item` has them (undefined = absent). */
export function keyHoldOrigin(item) {
  return {
    propertyKeyframes: item?.propertyKeyframes,
    hiddenPropertyKeyframes: item?.hiddenPropertyKeyframes,
    [HELD_KEYFRAMES_FIELD]: item?.[HELD_KEYFRAMES_FIELD],
  };
}

/**
 * The item's key fields for trims `trimStart` / `trimEnd`, with every key where it
 * was when the drag began. Always computed from the base, never from the previous
 * frame, so dragging an edge out and back leaves the item exactly as it was and
 * Shift can be pressed or released in the middle of a drag.
 *
 * Returns { propertyKeyframes, hiddenPropertyKeyframes, heldKeyframes } (undefined =
 * the field is absent), or null when the trims are not a span.
 */
export function holdKeyframes(base, trimStart, trimEnd) {
  const len = base.trimEnd - base.trimStart;
  const a = (trimStart - base.trimStart) / len;
  const b = (trimEnd - base.trimStart) / len;
  if (!(b - a > 0)) return null;
  if (Math.abs(a) < CUT_EPS && Math.abs(b - 1) < CUT_EPS) return keyHoldOrigin(base.item);
  const from = base.from + a * (base.to - base.from);
  const to = base.from + b * (base.to - base.from);
  const patch = keyHoldOrigin(base.item);
  const keptTracks = {};
  for (const [field, full] of Object.entries(base.fields)) {
    const out = { ...base.item[field] };
    for (const [prop, track] of Object.entries(full)) {
      const shown = rewindowTrack(track, from, to, base.trackOpts(prop));
      if (!shown) continue;
      out[prop] = shown;
      const outside = track.some((k) => k.position < from * 100 - POS_EPS || k.position > to * 100 + POS_EPS);
      if (outside) (keptTracks[field] ||= {})[prop] = track.map(cleanKey);
    }
    patch[field] = out;
  }
  patch[HELD_KEYFRAMES_FIELD] = Object.keys(keptTracks).length
    ? { from, to, trimStart, trimEnd, tracks: keptTracks }
    : undefined;
  return patch;
}
