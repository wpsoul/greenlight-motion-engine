// Camera layer — a virtual 2.5D camera over the whole layer stack.
//
// The camera is a TIMELINE LAYER, not a project setting: a `camera` clip on a
// dedicated camera channel, placed and trimmed like an adjustment layer. That means
// its keyframes are ordinary clip keyframes (`item.propertyKeyframes`, positions
// 0-100% of the clip) and it inherits trim, undo/redo, drag and the whole keyframe
// builder for free. Several camera clips can sit on the channel to chain moves; the
// one under the playhead wins, and outside every camera clip the rig is neutral.
//
// Only ONE camera channel may exist — two cameras over one stack has no meaning.
//
// Rendering: Player.jsx does NOT move the shared PerspectiveCamera (that would apply
// the move twice inside sequence clips, which pre-render their inner channels with
// the same camera). Instead each top-level channel group gets a parent "rig" group
// carrying the inverse transform. The project background is three's screen-fit
// `scene.background` pass, which object transforms never touch, so it correctly
// stays put as a backdrop.

import * as THREE from 'three';
import { TransitionEasing } from './types';
import { evalCameraRig } from './cameraRig';
import { getItemKeyframeValues } from './gsapTransitions';
import { buildParentIndex, resolveItemPrs } from './keyframeParenting';

// The comp plane exactly fills the frame at this distance — the same constant
// Player builds its PerspectiveCamera from.
export const CAMERA_FOV = 28;

const D2R = Math.PI / 180;

export function perspectiveDistance(height, fovDeg = CAMERA_FOV) {
  return (Math.max(1, height) * 0.5) / Math.tan(((fovDeg * Math.PI) / 180) * 0.5);
}

export const CAMERA_MEDIA_TYPE = 'camera';
export const CAMERA_CHANNEL_KIND = 'camera';
export const CAMERA_CLIP_DURATION_SECONDS = 5;

// Keyframable camera tracks. Same entry shape as KF_PROPS (keyframeProps.js) so
// VEKeyframeBuilder can consume this registry unchanged via its `baseKfProps` prop.
export const CAMERA_KF_PROPS = [
  // Zoom is deliberately uncapped upward — extreme push-ins are a valid look;
  // only the positive floor is structural (fovEff needs zoom > 0).
  { label: 'camZoom', displayLabel: 'Zoom', group: 'Motion', placeholder: '1', unit: '×', type: 'number', min: 0.1, step: 0.01 },
  { label: 'camX', displayLabel: 'Pan X', group: 'Motion', placeholder: '0', unit: '%', type: 'number', min: -200, max: 200, step: 0.5 },
  { label: 'camY', displayLabel: 'Pan Y', group: 'Motion', placeholder: '0', unit: '%', type: 'number', min: -200, max: 200, step: 0.5 },
  { label: 'camRoll', displayLabel: 'Roll', group: 'Motion', placeholder: '0', unit: 'deg', type: 'number', min: -180, max: 180, step: 0.5 },
  { label: 'camDolly', displayLabel: 'Dolly', group: 'Motion', placeholder: '0', unit: 'px', type: 'number', min: -3000, max: 3000, step: 10 },
  { label: 'camTiltX', displayLabel: 'Tilt X', group: 'Motion', placeholder: '0', unit: 'deg', type: 'number', min: -60, max: 60, step: 0.5 },
  { label: 'camTiltY', displayLabel: 'Tilt Y', group: 'Motion', placeholder: '0', unit: 'deg', type: 'number', min: -60, max: 60, step: 0.5 },
  { label: 'camDofEnabled', displayLabel: 'Depth of Field', group: 'Depth of Field', placeholder: '0', unit: '', type: 'number', min: 0, max: 1, step: 1 },
  { label: 'camFocusDistance', displayLabel: 'Focus Distance', group: 'Depth of Field', placeholder: '0', unit: 'px', type: 'number', min: 0, max: 20000, step: 10 },
  { label: 'camAperture', displayLabel: 'Aperture', group: 'Depth of Field', placeholder: '24', unit: 'px', type: 'number', min: 0, max: 300, step: 1 },
  { label: 'camBlurLevel', displayLabel: 'Blur Level', group: 'Depth of Field', placeholder: '100', unit: '%', type: 'number', min: 0, max: 300, step: 1 },
  { label: 'camHighlightGain', displayLabel: 'Highlight Gain', group: 'Depth of Field', placeholder: '0', unit: '%', type: 'number', min: 0, max: 300, step: 1 },
  { label: 'camFocusX', displayLabel: 'Focus Point X', group: 'Depth of Field', placeholder: '50', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'camFocusY', displayLabel: 'Focus Point Y', group: 'Depth of Field', placeholder: '50', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  // 0 = the focus point is only a depth probe (pure per-layer DOF). Above 0 it also
  // becomes a SHARP REGION of the frame: blur is held off inside the area and ramps
  // to the layer's full circle of confusion by its edge, so a subject can stay crisp
  // while the rest of its own layer falls away.
  { label: 'camFocusWidth', displayLabel: 'Focus Area Width', group: 'Depth of Field', placeholder: '0', unit: '%', type: 'number', min: 0, max: 200, step: 1 },
  // How far along the camera path the camera has travelled. Only does anything
  // while the clip has a path with `follow` on — see resolveCameraPath below. It
  // lives in the registry so the keyframe builder and the timeline diamonds pick
  // it up like any other track.
  { label: 'camPathT', displayLabel: 'Path Progress', group: 'Motion', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 0.5 },
  // A constant displacement from the path, in WORLD axes (+X right, +Y down,
  // +Z toward the viewer — the panel's own signs). The aim is computed AFTER it,
  // so a camera pushed off a shared path still looks at its target.
  { label: 'camPathOffsetX', displayLabel: 'Path Offset X', group: 'Motion', placeholder: '0', unit: 'px', type: 'number', min: -10000, max: 10000, step: 5 },
  { label: 'camPathOffsetY', displayLabel: 'Path Offset Y', group: 'Motion', placeholder: '0', unit: 'px', type: 'number', min: -10000, max: 10000, step: 5 },
  { label: 'camPathOffsetZ', displayLabel: 'Path Offset Z', group: 'Motion', placeholder: '0', unit: 'px', type: 'number', min: -10000, max: 10000, step: 5 },
  // Which entry of the Follow Object rig's target list the camera looks at,
  // 1-based. Fractional values BLEND the two neighbouring targets' positions, so
  // an eased key from 1 to 2 pans the look-at across smoothly — that blend IS the
  // hand-off mechanism, not an interpolation artefact to be rounded away.
  { label: 'camFollowTarget', displayLabel: 'Follow Object', group: 'Motion', placeholder: '1', unit: '', type: 'number', min: 1, step: 1 },
];

export const CAMERA_PATH_OFFSETS = ['camPathOffsetX', 'camPathOffsetY', 'camPathOffsetZ'];

export const CAMERA_KF_LABELS = CAMERA_KF_PROPS.map((p) => p.label);

/**
 * Fingerprint of a camera clip's keyframed move. The camera remembers the Motion
 * preset it was set from as `cameraPreset: { id, name, hash }` (the rig's
 * `rigLook` twin) and the panel calls it "edited" once this stops matching.
 * Keys are read the way sanitizePropertyKeyframes writes them (sorted, numeric
 * position, string value, a valid easing, a bezier only on CUSTOM keys), so a
 * save + reload round trip never reads as an edit.
 */
export function cameraMoveHash(propertyKeyframes) {
  const easings = new Set(Object.values(TransitionEasing));
  const parts = [];
  for (const prop of CAMERA_KF_LABELS) {
    const track = propertyKeyframes?.[prop];
    if (!Array.isArray(track) || track.length === 0) continue;
    const seen = new Set();
    const keys = track
      .filter((k) => k && Number.isFinite(Number.parseFloat(k.position)))
      .map((k) => {
        const easing = easings.has(k.easing) ? k.easing : TransitionEasing.EASE_IN_OUT;
        const bezier = easing === TransitionEasing.CUSTOM && Array.isArray(k.bezier)
          ? k.bezier.map((n) => Math.round(Number(n) * 1e4) / 1e4).join(',')
          : '';
        return [Math.round(Number.parseFloat(k.position) * 1000) / 1000, String(k.value ?? ''), easing, bezier];
      })
      .sort((a, b) => a[0] - b[0])
      .filter((k) => (seen.has(k[0]) ? false : (seen.add(k[0]), true)));
    parts.push(`${prop}=${keys.map((k) => k.join('|')).join(';')}`);
  }
  const str = parts.join('&');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
export const CAMERA_KF_GROUPS = ['Motion', 'Depth of Field'];

export const CAMERA_RIG_PROPS = [
  'camZoom', 'camX', 'camY', 'camRoll', 'camDolly', 'camTiltX', 'camTiltY',
];

// The pose props a Camera Rig / Motion Path OVERWRITES after the keyframe tracks
// have been read (getCameraPose → applyCameraRig / applyCameraPath, which
// Object.assign cameraPropsForWorldPoint over the evaluated values). A keyframe on
// any of these is dead weight while the camera is in 'rig' or 'path' mode.
//
// camZoom, the DOF family and camPathT are deliberately NOT here: zoom and depth of
// field compose with a rig, and camPathT is the very track a rig/path rides — a
// preset saved off a rig camera carries exactly that and must not be flipped free.
export const CAMERA_MOVE_DRIVEN_PROPS = [
  'camX', 'camY', 'camDolly', 'camTiltX', 'camTiltY', 'camRoll',
];

/**
 * Does applying this preset to THIS camera require dropping it back to Free Movement?
 *
 * True only when both halves are true: the camera's current mode really does drive
 * the pose (a rig always does; Motion Path only once the path is live), and the
 * preset lays down a track — or a base value — on a prop that mode overwrites.
 *
 * Applying a motion preset to a rigged camera used to look like it worked — the
 * keyframes appeared in the builder and on the timeline — while every frame ignored
 * them. Flipping the mode is the honest outcome; failing quietly is not. A preset
 * that only carries depth of field, zoom, or Path Progress is left to compose.
 */
export function presetNeedsFreeCamera(item, propertyKeyframes, base = null) {
  const mode = item?.cameraMoveMode;
  const drives = mode === 'rig' || (mode === 'path' && cameraPathIsLive(item?.cameraPath));
  if (!drives) return false;
  for (const prop of CAMERA_MOVE_DRIVEN_PROPS) {
    if (Array.isArray(propertyKeyframes?.[prop]) && propertyKeyframes[prop].length) return true;
    const value = Number(base?.[prop]);
    if (Number.isFinite(value) && Math.abs(value - CAMERA_NEUTRAL[prop]) > 1e-4) return true;
  }
  return false;
}

// Neutral (identity) pose. Every evaluated frame is filled in from this, so a track
// the user never added contributes nothing.
export const CAMERA_NEUTRAL = {
  camZoom: 1,
  camX: 0,
  camY: 0,
  camRoll: 0,
  camDolly: 0,
  camTiltX: 0,
  camTiltY: 0,
  camDofEnabled: 0,
  // Zero means "the comp plane" and is resolved to the current camera distance
  // by Player. This keeps old camera clips correct when a project is resized.
  camFocusDistance: 0,
  camAperture: 24,
  camBlurLevel: 100,
  camHighlightGain: 0,
  camFocusX: 50,
  camFocusY: 50,
  camFocusWidth: 0,
  camPathT: 0,
  camPathOffsetX: 0,
  camPathOffsetY: 0,
  camPathOffsetZ: 0,
  camFollowTarget: 1,
};

// ── Camera path ──
//
// An optional 3D spline the camera can ride, authored in the world view. Points
// are world-space pixels (the same space layer positions live in: x right, y up,
// z toward the viewer, origin at the centre of the comp plane). Each anchor carries
// its bezier tangents as OFFSETS from itself, so dragging the anchor takes its
// handles with it; `manual` marks a hand-shaped anchor that auto-tangents must
// leave alone.
//
// The path is stored on the camera ITEM, so it saves, undoes and duplicates with
// the clip like every other camera property.
export const CAMERA_PATH_AIMS = ['free', 'tangent', 'target'];

export const CAMERA_PATH_DEFAULT = {
  points: [],
  closed: false,
  follow: false,
  aim: 'tangent',
  targetId: null, // null = the comp centre
  // "Make keyframes for each point" — camPathT carries one key per anchor instead
  // of a plain 0 → 100 ramp, so the camera arrives at an anchor on a keyframe and
  // the pacing between anchors is editable. The count/closed pair records what the
  // generated track was built for, so the panel can regenerate it when the path
  // gains or loses a point rather than leaving a stale track behind.
  keyframesPerPoint: false,
};

const vec3 = (v, fallback = null) => {
  if (!v || typeof v !== 'object') return fallback;
  return { x: num(v.x), y: num(v.y), z: num(v.z) };
};

export function sanitizeCameraPath(path) {
  if (!path || typeof path !== 'object') return null;
  const points = Array.isArray(path.points) ? path.points : [];
  const clean = [];
  for (const p of points) {
    if (!p || typeof p !== 'object') continue;
    const point = { x: num(p.x), y: num(p.y), z: num(p.z) };
    const hIn = vec3(p.hIn);
    const hOut = vec3(p.hOut);
    if (hIn) point.hIn = hIn;
    if (hOut) point.hOut = hOut;
    if (p.manual === true) point.manual = true;
    clean.push(point);
  }
  if (!clean.length) return null;
  return {
    points: clean,
    closed: path.closed === true,
    follow: path.follow === true,
    aim: CAMERA_PATH_AIMS.includes(path.aim) ? path.aim : 'tangent',
    targetId: typeof path.targetId === 'string' && path.targetId ? path.targetId : null,
    keyframesPerPoint: path.keyframesPerPoint === true,
    ...(path.keyframesPerPoint === true ? {
      keyframesPerPointCount: Math.max(0, Math.round(num(path.keyframesPerPointCount))),
      keyframesPerPointClosed: path.keyframesPerPointClosed === true,
    } : {}),
  };
}

export function cameraPathIsLive(path) {
  return !!path?.follow && Array.isArray(path.points) && path.points.length >= 2;
}

// Auto tangents for anchors the user hasn't shaped. Derived from the Catmull-Rom
// tangent m = (P[i+1] - P[i-1]) / 2, whose equivalent cubic-bezier control offset
// is m/3 — so an untouched path is exactly the Catmull-Rom curve through its
// points, and a hand-dragged handle is a local departure from it.
export function refreshCameraPathHandles(points, closed) {
  const n = points.length;
  if (n < 2) return points;
  const at = (i) => {
    const idx = closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    return points[idx];
  };
  for (let i = 0; i < n; i += 1) {
    if (points[i].manual) continue;
    const prev = at(i - 1);
    const next = at(i + 1);
    let mx; let my; let mz;
    if (!closed && i === 0) {
      mx = next.x - points[0].x; my = next.y - points[0].y; mz = next.z - points[0].z;
    } else if (!closed && i === n - 1) {
      mx = points[n - 1].x - prev.x; my = points[n - 1].y - prev.y; mz = points[n - 1].z - prev.z;
    } else {
      mx = (next.x - prev.x) * 0.5; my = (next.y - prev.y) * 0.5; mz = (next.z - prev.z) * 0.5;
    }
    mx /= 3; my /= 3; mz /= 3;
    points[i].hOut = { x: round4(mx), y: round4(my), z: round4(mz) };
    points[i].hIn = { x: round4(-mx), y: round4(-my), z: round4(-mz) };
  }
  return points;
}

const bezier = (a, b, c, d, t) => {
  const u = 1 - t;
  return (u * u * u * a) + (3 * u * u * t * b) + (3 * u * t * t * c) + (t * t * t * d);
};

const bezierDeriv = (a, b, c, d, t) => {
  const u = 1 - t;
  return (3 * u * u * (b - a)) + (6 * u * t * (c - b)) + (3 * t * t * (d - c));
};

/**
 * Point (and unit tangent) at `u` (0-1) along the path.
 *
 * Segments are walked at uniform parameter rather than by arc length: a camera
 * move is keyframed against time by the user anyway, and the exactness is not
 * worth resampling the whole curve on every frame.
 */
export function evaluateCameraPath(path, u) {
  const pts = path?.points || [];
  if (pts.length < 2) return null;
  const closed = path.closed === true;
  const segments = closed ? pts.length : pts.length - 1;
  const clamped = closed ? ((u % 1) + 1) % 1 : Math.max(0, Math.min(1, u));
  const scaled = clamped * segments;
  let index = Math.floor(scaled);
  if (index >= segments) index = segments - 1;
  const t = scaled - index;

  const a = pts[index];
  const b = pts[(index + 1) % pts.length];
  const ah = a.hOut || { x: 0, y: 0, z: 0 };
  const bh = b.hIn || { x: 0, y: 0, z: 0 };
  const axis = (k) => {
    const p0 = a[k];
    const p1 = a[k] + ah[k];
    const p2 = b[k] + bh[k];
    const p3 = b[k];
    return {
      value: bezier(p0, p1, p2, p3, t),
      slope: bezierDeriv(p0, p1, p2, p3, t),
    };
  };
  const x = axis('x'); const y = axis('y'); const z = axis('z');
  const len = Math.hypot(x.slope, y.slope, z.slope) || 1;
  return {
    position: { x: x.value, y: y.value, z: z.value },
    tangent: { x: x.slope / len, y: y.slope / len, z: z.slope / len },
  };
}

// Props whose motion cannot be represented as a 2D affine on the preview overlay
// (they are true perspective changes). PreviewTransformOverlay disables the gizmo
// while any of these is off-neutral rather than drawing a wrong selection box.
export const CAMERA_PERSPECTIVE_PROPS = ['camDolly', 'camTiltX', 'camTiltY'];

const num = (value, fallback = 0) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const round4 = (n) => Math.round(n * 10000) / 10000;

// ── Channel / clip identification ──

/**
 * Where the project camera really is, given a pose.
 *
 * This is THE camera model: rigs stay identity and this forward pose is what films
 * every layer, in the normal render, the world view and the model pass alike. With rig
 * matrix M = T·R·S the proxy's matrix is M⁻¹·C.
 *
 * camZoom becomes an effective FOV — fovEff = 2·atan( tan(fov/2) / zoom ) — which is a
 * real lens zoom and keeps CameraHelper's cone honest. It is NOT identical to the old
 * per-channel rig, whose (zoom, zoom, 1) scale was applied before the tilt: with zoom
 * and tilt combined the two diverge by up to half a frame width. That divergence is why
 * the rig stopped carrying the pose — see MODEL_3D_LAYERS_PLAN.md, Phase 0.5.
 */
export function cameraProxyFromPose(pose, W, H, out = {}) {
  const D = perspectiveDistance(H);
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const zoom = Number.isFinite(pose?.camZoom) && pose.camZoom > 0 ? pose.camZoom : 1;

  // The rig's rotation, then its inverse — the proxy's own orientation.
  const rigEuler = new THREE.Euler(
    -n(pose?.camTiltX) * D2R,
    -n(pose?.camTiltY) * D2R,
    -n(pose?.camRoll) * D2R,
    'XYZ'
  );
  const rigQuat = new THREE.Quaternion().setFromEuler(rigEuler);
  const invQuat = rigQuat.clone().invert();

  // position = R⁻¹ · ( camX/100·W/zoom , -camY/100·H/zoom , D - camDolly )
  //
  // The pan is divided by the zoom because camX/camY are SCREEN-space quantities —
  // "% of the frame", which is what the panel field means and what the editor has
  // always done. A narrowed FOV magnifies everything including the camera's own
  // lateral offset, so without this a 10 % pan would slide twice as far at 2× zoom
  // and every existing project that pans while zooming would reframe. Dividing here
  // makes the screen offset exactly `camX %` at any zoom, and it cancels cleanly
  // against camDolly.
  const position = new THREE.Vector3(
    ((n(pose?.camX) / 100) * W) / zoom,
    (-(n(pose?.camY) / 100) * H) / zoom,
    D - n(pose?.camDolly)
  ).applyQuaternion(invQuat);

  out.position = position;
  out.quaternion = invQuat;
  out.fov = 2 * Math.atan(Math.tan((CAMERA_FOV * D2R) * 0.5) / zoom) / D2R;
  out.distance = D;
  return out;
}

// Scratch objects — this runs per corner, per layer, per pointer move.
const _pfMat = new THREE.Matrix4();
const _pfVec = new THREE.Vector3();
const _pfPos = new THREE.Vector3();
const _pfQuat = new THREE.Quaternion();
const _pfScale = new THREE.Vector3(1, 1, 1);

/**
 * Project a point given in FRAME pixel coordinates (origin top-left, +y down) at
 * world depth `z` through the project camera, and return where it lands in frame
 * pixel coordinates on screen.
 *
 * This is the exact perspective the renderer draws with, not an approximation: it
 * builds the camera from cameraProxyFromPose, the same function syncPosedCamera uses,
 * so there is only ever one camera model. A 2D affine can express zoom/roll/pan but
 * NOT dolly, tilt or layer depth — which is why overlays that need to sit on a layer
 * under those moves have to come through here.
 *
 * Returns null when the point is at or behind the camera, where no screen position
 * exists and any number would be a lie.
 */
export function projectFramePoint(pose, W, H, fx, fy, z = 0) {
  const width = Number(W) > 0 ? Number(W) : 1;
  const height = Number(H) > 0 ? Number(H) : 1;
  const proxy = cameraProxyFromPose(pose || {}, width, height);
  _pfPos.copy(proxy.position);
  _pfQuat.copy(proxy.quaternion);
  _pfMat.compose(_pfPos, _pfQuat, _pfScale).invert();
  // Frame space (y down, origin top-left) → world space (y up, origin centre).
  _pfVec.set(Number(fx) - width / 2, height / 2 - Number(fy), Number(z) || 0);
  _pfVec.applyMatrix4(_pfMat);
  // Camera looks down -z; anything at or behind the plane has no projection.
  if (!(_pfVec.z < -1e-6)) return null;
  const focal = (height * 0.5) / Math.tan(((proxy.fov * Math.PI) / 180) * 0.5);
  const sx = (_pfVec.x * focal) / -_pfVec.z;
  const sy = (_pfVec.y * focal) / -_pfVec.z;
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return null;
  return { x: width / 2 + sx, y: height / 2 - sy };
}

export function isCameraChannel(channel) {
  return !!channel && channel.kind === CAMERA_CHANNEL_KIND;
}

export function findCameraChannel(channels) {
  return (channels || []).find(isCameraChannel) || null;
}

export function isCameraClip(clip) {
  return clip?.mediaType === CAMERA_MEDIA_TYPE;
}

// The camera channel is always the TOP of the stack. Channel order is z-order and
// the last entry renders highest, so the camera clip is pinned to the end of the
// array. It is not a creative choice a user should have to maintain: the camera
// frames everything, so anything above it would be framing the camera. Enforced on
// every channel write (pushChannels) and on load, so drag-reorder, undo/redo,
// import and agent-authored projects all converge on the same layout.
export function pinCameraChannelTop(channels) {
  if (!Array.isArray(channels) || channels.length < 2) return channels;
  const index = channels.findIndex(isCameraChannel);
  if (index < 0 || index === channels.length - 1) return channels;
  const next = channels.slice();
  const [cameraChannel] = next.splice(index, 1);
  next.push(cameraChannel);
  return next;
}

// ── World space ↔ camera props ──
//
// Player poses each channel's RIG with the inverse of the camera move while the
// shared PerspectiveCamera sits still at (0, 0, D). So with rig matrix M = T·R·S,
// the camera's real world matrix is M⁻¹·C, giving
//
//   position = R⁻¹ · ( camX/100·W , -camY/100·H , D - camDolly )
//
// and these two functions are that relation in each direction. camZoom is left
// out on purpose: it is a LENS zoom (rig.scale is x/y only), so it changes
// magnification without moving the viewpoint.

/** Rig rotation (the inverse of the camera's own orientation) for a pose. */
function rigQuaternion(values) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(
    -(num(values?.camTiltX) * Math.PI) / 180,
    -(num(values?.camTiltY) * Math.PI) / 180,
    -(num(values?.camRoll) * Math.PI) / 180,
    'XYZ'
  ));
}

export function cameraWorldPosition(values, width, height) {
  const D = perspectiveDistance(height);
  return new THREE.Vector3(
    (num(values?.camX) / 100) * width,
    -(num(values?.camY) / 100) * height,
    D - num(values?.camDolly)
  ).applyQuaternion(rigQuaternion(values).invert());
}

/**
 * A world point (plus optional camera orientation) back into camX/camY/camDolly.
 * `camQuat` is the CAMERA's orientation; pass null to keep the pose's own tilt.
 */
export function cameraPropsForWorldPoint(position, camQuat, values, width, height) {
  const D = perspectiveDistance(height);
  const rigQuat = camQuat ? camQuat.clone().invert() : rigQuaternion(values);
  const q = position.clone().applyQuaternion(rigQuat);
  const out = {
    camX: round4((q.x / width) * 100),
    camY: round4(-(q.y / height) * 100),
    camDolly: round4(D - q.z),
  };
  if (camQuat) {
    const e = new THREE.Euler().setFromQuaternion(rigQuat, 'XYZ');
    out.camTiltX = round4(-(e.x * 180) / Math.PI);
    out.camTiltY = round4(-(e.y * 180) / Math.PI);
    out.camRoll = round4(-(e.z * 180) / Math.PI);
  }
  return out;
}

// Object3D.lookAt aims +Z for anything that isn't a camera or light, which would
// point the camera exactly backwards. Build the orientation from a matrix instead.
export function cameraAimQuaternion(from, target) {
  const m = new THREE.Matrix4().lookAt(from, target, new THREE.Vector3(0, 1, 0));
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

/**
 * Fold a live camera path into an evaluated pose, in place.
 *
 * Precedence copies the flipbook builder's: an explicit target wins, otherwise a
 * path faces along its own tangent, otherwise the user's tilt/roll tracks are left
 * alone. Returns true when the path took over the camera's position.
 */
/**
 * A Camera Rig pose. Evaluated, never baked — the rig writes no path, so a user's
 * hand-drawn Motion Path survives switching modes back and forth untouched.
 * Runs INSTEAD of applyCameraPath: the two modes are mutually exclusive.
 */
/**
 * The world point a Follow Object rig is built around: the followed layer's
 * position at this instant, or a blend of two layers while the Follow Object
 * track sits between whole indices (that blend is the smooth hand-off).
 * Null when the rig has no usable target — the rig then orbits the comp centre,
 * exactly like a classic orbit, so an empty list is never a frozen camera.
 */
function resolveFollowCenter(rig, values, frame) {
  const targets = Array.isArray(rig?.targets)
    ? rig.targets.filter((id) => typeof id === 'string' && id)
    : [];
  if (!targets.length || typeof frame?.resolveTarget !== 'function') return null;
  const v = Math.max(1, Math.min(targets.length, num(values.camFollowTarget, 1)));
  const i0 = Math.min(targets.length - 1, Math.floor(v) - 1);
  const i1 = Math.min(targets.length - 1, i0 + 1);
  const f = Math.max(0, Math.min(1, v - (i0 + 1)));
  // A dangling id (layer deleted mid-undo or mid-paste) resolves to null and the
  // OTHER endpoint carries the centre — same no-op-on-dangling discipline as
  // motionFollow, so nothing is destroyed that a later edit would have restored.
  const p0 = frame.resolveTarget(targets[i0]);
  const p1 = i1 !== i0 && f > 0 ? frame.resolveTarget(targets[i1]) : p0;
  const a = p0 || p1;
  if (!a) return null;
  const b = p1 || a;
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    z: a.z + (b.z - a.z) * f,
  };
}

export function applyCameraRig(item, values, frame) {
  if (item?.cameraMoveMode !== 'rig') return false;
  if (!frame?.width || !frame?.height) return false;
  // THE MODE ALONE IS ENOUGH. Requiring `item.cameraRig` as well meant a camera
  // switched to Camera Rig — but whose parameters were still the panel's defaults,
  // never yet written to the item — evaluated to nothing: the camera did not move
  // and the 3D view drew no curve, with every field on screen looking correct.
  // evalCameraRig merges CAMERA_RIG_DEFAULTS itself, so an absent rig is simply the
  // default orbit.
  const rig = item.cameraRig || {};
  let ctx = null;
  if (rig.type === 'follow') {
    const center = resolveFollowCenter(rig, values, frame);
    if (center) {
      ctx = { center };
      // Stashed on the evaluated pose so the 3D view can draw the rig's curve
      // around the point the camera is actually following this frame.
      values.camFollowCenter = center;
    }
  }
  const { pos, aim, roll } = evalCameraRig(rig, num(values.camPathT, 0) / 100, ctx);
  const position = new THREE.Vector3(pos.x, pos.y, pos.z);
  const target = new THREE.Vector3(aim.x, aim.y, aim.z);
  let camQuat = null;
  if (position.distanceToSquared(target) > 1e-6) camQuat = cameraAimQuaternion(position, target);
  Object.assign(values, cameraPropsForWorldPoint(position, camQuat, values, frame.width, frame.height));
  if (Number.isFinite(roll) && Math.abs(roll) > 1e-4) values.camRoll = num(values.camRoll, 0) + roll;
  return true;
}

export function applyCameraPath(item, values, frame) {
  // Modes are exclusive: a project on 'rig' or 'free' must not also ride a path it
  // still has stored, or switching away from Motion Path would appear to do nothing.
  if (item?.cameraMoveMode && item.cameraMoveMode !== 'path') return false;
  const path = item?.cameraPath;
  if (!cameraPathIsLive(path) || !frame?.width || !frame?.height) return false;
  const hit = evaluateCameraPath(path, num(values.camPathT, 0) / 100);
  if (!hit) return false;

  // Offset first, aim second: a camera nudged off a shared path must still face
  // its target (and the tangent it aims along is the curve's, not the nudge's).
  const position = new THREE.Vector3(
    hit.position.x + num(values.camPathOffsetX),
    hit.position.y - num(values.camPathOffsetY),
    hit.position.z + num(values.camPathOffsetZ)
  );
  let camQuat = null;
  if (path.aim === 'tangent') {
    camQuat = cameraAimQuaternion(position, position.clone().add(
      new THREE.Vector3(hit.tangent.x, hit.tangent.y, hit.tangent.z)
    ));
  } else if (path.aim === 'target') {
    const target = frame.targetPoint || new THREE.Vector3(0, 0, 0);
    // Standing exactly on the target has no aim to speak of — keep the last one.
    if (position.distanceToSquared(target) > 1e-6) {
      camQuat = cameraAimQuaternion(position, target);
    }
  }
  Object.assign(values, cameraPropsForWorldPoint(position, camQuat, values, frame.width, frame.height));
  return true;
}

// ── Evaluation ──

// Pose for one camera item at its own progress (0-1). Camera tracks ride the same
// per-property track machinery as every other layer, so this is just a neutral-filled
// read of getItemKeyframeValues.
export function getCameraPose(item, progress, frame = null) {
  const kf = getItemKeyframeValues(item, progress);
  const values = { ...CAMERA_NEUTRAL };
  let any = false;
  // Inspector values are the base pose; keyframe tracks override them at the
  // playhead. Storing the base on the camera item makes a single, unkeyframed
  // camera DOF setup useful while retaining the shared keyframe builder.
  for (const prop of CAMERA_KF_LABELS) {
    const value = prop === 'camDofEnabled'
      ? (item?.[prop] === true ? 1 : item?.[prop] === false ? 0 : num(item?.[prop], CAMERA_NEUTRAL[prop]))
      : num(item?.[prop], CAMERA_NEUTRAL[prop]);
    values[prop] = value;
    if (Math.abs(value - CAMERA_NEUTRAL[prop]) > 1e-4) any = true;
  }
  for (const prop of CAMERA_KF_LABELS) {
    if (Number.isFinite(kf?.[prop])) {
      values[prop] = kf[prop];
      any = true;
    }
  }
  // A live path OVERWRITES the position it drives, so it runs after the tracks are
  // read. It also counts as a move in its own right: at 0% progress every value can
  // still look neutral, and returning null there would park the camera at origin
  // for the first frame of the travel.
  if (applyCameraRig(item, values, frame) || applyCameraPath(item, values, frame)) any = true;
  return any ? values : null;
}

// The pose in effect at an absolute timeline time: the camera clip under the
// playhead, or null when the playhead is outside every camera clip (rig neutral).
// `layoutFor` returns a channel's [{startTime,endTime,duration}] layout.
// `frame` is { width, height } — the project's video size. It is only needed by a
// live camera path (which is authored in world pixels and has to be converted back
// into camera props), so callers without one simply get path-free behaviour.
export function resolveCameraPose(channels, clipsMap, layoutFor, time, frame = null) {
  const channel = findCameraChannel(channels);
  if (!channel || channel.visible === false) return null;
  const layout = layoutFor(channel);
  if (!layout) return null;
  // Inclusive bounds with the same epsilon as resolveActiveIndex, so a layer that
  // is still visible on its exact last frame keeps its camera. Backwards iteration
  // biases a shared boundary between two camera clips toward the incoming one.
  const EPS = 1e-6;
  for (let i = channel.items.length - 1; i >= 0; i -= 1) {
    const entry = layout[i];
    if (!entry || time < entry.startTime - EPS || time > entry.endTime + EPS) continue;
    const item = channel.items[i];
    if (!isCameraClip(clipsMap.get(item?.clipId))) continue;
    const duration = entry.endTime - entry.startTime;
    const progress = duration > 0 ? (time - entry.startTime) / duration : 0;
    let poseFrame = frame;
    // A "look at this layer" path needs the layer's position at this instant, so
    // resolve it here where the channel stack is in hand.
    if (frame && item?.cameraPath?.aim === 'target' && item.cameraPath.targetId) {
      poseFrame = {
        ...frame,
        targetPoint: layerWorldPoint(channels, clipsMap, layoutFor, time, item.cameraPath.targetId, frame),
      };
    }
    // A Follow Object rig gets a RESOLVER rather than one point: which layer(s)
    // it needs depends on the interpolated Follow Object value, which is only
    // known once getCameraPose has read the tracks. The parent index is built
    // once and lazily — a blend resolves two targets at the same instant.
    if (frame && item?.cameraMoveMode === 'rig' && item?.cameraRig?.type === 'follow') {
      let targetIndex = null;
      poseFrame = {
        ...frame,
        resolveTarget: (id) => {
          if (!targetIndex) targetIndex = buildParentIndex(channels, layoutFor);
          return layerWorldPoint(channels, clipsMap, layoutFor, time, id, frame, targetIndex);
        },
      };
    }
    return getCameraPose(item, Math.max(0, Math.min(1, progress)), poseFrame);
  }
  return null;
}

/**
 * Where a layer sits in world space at `time`, resolved through the SAME machinery
 * that positions the layer's mesh (localPrs / resolveItemPrs) — so a camera aimed
 * here points at what the user sees, including a layer riding an object Motion
 * Path and a layer moved by its parent. The earlier pan+track arithmetic here
 * silently ignored both, and a followed layer on a path lost its camera.
 *
 * `index` is optional: pass a prebuilt buildParentIndex when resolving several
 * targets at one instant (the follow blend does), otherwise one is built here.
 */
export function layerWorldPoint(channels, clipsMap, layoutFor, time, itemId, frame, index = null) {
  const byId = index || buildParentIndex(channels, layoutFor);
  const prs = resolveItemPrs(byId, itemId, time, {
    W: frame.width,
    H: frame.height,
    evalKeyframes: (item, progress) => getItemKeyframeValues(item, progress),
  });
  return prs ? new THREE.Vector3(prs.px, prs.py, prs.pz) : null;
}

export function isCameraIdentity(values) {
  if (!values) return true;
  for (const prop of CAMERA_RIG_PROPS) {
    const neutral = CAMERA_NEUTRAL[prop];
    if (Math.abs((Number.isFinite(values[prop]) ? values[prop] : neutral) - neutral) > 1e-4) return false;
  }
  return true;
}

// Resolve the camera-owned optical controls for a frame. A zero focus distance
// intentionally follows the default comp plane, so existing projects and resized
// compositions remain focused without a migration.
export function getCameraDofSettings(values, defaultFocusDistance) {
  const fallbackDistance = Math.max(1, num(defaultFocusDistance, 1));
  return {
    enabled: num(values?.camDofEnabled, 0) >= 0.5,
    focusDistance: Math.max(1, num(values?.camFocusDistance, 0) || fallbackDistance),
    aperture: Math.max(0, num(values?.camAperture, CAMERA_NEUTRAL.camAperture)),
    blurLevel: Math.max(0, num(values?.camBlurLevel, CAMERA_NEUTRAL.camBlurLevel)),
    highlightGain: Math.max(0, num(values?.camHighlightGain, CAMERA_NEUTRAL.camHighlightGain)),
    // Screen-space sharp region around the focus point. Width 0 keeps the point a
    // pure depth probe (what the focus picker writes) and leaves the frame governed
    // by per-layer CoC alone.
    focusX: Math.max(0, Math.min(100, num(values?.camFocusX, CAMERA_NEUTRAL.camFocusX))),
    focusY: Math.max(0, Math.min(100, num(values?.camFocusY, CAMERA_NEUTRAL.camFocusY))),
    focusWidth: Math.max(0, num(values?.camFocusWidth, CAMERA_NEUTRAL.camFocusWidth)),
  };
}

// Fraction of a layer's circle of confusion that survives at a point, given the
// screen-space focus area. 1 everywhere when the area is disabled.
export function getCameraFocusFalloff(settings, dx, dy) {
  const width = num(settings?.focusWidth, 0);
  if (!(width > 0)) return 1;
  const inner = width * 0.5;
  const d = Math.hypot(dx, dy);
  if (d <= inner) return 0;
  if (d >= width) return 1;
  const t = (d - inner) / Math.max(1e-6, width - inner);
  return t * t * (3 - 2 * t); // smoothstep
}

export function getCameraCoCRadius(settings, layerDistance) {
  if (!settings?.enabled || settings.aperture <= 0 || settings.blurLevel <= 0) return 0;
  const distance = Math.max(1, num(layerDistance, 1));
  return settings.aperture
    * Math.abs(settings.focusDistance - distance)
    / distance
    * (settings.blurLevel / 100);
}

// True when the pose contains motion the preview overlay's 2D affine can't express.
export function cameraNeedsPerspective(values) {
  if (!values) return false;
  return CAMERA_PERSPECTIVE_PROPS.some((prop) => Math.abs(num(values[prop]) - CAMERA_NEUTRAL[prop]) > 1e-4);
}

// ── Built-in preset library ──
//
// Every key is Smooth. The presets were originally authored with a per-move easing
// (Expo Out for the whip, Linear for an even travel, Sine for a drift), but a preset
// is a starting point that gets hand-edited, and gizmo edits key in Smooth — so a
// mixed table made every preset-seeded track a patchwork. One easing throughout is
// the predictable base; reach for the keyframe editor to shape a move from there.
// Same "common snapshot" shape as KEYFRAME_PRESETS (EditorPanel.jsx) — positions are
// 0-100% of the camera CLIP, so a preset stretches to whatever length the clip is
// trimmed to, exactly like a layer preset. `duration` is the length the clip is
// resized to when the preset is applied from the panel.

export const CAMERA_PRESETS = [
  {
    id: 'quiet-push',
    category: 'Cinematic',
    name: 'Quiet Push',
    description: 'A restrained forward creep that adds attention without announcing itself',
    duration: 6,
    keyframes: [
      { position: 0, easing: TransitionEasing.EASE_IN_OUT, properties: { camZoom: '1.02', camDolly: '0', camY: '1' } },
      { position: 100, easing: TransitionEasing.EASE_IN_OUT, properties: { camZoom: '1.16', camDolly: '80', camY: '0' } },
    ],
  },
  {
    id: 'wide-reveal',
    category: 'Cinematic',
    name: 'Wide Reveal',
    description: 'Begins close and slightly low, then opens cleanly onto the full composition',
    duration: 5.5,
    keyframes: [
      { position: 0, easing: TransitionEasing.EASE_IN_OUT, properties: { camZoom: '1.36', camY: '-5', camTiltX: '2.5', camDolly: '120' } },
      { position: 100, easing: TransitionEasing.EASE_IN_OUT, properties: { camZoom: '1', camY: '0', camTiltX: '0', camDolly: '0' } },
    ],
  },
  {
    id: 'lateral-glide',
    category: 'Cinematic',
    name: 'Lateral Glide',
    description: 'A polished slider move with just enough yaw to reveal depth between layers',
    duration: 6,
    keyframes: [
      { position: 0, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '-7', camY: '0.8', camTiltY: '-1.8', camZoom: '1.08' } },
      { position: 50, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '0', camY: '0', camTiltY: '0', camZoom: '1.1' } },
      { position: 100, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '7', camY: '-0.8', camTiltY: '1.8', camZoom: '1.12' } },
    ],
  },
  {
    id: 'parallax-arc',
    category: 'Cinematic',
    name: 'Parallax Arc',
    description: 'An arcing move that lets foreground and background layers separate naturally',
    duration: 7,
    keyframes: [
      { position: 0, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '-8', camTiltY: '-4.5', camDolly: '-80', camZoom: '1.08' } },
      { position: 50, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '0', camTiltY: '0', camDolly: '170', camZoom: '1.13' } },
      { position: 100, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '8', camTiltY: '4.5', camDolly: '-80', camZoom: '1.08' } },
    ],
  },
  {
    id: 'crane-rise',
    category: 'Cinematic',
    name: 'Crane Rise',
    description: 'Rises through the composition while easing into a wider, level view',
    duration: 6,
    keyframes: [
      { position: 0, easing: TransitionEasing.EASE_IN_OUT, properties: { camY: '-7', camTiltX: '4', camZoom: '1.13', camDolly: '0' } },
      { position: 100, easing: TransitionEasing.EASE_IN_OUT, properties: { camY: '5', camTiltX: '-2', camZoom: '1.06', camDolly: '120' } },
    ],
  },
  {
    id: 'soft-punch',
    category: 'Editorial',
    name: 'Soft Punch',
    description: 'A quick emphasis beat with a controlled overshoot and a clean settle',
    duration: 1.6,
    keyframes: [
      { position: 0, easing: TransitionEasing.EASE_IN_OUT, properties: { camZoom: '1', camX: '0', camY: '0' } },
      { position: 35, easing: TransitionEasing.EASE_IN_OUT, properties: { camZoom: '1.2', camX: '-1', camY: '0.5' } },
      { position: 62, easing: TransitionEasing.EASE_IN_OUT, properties: { camZoom: '1.145', camX: '0', camY: '0' } },
      { position: 100, easing: TransitionEasing.EASE_IN_OUT, properties: { camZoom: '1.16', camX: '0', camY: '0' } },
    ],
  },
  {
    id: 'whip-and-land',
    category: 'Editorial',
    name: 'Whip & Land',
    description: 'A real reframing whip that accelerates late and settles on a new composition',
    duration: 1.15,
    keyframes: [
      { position: 0, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '0', camRoll: '0', camZoom: '1.08' } },
      { position: 24, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '0', camRoll: '0', camZoom: '1.08' } },
      { position: 63, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '49', camRoll: '2', camZoom: '1.13' } },
      { position: 80, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '42', camRoll: '0', camZoom: '1.1' } },
      { position: 100, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '42', camRoll: '0', camZoom: '1.1' } },
    ],
  },
  {
    id: 'handheld-breath',
    category: 'Editorial',
    name: 'Handheld Breath',
    description: 'Small, irregular operator drift without the synthetic wobble',
    duration: 8,
    keyframes: [
      { position: 0, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '-0.2', camY: '0.2', camRoll: '-0.08', camZoom: '1.04' } },
      { position: 19, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '0.65', camY: '-0.35', camRoll: '0.16', camZoom: '1.048' } },
      { position: 43, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '-0.45', camY: '0.5', camRoll: '-0.13', camZoom: '1.042' } },
      { position: 68, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '0.35', camY: '0.12', camRoll: '0.1', camZoom: '1.052' } },
      { position: 87, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '-0.55', camY: '-0.28', camRoll: '-0.12', camZoom: '1.046' } },
      { position: 100, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '-0.2', camY: '0.2', camRoll: '-0.08', camZoom: '1.04' } },
    ],
  },
  {
    id: 'documentary-follow',
    category: 'Editorial',
    name: 'Documentary Follow',
    description: 'A gently imperfect follow move that keeps finding the subject',
    duration: 5,
    keyframes: [
      { position: 0, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '-3', camY: '1.5', camRoll: '-0.15', camZoom: '1.06' } },
      { position: 38, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '1', camY: '-0.5', camRoll: '0.25', camZoom: '1.1' } },
      { position: 72, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '-0.5', camY: '0.8', camRoll: '-0.1', camZoom: '1.08' } },
      { position: 100, easing: TransitionEasing.EASE_IN_OUT, properties: { camX: '2.5', camY: '0', camRoll: '0.1', camZoom: '1.12' } },
    ],
  },
  {
    id: 'rack-to-near',
    category: 'Focus',
    name: 'Rack to Near',
    description: 'Holds the background, then pulls focus decisively onto a near subject',
    duration: 3.5,
    keyframes: [
      { position: 0, easing: TransitionEasing.EASE_IN_OUT, properties: { camDofEnabled: '1', camFocusDistance: '2800', camFocusX: '68', camFocusY: '48', camAperture: '36', camBlurLevel: '110', camHighlightGain: '18' } },
      { position: 22, easing: TransitionEasing.EASE_IN_OUT, properties: { camDofEnabled: '1', camFocusDistance: '2800', camFocusX: '68', camFocusY: '48', camAperture: '36', camBlurLevel: '110', camHighlightGain: '18' } },
      { position: 78, easing: TransitionEasing.EASE_IN_OUT, properties: { camDofEnabled: '1', camFocusDistance: '1350', camFocusX: '35', camFocusY: '55', camAperture: '36', camBlurLevel: '110', camHighlightGain: '18' } },
      { position: 100, easing: TransitionEasing.EASE_IN_OUT, properties: { camDofEnabled: '1', camFocusDistance: '1350', camFocusX: '35', camFocusY: '55', camAperture: '36', camBlurLevel: '110', camHighlightGain: '18' } },
    ],
  },
  {
    id: 'rack-to-far',
    category: 'Focus',
    name: 'Rack to Far',
    description: 'Transfers attention from a close detail to the wider scene behind it',
    duration: 3.5,
    keyframes: [
      { position: 0, easing: TransitionEasing.EASE_IN_OUT, properties: { camDofEnabled: '1', camFocusDistance: '1350', camFocusX: '35', camFocusY: '55', camAperture: '36', camBlurLevel: '110', camHighlightGain: '18' } },
      { position: 22, easing: TransitionEasing.EASE_IN_OUT, properties: { camDofEnabled: '1', camFocusDistance: '1350', camFocusX: '35', camFocusY: '55', camAperture: '36', camBlurLevel: '110', camHighlightGain: '18' } },
      { position: 78, easing: TransitionEasing.EASE_IN_OUT, properties: { camDofEnabled: '1', camFocusDistance: '2800', camFocusX: '68', camFocusY: '48', camAperture: '36', camBlurLevel: '110', camHighlightGain: '18' } },
      { position: 100, easing: TransitionEasing.EASE_IN_OUT, properties: { camDofEnabled: '1', camFocusDistance: '2800', camFocusX: '68', camFocusY: '48', camAperture: '36', camBlurLevel: '110', camHighlightGain: '18' } },
    ],
  },
  {
    id: 'focus-chase',
    category: 'Focus',
    name: 'Focus Chase',
    description: 'Moves attention across three depth beats for layered product or title layouts',
    duration: 6,
    keyframes: [
      { position: 0, easing: TransitionEasing.EASE_IN_OUT, properties: { camDofEnabled: '1', camFocusDistance: '1450', camFocusX: '28', camFocusY: '55', camAperture: '30', camBlurLevel: '95', camHighlightGain: '12' } },
      { position: 45, easing: TransitionEasing.EASE_IN_OUT, properties: { camDofEnabled: '1', camFocusDistance: '2600', camFocusX: '72', camFocusY: '42', camAperture: '30', camBlurLevel: '95', camHighlightGain: '12' } },
      { position: 100, easing: TransitionEasing.EASE_IN_OUT, properties: { camDofEnabled: '1', camFocusDistance: '1750', camFocusX: '48', camFocusY: '50', camAperture: '30', camBlurLevel: '95', camHighlightGain: '12' } },
    ],
  },
  {
    id: 'macro-bloom',
    category: 'Focus',
    name: 'Macro Bloom',
    description: 'Pushes into a detail while focus and highlight bloom tighten around it',
    duration: 4.5,
    keyframes: [
      { position: 0, easing: TransitionEasing.EASE_IN_OUT, properties: { camZoom: '1.05', camDolly: '0', camDofEnabled: '1', camFocusDistance: '2500', camFocusX: '50', camFocusY: '50', camAperture: '28', camBlurLevel: '100', camHighlightGain: '15' } },
      { position: 52, easing: TransitionEasing.EASE_IN_OUT, properties: { camZoom: '1.16', camDolly: '100', camDofEnabled: '1', camFocusDistance: '1650', camFocusX: '50', camFocusY: '50', camAperture: '46', camBlurLevel: '125', camHighlightGain: '32' } },
      { position: 100, easing: TransitionEasing.EASE_IN_OUT, properties: { camZoom: '1.23', camDolly: '180', camDofEnabled: '1', camFocusDistance: '1150', camFocusX: '50', camFocusY: '50', camAperture: '38', camBlurLevel: '110', camHighlightGain: '22' } },
    ],
  },
];

// Screen-recording auto-zoom (autoZoom.js) is authored as a LAYER move — scale +
// xPercent/yPercent that push the clicked spot to the frame centre. A camera does the
// same job by moving the opposite way, so the pans flip sign: a layer sliding left is
// a camera panning right.
export function autoZoomToCameraKeyframes(keyframes) {
  if (!Array.isArray(keyframes) || keyframes.length < 2) return null;
  const flip = (v) => {
    const n = num(v, 0);
    return n === 0 ? '0' : String(round4(-n));
  };
  return keyframes.map((kf) => {
    const p = kf.properties || {};
    const properties = {};
    if (p.scale != null) properties.camZoom = String(p.scale);
    if (p.xPercent != null) properties.camX = flip(p.xPercent);
    if (p.yPercent != null) properties.camY = flip(p.yPercent);
    return { position: kf.position, easing: kf.easing, properties };
  });
}

// Turn a camera clip's tracks back into a portable preset (for "Save as preset").
export function cameraItemToPreset(item, duration, { name = 'Camera preset' } = {}) {
  const tracks = item?.propertyKeyframes || {};
  const byPosition = new Map();
  for (const [prop, track] of Object.entries(tracks)) {
    if (!CAMERA_KF_LABELS.includes(prop)) continue;
    for (const k of track || []) {
      const position = round4(num(k.position));
      const key = position.toFixed(3);
      if (!byPosition.has(key)) {
        byPosition.set(key, {
          position,
          easing: k.easing,
          // Keep a hand-shaped segment's handles, or a preset saved off a
          // graph-edited move would come back Smooth (commonToPropertyKeyframes
          // reads `bezier` back out on the way in).
          ...(k.easing === TransitionEasing.CUSTOM && Array.isArray(k.bezier)
            ? { bezier: [...k.bezier] }
            : {}),
          properties: {},
        });
      }
      byPosition.get(key).properties[prop] = String(k.value);
    }
  }
  const keyframes = [...byPosition.values()].sort((a, b) => a.position - b.position);

  // Un-keyframed settings — a depth-of-field rig is usually dialled in as static
  // values, not animated — are saved alongside the motion so a preset restores the
  // whole look. Keyframed props are skipped: their tracks already carry them.
  const base = {};
  for (const prop of CAMERA_KF_LABELS) {
    if (Array.isArray(tracks[prop]) && tracks[prop].length) continue;
    const raw = item?.[prop];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = prop === 'camDofEnabled'
      ? (raw === true ? 1 : raw === false ? 0 : num(raw, CAMERA_NEUTRAL[prop]))
      : num(raw, CAMERA_NEUTRAL[prop]);
    if (Math.abs(value - CAMERA_NEUTRAL[prop]) < 1e-4) continue;
    base[prop] = round4(value);
  }

  // Worth saving if it animates something OR carries a non-default rig.
  if (!keyframes.length && !Object.keys(base).length) return null;
  return {
    name,
    description: '',
    duration: round4(Math.max(0.1, num(duration, CAMERA_CLIP_DURATION_SECONDS))),
    keyframes,
    ...(Object.keys(base).length ? { base } : {}),
  };
}

// Base values a preset restores onto the camera item, clamped to the registry.
export function sanitizeCameraPresetBase(base) {
  if (!base || typeof base !== 'object') return {};
  const out = {};
  for (const prop of CAMERA_KF_LABELS) {
    if (base[prop] === undefined || base[prop] === null || base[prop] === '') continue;
    const meta = CAMERA_KF_PROPS.find((p) => p.label === prop);
    const value = num(base[prop], CAMERA_NEUTRAL[prop]);
    const min = Number.isFinite(meta?.min) ? meta.min : -Infinity;
    const max = Number.isFinite(meta?.max) ? meta.max : Infinity;
    out[prop] = prop === 'camDofEnabled'
      ? value >= 0.5
      : Math.max(min, Math.min(max, value));
  }
  return out;
}
