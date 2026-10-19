/*
 * TSL twins of silhouetteFraming.js's three passes.
 *
 *   createSilhouetteFramingNodeMaterials() ← createSilhouetteFramingMaterials()
 *     { distH, distV, compose }
 *
 * Same uniform surface (`.uniforms.<name>.value`), so applySilhouetteFramingUniforms
 * drives either. Structural differences from the GLSL, all of them the chroma
 * key pair's: `uv()` replaces gl_FragCoord / uResolution on the fullscreen quad;
 * `uFlipV` is honoured on every read of the ISOLATE (DIST H and COMPOSE's plate),
 * never on the pooled distance targets, which are quad-written; the two array
 * uniforms get the `.value` facade onto `uniformArray.array` that the clip node
 * material uses, so the driver keeps writing `u.uShadowColors.value[i].set(…)`.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Break, uniform, uniformArray, uv, vec2, vec4, float, int,
  mix, clamp, max, min, sqrt, select, smoothstep,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';
import { SF_MAX_TAPS } from './silhouetteFraming.js';

const flipped = (uvn, uFlipV) => vec2(uvn.x, mix(uvn.y, uvn.y.oneMinus(), uFlipV));
const clamped = (p) => clamp(p, 0.0, 1.0);

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

// Tap i → distance in texels: 1..uFine at stride 1, then uFine + k·uStep.
const tapDistance = (i, u) => {
  const fi = float(i);
  return select(fi.lessThan(u.uFine), fi.add(1.0), u.uFine.add(fi.sub(u.uFine).add(1.0).mul(u.uStep)));
};

const commonUniforms = () => ({
  uResolution: uniform(new THREE.Vector2(1280, 720)),
  uTexel: uniform(new THREE.Vector2(1 / 1280, 1 / 720)),
  uRange: uniform(8),
});
const tapUniforms = () => ({ uFine: uniform(8), uStep: uniform(1), uCount: uniform(8) });

/** DIST H: per-row distance to the other class. */
function createDistHNodeMaterial() {
  const u = {
    uTexture: makeTslSampler({ rgba: [0, 0, 0, 0] }),
    uFlipV: uniform(0),
    ...commonUniforms(),
    ...tapUniforms(),
    uAlphaRef: uniform(0.5),
  };
  const insideAt = (p) => select(u.uTexture.sample(flipped(clamped(p), u.uFlipV)).a.greaterThan(u.uAlphaRef), float(1.0), float(0.0));
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = uv();
    const in0 = insideAt(uvn).toVar();
    const found = u.uRange.toVar();
    Loop({ start: int(0), end: int(SF_MAX_TAPS) }, ({ i }) => {
      If(float(i).greaterThanEqual(u.uCount), () => { Break(); });
      const d = tapDistance(i, u).toVar();
      If(d.greaterThanEqual(u.uRange), () => { Break(); });
      const o = vec2(d.mul(u.uTexel.x), 0.0);
      const hit = insideAt(uvn.sub(o)).notEqual(in0).or(insideAt(uvn.add(o)).notEqual(in0));
      If(hit, () => { found.assign(d); Break(); });
    });
    const hIn = select(in0.greaterThan(0.5), float(0.0), found);
    const hOut = select(in0.greaterThan(0.5), found, float(0.0));
    return vec4(hIn.div(u.uRange), hOut.div(u.uRange), in0, 1.0);
  })();
  return finish(material, u);
}

/** DIST V: rows → the Euclidean distance, both ways. */
function createDistVNodeMaterial() {
  const u = {
    uTexture: makeTslSampler({ rgba: [0, 0, 0, 0] }),
    ...commonUniforms(),
    ...tapUniforms(),
  };
  const rowAt = (p) => u.uTexture.sample(clamped(p)).rgb;
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = uv();
    const h0 = rowAt(uvn).toVar();
    const in0 = h0.b.toVar();
    const isIn = in0.greaterThan(0.5);
    const best = select(isIn, h0.g, h0.r).mul(u.uRange).toVar();
    Loop({ start: int(0), end: int(SF_MAX_TAPS) }, ({ i }) => {
      If(float(i).greaterThanEqual(u.uCount), () => { Break(); });
      const d = tapDistance(i, u).toVar();
      If(d.greaterThanEqual(best), () => { Break(); });
      const o = vec2(0.0, d.mul(u.uTexel.y));
      const hu = rowAt(uvn.add(o)).toVar();
      const hd = rowAt(uvn.sub(o)).toVar();
      const h = min(select(isIn, hu.g, hu.r), select(isIn, hd.g, hd.r)).mul(u.uRange);
      best.assign(min(best, sqrt(d.mul(d).add(h.mul(h)))));
    });
    best.assign(min(best, u.uRange));
    const dIn = select(isIn, float(0.0), best);
    const dOut = select(isIn, best, float(0.0));
    return vec4(dIn.div(u.uRange), dOut.div(u.uRange), in0, 1.0);
  })();
  return finish(material, u);
}

/** COMPOSE: the framing block over the premultiplied plate. */
function createComposeNodeMaterial() {
  const uShadowColors = uniformArray([
    new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0),
    new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0),
  ], 'vec4');
  const uShadowParams = uniformArray([
    new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0),
    new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0),
  ], 'vec4');
  const uShadowInset = uniformArray([0, 0, 0, 0], 'float');
  const u = {
    uTexture: makeTslSampler({ rgba: [0, 0, 0, 0] }),
    uSdf: makeTslSampler({ rgba: [0, 0, 0, 0] }),
    uFlipV: uniform(0),
    ...commonUniforms(),
    uOpacity: uniform(1),
    uBorderWidth: uniform(0),
    uBorderStyle: uniform(0),
    uBorderColor: uniform(new THREE.Vector4(1, 1, 1, 1)),
    uShadowCount: uniform(0),
    uShadowColors,
    uShadowParams,
    uShadowInset,
  };
  const sdfAt = (p) => {
    const s = u.uSdf.sample(clamped(p));
    return s.r.sub(s.g).mul(u.uRange);
  };
  const underlay = (top, rgb, a) => top.add(vec4(rgb.mul(a), a).mul(top.a.oneMinus()));
  const overlay = (rgb, a, base) => vec4(rgb.mul(a), a).add(base.mul(a.oneMinus()));

  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = uv();
    const color = u.uTexture.sample(flipped(uvn, u.uFlipV)).toVar();
    const sd = sdfAt(uvn).toVar();
    const aa = float(1.5);
    const bw = u.uBorderWidth;

    If(bw.greaterThan(0.25), () => {
      const ring = smoothstep(aa.negate(), aa, sd.sub(bw)).oneMinus().mul(smoothstep(aa.negate(), aa, sd)).toVar();
      If(u.uBorderStyle.greaterThan(2.5), () => {
        const third = bw.div(3.0);
        const inner = smoothstep(third.sub(aa.mul(0.5)), third.add(aa.mul(0.5)), sd).oneMinus();
        const outer = smoothstep(third.mul(2.0).sub(aa.mul(0.5)), third.mul(2.0).add(aa.mul(0.5)), sd);
        ring.mulAssign(max(inner, outer));
      });
      color.assign(underlay(color, u.uBorderColor.rgb, u.uBorderColor.a.mul(ring).mul(u.uOpacity)));
    });

    Loop({ start: int(0), end: int(4) }, ({ i }) => {
      If(float(i).greaterThanEqual(u.uShadowCount), () => { Break(); });
      If(uShadowInset.element(i).lessThanEqual(0.5), () => {
        const sp = uShadowParams.element(i);
        const ds = sdfAt(uvn.sub(vec2(sp.x, sp.y.negate()).mul(u.uTexel))).sub(bw).sub(sp.w);
        const soft = max(sp.z, 1.0);
        const mask = smoothstep(soft.negate(), soft, ds).oneMinus();
        const sc = uShadowColors.element(i);
        color.assign(underlay(color, sc.rgb, sc.a.mul(mask).mul(u.uOpacity)));
      });
    });

    const cover = clamp(color.a.div(max(u.uOpacity, 1e-3)), 0.0, 1.0).toVar();
    Loop({ start: int(0), end: int(4) }, ({ i }) => {
      If(float(i).greaterThanEqual(u.uShadowCount), () => { Break(); });
      If(uShadowInset.element(i).greaterThan(0.5), () => {
        const sp = uShadowParams.element(i);
        const ds = sdfAt(uvn.sub(vec2(sp.x, sp.y.negate()).mul(u.uTexel))).add(sp.w);
        const soft = max(sp.z, 1.0);
        const mask = smoothstep(soft.negate(), soft, ds).mul(cover);
        const sc = uShadowColors.element(i);
        color.assign(overlay(sc.rgb, sc.a.mul(mask).mul(u.uOpacity), color));
      });
    });

    return color;
  })();
  finish(material, u);
  // The `.value` facade the clip node material gives its array uniforms.
  for (const name of ['uShadowColors', 'uShadowParams', 'uShadowInset']) {
    const node = u[name];
    u[name] = {
      node,
      get value() { return node.array; },
      set value(next) { node.array = next; },
    };
  }
  return material;
}

export function createSilhouetteFramingNodeMaterials() {
  return { distH: createDistHNodeMaterial(), distV: createDistVNodeMaterial(), compose: createComposeNodeMaterial() };
}
