// Keyframe integration for MotionFast template options.
//
// A motion layer's options live flat on the item as `motionParams`, keyed by the
// template's `fields[].key`. Numeric and colour options are animatable through the
// shared propertyKeyframes system under the track keys `mp:<param>` (numeric) and
// `mpc:<param>` (colour) — the same trick adjustmentEffects.js plays with
// `fx:<eid>:<param>`. The interpolator is registry-agnostic, so these tracks flow
// through for free; the helpers below let the panel / sanitizer / timeline / render
// resolve them without hard-coding anything per template.
//
// Two prefixes rather than one because evaluatePropertyTrack picks numeric-vs-RGBA
// interpolation from the track key alone (see isColorTrackKey in keyframeProps.js);
// a colour under a numeric key would parseFloat('#fff') -> NaN and vanish.

// Imports only the leaf registry module on purpose: the catalog generator SSR-loads
// this to stamp `keyframable` onto every field, so it must not drag in the template
// façade (and its local-template fetching) at import time.
import { MOTION_KF_PREFIX, MOTION_KF_COLOR_PREFIX } from './keyframeProps';

// Options group label in the Keyframe Builder's "Add Property" dropdown.
export const MOTION_KF_GROUP = 'Template';

// Field types that can be interpolated. Selects/switches/text/image-lists have no
// meaningful in-between value, so they stay static.
const NUMERIC_FIELD_TYPES = new Set(['number', 'range']);

const PARAM_KEY_RE = /^[A-Za-z0-9_]+$/;

export function motionKfKey(paramKey, isColor = false) {
  return `${isColor ? MOTION_KF_COLOR_PREFIX : MOTION_KF_PREFIX}${paramKey}`;
}

export function parseMotionKfKey(label) {
  if (typeof label !== 'string') return null;
  for (const [prefix, isColor] of [[MOTION_KF_COLOR_PREFIX, true], [MOTION_KF_PREFIX, false]]) {
    if (!label.startsWith(prefix)) continue;
    const paramKey = label.slice(prefix.length);
    return PARAM_KEY_RE.test(paramKey) ? { paramKey, isColor } : null;
  }
  return null;
}

export function isMotionKfKey(label) {
  return parseMotionKfKey(label) != null;
}

// Motion-template fields may declare `showIf` to appear only when another param
// says so — a predicate `(params) => bool`, or the declarative `{ key, equals }`
// / `{ key, in: [...] }` (truthiness when neither is given). Shared by the inspector
// (which renders the control) and buildMotionKfProps (which offers the ◆ dot), so a
// hidden field is never animatable.
export function motionFieldVisible(field, params) {
  const cond = field?.showIf;
  if (cond == null) return true;
  try {
    if (typeof cond === 'function') return !!cond(params || {});
    const current = (params || {})[cond.key];
    if (Array.isArray(cond.in)) return cond.in.includes(current);
    if ('equals' in cond) return current === cond.equals;
    return !!current;
  } catch {
    return true;   // a broken condition must never hide a control for good
  }
}

// Can this template's param actually change from frame to frame?
//
// A stateful template (`createInstance`) bakes its params into precomputed state —
// layout tables, baked canvases — and drawMotionFrame caches the instance under a
// signature derived from the params, so an animated param would rebuild the whole
// instance every frame. Those are only animatable when the template opts in by
// declaring `liveParams` and implementing `instance.setParams(p)`; drawMotionFrame
// then keeps the instance signature on the *base* params and pushes the animated
// values through setParams each frame.
//
// Stateless (`draw`) templates are pure functions of (time, params), so every param
// is animatable with no template changes at all.
export function templateCanAnimate(template, paramKey) {
  if (!template) return false;
  if (typeof template.createInstance === 'function') {
    return Array.isArray(template.liveParams) && template.liveParams.includes(paramKey);
  }
  return typeof template.draw === 'function';
}

// Does this param feed getDuration? A motion clip's length is re-fitted from its
// params on every edit (updateMotionItem), always from the STATIC values — so a
// param that changes the natural duration would fight the clip it lives in. Probe
// the template at the field's extremes and refuse to animate it if the duration moves.
//
// Memoised per template+param: getDuration is cheap but this runs on every panel
// render, and the answer is a property of the template, not of the current params.
const durationCoupledCache = new Map();

export function isDurationCoupled(template, field) {
  if (!template || typeof template.getDuration !== 'function') return false;
  if (!NUMERIC_FIELD_TYPES.has(field?.type)) return false;   // colours never drive duration
  if (!Number.isFinite(field.min) || !Number.isFinite(field.max) || field.min === field.max) return false;

  const cacheKey = `${template.id}::${field.key}`;
  const cached = durationCoupledCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let coupled;
  try {
    const base = { ...(template.defaultParams || {}) };
    const lo = Number(template.getDuration({ ...base, [field.key]: field.min }));
    const hi = Number(template.getDuration({ ...base, [field.key]: field.max }));
    coupled = !(Number.isFinite(lo) && Number.isFinite(hi)) || Math.abs(lo - hi) > 1e-6;
  } catch {
    coupled = true;   // fail closed — a throwing probe means we can't vouch for it
  }
  durationCoupledCache.set(cacheKey, coupled);
  return coupled;
}

function makeMotionKfProp(field, currentValue) {
  const isColor = field.type === 'color';
  const base = {
    label: motionKfKey(field.key, isColor),   // the track key (unique id)
    group: MOTION_KF_GROUP,
    displayLabel: field.label || field.key,
    placeholder: String(currentValue ?? ''),
    unit: field.suffix || '',
    paramKey: field.key,
  };
  if (isColor) return { ...base, inputType: 'color', hasAlpha: true };
  return { ...base, type: 'number', min: field.min, max: field.max, step: field.step ?? 1 };
}

// Every animatable option a motion item exposes, each shaped like a KF_PROPS entry
// plus a human `displayLabel` — the shape VEKeyframeBuilder's `extraKfProps` expects.
// Placeholder = the param's CURRENT value, so seeding a track starts constant and
// promoting a field never changes the frame.
// Is this field animatable at all, ignoring the current params? Field type + the two
// template-level rules. Exported so the catalog generator can stamp it per field.
export function isFieldKeyframable(template, field) {
  if (!field?.key) return false;
  // A template can rule a field out itself. The duration probe below runs at the
  // default params, so it cannot see a field that feeds getDuration only while its
  // showIf holds (Glow Edge Pill's Hold After Click, which counts only with Click at End).
  if (field.keyframable === false) return false;
  if (field.type !== 'color' && !NUMERIC_FIELD_TYPES.has(field.type)) return false;
  if (!templateCanAnimate(template, field.key)) return false;
  return !isDurationCoupled(template, field);
}

export function buildMotionKfProps(item, template) {
  if (!item?.motionTemplateId || !template) return [];
  // A stub whose module hasn't landed yet carries no `fields`; the panel
  // re-renders on onMotionTemplatesLoaded once the real module arrives.
  if (!Array.isArray(template.fields)) return [];
  const params = item.motionParams || {};
  const out = [];
  for (const field of template.fields) {
    if (!isFieldKeyframable(template, field)) continue;
    if (!motionFieldVisible(field, params)) continue;   // params-dependent, so checked separately
    const isColor = field.type === 'color';
    const current = params[field.key] ?? (template.defaultParams || {})[field.key]
      ?? (isColor ? '#ffffff' : (field.min ?? 0));
    out.push(makeMotionKfProp(field, current));
  }
  return out;
}

// Merge resolved keyframe values back over the item's static params for one frame.
// Returns the SAME object reference when the item has no motion tracks: drawMotionFrame
// signs cached stateful instances with JSON.stringify(params), so handing it a fresh
// object every frame would be a silent perf cliff on every un-animated motion layer.
export function applyMotionParamKeyframes(motionParams, kfValues) {
  if (!kfValues) return motionParams;
  let merged = null;
  for (const [trackKey, value] of Object.entries(kfValues)) {
    const parsed = parseMotionKfKey(trackKey);
    if (!parsed || value === undefined) continue;
    if (!merged) merged = { ...(motionParams || {}) };
    merged[parsed.paramKey] = value;
  }
  return merged || motionParams;
}

// Drop every motion-option track (used when a layer swaps to a different template,
// which resets motionParams to the new template's defaults).
export function stripMotionTracks(propertyKeyframes) {
  if (!propertyKeyframes) return null;
  let changed = false;
  const next = {};
  for (const [key, track] of Object.entries(propertyKeyframes)) {
    if (isMotionKfKey(key)) { changed = true; continue; }
    next[key] = track;
  }
  return changed ? next : null;
}
