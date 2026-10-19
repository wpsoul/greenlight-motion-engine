/*
 * TSL bodies for the declarative `def.passes` family (matrix 08c) plus
 * Fast Camera Wiggle. Kept beside adjustmentEffectNodes.js so that file's
 * single-pass catalogue stays readable; the Player still reaches these
 * through PASS_BODIES / BODIES in that module.
 */
import {
  Fn, If, Loop, Break, int,
  vec2, vec3, vec4, float,
  mix, clamp, abs, max, min, mod, fract, floor, exp, sin, cos, tan,
  pow, sqrt, length, normalize, smoothstep, step, select, atan,
  screenCoordinate, screenSize, dot,
} from 'three/tsl';

const RAD = 3.141592653589793 / 180;

const luma = Fn(([c]) => dot(c, vec3(0.2126, 0.7152, 0.0722)))
  .setLayout({ name: 'pbLuma', type: 'float', inputs: [{ name: 'c', type: 'vec3' }] });
const hash21 = Fn(([pIn]) => {
  const p = fract(pIn.mul(vec2(123.34, 456.21))).toVar();
  p.addAssign(dot(p, p.add(45.32)));
  return fract(p.x.mul(p.y));
}).setLayout({ name: 'pbHash21', type: 'float', inputs: [{ name: 'pIn', type: 'vec2' }] });
const unpremult = Fn(([c]) => c.rgb.div(max(c.a, 1e-4)))
  .setLayout({ name: 'pbUnpremult', type: 'vec3', inputs: [{ name: 'c', type: 'vec4' }] });
const premult = Fn(([c, a]) => vec4(c.mul(clamp(a, 0.0, 1.0)), clamp(a, 0.0, 1.0)))
  .setLayout({
    name: 'pbPremult', type: 'vec4',
    inputs: [{ name: 'c', type: 'vec3' }, { name: 'a', type: 'float' }],
  });

const P = (u, i) => u.uParams.element(i);
const C = (u, i) => vec3(u.uColors.element(i * 3), u.uColors.element(i * 3 + 1), u.uColors.element(i * 3 + 2));
const sampleClamped = (samp, suv) => {
  const inside = suv.x.greaterThanEqual(0.0).and(suv.x.lessThanEqual(1.0))
    .and(suv.y.greaterThanEqual(0.0)).and(suv.y.lessThanEqual(1.0));
  return inside.select(samp.sample(suv), vec4(0.0));
};
const outside01 = (s) => s.x.lessThan(0.0).or(s.x.greaterThan(1.0)).or(s.y.lessThan(0.0)).or(s.y.greaterThan(1.0));

const jfaEnc = Fn(([uvIn]) => {
  const q = clamp(uvIn, 0.0, 1.0).mul(255.0);
  return vec4(floor(q.x).div(255.0), fract(q.x), floor(q.y).div(255.0), fract(q.y));
}).setLayout({ name: 'pbJfaEnc', type: 'vec4', inputs: [{ name: 'uvIn', type: 'vec2' }] });

const jfaDec = Fn(([e]) => vec2(
  floor(e.x.mul(255.0).add(0.5)).add(e.y),
  floor(e.z.mul(255.0).add(0.5)).add(e.w),
).div(255.0)).setLayout({ name: 'pbJfaDec', type: 'vec2', inputs: [{ name: 'e', type: 'vec4' }] });

const prismSpectral = Fn(([t]) => clamp(
  vec3(1.0).sub(pow(abs(vec3(t).sub(vec3(0.75, 0.5, 0.25))).mul(2.4), vec3(2.0))), 0.0, 1.0,
)).setLayout({ name: 'pbPrismSpectral', type: 'vec3', inputs: [{ name: 't', type: 'float' }] });

const sdlFill = Fn(([x, size, edge]) => float(1.0).sub(smoothstep(size.sub(edge), size.add(edge), x)))
  .setLayout({
    name: 'pbSdlFill', type: 'float',
    inputs: [{ name: 'x', type: 'float' }, { name: 'size', type: 'float' }, { name: 'edge', type: 'float' }],
  });

const fcwHash = Fn(([nIn]) => {
  // GLSL is `fract(n * 0.1031 + 0.113)`. Metal reassociates a plain mul-add;
  // a dot() form forces a fused mul-add and diverges (lab 08c `fcwFma` bisect).
  // Keep the split mul/add so WebGPU matches WebGL's shake field.
  const n = fract(nIn.mul(0.1031).add(0.113)).toVar();
  const a = n.add(33.33).toVar();
  n.mulAssign(a);
  const b = n.add(n).toVar();
  n.mulAssign(b);
  return fract(n);
}).setLayout({ name: 'pbFcwHash', type: 'float', inputs: [{ name: 'nIn', type: 'float' }] });

const fcwNoise = Fn(([t, seed]) => {
  const i = floor(t).toVar();
  const f = fract(t).toVar();
  const uu = f.mul(f).mul(f).mul(f.mul(f.mul(6.0).sub(15.0)).add(10.0)).toVar();
  const a = fcwHash(mod(i, 8192.0).add(seed)).toVar();
  const b = fcwHash(mod(i.add(1.0), 8192.0).add(seed)).toVar();
  return mix(a, b, uu).mul(2.0).sub(1.0);
}).setLayout({
  name: 'pbFcwNoise', type: 'float',
  inputs: [{ name: 't', type: 'float' }, { name: 'seed', type: 'float' }],
});

const fcwFbm = Fn(([t, seed, rough, oct]) => {
  const amp = float(1.0).toVar();
  const f = float(1.0).toVar();
  const sum = float(0.0).toVar();
  const norm = float(0.0).toVar();
  Loop({ start: int(0), end: int(4) }, ({ i }) => {
    If(float(i).greaterThanEqual(oct), () => { Break(); });
    sum.addAssign(amp.mul(fcwNoise(t.mul(f), seed.add(float(i).mul(101.3)))));
    norm.addAssign(amp);
    amp.mulAssign(rough);
    f.mulAssign(2.17);
  });
  return sum.div(max(norm, 1e-4));
}).setLayout({
  name: 'pbFcwFbm', type: 'float',
  inputs: [
    { name: 't', type: 'float' }, { name: 'seed', type: 'float' },
    { name: 'rough', type: 'float' }, { name: 'oct', type: 'float' },
  ],
});

const exChannel = (m, c, sa) => select(
  m.lessThan(0.5), luma(c),
  select(m.lessThan(1.5), c.r,
    select(m.lessThan(2.5), c.g,
      select(m.lessThan(3.5), c.b,
        select(m.lessThan(4.5), sa,
          select(m.lessThan(5.5), max(max(c.r, c.g), c.b),
            select(max(max(c.r, c.g), c.b).lessThanEqual(0.0001), float(0.0),
              max(max(c.r, c.g), c.b).sub(min(min(c.r, c.g), c.b))
                .div(max(max(c.r, c.g), c.b)))))))));

export function fastCameraWiggleBody({ u, uvn, helpers }) {
  const { fxLocal, fxFrame } = helpers;
  const amount = P(u, 0).div(100.0).toVar();
  const out = vec4(0.0).toVar();
  If(amount.lessThanEqual(0.0001), () => {
    out.assign(u.uTexture.sample(uvn));
  }).Else(() => {
    const freq = max(P(u, 1), 0.01).toVar();
    const rough = clamp(P(u, 2).div(100.0), 0.05, 0.95).toVar();
    const xw = P(u, 3).div(100.0).toVar();
    const yw = P(u, 4).div(100.0).toVar();
    const rotAmt = P(u, 5).mul(RAD).mul(amount).toVar();
    const zoomAmt = P(u, 6).div(100.0).mul(amount).toVar();
    const seed = P(u, 7).mul(13.7).toVar();
    const shutter = P(u, 8);
    const phase = P(u, 10);
    const edge = P(u, 11);
    const oct = select(u.uQuality.lessThan(0.75), float(2.0), float(4.0)).toVar();
    const base = amount.mul(0.10).toVar();
    const offX = base.mul(xw).toVar();
    const offY = base.mul(yw).toVar();
    const cover = float(1.0).toVar();
    If(edge.greaterThan(0.5).and(edge.lessThan(1.5)), () => {
      const aspect0 = u.uResolution.x.div(max(u.uResolution.y, 1.0)).toVar();
      const fxw = min(0.45, offX.div(aspect0)).toVar();
      const fyh = min(0.45, offY).toVar();
      const sOff = max(float(1.0).div(float(1.0).sub(fxw.mul(2.0))), float(1.0).div(float(1.0).sub(fyh.mul(2.0)))).toVar();
      const r = min(1.5707, abs(rotAmt)).toVar();
      const sRot = abs(cos(r)).add(aspect0.mul(abs(sin(r)))).toVar();
      const zMin = max(0.3, float(1.0).sub(zoomAmt)).toVar();
      cover.assign(min(4.0, sOff.mul(sRot).div(zMin)).mul(1.02));
    });
    const taps = clamp(floor(P(u, 9).add(0.5)), 4.0, 64.0).toVar();
    If(u.uQuality.lessThan(0.75), () => { taps.assign(max(2.0, floor(taps.mul(0.5)))); });
    If(shutter.lessThan(0.5), () => { taps.assign(1.0); });
    const shutterT = shutter.div(360.0).div(30.0).toVar();
    const aspect = u.uResolution.x.div(max(u.uResolution.y, 1.0)).toVar();
    const pivot = u.uFxOrigin;
    const p = uvn.sub(pivot).mul(vec2(aspect, 1.0)).toVar();
    // GLSL keys shutter jitter on gl_FragCoord (y-up). Plain screenCoordinate
    // disagrees on V and drifts the tap set; match the lab's axis.
    const fc = vec2(screenCoordinate.x, screenSize.y.sub(screenCoordinate.y));
    const j = fract(sin(dot(fc, vec2(12.9898, 78.233))).mul(43758.5453)).toVar();
    const acc = vec4(0.0).toVar();
    const ws = float(0.0).toVar();
    Loop({ start: int(0), end: int(64) }, ({ i }) => {
      If(float(i).greaterThanEqual(taps), () => { Break(); });
      const f = select(taps.greaterThan(1.5), float(i).add(j.mul(0.999)).div(taps), float(0.0)).toVar();
      const ts = u.uTime.sub(shutterT.mul(select(phase.greaterThan(0.5), f.sub(0.5), f))).toVar();
      const dx = offX.mul(fcwFbm(ts.mul(freq), seed.add(11.0), rough, oct)).toVar();
      const dy = offY.mul(fcwFbm(ts.mul(freq).mul(1.13), seed.add(37.0), rough, oct)).toVar();
      const rr = rotAmt.mul(fcwFbm(ts.mul(freq).mul(0.71), seed.add(71.0), rough, oct)).toVar();
      const zz = max(0.15, zoomAmt.mul(fcwFbm(ts.mul(freq).mul(0.53), seed.add(93.0), rough, oct)).add(1.0)).toVar();
      const q0 = p.sub(vec2(dx, dy)).toVar();
      const ct = cos(rr).toVar();
      const st = sin(rr).toVar();
      const q = vec2(q0.x.mul(ct).add(q0.y.mul(st)), q0.x.negate().mul(st).add(q0.y.mul(ct)))
        .div(zz.mul(cover)).toVar();
      const suv = q.div(vec2(aspect, 1.0)).add(pivot).toVar();
      const m = abs(fract(fxLocal(suv).mul(0.5).add(0.5)).mul(2.0).sub(1.0));
      const mirrored = u.uTexture.sample(fxFrame(m));
      const coverS = u.uTexture.sample(clamp(suv, 0.0, 1.0));
      const transparent = sampleClamped(u.uTexture, suv);
      acc.addAssign(select(edge.lessThan(0.5), mirrored, select(edge.lessThan(1.5), coverS, transparent)));
      ws.addAssign(1.0);
    });
    const res = acc.div(max(ws, 1e-4)).toVar();
    res.rgb.assign(min(res.rgb, vec3(res.a)));
    out.assign(res);
  });
  return out;
}

/*
 * Bloom's pyramid (matrix 08c family). Twins of BLOOM_DOWN_FX / BLOOM_UP_FX and
 * the bright/streak/main fragments in adjustmentEffects.js. Each pass renders at
 * half its source's resolution, so one SOURCE texel is 1/(2·uResolution) in the
 * down legs and 2/uResolution in the up legs. The streak samples through
 * sampleClamped so the taps stay in uniform control flow (WGSL forbids sampling
 * in a per-fragment branch); its out-of-bounds taps still feed ws, matching the
 * GLSL, which accumulates the same way for exactly this parity.
 */
const bloomStretch = (u) => {
  const an = clamp(P(u, 6).div(100.0), -1.0, 1.0);
  return vec2(max(an, 0.0).mul(1.2).add(1.0), max(an.negate(), 0.0).mul(1.2).add(1.0));
};

const bloomBright = ({ u, uvn }) => {
  const s = u.uTexture.sample(uvn).toVar();
  const straight = unpremult(s).toVar();
  const br = max(straight.r, max(straight.g, straight.b)).toVar();
  const thr = clamp(P(u, 0), 0.0, 0.99).toVar();
  const knee = max(thr.mul(clamp(P(u, 1), 0.01, 1.0)), 1e-4).toVar();
  const soft = clamp(br.sub(thr).add(knee), 0.0, knee.mul(2.0)).toVar();
  soft.assign(soft.mul(soft).div(knee.mul(4.0)));
  const w = max(max(soft, br.sub(thr)).div(max(br, 1e-4)), 0.0);
  return vec4(straight.mul(w).mul(s.a), w.mul(s.a));
};

const bloomDown = ({ u, uvn }) => {
  const h = bloomStretch(u).div(u.uResolution.mul(2.0)).toVar();
  const s = u.uTexture.sample(uvn).mul(4.0)
    .add(u.uTexture.sample(uvn.add(vec2(h.x.negate(), h.y.negate()))))
    .add(u.uTexture.sample(uvn.add(vec2(h.x, h.y.negate()))))
    .add(u.uTexture.sample(uvn.add(vec2(h.x.negate(), h.y))))
    .add(u.uTexture.sample(uvn.add(h)));
  return s.div(8.0);
};

const bloomUp = ({ u, uvn }) => {
  const h = bloomStretch(u).mul(2.0).div(u.uResolution).toVar();
  const s = u.uTexture1.sample(uvn.add(vec2(h.x.mul(-2.0), 0.0)))
    .add(u.uTexture1.sample(uvn.add(vec2(h.x.mul(2.0), 0.0))))
    .add(u.uTexture1.sample(uvn.add(vec2(0.0, h.y.mul(-2.0)))))
    .add(u.uTexture1.sample(uvn.add(vec2(0.0, h.y.mul(2.0)))))
    .add(u.uTexture1.sample(uvn.add(vec2(h.x.negate(), h.y)))
      .add(u.uTexture1.sample(uvn.add(h)))
      .add(u.uTexture1.sample(uvn.add(vec2(h.x.negate(), h.y.negate()))))
      .add(u.uTexture1.sample(uvn.add(vec2(h.x, h.y.negate()))))
      .mul(2.0));
  return u.uTexture.sample(uvn).add(s.div(12.0).mul(P(u, 24)));
};

const bloomStreak = ({ u, uvn }) => {
  const an = clamp(P(u, 6).div(100.0), -1.0, 1.0).toVar();
  const dir = select(an.greaterThanEqual(0.0), vec2(1.0, 0.0), vec2(0.0, 1.0)).toVar();
  const len = abs(an).mul(0.35).add(0.10).toVar();
  const jit = hash21(screenCoordinate.xy).sub(0.5).toVar();
  const acc = vec4(0.0).toVar();
  const ws = float(0.0).toVar();
  for (let arm = 0; arm < 2; arm += 1) {
    const d = arm === 0 ? dir : dir.negate();
    const w = float(1.0).toVar();
    for (let i = 1; i <= 20; i += 1) {
      w.mulAssign(0.93);
      acc.addAssign(sampleClamped(u.uTexture, uvn.add(d.mul(len).mul(float(i).add(jit).div(20.0)))).mul(w));
      ws.addAssign(w);
    }
  }
  return acc.div(max(ws, 1.0)).mul(2.0);
};

const bloomMain = ({ u, uvn }) => {
  const src = u.uSource.sample(uvn).toVar();
  const radius = clamp(P(u, 3), 1.0, 4.0).toVar();
  const norm = float(1.0)
    .add(clamp(radius.sub(1.0), 0.0, 1.0))
    .add(clamp(radius.sub(2.0), 0.0, 1.0))
    .add(clamp(radius.sub(3.0), 0.0, 1.0));
  const bl = u.uTexture1.sample(uvn).div(norm).toVar();
  const an = clamp(P(u, 6).div(100.0), -1.0, 1.0).toVar();
  bl.addAssign(u.uTexture2.sample(uvn).mul(step(0.01, abs(an))).mul(abs(an)).mul(1.2));
  const gain = P(u, 2).div(100.0).toVar();
  const b = bl.rgb.mul(gain).toVar();
  const l = luma(b).toVar();
  b.assign(max(mix(vec3(l), b, P(u, 4).div(100.0)), 0.0));
  b.assign(mix(b, vec3(l).mul(u.uColor).mul(1.6), clamp(P(u, 5).div(100.0), 0.0, 1.0)));
  const outA = clamp(src.a.add(clamp(bl.a.mul(gain), 0.0, 1.0)), 0.0, 1.0).toVar();
  // Mirrors the GLSL blend ladder: identity at zero bloom, transparent pixels
  // keep the raw glow (Dodge blends back to Add by src alpha for the halo).
  const bm = P(u, 7).toVar();
  const col = src.rgb.add(b).toVar();
  If(bm.greaterThan(0.5).and(bm.lessThan(1.5)), () => {
    col.assign(src.rgb.add(b.mul(vec3(1.0).sub(src.rgb))));
  }).ElseIf(bm.greaterThan(1.5).and(bm.lessThan(2.5)), () => {
    col.assign(max(src.rgb, b));
  }).ElseIf(bm.greaterThan(2.5).and(bm.lessThan(3.5)), () => {
    const dodge = min(src.rgb.div(max(vec3(1.0).sub(min(b, vec3(0.96))), vec3(0.04))), vec3(1.0));
    col.assign(mix(src.rgb.add(b), dodge, src.a));
  }).ElseIf(bm.greaterThan(3.5), () => {
    col.assign(b);
    outA.assign(clamp(bl.a.mul(gain), 0.0, 1.0));
  });
  return vec4(min(col, vec3(outA)), outA);
};

/* ── Copy Color Profile (html/copy-color-profile.html) ─────────────────────
   Twin of CCP_LIB / CCP_STATS_FX / CCP_MAIN_FX in adjustmentEffects.js. The
   colour-space and packing helpers are pure functions of their inputs, so they
   keep layouts; the pass bodies read uniforms and stay closures. */
const ccpSrgbToLin = Fn(([c]) => mix(c.div(12.92), pow(c.add(0.055).div(1.055), vec3(2.4)), step(0.04045, c)))
  .setLayout({ name: 'ccpSrgbToLin', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }] });
const ccpLinToSrgb = Fn(([cIn]) => {
  const c = max(cIn, 0.0);
  return mix(c.mul(12.92), pow(c, vec3(1.0 / 2.4)).mul(1.055).sub(0.055), step(0.0031308, c));
}).setLayout({ name: 'ccpLinToSrgb', type: 'vec3', inputs: [{ name: 'cIn', type: 'vec3' }] });
const ccpLinToOklab = Fn(([c]) => {
  const l = pow(max(dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)), 0.0), 1.0 / 3.0);
  const m = pow(max(dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)), 0.0), 1.0 / 3.0);
  const s = pow(max(dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005)), 0.0), 1.0 / 3.0);
  const lms = vec3(l, m, s);
  return vec3(
    dot(lms, vec3(0.2104542553, 0.7936177850, -0.0040720468)),
    dot(lms, vec3(1.9779984951, -2.4285922050, 0.4505937099)),
    dot(lms, vec3(0.0259040371, 0.7827717662, -0.8086757660)),
  );
}).setLayout({ name: 'ccpLinToOklab', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }] });
const ccpOklabToLin = Fn(([c]) => {
  const l0 = dot(c, vec3(1.0, 0.3963377774, 0.2158037573));
  const m0 = dot(c, vec3(1.0, -0.1055613458, -0.0638541728));
  const s0 = dot(c, vec3(1.0, -0.0894841775, -1.2914855480));
  const lms = vec3(l0.mul(l0).mul(l0), m0.mul(m0).mul(m0), s0.mul(s0).mul(s0));
  return vec3(
    dot(lms, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
    dot(lms, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
    dot(lms, vec3(-0.0041960863, -0.7034186147, 1.7076147010)),
  );
}).setLayout({ name: 'ccpOklabToLin', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }] });
// space: 0 = Oklab, 1 = YCbCr (BT.709 on the gamma signal), 2 = sRGB as is.
const ccpToSpace = Fn(([c, space]) => {
  const out = vec3(c).toVar();
  If(space.lessThan(0.5), () => {
    out.assign(ccpLinToOklab(ccpSrgbToLin(c)));
  }).ElseIf(space.lessThan(1.5), () => {
    const y = luma(c);
    out.assign(vec3(y, c.b.sub(y).div(1.8556), c.r.sub(y).div(1.5748)));
  });
  return out;
}).setLayout({ name: 'ccpToSpace', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }, { name: 'space', type: 'float' }] });
const ccpFromSpace = Fn(([c, space]) => {
  const out = vec3(c).toVar();
  If(space.lessThan(0.5), () => {
    out.assign(ccpLinToSrgb(ccpOklabToLin(c)));
  }).ElseIf(space.lessThan(1.5), () => {
    const r = c.x.add(c.z.mul(1.5748));
    const b = c.x.add(c.y.mul(1.8556));
    const g = c.x.sub(r.mul(0.2126)).sub(b.mul(0.0722)).div(0.7152);
    out.assign(vec3(r, g, b));
  });
  return out;
}).setLayout({ name: 'ccpFromSpace', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }, { name: 'space', type: 'float' }] });
// 16-bit in two RGBA8 channels (hi, lo); signed values ride as (v + 1) / 2.
const ccpEnc16 = Fn(([v]) => {
  const q = clamp(v, 0.0, 1.0).mul(65535.0);
  const hi = floor(q.div(256.0));
  const lo = floor(q.sub(hi.mul(256.0)).add(0.5));
  return vec2(hi, lo).div(255.0);
}).setLayout({ name: 'ccpEnc16', type: 'vec2', inputs: [{ name: 'v', type: 'float' }] });
const ccpDec16 = Fn(([e]) => floor(e.x.mul(255.0).add(0.5)).mul(256.0).add(floor(e.y.mul(255.0).add(0.5))).div(65535.0))
  .setLayout({ name: 'ccpDec16', type: 'float', inputs: [{ name: 'e', type: 'vec2' }] });
const ccpEncS = (v) => ccpEnc16(v.mul(0.5).add(0.5));
const ccpDecS = (e) => ccpDec16(e).mul(2.0).sub(1.0);

/** Stats pass → 4×1: mean.xyz / sd.xyz / coverage of uTexture over the AABB in 24..27. */
const ccpStatsBody = ({ u }) => {
  // Texel index from the fragment's x — the target is 4 px wide.
  const idx = floor(screenCoordinate.x).toVar();
  const space = P(u, 0);
  const n = max(P(u, 1), 2.0).toVar();
  If(u.uQuality.lessThan(0.75), () => { n.assign(min(n, 32.0)); });
  const r0 = vec2(P(u, 24), P(u, 25));
  const r1 = vec2(P(u, 26), P(u, 27));
  const s1 = vec3(0.0).toVar();
  const s2 = vec3(0.0).toVar();
  const sw = float(0.0).toVar();
  // One flat loop over the 64×64 lattice (row-major) — TSL's Loop takes one
  // index; rows past n break out, columns past n are skipped.
  Loop({ start: int(0), end: int(4096) }, ({ i }) => {
    const j = i.div(int(64));
    const k = i.sub(j.mul(int(64)));
    If(float(j).greaterThanEqual(n), () => { Break(); });
    If(float(k).lessThan(n), () => {
      const q = mix(r0, r1, vec2(float(k), float(j)).add(0.5).div(n));
      const p = u.uTexture.sample(q).toVar();
      If(p.a.greaterThanEqual(0.002), () => {
        const c = ccpToSpace(clamp(p.rgb.div(p.a), 0.0, 1.0), space).toVar();
        s1.addAssign(c.mul(p.a));
        s2.addAssign(c.mul(c).mul(p.a));
        sw.addAssign(p.a);
      });
    });
  });
  const inv = float(1.0).div(max(sw, 1e-5));
  const mean = s1.mul(inv).toVar();
  const sd = sqrt(max(s2.mul(inv).sub(mean.mul(mean)), 0.0)).toVar();
  const cov = sw.div(max(n.mul(n), 1.0));
  const out = vec4(0.0).toVar();
  If(idx.lessThan(0.5), () => {
    out.assign(vec4(ccpEncS(mean.x), ccpEncS(mean.y)));
  }).ElseIf(idx.lessThan(1.5), () => {
    out.assign(vec4(ccpEncS(mean.z), ccpEncS(sd.x)));
  }).ElseIf(idx.lessThan(2.5), () => {
    out.assign(vec4(ccpEncS(sd.y), ccpEncS(sd.z)));
  }).Else(() => {
    out.assign(vec4(ccpEnc16(cov), ccpEnc16(float(0.0))));
  });
  return out;
};

const ccpReadStats = (samp) => {
  const p0 = samp.sample(vec2(0.125, 0.5)).toVar();
  const p1 = samp.sample(vec2(0.375, 0.5)).toVar();
  const p2 = samp.sample(vec2(0.625, 0.5)).toVar();
  const p3 = samp.sample(vec2(0.875, 0.5)).toVar();
  return {
    mean: vec3(ccpDecS(p0.rg), ccpDecS(p0.ba), ccpDecS(p1.rg)).toVar(),
    sd: vec3(ccpDecS(p1.ba), ccpDecS(p2.rg), ccpDecS(p2.ba)).toVar(),
    cov: ccpDec16(p3.rg).toVar(),
  };
};

/** Main pass: move uTexture's distribution (uTexture2 stats) onto the reference's (uTexture1). */
const ccpMainBody = ({ u, uvn }) => {
  const src = u.uTexture.sample(uvn).toVar();
  const out = vec4(src).toVar();
  If(src.a.greaterThanEqual(0.002), () => {
    const space = P(u, 0);
    const transfer = P(u, 2);
    const lumAmt = P(u, 3).div(100.0);
    const colAmt = P(u, 4).div(100.0);
    const contrast = P(u, 5).div(100.0);
    const sat = P(u, 6).div(100.0);
    const maxGain = max(P(u, 7), 1.0);
    const protHi = P(u, 8).div(100.0);
    const protLo = P(u, 9).div(100.0);
    const R = ccpReadStats(u.uTexture1);
    const S = ccpReadStats(u.uTexture2);
    If(R.cov.greaterThanEqual(1e-4).and(S.cov.greaterThanEqual(1e-4)), () => {
      const rgb = clamp(unpremult(src), 0.0, 1.0).toVar();
      const c = ccpToSpace(rgb, space).toVar();
      const isRgb = space.greaterThan(1.5);
      const o = vec3(0.0).toVar();
      If(transfer.lessThan(0.5), () => {
        const gain = pow(clamp(R.sd.div(max(S.sd, 1e-3)), vec3(float(1.0).div(maxGain)), vec3(maxGain)), vec3(contrast));
        o.assign(c.sub(S.mean).mul(gain).add(R.mean));
      }).Else(() => {
        const ratio = clamp(R.mean.div(max(S.mean, vec3(1e-3))), vec3(float(1.0).div(maxGain)), vec3(maxGain)).toVar();
        o.assign(select(isRgb, c.mul(ratio),
          vec3(c.x.mul(ratio.x), c.yz.add(R.mean.yz.sub(S.mean.yz)))));
      });
      const amt = select(isRgb, vec3(colAmt), vec3(lumAmt, colAmt, colAmt));
      o.assign(mix(c, o, amt));
      o.assign(select(isRgb, o, vec3(o.x, o.yz.mul(sat.add(1.0)))));
      const outRgb = ccpFromSpace(o, space).toVar();
      If(isRgb, () => {
        const yo = luma(outRgb);
        outRgb.assign(mix(vec3(yo), outRgb, sat.add(1.0)));
        outRgb.mulAssign(mix(luma(rgb).div(max(yo, 1e-3)), 1.0, lumAmt));
      });
      outRgb.assign(clamp(outRgb, 0.0, 1.0));
      const y = luma(rgb);
      const keep = float(1.0).sub(protHi.mul(smoothstep(0.7, 1.0, y)))
        .sub(protLo.mul(float(1.0).sub(smoothstep(0.0, 0.25, y))));
      outRgb.assign(mix(rgb, outRgb, clamp(keep, 0.0, 1.0)));
      out.assign(premult(outRgb, src.a));
    });
  });
  return out;
};

export const EXTRA_PASS_BODIES = {
  'copyColor:statsRef': ccpStatsBody,
  'copyColor:statsSrc': ccpStatsBody,
  'copyColor:main': ccpMainBody,

  'bloom:bright': bloomBright,
  'bloom:down1': bloomDown,
  'bloom:down2': bloomDown,
  'bloom:down3': bloomDown,
  'bloom:up2': bloomUp,
  'bloom:up1': bloomUp,
  'bloom:up0': bloomUp,
  'bloom:streak': bloomStreak,
  'bloom:main': bloomMain,

  'alphaChoker:main': ({ u, uvn }) => {
    const s = u.uSource.sample(uvn).toVar();
    const m = clamp(u.uTexture1.sample(uvn).a, 0.0, 1.0).toVar();
    const bias = clamp(P(u, 2).div(100.0), -1.0, 1.0).toVar();
    m.assign(pow(m, exp(bias.mul(-1.6))));
    const ec = clamp(P(u, 3).div(100.0), 0.0, 1.0).toVar();
    If(ec.greaterThan(0.001), () => {
      const w = mix(0.5, 0.015, ec).toVar();
      m.assign(mix(m, smoothstep(float(0.5).sub(w), float(0.5).add(w), m), ec));
    });
    const grown = u.uTexture2.sample(uvn).toVar();
    const col = select(s.a.greaterThan(0.02), unpremult(s), unpremult(grown)).toVar();
    const dec = clamp(P(u, 4).div(100.0), 0.0, 1.0).toVar();
    const ref = u.uResolution.y.div(1080.0).toVar();
    const px = vec2(1.0).div(u.uResolution).toVar();
    const span = max(2.0, abs(P(u, 0)).add(P(u, 1)).mul(ref)).toVar();
    const gx = u.uTexture1.sample(uvn.add(vec2(px.x, 0.0).mul(span))).a
      .sub(u.uTexture1.sample(uvn.sub(vec2(px.x, 0.0).mul(span))).a);
    const gy = u.uTexture1.sample(uvn.add(vec2(0.0, px.y).mul(span))).a
      .sub(u.uTexture1.sample(uvn.sub(vec2(0.0, px.y).mul(span))).a);
    const g = vec2(gx, gy).toVar();
    const glen = length(g).toVar();
    If(glen.greaterThan(1e-4).and(dec.greaterThan(0.001)), () => {
      const inward = g.div(glen).toVar();
      const clean = col.toVar();
      const found = float(0.0).toVar();
      Loop({ start: int(1), end: int(6) }, ({ i }) => {
        const dist = span.add(float(i).div(5.0).mul(dec.mul(46.0).add(6.0)).mul(ref)).toVar();
        const inner = u.uSource.sample(clamp(uvn.add(inward.mul(px).mul(dist)), vec2(0.001), vec2(0.999))).toVar();
        If(found.lessThan(0.5).and(inner.a.greaterThan(0.9)), () => {
          clean.assign(unpremult(inner));
          found.assign(1.0);
        });
      });
      col.assign(mix(col, clean, clamp(dec.mul(clamp(s.a, 0.0, 1.0)), 0.0, 1.0).mul(found)));
    });
    const view = P(u, 5);
    const out = premult(col, m).toVar();
    If(view.greaterThan(0.5).and(view.lessThan(1.5)), () => {
      out.assign(vec4(vec3(m), 1.0));
    }).ElseIf(view.greaterThan(1.5), () => {
      out.assign(vec4(vec3(clamp(abs(m.sub(s.a)).mul(3.0), 0.0, 1.0)), 1.0));
    });
    return out;
  },

  'extract:key': ({ u, uvn }) => {
    const s = u.uTexture.sample(uvn).toVar();
    const c = unpremult(s).toVar();
    const v = exChannel(P(u, 0), c, s.a).toVar();
    const bp = P(u, 1).div(255.0).toVar();
    const bs = P(u, 2).div(255.0).toVar();
    const wp = P(u, 3).div(255.0).toVar();
    const ws = P(u, 4).div(255.0).toVar();
    const lo = select(bs.lessThan(0.002), step(bp, v), smoothstep(bp, bp.add(bs), v)).toVar();
    const hi = select(ws.lessThan(0.002), step(v, wp), float(1.0).sub(smoothstep(wp.sub(ws), wp, v))).toVar();
    const a = clamp(lo.mul(hi), 0.0, 1.0).toVar();
    If(P(u, 5).greaterThan(0.5), () => { a.assign(float(1.0).sub(a)); });
    If(P(u, 13).greaterThan(0.5), () => { a.mulAssign(clamp(s.a, 0.0, 1.0)); });
    return vec4(a);
  },

  'extract:main': ({ u, uvn }) => {
    const s = u.uSource.sample(uvn).toVar();
    const a = clamp(u.uTexture1.sample(uvn).a, 0.0, 1.0).toVar();
    const choke = P(u, 8).div(100.0).toVar();
    const edge = clamp(P(u, 9).div(100.0), 0.0, 1.0).toVar();
    If(abs(choke).greaterThan(0.002).or(edge.greaterThan(0.002)), () => {
      const piv = clamp(choke.mul(0.48).add(0.5), 0.02, 0.98).toVar();
      const soft = mix(0.5, 0.012, edge).toVar();
      a.assign(smoothstep(clamp(piv.sub(soft), 0.0, 1.0), clamp(piv.add(soft), 0.0, 1.0), a));
    });
    const g = P(u, 6).div(100.0).toVar();
    If(abs(g).greaterThan(0.002), () => { a.assign(pow(clamp(a, 0.0, 1.0), exp(g.mul(-1.6)))); });
    a.assign(clamp(a, 0.0, 1.0));
    const view = P(u, 10);
    const out = vec4(0.0).toVar();
    If(view.greaterThan(0.5).and(view.lessThan(1.5)), () => {
      out.assign(vec4(vec3(a), 1.0));
    }).ElseIf(view.greaterThan(1.5), () => {
      out.assign(vec4(vec3(exChannel(P(u, 0), unpremult(s), s.a)), 1.0));
    }).Else(() => {
      const col = unpremult(s).toVar();
      const boost = clamp(P(u, 12).div(100.0), 0.0, 2.0).toVar();
      If(boost.greaterThan(0.002).and(a.greaterThan(0.004)), () => {
        col.assign(mix(col, col.div(max(a, 0.02)), min(boost, 1.0)).mul(max(boost.sub(1.0), 0.0).add(1.0)));
      });
      const tamt = clamp(P(u, 11).div(100.0), 0.0, 1.0).toVar();
      If(tamt.greaterThan(0.002), () => { col.assign(mix(col, u.uColor, tamt)); });
      out.assign(premult(clamp(col, 0.0, 8.0), a));
    });
    return out;
  },

  'lightRays:bright': ({ u, uvn }) => {
    const s = u.uTexture.sample(uvn).toVar();
    const m = u.uTexture1.sample(uvn).a.toVar();
    const mode = P(u, 0);
    const th = P(u, 6).div(100.0).toVar();
    const col = unpremult(s).toVar();
    const lvl = float(0.0).toVar();
    If(mode.lessThan(0.5), () => {
      lvl.assign(m);
      col.assign(mix(vec3(1.0), col, clamp(s.a, 0.0, 1.0)));
    }).ElseIf(mode.lessThan(1.5), () => {
      lvl.assign(smoothstep(th, 1.0, luma(col)).mul(s.a));
    }).Else(() => {
      lvl.assign(smoothstep(max(th, 0.55), 1.0, luma(col)).mul(s.a));
    });
    return premult(col, lvl);
  },

  'lightRays:march': ({ u, uvn, helpers }) => {
    // GLSL: fxFrame(vec2(uParams[1], uParams[2])) — NO flip. fxFrame's box
    // convention already agrees between backends (the same proof as rgbSplit /
    // vignette passing with an unflipped fxLocal). Flipping P2 here put the
    // light source on the mirrored side of the layer: every ray poured out of
    // the wrong place (catalogue: 115k px, maxD 255).
    const origin = helpers.fxFrame(vec2(P(u, 1), P(u, 2))).toVar();
    const lenN = P(u, 3).div(100.0).toVar();
    const density = max(P(u, 4), 0.25).toVar();
    const decay = P(u, 5).div(100.0).toVar();
    const taps = max(
      floor(select(u.uQuality.lessThan(0.75), float(24.0), float(48.0)).mul(min(density, 1.0)).add(0.5)),
      8.0,
    ).toVar();
    const delta = uvn.sub(origin).toVar();
    // The jitter lattice is hashed per pixel and consumed by this same pass, so
    // it follows the measured rule: plain screenCoordinate reproduces GLSL's
    // gl_FragCoord lattice in the app pipeline (grain/halftone/td pass plain).
    const jitter = hash21(screenCoordinate.xy).sub(0.5).div(taps).toVar();
    const acc = vec4(0.0).toVar();
    const w = float(1.0).toVar();
    const ws = float(0.0).toVar();
    Loop({ start: int(0), end: int(48) }, ({ i }) => {
      If(float(i).greaterThanEqual(taps), () => { Break(); });
      const t = float(i).div(taps).add(jitter).mul(lenN).toVar();
      acc.addAssign(sampleClamped(u.uTexture, uvn.sub(delta.mul(t))).mul(w));
      ws.addAssign(w);
      w.mulAssign(mix(1.0, 0.82, decay));
    });
    return acc.div(max(ws, 1e-4));
  },

  'lightRays:main': ({ u, uvn }) => {
    const src = u.uSource.sample(uvn).toVar();
    const rays = u.uTexture1.sample(uvn).toVar();
    const expo = P(u, 7).div(100.0).toVar();
    const flick = P(u, 9).div(100.0).toVar();
    If(flick.greaterThan(0.001), () => {
      expo.mulAssign(float(1.0).sub(flick.mul(0.65).mul(hash21(vec2(floor(u.uTime.mul(24.0)), 7.0)))));
    });
    const rc = unpremult(rays).mul(u.uColor);
    const ra = clamp(rays.a.mul(expo), 0.0, 2.0);
    const srcLevel = P(u, 8).div(100.0);
    const col = clamp(unpremult(src).mul(srcLevel).add(rc.mul(ra)), 0.0, 1.0);
    const outA = clamp(src.a.mul(srcLevel).add(ra), 0.0, 1.0);
    return premult(col, outA);
  },

  'lensPrism:main': ({ u, uvn }) => {
    const src = u.uSource.sample(uvn).toVar();
    const ref = u.uResolution.y.div(1080.0).toVar();
    const px = vec2(max(2.0, ref.mul(10.0))).div(u.uResolution).toVar();
    const hx = u.uTexture1.sample(uvn.add(vec2(px.x, 0.0))).r.sub(u.uTexture1.sample(uvn.sub(vec2(px.x, 0.0))).r);
    const hy = u.uTexture1.sample(uvn.add(vec2(0.0, px.y))).r.sub(u.uTexture1.sample(uvn.sub(vec2(0.0, px.y))).r);
    const n = normalize(vec3(hx.negate().mul(5.0), hy.negate().mul(5.0), 1.0)).toVar();
    const amount = P(u, 0).mul(ref).toVar();
    const disp = P(u, 2).div(100.0).toVar();
    const specW = max(P(u, 3).div(100.0), 0.05).toVar();
    const refr = P(u, 4).div(100.0).toVar();
    const edgeBias = P(u, 5).div(100.0).toVar();
    const ang = P(u, 1).mul(RAD).add(u.uTime.mul(P(u, 6).mul(RAD))).toVar();
    const axis = vec2(cos(ang), sin(ang)).toVar();
    const dirv = normalize(mix(axis, n.xy.add(axis.mul(0.15)), refr).add(1e-5)).toVar();
    const slope = clamp(float(1.0).sub(n.z).mul(3.0), 0.0, 1.0).toVar();
    const gate = mix(1.0, slope, edgeBias).toVar();
    const off = amount.mul(gate).toVar();
    const out = src.toVar();
    If(off.greaterThanEqual(0.25), () => {
      const acc = vec3(0.0).toVar();
      const wsum = vec3(0.0).toVar();
      const aSum = float(0.0).toVar();
      Loop({ start: int(0), end: int(7) }, ({ i }) => {
        const k = float(i).div(6.0).toVar();
        const d = k.sub(0.5).mul(2.0).toVar();
        const suv = uvn.add(
          dirv.mul(off.mul(disp).mul(specW).mul(d)).add(n.xy.mul(off.mul(refr).mul(0.7))).div(u.uResolution),
        ).toVar();
        const s = sampleClamped(u.uTexture, suv).toVar();
        const w = prismSpectral(k).toVar();
        acc.addAssign(unpremult(s).mul(w).mul(s.a));
        wsum.addAssign(w);
        aSum.addAssign(s.a);
      });
      const srcLevel = P(u, 7).div(100.0);
      const outCol = clamp(mix(unpremult(src).mul(srcLevel), acc.div(max(wsum, vec3(1e-4))), gate), 0.0, 1.0);
      const outA = mix(src.a.mul(srcLevel), aSum.div(7.0), gate);
      out.assign(premult(outCol, outA));
    });
    return out;
  },

  'sdfLensBlur:main': ({ u, uvn, helpers }) => {
    const { fxLocal, fxFrame, fxAspect } = helpers;
    const ar = fxAspect().toVar();
    const asp = select(ar.greaterThan(1.0), vec2(ar, 1.0), vec2(1.0, float(1.0).div(ar))).toVar();
    const st = fxLocal(uvn).sub(0.5).mul(asp).add(0.5).toVar();
    const ang = P(u, 5).mul(RAD).mul(u.uTime).toVar();
    const c = vec2(P(u, 7), P(u, 8)).toVar();
    const rad = P(u, 6).div(100.0).toVar();
    const path = P(u, 4);
    const lens = vec2(0.0).toVar();
    If(path.lessThan(0.5), () => {
      lens.assign(c.add(vec2(cos(ang), sin(ang)).mul(rad)));
    }).ElseIf(path.lessThan(1.5), () => {
      lens.assign(c.add(vec2(sin(ang), sin(ang.mul(2.0)).mul(0.5)).mul(rad)));
    }).ElseIf(path.lessThan(2.5), () => {
      lens.assign(vec2(
        c.x.add(abs(fract(ang.mul(0.15915494)).mul(2.0).sub(1.0)).mul(2.0).sub(1.0).mul(rad)),
        c.y,
      ));
    }).Else(() => { lens.assign(c); });
    const lp = lens.sub(0.5).mul(asp).add(0.5).toVar();
    const lensRaw = sdlFill(length(st.sub(lp)).mul(2.0), P(u, 1).div(100.0), max(P(u, 2).div(100.0), 1e-3)).toVar();
    const lensV = select(P(u, 3).greaterThan(0.5), float(1.0).sub(lensRaw), lensRaw).toVar();
    const mag = P(u, 9).div(100.0).toVar();
    const suv = uvn.toVar();
    If(mag.greaterThan(0.001), () => {
      const stM = mix(st, lp.add(st.sub(lp).div(mag.add(1.0))), lensRaw).toVar();
      suv.assign(fxFrame(stM.sub(0.5).div(asp).add(0.5)));
    });
    return mix(sampleClamped(u.uTexture, suv), sampleClamped(u.uTexture1, suv), clamp(lensV, 0.0, 1.0));
  },

  'crtMatrix:base': ({ u, uvn, helpers }) => {
    const { fxLocal, fxFrame, fxRes } = helpers;
    const display = P(u, 0);
    const ref = fxRes().y.div(1080.0).toVar();
    const cell = max(P(u, 1).mul(ref), 2.0).toVar();
    const curved = P(u, 5).div(100.0).toVar();
    const uvIn = fxLocal(uvn).toVar();
    const p = uvIn.mul(2.0).sub(1.0).toVar();
    p.mulAssign(curved.mul(0.18).mul(dot(p, p)).add(1.0));
    const cuv = select(curved.lessThan(0.001), uvIn, p.mul(0.5).add(0.5)).toVar();
    const out = vec4(0.0).toVar();
    If(outside01(cuv).not(), () => {
      const fc = cuv.mul(fxRes()).toVar();
      const cellUv = floor(fc.div(cell)).add(0.5).mul(cell).div(fxRes()).toVar();
      const beam = P(u, 4).div(100.0).toVar();
      const sHard = u.uTexture.sample(fxFrame(cellUv)).toVar();
      const sSoft = u.uTexture.sample(fxFrame(cuv)).toVar();
      const s = mix(sHard, sSoft, beam.mul(beam)).toVar();
      const moire = P(u, 9).div(100.0).toVar();
      If(moire.greaterThan(0.001), () => {
        const mc = cell.mul(moire.mul(0.07).add(1.0)).toVar();
        const mUv = floor(fc.div(mc)).add(0.5).mul(mc).div(fxRes()).toVar();
        s.assign(mix(s, u.uTexture.sample(fxFrame(mUv)), moire.mul(0.5)));
      });
      const col = unpremult(s).toVar();
      const f = fract(fc.div(cell)).toVar();
      const sub = P(u, 3).div(100.0).toVar();
      const mask = vec3(1.0).toVar();
      const aa = clamp(float(2.0).div(cell), 0.04, 0.4).toVar();
      If(display.lessThan(0.5), () => {
        const band = floor(f.x.mul(3.0)).toVar();
        mask.assign(select(band.lessThan(0.5), vec3(1.0, 0.12, 0.12),
          select(band.lessThan(1.5), vec3(0.12, 1.0, 0.12), vec3(0.12, 0.12, 1.0))));
        const scan = sin(cuv.y.mul(fxRes().y).div(cell).mul(6.2831853)).mul(0.5).add(0.5);
        col.mulAssign(mix(1.0, scan.mul(0.55).add(0.45), P(u, 2).div(100.0)));
      }).ElseIf(display.lessThan(1.5), () => {
        const band = floor(f.x.mul(3.0)).toVar();
        mask.assign(select(band.lessThan(0.5), vec3(1.0, 0.06, 0.06),
          select(band.lessThan(1.5), vec3(0.06, 1.0, 0.06), vec3(0.06, 0.06, 1.0))));
        // WGSL forbids reverse-edge smoothstep(1, 1-aa, …); high-edge falloff is an invert.
        const gap = smoothstep(0.0, aa, f.y).mul(float(1.0).sub(smoothstep(float(1.0).sub(aa), float(1.0), f.y)));
        mask.mulAssign(mix(1.0, gap, P(u, 2).div(100.0)));
      }).ElseIf(display.lessThan(2.5), () => {
        const band = floor(f.x.mul(3.0)).toVar();
        mask.assign(select(band.lessThan(0.5), vec3(1.0, 0.10, 0.10),
          select(band.lessThan(1.5), vec3(0.10, 1.0, 0.10), vec3(0.10, 0.10, 1.0))));
        mask.mulAssign(float(1.0).sub(step(0.965, f.y).mul(P(u, 2).div(100.0)).mul(0.8)));
      }).ElseIf(display.lessThan(3.5), () => {
        const d = length(f.sub(0.5)).mul(2.0);
        mask.assign(vec3(float(1.0).sub(smoothstep(float(0.9).sub(aa.mul(3.0)), float(0.9), d))));
        col.assign(pow(col, vec3(0.9)));
      }).Else(() => {
        const band = floor(f.x.mul(3.0)).toVar();
        const well = select(band.lessThan(0.5), vec3(1.0, 0.04, 0.04),
          select(band.lessThan(1.5), vec3(0.04, 1.0, 0.04), vec3(0.04, 0.04, 1.0)));
        const bx = fract(f.x.mul(3.0));
        const win = smoothstep(0.06, float(0.06).add(aa), bx)
          .mul(float(1.0).sub(smoothstep(float(0.94).sub(aa), float(0.94), bx)))
          .mul(smoothstep(0.08, float(0.08).add(aa), f.y))
          .mul(float(1.0).sub(smoothstep(float(0.92).sub(aa), float(0.92), f.y)));
        mask.assign(mix(vec3(0.02), well, win));
      });
      col.mulAssign(mix(vec3(1.0), mask.mul(1.9), sub));
      const roll = P(u, 8).div(100.0).toVar();
      If(roll.greaterThan(0.001), () => {
        const bar = fract(cuv.y.mul(0.7).add(u.uTime.mul(0.35)));
        col.mulAssign(float(1.0).sub(roll.mul(0.5).mul(
          float(1.0).sub(smoothstep(0.0, 0.15, abs(bar.sub(0.5)).sub(0.28))))));
      });
      const flick = P(u, 7).div(100.0).toVar();
      If(flick.greaterThan(0.001), () => {
        col.mulAssign(float(1.0).sub(flick.mul(0.3).mul(hash21(vec2(floor(u.uTime.mul(60.0)), 3.0)))));
      });
      out.assign(premult(clamp(col, 0.0, 1.0), s.a));
    });
    return out;
  },

  'crtMatrix:bright': ({ u, uvn }) => {
    const s = u.uTexture.sample(uvn).toVar();
    return s.mul(smoothstep(0.55, 1.0, luma(unpremult(s)).mul(s.a)));
  },

  'crtMatrix:main': ({ u, uvn }) => {
    const base = u.uTexture1.sample(uvn).toVar();
    const glow = u.uTexture2.sample(uvn).toVar();
    const g = P(u, 6).div(100.0);
    const col = unpremult(base).mul(base.a).add(unpremult(glow).mul(glow.a).mul(g).mul(1.4));
    const a = clamp(base.a.add(glow.a.mul(g)), 0.0, 1.0);
    return premult(clamp(col.div(max(a, 1e-4)), 0.0, 1.0), a);
  },

  'outlineBands:mask': ({ u, uvn }) => {
    const mode = P(u, 0);
    const th = P(u, 1).div(100.0);
    const m = float(0.0).toVar();
    If(mode.lessThan(0.5), () => {
      m.assign(step(0.5, u.uTexture1.sample(uvn).a));
    }).ElseIf(mode.lessThan(1.5), () => {
      const s = u.uTexture.sample(uvn);
      m.assign(step(th, luma(unpremult(s)).mul(s.a)));
    }).Else(() => {
      const px = float(1.4).div(u.uResolution);
      const c = luma(unpremult(u.uTexture.sample(uvn)));
      const dx = abs(luma(unpremult(u.uTexture.sample(uvn.add(vec2(px.x, 0.0))))).sub(c));
      const dy = abs(luma(unpremult(u.uTexture.sample(uvn.add(vec2(0.0, px.y))))).sub(c));
      m.assign(step(th.mul(0.25), dx.add(dy)));
    });
    return vec4(m);
  },

  'outlineBands:seed': ({ u, uvn }) => {
    const px = float(1.0).div(u.uResolution);
    const c = u.uTexture.sample(uvn).r;
    const n = u.uTexture.sample(uvn.add(vec2(px.x, 0.0))).r
      .add(u.uTexture.sample(uvn.sub(vec2(px.x, 0.0))).r)
      .add(u.uTexture.sample(uvn.add(vec2(0.0, px.y))).r)
      .add(u.uTexture.sample(uvn.sub(vec2(0.0, px.y))).r);
    const edge = select(c.greaterThan(0.5), n.lessThan(3.5), n.greaterThan(0.5));
    return select(edge, jfaEnc(uvn), vec4(1.0));
  },

  'outlineBands:jfa': ({ u, uvn }) => {
    const px = vec2(P(u, 26)).div(u.uResolution);
    const best = u.uTexture.sample(uvn).toVar();
    const bp = jfaDec(best).toVar();
    const bd = select(bp.x.greaterThan(1.001), float(1e9), length(uvn.sub(bp).mul(u.uResolution))).toVar();
    Loop({ start: int(0), end: int(9) }, ({ i }) => {
      const dx = mod(float(i), 3.0).sub(1.0);
      const dy = floor(float(i).div(3.0)).sub(1.0);
      If(abs(dx).add(abs(dy)).greaterThan(0.25), () => {
        const suv = uvn.add(vec2(dx, dy).mul(px)).toVar();
        If(outside01(suv).not(), () => {
          const cand = u.uTexture.sample(suv).toVar();
          const cp = jfaDec(cand).toVar();
          If(cp.x.lessThanEqual(1.001), () => {
            const d = length(uvn.sub(cp).mul(u.uResolution));
            If(d.lessThan(bd), () => {
              bd.assign(d);
              best.assign(cand);
            });
          });
        });
      });
    });
    return best;
  },

  'outlineBands:main': ({ u, uvn }) => {
    const src = u.uSource.sample(uvn).toVar();
    const ref = u.uResolution.y.div(1080.0);
    const near = jfaDec(u.uTexture1.sample(uvn)).toVar();
    const out = src.toVar();
    If(near.x.lessThanEqual(1.001), () => {
      const dist = length(uvn.sub(near).mul(u.uResolution)).toVar();
      const inside = u.uTexture2.sample(uvn).r;
      const side = P(u, 6);
      const sideOk = select(side.lessThan(0.5), float(1.0).sub(inside),
        select(side.lessThan(1.5), inside, float(1.0)));
      const spacing = max(P(u, 2).mul(ref), 2.0);
      const count = max(P(u, 7), 1.0);
      const travel = P(u, 4).mul(ref).add(u.uTime.mul(P(u, 5)).mul(ref));
      const reach = step(dist, spacing.mul(count));
      const band = fract(dist.add(travel).div(spacing));
      const width = clamp(P(u, 3).div(100.0), 0.02, 1.0);
      const aa = clamp(float(1.4).div(spacing), 0.01, 0.3);
      // WGSL rejects reverse-edge smoothstep(hi, lo, …); band soft-edge is an invert.
      const half = width.mul(0.5);
      const line = float(1.0).sub(smoothstep(half.sub(aa), half.add(aa), abs(band.sub(0.5))));
      const col = u.uLUT.sample(vec2(clamp(dist.div(spacing.mul(count)), 0.0, 1.0), 0.5)).rgb;
      const bandA = line.mul(sideOk).mul(reach);
      const core = P(u, 8).div(100.0);
      const srcLevel = P(u, 9).div(100.0);
      const base = src.mul(mix(srcLevel, core, inside));
      const bands = premult(col, bandA);
      out.assign(bands.add(base.mul(float(1.0).sub(bands.a))));
    });
    return out;
  },
};

const JFA_KEYS = [1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1];
for (const step of JFA_KEYS) {
  EXTRA_PASS_BODIES[`outlineBands:jf${step}`] = EXTRA_PASS_BODIES['outlineBands:jfa'];
}

/*
 * ── Edge Detect (edgeDetect) ───────────────────────────────────────────────
 * Twins of ED_GRAD_FX / ED_EDGE_FX / ED_LINK_FX / ED_MAIN_FX in motionEffects.js.
 * Orientation, measured not assumed (verify_edge_detect.js): texture-space
 * NEIGHBOUR OFFSETS port verbatim — the pass framework keeps RT write/read
 * round-trips v-consistent per backend, so hand-negating dy double-flips (it
 * moved every contour line one pixel and mirrored the direction-hue wheel).
 * The main pass's sweep axis ports verbatim too — NO y negation: it lives in
 * fxLocal box space, which is orientation-normalized on both backends (unlike
 * longShadow's raw-uv offset, which does negate). The original negation was
 * masked by angle-0 cases and a not-yet-visible front; drawon-speed at -35°
 * caught it shifting the reveal.
 */

const edHue = Fn(([h]) => {
  const p3 = abs(mod(h.mul(6.0).add(vec3(0.0, 4.0, 2.0)), 6.0).sub(3.0));
  return clamp(p3.sub(1.0), 0.0, 1.0);
}).setLayout({ name: 'edHue', type: 'vec3', inputs: [{ name: 'h', type: 'float' }] });

const edVN = Fn(([pIn]) => {
  const i = floor(pIn);
  const f0 = fract(pIn);
  const f = f0.mul(f0).mul(float(3.0).sub(f0.mul(2.0)));
  const a = hash21(i);
  const b = hash21(i.add(vec2(1.0, 0.0)));
  const c = hash21(i.add(vec2(0.0, 1.0)));
  const d = hash21(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}).setLayout({ name: 'edVN', type: 'float', inputs: [{ name: 'pIn', type: 'vec2' }] });

// tanh is unavailable in GLSL ES 1.00, so the GLSL side builds it from exp with
// a clamped argument; fold the same construction here so the ink ramp matches.
const edTanh = Fn(([x]) => {
  const t = exp(clamp(x, -8.0, 8.0).mul(2.0));
  return t.sub(1.0).div(t.add(1.0));
}).setLayout({ name: 'edTanh', type: 'float', inputs: [{ name: 'x', type: 'float' }] });

const edClampUv = (q, px) => clamp(q, px.mul(0.5), vec2(1.0).sub(px.mul(0.5)));

const edGradBody = ({ u, uvn }) => {
  const px = vec2(1.0, 1.0).div(u.uResolution).toVar();
  const L = (dx, dy) => luma(u.uTexture.sample(edClampUv(uvn.add(px.mul(vec2(dx, dy))), px)).rgb);
  const tl = L(-1, 1).toVar();
  const tc = L(0, 1).toVar();
  const tr = L(1, 1).toVar();
  const ml = L(-1, 0).toVar();
  const mr = L(1, 0).toVar();
  const bl = L(-1, -1).toVar();
  const bc = L(0, -1).toVar();
  const br = L(1, -1).toVar();
  const op = P(u, 1);
  const w = select(op.lessThan(0.5), vec2(0.25, 0.5),
    select(op.lessThan(1.5), vec2(0.1875, 0.625), vec2(1.0 / 3.0, 1.0 / 3.0))).toVar();
  const gx = tr.sub(tl).add(br).sub(bl).mul(w.x).add(mr.sub(ml).mul(w.y)).toVar();
  const gy = tl.sub(bl).add(tr).sub(br).mul(w.x).add(tc.sub(bc).mul(w.y)).toVar();
  const mag = length(vec2(gx, gy)).mul(0.70710678);
  return vec4(gx.mul(0.5).add(0.5), gy.mul(0.5).add(0.5), mag, 1.0);
};

const edEdgeBody = ({ u, uvn }) => {
  const px = vec2(1.0, 1.0).div(u.uResolution).toVar();
  const method = P(u, 0);
  const th = P(u, 2).div(100.0).mul(0.7).toVar();
  const e = float(0.0).toVar();
  If(method.lessThan(0.5), () => {
    const mag = u.uTexture.sample(uvn).b.mul(1.41421356);
    const k = P(u, 3).div(100.0).toVar();
    e.assign(smoothstep(th.mul(float(1.0).sub(k)), th.mul(k.add(1.0)).add(0.003), mag));
  }).ElseIf(method.lessThan(1.5), () => {
    const g = u.uTexture.sample(uvn).toVar();
    const m = g.b.toVar();
    If(m.greaterThanEqual(1e-4), () => {
      const dn = normalize(g.rg.mul(2.0).sub(1.0));
      const sp = floor(dn.add(0.5)).toVar();
      const m1 = u.uTexture.sample(edClampUv(uvn.add(sp.mul(px)), px)).b;
      const m2 = u.uTexture.sample(edClampUv(uvn.sub(sp.mul(px)), px)).b;
      If(m.greaterThanEqual(m1).and(m.greaterThan(m2.sub(1e-6))), () => {
        const mm = m.mul(1.41421356);
        const lo = th.mul(P(u, 4).div(100.0));
        e.assign(select(mm.greaterThanEqual(th), float(1.0),
          select(mm.greaterThanEqual(lo), float(0.5), float(0.0))));
      });
    });
  }).ElseIf(method.lessThan(2.5), () => {
    const a = luma(u.uTexture1.sample(uvn).rgb);
    const b = luma(u.uTexture2.sample(uvn).rgb);
    const S = a.mul(P(u, 5).add(1.0)).sub(P(u, 5).mul(b)).toVar();
    const eps = P(u, 7).mul(0.002).toVar();
    const T = select(S.greaterThanEqual(eps), float(1.0),
      edTanh(S.sub(eps).mul(P(u, 6))).add(1.0));
    e.assign(clamp(float(1.0).sub(T), 0.0, 1.0));
  }).Else(() => {
    const bands = max(floor(P(u, 8).add(0.5)), 2.0).toVar();
    const Q = (q) => floor(clamp(luma(u.uTexture1.sample(edClampUv(q, px)).rgb), 0.0, 0.9999).mul(bands));
    const q0 = Q(uvn).toVar();
    const qr = Q(uvn.add(vec2(px.x, 0.0))).toVar();
    const qu = Q(uvn.add(vec2(0.0, px.y))).toVar();
    e.assign(select(abs(qr.sub(q0)).greaterThan(0.5).or(abs(qu.sub(q0)).greaterThan(0.5)),
      float(1.0), float(0.0)));
  });
  return vec4(e, e, e, e);
};

const edLinkBody = ({ u, uvn }) => {
  const px = vec2(1.0, 1.0).div(u.uResolution).toVar();
  const v = u.uTexture.sample(uvn).r.toVar();
  If(v.greaterThan(0.25).and(v.lessThan(0.75)), () => {
    const mx = float(0.0).toVar();
    Loop({ start: int(0), end: int(9) }, ({ i }) => {
      const fi = float(i);
      const dx = mod(fi, 3.0).sub(1.0);
      const dy = floor(fi.div(3.0)).sub(1.0);
      const q = edClampUv(uvn.add(px.mul(vec2(dx, dy))), px);
      mx.assign(max(mx, u.uTexture.sample(q).r));
    });
    If(mx.greaterThan(0.75), () => { v.assign(1.0); })
      .ElseIf(P(u, 27).greaterThan(0.5), () => { v.assign(0.0); });
  });
  return vec4(v, v, v, v);
};

const edMainBody = ({ u, uvn, helpers }) => {
  const { fxLocal, fxAspect } = helpers;
  const src = u.uSource.sample(uvn).toVar();
  const srcC = unpremult(src).toVar();
  const srcLum = luma(srcC).toVar();

  const anim = P(u, 15).toVar();
  const spd = max(P(u, 18), 0.01).toVar();
  const p = fxLocal(uvn).toVar();
  const ang = P(u, 16).mul(RAD).toVar();
  const axis = vec2(cos(ang), sin(ang)).toVar();
  const asp = fxAspect().toVar();
  const span = abs(axis.x).mul(asp).add(abs(axis.y)).mul(0.5).add(1e-5).toVar();
  const sweep = dot(p.sub(0.5).mul(vec2(asp, 1.0)), axis).div(span.mul(2.0)).add(0.5).toVar();

  const euv = uvn.toVar();
  If(anim.greaterThan(4.5), () => {
    const bt = floor(u.uTime.mul(8.0).mul(spd)).toVar();
    const n1 = edVN(p.mul(14.0).add(bt.mul(7.13)));
    const n2 = edVN(p.mul(14.0).add(91.7).sub(bt.mul(3.31)));
    euv.assign(uvn.add(vec2(n1, n2).sub(0.5).mul(vec2(3.5, 3.5).div(u.uResolution))));
  });
  const eRaw = u.uTexture1.sample(euv).r.toVar();
  If(P(u, 11).greaterThan(0.5), () => { eRaw.assign(float(1.0).sub(eRaw)); });
  const e = clamp(eRaw.mul(P(u, 9).div(100.0)), 0.0, 1.0).toVar();
  const g = u.uTexture2.sample(euv).r.mul(P(u, 13).div(100.0)).toVar();

  const show = float(1.0).toVar();
  const scan = float(0.0).toVar();
  If(anim.greaterThan(0.5).and(anim.lessThan(1.5)), () => {
    const s2 = P(u, 17).div(100.0).add(0.02).toVar();
    const pp = mix(s2.negate(), s2.add(1.0), clamp(u.uProgress.mul(spd), 0.0, 1.0)).toVar();
    show.assign(float(1.0).sub(smoothstep(pp.sub(s2), pp.add(s2), sweep)));
  }).ElseIf(anim.greaterThan(1.5).and(anim.lessThan(2.5)), () => {
    const s = sweep.sub(clamp(u.uProgress.mul(spd), 0.0, 1.0).mul(1.1).sub(0.05)).toVar();
    show.assign(select(s.lessThan(0.0), float(1.0), float(0.0)));
    scan.assign(exp(abs(s).mul(-90.0)));
  }).ElseIf(anim.greaterThan(2.5).and(anim.lessThan(3.5)), () => {
    const f = hash21(vec2(floor(u.uTime.mul(24.0).mul(spd)), 7.0)).toVar();
    show.assign(f.mul(f).mul(0.55).add(0.45));
  }).ElseIf(anim.greaterThan(3.5).and(anim.lessThan(4.5)), () => {
    g.mulAssign(sin(u.uTime.mul(3.5).mul(spd)).mul(0.45).add(0.55));
  });
  e.mulAssign(show);
  g.mulAssign(show);

  const cm = P(u, 10).toVar();
  const col = C(u, 0).toVar();
  If(cm.greaterThan(0.5).and(cm.lessThan(1.5)), () => {
    col.assign(clamp(pow(srcC, vec3(0.6, 0.6, 0.6)).mul(1.25), 0.0, 1.0));
  }).ElseIf(cm.greaterThan(1.5).and(cm.lessThan(2.5)), () => {
    // The gradient was packed y-UP on both backends, so no flip here.
    const gv = u.uTexture3.sample(uvn).rg.mul(2.0).sub(1.0).toVar();
    col.assign(edHue(fract(atan(gv.y, gv.x).div(6.2831853).add(0.5))));
  }).ElseIf(cm.greaterThan(2.5), () => {
    col.assign(mix(C(u, 1), C(u, 0), smoothstep(0.15, 0.85, srcLum)));
  });
  const gcol = select(cm.greaterThan(1.5).and(cm.lessThan(2.5)), col, C(u, 0)).toVar();

  const srcLevel = P(u, 12).div(100.0);
  const base = src.mul(srcLevel).toVar();
  If(anim.greaterThan(1.5).and(anim.lessThan(2.5)), () => {
    base.assign(mix(src, base, show));
  });

  const blendM = P(u, 14);
  const edgeC = col.mul(e).toVar();
  const rgb = vec3(0.0).toVar();
  const a = float(0.0).toVar();
  If(blendM.lessThan(0.5), () => {
    rgb.assign(edgeC.add(base.rgb.mul(float(1.0).sub(e))));
    a.assign(e.add(base.a.mul(float(1.0).sub(e))));
  }).ElseIf(blendM.lessThan(1.5), () => {
    rgb.assign(base.rgb.add(edgeC));
    a.assign(base.a.add(e));
  }).Else(() => {
    rgb.assign(vec3(1.0, 1.0, 1.0).sub(vec3(1.0, 1.0, 1.0).sub(base.rgb).mul(vec3(1.0, 1.0, 1.0).sub(edgeC))));
    a.assign(base.a.add(e.mul(float(1.0).sub(base.a))));
  });
  rgb.addAssign(gcol.mul(g));
  a.addAssign(g.mul(0.8));
  rgb.addAssign(gcol.mul(0.85).add(0.15).mul(scan));
  a.addAssign(scan.mul(0.5));
  return vec4(clamp(rgb, 0.0, 1.0), clamp(a, 0.0, 1.0));
};

EXTRA_PASS_BODIES['edgeDetect:grad'] = edGradBody;
EXTRA_PASS_BODIES['edgeDetect:edge'] = edEdgeBody;
for (const k of ['lk1', 'lk2', 'lk3', 'lk4', 'res']) {
  EXTRA_PASS_BODIES[`edgeDetect:${k}`] = edLinkBody;
}
EXTRA_PASS_BODIES['edgeDetect:main'] = edMainBody;

export const BLUR_PASS_KEYS = [
  'edgeDetect:blurX', 'edgeDetect:blurY', 'edgeDetect:blur2X', 'edgeDetect:blur2Y',
  'edgeDetect:glowX', 'edgeDetect:glowY',
  'extract:blurX', 'extract:blurY',
  'lightRays:softX', 'lightRays:softY',
  'lensPrism:heightX', 'lensPrism:heightY',
  'sdfLensBlur:blurX', 'sdfLensBlur:blurY',
  'crtMatrix:blurX', 'crtMatrix:blurY',
];
