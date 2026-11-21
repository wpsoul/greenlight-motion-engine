// (animtools) A Scene object's follow path, and the little rotation math the world's keys need without three: pure, so the world, the
// editor's own pose of a Scene object (modelPose.js sceneObjectMatrix) and `node --test` place an object on its path alike.
//
// `path: { points: [[x, y, z], ...], tension [0.5], closed [false], along [0], orient [false], up [[0, 1, 0]], bank [0] }`: a curve
// through the points (tension 0.5 a Catmull-Rom spline, as the `tube` op's; 0 the polyline itself), in the space the object's `at` is in,
// measured from its `at`. `along` 0 is the first point and 1 the last, by the share of the curve's LENGTH, so a linear `along` is an even
// speed and the eases of its keys (or its drive) are the speed's own. `orient` turns the object so its +Z runs along the curve (its +Y
// toward `up`), `bank` rolls it about that direction, degrees; the object's own `rot` then turns it within that frame.

const DEG = Math.PI / 180;
const COMPILED = new WeakMap();
const PER_SEGMENT = 48;
const MAX_SAMPLES = 16384;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null; };
const isVec3 = (p) => Array.isArray(p) && p.length >= 3 && Number.isFinite(+p[0]) && Number.isFinite(+p[1]) && Number.isFinite(+p[2]);

/** The curve's control points around segment i (from point i to i + 1), as three's CatmullRomCurve3 takes them: a closed curve wraps,
 *  an open one mirrors its end points (p0 = 2 p1 − p2), so the spline starts and ends on the first and last point heading their way. */
function controls(P, i, closed) {
  const n = P.length;
  const at = (k) => (closed ? P[((k % n) + n) % n] : P[Math.max(0, Math.min(n - 1, k))]);
  const p1 = at(i), p2 = at(i + 1);
  const p0 = closed || i > 0 ? at(i - 1) : [2 * p1[0] - p2[0], 2 * p1[1] - p2[1], 2 * p1[2] - p2[2]];
  const p3 = closed || i + 2 < n ? at(i + 2) : [2 * p2[0] - p1[0], 2 * p2[1] - p1[1], 2 * p2[2] - p1[2]];
  return [p0, p1, p2, p3];
}

/** A Hermite segment from p1 to p2 with tangents tension·(p2 − p0) and tension·(p3 − p1) (three's CubicPoly.initCatmullRom): its point
 *  and its derivative at u in 0..1. */
function hermite(c, tension, u) {
  const [p0, p1, p2, p3] = c;
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
  const point = [0, 0, 0], deriv = [0, 0, 0];
  for (let k = 0; k < 3; k += 1) {
    const m1 = tension * (p2[k] - p0[k]), m2 = tension * (p3[k] - p1[k]);
    point[k] = h00 * p1[k] + h10 * m1 + h01 * p2[k] + h11 * m2;
    deriv[k] = d00 * p1[k] + d10 * m1 + d01 * p2[k] + d11 * m2;
  }
  return { point, deriv };
}

/** The path made ready to walk: its points, segments and a table of its length (one entry every 1/PER_SEGMENT of a segment). Null for
 *  fewer than two points. Cached per path object. */
export function compilePath(path) {
  if (!path || typeof path !== 'object') return null;
  const hit = COMPILED.get(path);
  if (hit !== undefined && hit.src === path.points) return hit.compiled;
  const P = (Array.isArray(path.points) ? path.points : []).filter(isVec3).map((p) => [+p[0], +p[1], +p[2]]);
  let compiled = null;
  if (P.length >= 2) {
    const closed = path.closed === true;
    const tension = Number.isFinite(+path.tension) ? Math.max(0, Math.min(1, +path.tension)) : 0.5;
    const segs = closed ? P.length : P.length - 1;
    const per = Math.max(4, Math.min(PER_SEGMENT, Math.floor(MAX_SAMPLES / segs)));
    const ctrl = Array.from({ length: segs }, (_, i) => controls(P, i, closed));
    // cumulative length at each table entry: entry j is segment floor(j / per), u = (j % per) / per
    const n = segs * per + 1;
    const len = new Float64Array(n);
    let prev = ctrl[0][1], acc = 0;
    for (let j = 1; j < n; j += 1) {
      const s = Math.min(segs - 1, Math.floor((j - 1) / per));
      const u = (j - s * per) / per;
      const p = tension === 0 ? lerp3(ctrl[s][1], ctrl[s][2], u) : hermite(ctrl[s], tension, u).point;
      acc += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
      len[j] = acc;
      prev = p;
    }
    compiled = { ctrl, segs, per, len, total: acc, tension, closed };
  }
  COMPILED.set(path, { src: path.points, compiled });
  return compiled;
}

const lerp3 = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

/** Where a path is at `along` (the share of its length; outside 0..1 it holds the end, a closed path wraps), and the unit direction it
 *  runs there. { point, tangent } or null. */
export function pathAt(path, along) {
  const c = compilePath(path);
  if (!c) return null;
  let a = Number.isFinite(+along) ? +along : 0;
  if (c.closed) a -= Math.floor(a);
  else a = Math.max(0, Math.min(1, a));
  const target = a * c.total;
  const { len, per, segs } = c;
  // the table entry at or before `target`, then the exact curve between the two entries (u interpolated by length)
  let lo = 0, hi = len.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (len[mid] <= target) lo = mid; else hi = mid; }
  const span = len[hi] - len[lo];
  const f = span > 1e-15 ? Math.max(0, Math.min(1, (target - len[lo]) / span)) : 0;
  const j = lo + f;
  const s = Math.min(segs - 1, Math.floor(j / per));
  const u = Math.max(0, Math.min(1, (j - s * per) / per));
  const ctrl = c.ctrl[s];
  if (c.tension === 0) {
    const tangent = unit(sub(ctrl[2], ctrl[1])) || [0, 0, 1];
    return { point: lerp3(ctrl[1], ctrl[2], u), tangent };
  }
  const h = hermite(ctrl, c.tension, u);
  return { point: h.point, tangent: unit(h.deriv) || unit(sub(ctrl[2], ctrl[1])) || [0, 0, 1] };
}

/** three's Quaternion.setFromEuler for an 'XYZ' Euler in DEGREES (the order a Scene object's `rot` turns in): [x, y, z, w]. */
export function quatFromEulerDeg(rot) {
  const x = (+rot?.[0] || 0) * DEG, y = (+rot?.[1] || 0) * DEG, z = (+rot?.[2] || 0) * DEG;
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}

/** a · b, quaternions [x, y, z, w] (b turns first). */
export function quatMul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [ax * bw + aw * bx + ay * bz - az * by, ay * bw + aw * by + az * bx - ax * bz, az * bw + aw * bz + ax * by - ay * bx, aw * bw - ax * bx - ay * by - az * bz];
}

/** The turn whose +Z is `forward` and whose +Y leans toward `up` (three's Object3D.lookAt for an object), rolled `bank` degrees about
 *  `forward`: [x, y, z, w]. */
export function quatAlong(forward, up = [0, 1, 0], bank = 0) {
  const z = unit(forward) || [0, 0, 1];
  let x = unit(cross(isVec3(up) ? up : [0, 1, 0], z));
  if (!x) x = unit(cross(Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], z));
  const y = cross(z, x);
  // rotation matrix columns x, y, z → quaternion (three's setFromRotationMatrix)
  const m11 = x[0], m12 = y[0], m13 = z[0], m21 = x[1], m22 = y[1], m23 = z[1], m31 = x[2], m32 = y[2], m33 = z[2];
  const trace = m11 + m22 + m33;
  let q;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    q = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    q = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    q = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
  }
  const b = (+bank || 0) * DEG;
  return b ? quatMul(q, [0, 0, Math.sin(b / 2), Math.cos(b / 2)]) : q;
}
