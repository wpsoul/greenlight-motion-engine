// Carousel (MotionFast `orbit`): picture cards on a ring in 3D, always facing the camera, the front card at the
// frame centre at full size. View tips the ring toward the camera (0° edge-on = a carousel, 90° face-on = a flat
// ring), Angle turns it on screen, Perspective sets how far the back shrinks. Slide and stop steps one card per beat
// or the ring turns steadily; Start from single / End to single gather the ring into one picture that grows out.
//
// Built from ordinary layers: one picture layer per card, placed in real depth (translateZ) so the editor's own camera
// gives the perspective and the back-to-front order. MotionFast projects with a camera Perspective px from the front
// card; the editor's lens sits D = (H/2)/tan(14°) from the frame, so a card's depth is written as z·D/Perspective:
// the same picture on screen, at every size of frame. Each card's track keys hold the ring's TURN (slots advanced,
// one step keyed with the slide easing and repeated by loopOut('offset'), or a straight line for a steady turn) and a
// ƒx expression turns it into that card's place on the ring — one key set per card, no key per frame. The grow and
// gather of Start / End to single are plain keys (every value is a straight line in the spread there), on the same
// track as the turn.
//
// A built-in script (PLANS/ESSENTIAL_TEMPLATES.md §14): it imports nothing, so this same text also runs as a
// `kind: "script"` source. Numbers and timing are MotionFast's (motionTemplates/orbit.js).
const D2R = Math.PI / 180;
const LENS = 28;                       // the editor's camera: the frame fills the view at this vertical fov
const PLATES = ['#1d9bf1', '#f9492d', '#ffffff', '#33efab'];
const CARD_SHAPES = { '1:1': 1, '4:5': 4 / 5, '3:4': 3 / 4, '2:3': 2 / 3, '9:16': 9 / 16, '4:3': 4 / 3, '3:2': 3 / 2, '16:9': 16 / 9 };
const CLUSTER = [0.69, -0.56, 0.3, -0.98, 1, -0.27, 0.49, -0.67];
// the reel's stepper ease and the steady turn's speed ramp (∫ smoothstep, as a bezier: within 0.31 % of the curve)
const REEL = [0.86, 0.14, 0.14, 0.86];
const RAMP_IN = [0.4206, 0, 0.5794, 0.1587];
const RAMP_OUT = [0.4206, 0.8413, 0.5794, 1];

// MotionFast's easings as the editor's key easings (exact: the same bezier, the same named curve), or null: sampled
const BEZ = (b) => ({ easing: 'Custom', bezier: b.map((v) => Math.round(v * 1e4) / 1e4) });
const EASES = {
  reel: BEZ(REEL), smooth: BEZ([0.5, 0, 0, 1]), power2: { easing: 'Ease Out' }, power3: { easing: 'Cubic Out' },
  power4: { easing: 'Power' }, back: { easing: 'Back Out' }, bounce: { easing: 'Bounce Out' }, expo: null,
  natural: { easing: 'Natural' }, slowDown: { easing: 'Slow Down' }, elastic: null, overshoot: { easing: 'Overshoot' },
  impulse: { easing: 'Impulse' }, swing: { easing: 'Swing' }, aeIn: { easing: 'AE In (arrive)' },
  aeSmooth: { easing: 'AE Smooth' }, aeOut: { easing: 'AE Out (leave)' },
};
const ELASTIC = '0,.0221,.0739,.1485,.2394,.3402,.4458,.5517,.6541,.7502,.8375,.9149,.9813,1.0364,1.0803,1.1136,1.1369,1.1513,1.1579,1.1578,1.1522,1.1424,1.1294,1.1142,1.0978,1.081,1.0643,1.0485,1.0338,1.0205,1.009,.9992,.9912,.9849,.9803,.9772,.9754,.9748,.9752,.9764,.9782,.9804,.9829,.9856,.9882,.9908,.9933,.9955,.9975,.9992,1.0007,1.0018,1.0027,1.0034,1.0038,1.004,1.004,1.0039,1.0036,1.0033,1.0029,1.0025,1.0021,1.0017,1.0013,1.0009,1.0006,1.0003,1,.9998,.9996,.9995,.9994,.9994,.9994,.9994,.9994,.9994,.9995,.9996,.9996,.9997,.9998,.9998,.9999,.9999,1,1,1,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1'.split(',').map(Number);

const EASE_OPTIONS = [['smooth', 'Smooth'], ['power2', 'Power 2'], ['power3', 'Power 3'], ['power4', 'Power 4'], ['back', 'Back'],
  ['bounce', 'Bounce'], ['expo', 'Expo'], ['natural', 'Natural'], ['slowDown', 'Slow Down'], ['elastic', 'Elastic'],
  ['overshoot', 'Overshoot'], ['impulse', 'Impulse'], ['swing', 'Swing'], ['aeIn', 'AE In'], ['aeSmooth', 'AE Smooth'], ['aeOut', 'AE Out']]
  .map(([value, label]) => ({ value, label }));

const LOOK_BASE = { count: 8, view: 0, angle: 0, offsetX: 0, offsetY: 0, cardShape: '1:1', cornerRadius: 0, facing: 'camera',
  sizeVariety: 0, ringVariety: 0, seed: 1, shade: 0, slideStop: true, stepTime: 1, stopShare: 0, stepEase: 'reel', cardTime: 1.5,
  direction: 'forward', duration: 8, seamless: true };
const LOOKS = [
  { value: 'revolve', label: 'Revolve', params: { ...LOOK_BASE, ringSize: 729, perspective: 1323, cardSize: 568 } },
  { value: 'riser', label: 'Riser', params: { ...LOOK_BASE, ringSize: 776, perspective: 1289, cardSize: 591, angle: 90, direction: 'reverse' } },
  { value: 'panorama', label: 'Panorama', params: { ...LOOK_BASE, ringSize: 1118, perspective: 861, cardSize: 527, shade: 40 } },
  { value: 'ascent', label: 'Ascent', params: { ...LOOK_BASE, ringSize: 913, perspective: 1195, cardSize: 452, angle: -54 } },
  { value: 'descent', label: 'Descent', params: { ...LOOK_BASE, ringSize: 911, perspective: 1200, cardSize: 451, angle: 54 } },
  { value: 'halo', label: 'Halo', params: { ...LOOK_BASE, ringSize: 379, view: 20, perspective: 996, cardSize: 316, offsetY: -1.9, cornerRadius: 35, slideStop: false, cardTime: 1.5, duration: 12 } },
  { value: 'wreath', label: 'Wreath', params: { ...LOOK_BASE, ringSize: 270, view: 90, perspective: 1000, cardSize: 253, cornerRadius: 11, sizeVariety: 15, ringVariety: 8, slideStop: false, cardTime: 2.25, duration: 18, direction: 'reverse' } },
];

const fields = [
  { key: 'media', type: 'media', label: 'Images / videos', slots: { from: 'media', max: 24 }, accept: 'media', ifFewer: 'reuse' },
  { key: 'fillEmpty', type: 'switch', label: 'Repeat media', default: true },
  { key: 'color1', type: 'color', label: 'Plate 1', default: PLATES[0] },
  { key: 'color2', type: 'color', label: 'Plate 2', default: PLATES[1] },
  { key: 'color3', type: 'color', label: 'Plate 3', default: PLATES[2] },
  { key: 'color4', type: 'color', label: 'Plate 4', default: PLATES[3] },
  { type: 'group', key: 'gRing', label: 'Ring' },
  { key: 'look', type: 'select', label: 'Look', default: 'revolve', options: LOOKS },
  { key: 'count', type: 'range', label: 'Cards', default: 8, min: 3, max: 24, step: 1, integer: true },
  { key: 'ringSize', type: 'range', label: 'Ring size', default: 729, min: 40, max: 2000, step: 1, suffix: 'px' },
  { key: 'view', type: 'range', label: 'View', default: 0, min: 0, max: 90, step: 0.5, suffix: '°' },
  { key: 'angle', type: 'range', label: 'Angle', default: 0, min: -180, max: 180, step: 1, suffix: '°' },
  { key: 'perspective', type: 'range', label: 'Perspective', default: 1323, min: 200, max: 5000, step: 1, suffix: 'px' },
  { key: 'offsetX', type: 'range', label: 'Offset X', default: 0, min: -50, max: 50, step: 0.5, suffix: '%' },
  { key: 'offsetY', type: 'range', label: 'Offset Y', default: 0, min: -50, max: 50, step: 0.5, suffix: '%' },
  { type: 'group', key: 'gCards', label: 'Cards' },
  { key: 'cardSize', type: 'range', label: 'Card size', default: 568, min: 20, max: 1200, step: 1, suffix: 'px' },
  { key: 'cardShape', type: 'select', label: 'Card shape', default: '1:1', options: [
    { value: '1:1', label: 'Square' }, { value: '4:5', label: '4:5 portrait' }, { value: '3:4', label: '3:4 portrait' },
    { value: '2:3', label: '2:3 portrait' }, { value: '9:16', label: '9:16 portrait' }, { value: '4:3', label: '4:3' },
    { value: '3:2', label: '3:2' }, { value: '16:9', label: '16:9' },
  ] },
  { key: 'cornerRadius', type: 'range', label: 'Corner radius', default: 0, min: 0, max: 300, step: 1, suffix: 'px' },
  { key: 'facing', type: 'select', label: 'Cards face', default: 'camera', options: [
    { value: 'camera', label: 'The camera (level)' }, { value: 'outward', label: 'Outward (spokes)' },
  ] },
  { key: 'sizeVariety', type: 'range', label: 'Size variety', default: 0, min: 0, max: 60, step: 1, suffix: '%' },
  { key: 'ringVariety', type: 'range', label: 'Ring variety', default: 0, min: 0, max: 40, step: 1, suffix: '%' },
  { key: 'seed', type: 'range', label: 'Shuffle', default: 1, min: 1, max: 99, step: 1, integer: true },
  { key: 'shade', type: 'range', label: 'Depth darkening', default: 0, min: 0, max: 100, step: 1, suffix: '%' },
  { type: 'group', key: 'gMotion', label: 'Motion' },
  { key: 'slideStop', type: 'switch', label: 'Slide and stop', default: true },
  { key: 'stepTime', type: 'range', label: 'Time per card', default: 1, min: 0.2, max: 6, step: 0.05, suffix: 's', showIf: { key: 'slideStop', truthy: true } },
  { key: 'stopShare', type: 'range', label: 'Stop', default: 0, min: 0, max: 90, step: 1, suffix: '%', showIf: { key: 'slideStop', truthy: true } },
  { key: 'stepEase', type: 'select', label: 'Slide easing', default: 'reel', options: [{ value: 'reel', label: 'Reel step' }, ...EASE_OPTIONS], showIf: { key: 'slideStop', truthy: true } },
  { key: 'cardTime', type: 'range', label: 'Time per card', default: 1.5, min: 0.2, max: 12, step: 0.05, suffix: 's', showIf: { key: 'slideStop', equals: false } },
  { key: 'direction', type: 'select', label: 'Direction', default: 'forward', options: [
    { value: 'forward', label: 'Forward' }, { value: 'reverse', label: 'Reverse' },
  ] },
  { key: 'seamless', type: 'switch', label: 'Seamless loop', default: true },
  { key: 'duration', type: 'range', label: 'Duration', default: 8, min: 1, max: 60, step: 0.1, suffix: 's' },
  { type: 'group', key: 'gSingle', label: 'Single' },
  { key: 'startSingle', type: 'switch', label: 'Start from single', default: false },
  { key: 'endSingle', type: 'switch', label: 'End to single', default: false },
  { key: 'singleHold', type: 'range', label: 'Single hold', default: 0.6, min: 0, max: 5, step: 0.05, suffix: 's' },
  { key: 'spreadTime', type: 'range', label: 'Grow time', default: 1.4, min: 0.2, max: 5, step: 0.05, suffix: 's' },
  { key: 'spreadEase', type: 'select', label: 'Grow easing', default: 'natural', options: EASE_OPTIONS },
];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const r6 = (v) => { const x = Math.round(v * 1e6) / 1e6; return Object.is(x, -0) ? 0 : x; };
const n = (v) => { const x = Number(v); return Math.abs(x) < 1e-12 ? '0' : String(Number(x.toPrecision(10))); };   // in an expression or a key
const pct = (t, span) => r6((t / span) * 100);        // a key's place in its layer, % of the layer
function hash01(a, b) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// MotionFast's clip: optional start single (hold + grow), the ring's motion, optional end single (gather + hold)
function timing(S) {
  const N = clamp(Math.round(num(S.count, 8)), 3, 48);
  const slide = !!S.slideStop;
  const per = slide ? Math.max(0.05, num(S.stepTime, 1)) : Math.max(0.05, num(S.cardTime, 1.5));
  const hold = Math.max(0, num(S.singleHold, 0.6)), zt = Math.max(0.05, num(S.spreadTime, 1.4));
  const hs = S.startSingle ? hold + zt : 0, he = S.endSingle ? hold + zt : 0;
  const turn = N * per, want = Math.max(0.5, num(S.duration, turn));
  const D = !hs && !he && S.seamless ? Math.max(1, Math.round(want / turn)) * turn : Math.max(want, hs + he + per);
  return { N, slide, per, hold, zt, hs, he, D };
}

// keys of a track whose value runs from a to b over [t0, t1] on a MotionFast ease (sampled when the editor has no
// exact curve for it), at positions % of a layer `span` long that starts at `at`
function easedKeys(name, t0, t1, a, b, at, span) {
  const e = EASES[name];
  if (e !== null && e !== undefined) return [{ position: pct(t0 - at, span), value: a, ...e }, { position: pct(t1 - at, span), value: b, easing: 'Linear' }];
  const curve = name === 'elastic'
    ? (u) => { const x = clamp(u, 0, 1) * 100, lo = Math.floor(x), hi = Math.min(100, lo + 1); return ELASTIC[lo] + (ELASTIC[hi] - ELASTIC[lo]) * (x - lo); }
    : (u) => (u >= 1 ? 1 : 1 - Math.pow(2, -10 * u));
  const out = [];
  const count = name === 'elastic' ? 100 : 96;
  for (let j = 0; j <= count; j += 1) {
    const u = name === 'elastic' ? j / count : Math.pow(j / count, 1.6);
    out.push({ position: pct(t0 + u * (t1 - t0) - at, span), value: a + (b - a) * curve(u), easing: 'Linear' });
  }
  return out;
}
const asKeys = (list) => list.map((k) => ({ ...k, value: n(k.value) }));

export default {
  id: 'orbit',
  name: 'Carousel',
  category: 'Carousels',
  v: 1,
  fields,
  build({ settings: S, media, frame }) {
    const { W, H } = frame;
    const sc = H / 1080;                                 // MotionFast's px are px of a 1080-tall frame
    const Dcam = (H / 2) / Math.tan((LENS / 2) * D2R);   // the editor's camera distance
    const { N, slide, per, hold, hs, he, D } = timing(S);
    const Wm = Math.max(0, D - hs - he);                 // the ring moves only once it has grown
    const singles = hs > 0 || he > 0;
    const share = clamp(1 - num(S.stopShare, 0) / 100, 0.05, 1);
    const lead = (1 - share) / 2;
    const nSteps = slide ? (singles ? Math.floor(Wm / per + 1e-6) : Infinity) : 0;
    let r1 = 0, r2 = 0, v = 1 / per, total = Infinity;
    if (!slide && singles) {
      const r = Math.min(Math.max(0.3, per), Wm / 3);
      r1 = hs ? r : 0; r2 = he ? r : 0;
      const flat = Wm - (r1 + r2) / 2;
      if (he) { const k = Math.max(1, Math.round(flat / per)); v = flat > 0 ? k / flat : 0; }
      total = v * flat;
    }
    const A = (2 * Math.PI) / N;
    const dir = S.direction === 'reverse' ? -1 : 1;
    const view = clamp(num(S.view, 0), 0, 90) * D2R, sv = Math.sin(view), cv = Math.cos(view);
    const ang = num(S.angle, 0) * D2R, ca = Math.cos(ang), sa = Math.sin(ang);
    const R0 = Math.max(0, num(S.ringSize, 729)), P = Math.max(50, num(S.perspective, 1323));
    const ch = Math.max(2, num(S.cardSize, 568));
    const aspect = CARD_SHAPES[S.cardShape] || 1;
    const sVar = clamp(num(S.sizeVariety, 0), 0, 90) / 100, rVar = clamp(num(S.ringVariety, 0), 0, 90) / 100;
    const shade = clamp(num(S.shade, 0), 0, 100) / 100;
    const rad = Math.max(0, num(S.cornerRadius, 0));
    const offX = (num(S.offsetX, 0) / 100) * W, offY = (num(S.offsetY, 0) / 100) * H;   // frame px
    const outward = S.facing === 'outward';
    const seed = Math.round(num(S.seed, 1));
    const M = media.length, fill = S.fillEmpty !== false;
    const warnings = [];
    const darkens = shade > 0 && R0 * cv > 1e-6;

    // The ring's turn (slots advanced) on the layer that carries it: keys + how a card's ƒx reads it. The keys stay
    // between 0 and 1 (they sit on tracks whose keys the editor clamps: brightness from 0, positions to ±200 %):
    //   slide and stop: one step keyed (hold · slide easing · hold), repeated: loopOut('offset') adds a slot a beat
    //   steady: one card's time, straight, repeated the same way; with a single at either end the speed eases in
    //   after the grow and out before the gather (the whole turn keyed, as a share of it)
    let turnLayer = null;   // { start, end, keys, read }
    const loop = (span) => (span > per + 1e-6 ? "loopOut('offset')" : 'value');
    if (slide) {
      const end = singles ? hs + nSteps * per : D;
      if (end - hs > 1e-6) {
        const span = end - hs;
        const keys = [];
        if (lead > 1e-9) keys.push({ position: 0, value: 0, easing: 'Linear' });
        keys.push(...easedKeys(S.stepEase || 'reel', lead * per, (lead + share) * per, 0, 1, 0, span));
        if (lead > 1e-9) keys.push({ position: pct(per, span), value: 1, easing: 'Linear' });
        turnLayer = { start: hs, end, keys, read: loop(span) };
      }
    } else if (!singles) {
      turnLayer = { start: 0, end: D, keys: [{ position: 0, value: 0, easing: 'Linear' }, { position: pct(Math.min(per, D), D), value: Math.min(per, D) / per, easing: 'Linear' }], read: loop(D) };
    } else if (Wm > 1e-6 && total > 0) {
      const keys = [];
      const kA = r1 > 0 ? v * r1 / 2 : 0, kB = r2 > 0 ? total - v * r2 / 2 : total;
      keys.push({ position: 0, value: 0, ...(r1 > 0 ? BEZ(RAMP_IN) : { easing: 'Linear' }) });
      if (r1 > 0) keys.push({ position: pct(r1, Wm), value: kA / total, easing: 'Linear' });
      if (r2 > 0) keys.push({ position: pct(Wm - r2, Wm), value: kB / total, ...BEZ(RAMP_OUT) });
      keys.push({ position: 100, value: 1, easing: 'Linear' });
      turnLayer = { start: hs, end: hs + Wm, keys, read: `(value*${n(total)})` };
    }
    const kEnd = slide ? (singles ? nSteps : 0) : (singles ? total : 0);

    // Every value of a card is a function of where it is on the ring (sin θ, cos θ) and of the spread sp (1 = the
    // full ring, 0 = gathered into one picture), MotionFast renderOrbit: x3 = R sinθ, y3 = R cosθ sin(view),
    // z3 = (R cosθ − R0) cos(view), the ring scaled by sp toward the front point, seen from Perspective px.
    // The editor orders cards back to front by depth (its channels step 0.1 px apart): MotionFast orders them by z3,
    // also while gathered (sp → 0) and on a face-on ring (z3 all but 0). So a card's depth also carries a SORT term,
    // (R cosθ − R0)·kap, that spreads the cards over at least SORT_RANGE px whatever the view; the lens would draw that
    // depth bigger or smaller, so its place and size are divided by it again (g below): the picture is MotionFast's.
    const SORT_RANGE = 1000;
    const trueRange = 2 * R0 * cv * Dcam / P;
    const kapOf = (always) => (R0 > 1e-6 ? Math.max(0, (SORT_RANGE - (always ? 0 : trueRange)) / (2 * R0)) : 0);
    const cardOf = (i) => {
      const u = seed === 1 ? CLUSTER[i % CLUSTER.length] : 2 * hash01(i, seed) - 1;
      return { i, u, R: R0 * (1 - rVar * u), size0: Math.max(0.05, 1 + sVar * u) };
    };
    // the affine parts, at (s, c, sp)
    const parts = (cd, s, c, sp, kap) => {
      const x3 = cd.R * s, y3 = cd.R * c * sv, z3 = (cd.R * c - R0) * cv, zs = z3 * sp;
      const zTrue = (zs * Dcam) / P;
      return {
        X: ((((x3 * ca - y3 * sa) * sp * sc + offX * (1 - zs / P)) / W) * 100),
        Y: ((((x3 * sa + y3 * ca) * sp * sc + offY * (1 - zs / P)) / H) * 100),
        zTrue, zTot: zTrue + (cd.R * c - R0) * kap,
        dep: R0 * cv > 1e-6 ? -zs / (2 * R0 * cv) : 0,
        size: Math.max(0.05, 1 + sVar * cd.u * sp) / cd.size0,
      };
    };
    // an affine form as expression text: f0 + Σ k·sym (terms under 1e-12 left out)
    const aff = (f0, terms) => {
      const out = [...terms.filter(([k]) => Math.abs(k) >= 1e-12).map(([k, sym]) => `${n(k)}*${sym}`), ...(Math.abs(f0) >= 1e-12 ? [n(f0)] : [])];
      return out.length ? out.join('+').replace(/\+-/g, '-') : '0';
    };
    // the expressions of one card on one layer. vars: { s, c } numbers and sp a symbol (a spread layer), or s / c
    // symbols and sp = 1 (the turning layer). Each part is affine in what varies, so its coefficients are read off.
    const exprsOf = (cd, kap, vars) => {
      const form = (key) => {
        if (vars.turn) {
          const f0 = parts(cd, 0, 0, 1, kap)[key];
          return aff(f0, [[parts(cd, 1, 0, 1, kap)[key] - f0, vars.S], [parts(cd, 0, 1, 1, kap)[key] - f0, vars.C]]);
        }
        const f0 = parts(cd, vars.s, vars.c, 0, kap)[key];
        return aff(f0, [[parts(cd, vars.s, vars.c, 1, kap)[key] - f0, vars.sp]]);
      };
      const fix = kap > 0 ? `*(${aff(Dcam, [])}-(${form('zTot')}))/(${aff(Dcam, [])}-(${form('zTrue')}))` : '';
      const out = {};
      const X = form('X'), Y = form('Y'), Z = form('zTot');
      if (X !== '0') out.xPercent = fix ? `(${X})${fix}` : X;
      if (Y !== '0') out.yPercent = fix ? `(${Y})${fix}` : Y;
      if (Z !== '0') out.translateZ = Z;
      const sz = form('size');
      if (fix || sz !== '1') out.scale = fix ? `(${sz})${fix}` : sz;
      if (darkens) out.brightness = `100-${n(100 * shade)}*clamp(${form('dep')},0,1)`;
      if (outward) {
        if (vars.turn) out.rotate = `(atan2(${vars.S}*${n(sa)}+${vars.C}*${n(sv * ca)},${vars.S}*${n(ca)}-${vars.C}*${n(sv * sa)})+${n(Math.PI / 2)})*${n(1 / D2R)}`;
        else {
          const x3 = cd.R * vars.s, y3 = cd.R * vars.c * sv, z3 = (cd.R * vars.c - R0) * cv;
          const rz = P - z3 >= 1 ? (Math.atan2(x3 * sa + y3 * ca, x3 * ca - y3 * sa) + Math.PI / 2) / D2R : 0;
          out.rotate = aff(0, [[rz, vars.sp]]);
        }
      }
      return out;
    };
    // the tracks of a layer: each one's keys hold the layer's driver (the turn, or the spread) and its ƒx reads it
    // where the expression says @; the scale track holds driver + 1 (scale keys are clamped at 0.1) and reads it back
    const withFx = (exprs, keys, read, readScale) => {
      const tracks = {}, fxs = {};
      for (const [prop, code] of Object.entries(exprs)) {
        const scale = prop === 'scale';
        tracks[prop] = asKeys(keys.map((k) => ({ ...k, value: scale ? k.value + 1 : k.value })));
        fxs[prop] = { type: 'custom', params: { code: code.split('@').join(scale ? readScale : read) } };
      }
      return { propertyKeyframes: tracks, propertyKeyframeFx: fxs };
    };

    const layers = [];
    // back to front by depth is the camera's; level ties paint card 0 on top (MotionFast), so card 0 is listed last
    for (let i = N - 1; i >= 0; i -= 1) {
      const cd = cardOf(i);
      const m = M ? (fill ? i % M : (i < M ? i : -1)) : -1;
      const box = { w: r6(ch * aspect * sc * cd.size0), h: r6(ch * sc * cd.size0), fit: 'cover', radius: r6(rad * sc) };
      const plate = S[`color${(i % 4) + 1}`] || PLATES[i % 4];
      const plateSrc = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(box.w)}" height="${Math.round(box.h)}"><rect width="100%" height="100%" fill="${plate}"/></svg>`)}`;
      const picture = m >= 0
        ? { type: media[m].type === 'video' ? 'video' : 'image', media: m }
        : (M ? { type: 'image', src: plateSrc } : { type: 'image', media: i, src: plateSrc });
      const base = { ...picture, name: `Card ${i + 1}`, box, track: singles ? `card[${i}]` : undefined };
      // a layer of this card from t0 to t1 holding still at turn k while the spread follows `sps` ([time, sp, ease?])
      const spreadLayer = (key, t0, t1, k, sps) => {
        const span = t1 - t0;
        const th = dir * (k - i) * A;
        const keys = [];
        for (let j = 0; j < sps.length; j += 1) {
          const [t, sp, ease] = sps[j];
          const next = sps[j + 1];
          if (next && ease && EASES[ease] === null) keys.push(...easedKeys(ease, t, next[0], sp, next[1], t0, span).slice(0, -1));
          else keys.push({ position: pct(t - t0, span), value: sp, ...(next && ease && EASES[ease] ? EASES[ease] : { easing: 'Linear' }) });
        }
        const ex = exprsOf(cd, kapOf(true), { s: Math.sin(th), c: Math.cos(th), sp: '@' });
        return { ...base, key, freeStart: r6(t0), trimEnd: r6(span), ...withFx(ex, keys, 'value', '(value-1)') };
      };
      if (hs > 0) {
        // the grow: one picture (every card at the frame centre), then out into the ring
        const sps = hold > 1e-6 ? [[0, 0, null], [hold, 0, S.spreadEase], [hs, 1, null]] : [[0, 0, S.spreadEase], [hs, 1, null]];
        layers.push(spreadLayer(`card[${i}].grow`, 0, hs, 0, sps));
      }
      if (turnLayer) {
        const span = turnLayer.end - turnLayer.start;
        const a = dir * A, b = -dir * A * i;
        const th = `(${n(a)}*@${Math.abs(b) < 1e-12 ? '' : `${b < 0 ? '' : '+'}${n(b)}`})`;
        const ex = exprsOf(cd, kapOf(false), { turn: true, S: `sin${th}`, C: `cos${th}` });
        const readScale = turnLayer.read === "loopOut('offset')" ? "(loopOut('offset')-1)" : turnLayer.read.split('value').join('(value-1)');
        layers.push({ ...base, key: `card[${i}]`, freeStart: r6(turnLayer.start), trimEnd: r6(span), ...withFx(ex, turnLayer.keys, turnLayer.read, readScale) });
      }
      const restFrom = turnLayer ? turnLayer.end : hs;
      if (D - restFrom > 1e-6) {
        // after the turn: still at its last slot, then (End to single) gathered back into one picture
        const sps = [[restFrom, 1, null]];
        if (he > 0) {
          const g0 = D - he, g1 = D - hold;
          if (g0 - restFrom > 1e-6) sps.push([g0, 1, null]);
          sps[sps.length - 1][2] = S.spreadEase;
          sps.push([g1, 0, null]);
          if (D - g1 > 1e-6) sps.push([D, 0, null]);
        }
        layers.push(spreadLayer(`card[${i}].${he > 0 ? 'gather' : 'rest'}`, restFrom, D, kEnd, sps));
      }
    }
    if (M && media.some((x) => x.type === 'video')) warnings.push('A video on a card plays once (no loop yet).');
    return { duration: D, layers, warnings };
  },
};
