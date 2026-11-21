// Column-major 4x4 matrices: the layout of three's Matrix4.elements and of Geo.instances. Rotations are degrees in three's
// default 'XYZ' Euler order, so an object here matches `object.rotation.set(...)` in the renderer.

export const DEG = Math.PI / 180;

export const vec3 = (v, fallback = 0) => {
  if (v == null) return [fallback, fallback, fallback];
  if (typeof v === 'number') return [v, v, v];
  return [v[0] ?? fallback, v[1] ?? fallback, v[2] ?? fallback];
};

export const identity = () => {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};

export function multiply(a, b, out = new Float64Array(16)) {
  const o = out === a || out === b ? new Float64Array(16) : out;
  for (let c = 0; c < 4; c += 1) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    o[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  if (o !== out) out.set(o);
  return out;
}

/** T * R * S. */
export function composeTRS(at, rot, scale, out = new Float64Array(16)) {
  const [tx, ty, tz] = vec3(at, 0);
  const [rx, ry, rz] = vec3(rot, 0);
  const [sx, sy, sz] = vec3(scale, 1);
  const a = Math.cos(rx * DEG), b = Math.sin(rx * DEG);
  const c = Math.cos(ry * DEG), d = Math.sin(ry * DEG);
  const e = Math.cos(rz * DEG), f = Math.sin(rz * DEG);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  out[0] = c * e * sx; out[1] = (af + be * d) * sx; out[2] = (bf - ae * d) * sx; out[3] = 0;
  out[4] = -c * f * sy; out[5] = (ae - bf * d) * sy; out[6] = (be + af * d) * sy; out[7] = 0;
  out[8] = d * sz; out[9] = -b * c * sz; out[10] = a * c * sz; out[11] = 0;
  out[12] = tx; out[13] = ty; out[14] = tz; out[15] = 1;
  return out;
}

/** Rotation about one of the world axes (0 x, 1 y, 2 z). */
export function rotationAbout(axis, degrees) {
  const rot = [0, 0, 0];
  rot[axis] = degrees;
  return composeTRS(null, rot, null);
}

/** Determinant of the upper 3x3: its sign says whether a matrix mirrors, which flips triangle winding. */
export const det3 = (m) =>
  m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

/** Cofactors of the upper 3x3 by rows, so n' = [k0 k1 k2; k3 k4 k5; k6 k7 k8] * n. Signed so mirroring maps normals correctly. */
export function normalMatrix(m) {
  const s = det3(m) < 0 ? -1 : 1;
  return [
    (m[5] * m[10] - m[9] * m[6]) * s, (m[9] * m[2] - m[1] * m[10]) * s, (m[1] * m[6] - m[5] * m[2]) * s,
    (m[8] * m[6] - m[4] * m[10]) * s, (m[0] * m[10] - m[8] * m[2]) * s, (m[4] * m[2] - m[0] * m[6]) * s,
    (m[4] * m[9] - m[8] * m[5]) * s, (m[8] * m[1] - m[0] * m[9]) * s, (m[0] * m[5] - m[4] * m[1]) * s,
  ];
}

/** Shortest-arc quaternion from +Y to a unit vector, written at q[o..o+3]. */
export function quatFromUp(nx, ny, nz, q, o = 0) {
  const w = 1 + ny;
  if (w < 1e-8) { q[o] = 1; q[o + 1] = 0; q[o + 2] = 0; q[o + 3] = 0; return q; } // straight down: any half turn
  const len = Math.hypot(nz, nx, w);
  q[o] = nz / len; q[o + 1] = 0; q[o + 2] = -nx / len; q[o + 3] = w / len;
  return q;
}

/** Hamilton product a * b of xyzw quaternions held at offsets of their arrays. */
export function quatMultiply(a, ao, b, bo, out, oo) {
  const ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3];
  const bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
  out[oo] = ax * bw + aw * bx + ay * bz - az * by;
  out[oo + 1] = ay * bw + aw * by + az * bx - ax * bz;
  out[oo + 2] = az * bw + aw * bz + ax * by - ay * bx;
  out[oo + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** Quaternion of a degrees rotation in the 'XYZ' order of composeTRS. */
export function quatFromEuler(rot) {
  const [x, y, z] = vec3(rot, 0);
  const c1 = Math.cos(x * DEG / 2), s1 = Math.sin(x * DEG / 2);
  const c2 = Math.cos(y * DEG / 2), s2 = Math.sin(y * DEG / 2);
  const c3 = Math.cos(z * DEG / 2), s3 = Math.sin(z * DEG / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

/** T * R(q) * S(uniform), with the quaternion read from q[o..o+3]. */
export function composeQuat(x, y, z, q, o, s, out) {
  const qx = q[o], qy = q[o + 1], qz = q[o + 2], qw = q[o + 3];
  const xx = qx + qx, yy = qy + qy, zz = qz + qz;
  const wx = qw * xx, wy = qw * yy, wz = qw * zz;
  const xa = qx * xx, xb = qx * yy, xc = qx * zz;
  const ya = qy * yy, yb = qy * zz, za = qz * zz;
  out[0] = (1 - (ya + za)) * s; out[1] = (xb + wz) * s; out[2] = (xc - wy) * s; out[3] = 0;
  out[4] = (xb - wz) * s; out[5] = (1 - (xa + za)) * s; out[6] = (yb + wx) * s; out[7] = 0;
  out[8] = (xc + wy) * s; out[9] = (yb - wx) * s; out[10] = (1 - (xa + ya)) * s; out[11] = 0;
  out[12] = x; out[13] = y; out[14] = z; out[15] = 1;
  return out;
}
