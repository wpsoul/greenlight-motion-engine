// (Track 4A.4) Helpers for posed skinned meshes: fast per-bone conservative bounding boxes for frustum culling,
// world-space posed geometry extraction for inspectScene/BVH checks, and opt-in dual-quaternion skinning for imported GLBs.

import * as THREE from 'three';
import { useDualQuaternions } from './dualQuat.js';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _morph = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _m0 = new THREE.Matrix4();
const _m1 = new THREE.Matrix4();
const _instMat = new THREE.Matrix4();
const _worldMat = new THREE.Matrix4();
const _invRoot = new THREE.Matrix4();
const _b0 = new THREE.Box3();

function isDescendant(ancestor, node) {
  for (let p = node; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

/** Ensures every bone of `sm.skeleton` has a current `matrixWorld`, even if bones live outside `root`. */
function ensureSkeletonMatrices(sm, root) {
  const bones = sm.skeleton?.bones;
  if (!bones?.length) return;
  const checkedRoots = new Set();
  for (let i = 0; i < bones.length; i += 1) {
    const bone = bones[i];
    if (!bone || isDescendant(root, bone)) continue;
    let top = bone;
    while (top.parent) top = top.parent;
    if (!checkedRoots.has(top)) {
      checkedRoots.add(top);
      top.updateMatrixWorld(true);
    }
  }
}

function elementsEqual(a, b, offset = 0) {
  for (let i = 0; i < 16; i += 1) if (a[offset + i] !== b[i]) return false;
  return true;
}

function morphMetaMatches(geom, meta) {
  const mp = geom.morphAttributes?.position || [];
  const prev = meta.morphVersions || [];
  if (mp.length !== prev.length || meta.morphRelative !== !!geom.morphTargetsRelative) return false;
  for (let i = 0; i < mp.length; i += 1) {
    if ((mp[i]?.version ?? 0) !== prev[i]) return false;
  }
  return true;
}

function skinBoxesCacheValid(sm, geom, pos, si, sw) {
  const meta = geom.userData?._skinBoneBoxesMeta;
  const boxes = geom.userData?._skinBoneBoxes;
  const restBox = geom.userData?._skinRestBox;
  if (!meta || !Array.isArray(boxes) || !restBox) return false;
  const bones = sm.skeleton.bones;
  const boneInverses = sm.skeleton.boneInverses;
  if (meta.posVersion !== pos.version || meta.siVersion !== si.version || meta.swVersion !== sw.version) return false;
  if (!morphMetaMatches(geom, meta)) return false;
  if (meta.boneCount !== bones.length || boxes.length !== bones.length) return false;
  if (!elementsEqual(meta.bindMatrix, sm.bindMatrix.elements)) return false;
  for (let b = 0; b < bones.length; b += 1) {
    if (!boneInverses[b] || !elementsEqual(meta.boneInverses, boneInverses[b].elements, b * 16)) return false;
  }
  return true;
}

function widenPad(pad, x, y, z) {
  if (!pad.has) {
    pad.min[0] = pad.max[0] = x;
    pad.min[1] = pad.max[1] = y;
    pad.min[2] = pad.max[2] = z;
    pad.has = true;
    return;
  }
  if (x < pad.min[0]) pad.min[0] = x;
  if (y < pad.min[1]) pad.min[1] = y;
  if (z < pad.min[2]) pad.min[2] = z;
  if (x > pad.max[0]) pad.max[0] = x;
  if (y > pad.max[1]) pad.max[1] = y;
  if (z > pad.max[2]) pad.max[2] = z;
}

function buildSkinBoneBoxes(sm, geom, pos, si, sw) {
  const bones = sm.skeleton.bones;
  const boneInverses = sm.skeleton.boneInverses;
  const nBones = bones.length;
  const toBone = new Array(nBones);
  const invSnapshot = new Float64Array(nBones * 16);
  for (let b = 0; b < nBones; b += 1) {
    toBone[b] = new THREE.Matrix4().multiplyMatrices(boneInverses[b], sm.bindMatrix);
    invSnapshot.set(boneInverses[b].elements, b * 16);
  }
  const boxes = Array.from({ length: nBones }, () => ({
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    count: 0,
  }));
  const restBox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], count: 0 };

  const morphPos = geom.morphAttributes?.position || [];
  const morphRel = !!geom.morphTargetsRelative;
  const nMorphs = morphPos.length;
  const morphPads = nMorphs
    ? Array.from({ length: nMorphs }, () => Array.from({ length: nBones }, () => ({ min: [0, 0, 0], max: [0, 0, 0], has: false })))
    : null;
  const restMorphPads = nMorphs
    ? Array.from({ length: nMorphs }, () => ({ min: [0, 0, 0], max: [0, 0, 0], has: false }))
    : null;

  for (let i = 0; i < pos.count; i += 1) {
    _v0.fromBufferAttribute(pos, i);
    let touched = false;
    for (let k = 0; k < 4; k += 1) {
      const w = sw.getComponent(i, k);
      if (!(w > 0)) continue;
      const b = Math.round(si.getComponent(i, k));
      if (b < 0 || b >= nBones) continue;
      touched = true;
      _v1.copy(_v0).applyMatrix4(toBone[b]);
      const box = boxes[b];
      if (_v1.x < box.min[0]) box.min[0] = _v1.x;
      if (_v1.y < box.min[1]) box.min[1] = _v1.y;
      if (_v1.z < box.min[2]) box.min[2] = _v1.z;
      if (_v1.x > box.max[0]) box.max[0] = _v1.x;
      if (_v1.y > box.max[1]) box.max[1] = _v1.y;
      if (_v1.z > box.max[2]) box.max[2] = _v1.z;
      box.count += 1;
      if (nMorphs) {
        const te = toBone[b].elements;
        for (let m = 0; m < nMorphs; m += 1) {
          const attr = morphPos[m];
          if (!attr) continue;
          _morph.fromBufferAttribute(attr, i);
          if (!morphRel) _morph.sub(_v0);
          const dx = _morph.x, dy = _morph.y, dz = _morph.z;
          // Transform delta by the linear 3x3 of toBone[b] (column-major)
          widenPad(
            morphPads[m][b],
            te[0] * dx + te[4] * dy + te[8] * dz,
            te[1] * dx + te[5] * dy + te[9] * dz,
            te[2] * dx + te[6] * dy + te[10] * dz,
          );
        }
      }
    }
    if (!touched) {
      if (_v0.x < restBox.min[0]) restBox.min[0] = _v0.x;
      if (_v0.y < restBox.min[1]) restBox.min[1] = _v0.y;
      if (_v0.z < restBox.min[2]) restBox.min[2] = _v0.z;
      if (_v0.x > restBox.max[0]) restBox.max[0] = _v0.x;
      if (_v0.y > restBox.max[1]) restBox.max[1] = _v0.y;
      if (_v0.z > restBox.max[2]) restBox.max[2] = _v0.z;
      restBox.count += 1;
      if (nMorphs) {
        for (let m = 0; m < nMorphs; m += 1) {
          const attr = morphPos[m];
          if (!attr) continue;
          _morph.fromBufferAttribute(attr, i);
          if (!morphRel) _morph.sub(_v0);
          widenPad(restMorphPads[m], _morph.x, _morph.y, _morph.z);
        }
      }
    }
  }

  geom.userData._skinBoneBoxes = boxes;
  geom.userData._skinRestBox = restBox;
  geom.userData._skinBoneMorphPads = morphPads;
  geom.userData._skinRestMorphPads = restMorphPads;
  geom.userData._skinBoneBoxesMeta = {
    posVersion: pos.version,
    siVersion: si.version,
    swVersion: sw.version,
    morphVersions: morphPos.map((a) => a?.version ?? 0),
    morphRelative: morphRel,
    boneCount: nBones,
    bindMatrix: Float64Array.from(sm.bindMatrix.elements),
    boneInverses: invSnapshot,
  };
  return { boxes, restBox, morphPads, restMorphPads };
}

/** Whether `root` holds a SkinnedMesh at all: asked once per model (model3dLayer.js), so a model with none never pays updateSkinnedBounds. */
export function hasSkinnedMesh(root) {
  let found = false;
  root?.traverse((n) => { if (n.isSkinnedMesh) found = true; });
  return found;
}

/**
 * Updates `sm.boundingBox` and `sm.boundingSphere` for every `SkinnedMesh` under `root` using cached per-bone bind-space
 * vertex AABBs (`geometry.userData._skinBoneBoxes`) + cached per-bone morph delta pads transformed in O(bones) by `(bindMatrixInverse * bone.matrixWorld)`.
 * Falls back cleanly to rest geometry bounds if `boneInverses` count does not match `bones` count or skin attributes are missing.
 */
export function updateSkinnedBounds(root) {
  if (!root) return { meshes: 0, boundingBox: null, boundingSphere: null };
  if (root.parent) root.parent.updateWorldMatrix(true, false);
  root.updateMatrixWorld(true);
  _invRoot.copy(root.matrixWorld).invert();

  const rootBox = new THREE.Box3();
  let meshes = 0;

  root.traverse((sm) => {
    if (!sm.isSkinnedMesh) return;
    const geom = sm.geometry;
    const pos = geom?.attributes?.position;
    const skeleton = sm.skeleton;
    if (!geom || !pos || !skeleton) return;

    const si = geom.attributes.skinIndex;
    const sw = geom.attributes.skinWeight;
    const bones = skeleton.bones;
    const boneInverses = skeleton.boneInverses;
    const validSkeleton = Boolean(
      si && sw && bones?.length && boneInverses?.length === bones.length && boneInverses.every(Boolean),
    );

    sm.boundingBox ??= new THREE.Box3();
    sm.boundingSphere ??= new THREE.Sphere();

    if (!validSkeleton) {
      if (!geom.boundingBox) geom.computeBoundingBox();
      if (geom.boundingBox) sm.boundingBox.copy(geom.boundingBox);
      else sm.boundingBox.makeEmpty();
      sm.boundingBox.getBoundingSphere(sm.boundingSphere);
    } else {
      ensureSkeletonMatrices(sm, root);
      const { boxes, restBox, morphPads, restMorphPads } = skinBoxesCacheValid(sm, geom, pos, si, sw)
        ? {
          boxes: geom.userData._skinBoneBoxes,
          restBox: geom.userData._skinRestBox,
          morphPads: geom.userData._skinBoneMorphPads,
          restMorphPads: geom.userData._skinRestMorphPads,
        }
        : buildSkinBoneBoxes(sm, geom, pos, si, sw);

      const infs = sm.morphTargetInfluences;
      const box = sm.boundingBox.makeEmpty();
      if (restBox.count > 0) {
        let rMinX = restBox.min[0], rMinY = restBox.min[1], rMinZ = restBox.min[2];
        let rMaxX = restBox.max[0], rMaxY = restBox.max[1], rMaxZ = restBox.max[2];
        if (restMorphPads && infs?.length) {
          for (let m = 0; m < restMorphPads.length && m < infs.length; m += 1) {
            const w = infs[m];
            const pad = restMorphPads[m];
            if (!w || !pad?.has) continue;
            if (w > 0) {
              rMinX += w * pad.min[0]; rMinY += w * pad.min[1]; rMinZ += w * pad.min[2];
              rMaxX += w * pad.max[0]; rMaxY += w * pad.max[1]; rMaxZ += w * pad.max[2];
            } else {
              rMinX += w * pad.max[0]; rMinY += w * pad.max[1]; rMinZ += w * pad.max[2];
              rMaxX += w * pad.min[0]; rMaxY += w * pad.min[1]; rMaxZ += w * pad.min[2];
            }
          }
        }
        _v0.set(rMinX, rMinY, rMinZ);
        box.expandByPoint(_v0);
        _v0.set(rMaxX, rMaxY, rMaxZ);
        box.expandByPoint(_v0);
      }
      for (let b = 0; b < bones.length; b += 1) {
        const bb = boxes[b];
        if (!bb || !bb.count) continue;
        const bone = bones[b];
        if (!bone) continue;
        _m0.multiplyMatrices(sm.bindMatrixInverse, bone.matrixWorld);
        let minX = bb.min[0], minY = bb.min[1], minZ = bb.min[2];
        let maxX = bb.max[0], maxY = bb.max[1], maxZ = bb.max[2];
        if (morphPads && infs?.length) {
          for (let m = 0; m < morphPads.length && m < infs.length; m += 1) {
            const w = infs[m];
            const pad = morphPads[m]?.[b];
            if (!w || !pad?.has) continue;
            if (w > 0) {
              minX += w * pad.min[0]; minY += w * pad.min[1]; minZ += w * pad.min[2];
              maxX += w * pad.max[0]; maxY += w * pad.max[1]; maxZ += w * pad.max[2];
            } else {
              minX += w * pad.max[0]; minY += w * pad.max[1]; minZ += w * pad.max[2];
              maxX += w * pad.min[0]; maxY += w * pad.min[1]; maxZ += w * pad.min[2];
            }
          }
        }
        for (let c = 0; c < 8; c += 1) {
          _v0.set(c & 1 ? maxX : minX, c & 2 ? maxY : minY, c & 4 ? maxZ : minZ).applyMatrix4(_m0);
          box.expandByPoint(_v0);
        }
      }
      box.getBoundingSphere(sm.boundingSphere);
    }

    if (!sm.boundingBox.isEmpty()) {
      _m1.multiplyMatrices(_invRoot, sm.matrixWorld);
      _b0.copy(sm.boundingBox).applyMatrix4(_m1);
      rootBox.union(_b0);
    }
    meshes += 1;
  });

  if (!meshes || rootBox.isEmpty()) {
    return { meshes, boundingBox: null, boundingSphere: null };
  }
  return {
    meshes,
    boundingBox: rootBox,
    boundingSphere: rootBox.getBoundingSphere(new THREE.Sphere()),
  };
}

function readLocalPosedVertex(mesh, geom, pos, vIdx, canSkin, out) {
  out.fromBufferAttribute(pos, vIdx);
  const morphPos = geom.morphAttributes?.position;
  const influences = mesh.morphTargetInfluences;
  if (morphPos?.length && influences?.length) {
    _morph.set(0, 0, 0);
    const relative = geom.morphTargetsRelative;
    for (let m = 0; m < morphPos.length && m < influences.length; m += 1) {
      const inf = influences[m];
      if (!inf) continue;
      _tmp.fromBufferAttribute(morphPos[m], vIdx);
      if (relative) _morph.addScaledVector(_tmp, inf);
      else _morph.addScaledVector(_tmp.sub(out), inf);
    }
    out.add(_morph);
  }
  if (canSkin) mesh.applyBoneTransform(vIdx, out);
  return out;
}

/**
 * Extracts posed triangle geometry from a live Three.js node tree (including morph targets, linear/DQ skinning,
 * and `InstancedMesh`es) into `{ mesh: { position: Float32Array, index: Uint32Array } }` for `inspectScene()`.
 * Pass `{ stopNodes, space: 'local' }` when parented child scene objects are inspected separately so child scene
 * nodes are not double-counted inside the parent's geometry and vertices are expressed in `node`'s local frame.
 * Returns `null` if zero triangles are collected.
 */
export function extractPosedObjectGeo(node, { stopNodes = null, space = 'world' } = {}) {
  if (!node) return null;
  if (node.parent) node.parent.updateWorldMatrix(true, false);
  node.updateMatrixWorld(true);
  const localInv = space === 'local' ? new THREE.Matrix4().copy(node.matrixWorld).invert() : null;

  const meshes = [];
  const visit = (obj) => {
    if (!obj || obj.visible === false) return;
    if (obj !== node && stopNodes?.has(obj)) return;
    const u = obj.userData;
    if (obj.isMesh && !u?.gobo && !u?.layerTwin && !u?.catcher && !u?.toonOutline && !u?.catcherAo) {
      meshes.push(obj);
    }
    for (let i = 0; i < obj.children.length; i += 1) visit(obj.children[i]);
  };
  visit(node);
  if (!meshes.length) return null;

  const chunks = [];
  let totalVerts = 0;
  let totalIndices = 0;

  for (let m = 0; m < meshes.length; m += 1) {
    const c = meshes[m];
    const geom = !c.isSkinnedMesh && c.userData?.roundSource ? c.userData.roundSource : c.geometry;
    const pos = geom?.attributes?.position;
    if (!pos || !pos.count) continue;

    const idxAttr = geom.index;
    const totalCount = idxAttr ? idxAttr.count : pos.count;
    const drStart = Math.max(0, geom.drawRange?.start ?? 0);
    const drCount = Number.isFinite(geom.drawRange?.count)
      ? Math.min(totalCount - drStart, geom.drawRange.count)
      : totalCount - drStart;
    const triIdxCount = Math.floor(Math.max(0, drCount) / 3) * 3;
    if (triIdxCount < 3) continue;

    const instCount = c.isInstancedMesh ? (c.count ?? 0) : 1;
    if (instCount <= 0) continue;

    const skeleton = c.skeleton;
    const canSkin = Boolean(
      c.isSkinnedMesh
      && skeleton?.bones?.length
      && skeleton.boneInverses?.length === skeleton.bones.length
      && geom.attributes.skinIndex
      && geom.attributes.skinWeight,
    );
    if (canSkin) {
      ensureSkeletonMatrices(c, node);
      skeleton.update();
      c.userData?.skinDQUpdate?.();
    }

    const fullRange = drStart === 0 && triIdxCount === totalCount;
    let localPos;
    let localIdx;

    if (fullRange) {
      localPos = new Float32Array(pos.count * 3);
      for (let v = 0; v < pos.count; v += 1) {
        readLocalPosedVertex(c, geom, pos, v, canSkin, _v0);
        localPos[v * 3] = _v0.x;
        localPos[v * 3 + 1] = _v0.y;
        localPos[v * 3 + 2] = _v0.z;
      }
      localIdx = new Uint32Array(triIdxCount);
      if (idxAttr) {
        for (let k = 0; k < triIdxCount; k += 1) localIdx[k] = idxAttr.getX(k);
      } else {
        for (let k = 0; k < triIdxCount; k += 1) localIdx[k] = k;
      }
    } else {
      const remap = new Int32Array(pos.count).fill(-1);
      const verts = [];
      localIdx = new Uint32Array(triIdxCount);
      for (let k = 0; k < triIdxCount; k += 1) {
        const rawIdx = idxAttr ? idxAttr.getX(drStart + k) : drStart + k;
        let mapped = remap[rawIdx];
        if (mapped < 0) {
          mapped = verts.length;
          remap[rawIdx] = mapped;
          verts.push(rawIdx);
        }
        localIdx[k] = mapped;
      }
      localPos = new Float32Array(verts.length * 3);
      for (let i = 0; i < verts.length; i += 1) {
        readLocalPosedVertex(c, geom, pos, verts[i], canSkin, _v0);
        localPos[i * 3] = _v0.x;
        localPos[i * 3 + 1] = _v0.y;
        localPos[i * 3 + 2] = _v0.z;
      }
    }

    const vertCount = localPos.length / 3;
    for (let inst = 0; inst < instCount; inst += 1) {
      if (c.isInstancedMesh) {
        c.getMatrixAt(inst, _instMat);
        _worldMat.multiplyMatrices(c.matrixWorld, _instMat);
      } else {
        _worldMat.copy(c.matrixWorld);
      }
      if (localInv) _worldMat.premultiply(localInv);
      const worldPos = new Float32Array(localPos.length);
      for (let v = 0; v < vertCount; v += 1) {
        _v0.set(localPos[v * 3], localPos[v * 3 + 1], localPos[v * 3 + 2]).applyMatrix4(_worldMat);
        worldPos[v * 3] = _v0.x;
        worldPos[v * 3 + 1] = _v0.y;
        worldPos[v * 3 + 2] = _v0.z;
      }
      chunks.push({ pos: worldPos, idx: localIdx, vertOffset: totalVerts });
      totalVerts += vertCount;
      totalIndices += localIdx.length;
    }
  }

  if (!totalIndices) return null;

  const position = new Float32Array(totalVerts * 3);
  const index = new Uint32Array(totalIndices);
  let posOff = 0;
  let idxOff = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const ch = chunks[i];
    position.set(ch.pos, posOff);
    posOff += ch.pos.length;
    const vo = ch.vertOffset;
    const srcIdx = ch.idx;
    for (let k = 0; k < srcIdx.length; k += 1) index[idxOff + k] = srcIdx[k] + vo;
    idxOff += srcIdx.length;
  }
  return { mesh: { position, index } };
}

/**
 * Applies dual-quaternion skinning (`useDualQuaternions`) to every imported `SkinnedMesh` under `root` when
 * `skinning === 'dualQuaternion'`. Skips meshes that already use dual-quaternion skinning or lack a complete skeleton.
 * Returns the array of converted `SkinnedMesh`es.
 */
export function applyImportedDualQuat(root, skinning) {
  if (!root || skinning !== 'dualQuaternion') return [];
  if (root.parent) root.parent.updateWorldMatrix(true, false);
  root.updateMatrixWorld(true);

  const converted = [];
  root.traverse((c) => {
    if (!c.isSkinnedMesh) return;
    const sk = c.skeleton;
    if (!sk?.bones?.length || sk.boneInverses?.length !== sk.bones.length || !sk.boneInverses.every(Boolean)) return;
    if (!c.geometry?.attributes?.skinIndex || !c.geometry?.attributes?.skinWeight) return;
    if (c.userData?.skinning === 'dualQuaternion') return;
    ensureSkeletonMatrices(c, root);
    useDualQuaternions(c);
    c.userData.skinDQUpdate?.();
    converted.push(c);
  });
  return converted;
}
