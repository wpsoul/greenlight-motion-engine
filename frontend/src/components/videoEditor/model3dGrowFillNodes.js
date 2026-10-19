/*
 * TSL twin of model3dGrowFill.js's shader splice — matrix row 17b.
 *
 * Ported from the verdicted pair 17b (35 states; 33 with zero pixels
 * attributable to the port, against a measured control floor of 20 px).
 *
 * This is the only LIT pair in the port. The app paints its grow fill by
 * splicing GLSL in through `onBeforeCompile`, AFTER tone mapping
 * (`#include <dithering_fragment>`). Node materials ignore `onBeforeCompile`
 * entirely, so the twin instead paints through `material.outputNode`, which
 * runs BEFORE the renderer's tone mapping. Those are only the same place under
 * **NoToneMapping + LinearSRGBColorSpace** — which is what the app already uses.
 * If tone mapping is ever switched on, this splice point stops matching and the
 * pair's own measurements say the disagreement is worth mean Δ 9.3, not a
 * rounding difference.
 *
 * Everything below the shader stays app code: `applyModelGrowFill()` runs the
 * Dijkstra arrival bake, the geometry alias and all 26 uniform writes. On this
 * side it simply degrades into "bake + fill the uniform objects", so the two
 * renderers cannot drift on the arrival field or on any parameter, even in
 * principle. That is why this module takes the app's OWN `growState.uniforms`
 * rather than declaring its own.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, output, attribute, varying, uniform, texture, positionGeometry,
  vec2, vec3, vec4, float, mix, clamp, abs, max, min, smoothstep, exp, floor,
  fract, sin, dot, select,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';

// `uGrowWavScale` is written by the app but never read by the fragment: the
// wave frequency reaches the GPU only through uGrowNoiseFreq, which the CPU
// derives from the model's bbox diagonal. Porting it would be dead weight.
const SCALARS = [
  'uGrowOn', 'uGrowProgress', 'uGrowMode', 'uGrowStyle', 'uGrowLoops', 'uGrowFlow',
  'uGrowSoft', 'uGrowWavAmp', 'uGrowFeW', 'uGrowFeMode', 'uGrowFeGlowW', 'uGrowFeGlowI',
  'uGrowBeOn', 'uGrowBeOff', 'uGrowBeW', 'uGrowBeMode', 'uGrowBeGlowW', 'uGrowBeGlowI',
  'uGrowNoiseFreq', 'uGrowFeAlpha', 'uGrowBeAlpha',
];

/**
 * Build the lit grow-fill material for one model entry.
 *
 * `gu` is `entry.growState.uniforms` — the app's OWN uniform objects, already
 * populated by applyModelGrowFill (including the three ramp textures). Colours
 * WRAP the app's THREE.Color instances because applyModelGrowFill mutates them
 * in place with `.set()`, so hex parsing and splitEdgeColor's alpha split stay
 * app code. Scalars are REPLACED by it, so `syncGrowUniforms()` mirrors them
 * after every apply.
 *
 * `srcMat` is the mesh's OWN material, straight off the glTF, and `renderer` is
 * what turns it into a node material — see the adoption note below.
 */
export function createModelGrowFillNodeMaterial(gu, srcMat = null, renderer = null) {
  const uFillColor = uniform(gu.uGrowFillColor.value);
  const uFeColor = uniform(gu.uGrowFeColor.value);
  const uBeColor = uniform(gu.uGrowBeColor.value);
  const S = {};
  for (const k of SCALARS) S[k] = uniform(gu[k].value);
  /*
   * The three ramps go through the null-safe facade, and BOTH reasons matter.
   *
   * makeGrowUniforms() starts them at `{ value: null }`, so building from a
   * fresh entry called `texture(null)` — the identical build failure that made
   * the clip material render black, silently caught by three and swapped for the
   * default shader. The lab never saw it because it built the WebGL material
   * first, which populated the ramps before the TSL material was constructed;
   * production builds in the other order.
   *
   * applyModelGrowFill also REPLACES `.value` with a new ramp texture whenever
   * the gradient changes, rather than mutating one in place — so a captured
   * texture() node would keep sampling the first gradient forever. Hence the
   * ramps are mirrored in syncGrowUniforms below alongside the scalars.
   */
  const texRamp = makeTslSampler({ rgba: [255, 255, 255, 255] });
  const texRampFE = makeTslSampler({ rgba: [255, 255, 255, 255] });
  const texRampBE = makeTslSampler({ rgba: [255, 255, 255, 255] });
  const RAMPS = [[texRamp, 'uGrowRamp'], [texRampFE, 'uGrowRampFE'], [texRampBE, 'uGrowRampBE']];
  for (const [sampler, key] of RAMPS) sampler.value = gu[key].value;

  // The GLSL vertex splice is `vGrowArr = aGrowArrival; vGrowPos = position;`
  // — note POSITION, not the transformed vertex, so positionGeometry is the
  // exact node. Both helpers carry an explicit .setLayout(): growVn calls
  // growHash EIGHT times, and an un-laid-out Fn is inlined at every call site
  // with its argument's whole expression tree duplicated (§2 — pair 11 hung the
  // page for seconds on exactly this shape, with no error at all).
  const vGrowArr = varying(attribute('aGrowArrival', 'float'));
  const vGrowPos = varying(positionGeometry);

  const growHash = Fn(([p]) => fract(sin(dot(p, vec3(127.1, 311.7, 74.7))).mul(43758.5453)))
    .setLayout({ name: 'growHash', type: 'float', inputs: [{ name: 'p', type: 'vec3' }] });

  const growVn = Fn(([p]) => {
    const i = floor(p).toVar();
    const f0 = fract(p).toVar();
    const f = f0.mul(f0).mul(vec3(3.0).sub(f0.mul(2.0))).toVar();
    const a = mix(growHash(i), growHash(i.add(vec3(1, 0, 0))), f.x);
    const b = mix(growHash(i.add(vec3(0, 1, 0))), growHash(i.add(vec3(1, 1, 0))), f.x);
    const c = mix(growHash(i.add(vec3(0, 0, 1))), growHash(i.add(vec3(1, 0, 1))), f.x);
    const d = mix(growHash(i.add(vec3(0, 1, 1))), growHash(i.add(vec3(1, 1, 1))), f.x);
    return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
  }).setLayout({ name: 'growVn', type: 'float', inputs: [{ name: 'p', type: 'vec3' }] });

  /*
   * ADOPT the glTF material — do not build a new one.
   *
   * The WebGL twin is `srcMat.clone()` + an onBeforeCompile splice, so it keeps
   * everything the asset authored. Constructing a fresh MeshStandardNodeMaterial
   * from `{color, roughness, metalness}` carries THREE SCALARS across and drops
   * map, normalMap, the ORM maps, emissiveMap, alphaMap, clearcoat, side and
   * every UV transform — the model renders as untextured plastic wherever grow
   * fill is on. `library.fromMaterial()` is the same conversion WebGPURenderer
   * runs internally per build (R17's ADOPT step), so maps and factors survive
   * and a clearcoat glass part stays MeshPhysicalNodeMaterial.
   */
  const adopted = srcMat ? renderer?.library?.fromMaterial?.(srcMat) ?? null : null;
  const growMat = adopted && adopted === srcMat
    // Already a node material: fromMaterial hands back the SAME object, and
    // writing outputNode onto it would rewrite the asset's shared original.
    ? srcMat.clone()
    : adopted || new THREE.MeshStandardNodeMaterial({
      color: srcMat?.color?.getHex?.() ?? 0x8891a6,
      roughness: srcMat?.roughness ?? 0.5,
      metalness: srcMat?.metalness ?? 0,
    });
  /*
   * fromMaterial copies every key straight across, so `userData` arrives BY
   * REFERENCE while Material.clone() (the WebGL path) deep-copies it.
   * applyModelGrowFill stores growSrcTransparent there, which would otherwise
   * be written onto the asset's shared original and onto every sibling adopted
   * from it.
   */
  growMat.userData = { ...(srcMat?.userData || {}) };
  growMat.outputNode = Fn(() => {
    const lit = output;
    const rgb0 = lit.rgb.toVar();
    const a0 = lit.a.toVar();

    // px-authored sliders ride the normalised arrival span through /300.
    const softN = S.uGrowSoft.div(300.0);
    const wavN = S.uGrowWavAmp.div(300.0);
    const pad = softN.add(wavN).add(0.03).toVar();
    const endPad = pad.add(select(S.uGrowBeOn.greaterThan(0.5), S.uGrowBeOff.div(300.0), float(0.0))).toVar();
    const p = pad.negate().add(clamp(S.uGrowProgress, 0.0, 1.0).mul(float(0.98).add(pad).add(endPad))).toVar();
    const wn = growVn(vGrowPos.mul(S.uGrowNoiseFreq)
      .add(vec3(S.uGrowProgress.mul(S.uGrowFlow).mul(0.7), 0.0, 0.0))).sub(0.5).toVar();
    const arrE = vGrowArr.add(wn.mul(2.0).mul(wavN)).toVar();
    const soft = max(softN, 0.002);
    const fillW = float(1.0).sub(smoothstep(p.sub(soft), p.add(soft), arrE)).toVar();

    // styles: 0 solid · 1 gradient by age · 2 gradient loop · 3 noise tint
    const age = clamp(p.sub(arrE).div(0.35), 0.0, 1.0);
    const ph = fract(arrE.mul(S.uGrowLoops).sub(S.uGrowProgress.mul(S.uGrowFlow)));
    const colAge = texRamp.sample(vec2(float(1.0).sub(age), 0.5)).rgb;
    const colPhase = texRamp.sample(vec2(ph, 0.5)).rgb;
    const colNoise = uFillColor.mul(growVn(vGrowPos.mul(S.uGrowNoiseFreq).mul(4.0)).mul(0.9).add(0.25));
    const styleCol = select(
      S.uGrowStyle.greaterThan(0.5).and(S.uGrowStyle.lessThan(1.5)), colAge,
      select(
        S.uGrowStyle.greaterThan(1.5).and(S.uGrowStyle.lessThan(2.5)), colPhase,
        select(S.uGrowStyle.greaterThan(2.5).and(S.uGrowStyle.lessThan(3.5)), colNoise, uFillColor),
      ),
    ).toVar();

    const aa = 0.005;
    const feHalf = S.uGrowFeW.mul(0.5).div(300.0).toVar();
    const feBand = select(
      S.uGrowFeW.lessThan(0.5), float(0.0),
      float(1.0).sub(smoothstep(feHalf.sub(aa), feHalf.add(aa), abs(arrE.sub(p)))),
    ).toVar();
    const feT = clamp(p.add(feHalf).sub(arrE).div(max(feHalf.mul(2.0), 1e-5)), 0.0, 1.0);
    const feCol = select(S.uGrowFeMode.greaterThan(0.5), texRampFE.sample(vec2(feT, 0.5)).rgb, uFeColor).toVar();
    const feGw = max(S.uGrowFeGlowW.div(300.0), 1e-3);
    const feGlow = select(
      S.uGrowFeGlowW.lessThan(0.5), float(0.0),
      exp(abs(arrE.sub(p)).div(feGw).negate()).mul(S.uGrowFeGlowI),
    ).toVar();

    const beC = p.sub(S.uGrowBeOff.div(300.0)).toVar();
    const beHalf = S.uGrowBeW.mul(0.5).div(300.0).toVar();
    const beOff = S.uGrowBeOn.lessThan(0.5);
    const beBand = select(
      beOff.or(S.uGrowBeW.lessThan(0.5)), float(0.0),
      float(1.0).sub(smoothstep(beHalf.sub(aa), beHalf.add(aa), abs(arrE.sub(beC)))),
    ).toVar();
    const beT = clamp(beC.add(beHalf).sub(arrE).div(max(beHalf.mul(2.0), 1e-5)), 0.0, 1.0);
    const beCol = select(S.uGrowBeMode.greaterThan(0.5), texRampBE.sample(vec2(beT, 0.5)).rgb, uBeColor).toVar();
    const beGw = max(S.uGrowBeGlowW.div(300.0), 1e-3);
    const beGlow = select(
      beOff.or(S.uGrowBeGlowW.lessThan(0.5)), float(0.0),
      exp(abs(arrE.sub(beC)).div(beGw).negate()).mul(S.uGrowBeGlowI),
    ).toVar();

    // style 4 ("None — edges only") paints no fill but still cuts alpha.
    const paint = select(S.uGrowStyle.greaterThan(3.5), float(0.0), fillW);

    const isFill = S.uGrowMode.lessThan(0.5);
    const isUnfill = S.uGrowMode.lessThan(1.5);
    const rgb = select(isFill, mix(rgb0, styleCol, paint), rgb0).toVar();
    const alpha = select(isFill, a0, select(isUnfill, a0.mul(float(1.0).sub(fillW)), a0.mul(fillW))).toVar();

    // The edge bands carry their colour's own opacity, as on a 2D layer.
    rgb.assign(mix(rgb, beCol, beBand.mul(S.uGrowBeAlpha)));
    rgb.assign(mix(rgb, feCol, feBand.mul(S.uGrowFeAlpha)));
    rgb.assign(rgb.add(beCol.mul(beGlow)));
    rgb.assign(rgb.add(feCol.mul(feGlow)));

    const gate = S.uGrowOn.greaterThan(0.5).and(vGrowArr.lessThan(0.995));
    return vec4(select(gate, rgb, rgb0), select(gate, alpha, a0));
  })();

  /*
   * applyModelGrowFill REPLACES scalar values and ramp TEXTURES rather than
   * mutating them, so both have to be re-read after every apply. Only the
   * colours are mutated in place (`.set()`), which is why they are wrapped by
   * reference above and need no mirroring here.
   *
   * The ramps were missing from this list, and the symptom was not a crash: a
   * gradient edit simply never took effect.
   */
  growMat.syncGrowUniforms = () => {
    for (const k of SCALARS) S[k].value = gu[k].value;
    for (const [sampler, key] of RAMPS) {
      if (sampler.value !== gu[key].value) sampler.value = gu[key].value;
    }
  };
  growMat.uniforms = gu;
  return growMat;
}
