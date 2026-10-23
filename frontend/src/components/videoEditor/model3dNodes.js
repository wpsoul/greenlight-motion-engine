/*
 * TSL twins for model3dLayer.js's pipeline passes.
 *
 * WHY THIS IS A P0 rather than another effect: `renderModelLayer()` ALWAYS ends
 * with the tone pass to produce its final LDR target. A GLSL ShaderMaterial on
 * WebGPURenderer draws nothing, so without this twin the model, rig-scene and
 * flat-plate outputs all come out cleared — the entire 3D path, not one optional
 * look. It is the same class of gap as the eight compositing materials: plumbing
 * that the effect-shaped migration matrix never listed.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, If, Discard, uniform, uv, vec2, vec3, vec4, clamp, select, max, diffuseColor, materialOpacity, screenUV, positionView, positionGeometry,
  float, int, ivec2, Loop, reference, renderGroup, texture, textureLoad, floor, exp2, min, abs,
  vogelDiskSample, fract, dot, log2, fwidth, positionWorld, mix, dFdx, dFdy, length,
} from 'three/tsl';
import { veDisplayTransform, veToSRGB } from './threeDisplayTransformNodes.js';
import { makeTslSampler } from './tslSampler.js';

/** Null-safe binding facade; see tslSampler.js. */
const makeSampler = () => makeTslSampler({ rgba: [0, 0, 0, 0] });

// PCSS twin of rigSoftShadows: raw depth for blocker search, hardware bilinear
// comparison for the 32-tap penumbra. Radius uses the same packed per-light data.
const pcssHash3 = (p) => {
  const q = fract(p.mul(0.1031)).toVar();
  q.addAssign(dot(q, q.zyx.add(31.32)));
  return fract(q.x.add(q.y).mul(q.z));
};
export const rigSoftShadowFilter = Fn(({ depthTexture, shadowCoord, shadow, depthLayer }, builder) => {
  const mapSize = reference('mapSize', 'vec2', shadow).setGroup(renderGroup);
  const packed = reference('radius', 'float', shadow).setGroup(renderGroup);
  const kq = floor(packed.div(1024));
  const cap = max(packed.sub(kq.mul(1024)).mul(0.25), 1);
  const k = exp2(kq.div(256)).sub(1);
  // WebGL's pcssPhi: a disk rotation anchored to the receiving surface (world
  // cells of about a pixel, two sizes mixed per cell), so neither a camera nor a
  // light move re-rolls it. Evaluated here, up front — WGSL rejects derivatives
  // inside the non-uniform branches below.
  const fw = fwidth(positionWorld);
  const lv = log2(max(max(fw.x, fw.y), max(fw.z, 1e-6)));
  const l0 = floor(lv);
  const level = select(pcssHash3(floor(positionWorld.div(exp2(l0))).add(17)).lessThan(fract(lv)), l0.add(1), l0);
  const phi = pcssHash3(floor(positionWorld.div(exp2(level)))).mul(Math.PI * 2).toVar();
  // WebGL's pcssReceiverSlope: the receiver's own depth gradient across the map, so
  // every tap compares against the receiving surface's plane at that tap (no acne
  // bands on slanted faces). Up front for the same reason as phi.
  const sdx = dFdx(shadowCoord.xyz), sdy = dFdy(shadowCoord.xyz);
  const det = sdx.x.mul(sdy.y).sub(sdx.y.mul(sdy.x));
  const g = select(abs(det).greaterThan(1e-14),
    vec2(sdx.z.mul(sdy.y).sub(sdx.y.mul(sdy.z)), sdx.x.mul(sdy.z).sub(sdx.z.mul(sdy.x))).div(det), vec2(0));
  const dzUv = g.mul(min(float(1), float(16).div(max(length(g), 1e-9)))).toVar();
  const sum = float(0).toVar(), count = float(0).toVar();
  const nB = int(min(mapSize.x, 16)), nF = int(min(mapSize.x, 32));
  Loop({ start: int(0), end: nB, type: 'int', condition: '<' }, ({ i }) => {
    const offset = select(i.equal(0), vec2(0), vogelDiskSample(i.sub(1), nB.sub(1), phi).mul(cap.div(mapSize.x)));
    const pixel = ivec2(clamp(shadowCoord.xy.add(offset).mul(mapSize), vec2(0), mapSize.sub(1)));
    let sample = textureLoad(depthTexture, pixel);
    if (depthTexture.isArrayTexture) sample = sample.depth(depthLayer);
    const d = sample.r;
    const zr = shadowCoord.z.add(dot(dzUv, offset));
    If(builder.renderer.reversedDepthBuffer ? d.greaterThan(zr) : d.lessThan(zr), () => {
      sum.addAssign(d); count.addAssign(1);
    });
  });
  const result = float(1).toVar();
  If(count.greaterThan(0), () => {
    const separation = abs(shadowCoord.z.sub(sum.div(count)));
    const penumbra = min(separation.mul(k), cap).add(1.5).div(mapSize.x);
    const lit = float(0).toVar();
    Loop({ start: int(0), end: nF, type: 'int', condition: '<' }, ({ i }) => {
      const o = vogelDiskSample(i, nF, phi).mul(penumbra);
      let sample = texture(depthTexture, shadowCoord.xy.add(o));
      if (depthTexture.isArrayTexture) sample = sample.depth(depthLayer);
      lit.addAssign(sample.compare(shadowCoord.z.add(dot(dzUv, o))));
    });
    result.assign(lit.div(float(nF)));
  });
  return result;
});

/** Same underside height capture and separable Gaussian as rigContactShadows. */
export function createRigContactNodeMaterials() {
  const contactNear = uniform(0.01), contactFar = uniform(100);
  const depthMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const coverage = clamp(contactFar.add(positionView.z).div(contactFar.sub(contactNear)), 0, 1).pow(2);
  depthMaterial.fragmentNode = vec4(vec3(coverage), 1);
  depthMaterial.uniforms = { contactNear, contactFar };
  const source = makeSampler(), stepUV = uniform(new THREE.Vector2());
  const blurMaterial = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, blending: THREE.NoBlending });
  blurMaterial.vertexNode = vec4(positionGeometry.xy, 0, 1);
  blurMaterial.fragmentNode = Fn(() => {
    const value = vec4(0).toVar();
    let total = 0;
    for (let i = -8; i <= 8; i++) {
      const weight = Math.exp(-0.5 * i * i / 9);
      value.addAssign(source.sample(screenUV.add(stepUV.mul(i))).mul(weight));
      total += weight;
    }
    return value.div(total);
  })();
  blurMaterial.uniforms = { source, stepUV };
  return { depthMaterial, blurMaterial };
}

/**
 * The universal tone pass: HDR render target → display-referred LDR.
 *
 * The GLSL derives its uv from `gl_FragCoord.xy / uResolution`. On a fullscreen
 * ortho quad the interpolated `uv()` is exactly that at every pixel centre, and
 * the composite port measured that substitution at Δ 0 — so `uResolution` stays
 * on the uniform surface for the app's writers but does not enter the graph.
 */
export function createModelTonePassNodeMaterial() {
  const u = {
    uTexture: makeSampler(),
    uResolution: uniform(new THREE.Vector2(1, 1)),
    uExposure: uniform(1),
    uDisplay: uniform(1),
    // Screens (model3dConfig.screen/screens): coverage of display-referred media,
    // which skips the scene's tone curve — see model3dTonePass.js.
    uScreenMask: makeSampler(),
    uScreenMaskOn: uniform(0),
  };

  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    /*
     * SCREEN UV, not the quad's uv attribute.
     *
     * The GLSL derives its read from `gl_FragCoord.xy / uResolution`, and the
     * port substituted the interpolated `uv()` on the grounds that the two agree
     * at every pixel centre of a fullscreen quad. They do NOT agree here: with
     * `uv()` this pass reads ZERO over most of the model on WebGPU even though
     * the HDR target demonstrably holds the right pixels (read back directly:
     * 835438 covered texels on WebGPU vs 834174 on WebGL).
     */
    const src = u.uTexture.sample(screenUV);
    const a = clamp(src.a, 0.0, 1.0);
    // Unpremultiply before the non-linear maths and re-premultiply after, or
    // transparent edges come back with dark fringes.
    const lin = select(a.greaterThan(1e-4), src.rgb.div(a), vec3(0.0));
    /*
     * uDisplay 0 is the flat-plate case. That pass carries the layer's OWN
     * artwork, which is display-referred end to end — the bake is raw, the plate
     * material samples it raw, and the shadow is a multiply. So it passes
     * straight through. Anything else changes an ordinary 2D layer's colour the
     * moment it starts catching a shadow: ACES desaturates it, and a bare encode
     * washes it out (the second sRGB encode of #e11d48 is #f15f91 — measured).
     */
    const scene = select(u.uDisplay.greaterThan(0.5), veDisplayTransform(lin, u.uExposure), lin);
    const screen = u.uScreenMask.sample(screenUV).r.mul(u.uScreenMaskOn);
    const mapped = mix(scene, veToSRGB(lin), screen);
    return vec4(mapped.mul(a), a);
  })();

  material.depthTest = false;
  material.depthWrite = false;
  material.transparent = true;
  /*
   * A full-frame COPY into a target that was just cleared, whose output is
   * already premultiplied (`mapped * a`). Ordinary source-alpha blending would
   * multiply by alpha a second time and darken every antialiased silhouette into
   * a dirty outline.
   */
  material.blending = THREE.NoBlending;
  // ShaderMaterial's constructor sets this true; every NodeMaterial inherits
  // Material's false (PORTING-GUIDE §13).
  material.forceSinglePass = true;
  material.uniforms = u;
  return material;
}

/**
 * The flat animated shadow plate.
 *
 * The GLSL side is a `ShadowMaterial` with an `onBeforeCompile` splice — and
 * onBeforeCompile is GLSL string surgery that WebGPU never calls at all, so
 * there is nothing to "translate": the twin has to rebuild the same result out
 * of the node pipeline.
 *
 * three's `ShadowNodeMaterial` runs `ShadowMaskModel`, whose finish() leaves
 * `diffuseColor.a = opacity * shadowAmount` — exactly the GLSL's
 * `opacity * (1.0 - getShadowMask())`. That is the only place the accumulated
 * mask is reachable from a material-level node, so the plate recovers the raw
 * shadow amount by dividing that alpha back out by opacity, then reproduces the
 * splice verbatim.
 *
 * The clip shader stays the single authority for fitting, crop, filters, text
 * rasterisation and shape drawing; this pass only multiplies the already-baked
 * plate by the shadow it received.
 */
export function createShadowPlateNodeMaterial() {
  const u = {
    uPlate: makeSampler(),
    uReceiveShadow: uniform(0),
  };

  const material = new THREE.ShadowNodeMaterial({
    transparent: true,
    opacity: 0.7,
    side: THREE.DoubleSide,
    alphaTest: 0.02,
    depthWrite: true,
    toneMapped: false,
  });
  // Present for the same reason as on the GLSL material: WebGLShadowMap copies
  // `map` and `alphaTest` into its depth material so transparent pixels never
  // cast a rectangular shadow. Harmless on WebGPU, and keeps the two surfaces
  // identical for the app's writers.
  material.map = null;
  material.userData.receiveShadow = false;
  // The app writes through userData.plateUniforms on the GLSL side; mirror that
  // exact shape so syncPlateObject drives either implementation unchanged.
  material.userData.plateUniforms = u;

  material.outputNode = Fn(() => {
    const plate = u.uPlate.sample(uv()).toVar();
    If(plate.a.lessThan(0.02), () => { Discard(); });
    /*
     * ShadowMaskModel has already folded the mask into diffuseColor.a as
     * `opacity * shadowAmount`. Dividing by opacity recovers the amount the
     * GLSL gets straight from getShadowMask(). Guarded because a zero-opacity
     * plate would otherwise divide by zero and paint NaN.
     */
    const shadowAmount = diffuseColor.a.div(max(materialOpacity, 1e-4));
    const received = u.uReceiveShadow.mul(shadowAmount);
    const straightRgb = select(plate.a.greaterThan(0.0001), plate.rgb.div(plate.a), vec3(0.0));
    return vec4(straightRgb.mul(materialOpacity.mul(received).oneMinus()), plate.a);
  })();

  /*
   * PORTING-GUIDE §13. `ShadowMaterial` is a ShaderMaterial, whose constructor
   * sets this true; every NodeMaterial inherits Material's FALSE, which opts a
   * transparent DoubleSide plate into a back-then-front two-pass draw and lets
   * the back face win. The visible symptom is the cast shadow appearing
   * mirrored about the plate.
   */
  material.forceSinglePass = true;
  material.uniforms = u;
  return material;
}
