// Motion paths for ordinary visual layers.
//
// Points use the editor's canonical world-pixel space: x points right, y points
// up, z points toward the viewer, and the composition centre is the origin. This
// is deliberately the same space as the camera path and localPrs(), so preview,
// WebCodecs export, 3D models and the two editor views all sample one curve.

// Tangent handles are offsets from their anchor. `manual` prevents the automatic
// Catmull-Rom pass from replacing a hand-shaped pair.

// Follow Path owns position. Aim Along Path additionally aligns the layer's local
// +X axis with the curve tangent; Free leaves the layer's rotation untouched.

// Anchors may carry a rotation (rx/ry/rz, degrees, same sign convention as the
// layer Rotate fields), interpolated between anchors so a rotated point turns
// the layer as it arrives. Aim 'tangent' applies it in the aimed local frame on
// top of the tangent alignment; aim 'points' uses the anchor rotations alone
// (world axes, no tangent) — and falls back to Free while no anchor is rotated,
// so picking the mode before rotating anything changes nothing. Zero rotations
// are not stored.

// A constant displacement from the sampled curve, in the panel's own units:
// +X right, +Y DOWN, +Z toward the viewer (exactly translateX/Y/Z). It rides in
// WORLD axes, not the aimed local frame, so several layers sharing one copied path
// stay in formation however the curve turns. Item fields rather than part of the
// path, so copying a path never carries someone else's spacing with it.
export const OBJECT_MOTION_PATH_KEY = 'motionPath';
export const OBJECT_MOTION_PATH_PROGRESS = 'motionPathT';
export const OBJECT_MOTION_PATH_OFFSETS = ['motionPathOffsetX', 'motionPathOffsetY', 'motionPathOffsetZ'];
export const OBJECT_MOTION_PATH_AIMS = ['tangent', 'points', 'free'];

// Path Progress tracks: a layer's motionPathT and the camera's camPathT (which a
// Camera Rig rides too). A new one starts LINEAR — constant speed is what riding a
// path means, and an S-curve on progress reads as the move stalling at both ends.
// Every place that STARTS such a track reads this: Follow Path, per-point keys, the
// stopwatch, Add Property in the Keyframes panel. 'Linear' is TransitionEasing.LINEAR,
// spelled out so this module keeps no editor imports.
export const PATH_PROGRESS_PROPS = [OBJECT_MOTION_PATH_PROGRESS, 'camPathT'];
export const PATH_PROGRESS_EASING = 'Linear';
export const isPathProgressProp = (prop) => PATH_PROGRESS_PROPS.includes(prop);

export const OBJECT_MOTION_PATH_DEFAULT = {
  points: [],
  closed: false,
  follow: false,
  aim: 'tangent',
  keyframesPerPoint: false,
};

const num = (value, fallback = 0) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const round4 = (n) => Math.round(n * 10000) / 10000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const vec3 = (value) => {
  if (!value || typeof value !== 'object') return null;
  if (![value.x, value.y, value.z].every((v) => Number.isFinite(Number(v)))) return null;
  return { x: num(value.x), y: num(value.y), z: num(value.z) };
};

export function sanitizeObjectMotionPath(path) {
  if (!path || typeof path !== 'object') return null;
  const points = [];
  for (const raw of Array.isArray(path.points) ? path.points : []) {
    const p = vec3(raw);
    if (!p) continue;
    const point = p;
    const hIn = vec3(raw.hIn);
    const hOut = vec3(raw.hOut);
    if (hIn) point.hIn = hIn;
    if (hOut) point.hOut = hOut;
    if (raw.manual === true) point.manual = true;
    const rx = num(raw.rx); const ry = num(raw.ry); const rz = num(raw.rz);
    if (rx || ry || rz) { point.rx = rx; point.ry = ry; point.rz = rz; }
    points.push(point);
  }
  if (!points.length) return null;
  return {
    points,
    closed: path.closed === true,
    follow: path.follow === true,
    aim: OBJECT_MOTION_PATH_AIMS.includes(path.aim) ? path.aim : 'tangent',
    keyframesPerPoint: path.keyframesPerPoint === true,
    ...(path.keyframesPerPoint === true ? {
      keyframesPerPointCount: Math.max(0, Math.round(num(path.keyframesPerPointCount))),
      keyframesPerPointClosed: path.keyframesPerPointClosed === true,
    } : {}),
  };
}

// One Path Progress key per anchor. Open paths finish on the final point; closed
// paths add a last 100% key that returns to point one, completing the loop.
//
// Shared by BOTH path editors — a layer's motionPathT and the camera's camPathT —
// since the two curves are parameterised identically (see evaluateCameraPath).
export function makePathPointKeyframes(pointCount, closed = false, easing = PATH_PROGRESS_EASING) {
  const count = Math.max(0, Math.round(num(pointCount)));
  if (count < 2) return [];
  const intervals = closed ? count : count - 1;
  return Array.from({ length: intervals + 1 }, (_, index) => {
    const progress = round4((index / intervals) * 100);
    return { position: progress, value: String(progress), easing };
  });
}

export function objectMotionPathIsLive(path) {
  return path?.follow === true && Array.isArray(path.points) && path.points.length >= 2;
}

// Text on Path: the glyph run rides the curve inside the text canvas, so Follow
// Path must NOT also move the quad — localPrs skips its position override while
// this is live and the text draw owns the placement instead.
export function textOnPathIsLive(item) {
  return item?.textPathEnabled === true
    && Array.isArray(item?.motionPath?.points)
    && item.motionPath.points.length >= 2;
}

export function refreshObjectMotionPathHandles(points, closed) {
  const n = points.length;
  if (n < 2) return points;
  const at = (i) => points[closed
    ? ((i % n) + n) % n
    : Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < n; i += 1) {
    if (points[i].manual) continue;
    const prev = at(i - 1);
    const next = at(i + 1);
    let mx; let my; let mz;
    if (!closed && i === 0) {
      mx = next.x - points[i].x; my = next.y - points[i].y; mz = next.z - points[i].z;
    } else if (!closed && i === n - 1) {
      mx = points[i].x - prev.x; my = points[i].y - prev.y; mz = points[i].z - prev.z;
    } else {
      mx = (next.x - prev.x) * 0.5;
      my = (next.y - prev.y) * 0.5;
      mz = (next.z - prev.z) * 0.5;
    }
    points[i].hOut = { x: round4(mx / 3), y: round4(my / 3), z: round4(mz / 3) };
    points[i].hIn = { x: round4(-mx / 3), y: round4(-my / 3), z: round4(-mz / 3) };
  }
  return points;
}

const cubic = (a, b, c, d, t) => {
  const u = 1 - t;
  return u ** 3 * a + 3 * u * u * t * b + 3 * u * t * t * c + t ** 3 * d;
};

const cubicDerivative = (a, b, c, d, t) => {
  const u = 1 - t;
  return 3 * u * u * (b - a) + 6 * u * t * (c - b) + 3 * t * t * (d - c);
};

export function evaluateObjectMotionPath(path, progress) {
  const points = path?.points || [];
  if (points.length < 2) return null;
  const closed = path.closed === true;
  const segments = closed ? points.length : points.length - 1;
  const u = closed
    ? ((num(progress) % 1) + 1) % 1
    : clamp(num(progress), 0, 1);
  const scaled = u * segments;
  const index = Math.min(segments - 1, Math.floor(scaled));
  const t = scaled - index;
  const a = points[index];
  const b = points[(index + 1) % points.length];
  const ah = a.hOut || { x: 0, y: 0, z: 0 };
  const bh = b.hIn || { x: 0, y: 0, z: 0 };
  const axis = (key) => ({
    value: cubic(a[key], a[key] + ah[key], b[key] + bh[key], b[key], t),
    slope: cubicDerivative(a[key], a[key] + ah[key], b[key] + bh[key], b[key], t),
  });
  const x = axis('x'); const y = axis('y'); const z = axis('z');
  const length = Math.hypot(x.slope, y.slope, z.slope) || 1;
  // Anchor rotation blends linearly over the same segment parameter as position,
  // matching the pacing of the per-point Path Progress keys.
  const rotated = points.some((p) => p.rx || p.ry || p.rz);
  const lerpRot = (key) => num(a[key]) + (num(b[key]) - num(a[key])) * t;
  return {
    position: { x: x.value, y: y.value, z: z.value },
    tangent: { x: x.slope / length, y: y.slope / length, z: z.slope / length },
    pointRotation: rotated
      ? { rx: lerpRot('rx'), ry: lerpRot('ry'), rz: lerpRot('rz') }
      : null,
  };
}

// Quaternion pieces kept local so the dependency-free PRS module never needs
// three. All Euler work is THREE's default XYZ order.
const quatForXAxis = (direction) => {
  const dx = num(direction?.x, 1);
  const dy = num(direction?.y);
  const dz = num(direction?.z);
  const len = Math.hypot(dx, dy, dz) || 1;
  const x = dx / len; const y = dy / len; const z = dz / len;
  let qx = 0; let qy = -z; let qz = y; let qw = 1 + x;
  if (qw < 1e-7) { qx = 0; qy = 0; qz = 1; qw = 0; }
  const qLen = Math.hypot(qx, qy, qz, qw) || 1;
  return { x: qx / qLen, y: qy / qLen, z: qz / qLen, w: qw / qLen };
};

const quatFromEulerXYZ = (x, y, z) => {
  const c1 = Math.cos(x / 2); const s1 = Math.sin(x / 2);
  const c2 = Math.cos(y / 2); const s2 = Math.sin(y / 2);
  const c3 = Math.cos(z / 2); const s3 = Math.sin(z / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
};

const quatMultiply = (a, b) => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});

const eulerFromQuat = ({ x: qx, y: qy, z: qz, w: qw }) => {
  const m11 = 1 - 2 * (qy * qy + qz * qz);
  const m12 = 2 * (qx * qy - qz * qw);
  const m13 = 2 * (qx * qz + qy * qw);
  const m22 = 1 - 2 * (qx * qx + qz * qz);
  const m23 = 2 * (qy * qz - qx * qw);
  const m32 = 2 * (qy * qz + qx * qw);
  const m33 = 1 - 2 * (qx * qx + qy * qy);
  const ry = Math.asin(clamp(m13, -1, 1));
  if (Math.abs(m13) < 0.9999999) {
    return { rx: Math.atan2(-m23, m33), ry, rz: Math.atan2(-m12, m11) };
  }
  return { rx: Math.atan2(m32, m22), ry, rz: 0 };
};

/** Quaternion rotating local +X onto `direction`, as THREE XYZ Euler radians. */
export function eulerForObjectPathTangent(direction) {
  return eulerFromQuat(quatForXAxis(direction));
}

const DEG2RAD = Math.PI / 180;

/**
 * Aim orientation composed with the blended anchor rotation, applied in the
 * aimed local frame — "rotate X" spins the layer around its own path axis. The
 * degree→radian signs match localPrs so a point rotation reads like the layer's
 * Rotate fields.
 */
export function eulerForObjectPathPose(tangent, pointRotation) {
  const aim = quatForXAxis(tangent);
  if (!pointRotation) return eulerFromQuat(aim);
  const local = quatFromEulerXYZ(
    -num(pointRotation.rx) * DEG2RAD,
    -num(pointRotation.ry) * DEG2RAD,
    -num(pointRotation.rz) * DEG2RAD
  );
  return eulerFromQuat(quatMultiply(aim, local));
}

/** The blended anchor rotation by itself — aim 'points'. Degrees → the same
 *  canonical radians localPrs would produce for the layer Rotate fields. */
export function eulerForObjectPointRotation(pointRotation) {
  if (!pointRotation) return null;
  return {
    rx: -num(pointRotation.rx) * DEG2RAD,
    ry: -num(pointRotation.ry) * DEG2RAD,
    rz: -num(pointRotation.rz) * DEG2RAD,
  };
}

/** A keyframed value wins over the item's own; both are optional. */
const liveValue = (item, keyframeValues, key) => (
  Number.isFinite(Number(keyframeValues?.[key]))
    ? Number(keyframeValues[key])
    : num(item?.[key])
);

export function resolveObjectMotionPath(item, keyframeValues = null) {
  const path = item?.motionPath;
  if (!objectMotionPathIsLive(path)) return null;
  const progress = liveValue(item, keyframeValues, OBJECT_MOTION_PATH_PROGRESS);
  const hit = evaluateObjectMotionPath(path, progress / 100);
  if (!hit) return null;
  const rotation = path.aim === 'tangent'
    ? eulerForObjectPathPose(hit.tangent, hit.pointRotation)
    : path.aim === 'points'
      ? eulerForObjectPointRotation(hit.pointRotation)
      : null;
  // Offset moves the layer off the curve without moving the curve: the tangent —
  // and so every aim — is still the one the path itself has at this progress.
  const [ox, oy, oz] = OBJECT_MOTION_PATH_OFFSETS.map((key) => liveValue(item, keyframeValues, key));
  const position = (ox || oy || oz)
    ? { x: hit.position.x + ox, y: hit.position.y - oy, z: hit.position.z + oz }
    : hit.position;
  return { ...hit, position, rotation };
}
