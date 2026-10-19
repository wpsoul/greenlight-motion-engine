/*
 * TSL twin of gridLinesEffect.js — the GLSL is the reference; keep the two in
 * lockstep. All box-pixel maths on fxLocal, which is y-up on both backends in
 * both scopes (runEffectChain's WebGPU axis flip), so it ports verbatim.
 * fwidth() is a sum of absolute derivatives, so the screen y direction does not
 * matter to the footprint.
 */
import {
  Fn, float, vec2, vec3, vec4, clamp, max, min, floor, fract, abs, sin, cos, radians, select, fwidth,
} from 'three/tsl';

const glslMod = Fn(([x, y]) => x.sub(y.mul(floor(x.div(y))))).setLayout({
  name: 'glGlslMod', type: 'float',
  inputs: [{ name: 'x', type: 'float' }, { name: 'y', type: 'float' }],
});

// Overlap of the line [-w/2, w/2] with a pixel footprint of width f at
// distance d from the line's centre, as coverage.
const cover = Fn(([d, w, f]) => {
  const h = w.mul(0.5);
  const lo = max(h.negate(), d.sub(f.mul(0.5)));
  const hi = min(h, d.add(f.mul(0.5)));
  return clamp(hi.sub(lo).div(f), 0.0, 1.0);
}).setLayout({
  name: 'glCover', type: 'float',
  inputs: [{ name: 'd', type: 'float' }, { name: 'w', type: 'float' }, { name: 'f', type: 'float' }],
});

export const GRID_LINES_BODIES = {
  gridLines: ({ u, uvn, srcCol, helpers }) => {
    const P = u.uParams;
    const Sz = helpers.fxRes();
    const ref = Sz.y.div(1080.0);
    const cell = max(P.element(0), 1.0).mul(ref);
    const width = max(P.element(1), 0.0).mul(ref);
    const rot = radians(P.element(2));
    const lines = P.element(3);
    const lp = helpers.fxLocal(uvn);
    const pd = vec2(lp.x, float(1.0).sub(lp.y)).mul(Sz);
    const half = Sz.mul(0.5);
    const rm = glslMod(P.element(2), float(90.0));
    const snap = u.uFxLayer.lessThan(0.5).and(rm.lessThan(1e-3).or(rm.greaterThan(90.0 - 1e-3)));
    const odd = glslMod(floor(width.add(0.5)), float(2.0)).greaterThan(0.5);
    const snapped = select(odd, floor(half).add(0.5), floor(half.add(0.5)));
    const c = select(snap, snapped, half).add(vec2(P.element(4), P.element(5)).mul(ref));
    const q0 = pd.sub(c);
    const cs = cos(rot);
    const sn = sin(rot);
    const q = vec2(cs.mul(q0.x).add(sn.mul(q0.y)), sn.negate().mul(q0.x).add(cs.mul(q0.y))).toVar();
    const fw = max(fwidth(q), vec2(1e-4));
    const d = abs(fract(q.div(cell).add(0.5)).sub(0.5)).mul(cell);
    const cx = select(lines.greaterThan(1.5), float(0.0), cover(d.x, width, fw.x));
    const cy = select(lines.greaterThan(0.5).and(lines.lessThan(1.5)), float(0.0), cover(d.y, width, fw.y));
    const cov = float(1.0).sub(float(1.0).sub(cx).mul(float(1.0).sub(cy)));
    const a = select(u.uFxLayer.greaterThan(0.5), srcCol.a, float(1.0));
    return srcCol.mul(float(1.0).sub(cov)).add(vec4(vec3(u.uColor).mul(a), a).mul(cov));
  },
};
