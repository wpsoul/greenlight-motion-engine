/*
 * Per-layer passes (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 16 — moved verbatim out of the Player with
 * tests/engine-extraction/tools/convert_leaf.py: `xRef.current` → `engine.x`, engine-backed handles → their engine
 * functions): Chroma Key and Silhouette Framing (keyed off the layer's isolate), Depth Scan, Grow Fill (the
 * geodesic field), Fresnel Rim and Pryzm — each draws one layer's plate through its own pass, built on first use —
 * and plateToCameraAxis (a plate flipped back onto the camera's axis for the passes that need it).
 *
 * Engine fields: renderer, orthoCamera, camera, blit*, seqPlateCopy*, the passes (chromaKeyPass, silhouetteFramingPass,
 * depthScanRig, autoFillRig, pryzmPass — released with the renderer), maskCoverageStamp, videoSize, isPlaying,
 * exporting, renderFrame (a repaint when an async bake lands).
 */
import * as THREE from 'three';
import { effectWindowAt } from '../adjustmentEffects';
import { applyAutoFillUniforms, autoFillBakeParams, createAutoFillMaterial, getAutoFillEffect, resolveAutoFillParams } from '../autoFillLayer';
import { getAutofillField } from '../autofillField';
import { hasBorderKeyframes, withBorderKeyframes } from '../borderKeyframes';
import { applyChromaKeyUniforms, createChromaKeyMaterials, isChromaKeyEnabled, resolveChromaKeyParams } from '../chromaKeyLayer';
import { applyDepthScanUniforms, createDepthScanMaterial, depthScanPhase, depthScanSource, getDepthScanEffect, resolveDepthScanParams } from '../depthScanLayer';
import { fresnelRimFxModule, fresnelRimPhase, getFresnelRimEffect, resolveFresnelRimParams } from '../fresnelRimLayer';
import { getItemKeyframeValues, integratePathRate } from '../gsapTransitions';
import { materials as makeMaterial, swapWarpMaterialForBackend } from '../materialFactory';
import { applyPryzmUniforms, createPryzmPass } from '../pryzmLayer';
import { applySilhouetteFramingUniforms, createSilhouetteFramingMaterials } from '../silhouetteFraming';
import { selectedBackend } from '../videoRenderer';
import { computeLayerBox } from './layerWarps';
import { ensurePassTarget as ensurePassTargetInEngine } from './passPool';
import { ensurePryzmSource as ensurePryzmSourceInEngine } from './renderTargets';

export function applyChromaKey(engine, src, ck, t, camAxis = true, pxScaleOverride = null) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  if (!renderer || !orthoCamera || !src || !ck?.item || !ck?.entry) return false;
  const entry = ck.entry;
  const dur = entry.endTime - entry.startTime;
  const progress = dur > 0 ? Math.max(0, Math.min(1, (t - entry.startTime) / dur)) : 0;
  const params = resolveChromaKeyParams(ck.item, getItemKeyframeValues(ck.item, progress));
  if (!(params.ckAmount > 0.01)) return false;

  let pass = engine.chromaKeyPass;
  if (!pass) {
    const mats = makeMaterial.chromaKey() ?? createChromaKeyMaterials();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mats.key);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    pass = { scene, mesh, mats };
    engine.chromaKeyPass = pass;
  }
  const { scene, mesh, mats } = pass;
  // Choke / feather / wrap are authored in COMPOSITION px; the isolate is the
  // composition at the render's supersample, so one comp px is this many texels.
  // A plate that is NOT the composition (the 3D view keys the layer's own box,
  // engine/worldLayerFx.js) passes its own texels-per-comp-px instead.
  const pxScale = pxScaleOverride > 0 ? pxScaleOverride : src.width / Math.max(1, engine.videoSize?.w || src.width);
  const { needsChoke } = applyChromaKeyUniforms(mats, params, { width: src.width, height: src.height, pxScale });

  // Keyed by SIZE (the lm:apply precedent): consumed inside this call, never
  // read across layers, shared by the compositor flows whose plates match.
  const a = ensurePassTargetInEngine(engine, `ck:a:${src.width}x${src.height}`, src.width, src.height, false);
  const b = ensurePassTargetInEngine(engine, `ck:b:${src.width}x${src.height}`, src.width, src.height, false);
  const blitScene = engine.blitScene;
  const blitMaterial = engine.blitMaterial;
  if (!a || !b || !blitScene || !blitMaterial) return false;
  const draw = (material, target) => {
    mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, orthoCamera);
  };
  const flip = camAxis ? 1 : 0;
  mats.key.uniforms.uTexture.value = src.texture;
  if (mats.key.uniforms.uFlipV) mats.key.uniforms.uFlipV.value = flip;
  draw(mats.key, a);
  let keyed = a;
  if (needsChoke) {
    mats.choke.uniforms.uTexture.value = a.texture;
    draw(mats.choke, b);
    keyed = b;
  }
  const dest = keyed === a ? b : a;
  mats.out.uniforms.uTexture.value = keyed.texture;
  mats.out.uniforms.uSource.value = src.texture;
  if (mats.out.uniforms.uFlipV) mats.out.uniforms.uFlipV.value = flip;
  draw(mats.out, dest);

  /*
   * COPY BACK — and the CHOKE DECIDES WHICH COPY.
   *
   * On WebGPU every full-screen pass into a render target re-stores its result
   * on the opposite V axis, so the flip cancels on an EVEN number of hops and
   * survives on an odd one. This function runs a different number depending on
   * a setting: key -> out -> copy is three, and key -> choke -> out -> copy is
   * four. So the keyed layer came out upside down with choke off and upright
   * with choke on — the same effect, mirrored or not according to a slider
   * nobody would connect to orientation. Measured on an asymmetric plate
   * through the real render page: choke off, WebGL centre of mass 0.638 against
   * WebGPU 0.362 — the exact mirror; choke on, both 0.642.
   *
   * The fix is to make the total even in both cases by choosing the copy. The
   * storage-identity copy adds no flip, the plain blit adds one, and the two
   * odd cases are exactly the ones the choke does not cover. On WebGL the
   * factory returns null and the identity IS the plain blit, so that backend
   * is byte-for-byte unchanged.
   */
  const identityCopyScene = engine.seqPlateCopyScene;
  const identityCopyMaterial = engine.seqPlateCopyMaterial;
  const evenAlready = needsChoke;   // key + choke + out = three mirrors, + the copy = four
  const copyMaterial = evenAlready || !identityCopyMaterial ? blitMaterial : identityCopyMaterial;
  const copyScene = copyMaterial === blitMaterial ? blitScene : identityCopyScene;
  copyMaterial.uniforms.uTexture.value = dest.texture;
  renderer.setRenderTarget(src);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(copyScene, orthoCamera);
  return true;
}

export function renderLayerDepthScan(engine, srcTarget, scan, layerMesh, chCam, t, flipPlate = false) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  if (!renderer || !orthoCamera || !layerMesh || !srcTarget || !scan?.item || !scan?.entry) return srcTarget;
  const { item, entry } = scan;
  // No map yet (the panel is still offering "Analyse depth"): render nothing
  // rather than a slice through an empty texture, which would paint the whole
  // layer at depth 0.
  const source = depthScanSource(item);
  if (!source) return srcTarget;
  const box = computeLayerBox(layerMesh, chCam || engine.camera, srcTarget.width, srcTarget.height);
  if (!box) return srcTarget;
  const duration = entry.endTime - entry.startTime;
  const progress = duration > 0 ? Math.max(0, Math.min(1, (t - entry.startTime) / duration)) : 0;
  const params = resolveDepthScanParams(item, getItemKeyframeValues(item, progress));
  if (!(params.scnAmount > 0.01)) return srcTarget;

  /*
   * Active Range — the Overlay Effects window, on this entry, in clip-local
   * seconds. Outside it the stage is skipped entirely (the plate passes
   * through untouched, which is cheaper than drawing a zero-amount pass).
   *
   * Inside it the CLOCK IS REBASED, which is the whole point of a window on a
   * cyclic effect: the sweep is `scnPhase + scnSpeed x seconds`, so on the raw
   * clip clock a window opening at 2 s would catch the scan already two
   * seconds into its travel — it would appear mid-sweep, at an arbitrary
   * depth. Rebasing makes the slice start where scnPhase says, every time,
   * wherever the window sits. Keyframes deliberately stay on the CLIP clock:
   * a track the user drew against the timeline must not slide with the window.
   */
  const clipNow = Math.max(0, t - entry.startTime);
  const scnWin = effectWindowAt(getDepthScanEffect(item), clipNow, duration);
  if (scnWin && scnWin.amount <= 0) return srcTarget;
  const sweepNow = scnWin ? scnWin.time : clipNow;

  // Normalise a camera-axis isolate into WebGL storage layout first — the
  // second of this stage's two hops. See the note above.
  let plate = srcTarget;
  if (flipPlate) {
    const norm = ensurePassTargetInEngine(engine, `scn:norm:${srcTarget.width}x${srcTarget.height}`, srcTarget.width, srcTarget.height, false);
    const bScene = engine.blitScene;
    const bMaterial = engine.blitMaterial;
    if (norm && bScene && bMaterial) {
      bMaterial.uniforms.uTexture.value = srcTarget.texture;
      renderer.setRenderTarget(norm);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(bScene, orthoCamera);
      plate = norm;
    }
  }

  let rig = engine.depthScanRig;
  if (!rig) {
    const material = makeMaterial.depthScan() ?? createDepthScanMaterial();
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    rig = { scene, mesh, material };
    engine.depthScanRig = rig;
  }
  applyDepthScanUniforms(rig.material, params, {
    width: plate.width,
    height: plate.height,
    box,
    phase: depthScanPhase(params, sweepNow),
    depthTexture: source.texture,
    depthSize: source.size,
    invert: source.invert,
  });
  rig.material.uniforms.uTexture.value = plate.texture;
  const dest = ensurePassTargetInEngine(engine, `scn:${item.id}`, plate.width, plate.height, false);
  if (!dest) return srcTarget;
  renderer.setRenderTarget(dest);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(rig.scene, orthoCamera);
  return dest;
}

export function renderLayerAutoFill(engine, srcTarget, af, layerMesh, t, flipPlate = false) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  if (!renderer || !orthoCamera || !layerMesh) return srcTarget;
  const { item, entry } = af;
  let plate = srcTarget;
  if (flipPlate) {
    // srcTarget is the camera-rendered isolate. WebGPU stores it with the
    // view's top row in texture row 0 — the opposite of WebGL — and every
    // downstream consumer here (the bake's crop pass, the style material)
    // was ported against WebGL storage. The PLAIN blit is the normalizer:
    // on WebGPU a geometry-uv blit mirrors texture storage, producing the
    // WebGL layout; on WebGL the same blit is identity, where the isolate
    // is already stored that way (PORTING-GUIDE §3, point 6).
    const norm = ensurePassTargetInEngine(engine, `af:norm:${srcTarget.width}x${srcTarget.height}`, srcTarget.width, srcTarget.height, false);
    const bScene = engine.blitScene;
    const bMaterial = engine.blitMaterial;
    if (norm && bScene && bMaterial) {
      bMaterial.uniforms.uTexture.value = srcTarget.texture;
      renderer.setRenderTarget(norm);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(bScene, orthoCamera);
      plate = norm;
    }
  }
  const box = computeLayerBox(layerMesh, engine.camera, plate.width, plate.height);
  if (!box) return srcTarget;
  const duration = entry.endTime - entry.startTime;
  const progress = duration > 0 ? Math.max(0, Math.min(1, (t - entry.startTime) / duration)) : 0;
  const params = resolveAutoFillParams(item, getItemKeyframeValues(item, progress));
  // Grow Speed advances the fill on its own (afSpeed %/s of clip time), on top
  // of the Start Fill offset — no keyframes required. A keyed speed track is
  // INTEGRATED (like Neon Glow's rate tracks), so a ramp accelerates the front
  // smoothly instead of teleporting it; everything stays a pure function of
  // (track, time) for the deterministic export.
  const clipNow = Math.max(0, t - entry.startTime);
  const grown = integratePathRate(item, 'afSpeed', params.afSpeed, clipNow, duration);
  const effProgress = Math.min(100, params.afProgress + grown);
  const eff = getAutoFillEffect(item);
  // The mask stamp varies the cache key: an animated mask changes the alpha this
  // field is baked from without changing the item object, and the cache keys on
  // (paramsKey, itemRef) alone would keep serving the frame-0 arrival field. It
  // is handed over separately from the instance id because the bake is async —
  // while a new stamp's field bakes, the module serves this INSTANCE's previous
  // field rather than nothing.
  const field = getAutofillField(
    renderer, plate.texture, box,
    autoFillBakeParams(params),
    eff?.eid || item.id,
    item,
    engine.maskCoverageStamp.get(item.id)
  );
  let rig = engine.autoFillRig;
  if (!rig) {
    const material = makeMaterial.autoFill() ?? createAutoFillMaterial();
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    scene.add(mesh);
    rig = { scene, mesh, material };
    engine.autoFillRig = rig;
  }
  applyAutoFillUniforms(rig.material, { ...params, afProgress: effProgress }, {
    width: plate.width, height: plate.height, box, field,
  });
  rig.material.uniforms.uTexture.value = plate.texture;
  const dest = ensurePassTargetInEngine(engine, `af:${item.id}`, plate.width, plate.height, false);
  if (!dest) return srcTarget;
  renderer.setRenderTarget(dest);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(rig.scene, orthoCamera);
  return dest;
}

export function applySilhouetteFraming(engine, src, ck, mesh, t, camAxis = true) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  if (!renderer || !orthoCamera || !src || !ck?.item || !ck?.entry || !mesh) return false;
  const entry = ck.entry;
  const dur = entry.endTime - entry.startTime;
  const progress = dur > 0 ? Math.max(0, Math.min(1, (t - entry.startTime) / dur)) : 0;
  // Border tracks ride along: the pass strokes this frame's width and colour.
  const item = hasBorderKeyframes(ck.item) ? withBorderKeyframes(ck.item, getItemKeyframeValues(ck.item, progress)) : ck.item;
  // The matte / status views are diagnostics of the KEY — no framing on them.
  if (isChromaKeyEnabled(item)) {
    const ckParams = resolveChromaKeyParams(item, getItemKeyframeValues(item, progress));
    if (Math.round(ckParams.ckView) > 0) return false;
  }

  let pass = engine.silhouetteFramingPass;
  if (!pass) {
    const mats = makeMaterial.silhouetteFraming() ?? createSilhouetteFramingMaterials();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mats.distH);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    pass = { scene, quad, mats };
    engine.silhouetteFramingPass = pass;
  }
  const { scene, quad, mats } = pass;
  const layerScale = Number.isFinite(mesh.userData?.layerScale) ? mesh.userData.layerScale : 1;
  const pxScale = (src.width / Math.max(1, engine.videoSize?.w || src.width)) * Math.max(0.01, layerScale);
  const opacityUniform = mesh.material?.uniforms?.uOpacity?.value;
  const opacity = Number.isFinite(opacityUniform) ? opacityUniform : 1;
  const spec = applySilhouetteFramingUniforms(mats, item, { width: src.width, height: src.height, pxScale, opacity });
  if (!spec) return false;

  // Keyed by SIZE (the ck:a/ck:b precedent): consumed inside this call, never
  // read across layers. The compose destination reuses the key's pooled `ck:a`
  // — the key is finished with it by the time this runs.
  const distH = ensurePassTargetInEngine(engine, `sf:h:${src.width}x${src.height}`, src.width, src.height, true);
  const distV = ensurePassTargetInEngine(engine, `sf:v:${src.width}x${src.height}`, src.width, src.height, true);
  const dest = ensurePassTargetInEngine(engine, `ck:a:${src.width}x${src.height}`, src.width, src.height, false);
  const blitScene = engine.blitScene;
  const blitMaterial = engine.blitMaterial;
  if (!distH || !distV || !dest || !blitScene || !blitMaterial) return false;
  const draw = (material, target) => {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, orthoCamera);
  };
  const flip = camAxis ? 1 : 0;
  mats.distH.uniforms.uTexture.value = src.texture;
  mats.distH.uniforms.uFlipV.value = flip;
  draw(mats.distH, distH);
  mats.distV.uniforms.uTexture.value = distH.texture;
  draw(mats.distV, distV);
  mats.compose.uniforms.uTexture.value = src.texture;
  mats.compose.uniforms.uSdf.value = distV.texture;
  mats.compose.uniforms.uFlipV.value = flip;
  draw(mats.compose, dest);
  // compose + copy = two hops: even, so the plain blit is the right copy here
  // (the chroma pass's choke-on case).
  blitMaterial.uniforms.uTexture.value = dest.texture;
  renderer.setRenderTarget(src);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(blitScene, orthoCamera);
  return true;
}

export function renderLayerFresnelRim(engine, srcTarget, fr, layerMesh, chCam, t, flipPlate = false) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  if (!renderer || !orthoCamera || !layerMesh || !srcTarget || !fr?.item || !fr?.entry) return srcTarget;
  const { item, entry } = fr;
  const source = depthScanSource(item);
  if (!source) return srcTarget;
  const fxm = fresnelRimFxModule(() => {
    if (!engine.exporting && !engine.isPlaying) engine.renderFrame?.();
  });
  if (!fxm) return srcTarget;
  const box = computeLayerBox(layerMesh, chCam || engine.camera, srcTarget.width, srcTarget.height);
  if (!box) return srcTarget;
  const duration = entry.endTime - entry.startTime;
  const progress = duration > 0 ? Math.max(0, Math.min(1, (t - entry.startTime) / duration)) : 0;
  const params = resolveFresnelRimParams(item, getItemKeyframeValues(item, progress));
  if (!(params.frIntensity > 1e-4)) return srcTarget;
  // Active Range, with the sweep clock rebased inside it (Depth Scan's rule).
  const clipNow = Math.max(0, t - entry.startTime);
  const win = effectWindowAt(getFresnelRimEffect(item), clipNow, duration);
  if (win && win.amount <= 0) return srcTarget;
  const sweepNow = win ? win.time : clipNow;
  let plate = srcTarget;
  if (flipPlate) {
    const norm = ensurePassTargetInEngine(engine, `fr:norm:${srcTarget.width}x${srcTarget.height}`, srcTarget.width, srcTarget.height, false);
    const bScene = engine.blitScene;
    const bMaterial = engine.blitMaterial;
    if (norm && bScene && bMaterial) {
      bMaterial.uniforms.uTexture.value = srcTarget.texture;
      renderer.setRenderTarget(norm);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(bScene, orthoCamera);
      plate = norm;
    }
  }
  const dest = ensurePassTargetInEngine(engine, `fr:${item.id}`, plate.width, plate.height, false);
  if (!dest) return srcTarget;
  const out = fxm.runFlatFresnelRim(renderer, {
    src: plate,
    dst: dest,
    target: (name, level, w, h) => ensurePassTargetInEngine(engine, `fr:${name}:${item.id}`, w, h, false),
    box,
    depth: source,
    params,
    phase: fresnelRimPhase(params, sweepNow),
    time: sweepNow,
  });
  return out ? dest : srcTarget;
}

export function renderLayerPryzm(engine, srcTarget, outTarget, params, layerMesh, chCam, localTime, flipPlate = false, boxOverride = null) {
  const renderer = engine.renderer;
  /*
   * THE STORAGE-IDENTITY COPY, and it is not optional.
   *
   * A plain-uv blit re-stores a plate on the OPPOSITE V axis under WebGPU —
   * the same defect that put every composited sequence upside down. This blit
   * adds a hop that `flipPlate` (which describes srcTarget's provenance)
   * knows nothing about, so on WebGPU the glass read the plate mirrored and
   * the whole layer came out flipped while WebGL was fine. Measured:
   * tests/pryzm/verify_render.js --backend webgpu, `lattice is upright on row`
   * reported d(upright)=26.1 against d(mirrored)=2.6.
   *
   * seqPlateCopyMaterial is the storage-identity copy built for exactly this
   * (it aliases the plain blit on WebGL), so mipSrc keeps srcTarget's V axis
   * and `flipPlate` stays the right answer on both backends.
   */
  const copyScene = engine.seqPlateCopyScene;
  const copyMaterial = engine.seqPlateCopyMaterial;
  if (!renderer || !layerMesh || !chCam || !copyScene || !copyMaterial) return srcTarget;
  const box = boxOverride || computeLayerBox(layerMesh, chCam, srcTarget.width, srcTarget.height);
  if (!box) return srcTarget;
  let pass = engine.pryzmPass;
  if (!pass) {
    pass = swapWarpMaterialForBackend('pryzm', createPryzmPass());
    engine.pryzmPass = pass;
  }
  // Copy the isolate into the mipped target; three generates the chain when
  // the target is unbound by the next setRenderTarget.
  const mipSrc = ensurePryzmSourceInEngine(engine, srcTarget.width, srcTarget.height);
  copyMaterial.uniforms.uTexture.value = srcTarget.texture;
  renderer.setRenderTarget(mipSrc);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(copyScene, engine.orthoCamera);
  pass.material.uniforms.uTexture.value = mipSrc.texture;
  if (pass.material.uniforms.uFlipV) pass.material.uniforms.uFlipV.value = flipPlate ? 1 : 0;
  applyPryzmUniforms(pass.material, params, box, localTime);
  renderer.setRenderTarget(outTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(pass.scene, engine.orthoCamera);
  return outTarget;
}

export function plateToCameraAxis(engine, src) {
  if (selectedBackend() !== 'webgpu') return src;
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  const blitScene = engine.blitScene;
  const blitMaterial = engine.blitMaterial;
  // Keyed by SIZE (the lm:apply precedent): consumed by the very next pass.
  const dest = ensurePassTargetInEngine(engine, `axis:cam:${src.width}x${src.height}`, src.width, src.height, false);
  if (!renderer || !orthoCamera || !blitScene || !blitMaterial || !dest) return src;
  blitMaterial.uniforms.uTexture.value = src.texture;
  renderer.setRenderTarget(dest);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(blitScene, orthoCamera);
  return dest;
}
