// Cascading Ticker (MotionFast `cascading-ticker`): four full-width marquee rows of repeated "item >" blocks. Every row
// slides right by one block over the clip on its own warped profile (pow(t, warp) fed into a quintic in-out), so the
// rows race ahead and settle at different moments.
//
// Built from ordinary layers: per row a Row null whose X is the row's slide (one key pair holding the clip's progress
// 0 → 1, and a ƒx that is MotionFast's warpEase of it, exactly), and under it one text layer per word and one per
// separator, each at its fixed place along the row. The separators are their own text layers (accent colour, 1.18×
// the size): a text layer could style them only as contiguous ranges, at most 8 a layer. Only the words and separators
// that come into the frame at some moment of the clip are made, and each lives only while it is in the frame (its
// layer starts and ends there: off the frame it costs nothing).
//
// Text widths: the row is laid out from its words' widths, so the script asks the host to measure them (measure():
// every distinct word at the row's size and tracking, the separator at 1× (MotionFast measures it there for the slide)
// and at 1.18× (where it is drawn)) and build() reads `metrics`. The text layers centre their font box; MotionFast draws
// with the canvas 'middle' baseline, so each layer sits (ascent − descent) / 2 − middle above the row's centre line.
// Without metrics (node tools) an estimate of 0.55 em a letter is used, with a warning.
//
// A text layer holds letter spacing within −20…80 px: a word whose tracking is past it is drawn at a smaller size with
// the tracking scaled alike and the layer zoomed back (the same glyphs in the same places).
//
// MotionFast's quirks are kept: the separator measured at 1× but drawn at 1.18×, the slide's block width counting the
// tracking between letters while the row advances by the tracking after every letter, an Offset of 0 taken as 150,
// font size scaled by min(W / 1920, H / 1080) while Row Gap and the offsets stay frame px, and warpEase's step at 0.49.
//
// A built-in script (PLANS/ESSENTIAL_TEMPLATES.md §14): it imports nothing, so this same text also runs as a
// `kind: "script"` source. Numbers and timing are MotionFast's (motionTemplates/cascadingTicker.js).
const ROW_DEFAULTS = [
  'Kobenhavn|Warszawa|Berlin|Stockholm',
  'Zaragoza|Madrid|Barcelona|Valencia',
  'Geneve|Milano|Florence|Roma',
  'Wien|Praha|Munchen|Budapest',
];
const D0 = {
  row1: ROW_DEFAULTS[0], row2: ROW_DEFAULTS[1], row3: ROW_DEFAULTS[2], row4: ROW_DEFAULTS[3], arrow: '>',
  speed: 1, rowGap: 40, offset1: 150, offset2: 150, offset3: 150, offset4: 150,
  warp1: 0.6, warp2: 0.63, warp3: 0.68, warp4: 0.77,
  fontFamily: 'Inter', fontWeight: 900, fontSize: 164, letterSpacing: -0.05, textColor: '#ffffff', accentColor: '#f9492d',
};
const range = (key, label, min, max, step, extra = {}) => ({ key, type: 'range', label, default: D0[key], min, max, step, ...extra });
const fields = [
  { type: 'group', key: 'gRows', label: 'Rows' },
  { key: 'row1', type: 'textarea', label: 'Row 1', default: D0.row1, rows: 2, placeholder: 'Item 1|Item 2|Item 3' },
  { key: 'row2', type: 'textarea', label: 'Row 2', default: D0.row2, rows: 2, placeholder: 'Item 1|Item 2|Item 3' },
  { key: 'row3', type: 'textarea', label: 'Row 3', default: D0.row3, rows: 2, placeholder: 'Item 1|Item 2|Item 3' },
  { key: 'row4', type: 'textarea', label: 'Row 4', default: D0.row4, rows: 2, placeholder: 'Item 1|Item 2|Item 3' },
  { key: 'arrow', type: 'text', label: 'Separator', default: D0.arrow, placeholder: '>' },
  { type: 'group', key: 'gType', label: 'Typeface' },
  { key: 'fontFamily', type: 'font', label: 'Font', default: D0.fontFamily },
  { key: 'fontWeight', type: 'select', label: 'Font Weight', default: 900, options: [
    { value: 400, label: 'Regular' }, { value: 600, label: 'Semibold' }, { value: 700, label: 'Bold' }, { value: 800, label: 'Extra Bold' }, { value: 900, label: 'Black' },
  ] },
  range('fontSize', 'Font Size', 72, 280, 4, { suffix: 'px' }),
  range('letterSpacing', 'Letter Spacing', -0.15, 0.1, 0.01),
  { type: 'group', key: 'gColor', label: 'Colours' },
  { key: 'textColor', type: 'color', label: 'Text', default: D0.textColor },
  { key: 'accentColor', type: 'color', label: 'Separator', default: D0.accentColor },
  { type: 'group', key: 'gLayout', label: 'Row Layout' },
  range('rowGap', 'Row Gap', 10, 200, 2),
  range('offset1', 'Row 1 Offset', -400, 400, 5),
  range('offset2', 'Row 2 Offset', -400, 400, 5),
  range('offset3', 'Row 3 Offset', -400, 400, 5),
  range('offset4', 'Row 4 Offset', -400, 400, 5),
  range('warp1', 'Row 1 Warp', 0.3, 1.2, 0.01),
  range('warp2', 'Row 2 Warp', 0.3, 1.2, 0.01),
  range('warp3', 'Row 3 Warp', 0.3, 1.2, 0.01),
  range('warp4', 'Row 4 Warp', 0.3, 1.2, 0.01),
  { type: 'group', key: 'gTiming', label: 'Timing' },
  range('speed', 'Animation Speed', 0.2, 3, 0.1),
];

const MAX_LAYERS = 396;
const REQ_MAX = 128, REQ_TEXT = 256, REQ_CHARS = 4096;     // the host's measure caps (capabilities: script.measure.limits)
const r4 = (v) => { const x = Math.round(v * 1e4) / 1e4; return Object.is(x, -0) ? 0 : x; };
const r6 = (v) => { const x = Math.round(v * 1e6) / 1e6; return Object.is(x, -0) ? 0 : x; };
const n = (v) => { const x = Number(v); return Math.abs(x) < 1e-12 ? '0' : String(Number(x.toPrecision(10))); };
const fx = (code) => ({ type: 'custom', params: { code } });
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const parseRow = (value, fallback) => {
  const parts = String(value || fallback).split(/\r?\n|\|/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : fallback.split('|');
};

// What both measure() and build() read: sizes, tracking, the rows' words (MotionFast buildLayout's inputs)
function inputs(p, frame) {
  const sf = Math.min(frame.W / 1920, frame.H / 1080);
  const fontSize = Math.max(1, (Number(p.fontSize) || 164) * sf);
  const lsPx = Number(p.letterSpacing ?? -0.05) * fontSize;
  const weight = Number(p.fontWeight) || 900;
  const family = String(p.fontFamily || 'Inter');
  const arrow = String(p.arrow || '>').replace(/[\r\n]+/g, ' ');
  const rows = [p.row1, p.row2, p.row3, p.row4].map((v, i) => parseRow(v, ROW_DEFAULTS[i]));
  // the words to measure: each distinct one once, in order, within the host's caps
  const words = [];
  const seen = new Map();
  let chars = Array.from(arrow).length * 2;
  for (const row of rows) for (const w of row) {
    if (seen.has(w)) continue;
    const len = Array.from(w).length;
    const ok = words.length + 2 < REQ_MAX && len <= REQ_TEXT && chars + len <= REQ_CHARS;
    seen.set(w, ok ? `w[${words.length}]` : null);
    if (ok) { words.push(w); chars += len; }
  }
  return { fontSize, lsPx, weight, family, arrow, rows, words, keyOf: seen, arrowOk: Array.from(arrow).length <= REQ_TEXT };
}

export default {
  id: 'cascading-ticker',
  name: 'Cascading Ticker',
  category: 'Typography',
  v: 1,
  fields,
  // every distinct word at the row's size and tracking, the separator at 1× and at 1.18× (no tracking: MotionFast
  // measures and draws it with letterSpacing 0)
  measure({ settings, frame }) {
    const I = inputs({ ...D0, ...settings }, frame);
    const base = { font: I.family, weight: I.weight };
    const out = [];
    if (I.arrowOk) {
      out.push({ key: 'sep', text: I.arrow, size: I.fontSize, ...base });
      out.push({ key: 'sepBig', text: I.arrow, size: I.fontSize * 1.18, ...base });
    }
    I.words.forEach((w, k) => out.push({ key: `w[${k}]`, text: w, size: I.fontSize, letterSpacing: I.lsPx, ...base }));
    return out;
  },
  build({ settings, frame, metrics }) {
    const p = { ...D0, ...settings };
    const { W, H } = frame;
    const warnings = [];
    const I = inputs(p, frame);
    const { fontSize, lsPx, arrow } = I;
    const M = metrics || {};
    let estimated = 0;
    // a text's metrics as the host measured them, else the script's estimate (0.55 em a letter, a 1.2 em font box)
    const metric = (key, text, size, ls) => {
      const m = key && M[key];
      if (m && Number.isFinite(m.width)) {
        return { width: m.width, ascent: num(m.ascent, size * 0.97), descent: num(m.descent, size * 0.24), middle: num(m.middle, size * 0.365) };
      }
      estimated += 1;
      const len = Array.from(text).length;
      return { width: len * 0.55 * size + Math.max(0, len - 1) * ls, ascent: size * 0.97, descent: size * 0.24, middle: size * 0.365 };
    };
    // the canvas 'middle' line at the row's centre: the text layer (centred on its font box) sits this far below it
    const dropOf = (m) => m.middle - (m.ascent - m.descent) / 2;
    const sep1 = metric(I.arrowOk ? 'sep' : null, arrow, fontSize, 0);           // the quirk: measured at 1× for the slide
    const sepBig = metric(I.arrowOk ? 'sepBig' : null, arrow, fontSize * 1.18, 0);
    const itemGap = fontSize * 0.52, arrowGap = fontSize * 0.28;

    const rows = I.rows.map((items, ri) => {
      const offset = Number(p[`offset${ri + 1}`]) || 150;                       // MotionFast: 0 counts as 150
      const warp = Number(p[`warp${ri + 1}`]) || 0.7;
      let blockWidth = 0, actualBlockWidth = 0;
      const laid = items.map((text) => {
        const m = metric(I.keyOf.get(text), text, fontSize, lsPx);
        // the slide's block: the width with the tracking between letters (MotionFast: base + (len − 1) × tracking)
        blockWidth += m.width + arrowGap + sep1.width + itemGap;
        // what the row really advances: the canvas's width carries the tracking after the last letter too
        const textDrawW = m.width + lsPx;
        const advance = textDrawW + arrowGap + sepBig.width + itemGap;
        actualBlockWidth += advance;
        return { text, m, textDrawW, advance };
      });
      const visibleCount = Math.max(1, Math.ceil(W / Math.max(blockWidth, 1)) + 1);
      return { laid, blockWidth, actualBlockWidth, repeatCount: visibleCount + 2, offset, warp };
    });
    const rowGap = Number(p.rowGap) || 40;
    const rowHeight = fontSize * 1.2;
    const totalH = rows.length * rowHeight + (rows.length - 1) * rowGap;
    const firstCenterY = (H - totalH) / 2 + rowHeight / 2;
    const rowStep = rowHeight + rowGap;

    // a text layer holds its letter spacing within −20…80 px: past it the word is drawn at size / k with spacing / k and
    // the layer scaled by k (Zoom), the same glyphs in the same places
    const textLayer = (key, name, parent, text, color, size, ls, x, y) => {
      const k = Math.min(20, ls < -20 ? ls / -20 : ls > 80 ? ls / 80 : 1);
      return {
      key, type: 'text', name, keyframeParenting: { parentItemId: parent, type: 'additive' },
      textContent: text, textColor: color, textFontFamily: I.family, textFontWeight: I.weight,
      textFontSizeUnit: 'px', textFontSize: r4(size / k), ...(ls ? { textLetterSpacing: r4(Math.max(-20, Math.min(80, ls / k))) } : {}),
      ...(k > 1 ? { zoom: r6(k) } : {}),
      textAlign: 'center', textNoWrap: true, textLineHeight: 1,
      // a fixed place: Pan X / Y (% of the frame, unbounded; position keys stop at ±1200 px)
      panX: r6((x / W) * 100), panY: r6((y / H) * 100),
      };
    };
    const layers = [];
    let dropped = 0;
    const D = Math.max(1, 5 / Math.max(0.1, Number(p.speed) || 1));
    // MotionFast's slide (warpEase of the clip's progress), sampled: a word or separator layer lives only while some part
    // of it is in the frame (rounded outward to the host's 1/10000 s, at least the editor's 0.1 s): a layer off the frame
    // costs nothing then
    const SAMPLES = 480;
    const warpEase = (q, w) => { const t = Math.pow(Math.min(1, Math.max(0, q)), w); return t < 0.49 ? 16 * Math.pow(t, 5) : 1 - Math.pow(-2 * t + 2, 5) / 2; };
    const spanOf = (xs, c0, c1) => {
      let a = -1, b = -1;
      for (let j = 0; j <= SAMPLES; j += 1) if (xs[j] + c1 > 0 && xs[j] + c0 < W) { if (a < 0) a = j; b = j; }
      if (a < 0) return null;
      let t0 = Math.floor((Math.max(0, (a - 1) / SAMPLES) * D) * 1e4) / 1e4;
      let t1 = Math.ceil((Math.min(1, (b + 1) / SAMPLES) * D) * 1e4) / 1e4;
      if (t1 - t0 < 0.1) { t1 = Math.min(D, t0 + 0.1); t0 = Math.max(0, t1 - 0.1); }
      if (t0 > D - 0.1) t0 = Math.floor((D - 0.1) * 1e4) / 1e4;
      // (to the clip's end: no trimEnd, the host runs it to the template's end exactly)
      return t1 >= D - 1e-9 ? { freeStart: t0 } : { freeStart: t0, trimEnd: Math.round((t1 - t0) * 1e4) / 1e4 };
    };
    rows.forEach((row, ri) => {
      const { laid, blockWidth: B, actualBlockWidth, repeatCount, offset, warp } = row;
      const startX = -2 * B + offset;
      const rowKey = `row[${ri}]`;
      const centerY = firstCenterY + ri * rowStep;
      // the slide: keys hold the clip's progress, the ƒx is warpEase (t^warp into a quintic in-out, its step at 0.49)
      const q = `pow(value,${n(warp)})`;
      const ease = `(${q}<0.49?16*pow(value,${n(5 * warp)}):1-pow(2-2*${q},5)/2)`;
      layers.push({
        key: rowKey, type: 'null', name: `Row ${ri + 1}`,
        panY: r6(((centerY - H / 2) / H) * 100),
        propertyKeyframes: { translateX: [{ position: 0, value: '0', easing: 'Linear' }, { position: 100, value: '1', easing: 'Linear' }] },
        propertyKeyframeFx: { translateX: fx(`${n(startX)}+${n(B)}*${ease}`) },
      });
      // the words and separators that enter the frame at some moment: x(t) runs from startX to startX + B
      const lo = -(startX + B), hi = W - startX;
      const xs = Array.from({ length: SAMPLES + 1 }, (_, j) => startX + B * warpEase(j / SAMPLES, warp));
      let cursor = 0, k = 0;
      for (let r = 0; r < repeatCount && cursor < hi; r += 1) {
        if (cursor + actualBlockWidth < lo) { cursor += actualBlockWidth; k += laid.length; continue; }
        for (const it of laid) {
          if (cursor < hi && cursor + it.advance > lo) {
            if (layers.length + 2 > MAX_LAYERS) { dropped += 1; } else {
              const sx = cursor + it.textDrawW + arrowGap;
              // (a word's ink can reach a little past its advance: the span takes a quarter em either side)
              const pad = fontSize * 0.25;
              const ws = spanOf(xs, cursor - pad, cursor + it.textDrawW + pad);
              const ss = spanOf(xs, sx - pad, sx + sepBig.width + pad);
              if (ws) layers.push({ ...textLayer(`${rowKey}.word[${k}]`, `Row ${ri + 1} · ${it.text}`, rowKey, it.text, p.textColor, fontSize, lsPx,
                cursor + it.m.width / 2 - W / 2, dropOf(it.m)), ...ws });
              if (ss) layers.push({ ...textLayer(`${rowKey}.sep[${k}]`, `Row ${ri + 1} · separator`, rowKey, arrow, p.accentColor, fontSize * 1.18, 0,
                sx + sepBig.width / 2 - W / 2, dropOf(sepBig)), ...ss });
            }
          }
          cursor += it.advance;
          k += 1;
        }
      }
    });
    if (estimated) warnings.push('No text metrics from the host: the rows are laid out from an estimate (0.55 em a letter); the words may overlap or gap.');
    if (lsPx < -400 || lsPx > 1600) warnings.push('Letter spacing past −400…1600 px: the words are drawn with it held there (their places keep the full value).');
    if (dropped) warnings.push(`Too many words in the frame: ${dropped} of them are left out (400 layers at most).`);
    return { duration: D, layers, warnings };
  },
};
