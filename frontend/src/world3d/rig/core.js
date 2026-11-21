// (rigging) A rig made for meshes: the joints (rig/joints.js), every vertex's four influences (rig/weights.js: heat diffusion or rigid,
// then smoothing and the agent's manual fixes) and a report. Pure: plain arrays in and out, so the editor and the world (two threes)
// make the same rig from the same JSON.
//
// `skeleton` (model3dConfig.skeleton on a model layer, `skeleton` on a Scene object):
//   template      "biped" | "quadruped": joints from landmark points; `landmarks` { name: [x, y, z] } the agent gives, the rest found from
//                 the mesh's shape (`symmetric`, default true: a ".L" point given alone also places its ".R" across the middle)
//   joints        [{ name, parent, at, tail, rot }]: written out, or added to / replacing a template's joints of the same name
//   skinning      "dualQuaternion" (default: every blend a rigid motion, rig/dualQuat.js) | "linear" (three's own linear blend)
//   bind          "skin" (default: smooth weights that bend the surface) | "rigid" (each connected part follows the one joint that holds most
//                 of it; a model file's meshes by name with `parts`: { "<mesh>": "<joint>" })
//   weights       { smooth: passes (0), threshold: 0.01, visibility: true }
//   fixes         [{ joint, value, mode: set|add|multiply|max|min, strength, and where: group / box / sphere / near / mesh / of }]
//                 or [{ smooth: passes, strength, where … }]: manual weight edits, in order, after the automatic weights
//   clips         [{ name, duration, bones: { "<joint>": { rot | at | scale: [{ t, v, ease }] } } }]: animations made of keys on the joints
//                 (rig/bind.js), played by the pose pipeline like a file's own clips
//
// Space: the mesh's own, as joints.js says.

import { surfaceOf, heatWeights, rigidWeights, normalizeRows, smoothWeights, packInfluences } from './weights.js';
import { resolveJoints, jointSegments } from './joints.js';

export const FIX_MODES = ['set', 'add', 'multiply', 'max', 'min'];
export const RIG_BINDS = ['skin', 'rigid'];

const isPoint = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const smoothstep = (x) => { const s = Math.min(1, Math.max(0, x)); return s * s * (3 - 2 * s); };

/** Meshes joined into one: positions, triangles and each vertex's mesh; vertex groups by name (0 where a mesh lacks one). */
function joinMeshes(meshes) {
  let n = 0, t = 0;
  for (const m of meshes) { n += m.position.length / 3; t += m.index ? m.index.length : m.position.length / 3; }
  const position = new Float32Array(n * 3), index = new Uint32Array(t), meshOf = new Int32Array(n);
  const groups = {};
  let vo = 0, to = 0;
  meshes.forEach((m, k) => {
    const c = m.position.length / 3;
    position.set(m.position, vo * 3);
    meshOf.fill(k, vo, vo + c);
    if (m.index) { for (let i = 0; i < m.index.length; i += 1) index[to + i] = m.index[i] + vo; to += m.index.length; } else { for (let i = 0; i < c; i += 1) index[to + i] = vo + i; to += c; }
    for (const [name, w] of Object.entries(m.groups || {})) {
      if (!w || w.length !== c) continue;
      groups[name] ||= new Float32Array(n);
      groups[name].set(w, vo);
    }
    vo += c;
  });
  return { position, index, meshOf, groups };
}

/** The share 0..1 of point i a fix's `where` takes (all its selectors at once: their product). */
function whereMask(fix, S, joined, meshes, W, J, jointIndex, warn) {
  const { m, P } = S;
  const mask = new Float32Array(m).fill(1);
  const firstVertex = new Int32Array(m).fill(-1);
  for (let v = 0; v < S.n; v += 1) if (firstVertex[S.pid[v]] < 0) firstVertex[S.pid[v]] = v;
  if (fix.group != null) {
    const key = String(fix.group).replace(/^group:/, '');
    const g = joined.groups[key] || joined.groups[`group:${key}`];
    if (!g) { warn(`skeleton: fix group "${fix.group}" is not a vertex group of this mesh (${Object.keys(joined.groups).join(', ') || 'none'})`); mask.fill(0); return mask; }
    // a point is as much in the group as the most of its vertices
    const best = new Float32Array(m);
    for (let v = 0; v < S.n; v += 1) best[S.pid[v]] = Math.max(best[S.pid[v]], g[v]);
    for (let i = 0; i < m; i += 1) mask[i] *= best[i];
  }
  if (fix.mesh != null) {
    const k = meshes.findIndex((x) => x.name === fix.mesh);
    if (k < 0) { warn(`skeleton: fix mesh "${fix.mesh}" is not one of this model's meshes`); mask.fill(0); return mask; }
    for (let i = 0; i < m; i += 1) mask[i] *= joined.meshOf[firstVertex[i]] === k ? 1 : 0;
  }
  if (fix.box && isPoint(fix.box.min) && isPoint(fix.box.max)) {
    const soft = Math.max(0, num(fix.soft, 0));
    for (let i = 0; i < m; i += 1) {
      let k = 1;
      for (let a = 0; a < 3; a += 1) {
        const p = P[i * 3 + a], lo = fix.box.min[a], hi = fix.box.max[a];
        const out = p < lo ? lo - p : p > hi ? p - hi : 0;
        k *= soft > 0 ? 1 - smoothstep(out / soft) : out > 0 ? 0 : 1;
      }
      mask[i] *= k;
    }
  }
  const radial = fix.sphere || fix.near;
  if (radial && isPoint(radial.at)) {
    // `sphere`: all of it inside, fading over its last `soft` metres; `near`: all of it within `inner`, fading out to `radius` by `falloff`
    const r = Math.max(1e-9, num(radial.radius, 0.1));
    const inner = fix.sphere ? Math.max(0, r - Math.max(0, num(fix.soft, 0))) : Math.min(r, Math.max(0, num(radial.inner, 0)));
    const curve = fix.sphere ? 'smooth' : (['linear', 'sharp', 'smooth'].includes(radial.falloff) ? radial.falloff : 'smooth');
    for (let i = 0; i < m; i += 1) {
      const d = Math.hypot(P[i * 3] - radial.at[0], P[i * 3 + 1] - radial.at[1], P[i * 3 + 2] - radial.at[2]);
      let k;
      if (d > r) k = 0;
      else if (d <= inner || curve === 'sharp') k = 1;
      else { const x = (d - inner) / (r - inner); k = curve === 'linear' ? 1 - x : 1 - smoothstep(x); }
      mask[i] *= k;
    }
  }
  if (fix.of != null) {
    // the points a joint holds most
    const j = jointIndex.get(fix.of);
    if (j === undefined) { warn(`skeleton: fix "of" joint "${fix.of}" is not a joint`); mask.fill(0); return mask; }
    for (let i = 0; i < m; i += 1) {
      let best = 0;
      for (let l = 1; l < J; l += 1) if (W[i * J + l] > W[i * J + best]) best = l;
      mask[i] *= best === j ? 1 : 0;
    }
  }
  const strength = Math.min(1, Math.max(0, num(fix.strength, 1)));
  if (strength !== 1) for (let i = 0; i < m; i += 1) mask[i] *= strength;
  return mask;
}

/** One `set`/`add`/… fix: the joint's weight moves toward its target by the mask, the other joints share what is left as they did. */
function applyValueFix(fix, mask, W, m, J, j, joints) {
  const mode = FIX_MODES.includes(fix.mode) ? fix.mode : 'set';
  const value = num(fix.value, mode === 'multiply' ? 1 : mode === 'add' ? 0 : 1);
  let touched = 0;
  for (let i = 0; i < m; i += 1) {
    const k = mask[i];
    if (!(k > 0)) continue;
    const old = W[i * J + j];
    const target = mode === 'set' ? value : mode === 'add' ? old + value : mode === 'multiply' ? old * value : mode === 'max' ? Math.max(old, value) : Math.min(old, value);
    const next = Math.min(1, Math.max(0, old + (target - old) * k));
    if (next === old) continue;
    touched += 1;
    let others = 0;
    for (let l = 0; l < J; l += 1) if (l !== j) others += W[i * J + l];
    W[i * J + j] = next;
    if (others > 0) {
      const scale = (1 - next) / others;
      for (let l = 0; l < J; l += 1) if (l !== j) W[i * J + l] *= scale;
    } else if (next < 1) {
      // nothing else held this point: what the joint gave up goes to its parent (a root keeps it all)
      const p = joints[j].parent;
      if (p >= 0) W[i * J + p] = 1 - next; else W[i * J + j] = 1;
    }
  }
  return touched;
}

/**
 * The rig for these meshes. `meshes`: [{ name, position (in the rig's space), index, groups: { name: Float32Array per vertex } }].
 * Returns { joints, landmarks, found, influences: [{ skinIndex, skinWeight }] per mesh, warnings, report }.
 */
export function computeRig(spec, meshes) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const warnings = [];
  const seen = new Set();
  const warn = (msg) => { if (!seen.has(msg)) { seen.add(msg); warnings.push(msg); } };
  const joined = joinMeshes(meshes);
  const S = surfaceOf(joined.position, joined.index);
  const { joints, landmarks, found, warnings: jw } = resolveJoints(spec, S);
  jw.forEach(warn);
  const J = joints.length;
  if (!J) {
    warn('skeleton: no joints (give `joints`, or a `template` with `landmarks`)');
    return { joints, landmarks, found, influences: null, warnings, report: { joints: 0 } };
  }
  const jointIndex = new Map(joints.map((j, i) => [j.name, i]));
  const opts = spec.weights && typeof spec.weights === 'object' ? spec.weights : {};
  const { W, stats } = heatWeights(S, jointSegments(joints), J, { visibility: opts.visibility !== false, parents: joints.map((j) => j.parent) });
  const bind = RIG_BINDS.includes(spec.bind) ? spec.bind : 'skin';
  let owners = null;
  if (bind === 'rigid') owners = rigidWeights(S, W, J);
  // a model file's meshes by name, each following one joint
  if (spec.parts && typeof spec.parts === 'object') {
    for (const [meshName, jointName] of Object.entries(spec.parts)) {
      const k = meshes.findIndex((x) => x.name === meshName);
      const j = jointIndex.get(jointName);
      if (k < 0) { warn(`skeleton: parts names mesh "${meshName}", which this model does not have`); continue; }
      if (j === undefined) { warn(`skeleton: parts gives mesh "${meshName}" to joint "${jointName}", which is not a joint`); continue; }
      for (let v = 0; v < S.n; v += 1) {
        if (joined.meshOf[v] !== k) continue;
        const i = S.pid[v];
        for (let l = 0; l < J; l += 1) W[i * J + l] = 0;
        W[i * J + j] = 1;
      }
    }
  }
  normalizeRows(W, S.m, J);
  const passes = Math.max(0, Math.min(50, Math.round(num(opts.smooth, 0))));
  if (passes && bind === 'skin') { smoothWeights(S, W, J, { iterations: passes, strength: 0.5 }); normalizeRows(W, S.m, J); }
  // the agent's own edits, in order
  const fixes = [];
  for (const [k, fix] of (Array.isArray(spec.fixes) ? spec.fixes : []).entries()) {
    if (!fix || typeof fix !== 'object') continue;
    const mask = whereMask(fix, S, joined, meshes, W, J, jointIndex, warn);
    let touched = 0;
    if (Number.isFinite(Number(fix.smooth)) && fix.joint == null) {
      smoothWeights(S, W, J, { iterations: Math.max(1, Math.min(50, Math.round(Number(fix.smooth)))), strength: 0.5, mask });
      normalizeRows(W, S.m, J);
      for (let i = 0; i < S.m; i += 1) if (mask[i] > 0) touched += 1;
    } else {
      const j = jointIndex.get(fix.joint);
      if (j === undefined) { warn(`skeleton: fix ${k} names joint "${fix.joint}", which is not a joint`); continue; }
      touched = applyValueFix(fix, mask, W, S.m, J, j, joints);
    }
    if (!touched) warn(`skeleton: fix ${k} touched no point (its region is empty)`);
    fixes.push({ fix: k, points: touched });
  }
  const threshold = Math.min(0.5, Math.max(0, num(opts.threshold, 0.01)));
  const packed = packInfluences(S, W, J, { threshold });
  // back to each mesh
  const influences = [];
  let vo = 0;
  for (const mesh of meshes) {
    const c = mesh.position.length / 3;
    influences.push({ skinIndex: packed.skinIndex.slice(vo * 4, (vo + c) * 4), skinWeight: packed.skinWeight.slice(vo * 4, (vo + c) * 4) });
    vo += c;
  }
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  const report = {
    joints: J, bind, vertices: S.n, points: S.m, triangles: stats.triangles, parts: S.islands,
    unseen: stats.unseen, fallback: stats.fallback, solves: stats.solves, iterations: stats.iterations, influencesMost: packed.most,
    ...(owners ? { partJoints: Array.from(owners, (j) => joints[j].name) } : {}),
    ...(fixes.length ? { fixes } : {}), ms: +ms.toFixed(1),
  };
  return { joints, landmarks, found, influences, warnings, report, W, S };
}
