/*
 * TSL twins of the BUILT-IN transition packages' fragments — matrix rows 07/07b.
 *
 * Scope, which is the important part of this file: only the packages the app
 * ships are ported. The v2 SDK's `createShaderMaterial({ fragmentShader })`
 * takes a GLSL STRING, and no WebGPU renderer can compile GLSL at runtime, so a
 * package that brings its own shader cannot run — PORT-PLAN §5 already lists
 * "transition SDK v2" among the deletions. The built-ins are app code and must
 * survive, or the shipped 3D Carousel and Circular Wipe transitions stop
 * rendering; everything here is one of those.
 *
 * Each factory returns a material whose `.uniforms.<name>.value` behaves exactly
 * like a ShaderMaterial's, so the packages' own `render()` drivers — which are
 * plain renderer-agnostic JS — mutate these unchanged.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, int, uniform, texture, uv, screenCoordinate, screenSize, vec2, vec3, vec4, float, mat2, dot, cross,
  mix, clamp, abs, max, min, length, floor, fract, sin, cos, atan, normalize, smoothstep, select, step,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';
import { CAMERA_WHIP_NODE_SAMPLES } from './cameraWhipSamples.js';
import { srSdBox, srCoverage } from './shapeRulersNodes.js';

function finish(material, uniforms) {
  // makeTwoTextureInstance switches every pass to the premultiplied OVER.
  material.transparent = false;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  // ShaderMaterial defaults this to true, every NodeMaterial to false; leaving
  // it false opts a transparent DoubleSide material into the two-pass
  // back/front draw and reorders any self-overlap (PORTING-GUIDE §13).
  material.forceSinglePass = true;
  material.uniforms = uniforms;
  return material;
}

/** GLSL `mat2 rot(a)` — column-major, same as the source. */
const rot = Fn(([a]) => {
  const c = cos(a);
  const s = sin(a);
  return mat2(c, s.negate(), s, c);
}).setLayout({ name: 'tpRot', type: 'mat2', inputs: [{ name: 'a', type: 'float' }] });

/** Louver: slats rotate through π, showing previous then current. */
/** Null-safe binding facade; see tslSampler.js. Opaque BLACK fallback: an
 * unbound transition side is an empty frame, not a white flash. */
const makeSampler = () => makeTslSampler({ rgba: [0, 0, 0, 255] });

export function createLouverNodeMaterial() {
  const u = {
    uPrevious: makeSampler(),
    uCurrent: makeSampler(),
    uProgress: uniform(0),
    uSlats: uniform(12),
    uStagger: uniform(0.2),
    uShadeAmt: uniform(0.6),
    uOrient: uniform(0),
  };
  const ez = (tIn) => {
    const t = clamp(tIn, 0.0, 1.0);
    return t.mul(t).mul(float(3.0).sub(t.mul(2.0)));
  };
  const fragment = Fn(() => {
    const vUv = uv();
    const q = mix(vUv, vUv.yx, u.uOrient);
    const N = max(float(1.0), u.uSlats);
    const i = floor(q.y.mul(N));
    const local = fract(q.y.mul(N));
    const sVal = clamp(u.uProgress.mul(float(1.0).add(N.sub(1.0).mul(u.uStagger))).sub(i.mul(u.uStagger)), 0.0, 1.0);
    const th = ez(sVal).mul(3.14159265);
    const co = cos(th);
    const ac = max(abs(co), 0.02);
    const ly = local.sub(0.5).div(ac).add(0.5);
    const out = vec4(0.0).toVar();
    // Past an edge-on slat `out` stays vec4(0): transparent, like the GLSL.
    If(ly.greaterThanEqual(0.0).and(ly.lessThanEqual(1.0)), () => {
      const gy = i.add(ly).div(N);
      const suv0 = mix(vec2(q.x, gy), vec2(gy, q.x), u.uOrient);
      // Capture plates are camera-rendered: mirrored storage under WebGPU, so
      // the sample flips V (same rule as circleWipe / carousel).
      const suv = vec2(suv0.x, suv0.y.oneMinus());
      const shade = mix(float(1.0), float(0.4).add(ac.mul(0.6)), u.uShadeAmt);
      const src = select(co.greaterThan(0.0), u.uPrevious.sample(suv), u.uCurrent.sample(suv));
      out.assign(vec4(src.rgb.mul(shade), src.a));
    });
    return out;
  });
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = fragment();
  return finish(material, u);
}

/**
 * Circular Wipe: a feathered expanding (or closing) front, an optional gradient
 * beam riding that front, and a parallax settle on both plates.
 */
export function createCircleWipeNodeMaterial() {
  const u = {
    uPrevious: makeSampler(),
    uCurrent: makeSampler(),
    uProgress: uniform(0),
    uRatio: uniform(1.777),
    uCenter: uniform(new THREE.Vector2(0.5, 0.5)),
    uMaxR: uniform(1),
    uFeather: uniform(0.04),
    uInvert: uniform(0),
    uBeam: uniform(0),
    uBeamMode: uniform(0),
    uBeamW: uniform(0.04),
    uBeamI: uniform(1),
    uBloomW: uniform(0.08),
    uBloomI: uniform(0.5),
    uFlow: uniform(0),
    uBeamFade: uniform(0.15),
    uC0: uniform(new THREE.Color(1, 1, 1)),
    uC1: uniform(new THREE.Color(1, 1, 1)),
    uC2: uniform(new THREE.Color(1, 1, 1)),
    uC3: uniform(new THREE.Color(1, 1, 1)),
    uParZoom: uniform(0),
    uParDrift: uniform(0),
    uParPush: uniform(0),
  };
  const grad4 = (t) => {
    const sv = fract(t).mul(4.0);
    const out = vec3(0.0).toVar();
    If(sv.lessThan(1.0), () => { out.assign(mix(u.uC0, u.uC1, smoothstep(0.0, 1.0, sv))); })
      .ElseIf(sv.lessThan(2.0), () => { out.assign(mix(u.uC1, u.uC2, smoothstep(0.0, 1.0, sv.sub(1.0)))); })
      .ElseIf(sv.lessThan(3.0), () => { out.assign(mix(u.uC2, u.uC3, smoothstep(0.0, 1.0, sv.sub(2.0)))); })
      .Else(() => { out.assign(mix(u.uC3, u.uC0, smoothstep(0.0, 1.0, sv.sub(3.0)))); });
    return out;
  };
  const zoomAt = (p, c, z) => c.add(p.sub(c).div(max(z, 0.02)));

  const fragment = Fn(() => {
    const vUv = uv();
    const asp = vec2(u.uRatio, 1.0);
    const p = vUv.sub(u.uCenter).mul(asp);
    const r = length(p);

    const prog = mix(u.uProgress, float(1.0).sub(u.uProgress), u.uInvert);
    const fe = max(u.uFeather.mul(u.uMaxR), 0.0015);
    const R = prog.mul(u.uMaxR.add(fe.mul(2.0))).sub(fe);
    const d = r.sub(R);
    // Every smoothstep keeps edge0 < edge1: reversed edges are undefined in the
    // GLSL spec even where desktop drivers happen to ramp them backwards.
    const inside = float(1.0).sub(smoothstep(fe.negate(), fe, d));
    const mask = mix(inside, float(1.0).sub(inside), u.uInvert);

    // The incoming clip settles out of a zoom and a drift anchored on the wipe
    // point; the outgoing one pushes past the camera. Both ride eased progress.
    const settle = u.uProgress;
    const uvB = zoomAt(vUv, u.uCenter, mix(float(1.0).add(u.uParZoom), float(1.0), settle))
      .add(normalize(p.add(vec2(1e-5))).div(asp).mul(u.uParDrift).mul(float(1.0).sub(settle)).mul(0.25));
    const uvA = zoomAt(vUv, u.uCenter, float(1.0).add(u.uParPush.mul(settle)));

    // Plates are premultiplied, so mixing the whole vec4 IS the correct blend.
    // Sample V flips: the capture plates are camera-rendered, so under WebGPU
    // their storage is mirrored against this fragment's uv() (see louver).
    const col = mix(
      u.uPrevious.sample(clamp(vec2(uvA.x, uvA.y.oneMinus()), 0.0, 1.0)),
      u.uCurrent.sample(clamp(vec2(uvB.x, uvB.y.oneMinus()), 0.0, 1.0)),
      mask,
    ).toVar();

    If(u.uBeam.greaterThan(0.5), () => {
      const bw = max(u.uBeamW.mul(u.uMaxR), 0.002);
      const core = d.mul(d).div(bw.mul(bw)).negate().exp();
      const halo = abs(d).div(max(u.uBloomW.mul(u.uMaxR), 0.004)).negate().exp();
      const ang = atan(p.y, p.x).mul(0.15915494).add(0.5);
      const gcol = grad4(mix(ang.add(u.uFlow), d.div(bw).mul(0.25).add(u.uFlow), u.uBeamMode));
      // A wide bloom needs the long tail — cut it short and the glow vanishes in
      // a single frame.
      const fade = max(u.uBeamFade, 0.001);
      const alive = smoothstep(float(0.0), fade, prog)
        .mul(float(1.0).sub(smoothstep(float(1.0).sub(fade), float(1.0), prog)));
      // Darkening under the core keeps the gradient readable on bright footage.
      col.rgb.mulAssign(float(1.0).sub(core.mul(alive).mul(min(u.uBeamI, 1.0)).mul(0.45)));
      // Added to premultiplied colour and NOT to alpha, so the beam behaves as
      // light rather than punching a hole in the frame.
      col.rgb.addAssign(gcol.mul(core.mul(u.uBeamI).add(halo.mul(halo).mul(u.uBloomI))).mul(alive));
    });

    return col;
  });
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = fragment();
  return finish(material, u);
}

/**
 * 3D Carousel: two panels on a spinning rig, ray-marched with a 16-sample
 * shutter. Each pixel opens its shutter at its own phase (interleaved gradient
 * noise on the fragment coordinate) so the samples integrate into a continuous
 * smear rather than visible ghost copies — which is why the fragment coordinate
 * has to match the GLSL's `gl_FragCoord` ORIENTATION, not merely its scale: a
 * y-flip hands each pixel a different jitter and changes the noise.
 */
export function createCarouselNodeMaterial() {
  const u = {
    uPrevious: makeSampler(),
    uCurrent: makeSampler(),
    uRatio: uniform(1.777),
    uRectC: uniform(new THREE.Vector2(0, 0)),
    uRectH: uniform(new THREE.Vector2(0.888, 0.5)),
    uTanHF: uniform(0.5),
    uOrtho: uniform(0),
    uSpacing: uniform(1.5708),
    uRadiusMul: uniform(1),
    uShade: uniform(0.5),
    uSign: uniform(1),
    uAxisSC: uniform(new THREE.Vector2(0, 1)),
    uShear: uniform(0),
    uTheta0: uniform(0),
    uTheta1: uniform(0),
    uBgLift: uniform(0),
    uBackdrop: uniform(1),
    uUseAlpha: uniform(0),
  };

  // Interleaved gradient noise — deterministic per-pixel phase.
  const ign = (p) => fract(fract(p.x.mul(0.06711056).add(p.y.mul(0.00583715))).mul(52.9829189));
  // Rodrigues rotation of v about unit axis a by (c, s).
  const rot3 = (v, a, c, sN) => v.mul(c).add(cross(a, v).mul(sN)).add(a.mul(dot(a, v)).mul(float(1.0).sub(c)));

  const fragment = Fn(() => {
    const vUv = uv();
    // gl_FragCoord: origin bottom-left, pixel centres. Reproduced exactly,
    // because ign() hashes it.
    const fragCoord = vec2(screenCoordinate.x, screenSize.y.sub(screenCoordinate.y));

    const ndc = vUv.mul(2.0).sub(1.0);
    const scr = vec2(ndc.x.mul(u.uRatio), ndc.y);
    const local = scr.sub(u.uRectC).div(u.uRectH.y);
    const H = float(1.0);
    const W = u.uRectH.x.div(u.uRectH.y);
    // At fov 0 there is no camera distance — the camera is orthographic, the rig
    // sits at the origin and the rays run parallel from a plane in front of it.
    const D = mix(float(1.0).div(max(u.uTanHF, 1e-6)), float(0.0), u.uOrtho);
    const axis = vec3(u.uAxisSC.x, u.uAxisSC.y, 0.0);
    // Half extent perpendicular to the tilted axis, so "radius in half-panel-
    // widths" stays meaningful as the tilt turns W into H.
    const effW = W.mul(abs(u.uAxisSC.y)).add(H.mul(abs(u.uAxisSC.x)));
    const R = u.uRadiusMul.mul(effW);
    const uv0 = vec2(u.uRectC.x.sub(u.uRectH.x).div(u.uRatio).mul(0.5).add(0.5),
      u.uRectC.y.sub(u.uRectH.y).mul(0.5).add(0.5));
    const uvS = vec2(u.uRectH.x.div(u.uRatio), u.uRectH.y);

    const bgCol = vec3(0.03, 0.035, 0.05).add(u.uBgLift)
      .mul(float(1.0).sub(length(ndc.mul(vec2(0.7, 1.0))).mul(0.35)));
    const bg = vec4(bgCol, 1.0).mul(u.uBackdrop);   // premultiplied; 0 = see through

    // GLSL's early `return vec4(0.0)` guards become a result var: alpha 0 = miss.
    const panelHit = (ro, rd, phi, W2, H2, k) => {
      const out = vec4(0.0).toVar();
      const c = cos(phi);
      const sN = sin(phi);
      const n = rot3(vec3(0.0, 0.0, 1.0), axis, c, sN);
      const denom = dot(rd, n);
      If(dot(n, rd.negate()).greaterThan(0.0).and(abs(denom).greaterThanEqual(1e-5)), () => {
        const C = vec3(0.0, 0.0, D.add(R).negate()).add(n.mul(R));
        const t = dot(C.sub(ro), n).div(denom);
        If(t.greaterThanEqual(1e-4), () => {
          const dv = ro.add(rd.mul(t)).sub(C);
          const px0 = dot(dv, rot3(vec3(1.0, 0.0, 0.0), axis, c, sN));
          const py0 = dot(dv, rot3(vec3(0.0, 1.0, 0.0), axis, c, sN));
          // Un-shear in the (sweep, along-axis) frame.
          const sw = px0.mul(u.uAxisSC.y).sub(py0.mul(u.uAxisSC.x)).sub(
            k.mul(px0.mul(u.uAxisSC.x).add(py0.mul(u.uAxisSC.y))));
          const al = px0.mul(u.uAxisSC.x).add(py0.mul(u.uAxisSC.y));
          const px = sw.mul(u.uAxisSC.y).add(al.mul(u.uAxisSC.x));
          const py = sw.negate().mul(u.uAxisSC.x).add(al.mul(u.uAxisSC.y));
          const uu = px.div(W2).mul(0.5).add(0.5);
          const vv = py.div(H2).mul(0.5).add(0.5);
          const aa = float(0.004);
          // GLSL accepts reverse-edge smoothstep (1 → 1-aa); WGSL rejects it at
          // compile time and the whole carousel pipeline never draws. Invert the
          // high-edge falloff explicitly instead.
          const alpha = smoothstep(float(0.0), aa, uu)
            .mul(float(1.0).sub(smoothstep(float(1.0).sub(aa), float(1.0), uu)))
            .mul(smoothstep(float(0.0), aa, vv))
            .mul(float(1.0).sub(smoothstep(float(1.0).sub(aa), float(1.0), vv)));
          If(alpha.greaterThan(0.0), () => { out.assign(vec4(uu, vv, t, alpha)); });
        });
      });
      return out;
    };

    const shadePanel = (col, phi, puv) => {
      const facing = clamp(cos(phi), 0.0, 1.0);   // n·z == cos(phi) at any tilt
      const c1 = col.mul(mix(float(1.0).sub(u.uShade), float(1.0), facing));
      const px = puv.x.sub(0.5).mul(2.0).mul(W);
      const py = puv.y.sub(0.5).mul(2.0).mul(H);
      const sweep = px.mul(u.uAxisSC.y).sub(py.mul(u.uAxisSC.x)).div(effW.mul(2.0));
      return c1.mul(float(1.0).sub(u.uShade.mul(0.18).mul(smoothstep(0.35, 0.5, abs(sweep)))));
    };

    const acc = vec4(0.0).toVar();
    const jitter = ign(fragCoord);
    const SAMPLES = 16;
    for (let i = 0; i < SAMPLES; i += 1) {
      const fs = float(i).add(jitter).div(float(SAMPLES));
      const theta = mix(u.uTheta0, u.uTheta1, fs);
      const phiA = u.uSign.mul(theta);
      const phiB = u.uSign.mul(theta.sub(u.uSpacing));
      // The whip shear rides the RIG, not the panel: same lean on both, zero at
      // both ends of the turn, peak in the middle.
      const k = u.uShear.mul(sin(clamp(theta.div(max(u.uSpacing, 1e-4)), 0.0, 1.0).mul(3.14159265)));

      const ro = vec3(local, 100.0).mul(u.uOrtho);
      const rd = mix(normalize(vec3(local.x.mul(u.uTanHF), local.y.mul(u.uTanHF), -1.0)),
        vec3(0.0, 0.0, -1.0), u.uOrtho);

      const hA = panelHit(ro, rd, phiA, W, H, k);
      const hB = panelHit(ro, rd, phiB, W, H, k);

      const col = vec4(bg).toVar();
      const aNear = hA.w.greaterThan(0.0).and(hB.w.lessThanEqual(0.0).or(hA.z.lessThanEqual(hB.z)));
      // Two passes: far panel, then near over it. Unrolled, since it is two.
      for (const nearPass of [false, true]) {
        const isA = nearPass ? aNear : aNear.not();
        const hh = select(isA, hA, hB);
        const phi = select(isA, phiA, phiB);
        If(hh.w.greaterThan(0.0), () => {
          const tuv0 = uv0.add(clamp(hh.xy, 0.002, 0.998).mul(uvS));
          // The panel coordinate is fragment-uv-derived (the ray starts from
          // vUv), so like louver/circleWipe the camera-captured plate
          // must be sampled with V flipped under WebGPU.
          const tuv = vec2(tuv0.x, tuv0.y.oneMinus());
          // Plates are PREMULTIPLIED (captured onto a cleared alpha-0 target), so
          // shading scales rgb and the plate's own alpha rides along.
          const sample = select(isA, u.uPrevious.sample(tuv), u.uCurrent.sample(tuv));
          const rgb = shadePanel(sample.rgb, phi, hh.xy);
          const a = mix(float(1.0), sample.a, u.uUseAlpha);
          const src = vec4(rgb, a).mul(hh.w);
          col.assign(src.add(col.mul(float(1.0).sub(src.a))));
        });
      }
      acc.addAssign(col);
    }
    return acc.div(float(SAMPLES));
  });
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = fragment();
  return finish(material, u);
}

const pbHash = Fn(([p0]) => {
  const p = fract(p0.mul(vec2(123.34, 456.21))).toVar();
  p.addAssign(dot(p, p.add(45.32)));
  return fract(p.x.mul(p.y));
}).setLayout({ name: 'pbHash', type: 'float', inputs: [{ name: 'p0', type: 'vec2' }] });

const pbRoundedBox = Fn(([p, b, r]) => {
  const q = abs(p).sub(b).add(r);
  return length(max(q, 0.0)).add(min(max(q.x, q.y), 0.0)).sub(r);
}).setLayout({
  name: 'pbRoundedBox', type: 'float',
  inputs: [{ name: 'p', type: 'vec2' }, { name: 'b', type: 'vec2' }, { name: 'r', type: 'float' }],
});

const PB_MASK_INPUTS = [{ name: 't', type: 'float' }, { name: 'phase2', type: 'float' }];

/**
 * Pixel Blocks: the lab's cell mask, expression for expression. Every switch is
 * a float uniform compared against .5 (never an int), so the GLSL and this graph
 * evaluate the same arithmetic. Cell coordinates come from uv() × uRes, which is
 * y-up on both backends like gl_FragCoord was in the lab; only the plate SAMPLES
 * flip V (see circleWipe).
 *
 * The helpers are real WGSL functions (setLayout), as they are GLSL functions in
 * the twin. Written as plain JS closures they were INLINED at every call: five
 * cell evaluations per mask, three masks, each with its four hashes and sweep
 * coordinate. three emitted 10 k lines / 361 KB of WGSL, and building it held
 * the JS thread for 1.2 s on the first frame the transition drew, then 0.35 s of
 * pipeline compile: the "freeze on first play". So `phase2` is a float argument,
 * as in the GLSL, and maskAt returns vec2(m, mN).
 */
export function createPixelBlocksNodeMaterial() {
  const u = {
    uPrevious: makeSampler(),
    uCurrent: makeSampler(),
    uRes: uniform(new THREE.Vector2(1920, 1080)),
    uCell: uniform(new THREE.Vector2(20, 20)),
    uPoint: uniform(new THREE.Vector2(0.5, 0.5)),
    uT: uniform(0),
    uT2: uniform(0),
    uSoft: uniform(0),
    uBand: uniform(0.25),
    uFade: uniform(0.26),
    uResidual: uniform(0.3),
    uLag: uniform(0.2),
    uSteps: uniform(5),
    uSeed: uniform(7),
    uAngle: uniform(0),
    uDir: uniform(1),
    uJitterBy: uniform(0),
    uMode: uniform(0),
    uDir2Rev: uniform(0),
    uScaleIn: uniform(0),
    uColor: uniform(new THREE.Color(1, 1, 1)),
    uTint: uniform(0.8),
    uPix: uniform(0.7),
    uPixScale: uniform(1),
    uGap: uniform(0.3),
    uRound: uniform(0),
    uSolo: uniform(0),
  };
  const isRadial = () => u.uDir.greaterThan(0.5).and(u.uDir.lessThan(2.5));
  const isRandom = () => u.uDir.greaterThan(2.5);
  const dirCoord = Fn(([px]) => {
    const pp = u.uPoint.mul(u.uRes);
    const far = max(pp, u.uRes.sub(pp));
    const dr = length(px.sub(pp)).div(length(far));
    const radial = select(u.uDir.lessThan(1.5), dr, float(1.0).sub(dr));
    const dir = vec2(cos(u.uAngle), sin(u.uAngle).negate());
    const d = dot(px.sub(u.uRes.mul(0.5)), dir);
    const maxD = abs(dir.x).mul(u.uRes.x).add(abs(dir.y).mul(u.uRes.y)).mul(0.5);
    const lin = d.div(maxD).mul(0.5).add(0.5);
    return select(isRadial(), radial, lin);
  }).setLayout({ name: 'pbDirCoord', type: 'float', inputs: [{ name: 'px', type: 'vec2' }] });
  const front = (band, t, fade) => band.mul(-0.5).add(t.mul(float(1.0).add(band).add(u.uLag).add(fade)));
  const cellAlpha = Fn(([cid, t, phase2]) => {
    const cc = cid.add(0.5).mul(u.uCell);
    const s = u.uSeed.mul(1.37).add(phase2.mul(101.0));
    const rLvl = pbHash(cid.add(s).add(17.1));
    const rLag = pbHash(cid.add(s).add(31.7));
    const jid = select(u.uJitterBy.greaterThan(1.5), vec2(0.0, cid.y), select(u.uJitterBy.greaterThan(0.5), vec2(cid.x, 0.0), cid));
    const rj = pbHash(jid.add(s).add(3.3));
    const d0 = select(isRandom(), pbHash(cid.add(s).add(9.9)), dirCoord(cc));
    const d = select(phase2.greaterThan(0.5).and(u.uDir2Rev.greaterThan(0.5)), float(1.0).sub(d0), d0);
    const band = select(isRandom(), float(0.0), u.uBand);
    const start = d.add(rj.sub(0.5).mul(band));
    const fade = max(u.uFade, 1e-4);
    const f = front(band, t, fade);
    const a1 = clamp(f.sub(start).div(fade), 0.0, 1.0);
    const lvl = mix(float(1.0), rLvl.mul(0.7).add(0.15), u.uResidual);
    const a2 = clamp(f.sub(start).sub(u.uLag.mul(rLag.mul(0.75).add(0.25))).div(fade), 0.0, 1.0);
    const a0 = max(a1.mul(lvl), a2);
    return select(u.uSteps.greaterThan(0.5), floor(a0.mul(u.uSteps).add(0.5)).div(max(u.uSteps, 1.0)), a0);
  }).setLayout({ name: 'pbCellAlpha', type: 'float', inputs: [{ name: 'cid', type: 'vec2' }, ...PB_MASK_INPUTS] });
  const softMask = Fn(([g, t, phase2]) => {
    const gc = g.sub(0.5);
    const i = floor(gc);
    const fr = fract(gc);
    const s = max(u.uSoft, 1e-3);
    const w = smoothstep(float(0.5).sub(s.mul(0.5)), float(0.5).add(s.mul(0.5)), fr);
    const a00 = cellAlpha(i, t, phase2);
    const a10 = cellAlpha(i.add(vec2(1.0, 0.0)), t, phase2);
    const a01 = cellAlpha(i.add(vec2(0.0, 1.0)), t, phase2);
    const a11 = cellAlpha(i.add(vec2(1.0, 1.0)), t, phase2);
    return mix(mix(a00, a10, w.x), mix(a01, a11, w.x), w.y);
  }).setLayout({ name: 'pbSoftMask', type: 'float', inputs: [{ name: 'g', type: 'vec2' }, ...PB_MASK_INPUTS] });
  // vec2(m, mN): m = the soft mask, mN = the nearest cell's alpha (drives that cell's pixelation)
  const maskAt = Fn(([px, t, phase2]) => {
    const g = px.div(u.uCell);
    const cid = floor(g);
    const aN = cellAlpha(cid, t, phase2);
    const m0 = softMask(g, t, phase2);
    const shaped = u.uGap.greaterThan(0.001).or(u.uRound.greaterThan(0.001)).or(u.uScaleIn.greaterThan(0.5));
    const local = fract(g).sub(0.5);
    const settle = smoothstep(0.6, 0.9, aN);
    const grow = select(u.uScaleIn.greaterThan(0.5), aN, float(1.0));
    const size = mix(grow.mul(float(1.0).sub(u.uGap)), float(1.0), settle);
    const rr = u.uRound.mul(size).mul(0.5).mul(float(1.0).sub(settle));
    const sd = pbRoundedBox(local, vec2(size.mul(0.5)), rr);
    const aa = float(1.0).div(min(u.uCell.x, u.uCell.y));
    // snap near-full cells shut: no hairline outlines
    const shape = select(size.lessThan(0.92), float(1.0).sub(smoothstep(aa.negate(), aa, sd)), float(1.0));
    const mShaped = select(u.uScaleIn.greaterThan(0.5), shape.mul(step(0.002, aN)), m0.mul(shape));
    return vec2(select(shaped, mShaped, m0), aN);
  }).setLayout({ name: 'pbMaskAt', type: 'vec2', inputs: [{ name: 'px', type: 'vec2' }, ...PB_MASK_INPUTS] });
  const pixUv = (px) => {
    const cs = u.uCell.mul(u.uPixScale);
    return floor(px.div(cs)).add(0.5).mul(cs).div(u.uRes);
  };
  const flipV = (p) => vec2(p.x, p.y.oneMinus());

  const fragment = Fn(() => {
    const vUv = uv();
    const px = vUv.mul(u.uRes);
    const A = u.uPrevious.sample(flipV(vUv));
    const Bp = u.uCurrent.sample(flipV(vUv));
    const puv = pixUv(px);
    const Apix = u.uPrevious.sample(flipV(puv));
    const Bpix = u.uCurrent.sample(flipV(puv));
    const o = vec4(0.0).toVar();
    If(u.uMode.greaterThan(2.5), () => {
      const m1 = maskAt(px, u.uT, float(0.0)).toVar();
      const m2 = maskAt(px, u.uT2, float(1.0)).toVar();
      const B = mix(Bp, Bpix, clamp(u.uPix.mul(float(1.0).sub(m2.y)), 0.0, 1.0));
      // One-sided, the colour fills only the layer's own pixels (premultiplied)
      const cover = mix(float(1.0), max(A.a, Bp.a), step(0.5, u.uSolo));
      o.assign(mix(mix(A, vec4(u.uColor, 1.0).mul(cover), m1.x), B, m2.x));
    }).Else(() => {
      const mask = maskAt(px, u.uT, float(0.0)).toVar();
      const m = mask.x;
      const mN = mask.y;
      const As = mix(A, Apix, clamp(u.uPix.mul(mN), 0.0, 1.0));
      const k = float(1.0).sub(m);
      const dis = As.mul(k).add(Bp.mul(float(1.0).sub(As.a.mul(k))));
      const B = mix(Bp, Bpix, clamp(u.uPix.mul(float(1.0).sub(mN)), 0.0, 1.0));
      const cross = mix(A, B, m);
      const app = B.mul(m).add(A.mul(float(1.0).sub(B.a.mul(m))));
      const base = select(u.uMode.greaterThan(1.5), dis, select(u.uMode.lessThan(0.5), cross, app)).toVar();
      const band = m.mul(float(1.0).sub(m)).mul(4.0);
      base.rgb.assign(mix(base.rgb, u.uColor.mul(base.a), u.uTint.mul(band)));
      o.assign(base);
    });
    return o;
  });
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = fragment();
  return finish(material, u);
}

/**
 * Camera Whip: the GLSL in builtinTransitionPackages.js, expression for
 * expression. Screen and plate coordinates run Y-DOWN inside the warp exactly
 * as they do there; the GLSL entry flip `1 - vUv.y` stays, and the plate fetch
 * loses its flip instead, because a camera-captured plate is stored mirrored
 * under WebGPU (see circleWipe). Every switch is a float against a threshold,
 * never an int, so both backends evaluate the same arithmetic. The sample loop
 * is unrolled at the same count as the GLSL constant — importing it keeps the
 * two from drifting.
 */
export function createCameraWhipNodeMaterial() {
  const u = {
    uPrevious: makeSampler(),
    uCurrent: makeSampler(),
    uAspect: uniform(16 / 9),
    uFocal: uniform(1.6),
    uK: uniform(new THREE.Vector3(0, 1, 0)),
    uK2: uniform(new THREE.Vector3(1, 0, 0)),
    uRotA: uniform(new THREE.Vector3()),
    uRotB: uniform(new THREE.Vector3()),
    uSweepA: uniform(new THREE.Vector3()),
    uSweepB: uniform(new THREE.Vector3()),
    uRS: uniform(new THREE.Vector3()),
    uFocalOut: uniform(1.6),
    uFocalSweep: uniform(0),
    uBias: uniform(0),
    uStreak: uniform(1.35),
    uChroma: uniform(0),
    uMix: uniform(0),
    uEdge: uniform(0),
    uTileFade: uniform(0.35),
    uFoldA: uniform(new THREE.Vector4(0, 0, 1, 1)),
    uFoldB: uniform(new THREE.Vector4(0, 0, 1, 1)),
    uFlash: uniform(new THREE.Vector3(1, 1, 1)),
    uFlashAmt: uniform(0),
    uSolo: uniform(0),
    uSamplesA: uniform(1),
    uSamplesB: uniform(1),
  };

  const ign = (p) => fract(fract(p.x.mul(0.06711056).add(p.y.mul(0.00583715))).mul(52.9829189));
  // Rodrigues with the angle's sine and cosine already in hand.
  const turn = (v, k, c, sN) => v.mul(c).add(cross(k, v).mul(sN)).add(k.mul(dot(k, v)).mul(float(1.0).sub(c)));

  const fragment = Fn(() => {
    const vUv = uv();
    const q = vec2(vUv.x, vUv.y.oneMinus());
    // gl_FragCoord: origin bottom-left, pixel centres. Reproduced exactly,
    // because ign() hashes it.
    const fragCoord = vec2(screenCoordinate.x, screenSize.y.sub(screenCoordinate.y));
    const jitter = ign(fragCoord);

    const mirrorRepeat = (p) => {
      const t = p.mod(2.0);
      return mix(t, float(2.0).sub(t), step(1.0, t));
    };
    const outsideAmount = (p) => clamp(max(
      max(float(0.0).sub(p.x), p.x.sub(1.0)),
      max(float(0.0).sub(p.y), p.y.sub(1.0)),
    ), 0.0, 1.0);

    // Mirror and Clamp fold at the picture's edge, not the plate's — the GLSL
    // whipFetch. A fold of (0, 0, 1, 1) is the plate itself.
    const fetchEdge = (sampler, p, fold, behind) => {
      const span = fold.zw.sub(fold.xy);
      const l = p.sub(fold.xy).div(span);
      const o = max(outsideAmount(l), behind);
      const mirror = step(u.uEdge, 0.5);
      const inside = fold.xy.add(mix(clamp(l, 0.0005, 0.9995), mirrorRepeat(l), mirror).mul(span));
      // GLSL flips V here; the WebGPU plate is stored mirrored, so it does not.
      const c = sampler.sample(vec2(inside.x, inside.y)).toVar();
      const invent = step(u.uEdge, 1.5);
      const lit = c.rgb.mul(float(1.0).sub(u.uTileFade.mul(clamp(o.mul(3.0), 0.0, 1.0)).mul(invent)));
      const blank = vec4(0.0, 0.0, 0.0, step(2.5, u.uEdge));
      return mix(vec4(lit, c.a), blank, float(1.0).sub(invent).mul(step(0.0001, o)));
    };

    // Output pixel to plate uv, through the camera. `behind` marks a ray that
    // turned past the camera plane, which no edge fill can invent. `c`/`s` are
    // cos/sin of (pan, perpendicular, roll).
    const warp = (p, c, s, fOut) => {
      const d = vec3(p.x.sub(0.5).mul(2.0), p.y.sub(0.5).mul(2.0).div(u.uAspect), fOut).toVar();
      d.assign(vec3(d.x.mul(c.z).sub(d.y.mul(s.z)), d.x.mul(s.z).add(d.y.mul(c.z)), d.z));
      d.assign(turn(d, u.uK2, c.y, s.y));
      d.assign(turn(d, u.uK, c.x, s.x));
      const behind = float(1.0).sub(step(0.0005, d.z));
      const iz = u.uFocal.div(max(d.z, 0.0005));
      return { uv: vec2(d.x.mul(iz).mul(0.5).add(0.5), d.y.mul(iz).mul(0.5).mul(u.uAspect).add(0.5)), behind };
    };

    // One plate, integrated across the exposure with `nf` samples — a REAL
    // loop with a uniform bound, the GLSL twin line for line. The three camera
    // angles advance by one complex rotation per sample (angle addition), and
    // fringing samples two more focals inside the same loop: ONE loop body per
    // plate. The earlier port unrolled 33 samples × 4 exposures × 2 plates
    // into 264 texture reads of straight-line WGSL (850 KB), which ran seven
    // times slower than the GLSL loop.
    const plate = (sampler, rot, sweep, nf, fold) => {
      const rs = u.uRS.mul(q.y.sub(0.5));
      const inv = float(1.0).div(max(nf.sub(1.0), 1.0));
      const w0 = jitter.mul(inv).sub(0.5).add(u.uBias.mul(0.5));
      const a0 = rot.add(rs).add(sweep.mul(w0));
      const da = sweep.mul(inv);
      const c = cos(a0).toVar();
      const s = sin(a0).toVar();
      const cd = cos(da).toVar();
      const sd = sin(da).toVar();
      const f0 = u.uFocalOut.add(u.uFocalSweep.mul(w0));
      const df = u.uFocalSweep.mul(inv);
      const pw = float(1.0).add(u.uStreak);
      const k = u.uChroma.mul(0.05).mul(u.uFocalOut);
      const acc = vec3(0.0).toVar();
      const cover = vec3(0.0).toVar();
      Loop({ start: int(0), end: int(nf.add(0.5)), type: 'int', condition: '<' }, ({ i }) => {
        const f = f0.add(float(i).mul(df));
        const hit = warp(q, c, s, f);
        const g = fetchEdge(sampler, hit.uv, fold, hit.behind).toVar();
        const alpha = vec3(g.a).toVar();
        If(u.uChroma.greaterThanEqual(0.002), () => {
          const hr = warp(q, c, s, f.add(k));
          const hb = warp(q, c, s, f.sub(k));
          const r = fetchEdge(sampler, hr.uv, fold, hr.behind).toVar();
          const b = fetchEdge(sampler, hb.uv, fold, hb.behind).toVar();
          alpha.assign(vec3(r.a, g.a, b.a));
          g.assign(vec4(r.r, g.g, b.b, g.a));
        });
        acc.addAssign(max(g.rgb, 0.0).pow(vec3(pw)));
        cover.addAssign(alpha);
        // The new cosine must be captured BEFORE the sine is overwritten.
        const c1 = c.mul(cd).sub(s.mul(sd)).toVar();
        s.assign(s.mul(cd).add(c.mul(sd)));
        c.assign(c1);
      });
      acc.assign(acc.div(nf));
      cover.assign(cover.div(nf));
      return vec4(max(acc, 0.0).pow(vec3(float(1.0).div(pw))), max(max(cover.x, cover.y), cover.z));
    };

    // One-sided (uSolo 1 = entrance, 2 = exit) the empty lane contributes
    // nothing, and the flash lifts only the layer's own coverage — the GLSL twin.
    const hasA = u.uSolo.lessThan(0.5).or(u.uSolo.greaterThan(1.5));
    const hasB = u.uSolo.lessThan(1.5);
    const a = vec4(0.0).toVar();
    const b = vec4(0.0).toVar();
    If(hasA.and(u.uMix.lessThan(0.999)), () => { a.assign(plate(u.uPrevious, u.uRotA, u.uSweepA, u.uSamplesA, u.uFoldA)); });
    If(hasB.and(u.uMix.greaterThan(0.001)), () => { b.assign(plate(u.uCurrent, u.uRotB, u.uSweepB, u.uSamplesB, u.uFoldB)); });
    const col = mix(a, b, u.uMix);
    const cover = mix(float(1.0), col.a, step(0.5, u.uSolo));
    return mix(col, vec4(u.uFlash, 1.0).mul(cover), clamp(u.uFlashAmt, 0.0, 1.0));
  });

  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = fragment();
  return finish(material, u);
}

/**
 * Zoom Ruler: the Shape Rulers box as the clip mask — the GLSL expression for
 * expression, ruler geometry from shapeRulersNodes.js (the overlay effect's own
 * twin). Box maths runs in uv()·uRes, y up like the GLSL's vUv; only the capture
 * plates flip V on read (camera-rendered, see Circular Wipe).
 */
export function createZoomRulerNodeMaterial() {
  const u = {
    uPrevious: makeSampler(),
    uCurrent: makeSampler(),
    uRes: uniform(new THREE.Vector2(1920, 1080)),
    uC: uniform(new THREE.Vector2(960, 540)),
    uMH: uniform(new THREE.Vector2(0, 0)),
    uH: uniform(new THREE.Vector2(0.5, 0.5)),
    uFeather: uniform(0),
    uMaskIn: uniform(0),
    uZoomB: uniform(1),
    uAlpha: uniform(0),
    uLineW: uniform(1.5),
    uLineA: uniform(0.9),
    uExt: uniform(1e6),
    uDash: uniform(0),
    uLineCol: uniform(new THREE.Vector3(1, 1, 1)),
    uHS: uniform(new THREE.Vector2(7.5, 7.5)),
    uHR: uniform(1),
    uHShape: uniform(0),
    uHStroke: uniform(2.5),
    uMid: uniform(0),
    uHCol: uniform(new THREE.Vector3(1, 1, 1)),
  };
  // GLSL zrMirror: 1 - |1 - mod(uv, 2)| with GLSL's floor-based mod.
  const mirror = (p) => {
    const m = p.sub(floor(p.mul(0.5)).mul(2.0));
    return vec2(1.0).sub(abs(vec2(1.0).sub(m)));
  };
  const fragment = Fn(() => {
    const vUv = uv();
    const px = vUv.mul(u.uRes);
    const A = u.uPrevious.sample(vec2(vUv.x, vUv.y.oneMinus()));
    const qb = mirror(u.uC.add(px.sub(u.uC).div(u.uZoomB)).div(u.uRes));
    const B = u.uCurrent.sample(vec2(qb.x, qb.y.oneMinus()));
    const sd = srSdBox(px.sub(u.uC), u.uMH, float(0.0));
    const fe = max(u.uFeather, 1e-3);
    const soft = float(1.0).sub(smoothstep(fe.mul(-0.5), fe.mul(0.5), sd));
    const hard = clamp(float(0.5).sub(sd), 0.0, 1.0);
    const m = select(u.uFeather.greaterThan(0.5), soft, hard);
    const o = mix(A, B, m.mul(u.uMaskIn)).toVar();
    If(u.uAlpha.greaterThan(0.001), () => {
      const cov = srCoverage(px.sub(u.uC), u.uH, u.uLineW, u.uExt, u.uDash, u.uHShape, u.uHS,
        u.uHR, u.uHStroke, u.uMid).mul(u.uAlpha);
      const l = cov.x.mul(u.uLineA);
      o.assign(o.mul(float(1.0).sub(l)).add(vec4(u.uLineCol.mul(l), l)));
      o.assign(o.mul(float(1.0).sub(cov.y)).add(vec4(u.uHCol.mul(cov.y), cov.y)));
    });
    return o;
  });
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = fragment();
  return finish(material, u);
}

/**
 * Gradient Glow Stack: GLOW_STACK_FRAGMENT in builtinTransitionPackages.js,
 * expression for expression. The six layer slots are unrolled on purpose —
 * pure arithmetic with no texture tap inside — and a slot past uN is switched
 * off by its `on` factor, exactly as the GLSL does.
 */
export function createGlowStackNodeMaterial() {
  const v4 = () => uniform(new THREE.Vector4(0, 1, 1, 0));
  const v3 = () => uniform(new THREE.Vector3(1, 1, 1));
  const u = {
    uPrevious: makeSampler(),
    uCurrent: makeSampler(),
    uRes: uniform(new THREE.Vector2(1920, 1080)),
    uCenter: uniform(new THREE.Vector2(960, 540)),
    uBox: uniform(new THREE.Vector4(-1e6, -1e6, 1e6, 1e6)),
    uShapeMask: uniform(0),
    uDir: uniform(new THREE.Vector2(0, 1)),
    uN: uniform(4),
    uL0: v4(), uL1: v4(), uL2: v4(), uL3: v4(), uL4: v4(), uL5: v4(),
    uC0: v3(), uC1: v3(), uC2: v3(), uC3: v3(), uC4: v3(), uC5: v3(),
    uRound: uniform(1),
    uAniso: uniform(1),
    uSwapLine: uniform(-1e6),
    uSwapSoft: uniform(1),
    uSwapAll: uniform(0),
    uStackAlpha: uniform(1),
    uBlend: uniform(0),
    uGrain: uniform(0.05),
    uGrainSize: uniform(1),
    uSeed: uniform(0),
  };
  const Phi = (z0) => {
    const z = clamp(z0, -8.0, 8.0);
    return float(1.0).div(float(1.0).add(z.mul(-1.5976).sub(z.mul(z).mul(z).mul(0.07056)).exp()));
  };
  const sdShape = (q, R) => {
    const rc = u.uRound.mul(R);
    const d = abs(q).sub(vec2(R.sub(rc)));
    return length(max(d, 0.0)).add(min(max(d.x, d.y), 0.0)).sub(rc);
  };
  const hash12 = (p) => {
    const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
    p3.addAssign(dot(p3, p3.yzx.add(33.33)));
    return fract(p3.x.add(p3.y).mul(p3.z));
  };
  const flipV = (p) => vec2(p.x, p.y.oneMinus());

  const fragment = Fn(() => {
    const vUv = uv();
    const px = vUv.mul(u.uRes).toVar();
    const p = px.sub(u.uCenter);
    const s = dot(p, u.uDir).toVar();
    const t = dot(p, vec2(u.uDir.y.negate(), u.uDir.x)).toVar();
    const A = u.uPrevious.sample(flipV(vUv));
    const B = u.uCurrent.sample(flipV(vUv));
    const wB = max(Phi(u.uSwapLine.sub(s).div(u.uSwapSoft)), u.uSwapAll);
    const base = mix(A, B, wB).toVar();
    const col = vec4(base).toVar();
    const cover = float(0.0).toVar();
    // Covers: inside the box (1 px soft edge), and on the plates' pixels for Layer shape
    const inBox = min(px.sub(u.uBox.xy), u.uBox.zw.sub(px));
    const m = clamp(min(inBox.x, inBox.y).add(0.5), 0.0, 1.0).mul(mix(float(1.0), max(A.a, B.a), u.uShapeMask)).toVar();
    // premultiplied: the glow layer over what is under it
    const glowLayer = (L, C, on) => {
      const a = Phi(sdShape(vec2(s.sub(L.x).mul(u.uAniso), t), L.y).negate().div(L.z)).mul(L.w).mul(on).toVar();
      const src = C.mul(a);
      const alpha = a.add(col.a).sub(a.mul(col.a));
      const normal = vec4(src.add(col.rgb.mul(float(1.0).sub(a))), alpha);
      const screen = vec4(src.add(col.rgb).sub(src.mul(col.rgb)), alpha);
      const added = vec4(min(col.rgb.add(src), vec3(alpha)), alpha);
      col.assign(select(u.uBlend.lessThan(0.5), normal, select(u.uBlend.lessThan(1.5), screen, added)));
      cover.assign(cover.add(a).sub(cover.mul(a)));
    };
    glowLayer(u.uL0, u.uC0, m);
    glowLayer(u.uL1, u.uC1, m);
    glowLayer(u.uL2, u.uC2, step(2.5, u.uN).mul(m));
    glowLayer(u.uL3, u.uC3, step(3.5, u.uN).mul(m));
    glowLayer(u.uL4, u.uC4, step(4.5, u.uN).mul(m));
    glowLayer(u.uL5, u.uC5, step(5.5, u.uN).mul(m));
    col.assign(mix(base, col, u.uStackAlpha));
    cover.assign(cover.mul(u.uStackAlpha));
    const g = hash12(floor(px.div(u.uGrainSize)).add(vec2(u.uSeed.mul(17.0), u.uSeed.mul(31.0)))).sub(0.5);
    const rgb = clamp(col.rgb.add(g.mul(2.0).mul(u.uGrain).mul(cover)), vec3(0.0), vec3(col.a));
    return vec4(rgb, col.a);
  });
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = fragment();
  return finish(material, u);
}

/**
 * Gradient Map: GRADIENT_MAP_FRAGMENT in builtinTransitionPackages.js,
 * expression for expression. The nine palette segments are unrolled (pure
 * arithmetic, no taps), and only the two plate samples flip V.
 */
export function createGradientMapNodeMaterial() {
  const v4 = () => uniform(new THREE.Vector4(0, 0, 0, 2));
  const u = {
    uPrevious: makeSampler(),
    uCurrent: makeSampler(),
    uRes: uniform(new THREE.Vector2(1920, 1080)),
    uP0: v4(), uP1: v4(), uP2: v4(), uP3: v4(), uP4: v4(), uP5: v4(), uP6: v4(), uP7: v4(), uP8: v4(),
    uPhase: uniform(0),
    uBands: uniform(1),
    uSoft: uniform(0.5),
    uOrder: uniform(0),
    uMapA: uniform(0),
    uSwap: uniform(0),
    uReveal: uniform(0),
    uZoomA: uniform(1),
    uZoomB: uniform(1),
    uExit: uniform(0),
    uAccent: uniform(0),
    uAccentCol: uniform(new THREE.Vector3(1, 0.576, 0.259)),
    uAccentAmt: uniform(0),
    uRingR: uniform(0),
    uRingW: uniform(1),
    uPitch: uniform(36),
    uTime: uniform(0),
    uPoint: uniform(new THREE.Vector2(960, 540)),
    uPointMaxD: uniform(1),
    uPointAmt: uniform(0),
  };
  const luma = (c) => dot(c, vec3(0.299, 0.587, 0.114));
  const seg = (c, a, b, x) => {
    const t = x.sub(a.w).div(max(b.w.sub(a.w), 1e-5));
    return select(x.greaterThanEqual(a.w).and(x.lessThan(b.w)), mix(a.xyz, b.xyz, t), c);
  };
  const palette = (x) => {
    const P = [u.uP0, u.uP1, u.uP2, u.uP3, u.uP4, u.uP5, u.uP6, u.uP7, u.uP8];
    let c = P[0].xyz;
    for (let i = 0; i < 8; i += 1) c = seg(c, P[i], P[i + 1], x);
    return c;
  };
  // AE Gradient Wipe: how much of the layer is left at completion c
  const wipe = (key, c) => clamp(key.sub(c.mul(u.uSoft.add(1.0))).add(u.uSoft).div(u.uSoft), 0.0, 1.0);
  const hash12 = (p) => {
    const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
    p3.addAssign(dot(p3, p3.yzx.add(33.33)));
    return fract(p3.x.add(p3.y).mul(p3.z));
  };
  const flipV = (p) => vec2(p.x, p.y.oneMinus());

  const fragment = Fn(() => {
    const vUv = uv();
    const A = u.uPrevious.sample(flipV(vUv.sub(0.5).div(u.uZoomA).add(0.5))).toVar();
    const B = u.uCurrent.sample(flipV(vUv.sub(0.5).div(u.uZoomB).add(0.5))).toVar();
    const lA = luma(A.rgb.div(max(A.a, 1e-4))).toVar();
    const lB = luma(B.rgb.div(max(B.a, 1e-4))).toVar();
    // the order the pixels go in: brightness, pulled toward the point. Like Circular Wipe
    // every front travels OUT from the point: the map arrives nearest first and the real
    // picture comes back nearest first — a high key gets the map first, a low key loses it first
    const dn = clamp(length(vUv.mul(u.uRes).sub(u.uPoint)).div(u.uPointMaxD), 0.0, 1.0).toVar();
    const baseA = mix(lA, lA.oneMinus(), u.uOrder).toVar();
    const kA = mix(baseA, dn.oneMinus(), u.uPointAmt);    // A's map builds
    const kAout = mix(baseA, dn, u.uPointAmt);            // A's map leaves (exit)
    const kB = mix(mix(lB, lB.oneMinus(), u.uOrder), dn, u.uPointAmt);
    const mA = palette(fract(lA.mul(u.uBands).add(u.uPhase))).mul(A.a);
    const mB = palette(fract(lB.mul(u.uBands).add(u.uPhase))).mul(B.a);
    // premultiplied: the map builds over A (the reveal played backwards) and leaves B
    const a = vec4(mix(A.rgb, mA, wipe(kA, u.uMapA.oneMinus())), A.a).toVar();
    const b = vec4(mix(B.rgb, mB, wipe(kB, u.uReveal)), B.a);
    const w = wipe(mix(lB, dn.oneMinus(), u.uPointAmt), u.uSwap.oneMinus());   // B's map arrives brightest (or nearest) first
    const col = vec4(0.0).toVar();
    If(u.uExit.greaterThan(0.5), () => { col.assign(a.mul(wipe(kAout, u.uSwap))); })
      .Else(() => { col.assign(b.mul(w).add(a.mul(w.oneMinus()))); });
    If(u.uAccent.greaterThan(0.5).and(u.uAccentAmt.greaterThan(0.001)), () => {
      const px = vUv.mul(u.uRes);
      const r = length(px.sub(u.uRes.mul(0.5)));
      const d = r.sub(u.uRingR).div(u.uRingW);
      const ring = d.mul(d).negate().exp();
      const cell = fract(px.div(u.uPitch)).mul(u.uPitch).sub(u.uPitch.mul(0.5));
      const m = float(0.0).toVar();
      If(u.uAccent.lessThan(1.5), () => {
        const rad = u.uPitch.mul(0.14);
        m.assign(ring.mul(float(1.0).sub(smoothstep(rad.sub(0.75), rad.add(0.75), length(cell)))));
      }).ElseIf(u.uAccent.lessThan(2.5), () => {
        const q = abs(cell);
        const arm = u.uPitch.mul(0.3);
        const th = max(float(0.6), u.uPitch.mul(0.035));
        const across = (k) => float(1.0).sub(smoothstep(th.sub(0.5), th.add(0.5), k));
        const along = (k) => float(1.0).sub(smoothstep(arm.sub(0.5), arm.add(0.5), k));
        const plus = max(across(q.y).mul(along(q.x)), across(q.x).mul(along(q.y)));
        const disc = float(1.0).sub(smoothstep(u.uRingR.sub(u.uRingW), u.uRingR.add(u.uRingW), r));
        m.assign(plus.mul(disc).mul(0.45));
      }).Else(() => {
        const blk = floor(px.div(u.uPitch.mul(1.1)));
        const tt = u.uTime.mul(4.0);
        const k0 = floor(tt);
        const h = mix(hash12(blk.add(k0.mul(17.0))), hash12(blk.add(k0.add(1.0).mul(17.0))), smoothstep(0.0, 1.0, tt.sub(k0)));
        m.assign(ring.mul(smoothstep(0.55, 0.75, h)));
      });
      // light: added to rgb only, so it glows over what is under the pass
      col.assign(vec4(min(col.rgb.add(u.uAccentCol.mul(m.mul(u.uAccentAmt))), vec3(1.0)), col.a));
    });
    return col;
  });
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = fragment();
  return finish(material, u);
}
