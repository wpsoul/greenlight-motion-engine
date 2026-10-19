/*
 * Fast Blur — After Effects' Fast Box Blur, as an Overlay Effect.
 *
 * Look-dev and gates: html/overlay-effects-lab.html +
 * tests/layer-effect-labs/verify_overlay_effects.js (the GPU result matches an
 * exact CPU AE box blur at mean ≤ 0.75/255 across every pyramid level).
 *
 * THE MATHS IS AE's. Each iteration convolves a (2·Blurriness+1)-px box, so
 * Iterations 1 is a hard box and 3 reads as Gaussian. n boxes convolved = the
 * cardinal B-spline of order n, and every tap integrates that continuous
 * kernel over its texel (a difference of the Irwin–Hall CDF) — so fractional
 * and KEYFRAMED Blurriness stays smooth instead of stepping per whole pixel.
 *
 * THE COST IS FLAT. Blurring a 250 px radius directly is ~1500 taps a pixel.
 * Instead the blurred axes are halved (1 tap per level) until the kernel spans
 * ≤ MAXSPAN texels, blurred there, and bilinearly upsampled by the main pass.
 * The level's kernel is VARIANCE-MATCHED: the 2^L box decimation (1/12 texel²),
 * the bilinear upsample (1/6) and the per-texel binning (1/12) are subtracted,
 * so the result is the same blur at any level. A hard box (n = 1) still
 * reshapes slightly between levels, so in the top BAND of a level's range the
 * next level is blurred too and cross-faded in — an animated Blurriness never
 * steps when it crosses a level (measured Δ 0.02/255 across vs 0.2 per 0.38 px).
 *
 * One-axis blur halves ONLY that axis: a uniform pyramid would soften the axis
 * the user asked to keep sharp.
 *
 * Units: Blurriness is px at 1080p (the chain's `ref`), so the preview (half
 * resolution) and a 4K export show the same blur relative to the frame.
 *
 * Nothing runs for what is not used: Blurriness 0 bypasses the effect outright
 * (`bypassIf` — zero passes), skipped levels and the unused axis never render,
 * and the second level exists only inside the blend band.
 */

const MAXSPAN = 48;      // kernel support per level, in level texels
const BAND = 0.25;       // log2 fraction at the top of a level that also blurs L+1
const MAX_LEVEL = 7;     // deepest level any pass can reference (1/128)

// One plan per (params object, plate ref): the Player resolves params once per
// effect per frame and asks every pass's hooks in turn.
const planCache = new WeakMap();

export function fastBlurPlan(p, ctx) {
  const ref = ctx && Number.isFinite(ctx.ref) && ctx.ref > 0 ? ctx.ref : 1;
  const cached = p ? planCache.get(p) : null;
  if (cached && cached.ref === ref) return cached;
  const r = Math.max(0, Number(p?.blurriness) || 0) * ref;
  const n = Math.min(5, Math.max(1, Math.round(Number(p?.iterations) || 3)));
  const dims = Number(p?.dimensions) || 0;
  const doX = dims !== 2;
  const doY = dims !== 1;
  let plan;
  if (r <= 1e-3) {
    plan = { ref, off: true };
  } else {
    const w = 2 * r + 1;
    const V = (n * (w * w - 1)) / 12;          // discrete AE box variance per axis, px²
    const lf = Math.log2((n * w) / MAXSPAN);
    const raw = Math.max(0, Math.ceil(lf));
    const L = Math.min(MAX_LEVEL, raw);
    const blend = L < MAX_LEVEL && raw <= MAX_LEVEL
      ? Math.min(1, Math.max(0, (lf - (L - BAND)) / BAND)) : 0;
    const two = blend > 0.001;
    plan = { ref, off: false, r, n, doX, doY, V, L, blend: two ? blend : 0, two, top: two ? L + 1 : L };
  }
  if (p) planCache.set(p, plan);
  return plan;
}

// Per-axis scale of a level: only the blurred axes are halved.
const levelScale = (plan, lv) => [plan.doX ? 2 ** -lv : 1, plan.doY ? 2 ** -lv : 1];
const levelBuffer = (lv) => (lv === 0 ? 'source' : `fbD${lv}`);

// Bound per axis: comp px per level texel, the variance-matched box width in
// level texels, and the tap half-width that covers its n-fold support.
function axisKernel(plan, lv, horiz, ctx) {
  const full = horiz ? ctx.width : ctx.height;
  const size = Math.max(1, Math.round(full * (horiz ? levelScale(plan, lv)[0] : levelScale(plan, lv)[1])));
  const tx = full / size;
  const pre = lv > 0 ? 0.25 : 0;
  const wl = Math.sqrt(Math.max((12 * (plan.V / (tx * tx) - pre - 1 / 12)) / plan.n, 1e-6));
  const half = Math.min(96, Math.ceil((plan.n * wl) / 2 + 1));
  return { wl, half };
}

// ── GLSL ────────────────────────────────────────────────────────────────────
// Down: one bilinear tap at the destination texel centre = an exact 2×2 box on
// each halved axis; an un-halved axis lands on a texel centre and is copied.
const FB_DOWN_FX = /* glsl */ `
vec4 fx(vec2 uv) { return texture2D(uTexture, uv); }
`;

// One axis of the n-fold box. [24] box width (level texels), [25] tap half
// width, [26] axis (0 H, 1 V), [27] iterations — all from the pass's set().
const FB_BLUR_FX = /* glsl */ `
float fbCdf(float x, float n) {
  if (x <= 0.0) return 0.0;
  if (x >= n) return 1.0;
  bool flip = x > 0.5 * n;
  float xx = flip ? n - x : x;
  float fact = 1.0;
  for (int i = 2; i <= 5; i++) { if (float(i) > n + 0.5) break; fact *= float(i); }
  float s = 0.0;
  float c = 1.0;
  for (int j = 0; j <= 5; j++) {
    float fj = float(j);
    if (fj > xx || fj > n + 0.5) break;
    float d = xx - fj;
    float pw = 1.0;
    for (int k = 0; k < 5; k++) { if (float(k) >= n - 0.5) break; pw *= d; }
    s += (mod(fj, 2.0) < 0.5 ? c : -c) * pw;
    c *= (n - fj) / (fj + 1.0);
  }
  float F = s / fact;
  return flip ? 1.0 - F : F;
}
vec4 fx(vec2 uv) {
  float wl = max(uParams[24], 1e-3);
  int halfTaps = int(uParams[25] + 0.5);
  vec2 dir = uParams[26] > 0.5 ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
  float n = uParams[27];
  bool repeatEdges = uParams[3] > 0.5;
  vec2 stepUv = dir / uResolution;
  vec2 lo = 0.5 / uResolution;
  vec2 hi = 1.0 - 0.5 / uResolution;
  float c0 = 0.5 * n;
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i <= 192; i++) {
    int k = i - halfTaps;
    if (k > halfTaps) break;
    float fk = float(k);
    float w = fbCdf((fk + 0.5) / wl + c0, n) - fbCdf((fk - 0.5) / wl + c0, n);
    vec2 suv = uv + stepUv * fk;
    vec4 s = repeatEdges ? texture2D(uTexture, clamp(suv, lo, hi)) : sampleClamped(uTexture, suv);
    acc += s * w;
    ws += w;
  }
  return acc / max(ws, 1e-6);
}
`;

// Main: bilinear upsample of the blurred level (uTexture1), cross-faded with the
// next level (uTexture2) inside the blend band. [24] 1 = blurred this frame,
// [25] blend, [26] dither. ±½ LSB dither only when a pyramid ran: 8-bit levels
// band on a smooth sky otherwise.
const FB_MAIN_FX = /* glsl */ `
vec4 fx(vec2 uv) {
  if (uParams[24] < 0.5) return texture2D(uTexture, uv);
  vec4 b = texture2D(uTexture1, uv);
  if (uParams[25] > 0.0) b = mix(b, texture2D(uTexture2, uv), uParams[25]);
  if (uParams[26] > 0.5) {
    vec2 px = floor(uv * uResolution);
    float nz = (hash21(px) + hash21(px + 71.0) - 1.0) / 255.0;
    b.rgb = min(clamp(b.rgb + nz, 0.0, 1.0), vec3(b.a));
  }
  return b;
}
`;

const downPass = (i) => ({
  key: `down${i}`,
  target: `fbD${i}`,
  scale: (p, c) => levelScale(fastBlurPlan(p, c), i),
  inputs: { uTexture: levelBuffer(i - 1) },
  fragment: FB_DOWN_FX,
  skipIf: (p, c) => { const plan = fastBlurPlan(p, c); return plan.off || plan.top < i; },
  alias: 'source',
});

// which = 'A' (level L) or 'B' (level L+1, blend band only).
const blurPass = (which, horiz) => ({
  key: `blur${horiz ? 'H' : 'V'}${which}`,
  target: `fb${horiz ? 'H' : 'V'}${which}`,
  scale: (p, c) => {
    const plan = fastBlurPlan(p, c);
    return plan.off ? 1 : levelScale(plan, which === 'A' ? plan.L : plan.L + 1);
  },
  inputs: (p, c) => {
    const plan = fastBlurPlan(p, c);
    const lv = which === 'A' ? plan.L : plan.L + 1;
    if (horiz || !plan.doX) return { uTexture: levelBuffer(lv) };
    return { uTexture: `fbH${which}` };
  },
  fragment: FB_BLUR_FX,
  skipIf: (p, c) => {
    const plan = fastBlurPlan(p, c);
    if (plan.off || (which === 'B' && !plan.two)) return true;
    return horiz ? !plan.doX : !plan.doY;
  },
  alias: 'source',
  set: (p, c) => {
    const plan = fastBlurPlan(p, c);
    const k = axisKernel(plan, which === 'A' ? plan.L : plan.L + 1, horiz, c);
    return { 24: k.wl, 25: k.half, 26: horiz ? 0 : 1, 27: plan.n };
  },
});

// The result buffer of one level: V when vertical ran, H otherwise.
const levelResult = (plan, which) => (plan.doY ? `fbV${which}` : `fbH${which}`);

export const FAST_BLUR_EFFECT = {
  id: 'fastBlur',
  name: 'Fast Blur',
  group: 'Lens',
  animated: false,
  // A growth effect: the blur spreads past the silhouette, so it is never cut
  // back to the layer's shape (clipping would erase exactly what it adds).
  layerMatte: 'expand',
  params: [
    { key: 'blurriness', slot: 0, label: 'Blurriness', min: 0, max: 250, step: 0.5, default: 20, suffix: 'px' },
    { key: 'iterations', slot: 1, label: 'Iterations', min: 1, max: 5, step: 1, default: 3 },
    { key: 'dimensions', slot: 2, label: 'Blur Dimensions', type: 'select', default: 0,
      options: [
        { value: 0, label: 'Horizontal and Vertical' },
        { value: 1, label: 'Horizontal' },
        { value: 2, label: 'Vertical' },
      ] },
    // AE's default is Off; On here, because a full-frame blur that darkens and
    // turns transparent at the frame edges is the classic surprise.
    { key: 'repeatEdges', slot: 3, label: 'Repeat Edge Pixels', type: 'select', default: 1,
      options: [{ value: 1, label: 'On' }, { value: 0, label: 'Off' }] },
  ],
  colorPresets: [
    { name: 'Soft', params: { blurriness: 4, iterations: 3, dimensions: 0 } },
    { name: 'Defocus', params: { blurriness: 18, iterations: 3, dimensions: 0 } },
    { name: 'Heavy', params: { blurriness: 80, iterations: 3, dimensions: 0 } },
    { name: 'Box', params: { blurriness: 16, iterations: 1, dimensions: 0 } },
    { name: 'Smear H', params: { blurriness: 70, iterations: 2, dimensions: 1 } },
    { name: 'Smear V', params: { blurriness: 70, iterations: 2, dimensions: 2 } },
  ],
  bypassIf: (p, c) => fastBlurPlan(p, c).off,
  passes: [
    // top ≤ MAX_LEVEL (the blend band never opens on the deepest level).
    ...Array.from({ length: MAX_LEVEL }, (_, k) => downPass(k + 1)),
    blurPass('A', true),
    blurPass('A', false),
    blurPass('B', true),
    blurPass('B', false),
    {
      key: 'main',
      target: 'out',
      main: true,
      inputs: (p, c) => {
        const plan = fastBlurPlan(p, c);
        if (plan.off) return { uTexture: 'source', uTexture1: 'source', uTexture2: 'source' };
        const a = levelResult(plan, 'A');
        return { uTexture: 'source', uTexture1: a, uTexture2: plan.two ? levelResult(plan, 'B') : a };
      },
      fragment: FB_MAIN_FX,
      set: (p, c) => {
        const plan = fastBlurPlan(p, c);
        return { 24: plan.off ? 0 : 1, 25: plan.off ? 0 : plan.blend, 26: !plan.off && plan.top > 0 ? 1 : 0 };
      },
    },
  ],
};
