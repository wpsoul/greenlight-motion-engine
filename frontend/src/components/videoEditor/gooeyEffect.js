/*
 * Gooey — liquid merge (metaballs) as an Overlay Effect.
 *
 * Look-dev: promo-special/fx-labs/gooey_lab.html (the owner-approved lab; its GLSL passes are the reference).
 * Gates: tests/gooey/verify_render.mjs.
 *
 * THE LOOK. Blur the group's PREMULTIPLIED colour + alpha with a Gaussian, then cut the blurred alpha at a
 * threshold with a narrow smoothstep edge; the colour is the blurred colour ÷ the blurred alpha. Where two shapes
 * come close their halos sum above the threshold in the gap, so a liquid bridge grows between them; thin parts
 * and corners melt round. On a regular layer it melts that layer; on an adjustment item, everything below it; on
 * a sequence item, the sequence's composite (the usual set-up: the shapes or cursors in a sequence, Gooey on the
 * sequence item, the background and any sharp labels outside it).
 *
 * Radius is px at 1080p (the chain's `ref`), and σ = radius / 2 in plate px, as the lab sets it ("radius ≈ 2σ").
 *
 * THE COST STAYS FLAT. The lab blurs at half resolution and thresholds at full. Here the blur runs at full
 * resolution while σ ≤ 6 px (a few taps, and an exact identity at radius 0), at half resolution up to σ = 32 px
 * (the default 30 px radius at 1080p lands here — the lab's own path), and one more halving per doubling of σ
 * beyond, so a 200 px radius at 4K still costs ~85 taps a pixel per axis. Every level is VARIANCE-MATCHED: the 2^L
 * box decimation ((n² − 1)/12 px²) and the bilinear upsample (n²/6 px²) are subtracted from σ², so the field —
 * and the threshold edge it draws — is the same at every level, and a keyframed radius never steps across one.
 * The blur targets are half-float, so the threshold edge and colour ÷ alpha carry no 8-bit banding.
 *
 * Edges: the blur reads clamp-to-edge, as the lab does, so a shape running off the frame stays solid up to it.
 * The threshold's soft edge is clamped into 0…1 (the lab could put its low edge below 0 — Threshold 0.05 with
 * Softness 0.25 — which painted the empty frame black), so empty stays empty and a solid interior stays solid.
 */

const FULL_MAX = 6;      // σ (plate px) the full-resolution blur covers before halving
const SMAX = 16;         // σ per level, in level texels, before the next halving
const MAX_LEVEL = 5;     // 1/32 — σ 512 plate px (radius 200 at 1080p needs level 3 at 4K)
const TAPS = 2.6;        // tap half-width in σ, as the lab (the kernel is renormalised)
const TAP_CAP = 48;      // = ceil(2.6 · 16) + slack; the shaders' loop bound is 2 · TAP_CAP + 1

// One plan per (params object, plate): the chain resolves params once per effect per frame and asks every pass's
// hooks in turn.
const planCache = new WeakMap();

export function gooeyPlan(p, ctx) {
  const W = Math.max(1, Math.round(ctx?.width || 1));
  const H = Math.max(1, Math.round(ctx?.height || 1));
  const ref = ctx && Number.isFinite(ctx.ref) && ctx.ref > 0 ? ctx.ref : H / 1080;
  const cached = p ? planCache.get(p) : null;
  if (cached && cached.W === W && cached.H === H && cached.ref === ref) return cached;
  const sigma = (Math.max(0, Number(p?.radius) || 0) * ref) / 2;
  let plan;
  if (sigma < 0.3) {
    plan = { W, H, ref, sigma, blur: false, L: 0 };
  } else {
    const L = sigma <= FULL_MAX ? 0 : Math.min(MAX_LEVEL, Math.max(1, Math.ceil(Math.log2(sigma / SMAX))));
    const s = 2 ** -L;
    // The level's real size, rounded exactly as the pass pool sizes its target.
    const lw = Math.max(1, Math.round(W * s));
    const lh = Math.max(1, Math.round(H * s));
    const axis = (full, size) => {
      const tx = full / size;                                    // plate px per level texel
      const pre = L > 0 ? (tx * tx - 1) / 12 + (tx * tx) / 6 : 0; // box decimation + bilinear upsample, px²
      const sl = Math.sqrt(Math.max(sigma * sigma - pre, 0)) / tx;
      return { sigma: Math.max(sl, 1e-3), half: Math.min(TAP_CAP, Math.ceil(sl * TAPS)) };
    };
    plan = { W, H, ref, sigma, blur: true, L, scale: s, x: axis(W, lw), y: axis(H, lh) };
  }
  if (p) planCache.set(p, plan);
  return plan;
}

// ── GLSL ────────────────────────────────────────────────────────────────────
// Down: one bilinear tap at the destination texel centre = an exact 2×2 box of the level above.
const GY_DOWN_FX = /* glsl */ `
vec4 fx(vec2 uv) { return texture2D(uTexture, uv); }
`;

// One axis of the Gaussian, in this pass's own texels (uResolution = the level's size). The H pass reads the level
// above (or the plate), so each of its taps is that 2×2 box — the lab's fused downsample + H blur. Taps sit on whole
// texels and the kernel is renormalised, exactly as in the lab. [24] σ (level texels), [25] tap half-width,
// [26] axis (0 H, 1 V).
const GY_BLUR_FX = /* glsl */ `
vec4 fx(vec2 uv) {
  float sigma = max(uParams[24], 1e-3);
  float r = uParams[25];
  vec2 dir = uParams[26] > 0.5 ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
  vec2 stepUv = dir / uResolution;
  float k = -0.5 / (sigma * sigma);
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i <= ${2 * TAP_CAP}; i++) {
    float x = float(i) - r;
    if (x > r) break;
    float w = exp(k * x * x);
    acc += texture2D(uTexture, uv + stepUv * x) * w;
    ws += w;
  }
  return acc / max(ws, 1e-6);
}
`;

// The threshold, at full resolution: uTexture = the group, uTexture1 = its blurred field (bilinear from its level;
// the plate itself when Radius is 0). Slots: 1 threshold, 2 softness, 3 colour mode; colour 0 = the fill.
// Colour: 0 the blurred colour (two colours blend where they meet), 1 one fill, 2 the shapes keep their own pixels
// and colour where they are solid, and only the melt and the bridges come from the field.
const GY_MAIN_FX = /* glsl */ `
vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  vec4 b = texture2D(uTexture1, uv);
  float th = uParams[1];
  float soft = uParams[2];
  float lo = max(th - soft, 0.0);
  float hi = min(th + soft, 1.0) + 1e-4;
  float a = smoothstep(lo, hi, b.a);
  vec3 col = b.rgb / max(b.a, 1e-4);
  float mode = uParams[3];
  if (mode > 0.5 && mode < 1.5) {
    col = uColors[0];
  } else if (mode > 1.5) {
    vec3 sc = src.rgb / max(src.a, 1e-4);
    col = mix(col, sc, smoothstep(0.35, 0.95, src.a));
    a = max(a, src.a);
  }
  return vec4(clamp(col, 0.0, 1.0) * a, a);
}
`;

const levelScale = (i) => (p, c) => { const plan = gooeyPlan(p, c); return plan.blur ? 2 ** -i : 1; };
const levelBuffer = (lv) => (lv <= 0 ? 'source' : `gyD${lv}`);

// down<i> builds level i for a blur at level L > i (the H pass reads level L − 1 itself).
const downPass = (i) => ({
  key: `down${i}`,
  target: `gyD${i}`,
  hdr: true,
  scale: levelScale(i),
  inputs: { uTexture: levelBuffer(i - 1) },
  fragment: GY_DOWN_FX,
  skipIf: (p, c) => { const plan = gooeyPlan(p, c); return !plan.blur || plan.L - 1 < i; },
  alias: 'source',
});

const blurPass = (horiz) => ({
  key: horiz ? 'blurH' : 'blurV',
  target: horiz ? 'gyH' : 'gyV',
  hdr: true,
  scale: (p, c) => { const plan = gooeyPlan(p, c); return plan.blur ? plan.scale : 1; },
  inputs: (p, c) => {
    if (!horiz) return { uTexture: 'gyH' };
    const plan = gooeyPlan(p, c);
    return { uTexture: levelBuffer(plan.L - 1) };
  },
  fragment: GY_BLUR_FX,
  skipIf: (p, c) => !gooeyPlan(p, c).blur,
  alias: horiz ? 'source' : 'gyH',
  set: (p, c) => {
    const plan = gooeyPlan(p, c);
    const k = horiz ? plan.x : plan.y;
    return { 24: k ? k.sigma : 1, 25: k ? k.half : 0, 26: horiz ? 0 : 1 };
  },
});

export const GOOEY_EFFECT = {
  id: 'gooey',
  name: 'Gooey',
  group: 'Matte',
  animated: false,
  // A growth effect: the bridges ARE the pixels outside the silhouette, so it is never cut back to the layer's
  // shape (clipping would erase exactly what it adds).
  layerMatte: 'expand',
  params: [
    { key: 'radius', slot: 0, label: 'Radius', min: 0, max: 200, step: 1, default: 30, suffix: 'px' },
    { key: 'threshold', slot: 1, label: 'Threshold', min: 0.05, max: 0.95, step: 0.01, default: 0.5 },
    { key: 'softness', slot: 2, label: 'Softness', min: 0, max: 0.25, step: 0.005, default: 0.04 },
    { key: 'colorMode', slot: 3, label: 'Colour', type: 'select', default: 0,
      options: [
        { value: 0, label: 'Blend colours' },
        { value: 1, label: 'One fill' },
        { value: 2, label: 'Keep shapes + add bridges' },
      ] },
    { key: 'fill', type: 'color', colorSlot: 0, label: 'Fill', default: '#34efab', showIf: { key: 'colorMode', equals: 1 } },
  ],
  colorPresets: [
    { name: 'Liquid', params: { radius: 30, threshold: 0.5, softness: 0.04, colorMode: 0 } },
    { name: 'Tight', params: { radius: 14, threshold: 0.5, softness: 0.03, colorMode: 0 } },
    { name: 'Blobby', params: { radius: 60, threshold: 0.45, softness: 0.05, colorMode: 0 } },
    { name: 'Bridges', params: { radius: 44, threshold: 0.5, softness: 0.04, colorMode: 2 } },
    { name: 'One Fill', params: { radius: 40, threshold: 0.5, softness: 0.04, colorMode: 1 } },
  ],
  passes: [
    ...Array.from({ length: MAX_LEVEL - 1 }, (_, k) => downPass(k + 1)),
    blurPass(true),
    blurPass(false),
    {
      key: 'main',
      target: 'out',
      main: true,
      inputs: { uTexture: 'source', uTexture1: 'gyV' },
      fragment: GY_MAIN_FX,
    },
  ],
};
