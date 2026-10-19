/*
 * TSL twins of chromaKeyLayer.js's three passes.
 *
 *   createChromaKeyNodeMaterials() ← createChromaKeyMaterials()   { key, choke, out }
 *
 * Same uniform surface (`.uniforms.<name>.value`), so applyChromaKeyUniforms
 * drives either. Two things differ from the GLSL, both structural:
 *
 *   `uv()` replaces gl_FragCoord / uResolution — on a fullscreen ortho quad the
 *   interpolated uv is exactly that at every pixel centre (the layer-mask pair).
 *
 *   `uFlipV` on the KEY pass's plate read and on OUT's `uSource`: both read the
 *   camera-rendered isolate, whose V axis runs opposite on WebGPU (the warps'
 *   convention — set per draw from the compositor's provenance flag). CHOKE and
 *   OUT's `uTexture` read quad-written pooled targets and never flip.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, uniform, uv, vec2, vec3, vec4, float, int,
  dot, mix, clamp, abs, max, min, length, sin, cos, sqrt, step, select,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';

const TAU = 6.28318530718;
const GA = 2.39996323;

const ycc = (c) => vec3(
  dot(c, vec3(0.299, 0.587, 0.114)),
  dot(c, vec3(-0.168736, -0.331264, 0.5)),
  dot(c, vec3(0.5, -0.418688, -0.081312)),
);

const flipped = (uvn, uFlipV) => vec2(uvn.x, mix(uvn.y, uvn.y.oneMinus(), uFlipV));

function finish(material, uniforms) {
  material.transparent = true;
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  // ShaderMaterial defaults this to true, every NodeMaterial to false (PORTING-GUIDE §13).
  material.forceSinglePass = true;
  material.uniforms = uniforms;
  return material;
}

/** KEY: premultiplied plate → straight despilled colour + matte. */
function createKeyNodeMaterial() {
  const u = {
    uTexture: makeTslSampler({ rgba: [0, 0, 0, 0] }),
    uFlipV: uniform(0),
    uResolution: uniform(new THREE.Vector2(1280, 720)),
    uKey: uniform(new THREE.Vector3(0.25, 0.7, 0.3)),
    uHue: uniform(new THREE.Matrix3()),
    uHueInv: uniform(new THREE.Matrix3()),
    uMethod: uniform(0),
    uBalance: uniform(0.4),
    uAdapt: uniform(0.4),
    uTol: uniform(0.3),
    uLumaW: uniform(0.5),
    uChromaW: uniform(1.8),
    uGain: uniform(1.15),
    uClipB: uniform(0.08),
    uClipW: uniform(0.7),
    uSpill: uniform(1),
    uSpillBias: uniform(0.3),
    uSpillLuma: uniform(0.7),
    uSpillTintAmt: uniform(0),
    uSpillTint: uniform(new THREE.Vector3(0.8, 0.65, 0.54)),
    uHasHue: uniform(1),
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = uv();
    const s = u.uTexture.sample(flipped(uvn, u.uFlipV));
    const c = select(s.a.greaterThan(1e-4), s.rgb.div(max(s.a, 1e-4)), vec3(0.0)).toVar();
    const yk = ycc(u.uKey).toVar();
    const yc = ycc(c).toVar();
    const sdiff = (col) => {
      const r = u.uHue.mul(col);
      return r.g.sub(mix(max(r.r, r.b), min(r.r, r.b), u.uBalance));
    };
    const scr = float(0.0).toVar();
    If(u.uMethod.lessThan(0.5), () => {
      const sk = max(sdiff(u.uKey), 1e-3);
      const ratio = clamp(yc.x.div(max(yk.x, 1e-3)), 0.35, 1.6);
      const ref = sk.mul(mix(float(1.0), ratio, u.uAdapt));
      scr.assign(sdiff(c).div(ref));
    }).Else(() => {
      const d = yc.sub(yk);
      const lw = select(u.uMethod.lessThan(1.5), float(0.0), select(u.uMethod.lessThan(2.5), float(1.0), u.uLumaW));
      const cw = select(u.uMethod.lessThan(1.5), float(1.0), select(u.uMethod.lessThan(2.5), u.uChromaW, float(1.0)));
      const dist = length(vec3(d.x.mul(lw), d.yz.mul(cw)));
      scr.assign(float(1.0).sub(dist.div(max(u.uTol, 1e-4))));
    });
    const a0 = float(1.0).sub(clamp(scr.mul(u.uGain), 0.0, 1.0));
    const a = clamp(a0.sub(u.uClipB).div(max(u.uClipW.sub(u.uClipB), 1e-3)), 0.0, 1.0);

    const c2 = c.toVar();
    If(u.uHasHue.greaterThan(0.5).and(u.uSpill.greaterThan(0.0)), () => {
      const r0 = u.uHue.mul(c);
      const lim = mix(r0.r.add(r0.b).mul(0.5), max(r0.r, r0.b), u.uSpillBias);
      const sp = max(r0.g.sub(lim), 0.0).mul(u.uSpill);
      const r = vec3(r0.r, r0.g.sub(sp), r0.b);
      const cc = u.uHueInv.mul(r).toVar();
      const ya = ycc(cc).x;
      cc.addAssign(vec3(yc.x.sub(ya).mul(u.uSpillLuma)));
      cc.addAssign(u.uSpillTint.mul(sp).mul(u.uSpillTintAmt));
      c2.assign(clamp(cc, 0.0, 1.0));
    });
    return vec4(c2, a);
  })();
  return finish(material, u);
}

/** CHOKE: min (shrink) / max (grow) of the matte over a 24-tap disc. Straight in, straight out. */
function createChokeNodeMaterial() {
  const u = {
    uTexture: makeTslSampler({ rgba: [0, 0, 0, 0] }),
    uResolution: uniform(new THREE.Vector2(1280, 720)),
    uTexel: uniform(new THREE.Vector2(1 / 1280, 1 / 720)),
    uShrink: uniform(0),
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = uv();
    const s = u.uTexture.sample(uvn);
    const a = s.a.toVar();
    const r = abs(u.uShrink);
    Loop({ start: int(0), end: int(12) }, ({ i }) => {
      const t = float(i).div(12.0).mul(TAU);
      const d = vec2(cos(t), sin(t)).mul(u.uTexel);
      const v1 = u.uTexture.sample(uvn.add(d.mul(r))).a;
      const v2 = u.uTexture.sample(uvn.add(d.mul(r).mul(0.5))).a;
      a.assign(select(u.uShrink.lessThan(0.0), min(a, min(v1, v2)), max(a, max(v1, v2))));
    });
    return vec4(s.rgb, a);
  })();
  return finish(material, u);
}

/** OUT: feather, light wrap, plate coverage, premultiply, views, amount. */
function createOutNodeMaterial() {
  const u = {
    uTexture: makeTslSampler({ rgba: [0, 0, 0, 0] }),
    uSource: makeTslSampler({ rgba: [0, 0, 0, 0] }),
    uFlipV: uniform(0),
    uResolution: uniform(new THREE.Vector2(1280, 720)),
    uTexel: uniform(new THREE.Vector2(1 / 1280, 1 / 720)),
    uFeather: uniform(0),
    uWrapAmt: uniform(0),
    uWrapWidth: uniform(12),
    uWrapColor: uniform(new THREE.Vector3(1, 0.91, 0.79)),
    uView: uniform(0),
    uAmount: uniform(1),
  };
  const blurA = (uvn, rad, n) => {
    const acc = float(0.0).toVar();
    Loop({ start: int(0), end: int(n) }, ({ i }) => {
      const f = float(i).add(0.5).div(n);
      const rr = sqrt(f).mul(rad);
      const t = float(i).mul(GA);
      acc.addAssign(u.uTexture.sample(uvn.add(vec2(cos(t), sin(t)).mul(rr).mul(u.uTexel))).a);
    });
    return acc.div(n);
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = uv();
    const k = u.uTexture.sample(uvn);
    const a = k.a.toVar();
    If(u.uFeather.greaterThan(0.0), () => { a.assign(blurA(uvn, u.uFeather, 24)); });
    const col = k.rgb.toVar();
    If(u.uWrapAmt.greaterThan(0.0), () => {
      const wide = blurA(uvn, u.uWrapWidth, 16);
      const w = clamp(float(1.0).sub(wide).mul(u.uWrapAmt).mul(1.5), 0.0, 1.0).mul(step(0.001, a));
      col.assign(mix(col, u.uWrapColor, w));
    });
    const src = u.uSource.sample(flipped(uvn, u.uFlipV));
    const cov = src.a;
    const fa = a.mul(cov);
    const keyed = vec4(min(clamp(col, 0.0, 1.0).mul(fa), vec3(fa)), fa);
    const st = select(a.lessThanEqual(0.004), float(0.0), select(a.greaterThanEqual(0.996), float(1.0), float(0.5)));
    return select(
      u.uView.lessThan(0.5),
      mix(src, keyed, u.uAmount),
      select(u.uView.lessThan(1.5), vec4(vec3(a).mul(cov), cov), vec4(vec3(st).mul(cov), cov)),
    );
  })();
  return finish(material, u);
}

export function createChromaKeyNodeMaterials() {
  return { key: createKeyNodeMaterial(), choke: createChokeNodeMaterial(), out: createOutNodeMaterial() };
}
