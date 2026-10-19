/*
 * The compositor's state, OUTSIDE React (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Part 3 step 2 / Stage 9).
 *
 * The Player kept everything the compositor owns in useRef boxes — 250 of them — so the engine could only
 * live inside a React component. The extraction moves that state here, one subsystem at a time, into one
 * plain object that engine modules (./compositePipeline.js, …) read and write as fields.
 *
 * While the Player still holds code that reads those values through `xRef.current`, the engine field is a
 * BRIDGE to that ref (bindEngineRefs): moved code uses `engine.x`, the Player keeps `xRef.current`, and both
 * always see the same value. When the last `xRef` user has moved, the ref goes and the field is plain.
 */
// Every field the engine owns, created up front so the object keeps one shape.
import { engineInitialValues } from './engineInit';

const FIELDS = [
  // the renderer, its readiness and the main scene/camera (./engineRenderer.js)
  'renderer', 'rendererReady', 'rendererSession', 'scene', 'camera',
  // the composite pipeline (./compositePipeline.js)
  'posedCamera', 'orthoCamera', 'fsQuadGeo', 'materialFactory',
  'blitMaterial', 'blitScene', 'pictureCopyMaterial', 'pictureCopyScene', 'seqPlateCopyMaterial', 'seqPlateCopyScene',
  'depthStampMaterial', 'depthStampScene', 'depthCompositeMaterial', 'depthCompositeScene', 'cameraDofMaterial', 'cameraDofScene',
  'mixMaterial', 'mixScene', 'maskMaterial', 'maskScene', 'trackMatteMaterial', 'trackMatteScene',
  'trackMattePlainMaterial', 'trackMattePlainScene', 'overBlitMaterial', 'overBlitScene', 'flattenScene',
  'adjustmentGeo', 'adjustmentClipMesh', 'adjustmentClipScene', 'effectMesh', 'effectScene',
  'motionBlurMixMaterial', 'motionBlurMixMesh', 'motionBlurMixScene', 'matteClipMaterial', 'matteClipPlainMaterial',
  // lazily built passes (built on first use, cleared with the pipeline)
  'glowMaterials', 'glowMesh', 'glowScene', 'motionBlurMaterial', 'motionBlurMesh', 'motionBlurScene',
  'motionTrailMaterial', 'motionTrailMesh', 'motionTrailScene', 'trailPass', 'echoPass', 'timeshiftPass',
  'backdropPass', 'glassPass', 'blendPass',
  // ping-pong targets (created on first use, sized to the drawing buffer)
  'adjustmentRT', 'overlayFxRT',
  // the pass pool and the owners of its persistent rings (./passPool.js)
  'passPool', 'passUse', 'passFrame', 'colorRefStatic', 'echoState', 'trailState', 'timeshiftState', 'repetileHist',
  // the project background (./background.js)
  'background', 'backgroundCanvas', 'backgroundTexSize', 'backgroundShaderKey',
  // the playhead time the frame being drawn is for, and the composition size
  'currentTime', 'videoSize',
  // per-channel and per-sequence Three.js state (./channelStates.js)
  'channelStates', 'sequenceStates',
  // media textures (./mediaTextures.js): the caches, in-flight image loads, the seek / fresh-frame gates, the rVFC
  // frame loop, presented / uploaded media times, textures waiting to be disposed, and whether playback runs
  'imageTextureCache', 'imageTextureLoads', 'videoTextureCache', 'canvasTextureCache', 'pendingSeek', 'awaitingFreshFrame',
  'preparedVideoTexturePrime', 'videoFrameReady', 'rvfcLoop', 'presentedMediaTime', 'uploadedMediaTime', 'pendingDisposal',
  'isPlaying',
  // this frame's project camera pose (./camera.js)
  'cameraPose',
  // the lazily loaded 3D model / rig and particle runtimes (./modules3d.js)
  'model3d', 'model3dLoading', 'model3dModule', 'particle', 'particleModule',
  // transitions (./transitions.js): whether an export drives the media, the WebKit jump hold, videos being primed,
  // and the banks that run a layer's effects before its transition
  'exportActive', 'jumpHold', 'primeInFlight', 'preTransitionFxRT', 'preTransitionFxUsed',
  // scratch render targets (./renderTargets.js; adjustmentRT and overlayFxRT are listed with the pipeline)
  'sequenceAdjRT', 'depthProbeRT', 'pryzmSrc',
  // the layer warps' passes, built on first use (./layerWarps.js)
  'regionDistortPass', 'bendPass', 'meshWarpPass', 'bezierWarpPass', 'cornerPinPass', 'drostePass',
  // compiled overlay-effect materials + their LRU stamp, and the histogram probe's target (./effectMaterials.js)
  'effectMaterials', 'effectMaterialSeq', 'fxProbeRT',
  // Layer Mask coverage plates and what they publish, and the text/motion canvases (./layerMasks.js)
  'maskPlateCache', 'maskCoverageStamp', 'maskCoverageByItem', 'textTextureCache',
  // the history effects' own state beyond the pool (./historyEffects.js)
  'timeshiftSweep', 'repetilePass',
  // per-layer passes (./layerPasses.js), whether an export runs, and the repaint the async bakes call
  'autoFillRig', 'chromaKeyPass', 'depthScanRig', 'pryzmPass', 'silhouetteFramingPass', 'exporting', 'renderFrame',
  // an adjustment layer's Layer Mask mix (./compositeOps.js)
  'adjustmentMaskPass',
  // grids and Mockup Frame (./gridMockup.js), and the raster density settings they read
  'worldGrids', 'worldFxPlates', 'mockupFramePass', 'mockupChassis', 'mockupDensity', 'adaptiveRaster', 'rasterSupersample',
  // Mockup Frame's first-render values (set once by the Player), and the layer stages' passes (./layerStages.js)
  'mockupEnv', 'layerMaskCut', 'layerMaskPass', 'rigPass',
  // the motion passes (./motionPasses.js)
  'motionBlurModule', 'motionBlurPipeline', 'outputTarget',
  // ./effectChain.js
  'colorRefBakeKeys', 'colorRefPlates', 'layerStack', 'preTransitionFxItemIds', 'scrubPlate',
  // ./sequenceComposite.js
  'perfStats', 'rcMediaOnly', 'sequenceFrameStamp',
  // ./adjustmentComposite.js
  'alphaExport', 'autoFillLayers', 'backdropLayers', 'bendLayers', 'bezierWarpLayers', 'chromaKeyLayers', 'colorRefConsumed', 'colorRefKeys', 'colorRefSources', 'cornerPinLayers', 'depthPlates', 'depthScanLayers', 'drosteLayers', 'frRimLayers', 'glassLayers', 'glowLayers', 'layerDepthMode', 'layerItems', 'layerMaskLayers', 'matteSourceChannels', 'meshWarpLayers', 'mockupFrameLayers', 'modelDepth', 'modelDepthTex', 'modelSpillDepth', 'motionBlurLayers', 'motionTrailLayers', 'overlayFx', 'pryzmLayers', 'regionDistortLayers', 'repetileLayers', 'rigLayers', 'shaderBlendLayers', 'trackMatteLayers',
  // ./channelRender.js
  'activeRigAt', 'audioElements', 'ensureParticleModule', 'forceMuteAudio', 'frameToken', 'lastActiveIndex', 'loop', 'playbackStep', 'preTransitionFxPrepare', 'renderSequenceFrame', 'selectedItemId', 'shortAudio', 'soundEnabled', 'tightSyncUntil', 'worldActive',
  // ./layerMesh.js
  'ccCompare', 'ccProbe', 'ccSourceReq', 'fontLoadVersion', 'motionCache', 'placeholderEnv', 'rasterDensity',
  // ./frameRender.js
  'cameraItem', 'gifPump', 'idleSweepTimer', 'mediaPump', 'planeOrderApplied', 'rcDrewCache', 'rcFrameTexture', 'rcPlate', 'rcSample', 'rcTargetMs', 'renderCache', 'rigEntries', 'selectedLight', 'selectedRigEnd', 'worldLightItem', 'worldModels', 'worldView',
  // ./warmUp.js
  'warmUp',
  // ./mediaClock.js
  'seekGeneration', 'seekTimeout', 'sourceGeneration',
  // ./engineLifecycle.js
  'animation', 'previewRenderSize', 'rasterBudget',
  // ./exporter.js
  'canvas', 'committedTime', 'motionBlurEnabled', 'motionBlurShutter', 'outputSize',
  // ./engineEffects.js
  'fpsCap', 'lastPlayhead', 'lastTick', 'nextRenderDeadline', 'rcStop', 'videoLoadPoll',
  // what buildCompositePipeline made, so disposeCompositePipeline releases exactly that
  'pipelineBuilt',
  // the bound ref OBJECTS, for code that hands a ref itself to a helper (bindEngineRefs)
  'refObjects',
  // set once the Player's refs are bound (bindEngineRefs)
  'boundRefs',
];

export function createEngineState() {
  const engine = {};
  for (const key of FIELDS) engine[key] = null;
  // the starting values that need nothing from the editor (./engineInit.js) — a complete engine without a Player
  Object.assign(engine, engineInitialValues());
  return engine;
}

/**
 * Expose the Player's refs as engine fields (once per engine): `engine.x` reads and writes `xRef.current`, so
 * code that moved into engine modules and code still in the Player share one value. The refs stay real
 * useRefs — React's hook lint and every `xRef.current` keep working — until their last Player user moves.
 */
export function bindEngineRefs(engine, refs) {
  if (engine.boundRefs) return;
  for (const [key, ref] of Object.entries(refs)) {
    if (!(key in engine)) throw new Error(`engine has no field "${key}"`);
    Object.defineProperty(engine, key, {
      get: () => ref.current,
      set: (value) => { ref.current = value; },
      enumerable: true,
      configurable: true,
    });
  }
  engine.refObjects = refs;
  engine.boundRefs = true;
}
