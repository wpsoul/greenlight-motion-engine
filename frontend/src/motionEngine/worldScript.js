// (motion3d) A scene script's `world` → a 3D Scene layer's Rig: the fields, the ready camera moves and the strict check. Its own module
// so the 3D plugin's standalone player (motionEngine3d/player.js) compiles a script's `world` exactly as build_video and `script` do,
// without the 2D converter. Pure data.
// The strict check (the Scene schema: world3d/schema/validate.js validateRig, the same answers the GreenLight Dash server gives) is
// handed in by the caller, so the 3D player compiles a `world` without carrying the schema (a script's `world` was checked when built).

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const r3 = (v) => +(+v).toFixed(3);
const near = (want, list) => {
  const w = String(want || '').toLowerCase();
  const hits = list.filter((x) => x.toLowerCase().includes(w.slice(0, 4)) || w.includes(x.toLowerCase().slice(0, 4)));
  return hits.length ? ` (did you mean ${hits.slice(0, 4).map((h) => `"${h}"`).join(', ')}?)` : '';
};

// ── A 3D Scene in the script ───────────────────────────────────────────────────────────────────────────────────────────
// `world`: { scene (rig.scene: objects, materials, lights, camera, env…), render? (rig.render: mode draft | final, spp …), look?,
// exposure?, camera? (a move written as the scene camera's keys), duration? }. Simple scenes: the chat page and the npm engine carry
// the world (about 9 MB of code) but no files of the user's beyond links, so geometry comes from ops, looks from materials and the
// bundled HDR presets.
export const WORLD_FIELDS = ['scene', 'render', 'look', 'exposure', 'camera', 'duration'];
export const WORLD_MOVES = ['orbit', 'push-in', 'pull-out', 'rise', 'slide-left', 'slide-right'];
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A move of the scene camera over the whole clip, as keys on `at` (and `target` for a slide). */
function worldMove(scene, move, D, problems) {
  const m = typeof move === 'string' ? { move } : move;
  if (!isPlain(m) || !WORLD_MOVES.includes(m.move)) {
    const got = typeof m?.move === 'string' ? `world.camera.move: "${m.move}" is not a move — ` : 'world.camera: ';
    problems.push(`${got}{ "move": ${WORLD_MOVES.map((x) => `"${x}"`).join(' | ')}, "amount"? } (or leave it out and key scene.camera yourself)${typeof m?.move === 'string' ? near(m.move, WORLD_MOVES) : ''}`);
    return null;
  }
  const cam = scene.camera;
  if (!isPlain(cam) || !Array.isArray(cam.at) || !Array.isArray(cam.target)) { problems.push('world.camera: a move needs scene.camera with "at" and "target" (where it starts and what it looks at)'); return null; }
  if (cam.keys?.at || cam.keys?.target) { problems.push('world.camera: a move writes the camera\'s keys; scene.camera.keys already has them — one or the other'); return null; }
  const [ax, ay, az] = cam.at.map(Number); const [tx, ty, tz] = cam.target.map(Number);
  const dx = ax - tx, dz = az - tz, dist = Math.hypot(ax - tx, ay - ty, az - tz) || 1;
  const n = 6, keys = { at: [] };
  const amount = num(m.amount, m.move === 'orbit' ? 40 : 0.25);
  for (let i = 0; i <= n; i += 1) {
    const u = i / n, e = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;   // one smooth in-out over the clip
    let at = [ax, ay, az], target = null;
    if (m.move === 'orbit') {
      const a = ((e - 0.5) * amount * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      at = [tx + dx * c + dz * s, ay, tz - dx * s + dz * c];
    } else if (m.move === 'push-in' || m.move === 'pull-out') {
      const k = (m.move === 'push-in' ? e : 1 - e) * clamp(amount, 0, 0.9);
      at = [ax - (ax - tx) * k, ay - (ay - ty) * k, az - (az - tz) * k];
    } else if (m.move === 'rise') {
      at = [ax, ay + (e - 0.5) * amount * dist, az];
    } else {
      const side = m.move === 'slide-left' ? -1 : 1, len = Math.hypot(dx, dz) || 1;
      const off = (e - 0.5) * amount * dist * side, rx = dz / len, rz = -dx / len;   // the camera's right, level
      at = [ax + rx * off, ay, az + rz * off];
      target = [tx + rx * off, ty, tz + rz * off];
    }
    keys.at.push({ t: r3(u * D), v: at.map(r3) });
    if (target) (keys.target ||= []).push({ t: r3(u * D), v: target.map(r3) });
  }
  for (const track of Object.values(keys)) for (const k of track.slice(0, -1)) k.ease = 'linear';   // the smoothing is in the samples
  cam.keys = { ...(cam.keys || {}), ...keys };
  // what the build answer echoes: the move and the amount it used
  return `${m.move} ${m.move === 'orbit' ? `${r3(amount)}°` : m.move.startsWith('push') || m.move.startsWith('pull') ? `${r3(clamp(amount, 0, 0.9))} of the distance` : `${r3(amount)} of the distance`}`;
}

export function compileWorld(w, total, problems, warnings, validateRig = null) {
  if (!isPlain(w)) { problems.push('world must be an object: { "scene": { objects, materials, lights, camera, env }, "render"?, "look"?, "camera"? }'); return null; }
  for (const k of Object.keys(w)) if (!WORLD_FIELDS.includes(k)) problems.push(`world: unknown field "${k}" (${WORLD_FIELDS.join(', ')})${near(k, WORLD_FIELDS)}`);
  if (!isPlain(w.scene)) { problems.push('world.scene must be an object: { objects, materials, lights, camera, env } (get_motion_reference "world3d")'); return null; }
  // with scenes the world lasts the whole video (their total); `duration` counts only for a world on its own
  const duration = total != null ? clamp(total, 1, 60) : clamp(num(w.duration, 6), 1, 60);
  if (total != null && w.duration != null && Math.abs(num(w.duration, total) - total) > 0.05) {
    warnings.push(`world.duration ${w.duration} s is not used: with scenes the 3D Scene lasts the whole video (${r3(total)} s, the scenes' total)`);
  }
  const scene = JSON.parse(JSON.stringify(w.scene));
  const move = w.camera != null ? worldMove(scene, w.camera, duration, problems) : null;
  const rig = { renderer: 'world', lights: [], cyclorama: { shape: 'none' }, scene,
    ...(w.render != null ? { render: w.render } : {}), ...(w.look != null ? { look: w.look } : {}), ...(w.exposure != null ? { exposure: w.exposure } : {}) };
  const check = validateRig ? validateRig(rig, { path: 'world' }) : { errors: [], warnings: [] };
  // what the script did not write itself (renderer, lights, cyclorama) cannot be the agent's mistake
  for (const e of check.errors) problems.push(`${e.path}: ${e.message}`);
  for (const x of check.warnings) warnings.push(`${x.path}: ${x.message}`);
  return { rig, duration, move, mode: rig.render?.mode === 'final' ? 'final' : 'draft', objects: Array.isArray(scene.objects) ? scene.objects.length : 0, lights: Array.isArray(scene.lights) ? scene.lights.length : 0 };
}

