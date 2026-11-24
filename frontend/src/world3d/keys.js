// Keyframes for scene values. A track is [{ t, v, ease }]; v is a number, an array of numbers or a plain object of numbers, and ease
// shapes the segment that starts at that key. Hold before the first key and after the last, as the editor's tracks do.
//
// (smallfix) `ease` is one of the world's own six below, one of the Video Editor's keyframe easings (the very curve the editor
// plays, components/videoEditor/appEases.js: by its id, `aeSmooth`, or by the name the editor's keys write, `AE Smooth`; `hold`
// steps to the next key), or the editor's Custom curve as [x1, y1, x2, y2] (a CSS cubic-bezier: x the share of the segment's
// time, y of its move; played as the editor plays a Custom key's `bezier`). Anything else plays `inOut`, as before.
//
// (animtools) Motion design on top of the keys, the way a Blender driver rig works (one clock per move, each channel through its own remap):
//   scene.clocks  { <name>: { keys: [{ t, v, ease }], filter: { glide: … } } }: a value (u, usually 0 to 1) keyed on the Scene's clock, run
//                 through any ƒx of the editor (`filter`: Glide is the editor's Glide ƒx, keyframeExpr.js glideValue)
//   drive         on an item, beside `keys`: { <field>: { clock, map: [[u0, v0, ease], [u1, v1, ease], …] } } (or a list of such terms):
//                 the field's value is the clock's value through that remap, whose segments are any of the eases above
//   fx            on an item: { <field>: { glide | elastic | spring | bounce | wiggle | custom: params } }: the editor's ƒx on that field's keys,
//                 the same functions as a 2D layer's (keyframeFxCore.js)
//   path          an object's follow path (followPath.js); `along` and `bank` key and drive like any field
// Keys and drives on one field combine: `scale` multiplies them, every other field adds them (an object that appears on one move and
// leaves on the next: two terms). A field with neither keeps its static value.
import { namedEase } from '../components/videoEditor/appEases.js';
import { bezierEase } from '../components/videoEditor/easingEngine.js';
import { sanitizeBezier } from '../components/videoEditor/easingCurves.js';
import { TransitionEasing } from '../components/videoEditor/types.js';
import { fxConfigOf, fxAtSeconds } from '../components/videoEditor/keyframeFxCore.js';
import { stringSeed, compileExpression, evaluateAst } from '../components/videoEditor/keyframeExpr.js';
import { pathAt, quatAlong, quatFromEulerDeg, quatMul } from './followPath.js';
import { audioClockValue, isAudioClock } from './audioClock.js';

const EASE = {
  linear: (x) => x,
  in: (x) => x * x * x,
  out: (x) => 1 - (1 - x) ** 3,
  inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
  back: (x) => { const c = 1.70158; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; },
  bounce: (x) => {
    const n = 7.5625, d = 2.75;
    if (x < 1 / d) return n * x * x;
    if (x < 2 / d) { x -= 1.5 / d; return n * x * x + 0.75; }
    if (x < 2.5 / d) { x -= 2.25 / d; return n * x * x + 0.9375; }
    x -= 2.625 / d; return n * x * x + 0.984375;
  },
};

// The editor's keyframe easings (types.js TransitionEasing, all but Custom, which is the [x1, y1, x2, y2] form): AE_SMOOTH -> `aeSmooth`,
// APPLE_OUT -> `appleOut`, and the editor's own name ('AE Smooth') too. `linear` stays the world's (the same curve).
const HOLD = () => 0;
const idOf = (key) => key.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const APP = new Map();
const APP_IDS = [], APP_NAMES = [];
// (leftovers2) where each name's curve comes from: the world's own (`linear`) or the editor easing it names ('AE Smooth'), so the curves can
// be written down as data for the server's own sampler (schema/eases.js -> backend/world3d_assets/scene_eases.json, camera_layer.py)
export const easeSources = new Map(Object.keys(EASE).map((id) => [id, { world: id }]));
for (const [key, name] of Object.entries(TransitionEasing)) {
  if (name === TransitionEasing.CUSTOM) continue;
  const fn = name === TransitionEasing.HOLD ? HOLD : namedEase(name);
  if (!fn) continue;
  const id = idOf(key);
  if (!Object.hasOwn(EASE, id)) { APP.set(id, fn); APP_IDS.push(id); easeSources.set(id, { editor: name }); }
  APP.set(name, fn);
  APP_NAMES.push(name);
  easeSources.set(name, { editor: name });
}

// A curve per distinct bezier, as the editor caches its Custom keys (gsapTransitions.js customEase)
const BEZIERS = new Map();
function bezierOf(b) {
  const s = sanitizeBezier(b);
  if (!s) return null;
  const id = s.join(',');
  let fn = BEZIERS.get(id);
  if (!fn) {
    if (BEZIERS.size > 256) BEZIERS.clear();
    fn = bezierEase(...s);
    BEZIERS.set(id, fn);
  }
  return fn;
}

/** The curve a key's `ease` plays: a name (the world's or the editor's) or [x1, y1, x2, y2]; `inOut` for anything else. */
export function easeOf(ease) {
  if (Array.isArray(ease)) return bezierOf(ease) || EASE.inOut;
  if (typeof ease !== 'string') return EASE.inOut;
  return (Object.hasOwn(EASE, ease) ? EASE[ease] : APP.get(ease)) || EASE.inOut;
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// (posefix) a plain object of numbers (a hand's `curl` as { thumb, index, … }) blends key by key: a key whose value is a number on both
// sides blends, any other holds the earlier side's value (the later's when only it has the key)
const lerpObject = (a, b, k) => {
  const out = { ...b, ...a };
  for (const key of Object.keys(out)) if (typeof a[key] === 'number' && typeof b[key] === 'number') out[key] = a[key] + (b[key] - a[key]) * k;
  return out;
};
const lerp = (a, b, k) => (Array.isArray(a) ? a.map((v, i) => v + (b[i] - v) * k)
  : isPlain(a) && isPlain(b) ? lerpObject(a, b, k) : a + (b - a) * k);

export function sampleTrack(track, t) {
  if (!track?.length) return undefined;
  if (t <= track[0].t) return track[0].v;
  const last = track[track.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < track.length - 2 && t >= track[i + 1].t) i += 1;
  const a = track[i], b = track[i + 1];
  const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
  return lerp(a.v, b.v, easeOf(a.ease)(k));
}

/** Shortest-arc unit quaternion [x, y, z, w] track interpolation with eased slerp. */
export function sampleQuatTrack(track, t) {
  if (!track?.length) return undefined;
  const norm = (q) => {
    const x = Number(q?.[0]) || 0, y = Number(q?.[1]) || 0, z = Number(q?.[2]) || 0, w = Number(q?.[3] ?? 1);
    const l = Math.hypot(x, y, z, w) || 1;
    return [x / l, y / l, z / l, w / l];
  };
  if (t <= track[0].t) return norm(track[0].v);
  const last = track[track.length - 1];
  if (t >= last.t) return norm(last.v);
  let i = 0;
  while (i < track.length - 2 && t >= track[i + 1].t) i += 1;
  const a = track[i], b = track[i + 1];
  const u = easeOf(a.ease)((t - a.t) / Math.max(1e-6, b.t - a.t));
  const qa = norm(a.v);
  let qb = norm(b.v);
  let dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3];
  if (dot < 0) { qb = [-qb[0], -qb[1], -qb[2], -qb[3]]; dot = -dot; }
  if (dot > 0.9995) {
    return norm([
      qa[0] + (qb[0] - qa[0]) * u,
      qa[1] + (qb[1] - qa[1]) * u,
      qa[2] + (qb[2] - qa[2]) * u,
      qa[3] + (qb[3] - qa[3]) * u,
    ]);
  }
  const theta0 = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sin0 = Math.sin(theta0);
  const s0 = Math.sin((1 - u) * theta0) / sin0;
  const s1 = Math.sin(u * theta0) / sin0;
  return [
    qa[0] * s0 + qb[0] * s1,
    qa[1] * s0 + qb[1] * s1,
    qa[2] * s0 + qb[2] * s1,
    qa[3] * s0 + qb[3] * s1,
  ];
}

/** (smallfix) A track that switches rather than moves (an object's `visible`): the value of the last key at or before t, the first
 *  key's before it. No ease and no blend: the switch happens at its key's time. */
export function sampleStep(track, t) {
  if (!track?.length) return undefined;
  let v = track[0].v;
  for (const k of track) {
    if (k.t > t) break;
    v = k.v;
  }
  return v;
}

/** (leftovers2) A `visible` key's value that hides (WorldRenderer #keyVisible reads the same). */
export const hidesAt = (v) => v === false || v === 0;

/**
 * (leftovers2) The objects their `visible` keys hide at time t, as the world draws them (a hidden object's children with it): id ->
 * { at: the time of the key that hides it (sampleStep's key: the last at or before t, the first before it), until: the time of the next
 * key that shows it again (null: none), by: the object whose keys hide it, when that is a parent }. An object with no `visible` keys up
 * its chain is not in it; a scene without any gives an empty map. For the reports (inspect, critique): hidden, not out of frame.
 */
export function hiddenByKeys(objects, t) {
  const out = new Map(), own = new Map();
  for (const o of objects || []) {
    const track = o?.keys?.visible;
    if (!track?.length) continue;
    let i = 0;
    for (let k = 0; k < track.length; k += 1) { if (track[k].t > t) break; i = k; }
    if (!hidesAt(track[i].v)) continue;
    let until = null;
    for (let k = i + 1; k < track.length; k += 1) if (!hidesAt(track[k].v)) { until = track[k].t; break; }
    own.set(o.id, { at: track[i].t, until });
  }
  if (!own.size) return out;
  const byId = new Map(objects.map((o) => [o?.id, o]));
  for (const o of objects) {
    for (let p = o, hops = 0; p && hops < 64; p = byId.get(p.parent), hops += 1) {
      const h = own.get(p.id);
      if (h) { out.set(o.id, p === o ? h : { ...h, by: p.id }); break; }
    }
  }
  return out;
}

/** (leftovers2) hiddenByKeys as the reports write it: [{ id, at, until, by? }], times to the millisecond. */
export function hiddenByKeysList(objects, t) {
  const ms = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
  return [...hiddenByKeys(objects, t)].map(([id, h]) => ({ id, at: ms(h.at), until: ms(h.until), ...(h.by != null ? { by: h.by } : null) }));
}

// ── (animtools) clocks, drives, ƒx on keys, follow path ─────────────────────────────────────────────────────────────────

// a field's own step, for Wiggle's default amplitude (ten steps, as the editor's): a centimetre, two degrees, two percent of scale
const FIELD_STEP = { at: 0.001, target: 0.001, rot: 0.2, scale: 0.002, fov: 0.05, lens: 0.1, focus: 0.001, along: 0.001, bank: 0.2, u: 0.001 };
// the fields whose static value lives on the object's `path`
const PATH_FIELDS = new Set(['along', 'bank']);

const fxCache = new WeakMap();
/** An item's ƒx spec ({ glide: 'soft' }, ...) made whole (keyframeFxCore.js fxConfigOf), cached per spec object. Null: none or not one. */
export function fxOf(spec, field = '') {
  if (!spec || typeof spec !== 'object') return null;
  let byField = fxCache.get(spec);
  if (!byField) { byField = new Map(); fxCache.set(spec, byField); }
  if (!byField.has(field)) byField.set(field, fxConfigOf(spec, { step: FIELD_STEP[field] ?? (field.startsWith('shape:') ? 0.002 : 0.01) }));
  return byField.get(field);
}

const componentKeys = new WeakMap();
/** A track's keys as fxAtSeconds reads them: [{ t, v }] with v one number (component `i` of a vector track). */
function keysOf(track, i) {
  let per = componentKeys.get(track);
  if (!per) { per = new Map(); componentKeys.set(track, per); }
  if (!per.has(i)) per.set(i, track.map((k) => ({ t: Number(k?.t) || 0, v: Array.isArray(k?.v) ? Number(k.v[i]) : Number(k?.v) })));
  return per.get(i);
}

/** A track's value at t through an ƒx (fxOf's config), per component of a vector: what a layer's ƒx does to its track. */
export function sampleTrackFx(track, cfg, t, seedKey = '', opts = {}) {
  const base = sampleTrack(track, t);
  if (!cfg || base === undefined) return base;
  const one = (b, i, valueAt) => fxAtSeconds(cfg, { keys: keysOf(track, i), valueAt, t, base: b, seed: stringSeed(i == null ? seedKey : `${seedKey}|${i}`), ...opts });
  if (!Array.isArray(base)) return typeof base === 'number' ? one(base, null, (s) => sampleTrack(track, s)) : base;
  return base.map((b, i) => (typeof b === 'number' ? one(b, i, (s) => { const v = sampleTrack(track, s); return Array.isArray(v) ? v[i] : v; }) : b));
}

const clockCache = new WeakMap();
const AUDIO_FILTER_SEED = [{ t: 0, v: 0 }];
/** A clock's value at t (`scene.clocks[name]`: its keys or `audio` envelope, then its `filter`), or undefined when the scene has no such clock. */
export function clockAt(clocks, name, t) {
  if (!clocks || typeof clocks !== 'object' || typeof name !== 'string') return undefined;
  const def = clocks[name];
  if (!def || typeof def !== 'object') return undefined;
  const audio = isAudioClock(def);
  const env = audio ? (def._envelope || def.envelope || null) : null;
  let byName = clockCache.get(clocks);
  if (!byName) { byName = new Map(); clockCache.set(clocks, byName); }
  let c = byName.get(name);
  if (!c || c.def !== def || c.keys !== def.keys || c.filter !== def.filter || c.audio !== def.audio || c.env !== env) {
    const keys = Array.isArray(def.keys) && def.keys.length ? def.keys : null;
    c = {
      def, keys: def.keys, filter: def.filter, audio: def.audio, isAudio: audio, env,
      track: keys,
      cfg: (keys || audio) ? fxOf(def.filter, 'u') : null,
    };
    byName.set(name, c);
  }
  let v;
  if (c.isAudio) {
    const rawAt = (s) => audioClockValue(def, s);
    const base = rawAt(t);
    v = c.cfg ? fxAtSeconds(c.cfg, { keys: AUDIO_FILTER_SEED, valueAt: rawAt, t, base, seed: stringSeed(`clock|${name}`) }) : base;
  } else {
    if (!c.track) return undefined;
    v = c.cfg ? sampleTrackFx(c.track, c.cfg, t, `clock|${name}`) : sampleTrack(c.track, t);
  }
  if (Array.isArray(v)) v = Number(v[0]);
  return Number.isFinite(v) ? v : undefined;
}

/** Deterministic audio-clock helper: reads `scene.clocks[clockName]` at time `t` (0 when missing). */
export function sampleSound(scene, clockName, t) {
  const clocks = scene?.clocks && typeof scene.clocks === 'object' ? scene.clocks : scene;
  return clockAt(clocks, clockName, t) ?? 0;
}

const mapCache = new WeakMap();
/** A drive's remap ([[u, v, ease], …], or { u, v, ease } entries) as a track keyed on u. Null: none (the clock's value itself). */
function remapOf(map) {
  if (!Array.isArray(map) || !map.length) return null;
  let track = mapCache.get(map);
  if (!track) {
    track = map.map((e) => (Array.isArray(e) ? { t: Number(e[0]), v: e[1], ease: e[2] } : { t: Number(e?.u), v: e?.v, ease: e?.ease }))
      .filter((k) => Number.isFinite(k.t) && k.v !== undefined).sort((a, b) => a.t - b.t);
    mapCache.set(map, track);
  }
  return track.length ? track : null;
}

/**
 * (animtools) A drive term's expression (a Blender driver's scripted expression): the editor's ƒx language (keyframeExpr.js, the same
 * one a layer's Custom ƒx runs) over its `vars` (each a number, or a clock through its own remap) and `time` (seconds on the Scene's
 * clock). A number, or a list of numbers for a vector field; undefined when it does not parse or run, or a var's clock is missing.
 */
export function exprAt(term, clocks, t, fps = 30) {
  const { ast, error } = compileExpression(term.expr);
  if (error) return undefined;
  const vars = {};
  for (const [k, spec] of Object.entries(term.vars && typeof term.vars === 'object' ? term.vars : {})) {
    const v = typeof spec === 'number' ? spec : termAt(spec, clocks, t, fps);
    if (v === undefined) return undefined;
    vars[k] = v;
  }
  try {
    const v = evaluateAst(ast, { value: 0, time: t, frame: Math.floor(t * fps + 1e-6), fps, duration: 0, progress: 0, index: 0, seed: 0, vars });
    if (Array.isArray(v)) return v.every((x) => Number.isFinite(Number(x))) ? v.map(Number) : undefined;
    const n = typeof v === 'number' ? v : Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a drive term's expression parses and runs (an empty string when it does): for the scene's warnings. */
export function exprProblem(term, clocks) {
  const { error } = compileExpression(term?.expr);
  if (error) return error.message;
  const vars = {};
  for (const [k, spec] of Object.entries(term.vars && typeof term.vars === 'object' ? term.vars : {})) vars[k] = typeof spec === 'number' ? spec : 0;
  try { evaluateAst(compileExpression(term.expr).ast, { value: 0, time: 0, frame: 0, fps: 30, duration: 0, progress: 0, index: 0, seed: 0, vars }); } catch (e) { return e.message; }
  for (const [k, spec] of Object.entries(term.vars && typeof term.vars === 'object' ? term.vars : {})) {
    if (typeof spec !== 'number' && clockAt(clocks, spec?.clock, 0) === undefined) return `variable ${k}: no clock "${spec?.clock}"`;
  }
  return '';
}

/** One drive term's value at t: its clock's value through its remap, or its expression's. Undefined when its clock is missing. */
function termAt(term, clocks, t, fps = 30) {
  if (!term || typeof term !== 'object') return undefined;
  if (typeof term.expr === 'string') return exprAt(term, clocks, t, fps);
  const u = clockAt(clocks, term.clock, t);
  if (u === undefined) return undefined;
  const map = remapOf(term.map);
  return map ? sampleTrack(map, u) : u;
}

/** Two values of one field together: `scale` multiplies, every other field adds; a number with a list goes to each component. */
function combine(a, b, multiply) {
  const op = multiply ? (x, y) => x * y : (x, y) => x + y;
  if (Array.isArray(a) || Array.isArray(b)) {
    const n = Math.max(Array.isArray(a) ? a.length : 0, Array.isArray(b) ? b.length : 0);
    return Array.from({ length: n }, (_, i) => op(Number(Array.isArray(a) ? a[i] ?? 0 : a), Number(Array.isArray(b) ? b[i] ?? 0 : b)));
  }
  return op(Number(a), Number(b));
}

/** A field's drive (one term or a list) at t; undefined when no term has its clock. */
export function driveAt(drive, clocks, t, field = '', fps = 30) {
  let out;
  for (const term of Array.isArray(drive) ? drive : [drive]) {
    const v = termAt(term, clocks, t, fps);
    if (v === undefined) continue;
    out = out === undefined ? v : combine(out, v, field === 'scale');
  }
  return out;
}

/**
 * The value of a field at time t: its keys (through its ƒx) and its drive (through the scene's clocks), combined; else the static value.
 * `scene` is the Scene (its `clocks`); without it a drive is not read.
 */
export function sampleField(item, field, t, scene = null) {
  if (!item) return undefined;
  const track = item.keys?.[field];
  let v;
  if (Array.isArray(track) && track.length) {
    const cfg = item.fx?.[field] ? fxOf(item.fx[field], field) : null;
    v = cfg ? sampleTrackFx(track, cfg, t, `${item.id ?? ''}|${field}`) : sampleTrack(track, t);
  }
  const drive = item.drive?.[field];
  if (drive != null && scene) {
    const d = driveAt(drive, scene.clocks, t, field, Number(scene.fps) > 0 ? Number(scene.fps) : 30);
    if (d !== undefined) v = v === undefined ? d : combine(v, d, field === 'scale');
  }
  if (v !== undefined) return v;
  return PATH_FIELDS.has(field) ? item.path?.[field] : item[field];
}

/** Whether any of `fields` of an item can change in time: it has keys on it, a drive, or a follow path that moves it. */
export function isAnimated(item, fields) {
  if (!item || typeof item !== 'object') return false;
  const pathMoves = !!item.path && (!!item.keys?.along || item.drive?.along != null || !!item.keys?.bank || item.drive?.bank != null);
  for (const f of fields) {
    if (item.keys?.[f] || item.drive?.[f] != null) return true;
    if (pathMoves && (f === 'at' || (f === 'rot' && item.path.orient))) return true;
  }
  return false;
}

/**
 * Where a Scene object stands at t, in its parent's space: { at, rot, scale, quat }. `quat` ([x, y, z, w]) is set only when a path
 * turns it (`orient`): then it is the whole turn, the path's frame then its own `rot`; otherwise `rot` (degrees, XYZ) is. A path puts it
 * at its `at` plus the curve's point at `along`.
 */
export function objectPose(o, t, scene = null) {
  const at = sampleField(o, 'at', t, scene), rot = sampleField(o, 'rot', t, scene), scale = sampleField(o, 'scale', t, scene);
  const p = o?.path ? pathAt(o.path, sampleField(o, 'along', t, scene) ?? 0) : null;
  if (!p) return { at, rot, scale, quat: null };
  const a = Array.isArray(at) ? at : [0, 0, 0];
  const pos = [(+a[0] || 0) + p.point[0], (+a[1] || 0) + p.point[1], (+a[2] || 0) + p.point[2]];
  if (!o.path.orient) return { at: pos, rot, scale, quat: null };
  const q = quatMul(quatAlong(p.tangent, o.path.up, sampleField(o, 'bank', t, scene) ?? 0), quatFromEulerDeg(Array.isArray(rot) ? rot : [0, 0, 0]));
  return { at: pos, rot, scale, quat: q };
}

const differs = (a, b) => {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return true;
    return a.some((v, i) => Math.abs(v - b[i]) > 1e-6);
  }
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) > 1e-6;
  return a !== b;
};

/** Whether an item's `fields` change between t0 and t1 (sampled at both ends and the middle), its path included. For what keys alone
 *  cannot tell: a drive (its clock's glide runs on after its last key), an ƒx (a spring rings past its key), a path. */
export function fieldsMoveBetween(item, fields, t0, t1, scene = null) {
  if (!isAnimated(item, fields)) return false;
  const mid = (t0 + t1) / 2;
  const at = (t) => (item.path && fields.includes('at') ? objectPose(item, t, scene) : null);
  for (const f of fields) {
    const a = sampleField(item, f, t0, scene);
    if (differs(a, sampleField(item, f, t1, scene)) || differs(a, sampleField(item, f, mid, scene))) return true;
  }
  const p0 = at(t0);
  if (p0) {
    for (const t of [t1, mid]) { const p = at(t); if (differs(p0.at, p.at) || differs(p0.quat, p.quat)) return true; }
  }
  return false;
}

/** Whether a Scene object, or the parents it hangs from, can move by its keys, drives or path (the world's checks of what stays put). */
export function chainAnimated(objects, id, fields = ['at', 'rot', 'scale']) {
  const byId = objects instanceof Map ? objects : new Map((objects || []).map((o) => [o?.id, o]));
  for (let o = byId.get(id), hops = 0; o && hops < 32; o = byId.get(o.parent), hops += 1) if (isAnimated(o, fields)) return true;
  return false;
}

/** Every name `ease` takes: the world's six, the editor's easings by id, then by the editor's own names. */
export const easeNames = [...Object.keys(EASE), ...APP_IDS, ...APP_NAMES];
