/*
 * Adjustment layers and the per-layer stack (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 24 — moved verbatim
 * out of Player.jsx with tests/engine-extraction/tools/stage9_step.py): renderAdjustmentComposite draws a channel stack
 * layer by layer — each layer isolated, through its passes (Rig, Layer Mask, Chroma Key, warps, Motion Blur, trails,
 * glow, Mockup Frame, its effect chain), then Backdrop Blur / Glass, blends and adjustment layers over what is below;
 * setLayerDepthMode switches the layers' depth cut for 3D compositing.
 *
 * `env` carries the live editor values these read (`channels`, `clipsMap`, `interactivePreviewEnabled`,
 * `parentIndex`); the Player memoizes it over exactly the values the old callback listed as dependencies.
 */
import * as THREE from 'three';
import { applyAdjustmentUniforms, applyPremultipliedBlendMode } from '../clipShader';
import { layerPlane, layerSortDepth } from '../compositeSortDepth';
import { getItemKeyframeValues, getItemPeakKeyframeScale } from '../gsapTransitions';
import { isLayerMaskEnabled } from '../layerMask';
import { buildMockupDevice, layoutMockupFrame, mockupSeatTransform } from '../mockupFrame';
import { getCameraCoCRadius, getCameraDofSettings } from '../projectCamera';
import { isCameraBaked3dPlate } from '../rig3d';
import { hasVisibleTransitionPackageInstances } from '../transitionPackageRuntime';
import { selectedBackend } from '../videoRenderer';
import { cameraForChannel } from './camera';
import { _dofView, _dofWorld, getChannelsBottomToTop, isUprightIsolatePlate, orderChannelsForComposite, resumeChannelBlend, suspendChannelBlend } from './compositeHelpers';
import { applyAdjustmentMask as applyAdjustmentMaskInEngine, applyShaderBlend as applyShaderBlendInEngine, ensurePictureRefPlate as ensurePictureRefPlateInEngine } from './compositeOps';
import { runEffectChain as runEffectChainInEngine, runLayerOverlayEffects as runLayerOverlayEffectsInEngine } from './effectChain';
import { resolveMockupStageParams as resolveMockupStageParamsInEngine } from './gridMockup';
import { maskSilhouetteFraming } from './layerHelpers';
import { applyChromaKey as applyChromaKeyInEngine, applySilhouetteFraming as applySilhouetteFramingInEngine, plateToCameraAxis as plateToCameraAxisInEngine, renderLayerAutoFill as renderLayerAutoFillInEngine, renderLayerDepthScan as renderLayerDepthScanInEngine, renderLayerFresnelRim as renderLayerFresnelRimInEngine } from './layerPasses';
import { applyBackdropBlur as applyBackdropBlurInEngine, applyGlass as applyGlassInEngine, applyLayerMask as applyLayerMaskInEngine, renderLayerRig as renderLayerRigInEngine, runLayerGeometryStages as runLayerGeometryStagesInEngine } from './layerStages';
import { computeLayerBox, layerPlaneBox } from './layerWarps';
import { applyMeshTransform, resolveFollow as resolveFollowInEngine, resolveParenting as resolveParentingInEngine } from './meshTransform';
import { measureMotionBlur as measureMotionBlurInEngine, renderLayerAccumBlur as renderLayerAccumBlurInEngine, renderLayerGlow as renderLayerGlowInEngine, renderLayerMotionBlur as renderLayerMotionBlurInEngine, renderLayerTrail as renderLayerTrailInEngine } from './motionPasses';
import { ensurePassTarget as ensurePassTargetInEngine } from './passPool';
import { ensureAdjustmentTargets as ensureAdjustmentTargetsInEngine, ensureDepthProbeTarget as ensureDepthProbeTargetInEngine } from './renderTargets';
import { _platePos, seatLayerMesh, unseatLayerMesh } from './compositeHelpers';

export function setLayerDepthMode(engine, on) {
  if (engine.layerDepthMode === on) return;
  engine.layerDepthMode = on;
  const apply = (cs) => {
    for (const mat of [cs.currMaterial, cs.prevMaterial]) {
      if (!mat?.uniforms?.uDepthCut) continue;
      mat.uniforms.uDepthCut.value = on ? 1 : 0;
      mat.depthTest = on;
      mat.depthWrite = on;
    }
  };
  for (const cs of engine.channelStates.values()) apply(cs);
  for (const st of engine.sequenceStates.values()) {
    for (const cs of st.channelStates.values()) apply(cs);
  }
}

export function renderAdjustmentComposite(engine, env, adjustments) {
  const renderer = engine.renderer;
  const camera = engine.camera;
  const orthoCamera = engine.orthoCamera;
  const clipScene = engine.adjustmentClipScene;
  const clipMesh = engine.adjustmentClipMesh;
  const blitScene = engine.blitScene;
  const blitMaterial = engine.blitMaterial;
  const maskScene = engine.maskScene;
  const maskMaterial = engine.maskMaterial;
  const dofScene = engine.cameraDofScene;
  const dofMaterial = engine.cameraDofMaterial;
  const overBlitScene = engine.overBlitScene;
  const overBlitMaterial = engine.overBlitMaterial;
  if (!renderer || !camera || !orthoCamera || !clipScene || !clipMesh || !blitScene || !blitMaterial || !maskScene || !maskMaterial || !dofScene || !dofMaterial || !overBlitScene || !overBlitMaterial) {
    return false;
  }

  const { w: W, h: H } = engine.videoSize;
  const sizeVec = renderer.getDrawingBufferSize(new THREE.Vector2());

  // Supersample the adjustment chain when a zoom (scale > 1) is active. The
  // compositor renders the below-stack into an offscreen target and then magnifies
  // THAT target — so at the drawing-buffer size a 4K source recording is first
  // downscaled to the (e.g. 1080p) canvas and only THEN zoomed, throwing away the
  // detail the zoom needs (the "blurry zoom" bug). Rendering the chain at zoom× the
  // canvas keeps source detail in the magnified region; the final blit downsamples
  // back to the canvas. The factor is the layer's peak zoom, capped to bound GPU
  // memory / stay within the max texture size, and held at 1 during interactive
  // playback to keep it smooth (it engages when paused and during export).
  const hasColorAdjustment = adjustments.some((a) => a.kind === 'adjust');
  let peakZoom = 1;
  for (const a of adjustments) {
    if (a.kind !== 'adjust') continue;
    peakZoom = Math.max(peakZoom, getItemPeakKeyframeScale(a.item));
  }
  // A regular-layer Overlay Effects chain holds the factor at 1: it needs its own bank of full-size
  // targets, and supersampling them would quadruple that memory for a feature the
  // zoom-detail argument above doesn't apply to (nothing magnifies a layer plate).
  // Track matte joins the overlay-fx reasoning: its keyed source isolates are
  // full-size targets, and supersampling them would multiply that memory.
  // Layer Mask joins it too, for the same reason plus its own: the coverage
  // plate is sized from box.sizePx, which carries `ss`, so supersampling
  // quadruples the raster the mask uploads on every geometry change.
  const ssMax = env.interactivePreviewEnabled || !hasColorAdjustment || engine.overlayFx.size > 0
    || engine.trackMatteLayers.size > 0 || engine.layerMaskLayers.size > 0
    || engine.backdropLayers.size > 0 || engine.glassLayers.size > 0
    || adjustments.some((a) => a.kind === 'adjust' && isLayerMaskEnabled(a.item)) ? 1 : 2;
  let ss = Math.min(ssMax, Math.max(1, peakZoom));
  const longEdge = Math.max(sizeVec.x, sizeVec.y);
  const longEdgeCap = Math.min(3840, renderer.capabilities?.maxTextureSize || 8192);
  if (longEdge * ss > longEdgeCap) ss = Math.max(1, longEdgeCap / longEdge);
  const rt = ensureAdjustmentTargetsInEngine(engine, sizeVec.x * ss, sizeVec.y * ss);
  let read = rt.a;
  let write = rt.b;
  const dof = getCameraDofSettings(engine.cameraPose, camera.position.z);

  const adjById = new Map();
  for (const a of adjustments) adjById.set(a.channelId, a);

  const channelById = new Map();
  for (const ch of env.channels) channelById.set(ch.id, ch);
  // A model / cyclorama pass has already been filmed through the project camera
  // before it reaches the compositor as a full-frame texture. Real-3D grids do the
  // same with their inner scene. Their identity plates must therefore use the
  // neutral composition camera here; ordinary layers still use their channel's
  // posed or locked camera exactly as before.
  const cameraForCompositePlate = (channel, cs) => {
    const item = engine.layerItems.get(channel.id);
    const clip = env.clipsMap.get(item?.clipId);
    const gridPlate = !!(cs?.currMesh?.visible && cs.currMesh.userData?.gridWorldPos)
      || !!(cs?.prevMesh?.visible && cs.prevMesh.userData?.gridWorldPos);
    return gridPlate || isCameraBaked3dPlate(clip, item)
      ? camera
      : cameraForChannel(channel, engine.posedCamera, camera);
  };
  // View-space distance of a channel's active layer, measured through the camera that
  // actually films it. A model reports the real distance of its geometry (its plane is
  // a neutral quad and would read as z = 0); everything else uses layerSortDepth.
  const depthOfChannel = (channel) => {
    const cs = engine.channelStates.get(channel.id);
    if (!cs) return 0;
    const modelDist = engine.modelDepth.get(channel.id);
    if (Number.isFinite(modelDist)) return modelDist;
    let mesh = cs.currMesh?.visible ? cs.currMesh : cs.prevMesh;
    if (!mesh?.visible) {
      // A transition package hides BOTH clip planes and draws its own root in
      // their place, but the hidden incoming mesh still carries this frame's
      // pose — measure it. Returning 0 here read as "at the camera", which
      // composited the whole transition ABOVE every other channel for exactly
      // the overlap window (and snapped back at the cut).
      if (!hasVisibleTransitionPackageInstances(cs)) return 0;
      mesh = cs.currMesh;
      if (!mesh) return 0;
    }
    const chCam = cameraForChannel(channel, engine.posedCamera, camera);
    chCam.updateMatrixWorld();
    // A real-3D grid's plate is screen-aligned (always at z 0) — sort by where
    // the ARRANGEMENT is, through the camera that actually films the cells.
    const gp = mesh.userData?.gridWorldPos;
    if (gp) return -_dofView.set(gp.x, gp.y, gp.z).applyMatrix4(chCam.matrixWorldInverse).z;
    // A flat layer sorts by its PLANE, not its centre, or a tilted camera re-sorts
    // coplanar layers by screen position — see compositeSortDepth.js.
    return layerSortDepth(mesh, chCam);
  };
  // The plane a channel's layer lies on, for layers rotated in 3D (null: flat, a model, a grid plate).
  const planeOfChannel = (channel) => {
    const cs = engine.channelStates.get(channel.id);
    if (!cs || engine.modelDepth.has(channel.id)) return null;
    const mesh = cs.currMesh?.visible ? cs.currMesh : cs.prevMesh;
    if (!mesh?.visible || mesh.userData?.gridWorldPos) return null;
    return layerPlane(mesh);
  };
  const compositeOrder = orderChannelsForComposite(
    getChannelsBottomToTop(env.channels), adjById, depthOfChannel, planeOfChannel
  );
  // A model is real geometry, so a flat layer near it has to be cut by its SURFACE,
  // not by its silhouette. Depth mode turns the layer quads into depth-testing,
  // depth-writing geometry for this frame; without a model in the stack nothing
  // changes and the composite is bit-for-bit what it was.
  //
  // A layer that opted into depth occlusion switches the same mode on by itself,
  // which is the whole of what that flag does. Its quad is already standing in the
  // right place in the composition's 3D space; all it was ever missing was
  // permission to write depth there — and once it has that, two flat layers
  // crossing at an angle resolve per pixel exactly as a layer and a model do.
  const depth3d = engine.modelDepthTex.size > 0 || engine.depthPlates.size > 0;
  setLayerDepthMode(engine, depth3d);

  const prevAutoClear = renderer.autoClear;
  const prevTarget = renderer.getRenderTarget();
  renderer.autoClear = false;

  // Start from a transparent accumulation buffer.
  renderer.setRenderTarget(read);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);

  const mat = clipMesh.material;
  const t = engine.currentTime;
  const depthStampScene = engine.depthStampScene;
  const depthStampMaterial = engine.depthStampMaterial;
  const depthCompositeScene = engine.depthCompositeScene;
  const depthCompositeMaterial = engine.depthCompositeMaterial;
  // Stamp a model's depth into whichever target the stack is accumulating into, so
  // the layers drawn after it are cut by its real surface. Called after the model's
  // colour lands, and re-applied when the ping-pong swaps targets.
  // A model's own quad must not depth-TEST: it is a neutral full-frame stand-in whose
  // z says nothing about where the geometry is, so testing it against a neighbouring
  // layer's depth would reject the whole model (the phone simply vanishes). Its real
  // depth reaches the buffer through the stamp below instead.
  //
  // That holds for EVERY camera-baked pass, including one that hands back no depth
  // at all: a "Shadows only" backdrop. Writing its quad's depth made a flat wall at
  // the composition plane wherever a shadow landed, and every model part behind
  // that plane was cut out of the frame.
  //
  // Judged by what the channel DREW this frame, not by its item's type: during a
  // cross transition into a model the channel shows the outgoing clip, which is
  // an ordinary layer and must keep its depth and its single hop.
  const isBakedPass = (channel) => {
    const cs = engine.channelStates.get(channel.id);
    return !!cs && [cs.currMesh, cs.prevMesh].some((m) => m?.visible && m.userData?.cameraBaked3d === true);
  };
  const setModelQuadDepth = (channel) => {
    if (!depth3d) return;
    const isModel = engine.modelDepthTex.has(channel.id) || isBakedPass(channel);
    const cs = engine.channelStates.get(channel.id);
    if (!cs) return;
    for (const m of [cs.currMaterial, cs.prevMaterial]) {
      if (!m) continue;
      m.depthTest = !isModel;
      m.depthWrite = !isModel;
    }
  };
  const stampModelDepth = (channel, target) => {
    if (!depth3d || !depthStampScene) return;
    const tex = engine.modelDepthTex.get(channel.id);
    if (!tex) return;
    depthStampMaterial.uniforms.uDepth.value = tex;
    depthStampMaterial.uniforms.uResolution.value.set(target.width, target.height);
    renderer.setRenderTarget(target);
    renderer.render(depthStampScene, orthoCamera);
  };
  // Draw an isolate with real per-pixel depth: colour and depth are tested and
  // written in one fragment pass, so two crossing surfaces alternate which one is
  // in front across the overlap instead of one flat quad winning everywhere.
  const compositeWithDepth = (colorTarget, depthTexture, target, blendMode, fallback = -1) => {
    if (!depthTexture || !depthCompositeScene || !depthCompositeMaterial || !colorTarget?.texture) return false;
    depthCompositeMaterial.uniforms.uColor.value = colorTarget.texture;
    depthCompositeMaterial.uniforms.uDepth.value = depthTexture;
    depthCompositeMaterial.uniforms.uFallback.value = Number.isFinite(fallback) ? fallback : -1;
    applyPremultipliedBlendMode(depthCompositeMaterial, blendMode);
    renderer.setRenderTarget(target);
    renderer.render(depthCompositeScene, orthoCamera);
    return true;
  };
  // A camera-baked 3D pass (model, cyclorama, re-lit plate). Its proxy quad has no
  // useful z of its own, so the pass's own depth buffer is the authority and there
  // is nothing outside it to keep — unless a real-3D effect put light past a
  // model's silhouette, which then sits at the model's centre depth.
  const compositePhysicalDepth = (channel, colorTarget, target, blendMode) =>
    compositeWithDepth(colorTarget, engine.modelDepthTex.get(channel.id), target, blendMode,
      engine.modelSpillDepth.get(channel.id) ?? -1);

  /*
   * An ORDINARY layer's own depth, for the isolate branch.
   *
   * The fast branch gets depth for free — the quad is drawn straight into the
   * accumulation buffer, so it tests and writes as it goes. The isolate branch does
   * not: the layer is rendered into a target of its own and arrives as a flat blit
   * that neither tests nor writes. Without this, switching on a drop shadow (or
   * DOF, or a track matte) silently dropped the layer out of the very 3D scene it
   * had just been placed in — it stopped occluding, and stopped being occluded.
   *
   * Re-drawing the same geometry with colour writes off into a depth-only target is
   * the honest fix; the plane's own centre depth covers whatever the effects spilled
   * outside the quad.
   */
  const layerDepthPass = (cs, chCam) => {
    const target = ensureDepthProbeTargetInEngine(engine, read.width, read.height);
    if (!target) return null;
    const mats = [cs.currMaterial, cs.prevMaterial].filter(Boolean);
    if (!mats.length) return null;
    for (const m of mats) m.colorWrite = false;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(cs.rig, chCam);
    for (const m of mats) m.colorWrite = true;
    return target.depthTexture;
  };
  // Window-space depth of a layer plane's centre, in the same encoding the depth
  // buffer holds — three's projection maps ndc.z ∈ [-1,1] onto [0,1].
  const planeDepthOf = (mesh, chCam) => {
    if (!mesh) return -1;
    mesh.updateWorldMatrix(true, false);
    const ndcZ = _platePos.copy(mesh.getWorldPosition(_dofWorld)).project(chCam).z;
    return Math.min(1, Math.max(0, ndcZ * 0.5 + 0.5));
  };
  // Camera DOF circle-of-confusion for one channel's active layer, measured
  // through the camera that actually films it. Mesh world z includes item panZ /
  // keyframed translateZ and channel stacking. The camera's dolly/tilt is not
  // baked into it — the camera moves instead — so focus distance is measured
  // along THIS channel's camera's viewing axis rather than by subtracting world
  // z from a fixed camera z. For a neutral pose the two are identical, which
  // keeps existing projects rendering exactly as before.
  const cocForChannel = (channel, cs, chCam) => {
    if (!(dof.enabled && dof.aperture > 0 && dof.blurLevel > 0) || channel.cameraLocked) return 0;
    const modelDist = engine.modelDepth.get(channel.id);
    // The model pass handed back its bounding-box centre's real view-space
    // distance; its plane is a neutral quad and would read as z = 0.
    if (Number.isFinite(modelDist)) return getCameraCoCRadius(dof, Math.max(1, modelDist));
    const focusMesh = cs.currMesh?.visible ? cs.currMesh : cs.prevMesh;
    if (!focusMesh?.visible) return 0;
    focusMesh.updateWorldMatrix(true, false);
    const world = focusMesh.getWorldPosition(_dofWorld);
    chCam.updateMatrixWorld();
    const viewZ = -_dofView.copy(world).applyMatrix4(chCam.matrixWorldInverse).z;
    return getCameraCoCRadius(dof, Math.max(1, viewZ));
  };

  // Whether a channel's active layer carries any per-layer effect at all.
  const hasLayerEffectStack = (channelId) => !!(engine.glowLayers.get(channelId)
    || engine.overlayFx.get(channelId) || engine.motionBlurLayers.get(channelId)
    || engine.motionTrailLayers.get(channelId)
    || engine.autoFillLayers.get(channelId) || engine.rigLayers.get(channelId)
    || engine.repetileLayers.get(channelId) || engine.regionDistortLayers.get(channelId)
    || engine.bendLayers.get(channelId) || engine.cornerPinLayers.get(channelId)
    || engine.drosteLayers.get(channelId) || engine.pryzmLayers.get(channelId)
    || engine.chromaKeyLayers.get(channelId) || engine.depthScanLayers.get(channelId)
    || engine.frRimLayers.get(channelId)
    || engine.meshWarpLayers.get(channelId) || engine.bezierWarpLayers.get(channelId)
    || engine.mockupFrameLayers.get(channelId)
    || engine.layerMaskLayers.get(channelId));

  // Render ONE layer ALONE into rt.c and run its whole per-layer stack on that
  // isolate, in the c–f scratch bank. Every per-layer effect needs the isolate:
  // DOF gathers against the layer's alpha silhouette instead of its rectangular
  // quad, Running Glow traces that silhouette as a contour, and the effect chain
  // both styles it and clips back to it. rt.c keeps the untouched isolate for the
  // whole call — it is the matte.
  //
  // Motion Blur measures once here; Accumulation mode REPLACES the plain isolate
  // with the K-sub-pose average (DoF/glow/chain then style the blurred plate, and
  // the matte is the blurred silhouette). Velocity mode keeps the plain isolate
  // and gathers at the end.
  //
  // Returns the target holding the finished plate (one of the c–f bank or a
  // pooled effect destination). Two callers: the composite loop's per-layer
  // branch, and the track-matte source pre-pass below.
  const renderStyledLayerIsolate = (channel, cs, chCam, coc) => {
    const glow = engine.glowLayers.get(channel.id) || null;
    const fx = engine.overlayFx.get(channel.id) || null;
    const mblur = engine.motionBlurLayers.get(channel.id) || null;
    const motionTrail = engine.motionTrailLayers.get(channel.id) || null;
    const autoFill = engine.autoFillLayers.get(channel.id) || null;
    const rigFx = engine.rigLayers.get(channel.id) || null;
    const repetile = engine.repetileLayers.get(channel.id) || null;
    const regionDistort = engine.regionDistortLayers.get(channel.id) || null;
    const bend = engine.bendLayers.get(channel.id) || null;
    const meshWarp = engine.meshWarpLayers.get(channel.id) || null;
    const bezierWarp = engine.bezierWarpLayers.get(channel.id) || null;
    const cornerPin = engine.cornerPinLayers.get(channel.id) || null;
    const droste = engine.drosteLayers.get(channel.id) || null;
    const pryzm = engine.pryzmLayers.get(channel.id) || null;
    const mockupFrame = engine.mockupFrameLayers.get(channel.id) || null;
    const layerMask = engine.layerMaskLayers.get(channel.id) || null;
    const chromaKey = engine.chromaKeyLayers.get(channel.id) || null;
    const depthScan = engine.depthScanLayers.get(channel.id) || null;
    const frRim = engine.frRimLayers.get(channel.id) || null;
    const defocused = coc >= 0.25;

    const mblurFrame = mblur ? measureMotionBlurInEngine(engine, env, mblur, cs, chCam, t, rt.c.width, rt.c.height) : null;
    const accumBlur = !!mblurFrame && mblurFrame.params.mblurMode < 0.5;
    const accumRan = !!(accumBlur && renderLayerAccumBlurInEngine(engine, env, rt, cs, chCam, mblur, mblurFrame, t));
    // Mockup Frame SEATS the layer for the isolate: the mesh is posed into the
    // chassis screen (in its own plane, so a 3D tilt carries it) before the render,
    // and restored before the geometry stages. The isolate — and every stage that
    // styles it below — then holds the artwork already inside the screen, and the
    // pass reads it at identity instead of reaching for artwork pixels a big or
    // tilted layer projects off the frame. The accumulation blur poses the rig
    // itself, so a seat is not attempted there and the pass falls back to the
    // projected read.
    let mockupSeated = false;
    let seatMesh = null;
    let seatSaved = null;
    if (mockupFrame && !accumRan) {
      seatMesh = cs.currMesh?.visible ? cs.currMesh : (cs.prevMesh?.visible ? cs.prevMesh : null);
      if (seatMesh) {
        const mfParams = resolveMockupStageParamsInEngine(engine, mockupFrame, t);
        const mfDev = buildMockupDevice(mfParams);
        const mfBox = computeLayerBox(seatMesh, chCam, rt.c.width, rt.c.height);
        const mfPlane = mfBox ? layerPlaneBox(seatMesh, chCam, rt.c.height) : null;
        if (mfDev && mfDev.w > 0 && mfDev.h > 0 && mfPlane?.sizePlane) {
          const [bw, bh] = mfPlane.sizePlane;
          const mfLayout = layoutMockupFrame(mfDev, Math.max(1, bw), Math.max(1, bh), mfParams);
          if (mfLayout.scale > 1e-6) {
            seatSaved = seatLayerMesh(seatMesh,
              mockupSeatTransform(mfDev, mfParams, mfLayout, Math.max(1, bw), Math.max(1, bh)), mfPlane.pxPerWorld);
            mockupSeated = !!seatSaved;
          }
        }
      }
    }
    if (!accumRan) {
      renderer.setRenderTarget(rt.c);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(cs.rig, chCam);
    }
    let out = rt.c;
    // V-axis provenance: a camera-rendered isolate sits on the opposite V
    // axis from quad-written plates under WebGPU (the matteClip uMatte
    // precedent). rt.c stays camera-axis until a pass rewrites it through
    // an ortho quad — the mask, the rig and the accumulation blur all do.
    // Plain-UV consumers (Auto Fill, the velocity motion blur) flip their
    // plate reads while `out` is still that camera plate. A model / Rig
    // isolate is upright from the start (isUprightIsolatePlate).
    const isoItem = engine.layerItems.get(channel.id);
    let rtcCameraAxis = !accumRan && !isUprightIsolatePlate(env.clipsMap.get(isoItem?.clipId), isoItem);

    // Chroma Key pulls the matte off the isolate IN PLACE, before everything
    // else: from here on the keyed silhouette is the layer's real shape.
    if (chromaKey && applyChromaKeyInEngine(engine, rt.c, chromaKey, t, rtcCameraAxis)) rtcCameraAxis = false;

    // Layer Mask cuts the isolate IN PLACE, BEFORE the rig. The mask is
    // authored in the layer's unit box against the UN-WARPED artwork; masking
    // after the rig would slice the already-warped image with a straight edge
    // and the mask would visibly refuse to follow the puppet. The rig then
    // bakes its preserve-texture mask from rt.c.texture — now the masked
    // alpha — which is exactly right.
    if (layerMask) {
      const lmMesh = cs.currMesh?.visible ? cs.currMesh : (cs.prevMesh?.visible ? cs.prevMesh : null);
      if (lmMesh && applyLayerMaskInEngine(engine, rt.c, layerMask, lmMesh, chCam, t, ss, rtcCameraAxis)) rtcCameraAxis = false;
    }

    // Silhouette framing: the keyed layer's border + shadows, drawn from the
    // keyed (and masked) alpha. After the mask so a mask cut is part of the
    // outline; before the rig so the pins warp the framed plate, exactly as
    // they warp a rectangle's shadow today.
    const framed = chromaKey || (layerMask && maskSilhouetteFraming(layerMask.item, layerMask.clip) ? layerMask : null);
    if (framed) {
      const sfMesh = cs.currMesh?.visible ? cs.currMesh : (cs.prevMesh?.visible ? cs.prevMesh : null);
      if (sfMesh && applySilhouetteFramingInEngine(engine, rt.c, framed, sfMesh, t, rtcCameraAxis)) rtcCameraAxis = false;
    }

    // Rig (Puppet) warps the isolate IN PLACE first of all — the pins
    // deform the raw artwork, and every later stage (Auto Fill's bake,
    // DOF, glow, the chain's matte, track matte) reads the warped
    // silhouette because rt.c itself is replaced.
    if (rigFx) {
      const rigMesh = cs.currMesh?.visible ? cs.currMesh : (cs.prevMesh?.visible ? cs.prevMesh : null);
      if (rigMesh && renderLayerRigInEngine(engine, rt, rigFx, rigMesh, t, rtcCameraAxis)) rtcCameraAxis = false;
    }

    // Auto Fill restyles the isolate FIRST, so DOF, glow, the overlay
    // chain and motion blur all style the filled look — and rt.c stays
    // the untouched matte for everything downstream.
    if (autoFill) {
      const afMesh = cs.currMesh?.visible ? cs.currMesh : (cs.prevMesh?.visible ? cs.prevMesh : null);
      if (afMesh) out = renderLayerAutoFillInEngine(engine, out, autoFill, afMesh, t, out === rt.c && rtcCameraAxis);
    }

    // Depth Scan restyles the plate the same way and for the same reason: DOF,
    // glow and the overlay chain should all see the SCANNED look, and rt.c is
    // left alone as the matte. After Auto Fill so a filled layer can also be
    // sliced (the fill is part of the artwork by then).
    if (depthScan) {
      const scanMesh = cs.currMesh?.visible ? cs.currMesh : (cs.prevMesh?.visible ? cs.prevMesh : null);
      if (scanMesh) out = renderLayerDepthScanInEngine(engine, out, depthScan, scanMesh, chCam, t, out === rt.c && rtcCameraAxis);
    }
    // Fresnel Rim (pictures): after the scan, so a scanned layer can also rim.
    if (frRim) {
      const frMesh = cs.currMesh?.visible ? cs.currMesh : (cs.prevMesh?.visible ? cs.prevMesh : null);
      if (frMesh) out = renderLayerFresnelRimInEngine(engine, out, frRim, frMesh, chCam, t, out === rt.c && rtcCameraAxis);
    }

    // DOF, glow and the chain want a camera-axis source (plateToCameraAxis);
    // only the untouched isolate still is one.
    const outCamAxis = () => out === rt.c && rtcCameraAxis;
    if (defocused) {
      dofMaterial.uniforms.uTexture.value = (outCamAxis() ? out : plateToCameraAxisInEngine(engine, out)).texture;
      dofMaterial.uniforms.uResolution.value.set(rt.d.width, rt.d.height);
      dofMaterial.uniforms.uRadiusPx.value = Math.min(64, coc * ss);
      dofMaterial.uniforms.uHighlightGain.value = dof.highlightGain / 100;
      dofMaterial.uniforms.uSamples.value = env.interactivePreviewEnabled ? 24 : 40;
      // Focus area, in this target's pixels. gl_FragCoord has y up, the focus
      // point is authored y-down like every other % field in the editor.
      dofMaterial.uniforms.uFocusPointPx.value.set(
        (dof.focusX / 100) * rt.d.width,
        (1 - dof.focusY / 100) * rt.d.height
      );
      const focusOuterPx = (dof.focusWidth / 100) * rt.d.width;
      dofMaterial.uniforms.uFocusOuterPx.value = focusOuterPx;
      dofMaterial.uniforms.uFocusInnerPx.value = focusOuterPx * 0.5;
      renderer.setRenderTarget(rt.d);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(dofScene, orthoCamera);
      out = rt.d;
    }

    // Glow runs on the defocused result, so a background layer's glow is
    // blurred by the same amount as the layer it belongs to. When `out`
    // is rt.d (defocused) the scratch pair shifts to e/f; otherwise
    // (plain isolate or the Auto Fill destination) d/e are free.
    if (glow) {
      const glowSrc = outCamAxis() ? out : plateToCameraAxisInEngine(engine, out);
      out = glowSrc === rt.d ? renderLayerGlowInEngine(engine, env, rt.d, rt.e, rt.f, glow, t) : renderLayerGlowInEngine(engine, env, glowSrc, rt.d, rt.e, glow, t);
    }

    // The chain runs last, on the finished layer, so it can restyle the glow
    // and the defocus too. It works in its own target bank (rt.c–f are taken).
    if (fx) {
      const fxMesh = cs.currMesh?.visible ? cs.currMesh : (cs.prevMesh?.visible ? cs.prevMesh : null);
      out = runLayerOverlayEffectsInEngine(engine, env, out, rt.c, fx, t, fxMesh, chCam,
        { srcCamAxis: outCamAxis(), matteCamAxis: rtcCameraAxis });
    }

    // The geometry stages — warps, Droste, Corner Pin, Mockup Frame, Repetile —
    // reshape the finished plate in one shared runner (order and rationale live
    // on runLayerGeometryStages). An executable transition package hides BOTH
    // clip planes to draw its own output, but the hidden mesh still carries the
    // item's transform and the box is all these passes need — so fall back to
    // it rather than skipping the whole stack for the length of the transition.
    // The seat is undone here: the geometry stages lay the chassis out against the
    // layer's REAL box, and everything after them composites at the real pose.
    if (seatSaved) unseatLayerMesh(seatMesh, seatSaved);
    const geoMesh = cs.currMesh?.visible ? cs.currMesh
      : (cs.prevMesh?.visible ? cs.prevMesh : (cs.currMesh || cs.prevMesh));
    if (geoMesh && (regionDistort || bend || meshWarp || bezierWarp || droste || pryzm || cornerPin || mockupFrame || repetile)) {
      const geo = runLayerGeometryStagesInEngine(engine, out,
        { regionDistort, bend, meshWarp, bezierWarp, droste, pryzm, cornerPin, mockupFrame, repetile },
        { mesh: geoMesh, cam: chCam, t, ping: rt.c, pong: rt.d, camAxisTarget: rt.c, camAxis: rtcCameraAxis, cacheKey: channel.id, mockupSeated });
      out = geo.out;
      rtcCameraAxis = geo.camAxis;
    }

    // Motion Trail repeats the FINISHED look behind the layer — the copies
    // carry the glow, the defocus and the chain, same reasoning as Repetile.
    // Before motion blur so a shutter smears the whole trail.
    if (motionTrail) {
      const dest = out === rt.c ? rt.d : rt.c;
      const res = renderLayerTrailInEngine(engine, env, out, dest, motionTrail, cs, chCam, t, channel.id,
        out === rt.c && rtcCameraAxis);
      if (dest === rt.c && res === rt.c) rtcCameraAxis = false;
      out = res;
    }

    // Velocity-mode Motion Blur is the true last step: the shutter smears
    // the FINISHED look (defocus, glow, overlay chain and all). rt.c was
    // the matte; the chain is done with it by now, so it (or rt.d) is
    // free to receive. Accumulation mode already blurred the isolate.
    if (mblurFrame && !accumBlur) {
      const dest = out === rt.c ? rt.d : rt.c;
      const res = renderLayerMotionBlurInEngine(engine, env, out, dest, mblurFrame,
        out === rt.c && rtcCameraAxis);
      if (res !== out) rtcCameraAxis = false;
      out = res;
    }

    // A layer-effect stack always composites through overBlit(uv()), which is
    // the wrong read of a camera-rendered isolate under WebGPU (plain layers
    // skip this path and draw the mesh directly, so they stay upright). Every
    // effect that rewrites the plate through an ortho quad clears the flag
    // above. The remaining case is an enabled effect that did no rewrite —
    // Motion Blur's "static frame, exact bypass" is the one that actually
    // ships: the shutter has nothing to smear, the isolate is still camera-
    // axis, and overBlit shows it vertically mirrored. Copy through the same
    // uv() blit the overlay chain starts with so provenance matches a
    // finished quad plate.
    if (rtcCameraAxis && out === rt.c && rt.d) {
      blitMaterial.uniforms.uTexture.value = out.texture;
      renderer.setRenderTarget(rt.d);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(blitScene, orthoCamera);
      out = rt.d;
    }
    return out;
  };

  // ── Track matte source isolates ──
  // One per consumed source, into a keyed pass-pool target. Rendered HERE, before
  // the stack accumulates, because a styled source needs the whole rt.c–f scratch
  // bank — inside a consumer's own branch those targets are all taken.
  //
  // The source renders through ITS OWN channel camera, so the matte lands exactly
  // where that layer would have drawn on screen (camera-locked sources included),
  // and it carries the source's OWN per-layer stack: an Extract/Curves chain, a
  // rig warp, glow, Repetile, motion blur. That chain is usually the whole point —
  // keying on the raw plate silently threw away the matte the user authored.
  // Effect-free sources take the original single-render path byte-for-byte.
  const matteIsolates = new Map();
  for (const srcChannelId of engine.matteSourceChannels.keys()) {
    let target = null;
    const srcCs = engine.channelStates.get(srcChannelId);
    const srcChannel = channelById.get(srcChannelId);
    if (srcCs && srcChannel && srcCs.group.visible !== false) {
      target = ensurePassTargetInEngine(engine, `trackMatte:${srcChannelId}`, read.width, read.height, false);
      if (target) {
        const srcCam = cameraForCompositePlate(srcChannel, srcCs);
        const srcCoc = cocForChannel(srcChannel, srcCs, srcCam);
        const styled = srcCoc >= 0.25 || hasLayerEffectStack(srcChannelId)
          ? renderStyledLayerIsolate(srcChannel, srcCs, srcCam, srcCoc)
          : null;
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        if (styled) {
          // NoBlending copy into the cleared target — alpha included, which is
          // the channel the matte pass reads.
          blitMaterial.uniforms.uTexture.value = styled.texture;
          renderer.render(blitScene, orthoCamera);
        } else {
          suspendChannelBlend(srcCs);
          renderer.render(srcCs.rig, srcCam);
          resumeChannelBlend(srcCs);
        }
      }
    }
    matteIsolates.set(srcChannelId, target);
  }

  // ── Copy Color Profile reference isolates ──
  // Same place and same reasons as the matte sources: the scratch bank is free
  // here, and the source renders through its own camera with its own stack.
  // Always a QUAD plate on exit (camera render into rt.c → uv() blit), so the
  // chain samples it plain on both backends and the projected box below is in
  // the same convention as ctx.box. Keyed by ITEM id — that is what the effect
  // stores — and cleared per composite so a deleted layer cannot linger.
  const colorRefPlates = engine.colorRefPlates;
  colorRefPlates.clear();
  // Keys taken from the pass pool this frame; whatever was taken last frame
  // and is not taken now is released below (a reference changed or its effect
  // went quiet) — a 1080p plate is ~8 MiB, and the pool otherwise holds it
  // until the renderer is torn down. Plates the pre-transition bake drew this
  // frame count as taken: the bake ran before this pass and runs again next
  // frame, so releasing them would only re-allocate and re-copy them.
  const colorRefKeysUsed = new Set(engine.colorRefBakeKeys);
  for (const [srcItemId, src] of engine.colorRefSources) {
    const srcChannelId = src.channelId;
    if (!srcChannelId) {
      // Not on screen right now (hidden channel, elsewhere in time, same
      // channel): measure the clip's own picture (ensurePictureRefPlate).
      const ref = ensurePictureRefPlateInEngine(engine, srcItemId, env.clipsMap.get(src.item?.clipId), read.width, read.height);
      if (!ref) continue;
      colorRefKeysUsed.add(ref.key);
      colorRefPlates.set(srcItemId, ref.plate);
      continue;
    }
    const srcCs = engine.channelStates.get(srcChannelId);
    const srcChannel = channelById.get(srcChannelId);
    if (!srcCs || !srcChannel || srcCs.group.visible === false) continue;
    const liveKey = `colorRef:${srcChannelId}`;
    colorRefKeysUsed.add(liveKey);
    const target = ensurePassTargetInEngine(engine, liveKey, read.width, read.height, false);
    if (!target) continue;
    const srcCam = cameraForCompositePlate(srcChannel, srcCs);
    const srcCoc = cocForChannel(srcChannel, srcCs, srcCam);
    let styled = srcCoc >= 0.25 || hasLayerEffectStack(srcChannelId)
      ? renderStyledLayerIsolate(srcChannel, srcCs, srcCam, srcCoc)
      : null;
    if (!styled) {
      renderer.setRenderTarget(rt.c);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(srcCs.rig, srcCam);
      styled = rt.c;
    }
    blitMaterial.uniforms.uTexture.value = styled.texture;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(blitScene, orthoCamera);
    const srcMesh = srcCs.currMesh?.visible ? srcCs.currMesh : (srcCs.prevMesh?.visible ? srcCs.prevMesh : null);
    colorRefPlates.set(srcItemId, {
      texture: target.texture,
      box: srcMesh ? computeLayerBox(srcMesh, srcCam, read.width, read.height) : null,
    });
  }
  for (const key of engine.colorRefKeys) {
    if (colorRefKeysUsed.has(key)) continue;
    const stale = engine.passPool.get(key);
    if (stale) { stale.dispose(); engine.passPool.delete(key); }
    if (key.startsWith('colorRef:item:')) engine.colorRefStatic.delete(key.slice('colorRef:item:'.length));
  }
  engine.colorRefKeys = colorRefKeysUsed;

  // Depth order, not channel order — see orderChannelsForComposite.
  for (const channel of compositeOrder) {
    const cs = engine.channelStates.get(channel.id);
    if (!cs) continue;
    // A consumed matte source never draws itself: its pixels only feed the
    // consumers' matte pass (mirrors how a clip-mask layer's fill is never drawn).
    if (engine.matteSourceChannels.has(channel.id)) continue;
    // Same for a layer consumed by a `consumesLayerRef` effect (its isolate
    // already went into the ref plate above).
    if (engine.colorRefConsumed.has(channel.id)) continue;
    // Locked ordinary env.channels stay put while unlocked ones ride the project pose.
    // Camera-baked 3D/grid plates are the exception handled by the helper: their
    // pixels already carry that pose and must not be projected a second time.
    const chCam = cameraForCompositePlate(channel, cs);
    const adj = adjById.get(channel.id);
    if (adj && adj.kind === 'mask') {
      // Clipping mask (shape or text): render the mask layer (with its own
      // transforms/keyframes) into the spare target, then keep the accumulated
      // below-composite only where it has coverage. The mask layer's own fill is
      // never drawn — its alpha (including a semi-transparent fill) IS the mask,
      // and `clipMaskInvert` flips it to a knockout.
      if (cs.group.visible !== false) {
        renderer.setRenderTarget(rt.c);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        // Rig, not group — the top-level stack renders through the project camera.
        renderer.render(cs.rig, chCam);
        maskMaterial.uniforms.uTexture.value = read.texture;
        maskMaterial.uniforms.uMask.value = rt.c.texture;
        // Set every pass — the material is shared and stacked masks can disagree.
        maskMaterial.uniforms.uInvert.value = adj.item?.clipMaskInvert ? 1 : 0;
        renderer.setRenderTarget(write);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.render(maskScene, orthoCamera);
        const tmp = read; read = write; write = tmp;
      }
    } else if (adj) {
      // The adjustment is a camera-move + grade on the layers below. It REPLACES the
      // below with the graded/transformed result; the result's own alpha = coverage *
      // opacity, so opacity is real layer transparency (50% = the whole adjusted frame
      // shown 50% transparent over the canvas — no blend with the original, no copy).
      const { item, entry } = adj;
      const duration = entry.endTime - entry.startTime;
      const progress = duration > 0 ? Math.max(0, Math.min(1, (t - entry.startTime) / duration)) : 0;
      const kf = getItemKeyframeValues(item, progress);

      // Adjustment Mask: capture the UNGRADED composite first. After the
      // grade renders and the effect chain ping-pongs over the pair, no live
      // target still holds it — and the mix pass below needs it back.
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

      // Render the graded/transformed plane into a fresh (transparent) target.
      mat.uniforms.uTexture.value = read.texture;
      applyAdjustmentUniforms(mat, item, kf, sizeVec.x, sizeVec.y, { reducedMotionPreview: env.interactivePreviewEnabled });
      applyMeshTransform(clipMesh, item, kf, W, H, resolveParentingInEngine(engine, env.parentIndex, item, t),
        null, resolveFollowInEngine(engine, env.parentIndex, item, t));
      renderer.setRenderTarget(write);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(clipScene, camera);

      let tmp = read; read = write; write = tmp;
      // GPU effect chain + item-level LUT on the graded result (screen-space,
      // same ping-pong pair; rt.c doubles as the scratch for two-pass effects —
      // its mask/DOF uses are transient within their own branches).
      if (item?.effects?.length || item?.lut) {
        const res = runEffectChainInEngine(engine, env, item, kf, {
          read,
          write,
          scratch: rt.c,
          pyramid: [rt.c, rt.d, rt.e, rt.f],
          time: t - entry.startTime,
          progress,
          duration,
        });
        read = res.read; write = res.write;
      }
      // Scope the grade to the mask stack: mix the finished graded result
      // back toward the ungraded capture by coverage. clipMesh still carries
      // this item's transform from applyMeshTransform above, and `camera` is
      // the camera that filmed the plane — the pairing computeLayerBox needs.
      if (adjMaskSrc && applyAdjustmentMaskInEngine(engine, read, adjMaskSrc, write, { item, entry }, clipMesh, camera, t, ss)) {
        tmp = read; read = write; write = tmp;
      }
    } else {
      if (cs.group.visible === false) continue;
      const glow = engine.glowLayers.get(channel.id) || null;
      const fx = engine.overlayFx.get(channel.id) || null;
      const mblur = engine.motionBlurLayers.get(channel.id) || null;
      const motionTrail = engine.motionTrailLayers.get(channel.id) || null;
      const autoFill = engine.autoFillLayers.get(channel.id) || null;
      const rigFx = engine.rigLayers.get(channel.id) || null;
      const repetile = engine.repetileLayers.get(channel.id) || null;
      const regionDistort = engine.regionDistortLayers.get(channel.id) || null;
      const bend = engine.bendLayers.get(channel.id) || null;
      const meshWarp = engine.meshWarpLayers.get(channel.id) || null;
      const bezierWarp = engine.bezierWarpLayers.get(channel.id) || null;
      const cornerPin = engine.cornerPinLayers.get(channel.id) || null;
      const droste = engine.drosteLayers.get(channel.id) || null;
      const pryzm = engine.pryzmLayers.get(channel.id) || null;
      const mockupFrame = engine.mockupFrameLayers.get(channel.id) || null;
      const layerMask = engine.layerMaskLayers.get(channel.id) || null;
      const chromaKey = engine.chromaKeyLayers.get(channel.id) || null;
      const depthScan = engine.depthScanLayers.get(channel.id) || null;
      const frRim = engine.frRimLayers.get(channel.id) || null;
      const layerItem = engine.layerItems.get(channel.id) || null;
      // A shader blend mode: the plate meets the stack through the
      // blendComposite pass instead of the over-blit — isolate branch only.
      const shaderBlend = engine.shaderBlendLayers.get(channel.id) || null;
      // Backdrop Blur: runs BEFORE the shape lands, on whatever the stack
      // holds so far — its window is the shape's silhouette. It never forces
      // the isolate branch: a plain shape keeps its direct draw.
      const backdrop = engine.backdropLayers.get(channel.id) || null;
      // Glass: same slot as Backdrop Blur (after it, before the shape lands).
      const glass = engine.glassLayers.get(channel.id) || null;
      // Track matte on this layer. An EMPTY matte (source clip not under the
      // playhead) is AE semantics: alpha/luma modes hide the consumer outright,
      // inverted modes leave it untouched (matte 0 everywhere → 1−0 = 1).
      const matte = engine.trackMatteLayers.get(channel.id) || null;
      const matteInverted = !!matte && (matte.mode === 'alphaInverted' || matte.mode === 'lumaInverted');
      if (matte && !matte.sourceChannelId && !matteInverted) continue;
      const activeMatte = matte && matte.sourceChannelId ? matte : null;
      const coc = cocForChannel(channel, cs, chCam);
      const defocused = coc >= 0.25;
      if (!defocused && !glow && !fx && !mblur && !motionTrail && !activeMatte && !autoFill && !rigFx && !repetile && !regionDistort && !bend && !meshWarp && !bezierWarp && !cornerPin && !droste && !pryzm && !mockupFrame && !layerMask && !chromaKey && !depthScan && !frRim && !shaderBlend) {
        // Exact bypass: DOF off, zero aperture/blur, no Running Glow, no layer
        // effects, no Motion Blur, no mask — in-focus plain layers retain the
        // original direct render path byte-for-byte.
        if (backdrop) {
          // The window is the shape's plain isolate — camera-rendered, so it
          // shares the stack's V axis and the mix reads it plain.
          renderer.setRenderTarget(rt.c);
          renderer.setClearColor(0x000000, 0);
          renderer.clear(true, true, true);
          renderer.render(cs.rig, chCam);
          if (applyBackdropBlurInEngine(engine, read, write, rt.c, false, backdrop, W)) {
            const tmp = read; read = write; write = tmp;
          }
        }
        if (glass && applyGlassInEngine(engine, read, write, glass, cs, cs.rig, chCam, W)) {
          const tmp = read; read = write; write = tmp;
        }
        setModelQuadDepth(channel);
        if (engine.modelDepthTex.has(channel.id)) {
          // The proxy quad has no physical Z. Isolate its finished colour, then
          // combine that colour with the pass's real depth in one tested draw.
          renderer.setRenderTarget(rt.c);
          renderer.setClearColor(0x000000, 0);
          renderer.clear(true, true, true);
          suspendChannelBlend(cs);
          renderer.render(cs.rig, chCam);
          resumeChannelBlend(cs);
          if (!compositePhysicalDepth(channel, rt.c, read, layerItem?.blendMode)) {
            renderer.setRenderTarget(read);
            renderer.render(cs.rig, chCam);
            stampModelDepth(channel, read);
          }
        } else if (selectedBackend() === 'webgpu' && isBakedPass(channel)) {
          // A depth-less 3D pass (a "Shadows only" backdrop, a picture that
          // receives shadows without occluding) takes the SAME two hops as the
          // depth route above, colour isolate then a blit into the stack. Drawn
          // straight into the stack it was one hop short, which on WebGPU is
          // a vertical flip: the backdrop's shadows landed in the sky.
          renderer.setRenderTarget(rt.c);
          renderer.setClearColor(0x000000, 0);
          renderer.clear(true, true, true);
          suspendChannelBlend(cs);
          renderer.render(cs.rig, chCam);
          resumeChannelBlend(cs);
          applyPremultipliedBlendMode(overBlitMaterial, layerItem?.blendMode);
          overBlitMaterial.uniforms.uTexture.value = rt.c.texture;
          renderer.setRenderTarget(read);
          renderer.render(overBlitScene, orthoCamera);
          applyPremultipliedBlendMode(overBlitMaterial, 'normal');
        } else {
          renderer.setRenderTarget(read);
          renderer.render(cs.rig, chCam);
        }
      } else {
        // The layer's own surface depth, captured from the untouched geometry
        // before any effect reshapes it. Only in a 3D frame, and never for a
        // camera-baked pass — that one carries its own depth already, or (a
        // shadow-only backdrop) deliberately none.
        const ownDepth = depth3d && !engine.modelDepthTex.has(channel.id) && !isBakedPass(channel)
          ? layerDepthPass(cs, chCam)
          : null;
        const ownFallback = ownDepth
          ? planeDepthOf(cs.currMesh?.visible ? cs.currMesh : cs.prevMesh, chCam)
          : -1;

        // Render this layer ALONE and run its whole per-layer stack on the
        // isolate (see renderStyledLayerIsolate). Its hardware blend mode is
        // suspended for the isolate: it is applied when the plate meets the
        // stack below (overBlit / blendComposite), never against the plate's
        // own cleared black.
        suspendChannelBlend(cs);
        let out = renderStyledLayerIsolate(channel, cs, chCam, coc);

        // Track matte is the true last word: it clips the FINISHED look —
        // defocus, glow, chain and blur spill included — exactly like AE, where
        // the matte applies at composite time after the layer's own effects.
        //
        // `out` is always a finished QUAD plate here (renderStyledLayerIsolate
        // normalises a camera-axis isolate on exit) while the matte isolate is
        // camera-rendered — so this is the flipTexture variant, which keeps the
        // plate's layout for the overBlit below (createTrackMatteNodeMaterial).
        if (activeMatte) {
          const srcTarget = matteIsolates.get(activeMatte.sourceChannelId) || null;
          const tmScene = engine.trackMatteScene;
          const tmMat = engine.trackMatteMaterial;
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
          }
        }

        // The result is premultiplied and composites cleanly over the accumulated
        // lower stack, including soft alpha at foreground edges. It must carry the
        // layer's blend mode: the mesh material's blending was bypassed the moment
        // the layer was rendered into a target of its own, so without this a
        // screen/multiply layer silently reverts to Normal whenever any per-layer
        // effect is on.
        //
        // Both kinds of 3D layer land here through the same depth-aware draw: a
        // camera-baked pass with its own depth buffer, and an ordinary layer with
        // the depth captured from its geometry above. Everything else blits flat,
        // exactly as before.
        // Backdrop Blur under a styled shape: the window is the FINISHED
        // plate (warped, masked, matted), a quad plate — hence the flipped
        // matte read on WebGPU.
        if (backdrop && applyBackdropBlurInEngine(engine, read, write, out, true, backdrop, W)) {
          const tmp = read; read = write; write = tmp;
        }
        // Glass under a matte: the pane keeps only what the matte keeps — the
        // same camera-axis isolate and maths the plate was just matted with.
        const glassMatteSrc = glass && activeMatte ? matteIsolates.get(activeMatte.sourceChannelId) : null;
        const glassMatte = glassMatteSrc ? {
          texture: glassMatteSrc.texture,
          luma: activeMatte.mode === 'luma' || activeMatte.mode === 'lumaInverted',
          invert: matteInverted,
        } : null;
        // …and its Layer Mask: renderStyledLayerIsolate just cut the isolate with it.
        if (glass && applyGlassInEngine(engine, read, write, glass, cs, cs.rig, chCam, W, glassMatte, layerMask?.item)) {
          const tmp = read; read = write; write = tmp;
        }
        // A shader blend mode reads the stack, so it cannot ride the depth-
        // tested draw: it composites flat (the plate's own depth is dropped
        // for that frame), through the blendComposite ping-pong.
        const depthed = !shaderBlend && (engine.modelDepthTex.has(channel.id)
          ? compositePhysicalDepth(channel, out, read, layerItem?.blendMode)
          : (ownDepth
            ? compositeWithDepth(out, ownDepth, read, layerItem?.blendMode, ownFallback)
            : false));
        if (!depthed) {
          if (shaderBlend && applyShaderBlendInEngine(engine, read, write, out, true, shaderBlend)) {
            const tmp = read; read = write; write = tmp;
          } else {
            applyPremultipliedBlendMode(overBlitMaterial, layerItem?.blendMode);
            overBlitMaterial.uniforms.uTexture.value = out.texture;
            renderer.setRenderTarget(read);
            renderer.render(overBlitScene, orthoCamera);
            // Fallback for a context that could not create the GLSL3 depth-colour
            // pass: preserve the older colour-then-stamp behavior.
            stampModelDepth(channel, read);
          }
        }
        // The flatten pass below shares this material and always wants plain over.
        applyPremultipliedBlendMode(overBlitMaterial, 'normal');
        resumeChannelBlend(cs);
      }
    }
  }

  // Flatten onto an opaque backdrop (project background, else black) before the
  // canvas is read back. A clip mask leaves partial alpha along every antialiased
  // edge with RGB premultiplied by that alpha; an opaque encoder un-premultiplies
  // (RGB / tiny alpha ≈ white) and then discards the alpha, which turned glyph
  // outlines into a 1px white fringe and threw away the antialiasing. Blending
  // against the backdrop here resolves those edges properly, and it also restores
  // the project background, which the per-channel loop above never draws (it
  // renders channel groups, not `scene`). Skipped for alpha exports, where the
  // transparency IS the deliverable and the PNG-frame route handles it correctly.
  const flattenScene = engine.flattenScene;
  const flattened = !engine.alphaExport && !!flattenScene && !!overBlitMaterial && !!overBlitScene;
  if (flattened) {
    renderer.setRenderTarget(write);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, true);
    const sceneBackground = engine.scene?.background || null;
    if (sceneBackground) {
      // Borrow three's own background pass so the backdrop matches the
      // single-pass path exactly (fitting, colour space, intensity).
      flattenScene.background = sceneBackground;
      renderer.render(flattenScene, camera);
      flattenScene.background = null;
    }
    overBlitMaterial.uniforms.uTexture.value = read.texture;
    renderer.render(overBlitScene, orthoCamera);
    const tmp = read; read = write; write = tmp;
  }

  // Blit the final composite onto the canvas (or into the output target the
  // motion-blur accumulation bound in its place).
  //
  // V axis: this landing has to produce the SAME axis the single-pass branch
  // does (`renderer.render(scene, camera)` straight into the same target) —
  // both finish a frame, and everything downstream (the encoder, and the
  // motion-blur accumulation that binds its own target here) is calibrated
  // for one axis, not two. `read` is camera-axis, and on WebGPU a plain-uv
  // blit re-stores it mirrored; the flatten above is a second uv() hop, so
  // when it runs the two mirrors cancel and the plain blit is correct.
  //
  // When it does NOT run — an alpha export, where the transparency is the
  // deliverable — the plain blit was the ONLY hop and the whole frame landed
  // upside down. Measured against WebGL on this exact fixture: the alpha
  // frames' vertical centroid sat at 0.614 where every WebGL run put it at
  // 0.386, an exact mirror. The storage-identity copy keeps the camera axis
  // and makes the two landings agree again. WebGL aliases the plain blit, and
  // an opaque export still takes the flatten + plain blit path byte-for-byte.
  const landingIdentity = !flattened && selectedBackend() === 'webgpu'
    && !!engine.seqPlateCopyMaterial && !!engine.seqPlateCopyScene;
  const landingMaterial = landingIdentity ? engine.seqPlateCopyMaterial : blitMaterial;
  landingMaterial.uniforms.uTexture.value = read.texture;
  renderer.setRenderTarget(engine.outputTarget);
  renderer.setClearColor(0x000000, engine.alphaExport ? 0 : 1);
  renderer.clear(true, true, true);
  renderer.render(landingIdentity ? engine.seqPlateCopyScene : blitScene, orthoCamera);

  // Restore renderer state for the next frame / the non-adjustment path.
  renderer.autoClear = prevAutoClear;
  renderer.setRenderTarget(prevTarget || null);
  return true;
}
