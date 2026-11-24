// Tumble (MotionFast `tumble`): picture cards drop one by one onto a loose pile, each landing with a dip and a spring
// back, then the whole pile leaves (falls away, lifts off, slides, explodes, peels, collapses). Cards fly in from any
// side, can flutter or spin in; the pile's spread, scatter, staircase and tilt are options. Start / End on full frame
// zoom between one card filling the frame and the pile.
//
// Built from ordinary layers: one picture layer per card (bottom to top in drop order), its place, turn and size on
// keys. Every piece of the motion is a curve the editor's keys draw exactly: the reel's decoded drop is a straight
// line between its 22 tracked frames, an easing drop is two keys with that easing, the tilt settling and the spin
// unwinding are cubics in time (a Custom bezier per piece), the exits are the reel's fall (straight lines) or cubics
// (explode, peel, collapse). Only what no key curve can draw is a ƒx expression: the flutter's sway (a sine of the
// distance still to fall), a scale that collapses to 0, and the full-frame hero: the sequence's own camera zooms
// (camZoom = Z0^(1−e), its pan follows) and the hero card's mask grows from the frame to the card, both read from one
// key track that holds the hero's progress e with the zoom easing.
//
// A built-in script (PLANS/ESSENTIAL_TEMPLATES.md §14): it imports nothing, so this same text also runs as a
// `kind: "script"` source. Numbers and timing are MotionFast's (motionTemplates/tumble.js).
const REF_H = 1080;
const D2R = Math.PI / 180;
const PLATES = ['#1d9bf1', '#f9492d', '#ffffff', '#33efab'];
const CARD_SHAPES = { '1:1': 1, '4:5': 4 / 5, '3:4': 3 / 4, '9:16': 9 / 16, '4:3': 4 / 3, '16:9': 16 / 9 };
// the decoded reel (MotionFast's REF): world px of a 1080-tall frame, keys at 30 fps
const REF = {
  card: 738, radius: 34, start: 950, fallDist: 1250, tilt: 1.6,
  beat: 0.5103, intro: 0.204 - 5.5 / 30, dropTime: 22.77 / 30, hold: 1.977 + 5.5 / 30 - 22.77 / 30, exitTime: 1.2,
  tail: 7 - (0.204 + 7 * 0.5103 + 1.977 + 1.2),
  uI: (1.27 + 5.9 / 65.2 + 5.5) / 22.77,
  x: [-1.1, 4.9, -13, 17.5, -25.1, 29.3, -37.8, 41.1],
  rz: [-3, 1.95, -1.4, 2.5, -3, 1.9, -1.5, 2.5],
  drop: [[-5.5, -950], [-3.73, -640.6], [-2.73, -464.5], [-1.73, -317.9], [-0.73, -195.3], [0.27, -90.3], [1.27, -5.9],
    [2.27, 59.3], [3.27, 108], [4.27, 142.2], [5.27, 163.3], [6.77, 172.5], [8.27, 163.9], [9.27, 148.7], [10.27, 128.9],
    [11.27, 105.7], [12.27, 81.8], [13.27, 58], [14.27, 35.9], [15.27, 17.3], [16.27, 4.6], [17.27, -0.8]],
  fall: [[0, 0], [4, 3], [8, 7], [12, 15], [16, 31.4], [20, 67.3], [24, 139.6], [28, 292.7], [32, 606], [36, 1250]],
};
REF.settle0 = (1.5 / 22.77) / REF.uI;
REF.settleW = (8 / 22.77) / REF.uI;
const FROM = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
const EXIT_VEC = { fall: [0, 1], lift: [0, -1], slideLeft: [-1, 0], slideRight: [1, 0] };
const EXITS = ['fall', 'lift', 'slideLeft', 'slideRight', 'explode', 'peel', 'shrink', 'none'];

// MotionFast's easings (motionTemplates/mtl.js getEase): the curve itself, and the editor's key easing that draws it
// exactly (the same bezier or the same named curve), or null: keyed by samples
const BEZ = (b) => ({ easing: 'Custom', bezier: b.map((v) => Math.round(v * 1e4) / 1e4) });
const TABLE = (s) => s.split(',').map(Number);
const T_ELASTIC = TABLE('0,.0221,.0739,.1485,.2394,.3402,.4458,.5517,.6541,.7502,.8375,.9149,.9813,1.0364,1.0803,1.1136,1.1369,1.1513,1.1579,1.1578,1.1522,1.1424,1.1294,1.1142,1.0978,1.081,1.0643,1.0485,1.0338,1.0205,1.009,.9992,.9912,.9849,.9803,.9772,.9754,.9748,.9752,.9764,.9782,.9804,.9829,.9856,.9882,.9908,.9933,.9955,.9975,.9992,1.0007,1.0018,1.0027,1.0034,1.0038,1.004,1.004,1.0039,1.0036,1.0033,1.0029,1.0025,1.0021,1.0017,1.0013,1.0009,1.0006,1.0003,1,.9998,.9996,.9995,.9994,.9994,.9994,.9994,.9994,.9994,.9995,.9996,.9996,.9997,.9998,.9998,.9999,.9999,1,1,1,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1');
const T_OVERSHOOT = TABLE('0,.1739,.3067,.4183,.515,.6,.6755,.743,.8034,.8576,.9063,.95,.9891,1.0241,1.0551,1.0825,1.1066,1.1275,1.1455,1.1606,1.1731,1.183,1.1906,1.1959,1.199,1.2,1.1997,1.1988,1.1972,1.195,1.1921,1.1886,1.1846,1.18,1.1749,1.1695,1.1638,1.1579,1.1519,1.1458,1.1397,1.1337,1.1277,1.1219,1.1162,1.1107,1.1053,1.1002,1.0952,1.0904,1.0857,1.0813,1.077,1.0729,1.0689,1.0651,1.0615,1.058,1.0547,1.0515,1.0484,1.0455,1.0427,1.0401,1.0375,1.0351,1.0327,1.0305,1.0284,1.0264,1.0244,1.0226,1.0209,1.0192,1.0176,1.0162,1.0148,1.0134,1.0122,1.011,1.0099,1.0088,1.0079,1.007,1.0061,1.0053,1.0046,1.0039,1.0033,1.0028,1.0023,1.0018,1.0014,1.0011,1.0008,1.0005,1.0003,1.0002,1.0001,1,1');
const T_IMPULSE = TABLE('0,-.0006,-.0023,-.005,-.0086,-.0131,-.0183,-.0243,-.0308,-.038,-.0456,-.0537,-.0622,-.071,-.0801,-.0894,-.0988,-.1084,-.1179,-.1275,-.1369,-.1461,-.1551,-.1636,-.1717,-.1791,-.1858,-.1915,-.1959,-.1989,-.2,-.1986,-.1944,-.187,-.1762,-.1616,-.1432,-.1206,-.0939,-.0632,-.0289,.0087,.0487,.0906,.1334,.1765,.2193,.2613,.3022,.3416,.3794,.4156,.4501,.483,.5142,.5438,.5719,.5986,.6239,.6478,.6705,.692,.7124,.7317,.75,.7673,.7837,.7993,.814,.8279,.841,.8535,.8652,.8763,.8868,.8967,.9059,.9147,.9229,.9305,.9377,.9444,.9507,.9565,.9619,.9669,.9714,.9756,.9794,.9829,.986,.9888,.9912,.9933,.9952,.9967,.9979,.9988,.9995,.9999,1');
const T_SWING = TABLE('0,-.0013,-.0052,-.0115,-.0199,-.0302,-.0421,-.0554,-.0697,-.0847,-.1,-.1153,-.1303,-.1446,-.1579,-.1698,-.1801,-.1885,-.1948,-.1987,-.2,-.1986,-.1942,-.1863,-.1744,-.1578,-.136,-.1079,-.0725,-.0288,.0241,.087,.1594,.2396,.3241,.4088,.4899,.5651,.6332,.6941,.7482,.796,.8384,.8758,.9088,.9379,.9636,.9863,1.0061,1.0235,1.0386,1.0517,1.0628,1.0723,1.0801,1.0865,1.0916,1.0954,1.098,1.0995,1.1,1.0997,1.0987,1.097,1.0947,1.0919,1.0885,1.0847,1.0806,1.0762,1.0717,1.0671,1.0624,1.0578,1.0533,1.0489,1.0447,1.0406,1.0368,1.0332,1.0297,1.0265,1.0235,1.0207,1.0181,1.0157,1.0135,1.0115,1.0097,1.008,1.0065,1.0052,1.0041,1.0031,1.0022,1.0015,1.001,1.0005,1.0002,1.0001,1');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clamp01 = (v) => clamp(v, 0, 1);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
function bezierCurve(p1x, p1y, p2x, p2y) {   // MotionFast's solver (easingEngine.bezierEase): the same numbers
  const bx = (t) => 3 * p1x * t * (1 - t) * (1 - t) + 3 * p2x * t * t * (1 - t) + t * t * t;
  const by = (t) => 3 * p1y * t * (1 - t) * (1 - t) + 3 * p2y * t * t * (1 - t) + t * t * t;
  return (x) => {
    x = clamp01(x);
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 24; i += 1) { const cx = bx(t); if (Math.abs(cx - x) < 1e-4) break; if (cx < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return by(t);
  };
}
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
const EASES = {
  smooth: [bezierCurve(0.5, 0, 0, 1), BEZ([0.5, 0, 0, 1])],
  power2: [powOut(3), { easing: 'Ease Out' }],
  power3: [powOut(4), { easing: 'Cubic Out' }],
  power4: [powOut(5), { easing: 'Power' }],
  back: [(t) => { t = clamp01(t); return 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2); }, { easing: 'Back Out' }],
  bounce: [bounceOut, { easing: 'Bounce Out' }],
  expo: [(t) => { t = clamp01(t); return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); }, null],
  natural: [bezierCurve(0.8, 0, 0.2, 1), { easing: 'Natural' }],
  slowDown: [bezierCurve(0, 0, 0, 1), { easing: 'Slow Down' }],
  elastic: [sampled(T_ELASTIC), null],
  overshoot: [sampled(T_OVERSHOOT), { easing: 'Overshoot' }],
  impulse: [sampled(T_IMPULSE), { easing: 'Impulse' }],
  swing: [sampled(T_SWING), { easing: 'Swing' }],
  aeIn: [bezierCurve(0.3141666673, 0, 0.0875000209, 1), { easing: 'AE In (arrive)' }],
  aeSmooth: [bezierCurve(0.882083327, 0, 0.2445833683, 1), { easing: 'AE Smooth' }],
  aeOut: [bezierCurve(0.8699999754, 0, 0.6433336333, 1), { easing: 'AE Out (leave)' }],
};
const easeOf = (name) => EASES[name] || EASES.smooth;
const EASE_OPTIONS = [['smooth', 'Smooth'], ['power2', 'Power 2'], ['power3', 'Power 3'], ['power4', 'Power 4'], ['back', 'Back'],
  ['bounce', 'Bounce'], ['expo', 'Expo'], ['natural', 'Natural'], ['slowDown', 'Slow Down'], ['elastic', 'Elastic'],
  ['overshoot', 'Overshoot'], ['impulse', 'Impulse'], ['swing', 'Swing'], ['aeIn', 'AE In'], ['aeSmooth', 'AE Smooth'], ['aeOut', 'AE Out']]
  .map(([value, label]) => ({ value, label }));

// Looks: picking one sets every drop / pile / card / exit / hero option (MotionFast's LOOK_DEFS)
const DEFAULTS = { direction: 'top', cardCount: 8, beat: REF.beat, dropTime: REF.dropTime, dropEase: 'reference', bounce: 100, flutter: 0,
  spin: 0, spread: 100, scatter: 0, stepX: 0, stepY: 0, tilt: 100, seed: 1, cardSize: 100, cardShape: '1:1', radius: 34, exit: 'fall',
  holdTime: REF.hold, exitTime: REF.exitTime, startHero: false, endHero: false, heroHold: 0.8, heroTime: 1.8, heroEase: 'natural' };
const LOOKS = [
  ['tumble', 'Tumble', {}],
  ['side-swipe', 'Side Swipe', { direction: 'sides', beat: 0.42, dropTime: 0.62, bounce: 70, tilt: 220, spread: 300, cardSize: 78, cardShape: '4:5', exit: 'slideRight', holdTime: 0.9, exitTime: 0.9 }],
  ['scatter-burst', 'Scatter Burst', { direction: 'around', cardCount: 11, beat: 0.3, dropTime: 0.7, dropEase: 'expo', bounce: 0, spin: 220, scatter: 190, spread: 0, tilt: 350, cardSize: 52, radius: 26, exit: 'explode', holdTime: 1.0, exitTime: 1.1 }],
  ['cascade', 'Cascade', { direction: 'top', cardCount: 9, beat: 0.34, dropTime: 0.6, bounce: 55, spread: 0, stepX: 8.5, stepY: 4.5, tilt: 60, cardSize: 56, cardShape: '3:4', radius: 22, exit: 'peel', holdTime: 0.8, exitTime: 1.4 }],
  ['hero-finale', 'Hero Finale', { endHero: true, holdTime: 0.5, heroTime: 1.6, heroHold: 1.0 }],
].map(([value, label, over]) => ({ value, label, params: { ...DEFAULTS, ...over } }));

const fields = [
  { type: 'group', key: 'gMedia', label: 'Media' },
  { key: 'media', type: 'media', label: 'Images / videos', slots: { from: 'media', max: 24 }, accept: 'media', ifFewer: 'reuse' },
  { key: 'fillEmpty', type: 'switch', label: 'Repeat media', default: true },
  { type: 'group', key: 'gPlates', label: 'Placeholders' },
  { key: 'color1', type: 'color', label: 'Fill 1', default: PLATES[0] },
  { key: 'color2', type: 'color', label: 'Fill 2', default: PLATES[1] },
  { key: 'color3', type: 'color', label: 'Fill 3', default: PLATES[2] },
  { key: 'color4', type: 'color', label: 'Fill 4', default: PLATES[3] },
  { type: 'group', key: 'gDrop', label: 'Drop' },
  { key: 'look', type: 'select', label: 'Look', default: 'tumble', options: LOOKS },
  { key: 'direction', type: 'select', label: 'From', default: 'top', options: [
    { value: 'top', label: 'Top' }, { value: 'bottom', label: 'Below' }, { value: 'left', label: 'Left' },
    { value: 'right', label: 'Right' }, { value: 'sides', label: 'Sides' }, { value: 'around', label: 'Around' },
  ] },
  { key: 'cardCount', type: 'range', label: 'Cards', default: 8, min: 2, max: 24, step: 1, integer: true },
  { key: 'beat', type: 'range', label: 'Beat', default: REF.beat, min: 0.15, max: 2, step: 0.01, suffix: 's' },
  { key: 'dropTime', type: 'range', label: 'Drop time', default: REF.dropTime, min: 0.25, max: 3, step: 0.01, suffix: 's' },
  { key: 'dropEase', type: 'select', label: 'Landing', default: 'reference', options: [{ value: 'reference', label: 'Dip + spring back (reel)' }, ...EASE_OPTIONS] },
  { key: 'bounce', type: 'range', label: 'Dip / bounce', default: 100, min: 0, max: 300, step: 1, suffix: '%' },
  { key: 'flutter', type: 'range', label: 'Flutter', default: 0, min: 0, max: 200, step: 1, suffix: '%' },
  { key: 'spin', type: 'range', label: 'Spin in', default: 0, min: -720, max: 720, step: 1, suffix: '°' },
  { type: 'group', key: 'gPile', label: 'Pile' },
  { key: 'spread', type: 'range', label: 'Spread', default: 100, min: 0, max: 400, step: 1, suffix: '%' },
  { key: 'scatter', type: 'range', label: 'Scatter', default: 0, min: 0, max: 400, step: 1, suffix: '%' },
  { key: 'stepX', type: 'range', label: 'Step →', default: 0, min: -60, max: 60, step: 0.5, suffix: '%' },
  { key: 'stepY', type: 'range', label: 'Step ↓', default: 0, min: -60, max: 60, step: 0.5, suffix: '%' },
  { key: 'tilt', type: 'range', label: 'Tilt', default: 100, min: 0, max: 600, step: 1, suffix: '%' },
  { key: 'seed', type: 'range', label: 'Shuffle', default: 1, min: 1, max: 99, step: 1, integer: true },
  { type: 'group', key: 'gCards', label: 'Cards' },
  { key: 'cardSize', type: 'range', label: 'Card size', default: 100, min: 30, max: 200, step: 1, suffix: '%' },
  { key: 'cardShape', type: 'select', label: 'Card shape', default: '1:1', options: [
    { value: '1:1', label: 'Square (reel)' }, { value: '4:5', label: '4:5 portrait' }, { value: '3:4', label: '3:4 portrait' },
    { value: '9:16', label: '9:16 portrait' }, { value: '4:3', label: '4:3 landscape' }, { value: '16:9', label: '16:9 landscape' },
  ] },
  { key: 'radius', type: 'range', label: 'Corner radius', default: 34, min: 0, max: 300, step: 1, suffix: 'px' },
  { type: 'group', key: 'gExit', label: 'Exit' },
  { key: 'exit', type: 'select', label: 'Pile leaves', default: 'fall', showIf: { key: 'endHero', equals: false }, options: [
    { value: 'fall', label: 'Falls away (reel)' }, { value: 'lift', label: 'Lifts off the top' },
    { value: 'slideLeft', label: 'Slides off left' }, { value: 'slideRight', label: 'Slides off right' },
    { value: 'explode', label: 'Explodes outward' }, { value: 'peel', label: 'Peels off, top card first' },
    { value: 'shrink', label: 'Collapses to the centre' }, { value: 'none', label: 'Stays (clip ends)' },
  ] },
  { key: 'holdTime', type: 'range', label: 'Pile hold', default: REF.hold, min: 0, max: 5, step: 0.01, suffix: 's' },
  { key: 'exitTime', type: 'range', label: 'Exit time', default: REF.exitTime, min: 0.2, max: 4, step: 0.01, suffix: 's', showIf: { key: 'exit', notEquals: 'none' } },
  { type: 'group', key: 'gHero', label: 'Hero' },
  { key: 'startHero', type: 'switch', label: 'Start from full frame', default: false },
  { key: 'endHero', type: 'switch', label: 'End on full frame', default: false },
  { key: 'heroHold', type: 'range', label: 'Full-frame hold', default: 0.8, min: 0, max: 5, step: 0.05, suffix: 's' },
  { key: 'heroTime', type: 'range', label: 'Zoom time', default: 1.8, min: 0.3, max: 5, step: 0.05, suffix: 's' },
  { key: 'heroEase', type: 'select', label: 'Zoom easing', default: 'natural', options: EASE_OPTIONS },
];

const r6 = (v) => { const x = Math.round(v * 1e6) / 1e6; return Object.is(x, -0) ? 0 : x; };
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const n = (v) => { const x = Number(v); return Math.abs(x) < 1e-12 ? '0' : String(Number(x.toPrecision(10))); };
function hash01(a, b) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function keysAt(keys, f) {
  const last = keys.length - 1;
  if (f <= keys[0][0]) return keys[0][1];
  if (f >= keys[last][0]) return keys[last][1];
  let k = 1;
  while (keys[k][0] < f) k += 1;
  const a = keys[k - 1], b = keys[k];
  return a[1] + (b[1] - a[1]) * (f - a[0]) / (b[0] - a[0]);
}
const refDrop = (u) => keysAt(REF.drop, -5.5 + clamp01(u) * 22.77);
const refFall = (q) => keysAt(REF.fall, clamp01(q) * 36) / REF.fallDist;
function halfExt(w, h, rz) {
  const c = Math.abs(Math.cos(rz * D2R)), s = Math.abs(Math.sin(rz * D2R));
  return [0.5 * (w * c + h * s), 0.5 * (w * s + h * c)];
}
function exitDist(px, py, v, W, H, ex, ey) {
  let best = Infinity;
  if (Math.abs(v[0]) > 1e-6) best = Math.min(best, (W / 2 + ex - Math.sign(v[0]) * px) / Math.abs(v[0]));
  if (Math.abs(v[1]) > 1e-6) best = Math.min(best, (H / 2 + ey - Math.sign(v[1]) * py) / Math.abs(v[1]));
  return Math.max(0, best);
}
function impactOf(ease) { for (let k = 1; k <= 400; k += 1) if (ease(k / 400) >= 0.999) return k / 400; return 1; }

// MotionFast's clip: cards drop from `first`, one per beat; the pile leaves at te (or the camera pushes in)
function timeline(S) {
  const N = Math.max(1, Math.round(clamp(num(S.cardCount, 8), 1, 60)));
  const beat = Math.max(0.05, num(S.beat, REF.beat));
  const dropTime = Math.max(0.1, num(S.dropTime, REF.dropTime));
  const hold = Math.max(0, num(S.holdTime, REF.hold));
  const exitTime = Math.max(0.1, num(S.exitTime, REF.exitTime));
  const hh = Math.max(0, num(S.heroHold, 0.8)), ht = Math.max(0.05, num(S.heroTime, 1.8));
  const start = !!S.startHero, end = !!S.endHero;
  const first = start ? hh + 0.7 * ht - beat : REF.intro;
  const te = first + (N - 1) * beat + dropTime + hold;
  const exit = end ? 'none' : (EXITS.includes(S.exit) ? S.exit : 'fall');
  const D = end ? te + ht + hh : exit === 'none' ? te : te + exitTime + REF.tail;
  return { N, beat, dropTime, hold, exitTime, hh, ht, start, end, first, te, exit, D: Math.max(0.5, D) };
}

// ── keys ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// A track is built from pieces [t0, t1, how] of one value function f(t): 'line' (straight), 'cubic' (f is a cubic in
// t there: drawn by a Custom bezier whose x handles sit at 1/3 and 2/3, so the bezier IS that cubic), an easing name
// (f runs between its ends on that MotionFast easing: the editor's same curve, or samples), or 'samples' (f at 30
// points, straight between). Keys are placed in % of a layer [fs, fs + span].
function cubicEase(y0, y1, y2, y3) {
  // the bezier through the cubic's values at 0, 1/3, 2/3, 1 (x handles at 1/3, 2/3: x(s) = s)
  const d = y3 - y0;
  const b1 = (18 * y1 - 9 * y2 - 5 * y0 + 2 * y3) / 6, b2 = (18 * y2 - 9 * y1 - 5 * y3 + 2 * y0) / 6;
  const scale = Math.max(Math.abs(y0), Math.abs(y3), Math.abs(b1), Math.abs(b2), 1e-9);
  if (Math.abs(b1 - (y0 + d / 3)) < 1e-9 * scale && Math.abs(b2 - (y0 + 2 * d / 3)) < 1e-9 * scale) return { easing: 'Linear' };
  if (Math.abs(d) < 1e-6 * scale) return null;
  const p1 = (b1 - y0) / d, p2 = (b2 - y0) / d;
  if (!(p1 >= -3 && p1 <= 4 && p2 >= -3 && p2 <= 4)) return null;
  return { easing: 'Custom', bezier: [0.3333, Math.round(p1 * 1e4) / 1e4, 0.6667, Math.round(p2 * 1e4) / 1e4] };
}
function trackKeys(f, pieces, fs, span) {
  const pos = (t) => r6(clamp(((t - fs) / span) * 100, 0, 100));
  const out = [];
  const push = (t, ease) => out.push({ position: pos(t), value: f(t), ...(ease || { easing: 'Linear' }) });
  const add = (t0, t1, how, depth = 0) => {
    if (t1 - t0 < 1e-7) return;
    if (how === 'line') { push(t0); return; }
    if (how === 'cubic') {
      const e = cubicEase(f(t0), f(t0 + (t1 - t0) / 3), f(t0 + (2 * (t1 - t0)) / 3), f(t1));
      if (e) { push(t0, e); return; }
      if (depth < 3) { const m = (t0 + t1) / 2; add(t0, m, how, depth + 1); add(m, t1, how, depth + 1); return; }
      how = 'samples';
    }
    if (how !== 'samples') {
      const ease = easeOf(how)[1];
      if (ease) { push(t0, ease); return; }
      // expo / elastic: no key curve in the editor; samples, denser where the curve bends (as orbit.js)
      const count = how === 'elastic' ? 100 : 96;
      for (let j = 0; j < count; j += 1) push(t0 + (how === 'elastic' ? j / count : Math.pow(j / count, 1.6)) * (t1 - t0));
      return;
    }
    for (let j = 0; j < 30; j += 1) push(t0 + (j / 30) * (t1 - t0));
  };
  const list = pieces.filter((p) => p[1] - p[0] > 1e-7).sort((a, b) => a[0] - b[0]);
  list.forEach(([t0, t1, how], k) => {
    add(t0, t1, how);
    // a gap before the next piece: the value holds (a key where this piece ends)
    if (k + 1 < list.length && list[k + 1][0] - t1 > 1e-7) push(t1);
  });
  if (list.length) push(list[list.length - 1][1]);
  else push(fs);
  // drop keys that change nothing (a straight key between two equal ones)
  const same = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  const keep = out.filter((k, i) => i === 0 || i === out.length - 1 || !(same(out[i - 1].value, k.value) && same(k.value, out[i + 1].value) && out[i - 1].easing === 'Linear' && k.easing === 'Linear'));
  const dedup = keep.filter((k, i) => i === 0 || k.position > keep[i - 1].position);
  if (dedup.every((k) => same(k.value, dedup[0].value))) return [{ position: 0, value: n(dedup[0].value), easing: 'Linear' }];
  return dedup.map((k) => ({ ...k, value: n(k.value) }));
}
// eight points of a rounded rectangle in the mask's unit box (−0.5 … 0.5), corner rx / ry as shares of its sides
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

export default {
  id: 'tumble',
  name: 'Tumble',
  category: 'Carousels',
  v: 1,
  fields,
  build({ settings: S, media, frame }) {
    const { W: FW, H: FH } = frame;
    const tl = timeline(S);
    const { N, beat, dropTime: dT, start, end, first, te, exit, hh, ht } = tl;
    const D = tl.D;
    const Sx = FH / REF_H, W = FW / Sx, H = REF_H;               // world px: a 1080-tall frame
    const aspect = CARD_SHAPES[S.cardShape] || 1;
    const fit = Math.min(1, 0.88 * W / (REF.card * Math.sqrt(aspect)), 0.92 * H / (REF.card / Math.sqrt(aspect)));
    const sizeK = Math.max(0.05, num(S.cardSize, 100) / 100) * fit;
    const A = REF.card * sizeK, w = A * Math.sqrt(aspect), h = A / Math.sqrt(aspect);
    const spread = num(S.spread, 100) / 100, scatter = Math.max(0, num(S.scatter, 0)) / 100;
    const stepX = num(S.stepX, 0) / 100, stepY = num(S.stepY, 0) / 100;
    const tiltK = Math.max(0, num(S.tilt, 100)) / 100, spin = num(S.spin, 0);
    const bounceK = Math.max(0, num(S.bounce, 100)) / 100, flutter = Math.max(0, num(S.flutter, 0)) / 100;
    const radius = Math.max(0, num(S.radius, REF.radius)) * sizeK;
    const R0 = 0.5 * Math.hypot(w, h);
    const seed = Math.max(1, Math.round(num(S.seed, 1)));
    const direction = (FROM[S.direction] || S.direction === 'sides' || S.direction === 'around') ? S.direction : 'top';
    const easeName = S.dropEase && S.dropEase !== 'reference' ? (EASES[S.dropEase] ? S.dropEase : 'smooth') : null;
    const ease = easeName ? easeOf(easeName)[0] : null;
    const uI = ease ? impactOf(ease) : REF.uI;
    const M = media.length, fill = S.fillEmpty !== false;
    const warnings = [];
    // layer times: the host keeps a layer's start and length to 1/10000 s. A layer starts at or just BEFORE its first
    // key (rounded down), so no key falls before it (it would be pulled to the start); the template's end is the host's
    const at4 = (t) => (Math.abs(t - D) < 1e-9 ? r4(D) : Math.floor(t * 1e4 + 1e-7) / 1e4);

    // the cards (MotionFast buildPlan) and their rest in the pile
    const cards = [];
    for (let i = 0; i < N; i += 1) {
      const R = (k) => hash01(i, seed * 131 + k);
      const alt = i % 2 ? 1 : -1;
      const ang = (i * 2.399963 + (seed === 1 ? 0.6 : R(4) * 6.283)) % 6.283185;
      const from = direction === 'sides' ? (i % 2 ? [1, 0] : [-1, 0]) : direction === 'around' ? [Math.cos(ang), Math.sin(ang)] : FROM[direction];
      const c = {
        i, from, sg: alt, sx: R(5) * 2 - 1, sy: R(6) * 2 - 1, sr: R(7) * 2 - 1, ph: R(8) * 6.283, sg2: R(9) < 0.5 ? -1 : 1, burst: R(10) * 6.283,
        bx: seed === 1 && i < REF.x.length ? REF.x[i] : alt * 5.8 * i * (seed === 1 ? 1 : 0.6 + 0.8 * R(1)),
        rz0: seed === 1 ? REF.rz[i % REF.rz.length] : alt * (1.4 + 1.6 * R(2)),
      };
      const k = i - (N - 1) / 2;
      c.rest = {
        x: (c.bx * spread + c.sx * scatter * 0.3 * REF.card + stepX * REF.card * k) * sizeK,
        y: (c.sy * scatter * 0.22 * REF.card + stepY * REF.card * k) * sizeK,
        rz: c.rz0 * tiltK + c.sr * scatter * 8,
      };
      c.t0 = start && i === 0 ? null : first + i * beat;          // its drop starts (a start hero lies there from frame 0)
      const [ex, ey] = spin || flutter ? [R0, R0] : halfExt(w, h, c.rest.rz * REF.tilt);
      c.dist = Math.max(REF.start * sizeK, exitDist(c.rest.x, c.rest.y, from, W, H, ex, ey) + 4);
      cards.push(c);
    }
    // the rigid exits move the whole pile by one distance, enough for its farthest card
    let pileDist = 0;
    if (EXIT_VEC[exit]) {
      let need = 0;
      for (const c of cards) { const [ex, ey] = halfExt(w, h, c.rest.rz); need = Math.max(need, exitDist(c.rest.x, c.rest.y, EXIT_VEC[exit], W, H, ex, ey)); }
      pileDist = Math.max(REF.fallDist * sizeK, need + 4);
    }

    // along the flight (+ = past the rest): MotionFast layoutCards
    const alongOf = (c, uc) => {
      if (ease) { const a = -(1 - ease(uc)) * c.dist; return uc > uI ? a * bounceK : a; }
      const a = refDrop(uc);
      return uc < uI ? (a * c.dist) / REF.start : a * bounceK * sizeK;
    };
    const tiltIn = (uc) => REF.tilt + (1 - REF.tilt) * clamp01((uc - REF.settle0 * uI) / (REF.settleW * uI));
    // a card's pose at time t, world px about the frame centre (no flutter: see the flutter layers), before the camera
    const poseAt = (c, t) => {
      let x = c.rest.x, y = c.rest.y, rz = c.rest.rz, s = 1;
      if (c.t0 !== null) {
        const uc = clamp01((t - c.t0) / dT), pI = clamp01(uc / uI);
        rz = c.rest.rz * tiltIn(uc) + spin * c.sg * Math.pow(1 - pI, 3);
        const along = alongOf(c, uc);
        x -= c.from[0] * along; y -= c.from[1] * along;
      }
      const qx = t > te && exit !== 'none' ? clamp01((t - te) / tl.exitTime) : 0;
      if (qx > 0 && EXIT_VEC[exit]) {
        const d = pileDist * refFall(qx);
        x += EXIT_VEC[exit][0] * d; y += EXIT_VEC[exit][1] * d;
      } else if (qx > 0 && exit === 'explode') {
        const qi = clamp01((qx - (N > 1 ? ((N - 1 - c.i) / (N - 1)) * 0.3 : 0)) / 0.7);
        if (qi > 0) {
          const E = 1 - (1 - qi) * (1 - qi);
          x += c.burstV[0] * E; y += c.burstV[1] * E;
          rz += c.sg2 * (110 + Math.abs(spin)) * E; s *= 1 + 0.18 * E;
        }
      } else if (t > te && exit === 'peel') {
        const qi = clamp01((t - c.peelAt) / (tl.exitTime * 0.4));
        if (qi > 0) {
          const E = qi * qi * (2.2 * qi - 1.2);
          x += c.peelV[0] * E; y += c.peelV[1] * E; rz += c.sg * 14 * Math.max(0, E);
        }
      } else if (qx > 0 && exit === 'shrink') {
        s = Math.max(0, 1 - qx * qx * (2.70158 * qx - 1.70158));
        x *= s; y *= s;
      }
      return { x, y, rz, s };
    };
    // where each card has landed (the exits read it): the drop's last value
    for (const c of cards) {
      const p = poseAt(c, Math.min(te, c.t0 === null ? 0 : c.t0 + dT));
      if (exit === 'explode') {
        let dx = c.rest.x / w * 1.5 + Math.cos(c.burst), dy = c.rest.y / h * 1.5 + Math.sin(c.burst);
        const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
        const need = exitDist(p.x, p.y, [dx, dy], W, H, R0 * 1.2, R0 * 1.2) + 4;
        c.burstV = [dx * need * 1.15, dy * need * 1.15];
        c.burstAt = te + (N > 1 ? ((N - 1 - c.i) / (N - 1)) * 0.3 : 0) * tl.exitTime;
      }
      if (exit === 'peel') {
        const need = exitDist(p.x, p.y, c.from, W, H, R0, R0) + 4;
        c.peelV = [c.from[0] * need, c.from[1] * need];
        c.peelAt = te + (N > 1 ? ((N - 1 - c.i) / (N - 1)) * tl.exitTime * 0.6 : 0);
      }
    }

    // the pieces of each track over [from, to): the drop (u from 0), the rest, the exit
    const dropPieces = (c, which) => {
      const out = [];
      if (c.t0 === null) return out;
      const at = (u) => c.t0 + u * dT;
      if (which === 'rz') {
        // the entry tilt settles (straight) and the spin unwinds ((1 − p)³): a cubic in t between these points
        const knots = [0, REF.settle0 * uI, (REF.settle0 + REF.settleW) * uI, uI, 1].map((u) => clamp01(u)).sort((a, b) => a - b);
        for (let k = 0; k + 1 < knots.length; k += 1) out.push([at(knots[k]), at(knots[k + 1]), spin ? 'cubic' : 'line']);
        return out;
      }
      if (!ease) {
        // the reel's decoded drop: straight between its tracked frames, and through the landing (where the dip scale starts)
        const us = [...REF.drop.map(([f]) => (f + 5.5) / 22.77), uI].sort((a, b) => a - b);
        for (let k = 0; k + 1 < us.length; k += 1) out.push([at(us[k]), at(us[k + 1]), 'line']);
        return out;
      }
      // an easing: its curve from the start to the rest; past the impact a dip scaled by Dip / bounce (samples then)
      // (an easing the editor draws, with a scaled dip, is a flight layer: flightLayer)
      if (bounceK === 1 || uI >= 1) out.push([at(0), at(1), easeName]);
      else { out.push([at(0), at(uI), easeName]); out.push([at(uI), at(1), easeName]); }
      return out;
    };
    const exitPieces = (c, which) => {
      const out = [];
      if (exit === 'none') return out;
      if (EXIT_VEC[exit]) {
        if ((which === 'x' && EXIT_VEC[exit][0]) || (which === 'y' && EXIT_VEC[exit][1])) {
          for (let k = 0; k + 1 < REF.fall.length; k += 1) out.push([te + (REF.fall[k][0] / 36) * tl.exitTime, te + (REF.fall[k + 1][0] / 36) * tl.exitTime, 'line']);
        }
        return out;
      }
      if (exit === 'explode') { out.push([c.burstAt, c.burstAt + 0.7 * tl.exitTime, 'cubic']); return out; }
      if (exit === 'peel') {
        const t1 = c.peelAt + tl.exitTime * 0.4;
        if (which === 'rz') out.push([c.peelAt + (1.2 / 2.2) * tl.exitTime * 0.4, t1, 'cubic']);
        else if (which !== 's') out.push([c.peelAt, t1, 'cubic']);
        return out;
      }
      if (exit === 'shrink' && which !== 'rz') out.push([te, te + tl.exitTime, 'cubic']);
      return out;
    };

    const layers = [];
    const pictureOf = (c) => {
      const m = M && (fill || c.i < M) ? c.i % M : -1;
      const box = { w: r6(w * Sx), h: r6(h * Sx), fit: 'cover', radius: r6(radius * Sx) };
      const plate = S[`color${(c.i % 4) + 1}`] || PLATES[c.i % 4];
      const plateSrc = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(box.w)}" height="${Math.round(box.h)}"><rect width="100%" height="100%" fill="${plate}"/></svg>`)}`;
      const pic = m >= 0 ? { type: media[m].type === 'video' ? 'video' : 'image', media: m } : (M ? { type: 'image', src: plateSrc } : { type: 'image', media: c.i, src: plateSrc });
      // the picture's plate as the host fits it (scriptAssembler fitBox): its pixels shrunk into the frame, or the card's
      const mm = m >= 0 ? media[m] : null;
      // the picture's plate as the renderer draws it (its pixels shrunk into the frame: an example plate is the SVG above,
      // whole px) and the host's cover zoom of the card (scriptAssembler fitBox, which takes an example at the box's size)
      const known = !!(mm && Number(mm.w) > 0 && Number(mm.h) > 0);
      const nw = known ? Number(mm.w) : Math.round(box.w), nh = known ? Number(mm.h) : Math.round(box.h);
      const k = Math.min(1, FW / nw, FH / nh);
      const hw = known ? nw : box.w, hh2 = known ? nh : box.h, hk = Math.min(1, FW / hw, FH / hh2);
      return { pic, box, pw: nw * k, ph: nh * k, z0: Math.max(box.w / (hw * hk), box.h / (hh2 * hk)) };
    };
    const xp = (x) => (x * Sx / FW) * 100, yp = (y) => (y * Sx / FH) * 100;
    // a card layer over [from, to] with its pose keyed (the drop, the rest, the exit)
    const cardLayer = (c, key, from, to, pic) => {
      const fs = at4(from), span = at4(to) - fs;
      const pieces = (which) => [...(from < (c.t0 ?? -1) + dT ? dropPieces(c, which) : []), ...exitPieces(c, which)]
        .filter(([a, b]) => b > from + 1e-9 && a < to - 1e-9).map(([a, b, how]) => [Math.max(a, from), Math.min(b, to), how]);
      const at = (t) => poseAt(c, clamp(t, from, to));
      const tracks = {
        xPercent: trackKeys((t) => xp(at(t).x), pieces('x'), fs, span),
        yPercent: trackKeys((t) => yp(at(t).y), pieces('y'), fs, span),
        rotate: trackKeys((t) => at(t).rz, pieces('rz'), fs, span),
      };
      const fx = {};
      const sp = pieces('s');
      if (exit === 'shrink' && sp.length) {
        // the collapse ends at scale 0 (scale keys stay ≥ 0.1): the keys hold scale + 1, the ƒx takes the 1 off
        tracks.scale = trackKeys((t) => at(t).s + 1, sp, fs, span);
        fx.scale = { type: 'custom', params: { code: 'max(0,value-1)' } };
      } else if (exit === 'explode' && sp.length) tracks.scale = trackKeys((t) => at(t).s, sp, fs, span);
      return { ...pic.pic, key, name: `Card ${c.i + 1}`, box: pic.box, track: `card[${c.i}]`, freeStart: fs, trimEnd: r6(span),
        propertyKeyframes: tracks, ...(Object.keys(fx).length ? { propertyKeyframeFx: fx } : {}) };
    };
    // the flight of a card that flutters (or eases with a scaled dip): its keys hold the DRIVER g of the drop and a ƒx
    // turns it into the place and the turn, the sway a sine of the distance still to fall (MotionFast layoutCards)
    const flightLayer = (c, pic) => {
      const fs = at4(c.t0), span = at4(c.t0 + dT) - fs, off = c.t0 - fs;   // the ƒx's time is the layer's: off = the rounding
      const tI = off + uI * dT;
      // the driver g on the keys: the reel's a/950 (straight between its frames), an easing's progress (its key
      // easing), or for Expo (no key curve) the drop's share u, straight, and the ƒx takes 1 − 2^(−10u)
      const expo = easeName === 'expo';
      const driver = expo ? (t) => clamp01((t - c.t0) / dT) : ease ? (t) => ease(clamp01((t - c.t0) / dT)) : (t) => refDrop(clamp01((t - c.t0) / dT)) / REF.start;
      const keys = trackKeys(driver, expo ? [[c.t0, c.t0 + dT, 'line']] : ease ? [[c.t0, c.t0 + dT, easeName]] : dropPieces(c, 'x'), fs, span);
      const g = expo ? '(value>=1?1:1-pow(2,-10*value))' : 'value';
      // along the flight from g: reference g = a/950 (along = a·dist/950 before the landing, a·bounce·size after);
      // an easing g = ease (along = −(1 − g)·dist, × bounce after the impact)
      const along = ease ? `(-(1-${g})*${n(c.dist)}*(time>${n(tI)}?${n(bounceK)}:1))` : `(value*(time<${n(tI)}?${n(c.dist)}:${n(REF.start * bounceK * sizeK)}))`;
      const ep = ease ? `clamp(${g},0,1)` : 'clamp(1+value,0,1)';
      const fl = flutter > 0;
      const sway = fl ? `(time<${n(tI)}?${n(flutter * 0.32 * w)}*sin(${n(2 * Math.PI * 1.5)}*${ep}+${n(c.ph)})*(1-pow(${ep},4)):0)` : '0';
      const [fx0, fy0] = c.from;
      const xw = `${n(c.rest.x)}-${n(fx0)}*${along}-${n(fy0)}*${sway}`, yw = `${n(c.rest.y)}-${n(fy0)}*${along}+${n(fx0)}*${sway}`;
      const a0 = off + REF.settle0 * uI * dT, aw = REF.settleW * uI * dT;
      const rz = `${n(c.rest.rz)}*(${n(REF.tilt)}+${n(1 - REF.tilt)}*clamp((time-${n(a0)})/${n(aw)},0,1))`
        + (spin ? `+${n(spin * c.sg)}*pow(1-clamp((time-${n(off)})/${n(uI * dT)},0,1),3)` : '')
        + (fl ? `+(time<${n(tI)}?${n(flutter * 18)}*cos(${n(2 * Math.PI * 1.5)}*${ep}+${n(c.ph)})*(1-pow(${ep},4)):0)` : '');
      const code = (e, k) => ({ type: 'custom', params: { code: `(${e})*${n(k)}` } });
      return { ...pic.pic, key: `card[${c.i}].drop`, name: `Card ${c.i + 1} (drop)`, box: pic.box, track: `card[${c.i}]`, freeStart: fs, trimEnd: r6(span),
        propertyKeyframes: { xPercent: keys, yPercent: keys.map((k) => ({ ...k })), rotate: keys.map((k) => ({ ...k })) },
        propertyKeyframeFx: { xPercent: code(xw, (Sx / FW) * 100), yPercent: code(yw, (Sx / FH) * 100), rotate: code(rz, 1) } };
    };

    // the full-frame hero: e = 0 the card fills the frame … 1 the card at its place in the pile. MotionFast films the
    // pile through a 2D camera X = C + Z·(s − F), Z = Z0^(1−e), F = h − e·(h − C)/Z (h the hero card's place): the
    // sequence's camera does it (camZoom = Z, its pan = (Z − e)·(h − C) as % of the frame). The hero card itself grows
    // from the frame (w0 × h0) to its size, its turn and corners from 0 to its own: its mask, its scale (the picture
    // keeps covering the card) and its corners follow e. The key tracks hold the zoom's eased progress p (its key
    // easing; e = p pulling back, 1 − p pushing in), or for Expo (no key curve) its share q, straight, and the ƒx
    // takes p = 1 − 2^(−10q).
    const heroEase = S.heroEase && EASES[S.heroEase] ? S.heroEase : 'natural';
    const hExpo = heroEase === 'expo';
    const heroQ = (t, which) => clamp01((t - (which === 'start' ? hh : te)) / ht);
    const heroE = (t, which) => { const p = easeOf(heroEase)[0](heroQ(t, which)); return which === 'start' ? p : 1 - p; };
    const heroDriver = (t, which) => (hExpo ? heroQ(t, which) : easeOf(heroEase)[0](heroQ(t, which)));
    const heroWindow = (which) => (which === 'start' ? [0, Math.min(D, hh + ht)] : [te, D]);
    const heroPieces = (which) => { const how = hExpo ? 'line' : heroEase; return which === 'start' ? [[0, hh, 'line'], [hh, hh + ht, how]] : [[te, te + ht, how], [te + ht, D, 'line']]; };
    const heroLayers = (c, which, pic) => {
      const [t0, t1] = heroWindow(which);
      const fs = at4(t0), span = at4(t1) - fs;
      const at = poseAt(c, which === 'start' ? 0 : te);
      if (which === 'start' && te < t1) warnings.push('The pile leaves before the camera has pulled back: the camera keeps to where the first card lay.');
      const hx = at.x * Sx, hy = at.y * Sx;                       // the hero's place, frame px from the centre
      const Z0 = 1.003 * Math.max(FW / (w * Sx), FH / (h * Sx));
      const w0 = FW / Z0, h0 = FH / Z0;                           // the card at e = 0, frame px (before the camera)
      const cw = w * Sx, ch = h * Sx;
      const z0 = pic.z0;              // the host's cover fit of the card
      const pcs = heroPieces(which).map(([a, b, how]) => [Math.max(a, t0), Math.min(b, t1), how]);
      const eKeys = (shift) => trackKeys((t) => heroDriver(t, which) + shift, pcs, fs, span);
      // e in a ƒx: the keys hold p (+ shift, above a track's floor)
      const E = (shift) => {
        const v = shift ? `(value-${shift})` : 'value';
        const p = hExpo ? `(${v}>=1?1:1-pow(2,-10*${v}))` : v;
        return which === 'start' ? p : `(1-${p})`;
      };
      const lnZ0 = Math.log(Z0);
      // e as a function of time, for the corners (path keys are drawn straight between, so sampled: 30 a second)
      const steps = Math.max(2, Math.ceil((t1 - t0) * 30));
      const pathKeys = [];
      for (let j = 0; j <= steps; j += 1) {
        const t = t0 + ((t1 - t0) * j) / steps, e = heroE(t, which);
        const Wd = w0 + (cw - w0) * e, Hd = h0 + (ch - h0) * e, rr = radius * Sx * e;
        pathKeys.push({ position: r6(clamp(((t - fs) / span) * 100, 0, 100)), value: JSON.stringify(roundRect8(clamp(rr / Wd, 0, 0.5), clamp(rr / Hd, 0, 0.5))), easing: 'Linear' });
      }
      // the cover scale: max(W'/pw, H'/ph) / z0, W' = w0 + (cw − w0)·e
      const kx = (a) => `(${n(w0 / pic.pw)}+${n((cw - w0) / pic.pw)}*${a})`, ky = (a) => `(${n(h0 / pic.ph)}+${n((ch - h0) / pic.ph)}*${a})`;
      const card = {
        ...pic.pic, key: `card[${c.i}].hero`, name: `Card ${c.i + 1} (full frame)`, box: pic.box, track: `card[${c.i}]`, freeStart: fs, trimEnd: r6(span),
        propertyKeyframes: {
          xPercent: [{ position: 0, value: n(xp(at.x)), easing: 'Linear' }],
          yPercent: [{ position: 0, value: n(yp(at.y)), easing: 'Linear' }],
          // its turn: rz·e, two keys with the zoom easing (Expo: the ƒx)
          rotate: hExpo ? eKeys(0) : trackKeys((t) => at.rz * heroE(t, which), pcs, fs, span),
          scale: eKeys(1),
          'msk:m1:w': eKeys(2),
          'msk:m1:h': eKeys(2),
          'msk:m1:path': pathKeys,
        },
        propertyKeyframeFx: {
          ...(hExpo ? { rotate: { type: 'custom', params: { code: `${n(at.rz)}*${E(0)}` } } } : {}),
          scale: { type: 'custom', params: { code: `max(${kx(E(1))},${ky(E(1))})/${n(z0)}` } },
          'msk:m1:w': { type: 'custom', params: { code: `100*${kx(E(2))}/max(${kx(E(2))},${ky(E(2))})` } },
          'msk:m1:h': { type: 'custom', params: { code: `100*${ky(E(2))}/max(${kx(E(2))},${ky(E(2))})` } },
        },
        // its own mask (the host puts its fitted one in its place when the picture is cropped or rounded: the same ids,
        // so the keys above drive that one)
        layerEffects: [{ id: 'layerMask', eid: 'box-mask', enabled: true, params: { mskAmount: 100, mskQuality: 0 },
          masks: [{ mid: 'm1', name: 'Box', mode: 'add', enabled: true, inverted: false, path: { points: roundRect8(0, 0), closed: true },
            x: 0, y: 0, w: r6((100 * cw) / (pic.pw * z0)), h: r6((100 * ch) / (pic.ph * z0)), rot: 0, feather: 0, expand: 0, opacity: 100, grow: 0 }] }],
      };
      const camera = {
        key: `camera.${which}`, type: 'camera', name: which === 'start' ? 'Pull back' : 'Push in', freeStart: fs, trimEnd: r6(span),
        propertyKeyframes: { camZoom: eKeys(1), camX: eKeys(0), camY: eKeys(0) },
        propertyKeyframeFx: {
          camZoom: { type: 'custom', params: { code: `exp((1-${E(1)})*${n(lnZ0)})` } },
          camX: { type: 'custom', params: { code: `(exp((1-${E(0)})*${n(lnZ0)})-${E(0)})*${n((100 * hx) / FW)}` } },
          camY: { type: 'custom', params: { code: `(exp((1-${E(0)})*${n(lnZ0)})-${E(0)})*${n((100 * hy) / FH)}` } },
        },
      };
      return { card, camera };
    };

    const cams = [];
    // with an end hero, nothing but the hero is drawn once it fills the frame
    const cardsEnd = end ? Math.min(D, te + ht) : (exit === 'shrink' ? Math.min(D, te + tl.exitTime) : D);
    // a flight layer where the drop needs a ƒx: flutter, Expo (its curve in the ƒx: samples would be ~0.5 px off), or an
    // easing the editor draws with a scaled dip after the impact
    const flies = flutter > 0 || easeName === 'expo' || (ease && bounceK !== 1 && uI < 1 && !!easeOf(easeName)[1]);
    for (const c of cards) {
      const pic = pictureOf(c);
      const isStartHero = start && c.i === 0, isEndHero = end && c.i === N - 1;
      let from = c.t0 === null ? 0 : c.t0;
      if (isStartHero) {
        const hl = heroLayers(c, 'start', pic);
        layers.push(hl.card); cams.push(hl.camera);
        from = heroWindow('start')[1];
      } else if (flies) {
        layers.push(flightLayer(c, pic));
        from = c.t0 + dT;
      }
      const to = isEndHero ? te : cardsEnd;
      if (to - from > 1e-6) layers.push(cardLayer(c, `card[${c.i}]`, from, to, pic));
      if (isEndHero) {
        const hl = heroLayers(c, 'end', pic);
        layers.push(hl.card); cams.push(hl.camera);
      }
    }
    if (M && media.some((x) => x.type === 'video')) warnings.push('A video on a card plays once (no loop yet).');
    return { duration: D, layers: [...layers, ...cams], warnings };
  },
};
