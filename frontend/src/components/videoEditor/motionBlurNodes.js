/*
 * TSL twins of all THREE motion-blur mechanisms — matrix row 14.
 *
 *   createMotionBlurAccumulateNodeMaterial()  ← motionBlur.js accumulateFragmentShader
 *   createMotionBlurBlitNodeMaterial()        ← motionBlur.js blitFragmentShader
 *   createMotionBlurMixNodeMaterial()         ← motionBlurLayer.js MIX_FRAGMENT
 *   createMotionBlurNodeMaterial()            ← motionBlurLayer.js FRAGMENT (velocity gather)
 *
 * WHY THIS IS NOT THE LAB'S yup+flip PAIR
 *
 * Lab 14 used y-up UV + RT sample flip against its own write path. The app
 * compositor writes and reads RTs with plain `screenCoordinate` UV — and a
 * fragcoord probe measured `screenCoordinate` as byte-identical to GLSL's
 * `gl_FragCoord` (max Δ 0). Layer boxes from computeLayerBox are in that same
 * y-up NDC frame. So:
 *
 *   * UV = screenCoordinate / resolution  (same as GLSL)
 *   * boxes stay as written               (same as GLSL)
 *   * samplers are NOT flipped            (QUAD-written app RTs are upright
 *     under that UV)
 *
 * The earlier port's yup rewrite + flipY sampler (and a later attempt to
 * "remap" boxes into a supposed y-down space) flipped the plate and shifted
 * the layer. Motion trail uses the same plain-UV rule now.
 *
 * THE CAMERA-PLATE EXCEPTION. The rule above holds for plates written by an
 * ortho fullscreen quad. A CAMERA-rendered plate — the raw layer isolate in
 * rt.c, the sub-frame scratch rt.f — lands on the opposite V axis under
 * WebGPU (the matteClip uMatte precedent), and reading it with plain UV is a
 * mirrored read. The velocity gather can receive either provenance as its
 * uTexture (the isolate when no other layer effect ran, a quad plate
 * otherwise), so it takes a runtime uFlipV and flips AT THE SAMPLE POINT,
 * keeping every box/vector in screen space. The accumulation mix always
 * reads rt.f (camera) and often a quad accumulator, so it gets per-sampler
 * uFlipA/uFlipB. All three default to 0 and simply do not exist on the GLSL
 * twins, where both provenances sample upright — the drivers guard with
 * `if (uniforms.uFlipV)`, which is exactly the backend check.
 */
import * as THREE from 'three/webgpu';
import {
  uniform, vec2, vec4, float, mix, clamp, abs, max, min, pow, floor, fract,
  dot, length, Fn, If, Loop, Break, screenCoordinate, screenSize,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';

const makeSampler = () => makeTslSampler({ rgba: [0, 0, 0, 0], flipY: false });

function finish(material, uniforms) {
  material.depthTest = false;
  material.depthWrite = false;
  material.forceSinglePass = true;
  material.uniforms = uniforms;
  return material;
}

const fullscreenUv = () => screenCoordinate.xy.div(screenSize);

/**
 * Sub-frame accumulation for the EXPORT path: each of N whole-frame re-renders
 * is added at weight 1/N. The One/One blending is the accumulation — the
 * fragment only scales.
 */
export function createMotionBlurAccumulateNodeMaterial() {
  const u = { uTexture: makeSampler(), uWeight: uniform(1) };
  const material = new THREE.MeshBasicNodeMaterial();
  /*
   * PLAIN, like its GLSL original — and the sample flip that used to be here
   * was compensating for a bug one level up, not for this pass.
   *
   * The flip was calibrated against `mb_export_verify.js`'s COMPOSITE case,
   * which renders through `renderAdjustmentComposite` in alpha-frames mode —
   * and that landing was itself mirrored on WebGPU, because the flatten hop it
   * silently relied on is skipped for an alpha export (Player.jsx, "V axis:
   * this landing has to produce the SAME axis the single-pass branch does").
   * Two mirrors cancelled, that one cell matched WebGL, and the constant looked
   * right. The SINGLE case — the single-pass branch, where nothing cancelled —
   * was flipped the whole time, and so was every opaque render with motion blur
   * on, because an mp4 export runs the flatten and has nothing to cancel with.
   *
   * Measured on this fixture, vertical centroid of frame 0, WebGL truth 0.3859:
   *   before, landing fixed:  single 0.6141  composite 0.6141   (both mirrored)
   *   after (this change):    single 0.3859  composite 0.3859
   * Nothing here is provenance-dependent: the accumulation reads the finished
   * frame, and the two branches that finish one now agree by construction.
   */
  material.fragmentNode = Fn(() => u.uTexture.sample(fullscreenUv()).mul(u.uWeight))();
  material.transparent = true;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  return finish(material, u);
}

/** Straight copy of the accumulator back out. */
export function createMotionBlurBlitNodeMaterial() {
  const u = { uTexture: makeSampler() };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => u.uTexture.sample(fullscreenUv()))();
  material.transparent = false;
  material.blending = THREE.NoBlending;
  return finish(material, u);
}

/**
 * The per-layer true-shutter mode's running mean: `mix(acc, sub, 1/(k+1))` over
 * a ping-pong. `uW = 0` is the landing copy, which is why this is a mix and not
 * an accumulate — at 0 it must reproduce `acc` exactly.
 */
export function createMotionBlurMixNodeMaterial() {
  const u = {
    uAcc: makeSampler(),
    uSub: makeSampler(),
    uResolution: uniform(new THREE.Vector2(1920, 1080)),
    uW: uniform(0.5),
    // Per-sampler V flips — the two plates routinely differ in provenance
    // (rt.f is always camera-rendered; the accumulator is quad-written after
    // the first mix), so neither a global flip nor a global plain works.
    uFlipA: uniform(0),
    uFlipB: uniform(0),
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = fullscreenUv();
    const uvA = vec2(uvn.x, mix(uvn.y, uvn.y.oneMinus(), u.uFlipA));
    const uvB = vec2(uvn.x, mix(uvn.y, uvn.y.oneMinus(), u.uFlipB));
    return mix(u.uAcc.sample(uvA), u.uSub.sample(uvB), u.uW);
  })();
  material.transparent = false;
  material.blending = THREE.NoBlending;
  return finish(material, u);
}

const hash21 = Fn(([pIn]) => {
  const p = fract(pIn.mul(vec2(123.34, 456.21))).toVar();
  p.addAssign(dot(p, p.add(45.32)));
  return fract(p.x.mul(p.y));
}).setLayout({ name: 'mbHash21', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

/**
 * The fast mode: one gather pass mapping every pixel through (prev ∘ curr⁻¹).
 * The two affine boxes define the screen-space map, each pixel solves its
 * quad-local coords in the current basis and re-projects through the previous.
 * All premultiplied — alpha smears with colour so the streak composites right.
 */
export function createMotionBlurNodeMaterial() {
  const u = {
    uTexture: makeSampler(),
    uResolution: uniform(new THREE.Vector2(1920, 1080)),
    uCurrO: uniform(new THREE.Vector2()),
    uCurrX: uniform(new THREE.Vector2()),
    uCurrY: uniform(new THREE.Vector2()),
    uPrevO: uniform(new THREE.Vector2()),
    uPrevX: uniform(new THREE.Vector2()),
    uPrevY: uniform(new THREE.Vector2()),
    uShutter: uniform(0.5),
    uSamples: uniform(24),
    uMaxBlur: uniform(120),
    uFall: uniform(2.5),
    uMix: uniform(1),
    uPhase: uniform(0),
    // 1 when uTexture is the camera-rendered isolate (opposite V axis), 0 for
    // a quad-written plate. Applied AT THE SAMPLE POINT so the affine box
    // math above stays in the screen frame either way.
    uFlipV: uniform(0),
  };
  const tapClamped = Fn(([uvIn]) => {
    const o = vec4(0.0).toVar();
    If(uvIn.x.greaterThanEqual(0.0).and(uvIn.x.lessThanEqual(1.0))
      .and(uvIn.y.greaterThanEqual(0.0)).and(uvIn.y.lessThanEqual(1.0)), () => {
      o.assign(u.uTexture.sample(vec2(uvIn.x, mix(uvIn.y, uvIn.y.oneMinus(), u.uFlipV))));
    });
    return o;
  }).setLayout({ name: 'mbTapClamped', type: 'vec4', inputs: [{ name: 'uv', type: 'vec2' }] });

  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    // screenCoordinate ≡ gl_FragCoord (measured); boxes are in that same frame.
    const fragCoord = screenCoordinate.xy.toVar();
    const uvn = fragCoord.div(u.uResolution).toVar();
    const src = u.uTexture.sample(vec2(uvn.x, mix(uvn.y, uvn.y.oneMinus(), u.uFlipV))).toVar();
    const res = src.toVar();
    const det = u.uCurrX.x.mul(u.uCurrY.y).sub(u.uCurrX.y.mul(u.uCurrY.x)).toVar();
    If(abs(det).greaterThanEqual(1e-9).and(u.uMix.greaterThan(0.001)), () => {
      const d = uvn.sub(u.uCurrO).toVar();
      const a = d.x.mul(u.uCurrY.y).sub(d.y.mul(u.uCurrY.x)).div(det).toVar();
      const b = d.x.negate().mul(u.uCurrX.y).add(d.y.mul(u.uCurrX.x)).div(det).toVar();
      const prevUv = u.uPrevO.add(u.uPrevX.mul(a)).add(u.uPrevY.mul(b)).toVar();
      const blurPx = uvn.sub(prevUv).mul(u.uResolution).mul(u.uShutter).toVar();
      const len = length(blurPx).toVar();
      If(len.greaterThan(u.uMaxBlur), () => {
        blurPx.mulAssign(u.uMaxBlur.div(len));
        len.assign(u.uMaxBlur);
      });
      If(len.greaterThanEqual(0.5), () => {
        const stepUv = blurPx.div(u.uResolution).toVar();
        const taps = clamp(floor(u.uSamples), 7.0, 64.0).toVar();
        const j = hash21(fragCoord).sub(0.5).toVar();
        const s0 = u.uPhase.lessThan(0.5).select(float(0.0),
          u.uPhase.lessThan(1.5).select(float(-0.5), float(-1.0))).toVar();
        const acc = vec4(0.0).toVar();
        const ws = float(0.0).toVar();
        Loop({ start: 0, end: 64, type: 'float', condition: '<' }, ({ i }) => {
          If(i.greaterThanEqual(taps), () => { Break(); });
          const u01 = i.add(0.5).add(j).div(taps).toVar();
          const s = s0.add(u01).toVar();
          const e = u.uPhase.lessThan(0.5).select(u01,
            u.uPhase.lessThan(1.5).select(abs(s).mul(2.0), s.negate())).toVar();
          const w = pow(max(float(1.0).sub(e), 0.0), float(1.0).div(max(u.uFall, 0.05))).toVar();
          acc.addAssign(tapClamped(uvn.sub(stepUv.mul(s))).mul(w));
          ws.addAssign(w);
        });
        const blurred = ws.greaterThan(1e-4).select(acc.div(ws), src).toVar();
        res.assign(mix(src, blurred, u.uMix));
      });
    });
    return res;
  })();
  material.transparent = true;
  material.blending = THREE.NoBlending;
  return finish(material, u);
}
