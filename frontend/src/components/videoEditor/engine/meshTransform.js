/*
 * A layer mesh's transform (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 20 — moved verbatim out of Player.jsx:
 * the module-level helpers with tests/engine-extraction/tools/move_module_decls.py, the two callbacks with
 * convert_leaf.py): Position / Rotation / Scale composed with keyframes, parenting and Motion Follow
 * (applyMeshTransform), a plate's scale (makePlateScale, shapePlateAt), and the parent / follow resolvers the render
 * loop and the motion passes evaluate at any time.
 *
 *   resolveParenting(engine, index, item, time)   the parent's effective transform at `time`, or null
 *   resolveFollow(engine, index, item, time)      the Motion Follow delta at `time`, or null
 */
import * as THREE from 'three';
import { withBorderKeyframes } from '../borderKeyframes';
import { getItemKeyframeValues, itemHasKeyframes } from '../gsapTransitions';
import { applyParenting, getParenting, localPrs, resolveParentTransform } from '../keyframeParenting';
import { applyMotionFollowToPrs, resolveMotionFollowDelta } from '../motionTracking';
import { RIG_MEDIA_TYPE } from '../rig3d';
import { SHAPE_PATH_KF_KEY, isStrokeShape, resolveLineSettings, withShapeSizeKeyframes } from '../shapePath';
import { isGridClip } from '../types';
import { getShapeTextureLayout } from './pathFx';
import { PARTICLE_MEDIA_TYPE } from '../../../sim/particles/schema.js';

// Position/Rotation/Scale for one layer, base fields composed with its keyframed
// PRS — and, when the layer is parented, with its parent's effective PRS resolved
// from absolute timeline time (keyframeParenting.js is the single evaluator every
// render path, gizmo and the exporter share).
//
// `parentXform` is { prs, type } from resolveParentTransform, or null for an
// unparented layer — in which case this reduces exactly to the layer's own PRS.
// Mirror is applied last: it's a child appearance setting, never inherited.
// `followDelta` is a resolved motion-track link (motionTracking.js), passed in by
// every caller that knows the absolute time — resolving it here is impossible,
// this function only ever sees the item's own progress-evaluated keyframes.
export function applyMeshTransform(mesh, item, keyframeProps, W, H, parentXform = null, clip = null, followDelta = null) {
  // A model layer's transform is applied to the geometry inside its own 3D pass, and
  // the result arrives as a full-frame texture. Posing its plane as well would apply
  // every translation and rotation twice.
  // Same for the Rig clip: the cyclorama is posed by the rig's own x/y/z + rotation
  // inside that pass, so the plate it comes back on stays at frame identity.
  // And for a particle layer: its Solver Box is posed at the layer's PRS and filmed
  // through the project camera inside renderParticleLayer. Posing the plate too put
  // every particle at twice the layer's offset, which under a travelling camera is
  // off screen.
  if (clip?.mediaType === 'model3d' || clip?.mediaType === RIG_MEDIA_TYPE || clip?.mediaType === PARTICLE_MEDIA_TYPE) {
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);
    if (mesh.userData.gridWorldPos) mesh.userData.gridWorldPos = null;
    return;
  }
  const local = localPrs(item, keyframeProps, W, H);
  // A real-3D grid's plate is a screen-aligned intermediate: the whole resolved
  // transform was folded into the camera that filmed the inner scene (see the
  // "cells are REAL 3D objects" note above), so posing the plate as well would
  // apply it twice. The plate sits at frame identity and is composited through
  // the neutral lens; only mirror stays here — a 2D appearance flip the camera
  // cannot express. A grid living as a CELL of another grid keeps ordinary
  // plate semantics: its pose is the outer layout's business.
  if (isGridClip(clip) && !parentXform?.cell) {
    const prs = parentXform ? applyParenting(parentXform.prs, local, parentXform.type) : local;
    // Where the arrangement's origin really is. Depth sorting and DOF read this,
    // because the identity plate itself would always sort at z 0.
    mesh.userData.gridWorldPos = { x: prs.px, y: prs.py, z: prs.pz };
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(item.mirrorH ? -1 : 1, item.mirrorV ? -1 : 1, 1);
    return;
  }
  if (mesh.userData.gridWorldPos) mesh.userData.gridWorldPos = null;
  let prs = parentXform ? applyParenting(parentXform.prs, local, parentXform.type) : local;
  // Motion tracking rides on TOP of parenting: a follower that is also a child
  // keeps following its parent, and the track adds to the result. Object lock
  // cancels the tracked motion from wherever the layer ended up, not from its
  // unparented pose.
  if (followDelta) prs = applyMotionFollowToPrs(prs, followDelta, W, H);

  mesh.position.set(prs.px, prs.py, prs.pz);
  // THREE's default Euler order is 'XYZ', which is the order the composer
  // decomposes into — see decomposeLinear in keyframeParenting.js.
  mesh.rotation.set(prs.rx, prs.ry, prs.rz);

  const flipX = item.mirrorH ? -1 : 1;
  const flipY = item.mirrorV ? -1 : 1;
  // Scale z stays 1: the layer plane has no depth, and the shape/shadow-expand
  // multipliers below only ever touch x/y.
  mesh.scale.set(prs.sx * flipX, prs.sy * flipY, 1);
}

// A shape's plate (outline + stroke/border reach + shadow pad) at one set of
// keyframe values — the same resolution the channel sizes the shape plate with.
export function shapePlateAt(item, kf, compositionWidth, compositionHeight) {
  const shapeItem = withBorderKeyframes(withShapeSizeKeyframes(item, kf), kf);
  const isPathShape = item.shapeType === 'path' || item.shapeType === 'line';
  const shapeKf = isPathShape ? kf : null;
  let pathPoints = isPathShape ? (item.shapePath?.points || null) : null;
  if (pathPoints && shapeKf) {
    const morphed = shapeKf[SHAPE_PATH_KF_KEY];
    if (Array.isArray(morphed) && morphed.length >= 2) pathPoints = morphed;
  }
  const line = isStrokeShape(item) ? resolveLineSettings(item, shapeKf) : null;
  const { plateWidth, plateHeight } = getShapeTextureLayout(shapeItem, compositionWidth, compositionHeight, { pathPoints, line });
  return [plateWidth, plateHeight];
}

/*
 * The temporal effects (Echo, Motion Trail) measure the layer at OTHER times by
 * re-posing its mesh with applyMeshTransform, which writes only the item's
 * transform. The channel then multiplies the mesh scale by the layer's plate
 * (shape / text / SVG / photo: layerWidth / W) and its shadow expand, so the
 * re-posed mesh measured a FRAME-SIZED box wherever the layer really was — and
 * the warp clips every image to its box. A layer bigger than the frame lost
 * everything outside that box: an ellipse grown past the frame was cut through
 * its middle, then vanished once its centre left the frame.
 *
 * Call with the mesh holding NOW's transform-only pose and `posedScale` the
 * scale the channel actually drew it with. The ratio of the two is everything
 * the channel put on top of the transform; the returned function applies it to
 * any later pose, and a shape whose Width / Height (or path, stroke, border) is
 * keyframed is rescaled by its own plate at that pose's time.
 */
export function makePlateScale(mesh, posedScale, item, clip, kfNow, compositionWidth, compositionHeight) {
  const rx = Math.abs(mesh.scale.x) > 1e-9 ? posedScale.x / mesh.scale.x : 1;
  const ry = Math.abs(mesh.scale.y) > 1e-9 ? posedScale.y / mesh.scale.y : 1;
  const plateNow = clip?.mediaType === 'shape' && itemHasKeyframes(item)
    ? shapePlateAt(item, kfNow, compositionWidth, compositionHeight)
    : null;
  return (kf) => {
    let kx = rx;
    let ky = ry;
    if (plateNow) {
      const [pw, ph] = shapePlateAt(item, kf, compositionWidth, compositionHeight);
      kx *= pw / plateNow[0];
      ky *= ph / plateNow[1];
    }
    mesh.scale.x *= kx;
    mesh.scale.y *= ky;
  };
}

export function resolveParenting(engine, index, item, time) {
  if (!index || !getParenting(item)) return null;
  const { w, h } = engine.videoSize;
  return resolveParentTransform(index, item, time, {
    W: w,
    H: h,
    evalKeyframes: getItemKeyframeValues,
  });
}

export function resolveFollow(engine, index, item, time) {
  if (!index || !item?.motionFollow) return null;
  const { w, h } = engine.videoSize;
  return resolveMotionFollowDelta({ index, item, t: time, W: w, H: h });
}
