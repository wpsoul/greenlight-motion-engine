/*
 * Chroma Key and Layer Mask in the 3D view.
 *
 * The 3D view draws every layer's own card (frameRender's world branch) and skips the compositor, so the passes that
 * run on a layer's isolate in the 2D view never ran there: a keyed green screen stayed green and a masked layer showed
 * whole. These two are the effects that change the layer's SHAPE — the thing a camera move is framed against.
 *
 * For a layer with either one on, its card material is drawn flat into a plate in the layer's own box, the SAME
 * passes run on it in the 2D view's order (applyChromaKey → applyLayerMask, the pre-transition stack's V-axis
 * bookkeeping — effectChain.js), and the card shows that plate through a neutral clip material for the one world-view
 * draw. Feeding a plate back through a clip material is the effectChain carrier precedent: the colour path into the
 * 3D view's draw stays the one every other card takes.
 *
 * Cost: per keyed/masked layer and world-view frame, one card draw + the keyer's 2–3 passes and a copy + the mask's
 * pass and a copy, at the layer's own size capped at PLATE_MAX_EDGE. Nothing for any other layer or project: the
 * gates are the compositor's own predicates.
 *
 *   prepareWorldLayerFx(engine, layers, t)   → swaps; call right before worldView.render()
 *   restoreWorldLayerFx(swaps)              put each card's own material back after the draw
 *   releaseWorldLayerFx(engine)             free the cached carriers (3D view closed, engine torn down)
 */
import * as THREE from 'three';
import { isChromaKeyEnabled } from '../chromaKeyLayer';
import { createClipMaterial, resetMaterialUniforms, resumeBlendMode, suspendBlendMode } from '../clipShader';
import { isLayerMaskEnabled } from '../layerMask';
import { materials as makeMaterial } from '../materialFactory';
import { applyChromaKey } from './layerPasses';
import { applyLayerMask } from './layerStages';
import { ensurePassTarget } from './passPool';

// The 3D view is an authoring view; the model plates' bake uses the same cap (model3dLayer.js).
const PLATE_MAX_EDGE = 1536;

function ensureEntry(engine, itemId) {
  let entry = engine.worldFxPlates.get(itemId);
  if (!entry) {
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh();
    mesh.frustumCulled = false;
    scene.add(mesh);
    const camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 2);
    camera.position.set(0, 0, 1);
    camera.updateMatrixWorld(true);
    entry = { scene, mesh, camera, carrier: null };
    engine.worldFxPlates.set(itemId, entry);
  }
  return entry;
}

function disposeEntry(entry) {
  entry.mesh.geometry = null;
  entry.mesh.material = null;
  try { entry.carrier?.dispose(); } catch { /* no-op */ }
  entry.carrier = null;
}

/**
 * `layers` are the world branch's records ({ item, mesh, entry }) — only cards still visible are looked at, so the
 * models, plates, rig, particles and grids it lent real geometry for are skipped. Returns the cards whose material was
 * swapped, for restoreWorldLayerFx.
 */
export function prepareWorldLayerFx(engine, layers, t) {
  const swaps = [];
  const used = new Set();
  const renderer = engine.renderer;
  if (renderer) {
    for (const layer of layers) {
      const { item, mesh, entry: span } = layer;
      if (!item || !span || !mesh?.visible) continue;
      const keyed = isChromaKeyEnabled(item);
      const masked = isLayerMaskEnabled(item);
      if (!keyed && !masked) continue;
      const material = mesh.material;
      const geo = mesh.geometry;
      if (!material?.uniforms?.uTexture || !geo) continue;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      // The card's size in composition px, and a plate with square texels in the layer's own space.
      const compW = (bb.max.x - bb.min.x) * Math.abs(mesh.scale.x);
      const compH = (bb.max.y - bb.min.y) * Math.abs(mesh.scale.y);
      if (!(compW > 1) || !(compH > 1)) continue;
      const fit = Math.min(1, PLATE_MAX_EDGE / Math.max(compW, compH));
      const pw = Math.max(2, Math.round(compW * fit));
      const ph = Math.max(2, Math.round(compH * fit));
      const plate = ensurePassTarget(engine, `w3d:${item.id}`, pw, ph, false);
      if (!plate) continue;

      // The card, flat, exactly as this frame's uniforms left it (the 2D isolate's input, minus the camera).
      const fx = ensureEntry(engine, item.id);
      used.add(item.id);
      fx.mesh.geometry = geo;
      fx.mesh.material = material;
      // A video's mask lives in the frame-sized box around its picture (layerMesh.js fxFrame), not on the card.
      fx.mesh.userData.fxFrame = mesh.userData?.fxFrame || null;
      fx.mesh.userData.mediaFrac = mesh.userData?.mediaFrac || null;
      const cam = fx.camera;
      cam.left = bb.min.x;
      cam.right = bb.max.x;
      cam.top = bb.max.y;
      cam.bottom = bb.min.y;
      cam.updateProjectionMatrix();
      suspendBlendMode(material);
      renderer.setRenderTarget(plate);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(fx.scene, cam);
      resumeBlendMode(material);

      // The 2D order: key first, then the mask on the keyed silhouette. Each rewrites the plate in place through
      // an ortho quad, which is what camAxis tracks (effectChain.js, the pre-transition stack).
      const texelsPerCompPx = pw / compW;
      const span2d = { item, entry: span };
      let camAxis = true;
      let changed = false;
      if (keyed && applyChromaKey(engine, plate, span2d, t, camAxis, texelsPerCompPx)) { camAxis = false; changed = true; }
      if (masked && applyLayerMask(engine, plate, span2d, fx.mesh, cam, t, texelsPerCompPx, camAxis)) { camAxis = false; changed = true; }
      // Both bypassed at this time (amount 0, no usable mask): the card is already right.
      if (!changed) continue;

      if (!fx.carrier) fx.carrier = makeMaterial.clip() ?? createClipMaterial();
      const carrier = fx.carrier;
      resetMaterialUniforms(carrier);
      const u = carrier.uniforms;
      u.uTexture.value = plate.texture;
      u.uResolution.value.set(pw, ph);
      u.uCanvasSize.value.set(compW, compH);
      // The plate is one of the compositor's own targets: premultiplied (layerMesh.js override textures).
      u.uInputPremultiplied.value = 1;
      // resetMaterialUniforms cleared uInputFlipV, and both passes leave the plate quad-axis, which this plane
      // reads upright on either backend (effectChain.js flips only a camera-axis plate).
      // The 3D view's depth mode, as setLayerDepthMode gives every card.
      if (u.uDepthCut) u.uDepthCut.value = 1;
      carrier.depthTest = true;
      carrier.depthWrite = true;
      carrier.userData.textureSource = `__world_fx__:${item.id}`;
      swaps.push({ mesh, material });
      mesh.material = carrier;
    }
  }
  for (const [id, entry] of engine.worldFxPlates) {
    if (used.has(id)) continue;
    disposeEntry(entry);
    engine.worldFxPlates.delete(id);
  }
  return swaps;
}

export function restoreWorldLayerFx(swaps) {
  for (const { mesh, material } of swaps) mesh.material = material;
}

export function releaseWorldLayerFx(engine) {
  for (const entry of engine.worldFxPlates.values()) disposeEntry(entry);
  engine.worldFxPlates.clear();
}
