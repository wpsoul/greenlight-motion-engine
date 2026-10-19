// TSL twin of posterizeEffect.js — the same AE Posterize bins, Luminosity SetLum
// and Bayer dither, node for node. The dither lattice reads plain fxCoord, like Film
// Grain and Film Stock: the box axes are authored in uvn's own space, so it already
// lands on GLSL's cells (measured — fxGeoCoord drew the dots mirrored on a layer).
import { vec2, vec3, vec4, float, floor, fract, max, min, clamp, abs, step, mix, dot, select } from 'three/tsl';

const LUM_W = vec3(0.3, 0.59, 0.11);

// GLSL mod(x, 2.0) = x − 2·floor(x / 2): positive for a negative lattice index too.
const mod2 = (x) => x.sub(floor(x.mul(0.5)).mul(2.0));
const bayer2 = (a) => {
  const f = floor(a);
  return fract(mod2(f.x).mul(0.5).add(mod2(f.y).mul(0.75)));
};
const bayer8 = (a) => bayer2(a.mul(0.25)).mul(0.0625).add(bayer2(a.mul(0.5)).mul(0.25)).add(bayer2(a));

// pzLevels: v snapped to its 8-bit code, k = floor(v·L/255 + d), out = round(k·255/(L−1)).
const levels = (c, L, d) => {
  const v = c.mul(255.0).toVar();
  const vr = floor(v.add(0.5));
  v.assign(mix(v, vr, step(abs(v.sub(vr)), vec3(1e-3))));
  const k = max(floor(v.mul(L).div(255.0).add(d).add(1e-4)), vec3(0.0));
  return min(floor(k.mul(255.0).div(L.sub(1.0)).add(0.5 + 1e-4)), vec3(255.0)).div(255.0);
};

// bmSetLum (BLEND_FUNCTIONS_GLSL) in GLSL's evaluation order: l, n and x are taken
// once before either clip, and the second clip sees the first one's result.
const setLum = (cIn, l) => {
  const c = cIn.add(l.sub(dot(cIn, LUM_W))).toVar();
  const cl = dot(c, LUM_W).toVar();
  const n = min(min(c.r, c.g), c.b).toVar();
  const x = max(max(c.r, c.g), c.b).toVar();
  c.assign(select(n.lessThan(0.0), cl.add(c.sub(cl).mul(cl).div(max(cl.sub(n), 1e-5))), c));
  c.assign(select(x.greaterThan(1.0), cl.add(c.sub(cl).mul(float(1.0).sub(cl)).div(max(x.sub(cl), 1e-5))), c));
  return c;
};

export const POSTERIZE_BODIES = {
  posterize: ({ u, uvn, srcCol, helpers }) => {
    const P = u.uParams;
    const a = clamp(srcCol.a, 0.0, 1.0);
    const c = srcCol.rgb.div(max(srcCol.a, 1e-4)).toVar();
    const L = clamp(P.element(0), 2.0, 255.0);
    const amt = clamp(P.element(2).div(100.0), 0.0, 1.0);
    const cell = floor(helpers.fxCoord(uvn).div(max(float(1.0), floor(P.element(3).add(0.5)))));
    const d = select(amt.greaterThan(0.0), bayer8(cell).add(0.0078125 - 0.5).mul(amt), float(0.0));
    const out = select(P.element(1).greaterThan(0.5),
      setLum(c, levels(vec3(dot(c, LUM_W)), L, d).x),
      levels(c, L, d));
    return select(srcCol.a.lessThanEqual(0.0), srcCol, vec4(out.mul(a), a));
  },
};
