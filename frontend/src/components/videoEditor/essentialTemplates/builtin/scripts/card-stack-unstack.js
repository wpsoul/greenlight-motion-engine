// Unstacking Cards (MotionFast `card-stack-unstack`): the mirror of Stacking Cards. The finished stack is the base state:
// every card owns its slot (its rank from the front) for the whole clip; the entry brings each card into that slot
// (drop, rise, slide, gather, grow, fade, or already there), and the leave sends the cards out of frame one at a time
// while the cards behind inherit the slot, so the pile closes up toward the viewer as it empties. Each arrival and each
// release nudges the pile (squash, bounce, spring, dip, shake, tilt).
//
// Built from ordinary layers as Stacking Cards (card-stack-drop.js, the same drawing repeated here: a built-in imports
// nothing): per card and per phase (its entry, its time on the pile, its leave) a drop shadow (a black card blurred by a
// Fast Blur, its blur and offset growing while the card is off the pile), the plate, the picture, the depth shade and
// the label. The depth is the card's rank minus the slots handed over by the cards leaving in front (ease-out cubic: the
// app's Ease Out), so it is always a key curve; the card's own entry and leave ride the translate and Scale X / Y tracks
// on the chosen easing (mirrored into an ease-in for the leave); the reactions are damped sines in the ƒx.
//
// A built-in script (PLANS/ESSENTIAL_TEMPLATES.md §14): it imports nothing, so this same text also runs as a
// `kind: "script"` source. Numbers and timing are MotionFast's (motionTemplates/cardUnstack.js).
const FIT_MARGIN = 0.94;
const FADE_IN = 0.22;
const CLOSE_TAIL = 0.35;
const RELEASE_MUL = 0.6;
const LIFT_SHADOW = 2.2;
const SHADOW_BLUR = 46;
const SHADOW_OFFSET = 22;
const IMPACT_WINDOW = 1.6;
const DEG = Math.PI / 180;
const ASPECTS = { '1:1': 1, '4:5': 4 / 5, '3:4': 3 / 4, '9:16': 9 / 16, '4:3': 4 / 3, '16:9': 16 / 9 };
const IMPACT_STYLES = {
  none: {},
  squash: { sqY: 0.11, sqX: 0.075, sqD: 11, sqF: 24, stackY: 16 },
  bounce: { hop: 34, hopD: 5.5, hopF: 13, sqY: 0.06, sqX: 0.04, sqD: 13, sqF: 26, stackY: 8 },
  spring: { grow: 0.10, growD: 7, growF: 24 },
  dip: { stackY: 34, stackD: 6.5, stackF: 15 },
  shake: { stackX: 13, stackXD: 9, stackXF: 38, stackY: 5 },
  tilt: { rot: 4.2, rotD: 8, rotF: 22 },
};
const ENTRY_MODES = {
  none: { vx: 0, vy: 0, instant: true },
  drop: { vx: 0, vy: -1 },
  rise: { vx: 0, vy: 1 },
  slideLeft: { vx: -1, vy: 0 },
  slideRight: { vx: 1, vy: 0 },
  gather: { vx: 'alt', vy: 0 },
  grow: { vx: 0, vy: 0, scaleFrom: 0.55 },
  fade: { vx: 0, vy: 0, fadeOnly: true },
};
const LEAVE_MODES = {
  dropOut: { vx: 0, vy: 1, spin: 'alt' },
  flyUp: { vx: 0, vy: -1, spin: 'alt' },
  swipeLeft: { vx: -1, vy: -0.12, spin: -1 },
  swipeRight: { vx: 1, vy: -0.12, spin: 1 },
  scatter: { vx: 'alt', vy: -0.35, spin: 'dir', spinMul: 2.4 },
  shrink: { vx: 0, vy: 0, spin: 0, shrinkTo: 0.55, fade: true },
};

// ── MotionFast's easings (motionTemplates/mtl.js getEase) and the editor's key curve for each, both ways ──────────
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const num = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
function bezierCurve(p1x, p1y, p2x, p2y) {   // easingEngine.bezierEase: the same numbers
  const bx = (t) => 3 * p1x * t * (1 - t) * (1 - t) + 3 * p2x * t * t * (1 - t) + t * t * t;
  const by = (t) => 3 * p1y * t * (1 - t) * (1 - t) + 3 * p2y * t * t * (1 - t) + t * t * t;
  return (x) => {
    x = clamp01(x);
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 24; i += 1) { const cx = bx(t); if (Math.abs(cx - x) < 1e-4) break; if (cx < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return by(t);
  };
}
const TABLE = (s) => s.split(',').map(Number);
const T_ELASTIC = TABLE('0,.0221,.0739,.1485,.2394,.3402,.4458,.5517,.6541,.7502,.8375,.9149,.9813,1.0364,1.0803,1.1136,1.1369,1.1513,1.1579,1.1578,1.1522,1.1424,1.1294,1.1142,1.0978,1.081,1.0643,1.0485,1.0338,1.0205,1.009,.9992,.9912,.9849,.9803,.9772,.9754,.9748,.9752,.9764,.9782,.9804,.9829,.9856,.9882,.9908,.9933,.9955,.9975,.9992,1.0007,1.0018,1.0027,1.0034,1.0038,1.004,1.004,1.0039,1.0036,1.0033,1.0029,1.0025,1.0021,1.0017,1.0013,1.0009,1.0006,1.0003,1,.9998,.9996,.9995,.9994,.9994,.9994,.9994,.9994,.9994,.9995,.9996,.9996,.9997,.9998,.9998,.9999,.9999,1,1,1,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1');
const T_OVERSHOOT = TABLE('0,.1739,.3067,.4183,.515,.6,.6755,.743,.8034,.8576,.9063,.95,.9891,1.0241,1.0551,1.0825,1.1066,1.1275,1.1455,1.1606,1.1731,1.183,1.1906,1.1959,1.199,1.2,1.1997,1.1988,1.1972,1.195,1.1921,1.1886,1.1846,1.18,1.1749,1.1695,1.1638,1.1579,1.1519,1.1458,1.1397,1.1337,1.1277,1.1219,1.1162,1.1107,1.1053,1.1002,1.0952,1.0904,1.0857,1.0813,1.077,1.0729,1.0689,1.0651,1.0615,1.058,1.0547,1.0515,1.0484,1.0455,1.0427,1.0401,1.0375,1.0351,1.0327,1.0305,1.0284,1.0264,1.0244,1.0226,1.0209,1.0192,1.0176,1.0162,1.0148,1.0134,1.0122,1.011,1.0099,1.0088,1.0079,1.007,1.0061,1.0053,1.0046,1.0039,1.0033,1.0028,1.0023,1.0018,1.0014,1.0011,1.0008,1.0005,1.0003,1.0002,1.0001,1,1');
const T_IMPULSE = TABLE('0,-.0006,-.0023,-.005,-.0086,-.0131,-.0183,-.0243,-.0308,-.038,-.0456,-.0537,-.0622,-.071,-.0801,-.0894,-.0988,-.1084,-.1179,-.1275,-.1369,-.1461,-.1551,-.1636,-.1717,-.1791,-.1858,-.1915,-.1959,-.1989,-.2,-.1986,-.1944,-.187,-.1762,-.1616,-.1432,-.1206,-.0939,-.0632,-.0289,.0087,.0487,.0906,.1334,.1765,.2193,.2613,.3022,.3416,.3794,.4156,.4501,.483,.5142,.5438,.5719,.5986,.6239,.6478,.6705,.692,.7124,.7317,.75,.7673,.7837,.7993,.814,.8279,.841,.8535,.8652,.8763,.8868,.8967,.9059,.9147,.9229,.9305,.9377,.9444,.9507,.9565,.9619,.9669,.9714,.9756,.9794,.9829,.986,.9888,.9912,.9933,.9952,.9967,.9979,.9988,.9995,.9999,1');
const T_SWING = TABLE('0,-.0013,-.0052,-.0115,-.0199,-.0302,-.0421,-.0554,-.0697,-.0847,-.1,-.1153,-.1303,-.1446,-.1579,-.1698,-.1801,-.1885,-.1948,-.1987,-.2,-.1986,-.1942,-.1863,-.1744,-.1578,-.136,-.1079,-.0725,-.0288,.0241,.087,.1594,.2396,.3241,.4088,.4899,.5651,.6332,.6941,.7482,.796,.8384,.8758,.9088,.9379,.9636,.9863,1.0061,1.0235,1.0386,1.0517,1.0628,1.0723,1.0801,1.0865,1.0916,1.0954,1.098,1.0995,1.1,1.0997,1.0987,1.097,1.0947,1.0919,1.0885,1.0847,1.0806,1.0762,1.0717,1.0671,1.0624,1.0578,1.0533,1.0489,1.0447,1.0406,1.0368,1.0332,1.0297,1.0265,1.0235,1.0207,1.0181,1.0157,1.0135,1.0115,1.0097,1.008,1.0065,1.0052,1.0041,1.0031,1.0022,1.0015,1.001,1.0005,1.0002,1.0001,1');
const sampled = (tb) => (t) => { t = clamp01(t); const i = t * (tb.length - 1), lo = Math.floor(i), hi = Math.min(tb.length - 1, lo + 1); return tb[lo] + (tb[hi] - tb[lo]) * (i - lo); };
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
const BACK = 1.70158;
const BEZ = { smooth: [0.5, 0, 0, 1], natural: [0.8, 0, 0.2, 1], slowDown: [0, 0, 0, 1], aeIn: [0.3141666673, 0, 0.0875000209, 1],
  aeSmooth: [0.882083327, 0, 0.2445833683, 1], aeOut: [0.8699999754, 0, 0.6433336333, 1] };
const TABLES = { elastic: T_ELASTIC, overshoot: T_OVERSHOOT, impulse: T_IMPULSE, swing: T_SWING };
const EASE_FN = {
  power2: powOut(3), power3: powOut(4), power4: powOut(5),
  back: (t) => { t = clamp01(t); return 1 + (BACK + 1) * Math.pow(t - 1, 3) + BACK * Math.pow(t - 1, 2); },
  bounce: bounceOut,
  expo: (t) => { t = clamp01(t); return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); },
};
for (const [k, b] of Object.entries(BEZ)) EASE_FN[k] = bezierCurve(...b);
for (const [k, tb] of Object.entries(TABLES)) EASE_FN[k] = sampled(tb);
const NAMED = { power2: 'Ease Out', power3: 'Cubic Out', power4: 'Power', back: 'Back Out', bounce: 'Bounce Out', natural: 'Natural',
  slowDown: 'Slow Down', overshoot: 'Overshoot', impulse: 'Impulse', swing: 'Swing', aeIn: 'AE In (arrive)', aeSmooth: 'AE Smooth', aeOut: 'AE Out (leave)' };
const NAMED_IN = { power2: 'Ease In', power3: 'Cubic In', back: 'Back In', natural: 'Natural' };
const r6 = (v) => { const x = Math.round(v * 1e6) / 1e6; return Object.is(x, -0) ? 0 : x; };
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const n = (v) => { const x = Number(v); return Math.abs(x) < 1e-12 ? '0' : String(Number(x.toPrecision(10))); };
// how a driver that runs 0 → 1 on a MotionFast easing is keyed: a key curve of the editor ({ easing }), a 101-point
// table (straight between: exact), or the time share u straight with the curve in the ƒx (`fx(u)`)
function easeKeying(name, mirrored) {
  const f = EASE_FN[name] || EASE_FN.smooth;
  const fn = mirrored ? (x) => 1 - f(1 - clamp01(x)) : f;
  if (TABLES[name]) {
    const tb = TABLES[name];
    return { fn, table: mirrored ? tb.map((_, j) => 1 - tb[tb.length - 1 - j]) : tb };
  }
  if (!mirrored && NAMED[name]) return { fn, key: { easing: NAMED[name] } };
  if (mirrored && NAMED_IN[name]) return { fn, key: { easing: NAMED_IN[name] } };
  if (BEZ[name]) {
    const [a, b, c, d] = BEZ[name];
    return { fn, key: { easing: 'Custom', bezier: (mirrored ? [1 - c, 1 - d, 1 - a, 1 - b] : [a, b, c, d]).map(r6) } };
  }
  // written in the ƒx (u = the time share, clamped)
  const fx = {
    expo: (u) => (mirrored ? `(${u}<=0?0:pow(2,10*${u}-10))` : `(${u}>=1?1:1-pow(2,-10*${u}))`),
    power4: (u) => (mirrored ? `pow(${u},5)` : `(1-pow(1-${u},5))`),
    bounce: (u) => {
      const b = (x) => `(${x}<${n(1 / 2.75)}?7.5625*pow(${x},2):${x}<${n(2 / 2.75)}?7.5625*pow(${x}-${n(1.5 / 2.75)},2)+0.75:${x}<${n(2.5 / 2.75)}?7.5625*pow(${x}-${n(2.25 / 2.75)},2)+0.9375:7.5625*pow(${x}-${n(2.625 / 2.75)},2)+0.984375)`;
      return mirrored ? `(1-${b(`(1-${u})`)})` : b(u);
    },
  }[name];
  return { fn, fx };
}
// the same easing as ƒx text of a clamped share (null: no closed form, i.e. a bezier or a table)
function easeExpr(name, mirrored, u) {
  const k = easeKeying(name, mirrored);
  if (k.fx) return k.fx(u);
  const pw = { power2: 3, power3: 4 }[name];
  if (pw) return mirrored ? `pow(${u},${pw})` : `(1-pow(1-${u},${pw}))`;
  if (name === 'back') return mirrored ? `(${n(BACK + 1)}*pow(${u},3)-${n(BACK)}*pow(${u},2))` : `(1+${n(BACK + 1)}*pow(${u}-1,3)+${n(BACK)}*pow(${u}-1,2))`;
  return null;
}
const EASE_OPTIONS = [['smooth', 'Smooth'], ['power2', 'Power 2'], ['power3', 'Power 3'], ['power4', 'Power 4'], ['back', 'Back'],
  ['bounce', 'Bounce'], ['expo', 'Expo'], ['natural', 'Natural'], ['slowDown', 'Slow Down'], ['elastic', 'Elastic'],
  ['overshoot', 'Overshoot'], ['impulse', 'Impulse'], ['swing', 'Swing'], ['aeIn', 'AE In'], ['aeSmooth', 'AE Smooth'], ['aeOut', 'AE Out']]
  .map(([value, label]) => ({ value, label }));
const WEIGHT_OPTIONS = [[400, 'Regular'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra Bold'], [900, 'Black']].map(([value, label]) => ({ value, label }));

const fields = [
  { type: 'group', key: 'gMedia', label: 'Media' },
  { key: 'media', type: 'media', label: 'Images / videos (front card first)', slots: { from: 'media', max: 12 }, accept: 'media', ifFewer: 'reuse' },
  { key: 'fillEmpty', type: 'switch', label: 'Repeat media across empty cards', default: true },
  { key: 'imageFit', type: 'select', label: 'Image Fit', default: 'cover', options: [
    { value: 'cover', label: 'Cover (fill card)' }, { value: 'contain', label: 'Contain (fit inside)' }, { value: 'stretch', label: 'Stretch' },
  ] },
  { key: 'imageScale', type: 'range', label: 'Image Scale', default: 1, min: 0.5, max: 2, step: 0.05, suffix: 'x' },
  { type: 'group', key: 'gStack', label: 'Stack' },
  { key: 'cardCount', type: 'range', label: 'Cards', default: 5, min: 2, max: 12, step: 1, integer: true },
  { key: 'offsetY', type: 'range', label: 'Step up', default: 46, min: -160, max: 160, step: 2 },
  { key: 'offsetX', type: 'range', label: 'Step sideways', default: 0, min: -160, max: 160, step: 2 },
  { key: 'scaleStep', type: 'range', label: 'Scale per card', default: 0.94, min: 0.8, max: 1.06, step: 0.005 },
  { key: 'rotStep', type: 'range', label: 'Rotate per card', default: 0, min: -15, max: 15, step: 0.5, suffix: '°' },
  { key: 'tiltVary', type: 'range', label: 'Tilt variation', default: 0, min: 0, max: 14, step: 0.5, suffix: '°' },
  { key: 'depthShade', type: 'range', label: 'Depth shade', default: 0.15, min: 0, max: 1, step: 0.02 },
  { key: 'visibleDepth', type: 'range', label: 'Cards visible behind', default: 6, min: 1, max: 12, step: 1, integer: true },
  { type: 'group', key: 'gCards', label: 'Cards' },
  { key: 'cardSize', type: 'range', label: 'Card size', default: 560, min: 200, max: 900, step: 10 },
  { key: 'cardAspect', type: 'select', label: 'Card shape', default: '1:1', options: [
    { value: '1:1', label: 'Square 1:1' }, { value: '4:5', label: 'Portrait 4:5' }, { value: '3:4', label: 'Portrait 3:4' },
    { value: '9:16', label: 'Portrait 9:16' }, { value: '4:3', label: 'Landscape 4:3' }, { value: '16:9', label: 'Landscape 16:9' },
  ] },
  { key: 'cornerRadius', type: 'range', label: 'Corner radius', default: 44, min: 0, max: 160, step: 2 },
  { key: 'shadow', type: 'range', label: 'Shadow', default: 0.7, min: 0, max: 1.5, step: 0.05 },
  { key: 'borderWidth', type: 'range', label: 'Border width', default: 0, min: 0, max: 14, step: 1 },
  { key: 'borderColor', type: 'color', label: 'Border colour', default: '#ffffff' },
  { type: 'group', key: 'gColors', label: 'Card Colours' },
  { key: 'color1', type: 'color', label: 'Card colour 1', default: '#33efab' },
  { key: 'color2', type: 'color', label: 'Card colour 2', default: '#f9492d' },
  { key: 'color3', type: 'color', label: 'Card colour 3', default: '#ffffff' },
  { key: 'color4', type: 'color', label: 'Card colour 4', default: '#1d9bf1' },
  { type: 'group', key: 'gLabels', label: 'Labels' },
  { key: 'labels', type: 'textarea', label: 'Labels — one line per card, front card first', default: '' },
  { key: 'fontFamily', type: 'font', label: 'Label Font', default: 'Inter, sans-serif' },
  { key: 'fontWeight', type: 'select', label: 'Label Weight', default: 900, options: WEIGHT_OPTIONS },
  { key: 'fontSize', type: 'range', label: 'Label Size', default: 130, min: 24, max: 320, step: 2 },
  { key: 'textColor', type: 'color', label: 'Label Colour', default: '#ffffff' },
  { type: 'group', key: 'gEntry', label: 'Entry' },
  { key: 'entry', type: 'select', label: 'Cards arrive by', default: 'drop', options: [
    { value: 'drop', label: 'Dropping in from above' }, { value: 'rise', label: 'Rising in from below' },
    { value: 'slideLeft', label: 'Sliding in from the left' }, { value: 'slideRight', label: 'Sliding in from the right' },
    { value: 'gather', label: 'Gathering from both sides' }, { value: 'grow', label: 'Growing in on the spot' },
    { value: 'fade', label: 'Fading in on the spot' }, { value: 'none', label: 'Already there (no entry)' },
  ] },
  { key: 'entryOrder', type: 'select', label: 'Arrive order', default: 'back', showIf: { key: 'entry', notEquals: 'none' }, options: [
    { value: 'back', label: 'Back card first (pile builds forward)' }, { value: 'front', label: 'Front card first' },
  ] },
  { key: 'entryDuration', type: 'range', label: 'Entry duration', default: 0.5, min: 0.15, max: 2, step: 0.01, suffix: 's', showIf: { key: 'entry', notEquals: 'none' } },
  { key: 'entryStagger', type: 'range', label: 'Gap between arrivals', default: 0.07, min: 0, max: 0.8, step: 0.01, suffix: 's', showIf: { key: 'entry', notEquals: 'none' } },
  { key: 'entryDistance', type: 'range', label: 'Entry distance', default: 900, min: 0, max: 2200, step: 20, showIf: { key: 'entry', notEquals: 'none' } },
  { key: 'entryTilt', type: 'range', label: 'Entry tilt', default: -6, min: -60, max: 60, step: 1, suffix: '°', showIf: { key: 'entry', notEquals: 'none' } },
  { key: 'entryScale', type: 'range', label: 'Entry scale', default: 1.06, min: 0.2, max: 1.8, step: 0.02, suffix: 'x', showIf: { key: 'entry', notEquals: 'none' } },
  { type: 'group', key: 'gLeave', label: 'Leave' },
  { key: 'leave', type: 'select', label: 'Cards leave by', default: 'dropOut', options: [
    { value: 'dropOut', label: 'Falling out the bottom' }, { value: 'flyUp', label: 'Flying up out of frame' },
    { value: 'swipeLeft', label: 'Swiping off left' }, { value: 'swipeRight', label: 'Swiping off right' },
    { value: 'scatter', label: 'Scattering both ways' }, { value: 'shrink', label: 'Shrinking away' },
  ] },
  { key: 'leaveOrder', type: 'select', label: 'Leave order', default: 'front', options: [
    { value: 'front', label: 'Front card first (pile closes up)' }, { value: 'back', label: 'Back card first' },
  ] },
  { key: 'leaveDuration', type: 'range', label: 'Leave duration, per card', default: 0.55, min: 0.15, max: 3, step: 0.01, suffix: 's' },
  { key: 'leaveDistance', type: 'range', label: 'Leave distance', default: 1300, min: 200, max: 2400, step: 20 },
  { key: 'leaveSpin', type: 'range', label: 'Leave spin', default: 8, min: 0, max: 60, step: 1, suffix: '°' },
  { key: 'impactStyle', type: 'select', label: 'Reaction effect', default: 'squash', options: [
    { value: 'squash', label: 'Squash & settle' }, { value: 'bounce', label: 'Bounce up' }, { value: 'spring', label: 'Spring scale' },
    { value: 'dip', label: 'Stack dip (heavy)' }, { value: 'shake', label: 'Slam shake' }, { value: 'tilt', label: 'Tilt wobble' },
    { value: 'none', label: 'None (clean)' },
  ] },
  { key: 'impact', type: 'range', label: 'Reaction amount', default: 0.15, min: 0, max: 1.5, step: 0.05 },
  { type: 'group', key: 'gTiming', label: 'Timing' },
  { key: 'speed', type: 'range', label: 'Speed', default: 1, min: 0.25, max: 3, step: 0.05 },
  { key: 'easing', type: 'select', label: 'Easing', default: 'power3', options: EASE_OPTIONS },
  { key: 'pause', type: 'range', label: 'Pause between cards', default: 0.22, min: -0.4, max: 2.5, step: 0.02, suffix: 's' },
  { key: 'holdFull', type: 'range', label: 'Hold full stack first', default: 0.45, min: 0, max: 4, step: 0.05, suffix: 's' },
  { key: 'endHold', type: 'range', label: 'Hold empty at end', default: 0.2, min: 0, max: 4, step: 0.1, suffix: 's' },
];

// Labels: a label is shrunk to 84 % of its card's width where it is wider, and MotionFast centres it on the canvas's
// 'middle' baseline. A script cannot measure text, so it asks the host: measure() names every label (its font, weight
// and size as MotionFast measures it, before the stack's fit scale) and build() reads `metrics`: the width, and the font
// box against the 'middle' line (the text layer centres its font box). Without metrics (node tools) an estimate is used
// (0.55 em a letter; the middle 0.0634 em above the box's centre, Inter's), with a warning.
const MID_EST = 0.0634;
const labelLines = (P) => String(P.labels == null ? '' : P.labels).split(/\r?\n/);
// MotionFast's noise(): the per-card tilt
const noise = (x) => { const y = Math.sin(x) * 10000; return y - Math.floor(y); };
const damp = (tau, decay, freq) => Math.exp(-decay * tau) * Math.sin(freq * tau);
// eight points of a rounded rectangle in the mask's unit box (−0.5 … 0.5)
function roundRect8(rx, ry) {
  const K = 0.5522847498307936, kx = K * rx, ky = K * ry;
  const P = (x, y, hi, ho) => ({ x: r4(x), y: r4(y), hIn: { x: r4(hi[0]), y: r4(hi[1]) }, hOut: { x: r4(ho[0]), y: r4(ho[1]) }, manual: true });
  return [
    P(-0.5 + rx, -0.5, [-kx, 0], [0, 0]), P(0.5 - rx, -0.5, [0, 0], [kx, 0]),
    P(0.5, -0.5 + ry, [0, -ky], [0, 0]), P(0.5, 0.5 - ry, [0, 0], [0, ky]),
    P(0.5 - rx, 0.5, [kx, 0], [0, 0]), P(-0.5 + rx, 0.5, [0, 0], [-kx, 0]),
    P(-0.5, 0.5 - ry, [0, ky], [0, 0]), P(-0.5, -0.5 + ry, [0, 0], [0, -ky]),
  ];
}
// a sum as ƒx text, balanced (the parser caps nesting at 40)
function sum(list) {
  const xs = list.filter((x) => x && x !== '0');
  if (!xs.length) return '0';
  if (xs.length === 1) return xs[0];
  const m = Math.ceil(xs.length / 2);
  return `(${sum(xs.slice(0, m))}+${sum(xs.slice(m))})`;
}
// c0 + c1·x as ƒx text (zero terms dropped)
const lin = (c0, c1, x) => {
  const a = Math.abs(c0) > 1e-12 ? n(c0) : '', b = Math.abs(c1) > 1e-12 ? `${n(c1)}*${x}` : '';
  return a && b ? `(${a}+${b})` : a || b || '0';
};
// a rough size check of ƒx text (MAX_NODES 600, 4000 characters, nesting 40 in keyframeExpr.js)
function fitsFx(code) {
  if (code.length > 3800) return false;
  const tokens = code.match(/[A-Za-z_][A-Za-z0-9_]*|[0-9.]+(e[-+]?[0-9]+)?|&&|\|\||[<>=!]=?|[-+*/?:(),]/g) || [];
  if (tokens.filter((t) => t !== '(' && t !== ')' && t !== ',').length > 520) return false;
  let depth = 0, max = 0;
  for (const c of code) { if (c === '(') { depth += 1; max = Math.max(max, depth); } else if (c === ')') depth -= 1; }
  return max <= 30;
}

// MotionFast's timeline (scene seconds; speed divides it)
function timings(P) {
  const count = Math.max(1, Math.round(num(P.cardCount, 5)));
  const entryOn = (P.entry || 'drop') !== 'none';
  const entryDur = Math.max(0.08, num(P.entryDuration, 0.5));
  const entryStag = Math.max(0, num(P.entryStagger, 0.07));
  const leaveDur = Math.max(0.08, num(P.leaveDuration, 0.55));
  const gap = num(P.pause, 0.22);
  const holdFull = Math.max(0, num(P.holdFull, 0.45));
  const endHold = Math.max(0, num(P.endHold, 0.2));
  const entryEnd = entryOn ? (count - 1) * entryStag + entryDur : 0;
  const leaveBegin = entryEnd + holdFull;
  const leaveStep = leaveDur + gap;
  const lastGone = leaveBegin + (count - 1) * leaveStep + leaveDur;
  return { count, entryOn, entryDur, entryStag, leaveDur, gap, holdFull, endHold, entryEnd, leaveBegin, leaveStep, total: lastGone + endHold };
}

export default {
  id: 'card-stack-unstack',
  name: 'Unstacking Cards',
  category: 'Carousels',
  v: 1,
  fields,
  // every card's label at the label size (the stack's fit scale is applied to the drawn layer, not to the measure)
  measure({ settings: P }) {
    const family = P.fontFamily || 'Inter, sans-serif';
    const weight = num(P.fontWeight, 900) || 900;
    const fontSize = Math.max(6, num(P.fontSize, 130));
    return labelLines(P).slice(0, 12).map((line, r) => ({ key: `label[${r}]`, text: line.trim(), font: family, size: fontSize, weight }))
      .filter((q) => q.text && Array.from(q.text).length <= 256);
  },
  build({ settings: P, media, frame, metrics }) {
    const { W, H } = frame;
    const Tm = timings(P);
    const sp = Math.max(0.05, num(P.speed, 1));
    const D = Math.round(Math.max(0.6, Tm.total / sp) * 1e9) / 1e9;
    const easeName = EASE_FN[P.easing] ? P.easing : 'smooth';
    const fallK = easeKeying(easeName, false), exitK = easeKeying(easeName, true);   // the entry's, the leave's
    const ease = fallK.fn, exitEase = exitK.fn;
    const count = Tm.count;
    const cardH = Math.max(40, num(P.cardSize, 560));
    const cardW = cardH * (ASPECTS[P.cardAspect] || 1);
    const radius = Math.max(0, num(P.cornerRadius, 44));
    const offY = num(P.offsetY, 46), offX = num(P.offsetX, 0);
    const scaleStep = clamp(num(P.scaleStep, 0.94), 0.5, 1.2);
    const rotStep = num(P.rotStep, 0) * DEG;
    const tiltVary = num(P.tiltVary, 0) * DEG;
    const depthShade = clamp(num(P.depthShade, 0.15), 0, 1);
    const visibleDepth = Math.max(0, Math.round(num(P.visibleDepth, 6)));
    const shadow = Math.max(0, num(P.shadow, 0.7));
    const borderW = Math.max(0, num(P.borderWidth, 0));
    const impact = Math.max(0, num(P.impact, 0.15));
    const style = IMPACT_STYLES[P.impactStyle] || IMPACT_STYLES.squash;
    const entryMode = ENTRY_MODES[P.entry || 'drop'] || ENTRY_MODES.drop;
    const entryFrontFirst = (P.entryOrder || 'back') === 'front';
    const entryDist = Math.max(0, num(P.entryDistance, 900));
    const entryTilt = num(P.entryTilt, -6) * DEG;
    const entryScale = clamp(num(P.entryScale, 1.06), 0.05, 3);
    const physical = Tm.entryOn && !entryMode.fadeOnly;
    const leaveMode = LEAVE_MODES[P.leave || 'dropOut'] || LEAVE_MODES.dropOut;
    const leaveFrontFirst = (P.leaveOrder || 'front') !== 'back';
    const leaveDist = Math.max(0, num(P.leaveDistance, 1300));
    const leaveSpin = num(P.leaveSpin, 8) * DEG;
    const colors = [P.color1 || '#33efab', P.color2 || '#f9492d', P.color3 || '#ffffff', P.color4 || '#1d9bf1'];
    const fit = ['cover', 'contain', 'stretch'].includes(P.imageFit) ? P.imageFit : 'cover';
    const iscale = Math.max(0.05, num(P.imageScale, 1));
    const fillEmpty = P.fillEmpty !== false;
    const labels = labelLines(P);
    const family = P.fontFamily || 'Inter, sans-serif';
    const weight = num(P.fontWeight, 900) || 900;
    const fontSize = Math.max(6, num(P.fontSize, 130));
    const M = media.length;
    const warnings = [];
    // a label's width and its 'middle' line's lift (both at the label size) as the host measured them, else the estimate
    let estimated = 0;
    const labelMetric = (text, r) => {
      const m = metrics && metrics[`label[${r}]`];
      if (m && Number.isFinite(m.width)) {
        const lift = Number.isFinite(m.ascent) && Number.isFinite(m.descent) && Number.isFinite(m.middle) ? (m.ascent - m.descent) / 2 - m.middle : MID_EST * fontSize;
        return { w: m.width, lift };
      }
      estimated += 1;
      return { w: Array.from(text).length * 0.55 * fontSize, lift: MID_EST * fontSize };
    };

    // the cards (MotionFast createInstance): a card IS its rank (0 = the front); content fills front-first
    const cards = [];
    for (let r = 0; r < count; r += 1) {
      const alt = r % 2 ? -1 : 1;
      const lvx = leaveMode.vx === 'alt' ? alt : leaveMode.vx;
      const sign = leaveMode.spin === 'alt' ? alt : leaveMode.spin === 'dir' ? (lvx >= 0 ? 1 : -1) : leaveMode.spin;
      const entryIdx = entryFrontFirst ? r : count - 1 - r, leaveIdx = leaveFrontFirst ? r : count - 1 - r;
      const arriveAt = Tm.entryOn ? entryIdx * Tm.entryStag : 0;
      const leaveAt = Tm.leaveBegin + leaveIdx * Tm.leaveStep;
      cards.push({
        i: r, rank: r, color: colors[r % colors.length], label: (labels[r] || '').trim(),
        imageIndex: M > 0 ? (fillEmpty ? r % M : (r < M ? r : -1)) : -1,
        tilt: tiltVary ? (noise(r * 12.9898 + 4.1) * 2 - 1) * tiltVary : 0,
        arriveAt, settledAt: Tm.entryOn ? arriveAt + Tm.entryDur : 0, leaveAt,
        evx: entryMode.vx === 'alt' ? alt : entryMode.vx, evy: entryMode.vy, lvx, lvy: leaveMode.vy, spin: leaveSpin * sign * (leaveMode.spinMul || 1),
      });
    }
    // the framing of the FULL stack (the state the clip opens on)
    const slot = (d) => ({ x: offX * d, y: -offY * d, s: Math.pow(scaleStep, d), rot: rotStep * d });
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let d = 0; d < count; d += 1) {
      const st = slot(d);
      const hw = (cardW / 2) * st.s, hh = (cardH / 2) * st.s;
      const a = Math.abs(st.rot) + Math.abs(tiltVary);
      const ca = Math.abs(Math.cos(a)), sa = Math.abs(Math.sin(a));
      const rw = hw * ca + hh * sa, rh = hw * sa + hh * ca;
      minX = Math.min(minX, st.x - rw); maxX = Math.max(maxX, st.x + rw);
      minY = Math.min(minY, st.y - rh); maxY = Math.max(maxY, st.y + rh);
    }
    const S = Math.min(H / 1080, (W * FIT_MARGIN) / Math.max(1, maxX - minX), (H * FIT_MARGIN) / Math.max(1, maxY - minY));
    const ox = -((minX + maxX) / 2) * S, oy = -((minY + maxY) / 2) * S;    // the origin, frame px from the centre

    // ── the depth of card r: its rank minus the slots handed over by the cards leaving in front (ease-out cubic over
    // 1.35 leaves, from each one's departure), MotionFast's own loop
    const depthTerms = cards.map((c) => {
      const terms = [];
      for (let j = 0; j < c.rank; j += 1) terms.push({ a: cards[j].leaveAt, L: Math.max(1e-4, Tm.leaveDur * (1 + CLOSE_TAIL)), sgn: -1, shape: 'eoc' });
      return { base: c.rank, terms };
    });
    const depthAt = (i, t) => {
      const { base, terms } = depthTerms[i];
      let d = base;
      for (const q of terms) d += q.sgn * (1 - Math.pow(1 - clamp01((t - q.a) / q.L), 3));
      return Math.max(0, d);
    };
    const goneAt = (c, t) => exitEase(clamp01((t - c.leaveAt) / Tm.leaveDur));
    // what nudges the pile: every arrival, and every release (softer)
    const hits = [];
    for (const c of cards) { if (Tm.entryOn) hits.push({ a: c.settledAt, k: 1 }); hits.push({ a: c.leaveAt, k: RELEASE_MUL }); }
    const settleAt = (t) => {
      const o = { dx: 0, dy: 0 };
      if (impact <= 0) return o;
      for (const h of hits) {
        const tau = t - h.a;
        if (tau < 0 || tau > IMPACT_WINDOW) continue;
        if (style.stackY) o.dy += style.stackY * impact * h.k * damp(tau, style.stackD || 9, style.stackF || 21);
        if (style.stackX) o.dx += style.stackX * impact * h.k * damp(tau, style.stackXD || 9, style.stackXF || 38);
      }
      return o;
    };
    const impactAt = (c, t) => {
      const o = { qx: 1, qy: 1, dy: 0, rot: 0 };
      const tau = t - c.settledAt;
      if (impact <= 0 || !Tm.entryOn || tau < 0 || tau > IMPACT_WINDOW) return o;
      if (style.sqY) { const q = damp(tau, style.sqD, style.sqF); o.qy = 1 - style.sqY * impact * q; o.qx = 1 + style.sqX * impact * q; }
      if (style.grow) { const g = 1 + style.grow * impact * damp(tau, style.growD, style.growF); o.qx *= g; o.qy *= g; }
      if (style.hop) o.dy = -style.hop * impact * Math.abs(damp(tau, style.hopD, style.hopF));
      if (style.rot) o.rot = style.rot * DEG * impact * damp(tau, style.rotD, style.rotF);
      return o;
    };
    // card r at scene time t: exactly MotionFast's render (null where it is not drawn)
    const poseAt = (c, t) => {
      if (t < c.arriveAt) return null;
      const away = goneAt(c, t);
      if (away >= 1) return null;
      const depth = depthAt(c.i, t);
      const st = slot(depth);
      const prog = Tm.entryOn ? clamp01((t - c.arriveAt) / Tm.entryDur) : 1, e = ease(prog), arriving = prog < 1;
      const onPile = !arriving && away <= 0;
      const imp = onPile ? impactAt(c, t) : { qx: 1, qy: 1, dy: 0, rot: 0 };
      const set = onPile ? settleAt(t) : { dx: 0, dy: 0 };
      let sx = st.x + set.dx, sy = st.y + imp.dy + set.dy, sc = st.s, rot = st.rot + c.tilt + imp.rot;
      if (physical && arriving) {
        sx += c.evx * entryDist * (1 - e); sy += c.evy * entryDist * (1 - e);
        sc *= (entryMode.scaleFrom || entryScale) + (1 - (entryMode.scaleFrom || entryScale)) * e; rot += entryTilt * (1 - e);
      }
      let fade = 1;
      if (away > 0) {
        sx += c.lvx * leaveDist * away; sy += c.lvy * leaveDist * away; rot += c.spin * away;
        if (leaveMode.shrinkTo) sc *= 1 + (leaveMode.shrinkTo - 1) * away;
        fade = leaveMode.fade ? 1 - away : 1 - clamp01((away - 0.9) / 0.1);
      }
      const lift = 1 + LIFT_SHADOW * (arriving ? 1 - e : away);
      const alpha = clamp01(prog / FADE_IN) * clamp01(visibleDepth + 1 - depth) * fade;
      return { x: ox + sx * S, y: oy + sy * S, rot, sx: sc * imp.qx, sy: sc * imp.qy, alpha, lift, depth, shade: depthShade * clamp01(depth / 4) };
    };

    // ── layer timing: a layer starts at its first key rounded DOWN to 1/10000 s (the host's step), ends at its last
    const at4 = (t) => (Math.abs(t - D) < 1e-9 ? r4(D) : Math.floor(t * 1e4 + 1e-7) / 1e4);
    const layers = [];
    const TOL = { deg: 0.06, unit: 0.002 };

    // keys of a function f (scene time) over pieces [t0, t1, how] of a layer [fs, fs + span] (real seconds):
    // how = 'line' | 'cubic' | { easing… } | { table } | { tol } (samples, finer where it bends)
    function keysOf(f, pieces, fs, span) {
      const pos = (t) => r6(clamp(((t / sp - fs) / span) * 100, 0, 100));
      const out = [];
      const push = (t, ez) => out.push({ position: pos(t), value: f(t), ...(ez || { easing: 'Linear' }) });
      const cubicEase = (a, b) => {
        const y0 = f(a), y1 = f(a + (b - a) / 3), y2 = f(a + (2 * (b - a)) / 3), y3 = f(b), d = y3 - y0;
        const b1 = (18 * y1 - 9 * y2 - 5 * y0 + 2 * y3) / 6, b2 = (18 * y2 - 9 * y1 - 5 * y3 + 2 * y0) / 6;
        const sc = Math.max(Math.abs(y0), Math.abs(y3), Math.abs(b1), Math.abs(b2), 1e-9);
        if (Math.abs(b1 - (y0 + d / 3)) < 1e-9 * sc && Math.abs(b2 - (y0 + (2 * d) / 3)) < 1e-9 * sc) return { easing: 'Linear' };
        if (Math.abs(d) < 1e-6 * sc) return null;
        const p1 = (b1 - y0) / d, p2 = (b2 - y0) / d;
        if (!(p1 >= -3 && p1 <= 4 && p2 >= -3 && p2 <= 4)) return null;
        return { easing: 'Custom', bezier: [0.3333, r4(p1), 0.6667, r4(p2)] };
      };
      const adaptive = (a, b, tol, depth = 0) => {
        const fa = f(a), fb = f(b);
        let worst = 0;
        for (const q of [0.25, 0.5, 0.75]) worst = Math.max(worst, Math.abs(f(a + (b - a) * q) - (fa + (fb - fa) * q)));
        if (worst > tol && depth < 9 && (b - a) * sp > 0.004) { const m = (a + b) / 2; adaptive(a, m, tol, depth + 1); adaptive(m, b, tol, depth + 1); return; }
        push(a);
      };
      // a piece drawn by one Custom bezier through f at 0, 1/3, 2/3, 1 (x handles at 1/3, 2/3), split in two where the
      // drawn curve misses f by more than tol (a sum of eased ramps: a few pieces, no key per frame)
      const fitted = (a, b, tol, depth = 0) => {
        const ez = cubicEase(a, b);
        if (ez || depth >= 8) {
          const y0 = f(a), y3 = f(b);
          const curve = ez && ez.easing === 'Custom' ? bezierCurve(...ez.bezier) : (s) => s;
          let worst = 0;
          if (ez) for (const q of [0.08, 0.2, 0.35, 0.5, 0.65, 0.8, 0.92]) worst = Math.max(worst, Math.abs(f(a + (b - a) * q) - (y0 + (y3 - y0) * curve(q))));
          if (ez && (worst <= tol || depth >= 8)) { push(a, ez); return; }
          if (!ez) { push(a); return; }
        }
        const m = (a + b) / 2; fitted(a, m, tol, depth + 1); fitted(m, b, tol, depth + 1);
      };
      const add = (a, b, how, depth = 0) => {
        if (b - a < 1e-9) return;
        if (how === 'line') { push(a); return; }
        if (how === 'cubic') {
          const ez = cubicEase(a, b);
          if (ez) { push(a, ez); return; }
          if (depth < 4) { const m = (a + b) / 2; add(a, m, how, depth + 1); add(m, b, how, depth + 1); return; }
          how = { tol: 1e-4 };
        }
        if (how.fit) { fitted(a, b, how.fit); return; }
        if (how.table) { for (let j = 0; j < how.table.length - 1; j += 1) push(a + ((b - a) * j) / (how.table.length - 1)); return; }
        if (how.tol) {
          // start from a sample a frame (60 a second), then split where the straight line misses by more than tol
          const steps = Math.max(1, Math.ceil(((b - a) / sp) * 60));
          for (let j = 0; j < steps; j += 1) adaptive(a + ((b - a) * j) / steps, a + ((b - a) * (j + 1)) / steps, how.tol);
          return;
        }
        push(a, how);
      };
      const list = pieces.filter((p) => p[1] - p[0] > 1e-9).sort((x, y) => x[0] - y[0]);
      list.forEach(([a, b, how], k) => {
        add(a, b, how);
        if (k + 1 < list.length && list[k + 1][0] - b > 1e-9) push(b);
      });
      if (list.length) push(list[list.length - 1][1]); else push(fs * sp);
      const same = (x, y) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x));
      const keep = out.filter((k, i) => i === 0 || i === out.length - 1 || !(same(out[i - 1].value, k.value) && same(k.value, out[i + 1].value) && out[i - 1].easing === 'Linear' && k.easing === 'Linear'));
      const dedup = keep.filter((k, i) => i === 0 || k.position > keep[i - 1].position);
      if (dedup.every((k) => same(k.value, dedup[0].value))) return [{ position: 0, value: n(dedup[0].value), easing: 'Linear' }];
      return dedup.map((k) => ({ ...k, value: n(k.value) }));
    }

    // ── one card in one phase: [t0, t1] scene seconds, with the drivers its tracks read
    // the parts of a card bottom to top; channels follow (card in paint order, part), so a part a phase lacks (the
    // front card's shade while it falls) never lands its channel above a later part
    const PARTS = ['shadow', 'card', 'picture', 'shade', 'label', 'border'];
    let paintIndex = 0;
    function emitPhase(c, tag, t0, t1, kind, onPile = false) {
      const fs = at4(t0 / sp);
      const span0 = (t1 - t0) / sp;
      const end = at4(t1 / sp);   // the next phase on the track starts there (rounded down too)
      let span = r4(end - fs);
      // the editor's shortest layer is 0.1 s: a shorter phase is drawn on a 0.1 s layer of its own channel, hidden
      // outside its own times (a layer must not start within 0.05 s of the end, so it reaches back then)
      let lfs = fs, hide = null;
      if (span < 0.1) {
        if (fs + 0.1 <= D + 1e-9) { span = 0.1; } else { lfs = r4(Math.max(0, D - 0.1)); span = r4(D - lfs); }
        hide = [fs - lfs, fs - lfs + span0];
      }
      const T0 = lfs;
      const tm = (a) => { const x = a / sp - T0; return Math.abs(x) < 1e-12 ? 'time' : x > 0 ? `(time-${n(x)})` : `(time+${n(-x)})`; };
      // a clamped share of a scene interval [a, a + L] in the layer's time
      const share = (a, L) => `clamp(${tm(a)}*${n(sp / L)},0,1)`;

      // the depth over this phase: its keys (pieces) and its ƒx text (null where a ramp has no closed form)
      const { base, terms } = depthTerms[c.i];
      const act = terms.filter((q) => q.a < t1 - 1e-9 && q.a + q.L > t0 + 1e-9);
      const done = terms.filter((q) => q.a + q.L <= t0 + 1e-9).reduce((s, q) => s + q.sgn, base);
      const dConst = act.length === 0;
      let dExpr = n(done);
      if (!dConst) {
        const parts = act.map((q) => {
          const u = share(q.a, q.L);
          const sh = `(1-pow(1-${u},3))`;
          return sh === null ? null : (q.sgn > 0 ? sh : `(0-${sh})`);
        });
        dExpr = parts.includes(null) ? null : sum([done ? n(done) : '', ...parts]);
      }
      const dPieces = (() => {
        const cuts = [t0, t1];
        for (const q of act) cuts.push(clamp(q.a, t0, t1), clamp(q.a + q.L, t0, t1));
        const xs = [...new Set(cuts.map((x) => Math.round(x * 1e9) / 1e9))].sort((a, b) => a - b);
        const out = [];
        for (let k = 0; k + 1 < xs.length; k += 1) {
          const a = xs[k], b = xs[k + 1];
          const on = act.filter((q) => q.a < b - 1e-9 && q.a + q.L > a + 1e-9);
          if (!on.length) out.push([a, b, 'line']);
          else if (on.every((q) => q.shape === 'eoc')) out.push([a, b, on.length === 1 && Math.abs(a - on[0].a) < 1e-9 && Math.abs(b - on[0].a - on[0].L) < 1e-9 ? { easing: 'Ease Out' } : 'cubic']);
          else if (on.length === 1 && Math.abs(a - on[0].a) < 1e-9 && Math.abs(b - on[0].a - on[0].L) < 1e-9 && (exitK.key || exitK.table)) out.push([a, b, exitK.key || { table: exitK.table }]);
          else out.push([a, b, { fit: 0.008 }]);   // 0.008 of a slot: ≤ 0.4 px
        }
        // fitted stretches next to each other are one (the fit splits where it needs to, not at every ramp's end)
        return out.reduce((acc, q) => {
          const last = acc[acc.length - 1];
          if (last && last[2].fit && q[2].fit && Math.abs(last[1] - q[0]) < 1e-9) last[1] = q[1]; else acc.push([...q]);
          return acc;
        }, []);
      })();
      const dVal = (t) => depthAt(c.i, clamp(t, t0, t1));
      let dMin = done, dMax = done;
      if (!dConst) for (let j = 0; j <= 64; j += 1) { const v = dVal(t0 + ((t1 - t0) * j) / 64); dMin = Math.min(dMin, v); dMax = Math.max(dMax, v); }

      // the own driver: the fall's eased progress (F) or the exit's (X)
      let own = null;
      if (kind === 'F' || kind === 'X') {
        const k = kind === 'F' ? fallK : exitK;
        const a = kind === 'F' ? c.arriveAt : c.leaveAt, L = kind === 'F' ? Tm.entryDur : Tm.leaveDur;
        const u = (t) => clamp01((t - a) / L);
        // MotionFast moves a leaving card only while its leave is past 0 (`if (away > 0)`): an ease that winds back
        // first (Back, Overshoot, Swing mirrored) holds the card on the pile there (that stretch is its own phase,
        // onPile); its shadow's lift reads the leave as it is (`raw`)
        const gate = kind === 'X' ? (x) => `max(0,${x})` : (x) => x;
        if (k.fx) own = { f: u, pieces: [[Math.max(a, t0), Math.min(a + L, t1), 'line']], expr: (v) => gate(k.fx(`clamp(${v},0,1)`)), raw: (v) => k.fx(`clamp(${v},0,1)`), lo: 0, hi: 1 };
        else {
          const lo = k.table ? Math.min(...k.table) : -0.2, hi = k.table ? Math.max(...k.table) : 1.2;
          // a phase that holds only part of the curve keys that part (fitted pieces: a piece of a bezier is one)
          const whole = a >= t0 - 1e-9 && a + L <= t1 + 1e-9;
          own = { f: (t) => k.fn(u(t)), pieces: whole ? [[a, a + L, k.key || { table: k.table }]] : [[Math.max(a, t0), Math.min(a + L, t1), { fit: 1e-4 }]], expr: (v) => gate(v), raw: (v) => v, lo: Math.min(lo, 0), hi: Math.max(hi, 1) };
        }
      }
      // the depth as a driver (a constant depth: a single key the ƒx ignores)
      const dummy = { f: () => 0, pieces: [[t0, t1, 'line']], expr: () => '0', lo: 0, hi: 0 };
      const dDrv = dConst ? { ...dummy, expr: () => n(done) } : { f: dVal, pieces: dPieces, expr: (v) => v, lo: dMin, hi: dMax };

      // a track from a driver: its keys hold shift + k·driver inside the track's range; code(driverText) is the value
      const track = (drv, code, range) => {
        const [mn, mx] = range;
        let shift = 0, k = 1;
        if (drv.lo < mn || drv.hi > mx) {
          if (drv.lo + 1 >= mn && drv.hi + 1 <= mx) shift = 1;
          else { k = (mx - mn) * 0.9 / Math.max(1e-9, drv.hi - drv.lo); shift = mn + (mx - mn) * 0.05 - k * drv.lo; }
        }
        const keys = keysOf((t) => shift + k * drv.f(t), drv.pieces, lfs, span);
        const v = shift === 0 && k === 1 ? 'value' : `((value-${n(shift)})/${n(k)})`;
        const body = code(drv.expr(v), v);
        return { keys, code: body };
      };
      const constant = (v) => ({ keys: [{ position: 0, value: n(v), easing: 'Linear' }] });
      const samples = (f, tol) => ({ keys: keysOf(f, [[t0, t1, { fit: tol }]], lfs, span) });
      const R = { pos: [-200, 200], tr: [-1200, 1200], sc: [0.1, 20], rot: [-1000, 1000], op: [0, 2] };

      // ── the time terms (ƒx of the layer's time): the pile's nudge and the landed card's own reaction
      const landed = kind === 'S' || (kind === 'X' && onPile);
      // A·e^(−Dτ)·sin(Fτ) for 0 ≤ τ ≤ 1.6 s after a landing (τ in scene seconds), only where it reaches this layer
      const dampTerm = (a, A, Dk, F, abs) => {
        if (Math.abs(A) < 1e-12) return '';
        if (!(a < t1 - 1e-9 && a + IMPACT_WINDOW > t0 + 1e-9)) return '';
        const x = tm(a);
        const s = `sin(${n(F * sp)}*${x})`;
        return `(${x}>=0&&${x}<=${n(IMPACT_WINDOW / sp)}?${n(A)}*exp(${n(-Dk * sp)}*${x})*${abs ? `abs(${s})` : s}:0)`;
      };
      const settleX = landed && impact > 0 && style.stackX ? sum(hits.map((h) => dampTerm(h.a, style.stackX * impact * h.k, style.stackXD || 9, style.stackXF || 38))) : '0';
      const settleY = landed && impact > 0 && style.stackY ? sum(hits.map((h) => dampTerm(h.a, style.stackY * impact * h.k, style.stackD || 9, style.stackF || 21))) : '0';
      const own0 = landed && impact > 0 && Tm.entryOn;   // the card's own reaction: on its arrival
      const hopY = own0 && style.hop ? dampTerm(c.settledAt, -style.hop * impact, style.hopD, style.hopF, true) || '0' : '0';
      const qBase = own0 && style.sqY ? dampTerm(c.settledAt, 1, style.sqD, style.sqF) : '';
      const gBase = own0 && style.grow ? dampTerm(c.settledAt, style.grow * impact, style.growD, style.growF) : '';
      const qx = qBase ? `(1+${n(style.sqX * impact)}*${qBase})` : '1', qy = qBase ? `(1-${n(style.sqY * impact)}*${qBase})` : '1';
      const qxT = gBase ? `${qx}*(1+${gBase})` : qx, qyT = gBase ? `${qy}*(1+${gBase})` : qy;
      const impRot = own0 && style.rot ? dampTerm(c.settledAt, style.rot * impact, style.rotD, style.rotF) || '0' : '0';   // degrees
      const hasSettleX = settleX !== '0', hasSettleY = settleY !== '0' || hopY !== '0';
      const hasQ = qxT !== '1' || qyT !== '1';
      const prog = kind === 'F' ? `clamp(${tm(c.arriveAt)}*${n(sp / (Tm.entryDur * FADE_IN))},0,1)` : null;

      // ── the tracks of the card's transform, shared by its parts
      const fx = {};
      const kf = {};
      const put = (name, t) => { kf[name] = t.keys; if (t.code !== undefined) fx[name] = t.code; };
      // its place in the pile (the depth's slot) and the pile's nudge
      const xOf = (d) => `${sum([n(ox), offX ? `${n(offX * S)}*${d}` : '', hasSettleX ? `${n(S)}*${settleX}` : ''])}*${n(100 / W)}`;
      const yOf = (d) => `${sum([n(oy), offY ? `${n(-offY * S)}*${d}` : '', hasSettleY ? `${n(S)}*${sum([settleY, hopY])}` : ''])}*${n(100 / H)}`;
      if (!hasSettleX && (dConst || !offX)) put('xPercent', constant(((ox + offX * S * done) * 100) / W)); else put('xPercent', track(dDrv, xOf, R.pos));
      if (!hasSettleY && (dConst || !offY)) put('yPercent', constant(((oy - offY * S * done) * 100) / H)); else put('yPercent', track(dDrv, yOf, R.pos));
      // its size in the pile
      if (scaleStep !== 1 && !dConst) put('scale', track(dDrv, (d) => `pow(${n(scaleStep)},${d})`, R.sc));
      else put('scale', constant(Math.pow(scaleStep, done)));
      // its own flight (translate), entry size and squash (Scale X / Y), its turn
      const fallX = physical ? c.evx * entryDist * S : 0, fallY = physical ? c.evy * entryDist * S : 0;
      const from = entryMode.scaleFrom || entryScale;
      if (kind === 'F') {
        if (fallX) put('translateX', track(own, (e) => `${n(fallX)}*(1-${e})`, R.tr));
        if (fallY) put('translateY', track(own, (e) => `${n(fallY)}*(1-${e})`, R.tr));
        if (physical && from !== 1) { const s = track(own, (e) => `(${n(from)}+${n(1 - from)}*${e})`, R.sc); put('scaleX', s); put('scaleY', s); }
      } else if (kind === 'X' && !onPile) {
        if (c.lvx && leaveDist) put('translateX', track(own, (g) => `${n(c.lvx * leaveDist * S)}*${g}`, R.tr));
        if (c.lvy && leaveDist) put('translateY', track(own, (g) => `${n(c.lvy * leaveDist * S)}*${g}`, R.tr));
        if (leaveMode.shrinkTo) {
          const shr = (g) => `(1+${n(leaveMode.shrinkTo - 1)}*${g})`;
          put('scaleX', track(own, (g) => `${qxT}*${shr(g)}`, R.sc)); put('scaleY', track(own, (g) => `${qyT}*${shr(g)}`, R.sc));
        }
      } else if (hasQ) {
        put('scaleX', track(dummy, () => qxT, R.sc)); put('scaleY', track(dummy, () => qyT, R.sc));
      }
      const tiltIn = physical ? entryTilt : 0;
      // the turn: slot turn + tilt + entry tilt (F) + landing wobble + exit spin (X)
      const rotD = (d) => sum([rotStep ? `${n(rotStep / DEG)}*${d}` : '', c.tilt ? n(c.tilt / DEG) : '', impRot !== '0' ? impRot : '']);
      const rotDepthVaries = rotStep && !dConst;
      if (kind === 'F') {
        const code = (e) => sum([rotD(rotDepthVaries ? dExpr : n(done)), tiltIn ? `${n(tiltIn / DEG)}*(1-${e})` : '']);
        if (tiltIn || (rotDepthVaries)) put('rotate', track(own, code, R.rot)); else put('rotate', constant((rotStep * done + c.tilt) / DEG));
      } else if (kind === 'X') {
        const spin = onPile ? 0 : c.spin;
        if (spin || rotDepthVaries || impRot !== '0') put('rotate', track(own, (g) => sum([rotD(rotDepthVaries ? dExpr : n(done)), spin ? `${n(spin / DEG)}*${g}` : '']), R.rot));
        else put('rotate', constant((rotStep * done + c.tilt) / DEG));
      } else if (rotDepthVaries || impRot !== '0') put('rotate', track(dDrv, rotD, R.rot));
      else put('rotate', constant((rotStep * done + c.tilt) / DEG));

      // ── the fade: the fall's fade-in (F), the depth beyond `visibleDepth`, the exit's fade (X); times a factor of the
      // depth (the card's: 1; its shade's: depthShade · clamp(depth / 4))
      const visMatters = dMax > visibleDepth;
      const vis = (d) => (visMatters ? `*clamp(${n(visibleDepth + 1)}-${d},0,1)` : '');
      const exitFade = (g) => (onPile ? '1' : leaveMode.fade ? `(1-${g})` : `(1-clamp((${g}-0.9)*10,0,1))`);
      // mul = { text(d), val(d), byDepth }
      const opacityOf = (mul, mulOfPose) => {
        const byD = !dConst && (visMatters || mul.byDepth);
        if (kind === 'F') return track(byD ? dDrv : { ...dummy, expr: () => n(done) }, (d) => `${prog}${vis(d)}${mul.text(d)}`, R.op);
        if (kind === 'S') {
          if (!byD) return constant(clamp01(visibleDepth + 1 - done) * mul.val(done));
          return track(dDrv, (d) => `1${vis(d)}${mul.text(d)}`, R.op);
        }
        // X: the exit's fade on the own driver, the depth in the ƒx (or samples where it has no closed form)
        const needD = !dConst && (visMatters || mul.byDepth);
        if (!needD || dExpr !== null) {
          const d = dConst ? n(done) : dExpr;
          return track(own, (g) => `${exitFade(g)}${needD ? vis(d) : ''}${needD ? mul.text(d) : mul.text(n(done))}`, R.op);
        }
        return samples((tt) => { const p = poseAt(c, clamp(tt, t0, t1 - 1e-9)); return p ? p.alpha * mulOfPose(p) : 0; }, TOL.unit);
      };
      const baseKf = kf, baseFx = fx;

      // ── the parts, bottom to top
      const cw = cardW * S, ch = cardH * S, rr = Math.min(radius, cardW / 2, cardH / 2) * S;
      const shapeOf = (fill) => ({ type: 'shape', shapeType: 'rectangle', shapeSizeUnit: 'px', shapeWidthPx: r6(cw), shapeHeightPx: r6(ch), shapeFillColor: fill, borderRadius: r6(rr) });
      const name = `Card ${c.rank + 1}`;
      const emit = (part, base, extraKf, extraFx, opacityTrack, child = false) => {
        // a child (the label) takes its card's transform from its parent: only its own tracks
        const propertyKeyframes = child ? { ...extraKf } : { ...baseKf, ...extraKf }, propertyKeyframeFx = {};
        for (const [k, v] of Object.entries(child ? extraFx : { ...baseFx, ...extraFx })) if (v !== undefined) propertyKeyframeFx[k] = { type: 'custom', params: { code: v } };
        if (opacityTrack) {
          propertyKeyframes.opacity = opacityTrack.keys;
          if (opacityTrack.code !== undefined) propertyKeyframeFx.opacity = { type: 'custom', params: { code: opacityTrack.code } };
        }
        if (hide) {
          // hidden outside the phase's own times on its 0.1 s layer
          const code = propertyKeyframeFx.opacity ? propertyKeyframeFx.opacity.params.code : (propertyKeyframes.opacity ? 'value' : '1');
          if (!propertyKeyframes.opacity) propertyKeyframes.opacity = [{ position: 0, value: '1', easing: 'Linear' }];
          propertyKeyframeFx.opacity = { type: 'custom', params: { code: `(time>=${n(hide[0])}&&time<${n(hide[1])}?${code}:0)` } };
        }
        for (const [k, v] of Object.entries(propertyKeyframeFx)) if (!fitsFx(v.params.code)) warnings.push(`${name} ${part}: a ƒx of ${k} is long (${v.params.code.length} characters).`);
        const out = { ...base, key: `card[${c.i}].${part}.${tag}`, ord: [paintIndex, PARTS.indexOf(part)], name: `${name}${part === 'card' ? '' : ` ${part}`}`, track: hide ? `card[${c.i}].${part}.${tag}` : `card[${c.i}].${part}`,
          freeStart: lfs, trimEnd: r6(span), propertyKeyframes };
        if (Object.keys(propertyKeyframeFx).length) out.propertyKeyframeFx = propertyKeyframeFx;
        layers.push(out);
      };
      const cardOpacity = opacityOf({ text: () => '', val: () => 1, byDepth: false }, () => 1);
      // the drop shadow: a black card, offset and blurred in frame px (the canvas shadow ignores the transform), its
      // blur and offset growing while the card is in the air; σ = shadowBlur / 2; Fast Blur: σ² = r² + r (3 boxes)
      if (shadow > 0) {
        const sa = 0.34 * Math.min(1.4, shadow);
        const sig = (lift) => `${n((SHADOW_BLUR * shadow) / 2)}*${lift}`;
        const blurOf = (lift) => `max(0,(sqrt(1+4*pow(${sig(lift)},2))-1)*${n(540 / H)})`;
        const extraKf = {}, extraFx = {};
        const shY = SHADOW_OFFSET * shadow;
        if (kind === 'F') {
          const tY = track(own, (e) => sum([fallY ? `${n(fallY)}*(1-${e})` : '', `${n(shY)}*(1+${n(LIFT_SHADOW)}*(1-${e}))`]), R.tr);
          extraKf.translateY = tY.keys; extraFx.translateY = tY.code;
          const tB = track(own, (e) => blurOf(`(1+${n(LIFT_SHADOW)}*(1-${e}))`), [0, 250]);
          extraKf['fx:blur:blurriness'] = tB.keys; extraFx['fx:blur:blurriness'] = tB.code;
        } else if (kind === 'X') {
          // the lift reads the leave as it is (a wind-back shrinks the shadow while the card still sits on the pile)
          const lift = (v) => `(1+${n(LIFT_SHADOW)}*${own.raw(v)})`;
          const tr = (v) => `${n(shY)}*${lift(v)}`;
          const tY = track(own, (g, v) => sum([!onPile && c.lvy && leaveDist ? `${n(c.lvy * leaveDist * S)}*${g}` : '', tr(v)]), R.tr);
          extraKf.translateY = tY.keys; extraFx.translateY = tY.code;
          const tB = track(own, (g, v) => blurOf(lift(v)), [0, 250]);
          extraKf['fx:blur:blurriness'] = tB.keys; extraFx['fx:blur:blurriness'] = tB.code;
        } else extraKf.translateY = constant(shY).keys;
        const b0 = (Math.sqrt(1 + 4 * Math.pow((SHADOW_BLUR * shadow) / 2, 2)) - 1) * (540 / H);
        const op = cardOpacity.code !== undefined ? { keys: cardOpacity.keys, code: `${n(sa)}*(${cardOpacity.code})` }
          : { keys: cardOpacity.keys.map((k) => ({ ...k, value: n(Number(k.value) * sa) })) };
        emit('shadow', { ...shapeOf('#000000'), effects: [{ id: 'fastBlur', eid: 'blur', enabled: true, mix: 100, params: { blurriness: r6(b0), iterations: 3, dimensions: 0, repeatEdges: 0 } }] },
          extraKf, extraFx, op);
      }
      emit('card', shapeOf(c.color), {}, {}, cardOpacity);
      if (c.imageIndex >= 0) {
        const md = media[c.imageIndex];
        const extraKf = {}, extraFx = {};
        const pic = { type: md.type === 'video' ? 'video' : 'image', media: c.imageIndex, box: { w: r6(cw), h: r6(ch), fit, radius: r6(rr) } };
        if (Math.abs(iscale - 1) > 1e-9) {
          // Image Scale: the picture grows inside the card (the layer scaled, its mask, the card, shrunk back)
          const known = Number(md.w) > 0 && Number(md.h) > 0;
          const nw = known ? Number(md.w) : cw, nh = known ? Number(md.h) : ch;
          const kk = Math.min(1, W / nw, H / nh), pw = nw * kk, ph = nh * kk;
          const zoom = fit === 'stretch' ? 1 : fit === 'contain' ? Math.min(cw / pw, ch / ph) : Math.max(cw / pw, ch / ph);
          const dw = fit === 'stretch' ? cw : pw * zoom, dh = fit === 'stretch' ? ch : ph * zoom;
          const sc = kf.scale.length === 1 && fx.scale === undefined ? { keys: kf.scale.map((k) => ({ ...k, value: n(Number(k.value) * iscale) })) } : null;
          if (sc) extraKf.scale = sc.keys; else { extraKf.scale = kf.scale; extraFx.scale = `(${fx.scale})*${n(iscale)}`; }
          extraKf['msk:m1:w'] = constant((100 * cw) / (dw * iscale)).keys;
          extraKf['msk:m1:h'] = constant((100 * ch) / (dh * iscale)).keys;
        }
        emit('picture', pic, extraKf, extraFx, cardOpacity);
      }
      // the depth shade: a black card whose opacity is the card's × depthShade · clamp(depth / 4)
      if (depthShade * clamp01(dMax / 4) > 0.002) {
        const mul = { text: (d) => `*${n(depthShade)}*clamp(${d}*0.25,0,1)`, val: (d) => depthShade * clamp01(d / 4), byDepth: true };
        emit('shade', shapeOf('#000000'), {}, {}, opacityOf(mul, (p) => p.shade));
      }
      if (c.label) {
        // the label: a child of the card (it turns, squashes and scales with it), centred where the canvas's 'middle'
        // baseline puts it (its font box's centre minus the middle line, as measured), shrunk to 84 % of the card's width
        // where it is wider
        const lm = labelMetric(c.label, c.rank);
        const w = lm.w;
        const size = w > cardW * 0.84 ? fontSize * ((cardW * 0.84) / w) : fontSize;
        emit('label', { type: 'text', textContent: c.label, textColor: P.textColor || '#ffffff', textFontFamily: family, textFontWeight: weight,
          textFontSizeUnit: 'px', textFontSize: r6(Math.min(1000, size * S)), textAlign: 'center', textNoWrap: true, textLineHeight: 1,
          keyframeParenting: { parentItemId: `card[${c.i}].card.${tag}`, type: 'additive' } },
        { yPercent: constant((-lm.lift * (size / fontSize) * S * 100) / H).keys }, {}, cardOpacity, true);
      }
      if (borderW > 0) {
        // MotionFast strokes a path inset by half the width (the band lies inside the card); a shape's border is
        // centred on its outline: the border shape is the inset card
        const bw = Math.min(borderW, cardW / 2, cardH / 2);
        emit('border', { type: 'shape', shapeType: 'rectangle', shapeSizeUnit: 'px', shapeWidthPx: r6(Math.max(1, (cardW - bw) * S)), shapeHeightPx: r6(Math.max(1, (cardH - bw) * S)),
          shapeFillColor: 'rgba(0,0,0,0)', borderRadius: r6(Math.max(0, Math.min(radius - bw / 2, (cardW - bw) / 2, (cardH - bw) / 2)) * S), borderWidth: r6(bw * S), borderColor: P.borderColor || '#ffffff' }, {}, {}, cardOpacity);
      }
    }

    // where a leave that winds back first (its mirrored curve below 0) still holds the card on the pile
    let hold0 = 0;
    for (let k = 1; k <= 2000; k += 1) { if (exitEase(k / 2000) <= 0) hold0 = k / 2000; else break; }
    // ── per card: its entry, its time on the pile, its leave; painted deepest first (MotionFast's order)
    for (let k = count - 1; k >= 0; k -= 1) {
      const c = cards[k];
      paintIndex = count - 1 - k;
      const t0 = Math.max(0, c.arriveAt);
      const tEnd = c.leaveAt + Tm.leaveDur;
      if (Tm.entryOn && c.settledAt > t0 + 1e-9) emitPhase(c, 'entry', t0, Math.min(c.settledAt, c.leaveAt), 'F');
      const s0 = Math.max(t0, c.settledAt);
      if (c.leaveAt > s0 + 1e-9) emitPhase(c, 'pile', s0, c.leaveAt, 'S');
      const x0 = Math.max(s0, c.leaveAt), xh = c.leaveAt + hold0 * Tm.leaveDur;
      if (hold0 > 0 && xh > x0 + 1e-9) emitPhase(c, 'hold', x0, xh, 'X', true);
      if (tEnd > Math.max(x0, xh) + 1e-9) emitPhase(c, 'leave', Math.max(x0, xh), tEnd, 'X');
    }
    if (cards.some((c) => c.label) && !/^\s*['"]?Inter\b/i.test(family)) warnings.push('Labels are fitted and centred by Inter\'s measures: another font may sit a little off.');
    if (M && media.some((x) => x.type === 'video')) warnings.push('A video on a card plays once (no loop yet).');
    const ordered = layers.map((ly, j) => [ly, j]).sort((a, b) => a[0].ord[0] - b[0].ord[0] || a[0].ord[1] - b[0].ord[1] || a[1] - b[1])
      .map(([ly]) => { const { ord, ...rest } = ly; return rest; });
    if (estimated) warnings.push('No text metrics from the host: the labels are sized from an estimate (0.55 em a letter).');
    return { duration: D, layers: ordered, warnings };
  },
};
