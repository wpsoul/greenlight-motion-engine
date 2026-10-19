// Shared helpers for the native motion templates (ported from the MotionFast /
// GreenLight HTML templates). Same easing/RNG/split helpers the originals use, so
// the canvas ports match their timing. All templates are pure functions of time.
import { isMotionVideoUrl, getAmbientVideoEntry, requestVideoFrame, getMotionVideoSource } from './motionVideo';
import { bezierEase } from '../easingEngine';

export const clamp01 = (v) => Math.max(0, Math.min(1, v));
export const lerp = (a, b, t) => a + (b - a) * t;

export const easeOutCubic = (t) => { t = clamp01(t); return 1 - Math.pow(1 - t, 3); };
export const easeInOutCubic = (t) => { t = clamp01(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
export const easeOutQuad = (t) => { t = clamp01(t); return 1 - (1 - t) * (1 - t); };
export const power1Out = easeOutQuad;
export function backOut(t, c1 = 1.70158) { t = clamp01(t); const c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
export function elasticOut(t) {
  t = clamp01(t);
  if (t === 0 || t === 1) return t;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
}

const powerOut = (power) => (t) => { t = clamp01(t); return 1 - Math.pow(1 - t, power); };
export const power2Out = easeOutCubic;
export const power3Out = powerOut(4);
export const power4Out = powerOut(5);
export const expoOut = (t) => { t = clamp01(t); return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); };
export function bounceOut(t) {
  t = clamp01(t);
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
  if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
  t -= 2.625 / d1;
  return n1 * t * t + 0.984375;
}

const sampledValues = (source) => source.split(',').map(Number);
const LEGACY_SAMPLED_EASES = {
  elastic: sampledValues('0,.0221,.0739,.1485,.2394,.3402,.4458,.5517,.6541,.7502,.8375,.9149,.9813,1.0364,1.0803,1.1136,1.1369,1.1513,1.1579,1.1578,1.1522,1.1424,1.1294,1.1142,1.0978,1.081,1.0643,1.0485,1.0338,1.0205,1.009,.9992,.9912,.9849,.9803,.9772,.9754,.9748,.9752,.9764,.9782,.9804,.9829,.9856,.9882,.9908,.9933,.9955,.9975,.9992,1.0007,1.0018,1.0027,1.0034,1.0038,1.004,1.004,1.0039,1.0036,1.0033,1.0029,1.0025,1.0021,1.0017,1.0013,1.0009,1.0006,1.0003,1,.9998,.9996,.9995,.9994,.9994,.9994,.9994,.9994,.9994,.9995,.9996,.9996,.9997,.9998,.9998,.9999,.9999,1,1,1,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1'),
  overshoot: sampledValues('0,.1739,.3067,.4183,.515,.6,.6755,.743,.8034,.8576,.9063,.95,.9891,1.0241,1.0551,1.0825,1.1066,1.1275,1.1455,1.1606,1.1731,1.183,1.1906,1.1959,1.199,1.2,1.1997,1.1988,1.1972,1.195,1.1921,1.1886,1.1846,1.18,1.1749,1.1695,1.1638,1.1579,1.1519,1.1458,1.1397,1.1337,1.1277,1.1219,1.1162,1.1107,1.1053,1.1002,1.0952,1.0904,1.0857,1.0813,1.077,1.0729,1.0689,1.0651,1.0615,1.058,1.0547,1.0515,1.0484,1.0455,1.0427,1.0401,1.0375,1.0351,1.0327,1.0305,1.0284,1.0264,1.0244,1.0226,1.0209,1.0192,1.0176,1.0162,1.0148,1.0134,1.0122,1.011,1.0099,1.0088,1.0079,1.007,1.0061,1.0053,1.0046,1.0039,1.0033,1.0028,1.0023,1.0018,1.0014,1.0011,1.0008,1.0005,1.0003,1.0002,1.0001,1,1'),
  impulse: sampledValues('0,-.0006,-.0023,-.005,-.0086,-.0131,-.0183,-.0243,-.0308,-.038,-.0456,-.0537,-.0622,-.071,-.0801,-.0894,-.0988,-.1084,-.1179,-.1275,-.1369,-.1461,-.1551,-.1636,-.1717,-.1791,-.1858,-.1915,-.1959,-.1989,-.2,-.1986,-.1944,-.187,-.1762,-.1616,-.1432,-.1206,-.0939,-.0632,-.0289,.0087,.0487,.0906,.1334,.1765,.2193,.2613,.3022,.3416,.3794,.4156,.4501,.483,.5142,.5438,.5719,.5986,.6239,.6478,.6705,.692,.7124,.7317,.75,.7673,.7837,.7993,.814,.8279,.841,.8535,.8652,.8763,.8868,.8967,.9059,.9147,.9229,.9305,.9377,.9444,.9507,.9565,.9619,.9669,.9714,.9756,.9794,.9829,.986,.9888,.9912,.9933,.9952,.9967,.9979,.9988,.9995,.9999,1'),
  swing: sampledValues('0,-.0013,-.0052,-.0115,-.0199,-.0302,-.0421,-.0554,-.0697,-.0847,-.1,-.1153,-.1303,-.1446,-.1579,-.1698,-.1801,-.1885,-.1948,-.1987,-.2,-.1986,-.1942,-.1863,-.1744,-.1578,-.136,-.1079,-.0725,-.0288,.0241,.087,.1594,.2396,.3241,.4088,.4899,.5651,.6332,.6941,.7482,.796,.8384,.8758,.9088,.9379,.9636,.9863,1.0061,1.0235,1.0386,1.0517,1.0628,1.0723,1.0801,1.0865,1.0916,1.0954,1.098,1.0995,1.1,1.0997,1.0987,1.097,1.0947,1.0919,1.0885,1.0847,1.0806,1.0762,1.0717,1.0671,1.0624,1.0578,1.0533,1.0489,1.0447,1.0406,1.0368,1.0332,1.0297,1.0265,1.0235,1.0207,1.0181,1.0157,1.0135,1.0115,1.0097,1.008,1.0065,1.0052,1.0041,1.0031,1.0022,1.0015,1.001,1.0005,1.0002,1.0001,1'),
};

function sampledEase(values, t) {
  t = clamp01(t);
  const index = t * (values.length - 1);
  const low = Math.floor(index);
  const high = Math.min(values.length - 1, low + 1);
  return lerp(values[low], values[high], index - low);
}

// Convert After Effects' temporal KeyframeEase values to a normalized curve.
// averageSpeed is total value-distance / segment duration (use spatial distance for Position).
export function aeSpeedEase(outSpeed, outInfluence, inSpeed, inInfluence, averageSpeed) {
  const numericAverage = Number(averageSpeed);
  const safeAverage = Number.isFinite(numericAverage) && Math.abs(numericAverage) > 1e-9 ? numericAverage : 1;
  const x1 = clamp01(Number(outInfluence) / 100);
  const x2 = 1 - clamp01(Number(inInfluence) / 100);
  const y1 = x1 * (Number(outSpeed) || 0) / safeAverage;
  const y2 = 1 - (1 - x2) * (Number(inSpeed) || 0) / safeAverage;
  return bezierEase(x1, y1, x2, y2);
}

// Curves extracted from easing.aep. Its keyframe speeds are effectively zero,
// so the temporal influences map directly to these cubic-bezier handles.
export const AE_EASING_DEFS = {
  aeIn: [0.3141666673, 0, 0.0875000209, 1],
  aeSmooth: [0.8820833270, 0, 0.2445833683, 1],
  aeOut: [0.8699999754, 0, 0.6433336333, 1],
};

const EASES = {
  smooth: () => bezierEase(0.5, 0, 0, 1),
  power2: () => power2Out,
  power3: () => power3Out,
  power4: () => power4Out,
  back: () => backOut,
  bounce: () => bounceOut,
  expo: () => expoOut,
  natural: () => bezierEase(0.8, 0, 0.2, 1),
  slowDown: () => bezierEase(0, 0, 0, 1),
  elastic: () => (t) => sampledEase(LEGACY_SAMPLED_EASES.elastic, t),
  overshoot: () => (t) => sampledEase(LEGACY_SAMPLED_EASES.overshoot, t),
  impulse: () => (t) => sampledEase(LEGACY_SAMPLED_EASES.impulse, t),
  swing: () => (t) => sampledEase(LEGACY_SAMPLED_EASES.swing, t),
  aeIn: () => bezierEase(...AE_EASING_DEFS.aeIn),
  aeSmooth: () => bezierEase(...AE_EASING_DEFS.aeSmooth),
  aeOut: () => bezierEase(...AE_EASING_DEFS.aeOut),
  // legacy names from before the easing.aep rework — resolve to the new curves
  aeLate: () => bezierEase(...AE_EASING_DEFS.aeOut),
  aeSnappy: () => bezierEase(...AE_EASING_DEFS.aeIn),
};

export function getEase(name) {
  return (EASES[name] || EASES.smooth)();
}

export const splitLines = (t) => String(t || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
export const splitWords = (t) => String(t || '').trim().split(/\s+/).filter(Boolean);

// Deterministic RNG matching the templates' makeSeededRandom.
export function makeSeededRandom(seed) {
  let s = seed;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}
// Deterministic per-index noise matching the templates' noise().
export function noise(x) { const y = Math.sin(x) * 10000; return y - Math.floor(y); }

// Field option lists reused across templates.
export const EASING_OPTIONS = [
  { value: 'smooth', label: 'Smooth' },
  { value: 'power2', label: 'Power 2' },
  { value: 'power3', label: 'Power 3' },
  { value: 'power4', label: 'Power 4' },
  { value: 'back', label: 'Back' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'expo', label: 'Expo' },
  { value: 'natural', label: 'Natural' },
  { value: 'slowDown', label: 'Slow Down' },
  { value: 'elastic', label: 'Elastic' },
  { value: 'overshoot', label: 'Overshoot' },
  { value: 'impulse', label: 'Impulse' },
  { value: 'swing', label: 'Swing' },
  { value: 'aeIn', label: 'AE In' },
  { value: 'aeSmooth', label: 'AE Smooth' },
  { value: 'aeOut', label: 'AE Out' },
];
export const WEIGHT_OPTIONS = [
  { value: 400, label: 'Regular' },
  { value: 600, label: 'Semibold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extra Bold' },
  { value: 900, label: 'Black' },
];

// Set a canvas font shorthand.
export function setFont(ctx, weight, sizePx, family) {
  ctx.font = `${weight || 800} ${Math.max(1, sizePx)}px ${family || 'Inter, sans-serif'}`;
}

// Per-word entrance animations shared by the typography templates (mirrors the
// MotionFast template1/5 animation set). Used with the `select-multi` field.
export const ANIMATION_OPTIONS = [
  { value: 'zoomOut', label: 'Zoom Out' },
  { value: 'zoomIn', label: 'Zoom In' },
  { value: 'rotate', label: 'Spin' },
  { value: 'elastic', label: 'Elastic Pop' },
  { value: 'slideLeft', label: 'Slide Left' },
  { value: 'slideRight', label: 'Slide Right' },
  { value: 'slideUp', label: 'Slide Up' },
  { value: 'slideDown', label: 'Slide Down' },
  { value: 'flip', label: '3D Flip' },
  { value: 'reveal', label: 'Clip Down' },
  { value: 'revealUp', label: 'Clip Up' },
  { value: 'revealLeft', label: 'Clip Left' },
  { value: 'revealRight', label: 'Clip Right' },
  { value: 'riseSettle', label: 'Rise & Settle' },
  { value: 'dropBounce', label: 'Drop Bounce' },
  { value: 'blurIn', label: 'Blur In' },
  { value: 'tiltIn', label: 'Tilt In' },
  { value: 'swing', label: 'Swing' },
  { value: 'skewSlide', label: 'Skew Slide' },
  { value: 'flipX', label: 'Flip Horizontal' },
  { value: 'rollIn', label: 'Roll In' },
  { value: 'stamp', label: 'Stamp' },
  { value: 'letters', label: 'Letters' },
  { value: 'shake', label: 'Shake Settle' },
];

// Normalize a selectedAnimations value (array or legacy single string) to a
// non-empty list; pick per-word by index so multiple selections vary the words.
export function animList(value, fallback = 'zoomOut') {
  if (Array.isArray(value) && value.length) return value;
  if (typeof value === 'string' && value) return [value];
  return [fallback];
}

// A gentle damped spring: one soft overshoot of `amp` (0.12 = 12 %) with `freq` swings over
// the entrance — the Title Push pop and swing use it instead of elasticOut's +37 % snap.
export function gentleElastic(t, amp = 0.12, freq = 1.1) {
  t = clamp01(t);
  if (t >= 1) return 1;
  const k = -2 * freq * Math.log(Math.max(1e-4, amp));
  return 1 - Math.exp(-k * t) * Math.cos(2 * Math.PI * freq * t) * (1 - t * t * t);
}

// Draw one word with an entrance animation. Assumes the ctx origin is already at
// the word's centre and fillStyle/font/textAlign(center)/textBaseline(middle) set.
// `p` is raw 0..1 progress; the appropriate ease is chosen per animation.
// `tune` retunes a few entrances per template — a number is the Zoom Out start scale (5×
// is the original MotionFast look), or an object (Title Push, settled in
// html/title-push-entrance-lab.html):
//   { zoomFrom: 2.2, spinDeg: 15, slideTilt: 10, pop: { overshoot: 0.12, swings: 1.1, from: 0.6 }, seed }
// spinDeg also sets the Tilt In lean and the Swing amplitude; without it Spin is the
// original half turn and Elastic Pop the original elasticOut.
export function drawAnimatedWord(ctx, text, anim, p, fs, baseEase = easeOutCubic, tune = 5) {
  p = clamp01(p);
  const T = typeof tune === 'object' && tune ? tune : {};
  const zoomFrom = typeof tune === 'number' ? tune : (Number(T.zoomFrom) || 5);
  const spinDeg = Number.isFinite(Number(T.spinDeg)) ? Number(T.spinDeg) : null;
  const spin = ((spinDeg == null ? 15 : spinDeg) * Math.PI) / 180;
  const tilt = ((Number.isFinite(Number(T.slideTilt)) ? Number(T.slideTilt) : 9.74) * Math.PI) / 180;
  const pop = T.pop || null;
  const seed = Number(T.seed) || 0;
  const isSlide = typeof anim === 'string' && anim.indexOf('slide') === 0;
  const ease = anim === 'elastic' && !pop ? elasticOut : isSlide ? backOut : baseEase;
  const e = ease(p);
  const slide = fs * 2.2;
  let dx = 0, dy = 0, sx = 1, sy = 1, rot = 0, clip = null, alpha = clamp01(e), blur = 0, skew = 0;
  let pivotX = 0, pivotY = 0;
  let letters = false;
  const wordW = ctx.measureText(text).width;
  switch (anim) {
    case 'zoomIn': sx = sy = lerp(0.01, 1, e); break;
    case 'rotate':
      if (spinDeg != null) { const s = backOut(p, 1.2); sx = sy = lerp(0.55, 1, s); rot = lerp(spin, 0, s); alpha = clamp01(p * 2.5); }
      else { sx = sy = lerp(0.01, 1, e); rot = lerp(Math.PI, 0, e); }
      break;
    case 'elastic':
      if (pop) { const s = gentleElastic(p, Number(pop.overshoot) || 0.12, Number(pop.swings) || 1.1); sx = sy = lerp(Number(pop.from) || 0.6, 1, s); dy = lerp(fs * 0.5, 0, s); alpha = clamp01(p * 3); }
      else { sx = sy = lerp(0.3, 1, e); dy = lerp(150, 0, e); }
      break;
    case 'slideLeft': dx = lerp(-slide, 0, e); rot = lerp(-tilt, 0, e); break;
    case 'slideRight': dx = lerp(slide, 0, e); rot = lerp(tilt, 0, e); break;
    case 'slideUp': dy = lerp(-slide, 0, e); break;
    case 'slideDown': dy = lerp(slide, 0, e); break;
    case 'flip': sy = lerp(0, 1, e); break; // 3D flip approximated as a vertical open
    case 'reveal': clip = 'down'; dy = lerp(fs * 0.4, 0, e); break;
    case 'revealUp': clip = 'up'; dy = lerp(-fs * 0.4, 0, e); break;
    case 'revealLeft': clip = 'left'; dx = lerp(-fs * 0.4, 0, e); break;
    case 'revealRight': clip = 'right'; dx = lerp(fs * 0.4, 0, e); break;
    case 'riseSettle': { const s = backOut(p, 1.9); dy = lerp(fs * 0.7, 0, s); alpha = clamp01(p * 2.2); break; }
    case 'dropBounce': { const s = bounceOut(p); dy = lerp(-fs * 1.4, 0, s); alpha = clamp01(p * 3); break; }
    case 'blurIn': { const s = easeOutCubic(p); blur = (1 - s) * fs * 0.22; sx = sy = lerp(1.12, 1, s); alpha = clamp01(p * 1.6); break; }
    case 'tiltIn': { const s = backOut(p, 1.4); rot = lerp(spin, 0, s); sx = sy = lerp(0.9, 1, s); pivotX = -wordW / 2; pivotY = fs * 0.45; alpha = clamp01(p * 2.5); break; }
    case 'swing': { const s = gentleElastic(p, 0.22, 0.9); rot = lerp(-spin * 1.6, 0, s); pivotY = -fs * 0.9; alpha = clamp01(p * 2.5); break; }
    case 'skewSlide': { const s = backOut(p, 1.2); dx = lerp(-slide * 0.7, 0, s); skew = lerp(0.55, 0, s); alpha = clamp01(p * 2); break; }
    case 'flipX': { const s = backOut(p, 1.1); sx = Math.max(0.02, lerp(0, 1, s)); skew = lerp(0.25, 0, s); alpha = clamp01(p * 3); break; }
    case 'rollIn': { const s = easeOutCubic(p); rot = lerp(-Math.PI / 2, 0, s); dx = lerp(-slide * 0.6, 0, s); sx = sy = lerp(0.6, 1, s); alpha = clamp01(p * 2); break; }
    case 'stamp': { const s = backOut(p, 2.2); sx = sy = lerp(1.6, 1, s); alpha = p < 0.12 ? 0 : 1; break; }
    case 'letters': letters = true; alpha = 1; break;
    case 'shake': {
      // a slow wobble: ~7 noise samples over the entrance, smoothly interpolated, dying out
      const k = p * 7, i = Math.floor(k), u = k - i, sm = u * u * (3 - 2 * u);
      const n = (off) => lerp(noise(seed * 7.1 + off + i) - 0.5, noise(seed * 7.1 + off + i + 1) - 0.5, sm);
      const d = Math.pow(1 - p, 1.8);
      dx = n(0) * fs * 0.55 * d; dy = n(100) * fs * 0.3 * d; rot = n(200) * 0.22 * d; alpha = clamp01(p * 3);
      break;
    }
    default: sx = sy = lerp(zoomFrom, 1, e); break; // zoomOut
  }
  ctx.save();
  ctx.globalAlpha *= clamp01(alpha);
  ctx.translate(dx, dy);
  ctx.translate(pivotX, pivotY); ctx.rotate(rot); ctx.translate(-pivotX, -pivotY);
  if (skew) ctx.transform(1, 0, -skew, 1, 0, 0);
  ctx.scale(sx, sy);
  if (blur > 0.3) ctx.filter = `blur(${blur.toFixed(1)}px)`;
  if (clip) {
    const w = wordW * 1.15 + fs * 0.5;
    const h = fs * 1.5;
    ctx.beginPath();
    if (clip === 'down') ctx.rect(-w / 2, -h / 2, w, h * e);
    else if (clip === 'up') ctx.rect(-w / 2, h / 2 - h * e, w, h * e);
    else if (clip === 'left') ctx.rect(-w / 2, -h / 2, w * e, h);
    else ctx.rect(w / 2 - w * e, -h / 2, w * e, h);
    ctx.clip();
  }
  if (letters) {
    // characters arrive one by one, each with a tiny rise + fade
    const chars = [...text];
    const widths = chars.map((c) => ctx.measureText(c).width);
    const total = widths.reduce((a, b) => a + b, 0);
    let x = -total / 2;
    ctx.textAlign = 'left';
    const n = chars.length;
    chars.forEach((c, i) => {
      const lp = clamp01((p * 1.6 - (i / n) * 0.6) / 0.6);
      const s = easeOutCubic(lp);
      ctx.save(); ctx.globalAlpha *= s; ctx.fillText(c, x, lerp(fs * 0.25, 0, s)); ctx.restore();
      x += widths[i];
    });
  } else {
    ctx.fillText(text, 0, 0);
  }
  ctx.restore();
}

// Cubic-bezier easing (CSS-style, x = time, y = progress) — used by ports of
// templates whose originals use cubic-bezier() impulses. It lives in the easing
// engine (one solver for templates, keyframes and flipbooks); re-exported here.
export { bezierEase };

// Piecewise-linear multi-keyframe interpolation: points ascending, values same length.
export function interpolateMulti(t, points, values) {
  if (t <= points[0]) return values[0];
  const last = points.length - 1;
  if (t >= points[last]) return values[last];
  let i = 1;
  while (points[i] < t) i++;
  const f = (t - points[i - 1]) / (points[i] - points[i - 1]);
  return lerp(values[i - 1], values[i], f);
}

// Offscreen scratch canvas (text measurement, pre-rendered strips/tiles). The one
// sanctioned way for a template to create a canvas — imported local templates may
// not touch `document`, and routing every canvas through here lets a future
// sandboxed runtime swap in OffscreenCanvas without changing template code.
export function createCanvas(width = 1, height = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

// ── Supersampled glyph sprite ─────────────────────────────────────────────────
// A 1:1 fillText leaves a ONE-pixel antialiasing ramp. Correct at actual size, but
// one pixel is all the gradation a curve gets, so big letterforms read as a
// staircase the moment they are viewed larger than 1:1 (preview zoom, camera
// push-in, 1080p on a large display). Composing the art at `ss`× the plate density
// into a buffer and bringing it down gives every output pixel ss² coverage samples.
//
// The come-down MUST happen in 2× steps. One bilinear pass over a >2× gap reads
// only 4 texels per output pixel and skips the rest — measured on Inter at 132px
// that LOWERS edge quality below plain fillText (0.76px mean ramp / 40% zero-ramp
// steps vs 1.06px / 21%). Each 2× step averages exactly its 4 texels, so the full
// sample field survives: 1.51px mean ramp / 9% zero-ramp steps at ss = 3.
export const GLYPH_RASTER_SS = 3;
// Chromium renders a canvas past its limits BLANK rather than throwing, so the
// factor is backed off until the buffer fits instead of being trusted.
const GLYPH_MAX_DIM = 16384;
const GLYPH_MAX_AREA = 150e6;

function glyphRasterScale(w, h, pixelScale, ss) {
  const density = Number(pixelScale) > 0 ? Number(pixelScale) : 1;
  // Sized in DEVICE pixels, so the edge looks the same at every raster density
  // rather than changing under a camera push-in.
  let k = (ss > 0 ? ss : GLYPH_RASTER_SS) * density;
  while (k > 1 && (w * k > GLYPH_MAX_DIM || h * k > GLYPH_MAX_DIM || w * k * h * k > GLYPH_MAX_AREA)) {
    k -= 0.5;
  }
  return Math.max(1, k);
}

// Grow-only scratch canvases: reallocating a multi-megapixel buffer every frame
// would cost more than the supersampling does.
function glyphScratch(cache, key, w, h) {
  let c = cache.get(key);
  if (!c || c.width < w || c.height < h) {
    c = createCanvas(Math.max(w, c ? c.width : 0), Math.max(h, c ? c.height : 0));
    cache.set(key, c);
  }
  return c;
}

// Rasterize `paint(g, k)` supersampled and return a sprite ready to composite.
// `bounds` {x, y, w, h} is the composition-space box the paint covers (include a
// margin for overshoots/side bearings); `cache` is any per-instance Map — the
// scratch buffers live under '#ss-*' keys. The callback receives a context whose
// transform already maps composition units to buffer pixels, so it paints at the
// SAME logical coordinates it would use on the plate. Font size, gradients and
// paths scale through the CTM; only DEVICE-pixel lengths (shadowBlur, filter blur)
// need multiplying by `k` inside the callback.
//
// Draw the result with drawGlyphSprite — possibly several times (glow/shadow
// passes over the sprite, clipped recolors). Sequential builds may share a cache;
// a sprite is only valid until the next buildGlyphSprite call on that cache.
export function buildGlyphSprite(cache, bounds, pixelScale, paint, ss) {
  const w = Math.max(1, bounds.w);
  const h = Math.max(1, bounds.h);
  const k = glyphRasterScale(w, h, pixelScale, ss);
  const wPx = Math.ceil(w * k);
  const hPx = Math.ceil(h * k);
  // +2px gutter: the come-down samples just past the used rect, and a grow-only
  // buffer may hold stale pixels there from an earlier, larger frame.
  const buf = glyphScratch(cache, '#ss-a', wPx + 2, hPx + 2);
  const g = buf.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, Math.min(buf.width, wPx + 2), Math.min(buf.height, hPx + 2));
  g.setTransform(k, 0, 0, k, -bounds.x * k, -bounds.y * k);
  paint(g, k);
  g.setTransform(1, 0, 0, 1, 0, 0);

  const density = Number(pixelScale) > 0 ? Number(pixelScale) : 1;
  let src = buf;
  let sw = wPx;
  let sh = hPx;
  let cur = k;
  let flip = false;
  while (cur / density > 2) {
    const nw = sw / 2;
    const nh = sh / 2;
    const next = glyphScratch(cache, flip ? '#ss-b' : '#ss-c', Math.ceil(nw) + 2, Math.ceil(nh) + 2);
    const ng = next.getContext('2d');
    ng.setTransform(1, 0, 0, 1, 0, 0);
    ng.clearRect(0, 0, Math.min(next.width, Math.ceil(nw) + 2), Math.min(next.height, Math.ceil(nh) + 2));
    ng.imageSmoothingEnabled = true;
    ng.imageSmoothingQuality = 'high';
    ng.drawImage(src, 0, 0, sw, sh, 0, 0, nw, nh);
    src = next; sw = nw; sh = nh; cur /= 2; flip = !flip;
  }
  // Destination derives from the buffer size, so the scale stays exactly `cur`
  // and the art cannot drift by the rounding of the source rect.
  return { canvas: src, sw, sh, x: bounds.x, y: bounds.y, w: sw / cur, h: sh / cur };
}

export function drawGlyphSprite(ctx, sprite) {
  if (!sprite) return;
  const se = ctx.imageSmoothingEnabled;
  const sq = ctx.imageSmoothingQuality;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sprite.canvas, 0, 0, sprite.sw, sprite.sh, sprite.x, sprite.y, sprite.w, sprite.h);
  ctx.imageSmoothingEnabled = se;
  ctx.imageSmoothingQuality = sq;
}

// Deterministic shared image cache for motion templates with image params.
// draw()/render() call getMotionImage(url) each frame and skip the card until
// `ready`; the Player preloads + repaints so preview AND export are deterministic.
//
// A media list may also hold VIDEOS. Those resolve through motionVideo.js against
// the clip's local time (looping), and the returned `img` is the decoder's canvas —
// a drawable, so every template already written against this entry shape keeps
// working unchanged. Unsupported containers come back `failed` (draw your plate).
const motionImageCache = new Map();
export function getMotionImage(url) {
  if (!url) return null;
  if (isMotionVideoUrl(url)) return getAmbientVideoEntry(url);
  let entry = motionImageCache.get(url);
  if (!entry) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    entry = { img, loaded: false, failed: false };
    entry.ready = new Promise((resolve) => {
      img.onload = () => { entry.loaded = true; resolve(entry); };
      img.onerror = () => { entry.failed = true; resolve(entry); };
    });
    img.src = url;
    motionImageCache.set(url, entry);
  }
  return entry;
}

// Media entry for a URL that may be an image OR a video, with explicit control over
// the video's source time and decoder lane — use it when a slot needs its own
// playhead (e.g. a card that starts its clip when it enters). `frameAt(t)` returns a
// drawable (image or decoded video frame) or null while it isn't ready yet.
//   const m = getMotionMedia(url, { lane: `card${i}` });
//   const src = m && m.frameAt(cardLocalTime);
//   if (src) drawImageInBox(ctx, src, x, y, w, h, 'cover', 1);
export function getMotionMedia(url, opts = {}) {
  if (!url) return null;
  if (!isMotionVideoUrl(url)) {
    const entry = getMotionImage(url);
    if (!entry) return null;
    return {
      kind: 'image',
      loaded: entry.loaded,
      failed: entry.failed,
      ready: entry.ready,
      duration: 0,
      width: entry.loaded ? entry.img.naturalWidth : 0,
      height: entry.loaded ? entry.img.naturalHeight : 0,
      frameAt: () => (entry.loaded ? entry.img : null),
    };
  }
  const source = getMotionVideoSource(url);
  const lane = `${opts.lane || 'default'}::${url}`;
  const loop = opts.loop !== false;
  return {
    kind: 'video',
    loaded: source.loaded,
    failed: source.failed,
    ready: source.ready,
    duration: source.duration,
    width: source.width,
    height: source.height,
    frameAt(timeSec) {
      const t = Math.max(0, Number(timeSec) || 0);
      const d = source.duration || 0;
      return requestVideoFrame(url, loop && d > 0 ? t % d : t, lane);
    },
  };
}
