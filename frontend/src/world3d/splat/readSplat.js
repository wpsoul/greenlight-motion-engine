// A Gaussian splat (.ply, .splat, .spz): each point is a soft 3D blob with a position, colour (+ optional view-dependent spherical harmonics
// bands 1-3), opacity, three sizes and a rotation. Plain arrays, so it needs no GPU and runs in node.

export const SH_C0 = 0.28209479177387814; // the first spherical harmonic (DC)
export const SH_C1 = 0.4886025119029199;
export const SH_C2 = [1.0925484305920792, -1.0925484305920792, 0.31539156525252005, -1.0925484305920792, 0.5462742152960396];
export const SH_C3 = [-0.5900435899266435, 2.890611442640554, -0.4570457994644658, 0.3731763325901154, -0.4570457994644658, 1.445305721320277, -0.5900435899266435];
// Signs for the 15 rest SH basis functions under 180-deg X flip (y -> -y, z -> -z) when upright = true
export const SH_FLIP_SIGNS = [-1, -1, 1, -1, 1, 1, -1, 1, -1, 1, -1, -1, 1, -1, 1];
export const SH_COEFF_COUNTS = [0, 3, 8, 15];
export const SH_VEC4_STRIDE = [0, 2, 3, 6]; // uvec4s per splat in GPU f16x2 packed buffer (16, 24, 48 scalars)

const TYPES = { float: 4, float32: 4, double: 8, float64: 8, uchar: 1, uint8: 1, char: 1, int8: 1, short: 2, int16: 2, ushort: 2, uint16: 2, int: 4, int32: 4, uint: 4, uint32: 4 };
// how a DataView reads each .ply type (little-endian), the number as stored
const GETTERS = { float: 'getFloat32', float32: 'getFloat32', double: 'getFloat64', float64: 'getFloat64', uchar: 'getUint8', uint8: 'getUint8',
  char: 'getInt8', int8: 'getInt8', short: 'getInt16', int16: 'getInt16', ushort: 'getUint16', uint16: 'getUint16', int: 'getInt32', int32: 'getInt32',
  uint: 'getUint32', uint32: 'getUint32' };

/** A reader of one .ply property: (offset of the row) -> its value, by the type the header gives it. */
function propertyReader(view, property) {
  if (!property) return () => 0;
  const get = GETTERS[property.type], at = property.offset;
  return get === 'getUint8' || get === 'getInt8' ? (o) => view[get](o + at) : (o) => view[get](o + at, true);
}

const _f32Buf = new Float32Array(1);
const _u32Buf = new Uint32Array(_f32Buf.buffer);

/** Convert IEEE-754 binary32 float to binary16 bits (uint16). */
export function f32ToF16(val) {
  _f32Buf[0] = val;
  const x = _u32Buf[0];
  const sign = (x >>> 16) & 0x8000;
  let mant = x & 0x007fffff;
  const exp = (x >>> 23) & 0xff;
  if (exp === 255) return sign | (mant ? 0x7e00 : 0x7c00);
  if (exp === 0) return sign;
  const newExp = exp - 127 + 15;
  if (newExp >= 31) return sign | 0x7bff; // clamp finite overflow to max half 65504
  if (newExp <= 0) {
    if (newExp < -10) return sign;
    mant |= 0x00800000;
    const shift = 14 - newExp;
    return sign | (mant >> shift);
  }
  return sign | (newExp << 10) | (mant >> 13);
}

/** Convert IEEE-754 binary16 bits (uint16) to JS float: the same number, built as binary32 bits (no Math.pow per coefficient). */
export function f16ToF32(h) {
  const sign = (h & 0x8000) << 16;
  let exp = (h >> 10) & 0x1f;
  let mant = h & 0x03ff;
  if (exp === 31) { _u32Buf[0] = sign | 0x7f800000 | (mant << 13); return _f32Buf[0]; }
  if (exp === 0) {
    if (!mant) { _u32Buf[0] = sign; return _f32Buf[0]; }
    exp = 1;
    while (!(mant & 0x0400)) { mant <<= 1; exp -= 1; }
    mant &= 0x03ff;
  }
  _u32Buf[0] = sign | ((exp + 112) << 23) | (mant << 13);
  return _f32Buf[0];
}

export function packHalf2(a, b) {
  return (f32ToF16(a) | (f32ToF16(b) << 16)) >>> 0;
}

export function unpackShCoeff(sh, splatIndex, stride, coeffIndex, channel) {
  if (!sh || !stride) return 0;
  const j = coeffIndex * 3 + channel;
  const u32 = sh[splatIndex * stride * 4 + (j >> 1)];
  const h = (j & 1) ? (u32 >>> 16) : (u32 & 0xffff);
  return f16ToF32(h);
}

export function writeShCoeffs(sh, splatIndex, stride, scalars) {
  const base = splatIndex * stride * 4;
  for (let j = 0; j < scalars.length; j += 2) {
    const a = scalars[j];
    const b = j + 1 < scalars.length ? scalars[j + 1] : 0;
    sh[base + (j >> 1)] = packHalf2(a, b);
  }
}

/** Compute 6 covariance terms [xx, xy, xz, yy, yz, zz] from quaternion + scales. */
export function quatToCov(w, qx, qy, qz, sx, sy, sz, flip = 1, out = null, outOffset = 0) {
  const l = Math.hypot(w, qx, qy, qz) || 1;
  const qw = w / l, ax = qx / l, ay = qy / l, az = qz / l;
  const r00 = 1 - 2 * (ay * ay + az * az), r01 = 2 * (ax * ay - qw * az), r02 = 2 * (ax * az + qw * ay);
  const r10 = 2 * (ax * ay + qw * az), r11 = 1 - 2 * (ax * ax + az * az), r12 = 2 * (ay * az - qw * ax);
  const r20 = 2 * (ax * az - qw * ay), r21 = 2 * (ay * az + qw * ax), r22 = 1 - 2 * (ax * ax + ay * ay);
  const a2 = sx * sx, b2 = sy * sy, c2 = sz * sz;
  const dst = out || new Float32Array(6);
  dst[outOffset] = r00 * r00 * a2 + r01 * r01 * b2 + r02 * r02 * c2;
  dst[outOffset + 1] = flip * (r00 * r10 * a2 + r01 * r11 * b2 + r02 * r12 * c2);
  dst[outOffset + 2] = flip * (r00 * r20 * a2 + r01 * r21 * b2 + r02 * r22 * c2);
  dst[outOffset + 3] = r10 * r10 * a2 + r11 * r11 * b2 + r12 * r12 * c2;
  dst[outOffset + 4] = r10 * r20 * a2 + r11 * r21 * b2 + r12 * r22 * c2;
  dst[outOffset + 5] = r20 * r20 * a2 + r21 * r21 * b2 + r22 * r22 * c2;
  return dst;
}

const _jA = new Float64Array(9);
const _jV = new Float64Array(9);

/** One Jacobi rotation of the symmetric A (row-major 3x3) zeroing A[p][q], carried into V's columns. */
function jacobiRotate(A, V, p, q) {
  const apq = A[p * 3 + q];
  if (apq === 0) return;
  const theta = (A[q * 3 + q] - A[p * 3 + p]) / (2 * apq);
  const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
  const c = 1 / Math.sqrt(t * t + 1), s = t * c;
  for (let k = 0; k < 3; k += 1) {
    const akp = A[k * 3 + p], akq = A[k * 3 + q];
    A[k * 3 + p] = c * akp - s * akq; A[k * 3 + q] = s * akp + c * akq;
  }
  for (let k = 0; k < 3; k += 1) {
    const apk = A[p * 3 + k], aqk = A[q * 3 + k];
    A[p * 3 + k] = c * apk - s * aqk; A[q * 3 + k] = s * apk + c * aqk;
    const vkp = V[k * 3 + p], vkq = V[k * 3 + q];
    V[k * 3 + p] = c * vkp - s * vkq; V[k * 3 + q] = s * vkp + c * vkq;
  }
}

/**
 * One blob's sizes and turn from its covariance (`cov` at `o8`: xx, xy, xz, yy, yz, zz): the roots of its eigenvalues, largest first,
 * into `scale` at `o3`, and the turn whose columns are their axes, [qw, qx, qy, qz], into `rot` at `o4`. A covariance is the whole of a
 * blob's shape, so any decomposition of it draws the same blob; quatToCov of the result gives the covariance back. Cyclic Jacobi in doubles.
 */
export function covToScaleRot(cov, o8, scale, o3, rot, o4) {
  const A = _jA, V = _jV;
  A[0] = cov[o8]; A[1] = cov[o8 + 1]; A[2] = cov[o8 + 2];
  A[3] = cov[o8 + 1]; A[4] = cov[o8 + 3]; A[5] = cov[o8 + 4];
  A[6] = cov[o8 + 2]; A[7] = cov[o8 + 4]; A[8] = cov[o8 + 5];
  V[0] = 1; V[1] = 0; V[2] = 0; V[3] = 0; V[4] = 1; V[5] = 0; V[6] = 0; V[7] = 0; V[8] = 1;
  for (let sweep = 0; sweep < 24; sweep += 1) {
    const off = A[1] * A[1] + A[2] * A[2] + A[5] * A[5];
    if (!(off > 1e-30 * (A[0] * A[0] + A[4] * A[4] + A[8] * A[8]))) break;
    jacobiRotate(A, V, 0, 1); jacobiRotate(A, V, 0, 2); jacobiRotate(A, V, 1, 2);
  }
  // largest first, and a right-handed frame (a covariance does not know the sign of an axis)
  let i0 = 0, i1 = 1, i2 = 2, t;
  if (A[i1 * 4] > A[i0 * 4]) { t = i0; i0 = i1; i1 = t; }
  if (A[i2 * 4] > A[i1 * 4]) { t = i1; i1 = i2; i2 = t; }
  if (A[i1 * 4] > A[i0 * 4]) { t = i0; i0 = i1; i1 = t; }
  const m00 = V[i0], m10 = V[3 + i0], m20 = V[6 + i0], m01 = V[i1], m11 = V[3 + i1], m21 = V[6 + i1];
  let m02 = V[i2], m12 = V[3 + i2], m22 = V[6 + i2];
  if (m00 * (m11 * m22 - m12 * m21) - m01 * (m10 * m22 - m12 * m20) + m02 * (m10 * m21 - m11 * m20) < 0) { m02 = -m02; m12 = -m12; m22 = -m22; }
  scale[o3] = Math.sqrt(Math.max(0, A[i0 * 4])); scale[o3 + 1] = Math.sqrt(Math.max(0, A[i1 * 4])); scale[o3 + 2] = Math.sqrt(Math.max(0, A[i2 * 4]));
  let w, x, y, z;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const k = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / k; x = (m21 - m12) * k; y = (m02 - m20) * k; z = (m10 - m01) * k;
  } else if (m00 > m11 && m00 > m22) {
    const k = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / k; x = 0.25 * k; y = (m01 + m10) / k; z = (m02 + m20) / k;
  } else if (m11 > m22) {
    const k = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / k; x = (m01 + m10) / k; y = 0.25 * k; z = (m12 + m21) / k;
  } else {
    const k = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / k; x = (m02 + m20) / k; y = (m12 + m21) / k; z = 0.25 * k;
  }
  const l = Math.hypot(w, x, y, z) || 1;
  rot[o4] = w / l; rot[o4 + 1] = x / l; rot[o4 + 2] = y / l; rot[o4 + 3] = z / l;
}

const lazyShape = new WeakMap();

/**
 * A cloud's `scale` (3 a blob) and `rot` ([qw, qx, qy, qz] a blob), worked out from `cov` the first time something reads them (the tracer's
 * splat tree) and kept from then on. Draft draws from `cov` alone, so a cloud that is only drawn never holds them (44 % more memory a
 * splat). Enumerable, so a structured clone carries them as plain arrays.
 */
export function withScaleRot(splat) {
  const held = { scale: null, rot: null };
  lazyShape.set(splat, held);
  const derive = () => {
    const n = splat.count | 0;
    const s = new Float32Array(n * 3), r = new Float32Array(n * 4);
    for (let i = 0; i < n; i += 1) covToScaleRot(splat.cov, i * 8, s, i * 3, r, i * 4);
    held.scale ??= s; held.rot ??= r;
  };
  Object.defineProperties(splat, {
    scale: { enumerable: true, configurable: true, get: () => { if (!held.scale) derive(); return held.scale; }, set: (v) => { held.scale = v; } },
    rot: { enumerable: true, configurable: true, get: () => { if (!held.rot) derive(); return held.rot; }, set: (v) => { held.rot = v; } },
  });
  return splat;
}

/** Whether a cloud holds its `scale` and `rot` yet, without working them out (withScaleRot). */
export function holdsScaleRot(splat) {
  const held = lazyShape.get(splat);
  return held ? !!(held.scale && held.rot) : !!(splat?.scale && splat?.rot);
}

/** sRGB's encoding of a linear value (IEC 61966-2-1; below 0 the straight part goes on), and its slope there. */
export const srgbEncode = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const srgbSlope = (v) => (v <= 0.0031308 ? 12.92 : (1.055 / 2.4) * Math.pow(v, 1 / 2.4 - 1));

/**
 * A cloud whose colours are linear display light (KHR_gaussian_splatting `colorSpace: "lin_rec709_display"`) made display sRGB in place,
 * which is what every splat here is drawn as (render/splatPass.js): each base colour encoded exactly, and its view-dependent harmonics
 * scaled by the encoding's slope at that colour (the change with the view, to first order: no harmonics carry a curve exactly).
 */
export function linearColorsToSrgb(splat) {
  const { count, color } = splat;
  const deg = splat.sh ? splat.shDegree || 0 : 0;
  const stride = SH_VEC4_STRIDE[deg] || 0, nScalars = (SH_COEFF_COUNTS[deg] || 0) * 3;
  const tmp = nScalars ? new Float32Array(nScalars) : null;
  const k = [0, 0, 0];
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    for (let c = 0; c < 3; c += 1) {
      const lin = color[o + c];
      k[c] = srgbSlope(Math.max(0, lin));
      color[o + c] = srgbEncode(lin);
    }
    if (!tmp) continue;
    const base = i * stride * 4;
    for (let j = 0; j < nScalars; j += 1) {
      const w = splat.sh[base + (j >> 1)];
      tmp[j] = f16ToF32((j & 1) ? (w >>> 16) : (w & 0xffff)) * k[j % 3];
    }
    for (let j = 0; j < nScalars; j += 2) splat.sh[base + (j >> 1)] = packHalf2(tmp[j], j + 1 < nScalars ? tmp[j + 1] : 0);
  }
  return splat;
}

/** Evaluate view-dependent SH color [r, g, b] for splat `i` in local space given view direction `camToSplat` or `camPos`. */
export function evalSplatShCpu(data, i, camPos, out = [0, 0, 0]) {
  const co = i * 4;
  let r = data.color[co], g = data.color[co + 1], b = data.color[co + 2];
  const deg = data.shDegree || 0;
  if (!deg || !data.sh) {
    out[0] = Math.max(0, r); out[1] = Math.max(0, g); out[2] = Math.max(0, b);
    return out;
  }
  let dx = data.center[co] - camPos[0];
  let dy = data.center[co + 1] - camPos[1];
  let dz = data.center[co + 2] - camPos[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len; dy /= len; dz /= len;
  const stride = SH_VEC4_STRIDE[deg];
  const base = i * stride * 4;
  const sh = data.sh;
  const c = (idx) => {
    const u32 = sh[base + (idx >> 1)];
    return f16ToF32((idx & 1) ? (u32 >>> 16) : (u32 & 0xffff));
  };
  const addTerm = (k, w) => {
    const o = k * 3;
    r += c(o) * w; g += c(o + 1) * w; b += c(o + 2) * w;
  };
  addTerm(0, -SH_C1 * dy);
  addTerm(1, SH_C1 * dz);
  addTerm(2, -SH_C1 * dx);
  if (deg > 1) {
    const xx = dx * dx, yy = dy * dy, zz = dz * dz;
    const xy = dx * dy, yz = dy * dz, xz = dx * dz;
    addTerm(3, SH_C2[0] * xy);
    addTerm(4, SH_C2[1] * yz);
    addTerm(5, SH_C2[2] * (2 * zz - xx - yy));
    addTerm(6, SH_C2[3] * xz);
    addTerm(7, SH_C2[4] * (xx - yy));
    if (deg > 2) {
      addTerm(8, SH_C3[0] * dy * (3 * xx - yy));
      addTerm(9, SH_C3[1] * xy * dz);
      addTerm(10, SH_C3[2] * dy * (4 * zz - xx - yy));
      addTerm(11, SH_C3[3] * dz * (2 * zz - 3 * xx - 3 * yy));
      addTerm(12, SH_C3[4] * dx * (4 * zz - xx - yy));
      addTerm(13, SH_C3[5] * dz * (xx - yy));
      addTerm(14, SH_C3[6] * dx * (xx - 3 * yy));
      out[0] = Math.max(0, r); out[1] = Math.max(0, g); out[2] = Math.max(0, b);
      return out;
    }
  }
  out[0] = Math.max(0, r); out[1] = Math.max(0, g); out[2] = Math.max(0, b);
  return out;
}

export function parsePlyHeader(bytes) {
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 16384)));
  const end = text.indexOf('end_header');
  if (!text.startsWith('ply') || end < 0) throw new Error('This is not a .ply file.');
  const lines = text.slice(0, end).split(/\r?\n/);
  const format = lines.find((l) => l.startsWith('format'))?.split(/\s+/)[1];
  if (format !== 'binary_little_endian') throw new Error(`This .ply is ${format}. Splats come as binary_little_endian.`);
  const newline = text.indexOf('\n', end);
  // A compressed file holds a table of chunks before its points, so each element knows where it starts.
  const elements = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'element') elements.push({ name: parts[1], count: Number(parts[2]), stride: 0, properties: [] });
    else if (parts[0] === 'property' && elements.length) {
      const size = TYPES[parts[1]];
      if (!size) throw new Error(`Unknown .ply type ${parts[1]}.`);
      const element = elements[elements.length - 1];
      element.properties.push({ name: parts[2], type: parts[1], offset: element.stride });
      element.stride += size;
    }
  }
  let start = newline + 1;
  for (const element of elements) { element.start = start; start += element.count * element.stride; }
  const vertex = elements.find((e) => e.name === 'vertex');
  if (!vertex) throw new Error('This .ply has no vertex element.');
  return { count: vertex.count, stride: vertex.stride, properties: vertex.properties, dataStart: vertex.start, elements };
}

/** Is this .ply a splat cloud, or an ordinary mesh or point cloud? */
export function isSplatPly(header) {
  const names = new Set(header.properties.map((p) => p.name));
  return ['f_dc_0', 'opacity', 'scale_0', 'rot_0'].every((n) => names.has(n));
}

export const isCompressedPly = (header) => header.elements.some((e) => e.name === 'chunk') && header.properties.some((p) => p.name === 'packed_position');

export function detectPlyShDegree(properties) {
  const names = new Set(properties.map((p) => p.name));
  if (names.has('f_rest_44')) return 3;
  if (names.has('f_rest_23')) return 2;
  if (names.has('f_rest_8')) return 1;
  return 0;
}

/** Fills the arrays a renderer wants, one splat at a time, whichever file it came from. `scale` and `rot` are not kept: they come
 *  from `cov` when something asks (withScaleRot). */
export function splatSink(count, flip = -1, shDegree = 0) {
  const center = new Float32Array(count * 4);    // x, y, z, opacity
  const color = new Float32Array(count * 4);     // r, g, b, largest radius (unclamped DC when shDegree > 0)
  const cov = new Float32Array(count * 8);       // xx, xy, xz, yy, then yz, zz, unused, unused
  const stride = SH_VEC4_STRIDE[shDegree] || 0;
  const sh = stride ? new Uint32Array(count * stride * 4) : null;
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

  const add = (i, px, py, pz, opacity, r, g, b, sx, sy, sz, w, qx, qy, qz) => {
    const x = px, y = flip * py, z = flip * pz;
    center[i * 4] = x; center[i * 4 + 1] = y; center[i * 4 + 2] = z;
    center[i * 4 + 3] = opacity;
    if (x < box.min[0]) box.min[0] = x; if (y < box.min[1]) box.min[1] = y; if (z < box.min[2]) box.min[2] = z;
    if (x > box.max[0]) box.max[0] = x; if (y > box.max[1]) box.max[1] = y; if (z > box.max[2]) box.max[2] = z;
    color[i * 4] = r; color[i * 4 + 1] = g; color[i * 4 + 2] = b;
    color[i * 4 + 3] = Math.max(sx, sy, sz);
    const l = Math.hypot(w, qx, qy, qz) || 1;
    quatToCov(w / l, qx / l, qy / l, qz / l, sx, sy, sz, flip, cov, i * 8);
  };

  const addSh = stride ? (i, scalars) => {
    const nCoeffs = SH_COEFF_COUNTS[shDegree];
    const base = i * stride * 4;
    // scalars is [c0r, c0g, c0b, c1r, c1g, c1b, ...]; apply upright basis flip if flip < 0
    if (flip < 0) {
      for (let k = 0; k < nCoeffs; k += 1) {
        const s = SH_FLIP_SIGNS[k];
        if (s < 0) {
          const o = k * 3;
          scalars[o] = -scalars[o]; scalars[o + 1] = -scalars[o + 1]; scalars[o + 2] = -scalars[o + 2];
        }
      }
    }
    for (let j = 0; j < nCoeffs * 3; j += 2) {
      const a = scalars[j];
      const b = j + 1 < nCoeffs * 3 ? scalars[j + 1] : 0;
      sh[base + (j >> 1)] = packHalf2(a, b);
    }
  } : null;

  return { add, addSh, result: () => withScaleRot({ count, center, color, cov, shDegree, sh, box }) };
}

function readPlainPly(bytes, header, sink, shDegree) {
  const { count, stride, dataStart, properties } = header;
  if (dataStart + count * stride > bytes.length) throw new Error('This .ply is cut short.');
  // the training's own files are all float32: read from a float view of the rows; anything else (a double position, a uchar colour beside
  // the splat's floats) property by property, by the type the header gives it
  const f32 = stride % 4 === 0 && properties.every((p) => p.type === 'float' || p.type === 'float32');
  const at = Object.fromEntries(properties.map((p) => [p.name, f32 ? p.offset / 4 : p.offset]));
  const step = f32 ? stride / 4 : stride;
  let read;
  if (f32) {
    const body = new Float32Array(bytes.slice(dataStart, dataStart + count * stride).buffer);
    read = (row, off) => body[row + off];
  } else {
    const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart);
    const byOffset = new Map(properties.map((p) => [p.offset, propertyReader(view, { ...p, offset: 0 })]));
    read = (row, off) => byOffset.get(off)(row + off);
  }
  const [ax, ay, az, aOpacity] = ['x', 'y', 'z', 'opacity'].map((n) => at[n]);
  const [ar, ag, ab] = ['f_dc_0', 'f_dc_1', 'f_dc_2'].map((n) => at[n]);
  const [as0, as1, as2] = ['scale_0', 'scale_1', 'scale_2'].map((n) => at[n]);
  const [aq0, aq1, aq2, aq3] = ['rot_0', 'rot_1', 'rot_2', 'rot_3'].map((n) => at[n]);

  const nCoeffs = SH_COEFF_COUNTS[shDegree];
  const shOffsets = shDegree ? Array.from({ length: nCoeffs * 3 }, (_, idx) => at[`f_rest_${idx}`]) : null;
  const shTmp = shDegree ? new Float32Array(nCoeffs * 3) : null;

  for (let i = 0; i < count; i += 1) {
    const o = i * step;
    const dcR = 0.5 + SH_C0 * read(o, ar);
    const dcG = 0.5 + SH_C0 * read(o, ag);
    const dcB = 0.5 + SH_C0 * read(o, ab);
    sink.add(
      i, read(o, ax), read(o, ay), read(o, az), 1 / (1 + Math.exp(-read(o, aOpacity))),
      shDegree ? dcR : Math.max(0, dcR), shDegree ? dcG : Math.max(0, dcG), shDegree ? dcB : Math.max(0, dcB),
      Math.exp(read(o, as0)), Math.exp(read(o, as1)), Math.exp(read(o, as2)),
      read(o, aq0), read(o, aq1), read(o, aq2), read(o, aq3),
    );
    if (shDegree) {
      // Plain PLY f_rest is channel-major: R[0..N-1], G[0..N-1], B[0..N-1] -> reorder to interleaved RGB
      for (let k = 0; k < nCoeffs; k += 1) {
        shTmp[k * 3] = read(o, shOffsets[k]);
        shTmp[k * 3 + 1] = read(o, shOffsets[nCoeffs + k]);
        shTmp[k * 3 + 2] = read(o, shOffsets[nCoeffs * 2 + k]);
      }
      sink.addSh(i, shTmp);
    }
  }
}

// PlayCanvas's compressed .ply: 256 splats to a chunk, each packed into 16 bytes against its chunk's bounds.
const CHUNK_SIZE = 256;
const lerp = (a, b, t) => a + (b - a) * t;
const unit = (v, bits) => (v & ((1 << bits) - 1)) / ((1 << bits) - 1);
// Its harmonics are one byte each over [-4, 4]: splat-transform writes trunc((v / 8 + 0.5) * 256) and reads a byte back as the middle of
// its step, the ends as the ends (readers/decompress-ply.ts; the engine's gsplat-compressed-data.js reads v * 8 / 255 - 4, the same to 0.016).
export const compressedShValue = (b) => ((b === 0 ? 0 : b === 255 ? 1 : (b + 0.5) / 256) - 0.5) * 8;

function readCompressedPly(bytes, header, sink, shDegree) {
  const chunks = header.elements.find((e) => e.name === 'chunk');
  const shEl = header.elements.find((e) => e.name === 'sh');
  const { count, stride, dataStart, properties } = header;
  if (dataStart + count * stride > bytes.length) throw new Error('This .ply is cut short.');
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const field = Object.fromEntries(chunks.properties.map((p) => [p.name, p.offset]));
  const offset = Object.fromEntries(properties.map((p) => [p.name, p.offset]));
  const hasColorRange = 'min_r' in field;
  const bound = (c, name, fallback) => (name in field ? view.getFloat32(chunks.start + c * chunks.stride + field[name], true) : fallback);
  const nCoeffs = SH_COEFF_COUNTS[shDegree];
  const shTmp = shDegree ? new Float32Array(nCoeffs * 3) : null;
  let chunk = -1;
  let box = [];
  for (let i = 0; i < count; i += 1) {
    const c = Math.floor(i / CHUNK_SIZE);
    if (c >= chunks.count) throw new Error('This .ply is cut short.');
    if (c !== chunk) {
      chunk = c;
      box = ['min_x', 'max_x', 'min_y', 'max_y', 'min_z', 'max_z', 'min_scale_x', 'max_scale_x', 'min_scale_y', 'max_scale_y', 'min_scale_z', 'max_scale_z'].map((n) => bound(c, n, 0));
      if (hasColorRange) box.push(...['min_r', 'max_r', 'min_g', 'max_g', 'min_b', 'max_b'].map((n) => bound(c, n, 0)));
    }
    const o = dataStart + i * stride;
    const position = view.getUint32(o + offset.packed_position, true);
    const rotation = view.getUint32(o + offset.packed_rotation, true);
    const scale = view.getUint32(o + offset.packed_scale, true);
    const packed = view.getUint32(o + offset.packed_color, true);
    const t = (v) => [unit(v >>> 21, 11), unit(v >>> 11, 10), unit(v, 11)];
    const [px, py, pz] = t(position), [ts, tu, tv] = t(scale);
    const r = unit(packed >>> 24, 8), g = unit(packed >>> 16, 8), b = unit(packed >>> 8, 8), a = unit(packed, 8);
    const q = [unit(rotation >>> 20, 10), unit(rotation >>> 10, 10), unit(rotation, 10)].map((v) => (v - 0.5) * Math.SQRT2);
    const rest = Math.sqrt(Math.max(0, 1 - q[0] * q[0] - q[1] * q[1] - q[2] * q[2]));
    q.splice(rotation >>> 30, 0, rest);
    sink.add(
      i, lerp(box[0], box[1], px), lerp(box[2], box[3], py), lerp(box[4], box[5], pz), a,
      Math.max(0, hasColorRange ? lerp(box[12], box[13], r) : r), Math.max(0, hasColorRange ? lerp(box[14], box[15], g) : g), Math.max(0, hasColorRange ? lerp(box[16], box[17], b) : b),
      Math.exp(lerp(box[6], box[7], ts)), Math.exp(lerp(box[8], box[9], tu)), Math.exp(lerp(box[10], box[11], tv)),
      q[0], q[1], q[2], q[3],
    );
    if (shDegree && shEl && shEl.start + (i + 1) * shEl.stride <= bytes.length) {
      const base = shEl.start + i * shEl.stride;
      for (let k = 0; k < nCoeffs; k += 1) {
        shTmp[k * 3] = compressedShValue(bytes[base + k]);
        shTmp[k * 3 + 1] = compressedShValue(bytes[base + nCoeffs + k]);
        shTmp[k * 3 + 2] = compressedShValue(bytes[base + nCoeffs * 2 + k]);
      }
      sink.addSh(i, shTmp);
    }
  }
}

// The .splat of the first web viewers: 32 bytes each, with no header. Three floats of position, three of size, then bytes of colour, opacity and rotation.
const SPLAT_BYTES = 32;

function readDotSplat(bytes, sink, count) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  for (let i = 0; i < count; i += 1) {
    const o = i * SPLAT_BYTES;
    const rotation = (k) => (bytes[o + 28 + k] - 128) / 128;
    sink.add(
      i, view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true), bytes[o + 27] / 255,
      bytes[o + 24] / 255, bytes[o + 25] / 255, bytes[o + 26] / 255,
      view.getFloat32(o + 12, true), view.getFloat32(o + 16, true), view.getFloat32(o + 20, true),
      rotation(0), rotation(1), rotation(2), rotation(3),
    );
  }
}

// Niantic's .spz, once gunzipped: a 16-byte header, then every field of every splat in one run each.
const SPZ_MAGIC = 0x5053474e;
const SPZ_COLOR_SCALE = 0.15;

export function spzCount(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  if (bytes.length < 16 || view.getUint32(0, true) !== SPZ_MAGIC) throw new Error('This is not a .spz file.');
  return view.getUint32(8, true);
}

export function spzShDegree(bytes) {
  if (bytes.length < 16) return 0;
  const deg = bytes[12];
  return deg >= 1 && deg <= 3 ? deg : 0;
}

function readSpz(bytes, sink, shDegree) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const version = view.getUint32(4, true), count = spzCount(bytes), bits = bytes[13];
  if (version < 2 || version > 3) throw new Error(`This .spz is version ${version}, and this app reads 2 and 3.`);
  const rotationBytes = version >= 3 ? 4 : 3;
  const nCoeffs = SH_COEFF_COUNTS[shDegree];
  const positions = 16, alphas = positions + count * 9, colors = alphas + count, scales = colors + count * 3, rotations = scales + count * 3;
  const shStart = rotations + count * rotationBytes;
  const expectedMin = shStart + count * nCoeffs * 3;
  if (shStart > bytes.length || (shDegree > 0 && expectedMin > bytes.length)) throw new Error('This .spz is cut short.');
  const fixed = 1 / (1 << bits);
  const coordinate = (o) => (((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8) >> 8) * fixed;
  const shadeUnclamped = (b) => 0.5 + SH_C0 * ((b / 255 - 0.5) / SPZ_COLOR_SCALE);
  const size = (b) => Math.exp(b / 16 - 10);
  const shTmp = shDegree ? new Float32Array(nCoeffs * 3) : null;
  const q = [0, 0, 0, 0];
  for (let i = 0; i < count; i += 1) {
    const r = rotations + i * rotationBytes;
    if (version >= 3) {
      let packed = view.getUint32(r, true);
      const largest = packed >>> 30;
      let rest = 1;
      for (let k = 3; k >= 0; k -= 1) {
        if (k === largest) continue;
        const value = (Math.SQRT1_2 * (packed & 511)) / 511;
        q[k] = (packed >>> 9) & 1 ? -value : value;
        rest -= value * value;
        packed >>>= 10;
      }
      q[largest] = Math.sqrt(Math.max(0, rest));
    } else {
      q[0] = bytes[r] / 127.5 - 1; q[1] = bytes[r + 1] / 127.5 - 1; q[2] = bytes[r + 2] / 127.5 - 1;
      q[3] = Math.sqrt(Math.max(0, 1 - q[0] * q[0] - q[1] * q[1] - q[2] * q[2]));
    }
    const p = positions + i * 9, c = colors + i * 3, s = scales + i * 3;
    const sr = shadeUnclamped(bytes[c]), sg = shadeUnclamped(bytes[c + 1]), sb = shadeUnclamped(bytes[c + 2]);
    sink.add(
      i, coordinate(p), coordinate(p + 3), coordinate(p + 6), bytes[alphas + i] / 255,
      shDegree ? sr : Math.max(0, sr), shDegree ? sg : Math.max(0, sg), shDegree ? sb : Math.max(0, sb),
      size(bytes[s]), size(bytes[s + 1]), size(bytes[s + 2]),
      q[3], q[0], q[1], q[2],
    );
    if (shDegree) {
      const shOff = shStart + i * nCoeffs * 3;
      for (let j = 0; j < nCoeffs * 3; j += 1) shTmp[j] = (bytes[shOff + j] - 128) / 128;
      sink.addSh(i, shTmp);
    }
  }
}

const GZIP = (bytes) => bytes[0] === 0x1f && bytes[1] === 0x8b;

/** Unpacks what a .spz is wrapped in. Apart so `readSplat` can stay synchronous; `DecompressionStream` is in browsers and node alike. */
export async function gunzip(input) {
  const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
  if (!GZIP(bytes)) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads a splat file of any kind, told apart by what is inside it: a .ply and a .spz say what they are, and a .splat is what is left. */
export function readSplat(input, { upright = true } = {}) {
  const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
  if (GZIP(bytes)) throw new Error('This file is still gzipped: pass it through gunzip first.');
  const text = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
  const flip = upright ? -1 : 1;
  if (bytes.length >= 16 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === SPZ_MAGIC) {
    const shDegree = spzShDegree(bytes);
    const sink = splatSink(spzCount(bytes), flip, shDegree);
    readSpz(bytes, sink, shDegree);
    return sink.result();
  }
  if (text === 'ply') {
    const header = parsePlyHeader(bytes);
    const compressed = isCompressedPly(header);
    if (!compressed && !isSplatPly(header)) throw new Error('This .ply has no splat fields (f_dc, opacity, scale, rot).');
    const shEl = compressed ? header.elements.find((e) => e.name === 'sh') : null;
    const shDegree = compressed
      ? (shEl?.stride >= 45 ? 3 : shEl?.stride >= 24 ? 2 : shEl?.stride >= 9 ? 1 : 0)
      : detectPlyShDegree(header.properties);
    const sink = splatSink(header.count, flip, shDegree);
    (compressed ? readCompressedPly : readPlainPly)(bytes, header, sink, shDegree);
    return sink.result();
  }
  if (bytes.length === 0 || bytes.length % SPLAT_BYTES) throw new Error('This is not a splat file: a .ply, .splat or .spz.');
  const count = bytes.length / SPLAT_BYTES;
  const sink = splatSink(count, flip, 0);
  readDotSplat(bytes, sink, count);
  return sink.result();
}

/**
 * The box of a splat file's centres, as readSplat(input, { upright }).box gives it, read from the positions alone: no sizes, turns, colours
 * or harmonics and none of their arrays (the editor's stand-in box for a splat only the world draws, model3dLayer.js).
 */
export function readSplatBox(input, { upright = true } = {}) {
  const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
  if (GZIP(bytes)) throw new Error('This file is still gzipped: pass it through gunzip first.');
  const flip = upright ? -1 : 1;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const add = (x, py, pz) => {
    const y = flip * py, z = flip * pz;
    if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y; if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y; if (z > max[2]) max[2] = z;
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  if (bytes.length >= 16 && view.getUint32(0, true) === SPZ_MAGIC) {
    const version = view.getUint32(4, true), count = spzCount(bytes), fixed = 1 / (1 << bytes[13]);
    if (version < 2 || version > 3) throw new Error(`This .spz is version ${version}, and this app reads 2 and 3.`);
    if (16 + count * 9 > bytes.length) throw new Error('This .spz is cut short.');
    const coordinate = (o) => (((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8) >> 8) * fixed;
    for (let i = 0; i < count; i += 1) { const p = 16 + i * 9; add(coordinate(p), coordinate(p + 3), coordinate(p + 6)); }
    return { min, max };
  }
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2]) === 'ply') {
    const header = parsePlyHeader(bytes);
    const compressed = isCompressedPly(header);
    if (!compressed && !isSplatPly(header)) throw new Error('This .ply has no splat fields (f_dc, opacity, scale, rot).');
    const { count, stride, dataStart, properties } = header;
    if (dataStart + count * stride > bytes.length) throw new Error('This .ply is cut short.');
    const offset = Object.fromEntries(properties.map((p) => [p.name, p.offset]));
    if (compressed) {
      const chunks = header.elements.find((e) => e.name === 'chunk');
      const field = Object.fromEntries(chunks.properties.map((p) => [p.name, p.offset]));
      const bound = (c, name) => (name in field ? view.getFloat32(chunks.start + c * chunks.stride + field[name], true) : 0);
      let chunk = -1, b = null;
      for (let i = 0; i < count; i += 1) {
        const c = Math.floor(i / CHUNK_SIZE);
        if (c >= chunks.count) throw new Error('This .ply is cut short.');
        if (c !== chunk) { chunk = c; b = ['min_x', 'max_x', 'min_y', 'max_y', 'min_z', 'max_z'].map((n) => bound(c, n)); }
        const v = view.getUint32(dataStart + i * stride + offset.packed_position, true);
        add(lerp(b[0], b[1], unit(v >>> 21, 11)), lerp(b[2], b[3], unit(v >>> 11, 10)), lerp(b[4], b[5], unit(v, 11)));
      }
      return { min, max };
    }
    // three columns read where they lie, by their types (no copy of the rows)
    const rows = new DataView(bytes.buffer, bytes.byteOffset + dataStart);
    const [x, y, z] = ['x', 'y', 'z'].map((n) => propertyReader(rows, properties.find((p) => p.name === n)));
    for (let i = 0; i < count; i += 1) add(x(i * stride), y(i * stride), z(i * stride));
    return { min, max };
  }
  if (bytes.length === 0 || bytes.length % SPLAT_BYTES) throw new Error('This is not a splat file: a .ply, .splat or .spz.');
  for (let i = 0; i < bytes.length / SPLAT_BYTES; i += 1) {
    const o = i * SPLAT_BYTES;
    add(view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true));
  }
  return { min, max };
}

/** Back to front along `axis` (from the camera, in the splats' own space): a 16-bit counting sort, fast enough to run each view. */
export function sortSplats(center, count, eye, axis, out = new Uint32Array(count), keys = new Uint16Array(count), bins = new Uint32Array(65537), depth = new Float32Array(count)) {
  let low = Infinity, high = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    const d = (center[o] - eye[0]) * axis[0] + (center[o + 1] - eye[1]) * axis[1] + (center[o + 2] - eye[2]) * axis[2];
    depth[i] = d;
    if (d < low) low = d;
    if (d > high) high = d;
  }
  const scale = high > low ? 65535 / (high - low) : 0;
  bins.fill(0);
  // Farthest first, so the bin index runs the other way.
  for (let i = 0; i < count; i += 1) { const k = 65535 - Math.floor((depth[i] - low) * scale); keys[i] = k; bins[k + 1] += 1; }
  for (let b = 1; b < 65537; b += 1) bins[b] += bins[b - 1];
  for (let i = 0; i < count; i += 1) { out[bins[keys[i]]] = i; bins[keys[i]] += 1; }
  return out;
}
