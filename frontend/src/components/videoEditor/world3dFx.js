/*
 * What a model layer's effects tell the world (src/world3d/render/objectFx.js), each frame.
 *
 * The world has a three and a GPU device of its own, so nothing of the editor's crosses but plain data: each live entry with its params
 * resolved for this frame (keyframes, Mix, Active Range, the master Amount: resolveModelOverlayFx), what an effect takes from this side as
 * bytes or numbers (a baked curve, Lines Draw's runner), the layer's colour filters as the stack's last entry, and the model's own frame
 * and box, so a pattern stays on its surface exactly as it did in the model's own pass.
 */
import { getCurvesTexture } from './adjustmentEffects';
import { linesDrawRunnerState } from './linesDrawProfiles';
import { resolveModelOverlayFx, isWorldModelFx } from './model3dFxCatalog';
import { worldMatrix } from './world3dScene.js';

/** The world's entries on a model item this frame, in stack order, its colour filters last. Empty when none is live: the world then does nothing for it. */
export function worldFxEffects(item, kfNow, clipNow, duration) {
  const master = Number.isFinite(kfNow?.effectAmount) ? Math.max(0, Math.min(1, kfNow.effectAmount)) : 1;
  const out = resolveModelOverlayFx(item, { kf: kfNow, time: clipNow, duration, master }, isWorldModelFx).map(withPictures);
  const filters = layerFilters(item, kfNow);
  if (filters) out.push({ id: 'filters', params: filters, mix: 1, time: clipNow });
  return out;
}

/** Does the layer carry colour filters the world lays on its object? Blur moves the picture, so it is not one of them (it keeps the model's own pass). */
export function hasLayerFilters(item) {
  return !!layerFilters(item, null) || ['brightness', 'contrast', 'saturate', 'hue-rotate', 'grayscale', 'sepia', 'invert']
    .some((k) => Array.isArray(item?.propertyKeyframes?.[k]) && item.propertyKeyframes[k].length > 0);
}

// The compositor's own reading of them (clipShader.applyFilterUniforms): a keyframe wins over the layer's value. Null when all are neutral.
function layerFilters(item, kf) {
  const at = (key, field, rest) => {
    const v = kf?.[key];
    if (Number.isFinite(v)) return v;
    return Number.isFinite(item?.[field]) ? item[field] : rest;
  };
  const f = {
    brightness: at('brightness', 'filterBrightness', 100), contrast: at('contrast', 'filterContrast', 100), saturate: at('saturate', 'filterSaturation', 100),
    hue: at('hue-rotate', 'filterHueRotate', 0), grayscale: at('grayscale', 'filterGrayscale', 0), sepia: at('sepia', 'filterSepia', 0), invert: at('invert', 'filterInvert', 0),
  };
  const neutral = f.brightness === 100 && f.contrast === 100 && f.saturate === 100 && Math.abs(f.hue) <= 0.5 && !f.grayscale && !f.sepia && !f.invert;
  return neutral ? null : f;
}

function withPictures(e) {
  if (e.id === 'curves') {
    const t = getCurvesTexture(e.params.curves);
    return { ...e, params: { ...e.params, __lut: { data: t.image.data, key: t.uuid } } };
  }
  if (e.id === 'linesDraw') {
    const run = linesDrawRunnerState(e.params, Number.isFinite(e.time) ? e.time : 0, true);
    return { ...e, params: { ...e.params, __run: { pathPhase: run.pathPhase, pathAux: run.pathAux } } };
  }
  return e;
}

/** `fx`: [{ itemId, objects, effects }] from the layers in the world. `frameOf` is model3dLayer.modelFxFrame; `H` the composition's height. */
export function worldFxList(fx, frameOf, H) {
  const out = [];
  for (const f of fx) {
    const at = frameOf(f.itemId);
    const effects = f.effects.filter(Boolean);
    if (at && effects.length) out.push({ objects: f.objects, frame: worldMatrix(at.matrix), box: at.box, fitPx: at.fitPx, H, effects });
  }
  return out;
}
