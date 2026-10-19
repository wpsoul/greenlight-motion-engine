/*
 * TSL twin of asciiEffect.js — the GLSL is the reference; keep the two in
 * lockstep.
 *
 * Box maths (fxLocal / fxFrame) ports VERBATIM: both are y-up on both backends
 * in both scopes (an adjustment layer's chain runs on a quad plate too —
 * runEffectChain's WebGPU axis flip), exactly as in the GLSL. The cell and vote targets are written and
 * read in their own plain uvn — a quad-written target samples upright under
 * plain UV — so a cell's texel is found at the same (index + 0.5) / grid on
 * both sides.
 *
 * WGSL forbids implicit-LOD sampling under non-uniform control flow: the tap
 * loops' bounds are uniforms, "inside the box / frame" is a weight rather than
 * a branch, every main-pass read happens before any branch, and the glyph is
 * read with explicit gradients.
 */
import {
  Fn, If, Loop, Break, int, float, vec2, vec3, vec4,
  clamp, max, min, floor, fract, dot, length, atan, select, step, dFdx, dFdy,
} from 'three/tsl';

const luma = Fn(([c]) => dot(c, vec3(0.2126, 0.7152, 0.0722)))
  .setLayout({ name: 'asLuma', type: 'float', inputs: [{ name: 'c', type: 'vec3' }] });
const unpremult = Fn(([c]) => c.rgb.div(max(c.a, 1e-4)))
  .setLayout({ name: 'asUnpremult', type: 'vec3', inputs: [{ name: 'c', type: 'vec4' }] });
const glslMod = Fn(([x, y]) => x.sub(y.mul(floor(x.div(y))))).setLayout({
  name: 'asGlslMod', type: 'float',
  inputs: [{ name: 'x', type: 'float' }, { name: 'y', type: 'float' }],
});
const bayer2 = Fn(([aIn]) => {
  const a = floor(aIn);
  return fract(a.x.div(2.0).add(a.y.mul(a.y).mul(0.75)));
}).setLayout({ name: 'asBayer2', type: 'float', inputs: [{ name: 'aIn', type: 'vec2' }] });
const bayer4 = Fn(([a]) => bayer2(a.mul(0.5)).mul(0.25).add(bayer2(a)))
  .setLayout({ name: 'asBayer4', type: 'float', inputs: [{ name: 'a', type: 'vec2' }] });

const P = (u, i) => u.uParams.element(i);
const S = (u) => vec2(P(u, 22), P(u, 23));
const cellPx = (u) => vec2(P(u, 12), P(u, 13));
const origin = (u) => vec2(P(u, 14), P(u, 15));
const grid = (u) => vec2(P(u, 16), P(u, 17));
const C = (u, i) => vec3(u.uColors.element(i * 3), u.uColors.element(i * 3 + 1), u.uColors.element(i * 3 + 2));

// One cell's average from uTexture, inside the box and the frame only.
const average = (u, uvn, helpers) => {
  const g = grid(u);
  const cp = cellPx(u);
  const nt = P(u, 21);
  const ci = min(floor(uvn.mul(g)), g.sub(1.0));
  const p0 = origin(u).add(ci.mul(cp));
  const acc = vec4(0.0).toVar();
  const cnt = float(0.0).toVar();
  Loop({ start: int(0), end: int(8), name: 'ty' }, ({ ty }) => {
    If(float(ty).greaterThanEqual(nt), () => { Break(); });
    Loop({ start: int(0), end: int(8), name: 'tx' }, ({ tx }) => {
      If(float(tx).greaterThanEqual(nt), () => { Break(); });
      const bu = p0.add(vec2(float(tx), float(ty)).add(0.5).div(nt).mul(cp)).div(S(u));
      const fu = helpers.fxFrame(bu);
      const inside = step(0.0, bu.x).mul(step(0.0, bu.y)).mul(step(bu.x, 1.0)).mul(step(bu.y, 1.0))
        .mul(step(0.0, fu.x)).mul(step(0.0, fu.y)).mul(step(fu.x, 1.0)).mul(step(fu.y, 1.0));
      acc.addAssign(u.uTexture.sample(clamp(fu, 0.0, 1.0)).mul(inside));
      cnt.addAssign(inside);
    });
  });
  return select(cnt.greaterThan(0.0), acc.div(max(cnt, 1.0)), vec4(0.0));
};

const cellsBody = ({ u, uvn, helpers }) => average(u, uvn, helpers);

const votesBody = ({ u, uvn, helpers }) => {
  const a = average(u, uvn, helpers).toVar();
  const m = a.r.toVar();
  const d = float(0.0).toVar();
  If(a.g.greaterThan(m), () => { m.assign(a.g); d.assign(1.0); });
  If(a.b.greaterThan(m), () => { m.assign(a.b); d.assign(2.0); });
  If(a.a.greaterThan(m), () => { m.assign(a.a); d.assign(3.0); });
  return vec4(m, d.mul(0.25), 0.0, 1.0);
};

const sobelBody = ({ u, uvn, helpers }) => {
  const bu = helpers.fxLocal(uvn).toVar();
  const t = vec2(2.0).div(S(u));
  const L = (off) => luma(u.uTexture.sample(clamp(helpers.fxFrame(bu.add(off)), 0.0, 1.0)).rgb);
  const tl = L(vec2(t.x.negate(), t.y));
  const tc = L(vec2(0.0, t.y));
  const tr = L(t);
  const l = L(vec2(t.x.negate(), 0.0));
  const r = L(vec2(t.x, 0.0));
  const bl = L(t.negate());
  const bc = L(vec2(0.0, t.y.negate()));
  const br = L(vec2(t.x, t.y.negate()));
  const gx = tr.add(r.mul(2.0)).add(br).sub(tl.add(l.mul(2.0)).add(bl));
  const gy = tl.add(tc.mul(2.0)).add(tr).sub(bl.add(bc.mul(2.0)).add(br));
  const e = glslMod(atan(gy, gx).add(1.5707963), float(3.1415927));
  const q = glslMod(floor(e.div(0.78539816).add(0.5)), float(4.0));
  const hot = length(vec2(gx, gy)).greaterThanEqual(P(u, 24));
  const vote = select(q.lessThan(0.5), vec4(1.0, 0.0, 0.0, 0.0),
    select(q.lessThan(1.5), vec4(0.0, 1.0, 0.0, 0.0),
      select(q.lessThan(2.5), vec4(0.0, 0.0, 1.0, 0.0), vec4(0.0, 0.0, 0.0, 1.0))));
  return select(hot, vote, vec4(0.0));
};

const mainBody = ({ u, uvn, helpers }) => {
  const src = u.uTexture.sample(uvn);
  const g = grid(u);
  const N = max(P(u, 18), 1.0);
  const gw = P(u, 19);
  const atlasRows = max(P(u, 20), 1.0);
  const cc = helpers.fxLocal(uvn).mul(S(u)).sub(origin(u)).div(cellPx(u)).toVar();
  const cf = floor(cc);
  const ci = clamp(cf, vec2(0.0), g.sub(1.0)).toVar();
  const f = cc.sub(cf);
  const cuv = ci.add(0.5).div(g);
  const cell = u.uTexture1.sample(cuv).toVar();
  const edge = u.uTexture2.sample(cuv).toVar();
  const ddx = dFdx(cc).toVar();
  const ddy = dFdy(cc).toVar();

  const c3 = unpremult(cell).toVar();
  const v = clamp(luma(c3).sub(0.5).mul(P(u, 7).div(100.0)).add(0.5).add(P(u, 8).div(200.0)), 0.0, 1.0).toVar();
  If(P(u, 10).greaterThan(0.5), () => { v.assign(float(1.0).sub(v)); });
  v.mulAssign(clamp(cell.a, 0.0, 1.0));
  const dith = P(u, 9).div(100.0);
  If(dith.greaterThan(0.0).and(v.greaterThan(0.0)), () => {
    v.addAssign(bayer4(ci).sub(0.46875).mul(dith).div(N));
  });
  const gi = clamp(floor(v.mul(N)), 0.0, N.sub(1.0)).toVar();
  If(P(u, 11).greaterThan(0.0).and(edge.r.greaterThan(P(u, 25))).and(cell.a.greaterThan(0.05)), () => {
    gi.assign(N.add(floor(edge.g.mul(4.0).add(0.5))));
  });

  const col = glslMod(gi, float(16.0));
  const row = floor(gi.add(0.5).div(16.0));
  const slotW = gw.add(24.0);
  const atlasW = slotW.mul(16.0);
  const atlasH = atlasRows.mul(88.0);
  const auv = vec2(
    col.mul(slotW).add(12.0).add(f.x.mul(gw)).div(atlasW),
    row.mul(88.0).add(12.0).add(float(1.0).sub(f.y).mul(64.0)).div(atlasH),
  );
  const gdx = vec2(ddx.x.mul(gw).div(atlasW), ddx.y.mul(-64.0).div(atlasH));
  const gdy = vec2(ddy.x.mul(gw).div(atlasW), ddy.y.mul(-64.0).div(atlasH));
  const cov = u.uLUT.sample(auv).grad(gdx, gdy).a;

  const mode = P(u, 3);
  const m = max(max(c3.r, c3.g), c3.b);
  const boosted = c3.add(c3.div(max(m, 1e-3)).sub(c3).mul(P(u, 4).div(100.0)));
  const fg = select(mode.lessThan(0.5), boosted,
    select(mode.lessThan(1.5), C(u, 0), C(u, 0).add(C(u, 1).sub(C(u, 0)).mul(v))));
  const bgMode = P(u, 5);
  const bg = select(bgMode.lessThan(0.5), vec4(C(u, 2), 1.0),
    select(bgMode.lessThan(1.5), vec4(src.rgb.mul(P(u, 6).div(100.0)), src.a), vec4(0.0)));
  return vec4(clamp(fg, 0.0, 1.0), 1.0).mul(cov).add(bg.mul(float(1.0).sub(cov)));
};

export const ASCII_PASS_BODIES = {
  'ascii:cells': cellsBody,
  'ascii:sobel': sobelBody,
  'ascii:votes': votesBody,
  'ascii:main': mainBody,
};
