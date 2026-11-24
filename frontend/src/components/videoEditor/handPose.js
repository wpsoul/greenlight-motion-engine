/*
 * (pose) Hand shaping, skin-surface support, and engine pinch solving for the pose pipeline (`modelPose.js`).
 *
 * Keeps hand poses ergonomic and physically grounded on any rig naming scheme:
 *   - `HAND_SHAPES` / `HAND_PRESETS`: relaxed, point, pinch, grip, spread
 *   - `findHandBones`: auto-rigged (`Thumb1.L`/sanitized `Thumb1L`), Rigify (`f_index.01.L`), Mixamo (`LeftHandIndex1`),
 *     Unity/Unreal (`index_01_l`), generic (`thumb_1_r`), unsided FPV, or hierarchical chains under palm/hand/wrist
 *   - `detectFingerAxes`: rest-pose palm normal & per-phalanx local curl/spread/oppose axes (cached on `rig`)
 *   - `applyHandShapes`: keyable `L.spec.hands` presets/overrides before Step 3 explicit `bones`
 *   - `computeBoneSkinSupport` / `evaluateSkinnedExtremalPoint`: live skinned vertices (linear + dual-quaternion via
 *     `sm.applyBoneTransform` + `sm.matrixWorld`) including `_end` / zero-weight tip bones
 *   - `pointClearanceFromShape` / `solvePinchConstraint`: signed clearance against OBB, sphere, or closed triangle mesh,
 *     sweeping + bisecting finger curl to achieve target clearance with zero skin penetration.
 */
import * as THREE from 'three';
import { sampleTrack, sampleStep } from '../../world3d/keys.js';

const DEG = Math.PI / 180;
const num = (v, d) => (Number.isFinite(v) ? v : d);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export const HAND_SHAPES = ['relaxed', 'point', 'pinch', 'grip', 'spread'];
export const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'];

// Max flexion angle (degrees) per phalanx [proximal, intermediate, distal]
const DEFAULT_PHALANX_DEG = [78, 95, 65];
const THUMB_PHALANX_DEG = [28, 52, 60];
const THUMB_OPPOSE_DEG = 46;
// Default spread angles (degrees) at spread = 1 (positive = toward thumb side)
const DEFAULT_SPREAD_DEG = { thumb: 26, index: 14, middle: 2, ring: -12, pinky: -24 };

export const HAND_PRESETS = {
  relaxed: {
    curl: { thumb: 0.22, index: 0.20, middle: 0.24, ring: 0.28, pinky: 0.32 },
    phalanx: {
      thumb: [0.65, 0.9, 0.8],
      index: [0.85, 1.0, 0.75],
      middle: [0.85, 1.0, 0.75],
      ring: [0.85, 1.0, 0.75],
      pinky: [0.85, 1.0, 0.75],
    },
    oppose: 0.25,
    spread: 0,
    spreadAngles: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
  },
  point: {
    curl: { thumb: 0.55, index: 0.04, middle: 0.86, ring: 0.90, pinky: 0.92 },
    phalanx: {
      thumb: [0.8, 1.0, 0.9],
      index: [0.5, 0.5, 0.5],
      middle: [1.0, 1.05, 0.9],
      ring: [1.0, 1.05, 0.9],
      pinky: [1.0, 1.05, 0.9],
    },
    oppose: 0.65,
    spread: 0,
    spreadAngles: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
  },
  pinch: {
    curl: { thumb: 0.45, index: 0.48, middle: 0.58, ring: 0.66, pinky: 0.74 },
    phalanx: {
      thumb: [0.7, 0.95, 1.0],
      index: [1.05, 1.0, 0.85],
      middle: [0.9, 1.0, 0.8],
      ring: [0.9, 1.0, 0.8],
      pinky: [0.9, 1.0, 0.8],
    },
    oppose: 0.85,
    spread: 0,
    spreadAngles: { thumb: 0, index: -4, middle: 0, ring: 0, pinky: 0 },
  },
  grip: {
    curl: { thumb: 0.76, index: 0.80, middle: 0.84, ring: 0.86, pinky: 0.88 },
    phalanx: {
      thumb: [0.8, 1.0, 0.95],
      index: [1.0, 1.05, 0.9],
      middle: [1.0, 1.05, 0.9],
      ring: [1.0, 1.05, 0.9],
      pinky: [1.0, 1.05, 0.9],
    },
    oppose: 0.80,
    spread: 0,
    spreadAngles: { thumb: 4, index: 3, middle: 0, ring: -3, pinky: -6 },
  },
  spread: {
    curl: { thumb: 0.02, index: 0.02, middle: 0.02, ring: 0.02, pinky: 0.02 },
    phalanx: {
      thumb: [0.5, 0.5, 0.5],
      index: [0.5, 0.5, 0.5],
      middle: [0.5, 0.5, 0.5],
      ring: [0.5, 0.5, 0.5],
      pinky: [0.5, 0.5, 0.5],
    },
    oppose: 0,
    spread: 1,
    spreadAngles: { ...DEFAULT_SPREAD_DEG },
  },
};

// scratch
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _s1 = new THREE.Vector3();

// ── local standalone helpers (avoid circular import with modelPose.js) ───────────────────────────────────────────────

const sanitized = (name) => THREE.PropertyBinding.sanitizeNodeName(String(name));

function nodeByName(rig, name) {
  if (!name || !rig?.byName) return null;
  return rig.byName.get(name) || rig.byName.get(sanitized(name)) || null;
}

function controlValue(control, field, t, fallback) {
  if (!control || typeof control !== 'object') return fallback;
  const track = control.keys?.[field];
  if (Array.isArray(track) && track.length) {
    const first = track[0]?.v;
    const v = typeof first === 'string' || typeof first === 'boolean' ? sampleStep(track, t) : sampleTrack(track, t);
    if (v !== undefined) return v;
  }
  return control[field] !== undefined ? control[field] : fallback;
}

const maskSets = new WeakMap();
function maskNames(mask) {
  let m = maskSets.get(mask);
  if (!m) {
    const list = (v) => new Set((Array.isArray(v) ? v : []).flatMap((x) => [String(x), sanitized(x)]));
    m = {
      names: list([...(Array.isArray(mask.bones) ? mask.bones : []), ...(Array.isArray(mask.objects) ? mask.objects : [])]),
      exclude: list(mask.exclude),
    };
    maskSets.set(mask, m);
  }
  return m;
}

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
    for (let n = node; n && n !== rig.root?.parent; n = deep ? n.parent : null) {
      if (names.has(n.name)) { hit = true; break; }
      if (!deep) break;
    }
    if (!hit) return false;
  }
  if (exclude.size) {
    for (let n = node; n && n !== rig.root?.parent; n = n.parent) if (exclude.has(n.name)) return false;
  }
  return true;
}

function restLocalTransform(rig, node) {
  const idx = rig.index?.get(node);
  if (idx !== undefined && rig.rest?.[idx]) return rig.rest[idx];
  return { p: node.position, q: node.quaternion, s: node.scale };
}

/** Node's rest world transform in `rig.root` space (matrix, position, quaternion). */
function restInRoot(rig, node, outPos = new THREE.Vector3(), outQuat = new THREE.Quaternion(), outMat = new THREE.Matrix4()) {
  outMat.identity();
  const chain = [];
  for (let p = node; p && p !== rig.root; p = p.parent) {
    if (rig.index && !rig.index.has(p)) break;
    chain.unshift(p);
  }
  for (const p of chain) {
    const r = restLocalTransform(rig, p);
    _m2.compose(r.p, r.q, r.s);
    outMat.multiply(_m2);
  }
  outMat.decompose(outPos, outQuat, _s1);
  return outMat;
}

function skinnedMeshesOf(rig) {
  if (rig._skinnedMeshes) return rig._skinnedMeshes;
  const list = [];
  if (rig.root) {
    rig.root.traverse((n) => {
      if (n.isSkinnedMesh && n.skeleton && n.geometry?.attributes?.position && n.geometry?.attributes?.skinIndex && n.geometry?.attributes?.skinWeight) {
        list.push(n);
      }
    });
  }
  rig._skinnedMeshes = list;
  return list;
}

function boneHasSkinWeight(rig, bone) {
  for (const sm of skinnedMeshesOf(rig)) {
    const bi = sm.skeleton.bones.indexOf(bone);
    if (bi < 0) continue;
    const si = sm.geometry.attributes.skinIndex;
    const sw = sm.geometry.attributes.skinWeight;
    for (let v = 0; v < si.count; v += 1) {
      for (let k = 0; k < 4; k += 1) {
        if (si.getComponent(v, k) === bi && sw.getComponent(v, k) > 1e-4) return true;
      }
    }
  }
  return false;
}

// ── Bone discovery ───────────────────────────────────────────────────────────────────────────────────────────────────

export function normalizeSide(side) {
  if (!side) return null;
  const s = String(side).trim().toLowerCase();
  if (s === 'left' || s === 'l') return 'left';
  if (s === 'right' || s === 'r') return 'right';
  return null;
}

/** Extracts `'left' | 'right' | null` from a bone name across auto-rigged, Rigify, Mixamo, Unity/Unreal, and glTF-sanitized forms. */
export function sideOfBone(name) {
  if (!name) return null;
  const raw = String(name);
  const base = raw.replace(/(?:[._:-](?:end|tip|nub))+$/i, '').replace(/(Tip|End|Nub)$/, '');
  // Explicit words: Left/Right (delimited, namespaced with ':', or camelCase e.g. LeftHandIndex1, mixamorig:LeftHand)
  if (/(?:^|[^a-zA-Z])left(?:[^a-zA-Z]|$)/i.test(base) || /(?:^|[a-z._:-])Left(?=[A-Z0-9._:-]|$)/.test(base)) return 'left';
  if (/(?:^|[^a-zA-Z])right(?:[^a-zA-Z]|$)/i.test(base) || /(?:^|[a-z._:-])Right(?=[A-Z0-9._:-]|$)/.test(base)) return 'right';
  // Delimited L/R token (.L, _l, -R, :L, L_)
  const sep = /(?:^|[._:-])([LR])(?=$|[._:-])/i.exec(base);
  if (sep) return sep[1].toUpperCase() === 'L' ? 'left' : 'right';
  // glTF sanitized suffix: Thumb1L, f_index01L, handL, wristR
  const sanNum = /\d([LR])$/.exec(base);
  if (sanNum) return sanNum[1] === 'L' ? 'left' : 'right';
  const sanLower = /[a-z]([LR])$/.exec(base);
  if (sanLower) return sanLower[1] === 'L' ? 'left' : 'right';
  // Prefix LHand / RIndex1 / mixamorig:LHand
  const pref = /(?:^|:)([LR])(?=[A-Z])/.exec(base);
  if (pref) return pref[1] === 'L' ? 'left' : 'right';
  return null;
}

function tokenizeBoneName(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function parseFingerToken(name) {
  const raw = String(name);
  const tokensAll = tokenizeBoneName(raw);
  const lastTok = tokensAll[tokensAll.length - 1];
  const isTip = /(?:[._:-](?:end|tip|nub))$/i.test(raw)
    || /(Thumb|Index|Middle|Ring|Pinky|Little)\d*(?:[._:-])?(?:Tip|End|Nub)(?:[._:-]?[LR])?$/i.test(raw)
    || ['end', 'tip', 'nub'].includes(lastTok);
  const base = raw.replace(/(?:[._:-](?:end|tip|nub))+$/i, '');
  const tokens = tokenizeBoneName(base);

  // Match whole tokens so "Earring" or "String" never falsely match "ring" (and "IndexMiddle" matches index first).
  const hasTok = (t) => tokens.includes(t);
  let finger = null;
  if (hasTok('thumb')) finger = 'thumb';
  else if (hasTok('index')) finger = 'index';
  else if (hasTok('ring')) finger = 'ring';
  else if (hasTok('pinky') || hasTok('little')) finger = 'pinky';
  else if (hasTok('middle')) finger = 'middle';

  if (!finger) return { finger: null, isTip, order: 0, isMetacarpal: false };

  const isMetacarpal = hasTok('metacarpal') || hasTok('carpal');
  let order = 99;
  if (isMetacarpal) order = 0;
  else if (hasTok('proximal') || hasTok('prox')) order = 1;
  else if (hasTok('intermediate') || hasTok('inter') || (finger !== 'middle' && hasTok('middle'))) order = 2;
  else if (hasTok('distal') || hasTok('dist')) order = 3;
  else {
    // Strip trailing sanitized L/R before checking phalanx index digits
    const stripped = base.replace(/([a-z0-9])[LR]$/, '$1');
    const matches = [...stripped.matchAll(/(\d+)/g)];
    if (matches.length) order = Number(matches[matches.length - 1][1]);
  }
  return { finger, isTip, order, isMetacarpal };
}

function depthInRig(rig, node) {
  let d = 0;
  for (let p = node; p && p !== rig.root; p = p.parent) d += 1;
  return d;
}

function isAncestorOf(anc, node, rigRoot) {
  for (let p = node; p && p !== rigRoot; p = p.parent) if (p === anc) return true;
  return false;
}

function commonAncestor(nodes, rigRoot) {
  const valid = nodes.filter(Boolean);
  if (!valid.length) return null;
  const chains = valid.map((n) => {
    const c = [];
    for (let p = n.parent; p && p !== rigRoot; p = p.parent) c.unshift(p);
    return c;
  });
  let lca = null;
  const minLen = Math.min(...chains.map((c) => c.length));
  for (let i = 0; i < minLen; i += 1) {
    const c0 = chains[0][i];
    if (chains.every((c) => c[i] === c0)) lca = c0;
    else break;
  }
  return lca;
}

function trimChainToPhalanges(rig, entries, finger) {
  if (!entries.length) return [];
  // Sort parent-to-child (depth first, then parsed phalanx order)
  const sorted = [...entries].sort((a, b) => depthInRig(rig, a.node) - depthInRig(rig, b.node) || a.order - b.order);
  const active = sorted.filter((e) => !e.isTip);
  let list = active.length ? active : sorted;
  // Drop explicit metacarpal / 0 bone on non-thumb fingers when >= 4 bones exist
  if (list.length >= 4 && finger !== 'thumb' && (list[0].isMetacarpal || list[0].order === 0)) {
    list = list.slice(1);
  }
  // Drop Mixamo-style unskinned 4th nub leaf when 4 bones exist
  if (list.length >= 4) {
    const last = list[list.length - 1].node;
    const hasSkin = skinnedMeshesOf(rig).length > 0;
    const leaf = last.children.filter((c) => !parseFingerToken(c.name).isTip).length === 0;
    if (leaf && (!hasSkin || !boneHasSkinWeight(rig, last))) list = list.slice(0, -1);
  }
  return list.slice(0, 3).map((e) => e.node);
}

/** Hierarchical geometric fallback when bone names have no finger keywords (e.g. generic Bone_01.. chains under Hand/Palm/Wrist). */
function discoverHierarchicalFingers(rig, handRoot) {
  const fingers = { thumb: [], index: [], middle: [], ring: [], pinky: [] };
  if (!handRoot) return fingers;

  const isTipName = (n) => /(?:[._-](?:end|tip|nub))$/i.test(n.name);
  const collectChains = (node, acc) => {
    const kids = node.children.filter((c) => rig.index?.has(c) && !isTipName(c));
    if (!kids.length) return;
    if (kids.length > 1 || node === handRoot) {
      for (const k of kids) {
        // Walk linear chain from k
        const chain = [k];
        let cur = k;
        while (true) {
          const next = cur.children.filter((c) => rig.index?.has(c) && !isTipName(c));
          if (next.length === 1) {
            chain.push(next[0]);
            cur = next[0];
          } else if (next.length > 1 && chain.length === 1) {
            // Intermediate metacarpal/palm hub: branch from here
            collectChains(cur, acc);
            chain.length = 0;
            break;
          } else break;
        }
        if (chain.length >= 2) acc.push(chain.slice(0, 3));
      }
    }
  };

  const chains = [];
  collectChains(handRoot, chains);
  if (!chains.length) return fingers;

  const rootPos = new THREE.Vector3();
  restInRoot(rig, handRoot, rootPos);
  const infos = chains.map((c) => {
    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3();
    restInRoot(rig, c[0], p0);
    restInRoot(rig, c[c.length - 1], p1);
    const dir = p1.clone().sub(p0);
    const len = dir.length() || 1;
    return { chain: c, p0, p1, dir: dir.normalize(), len };
  });

  if (infos.length === 1) {
    fingers.index = infos[0].chain;
    return fingers;
  }

  const meanDir = new THREE.Vector3();
  for (const x of infos) meanDir.add(x.dir);
  if (meanDir.lengthSq() > 1e-9) meanDir.normalize();
  else meanDir.set(0, 0, 1);

  // Thumb is typically closest to wrist along meanDir and diverges furthest from meanDir
  let thumbIdx = 0;
  let bestThumbScore = -Infinity;
  const maxProj = Math.max(...infos.map((x) => x.p0.clone().sub(rootPos).dot(meanDir)));
  for (let i = 0; i < infos.length; i += 1) {
    const rel = infos[i].p0.clone().sub(rootPos);
    const distBack = maxProj - rel.dot(meanDir);
    const angle = 1 - infos[i].dir.dot(meanDir);
    const score = distBack * 4 + angle;
    if (score > bestThumbScore) { bestThumbScore = score; thumbIdx = i; }
  }
  fingers.thumb = infos[thumbIdx].chain;
  const rest = infos.filter((_, i) => i !== thumbIdx);
  if (!rest.length) return fingers;

  // Order remaining fingers by distance from thumb root along the lateral knuckle axis
  const thumbPos = infos[thumbIdx].p0;
  const meanKnuckle = new THREE.Vector3();
  for (const r of rest) meanKnuckle.add(r.p0);
  meanKnuckle.divideScalar(rest.length);
  const lateral = meanKnuckle.clone().sub(thumbPos);
  lateral.addScaledVector(meanDir, -lateral.dot(meanDir));
  if (lateral.lengthSq() > 1e-12) lateral.normalize();
  else lateral.set(1, 0, 0);

  rest.sort((a, b) => a.p0.clone().sub(thumbPos).dot(lateral) - b.p0.clone().sub(thumbPos).dot(lateral));
  const orderNames = ['index', 'middle', 'ring', 'pinky'];
  for (let i = 0; i < rest.length && i < orderNames.length; i += 1) {
    fingers[orderNames[i]] = rest[i].chain;
  }
  return fingers;
}

/**
 * Discovers `{ side, wrist, palm, fingers: { thumb, index, middle, ring, pinky } }` on `rig` for `side` (`'left'|'right'|null`).
 */
export function findHandBones(rig, side = null) {
  if (!rig?.nodes?.length) return { side: normalizeSide(side), wrist: null, palm: null, fingers: { thumb: [], index: [], middle: [], ring: [], pinky: [] } };
  const targetSide = normalizeSide(side);
  const cacheKey = targetSide || 'auto';
  rig._handBonesCache ||= new Map();
  if (rig._handBonesCache.has(cacheKey)) return rig._handBonesCache.get(cacheKey);

  const allNodes = rig.nodes.filter((n) => n !== rig.root && n.name);
  const parsed = allNodes.map((n) => ({
    node: n,
    side: sideOfBone(n.name),
    ...parseFingerToken(n.name),
  }));

  const anySidedFingers = parsed.some((e) => e.finger && !e.isTip && e.side);
  const sideMatched = (entrySide) => {
    if (targetSide) {
      if (entrySide === targetSide) return true;
      // Single-hand FPV model with no sided finger tags at all: allow unsided fallback
      if (!anySidedFingers && entrySide === null) return true;
      return false;
    }
    return true;
  };

  // Pick finger nodes matching targetSide (if side omitted on a two-handed rig, prefer 'left' or first sided group if both exist)
  let effectiveSide = targetSide;
  let fingerEntries = parsed.filter((e) => e.finger && sideMatched(e.side));
  if (!effectiveSide && anySidedFingers) {
    const leftOnes = fingerEntries.filter((e) => e.side === 'left');
    const rightOnes = fingerEntries.filter((e) => e.side === 'right');
    if (leftOnes.length && rightOnes.length) {
      effectiveSide = 'left';
      fingerEntries = leftOnes;
    } else if (leftOnes.length) {
      effectiveSide = 'left';
    } else if (rightOnes.length) {
      effectiveSide = 'right';
    }
  }

  const fingers = { thumb: [], index: [], middle: [], ring: [], pinky: [] };
  for (const f of FINGER_NAMES) {
    const entries = fingerEntries.filter((e) => e.finger === f);
    fingers[f] = trimChainToPhalanges(rig, entries, f);
  }

  const fingerRoots = FINGER_NAMES.map((f) => fingers[f][0]).filter(Boolean);
  const lca = commonAncestor(fingerRoots, rig.root);

  // Candidate wrist/hand/palm bones (excluding finger bones)
  const nonFinger = parsed.filter((e) => !e.finger && !e.isTip && (!effectiveSide ? !anySidedFingers || e.side === null : e.side === effectiveSide || (!anySidedFingers && e.side === null)));
  const isPalmName = (s) => /palm/i.test(s) && !/palm[._-]?\d+$/i.test(s.replace(/([._-][LR]|L|R)$/i, ''));
  const wristCand = nonFinger.find((e) => /wrist/i.test(e.node.name))?.node || null;
  const handCand = nonFinger.find((e) => /hand/i.test(e.node.name))?.node || null;
  const palmCand = nonFinger.find((e) => isPalmName(e.node.name))?.node || null;

  let wrist = null;
  let palm = null;
  if (fingerRoots.length) {
    const bestAnc = (c) => c && fingerRoots.some((fr) => isAncestorOf(c, fr, rig.root));
    palm = (bestAnc(palmCand) && palmCand) || lca || (bestAnc(handCand) && handCand) || palmCand || handCand || wristCand;
    if (wristCand && isAncestorOf(wristCand, palm || fingerRoots[0], rig.root)) wrist = wristCand;
    else if (handCand && handCand !== palm && isAncestorOf(handCand, palm || fingerRoots[0], rig.root)) wrist = handCand;
    else wrist = wristCand || handCand || palm;
  } else {
    // Hierarchical fallback under wrist/hand/palm when fingers have generic names
    const anySidedHands = parsed.some((e) => !e.finger && (/wrist|hand|palm/i.test(e.node.name)) && e.side);
    const sideHand = parsed.filter((e) => !e.finger && !e.isTip && /wrist|hand|palm/i.test(e.node.name) && (targetSide ? (e.side === targetSide || (!anySidedHands && e.side === null)) : true));
    const hPalm = sideHand.find((e) => /palm/i.test(e.node.name))?.node || null;
    const hHand = sideHand.find((e) => /hand/i.test(e.node.name))?.node || null;
    const hWrist = sideHand.find((e) => /wrist/i.test(e.node.name))?.node || null;
    const rootNode = hPalm || hHand || hWrist;
    if (rootNode) {
      const hFingers = discoverHierarchicalFingers(rig, rootNode);
      for (const f of FINGER_NAMES) fingers[f] = hFingers[f];
      palm = hPalm || hHand || rootNode;
      wrist = hWrist || hHand || rootNode;
    }
  }

  const result = { side: effectiveSide, wrist, palm, fingers };
  rig._handBonesCache.set(cacheKey, result);
  return result;
}

// ── Automatic rest-pose curl & spread axes ───────────────────────────────────────────────────────────────────────────

function childDirectionInRoot(rig, bone, nextBone, fallbackDir) {
  const p0 = new THREE.Vector3();
  restInRoot(rig, bone, p0);
  const p1 = new THREE.Vector3();
  if (nextBone) {
    restInRoot(rig, nextBone, p1);
    const d = p1.sub(p0);
    if (d.lengthSq() > 1e-12) return d.normalize();
  }
  const kids = (bone.children || []).filter((c) => rig.index?.has(c));
  if (kids.length) {
    const avg = new THREE.Vector3();
    for (const k of kids) {
      restInRoot(rig, k, p1);
      avg.add(p1.sub(p0));
    }
    if (avg.lengthSq() > 1e-12) return avg.normalize();
  }
  return fallbackDir.clone();
}

// a `{ boneName: axis }` map's entry for a bone: by its own name, else by a key that sanitizes to it (the file's `Thumb1.L` for the
// loader's `Thumb1L`, as nodeByName finds bones), else `default`
function axisByBone(raw, boneName) {
  if (raw[boneName]) return raw[boneName];
  const want = sanitized(boneName);
  for (const key of Object.keys(raw)) if (key !== 'default' && raw[key] && sanitized(key) === want) return raw[key];
  return raw.default || null;
}

function parseOverrideAxis(raw, boneName) {
  if (!raw) return null;
  const pick = Array.isArray(raw) || raw.isVector3 ? raw : (typeof raw === 'object' ? axisByBone(raw, boneName) : null);
  if (!pick) return null;
  const v = pick.isVector3 ? pick.clone() : Array.isArray(pick) ? new THREE.Vector3(num(pick[0], 0), num(pick[1], 0), num(pick[2], 0)) : null;
  return v && v.lengthSq() > 1e-12 ? v.normalize() : null;
}

/**
 * Computes palm basis and local phalanx `{ curlAxis, spreadAxis, opposeAxis }` for each finger bone from rest transforms.
 * Cached on `rig` per side (unless explicit `curlAxis` override is passed).
 */
export function detectFingerAxes(rig, handBones, opts = {}) {
  if (!handBones?.fingers) return null;
  const sideKey = handBones.side || 'auto';
  const hasOverride = Boolean(opts?.curlAxis);
  rig._fingerAxesCache ||= new Map();
  if (!hasOverride && rig._fingerAxesCache.has(sideKey)) return rig._fingerAxesCache.get(sideKey);

  const restPos = new Map();
  const restQuat = new Map();
  const getRest = (n) => {
    if (!n) return null;
    if (!restPos.has(n)) {
      const p = new THREE.Vector3(), q = new THREE.Quaternion();
      restInRoot(rig, n, p, q);
      restPos.set(n, p);
      restQuat.set(n, q);
    }
    return { p: restPos.get(n), q: restQuat.get(n) };
  };

  const wNode = handBones.palm || handBones.wrist;
  const wristPos = wNode ? getRest(wNode).p.clone() : new THREE.Vector3();

  // Knuckle positions for palm plane
  const fingerKnuckles = [];
  for (const f of ['index', 'middle', 'ring', 'pinky']) {
    const b0 = handBones.fingers[f]?.[0];
    if (b0) fingerKnuckles.push({ f, p: getRest(b0).p.clone(), chain: handBones.fingers[f] });
  }
  const thumbChain = handBones.fingers.thumb || [];
  const thumb0Pos = thumbChain[0] ? getRest(thumbChain[0]).p.clone() : null;

  // palmCenter & palmForward (wrist -> knuckles)
  const palmCenter = new THREE.Vector3();
  const palmForward = new THREE.Vector3();
  if (fingerKnuckles.length) {
    for (const k of fingerKnuckles) palmCenter.add(k.p);
    palmCenter.divideScalar(fingerKnuckles.length);
    if (wNode) {
      palmForward.copy(palmCenter).sub(wristPos);
      palmCenter.lerp(wristPos, 0.5);
    }
  } else if (thumb0Pos && wNode) {
    palmForward.copy(thumb0Pos).sub(wristPos);
    palmCenter.copy(wristPos).lerp(thumb0Pos, 0.5);
  }
  if (palmForward.lengthSq() <= 1e-12) {
    // Fall back to mean finger direction
    for (const k of fingerKnuckles) palmForward.add(childDirectionInRoot(rig, k.chain[0], k.chain[1], new THREE.Vector3(0, 0, 1)));
    if (palmForward.lengthSq() <= 1e-12 && thumbChain[0]) palmForward.copy(childDirectionInRoot(rig, thumbChain[0], thumbChain[1], new THREE.Vector3(0, 0, 1)));
    if (palmForward.lengthSq() <= 1e-12) palmForward.set(0, 0, 1);
  }
  palmForward.normalize();

  // palmAcross (radial/index -> ulnar/pinky across the knuckles, orthogonalized against palmForward)
  const palmAcross = new THREE.Vector3();
  if (fingerKnuckles.length >= 2) {
    palmAcross.copy(fingerKnuckles[fingerKnuckles.length - 1].p).sub(fingerKnuckles[0].p);
  } else if (fingerKnuckles.length === 1 && thumb0Pos) {
    palmAcross.copy(fingerKnuckles[0].p).sub(thumb0Pos);
  }
  palmAcross.addScaledVector(palmForward, -palmAcross.dot(palmForward));
  if (palmAcross.lengthSq() <= 1e-12) {
    palmAcross.set(1, 0, 0).addScaledVector(palmForward, -palmForward.x);
    if (palmAcross.lengthSq() <= 1e-12) palmAcross.set(0, 0, 1).cross(palmForward);
  }
  palmAcross.normalize();

  // Candidate palm normal (palmForward x palmAcross)
  let palmInward = new THREE.Vector3().crossVectors(palmForward, palmAcross).normalize();

  // Orient palmInward toward true palmar flexion side:
  // 1) Rest finger flexion deflection (fingers naturally bend slightly palmar, never dorsal)
  let bendScore = 0;
  for (const k of fingerKnuckles) {
    const ch = k.chain;
    if (ch.length >= 2) {
      const d0 = childDirectionInRoot(rig, ch[0], ch[1], palmForward);
      const d1 = childDirectionInRoot(rig, ch[1], ch[2], d0);
      bendScore += d1.clone().sub(d0).dot(palmInward);
      if (ch.length >= 3) {
        const d2 = childDirectionInRoot(rig, ch[2], null, d1);
        bendScore += d2.clone().sub(d1).dot(palmInward);
      }
    }
  }

  let side = handBones.side;
  if (!side) {
    for (const f of FINGER_NAMES) {
      for (const b of handBones.fingers[f] || []) {
        side = sideOfBone(b.name);
        if (side) break;
      }
      if (side) break;
    }
  }

  if (Math.abs(bendScore) > 0.025) {
    if (bendScore < 0) palmInward.negate();
  } else if (side === 'left') {
    // Left-hand chirality: palmForward (wrist->knuckles) x palmAcross (index->pinky) points dorsally, so negate for palmar
    palmInward.negate();
  } else if (side === 'right') {
    // Right-hand chirality: palmForward x palmAcross already points palmar
  } else if (thumbChain.length >= 2 && fingerKnuckles.length) {
    // Un-sided flat hand fallback: thumb distal phalanges sit slightly toward the palmar side of the knuckle plane
    const tEnd = getRest(thumbChain[thumbChain.length - 1]).p;
    const planeDist = tEnd.clone().sub(fingerKnuckles[0].p).dot(palmInward);
    if (Math.abs(planeDist) > 1e-4) {
      if (planeDist < 0) palmInward.negate();
    } else if (palmInward.y > 0.5) {
      // Standard rest hand with horizontal palm typically faces downward (-Y)
      palmInward.negate();
    }
  }

  const boneAxes = new Map();
  const perFinger = {};

  for (const f of FINGER_NAMES) {
    const chain = handBones.fingers[f] || [];
    perFinger[f] = [];
    let prevDir = palmForward.clone();
    for (let i = 0; i < chain.length; i += 1) {
      const b = chain[i];
      const next = chain[i + 1] || null;
      const boneDir = childDirectionInRoot(rig, b, next, prevDir);
      prevDir = boneDir;
      const qInv = getRest(b).q.clone().invert();

      let curlWorld;
      let opposeWorld = null;
      if (f === 'thumb') {
        const thumbInward = new THREE.Vector3().addScaledVector(palmInward, 0.78).addScaledVector(palmAcross, 0.62).normalize();
        curlWorld = new THREE.Vector3().crossVectors(boneDir, thumbInward);
        if (curlWorld.lengthSq() < 1e-6) curlWorld.crossVectors(palmForward, thumbInward);
        if (curlWorld.lengthSq() < 1e-6) curlWorld.copy(palmAcross);
        curlWorld.normalize();

        const opposeTarget = new THREE.Vector3().addScaledVector(palmInward, 0.85).addScaledVector(palmAcross, 0.52).normalize();
        opposeWorld = new THREE.Vector3().crossVectors(boneDir, opposeTarget);
        if (opposeWorld.lengthSq() < 1e-6) opposeWorld.copy(curlWorld);
        opposeWorld.normalize();
      } else {
        curlWorld = new THREE.Vector3().crossVectors(boneDir, palmInward);
        if (curlWorld.lengthSq() < 1e-6) curlWorld.crossVectors(palmForward, palmInward);
        if (curlWorld.lengthSq() < 1e-6) curlWorld.copy(palmAcross);
        curlWorld.normalize();
      }

      // Abduction/spread: palmAcross x boneDir rotates finger toward thumb (-palmAcross) for +angle
      let spreadWorld = new THREE.Vector3().crossVectors(palmAcross, boneDir);
      spreadWorld.addScaledVector(curlWorld, -spreadWorld.dot(curlWorld));
      if (spreadWorld.lengthSq() < 1e-6) spreadWorld.copy(palmInward);
      spreadWorld.normalize();

      const overrideLocal = parseOverrideAxis(opts?.curlAxis, b.name);
      const curlAxis = overrideLocal || curlWorld.clone().applyQuaternion(qInv).normalize();
      const spreadAxis = spreadWorld.clone().applyQuaternion(qInv).normalize();
      const opposeAxis = opposeWorld ? opposeWorld.clone().applyQuaternion(qInv).normalize() : null;

      const entry = { bone: b, curlAxis, spreadAxis, opposeAxis, boneDir };
      boneAxes.set(b, entry);
      perFinger[f].push(entry);
    }
  }

  const result = { side: side || null, palmCenter, palmForward, palmAcross, palmInward, bones: boneAxes, fingers: perFinger };
  if (!hasOverride) rig._fingerAxesCache.set(sideKey, result);
  return result;
}

// ── Hand shape presets application ───────────────────────────────────────────────────────────────────────────────────

function extractCurlForFinger(curlSpec, fingerName, fingerIndex) {
  if (curlSpec === undefined || curlSpec === null) return undefined;
  if (typeof curlSpec === 'number') return Number.isFinite(curlSpec) ? curlSpec : undefined;
  if (Array.isArray(curlSpec)) return Number.isFinite(curlSpec[fingerIndex]) ? curlSpec[fingerIndex] : undefined;
  if (typeof curlSpec === 'object') return Number.isFinite(curlSpec[fingerName]) ? curlSpec[fingerName] : undefined;
  return undefined;
}

function normalizeHandEntries(hands) {
  if (!hands) return [];
  if (Array.isArray(hands)) {
    return hands.filter(Boolean).map((entry) => {
      if (typeof entry === 'string') return { side: null, ctrl: { shape: entry } };
      return { side: entry.side ?? null, ctrl: entry };
    });
  }
  if (typeof hands === 'object') {
    const out = [];
    for (const [side, raw] of Object.entries(hands)) {
      if (!raw) continue;
      const ctrl = typeof raw === 'string' ? { shape: raw } : raw;
      if (ctrl && typeof ctrl === 'object') out.push({ side, ctrl });
    }
    return out;
  }
  return [];
}

/**
 * Applies `L.spec.hands` across `layers` before Step 3 explicit `bones` overrides.
 * Honors `maskAllows(rig, L.mask, bone, 'q')` and `L.weight * ctrlWeight`.
 */
export function applyHandShapes(rig, pose, layers, t, warn) {
  const layerList = Array.isArray(layers) ? layers : [{ id: null, spec: pose, weight: 1, mask: null }];
  rig._handAppliedOppose = new Map();

  for (const L of layerList) {
    const entries = normalizeHandEntries(L?.spec?.hands);
    if (!entries.length) continue;

    for (const { side, ctrl } of entries) {
      if (ctrl.on === false || controlValue(ctrl, 'on', t, true) === false) continue;
      const w = clamp01(num(Number(controlValue(ctrl, 'weight', t, 1)), 1)) * (L.weight ?? 1);
      if (!(w > 0)) continue;

      const shape = controlValue(ctrl, 'shape', t, undefined);
      let preset = null;
      if (shape !== undefined && shape !== null) {
        if (!HAND_PRESETS[shape]) {
          warn?.('unknown_hand_shape', `pose: unknown hand shape "${shape}" (${HAND_SHAPES.join(', ')})`);
          continue;
        }
        preset = HAND_PRESETS[shape];
      }

      const handBones = findHandBones(rig, side);
      const anyBones = FINGER_NAMES.some((f) => handBones.fingers[f].length > 0);
      if (!anyBones) {
        warn?.('unknown_hand', `pose: no hand bones found for side "${side || 'auto'}"`);
        continue;
      }
      const axes = detectFingerAxes(rig, handBones, { curlAxis: ctrl.curlAxis });
      if (!axes) continue;

      const amount = Math.max(0, num(Number(controlValue(ctrl, 'amount', t, 1)), 1));
      const ctrlCurl = controlValue(ctrl, 'curl', t, undefined);
      const ctrlSpread = controlValue(ctrl, 'spread', t, undefined);
      const ctrlOppose = controlValue(ctrl, 'oppose', t, undefined);
      const replace = ctrl.mode === 'replace';

      const baseOppose = ctrlOppose !== undefined && typeof ctrlOppose === 'number'
        ? num(ctrlOppose, 0) * amount
        : (preset ? (preset.oppose ?? 0) * amount : (typeof ctrlCurl === 'number' ? clamp01(ctrlCurl) * 0.55 * amount : 0));

      for (let fi = 0; fi < FINGER_NAMES.length; fi += 1) {
        const f = FINGER_NAMES[fi];
        const chain = handBones.fingers[f];
        if (!chain.length) continue;

        const overrideCurl = extractCurlForFinger(ctrlCurl, f, fi);
        const fCurl = overrideCurl !== undefined
          ? overrideCurl * amount
          : (preset ? (preset.curl[f] ?? 0) * amount : 0);

        const overrideSpread = extractCurlForFinger(ctrlSpread, f, fi);
        const presetSpreadDeg = preset?.spreadAngles?.[f];
        // When preset has non-zero spreadAngles (e.g. spread or pinch), scale by preset.spread or add on top
        let spreadDeg = 0;
        if (overrideSpread !== undefined) {
          spreadDeg = overrideSpread * amount * (DEFAULT_SPREAD_DEG[f] || 0);
        } else if (ctrlSpread !== undefined && typeof ctrlSpread === 'number') {
          spreadDeg = ctrlSpread * amount * (DEFAULT_SPREAD_DEG[f] || 0);
        } else if (preset) {
          spreadDeg = (presetSpreadDeg !== undefined && preset.spread ? presetSpreadDeg : (preset.spread ? DEFAULT_SPREAD_DEG[f] : 0)) * amount;
          if (presetSpreadDeg && !preset.spread) spreadDeg += presetSpreadDeg * amount;
        }

        const phalanxDeg = f === 'thumb' ? THUMB_PHALANX_DEG : DEFAULT_PHALANX_DEG;
        const phalanxScale = preset?.phalanx?.[f] || [1, 1, 1];

        for (let k = 0; k < chain.length; k += 1) {
          const b = chain[k];
          if (!maskAllows(rig, L.mask, b, 'q')) continue;
          const ax = axes.bones.get(b);
          if (!ax) continue;

          _q1.identity();
          if (k === 0 && Math.abs(spreadDeg) > 1e-6) {
            _q2.setFromAxisAngle(ax.spreadAxis, spreadDeg * DEG);
            _q1.multiply(_q2);
          }
          if (f === 'thumb' && k === 0 && Math.abs(baseOppose) > 1e-6 && ax.opposeAxis) {
            _q2.setFromAxisAngle(ax.opposeAxis, baseOppose * THUMB_OPPOSE_DEG * DEG);
            _q1.multiply(_q2);
            rig._handAppliedOppose.set(b, (rig._handAppliedOppose.get(b) || 0) + baseOppose * w);
          }
          const curlRad = fCurl * (phalanxDeg[Math.min(k, 2)] || 65) * (phalanxScale[Math.min(k, 2)] ?? 1) * DEG;
          if (Math.abs(curlRad) > 1e-6) {
            _q2.setFromAxisAngle(ax.curlAxis, curlRad);
            _q1.multiply(_q2);
          }

          if (replace) {
            const rq = restLocalTransform(rig, b).q;
            _q3.copy(rq).multiply(_q1);
            b.quaternion.slerp(_q3, w);
          } else {
            _q2.identity().slerp(_q1, w);
            b.quaternion.multiply(_q2);
          }
        }
      }
    }
  }
}

// ── Skin-surface support ─────────────────────────────────────────────────────────────────────────────────────────────

function restChainMatrix(rig, ancestor, descendant, out = new THREE.Matrix4()) {
  out.identity();
  const chain = [];
  for (let p = descendant; p && p !== ancestor; p = p.parent) {
    if (rig.index && !rig.index.has(p)) return null;
    chain.unshift(p);
  }
  if (!chain.length && descendant !== ancestor) return null;
  for (const p of chain) {
    const r = restLocalTransform(rig, p);
    _m2.compose(r.p, r.q, r.s);
    out.multiply(_m2);
  }
  return out;
}

/**
 * Finds and caches `[{ sm, vertices: Int32Array }]` of skinned vertices driven by `bone` (weight >= `threshold`).
 * If `bone` is an `_end` or zero-weight tip bone, walks up to its parent bone and keeps vertices in the distal half toward `bone`.
 */
export function computeBoneSkinSupport(rig, bone, opts = {}) {
  const b = typeof bone === 'string' ? nodeByName(rig, bone) : bone;
  if (!rig || !b) return [];
  const threshold = num(opts.threshold, 0.25);
  const useDefaultCache = threshold === 0.25 && !opts.noCache;
  rig._skinSupportCache ||= new Map();
  if (useDefaultCache && rig._skinSupportCache.has(b)) return rig._skinSupportCache.get(b);

  const meshes = skinnedMeshesOf(rig);
  const out = [];
  const isTipName = /(?:[._-](?:end|tip|nub))$/i.test(b.name || '');

  for (const sm of meshes) {
    const bones = sm.skeleton.bones;
    const posAttr = sm.geometry.attributes.position;
    const si = sm.geometry.attributes.skinIndex;
    const sw = sm.geometry.attributes.skinWeight;
    const bIdx = bones.indexOf(b);

    let targetBone = b;
    let targetIdx = bIdx;
    let filterToTip = false;

    const collectForBone = (idx, minW) => {
      const hits = [];
      for (let v = 0; v < si.count; v += 1) {
        let sum = 0;
        for (let k = 0; k < 4; k += 1) if (si.getComponent(v, k) === idx) sum += sw.getComponent(v, k);
        if (sum >= minW) hits.push(v);
      }
      return hits;
    };

    let verts = !isTipName && targetIdx >= 0 ? collectForBone(targetIdx, threshold) : [];
    if (!verts.length && !isTipName && targetIdx >= 0) {
      // Check if bone has any dominant-weight vertices below threshold before walking up
      const dom = [];
      for (let v = 0; v < si.count; v += 1) {
        let wTarget = 0, wMax = 0;
        for (let k = 0; k < 4; k += 1) {
          const w = sw.getComponent(v, k);
          if (si.getComponent(v, k) === targetIdx) wTarget += w;
          if (w > wMax) wMax = w;
        }
        if (wTarget > 1e-4 && wTarget >= wMax - 1e-6) dom.push(v);
      }
      if (dom.length) verts = dom;
    }

    if (!verts.length) {
      // Walk up ancestors to find parent bone with weights, then keep distal vertices toward `b`
      let cur = b.parent;
      let steps = 0;
      while (cur && cur !== rig.root && steps < 4) {
        steps += 1;
        const pIdx = bones.indexOf(cur);
        if (pIdx >= 0) {
          let cand = collectForBone(pIdx, threshold);
          if (!cand.length) cand = collectForBone(pIdx, 0.05);
          if (cand.length) {
            targetBone = cur;
            targetIdx = pIdx;
            verts = cand;
            filterToTip = true;
            break;
          }
        }
        cur = cur.parent;
      }
    }

    if (verts.length && filterToTip) {
      const invMat = sm.skeleton.boneInverses[targetIdx];
      if (invMat) {
        const parentBind = _m1.copy(invMat).invert();
        const rel = restChainMatrix(rig, targetBone, b, new THREE.Matrix4());
        if (rel) {
          const boneBind = parentBind.clone().multiply(rel);
          const pParentGeom = new THREE.Vector3().setFromMatrixPosition(parentBind).applyMatrix4(sm.bindMatrixInverse);
          const pBoneGeom = new THREE.Vector3().setFromMatrixPosition(boneBind).applyMatrix4(sm.bindMatrixInverse);
          const axis = pBoneGeom.clone().sub(pParentGeom);
          const lenSq = axis.lengthSq();
          const vp = new THREE.Vector3();
          if (lenSq > 1e-12) {
            const distal = verts.filter((vi) => {
              vp.fromBufferAttribute(posAttr, vi);
              return vp.sub(pParentGeom).dot(axis) / lenSq >= 0.5;
            });
            if (distal.length) verts = distal;
            else {
              verts.sort((vA, vB) => vp.fromBufferAttribute(posAttr, vA).distanceToSquared(pBoneGeom) - _v2.fromBufferAttribute(posAttr, vB).distanceToSquared(pBoneGeom));
              verts = verts.slice(0, Math.max(1, Math.ceil(verts.length * 0.25)));
            }
          } else {
            verts.sort((vA, vB) => vp.fromBufferAttribute(posAttr, vA).distanceToSquared(pBoneGeom) - _v2.fromBufferAttribute(posAttr, vB).distanceToSquared(pBoneGeom));
            verts = verts.slice(0, Math.max(1, Math.ceil(verts.length * 0.25)));
          }
        }
      }
    }

    if (verts.length) out.push({ sm, vertices: Int32Array.from(verts) });
  }

  if (useDefaultCache) rig._skinSupportCache.set(b, out);
  return out;
}

/** Sync `sm.bindMatrixInverse` for attached meshes after `matrixWorld` updates via `updateWorldMatrix`. */
function syncAttachedSkinBindInverse(sm) {
  if (sm.bindMode === 'attached') sm.bindMatrixInverse.copy(sm.matrixWorld).invert();
}

/**
 * Evaluates live skinned vertices for `bone` via `sm.applyBoneTransform(vi, v)` + `sm.matrixWorld`,
 * returning the extremal vertex minimizing `dot(v - target, n)`.
 */
export function evaluateSkinnedExtremalPoint(rig, bone, target, normal, opts = {}) {
  const support = computeBoneSkinSupport(rig, bone, opts);
  if (!support.length) return null;
  const n = (normal?.isVector3 ? normal.clone() : new THREE.Vector3(...(normal || [0, 1, 0])));
  if (n.lengthSq() <= 1e-18) return null;
  n.normalize();
  const tgt = target?.isVector3 ? target : new THREE.Vector3(...(target || [0, 0, 0]));

  let bestDist = Infinity;
  let bestMesh = null;
  let bestIdx = -1;
  const bestPt = new THREE.Vector3();
  const v = new THREE.Vector3();

  for (const { sm, vertices } of support) {
    syncAttachedSkinBindInverse(sm);
    const posAttr = sm.geometry.attributes.position;
    for (let i = 0; i < vertices.length; i += 1) {
      const vi = vertices[i];
      v.fromBufferAttribute(posAttr, vi);
      sm.applyBoneTransform(vi, v);
      v.applyMatrix4(sm.matrixWorld);
      const sd = _v1.copy(v).sub(tgt).dot(n);
      if (sd < bestDist) {
        bestDist = sd;
        bestPt.copy(v);
        bestMesh = sm;
        bestIdx = vi;
      }
    }
  }

  if (!bestMesh) return null;
  const delta = bestPt.clone().sub(tgt);
  const tangentVector = delta.clone().addScaledVector(n, -bestDist);
  return {
    point: bestPt,
    signedDistance: bestDist,
    penetration: -bestDist,
    tangentialError: tangentVector.length(),
    tangentVector,
    totalError: delta.length(),
    mesh: bestMesh,
    vertexIndex: bestIdx,
  };
}

// ── Shape signed clearance ───────────────────────────────────────────────────────────────────────────────────────────

const _tri = new THREE.Triangle();
const _cp = new THREE.Vector3();
const _ta = new THREE.Vector3(), _tb = new THREE.Vector3(), _tc = new THREE.Vector3(), _tx = new THREE.Vector3();

function solidAngle(p, a, b, c) {
  _ta.copy(a).sub(p);
  _tb.copy(b).sub(p);
  _tc.copy(c).sub(p);
  const la = _ta.length(), lb = _tb.length(), lc = _tc.length();
  if (la < 1e-12 || lb < 1e-12 || lc < 1e-12) return 0;
  _tx.crossVectors(_tb, _tc);
  const det = _ta.dot(_tx);
  const denom = la * lb * lc + _ta.dot(_tb) * lc + _tb.dot(_tc) * la + _tc.dot(_ta) * lb;
  return 2 * Math.atan2(det, denom);
}

function normalizeBox3(raw) {
  if (!raw) return null;
  if (raw.isBox3) return raw;
  if (Array.isArray(raw.min) && Array.isArray(raw.max)) {
    return new THREE.Box3(new THREE.Vector3(...raw.min), new THREE.Vector3(...raw.max));
  }
  return null;
}

function getShapeRigidInverse(shape) {
  if (shape._rigidCache) return shape._rigidCache;
  let mat = shape.matrix || null;
  if (!mat && shape.inverseMatrix) mat = shape.inverseMatrix.clone().invert();
  if (!mat) {
    shape._rigidCache = { invRigid: null, scale: new THREE.Vector3(1, 1, 1) };
    return shape._rigidCache;
  }
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  mat.decompose(p, q, s);
  const rigid = new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
  const isUnit = Math.abs(s.x - 1) < 1e-6 && Math.abs(s.y - 1) < 1e-6 && Math.abs(s.z - 1) < 1e-6;
  const invRigid = isUnit && shape.inverseMatrix ? shape.inverseMatrix.clone() : rigid.invert();
  shape._rigidCache = { invRigid, mat, scale: s, isUnit };
  return shape._rigidCache;
}

function obbSignedDistance(worldPt, box, shape) {
  const { invRigid, scale } = getShapeRigidInverse(shape);
  const p = invRigid ? _v1.copy(worldPt).applyMatrix4(invRigid) : _v1.copy(worldPt);
  const minX = Math.min(box.min.x * scale.x, box.max.x * scale.x);
  const maxX = Math.max(box.min.x * scale.x, box.max.x * scale.x);
  const minY = Math.min(box.min.y * scale.y, box.max.y * scale.y);
  const maxY = Math.max(box.min.y * scale.y, box.max.y * scale.y);
  const minZ = Math.min(box.min.z * scale.z, box.max.z * scale.z);
  const maxZ = Math.max(box.min.z * scale.z, box.max.z * scale.z);

  const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
  const hx = (maxX - minX) * 0.5, hy = (maxY - minY) * 0.5, hz = (maxZ - minZ) * 0.5;
  const qx = Math.abs(p.x - cx) - hx;
  const qy = Math.abs(p.y - cy) - hy;
  const qz = Math.abs(p.z - cz) - hz;
  const outDist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  const inDist = Math.min(Math.max(qx, qy, qz), 0);
  return outDist + inDist;
}

function triangleMeshSignedDistance(worldPt, triangles, shape) {
  const { mat } = getShapeRigidInverse(shape);
  // If triangles are stored in local space with a matrix, transform point into local space when scaled uniformly or transform vertices if cached
  let worldTris = shape._worldTris;
  if (!worldTris) {
    const nTri = Array.isArray(triangles) && typeof triangles[0] === 'object' && !Array.isArray(triangles[0])
      ? triangles.length
      : Math.floor(triangles.length / 9);
    worldTris = new Float64Array(nTri * 9);
    const pt = new THREE.Vector3();
    for (let i = 0; i < nTri; i += 1) {
      let ax, ay, az, bx, by, bz, cx, cy, cz;
      if (Array.isArray(triangles) && typeof triangles[0] === 'object' && !Array.isArray(triangles[0])) {
        const t = triangles[i];
        ({ x: ax, y: ay, z: az } = t.a);
        ({ x: bx, y: by, z: bz } = t.b);
        ({ x: cx, y: cy, z: cz } = t.c);
      } else {
        const o = i * 9;
        ax = triangles[o]; ay = triangles[o + 1]; az = triangles[o + 2];
        bx = triangles[o + 3]; by = triangles[o + 4]; bz = triangles[o + 5];
        cx = triangles[o + 6]; cy = triangles[o + 7]; cz = triangles[o + 8];
      }
      const o = i * 9;
      if (mat) {
        pt.set(ax, ay, az).applyMatrix4(mat); worldTris[o] = pt.x; worldTris[o + 1] = pt.y; worldTris[o + 2] = pt.z;
        pt.set(bx, by, bz).applyMatrix4(mat); worldTris[o + 3] = pt.x; worldTris[o + 4] = pt.y; worldTris[o + 5] = pt.z;
        pt.set(cx, cy, cz).applyMatrix4(mat); worldTris[o + 6] = pt.x; worldTris[o + 7] = pt.y; worldTris[o + 8] = pt.z;
      } else {
        worldTris[o] = ax; worldTris[o + 1] = ay; worldTris[o + 2] = az;
        worldTris[o + 3] = bx; worldTris[o + 4] = by; worldTris[o + 5] = bz;
        worldTris[o + 6] = cx; worldTris[o + 7] = cy; worldTris[o + 8] = cz;
      }
    }
    if (!mat) shape._worldTris = worldTris;
    else shape._worldTris = worldTris;
  }

  let minSq = Infinity;
  let winding = 0;
  let bestSignFallback = 1;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();

  for (let o = 0; o < worldTris.length; o += 9) {
    a.set(worldTris[o], worldTris[o + 1], worldTris[o + 2]);
    b.set(worldTris[o + 3], worldTris[o + 4], worldTris[o + 5]);
    c.set(worldTris[o + 6], worldTris[o + 7], worldTris[o + 8]);
    _tri.set(a, b, c);
    _tri.closestPointToPoint(worldPt, _cp);
    const sq = worldPt.distanceToSquared(_cp);
    if (sq < minSq) {
      minSq = sq;
      _tri.getNormal(n);
      bestSignFallback = _v2.copy(worldPt).sub(_cp).dot(n) < 0 ? -1 : 1;
    }
    winding += solidAngle(worldPt, a, b, c);
  }

  const dist = Math.sqrt(minSq);
  // Closed mesh: |winding| >= 2*PI means inside
  if (Math.abs(winding) >= Math.PI * 2) return -dist;
  // Open or degenerate shell fallback
  return Math.abs(winding) > 0.2 && Math.abs(winding) < Math.PI ? dist : bestSignFallback * dist;
}

/**
 * Signed distance from `worldPt` to `shape` (`< 0` inside, `0` on surface, `> 0` outside).
 * Supports `{ box, matrix, inverseMatrix }`, `{ triangles, matrix }`, and `{ sphere | center, radius }`.
 */
export function pointClearanceFromShape(worldPt, shape) {
  if (!shape || !worldPt) return Infinity;
  const pt = worldPt.isVector3 ? worldPt : new THREE.Vector3(...worldPt);

  if (shape.triangles && shape.triangles.length) {
    return triangleMeshSignedDistance(pt, shape.triangles, shape);
  }
  const sph = shape.sphere || (shape.radius !== undefined ? shape : null);
  if (sph && (sph.center || sph.radius !== undefined)) {
    const { mat, scale } = getShapeRigidInverse(shape);
    const cRaw = sph.center || [0, 0, 0];
    const center = cRaw.isVector3 ? cRaw.clone() : new THREE.Vector3(...cRaw);
    if (mat && !shape.sphereWorld) center.applyMatrix4(mat);
    const r = num(sph.radius, 0) * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
    return pt.distanceTo(center) - r;
  }
  const box = normalizeBox3(shape.box || (shape.min && shape.max ? shape : null));
  if (box) return obbSignedDistance(pt, box, shape);
  return Infinity;
}

// ── Engine Pinch Solver ──────────────────────────────────────────────────────────────────────────────────────────────

function buildFallbackBoxShape(pt, mat, c, t, metresToSpace) {
  const sz = controlValue(c, 'size', t, null);
  const thick = controlValue(c, 'thickness', t, null);
  let sx, sy, szz;
  if (Array.isArray(sz) && sz.length >= 3) {
    sx = Math.max(1e-5, num(sz[0], 0.02)) * metresToSpace;
    sy = Math.max(1e-5, num(sz[1], 0.02)) * metresToSpace;
    szz = Math.max(1e-5, num(sz[2], 0.02)) * metresToSpace;
  } else if (typeof sz === 'number' && Number.isFinite(sz)) {
    sx = sy = szz = Math.max(1e-5, sz) * metresToSpace;
  } else if (typeof thick === 'number' && Number.isFinite(thick)) {
    const th = Math.max(1e-5, thick) * metresToSpace;
    sx = 0.08 * metresToSpace;
    sy = 0.12 * metresToSpace;
    szz = th;
  } else {
    sx = sy = szz = 0.02 * metresToSpace;
  }
  const box = new THREE.Box3(
    new THREE.Vector3(-sx * 0.5, -sy * 0.5, -szz * 0.5),
    new THREE.Vector3(sx * 0.5, sy * 0.5, szz * 0.5),
  );
  let matrix;
  if (mat) {
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    mat.decompose(p, q, s);
    matrix = new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
  } else {
    matrix = new THREE.Matrix4().makeTranslation(pt.x, pt.y, pt.z);
  }
  return { box, matrix, inverseMatrix: matrix.clone().invert() };
}

function collectFingerVertices(rig, chain) {
  const meshes = skinnedMeshesOf(rig);
  if (!meshes.length) return [];

  const chainSet = new Set(chain);
  const perMesh = [];

  for (const sm of meshes) {
    const bones = sm.skeleton.bones;
    const indices = new Set();
    for (const b of chain) {
      const i = bones.indexOf(b);
      if (i >= 0) indices.add(i);
    }
    if (!indices.size) continue;

    const si = sm.geometry.attributes.skinIndex;
    const sw = sm.geometry.attributes.skinWeight;
    const hits = [];
    for (let v = 0; v < si.count; v += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) if (indices.has(si.getComponent(v, k))) sum += sw.getComponent(v, k);
      if (sum >= 0.5) hits.push(v);
    }
    if (hits.length) perMesh.push({ sm, vertices: Int32Array.from(hits) });
  }

  if (perMesh.length) return perMesh;

  // Fallback to union of computeBoneSkinSupport across chain bones
  const map = new Map();
  for (const b of chain) {
    for (const entry of computeBoneSkinSupport(rig, b)) {
      if (!map.has(entry.sm)) map.set(entry.sm, new Set());
      const s = map.get(entry.sm);
      for (let i = 0; i < entry.vertices.length; i += 1) s.add(entry.vertices[i]);
    }
  }
  // Include _end tip children if present
  const last = chain[chain.length - 1];
  for (const child of last?.children || []) {
    if (!chainSet.has(child)) {
      for (const entry of computeBoneSkinSupport(rig, child)) {
        if (!map.has(entry.sm)) map.set(entry.sm, new Set());
        const s = map.get(entry.sm);
        for (let i = 0; i < entry.vertices.length; i += 1) s.add(entry.vertices[i]);
      }
    }
  }
  return [...map.entries()].map(([sm, s]) => ({ sm, vertices: Int32Array.from(s) }));
}

function getFingerVertexCache(rig, chain) {
  rig._fingerVertsCache ||= new Map();
  const posKey = skinnedMeshesOf(rig).map((sm) => sm.geometry?.attributes?.position?.version ?? 0).join(',');
  const key = `${chain.map((b) => b.id).join(',')}|${posKey}`;
  let cached = rig._fingerVertsCache.get(key);
  if (cached) return cached;

  const full = collectFingerVertices(rig, chain);
  // Build a compact directional-extremal + strided vertex subset (~36 verts/mesh) for fast sweep + bisection.
  const dirs = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    [1, 1, 1], [-1, 1, 1], [1, -1, 1], [-1, -1, 1], [1, 1, -1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1],
  ];
  const sampled = [];
  const vp = new THREE.Vector3();
  for (const { sm, vertices } of full) {
    if (vertices.length <= 40) {
      sampled.push({ sm, vertices });
      continue;
    }
    const picked = new Set();
    const posAttr = sm.geometry.attributes.position;
    for (const d of dirs) {
      let bestVi = vertices[0];
      let bestDot = -Infinity;
      for (let i = 0; i < vertices.length; i += 1) {
        const vi = vertices[i];
        vp.fromBufferAttribute(posAttr, vi);
        const dp = vp.x * d[0] + vp.y * d[1] + vp.z * d[2];
        if (dp > bestDot) { bestDot = dp; bestVi = vi; }
      }
      picked.add(bestVi);
    }
    const stride = Math.max(1, Math.floor(vertices.length / 24));
    for (let i = 0; i < vertices.length && picked.size < 40; i += stride) picked.add(vertices[i]);
    sampled.push({ sm, vertices: Int32Array.from(picked) });
  }
  cached = { full, sampled };
  rig._fingerVertsCache.set(key, cached);
  return cached;
}

function measureFingerGap(fingerVerts, chain, shape) {
  let minGap = Infinity;
  let penetrated = 0;
  let count = 0;
  const v = new THREE.Vector3();

  if (fingerVerts.length) {
    for (const { sm, vertices } of fingerVerts) {
      syncAttachedSkinBindInverse(sm);
      const posAttr = sm.geometry.attributes.position;
      for (let i = 0; i < vertices.length; i += 1) {
        const vi = vertices[i];
        v.fromBufferAttribute(posAttr, vi);
        sm.applyBoneTransform(vi, v);
        v.applyMatrix4(sm.matrixWorld);
        const sd = pointClearanceFromShape(v, shape);
        count += 1;
        if (sd < -1e-6) penetrated += 1;
        if (sd < minGap) minGap = sd;
      }
    }
    return { minGap, penetrated, count };
  }

  // Fallback for bone-only skeletons with no SkinnedMesh
  for (const b of chain) {
    b.updateWorldMatrix(true, false);
    v.setFromMatrixPosition(b.matrixWorld);
    const sd = pointClearanceFromShape(v, shape);
    count += 1;
    if (sd < -1e-6) penetrated += 1;
    if (sd < minGap) minGap = sd;
  }
  return { minGap, penetrated, count };
}

/**
 * Solves a `pinch` constraint: curls each finger in `c.fingers || ['thumb', 'index']` to contact `c.object`
 * at `c.clearance` (default 0.0005 m) without penetrating the object's shape.
 */
export function solvePinchConstraint(rig, c, t, w, L, ctx, warn) {
  const metresToSpace = ctx?.metresToSpace ?? ctx?.unitsPerMetre ?? 1000;
  const spaceToMm = 1000 / metresToSpace;

  const side = normalizeSide(c.side) || (c.bone ? sideOfBone(c.bone) : null);
  const handBones = findHandBones(rig, side);
  if (c.bone) {
    const bn = nodeByName(rig, c.bone);
    if (!bn) {
      warn?.('unknown_bone', `pose: pinch bone "${c.bone}" not found`);
      return;
    }
  }
  const anyFingers = FINGER_NAMES.some((f) => handBones.fingers[f].length > 0);
  if (!anyFingers) {
    warn?.('unknown_hand', `pose: pinch found no hand bones for "${c.bone || side || 'auto'}"`);
    return;
  }

  const axes = detectFingerAxes(rig, handBones, { curlAxis: c.curlAxis });
  const ref = controlValue(c, 'object', t, null) ?? controlValue(c, 'target', t, null);
  if (!ref) {
    warn?.('pinch_object', 'pose: pinch constraint needs `object` or `target`');
    return;
  }
  const cleanRef = typeof ref === 'string' ? ref.replace(/^@/, '') : ref;

  let shape = ctx?.resolveShape?.(cleanRef, t) || ctx?.resolveShape?.(ref, t) || null;
  if (!shape) {
    const mat = ctx?.resolveMatrix?.(ref, t) || ctx?.resolveMatrix?.(cleanRef, t) || null;
    const pt = mat ? new THREE.Vector3().setFromMatrixPosition(mat) : (ctx?.resolve?.(ref, t) || ctx?.resolve?.(cleanRef, t) || null);
    if (!pt) {
      warn?.('unknown_target', `pose: pinch target ${JSON.stringify(ref)} not found`);
      return;
    }
    shape = buildFallbackBoxShape(pt, mat, c, t, metresToSpace);
  }

  rig.root.updateWorldMatrix(true, true);

  const clearanceM = num(Number(controlValue(c, 'clearance', t, 0.0005)), 0.0005);
  const clearanceSpace = clearanceM * metresToSpace;
  const maxCurl = Math.max(0.2, num(Number(controlValue(c, 'maxCurl', t, 1.2)), 1.2));
  const pinchSpread = num(Number(controlValue(c, 'spread', t, 0)), 0);
  const fingerList = Array.isArray(c.fingers) && c.fingers.length ? c.fingers : ['thumb', 'index'];

  const perFingerStats = {};
  let overallMinGap = Infinity;
  let totalPenetrated = 0;

  for (let fi = 0; fi < fingerList.length; fi += 1) {
    const f = fingerList[fi];
    const chain = handBones.fingers[f];
    if (!chain || !chain.length) continue;

    const { full: fingerVerts, sampled: sampleVerts } = getFingerVertexCache(rig, chain);
    const searchVerts = sampleVerts.length ? sampleVerts : fingerVerts;
    const qBase = chain.map((b) => b.quaternion.clone());
    const phalanxDeg = f === 'thumb' ? THUMB_PHALANX_DEG : DEFAULT_PHALANX_DEG;
    const alreadyOpposed = f === 'thumb' ? (rig._handAppliedOppose?.get(chain[0]) || 0) : 0;
    const needOppose = f === 'thumb' ? Math.max(0, 0.78 - alreadyOpposed) : 0;
    const spreadRad = Math.abs(pinchSpread) > 1e-6 ? pinchSpread * (DEFAULT_SPREAD_DEG[f] || 0) * DEG : 0;

    const applyAlpha = (alpha) => {
      for (let k = 0; k < chain.length; k += 1) {
        const b = chain[k];
        b.quaternion.copy(qBase[k]);
        if (!maskAllows(rig, L?.mask, b, 'q')) continue;
        const ax = axes.bones.get(b);
        if (!ax) continue;
        _q1.identity();
        if (k === 0 && spreadRad && ax.spreadAxis) {
          _q2.setFromAxisAngle(ax.spreadAxis, spreadRad);
          _q1.multiply(_q2);
        }
        if (f === 'thumb' && k === 0 && needOppose > 1e-4 && ax.opposeAxis && alpha > 0) {
          const opp = needOppose * clamp01(alpha / 0.45);
          _q2.setFromAxisAngle(ax.opposeAxis, opp * THUMB_OPPOSE_DEG * DEG);
          _q1.multiply(_q2);
        }
        const rad = alpha * (phalanxDeg[Math.min(k, 2)] || 65) * DEG;
        if (Math.abs(rad) > 1e-6) {
          _q2.setFromAxisAngle(ax.curlAxis, rad);
          _q1.multiply(_q2);
        }
        b.quaternion.multiply(_q1);
      }
      chain[0].updateWorldMatrix(false, true);
    };

    const evalAlpha = (alpha, verts = searchVerts) => {
      applyAlpha(alpha);
      return measureFingerGap(verts, chain, shape);
    };

    const g0 = evalAlpha(0);
    let chosenAlpha = 0;

    if (g0.minGap < clearanceSpace) {
      // Base pose already penetrates: sweep backward to uncurl until clear
      const STEPS = 14;
      let lo = 0, hi = -1.1;
      let cleared = false;
      for (let s = 1; s <= STEPS; s += 1) {
        const a = (hi * s) / STEPS;
        const g = evalAlpha(a);
        if (g.minGap >= clearanceSpace) {
          lo = ((s - 1) * hi) / STEPS;
          hi = a;
          cleared = true;
          break;
        }
      }
      if (cleared) {
        for (let it = 0; it < 10; it += 1) {
          const mid = 0.5 * (lo + hi);
          if (evalAlpha(mid).minGap >= clearanceSpace) hi = mid;
          else lo = mid;
        }
        chosenAlpha = hi;
      } else {
        let bestA = 0, bestG = g0.minGap;
        for (let s = 1; s <= STEPS; s += 1) {
          const a = (hi * s) / STEPS;
          const g = evalAlpha(a);
          if (g.minGap > bestG) { bestG = g.minGap; bestA = a; }
        }
        chosenAlpha = bestA;
      }
    } else {
      // Sweep forward using extremal vertex subset
      const STEPS = 18;
      let hitLo = null, hitHi = null;
      let closestAlpha = 0, closestGap = g0.minGap;
      let prevAlpha = 0;

      for (let s = 1; s <= STEPS; s += 1) {
        const a = (maxCurl * s) / STEPS;
        const g = evalAlpha(a);
        if (g.minGap < clearanceSpace) {
          hitLo = prevAlpha;
          hitHi = a;
          break;
        }
        if (g.minGap < closestGap) {
          closestGap = g.minGap;
          closestAlpha = a;
        }
        prevAlpha = a;
      }

      if (hitLo !== null) {
        let lo = hitLo, hi = hitHi;
        for (let it = 0; it < 10; it += 1) {
          const mid = 0.5 * (lo + hi);
          if (evalAlpha(mid).minGap >= clearanceSpace) lo = mid;
          else hi = mid;
        }
        chosenAlpha = lo;
      } else {
        chosenAlpha = closestAlpha;
      }
    }

    // Apply chosen alpha, verify once on full vertex set, and back off only if an unsampled interior vertex penetrates
    applyAlpha(chosenAlpha);
    let fullCheck = fingerVerts !== searchVerts ? measureFingerGap(fingerVerts, chain, shape) : null;
    if (fullCheck && fullCheck.minGap < clearanceSpace && chosenAlpha > -1.05) {
      let lo = Math.max(-1.1, chosenAlpha - 0.35), hi = chosenAlpha;
      if (evalAlpha(lo, fingerVerts).minGap >= clearanceSpace) {
        for (let it = 0; it < 8; it += 1) {
          const mid = 0.5 * (lo + hi);
          if (evalAlpha(mid, fingerVerts).minGap >= clearanceSpace) lo = mid;
          else hi = mid;
        }
        chosenAlpha = lo;
        applyAlpha(chosenAlpha);
      }
    }

    if (w < 1) {
      for (let k = 0; k < chain.length; k += 1) {
        const qSolved = chain[k].quaternion.clone();
        chain[k].quaternion.copy(qBase[k]).slerp(qSolved, w);
      }
      chain[0].updateWorldMatrix(false, true);
    }

    const finalStats = measureFingerGap(fingerVerts, chain, shape);
    if (finalStats.minGap < overallMinGap) overallMinGap = finalStats.minGap;
    totalPenetrated += finalStats.penetrated;
    perFingerStats[f] = {
      alpha: +chosenAlpha.toFixed(4),
      minGapMm: Number.isFinite(finalStats.minGap) ? +(finalStats.minGap * spaceToMm).toFixed(4) : null,
      penetratedVertices: finalStats.penetrated,
      vertexCount: finalStats.count,
    };
  }

  rig.solved.push({
    type: 'pinch',
    bone: c.bone || side || 'auto',
    object: c.object ?? c.target ?? null,
    weight: +w.toFixed(4),
    clearanceMm: +(clearanceSpace * spaceToMm).toFixed(4),
    minGapMm: Number.isFinite(overallMinGap) ? +(overallMinGap * spaceToMm).toFixed(4) : null,
    penetratedVertices: totalPenetrated,
    fingers: perFingerStats,
  });
}

// ── Cross-model Target, Shape, & World-Attach Helpers ─────────────────────────────────────────────────────────────

const _hmPos = new THREE.Vector3(), _hmQuat = new THREE.Quaternion(), _hmScale = new THREE.Vector3();
const _ownPos = new THREE.Vector3(), _ownQuat = new THREE.Quaternion(), _ownScale = new THREE.Vector3();
const _hmMat = new THREE.Matrix4();

/** Look up a loaded model entry by itemId or channel name inside `entries` (`Map` or iterable of `{ itemId, entry }`). */
export function findModelEntry(ref, entries, channels = null) {
  if (!entries) return null;
  let modelId = null;
  if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
    if (typeof ref.model !== 'string' || !ref.model) return null;
    modelId = ref.model.replace(/^@/, '');
  } else if (typeof ref === 'string') {
    modelId = ref.replace(/^@/, '');
  } else {
    return null;
  }
  const get = (id) => (entries instanceof Map ? entries.get(id) : entries.find((e) => e?.itemId === id)?.entry || entries.find((e) => e?.itemId === id));
  const direct = get(modelId);
  if (direct) return { itemId: modelId, entry: direct };
  if (Array.isArray(channels)) {
    for (const ch of channels) {
      if (ch?.name !== modelId) continue;
      for (const it of ch.items || []) {
        const hit = get(it?.id);
        if (hit) return { itemId: it.id, entry: hit };
      }
    }
  }
  return null;
}

function findNodeInModel(root, boneName) {
  if (!root || !boneName) return null;
  const clean = THREE.PropertyBinding.sanitizeNodeName(String(boneName));
  let hit = null;
  root.traverse((n) => {
    if (!hit && (n.name === boneName || n.name === clean)) hit = n;
  });
  return hit;
}

/** Resolve a target `{ model, bone?, point? }` or `"@modelId"` against loaded model entries in editor space. */
export function resolveModelTarget(ref, entries, channels = null, metresToSpace = 1000) {
  const found = findModelEntry(ref, entries, channels);
  if (!found?.entry) return null;
  const { itemId, entry } = found;
  const boneName = ref && typeof ref === 'object' ? ref.bone : null;
  const node = boneName ? findNodeInModel(entry.root || entry.inner, boneName) : (entry.inner || entry.root);
  if (!node) return null;
  node.updateWorldMatrix(true, false);
  const wm = entry.heldDelta ? _hmMat.multiplyMatrices(entry.heldDelta, node.matrixWorld) : node.matrixWorld;
  wm.decompose(_hmPos, _hmQuat, _hmScale);
  const m = new THREE.Matrix4().compose(_hmPos, _hmQuat, _hmScale.set(1, 1, 1));
  const pt = ref && typeof ref === 'object' && Array.isArray(ref.point) && ref.point.length >= 3 ? ref.point : null;
  if (pt) {
    m.multiply(new THREE.Matrix4().makeTranslation(num(pt[0], 0) * metresToSpace, num(pt[1], 0) * metresToSpace, num(pt[2], 0) * metresToSpace));
  }
  return { itemId, entry, node, matrix: m, point: new THREE.Vector3().setFromMatrixPosition(m) };
}

/** Build an OBB shape descriptor `{ box, matrix, inverseMatrix }` for a loaded model entry in editor space. */
export function modelBoxShape(entry) {
  if (!entry) return null;
  const root = entry.root || entry.inner;
  if (!root) return null;
  if (root.parent) root.parent.updateWorldMatrix(true, false);
  root.updateWorldMatrix(true);
  const invRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const box = new THREE.Box3();
  const mRel = new THREE.Matrix4();
  const bTmp = new THREE.Box3();
  root.traverse((o) => {
    if (!o.isMesh || o.visible === false || o.userData?.catcher || o.userData?.layerTwin) return;
    if (o.isSkinnedMesh && o.boundingBox && !o.boundingBox.isEmpty()) {
      mRel.multiplyMatrices(invRoot, o.matrixWorld);
      bTmp.copy(o.boundingBox).applyMatrix4(mRel);
      box.union(bTmp);
      return;
    }
    const g = o.geometry;
    if (!g?.attributes?.position) return;
    if (!g.boundingBox) g.computeBoundingBox();
    if (g.boundingBox && !g.boundingBox.isEmpty()) {
      mRel.multiplyMatrices(invRoot, o.matrixWorld);
      bTmp.copy(g.boundingBox).applyMatrix4(mRel);
      box.union(bTmp);
    }
  });
  if (box.isEmpty() && entry.box) box.copy(entry.box);
  if (box.isEmpty()) return null;
  const rootMat = entry.heldDelta
    ? new THREE.Matrix4().multiplyMatrices(entry.heldDelta, root.matrixWorld)
    : root.matrixWorld.clone();
  return {
    box,
    matrix: rootMat,
    inverseMatrix: rootMat.clone().invert(),
  };
}

/** Compute the world-metres matrix for an `attach`-held timeline model layer (preserving its fitted Scene scale `_ownScale`). */
export function heldModelMatrix(ownWorldMetres16, attachEntry, worldUnits = 0.001) {
  const out = new THREE.Matrix4().fromArray(ownWorldMetres16);
  if (attachEntry?.matrix && attachEntry.weight > 0) {
    out.decompose(_ownPos, _ownQuat, _ownScale);
    const m = new THREE.Matrix4().fromArray(attachEntry.matrix);
    m.decompose(_hmPos, _hmQuat, _hmScale);
    _hmPos.multiplyScalar(worldUnits);
    out.compose(_ownPos.lerp(_hmPos, attachEntry.weight), _ownQuat.slerp(_hmQuat, attachEntry.weight), _ownScale);
  }
  return out.toArray();
}

/** Extract a best-effort local shape box/sphere from a Scene object's procedural `graph` ops paired with its editor-space matrix. */
export function shapeFromSceneObject(obj, worldMatrixEditor, metresToSpace = 1000) {
  if (!obj || !worldMatrixEditor) return null;
  const ops = Array.isArray(obj.graph) ? obj.graph : [];
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const g = ops[i];
    if (!g || typeof g !== 'object') continue;
    if (g.op === 'sphere' && Number.isFinite(Number(g.radius))) {
      const r = Math.max(1e-5, Number(g.radius)) * metresToSpace;
      return { sphere: { center: [0, 0, 0], radius: r }, matrix: worldMatrixEditor };
    }
    if (g.op === 'box' && g.size !== undefined) {
      const s = Array.isArray(g.size) ? g.size : [g.size, g.size, g.size];
      const hx = Math.max(1e-5, Number(s[0] ?? 1)) * 0.5 * metresToSpace;
      const hy = Math.max(1e-5, Number(s[1] ?? s[0] ?? 1)) * 0.5 * metresToSpace;
      const hz = Math.max(1e-5, Number(s[2] ?? s[0] ?? 1)) * 0.5 * metresToSpace;
      return { box: { min: [-hx, -hy, -hz], max: [hx, hy, hz] }, matrix: worldMatrixEditor, inverseMatrix: worldMatrixEditor.clone().invert() };
    }
    if (g.op === 'capsule' || g.op === 'cylinder') {
      const rt = Number(g.radiusTop), rb = Number(g.radiusBottom), rr = Number(g.radius);
      const rRaw = Number.isFinite(rt) || Number.isFinite(rb)
        ? Math.max(Number.isFinite(rt) ? rt : 0, Number.isFinite(rb) ? rb : 0)
        : (Number.isFinite(rr) ? rr : 0.25);
      const r = Math.max(1e-5, rRaw) * metresToSpace;
      const hRaw = Number(g.height ?? g.length);
      const h = Math.max(r * 2, (Number.isFinite(hRaw) ? hRaw : 0.2) * metresToSpace);
      return { box: { min: [-r, -h * 0.5, -r], max: [r, h * 0.5, r] }, matrix: worldMatrixEditor, inverseMatrix: worldMatrixEditor.clone().invert() };
    }
  }
  return null;
}

/**
 * Topologically order pending timeline `model3d` items so unconstrained models and `attach` holders
 * always pose before any constrained models targeting them or their held props.
 */
export function orderModelPoses(pending, channels = null) {
  if (!Array.isArray(pending) || pending.length <= 1) return pending ? [...pending] : [];
  const itemOf = (p) => p?.item || p?.opts?.item || p;
  const n = pending.length;
  const idToIdx = new Map();
  const aliasToIdx = new Map();
  for (let i = 0; i < n; i += 1) {
    const it = itemOf(pending[i]);
    if (it?.id != null) {
      const k = String(it.id);
      idToIdx.set(k, i);
      aliasToIdx.set(k, i);
    }
  }
  if (Array.isArray(channels)) {
    for (const ch of channels) {
      if (!ch?.name) continue;
      for (const it of ch.items || []) {
        const idx = it?.id != null ? idToIdx.get(String(it.id)) : undefined;
        if (idx !== undefined) {
          aliasToIdx.set(ch.name, idx);
          break;
        }
      }
    }
  }

  const refIdx = (ref) => {
    if (!ref) return undefined;
    if (typeof ref === 'string') return aliasToIdx.get(ref.replace(/^@/, ''));
    if (typeof ref === 'object' && !Array.isArray(ref) && typeof ref.model === 'string') {
      return aliasToIdx.get(ref.model.replace(/^@/, ''));
    }
    return undefined;
  };

  const hasCons = new Array(n).fill(false);
  const attachers = new Map(); // target idx -> Set of attacher indices
  const reads = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < n; i += 1) {
    const pose = itemOf(pending[i])?.model3dConfig?.pose;
    if (!pose || typeof pose !== 'object') continue;
    const layers = [pose, ...(Array.isArray(pose.layers) ? pose.layers : [])];
    for (const L of layers) {
      if (!L || typeof L !== 'object') continue;
      if (L.hands) hasCons[i] = true;
      for (const c of Array.isArray(L.constraints) ? L.constraints : []) {
        if (!c || c.on === false) continue;
        hasCons[i] = true;
        if (c.type === 'attach') {
          const ti = refIdx(c.object);
          if (ti !== undefined && ti !== i) {
            let s = attachers.get(ti);
            if (!s) attachers.set(ti, s = new Set());
            s.add(i);
          }
          continue;
        }
        const candidates = [c.target, c.pole, c.object, ...(Array.isArray(c.path) ? c.path : []), c.orient?.aim];
        for (const cand of candidates) {
          const ti = refIdx(cand);
          if (ti !== undefined && ti !== i) reads[i].add(ti);
        }
      }
    }
  }

  const unconstrained = [];
  const constrained = [];
  for (let i = 0; i < n; i += 1) (hasCons[i] ? constrained : unconstrained).push(i);

  const cSet = new Set(constrained);
  const adj = new Map(constrained.map((i) => [i, new Set()]));
  const indeg = new Map(constrained.map((i) => [i, 0]));
  const addEdge = (from, to) => {
    if (from === to || !cSet.has(from) || !cSet.has(to)) return;
    const edges = adj.get(from);
    if (!edges.has(to)) { edges.add(to); indeg.set(to, indeg.get(to) + 1); }
  };
  for (const i of constrained) {
    for (const ti of reads[i]) {
      addEdge(ti, i);
      const holders = attachers.get(ti);
      if (holders) for (const h of holders) addEdge(h, i);
    }
  }

  const ready = constrained.filter((i) => indeg.get(i) === 0);
  const orderedConstrained = [];
  const emitted = new Set();
  while (orderedConstrained.length < constrained.length) {
    if (!ready.length) {
      const next = constrained.find((i) => !emitted.has(i));
      if (next === undefined) break;
      ready.push(next);
    }
    ready.sort((a, b) => a - b);
    const cur = ready.shift();
    if (emitted.has(cur)) continue;
    emitted.add(cur);
    orderedConstrained.push(cur);
    for (const nxt of adj.get(cur) || []) {
      const d = indeg.get(nxt) - 1;
      indeg.set(nxt, d);
      if (d === 0 && !emitted.has(nxt)) ready.push(nxt);
    }
  }
  return [...unconstrained, ...orderedConstrained].map((i) => pending[i]);
}
