import * as THREE from 'three';

/*
 * Bezier Warp — geometry layer effect (port of html/distort-lab.html effect 2, AE's
 * Bezier Warp).
 *
 * Four cubic edges drive a Coons patch: the silhouette CURVES instead of kinking at a
 * vertex, which is the difference between this and [meshWarp.js] and the reason both
 * exist. A lattice bends the interior point by point; four beziers bend the OUTLINE and
 * let the interior follow. Like Mesh Warp and Bend it is a FORWARD map over a dense
 * grid, not overscanned — the patch is defined by its own boundary, so there is nothing
 * outside the box to extrapolate.
 *
 * Coordinate conventions (all three are load-bearing, and shared with the siblings):
 *  - Authored params are PERCENT OF THE LAYER BOX, +y DOWN, like every other % field in
 *    the editor. The stored field, the keyframe value and the panel number are the same
 *    number (the layerMask.js rule) — a unit mismatch teleports geometry the instant it
 *    is keyed.
 *  - The shader works in box uv `b` ∈ [0,1]², +y DOWN, so the lab's warp math ports
 *    verbatim with no sign flips to get wrong.
 *  - Sampling converts box uv → frame uv through the computeLayerBox affine, because the
 *    isolate is a FULL-FRAME target in which the layer occupies a sub-rect. Edge handling
 *    therefore happens in box units; texture wrap modes would wrap the whole frame.
 *
 * All twelve points are plain numbered params, so every one of them keyframes through
 * the ordinary track machinery — that is what lets the canvas control KEY a handle
 * instead of overwriting it.
 */

export const BEZIER_WARP_LAYER_EFFECT_ID = 'bezierWarp';

const GRID_SEGMENTS = 128;     // vertex-warp resolution

/*
 * The ring, in the order the Coons patch expects: corner, its two outgoing tangents,
 * next corner, … clockwise from upper left. The control overlay and the panel both
 * iterate this, so a handle and its row can never disagree about which point they edit.
 * `corner` marks the four anchors; `owner`/`side` say which anchor a tangent belongs to,
 * which is how the overlay draws its leash.
 */
export const BW_POINTS = [
  { id: 'ul', kind: 'corner', label: 'Upper Left', xKey: 'bwULX', yKey: 'bwULY', group: 'corners' },
  { id: 't1', kind: 'tangent', owner: 'ul', label: 'Top · from UL', xKey: 'bwT1X', yKey: 'bwT1Y', group: 'top' },
  { id: 't2', kind: 'tangent', owner: 'ur', label: 'Top · from UR', xKey: 'bwT2X', yKey: 'bwT2Y', group: 'top' },
  { id: 'ur', kind: 'corner', label: 'Upper Right', xKey: 'bwURX', yKey: 'bwURY', group: 'corners' },
  { id: 'r1', kind: 'tangent', owner: 'ur', label: 'Right · from UR', xKey: 'bwR1X', yKey: 'bwR1Y', group: 'right' },
  { id: 'r2', kind: 'tangent', owner: 'lr', label: 'Right · from LR', xKey: 'bwR2X', yKey: 'bwR2Y', group: 'right' },
  { id: 'lr', kind: 'corner', label: 'Lower Right', xKey: 'bwLRX', yKey: 'bwLRY', group: 'corners' },
  { id: 'b1', kind: 'tangent', owner: 'lr', label: 'Bottom · from LR', xKey: 'bwB1X', yKey: 'bwB1Y', group: 'bottom' },
  { id: 'b2', kind: 'tangent', owner: 'll', label: 'Bottom · from LL', xKey: 'bwB2X', yKey: 'bwB2Y', group: 'bottom' },
  { id: 'll', kind: 'corner', label: 'Lower Left', xKey: 'bwLLX', yKey: 'bwLLY', group: 'corners' },
  { id: 'l1', kind: 'tangent', owner: 'll', label: 'Left · from LL', xKey: 'bwL1X', yKey: 'bwL1Y', group: 'left' },
  { id: 'l2', kind: 'tangent', owner: 'ul', label: 'Left · from UL', xKey: 'bwL2X', yKey: 'bwL2Y', group: 'left' },
];

/* The four cubic edges, as index triples into BW_POINTS — the overlay draws exactly
   these and the shader evaluates exactly these. */
export const BW_EDGES = [
  { id: 'top', a: 0, c1: 1, c2: 2, d: 3 },
  { id: 'right', a: 3, c1: 4, c2: 5, d: 6 },
  { id: 'bottom', a: 6, c1: 7, c2: 8, d: 9 },
  { id: 'left', a: 9, c1: 10, c2: 11, d: 0 },
];

const T3 = 100 / 3;

/* The pose at which the warp is a no-op — a flat box with evenly spaced tangents.
   Anything asking "is this doing nothing" compares against this, not BW_DEFAULTS. */
export const BW_IDENTITY = {
  bwULX: 0, bwULY: 0,
  bwT1X: T3, bwT1Y: 0,
  bwT2X: T3 * 2, bwT2Y: 0,
  bwURX: 100, bwURY: 0,
  bwR1X: 100, bwR1Y: T3,
  bwR2X: 100, bwR2Y: T3 * 2,
  bwLRX: 100, bwLRY: 100,
  bwB1X: T3 * 2, bwB1Y: 100,
  bwB2X: T3, bwB2Y: 100,
  bwLLX: 0, bwLLY: 100,
  bwL1X: 0, bwL1Y: T3 * 2,
  bwL2X: 0, bwL2Y: T3,
};

/* A freshly added effect bends the layer into an arc, so it shows what it does instead
   of sitting on the identity looking broken (the Corner Pin precedent). Both edges bow
   by the same amount — bowing only the top mostly LIFTS that edge, which reads as a
   nudge rather than a warp. */
export const BW_DEFAULTS = {
  ...BW_IDENTITY,
  bwT1Y: -20,
  bwT2Y: -20,
  bwB1Y: 80,
  bwB2Y: 80,
};

export const BW_NUMBER_FIELDS = BW_POINTS.flatMap((p) => ([
  { key: p.xKey, label: `${p.label} X`, min: -100, max: 200, step: 0.5, suffix: '%', kf: true, group: p.group },
  { key: p.yKey, label: `${p.label} Y`, min: -100, max: 200, step: 0.5, suffix: '%', kf: true, group: p.group },
]));

export const BW_KF_KEYS = BW_NUMBER_FIELDS.filter((f) => f.kf).map((f) => f.key);

const bowed = (patch) => ({ ...BW_IDENTITY, ...patch });

export const BW_PRESETS = [
  { name: 'Arc', values: { ...BW_DEFAULTS } },
  { name: 'Arch top', values: bowed({ bwT1Y: -26, bwT2Y: -26 }) },
  { name: 'Flag', values: bowed({ bwT1Y: -14, bwT2Y: 14, bwB1Y: 86, bwB2Y: 114 }) },
  {
    name: 'Barrel',
    values: bowed({
      bwT1Y: -12, bwT2Y: -12, bwB1Y: 112, bwB2Y: 112,
      bwR1X: 112, bwR2X: 112, bwL1X: -12, bwL2X: -12,
    }),
  },
  {
    name: 'Pinch',
    values: bowed({
      bwT1Y: 12, bwT2Y: 12, bwB1Y: 88, bwB2Y: 88,
      bwR1X: 88, bwR2X: 88, bwL1X: 12, bwL2X: 12,
    }),
  },
  { name: 'Reset edges', values: { ...BW_IDENTITY } },
];

export function getBezierWarpEffect(item) {
  const list = Array.isArray(item?.layerEffects) ? item.layerEffects : [];
  return list.find((effect) => effect?.id === BEZIER_WARP_LAYER_EFFECT_ID) || null;
}

/* The Player's collector predicate AND the per-channel exact bypass. The flat ring is a
   true no-op, but a keyframed handle can ramp away from it, so a track on any channel
   keeps the pass alive. */
export function isBezierWarpEnabled(item) {
  const effect = getBezierWarpEffect(item);
  if (!effect || effect.enabled === false) return false;
  const p = effect.params || {};
  const num = (key) => (Number.isFinite(p[key]) ? p[key] : BW_DEFAULTS[key]);
  const tracks = item?.propertyKeyframes || {};
  for (const [key, rest] of Object.entries(BW_IDENTITY)) {
    if (Math.abs(num(key) - rest) > 0.05) return true;
    if (tracks[key]?.length > 0) return true;
  }
  return false;
}

export function resolveBezierWarpParams(item, keyframeProps) {
  const effect = getBezierWarpEffect(item);
  const stored = effect?.params || {};
  const out = {};
  for (const [key, fallback] of Object.entries(BW_DEFAULTS)) {
    const keyed = keyframeProps?.[key];
    const value = Number.isFinite(keyed) ? keyed : stored[key];
    out[key] = Number.isFinite(value) ? value : fallback;
  }
  return out;
}

/* ── shader ─────────────────────────────────────────────────────────────── */

const COMMON = /* glsl */`
  uniform vec2 uOrigin;      // frame uv of the box centre
  uniform vec2 uAxisX;       // half-axis of the box in frame uv (+x)
  uniform vec2 uAxisY;       // half-axis of the box in frame uv (+y UP)

  // box uv (y down) → frame uv, through the layer-box affine
  vec2 boxToFrame(vec2 b) {
    vec2 l = vec2(b.x * 2.0 - 1.0, 1.0 - b.y * 2.0);
    return uOrigin + uAxisX * l.x + uAxisY * l.y;
  }
`;

/* The patch lives in the vertex stage; the fragment samples at rest and trims the edge,
   so the two shaders share nothing but boxToFrame. */
const VERTEX = /* glsl */`
  precision highp float;
  attribute vec2 aRest;      // rest position in box uv (y down), 0..1
  varying vec2 vRest;
  uniform vec2 uPts[12];     // the ring, box uv (y down), in BW_POINTS order
${COMMON}

  vec2 bez(vec2 a, vec2 b, vec2 c, vec2 d, float t) {
    float m = 1.0 - t;
    return m * m * m * a + 3.0 * m * m * t * b + 3.0 * m * t * t * c + t * t * t * d;
  }

  // Coons patch: the two ruled surfaces minus the bilinear corner patch.
  vec2 wBezier(vec2 b) {
    vec2 UL = uPts[0], t1 = uPts[1], t2 = uPts[2], UR = uPts[3];
    vec2 r1 = uPts[4], r2 = uPts[5], LR = uPts[6], b1 = uPts[7];
    vec2 b2 = uPts[8], LL = uPts[9], l1 = uPts[10], l2 = uPts[11];
    float u = b.x, v = b.y;
    vec2 top = bez(UL, t1, t2, UR, u);
    vec2 bot = bez(LL, b2, b1, LR, u);
    vec2 lft = bez(UL, l2, l1, LL, v);
    vec2 rgt = bez(UR, r1, r2, LR, v);
    vec2 ruled = mix(top, bot, v) + mix(lft, rgt, u);
    vec2 corner = mix(mix(UL, UR, u), mix(LL, LR, u), v);
    return ruled - corner;
  }

  void main() {
    vRest = aRest;
    gl_Position = vec4(boxToFrame(wBezier(aRest)) * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const FRAGMENT = /* glsl */`
  precision highp float;
  uniform sampler2D uTexture;
  varying vec2 vRest;
${COMMON}
  void main() {
    // Edge handling in BOX units — the isolate is frame sized, so a texture wrap mode
    // here would wrap the whole frame instead of the layer.
    vec2 w = fwidth(vRest) + 1e-5;
    vec2 m = smoothstep(vec2(0.0), w, vRest) * (1.0 - smoothstep(vec2(1.0) - w, vec2(1.0), vRest));
    float mask = m.x * m.y;
    if (mask <= 0.0) discard;

    gl_FragColor = texture2D(uTexture, boxToFrame(clamp(vRest, 0.0, 1.0))) * mask;
  }
`;

export function createBezierWarpPass() {
  const geometry = new THREE.BufferGeometry();
  const seg = GRID_SEGMENTS;
  const verts = (seg + 1) * (seg + 1);
  const position = new Float32Array(verts * 3);
  const rest = new Float32Array(verts * 2);
  for (let j = 0; j <= seg; j += 1) {
    for (let i = 0; i <= seg; i += 1) {
      const k = j * (seg + 1) + i;
      rest[k * 2] = i / seg;
      rest[k * 2 + 1] = j / seg;
    }
  }
  const index = new Uint32Array(seg * seg * 6);
  let t = 0;
  for (let j = 0; j < seg; j += 1) {
    for (let i = 0; i < seg; i += 1) {
      const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
      index[t++] = a; index[t++] = c; index[t++] = b;
      index[t++] = b; index[t++] = c; index[t++] = d;
    }
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aRest', new THREE.BufferAttribute(rest, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));

  // ONE uniform block, TWO materials. A patch pushed past itself folds, and where it
  // folds the surface is inside out — mirrored winding. Drawn as a single DoubleSide
  // mesh the overlap is settled by nothing but index order (row by row), so the fold
  // covered the artwork at the bottom of the layer and hid under it at the top: the
  // same gesture read differently at opposite ends of the same shape. Splitting the
  // draw by facing makes the rule explicit — see applyBezierWarpUniforms.
  const uniforms = {
    uTexture: { value: null },
    uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
    uAxisX: { value: new THREE.Vector2(0.5, 0) },
    uAxisY: { value: new THREE.Vector2(0, 0.5) },
    uPts: { value: BW_POINTS.map((p) => new THREE.Vector2(BW_IDENTITY[p.xKey] / 100, BW_IDENTITY[p.yKey] / 100)) },
  };
  const makeMaterial = (side) => new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side,
    extensions: { derivatives: true },
    blending: THREE.CustomBlending,  // the isolate is premultiplied
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms,                        // shared, so one apply drives both passes
  });
  const material = makeMaterial(THREE.FrontSide);
  const backMaterial = makeMaterial(THREE.BackSide);

  const front = new THREE.Mesh(geometry, material);
  const back = new THREE.Mesh(geometry, backMaterial);
  front.frustumCulled = false;
  back.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(front, back);
  return { scene, front, back, geometry, material, backMaterial };
}

export function applyBezierWarpUniforms(pass, p, box) {
  const u = pass.material.uniforms;
  u.uOrigin.value.set(box.origin[0], box.origin[1]);
  u.uAxisX.value.set(box.axisX[0], box.axisX[1]);
  u.uAxisY.value.set(box.axisY[0], box.axisY[1]);
  const bank = u.uPts.value;
  BW_POINTS.forEach((pt, i) => {
    const x = Number.isFinite(p[pt.xKey]) ? p[pt.xKey] : BW_IDENTITY[pt.xKey];
    const y = Number.isFinite(p[pt.yKey]) ? p[pt.yKey] : BW_IDENTITY[pt.yKey];
    bank[i].set(x / 100, y / 100);
  });
  setFoldOnTop(pass, box);
}

/**
 * The folded part of the patch draws LAST, so it lies on top of the artwork it folded
 * over — at every corner, not just the ones the grid happens to reach late.
 *
 * Which facing is "folded" depends on the layer, not on the warp: an unmirrored box
 * winds counter-clockwise, so its folds are back-facing, and a mirrored one is the
 * other way round. The box's own handedness (the sign of axisX × axisY) is the whole
 * test. Exported because Mesh Warp folds for exactly the same reason.
 */
export function setFoldOnTop(pass, box) {
  const handed = box.axisX[0] * box.axisY[1] - box.axisX[1] * box.axisY[0];
  const foldIsBack = handed >= 0;
  pass.front.renderOrder = foldIsBack ? 0 : 1;
  pass.back.renderOrder = foldIsBack ? 1 : 0;
}
