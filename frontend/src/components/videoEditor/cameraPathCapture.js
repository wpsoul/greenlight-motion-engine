// Moving the camera by hand: the writes behind the preview's camera gestures and the camera map.
//
// Three rules, all pure, so the preview overlay and the map cannot disagree:
//
//   moveWithoutKeys   Capture off: the camera moves and no key is ever added.
//   capturePathKey    Path + Capture: the pose becomes a path key at the playhead.
//   cameraMoveUpdates picks between those and a plain Free capture for one gesture.
//
// Plus the map's point edits (movePathPoints, dragPathTangent, moveFreeKeys, the deletes).
//
// Gesture values are absolute from a snapshot taken at the press, the reasoning in CameraCaptureOverlay.jsx: a re-render
// mid-drag can never compound a shift.

import * as THREE from 'three';
import {
  CAMERA_PATH_DEFAULT, CAMERA_RIG_PROPS, cameraPropsForWorldPoint, cameraWorldPosition, getCameraPose,
  refreshCameraPathHandles,
} from './projectCamera';
import { buildCameraTransformUpdates } from './transformWriteback';
import { evaluatePropertyTrack } from './gsapTransitions';
import { TransitionEasing } from './types';

const round = (n) => Math.round(n * 10000) / 10000;
const number = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const sorted = (track) => [...(track || [])].sort((a, b) => number(a.position) - number(b.position));

const rotationOf = (pose) => ({ rx: round(number(pose.camTiltX)), ry: round(number(pose.camTiltY)), rz: round(number(pose.camRoll)) });

/** camX / camY / camDolly that put the camera at a world point, keeping its rotation. */
export function propsForWorld(point, values, frame) {
  return cameraPropsForWorldPoint(new THREE.Vector3(point.x, point.y, point.z), null, values, frame.width, frame.height);
}

// ── Anchors ↔ time ──
//
// evaluateCameraPath walks segments at uniform parameter, so anchor i always sits at Path Progress i / segments. The
// time an anchor is reached is wherever the camPathT track crosses that value, which keeps the timing in the one track
// the app already has: no per-point time field, and a path drawn in the 3D view has times too.
function trackTimeOf(track, target) {
  const keys = sorted(track);
  if (target <= number(keys[0].value)) return number(keys[0].position);
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i];
    const b = keys[i + 1];
    if (target < number(a.value) || target > number(b.value)) continue;
    let lo = number(a.position);
    let hi = number(b.position);
    for (let n = 0; n < 24; n += 1) {
      const mid = (lo + hi) / 2;
      if (number(evaluatePropertyTrack(track, mid, false)) < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  return number(keys[keys.length - 1].position);
}

/** Each anchor's position in the clip, 0-100. */
export function pathAnchorTimes(item) {
  const path = item?.cameraPath;
  const n = path?.points?.length || 0;
  if (!n) return [];
  const segments = path.closed === true ? n : Math.max(1, n - 1);
  const track = item?.propertyKeyframes?.camPathT;
  return Array.from({ length: n }, (_, i) => {
    const target = (i / segments) * 100;
    return Array.isArray(track) && track.length ? trackTimeOf(track, target) : target;
  });
}

function pathProgressTrack(times, closed) {
  const n = times.length;
  const segments = closed ? n : Math.max(1, n - 1);
  return times.map((t, i) => ({
    position: round(t),
    value: String(n > 1 ? round((i / segments) * 100) : 0),
    easing: TransitionEasing.LINEAR,
  }));
}

/**
 * Path capture: the pose set in the preview becomes a path key at the playhead.
 *
 * One write, like a Free capture: the anchor under the playhead moves, otherwise one is inserted between its neighbours
 * in TIME, and every key of the Path Progress track is rebuilt from the anchors' times. The key is position AND rotation,
 * both on the anchor, so nothing lands on the tracks Free reads and the modes stay apart. A path made with another aim
 * keeps its look: what it shows at each anchor becomes that anchor's rotation.
 */
export function capturePathKey({ item, pct, keyTolerancePct = 0.5, frame }, pose) {
  const path = item.cameraPath || {};
  const times = pathAnchorTimes(item);
  const adopted = path.aim === 'captured';
  const points = (path.points || []).map((p, i) => (adopted
    ? { ...p }
    : { ...p, ...rotationOf({ ...(getCameraPose(item, times[i] / 100, frame) || {}) }) }));

  const at = cameraWorldPosition(pose, frame.width, frame.height);
  const anchor = { x: round(at.x), y: round(at.y), z: round(at.z), ...rotationOf(pose) };
  let index = times.findIndex((t) => Math.abs(t - pct) <= Math.max(0.001, keyTolerancePct));
  const inserted = index < 0;
  if (inserted) {
    index = times.findIndex((t) => t > pct);
    if (index < 0) index = points.length;
    points.splice(index, 0, anchor);
    times.splice(index, 0, pct);
  } else {
    points[index] = { ...points[index], ...anchor };
  }
  refreshCameraPathHandles(points, path.closed === true);

  return {
    updates: {
      cameraPath: {
        ...CAMERA_PATH_DEFAULT,
        ...path,
        aim: 'captured',
        follow: true,
        keyframesPerPoint: true,
        points,
        keyframesPerPointCount: points.length,
        keyframesPerPointClosed: path.closed === true,
      },
      propertyKeyframes: { ...(item.propertyKeyframes || {}), camPathT: pathProgressTrack(times, path.closed === true) },
      camZoom: pose.camZoom,
    },
    index,
    inserted,
    count: points.length,
  };
}

/**
 * A captured path whose point count changed outside capture (a point added or deleted in the 3D view, Smooth path).
 * The times can't be matched to the points any more, but they can keep their span and rough pacing instead of flattening
 * to an even 0 → 100: the new keys are read off the old key times.
 */
export function retimeCapturedTrack(track, count, closed) {
  const keys = sorted(track).map((k) => number(k.position));
  const segments = closed ? count : Math.max(1, count - 1);
  const times = Array.from({ length: count }, (_, i) => {
    if (keys.length < 2) return (i / segments) * 100;
    const at = (i / segments) * (keys.length - 1);
    const lo = Math.min(keys.length - 2, Math.floor(at));
    return keys[lo] + (keys[lo + 1] - keys[lo]) * (at - lo);
  });
  return pathProgressTrack(times, closed);
}

/** Smoothing rebuilds the anchors, so each new one takes the rotation of the nearest old one. */
export function carryPathRotation(next, old) {
  return next.map((p) => {
    let best = null;
    let bestD = Infinity;
    for (const o of old) {
      if (!Number.isFinite(o.rx)) continue;
      const d = Math.hypot(p.x - o.x, p.y - o.y, p.z - o.z);
      if (d < bestD) { best = o; bestD = d; }
    }
    return best ? { ...p, rx: best.rx, ry: best.ry, rz: best.rz } : p;
  });
}

/** Removes a path key. Its rotation goes with its anchor, and the keys left keep their times. */
export function deletePathKey(item, index) {
  const path = item.cameraPath;
  const points = path.points.filter((_, i) => i !== index);
  const times = pathAnchorTimes(item);
  times.splice(index, 1);
  const tracks = { ...(item.propertyKeyframes || {}) };
  if (!points.length) {
    delete tracks.camPathT;
    return { cameraPath: null, propertyKeyframes: tracks };
  }
  refreshCameraPathHandles(points, path.closed === true);
  tracks.camPathT = pathProgressTrack(times, path.closed === true);
  return { cameraPath: { ...path, points, keyframesPerPointCount: points.length }, propertyKeyframes: tracks };
}

/**
 * Moving the camera with Capture off. Decided for the whole camera, not per property, because a key is a moment of the
 * camera: `item` is the snapshot from the start of the gesture.
 *
 *   no keys at all   the base position changes;
 *   on a key         only that key changes, its neighbours stay;
 *   between keys     the whole move shifts: every key of what was moved goes by the same amount, so the camera stays
 *                    where it was put and the move keeps its shape.
 *
 * No new moment is ever added. On a key, a property with no key of its own at that time gets one there, or the change
 * would spread: a track of its own is laid down at all the camera's key times first, for the reason in moveFreeKeys.
 */
export function moveWithoutKeys({ item, pct, keyTolerancePct = 0.5, frame }, props) {
  const tracks = item?.propertyKeyframes || {};
  const keyTimes = freeKeyTimes(item);
  const near = (t) => Math.abs(number(t) - pct) <= Math.max(0.001, keyTolerancePct);
  const updates = {};
  if (!keyTimes.length) {
    for (const [prop, value] of Object.entries(props)) if (Number.isFinite(value)) updates[prop] = value;
    return updates;
  }
  const onKey = keyTimes.find(near);
  const next = { ...tracks };
  let tracksChanged = false;
  for (const [prop, value] of Object.entries(props)) {
    if (!Number.isFinite(value)) continue;
    const track = tracks[prop];
    const has = Array.isArray(track) && track.length > 0;
    if (onKey !== undefined) {
      const laid = has ? track : keyTimes.map((t) => ({
        position: t,
        value: String(round(number(getCameraPose(item, t / 100, frame)?.[prop]))),
        easing: TransitionEasing.EASE_IN_OUT,
      }));
      const idx = laid.findIndex((k) => near(k.position));
      next[prop] = idx >= 0
        ? laid.map((k, i) => (i === idx ? { ...k, value: String(round(value)) } : k))
        : [...laid, { position: onKey, value: String(round(value)), easing: TransitionEasing.EASE_IN_OUT }]
          .sort((a, b) => number(a.position) - number(b.position));
      tracksChanged = true;
    } else if (has) {
      const delta = value - number(evaluatePropertyTrack(track, pct, false));
      next[prop] = track.map((k) => ({ ...k, value: String(round(number(k.value) + delta)) }));
      tracksChanged = true;
    } else {
      updates[prop] = value; // nothing animates it, so its base IS the whole move
    }
  }
  if (tracksChanged) updates.propertyKeyframes = next;
  return updates;
}

/**
 * One camera gesture's write, wherever it came from. `desc` is { item, pct, keyTolerancePct } at the playhead; `gesture`
 * is the press's { base, item }.
 */
export function cameraMoveUpdates(desc, gesture, { capture, frame }, props) {
  const { item, pct, keyTolerancePct } = desc;
  if (item.cameraMoveMode === 'path') {
    return capturePathKey({ item, pct, keyTolerancePct, frame }, { ...gesture.base, ...props }).updates;
  }
  if (capture) return buildCameraTransformUpdates({ item, pct, keyTolerancePct, forceTracks: true }, props);
  return moveWithoutKeys({ item: gesture.item, pct, keyTolerancePct, frame }, props);
}

// ── The map ──

/** The 3D view's point drag: handles are offsets, so they travel with the anchor, and a key keeps its time. */
export function movePathPoints(path, base, indices, delta) {
  const points = base.map((p, i) => (indices.includes(i)
    ? { ...p, x: round(p.x + delta.x), y: round(p.y + delta.y), z: round(p.z + delta.z) }
    : { ...p }));
  refreshCameraPathHandles(points, path.closed === true);
  return { ...path, points };
}

/** worldView.js #moveTangent: the other handle mirrors with its own length, and `corner` (Alt) breaks the pair. */
export function dragPathTangent(path, base, index, key, at, corner = false) {
  const points = base.map((p) => ({ ...p }));
  const pt = points[index];
  const off = { x: round(at.x - pt.x), y: round(at.y - pt.y), z: round(at.z - pt.z) };
  pt[key] = off;
  pt.manual = true;
  if (!corner) {
    const other = key === 'hIn' ? 'hOut' : 'hIn';
    const cur = pt[other] || { x: 0, y: 0, z: 0 };
    const curLen = Math.hypot(cur.x, cur.y, cur.z);
    const offLen = Math.hypot(off.x, off.y, off.z) || 1e-6;
    const k = (curLen || offLen) / offLen;
    pt[other] = { x: round(-off.x * k), y: round(-off.y * k), z: round(-off.z * k) };
  }
  refreshCameraPathHandles(points, path.closed === true);
  return { ...path, points };
}

/**
 * A Free key moved on the map: the pose at that key goes to the new world point, rotation untouched.
 *
 * A capture only keys what its gesture touched, so a key can have no Pan or Dolly key at all. Writing one there would make
 * a one-key track, which holds its value across the whole clip and drags every other key along. So a position track that
 * doesn't exist yet is first laid down at all `keyTimes` with the values the camera already has there.
 */
export function moveFreeKeys({ item, keys, keyTimes = [], delta, frame, keyTolerancePct = 0.5 }) {
  let out = item;
  const tracks = { ...(out.propertyKeyframes || {}) };
  for (const prop of ['camX', 'camY', 'camDolly']) {
    if (tracks[prop]?.length) continue;
    tracks[prop] = keyTimes.map((pct) => ({
      position: pct,
      value: String(round(number(getCameraPose(item, pct / 100, frame)?.[prop]))),
      easing: TransitionEasing.EASE_IN_OUT,
    }));
  }
  out = { ...out, propertyKeyframes: tracks };
  for (const key of keys) {
    const target = { x: key.world.x + delta.x, y: key.world.y + delta.y, z: key.world.z + delta.z };
    const u = buildCameraTransformUpdates(
      { item: out, pct: key.pct, keyTolerancePct, forceTracks: true },
      propsForWorld(target, key.pose, frame),
    );
    out = { ...out, ...u };
  }
  return out;
}

/** The times a Free camera is keyed at, across its pose tracks: what a key on the map stands for. */
export function freeKeyTimes(item) {
  const set = new Set();
  for (const prop of CAMERA_RIG_PROPS) {
    for (const k of item?.propertyKeyframes?.[prop] || []) set.add(Math.round(number(k.position) * 100) / 100);
  }
  return [...set].sort((a, b) => a - b);
}

/** Removes every pose key at one time on a Free camera. */
export function deleteFreeKey(item, pct, keyTolerancePct = 0.5) {
  const tracks = { ...(item.propertyKeyframes || {}) };
  for (const prop of CAMERA_RIG_PROPS) {
    if (!tracks[prop]) continue;
    tracks[prop] = tracks[prop].filter((k) => Math.abs(number(k.position) - pct) > Math.max(0.001, keyTolerancePct));
    if (!tracks[prop].length) delete tracks[prop];
  }
  return tracks;
}
