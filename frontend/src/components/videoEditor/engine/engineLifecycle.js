/*
 * The engine's life cycle (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 28c — moved verbatim out of the
 * Player's renderer and resize effects with tests/engine-extraction/tools/stage9_lifecycle.py): mountEngine builds
 * the renderer and the composite pipeline on a canvas, resizeEngine sizes the renderer, camera and planes, and
 * disposeEngine stops the loop and releases every GPU and media resource the engine holds. The Player's effects
 * call these; a React-free driver calls the same three.
 */
import * as THREE from 'three';
import { releaseAnimatedImages } from '../animatedImage';
import { disposeAutoFillCropTargets } from '../autofillField';
import { releaseMotionMedia } from '../motionTemplates';
import { notePerfRenderer } from '../perfRegistry.js';
import { disposeRigCropTargets } from '../rigDeform';
import { disposeChannelStates, resizeChannelStates } from './channelStates';
import { disposeCompositePipeline, flipAdjustmentGeoV, buildCompositePipeline } from './compositePipeline';
import { disposeEngine3d } from './modules3d';
import { compositeNearPlane, getPerspectiveDistance } from './compositeHelpers';
import { createEngineRenderer, stopEngineRenderer, disposeEngineRenderer } from './engineRenderer';
import { disposeBackgroundShader } from './background';
import { disposeWarmUp } from './warmUp';
import { releaseWorldLayerFx } from './worldLayerFx';

export function releaseEngineResources(engine) {
  cancelAnimationFrame(engine.animation);
  // World view holds an orbit/gizmo listener set and its own rAF tick, and it
  // borrowed this renderer and scene — tear it down before they go.
  try { engine.worldView?.dispose(); } catch { /* no-op */ }
  engine.worldView = null;
  engine.worldActive = false;
  for (const held of engine.worldModels.values()) { try { held.detach(); } catch { /* no-op */ } }
  engine.worldModels.clear();
  // Every model / plate / rig / particle resource (engine/modules3d.js).
  disposeEngine3d(engine);
  for (const lent of engine.worldGrids.values()) {
    try {
      lent.group.remove(lent.scene);
      lent.group.parent?.remove(lent.group);
    } catch { /* no-op */ }
  }
  engine.worldGrids.clear();
  releaseWorldLayerFx(engine);
  // Every channel state and sequence (compound clip) offscreen state (engine/channelStates.js).
  disposeChannelStates(engine);
  // Motion-blur pipeline holds render targets tied to this renderer.
  try { engine.motionBlurPipeline?.dispose(); } catch { /* no-op */ }
  engine.motionBlurPipeline = null;
  // Clean up all audio elements
  for (const audioEl of engine.audioElements.values()) {
    try { audioEl.pause(); audioEl.removeAttribute('src'); } catch { /* no-op */ }
  }
  engine.audioElements.clear();
  for (const entry of engine.videoTextureCache.values()) {
    try { entry.texture.dispose(); } catch { /* no-op */ }
  }
  engine.videoTextureCache.clear();
  for (const texture of engine.imageTextureCache.values()) {
    try { texture.dispose(); } catch { /* no-op */ }
  }
  engine.imageTextureCache.clear();
  for (const entry of engine.textTextureCache.values()) {
    try { entry.texture.dispose(); } catch { /* no-op */ }
  }
  engine.textTextureCache.clear();
  // Layer Mask coverage plates — same CanvasTexture contract as the text
  // cache above (dispose and recreate on resize, never canvas.width = n).
  for (const entry of engine.maskPlateCache.values()) {
    try { entry.texture.dispose(); } catch { /* no-op */ }
  }
  engine.maskPlateCache.clear();
  engine.maskCoverageStamp.clear();
  for (const entry of engine.mockupChassis.values()) {
    try { entry.texture?.dispose(); } catch { /* no-op */ }
    try { entry.frontTexture?.dispose(); } catch { /* no-op */ }
  }
  engine.mockupChassis.clear();
  engine.mockupDensity.clear();
  try { engine.mockupFramePass?.geometry?.dispose(); } catch { /* no-op */ }
  try { engine.mockupFramePass?.material?.dispose(); } catch { /* no-op */ }
  engine.mockupFramePass = null;
  engine.motionCache.clear();
  // Motion-template video decoders hold VideoDecoders + demuxed sample tables.
  releaseMotionMedia();
  // Decoded GIF/WebP/APNG frames are the biggest thing this module holds (a
  // whole file's worth of ImageBitmaps per url), so they go back with the rest
  // of the editor rather than living on until the tab is closed.
  releaseAnimatedImages();
  // Dispose adjustment-layer pipeline
  try {
    if (engine.adjustmentRT) {
      engine.adjustmentRT.a?.dispose();
      engine.adjustmentRT.b?.dispose();
      engine.adjustmentRT.c?.dispose();
      engine.adjustmentRT.d?.dispose();
      engine.adjustmentRT.e?.dispose();
      engine.adjustmentRT.f?.dispose();
    }
    if (engine.depthProbeRT) {
      engine.depthProbeRT.depthTexture?.dispose();
      engine.depthProbeRT.dispose();
      engine.depthProbeRT = null;
    }
    if (engine.sequenceAdjRT) {
      engine.sequenceAdjRT.a?.dispose();
      engine.sequenceAdjRT.b?.dispose();
      engine.sequenceAdjRT.c?.dispose();
      engine.sequenceAdjRT.d?.dispose();
      engine.sequenceAdjRT.e?.dispose();
      engine.sequenceAdjRT.f?.dispose();
    }
    if (engine.overlayFxRT) {
      for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) engine.overlayFxRT[key]?.dispose();
      engine.overlayFxRT = null;
    }
    for (const bank of engine.preTransitionFxRT.values()) {
      for (const key of ['source', 'a', 'b', 'c', 'd', 'e', 'f']) bank[key]?.dispose();
      bank.scene?.clear();
    }
    engine.preTransitionFxRT.clear();
    engine.preTransitionFxUsed.clear();
    engine.preTransitionFxItemIds.clear();
    engine.preTransitionFxPrepare = null;
    for (const target of engine.passPool.values()) target.dispose();
    engine.passPool = new Map();
    engine.matteClipMaterial = null;
    engine.layerMaskPass?.material?.dispose();
    engine.layerMaskPass = null;
    try {
      const ck = engine.chromaKeyPass;
      if (ck) { for (const m of Object.values(ck.mats || {})) m?.dispose?.(); ck.mesh?.geometry?.dispose?.(); }
    } catch { /* no-op */ }
    engine.chromaKeyPass = null;
    engine.adjustmentMaskPass?.material?.dispose();
    engine.adjustmentMaskPass = null;
    /*
     * EVERY LAZILY-CACHED GPU PASS MUST DIE WITH ITS RENDERER.
     *
     * Each of these is built on first use and cached in a ref. The three
     * above were released here; these eight were not, so after a pipeline
     * rebuild they were reused — holding geometry, buffers and materials
     * belonging to a renderer that no longer exists. The effect then draws
     * NOTHING, silently, on whichever renderer you land on.
     *
     * That is what "repetile stopped working on the default renderer after
     * switching engines" was, and it was never only repetile: an audit of
     * lazily-created passes against this teardown found eight, and the same
     * failure applies to all five warps, the rig and Auto Fill.
     *
     * Anything added later that caches a pass in a ref belongs in this list.
     */
    /*
     * The POOLED CROP TARGETS live in rigDeform / autofillField as module
     * state, not in a ref here, so the loop below cannot reach them. They
     * are render targets — bound to the context that made them — and a
     * pooled one from the previous renderer is dead. This is the same defect
     * as the passes below, one level out: the Rig came back broken after an
     * engine switch even once its pass was released, because its BAKE was
     * still drawing into a target belonging to the old renderer.
     */
    try { disposeRigCropTargets(); } catch { /* no-op */ }
    try { disposeAutoFillCropTargets(); } catch { /* no-op */ }
    for (const ref of [engine.refObjects.repetilePass, engine.refObjects.rigPass, engine.refObjects.autoFillRig, engine.refObjects.depthScanRig,
      engine.refObjects.bendPass, engine.refObjects.cornerPinPass, engine.refObjects.drostePass, engine.refObjects.pryzmPass, engine.refObjects.bezierWarpPass, engine.refObjects.meshWarpPass,
      engine.refObjects.regionDistortPass]) {
      try { ref.current?.material?.dispose(); } catch { /* no-op */ }
      try { ref.current?.geometry?.dispose(); } catch { /* no-op */ }
      ref.current = null;
    }
    /* Pryzm's private mipped source is a RENDER TARGET, so it belongs to the
       renderer that made it — exactly the defect described above for the
       Rig's pooled crops. Releasing the pass without releasing this would
       leave the glass drawing into a dead target after an engine switch. */
    try { engine.pryzmSrc?.dispose(); } catch { /* no-op */ }
    engine.pryzmSrc = null;
    // the pipeline's materials, the shared quad and the lazily built passes (engine/compositePipeline.js)
    disposeCompositePipeline(engine);
    // Compiled effect-chain materials (built-in + custom).
    for (const entry of engine.effectMaterials.values()) {
      try { entry.material?.dispose(); } catch { /* no-op */ }
    }
    engine.effectMaterials.clear();
  } catch { /* no-op */ }
  engine.adjustmentRT = null;
  engine.sequenceAdjRT = null;
  engine.adjustmentClipScene = null;
  engine.adjustmentClipMesh = null;
  engine.adjustmentGeo = null;
  engine.blitMaterial = null;
  engine.blitScene = null;
  engine.seqPlateCopyMaterial = null;
  engine.pictureCopyMaterial = null;
  engine.pictureCopyScene = null;
  engine.seqPlateCopyScene = null;
  engine.depthStampMaterial = null;
  engine.depthStampScene = null;
  engine.depthCompositeMaterial = null;
  engine.depthCompositeScene = null;
  engine.cameraDofMaterial = null;
  engine.cameraDofScene = null;
  engine.mixMaterial = null;
  engine.mixScene = null;
  engine.maskMaterial = null;
  engine.maskScene = null;
  engine.trackMatteMaterial = null;
  engine.trackMatteScene = null;
  engine.trackMattePlainMaterial = null;
  engine.trackMattePlainScene = null;
  engine.overBlitMaterial = null;
  engine.overBlitScene = null;
  engine.flattenScene = null;
  engine.glowMaterials = null;
  engine.glowScene = null;
  engine.glowMesh = null;
  engine.motionBlurMaterial = null; engine.motionBlurMesh = null; engine.motionBlurScene = null;
  engine.motionTrailMaterial = null; engine.motionTrailMesh = null; engine.motionTrailScene = null;
  engine.trailPass = null;
  engine.backdropPass = null;
  engine.glassPass = null;
  engine.blendPass = null;
  engine.materialFactory = null;
  engine.fsQuadGeo = null;
  if (engine.idleSweepTimer) { clearTimeout(engine.idleSweepTimer); engine.idleSweepTimer = null; }
  engine.effectScene = null;
  engine.effectMesh = null;
  engine.orthoCamera = null;
}

export function resizeEngine(engine, sizeVideoW, sizeVideoH, sizeRenderW, sizeRenderH) {
  engine.videoSize = { w: sizeVideoW, h: sizeVideoH };
  const renderer = engine.renderer;
  const camera = engine.camera;
  if (!renderer || !camera) return false;

  renderer.setSize(sizeRenderW, sizeRenderH, false);
  notePerfRenderer({ w: sizeRenderW, h: sizeRenderH });
  engine.previewRenderSize = { w: sizeRenderW, h: sizeRenderH };
  camera.aspect = sizeVideoW / sizeVideoH;
  camera.position.z = getPerspectiveDistance(sizeVideoH);
  camera.near = compositeNearPlane(camera.position.z);
  camera.updateProjectionMatrix();
  const posed = engine.posedCamera;
  if (posed) {
    posed.aspect = camera.aspect;
    posed.position.copy(camera.position);
    posed.updateProjectionMatrix();
  }

  // Plane geometry at the new size; sequence states rebuild lazily (engine/channelStates.js).
  resizeChannelStates(engine, sizeVideoW, sizeVideoH);

  // Keep the adjustment-layer plane sized to the frame too.
  if (engine.adjustmentClipMesh) {
    const oldAdjGeo = engine.adjustmentGeo;
    const newAdjGeo = flipAdjustmentGeoV(new THREE.PlaneGeometry(sizeVideoW, sizeVideoH));
    engine.adjustmentClipMesh.geometry = newAdjGeo;
    engine.adjustmentGeo = newAdjGeo;
    oldAdjGeo?.dispose();
  }
  return true;
}

export function handleContextLost(engine, event) {
  event.preventDefault();
  // The real backstop for adaptive raster density. Whatever budget was derived
  // from installed RAM, the machine has just told us it could not sustain what we
  // asked for — so halve it and drop every magnified plate back to baseline.
  // Hardware that cannot take the budget self-corrects; hardware that can is
  // never throttled by a guess.
  if (engine.rasterDensity.size > 0) {
    engine.rasterBudget?.halve();
    engine.rasterBudget?.reset();
    engine.rasterDensity.clear();
  }
  // Vector plates are the one canvas texture that is NOT redrawn every frame, so
  // they are also the only one that would come back from a restore still holding
  // its "already uploaded" key with nothing behind it. Force a repaint.
  for (const entry of engine.textTextureCache.values()) {
    entry.vectorKey = null;
    entry.paintSig = null; // text/shape plate paint cache — same reason
  }
}

export function handleContextRestored(engine) {
  engine.model3d?.handleModelContextRestored?.();
  engine.renderFrame?.();
}

/**
 * Build the renderer on `canvas` and the composite pipeline on it — what the Player's renderer effect does on mount
 * and on every pipeline rebuild. `events` are createEngineRenderer's (onReady, onError, onContextLost, …).
 */
export function mountEngine(engine, { canvas, backend, width, height, fov, distance, ...events }) {
  createEngineRenderer(engine, { canvas, backend, width, height, fov, distance, ...events });
  // the composite pipeline's fixed materials and scenes, the posed + ortho cameras and the shared quad
  buildCompositePipeline(engine, { camera: engine.camera, initW: width, initH: height, fov });
}

/** Stop the loop, release every GPU / media resource, the background shader and the renderer. */
export function disposeEngine(engine) {
  disposeWarmUp(engine);
  stopEngineRenderer(engine);
  releaseEngineResources(engine);
  // This engine's private shader-background GL renderer.
  disposeBackgroundShader(engine);
  disposeEngineRenderer(engine);
}
