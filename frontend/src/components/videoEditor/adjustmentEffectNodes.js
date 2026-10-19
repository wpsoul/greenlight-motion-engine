/*
 * TSL twins of adjustmentEffects.js's effect materials — matrix rows 08a
 * (single-pass) and 08b (RT / multi-pass), ported family by family.
 *
 * The app's architecture survives intact: one shared PRELUDE of helpers, a
 * per-effect `fx(uv)` body, and one of three mains that crossfade src↔fx by
 * uMix. Only the GLSL bodies move; the registry itself (ADJUSTMENT_EFFECTS, its
 * params, the CPU curve/LUT bakers, applyEffectUniforms) is renderer-agnostic
 * data and is imported, not duplicated.
 *
 * The uniform surface matches freshUniforms() exactly — `.uniforms.<name>.value`
 * — so applyEffectUniforms drives these materials with no changes. Two array
 * uniforms need an accessor object rather than the node itself, for the reason
 * PORTING-GUIDE §2 gives: a UniformArrayNode keeps its DATA on `.array` and uses
 * `.value` for the packed buffer it uploads.
 *
 * UV IS NOT `uv()` HERE. The GLSL derives it from `gl_FragCoord.xy/uResolution`.
 * On WebGPU, texture sampling uses plain `screenCoordinate` (`uvn`); noise /
 * cell lattices that must match GLSL's Y-up axis use `fxGeoCoord` / `geoUv`
 * (dual UV — a global flip was measured to MIRRORED many layers).
 */
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Break, int, pow, sqrt, tan, atan, uniform, uniformArray, texture, screenCoordinate, screenSize,
  vec2, vec3, vec4, float, mat2, dot, cross, mix, clamp, smoothstep, abs, max, min,
  length, distance, floor, fract, mod, exp, sin, cos, asin, sign, radians, normalize, step, select, array,
} from 'three/tsl';
import * as TSL from 'three/tsl';
import { compileUserTsl } from './tslUserShader.js';
import { makeTslSampler } from './tslSampler.js';
import { EXTRA_PASS_BODIES, BLUR_PASS_KEYS, fastCameraWiggleBody } from './adjustmentPassBodies.js';
import { DOUBLE_EXPOSURE_PASS_BODIES } from './doubleExposureNodes.js';
import { FILM_STOCK_PASS_BODIES } from './filmStockNodes.js';
import { OBJECT_EFFECT_BODIES } from './objectEffectNodes.js';
import { FAST_BLUR_PASS_BODIES } from './fastBlurNodes.js';
import { RADIAL_FAST_BLUR_PASS_BODIES } from './radialFastBlurNodes.js';
import { ASCII_PASS_BODIES } from './asciiNodes.js';
import { PIXELATE_PASS_BODIES } from './pixelateNodes.js';
import { POSTERIZE_BODIES } from './posterizeNodes.js';
import { STRIP_BODIES } from './stripNodes.js';
import { GRID_LINES_BODIES } from './gridLinesNodes.js';
import { srCoverage } from './shapeRulersNodes.js';

const PARAM_SLOTS = 28;
const COLOR_SLOTS = 5;

// ── The prelude, in nodes ───────────────────────────────────────────────────
// Pure functions of their parameters keep a layout; anything that reads a
// uniform must NOT have one (PORTING-GUIDE §2), which is why the fx* box helpers
// below are plain JS closures over the uniform set.

const luma = Fn(([c]) => dot(c, vec3(0.2126, 0.7152, 0.0722)))
  .setLayout({ name: 'fxLuma', type: 'float', inputs: [{ name: 'c', type: 'vec3' }] });

const hash21 = Fn(([pIn]) => {
  const p = fract(pIn.mul(vec2(123.34, 456.21))).toVar();
  p.addAssign(dot(p, p.add(45.32)));
  return fract(p.x.mul(p.y));
}).setLayout({ name: 'fxHash21', type: 'float', inputs: [{ name: 'pIn', type: 'vec2' }] });

const unpremult = Fn(([c]) => c.rgb.div(max(c.a, 1e-4)))
  .setLayout({ name: 'fxUnpremult', type: 'vec3', inputs: [{ name: 'c', type: 'vec4' }] });

const premult = Fn(([c, a]) => vec4(c.mul(clamp(a, 0.0, 1.0)), clamp(a, 0.0, 1.0)))
  .setLayout({
    name: 'fxPremult', type: 'vec4',
    inputs: [{ name: 'c', type: 'vec3' }, { name: 'a', type: 'float' }],
  });

const rot2 = Fn(([a]) => {
  const c = cos(a);
  const s = sin(a);
  return mat2(c, s.negate(), s, c);
}).setLayout({ name: 'fxRot2', type: 'mat2', inputs: [{ name: 'a', type: 'float' }] });

// GLSL `mod(x, y)` is x - y*floor(x/y). TSL `mod()` is the `%` operator, which
// on WGSL truncates toward zero — a DIFFERENT result for negative x, which is
// exactly the case the path effects hit when the lit window wraps past sample 0.
const glslMod = Fn(([x, y]) => x.sub(y.mul(floor(x.div(y))))).setLayout({
  name: 'fxGlslMod', type: 'float',
  inputs: [{ name: 'x', type: 'float' }, { name: 'y', type: 'float' }],
});

// GLSL projects commonly reverse smoothstep's edges to get a descending ramp.
// WGSL requires low < high, and Metal rejects a pipeline when it can prove the
// constants are reversed. Preserve the GLSL curve by reversing the result, not
// the edges. Keep this helper for every literal descending ramp in a node body.
const inverseSmoothstep = (low, high, x) => float(1.0).sub(smoothstep(low, high, x));

// Lines Draw's widthCallback: taper both ends toward 0.12 over the edge
// fraction. Pure in (t, e), so it gets a real layout.
const ldTaperW = Fn(([t, e]) => {
  const w = float(1.0).toVar();
  If(t.lessThan(e), () => { w.assign(mix(0.12, 1.0, t.div(e))); });
  If(t.greaterThan(float(1.0).sub(e)), () => {
    w.assign(min(w, mix(0.12, 1.0, float(1.0).sub(t).div(e))));
  });
  return w;
}).setLayout({
  name: 'fxLdTaperW', type: 'float',
  inputs: [{ name: 't', type: 'float' }, { name: 'e', type: 'float' }],
});

const hueShift = Fn(([col, a]) => {
  const k = vec3(0.57735);
  const c = cos(a);
  return col.mul(c).add(cross(k, col).mul(sin(a))).add(k.mul(dot(k, col)).mul(float(1.0).sub(c)));
}).setLayout({
  name: 'fxHueShift', type: 'vec3',
  inputs: [{ name: 'col', type: 'vec3' }, { name: 'a', type: 'float' }],
});

// waveRipple's own value noise + 3-octave fbm. Pure functions of their
// parameters, so these keep their layouts.
const wrNoise = Fn(([pIn]) => {
  const i = floor(pIn);
  const f0 = fract(pIn);
  const f = f0.mul(f0).mul(float(3.0).sub(f0.mul(2.0)));
  const a = hash21(i);
  const b = hash21(i.add(vec2(1.0, 0.0)));
  const c = hash21(i.add(vec2(0.0, 1.0)));
  const d = hash21(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}).setLayout({ name: 'wrNoise', type: 'float', inputs: [{ name: 'pIn', type: 'vec2' }] });

const wrFbm = Fn(([pIn]) => {
  const p = pIn.toVar();
  const v = float(0.0).toVar();
  const a = float(0.5).toVar();
  // Unrolled in JS with node-carried accumulators, so the octaves fold at f32
  // exactly as the GLSL loop does.
  for (let i = 0; i < 3; i += 1) {
    v.addAssign(a.mul(wrNoise(p)));
    p.mulAssign(2.03);
    a.mulAssign(0.5);
  }
  return v;
}).setLayout({ name: 'wrFbm', type: 'float', inputs: [{ name: 'pIn', type: 'vec2' }] });

/*
 * fractalNoise's 4D Perlin gradient noise, fold, recentre and octave sum. Every
 * uniform the GLSL reads through uParams arrives here as an ARGUMENT, so each
 * function keeps a layout and the four fbm calls in the body (one field, three
 * lighting taps) compile to one WGSL function instead of inlining the octave
 * loop four times. Constants match the lab's measured fits exactly.
 */
const fnHash44 = Fn(([pIn]) => {
  const p = fract(pIn.mul(vec4(0.1031, 0.1030, 0.0973, 0.1099))).toVar();
  p.addAssign(dot(p, p.wzxy.add(33.33)));
  return fract(p.xxyz.add(p.yzzw).mul(p.zywx));
}).setLayout({ name: 'fnHash44', type: 'vec4', inputs: [{ name: 'pIn', type: 'vec4' }] });

const fnCorner = Fn(([i, f, c]) => {
  const g = normalize(fnHash44(i.add(c)).mul(2.0).sub(1.0).add(1e-4));
  return dot(g, f.sub(c));
}).setLayout({
  name: 'fnCorner', type: 'float',
  inputs: [{ name: 'i', type: 'vec4' }, { name: 'f', type: 'vec4' }, { name: 'c', type: 'vec4' }],
});

const fnNoise = Fn(([pIn]) => {
  const i = floor(pIn);
  const f = fract(pIn);
  const u = f.mul(f).mul(f).mul(f.mul(f.mul(6.0).sub(15.0)).add(10.0));
  const cn = (x, y, z, w) => fnCorner(i, f, vec4(x, y, z, w));
  const x00 = mix(mix(cn(0, 0, 0, 0), cn(1, 0, 0, 0), u.x), mix(cn(0, 1, 0, 0), cn(1, 1, 0, 0), u.x), u.y);
  const x01 = mix(mix(cn(0, 0, 1, 0), cn(1, 0, 1, 0), u.x), mix(cn(0, 1, 1, 0), cn(1, 1, 1, 0), u.x), u.y);
  const x10 = mix(mix(cn(0, 0, 0, 1), cn(1, 0, 0, 1), u.x), mix(cn(0, 1, 0, 1), cn(1, 1, 0, 1), u.x), u.y);
  const x11 = mix(mix(cn(0, 0, 1, 1), cn(1, 0, 1, 1), u.x), mix(cn(0, 1, 1, 1), cn(1, 1, 1, 1), u.x), u.y);
  return mix(mix(x00, x01, u.z), mix(x10, x11, u.z), u.w).mul(1.75);
}).setLayout({ name: 'fnNoise', type: 'float', inputs: [{ name: 'pIn', type: 'vec4' }] });

const fnFold = Fn(([n, s]) => sqrt(n.mul(n).add(s.mul(s))).sub(s).div(sqrt(s.mul(s).add(1.0)).sub(s)))
  .setLayout({ name: 'fnFold', type: 'float', inputs: [{ name: 'n', type: 'float' }, { name: 's', type: 'float' }] });

// `kind` is the fractal type (`type` is reserved in WGSL).
const fnShaped = Fn(([n, s, kind, ridge]) => {
  const out = n.toVar();
  If(kind.greaterThan(0.5).and(kind.lessThan(1.5)), () => {
    out.assign(fnFold(n, s));
  }).ElseIf(kind.greaterThanEqual(1.5), () => {
    out.assign(pow(clamp(float(1.0).sub(fnFold(n.mul(2.0), s)), 0.0, 1.0), ridge));
  });
  return out;
}).setLayout({
  name: 'fnShaped', type: 'float',
  inputs: [{ name: 'n', type: 'float' }, { name: 's', type: 'float' }, { name: 'kind', type: 'float' }, { name: 'ridge', type: 'float' }],
});

const fnRecentre = Fn(([v, kind, x]) => {
  const out = v.mul(1.2).add(0.5).toVar();
  If(kind.greaterThan(0.5).and(kind.lessThan(1.5)), () => {
    const m = float(0.2480).sub(x.mul(0.2673)).add(x.mul(x).mul(0.1447));
    const sd = float(0.0986).sub(x.mul(0.0148)).sub(x.mul(x).mul(0.0024));
    out.assign(v.sub(m).div(sd).mul(0.2).add(0.42));
  }).ElseIf(kind.greaterThanEqual(1.5), () => {
    const m = float(0.3680).add(x.mul(0.2878)).sub(x.mul(x).mul(0.1408));
    const sd = float(0.1651).add(x.mul(0.0765)).sub(x.mul(x).mul(0.0494));
    out.assign(v.sub(m).div(sd).mul(0.2).add(0.5));
  });
  return out;
}).setLayout({
  name: 'fnRecentre', type: 'float',
  inputs: [{ name: 'v', type: 'float' }, { name: 'kind', type: 'float' }, { name: 'x', type: 'float' }],
});

const fnLite = Fn(([qIn, evo]) => {
  const q = qIn.toVar();
  const s = float(0.0).toVar();
  const a = float(0.5).toVar();
  for (let i = 0; i < 3; i += 1) {
    s.addAssign(fnNoise(vec4(q, evo)).mul(a));
    q.assign(q.mul(2.0).add(vec2(1.7, 9.2)));
    a.mulAssign(0.5);
  }
  return s;
}).setLayout({ name: 'fnLite', type: 'float', inputs: [{ name: 'qIn', type: 'vec2' }, { name: 'evo', type: 'vec2' }] });

// The octave sum: mass gate (Musgrave product, C1 soft-saturated), fine-octave
// edge roll-off, per-octave fold softness. `octaves` is the user's Complexity,
// `maxOct` the cap for this call (3 for the lighting taps).
const fnFbm = Fn(([qIn, evo, maxOct, kind, octaves, gain, subRot, soft, ridge, mass, edge]) => {
  const q = qIn.toVar();
  const oct = floor(min(octaves, maxOct).add(0.5));
  const s0 = soft.mul(0.6);
  const amp = float(1.0).toVar();
  const tot = float(0.0).toVar();
  const sum = float(0.0).toVar();
  const weight = float(1.0).toVar();
  const ca = cos(radians(subRot));
  const sa = sin(radians(subRot));
  const er = float(1.0).toVar();
  const octs = max(octaves.sub(1.0), 1.0);
  Loop({ start: int(0), end: int(8) }, ({ i }) => {
    const fi = float(i);
    If(fi.greaterThanEqual(oct), () => { Break(); });
    const depth = fi.div(octs);
    const n = fnShaped(fnNoise(vec4(q, evo.mul(er))), s0.add(edge.mul(0.5).mul(depth)), kind, ridge);
    const w = amp.mul(mix(float(1.0), weight, mass));
    sum.addAssign(n.mul(w));
    tot.addAssign(amp);
    const dens = select(kind.lessThan(0.5), n.mul(0.5).add(0.5).mul(1.6), n.mul(3.0));
    const x = min(weight.mul(dens.add(mix(float(0.3), float(0.05), edge))), 1.0);
    weight.assign(x.mul(float(2.0).sub(x)));
    amp.mulAssign(gain.mul(mix(float(1.0), float(0.72), edge.mul(step(2.0, fi)))));
    er.mulAssign(1.35);
    // GLSL mat2(ca, sa, -sa, ca) * q, written out so the column order is explicit.
    q.assign(vec2(ca.mul(q.x).sub(sa.mul(q.y)), sa.mul(q.x).add(ca.mul(q.y))).mul(2.0).add(vec2(3.7, -2.1)));
  });
  return fnRecentre(sum.div(max(tot, 1e-5)), kind, soft);
}).setLayout({
  name: 'fnFbm', type: 'float',
  inputs: [
    { name: 'qIn', type: 'vec2' }, { name: 'evo', type: 'vec2' }, { name: 'maxOct', type: 'float' },
    { name: 'kind', type: 'float' }, { name: 'octaves', type: 'float' }, { name: 'gain', type: 'float' },
    { name: 'subRot', type: 'float' }, { name: 'soft', type: 'float' }, { name: 'ridge', type: 'float' },
    { name: 'mass', type: 'float' }, { name: 'edge', type: 'float' },
  ],
});

// Layer-local point → field coordinate: scale, stretch, rotation, drift, wisp warp.
const fnField = Fn(([p, evo, scale, stretch, rot, drift, wisp]) => {
  const k = float(300.0).div(max(scale, 1.0));
  const fs2 = vec2(pow(float(2.0), stretch.negate()), pow(float(2.0), stretch));
  const cr = cos(radians(rot));
  const sr = sin(radians(rot));
  const pk = p.mul(k).mul(fs2);
  const q = vec2(cr.mul(pk.x).sub(sr.mul(pk.y)), sr.mul(pk.x).add(cr.mul(pk.y))).add(drift).toVar();
  If(wisp.greaterThan(0.0), () => {
    const e = evo.mul(0.8).add(vec2(3.1, 7.7));
    q.addAssign(vec2(fnLite(q.add(vec2(11.3, 4.2)), e), fnLite(q.add(vec2(-6.1, 8.9)), e.mul(1.07))).mul(wisp));
  });
  return q;
}).setLayout({
  name: 'fnField', type: 'vec2',
  inputs: [
    { name: 'p', type: 'vec2' }, { name: 'evo', type: 'vec2' }, { name: 'scale', type: 'float' },
    { name: 'stretch', type: 'float' }, { name: 'rot', type: 'float' }, { name: 'drift', type: 'vec2' },
    { name: 'wisp', type: 'float' },
  ],
});

/*
 * turbulentDisplace's value noise + fbm. Separate from wrNoise/wrFbm because
 * this one takes a SEED and a shape TYPE (billow / ridged), and its octave count
 * is dynamic — quality drops two octaves in preview while keeping the same
 * timing. Laid out: pure functions of their arguments.
 */
const tdVal = Fn(([pIn, seed]) => {
  const i = floor(pIn);
  const f0 = fract(pIn);
  const f = f0.mul(f0).mul(float(3.0).sub(f0.mul(2.0)));
  const a = hash21(i.add(seed));
  const b = hash21(i.add(vec2(1.0, 0.0)).add(seed));
  const c = hash21(i.add(vec2(0.0, 1.0)).add(seed));
  const d = hash21(i.add(vec2(1.0, 1.0)).add(seed));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}).setLayout({
  name: 'tdVal', type: 'float',
  inputs: [{ name: 'pIn', type: 'vec2' }, { name: 'seed', type: 'float' }],
});

const tdFbm = Fn(([pIn, seed, oct, shape]) => {
  const p = pIn.toVar();
  const v = float(0.0).toVar();
  const amp = float(0.5).toVar();
  const norm = float(0.0).toVar();
  // Bounded at 6 with a dynamic break, exactly as the GLSL: the trip count is a
  // uniform, and the bound must stay constant for the shader to compile.
  Loop({ start: int(0), end: int(6) }, ({ i }) => {
    const fi = float(i);
    If(fi.greaterThanEqual(oct), () => { Break(); });
    const n = tdVal(p, seed.add(fi.mul(19.7))).toVar();
    If(shape.greaterThan(0.5).and(shape.lessThan(1.5)), () => {
      n.assign(abs(n.mul(2.0).sub(1.0)));                       // billow
    }).ElseIf(shape.greaterThan(1.5).and(shape.lessThan(2.5)), () => {
      n.assign(float(1.0).sub(abs(n.mul(2.0).sub(1.0))));       // ridged
    });
    v.addAssign(n.mul(amp));
    norm.addAssign(amp);
    p.assign(p.mul(2.03).add(7.1));
    amp.mulAssign(0.5);
  });
  return v.div(max(norm, 1e-4));
}).setLayout({
  name: 'tdFbm', type: 'float',
  // `type` is reserved in WGSL — the lab GLSL allowed it, the app cannot.
  inputs: [{ name: 'pIn', type: 'vec2' }, { name: 'seed', type: 'float' },
    { name: 'oct', type: 'float' }, { name: 'shape', type: 'float' }],
});

/*
 * vectorFieldWarp's noise / fbm / curl. Its own set rather than reusing tdFbm:
 * the octave count is FIXED at 4 and the amplitude is not normalised, so the
 * field magnitude differs from Turbulent Displace's by construction. Sharing
 * would silently change the strength of both.
 */
const vfVal = Fn(([pIn, seed]) => {
  const i = floor(pIn);
  const f0 = fract(pIn);
  const f = f0.mul(f0).mul(float(3.0).sub(f0.mul(2.0)));
  const a = hash21(i.add(seed));
  const b = hash21(i.add(vec2(1.0, 0.0)).add(seed));
  const c = hash21(i.add(vec2(0.0, 1.0)).add(seed));
  const d = hash21(i.add(vec2(1.0, 1.0)).add(seed));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}).setLayout({
  name: 'vfVal', type: 'float',
  inputs: [{ name: 'pIn', type: 'vec2' }, { name: 'seed', type: 'float' }],
});

const vfFbm = Fn(([pIn, seed]) => {
  const p = pIn.toVar();
  const v = float(0.0).toVar();
  const amp = float(0.5).toVar();
  // Unrolled in JS: the trip count is a literal 4, so there is no dynamic bound
  // to preserve and the octaves fold at f32 exactly as the GLSL loop does.
  for (let i = 0; i < 4; i += 1) {
    v.addAssign(vfVal(p, seed.add(19.7 * i)).mul(amp));
    p.assign(p.mul(2.03).add(7.1));
    amp.mulAssign(0.5);
  }
  return v;
}).setLayout({
  name: 'vfFbm', type: 'float',
  inputs: [{ name: 'pIn', type: 'vec2' }, { name: 'seed', type: 'float' }],
});

const vfCurl = Fn(([pIn, seed]) => {
  const e = float(0.45);
  const n1 = vfFbm(pIn.add(vec2(0.0, e)), seed);
  const n2 = vfFbm(pIn.sub(vec2(0.0, e)), seed);
  const n3 = vfFbm(pIn.add(vec2(e, 0.0)), seed);
  const n4 = vfFbm(pIn.sub(vec2(e, 0.0)), seed);
  // The negation on the second component is what makes this a CURL rather than
  // a gradient — divergence free, so the field rotates instead of smearing.
  return vec2(n1.sub(n2), n3.sub(n4).negate()).mul(2.6);
}).setLayout({
  name: 'vfCurl', type: 'vec2',
  inputs: [{ name: 'pIn', type: 'vec2' }, { name: 'seed', type: 'float' }],
});

// waveWarp's wave shapes. Pure in its parameters, so it keeps its layout.
const wwWave = Fn(([x, waveType, antialias]) => {
  const sineWave = sin(x);
  const out = float(0.0).toVar();
  If(waveType.lessThan(0.5), () => { out.assign(sineWave); })
    .ElseIf(waveType.lessThan(1.5), () => { out.assign(asin(sineWave).mul(0.63661977)); })
    .ElseIf(waveType.lessThan(2.5), () => { out.assign(mix(sign(sineWave), sineWave, antialias.mul(0.08))); })
    .Else(() => { out.assign(fract(x.div(6.2831853)).mul(2.0).sub(1.0)); });
  return out;
}).setLayout({
  name: 'wwWave', type: 'float',
  inputs: [{ name: 'x', type: 'float' }, { name: 'waveType', type: 'float' }, { name: 'antialias', type: 'float' }],
});

// GLSL `x > 0.5 ? 1 : 0`, which several bodies use as a boolean param.
const step05 = (x) => step(0.5, x);

/*
 * A texture binding that knows whether it is looking at an UPLOADED texture or a
 * RENDER TARGET.
 *
 * PORTING-GUIDE §3: an RT sampled on a hand-rolled fullscreen quad comes back
 * vertically mirrored on the WebGPU backend, while an uploaded texture does not
 * — and the flip belongs to the BINDING, not to the shader. That distinction is
 * live here: a single-pass effect's uTexture is whatever the chain handed it,
 * and a two-pass effect's MAIN pass always reads the scratch target its own
 * pre-pass just wrote. Getting it wrong does not fail loudly; glow simply blurs
 * the wrong rows and produces a plausible, different bloom.
 *
 * So every sampler goes through this wrapper, and the DRIVER declares what it
 * bound: `mat.uniforms.uTexture.flipY = true` for a render target. `.value`
 * stays exactly where the app's writers expect it.
 */
/*
 * Default (single-pass) samplers stay unflipped: the effect input is the isolate
 * plate (geometry-rendered), which samples upright with plain UV — same as the
 * lab's uploaded source. A global UV flip mirrors layers; flipping every RT
 * binding breaks hop-parity on some topologies (auraBlur).
 *
 * Declarative multipass is different (lab 08c / PORTING-GUIDE §3 + §7):
 * fullscreen-written intermediate targets need flipY, while source/matte
 * (isolate-like) must not. Flip is STRUCTURAL per sampler, so materials are
 * specialized by the resolved isRT map — see createEffectNodeMaterial(flips).
 */
const makeSampler = (flip = false, filter) => makeTslSampler({
  rgba: [255, 255, 255, 255], flipY: flip, ...(filter != null ? { filter } : {}),
});

// Path LUTs (Neon Glow, Lines Draw) are float 1-D position tables sampled with
// NEAREST in GLSL. TSL binds the sampler filter at construction from the
// placeholder, so a Linear placeholder compiles a filtered float sample — which
// WebGPU rejects without `float32-filterable` and the draw is dropped. Ramp /
// curves LUTs stay linear.
const PATH_LUT_IDS = new Set(['neonGlow', 'linesDraw']);

function makeUniforms(flips = null, { lutNearest = false } = {}) {
  const f = flips || {};
  const params = uniformArray(new Array(PARAM_SLOTS).fill(0), 'float');
  const colors = uniformArray(new Float32Array(COLOR_SLOTS * 3).fill(1), 'float');
  const u = {
    uTexture: makeSampler(!!f.uTexture),
    uSource: makeSampler(!!f.uSource),
    uTexture1: makeSampler(!!f.uTexture1),
    uTexture2: makeSampler(!!f.uTexture2),
    uTexture3: makeSampler(!!f.uTexture3),
    uLUT: makeSampler(!!f.uLUT, lutNearest ? THREE.NearestFilter : undefined),
    uResolution: uniform(new THREE.Vector2(1280, 720)),
    uTime: uniform(0),
    uProgress: uniform(0),
    uMix: uniform(1),
    uQuality: uniform(1),
    uParams: params,
    // Identity box = the whole frame, which is what every fx() helper collapses to.
    uFxOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uFxAxisX: uniform(new THREE.Vector2(0.5, 0)),
    uFxAxisY: uniform(new THREE.Vector2(0, 0.5)),
    uFxHom: uniform(new THREE.Matrix3()),
    uFxHomInv: uniform(new THREE.Matrix3()),
    uFxSizePx: uniform(new THREE.Vector2(1280, 720)),
    uFxLayer: uniform(0),
    uColor: uniform(new THREE.Color(0xffffff)),
    uColors: colors,
  };
  // See the header: the app writes `.value[i]`, the node reads `.array`. The
  // samplers are already facades of their own (makeSampler), so they pass
  // through unchanged.
  const facade = { ...u };
  facade.uParams = { node: params, get value() { return params.array; }, set value(v) { params.array = v; } };
  facade.uColors = { node: colors, get value() { return colors.array; }, set value(v) { colors.array = v; } };
  return { u, facade };
}

// The box helpers, bound to one material's uniforms. Closures rather than
// laid-out Fns precisely because they read those uniforms.
function boxHelpers(u) {
  /*
   * Helpers take texture-space UV (`uvn`). Do not flip sampling UVs here.
   *
   * `fxGeoLocal` / `fxGeoCoord` flip Y *after* the layer-box map so hash lattices
   * match GLSL's bottom-up gl_FragCoord without breaking RT sampling or the
   * box axes (which are authored in the same space as `uvn`). Passing a
   * frame-flipped UV into fxLocal would mis-place layer-scoped grids.
   */
  // fxLocal / fxFrame map through the layer plane's PROJECTIVE map, same as the
  // GLSL: the old per-axis projection was only right for perpendicular projected
  // axes, and even an exact affine inverse cannot describe the trapezoid a 3D tilt
  // projects (CRT Matrix / VHS sheared, magnified and clipped the artwork on a
  // tilted layer). For a flat layer the map is the affine frame and nothing changes.
  const fxLocal = (uvn) => {
    const h = u.uFxHomInv.mul(vec3(uvn.x, uvn.y, 1.0)).toVar();
    const l = h.xy.div(max(h.z, 1e-6));
    return select(h.z.lessThan(1e-6), vec2(-1e3, -1e3), l);
  };
  const fxFrame = (p) => {
    const h = u.uFxHom.mul(vec3(p.x, p.y, 1.0)).toVar();
    return h.xy.div(max(h.z, 1e-6));
  };
  const fxDir = (v) => u.uFxAxisX.mul(v.x).add(u.uFxAxisY.mul(v.y)).mul(2.0);
  const fxRes = () => u.uFxSizePx;
  const fxAspect = () => u.uFxSizePx.x.div(max(u.uFxSizePx.y, 1e-6));
  // The 0.25 bias keeps the rounding boundary off the whole and half pixels the
  // box lands on, so a hashed lattice rides the layer instead of re-randomising
  // as it moves. Frame scope keeps the raw value.
  const fxCoord = (uvn) => {
    const c = fxLocal(uvn).mul(u.uFxSizePx);
    return select(u.uFxLayer.greaterThan(0.5), floor(c.add(0.25)).add(0.5), c);
  };
  const fxGeoLocal = (uvn) => {
    const lp = fxLocal(uvn);
    return vec2(lp.x, float(1.0).sub(lp.y));
  };
  const fxGeoCoord = (uvn) => {
    const c = fxGeoLocal(uvn).mul(u.uFxSizePx);
    return select(u.uFxLayer.greaterThan(0.5), floor(c.add(0.25)).add(0.5), c);
  };
  return { fxLocal, fxFrame, fxDir, fxRes, fxAspect, fxCoord, fxGeoLocal, fxGeoCoord };
}

// ── Effect bodies ───────────────────────────────────────────────────────────
// Each returns the premultiplied vec4 the GLSL `fx(uv)` returns. Ported from the
// verdicted labs where one exists (pair 08a for these six).

const BODIES = {
  curves: ({ u, uvn, srcCol }) => {
    const P = u.uParams;
    const out = vec4(srcCol).toVar();
    If(P.element(24).greaterThanEqual(0.5), () => {
      const c = clamp(unpremult(srcCol), 0.0, 1.0);
      // The baked curve is a 256×1 LUT per channel; the +0.5/256 lands on texel
      // centres, exactly as the GLSL does.
      // uLUT, NOT uTexture1: applyEffectUniforms bakes the four spline channels
      // into uLUT (master folded into each channel), and uParams[24] is its
      // loaded flag. Sampling the wrong slot reads the unbound placeholder,
      // which grades everything to white.
      const graded = vec3(
        u.uLUT.sample(vec2(c.r.mul(255.0).add(0.5).div(256.0), 0.5)).r,
        u.uLUT.sample(vec2(c.g.mul(255.0).add(0.5).div(256.0), 0.5)).g,
        u.uLUT.sample(vec2(c.b.mul(255.0).add(0.5).div(256.0), 0.5)).b,
      );
      out.assign(vec4(graded.mul(clamp(srcCol.a, 0.0, 1.0)), clamp(srcCol.a, 0.0, 1.0)));
    });
    return out;
  },

  lut: ({ u, srcCol }) => {
    const P = u.uParams;
    const N = P.element(24);
    const out = vec4(srcCol).toVar();
    If(N.greaterThanEqual(2.0), () => {
      const c = clamp(unpremult(srcCol).sub(P.element(25))
        .div(max(P.element(26).sub(P.element(25)), 1e-5)), 0.0, 1.0);
      const b = c.b.mul(N.sub(1.0));
      const b0 = floor(b);
      const bf = b.sub(b0);
      const b1 = min(b0.add(1.0), N.sub(1.0));
      const x = c.r.mul(N.sub(1.0)).add(0.5);
      const y = c.g.mul(N.sub(1.0)).add(0.5).div(N);
      const w = N.mul(N);
      const s0 = u.uLUT.sample(vec2(b0.mul(N).add(x).div(w), y)).rgb;
      const s1 = u.uLUT.sample(vec2(b1.mul(N).add(x).div(w), y)).rgb;
      out.assign(vec4(mix(s0, s1, bf).mul(srcCol.a), srcCol.a));
    });
    return out;
  },

  /*
   * Colorama (gradient map). Ported from motionEffects.js's `fx()` — a straight
   * per-pixel body, which is why it goes first out of the 17-effect backlog.
   *
   * Two things carried over deliberately rather than tidied:
   *   * the DITHER is keyed on `fxCoord`, i.e. position only and never time, so
   *     a frame renders identically in preview and export. A hash that took
   *     uTime would make every exported frame a different grain.
   *   * the ramp read is a NEAREST-ish LUT lookup at v=0.5; `uLUT` is the
   *     gradient the registry builds from the `ramp` param via usesRamp.
   *
   * The GLSL's if/else-if chain over `mode` is a select() ladder here: the
   * values are already in registers, so there is no branch to save, and select()
   * keeps the whole body layout-free (PORTING-GUIDE §2).
   */
  /*
   * Kaleidoscope. Folds the layer's own box about its centre, so a folded LAYER
   * mirrors its artwork while an adjustment layer folds the frame — that is what
   * fxLocal/fxFrame carry, and it is why the maths is NOT done in frame uv.
   *
   * `seg < 1.5` is an EXACT BYPASS in the GLSL, not a perf guard: at one segment
   * the fold is the identity and the wedge maths would divide by a zero-width
   * wedge. Reproduced with If/Return rather than select(), because the skipped
   * branch is not neutral.
   */
  /*
   * Turbulent Displace. A noise field pushed through fxDir so the turbulence is
   * PRINTED ON the artwork and travels with a moving layer, rather than being a
   * field the layer slides through — that is what sampling the noise in
   * fxCoord's layer-pixel grid buys, and it is the whole character of the effect.
   *
   * The swirl mode is the CURL of a scalar potential, which is what makes it
   * rotate the source instead of smearing it: divergence-free by construction.
   * Four fbm taps, exactly as the GLSL, and the sign on the second component is
   * load-bearing.
   */
  turbulentDisplace: ({ u, uvn, geoUv, helpers }) => {
    const P = u.uParams;
    const { fxLocal, fxDir, fxRes, fxCoord } = helpers;
    const ref = fxRes().y.div(1080.0);
    const size = max(P.element(2), 2.0).mul(ref);
    const oct = max(float(1.0), floor(P.element(3).add(0.5))).toVar();
    // Preview drops two octaves and keeps the same timing.
    oct.assign(select(u.uQuality.lessThan(0.75), max(float(1.0), oct.sub(2.0)), oct));
    const type = P.element(6);
    const seed = P.element(10).mul(13.37);
    const evo = P.element(4).add(u.uTime.mul(P.element(5)).mul(90.0));
    const eo = vec2(0.37, -0.61).mul(evo.div(360.0)).mul(2.0);
    // Lattice matches GLSL gl_FragCoord; samples stay on texture-space uvn.
    const pp = fxCoord(uvn).div(size).add(eo).toVar();

    const d = vec2(0.0).toVar();
    If(type.greaterThan(2.5), () => {
      const e = float(0.55);
      const n1 = tdFbm(pp.add(vec2(0.0, e)), seed, oct, float(0.0));
      const n2 = tdFbm(pp.sub(vec2(0.0, e)), seed, oct, float(0.0));
      const n3 = tdFbm(pp.add(vec2(e, 0.0)), seed, oct, float(0.0));
      const n4 = tdFbm(pp.sub(vec2(e, 0.0)), seed, oct, float(0.0));
      d.assign(vec2(n1.sub(n2), n3.sub(n4).negate()).mul(3.2));
    }).Else(() => {
      d.assign(vec2(
        tdFbm(pp, seed, oct, type).sub(0.5),
        tdFbm(pp.add(41.7), seed.add(91.3), oct, type).sub(0.5),
      ).mul(2.0));
    });

    const mapMode = P.element(9);
    If(mapMode.greaterThan(0.5).and(mapMode.lessThan(1.5)), () => {
      // Luminance map: displace along the gradient of the source's brightness.
      const px = vec2(1.5).div(u.uResolution);
      const lx = luma(unpremult(u.uTexture.sample(uvn.add(vec2(px.x, 0.0)))))
        .sub(luma(unpremult(u.uTexture.sample(uvn.sub(vec2(px.x, 0.0))))));
      const ly = luma(unpremult(u.uTexture.sample(uvn.add(vec2(0.0, px.y)))))
        .sub(luma(unpremult(u.uTexture.sample(uvn.sub(vec2(0.0, px.y))))));
      d.assign(vec2(lx, ly).mul(5.0));
    }).ElseIf(mapMode.greaterThan(1.5), () => {
      d.assign(u.uTexture3.sample(uvn).rg.sub(0.5).mul(2.0));
    });

    const dr = rot2(radians(P.element(7))).mul(d);
    const disp = dr.mul(vec2(P.element(0), P.element(1))).mul(ref).toVar();

    const pin = clamp(P.element(8).div(100.0), 0.0, 1.0);
    // GLSL guards this with `pin > 0.001`; at pin 0 the smoothstep edge collapses
    // to 0 and the product is NOT neutral, so the guard is semantic — keep it.
    If(pin.greaterThan(0.001), () => {
      const e = pin.mul(0.5);
      const lp = fxLocal(uvn);
      disp.mulAssign(
        smoothstep(0.0, e, lp.x).mul(smoothstep(0.0, e, float(1.0).sub(lp.x)))
          .mul(smoothstep(0.0, e, lp.y)).mul(smoothstep(0.0, e, float(1.0).sub(lp.y))),
      );
    });

    const q = uvn.add(fxDir(disp.div(fxRes())));
    // sampleClamped: outside the plate is EMPTY, not the edge texel.
    const inside = q.x.greaterThanEqual(0.0).and(q.x.lessThanEqual(1.0))
      .and(q.y.greaterThanEqual(0.0)).and(q.y.lessThanEqual(1.0));
    return inside.select(u.uTexture.sample(q), vec4(0.0));
  },

  /*
   * Vector Field Warp. MULTI-STEP ADVECTION: each step re-reads the field at the
   * moved position, which is what turns a straight offset into a curved flow
   * line. Collapsing it to a single offset would look similar at low strength
   * and completely wrong at high strength, so the loop stays.
   */
  vectorFieldWarp: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const { fxLocal, fxDir, fxRes, fxAspect, fxCoord } = helpers;

    const vfField = (uvIn) => {
      const type = P.element(0);
      const ar = fxAspect();
      const c = vec2(P.element(3), P.element(4));
      const rel = fxLocal(uvIn).sub(c).mul(vec2(ar, 1.0)).toVar();
      const scale = max(P.element(2), 8.0).mul(fxRes().y.div(1080.0));
      const evo = u.uTime.mul(radians(P.element(7))).toVar();
      const pp = fxCoord(uvIn).div(scale).add(vec2(evo.mul(0.6), evo.mul(-0.4))).toVar();
      const d = vec2(0.0).toVar();
      If(type.lessThan(0.5), () => {                       // Flow: curl noise
        d.assign(vfCurl(pp, float(3.7)));
      }).ElseIf(type.lessThan(1.5), () => {                // Vortex
        const t = vec2(rel.y.negate(), rel.x);
        d.assign(normalize(t.add(vec2(1e-5, 1e-5)))
          .mul(inverseSmoothstep(0.05, 0.9, length(rel))));
        d.assign(rot2(evo).mul(d));
      }).ElseIf(type.lessThan(2.5), () => {                // Attract
        d.assign(normalize(rel.add(vec2(1e-5, 1e-5))).negate()
          .mul(inverseSmoothstep(0.0, 0.9, length(rel))));
      }).ElseIf(type.lessThan(3.5), () => {                // Repel
        d.assign(normalize(rel.add(vec2(1e-5, 1e-5)))
          .mul(inverseSmoothstep(0.0, 0.9, length(rel))));
      }).Else(() => {                                      // Directional
        const a = radians(P.element(5)).add(evo.mul(P.element(6)).div(100.0));
        d.assign(vec2(cos(a), sin(a)));
      });
      const turb = P.element(9).div(100.0);
      If(turb.greaterThan(0.001), () => {
        d.addAssign(vfCurl(pp.mul(1.7).add(31.0), float(9.1)).mul(turb));
      });
      const rotAmt = P.element(6).div(100.0);
      If(type.lessThan(3.5).and(type.greaterThan(0.5)), () => {
        d.assign(rot2(rotAmt.mul(1.5)).mul(d));
      });
      return d;
    };

    const ref = fxRes().y.div(1080.0);
    const strength = P.element(1).mul(ref).toVar();
    const out = vec4(0.0).toVar();
    If(strength.lessThan(0.25), () => {
      out.assign(u.uTexture.sample(uvn));
    }).Else(() => {
      const steps = max(floor(P.element(8)
        .mul(select(u.uQuality.lessThan(0.75), float(0.5), float(1.0))).add(0.5)), 1.0).toVar();
      const pAdv = uvn.toVar();
      Loop({ start: int(0), end: int(12) }, ({ i }) => {
        If(float(i).greaterThanEqual(steps), () => { Break(); });
        pAdv.subAssign(fxDir(vfField(pAdv).mul(strength.div(steps)).div(fxRes())));
      });
      const pin = clamp(P.element(10).div(100.0), 0.0, 1.0);
      // Semantic guard: at pin 0 the smoothstep edge collapses and k would be 0,
      // pinning everything back to uv. Not neutral — keep the branch.
      If(pin.greaterThan(0.001), () => {
        const e = pin.mul(0.5);
        const lp = fxLocal(uvn);
        const k = smoothstep(0.0, e, lp.x).mul(smoothstep(0.0, e, float(1.0).sub(lp.x)))
          .mul(smoothstep(0.0, e, lp.y)).mul(smoothstep(0.0, e, float(1.0).sub(lp.y)));
        pAdv.assign(mix(uvn, pAdv, k));
      });
      const inside = pAdv.x.greaterThanEqual(0.0).and(pAdv.x.lessThanEqual(1.0))
        .and(pAdv.y.greaterThanEqual(0.0)).and(pAdv.y.lessThanEqual(1.0));
      If(inside, () => { out.assign(u.uTexture.sample(pAdv)); })
        .Else(() => { out.assign(vec4(0.0)); });
    });
    return out;
  },

  /*
   * Pixel Stretch (pixel sorting). Two data-dependent marches, and the SECOND is
   * the one that makes the effect read as sorting:
   *
   *   inside the band  — hold the colour from where this run ENTERED the band
   *   outside the band — the streak EXTENSION: a run upstream drags its colour
   *                      past its own end, fading with distance. Without it the
   *                      effect only re-shuffles run interiors and uniformly
   *                      bright content barely changes.
   *
   * GLSL returns early from inside both loops. TSL has no early return through a
   * Loop, so a `done` flag carries it: once set, later iterations still execute
   * but write nothing, and the trailing branches are guarded on it. Same result,
   * and the bounded trip count (48) stays constant so the shader compiles.
   */
  pixelStretch: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const { fxLocal, fxDir, fxRes, fxAspect } = helpers;
    const psLum = (p) => {
      const sm = u.uTexture.sample(p);
      return luma(unpremult(sm)).mul(sm.a);
    };
    const ref = fxRes().y.div(1080.0);
    const dirMode = P.element(0);
    const ar = fxAspect();
    const lp = fxLocal(uvn).toVar();

    const d = vec2(1.0, 0.0).toVar();
    const lane = float(0.0).toVar();
    If(dirMode.lessThan(0.5), () => {
      d.assign(vec2(1.0, 0.0)); lane.assign(lp.y);
    }).ElseIf(dirMode.lessThan(1.5), () => {
      d.assign(vec2(0.0, 1.0)); lane.assign(lp.x);
    }).Else(() => {
      const rel = lp.sub(0.5).mul(vec2(ar, 1.0));
      d.assign(normalize(rel.add(1e-5)));
      lane.assign(atan(rel.y, rel.x).div(6.2831853).add(0.5));
    });
    If(P.element(7).greaterThan(0.5), () => { d.assign(d.negate()); });

    const animate = u.uTime.mul(P.element(6)).div(100.0);
    const lo = clamp(P.element(1).div(100.0)
      .add(sin(animate.mul(6.2831853)).mul(P.element(6)).div(600.0)), 0.0, 1.0).toVar();
    const hi = clamp(P.element(2).div(100.0), 0.0, 1.0).toVar();

    // Quantise the perpendicular coordinate into lanes and jitter span per lane —
    // the ragged thread lengths that make sorting read as sorting.
    const band = max(P.element(5).mul(ref), 1.0);
    const laneId = floor(lane.mul(fxRes().y).div(band));
    const jit = float(1.0).sub(P.element(4).div(100.0).mul(hash21(vec2(laneId, 17.0))));
    const span = P.element(3).mul(ref).mul(jit);

    const taps = select(u.uQuality.lessThan(0.75), float(24.0), float(48.0)).toVar();
    const stepv = fxDir(d.mul(span.div(taps)).div(fxRes())).toVar();
    const l = psLum(uvn).toVar();

    const out = u.uTexture.sample(uvn).toVar();
    const inBand = l.greaterThanEqual(lo).and(l.lessThanEqual(hi));

    If(inBand, () => {
      const origin = uvn.toVar();
      const done = float(0.0).toVar();
      Loop({ start: int(1), end: int(49) }, ({ i }) => {
        const fi = float(i);
        If(fi.greaterThan(taps), () => { Break(); });
        const suv = uvn.sub(stepv.mul(fi)).toVar();
        const outside = suv.x.lessThan(0.0).or(suv.x.greaterThan(1.0))
          .or(suv.y.lessThan(0.0)).or(suv.y.greaterThan(1.0));
        If(outside, () => { Break(); });
        const sl = psLum(suv);
        If(sl.lessThan(lo).or(sl.greaterThan(hi)), () => { Break(); });
        If(done.lessThan(0.5), () => { origin.assign(suv); });
      });
      out.assign(u.uTexture.sample(origin));
    }).Else(() => {
      const done = float(0.0).toVar();
      const acc = u.uTexture.sample(uvn).toVar();
      Loop({ start: int(1), end: int(49) }, ({ i }) => {
        const fi = float(i);
        If(fi.greaterThan(taps), () => { Break(); });
        const suv = uvn.sub(stepv.mul(fi)).toVar();
        const outside = suv.x.lessThan(0.0).or(suv.x.greaterThan(1.0))
          .or(suv.y.lessThan(0.0)).or(suv.y.greaterThan(1.0));
        If(outside, () => { Break(); });
        const sl = psLum(suv);
        If(sl.greaterThanEqual(lo).and(sl.lessThanEqual(hi)).and(done.lessThan(0.5)), () => {
          const fade = float(1.0).sub(fi.div(taps));
          acc.assign(mix(u.uTexture.sample(uvn), u.uTexture.sample(suv), fade));
          done.assign(1.0);
          Break();
        });
      });
      out.assign(acc);
    });
    return out;
  },

  /*
   * Halftone. The screen is PRINTED ON the layer: cells are measured in the
   * layer's own pixels and the grid is phased from its box (fxCoord), so the
   * dots stay put on the artwork while it moves rather than crawling under it.
   *
   * The CMYK branch is a genuinely different algorithm — four screens, each with
   * its own angle and misregistration, multiplied over paper — so it is an early
   * return in the GLSL and an If/Else here rather than a blended select.
   *
   * The `ch == 0 ? .. : (ch == 1 ? ..)` ladders are unrolled in JS: `ch` is a
   * loop constant, so this costs nothing and keeps the channel constants literal.
   */
  halftone: ({ u, uvn, geoUv, helpers }) => {
    const P = u.uParams;
    const { fxDir, fxRes, fxCoord } = helpers;
    const C = (i) => vec3(u.uColors.element(i * 3), u.uColors.element(i * 3 + 1),
      u.uColors.element(i * 3 + 2));

    const htLum = (p) => {
      const sm = u.uTexture.sample(p);
      const l = luma(unpremult(sm));
      const ct = max(P.element(3), 0.0).div(100.0);
      return clamp(l.sub(0.5).mul(ct).add(0.5), 0.0, 1.0);
    };
    const htEdge = (p) => {
      const px = vec2(1.4).div(u.uResolution);
      const l = htLum(p);
      const dx = abs(htLum(p.add(vec2(px.x, 0.0))).sub(htLum(p.sub(vec2(px.x, 0.0)))));
      const dy = abs(htLum(p.add(vec2(0.0, px.y))).sub(htLum(p.sub(vec2(0.0, px.y)))));
      return clamp(dx.add(dy).mul(3.0), 0.0, 1.0)
        .mul(clamp(P.element(6).div(100.0), 0.0, 1.0)).mul(float(0.4).add(l));
    };
    const htDots = (fc, ang, cell, ink, aa) => {
      const pr = rot2(ang).mul(fc);
      const f = fract(pr.div(cell)).sub(0.5);
      const r = length(f).mul(2.0);
      const rad = sqrt(clamp(ink, 0.0, 1.0)).mul(1.06);
      return smoothstep(rad.add(aa), rad.sub(aa), r);
    };
    const htLines = (fc, ang, cell, ink, aa, wobble) => {
      const pr = rot2(ang).mul(fc);
      const w = wobble > 0 ? sin(pr.x.div(cell).mul(6.2831853)).mul(cell).mul(0.16) : float(0.0);
      const d = abs(fract(pr.y.add(w).div(cell)).sub(0.5)).mul(2.0);
      const ik = clamp(ink, 0.0, 1.0);
      return smoothstep(ik.add(aa), ik.sub(aa), d);
    };

    const sm0 = u.uTexture.sample(uvn).toVar();
    const pattern = P.element(0);
    const ref = fxRes().y.div(1080.0);
    const cell = max(P.element(1), 1.5).mul(ref).toVar();
    const ang = radians(P.element(2)).toVar();
    const aa = clamp(float(2.6).div(cell), 0.02, 0.45).toVar();
    const drift = clamp(P.element(7).div(100.0), 0.0, 1.0);
    // Cell grid matches GLSL's gl_FragCoord lattice; samples stay on uvn.
    const fc = fxCoord(uvn).add(
      vec2(sin(u.uTime.mul(0.63)), cos(u.uTime.mul(0.47))).mul(drift).mul(cell).mul(2.0)).toVar();
    const mis = P.element(5).mul(ref).toVar();
    const paper = C(1);
    const ink = C(0);

    const out = vec4(0.0).toVar();
    If(pattern.greaterThan(2.5).and(pattern.lessThan(3.5)), () => {
      // CMYK: one screen per channel, each with its own angle + misregistration.
      const rotStep = radians(P.element(4));
      const col = paper.toVar();
      const INKS = [
        vec3(0.05, 0.72, 0.92), vec3(0.90, 0.10, 0.52),
        vec3(0.98, 0.86, 0.06), vec3(0.06, 0.06, 0.06),
      ];
      for (let ch = 0; ch < 4; ch += 1) {
        const fch = float(ch);
        const a2 = ang.add(rotStep.mul(fch));
        const off = vec2(cos(a2.mul(2.3)), sin(a2.mul(1.7))).mul(mis);
        const q = uvn.add(fxDir(off.div(fxRes())));
        const inside = q.x.greaterThanEqual(0.0).and(q.x.lessThanEqual(1.0))
          .and(q.y.greaterThanEqual(0.0)).and(q.y.lessThanEqual(1.0));
        const smc = inside.select(u.uTexture.sample(q), vec4(0.0));
        const ct = max(P.element(3), 0.0).div(100.0);
        const cm = clamp(unpremult(smc).sub(0.5).mul(ct).add(0.5), 0.0, 1.0).toVar();
        const k = float(1.0).sub(max(cm.r, max(cm.g, cm.b))).toVar();
        const ik = max(float(1.0).sub(k), 1e-3);
        const cmy = clamp(vec3(float(1.0).sub(k)).sub(cm).div(ik), 0.0, 1.0).toVar();
        const amt = ch === 0 ? cmy.x : ch === 1 ? cmy.y : ch === 2 ? cmy.z : k;
        const cov = htDots(fc.add(off), a2.add(0.4 * ch), cell, amt, aa);
        col.mulAssign(mix(vec3(1.0), INKS[ch], cov));
      }
      out.assign(premult(col, sm0.a));
    }).Else(() => {
      const l = htLum(uvn);
      const amt = clamp(float(1.0).sub(l).add(htEdge(uvn)), 0.0, 1.0).toVar();
      const cov = float(0.0).toVar();
      If(pattern.lessThan(0.5), () => {
        cov.assign(htDots(fc, ang, cell, amt, aa));
      }).ElseIf(pattern.lessThan(1.5), () => {
        cov.assign(htLines(fc, ang, cell, amt, aa, 0));
      }).ElseIf(pattern.lessThan(2.5), () => {
        const a1 = htLines(fc, ang, cell, amt.mul(0.92), aa, 0);
        const a2 = htLines(fc, ang.add(1.5708), cell,
          max(amt.sub(0.42), 0.0).mul(0.92), aa, 0);
        cov.assign(max(a1, a2));
      }).Else(() => {
        cov.assign(htLines(fc, ang, cell, amt, aa, 1));
      });

      const plain = premult(mix(paper, ink, cov), sm0.a);
      // Off-register second impression, tinted toward the ink's complement.
      const off = vec2(cos(ang.add(1.1)), sin(ang.add(1.1))).mul(mis);
      const cov2 = select(pattern.lessThan(0.5),
        htDots(fc.add(off), ang, cell, amt, aa),
        select(pattern.greaterThan(3.5),
          htLines(fc.add(off), ang, cell, amt, aa, 1),
          htLines(fc.add(off), ang, cell, amt, aa, 0)));
      const col2 = mix(paper, vec3(1.0).sub(ink), cov2.mul(0.5)).toVar();
      col2.assign(mix(col2, ink, cov));
      out.assign(select(mis.greaterThan(0.01), premult(col2, sm0.a), plain));
    });
    return out;
  },

  kaleidoscope: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const { fxLocal, fxFrame, fxAspect } = helpers;
    const seg = max(P.element(0), 1.0).toVar();
    const out = vec4(0.0).toVar();
    If(seg.lessThan(1.5), () => {
      out.assign(u.uTexture.sample(uvn));
    }).Else(() => {
      const ar = fxAspect();
      const c = vec2(P.element(2), P.element(3));
      const pp = fxLocal(uvn).sub(c).mul(vec2(ar, 1.0)).toVar();
      const r = length(pp).toVar();
      const a = atan(pp.y, pp.x).add(radians(P.element(1)))
        .add(u.uTime.mul(radians(P.element(9)))).toVar();
      const wedge = float(6.2831853).div(seg).toVar();
      const cell = fract(a.div(wedge)).toVar();
      If(P.element(5).greaterThan(0.5), () => {
        // Mirror alternate segments: seamless edges instead of hard wrap lines.
        cell.assign(abs(cell.mul(2.0).sub(1.0)));
        a.assign(cell.mul(wedge).mul(0.5));
      }).Else(() => {
        a.assign(cell.mul(wedge));
      });
      a.addAssign(r.mul(P.element(6)).div(100.0).mul(6.0));     // spiral
      r.mulAssign(float(1.0).div(max(P.element(4).div(100.0), 0.05)));
      r.addAssign(P.element(7).div(100.0));                      // radial offset
      const q = vec2(cos(a), sin(a)).mul(r).div(vec2(ar, 1.0)).add(c).toVar();
      const lq = select(
        P.element(8).greaterThan(0.5),
        abs(fract(q.mul(0.5)).mul(2.0).sub(1.0)),                // mirror tile
        clamp(q, 0.0, 1.0),                                      // clamp
      );
      out.assign(u.uTexture.sample(fxFrame(lq)));
    });
    return out;
  },

  /*
   * Directional Smear. A weighted march along an authored direction.
   *
   * Two things that must survive the port verbatim: the direction goes through
   * fxDir, so the streak stays stuck to a ROTATED layer instead of always
   * smearing screen-horizontal; and the result is clamped back under its own
   * alpha (`min(rgb, a)`) to keep the premultiplied invariant, without which a
   * bright tap can push rgb above alpha and the export flatten reads it as a
   * fringe.
   *
   * The GLSL's `for (i < 64) { if (i >= taps) break; }` is a bounded loop with a
   * dynamic trip count — Loop/Break reproduces exactly that, and the bound must
   * stay constant for the shader to compile.
   */
  directionalSmear: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const { fxLocal, fxFrame, fxDir, fxRes } = helpers;
    const smearTap = (p, mode) => {
      // sampleClamped: outside the plate is EMPTY, not the edge texel.
      const inside = p.x.greaterThanEqual(0.0).and(p.x.lessThanEqual(1.0))
        .and(p.y.greaterThanEqual(0.0)).and(p.y.lessThanEqual(1.0));
      const transparent = inside.select(u.uTexture.sample(p), vec4(0.0));
      const clamped = u.uTexture.sample(clamp(p, 0.0, 1.0));
      const m = abs(fract(fxLocal(p).mul(0.5)).mul(2.0).sub(1.0));
      const mirrored = u.uTexture.sample(fxFrame(m));
      return select(mode.lessThan(0.5), transparent,
        select(mode.lessThan(1.5), clamped, mirrored));
    };
    const ref = fxRes().y.div(1080.0);
    const len = P.element(0).mul(ref).toVar();
    const out = vec4(0.0).toVar();
    If(len.lessThan(0.5), () => {
      out.assign(u.uTexture.sample(uvn));
    }).Else(() => {
      const dir = vec2(cos(radians(P.element(1))), sin(radians(P.element(1))));
      const bias = clamp(P.element(2).div(100.0), -1.0, 1.0);
      const fall = max(P.element(3).div(100.0), 0.05);
      const taps = max(float(5.0),
        floor(P.element(4).mul(select(u.uQuality.lessThan(0.75), float(0.5), float(1.0))))).toVar();
      const boost = P.element(5).div(100.0);
      const edgeMode = P.element(6);
      const t0 = float(-0.5).sub(bias.mul(0.5)).toVar();
      const t1 = float(0.5).sub(bias.mul(0.5)).toVar();
      const span = max(max(abs(t0), abs(t1)), 1e-3);
      const acc = vec4(0.0).toVar();
      const ws = float(0.0).toVar();
      Loop({ start: int(0), end: int(64) }, ({ i }) => {
        const fi = float(i);
        If(fi.greaterThanEqual(taps), () => { Break(); });
        const k = fi.div(max(taps.sub(1.0), 1e-4));
        const t = mix(t0, t1, k);
        const w = pow(max(float(1.0).sub(abs(t).div(span)), 0.0), float(1.0).div(fall)).toVar();
        const sm = smearTap(uvn.add(fxDir(dir.mul(t.mul(len)).div(fxRes()))), edgeMode).toVar();
        const l = luma(unpremult(sm)).mul(sm.a);
        // Bright pixels drag longer streaks. Guarded in GLSL by `boost > 0.001`;
        // at boost 0 the factor is exactly 1, so the guard is provably neutral.
        w.mulAssign(float(1.0).add(boost.mul(l).mul(l).mul(3.0)));
        acc.addAssign(sm.mul(w));
        ws.addAssign(w);
      });
      const res = acc.div(max(ws, 1e-4)).toVar();
      out.assign(vec4(min(res.rgb, vec3(res.a)), res.a));
    });
    return out;
  },

  colorama: ({ u, uvn, srcCol, helpers }) => {
    const P = u.uParams;
    const { fxCoord } = helpers;
    const c = unpremult(srcCol).toVar();
    const mode = P.element(0);
    const v = luma(c).toVar();
    v.assign(select(mode.greaterThan(0.5).and(mode.lessThan(1.5)), c.r, v));
    v.assign(select(mode.greaterThan(1.5).and(mode.lessThan(2.5)), c.g, v));
    v.assign(select(mode.greaterThan(2.5).and(mode.lessThan(3.5)), c.b, v));
    v.assign(select(mode.greaterThan(3.5), srcCol.a, v));

    const d = hash21(fxCoord(uvn)).sub(0.5)
      .mul(clamp(P.element(7).div(100.0), 0.0, 1.0)).mul(0.024);
    const x = fract(v.mul(max(P.element(3), 0.01)).add(P.element(1))
      .add(u.uTime.mul(P.element(2))).add(d));
    const g = u.uLUT.sample(vec2(x, 0.5)).rgb.toVar();

    const pl = clamp(P.element(5).div(100.0), 0.0, 1.0);
    const relit = clamp(g.mul(luma(c).div(max(luma(g), 1e-3))), 0.0, 1.0);
    g.assign(mix(g, relit, pl));

    // Blend with the original — the same ladder as the GLSL. Nested selects
    // rather than a chain of g.assign(): every branch reads the mapped colour as
    // it stands here, so no mode can be fed the previous one's output.
    const bm = P.element(8);
    const one = vec3(1.0);
    const multiply = c.mul(g);
    const screen = one.sub(one.sub(c).mul(one.sub(g)));
    const overlay = mix(c.mul(g).mul(2.0), one.sub(one.sub(c).mul(one.sub(g)).mul(2.0)), step(vec3(0.5), c));
    const softLight = mix(
      c.mul(g).mul(2.0).add(c.mul(c).mul(one.sub(g.mul(2.0)))),
      sqrt(max(c, vec3(0.0))).mul(g.mul(2.0).sub(1.0)).add(c.mul(2.0).mul(one.sub(g))),
      step(vec3(0.5), g),
    );
    const add = min(c.add(g), one);
    const difference = abs(c.sub(g));
    const blended = select(bm.lessThan(0.5), g,
      select(bm.lessThan(1.5), multiply,
        select(bm.lessThan(2.5), screen,
          select(bm.lessThan(3.5), overlay,
            select(bm.lessThan(4.5), softLight,
              select(bm.lessThan(5.5), add, difference))))));

    // Blend With Original — fade the whole result back toward the source colour.
    const kept = mix(clamp(blended, 0.0, 1.0), c, clamp(P.element(9).div(100.0), 0.0, 1.0));

    const a = select(P.element(6).greaterThan(0.5), srcCol.a, float(1.0));
    return premult(kept, a);
  },

  fill: ({ u, srcCol }) => {
    const P = u.uParams;
    // Same ladder as the GLSL: blend on unpremultiplied colour, premultiply by
    // the SOURCE alpha so the fill never adds or removes coverage.
    const b = clamp(unpremult(srcCol), 0.0, 1.0).toVar();
    const s = clamp(vec3(u.uColor), 0.0, 1.0).toVar();
    const one = vec3(1.0);
    const bm = P.element(0);
    const multiply = b.mul(s);
    const screen = one.sub(one.sub(b).mul(one.sub(s)));
    const overlay = mix(b.mul(s).mul(2.0), one.sub(one.sub(b).mul(one.sub(s)).mul(2.0)), step(vec3(0.5), b));
    const softLight = mix(
      b.mul(s).mul(2.0).add(b.mul(b).mul(one.sub(s.mul(2.0)))),
      sqrt(max(b, vec3(0.0))).mul(s.mul(2.0).sub(1.0)).add(b.mul(2.0).mul(one.sub(s))),
      step(vec3(0.5), s),
    );
    const hardLight = mix(b.mul(s).mul(2.0), one.sub(one.sub(b).mul(one.sub(s)).mul(2.0)), step(vec3(0.5), s));
    const add = min(b.add(s), one);
    const lighten = max(b, s);
    const darken = min(b, s);
    const difference = abs(b.sub(s));
    // Color: the fill's hue + saturation at the source's luminance (setLum + clipColor).
    const l = luma(b).toVar();
    const c0 = s.add(vec3(l.sub(luma(s)))).toVar();
    const n0 = min(c0.r, min(c0.g, c0.b));
    const c1 = select(n0.lessThan(0.0), vec3(l).add(c0.sub(vec3(l)).mul(l).div(max(l.sub(n0), 1e-5))), c0).toVar();
    const x1 = max(c1.r, max(c1.g, c1.b));
    const colorMode = select(x1.greaterThan(1.0), vec3(l).add(c1.sub(vec3(l)).mul(float(1.0).sub(l)).div(max(x1.sub(l), 1e-5))), c1);
    const r = select(bm.lessThan(0.5), s,
      select(bm.lessThan(1.5), multiply,
        select(bm.lessThan(2.5), screen,
          select(bm.lessThan(3.5), overlay,
            select(bm.lessThan(4.5), softLight,
              select(bm.lessThan(5.5), hardLight,
                select(bm.lessThan(6.5), add,
                  select(bm.lessThan(7.5), lighten,
                    select(bm.lessThan(8.5), darken,
                      select(bm.lessThan(9.5), difference, colorMode))))))))));
    return premult(clamp(r, 0.0, 1.0), srcCol.a);
  },

  /*
   * Shape Rulers — the GLSL line for line. All of it is box-pixel maths on
   * fxLocal, which is orientation-normalised on both backends, so nothing here
   * negates y (the fxLocal regime, not the raw-uv one — project memory
   * fxlocal_orientation_parity).
   */
  shapeRulers: ({ u, uvn, srcCol, helpers }) => {
    const P = u.uParams;
    const C = (i) => vec3(u.uColors.element(i * 3), u.uColors.element(i * 3 + 1), u.uColors.element(i * 3 + 2));
    const k = min(u.uResolution.x, u.uResolution.y).div(1080.0);
    const rcRaw = vec4(P.element(24), P.element(25), P.element(26), P.element(27));
    const unset = rcRaw.z.sub(rcRaw.x).lessThan(1e-5).or(rcRaw.w.sub(rcRaw.y).lessThan(1e-5));
    const rc = select(unset, vec4(0.0, 0.0, 1.0, 1.0), rcRaw);
    const q = helpers.fxLocal(uvn).sub(rc.xy.add(rc.zw).mul(0.5)).mul(u.uFxSizePx).toVar();
    const hb = rc.zw.sub(rc.xy).mul(0.5).mul(u.uFxSizePx).toVar();
    If(P.element(13).lessThan(0.5), () => {
      const ax = u.uFxAxisX.mul(u.uResolution);
      const th = atan(ax.y, ax.x);
      const c = cos(th);
      const s = sin(th);
      q.assign(vec2(c.mul(q.x).sub(s.mul(q.y)), s.mul(q.x).add(c.mul(q.y))));
      hb.assign(vec2(abs(c).mul(hb.x).add(abs(s).mul(hb.y)), abs(s).mul(hb.x).add(abs(c).mul(hb.y))));
    });
    const H = max(hb.add(vec2(P.element(0), P.element(1)).mul(k)), vec2(0.5));
    const ext = select(P.element(4).lessThan(0.5), float(1e6),
      select(P.element(4).lessThan(1.5), P.element(5).mul(k), float(0.0)));
    const cov = srCoverage(q, H, P.element(2).mul(k), ext, P.element(6).mul(k), P.element(7),
      max(vec2(P.element(8), P.element(9)).mul(0.5).mul(k), vec2(0.25)), P.element(10).mul(k),
      max(P.element(11).mul(k), 0.25), P.element(12));
    const lines = cov.x.mul(clamp(P.element(3).div(100.0), 0.0, 1.0));
    const o = srcCol.mul(float(1.0).sub(lines)).add(vec4(C(0).mul(lines), lines));
    return o.mul(float(1.0).sub(cov.y)).add(vec4(C(1).mul(cov.y), cov.y));
  },

  vignette: ({ u, uvn, srcCol, helpers }) => {
    const P = u.uParams;
    // GLSL keys the falloff on fxLocal, so the darkening rides the layer box.
    const d = length(helpers.fxLocal(uvn).sub(0.5)).mul(1.41421);
    const v = smoothstep(P.element(1), P.element(1).sub(max(P.element(2), 1e-3)), d);
    const vig = mix(float(1.0), v, clamp(P.element(0), 0.0, 1.0));
    return vec4(unpremult(srcCol).mul(vig).mul(srcCol.a), srcCol.a);
  },

  sharpen: ({ u, uvn, srcCol }) => {
    const P = u.uParams;
    const px = vec2(1.0).div(u.uResolution);
    const cc = unpremult(srcCol);
    const nn = unpremult(u.uTexture.sample(uvn.add(vec2(0.0, px.y))));
    const ss = unpremult(u.uTexture.sample(uvn.sub(vec2(0.0, px.y))));
    const ee = unpremult(u.uTexture.sample(uvn.add(vec2(px.x, 0.0))));
    const ww = unpremult(u.uTexture.sample(uvn.sub(vec2(px.x, 0.0))));
    const col = clamp(cc.add(cc.mul(4.0).sub(nn).sub(ss).sub(ee).sub(ww).mul(P.element(0))), 0.0, 1.0);
    return vec4(col.mul(srcCol.a), srcCol.a);
  },

  rgbSplit: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    // Radial mode splits away from the layer's own centre (GLSL fxLocal).
    const dir = select(
      P.element(2).greaterThan(0.5),
      normalize(helpers.fxLocal(uvn).sub(0.5).add(1e-5)),
      vec2(cos(radians(P.element(1))), sin(radians(P.element(1)))),
    );
    const off = helpers.fxDir(dir.mul(P.element(0).div(helpers.fxRes())));
    const r = u.uTexture.sample(uvn.add(off));
    const g = u.uTexture.sample(uvn);
    const b = u.uTexture.sample(uvn.sub(off));
    const a = r.a.add(g.a).add(b.a).div(3.0);
    const col = vec3(unpremult(r).r, unpremult(g).g, unpremult(b).b);
    return vec4(col.mul(a), a);
  },

  grain: ({ u, uvn, srcCol, helpers }) => {
    const P = u.uParams;
    const tt = mix(float(0.0), floor(u.uTime.mul(24.0)), step05(P.element(2)));
    // Cell lattice matches GLSL gl_FragCoord; colour still comes from srcCol.
    const gp = floor(helpers.fxCoord(uvn).div(max(float(1.0), P.element(1))));
    const n = hash21(gp.add(tt.mul(1.37))).sub(0.5);
    const col = clamp(unpremult(srcCol).add(n.mul(P.element(0))), 0.0, 1.0);
    return vec4(col.mul(srcCol.a), srcCol.a);
  },

  scanlines: ({ u, uvn, srcCol, helpers }) => {
    const P = u.uParams;
    const base = srcCol;
    const sv = sin(helpers.fxLocal(uvn).y.add(u.uTime.mul(P.element(2)).mul(0.1))
      .mul(P.element(0)).mul(3.14159));
    const scan = float(1.0).sub(P.element(1).mul(float(0.5).sub(sv.mul(0.5))));
    return vec4(unpremult(base).mul(scan).mul(base.a), base.a);
  },

  flashBlink: ({ u, srcCol }) => {
    const P = u.uParams;
    const base = srcCol;
    const speed = max(P.element(0), 0.05);
    const mode = P.element(1);
    const style = P.element(2);
    const duty = clamp(P.element(3).div(100.0), 0.02, 0.98);
    const soft = clamp(P.element(4).div(100.0), 0.0, 1.0);

    const ph = u.uTime.mul(speed);
    const f = fract(ph);
    const k = float(0.0).toVar();
    If(mode.lessThan(0.5), () => {
      // Strobe: on for the duty fraction of each cycle, edges softened symmetrically.
      const e = max(soft.mul(0.5).mul(min(duty, float(1.0).sub(duty))), 1e-4);
      k.assign(smoothstep(0.0, e, f).mul(float(1.0).sub(smoothstep(duty.sub(e), duty, f))));
    }).ElseIf(mode.lessThan(1.5), () => {
      // Pulse: raised cosine, duty skews it brighter-longer or snappier.
      k.assign(pow(float(0.5).sub(cos(f.mul(6.2831853)).mul(0.5)), mix(float(2.4), float(0.45), duty)));
    }).Else(() => {
      // Flicker: random on/off per tick with a random level, duty = on-probability.
      const tick = floor(ph);
      k.assign(step(float(1.0).sub(duty), hash21(vec2(tick, 3.7)))
        .mul(mix(float(0.4), float(1.0), hash21(vec2(tick, 9.1)))));
    });
    k.assign(clamp(k, 0.0, 1.0));

    const out = vec4(0.0).toVar();
    If(style.greaterThan(0.5).and(style.lessThan(1.5)), () => {
      // Blink out: premultiplied scale, so fringes stay clean as content vanishes.
      out.assign(base.mul(float(1.0).sub(k)));
    }).Else(() => {
      // Exposure Pop is also the safe fallback for the removed legacy style 0.
      const col = clamp(unpremult(base).add(u.uColor.mul(k)), 0.0, 1.0);
      out.assign(vec4(col.mul(base.a), base.a));
    });
    return out;
  },

  radialBlur: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    // Centre is authored in the layer's box, so it stays on the same part of the
    // artwork wherever the layer sits.
    const dir = uvn.sub(helpers.fxFrame(vec2(P.element(1), P.element(2))));
    const strength = P.element(0).div(100.0);
    // GLSL runs a fixed 32-iteration loop with an `i >= n` break, so the tap
    // COUNT is dynamic while the bound is constant — reproduced exactly, since
    // both the divisor and the t spacing depend on n.
    const n = int(mix(float(12.0), float(32.0), clamp(u.uQuality, 0.0, 1.0)));
    const acc = vec4(0.0).toVar();
    Loop({ start: 0, end: 32, type: 'int' }, ({ i }) => {
      If(i.greaterThanEqual(n), () => { Break(); });
      const t = float(i).div(float(n.sub(1))).sub(0.5);
      acc.addAssign(u.uTexture.sample(uvn.sub(dir.mul(t).mul(strength))));
    });
    return acc.div(float(n));
  },


  fisheye: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const ar = helpers.fxAspect();
    const c = helpers.fxLocal(uvn).sub(0.5).mul(vec2(ar, 1.0)).toVar();
    c.mulAssign(float(1.0).add(P.element(0).mul(dot(c, c))));
    c.divAssign(max(P.element(1), 0.01));
    c.x.assign(c.x.div(ar));
    const p = c.add(0.5);
    // Outside the plate is empty, not the clamped edge texel.
    const outside = p.x.lessThan(0.0).or(p.x.greaterThan(1.0))
      .or(p.y.lessThan(0.0)).or(p.y.greaterThan(1.0));
    const out = vec4(0.0).toVar();
    If(outside.not(), () => { out.assign(u.uTexture.sample(helpers.fxFrame(p))); });
    return out;
  },

  shockwave: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const ar = helpers.fxAspect();
    const lp = helpers.fxLocal(uvn);
    const d = lp.sub(vec2(P.element(3), P.element(4))).mul(vec2(ar, 1.0));
    const dist = length(d);
    const ring = fract(u.uTime.mul(P.element(0)).mul(0.35));
    const edge = smoothstep(max(P.element(1), 1e-3), 0.0, abs(dist.sub(ring)));
    const fade = float(1.0).sub(ring);
    const push = d.div(max(dist, 1e-4)).div(vec2(ar, 1.0))
      .mul(edge).mul(fade).mul(P.element(2).div(100.0));
    return u.uTexture.sample(helpers.fxFrame(lp.sub(push)));
  },

  waveRipple: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const lines = max(P.element(0), 1.0);
    const sharpv = max(P.element(1), 0.5);
    const lnMix = clamp(P.element(2).div(100.0), 0.0, 1.0);
    const ctMix = clamp(P.element(3).div(100.0), 0.0, 1.0);
    const rings = max(P.element(4), 1.0);
    const amp = P.element(5).div(100.0);
    const wscale = max(P.element(6), 0.2);
    const t = u.uTime.mul(P.element(7));
    const lp = helpers.fxLocal(uvn);
    const ar = helpers.fxAspect();
    const pos = vec2(lp.x.mul(ar), lp.y);

    const wob = wrFbm(vec2(pos.x.mul(wscale).mul(1.4), pos.y.mul(wscale).mul(0.5).add(t.mul(0.35))))
      .sub(0.5).mul(amp);
    const wob2 = wrFbm(vec2(pos.y.mul(wscale).mul(0.9).add(7.3), t.mul(0.28))).sub(0.5).mul(amp);
    const wuv = uvn.add(helpers.fxDir(vec2(wob.mul(0.012), wob2.mul(0.008))));
    const base = u.uTexture.sample(wuv);

    // Contour field: blurred coverage of the content (alpha × brightness). The
    // spiral is FIXED, deliberately — the field feeds the ring phase × ring
    // count, so pixel-level noise in it scrambles the stripes into speckle.
    const n = int(mix(float(10.0), float(20.0), clamp(u.uQuality, 0.0, 1.0)));
    const px = u.uResolution.y.mul(0.05).div(u.uResolution);
    const fsum = float(0.0).toVar();
    const fw = float(0.0).toVar();
    Loop({ start: 0, end: 20, type: 'int' }, ({ i }) => {
      If(i.greaterThanEqual(n), () => { Break(); });
      const fi = float(i);
      const r = sqrt(fi.add(0.5).div(float(n)));
      const an = fi.mul(2.399963);
      const sm = u.uTexture.sample(wuv.add(vec2(cos(an), sin(an)).mul(r).mul(px)));
      const w = float(1.0).sub(r.mul(0.7));
      fsum.addAssign(sm.a.mul(clamp(luma(unpremult(sm)).mul(1.5), 0.0, 1.0)).mul(w));
      fw.addAssign(w);
    });
    const field = fsum.div(max(fw, 1e-4));

    const horiz = lp.y.add(wob.mul(0.05)).mul(lines);
    const cont = float(1.0).sub(field).mul(rings).add(wob.mul(2.0));
    const phase = mix(horiz, cont, ctMix);
    const s01 = float(0.5).add(cos(phase.mul(6.2831853)).mul(0.5));
    const stripes = pow(s01, sharpv);

    return base.mul(mix(float(1.0), stripes, lnMix));
  },

  glitch: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const amt = P.element(0);
    const blk = max(float(2.0), P.element(1));
    const t = floor(u.uTime.mul(P.element(2).mul(6.0).add(0.001)));
    // Rows / tear geometry use GLSL's fragment axis; sampling stays on uvn.
    const lp = helpers.fxLocal(uvn);
    const row = floor(helpers.fxCoord(uvn).y.div(blk));
    const rnd = hash21(vec2(row, t));
    const lineGlitch = step(float(1.0).sub(amt.mul(0.6)), rnd);
    const shift = hash21(vec2(row.mul(1.7), t.mul(0.3))).sub(0.5).mul(amt).mul(0.12).mul(lineGlitch);
    const uv2 = helpers.fxFrame(vec2(fract(lp.x.add(shift)), lp.y));
    const cs = helpers.fxDir(vec2(P.element(3).div(helpers.fxRes().x).mul(amt.add(0.3)), 0.0));
    const g = u.uTexture.sample(uv2);
    const r = u.uTexture.sample(uv2.add(cs));
    const b = u.uTexture.sample(uv2.sub(cs));
    const a = r.a.add(g.a).add(b.a).div(3.0);
    const col = vec3(unpremult(r).r, unpremult(g).g, unpremult(b).b).toVar();
    col.addAssign(lineGlitch.mul(hash21(vec2(row, t.mul(2.1))).sub(0.5)).mul(amt).mul(0.35));
    return vec4(clamp(col, 0.0, 1.0).mul(a), a);
  },

  vhs: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const amt = P.element(0);
    const lp = helpers.fxLocal(uvn);
    const w = sin(lp.y.mul(120.0).add(u.uTime.mul(4.0))).mul(0.5)
      .add(sin(lp.y.mul(13.0).sub(u.uTime.mul(2.0))).mul(0.5));
    const dx = w.mul(P.element(1)).mul(0.01).mul(amt).toVar();
    const band = smoothstep(0.4, 0.5, sin(lp.y.mul(3.0).sub(u.uTime.mul(1.3))))
      .mul(step(0.6, fract(u.uTime.mul(0.7))));
    dx.addAssign(band.mul(amt).mul(0.03));
    const uv2 = helpers.fxFrame(vec2(fract(lp.x.add(dx)), lp.y));
    const cs = helpers.fxDir(vec2(P.element(2).div(helpers.fxRes().x), 0.0));
    const g = u.uTexture.sample(uv2);
    const r = u.uTexture.sample(uv2.add(cs));
    const b = u.uTexture.sample(uv2.sub(cs));
    const a = r.a.add(g.a).add(b.a).div(3.0);
    const col = vec3(unpremult(r).r, unpremult(g).g, unpremult(b).b).toVar();
    col.addAssign(hash21(helpers.fxCoord(uvn).mul(0.5).add(floor(u.uTime.mul(24.0)))).sub(0.5).mul(P.element(3)));
    col.mulAssign(float(1.0).sub(float(0.15).mul(amt)
      .mul(float(0.5).sub(sin(lp.y.mul(helpers.fxRes().y)).mul(0.5)))));
    return vec4(clamp(col, 0.0, 1.0).mul(a), a);
  },

  mirror: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const ar = helpers.fxAspect();
    const center = vec2(P.element(0), P.element(1));
    const lp = helpers.fxLocal(uvn);
    const p = lp.sub(center).mul(vec2(ar, 1.0));
    const angle = radians(P.element(2));
    const normal = vec2(cos(angle), sin(angle));
    const distanceToLine = dot(p, normal);
    const reflectedPoint = p.sub(normal.mul(distanceToLine.mul(2.0)));
    const reflectedUv = helpers.fxFrame(reflectedPoint.div(vec2(ar, 1.0)).add(center));

    const original = u.uTexture.sample(uvn);
    const reflected = u.uTexture.sample(clamp(reflectedUv, 0.0, 1.0)).toVar();

    const fadeAmt = clamp(P.element(5).div(100.0), 0.0, 1.0);
    If(fadeAmt.greaterThan(0.001), () => {
      const span = max(P.element(7).div(100.0), 0.001);
      const mode = P.element(6);
      const d = float(0.0).toVar();
      If(mode.lessThan(0.5), () => { d.assign(abs(distanceToLine).div(span)); })
        .ElseIf(mode.lessThan(1.5), () => { d.assign(float(1.0).sub(abs(distanceToLine).div(span))); })
        .ElseIf(mode.lessThan(2.5), () => { d.assign(float(1.0).sub(lp.y).div(span)); })
        .ElseIf(mode.lessThan(3.5), () => { d.assign(lp.y.div(span)); })
        .ElseIf(mode.lessThan(4.5), () => { d.assign(lp.x.div(span)); })
        .Else(() => { d.assign(float(1.0).sub(lp.x).div(span)); });
      const k = pow(clamp(d, 0.0, 1.0), max(P.element(8).div(100.0), 0.05));
      // Premultiplied fade: scaling rgba together keeps edges clean over
      // transparency.
      reflected.mulAssign(float(1.0).sub(fadeAmt.mul(k)));
    });

    const copiedSide = step(0.0, distanceToLine.mul(P.element(3)));
    const mirrored = mix(original, reflected, copiedSide);

    const feather = max(P.element(4).div(100.0), 1e-5);
    const awayFromSeam = smoothstep(0.0, feather, abs(distanceToLine));
    const seamAverage = mix(original, reflected, 0.5);
    return mix(seamAverage, mirrored, awayFromSeam);
  },

  opticsCompensation: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const fovDeg = clamp(P.element(0), 0.0, 179.0);
    const out = vec4(0.0).toVar();
    If(fovDeg.lessThan(0.05), () => {
      out.assign(u.uTexture.sample(uvn));
    }).Else(() => {
      const ar = helpers.fxAspect();
      const ctr = vec2(P.element(3), P.element(4));
      const p = helpers.fxLocal(uvn).sub(ctr).mul(vec2(ar, 1.0)).toVar();
      const halfW = float(0.5).mul(ar);
      const orient = int(P.element(1).add(0.5));
      const halfDim = select(orient.equal(int(0)), halfW,
        select(orient.equal(int(1)), float(0.5), length(vec2(halfW, 0.5))));
      const f = halfDim.div(max(tan(radians(fovDeg).mul(0.5)), 1e-5));
      const rev = P.element(2).greaterThan(0.5);
      // Fit solves s so the source's far corner lands exactly on the frame
      // corner: g(s·rc) = rc, i.e. s = g⁻¹(rc)/rc.
      const s = float(1.0).toVar();
      const rc = length(vec2(max(ctr.x, float(1.0).sub(ctr.x)).mul(ar),
        max(ctr.y, float(1.0).sub(ctr.y))));
      If(P.element(5).greaterThan(0.5), () => {
        const inv = select(rev, f.mul(tan(min(rc.div(f), 1.5533))), f.mul(atan(rc.div(f))));
        s.assign(inv.div(max(rc, 1e-6)));
      });
      s.divAssign(max(P.element(6), 0.01));
      const len = length(p);
      If(len.greaterThan(1e-6), () => {
        const r = len.mul(s);
        const rs = select(rev, f.mul(atan(r.div(f))), f.mul(tan(min(r.div(f), 1.5533))));
        p.mulAssign(rs.div(len));
      });
      const dst = vec2(p.x.div(ar), p.y).add(ctr);
      const outside = dst.x.lessThan(0.0).or(dst.x.greaterThan(1.0))
        .or(dst.y.lessThan(0.0)).or(dst.y.greaterThan(1.0));
      If(outside.not(), () => {
        // sampleClamped: outside the plate is empty, not the edge texel.
        const q = helpers.fxFrame(dst);
        const qOut = q.x.lessThan(0.0).or(q.x.greaterThan(1.0))
          .or(q.y.lessThan(0.0)).or(q.y.greaterThan(1.0));
        If(qOut.not(), () => { out.assign(u.uTexture.sample(q)); });
      });
    });
    return out;
  },

  waveWarp: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const ar = helpers.fxAspect();
    const lp = helpers.fxLocal(uvn);
    const p = lp.sub(0.5).mul(vec2(ar, 1.0));
    const direction = radians(P.element(3));
    const travel = vec2(cos(direction), sin(direction));
    const displacementDirection = vec2(travel.y.negate(), travel.x);
    const coordinate = dot(p, travel);
    const waveWidth = max(P.element(2).div(100.0), 0.001);
    const wavePhase = coordinate.div(waveWidth).mul(6.2831853)
      .sub(u.uTime.mul(P.element(5)).mul(6.2831853))
      .add(radians(P.element(4)));
    const wave = wwWave(wavePhase, P.element(0), P.element(7).div(100.0));

    // Pinning damps the wave at the edges of the layer's own box, so a warped
    // shape stays anchored at its own border rather than at the frame's.
    const edgeDistance = min(min(lp.x, float(1.0).sub(lp.x)), min(lp.y, float(1.0).sub(lp.y)));
    const pinning = P.element(6).div(100.0);
    const pinned = select(pinning.lessThanEqual(0.0001), float(1.0),
      smoothstep(float(0.0), pinning, edgeDistance));
    const sampleLocal = lp.sub(displacementDirection.mul(wave).mul(P.element(1).div(100.0))
      .mul(pinned).div(vec2(ar, 1.0)));
    return u.uTexture.sample(clamp(helpers.fxFrame(sampleLocal), 0.0, 1.0));
  },

  // warpStyles: twelve styles, a forward map and its INVERSE. The inverse is the
  // hard half — nine bend styles invert algebraically, inflate needs Newton on a
  // cubic, squeeze a 2D Newton because its axes are coupled, and twist a
  // BISECTION on Kepler's equation (Newton bolts to a far branch past |e| = 1).
  // All three helpers read uParams, so none of them may carry a layout.
  warpStyles: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const wsSafe = (d) => select(abs(d).lessThan(1e-4), select(d.lessThan(0.0), float(-1e-4), float(1e-4)), d);
    const st = int(P.element(0).add(0.5));
    const bend = P.element(1).mul(0.01);
    const dh = P.element(2).mul(0.01);
    const dv = P.element(3).mul(0.01);

    const wsFwd = (pIn) => {
      const c = pIn.mul(2.0).sub(1.0).toVar();
      const x = c.x.toVar();
      const y = c.y.toVar();
      const off = float(0.0).toVar();
      If(st.equal(int(0)), () => { off.assign(bend.negate().mul(float(1.0).sub(x.mul(x)))); })
        .ElseIf(st.equal(int(1)), () => { off.assign(bend.negate().mul(float(1.0).sub(x.mul(x))).mul(float(0.5).sub(y.mul(0.5)))); })
        .ElseIf(st.equal(int(2)), () => { off.assign(bend.negate().mul(float(1.0).sub(x.mul(x))).mul(float(0.5).add(y.mul(0.5)))); })
        .ElseIf(st.equal(int(3)), () => { off.assign(bend.negate().mul(float(1.0).sub(x.mul(x))).mul(float(0.75).sub(y.mul(0.25)))); })
        .ElseIf(st.equal(int(4)), () => { off.assign(bend.mul(float(1.0).sub(x.mul(x))).mul(y)); })
        .ElseIf(st.equal(int(5)), () => { off.assign(bend.mul(sin(x.mul(4.71238898))).mul(float(0.55).add(float(0.45).mul(float(0.5).add(y.mul(0.5)))))); })
        .ElseIf(st.equal(int(6)), () => { off.assign(bend.mul(sin(x.mul(6.28318531)))); })
        .ElseIf(st.equal(int(7)), () => { off.assign(bend.mul(y).mul(float(1.0).sub(abs(x)))); })
        .ElseIf(st.equal(int(8)), () => { off.assign(bend.negate().mul(float(0.5).add(x.mul(0.5))).mul(float(0.5).add(x.mul(0.5)))); });
      c.y.assign(c.y.add(off));
      If(st.equal(int(9)), () => {
        c.assign(c.mul(float(1.0).add(bend.mul(float(1.0).sub(float(0.35).mul(x.mul(x).add(y.mul(y))))))));
      }).ElseIf(st.equal(int(10)), () => {
        c.x.assign(c.x.mul(float(1.0).sub(bend.mul(float(1.0).sub(y.mul(y))))));
        c.y.assign(c.y.mul(float(1.0).sub(bend.mul(0.35).mul(float(1.0).sub(x.mul(x))))));
      }).ElseIf(st.equal(int(11)), () => {
        const a = bend.mul(y).mul(1.4);
        const sa = sin(a); const ca = cos(a);
        c.assign(vec2(ca.mul(c.x).sub(sa.mul(c.y)), sa.mul(c.x).add(ca.mul(c.y))));
      });
      c.x.assign(c.x.mul(float(1.0).add(dh.mul(c.y).mul(0.6))));
      c.y.assign(c.y.mul(float(1.0).add(dv.mul(c.x).mul(0.6))));
      return c.mul(0.5).add(0.5);
    };

    const wsInv = (pIn) => {
      const d = pIn.mul(2.0).sub(1.0);
      // Perspective first, and exactly: the forward pass scales y by the ALREADY
      // scaled x, so that x is the destination's own and both lines divide out.
      const cy = d.y.div(wsSafe(float(1.0).add(dv.mul(d.x).mul(0.6))));
      const cx = d.x.div(wsSafe(float(1.0).add(dh.mul(cy).mul(0.6))));
      const x = cx.toVar();
      const y = cy.toVar();
      If(st.lessThan(int(9)), () => {
        // The y offset is affine in y for all nine bend styles, so one divide
        // undoes every one of them.
        const A = bend.negate().mul(float(1.0).sub(x.mul(x)));
        const k0 = float(0.0).toVar();
        const k1 = float(0.0).toVar();
        If(st.equal(int(0)), () => { k0.assign(A); })
          .ElseIf(st.equal(int(1)), () => { k0.assign(A.mul(0.5)); k1.assign(A.mul(-0.5)); })
          .ElseIf(st.equal(int(2)), () => { k0.assign(A.mul(0.5)); k1.assign(A.mul(0.5)); })
          .ElseIf(st.equal(int(3)), () => { k0.assign(A.mul(0.75)); k1.assign(A.mul(-0.25)); })
          .ElseIf(st.equal(int(4)), () => { k1.assign(bend.mul(float(1.0).sub(x.mul(x)))); })
          .ElseIf(st.equal(int(5)), () => {
            const C = bend.mul(sin(x.mul(4.71238898)));
            k0.assign(C.mul(0.775)); k1.assign(C.mul(0.225));
          })
          .ElseIf(st.equal(int(6)), () => { k0.assign(bend.mul(sin(x.mul(6.28318531)))); })
          .ElseIf(st.equal(int(7)), () => { k1.assign(bend.mul(float(1.0).sub(abs(x)))); })
          .ElseIf(st.equal(int(8)), () => { k0.assign(bend.negate().mul(float(0.5).add(x.mul(0.5))).mul(float(0.5).add(x.mul(0.5)))); });
        y.assign(cy.sub(k0).div(wsSafe(float(1.0).add(k1))));
      }).ElseIf(st.equal(int(9)), () => {
        // Inflate is radial: direction survives, radius follows
        // r' = r(1+bend) - 0.35·bend·r³. Newton, clamped to the branch where it
        // still rises — past the turning point no preimage exists.
        const rp = length(vec2(cx, cy));
        If(rp.greaterThan(1e-5), () => {
          const rmax = float(4.0).toVar();
          If(bend.greaterThan(1e-4), () => { rmax.assign(sqrt(float(1.0).add(bend).div(bend.mul(1.05)))); });
          const r = min(rp.div(max(float(1.0).add(bend), 0.05)), rmax).toVar();
          for (let i = 0; i < 8; i += 1) {
            const g = r.mul(float(1.0).add(bend)).sub(bend.mul(0.35).mul(r).mul(r).mul(r)).sub(rp);
            const gp = float(1.0).add(bend).sub(bend.mul(1.05).mul(r).mul(r));
            r.assign(clamp(r.sub(g.div(wsSafe(gp))), float(0.0), rmax));
          }
          x.assign(cx.mul(r.div(rp)));
          y.assign(cy.mul(r.div(rp)));
        }).Else(() => { x.assign(0.0); y.assign(0.0); });
      }).ElseIf(st.equal(int(10)), () => {
        // Squeeze couples its axes — each scaled by a function of the OTHER — so
        // it needs a real 2D Newton.
        for (let i = 0; i < 8; i += 1) {
          const sx = float(1.0).sub(bend.mul(float(1.0).sub(y.mul(y))));
          const sy = float(1.0).sub(bend.mul(0.35).mul(float(1.0).sub(x.mul(x))));
          const rx = x.mul(sx).sub(cx);
          const ry = y.mul(sy).sub(cy);
          const j01 = bend.mul(2.0).mul(x).mul(y);
          const j10 = bend.mul(0.7).mul(x).mul(y);
          const det = wsSafe(sx.mul(sy).sub(j01.mul(j10)));
          const nx = clamp(x.sub(sy.mul(rx).sub(j01.mul(ry)).div(det)), -4.0, 4.0);
          const ny = clamp(y.sub(sx.mul(ry).sub(j10.mul(rx)).div(det)), -4.0, 4.0);
          x.assign(nx);
          y.assign(ny);
        }
      }).Else(() => {
        // Twist keeps the radius; only the angle is unknown, and phi = u + e·sin(u)
        // is Kepler's equation. BISECTION, not Newton: past |e| = 1 the twist folds
        // and Newton bolts to a far branch, while [phi-|e|, phi+|e|] always
        // straddles a root.
        const r = length(vec2(cx, cy));
        If(r.greaterThan(1e-6), () => {
          const phi = atan(cy, cx);
          const e = bend.mul(1.4).mul(r);
          const lo = phi.sub(abs(e)).toVar();
          const hi = phi.add(abs(e)).toVar();
          for (let i = 0; i < 24; i += 1) {
            const m = lo.add(hi).mul(0.5);
            const below = m.add(e.mul(sin(m))).sub(phi).lessThan(0.0);
            lo.assign(select(below, m, lo));
            hi.assign(select(below, hi, m));
          }
          const uu = lo.add(hi).mul(0.5);
          x.assign(r.mul(cos(uu)));
          y.assign(r.mul(sin(uu)));
        }).Else(() => { x.assign(0.0); y.assign(0.0); });
      });
      return vec2(x, y).mul(0.5).add(0.5);
    };

    const out = vec4(0.0).toVar();
    If(abs(P.element(1)).add(abs(P.element(2))).add(abs(P.element(3))).lessThan(0.05), () => {
      out.assign(u.uTexture.sample(uvn));
    }).Else(() => {
      // fxLocal is y-UP; the styles' box space is y-DOWN. Without this flip every
      // style is mirrored vertically.
      const lp0 = helpers.fxLocal(uvn);
      const lp = vec2(lp0.x, float(1.0).sub(lp0.y));
      const src = wsInv(lp);
      const offPlate = src.x.lessThan(-0.002).or(src.x.greaterThan(1.002))
        .or(src.y.lessThan(-0.002)).or(src.y.greaterThan(1.002));
      If(offPlate.not(), () => {
        // Re-applying the forward map proves this fragment really has a preimage:
        // three styles fold at extreme settings and a folded solve lands
        // somewhere arbitrary, which would smear a wrong sample across the frame.
        const back = wsFwd(src);
        If(distance(back, lp).lessThanEqual(0.01), () => {
          // One-pixel feather from the forward Jacobian rather than fwidth() — a
          // warp magnifies locally, so a fixed feather would smear where it
          // stretches.
          const h = float(1e-3);
          const jx = wsFwd(src.add(vec2(h, 0.0))).sub(back).div(h);
          const jy = wsFwd(src.add(vec2(0.0, h))).sub(back).div(h);
          const det = abs(wsSafe(jx.x.mul(jy.y).sub(jx.y.mul(jy.x))));
          const texel = vec2(1.0).div(max(u.uFxSizePx, vec2(1.0)));
          const w = clamp(vec2(
            abs(jy.y).mul(texel.x).add(abs(jy.x).mul(texel.y)),
            abs(jx.y).mul(texel.x).add(abs(jx.x).mul(texel.y)),
          ).div(det), vec2(1e-4), vec2(0.25));
          const m = smoothstep(vec2(0.0), w, src)
            .mul(vec2(1.0).sub(smoothstep(vec2(1.0).sub(w), vec2(1.0), src)));
          const edge = m.x.mul(m.y);
          If(edge.greaterThan(0.0), () => {
            out.assign(u.uTexture.sample(helpers.fxFrame(vec2(src.x, float(1.0).sub(src.y)))).mul(edge));
          });
        });
      });
    });
    return out;
  },

  // ── 08b: two-pass effects ────────────────────────────────────────────────
  // The pre-pass renders an intermediate into the scratch target (never shown
  // directly, hence no mix); the main pass reads it through uTexture while
  // uSource holds the effect's ORIGINAL input, which is what the uMix bypass
  // must fade back to.
  glow: ({ u, uvn, pass }) => {
    const P = u.uParams;
    const radius = max(P.element(2), 0.5).mul(u.uResolution.y.div(1080.0));
    const acc = vec4(0.0).toVar();
    const ws = float(0.0).toVar();
    const halfN = 24;
    if (pass === 'pre') {
      // Horizontal half of the separable blur, thresholded to the bright part.
      const thr = clamp(P.element(1), 0.0, 0.999);
      for (let i = 0; i <= 2 * halfN; i += 1) {
        // Node arithmetic, not JS: `exp(-2·t²)` must fold at f32 like the GLSL,
        // or the kernel differs in its last bits and a tight radius shows it.
        const t = float(i - halfN).div(float(halfN));
        const w = exp(float(-2.0).mul(t).mul(t));   // GLSL's association, exactly
        const suv = uvn.add(vec2(t.mul(2.0).mul(radius).div(u.uResolution.x), 0.0));
        const outside = suv.x.lessThan(0.0).or(suv.x.greaterThan(1.0))
          .or(suv.y.lessThan(0.0)).or(suv.y.greaterThan(1.0));
        const sm = select(outside, vec4(0.0), u.uTexture.sample(suv));
        const straight = unpremult(sm);
        const bright = max(float(0.0), luma(straight).sub(thr)).div(max(float(1.0).sub(thr), 1e-3));
        const premultBright = straight.mul(bright).mul(sm.a);
        acc.addAssign(vec4(premultBright, bright.mul(sm.a)).mul(w));
        ws.addAssign(w);
      }
      return acc.div(max(ws, 1e-4));
    }
    // Main: the vertical half, then composite over the ORIGINAL input.
    for (let i = 0; i <= 2 * halfN; i += 1) {
      const t = float(i - halfN).div(float(halfN));
      const w = exp(float(-2.0).mul(t).mul(t));   // GLSL's association, exactly
      const suv = uvn.add(vec2(0.0, t.mul(2.0).mul(radius).div(u.uResolution.y)));
      const outside = suv.x.lessThan(0.0).or(suv.x.greaterThan(1.0))
        .or(suv.y.lessThan(0.0)).or(suv.y.greaterThan(1.0));
      acc.addAssign(select(outside, vec4(0.0), u.uTexture.sample(suv)).mul(w));
      ws.addAssign(w);
    }
    const bloom = acc.div(max(ws, 1e-4));
    const base = u.uSource.sample(uvn);
    const glowCol = bloom.rgb.mul(P.element(0)).mul(u.uColor);
    const outPre = base.rgb.add(glowCol);
    const outA = clamp(base.a.add(bloom.a.mul(P.element(0))), 0.0, 1.0);
    return vec4(min(outPre, vec3(outA)), outA);
  },

  waveLines: ({ u, uvn, helpers, pass }) => {
    const P = u.uParams;
    const radius = max(P.element(8), 1.0).mul(u.uResolution.y.div(1080.0));
    const halfN = 24;

    if (pass === 'pre') {
      // Horizontal half of the coverage blur. wlMask picks what counts as
      // coverage: alpha, a luma threshold, or the min of the two.
      const wlMask = (sm) => {
        const mode = P.element(9);
        const threshold = clamp(P.element(10).div(100.0), 0.0, 0.99);
        const lumMask = smoothstep(threshold, float(1.0), luma(unpremult(sm))).mul(sm.a);
        const out = float(0.0).toVar();
        If(mode.greaterThan(0.5).and(mode.lessThan(1.5)), () => { out.assign(sm.a); })
          .ElseIf(mode.greaterThan(1.5), () => { out.assign(lumMask); })
          .Else(() => { out.assign(min(sm.a, lumMask)); });
        return out;
      };
      const acc = float(0.0).toVar();
      const ws = float(0.0).toVar();
      for (let i = 0; i <= 2 * halfN; i += 1) {
        const q = float(i - halfN).div(float(halfN));
        const w = exp(float(-2.0).mul(q).mul(q));
        const suv = uvn.add(vec2(q.mul(2.0).mul(radius).div(u.uResolution.x), 0.0));
        const outside = suv.x.lessThan(0.0).or(suv.x.greaterThan(1.0))
          .or(suv.y.lessThan(0.0)).or(suv.y.greaterThan(1.0));
        const sm = select(outside, vec4(0.0), u.uTexture.sample(suv));
        acc.addAssign(wlMask(sm).mul(w));
        ws.addAssign(w);
      }
      return vec4(acc.div(max(ws, 1e-4)));
    }

    // Main: the vertical half of the field, then the stripes over the ORIGINAL.
    const lines = max(P.element(0), 1.0);
    const lineSharp = max(P.element(1), 0.5);
    const lineMix = clamp(P.element(2).div(100.0), 0.0, 1.0);
    const contourMix = clamp(P.element(3).div(100.0), 0.0, 1.0);
    const rings = max(P.element(4), 1.0);
    const waveAmp = P.element(5).div(100.0);
    const waveScale = max(P.element(6), 0.2);
    const t = u.uTime.mul(P.element(7));

    const lp = helpers.fxLocal(uvn);
    const aspect = helpers.fxAspect();
    const pos = vec2(lp.x.mul(aspect), lp.y);
    const wob = wrFbm(vec2(pos.x.mul(waveScale).mul(1.4), pos.y.mul(waveScale).mul(0.5).add(t.mul(0.35))))
      .sub(0.5).mul(waveAmp);

    const acc = float(0.0).toVar();
    const ws = float(0.0).toVar();
    for (let i = 0; i <= 2 * halfN; i += 1) {
      const q = float(i - halfN).div(float(halfN));
      const w = exp(float(-2.0).mul(q).mul(q));
      const suv = uvn.add(vec2(0.0, q.mul(2.0).mul(radius).div(u.uResolution.y)));
      const outside = suv.x.lessThan(0.0).or(suv.x.greaterThan(1.0))
        .or(suv.y.lessThan(0.0)).or(suv.y.greaterThan(1.0));
      acc.addAssign(select(outside, float(0.0), u.uTexture.sample(suv).a).mul(w));
      ws.addAssign(w);
    }
    const field = acc.div(max(ws, 1e-4));

    const horizontal = lp.y.add(wob.mul(0.05)).mul(lines);
    const contour = float(1.0).sub(field).mul(rings).add(wob.mul(2.0));
    const phase = mix(horizontal, contour, contourMix);
    const stripeWave = float(0.5).add(cos(phase.mul(6.2831853)).mul(0.5));
    const stripes = pow(stripeWave, lineSharp);

    const base = u.uSource.sample(uvn);
    return base.mul(mix(float(1.0), stripes, lineMix));
  },

  auraBlur: ({ u, uvn, helpers, pass }) => {
    const P = u.uParams;
    // Shared by both passes: what counts as coverage — alpha, a luma threshold,
    // or the min of the two.
    const abMask = (sm) => {
      const mode = P.element(14);
      const threshold = clamp(P.element(15).div(100.0), 0.0, 0.99);
      const lumMask = smoothstep(threshold, float(1.0), luma(unpremult(sm))).mul(sm.a);
      const out = float(0.0).toVar();
      If(mode.greaterThan(0.5).and(mode.lessThan(1.5)), () => { out.assign(sm.a); })
        .ElseIf(mode.greaterThan(1.5), () => { out.assign(lumMask); })
        .Else(() => { out.assign(min(sm.a, lumMask)); });
      return out;
    };

    if (pass === 'pyramid') {
      // One separable half-pass of one pyramid level. The driver runs it six
      // times (H then V, three levels) with cumulative radii.
      const radius = max(P.element(24), 0.0);
      const vertical = P.element(25);
      const extractMask = P.element(26);
      const acc = float(0.0).toVar();
      const ws = float(0.0).toVar();
      for (let i = 0; i <= 48; i += 1) {
        const t = float(i - 24).div(float(24));
        const w = exp(float(-2.0).mul(t).mul(t));
        const off = select(vertical.greaterThan(0.5),
          vec2(0.0, t.mul(2.0).mul(radius).div(u.uResolution.y)),
          vec2(t.mul(2.0).mul(radius).div(u.uResolution.x), 0.0));
        const suv = uvn.add(off);
        const outside = suv.x.lessThan(0.0).or(suv.x.greaterThan(1.0))
          .or(suv.y.lessThan(0.0)).or(suv.y.greaterThan(1.0));
        const sm = select(outside, vec4(0.0), u.uTexture.sample(suv));
        acc.addAssign(select(extractMask.greaterThan(0.5), abMask(sm), sm.a).mul(w));
        ws.addAssign(w);
      }
      return vec4(acc.div(max(ws, 1e-4)));
    }

    // Main: sample the pyramid CONTINUOUSLY between levels, then colour it.
    const abLevel = (p, k) => {
      const out = float(0.0).toVar();
      const inside = p.x.greaterThanEqual(0.0).and(p.x.lessThanEqual(1.0))
        .and(p.y.greaterThanEqual(0.0)).and(p.y.lessThanEqual(1.0));
      If(inside, () => {
        const level = clamp(k, 0.0, 1.0).mul(3.0);
        out.addAssign(abMask(u.uSource.sample(p)).mul(max(float(0.0), float(1.0).sub(abs(level)))));
        out.addAssign(u.uTexture1.sample(p).a.mul(max(float(0.0), float(1.0).sub(abs(level.sub(1.0))))));
        out.addAssign(u.uTexture2.sample(p).a.mul(max(float(0.0), float(1.0).sub(abs(level.sub(2.0))))));
        out.addAssign(u.uTexture3.sample(p).a.mul(max(float(0.0), float(1.0).sub(abs(level.sub(3.0))))));
      });
      return out;
    };
    // uColors is a flat float array of 5 vec3s (that is how the app uploads it).
    const C = (i) => vec3(u.uColors.element(i * 3), u.uColors.element(i * 3 + 1), u.uColors.element(i * 3 + 2));

    const t = u.uTime;
    const lp = helpers.fxLocal(uvn);
    const aspect = helpers.fxAspect();
    const pos = vec2(lp.x.mul(aspect), lp.y);
    const n = wrFbm(vec2(
      pos.x.mul(max(P.element(3), 0.2)).sub(t.mul(P.element(4))),
      pos.y.mul(max(P.element(3), 0.2)).mul(0.35).add(3.7),
    ));
    const k = clamp(P.element(1).div(100.0)
      .add(n.sub(0.5).mul(2.0).mul(P.element(2).div(100.0)))
      .add(sin(t.mul(P.element(10)).mul(6.2831853)).mul(P.element(9).div(100.0)).mul(0.5)), 0.0, 1.0);

    const ca = clamp(P.element(6).div(100.0), 0.0, 1.0);
    const kR = clamp(k.mul(float(1.0).sub(ca.mul(0.35))), 0.0, 1.0);
    const kB = clamp(k.mul(float(1.0).add(ca.mul(0.70))).add(ca.mul(0.04)), 0.0, 1.0);
    const shift = vec2(P.element(8).div(100.0).mul(0.004), 0.0).mul(k);
    const aura = vec3(abLevel(uvn.add(shift), kR), abLevel(uvn, k), abLevel(uvn.sub(shift), kB));

    const core = smoothstep(0.12, 0.85, abLevel(uvn, k.mul(clamp(P.element(5).div(100.0), 0.0, 1.0))));

    const left = P.element(12).div(100.0);
    const right = max(left.add(0.001), P.element(13).div(100.0));
    const gx = clamp(lp.x.sub(left).div(right.sub(left)), 0.0, 1.0);
    const coreColor = select(gx.lessThan(0.5),
      mix(C(0), C(1), gx.mul(2.0)),
      mix(C(1), C(2), gx.sub(0.5).mul(2.0)));

    const haloField = aura.mul(float(1.0).sub(core));
    const haloTint = mix(C(4), C(3), smoothstep(0.06, 0.55, aura.g));
    const color = min(coreColor.mul(core).mul(P.element(11).div(100.0))
      .add(haloTint.mul(haloField).mul(P.element(7).div(100.0))), vec3(1.0));
    const alpha = clamp(max(color.r, max(color.g, color.b)), 0.0, 1.0);
    return vec4(color, alpha);
  },

  /*
   * Neon Glow — matrix row 12b. The first `usesPath` body: applyEffectUniforms
   * bakes the layer's outline into uLUT (a NEAREST float strip) and packs its
   * shape into slots 24-27, so the fragment walks baked SEGMENTS rather than
   * evaluating a path. Every blend between samples is done by hand here, exactly
   * as the GLSL does, because the LUT must not be filtered.
   */
  neonGlow: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const NG_MAX = 258;
    // One baked outline sample. glslMod, not mod: the lit window wraps past
    // sample 0 with a NEGATIVE index, where `%` would truncate the wrong way.
    const ngSample = (i) => {
      const n = P.element(24);
      const m = glslMod(i, n);
      return u.uLUT.sample(vec2(m.add(0.5).div(n), 0.5));
    };
    const src = u.uTexture.sample(uvn).toVar();
    const n = P.element(24);
    const out = vec4(0.0).toVar();

    // Exact bypass: no baked outline this frame, or no layer box.
    If(n.lessThan(2.0).or(u.uFxLayer.lessThan(0.5)), () => {
      out.assign(src);
    }).Else(() => {
      const pathClosed = P.element(25).greaterThan(0.5);
      const platePx = vec2(max(P.element(26), 1.0), max(P.element(27), 1.0)).toVar();

      // The trimmed run range, as arc fractions.
      const st = clamp(min(P.element(1), P.element(2)).div(100.0), 0.0, 1.0).toVar();
      const e = clamp(max(P.element(2).div(100.0), st.add(0.005)), 0.0, 1.0).toVar();
      const span = max(e.sub(st), 0.005).toVar();
      const fullClosed = pathClosed.and(span.greaterThanEqual(0.999));

      const phase = P.element(20);
      const head = P.element(21).lessThan(0.5).select(
        e,
        fullClosed.select(fract(phase), st.add(fract(phase).mul(span))),
      ).toVar();
      const trail = clamp(P.element(3).div(100.0), 0.01, 1.0).toVar();
      const trailLen = trail.mul(span).toVar();
      const fullLoop = fullClosed.and(trail.greaterThanEqual(0.995));

      // The lit run in baked-SEGMENT index space.
      const segTotal = pathClosed.select(n, n.sub(1.0)).toVar();
      const a1 = head.mul(segTotal).toVar();
      const a0 = a1.sub(trailLen.mul(segTotal)).toVar();
      If(fullLoop, () => { a0.assign(a1.sub(segTotal)); });
      If(fullClosed.not(), () => {
        a0.assign(max(a0, st.mul(segTotal)));
        a1.assign(min(a1, e.mul(segTotal)));
        a0.assign(min(a0, a1.sub(1e-4)));
      });

      const pos = helpers.fxLocal(uvn).mul(platePx).toVar();
      const dist = float(1e6).toVar();

      const first = floor(a0).toVar();
      // Loop-carried, and it must stay a NODE: assigning a JS value here would
      // freeze the first sample into the emitted code.
      const sa = ngSample(first).toVar();
      Loop(NG_MAX, ({ i }) => {
        const j = first.add(float(i)).toVar();
        If(j.greaterThanEqual(a1), () => { Break(); });
        const sb = ngSample(j.add(1.0)).toVar();
        // A sample flagged as a contour start begins the NEXT glyph, so the
        // arriving segment is a bridge — close the ring we are on instead.
        const q1 = sb.z.greaterThan(0.5).select(ngSample(sa.w).xy, sb.xy).toVar();
        const lo = max(j, a0).sub(j).toVar();
        const hi = min(j.add(1.0), a1).sub(j).toVar();
        If(hi.greaterThan(lo), () => {
          const c0 = mix(sa.xy, q1, lo).mul(platePx).toVar();
          const c1 = mix(sa.xy, q1, hi).mul(platePx).toVar();
          const pa = pos.sub(c0).toVar();
          const ba = c1.sub(c0).toVar();
          const hseg = clamp(dot(pa, ba).div(max(dot(ba, ba), 1e-6)), 0.0, 1.0).toVar();
          dist.assign(min(dist, length(pa.sub(ba.mul(hseg)))));
        });
        sa.assign(sb);
      });
      dist.assign(max(dist, 0.0));

      const coreR = P.element(4);
      const glowR = P.element(5);
      const inten = P.element(6).div(100.0).toVar();
      const srcLevel = P.element(8).div(100.0).toVar();

      // The neonCursor grade verbatim, alpha from the brightest channel.
      const gcol = clamp(hueShift(u.uColor, P.element(22)), 0.0, 1.0).toVar();
      const core = smoothstep(coreR, 0.0, dist).mul(10.0).toVar();
      const glow = glowR.div(max(dist, 1e-3)).mul(inten).toVar();
      const rawC = vec3(core).add(gcol.mul(glow)).toVar();
      const col = pow(float(1.0).sub(exp(rawC.negate())), vec3(0.4545)).toVar();
      const aRaw = core.add(glow.mul(max(gcol.r, max(gcol.g, gcol.b)))).toVar();
      const a = pow(float(1.0).sub(exp(aRaw.negate())), 0.4545).toVar();

      const face = src.mul(srcLevel).toVar();
      const halo = vec4(min(col.mul(a), vec3(a)), a).toVar();
      out.assign(halo.add(face.mul(float(1.0).sub(halo.a))));
    });
    return out;
  },

  /*
   * Lines Draw — matrix row 12c. Shares Neon Glow's entire path infrastructure
   * (usesPath → baked uLUT + slots 24-27); what is new is a LOCAL ARRAY: the
   * GLSL keeps a 20-point window in `vec2 pts[LD_N]`, written by one loop and
   * read by the next, which ports as `array('vec2', 20).toVar()`.
   */
  linesDraw: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const C = [0, 1, 2].map((i) => vec3(
      u.uColors.element(i * 3), u.uColors.element(i * 3 + 1), u.uColors.element(i * 3 + 2),
    ));
    const LD_N = 20;
    const LD_SEG = float(LD_N - 1);

    // Reads uLUT, so NO layout (§7b). It is called 3x20x8 = 480 times, but the
    // body is small, so §2's inlining cost does not bite the way it does for a
    // heavy noise helper.
    const ldPointAt = (t, n, closedF) => {
      const isClosed = closedF.greaterThan(0.5);
      const fi = select(isClosed, fract(t).mul(n), clamp(t, 0.0, 1.0).mul(n.sub(1.0))).toVar();
      const i0 = floor(fi).toVar();
      const f = fi.sub(i0).toVar();
      const i1 = i0.add(1.0).toVar();
      // Both indices are non-negative here (fract/clamp above), so plain float
      // mod() is the safe half of §8's rule — no floor-mod helper needed.
      i0.assign(select(isClosed, glslMod(i0, n), min(i0, n.sub(1.0))));
      i1.assign(select(isClosed, glslMod(i1, n), min(i1, n.sub(1.0))));
      const p0 = u.uLUT.sample(vec2(i0.add(0.5).div(n), 0.5)).xy;
      const p1 = u.uLUT.sample(vec2(i1.add(0.5).div(n), 0.5)).xy;
      return mix(p0, p1, f);
    };

    const src = u.uTexture.sample(uvn).toVar();
    const n = P.element(24);
    const out = vec4(0.0).toVar();

    If(n.lessThan(2.0).or(u.uFxLayer.lessThan(0.5)), () => {
      out.assign(src);
    }).Else(() => {
      const closedF = P.element(25);
      const isClosed = closedF.greaterThan(0.5);
      const platePx = vec2(max(P.element(26), 1.0), max(P.element(27), 1.0)).toVar();

      // Signed runner aux: |v| = speed width factor, sign = travel direction.
      const auxRaw = P.element(23);
      const widthF = clamp(abs(auxRaw), 0.0, 1.0).toVar();
      const dirS = select(auxRaw.lessThan(0.0), float(-1.0), float(1.0)).toVar();
      const phase = P.element(20);
      const head = select(isClosed, fract(phase), clamp(phase, 0.0, 1.0)).toVar();
      const trail = clamp(P.element(3).div(100.0), 0.02, 1.0).mul(max(widthF, 0.02)).toVar();
      const maxW = P.element(4);
      const K = clamp(P.element(2), 1.0, 8.0).toVar();
      const spread = P.element(8);
      const lagFrac = P.element(14).div(100.0).toVar();
      const glowR = P.element(9);
      const inten = P.element(10).div(100.0).toVar();
      const headBright = P.element(11).div(100.0).toVar();
      const eTaper = clamp(P.element(7), 0.02, 0.5).toVar();

      const pos = helpers.fxLocal(uvn).mul(platePx).toVar();
      const pts = array('vec2', LD_N).toVar();
      const lit = vec3(0.0).toVar();
      const aRaw = float(0.0).toVar();
      const roundFrac = P.element(15).div(100.0).toVar();

      Loop({ start: 0, end: 8, type: 'int' }, ({ i: k }) => {
        If(float(k).greaterThanEqual(K), () => { Break(); });
        const hk = head.sub(dirS.mul(trail).mul(lagFrac).mul(float(k))).toVar();
        // A FIXED spatial ring around the head, so at a stop every line collapses
        // to ITS OWN point. Radius jitter echoes the lab's random(-0.1, 0.1).
        const ang = float(6.2831853).mul(float(k)).div(max(K, 1.0)).add(0.9).toVar();
        const rr = select(
          K.lessThan(1.5), float(0.0),
          spread.mul(float(1.0).add(sin(float(k).mul(12.9898)).mul(0.25))),
        ).toVar();
        const offVec = vec2(cos(ang), sin(ang)).mul(rr).toVar();
        const d = max(roundFrac, trail.mul(0.5).div(LD_SEG)).toVar();

        Loop({ start: 0, end: LD_N, type: 'int' }, ({ i }) => {
          const t = hk.sub(dirS.mul(trail).mul(float(1.0).sub(float(i).div(LD_SEG)))).toVar();
          const ta = select(isClosed, t.sub(d), clamp(t.sub(d), 0.0, 1.0));
          const tb = select(isClosed, t, clamp(t, 0.0, 1.0));
          const tc = select(isClosed, t.add(d), clamp(t.add(d), 0.0, 1.0));
          const pp = ldPointAt(ta, n, closedF).mul(0.25)
            .add(ldPointAt(tb, n, closedF).mul(0.5))
            .add(ldPointAt(tc, n, closedF).mul(0.25));
          pts.element(i).assign(pp.mul(platePx).add(offVec));
        });

        // Signed distance to the variable-width ribbon.
        const best = float(1e6).toVar();
        const bestFrac = float(0.0).toVar();
        Loop({ start: 0, end: LD_N - 1, type: 'int' }, ({ i }) => {
          const pa = pos.sub(pts.element(i)).toVar();
          const ba = pts.element(i.add(1)).sub(pts.element(i)).toVar();
          const h = clamp(dot(pa, ba).div(max(dot(ba, ba), 1e-6)), 0.0, 1.0).toVar();
          const dd = length(pa.sub(ba.mul(h))).toVar();
          const fr = float(i).add(h).div(LD_SEG).toVar();
          const wHere = max(float(0.5).mul(maxW).mul(widthF).mul(ldTaperW(fr, eTaper)), 0.3).toVar();
          const m = dd.sub(wHere).toVar();
          If(m.lessThan(best), () => { best.assign(m); bestFrac.assign(fr); });
        });

        // Colours cycle 1→2→3 across the fan.
        const km = mod(float(k), 3.0).toVar();
        const lineCol = select(km.lessThan(0.5), C[0], select(km.lessThan(1.5), C[1], C[2])).toVar();
        const hb = headBright.mul(smoothstep(0.55, 1.0, bestFrac)).toVar();
        const fillCol = clamp(lineCol.add(hb), 0.0, 1.0).toVar();
        const fill = inverseSmoothstep(-1.0, 1.0, best).toVar();
        const glow = glowR.div(max(best, 1.0)).mul(inten).mul(0.12).toVar();
        lit.addAssign(fillCol.mul(fill).mul(2.0).add(lineCol.mul(glow)));
        aRaw.addAssign(fill.mul(2.0).add(glow.mul(max(lineCol.r, max(lineCol.g, lineCol.b)))));
      });

      // Neon Glow's tonemap + premultiplied "halo over face" composite.
      const col = pow(float(1.0).sub(exp(lit.negate())), vec3(0.4545)).toVar();
      const a = pow(float(1.0).sub(exp(aRaw.negate())), 0.4545).toVar();
      const srcLevel = P.element(12).div(100.0).toVar();
      const face = src.mul(srcLevel).toVar();
      const halo = vec4(min(col.mul(a), vec3(a)), a).toVar();
      out.assign(halo.add(face.mul(float(1.0).sub(halo.a))));
    });
    return out;
  },

  gradientBeam: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const C = (i) => vec3(u.uColors.element(i * 3), u.uColors.element(i * 3 + 1), u.uColors.element(i * 3 + 2));
    // Smoothed joins — a hard lerp between stops creases visibly at this scale.
    const gmbRamp = (tIn) => {
      const t = clamp(tIn, 0.0, 1.0);
      const a = smoothstep(0.0, 1.0, clamp(t.mul(2.0), 0.0, 1.0));
      const b = smoothstep(0.0, 1.0, clamp(t.mul(2.0).sub(1.0), 0.0, 1.0));
      return mix(mix(C(0), C(1), a), C(2), b);
    };

    const base = u.uTexture.sample(uvn);
    const speed = max(P.element(0), 0.05);
    const angle = radians(P.element(1));
    const blur01 = clamp(P.element(2).div(100.0), 0.0, 1.0);
    const width01 = clamp(P.element(3).div(100.0), 0.02, 2.0);
    const hold = max(P.element(4), 0.0);
    const opacity = clamp(P.element(5).div(100.0), 0.0, 1.0);
    const mode = P.element(6);
    const frostPx = max(P.element(7), 0.0);
    const beamType = P.element(8);
    const layerShow = clamp(P.element(9).div(100.0), 0.0, 1.0);

    const ar = helpers.fxAspect();
    const p = helpers.fxLocal(uvn).sub(0.5).mul(vec2(ar, 1.0));
    const dir = vec2(cos(angle), sin(angle));
    const nrm = vec2(dir.y.negate(), dir.x);
    const halfDiag = length(vec2(ar, 1.0)).mul(0.5);

    // One pass = travel + hold, off mod(uTime): a pure function of the playhead,
    // so preview and the deterministic export agree frame for frame.
    const travel = float(2.6).div(speed);
    const cycle = travel.add(hold);
    const prog = clamp(mod(u.uTime, cycle).div(travel), 0.0, 1.0);
    const glide = mix(prog, prog.mul(prog).mul(float(3.0).sub(prog.mul(2.0))), 0.65);

    const d = float(0.0).toVar();
    const rampPos = float(0.0).toVar();
    const halfW = width01.mul(halfDiag).mul(1.6).toVar();
    If(beamType.lessThan(0.5), () => {
      // Directional — kept byte-for-byte so saved projects do not shift.
      const centre = halfDiag.add(halfW).negate().add(halfDiag.add(halfW).mul(2.0).mul(glide));
      const sAcross = dot(p, dir).sub(centre);
      const q = dot(p, nrm);
      // Two slow folds so the leading edge is a lobed cloud, not a ruler line.
      const wob = sin(q.mul(2.3).add(u.uTime.mul(0.5))).mul(0.5)
        .add(sin(q.mul(4.1).sub(u.uTime.mul(0.31))).mul(0.5));
      d.assign(sAcross.add(wob.mul(halfW).mul(0.22)).div(halfW));
      rampPos.assign(float(0.5).add(q.div(max(halfDiag, 1e-3)).mul(0.52))
        .add(d.mul(0.26)).add(wob.mul(0.1)));
    }).Else(() => {
      // From Center, in the same aspect-corrected box space.
      halfW.assign(width01.mul(halfDiag).mul(0.9));
      const centre = halfW.mul(-0.72).add(halfDiag.add(halfW.mul(1.35)).mul(glide));
      const radius = length(p);
      const theta = atan(p.y, p.x);
      // Both guards matter: angular displacement at radius zero becomes spokes.
      const contourIn = smoothstep(halfW.mul(0.22), halfW.mul(1.05), centre);
      const originGuard = smoothstep(halfW.mul(0.05), halfW.mul(0.35), radius);
      const fold = sin(theta.mul(3.0).add(u.uTime.mul(0.7))).mul(0.55)
        .add(sin(theta.mul(5.0).sub(u.uTime.mul(0.42))).mul(0.26))
        .add(sin(theta.mul(2.0).add(1.2)).mul(0.19));
      const radialWob = fold.mul(halfW).mul(0.10).mul(contourIn).mul(originGuard);
      d.assign(radius.sub(centre).add(radialWob).div(max(halfW, 1e-4)));
      rampPos.assign(float(0.5).add(d.mul(0.55)));
    });

    const shape = mix(float(7.0), float(1.6), blur01);
    const env = exp(pow(max(abs(d), 1e-4), shape).mul(-2.2))
      .mul(float(1.0).sub(smoothstep(1.7, 3.1, abs(d))));
    const fade = smoothstep(0.0, 0.16, prog).mul(float(1.0).sub(smoothstep(0.66, 1.0, prog)));
    const k = clamp(env.mul(fade).mul(opacity), 0.0, 1.0);
    // Mask Original Layer — coverage ignores Intensity, same as the GLSL twin.
    const cover = clamp(env.mul(fade), 0.0, 1.0);
    const keep = mix(cover, float(1.0), layerShow);
    const beam = gmbRamp(rampPos);

    const baseCol = unpremult(base).toVar();
    const baseA = base.a.toVar();

    // Frost: blur the layers below, strongest at the beam's core.
    If(frostPx.greaterThan(0.01).and(k.greaterThan(0.002)), () => {
      const rad = frostPx.mul(k).div(helpers.fxRes());
      const n = int(mix(float(10.0), float(24.0), clamp(u.uQuality, 0.0, 1.0)));
      const acc = vec4(0.0).toVar();
      Loop({ start: 0, end: 24, type: 'int' }, ({ i }) => {
        If(i.greaterThanEqual(n), () => { Break(); });
        const fi = float(i);
        const rr = sqrt(fi.add(0.5).div(float(n)));
        const aa = fi.mul(2.399963);
        acc.addAssign(u.uTexture.sample(uvn.add(helpers.fxDir(vec2(cos(aa), sin(aa)).mul(rr).mul(rad)))));
      });
      const av = acc.div(float(n));
      baseCol.assign(unpremult(av));
      baseA.assign(av.a);
    });
    baseA.mulAssign(keep);

    const outCol = vec3(0.0).toVar();
    If(mode.lessThan(0.5), () => {                     // screen
      outCol.assign(float(1.0).sub(float(1.0).sub(baseCol).mul(float(1.0).sub(beam.mul(k)))));
    }).ElseIf(mode.lessThan(1.5), () => {              // add
      outCol.assign(baseCol.add(beam.mul(k)));
    }).ElseIf(mode.lessThan(2.5), () => {              // lighten
      outCol.assign(mix(baseCol, max(baseCol, beam), k));
    }).ElseIf(mode.lessThan(3.5), () => {              // soft light
      const b = mix(vec3(0.5), beam, k);
      outCol.assign(mix(
        baseCol.mul(b).mul(2.0).add(baseCol.mul(baseCol).mul(float(1.0).sub(b.mul(2.0)))),
        sqrt(max(baseCol, vec3(0.0))).mul(b.mul(2.0).sub(1.0)).add(baseCol.mul(2.0).mul(float(1.0).sub(b))),
        step(0.5, b),
      ));
    }).Else(() => {                                    // normal
      outCol.assign(mix(baseCol, beam, k));
    });

    // Where the layers below have no coverage the result is the beam itself, and
    // the beam lifts alpha — otherwise it vanishes in a webm-alpha export.
    const straight = mix(beam, clamp(outCol, 0.0, 1.0), baseA);
    const outA = clamp(baseA.add(k.mul(float(1.0).sub(baseA))), 0.0, 1.0);
    return vec4(straight.mul(outA), outA);
  },

  fastCameraWiggle: fastCameraWiggleBody,
  gradientSweep: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const C = (i) => vec3(u.uColors.element(i * 3), u.uColors.element(i * 3 + 1), u.uColors.element(i * 3 + 2));
    // GLSL's `out float aOut` becomes the w component: same two results, one return.
    const gswRamp = (uu) => {
      const c = mix(C(0), C(1), smoothstep(0.02, 0.24, uu)).toVar();
      c.assign(mix(c, C(2), smoothstep(0.24, 0.50, uu)));
      c.assign(mix(c, C(3), smoothstep(0.50, 0.76, uu)));
      c.assign(mix(c, C(4), smoothstep(0.76, 0.94, uu)));
      const a = mix(float(1.0), float(0.92), smoothstep(0.50, 0.76, uu)).toVar();
      a.assign(mix(a, float(0.45), smoothstep(0.76, 0.94, uu)));
      a.mulAssign(float(1.0).sub(smoothstep(0.92, 1.0, uu)));
      return vec4(c, a);
    };
    // EFFECT_PRELUDE's sampleClamped: empty outside the plate, not the edge texel.
    const sampleClamped = (p) => {
      const outside = p.x.lessThan(0.0).or(p.x.greaterThan(1.0))
        .or(p.y.lessThan(0.0)).or(p.y.greaterThan(1.0));
      return select(outside, vec4(0.0), u.uTexture.sample(p));
    };

    const base = u.uTexture.sample(uvn);
    const mode = P.element(0);
    const ar = helpers.fxAspect();
    const p = helpers.fxLocal(uvn).sub(0.5).mul(vec2(ar, 1.0));
    const dir = vec2(cos(radians(P.element(1))), sin(radians(P.element(1))));
    // Sweep length = the box's extent along the axis, so a diagonal band still
    // starts and ends fully off the artwork.
    const span = abs(dir.x).mul(ar).add(abs(dir.y));
    const R = max(span.mul(P.element(2)).div(200.0), 1e-3);
    const over = R.mul(1.15);

    const dur = max(P.element(5), 0.2);
    const gap = max(P.element(7), 0.0);
    const tt = select(P.element(6).greaterThan(0.5), mod(u.uTime, dur.add(gap)), u.uTime);
    const raw = tt.div(dur);
    const rc = clamp(raw, 0.0, 1.0);
    const e = P.element(4);
    const eased = float(0.0).toVar();
    If(e.lessThan(0.5), () => { eased.assign(float(1.0).sub(cos(rc.mul(3.14159265))).mul(0.5)); })
      .ElseIf(e.lessThan(1.5), () => { eased.assign(rc); })
      .ElseIf(e.lessThan(2.5), () => {
        eased.assign(select(rc.lessThan(0.5), rc.mul(rc).mul(rc).mul(4.0),
          float(1.0).sub(pow(rc.mul(-2.0).add(2.0), float(3.0)).div(2.0))));
      })
      .Else(() => { eased.assign(float(1.0).sub(pow(float(1.0).sub(rc), float(3.0)))); });
    const bandD = mix(span.mul(-0.5).sub(over), span.mul(0.5).add(over), eased);
    const d = dot(p, dir).sub(bandD);
    const back = d.negate();

    // Anti-snap envelopes: leftovers ramp in and dissolve rather than switching
    // off in one frame.
    const sAfter = max(raw.sub(1.0), 0.0).mul(dur);
    const tailLen = select(P.element(6).greaterThan(0.5), max(gap, 0.05), float(0.45));
    const fadeSec = min(float(0.6), tailLen.mul(0.85));
    const endK = float(1.0).sub(smoothstep(float(0.0), float(1.0), sAfter.div(max(fadeSec, 1e-3))));
    const inK = smoothstep(float(0.0), float(1.0), rc.mul(dur).div(min(float(0.35), dur.mul(0.25))));
    const env = min(inK, endK);
    const sf = clamp(P.element(12), 0.05, dur.mul(0.5));
    const sNow = rc.mul(dur);
    const dimEnv = smoothstep(float(0.0), sf, sNow).mul(float(1.0).sub(smoothstep(dur.sub(sf), dur, sNow)));
    const bf = min(float(0.2), sf);
    const beamEnv = smoothstep(float(0.0), bf, sNow).mul(float(1.0).sub(smoothstep(dur.sub(bf), dur, sNow)));

    // Focus ramp: defocused ahead of the band, soft ONLY just behind it, and the
    // whole ramp dissolves with the pass — otherwise the layer keeps a permanent
    // defocus after the sweep.
    const sc = helpers.fxRes().y.div(1080.0);
    const blurPx = select(d.greaterThanEqual(0.0),
      P.element(13).mul(sc).mul(smoothstep(R.mul(0.10), R.mul(1.00), d)),
      P.element(14).mul(sc).mul(smoothstep(R.mul(0.30), R.mul(1.10), d.negate()))
        .mul(float(1.0).sub(smoothstep(R.mul(1.10), R.mul(2.40), d.negate()))),
    ).mul(endK).toVar();
    If(mode.greaterThan(1.5), () => { blurPx.assign(0.0); });   // sheen never defocuses

    const glowAmt = P.element(15).div(100.0);
    const glowPx = P.element(16).mul(sc);
    const plate = vec4(base).toVar();
    const glowA = base.a.toVar();
    If(blurPx.greaterThan(0.4).or(glowAmt.greaterThan(0.01)), () => {
      const n = int(mix(float(14.0), float(28.0), clamp(u.uQuality, 0.0, 1.0)));
      const acc = vec4(0.0).toVar();
      const accG = float(0.0).toVar();
      const ws = float(0.0).toVar();
      Loop({ start: 0, end: 28, type: 'int' }, ({ i }) => {
        If(i.greaterThanEqual(n), () => { Break(); });
        const fi = float(i);
        const rr = sqrt(fi.add(0.5).div(float(n)));
        const aa = fi.mul(2.399963);
        const o = vec2(cos(aa), sin(aa)).mul(rr);
        const w = exp(rr.mul(rr).mul(-2.2));
        acc.addAssign(sampleClamped(uvn.add(helpers.fxDir(o.mul(blurPx.div(helpers.fxRes()))))).mul(w));
        accG.addAssign(sampleClamped(uvn.add(helpers.fxDir(o.mul(glowPx.div(helpers.fxRes()))))).a.mul(w));
        ws.addAssign(w);
      });
      If(blurPx.greaterThan(0.4), () => { plate.assign(acc.div(max(ws, 1e-4))); });
      glowA.assign(accG.div(max(ws, 1e-4)));
    });

    const core = clamp(P.element(3).div(100.0), 0.0, 0.95);
    const uu = clamp(clamp(abs(d).div(R), 0.0, 1.0).sub(core).div(max(float(1.0).sub(core), 1e-3)), 0.0, 1.0);
    const ramp = gswRamp(uu);
    const bandC = ramp.rgb;
    const strength = clamp(P.element(8).div(100.0), 0.0, 1.0)
      .mul(select(mode.greaterThan(1.5), beamEnv, endK));
    const bandA = ramp.a.mul(strength).mul(plate.a);

    // Analytic bloom: the band's OWN colour under a widened alpha profile —
    // sampling the ramp at the widened profile would shift everything toward the
    // core and paint a pale ring across the hot zone.
    const uG = clamp(clamp(abs(d).div(R.mul(1.6)), 0.0, 1.0).sub(core).div(max(float(1.0).sub(core), 1e-3)), 0.0, 1.0);
    const bloomA = gswRamp(uG).a.mul(strength).mul(glowA).mul(glowAmt);

    const fadeLen = max(span.mul(P.element(19)).div(100.0), 0.02);
    const alive = float(1.0).sub(smoothstep(float(0.0), fadeLen, back.sub(R)));
    const ringA = float(0.0).toVar();
    const swPx = P.element(17).mul(sc);
    If(swPx.greaterThan(0.1).and(mode.lessThan(1.5)), () => {
      const dil = float(0.0).toVar();
      for (let i = 0; i < 12; i += 1) {
        const aa = float(i * 0.5235988);
        dil.assign(max(dil, sampleClamped(uvn.add(helpers.fxDir(vec2(cos(aa), sin(aa)).mul(swPx.div(helpers.fxRes()))))).a));
      }
      const onS = smoothstep(R.mul(0.42), R.mul(0.92), back);
      ringA.assign(clamp(dil.sub(base.a), 0.0, 1.0).mul(P.element(18).div(100.0)).mul(onS).mul(alive).mul(env));
    });

    const out = vec4(0.0).toVar();
    If(mode.lessThan(0.5), () => {
      // Reveal: real pixels ramp in behind the band; band + outline + bloom add.
      const behind = smoothstep(R.mul(0.05), R.mul(0.75), d.negate());
      const rgb = plate.rgb.mul(behind).add(bandC.mul(bandA)).add(u.uColor.mul(ringA)).add(bandC.mul(bloomA));
      const aa = clamp(plate.a.mul(behind).add(bandA).add(ringA).add(bloomA), 0.0, 1.0);
      out.assign(vec4(min(rgb, vec3(aa)), aa));
    }).ElseIf(mode.lessThan(1.5), () => {
      // Silhouette: cool fill + band + outline only.
      const onC = smoothstep(R.mul(0.35), R.mul(0.90), back);
      const coolA = P.element(10).div(100.0).mul(onC).mul(alive).mul(env).mul(base.a);
      const rgb = C(4).mul(coolA).add(bandC.mul(bandA)).add(u.uColor.mul(ringA)).add(bandC.mul(bloomA));
      const aa = clamp(coolA.add(bandA).add(ringA).add(bloomA), 0.0, 1.0);
      out.assign(vec4(min(rgb, vec3(aa)), aa));
    }).Else(() => {
      // Sheen: content stays, dims away from the band, beam blends over it.
      const dim = P.element(11).div(100.0).mul(dimEnv).mul(smoothstep(R.mul(0.5), R.mul(1.4), abs(d)));
      const st = unpremult(base).mul(float(1.0).sub(dim)).toVar();
      const w = ramp.a.mul(clamp(P.element(8).div(100.0), 0.0, 1.0)).mul(beamEnv);
      const bm = P.element(9);
      If(bm.lessThan(0.5), () => { st.assign(st.add(bandC.mul(w))); })
        .ElseIf(bm.lessThan(1.5), () => { st.assign(float(1.0).sub(float(1.0).sub(st).mul(float(1.0).sub(bandC.mul(w))))); })
        .Else(() => { st.assign(mix(st, bandC, w)); });
      const rgb = clamp(st, 0.0, 1.0).mul(base.a).add(bandC.mul(bloomA).mul(beamEnv));
      const aa = clamp(base.a.add(bloomA.mul(beamEnv)), 0.0, 1.0);
      out.assign(vec4(min(rgb, vec3(aa)), aa));
    });
    return out;
  },
  fractalNoise: ({ u, uvn, helpers }) => {
    const P = u.uParams;
    const C = (i) => vec3(u.uColors.element(i * 3), u.uColors.element(i * 3 + 1), u.uColors.element(i * 3 + 2));
    const base = u.uTexture.sample(uvn);
    // The lattice must match GLSL's y-up gl_FragCoord. fxLocal does in both scopes:
    // a layer's box lands it on the GLSL axis, and an adjustment layer's chain now
    // runs on the same quad-plate orientation (runEffectChain's WebGPU axis flip) —
    // the frame-scope geo flip this used to need compensated the camera-axis plate.
    const lp = helpers.fxLocal(uvn);
    const p = lp.sub(0.5).mul(vec2(helpers.fxAspect(), 1.0));
    const kind = P.element(0);
    const octaves = P.element(4);
    const gain = P.element(5);
    const subRot = P.element(6);
    const soft = P.element(7);
    const ridge = P.element(8);
    const mass = P.element(9);
    const edge = P.element(10);
    const wisp = P.element(11);
    const theta = P.element(12).mul(u.uProgress).mul(6.28318530718);
    const evo = vec2(cos(theta), sin(theta)).mul(0.75);
    const dv = P.element(13).mul(u.uTime);
    const drift = vec2(dv.mul(cos(radians(P.element(14)))), dv.mul(sin(radians(P.element(14)))));
    const field = (pp) => fnField(pp, evo, P.element(1), P.element(2), P.element(3), drift, wisp);
    const fbm = (q, maxOct) => fnFbm(q, evo, float(maxOct), kind, octaves, gain, subRot, soft, ridge, mass, edge);

    const tone = (vIn) => {
      const v = vIn.sub(0.5).mul(P.element(15)).add(0.5).add(P.element(16)).toVar();
      v.assign(v.sub(P.element(17)).div(max(float(1.0).sub(P.element(17)), 1e-4)));
      const k = P.element(18).mul(5.0);
      If(k.greaterThan(0.0), () => {
        v.assign(float(1.0).sub(exp(k.negate().mul(max(v, 0.0)))).div(float(1.0).sub(exp(k.negate()))));
      });
      If(v.greaterThan(0.85), () => {
        const t = v.sub(0.85).div(0.15);
        const e2 = exp(t.mul(2.0));
        v.assign(e2.sub(1.0).div(e2.add(1.0)).mul(0.15).add(0.85));
      });
      return clamp(v, 0.0, 1.0);
    };

    const v = tone(fbm(field(p), 8)).toVar();
    v.assign(mix(v, float(1.0).sub(v), step(0.5, P.element(23))));

    // Lighting from the low-octave field, finite differences two pixels apart.
    const shade = float(0.0).toVar();
    If(P.element(19).greaterThan(0.0), () => {
      const dp = float(2.0).div(max(helpers.fxRes().y, 1.0));
      const l0 = fbm(field(p), 3);
      const lx = fbm(field(p.add(vec2(dp, 0.0))), 3);
      const ly = fbm(field(p.add(vec2(0.0, dp))), 3);
      const g = vec2(lx.sub(l0), ly.sub(l0)).div(dp).mul(0.7).toVar();
      g.divAssign(length(g).mul(0.5).add(1.0));
      const N = normalize(vec3(g.negate(), 1.0));
      const la = radians(P.element(20));
      const L = normalize(vec3(cos(la), sin(la), 0.9));
      shade.assign(dot(N, L).sub(L.z).mul(P.element(19)));
    });
    const vc = clamp(v.add(shade.mul(v)), 0.0, 1.0);
    const nc = mix(C(0), C(1), vc);
    const st = unpremult(base);
    const maskA = mix(float(1.0), v, step(0.5, P.element(22)));
    const m = P.element(21);

    const out = vec4(0.0).toVar();
    If(m.greaterThan(4.5), () => {
      // Over: exact premultiplied over of a cloud whose alpha is the field.
      const rgb = base.rgb.mul(float(1.0).sub(v)).add(nc.mul(v));
      const a = base.a.mul(float(1.0).sub(v)).add(v);
      out.assign(vec4(rgb.mul(maskA), a.mul(maskA)));
    }).Else(() => {
      const b = st;
      const s = nc;
      const bl = vec3(0.0).toVar();
      If(m.lessThan(0.5), () => {
        bl.assign(float(1.0).sub(float(1.0).sub(b).mul(float(1.0).sub(s))));
      }).ElseIf(m.lessThan(1.5), () => {
        bl.assign(b.add(s));
      }).ElseIf(m.lessThan(2.5), () => {
        bl.assign(b.mul(s));
      }).ElseIf(m.lessThan(3.5), () => {
        bl.assign(mix(b.mul(s).mul(2.0), float(1.0).sub(float(1.0).sub(b).mul(float(1.0).sub(s)).mul(2.0)), step(vec3(0.5), b)));
      }).Else(() => {
        bl.assign(float(1.0).sub(s.mul(2.0)).mul(b).mul(b).add(s.mul(2.0).mul(b)));
      });
      const a = base.a.mul(maskA);
      out.assign(vec4(clamp(bl, 0.0, 1.0).mul(a), a));
    });
    return out;
  },
};

// The Object family's twins live in their own file (they share a per-material kit
// of closures the rest of the registry has no use for) and are folded in here, so
// createEffectNodeMaterial finds them exactly like any other single-pass body.
Object.assign(BODIES, OBJECT_EFFECT_BODIES);
Object.assign(BODIES, GRID_LINES_BODIES);
Object.assign(BODIES, POSTERIZE_BODIES);
Object.assign(BODIES, STRIP_BODIES);

// Effects with a def.prePass / def.pyramidPass. Their MAIN pass fades back to
// uSource — the effect's original input — not to the half-built intermediate the
// pre-pass left in uTexture, which is what a low uMix would otherwise reveal.
const TWO_PASS = new Set(['glow', 'auraBlur', 'waveLines']);

/** Is this effect's main pass driven from uSource rather than uTexture? */
export function isTwoPassEffect(id) {
  return TWO_PASS.has(id);
}

/*
 * DECLARATIVE MULTI-PASS BODIES — the `def.passes` family.
 *
 * `createEffectNodeMaterial(id, 'pass:<key>')` had no branch at all, so the
 * effects built on `def.passes` (alphaChoker, crtMatrix, extract, lensPrism,
 * lightRays, longShadow, outlineBands) were unreachable no matter what
 * was written for them. The GLSL side has had this since it was written
 * (adjustmentEffects.js's buildEffectFragment), and the migration matrix recorded
 * the family as "built" because the LAB implements it — lab-ported is not
 * app-wired.
 *
 * Keyed `<effectId>:<passKey>`, flat rather than nested, so a missing pass is a
 * missing key and not a half-present object.
 *
 * BLUR_FX and MORPH_FX are SHARED by several effects' separable passes, so they
 * are written once here and referenced by name. Porting these two is what makes
 * the rest of the family a matter of writing each effect's `main` body.
 */

/** Separable gaussian. Params 24/25 = axis, 26 = radius px, 27 = channel mode. */
const blurPassBody = ({ u, uvn }) => {
  const P = u.uParams;
  const r = P.element(26).toVar();
  const mode = P.element(27);
  const out = vec4(0.0).toVar();
  If(r.lessThan(0.01), () => {
    out.assign(u.uTexture.sample(uvn));
  }).Else(() => {
    const stepv = vec2(P.element(24), P.element(25)).div(u.uResolution).toVar();
    const taps = select(u.uQuality.lessThan(0.75), float(12.0), float(20.0)).toVar();
    const acc = vec4(0.0).toVar();
    const ws = float(0.0).toVar();
    // 41 iterations centred on 20, `continue`-style skip outside the tap window —
    // the GLSL shape, kept so the weights fold in the same order.
    Loop({ start: int(0), end: int(41) }, ({ i }) => {
      const fi = float(i).sub(20.0);
      If(abs(fi).lessThanEqual(taps), () => {
        const t = fi.div(taps);
        const w = exp(t.mul(t).mul(-2.2));
        const suv = uvn.add(stepv.mul(t.mul(r)));
        const inside = suv.x.greaterThanEqual(0.0).and(suv.x.lessThanEqual(1.0))
          .and(suv.y.greaterThanEqual(0.0)).and(suv.y.lessThanEqual(1.0));
        const sm = inside.select(u.uTexture.sample(suv), vec4(0.0)).toVar();
        const chan = select(mode.greaterThan(1.5), vec4(sm.a),
          select(mode.greaterThan(0.5), vec4(sm.r), sm));
        acc.addAssign(chan.mul(w));
        ws.addAssign(w);
      });
    });
    out.assign(acc.div(max(ws, 1e-4)));
  });
  return out;
};

/** Separable morphology. 26 = radius px, 27 = erode(>0) / dilate(<=0). */
const morphPassBody = ({ u, uvn }) => {
  const P = u.uParams;
  const c = u.uTexture.sample(uvn).toVar();
  const r = P.element(26).toVar();
  const out = vec4(0.0).toVar();
  If(r.lessThan(0.01), () => {
    out.assign(c);
  }).Else(() => {
    const stepv = vec2(P.element(24), P.element(25)).div(u.uResolution).toVar();
    const erode = P.element(27);
    // Tap count follows the radius so the step stays sub-pixel: a fixed count
    // turns a wide dilation into a staircase.
    const taps = clamp(r.mul(select(u.uQuality.lessThan(0.75), float(0.5), float(1.0))),
      6.0, 24.0).toVar();
    const sampleAt = (suv) => {
      const inside = suv.x.greaterThanEqual(0.0).and(suv.x.lessThanEqual(1.0))
        .and(suv.y.greaterThanEqual(0.0)).and(suv.y.lessThanEqual(1.0));
      return inside.select(u.uTexture.sample(suv), vec4(0.0));
    };
    If(erode.greaterThan(0.0), () => {
      const acc = float(1.0).toVar();
      Loop({ start: int(0), end: int(49) }, ({ i }) => {
        const fi = float(i).sub(24.0);
        If(abs(fi).lessThanEqual(taps), () => {
          acc.assign(min(acc, sampleAt(uvn.add(stepv.mul(fi.div(taps).mul(r)))).a));
        });
      });
      out.assign(vec4(c.rgb, acc));
    }).Else(() => {
      // Dilate: the winning sample carries its COLOUR with it. Growing alpha
      // alone leaves the new band with the transparent source's rgb, which
      // unpremultiplies to black — a grown matte came back as a black fringe.
      const best = c.toVar();
      Loop({ start: int(0), end: int(49) }, ({ i }) => {
        const fi = float(i).sub(24.0);
        If(abs(fi).lessThanEqual(taps), () => {
          const sm = sampleAt(uvn.add(stepv.mul(fi.div(taps).mul(r)))).toVar();
          If(sm.a.greaterThan(best.a), () => { best.assign(sm); });
        });
      });
      out.assign(best);
    });
  });
  return out;
};

/*
 * Long Shadow's MAIN pass. Marches away from the light through the (optionally
 * pre-blurred) matte in uTexture1, collecting total coverage and the nearest
 * occluder distance, then styles the result four ways.
 *
 * `nearest` starts at 1.0 and only ever decreases, which is what makes the
 * fade/steps/ribbon styles read as distance from the caster rather than as a
 * plain alpha ramp. The GLSL's `if (a > 0.5) nearest = min(...)` is a
 * conditional assignment inside the march — reproduced as such, not folded into
 * an unconditional min, because an unoccluded tap must not pull it down.
 */
const longShadowMainBody = ({ u, uvn, helpers }) => {
  const P = u.uParams;
  const { fxDir, fxRes } = helpers;
  const C = (i) => vec3(u.uColors.element(i * 3), u.uColors.element(i * 3 + 1),
    u.uColors.element(i * 3 + 2));
  const src = u.uSource.sample(uvn).toVar();
  const ref = fxRes().y.div(1080.0);
  const len = P.element(0).mul(ref).toVar();
  // Direction rides the layer: a rotated title keeps its extrusion angle.
  // Ported VERBATIM — fxDir maps through the layer box axes, which are authored in
  // uvn's own space (boxHelpers), so the y-up → y-down change is already in them.
  // A hand-negated sin double-flipped it: on WebGPU the extrusion went up-left
  // where WebGL (and the preset thumbnails) go down-left, on every media layer.
  const dir = vec2(cos(radians(P.element(1))), sin(radians(P.element(1)))).toVar();
  const style = P.element(2);
  const fade = P.element(3).div(100.0);
  const persp = P.element(4).div(100.0);
  const stepCount = max(P.element(5), 2.0).toVar();
  const srcLevel = P.element(6).div(100.0);
  const over = P.element(7);
  const taps = select(u.uQuality.lessThan(0.75), float(32.0), float(64.0)).toVar();

  const cov = float(0.0).toVar();
  const nearest = float(1.0).toVar();
  Loop({ start: int(1), end: int(65) }, ({ i }) => {
    const fi = float(i);
    If(fi.greaterThan(taps), () => { Break(); });
    const t = fi.div(taps);
    const d = t.mul(len).mul(float(1.0).add(persp.mul(t).mul(1.6)));
    const q = uvn.sub(fxDir(dir.mul(d).div(fxRes())));
    const inside = q.x.greaterThanEqual(0.0).and(q.x.lessThanEqual(1.0))
      .and(q.y.greaterThanEqual(0.0)).and(q.y.lessThanEqual(1.0));
    const a = inside.select(u.uTexture1.sample(q), vec4(0.0)).a.toVar();
    cov.assign(max(cov, a));
    If(a.greaterThan(0.5), () => { nearest.assign(min(nearest, t)); });
  });

  const shA = cov.toVar();
  const shCol = vec3(0.0).toVar();
  If(style.lessThan(0.5), () => {                       // Solid
    shCol.assign(C(0));
    shA.mulAssign(float(1.0).sub(nearest.mul(fade)));
  }).ElseIf(style.lessThan(1.5), () => {                // Steps
    const q = floor(nearest.mul(stepCount)).div(stepCount);
    shCol.assign(mix(C(0), C(1), q));
    shA.mulAssign(float(1.0).sub(q.mul(fade)));
  }).ElseIf(style.lessThan(2.5), () => {                // Gradient
    shCol.assign(mix(C(0), C(1), nearest));
    shA.mulAssign(float(1.0).sub(nearest.mul(fade)));
  }).Else(() => {                                       // Ribbon
    const band = fract(nearest.mul(stepCount));
    shCol.assign(mix(C(0), C(1), step(0.5, band)));
    shA.mulAssign(float(1.0).sub(nearest.mul(fade)));
  });
  shA.assign(clamp(shA, 0.0, 1.0));

  const shadow = premult(clamp(shCol, 0.0, 1.0), shA).toVar();
  const face = src.mul(srcLevel).toVar();
  // Behind keeps the face readable (default); Over is for reveal moments.
  return select(over.greaterThan(0.5),
    shadow.add(face.mul(float(1.0).sub(shadow.a))),
    face.add(shadow.mul(float(1.0).sub(face.a))));
};

const PASS_BODIES = {
  'alphaChoker:morphX': morphPassBody,
  'alphaChoker:morphY': morphPassBody,
  // Edge Detect thickness: the mask rides all four channels, so the alpha-keyed
  // dilate grows it and the colour channels come along (same as the GLSL side).
  'edgeDetect:dilX': morphPassBody,
  'edgeDetect:dilY': morphPassBody,
  'alphaChoker:featherX': blurPassBody,
  'alphaChoker:featherY': blurPassBody,
  'longShadow:softX': blurPassBody,
  'longShadow:softY': blurPassBody,
  'longShadow:main': longShadowMainBody,
  ...EXTRA_PASS_BODIES,
  ...DOUBLE_EXPOSURE_PASS_BODIES,
  ...FILM_STOCK_PASS_BODIES,
  ...FAST_BLUR_PASS_BODIES,
  ...RADIAL_FAST_BLUR_PASS_BODIES,
  ...ASCII_PASS_BODIES,
  ...PIXELATE_PASS_BODIES,
};
for (const key of BLUR_PASS_KEYS) {
  if (!PASS_BODIES[key]) PASS_BODIES[key] = blurPassBody;
}

/** Is there a node body for this effect's declarative pass? */
export function hasEffectPassBody(effectId, passKey) {
  return Object.prototype.hasOwnProperty.call(PASS_BODIES, `${effectId}:${passKey}`);
}

/** Effect ids that have a node body yet — the port is family by family. */
export function hasEffectNodeBody(id) {
  if (Object.prototype.hasOwnProperty.call(BODIES, id)) return true;
  return Object.keys(PASS_BODIES).some((key) => key.startsWith(`${id}:`));
}

/**
 * Node-material twin of createEffectMaterial(). `pass` mirrors the GLSL side:
 * 'main' crossfades src↔fx by uMix, 'pre'/'pyramid' render the intermediate
 * straight out, and a two-pass effect's main fades back to uSource (the effect's
 * ORIGINAL input) rather than to the half-built intermediate.
 */
/**
 * A CUSTOM effect, written in TSL by the user.
 *
 * It receives exactly what a built-in body receives — `u` (the whole uniform
 * bank), `uvn` (the y-flipped fragment coordinate the built-ins use, not uv()),
 * `srcCol` and the layer-box `helpers` — so a custom effect can centre and phase
 * itself on the LAYER rather than the frame, which is the thing the fx helpers
 * exist for. The framework still applies the `uMix` blend, so Amount behaves
 * identically to every built-in.
 *
 * Returns `{ material, error }`; a broken shader must not stop the render loop.
 */
export function createCustomEffectNodeMaterial(source, pass = 'main') {
  const { u, facade } = makeUniforms();
  const helpers = boxHelpers(u);
  // VALIDATE EAGERLY — `Fn()` defers its closure, so compiling inside it means a
  // broken shader reports nothing here and throws mid-render instead. This
  // stand-in compile surfaces syntax and name errors at creation time.
  {
    const check = compileUserTsl(source, {
      u, uvn: vec2(0.0, 0.0), srcCol: vec4(0.0), helpers, pass, ...u,
    });
    if (check.error) return { material: null, error: check.error };
  }
  try {
    const fragment = Fn(() => {
      const uvn = screenCoordinate.xy.div(u.uResolution);
      const geoUv = vec2(screenCoordinate.x, screenSize.y.sub(screenCoordinate.y)).div(u.uResolution);
      const srcCol = u.uTexture.sample(uvn);
      const { node, error } = compileUserTsl(source, {
        u, uvn, geoUv, srcCol, helpers, pass, ...u,
      });
      if (error) throw new Error(error);
      if (pass === 'pre' || pass === 'pyramid') return node;
      return mix(srcCol, node, clamp(u.uMix, 0.0, 1.0));
    });
    const material = new THREE.MeshBasicNodeMaterial();
    material.fragmentNode = fragment();
    material.transparent = true;
    material.blending = THREE.NoBlending;
    material.depthTest = false;
    material.depthWrite = false;
    material.forceSinglePass = true;
    material.uniforms = facade;
    return { material, error: null };
  } catch (err) {
    return { material: null, error: String(err.message || err) };
  }
}

/**
 * Stable cache suffix for a resolved flip map (`uTexture:1,uSource:0,…`).
 * Empty / all-false maps return '' so single-pass materials keep their old keys.
 */
export function effectFlipCacheKey(flips) {
  if (!flips || typeof flips !== 'object') return '';
  const parts = Object.keys(flips).sort()
    .filter((k) => flips[k])
    .map((k) => `${k}:1`);
  return parts.length ? `|${parts.join(',')}` : '';
}

/*
 * INSTALLED EFFECT PACKAGES (Effects SDK) bring their shading as a node function,
 * carried on the registry def (`def.fragmentNode`, or one per pass in
 * `def.passes`), never compiled from strings. It is called inside the material's
 * Fn like a built-in body, with one named context instead of the raw uniform
 * bank: params and colours by the KEY the package declared (localEffects.js
 * assigned their slots), its pass inputs and images by name, the full TSL
 * namespace so the package imports nothing, and the same layer-box helpers
 * built-ins use. `uv` is the built-ins' `uvn` — sample with it; use `geoUv` for
 * Y-up maths that must agree with GLSL (hash lattices, angles).
 */
const PACKAGE_INPUT_SAMPLERS = ['uTexture', 'uTexture1', 'uTexture2', 'uTexture3'];
const PACKAGE_WRAPS = { clamp: THREE.ClampToEdgeWrapping, repeat: THREE.RepeatWrapping, mirror: THREE.MirroredRepeatWrapping };

// A package image as a WebGPU texture, made once per loaded revision (the image
// is decoded by localEffects.js; the WebGL side makes its own from it). Stored
// premultiplied like every plate the chain passes around, and flipped so it is
// addressed Y-UP, as in GLSL: a package samples it at a y-up position —
// fxLocal(uv) inside the layer, geoUv across the frame — and the same position
// reads the same texel on both engines. Measured: unflipped, an image placed
// with fxLocal came out upside down on WebGPU only.
function packageImageTexture(spec) {
  if (!spec.gpuTexture) {
    const tex = new THREE.Texture(spec.image);
    tex.flipY = true;
    tex.premultiplyAlpha = true;
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = PACKAGE_WRAPS[spec.wrap] || THREE.ClampToEdgeWrapping;
    const filter = spec.filter === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter;
    tex.magFilter = filter;
    tex.minFilter = filter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    spec.gpuTexture = tex;
  }
  return spec.gpuTexture;
}

function packageEffectBody(def, passKey = null) {
  const pass = passKey ? (def.passes || []).find((p) => p.key === passKey) : null;
  const unit = pass || def;
  if (typeof unit?.fragmentNode !== 'function') return null;
  const slots = new Map();
  const colorSlots = new Map();
  for (const p of def.params || []) {
    if (p.type === 'color' && Number.isInteger(p.colorSlot)) colorSlots.set(p.key, p.colorSlot);
    else if (Number.isInteger(p.slot)) slots.set(p.key, p.slot);
  }
  const inputs = pass ? pass.inputNames : ['source'];
  const images = new Map((def.textures || []).map((t) => [t.key, t]));
  return ({ u, uvn, geoUv, srcCol, helpers }) => {
    const input = (name) => {
      const at = inputs.indexOf(name);
      if (at < 0) throw new Error(`"${name}" is not an input of ${pass ? `pass "${pass.label}"` : 'this effect'} (inputs: ${inputs.join(', ')})`);
      const sampler = u[PACKAGE_INPUT_SAMPLERS[at]];
      return { sample: (at2) => sampler.sample(at2) };
    };
    return unit.fragmentNode({
      tsl: TSL,
      uv: uvn,
      geoUv,
      src: srcCol,
      sample: (at) => u.uTexture.sample(at),
      input,
      param: (key) => {
        if (!slots.has(key)) throw new Error(`unknown param "${key}"`);
        return u.uParams.element(slots.get(key));
      },
      color: (key) => {
        if (!colorSlots.has(key)) throw new Error(`unknown colour param "${key}"`);
        const at = colorSlots.get(key) * 3;
        return vec3(u.uColors.element(at), u.uColors.element(at + 1), u.uColors.element(at + 2));
      },
      texture: (key, at) => {
        const spec = images.get(key);
        if (!spec) throw new Error(`unknown texture "${key}"`);
        if (!spec.image) throw new Error(`texture "${key}" has not loaded`);
        return texture(packageImageTexture(spec), at ?? geoUv);
      },
      time: u.uTime,
      progress: u.uProgress,
      resolution: u.uResolution,
      quality: u.uQuality,
      ...helpers,
    });
  };
}

// Build a package's node graph (each pass, when it has passes) once with
// stand-in inputs. Fn() defers its body, so without this a broken package would
// only fail mid-render; control flow (If/Loop) needs a current stack, which a
// throwaway one provides here.
export function validatePackageEffectBody(def) {
  const units = def.passes ? def.passes.map((p) => p.key) : [null];
  const previous = TSL.getCurrentStack();
  try {
    for (const passKey of units) {
      TSL.setCurrentStack(new THREE.StackNode());
      const { u } = makeUniforms();
      const body = packageEffectBody(def, passKey);
      if (!body) return `${passKey ? `pass "${def.passes.find((p) => p.key === passKey).label}": ` : ''}no fragmentNode`;
      try {
        const node = body({ u, uvn: vec2(0.0, 0.0), geoUv: vec2(0.0, 0.0), srcCol: vec4(0.0), helpers: boxHelpers(u) });
        if (!node || node.isNode !== true) throw new Error('fragmentNode must return a vec4 node');
      } catch (err) {
        const label = passKey ? def.passes.find((p) => p.key === passKey).label : null;
        return `${label ? `pass "${label}": ` : ''}${String(err?.message || err)}`;
      }
    }
    return null;
  } finally {
    TSL.setCurrentStack(previous);
  }
}

export function createEffectNodeMaterial(effectId, pass = 'main', flips = null, packageDef = null) {
  /*
   * `pass:<key>` selects a DECLARATIVE pass body. Checked before BODIES so an
   * effect can have passes without a single-pass body — which is the shape every
   * member of the def.passes family has.
   *
   * `flips` is reserved for per-binding RT specialization (lab 08c). The app's
   * plain screenCoordinate UV already matches isolate sampling; a blanket
   * yup+flip-all for passes broke sdfLensBlur/crtMatrix. Directional marches
   * that assume GLSL y-up negate their Y in the body instead.
   */
  const passKey = typeof pass === 'string' && pass.startsWith('pass:') ? pass.slice(5) : null;
  // An installed package answers for its own passes (localEffects.js).
  const body = packageDef?.isLocal
    ? packageEffectBody(packageDef, passKey)
    : passKey
      ? PASS_BODIES[`${effectId}:${passKey}`]
      : BODIES[effectId];
  if (!body) return null;
  const { u, facade } = makeUniforms(flips, { lutNearest: PATH_LUT_IDS.has(effectId) });
  const helpers = boxHelpers(u);

  const fragment = Fn(() => {
    const uvn = screenCoordinate.xy.div(u.uResolution);
    const geoUv = vec2(screenCoordinate.x, screenSize.y.sub(screenCoordinate.y)).div(u.uResolution);
    const srcCol = u.uTexture.sample(uvn);
    const fxCol = body({ u, uvn, geoUv, srcCol, helpers, pass, passKey });
    if (pass === 'pre' || pass === 'pyramid' || (passKey && passKey !== 'main')) return fxCol;
    const base = (pass === 'mainFromSource' || TWO_PASS.has(effectId) || passKey === 'main')
      ? u.uSource.sample(uvn) : srcCol;
    return mix(base, fxCol, clamp(u.uMix, 0.0, 1.0));
  });

  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = fragment();
  material.transparent = true;
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  material.forceSinglePass = true;
  material.uniforms = facade;
  material.userData.effectFlips = flips ? { ...flips } : null;
  return material;
}
