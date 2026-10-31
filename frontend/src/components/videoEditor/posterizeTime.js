// Posterize Time — a per-LAYER typed effect (item.layerEffects, like Motion Blur):
// the layer updates only N times a second while the project plays at full rate —
// the stop-motion / on-twos look. Everything the layer shows is sampled at the
// held instant: its video or image-sequence frame, keyframes (transform, effect
// params, masks, the motion path and its progress), text animators, nested
// sequences and particles. Sound is not: it keeps playing at the real time.
//
// It is a CLOCK, not a pixel pass: the renderer asks posterizedTimeInClip for the
// layer's local time and everything downstream follows. No pass, no target, no
// texture — a layer without the effect pays one array scan.
//
// The rate is keyframable (`ptFps`). A keyed rate is INTEGRATED (phase = ∫rate),
// never sampled and multiplied, so a ramp from 6 to 24 fps speeds the steps up
// smoothly instead of jumping back in time when the value changes.

// Dependency-free on purpose (it is imported by the sanitizer and plain-node tests):
// the keyframe-rate integrator (gsapTransitions.js integratePathRate) is handed over
// once at that module's import time, the setKeyframeTrackSampler pattern. Without
// it a keyed rate falls back to its stored value.
let integrateRate = null;
export function setPosterizeRateIntegrator(fn) {
  integrateRate = typeof fn === 'function' ? fn : null;
}

export const POSTERIZE_TIME_EFFECT_ID = 'posterizeTime';

// Stored in item.layerEffects as one { id, eid, enabled, params } entry. The `pt`
// prefix routes panel writes into that entry (see LayerEffectsSection).
export const PT_DEFAULTS = {
  ptFps: 12, // updates per second
};

export const PT_NUMBER_FIELDS = [
  { key: 'ptFps', label: 'Frame Rate', min: 1, max: 60, step: 1, suffix: 'fps', kf: true },
];

// Keyframable params, registered in keyframeProps.js.
export const PT_KF_KEYS = PT_NUMBER_FIELDS.filter((f) => f.kf).map((f) => f.key);

const clampRate = (v) => Math.min(120, Math.max(0.5, Number.isFinite(v) ? v : PT_DEFAULTS.ptFps));

export function getPosterizeTimeEffect(item) {
  const list = item?.layerEffects;
  if (!Array.isArray(list) || !list.length) return null;
  return list.find((effect) => effect?.id === POSTERIZE_TIME_EFFECT_ID) || null;
}

export function isPosterizeTimeEnabled(item) {
  const effect = getPosterizeTimeEffect(item);
  return !!effect && effect.enabled !== false;
}

/**
 * The layer's local time at the held step. `timeInClip` is seconds since the
 * layer started on the timeline, `duration` its placed length (the span a keyed
 * rate is integrated over). Returns `timeInClip` unchanged when the effect is
 * off — the only cost then is getPosterizeTimeEffect's scan.
 */
export function posterizedTimeInClip(item, timeInClip, duration = 0) {
  const effect = getPosterizeTimeEffect(item);
  if (!effect || effect.enabled === false || !Number.isFinite(timeInClip)) return timeInClip;
  const local = Math.max(0, timeInClip);
  const rate = clampRate(Number(effect.params?.ptFps));
  const track = item.propertyKeyframes?.ptFps;
  if (!Array.isArray(track) || !track.length || !integrateRate) {
    // The epsilon keeps an exact frame boundary on its own step (t·fps lands a
    // hair under the integer in floating point).
    return Math.floor(local * rate + 1e-6) / rate;
  }
  // A keyed rate: the step index is the integral of the rate; hold at the
  // instant that integral last crossed a whole number (binary search on the
  // monotonic phase — the integral table is cached per track edit).
  const span = duration > 0 ? duration : Math.max(local, 1e-3);
  const phaseAt = (t) => integrateRate(item, 'ptFps', rate, t, span);
  const k = Math.floor(phaseAt(local) + 1e-6);
  if (k <= 0) return 0;
  // Searched over the WHOLE span, not [0, local]: a step's hold instant then
  // depends on the step alone, so every frame inside it lands on the identical
  // time (a per-frame search window would jitter it in the last digits).
  let lo = 0;
  let hi = Math.max(span, local);
  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2;
    if (phaseAt(mid) >= k - 1e-9) hi = mid;
    else lo = mid;
  }
  return Math.min(hi, local);
}

/** The same, in timeline seconds: start + the held local time. */
export function posterizedLayerTime(item, startTime, duration, time) {
  if (!isPosterizeTimeEnabled(item)) return time;
  return startTime + posterizedTimeInClip(item, time - startTime, duration);
}
