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

// ── Animated motion path ────────────────────────────────────────────────────
//
// The path itself can be keyframed, like a layer-mask outline or a shape path:
// propertyKeyframes[MOTION_PATH_KF_KEY] holds snapshots of the POINTS (world
// pixels, 3D, with handles and anchor rotations). `closed`, `follow`, `aim` stay
// on item.motionPath — they are properties of the path, not of a moment.
//
// Its own codec on purpose: the shape/mask codec is 2D unit-box space clamped to
// ±8, which would flatten z, drop anchor rotations and crush world pixels.
// item.motionPath.points is kept in step with the key at the playhead, so every
// static reader (point count, Text on Path liveness, Copy path) stays valid.
export const MOTION_PATH_KF_KEY = 'motionPathPoints';
export const isMotionPathTrackKey = (prop) => prop === MOTION_PATH_KF_KEY;

const round3 = (n) => Math.round(n * 1000) / 1000;

export function encodeMotionPathValue(points) {
  return JSON.stringify((points || []).map((p) => {
    const out = {
      x: round3(num(p?.x)), y: round3(num(p?.y)), z: round3(num(p?.z)),
      hIn: { x: round3(num(p?.hIn?.x)), y: round3(num(p?.hIn?.y)), z: round3(num(p?.hIn?.z)) },
      hOut: { x: round3(num(p?.hOut?.x)), y: round3(num(p?.hOut?.y)), z: round3(num(p?.hOut?.z)) },
      manual: true,
    };
    const rx = num(p?.rx); const ry = num(p?.ry); const rz = num(p?.rz);
    if (rx || ry || rz) { out.rx = round3(rx); out.ry = round3(ry); out.rz = round3(rz); }
    return out;
  }));
}

// Decoded snapshots are immutable and shared: a dense roto track is read every
// frame, so each key string is parsed once. Bounded so a long editing session
// cannot grow it without limit.
const decodedMotionPaths = new Map();
const DECODED_MOTION_PATH_LIMIT = 4096;

export function decodeMotionPathValue(value) {
  if (Array.isArray(value)) return sanitizeObjectMotionPath({ points: value })?.points || null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const cached = decodedMotionPaths.get(value);
  if (cached !== undefined) return cached;
  let points = null;
  try {
    points = sanitizeObjectMotionPath({ points: JSON.parse(value) })?.points || null;
  } catch {
    points = null;
  }
  if (decodedMotionPaths.size >= DECODED_MOTION_PATH_LIMIT) decodedMotionPaths.clear();
  decodedMotionPaths.set(value, points);
  return points;
}

/** Loader coercer: '' drops an unusable key (cleanTrack). */
export function coerceMotionPathValue(value) {
  const points = decodeMotionPathValue(value);
  return points && points.length >= 2 ? encodeMotionPathValue(points) : '';
}

/**
 * Point-wise blend of two snapshots — anchors, handles and anchor rotations.
 * Structural edits rewrite every key, so the counts match; the clamp to the
 * shorter list only guards a hand-edited project (same rule as mask paths).
 */
export function interpolateMotionPaths(a, b, t) {
  if (!Array.isArray(a) || !a.length) return Array.isArray(b) ? b : [];
  if (!Array.isArray(b) || !b.length) return a;
  if (!Number.isFinite(t) || t <= 0) return a;
  if (t >= 1) return b;
  const lerp = (p, q) => p + (q - p) * t;
  const lerpVec = (p, q) => ({
    x: lerp(num(p?.x), num(q?.x)), y: lerp(num(p?.y), num(q?.y)), z: lerp(num(p?.z), num(q?.z)),
  });
  const n = Math.min(a.length, b.length);
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = a[i]; const q = b[i];
    const point = {
      x: lerp(p.x, q.x), y: lerp(p.y, q.y), z: lerp(p.z, q.z),
      hIn: lerpVec(p.hIn, q.hIn), hOut: lerpVec(p.hOut, q.hOut), manual: true,
    };
    if (p.rx || p.ry || p.rz || q.rx || q.ry || q.rz) {
      point.rx = lerp(num(p.rx), num(q.rx));
      point.ry = lerp(num(p.ry), num(q.ry));
      point.rz = lerp(num(p.rz), num(q.rz));
    }
    out[i] = point;
  }
  return out;
}

// The path a layer rides at this frame: the keyed snapshot when the track is
// live, else the stored one. Same object for the same snapshot array, so the
// identity-keyed caches downstream (Text on Path's arc table) hit while a key
// holds and rebuild only while the outline actually moves.
const livePathCache = new WeakMap();

export function liveObjectMotionPath(item, keyframeValues = null) {
  const base = item?.motionPath;
  if (!base) return null;
  const keyed = keyframeValues?.[MOTION_PATH_KF_KEY];
  if (!Array.isArray(keyed) || keyed.length < 2) return base;
  const hit = livePathCache.get(keyed);
  if (hit && hit.base === base) return hit.path;
  const path = { ...base, points: keyed };
  livePathCache.set(keyed, { base, path });
  return path;
}

// Horizontal reach (min/max x) of every snapshot of a keyed path — Text on Path
// sizes its plate from this ONCE per track instead of from the moving outline,
// so the texture is not reallocated on every frame of a roto track. Keyed on the
// track array (a new array after any edit), sampled like the static path.
const reachCache = new WeakMap();

export function motionPathTrackReach(track, closed = false) {
  if (!Array.isArray(track) || !track.length) return null;
  const hit = reachCache.get(track);
  if (hit && hit.closed === closed) return hit.out;
  let min = Infinity; let max = -Infinity;
  for (const key of track) {
    const points = decodeMotionPathValue(key?.value);
    if (!points || points.length < 2) continue;
    const path = { points, closed };
    for (let i = 0; i <= 64; i += 1) {
      const at = evaluateObjectMotionPath(path, i / 64);
      if (!at) break;
      if (at.position.x < min) min = at.position.x;
      if (at.position.x > max) max = at.position.x;
    }
  }
  const out = Number.isFinite(min) ? { min, max } : null;
  reachCache.set(track, { closed, out });
  return out;
}

// A cheap fingerprint of a point list — the Text on Path paint signature has to
// change while a keyed outline moves (the item object does not), and stay put
// while a key holds.
export function motionPathSignature(points) {
  if (!Array.isArray(points)) return '';
  let a = 0; let b = 0;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    a += (num(p.x) * 0.618 + num(p.y) * 1.414 + num(p.z) * 0.271) * (i + 1);
    b += num(p.hOut?.x) * 0.37 + num(p.hOut?.y) * 0.53 + num(p.hIn?.x) * 0.29 + num(p.hIn?.y) * 0.71;
  }
  return `${points.length}:${a.toFixed(2)}:${b.toFixed(2)}`;
}

const samePoint = (p, q) => !!p && !!q
  && Math.abs(num(p.x) - num(q.x)) < 1e-6
  && Math.abs(num(p.y) - num(q.y)) < 1e-6
  && Math.abs(num(p.z) - num(q.z)) < 1e-6;

// Split the cubic a→b of `points` at parameter t (de Casteljau): the new anchor
// with exact handles, and the neighbours' handles shortened to match, so the
// curve keeps its shape. Returns a new array with the anchor inserted at `at`.
function insertSplitPoint(points, at, t) {
  const n = points.length;
  const out = points.map((p) => ({ ...p, hIn: { ...(p.hIn || { x: 0, y: 0, z: 0 }) }, hOut: { ...(p.hOut || { x: 0, y: 0, z: 0 }) } }));
  const ai = (at - 1 + n) % n;
  const bi = at % n;
  const a = out[ai]; const b = out[bi];
  const pos = {}; const d = {};
  for (const k of ['x', 'y', 'z']) {
    const p0 = a[k]; const p1 = a[k] + a.hOut[k]; const p2 = b[k] + b.hIn[k]; const p3 = b[k];
    pos[k] = cubic(p0, p1, p2, p3, t);
    d[k] = cubicDerivative(p0, p1, p2, p3, t);
  }
  const point = {
    x: pos.x, y: pos.y, z: pos.z,
    hIn: { x: -d.x * t / 3, y: -d.y * t / 3, z: -d.z * t / 3 },
    hOut: { x: d.x * (1 - t) / 3, y: d.y * (1 - t) / 3, z: d.z * (1 - t) / 3 },
    manual: true,
  };
  if (a.rx || a.ry || a.rz || b.rx || b.ry || b.rz) {
    point.rx = num(a.rx) + (num(b.rx) - num(a.rx)) * t;
    point.ry = num(a.ry) + (num(b.ry) - num(a.ry)) * t;
    point.rz = num(a.rz) + (num(b.rz) - num(a.rz)) * t;
  }
  for (const k of ['x', 'y', 'z']) { a.hOut[k] *= t; b.hIn[k] *= (1 - t); }
  a.manual = true; b.manual = true;
  out.splice(at, 0, point);
  return out;
}

// Where along the segment ending at `at` the anchor `p` sits (closest sample).
function splitParamFor(points, at, p) {
  const n = points.length;
  const a = points[(at - 1 + n) % n]; const b = points[at % n];
  const ah = a.hOut || { x: 0, y: 0, z: 0 }; const bh = b.hIn || { x: 0, y: 0, z: 0 };
  let best = 0.5; let bestD = Infinity;
  for (let s = 1; s < 64; s += 1) {
    const t = s / 64;
    const dx = cubic(a.x, a.x + ah.x, b.x + bh.x, b.x, t) - p.x;
    const dy = cubic(a.y, a.y + ah.y, b.y + bh.y, b.y, t) - p.y;
    const dz = cubic(a.z, a.z + ah.z, b.z + bh.z, b.z, t) - p.z;
    const dd = dx * dx + dy * dy + dz * dz;
    if (dd < bestD) { bestD = dd; best = t; }
  }
  return best;
}

/**
 * An edit of a KEYFRAMED motion path, as the item updates to write. Every path
 * editor (the 2D overlay, the 3D view, the panel) writes a whole `motionPath`;
 * this turns that write into what the animation needs, the way a layer mask's
 * outline behaves:
 *
 *   - same point count → the edited points land in the key at `pct` (updated
 *     within `tolerancePct`, else inserted);
 *   - one anchor added → it is added to EVERY key, split at the same spot of the
 *     curve so no key changes shape (the key at `pct` takes the edit verbatim);
 *   - one anchor removed → removed from every key;
 *   - anything else (a preset, a pasted path) → every key takes the new points.
 *
 * `item.motionPath` always becomes the edited path, so it stays the snapshot at
 * the playhead. `basePoints` is the outline the editor showed (the snapshot at
 * the playhead) — the reference for finding an added or removed anchor. Returns
 * null when the path has no track — a plain write.
 */
export function applyMotionPathEdit(item, nextPath, pct, tolerancePct = 0, basePoints = null) {
  const pk = item?.propertyKeyframes;
  const track = pk?.[MOTION_PATH_KF_KEY];
  if (!Array.isArray(track) || !track.length) return null;
  if (!nextPath || !Array.isArray(nextPath.points) || nextPath.points.length < 2) {
    const { [MOTION_PATH_KF_KEY]: _drop, ...rest } = pk;
    return { motionPath: nextPath, propertyKeyframes: rest };
  }
  const next = nextPath.points;
  // Not a geometry edit (Follow, Aim, Closed… written over the stored points):
  // a plain write, no key.
  const stored = item?.motionPath?.points;
  if (next === stored || (Array.isArray(stored) && stored.length === next.length
    && stored.every((p, i) => samePoint(p, next[i])
      && samePoint(p.hIn || { x: 0, y: 0, z: 0 }, next[i].hIn || { x: 0, y: 0, z: 0 })
      && samePoint(p.hOut || { x: 0, y: 0, z: 0 }, next[i].hOut || { x: 0, y: 0, z: 0 })
      && num(p.rx) === num(next[i].rx) && num(p.ry) === num(next[i].ry) && num(p.rz) === num(next[i].rz)))) {
    return null;
  }
  const position = clamp(round4(num(pct)), 0, 100);
  const tol = Math.max(0.001, num(tolerancePct));
  // The outline the editor started from: the live snapshot at the playhead when
  // the caller has it (the editors draw that one), else the stored path.
  const prevStatic = Array.isArray(basePoints) && basePoints.length
    ? basePoints
    : (Array.isArray(item?.motionPath?.points) ? item.motionPath.points : []);
  const decoded = track.map((k) => decodeMotionPathValue(k?.value));
  const keyCount = decoded.find((pts) => pts?.length)?.length ?? prevStatic.length;
  const atHead = track.findIndex((k) => Math.abs(num(k?.position, -1) - position) <= tol);
  let keys;
  if (next.length === keyCount) {
    keys = track.map((k) => ({ ...k }));
  } else if (next.length === keyCount + 1 && prevStatic.length === keyCount) {
    let at = prevStatic.findIndex((p, i) => !samePoint(p, next[i]));
    if (at < 0) at = keyCount;
    const closed = nextPath.closed === true;
    keys = track.map((k, i) => {
      const pts = decoded[i];
      if (!pts || pts.length !== keyCount) return { ...k, value: encodeMotionPathValue(next) };
      if (at === 0 || (at === keyCount && !closed)) {
        // A new end anchor: carry it the same distance from that key's end.
        const ref = at === 0 ? 0 : keyCount - 1;
        const off = { x: next[at].x - prevStatic[ref].x, y: next[at].y - prevStatic[ref].y, z: next[at].z - prevStatic[ref].z };
        const added = { ...next[at], x: pts[ref].x + off.x, y: pts[ref].y + off.y, z: pts[ref].z + off.z };
        const out = pts.slice();
        out.splice(at, 0, added);
        return { ...k, value: encodeMotionPathValue(out) };
      }
      const t = splitParamFor(prevStatic, at, next[at]);
      return { ...k, value: encodeMotionPathValue(insertSplitPoint(pts, at, t)) };
    });
  } else if (next.length === keyCount - 1 && prevStatic.length === keyCount) {
    let at = next.findIndex((p, i) => !samePoint(p, prevStatic[i]));
    if (at < 0) at = keyCount - 1;
    keys = track.map((k, i) => {
      const pts = decoded[i];
      if (!pts || pts.length !== keyCount) return { ...k, value: encodeMotionPathValue(next) };
      return { ...k, value: encodeMotionPathValue(pts.filter((_, j) => j !== at)) };
    });
  } else {
    const value = encodeMotionPathValue(next);
    keys = track.map((k) => ({ ...k, value }));
  }
  const value = encodeMotionPathValue(next);
  if (atHead >= 0) {
    keys[atHead] = { ...keys[atHead], value };
  } else {
    const before = [...track].sort((a, b) => a.position - b.position).filter((k) => k.position < position).pop();
    keys.push({ position, value, easing: before?.easing || PATH_PROGRESS_EASING });
    keys.sort((a, b) => a.position - b.position);
  }
  return { motionPath: nextPath, propertyKeyframes: { ...pk, [MOTION_PATH_KF_KEY]: keys } };
}

/**
 * A motion-path track from keys timed in SECONDS (an animated outline copied
 * from another layer: a RotoScope mask, a keyed shape or motion path), placed on
 * the span [startTime, startTime + duration] of the layer that receives it. Keys
 * keep their absolute time — the text rides the outline where the footage has it
 * — and a source running past either end of the span is cut there with a key
 * interpolated at the boundary. `keys`: [{ time, points, easing }].
 */
export function motionPathTrackFromTimedKeys(keys, startTime, duration) {
  const list = (Array.isArray(keys) ? keys : [])
    .filter((k) => Number.isFinite(Number(k?.time)) && Array.isArray(k.points) && k.points.length >= 2)
    .sort((a, b) => a.time - b.time);
  if (!list.length || !(num(duration) > 0)) return [];
  const toPos = (t) => ((t - num(startTime)) / num(duration)) * 100;
  const out = [];
  const add = (position, points, easing) => {
    const pos = clamp(round4(position), 0, 100);
    if (out.some((k) => k.position === pos)) return;
    out.push({ position: pos, value: encodeMotionPathValue(points), easing: easing || PATH_PROGRESS_EASING });
  };
  const cut = (edge) => {
    for (let i = 0; i < list.length - 1; i += 1) {
      const pa = toPos(list[i].time); const pb = toPos(list[i + 1].time);
      if (pa < edge && pb > edge) {
        add(edge, interpolateMotionPaths(list[i].points, list[i + 1].points, (edge - pa) / (pb - pa)), list[i].easing);
        return;
      }
    }
  };
  cut(0);
  for (const k of list) {
    const pos = toPos(k.time);
    if (pos >= -1e-6 && pos <= 100 + 1e-6) add(pos, k.points, k.easing);
  }
  cut(100);
  if (!out.length) {
    // The whole source lies before or after this layer: hold its nearest key.
    const nearest = toPos(list[list.length - 1].time) < 0 ? list[list.length - 1] : list[0];
    add(toPos(nearest.time) < 0 ? 0 : 100, nearest.points, nearest.easing);
  }
  return out.sort((a, b) => a.position - b.position);
}

/** The ◆ stopwatch on the path: one key at the playhead holding `points`. */
export function seedMotionPathTrack(points, pct = 0, easing = PATH_PROGRESS_EASING) {
  return [{ position: clamp(round4(num(pct)), 0, 100), value: encodeMotionPathValue(points), easing }];
}

export function resolveObjectMotionPath(item, keyframeValues = null) {
  const path = liveObjectMotionPath(item, keyframeValues);
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
