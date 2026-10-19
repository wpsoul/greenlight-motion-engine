// Force-field patterns for the particle solver.
//
// A leaf module like rng.js — no DOM, no three.js — because the solver, the bake
// worker and the tests all need it and none of them may pull in the editor.
//
// TWO KINDS OF NOISE, ON PURPOSE
// ------------------------------
//   * `curlSines` (in rng.js as `turbulence`) is the SHIPPED field: the curl of a
//     sum-of-sines potential. Twelve sines per particle-step, divergence-free
//     enough to swirl rather than pump, and nothing to keep in sync with a future
//     GPU path. It is what every project saved before schema 2 looks like, so it
//     is still here, unchanged, as pattern 'smooth'.
//   * `vnoise3` is hash-based value noise — the bake-side twin of the one in
//     model3dGrowFill.js. Billow, Ridged and Swirl need octaves and a shaping
//     function, which a closed form cannot give you.
//
// PATTERN GAIN
// ------------
// Each pattern is scaled so the same `strength` reads roughly the same on screen.
// Without it, swapping Smooth (whose per-axis output spans ±2) for Billow (±1)
// silently halves the motion and the user re-tunes a number that should not have
// moved. The constants below are the measured RMS ratios — see fields.test.mjs.

import { turbulence as curlSines } from './rng.js';

export const PARTICLE_TURBULENCE_PATTERNS = ['smooth', 'billow', 'ridged', 'swirl', 'wave'];
export const PARTICLE_FIELD_MODES = ['vortex', 'orbit', 'twist', 'attract', 'repel'];
export const PARTICLE_FIELD_AXES = ['x', 'y', 'z'];

const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;

/** 3D integer hash -> [0,1). */
function ihash3(x, y, z, s) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + s * 974711369) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 3D value noise in [0,1). Deterministic, table-free, portable. */
export function vnoise3(x, y, z, s) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let xf = x - xi, yf = y - yi, zf = z - zi;
  xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf); zf = zf * zf * (3 - 2 * zf);
  const c = (dx, dy, dz) => ihash3(xi + dx, yi + dy, zi + dz, s);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), xf), lerp(c(0, 1, 0), c(1, 1, 0), xf), yf),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), xf), lerp(c(0, 1, 1), c(1, 1, 1), xf), yf),
    zf,
  );
}

/**
 * Fractal value noise in [0,1].
 * shape: 0 smooth · 1 billow (|2n-1|) · 2 ridged (1-|2n-1|) — the same three the
 * Turbulent Displace shader uses, so the words mean the same thing in both.
 */
export function fbm3(x, y, z, s, oct, shape) {
  let v = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < oct; i++) {
    let n = vnoise3(x, y, z, s + i * 17);
    if (shape === 1) n = Math.abs(n * 2 - 1);
    else if (shape === 2) n = 1 - Math.abs(n * 2 - 1);
    v += n * amp; norm += amp;
    x = x * 2.03 + 7.1; y = y * 2.03 - 3.7; z = z * 2.03 + 1.9;
    amp *= 0.5;
  }
  return v / Math.max(norm, 1e-4);
}

// Measured so one Strength reads the same across patterns (fields.test.mjs).
const GAIN = { billow: 2.03, ridged: 2.03, swirl: 1.33, wave: 2.24 };

/**
 * Turbulence acceleration at a point, in the solver's local space.
 * Writes ax/ay/az into `out` (length 3) to stay allocation-free.
 *
 * `t` is clip-local seconds; `phase` is the caller's per-particle decorrelation.
 */
export function turbulenceAccel(out, T, x, y, z, t, phase) {
  const scale = T.scale;
  const evo = t * T.speed;

  if (T.pattern === 'smooth' || !T.pattern) {
    curlSines(out, x, y, z, evo, scale, phase);
    return;
  }

  if (T.pattern === 'wave') {
    // A coherent travelling wave rather than noise: every particle on the same
    // wavefront is pushed the same way, which is what reads as a RIPPLE crossing
    // the cloud instead of a boil. The push is perpendicular to travel, like a
    // real transverse wave — pushing along it just bunches particles up.
    const a = (T.direction || 0) * DEG;
    const dx = Math.cos(a), dy = Math.sin(a);
    const ph = (x * dx + y * dy) * scale * 6 - evo * 3 + phase * 0.15;
    const s = Math.sin(ph);
    out[0] = -dy * s * GAIN.wave;
    out[1] = dx * s * GAIN.wave;
    out[2] = Math.sin(ph * 0.6 + z * scale * 3) * 0.45 * GAIN.wave;
    return;
  }

  const oct = Math.max(1, Math.min(6, Math.round(T.complexity || 3)));
  const s = scale * 1.6;
  const px = x * s, py = y * s, pz = z * s;
  const et = evo * 0.35;
  const seed = T.seedOffset || 5;

  if (T.pattern === 'swirl') {
    // Curl of the fbm potential: divergence-free, so the cloud ROTATES in eddies
    // at every octave instead of being compressed into the low spots.
    const e = 0.55;
    const n = (ax, ay, az) => fbm3(px + ax, py + ay, pz + az + et, seed, oct, 0);
    const g = GAIN.swirl * 3.2;
    out[0] = ((n(0, e, 0) - n(0, -e, 0)) - (n(0, 0, e) - n(0, 0, -e))) * g;
    out[1] = ((n(0, 0, e) - n(0, 0, -e)) - (n(e, 0, 0) - n(-e, 0, 0))) * g;
    out[2] = ((n(e, 0, 0) - n(-e, 0, 0)) - (n(0, e, 0) - n(0, -e, 0))) * g;
    return;
  }

  const shape = T.pattern === 'ridged' ? 2 : 1;
  const g = GAIN.billow;
  out[0] = (fbm3(px, py, pz + et, seed, oct, shape) * 2 - 1) * g;
  out[1] = (fbm3(px + 41.7, py - 17.3, pz + et, seed + 91, oct, shape) * 2 - 1) * g;
  out[2] = (fbm3(px - 23.1, py + 63.9, pz + et, seed + 173, oct, shape) * 2 - 1) * g;
}

/**
 * The radial/tangential field — what used to be "vortex", now one axis and five
 * behaviours.
 *
 * 'vortex' is the shipped one, tangential about the box's own axis with a gentle
 * inward bias so the swirl gathers instead of flinging outward, and its numbers
 * are untouched because it is what saved projects look like.
 *
 * `V.strength` is already the acceleration; the caller multiplies by dt.
 */
export function fieldAccel(out, V, x, y, z) {
  // The two components in the plane perpendicular to the axis.
  let ax, ay;
  if (V.axis === 'x') { ax = y; ay = z; }
  else if (V.axis === 'z') { ax = x; ay = y; }
  else { ax = x; ay = z; }

  const r = Math.hypot(ax, ay) || 1e-3;
  const k = r / Math.max(1, V.scale);
  const fall = 1 / (1 + k * k);
  const s = V.strength * fall;
  const rx = ax / r, ry = ay / r;   // unit radial
  const tx = -ry, ty = rx;          // unit tangential

  let u = 0, v = 0, w = 0;          // plane-x, plane-y, along the axis
  if (V.mode === 'attract') { u = -rx * s; v = -ry * s; }
  else if (V.mode === 'repel') { u = rx * s; v = ry * s; }
  else if (V.mode === 'orbit') { u = tx * s; v = ty * s; }
  else if (V.mode === 'twist') {
    u = tx * s; v = ty * s;
    // Lift along the axis, strongest at the eye: the funnel a "twister" needs.
    // Without it a vortex is a flat carousel.
    w = s * (V.lift ?? 0.5) * fall;
  } else {
    u = tx * s - rx * s * 0.18;
    v = ty * s - ry * s * 0.18;
  }

  if (V.axis === 'x') { out[0] = w; out[1] = u; out[2] = v; }
  else if (V.axis === 'z') { out[0] = u; out[1] = v; out[2] = w; }
  else { out[0] = u; out[1] = w; out[2] = v; }
}
