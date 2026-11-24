// Sliced Rolling Text (MotionFast `sliced-rolling-text`): a stack of text blocks, one per line, each a box whose four
// long faces carry the line (front and back dark on light, top and bottom light on dark), rolling round their long
// axis for the whole clip while every block and the frame behind them sway (an in-plane tilt following the roll),
// over a faint grid, with a label up each side of the frame.
//
// Built from ordinary layers in the editor's real 3D: per block a Block null (its place in the stack, its depth and
// the sway), a Roll null under it (the roll about X), and four faces under that (a face card and its line of text, each
// placed and turned onto its side of the box). The roll is a straight turn in time and the sway a sine of it: one key
// each and a short ƒx. MotionFast projects with a 2000 px CSS perspective about the frame's centre: the World null
// scales the scene by lens / 2000 and the camera zooms back by 2000 / lens, so the editor's lens films it from 2000 px
// whatever the frame. The frame sits behind every block in depth (pushed back, its size kept), as MotionFast paints it
// first. The grid is a picture that the camera does not film.
//
// Text widths: the blocks are as wide as the longest line (+ padding, snapped to the grid's odd steps), and each side
// label sits half its own width off the frame. A script cannot measure text, so it asks the host: measure() names every
// line (the chosen font, weight and size, as the face text layers draw it) and both labels (Inter 400, MotionFast's fixed
// label font, with its 1 px tracking), and build() reads `metrics`: the lines' widths, the labels' widths (plus the
// canvas's tracking after the last letter) and font boxes. Without metrics (node tools) an estimate of 0.55 em a letter
// is used, with a warning; the lines themselves are always drawn by text layers in the chosen font, centred on their
// faces, so only the box width can differ.
//
// A built-in script (PLANS/ESSENTIAL_TEMPLATES.md §14): it imports nothing, so this same text also runs as a
// `kind: "script"` source. Numbers and timing are MotionFast's (motionTemplates/slicedRollingText.js).
const REF_H = 1080;
const LENS_FOV = 28;                      // the editor's camera (projectCamera.js CAMERA_FOV)
// the script's own estimate where the host measured nothing: 0.55 em a letter, a 1.2 em font box
const estimate = (text, sizePx, lsPx = 0) => {
  const len = Array.from(String(text || '')).length;
  return { width: len * 0.55 * sizePx + Math.max(0, len - 1) * lsPx, ascent: 0.97 * sizePx, descent: 0.24 * sizePx };
};

const D0 = {
  stackText: 'HELLO\nFROM\nDUBLIN', footerLeft: '53.3454° N', footerRight: '-6.3070° E', speed: 0.5, duration: 10,
  blockPadding: 100, maxTilt: 20, showGrid: true, fontFamily: 'Anton', fontWeight: 700, fontSize: 100,
  primaryColor: '#FFFFFF', secondaryColor: '#000000',
};
const fields = [
  { type: 'group', key: 'gText', label: 'Text' },
  { key: 'stackText', type: 'textarea', label: 'Block Lines (one per line)', default: D0.stackText, rows: 6 },
  { key: 'footerLeft', type: 'text', label: 'Left Label', default: D0.footerLeft },
  { key: 'footerRight', type: 'text', label: 'Right Label', default: D0.footerRight },
  { type: 'group', key: 'gType', label: 'Typeface' },
  { key: 'fontFamily', type: 'font', label: 'Font', default: D0.fontFamily },
  { key: 'fontWeight', type: 'select', label: 'Font Weight', default: 700, options: [
    { value: 400, label: 'Regular' }, { value: 600, label: 'Semibold' }, { value: 700, label: 'Bold' }, { value: 800, label: 'Extra Bold' }, { value: 900, label: 'Black' },
  ] },
  { key: 'fontSize', type: 'range', label: 'Font Size', default: 100, min: 40, max: 200, step: 5, suffix: 'px' },
  { type: 'group', key: 'gColor', label: 'Colours' },
  { key: 'primaryColor', type: 'color', label: 'Primary', default: D0.primaryColor },
  { key: 'secondaryColor', type: 'color', label: 'Secondary', default: D0.secondaryColor },
  { type: 'group', key: 'gBlock', label: 'Block' },
  { key: 'blockPadding', type: 'range', label: 'Block Padding', default: 100, min: 0, max: 500, step: 10, suffix: 'px' },
  { key: 'maxTilt', type: 'range', label: 'Max Tilt (deg)', default: 20, min: 0, max: 25, step: 1, suffix: '°' },
  { key: 'showGrid', type: 'switch', label: 'Show Grid', default: true },
  { type: 'group', key: 'gTiming', label: 'Timing' },
  { key: 'speed', type: 'range', label: 'Spin Speed', default: 0.5, min: 0.1, max: 2, step: 0.1 },
  { key: 'duration', type: 'range', label: 'Duration (sec)', default: 10, min: 5, max: 30, step: 1, suffix: 's' },
];

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r6 = (v) => { const x = Math.round(v * 1e6) / 1e6; return Object.is(x, -0) ? 0 : x; };
const n = (v) => { const x = Number(v); return Math.abs(x) < 1e-12 ? '0' : String(Number(x.toPrecision(10))); };
const one = (v) => [{ position: 0, value: n(v), easing: 'Linear' }];
const fx = (code) => ({ type: 'custom', params: { code } });
const svgUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
// MotionFast's odd-grid snap: up to an odd multiple of the grid (grid, 3 grid, 5 grid …)
const snapToOddGrid = (val, grid) => Math.ceil((val - grid) / (grid * 2)) * grid * 2 + grid;

// what both measure() and build() read: the lines, the block slot, the fitted font size (MotionFast buildLayout)
function geometry(p, frame) {
  const s = frame.H / REF_H;
  const lines = String(p.stackText || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const N = Math.max(1, lines.length);
  const bh = ((frame.H * 0.8) / N) * 0.67;
  const fontPx = Math.min((Number(p.fontSize) || 100) * s, bh * 1.12);
  return { s, lines, N, bh, depth: bh, fontPx, family: String(p.fontFamily || 'Anton'), wt: Number(p.fontWeight) || 700 };
}

export default {
  id: 'sliced-rolling-text',
  name: 'Sliced Rolling Text',
  category: '3D Text',
  v: 1,
  fields,
  // every line at the size its face text layers draw it, and the two side labels (Inter 400 at 14 px, 1 px tracking)
  measure({ settings, frame }) {
    const p = { ...D0, ...settings };
    const g = geometry(p, frame);
    const out = g.lines.map((line, i) => ({ key: `line[${i}]`, text: line, font: g.family, size: g.fontPx, weight: g.wt }))
      .filter((r) => Array.from(r.text).length <= 256).slice(0, 126);
    for (const [key, text] of [['label.left', p.footerLeft], ['label.right', p.footerRight]]) {
      if (text && Array.from(String(text)).length <= 256) out.push({ key, text: String(text), font: 'Inter', size: 14 * g.s, weight: 400, letterSpacing: 1 * g.s });
    }
    return out;
  },
  build({ settings, frame, metrics }) {
    const p = { ...D0, ...settings };
    const { W, H } = frame;
    const g = geometry(p, frame);
    const { s, lines, N, bh, depth, fontPx, family, wt } = g;
    const warnings = [];
    const GRID = 100 * s;
    const topOffset = H * 0.1;
    const slotHeight = (H * 0.8) / N;
    const padding = (Number(p.blockPadding) || 100) * s;        // MotionFast: 0 counts as 100
    const M = metrics || {};
    let estimated = 0;
    // a text's metrics as the host measured them, else the estimate (counted for the warning)
    const metric = (key, text, size, ls = 0) => {
      const m = M[key];
      if (m && Number.isFinite(m.width)) return { width: m.width, ascent: Number.isFinite(m.ascent) ? m.ascent : 0.97 * size, descent: Number.isFinite(m.descent) ? m.descent : 0.24 * size };
      estimated += 1;
      return estimate(text, size, ls);
    };
    let maxW = 0;
    lines.forEach((line, i) => { maxW = Math.max(maxW, metric(`line[${i}]`, line, fontPx).width); });
    const bw = Math.max(snapToOddGrid(maxW + padding, GRID), GRID);
    const frameH = snapToOddGrid(H * 0.8, GRID);
    const P = 2000 * s;                                          // MotionFast's perspective
    const stackZ = depth / 2 + 2 * s;
    const primary = p.primaryColor || '#FFFFFF', secondary = p.secondaryColor || '#000000';
    // the clip and the motion (MotionFast renderFrame)
    const D = Math.max(1, Number(p.duration) || 10);
    const speed = Number(p.speed) || 0.5;
    const maxTilt = Number(p.maxTilt) || 20;                     // MotionFast: 0 counts as 20
    const totalAngle = 360 * Math.max(1, Math.round((D / 4) * speed));
    const rate = totalAngle / D;                                 // degrees a second
    // the sway: maxTilt × sin(2 × the roll's angle), the same turn for the frame and every block
    const TILT = fx(`${n(maxTilt)}*sin(${n((2 * rate * Math.PI) / 180)}*time)`);
    // the roll: CSS rotateX(−angle) (the editor's rotateX turns as CSS's), kept in −180…180
    const ROLL = fx(`(((${n(-rate)}*time+180)%360+360)%360-180)`);
    const lens = (H * 0.5) / Math.tan(((LENS_FOV * Math.PI) / 180) * 0.5);
    const k = lens / P;

    const layers = [];
    // the grid: lines 100 px apart through the frame's centre ± 50, a quarter strong, not filmed by the camera
    if (p.showGrid !== false) {
      const step = 100 * s;
      let d = '';
      for (let x = (((W / 2 - step / 2) % step) + step) % step; x <= W; x += step) d += `M${r4(x)} 0V${H}`;
      for (let y = (((H / 2 - step / 2) % step) + step) % step; y <= H; y += step) d += `M0 ${r4(y)}H${W}`;
      layers.push({ key: 'grid', type: 'image', name: 'Grid', cameraLocked: true,
        src: svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path d="${d}" fill="none" stroke="#444444" stroke-opacity="0.25" stroke-width="${r4(Math.max(1, s))}"/></svg>`) });
    }
    layers.push({ key: 'world', type: 'null', name: 'World', propertyKeyframes: { scale: one(k) } });
    // the frame: a dark card with a light 2 px border inside its edge, behind every block (pushed back by zb and
    // enlarged to keep its size on screen), swaying; the labels hang off it
    const zb = depth * 0.6 + 20 * s;
    const fw = bw + 186 * s, fh = frameH;
    layers.push({
      key: 'frame', type: 'shape', name: 'Frame', keyframeParenting: { parentItemId: 'world', type: 'additive' },
      shapeType: 'rectangle', shapeSizeUnit: 'px', shapeWidthPx: r4(fw), shapeHeightPx: r4(fh), shapeFillColor: secondary,
      borderWidth: r4(2 * s), borderColor: primary,
      propertyKeyframes: { translateZ: one(-zb), scale: one((P + zb) / P), rotate: one(0) },
      propertyKeyframeFx: { rotate: TILT },
    });
    const labelFont = 14 * s, ls = 1 * s;
    const label = (key, text, side) => {
      if (!text) return;
      const m = metric(key, text, labelFont, ls);
      const tw = m.width + ls;                                   // the canvas's width: its tracking after the last letter too
      const th = m.ascent + m.descent;
      // MotionFast's label box: 30 px outside the frame's edge, its top at the frame's middle, turned ±90° about its centre
      const cx = side < 0 ? -fw / 2 - 30 * s + tw / 2 : fw / 2 + 30 * s - tw / 2;
      layers.push({
        key, type: 'text', name: side < 0 ? 'Left label' : 'Right label', keyframeParenting: { parentItemId: 'frame', type: 'additive' },
        textContent: text, textColor: primary, textFontFamily: 'Inter', textFontWeight: 400, textFontSizeUnit: 'px', textFontSize: r4(labelFont),
        textLetterSpacing: r4(ls), textAlign: 'center', textNoWrap: true, textLineHeight: 1,
        propertyKeyframes: { translateX: one(cx), translateY: one(th / 2), rotate: one(side < 0 ? -90 : 90) },
      });
    };
    label('label.left', p.footerLeft, -1);
    label('label.right', p.footerRight, 1);
    // the blocks
    lines.forEach((line, i) => {
      const cy = topOffset + (i + 0.5) * slotHeight - H / 2;
      layers.push({ key: `block[${i}]`, type: 'null', name: `Block ${i + 1}`, keyframeParenting: { parentItemId: 'world', type: 'additive' },
        propertyKeyframes: { translateY: one(cy), translateZ: one(stackZ), rotate: one(0) }, propertyKeyframeFx: { rotate: TILT } });
      layers.push({ key: `roll[${i}]`, type: 'null', name: `Roll ${i + 1}`, keyframeParenting: { parentItemId: `block[${i}]`, type: 'additive' },
        propertyKeyframes: { rotateX: one(0) }, propertyKeyframeFx: { rotateX: ROLL } });
      // a face: its card and its line, placed on the box (MotionFast faceLocalPoint), turned onto its side
      const FACES = [
        ['front', { translateZ: depth / 2 }, primary, secondary],
        ['back', { translateZ: -depth / 2, rotateX: 180 }, primary, secondary],
        ['top', { translateY: -bh / 2, rotateX: 90 }, secondary, primary],
        ['bottom', { translateY: bh / 2, rotateX: -90 }, secondary, primary],
      ];
      for (const [face, place, bg, ink] of FACES) {
        const pos = Object.fromEntries(Object.entries(place).map(([t, v]) => [t, one(v)]));
        const base = { keyframeParenting: { parentItemId: `roll[${i}]`, type: 'additive' }, propertyKeyframes: pos };
        layers.push({ ...base, key: `${face}[${i}]`, type: 'shape', name: `Block ${i + 1} ${face}`,
          shapeType: 'rectangle', shapeSizeUnit: 'px', shapeWidthPx: r4(bw), shapeHeightPx: r4(face === 'front' || face === 'back' ? bh : depth),
          shapeFillColor: bg, borderWidth: r4(1 * s), borderColor: secondary });
        layers.push({ ...base, key: `${face}[${i}].text`, type: 'text', name: `Block ${i + 1} ${face} text`,
          textContent: line, textColor: ink, textFontFamily: family, textFontWeight: Number(p.fontWeight) || 700,
          textFontSizeUnit: 'px', textFontSize: r4(fontPx), textAlign: 'center', textNoWrap: true, textLineHeight: 1 });
      }
    });
    layers.push({ key: 'camera', type: 'camera', name: 'Lens', propertyKeyframes: { camZoom: one(P / lens) } });
    if (estimated) warnings.push('No text metrics from the host: the blocks and labels are sized from an estimate (0.55 em a letter).');
    if (layers.length > 400) warnings.push('Too many lines for one template (400 layers at most): keep it under 38 lines.');
    return { duration: D, layers, warnings };
  },
};
