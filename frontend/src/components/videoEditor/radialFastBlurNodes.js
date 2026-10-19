/*
 * TSL twin of radialFastBlurEffect.js — the GLSL is the reference; keep the two
 * in lockstep. Every pass samples at plain `uvn`: the inputs are the chain's
 * quad-written plate and this effect's own pass targets, which sample upright
 * under plain UV on WebGPU, and the Center goes through fxFrame() (Layer) or is
 * used as-is (Composition) exactly as in GLSL — the same no-flip convention
 * Radial Blur and Light Rays' origin were measured against. The trail scales
 * about the Center, so it carries no axis of its own to flip.
 *
 * Every texture read sits in uniform control flow: the taps are unrolled in JS
 * and the Zoom mode is a select() over the three results, never a branch around
 * a sample.
 */
import {
  vec2, vec3, vec4, float, exp, log, pow, clamp, max, min, mix, length, smoothstep, select,
} from 'three/tsl';

const P = (u, i) => u.uParams.element(i);

const inside01 = (s) => s.x.greaterThanEqual(0.0).and(s.x.lessThanEqual(1.0))
  .and(s.y.greaterThanEqual(0.0)).and(s.y.lessThanEqual(1.0));

const rfbCenter = (u, helpers) => {
  const c = vec2(P(u, 1), P(u, 2));
  return select(P(u, 5).greaterThan(0.5), c, helpers.fxFrame(c));
};

const pickMode = (mode, standard, brightest, darkest) => select(mode.lessThan(0.5), standard,
  select(mode.lessThan(1.5), brightest, darkest));

// The log codec (see the GLSL): e = 1 + ln(x) / 10, clamped to 0..1.
const rfbEnc = (x) => clamp(float(1.0).add(log(max(x, vec4(1e-30))).div(10.0)), 0.0, 1.0);
const rfbDec = (e) => exp(e.sub(1.0).mul(10.0));

// Darkest's quantity: premultiplied darkness with its coverage (see the GLSL).
const rfbDarkness = (v) => vec4(vec3(v.a).sub(v.rgb), v.a);

const prepBody = ({ u, uvn }) => {
  const mode = P(u, 3);
  const dark = mode.greaterThan(1.5);
  const px = vec2(0.5).div(u.uResolution);
  const c0 = u.uTexture.sample(uvn).toVar();
  const hi = select(dark, rfbDarkness(c0), c0).toVar();
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const suv = uvn.add(vec2(dx, dy).mul(px));
      const v = u.uTexture.sample(suv);
      const t = select(dark, rfbDarkness(v), v);
      hi.assign(max(hi, select(inside01(suv), t, vec4(0.0))));
    }
  }
  return select(mode.lessThan(0.5), c0, rfbEnc(hi));
};

const levelBody = ({ u, uvn, helpers }) => {
  const c = rfbCenter(u, helpers).toVar();
  const d = uvn.sub(c).toVar();
  const lnStep = P(u, 24).toVar();
  const gam = P(u, 25).toVar();
  const mode = P(u, 3);
  const sum = vec4(0.0).toVar();
  const ws = float(0.0).toVar();
  const em = vec4(0.0).toVar();
  for (let j = 0; j < 8; j += 1) {
    const lnS = lnStep.mul(j);
    const suv = c.add(d.mul(exp(lnS)));
    const v = u.uTexture.sample(suv);
    const inside = inside01(suv);
    const wsd = exp(gam.add(1.0).mul(lnS));
    sum.addAssign(select(inside, v, vec4(0.0)).mul(wsd));
    ws.addAssign(wsd);
    em.assign(max(em, select(inside, max(v.add(gam.mul(lnS).div(10.0)), vec4(0.0)), vec4(0.0))));
  }
  const avg = sum.div(max(ws, 1e-6)).toVar();
  const enc = select(mode.lessThan(0.5), avg, em);
  const lin = select(mode.lessThan(0.5), avg, rfbDec(em)).toVar();
  const gain = max(P(u, 6).div(100.0), 1e-3).toVar();
  const a2 = float(1.0).sub(pow(max(float(1.0).sub(lin.a), 0.0), gain)).toVar();
  const st = min(lin.rgb.div(max(lin.a, 1e-6)), vec3(1.0));
  const straight = select(mode.greaterThan(1.5), vec3(1.0).sub(st), st);
  const fin = vec4(straight.mul(a2), a2);
  return select(P(u, 26).greaterThan(0.5), fin, enc);
};

const mainBody = ({ u, uvn, helpers }) => {
  const src = u.uSource.sample(uvn).toVar();
  const sm = u.uTexture1.sample(uvn).toVar();
  const c = rfbCenter(u, helpers);
  const trailPx = length(uvn.sub(c).mul(u.uResolution)).mul(P(u, 24));
  const k = smoothstep(0.75, 2.5, trailPx);
  const da = max(src.a, sm.a);
  const darkest = vec4(vec3(da).sub(max(vec3(src.a).sub(src.rgb), vec3(sm.a).sub(sm.rgb))), da);
  const res = pickMode(P(u, 3), sm, max(src, sm), darkest);
  return mix(src, res, k);
};

export const RADIAL_FAST_BLUR_PASS_BODIES = {
  'radialFastBlur:prep': prepBody,
  ...Object.fromEntries(Array.from({ length: 5 }, (_, k) => [`radialFastBlur:l${k}`, levelBody])),
  'radialFastBlur:main': mainBody,
};
