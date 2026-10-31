/*
 * TSL twin of deepGlowEffect.js — the GLSL is the reference; keep the two in lockstep.
 *
 * Every pass samples at plain `uvn`: the inputs are the chain's quad-written plate and this effect's own pass
 * targets, which sample upright under plain UV on WebGPU — and `uvn·uResolution` addresses the plate in the same
 * picture orientation as the GLSL's gl_FragCoord, so the glow-space matrix (Angle) is used AS IS. Measured on
 * /video-render (tests/deep-glow/verify_app_render.js): with the y-mirror conjugation the first port applied,
 * Angle +30 turned the glow the opposite way on WebGPU; without it both backends agree. Every kernel (13-tap
 * down, 9-tap Gaussian, B-spline) is symmetric anyway. The dither lattice reads `geoUv`.
 *
 * Texture reads sit in uniform control flow: loop bounds and branches come from uniforms only, and the
 * out-of-frame test is a select() over the sample, never a branch around it. Helpers that sample take the texture
 * node and stay inline (a laid-out Fn must close over nothing but its inputs); the pure ones carry layouts.
 */
import {
  Fn, If, Loop, Break, int, uint, float, vec2, vec3, vec4,
  abs, clamp, max, min, mix, pow, step, exp, fract, floor, ceil, length, dot, select, smoothstep,
} from 'three/tsl';

const P = (u, i) => u.uParams.element(i);
const C = (u, i) => vec3(u.uColors.element(i * 3), u.uColors.element(i * 3 + 1), u.uColors.element(i * 3 + 2));

const luma = Fn(([c]) => dot(c, vec3(0.2126, 0.7152, 0.0722)))
  .setLayout({ name: 'dgLuma', type: 'float', inputs: [{ name: 'c', type: 'vec3' }] });
// Dither noise from an INTEGER hash of the pixel — bit-exact against the GLSL's dgHashU (u32 arithmetic wraps the
// same on both), where a float hash rounds differently per backend.
const hashU = Fn(([pIn]) => {
  const h = uint(max(pIn.x, 0.0)).mul(uint(1973)).add(uint(max(pIn.y, 0.0)).mul(uint(9277))).add(uint(26699)).toVar();
  h.assign(h.bitXor(h.shiftRight(uint(16))).mul(uint(73244475)));
  h.assign(h.bitXor(h.shiftRight(uint(16))).mul(uint(73244475)));
  h.assign(h.bitXor(h.shiftRight(uint(16))));
  return float(h.bitAnd(uint(65535))).div(65535.0);
}).setLayout({ name: 'dgHashU', type: 'float', inputs: [{ name: 'pIn', type: 'vec2' }] });
const unpremult = Fn(([c]) => c.rgb.div(max(c.a, 1e-4)))
  .setLayout({ name: 'dgUnpremult', type: 'vec3', inputs: [{ name: 'c', type: 'vec4' }] });
const toLin = Fn(([cIn]) => {
  const c = clamp(cIn, 0.0, 1.0);
  return mix(c.div(12.92), pow(c.add(0.055).div(1.055), vec3(2.4)), step(vec3(0.04045), c));
}).setLayout({ name: 'dgToLin', type: 'vec3', inputs: [{ name: 'cIn', type: 'vec3' }] });
const toSrgb = Fn(([cIn]) => {
  const c = max(cIn, 0.0);
  return mix(c.mul(12.92), pow(c, vec3(1.0 / 2.4)).mul(1.055).sub(0.055), step(vec3(0.0031308), c));
}).setLayout({ name: 'dgToSrgb', type: 'vec3', inputs: [{ name: 'cIn', type: 'vec3' }] });
const cubicW = Fn(([v]) => {
  const n = vec4(1.0, 2.0, 3.0, 4.0).sub(v);
  const s = n.mul(n).mul(n).toVar();
  const x = s.x;
  const y = s.y.sub(s.x.mul(4.0));
  const z = s.z.sub(s.y.mul(4.0)).add(s.x.mul(6.0));
  const w = float(6.0).sub(x).sub(y).sub(z);
  return vec4(x, y, z, w).mul(1.0 / 6.0);
}).setLayout({ name: 'dgCubicW', type: 'vec4', inputs: [{ name: 'v', type: 'float' }] });
const spectral = Fn(([t]) => clamp(vec3(t.mul(1.3).add(0.2), float(1.0).sub(abs(t).mul(1.2)), float(0.2).sub(t.mul(1.3))), 0.0, 1.0))
  .setLayout({ name: 'dgSpectral', type: 'vec3', inputs: [{ name: 't', type: 'float' }] });

const hable = (x) => {
  const A = 0.15, B = 0.50, Cc = 0.10, D = 0.20, E = 0.02, F = 0.30;
  return x.mul(x.mul(A).add(Cc * B)).add(D * E).div(x.mul(x.mul(A).add(B)).add(D * F)).sub(E / F);
};
const tonemap = Fn(([xIn, m]) => {
  const x = max(xIn, 0.0).toVar();
  const out = min(x, vec3(1.0)).toVar();
  If(m.greaterThanEqual(0.5).and(m.lessThan(1.5)), () => {
    const y = vec3(0.8).add(vec3(1.0).sub(exp(x.sub(0.8).negate().div(0.2))).mul(0.2));
    out.assign(min(mix(x, y, step(vec3(0.8), x)), vec3(1.0)));
  }).ElseIf(m.greaterThanEqual(1.5).and(m.lessThan(2.5)), () => {
    const pk = max(x.r, max(x.g, x.b)).toVar();
    const y = x.div(max(pk, 1e-6)).toVar();
    const hot = y.add(vec3(1.0).sub(y).mul(float(1.0).sub(exp(pk.sub(1.0).negate().mul(1.1)))));
    out.assign(select(pk.lessThanEqual(1.0), x, hot));
  }).ElseIf(m.greaterThanEqual(2.5).and(m.lessThan(3.5)), () => {
    const L = luma(x).toVar();
    const Ld = L.mul(L.div(36.0).add(1.0)).div(L.add(1.0));
    out.assign(min(x.mul(Ld.div(max(L, 1e-5))), vec3(1.0)));
  }).ElseIf(m.greaterThanEqual(3.5).and(m.lessThan(4.5)), () => {
    const y = x.mul(0.8).toVar();
    out.assign(clamp(y.mul(y.mul(2.51).add(0.03)).div(y.mul(y.mul(2.43).add(0.59)).add(0.14)), 0.0, 1.0));
  }).ElseIf(m.greaterThanEqual(4.5), () => {
    out.assign(clamp(hable(x.mul(2.0)).div(hable(vec3(11.2))), 0.0, 1.0));
  });
  return out;
}).setLayout({ name: 'dgTonemap', type: 'vec3', inputs: [{ name: 'xIn', type: 'vec3' }, { name: 'm', type: 'float' }] });

const sampleClamped = (tex, suv) => {
  const inside = suv.x.greaterThanEqual(0.0).and(suv.x.lessThanEqual(1.0))
    .and(suv.y.greaterThanEqual(0.0)).and(suv.y.lessThanEqual(1.0));
  return select(inside, tex.sample(suv), vec4(0.0));
};

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

// 9-tap Gaussian (σ 1.4 texels) as 5 bilinear fetches.
const blur9 = (tex, uvIn, dir) => {
  const d1 = dir.mul(1.3174924);
  const d2 = dir.mul(3.1435410);
  return tex.sample(uvIn).mul(0.2852592)
    .add(tex.sample(uvIn.add(d1)).add(tex.sample(uvIn.sub(d1))).mul(0.3238312))
    .add(tex.sample(uvIn.add(d2)).add(tex.sample(uvIn.sub(d2))).mul(0.0335392));
};

const preBody = ({ u, uvn }) => {
  const res = u.uResolution;
  const g = uvn.mul(res).toVar();
  const c0 = vec2(P(u, 20), P(u, 21)).toVar();
  const c1 = vec2(P(u, 22), P(u, 23)).toVar();
  const d = P(u, 24);
  const frame = vec2(P(u, 26), P(u, 27)).toVar();
  const nx = clamp(ceil(length(c0).mul(d)), 1.0, 8.0).toVar();
  const ny = clamp(ceil(length(c1).mul(d)), 1.0, 8.0).toVar();
  const thr = P(u, 3).div(100.0).toVar();
  const sm = P(u, 4).div(100.0).toVar();
  const mode = P(u, 5).toVar();
  const lin = P(u, 16).greaterThan(0.5);
  const acc = vec4(0.0).toVar();
  Loop({ start: int(0), end: int(8), name: 'dj' }, ({ dj }) => {
    If(float(dj).greaterThanEqual(ny), () => { Break(); });
    Loop({ start: int(0), end: int(8), name: 'di' }, ({ di }) => {
      If(float(di).greaterThanEqual(nx), () => { Break(); });
      const sub = vec2(float(di), float(dj)).add(0.5).div(vec2(nx, ny)).sub(0.5);
      const q = g.add(sub).sub(res.mul(0.5)).mul(d);
      const s = sampleClamped(u.uTexture, c0.mul(q.x).add(c1.mul(q.y)).add(frame.mul(0.5)).div(frame)).toVar();
      const c = unpremult(s).toVar();
      If(lin, () => { c.assign(toLin(c)); });
      const m = select(mode.lessThan(0.5), max(c.r, max(c.g, c.b)), luma(c));
      const w = select(mode.greaterThan(1.5), float(1.0), smoothstep(thr.sub(sm.mul(0.5)), thr.add(sm.mul(0.5)).add(1e-4), m)).toVar();
      acc.addAssign(vec4(c.mul(s.a).mul(w), s.a.mul(w)));
    });
  });
  const gain = P(u, 25);
  return acc.div(nx.mul(ny)).mul(vec4(gain, gain, gain, 1.0));
};

const downBody = ({ u, uvn }) => {
  const ts = vec2(1.0).div(vec2(P(u, 20), P(u, 21))).toVar();
  const c = uvn.mul(u.uResolution).mul(2.0).mul(ts).toVar();
  const t = (x, y) => u.uTexture.sample(c.add(ts.mul(vec2(x, y))));
  return t(0, 0).mul(0.125)
    .add(t(-2, 2).add(t(2, 2)).add(t(-2, -2)).add(t(2, -2)).mul(0.03125))
    .add(t(0, 2).add(t(-2, 0)).add(t(2, 0)).add(t(0, -2)).mul(0.0625))
    .add(t(-1, 1).add(t(1, 1)).add(t(-1, -1)).add(t(1, -1)).mul(0.125));
};

const blurBody = ({ u, uvn }) => blur9(u.uTexture, uvn, vec2(1.0, 0.0).div(u.uResolution));

const upBody = ({ u, uvn }) => {
  const b = blur9(u.uTexture, uvn, vec2(0.0, 1.0).div(u.uResolution)).toVar();
  const v = b.rgb.toVar();
  const L = luma(v).toVar();
  v.assign(mix(vec3(L), v, P(u, 10).div(100.0)));
  const ta = P(u, 8).div(100.0).toVar();
  If(ta.greaterThan(0.0), () => {
    const tint = mix(C(u, 0), C(u, 1), P(u, 23)).toVar();
    If(P(u, 16).greaterThan(0.5), () => { tint.assign(toLin(tint)); });
    const L2 = luma(v).toVar();
    const tv = select(P(u, 9).lessThan(0.5), vec3(L2).mul(tint).div(max(luma(tint), 0.15)), v.mul(tint));
    v.assign(mix(v, tv, ta));
  });
  const w = vec3(P(u, 20), P(u, 21), P(u, 22)).toVar();
  const prevTs = vec2(P(u, 25), P(u, 26)).toVar();
  const prev = bspline(u.uTexture1, uvn.mul(u.uResolution).mul(0.5).div(prevTs), prevTs);
  const r = vec4(max(v, 0.0).mul(w), b.a.mul(w.x.add(w.y).add(w.z)).div(3.0));
  return r.add(prev.mul(select(P(u, 24).greaterThan(0.5), float(1.0), float(0.0))));
};

const glowAt = (u, p) => {
  const res = u.uResolution;
  const ax = vec2(P(u, 20), P(u, 21));
  const ay = vec2(P(u, 22), P(u, 23));
  const q = ax.mul(p.x.sub(res.x.mul(0.5))).add(ay.mul(p.y.sub(res.y.mul(0.5))));
  const size0 = vec2(P(u, 25), P(u, 26));
  const g = q.div(P(u, 24)).add(size0.mul(0.5));
  return bspline(u.uTexture1, g.div(size0), size0).rgb;
};

const mainBody = ({ u, uvn, geoUv }) => {
  const src = u.uTexture.sample(uvn).toVar();
  const res = u.uResolution;
  const p = uvn.mul(res).toVar();
  const ca = P(u, 14).div(100.0).toVar();
  const g = vec3(0.0).toVar();
  If(ca.greaterThan(0.001), () => {
    const dp = p.sub(res.mul(0.5)).toVar();
    const acc = vec3(0.0).toVar();
    const ws = vec3(0.0).toVar();
    for (let k = 0; k < 5; k += 1) {
      const t = k * 0.5 - 1.0;
      const sw = spectral(float(t));
      acc.addAssign(glowAt(u, res.mul(0.5).add(dp.mul(ca.mul(0.045 * t).add(1.0)))).mul(sw));
      ws.addAssign(sw);
    }
    g.assign(acc.div(ws));
  }).Else(() => {
    g.assign(glowAt(u, p));
  });
  const lin = P(u, 16).greaterThan(0.5);
  const tm = P(u, 15);
  const a = src.a.toVar();
  const s = unpremult(src).toVar();
  const L = select(lin, toLin(s), s).toVar();
  const gs = min(g, vec3(1.0));
  const screen = P(u, 17).greaterThan(0.5);
  const cov = tonemap(select(screen, L.add(gs.mul(vec3(1.0).sub(min(L, vec3(1.0))))), L.add(g)), tm).toVar();
  const unc = tonemap(select(screen, gs, g), tm).toVar();
  const ec = select(lin, toSrgb(cov), cov).toVar();
  const eu = select(lin, toSrgb(unc), unc).toVar();
  If(P(u, 18).greaterThan(0.5), () => {
    const px = floor(geoUv.mul(res));
    const nz = hashU(px).add(hashU(px.add(vec2(7919.0, 104729.0)))).sub(1.0).div(255.0)
      .mul(clamp(max(eu.r, max(eu.g, eu.b)).mul(255.0), 0.0, 1.0)).toVar();
    ec.addAssign(nz);
    eu.addAssign(nz);
  });
  ec.assign(clamp(ec, 0.0, 1.0));
  eu.assign(clamp(eu, 0.0, 1.0));
  const outA = clamp(a.add(float(1.0).sub(a).mul(max(eu.r, max(eu.g, eu.b)))), 0.0, 1.0).toVar();
  const rgb = ec.mul(a).add(eu.mul(float(1.0).sub(a)));
  return vec4(min(rgb, vec3(outA)), outA);
};

const LEVELS = 11; // = DEEP_GLOW_MAX_LEVELS
export const DEEP_GLOW_PASS_BODIES = {
  'glow:pre': preBody,
  ...Object.fromEntries(Array.from({ length: LEVELS - 1 }, (_, k) => [`glow:down${k + 1}`, downBody])),
  ...Object.fromEntries(Array.from({ length: LEVELS }, (_, k) => [`glow:blur${k}`, blurBody])),
  ...Object.fromEntries(Array.from({ length: LEVELS }, (_, k) => [`glow:up${k}`, upBody])),
  'glow:main': mainBody,
};
