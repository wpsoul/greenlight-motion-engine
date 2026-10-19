/*
 * The project camera (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 7 — moved verbatim out of the Player,
 * `xRef.current` → `engine.x`): the inverse camera rig a channel hangs from, the rotation a container's plate is
 * seen through, which camera films a channel (posed or neutral), and pointing the posed camera at a pose.
 *
 *   poseEngineCamera(engine, { channels, clipsMap, layoutFor, time, worldActive })   once per frame, before the
 *       channel loop: engine.cameraPose = the camera clip under the playhead (null: every rig stays neutral), and
 *       engine.posedCamera follows it (world view: neutral)
 */
import * as THREE from 'three';
import { resolveCameraPose, isCameraChannel, cameraProxyFromPose } from '../projectCamera';

// Pose a channel's camera rig. `values` is a camera pose (projectCamera.js) or null
// for identity. The rig carries the INVERSE of the camera move; the shared camera
// itself never moves, because a sequence clip pre-renders its inner channels with
// that same camera and would otherwise receive the move twice.
//
// Zoom scales x/y only, which is a LENS zoom: every layer magnifies by the same
// factor whatever its z, so parallax is unchanged. `camDolly` is the separate
// viewpoint move that DOES change perspective — the two opposed is what makes the
// vertigo preset work.
//
// Sign conventions follow the on-screen sense already used by the item transform
// fields (panX/panY): +camX pans the camera right (content slides left), +camY pans
// it down (content slides up), +camRoll cants the horizon clockwise, +camDolly
// pushes the camera in.
//
// Composition is three's own T · R · S: zoom about the frame centre, then tilt/roll
// about it, then pan.
// Exported so the plane-equivalence gate (MODEL_3D_LAYERS_PLAN Phase 1) can prove the
// model pass's forward camera and this inverse rig are the same camera model, against
// the real function rather than a copy of it.
export function applyCameraRig(rig, values, W, H) {
  if (!rig) return;
  if (!values) {
    rig.position.set(0, 0, 0);
    rig.rotation.set(0, 0, 0);
    rig.scale.set(1, 1, 1);
    return;
  }
  const zoom = Number.isFinite(values.camZoom) && values.camZoom > 0 ? values.camZoom : 1;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  rig.position.set(
    -(n(values.camX) / 100) * W,
    (n(values.camY) / 100) * H,
    n(values.camDolly)
  );
  rig.rotation.set(
    -(n(values.camTiltX) * Math.PI) / 180,
    -(n(values.camTiltY) * Math.PI) / 180,
    -(n(values.camRoll) * Math.PI) / 180
  );
  rig.scale.set(zoom, zoom, 1);
}

// The rotation a container's plate is seen through: the camera rig's own turn
// (it carries the INVERSE of the camera move, so a rigged channel is rotated by
// it) composed with the layer's resolved rotation. Grid Builder's "Face screen"
// cancels this, which is what lets a cell stay square to the view however the
// grid — or the camera — is rotated. Rotations only; position and zoom do not
// change which way a cell faces.
export function composeViewRotation(cameraPose, layerPrs) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const rigX = cameraPose ? -(n(cameraPose.camTiltX) * Math.PI) / 180 : 0;
  const rigY = cameraPose ? -(n(cameraPose.camTiltY) * Math.PI) / 180 : 0;
  const rigZ = cameraPose ? -(n(cameraPose.camRoll) * Math.PI) / 180 : 0;
  const lx = n(layerPrs?.rx);
  const ly = n(layerPrs?.ry);
  const lz = n(layerPrs?.rz);
  if (!rigX && !rigY && !rigZ) return { rx: lx, ry: ly, rz: lz };
  if (!lx && !ly && !lz) return { rx: rigX, ry: rigY, rz: rigZ };
  // Compose through THREE's own Euler order by borrowing its scratch objects.
  _viewEulerA.set(rigX, rigY, rigZ, 'XYZ');
  _viewEulerB.set(lx, ly, lz, 'XYZ');
  _viewQuatA.setFromEuler(_viewEulerA);
  _viewQuatB.setFromEuler(_viewEulerB);
  _viewQuatA.multiply(_viewQuatB);
  _viewEulerA.setFromQuaternion(_viewQuatA, 'XYZ');
  return { rx: _viewEulerA.x, ry: _viewEulerA.y, rz: _viewEulerA.z };
}
const _viewEulerA = new THREE.Euler();
const _viewEulerB = new THREE.Euler();
const _viewQuatA = new THREE.Quaternion();
const _viewQuatB = new THREE.Quaternion();

// Which camera films this channel.
//
// A camera-locked channel (and the camera channel itself) must NOT move with the
// project camera, so it is filmed by the neutral camera at (0,0,D); every other channel
// is filmed by the posed one. Two cameras, each internally coherent — the alternative,
// cancelling a moved camera with a rig transform, would have to undo the effective-FOV
// change as a 2D scale, which is exactly the incoherence this arrangement removes.
export function cameraForChannel(channel, posed, neutral) {
  if (!posed) return neutral;
  return (channel?.cameraLocked || isCameraChannel(channel)) ? neutral : posed;
}

// Point the posed camera at the frame's pose. Null pose (or world view, which puts the
// real camera on screen as a proxy) leaves it identical to the neutral camera, so a
// project with no camera layer renders byte-for-byte as it did before this existed.
export function syncPosedCamera(posed, neutral, pose, W, H) {
  if (!posed || !neutral) return;
  if (!pose) {
    posed.position.copy(neutral.position);
    posed.quaternion.copy(neutral.quaternion);
    posed.fov = neutral.fov;
  } else {
    const proxy = cameraProxyFromPose(pose, W, H);
    posed.position.copy(proxy.position);
    posed.quaternion.copy(proxy.quaternion);
    posed.fov = proxy.fov;
  }
  posed.aspect = neutral.aspect;
  posed.near = neutral.near;
  posed.far = neutral.far;
  posed.updateProjectionMatrix();
  posed.updateMatrixWorld(true);
}

// Camera pose for this frame: the camera clip under the playhead, or null when
// there is none (every rig stays neutral). Resolved BEFORE the channel loop so
// it doesn't matter where the camera channel sits in the stack.
export function poseEngineCamera(engine, { channels, clipsMap, layoutFor, time, worldActive }) {
  engine.cameraPose = resolveCameraPose(channels, clipsMap, layoutFor, time, { width: engine.videoSize.w, height: engine.videoSize.h });
  // Point the posed camera at this frame's pose. World view draws the project camera
  // as an on-screen proxy and films the scene with its own orbit camera, so the posed
  // camera stands down there and every layer is filmed neutrally.
  syncPosedCamera(
    engine.posedCamera,
    engine.camera,
    worldActive ? null : engine.cameraPose,
    engine.videoSize.w,
    engine.videoSize.h
  );
}
