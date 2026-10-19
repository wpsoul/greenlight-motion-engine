// Repetile — a per-LAYER typed effect (item.layerEffects, like Motion Blur).
// AE's CC RepeTile plus the per-tile motion design AE has no answer for.
//
// Every tile is ONE INSTANCED QUAD with its own centre, size, rotation, uv flip,
// opacity and tint. A single inverse-mapped fract() shader — the obvious way to
// build a tiler — can only reproduce the "clip to cell" subset: the moment tiles
// overlap (scale > 100%, rotation, jitter, wave, a staggered reveal) a fragment
// belongs to more than one tile and there is nothing to inverse-map. So the field
// is drawn, not sampled. Prototyped in html/repetile-lab.html, which is the look
// reference for every constant in here.
//
// The field is laid out in the layer's OWN box space (box-local pixels), so a
// rotated or scaled layer tiles along its own axes exactly like AE's layer space.
// The tiles sample the layer's box out of the full-frame isolate, which is why no
// padding machinery is needed: the isolate is already frame-sized, and the field
// simply covers more of it.
//
// Runs AFTER the overlay chain and Running Glow, BEFORE motion blur and track
// matte — each tile therefore carries the layer's FINISHED look (its glow, its
// defocus, its chain), which is both what people expect and one styling pass
// instead of one per tile. See the call site in Player.jsx.

import * as THREE from 'three';
import { materials as makeMaterial } from './materialFactory.js';

export const REPETILE_LAYER_EFFECT_ID = 'repetile';

// Stored in item.layerEffects as one { id, eid, enabled, params } entry. The
// `rep` prefix routes panel writes into that entry (see LayerEffectsSection).
export const REP_DEFAULTS = {
  // grid — the four Expand counts are keyframable and read FRACTIONALLY (see
  // buildRepetileField): 2.4 is two full rings plus a third at 40% presence.
  repLeft: 2,
  repRight: 2,
  repUp: 1,
  repDown: 1,
  repSpacingX: 100,     // % of the layer box — 100 = tiles touch
  repSpacingY: 100,
  repMode: 0,           // tiling mode (see REP_ENUM_FIELDS)
  repBrick: 50,         // % — brick modes' row/column offset
  // The layout modes (Radial / Wave / Spiral / Random) place the SAME tile set on
  // a different figure, so these three only read there.
  repLayoutSpread: 100, // % — ring/spiral radius, wave amplitude, scatter extent
  repLayoutTurns: 2.5,  // spiral turns · wave cycles across the field · ring spin
  repLayoutOrient: 0,   // 1 = each tile turns to face along the figure
  repEdgeMode: 2,       // how a tile samples past its own box (repeat/mirror/clamp/transparent)
  repBlendBorders: 0,   // % of the tile — feathered overlap that cross-fades seams
  repClipCell: 0,       // 1 = each tile is clipped to its cell (true CC RepeTile)
  repBounds: 1,         // 1 = tile the layer's CONTENT, 0 = its full plate
  // per-tile transform
  repOrder: 0,          // which index drives the stagger
  repScale: 100,        // %
  repScaleFall: 0,      // % across the field
  repScaleRnd: 0,       // %
  repRotate: 0,         // °
  repRotateStep: 0,     // ° per tile — the "stagger rotation" knob
  repRotateRnd: 0,      // °
  repOpacityFall: 0,    // % across the field
  repOpacityRnd: 0,     // %
  repJitterX: 0,        // % of a cell
  repJitterY: 0,
  repSeed: 7,
  // colour
  repTint: '#ff7a3d',
  repTintAmount: 0,     // %
  repTintMode: 0,       // by order / random / alternate
  repBlendMode: 0,      // normal / add / screen
  repStack: 0,          // draw order
  // motion
  repDelay: 0,          // frames @30 — the tail of the stagger order's playback lag
  repScrollX: 0,        // px/s @1080
  repScrollY: 0,
  repWaveAmp: 0,        // px @1080 (or ° / % depending on the axis)
  repWaveAxis: 0,
  repWaveLength: 60,    // % — cycles per tile index
  repWaveSpeed: 100,    // % — 100 = one cycle/s
  // staggered reveal
  repReveal: 100,       // % — the keyframable master of the whole entrance
  repRevealType: 0,     // the entrance pose: fade / pop / rise / spin / from centre
  // 1 = the original tile reveals with the copies (Reveal 0 hides the layer too),
  // 0 = the entrance is the COPIES' only, and the layer itself never leaves.
  repRevealOriginal: 1,
  repSpread: 60,        // % — how far apart the per-tile delays sit
  repFromScale: 100,    // % — the scale a tile starts from
  repFromRotate: 0,     // °
  repFromOffset: 0,     // px @1080, on Y
  repEase: 0,
  repAmount: 100,       // % — master mix (keyframable)
};

export const REP_NUMBER_FIELDS = [
  // Whole numbers in the panel (step 1), fractional between keyframes — the grid
  // grows ring by ring instead of a tile count stepping.
  { key: 'repLeft', label: 'Expand Left', min: 0, max: 20, step: 1, kf: true, group: 'grid' },
  { key: 'repRight', label: 'Expand Right', min: 0, max: 20, step: 1, kf: true, group: 'grid' },
  { key: 'repUp', label: 'Expand Up', min: 0, max: 20, step: 1, kf: true, group: 'grid' },
  { key: 'repDown', label: 'Expand Down', min: 0, max: 20, step: 1, kf: true, group: 'grid' },
  { key: 'repSpacingX', label: 'Spacing X', min: 5, max: 1000, step: 1, suffix: '%', kf: true, group: 'grid' },
  { key: 'repSpacingY', label: 'Spacing Y', min: 5, max: 1000, step: 1, suffix: '%', kf: true, group: 'grid' },
  { key: 'repBrick', label: 'Brick Offset', min: 0, max: 100, step: 1, suffix: '%', brickOnly: true, kf: true, group: 'grid' },
  { key: 'repLayoutSpread', label: 'Layout Spread', min: 0, max: 400, step: 1, suffix: '%', layoutOnly: true, kf: true, group: 'grid' },
  { key: 'repLayoutTurns', label: 'Turns / Cycles', min: -12, max: 12, step: 0.25, layoutOnly: true, kf: true, group: 'grid' },
  { key: 'repBlendBorders', label: 'Blend Borders', min: 0, max: 60, step: 1, suffix: '%', kf: true, group: 'grid' },
  { key: 'repScale', label: 'Tile Scale', min: 1, max: 800, step: 1, suffix: '%', kf: true, group: 'tile' },
  { key: 'repScaleFall', label: 'Scale Falloff', min: -200, max: 500, step: 1, suffix: '%', kf: true, group: 'tile' },
  { key: 'repScaleRnd', label: 'Scale Random', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'tile' },
  { key: 'repRotate', label: 'Rotate', min: -180, max: 180, step: 1, suffix: '°', kf: true, group: 'tile' },
  { key: 'repRotateStep', label: 'Rotate Stagger', min: -90, max: 90, step: 0.5, suffix: '°', kf: true, group: 'tile' },
  { key: 'repRotateRnd', label: 'Rotate Random', min: 0, max: 180, step: 1, suffix: '°', kf: true, group: 'tile' },
  { key: 'repOpacityFall', label: 'Opacity Falloff', min: -100, max: 100, step: 1, suffix: '%', kf: true, group: 'tile' },
  { key: 'repOpacityRnd', label: 'Opacity Random', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'tile' },
  { key: 'repJitterX', label: 'Jitter X', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'tile' },
  { key: 'repJitterY', label: 'Jitter Y', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'tile' },
  { key: 'repSeed', label: 'Random Seed', min: 1, max: 99, step: 1, group: 'tile' },
  { key: 'repTintAmount', label: 'Tint Amount', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'colour' },
  // NOT keyframable, for the same reason Wave Speed is not: it is a lookup into a
  // ring of recorded frames, so a moving value would jump between slots rather
  // than accelerate.
  { key: 'repDelay', label: 'Play Delay', min: 0, max: 60, step: 1, suffix: 'f', group: 'motion' },
  { key: 'repScrollX', label: 'Scroll X', min: -400, max: 400, step: 1, suffix: 'px/s', kf: true, group: 'motion' },
  { key: 'repScrollY', label: 'Scroll Y', min: -400, max: 400, step: 1, suffix: 'px/s', kf: true, group: 'motion' },
  { key: 'repWaveAmp', label: 'Wave Amount', min: 0, max: 300, step: 1, kf: true, group: 'motion' },
  { key: 'repWaveLength', label: 'Wave Length', min: 5, max: 300, step: 1, suffix: '%', kf: true, group: 'motion' },
  { key: 'repWaveSpeed', label: 'Wave Speed', min: -400, max: 400, step: 5, suffix: '%', group: 'motion' },
  { key: 'repReveal', label: 'Reveal', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'reveal' },
  { key: 'repSpread', label: 'Stagger Spread', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'reveal' },
  { key: 'repFromScale', label: 'From Scale', min: 0, max: 200, step: 1, suffix: '%', kf: true, group: 'reveal' },
  { key: 'repFromRotate', label: 'From Rotate', min: -180, max: 180, step: 1, suffix: '°', kf: true, group: 'reveal' },
  { key: 'repFromOffset', label: 'From Offset Y', min: -400, max: 400, step: 1, suffix: 'px', kf: true, group: 'reveal' },
  { key: 'repAmount', label: 'Effect Amount', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'reveal' },
];

export const REP_ENUM_FIELDS = [
  {
    key: 'repMode',
    label: 'Tiling',
    group: 'grid',
    options: [
      [0, 'Repeat'],
      [1, 'Unfold (mirror both)'],
      [2, 'Mirror H'],
      [3, 'Mirror V'],
      [4, 'Brick H (row offset)'],
      [5, 'Brick V (column offset)'],
      [6, 'Brick + Mirror'],
      [7, 'Pinwheel (90° rotate)'],
      // 8+ are LAYOUTS: the same tile set, placed on a figure instead of a grid.
      // The original still sits at the centre, so the artwork never moves.
      [8, 'Radial (rings)'],
      [9, 'Wave'],
      [10, 'Spiral'],
      [11, 'Random (scatter)'],
    ],
  },
  {
    key: 'repLayoutOrient',
    label: 'Orient Tiles',
    group: 'grid',
    layoutOnly: true,
    // Radial/Spiral: face out from the centre. Wave: ride the crest's tangent.
    options: [[0, 'Off (upright)'], [1, 'Along the layout']],
  },
  {
    key: 'repEdgeMode',
    label: 'Edge Sampling',
    group: 'grid',
    // What a tile shows where it reaches past the layer's own box — only visible
    // once Blend Borders overlaps the tiles or Tile Scale pushes past the cell.
    options: [[0, 'Repeat'], [1, 'Mirror'], [2, 'Clamp'], [3, 'Transparent']],
  },
  {
    key: 'repClipCell',
    label: 'Clip to Cell',
    group: 'grid',
    // On = true CC RepeTile: a tile can never spill into its neighbour's cell.
    options: [[0, 'Off (tiles overlap)'], [1, 'On (hard cell edges)']],
  },
  {
    key: 'repBounds',
    label: 'Tile Bounds',
    group: 'grid',
    // A text or motion layer draws into a comp-sized plate, so its raw box is the
    // whole frame and tiling it gives one frame-sized tile. Content measures the
    // tight alpha bounds instead. No effect on opaque media, whose plate IS the
    // content — switch to Layer plate when you WANT the empty margin tiled too.
    options: [[1, 'Content (auto-tight)'], [0, 'Layer plate']],
  },
  {
    key: 'repOrder',
    label: 'Stagger Order',
    group: 'tile',
    options: [
      [0, 'Columns'], [1, 'Rows'], [2, 'Diagonal'],
      [3, 'Radial'], [4, 'Random'], [5, 'Columns (mirrored)'],
    ],
  },
  { key: 'repTintMode', label: 'Tint Spread', group: 'colour', options: [[0, 'By order'], [1, 'Random'], [2, 'Alternate']] },
  { key: 'repBlendMode', label: 'Tile Blend', group: 'colour', options: [[0, 'Normal'], [1, 'Add'], [2, 'Screen']] },
  { key: 'repStack', label: 'Stack Order', group: 'colour', options: [[0, 'Grid'], [1, 'By order'], [2, 'Reverse order'], [3, 'Random']] },
  { key: 'repWaveAxis', label: 'Wave Axis', group: 'motion', options: [[0, 'Y'], [1, 'X'], [2, 'Radial'], [3, 'Rotate'], [4, 'Scale']] },
  {
    key: 'repRevealType',
    label: 'Reveal Type',
    group: 'reveal',
    // The pose a tile arrives FROM. Fade is the historical behaviour (opacity
    // only); the rest add their own from-transform, which the From Scale /
    // Rotate / Offset fields then shape further.
    options: [[0, 'Fade'], [1, 'Pop'], [2, 'Rise'], [3, 'Spin'], [4, 'From Center']],
  },
  {
    key: 'repRevealOriginal',
    label: 'Include Original',
    group: 'reveal',
    // On: Reveal 0 hides the layer itself along with every copy — the whole thing
    // builds on from nothing. Off: the entrance belongs to the COPIES, and the
    // layer the user positioned stays put at full opacity the whole way through.
    options: [[1, 'On (hides at 0)'], [0, 'Off (copies only)']],
  },
  { key: 'repEase', label: 'Reveal Easing', group: 'reveal', options: [[0, 'Out Cubic'], [1, 'Out Back'], [2, 'Out Expo'], [3, 'In Out Cubic'], [4, 'Linear']] },
];

export const REP_COLOR_FIELDS = [
  { key: 'repTint', label: 'Tint', group: 'colour' },
];

// Keyframable params, registered in keyframeProps.js.
export const REP_KF_KEYS = REP_NUMBER_FIELDS.filter((f) => f.kf).map((f) => f.key);

// 41 × 41 — the cap the Expand fields already impose. Guards the buffer size.
export const REP_MAX_TILES = 41 * 41;

/* ------------------------------------------------------------- play delay */
// A tile can show the layer as it WAS, so a grid of a video plays as a canon
// rather than 25 synchronised copies. The pixels have to come from somewhere:
// like Motion Trail's Frame Echo this replays a RING OF PAST PLATES, and it
// inherits the same two limits. The delay is only as long as the ring, and a
// fresh seek has no history to read — those tiles show the live plate until it
// refills, which is why the effect belongs to playback and export rather than to
// scrubbing. Everything else about a tile is a pure function of time and is
// exact under any scrub; this one control is not.
export const REP_DELAY_RING = 16;       // recorded plates held per layer
// Half res, like Frame Echo's ring: a tile is a copy in a field of copies, and
// full-res slots would be 4× the VRAM for a difference nobody sees at tile size.
// Every tile reads the ring while the delay is on — including the undelayed ones
// — so the field is uniformly soft rather than sharp in patches.
export const REP_HISTORY_SCALE = 0.5;
export const REP_DELAY_MAX = 60;        // frames @30 — the lag of the order's tail
export const REP_FRAME_DT = 1 / 30;     // the nominal frame the delay counts in
// Floats per tile in the instance buffer — the stride the call site copies by
// when it draws the field one delay group at a time.
export const REP_FLOATS_PER_TILE = 16;

/**
 * Frames between ring slots. The ring is a fixed size, so a long delay is spanned
 * by recording every Nth frame instead of by more VRAM: the steps get coarser,
 * which is invisible at the delays a tile field is ever asked for.
 */
export function repetileDelayStride(p) {
  const frames = Math.max(0, Math.min(REP_DELAY_MAX, Number.isFinite(p?.repDelay) ? p.repDelay : 0));
  return Math.max(1, Math.ceil(frames / (REP_DELAY_RING - 1)));
}

export function getRepetileEffect(item) {
  const list = item?.layerEffects;
  if (!Array.isArray(list)) return null;
  return list.find((effect) => effect?.id === REPETILE_LAYER_EFFECT_ID) || null;
}

export function isRepetileEnabled(item) {
  const effect = getRepetileEffect(item);
  if (!effect || effect.enabled === false) return false;
  const amount = Number.isFinite(effect.params?.repAmount) ? effect.params.repAmount : REP_DEFAULTS.repAmount;
  // A static 0 is an exact bypass — but a keyframed amount can ramp up from it.
  if (amount > 0.01) return true;
  const track = item?.propertyKeyframes?.repAmount;
  return Array.isArray(track) && track.length > 0;
}

/** Effective params for a frame: keyframe track ?? stored param ?? default. */
export function resolveRepetileParams(item, keyframeProps) {
  const effect = getRepetileEffect(item);
  const params = effect?.params || {};
  const out = {};
  for (const [key, fallback] of Object.entries(REP_DEFAULTS)) {
    if (typeof fallback === 'string') {
      const raw = params[key];
      out[key] = typeof raw === 'string' && raw ? raw : fallback;
      continue;
    }
    const kf = keyframeProps?.[key];
    if (Number.isFinite(kf)) { out[key] = kf; continue; }
    const raw = params[key];
    out[key] = Number.isFinite(raw) ? raw : fallback;
  }
  return out;
}

/* ---------------------------------------------------------------- shaders */

const VERTEX = /* glsl */ `
precision highp float;
attribute vec2 aCenter;     // box-local px
attribute vec2 aHalf;       // box-local px, half extents of the drawn quad
attribute vec2 aRotAlpha;   // rotation (rad), opacity
attribute vec2 aUvScale;    // local-space scale * flip (±)
attribute vec4 aCell;       // cell centre + half extents, box-local px
attribute vec4 aTint;       // rgb + amount

uniform vec2 uOrigin;       // frame uv of the layer box centre
uniform vec2 uAxisX;        // frame uv half-axis of the box
uniform vec2 uAxisY;
uniform vec2 uHalfPx;       // box half size, px

varying vec2 vLocal;
varying vec2 vBoxPx;
varying float vAlpha;
varying vec4 vCell;
varying vec4 vTint;
varying vec2 vUvScale;

void main() {
  vec2 corner = position.xy;
  float c = cos(aRotAlpha.x);
  float s = sin(aRotAlpha.x);
  vec2 p = corner * aHalf;
  vec2 boxPx = aCenter + vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  // Box-local px → box units → frame uv. The two half-axes carry the layer's own
  // orientation, so the field tiles along the layer's axes, not the screen's.
  vec2 l = boxPx / uHalfPx;
  vec2 uv = uOrigin + uAxisX * l.x + uAxisY * l.y;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  vLocal = corner;
  vBoxPx = boxPx;
  vAlpha = aRotAlpha.y;
  vCell = aCell;
  vTint = aTint;
  vUvScale = aUvScale;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uOrigin;
uniform vec2 uAxisX;
uniform vec2 uAxisY;
uniform float uFeather;
uniform float uClipCell;
uniform float uEdgeMode;

varying vec2 vLocal;
varying vec2 vBoxPx;
varying float vAlpha;
varying vec4 vCell;
varying vec4 vTint;
varying vec2 vUvScale;

void main() {
  if (uClipCell > 0.5) {
    vec2 d = abs(vBoxPx - vCell.xy) - vCell.zw;
    if (d.x > 0.0 || d.y > 0.0) discard;
  }
  vec2 l = vLocal * vUvScale;
  // Edge handling happens in BOX units, not on the sampler: the box is a sub-rect
  // of a frame-sized isolate, so GL_REPEAT on the texture would wrap the frame.
  if (uEdgeMode < 0.5) {
    l = mod(l + 1.0, 2.0) - 1.0;
  } else if (uEdgeMode < 1.5) {
    vec2 t = mod(l + 1.0, 4.0) * 0.5;
    l = (1.0 - abs(t - 1.0)) * 2.0 - 1.0;
  } else if (uEdgeMode < 2.5) {
    l = clamp(l, -1.0, 1.0);
  } else if (abs(l.x) > 1.0 || abs(l.y) > 1.0) {
    discard;
  }
  vec2 uv = uOrigin + uAxisX * l.x + uAxisY * l.y;
  vec4 c = texture2D(uTexture, uv);
  if (uFeather > 0.001) {
    vec2 e = (1.0 - abs(vLocal)) / uFeather;
    c *= clamp(min(e.x, e.y), 0.0, 1.0);
  }
  if (vTint.a > 0.001 && c.a > 0.0009) {
    vec3 col = c.rgb / c.a;
    c.rgb = mix(col, vTint.rgb, vTint.a) * c.a;
  }
  gl_FragColor = c * vAlpha;
}
`;

const FLOATS_PER_TILE = REP_FLOATS_PER_TILE;

/**
 * One instanced quad per tile, drawn straight into frame-uv clip space (the
 * camera is bypassed — the box's own axes do the projection).
 */
export function createRepetilePass() {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = null;
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0, 1, -1, 0, -1, 1, 0,
    -1, 1, 0, 1, -1, 0, 1, 1, 0,
  ]), 3));
  const data = new Float32Array(REP_MAX_TILES * FLOATS_PER_TILE);
  const buffer = new THREE.InstancedInterleavedBuffer(data, FLOATS_PER_TILE, 1);
  buffer.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aCenter', new THREE.InterleavedBufferAttribute(buffer, 2, 0));
  geometry.setAttribute('aHalf', new THREE.InterleavedBufferAttribute(buffer, 2, 2));
  geometry.setAttribute('aRotAlpha', new THREE.InterleavedBufferAttribute(buffer, 2, 4));
  geometry.setAttribute('aUvScale', new THREE.InterleavedBufferAttribute(buffer, 2, 6));
  geometry.setAttribute('aCell', new THREE.InterleavedBufferAttribute(buffer, 4, 8));
  geometry.setAttribute('aTint', new THREE.InterleavedBufferAttribute(buffer, 4, 12));
  geometry.instanceCount = 0;

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: {
      uTexture: { value: null },
      uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
      uAxisX: { value: new THREE.Vector2(0.5, 0) },
      uAxisY: { value: new THREE.Vector2(0, 0.5) },
      uHalfPx: { value: new THREE.Vector2(100, 100) },
      uFeather: { value: 0 },
      uClipCell: { value: 0 },
      uEdgeMode: { value: 2 },
    },
  });

  const nodeMat = makeMaterial.repetile();
  const mesh = new THREE.Mesh(geometry, nodeMat ?? material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  // `material` is the pass's uniform surface AND what draws — hand back the
  // one the mesh actually uses, or every uniform write lands on the orphan.
  //
  // `scratch` is where the field is BUILT; `data` is what the GPU sees. Play
  // Delay draws the field one delay group at a time and each group has to start
  // at instance 0 (three has no instance-start offset), so the groups are copied
  // to the front of `data` one after another — which would clobber the groups
  // still waiting if the build had written there directly.
  const scratch = new Float32Array(REP_MAX_TILES * FLOATS_PER_TILE);
  return { scene, mesh, geometry, material: nodeMat ?? material, buffer, data, scratch };
}

export function applyRepetileBlendMode(material, mode) {
  if (mode > 1.5) {           // screen
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneMinusSrcColorFactor;
  } else if (mode > 0.5) {    // add
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
  } else {                    // normal, premultiplied
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
  }
  material.needsUpdate = true;
}

/* ------------------------------------------------------------ field build */

// Per-tile randoms, hashed from the tile's OWN (di, dj) coordinate.
//
// They used to be drawn from one sequential stream into a table indexed by grid
// position (`j * cols + i`), and that index moves the moment the field grows:
// adding a single column re-rolled the jitter, scale, rotation, tint and stack
// order of EVERY tile at once. That whole-field re-shuffle is exactly why the
// Expand counts were held static. Hashed by coordinate they are stable — a new
// ring only adds draws, and the tiles already on screen keep their numbers.
//
// The state is mixed from the seed and the coordinate, then walked with
// mulberry32's step for the five channels one tile needs.
// Channels 5 and 6 are the Random layout's scatter. They are APPENDED, so every
// tile's first five draws — jitter, scale, rotation, opacity, tint — are byte for
// byte what they were before the layout modes existed.
const RND_CHANNELS = 7;
const RND = new Float64Array(RND_CHANNELS);

function tileRandoms(seed, di, dj, out) {
  let a = (Math.imul(seed * 7919 + 13, 0x9E3779B1)
    ^ Math.imul(di + 71, 0x85EBCA77)
    ^ Math.imul(dj + 149, 0xC2B2AE3D)) | 0;
  for (let c = 0; c < out.length; c++) {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[c] = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

const EASE = [
  (t) => 1 - (1 - t) ** 3,
  (t) => { const c1 = 1.70158; const c3 = c1 + 1; return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2; },
  (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2),
  (t) => t,
];

const hexToRgb = (hex) => {
  const s = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#ffffff';
  return [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255];
};

const isOdd = (v) => (((v % 2) + 2) % 2) === 1;

const clamp01 = (v) => (v < 0 ? 0 : (v > 1 ? 1 : v));

// An Expand count clamped into its legal range, kept FRACTIONAL.
const expandOf = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(20, v)) : 0);

// How present ring `r` is (1-based distance from the original) under a fractional
// extent: 1 while fully inside, the fraction on the outermost ring, 0 past it.
// The original tile (r = 0) always weighs 1 — growing the field never touches it.
const ringWeight = (extent, r) => (r <= 0 ? 1 : clamp01(extent - r + 1));

// The rings a fractional extent reaches at all — 2.0 → 2, 2.01 → 3, 0 → 0.
const ringCount = (extent) => Math.max(0, Math.ceil(extent - 1e-6));

// Negate without minting -0: it is harmless in GL but makes the buffer compare
// unequal to a plain 0 for anything reading it back.
const neg = (v) => (v === 0 ? 0 : -v);

const TAU = Math.PI * 2;

// The golden angle — the divergence that packs a sunflower with no radial spokes,
// and the default the Grid Builder's spiral uses for the same reason.
const GOLDEN_ANGLE = 137.508 * Math.PI / 180;

// The lowest tiling mode that REPLACES the rectangular grid with a figure.
export const REP_LAYOUT_MODE = 8;

// Where (di, dj) sits along its own square ring, as 0..1 once around. The rings
// are Chebyshev — max(|di|, |dj|) — so the original is ring 0 and every further
// ring is the next square of cells out, which is exactly the field the Expand
// counts already describe. Walking the ring rather than taking atan2(dj, di)
// spaces the tiles EVENLY in angle; the raw square would bunch them at the
// corners, which reads as a lumpy ring rather than a cloner's.
function ringParam(di, dj, r) {
  const per = 8 * r;
  let idx;
  if (dj === -r) idx = di + r;                    // top row, left → right
  else if (di === r) idx = 2 * r + (dj + r);      // right column, top → bottom
  else if (dj === r) idx = 4 * r + (r - di);      // bottom row, right → left
  else idx = 6 * r + (r - dj);                    // left column, bottom → top
  return (idx % per) / per;
}

// The tile's index in CONCENTRIC order: 0 for the original, then ring by ring.
// (2r-1)² cells sit strictly inside ring r, so the ring's first cell starts there.
function ringOrdinal(di, dj, r) {
  if (r <= 0) return 0;
  return (2 * r - 1) ** 2 + Math.round(ringParam(di, dj, r) * 8 * r);
}

/**
 * Fill the instance buffer for one frame.
 * @param {Float32Array} data      the pass's interleaved buffer
 * @param {object} p               resolved params
 * @param {[number, number]} sizePx  the layer box size in px
 * @param {number} time            clip-local seconds (scroll + wave clock)
 * @param {number} ref             height / 1080, the scale px-authored values use
 * @param {{x: number, y: number}} [scroll]  DISTANCE already travelled, @1080 px.
 *   Scroll X/Y are rates, so a keyframed one has to be the INTEGRAL of its track —
 *   sampling the rate and multiplying by absolute time teleports the whole field
 *   the moment the value changes (offset = t·s(t) jumps by t·Δs). The Player passes
 *   integratePathRate's result; without a track that is just rate × time, which is
 *   what this falls back to.
 * @param {{hidden: boolean, groups: Array}} [out]  written, not read.
 *   `hidden` tells a zero count apart from a degenerate one: an empty field
 *   because the reveal has not started must CLEAR the layer, an empty field
 *   because the box or the spacing collapsed must leave the untouched plate
 *   alone — same number, opposite outcome.
 *   `groups` is the Play Delay draw plan, `[{ steps, count }]` in buffer order:
 *   consecutive runs of tiles that all read the same recorded plate. One group
 *   means one draw and no history at all, which is every field without a delay.
 * @returns {number} instance count
 */
export function buildRepetileField(data, p, sizePx, time, ref, scroll = null, out = null) {
  if (out) { out.hidden = false; out.groups = []; }
  // The four Expand counts are keyframable, so they arrive FRACTIONAL: 2.4
  // columns is two full rings plus a third at 40% presence. The grid is built out
  // to the ceiling and the outermost ring is faded by its fraction, which is what
  // turns a keyed count into a field that grows rather than one pop per integer.
  // Whole numbers are untouched — ceil(2) is 2 and every ring weighs 1.
  const leftF = expandOf(p.repLeft);
  const rightF = expandOf(p.repRight);
  const upF = expandOf(p.repUp);
  const downF = expandOf(p.repDown);
  const left = ringCount(leftF);
  const right = ringCount(rightF);
  const up = ringCount(upF);
  const down = ringCount(downF);
  const cols = 1 + left + right;
  const rows = 1 + up + down;

  const cellW = sizePx[0] * (p.repSpacingX / 100);
  const cellH = sizePx[1] * (p.repSpacingY / 100);
  if (!(cellW > 0.01) || !(cellH > 0.01)) return 0;

  const n = cols * rows;
  const seed = Math.round(p.repSeed);

  // Every stagger metric is normalised by the FRACTIONAL span, not the drawn one:
  // normalising by `cols` would step the falloffs, the tint spread and the reveal
  // delays of the whole field each time a ring appears, which is the same pop the
  // hashed randoms above remove from the per-tile draws.
  const spanX = leftF + rightF;
  const spanY = upF + downF;
  const maxDist = Math.hypot(Math.max(leftF, rightF), Math.max(upF, downF)) || 1;
  const tint = hexToRgb(p.repTint);
  const ease = EASE[Math.max(0, Math.min(EASE.length - 1, Math.round(p.repEase)))];
  const reveal = Math.max(0, Math.min(1, p.repReveal / 100));
  const spread = Math.max(0, Math.min(1, p.repSpread / 100));
  const brick = p.repBrick / 100;
  const amount = Math.max(0, Math.min(1, p.repAmount / 100));
  const feather = Math.max(0, p.repBlendBorders) / 100;
  const mode = Math.round(p.repMode);
  const revealType = Math.round(p.repRevealType);
  const revealOriginal = Math.round(p.repRevealOriginal) !== 0;

  // ---- layout modes (Radial / Wave / Spiral / Random) ----
  // They keep the tile SET the Expand counts describe and only move where each
  // tile lands, so every other control — stagger, falloffs, reveal, tint, wave —
  // keeps working untouched, and the original still sits at (0, 0).
  //
  // Every figure below is ABSOLUTE in the tile's own coordinate — no divide by a
  // field-wide maximum anywhere. That is deliberate: normalising by the drawn
  // extent would re-place the WHOLE field the instant a keyframed Expand grows a
  // ring, which is the same whole-field pop the hashed randoms were built to kill.
  const layout = mode >= REP_LAYOUT_MODE ? mode : 0;
  const spreadAmt = Math.max(0, p.repLayoutSpread) / 100;
  const turns = p.repLayoutTurns;
  const orient = Math.round(p.repLayoutOrient) === 1;
  const hRing = Math.max(1, leftF, rightF);
  const cellR = (cellW + cellH) * 0.5;
  // Play Delay rides the SAME `norm` every falloff rides: the head of the stagger
  // order plays live and the tail lags by the full delay, so the control that
  // decides what "per tile" counts along decides which way the canon runs.
  const delayFrames = Math.max(0, Math.min(REP_DELAY_MAX, p.repDelay));
  const delayStride = repetileDelayStride(p);
  const list = [];

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      const di = i - left;
      const dj = j - up;
      // Ring presence — 1 everywhere except the outermost ring of a fractional
      // count, and the early-out for a ring the count has not reached yet.
      const grow = ringWeight(di < 0 ? leftF : rightF, Math.abs(di))
        * ringWeight(dj < 0 ? upF : downF, Math.abs(dj));
      if (grow <= 0.0005) continue;
      tileRandoms(seed, di, dj, RND);
      const r0 = RND[0];
      const r1 = RND[1];
      const r2 = RND[2];
      const r3 = RND[3];
      const r4 = RND[4];

      // The stagger metric comes in two forms: a SIGNED one that accumulates
      // (a rotation step fans out symmetrically from the original tile) and a
      // NORMALISED 0..1 one for falloffs and reveal delays.
      let signed;
      let norm;
      switch (Math.round(p.repOrder)) {
        case 1: signed = dj; norm = spanY > 0 ? clamp01((dj + upF) / spanY) : 0; break;
        case 2: signed = di + dj; norm = (spanX + spanY) > 0 ? clamp01((di + leftF + dj + upF) / (spanX + spanY)) : 0; break;
        case 3: signed = Math.hypot(di, dj); norm = Math.min(1, signed / maxDist); break;
        case 4: signed = (r0 - 0.5) * Math.max(1 + spanX, 1 + spanY); norm = r0; break;
        case 5: signed = Math.abs(di); norm = clamp01(Math.abs(di) / Math.max(1, Math.max(leftF, rightF))); break;
        default: signed = di; norm = spanX > 0 ? clamp01((di + leftF) / spanX) : 0;
      }

      // Per-tile reveal progress. At reveal 0 nothing is in; at 100 everything is,
      // whatever the spread — the spread only redistributes the middle.
      // With Include Original off the original tile sits the entrance out entirely
      // (rt = 1), so the layer the user positioned never blinks: only the COPIES
      // build on around it.
      const isOriginal = di === 0 && dj === 0;
      const rt = ((spread > 0.001 || reveal < 1) && (revealOriginal || !isOriginal))
        ? Math.max(0, Math.min(1, reveal * (1 + spread) - norm * spread))
        : 1;
      const e = ease(rt);

      // Tiling mode: pure index maths (flip, brick offset, pinwheel rotation).
      let flipX = 1;
      let flipY = 1;
      let modeRot = 0;
      let bx = 0;
      let byDown = 0;
      switch (mode) {
        case 1: if (isOdd(di)) flipX = -1; if (isOdd(dj)) flipY = -1; break;
        case 2: if (isOdd(di)) flipX = -1; break;
        case 3: if (isOdd(dj)) flipY = -1; break;
        case 4: if (isOdd(dj)) bx = cellW * brick; break;
        case 5: if (isOdd(di)) byDown = cellH * brick; break;
        case 6:
          if (isOdd(dj)) { bx = cellW * brick; flipY = -1; }
          if (isOdd(di)) flipX = -1;
          break;
        case 7: modeRot = ((((di + dj) % 4) + 4) % 4) * Math.PI / 2; break;
        default: break;   // 8+ are layouts, handled below — no flip, no brick
      }

      // Layout figure: where this tile's CELL lands. The rectangular grid is the
      // default; Radial, Wave, Spiral and Random replace it. The original is
      // always the centre of the figure, so switching layouts never moves the
      // artwork the user positioned — the same contract the grid has.
      //
      // Y is counted screen-down here like the rest of the build (see the note
      // below), and angle 0 points UP with positive angles going clockwise, which
      // is the direction the editor's own Rotation field turns.
      let ccx = di * cellW + bx;
      let ccyDown = dj * cellH + byDown;
      if (layout !== 0) {
        const ring = Math.max(Math.abs(di), Math.abs(dj));
        if (layout === 8) {                     // Radial — one ring per grid ring
          if (ring === 0) { ccx = 0; ccyDown = 0; } else {
            const a = (ringParam(di, dj, ring) + turns) * TAU;
            // Spacing X/Y stay the pitch, so a wide layer rings out on an ellipse
            // exactly as wide — one fewer knob than a separate radius pair.
            ccx = Math.sin(a) * ring * cellW * spreadAmt;
            ccyDown = neg(Math.cos(a)) * ring * cellH * spreadAmt;
            if (orient) modeRot += a;
          }
        } else if (layout === 9) {              // Wave — the grid, riding a sine
          const phase = (di / hRing) * Math.PI * turns;
          const amp = cellH * spreadAmt;
          ccyDown += Math.sin(phase) * amp;
          // The sine's own tangent, so an oriented tile lies along the crest.
          if (orient) modeRot += Math.atan2(Math.cos(phase) * Math.PI * turns * amp / hRing, cellW);
        } else if (layout === 10) {             // Spiral — phyllotaxis, absolute
          // r ∝ √k with the 0.5 lands the outermost tile at the same radius the
          // grid's outermost ring would have had, so Spread 100% swaps the figure
          // without resizing the field.
          const k = ringOrdinal(di, dj, ring);
          const a = k * GOLDEN_ANGLE * (turns / 2.5);
          const rad = 0.5 * Math.sqrt(k) * cellR * spreadAmt;
          ccx = Math.sin(a) * rad;
          ccyDown = neg(Math.cos(a)) * rad;
          if (orient) modeRot += a;
        } else if (ring > 0) {                  // Random — scatter over the extent
          ccx = (RND[5] - 0.5) * 2 * Math.max(leftF, rightF) * cellW * spreadAmt;
          ccyDown = (RND[6] - 0.5) * 2 * Math.max(upF, downF) * cellH * spreadAmt;
        }
      }

      let scale = (p.repScale / 100)
        * (1 + (p.repScaleFall / 100) * norm)
        * (1 + (r1 - 0.5) * 2 * (p.repScaleRnd / 100));
      let rot = (p.repRotate + p.repRotateStep * signed + (r2 - 0.5) * 2 * p.repRotateRnd) * Math.PI / 180 + modeRot;
      let alpha = Math.max(0, Math.min(1, (1 + (p.repOpacityFall / 100) * norm) * (1 - r3 * (p.repOpacityRnd / 100))));
      // Effect Amount fades the ADDED tiles in, leaving the original where it was.
      // 0 never reaches here (the call site bypasses the whole pass), so the layer
      // is untouched at 0 and fully tiled at 100 with a usable ramp between.
      // `grow` rides along: it is 1 on the original and on every whole ring, so a
      // keyed Expand fades its newest ring in over exactly the same channel.
      if (di !== 0 || dj !== 0) alpha *= amount * grow;

      // Jitter, on the cell centre the layout put down. Y is counted the way the UI
      // reads it: +Y is DOWN the screen, so "Expand Down" puts tiles below the
      // original. The box frame the shader works in has +Y UP (computeLayerBox
      // projects the box's local +Y, and frame uv is y-up), so this whole block is
      // authored screen-down and negated once on the way into the buffer. Getting
      // that backwards is what made Expand Up and Expand Down swap places.
      let cx = ccx + (r4 - 0.5) * 2 * (p.repJitterX / 100) * cellW;
      let cyDown = ccyDown + (r1 - 0.5) * 2 * (p.repJitterY / 100) * cellH;
      // The tile's own offset from the original, BEFORE scroll and wave: the
      // distance the From Center reveal collapses. Scroll and wave stay applied
      // while a tile flies in, which is what keeps a scrolling field coherent.
      const localX = cx;
      const localYDown = cyDown;

      cx += (scroll ? scroll.x : p.repScrollX * time) * ref;
      cyDown += (scroll ? scroll.y : p.repScrollY * time) * ref;

      if (p.repWaveAmp > 0.001) {
        const phase = (signed * (p.repWaveLength / 100) - time * (p.repWaveSpeed / 100)) * Math.PI * 2;
        const w = Math.sin(phase);
        const axis = Math.round(p.repWaveAxis);
        if (axis === 0) cyDown += w * p.repWaveAmp * ref;
        else if (axis === 1) cx += w * p.repWaveAmp * ref;
        else if (axis === 2) {
          const dl = Math.hypot(di, dj) || 1;
          cx += (di / dl) * w * p.repWaveAmp * ref;
          cyDown += (dj / dl) * w * p.repWaveAmp * ref;
        } else if (axis === 3) rot += w * p.repWaveAmp * Math.PI / 180;
        else scale *= 1 + (w * p.repWaveAmp) / 200;
      }

      // The entrance. Reveal Type supplies a pose to arrive FROM; the From Scale /
      // Rotate / Offset fields then shape it further, so Fade with the defaults is
      // exactly the opacity-only entrance this always had.
      if (e < 1) {
        const inv = 1 - e;
        let fromScale = p.repFromScale / 100;
        let fromRotDeg = p.repFromRotate;
        let fromOffY = p.repFromOffset * ref;
        // Pop overshoots on the SCALE channel alone, whatever easing is picked —
        // an eased scale-in without the overshoot is a grow, not a pop.
        let eScale = e;
        switch (revealType) {
          case 1:                                   // Pop
            fromScale *= 0.15;
            eScale = EASE[1](rt);
            break;
          case 2:                                   // Rise — up from below
            fromOffY += 0.55 * sizePx[1];
            break;
          case 3:                                   // Spin
            fromScale *= 0.4;
            fromRotDeg -= 180;
            break;
          case 4:                                   // From Center
            // The tile collapses onto the original's own centre and travels out
            // to its cell, so the field blooms from the artwork rather than each
            // tile fading in where it already sits.
            cx -= localX * inv;
            cyDown -= localYDown * inv;
            break;
          default: break;                           // 0 — Fade, opacity only
        }
        scale = scale * eScale + scale * fromScale * (1 - eScale);
        rot += (fromRotDeg * Math.PI / 180) * inv;
        cyDown += fromOffY * inv;
        alpha *= Math.max(0, Math.min(1, e));
      }

      if (alpha <= 0.002 || scale <= 0.0005) continue;

      // A tile is the LAYER at `scale`, never the cell: the cell is only the pitch.
      // Spacing therefore opens gaps or overlaps without resizing the artwork, and
      // Tile Scale is the only thing that resizes it.
      const hx = sizePx[0] * 0.5 * scale * (1 + feather);
      const hy = sizePx[1] * 0.5 * scale * (1 + feather);
      // The uv window is ALWAYS the whole box (plus the feather ring). Scaling it
      // with the quad is what made Tile Scale look dead: the tile got smaller and
      // sampled a proportionally smaller crop, so the artwork stayed the same size
      // on screen and simply lost its edges.
      const uvx = (1 + feather) * flipX;
      const uvy = (1 + feather) * flipY;

      let tintAmt = p.repTintAmount / 100;
      if (tintAmt > 0) {
        const tintMode = Math.round(p.repTintMode);
        if (tintMode === 1) tintAmt *= r2;
        else if (tintMode === 2) tintAmt *= (i + j) % 2;
        else tintAmt *= norm;
      }

      let sortKey;
      const stack = Math.round(p.repStack);
      if (stack === 1) sortKey = norm;
      else if (stack === 2) sortKey = -norm;
      else if (stack === 3) sortKey = r0;
      else sortKey = idx / n;

      // Which recorded plate this tile reads, in ring steps back from now.
      const steps = delayFrames > 0
        ? Math.max(0, Math.min(REP_DELAY_RING - 1, Math.round((norm * delayFrames) / delayStride)))
        : 0;

      list.push({ cx, cyDown, hx, hy, rot, alpha, uvx, uvy, tintAmt, sortKey, steps, ccx, ccyDown });
    }
  }

  // Play Delay draws one group per recorded plate, so the groups have to be
  // CONTIGUOUS in the buffer and the delay outranks the stack order. Within a
  // group the stack order still decides, which is why it is the tie-break rather
  // than a separate sort — and why a delayed field layers by delay first.
  if (delayFrames > 0) list.sort((a, b) => a.steps - b.steps || a.sortKey - b.sortKey);
  else if (Math.round(p.repStack) !== 0) list.sort((a, b) => a.sortKey - b.sortKey);

  // Empty, but the grid itself was sound — the reveal has simply not started. The
  // layer must go with it, or the call site's "no tiles, leave the plate alone"
  // fallback would leave the original standing at full opacity at Reveal 0.
  if (out && list.length === 0) out.hidden = true;

  const count = Math.min(list.length, REP_MAX_TILES);
  const halfCellW = cellW * 0.5;
  const halfCellH = cellH * 0.5;
  for (let k = 0; k < count; k++) {
    const it = list[k];
    const o = k * FLOATS_PER_TILE;
    // Screen-down → box frame (+Y up), and clockwise-positive rotation → the
    // counter-clockwise-positive angle a Y-up frame rotates by. Both flips live
    // here so the whole build above reads in the UI's own conventions, matching
    // the editor's Rotation field (keyframeParenting maps it as `rz: -deg`).
    data[o] = it.cx; data[o + 1] = neg(it.cyDown);
    data[o + 2] = it.hx; data[o + 3] = it.hy;
    data[o + 4] = neg(it.rot); data[o + 5] = it.alpha;
    data[o + 6] = it.uvx; data[o + 7] = it.uvy;
    data[o + 8] = it.ccx; data[o + 9] = neg(it.ccyDown);
    data[o + 10] = halfCellW; data[o + 11] = halfCellH;
    data[o + 12] = tint[0]; data[o + 13] = tint[1]; data[o + 14] = tint[2];
    data[o + 15] = it.tintAmt;
  }

  // The draw plan: runs of tiles that read the same plate. Without a delay that
  // is one run over the whole field, which is the single draw this always was.
  if (out) {
    const groups = out.groups;
    for (let k = 0; k < count; k++) {
      const steps = list[k].steps;
      const last = groups.length > 0 ? groups[groups.length - 1] : null;
      if (last && last.steps === steps) last.count += 1;
      else groups.push({ steps, count: 1 });
    }
  }
  return count;
}

/** The feather in the shader's local units (the quad was grown by the same factor). */
export function repetileFeatherLocal(p) {
  const f = Math.max(0, p.repBlendBorders) / 100;
  return f > 0 ? f / (1 + f) : 0;
}

// One-click starting points for the panel.
export const REP_PRESETS = [
  {
    name: 'Wallpaper',
    values: {
      repMode: 1, repLeft: 3, repRight: 3, repUp: 2, repDown: 2, repSpacingX: 100, repSpacingY: 100,
      repScale: 100, repRotate: 0, repRotateStep: 0, repScrollX: 40, repScrollY: 22,
      repEdgeMode: 2, repReveal: 100, repSpread: 0, repBlendBorders: 0,
    },
  },
  {
    name: 'Brick Wall',
    values: {
      repMode: 4, repBrick: 50, repLeft: 4, repRight: 4, repUp: 3, repDown: 3,
      repSpacingX: 102, repSpacingY: 102, repScale: 97, repTintAmount: 18, repTintMode: 1,
      repOrder: 1, repReveal: 100, repSpread: 0,
    },
  },
  {
    name: 'Fan Cascade',
    values: {
      repMode: 0, repLeft: 6, repRight: 6, repUp: 0, repDown: 0, repSpacingX: 55, repSpacingY: 100,
      repScale: 90, repRotateStep: 7, repOrder: 0, repOpacityFall: -40, repScaleFall: -35,
      repStack: 1, repReveal: 100, repSpread: 0,
    },
  },
  {
    name: 'Pop Grid Reveal',
    values: {
      repMode: 0, repLeft: 4, repRight: 4, repUp: 2, repDown: 2, repSpacingX: 105, repSpacingY: 105,
      repScale: 85, repOrder: 3, repSpread: 70, repFromScale: 0, repFromRotate: -60, repEase: 1,
      // Lands on the FINISHED grid, not on reveal 0: a preset that leaves the layer
      // looking untouched reads as "the effect did nothing". Keyframe Reveal 0 → 100
      // to play the entrance.
      repReveal: 100,
    },
  },
  {
    name: 'Shuffle Scatter',
    values: {
      repMode: 0, repLeft: 4, repRight: 4, repUp: 2, repDown: 2, repSpacingX: 110, repSpacingY: 110,
      repScale: 70, repRotateRnd: 40, repScaleRnd: 35, repJitterX: 25, repJitterY: 25,
      repOpacityRnd: 30, repOrder: 4, repSpread: 80, repFromScale: 40, repFromRotate: 90, repReveal: 100,
    },
  },
  {
    name: 'Kaleido Unfold',
    values: {
      repMode: 1, repLeft: 4, repRight: 4, repUp: 3, repDown: 3, repSpacingX: 100, repSpacingY: 100,
      repScale: 100, repBlendBorders: 22, repEdgeMode: 1, repReveal: 100, repSpread: 0,
    },
  },
  {
    name: 'Pinwheel',
    values: {
      repMode: 7, repLeft: 4, repRight: 4, repUp: 3, repDown: 3, repSpacingX: 100, repSpacingY: 100,
      repScale: 100, repReveal: 100, repSpread: 0,
    },
  },
  {
    name: 'Wave Field',
    values: {
      repMode: 0, repLeft: 6, repRight: 6, repUp: 4, repDown: 4, repSpacingX: 95, repSpacingY: 95,
      repScale: 80, repOrder: 3, repWaveAmp: 34, repWaveAxis: 0, repWaveLength: 35, repWaveSpeed: 100,
      repTintAmount: 45, repTintMode: 0, repReveal: 100, repSpread: 0,
    },
  },
  {
    name: 'Ring Burst',
    values: {
      repMode: 8, repLeft: 2, repRight: 2, repUp: 2, repDown: 2, repSpacingX: 120, repSpacingY: 120,
      repLayoutSpread: 100, repLayoutTurns: 0, repLayoutOrient: 1, repScale: 45,
      repOrder: 3, repReveal: 100, repSpread: 60, repRevealType: 4, repRevealOriginal: 0,
    },
  },
  {
    name: 'Sunflower',
    values: {
      repMode: 10, repLeft: 3, repRight: 3, repUp: 3, repDown: 3, repSpacingX: 100, repSpacingY: 100,
      repLayoutSpread: 100, repLayoutTurns: 2.5, repLayoutOrient: 0, repScale: 30,
      repScaleFall: -40, repOrder: 3, repStack: 2, repReveal: 100, repSpread: 55, repRevealType: 1,
    },
  },
  {
    name: 'Scatter Pop',
    values: {
      repMode: 11, repLeft: 3, repRight: 3, repUp: 2, repDown: 2, repSpacingX: 100, repSpacingY: 100,
      repLayoutSpread: 120, repScale: 55, repRotateRnd: 25, repScaleRnd: 30,
      repOrder: 4, repReveal: 100, repSpread: 80, repRevealType: 1, repRevealOriginal: 0,
    },
  },
  {
    name: 'Echo Stack',
    values: {
      repMode: 0, repLeft: 0, repRight: 0, repUp: 0, repDown: 8, repSpacingX: 100, repSpacingY: 12,
      repScale: 100, repOrder: 1, repOpacityFall: -75, repScaleFall: -10, repBlendMode: 1,
      repStack: 2, repTintAmount: 60, repTintMode: 0, repReveal: 100, repSpread: 0,
    },
  },
];
