/*
 * TSL twin of gradientGlowEffect.js — the GLSL is the reference; keep the two in lockstep.
 *
 * Every pass samples at plain `uvn`: the inputs are the chain's quad-written plate and this effect's own pass
 * targets, which sample upright under plain UV on WebGPU. The blur kernels are symmetric, so no axis needs a y
 * negation, and the ramp is authored in the layer box through fxLocal, which is orientation-normalised on both
 * backends (box-space positions port verbatim). The dither lattice reads `geoUv`, GLSL's y-up gl_FragCoord.
 *
 * Texture reads sit in uniform control flow: loop bounds and branches come from uniforms only.
 */
import {
  Fn, If, Loop, Break, int, uint, float, vec2, vec3, vec4,
  abs, clamp, max, min, mix, exp, fract, floor, ceil, dot, select, sin, cos,
} from 'three/tsl';
import { GRADIENT_GLOW_MAX_LEVEL } from './gradientGlowEffect.js';

const P = (u, i) => u.uParams.element(i);
const C = (u, i) => vec3(u.uColors.element(i * 3), u.uColors.element(i * 3 + 1), u.uColors.element(i * 3 + 2));

const luma = Fn(([c]) => dot(c, vec3(0.2126, 0.7152, 0.0722)))
  .setLayout({ name: 'ggLuma', type: 'float', inputs: [{ name: 'c', type: 'vec3' }] });
// Integer hash of the pixel — bit-exact against the GLSL's ggHashU (u32 arithmetic wraps the same on both).
const hashU = Fn(([pIn]) => {
  const h = uint(max(pIn.x, 0.0)).mul(uint(1973)).add(uint(max(pIn.y, 0.0)).mul(uint(9277))).add(uint(26699)).toVar();
  h.assign(h.bitXor(h.shiftRight(uint(16))).mul(uint(73244475)));
  h.assign(h.bitXor(h.shiftRight(uint(16))).mul(uint(73244475)));
  h.assign(h.bitXor(h.shiftRight(uint(16))));
  return float(h.bitAnd(uint(65535))).div(65535.0);
}).setLayout({ name: 'ggHashU', type: 'float', inputs: [{ name: 'pIn', type: 'vec2' }] });
const cubicW = Fn(([v]) => {
  const n = vec4(1.0, 2.0, 3.0, 4.0).sub(v);
  const s = n.mul(n).mul(n).toVar();
  const x = s.x;
  const y = s.y.sub(s.x.mul(4.0));
  const z = s.z.sub(s.y.mul(4.0)).add(s.x.mul(6.0));
  const w = float(6.0).sub(x).sub(y).sub(z);
  return vec4(x, y, z, w).mul(1.0 / 6.0);
}).setLayout({ name: 'ggCubicW', type: 'vec4', inputs: [{ name: 'v', type: 'float' }] });

// Cubic B-spline in 4 bilinear taps (ts = the texture's size in texels).
const bspline = (tex, uvIn, ts) => {
  const inv = vec2(1.0).div(ts).toVar();
  const c = uvIn.mul(ts).sub(0.5).toVar();
  const f = fract(c).toVar();
  c.subAssign(f);
  const xc = cubicW(f.x).toVar();
  const yc = cubicW(f.y).toVar();
  const s = vec4(xc.x.add(xc.y), xc.z.add(xc.w), yc.x.add(yc.y), yc.z.add(yc.w)).toVar();
  const off = vec4(c.x.sub(0.5), c.x.add(1.5), c.y.sub(0.5), c.y.add(1.5))
    .add(vec4(xc.y, xc.w, yc.y, yc.w).div(s))
    .mul(vec4(inv.x, inv.x, inv.y, inv.y)).toVar();
  const s0 = tex.sample(vec2(off.x, off.z));
  const s1 = tex.sample(vec2(off.y, off.z));
  const s2 = tex.sample(vec2(off.x, off.w));
  const s3 = tex.sample(vec2(off.y, off.w));
  const sx = s.x.div(s.x.add(s.y));
  const sy = s.z.div(s.z.add(s.w));
  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
};

const downBody = ({ u, uvn }) => u.uTexture.sample(uvn);

const blurBody = ({ u, uvn }) => {
  const s = max(P(u, 20), 1e-3).toVar();
  const st = select(P(u, 21).greaterThan(0.5), vec2(0.0, 1.0), vec2(1.0, 0.0)).div(u.uResolution).toVar();
  const r = ceil(s.mul(3.0)).toVar();
  const acc = u.uTexture.sample(uvn).toVar();
  const ws = float(1.0).toVar();
  Loop({ start: int(1), end: int(49) }, ({ i }) => {
    const fi = float(i).toVar();
    If(fi.greaterThan(r), () => { Break(); });
    const w = exp(fi.mul(fi).mul(-0.5).div(s.mul(s))).toVar();
    acc.addAssign(u.uTexture.sample(uvn.add(st.mul(fi))).add(u.uTexture.sample(uvn.sub(st.mul(fi)))).mul(w));
    ws.addAssign(w.mul(2.0));
  });
  return acc.div(ws);
};

const lumBody = ({ u, uvn, helpers }) => {
  const s = u.uTexture.sample(uvn).toVar();
  const A = s.a.toVar();
  const q = helpers.fxLocal(uvn).sub(0.5).mul(u.uFxSizePx).toVar();
  const ang = P(u, 6).mul(Math.PI / 180).toVar();
  const d = vec2(sin(ang), cos(ang)).toVar();
  const len = abs(u.uFxSizePx.x.mul(d.x)).add(abs(u.uFxSizePx.y.mul(d.y)));
  const t = clamp(dot(q, d).div(max(len, 1.0)).add(0.5), 0.0, 1.0);
  const lo = P(u, 7).div(100.0).toVar();
  const hi = P(u, 8).div(100.0).toVar();
  const L = select(P(u, 5).greaterThan(0.5), mix(lo, hi, luma(s.rgb.div(max(A, 1e-4)))), mix(lo, hi, t)).toVar();
  const eb = select(P(u, 20).greaterThan(0.5), u.uTexture1.sample(uvn).a, float(0.0));
  const Ag = clamp(A.add(float(1.0).sub(A).mul(min(P(u, 12).div(100.0).mul(2.0).mul(eb), 1.0))), 0.0, 1.0).toVar();
  const rb = select(P(u, 21).greaterThan(0.5), u.uTexture2.sample(uvn).a, float(1.0));
  const rimA = clamp(A.mul(float(1.0).sub(rb)).mul(P(u, 10).div(100.0)), 0.0, 1.0).toVar();
  const a = Ag.add(rimA.mul(float(1.0).sub(Ag)));
  const lp = L.mul(Ag).mul(float(1.0).sub(rimA)).add(rimA);
  return vec4(vec3(lp), a);
};

const mod4 = (x) => x.sub(floor(x.div(4.0)).mul(4.0));
const stop = (u, i) => {
  const m = mod4(i).toVar();
  return select(m.lessThan(0.5), C(u, 0), select(m.lessThan(1.5), C(u, 1), select(m.lessThan(2.5), C(u, 2), C(u, 3))));
};

const colorBody = ({ u, uvn }) => {
  const I = u.uTexture.sample(uvn).toVar();
  const a = clamp(I.a, 0.0, 1.0).toVar();
  const L = clamp(I.r.div(max(a, 1e-5)), 0.0, 1.0).toVar();
  If(P(u, 21).greaterThan(0.5), () => {
    const B = bspline(u.uTexture1, uvn, vec2(P(u, 22), P(u, 23))).toVar();
    L.assign(clamp(B.r.div(max(B.a, 1e-4)), 0.0, 1.0));
  });
  const x = fract(L.add(P(u, 20))).mul(4.0).toVar();
  const i = floor(x).toVar();
  const f = x.sub(i).toVar();
  const p1 = stop(u, i).toVar();
  const p2 = stop(u, i.add(1.0)).toVar();
  const p0 = stop(u, i.add(3.0)).toVar();
  const p3 = stop(u, i.add(2.0)).toVar();
  const lin = mix(p1, p2, f);
  const f2 = f.mul(f);
  const cr = clamp(p1.mul(2.0)
    .add(p2.sub(p0).mul(f))
    .add(p0.mul(2.0).sub(p1.mul(5.0)).add(p2.mul(4.0)).sub(p3).mul(f2))
    .add(p1.mul(3.0).sub(p0).sub(p2.mul(3.0)).add(p3).mul(f2.mul(f)))
    .mul(0.5), 0.0, 1.0);
  const col = select(P(u, 9).lessThan(0.5), lin, cr);
  return select(a.lessThan(1e-5), vec4(0.0), vec4(col.mul(a), a));
};

const mainBody = ({ u, uvn, geoUv }) => {
  const Cc = u.uTexture.sample(uvn).toVar();
  const out = Cc.toVar();
  If(P(u, 20).greaterThan(0.5), () => {
    const H = bspline(u.uTexture1, uvn, vec2(P(u, 21), P(u, 22))).mul(P(u, 14).div(100.0)).toVar();
    const ha = clamp(H.a, 0.0, 1.0).toVar();
    const hrgb = clamp(H.rgb, vec3(0.0), vec3(ha)).toVar();
    const px = floor(geoUv.mul(u.uResolution)).toVar();
    const nz = hashU(px).add(hashU(px.add(vec2(7919.0, 104729.0)))).sub(1.0).div(255.0)
      .mul(clamp(ha.mul(255.0), 0.0, 1.0)).toVar();
    const ha2 = clamp(ha.add(nz), 0.0, 1.0).toVar();
    const hrgb2 = min(clamp(hrgb.add(vec3(nz)), 0.0, 1.0), vec3(ha2));
    out.assign(Cc.add(vec4(hrgb2, ha2).mul(float(1.0).sub(Cc.a))));
  });
  return out;
};

const levels = (chain) => Array.from({ length: GRADIENT_GLOW_MAX_LEVEL },
  (_, k) => [`gradientGlow:${chain}D${k + 1}`, downBody]);

export const GRADIENT_GLOW_PASS_BODIES = {
  ...Object.fromEntries([...levels('s'), ...levels('l'), ...levels('c')]),
  ...Object.fromEntries(['edge', 'rim', 'soft', 'halo'].flatMap((w) => [
    [`gradientGlow:${w}H`, blurBody], [`gradientGlow:${w}V`, blurBody],
  ])),
  'gradientGlow:lum': lumBody,
  'gradientGlow:color': colorBody,
  'gradientGlow:main': mainBody,
};
