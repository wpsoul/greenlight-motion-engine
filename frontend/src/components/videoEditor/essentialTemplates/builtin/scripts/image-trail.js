// Image Trail (MotionFast `image-trail`): a head runs along a path and drops a picture card at a fixed spacing; each
// card appears, stays where it was dropped (or keeps moving: falls away by default), then disappears, so a trail of
// pictures is drawn and eaten. 15 path shapes, passes that mirror or reverse, Trail life or Draw · hold · clear, one
// appear / disappear vocabulary, motion after appear.
//
// Built from ordinary layers: one picture layer per dropped card, starting at its drop and lasting its life (a card
// that runs past the end of a seamless clip goes on as a second layer at its start). Where a card is dropped, when,
// and in which order the cards stack come out of this script (the path's arc-length table, the head's easing inverted:
// MotionFast's own numbers). On each layer the APPEAR and DISAPPEAR are keys with the app's easings (an ease the editor
// has no exact curve for — Accelerate, Expo — is written in the expression), and the MOTION AFTER APPEAR (fall, float,
// wiggle, swirl …, spin, zoom) is a ƒx expression of the card's age: the keys hold what the appear / disappear does to
// the property, the expression adds the motion. A card's age is the layer's own `time`.
//
// A built-in script (PLANS/ESSENTIAL_TEMPLATES.md §14): it imports nothing, so this same text also runs as a
// `kind: "script"` source. Numbers and timing are MotionFast's (motionTemplates/imageTrail.js).
const REF_H = 1080;
const SIDE = 200;
const NS = 720;
const MAX_CARDS = 300;
const MAX_LAYERS = 390;          // the host takes 400 layers in a template
const DEG = Math.PI / 180;
const PLATES = ['#1d9bf1', '#f9492d', '#ffffff', '#33efab'];
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mod = (a, n) => ((a % n) + n) % n;
const lerp = (a, b, t) => a + (b - a) * t;
function hash01(a, b) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/* ---------- path shapes: at(u, p) → [x, y] in the 1080 box (MotionFast's) ---------- */
const HOOK = [[314, -121], [276, -165], [238, -211], [198, -257], [159, -300], [120, -332], [71, -368], [5, -391], [-69, -402], [-196, -382],
  [-246, -359], [-296, -334], [-344, -312], [-396, -289], [-440, -265], [-486, -242], [-537, -215], [-583, -196], [-629, -178]];
function catmullRom(pts, u) {
  const n = pts.length - 1, x = clamp(u, 0, 1) * n, i = Math.min(n - 1, Math.floor(x)), f = x - i;
  const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n, i + 2)];
  const c = (a, b, d, e) => 0.5 * (2 * b + (d - a) * f + (2 * a - 5 * b + 4 * d - e) * f * f + (3 * b - a - 3 * d + e) * f * f * f);
  return [c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])];
}
function polyAt(pts, u, closed) {
  const n = closed ? pts.length : pts.length - 1;
  const x = (closed ? mod(u, 1) : clamp(u, 0, 1)) * n;
  const i = Math.min(n - 1, Math.floor(x)), f = x - i;
  const a = pts[i], b = pts[(i + 1) % pts.length];
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f)];
}
const tri = (x) => { const f = mod(x, 1); return f < 0.25 ? 4 * f : f < 0.75 ? 2 - 4 * f : 4 * f - 4; };
const FRAME_PTS = (() => {
  const hw = 400, hh = 250, r = 110, out = [[0, -hh]];
  const arc = (cx, cy, a0) => { for (let k = 0; k <= 8; k++) { const a = a0 + (k / 8) * Math.PI / 2; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } };
  arc(hw - r, -hh + r, -Math.PI / 2); arc(hw - r, hh - r, 0); arc(-hw + r, hh - r, Math.PI / 2); arc(-hw + r, -hh + r, Math.PI);
  return out;
})();
function starPts(n) {
  n = clamp(Math.round(num(n, 5)), 3, 12);
  const p = [];
  for (let i = 0; i < 2 * n; i++) { const a = -Math.PI / 2 + (i * Math.PI) / n, r = i % 2 ? 190 : 440; p.push([r * Math.cos(a), r * Math.sin(a)]); }
  return p;
}
function scribbleAt(u, seed) {
  const a = 2 * Math.PI * u, s = Math.round(num(seed, 1));
  const AX = [300, 150, 80], AY = [220, 130, 70];
  let x = 0, y = 0;
  for (let k = 1; k <= 3; k++) { x += AX[k - 1] * Math.cos(k * a + 6.2832 * hash01(s, k)); y += AY[k - 1] * Math.sin(k * a + 6.2832 * hash01(s, k + 10)); }
  return [x, y];
}
const HEART_CY = -52;
const SHAPES = {
  hook: { label: 'Hook', closed: false, wide: true, at: (u) => catmullRom(HOOK, u) },
  lissajous: { label: 'Lissajous', closed: true, wide: true, at: (u) => { const a = 2 * Math.PI * u; return [0.3 + 432 * Math.cos(3 * a - 2.047), -1 + 377.4 * Math.cos(2 * a - 1.890)]; } },
  wave: { label: 'Wave', closed: false, wide: true, count: 'waves', at: (u, p) => [lerp(-640, 640, u), -230 * Math.sin(2 * Math.PI * num(p.waves, 1.5) * u)] },
  zigzag: { label: 'Zigzag', closed: false, wide: true, count: 'zigs', at: (u, p) => [lerp(-640, 640, u), -230 * tri(Math.round(num(p.zigs, 3)) * u)] },
  line: { label: 'Line', closed: false, wide: true, at: (u) => [lerp(-640, 640, u), lerp(320, -320, u)] },
  arc: { label: 'Arc', closed: false, wide: true, at: (u) => [-520 * Math.cos(Math.PI * u), 640 - 960 * Math.sin(Math.PI * u)] },
  bounce: { label: 'Bounce', closed: false, wide: true, count: 'hops', at: (u, p) => { const h = clamp(Math.round(num(p.hops, 3)), 1, 12), x = u * h, j = Math.min(h - 1, Math.floor(x)); return [lerp(-640, 640, u), 400 - 700 * Math.pow(0.62, j) * Math.sin(Math.PI * (x - j))]; } },
  circle: { label: 'Circle', closed: true, wide: false, at: (u) => [330 * Math.sin(2 * Math.PI * u), -330 * Math.cos(2 * Math.PI * u)] },
  infinity: { label: 'Infinity', closed: true, wide: false, at: (u) => { const a = 2 * Math.PI * u, s = Math.sin(a), d = 1 + s * s; return [500 * Math.cos(a) / d, 760 * s * Math.cos(a) / d]; } },
  spiral: { label: 'Spiral', closed: false, wide: false, count: 'turns', at: (u, p) => { const r = 30 + 440 * u, a = 2 * Math.PI * num(p.turns, 1.75) * u - Math.PI / 2; return [r * Math.cos(a), r * Math.sin(a)]; } },
  heart: { label: 'Heart', closed: true, wide: false, at: (u) => { const a = 2 * Math.PI * u, s = Math.sin(a); return [336 * s * s * s, -21 * (13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)) + HEART_CY]; } },
  flower: { label: 'Flower', closed: true, wide: false, count: 'petals', at: (u, p) => { const n = clamp(Math.round(num(p.petals, 5)), 2, 12), a = 2 * Math.PI * u, r = 440 * (0.3 + 0.7 * Math.abs(Math.cos(n * a / 2))); return [r * Math.sin(a), -r * Math.cos(a)]; } },
  star: { label: 'Star', closed: true, wide: false, count: 'points', at: (u, p) => polyAt(starPts(p.points), u, true) },
  frame: { label: 'Frame', closed: true, wide: true, at: (u) => polyAt(FRAME_PTS, u, true) },
  scribble: { label: 'Scribble', closed: true, wide: true, count: 'scribbleSeed', at: (u, p) => scribbleAt(u, p.scribbleSeed) },
};
const CARD_SHAPES = { '1:1': 1, '4:5': 0.8, '3:4': 0.75, '2:3': 2 / 3, '9:16': 9 / 16, '4:3': 4 / 3, '16:9': 16 / 9 };
const fitOf = (shape, aspect) => (shape.wide ? [aspect, 1] : [Math.min(1, aspect), Math.min(1, aspect)]);
const pScale = (v) => Math.max(0.02, num(v, 100) / 100);

/* ---------- MotionFast's easings (mtl.js + the editor's bezier search), and the editor's key for each ---------- */
function bezierEase(p1x, p1y, p2x, p2y) {
  const bx = (t) => 3 * p1x * t * (1 - t) * (1 - t) + 3 * p2x * t * t * (1 - t) + t * t * t;
  const by = (t) => 3 * p1y * t * (1 - t) * (1 - t) + 3 * p2y * t * t * (1 - t) + t * t * t;
  return (x) => {
    x = Math.max(0, Math.min(1, x));
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 24; i++) { const cx = bx(t); if (Math.abs(cx - x) < 1e-4) break; if (cx < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return by(t);
  };
}
const TABLES = {
  elastic: '0,.0221,.0739,.1485,.2394,.3402,.4458,.5517,.6541,.7502,.8375,.9149,.9813,1.0364,1.0803,1.1136,1.1369,1.1513,1.1579,1.1578,1.1522,1.1424,1.1294,1.1142,1.0978,1.081,1.0643,1.0485,1.0338,1.0205,1.009,.9992,.9912,.9849,.9803,.9772,.9754,.9748,.9752,.9764,.9782,.9804,.9829,.9856,.9882,.9908,.9933,.9955,.9975,.9992,1.0007,1.0018,1.0027,1.0034,1.0038,1.004,1.004,1.0039,1.0036,1.0033,1.0029,1.0025,1.0021,1.0017,1.0013,1.0009,1.0006,1.0003,1,.9998,.9996,.9995,.9994,.9994,.9994,.9994,.9994,.9994,.9995,.9996,.9996,.9997,.9998,.9998,.9999,.9999,1,1,1,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1',
  overshoot: '0,.1739,.3067,.4183,.515,.6,.6755,.743,.8034,.8576,.9063,.95,.9891,1.0241,1.0551,1.0825,1.1066,1.1275,1.1455,1.1606,1.1731,1.183,1.1906,1.1959,1.199,1.2,1.1997,1.1988,1.1972,1.195,1.1921,1.1886,1.1846,1.18,1.1749,1.1695,1.1638,1.1579,1.1519,1.1458,1.1397,1.1337,1.1277,1.1219,1.1162,1.1107,1.1053,1.1002,1.0952,1.0904,1.0857,1.0813,1.077,1.0729,1.0689,1.0651,1.0615,1.058,1.0547,1.0515,1.0484,1.0455,1.0427,1.0401,1.0375,1.0351,1.0327,1.0305,1.0284,1.0264,1.0244,1.0226,1.0209,1.0192,1.0176,1.0162,1.0148,1.0134,1.0122,1.011,1.0099,1.0088,1.0079,1.007,1.0061,1.0053,1.0046,1.0039,1.0033,1.0028,1.0023,1.0018,1.0014,1.0011,1.0008,1.0005,1.0003,1.0002,1.0001,1,1',
  impulse: '0,-.0006,-.0023,-.005,-.0086,-.0131,-.0183,-.0243,-.0308,-.038,-.0456,-.0537,-.0622,-.071,-.0801,-.0894,-.0988,-.1084,-.1179,-.1275,-.1369,-.1461,-.1551,-.1636,-.1717,-.1791,-.1858,-.1915,-.1959,-.1989,-.2,-.1986,-.1944,-.187,-.1762,-.1616,-.1432,-.1206,-.0939,-.0632,-.0289,.0087,.0487,.0906,.1334,.1765,.2193,.2613,.3022,.3416,.3794,.4156,.4501,.483,.5142,.5438,.5719,.5986,.6239,.6478,.6705,.692,.7124,.7317,.75,.7673,.7837,.7993,.814,.8279,.841,.8535,.8652,.8763,.8868,.8967,.9059,.9147,.9229,.9305,.9377,.9444,.9507,.9565,.9619,.9669,.9714,.9756,.9794,.9829,.986,.9888,.9912,.9933,.9952,.9967,.9979,.9988,.9995,.9999,1',
  swing: '0,-.0013,-.0052,-.0115,-.0199,-.0302,-.0421,-.0554,-.0697,-.0847,-.1,-.1153,-.1303,-.1446,-.1579,-.1698,-.1801,-.1885,-.1948,-.1987,-.2,-.1986,-.1942,-.1863,-.1744,-.1578,-.136,-.1079,-.0725,-.0288,.0241,.087,.1594,.2396,.3241,.4088,.4899,.5651,.6332,.6941,.7482,.796,.8384,.8758,.9088,.9379,.9636,.9863,1.0061,1.0235,1.0386,1.0517,1.0628,1.0723,1.0801,1.0865,1.0916,1.0954,1.098,1.0995,1.1,1.0997,1.0987,1.097,1.0947,1.0919,1.0885,1.0847,1.0806,1.0762,1.0717,1.0671,1.0624,1.0578,1.0533,1.0489,1.0447,1.0406,1.0368,1.0332,1.0297,1.0265,1.0235,1.0207,1.0181,1.0157,1.0135,1.0115,1.0097,1.008,1.0065,1.0052,1.0041,1.0031,1.0022,1.0015,1.001,1.0005,1.0002,1.0001,1',
};
const tableEase = (src) => { const v = src.split(',').map(Number); return (t) => { t = clamp(t, 0, 1); const i = t * (v.length - 1), lo = Math.floor(i), hi = Math.min(v.length - 1, lo + 1); return lerp(v[lo], v[hi], i - lo); }; };
const bounceOut = (t) => {
  t = clamp(t, 0, 1);
  const n1 = 7.5625, d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
  if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
  t -= 2.625 / d1; return n1 * t * t + 0.984375;
};
const ACCEL = 1 / 0.54;
const BZ = { smooth: [0.5, 0, 0, 1], natural: [0.8, 0, 0.2, 1], slowDown: [0, 0, 0, 1], aeIn: [0.3141666673, 0, 0.0875000209, 1], aeSmooth: [0.8820833270, 0, 0.2445833683, 1], aeOut: [0.8699999754, 0, 0.6433336333, 1] };
function easeOf(nm) {
  if (nm === 'linear') return (x) => clamp(x, 0, 1);
  if (nm === 'accelerate') return (x) => Math.pow(clamp(x, 0, 1), ACCEL);
  if (BZ[nm]) return bezierEase(...BZ[nm]);
  if (TABLES[nm]) return tableEase(TABLES[nm]);
  const p = (k) => (t) => { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, k); };
  if (nm === 'power2') return p(3);
  if (nm === 'power3') return p(4);
  if (nm === 'power4') return p(5);
  if (nm === 'back') return (t) => { t = clamp(t, 0, 1); return 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2); };
  if (nm === 'bounce') return bounceOut;
  if (nm === 'expo') return (t) => { t = clamp(t, 0, 1); return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); };
  return bezierEase(...BZ.smooth);
}
// the editor's key easing for each (exact: the same bezier, the same named curve or table); `fx`: written in the
// expression as a function of the card's age instead (no exact key curve); `sample`: keys every 1 % (MotionFast's table)
const R4 = (b) => b.map((v) => Math.round(v * 1e4) / 1e4);
const KEY_EASE = {
  linear: { easing: 'Linear' }, smooth: { easing: 'Custom', bezier: R4(BZ.smooth) }, natural: { easing: 'Natural' },
  slowDown: { easing: 'Slow Down' }, aeIn: { easing: 'AE In (arrive)' }, aeSmooth: { easing: 'AE Smooth' }, aeOut: { easing: 'AE Out (leave)' },
  power2: { easing: 'Ease Out' }, power3: { easing: 'Cubic Out' }, power4: { easing: 'Power' }, back: { easing: 'Back Out' },
  bounce: { easing: 'Bounce Out' }, overshoot: { easing: 'Overshoot' }, impulse: { easing: 'Impulse' }, swing: { easing: 'Swing' },
  accelerate: 'fx', expo: 'fx', elastic: 'sample',
};
const FX_EASE = { accelerate: (u) => `pow(clamp(${u},0,1),${n(ACCEL)})`, expo: (u) => `(${u}>=1?1:1-pow(2,-10*clamp(${u},0,1)))` };

const EASE_OPTIONS = [['linear', 'Linear'], ['accelerate', 'Accelerate'], ['smooth', 'Smooth'], ['power2', 'Power 2'], ['power3', 'Power 3'],
  ['power4', 'Power 4'], ['back', 'Back'], ['bounce', 'Bounce'], ['expo', 'Expo'], ['natural', 'Natural'], ['slowDown', 'Slow Down'],
  ['elastic', 'Elastic'], ['overshoot', 'Overshoot'], ['impulse', 'Impulse'], ['swing', 'Swing'], ['aeIn', 'AE In'], ['aeSmooth', 'AE Smooth'], ['aeOut', 'AE Out']]
  .map(([value, label]) => ({ value, label }));
const HEAD_EASES = EASE_OPTIONS.filter((o) => o.value !== 'back' && o.value !== 'bounce');
function invertEase(e, y) {
  if (y <= 0) return 0;
  if (y >= 1) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 32; i++) { const m = (lo + hi) / 2; if (e(m) < y) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

const ENTER = [['grow', 'Grow from small (Trail)'], ['scale', 'Zoom in'], ['fade', 'Fade in'], ['matte', 'Matte grows from centre'],
  ['wipeH', 'Wipe from a vertical line'], ['wipeV', 'Wipe from a horizontal line'], ['flip', 'Flip open'], ['spin', 'Spin in'],
  ['slide', 'Slide in along the path + fade'], ['push', 'Push out from under the previous card'], ['drop', 'Drop in from above'],
  ['rise', 'Rise from below'], ['cut', 'Hard cut']].map(([value, label]) => ({ value, label }));
const EXIT = [['shrink', 'Shrink, then cut (Trail)'], ['shrinkFade', 'Shrink + fade (Streak)'], ['scale', 'Zoom out'], ['fade', 'Fade'],
  ['matte', 'Matte shrinks to centre'], ['wipeH', 'Wipe to a vertical line'], ['wipeV', 'Wipe to a horizontal line'], ['flip', 'Flip closed'],
  ['spin', 'Spin out'], ['slide', 'Slide on along the path + fade'], ['push', 'Tuck under the neighbouring card'], ['drop', 'Drop down + fade'],
  ['rise', 'Rise up + fade'], ['cut', 'Hard cut']].map(([value, label]) => ({ value, label }));
const IDLE = { none: { label: 'Still' }, path: { label: 'Along path', base: 120 }, wiggle: { label: 'Wiggle', base: 38 }, spread: { label: 'Spread', base: 90 },
  float: { label: 'Float', base: 80 }, fall: { label: 'Fall', base: 150 }, bob: { label: 'Bob', base: 30 }, swirl: { label: 'Swirl', base: 14 } };
const CLOSED = Object.entries(SHAPES).filter(([, s]) => s.closed).map(([k]) => k);

const fields = [
  { type: 'group', key: 'gMedia', label: 'Media' },
  { key: 'media', type: 'media', label: 'Images / videos', slots: { from: 'media', max: 64, empty: 4 }, accept: 'media', ifFewer: 'reuse' },
  { key: 'fillEmpty', type: 'switch', label: 'Repeat media', default: true },
  { type: 'group', key: 'gPlates', label: 'Placeholders' },
  { key: 'color1', type: 'color', label: 'Fill 1', default: PLATES[0] },
  { key: 'color2', type: 'color', label: 'Fill 2', default: PLATES[1] },
  { key: 'color3', type: 'color', label: 'Fill 3', default: PLATES[2] },
  { key: 'color4', type: 'color', label: 'Fill 4', default: PLATES[3] },
  { type: 'group', key: 'gPath', label: 'Path' },
  { key: 'shape', type: 'select', label: 'Shape', default: 'hook', options: Object.entries(SHAPES).map(([value, s]) => ({ value, label: s.label })) },
  { key: 'waves', type: 'range', label: 'Waves', default: 1.5, min: 0.5, max: 6, step: 0.5, showIf: { key: 'shape', equals: 'wave' } },
  { key: 'zigs', type: 'range', label: 'Zigs', default: 3, min: 1, max: 12, step: 1, showIf: { key: 'shape', equals: 'zigzag' } },
  { key: 'hops', type: 'range', label: 'Hops', default: 3, min: 1, max: 8, step: 1, showIf: { key: 'shape', equals: 'bounce' } },
  { key: 'turns', type: 'range', label: 'Turns', default: 1.75, min: 0.5, max: 6, step: 0.25, showIf: { key: 'shape', equals: 'spiral' } },
  { key: 'petals', type: 'range', label: 'Petals', default: 5, min: 2, max: 12, step: 1, showIf: { key: 'shape', equals: 'flower' } },
  { key: 'points', type: 'range', label: 'Points', default: 5, min: 3, max: 12, step: 1, showIf: { key: 'shape', equals: 'star' } },
  { key: 'scribbleSeed', type: 'range', label: 'Shuffle', default: 1, min: 1, max: 99, step: 1, showIf: { key: 'shape', equals: 'scribble' } },
  { key: 'pathWidth', type: 'range', label: 'Width', default: 100, min: 20, max: 250, step: 1, suffix: '%' },
  { key: 'pathHeight', type: 'range', label: 'Height', default: 100, min: 20, max: 250, step: 1, suffix: '%' },
  { key: 'pathRotate', type: 'range', label: 'Rotate', default: 0, min: -180, max: 180, step: 1, suffix: '°' },
  { key: 'pathX', type: 'range', label: 'Move X', default: 0, min: -100, max: 100, step: 1, suffix: '%' },
  { key: 'pathY', type: 'range', label: 'Move Y', default: 0, min: -100, max: 100, step: 1, suffix: '%' },
  { key: 'startAt', type: 'range', label: 'Start point', default: 0, min: 0, max: 100, step: 1, suffix: '%', showIf: { key: 'shape', in: CLOSED } },
  { key: 'reverse', type: 'switch', label: 'Reverse direction', default: false },
  { key: 'alternate', type: 'select', label: 'Next pass', default: 'auto', options: [
    { value: 'auto', label: 'Auto — mirror open paths, repeat loops' }, { value: 'same', label: 'Same path' },
    { value: 'point', label: 'Mirror through the centre' }, { value: 'flipX', label: 'Mirror left ↔ right' },
    { value: 'flipY', label: 'Mirror top ↕ bottom' }, { value: 'reverse', label: 'Run it backwards' },
  ] },
  { type: 'group', key: 'gTrail', label: 'Trail' },
  { key: 'passes', type: 'range', label: 'Passes', default: 2, min: 1, max: 8, step: 1, integer: true },
  { key: 'drawTime', type: 'range', label: 'Draw time', default: 49, min: 5, max: 100, step: 1, suffix: '%' },
  { key: 'headEase', type: 'select', label: 'Head easing', default: 'linear', options: HEAD_EASES },
  { key: 'spacing', type: 'range', label: 'Card spacing', default: 30, min: 5, max: 300, step: 1, suffix: '%' },
  { type: 'group', key: 'gCards', label: 'Cards' },
  { key: 'cardSize', type: 'range', label: 'Card size', default: 100, min: 20, max: 300, step: 1, suffix: '%' },
  { key: 'cardShape', type: 'select', label: 'Card shape', default: '1:1', options: [
    { value: '1:1', label: 'Square' }, { value: '4:5', label: '4:5 portrait' }, { value: '3:4', label: '3:4 portrait' }, { value: '2:3', label: '2:3 portrait' },
    { value: '9:16', label: '9:16 portrait' }, { value: '4:3', label: '4:3' }, { value: '16:9', label: '16:9' },
  ] },
  { key: 'radius', type: 'range', label: 'Corner radius', default: 0, min: 0, max: 50, step: 1, suffix: '%' },
  { key: 'cardRotate', type: 'select', label: 'Rotation', default: 'none', options: [
    { value: 'none', label: 'Upright' }, { value: 'path', label: 'Follow the path' }, { value: 'random', label: 'Random tilt' }, { value: 'alternate', label: 'Alternate tilt' },
  ] },
  { key: 'tilt', type: 'range', label: 'Tilt', default: 10, min: 0, max: 45, step: 1, suffix: '°', showIf: { key: 'cardRotate', in: ['random', 'alternate'] } },
  { key: 'order', type: 'select', label: 'Stacking', default: 'newest', options: [{ value: 'newest', label: 'Newest on top' }, { value: 'oldest', label: 'Oldest on top' }] },
  { type: 'group', key: 'gAppear', label: 'Appear' },
  { key: 'revealStyle', type: 'select', label: 'Style', default: 'grow', options: ENTER },
  { key: 'growFrom', type: 'range', label: 'Start size', default: 48, min: 0, max: 100, step: 1, suffix: '%', showIf: { key: 'revealStyle', equals: 'grow' } },
  { key: 'revealTime', type: 'range', label: 'Duration', default: 0.62, min: 0.05, max: 2, step: 0.01, suffix: 's', showIf: { key: 'revealStyle', notEquals: 'cut' } },
  { key: 'revealEase', type: 'select', label: 'Easing', default: 'accelerate', options: EASE_OPTIONS, showIf: { key: 'revealStyle', notEquals: 'cut' } },
  { type: 'group', key: 'gIdle', label: 'Motion after appear' },
  { key: 'idleMotion', type: 'select', label: 'Motion', default: 'fall', options: Object.entries(IDLE).map(([value, m]) => ({ value, label: m.label })) },
  { key: 'idleAmount', type: 'range', label: 'Amount', default: 100, min: 0, max: 300, step: 1, suffix: '%', showIf: { key: 'idleMotion', notEquals: 'none' } },
  { key: 'idleSpin', type: 'range', label: 'Spin', default: 0, min: -120, max: 120, step: 1, suffix: '°/s' },
  { key: 'idleZoom', type: 'range', label: 'Zoom', default: 0, min: -40, max: 60, step: 1, suffix: '%/s' },
  { type: 'group', key: 'gDisappear', label: 'Disappear' },
  { key: 'lifeMode', type: 'select', label: 'Mode', default: 'trail', options: [{ value: 'trail', label: 'Trail' }, { value: 'hold', label: 'Draw · hold · clear' }] },
  { key: 'delay', type: 'range', label: 'Delay', default: 0, min: 0, max: 10, step: 0.05, suffix: 's', showIf: { key: 'lifeMode', equals: 'trail' } },
  { key: 'holdTime', type: 'range', label: 'Hold', default: 1, min: 0, max: 6, step: 0.05, suffix: 's', showIf: { key: 'lifeMode', equals: 'hold' } },
  { key: 'clearOrder', type: 'select', label: 'Order', default: 'tail', showIf: { key: 'lifeMode', equals: 'hold' }, options: [
    { value: 'tail', label: 'Tail first' }, { value: 'head', label: 'Head first (rewind)' }, { value: 'together', label: 'All together' },
  ] },
  { key: 'clearSweep', type: 'range', label: 'Clear over', default: 1, min: 0, max: 6, step: 0.05, suffix: 's', showIf: { key: 'lifeMode', equals: 'hold' } },
  { key: 'clearStyle', type: 'select', label: 'Style', default: 'shrink', options: EXIT },
  { key: 'shrinkTo', type: 'range', label: 'End size', default: 38, min: 0, max: 100, step: 1, suffix: '%', showIf: { key: 'clearStyle', in: ['shrink', 'shrinkFade'] } },
  { key: 'clearDur', type: 'range', label: 'Duration', default: 0.44, min: 0.05, max: 2, step: 0.01, suffix: 's', showIf: { key: 'clearStyle', notEquals: 'cut' } },
  { key: 'clearEase', type: 'select', label: 'Easing', default: 'linear', options: EASE_OPTIONS, showIf: { key: 'clearStyle', notEquals: 'cut' } },
  { type: 'group', key: 'gTiming', label: 'Timing' },
  { key: 'duration', type: 'range', label: 'Duration', default: 10, min: 1, max: 60, step: 0.1, suffix: 's' },
  { key: 'seamless', type: 'switch', label: 'Seamless loop', default: true },
];

// numbers in an expression or a key: 10 significant digits
function n(v) { const x = Number(v); return Math.abs(x) < 1e-12 ? '0' : String(Number(x.toPrecision(10))); }
const r6 = (v) => { const x = Math.round(v * 1e6) / 1e6; return Object.is(x, -0) ? 0 : x; };

// what an appear / disappear does to a card, as MotionFast's shapeState, at v (1 = in place)
function shapeState(st, style, v, phase, S) {
  v = Math.max(0, v);
  const r = 1 - v;
  switch (style) {
    case 'grow': st.k *= lerp(clamp(num(S.growFrom, 48), 0, 100) / 100, 1, v); break;
    case 'shrink': st.k *= lerp(clamp(num(S.shrinkTo, 38), 0, 100) / 100, 1, v); break;
    case 'shrinkFade': st.k *= lerp(clamp(num(S.shrinkTo, 38), 0, 100) / 100, 1, v); st.alpha *= v; break;
    case 'matte': st.mx *= v; st.my *= v; break;
    case 'wipeH': st.mx *= v; break;
    case 'wipeV': st.my *= v; break;
    case 'scale': st.k *= v; break;
    case 'flip': st.fx *= v; break;
    case 'fade': st.alpha *= v; break;
    case 'spin': st.k *= v; st.rot += (phase === 'in' ? -120 : 120) * r; break;
    case 'slide': st.dx += phase === 'in' ? -r : r; st.alpha *= v; break;
    case 'push': if (phase === 'in') st.pin = r; else st.pout = r; break;
    case 'drop': st.dy += phase === 'in' ? -r : r; st.alpha *= v; break;
    case 'rise': st.dy += phase === 'in' ? r : -r; st.alpha *= v; break;
    default: break;
  }
}
const fresh = () => ({ k: 1, mx: 1, my: 1, fx: 1, alpha: 1, dx: 0, dy: 0, rot: 0, pin: 0, pout: 0 });

export default {
  id: 'image-trail',
  name: 'Image Trail',
  category: 'Carousels',
  v: 1,
  fields,
  build({ settings: P, media, frame }) {
    const { W, H } = frame;
    const S = H / REF_H, aspect = W / H;
    const warnings = [];
    const shape = SHAPES[P.shape] || SHAPES.hook;
    const D = Math.max(1, num(P.duration, 10));
    const passes = clamp(Math.round(num(P.passes, 2)), 1, 12);
    const slot = D / passes;
    const alt = P.alternate === 'auto' ? (shape.closed ? 'same' : 'point') : P.alternate;
    const draw = slot * clamp(num(P.drawTime, 51), 1, 100) / 100;
    const headE = easeOf(P.headEase), revealE = easeOf(P.revealEase), clearE = easeOf(P.clearEase);
    const gap = SIDE * Math.max(0.01, num(P.spacing, 30) / 100);
    const asp = CARD_SHAPES[P.cardShape] || 1;
    const inStyle = P.revealStyle, outStyle = P.clearStyle;
    const rt = Math.max(0.01, num(P.revealTime, 0.62)), cd = Math.max(0.01, num(P.clearDur, 0.44));
    const hold = P.lifeMode === 'hold', delay = Math.max(0, num(P.delay, 0));
    const holdTime = Math.max(0, num(P.holdTime, 1)), sweep = Math.max(0, num(P.clearSweep, 1));
    const newestOnTop = P.order !== 'oldest', seamless = P.seamless !== false;
    const idleName = IDLE[P.idleMotion] ? P.idleMotion : 'none';
    const amt = Math.max(0, num(P.idleAmount, 100)) / 100 * (IDLE[idleName].base || 0);
    const spin = num(P.idleSpin, 0) * DEG, zoom = num(P.idleZoom, 0) / 100;
    const side = SIDE * Math.max(0.05, num(P.cardSize, 100) / 100);
    const w = side * Math.sqrt(asp), h = side / Math.sqrt(asp);
    const rad = (clamp(num(P.radius, 0), 0, 50) / 100) * Math.min(w, h);
    const tilt = num(P.tilt, 10) * DEG;
    const ramp = inStyle === 'cut' ? 0.25 : rt;

    // the drop schedule (geomFor): an arc-length table of the path at its size, the cards along it, when the head
    // reaches each
    const [fx0, fy0] = fitOf(shape, aspect);
    const sx = fx0 * pScale(P.pathWidth), sy = fy0 * pScale(P.pathHeight);
    const cum = new Array(NS + 1).fill(0);
    let [px0, py0] = shape.at(0, P);
    for (let i = 1; i <= NS; i++) { const [x, y] = shape.at(i / NS, P); cum[i] = cum[i - 1] + Math.hypot((x - px0) * sx, (y - py0) * sy); px0 = x; py0 = y; }
    const L = Math.max(1, cum[NS]);
    const uAt = (s) => {
      s = clamp(s, 0, L);
      let lo = 0, hi = NS;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
      const span = cum[hi] - cum[lo];
      return (lo + (span > 0 ? (s - cum[lo]) / span : 0)) / NS;
    };
    let ds = Math.max(2, gap);
    let count = shape.closed ? Math.max(1, Math.round(L / ds)) : Math.floor(L / ds + 1e-6) + 1;
    count = Math.min(count, MAX_CARDS);
    ds = shape.closed ? L / count : count > 1 ? Math.min(ds, L / (count - 1)) : 0;
    const start = shape.closed ? (mod(num(P.startAt, 0), 100) / 100) * L : 0;
    const sOf = (s, back) => (shape.closed ? mod(back ? start - s : start + s, L) : back ? L - s : s);
    const sk = [], tau = [];
    for (let k = 0; k < count; k++) { sk.push(k * ds); tau.push(invertEase(headE, shape.closed ? k / count : (k * ds) / L)); }
    // path → world (MotionFast frameSetup): size, rotation, offset; a pass mirrors about the path's own centre
    const rot = num(P.pathRotate, 0) * DEG, cr = Math.cos(rot), sr = Math.sin(rot);
    const ox = (num(P.pathX, 0) / 100) * (REF_H * aspect / 2), oy = (num(P.pathY, 0) / 100) * (REF_H / 2);
    const place = (u, mir) => {
      let [x, y] = shape.at(shape.closed ? mod(u, 1) : clamp(u, 0, 1), P);
      x *= sx; y *= sy;
      if (mir === 'point') { x = -x; y = -y; } else if (mir === 'flipX') x = -x; else if (mir === 'flipY') y = -y;
      return [x * cr - y * sr + ox, x * sr + y * cr + oy];
    };
    const pathPoint = (s, back, mir) => {
      const over = shape.closed ? 0 : Math.max(0, s - L);
      const u = uAt(sOf(shape.closed ? s : Math.min(s, L), back));
      const p = place(u, mir), e1 = place(u - 0.0015, mir), e2 = place(u + 0.0015, mir);
      let tx = e2[0] - e1[0], ty = e2[1] - e1[1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      if (back) { tx = -tx; ty = -ty; }
      return [p[0] + tx * over, p[1] + ty * over, tx, ty];
    };
    const passMirror = (j) => (j % 2 === 1 && (alt === 'point' || alt === 'flipX' || alt === 'flipY') ? alt : 'none');
    const passBack = (j) => !!P.reverse !== (alt === 'reverse' && j % 2 === 1);

    // every card: when it drops, when it starts to go, when it is gone (ages, s)
    const cards = [];
    for (let j = 0; j < passes; j++) {
      const t0 = j * slot;
      for (let k = 0; k < count; k++) {
        const drop = t0 + draw * tau[k];
        let ex;
        if (hold) {
          const f = count > 1 ? k / (count - 1) : 0;
          const frac = P.clearOrder === 'head' ? 1 - f : P.clearOrder === 'together' ? 0 : f;
          ex = t0 + draw + holdTime + sweep * frac - drop;
        } else ex = (inStyle === 'cut' ? 0 : rt) + delay;
        const end = Math.min(ex + (outStyle === 'cut' ? 0 : cd), D * 0.999);
        if (!(end > 0)) continue;
        cards.push({ j, k, gi: j * count + k, drop, ex, end, mir: passMirror(j), back: passBack(j) });
      }
    }
    const byJK = new Map(cards.map((c) => [`${c.j}:${c.k}`, c]));

    // a card's place at age a, before its appear / disappear offsets: (x, y) REF px from the frame centre, the
    // direction of travel and its angle; as numbers (for keys and checks) and as expression text (A = the age)
    const M = media.length, fill = P.fillEmpty !== false;
    const idleOf = (c) => {
      const [x0, y0, tx, ty] = pathPoint(sk[c.k], c.back, c.mir);
      let base = 0;
      if (P.cardRotate === 'random') base = (hash01(c.gi, 7) * 2 - 1) * tilt;
      else if (P.cardRotate === 'alternate') base = (c.k % 2 ? 1 : -1) * tilt;
      const pathAngle = Math.atan2(ty, tx);
      return { x0, y0, tx, ty, base, pathAngle };
    };
    const mtOf = (a) => (a < ramp ? (a * a) / (2 * ramp) : a - ramp / 2);
    const rkOf = (a) => (a < ramp ? (a / ramp) * (a / ramp) * (3 - 2 * a / ramp) : 1);
    // the motion after appear at age a: { x, y, tx, ty, ang (rad, without the appear's spin) }
    const motion = (c, I, a) => {
      const mt = mtOf(a), rk = rkOf(a);
      let x = I.x0, y = I.y0, tx = I.tx, ty = I.ty, turn = 0;
      if (idleName === 'path') [x, y, tx, ty] = pathPoint(sk[c.k] + amt * mt, c.back, c.mir);
      switch (idleName) {
        case 'wiggle': { const wv = amt * rk * Math.sin(2 * Math.PI * 0.8 * a - sk[c.k] / 110); x -= ty * wv; y += tx * wv; break; }
        case 'spread': {
          let dx = x - ox, dy = y - oy;
          const d = Math.hypot(dx, dy);
          if (d < 1) { dx = -ty; dy = tx; } else { dx /= d; dy /= d; }
          x += dx * amt * mt; y += dy * amt * mt;
          break;
        }
        case 'float': y -= amt * mt; x += 0.18 * amt * rk * Math.sin(1.7 * a + c.gi * 1.3); break;
        case 'fall': y += 0.5 * amt * mt * mt; x += (hash01(c.gi, 3) * 2 - 1) * 0.3 * amt * mt; break;
        case 'bob': y += amt * rk * Math.sin(2 * Math.PI * 0.6 * a + c.k * 0.9); break;
        case 'swirl': {
          turn = amt * DEG * mt;
          const co = Math.cos(turn), sn = Math.sin(turn), dx = x - ox, dy = y - oy;
          x = ox + dx * co - dy * sn; y = oy + dx * sn + dy * co;
          [tx, ty] = [tx * co - ty * sn, tx * sn + ty * co];
          break;
        }
        default: break;
      }
      let ang = P.cardRotate === 'path' ? Math.atan2(ty, tx) : I.base + turn;
      ang += spin * mt;
      return { x, y, tx, ty, ang };
    };
    // the motion after appear as expression text of the age A, as DELTAS from the drop point and the card's angle
    // (not for 'path': its cards are keyed by samples)
    const MT = (A) => `(${A}<${n(ramp)}?${A}*${A}/${n(2 * ramp)}:${A}-${n(ramp / 2)})`;
    const RK = (A) => `(${A}<${n(ramp)}?pow(${A}/${n(ramp)},2)*(3-2*${A}/${n(ramp)}):1)`;
    const sum = (terms) => { const t = terms.filter(Boolean); return t.length ? t.join('+').replace(/\+-/g, '-') : ''; };
    const motionExpr = (c, I, A) => {
      let dX = '', dY = '', dA = '';
      switch (idleName) {
        case 'wiggle': {
          const wv = `${n(amt)}*${RK(A)}*sin(${n(2 * Math.PI * 0.8)}*${A}-${n(sk[c.k] / 110)})`;
          dX = `${n(-I.ty)}*${wv}`; dY = `${n(I.tx)}*${wv}`;
          break;
        }
        case 'spread': {
          let dx = I.x0 - ox, dy = I.y0 - oy;
          const d = Math.hypot(dx, dy);
          if (d < 1) { dx = -I.ty; dy = I.tx; } else { dx /= d; dy /= d; }
          dX = `${n(dx * amt)}*${MT(A)}`; dY = `${n(dy * amt)}*${MT(A)}`;
          break;
        }
        case 'float': dY = `${n(-amt)}*${MT(A)}`; dX = `${n(0.18 * amt)}*${RK(A)}*sin(1.7*${A}+${n(c.gi * 1.3)})`; break;
        case 'fall': dY = `${n(0.5 * amt)}*pow(${MT(A)},2)`; dX = `${n((hash01(c.gi, 3) * 2 - 1) * 0.3 * amt)}*${MT(A)}`; break;
        case 'bob': dY = `${n(amt)}*${RK(A)}*sin(${n(2 * Math.PI * 0.6)}*${A}+${n(c.k * 0.9)})`; break;
        case 'swirl': {
          const T = `(${n(amt * DEG)}*${MT(A)})`, dx = I.x0 - ox, dy = I.y0 - oy;
          dX = `${n(dx)}*cos${T}-${n(dy)}*sin${T}-${n(dx)}`.replace(/--/g, '+');
          dY = `${n(dx)}*sin${T}+${n(dy)}*cos${T}-${n(dy)}`.replace(/\+-/g, '-').replace(/--/g, '+');
          dA = T;
          break;
        }
        default: break;
      }
      if (spin) dA = sum([dA, `${n(spin)}*${MT(A)}`]);
      return { dX, dY, dA };
    };

    // ── the layers ──
    // a card instance on the timeline: the whole life, or the part of a seamless card that wrapped to the clip's start
    const pieces = [];
    for (const c of cards) {
      if (c.drop + c.end <= D + 1e-9 || !seamless) {
        const life = Math.min(c.end, D - c.drop);
        if (life > 1e-6) pieces.push({ c, from: c.drop, a0: 0, a1: life });
      } else {
        pieces.push({ c, from: c.drop, a0: 0, a1: D - c.drop });
        pieces.push({ c, from: 0, a0: D - c.drop, a1: c.end, wrapped: true });
      }
    }
    // stacking: newest on top (MotionFast sorts by age); the wrapped parts are older than anything dropped this loop
    pieces.sort((p, q) => {
      const ka = (p.wrapped ? -D : 0) + p.c.drop, kb = (q.wrapped ? -D : 0) + q.c.drop;
      return newestOnTop ? (ka - kb) || (p.c.gi - q.c.gi) : (kb - ka) || (q.c.gi - p.c.gi);
    });
    if (pieces.length > MAX_LAYERS) {
      warnings.push(`Image Trail makes ${pieces.length} cards here; a template holds ${MAX_LAYERS}: raise the card spacing or lower the passes.`);
      pieces.splice(MAX_LAYERS);
    }
    const chOf = new Map(pieces.map((pc, i) => [pc, i]));

    const plateSrc = (pc) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * S)}" height="${Math.round(h * S)}"><rect width="100%" height="100%" fill="${P[`color${pc + 1}`] || PLATES[pc]}"/></svg>`)}`;
    const box = { w: r6(w * S), h: r6(h * S), fit: 'cover', radius: r6(rad * S) };
    const toX = (x) => (x * S / W) * 100, toY = (y) => (y * S / H) * 100;
    const usesMask = [inStyle, outStyle].some((st) => st === 'matte' || st === 'wipeH' || st === 'wipeV');
    // the card's share of its picture's layer, % (the host's cover fit, scriptAssembler fitBox): the mask's 100 %
    const maskBase = (m) => {
      const cw = w * S, ch = h * S, mm = m >= 0 ? media[m] : null;
      const known = mm && Number(mm.w) > 0 && Number(mm.h) > 0;
      const nw = known ? Number(mm.w) : cw, nh = known ? Number(mm.h) : ch;
      const fit = Math.min(1, W / nw, H / nh), pw = nw * fit, ph = nh * fit;
      const zm = Math.max(cw / pw, ch / ph);
      return [Math.min(100, (cw / (pw * zm)) * 100), Math.min(100, (ch / (ph * zm)) * 100)];
    };

    // MotionFast's card at age a, exactly (renderTrail): for the cards keyed by samples and for push
    const rawItem = (c, a) => {
      const st = fresh();
      if (inStyle !== 'cut' && a < rt) shapeState(st, inStyle, revealE(a / rt), 'in', P);
      if (a >= c.ex) shapeState(st, outStyle, 1 - clearE((a - c.ex) / cd), 'out', P);
      const mo = motion(c, idleOf(c), a);
      if (zoom) st.k *= Math.max(0.02, 1 + zoom * mtOf(a));
      const along = st.dx * w * 0.6;
      return { X: mo.x + mo.tx * along, Y: mo.y + mo.ty * along + st.dy * h * 0.6, ang: mo.ang + st.rot * DEG, st };
    };
    const alive = (c, t) => { let a = t - c.drop; if (seamless) a = mod(a, D); return a >= 0 && a < c.end ? a : null; };
    // MotionFast pulls in card order: a card pushed in moves onto its previous card AS PULLED ITSELF (pin only: the
    // tucks come after); a card tucked out moves onto its neighbour as drawn
    const pinItem = (c, a) => {
      const it = rawItem(c, a);
      if (it.st.pin > 0) {
        const nb = byJK.get(`${c.j}:${c.k - 1}`);
        const na = nb ? alive(nb, c.drop + a) : null;
        if (na !== null) { const o = pinItem(nb, na); it.X = lerp(it.X, o.X, it.st.pin); it.Y = lerp(it.Y, o.Y, it.st.pin); it.ang = lerp(it.ang, o.ang, it.st.pin); it.under = nb; } else it.st.k *= 1 - it.st.pin;
      }
      return it;
    };
    const itemAt = (c, a) => {
      const it = pinItem(c, a);
      const t = c.drop + a;
      if (it.st.pout > 0) {
        const dir = hold && P.clearOrder === 'head' ? -1 : 1;
        const together = hold && P.clearOrder === 'together';
        const nb = byJK.get(`${c.j}:${c.k + dir}`);
        const na = nb && !together ? alive(nb, t) : null;
        if (na !== null) {
          // the neighbour as drawn (it may be pulled itself, toward its own neighbour: MotionFast walks them in order)
          const o = itemAt(nb, na);
          it.X = lerp(it.X, o.X, it.st.pout); it.Y = lerp(it.Y, o.Y, it.st.pout); it.ang = lerp(it.ang, o.ang, it.st.pout); it.under = nb;
        } else it.st.k *= 1 - it.st.pout;
      }
      return it;
    };
    // sample times over [a0, a1]: every `step` s, plus the ends of the appear and the disappear (the motion turns
    // sharply there: a sample on each keeps the straight lines between samples on the curve)
    const sampleTimes = (c, a0, a1, step) => {
      const out = [];
      for (let a = a0; a < a1 - 1e-9; a += step) out.push(a);
      for (const b of [rt, c.ex, c.ex + cd]) if (b > a0 + 1e-6 && b < a1 - 1e-6) out.push(b);
      out.push(Math.max(a0, a1 - 1e-6));
      return [...new Set(out)].sort((x, y) => x - y);
    };
    const overlap = hold && cards.some((c) => inStyle !== 'cut' && c.ex < rt);
    const pushes = inStyle === 'push' || outStyle === 'push';

    const layers = [];
    pieces.forEach((pc) => {
      const c = pc.c;
      const I = idleOf(c);
      // the layer: the host keeps times to 1/10000 s and a layer at least 0.1 s long; the card's age at the layer's
      // own time is a0 + time − off, so the keys and the expression land on MotionFast's moments exactly. A life
      // shorter than 0.1 s gets a 0.1 s layer, hidden outside the life.
      const life = pc.a1 - pc.a0;
      let fs = Math.round(pc.from * 1e4) / 1e4;
      let span = Math.round((pc.from + life - fs) * 1e4) / 1e4;
      const short = span < 0.1;
      if (short) { span = 0.1; if (fs + span > D) fs = Math.round((D - span) * 1e4) / 1e4; }
      const off = pc.from - fs;
      const key = `card[${c.j}][${c.k}]${pc.wrapped ? '.wrap' : ''}`;
      const m = M ? (fill ? c.gi % M : (c.k < M ? c.k : -1)) : -1;
      const plate = c.gi % 4;
      const picture = m >= 0 ? { type: media[m].type === 'video' ? 'video' : 'image', media: m }
        : (M ? { type: 'image', src: plateSrc(plate) } : { type: 'image', media: plate, src: plateSrc(plate) });
      const A = Math.abs(pc.a0 - off) > 1e-12 ? `(time+${n(pc.a0 - off)})` : 'time';
      const pos = (a) => pct(a - pc.a0 + off, span);
      const [mw0, mh0] = usesMask ? maskBase(m) : [100, 100];
      const tracks = {}, fxs = {};
      const setTrack = (prop, keys, code) => { tracks[prop] = keys; if (code && code !== 'value') fxs[prop] = { type: 'custom', params: { code } }; };
      if (overlap || pushes || short) {
        // ── keyed by samples, 15 a second (overlapping phases; push: 30 a second; a life under 0.1 s: 4 samples)
        const times = sampleTimes(c, pc.a0, pc.a1, short ? Math.max(1e-3, life / 4) : (pushes ? 1 / 30 : 1 / 15));
        if (pushes) {
          // the moments a neighbour comes or goes: MotionFast's pushed card jumps there (pulled ↔ zoomed): a key
          // either side of it
          const dir = hold && P.clearOrder === 'head' ? -1 : 1;
          for (const nb of [byJK.get(`${c.j}:${c.k - 1}`), byJK.get(`${c.j}:${c.k + dir}`)].filter(Boolean)) {
            for (const tt of [nb.drop, nb.drop + nb.end]) {
              const a = tt - c.drop;
              if (a > pc.a0 + 2e-4 && a < pc.a1 - 2e-4) times.push(a - 1e-4, a);
            }
          }
          times.sort((x, y) => x - y);
        }
        const items = times.map((a) => itemAt(c, a));
        const col = {
          xPercent: items.map((it) => toX(it.X)), yPercent: items.map((it) => toY(it.Y)), rotate: items.map((it) => it.ang / DEG),
          scale: items.map((it) => Math.max(0, it.st.k) + 1), opacity: items.map((it) => clamp(it.st.alpha, 0, 1)), scaleX: items.map((it) => Math.max(0, it.st.fx) + 1),
          ...(usesMask ? { 'msk:m1:w': items.map((it) => it.st.mx * mw0 + 2), 'msk:m1:h': items.map((it) => it.st.my * mh0 + 2) } : {}),
        };
        const still = { rotate: 0, scale: 2, opacity: 1, scaleX: 2, 'msk:m1:w': mw0 + 2, 'msk:m1:h': mh0 + 2 };
        for (const [prop, vals] of Object.entries(col)) {
          if (prop in still && vals.every((v) => Math.abs(v - still[prop]) < 1e-9)) continue;
          setTrack(prop, times.map((a, i) => ({ position: pos(a), value: n(vals[i]), easing: 'Linear' })), prop === 'scale' || prop === 'scaleX' ? 'value-1' : (/^msk:/.test(prop) ? 'value-2' : null));
        }
        if (short) {
          // hidden outside the life: held at 0 before it and from its end
          const op = tracks.opacity || times.map((a) => ({ position: pos(a), value: '1', easing: 'Linear' }));
          const keys = [];
          if (pos(pc.a0) > 1e-6) keys.push({ position: 0, value: '0', easing: 'Hold' });
          keys.push(...op.slice(0, -1), { ...op[op.length - 1], easing: 'Hold' });
          if (pos(pc.a1) < 100 - 1e-6) keys.push({ position: pos(pc.a1), value: '0', easing: 'Hold' });
          setTrack('opacity', keys, null);
        }
        // pulled under a neighbour: below it while it is
        if (pushes) {
          const z = items.map((it) => {
            if (!it.under) return 0;
            const nbPiece = pieces.find((q) => q.c === it.under);
            const other = nbPiece ? chOf.get(nbPiece) : undefined;
            return other !== undefined && other < chOf.get(pc) ? (other - chOf.get(pc) - 0.5) * 0.1 : 0;
          });
          if (z.some((v) => v !== 0)) setTrack('translateZ', times.map((a, i) => ({ position: pos(a), value: n(z[i]), easing: 'Hold' })), null);
        }
      } else {
        // ── keys for the appear / disappear (the app's easings), the expression adds the motion after appear
        const phases = [];
        if (inStyle !== 'cut') phases.push({ a0: 0, a1: rt, style: inStyle, phase: 'in', ease: P.revealEase, E: revealE, from: 0, to: 1 });
        if (outStyle !== 'cut' && c.ex < c.end) phases.push({ a0: c.ex, a1: c.ex + cd, style: outStyle, phase: 'out', ease: P.clearEase, E: clearE, from: 1, to: 0 });
        const ends = (q, get) => { const s0 = fresh(), s1 = fresh(); shapeState(s0, q.style, q.from, q.phase, P); shapeState(s1, q.style, q.to, q.phase, P); return [get(s0), get(s1)]; };
        // the appear / disappear state at age a (no motion, no zoom)
        const envAt = (a) => {
          const st = fresh();
          if (inStyle !== 'cut' && a < rt) shapeState(st, inStyle, revealE(a / rt), 'in', P);
          if (a >= c.ex) shapeState(st, outStyle, 1 - clearE((a - c.ex) / cd), 'out', P);
          return st;
        };
        // a property over this piece of the life as keys: its value at the piece's start, then per phase that moves
        // it one segment on the phase's easing (exact) — or, for a phase this piece shows only part of (a card cut
        // at the loop's end), the shown part as samples 30 a second (an eased segment cut short is another curve).
        // (get: the property from a card state) null: the phases do not touch it here.
        const envKeys = (get) => {
          const ph = phases.filter((q) => { const [vA, vB] = ends(q, get); return Math.abs(vA - vB) > 1e-12 && Math.min(q.a1, pc.a1) > Math.max(q.a0, pc.a0) + 1e-9; });
          if (!ph.length) return null;
          const out = [{ position: 0, value: get(envAt(pc.a0)), easing: 'Linear' }];
          for (const q of ph) {
            const [vA, vB] = ends(q, get);
            const lo = Math.max(q.a0, pc.a0), hi = Math.min(q.a1, pc.a1);
            const whole = q.a0 >= pc.a0 - 1e-9 && q.a1 <= pc.a1 + 1e-9;
            const ke = KEY_EASE[q.ease] || { easing: 'Linear' };
            const at = (a) => vA + (vB - vA) * q.E((a - q.a0) / (q.a1 - q.a0));
            const put = (a, v, ease) => {
              const position = pos(a);
              if (Math.abs(out[out.length - 1].position - position) < 1e-9) out[out.length - 1] = { position, value: v, ...ease };
              else out.push({ position, value: v, ...ease });
            };
            if (whole && ke !== 'sample') {
              put(lo, vA, ke === 'fx' ? { easing: 'Linear' } : ke);
              put(hi, vB, { easing: 'Linear' });
            } else if (ke === 'fx') {
              // the expression writes this phase from the age: two plain keys hold its ends
              put(lo, at(lo), { easing: 'Linear' });
              put(hi, at(hi), { easing: 'Linear' });
            } else {
              const step = whole ? (q.a1 - q.a0) / 100 : 1 / 30;
              put(lo, at(lo), { easing: 'Linear' });
              for (let a = lo + step; a < hi - 1e-9; a += step) put(a, at(a), { easing: 'Linear' });
              put(hi, at(hi), { easing: 'Linear' });
            }
          }
          return out;
        };
        // the property as the expression reads it: the keys (value), except in a phase whose ease has no exact key
        // curve (Accelerate, Expo): written from the age there
        const envExpr = (get) => {
          let e = 'value';
          for (const q of phases) {
            if (KEY_EASE[q.ease] !== 'fx') continue;
            const [vA, vB] = ends(q, get);
            if (Math.abs(vA - vB) < 1e-12) continue;
            const u = `(${A}-${n(q.a0)})/${n(q.a1 - q.a0)}`;
            e = `(${A}>=${n(q.a0)}&&${A}<${n(q.a1)}?${n(vA)}+${n(vB - vA)}*${FX_EASE[q.ease](u)}:${e})`;
          }
          return e;
        };
        const keyed = (get, rest) => (envKeys(get) || [{ position: 0, value: rest, easing: 'Linear' }]).map((k) => ({ ...k, value: n(k.value) }));
        const plus = (e, d) => (d ? `${e}+${d}`.replace(/\+-/g, '-') : e);
        const mo = motionExpr(c, I, A);
        const slides = phases.filter((q) => q.style === 'slide');
        if (idleName === 'path') {
          // Along path: the place on the path is the path's own (no expression has it): its position and angle as
          // samples, 15 a second, straight between (the appear / disappear below are keys as everywhere)
          const times = sampleTimes(c, pc.a0, pc.a1, 1 / 15);
          const items = times.map((a) => itemAt(c, a));
          setTrack('xPercent', times.map((a, i) => ({ position: pos(a), value: n(toX(items[i].X)), easing: 'Linear' })), null);
          setTrack('yPercent', times.map((a, i) => ({ position: pos(a), value: n(toY(items[i].Y)), easing: 'Linear' })), null);
          if (items.some((it) => Math.abs(it.ang) > 1e-12)) setTrack('rotate', times.map((a, i) => ({ position: pos(a), value: n(items[i].ang / DEG), easing: 'Linear' })), null);
        } else if (idleName === 'swirl' && slides.length) {
          // a swirling card slides along its TURNING direction of travel: the keys hold the slide (px along it) and the
          // drop / rise offset (px down), each in its own phase; the expression turns the slide with the swirl
          const T = `(${n(amt * DEG)}*${MT(A)})`;
          const dx = I.x0 - ox, dy = I.y0 - oy;
          const gAl = (st) => st.dx * w * 0.6, gQ = (st) => st.dx * w * 0.6 + st.dy * h * 0.6;
          const inSlide = slides.map((q) => `(${A}>=${n(q.a0)}&&${A}<${n(q.a1)})`).join('||');
          const X = `${n(ox)}+${n(dx)}*cos${T}-${n(dy)}*sin${T}+(${n(I.tx)}*cos${T}-${n(I.ty)}*sin${T})*${envExpr(gAl)}`;
          const Y = `${n(oy)}+${n(dx)}*sin${T}+${n(dy)}*cos${T}+((${inSlide})?(${n(I.tx)}*sin${T}+${n(I.ty)}*cos${T})*${envExpr(gQ)}:${envExpr(gQ)})`;
          setTrack('xPercent', keyed(gAl, 0), `(${X})*${n(S / W * 100)}`.replace(/\+-/g, '-').replace(/--/g, '+'));
          setTrack('yPercent', keyed(gQ, 0), `(${Y})*${n(S / H * 100)}`.replace(/\+-/g, '-').replace(/--/g, '+'));
        } else {
          // position: the drop point and the slide / drop offsets (keys, % of the frame) + the motion (expression)
          const gx = (st) => toX(I.x0 + I.tx * st.dx * w * 0.6);
          const gy = (st) => toY(I.y0 + I.ty * st.dx * w * 0.6 + st.dy * h * 0.6);
          setTrack('xPercent', keyed(gx, gx(fresh())), plus(envExpr(gx), mo.dX && `(${mo.dX})*${n(S / W * 100)}`));
          setTrack('yPercent', keyed(gy, gy(fresh())), plus(envExpr(gy), mo.dY && `(${mo.dY})*${n(S / H * 100)}`));
        }
        // rotation, degrees: the card's angle and the spin style (keys) + the motion (expression)
        const base = P.cardRotate === 'path' ? I.pathAngle : I.base;
        const gr = (st) => (base + st.rot * DEG) / DEG;
        if (idleName !== 'path' && (envKeys(gr) || Math.abs(base) > 1e-12 || mo.dA)) setTrack('rotate', keyed(gr, gr(fresh())), plus(envExpr(gr), mo.dA && `(${mo.dA})*${n(1 / DEG)}`));
        // size: keys hold it + 1 (the editor keeps scale keys ≥ 0.1, and a card shrinks to nothing)
        const gk = (st) => st.k + 1;
        const zx = zoom ? `*max(0.02,1+${n(zoom)}*${MT(A)})` : '';
        // (an ease that overshoots below 0 would turn the card inside out: MotionFast skips it, so it is held at 0)
        if (envKeys(gk) || zoom) setTrack('scale', keyed(gk, 2), `max(0,${envExpr(gk)}-1)${zx}`);
        const ga = (st) => st.alpha;
        if (envKeys(ga)) setTrack('opacity', keyed(ga, 1), `clamp(${envExpr(ga)},0,1)`);
        const gf = (st) => st.fx + 1;
        if (envKeys(gf)) setTrack('scaleX', keyed(gf, 2), `max(0,${envExpr(gf)}-1)`);
        // matte / wipes: the card's mask narrows (its width and height, % of the layer). The editor keeps a mask at
        // 2 % or more (keys and drawing), so the keys hold the size + 2 and the expression takes the 2 off again:
        // exact down to 2 %, a 2 % sliver below that
        if (usesMask) {
          const gw = (st) => st.mx * mw0 + 2, gh = (st) => st.my * mh0 + 2;
          if (envKeys(gw)) setTrack('msk:m1:w', keyed(gw, mw0 + 2), `${envExpr(gw)}-2`);
          if (envKeys(gh)) setTrack('msk:m1:h', keyed(gh, mh0 + 2), `${envExpr(gh)}-2`);
        }
      }
      const layer = {
        ...picture, key, name: `Card ${c.gi + 1}${pc.wrapped ? ' (loop)' : ''}`, box,
        freeStart: fs, trimEnd: span,
        propertyKeyframes: tracks,
        ...(Object.keys(fxs).length ? { propertyKeyframeFx: fxs } : {}),
      };
      if (usesMask) {
        // the card's own mask (the host puts its fitted one in its place when the picture is cropped or rounded: the
        // same mask id, so the keys above drive that one)
        layer.layerEffects = [{ id: 'layerMask', eid: 'box-mask', enabled: true, params: { mskAmount: 100, mskQuality: 0 },
          masks: [{ mid: 'm1', name: 'Box', mode: 'add', enabled: true, inverted: false,
            // the unit box runs −0.5 … 0.5 (the host's box mask, scriptAssembler roundedRectPoints)
            path: { points: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) => ({ x, y, hIn: { x: 0, y: 0 }, hOut: { x: 0, y: 0 }, manual: true })), closed: true },
            x: 0, y: 0, w: r6(mw0), h: r6(mh0), rot: 0, feather: 0, expand: 0, opacity: 100, grow: 0 }] }];
      }
      layers.push(layer);
    });
    if (!layers.length) return { duration: D, layers: [{ key: 'empty', type: 'null', name: 'No cards' }], warnings: ['No card is dropped with these settings.'] };
    if (M && media.some((x) => x.type === 'video')) warnings.push('A video on a card plays once (no loop yet).');
    return { duration: D, layers, warnings: [...new Set(warnings)] };
  },
};

function pct(t, span) { return r6(clamp((t / span) * 100, 0, 100)); }
