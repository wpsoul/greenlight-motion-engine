// Toss (MotionFast `toss`): portrait picture cards are thrown up from below on ballistic arcs, hang at the top and drop
// back out, or land into a pile that then drops out. Throws come one by one, in pairs or volleys, from anywhere, the
// centre or a corner; Start / End on full frame zoom between one card filling the frame and the toss.
//
// Built from ordinary layers: one picture layer per throw of a card (a seamless loop throws a card again every turn of
// the clip: one layer per throw that is in it). A throw is a parabola: x and the turn are straight in time, y a
// quadratic (a Custom bezier on each side of the apex: exact). Only what no key curve draws is a ƒx: landing's little
// lift toward the camera (a half sine on the scale) and the creep after it lands (0.1·vx, easing out exponentially),
// and the full-frame hero (the sequence's own camera and the hero card's mask, as Tumble's).
//
// A built-in script (PLANS/ESSENTIAL_TEMPLATES.md §14): it imports nothing, so this same text also runs as a
// `kind: "script"` source. Numbers and timing are MotionFast's (motionTemplates/toss.js).
const REF_H = 1080;
const PLATES = ['#1d9bf1', '#f9492d', '#ffffff', '#33efab'];
const CARD_SHAPES = { '3:4': 3 / 4, '4:5': 4 / 5, '1:1': 1, '9:16': 9 / 16, '4:3': 4 / 3, '16:9': 16 / 9 };

// MotionFast's easings (motionTemplates/mtl.js getEase): the curve, and the editor's key easing that draws it exactly
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

// ── Toss ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// The decoded reel (MotionFast's REF): one apex every 1.5 s; per card [apex t, x, y, vx /s, rz °, spin °/s, height, g]
const TREF = {
  beat: 1.5, aspect: 0.745, radius: 20, hMean: 374.625, gMean: 392.125, fallTo: 770,
  cards: [
    [0.450, 144, -29, -80, -2.1, 2.7, 297, 396], [1.953, -79, 79, -78, -5.8, -3.2, 380, 377],
    [3.453, -203, -45, -3, -4.7, -3.3, 354, 422], [4.950, 198, 7, 34, 0, -2.9, 367, 401],
    [6.453, -220, 70, 60, -3.5, 3.1, 329, 357], [7.957, 183, 62, 18, -0.8, -3.3, 422, 389],
    [9.453, 166, 25, 24, 5.6, 3.1, 426, 410], [10.953, -187, 76, -49, -4.6, -3.1, 422, 385],
  ],
  fall: [[0, 0], [4, 3], [8, 7], [12, 15], [16, 31.4], [20, 67.3], [24, 139.6], [28, 292.7], [32, 606], [36, 1250]],
};
TREF.air = Math.sqrt(2 * TREF.fallTo / TREF.gMean);
const EXT_T = 600;
const LAUNCH_X = { center: 0, left: -0.42, right: 0.42 };
const refFall = (q) => keysAt(TREF.fall, clamp01(q) * 36) / 1250;

const DEFAULTS = { cardCount: 8, perThrow: 1, stagger: 0.08, beat: 0.5, airTime: 0.7, launch: 'scatter', drift: 100, apex: 0, spread: 100, seed: 1,
  tilt: 100, spin: 0, cardSize: 100, sizeVariety: 100, cardShape: '3:4', radius: 20, after: 'fall', holdTime: 0.6, exitTime: 1, seamless: true,
  startHero: false, endHero: false, heroHold: 0.8, heroTime: 1.8, heroEase: 'natural' };
const LOOKS = [
  ['toss', 'Toss', {}],
  ['pairs', 'Pairs', { cardCount: 10, perThrow: 2, stagger: 0.05, beat: 0.85, airTime: 1.05, drift: 170, spread: 125, apex: 4 }],
  ['fountain', 'Fountain', { cardCount: 12, perThrow: 4, stagger: 0.06, beat: 1.15, airTime: 1.15, launch: 'center', apex: 16, spread: 130, cardSize: 78, tilt: 160, spin: 50 }],
  ['arc-stream', 'Arc Stream', { cardCount: 12, beat: 0.3, airTime: 0.95, launch: 'right', apex: 10, spread: 75, cardSize: 68, sizeVariety: 60, tilt: 200, spin: 40 }],
  ['flick', 'Flick', { cardCount: 12, beat: 0.3, airTime: 0.55, apex: -12, drift: 260, tilt: 200, spin: 300, cardSize: 92 }],
  ['lob', 'Lob', { cardCount: 7, beat: 0.95, airTime: 1.55, apex: 21, drift: 35, tilt: 0, spin: 0, cardSize: 118, sizeVariety: 35, radius: 24 }],
  ['toss-land', 'Toss & Land', { after: 'land', cardCount: 9, beat: 0.42, airTime: 0.85, apex: 4, spread: 125, cardSize: 72, tilt: 320, spin: 140, holdTime: 0.8, exitTime: 0.9 }],
  ['hero-catch', 'Hero Catch', { cardCount: 6, endHero: true, heroTime: 1.4, heroHold: 1.0 }],
  ['original-pace', 'Original Pace', { beat: TREF.beat, airTime: +TREF.air.toFixed(3) }],
].map(([value, label, over]) => ({ value, label, params: { ...DEFAULTS, ...over } }));

const fields = [
  { type: 'group', key: 'gMedia', label: 'Media' },
  { key: 'media', type: 'media', label: 'Images / videos', slots: { from: 'media', max: 30 }, accept: 'media', ifFewer: 'reuse' },
  { key: 'fillEmpty', type: 'switch', label: 'Repeat media', default: true },
  { type: 'group', key: 'gPlates', label: 'Placeholders' },
  { key: 'color1', type: 'color', label: 'Fill 1', default: PLATES[0] },
  { key: 'color2', type: 'color', label: 'Fill 2', default: PLATES[1] },
  { key: 'color3', type: 'color', label: 'Fill 3', default: PLATES[2] },
  { key: 'color4', type: 'color', label: 'Fill 4', default: PLATES[3] },
  { type: 'group', key: 'gThrow', label: 'Throw' },
  { key: 'look', type: 'select', label: 'Look', default: 'toss', options: LOOKS },
  { key: 'cardCount', type: 'range', label: 'Cards', default: 8, min: 2, max: 30, step: 1, integer: true },
  { key: 'perThrow', type: 'range', label: 'Per throw', default: 1, min: 1, max: 5, step: 1, integer: true },
  { key: 'stagger', type: 'range', label: 'Throw stagger', default: 0.08, min: 0, max: 0.5, step: 0.01, suffix: 's' },
  { key: 'beat', type: 'range', label: 'Beat', default: 0.5, min: 0.15, max: 3, step: 0.01, suffix: 's' },
  { key: 'airTime', type: 'range', label: 'Air time', default: 0.7, min: 0.3, max: 3, step: 0.01, suffix: 's' },
  { key: 'launch', type: 'select', label: 'Thrown from', default: 'scatter', options: [
    { value: 'scatter', label: 'Anywhere' }, { value: 'center', label: 'Centre' }, { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' },
  ] },
  { key: 'drift', type: 'range', label: 'Drift', default: 100, min: 0, max: 300, step: 1, suffix: '%', showIf: { key: 'launch', equals: 'scatter' } },
  { key: 'apex', type: 'range', label: 'Apex height', default: 0, min: -30, max: 40, step: 0.5, suffix: '%' },
  { key: 'spread', type: 'range', label: 'Spread', default: 100, min: 0, max: 250, step: 1, suffix: '%' },
  { key: 'seed', type: 'range', label: 'Shuffle', default: 1, min: 1, max: 99, step: 1, integer: true },
  { type: 'group', key: 'gSpin', label: 'Rotation' },
  { key: 'tilt', type: 'range', label: 'Tilt', default: 100, min: 0, max: 600, step: 1, suffix: '%' },
  { key: 'spin', type: 'range', label: 'Spin', default: 0, min: -720, max: 720, step: 1, suffix: '°/s' },
  { type: 'group', key: 'gCards', label: 'Cards' },
  { key: 'cardSize', type: 'range', label: 'Card size', default: 100, min: 30, max: 200, step: 1, suffix: '%' },
  { key: 'sizeVariety', type: 'range', label: 'Size variety', default: 100, min: 0, max: 200, step: 1, suffix: '%' },
  { key: 'cardShape', type: 'select', label: 'Card shape', default: '3:4', options: [
    { value: '3:4', label: '3:4 portrait (reel)' }, { value: '4:5', label: '4:5 portrait' }, { value: '1:1', label: 'Square' },
    { value: '9:16', label: '9:16 portrait' }, { value: '4:3', label: '4:3 landscape' }, { value: '16:9', label: '16:9 landscape' },
  ] },
  { key: 'radius', type: 'range', label: 'Corner radius', default: 20, min: 0, max: 150, step: 1, suffix: 'px' },
  { type: 'group', key: 'gLand', label: 'Landing' },
  { key: 'after', type: 'select', label: 'After the apex', default: 'fall', options: [
    { value: 'fall', label: 'Fall back out (reel)' }, { value: 'land', label: 'Land and stay, the pile drops out at the end' },
  ] },
  { key: 'holdTime', type: 'range', label: 'Pile hold', default: 0.6, min: 0, max: 5, step: 0.05, suffix: 's', showIf: { key: 'after', equals: 'land' } },
  { key: 'exitTime', type: 'range', label: 'Drop-out time', default: 1, min: 0.2, max: 4, step: 0.05, suffix: 's', showIf: { key: 'after', equals: 'land' } },
  { key: 'seamless', type: 'switch', label: 'Seamless loop', default: true, showIf: { key: 'after', equals: 'fall' } },
  { type: 'group', key: 'gHero', label: 'Hero' },
  { key: 'startHero', type: 'switch', label: 'Start from full frame', default: false },
  { key: 'endHero', type: 'switch', label: 'End on full frame', default: false },
  { key: 'heroHold', type: 'range', label: 'Full-frame hold', default: 0.8, min: 0, max: 5, step: 0.05, suffix: 's' },
  { key: 'heroTime', type: 'range', label: 'Zoom time', default: 1.8, min: 0.3, max: 5, step: 0.05, suffix: 's' },
  { key: 'heroEase', type: 'select', label: 'Zoom easing', default: 'natural', options: EASE_OPTIONS },
];

// MotionFast's schedule: the cards and every time the clip needs
function schedule(S) {
  const N = Math.max(1, Math.round(clamp(num(S.cardCount, 8), 1, 60)));
  const pt = Math.max(1, Math.round(clamp(num(S.perThrow, 1), 1, 6)));
  const B = Math.ceil(N / pt);
  const beat = Math.max(0.05, num(S.beat, 0.5)), stagger = Math.max(0, num(S.stagger, 0.08));
  const air = Math.max(0.15, num(S.airTime, 1)), kT = TREF.air / air;
  const apexUp = num(S.apex, 0) / 100 * REF_H;
  const land = S.after === 'land';
  const start = !!S.startHero, end = !!S.endHero;
  const hh = Math.max(0, num(S.heroHold, 0.8)), ht = Math.max(0.05, num(S.heroTime, 1.8));
  const loop = !land && S.seamless !== false && !start && !end;
  const seed = Math.max(1, Math.round(num(S.seed, 1)));
  const slots = Array.from({ length: N }, (_, k) => k);
  for (let k = N - 1; k > 0; k -= 1) { const j = Math.floor(hash01(k, seed * 59) * (k + 1)); [slots[k], slots[j]] = [slots[j], slots[k]]; }
  const cards = [];
  for (let i = 0; i < N; i += 1) {
    const R = (k) => hash01(i, seed * 131 + k);
    const grp = Math.floor(i / pt), mem = i % pt, nn = Math.min(pt, N - grp * pt);
    let ax, ay, vx, rz, sp, hz, gk;
    if (seed === 1 && pt === 1 && i < TREF.cards.length) {
      const c = TREF.cards[i];
      [ax, ay, vx, rz, sp, hz, gk] = [c[1], c[2], c[3], c[4], c[5], c[6], c[7] / TREF.gMean];
    } else if (nn > 1) {
      const f = (mem / (nn - 1)) * 2 - 1, sgn = f < 0 ? -1 : f > 0 ? 1 : (R(1) < 0.5 ? -1 : 1);
      ax = f * (90 + 45 * nn) + (R(2) * 2 - 1) * 40 + (hash01(grp, seed * 977) * 2 - 1) * 70;
      ay = -25 + 70 * R(3) - 45 * (1 - Math.abs(f));
      vx = sgn * (25 + 45 * R(4)) * (f === 0 ? 0.3 : 1);
      rz = f * 4 + (R(5) * 2 - 1) * 2.5;
      sp = sgn * (2.7 + 0.6 * R(6));
      hz = 297 + 129 * R(7); gk = 0.91 + 0.17 * R(8);
    } else {
      const side = (i % 2 ? -1 : 1) * (R(1) < 0.15 ? -1 : 1);
      ax = side * (70 + 160 * R(2)); ay = -50 + 130 * R(3); vx = (R(4) * 2 - 1) * 80;
      rz = (R(5) * 2 - 1) * 6; sp = (R(6) < 0.5 ? -1 : 1) * (2.7 + 0.6 * R(7));
      hz = 297 + 129 * R(8); gk = 0.91 + 0.17 * R(9);
    }
    const g = TREF.gMean * gk * kT * kT;
    const xn = N > 1 ? ((slots[i] + 0.25 + 0.5 * R(11)) / N) * 2 - 1 : 0;
    const yR = (R(12) * 2 - 1) * 120, lift = Math.max(60, 300 + apexUp);
    const Y = land ? yR - lift : ay - apexUp;
    const td = land ? Math.sqrt(2 * lift / g) : 0;
    const tT = Math.sqrt(2 * Math.max(1, REF_H / 2 + EXT_T - Y) / g);
    cards.push({ i, grp, mem, ax, ay, vx, rz, sp, hz, g, Y, xn, yR, td, tT, sg: sp < 0 ? -1 : 1, off: grp * beat + mem * stagger, ta: 0 });
  }
  let D, te = 0, tz = 0;
  const T = B * beat;
  if (loop) {
    cards.forEach((c) => { c.ta = 0.3 * beat + c.off; });
    D = T;
  } else {
    const lead = start && N > 1 ? cards[1] : cards[0];
    const enter = start ? hh + 0.6 * ht : 0;
    const base = enter + lead.tT - lead.off;
    cards.forEach((c) => { c.ta = base + c.off; });
    if (start) cards[0].ta = hh + 0.5 * ht;
    const last = cards[N - 1];
    if (land) {
      te = Math.max(...cards.map((c) => c.ta + c.td * 1.5)) + Math.max(0, num(S.holdTime, 0.6));
      D = end ? te + ht + hh : te + Math.max(0.1, num(S.exitTime, 1)) + 0.05;
      tz = te;
    } else if (end) {
      tz = last.ta - 0.3 * ht;
      D = tz + ht + hh;
    } else {
      D = Math.max(...cards.map((c) => c.ta + c.tT)) + 0.05;
    }
  }
  return { N, pt, B, beat, air, kT, land, start, end, hh, ht, loop, T, te, tz, D: Math.max(0.5, D), cards };
}

export default {
  id: 'toss',
  name: 'Toss',
  category: 'Carousels',
  v: 1,
  fields,
  build({ settings: S, media, frame }) {
    const { W: FW, H: FH } = frame;
    const sc = schedule(S);
    const { N, land, start, end, hh, ht, loop, T, te, tz, D, kT } = sc;
    const Sx = FH / REF_H, W = FW / Sx, H = REF_H;
    const xS = Math.sqrt(W / REF_H);
    const aspect = CARD_SHAPES[S.cardShape] || 0.75;
    const sizeK = Math.max(0.05, num(S.cardSize, 100) / 100), variety = Math.max(0, num(S.sizeVariety, 100)) / 100;
    const spread = Math.max(0, num(S.spread, 100)) / 100, drift = Math.max(0, num(S.drift, 100)) / 100;
    const tiltK = Math.max(0, num(S.tilt, 100)) / 100, spin = num(S.spin, 0);
    const radius0 = Math.max(0, num(S.radius, TREF.radius));
    const launch = ['scatter', 'center', 'left', 'right'].includes(S.launch) ? S.launch : 'scatter';
    const xL = launch === 'scatter' ? null : LAUNCH_X[launch] * W;
    const M = media.length, fill = S.fillEmpty !== false;
    const warnings = [];
    // layer times (the host keeps them to 1/10000 s): a layer starts at or just before its first key and ends at or just
    // after its last (no key is pulled inside it; a card's layers never share a channel, so they may touch), inside the clip
    const at4 = (t) => (Math.abs(t - D) < 1e-9 ? r4(D) : Math.floor(t * 1e4 + 1e-7) / 1e4);
    const to4 = (t) => Math.min(r4(D), Math.ceil(t * 1e4 - 1e-7) / 1e4);
    const xp = (x) => (x * Sx / FW) * 100, yp = (y) => (y * Sx / FH) * 100;
    // a layer lasts at least 0.1 s (the editor's shortest): a shorter stretch of a card is drawn on a 0.1 s layer that is
    // hidden (opacity held at 0) outside its own times
    const atLeast = (from, to) => {
      if (to - from >= 0.1002) return { from, to, hide: null };
      let a = from - (0.1003 - (to - from)), b = to;
      if (a < 0) { b = Math.min(D, b - a); a = 0; }
      return { from: a, to: b, hide: [from, to] };
    };
    const hideKeys = (L, fs, span) => {
      const pos = (t) => r6(clamp(((t - fs) / span) * 100, 0, 100));
      const k = [{ position: 0, value: L.hide[0] > fs + 1e-7 ? '0' : '1', easing: 'Hold' }];
      if (L.hide[0] > fs + 1e-7) k.push({ position: pos(L.hide[0]), value: '1', easing: 'Hold' });
      if (L.hide[1] < L.to - 1e-7) k.push({ position: pos(L.hide[1]), value: '0', easing: 'Hold' });
      return k;
    };

    // each card's flight (MotionFast layoutCards): size, apex / landing spot, drift, turn
    for (const c of sc.cards) {
      const hz = Math.max(20, (TREF.hMean + (c.hz - TREF.hMean) * variety) * sizeK);
      const A = hz * hz * TREF.aspect;
      c.w = Math.sqrt(A * aspect); c.h = Math.sqrt(A / aspect);
      c.ext = 0.5 * Math.hypot(c.w, c.h); c.r = radius0 * hz / TREF.hMean;
      c.rz0 = c.rz * tiltK;
      c.tE = Math.sqrt(2 * Math.max(1, H / 2 + c.ext - c.Y) / c.g);   // frame bottom → apex
      if (!land) {
        c.X = c.ax * spread * xS;
        c.vxx = xL === null ? c.vx * kT * drift * xS : (c.X - xL) / c.tE;
        const sg = xL === null ? c.sg : (c.vxx >= 0 ? 1 : -1);
        c.om = (xL === null ? c.sp : sg * Math.abs(c.sp)) * kT + spin * sg;
      } else {
        c.xR = c.xn * 0.3 * W * spread;
        c.vxx = xL === null ? c.vx * kT * drift * xS : (c.xR - xL) / (c.tE + c.td);
        const sg = xL === null ? c.sg : (c.vxx >= 0 ? 1 : -1);
        c.om = (xL === null ? c.sp : sg * Math.abs(c.sp)) * kT + spin * sg;
        c.tl = c.ta + c.td;                                          // it lands
        c.v1 = 0.25 * c.g * c.td; c.hop = 2 * c.v1 / c.g;
      }
      c.m = M && (fill || c.i < M) ? c.i % M : -1;
    }
    // Land: the whole pile drops out at the end (Tumble's fall), by enough for its lowest card
    let pileDrop = 0;
    if (land && !end) {
      let need = 0;
      for (const c of sc.cards) need = Math.max(need, H / 2 - c.yR + c.ext);
      pileDrop = need + 4;
    }
    const exitTime = Math.max(0.1, num(S.exitTime, 1));
    // a card's place at time t (world px about the frame centre; tau = time from its apex) before the camera
    const fallPose = (c, tau) => ({ x: c.X + c.vxx * tau, y: c.Y + 0.5 * c.g * tau * tau, rz: c.rz0 + c.om * tau, s: 1 });
    const landPose = (c, t) => {
      if (start && c.i === 0) return { x: c.xR, y: c.yR + (t > te && !end ? pileDrop * refFall((t - te) / exitTime) : 0), rz: c.rz0, s: 1 };
      const tau = t - c.ta;
      let x, y, rz, s = 1;
      if (tau < c.td) {
        x = c.xR - c.vxx * (c.td - tau); y = c.Y + 0.5 * c.g * tau * tau; rz = c.rz0 + c.om * (tau - c.td);
        s = 1 + 0.1 * Math.sin(Math.PI * clamp01((tau + c.tE) / (c.tE + c.td)));
      } else {
        const u = tau - c.td, k = 0.1 * (1 - Math.exp(-u / 0.1));
        x = c.xR + c.vxx * k; y = c.yR - (u < c.hop ? c.v1 * u - 0.5 * c.g * u * u : 0); rz = c.rz0 + c.om * k;
      }
      if (t > te && !end) y += pileDrop * refFall((t - te) / exitTime);
      return { x, y, rz, s };
    };

    const pictureOf = (c) => {
      const box = { w: r6(c.w * Sx), h: r6(c.h * Sx), fit: 'cover', radius: r6(c.r * Sx) };
      const plate = S[`color${(c.i % 4) + 1}`] || PLATES[c.i % 4];
      const plateSrc = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(box.w)}" height="${Math.round(box.h)}"><rect width="100%" height="100%" fill="${plate}"/></svg>`)}`;
      const pic = c.m >= 0 ? { type: media[c.m].type === 'video' ? 'video' : 'image', media: c.m } : (M ? { type: 'image', src: plateSrc } : { type: 'image', media: c.i, src: plateSrc });
      const mm = c.m >= 0 ? media[c.m] : null;
      // the picture's plate as the renderer draws it (its pixels shrunk into the frame: an example plate is the SVG above,
      // whole px) and the host's cover zoom of the card (scriptAssembler fitBox, which takes an example at the box's size)
      const known = !!(mm && Number(mm.w) > 0 && Number(mm.h) > 0);
      const nw = known ? Number(mm.w) : Math.round(box.w), nh = known ? Number(mm.h) : Math.round(box.h);
      const k = Math.min(1, FW / nw, FH / nh);
      const hw = known ? nw : box.w, hh2 = known ? nh : box.h, hk = Math.min(1, FW / hw, FH / hh2);
      return { pic, box, pw: nw * k, ph: nh * k, z0: Math.max(box.w / (hw * hk), box.h / (hh2 * hk)) };
    };

    const layers = [];      // bottom to top
    const tops = [];        // a start hero is drawn over the pile while it fills the frame (MotionFast heroOnTop)
    const cams = [];
    const othersEnd = end ? Math.min(D, tz + ht) : D;              // once the end hero fills the frame it is all that is drawn

    // Fall: one layer per throw of a card, while it is above the frame's bottom edge: x and the turn straight, y a
    // parabola (a quadratic: a Custom bezier each side of the apex)
    const throwLayer = (c, pic, key, name, from, to, apexAt) => {
      const L = atLeast(from, to);
      const fs = at4(L.from), span = to4(L.to) - fs;
      const tau = (t) => t - apexAt;
      const pose = (t) => fallPose(c, c.endHeroCatch ? Math.min(0, tau(t)) : c.startHeroFall ? Math.max(0, tau(t)) : tau(t));
      const yPieces = apexAt > from && apexAt < to ? [[from, apexAt, 'cubic'], [apexAt, to, 'cubic']] : [[from, to, 'cubic']];
      const xPieces = apexAt > from && apexAt < to && (c.endHeroCatch || c.startHeroFall) ? [[from, apexAt, 'line'], [apexAt, to, 'line']] : [[from, to, 'line']];
      return { ...pic.pic, key, name, box: pic.box, freeStart: fs, trimEnd: r6(span),
        propertyKeyframes: {
          xPercent: trackKeys((t) => xp(pose(t).x), xPieces, fs, span),
          yPercent: trackKeys((t) => yp(pose(t).y), yPieces, fs, span),
          rotate: trackKeys((t) => pose(t).rz, xPieces, fs, span),
          ...(L.hide ? { opacity: hideKeys(L, fs, span) } : {}),
        } };
    };
    // Land: the flight (straight x and turn, the parabola), a little nearer the camera mid-air (a half sine on the
    // scale: ƒx), lands with a hop (a parabola), and creeps on 0.1·vx (x and the turn ease out exponentially: ƒx added
    // to the keys); at the end the pile drops out (the reel's fall, straight between its frames)
    const landLayer = (c, pic, key, name, from, to) => {
      const L = atLeast(from, to);
      const fs = at4(L.from), span = to4(L.to) - fs, off = -fs;
      const isHero0 = start && c.i === 0;
      const pose = (t) => landPose(c, clamp(t, from, to));
      const exitPcs = !end ? TREF.fall.slice(0, -1).map(([f], k) => [te + (f / 36) * exitTime, te + (TREF.fall[k + 1][0] / 36) * exitTime, 'line']) : [];
      const clip = (pcs) => pcs.filter(([a, b]) => b > from + 1e-9 && a < to - 1e-9).map(([a, b, how]) => [Math.max(a, from), Math.min(b, to), how]);
      const tracks = {}, fx = {};
      if (isHero0) {
        tracks.xPercent = [{ position: 0, value: n(xp(c.xR)), easing: 'Linear' }];
        tracks.yPercent = trackKeys((t) => yp(pose(t).y), clip(exitPcs), fs, span);
        tracks.rotate = [{ position: 0, value: n(c.rz0), easing: 'Linear' }];
      } else {
        const tl = c.tl;
        const base = (t) => (t < tl ? pose(t) : { x: c.xR, rz: c.rz0 });   // the keys: the flight, then the spot (the creep is the ƒx)
        tracks.xPercent = trackKeys((t) => xp(base(t).x), clip([[from, tl, 'line']]), fs, span);
        tracks.rotate = trackKeys((t) => base(t).rz, clip([[from, tl, 'line']]), fs, span);
        const yP = [[from, c.ta, 'cubic'], [c.ta, tl, 'cubic'], [tl, tl + c.hop / 2, 'cubic'], [tl + c.hop / 2, tl + c.hop, 'cubic'], ...exitPcs];
        tracks.yPercent = trackKeys((t) => yp(pose(t).y), clip(yP), fs, span);
        const tlL = tl + off;
        fx.xPercent = { type: 'custom', params: { code: `value+(time>${n(tlL)}?${n(xp(c.vxx * 0.1))}*(1-exp(-(time-${n(tlL)})/0.1)):0)` } };
        fx.rotate = { type: 'custom', params: { code: `value+(time>${n(tlL)}?${n(c.om * 0.1)}*(1-exp(-(time-${n(tlL)})/0.1)):0)` } };
        if (from < tl) {
          tracks.scale = [{ position: 0, value: '1', easing: 'Linear' }];
          fx.scale = { type: 'custom', params: { code: `1+(time<${n(tlL)}?0.1*sin(${n(Math.PI)}*clamp((time-${n(c.ta - c.tE + off)})/${n(c.tE + c.td)},0,1)):0)` } };
        }
      }
      if (L.hide) tracks.opacity = hideKeys(L, fs, span);
      return { ...pic.pic, key, name, box: pic.box, freeStart: fs, trimEnd: r6(span), propertyKeyframes: tracks,
        ...(Object.keys(fx).length ? { propertyKeyframeFx: fx } : {}) };
    };

    // the full-frame hero (as Tumble): MotionFast's 2D camera X = C + Z·(s − F), Z = Z0^(1−e), F = h − e·(h − C)/Z is the
    // sequence's camera (camZoom = Z, its pan = (Z − e)·(h − C)); the hero card grows from the frame to its size (its
    // mask, its cover scale, its corners) and turns by e·rz. Here the hero may move while the camera zooms (it starts
    // to fall half way through the pull-back; the last card is caught rising to its apex): its place h(t) and turn are
    // written in the ƒx from the clip's time. The key tracks hold the zoom's eased progress p (Expo: its share q).
    const heroEase = S.heroEase && EASES[S.heroEase] ? S.heroEase : 'natural';
    const hExpo = heroEase === 'expo';
    const heroQ = (t, which) => clamp01((t - (which === 'start' ? hh : tz)) / ht);
    const heroE = (t, which) => { const p = easeOf(heroEase)[0](heroQ(t, which)); return which === 'start' ? p : 1 - p; };
    const heroDriver = (t, which) => (hExpo ? heroQ(t, which) : easeOf(heroEase)[0](heroQ(t, which)));
    // MotionFast films through the hero only while the hero card is in its frame (a card below it or off its side is not
    // drawn, and then there is no hero): the pull-back ends early if the first card has fallen out, the push-in starts
    // once the last card has risen into view
    const heroWindow = (c, which) => {
      let t0 = which === 'start' ? 0 : tz, t1 = which === 'start' ? Math.min(D, hh + ht) : D;
      if (!land) {
        let a = -c.tE, b = c.tE;                                   // above the frame's bottom edge
        if (Math.abs(c.vxx) > 1e-9) {                              // not off its sides: |X + vx·tau| ≤ W/2 + ext
          const lim = W / 2 + c.ext, r1 = (-lim - c.X) / c.vxx, r2 = (lim - c.X) / c.vxx;
          a = Math.max(a, Math.min(r1, r2)); b = Math.min(b, Math.max(r1, r2));
        } else if (Math.abs(c.X) > W / 2 + c.ext) { a = 1; b = 0; }
        if (which === 'start') t1 = Math.min(t1, a <= 0 && b >= 0 ? c.ta + b : 0);
        else t0 = Math.max(t0, a <= 0 && b >= 0 ? c.ta + a : D);
      }
      return [t0, t1];
    };
    const heroLayers = (c, which, pic) => {
      const [t0, t1] = heroWindow(c, which);
      if (t1 - t0 < 1e-6) return null;
      if (t1 - t0 < 0.1) { warnings.push('The hero card is in the frame for under 0.1 s of its zoom: that zoom is left out.'); return null; }
      const fs = at4(t0), span = to4(t1) - fs, off = -fs;           // ƒx time + fs = the clip's time
      const pcs = (which === 'start' ? [[0, hh, 'line'], [hh, hh + ht, hExpo ? 'line' : heroEase]] : [[tz, tz + ht, hExpo ? 'line' : heroEase], [tz + ht, D, 'line']])
        .map(([a, b, how]) => [Math.max(a, t0), Math.min(b, t1), how]);
      const eKeys = (shift) => trackKeys((t) => heroDriver(t, which) + shift, pcs, fs, span);
      const E = (shift) => {
        const v = shift ? `(value-${shift})` : 'value';
        const p = hExpo ? `(${v}>=1?1:1-pow(2,-10*${v}))` : v;
        return which === 'start' ? p : `(1-${p})`;
      };
      // the hero's place and turn (world px) as expressions of the layer's time, and in JS for the corners' samples
      let hx, hy, hr;
      if (!land) {
        const ta = n(c.ta + off), tau = which === 'start' ? `max(0,time-${ta})` : `min(0,time-${ta})`;
        hx = `(${n(c.X)}+${n(c.vxx)}*${tau})`; hy = `(${n(c.Y)}+${n(0.5 * c.g)}*pow(${tau},2))`; hr = `(${n(c.rz0)}+${n(c.om)}*${tau})`;
      } else if (which === 'start') {
        hx = n(c.xR); hy = n(c.yR); hr = n(c.rz0);
      } else {
        const kk = `0.1*(1-exp(-max(0,time-${n(c.tl + off)})/0.1))`;
        hx = `(${n(c.xR)}+${n(c.vxx)}*${kk})`; hy = n(c.yR); hr = `(${n(c.rz0)}+${n(c.om)}*${kk})`;
      }
      const Z0 = 1.003 * Math.max(FW / (c.w * Sx), FH / (c.h * Sx));
      const w0 = FW / Z0, h0 = FH / Z0, cw = c.w * Sx, ch = c.h * Sx;
      const z0 = pic.z0;
      const lnZ0 = Math.log(Z0);
      const steps = Math.max(2, Math.ceil((t1 - t0) * 30));
      const pathKeys = [];
      for (let j = 0; j <= steps; j += 1) {
        const t = t0 + ((t1 - t0) * j) / steps, e = heroE(t, which);
        const Wd = w0 + (cw - w0) * e, Hd = h0 + (ch - h0) * e, rr = c.r * Sx * e;
        pathKeys.push({ position: r6(clamp(((t - fs) / span) * 100, 0, 100)), value: JSON.stringify(roundRect8(clamp(rr / Wd, 0, 0.5), clamp(rr / Hd, 0, 0.5))), easing: 'Linear' });
      }
      const kx = (a) => `(${n(w0 / pic.pw)}+${n((cw - w0) / pic.pw)}*${a})`, ky = (a) => `(${n(h0 / pic.ph)}+${n((ch - h0) / pic.ph)}*${a})`;
      const one = (v) => [{ position: 0, value: v, easing: 'Linear' }];
      const card = {
        ...pic.pic, key: `card[${c.i}].hero`, name: `Card ${c.i + 1} (full frame)`, box: pic.box, freeStart: fs, trimEnd: r6(span),
        propertyKeyframes: { xPercent: one('0'), yPercent: one('0'), rotate: eKeys(0), scale: eKeys(1), 'msk:m1:w': eKeys(2), 'msk:m1:h': eKeys(2), 'msk:m1:path': pathKeys },
        propertyKeyframeFx: {
          xPercent: { type: 'custom', params: { code: `${hx}*${n((Sx / FW) * 100)}` } },
          yPercent: { type: 'custom', params: { code: `${hy}*${n((Sx / FH) * 100)}` } },
          rotate: { type: 'custom', params: { code: `${hr}*${E(0)}` } },
          scale: { type: 'custom', params: { code: `max(${kx(E(1))},${ky(E(1))})/${n(z0)}` } },
          'msk:m1:w': { type: 'custom', params: { code: `100*${kx(E(2))}/max(${kx(E(2))},${ky(E(2))})` } },
          'msk:m1:h': { type: 'custom', params: { code: `100*${ky(E(2))}/max(${kx(E(2))},${ky(E(2))})` } },
        },
        layerEffects: [{ id: 'layerMask', eid: 'box-mask', enabled: true, params: { mskAmount: 100, mskQuality: 0 },
          masks: [{ mid: 'm1', name: 'Box', mode: 'add', enabled: true, inverted: false, path: { points: roundRect8(0, 0), closed: true },
            x: 0, y: 0, w: r6((100 * cw) / (pic.pw * z0)), h: r6((100 * ch) / (pic.ph * z0)), rot: 0, feather: 0, expand: 0, opacity: 100, grow: 0 }] }],
      };
      const Zx = `exp((1-${E(0)})*${n(lnZ0)})`;
      const camera = {
        key: `camera.${which}`, type: 'camera', name: which === 'start' ? 'Pull back' : 'Push in', freeStart: fs, trimEnd: r6(span),
        propertyKeyframes: { camZoom: eKeys(1), camX: eKeys(0), camY: eKeys(0) },
        propertyKeyframeFx: {
          camZoom: { type: 'custom', params: { code: `exp((1-${E(1)})*${n(lnZ0)})` } },
          camX: { type: 'custom', params: { code: `(${Zx}-${E(0)})*${hx}*${n((100 * Sx) / FW)}` } },
          camY: { type: 'custom', params: { code: `(${Zx}-${E(0)})*${hy}*${n((100 * Sx) / FH)}` } },
        },
      };
      return { card, camera };
    };

    for (const c of sc.cards) {
      const pic = pictureOf(c);
      const isStartHero = start && c.i === 0, isEndHero = end && c.i === N - 1;
      const own = [];
      if (isStartHero) {
        const hl = heroLayers(c, 'start', pic);
        if (hl) { tops.push(hl.card); cams.push(hl.camera); }
      }
      if (!land) {
        const reach = loop ? Math.min(c.tE, 1.5 * T) : c.tE;
        if (isStartHero) {
          c.startHeroFall = true;
          const from = Math.min(D, hh + ht), to = Math.min(othersEnd, c.ta + c.tE);
          if (to - from > 1e-6) own.push(throwLayer(c, pic, `card[${c.i}]`, `Card ${c.i + 1}`, from, to, c.ta));
        } else if (isEndHero) {
          c.endHeroCatch = true;
          const from = Math.max(0, c.ta - c.tE), to = Math.min(D, heroWindow(c, 'end')[0]);
          if (to - from > 1e-6) own.push(throwLayer(c, pic, `card[${c.i}]`, `Card ${c.i + 1}`, from, to, c.ta));
        } else if (loop) {
          // a seamless loop: the throw again every T, each one a layer where it is in the clip
          const copies = [];
          for (let m = Math.floor((0 - c.ta - reach) / T) - 1; m <= Math.ceil((D - c.ta + reach) / T) + 1; m += 1) {
            const apex = c.ta + m * T, from = Math.max(0, apex - reach), to = Math.min(D, apex + reach);
            if (to - from > 1e-6) copies.push({ m, apex, from, to });
          }
          // MotionFast draws a card's copies newest first (the older throw on top)
          copies.sort((a, b) => b.from - a.from).forEach((k, j) => own.push(throwLayer(c, pic, `card[${c.i}].throw[${k.m}]`, `Card ${c.i + 1}${j ? ` (${j + 1})` : ''}`, k.from, k.to, k.apex)));
        } else {
          const from = Math.max(0, c.ta - c.tE), to = Math.min(othersEnd, c.ta + c.tE);
          if (to - from > 1e-6) own.push(throwLayer(c, pic, `card[${c.i}]`, `Card ${c.i + 1}`, from, to, c.ta));
        }
      } else {
        const from = isStartHero ? Math.min(D, hh + ht) : Math.max(0, c.ta - c.tE);
        const to = isEndHero ? Math.min(D, tz) : othersEnd;
        if (to - from > 1e-6) own.push(landLayer(c, pic, `card[${c.i}]`, `Card ${c.i + 1}`, from, to));
      }
      layers.push(...own);
      if (isEndHero) {
        const hl = heroLayers(c, 'end', pic);
        if (hl) { layers.push(hl.card); cams.push(hl.camera); }
      }
    }
    if (M && media.some((x) => x.type === 'video')) warnings.push('A video on a card plays once (no loop yet).');
    return { duration: D, layers: [...layers, ...tops, ...cams], warnings };
  },
};
