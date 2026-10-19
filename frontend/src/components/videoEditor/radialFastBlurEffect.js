/*
 * Radial Fast Blur — After Effects' CC Radial Fast Blur, as an Overlay Effect.
 *
 * Built to port AE light rigs (the "Light Text Reveal" template: a thin line
 * whose pixels are smeared AWAY from a light source into a cone of light). The
 * existing Radial Blur is a short symmetric zoom (±30 % of the distance) and
 * Light Rays averages 24–48 jittered taps, so a 2–4 px line smeared over 5–10×
 * its distance from the centre came out dotted and ~1 % bright. This effect
 * smears contiguously over any length, and its Brightest mode keeps a thin
 * line at full strength along the whole trail.
 *
 * THE TRAIL. A pixel at distance r from the Center gathers the picture along
 * the segment towards the Center, down to (1 − Amount) · r. Amount 87 reaches
 * back to 13 % of the distance, i.e. a feature smears out to 7.7× its own
 * distance from the Center. Zoom picks how the trail combines (AE's names):
 *   Standard   weighted average — a zoom blur;
 *   Brightest  per-channel maximum — light rays; a thin bright line stays bright;
 *   Darkest    the darkest colour along the trail — shadow rays. Transparent
 *              pixels are neutral, so a layer's empty surround does not win.
 * Falloff dims the trail each time its distance from the Center doubles
 * (Falloff 50 % → half strength at 2×, a quarter at 4×), and Intensity stacks
 * the trail onto itself (opacity 1 − (1 − α)^Intensity, colour kept), so the
 * trail holds full strength until Falloff has thinned it to ~1 / Intensity,
 * then fades: a plateau, a smooth shoulder and a power-law tail. CC Radial
 * Fast Blur has neither control, but its trails look like this (a thin 4 px
 * line keeps a bright plateau out to ~2× its distance), and Brightest +
 * Falloff + Intensity is how a CC rig is matched — the measured fit is in
 * tests/radial-fast-blur/README.md. Standard here is a true, normalised zoom
 * blur: a thin line is diluted over its trail (CC's Standard is not).
 *
 * THE COST IS FLAT. A dense trail of N samples is N taps a pixel. Instead the
 * samples are log-spaced (each one a fixed RATIO closer to the Center) and
 * gathered hierarchically: level k combines 8 taps whose ratios are 8^k steps
 * apart, so K levels cover 8^K contiguous steps with 8·K taps. K (1–5) is the
 * fewest levels whose step stays under ¾ of a pass texel at the frame's far
 * corner — Amount 87 at 1080p needs 4 levels (32 taps). Separable weights:
 * Standard s^(1+γ) (γ = 0 is the classic linear-in-distance zoom blur),
 * Brightest/Darkest s^γ, with s the sample's distance ratio and γ = −log2(1 − Falloff).
 * Levels run at half resolution (a trail is soft by construction); the main
 * pass puts the full-resolution source back wherever the trail is under ~2 px
 * long, so the picture near the Center stays sharp.
 *
 * Brightest/Darkest open with a 3×3 maximum at half-texel offsets (≈ ±1 source
 * px) while downsampling. Without it a 1-texel line sampled at a fractional
 * offset loses up to half its value, and the maximum along the ray inherits
 * that phase as moiré bands; a full-texel 3×3 also fixed that but pushed the
 * cone's near edge ~3 px towards the Center, in front of the line.
 *
 * Center X/Y are 0–1 with y UP, like every effect centre. Space: Layer rides
 * the layer's box (Radial Blur's behaviour); Composition pins the Center to
 * the frame — a fixed light that a moving, rotating layer passes in front of,
 * which is how CC Radial Fast Blur behaves on an AE shape layer. On an
 * adjustment layer the box IS the frame, so both read the same.
 *
 * Nothing runs for what is not used: Amount 0 bypasses the effect outright
 * (`bypassIf` — zero passes), and levels past K never render.
 */

const TAPS = 8;
const MAX_LEVELS = 5;
const STEP_TEXELS = 0.75;
const PASS_SCALE = 0.5;
const MAX_AMOUNT = 0.998;

const planCache = new WeakMap();

export function radialFastBlurPlan(p, ctx) {
  const w = ctx && Number.isFinite(ctx.width) ? ctx.width : 1920;
  const h = ctx && Number.isFinite(ctx.height) ? ctx.height : 1080;
  const cached = p ? planCache.get(p) : null;
  if (cached && cached.w === w && cached.h === h) return cached;
  const A = Math.min(MAX_AMOUNT, Math.max(0, (Number(p?.amount) || 0) / 100));
  let plan;
  if (A <= 1e-4) {
    plan = { w, h, off: true };
  } else {
    const lam = -Math.log(1 - A);
    // Farthest a pixel can sit from the Center, in pass texels: the pass
    // diagonal, grown when the Center itself is off the frame.
    const cx = Number.isFinite(Number(p?.centerX)) ? Number(p.centerX) : 0.5;
    const cy = Number.isFinite(Number(p?.centerY)) ? Number(p.centerY) : 0.5;
    const excess = Math.max(0, Math.abs(cx - 0.5) - 0.5, Math.abs(cy - 0.5) - 0.5);
    const R = Math.hypot(w * PASS_SCALE, h * PASS_SCALE) * (1 + 2 * excess);
    const need = Math.max(2, (lam * R) / STEP_TEXELS);
    const K = Math.min(MAX_LEVELS, Math.max(1, Math.ceil(Math.log(need) / Math.log(TAPS))));
    const lnq = -lam / (TAPS ** K - 1);
    const F = Math.min(0.995, Math.max(0, (Number(p?.falloff) || 0) / 100));
    plan = { w, h, off: false, A, K, lnq, gamma: -Math.log2(1 - F) };
  }
  if (p) planCache.set(p, plan);
  return plan;
}

// The Center in frame uv. [5] Space: 0 Layer (through the box), 1 Composition.
const RFB_CENTER = /* glsl */ `
vec2 rfbCenter() {
  vec2 c = vec2(uParams[1], uParams[2]);
  return uParams[5] > 0.5 ? c : fxFrame(c);
}
`;

// Brightest / Darkest run their levels in a LOG-ENCODED 8-bit space:
// e = 1 + ln(x) / K (K = 10 nats, x ≤ e^-10 → 0). The maximum commutes with a
// monotonic encoding and the falloff weights become additive (ln w = γ·ln s),
// so the hierarchy is exact in that domain — and 8 bits then hold ~4 % RELATIVE
// precision over the whole range instead of 1/255 absolute. Linear 8-bit
// intermediates stepped visibly in the dim tail once Intensity multiplied it
// back up (×14 → 14/255 bands). Darkest encodes the DARKNESS (1 − v), whose
// maximum is the darkest sample. The last level (uParams[26] = 1) decodes,
// applies Intensity, and writes plain premultiplied colour for the main pass.
const RFB_CODEC = /* glsl */ `
vec4 rfbEnc(vec4 x) { return clamp(1.0 + log(max(x, vec4(1e-30))) / 10.0, 0.0, 1.0); }
vec4 rfbDec(vec4 e) { return exp((e - 1.0) * 10.0); }
`;

// Brightest / Darkest open with a half-texel 3×3 dilate (see the header); Standard is the
// plain half-resolution tap (a 2×2 box of the source). All nine taps are read
// unconditionally so the WebGPU twin keeps every sample in uniform flow.
//
// Darkest runs the SAME maximum over a premultiplied DARKNESS (a − rgb, a): the
// amount a pixel darkens what lies beneath it, with its coverage. A transparent
// pixel is then neutral (0, 0) instead of "the darkest thing on the plate" —
// a plain per-channel minimum let the empty frame around a layer win every ray
// and erased the layer. On an opaque plate it is exactly the darkest colour.
const RFB_PREP_FX = /* glsl */ `
${RFB_CODEC}
vec4 rfbDarkness(vec4 v) { return vec4(v.a - v.rgb, v.a); }
vec4 fx(vec2 uv) {
  float mode = uParams[3];
  vec2 px = 0.5 / uResolution;
  vec4 c0 = texture2D(uTexture, uv);
  vec4 hi = mode > 1.5 ? rfbDarkness(c0) : c0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 suv = uv + vec2(float(dx), float(dy)) * px;
      vec4 v = texture2D(uTexture, suv);
      bool inside = suv.x >= 0.0 && suv.x <= 1.0 && suv.y >= 0.0 && suv.y <= 1.0;
      vec4 t = mode > 1.5 ? rfbDarkness(v) : v;
      hi = max(hi, inside ? t : vec4(0.0));
    }
  }
  return mode < 0.5 ? c0 : rfbEnc(hi);
}
`;

// One level: 8 taps along the ray, ratio exp([24] · j) of the distance to the
// Center. [25] = γ, [26] = 1 on the LAST level (decode + Intensity). Off-frame
// samples are transparent (Standard / Brightest) and neutral for Darkest. The
// Standard weights are normalised over all eight taps, so the frame edge fades
// the trail the way AE's does.
//
// [6] Intensity stacks the trail onto itself: opacity 1 − (1 − α)^Intensity,
// colour kept — the alpha of Intensity screened copies. 100 % is the identity;
// above it a faint tail gains ~Intensity× while the core saturates SMOOTHLY at 1
// (a hard min(1, α·I) clip drew a visible Mach band where the plateau ends).
// It is the counterpart of Falloff, which fades premultiplied samples, i.e.
// their opacity.
const RFB_LEVEL_FX = /* glsl */ `
${RFB_CENTER}
${RFB_CODEC}
vec4 fx(vec2 uv) {
  vec2 c = rfbCenter();
  vec2 d = uv - c;
  float lnStep = uParams[24];
  float gam = uParams[25];
  float mode = uParams[3];
  vec4 sum = vec4(0.0);
  float ws = 0.0;
  vec4 em = vec4(0.0);
  for (int j = 0; j < 8; j++) {
    float lnS = lnStep * float(j);
    vec2 suv = c + d * exp(lnS);
    vec4 v = texture2D(uTexture, suv);
    bool inside = suv.x >= 0.0 && suv.x <= 1.0 && suv.y >= 0.0 && suv.y <= 1.0;
    float wsd = exp((1.0 + gam) * lnS);
    sum += (inside ? v : vec4(0.0)) * wsd;
    ws += wsd;
    em = max(em, inside ? max(v + gam * lnS / 10.0, vec4(0.0)) : vec4(0.0));
  }
  vec4 avg = sum / max(ws, 1e-6);
  vec4 enc = mode < 0.5 ? avg : em;
  vec4 lin = mode < 0.5 ? avg : rfbDec(em);
  float gain = max(uParams[6] / 100.0, 1e-3);
  float a2 = 1.0 - pow(max(1.0 - lin.a, 0.0), gain);
  // Straight colour (Darkest: 1 − straight darkness), kept while Intensity
  // restacks the opacity.
  vec3 straight = min(lin.rgb / max(lin.a, 1e-6), vec3(1.0));
  straight = mode > 1.5 ? vec3(1.0) - straight : straight;
  vec4 fin = vec4(straight * a2, a2);
  return uParams[26] > 0.5 ? fin : enc;
}
`;

// Main: the finished half-resolution trail (uTexture1) against the
// full-resolution source (uSource). Where the trail is shorter than ~2 px the
// sharp source stands, so the Center region keeps its detail. [24] = Amount.
const RFB_MAIN_FX = /* glsl */ `
${RFB_CENTER}
vec4 fx(vec2 uv) {
  vec4 src = texture2D(uSource, uv);
  vec4 sm = texture2D(uTexture1, uv);
  vec2 c = rfbCenter();
  float trailPx = length((uv - c) * uResolution) * uParams[24];
  float k = smoothstep(0.75, 2.5, trailPx);
  float mode = uParams[3];
  // Darkest: the larger coverage and the larger darkness (see the prep pass).
  float da = max(src.a, sm.a);
  vec4 darkest = vec4(vec3(da) - max(vec3(src.a) - src.rgb, vec3(sm.a) - sm.rgb), da);
  vec4 res = mode < 0.5 ? sm : (mode < 1.5 ? max(src, sm) : darkest);
  return mix(src, res, k);
}
`;

const levelPass = (k) => ({
  key: `l${k}`,
  target: `rfbL${k}`,
  scale: PASS_SCALE,
  // Ping-pong two pooled targets: each level reads only the one before it.
  poolSlot: k % 2 === 0 ? 'rfb1' : 'rfb0',
  inputs: { uTexture: k === 0 ? 'rfbP' : `rfbL${k - 1}` },
  fragment: RFB_LEVEL_FX,
  skipIf: (p, c) => { const plan = radialFastBlurPlan(p, c); return plan.off || k >= plan.K; },
  alias: k === 0 ? 'rfbP' : `rfbL${k - 1}`,
  set: (p, c) => {
    const plan = radialFastBlurPlan(p, c);
    return { 24: plan.off ? 0 : plan.lnq * TAPS ** k, 25: plan.off ? 0 : plan.gamma, 26: !plan.off && k === plan.K - 1 ? 1 : 0 };
  },
});

export const RADIAL_FAST_BLUR_EFFECT = {
  id: 'radialFastBlur',
  name: 'Radial Fast Blur',
  group: 'Lens',
  animated: false,
  // A growth effect: the trail lands outside the silhouette by design.
  layerMatte: 'expand',
  params: [
    { key: 'amount', slot: 0, label: 'Amount', min: 0, max: 100, step: 0.5, default: 50, suffix: '%' },
    { key: 'centerX', slot: 1, label: 'Center X', min: -0.5, max: 1.5, step: 0.005, default: 0.5 },
    { key: 'centerY', slot: 2, label: 'Center Y', min: -0.5, max: 1.5, step: 0.005, default: 0.5 },
    { key: 'zoom', slot: 3, label: 'Zoom', type: 'select', default: 0,
      options: [
        { value: 0, label: 'Standard' },
        { value: 1, label: 'Brightest' },
        { value: 2, label: 'Darkest' },
      ] },
    { key: 'falloff', slot: 4, label: 'Falloff', min: 0, max: 100, step: 0.5, default: 0, suffix: '%' },
    { key: 'intensity', slot: 6, label: 'Intensity', min: 0, max: 5000, step: 10, default: 100, suffix: '%' },
    { key: 'space', slot: 5, label: 'Center Space', type: 'select', default: 0,
      options: [
        { value: 0, label: 'Layer' },
        { value: 1, label: 'Composition' },
      ] },
  ],
  colorPresets: [
    { name: 'Zoom Burst', params: { amount: 35, zoom: 0, falloff: 0, intensity: 100 } },
    { name: 'Light Rays', params: { amount: 85, zoom: 1, falloff: 75, intensity: 400 } },
    { name: 'Light Cone', params: { amount: 94, zoom: 1, falloff: 93.5, intensity: 3000 } },
    { name: 'Long Streaks', params: { amount: 94, zoom: 1, falloff: 30, intensity: 100 } },
    { name: 'Shadow Rays', params: { amount: 70, zoom: 2, falloff: 40, intensity: 100 } },
  ],
  bypassIf: (p, c) => radialFastBlurPlan(p, c).off,
  passes: [
    {
      key: 'prep',
      target: 'rfbP',
      scale: PASS_SCALE,
      poolSlot: 'rfb0',
      inputs: { uTexture: 'source' },
      fragment: RFB_PREP_FX,
    },
    ...Array.from({ length: MAX_LEVELS }, (_, k) => levelPass(k)),
    {
      key: 'main',
      target: 'out',
      main: true,
      inputs: { uTexture1: `rfbL${MAX_LEVELS - 1}` },
      fragment: RFB_MAIN_FX,
      set: (p, c) => ({ 24: radialFastBlurPlan(p, c).A || 0 }),
    },
  ],
};
