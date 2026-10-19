/*
 * TSL twins of shapeRulersGlsl.js — the ruler geometry shared by the Shape Rulers
 * overlay effect (adjustmentEffectNodes.js) and the Zoom Ruler transition
 * (transitionPackageNodes.js). Expression for expression with the GLSL.
 */
import {
  Fn, If, vec2, float, clamp, abs, max, min, length, floor, select,
} from 'three/tsl';

export const srSdBox = Fn(([p, b, rIn]) => {
  const r = min(rIn, min(b.x, b.y));
  const q = abs(p).sub(b).add(r);
  return length(max(q, 0.0)).add(min(max(q.x, q.y), 0.0)).sub(r);
}).setLayout({
  name: 'srSdBox', type: 'float',
  inputs: [{ name: 'p', type: 'vec2' }, { name: 'b', type: 'vec2' }, { name: 'rIn', type: 'float' }],
});

// GLSL srGuide. `mod` is spelled out: TSL's mod is WGSL `%`, which truncates
// toward zero (the argument is never negative here, but keep the GLSL meaning).
export const srGuide = Fn(([across, along, halfLen, lw, ext, dash]) => {
  const w = clamp(lw.mul(0.5).add(0.5).sub(across), 0.0, 1.0);
  const a = abs(along);
  const seg = clamp(halfLen.add(ext).sub(a).add(0.5), 0.0, 1.0).toVar();
  If(dash.greaterThan(0.5), () => {
    const x = abs(a.sub(halfLen));
    const period = dash.mul(2.0);
    const ph = x.sub(period.mul(floor(x.div(period))));
    seg.mulAssign(clamp(dash.sub(ph).add(0.5), 0.0, 1.0));
  });
  return w.mul(seg);
}).setLayout({
  name: 'srGuide', type: 'float',
  inputs: [
    { name: 'across', type: 'float' }, { name: 'along', type: 'float' }, { name: 'halfLen', type: 'float' },
    { name: 'lw', type: 'float' }, { name: 'ext', type: 'float' }, { name: 'dash', type: 'float' },
  ],
});

// GLSL srMark's if-ladder as a select() ladder: the shapes are a handful of ALU
// each, cheaper than divergent branches, and select() keeps the layout.
export const srMark = Fn(([q, hs, edge, shape, r, t]) => {
  const m = min(hs.x, hs.y);
  const ht = t.mul(0.5);
  const dSquare = srSdBox(q, hs, r);
  const dCircle = length(q.div(hs)).sub(1.0).mul(m);
  const dDiamond = abs(q.x).div(hs.x).add(abs(q.y).div(hs.y)).sub(1.0).mul(hs.x).mul(hs.y).div(length(hs));
  const dSquareOutline = abs(srSdBox(q, hs.sub(ht), max(r.sub(ht), 0.0))).sub(ht);
  const dCircleOutline = abs(dCircle.add(ht)).sub(ht);
  const barH = srSdBox(q, vec2(hs.x, ht), float(0.0));
  const barV = srSdBox(q, vec2(ht, hs.y), float(0.0));
  const dCross = min(barH, barV);
  const bracket = min(
    srSdBox(q.sub(vec2(t.mul(0.25).sub(hs.x), 0.0)), vec2(hs.x.add(t.mul(0.25)), ht), float(0.0)),
    srSdBox(q.sub(vec2(0.0, t.mul(0.25).sub(hs.y))), vec2(ht, hs.y.add(t.mul(0.25))), float(0.0)),
  );
  const dBracket = select(edge.greaterThan(1.5), barH, select(edge.greaterThan(0.5), barV, bracket));
  return select(shape.lessThan(0.5), dSquare,
    select(shape.lessThan(1.5), dCircle,
      select(shape.lessThan(2.5), dDiamond,
        select(shape.lessThan(3.5), dSquareOutline,
          select(shape.lessThan(4.5), dCircleOutline,
            select(shape.lessThan(5.5), dCross, dBracket))))));
}).setLayout({
  name: 'srMark', type: 'float',
  inputs: [
    { name: 'q', type: 'vec2' }, { name: 'hs', type: 'vec2' }, { name: 'edge', type: 'float' },
    { name: 'shape', type: 'float' }, { name: 'r', type: 'float' }, { name: 't', type: 'float' },
  ],
});

/** GLSL srCoverage → vec2(lines, mark). A closure (it branches), called inside a Fn. */
export function srCoverage(q, H, lw, ext, dash, shape, hs, r, t, mid) {
  const lines = max(
    srGuide(abs(abs(q.x).sub(H.x)), q.y, H.y, lw, ext, dash),
    srGuide(abs(abs(q.y).sub(H.y)), q.x, H.x, lw, ext, dash),
  );
  const mark = float(0.0).toVar();
  If(shape.lessThan(6.5), () => {
    const md = srMark(abs(q).sub(H), hs, float(0.0), shape, r, t).toVar();
    If(mid.greaterThan(0.5), () => {
      md.assign(min(md, srMark(vec2(abs(q.x).sub(H.x), q.y), hs, float(1.0), shape, r, t)));
      md.assign(min(md, srMark(vec2(q.x, abs(q.y).sub(H.y)), hs, float(2.0), shape, r, t)));
    });
    mark.assign(clamp(float(0.5).sub(md), 0.0, 1.0));
  });
  return vec2(lines, mark);
}
