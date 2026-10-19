/*
 * TSL twin of filmStockEffect.js (the GLSL is the reference; keep the two in
 * lockstep). The stock table is the SAME JS array — the id ladder below is
 * generated from FILM_STOCKS exactly as the GLSL one is, so a stock edited in
 * one place lands on both backends.
 *
 * Every texture read (source + the pyramid sum) happens at the top of the
 * main body, before any branch: WGSL forbids sampling inside non-uniform
 * control flow.
 *
 * The grain lattice is keyed on plain `fxCoord`,
 * exactly like the shipped Film Grain body: the box axes are authored in uvn's
 * own space, so fxCoord already lands on GLSL's cells (measured — fxGeoCoord
 * put the lattice on the mirrored cells and the catalogue reported DIFFERS).
 */
import {
  Fn, If, vec2, vec3, vec4, float, int, uint, ivec2, uvec2,
  mix, clamp, max, min, fract, floor, exp, exp2, sin, cos, pow, length,
  smoothstep, step, dot,
} from 'three/tsl';
import { FILM_STOCKS, FILM_STOCK_SCALARS, FILM_STOCK_COLORS, hexToRgb01 } from './filmStockEffect.js';

const luma = Fn(([c]) => dot(c, vec3(0.2126, 0.7152, 0.0722)))
  .setLayout({ name: 'fsLuma', type: 'float', inputs: [{ name: 'c', type: 'vec3' }] });
const unpremult = Fn(([c]) => c.rgb.div(max(c.a, 1e-4)))
  .setLayout({ name: 'fsUnpremult', type: 'vec3', inputs: [{ name: 'c', type: 'vec4' }] });
const s2l = Fn(([c]) => pow(max(c, 0.0), vec3(2.2)))
  .setLayout({ name: 'fsS2L', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }] });
const l2s = Fn(([c]) => pow(max(c, 0.0), vec3(1.0 / 2.2)))
  .setLayout({ name: 'fsL2S', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }] });

// Integer-lattice hash, uint LCG + xorshift — bit-exact across backends (see
// the GLSL). Swizzle writes are rebuilt as whole-vector assigns; the shift
// amount is a vector because WGSL shifts a vector only by a vector.
const K = uint(1664525);
const hash = Fn(([p]) => {
  const v = uvec2(ivec2(floor(p)).add(int(32768))).toVar();
  v.assign(v.mul(K).add(uint(1013904223)));
  v.assign(uvec2(v.x.add(v.y.mul(K)), v.y));
  v.assign(uvec2(v.x, v.y.add(v.x.mul(K))));
  v.assign(v.bitXor(v.shiftRight(uvec2(uint(16), uint(16)))));
  v.assign(uvec2(v.x.add(v.y.mul(K)), v.y));
  v.assign(uvec2(v.x, v.y.add(v.x.mul(K))));
  v.assign(v.bitXor(v.shiftRight(uvec2(uint(16), uint(16)))));
  return float(v.x.bitXor(v.y)).div(4294967296.0);
}).setLayout({ name: 'fsHash', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });
const knee = Fn(([l, thr]) => {
  const k = max(thr.mul(0.5), 1e-4).toVar();
  const soft = clamp(l.sub(thr).add(k), 0.0, k.mul(2.0)).toVar();
  soft.assign(soft.mul(soft).div(k.mul(4.0)));
  return max(max(soft, l.sub(thr)).div(max(l, 1e-4)), 0.0);
}).setLayout({ name: 'fsKnee', type: 'float', inputs: [{ name: 'l', type: 'float' }, { name: 'thr', type: 'float' }] });

const vnoise = Fn(([p]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  f.assign(f.mul(f).mul(float(3.0).sub(f.mul(2.0))));
  const a = hash(i), b = hash(i.add(vec2(1.0, 0.0))), c = hash(i.add(vec2(0.0, 1.0))), d = hash(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}).setLayout({ name: 'fsVnoise', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

const grain = Fn(([p, seed]) => {
  const s = vec2(seed.mul(17.0).add(3.0), seed.mul(9.0).add(5.0)).toVar();
  const n = vnoise(p.add(s)).add(vnoise(p.mul(1.93).add(s.mul(1.7)).add(31.0)).mul(0.5));
  return n.div(1.5).sub(0.5).mul(2.4);
}).setLayout({ name: 'fsGrain', type: 'float', inputs: [{ name: 'p', type: 'vec2' }, { name: 'seed', type: 'float' }] });

const tanhF = Fn(([x]) => {
  const t = exp(clamp(x, -8.0, 8.0).mul(2.0));
  return t.sub(1.0).div(t.add(1.0));
}).setLayout({ name: 'fsTanh', type: 'float', inputs: [{ name: 'x', type: 'float' }] });

const shoulder = Fn(([d]) => {
  const k = float(0.62);
  const one = float(1.0).sub(k);
  const hi = vec3(k).add(vec3(
    tanhF(d.r.sub(k).div(one)), tanhF(d.g.sub(k).div(one)), tanhF(d.b.sub(k).div(one)),
  ).mul(one));
  return mix(d, hi, step(vec3(k), d));
}).setLayout({ name: 'fsShoulder', type: 'vec3', inputs: [{ name: 'd', type: 'vec3' }] });

// The stock table as an If/ElseIf ladder over toVar() slots — the GLSL ladder's twin.
function stockVars(id) {
  const v = {};
  for (const key of FILM_STOCK_SCALARS) v[key] = float(0.0).toVar();
  for (const key of FILM_STOCK_COLORS) v[key] = vec3(0.0).toVar();
  v.m0 = vec3(0.0).toVar(); v.m1 = vec3(0.0).toVar(); v.m2 = vec3(0.0).toVar();
  const assign = (s) => () => {
    for (const key of FILM_STOCK_SCALARS) v[key].assign(float(s[key]));
    for (const key of FILM_STOCK_COLORS) v[key].assign(vec3(...hexToRgb01(s[key])));
    v.m0.assign(vec3(s.matrix[0], s.matrix[1], s.matrix[2]));
    v.m1.assign(vec3(s.matrix[3], s.matrix[4], s.matrix[5]));
    v.m2.assign(vec3(s.matrix[6], s.matrix[7], s.matrix[8]));
  };
  let chain = null;
  FILM_STOCKS.forEach((s, i) => {
    if (i === 0) chain = If(id.lessThan(0.5), assign(s));
    else if (i === FILM_STOCKS.length - 1) chain.Else(assign(s));
    else chain = chain.ElseIf(id.lessThan(i + 0.5), assign(s));
  });
  return v;
}

const P = (u, i) => u.uParams.element(i);

const brightBody = ({ u, uvn }) => {
  const s = u.uTexture.sample(uvn).toVar();
  const st = clamp(unpremult(s), 0.0, 1.0).toVar();
  const l = luma(st).toVar();
  const lin = s2l(st).toVar();
  return vec4(
    lin.mul(knee(l, P(u, 24))).mul(s.a).mul(0.5),
    luma(lin).mul(knee(l, P(u, 25))).mul(s.a).mul(0.5),
  );
};

const downBody = ({ u, uvn }) => {
  const h = vec2(1.0).div(u.uResolution.mul(2.0)).toVar();
  const s = u.uTexture.sample(uvn).mul(4.0)
    .add(u.uTexture.sample(uvn.add(vec2(h.x.negate(), h.y.negate()))))
    .add(u.uTexture.sample(uvn.add(vec2(h.x, h.y.negate()))))
    .add(u.uTexture.sample(uvn.add(vec2(h.x.negate(), h.y))))
    .add(u.uTexture.sample(uvn.add(h)));
  return s.div(8.0);
};

const upBody = ({ u, uvn }) => {
  const h = vec2(2.0).div(u.uResolution).toVar();
  const s = u.uTexture1.sample(uvn.add(vec2(h.x.mul(-2.0), 0.0)))
    .add(u.uTexture1.sample(uvn.add(vec2(h.x.mul(2.0), 0.0))))
    .add(u.uTexture1.sample(uvn.add(vec2(0.0, h.y.mul(-2.0)))))
    .add(u.uTexture1.sample(uvn.add(vec2(0.0, h.y.mul(2.0)))))
    .add(u.uTexture1.sample(uvn.add(vec2(h.x.negate(), h.y)))
      .add(u.uTexture1.sample(uvn.add(h)))
      .add(u.uTexture1.sample(uvn.add(vec2(h.x.negate(), h.y.negate()))))
      .add(u.uTexture1.sample(uvn.add(vec2(h.x, h.y.negate()))))
      .mul(2.0));
  const gate = vec4(P(u, 24), P(u, 24), P(u, 24), P(u, 25));
  return u.uTexture.sample(uvn).add(s.div(12.0).mul(gate));
};

const mainBody = ({ u, uvn, helpers }) => {
  const S = stockVars(P(u, 0));
  const grainX = P(u, 1).div(100.0), halX = P(u, 2).div(100.0), bloomX = P(u, 3).div(100.0), vigX = P(u, 4).div(100.0);
  const flick = P(u, 5).div(100.0);
  const weave = P(u, 6).div(100.0), leak = P(u, 7).div(100.0).toVar();
  const leakSpeed = P(u, 8).div(100.0).mul(2.0);
  const normB = max(P(u, 24), 1.0), normH = max(P(u, 25), 1.0);
  const T = u.uTime;
  const frame = floor(T.mul(24.0)).toVar();
  const pxScale = u.uResolution.y.div(1080.0).toVar();

  // gate weave
  const wv = vec2(sin(T.mul(1.3)).mul(1.2), cos(T.mul(0.9)).mul(1.6))
    .add(vec2(hash(vec2(frame, 3.0)), hash(vec2(frame, 7.0))).sub(0.5).mul(1.6)).mul(weave).toVar();
  const uv = uvn.add(wv.mul(pxScale).div(u.uResolution)).toVar();

  const src = u.uTexture.sample(uv).toVar();
  const pyr = u.uTexture1.sample(uv).toVar();
  const a = src.a.toVar();
  const st = clamp(unpremult(src), 0.0, 1.0).toVar();

  // exposure, flicker, white balance, dye matrix — linear light, premultiplied
  const fl = float(1.0).add(flick.mul(0.16).mul(
    hash(vec2(frame, 11.0)).sub(0.5).mul(1.4).add(hash(vec2(floor(frame.div(3.0)), 13.0)).sub(0.5).mul(0.6)),
  ));
  const c = s2l(st).mul(exp2(S.exposure)).mul(fl).toVar();
  c.mulAssign(vec3(S.temp.mul(0.16).add(1.0), float(1.0).sub(S.tint.mul(0.10)), float(1.0).sub(S.temp.mul(0.16))));
  c.assign(vec3(dot(S.m0, c), dot(S.m1, c), dot(S.m2, c)).mul(a));

  // emulsion glows — add coverage
  const halC = s2l(S.halCol).mul(pyr.a.mul(2.0).div(normH)).mul(S.halAmt).mul(halX).mul(2.6);
  const bloomC = pyr.rgb.mul(2.0).div(normB).mul(S.bloomAmt).mul(bloomX).mul(2.2);
  const glow = halC.add(bloomC).toVar();
  const outA = clamp(a.add(min(luma(glow), 1.0)), 0.0, 1.0).toVar();
  c.addAssign(glow);

  // light leak
  // smoothstep edges always low < high — Tint (Chromium ≤131, i.e. the
  // packaged Electron) rejects a constant reversed pair and the module dies.
  If(leak.greaterThan(0.001), () => {
    const lt = T.mul(leakSpeed).toVar();
    const lp = vec2(sin(lt.mul(0.37)).mul(0.08).add(0.92), sin(lt.mul(0.23).add(1.0)).mul(0.38).add(0.5));
    const dd = length(uvn.sub(lp).mul(vec2(1.0, 1.5)));
    const lk = float(1.0).sub(smoothstep(0.0, 0.85, dd)).mul(sin(lt.mul(0.9)).mul(0.45).add(0.55)).toVar();
    lk.addAssign(smoothstep(0.72, 1.0, uvn.x).mul(sin(lt.mul(0.5).add(2.0)).mul(0.5).add(0.5)).mul(0.5));
    const lc = mix(vec3(1.0, 0.36, 0.08), vec3(1.0, 0.14, 0.45), sin(lt.mul(0.31)).mul(0.5).add(0.5));
    c.addAssign(lc.mul(lk).mul(leak).mul(0.7).mul(outA));
  });
  c.divAssign(max(outA, 1e-4));

  // the film curve, display space
  const d = l2s(c).toVar();
  d.assign(d.sub(0.45).mul(S.contrast).add(0.45));
  d.assign(clamp(d, 0.0, 1.0));
  d.assign(mix(d, d.mul(d).mul(float(3.0).sub(d.mul(2.0))), S.curve));
  d.assign(mix(d, shoulder(d), S.roll));
  d.assign(S.lift.add(d.mul(float(1.0).sub(S.lift))));

  // split tone, hue only
  const lum = luma(d).toVar();
  const ws = float(1.0).sub(smoothstep(0.0, 0.6, lum));
  const wh = smoothstep(0.4, 1.0, lum);
  d.addAssign(S.shadowCol.sub(luma(S.shadowCol)).mul(ws).mul(S.shadowAmt));
  d.addAssign(S.highCol.sub(luma(S.highCol)).mul(wh).mul(S.highAmt));
  lum.assign(luma(d));
  d.assign(mix(vec3(lum), d, S.sat));

  // lens vignette on the layer's box
  const lp0 = helpers.fxLocal(uvn);
  const dist = length(lp0.sub(0.5).mul(vec2(helpers.fxAspect(), 1.0))).mul(1.2);
  const v = float(1.0).sub(smoothstep(S.vigRad.sub(max(S.vigSoft, 1e-3)), S.vigRad, dist));
  d.mulAssign(mix(float(1.0), v, S.vigAmt.mul(vigX)));

  // grain on a layer-stable lattice (GLSL's bottom-up cells)
  If(S.grainAmt.mul(grainX).greaterThan(0.001), () => {
    const p1080 = floor(helpers.fxCoord(uvn).div(pxScale).mul(8.0).add(0.5)).div(8.0).toVar();
    const gp = p1080.div(max(S.grainSize, 0.5)).toVar();
    const gm = grain(gp, float(1.0));
    const gc = vec3(grain(gp, float(4.0)), grain(gp, float(8.0)), grain(gp, float(12.0)));
    const gn = mix(vec3(gm), gc, S.grainChroma);
    const gw = mix(float(1.0), float(1.0).sub(smoothstep(0.4, 1.0, luma(d))), 0.7);
    d.addAssign(gn.mul(S.grainAmt).mul(grainX).mul(0.3).mul(gw));
  });

  const out = clamp(d, 0.0, 1.0);
  return vec4(out.mul(clamp(outA, 0.0, 1.0)), clamp(outA, 0.0, 1.0));
};

export const FILM_STOCK_PASS_BODIES = {
  'filmStock:bright': brightBody,
  'filmStock:down1': downBody,
  'filmStock:down2': downBody,
  'filmStock:down3': downBody,
  'filmStock:up2': upBody,
  'filmStock:up1': upBody,
  'filmStock:up0': upBody,
  'filmStock:main': mainBody,
};
