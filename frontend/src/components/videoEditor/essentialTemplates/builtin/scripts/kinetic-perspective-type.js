// Kinetic Perspective Type (MotionFast `kinetic-perspective-type`): lines of type drive in one after another on a
// 3D-tilted plane, each arrival shoving the earlier lines up the plane where perspective shrinks them; the block then
// snaps flat, and an optional word pushes in from the right while its line slides over to make room.
//
// Built from ordinary layers in the editor's real 3D. Every WORD is a text layer (MotionFast rasterises each word once
// and draws it as a perspective quad: one plane per word, no depth per letter). The plane and its pose are a chain of
// nulls, the way MotionFast composes them (block point → minus the pivot → scale → turn Z, then X, then Y → plus the
// pivot and the offset → perspective about the frame's centre):
//   World (scale lens / P)  →  Pose (pivot + offset; Rotate Y)  →  Tilt (Rotate X, Rotate Z, scale)  →  Pivot (− pivot)
//   →  Shove n−1 → … → Shove 1 (each later line's own push up the plane: its slot height × (1 − its entrance))
//   →  Line i (its place, its own entrance: rise / slide / depth; the room it makes for the push word)  →  its words
//   (a zoom entrance, the fade-in). The push word hangs off the Pivot (it has no entrance and is not shoved).
// The editor's Euler is X·Y·Z, MotionFast turns Z, then X, then Y: so Y sits on the parent. Signs (MotionFast y down, z
// away; the editor three's y up, z toward the eye): Rotate = tilt Z, Rotate X = − tilt X, Rotate Y = tilt Y,
// Position Z = − depth. MotionFast's fixed perspective (Focal, in 1080-reference px) whatever the frame: the World null
// scales the scene by lens / P and the camera zooms by P / lens (P = Focal × H / 1080).
// Every track is ONE driver where it can be: an entrance, the flatten or the push on its own key curve (the app's same
// curve as MotionFast's easing); where two drivers meet on one track (the pivot gliding to the arriving line while the
// block flattens, an overshoot mixed into the entrance, Expo) the value is fitted with Custom bezier pieces, cubic in
// time, split until within a hundredth of a pixel. The fade-in (alpha = 3 × entrance, clamped) is the entrance on keys and
// a ƒx clamp. MotionFast's shutter smear (N stamps over Shutter / 30 s, trailing) is the editor's Motion Blur on each
// word (accumulation, trailing, the same window and samples, at least 8).
//
// Text widths: the words are laid out from their widths (each word's advance, the line widths, the alignment, the
// pivot, the push distance) and stand on one baseline per line, so the script asks the host to measure every word
// (measure(): its font, weight, size and tracking as the text layer draws it) and build() reads `metrics`: the width
// (MotionFast's raster is the canvas width, with the tracking after the last letter, rounded up to its 3× raster's
// pixel) and the font box, which places the text layer (centred on its font box) on MotionFast's baseline. Without
// metrics (node tools) an estimate of 0.55 em a letter is used, with a warning.
//
// A built-in script (PLANS/ESSENTIAL_TEMPLATES.md §14): it imports nothing, so this same text also runs as a
// `kind: "script"` source. Numbers and timing are MotionFast's (motionTemplates/kineticPerspectiveType.js).
const REF_H = 1080;
const LENS_FOV = 28;                      // the editor's camera (projectCamera.js CAMERA_FOV)
const RASTER_SS = 3;                      // MotionFast rasterises a word at 3× (its advance is that raster's whole px)
const MAX_LAYERS = 396;

const D0 = {
  text: '*8*\nbig', pushWord: 'dots', align: 'left',
  fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif', fontWeight: 600, fontSize: 250,
  hlSize: 2.05, bodySize: 1, pushSize: 1, lineGap: -0.2, letterSpacing: -0.02, wordGap: 0.26,
  textColor: '#f4f3ef', hlColor: '#8fe6b8',
  tiltX: -32, tiltY: -25, tiltZ: -6, focal: 520, offX: 40, offY: -10, perspScale: 1.5,
  enterStyle: 'auto', enterDist: 1.45, enterScale: 0.55, stagger: 0.5, inDur: 0.5, enterEase: 'aeSmooth', overshoot: 0,
  restoreStart: 1.2, restoreDur: 0.7, restoreEase: 'natural',
  pushStart: 1.65, pushDur: 0.45, pushEase: 'natural', reflow: true,
  duration: 3, blurSamples: 12, shutter: 1.35,
};
const EASE_OPTIONS = [['smooth', 'Smooth'], ['power2', 'Power 2'], ['power3', 'Power 3'], ['power4', 'Power 4'], ['back', 'Back'],
  ['bounce', 'Bounce'], ['expo', 'Expo'], ['natural', 'Natural'], ['slowDown', 'Slow Down'], ['elastic', 'Elastic'],
  ['overshoot', 'Overshoot'], ['impulse', 'Impulse'], ['swing', 'Swing'], ['aeIn', 'AE In'], ['aeSmooth', 'AE Smooth'], ['aeOut', 'AE Out']]
  .map(([value, label]) => ({ value, label }));
const WEIGHT_OPTIONS = [[400, 'Regular'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra Bold'], [900, 'Black']].map(([value, label]) => ({ value, label }));
const range = (key, label, min, max, step, suffix) => ({ key, type: 'range', label, default: D0[key], min, max, step, ...(suffix ? { suffix } : {}) });
const fields = [
  { type: 'group', key: 'gText', label: 'Text' },
  { key: 'text', type: 'textarea', label: 'Lines', default: D0.text, rows: 3 },
  { key: 'pushWord', type: 'text', label: 'Push Word', default: D0.pushWord },
  { key: 'align', type: 'select', label: 'Align', default: 'left', options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }] },
  { type: 'group', key: 'gType', label: 'Typeface' },
  { key: 'fontFamily', type: 'font', label: 'Font', default: D0.fontFamily },
  { key: 'fontWeight', type: 'select', label: 'Weight', default: 600, options: WEIGHT_OPTIONS },
  range('fontSize', 'Base Size', 20, 900, 2),
  range('hlSize', 'Highlight Size', 0.05, 8, 0.05, '×'),
  range('bodySize', 'Plain Size', 0.05, 8, 0.05, '×'),
  range('pushSize', 'Push Word Size', 0.05, 8, 0.05, '×'),
  range('lineGap', 'Line Gap', -0.6, 0.6, 0.01),
  range('letterSpacing', 'Tracking', -0.1, 0.2, 0.005),
  range('wordGap', 'Word Gap', 0, 1.5, 0.02),
  { type: 'group', key: 'gColor', label: 'Colors' },
  { key: 'textColor', type: 'color', label: 'Text Color', default: D0.textColor },
  { key: 'hlColor', type: 'color', label: 'Highlight Color', default: D0.hlColor },
  { type: 'group', key: 'gPersp', label: 'Perspective' },
  range('tiltX', 'Tilt X', -80, 80, 1, '°'),
  range('tiltY', 'Tilt Y', -80, 80, 1, '°'),
  range('tiltZ', 'Tilt Z', -60, 60, 1, '°'),
  range('focal', 'Focal', 150, 4000, 10),
  range('offX', 'Offset X', -1600, 1600, 5),
  range('offY', 'Offset Y', -1600, 1600, 5),
  range('perspScale', 'Tilted Scale', 0.1, 8, 0.01),
  { type: 'group', key: 'gEnter', label: 'Line Entrance' },
  { key: 'enterStyle', type: 'select', label: 'Entrance', default: 'auto', options: [
    { value: 'auto', label: 'Auto (zoom, then rise)' }, { value: 'zoom', label: 'Zoom' }, { value: 'bottom', label: 'Rise' },
    { value: 'left', label: 'From Left' }, { value: 'right', label: 'From Right' }, { value: 'depth', label: 'From Depth' },
  ] },
  range('enterDist', 'Entrance Distance', 0.2, 4, 0.05),
  range('enterScale', 'Zoom From', 0.05, 8, 0.05, '×'),
  range('stagger', 'Line Stagger', 0.05, 1.5, 0.01, 's'),
  range('inDur', 'Entrance Time', 0.1, 1.5, 0.01, 's'),
  { key: 'enterEase', type: 'select', label: 'Entrance Easing', default: 'aeSmooth', options: EASE_OPTIONS },
  range('overshoot', 'Overshoot', 0, 1, 0.05),
  { type: 'group', key: 'gFlat', label: 'Flatten' },
  range('restoreStart', 'Flatten At', 0, 10, 0.05, 's'),
  range('restoreDur', 'Flatten Time', 0.1, 3, 0.01, 's'),
  { key: 'restoreEase', type: 'select', label: 'Flatten Easing', default: 'natural', options: EASE_OPTIONS },
  { type: 'group', key: 'gPush', label: 'Word Push' },
  range('pushStart', 'Push At', 0, 10, 0.05, 's'),
  range('pushDur', 'Push Time', 0.1, 3, 0.01, 's'),
  { key: 'pushEase', type: 'select', label: 'Push Easing', default: 'natural', options: EASE_OPTIONS },
  { key: 'reflow', type: 'switch', label: 'Line Makes Room', default: true },
  { type: 'group', key: 'gTiming', label: 'Timing & Blur' },
  range('duration', 'Duration', 0.5, 20, 0.1, 's'),
  range('blurSamples', 'Blur Samples', 1, 32, 1),
  range('shutter', 'Shutter', 0, 4, 0.05),
];

// ── MotionFast's easings (motionTemplates/mtl.js getEase) and the editor's key curve for each ──────────────────────
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const lerp = (a, b, t) => a + (b - a) * t;
// MotionFast's bezier easings (easingEngine.bezierEase stops its search at 1e-4 of x: the editor's key curves use that
// same function, so a keyed move is MotionFast's to the bit). The script's own values are solved exactly (Newton, then
// bisection): a FITTED track follows the smooth curve, within a fraction of a px of MotionFast's (it never chases that jitter)
function bezierCurve(p1x, p1y, p2x, p2y) {
  const bx = (t) => 3 * p1x * t * (1 - t) * (1 - t) + 3 * p2x * t * t * (1 - t) + t * t * t;
  const by = (t) => 3 * p1y * t * (1 - t) * (1 - t) + 3 * p2y * t * t * (1 - t) + t * t * t;
  const dx = (t) => 3 * p1x * (1 - t) * (1 - t) + 6 * (p2x - p1x) * t * (1 - t) + 3 * (1 - p2x) * t * t;
  return (x) => {
    x = clamp01(x);
    let t = x;
    for (let i = 0; i < 8; i += 1) { const d = dx(t); if (Math.abs(d) < 1e-9) break; t = clamp01(t - (bx(t) - x) / d); }
    if (Math.abs(bx(t) - x) > 1e-10) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 60; i += 1) { t = (lo + hi) / 2; if (bx(t) < x) lo = t; else hi = t; }
    }
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
const backOutS = (t, s) => { const u = t - 1; return 1 + (s + 1) * u * u * u + s * u * u; };
const BEZ = { smooth: [0.5, 0, 0, 1], natural: [0.8, 0, 0.2, 1], slowDown: [0, 0, 0, 1], aeIn: [0.3141666673, 0, 0.0875000209, 1],
  aeSmooth: [0.882083327, 0, 0.2445833683, 1], aeOut: [0.8699999754, 0, 0.6433336333, 1] };
const TABLES = { elastic: T_ELASTIC, overshoot: T_OVERSHOOT, impulse: T_IMPULSE, swing: T_SWING };
const EASE_FN = {
  power2: powOut(3), power3: powOut(4), power4: powOut(5),
  back: (t) => backOutS(clamp01(t), 1.70158),
  bounce: bounceOut,
  expo: (t) => { t = clamp01(t); return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); },
};
for (const [k, b] of Object.entries(BEZ)) EASE_FN[k] = bezierCurve(...b);
for (const [k, tb] of Object.entries(TABLES)) EASE_FN[k] = sampled(tb);
const easeFn = (name) => EASE_FN[name] || EASE_FN.smooth;
// the editor's key curve that IS MotionFast's easing over a whole move (expo has none: it is fitted)
const NAMED = { power2: 'Ease Out', power3: 'Cubic Out', power4: 'Power', back: 'Back Out', bounce: 'Bounce Out', natural: 'Natural',
  slowDown: 'Slow Down', aeIn: 'AE In (arrive)', aeSmooth: 'AE Smooth', aeOut: 'AE Out (leave)' };
function keyCurveOf(name) {
  const nm = EASE_FN[name] ? name : 'smooth';
  if (TABLES[nm]) return { table: TABLES[nm] };
  if (NAMED[nm]) return { key: { easing: NAMED[nm] } };
  if (BEZ[nm]) return { key: { easing: 'Custom', bezier: BEZ[nm].map((v) => Math.round(v * 1e6) / 1e6) } };
  return null;
}

// ── keys ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const r4 = (v) => { const x = Math.round(v * 1e4) / 1e4; return Object.is(x, -0) ? 0 : x; };
const r6 = (v) => { const x = Math.round(v * 1e6) / 1e6; return Object.is(x, -0) ? 0 : x; };
const n = (v) => { const x = Number(v); return Math.abs(x) < 1e-12 ? '0' : String(Number(x.toPrecision(10))); };
const fx = (code) => ({ type: 'custom', params: { code } });
const RANGE = { translateX: [-1200, 1200], translateY: [-1200, 1200], translateZ: [-3000, 3000], xPercent: [-200, 200],
  rotate: [-1000, 1000], rotateX: [-180, 180], rotateY: [-180, 180], scale: [0.1, 20], opacity: [0, 2], camZoom: [0.1, 1e6] };

// A cubic in time through f at the piece's 0, ⅓, ⅔, 1 is drawn EXACTLY by a Custom bezier with x handles ⅓, ⅔ (the y
// handles are the cubic's Bernstein points): fitted pieces, split until within tol (or the handles leave −3…4)
function fitPieces(f, a, b, tol, out, depth = 0) {
  const h = b - a;
  const f0 = f(a), f1 = f(a + h / 3), f2 = f(a + (2 * h) / 3), f3 = f(b);
  const A = 27 * f1 - 8 * f0 - f3, B = 27 * f2 - f0 - 8 * f3;
  const P1 = (2 * A - B) / 18, P2 = (2 * B - A) / 18;
  const span = f3 - f0;
  let piece = null, err = 0;
  const flat = Math.abs(span) < 1e-9;
  if (!flat) {
    const y1 = r4((P1 - f0) / span), y2 = r4((P2 - f0) / span);
    if (y1 >= -3 && y1 <= 4 && y2 >= -3 && y2 <= 4) {
      const q1 = f0 + y1 * span, q2 = f0 + y2 * span;
      for (let k = 1; k < 12; k += 1) {
        const s = k / 12, c = 1 - s;
        err = Math.max(err, Math.abs(c * c * c * f0 + 3 * c * c * s * q1 + 3 * c * s * s * q2 + s * s * s * f3 - f(a + s * h)));
      }
      piece = { t: a, v: f0, e: { easing: 'Custom', bezier: [0.3333, y1, 0.6667, y2] } };
      // (x handles are stored to 4 decimals: 0.3333 / 0.6667 move x by ≤ 3e-5 of the piece: below every tolerance)
    } else err = Infinity;
  } else {
    for (let k = 1; k < 12; k += 1) err = Math.max(err, Math.abs(f(a + (k / 12) * h) - f0));
    piece = { t: a, v: f0, e: { easing: 'Linear' } };
  }
  if (err <= tol || depth >= 14 || h < 2e-4) { out.push(piece || { t: a, v: f0, e: { easing: 'Linear' } }); return; }
  const m = a + h / 2;
  fitPieces(f, a, m, tol, out, depth + 1);
  fitPieces(f, m, b, tol, out, depth + 1);
}

// A track from its value function f(t) on [0, D] and the drivers it depends on ({ t0, t1, ease (name | null: fitted),
// fn }). Between the drivers' ends: nothing live → held; one live driver over its whole move with f affine in it → its
// key curve (the app's same curve, or MotionFast's 101-point table); else fitted pieces. Keys outside the property's
// range hold an affine map of the value, undone by a ƒx (ƒx results are not clamped).
function trackOf(prop, f, drivers, D, tol) {
  const cuts = [0, D];
  for (const d of drivers) for (const x of [d.t0, d.t1]) if (x > 0 && x < D) cuts.push(x);
  cuts.sort((x, y) => x - y);
  const ts = cuts.filter((x, i) => i === 0 || x - cuts[i - 1] > 1e-7);
  const entries = [];   // { t, v, e }
  for (let i = 0; i + 1 < ts.length; i += 1) {
    const a = ts[i], b = ts[i + 1];
    const live = drivers.filter((d) => d.t0 < b - 1e-9 && d.t1 > a + 1e-9);
    if (!live.length) { entries.push({ t: a, v: f(a), e: { easing: 'Linear' } }); continue; }
    const d = live[0];
    const whole = live.length === 1 && Math.abs(d.t0 - a) < 1e-7 && Math.abs(d.t1 - b) < 1e-7;
    const curve = whole && d.ease ? keyCurveOf(d.ease) : null;
    if (curve) {
      const v0 = f(a), v1 = f(b);
      const E = (t) => d.fn(clamp01((t - d.t0) / (d.t1 - d.t0)));
      const beta = v1 - v0;   // E runs 0 → 1 over the move
      let affine = true;
      for (const q of [0.07, 0.19, 0.33, 0.5, 0.61, 0.77, 0.93]) {
        const t = a + q * (b - a);
        if (Math.abs(f(t) - (v0 + beta * E(t))) > tol * 0.25) { affine = false; break; }
      }
      if (affine) {
        if (curve.key) entries.push({ t: a, v: v0, e: curve.key });
        else curve.table.forEach((y, j) => { if (j < curve.table.length - 1) entries.push({ t: a + ((b - a) * j) / (curve.table.length - 1), v: v0 + beta * y, e: { easing: 'Linear' } }); });
        continue;
      }
    }
    // fitted: a table easing (straight between its 101 points) is cut at its points first
    const sub = [a, b];
    for (const d2 of live) if (d2.ease && TABLES[d2.ease] && !(d2.t1 - d2.t0 < 1e-6)) {
      for (let j = 1; j < 100; j += 1) { const x = d2.t0 + ((d2.t1 - d2.t0) * j) / 100; if (x > a + 1e-7 && x < b - 1e-7) sub.push(x); }
    }
    sub.sort((x, y) => x - y);
    for (let j = 0; j + 1 < sub.length; j += 1) fitPieces(f, sub[j], sub[j + 1], tol, entries);
  }
  entries.push({ t: D, v: f(D), e: { easing: 'Linear' } });
  if (entries.length > 900 && tol < 50) return trackOf(prop, f, drivers, D, tol * 3);   // the editor keeps 1000 keys a track
  // the property's range: keys hold (v − c) / m, the ƒx gives v back
  const [lo, hi] = RANGE[prop] || [-Infinity, Infinity];
  const vs = entries.map((x) => x.v);
  const vmin = Math.min(...vs), vmax = Math.max(...vs);
  let c = 0, m = 1;
  if (vmin < lo || vmax > hi) {
    const room = (hi - lo) * 0.9;
    m = Math.max(1, Math.ceil(((vmax - vmin) / room) * 100) / 100);
    c = (vmin + vmax) / 2 - ((lo + hi) / 2) * m;
  }
  const keys = [];
  for (const x of entries) {
    const k = { position: r6((x.t / D) * 100), value: n((x.v - c) / m), ...x.e };
    if (keys.length && Math.abs(keys[keys.length - 1].position - k.position) < 1e-9) keys[keys.length - 1] = k; else keys.push(k);
  }
  const allSame = keys.every((k) => k.value === keys[0].value);
  return { keys: allSame ? [{ position: 0, value: keys[0].value, easing: 'Linear' }] : keys, fx: c || m !== 1 ? `value*${n(m)}+${n(c)}` : null };
}

// ── MotionFast's layout (buildLayout / parseLines / wordScale), from the measured words ───────────────────────────────
function parseLines(p) {
  const raw = String(p.text || '').split('\n').map((s) => s.trim()).filter((s) => s.length);
  const out = raw.map((l) => l.split(/\s+/).map((tok) => {
    const hl = /^\*.+\*$/.test(tok);
    return { text: hl ? tok.slice(1, -1) : tok, hl, pushed: false };
  }));
  if (!out.length) out.push([{ text: 'TYPE', hl: false, pushed: false }]);
  const pw = String(p.pushWord || '').trim();
  if (pw) {
    const hl = /^\*.+\*$/.test(pw);
    out[out.length - 1].push({ text: hl ? pw.slice(1, -1) : pw, hl, pushed: true });
  }
  return out;
}
const wordScale = (p, t) => Math.max(0.05, num(t.pushed ? p.pushSize : t.hl ? p.hlSize : p.bodySize, 1));
// the size the text layers draw at: frame px (MotionFast's 1080-reference px × H / 1080)
function words(p, frame) {
  const u = frame.H / REF_H;
  const fs = num(p.fontSize, 250);
  const lsEm = num(p.letterSpacing, 0);
  const list = [];
  parseLines(p).forEach((toks, li) => toks.forEach((t, wi) => {
    const sc = wordScale(p, t);
    list.push({ ...t, li, wi, scale: sc, size: fs * sc * u, ls: lsEm * fs * sc * u, key: `w[${list.length}]` });
  }));
  return list;
}

export default {
  id: 'kinetic-perspective-type',
  name: 'Kinetic Perspective Type',
  category: 'Typography',
  v: 1,
  fields,
  // every word at the size and tracking its text layer draws it (one plane per word)
  measure({ settings, frame }) {
    const p = { ...D0, ...settings };
    const family = String(p.fontFamily || D0.fontFamily);
    const weight = Number(p.fontWeight) || 600;
    return words(p, frame).filter((w) => Array.from(w.text).length <= 256 && w.size <= 2000).slice(0, 128)
      .map((w) => ({ key: w.key, text: w.text, font: family, size: w.size, weight, letterSpacing: w.ls }));
  },
  // a `motion` item's params as they are, but MotionFast's empty Push Word (no push) / Lines become a space: an empty text
  // field reads as its default here (core.resolveSettings), a space is kept and trims to nothing
  fromMotionParams(params) {
    const settings = {};
    for (const d of fields) if (d.type !== 'group' && params[d.key] !== undefined) settings[d.key] = params[d.key];
    for (const k of ['pushWord', 'text']) if (typeof settings[k] === 'string' && !settings[k].trim()) settings[k] = ' ';
    return { settings, media: [] };
  },
  build({ settings, frame, metrics }) {
    const p = { ...D0, ...settings };
    const { W, H } = frame;
    const u = H / REF_H;
    const warnings = [];
    const M = metrics || {};
    const family = String(p.fontFamily || D0.fontFamily);
    const weight = Number(p.fontWeight) || 600;
    const D = Math.max(0.1, Number(p.duration) || 3);
    const fs = num(p.fontSize, 250);
    const gap = fs * num(p.wordGap, 0.26);
    const lineGap = num(p.lineGap, 0);
    const k3 = RASTER_SS * u;                      // MotionFast's raster px per reference px

    // ── the words, measured (reference px), laid out as MotionFast lays them ──
    // the layer cap: World, Pose, Tilt, Pivot, the camera, a Line null (and a Shove null past the first) per line, a
    // layer per word; past it the last words (and lines) are left out
    let budget = MAX_LAYERS - 5, dropped = 0, lastLine = -1;
    const kept = words(p, frame).filter((w) => {
      const cost = 1 + (w.li !== lastLine ? (w.li > 0 ? 2 : 1) : 0);
      if (cost > budget || (w.li !== lastLine && w.li !== lastLine + 1)) { dropped += 1; return false; }
      budget -= cost;
      lastLine = w.li;
      return true;
    });
    let estimated = 0;
    const all = kept.map((w) => {
      const m = M[w.key];
      const ok = m && Number.isFinite(m.width);
      if (!ok) estimated += 1;
      const len = Array.from(w.text).length;
      const width = ok ? m.width : len * 0.55 * w.size + Math.max(0, len - 1) * w.ls;          // frame px, tracking between letters
      const ascent = ok && Number.isFinite(m.ascent) ? m.ascent : 0.95 * w.size;
      const descent = ok && Number.isFinite(m.descent) ? m.descent : 0.25 * w.size;
      // MotionFast's raster: the canvas width (tracking after the last letter too) at 3×, rounded up, plus its padding
      const fsR = fs * w.scale * k3;
      const rasterW = Math.ceil((width + w.ls) * RASTER_SS);
      const pad = Math.ceil(fsR * 0.08);
      return { ...w, width: width / u, ascent: ascent / u, descent: descent / u, adv: rasterW / k3, boxW: (rasterW + 2 * pad) / k3 };
    });
    const lines = [];
    for (const w of all) (lines[w.li] = lines[w.li] || []).push(w);
    const L = lines.map((ws, li) => {
      let x = 0;
      for (const w of ws) { w.lx = x; x += w.adv + gap; }
      const width = x - gap;
      const solid = ws.filter((w) => !w.pushed);
      let px = 0;
      for (const w of solid) px += w.adv + gap;
      const scale = Math.max(...ws.map((w) => w.scale));
      return { li, words: ws, width, preWidth: solid.length ? px - gap : 0, scale, lh: fs * scale * (1 + lineGap) };
    });
    const blockW = Math.max(...L.map((l) => l.width));
    const blockH = L.reduce((s, l) => s + l.lh, 0);
    let yAcc = 0;
    for (const l of L) {
      const alignOff = p.align === 'center' ? (blockW - l.width) / 2 : 0;
      l.y = -blockH / 2 + yAcc + l.lh / 2;
      yAcc += l.lh;
      l.cx = -blockW / 2 + alignOff + l.width / 2;
      const base = l.y + fs * l.scale * 0.32;      // one baseline per line
      for (const w of l.words) {
        const start = -blockW / 2 + alignOff + w.lx;
        w.cxm = start + w.adv / 2;                 // the centre MotionFast scales the word about (with the line's y)
        w.xc = start + w.width / 2;                // the text layer's centre (its line is centred, its font box too)
        w.yc = base - (w.ascent - w.descent) / 2;
      }
    }
    const pushLn = L.find((l) => l.words.some((w) => w.pushed));
    const hasPush = !!String(p.pushWord || '').trim();
    for (const l of L) {
      l.pushShift = p.reflow && pushLn ? (p.align === 'center' ? (l.width - l.preWidth) / 2 : (pushLn.width - pushLn.preWidth) / 2) : 0;
    }
    const nL = L.length;
    const pvy = L[nL - 1].y;

    // ── the drivers (MotionFast's clocks) ──
    const stagger = Math.max(0.001, num(p.stagger, 0.5));
    const inDur = Math.max(0.001, num(p.inDur, 0.5));
    const over = clamp(num(p.overshoot, 0), 0, 1);
    const baseEnter = easeFn(p.enterEase);
    const enterFn = over <= 0 ? baseEnter : (t) => { const b = baseEnter(t); return b + (backOutS(t, 1.2 + over * 2.2) - b) * over; };
    const drv = (t0, dur, ease, fn) => ({ t0, t1: t0 + dur, ease, fn });
    const E = L.map((l) => drv(l.li * stagger, inDur, over <= 0 ? p.enterEase : null, enterFn));
    const R = drv(num(p.restoreStart, 1.2), Math.max(0.001, num(p.restoreDur, 0.7)), p.restoreEase, easeFn(p.restoreEase));
    const PU = drv(num(p.pushStart, 1.65), Math.max(0.001, num(p.pushDur, 0.45)), p.pushEase, easeFn(p.pushEase));
    const at = (d, t) => d.fn(clamp01((t - d.t0) / (d.t1 - d.t0)));
    const er = (t) => at(R, t);
    const pvx = (t) => { let v = L[0].cx; for (let j = 1; j < nL; j += 1) v = lerp(v, L[j].cx, clamp01(at(E[j], t))); return v; };
    const styleOf = (li) => (p.enterStyle && p.enterStyle !== 'auto' ? p.enterStyle : li === 0 ? 'zoom' : 'bottom');

    // ── the lens: MotionFast's perspective P (frame px) through the editor's camera ──
    const P = num(p.focal, 520) * u;
    const lens = (H * 0.5) / Math.tan(((LENS_FOV * Math.PI) / 180) * 0.5);
    // a font past the text layer's 1000 px: the scene is built in units of 1/Q frame px (the World null takes Q back)
    const maxFont = Math.max(...all.map((w) => w.size));
    const Q = maxFont > 1000 ? 1000 / maxFont : 1;
    const uq = u * Q;                               // reference px → scene units
    const TOL = 0.01 * Q;                           // a hundredth of a frame px
    const layers = [];
    const track = (prop, f, drivers, tol = TOL) => trackOf(prop, f, drivers, D, tol);
    const put = (layer, props) => {
      for (const [prop, tr] of Object.entries(props)) {
        if (!tr) continue;
        (layer.propertyKeyframes = layer.propertyKeyframes || {})[prop] = tr.keys;
        if (tr.fx) (layer.propertyKeyframeFx = layer.propertyKeyframeFx || {})[prop] = fx(tr.fx);
      }
      layers.push(layer);
      return layer;
    };
    const parentOf = (key) => ({ keyframeParenting: { parentItemId: key, type: 'additive' } });
    const camZoom = P / lens;
    put({ key: 'world', type: 'null', name: 'World' }, { scale: track('scale', () => lens / P / Q, []) });
    const deg = 0.002;
    put({ key: 'pose', type: 'null', name: 'Pose', ...parentOf('world') }, {
      translateX: track('translateX', (t) => (pvx(t) + lerp(num(p.offX, 0), 0, er(t))) * uq, [...E.slice(1), R]),
      translateY: track('translateY', (t) => (pvy + lerp(num(p.offY, 0), 0, er(t))) * uq, [R]),
      rotateY: track('rotateY', (t) => lerp(num(p.tiltY, 0), 0, er(t)), [R], deg),
    });
    put({ key: 'tilt', type: 'null', name: 'Tilt', ...parentOf('pose') }, {
      rotateX: track('rotateX', (t) => -lerp(num(p.tiltX, 0), 0, er(t)), [R], deg),
      rotate: track('rotate', (t) => lerp(num(p.tiltZ, 0), 0, er(t)), [R], deg),
      scale: track('scale', (t) => lerp(num(p.perspScale, 1), 1, er(t)), [R], 2e-6),
    });
    put({ key: 'pivot', type: 'null', name: 'Pivot', ...parentOf('tilt'), panY: r6(((-pvy * uq) / H) * 100) }, {
      translateX: track('translateX', (t) => -pvx(t) * uq, E.slice(1)),
    });
    // the shove: line j's arrival pushes every earlier line up by its own slot height (a chain: line i hangs off j = i + 1)
    for (let j = nL - 1; j >= 1; j -= 1) {
      put({ key: `shove[${j}]`, type: 'null', name: `Shove ${j + 1}`, ...parentOf(j === nL - 1 ? 'pivot' : `shove[${j + 1}]`) }, {
        translateY: track('translateY', (t) => L[j].lh * (1 - at(E[j], t)) * uq, [E[j]]),
      });
    }
    const blur = Math.round(clamp(num(p.blurSamples, 12), 1, 32)) > 1 && num(p.shutter, 1.35) > 0;
    const blurFx = blur ? [{ id: 'motionBlur', eid: 'mblur', enabled: true, params: {
      mblurMode: 0, mblurPhase: 0, mblurShutter: r4(clamp(num(p.shutter, 1.35) * 360, 0, 720)),
      mblurSamples: clamp(Math.round(num(p.blurSamples, 12)), 8, 48), mblurAmount: 100,
    } }] : null;
    if (blur && num(p.shutter, 1.35) > 2) warnings.push('Shutter past 2 is held at 2 (the Motion Blur effect\'s 720°).');
    if (blur && Math.round(num(p.blurSamples, 12)) < 8) warnings.push('Blur Samples under 8 are drawn with 8 (the Motion Blur effect\'s fewest).');
    // (a text layer holds letter spacing within −20…80 px: past it the word is drawn at size / k with spacing / k and the
    // layer zoomed by k, the same glyphs in the same places)
    const textOf = (w) => {
      const ls = w.ls * Q, k = Math.min(20, ls < -20 ? ls / -20 : ls > 80 ? ls / 80 : 1);
      return {
        type: 'text', name: w.pushed ? `Push · ${w.text}` : w.text, textContent: w.text, textColor: w.hl ? p.hlColor : p.textColor,
        textFontFamily: family, textFontWeight: weight, textFontSizeUnit: 'px', textFontSize: r4((w.size * Q) / k),
        ...(ls ? { textLetterSpacing: r4(clamp(ls / k, -20, 80)) } : {}), ...(k > 1 ? { zoom: r6(k) } : {}),
        textAlign: 'center', textNoWrap: true, textLineHeight: 1, ...(blurFx ? { layerEffects: blurFx } : {}),
      };
    };
    let clamped = false;
    for (const l of L) {
      const lineKey = `line[${l.li}]`;
      const e = E[l.li];
      const st = styleOf(l.li);
      const dist = l.lh * num(p.enterDist, 1.45);
      const own = (t) => 1 - at(e, t);
      put({ key: lineKey, type: 'null', name: `Line ${l.li + 1}`, ...parentOf(l.li + 1 < nL ? `shove[${l.li + 1}]` : 'pivot') }, {
        translateY: track('translateY', (t) => (l.y + (st === 'bottom' ? own(t) * dist : 0)) * uq, st === 'bottom' ? [e] : []),
        ...(st === 'left' || st === 'right' ? { translateX: track('translateX', (t) => (st === 'left' ? -1 : 1) * own(t) * dist * 1.6 * uq, [e]) } : {}),
        ...(st === 'depth' ? { translateZ: track('translateZ', (t) => -own(t) * dist * (p.enterStyle === 'auto' ? 1 : 2) * uq, [e]) } : {}),
        ...(hasPush && l.pushShift ? { xPercent: track('xPercent', (t) => (l.pushShift * (1 - at(PU, t)) * uq * 100) / W, [PU], (TOL * 100) / W) } : {}),
      });
      for (const w of l.words) {
        if (w.pushed) continue;
        if (w.ls * Q < -400 || w.ls * Q > 1600) clamped = true;
        const zoom = st === 'zoom';
        const s = (t) => lerp(num(p.enterScale, 0.55), 1, at(e, t));
        const opacity = track('opacity', (t) => 0.5 + at(e, t), [e], 1e-4);
        opacity.fx = opacity.fx ? `min(1,max(0,3*(${opacity.fx}-0.5)))` : 'min(1,max(0,3*(value-0.5)))';
        put({ key: `${lineKey}.word[${w.wi}]`, ...textOf(w), ...parentOf(lineKey),
          ...(zoom ? {} : { panX: r6((w.xc * uq * 100) / W), panY: r6(((w.yc - l.y) * uq * 100) / H) }) }, {
          ...(zoom ? {
            translateX: track('translateX', (t) => (w.cxm + (w.xc - w.cxm) * s(t)) * uq, [e]),
            translateY: track('translateY', (t) => (w.yc - l.y) * s(t) * uq, [e]),
            scale: track('scale', s, [e], 1e-5),
          } : {}),
          opacity,
        });
      }
    }
    // the push word: no entrance, not shoved; hidden until the push starts, then in from the right
    const pw = all.find((w) => w.pushed);
    if (pw) {
      const far = blockW * 0.9 + pw.boxW * 1.5;
      put({ key: 'push', ...textOf(pw), ...parentOf('pivot'), panY: r6((pw.yc * uq * 100) / H) }, {
        translateX: track('translateX', (t) => (pw.xc + (1 - at(PU, t)) * far) * uq, [PU]),
        opacity: PU.t0 > 0 && PU.t0 < D
          ? { keys: [{ position: 0, value: '0', easing: 'Hold' }, { position: r6((PU.t0 / D) * 100), value: '1', easing: 'Linear' }], fx: null }
          : { keys: [{ position: 0, value: PU.t0 <= 0 ? '1' : '0', easing: 'Linear' }], fx: null },
      });
    }
    // the camera: zoom P / lens (below the editor's 0.1 floor: keys at 0.1, the value in a ƒx)
    put({ key: 'camera', type: 'camera', name: 'Lens' }, {
      camZoom: camZoom >= 0.1 ? { keys: [{ position: 0, value: n(camZoom), easing: 'Linear' }], fx: null } : { keys: [{ position: 0, value: '0.1', easing: 'Linear' }], fx: n(camZoom) },
    });
    if (estimated) warnings.push('No text metrics from the host: the words are laid out from an estimate (0.55 em a letter).');
    if (clamped) warnings.push('Tracking past −400…1600 px: the words are drawn with it held there (their places keep the full value).');
    if (dropped) warnings.push(`Too many words for one template: ${dropped} left out (400 layers at most).`);
    return { duration: D, layers, warnings };
  },
};
