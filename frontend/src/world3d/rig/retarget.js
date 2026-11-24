// (rigging, 4A.1) Humanoid motion retargeting onto world3d's `biped` skeleton (BVH + Three.js AnimationClip).
// Pure math over rest-pose deltas + optional limb rest-pose alignment + hip height scaling + in-place root option.
import * as THREE from 'three';
import { TEMPLATES } from './joints.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

export const BIPED_DEFAULT_JOINTS = [
  { name: 'hips', parent: null, at: [0, 0.95, 0] },
  { name: 'spine', parent: 'hips', at: [0, 1.12, 0] },
  { name: 'chest', parent: 'spine', at: [0, 1.30, 0] },
  { name: 'neck', parent: 'chest', at: [0, 1.46, 0] },
  { name: 'head', parent: 'neck', at: [0, 1.56, 0], tail: [0, 1.75, 0] },
  { name: 'upperArm.L', parent: 'chest', at: [0.18, 1.40, 0] },
  { name: 'forearm.L', parent: 'upperArm.L', at: [0.44, 1.40, 0] },
  { name: 'hand.L', parent: 'forearm.L', at: [0.68, 1.40, 0], tail: [0.80, 1.40, 0] },
  { name: 'upperArm.R', parent: 'chest', at: [-0.18, 1.40, 0] },
  { name: 'forearm.R', parent: 'upperArm.R', at: [-0.44, 1.40, 0] },
  { name: 'hand.R', parent: 'forearm.R', at: [-0.68, 1.40, 0], tail: [-0.80, 1.40, 0] },
  { name: 'thigh.L', parent: 'hips', at: [0.095, 0.88, 0] },
  { name: 'shin.L', parent: 'thigh.L', at: [0.095, 0.48, 0] },
  { name: 'foot.L', parent: 'shin.L', at: [0.095, 0.08, 0] },
  { name: 'toe.L', parent: 'foot.L', at: [0.095, 0.03, 0.14], tail: [0.095, 0.03, 0.20] },
  { name: 'thigh.R', parent: 'hips', at: [-0.095, 0.88, 0] },
  { name: 'shin.R', parent: 'thigh.R', at: [-0.095, 0.48, 0] },
  { name: 'foot.R', parent: 'shin.R', at: [-0.095, 0.08, 0] },
  { name: 'toe.R', parent: 'foot.R', at: [-0.095, 0.03, 0.14], tail: [-0.095, 0.03, 0.20] },
];

const LIMB_JOINTS = new Set([
  'upperArm.L', 'forearm.L', 'hand.L', 'upperArm.R', 'forearm.R', 'hand.R',
  'thigh.L', 'shin.L', 'foot.L', 'toe.L', 'thigh.R', 'shin.R', 'foot.R', 'toe.R',
]);

function normalizeToken(raw) {
  let s = String(raw || '').trim();
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (slash >= 0) s = s.slice(slash + 1);
  const colon = s.lastIndexOf(':');
  if (colon >= 0) s = s.slice(colon + 1);
  s = s.replace(/^(?:bip01|bip|valvebiped|cc_base|character\d+|rig|def|org|mch|jnt|bn)[_.\-\s]+/i, '');
  let side = null;
  if (/(?:^|[._\-\s])(l|left)$/i.test(s) || /^(?:l|left)[._\-\s]/i.test(s) || /^(?:[Ll]eft|LEFT|L)(?=[A-Z])/.test(s)) side = 'L';
  else if (/(?:^|[._\-\s])(r|right)$/i.test(s) || /^(?:r|right)[._\-\s]/i.test(s) || /^(?:[Rr]ight|RIGHT|R)(?=[A-Z])/.test(s)) side = 'R';
  let core = s
    .replace(/(?:[._\-\s])(l|r|left|right)$/i, '')
    .replace(/^(?:l|r|left|right)[._\-\s]/i, '')
    .replace(/^(?:[Ll]eft|[Rr]ight|LEFT|RIGHT|L|R)(?=[A-Z])/, '')
    .replace(/[\s._-]+/g, '')
    .toLowerCase();
  return { core, side };
}

const CENTER_MAP = {
  hips: 'hips', pelvis: 'hips', root: 'hips', cog: 'hips', hip: 'hips', mixamorighips: 'hips',
  spine: 'spine', spine0: 'spine', spine01: 'spine', spine1: 'spine1', lowerback: 'spine', waist: 'spine',
  chest: 'chest', upperchest: 'chest', torso: 'chest', spine2: 'chest', spine02: 'chest', spine03: 'chest', ribcage: 'chest',
  neck: 'neck', neck1: 'neck', neck01: 'neck',
  head: 'head', head1: 'head', skull: 'head',
};

const SIDE_MAP = {
  upperarm: 'upperArm', arm: 'upperArm', shoulderarm: 'upperArm', humerus: 'upperArm', uparm: 'upperArm',
  forearm: 'forearm', lowerarm: 'forearm', elbow: 'forearm', radius: 'forearm',
  hand: 'hand', wrist: 'hand', palm: 'hand',
  thigh: 'thigh', upleg: 'thigh', upperleg: 'thigh', femur: 'thigh', hip: 'thigh', leg: 'thigh',
  shin: 'shin', calf: 'shin', lowerleg: 'shin', leglower: 'shin', knee: 'shin', tibia: 'shin',
  foot: 'foot', ankle: 'foot', heel: 'foot',
  toe: 'toe', toebase: 'toe', ball: 'toe', toes: 'toe',
};

/** Maps Mixamo, Unreal, CMU, Rigify, VRM, or generic humanoid bone names to world3d `biped` canonical names. */
export function mapHumanoidBoneName(name) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (TEMPLATES.biped.joints.some((j) => j.name === trimmed)) return trimmed;
  const { core, side } = normalizeToken(trimmed);
  if (!core) return null;
  if (!side) {
    if (core === 'spine1') return 'spine1'; // collapsed dynamically when chest exists
    return CENTER_MAP[core] || null;
  }
  const mapped = SIDE_MAP[core];
  return mapped ? `${mapped}.${side}` : null;
}

/** Resolves full source->target joint name mapping, handling multi-segment spines cleanly (Mixamo Spine/Spine1/Spine2). */
export function buildHumanoidMapping(sourceNames, targetNames, overrides = null) {
  const targetSet = new Set(targetNames);
  const direct = {};
  const spineCandidates = [];
  for (const raw of sourceNames) {
    if (overrides && typeof overrides[raw] === 'string' && targetSet.has(overrides[raw])) {
      direct[raw] = overrides[raw];
      continue;
    }
    const cand = mapHumanoidBoneName(raw);
    if (!cand) continue;
    if (cand === 'spine' || cand === 'spine1' || cand === 'chest') {
      spineCandidates.push({ raw, cand });
      continue;
    }
    if (targetSet.has(cand) && !Object.values(direct).includes(cand)) direct[raw] = cand;
  }
  if (spineCandidates.length) {
    if (targetSet.has('chest') && spineCandidates.some((s) => s.cand === 'chest')) {
      const ch = spineCandidates.find((s) => s.cand === 'chest');
      direct[ch.raw] = 'chest';
      const sp = spineCandidates.find((s) => s.cand === 'spine') || spineCandidates.find((s) => s.cand === 'spine1');
      if (sp && targetSet.has('spine')) direct[sp.raw] = 'spine';
    } else if (spineCandidates.length >= 2 && targetSet.has('chest') && targetSet.has('spine')) {
      direct[spineCandidates[0].raw] = 'spine';
      direct[spineCandidates[spineCandidates.length - 1].raw] = 'chest';
    } else {
      const sp = spineCandidates[0];
      const tgt = targetSet.has(sp.cand) ? sp.cand : (targetSet.has('spine') ? 'spine' : null);
      if (tgt) direct[sp.raw] = tgt;
    }
  }
  return direct;
}

/** Parses standard `.bvh` motion capture text (arbitrary rotation orders and root translation). */
export function parseBVH(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('parseBVH: empty BVH text');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const joints = [];
  const stack = [];
  const channels = [];
  let inMotion = false;
  let frameCount = 0;
  let frameTime = 1 / 30;
  const motionNumbers = [];

  const nextTokens = () => {
    while (i < lines.length) {
      const raw = lines[i++].trim();
      if (!raw || raw.startsWith('#')) continue;
      return raw.split(/\s+/);
    }
    return null;
  };

  while (i < lines.length) {
    const raw = lines[i++].trim();
    if (!raw || raw.startsWith('#')) continue;
    if (raw === 'MOTION') { inMotion = true; break; }
    const toks = raw.split(/\s+/);
    const kw = toks[0];
    if (kw === 'HIERARCHY') continue;
    if (kw === 'ROOT' || kw === 'JOINT') {
      const name = raw.slice(kw.length).trim();
      const parent = stack.length ? stack[stack.length - 1] : -1;
      const idx = joints.length;
      joints.push({ name, parent, offset: [0, 0, 0], tail: null, rotChannels: [], posChannels: [] });
      stack.push(idx);
      const brace = nextTokens();
      if (!brace || brace[0] !== '{') throw new Error(`parseBVH: expected "{" after ${kw} ${name}`);
    } else if (kw === 'End') {
      const brace = nextTokens();
      if (!brace || brace[0] !== '{') throw new Error('parseBVH: expected "{" after End Site');
      stack.push('END');
    } else if (kw === 'OFFSET') {
      const off = [Number(toks[1]) || 0, Number(toks[2]) || 0, Number(toks[3]) || 0];
      const top = stack[stack.length - 1];
      if (top === 'END') {
        const p = stack[stack.length - 2];
        if (typeof p === 'number') joints[p].tail = off;
      } else if (typeof top === 'number') {
        joints[top].offset = off;
      }
    } else if (kw === 'CHANNELS') {
      const top = stack[stack.length - 1];
      if (typeof top !== 'number') continue;
      const n = Number(toks[1]) || 0;
      for (let k = 0; k < n; k += 1) {
        const ch = toks[2 + k];
        const col = channels.length;
        channels.push({ joint: top, name: ch });
        const mPos = /^([XYZ])position$/i.exec(ch || '');
        const mRot = /^([XYZ])rotation$/i.exec(ch || '');
        if (mPos) joints[top].posChannels.push({ axis: 'XYZ'.indexOf(mPos[1].toUpperCase()), col });
        else if (mRot) joints[top].rotChannels.push({ axis: mRot[1].toUpperCase(), col });
      }
    } else if (kw === '}') {
      stack.pop();
    }
  }

  if (!inMotion || !joints.length) throw new Error('parseBVH: missing HIERARCHY joints or MOTION section');
  while (i < lines.length) {
    const raw = lines[i++].trim();
    if (!raw || raw.startsWith('#')) continue;
    const mFrames = /^Frames:\s*(\d+)/i.exec(raw);
    if (mFrames) { frameCount = Number(mFrames[1]); continue; }
    const mTime = /^Frame\s+Time:\s*([-+0-9.eE]+)/i.exec(raw);
    if (mTime) { frameTime = Math.max(1e-5, Number(mTime[1]) || (1 / 30)); continue; }
    for (const tok of raw.split(/\s+/)) {
      const v = Number(tok);
      if (Number.isFinite(v)) motionNumbers.push(v);
    }
  }
  const stride = channels.length;
  const actualFrames = stride > 0 ? Math.min(frameCount || Infinity, Math.floor(motionNumbers.length / stride)) : 0;
  const frames = [];
  const axVec = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) };
  const qTmp = new THREE.Quaternion();
  for (let f = 0; f < actualFrames; f += 1) {
    const base = f * stride;
    const localRot = [];
    const localPos = [];
    for (let j = 0; j < joints.length; j += 1) {
      const jd = joints[j];
      if (jd.posChannels.length) {
        const p = [jd.offset[0], jd.offset[1], jd.offset[2]];
        // Standard BVH replaces offset when 6-channel X/Y/Zposition is present on root
        const zeroed = [0, 0, 0];
        for (const c of jd.posChannels) zeroed[c.axis] = motionNumbers[base + c.col];
        p[0] = zeroed[0]; p[1] = zeroed[1]; p[2] = zeroed[2];
        localPos.push(p);
      } else {
        localPos.push(null);
      }
      const q = new THREE.Quaternion();
      for (const c of jd.rotChannels) {
        qTmp.setFromAxisAngle(axVec[c.axis], motionNumbers[base + c.col] * DEG);
        q.multiply(qTmp);
      }
      localRot.push(q);
    }
    frames.push({ localRot, localPos });
  }
  const duration = actualFrames > 1 ? (actualFrames - 1) * frameTime : frameTime;
  return { joints, frames, frameTime, duration };
}

/** Normalizes joints list into parent-first indexed list. */
function normalizeTargetJoints(jointsSpec) {
  const raw = Array.isArray(jointsSpec) && jointsSpec.length ? jointsSpec : BIPED_DEFAULT_JOINTS;
  const idxMap = new Map();
  const list = raw.map((j, i) => {
    idxMap.set(j.name, i);
    return {
      name: j.name,
      parentRef: j.parent,
      at: isVec3(j.at) ? j.at.slice() : [0, 0, 0],
      tail: isVec3(j.tail) ? j.tail.slice() : null,
      rot: isVec3(j.rot) ? j.rot.slice() : null,
    };
  });
  return list.map((j, i) => ({
    ...j,
    parent: typeof j.parentRef === 'number' ? j.parentRef : (typeof j.parentRef === 'string' && idxMap.has(j.parentRef) ? idxMap.get(j.parentRef) : -1),
    index: i,
  }));
}

function sourceFromThree(root, clip) {
  const nodes = [];
  const nodeIndex = new Map();
  root.updateMatrixWorld(true);
  root.traverse((n) => {
    if (n === root && !n.name && n.children.length === 1) return;
    const parent = nodeIndex.has(n.parent) ? nodeIndex.get(n.parent) : -1;
    const idx = nodes.length;
    nodeIndex.set(n, idx);
    nodes.push({
      node: n,
      name: n.name || `joint_${idx}`,
      parent,
      restPos: n.position.clone(),
      restQ: n.quaternion.clone(),
      tail: null,
    });
  });
  const dur = Math.max(0.001, Number(clip.duration) || 1);
  const fps = 30;
  const nFrames = Math.max(2, Math.round(dur * fps) + 1);
  const frameTime = nFrames > 1 ? dur / (nFrames - 1) : dur;
  const bound = [];
  for (const tr of clip.tracks || []) {
    let parsed;
    try { parsed = THREE.PropertyBinding.parseTrackName(tr.name); } catch { continue; }
    const n = THREE.PropertyBinding.findNode(root, parsed.nodeName);
    if (!n || !nodeIndex.has(n)) continue;
    const jIdx = nodeIndex.get(n);
    if (parsed.propertyName === 'quaternion') bound.push({ jIdx, prop: 'q', interp: tr.createInterpolant() });
    else if (parsed.propertyName === 'position') bound.push({ jIdx, prop: 'p', interp: tr.createInterpolant() });
  }
  const frames = [];
  for (let f = 0; f < nFrames; f += 1) {
    const t = Math.min(dur, f * frameTime);
    const localRot = nodes.map((x) => x.restQ.clone());
    const localPos = nodes.map(() => null);
    for (const b of bound) {
      const v = b.interp.evaluate(t);
      if (b.prop === 'q') localRot[b.jIdx].fromArray(v).normalize();
      else if (b.prop === 'p') localPos[b.jIdx] = [v[0], v[1], v[2]];
    }
    frames.push({ localRot, localPos });
  }
  return {
    joints: nodes.map((x) => ({
      name: x.name,
      parent: x.parent,
      offset: x.restPos.toArray(),
      tail: null,
      restQ: x.restQ,
    })),
    frames,
    frameTime,
    duration: dur,
  };
}

function computeRestWorld(joints) {
  const worldPos = [];
  const worldQ = [];
  for (let i = 0; i < joints.length; i += 1) {
    const j = joints[i];
    const pIdx = j.parent;
    const pq = pIdx >= 0 ? worldQ[pIdx] : new THREE.Quaternion();
    const pp = pIdx >= 0 ? worldPos[pIdx] : new THREE.Vector3();
    const lq = j.restQ ? j.restQ.clone()
      : (j.rot ? new THREE.Quaternion().setFromEuler(new THREE.Euler(j.rot[0] * DEG, j.rot[1] * DEG, j.rot[2] * DEG, 'XYZ')) : new THREE.Quaternion());
    worldQ.push(pq.clone().multiply(lq));
    const off = j.offset ? new THREE.Vector3(...j.offset) : null;
    if (off) {
      worldPos.push(pp.clone().add(off.applyQuaternion(pq)));
    } else {
      worldPos.push(new THREE.Vector3(...(j.at || [0, 0, 0])));
    }
  }
  return { worldPos, worldQ };
}

function childDirections(joints, worldPos) {
  const dirs = new Array(joints.length).fill(null);
  const children = Array.from({ length: joints.length }, () => []);
  joints.forEach((j, i) => { if (j.parent >= 0) children[j.parent].push(i); });
  for (let i = 0; i < joints.length; i += 1) {
    let tip = null;
    if (children[i].length === 1) tip = worldPos[children[i][0]];
    else if (children[i].length > 1) {
      tip = new THREE.Vector3();
      for (const k of children[i]) tip.add(worldPos[k]);
      tip.divideScalar(children[i].length);
    } else if (isVec3(joints[i].tail)) {
      tip = joints[i].offset ? worldPos[i].clone().add(new THREE.Vector3(...joints[i].tail)) : new THREE.Vector3(...joints[i].tail);
    }
    if (tip) {
      const d = tip.clone().sub(worldPos[i]);
      if (d.lengthSq() > 1e-8) dirs[i] = d.normalize();
    }
  }
  return dirs;
}

/**
 * Retargets a humanoid BVH or Three.js clip onto `targetJoints` (e.g. world3d `biped` skeleton joints).
 * Returns `{ clip: { name, duration, bones }, mapping, unmappedSource, unmappedTarget, hipScale, warnings }`.
 */
export function retargetMotionToRig(source, targetJoints = null, opts = {}) {
  const warnings = [];
  const parsed = typeof source === 'string'
    ? parseBVH(source)
    : (source?.root && source?.clip ? sourceFromThree(source.root, source.clip) : source);
  if (!parsed?.joints?.length || !parsed?.frames?.length) {
    throw new Error('retargetMotionToRig: invalid or empty motion source');
  }
  const target = normalizeTargetJoints(targetJoints);
  const tIndex = new Map(target.map((j, i) => [j.name, i]));
  const sIndex = new Map(parsed.joints.map((j, i) => [j.name, i]));
  const mapping = buildHumanoidMapping(parsed.joints.map((j) => j.name), target.map((j) => j.name), opts.map);
  const tgtToSrc = new Map();
  for (const [sn, tn] of Object.entries(mapping)) tgtToSrc.set(tIndex.get(tn), sIndex.get(sn));

  const unmappedSource = parsed.joints.map((j) => j.name).filter((n) => !(n in mapping));
  const unmappedTarget = target.map((j) => j.name).filter((_, i) => !tgtToSrc.has(i));
  if (!tgtToSrc.size) warnings.push('retarget: no source bones matched any target joint');

  const sRest = computeRestWorld(parsed.joints);
  const tRest = computeRestWorld(target);
  const tLocalRestQ = target.map((j) => (j.rot
    ? new THREE.Quaternion().setFromEuler(new THREE.Euler(j.rot[0] * DEG, j.rot[1] * DEG, j.rot[2] * DEG, 'XYZ'))
    : new THREE.Quaternion()));

  // Hip height scale: ratio of target hips height above feet/minY vs source hips height above minY
  const sHipIdx = tgtToSrc.get(tIndex.get('hips')) ?? 0;
  const sYs = sRest.worldPos.map((p) => p.y);
  const sMinY = Math.min(...sYs);
  const sHipHeight = Math.max(1e-4, sRest.worldPos[sHipIdx].y - sMinY);
  const tHipIdx = tIndex.get('hips') ?? 0;
  const tYs = tRest.worldPos.map((p) => p.y);
  const tMinY = Math.min(...tYs);
  const tHipHeight = Math.max(1e-4, tRest.worldPos[tHipIdx].y - tMinY);
  const hipScale = Number.isFinite(Number(opts.scale)) ? Number(opts.scale) : +(tHipHeight / sHipHeight).toFixed(6);

  // Rest-limb direction alignment (e.g. T-pose BVH onto A-pose biped character)
  const sDirs = childDirections(parsed.joints, sRest.worldPos);
  const tDirs = childDirections(target, tRest.worldPos);
  const qBind = target.map((j, ti) => {
    if (opts.alignRest === false || !LIMB_JOINTS.has(j.name)) return new THREE.Quaternion();
    const si = tgtToSrc.get(ti);
    if (si === undefined || !sDirs[si] || !tDirs[ti]) return new THREE.Quaternion();
    const dot = THREE.MathUtils.clamp(tDirs[ti].dot(sDirs[si]), -1, 1);
    if (dot > 0.9999) return new THREE.Quaternion();
    return new THREE.Quaternion().setFromUnitVectors(tDirs[ti], sDirs[si]);
  });

  // Compute source root reference position for relative delta
  const sHipRestPos = sRest.worldPos[sHipIdx].clone();
  const inPlace = Boolean(opts.inPlace);
  const frameStep = Math.max(1, Math.round(Number(opts.stride) || 1));
  const bones = Object.fromEntries(target.map((j) => [j.name, { rot: [] }]));
  if (bones[target[tHipIdx].name]) bones[target[tHipIdx].name].at = [];

  const eOut = new THREE.Euler(0, 0, 0, 'XYZ');
  const dt = parsed.frameTime || (1 / 30);
  let lastT = 0;

  for (let f = 0; f < parsed.frames.length; f += frameStep) {
    const t = +(f * dt).toFixed(5);
    lastT = t;
    const fr = parsed.frames[f];
    const sWorldQ = new Array(parsed.joints.length);
    const sWorldPos = new Array(parsed.joints.length);
    for (let si = 0; si < parsed.joints.length; si += 1) {
      const j = parsed.joints[si];
      const pi = j.parent;
      const pq = pi >= 0 ? sWorldQ[pi] : new THREE.Quaternion();
      const pp = pi >= 0 ? sWorldPos[pi] : new THREE.Vector3();
      const lq = fr.localRot[si] || new THREE.Quaternion();
      sWorldQ[si] = pq.clone().multiply(lq);
      const lp = fr.localPos[si] ? new THREE.Vector3(...fr.localPos[si]) : new THREE.Vector3(...(j.offset || [0, 0, 0]));
      sWorldPos[si] = pi >= 0 ? pp.clone().add(lp.applyQuaternion(pq)) : lp;
    }

    const tWorldQ = new Array(target.length);
    for (let ti = 0; ti < target.length; ti += 1) {
      const pi = target[ti].parent;
      const pq = pi >= 0 ? tWorldQ[pi] : new THREE.Quaternion();
      const si = tgtToSrc.get(ti);
      if (si !== undefined) {
        // Δ_w = R_s(t) * R_s,rest^-1; R_d(t) = Δ_w * qBind * R_d,rest
        const deltaW = sWorldQ[si].clone().multiply(sRest.worldQ[si].clone().invert());
        tWorldQ[ti] = deltaW.multiply(qBind[ti]).multiply(tRest.worldQ[ti]);
      } else {
        tWorldQ[ti] = pq.clone().multiply(tLocalRestQ[ti]);
      }
      const qLocal = pq.clone().invert().multiply(tWorldQ[ti]);
      // bind.js multiplies track rotation AFTER rest.quaternion: q_local = q_rest * q_track => q_track = q_rest^-1 * q_local
      const qTrack = tLocalRestQ[ti].clone().invert().multiply(qLocal);
      eOut.setFromQuaternion(qTrack, 'XYZ');
      const deg = [+(eOut.x * RAD).toFixed(3), +(eOut.y * RAD).toFixed(3), +(eOut.z * RAD).toFixed(3)];
      if (si !== undefined) {
        bones[target[ti].name].rot.push({ t, v: deg, ease: 'linear' });
      }
    }

    if (bones[target[tHipIdx].name]?.at) {
      const hipPos = sWorldPos[sHipIdx];
      const dx = inPlace ? 0 : +((hipPos.x - sHipRestPos.x) * hipScale).toFixed(5);
      const dy = +((hipPos.y - sHipRestPos.y) * hipScale).toFixed(5);
      const dz = inPlace ? 0 : +((hipPos.z - sHipRestPos.z) * hipScale).toFixed(5);
      bones[target[tHipIdx].name].at.push({ t, v: [dx, dy, dz], ease: 'linear' });
    }
  }

  for (const [k, v] of Object.entries(bones)) {
    if (!v.rot?.length && !v.at?.length) delete bones[k];
  }
  const clipName = typeof opts.name === 'string' && opts.name ? opts.name : (opts.clipName || 'retargeted');
  const duration = +Math.max(lastT, Number(parsed.duration) || 0, dt).toFixed(5);
  return {
    clip: { name: clipName, duration, bones },
    mapping,
    unmappedSource,
    unmappedTarget,
    hipScale,
    warnings,
  };
}

/** Retargets source motion and returns `{ clip: THREE.AnimationClip, spec, mapping, unmappedSource, unmappedTarget, hipScale, warnings }`. */
export function retargetToAnimationClip(source, targetJoints = null, opts = {}) {
  const res = retargetMotionToRig(source, targetJoints, opts);
  const c = res.clip;
  const target = normalizeTargetJoints(targetJoints);
  const frames = (() => {
    const worldQ = [];
    return target.map((j, i) => {
      const q = j.rot ? new THREE.Quaternion().setFromEuler(new THREE.Euler(j.rot[0] * DEG, j.rot[1] * DEG, j.rot[2] * DEG, 'XYZ')) : new THREE.Quaternion();
      const pq = j.parent >= 0 ? worldQ[j.parent] : new THREE.Quaternion();
      worldQ[i] = pq.clone().multiply(q);
      const from = j.parent >= 0 ? target[j.parent].at : [0, 0, 0];
      const pos = new THREE.Vector3(j.at[0] - from[0], j.at[1] - from[1], j.at[2] - from[2]).applyQuaternion(pq.clone().invert());
      return { position: pos, quaternion: q };
    });
  })();
  const index = new Map(target.map((j, i) => [j.name, i]));
  const tracks = [];
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  for (const [name, ctrl] of Object.entries(c.bones)) {
    const ji = index.get(name);
    if (ji === undefined) continue;
    const node = THREE.PropertyBinding.sanitizeNodeName(name);
    const rest = frames[ji];
    if (Array.isArray(ctrl.rot) && ctrl.rot.length) {
      const times = Float32Array.from(ctrl.rot, (k) => k.t);
      const vals = new Float32Array(ctrl.rot.length * 4);
      ctrl.rot.forEach((k, idx) => {
        q.copy(rest.quaternion).multiply(new THREE.Quaternion().setFromEuler(e.set(k.v[0] * DEG, k.v[1] * DEG, k.v[2] * DEG, 'XYZ')));
        q.toArray(vals, idx * 4);
      });
      tracks.push(new THREE.QuaternionKeyframeTrack(`${node}.quaternion`, times, vals));
    }
    if (Array.isArray(ctrl.at) && ctrl.at.length) {
      const times = Float32Array.from(ctrl.at, (k) => k.t);
      const vals = new Float32Array(ctrl.at.length * 3);
      ctrl.at.forEach((k, idx) => {
        vals[idx * 3] = rest.position.x + k.v[0];
        vals[idx * 3 + 1] = rest.position.y + k.v[1];
        vals[idx * 3 + 2] = rest.position.z + k.v[2];
      });
      tracks.push(new THREE.VectorKeyframeTrack(`${node}.position`, times, vals));
    }
  }
  return { ...res, clip: new THREE.AnimationClip(c.name, c.duration, tracks), spec: c };
}
