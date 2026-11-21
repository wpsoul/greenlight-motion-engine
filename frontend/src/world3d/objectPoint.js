// (camlayer) Where a Scene object's origin stands at a time, in metres, as the world places it: its keys and their ƒx, its drives on
// the Scene's clocks, a follow path, and its parents' (keys.js objectPose, the pose WorldRenderer.applyTime gives the node). An imported
// object stands at its `matrix`, its `at` moving it from there. Pure maths (no three), so the editor's Camera layer (a look-at, a path's
// or a rig's aim, a focus held on an object: "@id") and the node shot evaluator read one definition.
import { objectPose } from './keys.js';
import { composeTRS, multiply } from './mat.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function quatMatrix(pose) {
  const [x, y, z, w] = pose.quat;
  const s = Array.isArray(pose.scale) ? pose.scale.map((v) => num(v, 1)) : [num(pose.scale, 1), num(pose.scale, 1), num(pose.scale, 1)];
  const a = pose.at || [0, 0, 0];
  return new Float64Array([
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    num(a[0]), num(a[1]), num(a[2]), 1]);
}

/** The object's world matrix at scene time `t` (column-major), or null when the Scene has no object `id`. */
export function objectWorldMatrix(scene, id, t = 0) {
  const objects = Array.isArray(scene?.objects) ? scene.objects : [];
  const byId = new Map(objects.filter((o) => o && o.id != null).map((o) => [String(o.id), o]));
  const walk = (oid, depth) => {
    const o = byId.get(String(oid));
    if (!o || depth > 32) return null;
    const pose = objectPose(o, t, scene);
    let m = pose.quat ? quatMatrix(pose) : composeTRS(pose.at, pose.rot, pose.scale ?? 1);
    // an import's placement: its own matrix, moved by `at` and turned about its origin by `rot`
    if (Array.isArray(o.matrix) && o.matrix.length === 16) {
      const at = pose.at || [0, 0, 0];
      const k = Float64Array.from(o.matrix.map((v) => num(v)));
      m = multiply(composeTRS([num(at[0]) + k[12], num(at[1]) + k[13], num(at[2]) + k[14]], pose.rot, pose.scale ?? 1),
        Float64Array.from([k[0], k[1], k[2], 0, k[4], k[5], k[6], 0, k[8], k[9], k[10], 0, 0, 0, 0, 1]));
    }
    if (o.parent != null && byId.has(String(o.parent))) {
      const p = walk(o.parent, depth + 1);
      if (p) m = multiply(p, m);
    }
    return m;
  };
  return walk(id, 0);
}

/** The object's origin at scene time `t`: [x, y, z] metres, or null. */
export function objectWorldPoint(scene, id, t = 0) {
  const m = objectWorldMatrix(scene, id, t);
  return m ? [m[12], m[13], m[14]] : null;
}
