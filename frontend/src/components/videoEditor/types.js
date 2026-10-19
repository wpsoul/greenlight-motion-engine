export const ClipSource = {
  LOCAL: 'LOCAL',
  REMOTE: 'REMOTE',
};

export const SHAPE_TYPES = ['rectangle', 'ellipse', 'circle', 'arrow', 'triangle', 'path', 'line', 'vector', 'custom'];

// ── Text layer font size ──
// A text layer sizes its font either in absolute composition pixels
// (`textFontSize`, the default and what every pre-8.x project stores) or as a
// percentage of the composition HEIGHT (`textFontSizePct`, like CSS `vh`) so the
// same layer keeps its relative size when the project is re-rendered at another
// resolution. Panel, canvas and export all resolve it through the helper below.
export const TEXT_FONT_SIZE_PX_MIN = 8;
export const TEXT_FONT_SIZE_PX_MAX = 1000;
export const TEXT_FONT_SIZE_PCT_MIN = 0.5;
export const TEXT_FONT_SIZE_PCT_MAX = 100;
export const DEFAULT_TEXT_FONT_SIZE_PX = 96;
// 96px on a 1080p frame — the px default expressed as %, so a layer that has
// never carried a % value doesn't jump when it first switches units.
export const DEFAULT_TEXT_FONT_SIZE_PCT = 8.9;
// Stored as a full CSS stack (it goes straight into canvas `ctx.font`); the
// font dropdown resolves it back to its "Helvetica" catalog entry by stack.
export const DEFAULT_TEXT_FONT_FAMILY = `'Helvetica Neue', Helvetica, Arial, sans-serif`;
export const DEFAULT_TEXT_FONT_WEIGHT = 400;

const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function textFontSizeUnitOf(item) {
  return item?.textFontSizeUnit === 'pct' ? 'pct' : 'px';
}

// Resolves a text layer's font size to composition pixels. `compHeight` is the
// composition height and is only consulted in % mode.
export function resolveTextFontSize(item, compHeight) {
  if (textFontSizeUnitOf(item) === 'pct') {
    const raw = Number(item?.textFontSizePct);
    const pct = clampNum(
      Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TEXT_FONT_SIZE_PCT,
      TEXT_FONT_SIZE_PCT_MIN,
      TEXT_FONT_SIZE_PCT_MAX,
    );
    const h = Number(compHeight) > 0 ? Number(compHeight) : 1080;
    return clampNum((h * pct) / 100, TEXT_FONT_SIZE_PX_MIN, TEXT_FONT_SIZE_PX_MAX * 4);
  }
  const px = Number(item?.textFontSize);
  return clampNum(
    Number.isFinite(px) && px > 0 ? px : DEFAULT_TEXT_FONT_SIZE_PX,
    TEXT_FONT_SIZE_PX_MIN,
    TEXT_FONT_SIZE_PX_MAX,
  );
}

// Sequences (compound clips) can nest recursively; cap the depth to keep the
// render pipeline (one offscreen pass per level) bounded. The cap covers every
// CONTAINER type, not just sequences — a grid inside a sequence inside a grid
// costs one offscreen pass per level exactly the same way.
export const SEQUENCE_MAX_DEPTH = 4;

// ── Container clips ──
// A container owns a private nested timeline (`clip.sequence = { clips, channels }`)
// that pre-renders to an offscreen target and then composites as one ordinary
// layer. Two kinds share that plumbing:
//   'sequence' — the nested timeline plays as authored (CapCut compound clip)
//   'grid'     — the nested channels are laid out by a rule (see gridLayout.js);
//                one channel per cell, the grid owns each member's PRS
// Every nested-render, media warm-up, GC, paste-remap and export path keys off
// isContainerClip so a new container type never has to re-walk them.
export const CONTAINER_MEDIA_TYPES = new Set(['sequence', 'grid']);

export const isContainerClip = (clip) =>
  !!clip && CONTAINER_MEDIA_TYPES.has(clip.mediaType) && !!clip.sequence;

export const GRID_MEDIA_TYPE = 'grid';

export const isGridClip = (clip) => clip?.mediaType === GRID_MEDIA_TYPE && !!clip.sequence;

export const TransitionType = {
  NONE: 'None',
  FADE: 'Cross Fade',
  // One type per move, the way is `transitionOptions.direction` (see
  // DIRECTIONAL_TRANSITIONS). Push absorbed Slide Left/Right and Push Up/Down —
  // the same move (both clips travel together) on two axes.
  PUSH: 'Push',
  PARALLAX: 'Parallax',
  WIPE: 'Wipe',
  ZOOM_IN: 'Zoom In',
  ZOOM_OUT: 'Zoom Out',
  // 'Zoom Blur' was retired in 9.0.6 — 'Advanced Zoom' does the same thing with a
  // pivot you can choose, so it was removed rather than kept as a duplicate.
  // Renamed from 'Zoom to Point'/'Move to Point' when they grew the fisheye and
  // wiggle groups: they are no longer only about aiming at a point. Every project
  // saved before that still holds the old string — see TRANSITION_TYPE_ALIASES.
  ZOOM_POINT: 'Advanced Zoom',
  MOVE_POINT: 'Advanced Movement',
  CAROUSEL_3D: '3D Carousel',
  LOUVER_FLIP: 'Louver Flip',
  CIRCULAR_WIPE: 'Circular Wipe',
  PIXEL_BLOCKS: 'Pixel Blocks',
  CAMERA_WHIP: 'Camera Whip',
  ZOOM_RULER: 'Zoom Ruler',
  GLOW_STACK: 'Gradient Glow Stack',
  GRADIENT_MAP: 'Gradient Map',
  SCALE_SWAP: 'Scale Swap',
  SIDE_BY_SIDE: 'Side by Side',
  DIP_TO_BLACK: 'Dip to Black',
  RADIAL_WIPE: 'Radial Wipe',
  CUSTOM: 'Custom',
};

/*
 * Retired transition names → what replaced them.
 *
 * A clip stores its transition as the display string, and sanitizeItem drops any
 * value that is not in TransitionType to `None`. So renaming an enum value
 * without an entry here does not "rename" anything — it silently clears the
 * transition on every project that used it, which is exactly what happened to
 * projects using 'Zoom Blur' in 9.0.6. Resolve through here before validating.
 */
export const TRANSITION_TYPE_ALIASES = Object.freeze({
  'Zoom to Point': 'Advanced Zoom',
  'Move to Point': 'Advanced Movement',
  // Retired transition. A cross fade keeps the saved overlap, so the clips after
  // it stay where they were; the old twist options are dropped with the type.
  'Vortex Swirl': 'Cross Fade',
});

/*
 * The directional transitions: one type each, the way in `options.direction`.
 *
 * Push / Parallax (cross) name the way the clips MOVE. Wipe names the way the
 * edge sweeps, on both slots. A layer's Slide keeps the meaning its four old
 * names had: Left / Right are the edge it enters from and leaves by, Up / Down
 * the way it moves (a Slide Up rises in, and rises out).
 *
 * Every project saved before the merge holds the old per-direction names. Each
 * load rewrites them (sanitizeItem → migrateDirectionalTransition) and the next
 * save stores the new shape; the runtime still reads them (directionalTransition),
 * so a path that skips sanitizing renders them unchanged.
 */
export const TransitionDirection = Object.freeze({
  LEFT: 'left', RIGHT: 'right', UP: 'up', DOWN: 'down',
  LEFT_TO_RIGHT: 'leftToRight', RIGHT_TO_LEFT: 'rightToLeft',
  BOTTOM_TO_TOP: 'bottomToTop', TOP_TO_BOTTOM: 'topToBottom',
});
const MOVE_WAYS = Object.freeze(['left', 'right', 'up', 'down']);
const SWEEP_WAYS = Object.freeze(['leftToRight', 'rightToLeft', 'bottomToTop', 'topToBottom']);
// type → its directions, the first is the default
export const DIRECTIONAL_TRANSITIONS = Object.freeze({
  Push: MOVE_WAYS,
  Parallax: MOVE_WAYS,
  Wipe: SWEEP_WAYS,
  Slide: MOVE_WAYS,
});
// old name → [new type, direction], per slot
export const LEGACY_DIRECTIONAL_TRANSITIONS = Object.freeze({
  'Slide Left': Object.freeze(['Push', 'left']),
  'Slide Right': Object.freeze(['Push', 'right']),
  'Push Up': Object.freeze(['Push', 'up']),
  'Push Down': Object.freeze(['Push', 'down']),
  'Parallax Left': Object.freeze(['Parallax', 'left']),
  'Parallax Right': Object.freeze(['Parallax', 'right']),
  'Parallax Up': Object.freeze(['Parallax', 'up']),
  'Parallax Down': Object.freeze(['Parallax', 'down']),
  'Wipe Reverse': Object.freeze(['Wipe', 'rightToLeft']),
});
export const LEGACY_DIRECTIONAL_LAYER_TRANSITIONS = Object.freeze({
  'Slide Left': Object.freeze(['Slide', 'left']),
  'Slide Right': Object.freeze(['Slide', 'right']),
  'Slide Up': Object.freeze(['Slide', 'up']),
  'Slide Down': Object.freeze(['Slide', 'down']),
  'Wipe Left': Object.freeze(['Wipe', 'leftToRight']),
  'Wipe Right': Object.freeze(['Wipe', 'rightToLeft']),
  'Wipe Up': Object.freeze(['Wipe', 'bottomToTop']),
  'Wipe Down': Object.freeze(['Wipe', 'topToBottom']),
});

/**
 * { type, options } for a saved slot, old names rewritten to the merged type with
 * their direction (any other saved options are dropped — the old types had none).
 * Everything else passes through untouched.
 */
export function migrateDirectionalTransition(type, options, slot = 'cross') {
  const legacy = (slot === 'cross' ? LEGACY_DIRECTIONAL_TRANSITIONS : LEGACY_DIRECTIONAL_LAYER_TRANSITIONS)[type];
  return legacy ? { type: legacy[0], options: { direction: legacy[1] } } : { type, options };
}

/** [type, direction] the runtime draws — new types read their option, old names map. */
export function directionalTransition(type, options, slot = 'cross') {
  const legacy = (slot === 'cross' ? LEGACY_DIRECTIONAL_TRANSITIONS : LEGACY_DIRECTIONAL_LAYER_TRANSITIONS)[type];
  if (legacy) return legacy;
  const ways = DIRECTIONAL_TRANSITIONS[type];
  if (!ways) return null;
  return [type, ways.includes(options?.direction) ? options.direction : ways[0]];
}

export function resolveTransitionType(value) {
  return (typeof value === 'string' && TRANSITION_TYPE_ALIASES[value]) || value;
}

/*
 * Which clip animates over which, for the length of a cross transition.
 *
 * Every cross transition is authored as one pair of lanes: the OUTGOING clip
 * plays the lane that leaves, the INCOMING clip plays the lane that arrives.
 * That is why a wipe uncovers the next clip over a previous one holding still,
 * and why a zoom pushes the next clip into place.
 *
 * `Previous over next` mirrors that pairing: the two clips trade lanes and the
 * ramp runs backwards, so the OUTGOING clip becomes the one that moves — it
 * wipes, zooms or slides away on top — while the incoming clip sits still
 * underneath waiting to be uncovered. The transition itself is unchanged; only
 * which side of the cut carries the motion is.
 *
 * Stored on the incoming item next to the rest of its cross fields, and only
 * when it is off the default, so projects that never touched it round-trip
 * byte-identical.
 */
export const TransitionOrder = {
  NEXT_OVER_PREV: 'Next over previous',
  PREV_OVER_NEXT: 'Previous over next',
};

export const TRANSITION_ORDER_OPTIONS = Object.freeze(Object.values(TransitionOrder));

export const LayerTransitionType = {
  NONE: 'None',
  FADE: 'Fade',
  // The way is `transitionIn/OutOptions.direction`, as on the cross slot.
  SLIDE: 'Slide',
  ZOOM_IN: 'Zoom In',
  ZOOM_OUT: 'Zoom Out',
  WIPE: 'Wipe',
  DIP_BLACK: 'Dip to Black',
  RADIAL_WIPE: 'Radial Wipe',
  /*
   * Advanced entrances/exits. These deliberately share their display string —
   * and therefore their whole option schema — with the cross transitions of the
   * same name, because they ARE those transitions with one side missing.
   *
   * A cross Advanced Zoom drives two lanes off one ramp: the outgoing clip
   * travels 1 → g while the incoming travels g⁻¹ → 1. An entrance is the
   * incoming lane on its own and an exit the outgoing lane on its own, so the
   * look, the options and the code are shared rather than reimplemented. Same
   * for Advanced Movement; the 3D Carousel turns with its other panel empty,
   * and the Camera Whip pans off nothing onto the layer (or off the layer onto
   * nothing) — the empty lane draws nothing, so what is under the layer shows.
   * The Gradient Glow Stack sweeps over what is under the layer, and the layer
   * appears (or goes) behind the stack.
   * The Gradient Map's entrance maps the layer in over what is under it and
   * reveals it; its exit maps the layer and dissolves the map to nothing.
   * Pixel Blocks block the layer in (or out) over what is under it; a colour
   * wipe fills only the layer's own pixels.
   *
   * The options live in transitionIn/OutOptions, resolved through the SAME
   * ADVANCED_TRANSITION_PRESETS descriptor the cross slot reads.
   */
  ZOOM_POINT: 'Advanced Zoom',
  MOVE_POINT: 'Advanced Movement',
  CAROUSEL_3D: '3D Carousel',
  CAMERA_WHIP: 'Camera Whip',
  GLOW_STACK: 'Gradient Glow Stack',
  GRADIENT_MAP: 'Gradient Map',
  PIXEL_BLOCKS: 'Pixel Blocks',
  CUSTOM: 'Custom',
};

// The subset of LayerTransitionType that is driven by an advanced preset rather
// than by the plain mesh switch. Used to decide whether a slot carries options.
export const ADVANCED_LAYER_TRANSITIONS = Object.freeze([
  LayerTransitionType.ZOOM_POINT,
  LayerTransitionType.MOVE_POINT,
  LayerTransitionType.CAROUSEL_3D,
  LayerTransitionType.CAMERA_WHIP,
  LayerTransitionType.GLOW_STACK,
  LayerTransitionType.GRADIENT_MAP,
  LayerTransitionType.PIXEL_BLOCKS,
]);

export function isAdvancedLayerTransition(type) {
  return ADVANCED_LAYER_TRANSITIONS.includes(type);
}

/** True when any of the three slots (cross / in / out) holds a real transition. */
export function itemHasLayerTransition(item) {
  if (!item) return false;
  return !!(
    (item.transition && item.transition !== TransitionType.NONE)
    || (item.transitionInType && item.transitionInType !== LayerTransitionType.NONE)
    || (item.transitionOutType && item.transitionOutType !== LayerTransitionType.NONE)
  );
}

export const TransitionEasing = {
  LINEAR: 'Linear',
  EASE_IN: 'Ease In',
  EASE_OUT: 'Ease Out',
  EASE_IN_OUT: 'Smooth',
  // The owner's own curves from the "Easing study" board (2026-10-16): Smooth Glide arrives fast, glides slowly
  // through the middle and leaves fast (its "Glide Easing" layer); Glide Easing Stop jumps in, all but stops,
  // then goes (its "Glide Easing Stop" layer). Both are cubic beziers — see EASING_BEZIER.
  SMOOTH_GLIDE: 'Smooth Glide',
  GLIDE_STOP: 'Glide Easing Stop',
  // After Effects-style bezier curves — same curves as MotionFast's aeIn/aeSmooth/aeOut.
  AE_IN: 'AE In',
  AE_SMOOTH: 'AE Smooth',
  AE_OUT: 'AE Out',
  SINE_IN: 'Sine In',
  SINE_OUT: 'Sine Out',
  SINE_IN_OUT: 'Sine Smooth',
  CUBIC_IN_OUT: 'Cubic Smooth',
  CUBIC_IN: 'Cubic In',
  CUBIC_OUT: 'Cubic Out',
  EXPO_IN: 'Expo In',
  EXPO_OUT: 'Expo Out',
  EXPO_IN_OUT: 'Expo Smooth',
  CIRC_IN: 'Circ In',
  CIRC_OUT: 'Circ Out',
  CIRC_IN_OUT: 'Circ Smooth',
  BACK_IN: 'Back In',
  BACK_OUT: 'Back Out',
  BACK_IN_OUT: 'Back Smooth',
  BOUNCE_OUT: 'Bounce Out',
  ELASTIC_OUT: 'Elastic',
  // Expressive curves ported from the legacy MotionFast template easing catalogue
  // (greenlight-render-templates/templates/common/easings.ts). Natural and Slow Down
  // are cubic beziers; Overshoot/Impulse/Swing are sampled spring curves.
  NATURAL: 'Natural',
  SLOW_DOWN: 'Slow Down',
  OVERSHOOT: 'Overshoot',
  IMPULSE: 'Impulse',
  SWING: 'Swing',
  // The smooth sibling of Overshoot/Elastic: the same springy character, but it
  // leaves 0 at zero velocity instead of being thrown, and rings once instead
  // of several times. Sampled — see SAMPLED_EASING_VALUES.
  SMOOTH_OVERSHOOT: 'Smooth Overshoot',
  // Winds back first, then snaps through to the end: an exit. Sampled.
  ANTICIPATE: 'Anticipate',
  POWER1_IN: 'Power1 In',
  POWER1_OUT: 'Power1 Out',
  POWER1_IN_OUT: 'Power1 Smooth',
  POWER2_IN: 'Power2 In',
  POWER2_OUT: 'Power2 Out',
  POWER2_IN_OUT: 'Power2 Smooth',
  POWER3_IN: 'Power3 In',
  POWER3_OUT: 'Power3 Out',
  POWER3_IN_OUT: 'Power3 Smooth',
  POWER4_IN: 'Power4 In',
  POWER4_OUT: 'Power4 Out',
  POWER4_IN_OUT: 'Power4 Smooth',
  // ── Keyframe-only easings ──
  // CUSTOM reads the key's own `bezier: [x1, y1, x2, y2]` (the graph editor writes
  // it by dragging handles); HOLD steps to the next key instead of interpolating.
  // Both are meaningless on a transition, which has no per-key data — use
  // TRANSITION_EASING_OPTIONS for those dropdowns. They live in this enum anyway so
  // the `Object.values(TransitionEasing).includes(...)` validators accept them.
  CUSTOM: 'Custom',
  HOLD: 'Hold',
};

// Easings a keyframe may carry but a transition may not.
export const KEYFRAME_ONLY_EASINGS = [TransitionEasing.CUSTOM, TransitionEasing.HOLD];

export const TRANSITION_EASING_OPTIONS = Object.values(TransitionEasing)
  .filter((e) => !KEYFRAME_ONLY_EASINGS.includes(e));

// Caption-bar (text background) reveal animations — textBgInType/textBgOutType.
// 'none' keeps the legacy instant bar. Mask names give the direction the edge
// travels; the Out slot mirrors the anchor so the motion reads as continuing
// through (In mask-right + Out mask-right = one left→right sweep).
export const TEXT_BG_REVEAL_TYPES = ['none', 'fade', 'mask-right', 'mask-left', 'mask-down', 'mask-up', 'center-h', 'center-v'];
// Caption-bar border (textBorderStyle). The stroke is drawn INSIDE the bar's
// bounds so a thick border never grows the measured bar; it rides the same
// In/Out reveal as the fill.
export const TEXT_BORDER_STYLES = ['solid', 'dashed', 'dotted'];
// How a directional caption-bar reveal moves: 'wipe' clips the finished bar with a
// rectangle (flat leading edge), 'slide' translates the fill behind a fixed mask,
// 'grow' scales the bar's own rounded geometry from the anchored edge so the
// corner radius survives the whole reveal. center-* take wipe or grow.
export const TEXT_BG_REVEAL_STYLES = ['wipe', 'slide', 'grow'];
// Grow Shape only — how the growing shape itself appears, on its own clock
// (textBgIn/OutGrowAppearDuration + Easing): 'fade' alphas it in, 'scale-in'
// zooms it about its centre from nothing (radius included), 'scale-down' starts
// at 150% and settles while fading in. The Out slot runs the same 1→0.
export const TEXT_BG_GROW_APPEAR = ['none', 'fade', 'scale-in', 'scale-down'];


// 3D model layers. Defaults live here (a leaf module) because both the sanitizer in
// VideoEditor and the inspector in EditorPanel need them, and those two already import
// each other — putting shared constants in either one closes a cycle.
export const MODEL_CONFIG_DEFAULTS = {
  source: 'custom',
  preset: null,
  fit: 'height',
  fitValue: 60,
  anchor: 'center',
  placeOnRigFloor: true,
  baseRotation: { x: 0, y: 0, z: 0 },
  env: { hdr: 'potsdamer_platz_1k', intensity: 1, exposure: 1, rotation: 0 },
  lights: { key: 1, fill: 0.45, rim: 0.35 },
  animation: { clip: null, speed: 1, loop: 'loop', offset: 0 },
  shadow: { enabled: false, opacity: 0.35, blur: 1 },
};

// Framing for artwork on a device's screen — the same options the Mockup builder
// exposes, so a screen looks the same in both features.
export const MODEL_SCREEN_DEFAULTS = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  padding: 0,
  fitMode: 'cover',
  borderRadius: 0,
};
