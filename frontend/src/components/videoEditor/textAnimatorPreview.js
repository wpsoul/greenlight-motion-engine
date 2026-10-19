// Advanced Animations preset previews — a small Canvas2D stage that plays a built
// preset (textAnimatorPresets.build) on a short text with the REAL engine
// (textAnimators.js) and the app's own track evaluator, so a tile moves the way the
// layer will. Mirrors the lab's draw (html/finished/text-animators-lab/index.html): per-unit
// transform around each animator's unit (a glyph with depth is warped into
// perspective), tracking reflow, folded paint, shadow-only glow and shadow,
// highlight boxes, masks, carets. Voice presets speak the tile text with a made-up
// voice (presets fakeVoice: `voiceWins`). Preview only — the layer itself is drawn by
// the Player.

import { evaluate, glyphFor, mul, rgbCss, layerSettings, boxRects, groupBoxes, maskedXf, unitTransform, hToCanvas, warpBegin, warpEnd, caretRect } from './textAnimators';
import { evaluatePropertyTrack } from './gsapTransitions';
import { buildCanvasGradient } from '../../utils/cssGradient';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const layoutCache = new Map();

// Font size that fits `text` into the stage (logical px), and its unit layout.
export function previewLayout(ctx, { text, family, weight, w, h, maxSize = Infinity }) {
  const key = `${text}\u0001${family}\u0001${weight}\u0001${w}\u0001${h}\u0001${maxSize}`;
  const hit = layoutCache.get(key);
  if (hit) return hit;
  const rows = String(text || '').replace(/\r/g, '').split('\n').slice(0, 3);
  const font = (size) => `${weight} ${size}px ${family}`;
  let size = Math.min(maxSize, (h * 0.62) / Math.max(1, rows.length * 1.15));
  ctx.font = font(size);
  const widest = Math.max(1, ...rows.map((r) => ctx.measureText(r).width));
  if (widest > w * 0.86) size *= (w * 0.86) / widest;
  ctx.font = font(size);
  const m = ctx.measureText('Hg');
  const asc = m.actualBoundingBoxAscent || size * 0.75;
  const desc = m.actualBoundingBoxDescent || size * 0.2;
  const lineH = size * 1.15;
  const top = (h - rows.length * lineH) / 2;
  const units = [];
  const lines = [];
  let ci = 0;
  let cn = 0;
  let wi = -1;
  rows.forEach((row, li) => {
    const chars = Array.from(row);
    const rm = ctx.measureText(row);
    const width = rm.width;
    const x0 = (w - width) / 2;
    const cy = top + li * lineH + lineH / 2;
    const baseline = cy + (asc - desc) / 2;
    // The row's own ink, top to bottom — the Mask cuts there (as the Player does).
    const inkTop = baseline - (rm.actualBoundingBoxAscent || asc);
    const inkBottom = baseline + (rm.actualBoundingBoxDescent || 0);
    const first = units.length;
    let prefix = '';
    let prevW = 0;
    let inWord = false;
    for (const ch of chars) {
      const next = prefix + ch;
      const wNext = ctx.measureText(next).width;
      const space = /\s/.test(ch);
      if (!space && !inWord) { wi += 1; inWord = true; }
      if (space) inWord = false;
      units.push({ ch, space, ci: ci++, cn: space ? -1 : cn++, wi: space ? -1 : wi, li, x: x0 + prevW, w: wNext - prevW, cy, baseline });
      prefix = next;
      prevW = wNext;
    }
    lines.push({ li, x0, width, baseline, inkTop, inkBottom, first, count: chars.length });
  });
  const bx0 = Math.min(...lines.map((l) => l.x0));
  const bx1 = Math.max(...lines.map((l) => l.x0 + l.width));
  const L = {
    size, font: font(size), units, lines, asc, desc,
    counts: { chars: ci, charsNoSpace: cn, words: wi + 1, lines: rows.length },
    block: { x: bx0, y: lines[0].baseline - asc, w: Math.max(1, bx1 - bx0), h: lines[lines.length - 1].baseline + desc - (lines[0].baseline - asc) },
  };
  if (layoutCache.size > 200) layoutCache.clear();
  layoutCache.set(key, L);
  return L;
}

// Scratch canvases for glyphs drawn in perspective (warpBegin / warpEnd), shared
// by every tile.
let warpCanvases = null;
const warpScratch = () => warpCanvases || (warpCanvases = { a: document.createElement('canvas'), b: document.createElement('canvas') });

const paintStyle = (ctx, css, box) => {
  if (typeof css === 'string' && css.startsWith('linear-gradient')) return buildCanvasGradient(ctx, css, box) || '#ffffff';
  return css;
};

// Draw one frame. `built` = textAnimatorPresets.build(...) output; `pct` = 0–100
// through a clip of `clipSec` seconds; `voiceWins` = spoken windows for Voice animators.
export function drawPreviewFrame(canvas, { text, family, weight, color, built, pct, clipSec, maxSize, background = null, voiceWins = null }) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 120;
  const h = canvas.clientHeight || 52;
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
  if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, w, h); }
  const L = previewLayout(ctx, { text, family, weight, w, h, maxSize });
  const tracks = built?.tracks || {};
  const tNow = (clamp(pct, 0, 100) / 100) * clipSec;
  const ev = evaluate({
    animators: built?.animators || [],
    units: L.units,
    counts: L.counts,
    time: tNow,
    clipSec,
    voice: voiceWins ? { t: tNow, wins: voiceWins } : null,
    baseColor: /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#ffffff',
    value: (aid, chan, stored) => {
      const track = tracks[`txa:${aid}:${chan}`];
      if (!Array.isArray(track) || !track.length) return stored;
      const v = evaluatePropertyTrack(track, pct, false);
      return Number.isFinite(v) ? v : stored;
    },
  });
  const n = L.units.length;
  // tracking reflow, centred rows
  const X = new Float64Array(n);
  for (const ln of L.lines) {
    let cum = 0;
    for (let j = 0; j < ln.count; j += 1) {
      const i = ln.first + j;
      const tr = ev.states[i].track;
      X[i] = L.units[i].x + L.units[i].w / 2 + cum + tr / 2;
      cum += tr;
    }
    for (let j = 0; j < ln.count; j += 1) X[ln.first + j] -= cum / 2;
  }
  // pivots: every unit's box at each level an animator can turn around
  const lay = layerSettings(built?.layer ? { textAnimatorPivotX: built.layer.pivotX, textAnimatorPivotY: built.layer.pivotY } : null);
  const band = L.asc + L.desc;
  const boxOf = groupBoxes(L.units.map((u, i) => ({ x0: X[i] - u.w / 2, y0: u.cy - band / 2, x1: u.space ? X[i] - u.w / 2 : X[i] + u.w / 2, y1: u.cy + band / 2, wi: u.wi, li: u.li })));
  const pivot = { x: lay.pivotX / 100, y: lay.pivotY / 100 };
  // Mask boxes: across = the unit's, down = its row's ink band (the Player's rule).
  const maskOf = ev.states.some((st) => st.mask)
    ? groupBoxes(L.units.map((u, i) => {
      const b = boxOf(i, 'char');
      const ln = L.lines[u.li];
      return { x0: b.x0, x1: b.x1, y0: ln.inkTop - 1, y1: ln.inkBottom + 1, wi: u.wi, li: u.li };
    }))
    : null;
  ctx.font = L.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  // highlight boxes
  const cells = L.units.map((u, i) => ({ row: u.li, x: X[i] - u.w / 2, w: u.w, ink: u.space ? 0 : u.w, top: u.baseline - L.asc, bottom: u.baseline + L.desc }));
  for (const { v, amt, groups } of ev.boxes) {
    ctx.fillStyle = v.color;
    for (const q of boxRects(v, amt, cells, groups)) {
      ctx.globalAlpha = q.alpha;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(q.x0, q.y0, q.x1 - q.x0, q.y1 - q.y0, q.r);
      else ctx.rect(q.x0, q.y0, q.x1 - q.x0, q.y1 - q.y0);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  // glyphs: one glyph with its light, stroke and paint on `c`, M = its full matrix
  const OFF = 2000;
  const by = (L.asc - L.desc) / 2;
  const paintGlyph = (c, M, u, i, st) => {
    c.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    const g = glyphFor(st, u.ch);
    c.filter = st.blur > 0.05 ? `blur(${(st.blur * dpr).toFixed(2)}px)` : 'none';
    const shadowOnly = (col, blur, ox, oy) => {
      c.save();
      c.shadowColor = col; c.shadowBlur = blur;
      c.shadowOffsetX = M[0] * OFF + ox; c.shadowOffsetY = M[1] * OFF + oy;
      c.globalAlpha = st.alpha; c.fillStyle = '#000';
      c.fillText(g, -OFF, by);
      c.restore();
    };
    if (st.shadow && st.shadow.alpha > 0.003) shadowOnly(rgbCss(st.shadow.c, clamp(st.shadow.alpha, 0, 1)), st.shadow.blur * dpr, st.shadow.x * dpr, st.shadow.y * dpr);
    if (st.glows) {
      for (const gl of st.glows) {
        const passes = clamp(Math.ceil(gl.alpha), 1, 3);
        for (let p = 0; p < passes; p += 1) shadowOnly(rgbCss(gl.c, clamp(gl.alpha / passes, 0, 1)), gl.size * dpr * (p % 2 ? 0.45 : 1), 0, 0);
      }
    }
    const stroke = st.stroke && st.stroke.w > 0.05 ? st.stroke : null;
    if (stroke) { c.lineJoin = 'round'; c.miterLimit = 2; c.strokeStyle = rgbCss(stroke.c); }
    if (stroke && !st.outlineK) { c.globalAlpha = st.alpha; c.lineWidth = stroke.w * 2; c.strokeText(g, 0, by); }
    const fillA = st.alpha * (1 - st.outlineK);
    if (fillA > 0.003) {
      const unitBox = { x: -u.w / 2, y: -band / 2, w: u.w, h: band };
      const textBox = { x: L.block.x - X[i], y: L.block.y - u.cy, w: L.block.w, h: L.block.h };
      c.globalAlpha = fillA;
      const css = st.touched ? (st.paint.type === 'solid' ? rgbCss(st.paint.c) : null) : (color || '#ffffff');
      if (css) c.fillStyle = paintStyle(c, css, textBox);
      else {
        const stops = st.paint.stops.map((q) => `rgb(${Math.round(q.c[0])}, ${Math.round(q.c[1])}, ${Math.round(q.c[2])}) ${(q.p * 100).toFixed(2)}%`).join(', ');
        c.fillStyle = paintStyle(c, `linear-gradient(${st.paint.angle + 90}deg, ${stops})`, st.paint.span === 'unit' ? unitBox : textBox);
      }
      c.fillText(g, 0, by);
    }
    if (stroke && st.outlineK) { c.globalAlpha = st.alpha; c.lineWidth = stroke.w; c.strokeText(g, 0, by); }
    c.filter = 'none';
    c.globalAlpha = 1;
  };
  // One unit: its transform around each animator's unit (depth = warped).
  const drawUnit = (i, u, st) => {
    const mb = st.mask ? maskOf(i, st.mask) : null;
    const tf = st.xf ? unitTransform(mb ? maskedXf(st, mb.y1 - mb.y0) : st.xf, (lv) => boxOf(i, lv), pivot) : null;
    const local = [1, 0, 0, 1, X[i], u.cy];
    if (tf && tf.projective) {
      // Depth: paint the glyph flat, then warp it into perspective.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const room = band * 0.25 + (st.stroke ? st.stroke.w : 0);
      const box = { x0: X[i] - u.w / 2 - room, y0: u.cy - band / 2 - room, x1: X[i] + u.w / 2 + room, y1: u.cy + band / 2 + room };
      const reach = 3 * st.blur + (st.shadow ? Math.abs(st.shadow.x) + Math.abs(st.shadow.y) + 1.5 * st.shadow.blur : 0)
        + (st.glows ? 1.5 * Math.max(...st.glows.map((gl) => gl.size)) : 0);
      const w = warpBegin(ctx, tf.H, box, warpScratch(), reach * dpr);
      if (w) { paintGlyph(w.ctx, mul(w.base, local), u, i, st); warpEnd(w); }
      return;
    }
    let M = [dpr, 0, 0, dpr, 0, 0];
    if (tf) M = mul(M, hToCanvas(tf.H));
    M = mul(M, local);
    if (Math.abs(M[0] * M[3] - M[1] * M[2]) < 1e-9) return;
    paintGlyph(ctx, M, u, i, st);
  };
  for (let i = 0; i < n; i += 1) {
    const u = L.units[i];
    const st = ev.states[i];
    if (u.space || st.alpha < 0.003) continue;
    if (st.mask) {
      // Mask: cut the unit off at its resting ink box, so it slides in from behind it.
      const b = maskOf(i, st.mask);
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.beginPath();
      ctx.rect(b.x0 - 2, b.y0, b.x1 - b.x0 + 4, b.y1 - b.y0);
      ctx.clip();
    }
    drawUnit(i, u, st);
    if (st.mask) ctx.restore();
  }
  // Caret effects, in the text colour unless they have their own.
  for (const c of ev.carets) {
    const r = caretRect(c, cells, tNow);
    if (!r) continue;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = r.alpha;
    ctx.fillStyle = r.color || color || '#ffffff';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.globalAlpha = 1;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return L;
}
