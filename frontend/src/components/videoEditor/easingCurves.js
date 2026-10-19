// Bezier handles for keyframe easing — the model behind the graph editor.
//
// A keyframe's `easing` shapes the segment that FOLLOWS it (gsapTransitions reads
// `low.easing`), so the out-handle of key i and the in-handle of key i+1 are both
// stored on key i, as `bezier: [x1, y1, x2, y2]` in the segment's unit box. That is
// only read when `easing === TransitionEasing.CUSTOM`; every other easing keeps
// working exactly as before.
//
// This module is a LEAF on purpose: it imports types only. Resolving an easing to a
// function needs GSAP and lives in gsapTransitions.js (`resolveKeyEase`); anything
// here that needs to evaluate a curve takes the function as an argument.

// Explicit extension so `node --test` can load this module directly, the same
// reason keyframeParenting.js imports objectMotionPath.js that way.
import { TransitionEasing } from './types.js';

// Control points for the easings that genuinely ARE a cubic bezier. These trace the
// same curves GSAP's power/sine/expo/circ/back eases do, so a handle the user grabs
// starts where the drawn curve already is rather than jumping.
export const EASING_BEZIER = {
  [TransitionEasing.LINEAR]: [1 / 3, 1 / 3, 2 / 3, 2 / 3],
  [TransitionEasing.EASE_IN]: [0.55, 0.055, 0.675, 0.19],
  [TransitionEasing.EASE_OUT]: [0.215, 0.61, 0.355, 1],
  [TransitionEasing.EASE_IN_OUT]: [0.645, 0.045, 0.355, 1],
  // The owner's curves, exactly as set on the "Easing study" board's layers; Smooth Glide re-tuned 2026-10-17 on
  // the "Current" board's Glide Soft text (a softer last third: 0.9051, 0.0533 → 0.8541, 0.112).
  [TransitionEasing.SMOOTH_GLIDE]: [0.2111, 0.7721, 0.8541, 0.112],
  [TransitionEasing.GLIDE_STOP]: [0, 0.9125, 1, -0.0338],
  // Extracted from easing.aep — the same numbers MotionFast's aeIn/aeSmooth/aeOut use.
  [TransitionEasing.AE_IN]: [0.3141666673, 0, 0.0875000209, 1],
  [TransitionEasing.AE_SMOOTH]: [0.8820833270, 0, 0.2445833683, 1],
  [TransitionEasing.AE_OUT]: [0.8699999754, 0, 0.6433336333, 1],
  [TransitionEasing.SINE_IN]: [0.47, 0, 0.745, 0.715],
  [TransitionEasing.SINE_OUT]: [0.39, 0.575, 0.565, 1],
  [TransitionEasing.SINE_IN_OUT]: [0.445, 0.05, 0.55, 0.95],
  [TransitionEasing.CUBIC_IN]: [0.895, 0.03, 0.685, 0.22],
  [TransitionEasing.CUBIC_OUT]: [0.165, 0.84, 0.44, 1],
  [TransitionEasing.CUBIC_IN_OUT]: [0.77, 0, 0.175, 1],
  [TransitionEasing.EXPO_IN]: [0.95, 0.05, 0.795, 0.035],
  [TransitionEasing.EXPO_OUT]: [0.19, 1, 0.22, 1],
  [TransitionEasing.EXPO_IN_OUT]: [1, 0, 0, 1],
  [TransitionEasing.CIRC_IN]: [0.6, 0.04, 0.98, 0.335],
  [TransitionEasing.CIRC_OUT]: [0.075, 0.82, 0.165, 1],
  [TransitionEasing.CIRC_IN_OUT]: [0.785, 0.135, 0.15, 0.86],
  [TransitionEasing.BACK_IN]: [0.6, -0.28, 0.735, 0.045],
  [TransitionEasing.BACK_OUT]: [0.175, 0.885, 0.32, 1.275],
  [TransitionEasing.BACK_IN_OUT]: [0.68, -0.55, 0.265, 1.55],
  [TransitionEasing.POWER1_IN]: [0.55, 0.085, 0.68, 0.53],
  [TransitionEasing.POWER1_OUT]: [0.25, 0.46, 0.45, 0.94],
  [TransitionEasing.POWER1_IN_OUT]: [0.455, 0.03, 0.515, 0.955],
  [TransitionEasing.POWER2_IN]: [0.55, 0.055, 0.675, 0.19],
  [TransitionEasing.POWER2_OUT]: [0.215, 0.61, 0.355, 1],
  [TransitionEasing.POWER2_IN_OUT]: [0.645, 0.045, 0.355, 1],
  [TransitionEasing.POWER3_IN]: [0.895, 0.03, 0.685, 0.22],
  [TransitionEasing.POWER3_OUT]: [0.165, 0.84, 0.44, 1],
  [TransitionEasing.POWER3_IN_OUT]: [0.77, 0, 0.175, 1],
  [TransitionEasing.POWER4_IN]: [0.755, 0.05, 0.855, 0.06],
  [TransitionEasing.POWER4_OUT]: [0.23, 1, 0.32, 1],
  [TransitionEasing.POWER4_IN_OUT]: [0.86, 0, 0.07, 1],
  // Legacy MotionFast template curves (templates/common/easings.ts).
  [TransitionEasing.NATURAL]: [0.8, 0, 0.2, 1],
  [TransitionEasing.SLOW_DOWN]: [0, 0, 0, 1],
};

// TransitionEasing value → the GSAP ease that PLAYS it. `aeIn`/`aeSmooth`/`aeOut`
// and the `mf*` curves are registered in gsapTransitions.js at import time.
//
// This table lives in the leaf module rather than next to its only runtime caller
// (getGsapEase) so the capabilities generator can read it without loading
// gsapTransitions.js, which drags in three.js and the WebGL transition registry.
export const GSAP_EASE_NAMES = {
  [TransitionEasing.LINEAR]: 'none',
  [TransitionEasing.EASE_IN]: 'power2.in',
  [TransitionEasing.EASE_OUT]: 'power2.out',
  [TransitionEasing.EASE_IN_OUT]: 'power2.inOut',
  [TransitionEasing.SMOOTH_GLIDE]: 'smoothGlide',
  [TransitionEasing.GLIDE_STOP]: 'glideStop',
  [TransitionEasing.AE_IN]: 'aeIn',
  [TransitionEasing.AE_SMOOTH]: 'aeSmooth',
  [TransitionEasing.AE_OUT]: 'aeOut',
  [TransitionEasing.SINE_IN]: 'sine.in',
  [TransitionEasing.SINE_OUT]: 'sine.out',
  [TransitionEasing.SINE_IN_OUT]: 'sine.inOut',
  [TransitionEasing.CUBIC_IN_OUT]: 'power3.inOut',
  [TransitionEasing.CUBIC_IN]: 'power3.in',
  [TransitionEasing.CUBIC_OUT]: 'power3.out',
  [TransitionEasing.EXPO_IN]: 'expo.in',
  [TransitionEasing.EXPO_OUT]: 'expo.out',
  [TransitionEasing.EXPO_IN_OUT]: 'expo.inOut',
  [TransitionEasing.CIRC_IN]: 'circ.in',
  [TransitionEasing.CIRC_OUT]: 'circ.out',
  [TransitionEasing.CIRC_IN_OUT]: 'circ.inOut',
  [TransitionEasing.BACK_IN]: 'back.in',
  [TransitionEasing.BACK_OUT]: 'back.out',
  [TransitionEasing.BACK_IN_OUT]: 'back.inOut',
  [TransitionEasing.BOUNCE_OUT]: 'bounce.out',
  [TransitionEasing.ELASTIC_OUT]: 'elastic.out',
  [TransitionEasing.NATURAL]: 'mfNatural',
  [TransitionEasing.SLOW_DOWN]: 'mfSlowDown',
  [TransitionEasing.OVERSHOOT]: 'mfOvershoot',
  [TransitionEasing.IMPULSE]: 'mfImpulse',
  [TransitionEasing.SWING]: 'mfSwing',
  [TransitionEasing.SMOOTH_OVERSHOOT]: 'mfSmoothOvershoot',
  [TransitionEasing.ANTICIPATE]: 'mfAnticipate',
  [TransitionEasing.POWER1_IN]: 'power1.in',
  [TransitionEasing.POWER1_OUT]: 'power1.out',
  [TransitionEasing.POWER1_IN_OUT]: 'power1.inOut',
  [TransitionEasing.POWER2_IN]: 'power2.in',
  [TransitionEasing.POWER2_OUT]: 'power2.out',
  [TransitionEasing.POWER2_IN_OUT]: 'power2.inOut',
  [TransitionEasing.POWER3_IN]: 'power3.in',
  [TransitionEasing.POWER3_OUT]: 'power3.out',
  [TransitionEasing.POWER3_IN_OUT]: 'power3.inOut',
  [TransitionEasing.POWER4_IN]: 'power4.in',
  [TransitionEasing.POWER4_OUT]: 'power4.out',
  [TransitionEasing.POWER4_IN_OUT]: 'power4.inOut',
};

// Sampled `linear()` tables (101 points) for the legacy MotionFast spring curves —
// taken verbatim from templates/common/easings.ts so the visual feel is preserved.
// Like Bounce and Elastic these cannot be expressed as one cubic bezier; the graph
// draws the sampled curve and only fits a bezier when the user grabs a handle.
export const SAMPLED_EASING_VALUES = {
  [TransitionEasing.OVERSHOOT]: [
    0, 0.1739, 0.3067, 0.4183, 0.515, 0.6, 0.6755, 0.743, 0.8034, 0.8576,
    0.9063, 0.95, 0.9891, 1.0241, 1.0551, 1.0825, 1.1066, 1.1275, 1.1455,
    1.1606, 1.1731, 1.183, 1.1906, 1.1959, 1.199, 1.2, 1.1997, 1.1988, 1.1972,
    1.195, 1.1921, 1.1886, 1.1846, 1.18, 1.1749, 1.1695, 1.1638, 1.1579,
    1.1519, 1.1458, 1.1397, 1.1337, 1.1277, 1.1219, 1.1162, 1.1107, 1.1053,
    1.1002, 1.0952, 1.0904, 1.0857, 1.0813, 1.077, 1.0729, 1.0689, 1.0651,
    1.0615, 1.058, 1.0547, 1.0515, 1.0484, 1.0455, 1.0427, 1.0401, 1.0375,
    1.0351, 1.0327, 1.0305, 1.0284, 1.0264, 1.0244, 1.0226, 1.0209, 1.0192,
    1.0176, 1.0162, 1.0148, 1.0134, 1.0122, 1.011, 1.0099, 1.0088, 1.0079,
    1.007, 1.0061, 1.0053, 1.0046, 1.0039, 1.0033, 1.0028, 1.0023, 1.0018,
    1.0014, 1.0011, 1.0008, 1.0005, 1.0003, 1.0002, 1.0001, 1, 1,
  ],
  [TransitionEasing.IMPULSE]: [
    0, -0.0006, -0.0023, -0.005, -0.0086, -0.0131, -0.0183, -0.0243, -0.0308,
    -0.038, -0.0456, -0.0537, -0.0622, -0.071, -0.0801, -0.0894, -0.0988,
    -0.1084, -0.1179, -0.1275, -0.1369, -0.1461, -0.1551, -0.1636, -0.1717,
    -0.1791, -0.1858, -0.1915, -0.1959, -0.1989, -0.2, -0.1986, -0.1944,
    -0.187, -0.1762, -0.1616, -0.1432, -0.1206, -0.0939, -0.0632, -0.0289,
    0.0087, 0.0487, 0.0906, 0.1334, 0.1765, 0.2193, 0.2613, 0.3022, 0.3416,
    0.3794, 0.4156, 0.4501, 0.483, 0.5142, 0.5438, 0.5719, 0.5986, 0.6239,
    0.6478, 0.6705, 0.692, 0.7124, 0.7317, 0.75, 0.7673, 0.7837, 0.7993,
    0.814, 0.8279, 0.841, 0.8535, 0.8652, 0.8763, 0.8868, 0.8967, 0.9059,
    0.9147, 0.9229, 0.9305, 0.9377, 0.9444, 0.9507, 0.9565, 0.9619, 0.9669,
    0.9714, 0.9756, 0.9794, 0.9829, 0.986, 0.9888, 0.9912, 0.9933, 0.9952,
    0.9967, 0.9979, 0.9988, 0.9995, 0.9999, 1,
  ],
  [TransitionEasing.SWING]: [
    0, -0.0013, -0.0052, -0.0115, -0.0199, -0.0302, -0.0421, -0.0554, -0.0697,
    -0.0847, -0.1, -0.1153, -0.1303, -0.1446, -0.1579, -0.1698, -0.1801,
    -0.1885, -0.1948, -0.1987, -0.2, -0.1986, -0.1942, -0.1863, -0.1744,
    -0.1578, -0.136, -0.1079, -0.0725, -0.0288, 0.0241, 0.087, 0.1594, 0.2396,
    0.3241, 0.4088, 0.4899, 0.5651, 0.6332, 0.6941, 0.7482, 0.796, 0.8384,
    0.8758, 0.9088, 0.9379, 0.9636, 0.9863, 1.0061, 1.0235, 1.0386, 1.0517,
    1.0628, 1.0723, 1.0801, 1.0865, 1.0916, 1.0954, 1.098, 1.0995, 1.1, 1.0997,
    1.0987, 1.097, 1.0947, 1.0919, 1.0885, 1.0847, 1.0806, 1.0762, 1.0717,
    1.0671, 1.0624, 1.0578, 1.0533, 1.0489, 1.0447, 1.0406, 1.0368, 1.0332,
    1.0297, 1.0265, 1.0235, 1.0207, 1.0181, 1.0157, 1.0135, 1.0115, 1.0097,
    1.008, 1.0065, 1.0052, 1.0041, 1.0031, 1.0022, 1.0015, 1.001, 1.0005,
    1.0002, 1.0001, 1,
  ],
  // Smooth Overshoot — the step response of an underdamped second-order system,
  // damping ratio 0.5:
  //     f(t) = 1 - e^(-at)·(cos wt + (a/w)·sin wt),  a = 5.3, w = 9.18
  // plus a t⁴ term that pulls the tail onto exactly 1 (the raw response lands on
  // 1.004; at t = 0.5 the correction moves the curve by 0.0003).
  //
  // What separates it from the three above: those all leave 0 at full speed, so
  // the move reads as thrown. This one leaves at ZERO velocity — it eases in and
  // only then overshoots, to 1.163 at t = 0.34, dips once to 0.973, and settles.
  // Regenerate with html/easing-picker.html, which carries the closed form.
  [TransitionEasing.SMOOTH_OVERSHOOT]: [
    0, 0.0054, 0.0209, 0.0452, 0.0773, 0.116, 0.1602, 0.2088, 0.2611, 0.3159,
    0.3725, 0.4301, 0.488, 0.5455, 0.6021, 0.6572, 0.7104, 0.7614, 0.8097,
    0.8553, 0.8978, 0.9371, 0.9731, 1.0058, 1.0351, 1.0611, 1.0839, 1.1035,
    1.1199, 1.1335, 1.1443, 1.1524, 1.1581, 1.1616, 1.1629, 1.1624, 1.1603,
    1.1566, 1.1516, 1.1455, 1.1385, 1.1307, 1.1223, 1.1134, 1.1042, 1.0948,
    1.0854, 1.076, 1.0667, 1.0576, 1.0489, 1.0404, 1.0324, 1.0249, 1.0178,
    1.0113, 1.0052, 0.9998, 0.9948, 0.9904, 0.9866, 0.9832, 0.9804, 0.978,
    0.9761, 0.9747, 0.9736, 0.9729, 0.9726, 0.9725, 0.9728, 0.9733, 0.974,
    0.9748, 0.9759, 0.9771, 0.9783, 0.9797, 0.9811, 0.9826, 0.984, 0.9855,
    0.9869, 0.9883, 0.9896, 0.9909, 0.9921, 0.9933, 0.9943, 0.9953, 0.9962,
    0.9969, 0.9976, 0.9982, 0.9987, 0.9992, 0.9995, 0.9997, 0.9999, 1, 1,
  ],
  // Anticipate — the exit ease of a Jitter export (html/swing-pop-lab), the sibling of
  // Overshoot above (that file's entrance ease, exactly). Two bezier segments: a wind-up
  // to −0.3791 at 57.56 % (.335,.539,.694,1), then a snap (.96,0,.994,.694) that covers
  // the whole distance in the last few percent. Sampled from those segments; at real
  // frame times the table is within 0.002 of them.
  [TransitionEasing.ANTICIPATE]: [
    0, -0.0105, -0.021, -0.0314, -0.0417, -0.052, -0.0621, -0.0721, -0.082,
    -0.0919, -0.1016, -0.1112, -0.1207, -0.1302, -0.1394, -0.1486, -0.1577, -0.1666,
    -0.1754, -0.1841, -0.1927, -0.2011, -0.2094, -0.2175, -0.2256, -0.2334, -0.2411,
    -0.2486, -0.256, -0.2633, -0.2703, -0.2773, -0.284, -0.2905, -0.2969, -0.3031,
    -0.309, -0.3148, -0.3203, -0.3257, -0.3309, -0.3358, -0.3405, -0.345, -0.3492,
    -0.3532, -0.357, -0.3604, -0.3636, -0.3666, -0.3692, -0.3716, -0.3737, -0.3754,
    -0.3768, -0.3779, -0.3786, -0.379, -0.3791, -0.3787, -0.3779, -0.3767, -0.3751,
    -0.373, -0.3705, -0.3674, -0.3639, -0.3598, -0.3552, -0.35, -0.3441, -0.3376,
    -0.3305, -0.3227, -0.314, -0.3046, -0.2944, -0.2833, -0.2712, -0.258, -0.2439,
    -0.2285, -0.2119, -0.1939, -0.1743, -0.1533, -0.1303, -0.1055, -0.0784, -0.0486,
    -0.0162, 0.0199, 0.0596, 0.104, 0.154, 0.2115, 0.2788, 0.3595, 0.4619,
    0.609, 1,
  ],
};

// Sample one of the tables above at fraction `t`, interpolating between samples.
export function sampleLinearEase(values, t) {
  if (t <= 0) return values[0];
  if (t >= 1) return values[values.length - 1];
  const n = values.length - 1;
  const idx = t * n;
  const i = Math.floor(idx);
  const frac = idx - i;
  return values[i] * (1 - frac) + values[i + 1] * frac;
}

// Bounce and Elastic cannot be expressed as one cubic bezier. The graph draws their
// real sampled curve and only fits a bezier when the user grabs a handle — at which
// point the key becomes CUSTOM and the fit is what they start shaping.
export function isTrueBezierEasing(easing) {
  return easing === TransitionEasing.CUSTOM || Object.hasOwn(EASING_BEZIER, easing);
}

// Handle coordinates are a unit box, but Y deliberately allows overshoot: that is
// what anticipation and follow-through are made of (Back overshoots to 1.275).
const BEZ_X_MIN = 0;
const BEZ_X_MAX = 1;
const BEZ_Y_MIN = -3;
const BEZ_Y_MAX = 4;

const clampTo = (v, min, max) => Math.min(max, Math.max(min, v));

// Round to 4dp so a dragged handle doesn't write 17 digits into every autosave.
const round4 = (v) => Math.round(v * 1e4) / 1e4;

export function clampBezierHandle(x, y) {
  return [round4(clampTo(x, BEZ_X_MIN, BEZ_X_MAX)), round4(clampTo(y, BEZ_Y_MIN, BEZ_Y_MAX))];
}

/**
 * Validate a stored bezier. Returns a fresh 4-tuple, or null when the value is not
 * a usable curve — callers then fall back to the named easing, so a corrupt field
 * degrades to "Smooth" rather than to a broken animation.
 *
 * X is clamped to [0,1] because bx(t) must stay monotonic for the solver in
 * bezierEase to converge; Y is left free within a sane range so overshoot survives.
 */
export function sanitizeBezier(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const nums = value.map((n) => Number.parseFloat(n));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [x1, y1] = clampBezierHandle(nums[0], nums[1]);
  const [x2, y2] = clampBezierHandle(nums[2], nums[3]);
  return [x1, y1, x2, y2];
}

/**
 * Fit a cubic bezier to an arbitrary easing function.
 *
 * Pinning the x-controls at 1/3 and 2/3 makes x(t) = t exactly, which reduces the
 * fit to two samples: f(1/3) and f(2/3) give a 2x2 system for the y-controls. Exact
 * for anything already bezier-shaped, and a good visual match for the rest.
 */
export function fitBezierFromFn(easeFn) {
  if (typeof easeFn !== 'function') return [...EASING_BEZIER[TransitionEasing.EASE_IN_OUT]];
  const r1 = easeFn(1 / 3) - 1 / 27;
  const r2 = easeFn(2 / 3) - 8 / 27;
  const det = (4 / 9) * (4 / 9) - (2 / 9) * (2 / 9);
  const y1 = ((4 / 9) * r1 - (2 / 9) * r2) / det;
  const y2 = ((4 / 9) * r2 - (2 / 9) * r1) / det;
  const [ax, ay] = clampBezierHandle(1 / 3, y1);
  const [bx, by] = clampBezierHandle(2 / 3, y2);
  return [ax, ay, bx, by];
}

/**
 * The handle positions to DRAW for a key, in its segment's unit box.
 *
 * Returns null for a hold key, which has no curve to shape. `easeFnFor` is only
 * consulted for the non-bezier easings — pass gsapTransitions' resolveKeyEase.
 */
export function bezierHandlesFor(key, easeFnFor) {
  const easing = key?.easing || TransitionEasing.EASE_IN_OUT;
  if (easing === TransitionEasing.HOLD) return null;
  // A slice plays only part of its easing, so neither the stored curve nor the
  // preset is what it draws: fit the part it plays, the way Bounce is fitted.
  if (key?.easeSlice && sanitizeEaseSlice(key)) return fitBezierFromFn(easeFnFor?.(key));
  if (easing === TransitionEasing.CUSTOM) {
    return sanitizeBezier(key?.bezier) || [...EASING_BEZIER[TransitionEasing.EASE_IN_OUT]];
  }
  const preset = EASING_BEZIER[easing];
  if (preset) return [...preset];
  return fitBezierFromFn(easeFnFor?.(key));
}

// ── Ease slices: a segment cut out of a longer one ──
//
// Splitting a layer cuts a keyframe segment in two, and each half has to keep
// playing ITS part of the move (keyframeSplit.js). Part of an easing is not itself
// an easing: most named ones play GSAP's own functions (power2.inOut, expo,
// bounce…), which the beziers drawn for them above miss by 2–19%, and even a real
// bezier re-fitted to its part plays back differently (bezierEase solves x to 1e-4).
// So the key keeps its easing and names the part it plays:
//
//   easeSlice: { of: <the key's easing>, from, to, bezier? }
//
// `from`/`to` are fractions of the ORIGINAL segment (0 ≤ from < to ≤ 1), and the
// segment plays (E(from + (to − from)·t) − E(from)) / (E(to) − E(from)). With the
// values the split writes onto the keys, that is the original move exactly.
//
// `of` (plus, for CUSTOM, a copy of the curve) ties the slice to the easing it was
// cut from. Any edit that changes the key's easing (a toolbar pick, a dragged
// handle, an agent's PATCH) leaves a slice that no longer matches, and it is
// ignored from then on and dropped by the next sanitize.
const EASING_VALUES = new Set(Object.values(TransitionEasing));

export function sanitizeEaseSlice(key) {
  const slice = key?.easeSlice;
  if (!slice || typeof slice !== 'object') return null;
  const easing = key.easing;
  if (slice.of !== easing || !EASING_VALUES.has(easing)) return null;
  if (easing === TransitionEasing.LINEAR || easing === TransitionEasing.HOLD) return null;
  const from = Number(slice.from);
  const to = Number(slice.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (from < 0 || to > 1 || !(to - from > 1e-9)) return null;
  if (from === 0 && to === 1) return null;
  if (easing !== TransitionEasing.CUSTOM) return { of: easing, from, to };
  const own = sanitizeBezier(key.bezier);
  const cut = sanitizeBezier(slice.bezier);
  if (!own || !cut || own.some((v, i) => v !== cut[i])) return null;
  return { of: easing, from, to, bezier: cut };
}

// The easing a slice plays, given the WHOLE easing's function.
export function sliceEase(easeFn, from, to) {
  const e0 = easeFn(from);
  const span = easeFn(to) - e0;
  // Both ends at the same eased value: the keys either side hold the same value
  // too, so whatever this returns is multiplied by zero. The split never writes
  // one (keyframeSplit adds a key at the turn instead).
  if (!(Math.abs(span) > 1e-12)) return (t) => t;
  const width = to - from;
  return (t) => (easeFn(from + width * t) - e0) / span;
}

// Formats a curve the way CSS spells it, for the readout in the graph editor.
export function formatBezier(bezier, digits = 2) {
  if (!Array.isArray(bezier)) return '';
  return `cubic-bezier(${bezier.map((n) => Number(n).toFixed(digits)).join(', ')})`;
}
