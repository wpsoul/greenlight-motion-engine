import * as THREE from 'three';
import { materials as makeMaterial } from './materialFactory';
import { readTargetPixels } from './readTargetPixels';
import { trackBake } from './asyncBakes';

/*
 * Rig (Puppet Pin) — typed Layer Effect, the After Effects Puppet analog.
 *
 * Math ported from html/rig-tool-lab-v2.html (the user-approved UX truth) and
 * html/rig-tool-app-mock.html (the app-integration harness): rigid moving-least-
 * squares solved in closed form per vertex — no solver. Every pin both poses AND
 * holds its region; Advanced/Bend pins contribute 4 rotated/scaled satellite
 * controls that share the pin's weight field (propagating rotation/scale through
 * the MLS with no new math); Starch pins run a post-pass that blends vertices
 * toward the locally-rigid transform so a region stops bending.
 *
 * Everything runs in MESH-CELL space: the grid is defined by a cell count, not
 * pixels, so the mesh is identical at every preview zoom and export size. Cells
 * are square in layer space because cols/rows follow the box aspect. Pins are
 * stored in unit-box coords (±0.5 of the layer box, y down — the shapePath
 * convention), so the rig survives layer move/scale/rotate and camera for free.
 *
 * Keyframes ride `rig:<pid>:<chan>` scalar tracks (see keyframeProps.js
 * RIG_KF_PREFIX): x/y are OFFSETS from the pin's rest in % of the layer box
 * (un-keyed pins sit at rest; "reset pose" = delete tracks — the Group
 * Distributor precedent), rot is degrees, scl and amount are %.
 *
 * The mesh + weights are baked from a low-res readback of the layer's isolate
 * (the autofillField.js crop-pass recipe) and cached per effect instance keyed
 * on structural params — never rebuilt per frame, so export stays deterministic.
 */

export const RIG_LAYER_EFFECT_ID = 'rig';

// PRO, gated exactly like Running Glow: free to design and preview, paywalled at
// render (containsProRigEffect below + the gate in VideoEditor's
// handleRenderInBackground). The effect IS the flag — no feature-id list.
export const RIG_IS_PRO = true;

export const RIG_DEFAULTS = {
  rigDensity: 24,     // mesh cells across the layer box's longer side
  rigExpansion: 1,    // dilate the alpha-clipped grid by N cells
  rigWeights: 0,      // 0 = geodesic (mesh), 1 = euclidean
  rigStiffness: 1.2,  // weight falloff exponent α — higher = stiffer, more local
};

export const RIG_NUMBER_FIELDS = [
  { key: 'rigDensity', label: 'Mesh density', min: 8, max: 48, step: 2 },
  { key: 'rigExpansion', label: 'Expansion', min: 0, max: 3, step: 1 },
  { key: 'rigStiffness', label: 'Stiffness', min: 0.6, max: 2.4, step: 0.1 },
];

export const RIG_ENUM_FIELDS = [
  {
    key: 'rigWeights',
    label: 'Weights',
    options: [[0, 'Geodesic (mesh)'], [1, 'Euclidean']],
  },
];

// ── Pin model ───────────────────────────────────────────────────────────────
// { pid, type, name, x, y, amount, extent, hardness } — x/y rest in unit-box
// coords (±0.5, y down). amount/hardness in %, extent in % of the box height
// (starch only). Every field the sanitizer doesn't spell out here is dropped.

export const RIG_PIN_TYPES = ['position', 'advanced', 'bend', 'starch'];

export const RIG_PIN_COLORS = {
  position: '#e3c368',
  advanced: '#79c07a',
  bend: '#dd9a55',
  starch: '#d97a7a',
};

export const RIG_PIN_LABELS = {
  position: 'Position',
  advanced: 'Advanced',
  bend: 'Bend',
  starch: 'Starch',
};

// Animatable channels per pin type. Starch amount is keyframable but rarely keyed.
export const RIG_PIN_CHANNELS = {
  position: ['x', 'y'],
  advanced: ['x', 'y', 'rot', 'scl'],
  bend: ['rot', 'scl'],
  starch: ['amount'],
};

// Builder/graph metadata per channel. x/y are offsets from rest in % of the
// layer box — 0 means "at rest", matching the Group Distributor convention.
export const RIG_KF_CHAN_META = {
  x: { label: 'X', unit: '%', min: -300, max: 300, step: 0.5, neutral: 0 },
  y: { label: 'Y', unit: '%', min: -300, max: 300, step: 0.5, neutral: 0 },
  rot: { label: 'Rotation', unit: 'deg', min: -1080, max: 1080, step: 1, neutral: 0 },
  scl: { label: 'Scale', unit: '%', min: 10, max: 400, step: 1, neutral: 100 },
  amount: { label: 'Amount', unit: '%', min: 0, max: 100, step: 1, neutral: 100 },
};

// ── IK limbs (chains) ───────────────────────────────────────────────────────
// { cid, joints:[pid,pid,pid], bend:±1, preserveTex, fleshR } — pure authoring
// assists: the overlay's 2-bone solve writes the joints' rig: tracks, so
// playback needs no solver. Everything geometric (bone lengths, rest angles,
// rigidity samples, preserve-tex masks) derives from the joints' REST pins —
// bones bind at rest exactly like the mesh does. What DOES run at render time
// is deterministic: sample controls and masks are pure functions of the rest
// pins and the evaluated joint poses (see PLANS/RIG_TOOL_PLAN.md §9).

export const RIG_CHAIN_FLESH = { min: 2, max: 30, def: 8 }; // % of the box height
const MAX_CHAINS = 8;

export function sanitizeRigChains(list, pins) {
  if (!Array.isArray(list)) return [];
  const pids = new Set((Array.isArray(pins) ? pins : []).map((p) => p?.pid));
  const used = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const joints = Array.isArray(raw.joints) ? raw.joints : [];
    if (joints.length !== 3) continue;
    if (joints.some((pid) => typeof pid !== 'string' || !pids.has(pid))) continue;
    if (new Set(joints).size !== 3) continue;
    if (joints.some((pid) => used.has(pid))) continue; // a pin belongs to one limb
    const cid = typeof raw.cid === 'string' && PID_RE.test(raw.cid) ? raw.cid : `c${out.length + 1}`;
    joints.forEach((pid) => used.add(pid));
    out.push({
      cid,
      joints: [...joints],
      bend: Number(raw.bend) === -1 ? -1 : 1,
      preserveTex: raw.preserveTex !== false,
      fleshR: clampNum(raw.fleshR, RIG_CHAIN_FLESH.def, RIG_CHAIN_FLESH.min, RIG_CHAIN_FLESH.max),
    });
    if (out.length >= MAX_CHAINS) break;
  }
  return out;
}

const PID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const RIG_KF_RE = /^rig:([A-Za-z0-9_-]{1,24}):(x|y|rot|scl|amount)$/;

export function rigKfKey(pid, chan) {
  return `rig:${pid}:${chan}`;
}

export function parseRigKfKey(key) {
  if (typeof key !== 'string') return null;
  const m = RIG_KF_RE.exec(key);
  return m ? { pid: m[1], chan: m[2] } : null;
}

export function getRigEffect(item) {
  const list = Array.isArray(item?.layerEffects) ? item.layerEffects : [];
  return list.find((effect) => effect?.id === RIG_LAYER_EFFECT_ID) || null;
}

// Active = enabled with at least one pin. A pin-less rig deforms nothing, so it
// neither forces the multi-pass path nor gates the render as PRO.
export function isRigEnabled(item) {
  const effect = getRigEffect(item);
  if (!effect || effect.enabled === false) return false;
  return Array.isArray(effect.pins) && effect.pins.length > 0;
}

const clampNum = (v, fallback, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

// Autosave strips whatever isn't re-emitted here (the standing item-field
// whitelist hazard) — every pin field must be spelled out.
export function sanitizeRigPins(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const pid = typeof raw.pid === 'string' && PID_RE.test(raw.pid) ? raw.pid : null;
    if (!pid || seen.has(pid)) continue;
    const type = RIG_PIN_TYPES.includes(raw.type) ? raw.type : 'position';
    seen.add(pid);
    out.push({
      pid,
      type,
      name: typeof raw.name === 'string' && raw.name ? raw.name.slice(0, 40) : `${RIG_PIN_LABELS[type]} pin`,
      x: clampNum(raw.x, 0, -0.75, 0.75),
      y: clampNum(raw.y, 0, -0.75, 0.75),
      ...(type === 'starch' ? {
        amount: clampNum(raw.amount, 100, 0, 100),
        extent: clampNum(raw.extent, 16, 4, 80),
        hardness: clampNum(raw.hardness, 50, 0, 95),
      } : {}),
    });
    if (out.length >= 64) break;
  }
  return out;
}

// Effective per-frame pose per pin: keyframe track ?? neutral. x/y come back as
// unit-box offsets, rot in radians, scl/amount as fractions.
export function resolveRigPoses(effect, keyframeProps) {
  const pins = Array.isArray(effect?.pins) ? effect.pins : [];
  const kf = keyframeProps || {};
  return pins.map((pin) => {
    const chan = (name, neutral) => {
      const v = kf[rigKfKey(pin.pid, name)];
      return Number.isFinite(v) ? v : neutral;
    };
    return {
      pin,
      dx: chan('x', 0) / 100,
      dy: chan('y', 0) / 100,
      rot: (chan('rot', 0) * Math.PI) / 180,
      scl: chan('scl', 100) / 100,
      amount: chan('amount', pin.type === 'starch' ? (pin.amount ?? 100) : 100) / 100,
    };
  });
}

// All channels neutral → the warp is an exact identity; the pass can be skipped.
export function isRigPoseNeutral(poses) {
  for (const p of poses) {
    if (p.pin.type === 'starch') continue; // starch is inert without a deformer pose
    if (Math.abs(p.dx) > 1e-6 || Math.abs(p.dy) > 1e-6) return false;
    if (p.pin.type !== 'position' && (Math.abs(p.rot) > 1e-6 || Math.abs(p.scl - 1) > 1e-6)) return false;
  }
  return true;
}

// KF_PROPS-shaped entries so the Keyframe Builder's row list, "Add Property"
// dropdown, timeline pill and graph editor pick the rig tracks up like any
// other property (the buildMotionKfProps / buildGridKfProps pattern).
export function buildRigKfProps(item) {
  const effect = getRigEffect(item);
  if (!effect) return [];
  const pins = Array.isArray(effect.pins) ? effect.pins : [];
  const out = [];
  for (const pin of pins) {
    for (const chan of RIG_PIN_CHANNELS[pin.type] || []) {
      const meta = RIG_KF_CHAN_META[chan];
      out.push({
        label: rigKfKey(pin.pid, chan),
        group: 'Rig',
        displayLabel: `${pin.name || pin.pid} · ${meta.label}`,
        placeholder: String(meta.neutral),
        unit: meta.unit,
        type: 'number',
        min: meta.min,
        max: meta.max,
        step: meta.step,
      });
    }
  }
  return out;
}

// ── PRO render gate (containsProGlowEffect precedent) ──────────────────────
// Project sequences can nest other sequences, so walk the complete saved state.
function rigGatesRender(item) {
  if (!RIG_IS_PRO) return false;
  return isRigEnabled(item);
}

export function containsProRigEffect(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (rigGatesRender(value)) return true;
  if (Array.isArray(value)) return value.some((entry) => containsProRigEffect(entry, seen));
  return Object.values(value).some((entry) => containsProRigEffect(entry, seen));
}

// ── Mesh bake: alpha-clipped grid over the layer box ───────────────────────
// The isolate's alpha is read back once per structural change through the same
// crop pass autofillField.js uses (box quad → small grid), then the grid keeps
// only cells touching alpha (9 sub-samples per cell), dilated by `expansion`.

const SUB = 3;              // mask sub-samples per cell side
const SAT_R = 0.8;          // satellite radius, in cells (lab: 18px / 22px cell)
const MAX_CACHED = 8;

let cropScene = null;
let cropMaterial = null;
let cropCamera = null;
// A free list rather than one shared target: the read that follows the crop is
// asynchronous (see readAlphaMask), so two layers baking in the same frame would
// otherwise both read whichever crop landed last.
const cropPool = [];
let cropRuntimeGeneration = 0;

/*
 * RELEASE THE POOLED RENDER TARGETS — they belong to ONE renderer.
 *
 * `cropPool` is module state, so it outlives any renderer. A WebGLRenderTarget
 * is not renderer-agnostic the way a Texture is: it owns a framebuffer bound to
 * the context that created it. After the pipeline is rebuilt (switching the
 * project's engine does exactly that), a pooled target from the previous
 * renderer is dead, and the rig bake that reuses it silently produces
 * nothing — the effect looks broken with no error anywhere.
 *
 * Called from the Player's teardown, alongside the passes it disposes there.
 * The BAKED RESULTS are deliberately left alone: those are CPU-side arrays and
 * stay valid across renderers, so a rebuild does not force a re-bake.
 */
export function disposeRigCropTargets() {
  cropRuntimeGeneration += 1;
  for (const target of cropPool) {
    try { target.dispose(); } catch { /* no-op */ }
  }
  cropPool.length = 0;
  try { cropMaterial?.dispose(); } catch { /* no-op */ }
  try { cropScene?.children?.[0]?.geometry?.dispose(); } catch { /* no-op */ }
  cropScene?.clear();
  cropScene = null;
  cropMaterial = null;
  cropCamera = null;
  inFlight.clear();
}
const CROP_POOL_MAX = 4;

/*
 * The crop material, as its own factory.
 *
 * It used to be built inline inside ensureCropRig(), which meant the port
 * harness had no way to reach the GLSL side and A/B it — the same problem
 * cameraDof and the 3D tone pass had. Naming it costs nothing and makes the
 * comparison possible; ensureCropRig's behaviour is unchanged.
 */
/*
 * The crop material, as its own factory.
 *
 * It used to be built inline inside ensureCropRig(), which meant the port
 * harness had no way to reach the GLSL side and A/B it — the same problem
 * cameraDof and the 3D tone pass had. Naming it costs nothing and makes the
 * comparison possible; ensureCropRig's behaviour is unchanged.
 */
export function createRigCropMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: null },
      uOutSize: { value: new THREE.Vector2(1, 1) },
      uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
      uAxisX: { value: new THREE.Vector2(0.5, 0) },
      uAxisY: { value: new THREE.Vector2(0, 0.5) },
    },
    vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uOutSize, uOrigin, uAxisX, uAxisY;
void main(){
  vec2 p = gl_FragCoord.xy / uOutSize;
  vec2 q = p * 2.0 - 1.0;
  vec2 uv = uOrigin + uAxisX * q.x + uAxisY * q.y;
  gl_FragColor = (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)
    ? vec4(0.0) : texture2D(uTex, uv);
}
`,
    depthTest: false,
    depthWrite: false,
  });
}

function ensureCropRig() {
  if (!cropScene) {
    cropMaterial = makeMaterial.rigCrop() ?? createRigCropMaterial();
    cropScene = new THREE.Scene();
    cropScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), cropMaterial));
    cropCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
}

function acquireCropTarget(gw, gh) {
  const i = cropPool.findIndex((t) => t.width === gw && t.height === gh);
  if (i >= 0) return cropPool.splice(i, 1)[0];
  return new THREE.WebGLRenderTarget(gw, gh, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

function releaseCropTarget(target, generation = cropRuntimeGeneration) {
  if (!target) return;
  if (generation !== cropRuntimeGeneration) {
    target.dispose();
    return;
  }
  if (cropPool.length < CROP_POOL_MAX) cropPool.push(target);
  else target.dispose();
}

// Snapshot the matte into a target of its own. SYNCHRONOUS on purpose, and the
// previous render target is restored before the caller can await anything: the
// caller is mid-frame, `matteTexture` is the isolate that later passes in the
// same frame overwrite, and every one of those passes would otherwise draw into
// the crop target. Only the READ of this snapshot is deferred.
function cropMatte(renderer, matteTexture, box, gw, gh) {
  ensureCropRig();
  const target = acquireCropTarget(gw, gh);
  const u = cropMaterial.uniforms;
  u.uTex.value = matteTexture;
  u.uOutSize.value.set(gw, gh);
  u.uOrigin.value.set(box.origin[0], box.origin[1]);
  u.uAxisX.value.set(box.axisX[0], box.axisX[1]);
  u.uAxisY.value.set(box.axisY[0], box.axisY[1]);
  const prev = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(cropScene, cropCamera);
  renderer.setRenderTarget(prev);
  renderer.setClearColor(prevClear, prevAlpha);
  return target;
}

// THE renderer-dependent step, and the reason the deform state bakes
// asynchronously: `readRenderTargetPixels` is synchronous and does not exist on
// a WebGPU renderer — there is only `readRenderTargetPixelsAsync`, whose result
// is the raw mapped staging buffer (256-byte row stride, row 0 is the TOP row
// where WebGL hands back the BOTTOM). Both defects read back as a
// plausible-looking buffer, so the unpad + row-flip goes in WITH the swap, here
// — see html/webgpu-migration/PORTING-GUIDE.md §3.4.
//
// The buffer is allocated per read, never shared: with a read in flight a second
// bake would otherwise overwrite the first one's pixels.
async function readAlphaMask(renderer, target, gw, gh) {
  const pixels = await readTargetPixels(renderer, target, gw, gh);
  const n = gw * gh;
  const mask = new Uint8Array(n);
  let hash = 0x811c9dc5;
  for (let i = 0; i < n; i++) {
    const m = pixels[i * 4 + 3] >= 10 ? 1 : 0;
    mask[i] = m;
    hash ^= m;
    hash = Math.imul(hash, 0x01000193);
  }
  return { mask, hash: hash >>> 0 };
}

// Grid dimensions from the box aspect: `density` cells across the longer side,
// so cells stay square in layer space and the mesh is zoom/export independent.
export function rigGridFor(box, density) {
  const w = Math.max(1, box?.sizePx?.[0] || 1);
  const h = Math.max(1, box?.sizePx?.[1] || 1);
  const cells = Math.min(48, Math.max(8, Math.round(density) || 24));
  if (w >= h) {
    return { cols: cells, rows: Math.min(48, Math.max(3, Math.round(cells * h / w))) };
  }
  return { cols: Math.min(48, Math.max(3, Math.round(cells * w / h))), rows: cells };
}

// The crop pass reads the mask y-DOWN relative to the box's visual top?  No —
// gl_FragCoord row 0 is the target's bottom, and the affine maps q=(-1,-1) to
// origin−axisX−axisY, which is the box's uv-space bottom-left. Frame uv is y-UP,
// so mask row 0 = the box's visual BOTTOM. Cell/vertex coords below therefore
// live in a y-UP cell space; unit-box pin coords (y down) flip on the way in.
function buildRigMesh(mask, cols, rows, expansion) {
  const gw = cols * SUB;
  let keep = new Uint8Array(cols * rows);
  let kept = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let hit = 0;
      for (let sy = 0; sy < SUB && !hit; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          if (mask[(cy * SUB + sy) * gw + cx * SUB + sx]) { hit = 1; break; }
        }
      }
      if (hit) { keep[cy * cols + cx] = 1; kept += 1; }
    }
  }
  // A fully transparent readback (empty frame, matte miss) keeps everything —
  // the warp then behaves like a plain box grid instead of vanishing.
  if (!kept) keep.fill(1);
  for (let d = 0; d < expansion; d++) {
    const nk = new Uint8Array(keep);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        if (keep[cy * cols + cx]) continue;
        if ((cx > 0 && keep[cy * cols + cx - 1]) || (cx < cols - 1 && keep[cy * cols + cx + 1])
          || (cy > 0 && keep[(cy - 1) * cols + cx]) || (cy < rows - 1 && keep[(cy + 1) * cols + cx])) {
          nk[cy * cols + cx] = 1;
        }
      }
    }
    keep = nk;
  }
  const vidx = new Int32Array((cols + 1) * (rows + 1)).fill(-1);
  const vx = [];
  const vy = [];
  const vId = (gx, gy) => {
    const k = gy * (cols + 1) + gx;
    if (vidx[k] < 0) { vidx[k] = vx.length; vx.push(gx); vy.push(gy); }
    return vidx[k];
  };
  const tris = [];
  const edgeSet = new Set();
  const adjMap = new Map();
  const addEdge = (i, j) => {
    const k = i < j ? i * 1e6 + j : j * 1e6 + i;
    if (edgeSet.has(k)) return;
    edgeSet.add(k);
    if (!adjMap.has(i)) adjMap.set(i, []);
    if (!adjMap.has(j)) adjMap.set(j, []);
    adjMap.get(i).push(j);
    adjMap.get(j).push(i);
  };
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (!keep[cy * cols + cx]) continue;
      const v00 = vId(cx, cy);
      const v10 = vId(cx + 1, cy);
      const v01 = vId(cx, cy + 1);
      const v11 = vId(cx + 1, cy + 1);
      tris.push(v00, v10, v11, v00, v11, v01);
      addEdge(v00, v10); addEdge(v10, v11); addEdge(v11, v01); addEdge(v01, v00); addEdge(v00, v11);
    }
  }
  const V = vx.length;
  const rest = new Float32Array(V * 2);
  for (let i = 0; i < V; i++) {
    rest[i * 2] = vx[i];
    rest[i * 2 + 1] = vy[i];
  }
  const adjStart = new Int32Array(V + 1);
  const adjFlat = [];
  for (let i = 0; i < V; i++) {
    adjStart[i] = adjFlat.length;
    const n = adjMap.get(i);
    if (n) for (const j of n) adjFlat.push(j);
  }
  adjStart[V] = adjFlat.length;
  return {
    cols, rows, V, rest,
    tris: new Uint32Array(tris),
    adjStart,
    adj: new Int32Array(adjFlat),
  };
}

function nearestVertex(mesh, x, y) {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < mesh.V; i++) {
    const dx = mesh.rest[i * 2] - x;
    const dy = mesh.rest[i * 2 + 1] - y;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function geodesicDist(mesh, srcVert) {
  const V = mesh.V;
  const dist = new Float32Array(V).fill(Infinity);
  const heap = new Float64Array(V * 4);
  let hn = 0;
  const push = (d, i) => {
    let c = hn++;
    heap[c * 2] = d; heap[c * 2 + 1] = i;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p * 2] <= heap[c * 2]) break;
      const td = heap[p * 2]; const ti = heap[p * 2 + 1];
      heap[p * 2] = heap[c * 2]; heap[p * 2 + 1] = heap[c * 2 + 1];
      heap[c * 2] = td; heap[c * 2 + 1] = ti;
      c = p;
    }
  };
  const pop = () => {
    const rd = heap[0]; const ri = heap[1];
    hn -= 1;
    heap[0] = heap[hn * 2]; heap[1] = heap[hn * 2 + 1];
    let c = 0;
    for (;;) {
      const l = c * 2 + 1; const r = l + 1;
      let m = c;
      if (l < hn && heap[l * 2] < heap[m * 2]) m = l;
      if (r < hn && heap[r * 2] < heap[m * 2]) m = r;
      if (m === c) break;
      const td = heap[m * 2]; const ti = heap[m * 2 + 1];
      heap[m * 2] = heap[c * 2]; heap[m * 2 + 1] = heap[c * 2 + 1];
      heap[c * 2] = td; heap[c * 2 + 1] = ti;
      c = m;
    }
    return [rd, ri];
  };
  dist[srcVert] = 0;
  push(0, srcVert);
  while (hn > 0) {
    const [d, iF] = pop();
    const i = iF | 0;
    if (d > dist[i]) continue;
    const x = mesh.rest[i * 2];
    const y = mesh.rest[i * 2 + 1];
    for (let k = mesh.adjStart[i]; k < mesh.adjStart[i + 1]; k++) {
      const j = mesh.adj[k];
      const dx = mesh.rest[j * 2] - x;
      const dy = mesh.rest[j * 2 + 1] - y;
      const nd = d + Math.hypot(dx, dy);
      if (nd < dist[j]) { dist[j] = nd; push(nd, j); }
    }
  }
  return dist;
}

// Weight field of one pin: 1/(d^2α + ε). Geodesic distances keep disconnected
// islands independent (a pin on one leg never drags the other — d = 1e6 there).
function weightField(mesh, x, y, geodesic, alpha) {
  const V = mesh.V;
  const w = new Float32Array(V);
  const dd = new Float32Array(V);
  if (geodesic) {
    const gd = geodesicDist(mesh, nearestVertex(mesh, x, y));
    for (let i = 0; i < V; i++) {
      const d = Number.isFinite(gd[i]) ? gd[i] : 1e6;
      dd[i] = d;
      w[i] = 1 / (Math.pow(d * d, alpha) + 1e-4);
    }
  } else {
    for (let i = 0; i < V; i++) {
      const dx = mesh.rest[i * 2] - x;
      const dy = mesh.rest[i * 2 + 1] - y;
      const d2 = dx * dx + dy * dy;
      dd[i] = Math.sqrt(d2);
      w[i] = 1 / (Math.pow(d2, alpha) + 1e-4);
    }
  }
  return { w, dd };
}

// Unit-box (±0.5, y down) → cell space (y up).
function pinToCell(pin, cols, rows) {
  const px = Number(pin.x) || 0;
  const py = Number(pin.y) || 0;
  return { x: (px + 0.5) * cols, y: (0.5 - py) * rows };
}

// ── Per-item deform state, cached like getAutofillField ────────────────────
//
// And baked like it too: the first step is reading the cropped isolate back,
// which cannot be synchronous on a WebGPU renderer, so a miss KICKS the bake and
// returns the item's previous state. The frame that asked paints with that (or,
// on the very first one, skips the warp — deformRig's own no-state path); the
// export settles the bake queue and repaints before capturing, so no render ever
// carries the stale mesh. See asyncBakes.js.

const rigCache = new Map();
const lastKeyByItem = new Map();  // itemKey -> the cacheKey it last served
const inFlight = new Map();       // itemKey -> Promise (at most one bake each)
let cacheSeq = 0;

function disposeEntry(entry) {
  entry.geo?.dispose?.();
}

function resolveRigParams(effect) {
  const stored = effect?.params || {};
  const out = {};
  for (const [key, def] of Object.entries(RIG_DEFAULTS)) {
    const v = Number(stored[key]);
    out[key] = Number.isFinite(v) ? v : def;
  }
  return out;
}

export function getRigDeformState(renderer, matteTexture, box, effect, itemKey, itemRef, maskStamp) {
  const params = resolveRigParams(effect);
  const pins = Array.isArray(effect?.pins) ? effect.pins : [];
  const chains = sanitizeRigChains(effect?.chains, pins);
  const { cols, rows } = rigGridFor(box, params.rigDensity);
  const pinsKey = pins
    .map((p) => `${p.pid},${p.type},${(Number(p.x) || 0).toFixed(4)},${(Number(p.y) || 0).toFixed(4)}`)
    .join(';');
  const chainsKey = chains
    .map((c) => `${c.joints.join('>')},${c.preserveTex ? 1 : 0},${c.fleshR}`)
    .join(';');
  const paramsKey = `${cols}x${rows}|${params.rigExpansion}|${params.rigWeights}|${params.rigStiffness}|${pinsKey}|${chainsKey}`;
  const item = itemKey || 'anon';
  const key = maskStamp ? `${item}|${maskStamp}` : item;
  const entry = rigCache.get(key);
  if (entry && entry.paramsKey === paramsKey && entry.itemRef === itemRef) {
    entry.lastUsed = cacheSeq++;
    lastKeyByItem.set(item, key);
    return entry;
  }
  // One bake in flight per item. An animated mask hands us a new key every
  // frame; without this the queue would take a full mesh build per frame and
  // never drain. Skipping is safe — the next frame asks again with whatever
  // state is current then, which is the one worth baking.
  if (!inFlight.has(item)) {
    kickRigBake(renderer, matteTexture, box, params, pins, chains, paramsKey, key, item, itemRef, cols, rows);
  }
  if (entry) return entry;
  const lastKey = lastKeyByItem.get(item);
  return (lastKey !== undefined && rigCache.get(lastKey)) || null;
}

function buildRigState(mask, params, pins, chains, cols, rows) {
  const mesh = buildRigMesh(mask, cols, rows, params.rigExpansion);
  const geodesic = Number(params.rigWeights) !== 1;
  const weights = [];
  const dists = [];
  const anchors = [];
  for (const pin of pins) {
    const c = pinToCell(pin, cols, rows);
    const f = weightField(mesh, c.x, c.y, geodesic, params.rigStiffness);
    weights.push(f.w);
    dists.push(f.dd);
    anchors.push(nearestVertex(mesh, c.x, c.y));
  }

  // Chain runtime: everything derived from the joints' REST pins, in cell
  // space. Samples every ~1.2 cells along each bone carry the segment's rigid
  // transform per frame (anti candy-wrap); preserve-tex masks bind the flesh
  // rigidly to its bone inside the flesh radius.
  const chainsRt = [];
  for (const chain of chains) {
    const idx = chain.joints.map((pid) => pins.findIndex((p) => p.pid === pid));
    if (idx.some((i) => i < 0)) continue;
    const restC = idx.map((i) => pinToCell(pins[i], cols, rows));
    const ang0C = [
      Math.atan2(restC[1].y - restC[0].y, restC[1].x - restC[0].x),
      Math.atan2(restC[2].y - restC[1].y, restC[2].x - restC[1].x),
    ];
    const samples = [];
    const sampleW = [];
    for (let s = 0; s < 2; s++) {
      const A = restC[s];
      const B = restC[s + 1];
      const len = Math.hypot(B.x - A.x, B.y - A.y);
      const n = Math.max(1, Math.round(len / 1.2) - 1);
      for (let k = 1; k <= n; k++) {
        const t = k / (n + 1);
        const x = A.x + (B.x - A.x) * t;
        const y = A.y + (B.y - A.y) * t;
        samples.push({ seg: s, rest: { x, y }, off: { x: x - A.x, y: y - A.y } });
        sampleW.push(weightField(mesh, x, y, geodesic, params.rigStiffness).w);
      }
    }
    let masks = null;
    if (chain.preserveTex) {
      const V = mesh.V;
      const R = (chain.fleshR / 100) * rows;
      const m0 = new Float32Array(V);
      const m1 = new Float32Array(V);
      const mH = new Float32Array(V);
      const Dr = dists[idx[0]];
      const Dm = dists[idx[1]];
      const De = dists[idx[2]];
      // Full rigidity across the inner 60% of the radius, smooth fade on the
      // rim — pure radial falloff never reaches 1 on thin limbs. The geodesic
      // gate (≈1.4 cells slack) keeps masks from leaking across gaps.
      const fall = (d) => { if (d >= R) return 0; const u = Math.min(1, (R - d) / (R * 0.4)); return u * u * (3 - 2 * u); };
      const gate = (dG, dE) => dG < dE * 1.8 + 1.4;
      const smooth01 = (u) => { const c = Math.max(0, Math.min(1, u)); return c * c * (3 - 2 * c); };
      const segDist = (vx, vy, A, B) => {
        const dx = B.x - A.x; const dy = B.y - A.y;
        const L2 = dx * dx + dy * dy || 1;
        const t = ((vx - A.x) * dx + (vy - A.y) * dy) / L2;
        const tc = Math.max(0, Math.min(1, t));
        return { t, d: Math.hypot(vx - (A.x + dx * tc), vy - (A.y + dy * tc)) };
      };
      for (let v = 0; v < V; v++) {
        const vx = mesh.rest[v * 2];
        const vy = mesh.rest[v * 2 + 1];
        const s0 = segDist(vx, vy, restC[0], restC[1]);
        const s1 = segDist(vx, vy, restC[1], restC[2]);
        // Upper bone fades in past the root so torso flesh stays soft.
        if (gate(Math.min(Dr[v], Dm[v]), s0.d)) m0[v] = fall(s0.d) * smooth01((s0.t + 0.15) / 0.17);
        if (gate(Math.min(Dm[v], De[v]), s1.d)) m1[v] = fall(s1.d);
        const dH = Math.hypot(vx - restC[2].x, vy - restC[2].y);
        if (gate(De[v], dH)) mH[v] = fall(dH); // hand disc — forearm + end ring
      }
      masks = { m0, m1, mH };
    }
    chainsRt.push({ chain, idx, restC, ang0C, samples, sampleW, masks });
  }

  // THREE geometry: static aRest (q-space, ±1 y-up like fxLocal), dynamic
  // position updated by deformRig every frame.
  const geo = new THREE.BufferGeometry();
  const restQ = new Float32Array(mesh.V * 2);
  for (let i = 0; i < mesh.V; i++) {
    restQ[i * 2] = (mesh.rest[i * 2] / cols) * 2 - 1;
    restQ[i * 2 + 1] = (mesh.rest[i * 2 + 1] / rows) * 2 - 1;
  }
  const pos = new Float32Array(mesh.V * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRest', new THREE.BufferAttribute(restQ, 2));
  geo.setIndex(new THREE.BufferAttribute(mesh.tris, 1));

  return { mesh, weights, dists, anchors, chainsRt, geo };
}

function kickRigBake(renderer, matteTexture, box, params, pins, chains, paramsKey, key, item, itemRef, cols, rows) {
  // The snapshot is taken NOW, from the isolate the caller is holding;
  // everything after this point runs off a copy nothing else can touch.
  const gw = cols * SUB;
  const gh = rows * SUB;
  let target;
  try {
    target = cropMatte(renderer, matteTexture, box, gw, gh);
  } catch (err) {
    console.warn('[rig] isolate snapshot failed: ' + (err?.message || err));
    return;
  }
  const generation = cropRuntimeGeneration;
  const run = readAlphaMask(renderer, target, gw, gh)
    .then(({ mask, hash }) => {
      if (generation !== cropRuntimeGeneration) return false;
      const prev = rigCache.get(key);
      if (prev && prev.paramsKey === paramsKey && prev.maskHash === hash) {
        // The item object was replaced (autosave) but nothing structural
        // changed. Adopt the new identity so the cheap gate hits again — no
        // rebuild and nothing to repaint.
        prev.itemRef = itemRef;
        prev.lastUsed = cacheSeq++;
        lastKeyByItem.set(item, key);
        return false;
      }
      const built = buildRigState(mask, params, pins, chains, cols, rows);
      if (prev) disposeEntry(prev);
      if (!rigCache.has(key) && rigCache.size >= MAX_CACHED) {
        let oldest = null;
        let oldestUsed = Infinity;
        for (const [k, e] of rigCache) {
          if (e.lastUsed < oldestUsed) { oldestUsed = e.lastUsed; oldest = k; }
        }
        if (oldest) {
          disposeEntry(rigCache.get(oldest));
          rigCache.delete(oldest);
        }
      }
      rigCache.set(key, { paramsKey, itemRef, maskHash: hash, ...built, lastUsed: cacheSeq++ });
      lastKeyByItem.set(item, key);
      return true;
    })
    .catch(() => false) // reported by the settle registry
    .then((changed) => {
      releaseCropTarget(target, generation);
      if (inFlight.get(item) === run) inFlight.delete(item);
      return changed;
    });
  inFlight.set(item, run);
  trackBake(run, 'rig');
}

export function releaseRigDeformState(cacheKey) {
  const entry = rigCache.get(cacheKey);
  if (entry) {
    disposeEntry(entry);
    rigCache.delete(cacheKey);
  }
}

// ── Per-frame deform: rigid MLS + satellites + starch post-pass ─────────────

// Posed joint position in cell space: rest + track offsets (unit y-down → cell
// y-up flips the y offset).
function posedCell(state, poses, i) {
  const { cols, rows } = state.mesh;
  const rp = pinToCell(poses[i].pin, cols, rows);
  return { x: rp.x + poses[i].dx * cols, y: rp.y - poses[i].dy * rows };
}

// How much pin i's bone segment has rotated rest → pose, in cell space —
// Advanced joints of a limb inherit this, so a hand ring rides its forearm.
function chainSegRotCell(state, poses, i) {
  for (const rt of state.chainsRt || []) {
    const pos = rt.idx.indexOf(i);
    if (pos < 0) continue;
    const seg = pos <= 0 ? 0 : pos - 1;
    const A = posedCell(state, poses, rt.idx[seg]);
    const B = posedCell(state, poses, rt.idx[seg + 1]);
    return Math.atan2(B.y - A.y, B.x - A.x) - rt.ang0C[seg];
  }
  return 0;
}

function buildControls(state, poses) {
  const { mesh, weights } = state;
  const { cols, rows } = mesh;
  const ctrls = [];
  for (let i = 0; i < poses.length; i++) {
    const { pin, dx, dy, rot, scl } = poses[i];
    if (pin.type === 'starch' || !weights[i]) continue;
    const rp = pinToCell(pin, cols, rows);
    // Offsets are unit-box (y down) → cell space flips y.
    const qx = rp.x + dx * cols;
    const qy = rp.y - dy * rows;
    if (pin.type === 'position') {
      ctrls.push({ w: weights[i], px: rp.x, py: rp.y, qx, qy });
      continue;
    }
    // Advanced rotates/scales about its (movable) posed point; Bend about its
    // held rest point. Cell space is y-up, so a positive (CW on screen, y-down)
    // rotation flips sign here. Advanced joints of a limb add their bone's
    // rest→pose rotation, so the ring is an offset on top of the inherited one.
    const ax = pin.type === 'bend' ? rp.x : qx;
    const ay = pin.type === 'bend' ? rp.y : qy;
    const rotCell = -rot + (pin.type === 'advanced' ? chainSegRotCell(state, poses, i) : 0);
    const cs = Math.cos(rotCell) * scl;
    const sn = Math.sin(rotCell) * scl;
    ctrls.push({ w: weights[i], px: rp.x, py: rp.y, qx: ax, qy: ay });
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      const ox = Math.cos(a) * SAT_R;
      const oy = Math.sin(a) * SAT_R;
      ctrls.push({
        w: weights[i],
        px: rp.x + ox,
        py: rp.y + oy,
        qx: ax + cs * ox - sn * oy,
        qy: ay + sn * ox + cs * oy,
      });
    }
  }
  // Bone rigidity samples: interior controls along each limb segment carry the
  // segment's rigid transform, so the flesh moves as two solid pieces and
  // bends only at the elbow instead of candy-wrapping.
  for (const rt of state.chainsRt || []) {
    for (let k = 0; k < rt.samples.length; k++) {
      const s = rt.samples[k];
      const A = posedCell(state, poses, rt.idx[s.seg]);
      const B = posedCell(state, poses, rt.idx[s.seg + 1]);
      const th = Math.atan2(B.y - A.y, B.x - A.x) - rt.ang0C[s.seg];
      const c = Math.cos(th);
      const sn = Math.sin(th);
      ctrls.push({
        w: rt.sampleW[k],
        px: s.rest.x,
        py: s.rest.y,
        qx: A.x + c * s.off.x - sn * s.off.y,
        qy: A.y + sn * s.off.x + c * s.off.y,
      });
    }
  }
  return ctrls;
}

// Rigid MLS solved at one weight sample (a vertex index).
function rigidAt(ctrls, vs) {
  let sw = 0; let psx = 0; let psy = 0; let qsx = 0; let qsy = 0;
  for (const c of ctrls) {
    const w = c.w[vs];
    sw += w;
    psx += w * c.px; psy += w * c.py; qsx += w * c.qx; qsy += w * c.qy;
  }
  const pcx = psx / sw; const pcy = psy / sw; const qcx = qsx / sw; const qcy = qsy / sw;
  let zr = 0; let zi = 0;
  for (const c of ctrls) {
    const w = c.w[vs];
    const ax = c.px - pcx; const ay = c.py - pcy;
    const bx = c.qx - qcx; const by = c.qy - qcy;
    zr += w * (ax * bx + ay * by);
    zi += w * (ax * by - ay * bx);
  }
  const len = Math.hypot(zr, zi) || 1;
  return { rr: zr / len, ri: zi / len, pcx, pcy, qcx, qcy };
}

// Deform the mesh for this frame's poses and write q-space positions into the
// geometry. Returns false when there is nothing to draw.
export function deformRig(state, poses) {
  const { mesh, geo } = state;
  const { cols, rows, V, rest } = mesh;
  if (!V) return false;
  const ctrls = buildControls(state, poses);
  const posAttr = geo.getAttribute('position');
  const out = posAttr.array;
  if (!ctrls.length) {
    for (let v = 0; v < V; v++) {
      out[v * 3] = (rest[v * 2] / cols) * 2 - 1;
      out[v * 3 + 1] = (rest[v * 2 + 1] / rows) * 2 - 1;
      out[v * 3 + 2] = 0;
    }
    posAttr.needsUpdate = true;
    return true;
  }
  // Scratch cell-space output for the starch pass.
  let cellOut = state.cellOut;
  if (!cellOut || cellOut.length !== V * 2) {
    cellOut = new Float32Array(V * 2);
    state.cellOut = cellOut;
  }
  const nc = ctrls.length;
  for (let v = 0; v < V; v++) {
    let sw = 0; let psx = 0; let psy = 0; let qsx = 0; let qsy = 0;
    for (let c = 0; c < nc; c++) {
      const k = ctrls[c];
      const w = k.w[v];
      sw += w;
      psx += w * k.px; psy += w * k.py; qsx += w * k.qx; qsy += w * k.qy;
    }
    const pcx = psx / sw; const pcy = psy / sw;
    const qcx = qsx / sw; const qcy = qsy / sw;
    let zr = 0; let zi = 0;
    for (let c = 0; c < nc; c++) {
      const k = ctrls[c];
      const w = k.w[v];
      const ax = k.px - pcx; const ay = k.py - pcy;
      const bx = k.qx - qcx; const by = k.qy - qcy;
      zr += w * (ax * bx + ay * by);
      zi += w * (ax * by - ay * bx);
    }
    const len = Math.hypot(zr, zi);
    const dx = rest[v * 2] - pcx;
    const dy = rest[v * 2 + 1] - pcy;
    if (len < 1e-9) {
      cellOut[v * 2] = dx + qcx;
      cellOut[v * 2 + 1] = dy + qcy;
    } else {
      const rr = zr / len; const ri = zi / len;
      cellOut[v * 2] = rr * dx - ri * dy + qcx;
      cellOut[v * 2 + 1] = ri * dx + rr * dy + qcy;
    }
  }
  // Starch post-pass: inside Extent, blend toward the locally rigid transform —
  // full stiffness through the Hardness plateau, smoothstep to 0 at the edge.
  for (let s = 0; s < poses.length; s++) {
    const { pin, amount } = poses[s];
    if (pin.type !== 'starch' || amount <= 0 || !state.dists[s]) continue;
    const T = rigidAt(ctrls, state.anchors[s]);
    const D = state.dists[s];
    const ext = ((pin.extent ?? 16) / 100) * rows; // % of box height → cells
    const hard = (Math.min(95, Math.max(0, pin.hardness ?? 50)) / 100) * ext;
    const ring = Math.max(ext - hard, 1e-4);
    for (let v = 0; v < V; v++) {
      const d = D[v];
      if (d >= ext) continue;
      let u = d <= hard ? 1 : 1 - (d - hard) / ring;
      u = u * u * (3 - 2 * u);
      const m = amount * u;
      if (m < 0.004) continue;
      const dx = rest[v * 2] - T.pcx;
      const dy = rest[v * 2 + 1] - T.pcy;
      const tx = T.rr * dx - T.ri * dy + T.qcx;
      const ty = T.ri * dx + T.rr * dy + T.qcy;
      cellOut[v * 2] += (tx - cellOut[v * 2]) * m;
      cellOut[v * 2 + 1] += (ty - cellOut[v * 2 + 1]) * m;
    }
  }
  // Preserve-texture pass: inside the flesh radius each vertex binds RIGIDLY to
  // its bone (rotation measured REST → pose about the joint), replacing the
  // soft MLS blend that smears texture on strong poses. The hand disc adds the
  // end ring's rotation/scale so the wrist stays functional.
  for (const rt of state.chainsRt || []) {
    if (!rt.masks) continue;
    const [ri, mi, ei] = rt.idx;
    const r0 = rt.restC[0];
    const m0c = rt.restC[1];
    const e0 = rt.restC[2];
    const rp = posedCell(state, poses, ri);
    const mp = posedCell(state, poses, mi);
    const ep = posedCell(state, poses, ei);
    const th0 = Math.atan2(mp.y - rp.y, mp.x - rp.x) - Math.atan2(m0c.y - r0.y, m0c.x - r0.x);
    const th1 = Math.atan2(ep.y - mp.y, ep.x - mp.x) - Math.atan2(e0.y - m0c.y, e0.x - m0c.x);
    const endRotCell = -(poses[ei]?.rot || 0); // ring rot is screen y-down → cell y-up
    const endScl = poses[ei]?.scl || 1;
    const T3 = [
      { c: Math.cos(th0), s: Math.sin(th0), ox: r0.x, oy: r0.y, tx: rp.x, ty: rp.y, w: rt.masks.m0 },
      { c: Math.cos(th1), s: Math.sin(th1), ox: m0c.x, oy: m0c.y, tx: mp.x, ty: mp.y, w: rt.masks.m1 },
      { c: Math.cos(th1 + endRotCell) * endScl, s: Math.sin(th1 + endRotCell) * endScl,
        ox: e0.x, oy: e0.y, tx: ep.x, ty: ep.y, w: rt.masks.mH },
    ];
    for (let v = 0; v < V; v++) {
      let tot = 0;
      let px = 0;
      let py = 0;
      for (let k = 0; k < 3; k++) {
        const w = T3[k].w[v];
        if (!w) continue;
        tot += w;
        const dx = rest[v * 2] - T3[k].ox;
        const dy = rest[v * 2 + 1] - T3[k].oy;
        px += w * (T3[k].c * dx - T3[k].s * dy + T3[k].tx);
        py += w * (T3[k].s * dx + T3[k].c * dy + T3[k].ty);
      }
      if (tot < 0.004) continue;
      const f = Math.min(1, tot);
      px /= tot;
      py /= tot;
      cellOut[v * 2] += (px - cellOut[v * 2]) * f;
      cellOut[v * 2 + 1] += (py - cellOut[v * 2 + 1]) * f;
    }
  }
  for (let v = 0; v < V; v++) {
    out[v * 3] = (cellOut[v * 2] / cols) * 2 - 1;
    out[v * 3 + 1] = (cellOut[v * 2 + 1] / rows) * 2 - 1;
    out[v * 3 + 2] = 0;
  }
  posAttr.needsUpdate = true;
  return true;
}

// ── Warp + copy materials ───────────────────────────────────────────────────
// The warp draws the deformed grid over the plate: vertices sit at the DEFORMED
// box point, fragments sample the isolate at the REST box point — both through
// the same computeLayerBox affine, so the pass composes with layer transform,
// parenting and the project camera for free.

export function createRigWarpMaterial() {
  return makeMaterial.rigWarp() ?? new THREE.ShaderMaterial({
    uniforms: {
      uTexture: { value: null },
      uFxOrigin: { value: new THREE.Vector2(0.5, 0.5) },
      uFxAxisX: { value: new THREE.Vector2(0.5, 0) },
      uFxAxisY: { value: new THREE.Vector2(0, 0.5) },
    },
    vertexShader: `
attribute vec2 aRest;
uniform vec2 uFxOrigin, uFxAxisX, uFxAxisY;
varying vec2 vUv;
void main() {
  vUv = uFxOrigin + uFxAxisX * aRest.x + uFxAxisY * aRest.y;
  vec2 warped = uFxOrigin + uFxAxisX * position.x + uFxAxisY * position.y;
  gl_Position = vec4(warped * 2.0 - 1.0, 0.0, 1.0);
}
`,
    fragmentShader: `
precision highp float;
uniform sampler2D uTexture;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(uTexture, vUv);
}
`,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide, // folds flip triangle winding; both faces must draw
  });
}

// Straight premultiplied copy, used to write the warped plate back into rt.c so
// everything downstream (DOF, glow, chain matte, track matte) keeps reading the
// warped silhouette with zero changes.
export function createRigCopyMaterial() {
  return makeMaterial.rigCopy() ?? new THREE.ShaderMaterial({
    uniforms: { uTexture: { value: null } },
    vertexShader: `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
    fragmentShader: `
precision highp float;
uniform sampler2D uTexture;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(uTexture, vUv);
}
`,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}
