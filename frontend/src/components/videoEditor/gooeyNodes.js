/*
 * TSL twin of gooeyEffect.js — the GLSL is the reference; keep the two in lockstep.
 *
 * Every pass samples at plain `uvn`: the inputs are the chain's quad-written plate and this effect's own pass
 * targets, which sample upright under plain UV on WebGPU. The Gaussian is symmetric and the threshold is per pixel,
 * so nothing here needs a y negation or a Y-up lattice.
 *
 * Every texture read sits in UNIFORM control flow: the tap loop's bound comes from uniforms, and the colour modes
 * are an If over values computed from samples taken before it (WGSL forbids implicit-LOD sampling under
 * non-uniform control flow).
 */
import {
  If, Loop, Break, int, float, vec2, vec3, vec4, clamp, max, min, mix, exp, smoothstep, select,
} from 'three/tsl';

const P = (u, i) => u.uParams.element(i);
const TAP_LOOP = 97;   // = 2 · TAP_CAP + 1 in gooeyEffect.js

const downBody = ({ u, uvn }) => u.uTexture.sample(uvn);

// [24] σ (level texels), [25] tap half-width, [26] axis (0 H, 1 V).
const blurBody = ({ u, uvn }) => {
  const sigma = max(P(u, 24), 1e-3);
  const r = P(u, 25);
  const dir = select(P(u, 26).greaterThan(0.5), vec2(0.0, 1.0), vec2(1.0, 0.0));
  const stepUv = dir.div(u.uResolution);
  const k = float(-0.5).div(sigma.mul(sigma));
  const acc = vec4(0.0).toVar();
  const ws = float(0.0).toVar();
  Loop({ start: int(0), end: int(TAP_LOOP) }, ({ i }) => {
    const x = float(i).sub(r);
    If(x.greaterThan(r), () => { Break(); });
    const w = exp(k.mul(x).mul(x));
    acc.addAssign(u.uTexture.sample(uvn.add(stepUv.mul(x))).mul(w));
    ws.addAssign(w);
  });
  return acc.div(max(ws, 1e-6));
};

// Slots: 1 threshold, 2 softness, 3 colour mode; colour 0 = the fill.
const mainBody = ({ u, uvn }) => {
  const src = u.uTexture.sample(uvn).toVar();
  const b = u.uTexture1.sample(uvn).toVar();
  const th = P(u, 1);
  const soft = P(u, 2);
  const lo = max(th.sub(soft), 0.0);
  const hi = min(th.add(soft), 1.0).add(1e-4);
  const a = smoothstep(lo, hi, b.a).toVar();
  const col = b.rgb.div(max(b.a, 1e-4)).toVar();
  const mode = P(u, 3);
  const fill = vec3(u.uColors.element(0), u.uColors.element(1), u.uColors.element(2));
  If(mode.greaterThan(0.5).and(mode.lessThan(1.5)), () => {
    col.assign(fill);
  }).ElseIf(mode.greaterThan(1.5), () => {
    const sc = src.rgb.div(max(src.a, 1e-4));
    col.assign(mix(col, sc, smoothstep(0.35, 0.95, src.a)));
    a.assign(max(a, src.a));
  });
  return vec4(clamp(col, 0.0, 1.0).mul(a), a);
};

export const GOOEY_PASS_BODIES = {
  ...Object.fromEntries(Array.from({ length: 4 }, (_, k) => [`gooey:down${k + 1}`, downBody])),
  'gooey:blurH': blurBody,
  'gooey:blurV': blurBody,
  'gooey:main': mainBody,
};
