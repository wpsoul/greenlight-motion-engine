// ── Keyframe track expressions (ƒx): the registry and the profiles ───────────
// (animtools) The pure half of keyframeFx.js, shared by a 2D layer's tracks (keyframeFx.js, positions in % of the clip) and a 3D Scene's
// keys and clocks (world3d/keys.js, times in seconds): the same types, parameters, presets and profile functions, so a Glide, Elastic,
// Spring, Bounce, Wiggle or Custom expression on a Scene key lands where the same ƒx on a layer's track would. It imports only the
// expression language (keyframeExpr.js, itself import-free), so the world's bundle and `node --test` load it without the editor.
import { runExpression, smoothNoise, glideValue, MAX_EXPR_LENGTH } from './keyframeExpr.js';

// Parameter metadata drives the popover UI, the sanitizer clamps and the
// defaults, so the three can never disagree. `def` may be a function of the
// track's property metadata (wiggle's amplitude is in the property's own units,
// so one static default cannot fit both `scale` and `translateX`).
export const KEYFRAME_FX_TYPES = [
  {
    id: 'elastic',
    label: 'Elastic',
    hint: 'The move itself becomes springy: it launches at the key before, overshoots the target and wobbles into place.',
    params: [
      // Percent mix between the plain keyframed motion (0) and the full spring
      // (100); past 100 the spring is extrapolated for exaggeration.
      { key: 'amp', label: 'Strength', min: 0, max: 300, step: 1, def: 100, suffix: '%' },
      // Wobbles across the MOVE, not Hz: the profile is normalized to each
      // segment, so a 0.3s move and a 3s move both read as the same gesture.
      // Lower it for a soft landing that overshoots once around the key; raise
      // it for a fast arrival followed by several wobbles.
      { key: 'freq', label: 'Wobbles', min: 0.3, max: 5, step: 0.1, def: 1.1 },
      // Paired with the default Wobbles this gives a ~10% overshoot that has
      // decayed to under 1% by the key — so a final key still lands on its
      // value — while leaving enough tail to carry into a following segment.
      { key: 'decay', label: 'Decay', min: 0.5, max: 15, step: 0.1, def: 5 },
    ],
  },
  {
    id: 'spring',
    label: 'Spring',
    hint: 'Each move is a real spring: it leaves the key before at rest, overshoots as far as its damping lets it and settles. It runs in seconds, so a short move and a long one ring alike.',
    // The "Easing Lab" board's two springs. They set the spring only, so a
    // tuned Strength survives a switch; the first equals the param defaults.
    presets: [
      { id: 'snappy', label: 'Snappy', hint: '1.6 Hz, damping 0.55: about 12 % overshoot. Buttons, icons, pop-ins', params: { freq: 1.6, damping: 0.55 } },
      { id: 'gentle', label: 'Gentle', hint: '1 Hz, damping 0.8: a 1.5 % overshoot. Mascots, big cards, the camera', params: { freq: 1, damping: 0.8 } },
    ],
    params: [
      { key: 'amp', label: 'Strength', min: 0, max: 300, step: 1, def: 100, suffix: '%' },
      // The spring's natural frequency: higher is quicker. A move settles (within
      // 2 %) in about 4 / (2π · freq · damping) s — Snappy 0.7 s, Gentle 0.8 s —
      // whatever the gap to the next key.
      { key: 'freq', label: 'Frequency', min: 0.1, max: 10, step: 0.05, def: 1.6, suffix: 'Hz' },
      // Damping ratio ζ: lower rings longer and overshoots further; 1 is
      // critically damped (no overshoot at all).
      { key: 'damping', label: 'Damping', min: 0.05, max: 1, step: 0.01, def: 0.55 },
    ],
  },
  {
    id: 'bounce',
    label: 'Bounce',
    hint: 'The move falls onto the target like a dropped ball and rebounds in decaying hops, settling on the key.',
    params: [
      { key: 'amp', label: 'Strength', min: 0, max: 300, step: 1, def: 100, suffix: '%' },
      // How much of the segment the hops occupy vs. the fall — the profile is
      // self-normalizing (fall + every hop fit the move exactly), so no gravity
      // or hop-time knob is needed and it is unit-independent by construction.
      { key: 'elasticity', label: 'Bounciness', min: 5, max: 80, step: 1, def: 45, suffix: '%' },
      { key: 'bounces', label: 'Max Bounces', min: 1, max: 10, step: 1, def: 5 },
    ],
  },
  {
    id: 'wiggle',
    label: 'Wiggle',
    hint: 'Continuous smooth jitter around the keyframed value, like AE wiggle().',
    params: [
      // In the property's own units (AE parity), so the default comes from the
      // property's step: ±10 steps reads as "visible but not violent" everywhere.
      { key: 'amp', label: 'Amplitude', min: 0, max: 2000, step: 0.1, def: (meta) => defaultWiggleAmp(meta) },
      { key: 'freq', label: 'Frequency', min: 0.1, max: 20, step: 0.1, def: 3, suffix: 'Hz' },
    ],
  },
  {
    id: 'glide',
    label: 'Glide',
    hint: 'The move lands soft and keeps sliding on in the direction it travelled, never past the key and never back. On a camera it keeps the shot alive between keys.',
    // One-click starting points, shown as tags above the options. The four
    // landings tuned on the owner's "Easing examples" board (rows 3–6); a preset
    // only sets the params, so every option stays free to change afterwards. The
    // first equals the param defaults, so a fresh Glide opens on it.
    presets: [
      { id: 'soft', label: 'Soft', hint: 'Lands soft and keeps sliding a little (Easing examples row 3)', params: { fast: 0.1, slow: 0.6, weight: 25, delay: 0 } },
      { id: 'floaty', label: 'Floaty', hint: 'A heavier tail: a floatier, longer landing (row 4)', params: { fast: 0.1, slow: 1, weight: 40, delay: 0 } },
      { id: 'trailing', label: 'Trailing', hint: 'The last quarter of the move starts 0.1 s late, like an AE null chain (row 5)', params: { fast: 0.1, slow: 0.45, weight: 25, delay: 0.1 } },
      { id: 'endless', label: 'Endless', hint: 'A long, light tail that never visibly stops before the next move (row 6)', params: { fast: 0.1, slow: 2, weight: 14, delay: 0 } },
    ],
    params: [
      // Time constant of the part that tracks the keys. Keep it near 0.1 s so
      // most of the move still arrives on time.
      { key: 'fast', label: 'Response', min: 0.01, max: 3, step: 0.01, def: 0.1, suffix: 's' },
      // Time constant of the slow tail — how long the drift keeps going.
      { key: 'slow', label: 'Tail Length', min: 0.05, max: 8, step: 0.05, def: 0.6, suffix: 's' },
      // Share of every move carried by the tail (glide()'s `weight` × 100).
      { key: 'weight', label: 'Tail Share', min: 0, max: 100, step: 1, def: 25, suffix: '%' },
      // How much later the tail starts than the fast part.
      { key: 'delay', label: 'Tail Delay', min: 0, max: 3, step: 0.01, def: 0, suffix: 's' },
    ],
  },
  {
    id: 'custom',
    label: 'Custom',
    hint: 'Write your own expression. The result becomes the property value.',
    params: [
      // The one non-numeric param in the registry: `kind: code` switches the
      // panel to a textarea + snippet picker, and the sanitizer to a length-capped
      // string. See keyframeExpr.js for the language.
      { key: 'code', label: 'Expression', kind: 'code', def: 'value' },
    ],
  },
];

export function keyframeFxType(id) {
  return KEYFRAME_FX_TYPES.find((t) => t.id === id) || null;
}

export function defaultWiggleAmp(meta) {
  const step = Number(meta?.step);
  if (!Number.isFinite(step) || step <= 0) return 10;
  return Math.min(2000, step * 10);
}

export function paramDefault(param, propMeta) {
  return typeof param.def === 'function' ? param.def(propMeta) : param.def;
}


export function numOr(v, fallback) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

// Damped sinusoid step response. f(0) = 0, f(∞) = 1; it crosses the target at
// u = 1/(4·wobbles), peaks half a period later, then rings down under the
// e^(−decay·u) envelope. Envelope and frequency are independent (unlike a real
// mass-spring), which is what lets a slow arrival still wobble quickly.
export function elasticProfile(u, wobbles, decay) {
  if (u <= 0) return 0;
  if (decay * u > 6.9) return 1; // envelope below 0.1% — settled
  return 1 - Math.exp(-decay * u) * Math.cos(2 * Math.PI * wobbles * u);
}

// Ball-drop profile: accelerate onto the target, then rebound in hops that lose
// `e` of their speed each time. Self-normalizing — the fall plus every hop are
// scaled to fit exactly in u = [0, 1], so the motion settles ON the key with no
// gravity or hop-duration knob to tune.
export function bounceProfile(u, e, nMax) {
  if (u <= 0) return 0;
  // Total = fall + Σ hops = T0·(1 + 2e(1−e^n)/(1−e)) ≡ 1.
  const hopSum = (2 * e * (1 - Math.pow(e, nMax))) / (1 - e);
  const T0 = 1 / (1 + hopSum);
  if (u >= 1) return 1;
  if (u < T0) {
    const r = u / T0;
    return r * r; // ½gu² with g chosen so the fall covers 1 in T0
  }
  const g = 2 / (T0 * T0);
  const v = g * T0;
  let vk = v * e;
  let hop = (2 * vk) / g;
  let tb = u - T0;
  let nb = 1;
  while (tb > hop && nb <= nMax) {
    tb -= hop;
    vk *= e;
    hop *= e;
    nb += 1;
  }
  if (nb > nMax) return 1;
  // Rebound travels back the way it came, so it subtracts from the target.
  return 1 - (vk * tb - (g * tb * tb) / 2);
}

// Spring step response, `tSec` seconds after the key the move leaves from — a damped
// harmonic oscillator released at rest:
//   x(t) = 1 − e^(−ζωt)·(cos ω_d t + ζω/ω_d · sin ω_d t),  ω = 2πf, ω_d = ω·√(1 − ζ²)
// It leaves at zero speed and peaks at 1 + e^(−ζπ/√(1−ζ²)) when t = π/ω_d. Unlike the
// two profiles above it is NOT normalized to the segment: the gap to the next key does
// not change the shape, only where the next step starts.
export function springProfile(tSec, freq, damping) {
  if (tSec <= 0) return 0;
  const w = 2 * Math.PI * freq;
  const zw = damping * w;
  if (zw * tSec > 14) return 1; // envelope below 1e-6 even with the 1/√(1−ζ²) gain near ζ = 1
  if (damping >= 0.999) return 1 - Math.exp(-w * tSec) * (1 + w * tSec); // critically damped
  const wd = w * Math.sqrt(1 - damping * damping);
  return 1 - Math.exp(-zw * tSec) * (Math.cos(wd * tSec) + (zw / wd) * Math.sin(wd * tSec));
}


// Superpose every key's step through `profile` (keys in seconds), then mix with the base: keyframeFx.js profiledValue with the positions
// already in seconds (its own converts them the same way), so a Scene key and a layer's track ring alike.
function profiledSeconds(keys, t, base, strength, profile) {
  if (keys.length < 2 || !(strength > 0)) return base;
  let value = numOr(keys[0].v, NaN);
  if (!Number.isFinite(value)) return base;
  for (let i = 1; i < keys.length; i += 1) {
    const prev = numOr(keys[i - 1].v, NaN);
    const cur = numOr(keys[i].v, NaN);
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) return base;
    const step = cur - prev;
    if (step === 0) continue; // a hold never wobbles
    const tPrev = Number(keys[i - 1].t);
    const segSec = Number(keys[i].t) - tPrev;
    if (!(segSec > 0)) continue;
    value += step * profile((t - tPrev) / segSec, segSec);
  }
  return base + strength * (value - base);
}

/**
 * (animtools) An ƒx config as a 3D Scene writes it, made whole: `{ "<type>": params }`, where params is an object of the editor's
 * parameters (the same names and units as a layer's ƒx: Glide's `weight` in percent), a preset's id (`{ "glide": "soft" }`), `true`
 * (the defaults), or for Custom the expression's text (`{ "custom": "value + 0.1 * sin(time * 3)" }`). Numbers are clamped into the
 * registry's ranges and missing ones take its defaults, as keyframeFx.js sanitizeKeyframeFxMap does; `meta` ({ step }) sizes Wiggle's
 * default amplitude to the field. Null for anything else.
 */
export function fxConfigOf(spec, meta = null) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const names = Object.keys(spec);
  if (names.length !== 1) return null;
  const type = keyframeFxType(names[0]);
  if (!type) return null;
  let given = spec[names[0]];
  if (typeof given === 'string' && type.id !== 'custom') given = type.presets?.find((p) => p.id === given)?.params ?? null;
  else if (typeof given === 'string') given = { code: given };
  else if (given === true) given = {};
  if (!given || typeof given !== 'object') return null;
  const params = {};
  for (const p of type.params) {
    const fallback = paramDefault(p, meta);
    if (p.kind === 'code') { params[p.key] = typeof given[p.key] === 'string' ? given[p.key].slice(0, MAX_EXPR_LENGTH) : fallback; continue; }
    const v = Number.parseFloat(given[p.key]);
    params[p.key] = Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : fallback;
  }
  return { type: type.id, params };
}

/**
 * (animtools) One ƒx on a track keyed in SECONDS (a 3D Scene's keys and clocks), by the same rules as keyframeFx.js evaluateKeyframeFx on
 * a layer's track: Elastic, Bounce and Spring reshape each key's move, Glide softens the keyed motion through glideValue (the very
 * filter of the editor's Glide and of `glide()`), Wiggle adds the editor's noise, Custom replaces the value with its expression's.
 *   cfg      fxConfigOf's { type, params }
 *   keys     the track's keys in time order: [{ t, v }], v a number (one component of a vector track)
 *   valueAt  (t) → the plain keyed value at t (the keys with their eases), what Glide and loopOut / valueAtTime read
 *   t        seconds; base: valueAt(t); seed: an integer (Wiggle, random()); fps, duration: for a Custom expression's `frame`
 */
export function fxAtSeconds(cfg, { keys, valueAt, t, base, seed = 0, fps = 30, duration = 0 }) {
  if (!cfg || !Array.isArray(keys) || !keys.length || !Number.isFinite(base)) return base;
  const p = cfg.params || {};
  switch (cfg.type) {
    case 'elastic': return profiledSeconds(keys, t, base, p.amp / 100, (u) => elasticProfile(u, p.freq, p.decay));
    case 'spring': return profiledSeconds(keys, t, base, p.amp / 100, (u, segSec) => springProfile(u * segSec, p.freq, p.damping));
    case 'bounce': {
      const e = Math.min(0.95, Math.max(0.01, p.elasticity / 100));
      const nMax = Math.max(1, Math.round(p.bounces));
      return profiledSeconds(keys, t, base, p.amp / 100, (u) => bounceProfile(u, e, nMax));
    }
    case 'wiggle': return p.amp > 0 ? base + p.amp * smoothNoise(t * p.freq, seed) : base;
    case 'glide': return glideValue({ value: base, time: t, valueAt }, p.fast, p.slow, p.weight / 100, p.delay);
    case 'custom': {
      const keyTimes = keys.map((k) => Number(k.t)).filter(Number.isFinite);
      return runExpression(p.code, {
        value: base, time: t, frame: Math.floor(t * fps + 1e-6), fps, duration, progress: duration > 0 ? Math.max(0, Math.min(1, t / duration)) : 0,
        index: 0, seed, keyTimes, valueAt, resolveLayer: () => null, resolveSelf: () => null,
      }).value;
    }
    default: return base;
  }
}
