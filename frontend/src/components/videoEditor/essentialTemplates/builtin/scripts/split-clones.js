// Split Clones (MotionFast `split-clones`): the text enters (zooms, spins, pops, slides, flips, wipes or fades in),
// then copies of it step out from behind it, one after another, to both sides (or one) along an axis. Each copy shows
// only the part that clears the copy in front of it, so the hole of an O stays background and dark gaps open between
// the bands.
//
// Built from ordinary layers: a Stack null carries the entry (scale, turn, slide); under it the centre text on top
// and, below it, a text layer per copy and side (its step out, a straight key pair on the split's easing; its scale
// and its fade), each cut by an inverted track matte: a box that rides with the copy in front of it (the same keys)
// and hides everything up to that copy's edge, as MotionFast clips each copy against its neighbour's box. A wipe entry
// cuts the centre text with a growing box (its own matte).
//
// Text widths: the copies are clipped against the text block's box: its width (left / right steps) is the widest line,
// its height the lines' ink (the tallest letter above the baseline and the deepest below). A script cannot measure
// text, so it asks the host: measure() names every line (font, weight, size and tracking as the text layer draws it)
// and build() reads `metrics`: each line's width (plus the canvas's tracking after the last letter, as MotionFast
// measures it), its ink above and below the baseline, and the font box the text layer centres its rows on. Without
// metrics (node tools) an estimate (0.55 em a letter, MotionFast's own minimum ink) is used, with a warning.
//
// A built-in script (PLANS/ESSENTIAL_TEMPLATES.md §14): it imports nothing, so this same text also runs as a
// `kind: "script"` source. Numbers and timing are MotionFast's (motionTemplates/splitClones.js).
const REF_H = 1080;
// MotionFast's easings: the editor's key easing that draws the same curve, or null (sampled / a ƒx)
const T_ELASTIC = '0,.0221,.0739,.1485,.2394,.3402,.4458,.5517,.6541,.7502,.8375,.9149,.9813,1.0364,1.0803,1.1136,1.1369,1.1513,1.1579,1.1578,1.1522,1.1424,1.1294,1.1142,1.0978,1.081,1.0643,1.0485,1.0338,1.0205,1.009,.9992,.9912,.9849,.9803,.9772,.9754,.9748,.9752,.9764,.9782,.9804,.9829,.9856,.9882,.9908,.9933,.9955,.9975,.9992,1.0007,1.0018,1.0027,1.0034,1.0038,1.004,1.004,1.0039,1.0036,1.0033,1.0029,1.0025,1.0021,1.0017,1.0013,1.0009,1.0006,1.0003,1,.9998,.9996,.9995,.9994,.9994,.9994,.9994,.9994,.9994,.9995,.9996,.9996,.9997,.9998,.9998,.9999,.9999,1,1,1,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1.0001,1'.split(',').map(Number);
const KEY_EASE = {
  smooth: { easing: 'Custom', bezier: [0.5, 0, 0, 1] }, power2: { easing: 'Ease Out' }, power3: { easing: 'Cubic Out' },
  power4: { easing: 'Power' }, back: { easing: 'Back Out' }, bounce: { easing: 'Bounce Out' }, natural: { easing: 'Natural' },
  slowDown: { easing: 'Slow Down' }, overshoot: { easing: 'Overshoot' }, impulse: { easing: 'Impulse' }, swing: { easing: 'Swing' },
  aeIn: { easing: 'AE In (arrive)' }, aeSmooth: { easing: 'AE Smooth' }, aeOut: { easing: 'AE Out (leave)' },
};
const EASING_OPTIONS = [['smooth', 'Smooth'], ['power2', 'Power 2'], ['power3', 'Power 3'], ['power4', 'Power 4'], ['back', 'Back'],
  ['bounce', 'Bounce'], ['expo', 'Expo'], ['natural', 'Natural'], ['slowDown', 'Slow Down'], ['elastic', 'Elastic'], ['overshoot', 'Overshoot'],
  ['impulse', 'Impulse'], ['swing', 'Swing'], ['aeIn', 'AE In'], ['aeSmooth', 'AE Smooth'], ['aeOut', 'AE Out']].map(([value, label]) => ({ value, label }));
const elasticTable = (x) => { x = Math.min(1, Math.max(0, x)); const i = x * 100, lo = Math.floor(i), hi = Math.min(100, lo + 1); return T_ELASTIC[lo] + (T_ELASTIC[hi] - T_ELASTIC[lo]) * (i - lo); };

const D0 = {
  text: 'O', fontFamily: "'Archivo Black', Impact, sans-serif", fontWeight: 800, fontSize: 560, letterSpacing: 0,
  textColor: '#33efab', shapeColor: '#33efab', cloneFade: 0, entry: 'zoomOut', entryEase: 'power3', entryFade: false,
  zoomAmount: 14, slideDistance: 70, entryDur: 1.4, axis: 'vertical', cloneCount: 4, stepPct: 15, stepScale: 1, mirror: true,
  splitEase: 'power3', splitStart: 1.15, splitDur: 0.7, cloneLag: 0.07, hold: 1.2, speed: 1,
};
const ENTRY_OPTIONS = [['zoomOut', 'Zoom Out'], ['zoomIn', 'Zoom In'], ['rotate', 'Spin In'], ['elastic', 'Elastic Pop'], ['slideUp', 'Slide Up'],
  ['slideDown', 'Slide Down'], ['slideLeft', 'Slide Left'], ['slideRight', 'Slide Right'], ['flip', '3D Flip'], ['reveal', 'Clip Down'],
  ['revealUp', 'Clip Up'], ['revealLeft', 'Clip Left'], ['revealRight', 'Clip Right'], ['fade', 'Fade In'], ['none', 'None']].map(([value, label]) => ({ value, label }));
const range = (key, label, min, max, step, suffix, extra = {}) => ({ key, type: 'range', label, default: D0[key], min, max, step, ...(suffix ? { suffix } : {}), ...extra });
const fields = [
  { type: 'group', key: 'gText', label: 'Text' },
  { key: 'text', type: 'textarea', label: 'Text', default: D0.text, rows: 2 },
  { type: 'group', key: 'gType', label: 'Typeface' },
  { key: 'fontFamily', type: 'font', label: 'Font', default: D0.fontFamily },
  { key: 'fontWeight', type: 'select', label: 'Weight', default: 800, options: [
    { value: 400, label: 'Regular' }, { value: 600, label: 'Semibold' }, { value: 700, label: 'Bold' }, { value: 800, label: 'Extra Bold' }, { value: 900, label: 'Black' },
  ] },
  range('fontSize', 'Size', 40, 700, 5, 'px'),
  range('letterSpacing', 'Letter Spacing', -20, 60, 1),
  { type: 'group', key: 'gColor', label: 'Colours' },
  { key: 'textColor', type: 'color', label: 'Text Color (centre)', default: D0.textColor },
  { key: 'shapeColor', type: 'color', label: 'Shape Color (clones)', default: D0.shapeColor },
  range('cloneFade', 'Clone Fade', 0, 1, 0.05),
  { type: 'group', key: 'gEntry', label: 'Entry' },
  { key: 'entry', type: 'select', label: 'Entry Effect', default: 'zoomOut', options: ENTRY_OPTIONS },
  { key: 'entryEase', type: 'select', label: 'Entry Easing', default: 'power3', options: EASING_OPTIONS },
  { key: 'entryFade', type: 'switch', label: 'Fade In With Entry', default: false },
  range('zoomAmount', 'Zoom Amount', 1.5, 40, 0.5, '×'),
  range('slideDistance', 'Slide Distance', 10, 150, 5, '%'),
  range('entryDur', 'Entry Duration', 0.2, 4, 0.05, 's'),
  { type: 'group', key: 'gClones', label: 'Clones' },
  { key: 'axis', type: 'select', label: 'Step Direction', default: 'vertical', options: [{ value: 'vertical', label: 'Top / Bottom' }, { value: 'horizontal', label: 'Left / Right' }, { value: 'diagonal', label: 'Diagonal' }] },
  range('cloneCount', 'Clones Per Side', 0, 10, 1, '', { integer: true }),
  range('stepPct', 'Step Distance', 2, 120, 1, '%'),
  range('stepScale', 'Step Scale', 0.6, 1.15, 0.01, '×'),
  { key: 'mirror', type: 'switch', label: 'Mirror Both Sides', default: true },
  { type: 'group', key: 'gSplit', label: 'Split' },
  { key: 'splitEase', type: 'select', label: 'Clone Easing', default: 'power3', options: EASING_OPTIONS },
  range('splitStart', 'Split Start', 0, 4, 0.05, 's'),
  range('splitDur', 'Step Duration', 0.1, 3, 0.05, 's'),
  range('cloneLag', 'Clone Lag', 0, 0.4, 0.01, 's'),
  { type: 'group', key: 'gTiming', label: 'Timing' },
  range('hold', 'Hold', 0, 10, 0.1, 's'),
  range('speed', 'Speed', 0.3, 2.5, 0.05, '×'),
];

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r6 = (v) => { const x = Math.round(v * 1e6) / 1e6; return Object.is(x, -0) ? 0 : x; };
const n = (v) => { const x = Number(v); return Math.abs(x) < 1e-12 ? '0' : String(Number(x.toPrecision(10))); };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fx = (code) => ({ type: 'custom', params: { code } });
const one = (v) => [{ position: 0, value: n(v), easing: 'Linear' }];

export default {
  id: 'split-clones',
  name: 'Split Clones',
  category: 'Typography',
  v: 1,
  fields,
  // every line at the size and tracking the text layer draws it
  measure({ settings, frame }) {
    const p = { ...D0, ...settings };
    const fs = Math.max(1, (Number(p.fontSize) || 200) * (frame.H / REF_H));
    const ls = (Number(p.letterSpacing) || 0) * (fs / 100);
    return String(p.text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
      .map((line, i) => ({ key: `line[${i}]`, text: line, font: String(p.fontFamily || D0.fontFamily), size: fs, weight: Number(p.fontWeight) || 800, letterSpacing: ls }))
      .filter((r) => Array.from(r.text).length <= 256).slice(0, 128);
  },
  build({ settings, frame, metrics }) {
    const p = { ...D0, ...settings };
    const { W, H } = frame;
    const s = H / REF_H;
    const warnings = [];
    const speed = Math.max(0.1, Number(p.speed) || 1);
    const N = Math.max(0, Math.round(Number(p.cloneCount) || 0));
    const entryDur = Math.max(0.01, Number(p.entryDur) || 0.01);
    const splitStart = Number(p.splitStart) || 0, splitDur = Math.max(0.01, Number(p.splitDur) || 0.01);
    const lag = Math.max(0, Number(p.cloneLag) || 0);
    const raw = Math.max(Number(p.entryDur) || 0, splitStart) + (Number(p.splitDur) || 0) + Math.max(0, N - 1) * lag + (Number(p.hold) || 0);
    const D = Math.max(1, raw / speed);
    const at = (tDesign) => tDesign / speed;                    // design seconds → the clip's
    const key = (t, v, e) => ({ position: r6(clamp((t / D) * 100, 0, 100)), value: n(v), ...(e || { easing: 'Linear' }) });

    // ── the text block (MotionFast layout): its advance width and its ink height, from the tables ──
    const lines = String(p.text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (!lines.length) return { duration: D, layers: [{ key: 'empty', type: 'null', name: 'Empty' }], warnings: ['No text.'] };
    const fs = Math.max(1, (Number(p.fontSize) || 200) * s);
    const ls = (Number(p.letterSpacing) || 0) * (fs / 100);
    const lineH = fs * 1.02;
    const M = metrics || {};
    let maxW = 0, asc = fs * 0.72, desc = fs * 0.02, estimated = 0, box = null;
    lines.forEach((line, i) => {
      const m = M[`line[${i}]`];
      if (m && Number.isFinite(m.width)) {
        // the canvas's width (its tracking after the last letter too) and the line's ink, as MotionFast measures them
        maxW = Math.max(maxW, m.width + ls);
        if (Number.isFinite(m.inkAscent)) asc = Math.max(asc, m.inkAscent);
        if (Number.isFinite(m.inkDescent)) desc = Math.max(desc, m.inkDescent);
        if (!box && Number.isFinite(m.ascent) && Number.isFinite(m.descent)) box = { asc: m.ascent, desc: m.descent };
      } else {
        estimated += 1;
        maxW = Math.max(maxW, Array.from(line).length * (0.55 * fs + ls));
      }
    });
    if (!box) box = { asc: 0.95 * fs, desc: 0.25 * fs };
    if (estimated) warnings.push('No text metrics from the host: the box the copies are clipped by is sized from an estimate (0.55 em a letter).');
    const textH = (lines.length - 1) * lineH + asc + desc;
    const halfW = maxW / 2, halfH = textH / 2;
    // the text layer centres its rows' font boxes; MotionFast puts the first baseline at −textH/2 + ink ascent
    const rowBase = (lineH / 2) + (box.asc - box.desc) / 2;
    const shiftY = (-halfH + asc) - (-(lines.length * lineH) / 2 + rowBase);
    const shiftX = -ls / 2;                                        // Chromium spaces after the last letter too
    if (ls < -400 || ls > 1600) warnings.push('The letter spacing is past −400…1600 px: it is held there.');

    // ── the entry: a driver e (0 → 1 on the entry's easing) on every track that needs it, mapped by a ƒx ──
    const entry = p.entry || 'zoomOut';
    const Te = at(entryDur);
    let driver, E;
    if (entry === 'elastic' || p.entryEase === 'expo') {
      // MotionFast's elasticOut (Elastic Pop owns its curve) or its normalised expo: no key curve, a ƒx of the share q
      driver = [key(0, 0), key(Te, 1)];
      E = entry === 'elastic' ? '(value>=1?1:pow(2,-10*value)*sin((value*10-0.75)*2.0943951023931953)+1)' : `((1-pow(2,-10*value))/${n(1 - Math.pow(2, -10))})`;
    } else if (p.entryEase === 'elastic') {
      driver = Array.from({ length: 101 }, (_, j) => key((Te * j) / 100, elasticTable(j / 100)));
      E = 'value';
    } else {
      driver = [key(0, 0, KEY_EASE[p.entryEase] || KEY_EASE.smooth), key(Te, 1)];
      E = 'value';
    }
    const lift = (code) => code.replace(/value/g, '(value-1)');
    const plus1 = (keys) => keys.map((k) => ({ ...k, value: n(Number(k.value) + 1) }));
    const amt = Math.max(1.01, Number(p.zoomAmount) || 14);
    const tx = Number(p.slideDistance) || 0;                        // % of the frame
    const stack = { key: 'stack', type: 'null', name: 'Stack' };
    const sk = {}, sf = {};
    const lerpE = (a, b) => `(${n(a)}+${n(b - a)}*${E})`;
    if (entry === 'zoomOut' || entry === 'zoomIn' || entry === 'rotate' || entry === 'elastic') {
      const a = entry === 'zoomOut' ? amt : entry === 'elastic' ? 0.3 : 1 / amt;
      sk.scale = plus1(driver); sf.scale = fx(lift(lerpE(a, 1)));
    }
    if (entry === 'rotate') { sk.rotate = driver; sf.rotate = fx(lerpE(180, 0)); }
    if (entry === 'elastic') { sk.translateY = driver; sf.translateY = fx(lerpE(fs * 0.5, 0)); }
    if (entry === 'slideUp' || entry === 'slideDown') { sk.yPercent = driver; sf.yPercent = fx(lerpE(entry === 'slideUp' ? tx : -tx, 0)); }
    if (entry === 'slideLeft' || entry === 'slideRight') { sk.xPercent = driver; sf.xPercent = fx(lerpE(entry === 'slideLeft' ? tx : -tx, 0)); }
    if (entry === 'flip') { sk.scaleY = plus1(driver); sf.scaleY = fx(`max(0.001,${lift(E)})`); }
    const reveal = { reveal: 'down', revealUp: 'up', revealLeft: 'left', revealRight: 'right' }[entry] || null;
    if (reveal === 'down' || reveal === 'up') { sk.translateY = driver; sf.translateY = fx(lerpE(reveal === 'down' ? fs * 0.4 : -fs * 0.4, 0)); }
    if (reveal === 'left' || reveal === 'right') { sk.translateX = driver; sf.translateX = fx(lerpE(reveal === 'left' ? -fs * 0.4 : fs * 0.4, 0)); }
    if (Object.keys(sk).length) { stack.propertyKeyframes = sk; stack.propertyKeyframeFx = sf; }
    // the entry's fade (Fade In, or Fade In With Entry), × a copy's own fade
    const fades = (entry === 'fade' ? 1 : 0) + (p.entryFade ? 1 : 0);
    // (a copy is hidden until it starts to step out: MotionFast skips a copy that has not cleared its neighbour, and a
    // copy larger than the text (Step Scale > 1) would peek out round it)
    const opacity = (alpha, from = 0) => {
      if (!fades) {
        if (from > 0) return { propertyKeyframes: { opacity: [key(0, 0, { easing: 'Hold' }), key(from, alpha)] } };
        return alpha < 1 ? { propertyKeyframes: { opacity: one(alpha) } } : {};
      }
      const f = `clamp(${E},0,1)`;
      const code = `${fades === 2 ? `${f}*${f}` : f}*${n(alpha)}`;
      return { propertyKeyframes: { opacity: driver }, propertyKeyframeFx: { opacity: fx(from > 0 ? `(time<${n(from)}?0:${code})` : code) } };
    };
    if (entry !== 'zoomOut' && entry !== 'zoomIn' && entry !== 'rotate' && entry !== 'elastic' && entry !== 'flip' && (Number(p.splitStart) || 0) < entryDur && reveal) {
      warnings.push('The copies step out while the wipe is still running: the wipe cuts the centre text only.');
    }

    // ── the copies: copy i steps out to i·step on the split's easing from splitStart + (i − 1)·lag (MotionFast clamps the
    // eased share to 0…1); everything is in the Stack's own units, where the entry's scale is already divided out ──
    const vertical = p.axis === 'vertical', horizontal = p.axis === 'horizontal';
    const ux = vertical ? 0 : 1, uy = horizontal ? 0 : 1;
    if (p.axis === 'diagonal' && entry === 'flip') warnings.push('Diagonal steps with the 3D Flip entry: the steps follow the text\'s own scale (MotionFast averages the two axes).');
    const step = fs * (Number(p.stepPct) || 0) / 100;
    const sides = p.mirror ? [-1, 1] : [1];
    const perStep = Number(p.stepScale) || 1;
    const fade = clamp(Number(p.cloneFade) || 0, 0, 1);
    const splitKey = KEY_EASE[p.splitEase] || null;
    // a copy's travel (0 → i·step) as keys of one track, the clamp in a ƒx
    const travel = (i, sign) => {
      const t0 = at(splitStart + (i - 1) * lag), t1 = at(splitStart + (i - 1) * lag + splitDur);
      const d = sign * i * step;
      if (p.splitEase === 'expo') {
        return { keys: [key(t0, 0), key(t1, 1)], code: `clamp((1-pow(2,-10*value))/${n(1 - Math.pow(2, -10))},0,1)*${n(d)}` };
      }
      if (!splitKey) {
        const k = Array.from({ length: 101 }, (_, j) => key(t0 + ((t1 - t0) * j) / 100, clamp(elasticTable(j / 100), 0, 1) * d));
        return { keys: k, code: null };
      }
      return { keys: [key(t0, 0, splitKey), key(t1, d)], code: `clamp(value,${n(Math.min(0, d))},${n(Math.max(0, d))})` };
    };
    const layers = [stack];
    // a text layer holds letter spacing within −20…80 px: past it the text is drawn at fs / k with spacing / k and every
    // text layer zoomed by k (its Scale keys multiply it), the same glyphs in the same places
    const kz = Math.min(20, ls < -20 ? ls / -20 : ls > 80 ? ls / 80 : 1);
    const textBase = {
      type: 'text', textContent: lines.join('\n'), textFontFamily: p.fontFamily, textFontWeight: Number(p.fontWeight) || 800,
      textFontSizeUnit: 'px', textFontSize: r4(fs / kz), textAlign: 'center', textLineHeight: 1.02, textNoWrap: true,
      ...(ls ? { textLetterSpacing: r4(clamp(ls / kz, -20, 80)) } : {}), ...(kz > 1 ? { zoom: r6(kz) } : {}),
      keyframeParenting: { parentItemId: 'stack', type: 'additive' },
    };
    // the box a copy is clipped against, as a matte that hides everything up to the edge of the copy in front of it
    const reach = N * step + textH * Math.max(1, Math.pow(perStep, N)) + fs;
    const wideX = halfW * Math.max(1, Math.pow(perStep, N)) + N * step * ux + fs;
    const wideY = halfH * Math.max(1, Math.pow(perStep, N)) + N * step * uy + fs;
    for (let i = N; i >= 1; i -= 1) {
      const alpha = 1 - fade * (i / Math.max(1, N));
      if (alpha <= 0) continue;
      const sc = Math.pow(perStep, i);
      for (const side of sides) {
        const id = `${i}${side < 0 ? 'a' : 'b'}`;
        // the hider: a box from the neighbour's edge (side · its travel ± the half box) back over the stack
        const front = i > 1 ? travel(i - 1, side) : null;
        const along = uy ? 'translateY' : 'translateX';
        const half = uy ? halfH : halfW;
        const hk = {}, hf = {};
        const edge = side * half;                                   // + the neighbour's travel
        const centre = edge - (side * reach) / 2;                   // the box spans [edge − side·reach, edge]
        if (front) {
          hk[along] = front.keys.map((k) => ({ ...k, value: n(Number(k.value)) }));
          hf[along] = fx(`${front.code ? front.code : 'value'}+${n(centre)}`);
        } else hk[along] = one(centre);
        if (uy && ux) { /* diagonal: the clip is MotionFast's vertical one */ }
        layers.push({
          key: `hide[${id}]`, type: 'shape', name: `Copy ${i} ${side < 0 ? 'A' : 'B'} cut`, keyframeParenting: { parentItemId: 'stack', type: 'additive' },
          shapeType: 'rectangle', shapeSizeUnit: 'px', shapeWidthPx: r4(uy ? 2 * wideX : reach), shapeHeightPx: r4(uy ? reach : 2 * wideY), shapeFillColor: '#ffffff',
          propertyKeyframes: hk, ...(Object.keys(hf).length ? { propertyKeyframeFx: hf } : {}),
        });
        const tr = travel(i, side);
        const ck = {}, cf = {};
        const offs = (axisOn, sh) => ({ keys: tr.keys, code: `${tr.code ? tr.code : 'value'}+${n(sh)}`, on: axisOn });
        const ox = offs(ux, shiftX * sc), oy = offs(uy, shiftY * sc);
        if (ux) { ck.translateX = ox.keys; cf.translateX = fx(ox.code); } else ck.translateX = one(shiftX * sc);
        if (uy) { ck.translateY = oy.keys; cf.translateY = fx(oy.code); } else ck.translateY = one(shiftY * sc);
        if (sc !== 1) ck.scale = one(sc);
        const op = opacity(alpha, at(splitStart + (i - 1) * lag) + 0.001);
        layers.push({
          ...textBase, key: `copy[${id}]`, name: `Copy ${i} ${side < 0 ? 'A' : 'B'}`, textColor: p.shapeColor,
          trackMatte: { sourceId: `hide[${id}]`, mode: 'alphaInverted' },
          propertyKeyframes: { ...ck, ...(op.propertyKeyframes || {}) }, propertyKeyframeFx: { ...cf, ...(op.propertyKeyframeFx || {}) },
        });
      }
    }
    // the centre text (on top), cut by the wipe while a wipe entry runs
    const centre = { ...textBase, key: 'text', name: 'Text', textColor: p.textColor,
      propertyKeyframes: { translateX: one(shiftX), translateY: one(shiftY), ...(opacity(1).propertyKeyframes || {}) },
      ...(opacity(1).propertyKeyframeFx ? { propertyKeyframeFx: opacity(1).propertyKeyframeFx } : {}) };
    if (reveal) {
      // MotionFast's wipe: the stack's box (± 0.15 em) opened from one side by e
      const m = fs * 0.15, bw = (halfW + m) * 2, bh = (halfH + m) * 2;
      const vert = reveal === 'down' || reveal === 'up';
      const dir = reveal === 'down' || reveal === 'left' ? -1 : 1;     // the side it opens from
      const wk = {}, wf = {};
      const size = vert ? bh : bw;
      if (vert) { wk.shapeHeightPx = plus1(driver); wf.shapeHeightPx = fx(`max(0.5,${n(size)}*clamp(${lift(E)},0,1))`); wk.translateY = driver; wf.translateY = fx(`${n(dir * size / 2)}-${n(dir * size / 2)}*clamp(${E},0,1)`); }
      else { wk.shapeWidthPx = plus1(driver); wf.shapeWidthPx = fx(`max(0.5,${n(size)}*clamp(${lift(E)},0,1))`); wk.translateX = driver; wf.translateX = fx(`${n(dir * size / 2)}-${n(dir * size / 2)}*clamp(${E},0,1)`); }
      layers.push({ key: 'wipe', type: 'shape', name: 'Wipe', keyframeParenting: { parentItemId: 'stack', type: 'additive' },
        shapeType: 'rectangle', shapeSizeUnit: 'px', shapeWidthPx: r4(bw), shapeHeightPx: r4(bh), shapeFillColor: '#ffffff',
        propertyKeyframes: wk, propertyKeyframeFx: wf });
      centre.trackMatte = { sourceId: 'wipe', mode: 'alpha' };
    }
    layers.push(centre);
    return { duration: D, layers, warnings };
  },
};
