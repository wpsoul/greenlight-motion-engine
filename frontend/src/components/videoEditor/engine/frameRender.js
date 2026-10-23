/*
 * One frame (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 27 — moved verbatim out of Player.jsx with
 * tests/engine-extraction/tools/stage9_step.py): renderFrame resolves the camera and the layer stack at the playhead,
 * renders every channel (renderChannel), composites them with their passes and adjustment layers
 * (renderAdjustmentComposite) and presents the result — the engine's `render(time)`.
 *
 * `env` carries the live editor values the frame reads (the channels, clips, layouts, parenting, fps, play state,
 * the path being edited) and the Player's own media-clock pieces (ensureChannelStates, syncTransitionSounds,
 * getTotalDuration, setupMesh, syncVideo); the Player memoizes it so it changes exactly when the old callback's
 * dependencies did.
 */
import * as THREE from 'three';
import { PARTICLE_MEDIA_TYPE } from '../../../sim/particles/schema.js';
import { allItemEffects, effectIsLiveAt, getAdjustmentEffect, hasActiveLayerOverlayEffects } from '../adjustmentEffects';
import { animatedImagePending, pumpAnimatedImages } from '../animatedImage';
import { isAutoFillEnabled } from '../autoFillLayer';
import { isBackdropBlurLayer, resolveBackdropParams, shapePeakAlpha } from '../backdropBlur';
import { isBendEnabled } from '../bendLayer';
import { isBezierWarpEnabled } from '../bezierWarp';
import { isShaderBlendMode } from '../blendModes';
import { isChromaKeyEnabled } from '../chromaKeyLayer';
import { createBlitMaterial } from '../clipShader';
import { layerPlane, layerQuad, layerSortDepth } from '../compositeSortDepth';
import { isCornerPinEnabled } from '../cornerPinLayer';
import { isDepthScanEnabled } from '../depthScanLayer';
import { isDrosteEnabled } from '../drosteLayer';
import { isFresnelRimEnabled } from '../fresnelRimLayer';
import { isGlassLayer } from '../glassEffect';
import { getItemKeyframeValues, itemHasKeyframes } from '../gsapTransitions';
import { htmlLiveBeginFrame } from '../htmlLive';
import { setKeyframeFxScene } from '../keyframeFx';
import { applyParenting, localPrs } from '../keyframeParenting';
import { isLayerMaskEnabled } from '../layerMask';
import { isMeshWarpEnabled } from '../meshWarp';
import { isMockupFrameActive } from '../mockupFrame';
import { withFlatEffects } from '../model3dFxCatalog';
import { isMotionBlurEnabled } from '../motionBlurLayer';
import { motionMediaPending, pumpMotionMedia } from '../motionTemplates';
import { isMotionTrailEnabled } from '../motionTrailLayer';
import { perfRegistry } from '../perfRegistry.js';
import { findCameraChannel, getCameraDofSettings, isCameraChannel } from '../projectCamera';
import { isPryzmEnabled } from '../pryzmLayer';
import { isRegionDistortEnabled } from '../regionDistort';
import { isRepetileEnabled } from '../repetileLayer';
import { isCameraBaked3dPlate, isDepthPlate, isWorld3dLayer, resolveRigAt, RIG_MEDIA_TYPE, rigDrawsBackdrop } from '../rig3d';
import { isRigEnabled } from '../rigDeform';
import { isRunningGlowEnabled } from '../runningGlow';
import { getTrackMatte } from '../trackMatte';
import { releaseIdleTransitionCaptures } from '../transitionPackageRuntime';
import { renderAdjustmentComposite as renderAdjustmentCompositeInEngine, setLayerDepthMode as setLayerDepthModeInEngine } from './adjustmentComposite';
import { repaintAnimatedBackground } from './background';
import { poseEngineCamera } from './camera';
import { prePoseWorldModels, renderChannel as renderChannelInEngine } from './channelRender';
import { getChannelsBottomToTop, isClipMaskItem, orderChannelsForComposite, resolveActiveIndex, resolveGlassLayer } from './compositeHelpers';
import { clamp01 } from './layerHelpers';
import { isTexturePinned as isTexturePinnedInEngine } from './mediaTextures';
import { resolveParenting as resolveParentingInEngine } from './meshTransform';
import { PASS_POOL_IDLE_MS, sweepPassPool as sweepPassPoolInEngine } from './passPool';
import { releaseUnusedPreTransitionFxTargets as releaseUnusedPreTransitionFxTargetsInEngine } from './transitions';
import { PERF_SAMPLE_MS } from './compositeHelpers';
import { scheduleWarmUp } from './warmUp';
import { prepareWorldLayerFx, restoreWorldLayerFx } from './worldLayerFx';

export function renderFrame(engine, env) {
  const renderer = engine.renderer;
  const scene = engine.scene;
  const camera = engine.camera;
  if (!renderer || !scene || !camera) return;
  // A WebGPU renderer throws outright if anything draws before init() resolves.
  // The boot repaints once it does.
  if (!engine.rendererReady) return;
  // While paused and idle, the layers not drawn yet get one hidden frame each, so their programs are built before
  // play (./warmUp.js). One flag check while playing.
  scheduleWarmUp(engine, env, renderFrame);
  htmlLiveBeginFrame();
  perfRegistry.rendered += 1;
  engine.passFrame += 1;
  sweepPassPoolInEngine(engine);
  if (engine.idleSweepTimer) clearTimeout(engine.idleSweepTimer);
  engine.idleSweepTimer = setTimeout(() => {
    engine.idleSweepTimer = null;
    sweepPassPoolInEngine(engine, true);
    for (const cs of engine.channelStates.values()) releaseIdleTransitionCaptures(cs);
    // Nested sequences keep their own channel states — same release for them.
    for (const st of engine.sequenceStates.values()) {
      for (const cs of st?.channelStates?.values?.() || []) releaseIdleTransitionCaptures(cs);
    }
  }, PASS_POOL_IDLE_MS);
  // One token per composited frame. The 3D passes use it to render the shared
  // shadow maps ONCE — the first pass of a frame refreshes them and every later
  // pass reuses them. A comp with a cyclorama and four models is five passes;
  // without this it would be five full shadow renders for one frame.
  engine.frameToken += 1;
  // Animated project background (shader / animated gradient): repaint the
  // rasterization canvas from the current playhead time before compositing.
  repaintAnimatedBackground(engine);
  // Playhead moved while paused → this is a scrub: thin the geometry plates for
  // the duration of the drag, and schedule the one full-quality repaint.
  {
    const sc = engine.scrubPlate;
    const now = performance.now();
    const t = engine.currentTime;
    if (engine.isPlaying || engine.exporting) {
      sc.active = false;
      sc.t = t;
    } else if (Math.abs(t - sc.t) > 1e-4) {
      sc.t = t;
      sc.at = now;
      sc.active = true;
      clearTimeout(sc.timer);
      sc.timer = setTimeout(() => {
        sc.timer = null;
        sc.active = false;
        if (!engine.isPlaying && !engine.exporting) engine.renderFrame?.();
      }, env.SCRUB_SETTLE_MS);
    }
  }
  const frameStart = performance.now();
  env.ensureChannelStates();
  // Publish this frame's clock and layer table for ƒx Custom expressions:
  // `time`/`frame` need the project clock and fps, and layer("Name").prop needs
  // every other layer's placement. Set here rather than in the evaluator so the
  // export walks the identical path — one write per frame, no allocation (the
  // index is the memoized env.parentIndex).
  setKeyframeFxScene({
    time: engine.currentTime,
    fps: env.projectFps || 30,
    index: env.parentIndex,
    nameOf: (entry) => {
      const clip = env.clipsMap.get(entry.item?.clipId);
      return entry.item?.customName
        || (clip?.mediaType === 'text' ? (entry.item?.textContent || clip?.name) : clip?.name)
        || '';
    },
    evaluate: getItemKeyframeValues,
    // Lets an expression walk into a sequence/grid's nested timeline
    // (layer("Seq").layer("Inner")) — the clip owns `sequence.channels`.
    clipOf: (item) => env.clipsMap.get(item?.clipId),
  });
  // This frame's camera pose, resolved BEFORE the channel loop, and the posed camera pointed at it
  // (engine/camera.js). World view films with its own orbit camera, so the posed camera stands down there.
  poseEngineCamera(engine, {
    channels: env.channels, clipsMap: env.clipsMap, layoutFor: (ch) => env.layoutMap.get(ch.id), time: engine.currentTime, worldActive: engine.worldActive,
  });
  engine.sequenceFrameStamp += 1;
  engine.preTransitionFxUsed.clear();
  engine.preTransitionFxItemIds.clear();
  engine.colorRefBakeKeys.clear();
  engine.shortAudio?.beginFrame();
  // Smart render cache: a cached frame runs only the media half of every channel.
  const rcTexture = engine.rcFrameTexture(engine.currentTime);
  engine.rcDrewCache = !!rcTexture;
  engine.rcMediaOnly = !!rcTexture;
  try {
    // Every 3D model where it is THIS frame before the first pass renders the Rig's
    // shared shadow map (channelRender.prePoseWorldModels).
    prePoseWorldModels(engine, env, engine.currentTime);
    for (const channel of env.channels) renderChannelInEngine(engine, env, channel, engine.currentTime);
  } finally {
    engine.rcMediaOnly = false;
  }
  env.syncTransitionSounds(engine.currentTime);
  engine.shortAudio?.endFrame();
  // Pause media inside sequences the playhead has left this frame — their inner
  // env.channels are no longer visited, so nothing else would stop them.
  for (const st of engine.sequenceStates.values()) {
    if (st._frameStamp === engine.sequenceFrameStamp) continue;
    for (const [chId, cs] of st.channelStates.entries()) {
      if (cs.videos.a.src && !cs.videos.a.paused) cs.videos.a.pause();
      if (cs.videos.b.src && !cs.videos.b.paused) cs.videos.b.pause();
      const seqAudio = engine.audioElements.get(`${chId}_audio`);
      if (seqAudio && !seqAudio.paused) seqAudio.pause();
    }
  }
  const afterScene = performance.now();

  // Sweep textures that were queued for disposal once they left the screen.
  // (Disposing a still-displayed texture would draw a black/garbage frame.)
  if (engine.pendingDisposal.size > 0) {
    for (const tex of engine.pendingDisposal) {
      if (!isTexturePinnedInEngine(engine, tex)) {
        try { tex.dispose(); } catch { /* no-op */ }
        engine.pendingDisposal.delete(tex);
      }
    }
  }

  // eslint-disable-next-line no-labels
  rcComposite: {
  if (rcTexture) {
    const plate = engine.rcPlate;
    if (!plate.mesh) {
      const makeMaterial = engine.materialFactory;
      plate.material = (makeMaterial && makeMaterial.blit()) ?? createBlitMaterial();
      plate.mesh = new THREE.Mesh(engine.fsQuadGeo, plate.material);
      plate.scene = new THREE.Scene();
      plate.scene.add(plate.mesh);
    }
    plate.material.uniforms.uTexture.value = rcTexture;
    renderer.setRenderTarget(engine.outputTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(plate.scene, engine.orthoCamera);
    perfRegistry.renderCache.cachedFrames += 1;
    perfRegistry.renderCache.last = 'cache';
    // eslint-disable-next-line no-labels
    break rcComposite;
  }
  if (engine.isPlaying) {
    perfRegistry.renderCache.liveFrames += 1;
    perfRegistry.renderCache.last = 'live';
  }
  // ── 3D world view ──
  // An authoring mode, so it deliberately bypasses the multi-pass compositor
  // (adjustment layers, clip masks and camera DOF all render full-frame quads
  // that mean nothing off-axis). `exportingRef` keeps it out of the export.
  const worldView = engine.worldActive ? engine.worldView : null;
  if (worldView && !engine.exporting) {
    const t = engine.currentTime;
    const layers = [];
    for (const channel of env.channels) {
      if (channel.visible === false) continue;
      const cs = engine.channelStates.get(channel.id);
      if (!cs || !cs.group.visible) continue;
      const mesh = cs.currMesh.visible ? cs.currMesh : (cs.prevMesh.visible ? cs.prevMesh : null);
      if (!mesh) continue;
      const layout = env.layoutMap.get(channel.id);
      if (!layout) continue;
      const ai = resolveActiveIndex(layout, t);
      if (ai < 0) continue;
      const item = channel.items[ai];
      const entry = layout[ai];
      const span = Math.max(1e-6, entry.endTime - entry.startTime);
      const parentXform = resolveParentingInEngine(engine, env.parentIndex, item, t);
      layers.push({
        itemId: item.id,
        channelId: channel.id,
        item,
        entry,
        mesh,
        pct: Math.max(0, Math.min(1, (t - entry.startTime) / span)) * 100,
        keyTolerancePct: 50 / Math.max(span * (env.projectFps || 30), 1), // half of one project frame
        // The mesh already sits at the parented pose; the gizmo write-back needs
        // the parent's contribution to turn a world drag back into local PRS.
        parentPrs: parentXform?.prs || null,
        parentType: parentXform?.type || null,
      });
    }
    // The camera clip under the playhead owns the path being authored, and is
    // itself selectable/draggable, so it carries its own clip-relative timing
    // for the keyframe write-back.
    //
    // With no camera clip under the playhead the proxy still draws (at the
    // neutral pose) — so instead of leaving a visible camera that swallows every
    // click, hand over the NEAREST camera clip as a `live: false` descriptor.
    // The engine dims the proxy and keeps the gizmo off it (there is no clip-
    // relative position to key against), but a click still selects that clip and
    // seeks into it, which makes it live on the very next frame.
    const camChannel = findCameraChannel(env.channels);
    let camDesc = null;
    if (camChannel) {
      const camLayout = env.layoutMap.get(camChannel.id);
      const camIndex = camLayout ? resolveActiveIndex(camLayout, t) : -1;
      if (camIndex >= 0) {
        const camItem = camChannel.items[camIndex];
        const camEntry = camLayout[camIndex];
        const camSpan = Math.max(1e-6, camEntry.endTime - camEntry.startTime);
        camDesc = {
          itemId: camItem.id,
          channelId: camChannel.id,
          item: camItem,
          live: true,
          pct: Math.max(0, Math.min(1, (t - camEntry.startTime) / camSpan)) * 100,
          keyTolerancePct: 50 / Math.max(camSpan * 30, 1),
        };
      } else if (camLayout?.length) {
        let nearest = -1;
        let nearestGap = Infinity;
        camLayout.forEach((entry, i) => {
          const gap = t < entry.startTime ? entry.startTime - t : t - entry.endTime;
          if (gap < nearestGap) { nearestGap = gap; nearest = i; }
        });
        const camEntry = nearest >= 0 ? camLayout[nearest] : null;
        if (camEntry) {
          camDesc = {
            itemId: camChannel.items[nearest].id,
            channelId: camChannel.id,
            item: camChannel.items[nearest],
            live: false,
            // Land just inside the clip, never on its exclusive end edge.
            seekTime: t < camEntry.startTime
              ? camEntry.startTime
              : Math.max(camEntry.startTime, camEntry.endTime - 1 / 30),
          };
        }
      }
    }
    // Lend the 3D view each model's real geometry, and hide the flat quad that stands
    // in for it — a billboard is the wrong thing to judge depth against while framing
    // a camera move. This MUST run before syncLayers: that call re-applies the
    // selection, and the gizmo reads `worldObject` from these very objects. `layers`
    // is rebuilt every frame, so setting it afterwards means the gizmo never sees it
    // and falls back to the layer's neutral full-frame quad at the origin.
    const mod3d = engine.model3d;
    const worldScene = engine.scene;
    const hidden = [];
    const liveModels = new Set();
    for (const l of layers) {
      if (env.clipsMap.get(l.item?.clipId)?.mediaType !== 'model3d') continue;
      liveModels.add(l.itemId);
      const object = mod3d?.getModelObject(l.itemId) || null;
      const held = engine.worldModels.get(l.itemId);
      if (held && held.object !== object) {
        try { held.detach(); } catch { /* already home */ }
        engine.worldModels.delete(l.itemId);
      }
      if (object && mod3d && worldScene && !engine.worldModels.has(l.itemId)) {
        const detach = mod3d.attachModelToScene(l.itemId, worldScene);
        if (detach) engine.worldModels.set(l.itemId, { detach, object });
      }
      if (mod3d) l.worldObject = object;
      if (l.mesh?.visible) { l.mesh.visible = false; hidden.push(l.mesh); }
    }
    // A plate that had to be FILMED (it receives the set's shadows) is in the same
    // position as a model: the quad the compositor holds is a full-frame billboard
    // standing at the origin with the project camera's perspective already painted
    // into it. Left alone it made the 3D view disagree with the 2D one about where
    // the layer is — the whole point of this view is that they agree. Its real
    // plane is lent instead, exactly as a model's geometry is.
    //
    // Casting and occluding layers need nothing here: they were never filmed, so
    // their own quad is still standing in the right place.
    for (const l of layers) {
      const lClip = env.clipsMap.get(l.item?.clipId);
      if (!isCameraBaked3dPlate(lClip, l.item) || lClip?.mediaType === 'model3d') continue;
      if (lClip?.mediaType === RIG_MEDIA_TYPE) continue;
      liveModels.add(l.itemId);
      const object = mod3d?.getPlateObject?.(l.itemId) || null;
      const held = engine.worldModels.get(l.itemId);
      if (held && held.object !== object) {
        try { held.detach(); } catch { /* already home */ }
        engine.worldModels.delete(l.itemId);
      }
      if (object && mod3d && worldScene && !engine.worldModels.has(l.itemId)) {
        const detach = mod3d.attachPlateToScene?.(l.itemId, worldScene);
        if (detach) engine.worldModels.set(l.itemId, { detach, object });
      }
      if (object) l.worldObject = object;
      if (l.mesh?.visible) { l.mesh.visible = false; hidden.push(l.mesh); }
    }
    // The RIG layer gets exactly the same treatment, and for exactly the same
    // reason. Left as an ordinary layer it showed up here as its composited output
    // painted on a flat full-frame quad — a curved studio backdrop rendered as a
    // rectangle with a gradient on it. The 3D view exists to judge depth while
    // framing a camera move, and a billboard of a set is no use for that.
    for (const l of layers) {
      if (env.clipsMap.get(l.item?.clipId)?.mediaType !== RIG_MEDIA_TYPE) continue;
      const object = mod3d?.getCycloramaObject?.() || null;
      const held = engine.worldModels.get(l.itemId);
      if (held && held.object !== object) {
        try { held.detach(); } catch { /* already home */ }
        engine.worldModels.delete(l.itemId);
      }
      if (object && mod3d && worldScene && !engine.worldModels.has(l.itemId)) {
        const detach = mod3d.attachCycloramaToScene?.(worldScene);
        if (detach) engine.worldModels.set(l.itemId, { detach, object });
      }
      if (mod3d) l.worldObject = object;
      if (l.mesh?.visible) { l.mesh.visible = false; hidden.push(l.mesh); }
      liveModels.add(l.itemId);
    }
    // A Solver Box is lent the same way, and for the same reason: as an ordinary
    // layer it showed up here as its particles painted flat on a full-frame quad
    // — a billboard of a volume, which is exactly what this view exists to stop
    // you having to imagine. Borrowed, you orbit the real box, its emitter and
    // its force arrows.
    const partMod = engine.particle;
    for (const l of layers) {
      if (env.clipsMap.get(l.item?.clipId)?.mediaType !== PARTICLE_MEDIA_TYPE) continue;
      liveModels.add(l.itemId);
      const object = partMod?.getParticleWorldObject?.(l.itemId) || null;
      const held = engine.worldModels.get(l.itemId);
      if (held && held.object !== object) {
        try { held.detach(); } catch { /* already home */ }
        engine.worldModels.delete(l.itemId);
      }
      if (object && partMod && worldScene && !engine.worldModels.has(l.itemId)) {
        const detach = partMod.attachParticlesToScene?.(l.itemId, worldScene);
        if (detach) engine.worldModels.set(l.itemId, { detach, object });
      }
      if (object) l.worldObject = object;
      if (l.mesh?.visible) { l.mesh.visible = false; hidden.push(l.mesh); }
    }
    for (const [id, held] of [...engine.worldModels.entries()]) {
      if (liveModels.has(id)) continue;
      held.detach();
      engine.worldModels.delete(id);
    }

    // Grids get the model treatment: their cells are real 3D objects (they are
    // FILMED as such — see buildGridCellPoses), so the 3D view shows the member
    // meshes themselves at their world poses. The screen-aligned plate would
    // read as a full-frame card at z 0 — the exact opposite of what this view
    // is for. The container's private scene is borrowed under a group posed at
    // the grid's resolved transform; renderSequenceFrame keeps posing the
    // member meshes every frame, so a sphere or a Z run is walkable live.
    const liveGrids = new Set();
    for (const l of layers) {
      if (env.clipsMap.get(l.item?.clipId)?.mediaType !== 'grid') continue;
      const st = engine.sequenceStates.get(l.itemId);
      if (!st || !worldScene) continue;
      liveGrids.add(l.itemId);
      let lent = engine.worldGrids.get(l.itemId);
      if (!lent) {
        const group = new THREE.Group();
        group.add(st.scene);
        worldScene.add(group);
        lent = { group, scene: st.scene };
        engine.worldGrids.set(l.itemId, lent);
      }
      // The plate mesh is frame identity, so the pose is recomputed from the item.
      const kfg = itemHasKeyframes(l.item) ? getItemKeyframeValues(l.item, l.pct / 100) : null;
      const lp = localPrs(l.item, kfg, engine.videoSize.w, engine.videoSize.h);
      const gp = l.parentPrs ? applyParenting(l.parentPrs, lp, l.parentType) : lp;
      lent.group.position.set(gp.px, gp.py, gp.pz);
      lent.group.rotation.set(gp.rx, gp.ry, gp.rz);
      lent.group.scale.set(gp.sx, gp.sy, gp.sz);
      l.worldObject = lent.group;
      if (l.mesh?.visible) { l.mesh.visible = false; hidden.push(l.mesh); }
    }
    for (const [id, lent] of [...engine.worldGrids.entries()]) {
      if (liveGrids.has(id)) continue;
      lent.group.remove(lent.scene);
      lent.group.parent?.remove(lent.group);
      engine.worldGrids.delete(id);
    }

    worldView.setVideoSize(engine.videoSize.w, engine.videoSize.h);
    worldView.setCameraItem(camDesc);
    // Remembered so a rig-endpoint drag knows which item to write back to.
    engine.cameraItem = camDesc?.item ? { ...camDesc.item, id: camDesc.itemId || camDesc.item.id } : null;
    worldView.syncLayers(layers);
    const objectPathLayer = env.motionPathEditItemId
      ? layers.find((layer) => layer.itemId === env.motionPathEditItemId)
      : null;
    let objectPathItem = objectPathLayer?.item || null;
    if (!objectPathItem && env.motionPathEditItemId) {
      for (const channel of env.channels) {
        objectPathItem = channel.items?.find((item) => item.id === env.motionPathEditItemId) || null;
        if (objectPathItem) break;
      }
    }
    worldView.setObjectPathItem?.(objectPathItem ? {
      itemId: env.motionPathEditItemId,
      item: objectPathItem,
      live: !!objectPathLayer,
    } : null);
    worldView.setPose(engine.cameraPose);

    // Depth mode for the layer quads: with real geometry in the same scene, painter
    // order is not enough — a quad must depth-test against the model or it flips
    // sides as the orbit camera passes its centre.
    // Lights are drawn in the 3D view like the camera is — a rig described only by
    // numbers is a rig nobody can aim.
    const activeRig = engine.activeRigAt(engine.currentTime);
    // Borrowed geometry remains attached while the 3D view is open, so project
    // lights/environment must be refreshed every frame just like the camera pass.
    const worldExposure = mod3d?.syncBorrowedWorldRig?.(worldScene, activeRig)
      ?? activeRig?.env?.exposure
      ?? 1;
    worldView.setDisplayExposure?.(worldExposure);
    worldView.setRigLights?.(activeRig?.lights || [], engine.selectedLight);
    // The camera rig's move, drawn with a handle at each end. Only while the
    // camera is actually in rig mode — a stale rig on a 'free' camera would draw
    // a curve nothing follows.
    const camItem = engine.cameraItem;
    // `|| {}` for the same reason applyCameraRig drops its rig check: the mode is
    // the switch, and evalCameraRig fills in the defaults. Passing the raw (often
    // undefined) field drew no curve for a camera that was visibly in rig mode.
    worldView.setCameraRig?.(
      camItem?.cameraMoveMode === 'rig' ? (camItem.cameraRig || {}) : null,
      engine.selectedRigEnd,
      // A Follow Object rig is drawn around the point it follows THIS frame —
      // stashed on the pose by applyCameraRig, which resolved it moments ago.
      engine.cameraPose?.camFollowCenter || null
    );
    // The ITEM a light drag writes back to — from the entry, not from `activeRig`,
    // which is the evaluated rig and carries no identity.
    engine.worldLightItem = resolveRigAt(engine.rigEntries, engine.currentTime)?.itemId || null;
    setLayerDepthModeInEngine(engine, true);
    // Chroma Key / Layer Mask cards show their keyed, masked plate for this draw (engine/worldLayerFx.js).
    const fxSwaps = prepareWorldLayerFx(engine, layers, t);
    try {
      worldView.render();
    } finally {
      restoreWorldLayerFx(fxSwaps);
    }
    for (const m of hidden) m.visible = true;
    if (!engine.exporting && motionMediaPending() && !engine.mediaPump) {
      engine.mediaPump = true;
      pumpMotionMedia().finally(() => { engine.mediaPump = false; });
    }
    // Same contract for an animated image whose file is still decoding: the frame
    // just painted fell back to its still texture. Unlike the motion pump this
    // settles ONCE per file rather than per frame — after the decode every frame
    // of it is synchronous — so this drains to nothing instead of running for the
    // whole of playback.
    if (!engine.exporting && animatedImagePending() && !engine.gifPump) {
      engine.gifPump = true;
      pumpAnimatedImages().finally(() => { engine.gifPump = false; });
    }
    return;
  }

  // Detect adjustment layers AND clipping masks (shape or text) active at the
  // current time. When present, route through the multi-pass RTT compositor so they
  // affect the layers below them. Otherwise keep the single-pass path untouched.
  const adjustments = [];
  // Layers with Running Glow active now. The effect needs the layer rendered
  // alone (its silhouette is the contour), so like camera DOF it can only run
  // in the multi-pass compositor — collecting it here is what forces that path.
  const glowLayers = engine.glowLayers;
  glowLayers.clear();
  // Regular layers with enabled Overlay Effects. Same reason as the glow map, and
  // registered by its OWN check rather than another `else if`: glow and the chain
  // are independent, and chaining them would silently skip the effects on exactly
  // the layers that use both.
  const overlayFx = engine.overlayFx;
  overlayFx.clear();
  // Motion Blur layers force the multi-pass path for the same reason: the blur
  // needs the layer isolated on its own plate.
  const motionBlurLayers = engine.motionBlurLayers;
  motionBlurLayers.clear();
  // Motion Trail re-projects the isolated plate K times — same requirement,
  // and collected separately because a layer may carry trail, blur or both.
  const motionTrailLayers = engine.motionTrailLayers;
  motionTrailLayers.clear();
  // Backdrop Blur blurs the stack BEHIND a shape — only the compositor can.
  const backdropLayers = engine.backdropLayers;
  backdropLayers.clear();
  // Glass refracts the stack behind a shape — same reason, same compositor.
  const glassLayers = engine.glassLayers;
  glassLayers.clear();
  // Shader blend modes (overlay, soft light, hue…) read the stack UNDER the
  // layer — only the compositor's isolate branch can, so they force it too.
  const shaderBlendLayers = engine.shaderBlendLayers;
  shaderBlendLayers.clear();
  // Auto Fill needs the isolated plate too — collecting it forces multi-pass.
  const autoFillLayers = engine.autoFillLayers;
  autoFillLayers.clear();
  // Rig (Puppet) warps the isolated plate — same multi-pass requirement.
  const rigLayers = engine.rigLayers;
  rigLayers.clear();
  // Repetile re-draws the isolated plate as a tile field — multi-pass too.
  const repetileLayers = engine.repetileLayers;
  repetileLayers.clear();
  // The warps redraw the isolated plate through their own geometry — multi-pass too,
  // and collected separately because a layer may carry any combination of them.
  const regionDistortLayers = engine.regionDistortLayers;
  regionDistortLayers.clear();
  const cornerPinLayers = engine.cornerPinLayers;
  cornerPinLayers.clear();
  const drosteLayers = engine.drosteLayers;
  drosteLayers.clear();
  const pryzmLayers = engine.pryzmLayers;
  pryzmLayers.clear();
  const chromaKeyLayers = engine.chromaKeyLayers;
  chromaKeyLayers.clear();
  const depthScanLayers = engine.depthScanLayers;
  depthScanLayers.clear();
  const frRimLayers = engine.frRimLayers;
  frRimLayers.clear();
  const mockupFrameLayers = engine.mockupFrameLayers;
  mockupFrameLayers.clear();
  const bendLayers = engine.bendLayers;
  bendLayers.clear();
  const meshWarpLayers = engine.meshWarpLayers;
  meshWarpLayers.clear();
  const bezierWarpLayers = engine.bezierWarpLayers;
  bezierWarpLayers.clear();
  // Layer Mask cuts the isolated plate — same multi-pass requirement.
  const layerMaskLayers = engine.layerMaskLayers;
  layerMaskLayers.clear();
  const layerItems = engine.layerItems;
  layerItems.clear();
  const depthPlates = engine.depthPlates;
  depthPlates.clear();
  const modelLayers = new Map();
  const tNow = engine.currentTime;
  // The chain's liveness context for an item at this frame (mix, keyed mix,
  // active window, master amount) — what decides whether an Overlay Effect
  // costs anything: the multi-pass detour, a reference pre-render, consumption.
  const overlayLiveAt = (item, entry) => {
    const dur = entry ? entry.endTime - entry.startTime : 0;
    const progress = dur > 0 ? clamp01((tNow - entry.startTime) / dur) : 0;
    const kf = itemHasKeyframes(item) ? getItemKeyframeValues(item, progress) : null;
    return {
      kf, time: entry ? tNow - entry.startTime : null, duration: dur,
      master: Number.isFinite(kf?.effectAmount) ? clamp01(kf.effectAmount) : 1,
    };
  };
  for (const channel of getChannelsBottomToTop(env.channels)) {
    if (channel.visible === false) continue;
    const layout = env.layoutMap.get(channel.id);
    if (!layout) continue;
    const ai = resolveActiveIndex(layout, tNow);
    if (ai < 0) continue;
    const item = channel.items[ai];
    const clip = env.clipsMap.get(item?.clipId);
    if (clip?.mediaType === 'adjustment') {
      adjustments.push({ channelId: channel.id, item, entry: layout[ai], kind: 'adjust' });
    } else if (isClipMaskItem(clip, item)) {
      adjustments.push({ channelId: channel.id, item, entry: layout[ai], kind: 'mask' });
    } else {
      layerItems.set(channel.id, item);
      if (isShaderBlendMode(item?.blendMode)) shaderBlendLayers.set(channel.id, item.blendMode);
      // Every per-layer collector below skips an item whose stack already baked
      // into its plate in preparePreTransitionOverlayEffects — the check is
      // load-bearing, exactly as it is for the mask: collecting it again would
      // run the stack twice on the framed/warped/tiled result.
      const bakedForTransition = engine.preTransitionFxItemIds.has(item.id);
      if (isRunningGlowEnabled(item) && !bakedForTransition) glowLayers.set(channel.id, { item, entry: layout[ai] });
      // Not on models: their plate is a projected 2D silhouette, so the fill
      // would creep in screen space — the surface-geodesic 3D version replaces
      // this rather than faking it.
      if (isAutoFillEnabled(item) && clip?.mediaType !== 'model3d' && !bakedForTransition) {
        autoFillLayers.set(channel.id, { item, entry: layout[ai] });
      }
      // Not on a layer filmed before the compositor: its transform is applied
      // inside the 3D pass and the plane it comes back on is a neutral full-frame
      // quad, so the box velocity reads as zero. A casting or occluding layer is
      // still its own moving quad and keeps every one of these.
      if (isMotionBlurEnabled(item) && !isCameraBaked3dPlate(clip, item)) {
        motionBlurLayers.set(channel.id, { item, entry: layout[ai], clip });
      }
      // Same exclusion, same reason: a camera-baked plate comes back on a
      // neutral full-frame quad, so its box does not move and every repeat
      // would land on top of the original.
      if (isMotionTrailEnabled(item) && !isCameraBaked3dPlate(clip, item)) {
        motionTrailLayers.set(channel.id, { item, entry: layout[ai], clip });
      }
      // Drop the temporal state of a layer that no longer trails, so its ring
      // and accumulator do not hold a stale past if it is switched back on.
      if (!motionTrailLayers.has(channel.id)) engine.trailState.delete(channel.id);
      // P0 scope: plain visual layers only — camera-baked plates carry no 2D
      // plate motion, and sequences/grids composite through their nested path.
      if (isRigEnabled(item) && !isCameraBaked3dPlate(clip, item)
        && clip?.mediaType !== 'sequence' && clip?.mediaType !== 'grid' && !bakedForTransition) {
        rigLayers.set(channel.id, { item, entry: layout[ai] });
      }
      // Not on a camera-baked plate: its transform lives inside the 3D pass and
      // the plate comes back as a neutral full-frame quad, so there is no layer
      // box to lay a field out in.
      if (isRepetileEnabled(item) && !isCameraBaked3dPlate(clip, item)) {
        // Baked for a transition: keep the history (the bake still reads it).
        if (!bakedForTransition) repetileLayers.set(channel.id, { item, entry: layout[ai], clip });
      } else if (item?.id) {
        // Same reason the trail drops its ring: a layer that no longer tiles must
        // not hold a stale past for the moment it is switched back on.
        engine.repetileHist.delete(item.id);
      }
      // Every warp is laid out in the layer's own box, so they are all out for the
      // same reason.
      if (isRegionDistortEnabled(item) && !isCameraBaked3dPlate(clip, item) && !bakedForTransition) {
        regionDistortLayers.set(channel.id, { item, entry: layout[ai], clip });
      }
      if (isCornerPinEnabled(item) && !isCameraBaked3dPlate(clip, item) && !bakedForTransition) {
        cornerPinLayers.set(channel.id, { item, entry: layout[ai], clip });
      }
      if (isDrosteEnabled(item) && !isCameraBaked3dPlate(clip, item) && !bakedForTransition) {
        drosteLayers.set(channel.id, { item, entry: layout[ai], clip });
      }
      if (isPryzmEnabled(item) && !isCameraBaked3dPlate(clip, item) && !bakedForTransition) {
        pryzmLayers.set(channel.id, { item, entry: layout[ai], clip });
      }
      // Keying reads pixels, not the layer box — a camera-baked plate keys too.
      if (isChromaKeyEnabled(item) && !bakedForTransition) {
        chromaKeyLayers.set(channel.id, { item, entry: layout[ai], clip });
      }
      if (isDepthScanEnabled(item) && !isCameraBaked3dPlate(clip, item) && !bakedForTransition) {
        depthScanLayers.set(channel.id, { item, entry: layout[ai], clip });
      }
      if ((clip?.mediaType === 'image' || clip?.mediaType === 'video') && isFresnelRimEnabled(item, clip.mediaType)
        && !isCameraBaked3dPlate(clip, item) && !bakedForTransition) {
        frRimLayers.set(channel.id, { item, entry: layout[ai], clip });
      }
      if (isMockupFrameActive(item) && !isCameraBaked3dPlate(clip, item) && !bakedForTransition) {
        mockupFrameLayers.set(channel.id, { item, entry: layout[ai], clip });
      }
      if (isBendEnabled(item) && !isCameraBaked3dPlate(clip, item) && !bakedForTransition) {
        bendLayers.set(channel.id, { item, entry: layout[ai], clip });
      }
      if (isMeshWarpEnabled(item) && !isCameraBaked3dPlate(clip, item) && !bakedForTransition) {
        meshWarpLayers.set(channel.id, { item, entry: layout[ai], clip });
      }
      if (isBezierWarpEnabled(item) && !isCameraBaked3dPlate(clip, item) && !bakedForTransition) {
        bezierWarpLayers.set(channel.id, { item, entry: layout[ai], clip });
      }
      // Layer Mask. Excluded on camera-baked plates for the same reason as
      // Repetile: the plate arrives already filmed and its quad is a neutral
      // full-frame stand-in, so computeLayerBox would describe the FRAME
      // rather than the artwork and the mask would cut the wrong thing.
      //
      // ⚠️ The preTransitionFxItemIds check is load-bearing. A masked layer
      // inside a transition is already cut in preparePreTransitionOverlayEffects
      // (flow 3); collecting it here as well would run the stack twice —
      // doubled feather, squared opacity.
      if (isLayerMaskEnabled(item) && !isCameraBaked3dPlate(clip, item)
        && !engine.preTransitionFxItemIds.has(item.id)) {
        layerMaskLayers.set(channel.id, { item, entry: layout[ai], clip });
      }
      // On a model, entries that render in 3D are not the flat chain's
      // (withFlatEffects returns the same item for everything else).
      const flatItem = withFlatEffects(item, clip);
      if (hasActiveLayerOverlayEffects(flatItem, overlayLiveAt(flatItem, layout[ai])) && !engine.preTransitionFxItemIds.has(item.id)) {
        // `clip` rides along for Neon Glow's outline bake: the path SOURCE is
        // decided by the clip's media type (shape path / traced text canvas /
        // image alpha / media rect), which the item alone cannot tell.
        overlayFx.set(channel.id, { item: flatItem, entry: layout[ai], clip });
      }
      // Backdrop Blur: shape layers only, and only while the blur is non-zero
      // THIS frame — a keyed fade-in costs nothing until it starts, and a
      // shape with the field at 0 takes the direct path byte-for-byte.
      if (isBackdropBlurLayer(item, clip) && !isCameraBaked3dPlate(clip, item)) {
        const params = resolveBackdropParams(item, overlayLiveAt(item, layout[ai]).kf);
        if (params.blurPx > 0) backdropLayers.set(channel.id, { ...params, alphaRef: shapePeakAlpha(item) });
      }
      // Glass: shape layers whose outline the pass can bevel (glassEffect.js).
      if (isGlassLayer(item, clip) && !isCameraBaked3dPlate(clip, item)) {
        const { w: compW, h: compH } = engine.videoSize;
        glassLayers.set(channel.id, resolveGlassLayer(item, overlayLiveAt(item, layout[ai]).kf, compW, compH));
      }
      if (isDepthPlate(item, clip)) depthPlates.set(channel.id, item);
      // The Scene Rig's backdrop is a 3D pass too. With no model beside it the frame
      // took the direct single pass, which painted the backdrop over every layer and,
      // on WebGPU, drew it upside down; the composite puts it first, the right way up.
      if (isWorld3dLayer(item, clip) || (clip?.mediaType === RIG_MEDIA_TYPE && rigDrawsBackdrop(item?.rig))) {
        modelLayers.set(channel.id, { item, entry: layout[ai] });
      }
    }
  }

  // Track matte: resolve consumer → source pairs among this frame's active
  // layers. A pair is LIVE only when the source item is the one actually active
  // on its channel right now (and wasn't classified as a mask/adjustment above);
  // otherwise the matte is EMPTY — AE semantics, handled in the composite loop.
  const trackMatteLayers = engine.trackMatteLayers;
  trackMatteLayers.clear();
  const matteSourceChannels = engine.matteSourceChannels;
  matteSourceChannels.clear();
  for (const [channelId, item] of layerItems) {
    const matte = getTrackMatte(item);
    if (!matte) continue;
    const srcEntry = env.parentIndex.get(matte.sourceId);
    const srcActive = !!srcEntry && srcEntry.channelId !== channelId
      && layerItems.get(srcEntry.channelId)?.id === matte.sourceId;
    trackMatteLayers.set(channelId, {
      mode: matte.mode,
      sourceChannelId: srcActive ? srcEntry.channelId : null,
    });
    if (srcActive) matteSourceChannels.set(srcEntry.channelId, matte.sourceId);
  }

  // Copy Color Profile: which layers are referenced by an Overlay Effect this
  // frame (on a regular layer or an adjustment layer). A reference that is LIVE
  // — the item active on a visible channel right now — is measured from its
  // isolate as drawn (pose, effects); any other reference (hidden channel, a
  // clip elsewhere in time, the same channel) is measured from its source
  // picture instead, so hiding the reference channel — the natural thing to do
  // with a colour reference — keeps the effect working. Keyed by item id; the
  // channel id is set only for a live one. A referenced layer still draws
  // itself unless the effect is flagged consumesLayerRef.
  const colorRefSources = engine.colorRefSources;
  colorRefSources.clear();
  const colorRefConsumed = engine.colorRefConsumed;
  colorRefConsumed.clear();
  // `at` is the chain's own liveness context for this item (mix, keyed mix,
  // active window): an effect the chain would bypass must not cost a
  // reference pre-render — and must not consume its texture layer either.
  const collectColorRefs = (item, at) => {
    for (const eff of allItemEffects(item)) {
      if (!effectIsLiveAt(eff, at, item)) continue;
      const def = getAdjustmentEffect(eff.id);
      const key = def?.usesLayerRef;
      if (!key) continue;
      const srcId = eff.params?.[key];
      if (typeof srcId !== 'string' || !srcId || srcId === item.id) continue;
      const srcEntry = env.parentIndex.get(srcId);
      if (!srcEntry) continue;
      // `layerRefMode: 'picture'` (Copy Color Profile) never uses the live
      // isolate: the reference is always the clip's own picture, so the layer
      // can sit anywhere on the timeline and its channel can stay hidden.
      const live = def.layerRefMode !== 'picture' && layerItems.get(srcEntry.channelId)?.id === srcId;
      // `layerRefMode: 'live'` (Double Exposure) has no picture fallback: a
      // reference that is not on screen with this item is a plain bypass.
      if (!live && def.layerRefMode === 'live') continue;
      colorRefSources.set(srcId, { channelId: live ? srcEntry.channelId : null, item: srcEntry.item });
      if (live && def.consumesLayerRef) colorRefConsumed.add(srcEntry.channelId);
    }
  };
  for (const { item, entry } of overlayFx.values()) collectColorRefs(item, overlayLiveAt(item, entry));
  for (const a of adjustments) if (a.kind === 'adjust') collectColorRefs(a.item, overlayLiveAt(a.item, a.entry));

  const cameraDof = getCameraDofSettings(engine.cameraPose, camera.position.z);
  const cameraDofActive = cameraDof.enabled && cameraDof.aperture > 0 && cameraDof.blurLevel > 0;
  // The single-pass path draws the whole scene with ONE camera, so it cannot serve a
  // stack that mixes camera-locked env.channels with posed ones. That only matters while
  // the camera is actually posed — with no camera layer the two cameras coincide and
  // the fast path stays byte-for-byte what it was.
  const posedCam = engine.posedCamera;
  const cameraPosed = !!engine.cameraPose && !engine.worldActive;
  let hasLocked = false;
  let hasPosed = false;
  let hasGridPlate = false;
  for (const channel of env.channels) {
    if (channel.visible === false || !channel.items?.length) continue;
    if (channel.cameraLocked || isCameraChannel(channel)) hasLocked = true;
    else hasPosed = true;
    // A real-3D grid's plate must be composited through the neutral lens (the
    // camera already filmed its cells), which only the multi-pass path can do
    // per channel — the single pass films the whole scene with ONE camera.
    if (!hasGridPlate && channel.items.some((it) => env.clipsMap.get(it.clipId)?.mediaType === 'grid')) {
      hasGridPlate = true;
    }
    // A particle plate likewise: renderParticleLayer has already filmed the box
    // through the posed camera.
    if (!hasGridPlate && channel.items.some((it) => env.clipsMap.get(it.clipId)?.mediaType === PARTICLE_MEDIA_TYPE)) {
      hasGridPlate = true;
    }
  }
  const mixedCameraLock = cameraPosed && (hasLocked || hasGridPlate) && hasPosed;
  if ((adjustments.length > 0 || cameraDofActive || glowLayers.size > 0 || overlayFx.size > 0
      || motionBlurLayers.size > 0 || motionTrailLayers.size > 0
      || autoFillLayers.size > 0 || rigLayers.size > 0 || repetileLayers.size > 0
      || regionDistortLayers.size > 0 || bendLayers.size > 0 || cornerPinLayers.size > 0
      || drosteLayers.size > 0 || pryzmLayers.size > 0 || chromaKeyLayers.size > 0 || depthScanLayers.size > 0 || frRimLayers.size > 0
      || meshWarpLayers.size > 0 || bezierWarpLayers.size > 0 || mockupFrameLayers.size > 0
      || layerMaskLayers.size > 0 || backdropLayers.size > 0 || glassLayers.size > 0 || shaderBlendLayers.size > 0
      || trackMatteLayers.size > 0 || mixedCameraLock || modelLayers.size > 0)
    && renderAdjustmentCompositeInEngine(engine, env, adjustments)) {
    // Adjustment/mask effects and camera DOF share this alpha-aware compositor.
  } else {
    // Direct single-pass render (interactive playback). The postprocessing
    // compositor leaves renderer.autoClear = false; combined with
    // preserveDrawingBuffer the buffer would never clear,
    // so transparent layers (text/overlays) accumulate into a smear every frame.
    // Opaque full-frame video hides it by repainting every pixel. Force the clear.
    renderer.autoClear = true;
    // Every channel here shares one camera: the posed one, unless the whole stack is
    // camera-locked (in which case `hasPosed` is false and neutral is correct).
    // Bound explicitly rather than inherited: this is where the frame is
    // finished, so it is the other place the output target has to be honoured.
    renderer.setRenderTarget(engine.outputTarget);
    const passCam = cameraPosed && hasPosed ? (posedCam || camera) : camera;
    // A layer rotated in 3D: three's transparent sort (centre depth) would put whatever lies on the far half of
    // a turned card behind the card. Order the env.channels like the compositor (coplanar layers keep channel order)
    // and hand three that order. A stack with no rotated layer keeps three's own sort, untouched.
    {
      const planeOf = (channel) => {
        const cs = engine.channelStates.get(channel.id);
        const mesh = cs && (cs.currMesh?.visible ? cs.currMesh : cs.prevMesh);
        return mesh?.visible ? layerPlane(mesh) : null;
      };
      const stack = getChannelsBottomToTop(env.channels).filter((c) => engine.channelStates.has(c.id));
      if (stack.some((c) => planeOf(c))) {
        passCam.updateMatrixWorld();
        const depthOf = (channel) => {
          const cs = engine.channelStates.get(channel.id);
          const mesh = cs && (cs.currMesh?.visible ? cs.currMesh : cs.prevMesh);
          return mesh?.visible ? layerSortDepth(mesh, passCam) : 0;
        };
        // …and on the right side of every flat layer it stands on (compositeSortDepth.js orderByPlanes). A model, a
        // camera-baked or particle pass and a grid plate sit on identity quads that say nothing about where they draw.
        const quadOf = (channel) => {
          const cs = engine.channelStates.get(channel.id);
          const mesh = cs && (cs.currMesh?.visible ? cs.currMesh : cs.prevMesh);
          const u = mesh?.userData;
          return !mesh?.visible || u?.gridWorldPos || u?.cameraBaked3d || u?.particlePlate ? null : layerQuad(mesh);
        };
        orderChannelsForComposite(stack, new Map(), depthOf, planeOf, quadOf, passCam.getWorldPosition(new THREE.Vector3()))
          .forEach((c, k) => { engine.channelStates.get(c.id).group.renderOrder = k + 1; });
        engine.planeOrderApplied = true;
      } else if (engine.planeOrderApplied) {
        for (const cs of engine.channelStates.values()) if (cs.group) cs.group.renderOrder = 0;
        engine.planeOrderApplied = false;
      }
    }
    renderer.render(scene, passCam);
  }
  } // rcComposite
  const afterRender = performance.now();
  // A plate must survive until the frame has actually been drawn. Dispose banks
  // that were used by the previous frame only after this frame no longer samples
  // them, keeping transition memory bounded without invalidating live textures.
  releaseUnusedPreTransitionFxTargetsInEngine(engine);

  const perf = engine.perfStats;
  perf.frames += 1;
  perf.sceneMs += afterScene - frameStart;
  perf.renderMs += afterRender - afterScene;
  {
    const rc = engine.renderCache;
    const rcs = engine.rcSample;
    if (rc && engine.isPlaying && !engine.exporting && !engine.rcDrewCache) {
      const gap = rcs.lastPaint ? afterRender - rcs.lastPaint : 0;
      // A gap over a second is a hidden tab or a stall, not a frame.
      if (rcs.lastPaint && gap < 1000 && afterRender >= rcs.warmUntil) {
        rc.recordSample({ t: engine.currentTime, gapMs: gap, targetMs: engine.rcTargetMs });
      }
      rcs.lastPaint = afterRender;
    } else {
      rcs.lastPaint = 0;
    }
  }
  if (!perf.lastSampleAt) {
    perf.lastSampleAt = afterRender;
  } else if (afterRender - perf.lastSampleAt >= PERF_SAMPLE_MS) {
    const elapsed = Math.max(1, afterRender - perf.lastSampleAt || PERF_SAMPLE_MS);
    const perFrame = (v) => Number((v / Math.max(1, perf.frames)).toFixed(2));
    window.__vePreviewStats = {
      fps: Number(((perf.frames * 1000) / elapsed).toFixed(1)),
      avgSceneMs: perFrame(perf.sceneMs),
      avgRenderMs: perFrame(perf.renderMs),
      // Scene-build breakdown, all per frame: canvas plate paints (with how many
      // plates the static paint cache served without repainting) and the
      // offscreen render of top-level sequences.
      avgTextPaintMs: perFrame(perf.textPaintMs),
      textPaintsPerFrame: perFrame(perf.textPaints),
      textPaintSkipsPerFrame: perFrame(perf.textPaintSkips),
      avgShapePaintMs: perFrame(perf.shapePaintMs),
      shapePaintsPerFrame: perFrame(perf.shapePaints),
      shapePaintSkipsPerFrame: perFrame(perf.shapePaintSkips),
      avgSequenceMs: perFrame(perf.sequenceMs),
      sequenceRendersPerFrame: perFrame(perf.sequenceRenders),
      activeVideoCount: Array.from(engine.channelStates.values()).reduce((count, cs) => count + (cs.videos.a.src ? 1 : 0) + (cs.videos.b.src ? 1 : 0), 0),
      previewQuality: env.interactivePreviewEnabled ? 'fast' : 'full',
    };
    perf.frames = 0;
    perf.sceneMs = 0;
    perf.renderMs = 0;
    perf.textPaintMs = 0;
    perf.textPaints = 0;
    perf.textPaintSkips = 0;
    perf.shapePaintMs = 0;
    perf.shapePaints = 0;
    perf.shapePaintSkips = 0;
    perf.sequenceMs = 0;
    perf.sequenceRenders = 0;
    perf.lastSampleAt = afterRender;
  }

  // Motion templates that drew a video asked for frames this pass (the frame just
  // painted could only use what was already decoded). Kick the decode off here;
  // the repaint comes from the onMotionMediaFrame subscription above. The export
  // awaits its own pump instead, so it never enters this path.
  if (!engine.exporting && motionMediaPending() && !engine.mediaPump) {
    engine.mediaPump = true;
    pumpMotionMedia().finally(() => { engine.mediaPump = false; });
  }
  // Same contract for an animated image whose file is still decoding: the frame
  // just painted fell back to its still texture. Unlike the motion pump this
  // settles ONCE per file rather than per frame — after the decode every frame
  // of it is synchronous — so this drains to nothing instead of running for the
  // whole of playback.
  if (!engine.exporting && animatedImagePending() && !engine.gifPump) {
    engine.gifPump = true;
    pumpAnimatedImages().finally(() => { engine.gifPump = false; });
  }
}
