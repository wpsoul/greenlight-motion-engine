// (rigging) A rig on three objects: bones made from the joints, the meshes turned into skinned meshes with the rig's weights, and the
// rig's own clips (keys on the joints) as three AnimationClips. The editor (its three) and the world (its own three) each call this on
// their copy of the same model with the same JSON, so both copies get the same nodes in the same order: the editor poses its copy and
// hands the world the node matrices, exactly as for a model file that came with a skeleton (WorldRenderer #setNodePose).
//
// After binding, a model is a skinned model like any other: three skins it in Draft, the tracer skins it for Final (three-mesh-bvh
// SkinnedMeshBVH, refit when the bones move), and the pose pipeline (components/videoEditor/modelPose.js) finds the joints by name.

import * as THREE from 'three';
import { computeRig } from './core.js';
import { resolveJoints } from './joints.js';
import { sampleTrack, sampleQuatTrack } from '../keys.js';
import { useDualQuaternions } from './dualQuat.js';
import { retargetMotionToRig } from './retarget.js';

const DEG = Math.PI / 180;
/** three's node name for a joint ("thigh.L" → "thighL"; the pose pipeline matches either spelling). */
export const jointNodeName = (name) => THREE.PropertyBinding.sanitizeNodeName(String(name));

// one rig per (meshes, JSON), by content: a world rebuilt for a light, a graph evaluated again off the editor's thread (a new copy of the
// same points), or a second layer of the same file with the same rig does not solve again. A few of them are kept.
const solved = new Map();
function contentKey(meshes, groups) {
  // two FNV-1a hashes over the points', triangles' and vertex groups' bits, and the counts
  let a = 2166136261, b = 0x9e3779b9;
  for (const m of meshes) {
    const own = groups?.get(m.object) || {};
    const names = Object.keys(own).sort();
    for (const n of names) for (let i = 0; i < n.length; i += 1) a = Math.imul(a ^ n.charCodeAt(i), 16777619);
    for (const arr of [m.position, m.index, ...names.map((n) => own[n])]) {
      if (!arr) { a = Math.imul(a ^ 0x55, 16777619); continue; }
      const u = new Uint32Array(arr.buffer, arr.byteOffset, (arr.byteLength / 4) | 0);
      for (let i = 0; i < u.length; i += 1) { a = Math.imul(a ^ u[i], 16777619); b = Math.imul(b ^ u[i], 2246822519) ^ (b >>> 13); }
      a = Math.imul(a ^ u.length, 16777619);
    }
  }
  return `${meshes.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}
function keep(key, result) {
  solved.set(key, result);
  if (solved.size > 8) solved.delete(solved.keys().next().value);
}
function cachedRig(key, make) {
  if (!solved.has(key)) keep(key, make());
  return solved.get(key);
}
const rigKeyOf = (found, groups, spec) => `${contentKey(found, groups)}|${JSON.stringify(spec)}`;

// (leftovers-rig) solves on their way back from a worker, by key
const inflight = new Map();

/**
 * Starts the solve bindRig would make for `root` and `spec`, on `solve` (rigSolver.js: a worker), so that bindRig then finds it ready and
 * binds without solving on the page's thread. Returns null when there is nothing to wait for (already solved, or no worker: bindRig solves
 * as before), else a Promise that settles (never rejects) once the solve is in. The same meshes and JSON make the same key bindRig looks
 * up, and the worker runs the same code, so the weights are the same to the bit.
 */
export function solveRigAhead(root, spec, { groups = null, solve = null } = {}) {
  if (!root || !spec || typeof spec !== 'object' || typeof solve !== 'function') return null;
  // a skeleton of the file's own bones binds nothing: no weights to wait for
  if (ownBones(root, spec, resolveJoints(spec).joints)) return null;
  const found = rigMeshes(root);
  if (!found.length) return null;
  const key = rigKeyOf(found, groups, spec);
  if (solved.has(key)) return null;
  if (inflight.has(key)) return inflight.get(key);
  const asked = solve(spec, found.map((m) => ({ name: m.name, position: m.position, index: m.index, groups: groups?.get(m.object) || null })));
  if (!asked) return null;
  const done = Promise.resolve(asked).then((result) => { if (result && result.joints) keep(key, result); }, () => {}).finally(() => inflight.delete(key));
  inflight.set(key, done);
  return done;
}

/**
 * Each joint's rest frame: `world`, its turn as the skeleton writes it (`rot` down the chain; left out, the mesh's axes), and its local
 * position, rotation and scale under its parent. A joint that is one of the model file's own bones (`rest`, bindRig's ownRig) rests as that
 * bone does.
 */
function restFrames(joints) {
  const worldQ = [];
  return joints.map((j, i) => {
    const q = j.rot ? new THREE.Quaternion().setFromEuler(new THREE.Euler(j.rot[0] * DEG, j.rot[1] * DEG, j.rot[2] * DEG, 'XYZ')) : new THREE.Quaternion();
    const parentQ = j.parent >= 0 ? worldQ[j.parent] : new THREE.Quaternion();
    worldQ[i] = parentQ.clone().multiply(q);
    if (j.rest) {
      return { position: new THREE.Vector3().fromArray(j.rest.at), quaternion: new THREE.Quaternion().fromArray(j.rest.quat), scale: new THREE.Vector3().fromArray(j.rest.scale), world: worldQ[i] };
    }
    const from = j.parent >= 0 ? joints[j.parent].at : [0, 0, 0];
    const local = new THREE.Vector3(j.at[0] - from[0], j.at[1] - from[1], j.at[2] - from[2]).applyQuaternion(parentQ.clone().invert());
    return { position: local, quaternion: q, scale: new THREE.Vector3(1, 1, 1), world: worldQ[i] };
  });
}

/**
 * Bones for these joints under one container (an Object3D named "skeleton"): the container, then the bones depth-first in joint order, which
 * is the node order both copies share. Returns { container, bones } (bones in joint order).
 */
export function buildBones(joints, name = 'skeleton', frame = null) {
  const container = new THREE.Object3D();
  container.name = name;
  // (ownRig) where the file's own root bones hang, so these bones stand where the file's do
  if (Array.isArray(frame) && frame.length === 16) new THREE.Matrix4().fromArray(frame).decompose(container.position, container.quaternion, container.scale);
  const frames = restFrames(joints);
  const bones = joints.map((j, i) => {
    const b = new THREE.Bone();
    b.name = jointNodeName(j.name);
    b.position.copy(frames[i].position);
    b.quaternion.copy(frames[i].quaternion);
    b.scale.copy(frames[i].scale);
    return b;
  });
  joints.forEach((j, i) => (j.parent >= 0 ? bones[j.parent] : container).add(bones[i]));
  return { container, bones };
}

/** Joint indices in the order a container built by buildBones is traversed: the container's children, depth first, in joint order. */
function treeOrder(joints) {
  const out = [];
  const visit = (p) => joints.forEach((j, i) => { if (j.parent === p) { out.push(i); visit(i); } });
  visit(-1);
  return out;
}

/**
 * The model file's own bones a skeleton's joints name, in `joints`' order, when the skeleton has no template and every joint names one:
 * then it describes the file's own rig (what /api/world3d/prepare-asset writes for a rigged model it retargeted a clip onto). Null otherwise.
 */
function ownBones(root, spec, joints) {
  if (!root || spec?.template || !joints?.length) return null;
  const byName = new Map();
  root.traverse((o) => { if (o.isBone && o.name && !byName.has(o.name)) byName.set(o.name, o); });
  if (!byName.size) return null;
  const bones = joints.map((j) => byName.get(j.name) || byName.get(jointNodeName(j.name)));
  return bones.every(Boolean) ? bones : null;
}

/**
 * A skeleton that names the file's own bones: nothing is solved or bound again (the file's meshes are skinned already, and a second set of
 * bones with the same names would leave whatever it bound on bones no clip reaches). Each joint carries its bone's rest frame in root's
 * space, so the clips play on the file's bones (rigClips) and the editor's copy of the joints (scenePose.js) poses them as the world's. A
 * plain mesh keeps its place unless `parts` names it: then it follows that bone whole.
 */
function ownRig(root, spec, resolved, bones, warnings) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const inRoot = (o) => (o && o !== root ? new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld) : new THREE.Matrix4());
  const turnOf = (m) => { const q = new THREE.Quaternion(); m.decompose(new THREE.Vector3(), q, new THREE.Vector3()); return q; };
  const joints = resolved.map((j, i) => {
    const b = bones[i], parent = inRoot(b.parent);
    return {
      ...j,
      at: new THREE.Vector3().setFromMatrixPosition(inRoot(b)).toArray(),
      rest: { at: b.position.toArray(), quat: b.quaternion.toArray(), scale: b.scale.toArray() },
      world: turnOf(inRoot(b)).toArray(),
      parentWorld: turnOf(parent).toArray(),
      parentInv: new THREE.Matrix3().setFromMatrix4(parent).invert().toArray(),
    };
  });
  const firstRoot = joints.findIndex((j) => j.parent < 0);
  const frame = firstRoot >= 0 ? inRoot(bones[firstRoot].parent).toArray() : null;
  // not in the scene: the list the world's #setNodePose walks is the file's bones, in the order the editor's copy traverses its joints
  const container = new THREE.Object3D();
  container.name = 'skeleton';
  container.userData.nodeList = [container, ...treeOrder(joints).map((i) => bones[i])];
  const plain = rigMeshes(root);
  const byJoint = new Map(joints.map((j, i) => [j.name, i]));
  const parts = spec.parts && typeof spec.parts === 'object' ? spec.parts : {};
  const meshes = [];
  const skeleton = new THREE.Skeleton(bones);
  for (const m of plain) {
    const joint = parts[m.name];
    if (joint == null) continue;
    const i = byJoint.get(joint) ?? joints.findIndex((j) => jointNodeName(j.name) === jointNodeName(joint));
    if (i === undefined || i < 0) { warnings.push(`skeleton: parts names joint "${joint}" for mesh "${m.name}", and there is no such joint`); continue; }
    const n = m.position.length / 3;
    const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);
    for (let v = 0; v < n; v += 1) { skinIndex[v * 4] = i; skinWeight[v * 4] = 1; }
    const sm = skinnedInPlace(m.object, skinIndex, skinWeight);
    meshes.push(sm);
  }
  if (meshes.length) {
    root.updateMatrixWorld(true);
    for (const sm of meshes) sm.bind(skeleton, sm.matrixWorld);
    if (spec.skinning !== 'linear') for (const sm of meshes) useDualQuaternions(sm);
  }
  const kept = plain.length - meshes.length;
  if (kept) warnings.push(`skeleton: ${kept} plain mesh(es) keep their place (the skeleton names the file's own bones; \`parts\` binds a mesh to one)`);
  root.userData.skinned = true;
  root.userData.rigBones = container;
  return { joints, landmarks: null, found: [], frame, bones, container, skeleton, meshes, clips: rigClips(spec, joints), own: true,
    report: { joints: joints.length, own: true, bound: meshes.length }, warnings };
}

/** The meshes a rig can bind under `root`, in traversal order, with their points in root's space. */
export function rigMeshes(root) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const out = [];
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.userData?.rigSkip) return;
    const g = o.geometry;
    const pos = g?.attributes?.position;
    if (!pos || pos.itemSize !== 3) return;
    const m = inv.clone().multiply(o.matrixWorld);
    const position = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 1) { v.fromBufferAttribute(pos, i).applyMatrix4(m); position[i * 3] = v.x; position[i * 3 + 1] = v.y; position[i * 3 + 2] = v.z; }
    out.push({ object: o, name: o.name, position, index: g.index ? Uint32Array.from(g.index.array) : null });
  });
  return out;
}

/** A skinned mesh in the place of `mesh`: the same geometry buffers plus the weights, the same material, transform, flags and children. */
function skinnedInPlace(mesh, skinIndex, skinWeight) {
  const src = mesh.geometry;
  const geo = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) geo.setAttribute(name, attr);
  geo.setIndex(src.index);
  for (const [name, list] of Object.entries(src.morphAttributes || {})) geo.morphAttributes[name] = list;
  geo.morphTargetsRelative = src.morphTargetsRelative;
  for (const g of src.groups) geo.addGroup(g.start, g.count, g.materialIndex);
  geo.drawRange = { ...src.drawRange };
  geo.userData = { ...src.userData };
  geo.name = src.name;
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  const sm = new THREE.SkinnedMesh(geo, mesh.material);
  sm.name = mesh.name;
  sm.position.copy(mesh.position); sm.quaternion.copy(mesh.quaternion); sm.scale.copy(mesh.scale);
  sm.matrixAutoUpdate = mesh.matrixAutoUpdate;
  sm.matrix.copy(mesh.matrix);
  sm.castShadow = mesh.castShadow; sm.receiveShadow = mesh.receiveShadow;
  sm.visible = mesh.visible; sm.renderOrder = mesh.renderOrder;
  sm.layers.mask = mesh.layers.mask;
  sm.userData = { ...mesh.userData };
  if (mesh.visibleToShadowRays !== undefined) sm.visibleToShadowRays = mesh.visibleToShadowRays;
  // a mesh's own shadow hooks (a see-through decal group that casts nothing) go with it
  if (Object.prototype.hasOwnProperty.call(mesh, 'onBeforeShadow')) sm.onBeforeShadow = mesh.onBeforeShadow;
  if (Object.prototype.hasOwnProperty.call(mesh, 'onAfterShadow')) sm.onAfterShadow = mesh.onAfterShadow;
  // its bounds move with the pose: never culled by its rest box
  sm.frustumCulled = false;
  if (mesh.morphTargetInfluences) { sm.morphTargetInfluences = [...mesh.morphTargetInfluences]; sm.morphTargetDictionary = { ...mesh.morphTargetDictionary }; }
  const parent = mesh.parent;
  if (parent) { parent.children[parent.children.indexOf(mesh)] = sm; sm.parent = parent; mesh.parent = null; }
  for (const c of [...mesh.children]) sm.add(c);
  return sm;
}

/**
 * Binds `spec` (rig JSON, core.js) to the meshes under `root`: joints, weights, bones under a "skeleton" container appended as root's last
 * child, skinned meshes in place of the plain ones (the solve is cached by the meshes' content and the JSON). `groups`: a
 * Map mesh object → { name: Float32Array } (a graph mesh's vertex groups, for fixes by group).
 * Returns { joints, bones, container, skeleton, meshes, clips, report, warnings } or null when there is nothing to bind.
 */
export function bindRig(root, spec, { groups = null } = {}) {
  if (!root || !spec || typeof spec !== 'object') return null;
  const warnings = [];
  const resolved = resolveJoints(spec);
  const fileBones = ownBones(root, spec, resolved.joints);
  if (fileBones) return ownRig(root, spec, resolved.joints, fileBones, [...resolved.warnings, ...warnings]);
  const found = rigMeshes(root);
  // nothing to bind, and still the skeleton's clips: they play on whatever nodes of the file their tracks name
  if (!found.length) {
    return { joints: [], bones: [], container: null, skeleton: null, meshes: [], clips: rigClips(spec, resolved.joints), report: { joints: 0 },
      warnings: ['skeleton: nothing to bind (no plain mesh under this object)'] };
  }
  let skipped = 0;
  root.traverse((o) => { if (o.isSkinnedMesh) skipped += 1; });
  if (skipped) warnings.push(`skeleton: ${skipped} mesh(es) already have a skeleton of their own and keep it`);
  const result = cachedRig(rigKeyOf(found, groups, spec), () => {
    // the dense weights and the surface are the solve's own: only the result is kept
    const { W, S, ...kept } = computeRig(spec, found.map((m) => ({ name: m.name, position: m.position, index: m.index, groups: groups?.get(m.object) || null })));
    return kept;
  });
  warnings.push(...result.warnings);
  if (!result.influences) return { joints: result.joints, bones: [], container: null, skeleton: null, meshes: [], clips: [], report: result.report, warnings };
  const { container, bones } = buildBones(result.joints);
  // a joint named like one of the file's own nodes would be found in the node's place by name
  const own = new Set();
  root.traverse((o) => { if (o.name) own.add(o.name); });
  for (const b of bones) if (own.has(b.name)) warnings.push(`skeleton: joint "${b.name}" has the name of one of this model's own nodes; the pose finds the node first`);
  root.add(container);
  const meshes = found.map((m, i) => skinnedInPlace(m.object, result.influences[i].skinIndex, result.influences[i].skinWeight));
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  for (const sm of meshes) {
    sm.bind(skeleton, sm.matrixWorld);
    // its box and sphere at rest, in its own space (what three would measure with the bones at rest; never a stale pose's)
    sm.geometry.computeBoundingBox();
    sm.geometry.computeBoundingSphere();
    sm.boundingBox = sm.geometry.boundingBox.clone();
    sm.boundingSphere = sm.geometry.boundingSphere.clone();
  }
  // dual quaternions unless the skeleton asks for linear blending: bends keep their thickness, twists do not collapse (rig/dualQuat.js;
  // the world's raster reads the table through its patched three, the tracer through applyBoneTransform)
  const skinning = spec.skinning === 'linear' ? 'linear' : 'dualQuaternion';
  if (skinning === 'dualQuaternion') for (const sm of meshes) useDualQuaternions(sm);
  root.userData.skinned = true;
  root.userData.rigBones = container;
  // the rest pose, read back through the skinning the tracer uses (applyBoneTransform): the binding moves nothing
  const report = { ...result.report, skinning, neutralMaxMove: neutralMaxMove(meshes) };
  const clips = rigClips(spec, result.joints);
  return { joints: result.joints, landmarks: result.landmarks, found: result.found, bones, container, skeleton, meshes, clips, report, warnings };
}

/** The farthest any vertex moves when the bones are at rest (skinned vs. its own point), in the mesh's own units. */
export function neutralMaxMove(meshes) {
  let most = 0;
  const v = new THREE.Vector3(), w = new THREE.Vector3();
  for (const sm of meshes) {
    sm.skeleton.update();
    const pos = sm.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i);
      w.copy(v);
      sm.applyBoneTransform(i, w);
      most = Math.max(most, w.distanceTo(v));
    }
  }
  return most;
}

/**
 * The rig's clips: `rig.clips` [{ name, duration, bones: { "<joint>": { rot, at, scale } } }], each field a track of keys [{ t, v, ease }]
 * (world3d/keys.js: held before the first key and after the last, eased between). `rot` turns from the joint's rest (degrees XYZ, as the
 * pose's bone controls), `at` moves from it (the mesh's units), `scale` multiplies it. Sampled at 60 per second into three tracks, so a
 * key's ease plays as written. A rig's clips play like a file's own: `pose.clips: [{ clip: "<name>" }]`.
 */
export function rigClips(spec, joints) {
  const out = [];
  const rawClips = [...(Array.isArray(spec?.clips) ? spec.clips : [])];
  const retargetList = Array.isArray(spec?.retarget) ? spec.retarget : (spec?.retarget && typeof spec.retarget === 'object' ? [spec.retarget] : []);
  for (const r of retargetList) {
    if (!r || typeof r !== 'object') continue;
    const src = r.bvh ?? r.source;
    if (!src) continue;
    try {
      const res = retargetMotionToRig(src, joints, {
        name: r.name || 'retargeted',
        scale: r.scale,
        inPlace: !!r.inPlace,
        map: r.map,
        alignRest: r.alignRest,
        stride: r.stride,
      });
      if (res?.clip) rawClips.push(res.clip);
    } catch { /* reported cleanly when queried via API or schema */ }
  }
  const frames = restFrames(joints);
  // How a key becomes a bone's local value. A joint the skeleton made: the key turns it from its rest in its own frame (as the pose's bone
  // controls do), local = rest * key, and `at` moves it in its parent's frame. One of the file's own bones (ownRig): the key is written in
  // the skeleton's frames (`rot`, or the mesh's axes when left out), so the bone makes the motion the key makes there, whatever its own rest
  // turn: local = Rp^-1 * S * key * S^-1 * Rw (Rp its parent node's turn in the file, Rw its own, S the skeleton's frame), and `at`, a move
  // in the parent joint's frame, is taken into the bone's parent space (an armature's scale and turn with it).
  const fromArr = (a) => new THREE.Quaternion().fromArray(a);
  const place = joints.map((j, i) => {
    const f = frames[i];
    if (!j.world) return { pre: f.quaternion, post: null, rest: f, move: null };
    const S = f.world, SJ = j.parent >= 0 ? frames[j.parent].world : new THREE.Quaternion();
    const parentInv = new THREE.Matrix3().fromArray(j.parentInv);
    return {
      pre: fromArr(j.parentWorld).invert().multiply(S),
      post: S.clone().invert().multiply(fromArr(j.world)),
      rest: f,
      move: (v) => v.applyQuaternion(SJ).applyMatrix3(parentInv),
    };
  });
  const index = new Map(joints.map((j, i) => [j.name, i]));
  for (const c of rawClips) {
    if (!c || typeof c.name !== 'string' || !c.bones || typeof c.bones !== 'object') continue;
    const tracks = [];
    let end = 0;
    for (const control of Object.values(c.bones)) for (const track of Object.values(control || {})) if (Array.isArray(track)) for (const k of track) end = Math.max(end, Number(k?.t) || 0);
    const duration = Number(c.duration) > 0 ? Number(c.duration) : end || 1;
    const n = Math.max(2, Math.round(duration * 60) + 1);
    const times = Float32Array.from({ length: n }, (_, i) => (duration * i) / (n - 1));
    for (const [name, control] of Object.entries(c.bones)) {
      const j = index.get(name) ?? index.get(joints.find((x) => jointNodeName(x.name) === jointNodeName(name))?.name);
      if (j === undefined || !control) continue;
      const node = jointNodeName(joints[j].name);
      const { pre, post, rest, move } = place[j];
      const turn = (qOff, q) => { q.copy(pre).multiply(qOff); if (post) q.multiply(post); return q; };
      if (Array.isArray(control.quat)) {
        const values = new Float32Array(n * 4);
        const q = new THREE.Quaternion(), qOff = new THREE.Quaternion();
        for (let i = 0; i < n; i += 1) {
          const v = sampleQuatTrack(control.quat, times[i]) || [0, 0, 0, 1];
          qOff.set(v[0] || 0, v[1] || 0, v[2] || 0, v[3] ?? 1).normalize();
          turn(qOff, q).toArray(values, i * 4);
        }
        tracks.push(new THREE.QuaternionKeyframeTrack(`${node}.quaternion`, times, values));
      } else if (Array.isArray(control.rot)) {
        const values = new Float32Array(n * 4);
        const q = new THREE.Quaternion(), qOff = new THREE.Quaternion(), e = new THREE.Euler();
        for (let i = 0; i < n; i += 1) {
          const v = sampleTrack(control.rot, times[i]) || [0, 0, 0];
          turn(qOff.setFromEuler(e.set((v[0] || 0) * DEG, (v[1] || 0) * DEG, (v[2] || 0) * DEG, 'XYZ')), q).toArray(values, i * 4);
        }
        tracks.push(new THREE.QuaternionKeyframeTrack(`${node}.quaternion`, times, values));
      }
      if (Array.isArray(control.at)) {
        const values = new Float32Array(n * 3);
        const d = new THREE.Vector3();
        for (let i = 0; i < n; i += 1) {
          const v = sampleTrack(control.at, times[i]) || [0, 0, 0];
          d.set(v[0] || 0, v[1] || 0, v[2] || 0);
          if (move) move(d);
          values[i * 3] = rest.position.x + d.x; values[i * 3 + 1] = rest.position.y + d.y; values[i * 3 + 2] = rest.position.z + d.z;
        }
        tracks.push(new THREE.VectorKeyframeTrack(`${node}.position`, times, values));
      }
      if (control.scale !== undefined && Array.isArray(control.scale)) {
        const values = new Float32Array(n * 3);
        for (let i = 0; i < n; i += 1) {
          const v = sampleTrack(control.scale, times[i]);
          const s = Array.isArray(v) ? v : [v ?? 1, v ?? 1, v ?? 1];
          values[i * 3] = rest.scale.x * (s[0] ?? 1); values[i * 3 + 1] = rest.scale.y * (s[1] ?? 1); values[i * 3 + 2] = rest.scale.z * (s[2] ?? 1);
        }
        tracks.push(new THREE.VectorKeyframeTrack(`${node}.scale`, times, values));
      }
    }
    out.push(new THREE.AnimationClip(c.name, duration, tracks));
  }
  return out;
}

/**
 * What the editor needs to pose a Scene object's rig without its mesh: the joints (name, parent, at, rot), plain data. A rig of the file's
 * own bones (ownRig) also gives each bone's rest frame and where its root bones hang (`frame`), so the editor's copy stands as the file does.
 */
export function rigInfo(bound) {
  if (!bound?.joints?.length) return null;
  const joints = bound.joints.map((j) => ({ name: j.name, parent: j.parent, at: j.at, tail: j.tail, rot: j.rot,
    ...(j.rest ? { rest: j.rest, world: j.world, parentWorld: j.parentWorld, parentInv: j.parentInv } : {}) }));
  return bound.frame ? { joints, frame: bound.frame } : { joints };
}
