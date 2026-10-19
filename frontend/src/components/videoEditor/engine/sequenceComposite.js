/*
 * Sequences (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 23 — moved verbatim out of Player.jsx with
 * tests/engine-extraction/tools/stage9_step.py): compositeSequenceStack composites a sequence's own channels — their
 * Layer Masks, adjustment layers, Silhouette Framing, Backdrop Blur and Glass, effect chains and blends — into the
 * sequence's plate; renderSequenceFrame lays out and renders one sequence (or grid) frame.
 *
 * `env` carries the live editor values these read (`interactivePreviewEnabled`, `parentIndex`, `clipsMap`) and, until
 * it moves too, the Player's renderChannel; the Player memoizes each env over exactly the values the old callbacks
 * listed as dependencies.
 */
import * as THREE from 'three';
import { allItemEffects, effectIsLiveAt, getAdjustmentEffect, hasActiveLayerOverlayEffects } from '../adjustmentEffects';
import { isBackdropBlurLayer, resolveBackdropParams, shapePeakAlpha } from '../backdropBlur';
import { isShaderBlendMode } from '../blendModes';
import { applyAdjustmentUniforms, applyPremultipliedBlendMode } from '../clipShader';
import { isDepthScanEnabled } from '../depthScanLayer';
import { isFresnelRimEnabled } from '../fresnelRimLayer';
import { isGlassLayer } from '../glassEffect';
import { getItemKeyframeValues, itemHasKeyframes } from '../gsapTransitions';
import { isLayerMaskEnabled } from '../layerMask';
import { withFlatEffects } from '../model3dFxCatalog';
import { getCameraCoCRadius, getCameraDofSettings, resolveCameraPose } from '../projectCamera';
import { isCameraBaked3dPlate } from '../rig3d';
import { getTrackMatte } from '../trackMatte';
import { isGridClip, SEQUENCE_MAX_DEPTH } from '../types';
import { selectedBackend } from '../videoRenderer';
import { cameraForChannel, syncPosedCamera } from './camera';
import { drawPicturePlate } from './canvasHelpers';
import { ensureSequenceState as ensureSequenceStateInEngine } from './channelStates';
import { applyAdjustmentMask as applyAdjustmentMaskInEngine, applyShaderBlend as applyShaderBlendInEngine } from './compositeOps';
import { runEffectChain as runEffectChainInEngine, runLayerOverlayEffects as runLayerOverlayEffectsInEngine } from './effectChain';
import { buildGridCellPoses as buildGridCellPosesInEngine, updateGridGuide as updateGridGuideInEngine } from './gridMockup';
import { clamp01, maskSilhouetteFraming } from './layerHelpers';
import { applySilhouetteFraming as applySilhouetteFramingInEngine, plateToCameraAxis as plateToCameraAxisInEngine } from './layerPasses';
import { applyBackdropBlur as applyBackdropBlurInEngine, applyGlass as applyGlassInEngine, applyLayerMask as applyLayerMaskInEngine } from './layerStages';
import { computeLayerBox } from './layerWarps';
import { getImageTexture as getImageTextureInEngine } from './mediaTextures';
import { applyMeshTransform, resolveFollow as resolveFollowInEngine, resolveParenting as resolveParentingInEngine } from './meshTransform';
import { ensurePassTarget as ensurePassTargetInEngine } from './passPool';
import { ensureSequenceAdjTargets as ensureSequenceAdjTargetsInEngine } from './renderTargets';
import { CAMERA_FOV, _dofView, _dofWorld, getChannelsBottomToTop, isClipMaskItem, isUprightIsolatePlate, orderChannelsForComposite, resolveActiveIndex, resolveGlassLayer, resumeChannelBlend, suspendChannelBlend } from './compositeHelpers';

export function compositeSequenceStack(engine, env, st, seqChannels, localTime, cellPose = null, innerCamera = null, innerPosed = null) {
  const renderer = engine.renderer;
  // The container's own camera — widened when a grid overscans, so every pass
  // here frames exactly what the plain render would.
  const camera = innerCamera || engine.camera;
  // The sequence's OWN camera (a camera clip on its inner camera channel, see
  // renderSequenceFrame): it films every inner channel except a camera-locked one,
  // exactly as the project camera does at the top level — the same two-camera rule
  // (cameraForChannel), the same depth sort with locked channels as barriers, and
  // its depth of field per layer. Without one, `camFor` is the container camera.
  const posedInner = innerPosed?.camera || null;
  const camFor = (ch) => (posedInner ? cameraForChannel(ch, posedInner, camera) : camera);
  const innerDof = innerPosed?.pose ? getCameraDofSettings(innerPosed.pose, camera.position.z) : null;
  const dofScene = engine.cameraDofScene;
  const dofMaterial = engine.cameraDofMaterial;
  const orthoCamera = engine.orthoCamera;
  const clipScene = engine.adjustmentClipScene;
  const clipMesh = engine.adjustmentClipMesh;
  const blitScene = engine.blitScene;
  const blitMaterial = engine.blitMaterial;
  const seqPlateCopyScene = engine.seqPlateCopyScene || blitScene;
  const seqPlateCopyMaterial = engine.seqPlateCopyMaterial || blitMaterial;
  const maskScene = engine.maskScene;
  const maskMaterial = engine.maskMaterial;
  const overBlitScene = engine.overBlitScene;
  const overBlitMaterial = engine.overBlitMaterial;
  if (!renderer || !camera || !orthoCamera || !clipScene || !clipMesh || !blitScene || !blitMaterial || !maskScene || !maskMaterial || !overBlitScene || !overBlitMaterial) {
    return false;
  }

  const stackChannels = getChannelsBottomToTop(seqChannels);
  const adjustments = [];
  // Overlay Effects on a regular layer inside the sequence force this compositor
  // on for the same reason they do at top level: isolate the layer before styling it.
  const seqOverlayFx = new Map();
  // Layer Mask on a regular layer inside the sequence — same requirement, and
  // the reason a masked layer keeps its mask after being grouped (the Track
  // Matte parity gap this feature deliberately does not repeat).
  const seqLayerMask = new Map();
  // Backdrop Blur on a shape inside the sequence — blurs THIS level's stack.
  const seqBackdrop = new Map();
  const seqGlass = new Map();
  // Shader blend modes inside the sequence — read THIS level's stack.
  const seqShaderBlend = new Map();
  // Depth Scan / Fresnel Rim on a picture inside the sequence: the same stages
  // the top level runs (layerStackRef), on this level's isolate.
  const seqDepthStack = new Map();
  // Model / Rig layers on WebGPU: their isolate is upright from the start, and
  // drawn straight into the stack it lands upside down there — the isolate
  // branch below already reads it the right way up.
  const seqUpright = new Set();
  const uprightViaIsolate = selectedBackend() === 'webgpu';
  // Ordinary (non-adjustment, non-mask) layers active on this level right now —
  // the only ones a track matte can pair, exactly as at the top level.
  const seqLayerItems = new Map();
  for (const ch of stackChannels) {
    if (ch.visible === false) continue;
    const layout = st.layouts.get(ch.id);
    if (!layout) continue;
    const ai = resolveActiveIndex(layout, localTime);
    if (ai < 0) continue;
    const item = ch.items[ai];
    const clip = st.clipsMap.get(item?.clipId);
    if (clip?.mediaType === 'adjustment') {
      adjustments.push({ channelId: ch.id, item, entry: layout[ai], kind: 'adjust' });
    } else if (isClipMaskItem(clip, item)) {
      adjustments.push({ channelId: ch.id, item, entry: layout[ai], kind: 'mask' });
    } else {
      seqLayerItems.set(ch.id, item);
      if (isShaderBlendMode(item?.blendMode)) seqShaderBlend.set(ch.id, item.blendMode);
      if (!engine.preTransitionFxItemIds.has(item.id) && !isCameraBaked3dPlate(clip, item)) {
        const mt = clip?.mediaType;
        const depthScan = isDepthScanEnabled(item) ? { item, entry: layout[ai], clip } : null;
        const fresnelRim = (mt === 'image' || mt === 'video') && isFresnelRimEnabled(item, mt)
          ? { item, entry: layout[ai], clip } : null;
        if (depthScan || fresnelRim) seqDepthStack.set(ch.id, { depthScan, fresnelRim });
      }
      if (uprightViaIsolate && isUprightIsolatePlate(clip, item)) seqUpright.add(ch.id);
      const flatItem = withFlatEffects(item, clip);
      if (hasActiveLayerOverlayEffects(flatItem) && !engine.preTransitionFxItemIds.has(item.id)) {
        seqOverlayFx.set(ch.id, { item: flatItem, entry: layout[ai], clip });
      }
      if (isBackdropBlurLayer(item, clip) && !isCameraBaked3dPlate(clip, item)) {
        const dur = layout[ai].endTime - layout[ai].startTime;
        const progress = dur > 0 ? clamp01((localTime - layout[ai].startTime) / dur) : 0;
        const kf = itemHasKeyframes(item) ? getItemKeyframeValues(item, progress) : null;
        const params = resolveBackdropParams(item, kf);
        if (params.blurPx > 0) seqBackdrop.set(ch.id, { ...params, alphaRef: shapePeakAlpha(item) });
      }
      if (isGlassLayer(item, clip) && !isCameraBaked3dPlate(clip, item)) {
        const dur = layout[ai].endTime - layout[ai].startTime;
        const progress = dur > 0 ? clamp01((localTime - layout[ai].startTime) / dur) : 0;
        const kf = itemHasKeyframes(item) ? getItemKeyframeValues(item, progress) : null;
        const { w: compW, h: compH } = engine.videoSize;
        seqGlass.set(ch.id, resolveGlassLayer(item, kf, compW, compH));
      }
      if (isLayerMaskEnabled(item) && !isCameraBaked3dPlate(clip, item)
        && !engine.preTransitionFxItemIds.has(item.id)) {
        seqLayerMask.set(ch.id, { item, entry: layout[ai], clip });
      }
    }
  }

  // Track matte inside the sequence. Same contract as the top level, resolved
  // against THIS level's items: the pairing is by item id, the source is live
  // only while it is the item actually active on its own channel, and a source
  // consumed by anyone is hidden from the inner composite.
  const seqMatte = new Map();
  const seqMatteSources = new Set();
  if (seqLayerItems.size > 1) {
    const channelOfItem = new Map();
    for (const [chId, it] of seqLayerItems) if (it?.id) channelOfItem.set(it.id, chId);
    for (const [chId, it] of seqLayerItems) {
      const matte = getTrackMatte(it);
      if (!matte) continue;
      const srcChannelId = channelOfItem.get(matte.sourceId) || null;
      const live = srcChannelId && srcChannelId !== chId ? srcChannelId : null;
      seqMatte.set(chId, { mode: matte.mode, sourceChannelId: live });
      if (live) seqMatteSources.add(live);
    }
  }

  if (adjustments.length === 0 && seqOverlayFx.size === 0 && seqMatte.size === 0
    && seqLayerMask.size === 0 && seqBackdrop.size === 0 && seqGlass.size === 0 && seqShaderBlend.size === 0
    && seqDepthStack.size === 0 && seqUpright.size === 0 && !posedInner) return false;
  const chById = new Map(stackChannels.map((c) => [c.id, c]));

  const { w: W, h: H } = engine.videoSize;
  const sizeVec = renderer.getDrawingBufferSize(new THREE.Vector2());
  const rt = ensureSequenceAdjTargetsInEngine(engine, sizeVec.x, sizeVec.y);
  let read = rt.a;
  let write = rt.b;
  const adjById = new Map();
  for (const a of adjustments) adjById.set(a.channelId, a);

  renderer.setRenderTarget(read);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);

  // Matte source isolates, before the stack accumulates (rt.c is the isolate
  // scratch inside the loop). A source carries its own Overlay Effects chain —
  // an Extract key on the matte layer IS the matte — mirroring the top level.
  // Keyed per channel: two instances of one sequence in a frame composite one
  // after the other, so the target is finished with before it is rewritten.
  const seqMatteIsolates = new Map();
  for (const srcChannelId of seqMatteSources) {
    let target = null;
    const srcCs = st.channelStates.get(srcChannelId);
    if (srcCs && srcCs.group.visible !== false) {
      target = ensurePassTargetInEngine(engine, `seqTrackMatte:${srcChannelId}`, rt.a.width, rt.a.height, false);
      if (target) {
        const srcFx = seqOverlayFx.get(srcChannelId) || null;
        renderer.setRenderTarget(srcFx ? rt.c : target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        suspendChannelBlend(srcCs);
        renderer.render(srcCs.group, camFor(chById.get(srcChannelId)));
        resumeChannelBlend(srcCs);
        if (srcFx) {
          const srcMesh = srcCs.currMesh?.visible ? srcCs.currMesh : (srcCs.prevMesh?.visible ? srcCs.prevMesh : null);
          const styled = runLayerOverlayEffectsInEngine(engine, env, rt.c, rt.c, srcFx, localTime, srcMesh, camFor(chById.get(srcChannelId)));
          blitMaterial.uniforms.uTexture.value = styled.texture;
          renderer.setRenderTarget(target);
          renderer.setClearColor(0x000000, 0);
          renderer.clear(true, true, true);
          renderer.render(blitScene, orthoCamera);
        }
      }
    }
    seqMatteIsolates.set(srcChannelId, target);
  }

  // Copy Color Profile inside the sequence: pre-render every layer referenced
  // by a chain on THIS level, mirroring the top-level pre-pass. Plates join the
  // same item-keyed map (sequence-internal ids never collide with top-level
  // ones); nothing is cleared here, the top level owns the map's lifetime.
  const seqRefConsumed = new Set();
  for (const [chId, it] of seqLayerItems) {
    for (const eff of allItemEffects(it)) {
      if (!effectIsLiveAt(eff, {}, it)) continue;
      const refDef = getAdjustmentEffect(eff.id);
      const key = refDef?.usesLayerRef;
      const srcId = key ? eff.params?.[key] : null;
      if (typeof srcId !== 'string' || !srcId || srcId === it.id) continue;
      let srcChId = null;
      if (refDef.layerRefMode !== 'picture') {
        for (const [otherChId, other] of seqLayerItems) if (other?.id === srcId) { srcChId = otherChId; break; }
      }
      // Live-only effects (Double Exposure) bypass instead of falling back.
      if ((!srcChId || srcChId === chId) && refDef.layerRefMode === 'live') continue;
      if (!srcChId || srcChId === chId) {
        // Not live on this level: the clip's picture, as at the top level.
        let srcItem = null;
        for (const sch of seqChannels) for (const other of sch?.items || []) if (other?.id === srcId) srcItem = other;
        const srcClip = srcItem ? st.clipsMap.get(srcItem.clipId) : null;
        const url = srcClip?.mediaType === 'image' ? srcClip.url
          : (srcClip?.mediaType === 'video' ? srcClip.thumbnailUrl : null);
        const tex = url ? getImageTextureInEngine(engine, url, () => engine.renderFrame()) : null;
        if (!tex?.image) continue;
        const target = ensurePassTargetInEngine(engine, `seqColorRef:item:${srcId}`, rt.a.width, rt.a.height, false);
        if (!drawPicturePlate(renderer, orthoCamera, engine.pictureCopyMaterial, engine.pictureCopyScene, tex, target)) continue;
        engine.colorRefPlates.set(srcId, { texture: target.texture, box: null, isStatic: true });
        continue;
      }
      if (refDef.consumesLayerRef) seqRefConsumed.add(srcChId);
      const srcCs = st.channelStates.get(srcChId);
      if (!srcCs || srcCs.group.visible === false) continue;
      const target = ensurePassTargetInEngine(engine, `seqColorRef:${srcChId}`, rt.a.width, rt.a.height, false);
      if (!target) continue;
      renderer.setRenderTarget(rt.c);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(srcCs.group, camera);
      const srcMesh = srcCs.currMesh?.visible ? srcCs.currMesh : (srcCs.prevMesh?.visible ? srcCs.prevMesh : null);
      const srcFx = seqOverlayFx.get(srcChId) || null;
      const styled = srcFx ? runLayerOverlayEffectsInEngine(engine, env, rt.c, rt.c, srcFx, localTime, srcMesh, camera) : rt.c;
      blitMaterial.uniforms.uTexture.value = styled.texture;
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(blitScene, orthoCamera);
      engine.colorRefPlates.set(srcId, {
        texture: target.texture,
        box: srcMesh ? computeLayerBox(srcMesh, camera, rt.a.width, rt.a.height) : null,
      });
    }
  }

  const mat = clipMesh.material;
  // A sequence's inner stack sorts by depth too, on the same rules as the top level —
  // otherwise Z would mean one thing outside a sequence and another inside it. Depth
  // is measured through the camera that films the channel (its own camera, when the
  // sequence has one; camera-locked channels are barriers in the order either way).
  const seqDepthOf = (ch) => {
    const cs = st.channelStates.get(ch.id);
    const mesh = cs?.currMesh?.visible ? cs.currMesh : cs?.prevMesh;
    if (!mesh?.visible) return 0;
    const cam = camFor(ch);
    mesh.updateWorldMatrix(true, false);
    cam.updateMatrixWorld();
    return -_dofView.copy(mesh.getWorldPosition(_dofWorld)).applyMatrix4(cam.matrixWorldInverse).z;
  };
  for (const ch of orderChannelsForComposite(stackChannels, adjById, seqDepthOf)) {
    const cs = st.channelStates.get(ch.id);
    if (!cs) continue;
    // A consumed matte source never draws itself — its pixels only feed the
    // consumers' matte pass, exactly as at the top level.
    if (seqMatteSources.has(ch.id)) continue;
    if (seqRefConsumed.has(ch.id)) continue;
    const adj = adjById.get(ch.id);
    if (adj && adj.kind === 'mask') {
      if (cs.group.visible !== false) {
        renderer.setRenderTarget(rt.c);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.render(cs.group, camFor(ch));
        maskMaterial.uniforms.uTexture.value = read.texture;
        maskMaterial.uniforms.uMask.value = rt.c.texture;
        maskMaterial.uniforms.uInvert.value = adj.item?.clipMaskInvert ? 1 : 0;
        renderer.setRenderTarget(write);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.render(maskScene, orthoCamera);
        const tmp = read; read = write; write = tmp;
      }
    } else if (adj) {
      const { item, entry } = adj;
      const duration = entry.endTime - entry.startTime;
      const progress = duration > 0 ? Math.max(0, Math.min(1, (localTime - entry.startTime) / duration)) : 0;
      const kf = getItemKeyframeValues(item, progress);
      // Adjustment Mask: capture the UNGRADED composite before the grade —
      // mirrors the top-level compositor (a masked adjustment must survive
      // grouping, the Track Matte parity gap this feature does not repeat).
      let adjMaskSrc = null;
      if (isLayerMaskEnabled(item)) {
        adjMaskSrc = ensurePassTargetInEngine(engine, `adjMask:${read.width}x${read.height}`, read.width, read.height, false);
        if (adjMaskSrc) {
          blitMaterial.uniforms.uTexture.value = read.texture;
          renderer.setRenderTarget(adjMaskSrc);
          renderer.setClearColor(0x000000, 0);
          renderer.clear(true, true, true);
          renderer.render(blitScene, orthoCamera);
        }
      }
      mat.uniforms.uTexture.value = read.texture;
      applyAdjustmentUniforms(mat, item, kf, sizeVec.x, sizeVec.y, { reducedMotionPreview: env.interactivePreviewEnabled });
      // An adjustment layer INSIDE a grid is a cell like any other; its quad
      // must be posed by the layout, not by ordinary parenting, or the grid
      // collapses to the frame centre the moment a member carries one.
      applyMeshTransform(clipMesh, item, kf, W, H,
        (cellPose ? cellPose(ch, item) : null) || resolveParentingInEngine(engine, st.parentIndex, item, localTime),
        null, resolveFollowInEngine(engine, st.parentIndex, item, localTime));
      renderer.setRenderTarget(write);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(clipScene, camera);
      let tmp = read; read = write; write = tmp;
      // GPU effect chain + item-level LUT on the graded result (screen-space,
      // same ping-pong pair; rt.c doubles as the scratch for two-pass effects —
      // its mask use above is transient, nothing persists across channels).
      if (item?.effects?.length || item?.lut) {
        const res = runEffectChainInEngine(engine, env, item, kf, {
          read,
          write,
          scratch: rt.c,
          pyramid: [rt.c, rt.d, rt.e, rt.f],
          time: localTime - entry.startTime,
          progress,
          duration,
        });
        read = res.read; write = res.write;
      }
      // Mix the finished graded result back toward the ungraded capture by
      // mask coverage — clipMesh still carries this item's pose from
      // applyMeshTransform above, filmed by this stack's `camera`.
      if (adjMaskSrc && applyAdjustmentMaskInEngine(engine, read, adjMaskSrc, write, { item, entry }, clipMesh, camera, localTime, 1)) {
        tmp = read; read = write; write = tmp;
      }
    } else {
      if (cs.group.visible === false) continue;
      const fx = seqOverlayFx.get(ch.id) || null;
      const lm = seqLayerMask.get(ch.id) || null;
      // An EMPTY matte (source clip not under the playhead) is AE semantics:
      // alpha/luma hide the consumer outright, inverted modes leave it alone.
      const matte = seqMatte.get(ch.id) || null;
      const matteInverted = !!matte && (matte.mode === 'alphaInverted' || matte.mode === 'lumaInverted');
      if (matte && !matte.sourceChannelId && !matteInverted) continue;
      const activeMatte = matte && matte.sourceChannelId ? matte : null;
      const bd = seqBackdrop.get(ch.id) || null;
      const seqGl = seqGlass.get(ch.id) || null;
      const sb = seqShaderBlend.get(ch.id) || null;
      const chCam = camFor(ch);
      // The sequence camera's depth of field: this layer's circle of confusion, measured
      // along the camera's axis exactly as cocForChannel does at the top level.
      let coc = 0;
      if (innerDof?.enabled && innerDof.aperture > 0 && innerDof.blurLevel > 0 && dofScene && dofMaterial
        && chCam === posedInner) {
        const mesh = cs.currMesh?.visible ? cs.currMesh : (cs.prevMesh?.visible ? cs.prevMesh : null);
        if (mesh) {
          mesh.updateWorldMatrix(true, false);
          chCam.updateMatrixWorld();
          const viewZ = -_dofView.copy(mesh.getWorldPosition(_dofWorld)).applyMatrix4(chCam.matrixWorldInverse).z;
          coc = getCameraCoCRadius(innerDof, Math.max(1, viewZ));
        }
      }
      const defocused = coc >= 0.25;
      const depthStack = seqDepthStack.get(ch.id) || null;
      if (!fx && !activeMatte && !lm && !sb && !defocused && !depthStack && !seqUpright.has(ch.id)) {
        if (bd) {
          // Same as the top level: the plain isolate is the window.
          renderer.setRenderTarget(rt.c);
          renderer.setClearColor(0x000000, 0);
          renderer.clear(true, true, true);
          renderer.render(cs.group, chCam);
          if (applyBackdropBlurInEngine(engine, read, write, rt.c, false, bd, W)) {
            const tmp = read; read = write; write = tmp;
          }
        }
        if (seqGl && applyGlassInEngine(engine, read, write, seqGl, cs, cs.group, chCam, W)) {
          const tmp = read; read = write; write = tmp;
        }
        renderer.setRenderTarget(read);
        renderer.render(cs.group, chCam);
      } else {
        // Same isolate → chain → matte → over-blit as the top-level compositor, so a
        // layer inside a sequence behaves identically to one outside it. rt.c is the
        // isolate and the matte; the mask branch's use of it above is transient.
        renderer.setRenderTarget(rt.c);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        // Hardware blend suspended for the isolate, as at the top level.
        suspendChannelBlend(cs);
        renderer.render(cs.group, chCam);
        const seqMesh = cs.currMesh?.visible ? cs.currMesh : (cs.prevMesh?.visible ? cs.prevMesh : null);
        let out = rt.c;
        // The mask cuts the isolate FIRST, in place — so the chain's matte and
        // the track matte both see the masked silhouette, exactly as at the
        // top level. `camera` (not engine.camera): inner channels are
        // deliberately reparented out of the camera rig, and a grid overscan
        // widens it further, so this is the only camera the isolate was
        // actually rendered with. ss is 1 — this bank is never supersampled.
        // V-axis provenance, as in renderStyledLayerIsolate: the isolate is
        // camera-axis until a pass rewrites it through an ortho quad (the mask
        // and the chain both do). The matte pass and the overBlit read it
        // differently under WebGPU depending on which it still is. A model / Rig
        // isolate is upright from the start (isUprightIsolatePlate).
        const uprightIsolate = isUprightIsolatePlate(st.clipsMap.get(seqLayerItems.get(ch.id)?.clipId), seqLayerItems.get(ch.id));
        let outCameraAxis = !uprightIsolate;
        if (lm && seqMesh && applyLayerMaskInEngine(engine, rt.c, lm, seqMesh, chCam, localTime, 1)) outCameraAxis = false;
        // Border and shadows along the masked shape (maskSilhouetteFraming).
        if (lm && seqMesh && maskSilhouetteFraming(lm.item, lm.clip)
          && applySilhouetteFramingInEngine(engine, rt.c, lm, seqMesh, localTime, outCameraAxis)) outCameraAxis = false;
        // The sequence camera's defocus, on the camera-axis isolate (as at the top level:
        // before the chain, so the chain restyles the defocused layer). The pass writes
        // a finished quad plate into rt.d; rt.c stays the layer's matte.
        // A model / Rig isolate is upright but still untouched here (no mask on a
        // camera-baked plate), so it is re-stored camera-axis for the DOF read,
        // exactly as the top level does with plateToCameraAxis.
        const rtcCamAxis = outCameraAxis;
        if (defocused && (outCameraAxis || uprightIsolate) && rt.d) {
          dofMaterial.uniforms.uTexture.value = (outCameraAxis ? rt.c : plateToCameraAxisInEngine(engine, rt.c)).texture;
          dofMaterial.uniforms.uResolution.value.set(rt.d.width, rt.d.height);
          dofMaterial.uniforms.uRadiusPx.value = Math.min(64, coc);
          dofMaterial.uniforms.uHighlightGain.value = innerDof.highlightGain / 100;
          dofMaterial.uniforms.uSamples.value = env.interactivePreviewEnabled ? 24 : 40;
          dofMaterial.uniforms.uFocusPointPx.value.set((innerDof.focusX / 100) * rt.d.width, (1 - innerDof.focusY / 100) * rt.d.height);
          const focusOuterPx = (innerDof.focusWidth / 100) * rt.d.width;
          dofMaterial.uniforms.uFocusOuterPx.value = focusOuterPx;
          dofMaterial.uniforms.uFocusInnerPx.value = focusOuterPx * 0.5;
          renderer.setRenderTarget(rt.d);
          renderer.setClearColor(0x000000, 0);
          renderer.clear(true, true, true);
          renderer.render(dofScene, orthoCamera);
          out = rt.d;
          outCameraAxis = false;
        }
        // Depth Scan → Fresnel Rim, before the chain — the top level's order. A
        // stage that hands back a different target wrote it through an ortho
        // quad; `flipPlate` lets it normalise a camera-axis isolate in place.
        const depthStages = engine.layerStack;
        if (depthStack && depthStages && seqMesh) {
          for (const [key, stageEntry] of [['depthScan', depthStack.depthScan], ['fresnelRim', depthStack.fresnelRim]]) {
            if (!stageEntry || !depthStages[key]) continue;
            const flipPlate = out === rt.c && outCameraAxis;
            const next = depthStages[key](out, stageEntry, seqMesh, chCam, localTime, flipPlate);
            if (next && next !== out) { out = next; outCameraAxis = false; }
          }
        }
        if (fx) {
          const styled = runLayerOverlayEffectsInEngine(engine, env, out, rt.c, fx, localTime, seqMesh, chCam,
            { srcCamAxis: outCameraAxis, matteCamAxis: rtcCamAxis });
          if (styled !== out) outCameraAxis = false;
          out = styled;
        }
        // Track matte is the last word here too: it clips the FINISHED layer.
        if (activeMatte) {
          const srcTarget = seqMatteIsolates.get(activeMatte.sourceChannelId) || null;
          // The matte isolate is always camera-axis; pick the variant whose
          // consumer read matches `out`'s provenance (createTrackMatteNodeMaterial).
          const tmScene = outCameraAxis ? engine.trackMattePlainScene : engine.trackMatteScene;
          const tmMat = outCameraAxis ? engine.trackMattePlainMaterial : engine.trackMatteMaterial;
          if (srcTarget && tmScene && tmMat) {
            const dest = out === rt.c ? rt.d : rt.c;
            tmMat.uniforms.uTexture.value = out.texture;
            tmMat.uniforms.uMatte.value = srcTarget.texture;
            tmMat.uniforms.uLuma.value = activeMatte.mode === 'luma' || activeMatte.mode === 'lumaInverted' ? 1 : 0;
            tmMat.uniforms.uInvert.value = matteInverted ? 1 : 0;
            renderer.setRenderTarget(dest);
            renderer.setClearColor(0x000000, 0);
            renderer.clear(true, true, true);
            renderer.render(tmScene, orthoCamera);
            out = dest;
            // Either variant writes a finished quad plate.
            outCameraAxis = false;
          }
        }
        // overBlit(uv()) is the wrong read of a camera-axis isolate under WebGPU
        // (the top level's "static frame, exact bypass" case). Reachable here when
        // the mask bypassed (edge-on box) and nothing else rewrote the plate: copy
        // through the plain blit so provenance matches a finished quad plate.
        if (outCameraAxis && out === rt.c && rt.d) {
          blitMaterial.uniforms.uTexture.value = out.texture;
          renderer.setRenderTarget(rt.d);
          renderer.setClearColor(0x000000, 0);
          renderer.clear(true, true, true);
          renderer.render(blitScene, orthoCamera);
          out = rt.d;
          // The copy IS the provenance change: from here `out` reads like
          // every other finished quad plate. Left camera-axis, the blend
          // pass read a sequence's shader-blend plate upside down on WebGPU
          // (measured: tests/blend-composite/verify_still.mjs S7).
          outCameraAxis = false;
        }
        if (bd && applyBackdropBlurInEngine(engine, read, write, out, !outCameraAxis, bd, W)) {
          const tmp = read; read = write; write = tmp;
        }
        const seqGlMatteSrc = seqGl && activeMatte ? seqMatteIsolates.get(activeMatte.sourceChannelId) : null;
        const seqGlMatte = seqGlMatteSrc ? {
          texture: seqGlMatteSrc.texture,
          luma: activeMatte.mode === 'luma' || activeMatte.mode === 'lumaInverted',
          invert: matteInverted,
        } : null;
        if (seqGl && applyGlassInEngine(engine, read, write, seqGl, cs, cs.group, chCam, W, seqGlMatte, lm?.item)) {
          const tmp = read; read = write; write = tmp;
        }
        if (sb && applyShaderBlendInEngine(engine, read, write, out, !outCameraAxis, sb)) {
          const tmp = read; read = write; write = tmp;
        } else {
          applyPremultipliedBlendMode(overBlitMaterial, (fx?.item || lm?.item || seqLayerItems.get(ch.id))?.blendMode);
          overBlitMaterial.uniforms.uTexture.value = out.texture;
          renderer.setRenderTarget(read);
          renderer.render(overBlitScene, orthoCamera);
          applyPremultipliedBlendMode(overBlitMaterial, 'normal');
        }
        resumeChannelBlend(cs);
      }
    }
  }

  // The grid's authoring guide lives in st.scene, which this compositor never
  // renders whole — give it its own pass on top of the finished stack.
  if (st.gridGuide?.visible) {
    renderer.setRenderTarget(read);
    renderer.render(st.gridGuide, camera);
  }

  // Copy the composited stack into the sequence's own RT (NoBlending blit
  // preserves the stack's alpha so the sequence still layers like a clip).
  //
  // V axis: the plain path (`renderer.render(st.scene, innerCamera)` into
  // st.rt) lands the plate camera-axis in ONE hop and the clip material's
  // uInputFlipV is calibrated for exactly that. `read` is camera-axis too, but
  // a plain-uv blit re-stores it on the opposite axis under WebGPU — every
  // composited sequence (an effect, a mask, a matte on a grouped layer) came out
  // upside down while a plain group was fine. The storage-identity copy keeps
  // the plain path's layout. Grids are exempt from uInputFlipV and keep the
  // plain blit, byte-for-byte as before.
  const identityCopy = !cellPose && selectedBackend() === 'webgpu';
  const copyMaterial = identityCopy ? seqPlateCopyMaterial : blitMaterial;
  copyMaterial.uniforms.uTexture.value = read.texture;
  renderer.setRenderTarget(st.rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(identityCopy ? seqPlateCopyScene : blitScene, orthoCamera);
  return true;
}

export function renderSequenceFrame(engine, env, seqClip, item, localTime, depth, rateScale, absoluteTime = 0, levelParentIndex = null, parentXform = null, cameraPose = null, baseCamera = null, scopeKey = null) {
  if (depth > SEQUENCE_MAX_DEPTH || !seqClip?.sequence) return null;
  const renderer = engine.renderer;
  const camera = engine.camera;
  if (!renderer || !camera) return null;
  const st = ensureSequenceStateInEngine(engine, item.id, seqClip);
  if (!st) return null;
  // Top-level containers only, so a nested sequence is not counted twice.
  const seqT0 = depth === 1 ? performance.now() : 0;
  st._frameStamp = engine.sequenceFrameStamp;
  const grid = isGridClip(seqClip)
    ? buildGridCellPosesInEngine(engine, seqClip, item, localTime, absoluteTime, levelParentIndex, parentXform, cameraPose, baseCamera || camera)
    : null;
  const cellPoses = grid?.poses || null;
  const cellPose = cellPoses ? (channel) => cellPoses.get(channel?.id) || null : null;
  updateGridGuideInEngine(engine, st, grid?.guide || null);
  let innerCamera = camera;
  if (grid?.innerCam) {
    // The composition's own camera, moved into the grid's space — the cells
    // are filmed as real 3D objects (see buildGridCellPoses). The scale is
    // the grid's inverse zoom: a scaled camera magnifies the world exactly
    // as scaling the arrangement would.
    if (!st.wideCamera) st.wideCamera = new THREE.PerspectiveCamera(CAMERA_FOV, camera.aspect, camera.near, camera.far);
    const wide = st.wideCamera;
    wide.aspect = camera.aspect;
    wide.near = camera.near;
    wide.far = camera.far;
    wide.fov = grid.innerCam.fov;
    wide.position.copy(grid.innerCam.position);
    wide.quaternion.copy(grid.innerCam.quaternion);
    wide.scale.copy(grid.innerCam.scale);
    wide.updateProjectionMatrix();
    wide.updateMatrixWorld();
    innerCamera = wide;
  }
  // The sequence's own camera: a camera clip on its inner camera channel films the
  // inner timeline (its move, its depth of field) the way the project camera films the
  // top level — so a sequence plays back, exports and prerenders the same. Grids keep
  // their layout camera.
  let innerPosed = null;
  if (!grid) {
    const { w: vw, h: vh } = engine.videoSize;
    const innerPose = resolveCameraPose(seqClip.sequence.channels, st.clipsMap, (ch) => st.layouts.get(ch.id), localTime, { width: vw, height: vh });
    if (innerPose) {
      if (!st.posedCamera) st.posedCamera = new THREE.PerspectiveCamera(CAMERA_FOV, camera.aspect, camera.near, camera.far);
      syncPosedCamera(st.posedCamera, camera, innerPose, vw, vh);
      innerPosed = { camera: st.posedCamera, pose: innerPose };
    }
  }
  const ctx = {
    channelStates: st.channelStates,
    clipsMap: st.clipsMap,
    layoutFor: (ch) => st.layouts.get(ch.id),
    parentIndex: st.parentIndex,
    depth,
    rateScale,
    // Identifies this editing level for per-item runtimes (see resolveParticleTexture).
    scopeKey,
    // Grid only. Present ⇒ this channel's item is a CELL: the layout supplies
    // its whole transform and its own stored PRS is ignored (never rewritten,
    // which is what makes Ungroup restore it for free).
    cellPose,
  };
  for (const ch of seqClip.sequence.channels) env.renderChannel(ch, localTime, ctx);
  if (engine.rcMediaOnly) return st.rt.texture; // render cache frame: media only
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  // Shape clipping masks / adjustment layers on the container's inner channels
  // need the same multi-pass compositing the top level gets — a plain scene
  // render would draw the shape's fill instead of masking the layers below it.
  if (!compositeSequenceStack(engine, env, st, seqClip.sequence.channels, localTime, cellPose, innerCamera, innerPosed)) {
    renderer.setRenderTarget(st.rt);
    renderer.setClearColor(0x000000, 0); // transparent — composites like a layer with alpha
    renderer.clear(true, true, true);
    renderer.render(st.scene, innerCamera);
  }
  renderer.setRenderTarget(prevTarget || null);
  renderer.autoClear = prevAutoClear;
  if (seqT0) {
    engine.perfStats.sequenceRenders += 1;
    engine.perfStats.sequenceMs += performance.now() - seqT0;
  }
  return st.rt.texture;
}
