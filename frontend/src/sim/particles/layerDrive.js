/*
 * LAYER VELOCITY — a force emitter whose push IS another layer's animation.
 *
 * A layer that moves through the box drags the particles (and the fluid) with
 * it, the way a hand drags smoke. The velocity is not measured from pixels: it
 * is the exact derivative of the layer's own transform, sampled from the same
 * PRS the renderer places it with (keyframes, motion paths, parenting, speed
 * ramps and all). Same idea as the Motion Blur layer effect, which smears a
 * layer along the transform it had one frame earlier — except that one only
 * needs the SCREEN-space map, and this one is fully 3D: a layer travelling in
 * z, or tumbling on rotateX/rotateY, pushes in z too.
 *
 * THE TABLE. The solver is pure — no DOM, no three, and it runs in a worker —
 * so it cannot resolve a timeline item's transform itself. The caller samples
 * it per simulation step on the main thread (layerVelocity.js in the editor)
 * and hands the result in as `opts.layerDrive`, exactly like the collision SDF
 * arrives as `opts.collider`. A flat bag of typed arrays, safe to post whole.
 *
 * THE MATHS. At step s the source layer's motion is one affine velocity field
 * in the box's own space:
 *
 *     v(p) = A · (p − c) + b          px/s
 *
 * where `b` is the velocity of the layer's centre `c` and `A` is the velocity
 * GRADIENT — rotation rate and scale rate together, so a spinning layer whips
 * what is near its rim and a growing one pushes outward. A is (M_now·M_prev⁻¹ −
 * I)/dt for the layer's 3×4 transform M, which is the same construction motion
 * blur does with its two projected boxes; here it stays in world space and
 * keeps its third row.
 *
 * The reach is the same gaussian every other force emitter falls off with,
 * exp(−(|p−c|/r)²), so a Layer Velocity source reads like the Blower it sits
 * next to in the panel — one radius, one strength.
 */

/** Floats per source per step. Four vec4s, so the GPU can read it as one block. */
export const LAYER_DRIVE_STRIDE = 16;

/** Sources one system may drive with (the force-emitter cap). */
export const MAX_LAYER_DRIVES = 3;

/*
 * Slot layout, per source per step:
 *
 *   0  1  2   centre c   (box-local px, +y up)
 *   3         radius r   (px — the gaussian reach)
 *   4  5  6   A row 0    7   b.x
 *   8  9 10   A row 1   11   b.y
 *  12 13 14   A row 2   15   b.z
 */

/** Byte offset of one (step, source) slot. Out-of-range steps clamp to the ends. */
export function layerDriveOffset(table, step, src) {
  const n = table.n | 0;
  const s = step < 0 ? 0 : step >= n ? n - 1 : step | 0;
  return (s * (table.count | 0) + src) * LAYER_DRIVE_STRIDE;
}

/**
 * The drive velocity at one point, written into `out` (length 3), plus the
 * gaussian weight of this source there — returned, so the caller can skip the
 * blend when the point is far outside the reach.
 */
export function layerDriveVelocity(out, data, o, x, y, z, gradient = true) {
  const dx = x - data[o], dy = y - data[o + 1], dz = z - data[o + 2];
  const r = data[o + 3] > 1 ? data[o + 3] : 1;
  const q = (dx * dx + dy * dy + dz * dz) / (r * r);
  if (q > 12) { out[0] = 0; out[1] = 0; out[2] = 0; return 0; }
  if (gradient) {
    out[0] = data[o + 4] * dx + data[o + 5] * dy + data[o + 6] * dz + data[o + 7];
    out[1] = data[o + 8] * dx + data[o + 9] * dy + data[o + 10] * dz + data[o + 11];
    out[2] = data[o + 12] * dx + data[o + 13] * dy + data[o + 14] * dz + data[o + 15];
  } else {
    // Travel only: the layer carries what is near it without whipping it. A
    // rotation-in-place then pushes nothing at all, which is the point.
    out[0] = data[o + 7]; out[1] = data[o + 11]; out[2] = data[o + 15];
  }
  return Math.exp(-q);
}

/**
 * Blend a particle's velocity toward what every layer source says the medium is
 * doing where it is. `vel` (length 3) is updated in place.
 *
 * The blend rate is the Blower's — strength/100 × weight × dt × 10, clamped to
 * 1 — so "how firmly it takes hold" means the same thing on both, and a
 * strength of 0 is an exact bypass rather than a very small push.
 */
export function applyLayerDrives(vel, table, step, drives, x, y, z, dt, scratch) {
  if (!table || !drives.length) return vel;
  const tv = scratch || [0, 0, 0];
  const count = Math.min(table.count | 0, drives.length);
  for (let k = 0; k < count; k++) {
    const strength = drives[k].strength;
    if (!(strength > 0)) continue;
    const o = layerDriveOffset(table, step, k);
    const w = layerDriveVelocity(tv, table.data, o, x, y, z, drives[k].spinDrag !== false);
    if (w < 1e-3) continue;
    let a = (strength / 100) * w * dt * 10;
    if (a > 1) a = 1;
    vel[0] += (tv[0] - vel[0]) * a;
    vel[1] += (tv[1] - vel[1]) * a;
    vel[2] += (tv[2] - vel[2]) * a;
  }
  return vel;
}

/**
 * The splats layer sources push into the FLUID, appended to `out`. A splat
 * carries one velocity, so the field gets the centre's motion (`b`) — the
 * gradient stays on the direct particle drive above. That is enough for the
 * thing it is there for: a layer sweeping past should shove the medium out of
 * its way, not just the particles that happen to be in it.
 */
export function layerDriveSplats(out, table, step, drives) {
  if (!table || !drives.length) return out;
  const count = Math.min(table.count | 0, drives.length);
  for (let k = 0; k < count; k++) {
    const fe = drives[k];
    if (!(fe.strength > 0)) continue;
    const o = layerDriveOffset(table, step, k);
    const d = table.data;
    out.push({
      x: d[o], y: d[o + 1], z: d[o + 2], r: d[o + 3] > 1 ? d[o + 3] : 1,
      tvx: d[o + 7], tvy: d[o + 11], tvz: d[o + 15],
      k: fe.strength / 100, den: 0, heat: 0,
    });
  }
  return out;
}

/**
 * Build one slot from a pair of 3×4 transforms (row-major, 12 floats each) one
 * `dt` apart, plus the centre and radius. Pure arithmetic, so the editor's
 * sampler and the node tests share it.
 *
 * A = (Mnow · Mprev⁻¹ − I) / dt, evaluated as the linear part only — the
 * translation falls out of `b`, which is measured directly as the centre's own
 * displacement. Doing it that way keeps the two halves independent: a pure
 * translation gives A = 0 exactly, whatever the rotation is.
 */
export function writeLayerDriveSlot(data, o, now, prev, dt, cx, cy, cz, radius) {
  const idt = dt > 1e-6 ? 1 / dt : 0;
  data[o] = cx; data[o + 1] = cy; data[o + 2] = cz;
  data[o + 3] = radius > 1 ? radius : 1;
  // Linear part of Mnow · Mprev⁻¹. `prev` is a similarity (rotation × scale),
  // so its inverse linear block is Rᵀ/s² per axis — computed by inverting the
  // 3×3 directly, which stays correct for non-uniform scale too.
  const inv = invert3(prev);
  if (!inv) {
    for (let i = 4; i < 16; i++) data[o + i] = 0;
    return data;
  }
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += now[r * 4 + k] * inv[k * 3 + c];
      data[o + 4 + r * 4 + c] = (sum - (r === c ? 1 : 0)) * idt;
    }
  }
  // b: the centre's own velocity — where this layer's origin went, over dt.
  data[o + 7] = (now[3] - prev[3]) * idt;
  data[o + 11] = (now[7] - prev[7]) * idt;
  data[o + 15] = (now[11] - prev[11]) * idt;
  return data;
}

/** Inverse of the 3×3 linear block of a row-major 3×4. Null when singular. */
function invert3(m) {
  const a = m[0], b = m[1], c = m[2];
  const d = m[4], e = m[5], f = m[6];
  const g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const s = 1 / det;
  return [
    A * s, (c * h - b * i) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, (c * d - a * f) * s,
    C * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
}

/**
 * A 3×4 row-major transform from a PRS in the canonical (THREE-space) form
 * keyframeParenting resolves.
 *
 * The rotation is Rx·Ry·Rz — THREE's default Euler order, which is what
 * applyMeshTransform relies on when it does `mesh.rotation.set(rx, ry, rz)`.
 * The scale rides on the columns, as Matrix4.compose puts it there. A layer is
 * a flat plate, so its z scale is 1 in the mesh and 1 here.
 */
export function prsToMatrix(out, prs) {
  const a = Math.cos(prs.rx), b = Math.sin(prs.rx);
  const c = Math.cos(prs.ry), d = Math.sin(prs.ry);
  const e = Math.cos(prs.rz), f = Math.sin(prs.rz);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  const sx = prs.sx, sy = prs.sy, sz = Number.isFinite(prs.sz) ? prs.sz : 1;
  out[0] = (c * e) * sx;        out[1] = (-c * f) * sy;      out[2] = d * sz;       out[3] = prs.px;
  out[4] = (af + be * d) * sx;  out[5] = (ae - bf * d) * sy; out[6] = (-b * c) * sz; out[7] = prs.py;
  out[8] = (bf - ae * d) * sx;  out[9] = (be + af * d) * sy; out[10] = (a * c) * sz; out[11] = prs.pz;
  return out;
}

/** out = a · b, both row-major 3×4 (implicit bottom row 0 0 0 1). */
export function mul34(out, a, b) {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
    }
    out[r * 4 + 3] = a[r * 4] * b[3] + a[r * 4 + 1] * b[7] + a[r * 4 + 2] * b[11] + a[r * 4 + 3];
  }
  return out;
}

/** The inverse of a row-major 3×4. Null when its linear block is singular. */
export function invert34(out, m) {
  const inv = invert3(m);
  if (!inv) return null;
  for (let r = 0; r < 3; r++) {
    out[r * 4] = inv[r * 3]; out[r * 4 + 1] = inv[r * 3 + 1]; out[r * 4 + 2] = inv[r * 3 + 2];
    out[r * 4 + 3] = -(inv[r * 3] * m[3] + inv[r * 3 + 1] * m[7] + inv[r * 3 + 2] * m[11]);
  }
  return out;
}

/** Identity key — what the sim hash uses so a moved source layer re-bakes. */
export function layerDriveKey(table) {
  return table ? table.key : '';
}
