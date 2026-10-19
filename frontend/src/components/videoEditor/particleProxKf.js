/*
 * PROXIMITY EFFECTORS ▸ KEYFRAMES — the `px:<param>` track namespace.
 *
 * The effector's numbers are ordinary scalars, so animating them needed no new
 * animation system at all: a track key, a stopwatch on the row, and the whole
 * existing machinery (Keyframes panel, graph editor, custom easing, HOLD, the ƒx
 * expressions) applies unchanged. This module is the thin layer that maps
 * between a track key and the block it patches — nothing here evaluates a curve.
 *
 * TWO CONSUMERS, EXACTLY LIKE THE POSES NEXT DOOR (particleProxTrack.js):
 *
 *   proxCfgAt()          one frame — what the RENDERER shades with. Look targets
 *                        are read at draw time, so this is the whole story for
 *                        size / opacity / colour / rotation / stretch / twinkle.
 *   proxParamTrackFor()  every simulation step (in particleProxTrack.js) — what
 *                        the SOLVER integrates, because a force cannot be
 *                        sampled once and multiplied by time.
 *
 * WHICH HALF PAYS. Animating a LOOK amount is free: it never enters the bake key
 * (see particleSimHash), so a Size that swells over a shot re-draws and nothing
 * more. Animating a MOTION amount — or Range / Falloff / Depth while one is
 * driven — is a simulation input and re-bakes, exactly as editing the same
 * number statically does today. The panel's LOOK / SIM badge already says which
 * is which, and the stopwatch inherits that promise rather than inventing a new
 * one.
 */

import { PROX_KF_PREFIX } from './keyframeProps.js';
import {
  particleProxKfField, particleProxKfFieldsFor, particleProxParamValue,
} from '../../sim/particles/schema.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** `range` → `px:range`. */
export const proxKfKey = (paramKey) => `${PROX_KF_PREFIX}${paramKey}`;

/** `px:range` → `range`, or null for anything that is not a live parameter. */
export function parseProxKfKey(label) {
  if (typeof label !== 'string' || !label.startsWith(PROX_KF_PREFIX)) return null;
  const paramKey = label.slice(PROX_KF_PREFIX.length);
  return particleProxKfField(paramKey) ? paramKey : null;
}

/** Every proximity parameter of `item` that carries a non-empty track. */
export function proxAnimatedParams(item) {
  const out = new Set();
  const pk = item?.propertyKeyframes;
  if (!pk) return out;
  for (const [key, track] of Object.entries(pk)) {
    if (!Array.isArray(track) || !track.length) continue;
    const paramKey = parseProxKfKey(key);
    if (paramKey) out.add(paramKey);
  }
  return out;
}

/**
 * Resolved `px:` values for one frame, clamped to the registry's range.
 * Null when the item carries no proximity tracks, which is the common case and
 * the reason the callers can skip cloning the block at all.
 */
export function proxKfOverrides(kfValues) {
  if (!kfValues) return null;
  let out = null;
  for (const [trackKey, value] of Object.entries(kfValues)) {
    const paramKey = parseProxKfKey(trackKey);
    if (!paramKey) continue;
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    const meta = particleProxKfField(paramKey);
    if (!out) out = {};
    out[paramKey] = clamp(n, meta.min, meta.max);
  }
  return out;
}

/**
 * The proximity block as it stands AT THIS FRAME.
 *
 * Returns the SAME object when nothing is animated, so an un-keyed effector does
 * not allocate a clone sixty times a second. An `fx` override only lands on a
 * property that is actually driven: a track left behind by a removed property is
 * inert, not a way to resurrect it.
 */
export function proxCfgAt(prox, kfValues) {
  if (!prox) return prox;
  const overrides = proxKfOverrides(kfValues);
  if (!overrides) return prox;
  let out = null;
  let fx = null;
  for (const [paramKey, v] of Object.entries(overrides)) {
    const meta = particleProxKfField(paramKey);
    if (meta.where === 'fx') {
      if (prox.fx?.[paramKey] === undefined) continue;
      if (!fx) fx = { ...prox.fx };
      fx[paramKey] = v;
    } else {
      if (!out) out = { ...prox };
      out[paramKey] = v;
    }
  }
  if (fx) out = { ...(out || prox), fx };
  return out || prox;
}

/**
 * The `px:<param>` rows a particle layer publishes to the Keyframe Builder,
 * shaped like KF_PROPS entries plus a human `displayLabel` — the shape
 * `extraKfProps` expects. The placeholder is the parameter's CURRENT value, so
 * seeding a track starts constant and promoting a field never changes the frame.
 */
export function buildProxKfProps(item) {
  const prox = item?.particleSystem?.proximity;
  const fields = particleProxKfFieldsFor(prox);
  if (!fields.length) return [];
  return fields.map((f) => ({
    label: proxKfKey(f.key),
    group: 'Proximity',
    // The bare parameter name, NOT the name plus a LOOK / SIM tag: the builder
    // appends the unit, so a tagged one reads "Attract / Repel (sim) (px/s²)" and
    // truncates before it says anything. The badge is on the panel row, which is
    // where the choice to animate is actually made.
    displayLabel: f.label,
    placeholder: String(particleProxParamValue(prox, f.key)),
    unit: (f.unit || '').trim(),
    type: 'number',
    min: f.min,
    max: f.max,
    step: f.step ?? 1,
  }));
}

/** A flat pair of keys at the current value — the stopwatch's "arm, change nothing". */
export function seedProxTrack(prox, paramKey, easing) {
  const value = String(particleProxParamValue(prox, paramKey));
  return [
    { position: 0, value, easing },
    { position: 100, value, easing },
  ];
}
