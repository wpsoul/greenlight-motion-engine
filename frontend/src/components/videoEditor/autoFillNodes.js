/*
 * TSL twins of Auto Fill's two shaders — matrix row 13.
 *
 *   createAutoFillNodeMaterial()      ← autoFillLayer.js  createAutoFillMaterial()
 *   createAutoFillCropNodeMaterial()  ← autofillField.js's crop pass
 *
 * Ported from the verdicted pair 13, which matched on 47 states. The bodies are
 * that lab's; what changes here is the uniform surface — the lab kept a
 * ShaderMaterial-shaped facade and copied it into TSL nodes each frame, whereas
 * an app material has to BE the facade so autoFillLayer's writers drive it
 * unchanged.
 *
 * Why the crop pass matters as much as the effect: three's WebGPURenderer cannot
 * draw the app's GLSL crop ShaderMaterial at all, so without this twin the BAKE
 * cannot run on WebGPU and the effect has no field to sample. Porting the pretty
 * shader and not the plumbing would leave Auto Fill dead on the new backend.
 *
 * Every helper carries an explicit `.setLayout()` (PORTING-GUIDE §2) — and note
 * that the layer-box helpers take the box as INPUTS rather than closing over the
 * uniforms, because a laid-out Fn that captures a uniform emits a stale uniform
 * index (§7b).
 */
import * as THREE from 'three/webgpu';
import {
  uniform, texture, vec2, vec3, vec4, float, mix, clamp, abs, max, min, mod,
  dot, fract, floor, exp, smoothstep, Fn, If, screenCoordinate, select,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';

/** Null-safe binding facade — see tslSampler.js for why null must never
 * reach TextureNode.value, and why the fallback is created once. */
const makeSampler = (flip = false, filter = THREE.LinearFilter) => makeTslSampler({
  rgba: [0, 0, 0, 0], flipY: flip, filter,
});

const SCALARS = [
  'uSpan', 'uReady', 'uProgress', 'uMode', 'uStyle', 'uLoops', 'uFlow', 'uSoftPx',
  'uWavAmpPx', 'uWavScalePx', 'uFeWidthPx', 'uFeMode', 'uFeGlowWPx', 'uFeGlowI',
  'uBeOn', 'uBeOffsetPx', 'uBeWidthPx', 'uBeMode', 'uBeGlowWPx', 'uBeGlowI',
  'uFeAlpha', 'uBeAlpha',
];
const SCALAR_DEFAULTS = {
  uSpan: 1, uReady: 0, uProgress: 0, uMode: 0, uStyle: 0, uLoops: 3, uFlow: 1,
  uSoftPx: 6, uWavAmpPx: 8, uWavScalePx: 60, uFeWidthPx: 0, uFeMode: 0,
  uFeGlowWPx: 14, uFeGlowI: 0.8, uBeOn: 0, uBeOffsetPx: 60, uBeWidthPx: 4,
  uBeMode: 0, uBeGlowWPx: 10, uBeGlowI: 0.6, uFeAlpha: 1, uBeAlpha: 1,
};


  const hash21 = Fn(([pIn]) => {
    const p = fract(pIn.mul(vec2(123.34, 456.21))).toVar();
    p.addAssign(dot(p, p.add(45.32)));
    return fract(p.x.mul(p.y));
  }).setLayout({ name: 'afHash21', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

  const afVn = Fn(([pIn]) => {
    const i = floor(pIn).toVar();
    const f = fract(pIn).toVar();
    f.assign(f.mul(f).mul(float(3.0).sub(f.mul(2.0))));
    const a = hash21(i);
    const b = hash21(i.add(vec2(1.0, 0.0)));
    const c = hash21(i.add(vec2(0.0, 1.0)));
    const d = hash21(i.add(vec2(1.0, 1.0)));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }).setLayout({ name: 'afVn', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

  // Cubic B-spline weight. Multi-return GLSL → one .toVar() + If/ElseIf (pair 03).
  const afCubw = Fn(([tIn]) => {
    const t = abs(tIn).toVar();
    const t2 = t.mul(t).toVar();
    const r = float(0.0).toVar();
    If(t.lessThan(1.0), () => {
      r.assign(float(4.0).sub(float(6.0).mul(t2)).add(float(3.0).mul(t2).mul(t)).div(6.0));
    }).ElseIf(t.lessThan(2.0), () => {
      const k = float(2.0).sub(t).toVar();
      r.assign(k.mul(k).mul(k).div(6.0));
    });
    return r;
  }).setLayout({ name: 'afCubw', type: 'float', inputs: [{ name: 't', type: 'float' }] });

  const afDec = Fn(([t]) => floor(t.r.mul(255.0).add(0.5)).mul(256.0)
    .add(floor(t.g.mul(255.0).add(0.5))).div(65535.0))
    .setLayout({ name: 'afDec', type: 'float', inputs: [{ name: 't', type: 'vec4' }] });

  // The layer-box uniforms are INPUTS, not closed-over module scope. A .setLayout()ed
  // Fn becomes a real WGSL function, and a uniform it merely closes over is emitted as
  // `object.nodeUniformN` while only the MATERIAL's own graph decides which uniforms
  // land in its struct — so the same helper compiled in a different context yields
  // "struct member nodeUniform2 not found" and an invalid pipeline. It only shows up
  // when a control changes at RUNTIME (a reload-per-state harness never sees it).
  // Identical root cause and fix as pair 14's mbCard. See PORTING-GUIDE §7b.
  // Through the layer plane's projective map (the inverse homography), like the
  // GLSL: the affine frame cannot describe the trapezoid a 3D tilt projects.
  const fxLocal = Fn(([uv, hi]) => {
    const h = hi.mul(vec3(uv.x, uv.y, 1.0)).toVar();
    const l = h.xy.div(max(h.z, 1e-6));
    return select(h.z.lessThan(1e-6), vec2(-1e3, -1e3), l);
  }).setLayout({ name: 'afFxLocal', type: 'vec2', inputs: [
    { name: 'uv', type: 'vec2' }, { name: 'hi', type: 'mat3' },
  ] });

  const fxCoord = Fn(([uv, hi, sizePx]) => {
    const c = fxLocal(uv, hi).mul(sizePx).toVar();
    return floor(c.add(0.25)).add(0.5);
  }).setLayout({ name: 'afFxCoord', type: 'vec2', inputs: [
    { name: 'uv', type: 'vec2' }, { name: 'hi', type: 'mat3' },
    { name: 'sizePx', type: 'vec2' },
  ] });

  const unpremult = Fn(([c]) => c.rgb.div(max(c.a, 1e-4)))
    .setLayout({ name: 'afUnpremult', type: 'vec3', inputs: [{ name: 'c', type: 'vec4' }] });

  const premult = Fn(([c, a]) => vec4(c.mul(clamp(a, 0.0, 1.0)), clamp(a, 0.0, 1.0)))
    .setLayout({
      name: 'afPremult', type: 'vec4',
      inputs: [{ name: 'c', type: 'vec3' }, { name: 'a', type: 'float' }],
    });

  const inUnit = (s) => s.x.greaterThanEqual(0.0).and(s.x.lessThanEqual(1.0))
    .and(s.y.greaterThanEqual(0.0)).and(s.y.lessThanEqual(1.0));

  // ── AF_FRAGMENT, ported ────────────────────────────────────────────────────
  // Textures are bound at BUILD time (pair 07/08b rule); the material is rebuilt
  // whenever the field or a ramp texture identity changes, never rebound.

/** Mirrors createAutoFillMaterial()'s uniform surface key for key. */
export function createAutoFillNodeMaterial() {
  const u = {
    uTexture: makeSampler(),
    // The arrival field is a nearest-filtered packed data texture. Building
    // this binding from the usual linear placeholder silently changed it into
    // a filtered sample on WebGPU, interpolating encoded high/low bytes before
    // afDec() could reconstruct them.
    uField: makeSampler(false, THREE.NearestFilter),
    uRamp: makeSampler(),
    uRampFE: makeSampler(),
    uRampBE: makeSampler(),
    uResolution: uniform(new THREE.Vector2(1280, 720)),
    uFxOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uFxAxisX: uniform(new THREE.Vector2(0.5, 0)),
    uFxAxisY: uniform(new THREE.Vector2(0, 0.5)),
    uFxHom: uniform(new THREE.Matrix3()),
    uFxHomInv: uniform(new THREE.Matrix3()),
    uFxSizePx: uniform(new THREE.Vector2(1280, 720)),
    uGrid: uniform(new THREE.Vector2(1, 1)),
    uFillColor: uniform(new THREE.Color('#7dd3c0')),
    uFeColor: uniform(new THREE.Color('#ffd9a0')),
    uBeColor: uniform(new THREE.Color('#ffffff')),
  };
  for (const k of SCALARS) u[k] = uniform(SCALAR_DEFAULTS[k]);

  // The lab's names, aliased onto this material's uniforms so its body below
  // stays verbatim.
  const S = u;
  const uRes = u.uResolution;
  const uFxOrigin = u.uFxOrigin;
  const uFxAxisX = u.uFxAxisX;
  const uFxAxisY = u.uFxAxisY;
  const uFxHomInv = u.uFxHomInv;
  const uFxSizePx = u.uFxSizePx;
  const uGrid = u.uGrid;
  const uFillColor = u.uFillColor;
  const uFeColor = u.uFeColor;
  const uBeColor = u.uBeColor;
  const plateNode = u.uTexture;
  const fieldNode = u.uField;
  const rampNode = u.uRamp;
  const rampFENode = u.uRampFE;
  const rampBENode = u.uRampBE;

  // Same UV as GLSL `gl_FragCoord.xy / uResolution` and as motionBlur/trail:
  // plain screenCoordinate. The earlier flipped plate sample was lab residue —
  // with app RTs upright under that UV it mirrored the isolate (and with a
  // mismatched crop bake, painted the fill across empty texels → black).
  const frameUv = screenCoordinate.xy.div(uRes);

    const body = Fn(() => {
      const src = plateNode.sample(frameUv).toVar();
      const outC = vec4(0.0).toVar();
      outC.assign(src);

      If(S.uReady.greaterThanEqual(0.5), () => {
        const local = fxLocal(frameUv, uFxHomInv).toVar();
        If(inUnit(local), () => {
          const span = max(S.uSpan, 1e-3).toVar();
          const ref = uRes.y.div(1080.0).toVar();
          const cellPx = float(0.5)
            .mul(uFxSizePx.x.div(uGrid.x).add(uFxSizePx.y.div(uGrid.y))).toVar();
          const normPerPx = ref.div(span.mul(max(cellPx, 1e-3))).toVar();

          // 4×4 bicubic B-spline over reachable taps. dx/dy are compile-time
          // constants in the GLSL loop too, so unrolling in JS is exact — but
          // every accumulator stays a NODE (guide §1 precision rule).
          const g = local.mul(uGrid).sub(0.5).toVar();
          const g0 = floor(g).toVar();
          const f = fract(g).toVar();
          const csum = float(0.0).toVar();
          const cw = float(0.0).toVar();
          const reach = float(0.0).toVar();
          for (let dy = -1; dy <= 2; dy++) {
            for (let dx = -1; dx <= 2; dx++) {
              const tap = fieldNode.sample(g0.add(vec2(dx, dy)).add(0.5).div(uGrid));
              const a = afDec(tap).toVar();
              If(a.lessThan(0.995), () => {
                const w = afCubw(float(dx).sub(f.x)).mul(afCubw(float(dy).sub(f.y))).toVar();
                csum.addAssign(a.mul(w));
                cw.addAssign(w);
                if (dx >= 0 && dx <= 1 && dy >= 0 && dy <= 1) reach.assign(1.0);
              });
            }
          }

          If(cw.greaterThan(0.0).and(reach.greaterThanEqual(0.5)), () => {
            const arr = csum.div(cw).toVar();

            const softN = S.uSoftPx.mul(normPerPx).toVar();
            const wavN = S.uWavAmpPx.mul(normPerPx).toVar();
            const pad = softN.add(wavN).add(0.03).toVar();
            const endPad = pad.add(
              S.uBeOn.greaterThan(0.5).select(S.uBeOffsetPx.mul(normPerPx), float(0.0)),
            ).toVar();
            const p = pad.negate()
              .add(clamp(S.uProgress, 0.0, 1.0).mul(float(0.98).add(pad).add(endPad))).toVar();

            const wn = afVn(
              fxCoord(frameUv, uFxHomInv, uFxSizePx).div(max(S.uWavScalePx.mul(ref), 4.0))
                .add(vec2(S.uProgress.mul(S.uFlow).mul(0.7), 0.0)),
            ).sub(0.5).toVar();
            const arrE = arr.add(wn.mul(2.0).mul(wavN)).toVar();
            const soft = max(softN, 0.002).toVar();
            const fill = float(1.0).sub(smoothstep(p.sub(soft), p.add(soft), arrE)).toVar();

            const styleCol = vec3(0.0).toVar();
            styleCol.assign(uFillColor);
            If(S.uStyle.greaterThan(0.5).and(S.uStyle.lessThan(1.5)), () => {
              const age = clamp(p.sub(arrE).div(0.35), 0.0, 1.0);
              styleCol.assign(rampNode.sample(vec2(float(1.0).sub(age), 0.5)).rgb);
            }).ElseIf(S.uStyle.greaterThan(1.5).and(S.uStyle.lessThan(2.5)), () => {
              const ph = fract(arrE.mul(S.uLoops).sub(S.uProgress.mul(S.uFlow)));
              styleCol.assign(rampNode.sample(vec2(ph, 0.5)).rgb);
            }).ElseIf(S.uStyle.greaterThan(2.5).and(S.uStyle.lessThan(3.5)), () => {
              const tn = afVn(fxCoord(frameUv, uFxHomInv, uFxSizePx).div(max(float(34.0).mul(ref), 4.0))).mul(0.9).add(0.25);
              styleCol.assign(uFillColor.mul(tn));
            });

            // Front edge: crisp band (solid or ramp across the band) + additive glow.
            const aa = float(1.5).mul(normPerPx).toVar();
            const feHalf = S.uFeWidthPx.mul(0.5).mul(normPerPx).toVar();
            const feBand = S.uFeWidthPx.lessThan(0.5).select(
              float(0.0),
              float(1.0).sub(smoothstep(feHalf.sub(aa), feHalf.add(aa), abs(arrE.sub(p)))),
            ).toVar();
            const feT = clamp(
              p.add(feHalf).sub(arrE).div(max(feHalf.mul(2.0), 1e-5)), 0.0, 1.0).toVar();
            const feCol = S.uFeMode.greaterThan(0.5)
              .select(rampFENode.sample(vec2(feT, 0.5)).rgb, uFeColor).toVar();
            const feGw = max(S.uFeGlowWPx.mul(normPerPx), 1e-3).toVar();
            const feGlow = S.uFeGlowWPx.lessThan(0.5).select(
              float(0.0),
              exp(abs(arrE.sub(p)).negate().div(feGw)).mul(S.uFeGlowI),
            ).toVar();

            // Back edge: trailing band at an offset behind the front.
            const beC = p.sub(S.uBeOffsetPx.mul(normPerPx)).toVar();
            const beHalf = S.uBeWidthPx.mul(0.5).mul(normPerPx).toVar();
            const beOff = S.uBeOn.lessThan(0.5).or(S.uBeWidthPx.lessThan(0.5));
            const beBand = beOff.select(
              float(0.0),
              float(1.0).sub(smoothstep(beHalf.sub(aa), beHalf.add(aa), abs(arrE.sub(beC)))),
            ).toVar();
            const beT = clamp(
              beC.add(beHalf).sub(arrE).div(max(beHalf.mul(2.0), 1e-5)), 0.0, 1.0).toVar();
            const beCol = S.uBeMode.greaterThan(0.5)
              .select(rampBENode.sample(vec2(beT, 0.5)).rgb, uBeColor).toVar();
            const beGw = max(S.uBeGlowWPx.mul(normPerPx), 1e-3).toVar();
            const beGlow = S.uBeOn.lessThan(0.5).or(S.uBeGlowWPx.lessThan(0.5)).select(
              float(0.0),
              exp(abs(arrE.sub(beC)).negate().div(beGw)).mul(S.uBeGlowI),
            ).toVar();

            // Premultiplied composite: fill inside the alpha, bands over it, then
            // the glows added as light (clipped to the silhouette).
            const alpha = src.a.toVar();
            const paint = S.uStyle.greaterThan(3.5).select(float(0.0), fill).toVar();
            const res = vec4(0.0).toVar();
            If(S.uMode.lessThan(0.5), () => {
              res.assign(premult(mix(unpremult(src), styleCol, paint), alpha));
            }).ElseIf(S.uMode.lessThan(1.5), () => {
              res.assign(src.mul(float(1.0).sub(fill)));
            }).Else(() => {
              res.assign(src.mul(fill));
            });
            const beA = beBand.mul(alpha).mul(S.uBeAlpha).toVar();
            res.assign(premult(beCol, beA).add(res.mul(float(1.0).sub(beA))));
            const feA = feBand.mul(alpha).mul(S.uFeAlpha).toVar();
            res.assign(premult(feCol, feA).add(res.mul(float(1.0).sub(feA))));
            res.assign(vec4(
              res.rgb.add(beCol.mul(beGlow).mul(alpha)).add(feCol.mul(feGlow).mul(alpha)),
              res.a,
            ));
            outC.assign(res);
          });
        });
      });
      return outC;
    });
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = body();
  material.transparent = true;
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  // ShaderMaterial defaults this true, every NodeMaterial false (§13).
  material.forceSinglePass = true;
  material.uniforms = u;
  return material;
}

/**
 * The crop pass from autofillField.js. Small, but not optional: WebGPURenderer
 * cannot draw the GLSL original, so without this the bake never produces a field.
 */
export function createAutoFillCropNodeMaterial() {
  const u = {
    // `uTex`, not `uTexture`: autofillField.js drives this material by name
    // (`cropMaterial.uniforms.uTex.value = ...`), so the twin has to answer to
    // the same key or the swap binds nothing and the crop reads the placeholder.
    uTex: makeSampler(),
    uOutSize: uniform(new THREE.Vector2(256, 256)),
    uOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uAxisX: uniform(new THREE.Vector2(0.5, 0)),
    uAxisY: uniform(new THREE.Vector2(0, 0.5)),
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    // gl_FragCoord.y is BOTTOM-up; screenCoordinate.y is TOP-down. The GLSL
    // crop maps the target's bottom row to the box's -Y side, and
    // readTargetPixels' readback row-flip assumes exactly that write order —
    // so the twin must flip Y here or the baked mask comes out V-mirrored
    // (measured: synthetic half-opaque matte → mirrored mask hash on WebGPU).
    const p = vec2(screenCoordinate.x, u.uOutSize.y.sub(screenCoordinate.y)).div(u.uOutSize);
    const q = p.mul(2.0).sub(1.0).toVar();
    const uvc = u.uOrigin.add(u.uAxisX.mul(q.x)).add(u.uAxisY.mul(q.y)).toVar();
    // Outside the layer box there is NO plate data: transparent, not the clamped
    // edge texel, which would smear the border row across the whole crop.
    return inUnit(uvc).select(u.uTex.sample(uvc), vec4(0.0));
  })();
  material.transparent = true;
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  material.forceSinglePass = true;
  material.uniforms = u;
  return material;
}
