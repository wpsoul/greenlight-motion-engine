/*
 * TSL twin of blendComposite.js:
 *
 *   createBlendCompositeNodeMaterial({ flipLayer }) ← createBlendCompositeMaterial()
 *
 * Same maths, same BLEND_MODE_INDEX switch. Both inputs sample at
 * screenCoordinate / uResolution — the storage-identity read (PORTING-GUIDE
 * §3.6) that lets the compositor's camera-axis stack pass through and come out
 * camera-axis, exactly as the Backdrop Blur mix does.
 *
 * `flipLayer` is the one provenance switch, and it mirrors backdropMix's
 * `flipMatte`: the plate is a finished QUAD plate at the top level
 * (renderStyledLayerIsolate normalises its exit) — the opposite V axis from
 * the stack, read at (u, 1 − v) — but a sequence's plain isolate is camera-
 * rendered and reads plain. One material per provenance; the driver picks.
 */
import * as THREE from 'three/webgpu';
import {
  uniform, vec2, vec3, vec4, float, int, dot, mix, clamp, step, abs, sqrt, floor, fract, sin,
  min as tmin, max as tmax, select, Fn, If, screenCoordinate,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';
import { BLEND_MODE_INDEX as M } from './blendModes.js';

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

const LUM_W = vec3(0.3, 0.59, 0.11);
const lum = (c) => dot(c, LUM_W);
const maxC = (c) => tmax(tmax(c.r, c.g), c.b);
const minC = (c) => tmin(tmin(c.r, c.g), c.b);
const clipColor = (cIn) => {
  const c = vec3(cIn).toVar();
  const l = lum(c);
  const n = minC(c);
  const x = maxC(c);
  c.assign(select(n.lessThan(0.0), c.sub(l).mul(l).div(tmax(l.sub(n), 1e-5)).add(l), c));
  c.assign(select(x.greaterThan(1.0), c.sub(l).mul(float(1.0).sub(l)).div(tmax(x.sub(l), 1e-5)).add(l), c));
  return c;
};
const setLum = (c, l) => clipColor(c.add(l.sub(lum(c))));
const sat = (c) => maxC(c).sub(minC(c));
const setSat = (c, s) => {
  const mx = maxC(c);
  const mn = minC(c);
  return select(mx.greaterThan(mn), c.sub(mn).mul(s).div(tmax(mx.sub(mn), 1e-5)), vec3(0.0));
};
const screen = (b, s) => b.add(s).sub(b.mul(s));
const colorDodge = (b, s) => {
  let r = tmin(vec3(1.0), b.div(tmax(float(1.0).sub(s), vec3(1e-5))));
  r = mix(r, vec3(1.0), step(vec3(1.0), s));
  r = mix(r, vec3(0.0), step(b, vec3(0.0)));
  return r;
};
const colorBurn = (b, s) => {
  let r = float(1.0).sub(tmin(vec3(1.0), float(1.0).sub(b).div(tmax(s, vec3(1e-5)))));
  r = mix(r, vec3(0.0), step(s, vec3(0.0)));
  r = mix(r, vec3(1.0), step(vec3(1.0), b));
  return r;
};
const hardLight = (b, s) => {
  const m = step(s, vec3(0.5));
  return mix(screen(b, s.mul(2.0).sub(1.0)), b.mul(2.0).mul(s), m);
};
const softLight = (b, s) => {
  const d = mix(sqrt(b), b.mul(16.0).sub(12.0).mul(b).add(4.0).mul(b), step(b, vec3(0.25)));
  const lo = b.sub(float(1.0).sub(s.mul(2.0)).mul(b).mul(float(1.0).sub(b)));
  const hi = b.add(s.mul(2.0).sub(1.0).mul(d.sub(b)));
  return mix(hi, lo, step(s, vec3(0.5)));
};

/** B(backdrop, source) for `mode` (an int node) — un-premultiplied colours. */
export function blendNode(mode, b, s) {
  const out = vec3(s).toVar();
  const is = (k) => mode.equal(int(k));
  If(is(M.multiply), () => { out.assign(b.mul(s)); })
    .ElseIf(is(M.screen), () => { out.assign(screen(b, s)); })
    .ElseIf(is(M.add), () => { out.assign(tmin(vec3(1.0), b.add(s))); })
    .ElseIf(is(M.lighten), () => { out.assign(tmax(b, s)); })
    .ElseIf(is(M.darken), () => { out.assign(tmin(b, s)); })
    .ElseIf(is(M.overlay), () => { out.assign(hardLight(s, b)); })
    .ElseIf(is(M.softLight), () => { out.assign(softLight(b, s)); })
    .ElseIf(is(M.hardLight), () => { out.assign(hardLight(b, s)); })
    .ElseIf(is(M.colorDodge), () => { out.assign(colorDodge(b, s)); })
    .ElseIf(is(M.colorBurn), () => { out.assign(colorBurn(b, s)); })
    .ElseIf(is(M.linearBurn), () => { out.assign(tmax(vec3(0.0), b.add(s).sub(1.0))); })
    .ElseIf(is(M.vividLight), () => {
      const m = step(s, vec3(0.5));
      out.assign(mix(colorDodge(b, s.mul(2.0).sub(1.0)), colorBurn(b, s.mul(2.0)), m));
    })
    .ElseIf(is(M.linearLight), () => { out.assign(clamp(b.add(s.mul(2.0)).sub(1.0), 0.0, 1.0)); })
    .ElseIf(is(M.pinLight), () => {
      const m = step(s, vec3(0.5));
      out.assign(mix(tmax(b, s.mul(2.0).sub(1.0)), tmin(b, s.mul(2.0)), m));
    })
    .ElseIf(is(M.hardMix), () => { out.assign(step(vec3(1.0), b.add(s))); })
    .ElseIf(is(M.difference), () => { out.assign(abs(b.sub(s))); })
    .ElseIf(is(M.exclusion), () => { out.assign(b.add(s).sub(b.mul(s).mul(2.0))); })
    .ElseIf(is(M.subtract), () => { out.assign(tmax(vec3(0.0), b.sub(s))); })
    .ElseIf(is(M.divide), () => {
      const r = tmin(vec3(1.0), b.div(tmax(s, vec3(1e-5))));
      out.assign(mix(r, vec3(1.0), step(s, vec3(0.0))));
    })
    .ElseIf(is(M.darkerColor), () => { out.assign(select(lum(s).lessThan(lum(b)), s, b)); })
    .ElseIf(is(M.lighterColor), () => { out.assign(select(lum(s).greaterThan(lum(b)), s, b)); })
    .ElseIf(is(M.hue), () => { out.assign(setLum(setSat(s, sat(b)), lum(b))); })
    .ElseIf(is(M.saturation), () => { out.assign(setLum(setSat(b, sat(s)), lum(b))); })
    .ElseIf(is(M.color), () => { out.assign(setLum(s, lum(b))); })
    .ElseIf(is(M.luminosity), () => { out.assign(setLum(b, lum(s))); });
  return out;
}

export function createBlendCompositeNodeMaterial({ flipLayer = false } = {}) {
  const u = {
    uTexture: makeSampler(),
    uLayer: makeSampler(flipLayer),
    uResolution: uniform(new THREE.Vector2(1, 1)),
    uMode: uniform(0),
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const px = screenCoordinate.xy;
    const uv = px.div(u.uResolution);
    const d = u.uTexture.sample(uv);
    const s = vec4(u.uLayer.sample(uv)).toVar();
    const cd = select(d.a.greaterThan(0.0), d.rgb.div(d.a), vec3(0.0)).toVar();
    const cs = select(s.a.greaterThan(0.0), s.rgb.div(s.a), vec3(0.0)).toVar();
    const mode = int(u.uMode).toVar();
    If(mode.equal(int(M.dissolve)), () => {
      const h = fract(sin(dot(floor(px), vec2(12.9898, 78.233))).mul(43758.5453));
      const k = step(h, s.a).mul(step(1e-4, s.a));
      s.assign(vec4(cs.mul(k), k));
      mode.assign(int(M.normal));
    });
    const b = blendNode(mode, cd, cs);
    const rgb = d.rgb.mul(float(1.0).sub(s.a)).add(s.rgb.mul(float(1.0).sub(d.a))).add(b.mul(s.a).mul(d.a));
    const a = s.a.add(d.a.mul(float(1.0).sub(s.a)));
    return vec4(rgb, a);
  })();
  return finish(material, u);
}
