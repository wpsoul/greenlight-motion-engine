// Grid Builder — the layout engine.
//
// A Grid layer is a CONTAINER (see types.js `isContainerClip`): its nested
// timeline holds one channel per member, and this module decides where each of
// those members is drawn. The grid owns only PRS — the member keeps its own
// stored position/rotation/scale untouched, which is what makes "ungroup" restore
// everything for free.
//
// `gridCellPoses` is a PURE function of (config, members, { W, H, progress,
// duration }). No Math.random(), no frame-to-frame state, no DOM, no three, no
// React. That is the contract that keeps the live preview, the editor's Download
// and the headless /video-render route pixel-identical, and it is what lets the
// whole thing be exercised under plain `node --test` (gridLayout.test.mjs).
//
// Coordinates: the returned `prs` is the editor's canonical THREE space, exactly
// what localPrs() in keyframeParenting.js produces —
//   px  +right       py  +UP       pz  +toward the camera
//   rx/ry/rz  radians, negated from the panel's degrees
//   sx/sy/sz plain multipliers
// so a pose can be written to a mesh (or handed to applyParenting) unchanged.
//
// Panel-facing units, on the other hand, mirror the Group Distributor's
// vocabulary (`layoutPoints`, DistributorPanel.jsx): margins/gaps are % of the
// frame, radii are % of the frame HEIGHT so a circle stays a circle at any aspect.
//
// Explicit .js extensions on the imports so `node --test` can load this directly,
// the same reason keyframeParenting.js imports objectMotionPath.js that way.
import { evaluateObjectMotionPath, eulerForObjectPathTangent } from './objectMotionPath.js';
import { namedEase } from './appEases.js';
import { localPrs } from './keyframeParenting.js';
import { GRID_KF_PREFIX } from './keyframeProps.js';
import { TransitionEasing } from './types.js';
import { contentRectInQuad } from './mediaFit.js';

export { GRID_KF_PREFIX };
export { contentRectInQuad };

export const GRID_CONFIG_VERSION = 1;

// 'current' is the identity layout: every cell sits where its layer already was,
// so grouping a hand-built arrangement into a grid changes nothing on screen. It
// is the mode a new grid is born in (buildGridFromSelection) and the natural
// slot 0 of a morph — Mix then travels from what the user placed into a rule.
export const GRID_MODES = ['current', 'rect', 'radial', 'spiral', 'wave', 'scatter', 'sphere', 'path'];
export const GRID_ORDERS = ['stack', 'reverse', 'name', 'random'];
export const GRID_FITS = ['contain', 'cover', 'stretch', 'none'];
export const GRID_ORIENTS = ['forward', 'center', 'screen', 'path'];
export const GRID_FILL_ORDERS = ['row', 'col', 'boustrophedon'];
export const GRID_ALIGN_LAST = ['center', 'start'];
export const GRID_SPIRAL_TYPES = ['phyllotaxis', 'archimedean'];
export const GRID_PATH_SPACING = ['arc', 'segment'];
export const GRID_REVEAL_PRESETS = ['none', 'fade', 'pop', 'rise', 'spin', 'flyCenter', 'flyEdge', 'flyRandom'];
export const GRID_STAGGER_BY = ['index', 'ring', 'distance', 'random'];
export const GRID_SCALE_BY = ['off', 'index', 'depth', 'distance'];

/* ── Effectors ──────────────────────────────────────────────────────────────
   An EFFECTOR turns "how much does this cell matter right now" into one number
   per cell (0–1), and every driven property is then blended from the cell's
   normal value toward its effected value by it. Two ways to decide that number,
   and only ONE can be live at a time — they answer the same question and
   stacking them just makes the result impossible to reason about:

     focus     — an animatable cell INDEX, with a falloff in cells around it
     proximity — the distance to other LAYERS on the timeline, referenced not
                 moved, so their own position keyframes drive the grid

   Look-dev: html/grid-focus-ripple.html and html/grid-proximity.html. */
export const GRID_EFFECTORS = ['off', 'focus', 'proximity'];
export const GRID_FOCUS_SHAPES = ['smooth', 'linear', 'ripple', 'step'];
export const GRID_FOCUS_MEASURES = ['index', 'row', 'column', 'distance'];
// Where the focus sits: an animatable index, or an end/centre that follows the
// member count so it needs no retuning when layers come and go.
export const GRID_FOCUS_TARGETS = ['index', 'first', 'last', 'center'];
// Properties that carry a Stagger badge (the group-edit pattern): the stagger
// value is an ordinary registry parameter; `staggerBackward[key]` flips which
// end of the run keeps the base value.
export const GRID_STAGGER_KEYS = ['radiusStagger', 'scaleStagger', 'rotateStaggerX', 'rotateStaggerY', 'rotateStaggerZ'];
export const GRID_PROX_SHAPES = ['smooth', 'linear', 'sharp'];
export const GRID_PROX_COMBINE = ['max', 'add', 'average'];
export const GRID_PROX_MEASURES = ['2d', 'x', 'y', '3d'];
export const GRID_MAX_PROX_SOURCES = 8;

/* What an effector can drive. `core` rows are always shown in the panel; the
   rest arrive through "Add property". `kind` decides where the value lands:
   'transform' is folded into the cell pose here, 'filter' is handed to the
   caller as a per-cell delta because those live on the clip material. */
export const GRID_FX_TARGETS = Object.freeze([
  { key: 'scale', label: 'Scale', unit: ' %', min: -100, max: 400, step: 1, def: 60, kind: 'transform', core: true },
  { key: 'opacity', label: 'Opacity', unit: ' %', min: -100, max: 100, step: 1, def: -70, kind: 'transform', core: true },
  { key: 'rotate', label: 'Rotation', unit: '°', min: -1440, max: 1440, step: 1, def: 45, kind: 'transform', core: true },
  { key: 'z', label: 'Push Z', unit: ' px', min: -4000, max: 4000, step: 10, def: 600, kind: 'transform', core: true },
  { key: 'lookAt', label: 'Look at source', unit: ' %', min: -200, max: 200, step: 5, def: 100, kind: 'transform', core: true, proximityOnly: true },
  { key: 'blur', label: 'Blur', unit: ' px', min: 0, max: 40, step: 0.5, def: 8, kind: 'filter' },
  { key: 'brightness', label: 'Brightness', unit: ' %', min: -100, max: 200, step: 1, def: 40, kind: 'filter' },
  { key: 'contrast', label: 'Contrast', unit: ' %', min: -100, max: 200, step: 1, def: 40, kind: 'filter' },
  { key: 'saturate', label: 'Saturation', unit: ' %', min: -100, max: 200, step: 1, def: 60, kind: 'filter' },
  { key: 'hue', label: 'Hue rotate', unit: '°', min: -360, max: 360, step: 1, def: 60, kind: 'filter' },
  { key: 'grayscale', label: 'Grayscale', unit: ' %', min: -100, max: 100, step: 1, def: 100, kind: 'filter' },
  { key: 'sepia', label: 'Sepia', unit: ' %', min: -100, max: 100, step: 1, def: 100, kind: 'filter' },
]);
const GRID_FX_BY_KEY = new Map(GRID_FX_TARGETS.map((t) => [t.key, t]));
export const gridFxTarget = (key) => GRID_FX_BY_KEY.get(key) || null;

// Members past this are laid out but not rendered — every cell costs a channel
// state with two meshes and two <video> elements (see createChannelState).
export const GRID_MAX_MEMBERS = 64;

// Layout slots (Grid Morph). Enough for any real move; keeps the panel a list.
export const GRID_MAX_LAYOUT_SLOTS = 8;

export const GRID_DEFAULTS = Object.freeze({
  version: GRID_CONFIG_VERSION,
  mode: 'rect',

  // shared
  order: 'stack',
  seed: 1234,
  showGuide: false,     // preview-only dashed line through the cells in layout order
  fit: 'contain',
  cellPadding: 6,       // % of the cell box, per side
  cellScale: 100,       // % multiplier applied after the fit
  cellSize: 0,          // non-rect modes: cell side as % of frame height (0 = auto)
  orient: 'forward',
  jitterPos: 0,         // % of the cell box
  jitterRot: 0,         // degrees
  jitterScale: 0,       // %

  // rect
  cols: 0,              // 0 = auto (⌈√n⌉), matching the Distributor's Grid preset
  gapX: 4,
  gapY: 4,
  marginX: 8,
  marginY: 8,
  fillOrder: 'row',
  rowOffset: 0,         // brick / honeycomb — % of a cell pitch, alternate rows
  colOffset: 0,
  alignLast: 'center',

  // radial
  radius: 30,
  radiusStagger: 0,     // % of frame height added per cell: cell 0 at Radius,
                        // cell 1 at Radius+stagger, cell 2 at +2·stagger, …
  rings: 1,
  ringSpacing: 12,
  startAngle: -90,
  sweep: 360,
  spin: 0,

  // spiral
  spiralTurns: 2.5,
  spiralRadius: 35,
  spiralType: 'phyllotaxis',

  // wave
  waveAmp: 12,
  waveFreq: 1,
  wavePhase: 0,

  // wave / spiral / path — total roll about the direction of travel, spread
  // over the run: 360° is one full ribbon twist end to end
  twist: 0,

  // scatter
  scatterDepth: 0,      // px of random z spread

  // sphere
  sphereRadius: 420,    // px — a shell needs real size before perspective sells it
  sphereSpinY: 0,       // degrees
  sphereTiltX: 0,       // degrees

  // path
  path: null,           // { points: [...], closed } — same point shape as item.motionPath
  pathSpacing: 'arc',
  pathTrimStart: 0,     // % — the usable stretch of the curve
  pathTrimEnd: 100,
  pathProgress: 0,      // % into the trimmed stretch where the cells start (animate to travel)
  pathSpread: 100,      // % of the trimmed stretch the cells occupy

  // depth + scale distribution (After Effects' Transform block)
  zDepth: 0,            // px of Z spread across the arrangement
  zAnchor: 0.5,         // 0..1 — which end of the run sits at z = 0
  scaleBy: 'off',       // off | index | depth | distance
  scaleFront: 0,        // % added to the cell at the near end
  scaleBack: 0,         // % added to the cell at the far end

  // Uniform per-cell rotation (degrees, layer-panel sign), composed in each
  // card's OWN frame on top of whatever Orientation produced — so every card
  // tilts together, and a Face-screen card tilts without losing its aim.
  cellRotateX: 0,
  cellRotateY: 0,
  cellRotateZ: 0,

  // Per-cell staggers (same idea as the radial Radius stagger): cell 0 is
  // untouched and every next cell steps by the amount, in layout order. Set
  // from the Stagger badge on the property's own row, not a separate slider.
  scaleStagger: 0,      // % — cell j scales by 1 + j·stagger
  rotateStaggerX: 0,    // degrees per cell, composed in each card's own frame
  rotateStaggerY: 0,
  rotateStaggerZ: 0,
  // Which staggers walk BACKWARD (the last cell keeps the base value):
  // { <stagger key>: true }. Forward is the absent default.
  staggerBackward: {},

  // effectors (one at a time — see GRID_EFFECTORS)
  effector: 'off',
  // focus
  focusTarget: 'index',
  focusIndex: 0,
  focusFalloff: 3,
  focusShape: 'smooth',
  focusMeasure: 'index',
  focusRipples: 2,
  focusWrap: false,
  // proximity
  proxSources: [],      // timeline item ids — REFERENCED, never moved into the grid
  proxRange: 260,       // px of full influence
  proxFalloff: 420,     // px the influence fades out over
  proxShape: 'smooth',
  proxCombine: 'max',
  proxMeasure: '2d',
  effectorInvert: false,
  // what the live effector drives: { <target key>: amount }
  fx: { scale: 60 },

  // per-cell reveal
  revealPreset: 'none',
  revealDuration: 0.6,
  revealStagger: 0.05,
  revealStaggerBy: 'index',
  revealEase: TransitionEasing.POWER2_OUT,
  revealOut: false,

  // layout slots + morph (Grid Morph — look-dev: html/grid-morph.html).
  // `layouts` is an ordered list of layout families; `layoutMix` travels it,
  // the fractional part blending adjacent slots per cell (gridLayoutMixPoses).
  layouts: null,        // [{ mode, …that mode's GRID-section fields }] or null
  layoutMix: 0,         // 0 … layouts.length-1
  morphStagger: 0.35,   // 0–0.9 — how much of the move is spread across cell ranks
  morphStaggerBy: 'index',
  morphEase: TransitionEasing.POWER2_IN_OUT,
  morphArc: 60,         // px — outward bulge of the travel (negative implodes)
  morphSpin: 0,         // whole turns added over the blend; vanishes at both ends
});

/* ── the parameter registry ─────────────────────────────────────────────────
   One row per numeric grid parameter: the panel renders its field from this, the
   Keyframe Builder offers a `gr:<key>` track for it, and the sanitizer clamps to
   the same range. `modes` is which layout families show the control (null = all).
   Keeping the three in one table is what stops a new parameter from being
   animatable in one place and invisible in another. */
export const GRID_KF_FIELDS = Object.freeze([
  // shared — cells
  { key: 'cellPadding', label: 'Cell padding', group: 'Cells', min: 0, max: 45, step: 1, unit: '%', modes: null },
  { key: 'cellScale', label: 'Cell scale', group: 'Cells', min: 1, max: 400, step: 1, unit: '%', modes: null },
  { key: 'cellSize', label: 'Cell size', group: 'Cells', min: 0, max: 200, step: 1, unit: '%', modes: ['current', 'radial', 'spiral', 'wave', 'scatter', 'sphere', 'path'] },
  { key: 'cellRotateX', label: 'Rotate X', group: 'Cells', min: -360, max: 360, step: 1, unit: '°', modes: null },
  { key: 'cellRotateY', label: 'Rotate Y', group: 'Cells', min: -360, max: 360, step: 1, unit: '°', modes: null },
  { key: 'cellRotateZ', label: 'Rotate Z', group: 'Cells', min: -360, max: 360, step: 1, unit: '°', modes: null },
  { key: 'scaleStagger', label: 'Scale stagger', group: 'Cells', min: -100, max: 100, step: 0.5, unit: '%', modes: null },
  { key: 'rotateStaggerX', label: 'Rotate X stagger', group: 'Cells', min: -360, max: 360, step: 1, unit: '°', modes: null },
  { key: 'rotateStaggerY', label: 'Rotate Y stagger', group: 'Cells', min: -360, max: 360, step: 1, unit: '°', modes: null },
  { key: 'rotateStaggerZ', label: 'Rotate Z stagger', group: 'Cells', min: -360, max: 360, step: 1, unit: '°', modes: null },
  { key: 'jitterPos', label: 'Jitter position', group: 'Cells', min: 0, max: 200, step: 1, unit: '%', modes: null },
  { key: 'jitterRot', label: 'Jitter rotation', group: 'Cells', min: 0, max: 180, step: 1, unit: '°', modes: null },
  { key: 'jitterScale', label: 'Jitter scale', group: 'Cells', min: 0, max: 100, step: 1, unit: '%', modes: null },
  // rect
  { key: 'cols', label: 'Columns', group: 'Grid', min: 0, max: 24, step: 1, unit: '', modes: ['rect'] },
  { key: 'gapX', label: 'Gap X', group: 'Grid', min: -50, max: 50, step: 0.5, unit: '%', modes: ['rect'] },
  { key: 'gapY', label: 'Gap Y', group: 'Grid', min: -50, max: 50, step: 0.5, unit: '%', modes: ['rect'] },
  { key: 'marginX', label: 'Margin X', group: 'Grid', min: -45, max: 45, step: 1, unit: '%', modes: ['rect', 'wave', 'scatter'] },
  { key: 'marginY', label: 'Margin Y', group: 'Grid', min: -45, max: 45, step: 1, unit: '%', modes: ['rect', 'scatter'] },
  { key: 'rowOffset', label: 'Row offset', group: 'Grid', min: -100, max: 100, step: 1, unit: '%', modes: ['rect'] },
  { key: 'colOffset', label: 'Column offset', group: 'Grid', min: -100, max: 100, step: 1, unit: '%', modes: ['rect'] },
  // radial
  { key: 'radius', label: 'Radius', group: 'Grid', min: 0, max: 120, step: 1, unit: '%', modes: ['radial'] },
  { key: 'radiusStagger', label: 'Radius stagger', group: 'Grid', min: -120, max: 120, step: 1, unit: '%', modes: ['radial'] },
  { key: 'rings', label: 'Rings', group: 'Grid', min: 1, max: 8, step: 1, unit: '', modes: ['radial'] },
  { key: 'ringSpacing', label: 'Ring spacing', group: 'Grid', min: -60, max: 60, step: 1, unit: '%', modes: ['radial'] },
  { key: 'startAngle', label: 'Start angle', group: 'Grid', min: -360, max: 360, step: 1, unit: '°', modes: ['radial', 'spiral'] },
  { key: 'sweep', label: 'Sweep', group: 'Grid', min: 5, max: 360, step: 1, unit: '°', modes: ['radial'] },
  { key: 'spin', label: 'Spin', group: 'Grid', min: -1440, max: 1440, step: 1, unit: '°', modes: ['radial', 'spiral'] },
  // spiral
  { key: 'spiralRadius', label: 'Spiral radius', group: 'Grid', min: 0, max: 120, step: 1, unit: '%', modes: ['spiral'] },
  { key: 'spiralTurns', label: 'Turns', group: 'Grid', min: -12, max: 12, step: 0.25, unit: '', modes: ['spiral'] },
  // wave
  { key: 'waveAmp', label: 'Amplitude', group: 'Grid', min: -100, max: 100, step: 1, unit: '%', modes: ['wave'] },
  { key: 'waveFreq', label: 'Frequency', group: 'Grid', min: 0, max: 8, step: 0.1, unit: '', modes: ['wave'] },
  { key: 'wavePhase', label: 'Phase', group: 'Grid', min: -360, max: 360, step: 1, unit: '°', modes: ['wave'] },
  // wave / spiral / path
  { key: 'twist', label: 'Twist', group: 'Grid', min: -1440, max: 1440, step: 1, unit: '°', modes: ['wave', 'spiral', 'path'] },
  // scatter
  { key: 'scatterDepth', label: 'Depth spread', group: 'Grid', min: 0, max: 3000, step: 10, unit: ' px', modes: ['scatter'] },
  // sphere
  { key: 'sphereRadius', label: 'Sphere radius', group: 'Grid', min: 0, max: 3000, step: 10, unit: ' px', modes: ['sphere'] },
  { key: 'sphereSpinY', label: 'Spin Y', group: 'Grid', min: -1440, max: 1440, step: 1, unit: '°', modes: ['sphere'] },
  { key: 'sphereTiltX', label: 'Tilt X', group: 'Grid', min: -180, max: 180, step: 1, unit: '°', modes: ['sphere'] },
  // path
  { key: 'pathTrimStart', label: 'Trim start', group: 'Path', min: 0, max: 100, step: 1, unit: '%', modes: ['path'] },
  { key: 'pathTrimEnd', label: 'Trim end', group: 'Path', min: 0, max: 100, step: 1, unit: '%', modes: ['path'] },
  { key: 'pathProgress', label: 'Path progress', group: 'Path', min: -400, max: 400, step: 1, unit: '%', modes: ['path'] },
  { key: 'pathSpread', label: 'Path spread', group: 'Path', min: 1, max: 100, step: 1, unit: '%', modes: ['path'] },
  // depth + scale distribution
  { key: 'zDepth', label: 'Z depth', group: 'Depth', min: -6000, max: 6000, step: 10, unit: ' px', modes: null },
  { key: 'zAnchor', label: 'Z anchor', group: 'Depth', min: 0, max: 1, step: 0.05, unit: '', modes: null },
  { key: 'scaleFront', label: 'Scale front', group: 'Depth', min: -100, max: 400, step: 1, unit: '%', modes: null },
  { key: 'scaleBack', label: 'Scale back', group: 'Depth', min: -100, max: 400, step: 1, unit: '%', modes: null },
  // morph — the layout-slot mix and its shaping (gridLayoutMixPoses). Ordinary
  // numeric tracks, which is the whole point: `gr:layoutMix` inherits the
  // stopwatch, the Keyframes panel, the graph editor and HOLD unchanged.
  { key: 'layoutMix', label: 'Layout mix', group: 'Morph', min: 0, max: GRID_MAX_LAYOUT_SLOTS - 1, step: 0.01, unit: '', modes: null },
  { key: 'morphStagger', label: 'Morph stagger', group: 'Morph', min: 0, max: 0.9, step: 0.05, unit: '', modes: null },
  { key: 'morphArc', label: 'Morph arc', group: 'Morph', min: -600, max: 600, step: 10, unit: ' px', modes: null },
  { key: 'morphSpin', label: 'Morph spin', group: 'Morph', min: -4, max: 4, step: 1, unit: '', modes: null },
]);

const GRID_KF_FIELD_BY_KEY = new Map(GRID_KF_FIELDS.map((f) => [f.key, f]));
// Whole numbers only — a fractional column count is not a layout, and a
// fractional spin would no longer vanish at the blend's endpoints.
const GRID_INT_KEYS = new Set(['cols', 'rings', 'seed', 'morphSpin']);

export const gridKfKey = (paramKey) => `${GRID_KF_PREFIX}${paramKey}`;

export function parseGridKfKey(label) {
  if (typeof label !== 'string' || !label.startsWith(GRID_KF_PREFIX)) return null;
  const paramKey = label.slice(GRID_KF_PREFIX.length);
  return GRID_KF_FIELD_BY_KEY.has(paramKey) ? paramKey : null;
}

export const gridKfFieldMeta = (paramKey) => GRID_KF_FIELD_BY_KEY.get(paramKey) || null;

/** Fields this grid's CURRENT mode exposes, for the panel and the kf builder. */
export function gridFieldsForMode(mode) {
  return GRID_KF_FIELDS.filter((f) => !f.modes || f.modes.includes(mode));
}

/* ── auto layout-mix keyframes ──────────────────────────────────────────────
   Adding a layout slot keyframes the morph by itself: with N slots the
   `gr:layoutMix` track carries one key per slot, spread every 100/N percent of
   the clip — two slots land 0 → 50 %, three land 0 → 33 → 67 % — so a fresh
   morph plays without a manual trip to the Keyframes panel. A hand-edited
   track is respected: a new slot only appends its own key at the even spot,
   existing keys never move. */
const layoutMixAutoTrack = (count) => Array.from({ length: count }, (_, i) => ({
  position: Math.round((i * 100 / count) * 100) / 100,
  value: String(i),
  easing: TransitionEasing.EASE_IN_OUT,
}));

const layoutMixTrackIsAuto = (track, count) => Array.isArray(track) && track.length === count
  && track.every((k, i) => Math.abs(Number(k.position) - (i * 100 / count)) <= 0.6
    && Number(k.value) === i);

/**
 * The `propertyKeyframes` map a grid item should carry after its layout list
 * changed size, or null when nothing needs to change. `prevCount`/`nextCount`
 * are the slot counts before and after the edit (0 or 1 = no list). The
 * stopwatch's constant no-op pair (same value at 0 and 100) counts as
 * untouched, so it is reseeded rather than appended to.
 */
export function autoLayoutMixKeyframes(propertyKeyframes, prevCount, nextCount) {
  const trackKey = gridKfKey('layoutMix');
  const pk = propertyKeyframes || {};
  const existing = Array.isArray(pk[trackKey]) && pk[trackKey].length ? pk[trackKey] : null;
  if (nextCount < 2) {
    // The list collapsed — a mix track with nothing left to morph only confuses.
    if (!existing) return null;
    const next = { ...pk };
    delete next[trackKey];
    return next;
  }
  if (nextCount === prevCount) return null;
  const isNoopPair = existing && existing.length === 2
    && Number(existing[0].position) === 0 && Number(existing[1].position) === 100
    && existing[0].value === existing[1].value;
  if (!existing || isNoopPair || layoutMixTrackIsAuto(existing, prevCount)) {
    return { ...pk, [trackKey]: layoutMixAutoTrack(nextCount) };
  }
  if (nextCount < prevCount) return null;   // hand-edited + slot removed: keys stay put
  // Hand-edited track and a slot was added: append the new slot's key alone.
  const position = Math.round(((nextCount - 1) * 100 / nextCount) * 100) / 100;
  if (existing.some((k) => Math.abs(Number(k.position) - position) < 1)) return null;
  const track = [...existing, { position, value: String(nextCount - 1), easing: TransitionEasing.EASE_IN_OUT }]
    .sort((a, b) => a.position - b.position);
  return { ...pk, [trackKey]: track };
}

/* ── layout slots (Grid Morph) ──────────────────────────────────────────────
   A slot is one layout family: `mode` plus exactly the fields the GRID (and
   PATH) section renders for it — derived from the registry, so a future mode
   parameter becomes morphable automatically. Everything else — fit, orient,
   order, seed, padding, jitter, depth, effector, reveal, the path's anchor
   points — is authored ONCE on the base config and identical on both sides of
   a blend. Three exclusions are load-bearing: fit/orient flip keepScale /
   keepRotation booleans in setupMesh (a boolean cannot blend); a per-slot
   order/seed would reassign which member sits in which cell mid-morph; and
   path.points is ~2 KB of anchors the trim/progress/spread numbers already
   parameterise. */
const GRID_MODE_ENUMS = Object.freeze({
  rect: { fillOrder: GRID_FILL_ORDERS, alignLast: GRID_ALIGN_LAST },
  spiral: { spiralType: GRID_SPIRAL_TYPES },
  path: { pathSpacing: GRID_PATH_SPACING },
});

export const GRID_LAYOUT_KEYS_FOR_MODE = Object.freeze(Object.fromEntries(GRID_MODES.map((mode) => [
  mode,
  Object.freeze([
    ...GRID_KF_FIELDS
      .filter((f) => (f.group === 'Grid' || f.group === 'Path') && f.modes && f.modes.includes(mode))
      .map((f) => f.key),
    ...Object.keys(GRID_MODE_ENUMS[mode] || {}),
  ]),
])));

/** Build a clean slot for `mode`, carrying every overlapping value from
 *  `source` (a config or another slot) and defaulting the rest — switching a
 *  slot's mode keeps its startAngle/margins/… wherever the two modes share. */
export function gridSlotForMode(mode, source = null) {
  const m = pick(mode, GRID_MODES, GRID_DEFAULTS.mode);
  const slot = { mode: m };
  for (const key of GRID_LAYOUT_KEYS_FOR_MODE[m]) {
    const allowed = GRID_MODE_ENUMS[m]?.[key];
    if (allowed) {
      slot[key] = pick(source?.[key], allowed, GRID_DEFAULTS[key]);
    } else {
      const meta = GRID_KF_FIELD_BY_KEY.get(key);
      let v = clamp(num(source?.[key], GRID_DEFAULTS[key]), meta.min, meta.max);
      if (GRID_INT_KEYS.has(key)) v = Math.round(v);
      slot[key] = v;
    }
  }
  return slot;
}

/** Clamp every slot to its mode's own fields and ranges; junk in, null out. */
export function sanitizeGridLayoutSlots(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    out.push(gridSlotForMode(s.mode, s));
    if (out.length >= GRID_MAX_LAYOUT_SLOTS) break;
  }
  return out.length ? out : null;
}

/** The slot's geometry spread over the base config — a complete, renderable
 *  config for one side of the blend. `overrides` are the frame's resolved
 *  `gr:` keyframe values: they re-apply LAST, so a keyframed radius stays
 *  continuous straight through a type change. */
export function slotConfig(base, slot, overrides = null) {
  if (!slot || typeof slot !== 'object') return base;
  const cfg = { ...base, ...slot };
  if (overrides) {
    for (const key of Object.keys(overrides)) cfg[key] = overrides[key];
  }
  return cfg;
}

/** The blend's shaping options, plucked off a config once per frame. */
export function gridMorphOf(config) {
  return {
    stagger: config.morphStagger,
    staggerBy: config.morphStaggerBy,
    ease: config.morphEase,
    arc: config.morphArc,
    spin: config.morphSpin,
    seed: config.seed,
  };
}

/**
 * Resolved `gr:<key>` keyframe values as a clamped { paramKey: value } map,
 * or null when the item carries no grid tracks.
 */
export function gridKfOverrides(kfValues) {
  if (!kfValues) return null;
  let out = null;
  for (const [trackKey, value] of Object.entries(kfValues)) {
    const paramKey = parseGridKfKey(trackKey);
    if (!paramKey || !Number.isFinite(Number(value))) continue;
    const meta = GRID_KF_FIELD_BY_KEY.get(paramKey);
    let v = clamp(Number(value), meta.min, meta.max);
    if (GRID_INT_KEYS.has(paramKey)) v = Math.round(v);
    if (!out) out = {};
    out[paramKey] = v;
  }
  return out;
}

/**
 * Merge resolved `gr:<key>` keyframe values over a config for one frame.
 * Returns the SAME object when the item carries no grid tracks, so an
 * un-animated grid never re-normalises (and never re-lays-out) per frame.
 */
export function applyGridParamKeyframes(config, kfValues) {
  const overrides = gridKfOverrides(kfValues);
  return overrides ? { ...config, ...overrides } : config;
}

/** Drop every grid track (used when a grid layer is ungrouped or converted). */
export function stripGridTracks(propertyKeyframes) {
  if (!propertyKeyframes) return null;
  let changed = false;
  const next = {};
  for (const [key, track] of Object.entries(propertyKeyframes)) {
    if (typeof key === 'string' && key.startsWith(GRID_KF_PREFIX)) { changed = true; continue; }
    next[key] = track;
  }
  return changed ? next : null;
}

const DEG2RAD = Math.PI / 180;
const TAU = Math.PI * 2;

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/* ── seeded randomness ──────────────────────────────────────────────────────
   The same hash the Distributor uses (`rand(seed, i)`), so a Scatter built there
   and a Scatter grid with the same seed shake out the same way. Every random in
   this module goes through it — nothing here may call Math.random(). */
export function gridRand(seed, i) {
  const x = Math.sin(num(seed, 0) * 999 + i * 127.1) * 43758.5453;
  return x - Math.floor(x);
}
// Signed −1..1, for jitter and directions.
const srand = (seed, i) => gridRand(seed, i) * 2 - 1;

/* ── facing a direction in 3D ───────────────────────────────────────────────
   A layer quad's face is its local +Z. objectMotionPath ships the +X version
   (eulerForObjectPathTangent, used for "aim along the path"); the sphere needs
   the +Z one, which is the same construction with a different cross product:
   q = (a × b, 1 + a·b) normalised, for a = +Z. Kept local so this module still
   imports nothing heavier than the two leaf helpers. */
// Quaternion → Euler XYZ, matching THREE.Euler.setFromRotationMatrix('XYZ') so a
// result can be written straight to mesh.rotation.
function eulerFromQuat(qx, qy, qz, qw) {
  const m11 = 1 - 2 * (qy * qy + qz * qz);
  const m12 = 2 * (qx * qy - qz * qw);
  const m13 = 2 * (qx * qz + qy * qw);
  const m22 = 1 - 2 * (qx * qx + qz * qz);
  const m23 = 2 * (qy * qz - qx * qw);
  const m32 = 2 * (qy * qz + qx * qw);
  const m33 = 1 - 2 * (qx * qx + qy * qy);
  const ry = Math.asin(clamp(m13, -1, 1));
  if (Math.abs(m13) < 0.9999999) {
    return { rx: Math.atan2(-m23, m33), ry, rz: Math.atan2(-m12, m11) };
  }
  return { rx: Math.atan2(m32, m22), ry, rz: 0 };
}

const quatMul = (a, b) => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
const quatConj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const quatAboutZ = (angle) => ({ x: 0, y: 0, z: Math.sin(angle / 2), w: Math.cos(angle / 2) });
const quatAxisAngle = (axis, angle) => {
  const l = Math.hypot(axis.x, axis.y, axis.z) || 1;
  const s = Math.sin(angle / 2) / l;
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angle / 2) };
};

// Rotate the card's face (its local +Z) onto `dir`. q = (a × b, 1 + a·b) for
// a = +Z, normalised — the same construction eulerForObjectPathTangent uses for +X.
function quatForFacing(dir) {
  const len = Math.hypot(num(dir?.x), num(dir?.y), num(dir?.z));
  if (!(len > 1e-9)) return { x: 0, y: 0, z: 0, w: 1 };
  const bx = num(dir.x) / len;
  const by = num(dir.y) / len;
  const bz = num(dir.z) / len;
  let qx = -by;
  let qy = bx;
  let qz = 0;
  let qw = 1 + bz;
  if (qw < 1e-7) { qx = 1; qy = 0; qz = 0; qw = 0; }   // exactly backwards: 180° about X
  const l = Math.hypot(qx, qy, qz, qw) || 1;
  return { x: qx / l, y: qy / l, z: qz / l, w: qw / l };
}

// Rotation matrix (columns = right, up, forward) → quaternion. Same branch
// structure as THREE.Quaternion.setFromRotationMatrix, so the result decomposes
// through eulerFromQuat into angles a mesh can be posed with directly.
function quatFromBasis(r, u, f) {
  const m11 = r.x; const m12 = u.x; const m13 = f.x;
  const m21 = r.y; const m22 = u.y; const m23 = f.y;
  const m31 = r.z; const m32 = u.z; const m33 = f.z;
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return { x: (m32 - m23) * s, y: (m13 - m31) * s, z: (m21 - m12) * s, w: 0.25 / s };
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return { x: 0.25 * s, y: (m12 + m21) / s, z: (m13 + m31) / s, w: (m32 - m23) / s };
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return { x: (m12 + m21) / s, y: 0.25 * s, z: (m23 + m32) / s, w: (m13 - m31) / s };
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return { x: (m13 + m31) / s, y: (m23 + m32) / s, z: 0.25 * s, w: (m21 - m12) / s };
}

// A full look-at: the card's face (+Z) aims at `dir` AND its top (+Y) follows
// `up`, which is what pins the ROLL. quatForFacing alone leaves the roll to fall
// out of the minimal rotation, so a card would not follow a lens that is itself
// rolled — and a rolled grid is exactly the case "Face screen" has to survive.
function quatLookAt(dir, up) {
  const fl = Math.hypot(num(dir?.x), num(dir?.y), num(dir?.z));
  if (!(fl > 1e-9)) return { x: 0, y: 0, z: 0, w: 1 };
  const f = { x: num(dir.x) / fl, y: num(dir.y) / fl, z: num(dir.z) / fl };
  const u0 = { x: num(up?.x, 0), y: num(up?.y, 1), z: num(up?.z, 0) };
  // right = up × forward
  let r = { x: u0.y * f.z - u0.z * f.y, y: u0.z * f.x - u0.x * f.z, z: u0.x * f.y - u0.y * f.x };
  const rl = Math.hypot(r.x, r.y, r.z);
  // Looking straight along `up`: nothing left to pin the roll to, so fall back to
  // the minimal rotation rather than producing a degenerate basis.
  if (!(rl > 1e-6)) return quatForFacing(dir);
  r = { x: r.x / rl, y: r.y / rl, z: r.z / rl };
  // up' = forward × right, already unit because f ⟂ r and both are unit.
  const u = { x: f.y * r.z - f.z * r.y, y: f.z * r.x - f.x * r.z, z: f.x * r.y - f.y * r.x };
  return quatFromBasis(r, u, f);
}

const vec3Or = (v, fallback) => {
  const x = Number(v?.x); const y = Number(v?.y); const z = Number(v?.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : fallback;
};

const normalizeOr = (v, fallback) => {
  const len = Math.hypot(v.x, v.y, v.z);
  return len > 1e-9 ? { x: v.x / len, y: v.y / len, z: v.z / len } : fallback;
};

function quatFromEulerXYZ(x, y, z) {
  const c1 = Math.cos(x / 2); const s1 = Math.sin(x / 2);
  const c2 = Math.cos(y / 2); const s2 = Math.sin(y / 2);
  const c3 = Math.cos(z / 2); const s3 = Math.sin(z / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}

/* ── Face screen ────────────────────────────────────────────────────────────
   A grid is a CONTAINER: its cells are drawn into one offscreen plate, and the
   plate is what carries a transform afterwards. Turning that plate can never be
   undone from inside it — a plate turned 90° has zero width on screen, so there
   is no per-cell rotation that brings the cells back.

   So the grid's OWN rotation is not applied to the plate at all. The Player
   films the private scene from a camera ORBITED by the inverse rotation, which
   is exactly equivalent to turning the arrangement in three dimensions, and
   hands the moved lens down here as `cameraPos` / `cameraUp`. "Face screen" is
   then simply "aim at that point", and it holds at any angle.

   What is left on the plate is whatever the grid INHERITS — the project camera's
   rig, and a parent layer's rotation — and that arrives as `viewRotation`. Cells
   pre-cancel it: exact for a roll about Z, and for a tilt about X/Y exact at the
   plate's centre and very close away from it, because the plate's own
   perspective compression is what the counter-rotation is undoing. */
function quatUndoView(viewRotation) {
  if (!viewRotation) return { x: 0, y: 0, z: 0, w: 1 };
  return quatConj(quatFromEulerXYZ(num(viewRotation.rx), num(viewRotation.ry), num(viewRotation.rz)));
}

/* ── easing ─────────────────────────────────────────────────────────────────
   The curve the editor plays for that name (appEases.js — the easing engine's
   families plus the app's own curves). It loads under bare node, so the reveal is
   testable and identical in the headless renderer. Hold steps; an unknown name
   plays linear. */
export function gridEase(easing, t) {
  const x = clamp01(num(t));
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (easing === TransitionEasing.HOLD) return 0;
  const fn = namedEase(easing);
  return fn ? fn(x) : x;
}

/* ── config normalisation ──────────────────────────────────────────────────── */

// Points are world pixels (the same space as item.motionPath), so they get a
// shape check rather than a numeric range.
function normalizePathPoints(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const vec = (v) => (v && [v.x, v.y, v.z].every((c) => Number.isFinite(Number(c)))
    ? { x: num(v.x), y: num(v.y), z: num(v.z) }
    : null);
  const points = [];
  for (const p of Array.isArray(raw.points) ? raw.points : []) {
    const base = vec(p);
    if (!base) continue;
    const hIn = vec(p.hIn);
    const hOut = vec(p.hOut);
    if (hIn) base.hIn = hIn;
    if (hOut) base.hOut = hOut;
    if (p.manual === true) base.manual = true;
    points.push(base);
  }
  if (points.length < 2) return null;
  return { points, closed: raw.closed === true };
}

// Driven-property amounts: an unknown key is junk (the registry is static and
// always loaded), and a present key IS the "on" switch — no parallel enabled flag
// to drift out of step with the value.
function normalizeGridFx(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const meta = GRID_FX_BY_KEY.get(key);
    if (!meta || !Number.isFinite(Number(value))) continue;
    out[key] = clamp(Number(value), meta.min, meta.max);
  }
  return out;
}

/** Fill in every missing field and clamp every present one. Always returns a
 *  complete, renderable config — callers never have to null-check a parameter. */
export function normalizeGridConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const D = GRID_DEFAULTS;
  const n = (key, lo, hi) => clamp(num(c[key], D[key]), lo, hi);
  return {
    version: GRID_CONFIG_VERSION,
    mode: pick(c.mode, GRID_MODES, D.mode),

    order: pick(c.order, GRID_ORDERS, D.order),
    seed: Math.round(clamp(num(c.seed, D.seed), 0, 999999)),
    fit: pick(c.fit, GRID_FITS, D.fit),
    cellPadding: n('cellPadding', 0, 45),
    cellScale: n('cellScale', 1, 400),
    cellSize: n('cellSize', 0, 200),
    orient: pick(c.orient, GRID_ORIENTS, D.orient),
    jitterPos: n('jitterPos', 0, 200),
    jitterRot: n('jitterRot', 0, 180),
    jitterScale: n('jitterScale', 0, 100),

    cols: Math.round(n('cols', 0, 24)),
    gapX: n('gapX', -50, 50),
    gapY: n('gapY', -50, 50),
    marginX: n('marginX', -45, 45),
    marginY: n('marginY', -45, 45),
    fillOrder: pick(c.fillOrder, GRID_FILL_ORDERS, D.fillOrder),
    rowOffset: n('rowOffset', -100, 100),
    colOffset: n('colOffset', -100, 100),
    alignLast: pick(c.alignLast, GRID_ALIGN_LAST, D.alignLast),

    radius: n('radius', 0, 120),
    radiusStagger: n('radiusStagger', -120, 120),
    rings: Math.round(n('rings', 1, 8)),
    ringSpacing: n('ringSpacing', -60, 60),
    startAngle: n('startAngle', -360, 360),
    sweep: n('sweep', 5, 360),
    spin: n('spin', -1440, 1440),

    spiralTurns: n('spiralTurns', -12, 12),
    spiralRadius: n('spiralRadius', 0, 120),
    spiralType: pick(c.spiralType, GRID_SPIRAL_TYPES, D.spiralType),

    waveAmp: n('waveAmp', -100, 100),
    waveFreq: n('waveFreq', 0, 8),
    wavePhase: n('wavePhase', -360, 360),

    twist: n('twist', -1440, 1440),

    scatterDepth: n('scatterDepth', 0, 3000),

    sphereRadius: n('sphereRadius', 0, 3000),
    sphereSpinY: n('sphereSpinY', -1440, 1440),
    sphereTiltX: n('sphereTiltX', -180, 180),

    path: normalizePathPoints(c.path),
    pathSpacing: pick(c.pathSpacing, GRID_PATH_SPACING, D.pathSpacing),
    // Path Progress runs past 100 on purpose: on a closed curve it wraps, which is
    // how you send the cells travelling round it.
    pathTrimStart: n('pathTrimStart', 0, 100),
    pathTrimEnd: n('pathTrimEnd', 0, 100),
    pathProgress: n('pathProgress', -400, 400),
    pathSpread: n('pathSpread', 1, 100),

    zDepth: n('zDepth', -6000, 6000),
    zAnchor: n('zAnchor', 0, 1),
    scaleBy: pick(c.scaleBy, GRID_SCALE_BY, D.scaleBy),
    scaleFront: n('scaleFront', -100, 400),
    scaleBack: n('scaleBack', -100, 400),
    cellRotateX: n('cellRotateX', -360, 360),
    cellRotateY: n('cellRotateY', -360, 360),
    cellRotateZ: n('cellRotateZ', -360, 360),
    scaleStagger: n('scaleStagger', -100, 100),
    rotateStaggerX: n('rotateStaggerX', -360, 360),
    rotateStaggerY: n('rotateStaggerY', -360, 360),
    rotateStaggerZ: n('rotateStaggerZ', -360, 360),
    staggerBackward: GRID_STAGGER_KEYS.reduce((out, key) => {
      if (c.staggerBackward?.[key] === true) out[key] = true;
      return out;
    }, {}),

    effector: pick(c.effector, GRID_EFFECTORS, D.effector),
    focusTarget: pick(c.focusTarget, GRID_FOCUS_TARGETS, D.focusTarget),
    focusIndex: n('focusIndex', -1000, 1000),
    focusFalloff: n('focusFalloff', 0.2, 200),
    focusShape: pick(c.focusShape, GRID_FOCUS_SHAPES, D.focusShape),
    focusMeasure: pick(c.focusMeasure, GRID_FOCUS_MEASURES, D.focusMeasure),
    focusRipples: Math.round(n('focusRipples', 1, 8)),
    focusWrap: c.focusWrap === true,
    showGuide: c.showGuide === true,
    proxSources: (Array.isArray(c.proxSources) ? c.proxSources : [])
      .filter((id) => typeof id === 'string' && id)
      .slice(0, GRID_MAX_PROX_SOURCES),
    proxRange: n('proxRange', 0, 8000),
    proxFalloff: n('proxFalloff', 0, 8000),
    proxShape: pick(c.proxShape, GRID_PROX_SHAPES, D.proxShape),
    proxCombine: pick(c.proxCombine, GRID_PROX_COMBINE, D.proxCombine),
    proxMeasure: pick(c.proxMeasure, GRID_PROX_MEASURES, D.proxMeasure),
    effectorInvert: c.effectorInvert === true,
    fx: normalizeGridFx(c.fx),

    revealPreset: pick(c.revealPreset, GRID_REVEAL_PRESETS, D.revealPreset),
    revealDuration: n('revealDuration', 0.05, 20),
    revealStagger: n('revealStagger', -2, 2),
    revealStaggerBy: pick(c.revealStaggerBy, GRID_STAGGER_BY, D.revealStaggerBy),
    revealEase: Object.values(TransitionEasing).includes(c.revealEase) ? c.revealEase : D.revealEase,
    revealOut: c.revealOut === true,

    layouts: sanitizeGridLayoutSlots(c.layouts),
    layoutMix: n('layoutMix', 0, GRID_MAX_LAYOUT_SLOTS - 1),
    morphStagger: n('morphStagger', 0, 0.9),
    morphStaggerBy: pick(c.morphStaggerBy, GRID_STAGGER_BY, D.morphStaggerBy),
    morphEase: Object.values(TransitionEasing).includes(c.morphEase) ? c.morphEase : D.morphEase,
    morphArc: n('morphArc', -600, 600),
    morphSpin: Math.round(n('morphSpin', -4, 4)),
  };
}

/** Columns the rect layout will actually use for `n` members. Exported so the
 *  panel can show "Auto (4)" instead of a bare 0. */
export function gridAutoCols(config, n) {
  const cfg = config?.version === GRID_CONFIG_VERSION ? config : normalizeGridConfig(config);
  if (cfg.cols > 0) return Math.min(cfg.cols, Math.max(1, n));
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, n))));
}

/* ── arc-length reparameterisation ──────────────────────────────────────────
   evaluateObjectMotionPath is PARAMETER-based: equal steps in t cover more
   ground on a straight run than round a tight corner, so cells bunch on the
   curves. Walk the curve densely once, accumulate real 3D distance (the path
   carries z), and invert that table to place cells at equal arc length. */
const ARC_SAMPLES = 400;

export function buildPathArcTable(path, samples = ARC_SAMPLES) {
  if (!path || !Array.isArray(path.points) || path.points.length < 2) return null;
  const ts = new Array(samples + 1);
  const cum = new Array(samples + 1);
  let prev = null;
  let total = 0;
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const hit = evaluateObjectMotionPath(path, t);
    if (!hit) return null;
    if (prev) {
      total += Math.hypot(
        hit.position.x - prev.x,
        hit.position.y - prev.y,
        hit.position.z - prev.z,
      );
    }
    prev = hit.position;
    ts[i] = t;
    cum[i] = total;
  }
  return { ts, cum, total };
}

/** Curve parameter (0–1) at arc-length fraction `u` (0–1). */
export function arcLengthToParam(table, u) {
  if (!table || !(table.total > 0)) return clamp01(u);
  const target = clamp01(u) * table.total;
  const { cum, ts } = table;
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < target) lo = mid + 1; else hi = mid;
  }
  if (lo === 0) return ts[0];
  const span = cum[lo] - cum[lo - 1];
  const frac = span > 1e-9 ? (target - cum[lo - 1]) / span : 0;
  return ts[lo - 1] + (ts[lo] - ts[lo - 1]) * frac;
}

/* ── member ordering ────────────────────────────────────────────────────────
   Which member lands in which cell. Cell 0 is the topmost channel, matching the
   Distributor's convention (a Row reads left-to-right down the stack). */
function orderRanks(order, members, seed) {
  const n = members.length;
  const idx = members.map((_, i) => i);
  if (order === 'reverse') idx.reverse();
  else if (order === 'name') {
    idx.sort((a, b) => String(members[a]?.name || '').localeCompare(String(members[b]?.name || ''))
      || a - b);
  } else if (order === 'random') {
    idx.sort((a, b) => gridRand(seed, a) - gridRand(seed, b));
  }
  // rank[memberIndex] = cell index
  const rank = new Array(n);
  idx.forEach((memberIndex, cellIndex) => { rank[memberIndex] = cellIndex; });
  return rank;
}

/* ── the layouts ────────────────────────────────────────────────────────────
   Each returns cells in CELL order: { x, y, z } in composition pixels measured
   from the frame centre (+x right, +y UP — canonical THREE space), plus the cell
   box `w`/`h` in pixels, and the stagger inputs `ring` / `angle`. */

/* The identity layout: each cell IS the member's own stored position.
   A grid is a container whose inner scene is the composition itself, so a
   member's local PRS is already in the grid's own space when the grid sits at
   the origin — which is exactly where buildGridFromSelection puts it. Read
   through localPrs (rather than panX/panY straight off the item) so a member
   riding a motion path reports where it is actually drawn.

   Only POSITION is taken. Rotation and scale are already the member's own under
   the default Orientation: Forward + Fit: Keep (keepRotation / keepScale), which
   is why a freshly grouped grid changes nothing on screen at all. */
function layoutCurrent(cfg, n, members, W, H) {
  const cells = [];
  for (let i = 0; i < n; i += 1) {
    const item = members[i]?.item || null;
    // No item (an empty cell, or a caller that passes bare { id, name }): the
    // origin is the only honest answer.
    const home = item ? localPrs(item, null, W, H) : null;
    cells.push({
      x: home ? home.px : 0,
      y: home ? home.py : 0,
      z: home ? home.pz : 0,
      w: 0,
      h: 0,
      ring: 0,
      runT: n === 1 ? 0 : i / (n - 1),
    });
  }
  return cells;
}

function layoutRect(cfg, n, W, H) {
  const cols = gridAutoCols(cfg, n);
  const rows = Math.max(1, Math.ceil(n / cols));
  const usableW = (W * (100 - 2 * cfg.marginX)) / 100;
  const usableH = (H * (100 - 2 * cfg.marginY)) / 100;
  const gapX = (W * cfg.gapX) / 100;
  const gapY = (H * cfg.gapY) / 100;
  const cellW = Math.max(1, (usableW - gapX * (cols - 1)) / cols);
  const cellH = Math.max(1, (usableH - gapY * (rows - 1)) / rows);
  const pitchX = cellW + gapX;
  const pitchY = cellH + gapY;
  // Left/top edge of the grid, in centre-origin pixels.
  const originX = -usableW / 2 + cellW / 2;
  const originY = usableH / 2 - cellH / 2;

  const cells = [];
  for (let i = 0; i < n; i += 1) {
    let c;
    let r;
    if (cfg.fillOrder === 'col') {
      r = i % rows;
      c = Math.floor(i / rows);
    } else {
      r = Math.floor(i / cols);
      c = i % cols;
      // Boustrophedon: every other row runs backwards, so a stagger reads as one
      // continuous snake instead of jumping back to the left edge each row.
      if (cfg.fillOrder === 'boustrophedon' && r % 2 === 1) c = cols - 1 - c;
    }
    // The final row is usually short. Centre it unless the user asked for a
    // ragged (start-aligned) edge.
    let shiftX = 0;
    if (cfg.fillOrder !== 'col' && cfg.alignLast === 'center' && r === rows - 1) {
      const inLastRow = n - (rows - 1) * cols;
      if (inLastRow > 0 && inLastRow < cols) shiftX = ((cols - inLastRow) * pitchX) / 2;
    }
    // Brick / honeycomb offsets on alternate rows and columns.
    const brickX = (r % 2 === 1) ? (cfg.rowOffset / 100) * pitchX : 0;
    const brickY = (c % 2 === 1) ? (cfg.colOffset / 100) * pitchY : 0;

    cells.push({
      x: originX + c * pitchX + shiftX + brickX,
      y: originY - r * pitchY - brickY,
      z: 0,
      w: cellW,
      h: cellH,
      ring: r,
      tAngle: 0,
    });
  }
  return cells;
}

// Split n across `rings` concentric rings, weighted by each ring's radius so the
// outer ones hold more (an even split leaves the inner ring visibly crowded).
// Largest-remainder apportionment, so the counts are deterministic and sum to n.
function ringCounts(n, rings, radii) {
  if (rings <= 1) return [n];
  const weights = radii.map((r) => Math.max(0.35, Math.abs(r)));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const exact = weights.map((w) => (n * w) / total);
  const counts = exact.map((v) => Math.max(1, Math.floor(v)));
  let used = counts.reduce((a, b) => a + b, 0);
  // Too many (n < rings) — trim from the innermost rings, which are smallest.
  for (let i = 0; used > n && i < counts.length; i += 1) {
    while (counts[i] > 0 && used > n) { counts[i] -= 1; used -= 1; }
  }
  // Hand the leftovers to the rings with the largest fractional part.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  let k = 0;
  while (used < n) {
    counts[order[k % order.length].i] += 1;
    used += 1;
    k += 1;
  }
  return counts;
}

function layoutRadial(cfg, n, W, H) {
  const rings = Math.max(1, Math.min(cfg.rings, n));
  const radii = Array.from({ length: rings }, (_, r) => ((cfg.radius + r * cfg.ringSpacing) / 100) * H);
  const counts = ringCounts(n, rings, radii);
  const full = cfg.sweep >= 359.999;
  const stagger = (cfg.radiusStagger / 100) * H;
  const cells = [];
  for (let r = 0; r < rings; r += 1) {
    const k = counts[r];
    const R = radii[r];
    for (let j = 0; j < k; j += 1) {
      // A full circle divides by k (the ends meet); an arc divides by k−1 so the
      // first and last cells sit exactly on the sweep's edges.
      const f = full ? j / Math.max(1, k) : (k === 1 ? 0.5 : j / (k - 1));
      const deg = cfg.startAngle + cfg.spin + f * cfg.sweep;
      const a = deg * DEG2RAD;
      // Each successive cell steps out (or in, when negative) by the stagger,
      // so the ring walks its radius point by point — one end sits exactly on
      // Radius and the run coils away from it, like AE's cloner stagger.
      const sj = cfg.staggerBackward?.radiusStagger ? (k - 1 - j) : j;
      const Rj = R + sj * stagger;
      cells.push({
        x: Math.cos(a) * Rj,
        y: -Math.sin(a) * Rj,  // panel angles run clockwise; THREE y is up
        z: 0,
        w: 0,
        h: 0,
        ring: r,
      });
    }
  }
  return cells;
}

function layoutSpiral(cfg, n, W, H) {
  const R = (cfg.spiralRadius / 100) * H;
  const cells = [];
  for (let i = 0; i < n; i += 1) {
    let a;
    let r;
    if (cfg.spiralType === 'archimedean') {
      const t = n === 1 ? 0 : i / (n - 1);
      a = (cfg.startAngle + cfg.spin + t * cfg.spiralTurns * 360) * DEG2RAD;
      r = R * t;
    } else {
      // Phyllotaxis (sunflower): the golden angle spreads points with no radial
      // spokes, which is why it stays legible at any count.
      a = (cfg.startAngle + cfg.spin) * DEG2RAD + i * 137.508 * DEG2RAD * (cfg.spiralTurns >= 0 ? 1 : -1);
      r = R * Math.sqrt(n === 1 ? 0 : i / (n - 1));
    }
    cells.push({
      x: Math.cos(a) * r,
      y: -Math.sin(a) * r,
      z: 0,
      w: 0,
      h: 0,
      ring: Math.round((r / Math.max(1, R)) * 4),
      runT: n === 1 ? 0 : i / (n - 1),
    });
  }
  return cells;
}

function layoutWave(cfg, n, W, H) {
  const usableW = (W * (100 - 2 * cfg.marginX)) / 100;
  const amp = (cfg.waveAmp / 100) * H;
  const cells = [];
  for (let i = 0; i < n; i += 1) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const phase = t * TAU * cfg.waveFreq + cfg.wavePhase * DEG2RAD;
    // Tangent of the sine, so "Orient to path" rides the crest.
    const slope = Math.cos(phase) * TAU * cfg.waveFreq * amp;
    cells.push({
      x: -usableW / 2 + usableW * t,
      y: Math.sin(phase) * amp,
      z: 0,
      w: 0,
      h: 0,
      ring: 0,
      tAngle: Math.atan2(slope, Math.max(1, usableW / Math.max(1, n - 1))),
      runT: t,
    });
  }
  return cells;
}

function layoutScatter(cfg, n, W, H) {
  const usableW = (W * (100 - 2 * cfg.marginX)) / 100;
  const usableH = (H * (100 - 2 * cfg.marginY)) / 100;
  const cells = [];
  for (let i = 0; i < n; i += 1) {
    cells.push({
      x: (gridRand(cfg.seed, i * 3) - 0.5) * usableW,
      y: (gridRand(cfg.seed, i * 3 + 1) - 0.5) * usableH,
      z: srand(cfg.seed, i * 3 + 2) * cfg.scatterDepth,
      w: 0,
      h: 0,
      ring: 0,
      tAngle: gridRand(cfg.seed, i * 3 + 7) * TAU,
    });
  }
  return cells;
}

function layoutSphere(cfg, n) {
  // Fibonacci sphere: the only distribution that stays even at every count
  // without a special case for the poles.
  const R = cfg.sphereRadius;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const spin = cfg.sphereSpinY * DEG2RAD;
  const tilt = cfg.sphereTiltX * DEG2RAD;
  const cells = [];
  for (let i = 0; i < n; i += 1) {
    const yUnit = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
    const ringR = Math.sqrt(Math.max(0, 1 - yUnit * yUnit));
    const theta = golden * i + spin;
    let x = Math.cos(theta) * ringR;
    let y = yUnit;
    let z = Math.sin(theta) * ringR;
    // Tilt about the world X axis, so the poles lean toward the viewer.
    const cy = Math.cos(tilt);
    const sy = Math.sin(tilt);
    const y2 = y * cy - z * sy;
    const z2 = y * sy + z * cy;
    y = y2; z = z2;
    cells.push({
      x: x * R,
      y: y * R,
      z: z * R,
      w: 0,
      h: 0,
      ring: Math.round(clamp01((yUnit + 1) / 2) * 4),
      // Outward normal — "Orient to centre" turns each card to face it.
      normal: { x, y, z },
      // The shell's own depth, kept out of the shared zDepth spread so both can
      // be used at once.
      sphereDepth: true,
    });
  }
  return cells;
}

function layoutPath(cfg, n) {
  const path = cfg.path;
  if (!path) return null;
  const table = cfg.pathSpacing === 'arc' ? buildPathArcTable(path) : null;
  // Trim carves the usable stretch out of the whole curve; the cells then occupy
  // `spread` of THAT stretch, starting `progress` into it. Progress is the knob
  // to animate — on a closed curve it wraps, so the cells travel round forever.
  const lo = Math.min(cfg.pathTrimStart, cfg.pathTrimEnd) / 100;
  const hi = Math.max(cfg.pathTrimStart, cfg.pathTrimEnd) / 100;
  const span = Math.max(1e-4, hi - lo);
  const spread = cfg.pathSpread / 100;
  const progress = cfg.pathProgress / 100;
  const cells = [];
  for (let i = 0; i < n; i += 1) {
    // A closed path divides by n (the ends meet); an open one by n−1 so the first
    // and last cells land on the endpoints.
    const f = path.closed
      ? i / Math.max(1, n)
      : (n === 1 ? 0.5 : i / (n - 1));
    let local = progress + f * spread;
    local = path.closed ? ((local % 1) + 1) % 1 : clamp01(local);
    const u = lo + local * span;
    const t = table ? arcLengthToParam(table, u) : u;
    const hit = evaluateObjectMotionPath(path, t);
    if (!hit) return null;
    const aim = eulerForObjectPathTangent(hit.tangent);
    cells.push({
      x: hit.position.x,
      y: hit.position.y,
      z: hit.position.z,
      w: 0,
      h: 0,
      ring: 0,
      tAngle: Math.atan2(hit.tangent.y, hit.tangent.x),
      aim,
      tan: hit.tangent,
      runT: f,
    });
  }
  return cells;
}

/* ── the auto cell box ──────────────────────────────────────────────────────
   Only the rect layout produces a cell box on its own. Everything else needs a
   size. It is a function of the COUNT and the frame alone — deliberately not of
   the arrangement's spread: growing a ring's radius moves the cards apart, it
   must not make them bigger. (An earlier density-based version rescaled every
   member whenever radius/spacing/sphere size changed — scale is its own
   property.) Cell size and Cell scale stay the explicit overrides. */
function autoCellSize(cfg, cells, n, W, H) {
  if (cfg.cellSize > 0) {
    const side = (cfg.cellSize / 100) * H;
    return { w: side, h: side };
  }
  if (n <= 1) return { w: Math.min(W, H) * 0.6, h: Math.min(W, H) * 0.6 };
  const side = Math.min(W, H) / Math.max(1, Math.ceil(Math.sqrt(n)));
  const lo = Math.min(W, H) * 0.04;
  const hi = Math.min(W, H) * 1.2;
  return { w: clamp(side, lo, hi), h: clamp(side, lo, hi) };
}

/* ── per-cell reveal ────────────────────────────────────────────────────────
   Not keyframes: a pure function of the grid item's own progress, staggered by
   index / ring / distance / seeded random. Same shape as the split-text reveal
   already in the Player (computeSplitProgress). */
function staggerRanks(cfg, cells, n) {
  const key = new Array(n);
  for (let i = 0; i < n; i += 1) {
    if (cfg.revealStaggerBy === 'ring') key[i] = cells[i].ring;
    else if (cfg.revealStaggerBy === 'distance') key[i] = Math.hypot(cells[i].x, cells[i].y, cells[i].z);
    else if (cfg.revealStaggerBy === 'random') key[i] = gridRand(cfg.seed + 77, i);
    else key[i] = i;
  }
  if (cfg.revealStaggerBy === 'index') return key;
  // Rank rather than raw value, so the stagger step stays in seconds whatever
  // the units of the sort key are. Ties share a rank — a whole ring pops at once.
  const sorted = [...new Set(key)].sort((a, b) => a - b);
  const rankOf = new Map(sorted.map((v, i) => [v, i]));
  return key.map((v) => rankOf.get(v));
}

// Where a cell starts its entrance, as a world-pixel offset from its final spot,
// plus its starting scale/rotation. Returned as `from`; the reveal lerps it out.
function revealFrom(preset, cell, cfg, i, W, H) {
  const zero = { dx: 0, dy: 0, scale: 1, rot: 0, opacity: 1 };
  switch (preset) {
    case 'fade':
      return { ...zero, opacity: 0 };
    case 'pop':
      return { ...zero, scale: 0.2, opacity: 0 };
    case 'rise':
      return { ...zero, dy: -Math.max(cell.h, H * 0.12) * 0.9, opacity: 0 };
    case 'spin':
      return { ...zero, scale: 0.3, rot: -180 * DEG2RAD, opacity: 0 };
    case 'flyCenter':
      // Toward the frame centre: the cell converges on its cell from the middle.
      return { ...zero, dx: -cell.x, dy: -cell.y, scale: 0.6, opacity: 0 };
    case 'flyEdge': {
      // Out through the nearest frame edge, so nothing crosses the composition.
      const left = cell.x + W / 2;
      const right = W / 2 - cell.x;
      const top = H / 2 - cell.y;
      const bottom = cell.y + H / 2;
      const min = Math.min(left, right, top, bottom);
      if (min === left) return { ...zero, dx: -(left + cell.w), opacity: 0 };
      if (min === right) return { ...zero, dx: right + cell.w, opacity: 0 };
      if (min === top) return { ...zero, dy: top + cell.h, opacity: 0 };
      return { ...zero, dy: -(bottom + cell.h), opacity: 0 };
    }
    case 'flyRandom': {
      const a = gridRand(cfg.seed + 31, i) * TAU;
      const d = Math.hypot(W, H) * 0.6;
      return { ...zero, dx: Math.cos(a) * d, dy: Math.sin(a) * d, rot: srand(cfg.seed + 53, i) * 0.6, opacity: 0 };
    }
    default:
      return zero;
  }
}

/* ── effectors ─────────────────────────────────────────────────────────────
   Both return one 0–1 number per cell. Everything downstream is identical,
   which is exactly why only one may be live: they are two answers to the same
   question. */

// An animatable cell index with a falloff around it.
function focusInfluence(cfg, cells) {
  const n = cells.length;
  // First / Last / Centre follow the member count, so the focus needs no
  // retuning when layers come and go; By index stays the animatable number.
  const focus = cfg.focusTarget === 'first' ? 0
    : cfg.focusTarget === 'last' ? n - 1
      : cfg.focusTarget === 'center' ? (n - 1) / 2
        : cfg.focusIndex;
  const anchor = cells[Math.round(clamp(focus, 0, n - 1))] || cells[0];
  const unit = Math.max(1, anchor.w || 1);
  return cells.map((cell, i) => {
    let d;
    if (cfg.focusMeasure === 'row') d = Math.abs(cell.ring - anchor.ring);
    else if (cfg.focusMeasure === 'column') d = Math.abs(i - Math.round(focus));
    else if (cfg.focusMeasure === 'distance') d = Math.hypot(cell.x - anchor.x, cell.y - anchor.y, cell.z - anchor.z) / unit;
    else {
      d = Math.abs(i - focus);
      // A ring has no ends, so the wave should not stop at the seam.
      if (cfg.focusWrap) d = Math.min(d, n - d);
    }
    const u = clamp01(1 - d / Math.max(1e-4, cfg.focusFalloff));
    if (cfg.focusShape === 'linear') return u;
    if (cfg.focusShape === 'step') return u > 0 ? 1 : 0;
    if (cfg.focusShape === 'ripple') {
      // A decaying wave, so the focus throws rings instead of one bump.
      const w = Math.cos(clamp01(d / Math.max(1e-4, cfg.focusFalloff)) * Math.PI * cfg.focusRipples);
      return u * (0.5 + 0.5 * w);
    }
    return u * u * (3 - 2 * u);
  });
}

// Distance to referenced layers. `sources` are already in the GRID's own local
// space (the caller converts, because only it knows the grid's world transform).
function proximityInfluence(cfg, cells, sources) {
  const live = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (!live.length) return cells.map(() => 0);
  return cells.map((cell) => {
    const vals = live.map((s) => {
      const dx = cell.x - s.x;
      const dy = cell.y - s.y;
      const dz = cell.z - s.z;
      const d = cfg.proxMeasure === 'x' ? Math.abs(dx)
        : cfg.proxMeasure === 'y' ? Math.abs(dy)
          : cfg.proxMeasure === '3d' ? Math.hypot(dx, dy, dz)
            : Math.hypot(dx, dy);
      if (d <= cfg.proxRange) return 1;
      const u = clamp01(1 - (d - cfg.proxRange) / Math.max(1, cfg.proxFalloff));
      if (cfg.proxShape === 'linear') return u;
      if (cfg.proxShape === 'sharp') return u * u;
      return u * u * (3 - 2 * u);
    });
    if (cfg.proxCombine === 'add') return clamp01(vals.reduce((a, b) => a + b, 0));
    if (cfg.proxCombine === 'average') return vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.max(...vals);
  });
}

// "Look at": the angle from a cell to its NEAREST source, in canonical radians.
function nearestSourceAngle(cell, sources) {
  let best = null;
  let bd = Infinity;
  for (const s of sources) {
    const d = Math.hypot(cell.x - s.x, cell.y - s.y);
    if (d < bd) { bd = d; best = s; }
  }
  return best ? Math.atan2(best.y - cell.y, best.x - cell.x) : 0;
}

/* ── the entry point ────────────────────────────────────────────────────────
 *
 * @param {object} config   the item's gridConfig (raw or normalized)
 * @param {Array}  members  [{ id, name, item }] in CHANNEL order (index 0 = cell
 *   0). `item` is the member's own timeline item; only the 'current' layout
 *   reads it, for the position the layer already has.
 * @param {object} opts     { W, H, progress, duration }
 * @returns {Array} one entry per member, index-aligned with `members`:
 *   { index, cellIndex, prs, cellW, cellH, fit, opacity, ring, dist }
 *   `prs` is canonical THREE-space PRS; `cellW`/`cellH` are the fit target in
 *   composition pixels (the caller resolves the media's own content rect, which
 *   is only known once the texture is bound — see setupMesh).
 */
export function gridCellPoses(config, members, opts = {}) {
  const cfg = config?.version === GRID_CONFIG_VERSION ? config : normalizeGridConfig(config);
  const list = Array.isArray(members) ? members : [];
  const n = list.length;
  if (n === 0) return [];

  const W = num(opts.W, 1920) || 1920;
  const H = num(opts.H, 1080) || 1080;
  const duration = Math.max(0.001, num(opts.duration, 0));
  const progress = clamp01(num(opts.progress, 1));
  // The rotation the plate is STILL seen through — the project camera's rig and
  // anything the grid is parented to. (The grid's own rotation is not in here:
  // it turns the arrangement instead, via the orbited lens below.)
  const qUndoView = quatUndoView(opts.viewRotation);
  // How far in front of the lens a cell may come. Past the camera it would vanish
  // or turn inside out, and even well short of it the magnification runs away
  // (a cell at 90 % of the distance is drawn ten times its size). The cap keeps a
  // big Z push dramatic instead of broken; the fallback matches the Player's own
  // framing formula, a 28° lens that fits the composition height exactly.
  const camZ = Number.isFinite(Number(opts.cameraZ)) && Number(opts.cameraZ) > 0
    ? Number(opts.cameraZ)
    : (H / 2) / Math.tan((28 * DEG2RAD) / 2);
  const maxZ = camZ * 0.72;
  // Where the lens is IN THE GRID'S OWN SPACE, and which way is up for it. A grid
  // the user has turned hands us a camera that has swung off the Z axis by the
  // inverse of that rotation — see the Face screen note above. Unturned, this is
  // the plain (0, 0, camZ) looking down −Z that it always was.
  const camPos = vec3Or(opts.cameraPos, { x: 0, y: 0, z: camZ });
  const camUp = vec3Or(opts.cameraUp, { x: 0, y: 1, z: 0 });
  // The lens's own forward axis. A posed project camera does not necessarily look
  // at the arrangement's origin (it can pan past it), so the caller supplies the
  // real axis; the fallback — looking at the origin — is exact for a neutral or
  // merely orbited lens.
  const camDir = opts.cameraDir
    ? normalizeOr(vec3Or(opts.cameraDir, { x: 0, y: 0, z: -1 }), { x: 0, y: 0, z: -1 })
    : normalizeOr({ x: -camPos.x, y: -camPos.y, z: -camPos.z }, { x: 0, y: 0, z: -1 });

  let cells = null;
  if (cfg.mode === 'current') cells = layoutCurrent(cfg, n, list, W, H);
  else if (cfg.mode === 'rect') cells = layoutRect(cfg, n, W, H);
  else if (cfg.mode === 'radial') cells = layoutRadial(cfg, n, W, H);
  else if (cfg.mode === 'spiral') cells = layoutSpiral(cfg, n, W, H);
  else if (cfg.mode === 'wave') cells = layoutWave(cfg, n, W, H);
  else if (cfg.mode === 'scatter') cells = layoutScatter(cfg, n, W, H);
  else if (cfg.mode === 'sphere') cells = layoutSphere(cfg, n);
  else if (cfg.mode === 'path') cells = layoutPath(cfg, n);
  // A path mode with no usable curve yet must still lay something out, or the
  // grid would vanish the moment the user switches mode and before they draw.
  if (!cells) cells = layoutRect(cfg, n, W, H);

  if (cfg.mode !== 'rect') {
    const auto = autoCellSize(cfg, cells, n, W, H);
    for (const cell of cells) { cell.w = auto.w; cell.h = auto.h; }
  } else if (cfg.cellSize > 0) {
    const side = (cfg.cellSize / 100) * H;
    for (const cell of cells) { cell.w = side; cell.h = side; }
  }

  // ── Depth ──
  // Spread the run through Z so a flat layout gains real perspective. zAnchor
  // picks which end sits on the camera plane (0.5 = the middle of the run), so
  // pushing depth doesn't shove the whole arrangement toward or away from the
  // lens. A sphere already carries its own z; this adds to it.
  if (cfg.zDepth !== 0 && n > 1) {
    for (let i = 0; i < cells.length; i += 1) {
      cells[i].z += ((i / (n - 1)) - cfg.zAnchor) * cfg.zDepth;
    }
  }

  // ── Scale by position (After Effects' Scale Front / Scale Back) ──
  // A percentage added at each end of the chosen axis, interpolated across it.
  // `depth` is the one that sells a 3D arrangement: the camera's own perspective
  // at a 28° lens only changes a cell's size by a few percent over a 600px shell,
  // which is why a sphere reads flat without this.
  const scaleAdj = new Array(n).fill(0);
  if (cfg.scaleBy !== 'off' && (cfg.scaleFront !== 0 || cfg.scaleBack !== 0) && n > 0) {
    const key = cells.map((cell, i) => {
      if (cfg.scaleBy === 'depth') return cell.z;
      if (cfg.scaleBy === 'distance') return -Math.hypot(cell.x, cell.y, cell.z);
      return -i;                       // 'index' — the first cell is the "front"
    });
    const lo = Math.min(...key);
    const hi = Math.max(...key);
    const span = hi - lo;
    for (let i = 0; i < n; i += 1) {
      // u = 1 at the near end, 0 at the far end.
      const u = span > 1e-6 ? (key[i] - lo) / span : 1;
      scaleAdj[i] = (cfg.scaleBack + (cfg.scaleFront - cfg.scaleBack) * u) / 100;
    }
  }

  // ── Effector ──
  // One influence number per cell, then every driven property is blended from
  // its normal value toward its effected value by it.
  const proxSources = Array.isArray(opts.proximitySources) ? opts.proximitySources.filter(Boolean) : [];
  let effect = null;
  if (cfg.effector === 'focus') effect = focusInfluence(cfg, cells);
  else if (cfg.effector === 'proximity' && proxSources.length) effect = proximityInfluence(cfg, cells, proxSources);
  if (effect && cfg.effectorInvert) effect = effect.map((v) => 1 - v);
  const fx = effect ? cfg.fx : null;
  // A Z push moves the cell before anything reads its depth, so it has to land
  // on the cell itself rather than on the pose.
  if (fx && Number.isFinite(fx.z)) {
    for (let i = 0; i < cells.length; i += 1) cells[i].z += fx.z * effect[i];
  }

  // Never let a cell reach the lens (see maxZ). Measured along the VIEW axis, so
  // it still holds once the grid is turned and the arrangement runs into depth —
  // a wall rotated 90° puts half its cells where its left edge used to be.
  // Unturned this reduces exactly to the old `z > camZ * 0.72` clamp.
  const minDepth = camZ - maxZ;
  for (let i = 0; i < cells.length; i += 1) {
    const c = cells[i];
    const depth = (c.x - camPos.x) * camDir.x + (c.y - camPos.y) * camDir.y + (c.z - camPos.z) * camDir.z;
    if (depth < minDepth) {
      const push = minDepth - depth;
      c.x += camDir.x * push;
      c.y += camDir.y * push;
      c.z += camDir.z * push;
    }
  }

  // Does the arrangement actually occupy depth? "Orient to centre" means one thing
  // for a flat ring (a clock face) and quite another for a shell (cards turned
  // outward), and whether the cells carry z is the only honest way to tell them apart.
  let maxAbsZ = 0;
  for (const cell of cells) maxAbsZ = Math.max(maxAbsZ, Math.abs(cell.z));
  const spatial = maxAbsZ > Math.min(W, H) * 0.02;

  // Uniform per-cell rotation — negated degrees, the layer Rotate fields' sign —
  // composed in each card's OWN frame on top of the Orientation result. Local
  // frame is the point: a Face-screen card tilts without losing its aim, and on
  // a sphere every card tilts relative to its own outward footing.
  const cellRotQ = (cfg.cellRotateX !== 0 || cfg.cellRotateY !== 0 || cfg.cellRotateZ !== 0)
    ? quatFromEulerXYZ(-cfg.cellRotateX * DEG2RAD, -cfg.cellRotateY * DEG2RAD, -cfg.cellRotateZ * DEG2RAD)
    : null;

  const ranks = staggerRanks(cfg, cells, n);
  const revealing = cfg.revealPreset !== 'none';
  const totalDelay = revealing ? Math.abs(cfg.revealStagger) * Math.max(0, Math.max(...ranks)) : 0;
  const t = progress * duration;

  const cellFor = orderRanks(cfg.order, list, cfg.seed);
  const out = new Array(n);

  for (let m = 0; m < n; m += 1) {
    const ci = cellFor[m];
    const cell = cells[ci];
    const pad = clamp01(cfg.cellPadding / 100);
    const cellW = Math.max(1, cell.w * (1 - 2 * pad));
    const cellH = Math.max(1, cell.h * (1 - 2 * pad));

    // Jitter is measured against the cell box, so it scales with the layout
    // instead of drifting out of it when the grid gets denser.
    const jx = (cfg.jitterPos / 100) * cell.w * srand(cfg.seed + 11, ci * 2);
    const jy = (cfg.jitterPos / 100) * cell.h * srand(cfg.seed + 11, ci * 2 + 1);
    const jr = cfg.jitterRot * DEG2RAD * srand(cfg.seed + 23, ci);
    const js = 1 + (cfg.jitterScale / 100) * srand(cfg.seed + 41, ci);

    // ── Orientation ──
    // Four modes, all falling out of the same per-cell pose the layout returned:
    //   forward — the grid does not touch rotation; the member keeps its own
    //             (signalled with keepRotation, resolved by the caller, which is
    //             the only place a member's local PRS is known)
    //   center  — the card's own +Y points AWAY from the arrangement's centre;
    //             on a sphere it faces outward along the surface normal
    //   screen  — forced flat to the camera, cancelling the member's own tilt
    //   path    — the card's +X follows the direction of travel
    // Rotation here is a real THREE Euler written straight to the mesh, so the
    // signs are NOT the panel's negated degrees.
    let rx = 0;
    let ry = 0;
    let rz = 0;
    // Outward radial direction, and the direction of travel through the cells.
    const nAng = Math.atan2(cell.y, cell.x);
    const tAng = Number.isFinite(cell.tAngle) ? cell.tAngle : nAng - Math.PI / 2;
    if (cfg.orient === 'path') {
      if (cell.aim) { rx = cell.aim.rx; ry = cell.aim.ry; rz = cell.aim.rz; }
      else rz = tAng;                       // 2D: +X along the tangent
    } else if (cfg.orient === 'screen' || cfg.orient === 'center') {
      // Where the lens is, seen from THIS cell, in the grid's own space — which
      // already accounts for however the user has turned the grid.
      const toCamera = { x: camPos.x - cell.x, y: camPos.y - cell.y, z: camPos.z - cell.z };
      let q;
      if (cfg.orient === 'screen') {
        q = quatLookAt(toCamera, camUp);
      } else if (cell.normal) {
        q = quatForFacing(cell.normal);       // a sphere knows its own outward normal
      } else if (spatial) {
        q = quatForFacing({ x: cell.x, y: cell.y, z: cell.z });
      } else {
        // Coplanar: pointing "away from the centre" would leave every card
        // edge-on, so a flat layout reads as a clock face instead — face the
        // viewer, roll the top outward.
        q = quatMul(quatLookAt(toCamera, camUp), quatAboutZ(nAng - Math.PI / 2));
      }
      // Cancel whatever the plate is still turned by (the camera rig, a parent),
      // so both of these mean the same thing wherever the grid ends up.
      const composed = quatMul(qUndoView, q);
      const e = eulerFromQuat(composed.x, composed.y, composed.z, composed.w);
      rx = e.rx; ry = e.ry; rz = e.rz;
    }

    // ── Twist (wave / spiral / path) ──
    // A roll about the direction of travel, spread over the run — cell i turns
    // by runT·twist about its own tangent, so 360° reads as one full ribbon
    // twist end to end. Grid-space axis, so it composes with any orientation.
    if (cfg.twist !== 0 && Number.isFinite(cell.runT)) {
      const axis = cell.tan || { x: Math.cos(tAng), y: Math.sin(tAng), z: 0 };
      const q = quatMul(quatAxisAngle(axis, cfg.twist * DEG2RAD * cell.runT), quatFromEulerXYZ(rx, ry, rz));
      const e = eulerFromQuat(q.x, q.y, q.z, q.w);
      rx = e.rx; ry = e.ry; rz = e.rz;
    }

    // Rotate staggers walk like the radial Radius stagger: one end untouched,
    // every next cell (in layout order) turning by another step — composed in
    // the card's OWN frame like the uniform Rotate X/Y/Z above them.
    const stepOf = (key) => (cfg.staggerBackward?.[key] ? (n - 1 - ci) : ci);
    const staggerRot = (cfg.rotateStaggerX !== 0 || cfg.rotateStaggerY !== 0 || cfg.rotateStaggerZ !== 0)
      ? quatFromEulerXYZ(
        -cfg.rotateStaggerX * stepOf('rotateStaggerX') * DEG2RAD,
        -cfg.rotateStaggerY * stepOf('rotateStaggerY') * DEG2RAD,
        -cfg.rotateStaggerZ * stepOf('rotateStaggerZ') * DEG2RAD)
      : null;
    if (cellRotQ || staggerRot) {
      let q = quatFromEulerXYZ(rx, ry, rz);
      if (cellRotQ) q = quatMul(q, cellRotQ);
      if (staggerRot) q = quatMul(q, staggerRot);
      const e = eulerFromQuat(q.x, q.y, q.z, q.w);
      rx = e.rx; ry = e.ry; rz = e.rz;
    }

    const reveal = revealing ? revealFrom(cfg.revealPreset, cell, cfg, ci, W, H) : null;
    let opacity = 1;
    let dx = 0;
    let dy = 0;
    let revScale = 1;
    let revRot = 0;
    if (reveal) {
      const delay = cfg.revealStagger >= 0
        ? cfg.revealStagger * ranks[ci]
        : Math.abs(cfg.revealStagger) * (Math.max(...ranks) - ranks[ci]);
      const pIn = gridEase(cfg.revealEase, clamp01((t - delay) / cfg.revealDuration));
      let pOut = 0;
      if (cfg.revealOut) {
        const outStart = duration - cfg.revealDuration - totalDelay + delay;
        pOut = gridEase(cfg.revealEase, clamp01((t - outStart) / cfg.revealDuration));
      }
      // presence: fully in, then fully out. The exit retraces the entrance, so a
      // cell that flew in from the left leaves the way it came.
      const k = (1 - pIn) + pOut;
      dx = reveal.dx * k;
      dy = reveal.dy * k;
      revScale = 1 + (reveal.scale - 1) * k;
      revRot = reveal.rot * k;
      opacity = clamp01(1 - (1 - reveal.opacity) * k);
    }

    // The effector's contribution for THIS cell.
    const k = effect ? effect[ci] : 0;
    let fxScale = 1;
    let fxRot = 0;
    let fxOpacity = 1;
    let cellFx = null;
    if (fx && k !== 0) {
      if (Number.isFinite(fx.scale)) fxScale = Math.max(0, 1 + (fx.scale / 100) * k);
      if (Number.isFinite(fx.rotate)) fxRot = fx.rotate * DEG2RAD * k;
      if (Number.isFinite(fx.opacity)) fxOpacity = clamp01(1 + (fx.opacity / 100) * k);
      if (Number.isFinite(fx.lookAt) && proxSources.length) {
        // Turn the card's own +X toward the nearest source, by the amount asked.
        fxRot += nearestSourceAngle(cell, proxSources) * k * (fx.lookAt / 100);
      }
      // Filter targets live on the clip material, so they travel back as deltas.
      for (const [key, amount] of Object.entries(fx)) {
        const meta = GRID_FX_BY_KEY.get(key);
        if (!meta || meta.kind !== 'filter' || !Number.isFinite(amount)) continue;
        if (!cellFx) cellFx = {};
        cellFx[key] = amount * k;
      }
    }

    const scale = Math.max(0, (cfg.cellScale / 100) * (1 + (cfg.scaleStagger / 100) * stepOf('scaleStagger')) * js * revScale * (1 + scaleAdj[ci]) * fxScale);
    out[m] = {
      index: m,
      cellIndex: ci,
      ring: cell.ring,
      dist: Math.hypot(cell.x, cell.y, cell.z),
      cellW,
      cellH,
      fit: cfg.fit,
      opacity: opacity * fxOpacity,
      // Per-cell filter deltas from the live effector, or null. The caller applies
      // them to the clip material after its own filters.
      fx: cellFx,
      effect: k,
      // The two escape hatches the grid cannot resolve on its own, because they
      // need the member's own local PRS (and, for the fit, its media size):
      // "Keep original size" leaves scale to the layer, "Forward" leaves rotation.
      keepScale: cfg.fit === 'none',
      keepRotation: cfg.orient === 'forward',
      prs: {
        px: cell.x + jx + dx,
        py: cell.y + jy + dy,
        pz: cell.z,
        rx,
        ry,
        rz: rz + jr + revRot + fxRot,
        sx: scale,
        sy: scale,
        sz: scale,
      },
    };
  }
  return out;
}

/* ── Grid Morph — blending two layouts' OUTPUT ──────────────────────────────
   You cannot interpolate the config ('rect' halfway to 'sphere' is not a
   layout), but gridCellPoses returns a fixed-length, index-aligned array —
   one entry per member, whatever the mode — so evaluating it twice and
   blending per cell is well-defined. And unlike shape paths, which needed
   resampling to make two point lists match, there is no correspondence
   problem at all: cell i of the rect IS cell i of the sphere by construction
   (order and seed are shared, so the member→cell map is identical on both
   sides). Look-dev: html/grid-morph.html — index correspondence plus stagger
   and a small arc reads as a fold, not a scramble.

   THE INVARIANT: blendCellPoses(A, B, 0) is exactly A and blendCellPoses(A,
   B, 1) is exactly B, for any stagger, arc or spin — sin(π·ti) vanishes at
   both ends and an integer turn lands back on itself. It is what makes an
   armed-but-unshaped Mix track free, and the first thing the tests lock down. */

const lerp = (a, b, t) => a + (b - a) * t;

// Shortest-arc spherical interpolation. Rotation must be slerped, never
// component-lerped: gridCellPoses produces rx/ry/rz by decomposing a
// quaternion, so lerping the components crosses the ±π seam and the gimbal
// branch in eulerFromQuat. This is correctness, not taste.
function quatSlerp(a, b, t) {
  let bx = b.x; let by = b.y; let bz = b.z; let bw = b.w;
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  // q and −q are the same rotation; take the near side.
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (cos > 0.9995) {
    const x = a.x + (bx - a.x) * t;
    const y = a.y + (by - a.y) * t;
    const z = a.z + (bz - a.z) * t;
    const w = a.w + (bw - a.w) * t;
    const l = Math.hypot(x, y, z, w) || 1;
    return { x: x / l, y: y / l, z: z / l, w: w / l };
  }
  const theta = Math.acos(clamp(cos, -1, 1));
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return { x: a.x * wa + bx * wb, y: a.y * wa + by * wb, z: a.z * wa + bz * wb, w: a.w * wa + bw * wb };
}

// One 0–1 rank per member, read off side A — the arrangement the eye is
// leaving. Same vocabulary as the reveal (GRID_STAGGER_BY); dense-ranked so a
// whole ring departs together, then normalised so the stagger maths is
// count-independent.
function morphStaggerRanks(posesA, staggerBy, seed) {
  const n = posesA.length;
  if (n < 2) return new Array(n).fill(0);
  const key = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = posesA[i];
    if (staggerBy === 'ring') key[i] = p.ring;
    else if (staggerBy === 'distance') key[i] = p.dist;
    else if (staggerBy === 'random') key[i] = gridRand(seed + 177, p.cellIndex);
    else key[i] = p.cellIndex;
  }
  const sorted = [...new Set(key)].sort((x, y) => x - y);
  const rankOf = new Map(sorted.map((v, i) => [v, i]));
  const maxRank = Math.max(1, sorted.length - 1);
  return key.map((v) => rankOf.get(v) / maxRank);
}

// Per-cell filter deltas, key-by-key with a missing side read as all-zero —
// otherwise a cell's blur would pop when only one side has effector output.
function lerpCellFx(a, b, t) {
  if (!a && !b) return null;
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    out[k] = lerp(num(a?.[k], 0), num(b?.[k], 0), t);
  }
  return out;
}

/**
 * Blend two index-aligned pose arrays (both from gridCellPoses, same members).
 * `morph` is gridMorphOf(config): { stagger, staggerBy, ease, arc, spin, seed }.
 */
export function blendCellPoses(A, B, t, morph = {}) {
  const tt = clamp01(num(t, 0));
  if (tt <= 0 || !B) return A;
  if (tt >= 1) return B;
  const n = Math.min(A.length, B.length);
  const stagger = clamp(num(morph.stagger, 0), 0, 0.95);
  const arc = num(morph.arc, 0);
  const spin = Math.round(num(morph.spin, 0));
  const ranks = morphStaggerRanks(A, morph.staggerBy, num(morph.seed, 0));
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = A[i];
    const b = B[i];
    const ti = gridEase(morph.ease || TransitionEasing.LINEAR,
      clamp01((tt - stagger * ranks[i]) / (1 - stagger)));
    // Exact endpoints — a cell that has not left yet IS side A's cell, and one
    // that has arrived IS side B's (a whole spin turn is the same rotation).
    if (ti <= 0) { out[i] = a; continue; }
    if (ti >= 1) { out[i] = b; continue; }

    let px = lerp(a.prs.px, b.prs.px, ti);
    let py = lerp(a.prs.py, b.prs.py, ti);
    const pz = lerp(a.prs.pz, b.prs.pz, ti);
    // Arc: displace the travelling cell along its radial direction, so a rect
    // opening into a ring bulges outward (negative implodes through the centre).
    if (arc) {
      const amt = Math.sin(Math.PI * ti) * arc;
      const len = Math.hypot(px, py);
      if (len > 1) {
        px += (px / len) * amt;
        py += (py / len) * amt;
      }
    }
    const q = quatSlerp(
      quatFromEulerXYZ(a.prs.rx, a.prs.ry, a.prs.rz),
      quatFromEulerXYZ(b.prs.rx, b.prs.ry, b.prs.rz),
      ti
    );
    const e = eulerFromQuat(q.x, q.y, q.z, q.w);

    out[i] = {
      index: a.index,
      cellIndex: a.cellIndex,
      ring: a.ring,
      dist: Math.hypot(px, py, pz),
      cellW: lerp(a.cellW, b.cellW, ti),
      cellH: lerp(a.cellH, b.cellH, ti),
      // fit / orient are shared config, so these agree on both sides — nothing
      // for setupMesh's booleans to snap over mid-blend.
      fit: a.fit,
      opacity: lerp(a.opacity, b.opacity, ti),
      fx: lerpCellFx(a.fx, b.fx, ti),
      effect: lerp(num(a.effect, 0), num(b.effect, 0), ti),
      keepScale: a.keepScale,
      keepRotation: a.keepRotation,
      prs: {
        px,
        py,
        pz,
        rx: e.rx,
        ry: e.ry,
        // Spin adds whole turns only, so ti = 1 lands back on B's rotation.
        rz: e.rz + spin * TAU * ti,
        sx: lerp(a.prs.sx, b.prs.sx, ti),
        sy: lerp(a.prs.sy, b.prs.sy, ti),
        sz: lerp(a.prs.sz, b.prs.sz, ti),
      },
    };
  }
  return out;
}

/**
 * The morph-aware entry point — same signature and return shape as
 * gridCellPoses, which it falls back to when the config has no layout slots.
 * At an integer mix only ONE layout is evaluated, so an un-morphing grid costs
 * exactly what it costs today.
 *
 * `opts.gridKfOverrides` (gridKfOverrides(kf), optional) re-applies the
 * frame's resolved `gr:` values over each slot's geometry, so a keyframed
 * parameter stays continuous straight through a type change.
 */
export function gridLayoutMixPoses(config, members, opts = {}) {
  const cfg = config?.version === GRID_CONFIG_VERSION ? config : normalizeGridConfig(config);
  const slots = cfg.layouts;
  if (!slots || !slots.length) return gridCellPoses(cfg, members, opts);
  const overrides = opts.gridKfOverrides || null;
  const top = slots.length - 1;
  const m = clamp(num(cfg.layoutMix, 0), 0, top);
  const i0 = Math.min(Math.floor(m), top);
  const t = m - i0;
  const A = gridCellPoses(slotConfig(cfg, slots[i0], overrides), members, opts);
  if (!(t > 0) || i0 >= top) return A;
  const B = gridCellPoses(slotConfig(cfg, slots[i0 + 1], overrides), members, opts);
  return blendCellPoses(A, B, t, gridMorphOf(cfg));
}

/* ── PRO gating ─────────────────────────────────────────────────────────────
   Grid Builder follows the established policy: free to build and play back in
   the preview, paywalled at the render — the same as PRO motion templates,
   Running Glow and Neon Glow. The check walks the WHOLE saved editor state,
   because a grid can sit inside a sequence (containsProGlowEffect does the same
   for the same reason). A grid with no members gates nothing: it draws nothing. */
export const GRID_IS_PRO = true;

export function containsProGridLayer(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (GRID_IS_PRO && value.mediaType === 'grid' && value.sequence?.channels?.some((ch) => ch?.items?.length)) {
    return true;
  }
  if (Array.isArray(value)) return value.some((entry) => containsProGridLayer(entry, seen));
  return Object.values(value).some((entry) => containsProGridLayer(entry, seen));
}

/* ── fit-to-cell ────────────────────────────────────────────────────────────
   The drawn content rect comes from the clip shader's fit-contain branch on
   uCanvasSize (the quad in px) and uResolution (the media in px) — the same
   maths, so a cell frames exactly what is painted rather than the quad around
   it. Kept here (rather than in the Player) so it is covered by the unit tests.

   `cover` returns a crop as well: the fraction of the content rect that stays
   visible, which the shader uses to keep a covering cell inside its own box. */
export function fitScaleForCell(fit, { contentW, contentH, cellW, cellH, localScale = 1 }) {
  const cw = Math.max(1e-6, num(contentW, 1));
  const chh = Math.max(1e-6, num(contentH, 1));
  const bw = Math.max(1e-6, num(cellW, 1));
  const bh = Math.max(1e-6, num(cellH, 1));
  if (fit === 'none') return { sx: localScale, sy: localScale, cropX: 1, cropY: 1 };
  if (fit === 'stretch') return { sx: bw / cw, sy: bh / chh, cropX: 1, cropY: 1 };
  if (fit === 'cover') {
    const s = Math.max(bw / cw, bh / chh);
    return {
      sx: s,
      sy: s,
      // Everything past the cell edge is cropped, so a covering cell can never
      // bleed over its neighbours.
      cropX: clamp01(bw / (cw * s)),
      cropY: clamp01(bh / (chh * s)),
    };
  }
  const s = Math.min(bw / cw, bh / chh);
  return { sx: s, sy: s, cropX: 1, cropY: 1 };
}
