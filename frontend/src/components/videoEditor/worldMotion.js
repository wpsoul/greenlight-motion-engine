/*
 * Motion the export's motion blur cannot see in the layers' own transforms (engine/exporter.js frameHasMotion): what moves inside a
 * Scene's world, the Rig's own keyframes, letters a Text Animator moves, and a model layer's own GLB clips. A frame whose shutter holds
 * any of it renders as sub-frames; a frame where all of it rests keeps its single render.
 *
 * Pure: a track's evaluation and what the world runs by itself (bodies, a .blend's baked playback) come in as arguments, so the node
 * tests can load it. A Scene's own tracks are sampled as the world samples them (world3d/keys.js), handed in by the export when the
 * project has a Scene: this file imports nothing of the world, so a 2D project loads none of it.
 */
import { KF_PREFIX as TXA_KF_PREFIX, liveAnimators, animatorsMove, motionKey } from './textAnimators.js';

const EPS = 1e-6;

const differs = (a, b) => {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return true;
    return a.some((v, i) => Math.abs(v - b[i]) > EPS);
  }
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) > EPS;
  return a !== b;
};

/** A scene track moves between t0 and t1. It holds before its first key and after its last, so a shutter outside them sees nothing;
 *  the middle is sampled too, for a move that comes back to where it was. Without the world's sampler, anywhere between its keys. */
function trackMoves(track, t0, t1, sample) {
  if (!Array.isArray(track) || track.length < 2) return false;
  const first = Math.min(...track.map((k) => k.t)), last = Math.max(...track.map((k) => k.t));
  if (t1 <= first || t0 >= last) return false;
  if (!sample) return true;
  const a = sample(track, t0);
  return differs(a, sample(track, t1)) || differs(a, sample(track, (t0 + t1) / 2));
}

/**
 * Whether the Scene's world moves between t0 and t1 (`rig.scene`, frontend/src/world3d/README.md): an object's (its shape keys too), a flat
 * layer's or the camera's keys, sims while their clip runs (particles, smoke, cloth, liquids and the rest), bodies and a .blend's baked playback. `runtime(t0, t1)` asks
 * the built world about bodies and baked playback (world3dLayer.js worldMovesBetween); without an answer they count as moving while
 * they can. `sampleTrack(track, t)` is world3d/keys.js's.
 */
export function sceneMovesBetween(scene, t0, t1, { runtime = null, sampleTrack = null, poseMoves = null, fieldsMove = null } = {}) {
  if (!scene || typeof scene !== 'object') return false;
  const keysMove = (keys, fields) => !!keys && fields.some((f) => trackMoves(keys[f], t0, t1, sampleTrack));
  // (animtools) an item with a drive on the scene's clocks, an ƒx on its keys or a follow path: sampled as the world samples it
  // (world3d/keys.js fieldsMoveBetween, handed in by the export: a clock's glide runs on past its last key, a spring rings past its
  // key); without it such an item counts as moving
  const itemMoves = (item, fields) => {
    if (!item) return false;
    if (item.drive || item.fx || item.path) return fieldsMove ? fieldsMove(item, fields, t0, t1, scene) : true;
    return keysMove(item.keys, fields);
  };
  // (cameras) an orthographic frame keyed bigger or smaller, a keyed lens shift: the picture moves as with a zoom
  // (mblur2) and a focus pull or an aperture keyed inside the shutter (the trace takes each sample's focus at its time); (mblur6) and a tilted
  // lens's lean (`tilt`: its plane of focus at each sample's time)
  if (itemMoves(scene.camera, ['at', 'target', 'fov', 'lens', 'orthoHeight', 'shift', 'focus', 'fStop', 'tilt'])) return true;
  const byId = new Map((scene.objects || []).map((o) => [o?.id, o]));
  for (const l of scene.layers2d || []) {
    if (itemMoves(l, ['at', 'rot'])) return true;
    // (animtools) a card on a parent moves with it
    for (let p = byId.get(l?.parent), hops = 0; p && hops < 32; p = byId.get(p.parent), hops += 1) if (itemMoves(p, ['at', 'rot', 'scale'])) return true;
  }
  let bodies = false, baked = false;
  for (const o of scene.objects || []) {
    if (!o) continue;
    // shape keys (`keys['shape:<name>']`, world3d/ops/shapeKeys.js) bend the mesh itself, and blur like any other move
    const shapes = [...new Set([...Object.keys(o.keys || {}), ...Object.keys(o.drive || {})].filter((k) => k.startsWith('shape:')))];
    if (itemMoves(o, ['at', 'rot', 'scale', ...shapes])) return true;
    // (mblur2) a rigged object's pose (its clips, keys and targets: modelPose.js poseMayMove, handed in by the export) bends the mesh
    if (o.skeleton && o.pose && poseMoves?.(o.pose, t0, t1)) return true;
    if (o.rigid && !(o.rigid.fixed)) bodies = true;
    if (o.track || o.bent || o.remade || o.grains || o.flock) baked = true;
  }
  // a sim moves while its clip runs (a recipe without its own clip may run the whole shot)
  for (const s of scene.sims || []) {
    if (!s) continue;
    const start = Number(s.clip?.start ?? s.start) || 0, dur = Number(s.clip?.duration ?? s.duration);
    if (t1 > start && t0 < (dur > 0 ? start + dur : Infinity)) return true;
  }
  if (scene.volumes?.length) return true;
  if (baked && scene.anim) {
    const end = (Math.max(1, Number(scene.anim.frames) || 1) - 1) / Math.max(1, Number(scene.anim.fps) || 24);
    if (t1 <= 0 || t0 >= end) baked = false;
  } else baked = false;
  // (mblur5) a texture graph keyed by its own `keys` or alive in time (the animated presets: a sweep, a pulse): the built world says whether
  // its maps change (WorldRenderer.movesBetween); a still graph does not move the frame
  const graphs = Object.values(scene.materials || {}).some((m) => m && typeof m === 'object' && m.graph && typeof m.graph === 'object');
  if (!bodies && !baked && !graphs) return false;
  return runtime?.(t0, t1) !== false;
}

/** Whether the Rig's own keyframes (`sc:` / `scc:`, resolved by frameQueries.js activeRigAt) change its lights, set or environment between
 *  two resolved rigs. A rig with no tracks resolves to the same object both times. (mblur6) And the numbers of a Scene material's texture
 *  graph (`sc:g~<material>:<param>`, folded into `scene.materials.<id>.graph`): a band keyed across a wall by hand moved with blur off. */
export function rigKeysMove(a, b) {
  if (a === b || !a || !b) return a !== b;
  const graphs = (r) => Object.entries(r.scene?.materials || {}).filter(([, m]) => m && typeof m === 'object' && m.graph && typeof m.graph === 'object').map(([id, m]) => [id, m.graph]);
  return JSON.stringify([a.lights, a.cyclorama, a.env, graphs(a)]) !== JSON.stringify([b.lights, b.cyclorama, b.env, graphs(b)]);
}

/** (mblur3) Whether the Rig's own keyframes change anything but its lights' colour, strength or place between two resolved rigs: the set
 *  (cyclorama), the environment, or which lights there are (one added, removed, of another type, switched on or off). A world Scene relights
 *  the rest at each of the shutter's times. (mblur4) The environment's strength and turn (`rotY`), an Ambient's or a Hemisphere's colour and
 *  strength (they tint and strengthen the environment) and the backdrop's colour are relit there too: the trace reads the map and the paint
 *  at each sample's time. (engine100b) The backdrop's place, turn and scale are its mesh's pose, posed at each of those times
 *  (world3dLayer.js withBackdropAt), and the map's turn about X or Z is not the world's at all (it turns the map about Y alone,
 *  world3dScene.js): neither sends the frame to the sub-frames. Nor does its exposure: each sample's light is weighed by the exposure at
 *  its time (the tracer's mbExposure, Draft's shutter average), nor the backdrop's opacity (Draft relights each draw with it, the trace reads
 *  it at each path's time: tracerMotion.js mbPaintAlpha). The map or its tint keyed, and the set's shape, still do. */
export function rigKeysMoveBeyondLights(a, b) {
  if (a === b || !a || !b) return a !== b;
  const envRest = (e) => {
    if (!e || typeof e !== 'object') return e ?? null;
    const { intensity: _i, rotY: _r, rotX: _x, rotZ: _z, exposure: _e, ...rest } = e;
    return rest;
  };
  const cycRest = (c) => {
    if (!c || typeof c !== 'object') return c ?? null;
    const { color: _c, ...material } = c.material && typeof c.material === 'object' ? c.material : {};
    // (engine100b) nor its opacity: Draft relights each of its draws with it, the trace reads it at each path's time
    delete material.opacity;
    const { x: _px, y: _py, z: _pz, rotX: _rx, rotY: _ry, rotZ: _rz, scale: _s, ...set } = c;
    return { ...set, material };
  };
  if (JSON.stringify([cycRest(a.cyclorama), envRest(a.env)]) !== JSON.stringify([cycRest(b.cyclorama), envRest(b.env)])) return true;
  const la = Array.isArray(a.lights) ? a.lights : [], lb = Array.isArray(b.lights) ? b.lights : [];
  if (la.length !== lb.length) return true;
  for (let i = 0; i < la.length; i += 1) {
    const x = la[i], y = lb[i];
    if (x?.lid !== y?.lid || x?.type !== y?.type || (x?.on !== false) !== (y?.on !== false)) return true;
  }
  return false;
}

/**
 * Whether a text layer's Text Animators move its letters between t0 and t1 (times on the timeline; `start` is where the item starts). The
 * same rules as the plate's motion key (textAnimators.js motionKey): Flow, Wiggle, Scramble, a blinking caret and a voice cascade are
 * always moving; a Time cascade moves while one of its units is in flight; a keyed animator moves while one of its tracks changes.
 * `evalTrack(track, pct)` is the editor's (gsapTransitions.js evaluatePropertyTrack).
 */
export function textAnimatorsMoveBetween(item, start, t0, t1, evalTrack) {
  const list = liveAnimators(item?.textAnimators);
  if (!list) return false;
  const pk = item.propertyKeyframes || {};
  const tracksOf = (aid) => Object.keys(pk).filter((k) => k.startsWith(`${TXA_KF_PREFIX}${aid}:`) && Array.isArray(pk[k]) && pk[k].length);
  if (!animatorsMove(list, (aid) => tracksOf(aid).length > 0)) return false;
  const span = Math.max(0, (Number(item.trimEnd) || 0) - (Number(item.trimStart) || 0));
  const local = (t) => Math.max(0, span > 0 ? Math.min(span, t - start) : t - start);
  const a = local(t0), b = local(t1);
  if (a === b) return false;
  const text = String(item.textContent ?? '');
  const counts = {
    chars: Array.from(text).length, charsNoSpace: Array.from(text).filter((c) => c.trim()).length,
    words: text.split(/\s+/).filter(Boolean).length, lines: text.split('\n').length,
  };
  const pct = (t) => (span > 0 ? (t / span) * 100 : 0);
  for (const an of list) {
    const on = an.effects.filter((e) => e && e.enabled !== false);
    if (!on.length) continue;
    const r = an.range || {};
    if (r.drive === 'voice' || r.flow || (an.wiggle?.enabled && an.wiggle.rate > 0)) return true;
    if (on.some((e) => (e.type === 'caret' && e.blink > 0) || (e.type === 'scramble' && e.rate > 0))) return true;
    if (r.drive === 'time') {
      const key = (t) => motionKey([an], null, { time: t, clipSec: span, units: [], counts, voice: null });
      const ka = key(a), kb = key(b);
      if (typeof ka === 'number' || typeof kb === 'number' || ka !== kb) return true;
    }
    for (const k of tracksOf(an.aid)) {
      const va = evalTrack(pk[k], pct(a)), vb = evalTrack(pk[k], pct(b)), vm = evalTrack(pk[k], pct((a + b) / 2));
      if (differs(va, vb) || differs(va, vm)) return true;
    }
  }
  return false;
}

// A clip's own time for the layer's time, by its loop mode: the same as model3dLayer.js modelClipTime. 'once' stops a hair before the end.
function clipTime(t, dur, mode) {
  if (!(dur > 0)) return 0;
  if (mode === 'loop') return ((t % dur) + dur) % dur;
  if (mode === 'pingpong') {
    const cycle = ((t % (dur * 2)) + dur * 2) % (dur * 2);
    return cycle <= dur ? cycle : dur * 2 - cycle;
  }
  return Math.max(0, Math.min(dur - 1e-4, t));
}

// A keyframe track's values at a time, linearly between its keys (enough to tell whether it changes): [] for an empty track.
function sampleKeys(track, t) {
  const times = track?.times, values = track?.values;
  if (!times?.length || !values?.length) return [];
  const stride = values.length / times.length;
  let i = 0;
  while (i < times.length - 1 && times[i + 1] <= t) i += 1;
  const j = Math.min(times.length - 1, i + 1);
  const k = j > i && times[j] > times[i] ? Math.max(0, Math.min(1, (t - times[i]) / (times[j] - times[i]))) : 0;
  const out = new Array(stride);
  for (let c = 0; c < stride; c += 1) out[c] = values[i * stride + c] + (values[j * stride + c] - values[i * stride + c]) * k;
  return out;
}

/**
 * Whether a model layer's own GLB clips move it between two times on the layer's clock (seconds since it starts), `animation` being its
 * `model3dConfig.animation` ({ clip, speed, offset, loop }) and `clips` the file's clips (model3dLayer.js modelAnimationClips; their
 * `tracks` with `times` and `values`). A clip that holds still there (a 'once' clip past its end, keys that do not change, speed 0) is
 * still. Before the file has loaded the clips are unknown, and a clip that is asked to play counts as moving.
 */
export function modelClipMovesBetween(animation, clips, a, b) {
  const name = animation?.clip;
  if (!name) return false;
  const speed = Number.isFinite(animation.speed) ? animation.speed : 1;
  if (speed === 0) return false;
  if (!Array.isArray(clips)) return true;
  const offset = Number.isFinite(animation.offset) ? animation.offset : 0;
  const mode = animation.loop || 'loop';
  const playing = name === '*' ? clips : clips.filter((c) => c?.name === name).slice(0, 1);
  for (const c of playing) {
    const dur = c.duration || 0;
    const at = (t) => clipTime(t * speed + offset, dur, mode);
    const ta = at(a), tb = at(b), tm = at((a + b) / 2);
    if (ta === tb && ta === tm) continue;
    for (const track of c.tracks || []) {
      const va = sampleKeys(track, ta);
      if (differs(va, sampleKeys(track, tb)) || differs(va, sampleKeys(track, tm))) return true;
    }
  }
  return false;
}
