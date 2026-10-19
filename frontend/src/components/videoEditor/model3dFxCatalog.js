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

/**
 * The item as the FLAT chain should see it: on a model layer, the entries that
 * render in 3D are taken out. Any other layer — or a model without such an
 * entry — gets the very same object back, so nothing about it changes.
 */
export function withFlatEffects(item, clip) {
  if (clip?.mediaType !== 'model3d') return item;
  const list = item?.effects;
  if (!Array.isArray(list) || !list.some(isModelFxOverlay)) return item;
  return { ...item, effects: list.filter((e) => !isModelFxOverlay(e)) };
}

/**
 * The live 3D overlay entries of a model item this frame, in stack order:
 * [{ id, params, mix (0..1), time }]. Every gate the flat chain uses applies —
 * muted, mix 0 (keyed or not), outside the Active Range or a master Amount of 0
 * means the entry is not in the list. `at` is the chain's liveness context
 * { kf, time (clip-local s), duration, master }.
 */
export function resolveModelOverlayFx(item, at) {
  const out = [];
  const list = item?.effects;
  if (!Array.isArray(list)) return out;
  const kf = at?.kf || null;
  const master = Number.isFinite(at?.master) ? at.master : 1;
  for (const eff of list) {
    if (!isModelFxOverlay(eff) || !effectIsLiveAt(eff, at, item)) continue;
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
