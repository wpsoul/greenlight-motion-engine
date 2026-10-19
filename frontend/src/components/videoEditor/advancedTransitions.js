// Advanced transitions can own more than a geometry change. Keep their bundled
// resources in one registry so the picker, live player and exporter all read the
// same recipe instead of re-implementing preset-specific checks.
import { CAMERA_WHIP_PRESET, CAROUSEL_3D_PRESET, CIRCULAR_WIPE_PRESET, GLOW_STACK_PRESET, GRADIENT_MAP_PRESET, LOUVER_FLIP_PRESET, PIXEL_BLOCKS_PRESET, ZOOM_RULER_PRESET } from './builtinTransitionPackages.js';

/*
 * Fisheye and Wiggle are shared by both point-aimed transitions, so the schema
 * is built once here rather than copy-pasted into each. Both default to OFF —
 * they are looks you reach for, and a non-zero default would silently restyle
 * every project already using these transitions.
 *
 * Both ride the SAME time envelope as the blur and the RGB split, so everything
 * the transition does builds into the cut and falls away together.
 */
const timeProfileOptions = (inheritLabel) => Object.freeze([
  Object.freeze({ value: 'blur', label: inheritLabel }),
  Object.freeze({ value: 'velocity', label: 'Follow speed' }),
  Object.freeze({ value: 'peak', label: 'Peak at cut' }),
  Object.freeze({ value: 'constant', label: 'Constant' }),
]);

const fisheyeOptionDefaults = (centre) => Object.freeze({
  fisheye: 0,
  fisheyeProfile: 'blur',
  fisheyeModel: 'spherical',
  fisheyeCentre: centre,
  fisheyeFit: true,
});

// Like the RGB split's, the lens ceiling is a multiple of FISHEYE_K_MAX rather
// than a remap of it: an already-saved 80% must still look like 80%. Past 100%
// the shader's fold guard takes over, so the dome keeps bulging (and the pinch
// keeps squeezing) instead of turning the frame inside out.
const FISHEYE_FIELD_MAX = 200;

const fisheyeOptionFields = (pointLabel) => Object.freeze([
  Object.freeze({ type: 'section', key: 'sec-fisheye', label: 'Fisheye' }),
  Object.freeze({ key: 'fisheye', label: 'Amount', type: 'range', min: -FISHEYE_FIELD_MAX, max: FISHEYE_FIELD_MAX, step: 1, suffix: '%' }),
  Object.freeze({ key: 'fisheyeProfile', label: 'Over time', type: 'select', options: timeProfileOptions('Same as blur') }),
  Object.freeze({ key: 'fisheyeModel', label: 'Lens model', type: 'select', options: Object.freeze([
    Object.freeze({ value: 'spherical', label: 'Spherical' }),
    Object.freeze({ value: 'barrel', label: 'Barrel' }),
  ]) }),
  Object.freeze({ key: 'fisheyeCentre', label: 'Lens centre', type: 'select', options: Object.freeze([
    Object.freeze({ value: 'point', label: pointLabel }),
    Object.freeze({ value: 'frame', label: 'Frame centre' }),
  ]) }),
  Object.freeze({ key: 'fisheyeFit', label: 'Pin the corner', type: 'switch' }),
]);

/*
 * Exposure flash — the Transition Builder's fxFlash, offered on the two
 * point-aimed transitions under the same name and the same ceiling (200%, so a
 * hard blow-out stays reachable; the wash itself clamps at fully washed).
 *
 * It washes each lane's OWN pixels toward the colour rather than laying a card
 * over the frame: the two lanes are still cross-blending under it, and a card
 * would flatten that blend into a single opaque frame. Like the lens and the
 * tremble it rides the shared time envelope, so the blow-out builds into the
 * cut and falls away with everything else.
 */
const FLASH_OPTION_DEFAULTS = Object.freeze({
  flash: 0,
  flashColor: '#ffffff',
  flashProfile: 'blur',
});

const FLASH_OPTION_FIELDS = Object.freeze([
  Object.freeze({ type: 'section', key: 'sec-flash', label: 'Exposure Flash' }),
  Object.freeze({ key: 'flash', label: 'Strength', type: 'range', min: 0, max: 200, step: 5, suffix: '%' }),
  Object.freeze({ key: 'flashColor', label: 'Colour', type: 'color' }),
  Object.freeze({ key: 'flashProfile', label: 'Over time', type: 'select', options: timeProfileOptions('Same as blur') }),
]);

/*
 * Bloom — highlights leaking during the move, the third member of the optics
 * cluster (blur, lens, flash). Like the flash it washes each lane's OWN pixels
 * and rides the shared time envelope, so the leak builds into the cut and falls
 * away with everything else. Defaults to OFF like every option group here.
 */
const BLOOM_OPTION_DEFAULTS = Object.freeze({
  bloom: 0,
  bloomThreshold: 60,
  bloomRadius: 36,
  bloomProfile: 'blur',
});

const BLOOM_OPTION_FIELDS = Object.freeze([
  Object.freeze({ type: 'section', key: 'sec-bloom', label: 'Bloom' }),
  Object.freeze({ key: 'bloom', label: 'Strength', type: 'range', min: 0, max: 300, step: 5, suffix: '%' }),
  Object.freeze({ key: 'bloomThreshold', label: 'Threshold', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
  Object.freeze({ key: 'bloomRadius', label: 'Radius', type: 'range', min: 4, max: 120, step: 1, suffix: 'px' }),
  Object.freeze({ key: 'bloomProfile', label: 'Over time', type: 'select', options: timeProfileOptions('Same as blur') }),
]);

const WIGGLE_OPTION_DEFAULTS = Object.freeze({
  wiggle: 0,
  wiggleFreq: 14,
  wiggleRotate: 1.6,
  wiggleRough: 40,
  wiggleProfile: 'peak',
  wigglePeak: 50,
  wiggleSharp: 1.4,
  wiggleSeed: 7,
  wiggleShared: true,
});

const WIGGLE_OPTION_FIELDS = Object.freeze([
  Object.freeze({ type: 'section', key: 'sec-wiggle', label: 'Wiggle' }),
  Object.freeze({ key: 'wiggle', label: 'Amount', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
  Object.freeze({ key: 'wiggleFreq', label: 'Frequency', type: 'range', min: 1, max: 40, step: 0.5, suffix: 'hz' }),
  Object.freeze({ key: 'wiggleRotate', label: 'Rotation', type: 'range', min: 0, max: 8, step: 0.1, suffix: '°' }),
  Object.freeze({ key: 'wiggleRough', label: 'Roughness', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
  Object.freeze({ key: 'wiggleProfile', label: 'Over time', type: 'select', options: Object.freeze([
    Object.freeze({ value: 'peak', label: 'Swell into the cut' }),
    Object.freeze({ value: 'velocity', label: 'Follow speed' }),
    Object.freeze({ value: 'constant', label: 'Constant' }),
  ]) }),
  Object.freeze({ key: 'wigglePeak', label: 'Peak at', type: 'range', min: 5, max: 95, step: 1, suffix: '%' }),
  Object.freeze({ key: 'wiggleSharp', label: 'Swell shape', type: 'range', min: 0.3, max: 4, step: 0.1 }),
  Object.freeze({ key: 'wiggleSeed', label: 'Seed', type: 'range', min: 1, max: 99, step: 1 }),
  // A layer entrance/exit shakes ONE plate, so there is no second clip to agree
  // or disagree with — `crossOnly` keeps the control off the in/out inspector
  // rather than showing a switch that cannot do anything.
  Object.freeze({ key: 'wiggleShared', label: 'Both clips share it', type: 'switch', crossOnly: true }),
]);

// The RGB split's ceiling is a multiple of RGB_SPLIT_MAX, not a remap of it:
// raising the ceiling must not change what an already-saved 35% looks like.
const RGB_SPLIT_FIELD_MAX = 300;

/*
 * Blend & edges — shared by the point-aimed pair.
 *
 * The edge fill is per LANE. A push that flies the outgoing clip off frame
 * usually wants mirrored fill behind it, while the clip arriving from beyond
 * the edge often reads better with nothing out there at all (or the other way
 * round) — one setting driving both lanes could never say that. The incoming
 * control defaults to 'match', so a project saved before it existed keeps its
 * single Edges setting on both lanes and looks exactly as it always did.
 */
const EDGE_OPTION_DEFAULTS = Object.freeze({
  edgeMode: 'mirror',
  edgeModeIn: 'match',
  // Dead centre of the transition — where the crossfade has always sat.
  blendPoint: 50,
});

const EDGE_MODE_VALUES = Object.freeze([
  Object.freeze({ value: 'mirror', label: 'Mirror tile' }),
  Object.freeze({ value: 'none', label: 'No fill' }),
]);

const BLEND_EDGE_OPTION_FIELDS = Object.freeze([
  // An exit ignores the blend (it would read as an automatic fade-out on a
  // single layer), so the control is dropped from the Out slot.
  // 0 is a real setting, not a degenerate one: no window at all is a HARD CUT at
  // the blend point, both clips at full opacity right up to it. That is the whip
  // cut where the move alone carries the change, so the floor is 0, not 2%.
  Object.freeze({ key: 'blendWindow', label: 'Blend window', type: 'range', min: 0, max: 100, step: 1, suffix: '%', outHidden: true }),
  // Where that window sits. Early hands the cut to the incoming clip while it is
  // still travelling; late holds the outgoing one longer. The runtime keeps the
  // whole window inside the transition, so a blend can never be left unfinished
  // at the cut however far this is pushed.
  Object.freeze({ key: 'blendPoint', label: 'Blend point', type: 'range', min: 0, max: 100, step: 1, suffix: '%', outHidden: true }),
  // The lane is named only where both lanes exist. An entrance or an exit IS
  // one lane, so `slotLabels` puts the plain name back there.
  Object.freeze({
    key: 'edgeMode',
    label: 'Edges (out)',
    type: 'select',
    slotLabels: Object.freeze({ in: 'Edges', out: 'Edges' }),
    options: EDGE_MODE_VALUES,
  }),
  Object.freeze({
    key: 'edgeModeIn',
    label: 'Edges (in)',
    type: 'select',
    crossOnly: true,
    options: Object.freeze([
      Object.freeze({ value: 'match', label: 'Same as out' }),
      ...EDGE_MODE_VALUES,
    ]),
  }),
  Object.freeze({ key: 'tileFade', label: 'Tile fade', type: 'range', min: 0, max: 100, step: 5, suffix: '%' }),
]);

/*
 * Which fill a lane puts behind its empty edges.
 *
 * 'prev' is the outgoing clip and 'curr' the incoming one — the lane names the
 * runtime already uses, so an entrance (curr) and an exit (prev) read the same
 * answer as their side of the cross. The incoming lane falls back to the
 * outgoing setting whenever it has no opinion of its own: 'match', or anything
 * saved before the option existed.
 */
export function advancedTransitionEdgeMirror(options, lane = 'curr') {
  const shared = options?.edgeMode !== 'none';
  if (lane === 'prev') return shared;
  const incoming = options?.edgeModeIn;
  if (incoming === 'mirror') return true;
  if (incoming === 'none') return false;
  return shared;
}

/*
 * The directional built-ins (types.js DIRECTIONAL_TRANSITIONS): plain mesh moves
 * in gsapTransitions.js whose only option is the way they go. `plain` keeps them
 * out of the "advanced" kind in the catalog and titles the modal block "Options".
 * Labels for Push / Parallax / Slide are the old type names' last word, so a
 * former "Push Up" reads Push ▸ Up.
 */
const MOVE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'left', label: 'Left' }),
  Object.freeze({ value: 'right', label: 'Right' }),
  Object.freeze({ value: 'up', label: 'Up' }),
  Object.freeze({ value: 'down', label: 'Down' }),
]);
const directionalPreset = (description, options, defaultDirection) => Object.freeze({
  plain: true,
  description,
  optionDefaults: Object.freeze({ direction: defaultDirection }),
  optionFields: Object.freeze([
    Object.freeze({ key: 'direction', label: 'Direction', type: 'select', options }),
  ]),
});
const DIRECTIONAL_PRESETS = Object.freeze({
  Push: directionalPreset('Both clips travel together; the next one pushes the current one out', MOVE_OPTIONS, 'left'),
  Parallax: directionalPreset('The next clip slides in while the current one drifts back slower', MOVE_OPTIONS, 'left'),
  Wipe: directionalPreset('A hard edge sweeps across the frame', Object.freeze([
    Object.freeze({ value: 'leftToRight', label: 'Left → Right' }),
    Object.freeze({ value: 'rightToLeft', label: 'Right → Left' }),
    Object.freeze({ value: 'bottomToTop', label: 'Bottom → Top' }),
    Object.freeze({ value: 'topToBottom', label: 'Top → Bottom' }),
  ]), 'leftToRight'),
  // layer slots only: Left / Right = the edge it enters from and leaves by, Up / Down = the way it moves
  Slide: directionalPreset('The layer slides in from an edge, or out to it', MOVE_OPTIONS, 'left'),
});

export const ADVANCED_TRANSITION_PRESETS = Object.freeze({
  ...DIRECTIONAL_PRESETS,
  // ── Point-aimed pair ──────────────────────────────────────────────────────
  // Both put the same continuous move under the cut: the outgoing clip travels
  // one "step", the incoming starts one step behind and lands home, so the two
  // are never moving in opposite directions. What differs is the step — a scale
  // ratio for the zoom, a translation for the move — and both are aimed at a
  // point the user picks in the preview rather than the frame centre.
  'Advanced Zoom': Object.freeze({
    category: 'advanced',
    description: 'Both clips zoom through a point you choose, with rotation, radial blur, fisheye, exposure flash and camera shake',
    optionDefaults: Object.freeze({
      point: Object.freeze({ x: 50, y: 50 }),
      direction: 'in',
      zoomStrength: 100,
      rotation: 0,
      blurStrength: 0,
      blurProfile: 'velocity',
      rgbSplit: 0,
      ...fisheyeOptionDefaults('point'),
      ...FLASH_OPTION_DEFAULTS,
      ...BLOOM_OPTION_DEFAULTS,
      ...WIGGLE_OPTION_DEFAULTS,
      blendWindow: 26,
      tileFade: 35,
      ...EDGE_OPTION_DEFAULTS,
    }),
    optionFields: Object.freeze([
      Object.freeze({ key: 'point', label: 'Zoom point', type: 'point' }),
      Object.freeze({ key: 'direction', label: 'Direction', type: 'select', options: Object.freeze([
        Object.freeze({ value: 'in', label: 'Zoom in' }),
        Object.freeze({ value: 'out', label: 'Zoom out' }),
      ]) }),
      // Ceiling only — a saved 250% still reads as 250%. The lane is an
      // exponential ramp (growth = 1 + 0.55·strength), so a high value is a
      // deeper push through the point rather than a different move.
      Object.freeze({ key: 'zoomStrength', label: 'Zoom strength', type: 'range', min: 0, max: 2000, step: 5, suffix: '%' }),
      // The spin rides the SAME step the zoom does — the outgoing lane turns one
      // step and the incoming starts one step behind — so the pair is a single
      // screw motion through the point rather than a rotation laid over a zoom.
      // Positive is clockwise; the ceiling allows three full turns for a whip.
      Object.freeze({ key: 'rotation', label: 'Rotation', type: 'range', min: -1080, max: 1080, step: 5, suffix: '°' }),
      Object.freeze({ type: 'section', key: 'sec-blur', label: 'Radial blur' }),
      Object.freeze({ key: 'blurStrength', label: 'Blur strength', type: 'range', min: 0, max: 60, step: 0.5 }),
      Object.freeze({ key: 'blurProfile', label: 'Blur over time', type: 'select', options: Object.freeze([
        Object.freeze({ value: 'velocity', label: 'Follow speed' }),
        Object.freeze({ value: 'peak', label: 'Peak at cut' }),
        Object.freeze({ value: 'constant', label: 'Constant' }),
      ]) }),
      Object.freeze({ key: 'rgbSplit', label: 'RGB split', type: 'range', min: 0, max: RGB_SPLIT_FIELD_MAX, step: 1, suffix: '%' }),
      ...fisheyeOptionFields('Zoom point'),
      ...FLASH_OPTION_FIELDS,
      ...BLOOM_OPTION_FIELDS,
      ...WIGGLE_OPTION_FIELDS,
      Object.freeze({ type: 'section', key: 'sec-edges', label: 'Blend & edges' }),
      ...BLEND_EDGE_OPTION_FIELDS,
    ]),
  }),
  'Advanced Movement': Object.freeze({
    category: 'advanced',
    description: 'Both clips travel toward a point you choose, with directional blur, fisheye, exposure flash and camera shake',
    optionDefaults: Object.freeze({
      point: Object.freeze({ x: 92, y: 50 }),
      direction: 'to',
      travelStrength: 100,
      usePointDistance: false,
      travelMode: 'straight',
      travelPath: Object.freeze({ points: Object.freeze([]), shares: Object.freeze([]) }),
      pathSmooth: 65,
      perspective: 0,
      perspectiveMode: 'lean',
      perspectiveDepth: 1.8,
      perspectiveAxis: 'auto',
      perspectiveAttach: 'plate',
      perspectiveShade: 35,
      squeezeOpposite: false,
      blurStrength: 0,
      blurProfile: 'velocity',
      rgbSplit: 0,
      // A travelling shot's lens belongs to the camera, not to the thing it is
      // heading for, so this one centres on the frame by default.
      ...fisheyeOptionDefaults('frame'),
      ...FLASH_OPTION_DEFAULTS,
      ...BLOOM_OPTION_DEFAULTS,
      ...WIGGLE_OPTION_DEFAULTS,
      squeeze: 8,
      blendWindow: 18,
      tileFade: 45,
      ...EDGE_OPTION_DEFAULTS,
    }),
    optionFields: Object.freeze([
      Object.freeze({ key: 'point', label: 'Target point', type: 'point' }),
      Object.freeze({ key: 'direction', label: 'Direction', type: 'select', options: Object.freeze([
        Object.freeze({ value: 'to', label: 'Move to point' }),
        Object.freeze({ value: 'from', label: 'Move from point' }),
      ]) }),
      // Down to 0: a short travel is a nudge under the blend rather than a whip,
      // and 0 leaves the pair still while the blur, lens and tremble carry the cut.
      Object.freeze({ key: 'travelStrength', label: 'Travel', type: 'range', min: 0, max: 260, step: 5, suffix: '%' }),
      Object.freeze({ key: 'usePointDistance', label: 'Distance sets travel', type: 'switch' }),
      /*
       * Motion Path — the second travel type. Anchors are percent-of-comp like
       * every point option; the runtime smooths a curve through them and BOTH
       * clips ride it (incoming offset by the net displacement). With the mode
       * on 'straight' — every saved project — none of this group runs and the
       * target point drives exactly as it always did.
       */
      Object.freeze({ type: 'section', key: 'sec-path', label: 'Motion Path' }),
      Object.freeze({ key: 'travelMode', label: 'Travel type', type: 'select', options: Object.freeze([
        Object.freeze({ value: 'straight', label: 'Straight (to point)' }),
        Object.freeze({ value: 'path', label: 'Motion path' }),
      ]) }),
      Object.freeze({ key: 'travelPath', label: 'Path', type: 'path' }),
      Object.freeze({ key: 'pathSmooth', label: 'Smoothing', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
      /*
       * Perspective — the lane's plate as a card tilted in 3D (closed-form
       * inverse homography in the clip shader, per lane). Lean tips both lanes
       * into the travel on the shared envelope; Swing is the travel's own ramp
       * in angle — one continuous card turn across the cut. Defaults OFF.
       */
      Object.freeze({ type: 'section', key: 'sec-perspective', label: 'Perspective' }),
      Object.freeze({ key: 'perspective', label: 'Tilt', type: 'range', min: -80, max: 80, step: 1, suffix: '°' }),
      Object.freeze({ key: 'perspectiveMode', label: 'Mode', type: 'select', options: Object.freeze([
        Object.freeze({ value: 'lean', label: 'Lean into the move' }),
        Object.freeze({ value: 'swing', label: 'Swing through' }),
      ]) }),
      Object.freeze({ key: 'perspectiveDepth', label: 'Depth', type: 'range', min: 0.6, max: 4, step: 0.05 }),
      Object.freeze({ key: 'perspectiveAxis', label: 'Axis', type: 'select', options: Object.freeze([
        Object.freeze({ value: 'auto', label: 'Auto (across travel)' }),
        Object.freeze({ value: 'yaw', label: 'Yaw (turn left/right)' }),
        Object.freeze({ value: 'pitch', label: 'Pitch (tip up/down)' }),
      ]) }),
      Object.freeze({ key: 'perspectiveAttach', label: 'Attach', type: 'select', options: Object.freeze([
        Object.freeze({ value: 'plate', label: 'Plate (rides the move)' }),
        Object.freeze({ value: 'camera', label: 'Camera (frame centre)' }),
      ]) }),
      Object.freeze({ key: 'perspectiveShade', label: 'Shade', type: 'range', min: 0, max: 100, step: 5, suffix: '%' }),
      Object.freeze({ type: 'section', key: 'sec-blur', label: 'Directional blur' }),
      Object.freeze({ key: 'blurStrength', label: 'Blur strength', type: 'range', min: 0, max: 60, step: 0.5 }),
      Object.freeze({ key: 'blurProfile', label: 'Blur over time', type: 'select', options: Object.freeze([
        Object.freeze({ value: 'velocity', label: 'Follow speed' }),
        Object.freeze({ value: 'peak', label: 'Peak at cut' }),
        Object.freeze({ value: 'constant', label: 'Constant' }),
      ]) }),
      Object.freeze({ key: 'rgbSplit', label: 'RGB split', type: 'range', min: 0, max: RGB_SPLIT_FIELD_MAX, step: 1, suffix: '%' }),
      ...fisheyeOptionFields('Target point'),
      ...FLASH_OPTION_FIELDS,
      ...BLOOM_OPTION_FIELDS,
      ...WIGGLE_OPTION_FIELDS,
      Object.freeze({ type: 'section', key: 'sec-edges', label: 'Blend & edges' }),
      Object.freeze({ key: 'squeeze', label: 'Squeeze', type: 'range', min: 0, max: 40, step: 1, suffix: '%' }),
      // Mirrors the squeeze about 1 on the ARRIVING lane (1 + s while the
      // outgoing gives 1 − s) — the exit lane has nothing to mirror, so the
      // control is dropped from the Out slot like the blend it belongs with.
      Object.freeze({ key: 'squeezeOpposite', label: 'Opposite on incoming', type: 'switch', outHidden: true }),
      ...BLEND_EDGE_OPTION_FIELDS,
    ]),
  }),
  // Built-in executable packages: same runtime as user-imported .gltransition
  // files, but shipped with the app (see builtinTransitionPackages.js).
  '3D Carousel': CAROUSEL_3D_PRESET,
  'Louver Flip': LOUVER_FLIP_PRESET,
  'Circular Wipe': CIRCULAR_WIPE_PRESET,
  'Pixel Blocks': PIXEL_BLOCKS_PRESET,
  'Camera Whip': CAMERA_WHIP_PRESET,
  'Zoom Ruler': ZOOM_RULER_PRESET,
  'Gradient Glow Stack': GLOW_STACK_PRESET,
  'Gradient Map': GRADIENT_MAP_PRESET,
});

// Point options are percent of composition. The range runs past the frame on
// purpose: aiming a zoom or a whip at something just off-screen is a real move.
export const POINT_OPTION_MIN = -100;
export const POINT_OPTION_MAX = 200;

export const ADVANCED_TRANSITION_DEFAULT_DURATION = 1;
export const ADVANCED_TRANSITION_MIN_DURATION = 0.05;
export const ADVANCED_TRANSITION_MAX_DURATION = 30;

const localPresets = new Map();
const registryListeners = new Set();
let localLoadPromise = null;
let localListPending = false; // a list request is in flight
let lastListStartedAt = 0;

export function replaceLocalAdvancedTransitionPresets(presets) {
  localPresets.clear();
  for (const preset of presets || []) {
    if (preset?.type && preset?.source === 'local') localPresets.set(preset.type, preset);
  }
  for (const listener of registryListeners) listener();
}

// Swap one registered package for its fully loaded descriptor (a lazy,
// metadata-only preset graduating on first use). Listeners re-render, so a
// frame drawn against the placeholder is redrawn with the real package.
export function upsertLocalAdvancedTransitionPreset(preset) {
  if (!preset?.type || preset?.source !== 'local') return;
  localPresets.set(preset.type, preset);
  for (const listener of registryListeners) listener();
}

export function onAdvancedTransitionPresetsChanged(listener) {
  registryListeners.add(listener);
  return () => registryListeners.delete(listener);
}

export function getAdvancedTransitionPresets() {
  return [
    ...Object.entries(ADVANCED_TRANSITION_PRESETS).map(([type, preset]) => ({ type, name: type, ...preset })),
    ...localPresets.values(),
  ];
}

export function getLocalAdvancedTransitionPresets() {
  return [...localPresets.values()];
}

/*
 * Registering the installed packages is ONE list request: each package is
 * registered from the capabilities it published (name, options, renderer,
 * preview assets) as a lazy preset, and its code is fetched and evaluated only
 * when something asks for it — the project referencing it (getAdvancedTransitionPreset
 * from the Player), or the picker adding it. Before the list existed every
 * package's source was fetched and executed at inspector start-up, whether the
 * project used it or not (user audit, 2026-09-11).
 *
 * The returned promise also settles every full load already requested, so the
 * export's `await loadAdvancedTransitionPackages()` still means "everything
 * this project references is resolved" before its first deterministic frame.
 */
export function loadAdvancedTransitionPackages({ force = false } = {}) {
  if (!localLoadPromise || force) {
    localListPending = true;
    lastListStartedAt = Date.now();
    localLoadPromise = import('./localAdvancedTransitions')
      .then((module) => module.loadAndRegisterLocalAdvancedTransitions())
      .catch((error) => {
        console.warn('[transitions] Could not load local transition packages:', error?.message || error);
        replaceLocalAdvancedTransitionPresets([]);
        return [];
      })
      .finally(() => { localListPending = false; });
  }
  return localLoadPromise.then((loaded) => import('./localAdvancedTransitions')
    .then((module) => module.settleRequestedLocalAdvancedTransitions())
    .then(() => loaded, () => loaded));
}

/*
 * RE-LISTING WHAT IS INSTALLED.
 *
 * The list above is read once per session, but packages also arrive from
 * outside the editor — an agent installs one over the API while the editor is
 * open, then adds it to the project. Nothing about that reaches this tab, so
 * the list is re-read at the moments a new package can matter: the transitions
 * modal opening, the editor reloading after an API change, and a project
 * referencing a `local:` type this session has never listed.
 *
 * A re-list is the same single request, and unchanged packages keep their
 * evaluated code (cached per id + revision), so it costs one small GET. It is
 * still coalesced: never while a list request is in flight, and at most once
 * per REFRESH_MIN_INTERVAL_MS.
 */
const REFRESH_MIN_INTERVAL_MS = 1000;

export function refreshAdvancedTransitionPackages() {
  if (localListPending || Date.now() - lastListStartedAt < REFRESH_MIN_INTERVAL_MS) {
    return loadAdvancedTransitionPackages();
  }
  return loadAdvancedTransitionPackages({ force: true });
}

// The Player looks a transition up every frame, so an unknown `local:` type
// must not turn into a request per frame. Each type is re-asked with a growing
// gap — a package the agent installed a moment ago is found on the first try,
// while one that was deleted settles at one request a minute.
const UNKNOWN_LOCAL_FIRST_RETRY_MS = 3000;
const UNKNOWN_LOCAL_MAX_RETRY_MS = 60000;
const unknownLocalTypes = new Map(); // type → { nextAt, delay }

function relistForUnknownLocalType(type) {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  const seen = unknownLocalTypes.get(type);
  if (seen && now < seen.nextAt) return;
  const delay = seen ? Math.min(seen.delay * 2, UNKNOWN_LOCAL_MAX_RETRY_MS) : UNKNOWN_LOCAL_FIRST_RETRY_MS;
  unknownLocalTypes.set(type, { nextAt: now + delay, delay });
  refreshAdvancedTransitionPackages();
}

export function getAdvancedTransitionPreset(type) {
  const preset = ADVANCED_TRANSITION_PRESETS[type] || localPresets.get(type) || null;
  // A lazy package is being referenced: start its full load (deduplicated), and
  // hand back the placeholder meanwhile — its createInstance waits for the load.
  if (preset?.lazy && typeof preset.load === 'function') preset.load();
  if (preset) { if (unknownLocalTypes.size) unknownLocalTypes.delete(type); }
  else if (isLocalAdvancedTransitionType(type)) relistForUnknownLocalType(type);
  return preset;
}

/*
 * The controls a preset offers in one slot.
 *
 * An advanced transition is the same recipe wherever it is applied, so the
 * schema is shared — a field is dropped only when the slot physically cannot
 * honour it (a `crossOnly` field needs a second clip that an entrance or exit
 * does not have; an `outHidden` field is ignored by the exit lane). Nothing is
 * renamed or re-ordered per slot: the point is that the same transition reads
 * the same everywhere.
 */
export function advancedTransitionOptionFields(preset, slot = 'cross') {
  const fields = preset?.optionFields || [];
  if (slot === 'cross') return fields;
  return fields
    .filter((field) => !field?.crossOnly && !(slot === 'out' && field?.outHidden) && !(slot === 'in' && field?.inHidden))
    // A field that names the lane it drives ("Edges (out)") only reads that way
    // with both lanes on screen; on a one-sided slot it carries the plain name.
    .map((field) => (field?.slotLabels?.[slot] ? { ...field, label: field.slotLabels[slot] } : field));
}

// Executable packages may need a longer authored timeline than the editor's
// generic one-second default. The descriptor default is applied only when the
// package is selected; the saved item duration remains the user's override.
export function getAdvancedTransitionDefaultDuration(type) {
  const value = getAdvancedTransitionPreset(type)?.defaultDuration;
  return Number.isFinite(value)
    ? Math.max(ADVANCED_TRANSITION_MIN_DURATION, Math.min(ADVANCED_TRANSITION_MAX_DURATION, value))
    : ADVANCED_TRANSITION_DEFAULT_DURATION;
}

export function isLocalAdvancedTransitionType(type) {
  return typeof type === 'string' && /^local:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(type);
}

export function transitionMediaVideoNeedsSeek(currentTime, targetTime, isPlaying) {
  if (!Number.isFinite(targetTime)) return false;
  const current = Number.isFinite(currentTime) ? currentTime : 0;
  return Math.abs(current - targetTime) > (isPlaying ? 0.12 : 0.004);
}

export function resolveAdvancedTransitionOptions(type, rawOptions) {
  const preset = getAdvancedTransitionPreset(type);
  if (!preset?.optionDefaults) return null;
  const raw = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
  const resolved = { ...preset.optionDefaults };
  for (const field of preset.optionFields || []) {
    // `{ type: 'section' }` entries only group the inspector UI — they carry no
    // key, so they must never be read as an option.
    if (field.type === 'section') continue;
    if (field.type === 'switch') {
      if (typeof raw[field.key] === 'boolean') resolved[field.key] = raw[field.key];
      continue;
    }
    if (field.type === 'select') {
      const allowed = (field.options || []).map((option) => (typeof option === 'object' ? option.value : option));
      if (allowed.includes(raw[field.key])) resolved[field.key] = raw[field.key];
      continue;
    }
    if (field.type === 'text' || field.type === 'textarea' || field.type === 'color') {
      if (typeof raw[field.key] === 'string') resolved[field.key] = raw[field.key].slice(0, 10000);
      continue;
    }
    // The motion path is object-valued like `point`, and for the same reason it
    // is rebuilt field by field: anchors cap at 12 and clamp to the point
    // range, shares clamp to their field range and are trimmed/padded to
    // exactly one per segment — a malformed half can't reach the runtime, and
    // autosave can't strip a shape it doesn't know.
    if (field.type === 'path') {
      const value = raw[field.key];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const points = (Array.isArray(value.points) ? value.points : [])
        .slice(0, 12)
        .filter((p) => p && typeof p === 'object' && Number.isFinite(p.x) && Number.isFinite(p.y))
        .map((p) => ({
          x: Math.max(POINT_OPTION_MIN, Math.min(POINT_OPTION_MAX, p.x)),
          y: Math.max(POINT_OPTION_MIN, Math.min(POINT_OPTION_MAX, p.y)),
        }));
      const segments = Math.max(0, points.length - 1);
      const shares = (Array.isArray(value.shares) ? value.shares : [])
        .slice(0, segments)
        .map((w) => (Number.isFinite(w) ? Math.max(5, Math.min(500, w)) : 100));
      while (shares.length < segments) shares.push(100);
      resolved[field.key] = { points, shares };
      continue;
    }
    // A point is an object-valued option. It is rebuilt axis by axis rather
    // than spread, so a malformed half (or an extra key) can't reach the shader.
    if (field.type === 'point') {
      const value = raw[field.key];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const fallback = preset.optionDefaults[field.key] || {};
      const axis = (key, dflt) => (Number.isFinite(value[key])
        ? Math.max(POINT_OPTION_MIN, Math.min(POINT_OPTION_MAX, value[key]))
        : dflt);
      resolved[field.key] = {
        x: axis('x', Number.isFinite(fallback.x) ? fallback.x : 50),
        y: axis('y', Number.isFinite(fallback.y) ? fallback.y : 50),
        ...(field.axes >= 3 || Number.isFinite(value.z)
          ? { z: axis('z', Number.isFinite(fallback.z) ? fallback.z : 0) }
          : null),
      };
      continue;
    }
    const value = raw[field.key];
    if (!Number.isFinite(value)) continue;
    resolved[field.key] = Math.max(field.min ?? -Infinity, Math.min(field.max ?? Infinity, value));
  }
  return resolved;
}

// A saved local package can be temporarily unavailable while the registry is
// loading (or after the package was moved). Preserve its primitive option values
// instead of erasing them during project sanitization; once loaded, the normal
// schema resolver clamps them to the package's declared controls.
export function sanitizePersistedTransitionOptions(type, rawOptions) {
  const resolved = resolveAdvancedTransitionOptions(type, rawOptions);
  if (resolved) return resolved;
  if (!isLocalAdvancedTransitionType(type) || !rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) return null;
  const safe = {};
  for (const [key, value] of Object.entries(rawOptions).slice(0, 64)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) continue;
    if (typeof value === 'boolean' || typeof value === 'string' || (Number.isFinite(value))) safe[key] = value;
  }
  return safe;
}

export function createTransitionSoundCue(item, itemLayout, offsetTime = 0, idPrefix = '') {
  const preset = getAdvancedTransitionPreset(item?.transition);
  const audio = preset?.audio;
  const options = resolveAdvancedTransitionOptions(item?.transition, item?.transitionOptions);
  if (options?.muteSound) return null;
  if (!audio || !itemLayout || !(itemLayout.overlapIn > 0)) return null;
  return {
    id: `${idPrefix}${item.id}`,
    url: audio.url,
    // A cross transition starts where the incoming clip's overlap starts.
    startTime: offsetTime + itemLayout.startTime,
    trimStart: audio.trimStart,
    trimEnd: audio.trimEnd,
    volume: audio.volume,
  };
}

/*
 * Every sound an item's transitions own — the cross cue above plus one for each
 * advanced entrance/exit.
 *
 * The preset carries the sound, not the slot, so a whoosh that plays on the cut
 * has to play on an entrance too or the same preset would be silently half a
 * transition depending on where it was applied. What differs is only WHERE the
 * cue lands: a cross sits on the cut, an entrance at the clip's start, an exit
 * at the point its exit window opens.
 */
function layerSlotSoundCue(item, itemLayout, offsetTime, idPrefix, slot) {
  const type = slot === 'in' ? item?.transitionInType : item?.transitionOutType;
  const audio = getAdvancedTransitionPreset(type)?.audio;
  if (!audio) return null;
  const rawOptions = slot === 'in' ? item?.transitionInOptions : item?.transitionOutOptions;
  if (resolveAdvancedTransitionOptions(type, rawOptions)?.muteSound) return null;
  const duration = Number(slot === 'in' ? item?.transitionInDuration : item?.transitionOutDuration) || 1;
  const clipDuration = itemLayout?.duration;
  if (!(clipDuration > 0)) return null;
  const start = slot === 'in'
    ? itemLayout.startTime
    : itemLayout.startTime + Math.max(0, clipDuration - duration);
  return {
    id: `${idPrefix}${item.id}:${slot}`,
    url: audio.url,
    startTime: offsetTime + start,
    trimStart: audio.trimStart,
    trimEnd: audio.trimEnd,
    volume: audio.volume,
  };
}

export function createTransitionSoundCues(item, itemLayout, offsetTime = 0, idPrefix = '') {
  return [
    createTransitionSoundCue(item, itemLayout, offsetTime, idPrefix),
    layerSlotSoundCue(item, itemLayout, offsetTime, idPrefix, 'in'),
    layerSlotSoundCue(item, itemLayout, offsetTime, idPrefix, 'out'),
  ].filter(Boolean);
}

export function clampTransitionSoundCue(cue, windowStart = -Infinity, windowEnd = Infinity) {
  if (!cue) return null;
  let startTime = cue.startTime;
  let trimStart = cue.trimStart;
  let trimEnd = cue.trimEnd;
  let endTime = startTime + (trimEnd - trimStart);
  if (endTime <= windowStart || startTime >= windowEnd) return null;
  if (startTime < windowStart) {
    trimStart += windowStart - startTime;
    startTime = windowStart;
  }
  endTime = startTime + (trimEnd - trimStart);
  if (endTime > windowEnd) trimEnd -= endTime - windowEnd;
  if (trimEnd - trimStart <= 0.01) return null;
  return { ...cue, startTime, trimStart, trimEnd };
}
