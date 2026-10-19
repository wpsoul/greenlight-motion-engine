/*
 * The effect passes that are built on FIRST USE (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 9 — moved
 * verbatim out of the Player, `xRef.current` → `engine.x`): Running Glow, Motion Blur, Motion Trail (+ its trail
 * pass), Backdrop Blur, Glass and the destination-reading blend pass.
 *
 * A project that never uses one never compiles its shaders. buildCompositePipeline stores the material factory and
 * the shared quad (engine.materialFactory / engine.fsQuadGeo) and clears these fields, and the pipeline's dispose
 * clears them again, so a stale WebGL material never meets WebGPURenderer after a rebuild. Each returns null while
 * the pipeline has no quad yet.
 */
import * as THREE from 'three';
import { createRunningGlowMaterials } from '../runningGlow';
import { createMotionBlurMaterial } from '../motionBlurLayer';
import {
  createMotionTrailMaterial, createTrailWarpMaterial, createTrailAccMaterial, createTrailErodeMaterial, createTrailComposeMaterial,
} from '../motionTrailLayer';
import { createBackdropBlurMaterial, createBackdropMixMaterial } from '../backdropBlur';
import { createGlassMaterial } from '../glassEffect';
import { createBlendCompositeMaterial } from '../blendComposite';

export function ensureGlowMaterials(engine) {
  if (engine.glowMaterials) return engine.glowMaterials;
  const geo = engine.fsQuadGeo;
  if (!geo) return null;
  const materials = engine.materialFactory?.runningGlow?.() ?? createRunningGlowMaterials();
  const mesh = new THREE.Mesh(geo, materials.pre);
  const scene = new THREE.Scene();
  scene.add(mesh);
  engine.glowMaterials = materials;
  engine.glowMesh = mesh;
  engine.glowScene = scene;
  return materials;
}

export function ensureMotionBlurMaterial(engine) {
  if (engine.motionBlurMaterial) return engine.motionBlurMaterial;
  const geo = engine.fsQuadGeo;
  if (!geo) return null;
  const material = engine.materialFactory?.motionBlur?.() ?? createMotionBlurMaterial();
  const mesh = new THREE.Mesh(geo, material);
  const scene = new THREE.Scene();
  scene.add(mesh);
  engine.motionBlurMaterial = material;
  engine.motionBlurMesh = mesh;
  engine.motionBlurScene = scene;
  return material;
}

export function ensureMotionTrailMaterial(engine) {
  if (engine.motionTrailMaterial) return engine.motionTrailMaterial;
  const geo = engine.fsQuadGeo;
  if (!geo) return null;
  const material = createMotionTrailMaterial();
  const mesh = new THREE.Mesh(geo, material);
  const scene = new THREE.Scene();
  scene.add(mesh);
  engine.motionTrailMaterial = material;
  engine.motionTrailMesh = mesh;
  engine.motionTrailScene = scene;
  return material;
}

export function ensureTrailPass(engine) {
  if (engine.trailPass) return engine.trailPass;
  const geo = engine.fsQuadGeo;
  const material = ensureMotionTrailMaterial(engine);
  if (!geo || !material) return null;
  const mesh = new THREE.Mesh(geo, material);
  const scene = new THREE.Scene();
  scene.add(mesh);
  engine.trailPass = {
    scene,
    mesh,
    warp: createTrailWarpMaterial(),
    acc: createTrailAccMaterial(),
    erode: createTrailErodeMaterial(),
    compose: createTrailComposeMaterial(),
  };
  return engine.trailPass;
}

export function ensureBackdropPass(engine) {
  if (engine.backdropPass) return engine.backdropPass;
  const geo = engine.fsQuadGeo;
  if (!geo) return null;
  const makeMaterial = engine.materialFactory;
  const blur = (makeMaterial && makeMaterial.backdropBlur()) ?? createBackdropBlurMaterial();
  const mix = (makeMaterial && makeMaterial.backdropMix()) ?? createBackdropMixMaterial();
  const mixFlip = (makeMaterial && makeMaterial.backdropMix({ flipMatte: true })) ?? mix;
  const mesh = new THREE.Mesh(geo, blur);
  const scene = new THREE.Scene();
  scene.add(mesh);
  engine.backdropPass = { blur, mix, mixFlip, mesh, scene };
  return engine.backdropPass;
}

// Glass's quad + material (glassEffect.js), built on first use like Backdrop Blur's.
export function ensureGlassPass(engine) {
  if (engine.glassPass) return engine.glassPass;
  const geo = engine.fsQuadGeo;
  if (!geo) return null;
  const makeMaterial = engine.materialFactory;
  const material = (makeMaterial && makeMaterial.glass()) ?? createGlassMaterial();
  const mesh = new THREE.Mesh(geo, material);
  const scene = new THREE.Scene();
  scene.add(mesh);
  engine.glassPass = { material, mesh, scene };
  return engine.glassPass;
}

// The destination-reading blend pass (overlay, soft light, hue…) — see
// blendComposite.js. `flip` is the plate-read binding for a finished quad
// plate; on WebGL it is the same material. Built on first use, cleared on
// renderer rebuild like the Backdrop Blur pass.
export function ensureBlendPass(engine) {
  if (engine.blendPass) return engine.blendPass;
  const geo = engine.fsQuadGeo;
  if (!geo) return null;
  const makeMaterial = engine.materialFactory;
  const plain = (makeMaterial && makeMaterial.blendComposite()) ?? createBlendCompositeMaterial();
  const flip = (makeMaterial && makeMaterial.blendComposite({ flipLayer: true })) ?? plain;
  const mesh = new THREE.Mesh(geo, plain);
  const scene = new THREE.Scene();
  scene.add(mesh);
  engine.blendPass = { plain, flip, mesh, scene };
  return engine.blendPass;
}
