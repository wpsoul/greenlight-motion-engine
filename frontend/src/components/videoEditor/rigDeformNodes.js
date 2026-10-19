/*
 * TSL twins of rigDeform.js's three materials (Rig tool / Puppet Pin).
 *
 *   createRigCropNodeMaterial()  ← the material inside ensureCropRig()
 *   createRigWarpNodeMaterial()  ← createRigWarpMaterial()
 *   createRigCopyNodeMaterial()  ← createRigCopyMaterial()
 *
 * These three happen to cover all three coordinate shapes the port has had to
 * distinguish, which makes them a decent summary of the rules:
 *
 *   crop  camera-projected, shaded by gl_FragCoord, samples a COMPUTED uv
 *   warp  writes clip space BY HAND from vertex DATA — repetile's shape
 *   copy  camera-projected, interpolated uv, samples where it writes
 */
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, uv, vec2, vec4, float, attribute, varying, select,
  positionGeometry, screenCoordinate,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';

/** Null-safe binding facade; see tslSampler.js. */
const makeSampler = () => makeTslSampler({ rgba: [0, 0, 0, 0] });

/*
 * Frame-uv -> the source texture's sampling convention.
 *
 * Both remapping passes here need it and the plain copy does not, which is the
 * pattern the whole port keeps running into: a pass that samples WHERE IT
 * WRITES is insensitive to the convention (both flips cancel), and a pass that
 * samples somewhere else is not.
 *
 * DO NOT promote this to a rule about "computed uv always flips" — repetile
 * computes its sample uv from box axes in exactly this way and needs NO flip
 * (11/11 exact without one). The interaction with each pass's vertex stage
 * decides it, and I have not found a formulation that predicts all of them.
 * What IS reliable is that a two-state bisect settles it in one run, so measure
 * per pass rather than reasoning from a neighbouring pass that looks similar.
 */
const flipV = (p) => vec2(p.x, float(1.0).sub(p.y));

function finish(material, uniforms) {
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  // ShaderMaterial's constructor sets this true; every NodeMaterial inherits
  // Material's false (PORTING-GUIDE §13).
  material.forceSinglePass = true;
  material.uniforms = uniforms;
  return material;
}

/**
 * The crop the rig bake runs before reading an alpha mask: resample the layer's
 * isolate through its own box so the mask is the LAYER's rect, not the frame's.
 */
export function createRigCropNodeMaterial() {
  const u = {
    uTex: makeSampler(),
    uOutSize: uniform(new THREE.Vector2(1, 1)),
    uOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uAxisX: uniform(new THREE.Vector2(0.5, 0)),
    uAxisY: uniform(new THREE.Vector2(0, 0.5)),
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    // This target is consumed by readTargetPixels(), not displayed directly.
    // Preserve WebGL's bottom-up output row order; the helper then normalises
    // WebGPU's mapped top-down rows in exactly the same way as Auto Fill's bake.
    const fc = vec2(screenCoordinate.x, u.uOutSize.y.sub(screenCoordinate.y));
    const p = fc.div(u.uOutSize);
    const q = p.mul(2.0).sub(1.0);
    const uvn = u.uOrigin.add(u.uAxisX.mul(q.x)).add(u.uAxisY.mul(q.y));
    const outside = uvn.x.lessThan(0.0).or(uvn.x.greaterThan(1.0))
      .or(uvn.y.lessThan(0.0)).or(uvn.y.greaterThan(1.0));
    return select(outside, vec4(0.0), u.uTex.sample(flipV(uvn)));
  })();
  material.transparent = true;
  return finish(material, u);
}

/**
 * The warp: vertices sit at the DEFORMED box point, fragments sample the isolate
 * at the REST box point — both through the same computeLayerBox affine, so the
 * pass composes with layer transform, parenting and the project camera for free.
 */
export function createRigWarpNodeMaterial() {
  const u = {
    uTexture: makeSampler(),
    uFxOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uFxAxisX: uniform(new THREE.Vector2(0.5, 0)),
    uFxAxisY: uniform(new THREE.Vector2(0, 0.5)),
  };
  const aRest = attribute('aRest', 'vec2');
  const vUv = varying(u.uFxOrigin.add(u.uFxAxisX.mul(aRest.x)).add(u.uFxAxisY.mul(aRest.y)));
  const warped = u.uFxOrigin
    .add(u.uFxAxisX.mul(positionGeometry.x))
    .add(u.uFxAxisY.mul(positionGeometry.y));

  const material = new THREE.MeshBasicNodeMaterial();
  /*
   * `warped` is already frame UV produced from y-up rig cell coordinates. The
   * app-path test shows that vertexNode must preserve the GLSL clip position;
   * negating it mirrors the whole posed mesh. Only the render-target SAMPLE is
   * flipped. The standalone fixture now normalises logical readback rows so it
   * measures this production convention rather than raw storage orientation.
   */
  material.vertexNode = vec4(
    warped.x.mul(2.0).sub(1.0), warped.y.mul(2.0).sub(1.0), 0.0, 1.0);
  material.fragmentNode = Fn(() => u.uTexture.sample(flipV(vUv)))();
  material.side = THREE.DoubleSide;
  material.transparent = true;
  return finish(material, u);
}

/**
 * Straight premultiplied copy, writing the warped plate back into rt.c so
 * everything downstream — DOF, glow, chain matte, track matte — keeps reading
 * the warped silhouette unchanged.
 */
export function createRigCopyNodeMaterial() {
  const u = { uTexture: makeSampler() };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => u.uTexture.sample(uv()))();
  material.transparent = true;
  return finish(material, u);
}
