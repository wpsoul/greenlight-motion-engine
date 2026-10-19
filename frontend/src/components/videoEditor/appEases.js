import { parseEase, registerEase, bezierEase } from './easingEngine.js';
import { TransitionEasing } from './types.js';
import { EASING_BEZIER, SAMPLED_EASING_VALUES, sampleLinearEase, GSAP_EASE_NAMES } from './easingCurves.js';

/*
 * The app's named easings, and the one lookup that turns a TransitionEasing value into
 * the curve that PLAYS. The editor (gsapTransitions.js), the easing picker and flipbooks
 * all resolve through playedEase, so a curve looks and moves the same everywhere.
 *
 * The families (power, sine, expo, circ, back, elastic, bounce) are easingEngine.js's;
 * the app's own curves are registered below. Only leaf modules are imported, with
 * explicit extensions (no three.js, no MotionFast library), so the picker, the flipbook
 * and the pure modules `node --test` loads (grid, crop, lines draw) can all use it.
 */

// After Effects-style curves registered as named eases so they resolve through
// parseEase like the rest. EASING_BEZIER holds the same handles as mtl.js's
// AE_EASING_DEFS (tests/easing-engine/verify_aligned.mjs checks they stay equal).
registerEase('aeIn', bezierEase(...EASING_BEZIER[TransitionEasing.AE_IN]));
registerEase('aeSmooth', bezierEase(...EASING_BEZIER[TransitionEasing.AE_SMOOTH]));
registerEase('aeOut', bezierEase(...EASING_BEZIER[TransitionEasing.AE_OUT]));

// The owner's Smooth Glide and Glide Easing Stop (EASING_BEZIER): plain beziers, played as named eases like AE's.
registerEase('smoothGlide', bezierEase(...EASING_BEZIER[TransitionEasing.SMOOTH_GLIDE]));
registerEase('glideStop', bezierEase(...EASING_BEZIER[TransitionEasing.GLIDE_STOP]));

// Legacy MotionFast template curves. Natural/Slow Down are the beziers already in
// EASING_BEZIER; the spring trio samples its 101-point table (see easingCurves.js).
registerEase('mfNatural', bezierEase(...EASING_BEZIER[TransitionEasing.NATURAL]));
registerEase('mfSlowDown', bezierEase(...EASING_BEZIER[TransitionEasing.SLOW_DOWN]));
registerEase('mfOvershoot', (t) => sampleLinearEase(SAMPLED_EASING_VALUES[TransitionEasing.OVERSHOOT], t));
registerEase('mfImpulse', (t) => sampleLinearEase(SAMPLED_EASING_VALUES[TransitionEasing.IMPULSE], t));
registerEase('mfSwing', (t) => sampleLinearEase(SAMPLED_EASING_VALUES[TransitionEasing.SWING], t));
// Same shape of registration, sampled the same way — Smooth Overshoot is not a
// legacy MotionFast curve but it lives in the same table for the same reason.
registerEase('mfSmoothOvershoot', (t) => sampleLinearEase(SAMPLED_EASING_VALUES[TransitionEasing.SMOOTH_OVERSHOOT], t));
registerEase('mfAnticipate', (t) => sampleLinearEase(SAMPLED_EASING_VALUES[TransitionEasing.ANTICIPATE], t));

// ── Easing map: TransitionEasing value → GSAP-style ease name (easingEngine.js resolves it) ──
// The table itself is GSAP_EASE_NAMES in easingCurves.js (a leaf the capabilities
// generator can load); this is the lookup every caller goes through.

export function getGsapEase(easingType) {
  // Two storage formats reach this lookup: most fields store the TransitionEasing
  // display value ('Expo Out') the table is keyed by, but a few (the text
  // counter's `easing`, textCounterEasing) store the enum KEY ('EXPO_OUT').
  // Resolve the key through the enum so those selections play their curve
  // instead of silently falling back to power2.inOut.
  return GSAP_EASE_NAMES[easingType]
    || GSAP_EASE_NAMES[TransitionEasing[easingType]]
    || 'power2.inOut';
}

/**
 * The curve a named easing plays, or undefined for a name the catalogue doesn't have —
 * for callers with their own fallback (the grid plays linear, Pixel Blocks Sine In).
 * Hold and Custom need the key itself — see resolveKeyEase in gsapTransitions.js.
 */
export function namedEase(easingType) {
  const name = GSAP_EASE_NAMES[easingType] || GSAP_EASE_NAMES[TransitionEasing[easingType]];
  return name ? parseEase(name) : undefined;
}

/** The curve a named easing plays. Unknown names play Smooth (power2.inOut), as in the editor. */
export function playedEase(easingType) {
  return parseEase(getGsapEase(easingType));
}
