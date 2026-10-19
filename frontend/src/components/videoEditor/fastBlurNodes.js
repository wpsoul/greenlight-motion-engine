/*
 * TSL twin of fastBlurEffect.js — the GLSL is the reference; keep the two in
 * lockstep. Every pass samples at plain `uvn`: the inputs are the chain's
 * quad-written plate and this effect's own pass targets, which sample upright
 * under plain UV on WebGPU. The blur offsets are symmetric, so no axis needs a
 * y negation.
 *
 * Every texture read sits in UNIFORM control flow: the tap loop's bound comes
 * from uniforms, and the Repeat Edge Pixels choice is a select() over the
 * sample, never a branch around it (WGSL forbids implicit-LOD sampling under
 * non-uniform control flow).
 *
 * Nested loops carry explicit index names — TSL names every loop's first index
 * `i` by default, and an inner `i` would shadow the outer one.
 */
import {
  Fn, If, Loop, Break, int, float, vec2, vec3, vec4,
  clamp, max, min, floor, fract, dot, select,
} from 'three/tsl';

const glslMod = Fn(([x, y]) => x.sub(y.mul(floor(x.div(y))))).setLayout({
  name: 'fbGlslMod', type: 'float',
  inputs: [{ name: 'x', type: 'float' }, { name: 'y', type: 'float' }],
});

const hash21 = Fn(([pIn]) => {
  const p = fract(pIn.mul(vec2(123.34, 456.21))).toVar();
  p.addAssign(dot(p, p.add(45.32)));
  return fract(p.x.mul(p.y));
}).setLayout({ name: 'fbHash21', type: 'float', inputs: [{ name: 'pIn', type: 'vec2' }] });

// CDF of the sum of n uniforms (Irwin–Hall), mirrored above n/2 for precision.
const fbCdf = Fn(([xIn, n]) => {
  const out = float(0.0).toVar();
  If(xIn.greaterThanEqual(n), () => {
    out.assign(1.0);
  }).ElseIf(xIn.greaterThan(0.0), () => {
    const flip = xIn.greaterThan(n.mul(0.5));
    const xx = select(flip, n.sub(xIn), xIn).toVar();
    const fact = float(1.0).toVar();
    Loop({ start: int(2), end: int(6), name: 'fi' }, ({ fi }) => {
      If(float(fi).greaterThan(n.add(0.5)), () => { Break(); });
      fact.mulAssign(float(fi));
    });
    const s = float(0.0).toVar();
    const c = float(1.0).toVar();
    Loop({ start: int(0), end: int(6), name: 'fj' }, ({ fj }) => {
      const j = float(fj);
      If(j.greaterThan(xx).or(j.greaterThan(n.add(0.5))), () => { Break(); });
      const d = xx.sub(j);
      const pw = float(1.0).toVar();
      Loop({ start: int(0), end: int(5), name: 'fk' }, ({ fk }) => {
        If(float(fk).greaterThanEqual(n.sub(0.5)), () => { Break(); });
        pw.mulAssign(d);
      });
      s.addAssign(select(glslMod(j, float(2.0)).lessThan(0.5), c, c.negate()).mul(pw));
      c.mulAssign(n.sub(j).div(j.add(1.0)));
    });
    const F = s.div(fact);
    out.assign(select(flip, float(1.0).sub(F), F));
  });
  return out;
}).setLayout({
  name: 'fbCdf', type: 'float',
  inputs: [{ name: 'xIn', type: 'float' }, { name: 'n', type: 'float' }],
});

const downBody = ({ u, uvn }) => u.uTexture.sample(uvn);

const blurBody = ({ u, uvn }) => {
  const P = u.uParams;
  const wl = max(P.element(24), 1e-3);
  const halfTaps = floor(P.element(25).add(0.5));
  const dir = select(P.element(26).greaterThan(0.5), vec2(0.0, 1.0), vec2(1.0, 0.0));
  const n = P.element(27);
  const repeatEdges = P.element(3).greaterThan(0.5);
  const stepUv = dir.div(u.uResolution);
  const lo = vec2(0.5).div(u.uResolution);
  const hi = vec2(1.0).sub(lo);
  const c0 = n.mul(0.5);
  const acc = vec4(0.0).toVar();
  const ws = float(0.0).toVar();
  Loop({ start: int(0), end: int(193) }, ({ i }) => {
    const k = float(i).sub(halfTaps);
    If(k.greaterThan(halfTaps), () => { Break(); });
    const w = fbCdf(k.add(0.5).div(wl).add(c0), n).sub(fbCdf(k.sub(0.5).div(wl).add(c0), n));
    const suv = uvn.add(stepUv.mul(k));
    const inside = suv.x.greaterThanEqual(0.0).and(suv.x.lessThanEqual(1.0))
      .and(suv.y.greaterThanEqual(0.0)).and(suv.y.lessThanEqual(1.0));
    const s = u.uTexture.sample(select(repeatEdges, clamp(suv, lo, hi), suv));
    acc.addAssign(select(repeatEdges.or(inside), s, vec4(0.0)).mul(w));
    ws.addAssign(w);
  });
  return acc.div(max(ws, 1e-6));
};

const mainBody = ({ u, uvn, geoUv }) => {
  const P = u.uParams;
  const src = u.uTexture.sample(uvn);
  const b0 = u.uTexture1.sample(uvn);
  const b1 = u.uTexture2.sample(uvn);
  const b = mix2(b0, b1, P.element(25)).toVar();
  If(P.element(26).greaterThan(0.5), () => {
    // Lattice from geoUv (gl_FragCoord's y-up order) so both backends dither
    // the same pixels the same way.
    const px = floor(geoUv.mul(u.uResolution));
    const nz = hash21(px).add(hash21(px.add(71.0))).sub(1.0).div(255.0);
    b.assign(vec4(min(clamp(b.rgb.add(nz), 0.0, 1.0), vec3(b.a)), b.a));
  });
  return select(P.element(24).lessThan(0.5), src, b);
};

// mix() spelled out so the blend is exactly GLSL's `b0 + (b1 - b0) * t`.
function mix2(a, b, t) { return a.add(b.sub(a).mul(t)); }

export const FAST_BLUR_PASS_BODIES = {
  ...Object.fromEntries(Array.from({ length: 7 }, (_, k) => [`fastBlur:down${k + 1}`, downBody])),
  'fastBlur:blurHA': blurBody,
  'fastBlur:blurVA': blurBody,
  'fastBlur:blurHB': blurBody,
  'fastBlur:blurVB': blurBody,
  'fastBlur:main': mainBody,
};
