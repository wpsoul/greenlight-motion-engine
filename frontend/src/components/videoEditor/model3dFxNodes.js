/*
 * TSL twin of model3dFx.js — the real-3D model effects on the WebGPU backend.
 *
 * Loaded on FIRST USE through materialFactory.loadModelFxNodes() (never at
 * backend init), so a WebGPU project without a 3D effect on a model never pays
 * for it. Every pass mirrors its GLSL namesake in model3dFx.js and exposes the
 * SAME `.uniforms` surface (names and value objects), so model3dFx's single
 * writer drives both backends.
 *
 * FRAME UV IS `screenUV`, never `uv()`: the passes read targets the camera
 * filmed, and the model tone pass established that screenUV is the read that
 * lands upright on WebGPU (model3dNodes.js). Texture samplers go through
 * makeTslSampler so a null binding can never compile a black fallback.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, int, uniform, vec2, vec3, vec4, float, screenUV, screenCoordinate, positionWorld, normalView,
  normalize, dot, pow, smoothstep, mix, clamp, max, length, sin, cos, step, abs, select,
  floor, fract, fwidth, mod, exp, sqrt, min, atan, cross, log, sign, uniformArray,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';
import { srGuide, srMark } from './shapeRulersNodes.js';
import { veDisplayTransform } from './threeDisplayTransformNodes.js';

const sampler = () => makeTslSampler({ rgba: [0, 0, 0, 0] });

function finish(material, u) {
  material.depthTest = false;
  material.depthWrite = false;
  material.transparent = false;
  material.blending = THREE.NoBlending;
  material.forceSinglePass = true;
  material.uniforms = u;
  return material;
}

/*
 * FRAME UV ↔ CLIP SPACE runs the other way up here. These passes read the
 * camera's own targets at screenUV, and on WebGPU row 0 of such a target is the
 * TOP of the frame (NDC y = +1), where WebGL's row 0 is the bottom. A read at
 * screenUV is still an identity copy on both (which is why the tone pass is
 * upright), but anything that converts between a frame uv and CLIP space — a
 * view ray, a 3D point projected back to the frame — must flip y on this side.
 * Measured: without it Pixelate's surface cells sampled the vertically mirrored
 * point (black blocks inside the "3" of the test text).
 */
const uvToNdc = (uvn) => vec2(uvn.x.mul(2.0).sub(1.0), float(1.0).sub(uvn.y.mul(2.0)));
const ndcToUv = (ndc) => vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)));

// View ray through a frame uv (far-plane point of the inverse projection).
const viewRay = (uvn, invProj) => {
  const r = invProj.mul(vec4(uvToNdc(uvn), 1.0, 1.0));
  return normalize(r.xyz.div(r.w));
};

// ── Surface cells (model3dFx.js SURFACE_CELL) ───────────────────────────────
const cellUniforms = () => ({
  tColor: sampler(), tN: sampler(), tP: sampler(), uRes: uniform(new THREE.Vector2(1, 1)),
  uViewToModel: uniform(new THREE.Matrix3()), uPosToClip: uniform(new THREE.Matrix4()),
  uCell: uniform(0.03), uCellAspect: uniform(new THREE.Vector2(1, 1)), uOffset: uniform(new THREE.Vector2(0, 0)),
  uMode: uniform(0), uCellPx: uniform(24), uAvg: uniform(0),
});
const project = (u, pc) => {
  const clip = u.uPosToClip.mul(vec4(pc, 1.0));
  return u.tColor.sample(ndcToUv(clip.xy.div(clip.w)));
};
// Returns { color, local, cid } for the frame uv `uvn`.
function cellAt(u, uvn) {
  const own = u.tColor.sample(uvn);
  // Screen grid — laid out from the frame's BOTTOM like the GLSL's gl_FragCoord,
  // so the cell boundaries land on the same pixels on both backends.
  const sz = u.uCellPx;
  const uvGl = vec2(uvn.x, float(1.0).sub(uvn.y));
  const gS = uvGl.mul(u.uRes).add(u.uOffset.mul(sz)).div(u.uCellAspect.mul(sz)).toVar();
  const cidS = floor(gS);
  const cGl = cidS.add(0.5).mul(u.uCellAspect).mul(sz).sub(u.uOffset.mul(sz)).div(u.uRes);
  const cS = u.tColor.sample(vec2(cGl.x, float(1.0).sub(cGl.y)));
  // Surface grid, on the dominant plane of the model-space normal.
  const p = u.tP.sample(uvn).xyz.toVar();
  const n = normalize(u.uViewToModel.mul(u.tN.sample(uvn).rgb.mul(2.0).sub(1.0)));
  const an = abs(n).toVar();
  const ax = select(an.x.greaterThan(an.y).and(an.x.greaterThan(an.z)), float(0.0), select(an.y.greaterThan(an.z), float(1.0), float(2.0))).toVar();
  const q = select(ax.lessThan(0.5), p.yz, select(ax.lessThan(1.5), p.xz, p.xy));
  const step2 = u.uCellAspect.mul(u.uCell);
  const g = q.add(u.uOffset.mul(u.uCell)).div(step2).toVar();
  const qc = floor(g).add(0.5).mul(step2).sub(u.uOffset.mul(u.uCell)).toVar();
  const at = (o) => {
    const c2 = qc.add(o);
    return select(ax.lessThan(0.5), vec3(p.x, c2.x, c2.y), select(ax.lessThan(1.5), vec3(c2.x, p.y, c2.y), vec3(c2.x, c2.y, p.z)));
  };
  const h = step2.mul(0.25);
  const c1 = project(u, at(vec2(0.0, 0.0)));
  const cAvg = project(u, at(vec2(h.x.negate(), h.y.negate()))).add(project(u, at(vec2(h.x, h.y.negate()))))
    .add(project(u, at(vec2(h.x.negate(), h.y)))).add(project(u, at(h))).mul(0.25);
  const cRaw = select(u.uAvg.greaterThan(0.5), cAvg, c1);
  const cSurf = select(cRaw.a.greaterThan(0.5), cRaw, own);
  const surf = u.uMode.lessThan(0.5);
  return {
    own,
    color: select(surf, cSurf, cS),
    local: select(surf, fract(g), fract(gS)),
    cid: select(surf, floor(g).add(ax.mul(4096.0)), cidS),
  };
}
const fxHash = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453123));

// ── Surface toolkit (model3dFx.js FX_SURF) ──────────────────────────────────
const surfUniforms = () => ({
  tColor: sampler(), tN: sampler(), tP: sampler(), uRes: uniform(new THREE.Vector2(1, 1)),
  uViewToModel: uniform(new THREE.Matrix3()), uPosToClip: uniform(new THREE.Matrix4()),
  uMix: uniform(1), uTime: uniform(0), uCell: uniform(0.03),
});
const fxLuma = (c) => dot(c, vec3(0.2126, 0.7152, 0.0722));
const fxUnpre = (c) => select(c.a.greaterThan(1e-4), c.rgb.div(max(c.a, 1e-4)), vec3(0.0));
const fxTone = (c) => float(1.0).sub(exp(fxLuma(c).mul(-1.6)));
const fxNormalM = (u, uvn) => normalize(u.uViewToModel.mul(u.tN.sample(uvn).rgb.mul(2.0).sub(1.0)));
const fxAxis = (n) => {
  const a = abs(n);
  return select(a.x.greaterThan(a.y).and(a.x.greaterThan(a.z)), float(0.0), select(a.y.greaterThan(a.z), float(1.0), float(2.0)));
};
const fxPlane = (p, ax) => select(ax.lessThan(0.5), p.yz, select(ax.lessThan(1.5), p.xz, p.xy));
const fxUnplane = (p, ax, q) => select(ax.lessThan(0.5), vec3(p.x, q.x, q.y), select(ax.lessThan(1.5), vec3(q.x, p.y, q.y), vec3(q.x, q.y, p.z)));
const fxProjectS = (u, pc) => {
  const clip = u.uPosToClip.mul(vec4(pc, 1.0));
  return u.tColor.sample(ndcToUv(clip.xy.div(clip.w)));
};
const fxRot = (v, a) => vec2(cos(a).mul(v.x).sub(sin(a).mul(v.y)), sin(a).mul(v.x).add(cos(a).mul(v.y)));
const fxBayer2 = (a0) => { const a = floor(a0); return fract(a.x.div(2.0).add(a.y.mul(a.y).mul(0.75))); };
const fxBayer4 = (a) => fxBayer2(a.mul(0.5)).mul(0.25).add(fxBayer2(a));
const fxBayer8 = (a) => fxBayer4(a.mul(0.5)).mul(0.25).add(fxBayer2(a));
const fxBlend = (b, s2, m) => select(m.lessThan(0.5), s2,
  select(m.lessThan(1.5), b.mul(s2),
    select(m.lessThan(2.5), float(1.0).sub(float(1.0).sub(b).mul(float(1.0).sub(s2))),
      select(m.lessThan(3.5), mix(b.mul(s2).mul(2.0), float(1.0).sub(float(1.0).sub(b).mul(float(1.0).sub(s2)).mul(2.0)), step(0.5, b)),
        select(m.lessThan(4.5), mix(b.sub(float(1.0).sub(s2.mul(2.0)).mul(b).mul(float(1.0).sub(b))), b.add(s2.mul(2.0).sub(1.0).mul(sqrt(b).sub(b))), step(0.5, s2)),
          select(m.lessThan(5.5), min(b.add(s2), vec3(1.0)), abs(b.sub(s2))))))));
// The view ray's facing for a frame uv (dither edge, colorama Facing).
const facingAt = (u, uvn, invProj) => {
  const nv = normalize(u.tN.sample(uvn).rgb.mul(2.0).sub(1.0));
  return clamp(dot(nv, viewRay(uvn, invProj).negate()), 0.0, 1.0);
};
const outMix = (u, own, rgb, a = null) => {
  const alpha = a || own.a;
  return select(own.a.lessThan(0.001), own, mix(own, vec4(rgb.mul(alpha), alpha), u.uMix));
};

// A frame position in the GLSL's bottom-up uv, and sampling a target at one.
// The batch-3 passes do their geometry (origins, centres, angles) in that space
// so one set of JS-written uniforms drives both backends.
const glUv = () => vec2(screenUV.x, float(1.0).sub(screenUV.y));
const atGl = (tex, q) => tex.sample(vec2(q.x, float(1.0).sub(q.y)));
const RING = 0.78539816;

// model3dFx.js EDGE3D — sampled in GL space (a ring is symmetric anyway).
const edgeUniforms = () => ({ uPosToView: uniform(new THREE.Matrix4()), uZRange: uniform(new THREE.Vector2(0, 1)) });
const e3Z = (u, q) => u.uPosToView.mul(vec4(atGl(u.tP, q).xyz, 1.0)).z.negate();
function e3Edges(u, q, r) {
  const c0 = atGl(u.tN, q).toVar();
  const n0 = c0.rgb.mul(2.0).sub(1.0).toVar();
  const z0 = e3Z(u, q).toVar();
  const zs = max(u.uZRange.y.sub(u.uZRange.x), 1e-4).toVar();
  const e = vec4(0.0).toVar();
  const acc = atGl(u.tColor, q).toVar();
  Loop({ start: int(0), end: int(8), type: 'int', condition: '<' }, ({ i }) => {
    const ang = float(i).mul(RING);
    const qq = q.add(vec2(cos(ang), sin(ang)).mul(r).div(u.uRes)).toVar();
    const nq = atGl(u.tN, qq).toVar();
    const both = c0.a.mul(nq.a);
    e.x.assign(max(e.x, abs(nq.a.sub(c0.a))));
    e.y.assign(max(e.y, both.mul(float(1.0).sub(dot(n0, nq.rgb.mul(2.0).sub(1.0))))));
    e.z.assign(max(e.z, both.mul(abs(e3Z(u, qq).sub(z0))).div(zs)));
    acc.addAssign(atGl(u.tColor, qq));
  });
  e.w.assign(acc.a.div(9.0));
  const col = select(acc.a.greaterThan(1e-4), acc.rgb.div(max(acc.a, 1e-4)), vec3(0.0));
  return { e, col };
}

const PASSES = {
  halftone3d() {
    const u = {
      ...surfUniforms(), uPattern: uniform(0), uAngle: uniform(0), uContrast: uniform(1), uChanRot: uniform(0.4),
      uMisreg: uniform(0), uDrift: uniform(0), uInk: uniform(new THREE.Color()), uPaper: uniform(new THREE.Color()),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uvn = screenUV;
      const own = u.tColor.sample(uvn).toVar();
      const p = u.tP.sample(uvn).xyz.toVar();
      const ax = fxAxis(fxNormalM(u, uvn)).toVar();
      const drift = vec2(0.6, 0.2).mul(u.uDrift).mul(u.uTime);
      const q = fxPlane(p, ax).div(u.uCell).add(drift).toVar();
      const r = fxRot(q, u.uAngle).toVar();
      const qc = fxRot(floor(r).add(0.5), u.uAngle.negate());
      const toneRaw = fxTone(fxUnpre(fxProjectS(u, fxUnplane(p, ax, qc.sub(drift).mul(u.uCell)))));
      const tone = clamp(toneRaw.sub(0.5).mul(u.uContrast).add(0.5), 0.0, 1.0).toVar();
      const dotScreen = (qq, a, k) => {
        const d = length(fract(fxRot(qq, a)).sub(0.5));
        const rad = sqrt(clamp(k, 0.0, 1.0)).mul(0.7071);
        const aa = max(fwidth(d), 1e-3);
        return float(1.0).sub(smoothstep(rad.sub(aa), rad.add(aa), d));
      };
      const col = vec3(0.0).toVar();
      If(u.uPattern.lessThan(0.5), () => {
        col.assign(mix(u.uPaper, u.uInk, dotScreen(q, u.uAngle, float(1.0).sub(tone))));
      }).ElseIf(u.uPattern.lessThan(1.5).or(u.uPattern.greaterThan(3.5)), () => {
        const bend = select(u.uPattern.greaterThan(3.5), sin(r.x.mul(0.9).add(p.y.mul(6.0))).mul(0.18), float(0.0));
        const f = abs(fract(r.y.add(bend)).sub(0.5));
        const w = float(1.0).sub(tone).mul(0.5);
        const aa = max(fwidth(f), 1e-3);
        col.assign(mix(u.uPaper, u.uInk, float(1.0).sub(smoothstep(w.sub(aa), w.add(aa), f))));
      }).ElseIf(u.uPattern.lessThan(2.5), () => {
        const f1 = abs(fract(r.y).sub(0.5));
        const f2 = abs(fract(fxRot(q, u.uAngle.add(1.5707963)).y).sub(0.5));
        const aa = max(fwidth(f1), 1e-3);
        const c1 = float(1.0).sub(smoothstep(float(0.12).sub(aa), float(0.12).add(aa), f1)).mul(step(tone, 0.66));
        const c2 = float(1.0).sub(smoothstep(float(0.12).sub(aa), float(0.12).add(aa), f2)).mul(step(tone, 0.36));
        col.assign(mix(u.uPaper, u.uInk, max(c1, c2)));
      }).Else(() => {
        const c = clamp(fxUnpre(own), 0.0, 1.0);
        const k = float(1.0).sub(max(c.r, max(c.g, c.b)));
        const cmy = float(1.0).sub(c).sub(k).div(max(float(1.0).sub(k), 1e-3));
        const mis = vec2(u.uMisreg.mul(0.05), 0.0);
        const cC = dotScreen(q.add(mis), u.uAngle.add(u.uChanRot), cmy.x);
        const cM = dotScreen(q.sub(mis), u.uAngle.add(u.uChanRot.mul(2.0)), cmy.y);
        const cY = dotScreen(q, u.uAngle, cmy.z);
        const cK = dotScreen(q, u.uAngle.add(u.uChanRot.mul(3.0)), k);
        col.assign(u.uPaper.mul(float(1.0).sub(vec3(1.0, 0.0, 0.0).mul(cC))).mul(float(1.0).sub(vec3(0.0, 1.0, 0.0).mul(cM)))
          .mul(float(1.0).sub(vec3(0.0, 0.0, 1.0).mul(cY))).mul(float(1.0).sub(cK)));
      });
      return outMix(u, own, col);
    })();
    return finish(m, u);
  },

  dither3d() {
    const u = {
      ...surfUniforms(), uThreshold: uniform(0.5), uContrast: uniform(1), uEdge: uniform(0.3), uPaperAmt: uniform(1),
      uAlgo: uniform(0), uInk: uniform(new THREE.Color()), uPaper: uniform(new THREE.Color()), uInvProj: uniform(new THREE.Matrix4()),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uvn = screenUV;
      const own = u.tColor.sample(uvn).toVar();
      const p = u.tP.sample(uvn).xyz;
      const ax = fxAxis(fxNormalM(u, uvn));
      const q = fxPlane(p, ax).div(u.uCell).toVar();
      const tone = clamp(fxTone(fxUnpre(own)).sub(0.5).mul(u.uContrast).add(0.5), 0.0, 1.0);
      const th = select(u.uAlgo.lessThan(0.5), fxBayer4(q),
        select(u.uAlgo.lessThan(1.5), fxBayer8(q),
          select(u.uAlgo.lessThan(2.5), fract(sin(dot(floor(q), vec2(127.1, 311.7))).mul(43758.5453123)),
            length(fract(q).sub(0.5)).mul(1.41))));
      const lit = step(th.add(u.uThreshold.sub(0.5)), tone);
      const edge = u.uEdge.mul(smoothstep(0.35, 0.1, facingAt(u, uvn, u.uInvProj)));
      const col = mix(u.uPaper, u.uInk, max(lit, edge));
      return outMix(u, own, mix(fxUnpre(own), col, u.uPaperAmt));
    })();
    return finish(m, u);
  },

  ascii3d() {
    const u = {
      ...surfUniforms(), tAtlas: makeTslSampler({ rgba: [0, 0, 0, 0] }), uN: uniform(1), uGw: uniform(38), uRows: uniform(1), uAspect: uniform(0.6),
      uColorMode: uniform(0), uBoost: uniform(0.6), uBg: uniform(0), uSrcLevel: uniform(0.2), uContrast: uniform(1.2),
      uBright: uniform(0), uDither: uniform(0.6), uInvert: uniform(0),
      uGlyph: uniform(new THREE.Color()), uLight: uniform(new THREE.Color()), uBgColor: uniform(new THREE.Color()),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uvn = screenUV;
      const own = u.tColor.sample(uvn).toVar();
      const p = u.tP.sample(uvn).xyz.toVar();
      const ax = fxAxis(fxNormalM(u, uvn)).toVar();
      const cellSz = vec2(u.uAspect, 1.0).mul(u.uCell);
      const cc = fxPlane(p, ax).div(cellSz).toVar();
      const ci = floor(cc).toVar();
      const f = cc.sub(ci);
      const cellRaw = fxProjectS(u, fxUnplane(p, ax, ci.add(0.5).mul(cellSz)));
      const cell = select(cellRaw.a.lessThan(0.5), own, cellRaw);
      const c3 = fxUnpre(cell).toVar();
      const v0 = clamp(fxTone(c3).sub(0.5).mul(u.uContrast).add(0.5).add(u.uBright), 0.0, 1.0);
      const v1 = select(u.uInvert.greaterThan(0.5), float(1.0).sub(v0), v0);
      const v = v1.add(fxBayer4(ci).sub(0.46875).mul(u.uDither).div(max(u.uN, 1.0))).toVar();
      const g = clamp(floor(v.mul(u.uN)), 0.0, u.uN.sub(1.0));
      const col = mod(g, 16.0);
      const row = floor(g.add(0.5).div(16.0));
      const slotW = u.uGw.add(24.0);
      const auv = vec2(col.mul(slotW).add(12.0).add(f.x.mul(u.uGw)).div(slotW.mul(16.0)),
        row.mul(88.0).add(12.0).add(float(1.0).sub(f.y).mul(64.0)).div(max(u.uRows, 1.0).mul(88.0)));
      const cov = u.tAtlas.sample(auv).a;
      const fg = select(u.uColorMode.lessThan(0.5), c3.mul(u.uBoost.add(1.0)), select(u.uColorMode.lessThan(1.5), u.uGlyph, mix(u.uGlyph, u.uLight, v)));
      const bg = select(u.uBg.lessThan(0.5), u.uBgColor, fxUnpre(own).mul(u.uSrcLevel));
      const none = vec4(fg.mul(cov).mul(own.a), cov.mul(own.a));
      const solid = vec4(mix(bg, fg, cov).mul(own.a), own.a);
      const outc = select(u.uBg.greaterThan(1.5), none, solid);
      return select(own.a.lessThan(0.001), own, mix(own, outc, u.uMix));
    })();
    return finish(m, u);
  },

  fractal3d() {
    const u = {
      ...surfUniforms(), uType: uniform(0), uOctaves: uniform(4), uGain: uniform(0.55), uRidge: uniform(2.5),
      uContrast: uniform(1), uBright: uniform(0), uFloor: uniform(0.35), uLightAmt: uniform(0), uBlendMode: uniform(0),
      uInvertF: uniform(0), uDrift: uniform(new THREE.Vector3()), uShadow: uniform(new THREE.Color()),
      uLightC: uniform(new THREE.Color()), uLightDir: uniform(new THREE.Vector3(0, 0, 1)),
    };
    const h3 = (pp) => fract(sin(dot(pp, vec3(127.1, 311.7, 74.7))).mul(43758.5453123));
    const vn3 = (x) => {
      const i = floor(x).toVar();
      const f0 = x.sub(i);
      const f = f0.mul(f0).mul(float(3.0).sub(f0.mul(2.0))).toVar();
      const a = mix(mix(h3(i), h3(i.add(vec3(1, 0, 0))), f.x), mix(h3(i.add(vec3(0, 1, 0))), h3(i.add(vec3(1, 1, 0))), f.x), f.y);
      const b = mix(mix(h3(i.add(vec3(0, 0, 1))), h3(i.add(vec3(1, 0, 1))), f.x), mix(h3(i.add(vec3(0, 1, 1))), h3(i.add(vec3(1, 1, 1))), f.x), f.y);
      return mix(a, b, f.z);
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uvn = screenUV;
      const own = u.tColor.sample(uvn).toVar();
      const p = u.tP.sample(uvn).xyz.div(u.uCell).add(u.uDrift).toVar();
      const sum = float(0.0).toVar();
      const amp = float(0.5).toVar();
      const norm = float(0.0).toVar();
      Loop({ start: int(0), end: int(8), type: 'int', condition: '<' }, ({ i }) => {
        If(float(i).lessThan(u.uOctaves), () => {
          const n0 = vn3(p).toVar();
          const n = select(u.uType.greaterThan(1.5), pow(float(1.0).sub(abs(n0.mul(2.0).sub(1.0))), u.uRidge),
            select(u.uType.greaterThan(0.5), abs(n0.mul(2.0).sub(1.0)), n0));
          sum.addAssign(n.mul(amp));
          norm.addAssign(amp);
          amp.mulAssign(u.uGain);
          p.assign(p.mul(2.03).add(vec3(17.1, 5.3, 11.7)));
        });
      });
      const v0 = clamp(sum.div(max(norm, 1e-4)).sub(0.5).mul(u.uContrast).add(0.5).add(u.uBright), 0.0, 1.0);
      const v1 = smoothstep(u.uFloor.mul(0.5), 1.0, v0);
      const v2 = select(u.uInvertF.greaterThan(0.5), float(1.0).sub(v1), v1);
      const nv = normalize(u.tN.sample(uvn).rgb.mul(2.0).sub(1.0));
      const v = v2.mul(mix(float(1.0), clamp(dot(nv, u.uLightDir).mul(0.5).add(0.5), 0.0, 1.0), u.uLightAmt)).toVar();
      const field = mix(u.uShadow, u.uLightC, v);
      const base = clamp(fxUnpre(own), 0.0, 1.0);
      const bm = u.uBlendMode;
      const mixed = select(bm.lessThan(0.5), fxBlend(base, field, float(2.0)),
        select(bm.lessThan(1.5), fxBlend(base, field, float(5.0)),
          select(bm.lessThan(2.5), fxBlend(base, field, float(1.0)),
            select(bm.lessThan(3.5), fxBlend(base, field, float(3.0)),
              select(bm.lessThan(4.5), fxBlend(base, field, float(4.0)), mix(base, field, v))))));
      return outMix(u, own, mixed);
    })();
    return finish(m, u);
  },

  fill3d() {
    const u = { ...surfUniforms(), uFill: uniform(new THREE.Color()), uBlendMode: uniform(0) };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const own = u.tColor.sample(screenUV).toVar();
      const lit = fxUnpre(own).toVar();
      const base = clamp(lit, 0.0, 1.0).toVar();
      const shade = clamp(fxTone(lit).mul(1.6), 0.0, 1.4);
      const f = u.uFill;
      const bm = u.uBlendMode;
      const c = select(bm.lessThan(0.5), f.mul(shade),
        select(bm.lessThan(1.5), fxBlend(base, f, float(1.0)),
          select(bm.lessThan(2.5), fxBlend(base, f, float(2.0)),
            select(bm.lessThan(3.5), fxBlend(base, f, float(3.0)),
              select(bm.lessThan(4.5), fxBlend(base, f, float(4.0)),
                select(bm.lessThan(5.5), fxBlend(f, base, float(3.0)),
                  select(bm.lessThan(6.5), fxBlend(base, f, float(5.0)),
                    select(bm.lessThan(7.5), max(base, f),
                      select(bm.lessThan(8.5), min(base, f),
                        select(bm.lessThan(9.5), fxBlend(base, f, float(6.0)), f.mul(fxLuma(base).div(max(fxLuma(f), 1e-3)))))))))))));
      return outMix(u, own, c);
    })();
    return finish(m, u);
  },

  colorama3d() {
    const u = {
      ...surfUniforms(), tRamp: makeTslSampler({ rgba: [255, 255, 255, 255] }), uPosToView: uniform(new THREE.Matrix4()),
      uZRange: uniform(new THREE.Vector2(0, 1)), uInvProj: uniform(new THREE.Matrix4()), uInput: uniform(0), uPhase: uniform(0),
      uCycle: uniform(0), uRepeat: uniform(1), uPreserveLuma: uniform(0), uPreserveAlpha: uniform(1), uDither: uniform(0.25),
      uBlendMode: uniform(0), uOriginal: uniform(0),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uvn = screenUV;
      const own = u.tColor.sample(uvn).toVar();
      const base = clamp(fxUnpre(own), 0.0, 1.0).toVar();
      const p = u.tP.sample(uvn).xyz.toVar();
      const z = u.uPosToView.mul(vec4(p, 1.0)).z.negate();
      const dCam = float(1.0).sub(clamp(z.sub(u.uZRange.x).div(max(1e-4, u.uZRange.y.sub(u.uZRange.x))), 0.0, 1.0));
      const inp = u.uInput;
      const x0 = select(inp.lessThan(0.5), fxLuma(base),
        select(inp.lessThan(1.5), base.r,
          select(inp.lessThan(2.5), base.g,
            select(inp.lessThan(3.5), base.b,
              select(inp.lessThan(4.5), own.a,
                select(inp.lessThan(5.5), clamp(p.y.add(0.5), 0.0, 1.0),
                  select(inp.lessThan(6.5), dCam, facingAt(u, uvn, u.uInvProj))))))));
      // The GLSL hashes floor(gl_FragCoord): the same pixel grid here.
      const x = x0.add(fract(sin(dot(floor(screenCoordinate.xy), vec2(127.1, 311.7))).mul(43758.5453123)).sub(0.5).mul(u.uDither).mul(0.02));
      const t = fract(x.add(u.uPhase).add(u.uCycle.mul(u.uTime)).mul(u.uRepeat));
      const g0 = u.tRamp.sample(vec2(t, 0.5)).rgb.toVar();
      const g = mix(g0, g0.mul(fxLuma(base).div(max(fxLuma(g0), 1e-3))), u.uPreserveLuma);
      const bm = u.uBlendMode;
      const c = select(bm.lessThan(0.5), g, select(bm.lessThan(1.5), fxBlend(base, g, float(1.0)),
        select(bm.lessThan(2.5), fxBlend(base, g, float(2.0)), select(bm.lessThan(3.5), fxBlend(base, g, float(3.0)),
          select(bm.lessThan(4.5), fxBlend(base, g, float(4.0)), select(bm.lessThan(5.5), fxBlend(base, g, float(5.0)), fxBlend(base, g, float(6.0))))))));
      return outMix(u, own, mix(c, base, u.uOriginal));
    })();
    return finish(m, u);
  },

  rgbCombine() {
    const u = {
      tR: sampler(), tG: sampler(), tB: sampler(), tP: sampler(), uRes: uniform(new THREE.Vector2(1, 1)), uMix: uniform(1),
      uPosToClip: uniform(new THREE.Matrix4()), uShiftR: uniform(new THREE.Vector2()), uShiftB: uniform(new THREE.Vector2()),
    };
    // model3dFx.js rgbCombine: the processed picture as each shifted copy sees it.
    // The shifts are in the GLSL's bottom-up uv (glUv / atGl); the projected point
    // goes back through ndcToUv like every other 3D → frame lookup here.
    const viewFrom = (copy, shift) => {
      const q = copy.sample(screenUV).toVar();
      const cov = clamp(q.a, 0.0, 1.0).toVar();
      const clip = u.uPosToClip.mul(vec4(q.xyz.div(max(q.a, 1e-4)), 1.0)).toVar();
      const s = u.tG.sample(ndcToUv(clip.xy.div(clip.w)));
      const surf = select(cov.greaterThan(0.001), vec4(fxUnpre(s), 1.0).mul(cov), vec4(0.0));
      const o = glUv().sub(shift).toVar();
      const off = atGl(u.tG, o).mul(float(1.0).sub(clamp(atGl(u.tP, o).a, 0.0, 1.0)));
      return surf.add(off.mul(float(1.0).sub(cov)));
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const g = u.tG.sample(screenUV).toVar();
      const r = viewFrom(u.tR, u.uShiftR).toVar();
      const b = viewFrom(u.tB, u.uShiftB).toVar();
      const a = r.a.add(g.a).add(b.a).div(3.0).toVar();
      const fx = vec4(vec3(fxUnpre(r).r, fxUnpre(g).g, fxUnpre(b).b).mul(a), a);
      return mix(g, fx, u.uMix);
    })();
    return finish(m, u);
  },

  pixelate3d() {
    const u = { ...cellUniforms(), uMix: uniform(1) };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const c = cellAt(u, screenUV);
      const own = c.own;
      const fx = vec4(c.color.rgb.div(max(c.color.a, 1e-4)).mul(own.a), own.a);
      return select(own.a.lessThan(0.001), own, mix(own, fx, u.uMix));
    })();
    return finish(m, u);
  },

  crtMatrix3d() {
    const u = {
      ...cellUniforms(), uMix: uniform(1), uDisplay: uniform(0), uScan: uniform(0.3), uSub: uniform(0.5),
      uSoft: uniform(0.4), uFlicker: uniform(0), uRoll: uniform(0), uTime: uniform(0),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uvn = screenUV;
      const c = cellAt(u, uvn);
      const own = c.own;
      const local = c.local.toVar();
      const col = c.color.rgb.div(max(c.color.a, 1e-4));
      const soft = mix(0.04, 0.3, u.uSoft);
      // LED: one round emitter per cell.
      const led = vec3(float(1.0).sub(smoothstep(float(0.32).sub(soft), float(0.36).add(soft), length(local.sub(0.5)))));
      // Elements: CRT staggers its triads by row.
      const xs = select(u.uDisplay.lessThan(0.5), fract(local.x.add(mod(c.cid.y, 2.0).mul(0.5))), local.x);
      const k = floor(xs.mul(3.0));
      const fxx = fract(xs.mul(3.0));
      const edge0 = smoothstep(0.0, soft, fxx).mul(smoothstep(1.0, float(1.0).sub(soft), fxx));
      const rowGap = smoothstep(0.0, soft, local.y).mul(smoothstep(1.0, float(1.0).sub(soft), local.y));
      const edge = select(u.uDisplay.lessThan(1.5).or(u.uDisplay.greaterThan(3.5)), edge0.mul(rowGap), edge0);
      const el = select(k.lessThan(0.5), vec3(1.0, 0.0, 0.0), select(k.lessThan(1.5), vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0)));
      const stripes = el.mul(edge).mul(3.0);
      const isLed = u.uDisplay.greaterThan(2.5).and(u.uDisplay.lessThan(3.5));
      const mask = mix(vec3(1.0), select(isLed, led, stripes), u.uSub);
      const scan = float(1.0).sub(u.uScan.mul(float(0.5).sub(cos(local.y.mul(6.2831853)).mul(0.5))));
      const flick = float(1.0).sub(u.uFlicker.mul(0.5).mul(fxHash(vec2(floor(u.uTime.mul(24.0)), 3.0))));
      const p = u.tP.sample(uvn).xyz;
      const bar = float(1.0).add(u.uRoll.mul(0.6).mul(smoothstep(0.08, 0.0, abs(fract(p.y.add(0.5).sub(u.uTime.mul(0.25))).sub(0.5)))));
      const lit = col.mul(mask).mul(scan).mul(flick).mul(bar);
      const fx = vec4(lit.mul(own.a), own.a);
      return select(own.a.lessThan(0.001), own, mix(own, fx, u.uMix));
    })();
    return finish(m, u);
  },

  beam3d() {
    const u = {
      ...surfUniforms(), uC1: uniform(new THREE.Color()), uC2: uniform(new THREE.Color()), uC3: uniform(new THREE.Color()),
      uSpeed: uniform(1), uAngle: uniform(0), uBlur: uniform(0.6), uWidth: uniform(0.5), uHold: uniform(1.4),
      uOpacity: uniform(0.75), uBlendMode: uniform(0), uType: uniform(0), uKeepLayer: uniform(1),
    };
    const ramp = (t0) => {
      const t = clamp(t0, 0.0, 1.0);
      const a = smoothstep(0.0, 1.0, clamp(t.mul(2.0), 0.0, 1.0));
      const b = smoothstep(0.0, 1.0, clamp(t.mul(2.0).sub(1.0), 0.0, 1.0));
      return mix(mix(u.uC1, u.uC2, a), u.uC3, b);
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const own = u.tColor.sample(screenUV).toVar();
      const p = u.tP.sample(screenUV).xyz.toVar();
      const dir = vec3(cos(u.uAngle), sin(u.uAngle), 0.0);
      const nrm = vec3(sin(u.uAngle).negate(), cos(u.uAngle), 0.0);
      const halfDiag = float(0.7071);
      const travel = float(2.6).div(max(u.uSpeed, 0.05));
      const cycle = travel.add(u.uHold);
      const prog = clamp(mod(u.uTime, cycle).div(travel), 0.0, 1.0).toVar();
      const glide = mix(prog, prog.mul(prog).mul(float(3.0).sub(prog.mul(2.0))), 0.65);
      // Directional
      const hwD = u.uWidth.mul(halfDiag).mul(1.6);
      const cD = hwD.add(halfDiag).negate().add(halfDiag.add(hwD).mul(2.0).mul(glide));
      const q = dot(p, nrm).add(p.z.mul(0.6)).toVar();
      const wob = sin(q.mul(2.3).add(u.uTime.mul(0.5))).mul(0.5).add(sin(q.mul(4.1).sub(u.uTime.mul(0.31))).mul(0.5));
      const dD = dot(p, dir).sub(cD).add(wob.mul(hwD).mul(0.22)).div(hwD);
      const rD = q.div(halfDiag).mul(0.52).add(0.5).add(dD.mul(0.26)).add(wob.mul(0.1));
      // From Center
      const hwC = u.uWidth.mul(halfDiag).mul(0.9);
      const cC = hwC.mul(-0.72).add(halfDiag.add(hwC.mul(1.35)).mul(glide));
      const dC = length(p).sub(cC).div(max(hwC, 1e-4));
      const rC = dC.mul(0.55).add(0.5);
      const isC = u.uType.greaterThan(0.5);
      const d = select(isC, dC, dD).toVar();
      const rampPos = select(isC, rC, rD);
      const shape = mix(7.0, 1.6, u.uBlur);
      const env = exp(pow(max(abs(d), 1e-4), shape).mul(-2.2)).mul(float(1.0).sub(smoothstep(1.7, 3.1, abs(d))));
      const fade = smoothstep(0.0, 0.16, prog).mul(float(1.0).sub(smoothstep(0.66, 1.0, prog)));
      const k = clamp(env.mul(fade).mul(u.uOpacity), 0.0, 1.0).toVar();
      const keep = mix(clamp(env.mul(fade), 0.0, 1.0), 1.0, u.uKeepLayer);
      const beam = ramp(rampPos).toVar();
      const b = fxUnpre(own).toVar();
      const bm = u.uBlendMode;
      const outCol = select(bm.lessThan(0.5), b.add(beam.mul(k).mul(float(1.0).sub(clamp(b, 0.0, 1.0)))),
        select(bm.lessThan(1.5), b.add(beam.mul(k)),
          select(bm.lessThan(2.5), mix(b, max(b, beam), k),
            select(bm.lessThan(3.5), mix(b, fxBlend(clamp(b, 0.0, 1.0), beam, float(4.0)), k), mix(b, beam, k)))));
      const a = own.a.mul(keep);
      return select(own.a.lessThan(0.001), own, mix(own, vec4(outCol.mul(a), a), u.uMix));
    })();
    return finish(m, u);
  },

  sweep3d() {
    const u = {
      ...surfUniforms(), tLight: sampler(), tHalo: sampler(), uInvProj: uniform(new THREE.Matrix4()),
      uCore: uniform(new THREE.Color()), uWarm: uniform(new THREE.Color()), uHot: uniform(new THREE.Color()),
      uCool: uniform(new THREE.Color()), uDeep: uniform(new THREE.Color()), uStroke: uniform(new THREE.Color()),
      uStage: uniform(1), uMode: uniform(0), uAngle: uniform(0), uBand: uniform(0.2), uCoreW: uniform(1), uFront: uniform(0),
      uStrength: uniform(1), uBlendMode: uniform(0), uCoolFill: uniform(0.34), uDim: uniform(0.45), uSheenFade: uniform(0.5),
      uGlow: uniform(0), uStrokeOp: uniform(0.9), uStrokeW: uniform(0.1),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uvn = screenUV;
      const own = u.tColor.sample(uvn).toVar();
      const p = u.tP.sample(uvn).xyz;
      const s01 = dot(p, vec3(cos(u.uAngle), sin(u.uAngle), 0.0)).div(1.4142).add(0.5);
      const x = u.uFront.sub(s01).div(max(u.uBand, 1e-3)).toVar();
      const bandEnv = exp(x.mul(x).mul(-3.0)).toVar();
      const core = float(1.0).sub(smoothstep(u.uCoreW.mul(0.5), u.uCoreW.mul(0.5).add(0.15), abs(x)));
      const bandCol = mix(mix(u.uHot, u.uWarm, smoothstep(-0.4, 0.6, x)), u.uCore, core).toVar();
      const facing = facingAt(u, uvn, u.uInvProj).toVar();
      const lightA = bandCol.mul(bandEnv).mul(u.uStrength);
      const edge = float(1.0).sub(smoothstep(0.0, max(u.uStrokeW, 0.02), facing));
      const lightB = lightA.add(u.uStroke.mul(u.uStrokeOp).mul(step(0.0, x))).mul(edge);
      const graze = pow(float(1.0).sub(facing), u.uSheenFade.mul(2.0).add(0.5));
      const lightC = lightA.mul(graze.add(0.25));
      const light = select(u.uMode.lessThan(0.5), lightA, select(u.uMode.lessThan(1.5), lightB, lightC)).toVar();
      const b = fxUnpre(own).toVar();
      const ahead = select(u.uMode.lessThan(0.5), smoothstep(0.0, -1.0, x), float(0.0));
      const waiting = mix(b.mul(float(1.0).sub(u.uDim)), mix(u.uDeep, u.uCool, fxTone(b)), u.uCoolFill);
      const base = mix(b, waiting, ahead).toVar();
      const c = select(u.uBlendMode.lessThan(0.5), base.add(light),
        select(u.uBlendMode.lessThan(1.5), base.add(light.mul(float(1.0).sub(clamp(base, 0.0, 1.0)))),
          mix(base, bandCol, clamp(bandEnv.mul(u.uStrength), 0.0, 1.0))));
      const halo = u.tHalo.sample(uvn).rgb.mul(u.uGlow);
      // Past the silhouette the glow is the only light: its strength is its coverage.
      const haloOut = mix(own, vec4(halo, clamp(max(halo.r, max(halo.g, halo.b)), 0.0, 1.0)), u.uMix);
      const composite = select(own.a.lessThan(0.001), haloOut, mix(own, vec4(c.add(halo).mul(own.a), own.a), u.uMix));
      const stage0 = select(own.a.lessThan(0.001), vec4(0.0), vec4(light, 1.0));
      return select(u.uStage.lessThan(0.5), stage0, composite);
    })();
    return finish(m, u);
  },

  contour3d() {
    const u = {
      ...surfUniforms(), uMethod: uniform(0), uLevels: uniform(14), uDetail: uniform(0.6), uWeight: uniform(1),
      uDensity: uniform(120), uDrift: uniform(0), uInk: uniform(new THREE.Color()), uAccent: uniform(new THREE.Color()),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const own = u.tColor.sample(screenUV).toVar();
      const p = u.tP.sample(screenUV).xyz.toVar();
      const b = fxUnpre(own).toVar();
      const tone = fxTone(b).toVar();
      const hTopo = p.y.add(0.5).add(tone.sub(0.5).mul(u.uDetail).mul(0.15)).mul(u.uLevels).add(u.uDrift.mul(u.uTime));
      const hFlow = atan(p.z, p.x).div(6.2831853).add(0.5).mul(u.uDensity).mul(0.25).add(u.uDrift.mul(u.uTime));
      const topo = u.uMethod.lessThan(0.5);
      const h = select(topo, hTopo, hFlow).toVar();
      const w = select(topo, u.uWeight, u.uWeight.mul(mix(0.4, 1.6, float(1.0).sub(tone))));
      const f = abs(fract(h).sub(0.5));
      const fw = max(fwidth(h), 1e-4);
      const line = float(1.0).sub(smoothstep(w.mul(fw).mul(0.5), w.mul(fw).mul(0.5).add(fw), f));
      const major = step(mod(floor(h.add(0.5)), 5.0), 0.5);
      const ink = mix(u.uInk, u.uAccent, major);
      return outMix(u, own, mix(b, ink, line));
    })();
    return finish(m, u);
  },

  curtain3d() {
    const u = {
      tColor: sampler(), uRes: uniform(new THREE.Vector2(1, 1)), uMix: uniform(1), uFall: uniform(new THREE.Vector2(0, -1)),
      uDir: uniform(0), uDensity: uniform(400), uLength: uniform(100), uColW: uniform(6), uThreshold: uniform(0.18),
      uColorMode: uniform(0), uTint: uniform(new THREE.Color()),
    };
    // Work in the GLSL's bottom-up pixel space; flip only to SAMPLE this target.
    const sampleGl = (q) => u.tColor.sample(vec2(q.x.div(u.uRes.x), float(1.0).sub(q.y.div(u.uRes.y))));
    const lum = (c) => dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    // The GLSL's march without an early exit: every tap samples (uniform control
    // flow for WGSL); only the FIRST strong step is kept.
    const march = (c, dir, hit, col) => {
      const prevC = sampleGl(c).toVar();
      const prev = lum(prevC).toVar();
      Loop({ start: int(1), end: int(33), type: 'int', condition: '<' }, ({ i }) => {
        const t = float(i).div(32.0).mul(u.uLength).toVar();
        const q = c.sub(dir.mul(t)).toVar();
        const s = sampleGl(q).toVar();
        const l = lum(s).toVar();
        const e = abs(l.sub(prev)).mul(32.0 * 0.08).toVar();
        const inside = q.x.greaterThanEqual(0.0).and(q.y.greaterThanEqual(0.0)).and(q.x.lessThanEqual(u.uRes.x)).and(q.y.lessThanEqual(u.uRes.y));
        If(hit.x.lessThan(0.0).and(inside).and(e.greaterThan(u.uThreshold)), () => {
          hit.assign(vec2(t, e));
          col.assign(fxUnpre(select(l.greaterThan(prev), s, prevC)));
        });
        prev.assign(l);
        prevC.assign(s);
      });
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const px = vec2(screenUV.x.mul(u.uRes.x), float(1.0).sub(screenUV.y).mul(u.uRes.y)).toVar();
      const own = u.tColor.sample(screenUV).toVar();
      const perp = vec2(u.uFall.y.negate(), u.uFall.x).toVar();
      const across = dot(px, perp).toVar();
      const bi = floor(across.div(u.uColW)).toVar();
      const lit = fxHash(vec2(bi, 7.3)).lessThanEqual(clamp(u.uDensity.div(400.0), 0.01, 1.0));
      const c = px.add(perp.mul(bi.add(0.5).mul(u.uColW).sub(across))).toVar();
      const hD = vec2(-1.0, 0.0).toVar(), hU = vec2(-1.0, 0.0).toVar();
      const colD = vec3(0.0).toVar(), colU = vec3(0.0).toVar();
      If(u.uDir.lessThan(0.5).or(u.uDir.greaterThan(1.5)), () => { march(c, u.uFall, hD, colD); });
      If(u.uDir.greaterThan(0.5), () => { march(c, u.uFall.negate(), hU, colU); });
      const useU = hU.x.greaterThanEqual(0.0).and(hD.x.lessThan(0.0).or(hU.x.lessThan(hD.x)));
      const h = select(useU, hU, hD);
      const band = select(u.uColorMode.greaterThan(0.5), u.uTint, select(useU, colU, colD));
      const a = select(lit.and(h.x.greaterThanEqual(0.0)),
        clamp(float(1.0).sub(h.x.div(u.uLength)).mul(clamp(h.y, 0.0, 1.0)), 0.0, 1.0), float(0.0)).toVar();
      const outc = own.mul(float(1.0).sub(a)).add(vec4(band.mul(a), a));
      return mix(own, outc, u.uMix);
    })();
    return finish(m, u);
  },

  bloomBright3d() {
    const u = { tColor: sampler(), uRes: uniform(new THREE.Vector2(1, 1)), uThr: uniform(0.62), uKnee: uniform(0.5), uExposure: uniform(1) };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const s = u.tColor.sample(screenUV).toVar();
      const c = fxUnpre(s).toVar();
      const shown = veDisplayTransform(c, u.uExposure).toVar();
      const br = max(shown.r, max(shown.g, shown.b));
      const knee = max(u.uThr.mul(u.uKnee), 1e-4).toVar();
      const soft0 = clamp(br.sub(u.uThr).add(knee), 0.0, knee.mul(2.0));
      const soft = soft0.mul(soft0).div(knee.mul(4.0));
      const w = max(max(soft, br.sub(u.uThr)).div(max(br, 1e-4)), 0.0).toVar();
      return vec4(c.mul(w).mul(s.a), w.mul(s.a));
    })();
    return finish(m, u);
  },

  bloom3d() {
    const u = {
      tColor: sampler(), tBloom: sampler(), tStreak: sampler(), uRes: uniform(new THREE.Vector2(1, 1)),
      uMix: uniform(1), uGain: uniform(1), uSat: uniform(1), uTintAmt: uniform(0), uAnamorph: uniform(0), uBlendMode: uniform(0),
      uTint: uniform(new THREE.Color()),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uvn = screenUV;
      const src = u.tColor.sample(uvn).toVar();
      const bl = u.tBloom.sample(uvn).rgb.toVar();
      const an = abs(u.uAnamorph).toVar();
      // The streak's taps run every frame (uniform control flow); Anamorphic 0 weighs them out.
      const dir = select(u.uAnamorph.greaterThanEqual(0.0), vec2(1.0, 0.0), vec2(0.0, 1.0)).toVar();
      const len = an.mul(0.35).add(0.10).toVar();
      const jit = fxHash(screenCoordinate.xy).sub(0.5).toVar();
      const acc = vec3(0.0).toVar();
      const ws = float(0.0).toVar();
      const w = float(1.0).toVar();
      Loop({ start: int(1), end: int(17), type: 'int', condition: '<' }, ({ i }) => {
        w.mulAssign(0.91);
        const o = dir.mul(len).mul(float(i).add(jit).div(16.0));
        acc.addAssign(u.tStreak.sample(uvn.add(o)).rgb.add(u.tStreak.sample(uvn.sub(o)).rgb).mul(w));
        ws.addAssign(w.mul(2.0));
      });
      bl.addAssign(select(an.greaterThan(0.01), acc.div(max(ws, 1.0)).mul(2.0).mul(an).mul(1.2), vec3(0.0)));
      const b0 = bl.mul(u.uGain);
      const l = fxLuma(b0).toVar();
      const b1 = max(mix(vec3(l), b0, u.uSat), 0.0);
      const b = mix(b1, vec3(l).mul(u.uTint).mul(1.6), u.uTintAmt).toVar();
      const ba = clamp(max(b.r, max(b.g, b.b)), 0.0, 1.0).toVar();
      const sc = src.rgb;
      const bm = u.uBlendMode;
      const col = select(bm.lessThan(0.5), sc.add(b),
        select(bm.lessThan(1.5), sc.add(b.mul(float(1.0).sub(clamp(sc, 0.0, 1.0)))),
          select(bm.lessThan(2.5), max(sc, b),
            select(bm.lessThan(3.5), mix(sc.add(b), sc.div(max(vec3(1.0).sub(min(b, vec3(0.96))), vec3(0.04))), src.a), b))));
      const outA = select(bm.lessThan(3.5), max(src.a, ba), ba);
      return mix(src, vec4(col, outA), u.uMix);
    })();
    return finish(m, u);
  },

  flash3d() {
    const u = {
      ...surfUniforms(), uSpeed: uniform(3), uMode: uniform(0), uStyle: uniform(2), uDuty: uniform(0.5), uSoft: uniform(0.15),
      uFlash: uniform(new THREE.Color()), uLightDir: uniform(new THREE.Vector3(0, 0, 1)),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uvn = screenUV;
      const own = u.tColor.sample(uvn).toVar();
      const ph = u.uTime.mul(max(u.uSpeed, 0.05)).toVar();
      const f = fract(ph).toVar();
      const duty = clamp(u.uDuty, 0.02, 0.98).toVar();
      const e = max(u.uSoft.mul(0.5).mul(min(duty, float(1.0).sub(duty))), 1e-4).toVar();
      const kStrobe = smoothstep(0.0, e, f).mul(float(1.0).sub(smoothstep(duty.sub(e), duty, f)));
      const kPulse = pow(float(0.5).sub(cos(f.mul(6.2831853)).mul(0.5)), mix(2.4, 0.45, duty));
      const tick = floor(ph);
      const kFlick = step(float(1.0).sub(duty), fxHash(vec2(tick, 3.7))).mul(mix(0.4, 1.0, fxHash(vec2(tick, 9.1))));
      const k = clamp(select(u.uMode.lessThan(0.5), kStrobe, select(u.uMode.lessThan(1.5), kPulse, kFlick)), 0.0, 1.0).toVar();
      const nv = normalize(u.tN.sample(uvn).rgb.mul(2.0).sub(1.0));
      const lam = clamp(dot(nv, u.uLightDir).mul(0.7).add(0.3), 0.0, 1.0);
      const blink = u.uStyle.greaterThan(0.5).and(u.uStyle.lessThan(1.5));
      const outc = select(blink, own.mul(float(1.0).sub(k)), vec4(own.rgb.add(u.uFlash.mul(k.mul(lam).mul(1.6)).mul(own.a)), own.a));
      return select(own.a.lessThan(0.001), own, mix(own, outc, u.uMix));
    })();
    return finish(m, u);
  },

  raysEmit3d() {
    const u = { ...surfUniforms(), uSource: uniform(0), uThr: uniform(0.4), uDisc: uniform(0.08), uOrigin: uniform(new THREE.Vector2(0.5, 0.5)) };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const q = glUv();
      const s = u.tColor.sample(screenUV).toVar();
      const lit = fxUnpre(s).toVar();
      const tone = fxTone(lit).toVar();
      const d = q.sub(u.uOrigin).mul(vec2(u.uRes.x.div(u.uRes.y), 1.0));
      const disc = exp(dot(d, d).negate().div(max(u.uDisc.mul(u.uDisc), 1e-6))).mul(float(1.0).sub(s.a));
      const src = u.uSource;
      const lvl = select(src.lessThan(0.5), s.a,
        select(src.lessThan(1.5), smoothstep(u.uThr, 1.0, tone).mul(s.a),
          select(src.lessThan(2.5), smoothstep(max(u.uThr, 0.55), 1.0, tone).mul(s.a), disc))).toVar();
      const col = select(src.lessThan(2.5), clamp(lit, 0.0, 1.0), vec3(1.0));
      return vec4(col.mul(lvl), lvl);
    })();
    return finish(m, u);
  },

  raysMarch3d() {
    const u = {
      tSrc: sampler(), uRes: uniform(new THREE.Vector2(1, 1)), uOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
      uLen: uniform(0.55), uTaps: uniform(48), uDecay: uniform(0.55),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const q = glUv().toVar();
      const delta = q.sub(u.uOrigin).toVar();
      const jitter = fxHash(screenCoordinate.xy).sub(0.5).div(u.uTaps).toVar();
      const fall = mix(1.0, 0.82, u.uDecay).toVar();
      const acc = vec4(0.0).toVar();
      const w = float(1.0).toVar();
      const ws = float(0.0).toVar();
      Loop({ start: int(0), end: int(48), type: 'int', condition: '<' }, ({ i }) => {
        const on = step(float(i).add(0.5), u.uTaps);
        const t = float(i).div(u.uTaps).add(jitter).mul(u.uLen);
        acc.addAssign(atGl(u.tSrc, q.sub(delta.mul(t))).mul(w.mul(on)));
        ws.addAssign(w.mul(on));
        w.mulAssign(mix(1.0, fall, on));
      });
      return acc.div(max(ws, 1e-4));
    })();
    return finish(m, u);
  },

  raysComp3d() {
    const u = {
      tColor: sampler(), tRays: sampler(), uRes: uniform(new THREE.Vector2(1, 1)), uMix: uniform(1),
      uExpo: uniform(1.2), uSrcLevel: uniform(1), uOcclude: uniform(1), uRayColor: uniform(new THREE.Color()),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const src = u.tColor.sample(screenUV).toVar();
      const rays = u.tRays.sample(screenUV).toVar();
      const rc = fxUnpre(rays).mul(u.uRayColor);
      const ra = clamp(rays.a.mul(u.uExpo), 0.0, 2.0).mul(float(1.0).sub(src.a.mul(u.uOcclude))).toVar();
      const col = src.rgb.mul(u.uSrcLevel).add(rc.mul(ra));
      const outA = clamp(src.a.mul(u.uSrcLevel).add(ra), 0.0, 1.0);
      return mix(src, vec4(col, outA), u.uMix);
    })();
    return finish(m, u);
  },

  neon3d() {
    const u = {
      ...surfUniforms(), ...edgeUniforms(), uCenter: uniform(new THREE.Vector2(0.5, 0.5)), uCorePx: uniform(1.5), uHead: uniform(0),
      uTrail: uniform(0.4), uTrimS: uniform(0), uTrimE: uniform(1), uFull: uniform(0), uIntensity: uniform(1), uHue: uniform(0),
      uGlow: uniform(new THREE.Color()),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const q = glUv().toVar();
      const { e } = e3Edges(u, q, u.uCorePx);
      const edge = max(e.x, max(smoothstep(0.25, 0.6, e.y), smoothstep(0.03, 0.08, e.z)));
      const d = q.sub(u.uCenter).mul(u.uRes);
      const s = atan(d.y, d.x).div(6.2831853).add(0.5);
      const span = max(u.uTrimE.sub(u.uTrimS), 0.005);
      const sl = s.sub(u.uTrimS).div(span).toVar();
      const inside = step(0.0, sl).mul(step(sl, 1.0));
      const dist = fract(u.uHead.sub(sl));
      const run = inside.mul(pow(clamp(float(1.0).sub(dist.div(max(u.uTrail, 1e-3))), 0.0, 1.0), 1.5));
      const lit = select(u.uFull.lessThan(0.5), run, float(1.0));
      const k = vec3(0.57735027);
      const ca = cos(u.uHue);
      const hued = u.uGlow.mul(ca).add(cross(k, u.uGlow).mul(sin(u.uHue))).add(k.mul(dot(k, u.uGlow)).mul(float(1.0).sub(ca)));
      return vec4(max(hued, 0.0).mul(edge).mul(lit).mul(u.uIntensity), 1.0);
    })();
    return finish(m, u);
  },

  lines3d() {
    const u = {
      ...surfUniforms(), uCenter: uniform(new THREE.Vector2(0.5, 0.5)), uLines: uniform(4), uHead: uniform(0), uTrail: uniform(0.35),
      uWidthPx: uniform(7), uMinW: uniform(0.06), uWf: uniform(1), uTaper: uniform(0.12), uSpreadPx: uniform(8), uLag: uniform(0),
      uHeadBright: uniform(0.3), uIntensity: uniform(1), uDirSign: uniform(1),
      uC1: uniform(new THREE.Color()), uC2: uniform(new THREE.Color()), uC3: uniform(new THREE.Color()),
    };
    // Dilated coverage: the most coverage within r px.
    const cov = (q, r) => {
      const mx = atGl(u.tN, q).a.toVar();
      Loop({ start: int(0), end: int(8), type: 'int', condition: '<' }, ({ i }) => {
        const ang = float(i).mul(RING);
        mx.assign(max(mx, atGl(u.tN, q.add(vec2(cos(ang), sin(ang)).mul(r).div(u.uRes))).a));
      });
      return mx;
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const q = glUv().toVar();
      const d = q.sub(u.uCenter).mul(u.uRes);
      const s = atan(d.y, d.x).div(6.2831853).add(0.5).toVar();
      const L = vec3(0.0).toVar();
      Loop({ start: int(0), end: int(8), type: 'int', condition: '<' }, ({ i }) => {
        const fi = float(i).toVar();
        const on = step(fi.add(0.5), u.uLines);
        const dist = fract(u.uHead.sub(fi.mul(u.uLag)).sub(s).mul(u.uDirSign));
        const tr = clamp(float(1.0).sub(dist.div(max(u.uTrail, 1e-3))), 0.0, 1.0).toVar();
        const w = max(u.uWidthPx.mul(max(u.uWf, u.uMinW)).mul(smoothstep(0.0, max(u.uTaper, 1e-3), tr)), 0.75).toVar();
        const off = fi.mul(u.uSpreadPx).toVar();
        const ring = clamp(cov(q, off.add(w)).sub(cov(q, off)), 0.0, 1.0);
        const headGlow = float(1.0).add(u.uHeadBright.mul(3.0).mul(smoothstep(0.94, 1.0, tr)));
        const slot = mod(fi, 3.0);
        const c = select(slot.lessThan(0.5), u.uC1, select(slot.lessThan(1.5), u.uC2, u.uC3));
        L.addAssign(c.mul(ring).mul(step(1e-4, tr)).mul(mix(0.35, 1.0, tr)).mul(headGlow).mul(on));
      });
      return vec4(L.mul(u.uIntensity), 1.0);
    })();
    return finish(m, u);
  },

  glowComp3d() {
    const u = {
      tColor: sampler(), tLight: sampler(), tHalo: sampler(), uRes: uniform(new THREE.Vector2(1, 1)),
      uMix: uniform(1), uCore: uniform(1), uHalo: uniform(0), uSrcLevel: uniform(1),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const c = u.tColor.sample(screenUV).toVar();
      const L = u.tLight.sample(screenUV).rgb.mul(u.uCore).add(u.tHalo.sample(screenUV).rgb.mul(u.uHalo)).toVar();
      const la = clamp(max(L.r, max(L.g, L.b)), 0.0, 1.0);
      return mix(c, vec4(c.rgb.mul(u.uSrcLevel).add(L), max(c.a.mul(u.uSrcLevel), la)), u.uMix);
    })();
    return finish(m, u);
  },

  edge3d() {
    const u = {
      ...surfUniforms(), ...edgeUniforms(), uCenter: uniform(new THREE.Vector2(0.5, 0.5)), uHalf: uniform(new THREE.Vector2(0.25, 0.25)),
      uMethod: uniform(0), uThr: uniform(0.12), uKnee: uniform(0.35), uLow: uniform(0.4), uThick: uniform(0), uGain: uniform(1),
      uColorMode: uniform(0), uInvert: uniform(0), uBands: uniform(8), uSigma: uniform(2), uK: uniform(1.6), uTau: uniform(15),
      uPhi: uniform(25), uEps: uniform(0), uAnim: uniform(0), uSpd: uniform(1), uProgress: uniform(0), uSweepAngle: uniform(0),
      uSweepSoft: uniform(0.1), uEdgeA: uniform(new THREE.Color()), uEdgeB: uniform(new THREE.Color()),
    };
    const ring = (q, r) => {
      const acc = fxTone(fxUnpre(atGl(u.tColor, q))).mul(2.0).toVar();
      Loop({ start: int(0), end: int(8), type: 'int', condition: '<' }, ({ i }) => {
        const ang = float(i).mul(RING);
        acc.addAssign(fxTone(fxUnpre(atGl(u.tColor, q.add(vec2(cos(ang), sin(ang)).mul(r).div(u.uRes))))));
      });
      return acc.div(10.0);
    };
    const vn = (p) => {
      const i = floor(p).toVar();
      const f = fract(p);
      const w = f.mul(f).mul(vec2(3.0).sub(f.mul(2.0))).toVar();
      return mix(mix(fxHash(i), fxHash(i.add(vec2(1.0, 0.0))), w.x), mix(fxHash(i.add(vec2(0.0, 1.0))), fxHash(i.add(vec2(1.0, 1.0))), w.x), w.y);
    };
    const level = (q, bands) => floor(clamp(e3Z(u, q).sub(u.uZRange.x).div(max(u.uZRange.y.sub(u.uZRange.x), 1e-4)), 0.0, 0.9999).mul(bands));
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uv = glUv().toVar();
      const q = uv.sub(u.uCenter).div(max(u.uHalf.mul(2.0), vec2(1e-4))).toVar();
      const axis = vec2(cos(u.uSweepAngle), sin(u.uSweepAngle));
      const asp = u.uHalf.x.mul(u.uRes.x).div(max(u.uHalf.y.mul(u.uRes.y), 1e-4));
      const span = abs(axis.x).mul(asp).add(abs(axis.y)).mul(0.5).add(1e-5);
      const sweep = dot(q.mul(vec2(asp, 1.0)), axis).div(span.mul(2.0)).add(0.5).toVar();
      const bt = floor(u.uTime.mul(8.0).mul(u.uSpd));
      const boil = vec2(vn(q.mul(14.0).add(bt.mul(7.13))), vn(q.mul(14.0).add(91.7).sub(bt.mul(3.31)))).sub(0.5).mul(vec2(3.5).div(u.uRes));
      const euv = uv.add(select(u.uAnim.greaterThan(4.5), boil, vec2(0.0))).toVar();
      const { e: g, col: near } = e3Edges(u, euv, u.uThick.add(1.0));
      const cov = atGl(u.tN, euv).a.toVar();
      const geo = max(g.x, max(g.y.mul(1.2), g.z.mul(6.0))).toVar();
      const th = u.uThr.mul(0.7).toVar();
      const eGrad = smoothstep(th.mul(float(1.0).sub(u.uKnee)), th.mul(float(1.0).add(u.uKnee)).add(0.003), geo);
      const eThin = select(geo.greaterThanEqual(th), float(1.0), select(geo.greaterThanEqual(th.mul(u.uLow)), float(0.5), float(0.0)));
      const a = ring(euv, u.uSigma);
      const b = ring(euv, u.uSigma.mul(u.uK));
      const S = float(1.0).add(u.uTau).mul(a).sub(u.uTau.mul(b)).toVar();
      const t2 = exp(clamp(u.uPhi.mul(S.sub(u.uEps)), -8.0, 8.0).mul(2.0));
      const T = select(S.greaterThanEqual(u.uEps), float(1.0), float(1.0).add(t2.sub(1.0).div(t2.add(1.0))));
      const eInk = max(clamp(float(1.0).sub(T), 0.0, 1.0).mul(cov), g.x);
      const bands = max(floor(u.uBands.add(0.5)), 2.0).toVar();
      const px = vec2(1.0).div(u.uRes);
      const l0 = level(euv, bands);
      const lr = level(euv.add(vec2(px.x, 0.0)), bands);
      const lu = level(euv.add(vec2(0.0, px.y)), bands);
      const c3 = cov.mul(atGl(u.tN, euv.add(vec2(px.x, 0.0))).a).mul(atGl(u.tN, euv.add(vec2(0.0, px.y))).a);
      const stepped = abs(lr.sub(l0)).greaterThan(0.5).or(abs(lu.sub(l0)).greaterThan(0.5));
      const eBands = max(select(stepped, c3, float(0.0)), g.x);
      const meth = u.uMethod;
      const e0 = select(meth.lessThan(0.5), eGrad, select(meth.lessThan(1.5), eThin, select(meth.lessThan(2.5), eInk, eBands)));
      const e1 = select(u.uInvert.greaterThan(0.5), float(1.0).sub(e0).mul(max(cov, g.x)), e0);
      const e = clamp(e1.mul(u.uGain), 0.0, 1.0).toVar();
      const prog = clamp(u.uProgress.mul(u.uSpd), 0.0, 1.0);
      const s2 = u.uSweepSoft.add(0.02);
      const pp = mix(s2.negate(), s2.add(1.0), prog);
      const showDraw = float(1.0).sub(smoothstep(pp.sub(s2), pp.add(s2), sweep));
      const sd = sweep.sub(prog.mul(1.1).sub(0.05)).toVar();
      const showScan = select(sd.lessThan(0.0), float(1.0), float(0.0));
      const fl = fxHash(vec2(floor(u.uTime.mul(24.0).mul(u.uSpd)), 7.0));
      const an = u.uAnim;
      const show = select(an.greaterThan(0.5).and(an.lessThan(1.5)), showDraw,
        select(an.greaterThan(1.5).and(an.lessThan(2.5)), showScan,
          select(an.greaterThan(2.5).and(an.lessThan(3.5)), fl.mul(fl).mul(0.55).add(0.45), float(1.0))));
      const scan = select(an.greaterThan(1.5).and(an.lessThan(2.5)), exp(abs(sd).mul(-90.0)).mul(max(cov, g.x)), float(0.0)).toVar();
      e.mulAssign(show);
      const n = atGl(u.tN, euv).rgb.mul(2.0).sub(1.0);
      const hp = abs(mod(fract(atan(n.y, n.x).div(6.2831853).add(0.5)).mul(6.0).add(vec3(0.0, 4.0, 2.0)), 6.0).sub(3.0));
      const hue = clamp(hp.sub(1.0), 0.0, 1.0);
      const z01 = clamp(e3Z(u, euv).sub(u.uZRange.x).div(max(u.uZRange.y.sub(u.uZRange.x), 1e-4)), 0.0, 1.0);
      const cm = u.uColorMode;
      const col = select(cm.lessThan(0.5), u.uEdgeA,
        select(cm.lessThan(1.5), clamp(pow(clamp(near, 0.0, 1.0), vec3(0.6)).mul(1.25), 0.0, 1.0),
          select(cm.lessThan(2.5), hue, mix(u.uEdgeA, u.uEdgeB, z01)))).toVar();
      return vec4(col.mul(e).add(col.mul(0.85).add(0.15).mul(scan)), clamp(e.add(scan.mul(0.5)), 0.0, 1.0));
    })();
    return finish(m, u);
  },

  edgeComp3d() {
    const u = {
      tColor: sampler(), tLight: sampler(), tHalo: sampler(), uRes: uniform(new THREE.Vector2(1, 1)),
      uMix: uniform(1), uSrcLevel: uniform(0), uGlow: uniform(0), uBlendMode: uniform(0),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const src = u.tColor.sample(screenUV).toVar();
      const ed = u.tLight.sample(screenUV).toVar();
      const e = clamp(ed.a, 0.0, 1.0).toVar();
      const base = src.mul(u.uSrcLevel).toVar();
      const bm = u.uBlendMode;
      const rgb = select(bm.lessThan(0.5), ed.rgb.add(base.rgb.mul(float(1.0).sub(e))),
        select(bm.lessThan(1.5), base.rgb.add(ed.rgb), base.rgb.add(ed.rgb.mul(float(1.0).sub(clamp(base.rgb, 0.0, 1.0))))));
      const a = select(bm.lessThan(0.5), e.add(base.a.mul(float(1.0).sub(e))),
        select(bm.lessThan(1.5), base.a.add(e), base.a.add(e.mul(float(1.0).sub(base.a)))));
      const h = u.tHalo.sample(screenUV).rgb.mul(u.uGlow).toVar();
      const outA = clamp(a.add(clamp(max(h.r, max(h.g, h.b)), 0.0, 1.0).mul(0.8)), 0.0, 1.0);
      return mix(src, vec4(rgb.add(h), outA), u.uMix);
    })();
    return finish(m, u);
  },

  aura3d() {
    const u = {
      ...surfUniforms(), tNarrow: sampler(), tWide: sampler(), uCenter: uniform(new THREE.Vector2(0.5, 0.5)),
      uCL: uniform(new THREE.Color()), uCM: uniform(new THREE.Color()), uCR: uniform(new THREE.Color()),
      uHI: uniform(new THREE.Color()), uHO: uniform(new THREE.Color()),
      uGradL: uniform(0.16), uGradR: uniform(0.94), uMelt: uniform(1), uBase: uniform(0.46), uVary: uniform(0.48),
      uVaryScale: uniform(6), uFlow: uniform(0.35), uChroma: uniform(0.41), uHaloLevel: uniform(1.3), uShiftPx: uniform(3),
      uBreath: uniform(1), uCoreLevel: uniform(1.15), uSrcMode: uniform(0), uSrcThr: uniform(0),
    };
    const h3 = (p) => fract(sin(dot(p, vec3(127.1, 311.7, 74.7))).mul(43758.5453123));
    const n3 = (p) => {
      const i = floor(p).toVar();
      const f = fract(p);
      const w = f.mul(f).mul(vec3(3.0).sub(f.mul(2.0))).toVar();
      const a = mix(mix(h3(i), h3(i.add(vec3(1.0, 0.0, 0.0))), w.x), mix(h3(i.add(vec3(0.0, 1.0, 0.0))), h3(i.add(vec3(1.0, 1.0, 0.0))), w.x), w.y);
      const b = mix(mix(h3(i.add(vec3(0.0, 0.0, 1.0))), h3(i.add(vec3(1.0, 0.0, 1.0))), w.x), mix(h3(i.add(vec3(0.0, 1.0, 1.0))), h3(i.add(vec3(1.0, 1.0, 1.0))), w.x), w.y);
      return mix(a, b, w.z);
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uv = glUv().toVar();
      const own = u.tColor.sample(screenUV).toVar();
      const nar = u.tNarrow.sample(screenUV).toVar();
      const wide = u.tWide.sample(screenUV).toVar();
      const p = u.tP.sample(screenUV).xyz.toVar();
      const frameP = vec3(uv.sub(u.uCenter).mul(vec2(u.uRes.x.div(u.uRes.y), 1.0)).mul(1.5), 0.0);
      const np = mix(frameP, p.mul(2.0), step(0.5, own.a)).mul(u.uVaryScale);
      const nz = n3(np.add(vec3(0.0, u.uTime.mul(u.uFlow), u.uTime.mul(u.uFlow).mul(0.6)))).toVar();
      const vary = mix(1.0, nz.mul(1.3).add(0.35), u.uVary);
      const sh = vec2(u.uShiftPx.div(u.uRes.x), 0.0);
      const sharp = vec3(fxUnpre(atGl(u.tColor, uv.add(sh))).r, fxUnpre(own).g, fxUnpre(atGl(u.tColor, uv.sub(sh))).b).toVar();
      const soft = select(nar.a.greaterThan(1e-4), nar.rgb.div(max(nar.a, 1e-4)), sharp);
      const melt = clamp(u.uMelt.mul(u.uBase.add(float(1.0).sub(u.uBase).mul(nz).mul(u.uVary).mul(1.5))), 0.0, 1.0);
      const core0 = mix(sharp, soft, melt).toVar();
      const gx = smoothstep(u.uGradL, max(u.uGradR, u.uGradL.add(1e-3)), p.x.add(0.5)).toVar();
      const grad = select(gx.lessThan(0.5), mix(u.uCL, u.uCM, gx.mul(2.0)), mix(u.uCM, u.uCR, gx.mul(2.0).sub(1.0)));
      const core = mix(core0, vec3(fxLuma(core0)).mul(grad).mul(1.4), 0.7).mul(u.uCoreLevel);
      const dR = atGl(u.tWide, u.uCenter.add(uv.sub(u.uCenter).mul(float(1.0).sub(u.uChroma.mul(0.04))))).a;
      const dB = atGl(u.tWide, u.uCenter.add(uv.sub(u.uCenter).mul(float(1.0).add(u.uChroma.mul(0.04))))).a;
      const lt = smoothstep(u.uSrcThr, 1.0, fxTone(fxUnpre(wide)));
      const sm = u.uSrcMode;
      const gate = select(sm.greaterThan(1.5), lt, select(sm.lessThan(0.5), mix(float(1.0), lt, 0.5), float(1.0)));
      const hm = vec3(dR, wide.a, dB).mul(gate);
      const hc = mix(u.uHO, u.uHI, clamp(nar.a.mul(1.6), 0.0, 1.0));
      const halo = hc.mul(hm).mul(u.uHaloLevel).mul(u.uBreath).mul(vary).toVar();
      const col = core.mul(own.a).add(halo.mul(float(1.0).sub(own.a.mul(0.6))));
      const a = max(own.a, clamp(max(halo.r, max(halo.g, halo.b)), 0.0, 1.0));
      return mix(own, vec4(col, a), u.uMix);
    })();
    return finish(m, u);
  },

  glitch3d() {
    const u = {
      tColor: sampler(), uRes: uniform(new THREE.Vector2(1, 1)), uMix: uniform(1), uTime: uniform(0),
      uCenterPx: uniform(new THREE.Vector2()), uUp: uniform(new THREE.Vector2(0, 1)), uAxX: uniform(new THREE.Vector2(1, 0)),
      uAxZ: uniform(new THREE.Vector2(0, 0)), uAmt: uniform(0.5), uBlk: uniform(24), uSpeed: uniform(4), uShift: uniform(8),
    };
    const at = (q) => atGl(u.tColor, q.div(u.uRes));
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const px = glUv().mul(u.uRes).toVar();
      const own = u.tColor.sample(screenUV).toVar();
      const t = floor(u.uTime.mul(u.uSpeed.mul(6.0).add(0.001))).toVar();
      const row = floor(dot(px.sub(u.uCenterPx), u.uUp).div(max(u.uBlk, 2.0))).toVar();
      const lineG = step(float(1.0).sub(u.uAmt.mul(0.6)), fxHash(vec2(row, t))).toVar();
      const sx = fxHash(vec2(row.mul(1.7), t.mul(0.3))).sub(0.5).mul(u.uAmt).mul(0.12).mul(lineG);
      const sz = fxHash(vec2(row.mul(2.3), t.mul(0.7))).sub(0.5).mul(u.uAmt).mul(0.12).mul(lineG);
      const q = px.sub(u.uAxX.mul(sx).add(u.uAxZ.mul(sz))).toVar();
      const cs = normalize(u.uAxX.add(1e-6)).mul(u.uShift).mul(u.uAmt.add(0.3)).toVar();
      const g = at(q).toVar();
      const r = at(q.add(cs)).toVar();
      const b = at(q.sub(cs)).toVar();
      const a = r.a.add(g.a).add(b.a).div(3.0).toVar();
      const col0 = vec3(fxUnpre(r).r, fxUnpre(g).g, fxUnpre(b).b);
      const col = max(col0.add(lineG.mul(fxHash(vec2(row, t.mul(2.1))).sub(0.5)).mul(u.uAmt).mul(0.35)), 0.0);
      return mix(own, vec4(col.mul(a), a), u.uMix);
    })();
    return finish(m, u);
  },

  slit3d() {
    const u = {
      tColor: sampler(), tN: sampler(), uRes: uniform(new THREE.Vector2(1, 1)), uMix: uniform(1), uTime: uniform(0),
      uCenterPx: uniform(new THREE.Vector2()), uAcross: uniform(new THREE.Vector2(1, 0)), uAlong: uniform(new THREE.Vector2(0, 1)),
      uExtA: uniform(100), uExtB: uniform(100), uCount: uniform(84), uShift: uniform(0.035), uDrive: uniform(1), uHold: uniform(0.61),
      uGap: uniform(0), uWave: uniform(1.6), uSeed: uniform(7),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const px = glUv().mul(u.uRes).toVar();
      const own = u.tColor.sample(screenUV).toVar();
      const d = px.sub(u.uCenterPx).toVar();
      const a = dot(d, u.uAcross).div(max(u.uExtA.mul(2.0), 1.0)).add(0.5).toVar();
      const n = max(2.0, floor(u.uCount.add(0.5))).toVar();
      const idx = floor(a.mul(n)).toVar();
      const probe = u.uCenterPx.add(u.uAcross.mul(idx.add(0.5).div(n).sub(0.5)).mul(u.uExtA.mul(2.0))).toVar();
      const field = atGl(u.tN, probe.div(u.uRes)).a.toVar();
      const o = u.uAlong.mul(3.0);
      const n1 = atGl(u.tN, probe.add(o).div(u.uRes)).toVar();
      const n2 = atGl(u.tN, probe.sub(o).div(u.uRes)).toVar();
      const edge = abs(n1.a.sub(n2.a)).add(n1.a.mul(n2.a).mul(float(1.0).sub(dot(n1.rgb.mul(2.0).sub(1.0), n2.rgb.mul(2.0).sub(1.0)))));
      const dr = u.uDrive;
      const f = select(dr.lessThan(0.5), field.mul(2.0).sub(1.0),
        select(dr.lessThan(1.5), clamp(edge.mul(4.0), 0.0, 2.0).sub(1.0),
          select(dr.lessThan(2.5), sin(idx.mul(0.35).add(u.uTime.mul(max(u.uWave, 0.0)))),
            fxHash(vec2(idx.mul(0.013).add(u.uSeed), idx.mul(0.07))).mul(2.0).sub(1.0))));
      const hold = float(1.0).sub(u.uHold.mul(clamp(field, 0.0, 1.0)));
      const off = f.mul(u.uShift).mul(hold);
      const b = fract(dot(d, u.uAlong).div(max(u.uExtB.mul(2.0), 1.0)).add(0.5).sub(off).add(2.0));
      const q = u.uCenterPx.add(u.uAcross.mul(dot(d, u.uAcross))).add(u.uAlong.mul(b.sub(0.5)).mul(u.uExtB.mul(2.0)));
      const moved = atGl(u.tColor, q.div(u.uRes));
      const inGap = step(float(1.0).sub(u.uGap.mul(n)), fract(a.mul(n)));
      return mix(own, moved.mul(float(1.0).sub(inGap)), u.uMix);
    })();
    return finish(m, u);
  },

  stretch3d() {
    const u = {
      tColor: sampler(), uRes: uniform(new THREE.Vector2(1, 1)), uMix: uniform(1), uTime: uniform(0), uExposure: uniform(1),
      uCenterPx: uniform(new THREE.Vector2()), uDirA: uniform(new THREE.Vector2(0, 1)), uMode: uniform(1), uLo: uniform(0.35),
      uHi: uniform(1), uSpan: uniform(240), uJitter: uniform(0.4), uBand: uniform(3), uFlip: uniform(0), uRef: uniform(1),
    };
    const at = (q) => atGl(u.tColor, q.div(u.uRes));
    const lum = (q) => {
      const s2 = at(q);
      return fxLuma(veDisplayTransform(fxUnpre(s2), u.uExposure)).mul(s2.a);
    };
    const inside = (q) => q.x.greaterThanEqual(0.0).and(q.y.greaterThanEqual(0.0)).and(q.x.lessThanEqual(u.uRes.x)).and(q.y.lessThanEqual(u.uRes.y));
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const px = glUv().mul(u.uRes).toVar();
      const rel = px.sub(u.uCenterPx).toVar();
      const radial = u.uMode.greaterThan(1.5);
      const dir0 = select(radial, normalize(rel.add(1e-5)), u.uDirA);
      const dir = select(u.uFlip.greaterThan(0.5), dir0.negate(), dir0).toVar();
      const lane = select(radial, atan(rel.y, rel.x).div(6.2831853).add(0.5).mul(u.uRes.y), dot(rel, vec2(u.uDirA.y.negate(), u.uDirA.x)));
      const laneId = floor(lane.div(max(u.uBand, 1.0)));
      const span = u.uSpan.mul(float(1.0).sub(u.uJitter.mul(fxHash(vec2(laneId, 17.0)))));
      const stepv = dir.mul(span.div(48.0)).toVar();
      const cur = u.tColor.sample(screenUV).toVar();
      const l = lum(px);
      const inBand = l.greaterThanEqual(u.uLo).and(l.lessThanEqual(u.uHi));
      const origin = px.toVar();
      const alive = float(1.0).toVar();
      const found = float(0.0).toVar();
      const ext = cur.toVar();
      Loop({ start: int(1), end: int(49), type: 'int', condition: '<' }, ({ i }) => {
        const q = px.sub(stepv.mul(float(i))).toVar();
        const sl = lum(q).toVar();
        const ok = inside(q).and(sl.greaterThanEqual(u.uLo)).and(sl.lessThanEqual(u.uHi));
        const sv = at(q);
        alive.assign(select(ok, alive, float(0.0)));
        origin.assign(select(alive.greaterThan(0.5), q, origin));
        const hit = found.lessThan(0.5).and(ok);
        ext.assign(select(hit, mix(cur, sv, float(1.0).sub(float(i).div(48.0))), ext));
        found.assign(select(hit, float(1.0), found));
      });
      const res = select(inBand, at(origin), ext);
      return mix(cur, res, u.uMix);
    })();
    return finish(m, u);
  },

  rulers3d() {
    const seg = uniformArray(new Float32Array(60), 'float');
    const cor = uniformArray(new Float32Array(16), 'float');
    const u = {
      tColor: sampler(), uRes: uniform(new THREE.Vector2(1, 1)), uMix: uniform(1),
      // The GLSL writer fills `.value` in place; here that is the node's own array.
      uSeg: { node: seg, get value() { return seg.array; } },
      uCor: { node: cor, get value() { return cor.array; } },
      uCenterPx: uniform(new THREE.Vector2()),
      uLw: uniform(1.5), uExt: uniform(1e6), uDash: uniform(0), uShape: uniform(0), uMarkR: uniform(1), uMarkT: uniform(2.5),
      uMid: uniform(0), uLineOp: uniform(0.9), uCorners: uniform(8), uMarkHs: uniform(new THREE.Vector2(7.5, 7.5)),
      uLineC: uniform(new THREE.Color()), uMarkC: uniform(new THREE.Color()),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const px = glUv().mul(u.uRes).toVar();
      const src = u.tColor.sample(screenUV).toVar();
      const front = float(0.0).toVar();
      const back = float(0.0).toVar();
      const mark = float(0.0).toVar();
      const marks = u.uShape.lessThan(6.5);
      Loop({ start: int(0), end: int(12), type: 'int', condition: '<' }, ({ i }) => {
        const o = i.mul(5);
        const a = vec2(seg.element(o), seg.element(o.add(1))).toVar();
        const b = vec2(seg.element(o.add(2)), seg.element(o.add(3))).toVar();
        const vis = seg.element(o.add(4));
        const ab = b.sub(a);
        const L = length(ab).toVar();
        const t = ab.div(max(L, 1e-4)).toVar();
        const mid = a.add(b).mul(0.5);
        const rel = px.sub(mid).toVar();
        const along = dot(rel, t);
        const acrossS = dot(rel, vec2(t.y.negate(), t.x));
        const live = step(0.5, L);
        const g = srGuide(abs(acrossS), along, L.mul(0.5), u.uLw, u.uExt, u.uDash).mul(live);
        front.assign(select(vis.greaterThan(0.5), max(front, g), front));
        back.assign(select(vis.greaterThan(0.5), back, max(back, g)));
        const mm = clamp(float(0.5).sub(srMark(vec2(acrossS, along), u.uMarkHs, float(1.0), u.uShape, u.uMarkR, u.uMarkT)), 0.0, 1.0);
        mark.assign(select(u.uMid.greaterThan(0.5).and(marks), max(mark, mm.mul(live)), mark));
      });
      Loop({ start: int(0), end: int(8), type: 'int', condition: '<' }, ({ i }) => {
        const c = vec2(cor.element(i.mul(2)), cor.element(i.mul(2).add(1))).toVar();
        const sgn = vec2(select(c.x.greaterThanEqual(u.uCenterPx.x), float(1.0), float(-1.0)), select(c.y.greaterThanEqual(u.uCenterPx.y), float(1.0), float(-1.0)));
        const mk = clamp(float(0.5).sub(srMark(px.sub(c).mul(sgn), u.uMarkHs, float(0.0), u.uShape, u.uMarkR, u.uMarkT)), 0.0, 1.0);
        const on = step(float(i).add(0.5), u.uCorners);
        mark.assign(select(marks, max(mark, mk.mul(on)), mark));
      });
      const lines = max(front, back.mul(0.45).mul(float(1.0).sub(src.a))).mul(u.uLineOp).toVar();
      const o1 = src.mul(float(1.0).sub(lines)).add(vec4(u.uLineC.mul(lines), lines));
      const o2 = o1.mul(float(1.0).sub(mark)).add(vec4(u.uMarkC.mul(mark), mark));
      return mix(src, o2, u.uMix);
    })();
    return finish(m, u);
  },

  curves3d() {
    const u = {
      tColor: sampler(), tLUT: makeTslSampler({ rgba: [255, 255, 255, 255] }), uRes: uniform(new THREE.Vector2(1, 1)), uMix: uniform(1),
    };
    const lut = (x) => u.tLUT.sample(vec2(x.mul(255.0).add(0.5).div(256.0), 0.5));
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const s0 = u.tColor.sample(screenUV).toVar();
      const c = max(s0.rgb.div(max(s0.a, 1e-4)), 0.0);
      const t = clamp(float(1.0).sub(exp(c.mul(-1.6))), 0.0, 1.0).toVar();
      const t2 = vec3(lut(t.r).r, lut(t.g).g, lut(t.b).b);
      const c2 = log(max(float(1.0).sub(min(t2, vec3(0.9985))), 1e-4)).negate().div(1.6);
      return select(s0.a.lessThan(0.001), s0, mix(s0, vec4(c2.mul(s0.a), s0.a), u.uMix));
    })();
    return finish(m, u);
  },

  voxel3d() {
    const u = {
      ...surfUniforms(), uInvProj: uniform(new THREE.Matrix4()), uViewToModel4: uniform(new THREE.Matrix4()),
      uBoxH: uniform(new THREE.Vector3(0.5, 0.5, 0.5)), uVox: uniform(0.05), uEdge: uniform(0.35), uLightM: uniform(new THREE.Vector3(0, 0, 1)),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uvn = screenUV;
      const own = u.tColor.sample(uvn).toVar();
      const dv = viewRay(uvn, u.uInvProj);
      const O = u.uViewToModel4.mul(vec4(0.0, 0.0, 0.0, 1.0)).xyz.toVar();
      const D = normalize(u.uViewToModel4.mul(vec4(dv, 0.0)).xyz).toVar();
      const bmin = u.uBoxH.negate().sub(u.uVox);
      const bmax = u.uBoxH.add(u.uVox);
      const inv = vec3(1.0).div(mix(vec3(1e-6), D, step(vec3(1e-6), abs(D)))).toVar();
      const t0 = bmin.sub(O).mul(inv);
      const t1 = bmax.sub(O).mul(inv);
      const tn = min(t0, t1).toVar();
      const tf = max(t0, t1).toVar();
      const tEnter = max(max(tn.x, tn.y), max(tn.z, 0.0)).toVar();
      const tExit = min(tf.x, min(tf.y, tf.z)).toVar();
      const P = O.add(D.mul(tEnter.add(1e-4)));
      const cell = floor(P.div(u.uVox)).toVar();
      const st = sign(D).toVar();
      const tMax = cell.add(max(st, 0.0)).mul(u.uVox).sub(O).mul(inv).toVar();
      const tDel = abs(inv.mul(u.uVox)).toVar();
      const face = select(tn.x.greaterThan(tn.y).and(tn.x.greaterThan(tn.z)), float(0.0), select(tn.y.greaterThan(tn.z), float(1.0), float(2.0))).toVar();
      const hit = float(0.0).toVar();
      const tHit = tEnter.toVar();
      Loop({ start: int(0), end: int(64), type: 'int', condition: '<' }, () => {
        // Solid test every step (uniform control flow), the DDA advance only until a hit.
        const c = cell.add(0.5).mul(u.uVox);
        const clip = u.uPosToClip.mul(vec4(c, 1.0));
        const suv = ndcToUv(clip.xy.div(clip.w)).toVar();
        const q = u.tP.sample(suv).xyz;
        const cov = u.tN.sample(suv).a;
        const dd = abs(q.sub(c));
        const inFrame = suv.x.greaterThanEqual(0.0).and(suv.y.greaterThanEqual(0.0)).and(suv.x.lessThanEqual(1.0)).and(suv.y.lessThanEqual(1.0));
        const solid = inFrame.and(cov.greaterThan(0.5)).and(max(dd.x, max(dd.y, dd.z)).lessThanEqual(u.uVox.mul(0.75)));
        If(hit.lessThan(0.5).and(solid), () => { hit.assign(1.0); });
        If(hit.lessThan(0.5), () => {
          If(tMax.x.lessThan(tMax.y).and(tMax.x.lessThan(tMax.z)), () => {
            tHit.assign(tMax.x); cell.x.addAssign(st.x); tMax.x.addAssign(tDel.x); face.assign(0.0);
          }).ElseIf(tMax.y.lessThan(tMax.z), () => {
            tHit.assign(tMax.y); cell.y.addAssign(st.y); tMax.y.addAssign(tDel.y); face.assign(1.0);
          }).Else(() => {
            tHit.assign(tMax.z); cell.z.addAssign(st.z); tMax.z.addAssign(tDel.z); face.assign(2.0);
          });
        });
      });
      const c = cell.add(0.5).mul(u.uVox);
      const clip = u.uPosToClip.mul(vec4(c, 1.0));
      const sc = u.tColor.sample(ndcToUv(clip.xy.div(clip.w)));
      const col = fxUnpre(sc);
      const nrm = select(face.lessThan(0.5), vec3(st.x.negate(), 0.0, 0.0), select(face.lessThan(1.5), vec3(0.0, st.y.negate(), 0.0), vec3(0.0, 0.0, st.z.negate())));
      const shade = dot(nrm, u.uLightM).max(0.0).mul(0.45).add(0.55);
      const hp = O.add(D.mul(tHit)).div(u.uVox).sub(cell).toVar();
      const f2 = select(face.lessThan(0.5), hp.yz, select(face.lessThan(1.5), hp.xz, hp.xy)).toVar();
      const e2 = min(f2, vec2(1.0).sub(f2));
      const edge = float(1.0).sub(u.uEdge.mul(float(1.0).sub(smoothstep(0.02, 0.09, min(e2.x, e2.y)))));
      const hitOut = vec4(col.mul(shade).mul(edge), 1.0);
      const outc = select(tExit.greaterThan(tEnter).and(hit.greaterThan(0.5)), hitOut, vec4(0.0));
      return mix(own, outc, u.uMix);
    })();
    return finish(m, u);
  },

  depthScan3d() {
    const u = {
      tColor: sampler(), tP: sampler(), tRamp: makeTslSampler({ rgba: [255, 255, 255, 255] }), uRes: uniform(new THREE.Vector2(1, 1)),
      uPosToView: uniform(new THREE.Matrix4()), uSpace: uniform(0), uZRange: uniform(new THREE.Vector2(0, 1)),
      uPhase: uniform(0), uWidth: uniform(0.011), uSplit: uniform(0.024), uFeather: uniform(0.0035), uGrain: uniform(0.22),
      uGamma: uniform(1), uLow: uniform(0), uHigh: uniform(1), uColorMode: uniform(0), uColor: uniform(new THREE.Color()),
      uBrightness: uniform(1.25), uSourceMix: uniform(0), uAmount: uniform(1),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uvn = screenUV;
      const s0 = u.tColor.sample(uvn);
      const cov = s0.a.toVar();
      const src = s0.rgb.div(max(cov, 1e-4)).toVar();
      const p = u.tP.sample(uvn).xyz.toVar();
      const z = u.uPosToView.mul(vec4(p, 1.0)).z.negate();
      const dCam = float(1.0).sub(clamp(z.sub(u.uZRange.x).div(max(1e-4, u.uZRange.y.sub(u.uZRange.x))), 0.0, 1.0));
      const dPlane = clamp(select(u.uSpace.lessThan(1.5), p.x, select(u.uSpace.lessThan(2.5), p.y, p.z)).add(0.5), 0.0, 1.0);
      const d = pow(select(u.uSpace.lessThan(0.5), dCam, dPlane), u.uGamma).toVar();
      // The GLSL hashes floor(gl_FragCoord): the same pixel grid here.
      const n = fxHash(floor(screenCoordinate.xy)).sub(0.5).mul(u.uGrain).mul(u.uWidth.add(u.uFeather)).mul(1.6).toVar();
      const soft = max(u.uFeather, fwidth(d).mul(0.35)).toVar();
      const band = (center, noise, w) => float(1.0).sub(smoothstep(w, w.add(soft), abs(d.sub(center).add(noise))));
      const scan = vec3(0.0).toVar();
      If(u.uColorMode.lessThan(0.5), () => {
        scan.assign(vec3(
          band(clamp(u.uPhase.sub(u.uSplit), 0.0, 1.0), n, u.uWidth),
          band(u.uPhase, n.mul(0.35), u.uWidth),
          band(clamp(u.uPhase.add(u.uSplit), 0.0, 1.0), n.negate(), u.uWidth),
        ));
      }).ElseIf(u.uColorMode.lessThan(1.5), () => {
        scan.assign(u.uColor.mul(band(u.uPhase, n.mul(0.35), u.uWidth)));
      }).Else(() => {
        const ext = max(u.uSplit, u.uWidth);
        const mm = band(u.uPhase, n.mul(0.35), u.uWidth.add(u.uSplit));
        const t = clamp(d.sub(u.uPhase).add(n.mul(0.35)).div(ext.mul(2.0)).add(0.5), 0.0, 1.0);
        scan.assign(u.tRamp.sample(vec2(t, 0.5)).rgb.mul(mm));
      });
      const valid = smoothstep(u.uLow, u.uLow.add(0.012), d).mul(smoothstep(u.uHigh.sub(0.012), u.uHigh, d).oneMinus());
      const lit = scan.mul(valid).mul(u.uBrightness);
      const result = mix(src, src.mul(u.uSourceMix).add(lit), u.uAmount);
      return select(cov.lessThan(0.001), s0, vec4(result.mul(cov), cov));
    })();
    return finish(m, u);
  },

  rim() {
    const u = {
      tN: sampler(), uRes: uniform(new THREE.Vector2(1, 1)), uInvProj: uniform(new THREE.Matrix4()),
      uColorA: uniform(new THREE.Color()), uColorB: uniform(new THREE.Color()),
      uIntensity: uniform(1), uPower: uniform(2), uSoft: uniform(0.5), uDirMix: uniform(0),
      uPulse: uniform(0), uTime: uniform(0), uDir: uniform(new THREE.Vector2(1, 0)),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uvn = screenUV;
      const nt = u.tN.sample(uvn);
      const n = normalize(nt.rgb.mul(2.0).sub(1.0));
      const facing = clamp(dot(n, viewRay(uvn, u.uInvProj).negate()), 0.0, 1.0);
      const f0 = pow(float(1.0).sub(facing), u.uPower).mul(smoothstep(0.0, 0.12, facing));
      const f1 = mix(smoothstep(0.45, 0.55, f0), f0, u.uSoft);
      const n2 = n.xy.div(max(length(n.xy), 1e-4));
      const fres = f1.mul(mix(float(1.0), smoothstep(-0.25, 0.9, dot(n2, u.uDir)), u.uDirMix));
      const pulse = float(1.0).sub(u.uPulse.mul(float(0.5).sub(sin(u.uTime.mul(3.0)).mul(0.5))));
      const col = mix(u.uColorB, u.uColorA, smoothstep(0.0, 1.0, fres));
      const e = col.mul(fres).mul(u.uIntensity).mul(pulse).mul(nt.a).mul(step(0.001, nt.a));
      return vec4(e, 1.0);
    })();
    return finish(m, u);
  },

  down() {
    const u = { tSrc: sampler(), uRes: uniform(new THREE.Vector2(1, 1)), uSrcTexel: uniform(new THREE.Vector2(1, 1)) };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uvn = screenUV;
      const o = u.uSrcTexel;
      const s = u.tSrc.sample(uvn).mul(4.0)
        .add(u.tSrc.sample(uvn.add(vec2(o.x.negate(), o.y.negate()))))
        .add(u.tSrc.sample(uvn.add(vec2(o.x, o.y.negate()))))
        .add(u.tSrc.sample(uvn.add(vec2(o.x.negate(), o.y))))
        .add(u.tSrc.sample(uvn.add(vec2(o.x, o.y))));
      return s.div(8.0);
    })();
    return finish(m, u);
  },

  up() {
    const u = { tSrc: sampler(), uRes: uniform(new THREE.Vector2(1, 1)), uSrcTexel: uniform(new THREE.Vector2(1, 1)) };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uvn = screenUV;
      const o = u.uSrcTexel;
      const s = u.tSrc.sample(uvn.add(vec2(o.x.mul(-2.0), 0.0)))
        .add(u.tSrc.sample(uvn.add(vec2(o.x.mul(2.0), 0.0))))
        .add(u.tSrc.sample(uvn.add(vec2(0.0, o.y.mul(-2.0)))))
        .add(u.tSrc.sample(uvn.add(vec2(0.0, o.y.mul(2.0)))))
        .add(u.tSrc.sample(uvn.add(vec2(o.x.negate(), o.y.negate()))).mul(2.0))
        .add(u.tSrc.sample(uvn.add(vec2(o.x, o.y.negate()))).mul(2.0))
        .add(u.tSrc.sample(uvn.add(vec2(o.x.negate(), o.y))).mul(2.0))
        .add(u.tSrc.sample(uvn.add(vec2(o.x, o.y))).mul(2.0));
      return s.div(12.0);
    })();
    return finish(m, u);
  },

  addLight() {
    const u = {
      tColor: sampler(), tLight: sampler(), tHalo: sampler(),
      uRes: uniform(new THREE.Vector2(1, 1)), uHalo: uniform(0), uBase: uniform(1), uLight: uniform(1),
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uvn = screenUV;
      const c = u.tColor.sample(uvn);
      const L = u.tLight.sample(uvn).rgb.mul(u.uLight).add(u.tHalo.sample(uvn).rgb.mul(u.uHalo));
      const la = clamp(max(L.r, max(L.g, L.b)), 0.0, 1.0);
      return vec4(c.rgb.mul(u.uBase).add(L), max(c.a, la));
    })();
    return finish(m, u);
  },

  /*
   * Flat Fresnel Rim (image / video) — model3dFx.js `flatRim`. Frame uv is
   * screenCoordinate / uRes and the depth goes through the layer box, the Depth
   * Scan twin's conventions exactly (depthScanNodes.js), so the box and the plate
   * agree on WebGPU. The 12 × 5 search is a real Loop: a JS loop would inline 60
   * texture reads per pixel into the WGSL (the camera-whip lesson).
   */
  flatRim() {
    const u = {
      tDepth: makeTslSampler({ rgba: [0, 0, 0, 255] }), uRes: uniform(new THREE.Vector2(1, 1)), uFxHomInv: uniform(new THREE.Matrix3()),
      uInvert: uniform(0), uGamma: uniform(1), uLow: uniform(0), uHigh: uniform(1), uPhase: uniform(0),
      uWindow: uniform(0.14), uFeather: uniform(0.04), uEdgeMin: uniform(0.02), uRimUv: uniform(new THREE.Vector2(0.01, 0.01)),
      uColorA: uniform(new THREE.Color()), uColorB: uniform(new THREE.Color()),
      uIntensity: uniform(1), uDirMix: uniform(0), uPulse: uniform(0), uTime: uniform(0),
      uDir: uniform(new THREE.Vector2(1, 0)),
    };
    const depthAt = (p) => {
      const raw = u.tDepth.sample(clamp(p, 0.0, 1.0)).r;
      const d = select(u.uInvert.greaterThan(0.5), raw.oneMinus(), raw);
      return pow(clamp(d, 0.0, 1.0), u.uGamma);
    };
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const uvn = screenCoordinate.xy.div(u.uRes);
      const h = u.uFxHomInv.mul(vec3(uvn.x, uvn.y, 1.0)).toVar();
      const p = select(h.z.lessThan(1e-6), vec2(-1e3, -1e3), h.xy.div(max(h.z, 1e-6))).toVar();
      const inside = step(0.0, p.x).mul(step(0.0, p.y)).mul(step(p.x, 1.0)).mul(step(p.y, 1.0));
      const d = depthAt(p).toVar();
      const best = float(0.0).toVar();
      const outward = vec2(0.0, 0.0).toVar();
      Loop({ start: int(0), end: int(12), type: 'int', condition: '<' }, ({ i: k }) => {
        const a = float(k).add(0.5).mul(6.2831853 / 12.0);
        const dir = vec2(cos(a), sin(a)).toVar();
        Loop({ start: int(1), end: int(6), type: 'int', condition: '<' }, ({ i: r }) => {
          const fr = float(r).div(5.0);
          const drop = d.sub(depthAt(p.add(dir.mul(u.uRimUv).mul(fr))));
          const e = smoothstep(u.uEdgeMin, u.uEdgeMin.mul(3.0), drop).mul(float(1.0).sub(fr.mul(fr).mul(0.85))).toVar();
          If(e.greaterThan(best), () => { best.assign(e); outward.assign(dir); });
        });
      });
      const soft = max(u.uFeather, 0.002);
      const win = float(1.0).sub(smoothstep(u.uWindow.mul(0.5), u.uWindow.mul(0.5).add(soft), abs(d.sub(u.uPhase))));
      const valid = smoothstep(u.uLow, u.uLow.add(0.012), d).mul(smoothstep(u.uHigh.sub(0.012), u.uHigh, d).oneMinus());
      const side = mix(float(1.0), smoothstep(-0.25, 0.9, dot(outward, u.uDir)), u.uDirMix);
      const pulse = float(1.0).sub(u.uPulse.mul(float(0.5).sub(sin(u.uTime.mul(3.0)).mul(0.5))));
      const col = mix(u.uColorB, u.uColorA, smoothstep(0.2, 1.0, best));
      const light = best.mul(win).mul(valid).mul(side).mul(inside);
      return vec4(col.mul(light).mul(u.uIntensity).mul(pulse), 1.0);
    })();
    return finish(m, u);
  },
};

/** The full-screen pass `name` (model3dFx.js GLSL key), with its uniform surface. */
export function createPassNodeMaterial(name) {
  const make = PASSES[name];
  if (!make) throw new Error(`model3dFxNodes: no pass "${name}"`);
  return make();
}

/**
 * The view-space normal buffer (gN), packed n·0.5 + 0.5 with coverage in alpha.
 *
 * NOT three's MeshNormalNodeMaterial: on WebGPU that one routes its colour
 * through colorSpaceToWorking(…, SRGBColorSpace) — right for showing normals on
 * a canvas, wrong for a DATA buffer. Measured: the front face of the test text
 * came out (75,184,227) after the tone pass on WebGPU vs (174,215,230) on WebGL,
 * and the rim lit faces that look straight at the camera. outputNode writes the
 * raw value, matching WebGL's MeshNormalMaterial byte for byte in intent.
 */
export function createNormalNodeMaterial() {
  const m = new THREE.MeshBasicNodeMaterial();
  m.outputNode = Fn(() => vec4(normalize(normalView).mul(0.5).add(0.5), 1.0))();
  return m;
}

/**
 * The model-space position buffer (gP). `pos` is model3dFx's shared uniform
 * object; the Matrix4 / Vector3 values are wrapped BY REFERENCE so the writer's
 * in-place updates reach the graph, and the scalar is mirrored by syncPos().
 * outputNode so nothing (lighting, colour space) touches the raw position.
 */
export function createPositionNodeMaterial(pos) {
  const u = {
    uFxRootInv: uniform(pos.uFxRootInv.value),
    uFxCenter: uniform(pos.uFxCenter.value),
    uFxScale: uniform(pos.uFxScale.value),
  };
  const m = new THREE.MeshBasicNodeMaterial();
  m.outputNode = Fn(() => {
    const p = u.uFxRootInv.mul(vec4(positionWorld, 1.0)).xyz.sub(u.uFxCenter).mul(u.uFxScale);
    return vec4(p, 1.0);
  })();
  m.uniforms = u;
  m.syncPos = () => { u.uFxScale.value = pos.uFxScale.value; };
  return m;
}
