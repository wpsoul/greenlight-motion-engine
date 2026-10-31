/*
 * The composite pipeline's fixed GPU resources (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 1).
 *
 * Moved VERBATIM out of the Player's renderer effect: the posed camera, the ortho camera and the shared
 * full-screen quad, and the materials + scenes of every full-screen pass the compositor draws through —
 * blit, picture copy, sequence-plate copy, depth stamp / composite, camera depth of field, mix, clip mask,
 * track matte (+ plain), over-blit / flatten, the adjustment clip quad, the effect quad, motion-blur mix and
 * matte clip (+ plain) — plus clearing the lazily built passes and ping-pong targets. They now live on the
 * engine object (./engineState.js) instead of in React refs; the Player reaches them through bridges.
 *
 *   buildCompositePipeline(engine, { camera, initW, initH, fov })   after the renderer and main camera exist
 *   disposeCompositePipeline(engine)                                  when that renderer is torn down
 */
import * as THREE from 'three';
import { materials as makeMaterial } from '../materialFactory';
import {
  createBlitMaterial, createPictureCopyMaterial, createOverBlitMaterial, createAdjustmentMaterial, createMixMaterial,
  createMaskCompositeMaterial, createTrackMatteMaterial, createDepthStampMaterial, createDepthCompositeMaterial,
} from '../clipShader';
import { createCameraDofDepthMaterial, createCameraDofMaterial } from '../cameraDof';
import { createMotionBlurMixMaterial } from '../motionBlurLayer';
import { createMatteClipMaterial } from '../adjustmentEffects';
import { selectedBackend } from '../videoRenderer';

/*
 * The adjustment quad's V flip, and why it lives HERE rather than in the material.
 *
 * The adjustment layer is the one plane in the compositor that is BOTH posed by
 * the perspective camera AND textured from a render target (the accumulated
 * below-stack). Every other perspective plane samples a canvas/video texture,
 * whose upload orientation already matches on both backends; every other
 * render-target consumer is a fullscreen ortho blit. The adjustment layer is the
 * only place those two meet, and WebGPU's render-target texture axis runs
 * opposite to WebGL's — so on WebGPU the graded result came out MIRRORED. Not
 * subtly: the whole frame, text upside down. Measured on the app path, WebGL vs
 * WebGPU was 20,028 differing pixels at max 255, and comparing against a
 * mirrored WebGPU frame collapsed that to 4.
 *
 * NOT FIXED IN THE MATERIAL. `createAdjustmentNodeMaterial()` is shared with
 * html/webgpu-migration/port/composite.html, which drives it as an ORTHO
 * fullscreen quad — a different binding arrangement, self-consistent without a
 * flip. Flipping the material fixed the app and broke 14 of that lab's 39
 * states. The material has exactly ONE production consumer (the mesh below), and
 * the defect is in how THIS pass binds it, so the correction belongs to this
 * geometry: shared code stays shared, and the lab keeps measuring the maths.
 */
export function flipAdjustmentGeoV(geo) {
  if (selectedBackend() !== 'webgpu') return geo;
  const uvAttr = geo.getAttribute('uv');
  if (!uvAttr) return geo;
  for (let i = 0; i < uvAttr.count; i += 1) uvAttr.setY(i, 1 - uvAttr.getY(i));
  uvAttr.needsUpdate = true;
  return geo;
}

export function buildCompositePipeline(engine, { camera, initW, initH, fov }) {
  const posedCamera = new THREE.PerspectiveCamera(fov, initW / initH, 1, 100000);
  posedCamera.position.copy(camera.position);
  engine.posedCamera = posedCamera;

  // ── Adjustment-layer compositing pipeline (ping-pong RTTs) ──
  // Ortho full-screen quad is used only to copy/blit render targets.
  const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const fsQuadGeo = new THREE.PlaneGeometry(2, 2);
  const blitMaterial = makeMaterial.blit() ?? createBlitMaterial();
  const blitScene = new THREE.Scene();
  blitScene.add(new THREE.Mesh(fsQuadGeo, blitMaterial));
  // Storage-identity copy for the sequence plate (see the refs' comment and
  // createBlitNodeMaterial). WebGL: the factory returns null and the plain blit
  // IS the identity, so the refs simply alias it.
  const pictureCopyMaterial = makeMaterial.pictureCopy() ?? createPictureCopyMaterial();
  const pictureCopyScene = new THREE.Scene();
  pictureCopyScene.add(new THREE.Mesh(fsQuadGeo, pictureCopyMaterial));
  engine.pictureCopyMaterial = pictureCopyMaterial;
  engine.pictureCopyScene = pictureCopyScene;
  const seqPlateCopyMaterial = makeMaterial.blit({ flipTexture: true }) ?? blitMaterial;
  let seqPlateCopyScene = blitScene;
  if (seqPlateCopyMaterial !== blitMaterial) {
    seqPlateCopyScene = new THREE.Scene();
    seqPlateCopyScene.add(new THREE.Mesh(fsQuadGeo, seqPlateCopyMaterial));
  }
  engine.seqPlateCopyMaterial = seqPlateCopyMaterial;
  engine.seqPlateCopyScene = seqPlateCopyScene;
  // Depth stamp: copies a model's depth into the accumulation buffer so later layers
  // can be cut by its real surface.
  const depthStampMaterial = makeMaterial.depthStamp() ?? createDepthStampMaterial();
  const depthStampScene = new THREE.Scene();
  depthStampScene.add(new THREE.Mesh(fsQuadGeo, depthStampMaterial));
  engine.depthStampMaterial = depthStampMaterial;
  engine.depthStampScene = depthStampScene;
  // Camera-baked 3D colour + its real depth land together. Unlike the fallback
  // stamp above, this can resolve two crossing 3D surfaces per pixel.
  const depthCompositeMaterial = makeMaterial.depthComposite() ?? createDepthCompositeMaterial();
  const depthCompositeScene = new THREE.Scene();
  depthCompositeScene.add(new THREE.Mesh(fsQuadGeo, depthCompositeMaterial));
  engine.depthCompositeMaterial = depthCompositeMaterial;
  engine.depthCompositeScene = depthCompositeScene;
  // A 3D pass with transparent surfaces composites in two draws, each with its own
  // material (compositeWithDepth): its opaque pixels writing depth, then a card in
  // front at its own depth without writing it — depth writing is pipeline state on
  // WebGPU, and each of these samplers only ever sees one kind of texture.
  const depthCompositeSplitMaterial = makeMaterial.depthComposite() ?? createDepthCompositeMaterial();
  depthCompositeSplitMaterial.uniforms.uPass.value = 1;
  const depthCompositeSplitScene = new THREE.Scene();
  depthCompositeSplitScene.add(new THREE.Mesh(fsQuadGeo, depthCompositeSplitMaterial));
  const depthCompositeTranslucentMaterial = makeMaterial.depthComposite() ?? createDepthCompositeMaterial();
  depthCompositeTranslucentMaterial.uniforms.uPass.value = 2;
  depthCompositeTranslucentMaterial.depthWrite = false;
  const depthCompositeTranslucentScene = new THREE.Scene();
  depthCompositeTranslucentScene.add(new THREE.Mesh(fsQuadGeo, depthCompositeTranslucentMaterial));
  engine.depthCompositeSplitMaterial = depthCompositeSplitMaterial;
  engine.depthCompositeSplitScene = depthCompositeSplitScene;
  engine.depthCompositeTranslucentMaterial = depthCompositeTranslucentMaterial;
  engine.depthCompositeTranslucentScene = depthCompositeTranslucentScene;
  // The same source again, for the pixels the tested draw REJECTED: something drawn
  // earlier stands in front there. Composited UNDER what is already in the stack
  // (premultiplied: dst + src·(1 − dst.a)), never writing depth — so a partly
  // transparent layer in front (a soft shadow, a 30 % tint) shows this surface through
  // its transparency instead of the empty comp, and an opaque one still hides it.
  const depthCompositeUnderMaterial = makeMaterial.depthComposite() ?? createDepthCompositeMaterial();
  depthCompositeUnderMaterial.depthWrite = false;
  depthCompositeUnderMaterial.depthFunc = THREE.GreaterDepth;
  depthCompositeUnderMaterial.blending = THREE.CustomBlending;
  depthCompositeUnderMaterial.blendEquation = THREE.AddEquation;
  depthCompositeUnderMaterial.blendSrc = THREE.OneMinusDstAlphaFactor;
  depthCompositeUnderMaterial.blendDst = THREE.OneFactor;
  depthCompositeUnderMaterial.blendEquationAlpha = THREE.AddEquation;
  depthCompositeUnderMaterial.blendSrcAlpha = THREE.OneMinusDstAlphaFactor;
  depthCompositeUnderMaterial.blendDstAlpha = THREE.OneFactor;
  const depthCompositeUnderScene = new THREE.Scene();
  depthCompositeUnderScene.add(new THREE.Mesh(fsQuadGeo, depthCompositeUnderMaterial));
  engine.depthCompositeUnderMaterial = depthCompositeUnderMaterial;
  engine.depthCompositeUnderScene = depthCompositeUnderScene;
  // A camera-locked backdrop held aside while the 3D stack composites over transparency
  // lands UNDER the finished stack (renderAdjustmentComposite, lockedLead). A storage
  // identity, like the sequence plate copy: it keeps the stack's own V axis on WebGPU.
  const backdropUnderMaterial = makeMaterial.blit({ flipTexture: true }) ?? createBlitMaterial();
  backdropUnderMaterial.depthTest = false;
  backdropUnderMaterial.depthWrite = false;
  backdropUnderMaterial.transparent = true;
  backdropUnderMaterial.blending = THREE.CustomBlending;
  backdropUnderMaterial.blendEquation = THREE.AddEquation;
  backdropUnderMaterial.blendSrc = THREE.OneMinusDstAlphaFactor;
  backdropUnderMaterial.blendDst = THREE.OneFactor;
  backdropUnderMaterial.blendEquationAlpha = THREE.AddEquation;
  backdropUnderMaterial.blendSrcAlpha = THREE.OneMinusDstAlphaFactor;
  backdropUnderMaterial.blendDstAlpha = THREE.OneFactor;
  const backdropUnderScene = new THREE.Scene();
  backdropUnderScene.add(new THREE.Mesh(fsQuadGeo, backdropUnderMaterial));
  engine.backdropUnderMaterial = backdropUnderMaterial;
  engine.backdropUnderScene = backdropUnderScene;
  const cameraDofMaterial = makeMaterial.cameraDof() ?? createCameraDofMaterial();
  const cameraDofScene = new THREE.Scene();
  cameraDofScene.add(new THREE.Mesh(fsQuadGeo, cameraDofMaterial));
  const cameraDofDepthMaterial = makeMaterial.cameraDofDepth() ?? createCameraDofDepthMaterial();
  const cameraDofDepthScene = new THREE.Scene();
  cameraDofDepthScene.add(new THREE.Mesh(fsQuadGeo, cameraDofDepthMaterial));
  // Full-screen mix pass: composite the adjusted result over the layers below at opacity.
  const mixMaterial = makeMaterial.mix() ?? createMixMaterial();
  const mixScene = new THREE.Scene();
  mixScene.add(new THREE.Mesh(fsQuadGeo, mixMaterial));
  // Full-screen clip-mask pass: below-composite kept only where the mask has coverage. Both inputs are
  // camera-rendered, so on WebGPU the pass samples them flipped (storage identity, like seqPlateCopyMaterial).
  const maskMaterial = makeMaterial.maskComposite({ flipTexture: true }) ?? createMaskCompositeMaterial();
  const maskScene = new THREE.Scene();
  maskScene.add(new THREE.Mesh(fsQuadGeo, maskMaterial));
  // Full-screen track-matte pass: ONE consumer layer's isolate kept only where
  // its matte source has coverage (alpha) or brightness (luma).
  //
  // Two bindings of the one pass (see createTrackMatteNodeMaterial). The matte
  // isolate is always camera-rendered; the consumer plate is a finished quad
  // plate at the top level (flipTexture) and may still be the raw camera
  // isolate inside a sequence (plain). On WebGL the factory returns null and
  // both names hold the one GLSL material, exactly as before.
  const trackMatteMaterial = makeMaterial.trackMatte({ flipTexture: true }) ?? createTrackMatteMaterial();
  const trackMatteScene = new THREE.Scene();
  trackMatteScene.add(new THREE.Mesh(fsQuadGeo, trackMatteMaterial));
  engine.trackMatteMaterial = trackMatteMaterial;
  engine.trackMatteScene = trackMatteScene;
  const trackMattePlainMaterial = makeMaterial.trackMatte() ?? trackMatteMaterial;
  let trackMattePlainScene = trackMatteScene;
  if (trackMattePlainMaterial !== trackMatteMaterial) {
    trackMattePlainScene = new THREE.Scene();
    trackMattePlainScene.add(new THREE.Mesh(fsQuadGeo, trackMattePlainMaterial));
  }
  engine.trackMattePlainMaterial = trackMattePlainMaterial;
  engine.trackMattePlainScene = trackMattePlainScene;
  // Full-screen flatten pass: the composite drawn OVER an opaque backdrop.
  const overBlitMaterial = makeMaterial.overBlit() ?? createOverBlitMaterial();
  const overBlitScene = new THREE.Scene();
  overBlitScene.add(new THREE.Mesh(fsQuadGeo, overBlitMaterial));
  const flattenScene = new THREE.Scene();
  // The graded adjustment quad is a perspective-camera plane, so it inherits
  // footage's exact transform (zoom/pan/rotate) for the camera-move on the below.
  const adjustmentGeo = flipAdjustmentGeoV(new THREE.PlaneGeometry(initW, initH));
  const adjustmentClipMesh = new THREE.Mesh(adjustmentGeo, makeMaterial.adjustment() ?? createAdjustmentMaterial());
  const adjustmentClipScene = new THREE.Scene();
  adjustmentClipScene.add(adjustmentClipMesh);
  engine.orthoCamera = orthoCamera;
  engine.adjustmentGeo = adjustmentGeo;
  engine.adjustmentClipMesh = adjustmentClipMesh;
  engine.adjustmentClipScene = adjustmentClipScene;
  engine.blitMaterial = blitMaterial;
  engine.blitScene = blitScene;
  engine.cameraDofMaterial = cameraDofMaterial;
  engine.cameraDofScene = cameraDofScene;
  engine.cameraDofDepthMaterial = cameraDofDepthMaterial;
  engine.cameraDofDepthScene = cameraDofDepthScene;
  engine.mixMaterial = mixMaterial;
  engine.mixScene = mixScene;
  engine.maskMaterial = maskMaterial;
  engine.maskScene = maskScene;
  engine.overBlitMaterial = overBlitMaterial;
  engine.overBlitScene = overBlitScene;
  engine.flattenScene = flattenScene;
  // Adjustment-layer effect chain: one full-screen quad whose material is swapped
  // per effect (over the SHARED fsQuadGeo). Effect materials are compiled/cached
  // lazily in effectMaterialsRef; the placeholder material is never rendered as-is.
  const effectMesh = new THREE.Mesh(fsQuadGeo, blitMaterial);
  const effectScene = new THREE.Scene();
  effectScene.add(effectMesh);
  engine.effectMesh = effectMesh;
  engine.effectScene = effectScene;
  // Running Glow / Motion Blur / Motion Trail: built on first use (see the
  // ensure* helpers next to sweepPassPool), so a project without them never
  // compiles their shaders. Keep the factory and the shared quad for that, and
  // clear the refs — this block runs again on a renderer rebuild.
  engine.materialFactory = makeMaterial;
  engine.fsQuadGeo = fsQuadGeo;
  engine.glowMaterials = null; engine.glowMesh = null; engine.glowScene = null;
  engine.motionBlurMaterial = null; engine.motionBlurMesh = null; engine.motionBlurScene = null;
  engine.motionTrailMaterial = null; engine.motionTrailMesh = null; engine.motionTrailScene = null;
  engine.trailPass = null;
  // Echo's three materials are built ON FIRST USE (renderEchoStack), not here:
  // two of them duplicate Motion Trail's warp and compose, and a project that
  // never uses Echo should not pay to build materials it will never draw.
  // Cleared rather than left alone, because this block runs again when the
  // renderer is rebuilt — a stale WebGL material handed to WebGPURenderer
  // draws nothing and throws nothing.
  engine.echoPass = null;
  // Same contract as Echo's: built on first use, cleared on renderer rebuild
  // so a stale WebGL material is never handed to WebGPURenderer.
  engine.timeshiftPass = null;
  engine.backdropPass = null;
  engine.glassPass = null;
  engine.blendPass = null;
  const motionBlurMixMaterial = makeMaterial.motionBlurMix() ?? createMotionBlurMixMaterial();
  const motionBlurMixMesh = new THREE.Mesh(fsQuadGeo, motionBlurMixMaterial);
  const motionBlurMixScene = new THREE.Scene();
  motionBlurMixScene.add(motionBlurMixMesh);
  engine.motionBlurMixMaterial = motionBlurMixMaterial;
  engine.motionBlurMixMesh = motionBlurMixMesh;
  engine.motionBlurMixScene = motionBlurMixScene;
  // Per-layer Overlay Effects: cut the chain result back to the layer's own
  // silhouette. Rendered on the effect quad, so it follows the same convention.
  const matteClipMaterial = makeMaterial.matteClip() ?? createMatteClipMaterial();
  engine.matteClipMaterial = matteClipMaterial;
  // A 3D model's isolate already arrives in the effect chain's orientation, so
  // it needs the variant that does NOT flip the matte. On WebGL both are the
  // same material — the flip is a WebGPU-only correction.
  engine.matteClipPlainMaterial = makeMaterial.matteClip({ flipMatte: false }) ?? matteClipMaterial;
  // Render targets are created lazily on first use, sized to the drawing buffer.
  engine.adjustmentRT = null;
  engine.overlayFxRT = null;
  // what disposeCompositePipeline releases: exactly the objects built here
  engine.pipelineBuilt = {
    fsQuadGeo, blitMaterial, seqPlateCopyMaterial, depthStampMaterial, depthCompositeMaterial, cameraDofMaterial,
    cameraDofDepthMaterial, depthCompositeSplitMaterial, depthCompositeTranslucentMaterial,
    mixMaterial, maskMaterial, trackMatteMaterial, trackMattePlainMaterial, overBlitMaterial, adjustmentClipMesh,
    matteClipMaterial,
  };
}

// The pipeline's share of the renderer teardown, in the order the Player's teardown released it.
export function disposeCompositePipeline(engine) {
  const b = engine.pipelineBuilt;
  if (!b) return;
  engine.pipelineBuilt = null;
  b.matteClipMaterial.dispose();
  b.fsQuadGeo.dispose();
  b.blitMaterial.dispose();
  if (b.seqPlateCopyMaterial !== b.blitMaterial) b.seqPlateCopyMaterial.dispose();
  b.depthStampMaterial.dispose();
  b.depthCompositeMaterial.dispose();
  b.depthCompositeSplitMaterial.dispose();
  b.depthCompositeTranslucentMaterial.dispose();
  b.cameraDofMaterial.dispose();
  b.cameraDofDepthMaterial.dispose();
  b.mixMaterial.dispose();
  b.maskMaterial.dispose();
  b.trackMatteMaterial.dispose();
  if (b.trackMattePlainMaterial !== b.trackMatteMaterial) b.trackMattePlainMaterial.dispose();
  b.overBlitMaterial.dispose();
  b.adjustmentClipMesh.material.dispose();
  engine.adjustmentGeo?.dispose();
  // Lazily built (ensure* helpers): dispose whatever was actually built.
  engine.glowMaterials?.pre?.dispose();
  engine.glowMaterials?.main?.dispose();
  engine.motionBlurMaterial?.dispose();
  engine.motionTrailMaterial?.dispose();
  const trailPass = engine.trailPass;
  if (trailPass) { trailPass.warp?.dispose(); trailPass.acc?.dispose(); trailPass.erode?.dispose(); trailPass.compose?.dispose(); }
}
