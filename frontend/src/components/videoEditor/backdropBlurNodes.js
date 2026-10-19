/*
 * TSL twins of backdropBlur.js:
 *
 *   createBackdropBlurNodeMaterial()            ← createBackdropBlurMaterial()
 *   createBackdropMixNodeMaterial({ flipMatte }) ← createBackdropMixMaterial()
 *
 * Both sample at screenCoordinate / uResolution, the storage-identity read
 * (PORTING-GUIDE §3.6: a quad's uv() mirrors storage on WebGPU, the fragment
 * coordinate does not; on WebGL both are identity). That is what lets the
 * compositor's camera-axis stack pass through the mix and come out camera-
 * axis, so the layers drawn after it land upright.
 *
 * `flipMatte` is the one provenance switch: the matte is a camera-rendered
 * isolate for a plain shape (same axis as the stack — read plain) but a
 * finished QUAD plate when the shape also carries Layer Effects
 * (renderStyledLayerIsolate normalises its exit) — the opposite V axis, so
 * that binding reads it at (u, 1 − v). Same shape as matteClip / trackMatte:
 * one material per provenance, the driver picks by parity.
 */
import * as THREE from 'three/webgpu';
import {
  uniform, vec3, vec4, float, int, dot, mix, clamp, exp, max as tslMax,
  Fn, If, Loop, Break, screenCoordinate,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';
import { BACKDROP_MAX_HALF_TAPS } from './backdropBlur.js';

const makeSampler = (flip = false) => makeTslSampler({ rgba: [0, 0, 0, 0], flipY: flip });

function finish(material, uniforms) {
  material.depthTest = false;
  material.depthWrite = false;
  material.forceSinglePass = true;
  material.transparent = false;
  material.blending = THREE.NoBlending;
  material.uniforms = uniforms;
  return material;
}

export function createBackdropBlurNodeMaterial() {
  const u = {
    uTexture: makeSampler(),
    uResolution: uniform(new THREE.Vector2(1, 1)),
    uStep: uniform(new THREE.Vector2(0, 0)),
    uSigma: uniform(1),
    uHalfTaps: uniform(0),
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uv = screenCoordinate.xy.div(u.uResolution).toVar();
    const sum = u.uTexture.sample(uv).toVar();
    const wsum = float(1.0).toVar();
    const inv2s2 = float(0.5).div(tslMax(u.uSigma.mul(u.uSigma), 1e-4));
    Loop({ start: int(1), end: int(BACKDROP_MAX_HALF_TAPS + 1), type: 'int' }, ({ i }) => {
      If(float(i).greaterThan(u.uHalfTaps), () => { Break(); });
      const x = float(i);
      const w = exp(x.mul(x).mul(inv2s2).negate());
      const o = u.uStep.mul(x);
      const a = u.uTexture.sample(clamp(uv.add(o), 0.0, 1.0));
      const b = u.uTexture.sample(clamp(uv.sub(o), 0.0, 1.0));
      sum.addAssign(a.add(b).mul(w));
      wsum.addAssign(w.mul(2.0));
    });
    return sum.div(wsum);
  })();
  return finish(material, u);
}

export function createBackdropMixNodeMaterial({ flipMatte = false } = {}) {
  const u = {
    uTexture: makeSampler(),
    uBlur: makeSampler(),
    uMatte: makeSampler(flipMatte),
    uResolution: uniform(new THREE.Vector2(1, 1)),
    uAlphaRef: uniform(1),
    uSaturation: uniform(1),
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uv = screenCoordinate.xy.div(u.uResolution);
    const src = u.uTexture.sample(uv);
    const m = clamp(u.uMatte.sample(uv).a.div(u.uAlphaRef), 0.0, 1.0);
    const b = u.uBlur.sample(uv).toVar();
    const l = dot(b.rgb, vec3(0.2126, 0.7152, 0.0722));
    const rgb = clamp(mix(vec3(l), b.rgb, u.uSaturation), vec3(0.0), vec3(b.a));
    return mix(src, vec4(rgb, b.a), m);
  })();
  return finish(material, u);
}
