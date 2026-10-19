// The projection half of adaptive raster density. Split out of Player.jsx so the
// riskiest part of the feature — NDC conversion, the near-plane guard, tilted-plane
// edge measurement — can be tested against a REAL THREE camera instead of a copy of
// the math. Same reason applyCameraRig is exported for the plane-equivalence gate.
//
// The policy half (buckets, caps, budget) lives in rasterDensity.js and stays free of
// THREE entirely.
import * as THREE from 'three';

// Explicit extension: this module is imported both by Vite and by the node test
// runner, and node's ESM resolver does not guess it.
import { screenScaleFromCorners } from './rasterDensity.js';

// Scratch objects so the per-frame probe allocates nothing.
const _world = new THREE.Vector3();
const _view = new THREE.Vector3();
const _pts = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
// Plane-geometry corners as fractions of the composition box: TL, TR, BL, BR.
const _corners = [[-0.5, 0.5], [0.5, 0.5], [-0.5, -0.5], [0.5, -0.5]];

/**
 * Worst-case on-screen magnification of a layer's plate, in screen px per logical px.
 *
 * `object` needs only a current `matrixWorld` — the caller poses it with the exact
 * transform the layer will render with. Measuring the REAL posed camera is
 * deliberate: re-deriving the camera model here would be a second copy that drifts
 * from syncPosedCamera, and the rig no longer carries the camera pose at all (it is
 * left at identity; the posed camera carries it), so a rig-based formula would
 * silently measure nothing.
 *
 * The clip plane geometry is composition-sized — PlaneGeometry(W, H) — so local
 * corners sit at ±W/2, ±H/2 before the object's own scale.
 */
export function measureScreenScale(object, camera, W, H, logicalW, logicalH, bufferW, bufferH) {
  if (!object || !camera) return 1;
  if (!(logicalW > 0) || !(logicalH > 0) || !(bufferW > 0) || !(bufferH > 0)) return 1;
  for (let i = 0; i < 4; i += 1) {
    _world.set(_corners[i][0] * W, _corners[i][1] * H, 0).applyMatrix4(object.matrixWorld);
    // A corner at or behind the near plane projects to nonsense — the perspective
    // divide flips sign rather than producing a non-finite number, so the check has
    // to happen in view space. A degenerate pose must never be the reason a layer
    // asks for a large allocation, so bail to 1x.
    _view.copy(_world).applyMatrix4(camera.matrixWorldInverse);
    if (!(_view.z < -camera.near)) return 1;
    _world.project(camera);
    if (!Number.isFinite(_world.x) || !Number.isFinite(_world.y)) return 1;
    // NDC (-1..1) to pixels. The +0.5 centring offset cancels in edge differences,
    // so it is left out.
    _pts[i].x = _world.x * 0.5 * bufferW;
    _pts[i].y = _world.y * 0.5 * bufferH;
  }
  return screenScaleFromCorners(
    { tl: _pts[0], tr: _pts[1], bl: _pts[2], br: _pts[3] },
    logicalW,
    logicalH
  );
}
