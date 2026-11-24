// Card Corridor (MotionFast `card-corridor`): two mirrored rows of overlapping picture cards fan out from the frame's
// centre seam, each further card bigger than the last (bigger cards paint on top, so each inner card shows a sliver
// toward the seam: the corridor), while the camera pulls back (or pushes in, or holds at mid zoom) with an optional roll,
// sway and pan drift; the cards pop in seam-outward (or edge-inward) behind a matte growing from their centre (or a wipe,
// zoom, flip, fade, push, slide, drop, rise or cut), hold, then clear the same way (cut by default).
//
// Built from ordinary layers. A Corridor null is the camera's roll, sway and pan drift about the band's centre; under it
// one Row null per side holds the row origin's distance from the seam (its X) and the camera's zoom (its Scale); under
// each row one picture layer per card, whose place along the row and size are constants and whose appear / disappear
// are keys: the mask's width and height (matte, wipes), Scale, Scale X (flip), opacity, an offset (slide, drop, rise,
// push). Every eased stretch is the app's same curve; a stretch the layer shows only part of plays a slice of that easing
// (exact). Where two motions meet on one property (an appear still running when the disappear starts, a push whose
// travel follows the camera, Expo) the keys are fitted pieces within a few hundredths of a pixel. A card's corners, when
// rounded, keep MotionFast's radius in frame pixels through the camera's zoom: its mask outline is keyed then. Channel
// order is MotionFast's draw order: card by card from the seam out, left then right.
//
// A built-in script (PLANS/ESSENTIAL_TEMPLATES.md §14): it imports nothing, so this same text also runs as a
// `kind: "script"` source. Numbers and timing are MotionFast's (motionTemplates/cardCorridor.js).
const REF_H = 1350;
const PLATES = ['#c8b6f2', '#f0b41e', '#efe8d8', '#e0567a', '#22c3c3', '#d9d9d9', '#5b3fd6', '#8fd0ff', '#0f7f7f', '#1d4ed8'];
// the Lottie's geometry, 10 cards per side (resampled by index for other counts): a card centre's offset from the row
// origin at row scale 1 (the two nearest sit inside the origin), and the card's own scale
const LX = [-73, -7, 89, 254, 453, 663, 878, 1104, 1361, 1687];
const LS = [0.5, 0.8, 1.2, 2, 3, 4, 5, 6, 7, 8];
const CARD_W = 258;
const ORIGIN_FROM = 290, ORIGIN_TO = 90;
const POP_IN = [0, 0.2795, 0.5090, 0.6667, 0.7603, 0.8322, 0.8829, 0.9297, 0.9688, 1];
const POP_OUT = [0, 0.1964, 0.3750, 0.5179, 0.6429, 0.7500, 0.8393, 0.9107, 0.9643, 1];
// the camera's keyframe easings (the Lottie's), and MotionFast's 'smooth'
const BZ_ZOOM_A = [0.861, 0, 0.674, 0.713], BZ_ZOOM_B = [0.888, 0, 0.5, 1], BZ_ORIGIN = [0.788, 0, 0.375, 1], BZ_SMOOTH = [0.5, 0, 0, 1];
const STYLES = ['matte', 'wipeH', 'wipeV', 'scale', 'flip', 'fade', 'push', 'slide', 'drop', 'rise'];

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const r6 = (v) => { const x = Math.round(v * 1e6) / 1e6; return Object.is(x, -0) ? 0 : x; };
const n = (v) => { const x = Number(v); return Math.abs(x) < 1e-12 ? '0' : String(Number(x.toPrecision(10))); };
const seg = (t, t0, t1) => (t1 <= t0 ? (t >= t1 ? 1 : 0) : clamp01((t - t0) / (t1 - t0)));
function tab(arr, u) {
  const m = arr.length - 1, x = clamp01(u) * m, i = Math.min(m - 1, Math.floor(x));
  return lerp(arr[i], arr[i + 1], x - i);
}

// ── easings ────────────────────────────────────────────────────────────────────────────────────────────────────────
// MotionFast's bezier solver (easingEngine.bezierEase, which the editor's keys use too: the same numbers), and the same
// curve solved to the end (what a fit follows: the solver's 1e-4 jitter is not chased)
function bezierMF(p1x, p1y, p2x, p2y) {
  const bx = (t) => 3 * p1x * t * (1 - t) * (1 - t) + 3 * p2x * t * t * (1 - t) + t * t * t;
  const by = (t) => 3 * p1y * t * (1 - t) * (1 - t) + 3 * p2y * t * t * (1 - t) + t * t * t;
  return (x) => {
    x = clamp01(x);
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 24; i += 1) { const cx = bx(t); if (Math.abs(cx - x) < 1e-4) break; if (cx < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return by(t);
  };
}
function bezierExact(p1x, p1y, p2x, p2y) {
  const bx = (t) => 3 * p1x * t * (1 - t) * (1 - t) + 3 * p2x * t * t * (1 - t) + t * t * t;
  const by = (t) => 3 * p1y * t * (1 - t) * (1 - t) + 3 * p2y * t * t * (1 - t) + t * t * t;
  return (x) => { x = clamp01(x); let lo = 0, hi = 1; for (let i = 0; i < 52; i += 1) { const m = (lo + hi) / 2; if (bx(m) < x) lo = m; else hi = m; } return by((lo + hi) / 2); };
}
const TABLE = (s) => s.split(',').map(Number);
const T_ELASTIC = TABLE('0,.0221,.0739,.1485,.2394,.3402,.4458,.5517,.6541,.7502,.8375,.9149,.9813,1.0364,1.0803,1.1136,1.1369,1.1513,1.1579,1.1578,1.1522,1.1424,1.1294,1.1142,1.0978,1.081,1.0643,1.0485,1.0338,1.0205,1.009,.9992,.9912,.9849,.9803,.9772,.9754,.9748,.9752,.9764,.9782,.9804,.9829,.9856,.9882,.9908,.9933,.9955,.9975,.9992,1.0007,1.0018,1.0027,1.0034,1.0038,1.004,1.004,1.0039,1.0036,1.0033,1.0029,1.0025,1.0021,1.0017,1.0013,1.0009,1.0006,1.0003,1,.9998,.9996,.9995,.9994,.9994,.9994,.9994,.9994,.9994,.9995,.9996,.9996,.9997,.9998,.9998,.9999,.9999,1,1,1,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1');
const T_OVERSHOOT = TABLE('0,.1739,.3067,.4183,.515,.6,.6755,.743,.8034,.8576,.9063,.95,.9891,1.0241,1.0551,1.0825,1.1066,1.1275,1.1455,1.1606,1.1731,1.183,1.1906,1.1959,1.199,1.2,1.1997,1.1988,1.1972,1.195,1.1921,1.1886,1.1846,1.18,1.1749,1.1695,1.1638,1.1579,1.1519,1.1458,1.1397,1.1337,1.1277,1.1219,1.1162,1.1107,1.1053,1.1002,1.0952,1.0904,1.0857,1.0813,1.077,1.0729,1.0689,1.0651,1.0615,1.058,1.0547,1.0515,1.0484,1.0455,1.0427,1.0401,1.0375,1.0351,1.0327,1.0305,1.0284,1.0264,1.0244,1.0226,1.0209,1.0192,1.0176,1.0162,1.0148,1.0134,1.0122,1.011,1.0099,1.0088,1.0079,1.007,1.0061,1.0053,1.0046,1.0039,1.0033,1.0028,1.0023,1.0018,1.0014,1.0011,1.0008,1.0005,1.0003,1.0002,1.0001,1,1');
const T_IMPULSE = TABLE('0,-.0006,-.0023,-.005,-.0086,-.0131,-.0183,-.0243,-.0308,-.038,-.0456,-.0537,-.0622,-.071,-.0801,-.0894,-.0988,-.1084,-.1179,-.1275,-.1369,-.1461,-.1551,-.1636,-.1717,-.1791,-.1858,-.1915,-.1959,-.1989,-.2,-.1986,-.1944,-.187,-.1762,-.1616,-.1432,-.1206,-.0939,-.0632,-.0289,.0087,.0487,.0906,.1334,.1765,.2193,.2613,.3022,.3416,.3794,.4156,.4501,.483,.5142,.5438,.5719,.5986,.6239,.6478,.6705,.692,.7124,.7317,.75,.7673,.7837,.7993,.814,.8279,.841,.8535,.8652,.8763,.8868,.8967,.9059,.9147,.9229,.9305,.9377,.9444,.9507,.9565,.9619,.9669,.9714,.9756,.9794,.9829,.986,.9888,.9912,.9933,.9952,.9967,.9979,.9988,.9995,.9999,1');
const T_SWING = TABLE('0,-.0013,-.0052,-.0115,-.0199,-.0302,-.0421,-.0554,-.0697,-.0847,-.1,-.1153,-.1303,-.1446,-.1579,-.1698,-.1801,-.1885,-.1948,-.1987,-.2,-.1986,-.1942,-.1863,-.1744,-.1578,-.136,-.1079,-.0725,-.0288,.0241,.087,.1594,.2396,.3241,.4088,.4899,.5651,.6332,.6941,.7482,.796,.8384,.8758,.9088,.9379,.9636,.9863,1.0061,1.0235,1.0386,1.0517,1.0628,1.0723,1.0801,1.0865,1.0916,1.0954,1.098,1.0995,1.1,1.0997,1.0987,1.097,1.0947,1.0919,1.0885,1.0847,1.0806,1.0762,1.0717,1.0671,1.0624,1.0578,1.0533,1.0489,1.0447,1.0406,1.0368,1.0332,1.0297,1.0265,1.0235,1.0207,1.0181,1.0157,1.0135,1.0115,1.0097,1.008,1.0065,1.0052,1.0041,1.0031,1.0022,1.0015,1.001,1.0005,1.0002,1.0001,1');
const tableEase = (tb) => (t) => { t = clamp01(t); const i = t * (tb.length - 1), lo = Math.floor(i), hi = Math.min(tb.length - 1, lo + 1); return tb[lo] + (tb[hi] - tb[lo]) * (i - lo); };
const powOut = (p) => (t) => 1 - Math.pow(1 - clamp01(t), p);
function bounceOut(t) {
  t = clamp01(t);
  const n1 = 7.5625, d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
  if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
  t -= 2.625 / d1;
  return n1 * t * t + 0.984375;
}
// an easing: f = MotionFast's curve (the editor's key draws the same numbers), g = the same solved exactly (fits),
// key = the editor's key easing for it (null: none, keyed by fitted pieces), table = straight between its 101 points
const bz = (b, key) => ({ f: bezierMF(...b), g: bezierExact(...b), key: key || { easing: 'Custom', bezier: b }, b });
const fnEase = (fn, key) => ({ f: fn, g: fn, key });
const tbEase = (tb, key) => ({ f: tableEase(tb), g: tableEase(tb), key, table: tb.length - 1 });
const EASES = {
  smooth: bz(BZ_SMOOTH),
  power2: fnEase(powOut(3), { easing: 'Ease Out' }),
  power3: fnEase(powOut(4), { easing: 'Cubic Out' }),
  power4: fnEase(powOut(5), { easing: 'Power' }),
  back: fnEase((t) => { t = clamp01(t); return 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2); }, { easing: 'Back Out' }),
  bounce: fnEase(bounceOut, { easing: 'Bounce Out' }),
  expo: fnEase((t) => { t = clamp01(t); return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); }, null),
  natural: bz([0.8, 0, 0.2, 1], { easing: 'Natural' }),
  slowDown: bz([0, 0, 0, 1], { easing: 'Slow Down' }),
  elastic: tbEase(T_ELASTIC, null),
  overshoot: tbEase(T_OVERSHOOT, { easing: 'Overshoot' }),
  impulse: tbEase(T_IMPULSE, { easing: 'Impulse' }),
  swing: tbEase(T_SWING, { easing: 'Swing' }),
  aeIn: bz([0.3141666673, 0, 0.0875000209, 1], { easing: 'AE In (arrive)' }),
  aeSmooth: bz([0.8820833270, 0, 0.2445833683, 1], { easing: 'AE Smooth' }),
  aeOut: bz([0.8699999754, 0, 0.6433336333, 1], { easing: 'AE Out (leave)' }),
};
const easeOf = (name) => EASES[name] || EASES.smooth;
// a bezier run backwards in time: B'(s) = 1 − B(1 − s) is the bezier with its handles turned about the centre
const reversed = (b) => [1 - b[2], 1 - b[3], 1 - b[0], 1 - b[1]];
const EASE_OPTIONS = [['smooth', 'Smooth'], ['power2', 'Power 2'], ['power3', 'Power 3'], ['power4', 'Power 4'], ['back', 'Back'],
  ['bounce', 'Bounce'], ['expo', 'Expo'], ['natural', 'Natural'], ['slowDown', 'Slow Down'], ['elastic', 'Elastic'],
  ['overshoot', 'Overshoot'], ['impulse', 'Impulse'], ['swing', 'Swing'], ['aeIn', 'AE In'], ['aeSmooth', 'AE Smooth'], ['aeOut', 'AE Out']]
  .map(([value, label]) => ({ value, label }));

const fields = [
  { type: 'group', key: 'gMedia', label: 'Media' },
  { key: 'media', type: 'media', label: 'Images / videos', slots: { from: 'media', max: 64 }, accept: 'media', ifFewer: 'reuse' },
  { key: 'sides', type: 'select', label: 'Sides', default: 'mirror', options: [
    { value: 'mirror', label: 'Same image on both sides' }, { value: 'alternate', label: 'Alternate left / right' },
  ] },
  { key: 'fillEmpty', type: 'switch', label: 'Repeat media to fill the corridor', default: false },
  { key: 'cardCount', type: 'range', label: 'Cards per side', default: 10, min: 1, max: 20, step: 1, integer: true, showIf: { key: 'fillEmpty', truthy: true } },
  { type: 'group', key: 'gCards', label: 'Cards' },
  { key: 'cardSize', type: 'range', label: 'Card size', default: 100, min: 30, max: 250, step: 1, suffix: '%' },
  { key: 'cardAspect', type: 'range', label: 'Card aspect', default: 0.796, min: 0.4, max: 2, step: 0.01 },
  { key: 'cardRadius', type: 'range', label: 'Corner radius', default: 0, min: 0, max: 80, step: 1 },
  { key: 'spread', type: 'range', label: 'Spread', default: 100, min: 40, max: 250, step: 1, suffix: '%' },
  { key: 'seamGap', type: 'range', label: 'Seam gap', default: 0, min: -100, max: 800, step: 1, suffix: 'px' },
  { key: 'growth', type: 'range', label: 'Size growth', default: 100, min: 0, max: 200, step: 1, suffix: '%' },
  { key: 'bandOffset', type: 'range', label: 'Vertical offset', default: 0, min: -40, max: 40, step: 1, suffix: '%' },
  { type: 'group', key: 'gCamera', label: 'Camera' },
  { key: 'camera', type: 'select', label: 'Move', default: 'pullBack', options: [
    { value: 'pullBack', label: 'Pull back — close → far (Lottie)' }, { value: 'pushIn', label: 'Push in — far → close' },
    { value: 'static', label: 'Static at mid zoom' },
  ] },
  { key: 'zoomFrom', type: 'range', label: 'Close zoom', default: 200, min: 30, max: 400, step: 1, suffix: '%' },
  { key: 'zoomMid', type: 'range', label: 'Mid zoom', default: 65.76, min: 10, max: 300, step: 0.5, suffix: '%' },
  { key: 'zoomTo', type: 'range', label: 'Far zoom', default: 30, min: 5, max: 200, step: 1, suffix: '%' },
  { key: 'cameraRoll', type: 'range', label: 'Roll', default: 0, min: -180, max: 180, step: 1, suffix: '°' },
  { key: 'cameraSway', type: 'range', label: 'Sway', default: 0, min: 0, max: 30, step: 0.5, suffix: '°' },
  { key: 'swayPeriod', type: 'range', label: 'Sway period', default: 3, min: 0.5, max: 10, step: 0.1, suffix: 's', showIf: { key: 'cameraSway', truthy: true } },
  { key: 'cameraPan', type: 'range', label: 'Pan drift', default: 0, min: -1500, max: 1500, step: 10 },
  { type: 'group', key: 'gBuild', label: 'Build (appear)' },
  { key: 'buildOrder', type: 'select', label: 'Order', default: 'seamFirst', options: [
    { value: 'seamFirst', label: 'Far first — seam outward (Lottie)' }, { value: 'edgeFirst', label: 'Near first — edges inward' },
  ] },
  { key: 'revealStyle', type: 'select', label: 'Style', default: 'matte', options: [
    { value: 'matte', label: 'Matte' }, { value: 'wipeH', label: 'Wipe ↔' }, { value: 'wipeV', label: 'Wipe ↕' }, { value: 'scale', label: 'Zoom' },
    { value: 'flip', label: 'Flip' }, { value: 'fade', label: 'Fade' }, { value: 'push', label: 'Push' }, { value: 'slide', label: 'Slide' },
    { value: 'drop', label: 'Drop' }, { value: 'rise', label: 'Rise' }, { value: 'cut', label: 'Cut' },
  ] },
  { key: 'revealLead', type: 'range', label: 'Lead', default: 0.4, min: 0, max: 1.5, step: 0.05, suffix: 's', showIf: { key: 'revealStyle', equals: 'matte' } },
  { key: 'revealTime', type: 'range', label: 'Duration', default: 1, min: 0.1, max: 3, step: 0.05, suffix: 's', showIf: { key: 'revealStyle', notEquals: 'cut' } },
  { key: 'revealEase', type: 'select', label: 'Easing', default: 'smooth', options: EASE_OPTIONS, showIf: { key: 'revealStyle', notEquals: 'cut' } },
  { type: 'group', key: 'gClear', label: 'Clear (disappear)' },
  { key: 'clearOrder', type: 'select', label: 'Order', default: 'seamFirst', options: [
    { value: 'seamFirst', label: 'Far first — seam outward (Lottie)' }, { value: 'edgeFirst', label: 'Near first — edges inward' },
  ] },
  { key: 'clearStyle', type: 'select', label: 'Style', default: 'cut', options: [
    { value: 'cut', label: 'Cut' }, { value: 'matte', label: 'Matte' }, { value: 'wipeH', label: 'Wipe ↔' }, { value: 'wipeV', label: 'Wipe ↕' },
    { value: 'scale', label: 'Zoom' }, { value: 'flip', label: 'Flip' }, { value: 'fade', label: 'Fade' }, { value: 'push', label: 'Push' },
    { value: 'slide', label: 'Slide' }, { value: 'drop', label: 'Drop' }, { value: 'rise', label: 'Rise' }, { value: 'none', label: 'Stay' },
  ] },
  { key: 'clearDur', type: 'range', label: 'Duration', default: 0.3, min: 0.05, max: 2, step: 0.05, suffix: 's', showIf: { key: 'clearStyle', in: STYLES } },
  { key: 'clearEase', type: 'select', label: 'Easing', default: 'smooth', options: EASE_OPTIONS, showIf: { key: 'clearStyle', in: STYLES } },
  { type: 'group', key: 'gTiming', label: 'Timing' },
  { key: 'introTime', type: 'range', label: 'Intro', default: 0.2, min: 0, max: 4, step: 0.05, suffix: 's' },
  { key: 'buildTime', type: 'range', label: 'Build', default: 1.281, min: 0.2, max: 6, step: 0.05, suffix: 's' },
  { key: 'showHold', type: 'range', label: 'Hold', default: 0.12, min: 0, max: 4, step: 0.05, suffix: 's' },
  { key: 'clearTime', type: 'range', label: 'Clear', default: 0.56, min: 0.1, max: 4, step: 0.05, suffix: 's' },
  { key: 'outroTime', type: 'range', label: 'Outro', default: 0.2, min: 0.2, max: 6, step: 0.05, suffix: 's' },
];

// MotionFast's clip: the cards pop over [T0, Tb], hold, clear over [Tc, Td]; the camera's keys ride on the card span W
function timeline(S) {
  const T0 = Math.max(0, num(S.introTime, 0.2));
  const Tb = T0 + Math.max(0.05, num(S.buildTime, 1.281));
  const Tc = Tb + Math.max(0, num(S.showHold, 0.12));
  const Td = Tc + Math.max(0.05, num(S.clearTime, 0.56));
  const end = Td + Math.max(0.2, num(S.outroTime, 0.2));
  const W = Td - T0;
  return { T0, Tb, Tc, Td, end, W, tz0: T0 - 0.0673 * W, tz1: T0 + 0.5385 * W, tz2: Td + 0.2065 * W, tp1: T0 + 0.7619 * W };
}

// ── keys ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const LINEAR = { easing: 'Linear' };
// MotionFast's card state: one vocabulary for the appear and the disappear (cardCorridor.js shapeState)
function shapeState(st, style, v, phase) {
  v = Math.max(0, v);
  const r = 1 - v;
  switch (style) {
    case 'matte': st.mx *= v; st.my *= v; break;
    case 'wipeH': st.mx *= v; break;
    case 'wipeV': st.my *= v; break;
    case 'scale': st.k *= v; break;
    case 'flip': st.fx *= v; break;
    case 'fade': st.alpha *= v; break;
    case 'slide': st.dx += r; st.alpha *= v; break;
    case 'push': if (phase === 'in') st.pin = r; else st.pout = r; break;
    case 'drop': st.dy += phase === 'in' ? -r : r; st.alpha *= v; break;
    case 'rise': st.dy += phase === 'in' ? r : -r; st.alpha *= v; break;
    default: break;
  }
}
// the Custom bezier through f at a, a + ⅓, a + ⅔, b (x handles at ⅓, ⅔: the bezier IS that cubic in time), split while it
// misses f by more than tol
function fitPieces(f, a, b, tol, out, depth = 0) {
  const y0 = f(a), y1 = f(a + (b - a) / 3), y2 = f(a + (2 * (b - a)) / 3), y3 = f(b), d = y3 - y0;
  let ez = null;
  if (Math.abs(d) > 1e-12 * Math.max(1, Math.abs(y0))) {
    const b1 = (18 * y1 - 9 * y2 - 5 * y0 + 2 * y3) / 6, b2 = (18 * y2 - 9 * y1 - 5 * y3 + 2 * y0) / 6;
    const p1 = (b1 - y0) / d, p2 = (b2 - y0) / d;
    if (p1 >= -3 && p1 <= 4 && p2 >= -3 && p2 <= 4) ez = { easing: 'Custom', bezier: [1 / 3, Number(p1.toPrecision(10)), 2 / 3, Number(p2.toPrecision(10))] };
  }
  const curve = ez ? bezierMF(...ez.bezier) : (q) => q;
  let worst = 0;
  for (const q of [0.1, 0.22, 0.4, 0.5, 0.6, 0.78, 0.9]) worst = Math.max(worst, Math.abs(f(a + (b - a) * q) - (y0 + d * curve(q))));
  if (worst <= tol || depth >= 10 || b - a < 1e-3) { out.push([a, ez || LINEAR]); return; }
  const m = (a + b) / 2;
  fitPieces(f, a, m, tol, out, depth + 1);
  fitPieces(f, m, b, tol, out, depth + 1);
}
// A track over [A, B] from its value f(t) (MotionFast's numbers) and g(t) (the same with every curve solved exactly):
// cut at the phase ends and the extra moments; a stretch where one phase moves the value along its easing is one key
// with that easing (a slice of it when the stretch is part of the phase), a stretch where nothing moves it holds, the
// rest is fitted pieces. Values that jump (a phase's end) get a key either side. → [{ t, value, ease }]
const JUMP = 2e-6;
function trackKeys({ f, g, phases = [], extra = [], A, B, tol }) {
  const fl = (t) => f(t - 1e-9);
  const cuts = [A, B, ...phases.flatMap((p) => [p.t0, p.t1]), ...extra].filter((t) => t >= A - 1e-12 && t <= B + 1e-12);
  const xs = [...new Set(cuts.map((t) => Math.round(t * 1e9) / 1e9))].sort((x, y) => x - y).filter((t, i, a) => i === 0 || t - a[i - 1] > 4 * JUMP);
  if (xs[xs.length - 1] < B - 4 * JUMP) xs.push(B); else xs[xs.length - 1] = B;
  const out = [];
  const near = (x, y, e) => Math.abs(x - y) <= e;
  for (let j = 0; j + 1 < xs.length; j += 1) {
    const a = xs[j];
    let b = xs[j + 1];
    const jump = j + 2 < xs.length && !near(fl(b), f(b), tol * 0.5);
    const bEnd = jump ? b - JUMP : b;
    const fa = f(a), fb = fl(bEnd);
    const mid = (a + bEnd) / 2;
    const live = phases.filter((p) => p.t1 - p.t0 > 1e-9 && p.t0 < mid && mid < p.t1);
    const probe = [0.13, 0.31, 0.5, 0.69, 0.87].map((q) => a + q * (bEnd - a));
    const flat = probe.every((t) => near(f(t), fa, tol * 0.05)) && near(fb, fa, tol * 0.05);
    let spec = null;
    if (flat) spec = LINEAR;
    else if (live.length === 1 && live[0].ease.key !== undefined) {
      const p = live[0], E = p.ease.f;
      const sa = clamp01((a - p.t0) / (p.t1 - p.t0)), sb = clamp01((bEnd - p.t0) / (p.t1 - p.t0));
      const Ea = E(sa), Eb = E(sb);
      if (Math.abs(Eb - Ea) > 1e-9) {
        const rel = Math.max(1e-9, Math.abs(fb - fa) * 2e-3);
        const fits = probe.every((t) => {
          const s = sa + ((t - a) / (bEnd - a)) * (sb - sa);
          return near(f(t), fa + ((fb - fa) * (E(s) - Ea)) / (Eb - Ea), rel);
        });
        if (fits && p.ease.table && !p.ease.key) spec = LINEAR;            // between two of the table's points: straight
        else if (fits && p.ease.key) {
          const k = p.ease.key;
          const whole = sa < 1e-12 && sb > 1 - 1e-12;
          spec = whole ? k : { ...k, easeSlice: { of: k.easing, from: Number(sa.toPrecision(12)), to: Number(sb.toPrecision(12)), ...(k.bezier ? { bezier: k.bezier } : {}) } };
        }
      }
    }
    if (spec) out.push({ t: a, value: fa, ease: spec });
    else {
      const got = [];
      fitPieces((t) => g(Math.min(t, bEnd - 1e-9)), a, bEnd, tol, got);
      got.forEach(([t, ez]) => out.push({ t, value: f(t), ease: ez }));
    }
    if (jump) out.push({ t: bEnd, value: fb, ease: LINEAR });
  }
  out.push({ t: B, value: fl(B), ease: LINEAR });
  // drop keys that change nothing (a straight key between two equal ones)
  const same = (x, y) => Math.abs(x - y) <= 1e-10 * Math.max(1, Math.abs(x));
  return out.filter((k, i) => i === 0 || i === out.length - 1 || !(same(out[i - 1].value, k.value) && same(k.value, out[i + 1].value) && out[i - 1].ease === LINEAR && k.ease === LINEAR));
}
// the moments an easing crosses 0 or 1 inside a phase (MotionFast clamps there: max(0, v), clamp01(alpha)), and an
// easing with no key curve but a table: its 101 points
function easeCuts(ease, t0, t1, outPhase, levels = [0, 1], nodes = true) {
  const out = [];
  const v = (s) => (outPhase ? 1 - ease.f(s) : ease.f(s));
  for (const level of levels) {
    let prev = v(0) - level;
    for (let i = 1; i <= 400; i += 1) {
      const cur = v(i / 400) - level;
      if ((prev < 0 && cur > 0) || (prev > 0 && cur < 0)) {
        let lo = (i - 1) / 400, hi = i / 400;
        for (let k = 0; k < 50; k += 1) { const m = (lo + hi) / 2; if ((v(m) - level < 0) === (v(lo) - level < 0)) lo = m; else hi = m; }
        out.push(t0 + ((lo + hi) / 2) * (t1 - t0));
      }
      prev = cur;
    }
  }
  if (nodes && ease.table && !ease.key) for (let j = 1; j < ease.table; j += 1) out.push(t0 + (j / ease.table) * (t1 - t0));
  return out;
}
// eight points of a rounded rectangle in the mask's unit box (−0.5 … 0.5), corners rx / ry as shares of its sides
function roundRect8(rx, ry) {
  const K = 0.5522847498307936, kx = K * rx, ky = K * ry;
  const q = (v) => Math.round(v * 1e6) / 1e6;
  const P = (x, y, hi, ho) => ({ x: q(x), y: q(y), hIn: { x: q(hi[0]), y: q(hi[1]) }, hOut: { x: q(ho[0]), y: q(ho[1]) }, manual: true });
  return [
    P(-0.5 + rx, -0.5, [-kx, 0], [0, 0]), P(0.5 - rx, -0.5, [0, 0], [kx, 0]),
    P(0.5, -0.5 + ry, [0, -ky], [0, 0]), P(0.5, 0.5 - ry, [0, 0], [0, ky]),
    P(0.5 - rx, 0.5, [kx, 0], [0, 0]), P(-0.5 + rx, 0.5, [0, 0], [-kx, 0]),
    P(-0.5, 0.5 - ry, [0, ky], [0, 0]), P(-0.5, -0.5 + ry, [0, 0], [0, -ky]),
  ];
}
const RECT4 = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) => ({ x, y, hIn: { x: 0, y: 0 }, hOut: { x: 0, y: 0 }, manual: true }));
// the editor keeps each track's keys inside its range: keys hold (value + add) / k and a ƒx gives the value back
const RANGES = { xPercent: [-200, 200], yPercent: [-200, 200], translateX: [-1200, 1200], translateY: [-1200, 1200], rotate: [-1000, 1000], scale: [0.1, 20], scaleX: [0.1, 20],
  scaleY: [0.1, 20], opacity: [0, 1], 'msk:m1:w': [2, 400], 'msk:m1:h': [2, 400], 'msk:m2:x': [-300, 300] };
function storeTrack(prop, keys, fs, span, more = '') {
  const [lo, hi] = RANGES[prop];
  const vals = keys.map((k) => k.value);
  const vmin = Math.min(...vals), vmax = Math.max(...vals);
  let add = 0, k = 1;
  if (lo < 0) k = Math.max(1, Math.ceil(Math.max(Math.abs(vmin), Math.abs(vmax)) / (hi * 0.98)));
  else {
    if (vmin < lo) add = Math.ceil(lo - vmin);
    for (let i = 0; i < 8 && (vmax + add) / k > hi; i += 1) { k = Math.ceil((vmax + add) / (hi * 0.98)); if ((vmin + add) / k < lo) add = Math.ceil(lo * k - vmin); }
  }
  const pos = (t) => r6(clamp(((t - fs) / span) * 100, 0, 100));
  const stored = keys.map((key) => ({ position: pos(key.t), value: n((key.value + add) / k), ...key.ease }))
    .filter((key, i, a) => i === 0 || key.position > a[i - 1].position);
  const base = k === 1 ? (add ? `value-${add}` : 'value') : (add ? `value*${k}-${add}` : `value*${k}`);
  const code = more ? `${base}${more}` : base;
  const list = stored.length > 1 && stored.every((key) => key.value === stored[0].value) ? [{ position: 0, value: stored[0].value, easing: 'Linear' }] : stored;
  return { keys: list, fx: code === 'value' ? null : { type: 'custom', params: { code } } };
}

export default {
  id: 'card-corridor',
  name: 'Card Corridor',
  category: 'Carousels',
  v: 1,
  fields,
  build({ settings: S, media, frame }) {
    const { W, H } = frame;
    const tl = timeline(S);
    const D = Math.max(1, tl.end);
    const Sc = H / REF_H;
    const M = media.length;
    const alternate = S.sides === 'alternate';
    const fill = S.fillEmpty === true || S.fillEmpty === 'true';
    const perMedia = alternate ? Math.ceil(M / 2) : M;
    const N = !M ? 10 : fill ? Math.max(1, Math.round(num(S.cardCount, 10))) : perMedia;
    const spread = num(S.spread, 100) / 100, growth = num(S.growth, 100) / 100;
    const gap = num(S.seamGap, 0) * Sc;
    const sizeF = (CARD_W * num(S.cardSize, 100)) / 100 * Sc;
    const aspect = Math.max(0.1, num(S.cardAspect, 0.796));
    const R = Math.max(0, num(S.cardRadius, 0)) * Sc;
    const inStyle = S.revealStyle || 'matte', outStyle = S.clearStyle || 'cut';
    const lead = Math.max(0, num(S.revealLead, 0.4)), grow = Math.max(0.05, num(S.revealTime, 1)), cdur = Math.max(0.05, num(S.clearDur, 0.3));
    const revealE = easeOf(S.revealEase), clearE = easeOf(S.clearEase);
    const build = tl.Tb - tl.T0, clear = tl.Td - tl.Tc;
    const edgeBuild = S.buildOrder === 'edgeFirst', edgeClear = S.clearOrder === 'edgeFirst';
    const zf = num(S.zoomFrom, 200) / 100, zm = num(S.zoomMid, 65.76) / 100, zt = num(S.zoomTo, 30) / 100;
    const roll0 = num(S.cameraRoll, 0), sway = num(S.cameraSway, 0), swayW = (Math.PI * 2) / Math.max(0.1, num(S.swayPeriod, 3)), panK = num(S.cameraPan, 0);
    const camMode = S.camera === 'static' || S.camera === 'pushIn' ? S.camera : 'pullBack';
    const inMoves = STYLES.includes(inStyle), outMoves = STYLES.includes(outStyle);
    const warnings = [];

    // MotionFast's frame (cardCorridor.js cameraAt / draw), with its own curve solver (exact = false) or every curve
    // solved exactly (exact = true: what a fit follows)
    const model = (exact) => {
      const pick = (e) => (exact ? e.g : e.f);
      const ezS = exact ? bezierExact(...BZ_SMOOTH) : bezierMF(...BZ_SMOOTH);
      const ezA = exact ? bezierExact(...BZ_ZOOM_A) : bezierMF(...BZ_ZOOM_A);
      const ezB = exact ? bezierExact(...BZ_ZOOM_B) : bezierMF(...BZ_ZOOM_B);
      const ezO = exact ? bezierExact(...BZ_ORIGIN) : bezierMF(...BZ_ORIGIN);
      const rev = pick(revealE), clr = pick(clearE);
      const cam = (t) => {
        const prog = ezS(seg(t, tl.tz0, tl.tz2));
        const roll = roll0 * (1 - prog) + (sway ? sway * Math.sin(t * swayW) : 0);
        const pan = panK * (prog - 0.5);
        if (camMode === 'static') return { Z: zm, O: ORIGIN_TO, roll, pan, prog };
        const tt = camMode === 'pushIn' ? tl.tz0 + tl.tz2 - t : t;
        return {
          Z: tt < tl.tz1 ? lerp(zf, zm, ezA(seg(tt, tl.tz0, tl.tz1))) : lerp(zm, zt, ezB(seg(tt, tl.tz1, tl.tz2))),
          O: lerp(ORIGIN_FROM, ORIGIN_TO, ezO(seg(tt, tl.tz0, tl.tp1))), roll, pan, prog,
        };
      };
      const state = (c, t) => {
        const st = { mx: 1, my: 1, k: 1, fx: 1, alpha: 1, dx: 0, dy: 0, pin: 0, pout: 0 };
        if (inStyle === 'matte') shapeState(st, 'matte', rev(seg(t, c.tin - lead, c.tin - lead + grow)), 'in');
        else if (inStyle !== 'cut') shapeState(st, inStyle, rev(seg(t, c.tin, c.tin + grow)), 'in');
        if (t >= c.toff && outStyle !== 'none' && outStyle !== 'cut') shapeState(st, outStyle, 1 - clr(seg(t, c.toff, c.toff + cdur)), 'out');
        return st;
      };
      // the card on its side, corridor px from the band's centre (before the roll and the pan); the row null sits at
      // dir·(O + gap) with the zoom Z as its scale
      const geo = (c, dir, t) => {
        const st = state(c, t), k = cam(t);
        const O = k.O * Sc, Z = k.Z;
        const w = sizeF * c.csc * Z * st.k, h = w / aspect;
        const off = O + gap + c.rel * Z * Sc;
        const edgeR = k.roll ? Math.hypot(W, H) / 2 : W / 2 + Math.abs(k.pan * Sc);
        let x = dir * (off + st.dx * w * 0.6);
        if (st.pin > 0) x -= dir * st.pin * (off + w / 2);
        if (st.pout > 0) x += dir * st.pout * Math.max(0, edgeR + w / 2 - off);
        return { st, k, Z, O, w, h, off, x, y: st.dy * h * 0.6 };
      };
      return { cam, state, geo };
    };
    const MF = model(false), EX = model(true);

    // ── the camera: Corridor null (roll + sway, pan drift, the band's offset) → Row nulls (origin, zoom) ──────────────
    const camPhases = { prog: [{ t0: tl.tz0, t1: tl.tz2, ease: EASES.smooth }], Z: [], O: [] };
    const bzPhase = (t0, t1, b) => ({ t0, t1, ease: { f: bezierMF(...b), g: bezierExact(...b), key: { easing: 'Custom', bezier: b } } });
    if (camMode === 'pullBack') {
      camPhases.Z.push(bzPhase(tl.tz0, tl.tz1, BZ_ZOOM_A), bzPhase(tl.tz1, tl.tz2, BZ_ZOOM_B));
      camPhases.O.push(bzPhase(tl.tz0, tl.tp1, BZ_ORIGIN));
    } else if (camMode === 'pushIn') {
      const m = tl.tz0 + tl.tz2;
      camPhases.Z.push(bzPhase(tl.tz0, m - tl.tz1, reversed(BZ_ZOOM_B)), bzPhase(m - tl.tz1, tl.tz2, reversed(BZ_ZOOM_A)));
      camPhases.O.push(bzPhase(m - tl.tp1, tl.tz2, reversed(BZ_ORIGIN)));
    }
    const camCuts = [tl.tz0, tl.tz1, tl.tz2, tl.tp1, tl.tz0 + tl.tz2 - tl.tz1, tl.tz0 + tl.tz2 - tl.tp1];
    const Ds = Math.round(D * 1e4) / 1e4;
    const whole = (fM, fE, phases, tol) => trackKeys({ f: fM, g: fE, phases, A: 0, B: D, tol });
    const zs = camMode === 'static' ? [zm] : [zf, zm, zt];
    const Zmax = Math.max(...zs);
    const layers = [];
    const nullLayer = (key, name, tracks, parent) => {
      const propertyKeyframes = {}, propertyKeyframeFx = {};
      const NEUTRAL = { xPercent: 0, yPercent: 0, rotate: 0, scale: 1 };
      for (const [prop, [keys, more]] of Object.entries(tracks)) {
        if (!more && keys.every((k) => Math.abs(k.value - NEUTRAL[prop]) < 1e-12)) continue;
        const st = storeTrack(prop, keys, 0, Ds, more);
        propertyKeyframes[prop] = st.keys;
        if (st.fx) propertyKeyframeFx[prop] = st.fx;
      }
      layers.push({ key, type: 'null', name, freeStart: 0, trimEnd: Ds, ...(parent ? { keyframeParenting: { parentItemId: parent, type: 'additive' } } : {}),
        propertyKeyframes, ...(Object.keys(propertyKeyframeFx).length ? { propertyKeyframeFx } : {}) });
    };
    nullLayer('corridor', 'Corridor', {
      xPercent: [whole((t) => (MF.cam(t).pan * Sc * 100) / W, (t) => (EX.cam(t).pan * Sc * 100) / W, camPhases.prog, 1e-4)],
      yPercent: [[{ t: 0, value: num(S.bandOffset, 0), ease: LINEAR }]],
      rotate: [whole((t) => roll0 * (1 - MF.cam(t).prog), (t) => roll0 * (1 - EX.cam(t).prog), camPhases.prog, 1e-4), sway ? `+${n(sway)}*sin(time*${n(swayW)})` : ''],
    });
    for (const [side, dir] of [['L', -1], ['R', 1]]) {
      nullLayer(`row.${side}`, side === 'L' ? 'Left row' : 'Right row', {
        xPercent: [whole((t) => (dir * (MF.cam(t).O * Sc + gap) * 100) / W, (t) => (dir * (EX.cam(t).O * Sc + gap) * 100) / W, camPhases.O, 1e-4)],
        scale: [whole((t) => MF.cam(t).Z, (t) => EX.cam(t).Z, camPhases.Z, 1e-5)],
      }, 'corridor');
    }

    // ── the cards ───────────────────────────────────────────────────────────────────────────────────────────────────
    const plateSrc = (color, bw, bh) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(1, Math.round(bw))}" height="${Math.max(1, Math.round(bh))}"><rect width="100%" height="100%" fill="${color}"/></svg>`)}`;
    // the picture as the host fits it (scriptAssembler fitBox, cover): the card's share of the picture's width / height
    const coverShare = (m, cw, ch) => {
      const mm = m >= 0 ? media[m] : null;
      if (!(mm && Number(mm.w) > 0 && Number(mm.h) > 0)) return [100, 100, cw, ch];
      const nw = Number(mm.w), nh = Number(mm.h), fit = Math.min(1, W / nw, H / nh), pw = nw * fit, ph = nh * fit;
      const z = Math.max(cw / pw, ch / ph);
      return [Math.min(100, (cw / (pw * z)) * 100), Math.min(100, (ch / (ph * z)) * 100), pw * z, ph * z];
    };
    const pushIn = inStyle === 'push';
    const cards = [];
    for (let i = 0; i < N; i += 1) {
      const u = N > 1 ? i / (N - 1) : 0;
      const c = {
        i, u, rel: tab(LX, u) * spread, csc: LS[0] + (tab(LS, u) - LS[0]) * growth,
        tin: tl.T0 + build * tab(POP_IN, edgeBuild ? 1 - u : u),
        toff: tl.Tc + clear * tab(POP_OUT, edgeClear ? 1 - u : u),
      };
      c.w0 = sizeF * c.csc;
      c.h0 = c.w0 / aspect;
      c.inPhase = inMoves ? (inStyle === 'matte' ? { t0: c.tin - lead, t1: c.tin - lead + grow, ease: revealE } : { t0: c.tin, t1: c.tin + grow, ease: revealE }) : null;
      c.outPhase = outMoves ? { t0: c.toff, t1: c.toff + cdur, ease: clearE } : null;
      cards.push(c);
    }
    for (const c of cards) {
      const { i } = c;
      // its life: from its pop to its cut (or the end of its clear, or the clip's end)
      const tA = c.tin, tB = outStyle === 'cut' ? c.toff : outStyle === 'none' ? D : Math.min(D, c.toff + cdur);
      if (tB - tA < 1e-6) continue;
      const phases = [c.inPhase, c.outPhase].filter(Boolean);
      const extra = [];
      if (c.inPhase) extra.push(...easeCuts(revealE, c.inPhase.t0, c.inPhase.t1, false));
      if (c.outPhase) extra.push(...easeCuts(clearE, c.outPhase.t0, c.outPhase.t1, true));
      // the layer: its start rounded down (no key before it), at least 0.1 s (hidden outside its life when shorter)
      let fs = Math.floor(tA * 1e4 + 1e-7) / 1e4;
      let span = Math.round((tB - fs) * 1e4) / 1e4;
      const short = span < 0.1;
      if (short) { span = 0.1; if (fs + span > Ds) fs = Math.round((Ds - span) * 1e4) / 1e4; }
      const life = (t) => clamp(t, tA, tB - 1e-9);
      for (const [side, dir] of [['L', -1], ['R', 1]]) {
        const slot = alternate ? 2 * i + (side === 'R' ? 1 : 0) : i;
        const m = M ? (fill ? slot % M : Math.min(M - 1, slot)) : -1;
        const plate = PLATES[i % PLATES.length];
        // the picture the card shows and the box the host fits it to. A pushed-in card is cut at the seam by a second
        // mask, so its box is the whole cover-fitted picture (the host leaves it uncut) and its own mask crops the card
        const [mw0p, mh0p, pwz, phz] = coverShare(m, c.w0, c.h0);
        const own = pushIn;
        const bw0 = own ? pwz : c.w0, bh0 = own ? phz : c.h0;
        const b = Math.min(1, W / bw0, H / bh0);                    // a picture larger than the frame: the rest on its scale
        // an example plate is drawn at its SVG's whole px: its box is whole px, the rest on Scale X / Scale Y
        const box = m >= 0 ? { w: r6(bw0 * b), h: r6(bh0 * b), fit: 'cover', radius: 0 }
          : { w: Math.max(1, Math.round(bw0 * b)), h: Math.max(1, Math.round(bh0 * b)), fit: 'cover', radius: 0 };
        const sxr = (bw0 * b) / box.w, syr = (bh0 * b) / box.h;
        const mw0 = own ? mw0p : (m >= 0 ? mw0p : 100), mh0 = own ? mh0p : (m >= 0 ? mh0p : 100);
        const pic = m >= 0 ? { type: media[m].type === 'video' ? 'video' : 'image', media: m }
          : { type: 'image', media: slot, src: plateSrc(plate, box.w, box.h) };
        const tracks = {}, fxs = {};
        const set = (prop, keys, neutral, more = '') => {
          if (!keys.length) return;
          if (neutral !== null && keys.every((k) => Math.abs(k.value - neutral) < 1e-9) && !more) return;
          const st = storeTrack(prop, keys, fs, span, more);
          tracks[prop] = st.keys;
          if (st.fx) fxs[prop] = st.fx;
        };
        const mk = (fM, fE, tol, cuts = []) => trackKeys({ f: (t) => fM(life(t)), g: (t) => fE(life(t)), phases, extra: [...extra, ...cuts], A: tA, B: tB, tol });
        // place along the row (constant, % of the frame in the row's own px) and the offsets of slide / drop / rise /
        // push, in the row's px (the row's scale is the zoom)
        const relPx = dir * c.rel * Sc;
        set('xPercent', [{ t: tA, value: (relPx * 100) / W, ease: LINEAR }], 0);
        const ppu = Zmax;   // frame px per row px
        const tx = (MDL) => (t) => { const q = MDL.geo(c, dir, t); return (q.x - dir * (q.O + gap)) / q.Z - relPx; };
        const pushes = inStyle === 'push' || outStyle === 'push';
        set('translateX', mk(tx(MF), tx(EX), 0.02 / ppu, pushes ? camCuts : []), 0);
        const ty = (MDL) => (t) => { const q = MDL.geo(c, dir, t); return q.y / q.Z; };
        set('translateY', mk(ty(MF), ty(EX), 0.02 / ppu), 0);
        // size: the zoom style and the box's own scale
        const sc = (MDL) => (t) => MDL.state(c, t).k / b;
        set('scale', mk(sc(MF), sc(EX), 0.02 / (box.w * Zmax)), 1);
        // the matte / wipes narrow the card's mask (% of the picture). The editor keeps a mask at 2 % or more: below that
        // the mask holds at 2 % and the card's Scale X / Y shrink it the rest of the way (a sliver that thin shows its
        // picture squeezed, invisibly)
        const matte = (st) => ['matte', 'wipeH', 'wipeV'].includes(st);
        const usesMatte = matte(inStyle) || matte(outStyle);
        const cap = m >= 0 ? 1 : Infinity;   // MotionFast draws a picture inside its card only (see the mask below)
        const FLOOR = 2;
        const shownW = (st) => Math.min(cap, st.mx) * mw0, shownH = (st) => Math.min(cap, st.my) * mh0;
        const floorCuts = !usesMatte ? [] : [
          ...(c.inPhase ? easeCuts(revealE, c.inPhase.t0, c.inPhase.t1, false, [FLOOR / mw0, FLOOR / mh0], false) : []),
          ...(c.outPhase ? easeCuts(clearE, c.outPhase.t0, c.outPhase.t1, true, [FLOOR / mw0, FLOOR / mh0], false) : []),
        ];
        const thin = (v) => (usesMatte && v < FLOOR ? v / FLOOR : 1);
        const sx = (MDL) => (t) => { const st = MDL.state(c, t); return st.fx * sxr * thin(shownW(st)); };
        set('scaleX', mk(sx(MF), sx(EX), 0.02 / (c.w0 * Zmax), floorCuts), 1);
        const sy = (MDL) => (t) => syr * thin(shownH(MDL.state(c, t)));
        set('scaleY', mk(sy(MF), sy(EX), 0.02 / (c.h0 * Zmax), floorCuts), 1);
        const al = (MDL) => (t) => clamp01(MDL.state(c, t).alpha);
        const alphaKeys = mk(al(MF), al(EX), 0.001);
        // the mask; rounded corners keep MotionFast's frame-px radius
        const needMask = usesMatte || R > 0 || own;
        let layerEffects = null;
        if (needMask) {
          const mtol = (0.02 * mw0) / (c.w0 * Zmax);
          // (MotionFast draws a picture inside its card only: an overshooting matte on a cropped photo stops at the card;
          // a plate is the card, and its own edge cuts the mask)
          const mw = (MDL) => (t) => Math.max(FLOOR, shownW(MDL.state(c, t))), mh = (MDL) => (t) => Math.max(FLOOR, shownH(MDL.state(c, t)));
          set('msk:m1:w', mk(mw(MF), mw(EX), mtol, floorCuts), own ? null : mw0);
          set('msk:m1:h', mk(mh(MF), mh(EX), (0.02 * mh0) / (c.h0 * Zmax), floorCuts), own ? null : mh0);
          // own crop: the keys must exist (the host does not fit this picture's mask)
          if (own && !tracks['msk:m1:w']) set('msk:m1:w', [{ t: tA, value: mw0, ease: LINEAR }], null);
          if (own && !tracks['msk:m1:h']) set('msk:m1:h', [{ t: tA, value: mh0, ease: LINEAR }], null);
          let staticPath = RECT4;
          if (R > 0) {
            // corners as shares of the shown card (MotionFast: radius·min(mx, my)·k in frame px, at most half a side)
            const corner0 = (t) => {
              const q = MF.geo(c, dir, life(t));
              const fw = q.w * q.st.mx, fh = q.h * q.st.my;
              if (!(fw > 1e-9 && fh > 1e-9)) return null;
              const rr = clamp(R * Math.min(q.st.mx, q.st.my) * q.st.k, 0, Math.min(fw, fh) / 2);
              // a photo's mask stops at the card: the part of a corner past the card's edge is cut off (≈ a smaller corner)
              const cw = Math.min(fw, cap * q.w), ch = Math.min(fh, cap * q.h);
              return { rx: Math.max(0, rr - (fw - cw) / 2) / cw, ry: Math.max(0, rr - (fh - ch) / 2) / ch, cw, ch };
            };
            // a card of no size (a matte at 0) has the corners it grows with
            const corner = (t) => corner0(t) || corner0(t + 2e-4) || corner0(t - 2e-4) || { rx: 0, ry: 0, cw: 0, ch: 0 };
            // sampled where a straight line between two samples is within 0.05 px of the radius
            const times = [];
            const err = (a2, b2) => {
              const ca = corner(a2), cb = corner(b2);
              let e = 0;
              for (const q of [0.25, 0.5, 0.75]) {
                const cm = corner(a2 + (b2 - a2) * q);
                e = Math.max(e, Math.abs(ca.rx + (cb.rx - ca.rx) * q - cm.rx) * cm.cw, Math.abs(ca.ry + (cb.ry - ca.ry) * q - cm.ry) * cm.ch);
              }
              return e;
            };
            const walk = (a2, b2, depth) => { if (depth < 14 && b2 - a2 > 1 / 480 && err(a2, b2) > 0.05) { const mm = (a2 + b2) / 2; walk(a2, mm, depth + 1); walk(mm, b2, depth + 1); } else times.push(a2); };
            const xs = [...new Set([tA, tB, ...phases.flatMap((p) => [p.t0, p.t1]), ...extra, ...camCuts].filter((t) => t >= tA && t <= tB))].sort((x, y) => x - y);
            for (let j = 0; j + 1 < xs.length; j += 1) walk(xs[j], xs[j + 1], 0);
            times.push(tB - 1e-9);
            const vals = times.map((t) => { const q = corner(t); return { t, rx: q.rx, ry: q.ry }; });
            const first = vals[0];
            if (vals.every((v) => Math.abs(v.rx - first.rx) < 1e-6 && Math.abs(v.ry - first.ry) < 1e-6)) staticPath = roundRect8(first.rx, first.ry);
            else {
              staticPath = roundRect8(first.rx, first.ry);
              tracks['msk:m1:path'] = vals.map((v) => ({ position: r6(clamp(((v.t - fs) / span) * 100, 0, 100)), value: JSON.stringify(roundRect8(v.rx, v.ry)), easing: 'Linear' }))
                .filter((key, j, a) => j === 0 || key.position > a[j - 1].position);
            }
            if (!tracks['msk:m1:path'] && !own) box.radius = r6(staticPath[1] ? first.rx * box.w : 0);
          }
          const masks = [{ mid: 'm1', name: 'Card', mode: 'add', enabled: true, inverted: false, path: { points: staticPath, closed: true },
            x: 0, y: 0, w: r6(mw0), h: r6(mh0), rot: 0, feather: 0, expand: 0, opacity: 100, grow: 0 }];
          if (own) {
            // the seam: while the card is pushed out from behind it, only its own side of the seam shows (MotionFast's
            // clip); a band 300 % wide whose inner edge is the seam, as % of the picture
            const seamAt = (MDL) => (t) => {
              const q = MDL.geo(c, dir, life(t));
              if (!(q.st.pin > 0)) return 0;   // open: the band covers the whole picture
              const rel = (0 - q.x) / (q.w * Math.max(0.001, q.st.fx));            // the seam, in card widths from its centre
              const e = clamp(rel * mw0, -150, 150);
              return dir > 0 ? e + 150 : e - 150;
            };
            set('msk:m2:x', mk(seamAt(MF), seamAt(EX), mtol, camCuts), null);
            masks.push({ mid: 'm2', name: 'Seam', mode: 'intersect', enabled: true, inverted: false, path: { points: RECT4, closed: true },
              x: 0, y: 0, w: 300, h: 300, rot: 0, feather: 0, expand: 0, opacity: 100, grow: 0 });
          }
          layerEffects = [{ id: 'layerMask', eid: own ? 'card-mask' : 'box-mask', enabled: true, params: { mskAmount: 100, mskQuality: 0 }, masks }];
        }
        // opacity: the fades, and hidden outside its life on a 0.1 s layer
        let op = alphaKeys;
        if (short) {
          op = [...alphaKeys];
          if (tA > fs + 1e-7) op.unshift({ t: fs, value: 0, ease: { easing: 'Hold' } });
          if (tB < fs + span - 1e-7) { const last = op.pop(); op.push({ ...last, t: tB - JUMP }, { t: tB, value: 0, ease: { easing: 'Hold' } }); }
        }
        set('opacity', op, short ? null : 1);
        layers.push({
          ...pic, key: `card[${i}].${side}`, name: `Card ${i + 1} ${side === 'L' ? 'left' : 'right'}`, box, freeStart: fs, trimEnd: span,
          keyframeParenting: { parentItemId: `row.${side}`, type: 'additive' },
          propertyKeyframes: tracks, ...(Object.keys(fxs).length ? { propertyKeyframeFx: fxs } : {}),
          ...(layerEffects ? { layerEffects } : {}),
        });
      }
    }
    if (M && media.some((x) => x.type === 'video')) warnings.push('A video on a card plays once (no loop yet).');
    return { duration: D, layers, warnings: warnings.filter(Boolean) };
  },
};
