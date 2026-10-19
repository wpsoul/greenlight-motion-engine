/*
 * TSL twin of pixelateEffect.js — the GLSL is the reference; keep the two in
 * lockstep.
 *
 * Both grids port VERBATIM: the Layer grid through fxLocal / fxFrame, the Frame grid
 * as plain plate uvn × size — the chain's plates sample with the same v as the GLSL
 * uv, so Offset Y (+ = down) lands on the same rows. Measured: a y-flipped Frame grid
 * moved Offset Y UP on WebGPU (tests/pixelate/verify_app.mjs). The sub-cell and cell targets are written and read in their own plain uvn (a
 * quad-written target samples upright under plain UV), so a cell's texel is found
 * at the same (index + 0.5) / count on both sides.
 *
 * WGSL forbids implicit-LOD sampling under non-uniform control flow: the tap loops'
 * bounds are uniforms, and every main-pass read happens before a select().
 */
import { Loop, Break, If, int, float, vec2, vec4, clamp, max, min, floor, select } from 'three/tsl';

const P = (u, i) => u.uParams.element(i);
const V = (u, i) => vec2(P(u, i), P(u, i + 1));
const isFrame = (u) => P(u, 6).greaterThan(0.5);

// Grid px (y up) <-> plate uvn.
const toUv = (u, helpers, g) => {
  const S = V(u, 8);
  return select(isFrame(u), g.div(S), helpers.fxFrame(g.div(S)));
};
const toGrid = (u, helpers, uvn) => {
  const S = V(u, 8);
  return select(isFrame(u), uvn.mul(S), helpers.fxLocal(uvn).mul(S));
};
// The cell's sampled span: clipped to the box on a Layer grid.
const span = (u, c) => {
  const lo = V(u, 12).add(c.mul(V(u, 10)));
  const hi = lo.add(V(u, 10));
  return {
    lo: select(isFrame(u), lo, max(lo, vec2(0.0))),
    hi: select(isFrame(u), hi, min(hi, V(u, 8))),
  };
};

const subBody = ({ u, uvn, helpers }) => {
  const sub = V(u, 18);
  const ij = floor(uvn.mul(V(u, 16)).mul(sub));
  const cell = floor(ij.add(0.5).div(sub));
  const s = ij.sub(cell.mul(sub));
  const { lo, hi } = span(u, V(u, 14).add(cell));
  const step = hi.sub(lo).div(sub).toVar();
  const base = lo.add(s.mul(step)).toVar();
  const nt = V(u, 20);
  const acc = vec4(0.0).toVar();
  Loop({ start: int(0), end: int(8), name: 'ty' }, ({ ty }) => {
    If(float(ty).greaterThanEqual(nt.y), () => { Break(); });
    Loop({ start: int(0), end: int(8), name: 'tx' }, ({ tx }) => {
      If(float(tx).greaterThanEqual(nt.x), () => { Break(); });
      const g = base.add(vec2(float(tx), float(ty)).add(0.5).div(nt).mul(step));
      acc.addAssign(u.uTexture.sample(clamp(toUv(u, helpers, g), 0.0, 1.0)));
    });
  });
  return acc.div(nt.x.mul(nt.y));
};

const cellsBody = ({ u, uvn }) => {
  const sub = V(u, 18);
  const count = V(u, 16);
  const size = count.mul(sub);
  const first = floor(uvn.mul(count)).mul(sub).toVar();
  const acc = vec4(0.0).toVar();
  Loop({ start: int(0), end: int(16), name: 'sy' }, ({ sy }) => {
    If(float(sy).greaterThanEqual(sub.y), () => { Break(); });
    Loop({ start: int(0), end: int(16), name: 'sx' }, ({ sx }) => {
      If(float(sx).greaterThanEqual(sub.x), () => { Break(); });
      acc.addAssign(u.uTexture.sample(first.add(vec2(float(sx), float(sy))).add(0.5).div(size)));
    });
  });
  return acc.div(sub.x.mul(sub.y));
};

const mainBody = ({ u, uvn, helpers }) => {
  const src = u.uTexture.sample(uvn).toVar();
  const S = V(u, 8);
  const count = V(u, 16);
  const at = (q) => {
    const g = toGrid(u, helpers, q).toVar();
    const c = floor(g.sub(V(u, 12)).div(V(u, 10))).toVar();
    const k = c.sub(V(u, 14)).toVar();
    const avg = u.uTexture1.sample(clamp(k, vec2(0.0), count.sub(1.0)).add(0.5).div(count));
    const { lo, hi } = span(u, c);
    const ctr = u.uTexture.sample(clamp(toUv(u, helpers, lo.add(hi).mul(0.5)), 0.0, 1.0));
    const inBox = isFrame(u).or(g.x.greaterThanEqual(0.0).and(g.y.greaterThanEqual(0.0))
      .and(g.x.lessThan(S.x)).and(g.y.lessThan(S.y)));
    const inGrid = k.x.greaterThanEqual(0.0).and(k.y.greaterThanEqual(0.0))
      .and(k.x.lessThan(count.x)).and(k.y.lessThan(count.y));
    return select(inBox.and(inGrid), select(P(u, 2).greaterThan(0.5), ctr, avg), src);
  };
  const h = vec2(0.25).div(u.uResolution);
  return at(uvn.sub(h))
    .add(at(uvn.add(vec2(h.x, h.y.negate()))))
    .add(at(uvn.add(vec2(h.x.negate(), h.y))))
    .add(at(uvn.add(h)))
    .mul(0.25);
};

export const PIXELATE_PASS_BODIES = {
  'pixelate:sub': subBody,
  'pixelate:cells': cellsBody,
  'pixelate:main': mainBody,
};
