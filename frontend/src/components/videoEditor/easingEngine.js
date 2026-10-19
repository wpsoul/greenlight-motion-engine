/*
 * GreenLight's own easing engine: an ease NAME → an easing function (t in 0..1 → progress).
 * No dependencies, so the generator, node tests and any engine bundle can load it.
 *
 * It speaks GSAP's ease names — `power2.out`, `back.inOut`, `elastic.out(1, 0.3)` — because
 * projects, GSAP_EASE_NAMES and capabilities.json already store those strings and agents know
 * them, and it returns the same curves: tests/easing-engine/parity.test.mjs holds every family
 * to GSAP 3.14.2's own numbers. GSAP itself is no longer a dependency.
 *
 *   parseEase('power3.inOut')        → fn          a family + .in / .out / .inOut
 *   parseEase('sine')                → fn          a bare family name is its .out (GSAP's rule)
 *   parseEase('back.out(2.5)')       → fn          back(overshoot), elastic(amplitude, period)
 *   parseEase('aeSmooth')            → fn          anything added with registerEase
 *   parseEase(fn)                    → fn          a function passes through
 *   parseEase('nope')                → undefined   unknown names resolve to nothing, like GSAP
 *
 * The app's own curves (aeIn/aeSmooth/aeOut, the mf* MotionFast curves) are registered by
 * gsapTransitions.js, which owns them.
 */

const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;

// How a family's other two curves follow from the one it defines. Kept in exactly this
// arithmetic: the parity test compares to the last bit, and `1 - p * 2` vs `1 - 2 * p` can differ.
const outFromIn = (easeIn) => (p) => 1 - easeIn(1 - p);
const inOutFromIn = (easeIn) => (p) => (p < 0.5 ? easeIn(p * 2) / 2 : 1 - easeIn((1 - p) * 2) / 2);
const inOutFromOut = (easeOut) => (p) => (p < 0.5 ? (1 - easeOut(1 - (p * 2))) / 2 : 0.5 + easeOut((p - 0.5) * 2) / 2);

const family = (easeIn, easeOut = outFromIn(easeIn), easeInOut = inOutFromIn(easeIn)) => (
  { in: easeIn, out: easeOut, inOut: easeInOut }
);

// power0…power4: progress raised to 1…5 (power0 = linear, power2 = cubic).
function powerFamily(n) {
  const power = n + 1;
  return family(
    n ? (p) => p ** power : (p) => p,
    (p) => 1 - (1 - p) ** power,
    (p) => (p < 0.5 ? (p * 2) ** power / 2 : 1 - ((1 - p) * 2) ** power / 2),
  );
}

// Back overshoots by `overshoot` (1.70158 = 10 % past the target, the classic value).
function backFamily(overshoot = 1.70158) {
  const easeIn = (p) => (p ? p * p * ((overshoot + 1) * p - overshoot) : 0);
  return family(easeIn, outFromIn(easeIn), inOutFromIn(easeIn));
}

// Elastic: `amplitude` ≥ 1 swings further; below 1 it only tightens the period, because the
// curve would otherwise start away from 0. `period` is the swing length (0.3; 0.45 for inOut).
function elasticCurve(kind, amplitude, period) {
  const p1 = amplitude >= 1 ? amplitude : 1;
  let p2 = (period || (kind !== 'inOut' ? 0.3 : 0.45)) / (amplitude < 1 ? amplitude : 1);
  const p3 = (p2 / TWO_PI) * (Math.asin(1 / p1) || 0);
  p2 = TWO_PI / p2;
  const easeOut = (p) => (p === 1 ? 1 : p1 * (2 ** (-10 * p)) * Math.sin((p - p3) * p2) + 1);
  if (kind === 'out') return easeOut;
  if (kind === 'in') return (p) => 1 - easeOut(1 - p);
  return inOutFromOut(easeOut);
}

function elasticFamily(amplitude, period) {
  return {
    in: elasticCurve('in', amplitude, period),
    out: elasticCurve('out', amplitude, period),
    inOut: elasticCurve('inOut', amplitude, period),
  };
}

// Bounce: four parabolic hops settling on 1.
function bounceOut(p) {
  const n = 7.5625;
  const c = 2.75;
  if (p < 1 / c) return n * p * p;
  if (p < 2 / c) return n * (p - 1.5 / c) ** 2 + 0.75;
  if (p < 2.5 / c) return n * (p - 2.25 / c) ** 2 + 0.9375;
  return n * (p - 2.625 / c) ** 2 + 0.984375;
}
const bounceIn = (p) => 1 - bounceOut(1 - p);

const FAMILIES = {
  power0: powerFamily(0),
  power1: powerFamily(1),
  power2: powerFamily(2),
  power3: powerFamily(3),
  power4: powerFamily(4),
  sine: family((p) => (p === 1 ? 1 : -Math.cos(p * HALF_PI) + 1)),
  // Blended so it lands exactly on 0 and 1; the plain 2^(10(p-1)) starts at 0.001 and is
  // not the curve projects have been playing (GSAP 3 blends it the same way).
  expo: family((p) => 2 ** (10 * (p - 1)) * p + p ** 6 * (1 - p)),
  circ: family((p) => -(Math.sqrt(1 - (p * p)) - 1)),
  back: backFamily(),
  elastic: elasticFamily(),
  bounce: family(bounceIn, bounceOut),
};
FAMILIES.linear = FAMILIES.power0;

// The families that take parameters, and what they take.
const CONFIGURABLE = {
  back: (overshoot) => backFamily(overshoot),
  elastic: (amplitude, period) => elasticFamily(amplitude, period),
};

const registry = new Map([['none', FAMILIES.power0.in]]);
for (const [name, curves] of Object.entries(FAMILIES)) {
  registry.set(name, curves.out);
  for (const kind of ['in', 'out', 'inOut']) registry.set(`${name}.${kind}`, curves[kind]);
}

/**
 * A CSS-style cubic-bezier ease (x = time, y = progress): what a Custom keyframe, the AE
 * curves and every MotionFast bezier play. Moved here unchanged from motionTemplates/mtl.js
 * (which re-exports it): solves x by bisection to 1e-4, so changing the tolerance changes
 * how saved projects move.
 */
export function bezierEase(p1x, p1y, p2x, p2y) {
  const bx = (t) => 3 * p1x * t * (1 - t) * (1 - t) + 3 * p2x * t * t * (1 - t) + t * t * t;
  const by = (t) => 3 * p1y * t * (1 - t) * (1 - t) + 3 * p2y * t * t * (1 - t) + t * t * t;
  return (x) => {
    x = Math.max(0, Math.min(1, x));
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 24; i++) {
      const cx = bx(t);
      if (Math.abs(cx - x) < 1e-4) break;
      if (cx < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return by(t);
  };
}

/** Adds (or replaces) a named ease, so parseEase(name) returns `fn`. */
export function registerEase(name, fn) {
  if (typeof name !== 'string' || !name || typeof fn !== 'function') {
    throw new Error('registerEase needs a name and an easing function');
  }
  registry.set(name, fn);
}

// "back.out(2.5)" / "elastic.inOut(1, 0.45)" → that family's curve with those parameters.
const CONFIGURED = /^([a-z]+\d?)\.(in|out|inOut)\(([^)]*)\)$/;

function configuredEase(name) {
  const m = CONFIGURED.exec(name.replace(/\s+/g, ''));
  if (!m || !CONFIGURABLE[m[1]]) return undefined;
  const args = m[3] === '' ? [] : m[3].split(',').map(Number);
  if (args.some((a) => !Number.isFinite(a))) return undefined;
  return CONFIGURABLE[m[1]](...args)[m[2]];
}

/**
 * The easing function for `ease`: a name, a configured name or a function (returned as is).
 * Unknown names give undefined, so a caller picks its own fallback.
 */
export function parseEase(ease) {
  if (typeof ease === 'function') return ease;
  if (typeof ease !== 'string' || !ease) return undefined;
  let fn = registry.get(ease);
  if (!fn && ease.includes('(')) {
    fn = configuredEase(ease);
    if (fn) registry.set(ease, fn);
  }
  return fn;
}
