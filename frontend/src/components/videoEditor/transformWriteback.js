// Turning a direct-manipulation gesture into a timeline edit.
//
// The rule, shared with the 2D preview gizmo (PreviewTransformOverlay.jsx): a
// gesture edits each affected property's own TRACK — updating the key under the
// playhead or inserting one there — whenever the layer is keyframed. A layer with
// no keyframes at all falls back to the item's base transform fields instead, so
// dragging an un-animated layer stays a plain move.
//
// Gestures arrive as DELTAS from the drag's starting state rather than absolute
// values: the render loop rewrites every mesh from item data on each frame, so an
// absolute read of the mesh mid-drag races with it, while a delta against a
// snapshot taken at drag start does not.

import { evaluatePropertyTrack, itemHasKeyframes } from './gsapTransitions';
import { CAMERA_NEUTRAL } from './projectCamera';
import { TransitionEasing } from './types';

const number = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const round = (n) => Math.round(n * 10000) / 10000;

/**
 * A writer bound to one item at one point on its timeline.
 *
 * `pct` is the playhead's position within the clip (0-100); `keyTolerancePct` is
 * how close an existing key has to be to count as "the key under the playhead"
 * (the callers use half a frame).
 *
 * `forceTracks` skips the base-field fallback entirely: Capture Camera exists to
 * record keyframes, so even a never-keyframed camera gets a track on the first
 * gesture instead of a silent base-value write.
 */
export function createTrackWriter({ item, pct, keyTolerancePct = 0.001, forceTracks = false }) {
  const tracks = { ...(item?.propertyKeyframes || {}) };
  const autoTrack = forceTracks || itemHasKeyframes(item);
  const updates = {};
  let tracksChanged = false;

  const editedTrack = (track, neutral, compute) => {
    const idx = track.findIndex(
      (k) => Math.abs(number(k.position) - pct) <= Math.max(0.001, keyTolerancePct)
    );
    if (idx >= 0) {
      const cur = number(track[idx].value, neutral);
      return track.map((k, i) => (i === idx ? { ...k, value: String(round(compute(cur))) } : k));
    }
    const cur = number(evaluatePropertyTrack(track, pct, false), neutral);
    // Always Smooth, rather than inheriting the previous key's easing: the camera
    // presets are authored in Sine Smooth, so an inherited easing meant every key
    // you dragged in after applying one silently came out Sine Smooth too.
    const newKey = {
      position: Math.round(pct * 100) / 100,
      value: String(round(compute(cur))),
      easing: TransitionEasing.EASE_IN_OUT,
    };
    return [...track, newKey].sort((a, b) => a.position - b.position);
  };

  return {
    /**
     * Edit `prop`'s track at the playhead, or fall back to a base field.
     * `compute(current)` returns the new value; `applyBase()` writes base fields
     * into `updates` and is only called when the layer has no keyframes at all.
     */
    editOrBase(prop, neutral, compute, applyBase) {
      const track = tracks[prop];
      const hasTrack = Array.isArray(track) && track.length > 0;
      // A freshly seeded track starts as a single key at the playhead — the same
      // shape editedTrack produces for an existing one.
      if (hasTrack || autoTrack) {
        tracks[prop] = editedTrack(hasTrack ? track : [], neutral, compute);
        tracksChanged = true;
      } else {
        applyBase();
      }
    },
    setBase(patch) { Object.assign(updates, patch); },
    result() {
      if (tracksChanged) updates.propertyKeyframes = tracks;
      return updates;
    },
  };
}

/**
 * The 3D world gizmo's write-back.
 *
 * `values` carries only the axes the gesture actually touched:
 *   { dPanX, dPanY, dPanZ }      translate — dPanX/dPanY in % of frame, dPanZ in px
 *   { dRotateX, dRotateY, dRotateZ }  rotate — degrees
 *   { zoomRatio }                scale — multiplier
 *
 * Sign conventions match applyMeshTransform in Player.jsx: +panX moves right,
 * +panY moves DOWN, +panZ moves toward the camera, and rotations are negated into
 * three's euler. The keyframe tracks that shadow these base fields (xPercent,
 * yPercent, translateZ, rotate/rotateX/rotateY, scale) share those conventions, so
 * a delta applies unchanged to either.
 */
export function buildWorldTransformUpdates(drag, values) {
  const { item } = drag;
  if (!item) return null;
  const writer = createTrackWriter(drag);

  if (Number.isFinite(values.dPanX) && values.dPanX !== 0) {
    writer.editOrBase('xPercent', 0,
      (cur) => cur + values.dPanX,
      () => writer.setBase({ panX: number(item.panX) + values.dPanX }));
  }
  if (Number.isFinite(values.dPanY) && values.dPanY !== 0) {
    writer.editOrBase('yPercent', 0,
      (cur) => cur + values.dPanY,
      () => writer.setBase({ panY: number(item.panY) + values.dPanY }));
  }
  if (Number.isFinite(values.dPanZ) && values.dPanZ !== 0) {
    writer.editOrBase('translateZ', 0,
      (cur) => cur + values.dPanZ,
      () => writer.setBase({ panZ: number(item.panZ) + values.dPanZ }));
  }

  if (Number.isFinite(values.dRotateX) && values.dRotateX !== 0) {
    writer.editOrBase('rotateX', 0,
      (cur) => cur + values.dRotateX,
      () => writer.setBase({ rotateX: number(item.rotateX) + values.dRotateX }));
  }
  if (Number.isFinite(values.dRotateY) && values.dRotateY !== 0) {
    writer.editOrBase('rotateY', 0,
      (cur) => cur + values.dRotateY,
      () => writer.setBase({ rotateY: number(item.rotateY) + values.dRotateY }));
  }
  if (Number.isFinite(values.dRotateZ) && values.dRotateZ !== 0) {
    writer.editOrBase('rotate', 0,
      (cur) => cur + values.dRotateZ,
      // rotateZ supersedes the legacy `rotation` field; keep them from disagreeing.
      () => writer.setBase({
        rotateZ: number(item.rotateZ, number(item.rotation)) + values.dRotateZ,
        rotation: 0,
      }));
  }

  if (Number.isFinite(values.zoomRatio) && values.zoomRatio !== 1 && values.zoomRatio > 0) {
    writer.editOrBase('scale', 1,
      (cur) => cur * values.zoomRatio,
      () => writer.setBase({ zoom: Math.max(0.01, number(item.zoom, 1) * values.zoomRatio) }));
  }

  const updates = writer.result();
  return Object.keys(updates).length > 0 ? updates : null;
}

/**
 * The camera gizmo's write-back.
 *
 * Unlike a layer, the camera's props are ABSOLUTE: dragging the proxy gives a
 * world position and orientation, and projectCamera's cameraPropsForWorldPoint
 * turns that straight into camX / camY / camDolly / camTiltX / camTiltY / camRoll.
 * A delta would be wrong here anyway — the position props are expressed in the
 * camera's own rotated frame, so changing the tilt changes what camX means.
 *
 * The keyframe rule is the layer one: a camera with tracks gets a key at the
 * playhead, an un-keyframed camera gets its base values written.
 */
export function buildCameraTransformUpdates(drag, props) {
  if (!drag?.item || !props) return null;
  const writer = createTrackWriter(drag);
  for (const [prop, value] of Object.entries(props)) {
    if (!Number.isFinite(value)) continue;
    const neutral = Number.isFinite(CAMERA_NEUTRAL[prop]) ? CAMERA_NEUTRAL[prop] : 0;
    writer.editOrBase(prop, neutral, () => value, () => writer.setBase({ [prop]: value }));
  }
  const updates = writer.result();
  return Object.keys(updates).length > 0 ? updates : null;
}
