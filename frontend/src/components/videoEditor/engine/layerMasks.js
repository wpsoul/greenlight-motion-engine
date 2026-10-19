/*
 * Layer Mask coverage (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 14 — moved verbatim out of the Player,
 * `xRef.current` → `engine.x`).
 *
 *   resolveMaskCoveragePlate(engine, src, lm, layerMesh, cam, t, ss)   rasterize the layer's mask stack at time `t`
 *       into its cached coverage plate → { plate, box, amount } or null (an exact bypass)
 *   maskVisibleShape(engine, item, clip, layerMesh, { outline })       the part of the layer the mask leaves visible
 *
 * Engine fields: renderer, maskPlateCache, maskCoverageStamp, maskCoverageByItem, textTextureCache.
 */
import {
  isLayerMaskEnabled, getLayerMaskEffect, resolveLayerMaskParams, drawMaskCoverage, maskGeomHash, isMatteMask,
} from '../layerMask';
import { requestVideoFrame, videoLaneStamp } from '../motionTemplates';
import { getItemKeyframeValues, integratePathRate } from '../gsapTransitions';
import { compTimeToSourceTime } from '../motionTracking';
import { sampleAlphaOutline, sampleAlphaBounds, hashAlphaSource } from '../alphaOutline';
import { computeLayerBox } from './layerWarps';
import { ensureTextTexture, mediaContentFrac, djb2, MASK_PLATE_STEPS, MASK_PLATE_CAP, PATH_FX_SAMPLES } from './canvasHelpers';

// Scratch for maskVisibleShape's coverage ∩ layer-alpha composite (one at a time).
let maskVisibleScratch = null;

/*
 * Rasterize one layer's mask stack at time `t`, project the carrier mesh's box through `cam` and rasterize coverage
 * into the cached plate.
 *
 * `cam` MUST be the camera the target was actually rendered with, or the
 * projected box (and therefore the whole mask) lands somewhere else on a
 * camera-locked channel.
 *
 * `ss` is the supersample factor of `src` (src px per composition px) — the
 * mask's feather/expand/grow are COMPOSITION px, so this is what converts them.
 *
 * Returns { plate, box, amount } or null as an exact bypass.
 */
export function resolveMaskCoveragePlate(engine, src, lm, layerMesh, cam, t, ss = 1) {
  const renderer = engine.renderer;
  if (!renderer || !layerMesh || !src) return null;
  const { item, entry } = lm;
  const effect = getLayerMaskEffect(item);
  if (!effect) return null;
  // Edge-on or degenerate: bypass. Treating a null box as zero coverage would
  // make the layer VANISH at 90°, which is far worse than an unmasked frame.
  const box = computeLayerBox(layerMesh, cam, src.width, src.height);
  if (!box) return null;

  const duration = entry.endTime - entry.startTime;
  const progress = duration > 0 ? Math.max(0, Math.min(1, (t - entry.startTime) / duration)) : 0;
  const clipNow = Math.max(0, t - entry.startTime);
  const resolved = resolveLayerMaskParams(item, getItemKeyframeValues(item, progress), {
    localTime: clipNow,
    duration,
    integrateRate: integratePathRate,
  });
  if (!resolved) return null;

  // ── Plate size ──
  // Quantized on the LONG edge so a continuous camera push-in re-rasters a
  // handful of times instead of 60×/s, and the short edge follows the box
  // aspect so plate pixels stay SQUARE in layer space — the offset stroke is a
  // true Minkowski offset and the feather blur is isotropic only if they are.
  const cap = Math.min(MASK_PLATE_CAP, renderer.capabilities?.maxTextureSize || 4096);
  const longNeed = Math.max(box.sizePx[0], box.sizePx[1]);
  let rung = MASK_PLATE_STEPS.findIndex((s) => s >= longNeed);
  if (rung < 0) rung = MASK_PLATE_STEPS.length - 1;
  // "High" feather quality is one rung denser: a finer plate is what actually
  // smooths a wide feather and keeps a hard edge crisp under magnification.
  if (resolved.quality === 1) rung = Math.min(MASK_PLATE_STEPS.length - 1, rung + 1);
  const long = Math.min(cap, MASK_PLATE_STEPS[rung]);
  const scale = long / Math.max(1, longNeed);
  const pw = Math.max(1, Math.min(cap, Math.round(box.sizePx[0] * scale)));
  const ph = Math.max(1, Math.min(cap, Math.round(box.sizePx[1] * scale)));
  // Composition px → plate px. box.sizePx is in ISOLATE px, so divide the
  // supersample back out before measuring against the plate.
  const plateRef = (pw * ss) / Math.max(1, box.sizePx[0]);

  // ── Raster matte masks: one decoder lane each ──
  // A matte mask reads its coverage from a baked grayscale MP4 rather than
  // from a path (layerMask.js). Frames come off the SAME lane the motion
  // templates use, which is what makes this work in export: the lane records
  // what a draw asked for, and both the preview loop and exportVideo's settle
  // loop already pump it and repaint until nothing is outstanding.
  //
  // The lane time is the clip's own SOURCE second minus the matte's t0, so a
  // trimmed, split, speed-ramped or reversed clip still lands on the frame the
  // subject was traced on.
  const frameFor = resolved.masks.some(isMatteMask)
    ? (mask) => {
      const lane = `msk:${item.id}:${mask.mid}`;
      const tSource = compTimeToSourceTime(item, entry, t);
      return {
        source: requestVideoFrame(mask.matte.url, tSource - mask.matte.t0, lane),
        stamp: videoLaneStamp(lane),
      };
    }
    : null;

  // ── Coverage raster, cached on content ──
  const cacheKey = `${item.id}:${effect.eid || 'lm'}`;
  const plate = ensureTextTexture({ current: engine.maskPlateCache }, cacheKey, pw, ph);
  const hash = maskGeomHash(resolved.masks, plateRef, pw, ph, frameFor);
  if (plate.maskHash !== hash) {
    drawMaskCoverage(plate.ctx, pw, ph, resolved.masks, plateRef, frameFor);
    plate.maskHash = hash;
    plate.texture.needsUpdate = true;
  }
  // Published for the two consumers that bake off this isolate's alpha and
  // would otherwise never notice it changed — see maskCoverageStampRef.
  engine.maskCoverageStamp.set(item.id, `${hash}:${pw}x${ph}`);
  engine.maskCoverageByItem.set(item.id, { plate, amount: resolved.amount });

  return { plate, box, amount: resolved.amount };
}

/*
 * The part of a masked layer that is actually visible, read off the coverage plate resolved this frame (the mask
 * runs before the chain in every flow) and cached on that plate's content hash: a static mask traces once, and a
 * layer with none of these effects never traces at all.
 *
 *   bounds   the coverage's extent, fractions of the layer box (y DOWN)
 *   outline  the coverage ∩ the layer's own alpha where the CPU has it (a text
 *            or motion canvas, an image's picture) ∩ a video's picture rect —
 *            the edge the light should actually run along (only on request)
 *
 * null when there is no mask, when Amount is below 100 (the cut-away part
 * still shows, so the plate IS the visible area) or when nothing is visible.
 */
export function maskVisibleShape(engine, item, clip, layerMesh, { outline = false } = {}) {
  if (!item || !isLayerMaskEnabled(item)) return null;
  const rec = engine.maskCoverageByItem.get(item.id);
  const plate = rec?.plate;
  if (!plate?.maskHash || !(rec.amount >= 0.999)) return null;
  let vis = plate.visible;
  if (!vis || vis.hash !== plate.maskHash) {
    vis = { hash: plate.maskHash, bounds: sampleAlphaBounds(plate.canvas), outlines: new Map() };
    plate.visible = vis;
  }
  if (!vis.bounds) return null;
  if (!outline) return { bounds: vis.bounds, outline: null, key: String(vis.hash) };
  const mt = clip?.mediaType;
  let source = null;
  let sourceKey = 'none';
  if (mt === 'text' || mt === 'motion') {
    source = engine.textTextureCache.get(item.id)?.canvas || null;
    sourceKey = source ? (hashAlphaSource(source) || 'none') : 'none';
  } else if (mt === 'image') {
    const img = layerMesh?.material?.uniforms?.uTexture?.value?.image || null;
    if (img && (img.width || img.naturalWidth)) {
      source = img;
      sourceKey = `img:${djb2(clip.proxyUrl || clip.url || '')}`;
    }
  }
  const { cw, ch } = mt === 'video' ? mediaContentFrac(layerMesh) : { cw: 1, ch: 1 };
  const key = `${sourceKey}|${cw.toFixed(4)}:${ch.toFixed(4)}`;
  let traced = vis.outlines.get(key);
  if (traced === undefined) {
    let canvas = plate.canvas;
    if (source || cw < 0.999 || ch < 0.999) {
      const w = plate.canvas.width;
      const h = plate.canvas.height;
      if (!maskVisibleScratch) maskVisibleScratch = document.createElement('canvas');
      const sc = maskVisibleScratch;
      sc.width = w;
      sc.height = h;
      const ctx = sc.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(plate.canvas, 0, 0);
      ctx.globalCompositeOperation = 'destination-in';
      try {
        if (source) ctx.drawImage(source, 0, 0, w, h);
        else ctx.fillRect((w * (1 - cw)) / 2, (h * (1 - ch)) / 2, w * cw, h * ch);
      } catch { /* an undrawable picture: keep the coverage alone */ }
      ctx.globalCompositeOperation = 'source-over';
      canvas = sc;
    }
    traced = sampleAlphaOutline(canvas, PATH_FX_SAMPLES) || null;
    if (vis.outlines.size > 4) vis.outlines.clear();
    vis.outlines.set(key, traced);
  }
  return { bounds: vis.bounds, outline: traced, key: `${vis.hash}|${key}` };
}
