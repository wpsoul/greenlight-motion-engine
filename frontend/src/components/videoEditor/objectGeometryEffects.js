/*
 * OBJECT EFFECTS — the GEOMETRY family.
 *
 * Six programs that draw strokes, marks, a Delaunay graph and real type rather
 * than shading pixels: Node Field (with Node Labels as its own option), Link
 * Graph, Facet Plates and Measure Rig.
 *
 * They are Overlay Effects like the rest of the pack and carry the same per-entry
 * TRACKING block — the subject field drives where points concentrate, which faces
 * are protected, and (Measure Rig) which box is annotated.
 *
 * WHAT IS DIFFERENT: the drawing happens on a Canvas2D plate (objectPlate.js),
 * and the fragment below does nothing but composite it. All six therefore SHARE
 * one fragment and one TSL body — the thing that distinguishes them is CPU-side,
 * so there is nothing per-effect for a shader to do, and six near-identical
 * shader bodies would be six places for the composite rule to drift.
 *
 * PARAM SLOTS. These programs' params are read by the CPU, not by the shader, so
 * they claim NO uParams slot at all (`slot: null`); the two the fragment needs
 * are 16 (a plate exists this frame) and 17 (its opacity). Slots 18–27 stay the
 * track block, as everywhere in the pack.
 */

import { TRACK_PRELUDE } from './objectTracking';

/*
 * The shared composite. Canvas2D hands back STRAIGHT alpha, the chain works in
 * premultiplied, and the plate is the layer's own box — so the read is
 * `vec2(p.x, 1 - p.y)` on fxLocal(), the same single flip the whole family uses.
 *
 * No plate this frame (media still decoding, nothing extracted yet) is an EXACT
 * pass-through rather than a black frame: a geometry effect that cannot draw must
 * look like an effect that is not there.
 */
const PLATE_FX = /* glsl */ `
${TRACK_PRELUDE}

vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  if (uParams[16] < 0.5) return src;
  vec2 lp = fxLocal(uv);
  if (lp.x < 0.0 || lp.x > 1.0 || lp.y < 0.0 || lp.y > 1.0) return src;
  vec4 plate = texture2D(uTexture2, vec2(lp.x, 1.0 - lp.y));
  float pa = clamp(plate.a * (uParams[17] / 100.0), 0.0, 1.0);
  if (pa <= 0.0) return src;
  vec3 straight = unpremult(src);
  return premult(mix(straight, plate.rgb, pa), src.a);
}
`;

/* Every geometry program takes the same extraction controls — they all read the
   same point set, and a per-program copy would let two effects on one layer
   disagree about what the extraction even is. */
const EXTRACT_PARAMS = (overrides = {}) => ([
  { key: 'analysis', slot: null, label: 'Analysis', type: 'select', default: 384, static: true, extract: true,
    options: [
      { value: 256, label: '256 px (fastest)' },
      { value: 384, label: '384 px' },
      { value: 512, label: '512 px' },
      { value: 768, label: '768 px (slowest)' },
    ] },
  // Density is a CAP, not a target: the point count saturates against the
  // threshold and the analysis resolution (measured 838 → 1182 across 256 → 768),
  // so a slider labelled "Density" reads as broken above the saturation point.
  { key: 'density', slot: null, label: 'Max points', min: 40, max: 1200, step: 10, default: 600, static: true, extract: true },
  { key: 'threshold', slot: null, label: 'Edge threshold', min: 1, max: 40, step: 1, default: 5, suffix: '%', static: true, extract: true },
  { key: 'preBlur', slot: null, label: 'Pre-blur', min: 0, max: 6, step: 0.5, default: 1, suffix: 'px', static: true, extract: true,
    note: 'A DETECTION control — it never reaches the picture.' },
  { key: 'bias', slot: null, label: 'Subject bias', min: 0, max: 100, step: 1, default: 70, suffix: '%', static: true, extract: true, track: true },
  { key: 'faceProtect', slot: null, label: 'Face protect', type: 'select', default: 0, static: true, extract: true, track: true,
    options: [
      { value: 0, label: 'Off' },
      { value: 1, label: 'Reduce' },
      { value: 2, label: 'Exclude' },
    ] },
  { key: 'seed', slot: null, label: 'Seed', min: 0, max: 999, step: 1, default: 7, static: true, extract: true },
].map((p) => (p.key in overrides ? { ...p, default: overrides[p.key] } : p)));

const TRACK_PARAMS = (overrides = {}) => ([
  {
    key: 'trackSource', slot: null, label: 'Detect', type: 'select', default: 0,
    track: true, scanOpt: true, static: true,
    options: [
      { value: 0, label: 'Person silhouette' },
      { value: 1, label: 'Face' },
      { value: 2, label: 'Person + face' },
    ],
  },
  { key: 'trackFeather', slot: null, label: 'Field feather', min: 0, max: 8, step: 1, default: 2, suffix: ' cells', track: true, scanOpt: true, static: true },
  { key: 'trackFaceBoost', slot: null, label: 'Face weight', min: 0, max: 100, step: 1, default: 100, suffix: '%', track: true, scanOpt: true, static: true },
].map((p) => (p.key in overrides ? { ...p, default: overrides[p.key] } : p)));

const OPACITY = (dflt = 100) => ({
  key: 'opacity', slot: 17, label: 'Program opacity', min: 0, max: 100, step: 1, default: dflt, suffix: '%',
});

/* Video only: how hard the point set is held steady frame to frame — identity,
   easing and hysteresis against the raw per-frame solve (objectStabilize.js).
   0 is the raw solve; a still ignores it entirely. */
const STABILISE = () => ({
  key: 'stabilise', slot: null, label: 'Stabilise', min: 0, max: 100, step: 1, default: 100, suffix: '%', static: true,
  note: 'Video only. Marks keep their identity between frames and ease toward the new solve instead of being re-dealt.',
});

const SHAPE_OPTIONS = [
  { value: 0, label: 'Circle' },
  { value: 1, label: 'Square' },
  { value: 2, label: 'Diamond' },
  { value: 3, label: 'Triangle' },
  { value: 4, label: 'Hexagon' },
  { value: 5, label: 'Cross' },
  { value: 6, label: 'Plus' },
  { value: 7, label: 'Bracket' },
  { value: 8, label: 'Mixed' },
];

const base = (id, name, params, presets) => ({
  id,
  name,
  group: 'Object',
  scopes: ['layer'],
  layerMatte: 'expand',
  usesTrack: true,
  usesPlate: true,
  animated: false,
  params,
  colorPresets: presets,
  fragment: PLATE_FX,
});

/* ── 02 · GEOMETRY NODES ──────────────────────────────────────────────────── */

export const OBJECT_NODES_ID = 'objectNodes';

const OBJECT_NODES = base(OBJECT_NODES_ID, 'Node Field', [
  { key: 'shape', slot: null, label: 'Mark', type: 'select', primary: true, default: 7, static: true, options: SHAPE_OPTIONS },
  { key: 'size', slot: null, label: 'Mark size', min: 1, max: 40, step: 0.5, default: 40, suffix: 'px', static: true },
  { key: 'weight', slot: null, label: 'Line weight', min: 0.2, max: 4, step: 0.1, default: 1, suffix: 'px', static: true },
  { key: 'fill', slot: null, label: 'Fill', min: 0, max: 100, step: 1, default: 0, suffix: '%', static: true },
  { key: 'vary', slot: null, label: 'Size by strength', min: 0, max: 100, step: 1, default: 0, suffix: '%', static: true },
  { key: 'random', slot: null, label: 'Size jitter', min: 0, max: 100, step: 1, default: 100, suffix: '%', static: true },
  { key: 'rotate', slot: null, label: 'Align to contour', min: 0, max: 100, step: 1, default: 65, suffix: '%', static: true },
  { key: 'hero', slot: null, label: 'Hero nodes', min: 0, max: 40, step: 1, default: 6, suffix: '%', static: true },
  { key: 'heroScale', slot: null, label: 'Hero scale', min: 100, max: 400, step: 5, default: 170, suffix: '%', static: true },
  { key: 'ring', slot: null, label: 'Hero ring', min: 0, max: 100, step: 1, default: 0, suffix: '%', static: true },
  { key: 'labels', slot: null, label: 'Node labels', min: 0, max: 100, step: 1, default: 76, suffix: '%', static: true },
  { key: 'labelStyle', slot: null, label: 'Label style', type: 'select', default: 2, static: true,
    options: [
      { value: 0, label: 'Chip' },
      { value: 1, label: 'Outlined box' },
      { value: 2, label: 'Tag on a rule' },
      { value: 3, label: 'Code word' },
    ] },
  { key: 'labelSize', slot: null, label: 'Label size', min: 7, max: 24, step: 1, default: 12, suffix: 'px', static: true },
  OPACITY(100),
  STABILISE(),
  ...EXTRACT_PARAMS({ analysis: 768 }),
  ...TRACK_PARAMS(),
  { key: 'ink', type: 'color', colorSlot: 0, label: 'Ink', default: '#7fe3ff' },
  { key: 'ink2', type: 'color', colorSlot: 1, label: 'Second ink', default: '#4a7f95' },
  { key: 'accent', type: 'color', colorSlot: 2, label: 'Accent', default: '#ffffff' },
], [
  { name: 'Node field', colors: ['#7fe3ff', '#4a7f95', '#ffffff'], params: { shape: 0, size: 9, hero: 6, ring: 60 } },
  { name: 'Mixed marks', colors: ['#ffd27f', '#8a6a3a', '#fff6e8'], params: { shape: 8, size: 12, random: 60, fill: 20 } },
  { name: 'Indexed', colors: ['#38f8b0', '#1c6b4e', '#eaffee'], params: { shape: 1, size: 7, labels: 60, labelStyle: 1 } },
]);

/* ── 04 · EDGE LINK GRAPH ─────────────────────────────────────────────────── */

export const OBJECT_LINKS_ID = 'objectLinks';

const OBJECT_LINKS = base(OBJECT_LINKS_ID, 'Link Graph', [
  { key: 'mode', slot: null, label: 'Link system', type: 'select', primary: true, default: 1, static: true,
    options: [
      { value: 0, label: 'Proximity' },
      { value: 1, label: 'Delaunay' },
      { value: 2, label: 'Edge chain' },
      { value: 3, label: 'Radial hubs' },
      { value: 4, label: 'Orthogonal' },
      { value: 5, label: 'Hybrid' },
    ] },
  { key: 'dist', slot: null, label: 'Max distance', min: 1, max: 40, step: 0.5, default: 4.5, suffix: '%', static: true },
  { key: 'weight', slot: null, label: 'Line weight', min: 0.2, max: 4, step: 0.1, default: 0.7, suffix: 'px', static: true },
  { key: 'conf', slot: null, label: 'Strength cut', min: 0, max: 100, step: 1, default: 75, suffix: '%', static: true },
  OPACITY(100),
  STABILISE(),
  ...EXTRACT_PARAMS({ density: 110, threshold: 9, preBlur: 2, faceProtect: 1 }),
  ...TRACK_PARAMS({ trackSource: 2 }),
  { key: 'ink', type: 'color', colorSlot: 0, label: 'Ink', default: '#7fe3ff' },
  { key: 'ink2', type: 'color', colorSlot: 1, label: 'Link ink', default: '#7fe3ff' },
  { key: 'accent', type: 'color', colorSlot: 2, label: 'Accent', default: '#ffffff' },
], [
  { name: 'Delaunay web', colors: ['#7fe3ff', '#7fe3ff', '#ffffff'], params: { mode: 1, dist: 7, weight: 0.8 } },
  { name: 'Constellation', colors: ['#cfd6e6', '#8fa4c8', '#ffffff'], params: { mode: 0, dist: 5, conf: 55 } },
  { name: 'Contour chain', colors: ['#ff6ea9', '#ff6ea9', '#ffe9f2'], params: { mode: 2, dist: 4, weight: 1.2 } },
  { name: 'Circuit', colors: ['#38f8b0', '#38f8b0', '#eaffee'], params: { mode: 4, dist: 6, weight: 0.6 } },
]);

/* ── N2 · FACET PLATES ────────────────────────────────────────────────────── */

export const OBJECT_FACETS_ID = 'objectFacets';

const OBJECT_FACETS = base(OBJECT_FACETS_ID, 'Facet Plates', [
  { key: 'detail', slot: null, label: 'Triangles from', min: 40, max: 700, step: 10, default: 260, suffix: ' pts', static: true },
  // Drops the Delaunay hull slivers — the long wedges a raw triangulation fans
  // out to the frame corners. Not a look control so much as the thing that makes
  // the look possible; see objectPlate.drawFacets.
  { key: 'maxSide', slot: null, label: 'Max plate size', min: 3, max: 60, step: 1, default: 18, suffix: '%', static: true },
  { key: 'fill', slot: null, label: 'Plate fill', min: 0, max: 100, step: 1, default: 85, suffix: '%', static: true },
  { key: 'shade', slot: null, label: 'Shading', type: 'select', primary: true, default: 0, static: true,
    options: [
      { value: 0, label: 'Flat colour' },
      { value: 1, label: 'Facing ramp' },
      { value: 2, label: 'Monochrome' },
    ] },
  { key: 'edge', slot: null, label: 'Plate edge', min: 0, max: 3, step: 0.1, default: 0.5, suffix: 'px', static: true },
  { key: 'subject', slot: null, label: 'Subject only', min: 0, max: 100, step: 1, default: 0, suffix: '%', static: true, track: true },
  OPACITY(90),
  STABILISE(),
  ...EXTRACT_PARAMS(),
  ...TRACK_PARAMS(),
  { key: 'ink', type: 'color', colorSlot: 0, label: 'Ink', default: '#7fe3ff' },
  { key: 'ink2', type: 'color', colorSlot: 1, label: 'Edge', default: '#ffffff' },
  { key: 'accent', type: 'color', colorSlot: 2, label: 'Accent', default: '#ffffff' },
], [
  { name: 'Low poly', colors: ['#7fe3ff', '#ffffff', '#ffffff'], params: { detail: 260, fill: 85, shade: 0, edge: 0.5 } },
  { name: 'Faceted', colors: ['#7fe3ff', '#0b1a22', '#ffffff'], params: { detail: 420, fill: 95, shade: 1, edge: 0 } },
  { name: 'Duotone plates', colors: ['#1b2a6b', '#ffffff', '#ff9f43'], params: { detail: 200, fill: 100, shade: 2, edge: 0.4 } },
]);

/* ── N4 · MEASURE RIG ─────────────────────────────────────────────────────── */

export const OBJECT_MEASURE_ID = 'objectMeasure';

const OBJECT_MEASURE = base(OBJECT_MEASURE_ID, 'Measure Rig', [
  { key: 'target', slot: null, label: 'Target', type: 'select', primary: true, default: 0, static: true, track: true,
    options: [
      { value: 0, label: 'Subject bounds' },
      { value: 1, label: 'Face box' },
      { value: 2, label: 'Whole layer' },
    ] },
  { key: 'pad', slot: null, label: 'Padding', min: -10, max: 40, step: 1, default: 4, suffix: '%', static: true },
  { key: 'corners', slot: null, label: 'Corner brackets', min: 0, max: 100, step: 1, default: 90, suffix: '%', static: true },
  { key: 'dims', slot: null, label: 'Dimension lines', min: 0, max: 100, step: 1, default: 85, suffix: '%', static: true },
  { key: 'cross', slot: null, label: 'Centroid cross', min: 0, max: 100, step: 1, default: 80, suffix: '%', static: true },
  { key: 'readout', slot: null, label: 'Readouts', min: 0, max: 100, step: 1, default: 90, suffix: '%', static: true },
  { key: 'weight', slot: null, label: 'Line weight', min: 0.2, max: 4, step: 0.1, default: 1, suffix: 'px', static: true },
  OPACITY(90),
  ...TRACK_PARAMS(),
  { key: 'ink', type: 'color', colorSlot: 0, label: 'Ink', default: '#7fe3ff' },
  { key: 'ink2', type: 'color', colorSlot: 1, label: 'Second ink', default: '#4a7f95' },
  { key: 'accent', type: 'color', colorSlot: 2, label: 'Accent', default: '#ffffff' },
], [
  { name: 'Survey', colors: ['#7fe3ff', '#4a7f95', '#ffffff'], params: { target: 0, corners: 90, dims: 85, readout: 90 } },
  { name: 'Face lock', colors: ['#ff3b30', '#7a1f1a', '#ffffff'], params: { target: 1, pad: 12, corners: 100, dims: 0 } },
  { name: 'Frame rig', colors: ['#38f8b0', '#1c6b4e', '#eaffee'], params: { target: 2, pad: -4, cross: 100 } },
]);

export const OBJECT_GEOMETRY_EFFECTS = [
  OBJECT_NODES, OBJECT_LINKS, OBJECT_FACETS, OBJECT_MEASURE,
];

export const OBJECT_GEOMETRY_IDS = new Set(OBJECT_GEOMETRY_EFFECTS.map((e) => e.id));
