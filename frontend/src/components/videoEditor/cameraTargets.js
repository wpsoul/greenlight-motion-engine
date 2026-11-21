// (camlayer) A 3D Scene object as something the Camera layer aims at, orbits, follows, focuses on or zooms to: "@<object id>" wherever the
// camera names a target (cameraLookAt, cameraFocusOn, cameraPath.targetId, cameraRig.center and .targets, a zoom range's target). It
// resolves to where the object's origin stands at that moment (world3d/objectPoint.js: its keys, drives, path and parents, on the Scene
// clip's own clock), in the camera's world pixels (x right, y up, z toward the viewer; one metre is 1000 px, world3dScene.js
// WORLD_UNITS). The Scene is the Scene layer on screen then: the clip under the playhead, else the nearest one (it holds its first
// frame before its clip and its last after), as rig3d.js resolveRigAt picks the world's Scene.
import { objectWorldPoint } from '../../world3d/objectPoint.js';

/** "@green" → "green"; anything else → null (a timeline item id, a point, nothing). */
export function sceneTargetId(ref) {
  return typeof ref === 'string' && ref.length > 1 && ref[0] === '@' ? ref.slice(1) : null;
}

const finite = (v) => Number.isFinite(Number(v));

/** A point written as { x, y, z } world px (as a path's points are). */
export function pointTarget(ref) {
  return ref && typeof ref === 'object' && !Array.isArray(ref) && finite(ref.x) && finite(ref.y) && finite(ref.z)
    ? { x: Number(ref.x), y: Number(ref.y), z: Number(ref.z) } : null;
}

/** The Scene layer the world shows at timeline `time`, and the Scene's own time then: { scene, sceneTime } or null. */
export function sceneAtTime(channels, clipsMap, layoutFor, time) {
  let hit = null, nearest = null, gap = Infinity;
  for (const channel of channels || []) {
    const layout = layoutFor(channel);
    if (!layout) continue;
    (channel.items || []).forEach((item, i) => {
      const e = layout[i];
      if (!e || clipsMap.get(item?.clipId)?.mediaType !== 'rig' || !item.rig?.scene) return;
      if (time >= e.startTime && time <= e.endTime) { if (!hit) hit = { item, e }; return; }
      const g = time < e.startTime ? e.startTime - time : time - e.endTime;
      if (g < gap || (g === gap && nearest && e.startTime < nearest.e.startTime)) { gap = g; nearest = { item, e }; }
    });
  }
  const pick = hit || nearest;
  if (!pick) return null;
  const span = Math.max(0, pick.e.endTime - pick.e.startTime);
  return { scene: pick.item.rig.scene, sceneTime: Math.max(0, Math.min(span, time - pick.e.startTime)), span, itemId: pick.item.id };
}

/** Where Scene object `id` stands at timeline `time`, in world px ({ x, y, z }), or null when no Scene shows one. */
export function sceneObjectPointPx(channels, clipsMap, layoutFor, time, id) {
  const at = sceneAtTime(channels, clipsMap, layoutFor, time);
  const p = at ? objectWorldPoint(at.scene, id, at.sceneTime) : null;
  return p ? { x: p[0] * 1000, y: p[1] * 1000, z: p[2] * 1000 } : null;
}

/** A target as saved: a string (≤ 120 characters: "@<object id>" or a timeline item id) or a point { x, y, z } (world px); null
 *  for anything else. */
export function sanitizeCameraRef(ref) {
  if (typeof ref === 'string') return ref.trim() ? ref.trim().slice(0, 120) : null;
  const p = pointTarget(ref);
  return p ? { x: Math.round(p.x * 1e3) / 1e3, y: Math.round(p.y * 1e3) / 1e3, z: Math.round(p.z * 1e3) / 1e3 } : null;
}

/** (camlayer) A 3D Scene's objects as camera targets ({ value: "@<id>", label }), from the project's Scene layers, each id once. */
export function sceneTargetOptions(channels) {
  const out = [];
  const seen = new Set();
  for (const ch of channels || []) {
    if (ch?.kind !== 'rig') continue;
    for (const it of ch.items || []) {
      for (const o of it?.rig?.scene?.objects || []) {
        if (o?.id == null) continue;
        const id = String(o.id);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ value: `@${id}`, label: typeof o.name === 'string' && o.name ? o.name : id });
      }
    }
  }
  return out;
}
