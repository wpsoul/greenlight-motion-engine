// (rigging) Dual-quaternion skinning (Kavan, Collins, Žára, O'Sullivan, "Skinning with Dual Quaternions", 2007), written from the paper.
// Linear blend skinning averages the bones' matrices, and an average of two rotations is no rotation: a joint bent 90 degrees loses
// thickness at the bend (the points shared half and half land at cos 45 = 0.71 of their distance), and a wrist twisted half a turn
// collapses to a line (the candy wrapper). Blending the bones as unit dual quaternions keeps every blend a rigid motion: no loss, no
// collapse.
//
// (leftovers-rig) Joint scale, as Kavan, Collins, Žára, O'Sullivan, "Geometric Skinning with Approximate Dual Quaternion Blending" (ACM TOG
// 2008, its section on scale and shear) treats it, from the paper: a dual quaternion is a rigid motion only, so each bone's skin motion K is
// split into a rigid part and a scale/shear part about the joint, K = Rig · Sc, with Sc = R_rest Z R_restᵀ about the joint's rest point
// (the polar decomposition of K's 3×3, A = R Z, Z symmetric) and Rig = K · Sc⁻¹. Skinning is then two phases: the scale/shear parts blended
// linearly (Σ w Sc, as linear blending does: where every bone keeps its scale it IS linear blending) and the rigid parts by dual
// quaternions. A bone scaled 1.5 grows its part of the mesh 1.5 times about its joint; normals go through the blended scale's inverse
// transpose (its cofactor). A skeleton without scale skins exactly as before (every Sc is the identity, bit for bit).
//
// A table holds each bone's skin motion in the mesh's own space, K = bindMatrixInverse · bone.matrixWorld · boneInverse · bindMatrix, as
// DQ_STRIDE floats: the rigid part's rotation quaternion (x, y, z, w), its dual part (x, y, z, w), then the scale part's three rows
// (a 3×4 affine: x row, y row, z row, each with its translation last). The world's raster reads it per vertex (three's skinning node,
// patched at build: html/world3d-lab/threeNodePatches.mjs SKIN_DQ), the editor's WebGL pass through its own shader chunks (skinDQWebGL.js),
// the tracer's packing and BVH through applyBoneTransform below.

import * as THREE from 'three';

const _m = new THREE.Matrix4(), _s = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _x = new THREE.Vector3(),
  _y = new THREE.Vector3(), _z = new THREE.Vector3();

/** One rigid motion (its matrix; any scale normalised away) as a dual quaternion into out[o .. o + 8). */
export function matrixToDualQuat(m, out, o = 0) {
  const e = m.elements;
  // the rotation from the matrix's columns, each made unit length (a scaled bone keeps its turn)
  _x.set(e[0], e[1], e[2]).normalize(); _y.set(e[4], e[5], e[6]).normalize(); _z.set(e[8], e[9], e[10]).normalize();
  _s.makeBasis(_x, _y, _z);
  _q.setFromRotationMatrix(_s).normalize();
  const tx = e[12], ty = e[13], tz = e[14];
  out[o] = _q.x; out[o + 1] = _q.y; out[o + 2] = _q.z; out[o + 3] = _q.w;
  // dual = 0.5 · (t, 0) · q
  out[o + 4] = 0.5 * (tx * _q.w + ty * _q.z - tz * _q.y);
  out[o + 5] = 0.5 * (-tx * _q.z + ty * _q.w + tz * _q.x);
  out[o + 6] = 0.5 * (tx * _q.y - ty * _q.x + tz * _q.w);
  out[o + 7] = -0.5 * (tx * _q.x + ty * _q.y + tz * _q.z);
  return out;
}

/** Floats a bone takes in the table: the rigid part's dual quaternion (8), the scale part's three rows (12). */
export const DQ_STRIDE = 20;
const IDENTITY_ROWS = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

const _next = new Float64Array(9);
const det3 = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
/** The polar decomposition A = R Z of a 3×3 (row-major), by Newton's iteration R ← (R + R⁻ᵀ) / 2 (Higham 1986); R a proper rotation (a
 *  mirrored A gives R and Z both negated). Into r and z (row-major). */
export function polar3(a, r, z) {
  for (let k = 0; k < 9; k += 1) r[k] = a[k];
  const next = _next;
  for (let it = 0; it < 40; it += 1) {
    const d = det3(r);
    if (!(Math.abs(d) > 1e-300)) break;
    // R⁻ᵀ = cofactor(R) / det
    next[0] = (r[4] * r[8] - r[5] * r[7]) / d; next[1] = (r[5] * r[6] - r[3] * r[8]) / d; next[2] = (r[3] * r[7] - r[4] * r[6]) / d;
    next[3] = (r[2] * r[7] - r[1] * r[8]) / d; next[4] = (r[0] * r[8] - r[2] * r[6]) / d; next[5] = (r[1] * r[6] - r[0] * r[7]) / d;
    next[6] = (r[1] * r[5] - r[2] * r[4]) / d; next[7] = (r[2] * r[3] - r[0] * r[5]) / d; next[8] = (r[0] * r[4] - r[1] * r[3]) / d;
    let moved = 0;
    for (let k = 0; k < 9; k += 1) { const v = 0.5 * (r[k] + next[k]); moved = Math.max(moved, Math.abs(v - r[k])); r[k] = v; }
    if (moved < 1e-15) break;
  }
  if (det3(r) < 0) for (let k = 0; k < 9; k += 1) r[k] = -r[k];
  // Z = Rᵀ A, made exactly symmetric
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) z[i * 3 + j] = r[i] * a[j] + r[3 + i] * a[3 + j] + r[6 + i] * a[6 + j];
  for (const [i, j] of [[1, 3], [2, 6], [5, 7]]) { const v = 0.5 * (z[i] + z[j]); z[i] = v; z[j] = v; }
  return r;
}

const _a = new Float64Array(9), _r = new Float64Array(9), _zs = new Float64Array(9), _rig = new THREE.Matrix4();
/**
 * One skin motion K (THREE.Matrix4, mesh space) into a table entry at out[o .. o + DQ_STRIDE): the rigid part as a dual quaternion, the
 * scale/shear part as three rows about `center` (the joint's rest point, mesh space). Returns whether K carries any scale or shear.
 */
export function splitSkinMotion(K, center, out, o = 0) {
  const e = K.elements;
  _a[0] = e[0]; _a[1] = e[4]; _a[2] = e[8]; _a[3] = e[1]; _a[4] = e[5]; _a[5] = e[9]; _a[6] = e[2]; _a[7] = e[6]; _a[8] = e[10];
  // AᵀA = I: no scale, no shear: the rigid motion as it stands (bit for bit what it was before scale was carried)
  let off = 0;
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) {
    const v = _a[i] * _a[j] + _a[3 + i] * _a[3 + j] + _a[6 + i] * _a[6 + j];
    off = Math.max(off, Math.abs(v - (i === j ? 1 : 0)));
  }
  if (!(off > 1e-9)) {
    matrixToDualQuat(K, out, o);
    for (let k = 0; k < 12; k += 1) out[o + 8 + k] = IDENTITY_ROWS[k];
    return false;
  }
  polar3(_a, _r, _zs);
  // Sc = [Z | (I − Z) c]; Rig = [R | t − R (I − Z) c]
  const cx = center[0], cy = center[1], cz = center[2];
  const sx = cx - (_zs[0] * cx + _zs[1] * cy + _zs[2] * cz), sy = cy - (_zs[3] * cx + _zs[4] * cy + _zs[5] * cz), sz = cz - (_zs[6] * cx + _zs[7] * cy + _zs[8] * cz);
  const tx = e[12] - (_r[0] * sx + _r[1] * sy + _r[2] * sz), ty = e[13] - (_r[3] * sx + _r[4] * sy + _r[5] * sz), tz = e[14] - (_r[6] * sx + _r[7] * sy + _r[8] * sz);
  _rig.set(_r[0], _r[1], _r[2], tx, _r[3], _r[4], _r[5], ty, _r[6], _r[7], _r[8], tz, 0, 0, 0, 1);
  matrixToDualQuat(_rig, out, o);
  const rows = [_zs[0], _zs[1], _zs[2], sx, _zs[3], _zs[4], _zs[5], sy, _zs[6], _zs[7], _zs[8], sz];
  for (let k = 0; k < 12; k += 1) out[o + 8 + k] = rows[k];
  return true;
}

/** Blends four bones of a table (DQ_STRIDE a bone) by weights (each turned to the first's hemisphere), normalised, into b (8 floats). */
export function blendDualQuats(table, idx, wts, b, stride = DQ_STRIDE) {
  b.fill(0);
  const o0 = idx[0] * stride;
  for (let k = 0; k < 4; k += 1) {
    const w = wts[k];
    if (!w) continue;
    const o = idx[k] * stride;
    const dot = table[o0] * table[o] + table[o0 + 1] * table[o + 1] + table[o0 + 2] * table[o + 2] + table[o0 + 3] * table[o + 3];
    const s = dot < 0 ? -w : w;
    for (let c = 0; c < 8; c += 1) b[c] += table[o + c] * s;
  }
  const len = Math.hypot(b[0], b[1], b[2], b[3]) || 1;
  for (let c = 0; c < 8; c += 1) b[c] /= len;
  return b;
}

/** The four bones' scale parts blended linearly into m (12 floats: three rows). */
export function blendScales(table, idx, wts, m) {
  m.fill(0);
  for (let k = 0; k < 4; k += 1) {
    const w = wts[k];
    if (!w) continue;
    const o = idx[k] * DQ_STRIDE + 8;
    for (let c = 0; c < 12; c += 1) m[c] += table[o + c] * w;
  }
  return m;
}

/** A point (w = 1) or a normal (w = 0: by the inverse transpose, as its cofactor; the length is the caller's) through the scale rows m. */
export function applyScaleRows(m, p, point = true) {
  const x = p.x, y = p.y, z = p.z;
  if (point) {
    p.x = m[0] * x + m[1] * y + m[2] * z + m[3];
    p.y = m[4] * x + m[5] * y + m[6] * z + m[7];
    p.z = m[8] * x + m[9] * y + m[10] * z + m[11];
    return p;
  }
  // columns c0 = (m0, m4, m8), c1 = (m1, m5, m9), c2 = (m2, m6, m10); M⁻ᵀ ∝ [c1×c2 | c2×c0 | c0×c1]
  const c0x = m[0], c0y = m[4], c0z = m[8], c1x = m[1], c1y = m[5], c1z = m[9], c2x = m[2], c2y = m[6], c2z = m[10];
  p.x = (c1y * c2z - c1z * c2y) * x + (c2y * c0z - c2z * c0y) * y + (c0y * c1z - c0z * c1y) * z;
  p.y = (c1z * c2x - c1x * c2z) * x + (c2z * c0x - c2x * c0z) * y + (c0z * c1x - c0x * c1z) * z;
  p.z = (c1x * c2y - c1y * c2x) * x + (c2x * c0y - c2y * c0x) * y + (c0x * c1y - c0y * c1x) * z;
  return p;
}

/** A point (w = 1) or a direction (w = 0) moved by a unit dual quaternion b, in place on {x, y, z}. */
export function applyDualQuat(b, p, point = true) {
  const rx = b[0], ry = b[1], rz = b[2], rw = b[3];
  // p + 2 r × (r × p + w p)
  const cx = ry * p.z - rz * p.y + rw * p.x, cy = rz * p.x - rx * p.z + rw * p.y, cz = rx * p.y - ry * p.x + rw * p.z;
  let x = p.x + 2 * (ry * cz - rz * cy), y = p.y + 2 * (rz * cx - rx * cz), z = p.z + 2 * (rx * cy - ry * cx);
  if (point) {
    // + 2 (w d − d.w r + r × d)
    const dx = b[4], dy = b[5], dz = b[6], dw = b[7];
    x += 2 * (rw * dx - dw * rx + (ry * dz - rz * dy));
    y += 2 * (rw * dy - dw * ry + (rz * dx - rx * dz));
    z += 2 * (rw * dz - dw * rz + (rx * dy - ry * dx));
  }
  p.x = x; p.y = y; p.z = z;
  return p;
}

const _c = new THREE.Vector3(), _bi = new THREE.Matrix4();
/** The table of a skinned mesh's bones as they stand now (each bone's skin motion in the mesh's own space). Into `out` when given;
 *  `scaled` (one byte a bone) notes which bones carry scale. */
export function skinDualQuatTable(sm, out = null, scaled = null) {
  const bones = sm.skeleton.bones, inv = sm.skeleton.boneInverses;
  const table = out || new Float64Array(bones.length * DQ_STRIDE);
  for (let i = 0; i < bones.length; i += 1) {
    _m.multiplyMatrices(bones[i].matrixWorld, inv[i]);
    _m.premultiply(sm.bindMatrixInverse).multiply(sm.bindMatrix);
    // the joint's rest point in the mesh's space: where the bone stood when bound
    _c.setFromMatrixPosition(_bi.copy(inv[i]).invert()).applyMatrix4(sm.bindMatrixInverse);
    const s = splitSkinMotion(_m, [_c.x, _c.y, _c.z], table, i * DQ_STRIDE);
    if (scaled) scaled[i] = s ? 1 : 0;
  }
  return table;
}

const _idx = [0, 0, 0, 0], _w = [0, 0, 0, 0], _b = new Float64Array(8), _sm = new Float64Array(12);

/**
 * Makes `sm` skin by dual quaternions: its applyBoneTransform (what three's CPU paths and the tracer's packing and BVH call) blends the
 * table, worked out again only when a bone or the mesh's place moved; `userData.skinDualQuaternion` holds the table the raster reads,
 * `userData.skinDQUpdate` refreshes it (three's skinning calls it once a frame).
 */
export function useDualQuaternions(sm) {
  const table = new Float64Array(sm.skeleton.bones.length * DQ_STRIDE);
  const scaled = new Uint8Array(sm.skeleton.bones.length);
  const gpu = new Float32Array(table.length);
  const seen = new Float64Array(sm.skeleton.bones.length * 16 + 16).fill(NaN);
  const fresh = () => {
    // the bones' world matrices and the mesh's own inverse, as last worked out: the same, the table stands
    const bones = sm.skeleton.bones;
    let same = true;
    for (let i = 0; i < bones.length && same; i += 1) { const e = bones[i].matrixWorld.elements; for (let k = 0; k < 16; k += 1) if (seen[i * 16 + k] !== e[k]) { same = false; break; } }
    const bi = sm.bindMatrixInverse.elements, o = bones.length * 16;
    for (let k = 0; k < 16 && same; k += 1) if (seen[o + k] !== bi[k]) same = false;
    if (same) return table;
    for (let i = 0; i < bones.length; i += 1) seen.set(bones[i].matrixWorld.elements, i * 16);
    seen.set(bi, o);
    return skinDualQuatTable(sm, table, scaled);
  };
  sm.userData.skinDualQuaternion = gpu;
  sm.userData.skinDQUpdate = () => { gpu.set(fresh()); };
  sm.applyBoneTransform = function applyBoneTransform(index, vector) {
    const t = fresh();
    const si = this.geometry.attributes.skinIndex, sw = this.geometry.attributes.skinWeight;
    let anyScale = false;
    for (let k = 0; k < 4; k += 1) { _idx[k] = si.getComponent(index, k); _w[k] = sw.getComponent(index, k); if (_w[k] && scaled[_idx[k]]) anyScale = true; }
    // a Vector4 with w = 0 is a direction (the tracer's normals)
    const point = vector.w === undefined || vector.w !== 0;
    // first the bones' scale, blended linearly; then their rigid motions, by dual quaternions
    if (anyScale) applyScaleRows(blendScales(t, _idx, _w, _sm), vector, point);
    blendDualQuats(t, _idx, _w, _b);
    applyDualQuat(_b, vector, point);
    return vector;
  };
  sm.userData.skinning = 'dualQuaternion';
  return sm;
}

/**
 * Dual-quaternion skinning of rest points by per-joint skin matrices (THREE.Matrix4, mesh space): the CPU twin of the above, for checks.
 * `centers` (each joint's rest point, [x, y, z]) is where a scaled joint scales about; without it a skin matrix's scale is not carried.
 */
export function skinPointsDQ(position, skinIndex, skinWeight, skin, centers = null) {
  const table = new Float64Array(skin.length * DQ_STRIDE);
  const scaled = skin.map((m, i) => {
    if (centers) return splitSkinMotion(m, centers[i], table, i * DQ_STRIDE);
    matrixToDualQuat(m, table, i * DQ_STRIDE);
    for (let k = 0; k < 12; k += 1) table[i * DQ_STRIDE + 8 + k] = IDENTITY_ROWS[k];
    return false;
  });
  const out = new Float32Array(position.length);
  const b = new Float64Array(8), sm = new Float64Array(12), idx = [0, 0, 0, 0], w = [0, 0, 0, 0], p = { x: 0, y: 0, z: 0 };
  for (let v = 0; v < position.length / 3; v += 1) {
    let anyScale = false;
    for (let k = 0; k < 4; k += 1) { idx[k] = skinIndex[v * 4 + k]; w[k] = skinWeight[v * 4 + k]; if (w[k] && scaled[idx[k]]) anyScale = true; }
    p.x = position[v * 3]; p.y = position[v * 3 + 1]; p.z = position[v * 3 + 2];
    if (anyScale) applyScaleRows(blendScales(table, idx, w, sm), p, true);
    blendDualQuats(table, idx, w, b);
    applyDualQuat(b, p, true);
    out[v * 3] = p.x; out[v * 3 + 1] = p.y; out[v * 3 + 2] = p.z;
  }
  return out;
}
