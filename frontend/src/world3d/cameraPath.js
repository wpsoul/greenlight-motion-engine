// A Scene camera's move checked over the whole clip with no render: the camera's keys sampled a few times against each object's box.
// Pure math (no three), so the render page, the engine's critique and the tests share it.
import { sampleField, objectPose, isAnimated } from './keys.js';
import { lensOf, inLensFrame, sceneFov } from './lens.js';

const r2 = (x) => Math.round(x * 100) / 100;

/** The share of an object's box (world space, { min, max }) the camera has in frame: its eight corners against the view
 *  (inspect.js inFrame's arithmetic, kept here so a page does not load the world's modelling code for it). */
/** How far an object's `at` keys (its own and its parents', added up) carry it from where it rests at time t: [dx, dy, dz], or null
 *  when nothing on its chain is keyed on `at`. Turns and scale keys are not followed. (animtools) A drive on `at` and a follow path
 *  carry it too (`scene`: its clocks). */
export function travel(object, byId, t, scene = null) {
  let d = null;
  for (let o = object, n = 0; o && n < 16; o = o.parent != null ? byId.get(o.parent) : null, n += 1) {
    if (!o.keys?.at?.length && !isAnimated(o, ['at'])) continue;
    const p = objectPose(o, t, scene).at || [0, 0, 0], q = o.at || [0, 0, 0];
    d = [(d?.[0] || 0) + p[0] - q[0], (d?.[1] || 0) + p[1] - q[1], (d?.[2] || 0) + p[2] - q[2]];
  }
  return d;
}

export function cornersInFrame(bbox, { at = [0, 0, 5], target = [0, 0, 0], up = [0, 1, 0], fov = 28, aspect = 16 / 9, near = 0.01, far = 1000, projection, orthoHeight, shift }) {
  // (cameras) an orthographic or shifted frame, as the renderer draws it
  const lens = lensOf({ projection, orthoHeight, shift }, { distance: Math.hypot(target[0] - at[0], target[1] - at[1], target[2] - at[2]), fov });
  const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const f = unit([target[0] - at[0], target[1] - at[1], target[2] - at[2]]);
  const r = unit(cross(f, Math.abs(f[1]) > 0.999 ? [0, 0, -1] : up));
  const u = cross(r, f);
  const tan = Math.tan((fov * Math.PI) / 360);
  let inside = 0;
  for (let c = 0; c < 8; c += 1) {
    const dx = (c & 1 ? bbox.max[0] : bbox.min[0]) - at[0];
    const dy = (c & 2 ? bbox.max[1] : bbox.min[1]) - at[1];
    const dz = (c & 4 ? bbox.max[2] : bbox.min[2]) - at[2];
    const depth = dx * f[0] + dy * f[1] + dz * f[2];
    const x = dx * r[0] + dy * r[1] + dz * r[2];
    const y = dx * u[0] + dy * u[1] + dz * u[2];
    if (depth >= near && depth <= far && inLensFrame(depth, x, y, lens, tan, aspect)) inside += 1;
  }
  return inside / 8;
}

/**
 * The move of a Scene camera (`camera`: the scene's own, with `keys` on at / target / fov) from its first key to its last, sampled
 * `samples` times and at every key, against each object's box (`objects`: [{ id, bbox, shift? }], the world's inspect report: boxes
 * where the objects rest; `shift(t)`, for one that travels on `at` keys, its own or a parent's, moves the box with it). Every object
 * wholly in shot at `now` (the frame's time, on the keys' clock) that is not at some sample: when, and how much of its box stays in.
 * The set (an object not wholly in shot at `now`: a floor, a backdrop) is left out. Null with no camera; `moves: false` with no move.
 */
export function cameraPathCheck({ camera, objects, now = 0, aspect = 16 / 9, samples = 9, scene = null } = {}) {
  if (!camera || typeof camera !== 'object') return null;
  const tracks = ['at', 'target', 'fov', 'orthoHeight', 'shift'].map((f) => camera.keys?.[f]).filter((k) => Array.isArray(k) && k.length > 1);
  // (animtools) a driven field moves over its clocks' keys
  const clockKeys = ['at', 'target', 'fov', 'orthoHeight', 'shift'].flatMap((f) => (camera.drive?.[f] == null ? [] : [camera.drive[f]].flat()))
    .map((term) => scene?.clocks?.[term?.clock]?.keys).filter((k) => Array.isArray(k) && k.length > 1);
  tracks.push(...clockKeys);
  const keyTimes = tracks.flatMap((k) => k.map((key) => Number(key.t)).filter(Number.isFinite));
  if (!keyTimes.length) return { moves: false, now: r2(now), leaves: [] };
  const t0 = Math.min(...keyTimes), t1 = Math.max(...keyTimes);
  if (!(t1 - t0 > 1e-3)) return { moves: false, now: r2(now), leaves: [] };
  const times = [...new Set([...Array.from({ length: samples }, (_, i) => t0 + ((t1 - t0) * i) / Math.max(1, samples - 1)), ...keyTimes].map(r2))].sort((a, b) => a - b);
  const view = (t) => ({ at: sampleField(camera, 'at', t, scene) || [0, 1, 3], target: sampleField(camera, 'target', t, scene) || [0, 0, 0],
    // (enginefix4) the view the world films at on this frame: `lens` on its sensor fit's film, or `fov` refitted from its `frame`
    fov: sceneFov({ ...camera, lens: sampleField(camera, 'lens', t, scene) }, sampleField(camera, 'fov', t, scene) ?? 28, aspect), up: camera.up || [0, 1, 0], aspect,
    projection: camera.projection, orthoHeight: sampleField(camera, 'orthoHeight', t, scene), shift: sampleField(camera, 'shift', t, scene) });
  const boxAt = (o, t) => {
    const d = typeof o.shift === 'function' ? o.shift(t) : null;
    return d ? { min: o.bbox.min.map((v, i) => v + d[i]), max: o.bbox.max.map((v, i) => v + d[i]) } : o.bbox;
  };
  const shot = (objects || []).filter((o) => o?.bbox && cornersInFrame(boxAt(o, now), view(now)) === 1);
  const leaves = [];
  for (const o of shot) {
    let worst = null;
    for (const t of times) {
      const inside = cornersInFrame(boxAt(o, t), view(t));
      if (inside < 1 && (!worst || inside < worst.inside)) worst = { id: o.id, t, inside };
    }
    if (worst) leaves.push(worst);
  }
  return { moves: true, now: r2(now), from: r2(t0), to: r2(t1), samples: times.length, checked: shot.map((o) => o.id), leaves };
}
