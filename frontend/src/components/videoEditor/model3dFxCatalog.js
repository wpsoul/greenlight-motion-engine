/*
 * Which Overlay Effects have a REAL-3D version on a model layer — DATA ONLY.
 *
 * The Player, the inspector and the picker all need to know this without
 * loading the passes themselves (model3dFx.js, lazy). An entry renders in 3D
 * when it says so (`real3d: true`, set when the effect is added to a model
 * layer) AND its id is listed here; everything else on a model stays on the
 * flat chain exactly as before — which is also what keeps a project saved
 * before this work looking the way it did.
 *
 * The set grows one effect at a time as each 3D version lands
 * (PLANS/MODEL3D_EFFECTS_PLAN.md).
 *
 * In a world Scene (a Rig with renderer 'world') the model is an object in
 * the world, and they split three ways there:
 *   WORLD_FX_IDS         run on its object, laid on the world's own picture
 *                        (src/world3d/render/objectFx.js): it keeps its
 *                        shadow and Final traces it.
 *   LEAVES_WORLD_FX_IDS  the six that move the picture off the surface. While
 *                        one is live (modelLeavesWorldAt), the model leaves the
 *                        world for its own pass, drawn over the Scene with no
 *                        shadow and not traced in Final; then it is back.
 *   NOT_IN_WORLD_FX_IDS  looks that read as a texture on the surface (they
 *                        come back later as materials): not offered on a
 *                        model there, and a saved entry is skipped.
 * Everywhere else (flat model layers, a classic Rig) every one of them is
 * what it always was.
 */
import { getAdjustmentEffect, resolveEffectParams, effectIsLiveAt, effectWindowAt } from './adjustmentEffects';

export const MODEL_FX_OVERLAY_IDS = Object.freeze(new Set([
  'rgbSplit',
  'pixelate',
  'crtMatrix',
  'halftone',
  'objectDither',
  'ascii',
  'fractalNoise',
  'fill',
  'colorama',
  'gradientBeam',
  'gradientSweep',
  'objectContour',
  'objectCurtain',
  'bloom',
  'auraBlur',
  'lightRays',
  'neonGlow',
  'linesDraw',
  'edgeDetect',
  'flashBlink',
  'glitch',
  'objectSlitScan',
  'pixelStretch',
  'shapeRulers',
  'curves',
]));

/** Does this overlay entry render inside the model's 3D pass? */
export function isModelFxOverlay(eff) {
  return eff?.real3d === true && MODEL_FX_OVERLAY_IDS.has(eff?.id);
}

/** A split, a smear, a slice, a flash: while one is live on a model in a world Scene, the model leaves the world for its own pass. */
export const LEAVES_WORLD_FX_IDS = Object.freeze(new Set([
  'rgbSplit',
  'glitch',
  'pixelStretch',
  'objectSlitScan',
  'objectCurtain',
  'flashBlink',
]));

/** Looks that read as a texture on the surface. In a world Scene a model is not offered them, and skips a saved one (flat or 3D). */
export const NOT_IN_WORLD_FX_IDS = Object.freeze(new Set([
  'crtMatrix',
  'halftone',
  'objectDither',
  'ascii',
  'fill',
  'colorama',
  'objectContour',
  'auraBlur',
  'lightRays',
]));

/** The ones a world Scene runs on the model's own object, in the world (src/world3d/render/objectFx.js, OBJECT_FX_IDS). */
export const WORLD_FX_IDS = Object.freeze(new Set([...MODEL_FX_OVERLAY_IDS].filter((id) => !NOT_IN_WORLD_FX_IDS.has(id) && !LEAVES_WORLD_FX_IDS.has(id))));

/** Does this entry run inside a world Scene, on the model's object? */
export const isWorldModelFx = (eff) => isModelFxOverlay(eff) && WORLD_FX_IDS.has(eff.id);

/** Is this entry skipped on a model in a world Scene? */
export const skippedInWorld = (eff, clip) => clip?.mediaType === 'model3d' && NOT_IN_WORLD_FX_IDS.has(eff?.id);

/** Does one of the six take this model out of a world Scene this frame? The chain's own liveness (muted, Mix, Active Range, the master
 *  Amount), flat or 3D alike; `at` is { kf, time (clip-local s), duration, master }. */
export const modelLeavesWorldAt = (item, at) => Array.isArray(item?.effects)
  && item.effects.some((e) => LEAVES_WORLD_FX_IDS.has(e?.id) && effectIsLiveAt(e, at, item));

/**
 * The item as the FLAT chain should see it: on a model layer, the entries that
 * render in 3D are taken out, and in a world Scene (`inWorld`) the ones not
 * offered there (NOT_IN_WORLD_FX_IDS) too. Any other layer — or a model
 * without such an entry — gets the very same object back, so nothing about it
 * changes.
 */
export function withFlatEffects(item, clip, inWorld = false) {
  if (clip?.mediaType !== 'model3d') return item;
  const list = item?.effects;
  const off = (e) => isModelFxOverlay(e) || (inWorld && NOT_IN_WORLD_FX_IDS.has(e?.id));
  if (!Array.isArray(list) || !list.some(off)) return item;
  return { ...item, effects: list.filter((e) => !off(e)) };
}

/**
 * The live 3D overlay entries of a model item this frame, in stack order:
 * [{ id, params, mix (0..1), time }]; `only` narrows them (the world's own,
 * isWorldModelFx). Every gate the flat chain uses applies —
 * muted, mix 0 (keyed or not), outside the Active Range or a master Amount of 0
 * means the entry is not in the list. `at` is the chain's liveness context
 * { kf, time (clip-local s), duration, master }.
 */
export function resolveModelOverlayFx(item, at, only = isModelFxOverlay) {
  const out = [];
  const list = item?.effects;
  if (!Array.isArray(list)) return out;
  const kf = at?.kf || null;
  const master = Number.isFinite(at?.master) ? at.master : 1;
  for (const eff of list) {
    if (!only(eff) || !effectIsLiveAt(eff, at, item)) continue;
    const def = getAdjustmentEffect(eff.id);
    const params = resolveEffectParams(def, eff);
    // A curves param is an object the resolver does not carry; the flat chain
    // reads it raw from the entry too (getCurvesTexture sanitizes it).
    for (const p of def.params) if (p.type === 'curves') params[p.key] = eff.params?.[p.key] ?? p.default;
    if (kf && eff.eid) {
      for (const p of def.params) {
        const v = kf[`fx:${eff.eid}:${p.key}`];
        if (Number.isFinite(v)) params[p.key] = v;
      }
    }
    const mixKf = kf && eff.eid ? kf[`fx:${eff.eid}:mix`] : undefined;
    const mix = (Number.isFinite(mixKf) ? mixKf : (Number.isFinite(eff.mix) ? eff.mix : 100)) / 100;
    const win = at?.time != null ? effectWindowAt(eff, at.time, at.duration) : null;
    const dur = Number(at?.duration);
    out.push({
      id: eff.id,
      params,
      mix: Math.max(0, Math.min(1, mix * master)),
      time: win ? win.time : at?.time,
      // 0..1 through the Active Range (else the clip): Edge Detect's Draw On / Scanner.
      progress: win ? win.progress : (dur > 0 ? Math.max(0, Math.min(1, (at?.time || 0) / dur)) : 0),
    });
  }
  return out;
}
