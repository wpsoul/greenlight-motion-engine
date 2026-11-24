/*
 * Small layer helpers the render loop shares (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 22 — moved verbatim out
 * of Player.jsx with tests/engine-extraction/tools/move_module_decls.py, which the Player imports back): clamp01, a
 * box's bounds, a clip's media time, a layer's content box, which layers a transition can bake, Silhouette Framing's
 * mask, which Layer Masks the layer's own pass draws (a box: shaderBoxMask / needsLayerMaskPass), and Echo's pose scratch.
 */
import * as THREE from 'three';
import { isAutoFillEnabled } from '../autoFillLayer';
import { isBendEnabled } from '../bendLayer';
import { isBezierWarpEnabled } from '../bezierWarp';
import { isChromaKeyEnabled } from '../chromaKeyLayer';
import { isCornerPinEnabled } from '../cornerPinLayer';
import { isDepthKeyEnabled } from '../depthKeyLayer';
import { isDepthScanEnabled } from '../depthScanLayer';
import { isDrosteEnabled } from '../drosteLayer';
import { isFresnelRimEnabled } from '../fresnelRimLayer';
import { boxMaskShape, isLayerMaskEnabled } from '../layerMask';
import { normalizeBlendMode } from '../blendModes';
import { isMeshWarpEnabled } from '../meshWarp';
import { isMockupFrameActive } from '../mockupFrame';
import { isPryzmEnabled } from '../pryzmLayer';
import { isRegionDistortEnabled } from '../regionDistort';
import { isRepetileEnabled } from '../repetileLayer';
import { isCameraBaked3dPlate } from '../rig3d';
import { isRigEnabled } from '../rigDeform';
import { isRunningGlowEnabled } from '../runningGlow';
import { hasSilhouetteFraming } from '../silhouetteFraming';
import { getTimelineDuration, mapTimelineToSource } from '../speedUtils';
import { getTextFootprint } from '../textFootprint';

export function calculateVideoTime(item, timeInClip) {
  const sourceDuration = item.trimEnd - item.trimStart;
  const timelineDuration = getTimelineDuration(sourceDuration, item.speedPoints);
  const normalizedTime = Math.max(0, Math.min(1, timeInClip / timelineDuration));
  return item.trimStart + mapTimelineToSource(item.speedPoints, normalizedTime) * sourceDuration;
}

export function bakeableLayerStack(item, clip, entry) {
  if (!item || !entry) return null;
  const baked3d = isCameraBaked3dPlate(clip, item);
  const mt = clip?.mediaType;
  const e = (on) => (on ? { item, entry, clip } : null);
  const stack = {
    // Keying reads pixels, not the layer box, so it has no 3D exclusion.
    chromaKey: e(isChromaKeyEnabled(item)),
    depthKey: e(isDepthKeyEnabled(item) && !baked3d),
    glow: e(isRunningGlowEnabled(item)),
    autoFill: e(isAutoFillEnabled(item) && mt !== 'model3d'),
    // The scan reads the layer BOX (to place the depth map), so a camera-baked
    // plate is out for the same reason the warps are.
    depthScan: e(isDepthScanEnabled(item) && !baked3d),
    // Fresnel Rim on a picture reads the depth map through the layer box, like
    // Depth Scan; on a model it runs inside the 3D pass instead (resolveModelFx3d).
    fresnelRim: e(isFresnelRimEnabled(item, mt) && (mt === 'image' || mt === 'video') && !baked3d),
    rig: e(isRigEnabled(item) && !baked3d && mt !== 'sequence' && mt !== 'grid'),
    regionDistort: e(isRegionDistortEnabled(item) && !baked3d),
    bend: e(isBendEnabled(item) && !baked3d),
    meshWarp: e(isMeshWarpEnabled(item) && !baked3d),
    bezierWarp: e(isBezierWarpEnabled(item) && !baked3d),
    droste: e(isDrosteEnabled(item) && !baked3d),
    pryzm: e(isPryzmEnabled(item) && !baked3d),
    cornerPin: e(isCornerPinEnabled(item) && !baked3d),
    mockupFrame: e(isMockupFrameActive(item) && !baked3d),
    repetile: e(isRepetileEnabled(item) && !baked3d),
  };
  return Object.values(stack).some(Boolean) ? stack : null;
}

// The part of a layer's box the layer actually occupies, in box uv (y up) — for
// effects that frame the layer rather than paint it (Shape Rulers). A text layer
// draws on a plate much bigger than its words, so its rect is the laid-out block
// the selection gizmo shows (textFootprint.js); every other layer fills its plate
// and gets null, which the effect reads as the whole box.
export function layerContentBox(item, clip) {
  if (clip?.mediaType !== 'text') return null;
  const fp = getTextFootprint(item?.id);
  if (!fp || !(fp.width > 0) || !(fp.height > 0) || !(fp.plateWidth > 0) || !(fp.plateHeight > 0)) return null;
  const pw = fp.plateWidth;
  const ph = fp.plateHeight;
  // Footprint offsets are y DOWN from the plate centre; box uv is y UP.
  return [
    0.5 + (fp.offsetX - fp.width / 2) / pw,
    0.5 - (fp.offsetY + fp.height / 2) / ph,
    0.5 + (fp.offsetX + fp.width / 2) / pw,
    0.5 - (fp.offsetY - fp.height / 2) / ph,
  ];
}

// A masked media layer's BORDER and SHADOWS follow what the mask leaves visible:
// the silhouette framing pass (the Chroma Key one) draws them after the cut and
// the clip shader's box framing stays off. Box framing outlined — and shadowed —
// the rectangle the mask had cut away, and its shadow margin grew the quad the
// mask is laid out on. Shapes frame their own outline on the canvas and text
// plates are frame-sized, so both keep the framing they had.
export function maskSilhouetteFraming(item, clip) {
  const mt = clip?.mediaType;
  return mt !== 'shape' && mt !== 'text' && mt !== 'adjustment'
    && isLayerMaskEnabled(item) && !isCameraBaked3dPlate(clip, item) && hasSilhouetteFraming(item);
}

// A Layer Mask that is just a box (layerMask.js boxMaskShape) is cut by the clip shader in the layer's own pass
// (layerMesh.js applyShaderBoxMask → clipShader.js uBoxCrop), with no isolate, coverage plate or mask pass — on a plain
// picture layer: an image or a video the clip material draws, whose masked pixels nothing else reads. A border or a
// shadow follows the masked silhouette (maskSilhouetteFraming), an Overlay Effect or a per-layer stage (bakeableLayerStack)
// reads the masked isolate, a blend mode other than Normal composites it: those keep the mask pass, as everything that is
// not a box does. → the box's shape, or null. Cached per item and clip (both are replaced, never mutated, on an edit).
const BOX_ENTRY = Object.freeze({});
const shaderBoxCache = new WeakMap();
export function shaderBoxMask(item, clip) {
  // `globalThis.__veBoxMaskPass = true`: every mask takes the mask pass again (an A/B of the two in one page; tests only)
  if (!item || typeof item !== 'object' || globalThis.__veBoxMaskPass === true) return null;
  const hit = shaderBoxCache.get(item);
  if (hit && hit.clip === clip) return hit.shape;
  const mt = clip?.mediaType;
  let shape = (mt === 'image' || mt === 'video') && !clip?.htmlSource ? boxMaskShape(item) : null;
  if (shape && (hasSilhouetteFraming(item) || bakeableLayerStack(item, clip, BOX_ENTRY)
    || (Array.isArray(item.effects) && item.effects.some((e) => e && e.enabled !== false))
    || normalizeBlendMode(item.blendMode) !== 'normal')) shape = null;
  shaderBoxCache.set(item, { clip, shape });
  return shape;
}

/** The layer's mask needs the mask pass (an isolate and a coverage plate): every enabled mask but a box (shaderBoxMask). */
export function needsLayerMaskPass(item, clip) {
  return isLayerMaskEnabled(item) && !shaderBoxMask(item, clip);
}

export function boxAabb(box, insetPct = 0) {
  let x0 = 0; let y0 = 0; let x1 = 1; let y1 = 1;
  if (box) {
    const [ox, oy] = box.origin;
    const [ax, ay] = box.axisX;
    const [bx, by] = box.axisY;
    const ex = Math.abs(ax) + Math.abs(bx);
    const ey = Math.abs(ay) + Math.abs(by);
    x0 = Math.max(0, ox - ex); x1 = Math.min(1, ox + ex);
    y0 = Math.max(0, oy - ey); y1 = Math.min(1, oy + ey);
  }
  const k = Math.min(0.45, Math.max(0, insetPct) / 100);
  const ix = (x1 - x0) * k;
  const iy = (y1 - y0) * k;
  return [x0 + ix, y0 + iy, x1 - ix, y1 - iy];
}

// Echo's Analytic engine drives the same mesh through the same evaluator, from a
// different call site — its own scratch so a trail and an echo on one layer can
// never restore each other's pose.
export const _echoPos = new THREE.Vector3();

export const _echoEuler = new THREE.Euler();

export const _echoScale = new THREE.Vector3();

export function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}
