/*
 * Painting text and shapes to canvases (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 26 — moved verbatim out of
 * Player.jsx with tests/engine-extraction/tools/move_module_decls.py; the Player imports back what it still uses):
 * letter spacing and kerning, wrapping, text animators' per-run state, decorations and reveal bars, path text, shape
 * paths with strokes and dashes, placeholder textures, and the scratch canvases these share.
 */
import * as THREE from 'three';
import { buildCanvasGradient, gradientFirstStopColor, isCssGradient } from '../../../utils/cssGradient';
import { getBackgroundCSS } from '../../mockupGenerator/BackgroundSelector';
import { drawEditorBackground } from '../backgroundLayer';
import { getItemShadows, parseCssColor } from '../clipShader';
import { buildPathArcTable } from '../gridLayout';
import { buildStrokeScene, strokeEngineActive } from '../pathStroke';
import { releaseStrokeRenderer, renderStrokeScene } from '../pathStrokeRenderer';
import { buildPathOutline, buildTrimmedOutline, isStrokeShape, isTrimActive, LINE_DEFAULTS, shapeCornerRadii } from '../shapePath';
import { KF_PREFIX as TXA_KF_PREFIX } from '../textAnimators';
import { getShapeSvgImage } from './pathFx';

// Caption-bar reveal: one background bar clipped by its In/Out animation.
// 'wipe' grows/shrinks the bar from the anchored edge; 'slide' keeps the mask at
// the bar's final shape and translates the fill (center-* have no slide origin,
// so they always wipe). The Out slot mirrors the directional anchor so the named
// direction is the one the motion travels both ways (In mask-right sweeps the
// leading edge rightward, Out mask-right sweeps the trailing edge rightward).
// reveal > 1 (Back/Elastic overshoot) just draws the full bar — the clip window
// is already larger than the geometry.
// `paint` says what the bar is made of: `fill` paints ctx.fillStyle, `border`
// ({ color, width, style }) strokes a line INSIDE the bar's bounds (inset by half
// the width, CSS-style) so the border never grows the measured bar. Both go
// through the same reveal clip, so a border-only bar wipes exactly like a filled one.
export const TEXT_BG_MIRRORED_DIRS = { 'mask-right': 'mask-left', 'mask-left': 'mask-right', 'mask-up': 'mask-down', 'mask-down': 'mask-up' };

export const TEXT_BG_DEFAULT_PAINT = { fill: true, border: null };

// `appear` ({ mode, q, start }) is Grow Shape's extra state: `start` is the seed
// size (px, along the grow axis) the shape extends from, and mode/q the shape's
// own fade / scale-in / scale-down on a separate clock (see the grow branch).
export function drawTextBgRevealBar(ctx, x, y, w, h, radius, type, style, slot, reveal, paint = TEXT_BG_DEFAULT_PAINT, appear = null) {
  // bw/bh default to the full bar; 'grow' paints a smaller bar with the SAME
  // radius (roundRect scales the corners down once they no longer fit, so a
  // pill stays a pill all the way down to nothing).
  const roundedPath = (bx, by, bw = w, bh = h, r = radius) => {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, r);
    else ctx.rect(bx, by, bw, bh);
  };
  const paintBar = (bx, by, bw = w, bh = h, r = radius) => {
    if (paint.fill) { roundedPath(bx, by, bw, bh, r); ctx.fill(); }
    const border = paint.border;
    if (border && border.width > 0) {
      // Clamp by the LONGER side only, so a hairline seed (bw → 0) still draws
      // its caret line at full stroke width instead of vanishing.
      const lw = Math.min(border.width, Math.max(bw, bh) * 0.5);
      ctx.save();
      ctx.strokeStyle = border.color;
      ctx.lineWidth = lw;
      if (border.style === 'dashed') { ctx.setLineDash([lw * 3, lw * 2]); ctx.lineCap = 'butt'; }
      else if (border.style === 'dotted') { ctx.setLineDash([0, lw * 2]); ctx.lineCap = 'round'; }
      else ctx.setLineDash([]);
      ctx.beginPath();
      const ix = bx + lw * 0.5, iy = by + lw * 0.5, iw = Math.max(0, bw - lw), ih = Math.max(0, bh - lw);
      if (ctx.roundRect) ctx.roundRect(ix, iy, iw, ih, Math.max(0, r - lw * 0.5));
      else ctx.rect(ix, iy, iw, ih);
      ctx.stroke();
      ctx.restore();
    }
  };
  const dir = slot === 'out' && TEXT_BG_MIRRORED_DIRS[type] ? TEXT_BG_MIRRORED_DIRS[type] : type;
  if (style === 'grow' && type !== 'none' && type !== 'fade') {
    // Grow Shape. The bar has a SEED sitting at the anchored edge — Start Width,
    // or the pill's diameter when there is a radius (a circle), or a hairline
    // caret — and the grow extends that seed along the direction to the full bar,
    // so the fill really is ~0 wide at the start instead of a tall sliver. Shape
    // Appear transforms about the ANCHOR POINT (the seed's start point), never the
    // moving box centre, so nothing drifts: scale-in zooms the seed from a dot
    // (dot → caret line, or dot → circle with a radius) and the extension only
    // begins once the seed is whole — the caller sequences the two clocks;
    // scale-down settles from 150% at the same point; fade alphas the whole thing.
    const p = Math.min(Math.max(reveal, 0), 1);
    const mode = appear && appear.mode ? appear.mode : 'none';
    const q = appear ? Math.min(Math.max(appear.q, 0), 1) : 1;
    const horizontal = dir === 'mask-right' || dir === 'mask-left' || dir === 'center-h';
    const full = horizontal ? w : h;
    const cross = horizontal ? h : w;
    const rEff = Math.min(radius, w * 0.5, h * 0.5);
    const hairline = Math.max(2, paint.border ? paint.border.width : 0);
    const seed = Math.min(full, Math.max(appear && appear.start > 0 ? appear.start : 0, rEff > 0 ? Math.min(rEff * 2, cross) : 0, hairline));
    const len = seed + (full - seed) * p;
    let cx = x, cy = y, cw = w, ch = h;
    if (horizontal) {
      cw = len;
      if (dir === 'mask-left') cx = x + w - len;
      else if (dir === 'center-h') cx = x + (w - len) * 0.5;
    } else {
      ch = len;
      if (dir === 'mask-up') cy = y + h - len;
      else if (dir === 'center-v') cy = y + (h - len) * 0.5;
    }
    const ax = dir === 'mask-right' ? x : dir === 'mask-left' ? x + w : x + w * 0.5;
    const ay = dir === 'mask-down' ? y : dir === 'mask-up' ? y + h : y + h * 0.5;
    let sc = 1;
    let alphaMul = 1;
    if (mode === 'fade') alphaMul = q;
    else if (mode === 'scale-in') sc = q;
    else if (mode === 'scale-down') { sc = 1 + 0.5 * (1 - q); alphaMul = q; }
    if (sc !== 1) { cx = ax + (cx - ax) * sc; cy = ay + (cy - ay) * sc; cw *= sc; ch *= sc; }
    if (cw > 0.01 && ch > 0.01 && alphaMul > 0.001) {
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = prevAlpha * alphaMul;
      paintBar(cx, cy, cw, ch, radius * sc);
      ctx.globalAlpha = prevAlpha;
    }
    return;
  }
  if (type === 'none' || (reveal >= 1 && type !== 'fade')) { paintBar(x, y); return; }
  if (reveal <= 0) return;
  if (type === 'fade') {
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * Math.min(reveal, 1);
    paintBar(x, y);
    ctx.globalAlpha = prevAlpha;
    return;
  }
  const p = Math.min(reveal, 1);
  // The partial bar's box for this direction — the clip window for 'wipe'.
  let cx = x, cy = y, cw = w, ch = h;
  if (dir === 'mask-right') cw = w * p;
  else if (dir === 'mask-left') { cx = x + w * (1 - p); cw = w * p; }
  else if (dir === 'mask-down') ch = h * p;
  else if (dir === 'mask-up') { cy = y + h * (1 - p); ch = h * p; }
  else if (dir === 'center-h') { cx = x + (w * (1 - p)) / 2; cw = w * p; }
  else if (dir === 'center-v') { cy = y + (h * (1 - p)) / 2; ch = h * p; }
  ctx.save();
  if (style === 'slide' && TEXT_BG_MIRRORED_DIRS[dir]) {
    roundedPath(x, y);
    ctx.clip();
    const dx = dir === 'mask-right' ? -(1 - p) * w : dir === 'mask-left' ? (1 - p) * w : 0;
    const dy = dir === 'mask-down' ? -(1 - p) * h : dir === 'mask-up' ? (1 - p) * h : 0;
    paintBar(x + dx, y + dy);
  } else {
    ctx.beginPath();
    ctx.rect(cx, cy, Math.max(0, cw), Math.max(0, ch));
    ctx.clip();
    paintBar(x, y);
  }
  ctx.restore();
}

export const _placeholderCache = {};

export function getPlaceholderTexture(type = 'loading') {
  if (_placeholderCache[type]) return _placeholderCache[type];
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 288;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, 512, 288);

  if (type === 'error') {
    ctx.fillStyle = '#ef4444';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('\u26A0', 256, 125);
    ctx.fillStyle = '#888';
    ctx.font = '14px sans-serif';
    ctx.fillText('Failed to load video', 256, 160);
  } else {
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(256, 120, 24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#8b5cf6';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(256, 120, 24, -Math.PI / 2, Math.PI / 4);
    ctx.stroke();
    ctx.fillStyle = '#888';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Processing video\u2026', 256, 170);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  _placeholderCache[type] = texture;
  return texture;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Text-on-Path arc tables are pure functions of the path object, and panel
// patches replace that object wholesale, so identity is a safe cache key
// (WeakMap — the table is dropped together with the superseded path).
export const textPathArcTables = new WeakMap();

export function getTextPathArcTable(path) {
  let table = textPathArcTables.get(path);
  if (table === undefined) {
    table = buildPathArcTable(path) ?? null;
    textPathArcTables.set(path, table);
  }
  return table;
}

// Dynamic placeholders ({{{COUNTER:…}}}, {{{CYCLE:…}}}, … — textPlaceholders.js) of the
// text layer being laid out and painted right now. The text branch sets it before
// layout and clears it after the paint; it is null for every layer without one, so the
// three glyph helpers below pay one null check. Only that branch calls them, and it
// runs synchronously.
export let activeTextRun = null;

// Text Animators: does this animator have any keyframe track right now?
export function txaHasTrack(pk, aid) {
  if (!pk) return false;
  const pre = `${TXA_KF_PREFIX}${aid}:`;
  for (const key in pk) if (key.startsWith(pre) && Array.isArray(pk[key]) && pk[key].length) return true;
  return false;
}

// Letter spacing goes through the canvas's own `letterSpacing`, which keeps the font's kerning
// pairs. Drawing glyph by glyph dropped them — tracked text came out 2–3 % wider (7 % on a line like
// "AVATAR To") than the same text anywhere else, and wider than it measured, since measuring used
// the kerned string. Canvas spacing follows EVERY glyph, the last included; the layout counts the
// n − 1 gaps between glyphs. Without the property (old WebKit) the glyph loop stays.
export const CANVAS_LETTER_SPACING = typeof CanvasRenderingContext2D !== 'undefined'
  && 'letterSpacing' in CanvasRenderingContext2D.prototype;

export function withCanvasLetterSpacing(ctx, letterSpacing, fn) {
  const prev = ctx.letterSpacing;
  ctx.letterSpacing = `${letterSpacing}px`;
  try { return fn(); } finally { ctx.letterSpacing = prev; }
}

export function measurePlainText(ctx, text, letterSpacing) {
  if (!text) return 0;
  const chars = Array.from(text);
  if (chars.length === 0) return 0;
  if (chars.length === 1) return ctx.measureText(text).width;
  if (CANVAS_LETTER_SPACING && Number.isFinite(letterSpacing) && Math.abs(letterSpacing) >= 0.001) {
    return withCanvasLetterSpacing(ctx, letterSpacing, () => ctx.measureText(text).width) - letterSpacing;
  }
  return ctx.measureText(text).width + letterSpacing * (chars.length - 1);
}

// Kerning between the last glyph of one split unit and the first of the next, at the context's
// current font — what a whole-string draw applies between them. Cached per font + pair: a split
// text re-lays itself out every frame it animates.
export const kernPairCache = new Map();

export function kernBetween(ctx, a, b) {
  if (!a || !b) return 0;
  const key = `${ctx.font}\u0000${a}${b}`;
  let k = kernPairCache.get(key);
  if (k === undefined) {
    k = ctx.measureText(a + b).width - ctx.measureText(a).width - ctx.measureText(b).width;
    if (kernPairCache.size > 4096) kernPairCache.clear();
    kernPairCache.set(key, k);
  }
  return k;
}

export function measureTextWithLetterSpacing(ctx, text, letterSpacing) {
  if (!text) return 0;
  if (activeTextRun?.holds(text)) return activeTextRun.measure(ctx, text, letterSpacing, measurePlainText);
  return measurePlainText(ctx, text, letterSpacing);
}

export function drawTextWithLetterSpacing(ctx, text, x, y, letterSpacing) {
  if (!text) return;
  if (activeTextRun?.holds(text)) {
    activeTextRun.paint(
      ctx, text, x, y, letterSpacing, measurePlainText,
      (plain, px, py = y) => drawPlainTextWithLetterSpacing(ctx, plain, px, py, letterSpacing),
      (ch, gx, gy) => ctx.fillText(ch, gx, gy),
    );
    return;
  }
  drawPlainTextWithLetterSpacing(ctx, text, x, y, letterSpacing);
}

export function drawPlainTextWithLetterSpacing(ctx, text, x, y, letterSpacing) {
  if (!Number.isFinite(letterSpacing) || Math.abs(letterSpacing) < 0.001) {
    ctx.fillText(text, x, y);
    return;
  }
  if (CANVAS_LETTER_SPACING) {
    withCanvasLetterSpacing(ctx, letterSpacing, () => ctx.fillText(text, x, y));
    return;
  }
  let cursor = x;
  for (const ch of Array.from(text)) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + letterSpacing;
  }
}

// Paint a glyph run as fill, outline, or both — the layer's Fill Style.
//
// Outline-only type is what makes a contour effect read on text: Running Glow (and
// any rim light) draws ON the glyph boundary, and a filled glyph swamps it, whereas
// a hollow glyph is nothing BUT boundary. The caller sets fillStyle / strokeStyle /
// lineWidth; this only decides which of the two passes run.
export function paintTextWithLetterSpacing(ctx, text, x, y, letterSpacing, mode) {
  if (!text) return;
  if (mode !== 'outline') drawTextWithLetterSpacing(ctx, text, x, y, letterSpacing);
  if (mode !== 'fill') strokeTextWithLetterSpacing(ctx, text, x, y, letterSpacing);
}

// Stroke variant of the above — used by the text-shadow spread pass, which
// dilates the glyph silhouette with a thick stroke so its shadow "spreads".
export function strokeTextWithLetterSpacing(ctx, text, x, y, letterSpacing) {
  if (!text) return;
  if (activeTextRun?.holds(text)) {
    activeTextRun.paint(
      ctx, text, x, y, letterSpacing, measurePlainText,
      (plain, px, py = y) => strokePlainTextWithLetterSpacing(ctx, plain, px, py, letterSpacing),
      (ch, gx, gy) => ctx.strokeText(ch, gx, gy),
    );
    return;
  }
  strokePlainTextWithLetterSpacing(ctx, text, x, y, letterSpacing);
}

export function strokePlainTextWithLetterSpacing(ctx, text, x, y, letterSpacing) {
  if (!Number.isFinite(letterSpacing) || Math.abs(letterSpacing) < 0.001) {
    ctx.strokeText(text, x, y);
    return;
  }
  if (CANVAS_LETTER_SPACING) {
    withCanvasLetterSpacing(ctx, letterSpacing, () => ctx.strokeText(text, x, y));
    return;
  }
  let cursor = x;
  for (const ch of Array.from(text)) {
    ctx.strokeText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + letterSpacing;
  }
}

// CSS-like text-transform, applied BEFORE measuring/wrapping so alignment and
// backgrounds use the transformed glyph widths. `capitalize` matches CSS: only
// each word's first character is uppercased, the rest keeps its typed case.
export function applyTextLetterCase(text, mode) {
  if (!text || !mode || mode === 'none') return text;
  if (mode === 'lowercase') return text.toLowerCase();
  if (mode === 'uppercase') return text.toUpperCase();
  if (mode === 'capitalize') return text.replace(/(^|\s)(\S)/g, (m, pre, ch) => pre + ch.toUpperCase());
  return text;
}

// text-decoration line drawn in the CURRENT fillStyle (call right after the
// glyph fill so it matches the text colour and inherits the same ctx.shadow).
// `topY` is the em-box top — text is drawn with textBaseline = 'top', and the
// alphabetic baseline sits ~0.8em below the top for typical fonts.
export function drawTextDecorationLine(ctx, decoration, x, topY, width, fontSize, mode = 'fill') {
  if (!decoration || decoration === 'none' || !(width > 0)) return;
  const thickness = Math.max(1, fontSize / 16);
  const baseline = topY + fontSize * 0.8;
  let lineY;
  if (decoration === 'underline') lineY = baseline + fontSize * 0.08;
  else if (decoration === 'line-through') lineY = baseline - fontSize * 0.3;
  else lineY = baseline - fontSize * 0.95; // overline
  // Hollow type gets a hollow rule; a solid bar under outlined letters reads as a
  // mistake. Inset by half the stroke so the outlined rule keeps its thickness.
  if (mode === 'outline') {
    const half = ctx.lineWidth / 2;
    if (thickness > ctx.lineWidth) ctx.strokeRect(x + half, lineY + half, width - ctx.lineWidth, thickness - ctx.lineWidth);
    else ctx.fillRect(x, lineY, width, thickness);
    return;
  }
  ctx.fillRect(x, lineY, width, thickness);
}

// Seeded PRNG for the Text Randomizer. Math.random() would restyle the text on
// every frame (strobing) and export renders frames out of order, so the whole
// style plan must be a pure function of (seed, unit count).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One style entry per randomizer unit: { sizeMul, color|null, weight|null, italic }.
// The distribution value `t` drives size, weight AND colour eligibility (units in
// the top `coverage` % of t get a colour), so "Every Nth" accents the same units
// across all properties instead of scattering independently.
export function buildTextRandomPlan(cfg, unitCount) {
  const rngA = mulberry32((cfg.seed * 7919 + 1) >>> 0);
  const rngB = mulberry32((cfg.seed * 104729 + 2) >>> 0);
  const phase = mulberry32((cfg.seed + 3) >>> 0)() * Math.PI * 2;
  const styles = [];
  for (let i = 0; i < unitCount; i += 1) {
    let t;
    if (cfg.dist === 'gaussian') t = clamp((rngA() + rngA() + rngA()) / 3, 0, 1);
    else if (cfg.dist === 'nth') t = i % cfg.nth === 0 ? 1 : rngA() * 0.25;
    else if (cfg.dist === 'wave') t = 0.5 + 0.5 * Math.sin((i / Math.max(1, unitCount)) * Math.PI * 3 + phase);
    else t = rngA();
    const style = { sizeMul: 1, color: null, weight: null, italic: false };
    if (cfg.sizeOn) style.sizeMul = (cfg.sizeMin + (cfg.sizeMax - cfg.sizeMin) * t) / 100;
    if (cfg.colorOn && cfg.colors.length) {
      const pick = rngB();
      if (t >= 1 - cfg.coverage / 100) style.color = cfg.colors[Math.floor(pick * cfg.colors.length) % cfg.colors.length];
    }
    if (cfg.weightOn && cfg.weights.length) {
      style.weight = cfg.weights[Math.min(cfg.weights.length - 1, Math.floor(t * cfg.weights.length))];
    }
    if (cfg.italicOn) style.italic = cfg.italicMode === 'all' || rngB() < cfg.italicShare / 100;
    styles.push(style);
  }
  return styles;
}

// Parse a CSS colour (#rgb, #rrggbb, rgb()/rgba()) into {r,g,b}; null on failure.
export function parseCssRgb(color) {
  if (typeof color !== 'string') return null;
  const s = color.trim();
  if (s[0] === '#') {
    let h = s.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length >= 6) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return { r, g, b };
    }
    return null;
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const parts = m[1].split(',').map((x) => parseFloat(x));
    if (parts.length >= 3) return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0 };
  }
  return null;
}

// A unit's base colour for Text Animator paint folding: [r, g, b], or null for a CSS
// gradient — the animator's paint is then an overlay over the untouched gradient.
export function txaBaseRgb(color) {
  if (typeof color !== 'string' || isCssGradient(color)) return null;
  const c = parseCssRgb(color);
  return c ? [c.r, c.g, c.b] : null;
}

export function buildWrappedTokens(line, mode, maxWidth, ctx, letterSpacing) {
  const rawTokens = mode === 'symbols' ? Array.from(line) : (line.match(/\S+\s*/g) || [line]);
  const rows = [];
  let current = [];
  let currentWidth = 0;
  for (const token of rawTokens) {
    const tokenWidth = measureTextWithLetterSpacing(ctx, token, letterSpacing);
    if (current.length > 0 && currentWidth + tokenWidth > maxWidth) {
      rows.push(current);
      current = [token];
      currentWidth = tokenWidth;
    } else {
      current.push(token);
      currentWidth += tokenWidth;
    }
  }
  if (current.length > 0) rows.push(current);
  if (rows.length === 0) rows.push(['']);
  return rows;
}

// ── Static plate paint cache ──
// Text and shape plates used to be cleared, repainted and re-uploaded on EVERY
// frame, whether or not anything about them had changed — a static label cost a
// full Canvas 2D paint plus a GPU upload of a composition-height strip per frame.
// A plate now remembers the signature of the inputs its last paint used
// (`entry.paintSig`) and skips the clear + paint + upload while the signature
// holds — the same discipline as the layer-mask plate's maskGeomHash. The
// signature is the item's paint-relevant fields (memoized on the item object's
// identity, so an unchanged store object costs one WeakMap lookup) joined with
// the per-frame values the painter actually resolves: keyframed paints, raster
// density, plate size, and a clock that is folded in ONLY when something in the
// paint really moves with time. Moving, scaling or rotating a layer never touches
// the signature, so a dragged label rides its cached texture.
export const TEXT_PAINT_KEY_RE = /^(text|motionPath|propertyKeyframes|trimStart)/;

export const SHAPE_PAINT_KEY_RE = /^(shape|border|line|shadow|propertyKeyframes)/;

export const itemPaintSigCache = new WeakMap(); // item -> Map(keyRe -> sig)

export function itemPaintFieldSignature(item, keyRe) {
  if (!item || typeof item !== 'object') return '';
  let byRe = itemPaintSigCache.get(item);
  if (!byRe) { byRe = new Map(); itemPaintSigCache.set(item, byRe); }
  const hit = byRe.get(keyRe);
  if (hit !== undefined) return hit;
  const picked = {};
  for (const k of Object.keys(item)) if (keyRe.test(k)) picked[k] = item[k];
  let sig;
  try { sig = JSON.stringify(picked); } catch { sig = `!${Date.now()}:${Math.random()}`; }
  byRe.set(keyRe, sig);
  return sig;
}

// Scratch canvas for pre-tinting custom SVG silhouettes (so shadow passes and
// the final draw reuse the recolored image without recoloring the shadows).
export let shapeScratchCanvas = null;

export function getShapeScratch(w, h) {
  if (!shapeScratchCanvas) shapeScratchCanvas = document.createElement('canvas');
  shapeScratchCanvas.width = Math.max(1, Math.ceil(w)); // setting size also clears
  shapeScratchCanvas.height = Math.max(1, Math.ceil(h));
  return shapeScratchCanvas;
}

// Scratch canvases for Text Animator units drawn in perspective (textAnimators.js
// warpBegin / warpEnd paint a unit flat into `a` and warp it through `b`).
export let txaWarpCanvases = null;

export const txaScratch = () => txaWarpCanvases || (txaWarpCanvases = { a: document.createElement('canvas'), b: document.createElement('canvas') });

// Vector outline for a path-based shape (null for custom SVG silhouettes).
// `pathPoints` is the resolved unit-space point list for `type === 'path'` — it
// comes from the layout so a keyframed morph can substitute its own snapshot.
export function buildShapePath(item, type, w, h, cx, cy, pathPoints = null, line = null) {
  const p = new Path2D();
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const y0 = cy - h / 2;
  const y1 = cy + h / 2;
  if (type === 'path' || type === 'line') {
    // Unit points scale with the shape's box, so Width/Height keep sizing the path.
    // A line is an open path by definition, whatever the stored flag says.
    const closed = type === 'line' ? false : item.shapePath?.closed !== false;
    // Trim replaces the exact bezier with a sampled polyline, so it is only paid
    // for when a trim is actually cutting something.
    if (isTrimActive(line)) {
      return buildTrimmedOutline(pathPoints, closed, cx, cy, w, h, {
        start: line.trimStart, end: line.trimEnd, offset: line.trimOffset,
      });
    }
    return buildPathOutline(pathPoints, closed, cx, cy, w, h);
  }
  if (type === 'ellipse') {
    p.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (type === 'circle') {
    // Perfect circle — w/h were already set to the diameter from shapeRadius*.
    p.arc(cx, cy, Math.min(w, h) / 2, 0, Math.PI * 2);
  } else if (type === 'arrow') {
    // Right-pointing arrow: shaft + triangular head, both user-tunable (% of box).
    const headPct = clamp(Number(item.shapeArrowHeadPct) || 45, 5, 90);
    const shaftPct = clamp(Number(item.shapeArrowShaftPct) || 42, 2, 100);
    const headLen = (w * headPct) / 100;
    const shaftH = (h * shaftPct) / 100;
    p.moveTo(x0, cy - shaftH / 2);
    p.lineTo(x1 - headLen, cy - shaftH / 2);
    p.lineTo(x1 - headLen, y0);
    p.lineTo(x1, cy);
    p.lineTo(x1 - headLen, y1);
    p.lineTo(x1 - headLen, cy + shaftH / 2);
    p.lineTo(x0, cy + shaftH / 2);
    p.closePath();
  } else if (type === 'triangle') {
    // Direction picks the base edge; the apex slides along the opposite edge
    // (50 = symmetric isosceles, 0/100 = right triangle).
    const dir = item.shapeTriDirection || 'up';
    const apex = clamp(Number.isFinite(Number(item.shapeTriApexPct)) ? Number(item.shapeTriApexPct) : 50, 0, 100) / 100;
    if (dir === 'down') {
      p.moveTo(x0 + w * apex, y1); p.lineTo(x0, y0); p.lineTo(x1, y0);
    } else if (dir === 'left') {
      p.moveTo(x0, y0 + h * apex); p.lineTo(x1, y0); p.lineTo(x1, y1);
    } else if (dir === 'right') {
      p.moveTo(x1, y0 + h * apex); p.lineTo(x0, y1); p.lineTo(x0, y0);
    } else {
      p.moveTo(x0 + w * apex, y0); p.lineTo(x1, y1); p.lineTo(x0, y1);
    }
    p.closePath();
  } else {
    // Rectangle — borderRadius (per-corner honored, px or % of the shorter side)
    // resolved against this box, so a resized rectangle keeps its corners.
    const radii = shapeCornerRadii(item, w, h);
    if (radii.some((r) => r > 0)) p.roundRect(x0, y0, w, h, radii);
    else p.rect(x0, y0, w, h);
  }
  return p;
}

// Draw a shape layer (rectangle/ellipse/arrow/triangle/custom SVG) centered on
// the canvas. Shares the text layer's canvas-texture pipeline, so shapes get
// transforms/filters/keyframes for free through the standard mesh path.
// Border and drop shadows are drawn HERE, following the actual shape outline —
// the shader's box framing is disabled for shape items (see setupMesh). Shadow
// `spread`/`inset` and borders on custom SVGs are not supported for shapes.
// Shared scratch for rasterizing a shape's background (gradient / shader /
// pattern / image) at bbox size, then anchoring it under the shape as a pattern.
export let shapeFillScratch = null;

export function resolveShapeFill(ctx, item, bbox, time, rasterScale = 1, fillOverride = null) {
  const bg = item.shapeBackground;
  // Keyframed gradient paint (`shapeFill` track): wins over the static gradient,
  // keeping the animated-pan box logic so a keyframed gradient can still pan.
  const overrideGradient = fillOverride && isCssGradient(fillOverride) ? fillOverride : null;
  if (!overrideGradient) {
    if (fillOverride) return null; // keyframed solid — caller paints it as `fill`
    if (!bg || bg.type === 'solid' || bg.type === 'transparent') return null; // caller uses solid
  }
  // Gradients resolve synchronously (a CanvasGradient positioned over the shape
  // box) — no async raster, so they show instantly even while paused.
  if (overrideGradient || bg?.type === 'gradient') {
    let box = bbox;
    if (bg?.gradientAnimated) {
      const raw = time * (bg.gradientAnimSpeed ?? 1) * 0.2;
      const f = ((raw % 2) + 2) % 2;
      const phase = f > 1 ? 2 - f : f; // ping-pong 0→1→0
      box = { x: bbox.x - phase * bbox.w, y: bbox.y - phase * bbox.h, w: bbox.w * 2, h: bbox.h * 2 };
    }
    return buildCanvasGradient(ctx, overrideGradient || getBackgroundCSS(bg), box) || null;
  }
  const bw = Math.max(1, Math.round(bbox.w * rasterScale));
  const bh = Math.max(1, Math.round(bbox.h * rasterScale));
  if (!shapeFillScratch) shapeFillScratch = document.createElement('canvas');
  const sc = shapeFillScratch;
  if (sc.width !== bw) sc.width = bw;
  if (sc.height !== bh) sc.height = bh;
  const fctx = sc.getContext('2d');
  // Reuse a renderer for shapes that use identical shader code. Rendering is
  // synchronous, so sharing is safe and avoids consuming one WebGL context per
  // shape (browsers commonly cap the number of live contexts).
  const shaderKey = `shape-shader:${bg.shaderCode || bg.shaderId || 'default'}`;
  drawEditorBackground(fctx, bw, bh, bg, time, { shaderKey, maxDim: 1280 });
  const pattern = ctx.createPattern(sc, 'no-repeat');
  if (!pattern) return null;
  // Anchor the rasterized fill to the shape's logical bounding box. Oversized
  // shapes may use a lower-resolution backing canvas; scale the pattern back to
  // logical composition pixels so the fill still covers the complete geometry.
  try {
    pattern.setTransform(
      new DOMMatrix()
        .translateSelf(bbox.x, bbox.y)
        .scaleSelf(1 / rasterScale, 1 / rasterScale)
    );
  } catch { /* no setTransform */ }
  return pattern;
}

// Dash pattern for the card BORDER, from `borderStyle`. `double` is handled by the
// caller (it needs a second destination-out pass).
export function applyBorderDash(ctx, style, width) {
  if (style === 'dashed') {
    ctx.setLineDash([width * 3, width * 2]);
  } else if (style === 'dotted') {
    ctx.setLineDash([0, width * 2]);
    ctx.lineCap = 'round';
  }
}

// Dash pattern for a Line / un-closed path, from its own `lineDash`. Dots need a
// round cap to be dots at all, so that one overrides the user's cap choice.
export function applyStrokeDash(ctx, dash, width, cap) {
  if (dash === 'dashed') {
    ctx.setLineDash([width * 2.4, width * 1.8]);
  } else if (dash === 'dotted') {
    ctx.setLineDash([0, width * 2]);
    if (cap === 'butt') ctx.lineCap = 'round';
  }
}

// ── Path Stroke engine paint ──
// A stroked shape with any Path Stroke option draws through pathStroke.js (geometry)
// and pathStrokeRenderer.js (one shared WebGL2 context) into a raster-size 2D
// scratch that drawShapeToCanvas then uses as its base. Grow-only scratches: every
// plate shares them, which is safe because the paint is synchronous.
// Returns { canvas, w, h }, `false` when there is nothing to draw, or null when
// WebGL2 is unavailable (the caller falls back to the plain Canvas 2D stroke).
export const strokeScratches = [null, null, null];

// Grow-only while painting; a static plate paints once and is cached, so after a
// few idle seconds the scratches and the GPU targets go back to 1×1 (a 4K plate
// would otherwise pin ~160 MB across five surfaces for the rest of the session).
export const STROKE_RELEASE_MS = 8000;

export let strokeReleaseTimer = null;

export function scheduleStrokeRelease() {
  if (strokeReleaseTimer) clearTimeout(strokeReleaseTimer);
  strokeReleaseTimer = setTimeout(() => {
    strokeReleaseTimer = null;
    for (const c of strokeScratches) if (c) { c.width = 1; c.height = 1; }
    releaseStrokeRenderer();
  }, STROKE_RELEASE_MS);
}

export function strokeScratch(i, w, h) {
  let c = strokeScratches[i];
  if (!c) { c = document.createElement('canvas'); c.width = 1; c.height = 1; strokeScratches[i] = c; }
  if (c.width < w) c.width = w;
  if (c.height < h) c.height = h;
  const g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, w, h);
  return c;
}

export function paintEngineStroke(ctx, item, layout, time, override, fill) {
  const line = layout.line;
  const w = layout.shapeWidth;
  const h = layout.shapeHeight;
  const cx = layout.plateWidth / 2;
  const cy = layout.plateHeight / 2;
  const closed = item.shapeType !== 'line' && item.shapePath?.closed !== false;
  const scene = buildStrokeScene({
    points: layout.pathPoints,
    closed,
    box: { cx, cy, w, h },
    line,
    time,
    px: layout.rasterScale,
    copyTrims: line.copyTrims || null,
  });
  if (!scene.layers.length) return false;
  scheduleStrokeRelease();
  const rw = layout.rasterWidth;
  const rh = layout.rasterHeight;
  const card = line.cards?.paint || null;
  const base = {
    width: rw,
    height: rh,
    px: layout.rasterScale,
    paintCard: card,
    time,
    outlineWidth: line.style === 'outline' ? line.outlineWidth : 0,
  };
  const out = strokeScratch(0, rw, rh);
  const octx = out.getContext('2d');
  const blit = (res, g) => g.drawImage(res.canvas, res.sx, res.sy, res.sw, res.sh, 0, 0, res.sw, res.sh);
  const fillStyle = resolveShapeFill(ctx, item, { x: cx - w / 2, y: cy - h / 2, w, h }, time, layout.rasterScale, override);
  if (!fillStyle) {
    // A solid fill (or a keyframed solid) goes straight to the GPU as the colour.
    const col = parseCssColor(typeof fill === 'string' ? fill : '', { r: 0.545, g: 0.361, b: 0.965, a: 1 });
    const res = renderStrokeScene(scene, { ...base, fillRgb: [col.r, col.g, col.b], fillAlpha: col.a });
    if (!res) return null;
    blit(res, octx);
    return { canvas: out, w: rw, h: rh };
  }
  // Gradient / shader / image fill: layers painted with the shape's fill render as a
  // coverage mask the fill is then painted into; layers with their own colour (copy
  // colours, stamp colour, a gradient along the path) render as colour. Consecutive
  // layers of one kind go through together, and the runs composite in SCENE order —
  // stamps "under the stroke" must stay under it whatever the fill is.
  const layers = scene.layers;
  for (let a = 0; a < layers.length;) {
    const isFill = layers[a].paint.mode === 'fill';
    let b = a + 1;
    while (b < layers.length && (layers[b].paint.mode === 'fill') === isFill) b += 1;
    const run = { layers: layers.slice(a, b) };
    if (!isFill) {
      const res = renderStrokeScene(run, base);
      if (!res) return null;
      blit(res, octx);
    } else {
      const res = renderStrokeScene(run, { ...base, out: 'mask' });
      if (!res) return null;
      // The first run paints straight into the (empty) output; a later one needs
      // its own surface, or source-in would erase what is already there.
      const tmp = a === 0 ? out : strokeScratch(1, rw, rh);
      const tctx = tmp.getContext('2d');
      blit(res, tctx);
      tctx.globalCompositeOperation = 'source-in';
      tctx.setTransform(layout.rasterScale, 0, 0, layout.rasterScale, 0, 0);
      tctx.fillStyle = fillStyle;
      tctx.fillRect(0, 0, layout.plateWidth, layout.plateHeight);
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.globalCompositeOperation = 'source-over';
      if (card?.core) {
        const core = renderStrokeScene(run, { ...base, out: 'core' });
        if (core) {
          const cs = strokeScratch(2, rw, rh);
          const cctx = cs.getContext('2d');
          blit(core, cctx);
          cctx.globalCompositeOperation = 'source-in';
          cctx.fillStyle = card.coreColor;
          cctx.fillRect(0, 0, rw, rh);
          cctx.globalCompositeOperation = 'source-over';
          tctx.drawImage(cs, 0, 0, rw, rh, 0, 0, rw, rh);
        }
      }
      if (tmp !== out) octx.drawImage(tmp, 0, 0, rw, rh, 0, 0, rw, rh);
    }
    a = b;
  }
  return { canvas: out, w: rw, h: rh };
}

export function drawShapeToCanvas(ctx, item, layout, time = 0, fillOverride = null) {
  const type = item.shapeType || 'rectangle';
  const bg = item.shapeBackground;
  // Keyframed paint (`shapeFill` track) overrides the static solid/gradient fill.
  // Shader/pattern/image/transparent backgrounds keep their own pipeline — the
  // stopwatch only rides the solid and gradient rows in the panel, but a stale
  // track must not repaint a background the user has since switched away from.
  const bgType = bg?.type || 'solid';
  const override = typeof fillOverride === 'string' && fillOverride.trim() && (bgType === 'solid' || bgType === 'gradient')
    ? fillOverride.trim()
    : null;
  // Solid fill (backward compatible with shapeFillColor). A richer background
  // config paints vector shapes below; custom-SVG silhouettes use the solid tint.
  const fill = bg?.type === 'transparent'
    ? 'rgba(0,0,0,0)'
    : (override
      ? (isCssGradient(override) ? gradientFirstStopColor(override, '#8b5cf6') : override)
      : ((bg && bg.type === 'solid' && bg.solidColor) || item.shapeFillColor || '#8b5cf6'));
  const w = layout.shapeWidth;
  const h = layout.shapeHeight;
  const cx = layout.plateWidth / 2;
  const cy = layout.plateHeight / 2;
  const isMask = !!item.shapeClipMask;
  // A Line — and any un-closed path — has no interior to fill, so the outline IS
  // the shape: it renders as a stroke with its own width, cap, join and dash.
  const openStroke = isStrokeShape(item);

  // Resolve the base draw: a vector path fill, a pre-tinted custom SVG
  // silhouette, or the full-colour SVG preview produced by Image → Vector.
  let path = null;
  let drawBase = null;
  let engineStroke = null;
  if (type === 'custom' || type === 'vector') {
    const entry = item.shapeSvgUrl ? getShapeSvgImage(item.shapeSvgUrl) : null;
    if (!entry?.ready) return;
    const iw = entry.img.naturalWidth || entry.img.width || 1;
    const ih = entry.img.naturalHeight || entry.img.height || 1;
    const k = Math.min(w / iw, h / ih);
    const dw = Math.max(1, iw * k);
    const dh = Math.max(1, ih * k);
    const scratchWidth = Math.max(1, Math.round(dw * layout.rasterScale));
    const scratchHeight = Math.max(1, Math.round(dh * layout.rasterScale));
    const scratch = getShapeScratch(scratchWidth, scratchHeight);
    const sctx = scratch.getContext('2d');
    sctx.drawImage(entry.img, 0, 0, scratchWidth, scratchHeight);
    if (type === 'custom') {
      sctx.globalCompositeOperation = 'source-in';
      sctx.fillStyle = fill;
      sctx.fillRect(0, 0, scratch.width, scratch.height);
      sctx.globalCompositeOperation = 'source-over';
    }
    drawBase = (c) => c.drawImage(scratch, cx - dw / 2, cy - dh / 2, dw, dh);
  } else {
    // Path Stroke options (taper, dashes, arrowheads, warp, copies…) draw through
    // the GPU stroke engine into a raster-size scratch; the plate takes it like any
    // other base, shadows included. `false` = the trim left nothing to draw; null =
    // no WebGL2, so the plain stroke below still shows the line.
    engineStroke = openStroke && layout.line && strokeEngineActive(layout.line)
      ? paintEngineStroke(ctx, item, layout, time, override, fill)
      : null;
    if (engineStroke === false) return;
  }
  if (engineStroke) {
    const src = engineStroke;
    drawBase = (c) => c.drawImage(src.canvas, 0, 0, src.w, src.h, 0, 0, layout.plateWidth, layout.plateHeight);
  } else if (!drawBase) {
    path = buildShapePath(item, type, w, h, cx, cy, layout.pathPoints, layout.line);
    // No outline at all: fewer than two anchors, or a trim that cut everything away.
    if (!path) return;
    const fillStyle = resolveShapeFill(
      ctx,
      item,
      { x: cx - w / 2, y: cy - h / 2, w, h },
      time,
      layout.rasterScale,
      override
    ) || fill;
    if (openStroke) {
      // The stroke takes the shape's own fill — solid, gradient, shader or image —
      // as its paint, so a line can carry a gradient exactly like a filled shape.
      const line = layout.line || LINE_DEFAULTS;
      if (!(line.width > 0)) return;
      drawBase = (c) => {
        c.save();
        c.strokeStyle = fillStyle;
        c.lineWidth = line.width;
        c.lineJoin = line.join;
        c.lineCap = line.cap;
        applyStrokeDash(c, line.dash, line.width, line.cap);
        c.stroke(path);
        c.restore();
      };
    } else {
      drawBase = (c) => {
        c.fillStyle = fillStyle;
        c.fill(path);
      };
    }
  }

  ctx.save();
  // Drop shadows hugging the silhouette (canvas shadows). CSS order puts the
  // first shadow on top, so draw the list back-to-front under the crisp copy.
  // Skipped in clip-mask mode — soft shadow alpha must not leak into the mask.
  if (!isMask) {
    const shadows = getItemShadows(item).filter(
      (s) => s && !s.inset && (Math.abs(s.x || 0) > 0.01 || Math.abs(s.y || 0) > 0.01 || (s.blur || 0) > 0.01)
    );
    for (let i = Math.min(shadows.length, 4) - 1; i >= 0; i--) {
      const s = shadows[i];
      ctx.save();
      ctx.shadowColor = s.color || 'rgba(0,0,0,0.65)';
      // Canvas shadow metrics are device-space and do not follow the current
      // transform, so scale them explicitly when the backing texture is capped.
      ctx.shadowOffsetX = (s.x || 0) * layout.rasterScale;
      ctx.shadowOffsetY = (s.y || 0) * layout.rasterScale;
      ctx.shadowBlur = Math.max(0, s.blur || 0) * layout.rasterScale;
      drawBase(ctx);
      ctx.restore();
    }
  }
  drawBase(ctx);

  // Border stroked along the outline (not the bounding box). An open path already
  // IS its border — drawBase stroked it — so there is nothing to add here.
  const borderWidth = isMask || openStroke || item.borderStyle === 'none' ? 0 : Number(item.borderWidth) || 0;
  if (borderWidth > 0 && path) {
    const style = item.borderStyle || 'solid';
    ctx.save();
    ctx.strokeStyle = item.borderColor || '#ffffff';
    ctx.lineWidth = borderWidth;
    ctx.lineJoin = 'round';
    applyBorderDash(ctx, style, borderWidth);
    ctx.stroke(path);
    if (style === 'double') {
      // Punch out the middle third of the stroke so two rings remain.
      ctx.setLineDash([]);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = borderWidth / 3;
      ctx.stroke(path);
    }
    ctx.restore();
  }
  ctx.restore();

}

// ── Motion templates and the 2D context transform ──
// A template owns the context it is handed, and several of them call
// ctx.setTransform() ABSOLUTELY (commentCard, glowEdgePill, commentThreadCamera,
// tagWall, kineticPerspectiveType at the time of writing). That silently discards the
// adaptive-density transform, leaving the template drawing at composition scale into a
// denser canvas — the artwork lands in the top-left corner at the wrong size.
//
// Which templates do this cannot be known from the outside, and a hand-kept list would
// rot the moment a template is edited. Instead the FIRST frame each template id really
// draws is drawn at density 1 — always safe — through a proxy that records whether the
// CTM was seized. Templates that leave it alone become eligible for density from the next
// frame; the rest stay at 1 forever. One probe per template id, then zero overhead.
// "Really draws": a lazy template's first frames are its STUB (drawMotionFrame returns
// false while the module loads), which never touches the CTM — judging from that frame
// marked glowEdgePill safe, so a paused full-size retina buffer (density 1.5) put it in
// the top-left corner at 2/3 size while playback (a smaller buffer, density 1) looked fine.
export const motionCtmSafe = new Map();

export function probeMotionCtx(ctx, onSeize) {
  return new Proxy(ctx, {
    get(target, prop) {
      const value = target[prop];
      if (prop === 'setTransform' || prop === 'resetTransform') {
        return (...args) => { onSeize(); return value.apply(target, args); };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}

// ── Density-correct shadows and filters for motion templates ──
// Canvas2D shadow lengths and `filter: blur()` are DEVICE pixels: the CTM does not touch
// them (the text path carries the density by hand — see `ctx.shadowBlur = … *
// layout.rasterScale` in drawTextShadow). A motion plate rasterized at density d therefore
// renders every glow at 1/d of its authored size, so the bloom collapses into a hard bright
// rim clamped to the glyph the moment a camera push-in magnifies the layer. Measured on
// Typewriter Text Frame at 1080p, glow 0.25: the halo reaches 9 logical px at density 1 and
// 3.0 px at density 3 — a different look at every camera distance, and worse at 1080p than
// at 4K because the same on-screen size needs more density to reach it.
//
// Templates cannot correct this themselves: they lay out in composition units and are never
// told the density (that is the whole point of the contract). So the plate context carries
// it for them — one place, and it covers local and future templates too. `pixelScale` stays
// the knob for the OTHER half of the problem, sizing a template's own offscreen buffers.
export const SHADOW_LENGTH_PROPS = new Set(['shadowBlur', 'shadowOffsetX', 'shadowOffsetY']);

export function densityMotionCtx(ctx, density) {
  if (!(density > 1)) return ctx; // the common case pays nothing
  return new Proxy(ctx, {
    get(target, prop) {
      // Report the LOGICAL value so a read-modify-write (`ctx.shadowBlur *= 2`) is stable.
      if (SHADOW_LENGTH_PROPS.has(prop)) return target[prop] / density;
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, prop, value) {
      if (SHADOW_LENGTH_PROPS.has(prop)) {
        const n = Number(value);
        target[prop] = Number.isFinite(n) ? n * density : value;
      } else if (prop === 'filter' && typeof value === 'string' && value.indexOf('px') >= 0) {
        target[prop] = value.replace(/(\d*\.?\d+)px/g, (m, n) => `${Number(n) * density}px`);
      } else {
        target[prop] = value;
      }
      return true;
    },
  });
}

// the moved render code assigns it; an import cannot be assigned
export function setActiveTextRun(value) { activeTextRun = value; }
