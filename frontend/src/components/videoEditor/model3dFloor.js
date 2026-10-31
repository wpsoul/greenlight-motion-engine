/*
 * The lowest point of a posed model, for Scene Rig floor placement (model3dLayer's
 * poseModel stands every model on the cyclorama floor, every frame).
 *
 * Why not Box3.setFromObject: its fast path unions each mesh's bounding box AFTER the
 * mesh's transform, and a rotated box reaches below the geometry inside it. A turning
 * wheel's box corners swing past its rim, so a spinning flywheel lifted the whole
 * model by up to 41 % of its radius four times per revolution and the model hopped on
 * the floor (the Teardown V8 GLB: 78 px at a 48 % fit). Box3's precise path is exact
 * but reads every vertex of every mesh each frame.
 *
 * Here only the meshes whose box can still hold the lowest point are measured vertex
 * by vertex: sorted by box bottom, walked until the next box starts above the lowest
 * vertex found, and each result is kept until that mesh moves — a static model is
 * measured once. Skinned, morphed and instanced meshes, points and lines keep their
 * box, as before: their drawn vertices are not the geometry's positions.
 */
import * as THREE from 'three';

const _box = new THREE.Box3();
const _cands = [];
const _exact = new WeakMap(); // mesh → { geometry, version, m: matrixWorld snapshot, y }

function exactLowY(mesh) {
  const geometry = mesh.geometry;
  const pos = geometry.attributes.position;
  const e = mesh.matrixWorld.elements;
  const hit = _exact.get(mesh);
  if (hit && hit.geometry === geometry && hit.version === pos.version) {
    let same = true;
    for (let i = 0; i < 16; i++) if (hit.m[i] !== e[i]) { same = false; break; }
    if (same) return hit.y;
  }
  // World y of a local vertex: row 1 of the (affine) world matrix.
  const ex = e[1], ey = e[5], ez = e[9];
  let y = Infinity;
  if (!pos.isInterleavedBufferAttribute && !pos.normalized && pos.itemSize === 3) {
    const a = pos.array;
    const end = Math.min(a.length, pos.count * 3);
    for (let i = 0; i < end; i += 3) {
      const v = ex * a[i] + ey * a[i + 1] + ez * a[i + 2];
      if (v < y) y = v;
    }
  } else {
    for (let i = 0; i < pos.count; i++) {
      const v = ex * pos.getX(i) + ey * pos.getY(i) + ez * pos.getZ(i);
      if (v < y) y = v;
    }
  }
  y += e[13];
  if (hit) {
    hit.geometry = geometry; hit.version = pos.version; hit.y = y;
    for (let i = 0; i < 16; i++) hit.m[i] = e[i];
  } else {
    _exact.set(mesh, { geometry, version: pos.version, m: Float64Array.from(e), y });
  }
  return y;
}

/**
 * World-space y of the lowest point of `root` and everything under it (the same
 * objects Box3.setFromObject visits, visible or not). World matrices must be current.
 * +Infinity when nothing has geometry.
 */
export function lowestPointY(root) {
  _cands.length = 0;
  root.traverse((o) => {
    const g = o.geometry;
    if (!g) return;
    // Box3.expandByObject's own choice: an object's box (instanced, skinned, batched)
    // when it has one, else its geometry's.
    if (o.boundingBox !== undefined) {
      if (o.boundingBox === null) o.computeBoundingBox();
      _box.copy(o.boundingBox);
    } else {
      if (g.boundingBox === null) g.computeBoundingBox();
      _box.copy(g.boundingBox);
    }
    _box.applyMatrix4(o.matrixWorld);
    if (!Number.isFinite(_box.min.y)) return; // empty geometry
    const exact = o.isMesh === true && !o.isSkinnedMesh && !o.isInstancedMesh && !o.isBatchedMesh
      && !(o.morphTargetInfluences && o.morphTargetInfluences.length) && !!g.attributes.position;
    _cands.push({ low: _box.min.y, o, exact });
  });
  _cands.sort((a, b) => a.low - b.low);
  let y = Infinity;
  for (const c of _cands) {
    if (c.low >= y) break; // every later box starts higher than what is already found
    const v = c.exact ? exactLowY(c.o) : c.low;
    if (v < y) y = v;
  }
  _cands.length = 0;
  return y;
}
