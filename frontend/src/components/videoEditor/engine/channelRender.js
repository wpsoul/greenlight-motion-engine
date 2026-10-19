/*
 * One channel's frame (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 25 — moved verbatim out of Player.jsx with
 * tests/engine-extraction/tools/stage9_step.py): renderChannel finds the channel's live item(s) at `time`, keeps their
 * media in step (videos, audio, preloads, hand-offs between cut clips), sets up their meshes, plays a cross
 * transition's two sides, and places 3D models, particles and camera-driven plates.
 *
 * `env` carries the live editor values it reads (`clipsMap`, `layoutMap`, `parentIndex`, `projectFps`, `isPlaying`)
 * and, until they move too, the Player's getTotalDuration, setupMesh and syncVideo; the Player memoizes it over
 * exactly what the old callback listed as dependencies.
 */
import { collidersOf, PARTICLE_MEDIA_TYPE, proximityDrivesMotion, proximityFeedsPacking } from '../../../sim/particles/schema.js';
import { hasActiveLayerOverlayEffects } from '../adjustmentEffects';
import { getAdvancedTransitionPreset, resolveAdvancedTransitionOptions } from '../advancedTransitions';
import { applyMute, applyVolume, parkAudio, startPlayingAudio, syncPlayingAudio } from '../audioDriftSync';
import { audioFadeGainAt } from '../audioFade';
import { isAutoFillEnabled, resolveAutoFillParams } from '../autoFillLayer';
import { applyBlendMode, resetMaterialUniforms } from '../clipShader';
import { getDepthCameraShift } from '../depthParallax';
import { activeEffectPrecomposeStage } from '../effectTransitionOrder';
import { applyCrossTransition, applyGsapEasing, applyLayerTransition, getItemKeyframeValues, integratePathRate, itemHasKeyframes } from '../gsapTransitions';
import { bindHtmlLiveCanvas, htmlLiveCanvas, htmlLivePrepare } from '../htmlLive';
import { localPrs } from '../keyframeParenting';
import { isLayerMaskEnabled } from '../layerMask';
import { layerDriveTableFor } from '../layerVelocity';
import { withFlatEffects } from '../model3dFxCatalog';
import { isNullClip, nullPreviewClip, nullPreviewItem } from '../nullLayer';
import { particleSourceFromLayer } from '../particleObjectRaster';
import { proxAnimatedParams, proxCfgAt } from '../particleProxKf';
import { colliderTracksFor, emitterGateFor, proxPosesAt, proxSolverInputFor } from '../particleProxTrack';
import { perfRegistry } from '../perfRegistry.js';
import { ensurePreviewAudio } from '../previewAudioMedia.js';
import { isInactiveTextureNeededAsFallback, reconcileChannelPreviewMedia, shouldPrepareNextVideo } from '../previewMediaLifecycle';
import { isCameraChannel, isCameraClip } from '../projectCamera';
import { isCameraBaked3dPlate, isScenePlate, RIG_MEDIA_TYPE } from '../rig3d';
import { prerenderPlaybackClip } from '../sequencePrerender';
import { getSpeedAtTime } from '../speedUtils';
import { hideTransitionPackageInstances, renderTransitionPackage } from '../transitionPackageRuntime';
import { isAdvancedLayerTransition, isContainerClip, LayerTransitionType, TransitionEasing, TransitionType } from '../types';
import { hasVideoStabilization } from '../videoStabilization';
import { applyCameraRig } from './camera';
import { _platePos, resolveActiveIndex } from './compositeHelpers';
import { bakeableLayerStack, calculateVideoTime, layerContentBox } from './layerHelpers';
import { getClipPlaybackUrl, normalizeUrl, primePreparedVideoTexture as primePreparedVideoTextureInEngine } from './mediaTextures';
import { resolveFollow as resolveFollowInEngine, resolveParenting as resolveParentingInEngine } from './meshTransform';
import { requestModel3dModule } from './modules3d';
import { mediaActivation } from './previewMedia';
import { deactivateTransitionPackageMedia as deactivateTransitionPackageMediaInEngine, syncTransitionPackageMedia as syncTransitionPackageMediaInEngine } from './transitions';
import { CLIP_BOUNDARY_CONVERGE_S, CLIP_HANDOFF_SYNC_MS, IDLE_CHANNEL_PRELOAD_LEAD, NEXT_CLIP_PRELOAD_WINDOW, _modelSize, _plateQuat, _plateScale, easeLayerSlot, resolveModelFx3d } from './compositeHelpers';

export function renderChannel(engine, env, channel, time, ctx = null) {
  const cs = (ctx ? ctx.channelStates : engine.channelStates).get(channel.id);
  const layout = ctx ? ctx.layoutFor(channel) : env.layoutMap.get(channel.id);
  const cMap = ctx ? ctx.clipsMap : env.clipsMap;
  // Sequence prerender (sequencePrerender.js): a sequence clip with a valid
  // prerender is PLAYED as a video clip in the preview — the transparent WebM the
  // server rendered from its inner timeline — instead of rendering that timeline
  // live. The export always renders live, so the swap is off while exporting.
  const getClip = (id) => {
    const c = cMap.get(id);
    if (!c || c.mediaType !== 'sequence' || engine.exporting) return c;
    return prerenderPlaybackClip(c, engine.videoSize.w, engine.videoSize.h, env.projectFps) || c;
  };
  const channelAudio = () => engine.audioElements.get(`${channel.id}_audio`);
  const reconcileMedia = ({ allowAudio = false, allowedVideos = [] } = {}) => (
    reconcileChannelPreviewMedia({
      audio: channelAudio(),
      videos: cs ? [cs.videos.a, cs.videos.b] : [],
      allowAudio,
      allowedVideos,
    })
  );
  // Camera rig. Top level only (`ctx` is a sequence's inner timeline, whose output
  // is a texture that the sequence clip's own plane already carries through the
  // rig), never for a channel that opted out with the lock, and never for the
  // camera channel itself. cameraPoseRef is resolved once per frame in renderFrame.
  if (cs && !ctx) {
    // Rigs no longer carry the camera pose — the posed camera does, for every layer
    // and for the model pass alike. The rig's (zoom, zoom, 1) scale was applied
    // before its tilt, so it diverged from a real camera by up to half a frame width
    // once zoom and tilt combined; see MODEL_3D_LAYERS_PLAN.md, Phase 0.5.
    //
    // `rigged` survives as "is this channel filmed by the posed camera", which is
    // what 3D Depth's parallax still keys off: a camera-locked channel doesn't move
    // with the camera, so its layers must not parallax either. Stored at strength
    // 100 % and scaled per item in env.setupMesh.
    const rigged = !engine.worldActive && !channel.cameraLocked && !isCameraChannel(channel);
    applyCameraRig(cs.rig, null, engine.videoSize.w, engine.videoSize.h);
    // 3D Depth rides the same rig decision: a camera-locked channel doesn't
    // move with the camera, so its layers must not parallax either. Stored at
    // strength 100 % and scaled per item in env.setupMesh.
    cs.depthShiftBase = rigged ? getDepthCameraShift(engine.cameraPose, 100) : null;
    // A grid's "Face screen" has to cancel the rig's rotation too, and only a
    // rigged channel is turned by it.
    cs.rigged = rigged;
  }
  if (!cs || !layout || channel.visible === false || channel.items.length === 0) {
    if (cs) cs.group.visible = false;
    reconcileMedia();
    return;
  }

  cs.group.visible = true;
  cs.prevMesh.visible = false;
  cs.currMesh.visible = false;
  hideTransitionPackageInstances(cs);

  // Reset transforms
  cs.prevMesh.position.set(0, 0, 0);
  cs.prevMesh.scale.set(1, 1, 1);
  cs.prevMesh.rotation.set(0, 0, 0);
  cs.currMesh.position.set(0, 0, 0.01);
  cs.currMesh.scale.set(1, 1, 1);
  cs.currMesh.rotation.set(0, 0, 0);

  resetMaterialUniforms(cs.prevMaterial);
  resetMaterialUniforms(cs.currMaterial);

  const activeIndex = resolveActiveIndex(layout, time);
  if (activeIndex < 0) {
    reconcileMedia();
    // Hide meshes so the renderer's black clear color shows through instead of the last frame.
    cs.prevMesh.visible = false;
    cs.currMesh.visible = false;
    engine.lastActiveIndex.delete(channel.id);
    // A shot whose edge lies on ANOTHER channel has no active clip here to hang
    // the same-channel preload on (split a clip and move the tail to its own
    // channel and every edge is this case). Without preparation this channel's
    // buffer still sits wherever it last stopped — for a re-played shot that is
    // its END frame — and the first frame after the edge shows that stale
    // picture instead of the shot's beginning. Both buffers are free while the
    // channel is idle, so warm the two soonest upcoming video clips (one per
    // buffer-parity slot). Measured cost of a cold re-source is 300-400ms for
    // even a tiny local file, so the lead here is deliberately wider than the
    // same-channel window. With loop enabled the horizon wraps: the channel's
    // first clip is "upcoming" again near the end of the timeline, which is
    // what stages the loop edge (the blind reset it replaces lived in the
    // playback loop and destroyed exactly this preparation).
    if (env.isPlaying && !engine.exportActive) {
      const wrapPeriod = (!ctx && engine.loop) ? env.getTotalDuration() : 0;
      const horizon = [];
      for (let i = 0; i < layout.length; i += 1) {
        let lead = layout[i].startTime - time;
        if (lead <= 0 && wrapPeriod > 0) lead += wrapPeriod;
        if (lead > 0 && lead <= IDLE_CHANNEL_PRELOAD_LEAD) horizon.push({ index: i, lead });
      }
      horizon.sort((a, b) => a.lead - b.lead);
      const preparedParity = new Set();
      for (const { index } of horizon) {
        if (preparedParity.size >= 2) break;
        const parity = index % 2;
        if (preparedParity.has(parity)) continue;
        const upcomingItem = channel.items[index];
        const upcomingClip = upcomingItem ? getClip(upcomingItem.clipId) : null;
        if (upcomingClip?.mediaType !== 'video') continue;
        const upcomingVideo = parity === 0 ? cs.videos.a : cs.videos.b;
        const upcomingSpeed = getSpeedAtTime(upcomingItem.speedPoints, 0);
        if (Math.abs(upcomingVideo.playbackRate - upcomingSpeed) > 0.05) upcomingVideo.playbackRate = upcomingSpeed;
        const upcomingTarget = calculateVideoTime(upcomingItem, 0);
        if (upcomingClip.htmlSource) {
          htmlLivePrepare(upcomingClip, upcomingTarget, {
            fps: env.projectFps, videoSize: engine.videoSize,
            instance: ctx?.scopeKey ? `${ctx.scopeKey}:${upcomingItem.id}` : upcomingItem.id,
          });
        }
        env.syncVideo(upcomingVideo, upcomingClip, upcomingTarget, { allowPlayback: false, idleStaging: true });
        primePreparedVideoTextureInEngine(engine, upcomingVideo, upcomingClip, upcomingTarget, env.projectFps);
        preparedParity.add(parity);
      }
    }
    return;
  }

  const prevActiveIndex = engine.lastActiveIndex.get(channel.id);
  // `undefined -> N` counts as a change too: a channel coming back from idle is
  // a cross-channel edge, and its element needs the same tight resync window a
  // same-channel handoff gets — otherwise the wide audible drift tolerance lets
  // it play on from its stale position (the previous run's END frame) for up to
  // half a second before anything pulls it to the shot's start.
  const clipChanged = prevActiveIndex !== activeIndex;
  engine.lastActiveIndex.set(channel.id, activeIndex);

  if (clipChanged) {
    // Don't null textures — keep the last frame visible during handoff to prevent flash.
    // The new clip's texture will replace it naturally when its frame is decoded.
    const handoffVideo = activeIndex % 2 === 0 ? cs.videos.a : cs.videos.b;
    engine.tightSyncUntil.set(handoffVideo, performance.now() + CLIP_HANDOFF_SYNC_MS);
  }

  const storedItem = channel.items[activeIndex];
  const itemLayout = layout[activeIndex];
  const storedClip = getClip(storedItem.clipId);
  if (!storedClip) {
    reconcileMedia();
    return;
  }
  // Null layers paint nothing — except in the PREVIEW while one is the selected
  // layer, where it draws as a plain circle through the shape path below
  // (nullLayer.js). Export and headless renders never reach that branch.
  const nullShown = isNullClip(storedClip)
    && storedItem.id === engine.selectedItemId
    && !engine.exporting && !engine.exportActive;
  if (isNullClip(storedClip) && !nullShown) {
    engine.shortAudio?.stop(`${channel.id}_audio`);
    reconcileMedia();
    cs.prevMesh.visible = false;
    cs.currMesh.visible = false;
    cs.group.visible = false;
    return;
  }
  const item = nullShown ? nullPreviewItem(storedItem) : storedItem;
  const clip = nullShown ? nullPreviewClip(storedClip) : storedClip;

  // A channel owns one standalone audio element. As soon as another media type
  // wins this channel at the playhead, stop it; audio/voice elements belonging
  // to other channels are separate map entries and keep mixing normally.
  if (clip.mediaType !== 'audio') {
    engine.shortAudio?.stop(`${channel.id}_audio`);
    reconcileChannelPreviewMedia({ audio: channelAudio() });
  }

  // Camera clips draw nothing at all — they only pose every OTHER channel's rig
  // (resolved once per frame in renderFrame, applied at the top of this function).
  if (isCameraClip(clip)) {
    reconcileMedia();
    cs.prevMesh.visible = false;
    cs.currMesh.visible = false;
    cs.group.visible = false;
    return;
  }

  // Adjustment layers draw no media of their own — they re-grade the layers
  // stacked below them in a dedicated render pass (see renderAdjustmentComposite).
  if (clip.mediaType === 'adjustment') {
    cs.prevMesh.visible = false;
    cs.currMesh.visible = false;
    cs.group.visible = false;
    // Adjustment/spacer clips have no sound of their own. Explicitly stop all
    // channel media here so the preceding video's embedded audio cannot bleed
    // through an AI Fill gap (or any other adjustment-only section).
    reconcileMedia();
    return;
  }

  // Audio clips: manage audio playback, skip visual rendering
  if (clip.mediaType === 'audio') {
    // a warm-up's hidden frame (./warmUp.js) draws nothing here and leaves the sound where it is
    if (engine.warmUp?.hidden) { cs.group.visible = false; return; }
    const audioKey = `${channel.id}_audio`;
    const audioEl = ensurePreviewAudio(engine.audioElements, audioKey, clip.url || '');
    reconcileChannelPreviewMedia({
      audio: audioEl,
      videos: [cs.videos.a, cs.videos.b],
      allowAudio: true,
    });
    // Volume 0–100% (default 100); old audio clips stored volume in `opacity`,
    // so fall back to it.
    const audioVol = item.volume ?? item.opacity ?? 100;
    const timeInClipLocal = time - itemLayout.startTime;
    const audioFadeGain = audioFadeGainAt(item, timeInClipLocal, itemLayout.duration);
    applyMute(audioEl, engine.forceMuteAudio
      || !engine.soundEnabled
      || !!item.muted
      || audioVol <= 0);
    audioEl.volume = Math.max(0, Math.min(1, (audioVol / 100) * audioFadeGain));
    const targetAudioTime = item.trimStart + timeInClipLocal;
    const buffered = !engine.exportActive && engine.shortAudio?.sync(audioKey, {
      url: clip.url, offset: targetAudioTime, end: item.trimEnd,
      volume: audioEl.muted ? 0 : audioEl.volume, active: env.isPlaying && !engine.jumpHold.active,
    });
    if (buffered) {
      if (!audioEl.paused) audioEl.pause();
    } else if (env.isPlaying && !engine.jumpHold.active) {
      // Start from the requested content; while playing intervene as
      // rarely as the engine can afford — on WebKit every seek or rate change
      // silences the element for ~0.4 s, and the old `> 0.3 → seek` rule was one
      // seek every 0.6 s (audioDriftSync.js).
      if (audioEl.paused) startPlayingAudio(audioEl, targetAudioTime, undefined, item.trimEnd).catch((e) => console.warn('Audio play failed:', e.message));
      else syncPlayingAudio(audioEl, targetAudioTime, undefined, () => { perfRegistry.events.seek += 1; }, item.trimEnd);
      perfRegistry.audioDrift = audioEl.currentTime - targetAudioTime;
    } else {
      if (!audioEl.paused) audioEl.pause();
      parkAudio(audioEl, targetAudioTime);
    }
    cs.group.visible = false;
    return;
  }

  const useVideoA = activeIndex % 2 === 0;
  const activeVideo = useVideoA ? cs.videos.a : cs.videos.b;
  const previousVideo = useVideoA ? cs.videos.b : cs.videos.a;
  const timeInClip = time - itemLayout.startTime;
  const itemProgress = Math.max(0, Math.min(1, timeInClip / itemLayout.duration));
  const inOverlap = activeIndex > 0 && itemLayout.overlapIn > 0 && timeInClip <= itemLayout.overlapIn;
  const prevItem = inOverlap ? channel.items[activeIndex - 1] : null;
  const prevLayout = inOverlap ? layout[activeIndex - 1] : null;
  const prevClip = prevItem ? getClip(prevItem.clipId) : null;
  const allowedVideos = [];
  if (clip.mediaType === 'video') allowedVideos.push(activeVideo);
  if (inOverlap && prevClip?.mediaType === 'video') allowedVideos.push(previousVideo);
  reconcileMedia({ allowedVideos });
  // Layer parenting: the parent's PRS is sampled at the SAME absolute time as this
  // frame, never at the child's progress — that's what keeps a parent and child
  // with different starts, durations and trims in step.
  const levelParentIndex = ctx ? ctx.parentIndex : env.parentIndex;
  // A layer reference resolves on this level only (preparePreTransitionOverlayEffects).
  const refClipOf = (id) => cMap.get(levelParentIndex?.get?.(id)?.item?.clipId);
  // Inside a GRID this channel is a cell: the layout engine supplies the whole
  // transform (position, rotation, scale + the cell box to fit into) and the
  // member's own PRS is ignored rather than composed. Everything downstream is
  // already parent-aware, so nothing else in the render path has to change.
  const poseFor = (it) => (ctx?.cellPose
    ? ctx.cellPose(channel, it)
    : resolveParentingInEngine(engine, levelParentIndex, it, time));
  const itemParentXform = poseFor(item);
  // Resolved once for this item at this frame and handed to every pose below —
  // including the adaptive-density probes, which must measure the transform the
  // layer will REALLY render with or a tracked layer rasterises at the wrong size.
  const itemFollow = resolveFollowInEngine(engine, levelParentIndex, item, time);

  // Sequence content pre-renders to an offscreen target; the clip then composites
  // like any other texture (keyframes/filters/transitions/blend all apply).
  const rateScale = ctx?.rateScale || 1;
  // A model layer's pixels come from its own depth-buffered 3D pass. Same contract as
  // resolveSequenceTexture: hand back a texture for env.setupMesh's overrideTexture, or
  // null when there is nothing to draw yet.
  const resolveModelTexture = (mItem, mClip, mTimeInClip) => {
    if (mClip?.mediaType !== 'model3d') return null;
    const mod = engine.model3d;
    if (!mod) {
      // The frame that triggered this import drew nothing for the layer; redraw once it lands.
      requestModel3dModule(engine, () => { if (!engine.exporting && !engine.isPlaying) engine.renderFrame(); });
      return null;
    }
    const renderer = engine.renderer;
    if (!renderer) return null;
    const { w: mW, h: mH } = engine.videoSize;
    // The model is filmed by the same camera as everything else. A camera-locked
    // channel (and any sequence's inner render, whose output already travels through
    // the sequence clip's own plane) gets the neutral pose.
    const locked = ctx || channel.cameraLocked || engine.worldActive;
    const kfNow = itemHasKeyframes(mItem) ? getItemKeyframeValues(mItem, itemProgress) : null;
    const prs = localPrs(mItem, kfNow, mW, mH);
    // Render at the drawing-buffer size, like every other target in the comp, so the
    // model is not resampled twice on its way to the canvas.
    const buf = renderer.getDrawingBufferSize(_modelSize);
    // Grow Fill on models runs INSIDE the 3D pass (surface-geodesic bake +
    // injected materials), not in the 2D compositor chain. Same progress
    // contract as renderLayerAutoFill: Start Fill + integrated Grow Speed.
    let growFill = null;
    if (isAutoFillEnabled(mItem)) {
      const afParams = resolveAutoFillParams(mItem, kfNow);
      const clipNow = Math.max(0, mTimeInClip);
      const grown = integratePathRate(mItem, 'afSpeed', afParams.afSpeed, clipNow, itemLayout.duration);
      growFill = {
        params: afParams,
        progress01: Math.min(1, Math.max(0, (afParams.afProgress + grown) / 100)),
      };
    }
    // Real-3D effects, resolved for this frame and run INSIDE the model's pass
    // (model3dFx.js). Empty → the pass never loads that module.
    const fx3d = resolveModelFx3d(mItem, kfNow, Math.max(0, mTimeInClip), itemLayout.duration);
    const res = mod.renderModelLayer(renderer, {
      item: mItem,
      clip: mClip,
      pose: locked ? null : engine.cameraPose,
      prs,
      W: mW,
      H: mH,
      width: buf.x || mW,
      height: buf.y || mH,
      time: Math.max(0, mTimeInClip),
      growFill,
      fx3d,
      // The project's 3D Rig, if there is one. Outside every rig clip this falls
      // back to the NEAREST one rather than to nothing: a rig's neutral state is
      // "no lights", so a gap would turn every model black purely because of where
      // the playhead sits. With no rig layer at all it stays null and the layer's
      // own model3dConfig lights it, exactly as before.
      rig: engine.activeRigAt(engine.currentTime),
      frameToken: engine.frameToken,
      // Share the compositor's depth encoding so the model's depth buffer can be
      // tested against directly.
      near: engine.camera?.near,
      far: engine.camera?.far,
    });
    if (res?.viewDistance != null) engine.modelDepth.set(channel.id, res.viewDistance);
    else engine.modelDepth.delete(channel.id);
    if (res?.depthTexture) engine.modelDepthTex.set(channel.id, res.depthTexture);
    else engine.modelDepthTex.delete(channel.id);
    if (res?.spillDepth >= 0) engine.modelSpillDepth.set(channel.id, res.spillDepth);
    else engine.modelSpillDepth.delete(channel.id);
    return res?.texture || null;
  };

  // A particle layer's pixels come from its own instanced pass, sampled out of a
  // deterministic bake cache. Same contract as resolveModelTexture: hand back a
  // texture for env.setupMesh's overrideTexture, or null when there is nothing to
  // draw (no live particles at this time — a legitimate, common state).
  const resolveParticleTexture = (pItem, pClip, pTimeInClip) => {
    if (pClip?.mediaType !== PARTICLE_MEDIA_TYPE || !pItem?.particleSystem) return null;
    const mod = engine.particle;
    if (!mod) {
      // The frame that triggered this import drew nothing for the layer; repaint
      // once it lands. An EXPORT cannot rely on that — it gets one pass per frame
      // — which is why exportVideo and captureFrameAtTime await the module before
      // their first frame.
      engine.ensureParticleModule?.().then(() => {
        if (!engine.exporting && !engine.isPlaying) engine.renderFrame();
      }).catch(() => {});
      return null;
    }
    const renderer = engine.renderer;
    if (!renderer) return null;
    const { w: pW, h: pH } = engine.videoSize;
    const locked = ctx || channel.cameraLocked || engine.worldActive;
    const kfNow = itemHasKeyframes(pItem) ? getItemKeyframeValues(pItem, itemProgress) : null;
    const prs = localPrs(pItem, kfNow, pW, pH);
    const buf = renderer.getDrawingBufferSize(_modelSize);
    // Keyed by the SCOPED runtime key, not the bare item id: the same item id can
    // appear at two levels once a solver is grouped into a sequence.
    const key = ctx?.scopeKey ? `${ctx.scopeKey}:${pItem.id}` : pItem.id;
    // Baking is synchronous and hashed on the simulation inputs only, so this is a
    // map lookup on every frame except the one after a solver edit.
    // A 'layer' emitter fires from a picture's opaque pixels. The table of those
    // sites is built once and shared: the bake takes positions from it, the draw
    // takes colours from the same index, so the two can never disagree.
    // A live video object is driven from here on the way to drawing: while the
    // timeline plays the element runs and is only nudged when it drifts, which
    // a per-frame seek would turn into a stutter.
    //
    // Scrubbing and paused preview seek instead, and repaint when the frame
    // lands — this draw already has whatever was decoded, and the element is
    // one frame behind until the seek resolves. Export does not come through
    // here at all: it awaits seekParticleObjectVideos before its single pass.
    // A layer emitter reading its colours off a VIDEO needs that element at
    // this frame, exactly like an object member does — otherwise every
    // particle wears the colour of whatever frame decoded first.
    const emSrc = pItem.particleSystem.emitters?.[0]?.source;
    if (emSrc?.kind === 'video' && pItem.particleSystem.render?.colorMode === 'source' && !engine.exporting) {
      const at = Math.max(0, pTimeInClip);
      if (engine.isPlaying) mod.prepareObjectVideos?.([emSrc], at, true);
      else {
        Promise.resolve(mod.prepareObjectVideos?.([emSrc], at, false))
          .then((seeked) => { if (seeked && !engine.exporting && !engine.isPlaying) engine.renderFrame?.(); })
          .catch(() => {});
      }
    }
    const objs = pItem.particleSystem.objects;
    if (objs?.playVideo && !engine.exporting) {
      const live = (objs.members || []).filter((m) => m.included !== false && m.source?.kind === 'video');
      if (live.length) {
        const sources = live.map((m) => m.source);
        const at = Math.max(0, pTimeInClip);
        if (engine.isPlaying) {
          mod.prepareObjectVideos?.(sources, at, true);
        } else {
          Promise.resolve(mod.prepareObjectVideos?.(sources, at, false))
            .then((seeked) => {
              if (seeked && !engine.exporting && !engine.isPlaying) engine.renderFrame?.();
            })
            .catch(() => {});
        }
      }
    }
    const spawn = mod.spawnTableFor?.(pItem.particleSystem) || null;
    // The collider (v3) is the same kind of input as the spawn table: an SDF
    // baked from a layer's artwork, identified by its own key.
    /*
     * A FOLLOWED collider takes the layer's ARTWORK live too, not only its
     * pose. `collision.source` is a snapshot from the moment it was picked, so
     * with follow on and the artwork stale the collider went on shaping the
     * particles with the letter the layer used to be. Following a layer means
     * following what it IS as well as where it is; the stored snapshot stays
     * as the fallback for when that layer is gone.
     */
    /*
     * A FOLLOWED collider takes the layer's ARTWORK live too, not only its
     * pose. `collision.source` is a snapshot from the moment it was picked, so
     * with follow on and the artwork stale the collider went on shaping the
     * particles with the letter the layer used to be. Following a layer means
     * following what it IS as well as where it is; the stored snapshot stays
     * as the fallback for when that layer is gone.
     *
     * One entry per collider, positional — a collider that does not follow
     * contributes null and keeps its row.
     */
    const collLiveSources = collidersOf(pItem.particleSystem).map((c) => {
      if (!c.follow || !c.fromItemId) return null;
      const ent = levelParentIndex?.get?.(c.fromItemId);
      const srcItem = ent?.item;
      if (!srcItem) return null;
      const srcClip = cMap.get(srcItem.clipId);
      if (!srcClip) return null;
      try { return particleSourceFromLayer(srcItem, srcClip, pW, pH); } catch { return null; }
    });
    const colliderTables = mod.colliderTablesFor?.(pItem.particleSystem, collLiveSources) || [];
    // The first one keeps the singular name: the fluid mask and the live engine
    // both take one collider and it is the one they take.
    const collider = colliderTables[0] || null;
    // A FOLLOWED collider needs where its source layer is at every simulation
    // step, for the same reason Layer Velocity does: the solver has no
    // timeline. Null for an ordinary collider, so nothing changes for one.
    // When may this emitter emit? Null unless it asked to follow its source
    // layer's span — see emitterGateFor.
    const emitterGate = emitterGateFor({
      system: pItem.particleSystem, item: pItem, index: levelParentIndex, layout: itemLayout,
    });
    const colliderTracks = colliderTracksFor({
      system: pItem.particleSystem,
      item: pItem,
      index: levelParentIndex,
      layout: itemLayout,
      W: pW,
      H: pH,
    });
    const colliderTrack = colliderTracks[0] || null;
    // LAYER VELOCITY (v3): the animation of the layers this system's Layer
    // Velocity sources point at, sampled per simulation step. Same contract as
    // the collider — resolved here because the solver has no timeline, and
    // memoised on the source layers' own transform signature, so it costs a
    // string compare on a frame where nothing moved.
    const layerDrive = layerDriveTableFor({
      system: pItem.particleSystem,
      item: pItem,
      index: levelParentIndex,
      layout: itemLayout,
      W: pW,
      H: pH,
    });
    /*
     * PROXIMITY EFFECTORS (v4). Two hand-offs from one resolver, for the same
     * reason the collider and Layer Velocity have theirs: this is where the
     * timeline lives, and neither the renderer nor the solver can see it.
     *
     *   proxPoses  where each source layer is AT THIS FRAME — all a look
     *              target needs, because look is read at draw time.
     *   proxTrack  the same, per simulation step, for the motion targets the
     *              solver integrates. Null when nothing drives motion, so a
     *              look-only effector never enters the bake key and never
     *              costs a re-simulation.
     *
     * Neither one can invalidate the distance FIELD: that is baked from the
     * artwork alone (particleProxField.js), so a source layer may be animated,
     * parented or speed-ramped and it is still baked exactly once.
     */
    const proxPoses = proxPosesAt({
      system: pItem.particleSystem,
      item: pItem,
      index: levelParentIndex,
      layout: itemLayout,
      W: pW,
      H: pH,
      time: (itemLayout?.startTime || 0) + Math.max(0, pTimeInClip),
    });
    // The solver's half: poses per step plus the field each one samples, keyed
    // together so a field that arrives late re-bakes. The fields come off the
    // SAME cache the renderer reads, so a source is baked once for both.
    /*
     * The block AS OF THIS FRAME. Its numbers are keyframable (`px:<param>`),
     * and the LOOK half of the effector is read at draw time, so the renderer
     * has to be handed the resolved block rather than the stored one. Same
     * object back when nothing is animated.
     */
    const proxCfg = proxCfgAt(pItem.particleSystem?.proximity, kfNow);
    // Which proximity parameters carry a track. The solver gate needs it: an
    // Attract stored at 0 and keyed up on the beat DOES reach the simulation,
    // and reading the stored numbers alone would skip the hand-off entirely.
    const proxAnimated = proxAnimatedParams(pItem);
    /*
     * ...or when PACKING reads the effector's Size as a contact radius. A
     * look-only effector drives no motion, so this hand-off skipped it
     * entirely and the solver had nothing to read — the hash re-baked on a
     * Size change and the bake came out identical.
     */
    const proximity = (proximityDrivesMotion(pItem.particleSystem?.proximity, proxAnimated)
      || proximityFeedsPacking(pItem.particleSystem, proxAnimated))
      ? proxSolverInputFor({
        system: pItem.particleSystem,
        item: pItem,
        index: levelParentIndex,
        layout: itemLayout,
        W: pW,
        H: pH,
      })
      : null;
    // During an export the frame must be the exact simulation for this config —
    // there is no second pass to correct it — so the bake happens here rather
    // than off-thread.
    // LIVE first: the WebGPU engine steps the system in real time while the
    // editor previews, and the bake is only asked for when live is off, not
    // possible, or fell back because it could not hold 60 fps. An export never
    // draws the live pool — it is the bake or nothing.
    const liveEngine = engine.exporting ? null : mod.ensureParticleLive?.(key, pItem.particleSystem, itemLayout.duration, spawn, {
      collider,
      layerDrive,
      proximity,
      time: Math.max(0, pTimeInClip),
      playing: engine.isPlaying,
    });
    // TIER 2: a system too big to bake runs on the GPU runtime, which draws
    // itself and hands back a canvas. Null until it is ready (and on every
    // failure), so the layer keeps drawing from the bake meanwhile — and,
    // unlike the live engine above, this one DOES run during an export,
    // because for a system this size there is no bake to fall back to.
    //
    // ASKED FOR BEFORE THE BAKE, because its answer decides whether there is
    // going to be one.
    const gpuRuntime = mod.ensureParticleGpu?.(key, pItem.particleSystem, itemLayout.duration, {
      width: buf.x || pW,
      height: buf.y || pH,
      time: Math.max(0, pTimeInClip),
      spawnTable: spawn,
      tableKey: key,
    }) || null;
    /*
     * A TIER 2 LAYER DOES NOT BAKE.
     *
     * The bake was asked for unconditionally, so a system on the GPU runtime
     * ran BOTH engines: the pool on the GPU, and a hundred thousand particles
     * (the bake's own ceiling) on a worker, with a snapshot cache of hundreds
     * of megabytes behind it. That is the whole of "I set Max particles to a
     * million, only a thousand are alive, and the editor crawls" — the crawl
     * was never the million, it was the bake underneath it. It also made the
     * panel's "not baked" line untrue.
     *
     * The bake comes back the moment Tier 2 stops owning the layer: a refused
     * reservation, a device loss, a count edited back down, an unsupported
     * feature switched on. particleGpuOwns is false in every one of those.
     */
    const gpuOwns = !!gpuRuntime || (mod.particleGpuOwns?.(key, pItem.particleSystem) ?? false);
    // The bake is what scrubbing reads once it is complete (one read per
    // frame, any time), what an export draws, and what a layer falls back to.
    // Off-thread, cancellable, progressive.
    /*
     * AND THROW AWAY THE BAKE THE LAYER USED TO HAVE.
     *
     * Not asking for a new one is only half of it. A layer that was under the
     * threshold a moment ago HAS a snapshot cache, and raising Max particles
     * moves it to the GPU engine without that cache going anywhere: tens of
     * megabytes of simulation for a system nothing reads any more, held until
     * the layer is deleted. It also keeps the panel reporting a bake — "Baked
     * in 1856 ms, 41.8 MB, 182 snapshots" sitting under a system that is not
     * baked at all, which reads as the engine doing both.
     *
     * Released once: after this, peek answers null and the branch is skipped.
     */
    if (gpuOwns && mod.peekParticleCache?.(key)) mod.releaseParticleCache?.(key);
    const bakeCache = gpuOwns ? null : mod.ensureParticleCache(key, pItem.particleSystem, itemLayout.duration, spawn, {
      sync: engine.exporting,
      collider,
      colliderTables,
      colliderTrack,
      colliderTracks,
      emitterGate,
      layerDrive,
      proximity,
      // Packing ▸ Shape: Object — one clump per member, from its artwork.
      // Null for every other system.
      objectShapes: mod.objectShapesFor?.(pItem.particleSystem) || null,
    });
    const cache = liveEngine || bakeCache;
    const res = mod.renderParticleLayer(renderer, {
      key,
      gpu: gpuRuntime,
      system: pItem.particleSystem,
      cache,
      pose: locked ? null : engine.cameraPose,
      prs,
      W: pW,
      H: pH,
      width: buf.x || pW,
      height: buf.y || pH,
      time: Math.max(0, pTimeInClip),
      near: engine.camera?.near,
      far: engine.camera?.far,
      proxPoses,
      proxCfg,
    });
    // A solver reports its box depth for channel ordering and DOF, but never a
    // depth texture: translucent particles must not cut the layers behind them.
    if (res?.viewDistance != null) engine.modelDepth.set(channel.id, res.viewDistance);
    else engine.modelDepth.delete(channel.id);
    return res?.texture || null;
  };

  // The Rig clip's pixels: the cyclorama, drawn ONCE as its own layer.
  //
  // It deliberately does NOT ride inside each model's pass. That version drew
  // nothing when a project had a rig but no model, and drew the backdrop twice
  // when it had two — a rig is a project singleton, so its set is one layer.
  // Occlusion still works because this pass hands back a depth texture, which is
  // the same mechanism that lets a model cut the layers behind it.
  const resolveRigTexture = (rItem, rClip) => {
    if (rClip?.mediaType !== RIG_MEDIA_TYPE) return null;
    const mod = engine.model3d;
    if (!mod) {
      requestModel3dModule(engine, () => { if (!engine.exporting && !engine.isPlaying) engine.renderFrame(); });
      return null;
    }
    const renderer = engine.renderer;
    if (!renderer || !mod.renderRigLayer) return null;
    const { w: rW, h: rH } = engine.videoSize;
    const locked = ctx || channel.cameraLocked || engine.worldActive;
    const buf = renderer.getDrawingBufferSize(_modelSize);
    // Resolved through activeRigAt like every other consumer, so a keyframed
    // cyclorama colour or environment rotation animates here too. Inside a rig
    // clip that resolves to this very clip, so there is no gap to fall back across.
    const res = mod.renderRigLayer(renderer, {
      rig: engine.activeRigAt(engine.currentTime) || rItem?.rig || null,
      frameToken: engine.frameToken,
      pose: locked ? null : engine.cameraPose,
      W: rW,
      H: rH,
      width: buf.x || rW,
      height: buf.y || rH,
      near: engine.camera?.near,
      far: engine.camera?.far,
    });
    if (res?.viewDistance != null) engine.modelDepth.set(channel.id, res.viewDistance);
    else engine.modelDepth.delete(channel.id);
    if (res?.depthTexture) engine.modelDepthTex.set(channel.id, res.depthTexture);
    else engine.modelDepthTex.delete(channel.id);
    engine.modelSpillDepth.delete(channel.id);
    return res?.texture || null;
  };

  // A flat layer's part in the 3D scene, in the two degrees it comes in.
  //
  // env.setupMesh has already resolved and rasterised the ordinary layer and
  // configured its clip shader. From here:
  //
  //   * CAST (and receive) — the layer needs a real plane in the shared world so
  //     the rig's one shadow map contains its live silhouette. syncPlateLayer
  //     bakes this frame's artwork onto that plane and poses it at the layer's
  //     WORLD transform. The compositor quad is left completely alone.
  //   * RECEIVE — its own pixels have to be darkened by that shadow map, which
  //     only a pass inside the lit scene can do. Only then is the layer filmed
  //     through the project camera and its quad replaced by the resulting
  //     full-frame plate.
  //
  // Depth occlusion asks for NEITHER. A layer quad already stands in the
  // composition's 3D space — same world units, same project camera, same
  // depth-buffered target — so making it intersect a model (or another layer) is
  // a matter of letting it test and write depth, which the composite loop does
  // for every 3D frame. Filming it would only cost it its position, its blend
  // mode and its effects; that mistake is what this split undoes.
  const promotePlateMesh = (pItem, pClip, mesh, material) => {
    if (!isScenePlate(pItem, pClip) || !mesh?.visible) return false;
    const mod = engine.model3d;
    if (!mod) {
      requestModel3dModule(engine, () => { if (!engine.exporting && !engine.isPlaying) engine.renderFrame(); });
      return false;
    }
    const renderer = engine.renderer;
    if (!renderer || !mod.syncPlateLayer) return false;
    const { w: pW, h: pH } = engine.videoSize;
    const expand = Math.max(0, Number(material.uniforms?.uPlaneExpand?.value) || 0);
    const expandX = (pW + 2 * expand) / pW;
    const expandY = (pH + 2 * expand) / pH;
    const buf = renderer.getDrawingBufferSize(_modelSize);
    // The mesh's WORLD matrix, not its local one: the channel's stacking z and any
    // layer parenting live above it, and dropping them put every plate on one
    // plane at the origin of the set. A container's inner scene is a world of its
    // own, so there the local transform is the whole story.
    let px = mesh.position.x, py = mesh.position.y, pz = mesh.position.z;
    let qx = mesh.quaternion.x, qy = mesh.quaternion.y, qz = mesh.quaternion.z, qw = mesh.quaternion.w;
    let sx = mesh.scale.x, sy = mesh.scale.y;
    if (!ctx) {
      mesh.updateWorldMatrix(true, false);
      mesh.matrixWorld.decompose(_platePos, _plateQuat, _plateScale);
      px = _platePos.x; py = _platePos.y; pz = _platePos.z;
      qx = _plateQuat.x; qy = _plateQuat.y; qz = _plateQuat.z; qw = _plateQuat.w;
      sx = _plateScale.x; sy = _plateScale.y;
      // decompose() folds a mirror's negative scale into the quaternion, which
      // would flip the plate in the set. The plane is double-sided, so the sign
      // is put back where it came from.
      if (mesh.scale.x < 0) sx = -Math.abs(sx);
      if (mesh.scale.y < 0) sy = -Math.abs(sy);
    }
    const opts = {
      item: pItem,
      clip: pClip,
      sourceMaterial: material,
      plateWidth: pW + 2 * expand,
      plateHeight: pH + 2 * expand,
      transform: {
        position: { x: px, y: py, z: pz },
        quaternion: { x: qx, y: qy, z: qz, w: qw },
        // The expand margin rides in the quad's scale and in the plate's geometry
        // alike, so it must be divided out of one of them exactly once.
        scale: { x: sx / expandX, y: sy / expandY, z: 1 },
      },
      pose: (ctx || channel.cameraLocked || engine.worldActive) ? null : engine.cameraPose,
      rig: engine.activeRigAt(engine.currentTime),
      frameToken: engine.frameToken,
      W: pW,
      H: pH,
      width: buf.x || pW,
      height: buf.y || pH,
      near: engine.camera?.near,
      far: engine.camera?.far,
    };

    // Casting only: the plate exists in the world, the layer stays itself.
    if (!isCameraBaked3dPlate(pClip, pItem)) {
      mod.syncPlateLayer(renderer, opts);
      engine.modelDepth.delete(channel.id);
      engine.modelDepthTex.delete(channel.id);
      engine.modelSpillDepth.delete(channel.id);
      return false;
    }

    const res = mod.renderPlateLayer?.(renderer, opts);
    if (!res?.texture) return false;
    if (res.viewDistance != null) engine.modelDepth.set(channel.id, res.viewDistance);
    else engine.modelDepth.delete(channel.id);
    if (res.depthTexture) engine.modelDepthTex.set(channel.id, res.depthTexture);
    else engine.modelDepthTex.delete(channel.id);
    engine.modelSpillDepth.delete(channel.id);

    resetMaterialUniforms(material);
    material.uniforms.uTexture.value = res.texture;
    material.uniforms.uResolution.value.set(buf.x || pW, buf.y || pH);
    material.uniforms.uCanvasSize.value.set(pW, pH);
    // The plate arrives premultiplied by its coverage; without this the material
    // multiplies by alpha a second time and every antialiased edge picks up a dark
    // outline. resetMaterialUniforms cleared the flag a moment ago, so it is set
    // here rather than with the model/rig ones in env.setupMesh.
    material.uniforms.uInputPremultiplied.value = 1;
    material.userData.textureSource = `__shadowplate__:${pItem.id}`;
    applyBlendMode(material, pClip.mediaType === 'text' ? 'normal' : pItem?.blendMode);
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);
    mesh.userData.cameraBaked3d = true;
    return true;
  };

  // Both container kinds pre-render their nested timeline the same way; the grid
  // only differs in the per-cell pose renderSequenceFrame hands its inner channels.
  const resolveSequenceTexture = (seqItem, seqClip, seqTimeInClip, seqProgress, seqParentXform = null) => {
    if (!isContainerClip(seqClip)) return null;
    const localTime = calculateVideoTime(seqItem, Math.max(0, seqTimeInClip));
    const innerRate = rateScale * getSpeedAtTime(seqItem.speedPoints, seqProgress);
    // The grid's own editing level is passed through so a Proximity effector can
    // resolve its referenced layers at whatever depth the grid itself sits at.
    return engine.renderSequenceFrame?.(
      seqClip, seqItem, localTime, (ctx?.depth || 0) + 1, innerRate, time, levelParentIndex,
      seqParentXform, cs?.rigged ? engine.cameraPose : null,
      // The camera that films this level: the posed project camera for a rigged
      // top-level channel, the neutral one everywhere else (locked channels,
      // and any container's inner scene, which is itself filmed neutrally).
      // A real-3D grid folds its own transform into this camera.
      (!ctx && cs?.rigged) ? engine.posedCamera : engine.camera,
      // The path of container items this level sits inside. Runtimes keyed by a
      // bare item id (the particle bake cache and its GPU buffers) would otherwise
      // collide when the same item is reachable at two editing levels.
      ctx?.scopeKey ? `${ctx.scopeKey}:${seqItem.id}` : seqItem.id,
    ) || null;
  };

  // A warm-up's hidden frame (./warmUp.js) leaves a live html page on the frame it shows: no step, no rebind.
  const htmlHeld = engine.exportActive || engine.warmUp?.hidden;
  if (clip.mediaType === 'video') {
    const speed = getSpeedAtTime(item.speedPoints, itemProgress) * rateScale;
    if (Math.abs(activeVideo.playbackRate - speed) > 0.05) activeVideo.playbackRate = speed;
    if (activeVideo.preservesPitch) activeVideo.preservesPitch = false;
    if (activeVideo.mozPreservesPitch) activeVideo.mozPreservesPitch = false;
    const videoVol = item.volume ?? 100;
    // `canUnmute` is the touch tier's gesture gate (always true on desktop):
    // unmuting here runs inside rAF, which WebKit answers by PAUSING the element.
    const shouldMute = engine.forceMuteAudio || !engine.soundEnabled || !!item.muted || videoVol <= 0
      || !mediaActivation.canUnmute(activeVideo);
    applyMute(activeVideo, shouldMute);
    const targetVideoVol = Math.max(0, Math.min(1, (videoVol / 100) * audioFadeGainAt(item, timeInClip, itemLayout.duration)));
    applyVolume(activeVideo, targetVideoVol); // WebKit: 0 for the first 300 ms of a start, so the picture starts on the clock (audioDriftSync.js)
    const targetTime = calculateVideoTime(item, timeInClip);
    // The convergence window only matters when another clip actually follows
    // on this channel; a transition (overlap) boundary manages both elements
    // itself, and activeIndex flips to the incoming clip before the window
    // would open anyway.
    const nearCutBoundary = !!channel.items[activeIndex + 1]
      && !inOverlap
      && (itemLayout.endTime - time) <= CLIP_BOUNDARY_CONVERGE_S;
    // A live html clip draws its page into a canvas the texture samples instead of
    // the bake's <video> (htmlLive.js); null keeps the bake.
    const liveHtml = !htmlHeld && clip.htmlSource
      ? htmlLiveCanvas(clip, targetTime, {
        fps: env.projectFps, videoSize: engine.videoSize, playing: engine.isPlaying,
        instance: ctx?.scopeKey ? `${ctx.scopeKey}:${item.id}` : item.id,
        stepSeconds: engine.isPlaying && engine.playbackStep > 0
          ? calculateVideoTime(item, Math.min(itemLayout.duration, timeInClip + engine.playbackStep * rateScale))
          : null,
      })
      : null;
    if (!htmlHeld) bindHtmlLiveCanvas(activeVideo, liveHtml);
    // During fast export the video element is positioned by the decoder (canvas),
    // not seeked — skip the (slow) <video> seek here.
    if (!engine.exportActive && !liveHtml) env.syncVideo(activeVideo, clip, targetTime, {
      // A stabilized layer joins the frame-critical set: its correction is
      // per source frame, so a paused step that leaves the picture on the
      // previous frame shows the wrong warp until the drift crosses the
      // ordinary 40 ms threshold.
      frameAccurate: isLayerMaskEnabled(item) || env.rotoPreview?.itemId === item.id
        || hasVideoStabilization(item),
      nearCutBoundary,
    });
  }

  // ── Overlap / cross-transition ──
  if (inOverlap) {
    const prevTimeInClipRaw = time - prevLayout.startTime;
    const prevTimeInClip = Math.max(0, Math.min(prevLayout.duration, prevTimeInClipRaw));
    const prevProgress = Math.max(0, Math.min(1, prevTimeInClip / prevLayout.duration));

    if (prevClip?.mediaType === 'video') {
      const prevSpeed = getSpeedAtTime(prevItem.speedPoints, prevProgress) * rateScale;
      if (Math.abs(previousVideo.playbackRate - prevSpeed) > 0.05) previousVideo.playbackRate = prevSpeed;
      if (previousVideo.preservesPitch) previousVideo.preservesPitch = false;
      if (previousVideo.mozPreservesPitch) previousVideo.mozPreservesPitch = false;
      const prevVideoVol = prevItem.volume ?? 100;
      const prevShouldMute = engine.forceMuteAudio
        || !engine.soundEnabled
        || !!prevItem.muted
        || prevVideoVol <= 0
        || !mediaActivation.canUnmute(previousVideo);
      applyMute(previousVideo, prevShouldMute);
      const prevTargetVol = Math.max(0, Math.min(1,
        (prevVideoVol / 100) * audioFadeGainAt(prevItem, prevTimeInClip, prevLayout.duration)
      ));
      applyVolume(previousVideo, prevTargetVol);
      const targetTime = calculateVideoTime(prevItem, prevTimeInClip);
      const prevLiveHtml = !htmlHeld && prevClip.htmlSource
        ? htmlLiveCanvas(prevClip, targetTime, {
          fps: env.projectFps, videoSize: engine.videoSize, playing: engine.isPlaying,
          instance: ctx?.scopeKey ? `${ctx.scopeKey}:${prevItem.id}` : prevItem.id,
          stepSeconds: engine.isPlaying && engine.playbackStep > 0
            ? calculateVideoTime(prevItem, Math.min(prevLayout.duration, prevTimeInClip + engine.playbackStep * rateScale))
            : null,
        })
        : null;
      if (!htmlHeld) bindHtmlLiveCanvas(previousVideo, prevLiveHtml);
      if (!engine.exportActive && !prevLiveHtml) env.syncVideo(previousVideo, prevClip, targetTime, {
        frameAccurate: isLayerMaskEnabled(prevItem) || env.rotoPreview?.itemId === prevItem.id
          || hasVideoStabilization(prevItem),
      });
    }

    // Render cache frame: media only. Containers still visit their inner
    // timelines (in media-only mode too) so their sound keeps playing.
    if (engine.rcMediaOnly) {
      resolveSequenceTexture(prevItem, prevClip, prevTimeInClip, prevProgress, poseFor(prevItem));
      resolveSequenceTexture(item, clip, timeInClip, itemProgress, itemParentXform);
      return;
    }
    const overlapProgress = Math.max(0, Math.min(1, timeInClip / itemLayout.overlapIn));
    const easedProgress = applyGsapEasing(overlapProgress, item.transitionEasing);

    const prevSeqTex = resolveSequenceTexture(prevItem, prevClip, prevTimeInClip, prevProgress, poseFor(prevItem));
    const currSeqTex = resolveSequenceTexture(item, clip, timeInClip, itemProgress, itemParentXform);

    // NB: do NOT pass the channel state here — the last-good-frame backstop is for
    // single-clip (no-overlap) rendering only. During a crossfade both meshes share
    // `cs`, so the backstop would let currMesh fall back to the texture prevMesh just
    // recorded (the OUTGOING clip), making the transition blend the same clip into
    // itself — i.e. no visible cross. Keep the overlap path identical to pre-fix.
    env.setupMesh(cs.prevMesh, cs.prevMaterial, prevItem, prevClip, previousVideo, prevProgress, prevLayout.duration, null, prevSeqTex,
      poseFor(prevItem), resolveFollowInEngine(engine, levelParentIndex, prevItem, time));
    promotePlateMesh(prevItem, prevClip, cs.prevMesh, cs.prevMaterial);
    env.setupMesh(cs.currMesh, cs.currMaterial, item, clip, activeVideo, itemProgress, itemLayout.duration, null, currSeqTex, itemParentXform, itemFollow);
    promotePlateMesh(item, clip, cs.currMesh, cs.currMaterial);

    // Correct order: source -> Overlay Effects -> transition. The old compositor
    // rendered both meshes into one channel plate and then applied the incoming
    // item's chain, so a fisheye (and every other spatial effect) distorted the
    // transition result itself. Bake each effected input independently while its
    // plain item transform is still intact; applyCrossTransition / package capture
    // then receive those finished plates as their source layers.
    // A layer MASK enters this path on the same terms as an Overlay chain —
    // the prepare replaces the mesh with a full-frame carrier, so a mask that
    // did not bake here would disappear for the length of the transition.
    const prepareTransitionFx = engine.preTransitionFxPrepare;
    if (prepareTransitionFx) {
      if (hasActiveLayerOverlayEffects(withFlatEffects(prevItem, prevClip)) || isLayerMaskEnabled(prevItem) || bakeableLayerStack(prevItem, prevClip, prevLayout)) {
        prepareTransitionFx({
          key: prevItem.id,
          mesh: cs.prevMesh,
          material: cs.prevMaterial,
          item: prevItem,
          clip: prevClip,
          entry: prevLayout,
          time,
          baseZ: 0,
          refClipOf,
        });
      }
      if (hasActiveLayerOverlayEffects(withFlatEffects(item, clip)) || isLayerMaskEnabled(item) || bakeableLayerStack(item, clip, itemLayout)) {
        prepareTransitionFx({
          key: item.id,
          mesh: cs.currMesh,
          material: cs.currMaterial,
          item,
          clip,
          entry: itemLayout,
          time,
          baseZ: 0.01,
          refClipOf,
        });
      }
    }

    // Built-ins use the editor's transition switch. Uploaded packages instead
    // execute their own renderer instance with raw Three.js/GLSL access.
    const { w: tW, h: tH } = engine.videoSize;
    const crossProgress = item.transition === TransitionType.SIDE_BY_SIDE ? overlapProgress : easedProgress;
    const crossEasing = item.transition === TransitionType.SIDE_BY_SIDE ? (item.transitionEasing ?? TransitionEasing.EASE_IN_OUT) : undefined;
    const packagedPreset = getAdvancedTransitionPreset(item.transition);
    // Any preset that ships createInstance() runs on the package runtime —
    // uploaded .gltransition files AND built-in executable packages (see
    // builtinTransitionPackages.js). Legacy built-ins (Zoom Blur) have no
    // createInstance and keep the editor's transition switch.
    const executablePackage = typeof packagedPreset?.createInstance === 'function';
    if (executablePackage) {
      const packageMedia = syncTransitionPackageMediaInEngine(engine, cs, packagedPreset, overlapProgress, itemLayout.overlapIn, { repaint: () => engine.renderFrame() });
      renderTransitionPackage({
        channelState: cs,
        preset: packagedPreset,
        renderer: engine.renderer,
        // Capture package inputs with the neutral composition camera. The package
        // output root then travels through the channel/project camera exactly once.
        camera: engine.camera,
        width: tW,
        height: tH,
        progress: crossProgress,
        rawProgress: overlapProgress,
        duration: itemLayout.overlapIn,
        options: resolveAdvancedTransitionOptions(item.transition, item.transitionOptions) || { ...packagedPreset.optionDefaults },
        contentBoxes: { previous: layerContentBox(prevItem, prevClip), current: layerContentBox(item, clip) },
        media: packageMedia,
        isPlaying: engine.isPlaying,
        exporting: engine.exportActive,
        requestRender: () => engine.renderFrame(),
      });
    } else {
      deactivateTransitionPackageMediaInEngine(cs);
      applyCrossTransition(
        cs.prevMesh,
        cs.currMesh,
        item.transition,
        crossProgress,
        tW,
        tH,
        item.customTransitionConfig,
        crossEasing,
        item.transitionOptions,
        // The wiggle needs real seconds (its frequency is in Hz) and the
        // UN-eased progress, so its tremble keeps a constant rate instead of
        // speeding up wherever the easing curve is steep.
        { duration: itemLayout.overlapIn, rawProgress: overlapProgress },
      );
    }

    /*
     * The neighbours' own in/out transitions still run underneath the cross —
     * a plain mesh move (slide, wipe, fade) composes with it because it only
     * offsets a transform the cross transition also merely offsets.
     *
     * An ADVANCED in/out cannot: Advanced Zoom and Advanced Movement set the
     * UV scale/offset uniforms absolutely (the cross transition of the same
     * family is already driving them), and a package hides the clip planes to
     * draw its own output. Whichever ran last would simply erase the other, so
     * during an overlap the cross transition owns the frame and the layer
     * slots stand down for the length of it.
     */
    const layerTransitionFitsOverlap = (type) => !isAdvancedLayerTransition(type);

    // Layer out-transition on previous clip
    const prevOutType = prevItem.transitionOutType || LayerTransitionType.NONE;
    if (prevOutType !== LayerTransitionType.NONE && layerTransitionFitsOverlap(prevOutType)) {
      const prevOutDuration = prevItem.transitionOutDuration || 1;
      if (prevTimeInClip > prevLayout.duration - prevOutDuration) {
        const raw = Math.max(0, Math.min(1, (prevLayout.duration - prevTimeInClip) / prevOutDuration));
        const eased = easeLayerSlot(raw, prevItem.transitionOutEasing, 'out');
        applyLayerTransition(cs.prevMesh, prevOutType, eased, tW, tH, prevItem.customTransitionOutConfig, 'out', {
          options: prevItem.transitionOutOptions,
          easingType: prevItem.transitionOutEasing, duration: prevOutDuration, rawProgress: raw,
        });
      }
    }

    // Layer in-transition on current clip
    const currInType = item.transitionInType || LayerTransitionType.NONE;
    if (currInType !== LayerTransitionType.NONE && layerTransitionFitsOverlap(currInType)) {
      const currInDuration = item.transitionInDuration || 1;
      if (timeInClip < currInDuration) {
        const raw = Math.max(0, Math.min(1, timeInClip / currInDuration));
        const eased = applyGsapEasing(raw, item.transitionInEasing);
        applyLayerTransition(cs.currMesh, currInType, eased, tW, tH, item.customTransitionInConfig, 'in', {
          options: item.transitionInOptions,
          easingType: item.transitionInEasing, duration: currInDuration, rawProgress: raw,
        });
      }
    }
    return;
  }

  // ── No overlap: single clip ──
  // A layer in/out transition can still be an executable package, so whether
  // this channel's package media stays awake is decided after that runs.
  let packageActive = false;

  let nextItem = channel.items[activeIndex + 1];
  let nextLayout = layout[activeIndex + 1];
  // Loop wrap staging for a channel that plays right up to the timeline's end:
  // it is never idle before the wrap, so the idle-channel preload can't stage
  // its first clip — treat that first clip as "next" instead. Only possible
  // when it lands on the OTHER buffer (odd last index): with matching parity
  // the active clip still owns the buffer the wrap needs, and the wrap pays a
  // same-buffer re-target at the edge (unavoidable with two buffers).
  if (!nextItem && !ctx && engine.loop && activeIndex % 2 === 1 && layout.length > 0) {
    nextItem = channel.items[0];
    nextLayout = { ...layout[0], startTime: layout[0].startTime + env.getTotalDuration() };
  }
  const nextClip = nextItem ? getClip(nextItem.clipId) : null;
  const timeUntilNextClip = nextLayout ? (nextLayout.startTime - time) : Infinity;
  // Adaptive window: at least NEXT_CLIP_PRELOAD_WINDOW, but for clips shorter than
  // that, preload from the clip's very start so cold/remote sources finish decoding
  // before the cut. Cap it so we never warm more than one clip ahead.
  const preloadLead = Math.max(NEXT_CLIP_PRELOAD_WINDOW, Math.min(itemLayout.duration, 4));
  // The inactive element's VideoTexture is live: changing the element's src also
  // changes that texture. If the incoming shot has not produced a frame yet and
  // this texture is the fallback currently carried by the channel, leave it alone.
  // Otherwise preloading shot N+1 can briefly show N+2 at the N -> N+1 cut.
  const activeCached = engine.videoTextureCache.get(activeVideo);
  const activeSource = normalizeUrl(getClipPlaybackUrl(clip));
  const activeHasFreshFrame = !!(
    activeCached?.hadFrame
    && activeCached.src === activeSource
    && activeVideo.readyState >= 2
    && !activeVideo.seeking
    && !engine.pendingSeek.has(activeVideo)
    && !engine.awaitingFreshFrame.has(activeVideo)
  );
  const inactiveCachedTexture = engine.videoTextureCache.get(previousVideo)?.texture || null;
  const inactiveFallbackTexture = inactiveCachedTexture
    || (cs.lastGoodTexture?.image === previousVideo ? cs.lastGoodTexture : null);
  const inactiveTexturePinned = isInactiveTextureNeededAsFallback({
    activeHasFreshFrame,
    inactiveTexture: inactiveFallbackTexture,
    currentTexture: cs.currMaterial.uniforms.uTexture.value,
    lastGoodTexture: cs.lastGoodTexture,
  });
  const shouldPreloadNextClip = shouldPrepareNextVideo({
    isPlaying: env.isPlaying,
    isExporting: engine.exportActive,
    hasNextItem: !!nextItem,
    hasNextLayout: !!nextLayout,
    nextMediaType: nextClip?.mediaType,
    timeUntilNextClip,
    preloadLead,
    inactiveTexturePinned,
  });

  // An upcoming html clip's live page loads and steps to its first frame now, so
  // the layer is live from the cut (the <video> preload below is its bake).
  if (env.isPlaying && !engine.exportActive && nextClip?.htmlSource && nextItem
    && timeUntilNextClip > 0 && timeUntilNextClip <= preloadLead) {
    htmlLivePrepare(nextClip, calculateVideoTime(nextItem, 0), {
      fps: env.projectFps, videoSize: engine.videoSize,
      instance: ctx?.scopeKey ? `${ctx.scopeKey}:${nextItem.id}` : nextItem.id,
    });
  }

  if (shouldPreloadNextClip) {
    const nextProgress = 0;
    const nextSpeed = getSpeedAtTime(nextItem.speedPoints, nextProgress);
    if (Math.abs(previousVideo.playbackRate - nextSpeed) > 0.05) previousVideo.playbackRate = nextSpeed;
    if (previousVideo.preservesPitch) previousVideo.preservesPitch = false;
    if (previousVideo.mozPreservesPitch) previousVideo.mozPreservesPitch = false;
    const nextTargetTime = calculateVideoTime(nextItem, 0);
    env.syncVideo(previousVideo, nextClip, nextTargetTime, { allowPlayback: false });
    primePreparedVideoTextureInEngine(engine, previousVideo, nextClip, nextTargetTime, env.projectFps);
  }

  if (engine.rcMediaOnly) {
    resolveSequenceTexture(item, clip, timeInClip, itemProgress, itemParentXform);
    return;
  }
  // The depth a model / Rig / re-lit plate hands back is THIS frame's: the
  // resolvers below set it again for their own media. Left over from an earlier
  // item on this channel it points at targets disposed with that item — WebGPU
  // threw binding them as soon as a picture here ran a per-layer stage (Depth
  // Scan, Fresnel Rim, Running Glow), and WebGL depth-tested the picture
  // against a surface that is no longer there.
  engine.modelDepth.delete(channel.id);
  engine.modelDepthTex.delete(channel.id);
  engine.modelSpillDepth.delete(channel.id);
  env.setupMesh(
    cs.currMesh, cs.currMaterial, item, clip, activeVideo, itemProgress, itemLayout.duration, cs,
    resolveSequenceTexture(item, clip, timeInClip, itemProgress, itemParentXform)
      || resolveModelTexture(item, clip, timeInClip)
      || resolveParticleTexture(item, clip, timeInClip)
      || resolveRigTexture(item, clip),
    itemParentXform,
    itemFollow
  );
  promotePlateMesh(item, clip, cs.currMesh, cs.currMaterial);

  // Layer in/out transitions
  const inType = item.transitionInType || LayerTransitionType.NONE;
  const outType = item.transitionOutType || LayerTransitionType.NONE;
  const inDuration = item.transitionInDuration || 1;
  const outDuration = item.transitionOutDuration || 1;

  const effectTransitionStage = activeEffectPrecomposeStage({
    activeIndex,
    overlapIn: itemLayout.overlapIn,
    timeInClip,
    duration: itemLayout.duration,
    transitionInType: inType,
    transitionInDuration: inDuration,
    transitionOutType: outType,
    transitionOutDuration: outDuration,
  });
  if (effectTransitionStage && (hasActiveLayerOverlayEffects(withFlatEffects(item, clip)) || isLayerMaskEnabled(item) || bakeableLayerStack(item, clip, itemLayout))) {
    engine.preTransitionFxPrepare?.({
      key: item.id,
      mesh: cs.currMesh,
      material: cs.currMaterial,
      item,
      clip,
      entry: itemLayout,
      time,
      baseZ: 0.01,
      refClipOf,
    });
  }

  /*
   * One layer's entrance or exit.
   *
   * Three kinds share this path. The plain types are a mesh move, the Advanced
   * Zoom / Movement pair is one lane of the matching cross transition (handled
   * inside applyLayerTransition), and an executable package renders itself
   * with the opposite lane empty.
   *
   * `raw` is the layer-transition convention — "how present the layer is", so
   * it runs 1 → 0 across an exit. A package instead animates FORWARD from its
   * own 0, and eases forward rather than playing the entrance's curve
   * backwards, because the package owns the whole look of that motion.
   *
   * EVERY slot eases forward in TIME (easeLayerSlot). An exit used to ease the
   * descending ramp directly, which runs the chosen curve backwards: "Ease In"
   * came out decelerating and "Ease Out" accelerating, the opposite of both
   * names, and the picker's own OUT previews disagreed with the frames.
   */
  const layerTransitionPackage = (type) => {
    const preset = getAdvancedTransitionPreset(type);
    return typeof preset?.createInstance === 'function' ? preset : null;
  };
  const runLayerTransition = (slot, type, raw, easing, customConfig, rawOptions, duration) => {
    const { w: ltW, h: ltH } = engine.videoSize;
    const eased = easeLayerSlot(raw, easing, slot);
    const preset = layerTransitionPackage(type);
    if (preset) {
      const forwardRaw = slot === 'out' ? 1 - raw : raw;
      packageActive = true;
      renderTransitionPackage({
        channelState: cs,
        preset,
        renderer: engine.renderer,
        camera: engine.camera,
        width: ltW,
        height: ltH,
        slot,
        progress: applyGsapEasing(forwardRaw, easing),
        rawProgress: forwardRaw,
        duration,
        options: resolveAdvancedTransitionOptions(type, rawOptions) || { ...preset.optionDefaults },
        // An entrance is the incoming lane, an exit the outgoing one (captureSources).
        contentBoxes: { [slot === 'out' ? 'previous' : 'current']: layerContentBox(item, clip) },
        media: syncTransitionPackageMediaInEngine(engine, cs, preset, forwardRaw, duration, { repaint: () => engine.renderFrame() }),
        isPlaying: engine.isPlaying,
        exporting: engine.exportActive,
        requestRender: () => engine.renderFrame(),
      });
      return;
    }
    applyLayerTransition(cs.currMesh, type, eased, ltW, ltH, customConfig, slot, {
      options: rawOptions,
      easingType: easing,
      duration,
      rawProgress: raw,
    });
  };

  if (inType !== LayerTransitionType.NONE && timeInClip < inDuration) {
    runLayerTransition(
      'in', inType,
      Math.max(0, Math.min(1, timeInClip / inDuration)),
      item.transitionInEasing, item.customTransitionInConfig, item.transitionInOptions, inDuration,
    );
  } else if (outType !== LayerTransitionType.NONE && timeInClip > itemLayout.duration - outDuration) {
    runLayerTransition(
      'out', outType,
      Math.max(0, Math.min(1, (itemLayout.duration - timeInClip) / outDuration)),
      item.transitionOutEasing, item.customTransitionOutConfig, item.transitionOutOptions, outDuration,
    );
  }
  // A package that owns this frame keeps its media running; everything else on
  // this channel has none to run.
  if (!packageActive) deactivateTransitionPackageMediaInEngine(cs);
}
