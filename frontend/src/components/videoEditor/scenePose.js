/*
 * (rigging) The pose of a Scene object that has a `skeleton` (world3d/rig): the same pose pipeline as a model layer's (modelPose.js
 * applyPose, unchanged), on the Scene's clock, run here on the object's joints alone. The world binds the mesh (its own copy, with the
 * same joints in the same order) and takes the joints' matrices each frame, as it takes a model layer's node matrices
 * (WorldRenderer #setNodePose): Draft skins the mesh, Final traces it skinned.
 *
 * The joints come from the world (WorldRenderer.rigInfo): a template's landmarks may be found from the mesh's shape, which only the world
 * has. The object stands where the Scene puts it at that time (sceneObjectMatrix), in the editor's 3D space like a model layer (one
 * composition pixel a millimetre), so a pose's targets, offsets and reports mean the same as on a model layer.
 */
import * as THREE from 'three';
import { makePoseRig, applyPose, sceneObjectMatrix, metresToEditor, poseInfo } from './modelPose.js';
import { buildBones, rigClips } from '../../world3d/rig/bind.js';

const MM = new THREE.Matrix4().makeScale(1000, 1000, 1000);

/** One poser per world: the objects' joint copies, made once per skeleton and kept while it stays the same. */
export function createScenePoser() {
  const held = new Map();

  function entryFor(o, info) {
    const key = JSON.stringify([info.joints, o.skeleton?.clips ?? null]);
    let e = held.get(o.id);
    if (e && e.key === key) return e;
    const root = new THREE.Object3D();
    root.matrixAutoUpdate = false;
    const { container } = buildBones(info.joints);
    root.add(container);
    const clips = rigClips(o.skeleton, info.joints);
    e = { key, root, container, rig: makePoseRig(root, clips, null), history: new Map(), warnings: [], info };
    held.set(o.id, e);
    return e;
  }

  /**
   * Every posed object at Scene time `time`: { nodePoses: { id: Float32Array }, attachments: Map(id → { matrix, weight }) }.
   * `infoOf(id)` is the world's rig info for an object (null until its build has bound it).
   */
  function pose(scene, time, infoOf) {
    const nodePoses = {};
    const attachments = new Map();
    const objects = Array.isArray(scene?.objects) ? scene.objects : [];
    const live = new Set();
    for (const o of objects) {
      if (!o || !o.skeleton || !o.pose || typeof o.pose !== 'object') continue;
      const info = infoOf(o.id);
      if (!info?.joints?.length) continue;
      live.add(o.id);
      const e = entryFor(o, info);
      // where the Scene puts the object now, in the editor's space
      const m = sceneObjectMatrix(scene, o.id, time) || new THREE.Matrix4();
      e.root.matrix.copy(m).premultiply(MM);
      e.root.matrixWorldNeedsUpdate = true;
      const point = (ref, t) => {
        if (Array.isArray(ref) && ref.length === 3 && ref.every(Number.isFinite)) return new THREE.Vector3(ref[0] * 1000, ref[1] * 1000, ref[2] * 1000);
        if (typeof ref === 'string') {
          const mm = sceneObjectMatrix(scene, ref.replace(/^@/, ''), Number.isFinite(t) ? t : time);
          if (mm) return new THREE.Vector3().setFromMatrixPosition(metresToEditor(mm));
        }
        return null;
      };
      const ctx = {
        sceneRef: scene,
        resolve: (ref, t) => point(ref, t),
        resolveMatrix: (ref, t) => {
          if (typeof ref !== 'string') return null;
          const mm = sceneObjectMatrix(scene, ref.replace(/^@/, ''), Number.isFinite(t) ? t : time);
          if (!mm) return null;
          const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
          metresToEditor(mm).decompose(p, q, s);
          return mm.compose(p, q, s.set(1, 1, 1));
        },
        attach: (id, matrix, w) => {
          if (id === o.id || !objects.some((x) => x?.id === id)) return false;
          attachments.set(id, { matrix: matrix.toArray(), weight: w });
          return true;
        },
      };
      const result = applyPose(e.rig, o.pose, time, ctx, null);
      e.warnings = result.warnings;
      e.history.delete(Math.round(time * 1e4));
      e.history.set(Math.round(time * 1e4), e.rig.solved);
      if (e.history.size > 64) e.history.delete(e.history.keys().next().value);
      const list = [];
      e.container.traverse((n) => list.push(n));
      const out = new Float32Array(list.length * 16);
      list.forEach((n, i) => { n.updateMatrix(); n.matrix.toArray(out, i * 16); });
      nodePoses[o.id] = out;
    }
    for (const id of held.keys()) if (!live.has(id)) held.delete(id);
    return { nodePoses, attachments };
  }

  /** What an agent needs for one posed object: its joints and clips, what the last pose warned about, what its constraints reached at `time`. */
  function report(id, time = null) {
    const e = held.get(id);
    if (!e) return null;
    const at = Number.isFinite(time) ? e.history.get(Math.round(time * 1e4)) : null;
    return { ...poseInfo(e.rig), warnings: e.warnings || [], solved: at || e.rig.solved || [] };
  }

  return { pose, report, ids: () => [...held.keys()] };
}
