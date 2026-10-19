/*
 * Motion Tracking — the pure half.
 *
 * A track is analysed ONCE (motionTracker.js, in a worker) and stored on the
 * timeline ITEM that owns the footage. Everything downstream — preview, export,
 * the sequence and adjustment compositors, headless /video-render — reads the
 * stored samples through this module. Computer vision never runs at render time.
 *
 * Two decisions here are load-bearing:
 *
 *  1. Samples are in the tracked clip's SOURCE seconds, positions normalised to
 *     the source frame. Trims, splits and speed ramps then cost nothing (the
 *     same reasoning as clip.recordingMeta), and a track analysed on the 1280px
 *     proxy applies unchanged to the original.
 *
 *  2. A track is IDENTITY AT refTime. Everything a follower gets is a delta from
 *     that frame, so wherever the user parked the follower at refTime *is* the
 *     offset — there are no offset fields to keep in sync, and re-tracking never
 *     moves a layer the user has already placed.
 *
 * Storage lives on the item because mapping composition time → the footage's
 * source time needs a specific item's trimStart/speedPoints; the same clip can
 * appear on the timeline many times. Same precedent as item.cameraPath.
 */

import { getItemKeyframeValues } from './gsapTransitions';
import { localPrs, timelineSpansShareFrame } from './keyframeParenting';
import { getTimelineDuration, mapTimelineToSource } from './speedUtils';
import { containedSourceScale } from './mediaFit';

const DEG2RAD = Math.PI / 180;
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);

// Sample tuple: [tSourceSec, cx, cy, scale, rotationDeg, confidence].
export const MT_T = 0;
export const MT_CX = 1;
export const MT_CY = 2;
export const MT_SCALE = 3;
export const MT_ROT = 4;
export const MT_CONF = 5;

export const MOTION_TRACK_MODES = ['transform', 'position', 'global'];
export const MOTION_FOLLOW_MODES = ['ride', 'pin', 'lock'];
export const MOTION_TRACK_MODE_LABELS = {
  transform: 'Position + scale + rotation',
  position: 'Position only',
  global: 'Camera / whole frame',
};

// Below this a sample is guesswork, not measurement: the path draws it dashed,
// the panel counts it as a gap, and the tracker refuses to publish a tail of it.
export const MT_CONF_USABLE = 0.35;

// The tracker's tunables, surfaced in the panel's Advanced options. The values
// MUST mirror TRACKER_DEFAULTS in motionTracker.js — duplicated here because
// that module drags the WebCodecs decoder and the OpenCV loader with it, and
// importing it from the main bundle would undo the startup bundle split.
export const MOTION_TRACKER_OPTION_DEFAULTS = {
  mode: 'transform',
  maxFeatures: 180,
  quality: 0.008,
  minDistance: 6,
  winSize: 21,
  levels: 3,
  fbThreshold: 1,
  reseedBelow: 0.4,
  appearanceGate: true,
  minNcc: 0.3,
  analysisWidth: 640,
};

/** Clamp a raw options object (panel state, localStorage) into safe engine input. */
export function sanitizeMotionTrackerOptions(raw) {
  const d = MOTION_TRACKER_OPTION_DEFAULTS;
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: MOTION_TRACK_MODES.includes(o.mode) ? o.mode : d.mode,
    maxFeatures: clamp(Math.round(num(o.maxFeatures, d.maxFeatures)), 20, 400),
    quality: clamp(num(o.quality, d.quality), 0.001, 0.06),
    minDistance: clamp(Math.round(num(o.minDistance, d.minDistance)), 2, 24),
    // LK windows must be odd — an even size silently rounds inside OpenCV.
    winSize: (() => { const w = clamp(Math.round(num(o.winSize, d.winSize)), 9, 41); return w % 2 ? w : w + 1; })(),
    levels: clamp(Math.round(num(o.levels, d.levels)), 1, 5),
    fbThreshold: clamp(num(o.fbThreshold, d.fbThreshold), 0.2, 4),
    reseedBelow: clamp(num(o.reseedBelow, d.reseedBelow), 0.1, 0.9),
    appearanceGate: o.appearanceGate !== false,
    minNcc: clamp(num(o.minNcc, d.minNcc), 0, 0.8),
    analysisWidth: [320, 480, 640, 960].includes(Number(o.analysisWidth)) ? Number(o.analysisWidth) : d.analysisWidth,
  };
}

export function makeMotionTrackId() {
  return `mt-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

/* ── Sanitize ──────────────────────────────────────────────────────────────
   Rebuilt from scratch rather than patched: a track arrives from a worker, a
   pasted clip, a portable board folder or a hand-edited project file, and a
   malformed sample would otherwise reach the render path as NaN — which
   propagates silently through the whole transform chain. */

function sanitizeSamples(raw, fps) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  let prevT = -Infinity;
  for (const s of raw) {
    if (!Array.isArray(s) || s.length < 6) continue;
    const t = Number(s[MT_T]);
    const cx = Number(s[MT_CX]);
    const cy = Number(s[MT_CY]);
    const sc = Number(s[MT_SCALE]);
    const rot = Number(s[MT_ROT]);
    const conf = Number(s[MT_CONF]);
    if (!Number.isFinite(t) || !Number.isFinite(cx) || !Number.isFinite(cy)) continue;
    if (!Number.isFinite(sc) || !Number.isFinite(rot) || !Number.isFinite(conf)) continue;
    if (t < prevT - 1e-6) continue;          // must be monotonic to binary-search
    prevT = t;
    out.push([
      t,
      // Deliberately NOT clamped to 0..1: an object tracked off the edge of the
      // frame has a real position outside it, and clamping would fold the path
      // back onto the border instead of leaving the follower where it belongs.
      cx, cy,
      clamp(sc, 0.001, 1000),
      rot,
      clamp01(conf),
    ]);
  }
  void fps;
  return out;
}

export function sanitizeMotionTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // Leftover Stabilize-feature tracks (v1 self-lock / cameraPath). Drop them.
  if (raw.stabilize) return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : makeMotionTrackId();
  const samples = sanitizeSamples(raw.samples);
  if (samples.length < 2) return null;
  const region = raw.region && typeof raw.region === 'object' ? raw.region : {};
  const mode = MOTION_TRACK_MODES.includes(raw.mode) ? raw.mode : 'transform';
  const aspect = num(raw.sourceAspect, 0);
  const track = {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : 'Track 1',
    version: 1,
    mode,
    refTime: num(raw.refTime, samples[0][MT_T]),
    region: {
      x: clamp(num(region.x, 0.4), -2, 3),
      y: clamp(num(region.y, 0.4), -2, 3),
      w: clamp(num(region.w, 0.2), 0.005, 3),
      h: clamp(num(region.h, 0.2), 0.005, 3),
    },
    sourceFps: clamp(num(raw.sourceFps, 30), 1, 240),
    // Aspect of the frames the track was measured on. Needed to turn normalised
    // source offsets into composition pixels through the layer's cover fit; 0
    // means "assume the layer's own box", which is right for a full-frame layer.
    sourceAspect: aspect > 0 ? aspect : 0,
    samples,
  };
  if (raw.useRange && typeof raw.useRange === 'object') {
    track.useRange = {
      start: num(raw.useRange.start, samples[0][MT_T]),
      end: num(raw.useRange.end, samples[samples.length - 1][MT_T]),
    };
    const used = motionTrackUseSpan(track);
    if (used?.trimmed) track.useRange = { start: used.start, end: used.end };
    else delete track.useRange;
  }
  const segs = Array.isArray(raw.segments) ? raw.segments : null;
  track.segments = segs
    ? segs
      .filter((s) => s && Number.isFinite(Number(s.start)) && Number.isFinite(Number(s.end)))
      .map((s) => ({ start: Number(s.start), end: Number(s.end) }))
    : computeMotionTrackSegments(track);
  return track;
}

export function sanitizeMotionTracks(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const track = sanitizeMotionTrack(entry);
    if (!track || seen.has(track.id)) continue;
    seen.add(track.id);
    out.push(track);
  }
  return out.slice(0, 12);
}

/**
 * A live link, kept deliberately FAIL-OPEN on referential integrity: the target
 * item may legitimately be missing right now (paste order, an undo mid-flight, a
 * sequence not yet expanded) and dropping the link during sanitize would destroy
 * user intent that a later edit would have restored. The resolver below no-ops on
 * a dangling reference, so the cost of keeping it is nothing.
 */
export function sanitizeMotionFollow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const itemId = typeof raw.itemId === 'string' ? raw.itemId.trim() : '';
  const trackId = typeof raw.trackId === 'string' ? raw.trackId.trim() : '';
  if (!itemId || !trackId) return null;
  return {
    itemId,
    trackId,
    position: raw.position !== false,
    scale: raw.scale !== false,
    rotation: raw.rotation !== false,
    // What the link DOES with the motion. Three genuinely different jobs, and
    // conflating the last two is a trap:
    //   ride — keep this layer's transform, add the tracked motion to it. Where
    //          you place the layer at refTime is the offset.
    //   pin  — put the layer ON the tracked point, ignoring where it was. For a
    //          badge or an arrow that should sit on the thing, with nothing to
    //          line up by hand.
    //   lock — cancel the motion (the inverse similarity about the tracked
    //          point) so the subject stands still and the FOOTAGE moves under
    //          it. That is stabilisation, and it only makes sense applied to the
    //          footage the track came from: on a small layer parked elsewhere it
    //          swings that layer around a pivot far outside it, which reads as
    //          chaos rather than as a lock.
    mode: MOTION_FOLLOW_MODES.includes(raw.mode)
      ? raw.mode
      : (raw.stabilize === true ? 'lock' : 'ride'),
    // ± this many source frames averaged. Cheap, and the only knob that makes a
    // jittery hand-held track usable without re-analysing it.
    smoothing: clamp(Math.round(num(raw.smoothing, 0)), 0, 30),
    // Crop zoom for `lock`, about the tracked point: a locked subject has to
    // hide the edges the inverse correction drags into view. Ignored by ride/pin.
    zoom: clamp(num(raw.zoom, 1), 1, 4),
  };
}

export const isSelfFollow = (item) => !!item?.motionFollow && item.motionFollow.itemId === item.id;

/**
 * Re-point a follow when items are cloned (duplicate, paste, group into a
 * sequence, ungroup). Same contract as remapParentingIds/remapTrackMatteIds: a
 * target outside the copied set is dropped rather than left pointing at the
 * ORIGINAL layer — a duplicated pair must not silently share one link, and a
 * self-follow (object lock) must survive as a self-follow on the copy.
 */
export function remapMotionFollowIds(item, idMap) {
  const follow = item?.motionFollow;
  if (!follow) return item;
  const mapped = idMap?.get ? idMap.get(follow.itemId) : idMap?.[follow.itemId];
  if (!mapped) {
    const { motionFollow, ...rest } = item;
    void motionFollow;
    return rest;
  }
  return { ...item, motionFollow: { ...follow, itemId: mapped } };
}

/** Strip the link outright (single-layer / cross-project paste). Tracks stay:
 *  they belong to the footage on this item, not to a relationship. */
export function stripMotionFollow(item) {
  if (!item?.motionFollow) return item;
  const { motionFollow, ...rest } = item;
  void motionFollow;
  return rest;
}

export function motionTracksOf(item) {
  return Array.isArray(item?.motionTracks) ? item.motionTracks : [];
}
export function findMotionTrack(item, trackId) {
  return motionTracksOf(item).find((t) => t?.id === trackId) || null;
}

/* ── Spans ─────────────────────────────────────────────────────────────────
   Anything longer than ~1.5 sample intervals is a hole the tracker refused to
   paper over (an occlusion it could not follow through). Followers interpolate
   across holes — that is the desired behaviour, a glide rather than a snap —
   but the UI has to SAY so, or a user reads the smooth result as a good track. */
export function computeMotionTrackSegments(track) {
  const samples = track?.samples || [];
  const dt = 1 / clamp(num(track?.sourceFps, 30), 1, 240);
  const segs = [];
  let start = null;
  let prev = null;
  for (const s of samples) {
    if (start === null) start = s[MT_T];
    else if (s[MT_T] - prev > dt * 1.5) { segs.push({ start, end: prev }); start = s[MT_T]; }
    prev = s[MT_T];
  }
  if (start !== null) segs.push({ start, end: prev });
  return segs;
}

export function motionTrackSpan(track) {
  const s = track?.samples || [];
  if (!s.length) return null;
  return { start: s[0][MT_T], end: s[s.length - 1][MT_T] };
}

/** The non-destructive part of a track the user has chosen to trust. The raw
 *  samples stay intact so the handles can always be widened again. */
export function motionTrackUseSpan(track) {
  const full = motionTrackSpan(track);
  if (!full) return null;
  const samples = track.samples;
  const duration = Math.max(0, full.end - full.start);
  if (!(duration > 1e-9)) return { ...full, trimmed: false };
  let start = clamp(num(track?.useRange?.start, full.start), full.start, full.end);
  let end = clamp(num(track?.useRange?.end, full.end), full.start, full.end);
  if (end < start) [start, end] = [end, start];
  // Handles choose TRACKING POINTS, not arbitrary seconds (which could land in
  // a lost gap and leave a visually non-empty range containing no measurement).
  let startIndex = nearestSampleIndex(samples, start);
  let endIndex = nearestSampleIndex(samples, end);
  if (endIndex < startIndex) [startIndex, endIndex] = [endIndex, startIndex];
  if (startIndex === endIndex && samples.length > 1) {
    if (endIndex < samples.length - 1) endIndex += 1;
    else startIndex -= 1;
  }
  start = samples[startIndex][MT_T];
  end = samples[endIndex][MT_T];
  const eps = Math.max(1e-6, motionTrackFrameStep(track) * 0.01);
  return {
    start,
    end,
    trimmed: start > full.start + eps || end < full.end - eps,
  };
}

/** Write/reset the trusted span without deleting any analysed samples. */
export function setMotionTrackUseRange(track, start, end) {
  if (!track?.samples?.length) return track;
  const candidate = { ...track, useRange: { start, end } };
  const used = motionTrackUseSpan(candidate);
  if (!used) return track;
  if (used.trimmed) candidate.useRange = { start: used.start, end: used.end };
  else delete candidate.useRange;
  return candidate;
}

/** Reference deltas move with the left range handle if the original reference
 *  frame was excluded. That makes the first USED frame identity. */
export function motionTrackEffectiveRefTime(track) {
  const used = motionTrackUseSpan(track);
  if (!used) return num(track?.refTime, 0);
  return clamp(num(track?.refTime, used.start), used.start, used.end);
}

export function motionTrackUsesTime(track, tSource) {
  const used = motionTrackUseSpan(track);
  return !!used && tSource >= used.start - 1e-6 && tSource <= used.end + 1e-6;
}

/* ── Sampling ──────────────────────────────────────────────────────────────
   Binary search + lerp, holding at both ends. Rotation interpolates along the
   SHORT arc: a track that crosses ±180° would otherwise spin the follower a full
   turn between two adjacent frames. */
export function sampleMotionTrack(track, tSource) {
  const s = track?.samples;
  if (!s || !s.length) return null;
  if (s.length === 1 || tSource <= s[0][MT_T]) return sampleObj(s[0]);
  if (tSource >= s[s.length - 1][MT_T]) return sampleObj(s[s.length - 1]);
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid][MT_T] <= tSource) lo = mid; else hi = mid;
  }
  const a = s[lo];
  const b = s[hi];
  const span = b[MT_T] - a[MT_T];
  const u = span > 1e-9 ? (tSource - a[MT_T]) / span : 0;
  let dr = b[MT_ROT] - a[MT_ROT];
  if (dr > 180) dr -= 360;
  if (dr < -180) dr += 360;
  return {
    cx: a[MT_CX] + (b[MT_CX] - a[MT_CX]) * u,
    cy: a[MT_CY] + (b[MT_CY] - a[MT_CY]) * u,
    scale: a[MT_SCALE] + (b[MT_SCALE] - a[MT_SCALE]) * u,
    rot: a[MT_ROT] + dr * u,
    conf: a[MT_CONF] + (b[MT_CONF] - a[MT_CONF]) * u,
  };
}

function sampleObj(s) {
  return { cx: s[MT_CX], cy: s[MT_CY], scale: s[MT_SCALE], rot: s[MT_ROT], conf: s[MT_CONF] };
}

export function sampleMotionTrackSmoothed(track, tSource, smoothing, usedOnly = false) {
  if (usedOnly && !motionTrackUsesTime(track, tSource)) return null;
  const k = clamp(Math.round(num(smoothing, 0)), 0, 30);
  if (!k) return sampleMotionTrack(track, tSource);
  const dt = 1 / clamp(num(track?.sourceFps, 30), 1, 240);
  let cx = 0; let cy = 0; let sc = 0; let rot = 0; let conf = 0; let n = 0;
  const base = sampleMotionTrack(track, tSource);
  if (!base) return null;
  for (let i = -k; i <= k; i += 1) {
    const sampleTime = tSource + i * dt;
    if (usedOnly && !motionTrackUsesTime(track, sampleTime)) continue;
    const s = sampleMotionTrack(track, sampleTime);
    if (!s) continue;
    cx += s.cx; cy += s.cy; sc += s.scale; conf += s.conf;
    // Unwrap against the centre sample, or averaging across ±180° cancels out.
    let d = s.rot - base.rot;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    rot += base.rot + d;
    n += 1;
  }
  return n ? { cx: cx / n, cy: cy / n, scale: sc / n, rot: rot / n, conf: conf / n } : base;
}

/* ── Time mapping ──────────────────────────────────────────────────────────
   Composition seconds → the tracked footage's source seconds, through THIS
   item's trim and speed ramp. Same arithmetic as Player's calculateVideoTime;
   duplicated here rather than imported so the pure module stays free of the
   render layer (and testable on its own). */
export function compTimeToSourceTime(item, entry, t) {
  const trimStart = num(item?.trimStart, 0);
  const trimEnd = num(item?.trimEnd, 0);
  const sourceDuration = trimEnd - trimStart;
  if (!(sourceDuration > 0)) return trimStart;
  const start = num(entry?.startTime, 0);
  const timelineDuration = getTimelineDuration(sourceDuration, item?.speedPoints);
  if (!(timelineDuration > 0)) return trimStart;
  const normalized = clamp01((t - start) / timelineDuration);
  return trimStart + mapTimelineToSource(item?.speedPoints, normalized) * sourceDuration;
}

/** The reverse — where a source second lands on the timeline. Used to park the
 *  playhead on a track's reference frame when the user goes back to re-anchor. */
export function sourceTimeToCompTime(item, entry, tSource) {
  const trimStart = num(item?.trimStart, 0);
  const trimEnd = num(item?.trimEnd, 0);
  const sourceDuration = trimEnd - trimStart;
  const start = num(entry?.startTime, 0);
  if (!(sourceDuration > 0)) return start;
  const target = clamp01((tSource - trimStart) / sourceDuration);
  const points = item?.speedPoints;
  const timelineDuration = getTimelineDuration(sourceDuration, points);
  if (!points || points.length < 2) return start + target * timelineDuration;
  // mapTimelineToSource is monotonic; invert it by bisection (12 rounds ≈ 1/4096
  // of the clip, well under a frame) rather than duplicating its ramp algebra.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i += 1) {
    const mid = (lo + hi) * 0.5;
    if (mapTimelineToSource(points, mid) < target) lo = mid; else hi = mid;
  }
  return start + ((lo + hi) * 0.5) * timelineDuration;
}

/* ── The delta ─────────────────────────────────────────────────────────────
   A normalised offset in the FOOTAGE becomes composition pixels only after
   going through the tracked layer's own transform: how big its box is on screen,
   how the source is contain-fitted into that box, and how the layer is rotated.
   Skip any of those and the link drifts the moment someone scales or spins the
   layer the track lives on. */
function containScale(track, boxW, boxH) {
  const aspect = num(track?.sourceAspect, 0);
  return containedSourceScale(boxW, boxH, aspect);
}

/**
 * Resolve `item.motionFollow` at composition time `t`.
 *
 * @returns {null | {dxPx, dyPx, scaleMul, rotateDeg, mode, conf, anchorPx}}
 *   dxPx/dyPx are composition pixels, y DOWN (screen sense). rotateDeg is
 *   clockwise-positive, matching the item's own `rotation`/`rotate` degrees.
 *   anchorPx is where the tracked point sits on screen — the pivot object lock
 *   corrects about.
 */
export function resolveMotionFollowDelta({ index, item, t, W, H }) {
  const follow = item?.motionFollow;
  if (!follow || !index) return null;
  const entry = index.get(follow.itemId);
  const tracked = entry?.item;
  if (!tracked) return null;                                  // dangling: fail open
  // A kept relationship whose clips were later dragged apart must be inert.
  // compTimeToSourceTime deliberately clamps outside a clip; without this guard
  // a non-overlapping follower kept the source track's final transform forever,
  // contradicting both the candidate rules and the panel warning.
  if (t < num(entry.startTime) - 1e-6 || t > num(entry.endTime) + 1e-6) return null;
  const track = findMotionTrack(tracked, follow.trackId);
  if (!track) return null;

  const tSource = compTimeToSourceTime(tracked, entry, t);
  // The range handles are an editorial gate, not a destructive trim: outside
  // them this link is inert even though the original analysis remains stored.
  if (!motionTrackUsesTime(track, tSource)) return null;
  const refTime = motionTrackEffectiveRefTime(track);
  const now = sampleMotionTrackSmoothed(track, tSource, follow.smoothing, true);
  const ref = sampleMotionTrackSmoothed(track, refTime, follow.smoothing, true);
  if (!now || !ref) return null;

  let dRot = now.rot - ref.rot;
  if (dRot > 180) dRot -= 360;
  if (dRot < -180) dRot += 360;
  const dScale = ref.scale > 1e-6 ? now.scale / ref.scale : 1;

  // The tracked layer's own pose at this instant. Read from its RAW keyframes —
  // never from a followed result — so a self-follow (object lock) cannot feed
  // its own correction back into the delta that produced it.
  const trackedEntry = entry;
  const duration = num(trackedEntry.endTime) - num(trackedEntry.startTime);
  const progress = duration > 0 ? clamp01((t - trackedEntry.startTime) / duration) : 0;
  const prs = localPrs(tracked, getItemKeyframeValues(tracked, progress), W, H);
  const boxW = Math.abs(prs.sx) * W;
  const boxH = Math.abs(prs.sy) * H;
  const { kx, ky } = containScale(track, boxW, boxH);

  // Layer-local offset, then rotated into composition space. rz is THREE's
  // (Y-up, CCW); on a y-down screen the same angle reads clockwise, which is
  // exactly the sense of `rotation` degrees — hence the negation.
  const lx = (now.cx - ref.cx) * kx;
  const ly = (now.cy - ref.cy) * ky;
  const phi = -prs.rz;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);

  // Where the tracked point is on screen right now: layer centre + the tracked
  // offset from the layer's own centre (the region centre in source uv).
  const ax = (now.cx - 0.5) * kx;
  const ay = (now.cy - 0.5) * ky;

  return {
    dxPx: follow.position ? lx * cos - ly * sin : 0,
    dyPx: follow.position ? lx * sin + ly * cos : 0,
    scaleMul: follow.scale ? dScale : 1,
    rotateDeg: follow.rotation ? dRot : 0,
    mode: follow.mode || 'ride',
    position: follow.position !== false,
    zoom: clamp(num(follow.zoom, 1), 1, 4),
    conf: now.conf,
    anchorPx: {
      x: prs.px + (ax * cos - ay * sin),
      // prs.py is Y-UP; the anchor offset is screen-down, so it subtracts.
      y: -prs.py + (ax * sin + ay * cos),
    },
  };
}

/**
 * Fold a resolved delta into a canonical PRS (the one applyMeshTransform is
 * about to write to the mesh). Two different jobs:
 *
 *   ride — the follower keeps its own transform and the track adds to it,
 *   rotating and scaling about the follower's own anchor. This is the additive
 *   parenting rule, and it is why placing the layer at refTime is the offset.
 *
 *   pin — the layer's anchor goes ON the tracked point every frame. Same result
 *   as riding along from a perfectly-placed start, minus the placing.
 *
 *   lock — cancel the motion instead, so the subject stands still and the layer
 *   moves under it. Correcting only the position leaves a rotating or looming
 *   subject sliding around, so the correction is a real similarity about the
 *   tracked point: C(x) = P + (1/s)·R(θ)·(x − P − d). This is for the FOOTAGE the
 *   track came from; on a small layer parked elsewhere the same maths swings it
 *   around a distant pivot, which is correct and useless.
 */
export function applyMotionFollowToPrs(prs, delta, W, H) {
  if (!delta) return prs;
  const out = { ...prs };

  if (delta.mode !== 'lock') {
    out.rz -= delta.rotateDeg * DEG2RAD;        // rz = −degrees (see localPrs)
    out.sx *= delta.scaleMul;
    out.sy *= delta.scaleMul;
    if (delta.mode === 'pin') {
      // Straight onto the tracked point. Note this is NOT the same as riding
      // along from a hand-placed start: that is base + delta, which keeps
      // whatever offset the layer had, while this discards it so the layer
      // needs no lining up at all.
      if (delta.position) {
        out.px = num(delta.anchorPx?.x, out.px);
        out.py = -num(delta.anchorPx?.y, -out.py);
      }
    } else {
      out.px += delta.dxPx;
      out.py -= delta.dyPx;                     // px is Y-up, the delta is y-down
    }
    return out;
  }

  const s = delta.scaleMul > 1e-6 ? delta.scaleMul : 1;
  // The ride-along branch adds −rotateDeg·DEG2RAD to rz, so cancelling it means
  // adding the OPPOSITE. Same angle then rotates the pivot offset, which is what
  // keeps the correction a true similarity about the tracked point rather than a
  // rotation about the frame centre with a translation bolted on.
  const th = delta.rotateDeg * DEG2RAD;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  // Pivot in THREE space (Y-up): where the tracked point sat at refTime, i.e. its
  // position now minus the motion being cancelled. anchorPx.y is y-DOWN.
  const px0 = num(delta.anchorPx?.x, 0) - delta.dxPx;
  const py0 = -(num(delta.anchorPx?.y, 0) - delta.dyPx);
  // C(x) = P₀ + (1/s)·R(θ)·(x − P(t)), with P(t) = P₀ + d — so the delta is
  // SUBTRACTED here. Adding it would move the layer WITH the subject at double
  // rate, which is what a sign slip looks like on screen: the lock runs away.
  const vx = out.px - px0 - delta.dxPx;
  const vy = out.py - py0 + delta.dyPx;         // d is y-down, this space is y-up
  out.px = px0 + (vx * cos - vy * sin) / s;
  out.py = py0 + (vx * sin + vy * cos) / s;
  out.rz += th;
  out.sx /= s;
  out.sy /= s;
  // Crop zoom, about the same pivot: at refTime the lock is identity, so this
  // is a plain zoom on the picture as placed, and every other frame is zoomed
  // about the point the correction holds still — which is where the black
  // edges would otherwise come in from.
  const zoom = num(delta.zoom, 1);
  if (zoom > 1 + 1e-9) {
    out.px = px0 + (out.px - px0) * zoom;
    out.py = py0 + (out.py - py0) * zoom;
    out.sx *= zoom;
    out.sy *= zoom;
  }
  void W; void H;
  return out;
}

/* ── Panel data ────────────────────────────────────────────────────────────
   Every track a layer could follow: any layer that shares a rendered frame with
   it, plus the layer itself (object lock). Built where the whole timeline is
   visible, like collectParentCandidates / collectMatteCandidates. */
export function collectMotionTrackCandidates({ index, item, clipsMap, fps = 30, clipNameFor = null }) {
  const out = [];
  if (!index || !item) return out;
  const selfEntry = index.get(item.id);
  if (!selfEntry) return out;
  const currentId = item.motionFollow?.itemId || null;

  for (const [id, entry] of index) {
    const tracks = motionTracksOf(entry.item);
    if (!tracks.length) continue;
    const isSelf = id === item.id;
    const shares = isSelf || timelineSpansShareFrame(selfEntry, entry, fps);
    // The layer currently linked stays listed even if the clips were dragged
    // apart afterwards — surfacing it as `noOverlap` beats silently dropping a
    // relationship the user built.
    if (!shares && id !== currentId) continue;
    const clip = clipsMap ? clipsMap.get(entry.item.clipId) : null;
    const name = (clipNameFor ? clipNameFor(entry.item, clip) : clip?.name) || 'Layer';
    for (const track of tracks) {
      const span = motionTrackUseSpan(track);
      out.push({
        itemId: id,
        trackId: track.id,
        isSelf,
        label: isSelf ? `This layer · ${track.name}` : `${name} · ${track.name}`,
        name,
        trackName: track.name,
        channelIndex: entry.channelIndex,
        startTime: entry.startTime,
        endTime: entry.endTime,
        sourceStart: span?.start ?? 0,
        sourceEnd: span?.end ?? 0,
        gaps: Math.max(0, (track.segments?.length || 1) - 1),
        noOverlap: !shares,
        isCurrent: id === currentId && track.id === item.motionFollow?.trackId,
      });
    }
  }
  // Own tracks first (object lock is the nearest thing to hand), then stack order.
  out.sort((a, b) => (Number(b.isSelf) - Number(a.isSelf))
    || (b.channelIndex - a.channelIndex)
    || (a.startTime - b.startTime));
  return out;
}

/* ── Preview overlay geometry ──────────────────────────────────────────────
   Source uv → composition frame pixels (y down, origin top-left), through the
   layer's cover fit, pose and rotation. Shared by the path and the box so the
   two can never disagree about where the tracked point is. */
function frameMapper({ track, item, entry, W, H, t }) {
  const duration = num(entry?.endTime) - num(entry?.startTime);
  // The layer's pose AT THIS MOMENT — a fixed mid-clip guess would slide the
  // box off the object on any layer that animates.
  const progress = duration > 0 && Number.isFinite(t)
    ? clamp01((t - num(entry?.startTime)) / duration)
    : 0.5;
  const prs = localPrs(item, getItemKeyframeValues(item, progress), W, H);
  const boxW = Math.abs(prs.sx) * W;
  const boxH = Math.abs(prs.sy) * H;
  const { kx, ky } = containScale(track, boxW, boxH);
  const phi = -prs.rz;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  return (u, v) => {
    const ax = (u - 0.5) * kx;
    const ay = (v - 0.5) * ky;
    return {
      x: prs.px + (ax * cos - ay * sin) + W / 2,
      y: -prs.py + (ax * sin + ay * cos) + H / 2,
    };
  };
}

/**
 * The source-uv → composition-pixel mapping for one layer at one instant, as a
 * reusable function. The camera solve's point cloud has to land on the footage
 * through exactly the same route a track's box and path do — layer pose, cover
 * fit, rotation — so it borrows this rather than growing a second copy that can
 * disagree. `track` is only read for `sourceAspect`, so a bare
 * `{ sourceAspect }` is a legitimate argument.
 */
export function motionTrackFrameMapper({ track, item, entry, W, H, t }) {
  return frameMapper({ track, item, entry, W, H, t });
}

/** Path polyline for the preview overlay, in composition pixels (y down). */
export function motionTrackPathPoints({ track, item, entry, W, H, every = 1 }) {
  if (!track?.samples?.length) return [];
  const used = motionTrackUseSpan(track);
  if (!used) return [];
  const samples = track.samples.filter((s) => (
    s[MT_T] >= used.start - 1e-6 && s[MT_T] <= used.end + 1e-6
  ));
  if (!samples.length) return [];
  const step = Math.max(1, Math.round(every));
  const out = [];
  const append = (s) => {
    // A source layer can itself be keyframed. Map every path point through that
    // sample's real composition-time pose instead of freezing the entire route
    // through the layer's mid-clip transform.
    const t = sourceTimeToCompTime(item, entry, s[MT_T]);
    const toFrame = frameMapper({ track, item, entry, W, H, t });
    const p = toFrame(s[MT_CX], s[MT_CY]);
    out.push({ x: p.x, y: p.y, conf: s[MT_CONF], t: s[MT_T] });
  };
  for (let i = 0; i < samples.length; i += step) append(samples[i]);
  // A narrow use range on a long analysis can be shorter than the display
  // stride. Keep its right boundary visible instead of drawing a single dot.
  const last = samples[samples.length - 1];
  if (out[out.length - 1]?.t !== last[MT_T]) append(last);
  return out;
}

/**
 * The tracked REGION as it sits on this frame — the thing a user actually reads
 * to know whether a track is holding. Four corners plus the centre crosshair, in
 * composition pixels.
 *
 * The pose scales and rotates in the footage's own PIXELS, so the region has to
 * be taken into a square-pixel space (normalise by height, hence the aspect
 * factor) before it is rotated, or the box shears on any non-square frame.
 *
 * `pose` overrides the stored samples — that is how the live box follows a run
 * in progress, before there is a track to sample.
 */
export function motionTrackBoxAt({ track, item, entry, W, H, t, pose = null }) {
  if (!track?.region) return null;
  let outOfSpan = false;
  const src = pose || (() => {
    const tSource = compTimeToSourceTime(item, entry, t);
    const s = sampleMotionTrack(track, tSource);
    if (!s) return null;
    const span = motionTrackUseSpan(track);
    // Outside the analysed span the sampler holds the end value. Hiding the box
    // there was wrong: on a track that stopped early — which is exactly when a
    // user needs to see what happened — the box silently vanished and left only
    // a stub of path behind. Show it, clamped, and mark it so the overlay can
    // draw it as the ghost it is.
    if (span && (tSource < span.start - 1e-3 || tSource > span.end + 1e-3)) outOfSpan = true;
    return s;
  })();
  if (!src) return null;

  const reg = track.region;
  const A = num(track.sourceAspect, 0) > 0 ? track.sourceAspect : 1;
  const th = num(src.rot, 0) * DEG2RAD;
  const sc = num(src.scale, 1);
  const cos = Math.cos(th) * sc;
  const sin = Math.sin(th) * sc;
  const hw = (reg.w / 2) * A;
  const hh = reg.h / 2;
  const cx = num(src.cx, 0.5) * A;
  const cy = num(src.cy, 0.5);

  const toFrame = frameMapper({ track, item, entry, W, H, t });
  const corner = (sx, sy) => {
    const x = cx + (cos * (sx * hw) - sin * (sy * hh));
    const y = cy + (sin * (sx * hw) + cos * (sy * hh));
    return toFrame(x / A, y);            // back to source uv for the mapper
  };
  return {
    corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
    center: toFrame(num(src.cx, 0.5), num(src.cy, 0.5)),
    conf: num(src.conf, 1),
    scale: sc,
    rotDeg: num(src.rot, 0),
    outOfSpan,
  };
}

/** Composition-frame pixels (y down, origin top-left) → source uv, the exact
 *  inverse of frameMapper. This is what turns a drag on the canvas into a track
 *  correction: the pointer lives in frame px, the samples in source uv. */
export function motionTrackFrameToSourceUv({ track, item, entry, W, H, t }, x, y) {
  const duration = num(entry?.endTime) - num(entry?.startTime);
  const progress = duration > 0 && Number.isFinite(t)
    ? clamp01((t - num(entry?.startTime)) / duration)
    : 0.5;
  const prs = localPrs(item, getItemKeyframeValues(item, progress), W, H);
  const boxW = Math.abs(prs.sx) * W;
  const boxH = Math.abs(prs.sy) * H;
  const { kx, ky } = containScale(track, boxW, boxH);
  const phi = -prs.rz;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = x - W / 2 - prs.px;
  const dy = y - H / 2 + prs.py;
  const ax = dx * cos + dy * sin;
  const ay = -dx * sin + dy * cos;
  return { u: ax / Math.max(kx, 1e-6) + 0.5, v: ay / Math.max(ky, 1e-6) + 0.5 };
}

/* ── Manual per-frame correction (the AE move) ─────────────────────────────
   A user parks the playhead on a frame the tracker got wrong and drags the box
   (or types values) — that writes a MANUAL sample at that frame: conf 1, sitting
   in the same array as the analysed ones. Downstream nothing changes: the
   sampler, the follower and the render server cannot tell a hand-set key from a
   measured one, which is exactly the point. */

/** The track's frame grid step in source seconds. */
export function motionTrackFrameStep(track) {
  return 1 / clamp(num(track?.sourceFps, 30), 1, 240);
}

/** Snap an arbitrary source time onto the track's sample grid. An existing
 *  sample within half a frame wins (so edits land ON analysed frames rather
 *  than splitting hairs beside them); otherwise the grid is anchored at the
 *  first sample. */
export function quantizeMotionTrackTime(track, tSource) {
  const s = track?.samples;
  const dt = motionTrackFrameStep(track);
  if (!s || !s.length) return Math.max(0, tSource);
  const idx = nearestSampleIndex(s, tSource);
  if (idx >= 0 && Math.abs(s[idx][MT_T] - tSource) <= dt * 0.5 + 1e-6) return s[idx][MT_T];
  const t0 = s[0][MT_T];
  return Math.max(0, t0 + Math.round((tSource - t0) / dt) * dt);
}

function nearestSampleIndex(samples, tSource) {
  if (!samples.length) return -1;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid][MT_T] <= tSource) lo = mid; else hi = mid;
  }
  return Math.abs(samples[lo][MT_T] - tSource) <= Math.abs(samples[hi][MT_T] - tSource) ? lo : hi;
}

/** Index of the sample sitting ON this frame (within half a frame), or -1. */
export function motionTrackSampleIndexAt(track, tSource) {
  const s = track?.samples;
  if (!s || !s.length) return -1;
  const idx = nearestSampleIndex(s, tSource);
  return Math.abs(s[idx][MT_T] - tSource) <= motionTrackFrameStep(track) * 0.5 + 1e-6 ? idx : -1;
}

/**
 * Write a manual key at `tSource` (replacing the sample on that frame if there
 * is one). Unspecified channels keep what the track believed there — sampled,
 * so correcting a position inside a hole does not also zero the rotation the
 * interpolation was carrying. Returns a NEW track; the input is not touched.
 */
export function upsertMotionTrackSample(track, tSource, patch = {}) {
  if (!track?.samples?.length) return track;
  const t = quantizeMotionTrackTime(track, tSource);
  const base = sampleMotionTrack(track, t) || { cx: 0.5, cy: 0.5, scale: 1, rot: 0 };
  const next = [
    +t.toFixed(4),
    +num(patch.cx, base.cx).toFixed(5),
    +num(patch.cy, base.cy).toFixed(5),
    +clamp(num(patch.scale, base.scale), 0.001, 1000).toFixed(5),
    +num(patch.rot, base.rot).toFixed(4),
    1,
  ];
  const dt = motionTrackFrameStep(track);
  const samples = track.samples.filter((s) => Math.abs(s[MT_T] - t) > dt * 0.5 + 1e-6);
  let at = samples.findIndex((s) => s[MT_T] > t);
  if (at < 0) at = samples.length;
  samples.splice(at, 0, next);
  const out = { ...track, samples };
  out.segments = computeMotionTrackSegments(out);
  return out;
}

/* ── Confidence strip ──────────────────────────────────────────────────────
   The panel's one-glance answer to "is this track any good": contiguous runs of
   solid / unsure / hole across the analysed span, weighted by duration. Solid
   and unsure split at 0.6 — above it the lock never wavered, below it the
   overlay already draws the box amber. Holes are the gaps between segments. */
export function motionTrackConfidenceRuns(track, maxRuns = 72) {
  const s = track?.samples;
  if (!s || s.length < 2) return [];
  const dt = motionTrackFrameStep(track);
  const raw = [];
  const pushRaw = (kind, w) => {
    const last = raw[raw.length - 1];
    if (last && last.kind === kind) last.w += w;
    else raw.push({ kind, w });
  };
  pushRaw(s[0][MT_CONF] >= 0.6 ? 'ok' : 'soft', dt);
  for (let i = 1; i < s.length; i += 1) {
    const smp = s[i];
    const gap = smp[MT_T] - s[i - 1][MT_T];
    if (gap > dt * 1.5) {
      pushRaw('hole', gap - dt);
      pushRaw(smp[MT_CONF] >= 0.6 ? 'ok' : 'soft', dt);
    } else {
      pushRaw(smp[MT_CONF] >= 0.6 ? 'ok' : 'soft', Math.max(dt, gap));
    }
  }
  const limit = Math.max(1, Math.round(num(maxRuns, 72)));
  if (raw.length <= limit) return raw;

  // Compress by DURATION, not by dropping array entries. Every output bucket
  // covers its part of the complete track; any hole/soft interval in a bucket is
  // surfaced (worst state wins), so a short loss is never averaged invisible.
  const total = raw.reduce((sum, run) => sum + run.w, 0);
  const bucketW = total / limit;
  const runs = [];
  const push = (kind, w) => {
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.w += w;
    else runs.push({ kind, w });
  };
  let ri = 0;
  let offset = 0;
  for (let bi = 0; bi < limit; bi += 1) {
    let left = bi === limit - 1 ? total - bucketW * bi : bucketW;
    let sawSoft = false;
    let sawHole = false;
    while (left > 1e-9 && ri < raw.length) {
      const available = raw[ri].w - offset;
      const take = Math.min(left, available);
      if (take > 1e-9) {
        if (raw[ri].kind === 'hole') sawHole = true;
        else if (raw[ri].kind === 'soft') sawSoft = true;
      }
      left -= take;
      offset += take;
      if (offset >= raw[ri].w - 1e-9) { ri += 1; offset = 0; }
    }
    push(sawHole ? 'hole' : sawSoft ? 'soft' : 'ok', bi === limit - 1 ? total - bucketW * bi : bucketW);
  }
  return runs;
}

/** Remove the sample on this frame, if any. A track keeps at least two samples
 *  — below that it stops being a track and delete-the-track is the honest tool. */
export function removeMotionTrackSampleAt(track, tSource) {
  if (!track?.samples || track.samples.length <= 2) return track;
  const idx = motionTrackSampleIndexAt(track, quantizeMotionTrackTime(track, tSource));
  if (idx < 0) return track;
  const samples = track.samples.filter((_, i) => i !== idx);
  const out = { ...track, samples };
  out.segments = computeMotionTrackSegments(out);
  return out;
}
