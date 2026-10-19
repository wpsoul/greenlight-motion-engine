/*
 * GENERATED from Player.jsx by tests/engine-extraction/tools/gen_driver_wiring.py — do not edit; regenerate after any
 * Stage 9 step (`--check` fails while it is out of date). The editor's envs as plain objects and its engine handles as
 * closures, for the React-free driver (engine/motionEngine.js, PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md step 28e4): the
 * driver renders through exactly the code paths the editor does.
 */
import { perfRegistry } from '../perfRegistry.js';
import { resolvePreviewFpsCap } from '../previewDeviceTier.js';
import { renderCacheTargetFps } from '../renderCache.js';
import { setLayerDepthMode as setLayerDepthModeInEngine } from './adjustmentComposite';
import { renderChannel as renderChannelInEngine } from './channelRender';
import { ensureSequenceState as ensureSequenceStateInEngine } from './channelStates';
import { preparePreTransitionOverlayEffects as preparePreTransitionOverlayEffectsInEngine } from './effectChain';
import { applyTextureQuality as applyTextureQualityInEngine, followCurrentTime as followCurrentTimeInEngine, loadMaterials as loadMaterialsInEngine, loadMotionImages as loadMotionImagesInEngine, loadTextFonts as loadTextFontsInEngine, pollVideoReadiness as pollVideoReadinessInEngine, pruneModelLayers as pruneModelLayersInEngine, pruneParticleRuntimes as pruneParticleRuntimesInEngine, pruneTransitionPackages as pruneTransitionPackagesInEngine, repaintOnAnimatedImageFrames as repaintOnAnimatedImageFramesInEngine, repaintOnBakes as repaintOnBakesInEngine, repaintOnDepthTextures as repaintOnDepthTexturesInEngine, repaintOnHtmlLiveFrames as repaintOnHtmlLiveFramesInEngine, repaintOnImagePlates as repaintOnImagePlatesInEngine, repaintOnInlineTextEdit as repaintOnInlineTextEditInEngine, repaintOnMockupSvg as repaintOnMockupSvgInEngine, repaintOnModelAssets as repaintOnModelAssetsInEngine, repaintOnMotionMediaFrames as repaintOnMotionMediaFramesInEngine, repaintOnMotionTemplates as repaintOnMotionTemplatesInEngine, runPlaybackLoop as runPlaybackLoopInEngine, watchEffectPackages as watchEffectPackagesInEngine, watchTransitionPackages as watchTransitionPackagesInEngine } from './engineEffects';
import { handleContextLost as handleContextLostInEngine, handleContextRestored as handleContextRestoredInEngine } from './engineLifecycle';
import { captureFrameAtTime as captureFrameAtTimeInEngine, exportVideo as exportVideoInEngine } from './exporter';
import { activeRigAt as activeRigAtInEngine, awaitMotionImages as awaitMotionImagesInEngine, getRasterBudget as getRasterBudgetInEngine, getRasterCaps as getRasterCapsInEngine, hasModel3dLayers as hasModel3dLayersInEngine, hasParticleLayers as hasParticleLayersInEngine, settleParticlePlates as settleParticlePlatesInEngine } from './frameQueries';
import { renderFrame as renderFrameInEngine } from './frameRender';
import { returnBorrowedGrids as returnBorrowedGridsInEngine } from './gridMockup';
import { setupMesh as setupMeshInEngine } from './layerMesh';
import { applyChromaKey as applyChromaKeyInEngine, applySilhouetteFraming as applySilhouetteFramingInEngine, renderLayerAutoFill as renderLayerAutoFillInEngine, renderLayerDepthScan as renderLayerDepthScanInEngine, renderLayerFresnelRim as renderLayerFresnelRimInEngine } from './layerPasses';
import { renderLayerRig as renderLayerRigInEngine, runLayerGeometryStages as runLayerGeometryStagesInEngine } from './layerStages';
import { activateMediaForGesture as activateMediaForGestureInEngine, ensureChannelStates as ensureChannelStatesInEngine, getTotalDuration as getTotalDurationInEngine, seekAllVideosForTime as seekAllVideosForTimeInEngine, seekParticleObjectVideos as seekParticleObjectVideosInEngine, seekVideoAndWait as seekVideoAndWaitInEngine, syncTransitionSounds as syncTransitionSoundsInEngine, syncVideo as syncVideoInEngine } from './mediaClock';
import { awaitImageTextures as awaitImageTexturesInEngine } from './mediaTextures';
import { resolveFollow as resolveFollowInEngine, resolveParenting as resolveParentingInEngine } from './meshTransform';
import { ensureParticleModule as ensureParticleModuleInEngine } from './modules3d';
import { getMotionBlurPipeline as getMotionBlurPipelineInEngine, renderLayerGlow as renderLayerGlowInEngine } from './motionPasses';
import { PREVIEW_TIER } from './previewMedia';
import { deriveRigEntries } from './projectDerive';
import { renderSequenceFrame as renderSequenceFrameInEngine } from './sequenceComposite';
import { deactivateTransitionPackageMedia as deactivateTransitionPackageMediaInEngine, ensureTransitionPackageMedia as ensureTransitionPackageMediaInEngine } from './transitions';

/** The names wireEngine reads from the driver's live values. */
export const WIRING_VALUES = ['SCRUB_SETTLE_MS', 'adaptiveRasterMode', 'backgroundUrls', 'channels', 'clipsMap', 'currentTime', 'fontLoadVersion', 'forceMuteAudio', 'interactivePreviewEnabled', 'isPlaying', 'layoutMap', 'loop', 'markers', 'materialsReady', 'motionBlurEnabled', 'motionBlurShutter', 'motionImageUrls', 'motionPathEditItemId', 'outputSize', 'parentIndex', 'previewFps', 'previewQuality', 'projectFps', 'rcFrameTexture', 'rcStop', 'renderCache', 'renderHeight', 'renderWidth', 'rotoPreview', 'selectedLightId', 'setCurrentTime', 'setFontLoadVersion', 'setIsPlaying', 'setMaterialsReady', 'setPlayheadTime', 'setRendererError', 'setRendererErrorDetail', 'setTransitionRegistryRevision', 'setWorldViewActive', 'shapeBackgroundUrls', 'soundEnabled', 'textFontLoadRequest', 'transitionSoundCues', 'videoHeight', 'videoWidth'];

/** Each env's dependency list in the Player — the values whose change makes the editor rebuild it. */
export const ENV_DEPS = {
  applyTextureQualityEnv: ['adaptiveRasterMode'],
  pruneTransitionPackagesEnv: ['channels', 'clipsMap'],
  watchTransitionPackagesEnv: [],
  cuesEnv: ['transitionSoundCues'],
  previewEnv: ['interactivePreviewEnabled'],
  parentEnv: ['parentIndex'],
  previewParentEnv: ['interactivePreviewEnabled', 'parentIndex'],
  loadTextFontsEnv: ['textFontLoadRequest'],
  urlsEnv: ['motionImageUrls', 'backgroundUrls', 'shapeBackgroundUrls'],
  loadMotionImagesEnv: ['motionImageUrls', 'shapeBackgroundUrls', 'backgroundUrls'],
  durationEnv: ['channels', 'layoutMap'],
  timelineEnv: ['channels', 'clipsMap', 'layoutMap'],
  syncEnv: ['isPlaying', 'projectFps'],
  meshEnv: ['interactivePreviewEnabled', 'isPlaying', 'getRasterBudget', 'getRasterCaps'],
  statesEnv: ['channels', 'soundEnabled'],
  channelEnv: ['clipsMap', 'projectFps', 'getTotalDuration', 'isPlaying', 'layoutMap', 'parentIndex', 'rotoPreview?.itemId', 'setupMesh', 'syncVideo'],
  sequenceFrameEnv: ['interactivePreviewEnabled', 'parentIndex', 'clipsMap', 'renderChannel'],
  layersEnv: ['channels', 'clipsMap'],
  pruneParticleRuntimesEnv: ['channels', 'clipsMap'],
  pruneModelLayersEnv: ['channels', 'clipsMap'],
  adjustmentEnv: ['interactivePreviewEnabled', 'parentIndex', 'channels', 'clipsMap'],
  frameEnv: ['SCRUB_SETTLE_MS', 'channels', 'clipsMap', 'ensureChannelStates', 'interactivePreviewEnabled', 'layoutMap', 'motionPathEditItemId', 'parentIndex', 'projectFps', 'syncTransitionSounds', 'isPlaying', 'getTotalDuration', 'setupMesh', 'syncVideo', 'rotoPreview?.itemId'],
  followCurrentTimeEnv: ['currentTime'],
  loadMaterialsEnv: ['materialsReady'],
  exportEnv: ['awaitMotionImages', 'channels', 'clipsMap', 'layoutMap', 'parentIndex', 'renderHeight', 'renderWidth', 'setCurrentTime', 'setIsPlaying', 'setPlayheadTime', 'setWorldViewActive', 'transitionSoundCues', 'videoHeight', 'videoWidth'],
  runPlaybackLoopEnv: ['isPlaying', 'setCurrentTime', 'setIsPlaying', 'setPlayheadTime', 'channels', 'layoutMap', 'clipsMap'],
  gestureEnv: ['channels', 'clipsMap', 'transitionSoundCues'],
  pollVideoReadinessEnv: ['isPlaying'],
};

/** The editor's envs and engine handles for `engine`, reading the driver's live values `v`. */
export function wireEngine(engine, v) {
  const envs = {};
  const h = {};
  h.repaintOnMockupSvg = () => repaintOnMockupSvgInEngine(engine);
  h.repaintOnMotionTemplates = () => repaintOnMotionTemplatesInEngine(engine);
  h.repaintOnDepthTextures = () => repaintOnDepthTexturesInEngine(engine);
  h.repaintOnModelAssets = () => repaintOnModelAssetsInEngine(engine);
  h.repaintOnInlineTextEdit = () => repaintOnInlineTextEditInEngine(engine);
  h.applyTextureQuality = () => applyTextureQualityInEngine(engine, envs.applyTextureQualityEnv);
  h.getRasterBudget = () => getRasterBudgetInEngine(engine);
  h.getRasterCaps = () => getRasterCapsInEngine(engine);
  h.getMotionBlurPipeline = () => getMotionBlurPipelineInEngine(engine);
  h.pruneTransitionPackages = () => pruneTransitionPackagesInEngine(engine, envs.pruneTransitionPackagesEnv);
  h.activeRigAt = (time) => activeRigAtInEngine(engine, time);
  h.watchTransitionPackages = () => watchTransitionPackagesInEngine(engine, envs.watchTransitionPackagesEnv);
  h.watchEffectPackages = () => watchEffectPackagesInEngine(engine);
  h.syncTransitionSounds = (time) => syncTransitionSoundsInEngine(engine, envs.cuesEnv, time);
  h.loadTextFonts = () => loadTextFontsInEngine(engine, envs.loadTextFontsEnv);
  h.repaintOnImagePlates = () => repaintOnImagePlatesInEngine(engine);
  h.awaitMotionImages = () => awaitMotionImagesInEngine(engine, envs.urlsEnv);
  h.loadMotionImages = () => loadMotionImagesInEngine(engine, envs.loadMotionImagesEnv);
  h.repaintOnMotionMediaFrames = () => repaintOnMotionMediaFramesInEngine(engine);
  h.repaintOnAnimatedImageFrames = () => repaintOnAnimatedImageFramesInEngine(engine);
  h.repaintOnBakes = () => repaintOnBakesInEngine(engine);
  h.getTotalDuration = () => getTotalDurationInEngine(engine, envs.durationEnv);
  h.awaitImageTextures = (timeoutMs = 15000) => awaitImageTexturesInEngine(engine, timeoutMs);
  h.ensureTransitionPackageMedia = (cs, definition) => ensureTransitionPackageMediaInEngine(cs, definition);
  h.deactivateTransitionPackageMedia = (cs) => deactivateTransitionPackageMediaInEngine(cs);
  h.syncVideo = (video, clip, targetTime, options) => syncVideoInEngine(engine, envs.syncEnv, video, clip, targetTime, options);
  h.setupMesh = (mesh, material, item, clip, video, progress, durationSec, cs, overrideTexture, parentXform, itemFollow) => setupMeshInEngine(engine, envs.meshEnv, mesh, material, item, clip, video, progress, durationSec, cs, overrideTexture, parentXform, itemFollow);
  h.ensureChannelStates = () => ensureChannelStatesInEngine(engine, envs.statesEnv);
  h.resolveParenting = (index, item, time) => resolveParentingInEngine(engine, index, item, time);
  h.resolveFollow = (index, item, time) => resolveFollowInEngine(engine, index, item, time);
  h.renderChannel = (channel, time, ctx) => renderChannelInEngine(engine, envs.channelEnv, channel, time, ctx);
  h.ensureSequenceState = (itemId, seqClip) => ensureSequenceStateInEngine(engine, itemId, seqClip);
  h.applyChromaKey = (src, ck, t, camAxis = true) => applyChromaKeyInEngine(engine, src, ck, t, camAxis);
  h.applySilhouetteFraming = (src, ck, mesh, t, camAxis = true) => applySilhouetteFramingInEngine(engine, src, ck, mesh, t, camAxis);
  h.preparePreTransitionOverlayEffects = (opts) => preparePreTransitionOverlayEffectsInEngine(engine, envs.previewParentEnv, opts);
  h.renderSequenceFrame = (seqClip, item, localTime, depth, rateScale, absoluteTime, levelParentIndex, parentXform, cameraPose, baseCamera, scopeKey) => renderSequenceFrameInEngine(engine, envs.sequenceFrameEnv, seqClip, item, localTime, depth, rateScale, absoluteTime, levelParentIndex, parentXform, cameraPose, baseCamera, scopeKey);
  h.hasModel3dLayers = () => hasModel3dLayersInEngine(engine, envs.layersEnv);
  h.ensureParticleModule = () => ensureParticleModuleInEngine(engine, () => {
    if (!engine.exporting && !engine.isPlaying) engine.renderFrame?.();
  });
  h.settleParticlePlates = () => settleParticlePlatesInEngine(engine);
  h.hasParticleLayers = () => hasParticleLayersInEngine(engine, envs.layersEnv);
  h.pruneParticleRuntimes = () => pruneParticleRuntimesInEngine(engine, envs.pruneParticleRuntimesEnv);
  h.pruneModelLayers = () => pruneModelLayersInEngine(engine, envs.pruneModelLayersEnv);
  h.renderLayerGlow = (srcTarget, fieldTarget, outTarget, glow, t) => renderLayerGlowInEngine(engine, envs.previewEnv, srcTarget, fieldTarget, outTarget, glow, t);
  h.renderLayerAutoFill = (srcTarget, af, layerMesh, t, flipPlate = false) => renderLayerAutoFillInEngine(engine, srcTarget, af, layerMesh, t, flipPlate);
  h.renderLayerDepthScan = (srcTarget, scan, layerMesh, chCam, t, flipPlate = false) => renderLayerDepthScanInEngine(engine, srcTarget, scan, layerMesh, chCam, t, flipPlate);
  h.renderLayerFresnelRim = (srcTarget, fr, layerMesh, chCam, t, flipPlate = false) => renderLayerFresnelRimInEngine(engine, srcTarget, fr, layerMesh, chCam, t, flipPlate);
  h.renderLayerRig = (rt, rigFx, layerMesh, t, camAxis = true) => renderLayerRigInEngine(engine, rt, rigFx, layerMesh, t, camAxis);
  h.runLayerGeometryStages = (out0, stack, ctx) => runLayerGeometryStagesInEngine(engine, out0, stack, ctx);
  h.renderFrame = () => renderFrameInEngine(engine, envs.frameEnv);
  h.followCurrentTime = () => followCurrentTimeInEngine(engine, envs.followCurrentTimeEnv);
  h.repaintOnHtmlLiveFrames = () => repaintOnHtmlLiveFramesInEngine(engine);
  h.setLayerDepthMode = (on) => setLayerDepthModeInEngine(engine, on);
  h.returnBorrowedGrids = () => returnBorrowedGridsInEngine(engine);
  h.loadMaterials = () => loadMaterialsInEngine(engine, envs.loadMaterialsEnv);
  h.handleContextLost = (event) => handleContextLostInEngine(engine, event);
  h.handleContextRestored = () => handleContextRestoredInEngine(engine);
  h.seekVideoAndWait = (video, targetTime) => seekVideoAndWaitInEngine(engine, video, targetTime);
  h.seekParticleObjectVideos = (time) => seekParticleObjectVideosInEngine(engine, envs.timelineEnv, time);
  h.seekAllVideosForTime = (time) => seekAllVideosForTimeInEngine(engine, envs.timelineEnv, time);
  h.captureFrameAtTimeImpl = (time, opts) => captureFrameAtTimeInEngine(engine, envs.exportEnv, time, opts);
  h.exportVideoImpl = (format, onProgress, signal, exportFps, onOutputChunk, frameSinks, timeRange, encodeOpts) => exportVideoInEngine(engine, envs.exportEnv, format, onProgress, signal, exportFps, onOutputChunk, frameSinks, timeRange, encodeOpts);
  h.runPlaybackLoop = () => runPlaybackLoopInEngine(engine, envs.runPlaybackLoopEnv);
  h.activateMediaForGesture = (soundOn, willPlay) => activateMediaForGestureInEngine(engine, envs.gestureEnv, soundOn, willPlay);
  h.pollVideoReadiness = () => pollVideoReadinessInEngine(engine, envs.pollVideoReadinessEnv);
  envs.applyTextureQualityEnv = { adaptiveRasterMode: v.adaptiveRasterMode };
  envs.pruneTransitionPackagesEnv = { channels: v.channels, clipsMap: v.clipsMap };
  envs.watchTransitionPackagesEnv = { setTransitionRegistryRevision: v.setTransitionRegistryRevision };
  envs.cuesEnv = { transitionSoundCues: v.transitionSoundCues };
  envs.previewEnv = { interactivePreviewEnabled: v.interactivePreviewEnabled };
  envs.parentEnv = { parentIndex: v.parentIndex };
  envs.previewParentEnv = { interactivePreviewEnabled: v.interactivePreviewEnabled, parentIndex: v.parentIndex };
  envs.loadTextFontsEnv = { setFontLoadVersion: v.setFontLoadVersion, textFontLoadRequest: v.textFontLoadRequest };
  envs.urlsEnv = { motionImageUrls: v.motionImageUrls, backgroundUrls: v.backgroundUrls, shapeBackgroundUrls: v.shapeBackgroundUrls };
  envs.loadMotionImagesEnv = { backgroundUrls: v.backgroundUrls, motionImageUrls: v.motionImageUrls, setFontLoadVersion: v.setFontLoadVersion, shapeBackgroundUrls: v.shapeBackgroundUrls };
  envs.durationEnv = { channels: v.channels, layoutMap: v.layoutMap };
  envs.timelineEnv = { channels: v.channels, clipsMap: v.clipsMap, layoutMap: v.layoutMap };
  envs.syncEnv = { isPlaying: v.isPlaying, projectFps: v.projectFps, forceMuteAudio: v.forceMuteAudio };
  envs.meshEnv = { interactivePreviewEnabled: v.interactivePreviewEnabled, isPlaying: v.isPlaying, getRasterBudget: h.getRasterBudget, getRasterCaps: h.getRasterCaps, markers: v.markers };
  envs.statesEnv = { channels: v.channels, soundEnabled: v.soundEnabled };
  envs.channelEnv = { clipsMap: v.clipsMap, layoutMap: v.layoutMap, parentIndex: v.parentIndex, projectFps: v.projectFps, isPlaying: v.isPlaying, getTotalDuration: h.getTotalDuration, setupMesh: h.setupMesh, syncVideo: h.syncVideo, rotoPreview: v.rotoPreview };
  envs.sequenceFrameEnv = { interactivePreviewEnabled: v.interactivePreviewEnabled, parentIndex: v.parentIndex, clipsMap: v.clipsMap, renderChannel: h.renderChannel };
  envs.layersEnv = { channels: v.channels, clipsMap: v.clipsMap };
  envs.pruneParticleRuntimesEnv = { channels: v.channels, clipsMap: v.clipsMap };
  envs.pruneModelLayersEnv = { channels: v.channels, clipsMap: v.clipsMap };
  envs.adjustmentEnv = { interactivePreviewEnabled: v.interactivePreviewEnabled, parentIndex: v.parentIndex, channels: v.channels, clipsMap: v.clipsMap };
  envs.frameEnv = { SCRUB_SETTLE_MS: v.SCRUB_SETTLE_MS, channels: v.channels, clipsMap: v.clipsMap, ensureChannelStates: h.ensureChannelStates, interactivePreviewEnabled: v.interactivePreviewEnabled, layoutMap: v.layoutMap, motionPathEditItemId: v.motionPathEditItemId, parentIndex: v.parentIndex, projectFps: v.projectFps, syncTransitionSounds: h.syncTransitionSounds, isPlaying: v.isPlaying, getTotalDuration: h.getTotalDuration, setupMesh: h.setupMesh, syncVideo: h.syncVideo, rotoPreview: v.rotoPreview, previewQuality: v.previewQuality };
  envs.followCurrentTimeEnv = { currentTime: v.currentTime };
  envs.loadMaterialsEnv = { materialsReady: v.materialsReady, setMaterialsReady: v.setMaterialsReady, setRendererError: v.setRendererError, setRendererErrorDetail: v.setRendererErrorDetail };
  envs.exportEnv = { awaitMotionImages: h.awaitMotionImages, channels: v.channels, clipsMap: v.clipsMap, ensureTransitionPackageMedia: h.ensureTransitionPackageMedia, hasModel3dLayers: h.hasModel3dLayers, hasParticleLayers: h.hasParticleLayers, layoutMap: v.layoutMap, parentIndex: v.parentIndex, renderHeight: v.renderHeight, renderWidth: v.renderWidth, setCurrentTime: v.setCurrentTime, setIsPlaying: v.setIsPlaying, setPlayheadTime: v.setPlayheadTime, setWorldViewActive: v.setWorldViewActive, settleParticlePlates: h.settleParticlePlates, transitionSoundCues: v.transitionSoundCues, videoHeight: v.videoHeight, videoWidth: v.videoWidth };
  envs.runPlaybackLoopEnv = { channels: v.channels, clipsMap: v.clipsMap, isPlaying: v.isPlaying, layoutMap: v.layoutMap, setCurrentTime: v.setCurrentTime, setIsPlaying: v.setIsPlaying, setPlayheadTime: v.setPlayheadTime };
  envs.gestureEnv = { channels: v.channels, clipsMap: v.clipsMap, transitionSoundCues: v.transitionSoundCues };
  envs.pollVideoReadinessEnv = { isPlaying: v.isPlaying };
  return { envs, h };
}

/** The engine fields the editor sets on every render, from the driver's handles `h` and live values `v`. */
export function syncEngineFields(engine, h, v) {
  const envs = null; // eslint-disable-line no-unused-vars
  engine.outputSize = v.outputSize;
  engine.fontLoadVersion = v.fontLoadVersion;
  engine.loop = v.loop;
  engine.soundEnabled = v.soundEnabled;
  engine.forceMuteAudio = v.forceMuteAudio;
  engine.isPlaying = v.isPlaying;
  engine.fpsCap = resolvePreviewFpsCap(PREVIEW_TIER, v.projectFps, v.previewFps);
  perfRegistry.fpsCap = engine.fpsCap;
  engine.renderCache = v.renderCache;
  engine.rcTargetMs = 1000 / renderCacheTargetFps(v.projectFps, engine.fpsCap);
  if (!perfRegistry.renderCache) perfRegistry.renderCache = { cachedFrames: 0, liveFrames: 0, last: null };
  engine.rcFrameTexture = v.rcFrameTexture;
  engine.rcStop = v.rcStop;
  engine.motionBlurEnabled = v.motionBlurEnabled;
  engine.motionBlurShutter = v.motionBlurShutter;
  engine.selectedLight = v.selectedLightId;
  engine.rigEntries = deriveRigEntries({ channels: v.channels, clipsMap: v.clipsMap, layoutMap: v.layoutMap });
  engine.activeRigAt = h.activeRigAt;
  engine.preTransitionFxPrepare = h.preparePreTransitionOverlayEffects;
  engine.renderSequenceFrame = h.renderSequenceFrame;
  engine.ensureParticleModule = h.ensureParticleModule;
  engine.layerStack = {
    chromaKey: h.applyChromaKey,
    silhouetteFraming: h.applySilhouetteFraming,
    geometry: h.runLayerGeometryStages,
    glow: h.renderLayerGlow,
    autoFill: h.renderLayerAutoFill,
    depthScan: h.renderLayerDepthScan,
    fresnelRim: h.renderLayerFresnelRim,
    rig: h.renderLayerRig,
  };
  if (!engine.mockupEnv) engine.mockupEnv = { getRasterCaps: h.getRasterCaps, getRasterBudget: h.getRasterBudget, interactivePreviewEnabled: v.interactivePreviewEnabled };
}
