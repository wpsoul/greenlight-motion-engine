/*
 * TSL twins of layerMask.js's two apply passes — matrix row 09.
 *
 *   createLayerMaskNodeMaterial()          ← createLayerMaskMaterial()
 *   createAdjustmentMaskMixNodeMaterial()  ← createAdjustmentMaskMixMaterial()
 *
 * Ported from the verdicted pair 09 (html/webgpu-migration/webgpu/09-layer-mask.html),
 * which fused both passes behind a uPassMode switch; here they stay two
 * materials, because that is what the Player builds and swaps.
 *
 * The CPU half of the feature is untouched and renderer-agnostic:
 * resolveLayerMaskParams and drawMaskCoverage's canvas-2D coverage plate (fold
 * modes, Minkowski offset stroke, feather blur, invert) survive the migration
 * exactly as they are.
 *
 * As with the clip material, `.uniforms.<name>.value` is the same surface the
 * ShaderMaterial exposes, so applyLayerMask's writers drive these unchanged.
 */
import * as THREE from 'three/webgpu';
import { uniform, texture, uv, vec2, vec3, vec4, float, dot, mix, clamp, max, abs, select } from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';

// frame uv → layer-box 0..1 (EFFECT_PRELUDE's fxLocal(), inlined), plus the
// coverage read. Shared by both passes because both do it identically — and
// deliberately NOT a laid-out Fn: it reads uniforms, and a layout on a helper
// that captures a uniform emits a stale uniform index (PORTING-GUIDE §2).
function coverageAt(uvn, uFxHomInv, uMask, uAmount) {
  // Through the layer plane's projective map (the affine frame cannot describe
  // the trapezoid a 3D tilt projects, and clipped the mask at the near edge).
  const h = uFxHomInv.mul(vec3(uvn.x, uvn.y, 1.0)).toVar();
  const p = select(h.z.lessThan(1e-6), vec2(-1e3, -1e3), h.xy.div(max(h.z, 1e-6))).toVar();
  // Outside the plate there is NO mask data. Coverage is 0 there, not the
  // clamped edge texel — ClampToEdge would smear the border row across the
  // whole frame.
  const outside = p.x.lessThan(0.0).or(p.x.greaterThan(1.0))
    .or(p.y.lessThan(0.0)).or(p.y.greaterThan(1.0));
  const cov = select(outside, float(0.0), uMask.sample(p).a);
  // uAmount is a MIX toward "no mask", not a multiplier on coverage: at 0 the
  // layer is untouched, at 1 the mask cuts fully. Multiplying instead would make
  // Amount 0 erase the layer.
  return clamp(mix(float(1.0), cov, clamp(uAmount, 0.0, 1.0)), 0.0, 1.0);
}

/** Null-safe binding facade; see tslSampler.js. White fallback because these
 * samples are MULTIPLIERS — an unbound coverage plate must not erase the layer. */
const makeSampler = () => makeTslSampler({ rgba: [255, 255, 255, 255] });

function baseUniforms() {
  return {
    uMask: makeSampler(),
    uResolution: uniform(new THREE.Vector2(1280, 720)),
    uFxOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uFxAxisX: uniform(new THREE.Vector2(0.5, 0)),
    uFxAxisY: uniform(new THREE.Vector2(0, 0.5)),
    uFxHom: uniform(new THREE.Matrix3()),
    uFxHomInv: uniform(new THREE.Matrix3()),
    uAmount: uniform(1),
  };
}

function finish(material, uniforms) {
  material.transparent = true;
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  // ShaderMaterial defaults this to true, every NodeMaterial to false; leaving
  // it false opts a transparent DoubleSide material into the two-pass
  // back/front draw and reorders any self-overlap (PORTING-GUIDE §13).
  material.forceSinglePass = true;
  material.uniforms = uniforms;
  return material;
}

/** The layer cut: scale BOTH rgb and alpha by the same coverage. */
export function createLayerMaskNodeMaterial() {
  /*
   * uTexture IS FLIPPED; uMask IS NOT — and the asymmetry is the whole point.
   *
   * This pass mixes two textures of DIFFERENT KINDS. `uTexture` is the layer's
   * plate, a RENDER TARGET, whose V axis runs opposite on WebGPU. `uMask` is the
   * coverage plate, a canvas-2D raster uploaded as an ordinary texture, which
   * lands the same way on both backends. Sampling both with a plain `uv()` was
   * correct on WebGL, where the two conventions coincide, and silently wrong on
   * WebGPU, where they do not.
   *
   * The symptom was not a mirrored image — it was a mask that KEPT THE WRONG
   * CONTENT: the coverage landed in the right place while the pixels underneath
   * came from the vertically mirrored position. Measured on the app path with a
   * mask that keeps content, WebGPU showed 3,410 lit pixels WebGL did not, and
   * 3,410 of 3,410 matched the unmasked frame at the MIRRORED position — none at
   * the same position. That is as unambiguous as this kind of evidence gets.
   *
   * Not caught earlier because no lab pair drives this material in the gate, and
   * the app-path fixture used a mask that cut nearly everything away, so almost
   * no content survived to be wrong.
   */
  const u = { uTexture: makeTslSampler({ rgba: [255, 255, 255, 255], flipY: true }), ...baseUniforms() };
  // GLSL derives uv from gl_FragCoord/uResolution; on a fullscreen ortho quad
  // the interpolated uv is exactly that at every pixel centre — same origin,
  // same half-pixel offsets — so uv() replaces it 1:1 (pair 09).
  const uvn = uv();
  const src = u.uTexture.sample(uvn);
  const m = coverageAt(uvn, u.uFxHomInv, u.uMask, u.uAmount);
  // BOTH rgb and a scale by the SAME coverage. The isolate is PREMULTIPLIED; if
  // rgb kept its old value while alpha shrank, every feathered texel would
  // un-premultiply to near-white and the export flatten would resolve it as a
  // bright fringe.
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = vec4(src.rgb.mul(m), src.a.mul(m));
  return finish(material, u);
}

/**
 * Adjustment Mask: MIX the graded composite back toward the ungraded one by
 * coverage. An adjustment layer has no pixels of its own, so cutting alpha would
 * punch through to the project background instead of revealing the stack below.
 * Both inputs are premultiplied, so the plain lerp is the correct composite.
 */
export function createAdjustmentMaskMixNodeMaterial() {
  const u = { uTexture: makeSampler(), uSource: makeSampler(), ...baseUniforms() };
  const uvn = uv();
  const graded = u.uTexture.sample(uvn);
  const below = u.uSource.sample(uvn);
  const m = coverageAt(uvn, u.uFxHomInv, u.uMask, u.uAmount);
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = mix(below, graded, m);
  return finish(material, u);
}
