// Glow Edge Pill (MotionFast `glow-edge-pill`): a capsule (or rounded box, or ellipse) whose outline is a lit ring
// (a bright core line, a hot bloom hugging it, a wide blurred halo) with a label in the middle. The colour along the
// edge comes from a conic gradient that spins; the halo samples the same palette turned by Halo Hue Shift. The ring
// traces itself in (or ignites, or grows), breathes, can be clicked by a cursor at the end, and fades out.
//
// Built from ordinary layers. Each of MotionFast's light passes (halo, mid bloom, inner bloom, core line, and the two
// bright heads while the edge traces) is a PAIR:
//   <pass>.src    the outline as a white stroke of the pass's width, blurred by a Fast Blur of the pass's softness, its
//                 Trim keyed for the trace: the track matte that shapes the light;
//   <pass>.glow   a square picture of the pass's conic palette (tinted toward its home colour, whitened for the core),
//                 turned by the spin, added (blend Add) through that matte at the pass's level. Its Layer Mask subtracts
//                 the inside of the outline at Inner Cut, turned back against the spin so it stays on the outline.
// The breathing, the intro levels, the click flash and the outro are one driver key track per layer (the intro's ease,
// the click's press and spring, the outro's fade, in that order and never at once) and a short ƒx that adds the pulse.
// The label is a text layer; the cursor a picture; the grain a Film Grain adjustment over the pill.
//
// Text widths: the pill's width follows the label (max(Min Width, label + 2 × Pad X)). A script cannot measure text,
// so it asks the host: measure() names the label (its font, weight, size, tracking) and build() reads metrics.label,
// measured in the page the way the text layer will draw it (any font, fonts loaded first): its width, and its font
// box against the canvas 'middle' line for the label's vertical place. Where the host cannot measure (node tools and
// tests) the label's width comes from a table of Helvetica Neue's advance widths and kerning pairs as Chromium's canvas
// measures them on macOS (MotionFast's default font; weights 400 / 500 / 700, the browser takes 600–900 as 700),
// embedded below; another font then gets the same table and a warning. The label itself is always drawn by the text
// layer in the chosen font, centred.
//
// A built-in script (PLANS/ESSENTIAL_TEMPLATES.md §14): it imports nothing, so this same text also runs as a
// `kind: "script"` source. Numbers and timing are MotionFast's (motionTemplates/glowEdgePill.js).
const REF_H = 1080;
const CLICK_TRAVEL = 0.8, CLICK_PRESS = 0.16, CLICK_RELEASE = 0.36, CLICK_SETTLE = 0.75;

// Helvetica Neue in Chromium's canvas (tools: measure.mjs), 1/1000 em: one advance per CHARS character, kerning pairs
const CHARS = "0123456789 !\"#$%&'()*+,-./:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~’‘“”–—…•·©®™°€£¥×÷±§¶ÄÖÜäöüßÀÁÂÃÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕØÙÚÛÝàáâãåæçèéêëìíîïñòóôõøùúûýÿ→←↑↓✦★";
const HN = {
  400: { mid: 52.3, adv: '556,556,556,556,556,556,556,556,556,556,278,259,426,556,556,1000,630,278,259,259,352,600,278,389,278,333,278,278,600,600,600,556,800,648,685,722,704,611,574,759,722,259,519,667,556,871,722,760,648,760,685,648,574,722,611,926,611,648,611,259,333,259,600,500,222,537,593,537,593,537,296,574,556,222,222,519,222,853,556,574,593,593,333,500,315,556,500,758,518,500,480,333,222,333,600,278,278,426,426,500,1000,1000,350,278,800,800,990,400,556,556,556,600,600,600,556,600,648,760,722,537,574,556,556,648,648,648,648,648,926,722,611,611,611,611,259,259,259,259,722,760,760,760,760,760,722,722,722,648,537,537,537,537,537,870,537,537,537,537,537,222,222,222,222,556,574,574,574,574,574,556,556,556,500,500,1000,1000,500,500,793,1000',
    kern: 'AT-92 AV-46 AW-24 AY-74 Av-18 Aw-18 Ay-18 F,-157 F.-157 FA-55 LT-92 LV-92 LW-55 LY-111 Ly-37 P,-179 P.-179 PA-74 RT-18 RV-18 RW-18 RY-37 T,-111 T--129 T.-111 T:-111 T;-111 TA-92 Ta-111 Tc-111 Te-111 To-111 Tr-92 Ts-111 Tu-92 Tw-111 Ty-111 V,-129 V--55 V.-129 V:-46 V;-46 VA-46 Va-55 Ve-55 Vi-18 Vo-55 Vr-37 Vu-37 Vy-18 W,-74 W.-74 W:-18 W;-18 WA-24 Wa-37 We-57 Wo-57 Wr-18 Wu-18 Y,-139 Y--111 Y.-139 Y:-92 Y;-92 YA-74 Ya-92 Ye-111 Yi-37 Yo-111 Yp-74 Yq-92 Yu-74 Yv-55 ff-15 r,-92 r--55 r.-92 rc-18 rd-18 re-18 rg-28 rn18 ro-18 rq-18 v,-74 v.-74 w,-55 w.-55 y,-74 y.-74' },
  500: { mid: 61, adv: '556,556,556,556,556,556,556,556,556,556,278,278,444,556,556,1000,648,278,278,278,370,600,278,389,278,352,278,278,600,600,600,556,800,667,704,722,722,630,593,759,722,278,537,685,574,889,722,760,667,760,704,648,593,722,611,944,648,648,630,296,352,296,600,500,241,556,611,556,611,556,315,593,574,241,241,537,241,870,574,593,611,611,352,519,333,574,519,778,537,519,500,296,222,296,600,278,278,444,444,500,1000,1000,500,278,800,800,990,400,556,556,556,600,600,600,556,600,667,760,722,556,593,574,574,667,667,667,667,667,963,722,630,630,630,630,278,278,278,278,722,760,760,760,760,760,722,722,722,648,556,556,556,556,556,889,556,556,556,556,556,241,241,241,241,574,593,593,593,593,593,574,574,574,519,519,1000,1000,500,500,793,1000',
    kern: 'AT-92 AV-62 AW-25 AY-74 Av-18 Aw-18 Ay-18 F,-129 F.-129 FA-55 IJ6 LT-92 LV-92 LW-55 LY-111 Ly-37 P,-169 P.-169 PA-74 RT-18 RV-18 RW-18 RY-37 T,-111 T--129 T.-111 T:-83 T;-83 TA-92 Ta-100 Tc-111 Te-111 To-111 Tr-92 Ts-111 Tu-92 Tw-111 Ty-111 V,-129 V--55 V.-129 V:-46 V;-46 VA-55 Va-55 Ve-55 Vi10 Vo-55 Vr-37 Vu-37 Vy-18 W,-74 W--28 W.-74 W:-18 W;-18 WA-25 Wa-37 We-18 Wo-18 Wr-18 Wu-18 Y,-111 Y--111 Y.-111 Y:-92 Y;-92 YA-74 Ya-92 Ye-92 Yi-9 Yo-92 Yp-86 Yq-104 Yu-86 Yv-55 ff-18 ij-8 r,-92 r--55 r.-92 rc-18 rd-18 re-18 rn18 ro-18 rq-18 v,-74 v.-74 w,-55 w.-55 y,-92 y.-92' },
  700: { mid: 61, adv: '556,556,556,556,556,556,556,556,556,556,278,278,463,556,556,1000,685,278,296,296,407,600,278,407,278,371,278,278,600,600,600,556,800,685,704,741,741,648,593,759,741,295,556,722,593,907,741,778,667,778,722,649,611,741,630,944,667,667,648,333,371,333,600,500,259,574,611,574,611,574,333,611,593,258,278,574,258,906,593,611,611,611,389,537,352,593,520,814,537,519,519,333,223,333,600,278,278,463,463,500,1000,1000,350,278,800,800,1000,400,556,556,556,600,600,600,556,620,685,778,741,574,611,593,611,685,685,685,685,685,981,741,648,648,648,648,295,295,295,295,741,778,778,778,778,778,741,741,741,667,574,574,574,574,574,907,574,574,574,574,574,258,258,258,258,593,611,611,611,611,611,593,593,593,519,519,1000,1000,500,500,793,1000',
    kern: 'AT-92 AV-46 AW-24 AY-74 Av-18 Aw-18 Ay-18 F,-157 F.-157 FA-55 LT-92 LV-92 LW-55 LY-111 Ly-37 P,-179 P.-179 PA-74 RT-18 RV-18 RW-18 RY-37 T,-111 T--129 T.-111 T:-111 T;-111 TA-92 Ta-111 Tc-111 Te-111 To-111 Tr-92 Ts-111 Tu-92 Tw-111 Ty-111 V,-129 V--55 V.-129 V:-46 V;-46 VA-46 Va-55 Ve-55 Vi-18 Vo-55 Vr-37 Vu-37 Vy-18 W,-74 W.-74 W:-18 W;-18 WA-24 Wa-37 We-57 Wo-57 Wr-18 Wu-18 Y,-139 Y--111 Y.-139 Y:-92 Y;-92 YA-74 Ya-92 Ye-111 Yi-37 Yo-111 Yp-74 Yq-92 Yu-74 Yv-55 ff-30 fi20 fl20 r,-92 r--55 r.-92 rc-18 rd-18 re-18 rg-28 rn18 ro-18 rq-18 v,-74 v.-74 w,-55 w.-55 y,-74 y.-74' },
};
const tableOf = (weight) => {
  const w = Number(weight) || 500;
  const t = HN[w <= 450 ? 400 : w <= 550 ? 500 : 700];
  if (!t.map) {
    const adv = t.adv.split(',').map(Number);
    t.map = {};
    Array.from(CHARS).forEach((ch, i) => { t.map[ch] = adv[i]; });
    t.pairs = {};
    for (const p of t.kern.split(' ')) t.pairs[p.slice(0, 2)] = Number(p.slice(2));
  }
  return t;
};
// The label's width as MotionFast's canvas measures it (letterSpacing included after every character, as Chromium does)
function measureLabel(text, weight, sizePx, lsPx) {
  const t = tableOf(weight);
  const chars = Array.from(String(text || ''));
  let em = 0, unknown = 0;
  chars.forEach((ch, i) => {
    const a = t.map[ch];
    if (a === undefined) { unknown += 1; em += 556; } else em += a;
    if (i + 1 < chars.length) em += t.pairs[ch + chars[i + 1]] || 0;
  });
  return { w: (em / 1000) * sizePx + chars.length * lsPx, unknown };
}
const isHelveticaNeue = (family) => /^\s*['"]?helvetica neue['"]?\s*(,|$)/i.test(String(family || ''));

// ── MotionFast's options ───────────────────────────────────────────────────────────────────────────────────────────
const D0 = {
  text: 'Touch', fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif", fontWeight: 500, fontSize: 128, letterSpacing: 0,
  textColor: '#ffffff', textGlow: 0, textGlowRadius: 13, textSoftness: 0,
  shape: 'pill', padX: 250, padY: 168, minWidth: 360, fitWidth: 86, fitHeight: 88, cornerRadius: 70, offsetX: 0, offsetY: 0,
  intensity: 100, glowSize: 92, glowSoftness: 82, glowLevel: 95, midLevel: 78, innerLevel: 95, ringWidth: 18, coreWidth: 4.4,
  coreWhite: 26, coreLevel: 100, innerCut: 90, coreTint: 62, haloTint: 58, phaseSpread: 122,
  colorA: '#ff5c8a', colorB: '#5b8cf0', colorC: '#a86ff0',
  speed: 1, spin: 42, phase: 0, pulse: 14, pulseRate: 0.5,
  intro: 'trace', introDur: 1.3, introEase: 'aeSmooth', traceMode: 'split', traceFrom: 'top', headBoost: 80,
  textDelay: 55, textDur: 0.75, textAnim: 'blurUp',
  hold: 2.6, outro: 'fade', outroDur: 0.6,
  endClick: false, clickFrom: 'br', cursorSize: 158, clickBoost: 70, clickHold: 0,
  grain: 12,
};
const EASE_OPTIONS = [
  { value: 'aeSmooth', label: 'AE Smooth' }, { value: 'aeIn', label: 'AE In' }, { value: 'aeOut', label: 'AE Out' },
  { value: 'smooth', label: 'Smooth' }, { value: 'linear', label: 'Linear' },
];
const range = (key, label, min, max, step, suffix, extra = {}) => ({ key, type: 'range', label, default: D0[key], min, max, step, ...(suffix ? { suffix } : {}), ...extra });
const fields = [
  { type: 'group', key: 'gLabel', label: 'Label' },
  { key: 'text', type: 'text', label: 'Label', default: D0.text },
  { type: 'group', key: 'gType', label: 'Typeface' },
  { key: 'fontFamily', type: 'font', label: 'Font', default: D0.fontFamily },
  { key: 'fontWeight', type: 'select', label: 'Weight', default: 500, options: [
    { value: 400, label: 'Regular' }, { value: 500, label: 'Medium' }, { value: 600, label: 'Semibold' }, { value: 700, label: 'Bold' },
    { value: 800, label: 'Extra Bold' }, { value: 900, label: 'Black' },
  ] },
  range('fontSize', 'Size', 40, 340, 2, 'px'),
  range('letterSpacing', 'Tracking', -10, 40, 1, 'px'),
  { type: 'group', key: 'gTextLook', label: 'Text Look' },
  { key: 'textColor', type: 'color', label: 'Text Color', default: D0.textColor },
  range('textGlow', 'Text Bloom', 0, 150, 5, '%'),
  range('textGlowRadius', 'Bloom Radius', 0, 90, 2, 'px'),
  range('textSoftness', 'Text Softness', 0, 10, 0.2, 'px'),
  { type: 'group', key: 'gShape', label: 'Shape' },
  { key: 'shape', type: 'select', label: 'Shape', default: 'pill', options: [{ value: 'pill', label: 'Pill' }, { value: 'rounded', label: 'Rounded Box' }, { value: 'ellipse', label: 'Ellipse' }] },
  range('cornerRadius', 'Corner Radius', 0, 300, 5, 'px', { showIf: { key: 'shape', equals: 'rounded' } }),
  range('padX', 'Pad X', 20, 500, 5, 'px'),
  range('padY', 'Pad Y', 10, 400, 5, 'px'),
  range('minWidth', 'Min Width', 0, 1400, 10, 'px'),
  range('fitWidth', 'Fit Width', 30, 100, 1, '%'),
  range('fitHeight', 'Fit Height', 30, 100, 1, '%'),
  range('offsetX', 'Offset X', -40, 40, 1, '%'),
  range('offsetY', 'Offset Y', -40, 40, 1, '%'),
  { type: 'group', key: 'gColor', label: 'Colours' },
  { key: 'colorA', type: 'color', label: 'Hot', default: D0.colorA },
  { key: 'colorB', type: 'color', label: 'Cool', default: D0.colorB },
  { key: 'colorC', type: 'color', label: 'Bridge', default: D0.colorC },
  range('coreTint', 'Line → Hot', 0, 100, 2, '%'),
  range('haloTint', 'Halo → Cool', 0, 100, 2, '%'),
  range('phaseSpread', 'Halo Hue Shift', 0, 360, 2, '°'),
  range('phase', 'Palette Angle', 0, 360, 2, '°'),
  { type: 'group', key: 'gGlow', label: 'Glow' },
  range('intensity', 'Glow Intensity', 0, 200, 2, '%'),
  range('glowSize', 'Glow Size', 4, 280, 2, 'px'),
  range('glowSoftness', 'Glow Softness', 0, 140, 2, '%'),
  range('glowLevel', 'Halo', 0, 200, 2, '%'),
  range('midLevel', 'Mid Bloom', 0, 200, 2, '%'),
  range('innerLevel', 'Inner Bloom', 0, 200, 2, '%'),
  range('ringWidth', 'Edge Width', 1, 60, 0.5, 'px'),
  range('coreWidth', 'Core Line', 0, 20, 0.2, 'px'),
  range('coreWhite', 'Core White', 0, 100, 1, '%'),
  range('coreLevel', 'Core Level', 0, 160, 5, '%'),
  range('innerCut', 'Inner Cut', 0, 100, 1, '%'),
  range('grain', 'Grain', 0, 100, 1, '%'),
  { type: 'group', key: 'gAnim', label: 'Animation' },
  range('speed', 'Speed', 0.3, 2.5, 0.05, 'x'),
  range('spin', 'Spin', -180, 180, 2, '°/s'),
  range('pulse', 'Pulse', 0, 60, 1, '%'),
  range('pulseRate', 'Pulse Rate', 0, 3, 0.05, 'Hz'),
  { type: 'group', key: 'gIntro', label: 'Intro' },
  { key: 'intro', type: 'select', label: 'Intro', default: 'trace', options: [{ value: 'trace', label: 'Trace the Edge' }, { value: 'ignite', label: 'Ignite' }, { value: 'grow', label: 'Grow In' }, { value: 'none', label: 'None' }] },
  range('introDur', 'Intro Time', 0.2, 3, 0.05, 's'),
  { key: 'introEase', type: 'select', label: 'Intro Easing', default: 'aeSmooth', options: EASE_OPTIONS },
  { key: 'traceMode', type: 'select', label: 'Trace Mode', default: 'split', showIf: { key: 'intro', equals: 'trace' }, options: [{ value: 'split', label: 'Split (both ways)' }, { value: 'sweep', label: 'Sweep (one way)' }] },
  { key: 'traceFrom', type: 'select', label: 'Trace From', default: 'top', showIf: { key: 'intro', equals: 'trace' }, options: [{ value: 'top', label: 'Top' }, { value: 'right', label: 'Right' }, { value: 'bottom', label: 'Bottom' }, { value: 'left', label: 'Left' }] },
  range('headBoost', 'Head Boost', 0, 200, 5, '%', { showIf: { key: 'intro', equals: 'trace' } }),
  { type: 'group', key: 'gTextIntro', label: 'Text Intro' },
  { key: 'textAnim', type: 'select', label: 'Text Intro', default: 'blurUp', options: [{ value: 'blurUp', label: 'Blur Up' }, { value: 'fade', label: 'Fade' }, { value: 'scale', label: 'Scale' }, { value: 'none', label: 'None' }] },
  range('textDelay', 'Text Delay', 0, 150, 5, '%'),
  range('textDur', 'Text Time', 0.1, 2, 0.05, 's'),
  { type: 'group', key: 'gOutro', label: 'Outro & Click' },
  range('hold', 'Hold', 0.3, 8, 0.1, 's'),
  { key: 'outro', type: 'select', label: 'Outro', default: 'fade', options: [{ value: 'fade', label: 'Fade Out' }, { value: 'none', label: 'None' }] },
  range('outroDur', 'Outro Time', 0.1, 2, 0.05, 's', { showIf: { key: 'outro', equals: 'fade' } }),
  { key: 'endClick', type: 'switch', label: 'Click at End', default: false },
  { key: 'clickFrom', type: 'select', label: 'Cursor From', default: 'br', showIf: { key: 'endClick', truthy: true }, options: [{ value: 'br', label: 'Bottom Right' }, { value: 'bl', label: 'Bottom Left' }, { value: 'tr', label: 'Top Right' }, { value: 'tl', label: 'Top Left' }] },
  range('cursorSize', 'Cursor Size', 60, 320, 4, 'px', { showIf: { key: 'endClick', truthy: true } }),
  range('clickBoost', 'Click Flash', 0, 200, 5, '%', { showIf: { key: 'endClick', truthy: true } }),
  range('clickHold', 'Hold After Click', 0, 8, 0.1, 's', { showIf: { key: 'endClick', truthy: true } }),
];

// ── small helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r6 = (v) => { const x = Math.round(v * 1e6) / 1e6; return Object.is(x, -0) ? 0 : x; };
const n = (v) => { const x = Number(v); return Math.abs(x) < 1e-12 ? '0' : String(Number(x.toPrecision(10))); };
const BACK_OUT = [0.3333, 1.5672, 0.6667, 1];        // MotionFast backOut(t, 1.70158), exactly: [1/3, (c + 3)/3, 2/3, 1]
// The click's release is 1 − clamp01(backOut(q)): the back-out curve only up to where it first reaches 1 (q0), then
// still. That piece of the curve as its own bezier (de Casteljau at q0; its x handles stay at 1/3, 2/3)
const BACK_Q0 = 1 - 1.70158 / 2.70158;
const BACK_CUT = (() => {
  const y = [0, (1.70158 + 3) / 3, 1, 1], t = BACK_Q0, l = (a, b) => a + (b - a) * t;
  const a = l(y[0], y[1]), b = l(y[1], y[2]), c = l(y[2], y[3]), d = l(a, b), e = l(b, c), f = l(d, e);
  return [0.3333, Math.round((a / f) * 1e4) / 1e4, 0.6667, Math.round((d / f) * 1e4) / 1e4];
})();
const EASE_KEY = {
  aeSmooth: { easing: 'AE Smooth' }, aeIn: { easing: 'AE In (arrive)' }, aeOut: { easing: 'AE Out (leave)' },
  smooth: { easing: 'Custom', bezier: [0.5, 0, 0, 1] }, linear: { easing: 'Linear' },
};
// a track from [t, value, ease?] entries on a layer [0, D]: ease = an EASE_KEY entry (the curve to the next key)
function track(D, entries) {
  const out = [];
  for (const [t, v, e] of entries) {
    const k = { position: r6(clamp((t / D) * 100, 0, 100)), value: typeof v === 'string' ? v : n(v), ...(e || { easing: 'Linear' }) };
    if (out.length && Math.abs(out[out.length - 1].position - k.position) < 1e-9) out[out.length - 1] = k; else out.push(k);
  }
  return out;
}
const fx = (code) => ({ type: 'custom', params: { code } });
function hexRgb(h) {
  let s = String(h || '#000').replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const v = parseInt(s.slice(0, 6), 16) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const mixRgb = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const hex2 = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
const svgUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

// The conic palette MotionFast strokes each pass with (ringGradient: 26 stops round the centre, each the 3-colour
// palette pulled toward the pass's tint and white), as a square picture of thin wedges: angle 0 at 3 o'clock, turning
// clockwise, the gradient starting `offset` degrees round. The layer turns it by the spin.
function conicPicture(size, cols, { tint = null, tintAmt = 0, white = 0 }, offset) {
  const N = 26;
  const paletteAt = (u) => {
    const v = u - Math.floor(u), f = v * 3, i = Math.floor(f) % 3;
    return mixRgb(cols[i], cols[(i + 1) % 3], f - Math.floor(f));
  };
  const stops = [];
  for (let i = 0; i <= N; i += 1) {
    let c = paletteAt(i / N);
    if (tint && tintAmt > 0.001) c = mixRgb(c, tint, clamp01(tintAmt));
    if (white > 0.001) c = mixRgb(c, [255, 255, 255], clamp01(white));
    stops.push(c.map((x) => Math.round(x)));
  }
  const colourAt = (u) => { const v = (u - Math.floor(u)) * N, i = Math.min(N - 1, Math.floor(v)); return mixRgb(stops[i], stops[i + 1], v - i); };
  const WEDGES = 180, c = size / 2, R = size * 0.75;
  let body = '';
  for (let j = 0; j < WEDGES; j += 1) {
    const a0 = (j / WEDGES) * 360, a1 = a0 + 360 / WEDGES + 0.6;    // a little overlap: no seams between wedges
    const col = colourAt(((a0 + 180 / WEDGES - offset) / 360));
    const p = (a) => `${r4(c + R * Math.cos((a * Math.PI) / 180))} ${r4(c + R * Math.sin((a * Math.PI) / 180))}`;
    body += `<path d="M${c} ${c}L${p(a0)}L${p(a1)}Z" fill="#${col.map(hex2).join('')}"/>`;
  }
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`);
}

// The outline as a closed path in the unit box of a w × h shape (fractions, +y down), its first point where MotionFast's
// path starts (the end of the top-left corner arc; an ellipse: its top), clockwise on screen
const KAPPA = 0.5522847498307936;
function outlinePoints(shape, w, h, r) {
  const P = (x, y, hi, ho) => ({ x: r6(x / w), y: r6(y / h), hIn: { x: r6(hi[0] / w), y: r6(hi[1] / h) }, hOut: { x: r6(ho[0] / w), y: r6(ho[1] / h) }, manual: true });
  if (shape === 'ellipse') {
    const a = w / 2, b = h / 2, ka = KAPPA * a, kb = KAPPA * b;
    return [P(0, -b, [-ka, 0], [ka, 0]), P(a, 0, [0, -kb], [0, kb]), P(0, b, [ka, 0], [-ka, 0]), P(-a, 0, [0, kb], [0, -kb])];
  }
  const k = KAPPA * r, L = -w / 2, R = w / 2, T = -h / 2, B = h / 2;
  return [
    P(L + r, T, [-k, 0], [0, 0]), P(R - r, T, [0, 0], [k, 0]),
    P(R, T + r, [0, -k], [0, 0]), P(R, B - r, [0, 0], [0, k]),
    P(R - r, B, [k, 0], [0, 0]), P(L + r, B, [0, 0], [-k, 0]),
    P(L, B - r, [0, k], [0, 0]), P(L, T + r, [0, 0], [0, -k]),
  ];
}

// The pointing hand (Prompt Card Click's line art, MotionFast getHand): a white silhouette with a soft shadow, the
// inside edges near-black. The picture's size in px, the fingertip (ox, oy) inside it.
const HAND_OUTER = 'M30.74 15.19a13.66 13.66 0 0 0-6.87-3.83 26 26 0 0 0-5.87-.78v-5.3A3.4 3.4 0 0 0 14.5 2 3.4 3.4 0 0 0 11 5.28v10L9.4 13.7a3.77 3.77 0 0 0-5.28 0A3.67 3.67 0 0 0 3 16.33a3.6 3.6 0 0 0 1 2.56l4.66 5.52a11.5 11.5 0 0 0 1.43 4 10.1 10.1 0 0 0 2 2.54v1.92a1.07 1.07 0 0 0 1 1.08H27a1.07 1.07 0 0 0 1-1.08v-2.7a12.8 12.8 0 0 0 3-8.36v-6a1 1 0 0 0-.26-.62Z';
const HAND_INNER = 'M29 21.86a10.72 10.72 0 0 1-2.6 7.26 1.1 1.1 0 0 0-.4.72V32H14.14v-1.48a1 1 0 0 0-.44-.83 7.3 7.3 0 0 1-1.82-2.23 9.1 9.1 0 0 1-1.2-3.52 1 1 0 0 0-.23-.59l-4.92-5.82a1.7 1.7 0 0 1 0-2.42 1.76 1.76 0 0 1 2.47 0l3 3v3.14l2-1V5.28A1.42 1.42 0 0 1 14.5 4 1.42 1.42 0 0 1 16 5.28v11.8l2 .43v-4.92a24 24 0 0 1 2.51.18V18l1.6.35V13c.41.08.83.17 1.26.28a15 15 0 0 1 1.53.49v5.15l1.6.35V14.5a11 11 0 0 1 2.5 1.73Z';
function handPicture(rawSize) {
  const size = Math.max(24, Math.round(rawSize));
  const k = size / 32, pad = Math.ceil(size * 0.18), side = Math.ceil(36 * k) + pad * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}">`
    + '<defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1.6" stdDeviation="1.6" flood-color="#000" flood-opacity="0.5"/></filter></defs>'
    + `<g filter="url(#s)"><g transform="translate(${pad} ${pad}) scale(${r6(k)})"><path d="${HAND_OUTER}" fill="#ffffff"/></g></g>`
    + `<g transform="translate(${pad} ${pad}) scale(${r6(k)})" stroke-linejoin="round" stroke-linecap="round"><path d="${HAND_OUTER}${HAND_INNER}" fill="#141414" fill-rule="evenodd"/></g></svg>`;
  return { src: svgUrl(svg), side, ox: pad + 14.5 * k, oy: pad + 2 * k };
}

export default {
  id: 'glow-edge-pill',
  name: 'Glow Edge Pill',
  category: 'UI Animation',
  v: 1,
  fields,
  // the label, to be measured by the host before build (metrics.label): at the size and tracking build lays it out at
  measure({ settings, frame }) {
    const p = { ...D0, ...settings };
    const text = String(p.text || '');
    if (!text) return [];
    const sc = frame.H / REF_H;
    return [{ key: 'label', text, font: String(p.fontFamily || D0.fontFamily), size: Math.max(4, num(p.fontSize, 120) * sc), weight: num(p.fontWeight, 500), letterSpacing: num(p.letterSpacing, 0) * sc }];
  },
  build({ settings, frame, metrics }) {
    const p = { ...D0, ...settings };
    const { W, H } = frame;
    const warnings = [];
    const sc = H / REF_H;

    // ── the timeline (MotionFast timings; design seconds ÷ speed) ──
    const speed = Math.max(0.1, num(p.speed, 1));
    const intro = p.intro === 'none' ? 0 : Math.max(0, num(p.introDur, 0));
    const hold = Math.max(0.1, num(p.hold, 0));
    const click = p.endClick ? CLICK_SETTLE : 0;
    const afterClick = p.endClick ? Math.max(0, num(p.clickHold, 0)) : 0;
    const outro = p.outro === 'none' ? 0 : Math.max(0, num(p.outroDur, 0));
    const D = Math.max(0.4, (intro + hold + click + afterClick + outro) / speed);
    const tI = intro / speed, tC = (intro + hold) / speed, tO = (intro + hold + click + afterClick) / speed;
    const tE = Math.min(D, tO + outro / speed);
    const tP = tC + CLICK_PRESS / speed, tB = tP + (BACK_Q0 * CLICK_RELEASE) / speed;

    // ── the shape (MotionFast shapeGeom): the label's width as the host measured it, else from the table ──
    const fs0 = Math.max(4, num(p.fontSize, 120) * sc);
    const lsRef = num(p.letterSpacing, 0);
    const text = String(p.text || '');
    const ml = metrics && metrics.label && Number.isFinite(metrics.label.width) ? metrics.label : null;
    let m;
    if (ml) {
      // the text layer's width spaces between letters; MotionFast's canvas spaces after the last one too
      m = { w: ml.width + lsRef * sc, unknown: 0 };
    } else {
      m = measureLabel(text, p.fontWeight, fs0, lsRef * sc);
      if (!isHelveticaNeue(p.fontFamily)) warnings.push('The pill is sized from Helvetica Neue\'s letter widths: with another font it can be a little wider or narrower than the label needs.');
      if (m.unknown) warnings.push(`${m.unknown} character(s) of the label are not in the width table: the pill takes them at an average width.`);
    }
    const textW0 = text ? m.w : 0;
    const w0 = Math.max(num(p.minWidth, 0) * sc, textW0 + 2 * num(p.padX, 0) * sc);
    const h0 = fs0 * 0.72 + 2 * num(p.padY, 0) * sc;
    const k = Math.min(1, (W * clamp01(num(p.fitWidth, 90) / 100)) / Math.max(1, w0), (H * clamp01(num(p.fitHeight, 90) / 100)) / Math.max(1, h0));
    const g = { w: w0 * k, h: h0 * k, fs: fs0 * k, s: sc * k };
    const panX = num(p.offsetX, 0), panY = num(p.offsetY, 0);
    const shape = ['pill', 'rounded', 'ellipse'].includes(p.shape) ? p.shape : 'pill';
    const rMax = Math.min(g.w, g.h) / 2;
    const radius = shape === 'rounded' ? Math.max(0, Math.min(rMax, num(p.cornerRadius, 0) * g.s)) : rMax;
    const perimeter = (() => {
      if (shape === 'ellipse') {
        const a = g.w / 2, b = g.h / 2, q = ((a - b) ** 2) / ((a + b || 1) ** 2);
        return Math.PI * (a + b) * (1 + (3 * q) / (10 + Math.sqrt(4 - 3 * q)));
      }
      return 2 * (g.w - 2 * radius) + 2 * (g.h - 2 * radius) + 2 * Math.PI * radius;
    })();
    const L = perimeter;
    // where the trace starts (MotionFast anchorDist), as a share of the outline
    const anchor = (() => {
      const where = p.traceFrom;
      if (shape === 'ellipse') return ({ top: 0, right: 0.25, bottom: 0.5, left: 0.75 }[where] || 0);
      const sw = Math.max(0, g.w - 2 * radius), sh = Math.max(0, g.h - 2 * radius), q = (Math.PI * radius) / 2;
      const d = where === 'right' ? sw + q + sh / 2 : where === 'bottom' ? sw + q + sh + q + sw / 2 : where === 'left' ? sw + q + sh + q + sw + q + sh / 2 : sw / 2;
      return d / L;
    })();

    // ── the looks of the light ──
    const cols = [hexRgb(p.colorA), hexRgb(p.colorB), hexRgb(p.colorC)];
    const soft = clamp01(num(p.glowSoftness, 0) / 100);
    const size0 = Math.max(2, num(p.glowSize, 0) * g.s);          // × glowScale(t)
    const ringW = Math.max(0.5, num(p.ringWidth, 0) * g.s);
    const coreW = Math.max(0, num(p.coreWidth, 0) * g.s);
    const spread = num(p.phaseSpread, 0);
    const cut = clamp01(num(p.innerCut, 0) / 100);
    const hot = { tint: cols[0], tintAmt: num(p.coreTint, 0) / 100 };
    const cool = { tint: cols[1], tintAmt: num(p.haloTint, 0) / 100 };
    const iPct = Number(p.intensity);
    const I0 = Number.isFinite(iPct) ? Math.max(0, iPct / 100) : 1;
    const boost = num(p.headBoost, 0) / 100;
    const pa = num(p.pulse, 0) / 100, pw = 2 * Math.PI * num(p.pulseRate, 0) * speed;     // the pulse, per real second
    const clickBoost = Math.max(0, num(p.clickBoost, 0)) / 100;
    const trace = p.intro === 'trace' && tI > 0;
    // a pass: its stroke width and blur (each × glowScale when `grows`), palette, phase offset, level, inner cut
    const passes = [
      { id: 'halo', name: 'Halo', q: 0.28, width: size0, blur: size0 * soft, grows: true, pal: cool, offset: spread, level: num(p.glowLevel, 0) / 100, cut, inset: 0 },
      { id: 'mid', name: 'Mid bloom', q: 0.4, width: size0 * 0.42, blur: size0 * 0.42 * soft, grows: true, pal: { tint: cool.tint, tintAmt: cool.tintAmt * 0.5 }, offset: spread * 0.55, level: num(p.midLevel, 0) / 100, cut, inset: 0 },
      { id: 'inner', name: 'Inner bloom', q: 0.7, width: ringW, blur: ringW * 0.75, grows: false, pal: hot, offset: 0, level: num(p.innerLevel, 0) / 100, cut: cut * 0.55, inset: ringW * 0.5 },
    ];
    if (coreW > 0.05 && num(p.coreLevel, 0) > 0.5) {
      passes.push({ id: 'core', name: 'Core line', q: 1, width: coreW, blur: Math.max(0.8, coreW * 0.3), grows: false, pal: { ...hot, white: num(p.coreWhite, 0) / 100 }, offset: 0, level: num(p.coreLevel, 0) / 100, cut: 0, inset: 0 });
    }
    // the bright heads that lead the trace: a short stretch at each end of the traced arc
    const headLen = Math.max(ringW * 2, L * 0.035);
    const heads = trace && boost > 0.01 ? (p.traceMode === 'split' ? [-1, 1] : [1]) : [];
    for (const hd of heads) {
      const tag = heads.length > 1 ? (hd < 0 ? ' (back)' : ' (front)') : '';
      passes.push({ id: `headCore${heads.length > 1 ? (hd < 0 ? 'B' : 'F') : ''}`, name: `Head${tag}`, q: 0.7, head: hd, width: ringW * 1.3, blur: Math.max(2, ringW), grows: false, pal: { ...hot, white: 0.7 }, offset: 0, level: boost, cut: cut * 0.5, inset: ringW * 0.5 });
      passes.push({ id: `headGlow${heads.length > 1 ? (hd < 0 ? 'B' : 'F') : ''}`, name: `Head glow${tag}`, q: 0.4, head: hd, width: size0 * 0.55, blur: size0 * 0.5 * soft, grows: true, pal: cool, offset: spread * 0.5, level: boost * 0.75, cut, inset: 0 });
    }

    // ── the driver every pill layer reads: the intro's progress e (0 → 1 on the intro's easing), then 1 + the click's
    // dip (AE In to 2 over the press, back to 1 on a back-out spring), then the outro's alpha (1 → 0 on AE In) ──
    const introKey = EASE_KEY[p.introEase] || EASE_KEY.aeSmooth;
    const driver = (span) => {
      const e = [];
      if (tI > 0) e.push([0, 0, introKey], [tI, 1]);
      else e.push([0, 1]);
      if (p.endClick) e.push([tC, 1, EASE_KEY.aeIn], [tP, 2, { easing: 'Custom', bezier: BACK_CUT }], [tB, 1]);
      if (outro > 0) e.push([tO, 1, EASE_KEY.aeIn], [tE, 0]);
      return track(span, e.filter(([t]) => t <= span + 1e-9));
    };
    // pieces of ƒx over that driver (value = the driver, time = the layer's seconds)
    const E = tI > 0 ? `(time<${n(tI)}?value:1)` : '1';
    const DIP = p.endClick ? `((time>=${n(tC)}&&time<${n(tO + 1e-6)})?value-1:0)` : '0';
    const ALPHA = outro > 0 ? `(time>=${n(tO)}?value:1)` : '1';
    const PULSE = (amt) => (pa > 0 && pw > 0 ? `(1+${n(amt * pa)}*sin(${n(pw)}*time))` : '1');
    const introLevel = p.intro === 'trace' && tI > 0 ? `(0.55+0.45*clamp(time*${n(1.6 / tI)},0,1))`
      : p.intro === 'ignite' && tI > 0 ? E
        : p.intro === 'grow' && tI > 0 ? `clamp(time*${n(2 / tI)},0,1)` : '1';
    const LEVEL = `${introLevel}*${PULSE(0.4)}${p.endClick ? `*(1+${n(clickBoost)}*${DIP})` : ''}`;
    const GLOW_SCALE = `${p.intro === 'ignite' && tI > 0 ? `(0.45+0.55*${E})*` : ''}${PULSE(0.6)}${p.endClick ? `*(1+${n(0.35 * clickBoost)}*${DIP})` : ''}`;
    const sceneMoves = (p.intro === 'grow' && tI > 0) || p.endClick;
    const SCENE = `${p.intro === 'grow' && tI > 0 ? `(0.82+0.18*${E})*` : ''}${p.endClick ? `(1-0.08*${DIP})` : '1'}`;
    // the same pieces with the driver held + 1 (a scale track keeps its keys ≥ 0.1)
    const lift = (code) => code.replace(/value/g, '(value-1)');
    const driverPlus = (span) => driver(span).map((key) => ({ ...key, value: n(Number(key.value) + 1) }));
    // Fast Blur's Blurriness (px at 1080) for a Gaussian of σ screen px: three boxes of 2r + 1 → σ² = r² + r
    const blurCode = (sigma) => `(${sigma}>0.4?(sqrt(1+4*pow(${sigma},2))-1)/2*${n(REF_H / H)}:0)`;
    const blurOf = (sigma) => (sigma > 0.4 ? ((Math.sqrt(1 + 4 * sigma * sigma) - 1) / 2) * (REF_H / H) : 0);

    // ── the spin: the palette turns at Spin °/s from Palette Angle (a picture's turn of 360° looks the same, so the
    // keys wrap there: no key passes the editor's ±1000°) ──
    const spinRate = num(p.spin, 0) * speed;
    const rot0 = num(p.phase, 0);
    const spinEntries = (span) => {
      const out = [[0, rot0]];
      if (Math.abs(spinRate) < 1e-9) return out;
      let t = 0, v = rot0;
      for (let guard = 0; guard < 500; guard += 1) {
        const lim = spinRate > 0 ? 360 : -360;
        const tw = t + (lim - v) / spinRate;
        if (tw >= span - 1e-6) { out.push([span, v + spinRate * (span - t)]); break; }
        out.push([tw - 0.001, lim - spinRate * 0.001, { easing: 'Hold' }], [tw, 0]);
        t = tw; v = 0;
      }
      return out;
    };
    const spinKeys = (span) => track(span, spinEntries(span));

    const layers = [];
    const BOX = Math.round(Math.min(1000, W, H));                 // the palette picture's own px (kept inside the frame)
    const reachOf = (ps) => {
      const gmax = ps.grows ? (1 + 0.6 * pa) * (1 + 0.35 * clickBoost) : 1;
      return Math.hypot(g.w / 2, g.h / 2) + (ps.width * gmax) / 2 + 3 * ps.blur * gmax + 8;
    };
    for (const ps of passes) {
      if (!(ps.level > 0)) continue;
      const span = ps.head ? Math.min(D, tI) : D;
      if (span < 0.1 - 1e-9) continue;
      const src = `${ps.id}.src`;
      // MotionFast paints a pass on a scratch canvas at q of the frame's resolution, sized to its box and rounded up to
      // whole px: drawn back onto the box, the pass is shrunk by q·box / ceil(q·box) toward the box's corner (up to
      // ~2 px at the far edge), and its edges are softened by the scaling (σ ≈ 0.5 / q px). Kept: the pass is placed,
      // sized and softened as MotionFast draws it.
      const cxF = W / 2 + (W * panX) / 100, cyF = H / 2 + (H * panY) / 100;
      const pad = Math.ceil(ps.width / 2 + ps.blur * 2.4 + 2);
      const bx = Math.floor(cxF - g.w / 2 - pad), bw = Math.ceil(cxF + g.w / 2 + pad) - bx;
      const by = Math.floor(cyF - g.h / 2 - pad), bh = Math.ceil(cyF + g.h / 2 + pad) - by;
      const qx = ps.q < 1 ? (bw * ps.q) / Math.ceil(bw * ps.q) : 1, qy = ps.q < 1 ? (bh * ps.q) / Math.ceil(bh * ps.q) : 1;
      const sk = (qx + qy) / 2;
      const ppX = r6(((bx + (cxF - bx) * qx - W / 2) / W) * 100), ppY = r6(((by + (cyF - by) * qy - H / 2) / H) * 100);
      const pw = g.w * qx, ph = g.h * qy, pr = radius * sk;
      const softQ = ps.q < 1 ? 0.5 / ps.q : 0;
      const eid = `${ps.id}-blur`;
      // the stroke and its blur, × glowScale(t) and the scene's scale (blur in screen px: the layer's scale does not
      // reach it)
      const wCode = ps.grows ? `${n(Math.max(0.6, ps.width) * sk)}*${GLOW_SCALE}` : null;
      const sigmaCode = `sqrt(pow(${n(ps.blur * sk)}*${ps.grows ? GLOW_SCALE : '1'}*${sceneMoves ? SCENE : '1'},2)+${n(softQ * softQ)})`;
      const srcKeys = {}, srcFx = {};
      if (ps.grows || sceneMoves) {
        srcKeys[`fx:${eid}:blurriness`] = driver(span);
        srcFx[`fx:${eid}:blurriness`] = fx(blurCode(sigmaCode));
      }
      if (wCode) { srcKeys.lineWidth = driver(span); srcFx.lineWidth = fx(wCode); }
      if (sceneMoves) { srcKeys.scale = driverPlus(span); srcFx.scale = fx(lift(SCENE)); }
      // the trace: Trim keyed on the intro's easing (MotionFast's dash from the anchor, both ways or one way)
      let trim = { lineTrimStart: 0, lineTrimEnd: 100, lineTrimOffset: 0 };
      const a100 = anchor * 100;
      const wrapOff = (v) => { let o = v; while (o >= 100) o -= 100; while (o < -100) o += 100; return r6(o); };
      if (ps.head) {
        // a head: a fixed span round 50 %, the offset carries it with the traced end (anchor ± half (split) or all
        // (sweep) of the outline)
        const hl = (headLen / L) * 100, reach = p.traceMode === 'split' ? 50 * ps.head : 100;
        let o0 = a100 - 50, o1 = a100 - 50 + reach;
        if (Math.max(o0, o1) > 100) { o0 -= 100; o1 -= 100; }
        if (Math.min(o0, o1) < -100) { o0 += 100; o1 += 100; }
        trim = { lineTrimStart: r6(50 - hl / 2), lineTrimEnd: r6(50 + hl / 2), lineTrimOffset: r6(o0) };
        srcKeys.lineTrimOffset = track(span, [[0, o0, introKey], [tI, o1]]);
      } else if (trace) {
        if (p.traceMode === 'split') {
          trim = { lineTrimStart: 50, lineTrimEnd: 50, lineTrimOffset: wrapOff(a100 - 50) };
          srcKeys.lineTrimStart = track(span, [[0, 50, introKey], [tI, 0]]);
          srcKeys.lineTrimEnd = track(span, [[0, 50, introKey], [tI, 100]]);
        } else {
          trim = { lineTrimStart: 0, lineTrimEnd: 0, lineTrimOffset: wrapOff(a100) };
          srcKeys.lineTrimEnd = track(span, [[0, 0, introKey], [tI, 100]]);
        }
      }
      layers.push({
        key: src, type: 'shape', name: `${ps.name} (light)`, trimEnd: r6(span), panX: ppX, panY: ppY,
        shapeType: 'path', shapePathRenderMode: 'stroke', shapePath: { points: outlinePoints(shape, pw, ph, pr), closed: true },
        shapeSizeUnit: 'px', shapeWidthPx: r4(pw), shapeHeightPx: r4(ph), shapeFillColor: '#ffffff',
        lineWidth: r4(Math.max(0.6, ps.width) * sk), lineCap: 'round', lineJoin: 'round', ...trim,
        effects: [{ id: 'fastBlur', eid, enabled: true, mix: 100, params: { blurriness: r6(blurOf(Math.hypot(ps.blur * sk, softQ))), iterations: 3, dimensions: 0, repeatEdges: 0 } }],
        ...(Object.keys(srcKeys).length ? { propertyKeyframes: srcKeys } : {}),
        ...(Object.keys(srcFx).length ? { propertyKeyframeFx: srcFx } : {}),
      });
      // the light: the palette picture, turned by the spin, added through the stroke at the pass's level
      const Sd = 2 * reachOf(ps);
      const glowKeys = { rotate: spinKeys(span), opacity: driver(span) };
      const glowFx = { opacity: fx(`clamp(${ALPHA}*${LEVEL}*${n(I0 * ps.level)},0,1)`) };
      if (sceneMoves) { glowKeys.scale = driverPlus(span); glowFx.scale = fx(lift(SCENE)); }
      const layer = {
        key: `${ps.id}.glow`, type: 'image', name: ps.name, src: conicPicture(BOX, cols, ps.pal, ps.offset),
        trimEnd: r6(span), panX: ppX, panY: ppY, zoom: r6(Sd / BOX), blendMode: 'add', trackMatte: { sourceId: src, mode: 'alpha' },
        propertyKeyframes: glowKeys, propertyKeyframeFx: glowFx,
      };
      // MotionFast erases the glow inside the (inset) outline at Inner Cut: a Subtract mask at that opacity, turned back
      // against the picture's spin so it stays on the outline
      const cutMask = (rot) => {
        const iw = Math.max(2, pw - 2 * ps.inset * sk), ih = Math.max(2, ph - 2 * ps.inset * sk);
        const ir = shape === 'ellipse' ? 0 : Math.max(0, Math.min(Math.min(iw, ih) / 2, pr - ps.inset * sk));
        return [{ id: 'layerMask', eid: 'cut', enabled: true, params: { mskAmount: 100, mskQuality: 0 },
          masks: [{ mid: 'm1', name: 'Inner cut', mode: 'subtract', enabled: true, inverted: false,
            path: { points: outlinePoints(shape, iw, ih, ir), closed: true },
            x: 0, y: 0, w: r6((iw / Sd) * 100), h: r6((ih / Sd) * 100), rot: r6(rot), feather: softQ > 0.25 ? r4(softQ) : 0, expand: 0, opacity: r6(ps.cut * 100), grow: 0 }] }];
      };
      if (ps.cut > 0.01) {
        layer.layerEffects = cutMask(-rot0);
        glowKeys['msk:m1:rot'] = glowKeys.rotate.map((key) => ({ ...key, value: n(-Number(key.value)) }));
      }
      // MotionFast adds its passes on a canvas of their own, so their coverage adds up as their light does; the editor's
      // Add sums the light but lays coverage "over", and a layer's light is kept within its coverage: where the narrow
      // passes overlap the halo the sum ran short (bluish edges came out up to 45 levels dim). A black copy of each
      // narrow pass (same light shape, same level) adds the coverage that was missing and no light. The halo keeps none,
      // so where it is alone (the far glow) the background shows through it exactly as in MotionFast.
      if (ps.id !== 'halo' && !/^headGlow/.test(ps.id)) {
        const B0 = 200;
        layers.push({
          key: `${ps.id}.cover`, type: 'image', name: `${ps.name} (coverage)`,
          src: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${B0}" height="${B0}"><rect width="${B0}" height="${B0}" fill="#000000"/></svg>`),
          trimEnd: r6(span), panX: ppX, panY: ppY, zoom: r6(Sd / B0), blendMode: 'add', trackMatte: { sourceId: src, mode: 'alpha' },
          ...(ps.cut > 0.01 ? { layerEffects: cutMask(0) } : {}),
          propertyKeyframes: { opacity: glowKeys.opacity, ...(glowKeys.scale ? { scale: glowKeys.scale } : {}) },
          propertyKeyframeFx: { opacity: glowFx.opacity, ...(glowFx.scale ? { scale: glowFx.scale } : {}) },
        });
      }
      layers.push(layer);
    }

    // ── the label ──
    if (text) {
      // canvas 'middle' vs the text layer's font-box centre: from the font box the host measured ((ascent − descent) / 2
      // above the baseline, less the 'middle' line's height), else the table's
      const measuredMid = ml && Number.isFinite(ml.ascent) && Number.isFinite(ml.descent) && Number.isFinite(ml.middle);
      const shift = measuredMid ? ((ml.ascent - ml.descent) / 2 - ml.middle) * (g.fs / fs0) : (tableOf(p.fontWeight).mid / 1000) * g.fs;
      const textStart = (intro * clamp01(num(p.textDelay, 0) / 100)) / speed;
      const textEnd = textStart + Math.max(0.05, num(p.textDur, 0.5)) / speed;
      const anim = ['blurUp', 'fade', 'scale', 'none'].includes(p.textAnim) ? p.textAnim : 'blurUp';
      const softPx = num(p.textSoftness, 0) * g.s;
      const ls = lsRef * g.s;
      const grow = p.intro === 'grow' && tI > 0;
      // MotionFast draws the label's middle line at the pill's centre + its rise, both × the scene's scale S and the
      // label's own ts about the pill's centre; the text layer scales about its font box's centre, `shift` above that
      // line: translateY = S·ts·(rise − shift), its blur σ·S·ts. Each track rides one driver: the label's progress textP
      // (AE Smooth), or the intro's (Grow In), then the click's dip and the outro's alpha. Where a track needs two
      // moving drivers at once (the label still coming in at the click or the outro; rising or scaling while the pill
      // grows in) it is sampled, 60 a second, straight between.
      const blocked = anim !== 'none' && textEnd > Math.min(p.endClick ? tC : Infinity, outro > 0 ? tO : Infinity) - 1e-9;
      const tail = () => {
        const e = [];
        if (p.endClick) e.push([tC, 1, EASE_KEY.aeIn], [tP, 2, { easing: 'Custom', bezier: BACK_CUT }], [tB, 1]);
        if (outro > 0 && tO < D) e.push([tO, 1, EASE_KEY.aeIn], [tE, 0]);
        return e;
      };
      const tDriver = () => track(D, [...(anim !== 'none' ? [[textStart, 0, EASE_KEY.aeSmooth], [textEnd, 1]] : [[0, 1]]), ...tail()]);
      const iDriver = () => track(D, [[0, 0, introKey], [tI, 1], ...tail()]);
      const plus1 = (keys) => keys.map((key) => ({ ...key, value: n(Number(key.value) + 1) }));
      const TP = anim === 'none' ? '1' : `(time<${n(Math.max(textEnd, 1e-6))}?value:1)`;
      const EI = `(time<${n(tI)}?value:1)`;
      const TDIP = p.endClick ? `((time>=${n(tC)}&&time<${n(tO + 1e-6)})?value-1:0)` : '0';
      const TALPHA = outro > 0 ? `(time>=${n(tO)}?value:1)` : '1';
      const TSCENE = p.endClick ? `(1-0.08*${TDIP})` : '1';
      const TS = anim === 'scale' ? `(0.86+0.14*${TP})` : '1';
      const GROW = `(0.82+0.18*${EI})`;
      const easeAt = (b, x) => {
        // a CSS cubic-bezier's value at time share x (for the sampled tracks)
        if (x <= 0) return 0; if (x >= 1) return 1;
        const bx = (u) => 3 * b[0] * u * (1 - u) * (1 - u) + 3 * b[2] * u * u * (1 - u) + u * u * u;
        const by = (u) => 3 * b[1] * u * (1 - u) * (1 - u) + 3 * b[3] * u * u * (1 - u) + u * u * u;
        let lo = 0, hi = 1, u = x;
        for (let i = 0; i < 40; i += 1) { const c = bx(u); if (Math.abs(c - x) < 1e-7) break; if (c < x) lo = u; else hi = u; u = (lo + hi) / 2; }
        return by(u);
      };
      const AE_SMOOTH = [0.882083327, 0, 0.2445833683, 1], AE_IN = [0.3141666673, 0, 0.0875000209, 1];
      const INTRO_B = { aeSmooth: AE_SMOOTH, aeIn: AE_IN, aeOut: [0.8699999754, 0, 0.6433336333, 1], smooth: [0.5, 0, 0, 1], linear: [1 / 3, 1 / 3, 2 / 3, 2 / 3] }[p.introEase] || AE_SMOOTH;
      // MotionFast's label state at time t (stateAt): alpha, rise, scale S·ts, blur
      const labelAt = (t) => {
        const tt = t * speed;
        const textP = easeAt(AE_SMOOTH, clamp01((tt - textStart * speed) / Math.max(0.05, num(p.textDur, 0.5))));
        let alpha = 1, sceneScale = 1;
        if (grow) sceneScale = lerp(0.82, 1, easeAt(INTRO_B, clamp01(tt / intro)));
        if (p.endClick) {
          const pressT = tt - (intro + hold);
          let dip = 0;
          if (pressT >= 0) dip = pressT < CLICK_PRESS ? easeAt(AE_IN, clamp01(pressT / CLICK_PRESS)) : 1 - clamp01(easeAt(BACK_OUT, clamp01((pressT - CLICK_PRESS) / CLICK_RELEASE)));
          sceneScale *= 1 - dip * 0.08;
        }
        const outStart = intro + hold + click + afterClick;
        if (outro > 0 && tt > outStart) alpha *= 1 - easeAt(AE_IN, clamp01((tt - outStart) / outro));
        let a = textP, dy = 0, ts = 1, blur = softPx;
        if (anim === 'blurUp') { dy = (1 - textP) * g.fs * 0.3; blur += (1 - textP) * g.fs * 0.14; } else if (anim === 'scale') ts = lerp(0.86, 1, textP); else if (anim === 'none') a = 1;
        return { alpha: clamp01(a) * alpha, dy, scale: sceneScale * ts, blur: blur * sceneScale * ts };
      };
      const sample = (f) => {
        const steps = Math.max(2, Math.ceil(D * 60));
        return track(D, Array.from({ length: steps + 1 }, (_, j) => { const t = (D * j) / steps; return [t, f(labelAt(t))]; }));
      };
      const keysT = {}, fxT = {};
      const needBlur = anim === 'blurUp' || softPx > 0;
      const eidT = 'label-blur';
      const riseMoves = anim === 'blurUp' || anim === 'scale';
      // opacity
      if (blocked) keysT.opacity = sample((st) => st.alpha);
      else { keysT.opacity = tDriver(); fxT.opacity = fx(`clamp(${TP}*${TALPHA},0,1)`); }
      // scale
      if (blocked || (grow && anim === 'scale')) keysT.scale = sample((st) => Math.max(0.1, st.scale));
      else if (grow) { keysT.scale = plus1(iDriver()); fxT.scale = fx(lift(`${GROW}*${TSCENE}`)); }
      else if (anim === 'scale' || p.endClick) { keysT.scale = plus1(tDriver()); fxT.scale = fx(lift(`${TS}*${TSCENE}`)); }
      // the rise (and the shift that keeps the middle line on its place under the scale)
      if (blocked || (grow && riseMoves)) keysT.translateY = sample((st) => st.scale * (st.dy - shift));
      else if (grow) { keysT.translateY = iDriver(); fxT.translateY = fx(`${GROW}*${TSCENE}*${n(-shift)}`); }
      else { keysT.translateY = tDriver(); fxT.translateY = fx(`(${anim === 'blurUp' ? `(1-${TP})*${n(g.fs * 0.3)}` : '0'}-${n(shift)})*${TS}*${TSCENE}`); }
      // the blur
      if (needBlur) {
        if (blocked || (grow && riseMoves)) keysT[`fx:${eidT}:blurriness`] = sample((st) => blurOf(st.blur));
        else if (grow) { keysT[`fx:${eidT}:blurriness`] = iDriver(); fxT[`fx:${eidT}:blurriness`] = fx(blurCode(`${n(softPx)}*${GROW}*${TSCENE}`)); }
        else { keysT[`fx:${eidT}:blurriness`] = tDriver(); fxT[`fx:${eidT}:blurriness`] = fx(blurCode(`(${n(softPx)}${anim === 'blurUp' ? `+(1-${TP})*${n(g.fs * 0.14)}` : ''})*${TS}*${TSCENE}`)); }
      }
      const label = {
        type: 'text', textContent: text, textColor: p.textColor, textFontFamily: p.fontFamily, textFontWeight: num(p.fontWeight, 500),
        textFontSizeUnit: 'px', textFontSize: r4(g.fs), textAlign: 'center', textNoWrap: true, textLineHeight: 1,
        ...(ls ? { textLetterSpacing: r4(ls) } : {}),
        // Chromium's canvas spaces after the last letter too, and centres that: the ink sits ls/2 left of the centre
        panX: r6(panX - ((ls / 2) / W) * 100), panY,
      };
      const glowAmt = num(p.textGlow, 0) / 100, glowR = Math.max(0, num(p.textGlowRadius, 0) * g.s);
      if (glowAmt > 0.01 && glowR > 0.5) {
        // the bloom: the label (risen, unblurred) blurred by Bloom Radius, added under it at Text Bloom × its alpha
        const bk = { ...keysT }, bfx = { ...fxT };
        delete bk[`fx:${eidT}:blurriness`]; delete bfx[`fx:${eidT}:blurriness`];
        if (bfx.opacity) bfx.opacity = fx(`clamp(${TP}*${TALPHA}*${n(glowAmt)},0,1)`);
        else bk.opacity = bk.opacity.map((key) => ({ ...key, value: n(Math.min(1, Number(key.value) * glowAmt)) }));
        layers.push({ ...label, key: 'label.bloom', name: 'Label bloom', blendMode: 'add',
          effects: [{ id: 'fastBlur', eid: 'bloom-blur', enabled: true, mix: 100, params: { blurriness: r6(blurOf(glowR)), iterations: 3, dimensions: 0, repeatEdges: 0 } }],
          propertyKeyframes: bk, propertyKeyframeFx: bfx });
      }
      layers.push({ ...label, key: 'label', name: 'Label',
        ...(needBlur ? { effects: [{ id: 'fastBlur', eid: eidT, enabled: true, mix: 100, params: { blurriness: r6(blurOf(softPx)), iterations: 3, dimensions: 0, repeatEdges: 0 } }] } : {}),
        propertyKeyframes: keysT, ...(Object.keys(fxT).length ? { propertyKeyframeFx: fxT } : {}) });
    }

    // ── the grain: MotionFast lays a fixed noise tile (mid-grey ± 95 levels) source-atop over what it painted, Grain ×
    // 0.42 strong: on average every painted colour, clipped, is pulled that far toward mid-grey, and speckled. Here the
    // Film Grain adjustment speckles (and clips) the template's own plate, and a second adjustment pulls it toward
    // mid-grey: Contrast (1 − Grain × 0.42) about 0.5 is exactly that pull. The cursor stays above both, as in MotionFast.
    const grainMix = clamp01(num(p.grain, 0) / 100) * 0.42;
    if (grainMix > 0.002) {
      layers.push({ key: 'grain', type: 'adjustment', name: 'Grain',
        effects: [{ id: 'grain', eid: 'grain', enabled: true, mix: 100, params: { amount: r4(clamp01((grainMix / 0.42) * 0.5)), size: 1, animate: 0, color: 0 } }] });
      layers.push({ key: 'grain.tone', type: 'adjustment', name: 'Grain tone', filterContrast: r4((1 - grainMix) * 100) });
    }

    // ── the cursor: it slides in over the end of the hold, presses at the click and springs back ──
    if (p.endClick) {
      const hand = handPicture(num(p.cursorSize, 158) * g.s);
      const tipX = 6 * g.s, tipY = 8 * g.s;                       // from the pill's centre
      const from = String(p.clickFrom || 'br');
      const offs = from === 'bl' ? [-1, 1] : from === 'tr' ? [1, -1.15] : from === 'tl' ? [-1, -1.15] : [1, 1];
      const t0 = tC - CLICK_TRAVEL / speed;
      const cxOff = hand.side / 2 - hand.ox, cyOff = hand.side / 2 - hand.oy;   // the picture's centre from the tip
      const x0 = tipX + offs[0] * (g.w / 2 + 380 * g.s), y0 = tipY + offs[1] * (g.h / 2 + 320 * g.s);
      const start = Math.max(0, t0);
      const spanC = D - start;
      const xp = (x) => ((x / W) * 100), yp = (y) => ((y / H) * 100);
      const baseX = (panX / 100) * W, baseY = (panY / 100) * H;
      const travelAt = (t) => {
        const q = clamp01((t - t0) / (CLICK_TRAVEL / speed));
        const b = [0.3141666673, 0, 0.0875000209, 1];
        const bx = (u) => 3 * b[0] * u * (1 - u) * (1 - u) + 3 * b[2] * u * u * (1 - u) + u * u * u;
        const by = (u) => 3 * b[1] * u * (1 - u) * (1 - u) + 3 * b[3] * u * u * (1 - u) + u * u * u;
        let lo = 0, hi = 1, u = q;
        for (let i = 0; i < 40; i += 1) { const c = bx(u); if (Math.abs(c - q) < 1e-7) break; if (c < q) lo = u; else hi = u; u = (lo + hi) / 2; }
        return q <= 0 ? 0 : q >= 1 ? 1 : by(u);
      };
      const pos = (x, y, dip) => [baseX + x + dip * 9 * g.s + (1 - 0.07 * dip) * cxOff, baseY + y + dip * 9 * g.s + (1 - 0.07 * dip) * cyOff];
      const atX = (t) => lerp(x0, tipX, travelAt(t)), atY = (t) => lerp(y0, tipY, travelAt(t));
      const entries = (f) => {
        const e = [];
        if (t0 >= 0) e.push([0, f(x0, y0, 0), EASE_KEY.aeIn]);
        else {
          // the slide began before the clip: the rest of it sampled to the press
          for (let t = 0; t < tC - 1e-9; t += 1 / 30) e.push([t, f(atX(t), atY(t), 0)]);
        }
        e.push([tC - start, f(tipX, tipY, 0), EASE_KEY.aeIn], [tP - start, f(tipX, tipY, 1), { easing: 'Custom', bezier: BACK_CUT }], [tB - start, f(tipX, tipY, 0)]);
        return track(spanC, e);
      };
      // its visibility: the slide's progress (the ƒx takes min(1, 2.4 ×) of it), then 1 → 2 for the outro (2 − value)
      const vis = t0 >= 0 ? [[0, 0, EASE_KEY.aeIn]] : Array.from({ length: Math.ceil(tC * 30) }, (_, j) => [j / 30, travelAt(j / 30)]);
      vis.push([tC - start, 1]);
      if (outro > 0) vis.push([tO - start, 1, EASE_KEY.aeIn], [tE - start, 2]);
      layers.push({
        key: 'cursor', type: 'image', name: 'Cursor', src: hand.src, freeStart: r4(Math.floor(start * 1e4) / 1e4), trimEnd: r6(spanC),
        propertyKeyframes: {
          xPercent: entries((x, y, dp) => xp(pos(x, y, dp)[0])),
          yPercent: entries((x, y, dp) => yp(pos(x, y, dp)[1])),
          scale: track(spanC, [[tC - start, 1, EASE_KEY.aeIn], [tP - start, 0.93, { easing: 'Custom', bezier: BACK_CUT }], [tB - start, 1]]),
          opacity: track(spanC, vis),
        },
        propertyKeyframeFx: { opacity: fx('(value<=1?min(1,2.4*value):2-value)') },
      });
    }
    return { duration: D, layers, warnings };
  },
};
