/*
 * TSL twin of lightSweepEffect.js — the same beam, falloff curves, edge ray and reception
 * modes, node for node. All box maths sits on fxLocal (y-up on both backends in both scopes)
 * and fxDir (the same box-to-plate step), so it ports verbatim. Slot 24 = the sweep's
 * progress, written per frame on the CPU (LIGHT_SWEEP_EFFECT.frameUniforms).
 */
import { If, Loop, vec2, vec4, float, clamp, max, abs, dot, mix, select, sin, cos, radians } from 'three/tsl';

export const LIGHT_SWEEP_BODIES = {
  lightSweep: ({ u, uvn, srcCol, helpers }) => {
    const P = u.uParams;
    const inUnit = (p) => p.x.greaterThanEqual(0.0).and(p.x.lessThanEqual(1.0))
      .and(p.y.greaterThanEqual(0.0)).and(p.y.lessThanEqual(1.0));
    const base = srcCol;
    const sc = max(u.uResolution.y.div(1080.0), 1e-4);
    const box = helpers.fxRes().div(sc).toVar();
    const l = helpers.fxLocal(uvn);
    const pt = vec2(l.x, float(1.0).sub(l.y)).mul(box);
    const th = radians(P.element(2));
    const axis = vec2(sin(th), cos(th).negate());
    const across = vec2(cos(th), sin(th));
    const W = max(P.element(4), 0.5);
    const span = abs(across.x).mul(box.x).add(abs(across.y).mul(box.y));
    const reach = span.mul(0.5).add(W.mul(2.0)).add(2.0);
    const dSweep = dot(pt.sub(box.mul(0.5)), across).sub(mix(reach.negate(), reach, P.element(24)));
    const dManual = dot(pt.sub(vec2(P.element(0), P.element(1)).mul(box)), across);
    const d = select(P.element(9).greaterThan(0.5), dSweep, dManual);
    const t = clamp(abs(d).div(W.mul(2.0)), 0.0, 1.0);
    const uu = float(1.0).sub(t);
    const shape = P.element(3);
    const beam = select(shape.lessThan(0.5), uu,
      select(shape.lessThan(1.5), uu.mul(uu).mul(t.mul(2.0).add(1.0)), uu.mul(uu))).toVar();
    const light = beam.mul(P.element(5)).div(100.0).toVar();
    const edgeT = max(P.element(7), 0.0);
    If(P.element(6).greaterThan(0.0).and(edgeT.greaterThan(0.0)).and(beam.greaterThan(0.0)).and(base.a.greaterThan(0.0)), () => {
      const stepUv = helpers.fxDir(vec2(axis.x.div(box.x), axis.y.negate().div(box.y))).mul(edgeT.mul(2.0)).toVar();
      const inside = float(0.0).toVar();
      // lswTap: off the plate but still inside the box the layer goes on, so it counts as this pixel's alpha.
      Loop({ start: 1, end: 13, type: 'int' }, ({ i }) => {
        const q = uvn.add(stepUv.mul(float(i).div(12.0))).toVar();
        inside.addAssign(select(inUnit(q), u.uTexture.sample(q).a,
          select(inUnit(helpers.fxLocal(q)), base.a, float(0.0))));
      });
      light.addAssign(float(1.0).sub(inside.div(12.0)).mul(beam).mul(P.element(6)).div(100.0).mul(2.0));
    });
    const s = base.rgb.div(max(base.a, 1e-4));
    const rec = P.element(8);
    const add = vec4(clamp(s.add(u.uColor.mul(light)), 0.0, 1.0).mul(base.a), base.a);
    const comp = vec4(mix(s, u.uColor, clamp(light, 0.0, 1.0)).mul(base.a), base.a);
    const ca = base.a.mul(clamp(light, 0.0, 1.0));
    const cut = vec4(u.uColor.mul(ca), ca);
    return select(rec.lessThan(0.5), add, select(rec.lessThan(1.5), comp, cut));
  },
};
