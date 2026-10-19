// Speed profiles for the Lines Draw overlay effect (id 'linesDraw').
//
// The meshline "follow" accumulation the effect ports is speed-driven: the trail
// widens and stretches while the head moves fast, and collapses to a dot when it
// stops. On a baked outline there is no mouse — the head's speed is the DERIVATIVE
// of an eased lap progress u(t). Everything here is a pure function of clip time,
// so range renders cold-start bit-identically (no spring/lerp state to warm up —
// the same reason Neon Glow pre-integrates its rate tracks instead of simulating).
//
// This module is a leaf (imports appEases + types only) so `node --test` can load it.

import { namedEase } from './appEases.js';
import { TransitionEasing } from './types.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t) => {
  const c1 = 2.4;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

// K sprints per lap: hold, then an eased dash to the next stop.
function dashProfile(t, K, hold, ease) {
  const seg = 1 / K;
  const i = Math.min(K - 1, Math.floor(t / seg));
  let u = (t - i * seg) / seg;
  u = u < hold ? 0 : (u - hold) / (1 - hold);
  return (i + ease(u)) / K;
}

// piecewise [t0, t1, u0, u1, ease?] segments; a missing ease holds at u0.
function piecewise(t, segs) {
  for (const [t0, t1, u0, u1, ease] of segs) {
    if (t <= t1 || t1 === 1) {
      if (t < t0) return u0;
      if (u0 === u1 || !ease) return u0;
      return u0 + (u1 - u0) * ease((t - t0) / (t1 - t0));
    }
  }
  return 1;
}

// The curves the editor plays for these names (appEases), not the graph editor's
// traced handles — Expo/Back Smooth used to run up to 0.13 off (14.0.18).
const aeSmooth = namedEase(TransitionEasing.AE_SMOOTH);
const aeIn = namedEase(TransitionEasing.AE_IN);
const aeOut = namedEase(TransitionEasing.AE_OUT);
const natural = namedEase(TransitionEasing.NATURAL);
const expoInOut = namedEase(TransitionEasing.EXPO_IN_OUT);
const backInOut = namedEase(TransitionEasing.BACK_IN_OUT);

// Order is the select's value — append only, never reorder (saved projects
// store the index).
const PROFILE_FNS = [
  aeSmooth,
  aeIn,
  aeOut,
  easeInOutCubic,
  natural,
  expoInOut,
  backInOut,
  (t) => dashProfile(t, 3, 0.42, easeInOutCubic),           // Dash & Pause
  (t) => dashProfile(t, 3, 0.38, easeOutBack),              // Elastic Stops
  (t) => dashProfile(t, 6, 0.3, easeInOutCubic),            // Stutter
  (t) => piecewise(t, [                                     // Heartbeat
    [0, 0.10, 0, 0.45, easeInOutCubic],
    [0.10, 0.20, 0.45, 0.45],
    [0.20, 0.30, 0.45, 0.90, easeInOutCubic],
    [0.30, 0.86, 0.90, 0.90],
    [0.86, 1, 0.90, 1, easeInOutCubic],
  ]),
  (t) => (t >= 1 ? 1 : (1 - Math.pow(2, -10 * t)) / (1 - Math.pow(2, -10))),  // Sprint & Drift
  (t) => (t <= 0 ? 0 : (Math.pow(2, 10 * (t - 1)) - Math.pow(2, -10)) / (1 - Math.pow(2, -10))), // Wind-up Blast
  // u' = 1 + A·cos(2πkt) integrated → monotonic sinusoidal fast/slow/fast (A<1)
  (t) => t + 0.9 * Math.sin(2 * Math.PI * 2 * t) / (2 * Math.PI * 2),         // Surge
  (t) => {                                                  // Chaos — sum-of-sines
    const A = [0.55, 0.3, 0.18];
    const K = [2, 5, 9];
    const PH = [1.3, 4.1, 0.7];
    let u = t;
    // the -sin(φ) terms keep u(0)=0 and u(1)=1 so laps chain continuously
    for (let i = 0; i < 3; i++) {
      u += A[i] * (Math.sin(2 * Math.PI * K[i] * t + PH[i]) - Math.sin(PH[i])) / (2 * Math.PI * K[i]);
    }
    return u;
  },
  (t) => t,                                                 // Linear
];

export const LINES_DRAW_PROFILE_OPTIONS = [
  { value: 0, label: 'AE Smooth' },
  { value: 1, label: 'AE In' },
  { value: 2, label: 'AE Out' },
  { value: 3, label: 'Cubic In-Out' },
  { value: 4, label: 'Natural' },
  { value: 5, label: 'Expo In-Out' },
  { value: 6, label: 'Back In-Out' },
  { value: 7, label: 'Dash & Pause' },
  { value: 8, label: 'Elastic Stops' },
  { value: 9, label: 'Stutter' },
  { value: 10, label: 'Heartbeat' },
  { value: 11, label: 'Sprint & Drift' },
  { value: 12, label: 'Wind-up Blast' },
  { value: 13, label: 'Surge' },
  { value: 14, label: 'Chaos' },
  { value: 15, label: 'Linear' },
];

export function linesDrawProgress(profile, t) {
  const fn = PROFILE_FNS[profile | 0] || PROFILE_FNS[0];
  return fn(clamp(t, 0, 1));
}

// Cumulative arc distance travelled, in laps: `laps + u(t within lap)`. This is
// continuous across lap boundaries for BOTH topologies (u(0)=0, u(1)=1), so it
// is safe to finite-difference for speed. Position differs: a closed outline
// chains laps end to end (the shader wraps with fract, the outline is periodic
// so position stays continuous); an open outline ping-pongs — even laps run
// forward, odd laps backward — so there is never a teleport, and the natural
// stop at each reversal is exactly the collapse the effect wants.
function totalDistance(profile, time, lap) {
  const laps = Math.floor(time / lap);
  return laps + linesDrawProgress(profile, time / lap - laps);
}

// Head position at `time` under a travel mode: 0 = Forward (each lap restarts
// at the start; eased profiles have already collapsed the trail at the lap end
// so the restart is invisible), 1 = Backward, 2 = Ping-Pong (alternate laps
// reverse). Closed outlines return unwrapped cumulative distance for the
// directional modes (the shader wraps with fract, negative values included).
function headAt(profile, time, lap, closed, mode) {
  const tc = Math.max(0, time);
  const laps = Math.floor(tc / lap);
  const u = clamp(linesDrawProgress(profile, tc / lap - laps), 0, 1);
  if (mode === 2) return laps % 2 === 1 ? 1 - u : u;
  if (closed) return mode === 1 ? -(laps + u) : laps + u;
  return mode === 1 ? 1 - u : u;
}

// Per-frame runner state for one 'linesDraw' instance: the head phase and the
// speed-derived width factor. `params` are the resolved effect params, `time`
// is clip-local seconds already rebased onto the effect's active range.
//
// pathAux is SIGNED: |value| is the width factor (0..1) and the sign is the
// head's direction of travel along the arc, so the shader can keep the trail
// BEHIND the head — on an open outline's return leg (and through an overshoot
// profile's backtrack) the ribbon must swing to the other side, not lead.
export function linesDrawRunnerState(params, time, closed) {
  const lap = clamp(Number(params.ldLapDur) || 2, 0.2, 30);
  const profile = Number(params.ldProfile) | 0;
  const gain = clamp(Number(params.ldSpeedGain) || 1, 0.05, 5);
  const minF = clamp((Number(params.ldMinWidth) || 0) / 100, 0, 1);
  // The lab's width-smoothing lerp, as a trailing finite-difference window.
  const smoothWin = clamp(Number(params.ldSmooth) || 0.12, 0.02, 0.5);
  const t = Math.max(0, Number(time) || 0);

  // 0 = Forward (default), 1 = Backward, 2 = Ping-Pong.
  const mode = Number(params.ldDirection) | 0;

  const w = Math.min(smoothWin, Math.max(t, 1e-3));
  const D = totalDistance(profile, t, lap);
  const v = Math.abs(D - totalDistance(profile, t - w, lap)) / w;
  // v·lap is pace relative to a constant-speed lap (1 = linear). ×0.5 puts
  // linear at half width and AE Smooth's mid-lap sprint at full.
  const widthFactor = clamp(v * lap * gain * 0.5, minF, 1);

  const head = headAt(profile, t, lap, closed, mode);
  // Direction from actual head displacement, so the ping-pong reversal AND
  // non-monotonic profiles both flip the trail side. NO modular wrapping here:
  // a steep profile legitimately moves more than half the path within the
  // smoothing window, and folding that delta flipped the trail side at peak
  // speed (mid-lap "jumping"). The only non-motion jump is the one-direction
  // lap-restart teleport on an OPEN outline (~±1) — detect it by size and use
  // the mode's intrinsic direction; closed one-direction phase is cumulative
  // and never jumps.
  let delta = head - headAt(profile, t - w, lap, closed, mode);
  if (!closed && mode !== 2 && Math.abs(delta) > 0.5) delta = mode === 1 ? -1 : 1;
  const dir = delta === 0 ? (mode === 1 ? -1 : 1) : (delta < 0 ? -1 : 1);

  return { pathPhase: head, pathMoving: true, pathAux: widthFactor * dir };
}
