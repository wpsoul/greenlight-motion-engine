import * as THREE from 'three';

import { setFoldOnTop } from './bezierWarp';

/*
 * Mesh Warp — geometry layer effect (port of html/distort-lab.html effect 1, AE's
 * Mesh Warp).
 *
 * A Catmull-Rom surface over a control lattice: drag ONE vertex and only its
 * neighbourhood moves, so this is the general-purpose warp of the family — the one
 * to reach for when the shape you want is not an arc ([bendLayer.js]), a band
 * ([regionDistort.js]) or a plane ([cornerPinLayer.js]). Like Bend it is a FORWARD
 * map, so it displaces the vertices of a dense grid rather than resolving a source
 * per fragment; unlike Bend the grid is NOT overscanned, because the lattice covers
 * exactly the layer box and there is nothing meaningful to extrapolate outside it.
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
 * Why the lattice is a bank of plain numbered params (`mwP0X`, `mwP0Y`, …) rather than
 * a points array: plain numbers keyframe through the ordinary track machinery, which is
 * what lets a canvas drag KEY a vertex. A `points` array would need a `msk:`-style
 * dynamic track prefix first. The bank is a fixed MW_MAX² slots; only the first
 * cols·rows are live, and changing the grid RE-SEEDS them (buildMeshLattice) — which is
 * also why the panel drops the point tracks when the grid size changes.
 *
 * The channels are NOT in the static KF_PROPS registry — 50 rows would sit in every
 * layer's property dropdown forever. They are published per item by
 * buildMeshWarpKfProps() (the buildRigKfProps / buildLayerMaskKfProps pattern) and kept
 * alive across autosave by the meshWarp branch in sanitizePropertyKeyframes.
 */

export const MESH_WARP_LAYER_EFFECT_ID = 'meshWarp';

const GRID_SEGMENTS = 128;     // vertex-warp resolution

/* Lattice bank. MW_MAX² is also the `uPts` uniform-array length in the shader — a
   fixed size, because a GLSL array cannot be resized at runtime. */
export const MW_MAX = 5;
export const MW_SLOTS = MW_MAX * MW_MAX;
export const MW_GRID_OPTIONS = [2, 3, 4, 5];
const MW_DEFAULT_COLS = 4;
const MW_DEFAULT_ROWS = 4;

export const mwPointXKey = (index) => `mwP${index}X`;
export const mwPointYKey = (index) => `mwP${index}Y`;

/** Row/column of a slot in a cols×rows lattice (slots run left→right, top→bottom). */
export const mwSlotRC = (index, cols) => ({ row: Math.floor(index / cols), col: index % cols });

/**
 * Where slot `index` sits when the lattice is undeformed, in percent of the layer box.
 * Clamped so the unused tail of the bank (index ≥ cols·rows) still holds a sane
 * position instead of running off past 100%.
 */
export function mwRestPoint(index, cols, rows) {
  const c = Math.max(2, cols);
  const r = Math.max(2, rows);
  const { row, col } = mwSlotRC(index, c);
  return {
    x: Math.min(1, col / (c - 1)) * 100,
    y: Math.min(1, row / (r - 1)) * 100,
  };
}

/** A full param patch for a regular cols×rows lattice — every slot, live or not. */
export function buildMeshLattice(cols, rows) {
  const out = {};
  for (let i = 0; i < MW_SLOTS; i += 1) {
    const p = mwRestPoint(i, cols, rows);
    out[mwPointXKey(i)] = Math.round(p.x * 1000) / 1000;
    out[mwPointYKey(i)] = Math.round(p.y * 1000) / 1000;
  }
  return out;
}

export const MW_DEFAULTS = {
  mwCols: MW_DEFAULT_COLS,
  mwRows: MW_DEFAULT_ROWS,
  ...buildMeshLattice(MW_DEFAULT_COLS, MW_DEFAULT_ROWS),
};

export const MW_ENUM_FIELDS = [
  { key: 'mwCols', label: 'Columns', options: MW_GRID_OPTIONS.map((n) => [n, String(n)]) },
  { key: 'mwRows', label: 'Rows', options: MW_GRID_OPTIONS.map((n) => [n, String(n)]) },
];

/* One field per lattice channel. These never render as panel rows (a 5×5 lattice is 50
   of them); they exist so the sanitizer has ranges and the Keyframe Builder has meta. */
export const MW_POINT_FIELDS = (() => {
  const out = [];
  for (let i = 0; i < MW_SLOTS; i += 1) {
    out.push({ key: mwPointXKey(i), slot: i, axis: 'x', min: -100, max: 200, step: 0.5, suffix: '%', kf: true });
    out.push({ key: mwPointYKey(i), slot: i, axis: 'y', min: -100, max: 200, step: 0.5, suffix: '%', kf: true });
  }
  return out;
})();

export const MW_POINT_KEYS = new Set(MW_POINT_FIELDS.map((f) => f.key));

/** The live vertices of a lattice, as the on-canvas control and the shader see them. */
export function mwLivePoints(params) {
  const cols = mwClampGrid(params?.mwCols, MW_DEFAULT_COLS);
  const rows = mwClampGrid(params?.mwRows, MW_DEFAULT_ROWS);
  const out = [];
  for (let i = 0; i < cols * rows; i += 1) {
    const rest = mwRestPoint(i, cols, rows);
    const x = Number(params?.[mwPointXKey(i)]);
    const y = Number(params?.[mwPointYKey(i)]);
    const { row, col } = mwSlotRC(i, cols);
    out.push({
      index: i,
      row,
      col,
      xKey: mwPointXKey(i),
      yKey: mwPointYKey(i),
      x: Number.isFinite(x) ? x : rest.x,
      y: Number.isFinite(y) ? y : rest.y,
      restX: rest.x,
      restY: rest.y,
    });
  }
  return { cols, rows, points: out };
}

export function mwClampGrid(value, fallback) {
  const n = Math.round(Number(value));
  return MW_GRID_OPTIONS.includes(n) ? n : fallback;
}

/* Which channels this lattice actually uses. The panel keyframes exactly these, and the
   sanitizer keeps exactly these — a track on a slot the grid no longer reaches is an
   orphan, the rig-pin rule. */
export function mwActiveKeys(params) {
  const { points } = mwLivePoints(params);
  const out = [];
  for (const p of points) out.push(p.xKey, p.yKey);
  return out;
}

export function getMeshWarpEffect(item) {
  const list = Array.isArray(item?.layerEffects) ? item.layerEffects : [];
  return list.find((effect) => effect?.id === MESH_WARP_LAYER_EFFECT_ID) || null;
}

/* The Player's collector predicate AND the per-channel exact bypass. A lattice at rest is
   a true no-op, but a keyframed vertex can ramp away from rest, so a track on any live
   channel keeps the pass alive. */
export function isMeshWarpEnabled(item) {
  const effect = getMeshWarpEffect(item);
  if (!effect || effect.enabled === false) return false;
  const params = { ...MW_DEFAULTS, ...(effect.params || {}) };
  const tracks = item?.propertyKeyframes || {};
  const { points } = mwLivePoints(params);
  for (const p of points) {
    if (Math.abs(p.x - p.restX) > 0.05 || Math.abs(p.y - p.restY) > 0.05) return true;
    if (tracks[p.xKey]?.length > 0 || tracks[p.yKey]?.length > 0) return true;
  }
  return false;
}

export function resolveMeshWarpParams(item, keyframeProps) {
  const effect = getMeshWarpEffect(item);
  const stored = effect?.params || {};
  const out = {};
  for (const [key, fallback] of Object.entries(MW_DEFAULTS)) {
    const keyed = keyframeProps?.[key];
    const value = Number.isFinite(keyed) ? keyed : stored[key];
    out[key] = Number.isFinite(value) ? value : fallback;
  }
  out.mwCols = mwClampGrid(out.mwCols, MW_DEFAULT_COLS);
  out.mwRows = mwClampGrid(out.mwRows, MW_DEFAULT_ROWS);
  return out;
}

/**
 * KF_PROPS-shaped rows for the Keyframe Builder / graph editor, published only for a
 * layer that actually carries the effect (the buildRigKfProps pattern) and only for the
 * lattice's LIVE vertices.
 */
export function buildMeshWarpKfProps(item) {
  const effect = getMeshWarpEffect(item);
  if (!effect) return [];
  const { points } = mwLivePoints({ ...MW_DEFAULTS, ...(effect.params || {}) });
  const out = [];
  for (const p of points) {
    const name = `Mesh r${p.row + 1}c${p.col + 1}`;
    out.push({
      label: p.xKey, group: 'Effects', displayLabel: `${name} X`,
      placeholder: String(Math.round(p.restX)), unit: '%', type: 'number', min: -100, max: 200, step: 0.5,
    });
    out.push({
      label: p.yKey, group: 'Effects', displayLabel: `${name} Y`,
      placeholder: String(Math.round(p.restY)), unit: '%', type: 'number', min: -100, max: 200, step: 0.5,
    });
  }
  return out;
}

/* Ready-made lattices. Each writes the WHOLE bank plus the grid size, so a preset is one
   commit and never leaves half a lattice from the previous shape behind. */
function latticeFrom(cols, rows, shape) {
  const out = { mwCols: cols, mwRows: rows, ...buildMeshLattice(cols, rows) };
  for (let i = 0; i < cols * rows; i += 1) {
    const rest = mwRestPoint(i, cols, rows);
    const { row, col } = mwSlotRC(i, cols);
    const u = col / (cols - 1);
    const v = row / (rows - 1);
    const moved = shape(rest, u, v);
    out[mwPointXKey(i)] = Math.round(moved.x * 1000) / 1000;
    out[mwPointYKey(i)] = Math.round(moved.y * 1000) / 1000;
  }
  return out;
}

export const MW_PRESETS = [
  {
    name: 'Bulge',
    values: latticeFrom(4, 4, (rest, u, v) => {
      const k = Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * 18;
      return { x: rest.x + (u - 0.5) * 2 * k, y: rest.y + (v - 0.5) * 2 * k };
    }),
  },
  {
    name: 'Wave',
    values: latticeFrom(4, 4, (rest, u) => ({ x: rest.x, y: rest.y + Math.sin(u * Math.PI * 2) * 12 })),
  },
  {
    name: 'Twist',
    values: latticeFrom(4, 4, (rest, u, v) => {
      const a = (v - 0.5) * 0.7;
      const dx = (u - 0.5) * 100;
      const dy = (v - 0.5) * 100;
      return { x: 50 + dx * Math.cos(a) - dy * Math.sin(a), y: 50 + dx * Math.sin(a) + dy * Math.cos(a) };
    }),
  },
  { name: 'Reset mesh', values: { mwCols: 4, mwRows: 4, ...buildMeshLattice(4, 4) } },
];

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

/* The surface lives entirely in the vertex stage; the fragment samples at rest and trims
   the edge, so the two shaders share nothing but boxToFrame.

   `uPts` is indexed by a computed expression — legal for a uniform array in a VERTEX
   shader (the same rule skinning relies on) and the reason this warp cannot be a
   fragment pass. */
const VERTEX = /* glsl */`
  precision highp float;
  attribute vec2 aRest;      // rest position in box uv (y down), 0..1
  varying vec2 vRest;
  uniform vec2 uPts[${MW_SLOTS}];   // lattice, box uv (y down)
  uniform int uCols;
  uniform int uRows;
${COMMON}

  vec2 latPt(int i, int j) {
    int ci = i < 0 ? 0 : (i > uCols - 1 ? uCols - 1 : i);
    int cj = j < 0 ? 0 : (j > uRows - 1 ? uRows - 1 : j);
    return uPts[cj * uCols + ci];
  }

  vec2 cr(vec2 p0, vec2 p1, vec2 p2, vec2 p3, float t) {
    float t2 = t * t;
    float t3 = t2 * t;
    return 0.5 * ((2.0 * p1) + (-p0 + p2) * t
      + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
      + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3);
  }

  vec2 wMesh(vec2 b) {
    float fx = b.x * float(uCols - 1);
    float fy = b.y * float(uRows - 1);
    int ix = int(floor(fx));
    int iy = int(floor(fy));
    ix = ix < 0 ? 0 : (ix > uCols - 2 ? uCols - 2 : ix);
    iy = iy < 0 ? 0 : (iy > uRows - 2 ? uRows - 2 : iy);
    float tx = clamp(fx - float(ix), 0.0, 1.0);
    float ty = clamp(fy - float(iy), 0.0, 1.0);
    vec2 c0 = cr(latPt(ix - 1, iy - 1), latPt(ix, iy - 1), latPt(ix + 1, iy - 1), latPt(ix + 2, iy - 1), tx);
    vec2 c1 = cr(latPt(ix - 1, iy    ), latPt(ix, iy    ), latPt(ix + 1, iy    ), latPt(ix + 2, iy    ), tx);
    vec2 c2 = cr(latPt(ix - 1, iy + 1), latPt(ix, iy + 1), latPt(ix + 1, iy + 1), latPt(ix + 2, iy + 1), tx);
    vec2 c3 = cr(latPt(ix - 1, iy + 2), latPt(ix, iy + 2), latPt(ix + 1, iy + 2), latPt(ix + 2, iy + 2), tx);
    return cr(c0, c1, c2, c3, ty);
  }

  void main() {
    vRest = aRest;
    gl_Position = vec4(boxToFrame(wMesh(aRest)) * 2.0 - 1.0, 0.0, 1.0);
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

export function createMeshWarpPass() {
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

  // ONE uniform block, TWO materials — a vertex dragged past its neighbour folds the
  // lattice, and the fold has to draw on top wherever it happens rather than wherever
  // the row order puts it. Same rule and same helper as [bezierWarp.js].
  const uniforms = {
    uTexture: { value: null },
    uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
    uAxisX: { value: new THREE.Vector2(0.5, 0) },
    uAxisY: { value: new THREE.Vector2(0, 0.5) },
    uPts: { value: Array.from({ length: MW_SLOTS }, () => new THREE.Vector2(0, 0)) },
    uCols: { value: MW_DEFAULT_COLS },
    uRows: { value: MW_DEFAULT_ROWS },
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

export function applyMeshWarpUniforms(pass, p, box) {
  const u = pass.material.uniforms;
  u.uOrigin.value.set(box.origin[0], box.origin[1]);
  u.uAxisX.value.set(box.axisX[0], box.axisX[1]);
  u.uAxisY.value.set(box.axisY[0], box.axisY[1]);
  const { cols, rows, points } = mwLivePoints(p);
  u.uCols.value = cols;
  u.uRows.value = rows;
  const bank = u.uPts.value;
  for (let i = 0; i < MW_SLOTS; i += 1) {
    const pt = points[i];
    if (pt) bank[i].set(pt.x / 100, pt.y / 100);
    else bank[i].set(0, 0);
  }
  setFoldOnTop(pass, box);
}
