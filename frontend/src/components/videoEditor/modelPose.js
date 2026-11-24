/*
 * (pose) The pose pipeline of a model layer: `model3dConfig.pose`, a character's pose as a pure function of the layer's time.
 *
 * One fixed order, the same in every render (the editor's own pass, the world's Draft and Final, the render page, the export), because
 * every one of them draws the pose this module leaves on the layer's nodes (the world copies the node matrices and morph weights):
 *
 *   1. clips        the GLB's animations, stacked: the first is the base, each next one is laid over what is below by its weight
 *                   (a crossfade is a weight that rises while the one before stays), each with its own time, speed, loop and offset,
 *                   root motion as the clip has it, in place, or carried on from loop to loop
 *   2. morphs       morph target weights by name (replace or add); then `speech`'s mouth shapes, added (lipsync)
 *   3. bones        local transform overrides by bone name: added to what the clips made, or replacing it; then `speech`'s jaw
 *                   and head nod, added (lipsync)
 *   4. constraints  look-at, two-bone IK, parent (a bone held by a target), follow path; and attach (another object held by a bone),
 *                   solved against the layer's world transform of this frame
 *   5. world        the layer's transform and its floor (model3dLayer.js poseModel; the floor is found on the pose before step 4, so
 *                   an arm reaching down never lifts the feet)
 *
 * Layers (`pose.layers`) run inside each step after the pose's own entries, in their order: a layer's clips in step 1, its morphs in
 * step 2 and so on, each laid over by the layer's weight and only where its mask lets it (bones and their children, objects, properties,
 * morphs). `on: false` takes a layer out. Every number a control holds is keyable: `keys: { <field>: [{ t, v, ease }] }` on the control,
 * in the layer's own seconds (world3d/keys.js: holds before the first key and after the last, inOut by default).
 *
 * Nothing here draws or allocates per frame beyond a few scratch objects; the source clips are read, never written.
 */
import * as THREE from 'three';
import { sampleTrack, sampleQuatTrack, sampleStep, sampleField, objectPose, isAnimated, clockAt } from '../../world3d/keys.js';
import { audioClockSongTime } from '../../world3d/audioClock.js';
import { VISEMES, NOD_DEGREES, EYE_DEGREES, lipsyncAt, lipsyncProblem, openFromLevel, emphasisFromLevel, speechTargets, speechWeights } from '../../world3d/lipsync.js';
import { applyHandShapes, evaluateSkinnedExtremalPoint, pointClearanceFromShape, solvePinchConstraint } from './handPose.js';

export const POSE_ORDER = ['clips', 'morphs', 'bones', 'constraints', 'world'];
export const ROOT_MODES = ['normal', 'inPlace', 'accumulate'];
export const CONSTRAINT_TYPES = ['lookAt', 'ik', 'splineIk', 'parent', 'path', 'attach', 'pinch'];

const DEG = Math.PI / 180;
const num = (v, d) => (Number.isFinite(v) ? v : d);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (x) => { const s = clamp01(x); return s * s * (3 - 2 * s); };

// scratch
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

/** A control's value at t: its track in `keys` when it has one, else its own field, else `fallback`. */
export function controlValue(control, field, t, fallback) {
  if (!control || typeof control !== 'object') return fallback;
  const track = control.keys?.[field];
  if (Array.isArray(track) && track.length) {
    const first = track[0]?.v;
    const v = typeof first === 'string' || typeof first === 'boolean'
      ? sampleStep(track, t)
      : (field === 'quat' ? sampleQuatTrack(track, t) : sampleTrack(track, t));
    if (v !== undefined) return v;
  }
  return control[field] !== undefined ? control[field] : fallback;
}

/** A clip's local time for `t` seconds since it starts playing, by loop mode. 'once' holds a hair before the end (as the mixer path). */
export function clipLocalTime(t, dur, mode) {
  if (!(dur > 0)) return 0;
  if (mode === 'loop') return ((t % dur) + dur) % dur;
  if (mode === 'pingpong') {
    const cycle = ((t % (dur * 2)) + dur * 2) % (dur * 2);
    return cycle <= dur ? cycle : dur * 2 - cycle;
  }
  return Math.max(0, Math.min(dur - 1e-4, t));
}

/** How many whole loops a looping clip has finished at unwrapped time u (accumulated root motion). */
const loopsDone = (u, dur) => (dur > 0 ? Math.floor(u / dur) : 0);

/**
 * A model's pose rig: its nodes by name, their rest transforms (from `restSource`, the untouched asset, by traversal order), the clips'
 * tracks bound to nodes, the morph meshes. Made once per model instance.
 */
export function makePoseRig(root, clips = [], restSource = null) {
  const nodes = [];
  root.traverse((n) => nodes.push(n));
  const source = [];
  (restSource || root).traverse((n) => source.push(n));
  const same = source.length === nodes.length;
  const rest = nodes.map((n, i) => {
    const s = same ? source[i] : n;
    return { p: s.position.clone(), q: s.quaternion.clone(), s: s.scale.clone(), w: s.morphTargetInfluences ? [...s.morphTargetInfluences] : null };
  });
  const index = new Map(nodes.map((n, i) => [n, i]));
  const byName = new Map();
  for (const n of nodes) if (n.name && !byName.has(n.name)) byName.set(n.name, n);
  const parentOf = (n) => (n.parent && index.has(n.parent) ? n.parent : null);
  const morphMeshes = nodes.filter((n) => n.isMesh && n.morphTargetInfluences?.length);
  const rig = { root, nodes, rest, index, byName, parentOf, morphMeshes, clips: new Map(), warnings: [], restPoseRel: null };
  for (const clip of clips) rig.clips.set(clip.name, { clip, bound: null });
  return rig;
}

/** The node a name means: exact, then with glTF's sanitised spaces. */
function nodeByName(rig, name) {
  if (!name) return null;
  return rig.byName.get(name) || rig.byName.get(sanitized(name)) || null;
}

/** A clip's tracks bound to this rig's nodes, once: [{ node, i, prop: 'p'|'q'|'s'|'w', interp, size }]. */
function boundClip(rig, entry) {
  if (entry.bound) return entry.bound;
  const out = [];
  for (const track of entry.clip.tracks) {
    let parsed;
    try { parsed = THREE.PropertyBinding.parseTrackName(track.name); } catch { continue; }
    const node = THREE.PropertyBinding.findNode(rig.root, parsed.nodeName);
    if (!node || !rig.index.has(node)) continue;
    const prop = { position: 'p', quaternion: 'q', scale: 's', morphTargetInfluences: 'w' }[parsed.propertyName];
    if (!prop || parsed.objectName) continue;
    if (prop === 'w' && !node.morphTargetInfluences) continue;
    const names = prop === 'w' ? [] : null;
    if (names) for (const [name, k] of Object.entries(node.morphTargetDictionary || {})) names[k] = name;
    out.push({ node, i: rig.index.get(node), prop, interp: track.createInterpolant(), size: track.getValueSize(), names });
  }
  entry.bound = out;
  return out;
}

/** The node whose translation is the clip's root motion: `root.bone`, else of the nodes the clips move by translation, the one with the
 *  most of the skeleton under it (the hips, not a foot), the shallower on a tie. */
function rootMotionNode(rig, spec, entries) {
  if (spec?.bone) return nodeByName(rig, spec.bone);
  const key = entries.map((e) => e.clip.name).join('|');
  if (rig.rootMotionKey === key) return rig.rootMotion;
  let best = null, bestScore = -1, bestDepth = Infinity;
  const seen = new Set();
  for (const e of entries) {
    for (const b of boundClip(rig, e)) {
      if (b.prop !== 'p' || seen.has(b.node)) continue;
      seen.add(b.node);
      let under = 0; b.node.traverse(() => { under += 1; });
      let d = 0; for (let n = b.node; n && n !== rig.root; n = n.parent) d += 1;
      if (under > bestScore || (under === bestScore && d < bestDepth)) { bestScore = under; bestDepth = d; best = b.node; }
    }
  }
  rig.rootMotion = best;
  rig.rootMotionKey = key;
  return best;
}

/** A node's rest rotation relative to the model root (the rest transforms down its chain, the node's own included). */
function restRotation(rig, n, out) {
  out.identity();
  const chain = [];
  for (let p = n; p && p !== rig.root; p = p.parent) chain.unshift(p);
  for (const p of chain) out.multiply(rig.rest[rig.index.get(p)].q);
  return out;
}

/** The model's up (+Y of the file) in a node's parent space at rest. */
function upInParent(rig, n) {
  if (rig.upCache?.node === n) return rig.upCache.up;
  const q = n.parent && n.parent !== rig.root ? restRotation(rig, n.parent, new THREE.Quaternion()) : new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q.invert()).normalize();
  rig.upCache = { node: n, up };
  return up;
}

/** A node name as three keeps it: glTF names lose `.`, `:`, `/`, `[`, `]` and turn spaces into `_` (PropertyBinding), so "Palm2.L"
 *  in a pose finds three's "Palm2L". */
const sanitized = (name) => THREE.PropertyBinding.sanitizeNodeName(String(name));
const maskSets = new WeakMap();
function maskNames(mask) {
  let m = maskSets.get(mask);
  if (!m) {
    const list = (v) => new Set((Array.isArray(v) ? v : []).flatMap((x) => [String(x), sanitized(x)]));
    m = { names: list([...(Array.isArray(mask.bones) ? mask.bones : []), ...(Array.isArray(mask.objects) ? mask.objects : [])]), exclude: list(mask.exclude) };
    maskSets.set(mask, m);
  }
  return m;
}

/** Whether a layer's mask lets it write `prop` of node `i` (bones/objects with their children, properties). */
function maskAllows(rig, mask, node, prop) {
  if (!mask) return true;
  if (Array.isArray(mask.properties) && mask.properties.length) {
    const name = { p: 'position', q: 'rotation', s: 'scale', w: 'morphs' }[prop];
    if (!mask.properties.includes(name)) return false;
  }
  const { names, exclude } = maskNames(mask);
  if (names.size) {
    const deep = mask.children !== false;
    let hit = false;
    for (let n = node; n && n !== rig.root.parent; n = deep ? n.parent : null) { if (names.has(n.name)) { hit = true; break; } if (!deep) break; }
    if (!hit) return false;
  }
  if (exclude.size) {
    for (let n = node; n && n !== rig.root.parent; n = n.parent) if (exclude.has(n.name)) return false;
  }
  return true;
}

const maskAllowsMorph = (mask, name) => !mask || !Array.isArray(mask.morphs) || !mask.morphs.length || mask.morphs.includes(name);

/** The layers in order: the pose itself first (no mask, weight 1), then `pose.layers` that are on. */
function layersOf(pose, t) {
  const out = [{ id: null, spec: pose, weight: 1, mask: null }];
  for (const L of Array.isArray(pose.layers) ? pose.layers : []) {
    if (!L || typeof L !== 'object' || L.on === false || controlValue(L, 'on', t, true) === false) continue;
    const w = clamp01(num(Number(controlValue(L, 'weight', t, 1)), 1));
    if (w <= 0) continue;
    out.push({ id: L.id ?? null, spec: L, weight: w, mask: L.mask && typeof L.mask === 'object' ? L.mask : null });
  }
  return out;
}

/** A clip control's weight at t: its weight (keyable) times its fade in after `start` and out before `end`. */
export function clipWeight(c, t) {
  const start = num(Number(c.start), 0);
  const end = Number.isFinite(Number(c.end)) && c.end !== null ? Number(c.end) : Infinity;
  if (t < start || t > end) return 0;
  let w = clamp01(num(Number(controlValue(c, 'weight', t, 1)), 1));
  const fin = Math.max(0, num(Number(c.fadeIn), 0)), fout = Math.max(0, num(Number(c.fadeOut), 0));
  if (fin > 0) w *= smooth((t - start) / fin);
  if (fout > 0 && end !== Infinity) w *= smooth((end - t) / fout);
  return w;
}

/** A clip control's local time at t (seconds since the layer starts): `time` when set or keyed, else from start, speed and offset. */
export function clipTimeAt(c, t, dur) {
  const mode = ['once', 'loop', 'pingpong'].includes(c.loop) ? c.loop : 'loop';
  const explicit = controlValue(c, 'time', t, undefined);
  const u = Number.isFinite(Number(explicit)) && explicit !== null
    ? Number(explicit)
    : (t - num(Number(c.start), 0)) * num(Number(controlValue(c, 'speed', t, 1)), 1) + num(Number(controlValue(c, 'offset', t, 0)), 0);
  return { local: clipLocalTime(u, dur, mode), unwrapped: u, mode };
}

/**
 * The pose at t onto the rig's nodes (and morph weights). `pose` is model3dConfig.pose; `fallbackClip` the layer's `animation` (its
 * clip plays as the base when the pose names no clips). `ctx.resolve(ref, t)` turns a target into a world point (THREE.Vector3) or null,
 * `ctx.attach(objectId, matrix, weight)` hands an attached object's world matrix out. Returns { warnings, rootMotionNode }.
 */
export function applyPose(rig, pose, t, ctx = {}, fallbackClip = null) {
  const warnings = [];
  const seen = new Set();
  const warn = (code, msg) => { if (!seen.has(msg)) { seen.add(msg); warnings.push({ code, message: msg }); } };
  const { nodes, rest } = rig;
  // `attach` with `keep`: where the hand held the object at the moment it took it, measured once (the pose at that moment, the object
  // where the Scene had it then) and kept for as long as the pose and the Scene stay the same
  if (!ctx.measuring) measureKept(rig, pose, ctx);
  rig.solved = [];
  // 0. rest: everything this pose can touch starts from the file's own pose, every frame
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i], r = rest[i];
    n.position.copy(r.p); n.quaternion.copy(r.q); n.scale.copy(r.s);
    if (r.w && n.morphTargetInfluences) for (let k = 0; k < r.w.length; k += 1) n.morphTargetInfluences[k] = r.w[k];
  }
  if (Array.isArray(pose.order) && pose.order.join() !== POSE_ORDER.join()) warn('pose_order', `pose: the order is always ${POSE_ORDER.join(', ')}; the stored one is ignored`);
  const layers = layersOf(pose, t);

  // 1. clips
  const clipControls = [];
  for (const L of layers) {
    const list = Array.isArray(L.spec.clips) ? L.spec.clips : [];
    if (L.id === null && !list.length && fallbackClip?.clip) {
      // the layer's own `animation` as the base: one clip, or '*' every clip of the file at once (each on its own length), as it plays
      // without a pose
      const names = fallbackClip.clip === '*' ? [...rig.clips.keys()] : [fallbackClip.clip];
      for (const name of names) clipControls.push({ L, c: { clip: name, speed: fallbackClip.speed, offset: fallbackClip.offset, loop: fallbackClip.loop || 'loop' } });
    }
    for (const c of list) if (c && typeof c === 'object') clipControls.push({ L, c });
  }
  const rootSpec = pose.root && typeof pose.root === 'object' ? pose.root : (typeof pose.root === 'string' ? { mode: pose.root } : null);
  const rootMode = ROOT_MODES.includes(rootSpec?.mode) ? rootSpec.mode : 'normal';
  const playing = [];
  for (const { L, c } of clipControls) {
    const entry = rig.clips.get(c.clip);
    if (!entry) { warn('unknown_clip', `pose: no clip "${c.clip}" in this model (${[...rig.clips.keys()].join(', ') || 'none'})`); continue; }
    playing.push({ L, c, entry });
  }
  const rootNode = rootMode !== 'normal' && playing.length ? rootMotionNode(rig, rootSpec, playing.map((p) => p.entry)) : null;
  for (const { L, c, entry } of playing) {
    const w = clipWeight(c, t) * L.weight;
    if (!(w > 0)) continue;
    const dur = entry.clip.duration || 0;
    const { local, unwrapped, mode } = clipTimeAt(c, t, dur);
    const blend = c.blend === 'add' ? 'add' : 'over';
    for (const b of boundClip(rig, entry)) {
      if (!maskAllows(rig, L.mask, b.node, b.prop)) continue;
      const v = b.interp.evaluate(local);
      const n = b.node;
      if (b.prop === 'q') {
        _q1.fromArray(v).normalize();
        if (blend === 'add') { _q2.copy(rest[b.i].q).invert().multiply(_q1); _q3.identity().slerp(_q2, w); n.quaternion.multiply(_q3); } else n.quaternion.slerp(_q1, w);
      } else if (b.prop === 'p') {
        _v1.fromArray(v);
        if (n === rootNode) {
          // "up" in the root's parent space (a Z-up armature turned upright by its parent has it on its own Z)
          const up = upInParent(rig, n);
          if (rootMode === 'inPlace') {
            // the root stays over where the clip starts it: its travel along the ground is taken out, up and down kept
            _v2.fromArray(b.interp.evaluate(0));
            _v3.copy(_v1).sub(_v2);
            _v1.copy(_v2).addScaledVector(up, _v3.dot(up));
          } else if (rootMode === 'accumulate' && mode === 'loop') {
            const k = loopsDone(unwrapped, dur);
            if (k) {
              // each finished loop adds the ground the clip covers in one loop, so a walk goes on instead of jumping back
              _v2.fromArray(b.interp.evaluate(0));
              _v3.fromArray(b.interp.evaluate(Math.max(0, dur - 1e-4))).sub(_v2);
              _v3.addScaledVector(up, -_v3.dot(up));
              _v1.addScaledVector(_v3, k);
            }
          }
        }
        if (blend === 'add') n.position.addScaledVector(_v1.sub(rest[b.i].p), w); else n.position.lerp(_v1, w);
      } else if (b.prop === 's') {
        _v1.fromArray(v);
        if (blend === 'add') n.scale.multiply(_v2.set(1, 1, 1).lerp(_v1.divide(rest[b.i].s), w)); else n.scale.lerp(_v1, w);
      } else if (b.prop === 'w') {
        const inf = n.morphTargetInfluences;
        for (let k = 0; k < inf.length && k < b.size; k += 1) {
          if (L.mask && !maskAllowsMorph(L.mask, b.names[k])) continue;
          inf[k] = blend === 'add' ? inf[k] + v[k] * w : inf[k] + (v[k] - inf[k]) * w;
        }
      }
    }
  }

  // 2. morphs
  for (const L of layers) {
    const morphs = L.spec.morphs && typeof L.spec.morphs === 'object' ? L.spec.morphs : null;
    if (!morphs) continue;
    for (const [name, raw] of Object.entries(morphs)) {
      if (!maskAllowsMorph(L.mask, name)) continue;
      const control = typeof raw === 'number' ? { value: raw } : raw;
      if (!control || typeof control !== 'object') continue;
      const value = Number(controlValue(control, 'value', t, 0));
      if (!Number.isFinite(value)) continue;
      const w = clamp01(num(Number(controlValue(control, 'weight', t, 1)), 1)) * L.weight;
      let found = false;
      for (const m of rig.morphMeshes) {
        const k = m.morphTargetDictionary?.[name];
        if (k === undefined) continue;
        if (control.mesh && ![m.name, m.parent?.name].some((x) => x === control.mesh || x === sanitized(control.mesh))) continue;
        found = true;
        const inf = m.morphTargetInfluences;
        inf[k] = control.mode === 'add' ? inf[k] + value * w : inf[k] + (value - inf[k]) * w;
      }
      if (!found) warn('unknown_morph', `pose: no morph target "${name}" in this model`);
    }
  }
  // 2b. (lipsync) the voice a Scene clock plays, as this model's mouth, on top of the morphs above
  const speech = pose.speech && typeof pose.speech === 'object' && pose.speech.on !== false ? speechFrame(rig, pose.speech, t, ctx, warn) : null;
  if (speech) {
    for (const [name, w] of speech.morphs) {
      for (const m of rig.morphMeshes) {
        const k = m.morphTargetDictionary?.[name];
        if (k === undefined || (pose.speech.mesh && ![m.name, m.parent?.name].some((x) => x === pose.speech.mesh || x === sanitized(pose.speech.mesh)))) continue;
        m.morphTargetInfluences[k] += w;
      }
    }
  }

  // 3. bones (hand presets first, so explicit bone overrides refine on top)
  applyHandShapes(rig, pose, layers, t, warn);
  for (const L of layers) {
    const bones = L.spec.bones && typeof L.spec.bones === 'object' ? L.spec.bones : null;
    if (!bones) continue;
    for (const [name, control] of Object.entries(bones)) {
      if (!control || typeof control !== 'object') continue;
      const n = nodeByName(rig, name);
      if (!n) { warn('unknown_bone', `pose: no bone or node "${name}" in this model`); continue; }
      const w = clamp01(num(Number(controlValue(control, 'weight', t, 1)), 1)) * L.weight;
      if (!(w > 0)) continue;
      const add = control.mode !== 'replace';
      const quat = controlValue(control, 'quat', t, null), rot = controlValue(control, 'rot', t, null), at = controlValue(control, 'at', t, null), sc = controlValue(control, 'scale', t, null);
      if (Array.isArray(quat) && quat.length >= 4 && maskAllows(rig, L.mask, n, 'q')) {
        _q1.set(num(quat[0], 0), num(quat[1], 0), num(quat[2], 0), num(quat[3], 1)).normalize();
        if (add) { _q2.identity().slerp(_q1, w); n.quaternion.multiply(_q2); } else n.quaternion.slerp(_q1, w);
      } else if (Array.isArray(rot) && maskAllows(rig, L.mask, n, 'q')) {
        _q1.setFromEuler(_e.set(num(rot[0], 0) * DEG, num(rot[1], 0) * DEG, num(rot[2], 0) * DEG, 'XYZ'));
        if (add) { _q2.identity().slerp(_q1, w); n.quaternion.multiply(_q2); } else n.quaternion.slerp(_q1, w);
      }
      if (Array.isArray(at) && maskAllows(rig, L.mask, n, 'p')) {
        _v1.set(num(at[0], 0), num(at[1], 0), num(at[2], 0));
        if (add) n.position.addScaledVector(_v1, w); else n.position.lerp(_v1, w);
      }
      if (sc !== null && sc !== undefined && maskAllows(rig, L.mask, n, 's')) {
        if (Array.isArray(sc)) _v1.set(num(sc[0], 1), num(sc[1], 1), num(sc[2], 1)); else _v1.setScalar(num(Number(sc), 1));
        if (add) n.scale.multiply(_v2.set(1, 1, 1).lerp(_v1, w)); else n.scale.lerp(_v1, w);
      }
    }
  }

  // 3b. (lipsync) the jaw opens and the head nods on the voice's accents, on top of the bones above
  if (speech) speechBones(rig, pose.speech, speech);

  // world (the layer's transform) is already on the nodes' ancestors: the caller placed `outer` and `inner` before this call, and it puts
  // the model on its floor now, on this pose, before the constraints (ctx.beforeConstraints)
  ctx.beforeConstraints?.();

  // 4. constraints
  let any = false;
  for (const L of layers) if (Array.isArray(L.spec.constraints) && L.spec.constraints.length) { any = true; break; }
  if (any) {
    rig.root.updateWorldMatrix(true, true);
    for (const L of layers) {
      for (const c of Array.isArray(L.spec.constraints) ? L.spec.constraints : []) {
        if (!c || typeof c !== 'object' || c.on === false) continue;
        const w = clamp01(num(Number(controlValue(c, 'weight', t, 1)), 1)) * L.weight;
        if (!(w > 0)) continue;
        if (!CONSTRAINT_TYPES.includes(c.type)) { warn('unknown_constraint', `pose: constraint type "${c.type}" (${CONSTRAINT_TYPES.join(', ')})`); continue; }
        SOLVE[c.type](rig, c, t, w, L, ctx, warn);
      }
    }
  }
  applyCorrectives(rig, layers, t, warn);
  return { warnings, rootMotionNode: rootNode };
}

function measureKept(rig, pose, ctx) {
  const all = [pose, ...(Array.isArray(pose.layers) ? pose.layers : [])].flatMap((L) => (Array.isArray(L?.constraints) ? L.constraints : []));
  const keeps = all.filter((c) => c && c.type === 'attach' && c.keep && c.object && c.on !== false);
  if (!keeps.length) { rig.kept = null; return; }
  // the pose and the Scene are replaced, never changed in place, on every edit: the same two objects mean the same measure
  if (rig.kept && rig.keptPose === pose && rig.keptScene === (ctx.sceneRef ?? null)) return;
  const kept = new Map();
  for (const c of keeps) {
    const at = grabTime(c);
    applyPose(rig, pose, at, { ...ctx, measuring: true, attach: () => true });
    const n = nodeByName(rig, c.bone);
    const obj = ctx.resolveMatrix?.(String(c.object).replace(/^@/, ''), at);
    if (n && obj) kept.set(c, boneFrame(n, new THREE.Matrix4()).invert().multiply(obj));
  }
  rig.kept = kept;
  rig.keptPose = pose;
  rig.keptScene = ctx.sceneRef ?? null;
}

// ── constraints ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A target as a world point (the editor's 3D space: one unit per composition pixel). `{ bone }` without `model` is one of this model's own. */
function targetPoint(rig, ref, t, ctx, out, warn) {
  if (ref && typeof ref === 'object' && !Array.isArray(ref) && ref.bone && !ref.model) {
    const n = nodeByName(rig, ref.bone);
    if (!n) { warn('unknown_bone', `pose: no bone "${ref.bone}" for a target`); return null; }
    if (Array.isArray(ref.point) && ref.point.length >= 3) {
      const scale = ctx?.metresToSpace ?? ctx?.unitsPerMetre ?? 1000;
      boneFrame(n, _m2);
      return out.set(num(ref.point[0], 0) * scale, num(ref.point[1], 0) * scale, num(ref.point[2], 0) * scale).applyMatrix4(_m2);
    }
    n.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(n.matrixWorld);
  }
  const p = ctx.resolve?.(ref, t);
  if (p) return out.copy(p);
  const m = ctx.resolveMatrix?.(ref, t);
  if (m) return out.setFromMatrixPosition(m);
  warn('unknown_target', `pose: target ${JSON.stringify(ref)} not found`);
  return null;
}

/** A node's world rotation set to `q`, through its parent (the local rotation that gives it), blended from the current one by w. */
function setWorldQuaternion(n, q, w) {
  n.parent.updateWorldMatrix(true, false);
  n.parent.matrixWorld.decompose(_v5, _q3, _s);
  _q2.copy(_q3).invert().multiply(q);
  n.quaternion.slerp(_q2, w);
  n.updateWorldMatrix(false, true);
}

const worldQuat = (n, out) => { n.updateWorldMatrix(true, false); n.matrixWorld.decompose(_v5, out, _s); return out; };
const worldPos = (n, out) => { n.updateWorldMatrix(true, false); return out.setFromMatrixPosition(n.matrixWorld); };

/** The direction a bone faces, in its own space: `axis`, else the model's front (+Z of the file, or `forward`) as the bone holds it at rest. */
function aimAxis(rig, n, c) {
  if (Array.isArray(c.axis) && c.axis.length === 3) return _v4.set(num(c.axis[0], 0), num(c.axis[1], 0), num(c.axis[2], 1)).normalize();
  const fwd = Array.isArray(c.forward) && c.forward.length === 3 ? _v4.set(num(c.forward[0], 0), num(c.forward[1], 0), num(c.forward[2], 1)) : _v4.set(0, 0, 1);
  // the bone's rest rotation relative to the model root, from the rest transforms down its chain
  _q1.identity();
  const chain = [];
  for (let p = n; p && p !== rig.root; p = p.parent) chain.unshift(p);
  for (const p of chain) _q1.multiply(rig.rest[rig.index.get(p)].q);
  return fwd.applyQuaternion(_q1.invert()).normalize();
}

const SOLVE = {
  /** Aim a bone (and a share of its parents: `chain`) at a target: the shortest turn, at most `limit` degrees off its pose. */
  lookAt(rig, c, t, w, L, ctx, warn) {
    const n = nodeByName(rig, c.bone);
    if (!n) { warn('unknown_bone', `pose: lookAt bone "${c.bone}" not found`); return; }
    const target = targetPoint(rig, controlValue(c, 'target', t, null), t, ctx, new THREE.Vector3(), warn);
    if (!target) return;
    const axis = aimAxis(rig, n, c).clone();
    const limit = num(Number(c.limit), 180) * DEG;
    const count = Math.max(1, Math.min(4, Math.round(num(Number(c.chain), 1))));
    const chain = [];
    for (let p = n; p && chain.length < count && p !== rig.root; p = p.parent) chain.unshift(p);
    // the whole chain together never turns past `limit` from where the clips and bones put the bone: the point it aims at is pulled in
    const from0 = worldPos(n, new THREE.Vector3());
    const aim0 = axis.clone().applyQuaternion(worldQuat(n, new THREE.Quaternion())).normalize();
    const want0 = target.clone().sub(from0);
    const dist = want0.length();
    if (!(dist > 1e-9)) return;
    want0.normalize();
    const full = new THREE.Quaternion().setFromUnitVectors(aim0, want0);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(full.w)));
    const aimAt = angle > limit
      ? from0.clone().addScaledVector(aim0.clone().applyQuaternion(new THREE.Quaternion().slerp(full, limit / angle)), dist)
      : target;
    // each bone from the top takes its share of what is left, the last bone what remains
    for (let k = 0; k < chain.length; k += 1) {
      const b = chain[k];
      if (!maskAllows(rig, L.mask, b, 'q')) continue;
      const share = 1 / (chain.length - k);
      const from = worldPos(n, new THREE.Vector3());
      const aim = axis.clone().applyQuaternion(worldQuat(n, new THREE.Quaternion())).normalize();
      const want = aimAt.clone().sub(from).normalize();
      const turn = new THREE.Quaternion().setFromUnitVectors(aim, want);
      const part = new THREE.Quaternion().slerp(turn, share);
      const bq = worldQuat(b, new THREE.Quaternion());
      setWorldQuaternion(b, part.multiply(bq), w);
    }
    // what it reached, for the report (render-still `inspect`: scene.poses): the angle between the bone's front and the target
    const endFrom = worldPos(n, new THREE.Vector3());
    const endAim = axis.clone().applyQuaternion(worldQuat(n, new THREE.Quaternion())).normalize();
    rig.solved.push({ type: 'lookAt', bone: c.bone, weight: +w.toFixed(4), errorDeg: +(endAim.angleTo(target.clone().sub(endFrom).normalize()) / DEG).toFixed(4) });
  },

  /** Two-bone IK: `bone` is the end (a wrist, an ankle); its parent and grandparent bend so that it reaches the target, the middle joint
   *  toward `pole` (a point; left out, the bend the pose already has). `tip` (a bone under the end: a knuckle, a toe) reaches instead
   *  of the end's own origin: the hand then lands on what it reaches rather than through it. Optional `orient` / `rot` orient `end`, and
   *  `surface` / `contact: 'surface'` iterates using live skinned support vertices so the skin pad kisses the target plane. */
  ik(rig, c, t, w, L, ctx, warn) {
    const end = nodeByName(rig, c.bone);
    if (!end) { warn('unknown_bone', `pose: ik bone "${c.bone}" not found`); return; }
    const mid = end.parent, top = mid?.parent;
    if (!mid || !top || !rig.index.has(top)) { warn('ik_chain', `pose: ik bone "${c.bone}" needs a parent and a grandparent`); return; }
    if (!maskAllows(rig, L.mask, top, 'q') && !maskAllows(rig, L.mask, mid, 'q')) return;
    const targetRef = controlValue(c, 'target', t, null);
    const target = targetPoint(rig, targetRef, t, ctx, new THREE.Vector3(), warn);
    if (!target) return;
    let tip = null;
    if (c.tip) {
      tip = nodeByName(rig, c.tip);
      let under = false;
      for (let p = tip; p; p = p.parent) if (p === end) { under = true; break; }
      if (!tip || !under) { warn('unknown_bone', `pose: ik tip "${c.tip}" is not a bone under "${c.bone}"`); tip = null; }
    }
    const poleRef = controlValue(c, 'pole', t, null);
    const pole = poleRef !== null && poleRef !== undefined ? targetPoint(rig, poleRef, t, ctx, new THREE.Vector3(), warn) : null;

    const orientVal = controlValue(c, 'orient', t, undefined);
    const rotVal = controlValue(c, 'rot', t, null);
    const hasOrient = orientVal !== undefined && orientVal !== false && orientVal !== null;
    const hasRot = Array.isArray(rotVal) && rotVal.length >= 3;
    const wantsEndOrient = (hasOrient || hasRot) && maskAllows(rig, L.mask, end, 'q');
    const qRotLocal = hasRot
      ? new THREE.Quaternion().setFromEuler(
        new THREE.Euler(num(rotVal[0], 0) * DEG, num(rotVal[1], 0) * DEG, num(rotVal[2], 0) * DEG, 'XYZ'),
      )
      : null;
    const endBaseLocalQ = end.quaternion.clone();

    // Resolve optional aim target point once if orient.aim is a target ref
    let aimPt = null;
    if (hasOrient && typeof orientVal === 'object' && !Array.isArray(orientVal) && orientVal.aim && !Array.isArray(orientVal.aim)) {
      aimPt = targetPoint(rig, orientVal.aim, t, ctx, new THREE.Vector3(), warn);
    }

    const computeEndQuat = () => {
      if (!hasOrient) return null;
      let qBase = null;
      if (orientVal === true) {
        if (targetRef && typeof targetRef === 'object' && !Array.isArray(targetRef) && targetRef.bone && !targetRef.model) {
          const tn = nodeByName(rig, targetRef.bone);
          qBase = tn ? worldQuat(tn, new THREE.Quaternion()) : worldQuat(end, new THREE.Quaternion());
        } else {
          const tm = ctx.resolveMatrix?.(targetRef, t);
          if (tm) {
            qBase = new THREE.Quaternion();
            tm.decompose(_v5, qBase, _s);
          } else {
            qBase = worldQuat(end, new THREE.Quaternion());
          }
        }
      } else if (Array.isArray(orientVal) && orientVal.length >= 3) {
        qBase = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(num(orientVal[0], 0) * DEG, num(orientVal[1], 0) * DEG, num(orientVal[2], 0) * DEG, 'XYZ'),
        );
      } else if (typeof orientVal === 'object') {
        const aimDir = Array.isArray(orientVal.aim) && orientVal.aim.length >= 3
          ? new THREE.Vector3(num(orientVal.aim[0], 0), num(orientVal.aim[1], 0), num(orientVal.aim[2], 1))
          : (aimPt ? aimPt.clone().sub(worldPos(end, new THREE.Vector3())) : target.clone().sub(worldPos(end, new THREE.Vector3())));
        if (aimDir.lengthSq() > 1e-12) aimDir.normalize();
        else aimDir.set(0, 0, 1);

        const localAxis = aimAxis(rig, end, { axis: orientVal.axis, forward: orientVal.forward }).clone();
        const curQ = worldQuat(end, new THREE.Quaternion());

        if (Array.isArray(orientVal.up) && orientVal.up.length >= 3) {
          const worldUp = new THREE.Vector3(num(orientVal.up[0], 0), num(orientVal.up[1], 1), num(orientVal.up[2], 0));
          if (worldUp.lengthSq() > 1e-12) worldUp.normalize();
          else worldUp.set(0, 1, 0);

          const wRight = new THREE.Vector3().crossVectors(worldUp, aimDir);
          if (wRight.lengthSq() > 1e-10) {
            wRight.normalize();
            const wUp = new THREE.Vector3().crossVectors(aimDir, wRight).normalize();
            let localUp = aimAxis(rig, end, { axis: orientVal.upAxis, forward: [0, 1, 0] }).clone();
            if (Math.abs(localUp.dot(localAxis)) > 0.98) {
              localUp = aimAxis(rig, end, { forward: Math.abs(localAxis.y) < 0.9 ? [0, 1, 0] : [1, 0, 0] }).clone();
            }
            const lRight = new THREE.Vector3().crossVectors(localUp, localAxis).normalize();
            const lUp = new THREE.Vector3().crossVectors(localAxis, lRight).normalize();
            const mW = new THREE.Matrix4().makeBasis(wRight, wUp, aimDir);
            const mL = new THREE.Matrix4().makeBasis(lRight, lUp, localAxis);
            qBase = new THREE.Quaternion().setFromRotationMatrix(mW.multiply(mL.transpose()));
          } else {
            const curAim = localAxis.clone().applyQuaternion(curQ).normalize();
            qBase = new THREE.Quaternion().setFromUnitVectors(curAim, aimDir).multiply(curQ);
          }
        } else {
          const curAim = localAxis.clone().applyQuaternion(curQ).normalize();
          qBase = new THREE.Quaternion().setFromUnitVectors(curAim, aimDir).multiply(curQ);
        }
      }
      return qBase && qRotLocal ? qBase.clone().multiply(qRotLocal) : qBase;
    };

    const surfaceVal = controlValue(c, 'surface', t, undefined);
    const wantsSurface = Boolean(surfaceVal) || c.contact === 'surface';
    const metresToSpace = ctx?.metresToSpace ?? ctx?.unitsPerMetre ?? 1000;
    const spaceToMm = 1000 / metresToSpace;
    let surfaceNormal = null;
    let clearanceSpace = 0;
    let surfaceTarget = target;
    if (wantsSurface) {
      const topNormal = controlValue(c, 'surfaceNormal', t, null);
      const nRaw = (surfaceVal && typeof surfaceVal === 'object' && Array.isArray(surfaceVal.normal))
        ? surfaceVal.normal
        : (Array.isArray(topNormal) ? topNormal : (Array.isArray(c.normal) ? c.normal : null));
      if (nRaw && nRaw.length >= 3) {
        surfaceNormal = new THREE.Vector3(num(nRaw[0], 0), num(nRaw[1], 1), num(nRaw[2], 0));
      } else if (hasOrient && typeof orientVal === 'object' && Array.isArray(orientVal.aim) && orientVal.aim.length >= 3) {
        surfaceNormal = new THREE.Vector3(-num(orientVal.aim[0], 0), -num(orientVal.aim[1], 0), -num(orientVal.aim[2], 1));
      } else {
        surfaceNormal = worldPos(top, new THREE.Vector3()).sub(target);
      }
      if (surfaceNormal.lengthSq() > 1e-12) surfaceNormal.normalize();
      else surfaceNormal.set(0, 1, 0);
      const clM = num(Number(surfaceVal && typeof surfaceVal === 'object' ? surfaceVal.clearance : c.clearance), 0);
      clearanceSpace = clM * metresToSpace;

      const hasExplicitPoint = Array.isArray(targetRef)
        || (targetRef && typeof targetRef === 'object' && !Array.isArray(targetRef) && Array.isArray(targetRef.point));
      const refKey = typeof targetRef === 'string' ? targetRef.replace(/^@/, '') : targetRef;
      const targetShape = !hasExplicitPoint && refKey
        ? (ctx?.resolveShape?.(refKey, t) || ctx?.resolveShape?.(targetRef, t) || null)
        : null;
      if (targetShape) {
        const sd0 = pointClearanceFromShape(target, targetShape);
        if (Number.isFinite(sd0) && sd0 < 0) {
          let lo = 0;
          let hi = Math.max(1e-3 * metresToSpace, -sd0);
          const maxReach = Math.max(4 * metresToSpace, Math.abs(sd0) * 4);
          while (hi < maxReach && pointClearanceFromShape(_v5.copy(target).addScaledVector(surfaceNormal, hi), targetShape) < 0) {
            lo = hi;
            hi *= 2;
          }
          if (pointClearanceFromShape(_v5.copy(target).addScaledVector(surfaceNormal, hi), targetShape) >= 0) {
            for (let it = 0; it < 20; it += 1) {
              const mid = 0.5 * (lo + hi);
              if (pointClearanceFromShape(_v5.copy(target).addScaledVector(surfaceNormal, mid), targetShape) < 0) lo = mid;
              else hi = mid;
            }
            surfaceTarget = target.clone().addScaledVector(surfaceNormal, 0.5 * (lo + hi));
          }
        }
      }
    }

    // the end aims where the tip must land, less the tip's offset from the end as the hand is held now; with a tip or surface contact
    // that offset turns with the forearm and skin, so it is solved iteratively
    const passes = wantsSurface ? 8 : (tip ? (wantsEndOrient ? 8 : 6) : 1);
    let l1 = 0, l2 = 0, tLen = 0;
    if (passes > 1) rig.ikFrom = [top.quaternion.clone(), mid.quaternion.clone(), endBaseLocalQ.clone()];
    // Orient end before pass 0 so tip/skin offset already matches the target orientation
    if (wantsEndOrient && (tip || wantsSurface)) {
      if (hasOrient) {
        const q0Target = computeEndQuat();
        if (q0Target) setWorldQuaternion(end, q0Target, 1);
      } else if (qRotLocal) {
        end.quaternion.copy(endBaseLocalQ).multiply(qRotLocal);
        end.updateWorldMatrix(true, true);
      }
    }

    const goal = surfaceTarget.clone();
    if (tip) goal.sub(worldPos(tip, new THREE.Vector3()).sub(worldPos(end, new THREE.Vector3())));
    let lastEndTargetQ = null;

    const limits = c.limits && typeof c.limits === 'object' ? c.limits : null;
    const minBendRaw = limits?.minBend ?? c.minBend;
    const maxBendRaw = limits?.maxBend ?? c.maxBend;
    const minBendDeg = Number.isFinite(Number(minBendRaw)) && minBendRaw !== null ? Math.max(0, Math.min(180, Number(minBendRaw))) : null;
    const maxBendDeg = Number.isFinite(Number(maxBendRaw)) && maxBendRaw !== null ? Math.max(0, Math.min(180, Number(maxBendRaw))) : null;
    const poleAngleDeg = num(Number(controlValue(c, 'poleAngle', t, 0)), 0);
    let clamped = false;
    let lastBendAngleDeg = 0;

    for (let pass = 0; pass < passes; pass += 1) {
      if (pass > 0) {
        if (wantsSurface) {
          const ext = evaluateSkinnedExtremalPoint(rig, tip || end, surfaceTarget, surfaceNormal);
          if (ext) {
            const errN = ext.signedDistance - clearanceSpace;
            const tol = 1e-5 * Math.max(1, metresToSpace / 1000);
            if (Math.abs(errN) < tol && ext.tangentialError < tol) break;
            const delta = surfaceTarget.clone().addScaledVector(surfaceNormal, clearanceSpace).sub(ext.point);
            const gain = pass === 1 ? 1.0 : 0.85;
            const maxStep = Math.max(1e-3, (l1 + l2) * 0.5);
            if (delta.length() > maxStep) delta.setLength(maxStep);
            goal.addScaledVector(delta, gain);
          } else if (tip) {
            goal.add(surfaceTarget.clone().sub(worldPos(tip, new THREE.Vector3())));
          }
        } else if (tip) {
          goal.add(surfaceTarget.clone().sub(worldPos(tip, new THREE.Vector3())));
        }
      }
      const a = worldPos(top, new THREE.Vector3()), b = worldPos(mid, new THREE.Vector3()), e = worldPos(end, new THREE.Vector3());
      l1 = a.distanceTo(b); l2 = b.distanceTo(e);
      if (!(l1 > 1e-9) || !(l2 > 1e-9)) return;
      const toT = goal.clone().sub(a);
      tLen = toT.length();
      let dMin = Math.abs(l1 - l2) + 1e-6;
      let dMax = (l1 + l2) * 0.99999;
      if (maxBendDeg !== null) {
        const dFromMaxBend = Math.sqrt(Math.max(1e-12, l1 * l1 + l2 * l2 + 2 * l1 * l2 * Math.cos(maxBendDeg * DEG)));
        if (dFromMaxBend > dMin) { dMin = Math.min(dMax, dFromMaxBend); }
      }
      if (minBendDeg !== null) {
        const dFromMinBend = Math.sqrt(Math.max(1e-12, l1 * l1 + l2 * l2 + 2 * l1 * l2 * Math.cos(minBendDeg * DEG)));
        if (dFromMinBend < dMax) { dMax = Math.max(dMin, dFromMinBend); }
      }
      const d = Math.min(Math.max(tLen, dMin), dMax);
      if (d !== Math.min(Math.max(tLen, Math.abs(l1 - l2) + 1e-6), (l1 + l2) * 0.99999)) clamped = true;
      const dir = toT.lengthSq() > 1e-18 ? toT.normalize() : e.clone().sub(a).normalize();
      // the bend: toward the pole, or the side the middle joint is on now (stable fallback avoids flips near full extension)
      const bend = pole ? pole.clone().sub(a) : b.clone().sub(a);
      bend.addScaledVector(dir, -bend.dot(dir));
      if (bend.lengthSq() < 1e-10) {
        bend.copy(b).sub(a).addScaledVector(dir, -b.clone().sub(a).dot(dir));
      }
      if (bend.lengthSq() < 1e-10) {
        const fb = Math.abs(dir.z) < 0.9 ? _v1.set(0, 0, 1) : _v1.set(0, 1, 0);
        bend.copy(fb).addScaledVector(dir, -fb.dot(dir));
      }
      bend.normalize();
      if (Math.abs(poleAngleDeg) > 1e-6) bend.applyQuaternion(_q1.setFromAxisAngle(dir, poleAngleDeg * DEG)).normalize();
      const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
      const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
      const want = a.clone().addScaledVector(dir, l1 * cosA).addScaledVector(bend, l1 * sinA);
      const reach = a.clone().addScaledVector(dir, d);
      lastBendAngleDeg = Math.acos(THREE.MathUtils.clamp((d * d - l1 * l1 - l2 * l2) / (2 * l1 * l2), -1, 1)) / DEG;
      // the weight blends once, on the last pass; the passes before it solve at full weight
      const ww = pass === passes - 1 ? w : 1;
      // top bone: its child (the middle joint) onto `want`
      if (maskAllows(rig, L.mask, top, 'q')) {
        const turn = new THREE.Quaternion().setFromUnitVectors(b.clone().sub(a).normalize(), want.clone().sub(a).normalize());
        setWorldQuaternion(top, turn.multiply(worldQuat(top, new THREE.Quaternion())), passes > 1 ? 1 : ww);
        if (limits?.top && clampLocalLimits(rig, top, limits.top)) clamped = true;
      }
      // middle bone: the end onto the reach point
      if (maskAllows(rig, L.mask, mid, 'q')) {
        const b2 = worldPos(mid, new THREE.Vector3()), e2 = worldPos(end, new THREE.Vector3());
        const turn = new THREE.Quaternion().setFromUnitVectors(e2.sub(b2).normalize(), reach.sub(b2).normalize());
        setWorldQuaternion(mid, turn.multiply(worldQuat(mid, new THREE.Quaternion())), passes > 1 ? 1 : ww);
        if (limits?.mid && clampLocalLimits(rig, mid, limits.mid)) clamped = true;
      }
      if (wantsEndOrient) {
        if (hasOrient) {
          lastEndTargetQ = computeEndQuat();
          if (lastEndTargetQ) setWorldQuaternion(end, lastEndTargetQ, passes > 1 ? 1 : ww);
        } else if (qRotLocal) {
          _q2.identity().slerp(qRotLocal, passes > 1 ? 1 : ww);
          end.quaternion.copy(endBaseLocalQ).multiply(_q2);
          end.updateWorldMatrix(false, true);
          lastEndTargetQ = worldQuat(end, new THREE.Quaternion());
        }
        if (limits?.end && clampLocalLimits(rig, end, limits.end)) clamped = true;
      }
    }
    if (passes > 1 && w < 1) {
      // part of the way: from the pose before the IK to the solved one
      const [q0, q1, q2] = rig.ikFrom;
      top.quaternion.copy(q0.slerp(top.quaternion, w));
      mid.quaternion.copy(q1.slerp(mid.quaternion, w));
      if (wantsEndOrient) end.quaternion.copy(q2.slerp(end.quaternion, w));
      top.updateWorldMatrix(false, true);
    }

    const report = {
      type: 'ik',
      bone: c.bone,
      ...(tip ? { tip: c.tip } : {}),
      weight: +w.toFixed(4),
      distance: +worldPos(tip || end, new THREE.Vector3()).distanceTo(surfaceTarget).toFixed(4),
      reach: +(l1 + l2).toFixed(4),
      targetDistance: +tLen.toFixed(4),
      bendAngleDeg: +lastBendAngleDeg.toFixed(2),
      ...(clamped ? { clamped: true } : {}),
    };
    if (wantsEndOrient && lastEndTargetQ) {
      const qCur = worldQuat(end, new THREE.Quaternion());
      report.orientErrorDeg = +(2 * Math.acos(Math.min(1, Math.abs(lastEndTargetQ.dot(qCur)))) / DEG).toFixed(4);
    }
    if (wantsSurface) {
      const extF = evaluateSkinnedExtremalPoint(rig, tip || end, surfaceTarget, surfaceNormal);
      if (extF) {
        const desired = surfaceTarget.clone().addScaledVector(surfaceNormal, clearanceSpace);
        report.skinError = +extF.point.distanceTo(desired).toFixed(4);
        report.penetrationMm = +(extF.penetration * spaceToMm).toFixed(4);
      }
    }
    rig.solved.push(report);
  },

  /** Spline IK: fits a chain of bones (`bones` or `chain` ancestors from `bone`) along a `path` spline with parallel-transport up & twist. */
  splineIk(rig, c, t, w, L, ctx, warn) {
    let chain = [];
    if (Array.isArray(c.bones) && c.bones.length >= 2) {
      for (const bn of c.bones) {
        const node = nodeByName(rig, bn);
        if (!node) { warn('unknown_bone', `pose: splineIk bone "${bn}" not found`); return; }
        chain.push(node);
      }
    } else {
      const end = nodeByName(rig, c.bone);
      if (!end) { warn('unknown_bone', `pose: splineIk bone "${c.bone}" not found`); return; }
      const count = Math.max(2, Math.min(64, Math.round(num(Number(c.chain), 4))));
      for (let p = end; p && chain.length < count && p !== rig.root; p = p.parent) chain.unshift(p);
    }
    if (chain.length < 2) { warn('spline_ik_chain', `pose: splineIk needs at least 2 bones`); return; }
    const pts = Array.isArray(c.path) ? c.path.map((p) => targetPoint(rig, p, t, ctx, new THREE.Vector3(), warn)).filter(Boolean) : [];
    if (pts.length < 2) { warn('path_points', 'pose: splineIk needs a `path` of at least two points'); return; }

    const closed = !!c.closed;
    const curve = new THREE.CatmullRomCurve3(pts, closed, 'centripetal');
    const curveLen = Math.max(1e-6, curve.getLength());
    const startU = clamp01(num(Number(controlValue(c, 'start', t, 0)), 0));
    const endU = clamp01(num(Number(controlValue(c, 'end', t, 1)), 1));
    const progress = clamp01(num(Number(controlValue(c, 'progress', t, 0)), 0));
    const stretchVal = controlValue(c, 'stretch', t, false);
    const stretchAmt = typeof stretchVal === 'boolean' ? (stretchVal ? 1 : 0) : clamp01(num(Number(stretchVal), 0));
    const twistVal = controlValue(c, 'twist', t, 0);
    const twist0 = Array.isArray(twistVal) ? num(twistVal[0], 0) : 0;
    const twist1 = Array.isArray(twistVal) ? num(twistVal[1], twist0) : num(Number(twistVal), 0);
    const jointLimitRad = Number.isFinite(Number(c.limit)) && c.limit !== null ? Math.max(0, Number(c.limit)) * DEG : Infinity;

    const worldPtsBefore = chain.map((b) => worldPos(b, new THREE.Vector3()));
    const segLens = [];
    for (let k = 0; k < chain.length - 1; k += 1) segLens.push(Math.max(1e-6, worldPtsBefore[k].distanceTo(worldPtsBefore[k + 1])));

    const uBase = clamp01(startU + progress);
    const spanU = Math.max(1e-4, endU - startU);
    const splinePts = [];
    const tangents = [];
    let cumArc = uBase * curveLen;
    for (let k = 0; k < chain.length; k += 1) {
      if (k > 0) cumArc += segLens[k - 1];
      const uFixed = closed ? ((cumArc / curveLen) % 1 + 1) % 1 : Math.min(1, cumArc / curveLen);
      const frac = k / Math.max(1, chain.length - 1);
      const uStretch = closed ? ((uBase + spanU * frac) % 1 + 1) % 1 : Math.min(1, uBase + spanU * frac);
      const uk = uFixed + (uStretch - uFixed) * stretchAmt;
      splinePts.push(curve.getPointAt(uk));
      tangents.push(curve.getTangentAt(uk).normalize());
    }

    const upRaw = Array.isArray(c.up) && c.up.length === 3 ? new THREE.Vector3(num(c.up[0], 0), num(c.up[1], 1), num(c.up[2], 0)) : new THREE.Vector3(0, 1, 0);
    if (upRaw.lengthSq() < 1e-10) upRaw.set(0, 1, 0);
    upRaw.normalize();

    const ups = [];
    const u0 = upRaw.clone().addScaledVector(tangents[0], -upRaw.dot(tangents[0]));
    if (u0.lengthSq() < 1e-10) {
      const alt = Math.abs(tangents[0].z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
      u0.copy(alt).addScaledVector(tangents[0], -alt.dot(tangents[0]));
    }
    ups.push(u0.normalize());
    for (let k = 1; k < chain.length; k += 1) {
      const tr = new THREE.Quaternion().setFromUnitVectors(tangents[k - 1], tangents[k]);
      ups.push(ups[k - 1].clone().applyQuaternion(tr).normalize());
    }

    // Move chain root to spline start unless keepRoot is explicitly requested
    const rootBone = chain[0];
    if (c.keepRoot !== true && rootBone.parent && maskAllows(rig, L.mask, rootBone, 'p')) {
      rootBone.parent.updateWorldMatrix(true, false);
      const localTarget = rootBone.parent.matrixWorld.clone().invert();
      const ptLocal = splinePts[0].clone().applyMatrix4(localTarget);
      rootBone.position.lerp(ptLocal, w);
      rootBone.updateWorldMatrix(false, true);
    }

    for (let k = 0; k < chain.length; k += 1) {
      const bone = chain[k];
      if (!maskAllows(rig, L.mask, bone, 'q')) continue;
      if (k > 0 && stretchAmt > 0 && bone.parent && maskAllows(rig, L.mask, bone, 'p')) {
        const desiredDist = segLens[k - 1] + (splinePts[k].distanceTo(splinePts[k - 1]) - segLens[k - 1]) * stretchAmt;
        const ri = rig.index.get(bone);
        const dirL = ri !== undefined && rig.rest[ri].p.lengthSq() > 1e-12 ? rig.rest[ri].p.clone().normalize() : new THREE.Vector3(0, 1, 0);
        bone.position.lerp(dirL.multiplyScalar(desiredDist), w);
        bone.updateWorldMatrix(false, true);
      }
      const frac = k / Math.max(1, chain.length - 1);
      const aimWorld = k < chain.length - 1
        ? splinePts[k + 1].clone().sub(worldPos(bone, new THREE.Vector3()))
        : tangents[k].clone();
      if (aimWorld.lengthSq() < 1e-12) aimWorld.copy(tangents[k]);
      aimWorld.normalize();

      const twistAngle = (twist0 + (twist1 - twist0) * frac) * DEG;
      const upWorld = ups[k].clone().addScaledVector(aimWorld, -ups[k].dot(aimWorld));
      if (upWorld.lengthSq() < 1e-10) upWorld.copy(ups[0]);
      upWorld.normalize().applyQuaternion(_q1.setFromAxisAngle(aimWorld, twistAngle));
      const sideWorld = new THREE.Vector3().crossVectors(upWorld, aimWorld).normalize();
      const orthoUpWorld = new THREE.Vector3().crossVectors(aimWorld, sideWorld).normalize();

      // Determine bone local primary axis toward child
      let localAim = null;
      if (k < chain.length - 1) {
        const ci = rig.index.get(chain[k + 1]);
        if (ci !== undefined && rig.rest[ci].p.lengthSq() > 1e-12) localAim = rig.rest[ci].p.clone().normalize();
      } else {
        const tipChild = bone.children.find((ch) => rig.index.has(ch) && rig.rest[rig.index.get(ch)].p.lengthSq() > 1e-12);
        if (tipChild) localAim = rig.rest[rig.index.get(tipChild)].p.clone().normalize();
      }
      if (!localAim) {
        const bi = rig.index.get(bone);
        localAim = bi !== undefined && rig.rest[bi].p.lengthSq() > 1e-12 ? rig.rest[bi].p.clone().normalize() : new THREE.Vector3(0, 1, 0);
      }
      let localUp = new THREE.Vector3(0, 1, 0);
      if (Math.abs(localUp.dot(localAim)) > 0.98) localUp.set(0, 0, 1);
      const localSide = new THREE.Vector3().crossVectors(localUp, localAim).normalize();
      const localOrthoUp = new THREE.Vector3().crossVectors(localAim, localSide).normalize();

      const mW = new THREE.Matrix4().makeBasis(sideWorld, orthoUpWorld, aimWorld);
      const mL = new THREE.Matrix4().makeBasis(localSide, localOrthoUp, localAim);
      let qTarget = new THREE.Quaternion().setFromRotationMatrix(mW.multiply(mL.transpose()));
      if (Number.isFinite(jointLimitRad)) {
        const qCur = worldQuat(bone, new THREE.Quaternion());
        const diff = qCur.angleTo(qTarget);
        if (diff > jointLimitRad && diff > 1e-6) {
          qTarget = qCur.clone().slerp(qTarget, jointLimitRad / diff);
        }
      }
      setWorldQuaternion(bone, qTarget, w);
    }

    const tipPt = worldPos(chain[chain.length - 1], new THREE.Vector3());
    rig.solved.push({
      type: 'splineIk',
      bone: c.bone,
      bones: chain.map((b) => b.name),
      tipError: +tipPt.distanceTo(splinePts[splinePts.length - 1]).toFixed(4),
      weight: +w.toFixed(4),
    });
  },

  /** A bone held by a target: its world position (and rotation, with `orient`) follows the target, `at` and `rot` the offset in the
   *  target's frame. Keying `weight` 0 → 1 hands the bone from its own parent's space to the target's (space switching). */
  parent(rig, c, t, w, L, ctx, warn) {
    const n = nodeByName(rig, c.bone);
    if (!n) { warn('unknown_bone', `pose: parent bone "${c.bone}" not found`); return; }
    const m = targetMatrix(rig, controlValue(c, 'target', t, null), t, ctx, warn);
    if (!m) return;
    offsetMatrix(controlValue(c, 'at', t, null), controlValue(c, 'rot', t, null), _m2);
    m.multiply(_m2);
    holdNode(rig, L, n, m, w, c.orient !== false);
  },

  /** A bone along a path: `path` points (scene metres, or `{ "bone": … }`-free world points through ctx), `progress` 0..1 keyable; with
   *  `orient` the bone's front turns along the path. */
  path(rig, c, t, w, L, ctx, warn) {
    const n = nodeByName(rig, c.bone);
    if (!n) { warn('unknown_bone', `pose: path bone "${c.bone}" not found`); return; }
    const pts = Array.isArray(c.path) ? c.path.map((p) => ctx.resolve?.(p, t)).filter(Boolean) : [];
    if (pts.length < 2) { warn('path_points', 'pose: a path needs at least two points'); return; }
    const curve = new THREE.CatmullRomCurve3(pts, !!c.closed, 'centripetal');
    const u = clamp01(num(Number(controlValue(c, 'progress', t, 0)), 0));
    const p = curve.getPointAt(u);
    const m = new THREE.Matrix4();
    if (c.orient) {
      const tan = curve.getTangentAt(u).normalize();
      const fwd = aimAxis(rig, n, c).clone();
      const nq = worldQuat(n, new THREE.Quaternion());
      const turn = new THREE.Quaternion().setFromUnitVectors(fwd.applyQuaternion(nq).normalize(), tan);
      m.compose(p, turn.multiply(nq), worldScale(n, new THREE.Vector3()));
    } else {
      m.compose(p, worldQuat(n, new THREE.Quaternion()), worldScale(n, new THREE.Vector3()));
    }
    holdNode(rig, L, n, m, w, !!c.orient);
  },

  /** Another object held by a bone (a cup in a hand): the object's world matrix is the bone's times `at`/`rot` (anchored at optional local
   *  `point`), handed out through ctx.attach (the world places it), blended from the object's own place by the weight: key it 0 → 1 to
   *  pick the object up. */
  attach(rig, c, t, w, L, ctx, warn) {
    const n = nodeByName(rig, c.bone);
    if (!n) { warn('unknown_bone', `pose: attach bone "${c.bone}" not found`); return; }
    if (!c.object) { warn('attach_object', 'pose: attach needs `object`'); return; }
    const id = String(c.object).replace(/^@/, '');
    // `keep`: the object stays where it was against the bone at the moment it is picked up (rig.kept, measured by applyPose first)
    const kept = c.keep ? rig.kept?.get(c) : null;
    if (c.keep && !kept) { warn('attach_keep', `pose: attach "${id}" could not measure where the hand held it`); return; }
    const scale = ctx?.metresToSpace ?? ctx?.unitsPerMetre ?? 1000;
    const m = boneFrame(n, new THREE.Matrix4());
    if (kept) m.multiply(kept);
    else {
      m.multiply(offsetMatrix(controlValue(c, 'at', t, null), controlValue(c, 'rot', t, null), _m2, scale));
      const pt = controlValue(c, 'point', t, null);
      if (Array.isArray(pt) && pt.length >= 3) {
        m.multiply(new THREE.Matrix4().makeTranslation(-num(pt[0], 0) * scale, -num(pt[1], 0) * scale, -num(pt[2], 0) * scale));
      }
    }
    if (!ctx.attach?.(id, m, w, { point: c.point, rawObject: c.object })) warn('attach_object', `pose: attach object "${c.object}" is not a Scene object`);
  },

  /** Finger pinch against a Scene object's shape or fallback box at target clearance without skin penetration. */
  pinch(rig, c, t, w, L, ctx, warn) {
    solvePinchConstraint(rig, c, t, w, L, ctx, warn);
  },
};

/** Clamps a node's local rotation relative to its rest pose against `{ x, y, z, swing, twist }`. */
function clampLocalLimits(rig, node, lim) {
  const ri = rig.index.get(node);
  if (ri === undefined || !lim || typeof lim !== 'object') return false;
  const restQ = rig.rest[ri].q;
  const relQ = restQ.clone().invert().multiply(node.quaternion);
  if (relQ.w < 0) relQ.set(-relQ.x, -relQ.y, -relQ.z, -relQ.w);
  let changed = false;
  if (['x', 'y', 'z'].some((a) => Array.isArray(lim[a]) && lim[a].length === 2)) {
    const e = new THREE.Euler().setFromQuaternion(relQ, 'XYZ');
    for (const ax of ['x', 'y', 'z']) {
      if (!Array.isArray(lim[ax]) || lim[ax].length !== 2) continue;
      const a = Number(lim[ax][0]), b = Number(lim[ax][1]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const lo = Math.min(a, b) * DEG, hi = Math.max(a, b) * DEG;
      const clamped = THREE.MathUtils.clamp(e[ax], lo, hi);
      if (Math.abs(clamped - e[ax]) > 1e-6) { e[ax] = clamped; changed = true; }
    }
    if (changed) relQ.setFromEuler(e);
  }
  if (Number.isFinite(Number(lim.swing)) || Number.isFinite(Number(lim.twist))) {
    const child = node.children.find((ch) => rig.index.has(ch));
    const axis = child && child.position.lengthSq() > 1e-10 ? child.position.clone().normalize() : new THREE.Vector3(0, 1, 0);
    const proj = relQ.x * axis.x + relQ.y * axis.y + relQ.z * axis.z;
    const twistQ = new THREE.Quaternion(axis.x * proj, axis.y * proj, axis.z * proj, relQ.w);
    const tl = twistQ.length();
    if (tl > 1e-9) twistQ.multiplyScalar(1 / tl); else twistQ.set(0, 0, 0, 1);
    const swingQ = relQ.clone().multiply(twistQ.clone().invert());
    if (twistQ.w < 0) twistQ.set(-twistQ.x, -twistQ.y, -twistQ.z, -twistQ.w);
    if (swingQ.w < 0) swingQ.set(-swingQ.x, -swingQ.y, -swingQ.z, -swingQ.w);
    if (Number.isFinite(Number(lim.twist))) {
      const maxT = Math.max(0, Number(lim.twist)) * DEG;
      const ang = 2 * Math.acos(Math.min(1, twistQ.w));
      if (ang > maxT + 1e-6) { twistQ.slerp(new THREE.Quaternion(), 1 - maxT / ang).normalize(); changed = true; }
    }
    if (Number.isFinite(Number(lim.swing))) {
      const maxS = Math.max(0, Number(lim.swing)) * DEG;
      const ang = 2 * Math.acos(Math.min(1, swingQ.w));
      if (ang > maxS + 1e-6) { swingQ.slerp(new THREE.Quaternion(), 1 - maxS / ang).normalize(); changed = true; }
    }
    if (changed) relQ.copy(swingQ).multiply(twistQ).normalize();
  }
  if (changed) {
    node.quaternion.copy(restQ).multiply(relQ).normalize();
    node.updateWorldMatrix(false, true);
  }
  return changed;
}

/** Step 4b (4A.2): angle-driven corrective morphs evaluated from final bone deltas after constraints. */
function applyCorrectives(rig, layers, t, warn) {
  if (!rig.morphMeshes.length) return;
  for (const L of layers) {
    const list = Array.isArray(L.spec.correctives) ? L.spec.correctives : null;
    if (!list?.length) continue;
    for (const rule of list) {
      if (!rule || typeof rule !== 'object' || rule.on === false || controlValue(rule, 'on', t, true) === false) continue;
      const w = clamp01(num(Number(controlValue(rule, 'weight', t, 1)), 1)) * L.weight;
      if (!(w > 0)) continue;
      if (!rule.bone || !rule.morph) continue;
      if (!maskAllowsMorph(L.mask, rule.morph)) continue;
      const node = nodeByName(rig, rule.bone);
      if (!node) { warn('unknown_bone', `pose: corrective bone "${rule.bone}" not found`); continue; }
      const ri = rig.index.get(node);
      if (ri === undefined) continue;
      const qRel = rig.rest[ri].q.clone().invert().multiply(node.quaternion);
      if (qRel.w < 0) qRel.set(-qRel.x, -qRel.y, -qRel.z, -qRel.w);

      const axSpec = rule.axis || 'bend';
      let angleDeg = 0;
      if (axSpec === 'bend') {
        angleDeg = (2 * Math.acos(Math.min(1, qRel.w))) / DEG;
      } else if (axSpec === 'twist') {
        const child = node.children.find((ch) => rig.index.has(ch));
        const ax = child && child.position.lengthSq() > 1e-10 ? child.position.clone().normalize() : new THREE.Vector3(0, 1, 0);
        angleDeg = (2 * Math.atan2(qRel.x * ax.x + qRel.y * ax.y + qRel.z * ax.z, qRel.w)) / DEG;
      } else if (axSpec === 'x' || axSpec === 'y' || axSpec === 'z') {
        _e.setFromQuaternion(qRel, 'XYZ');
        angleDeg = _e[axSpec] / DEG;
      } else if (Array.isArray(axSpec) && axSpec.length === 3) {
        const ax = new THREE.Vector3(num(axSpec[0], 0), num(axSpec[1], 1), num(axSpec[2], 0));
        if (ax.lengthSq() > 1e-12) ax.normalize(); else ax.set(0, 1, 0);
        angleDeg = (2 * Math.atan2(qRel.x * ax.x + qRel.y * ax.y + qRel.z * ax.z, qRel.w)) / DEG;
      } else {
        angleDeg = (2 * Math.acos(Math.min(1, qRel.w))) / DEG;
      }

      const fromDeg = num(Number(rule.from), 0);
      const toDeg = num(Number(rule.to), 90);
      const span = toDeg - fromDeg;
      const u = span !== 0 ? clamp01((angleDeg - fromDeg) / span) : (angleDeg >= fromDeg ? 1 : 0);
      const shaped = rule.curve === 'linear' ? u : (rule.curve === 'easeIn' ? u * u : smooth(u));
      const minW = num(Number(controlValue(rule, 'min', t, 0)), 0);
      const maxW = num(Number(controlValue(rule, 'max', t, 1)), 1);
      const val = (minW + (maxW - minW) * shaped) * w;

      let found = false;
      for (const m of rig.morphMeshes) {
        const k = m.morphTargetDictionary?.[rule.morph];
        if (k === undefined) continue;
        if (rule.mesh && ![m.name, m.parent?.name].some((x) => x === rule.mesh || x === sanitized(rule.mesh))) continue;
        found = true;
        const inf = m.morphTargetInfluences;
        if (rule.mode === 'max') inf[k] = Math.max(inf[k], val);
        else if (rule.mode === 'replace') inf[k] = inf[k] + (minW + (maxW - minW) * shaped - inf[k]) * w;
        else inf[k] += val;
      }
      if (!found) warn('unknown_morph', `pose: corrective morph "${rule.morph}" not found in this model`);
    }
  }
}

/** A bone's world frame without its scale (a file in centimetres never scales what the bone holds or what follows it). */
function boneFrame(n, out) {
  n.updateWorldMatrix(true, false);
  n.matrixWorld.decompose(_v1, _q1, _s);
  return out.compose(_v1, _q1, _s.set(1, 1, 1));
}

/** When an `attach` with `keep` picks its object up: `grab`, else where its weight starts to rise (the last 0 key before the first one above). */
export function grabTime(c) {
  if (Number.isFinite(Number(c.grab)) && c.grab !== null) return Number(c.grab);
  const keys = Array.isArray(c.keys?.weight) ? c.keys.weight : [];
  const up = keys.findIndex((k) => Number(k?.v) > 0);
  if (up > 0) return Number(keys[up - 1].t) || 0;
  if (up === 0) return Number(keys[0].t) || 0;
  return 0;
}

const worldScale = (n, out) => { n.updateWorldMatrix(true, false); n.matrixWorld.decompose(_v5, _q3, out); return out; };

/** An offset as a matrix in the editor's 3D space: `at` in metres (one composition px is a millimetre there), `rot` degrees XYZ. */
function offsetMatrix(at, rot, out, scale = 1000) {
  const p = Array.isArray(at) ? _v1.set(num(at[0], 0), num(at[1], 0), num(at[2], 0)).multiplyScalar(scale) : _v1.set(0, 0, 0);
  const q = Array.isArray(rot) ? _q1.setFromEuler(_e.set(num(rot[0], 0) * DEG, num(rot[1], 0) * DEG, num(rot[2], 0) * DEG, 'XYZ')) : _q1.identity();
  return out.compose(p, q, _s.set(1, 1, 1));
}

/** A target's world matrix: a bone of this model (`{ bone }` without `model`), or what ctx.resolveMatrix says (a Scene object), or a point (no turn). */
function targetMatrix(rig, ref, t, ctx, warn) {
  if (ref && typeof ref === 'object' && !Array.isArray(ref) && ref.bone && !ref.model) {
    const n = nodeByName(rig, ref.bone);
    if (!n) { warn('unknown_bone', `pose: no bone "${ref.bone}" for a target`); return null; }
    const m = boneFrame(n, new THREE.Matrix4());
    if (Array.isArray(ref.point) && ref.point.length >= 3) {
      const scale = ctx?.metresToSpace ?? ctx?.unitsPerMetre ?? 1000;
      m.multiply(new THREE.Matrix4().makeTranslation(num(ref.point[0], 0) * scale, num(ref.point[1], 0) * scale, num(ref.point[2], 0) * scale));
    }
    return m;
  }
  const m = ctx.resolveMatrix?.(ref, t);
  if (m) return m.clone();
  const p = ctx.resolve?.(ref, t);
  if (!p) { warn('unknown_target', `pose: target ${JSON.stringify(ref)} not found`); return null; }
  return new THREE.Matrix4().makeTranslation(p.x, p.y, p.z);
}

/** Puts node n at world matrix m (position always, rotation with `orient`), blended by w, through its parent. */
function holdNode(rig, L, n, m, w, orient) {
  n.parent.updateWorldMatrix(true, false);
  _m1.copy(n.parent.matrixWorld).invert().multiply(m);
  _m1.decompose(_v1, _q1, _v2);
  if (maskAllows(rig, L.mask, n, 'p')) n.position.lerp(_v1, w);
  if (orient && maskAllows(rig, L.mask, n, 'q')) n.quaternion.slerp(_q1, w);
  n.updateWorldMatrix(false, true);
}

// ── (lipsync) a pose's `speech` ────────────────────────────────────────────────────────────────────────────────────────────────

/** The model's morph and bone names, for speechTargets: morphs of every morph mesh (or of `mesh`), bones first (skinned meshes' bones
 *  and Bone nodes), then any other node. */
function speechNames(rig, mesh) {
  const morphs = new Set();
  for (const m of rig.morphMeshes) {
    if (mesh && ![m.name, m.parent?.name].some((x) => x === mesh || x === sanitized(mesh))) continue;
    for (const k of Object.keys(m.morphTargetDictionary || {})) morphs.add(k);
  }
  const bones = new Set();
  rig.root.traverse((n) => { if (n.isSkinnedMesh) for (const b of n.skeleton?.bones || []) if (b.name) bones.add(b.name); if (n.isBone && n.name) bones.add(n.name); });
  const others = rig.nodes.filter((n) => n !== rig.root && n.name && !n.isMesh && !bones.has(n.name)).map((n) => n.name);
  return { morphs: [...morphs], bones: [...bones, ...others] };
}

/** A bone's axis, in its own frame, for a turn about the model's side-to-side axis (up × forward, the file's +X for a model facing +Z):
 *  a positive turn about it drops what is in front of the bone (a jaw opens, a head nods). From the rest pose, so it moves with the head. */
function lateralAxis(rig, n, forward) {
  const f = new THREE.Vector3(...(Array.isArray(forward) && forward.length === 3 ? forward.map((v) => num(Number(v), 0)) : [0, 0, 1]));
  f.y = 0;
  if (f.lengthSq() < 1e-9) f.set(0, 0, 1);
  const side = new THREE.Vector3(0, 1, 0).cross(f.normalize()).normalize();
  return side.applyQuaternion(restRotation(rig, n, new THREE.Quaternion()).invert()).normalize();
}

/** What a model speaks with for this `speech` (lipsync.js speechTargets), its jaw and head nodes and their axes: once per rig and spec. */
function speechSetup(rig, spec) {
  const key = JSON.stringify([spec.jaw ?? null, spec.head ?? null, spec.morphs ?? null, spec.mesh ?? null, spec.forward ?? null, spec.jawAxis ?? null]);
  if (rig.speechSetup?.key === key) return rig.speechSetup;
  const names = speechNames(rig, spec.mesh);
  const targets = speechTargets(names.morphs, names.bones, spec);
  const jawNode = targets.useJaw ? nodeByName(rig, targets.jaw) : null;
  const headNode = targets.head ? nodeByName(rig, targets.head) : null;
  const jawAxis = jawNode ? (Array.isArray(spec.jawAxis) && spec.jawAxis.length === 3 ? new THREE.Vector3(...spec.jawAxis.map((v) => num(Number(v), 0))).normalize() : lateralAxis(rig, jawNode, spec.forward)) : null;
  // (quality) eye bones (when the model has no eyeLook shapes): turned about the model's up axis (a dart left / right) and its side axis
  const eyes = (targets.eyeBones || []).map((b) => nodeByName(rig, b)).filter(Boolean).map((node) => ({
    node, up: new THREE.Vector3(0, 1, 0).applyQuaternion(restRotation(rig, node, new THREE.Quaternion()).invert()).normalize(), side: lateralAxis(rig, node, spec.forward),
  }));
  rig.speechSetup = { key, targets, jawNode, headNode, jawAxis, headAxis: headNode ? lateralAxis(rig, headNode, spec.forward) : null, eyes };
  return rig.speechSetup;
}

const AA = VISEMES.indexOf('aa');

/**
 * This frame's mouth for `speech` (at the pose's time t; the clock is read at the Scene's time, ctx.sceneTime): { morphs: [[name,
 * weight]], open, emphasis }, or null (said in the warnings) when there is no clock or nothing on the model to speak with.
 */
function speechFrame(rig, spec, t, ctx, warn) {
  const clocks = ctx.sceneRef?.clocks && typeof ctx.sceneRef.clocks === 'object' ? ctx.sceneRef.clocks : null;
  const name = typeof spec.clock === 'string' ? spec.clock : '';
  const def = name && clocks ? clocks[name] : null;
  if (!def || typeof def !== 'object') {
    warn('speech_no_clock', !name ? 'pose.speech needs `clock`: the Scene clock that plays the voice (scene.clocks.<name>.audio on its clip)'
      : `pose.speech: no clock "${name}" in the Scene's clocks (${clocks ? `it has ${Object.keys(clocks).join(', ') || 'none'}` : 'the model is in no 3D Scene'}): the mouth stays as the pose has it`);
    return null;
  }
  const setup = speechSetup(rig, spec);
  if (!setup.targets.set && !setup.jawNode) {
    warn('speech_no_mouth', `pose.speech: this model has no jaw bone and no mouth morphs to speak with (it looks for a bone named jaw, and jawOpen, mouthOpen, viseme_*, vrc.v_*, aa ih ou ee oh, Fcl_MTH_*): name the model's own in speech.jaw or speech.morphs`);
    return null;
  }
  const st = typeof ctx.sceneTime === 'function' ? ctx.sceneTime(t) : t;
  const mouth = rig.speechMouth ||= { open: 0, w: new Float32Array(VISEMES.length), emphasis: 0, blink: 0, lookX: 0, lookY: 0 };
  const track = def.lipsync;
  const problem = track ? lipsyncProblem(track) : 'none';
  if (track && !problem) {
    const s = def.audio && typeof def.audio === 'object' ? audioClockSongTime(def.audio, st) : st;
    lipsyncAt(track, s === null ? NaN : s, mouth);
    const env = def._envelope || def.envelope;
    const dur = Number(env?.duration), made = Number(track.source?.duration);
    if (dur > 0 && made > 0 && Math.abs(dur - made) > 0.1) warn('speech_stale', `pose.speech: clock "${name}"'s lipsync was made from a sound of ${made} s and the clock plays one of ${+dur.toFixed(2)} s: make it again (POST /api/world3d/lipsync)`);
  } else {
    if (track) warn('speech_track', `pose.speech: clock "${name}"'s lipsync cannot be read (${problem}): the jaw follows the voice's loudness`);
    const gate = num(Number(spec.gate), 0.08);
    const at = (x) => openFromLevel(clockAt(clocks, name, x) ?? 0, gate);
    mouth.w.fill(0);
    mouth.w[AA] = 1;
    mouth.open = at(st);
    mouth.emphasis = emphasisFromLevel(at, st);
    // (quality) the face's life (blinks, eye darts) comes from a lipsync's track: none from loudness alone
    mouth.blink = 0;
    mouth.lookX = 0;
    mouth.lookY = 0;
  }
  const amount = Math.max(0, num(Number(controlValue(spec, 'amount', t, 1)), 1));
  const emphasis = Math.max(0, num(Number(controlValue(spec, 'emphasis', t, 1)), 1));
  return speechWeights(setup.targets, mouth, amount, emphasis, { blink: spec.blink, eyes: spec.eyes, brows: spec.brows, cheeks: spec.cheeks });
}

/** The jaw turned open (`jawAngle` degrees at a full opening, 18 by default) and the head nodded (NOD_DEGREES at a full accent). */
function speechBones(rig, spec, frame) {
  const s = rig.speechSetup;
  if (!s) return;
  if (s.jawNode && frame.open > 0) {
    _q1.setFromAxisAngle(s.jawAxis, frame.open * num(Number(spec.jawAngle), 18) * DEG);
    s.jawNode.quaternion.multiply(_q1);
  }
  if (s.headNode && frame.emphasis > 0) {
    _q1.setFromAxisAngle(s.headAxis, frame.emphasis * NOD_DEGREES * DEG);
    s.headNode.quaternion.multiply(_q1);
  }
  // (quality) an eye dart: + x the character's own left, + y up
  if (s.eyes && s.eyes.length && (frame.lookX || frame.lookY)) {
    for (const e of s.eyes) {
      _q1.setFromAxisAngle(e.up, (frame.lookX || 0) * EYE_DEGREES * DEG);
      e.node.quaternion.multiply(_q1);
      _q1.setFromAxisAngle(e.side, -(frame.lookY || 0) * EYE_DEGREES * DEG);
      e.node.quaternion.multiply(_q1);
    }
  }
}

/** (lipsync) What this model speaks with (pose.speech): its jaw bone, head bone and mouth morph set, or nulls. */
export function mouthInfo(rig, spec = null) {
  // (realface) the pose's own speech (its `morphs` map, `jaw`, `head`) as it last posed the model, else the names found by default
  const t = !spec && rig.speechSetup ? rig.speechSetup.targets : (() => {
    const names = speechNames(rig, spec?.mesh);
    return speechTargets(names.morphs, names.bones, spec || {});
  })();
  const morphs = t.set === 'oculus' || t.set === 'vrchat' ? Object.values(t.visemes) : t.set === 'vowels' ? Object.values(t.five)
    : t.set === 'arkit' ? [t.open, ...(t.close ? [t.close] : []), ...Object.values(t.arkit)] : t.set === 'custom' ? Object.values(t.custom) : t.open ? [t.open] : [];
  // (quality) and its life: the lids that blink, whether its eyes can dart (ARKit eyeLook*), the smile / cheek on the accents
  return { set: t.set, jaw: t.jaw, jawTurns: t.useJaw, head: t.head, morphs: [...new Set(morphs)], brows: t.brows, blink: t.blink || [], eyes: !!(t.look || t.eyeBones), cheeks: t.cheeks || [] };
}

/** What an agent needs to write a pose for a file: its clips (name, seconds), morph names, and the node tree with which are bones. */
export function poseInfo(rig) {
  const bones = new Set();
  rig.root.traverse((n) => { if (n.isSkinnedMesh) for (const b of n.skeleton.bones) bones.add(b); if (n.isBone) bones.add(n); });
  const tree = rig.nodes.filter((n) => n !== rig.root).map((n) => ({ name: n.name, parent: n.parent && n.parent !== rig.root ? n.parent.name : null, bone: bones.has(n), mesh: !!n.isMesh }));
  const morphs = [...new Set(rig.morphMeshes.flatMap((m) => Object.keys(m.morphTargetDictionary || {})))];
  return { clips: [...rig.clips.values()].map((e) => ({ name: e.clip.name, duration: +e.clip.duration.toFixed(4) })), morphs, nodes: tree, mouth: mouthInfo(rig) };
}

/**
 * Whether a pose may change between two layer times, from the spec alone (the export's motion blur asks; nothing is posed): a clip that
 * plays there (weight above 0 at either end, a speed or a keyed time), any keyed control whose value differs across the span, or a
 * constraint aimed at something outside the model (a Scene object may move). Errs toward "moves".
 */
export function poseMayMove(pose, a, b, { speech = null } = {}) {
  if (!pose || typeof pose !== 'object') return false;
  const m = (a + b) / 2;
  const sampleVal = (track, x) => {
    const first = track[0]?.v;
    return typeof first === 'string' || typeof first === 'boolean' ? sampleStep(track, x) : sampleTrack(track, x);
  };
  const keyedMoves = (control) => {
    for (const track of Object.values(control?.keys || {})) {
      if (!Array.isArray(track) || !track.length) continue;
      const va = JSON.stringify(sampleVal(track, a));
      if (va !== JSON.stringify(sampleVal(track, b)) || va !== JSON.stringify(sampleVal(track, m))) return true;
    }
    return false;
  };
  // (lipsync) a speaking mouth moves while its voice's mouth changes: `speech(spec, a, b)` (the export's, which knows where the voice
  // plays) says whether it does; without it, or when it cannot tell (undefined), the mouth counts as moving
  if (pose.speech && typeof pose.speech === 'object' && pose.speech.on !== false) {
    if (keyedMoves(pose.speech)) return true;
    if ((typeof speech === 'function' ? speech(pose.speech, a, b) : undefined) !== false) return true;
  }
  const externalRef = (r) => typeof r === 'string' || (r && typeof r === 'object' && typeof r.model === 'string');
  const layers = [pose, ...(Array.isArray(pose.layers) ? pose.layers : [])];
  for (const L of layers) {
    if (!L || typeof L !== 'object') continue;
    if (L !== pose && keyedMoves(L)) return true;
    for (const c of Array.isArray(L.clips) ? L.clips : []) {
      if (!c) continue;
      if (keyedMoves(c)) return true;
      const playing = clipWeight(c, a) > 0 || clipWeight(c, b) > 0;
      if (playing && (c.keys?.time || Number(controlValue(c, 'speed', a, 1)) !== 0)) return true;
    }
    for (const v of Object.values(L.morphs || {})) if (v && typeof v === 'object' && keyedMoves(v)) return true;
    const handEntries = Array.isArray(L.hands) ? L.hands : (L.hands && typeof L.hands === 'object' ? Object.values(L.hands) : []);
    for (const h of handEntries) if (h && typeof h === 'object' && keyedMoves(h)) return true;
    for (const v of Object.values(L.bones || {})) if (keyedMoves(v)) return true;
    for (const c of Array.isArray(L.constraints) ? L.constraints : []) {
      if (!c || c.on === false) continue;
      if (keyedMoves(c)) return true;
      const refs = [c.target, c.pole, c.object, ...(Array.isArray(c.path) ? c.path : [])];
      if (refs.some(externalRef)) return true;
    }
    for (const cr of Array.isArray(L.correctives) ? L.correctives : []) {
      if (cr && cr.on !== false && keyedMoves(cr)) return true;
    }
  }
  return false;
}

/**
 * A Scene object's world matrix at scene time t, in metres, from the scene JSON alone (its `at`/`rot`/`scale` and keys, through its
 * parents; a .blend import's `matrix`): what a pose aims at when a target names an object ("@ball"). Null when there is no such object.
 * (animtools) Its drives on the scene's clocks and its follow path too (world3d/keys.js objectPose, the very pose the world gives it), so
 * a 3D Text or flat layer parented to it (`worldParent`) rides it exactly.
 */
export function sceneObjectMatrix(scene, id, t, depth = 0) {
  const objects = Array.isArray(scene?.objects) ? scene.objects : [];
  const o = objects.find((x) => x && x.id === id);
  if (!o || depth > 32) return null;
  const m = new THREE.Matrix4();
  const pose = objectPose(o, t, scene);
  const at = pose.at || [0, 0, 0], rot = pose.rot || [0, 0, 0];
  const sc = pose.scale ?? 1;
  const s = Array.isArray(sc) ? new THREE.Vector3(num(sc[0], 1), num(sc[1], 1), num(sc[2], 1)) : new THREE.Vector3().setScalar(num(Number(sc), 1));
  const q = pose.quat ? new THREE.Quaternion(...pose.quat)
    : new THREE.Quaternion().setFromEuler(new THREE.Euler(num(rot[0], 0) * DEG, num(rot[1], 0) * DEG, num(rot[2], 0) * DEG, 'XYZ'));
  if (Array.isArray(o.matrix) && o.matrix.length === 16) {
    // (screensharp) an imported part stands at its matrix; `at` moves it from there, `rot` and `scale` turn and size it about its own
    // origin in the scene's axes (WorldRenderer #importedPose): keys no longer drop the matrix
    const im = new THREE.Matrix4().fromArray(o.matrix);
    const org = new THREE.Vector3().setFromMatrixPosition(im);
    m.compose(new THREE.Vector3(num(at[0], 0), num(at[1], 0), num(at[2], 0)).add(org), q, s)
      .multiply(new THREE.Matrix4().makeTranslation(-org.x, -org.y, -org.z)).multiply(im);
  } else {
    m.compose(new THREE.Vector3(num(at[0], 0), num(at[1], 0), num(at[2], 0)), q, s);
  }
  if (o.parent) {
    const p = sceneObjectMatrix(scene, o.parent, t, depth + 1);
    if (p) m.premultiply(p);
  }
  return m;
}

/** Metres (the Scene's units) to the editor's 3D space (one unit per composition pixel, WORLD_UNITS = 0.001), and back: translation only. */
export const metresToEditor = (m) => { const e = m.elements; e[12] *= 1000; e[13] *= 1000; e[14] *= 1000; return m; };
export const editorToMetres = (m) => { const e = m.elements; e[12] /= 1000; e[13] /= 1000; e[14] /= 1000; return m; };
