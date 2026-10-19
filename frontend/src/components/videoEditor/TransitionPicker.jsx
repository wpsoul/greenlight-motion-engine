import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { TransitionType, LayerTransitionType, TransitionEasing, TransitionOrder, TRANSITION_EASING_OPTIONS, directionalTransition } from './types';
import { applyGsapEasing } from './gsapTransitions';
import {
  ADVANCED_TRANSITION_MAX_DURATION,
  advancedTransitionEdgeMirror,
  advancedTransitionOptionFields,
  getAdvancedTransitionPreset,
  getAdvancedTransitionDefaultDuration,
  getLocalAdvancedTransitionPresets,
  isLocalAdvancedTransitionType,
  onAdvancedTransitionPresetsChanged,
  refreshAdvancedTransitionPackages,
  resolveAdvancedTransitionOptions,
} from './advancedTransitions';
import { importLocalAdvancedTransition } from './localAdvancedTransitions';
import { NumberField, PointField } from './Fields';
import {
  cameraWhipFrame, glowStackFrame, gradientMapFrame, gradientMapPaletteAt, gradientMapPoint, pixelBlocksClocks, zoomRulerFrame,
} from './builtinTransitionPackages';
import {
  TRANSITION_CATEGORIES as TRP_CATEGORIES,
  CROSS_TRANSITION_META as CROSS_META,
  LAYER_TRANSITION_META as LAYER_META,
} from './transitionMetadata';

// Gradient Glow Stack tile: the runtime's own glowStackFrame at tile size. The
// clips meet on the swap line (B behind it, or the cross-fade's mix), then the
// glow is painted as gradients in the frame's travel space — y up, the travel
// along +x, squeezed by `aniso` — onto one offscreen layer that fades as a whole,
// like the shader's flattened stack. `lane` is null for a cross, 'curr' for an
// entrance (nothing → layer) and 'prev' for an exit (layer → nothing).
const GLOW_PHI = (z) => { const c = Math.max(-8, Math.min(8, z)); return 1 / (1 + Math.exp(-1.5976 * c - 0.07056 * c * c * c)); };
let glowTileCanvas = null;
function drawGlowStackTile(ctx, p, w, h, options, lane = null) {
  const F = glowStackFrame(options, p, w, h, 2);
  const toTravel = (c) => {
    c.translate(w / 2, h / 2);
    c.scale(1, -1);
    c.rotate(Math.atan2(F.dir[1], F.dir[0]));
  };
  const drawA = () => { if (lane !== 'curr') drawScene(ctx, 0, 0, w, h, lane === null); };
  const drawB = () => { if (lane !== 'prev') drawScene(ctx, 0, 0, w, h, false); };
  drawA();
  if (F.swapAll >= 0.999) { ctx.clearRect(0, 0, w, h); drawB(); }
  else {
    if (F.swapAll > 0.001) {
      if (lane === 'prev') { ctx.save(); ctx.globalCompositeOperation = 'destination-out'; ctx.globalAlpha = F.swapAll; ctx.fillRect(0, 0, w, h); ctx.restore(); }
      else { ctx.save(); ctx.globalAlpha = F.swapAll; drawB(); ctx.restore(); }
    }
    if (F.swapLine > -1e5) {
      // behind the swap line: B (or, on an exit, nothing)
      ctx.save();
      toTravel(ctx);
      ctx.beginPath();
      ctx.rect(-4 * (w + h), -4 * (w + h), F.swapLine + 4 * (w + h), 8 * (w + h));
      ctx.restore();
      ctx.save();
      ctx.clip();
      ctx.clearRect(0, 0, w, h);
      drawB();
      ctx.restore();
    }
  }
  if (F.stackAlpha <= 0.004) return;
  if (!glowTileCanvas) glowTileCanvas = document.createElement('canvas');
  if (glowTileCanvas.width !== w || glowTileCanvas.height !== h) { glowTileCanvas.width = w; glowTileCanvas.height = h; }
  const g = glowTileCanvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.globalCompositeOperation = options?.blend === 'screen' ? 'screen' : (options?.blend === 'add' ? 'lighter' : 'source-over');
  for (const L of F.layers) {
    const reach = L.R + 3 * L.sigma;
    const cx = L.s * F.aniso;
    const [r, gr, b] = L.color.map((v) => Math.round(v * 255));
    g.save();
    toTravel(g);
    g.scale(1 / F.aniso, 1);
    const grad = F.round >= 0.999
      ? g.createRadialGradient(cx, 0, 0, cx, 0, reach)
      : g.createLinearGradient(cx - reach, 0, cx + reach, 0);
    for (let k = 0; k <= 10; k += 1) {
      const q = k / 10;
      const d = F.round >= 0.999 ? q * reach : Math.abs(q * 2 - 1) * reach;
      grad.addColorStop(q, `rgba(${r},${gr},${b},${GLOW_PHI((L.R - d) / L.sigma).toFixed(3)})`);
    }
    g.fillStyle = grad;
    g.fillRect(cx - reach, -reach, 2 * reach, 2 * reach);
    g.restore();
  }
  ctx.save();
  ctx.globalAlpha = F.stackAlpha;
  ctx.drawImage(glowTileCanvas, 0, 0);
  ctx.restore();
}

// Gradient Map tile: the runtime's own gradientMapFrame and palette, per pixel at
// tile size (84 × 52), the same maths as the shader's. Painted into an offscreen
// canvas and drawn over, so the tile's rounded clip and backdrop still apply.
// `lane` as for the glow stack; the accent overlays are too fine to show here.
const gmTile = { scenes: new Map(), out: null };
function gmScene(isPrev, w, h) {
  const key = `${isPrev ? 'p' : 'c'}${w}x${h}`;
  let data = gmTile.scenes.get(key);
  if (!data) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    drawScene(g, 0, 0, w, h, isPrev);
    data = g.getImageData(0, 0, w, h).data;
    gmTile.scenes.set(key, data);
  }
  return data;
}
function drawGradientMapTile(ctx, p, w, h, options, lane = null) {
  const slot = lane === 'curr' ? 'in' : (lane === 'prev' ? 'out' : 'cross');
  const F = gradientMapFrame(options, p, slot, 2.5);
  const P = gradientMapPoint(options, w, h);
  const A = slot === 'in' ? null : gmScene(slot === 'cross', w, h);
  const B = slot === 'out' ? null : gmScene(false, w, h);
  if (!gmTile.out || gmTile.out.width !== w || gmTile.out.height !== h) {
    gmTile.out = document.createElement('canvas');
    gmTile.out.width = w;
    gmTile.out.height = h;
  }
  const og = gmTile.out.getContext('2d');
  const img = og.createImageData(w, h);
  const out = img.data;
  const s = F.soft;
  const wipe = (key, c) => Math.max(0, Math.min(1, (key - c * (1 + s) + s) / s));
  const at = (x, y, z) => {
    const sx = Math.max(0, Math.min(w - 1, Math.floor((x + 0.5 - w / 2) / z + w / 2)));
    const sy = Math.max(0, Math.min(h - 1, Math.floor((y + 0.5 - h / 2) / z + h / 2)));
    return (sy * w + sx) * 4;
  };
  // one lane: [premultiplied rgb (opaque scene), luma, wipe key] with the map mixed in;
  // dn = distance from the reveal point (0 at it, 1 at the farthest corner); every front
  // travels out from it — the map arrives nearest first (reverse) and leaves nearest first
  const lane1 = (src, i, c, reverse, dn) => {
    const r = src[i] / 255;
    const g = src[i + 1] / 255;
    const b = src[i + 2] / 255;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    const k0 = F.order ? 1 - l : l;
    const k = k0 + ((reverse ? 1 - dn : dn) - k0) * P.amt;
    const x = l * F.bands + F.phase;
    const m = gradientMapPaletteAt(F.stops, x - Math.floor(x));
    const v = wipe(k, reverse ? 1 - c : c);
    return [r + (m[0] - r) * v, g + (m[1] - g) * v, b + (m[2] - b) * v, l, k0 + (dn - k0) * P.amt];
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dn = P.amt > 0 ? Math.min(1, Math.hypot(x + 0.5 - P.x, h - (y + 0.5) - P.y) / P.maxD) : 0;
      const a = A ? lane1(A, at(x, y, F.zoomA), F.mapA, true, dn) : null;
      const b = B ? lane1(B, at(x, y, F.zoomB), F.reveal, false, dn) : null;
      let col;
      if (slot === 'out') {
        const f = wipe(a[4], F.swap);
        col = [a[0] * f, a[1] * f, a[2] * f, f];
      } else {
        const wv = wipe(b[3] + (1 - dn - b[3]) * P.amt, 1 - F.swap);
        col = a
          ? [b[0] * wv + a[0] * (1 - wv), b[1] * wv + a[1] * (1 - wv), b[2] * wv + a[2] * (1 - wv), 1]
          : [b[0] * wv, b[1] * wv, b[2] * wv, wv];
      }
      const o = (y * w + x) * 4;
      const al = col[3];
      out[o] = al > 0 ? Math.round((col[0] / al) * 255) : 0;
      out[o + 1] = al > 0 ? Math.round((col[1] / al) * 255) : 0;
      out[o + 2] = al > 0 ? Math.round((col[2] / al) * 255) : 0;
      out[o + 3] = Math.round(al * 255);
    }
  }
  og.putImageData(img, 0, 0);
  ctx.drawImage(gmTile.out, 0, 0);
}

// Push / Parallax / Wipe (cross) and Slide / Wipe (layer): gsapTransitions'
// applyDirectionalCross / applyDirectionalLayer at tile size. Canvas y runs DOWN,
// so a world "up" is −y here.
const TILE_WAY = {
  left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1],
  leftToRight: [1, 0], rightToLeft: [-1, 0], bottomToTop: [0, -1], topToBottom: [0, 1],
};
const TILE_OUT_SWAP = { up: 'down', down: 'up', bottomToTop: 'topToBottom', topToBottom: 'bottomToTop' };
const tileWay = (kind, rawOptions) => directionalTransition(kind, resolveAdvancedTransitionOptions(kind, rawOptions))?.[1];
// the band a wipe has revealed after `q` of its sweep
function clipWipeBand(ctx, q, w, h, dx, dy) {
  ctx.beginPath();
  ctx.rect(dx < 0 ? w * (1 - q) : 0, dy < 0 ? h * (1 - q) : 0, dx ? w * q : w, dy ? h * q : h);
  ctx.clip();
}
function drawDirectionalCrossTile(ctx, p, w, h, kind, rawOptions) {
  const [dx, dy] = TILE_WAY[tileWay(kind, rawOptions)] || TILE_WAY.left;
  if (kind === 'Wipe') {
    drawScene(ctx, 0, 0, w, h, true);
    ctx.save();
    clipWipeBand(ctx, p, w, h, dx, dy);
    drawScene(ctx, 0, 0, w, h, false);
    ctx.restore();
    return;
  }
  if (kind === 'Push') drawScene(ctx, w * p * dx, h * p * dy, w, h, true);
  else if (dx !== 0) drawScene(ctx, w * 0.6 * p * dx, 0, w, h, true);
  else {
    // Parallax up / down: the outgoing clip sinks back
    const s = 1 - 0.12 * p;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(s, s);
    ctx.translate(-w / 2, -h / 2);
    drawScene(ctx, 0, 0, w, h, true);
    ctx.restore();
  }
  drawScene(ctx, -w * (1 - p) * dx, -h * (1 - p) * dy, w, h, false);
}
function drawDirectionalLayerTile(ctx, p, w, h, kind, rawOptions, lane) {
  const isOut = lane === 'prev';
  const way0 = tileWay(kind, rawOptions);
  const way = isOut && TILE_OUT_SWAP[way0] ? TILE_OUT_SWAP[way0] : way0;
  const q = isOut ? 1 - p : p;   // how present the layer is
  if (kind === 'Wipe') {
    const [dx, dy] = TILE_WAY[way] || TILE_WAY.leftToRight;
    ctx.save();
    clipWipeBand(ctx, q, w, h, dx, dy);
    drawScene(ctx, 0, 0, w, h, false);
    ctx.restore();
    return;
  }
  // Slide Left enters from the left edge; Up rises from the bottom (canvas +y)
  const from = { left: [-1, 0], right: [1, 0], up: [0, 1], down: [0, -1] }[way] || [-1, 0];
  drawScene(ctx, from[0] * w * (1 - q), from[1] * h * (1 - q), w, h, false);
}

const PW = 84;  // preview width — matches the keyframe modal's preset tile
const PH = 52;  // preview height
const CYCLE = 2000; // ms per animation cycle

// Two gradient "clips" for the preview
function drawPrev(ctx, x, y, w, h) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, '#6366f1');
  g.addColorStop(1, '#3b82f6');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

function drawCurr(ctx, x, y, w, h) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, '#f97316');
  g.addColorStop(1, '#ef4444');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

// Draw small "mountain/landscape" silhouette on the clip color for visual richness
function drawScene(ctx, x, y, w, h, isPrev) {
  isPrev ? drawPrev(ctx, x, y, w, h) : drawCurr(ctx, x, y, w, h);
  // Small triangle "mountains"
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x + w * 0.3, y + h * 0.5);
  ctx.lineTo(x + w * 0.5, y + h);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x + w * 0.4, y + h);
  ctx.lineTo(x + w * 0.7, y + h * 0.35);
  ctx.lineTo(x + w, y + h);
  ctx.fill();
  // "Sun" circle
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.beginPath();
  ctx.arc(x + w * (isPrev ? 0.8 : 0.2), y + h * 0.3, w * 0.08, 0, Math.PI * 2);
  ctx.fill();
}

function drawMirroredSceneGrid(ctx, w, h, isPrev) {
  for (let row = -1; row <= 1; row++) {
    for (let col = -1; col <= 1; col++) {
      const flipX = Math.abs(col) % 2 === 1;
      const flipY = Math.abs(row) % 2 === 1;
      ctx.save();
      ctx.translate(col * w + (flipX ? w : 0), row * h + (flipY ? h : 0));
      ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
      drawScene(ctx, 0, 0, w, h, isPrev);
      ctx.restore();
    }
  }
}

/** Same cross-blend the runtime uses, so a tile shows the cut where it happens. */
function trpBlend(p, windowPercent, pointPercent) {
  const w = Math.max(0, windowPercent / 100);
  const c = Math.min(1, Math.max(0, (pointPercent ?? 50) / 100));
  // A zero window is a hard cut on the blend point, same as the runtime.
  if (w <= 0) return p < c ? 0 : 1;
  // Same asymmetric window as the runtime's transitionBlend.
  const back = Math.max(0.01, Math.min(w / 2, c));
  const fwd = Math.max(0.01, Math.min(w / 2, 1 - c));
  const u = p <= c
    ? 0.5 * Math.max(0, (p - (c - back)) / back)
    : 0.5 + 0.5 * Math.min(1, (p - c) / fwd);
  return u * u * (3 - 2 * u);
}

/*
 * The exposure flash over a finished tile.
 *
 * The runtime washes each lane's own pixels; a tile is two lanes drawn into one
 * 2D context with the same wash on both, so one fill over the finished frame is
 * the same picture and does not need the plates kept apart. Like the rest of
 * these previews it rides the tile's simplified peak envelope rather than
 * re-deriving the eased velocity — the point is to show WHERE the blow-out
 * lands, at roughly the strength the slider asks for.
 */
function trpFlash(ctx, p, w, h, options) {
  const strength = (options?.flash ?? 0) / 100;
  if (strength <= 0) return;
  const env = Math.sin(Math.PI * Math.min(1, Math.max(0, p)));
  const alpha = Math.min(1, strength * Math.pow(env, 1.6));
  if (alpha <= 0.004) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = typeof options?.flashColor === 'string' && options.flashColor ? options.flashColor : '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ── Per-transition 2D preview renderers ──
// Each takes (ctx, progress, w, h) where progress is 0→1

const renderers = {
  'Cross Fade': (ctx, p, w, h) => {
    drawScene(ctx, 0, 0, w, h, true);
    ctx.globalAlpha = p;
    drawScene(ctx, 0, 0, w, h, false);
    ctx.globalAlpha = 1;
  },
  // One painter per move, the way from the Direction option.
  Push: (ctx, p, w, h, rawOptions) => drawDirectionalCrossTile(ctx, p, w, h, 'Push', rawOptions),
  Parallax: (ctx, p, w, h, rawOptions) => drawDirectionalCrossTile(ctx, p, w, h, 'Parallax', rawOptions),
  Wipe: (ctx, p, w, h, rawOptions) => drawDirectionalCrossTile(ctx, p, w, h, 'Wipe', rawOptions),
  'Zoom In': (ctx, p, w, h) => {
    ctx.save();
    ctx.globalAlpha = 1 - p;
    const s1 = 1 + p;
    ctx.translate(w / 2, h / 2);
    ctx.scale(s1, s1);
    ctx.translate(-w / 2, -h / 2);
    drawScene(ctx, 0, 0, w, h, true);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = p;
    const s2 = 0.5 + 0.5 * p;
    ctx.translate(w / 2, h / 2);
    ctx.scale(s2, s2);
    ctx.translate(-w / 2, -h / 2);
    drawScene(ctx, 0, 0, w, h, false);
    ctx.restore();
  },
  'Zoom Out': (ctx, p, w, h) => {
    ctx.save();
    ctx.globalAlpha = 1 - p;
    const s1 = 1 - 0.5 * p;
    ctx.translate(w / 2, h / 2);
    ctx.scale(s1, s1);
    ctx.translate(-w / 2, -h / 2);
    drawScene(ctx, 0, 0, w, h, true);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = p;
    const s2 = 1.5 - 0.5 * p;
    ctx.translate(w / 2, h / 2);
    ctx.scale(s2, s2);
    ctx.translate(-w / 2, -h / 2);
    drawScene(ctx, 0, 0, w, h, false);
    ctx.restore();
  },
  // The point-aimed pair. Both accumulate a few offset copies rather than
  // drawing one sharp frame — the blur IS the transition, so a tile without it
  // would advertise the wrong thing.
  'Advanced Zoom': (ctx, p, w, h, rawOptions) => {
    const options = resolveAdvancedTransitionOptions('Advanced Zoom', rawOptions);
    const cx = ((options?.point?.x ?? 50) / 100) * w;
    const cy = ((options?.point?.y ?? 50) / 100) * h;
    const span = 0.55 * ((options?.zoomStrength ?? 100) / 100);
    const growth = options?.direction === 'out' ? 1 / (1 + span) : 1 + span;
    const blur = Math.sin(Math.PI * p) * ((options?.blurStrength ?? 0) / 100);
    const mix = trpBlend(p, options?.blendWindow ?? 26, options?.blendPoint);
    // Same one-step currency as the zoom: 'prev' turns 0 → spin, 'curr' −spin → 0,
    // about the same point they scale about (canvas y is down, so a positive
    // angle is clockwise here exactly as it is in the shader).
    const spin = ((options?.rotation ?? 0) * Math.PI) / 180;

    const drawLayer = (isPrev, alpha, scale, roll) => {
      if (alpha <= 0.004) return;
      const tile = advancedTransitionEdgeMirror(options, isPrev ? 'prev' : 'curr');
      const samples = blur > 0.01 ? 7 : 1;
      for (let i = 0; i < samples; i++) {
        const t = samples === 1 ? 0 : i / (samples - 1) - 0.5;
        const s = scale * (1 + t * blur);
        ctx.save();
        ctx.globalAlpha = alpha / samples;
        ctx.translate(cx, cy);
        ctx.rotate(roll);
        ctx.scale(s, s);
        ctx.translate(-cx, -cy);
        if (tile && s < 1) drawMirroredSceneGrid(ctx, w, h, isPrev);
        else drawScene(ctx, 0, 0, w, h, isPrev);
        ctx.restore();
      }
    };
    drawLayer(true, 1 - mix, Math.pow(growth, p), spin * p);
    drawLayer(false, mix, Math.pow(growth, p - 1), spin * (p - 1));
    trpFlash(ctx, p, w, h, options);
  },
  // `lane` (layer entrance 'curr' / exit 'prev'): one lane over nothing, with the
  // runtime's one-sided modes — the blocks bring the layer in (Appear) or take
  // it away (Disappear); a colour wipe lands on the layer, then it arrives/goes.
  'Pixel Blocks': (ctx, p, w, h, rawOptions, lane = null) => {
    const o = resolveAdvancedTransitionOptions('Pixel Blocks', rawOptions) || {};
    // A coarse read of the runtime's cell mask: the same direction field, band
    // jitter and cell fade, one pass (no residual level), hard cells. Enough to
    // show WHERE the front is and which way it travels.
    const cols = 20;
    const cw = w / cols;
    const ch = cw / Math.max(0.2, o.cellAspect ?? 1);
    const rows = Math.ceil(h / ch);
    const hash = (x, y) => { let a = ((x * 123.34 + y * 456.21) % 1 + 1) % 1; a = (a * (a + 45.32)) % 1; return ((a * 991.7) % 1 + 1) % 1; };
    const dirs = { l2r: 0, r2l: 180, t2b: 90, b2t: 270, diagDR: 45, diagUR: 315 };
    const angle = ((o.direction === 'angle' ? (o.angle ?? 30) : (dirs[o.direction] ?? 0)) * Math.PI) / 180;
    const px = ((o.point?.x ?? 50) / 100) * w;
    const py = ((o.point?.y ?? 50) / 100) * h;
    const far = Math.hypot(Math.max(px, w - px), Math.max(py, h - py));
    const band = o.direction === 'random' ? 0 : (o.band ?? 25) / 100;
    const fade = Math.max(1e-3, (o.fade ?? 26) / 100);
    const seed = o.seed ?? 7;
    const coord = (cx, cy, phase2) => {
      if (o.direction === 'random') return hash(cx + seed * 1.37 + (phase2 ? 101 : 0) + 9.9, cy + 9.9);
      if (o.direction === 'radialOut' || o.direction === 'radialIn') {
        const d = Math.hypot(cx - px, cy - py) / far;
        return o.direction === 'radialOut' ? d : 1 - d;
      }
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);   // canvas y is DOWN: 90° = top → bottom
      const d = (cx - w / 2) * dx + (cy - h / 2) * dy;
      return d / ((Math.abs(dx) * w + Math.abs(dy) * h) / 2) * 0.5 + 0.5;
    };
    const cellOn = (t, phase2) => {
      const f = -band * 0.5 + t * (1 + band + (o.lag ?? 20) / 100 + fade);
      const cells = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          let d = coord((c + 0.5) * cw, (r + 0.5) * ch, phase2);
          if (phase2 && o.direction2 === 'reverse') d = 1 - d;
          const rj = hash(c + seed + 3.3 + (phase2 ? 101 : 0), r + 3.3);
          const start = d + (rj - 0.5) * band;
          if ((f - start) / fade >= 0.5) cells.push([c * cw, r * ch]);
        }
      }
      return cells;
    };
    const clipCells = (cells, paint) => {
      if (!cells.length) return;
      ctx.save();
      ctx.beginPath();
      for (const [x, y] of cells) ctx.rect(x, y, cw + 0.5, ch + 0.5);
      ctx.clip();
      paint();
      ctx.restore();
    };
    const { mode: crossMode, t1, t2 } = pixelBlocksClocks(o, p);
    const mode = lane && crossMode !== 3 ? (lane === 'prev' ? 2 : 1) : crossMode;
    const colour = typeof o.colour === 'string' && o.colour ? o.colour : '#ffffff';
    const remaining = (cells) => {
      const gone = new Set(cells.map(([x, y]) => `${x},${y}`));
      const keep = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const k = `${c * cw},${r * ch}`; if (!gone.has(k)) keep.push([c * cw, r * ch]); }
      return keep;
    };
    if (mode === 2) {
      // Disappear: A's cells fall away to show B underneath (one lane: nothing).
      if (!lane) drawScene(ctx, 0, 0, w, h, false);
      clipCells(remaining(cellOn(t1, false)), () => drawScene(ctx, 0, 0, w, h, !lane));
      return;
    }
    if (mode === 3 && lane === 'prev') {
      // An exit's colour wipe: colour lands on the layer, then its cells clear.
      clipCells(remaining(cellOn(t2, true)), () => {
        drawScene(ctx, 0, 0, w, h, false);
        clipCells(cellOn(t1, false), () => { ctx.fillStyle = colour; ctx.fillRect(0, 0, w, h); });
      });
      return;
    }
    if (!lane) drawScene(ctx, 0, 0, w, h, true);
    if (mode === 3) {
      clipCells(cellOn(t1, false), () => { ctx.fillStyle = colour; ctx.fillRect(0, 0, w, h); });
      clipCells(cellOn(t2, true), () => drawScene(ctx, 0, 0, w, h, false));
      return;
    }
    clipCells(cellOn(t1, false), () => drawScene(ctx, 0, 0, w, h, false));
  },
  // A coarse 2D replica of the whip: the plate centre's displacement for a pan
  // of `ang` is f·tan(ang) in half-width units, which is the same number the
  // shader's warp puts the frame centre at. It shares cameraWhipFrame with the
  // runtime, so the tile and the transition cannot disagree about WHEN.
  'Camera Whip': (ctx, p, w, h, rawOptions) => {
    const o = resolveAdvancedTransitionOptions('Camera Whip', rawOptions) || {};
    const ar = h > 0 ? w / h : 16 / 9;
    const v = cameraWhipFrame(o, p, ar, 0.5);
    const a = ((o.axis ?? 225) * Math.PI) / 180;
    const ux = Math.cos(a);
    const uy = -Math.sin(a);                       // canvas y runs down
    const shift = (ang) => -v.focal * Math.tan(Math.max(-1.4, Math.min(1.4, ang))) * (w / 2);

    const drawLayer = (isPrev, alpha, rot) => {
      if (alpha <= 0.004) return;
      const ang = isPrev ? v.rotA[0] : v.rotB[0];
      const sweep = isPrev ? v.sweepA[0] : v.sweepB[0];
      const smear = shift(ang + sweep / 2) - shift(ang - sweep / 2);
      const samples = Math.abs(smear) > 1.2 ? 9 : 1;
      for (let i = 0; i < samples; i += 1) {
        const t = samples === 1 ? 0 : i / (samples - 1) - 0.5;
        const d = shift(ang) + t * smear;
        ctx.save();
        ctx.globalAlpha = alpha / samples;
        ctx.translate(w / 2, h / 2);
        ctx.rotate(rot);
        ctx.translate(-w / 2 + ux * d, -h / 2 + uy * d);
        drawScene(ctx, 0, 0, w, h, isPrev);
        ctx.restore();
      }
    };
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, w, h);
    drawLayer(true, 1 - v.mix, v.rotA[2]);
    drawLayer(false, v.mix, v.rotB[2]);
    if (v.flash > 0.004) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, v.flash);
      ctx.fillStyle = typeof o.flashTint === 'string' && o.flashTint ? o.flashTint : '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  },
  'Circular Wipe': (ctx, p, w, h, rawOptions) => {
    const options = resolveAdvancedTransitionOptions('Circular Wipe', rawOptions) || {};
    const cx = ((options.point?.x ?? 0) / 100) * w;
    const cy = ((options.point?.y ?? 42) / 100) * h;
    const invert = !!options.invert;
    // Inverted, the circle closes onto the point: the OUTGOING clip is what
    // survives inside it, so both the fill and the ramp run the other way.
    const prog = invert ? 1 - p : p;
    const maxR = Math.hypot(Math.max(Math.abs(cx), Math.abs(w - cx)), Math.max(Math.abs(cy), Math.abs(h - cy)));
    const feather = ((options.feather ?? 17) / 100) * maxR;
    const radius = prog * (maxR + 2 * feather) - feather;

    drawScene(ctx, 0, 0, w, h, !invert);
    if (radius > 0.5) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.clip();
      drawScene(ctx, 0, 0, w, h, invert);
      ctx.restore();
    }
    const alive = Math.min(1, prog / 0.18) * Math.min(1, (1 - prog) / 0.18);
    if (options.beam !== false && radius > 0.5 && alive > 0.004) {
      const stops = [options.beamColor1, options.beamColor2, options.beamColor3, options.beamColor4]
        .map((color, i) => (typeof color === 'string' && color ? color : ['#38d4f0', '#7b5cff', '#ff4fa3', '#ffc94d'][i]));
      const gradient = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
      stops.forEach((color, i) => gradient.addColorStop(i / (stops.length - 1), color));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alive;
      ctx.strokeStyle = gradient;
      ctx.lineWidth = Math.max(1.5, ((options.beamWidth ?? 12) / 100) * maxR);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  },
  'Gradient Glow Stack': (ctx, p, w, h, rawOptions) => {
    drawGlowStackTile(ctx, p, w, h, resolveAdvancedTransitionOptions('Gradient Glow Stack', rawOptions) || {});
  },
  'Gradient Map': (ctx, p, w, h, rawOptions) => {
    drawGradientMapTile(ctx, p, w, h, resolveAdvancedTransitionOptions('Gradient Map', rawOptions) || {});
  },
  'Zoom Ruler': (ctx, p, w, h, rawOptions) => {
    const o = resolveAdvancedTransitionOptions('Zoom Ruler', rawOptions) || {};
    // The runtime's own box maths (y up) at tile size; the tile draws y down.
    const s = zoomRulerFrame(o, p, w, h);
    const cy = h - s.cy;
    drawScene(ctx, 0, 0, w, h, true);
    if (s.fade > 0 && s.hx > 0.5) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(s.cx - s.hx, cy - s.hy, s.hx * 2, s.hy * 2);
      ctx.clip();
      ctx.globalAlpha = s.fade;
      // A push-in below 1:1 would leave a gap at the tile's edge; the runtime
      // mirror-tiles there, the tile just holds 1:1.
      const z = Math.max(1, s.zoomB);
      ctx.translate(s.cx, cy);
      ctx.scale(z, z);
      ctx.translate(-s.cx, -cy);
      drawScene(ctx, 0, 0, w, h, false);
      ctx.restore();
    }
    if (o.rulers !== false && s.fade > 0 && p < 1) {
      // Tile-sized strokes: the authored 1080p pixel sizes vanish at thumbnail scale.
      const x0 = Math.round(s.cx - s.rx) + 0.5;
      const x1 = Math.round(s.cx + s.rx) + 0.5;
      const y0 = Math.round(cy - s.ry) + 0.5;
      const y1 = Math.round(cy + s.ry) + 0.5;
      ctx.save();
      ctx.globalAlpha = s.fade * Math.max(0, Math.min(1, (o.lineOpacity ?? 90) / 100));
      ctx.strokeStyle = o.lineColor || '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const x of [x0, x1]) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      for (const y of [y0, y1]) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();
      if (o.markShape !== 'none') {
        ctx.globalAlpha = s.fade;
        ctx.fillStyle = o.markColor || '#ffffff';
        for (const x of [x0, x1]) for (const y of [y0, y1]) ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
      }
      ctx.restore();
    }
  },
  'Advanced Movement': (ctx, p, w, h, rawOptions) => {
    const options = resolveAdvancedTransitionOptions('Advanced Movement', rawOptions);
    const ar = h > 0 ? w / h : 1;
    let dx = ((options?.point?.x ?? 92) / 100 - 0.5) * ar;
    let dy = ((options?.point?.y ?? 50) / 100 - 0.5);
    if (Math.hypot(dx, dy) < 1e-4) { dx = 1; dy = 0; }
    const norm = Math.hypot(dx, dy) || 1;
    const sign = options?.direction === 'from' ? -1 : 1;
    const ux = (dx / norm) * sign;
    const uy = (dy / norm) * sign;
    const clearance = Math.abs(ux) * ar + Math.abs(uy);
    const travel = clearance * ((options?.travelStrength ?? 100) / 100);
    const blur = Math.sin(Math.PI * p) * ((options?.blurStrength ?? 0) / 100) * 0.5;
    const mix = trpBlend(p, options?.blendWindow ?? 18, options?.blendPoint);
    const squeeze = 1 - ((options?.squeeze ?? 8) / 100) * Math.sin(Math.PI * p);

    const drawLayer = (isPrev, alpha, distance) => {
      if (alpha <= 0.004) return;
      const tile = advancedTransitionEdgeMirror(options, isPrev ? 'prev' : 'curr');
      const samples = blur > 0.004 ? 7 : 1;
      for (let i = 0; i < samples; i++) {
        const t = samples === 1 ? 0 : i / (samples - 1) - 0.5;
        const d = distance + t * blur;
        ctx.save();
        ctx.globalAlpha = alpha / samples;
        ctx.translate((ux * d * w) / ar, uy * d * h);
        ctx.translate(w / 2, h / 2);
        ctx.scale(squeeze, squeeze);
        ctx.translate(-w / 2, -h / 2);
        if (tile) drawMirroredSceneGrid(ctx, w, h, isPrev);
        else drawScene(ctx, 0, 0, w, h, isPrev);
        ctx.restore();
      }
    };
    drawLayer(true, 1 - mix, travel * p);
    drawLayer(false, mix, travel * (p - 1));
    trpFlash(ctx, p, w, h, options);
  },
  '3D Carousel': (ctx, p, w, h) => {
    const e = p * p * (3 - 2 * p);
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, w, h);
    const drawPanel = (isPrev, t) => {
      const ang = t * Math.PI / 2 * 0.9;
      const off = Math.sin(ang) * w * 0.75;
      const squeeze = Math.max(Math.abs(Math.cos(ang)), 0.05);
      ctx.save();
      ctx.translate(w / 2 + off, h / 2);
      ctx.transform(squeeze, -0.18 * Math.sin(ang), 0, 1, 0, 0);
      ctx.translate(-w / 2, -h / 2);
      drawScene(ctx, 0, 0, w, h, isPrev);
      ctx.fillStyle = `rgba(0,0,0,${0.55 * Math.abs(Math.sin(ang))})`;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    };
    // far panel first: the one swung further from the front
    const panels = [[true, e], [false, e - 1]].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    for (const [isPrev, t] of panels) drawPanel(isPrev, t);
  },
  'Louver Flip': (ctx, p, w, h) => {
    const N = 7, st = 0.07;
    for (let i = 0; i < N; i++) {
      const s = Math.min(1, Math.max(0, p * (1 + (N - 1) * st) - i * st));
      const e = s * s * (3 - 2 * s);
      const co = Math.cos(e * Math.PI);
      const ac = Math.max(Math.abs(co), 0.04);
      const y = (i / N) * h;
      const sh = h / N;
      const cy = y + sh / 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y, w, sh);
      ctx.clip();
      ctx.translate(0, cy);
      ctx.scale(1, ac);
      ctx.translate(0, -cy);
      drawScene(ctx, 0, 0, w, h, co > 0);
      ctx.restore();
      ctx.fillStyle = `rgba(0,0,0,${0.6 * (1 - ac)})`;
      ctx.fillRect(0, y, w, sh);
    }
  },
  'Scale Swap': (ctx, p, w, h) => {
    const scaleMin = 0.25;
    const moveAmount = 0.4;
    ctx.save();
    ctx.globalAlpha = 1 - p * 0.5;
    ctx.translate(w / 2, h / 2);
    ctx.scale(1 + (scaleMin - 1) * p, 1 + (scaleMin - 1) * p);
    ctx.translate(-w / 2, -h / 2);
    ctx.translate(moveAmount * w * p, 0);
    drawScene(ctx, 0, 0, w, h, true);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = p;
    const currScale = scaleMin + (1 - scaleMin) * p;
    ctx.translate(w / 2, h / 2);
    ctx.scale(currScale, currScale);
    ctx.translate(-w / 2, -h / 2);
    ctx.translate(-moveAmount * w * (1 - p), 0);
    drawScene(ctx, 0, 0, w, h, false);
    ctx.restore();
  },
  'Side by Side': (ctx, p, w, h) => {
    const scaleMin = 0.5;
    const totalSlide = 0.85;
    const p1 = 1 / 3;
    const p2 = 2 / 3;
    const smooth = (t) => t * t * (3 - 2 * t); // per-phase easing in preview

    const linear = p;
    let e1; let e2; let e3;
    if (linear <= p1) {
      e1 = p1 > 0 ? smooth(linear / p1) : 1;
      e2 = 0;
      e3 = 0;
    } else if (linear <= p2) {
      e1 = 1;
      e2 = smooth((linear - p1) / (p2 - p1));
      e3 = 0;
    } else {
      e1 = 1;
      e2 = 1;
      e3 = (1 - p2) > 0 ? smooth((linear - p2) / (1 - p2)) : 1;
    }

    const prevScale = e1 < 1 ? 1 + (scaleMin - 1) * e1 : scaleMin;
    const prevPosX = e2 * totalSlide * w;
    ctx.save();
    ctx.globalAlpha = linear <= p2 ? 1 : 0;
    ctx.translate(w / 2, h / 2);
    ctx.scale(prevScale, prevScale);
    ctx.translate(-w / 2, -h / 2);
    ctx.translate(prevPosX, 0);
    drawScene(ctx, 0, 0, w, h, true);
    ctx.restore();

    const currScale = e2 < 1 ? scaleMin : scaleMin + (1 - scaleMin) * e3;
    const currPosX = e2 < 1 ? -totalSlide * w + e2 * totalSlide * w : 0;
    ctx.save();
    ctx.globalAlpha = linear <= p1 ? 0 : 1;
    ctx.translate(w / 2, h / 2);
    ctx.scale(currScale, currScale);
    ctx.translate(-w / 2, -h / 2);
    ctx.translate(currPosX, 0);
    drawScene(ctx, 0, 0, w, h, false);
    ctx.restore();
  },
  'Dip to Black': (ctx, p, w, h) => {
    if (p < 0.5) {
      ctx.globalAlpha = 1 - p * 2;
      drawScene(ctx, 0, 0, w, h, true);
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = (p - 0.5) * 2;
      drawScene(ctx, 0, 0, w, h, false);
      ctx.globalAlpha = 1;
    }
  },
  'Radial Wipe': (ctx, p, w, h) => {
    drawScene(ctx, 0, 0, w, h, true);
    ctx.save();
    ctx.beginPath();
    const maxR = Math.sqrt((w / 2) ** 2 + (h / 2) ** 2);
    ctx.arc(w / 2, h / 2, maxR * p, 0, Math.PI * 2);
    ctx.clip();
    drawScene(ctx, 0, 0, w, h, false);
    ctx.restore();
  },
};

// ── Layer transition renderers (entrance: 0→1 shows curr appearing) ──

const layerRenderers = {
  'Fade': (ctx, p, w, h) => {
    ctx.globalAlpha = p;
    drawScene(ctx, 0, 0, w, h, false);
    ctx.globalAlpha = 1;
  },
  // One lane of Slide / Wipe: the entrance plays forward, the exit as gsapTransitions does it.
  Slide: (ctx, p, w, h, rawOptions, lane = 'curr') => drawDirectionalLayerTile(ctx, p, w, h, 'Slide', rawOptions, lane),
  Wipe: (ctx, p, w, h, rawOptions, lane = 'curr') => drawDirectionalLayerTile(ctx, p, w, h, 'Wipe', rawOptions, lane),
  'Zoom In': (ctx, p, w, h) => {
    ctx.save();
    ctx.globalAlpha = p;
    const s = 0.5 + 0.5 * p;
    ctx.translate(w / 2, h / 2);
    ctx.scale(s, s);
    ctx.translate(-w / 2, -h / 2);
    drawScene(ctx, 0, 0, w, h, false);
    ctx.restore();
  },
  'Zoom Out': (ctx, p, w, h) => {
    ctx.save();
    ctx.globalAlpha = p;
    const s = 1.5 - 0.5 * p;
    ctx.translate(w / 2, h / 2);
    ctx.scale(s, s);
    ctx.translate(-w / 2, -h / 2);
    drawScene(ctx, 0, 0, w, h, false);
    ctx.restore();
  },
  'Dip to Black': (ctx, p, w, h) => {
    ctx.globalAlpha = p;
    drawScene(ctx, 0, 0, w, h, false);
    ctx.globalAlpha = 1;
  },
  'Radial Wipe': (ctx, p, w, h) => {
    ctx.save();
    ctx.beginPath();
    const maxR = Math.sqrt((w / 2) ** 2 + (h / 2) ** 2);
    ctx.arc(w / 2, h / 2, maxR * p, 0, Math.PI * 2);
    ctx.clip();
    drawScene(ctx, 0, 0, w, h, false);
    ctx.restore();
  },

  /* ── The advanced trio, one lane ─────────────────────────────────────────
   *
   * These take a `lane` the others do not: an entrance draws the incoming lane
   * of the cross transition and an exit the outgoing one, both at FORWARD
   * progress. Playing the entrance backwards (what pickRenderer does for every
   * other type) would show the wrong lane, which is why they are listed in
   * LANE_RENDERERS and get progress straight through in both directions.
   */
  'Advanced Zoom': (ctx, p, w, h, rawOptions, lane = 'curr') => {
    const options = resolveAdvancedTransitionOptions('Advanced Zoom', rawOptions);
    const cx = ((options?.point?.x ?? 50) / 100) * w;
    const cy = ((options?.point?.y ?? 50) / 100) * h;
    const span = 0.55 * ((options?.zoomStrength ?? 100) / 100);
    const growth = options?.direction === 'out' ? 1 / (1 + span) : 1 + span;
    const blur = Math.sin(Math.PI * p) * ((options?.blurStrength ?? 0) / 100);
    const mix = trpBlend(p, options?.blendWindow ?? 26, options?.blendPoint);
    const tile = advancedTransitionEdgeMirror(options, lane);
    const alpha = lane === 'prev' ? 1 - mix : mix;
    const step = lane === 'prev' ? p : p - 1;
    const scale = Math.pow(growth, step);
    const roll = ((options?.rotation ?? 0) * Math.PI * step) / 180;
    if (alpha <= 0.004) return;
    const samples = blur > 0.01 ? 7 : 1;
    for (let i = 0; i < samples; i++) {
      const t = samples === 1 ? 0 : i / (samples - 1) - 0.5;
      const s = scale * (1 + t * blur);
      ctx.save();
      ctx.globalAlpha = alpha / samples;
      ctx.translate(cx, cy);
      ctx.rotate(roll);
      ctx.scale(s, s);
      ctx.translate(-cx, -cy);
      if (tile && s < 1) drawMirroredSceneGrid(ctx, w, h, false);
      else drawScene(ctx, 0, 0, w, h, false);
      ctx.restore();
    }
    trpFlash(ctx, p, w, h, options);
  },
  'Advanced Movement': (ctx, p, w, h, rawOptions, lane = 'curr') => {
    const options = resolveAdvancedTransitionOptions('Advanced Movement', rawOptions);
    const ar = h > 0 ? w / h : 1;
    let dx = ((options?.point?.x ?? 92) / 100 - 0.5) * ar;
    let dy = ((options?.point?.y ?? 50) / 100 - 0.5);
    if (Math.hypot(dx, dy) < 1e-4) { dx = 1; dy = 0; }
    const norm = Math.hypot(dx, dy) || 1;
    const sign = options?.direction === 'from' ? -1 : 1;
    const ux = (dx / norm) * sign;
    const uy = (dy / norm) * sign;
    const clearance = Math.abs(ux) * ar + Math.abs(uy);
    const travel = clearance * ((options?.travelStrength ?? 100) / 100);
    const blur = Math.sin(Math.PI * p) * ((options?.blurStrength ?? 0) / 100) * 0.5;
    const mix = trpBlend(p, options?.blendWindow ?? 18, options?.blendPoint);
    const tile = advancedTransitionEdgeMirror(options, lane);
    const squeeze = 1 - ((options?.squeeze ?? 8) / 100) * Math.sin(Math.PI * p);
    const alpha = lane === 'prev' ? 1 - mix : mix;
    const distance = travel * (lane === 'prev' ? p : p - 1);
    if (alpha <= 0.004) return;
    const samples = blur > 0.004 ? 7 : 1;
    for (let i = 0; i < samples; i++) {
      const t = samples === 1 ? 0 : i / (samples - 1) - 0.5;
      const d = distance + t * blur;
      ctx.save();
      ctx.globalAlpha = alpha / samples;
      ctx.translate((ux * d * w) / ar, uy * d * h);
      ctx.translate(w / 2, h / 2);
      ctx.scale(squeeze, squeeze);
      ctx.translate(-w / 2, -h / 2);
      if (tile) drawMirroredSceneGrid(ctx, w, h, false);
      else drawScene(ctx, 0, 0, w, h, false);
      ctx.restore();
    }
    trpFlash(ctx, p, w, h, options);
  },
  // One panel of the carousel. The other slot is empty, so unlike the cross
  // tile there is no backdrop and no second scene — the layer simply turns in
  // over whatever is underneath it.
  '3D Carousel': (ctx, p, w, h, rawOptions, lane = 'curr') => {
    const e = p * p * (3 - 2 * p);
    const t = lane === 'prev' ? e : e - 1;
    const ang = t * Math.PI / 2 * 0.9;
    const off = Math.sin(ang) * w * 0.75;
    const squeeze = Math.max(Math.abs(Math.cos(ang)), 0.05);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, squeeze * 1.6));
    ctx.translate(w / 2 + off, h / 2);
    ctx.scale(squeeze, 1);
    ctx.translate(-w / 2, -h / 2);
    drawScene(ctx, 0, 0, w, h, false);
    ctx.restore();
  },
  // One plate of the whip, over whatever is underneath — the runtime's empty
  // lane draws nothing, so neither does the tile: no backdrop, no second scene.
  // Same cameraWhipFrame clock as the cross tile and the shader, and the flash
  // lifts only the plate's own footprint, as the shader does one-sided.
  'Camera Whip': (ctx, p, w, h, rawOptions, lane = 'curr') => {
    const o = resolveAdvancedTransitionOptions('Camera Whip', rawOptions) || {};
    const ar = h > 0 ? w / h : 16 / 9;
    const v = cameraWhipFrame(o, p, ar, 0.5);
    const isPrev = lane === 'prev';
    const alpha = isPrev ? 1 - v.mix : v.mix;
    if (alpha <= 0.004) return;
    const a = ((o.axis ?? 225) * Math.PI) / 180;
    const ux = Math.cos(a);
    const uy = -Math.sin(a);                       // canvas y runs down
    const shift = (ang) => -v.focal * Math.tan(Math.max(-1.4, Math.min(1.4, ang))) * (w / 2);
    const ang = isPrev ? v.rotA[0] : v.rotB[0];
    const sweep = isPrev ? v.sweepA[0] : v.sweepB[0];
    const rot = isPrev ? v.rotA[2] : v.rotB[2];
    const smear = shift(ang + sweep / 2) - shift(ang - sweep / 2);
    const samples = Math.abs(smear) > 1.2 ? 9 : 1;
    const flashTint = typeof o.flashTint === 'string' && o.flashTint ? o.flashTint : '#ffffff';
    for (let i = 0; i < samples; i += 1) {
      const t = samples === 1 ? 0 : i / (samples - 1) - 0.5;
      const d = shift(ang) + t * smear;
      ctx.save();
      ctx.globalAlpha = alpha / samples;
      ctx.translate(w / 2, h / 2);
      ctx.rotate(rot);
      ctx.translate(-w / 2 + ux * d, -h / 2 + uy * d);
      drawScene(ctx, 0, 0, w, h, false);
      if (v.flash > 0.004) {
        ctx.globalAlpha = (alpha / samples) * Math.min(1, v.flash);
        ctx.fillStyle = flashTint;
        ctx.fillRect(0, 0, w, h);
      }
      ctx.restore();
    }
  },
  // One lane of the stack: the glow sweeps over what is under the layer, and the
  // layer appears behind it (entrance) or goes with it (exit).
  'Gradient Glow Stack': (ctx, p, w, h, rawOptions, lane = 'curr') => {
    drawGlowStackTile(ctx, p, w, h, resolveAdvancedTransitionOptions('Gradient Glow Stack', rawOptions) || {}, lane);
  },
  // One lane: the entrance's map arrives over what is under the layer and
  // dissolves into it; the exit's map takes the layer away, darkest first.
  'Gradient Map': (ctx, p, w, h, rawOptions, lane = 'curr') => {
    drawGradientMapTile(ctx, p, w, h, resolveAdvancedTransitionOptions('Gradient Map', rawOptions) || {}, lane);
  },
  // One lane: the blocks bring the layer in over what is under it, or take it away.
  'Pixel Blocks': (ctx, p, w, h, rawOptions, lane = 'curr') => {
    renderers['Pixel Blocks'](ctx, p, w, h, rawOptions, lane);
  },
};

// Layer transitions whose renderer takes an explicit lane instead of being
// played in reverse for the OUT preview.
const LANE_RENDERERS = new Set(['Advanced Zoom', 'Advanced Movement', '3D Carousel', 'Camera Whip', 'Gradient Glow Stack', 'Gradient Map', 'Pixel Blocks', 'Slide', 'Wipe']);

// ── Custom transition renderer factory ──

function createCustomRenderer(cfg, isLayer) {
  const readLayer = (raw, fallback = {}) => ({
    moveX: Number.isFinite(raw?.moveX) ? raw.moveX : (fallback.moveX ?? 0),
    moveY: Number.isFinite(raw?.moveY) ? raw.moveY : (fallback.moveY ?? 0),
    scaleFrom: Number.isFinite(raw?.scaleFrom) ? raw.scaleFrom : (fallback.scaleFrom ?? 1),
    opacityFrom: Number.isFinite(raw?.opacityFrom) ? raw.opacityFrom : (fallback.opacityFrom ?? 0),
    rotateX: Number.isFinite(raw?.rotateX) ? raw.rotateX : (fallback.rotateX ?? 0),
    rotateY: Number.isFinite(raw?.rotateY) ? raw.rotateY : (fallback.rotateY ?? 0),
    rotation: Number.isFinite(raw?.rotation) ? raw.rotation : (fallback.rotation ?? 0),
  });

  return (ctx, p, w, h) => {
    const nextCfg = isLayer
      ? readLayer(cfg, { moveX: 0, moveY: 0, scaleFrom: 1, opacityFrom: 0, rotateX: 0, rotateY: 0, rotation: 0 })
      : readLayer(cfg?.next || cfg, { moveX: 0, moveY: 0, scaleFrom: 1, opacityFrom: 0, rotateX: 0, rotateY: 0, rotation: 0 });
    const prevCfg = readLayer(cfg?.prev, { moveX: 0, moveY: 0, scaleFrom: 1, opacityFrom: 0, rotateX: 0, rotateY: 0, rotation: 0 });

    const ox = ((cfg?.originX ?? cfg?.next?.originX ?? 50) / 100) * w;
    const oy = ((cfg?.originY ?? cfg?.next?.originY ?? 50) / 100) * h;
    const mx = (nextCfg.moveX / 100) * w * (1 - p);
    const my = (nextCfg.moveY / 100) * h * (1 - p);
    const sc = nextCfg.scaleFrom + (1 - nextCfg.scaleFrom) * p;
    const op = nextCfg.opacityFrom + (1 - nextCfg.opacityFrom) * p;
    const rot = -nextCfg.rotation * (1 - p) * Math.PI / 180;
    const rotX = -nextCfg.rotateX * (1 - p) * Math.PI / 180;
    const rotY = -nextCfg.rotateY * (1 - p) * Math.PI / 180;
    const skewX = Math.sin(rotY) * 0.36;
    const skewY = Math.sin(rotX) * 0.36;

    if (!isLayer) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, 1 + (prevCfg.opacityFrom - 1) * p));
      ctx.translate((prevCfg.moveX / 100) * w * p, (prevCfg.moveY / 100) * h * p);
      if (prevCfg.rotation) {
        ctx.translate(w / 2, h / 2);
        ctx.rotate(prevCfg.rotation * p * Math.PI / 180);
        ctx.translate(-w / 2, -h / 2);
      }
      const prevRotX = -prevCfg.rotateX * p * Math.PI / 180;
      const prevRotY = -prevCfg.rotateY * p * Math.PI / 180;
      const prevSkewX = Math.sin(prevRotY) * 0.36;
      const prevSkewY = Math.sin(prevRotX) * 0.36;
      const prevScale = 1 + (prevCfg.scaleFrom - 1) * p;
      ctx.translate(w / 2, h / 2);
      ctx.scale(prevScale, prevScale);
      const prevTiltX = Math.max(0.45, Math.cos((prevCfg.rotateY * p * Math.PI) / 180));
      const prevTiltY = Math.max(0.45, Math.cos((prevCfg.rotateX * p * Math.PI) / 180));
      ctx.scale(prevTiltX, prevTiltY);
      ctx.transform(1, prevSkewY, prevSkewX, 1, 0, 0);
      ctx.translate(-w / 2, -h / 2);
      drawScene(ctx, 0, 0, w, h, true);
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, op));
    ctx.translate(ox, oy);
    ctx.rotate(rot);
    ctx.scale(sc, sc);
    const tiltX = Math.max(0.45, Math.cos((nextCfg.rotateY * (1 - p) * Math.PI) / 180));
    const tiltY = Math.max(0.45, Math.cos((nextCfg.rotateX * (1 - p) * Math.PI) / 180));
    ctx.scale(tiltX, tiltY);
    ctx.transform(1, skewY, skewX, 1, 0, 0);
    ctx.translate(-ox, -oy);
    ctx.translate(mx, my);
    drawScene(ctx, 0, 0, w, h, false);
    ctx.restore();
  };
}

// The empty stage a layer animates over. A layer transition only ever draws the
// layer itself, so at the far end of the animation the frame is empty — without
// this the list is a column of black holes. Cross transitions always fill the
// frame themselves and get none of it.
function drawBackdrop(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#101015');
  g.addColorStop(1, '#0a0a0d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  ctx.strokeRect(8.5, 6.5, w - 17, h - 13);
}

// ── TransitionPreview: individual animated canvas ──
// Every preview in the modal receives the same start time. That keeps the wall
// in lockstep: layer entrances are all empty together, begin together and
// finish together instead of each row carrying an artificial delay.
function TransitionPreview({ render, cycle = CYCLE, startTime, easing = null, backdrop = false, radius = 4 }) {
  const canvasRef = useRef(null);
  const animRef = useRef(0);
  // Read through a ref so a duration or easing change does not restart the
  // loop. Written in an effect, not during render — a frame of lag on a 2s
  // preview cycle is invisible, and writing refs mid-render is not allowed.
  const cfg = useRef({ render, cycle, startTime, easing, backdrop, radius });
  useEffect(() => {
    cfg.current = { render, cycle, startTime, easing, backdrop, radius };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    let visible = typeof IntersectionObserver === 'undefined';

    const animate = (frameTime) => {
      animRef.current = 0;
      if (!visible || document.hidden) return;
      const c = cfg.current;
      // requestAnimationFrame supplies the same timestamp to every callback in
      // a frame, so every canvas computes the exact same progress value.
      const elapsed = Math.max(0, frameTime - c.startTime);
      const cyclePos = (elapsed % c.cycle) / c.cycle;
      // hold at start/end, animate in middle
      let p;
      if (cyclePos < 0.15) p = 0;
      else if (cyclePos > 0.85) p = 1;
      else p = (cyclePos - 0.15) / 0.7;
      if (c.easing) p = applyGsapEasing(p, c.easing);

      ctx.clearRect(0, 0, PW, PH);
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(0, 0, PW, PH, c.radius);
      ctx.clip();
      if (c.backdrop) drawBackdrop(ctx, PW, PH);
      c.render(ctx, p, PW, PH);
      ctx.restore();

      animRef.current = requestAnimationFrame(animate);
    };

    const syncAnimation = () => {
      if (visible && !document.hidden) {
        if (!animRef.current) animRef.current = requestAnimationFrame(animate);
      } else {
        cancelAnimationFrame(animRef.current);
        animRef.current = 0;
      }
    };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
      // isIntersecting also includes a zero-area contact with the scroll edge.
      visible = entry.isIntersecting && entry.intersectionRatio >= 0.001;
      syncAnimation();
    }, { threshold: 0.001 });
    observer?.observe(canvas);
    document.addEventListener('visibilitychange', syncAnimation);
    syncAnimation();
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', syncAnimation);
      cancelAnimationFrame(animRef.current);
      animRef.current = 0;
    };
  }, []);

  return <canvas ref={canvasRef} width={PW} height={PH} className="ve-tp-canvas" />;
}

// OUT previews mirror the render engine: the entrance plays in reverse, and
// motion-named pairs swap (Slide/Wipe Up↔Down, Zoom In↔Out) so the exit truly
// moves in the named direction — "Slide Right" exits right, "Slide Down" exits
// down, "Zoom In" pushes toward the camera while fading.
const OUT_SWAP = {
  'Zoom In': 'Zoom Out',
  'Zoom Out': 'Zoom In',
};

function pickRenderer(opt, { isLayer, isOut, customRenderer, advancedOptions }) {
  const map = isLayer ? layerRenderers : renderers;
  const key = isOut && opt !== 'Custom' ? (OUT_SWAP[opt] || opt) : opt;
  const base = key === 'Custom' ? customRenderer : (map[key] || renderers['Cross Fade']);
  // An advanced layer transition is ONE LANE of the cross pair, not a reversible
  // entrance: an exit is the OUTGOING lane played forward. Reversing the
  // entrance would run the incoming lane backwards, which zooms/travels the
  // wrong way — so these take the lane and read forward progress either way.
  if (isLayer && LANE_RENDERERS.has(key)) {
    const lane = isOut ? 'prev' : 'curr';
    return (ctx, p, w, h) => base(ctx, p, w, h, advancedOptions, lane);
  }
  if (!isOut) return (ctx, p, w, h) => base(ctx, p, w, h, advancedOptions);
  return (ctx, p, w, h) => base(ctx, 1 - p, w, h, advancedOptions);
}

// ── Main TransitionPicker ──
// The row control in the Transitions panel. It reads the current value and
// opens the preset modal; the grid dropdown it used to own now lives there.

export default function TransitionPicker({ value, onOpen }) {
  const label = getAdvancedTransitionPreset(value)?.name || value;
  return (
    <div className="ve-tp-wrap">
      <button className="ve-tp-trigger" onClick={onOpen}>
        <span>{label}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Transition preset modal — the "Spotlight" layout that shipped for keyframe
   presets, applied to transitions. Search leads, the list is the surface, and
   the timing controls sit in a compact bar above the footer.

   The keyframe modal's "When" band asked where the animation starts and how
   long it runs. A transition has no start point — it is welded to the cut
   (cross) or to the clip edge (in/out) — so the band holds Duration and
   Easing instead, which until now were hidden behind the per-row cog.

   The Intro/Outro segmented becomes Cross / In / Out: it swaps the option
   list, re-renders every preview and re-tints the modal through --kfp-dir.
   Look-dev source: html/transition-presets-modal.html
   ══════════════════════════════════════════════════════════════════════════ */

const TRP_CAT_NAME = Object.fromEntries(TRP_CATEGORIES.map((c) => [c.id, c.name]));

// Which item fields each slot owns. One table so nothing can drift between
// reading the current value, writing the patch and seeding the builder.
export const TRANSITION_SLOT_FIELDS = {
  cross: { type: 'transition', duration: 'transitionDuration', easing: 'transitionEasing', config: 'customTransitionConfig', options: 'transitionOptions', order: 'transitionOrder', label: 'Cross' },
  in: { type: 'transitionInType', duration: 'transitionInDuration', easing: 'transitionInEasing', config: 'customTransitionInConfig', options: 'transitionInOptions', label: 'In' },
  out: { type: 'transitionOutType', duration: 'transitionOutDuration', easing: 'transitionOutEasing', config: 'customTransitionOutConfig', options: 'transitionOutOptions', label: 'Out' },
};

// 1s is the default length for built-ins and legacy packages. Executable
// packages can declare a longer defaultDuration in their descriptor.
export const TRANSITION_DEFAULT_DURATION = 1;
const TRP_LENGTHS = [0.25, 0.5, 0.75, 1, 1.5];
// Cross only — an entrance or exit has one clip, so there is nothing to reorder.
const TRP_ORDERS = [
  [TransitionOrder.NEXT_OVER_PREV, 'Next over prev',
    'The next clip slides EARLIER onto the previous clip\u2019s tail. The previous clip stays put and the timeline gets shorter.'],
  [TransitionOrder.PREV_OVER_NEXT, 'Prev over next',
    'The previous clip slides LATER onto the next clip\u2019s head. The next clip stays put, the timeline keeps its length, and a gap opens in front of the clip that moved.'],
];
// The four that cover almost every use; the rest stay one click away in the select.
const TRP_QUICK_EASINGS = [TransitionEasing.EASE_IN_OUT, TransitionEasing.EASE_OUT, TransitionEasing.AE_SMOOTH, TransitionEasing.LINEAR];

const trpClamp = (v, min, max) => Math.max(min, Math.min(max, v));

// "Ripple transition" is a working preference, not a property of one cut: it
// stays as the user left it from one opening of the modal to the next.
const TRP_RIPPLE_KEY = 'video_editor_transition_ripple';
const readRipplePref = () => {
  try { return localStorage.getItem(TRP_RIPPLE_KEY) === '1'; } catch { return false; }
};
const writeRipplePref = (on) => {
  try { localStorage.setItem(TRP_RIPPLE_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
};

/*
 * The two that lead every list, in every category, in every slot.
 *
 * Advanced Zoom and Advanced Movement are the transitions with the full option
 * schema behind them, so they are what a pick usually ends at — burying them
 * mid-wall behind a dozen fixed slides made the modal read as if the app only
 * had the simple ones. Cross and layer share the same display strings, so one
 * list covers both enumerations.
 */
const TRP_PINNED_FIRST = [TransitionType.ZOOM_POINT, TransitionType.MOVE_POINT];

function trpOptions(slot, currentValue) {
  const enumeration = slot === 'cross' ? TransitionType : LayerTransitionType;
  const meta = slot === 'cross' ? CROSS_META : LAYER_META;
  const names = Object.values(enumeration).filter((t) => t !== 'None' && t !== 'Custom');
  // 'Custom' only appears once the slot actually holds a custom transition —
  // it is authored in the Builder, not picked from a list.
  if (currentValue === 'Custom') names.unshift('Custom');
  const options = names.map((name) => {
    const entry = meta[name] || ['special', ''];
    return {
      value: name,
      name,
      cat: entry[0],
      desc: (slot === 'out' ? entry[2] : entry[1]) || entry[1] || '',
      hasAudio: !!getAdvancedTransitionPreset(name)?.audio,
    };
  });
  if (slot === 'cross') {
    for (const preset of getLocalAdvancedTransitionPresets()) {
      options.push({
        value: preset.type,
        name: preset.name,
        cat: 'advanced',
        desc: preset.description,
        hasAudio: !!preset.audio,
        source: 'local',
        thumbnail: preset.thumbnail,
        previewVideo: preset.previewVideo,
      });
    }
  }
  // Stable sort: everything that is not pinned keeps the order it was declared in.
  const pinRank = (o) => {
    const i = TRP_PINNED_FIRST.indexOf(o.value);
    return i === -1 ? TRP_PINNED_FIRST.length : i;
  };
  return options.sort((a, b) => pinRank(a) - pinRank(b));
}

export function TransitionPresetModal({
  initialSlot = 'in',
  item,
  // Cross transitions need clips to overlap, which never happens on a
  // free-positioned channel — the slot is hidden there, as in the panel.
  crossDisabled = false,
  onApply,
  onRemove,
  onOpenBuilder,
  onClose,
  // false on a GreenLight Motion page: no Skill for Custom / Upload Transition (they install into the app)
  appTools = true,
}) {
  const [slot, setSlot] = useState(crossDisabled && initialSlot === 'cross' ? 'in' : initialSlot);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [skillPathCopied, setSkillPathCopied] = useState(false);
  const [registryRevision, setRegistryRevision] = useState(0);
  const [importBusy, setImportBusy] = useState(false);
  const [importNotice, setImportNotice] = useState('');
  const [previewStartTime] = useState(() => performance.now());
  const [ripple, setRipple] = useState(readRipplePref);
  const wallRef = useRef(null);
  const importInputRef = useRef(null);

  useEffect(() => {
    const unsubscribe = onAdvancedTransitionPresetsChanged(() => setRegistryRevision((revision) => revision + 1));
    // Re-read the installed list on every open: an agent may have added a
    // package over the API since this session last listed them.
    refreshAdvancedTransitionPackages();
    return unsubscribe;
  }, []);

  const copyAdvancedTransitionSkillPath = useCallback(async () => {
    try {
      const skillPath = (await window.electronAPI?.terminal?.getAdvancedTransitionSkillPath?.())
        || 'skills/advanced-transitions/SKILL.md';
      await navigator.clipboard.writeText(skillPath);
      setSkillPathCopied(true);
      setTimeout(() => setSkillPathCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  }, []);

  const importTransition = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImportBusy(true);
    setImportNotice('');
    try {
      const imported = await importLocalAdvancedTransition(file);
      const options = resolveAdvancedTransitionOptions(imported.type, imported.optionDefaults) || { ...imported.optionDefaults };
      setDraft((previous) => ({
        ...previous,
        cross: {
          ...previous.cross,
          value: imported.type,
          duration: getAdvancedTransitionDefaultDuration(imported.type),
          options,
        },
      }));
      setSlot('cross');
      setCategory('advanced');
      setQuery('');
      setImportNotice(`Imported ${imported.name}`);
    } catch (error) {
      setImportNotice(error?.message || 'Transition import failed.');
    } finally {
      setImportBusy(false);
    }
  }, []);

  // One draft per slot, seeded from the item. Kept apart so flipping the
  // segmented cannot drag one slot's duration onto another, and so a visit to
  // another slot is only committed if it was actually changed.
  const [draft, setDraft] = useState(() => {
    const seed = {};
    Object.entries(TRANSITION_SLOT_FIELDS).forEach(([key, f]) => {
      const type = item?.[f.type];
      const hasTransition = !!type && type !== 'None';
      seed[key] = {
        value: hasTransition ? type : null,
        // Ignore stale duration fields on empty slots. Picking a transition for
        // the first time must both display and apply the documented 1s default.
        duration: hasTransition && Number.isFinite(item?.[f.duration])
          ? item[f.duration]
          : TRANSITION_DEFAULT_DURATION,
        easing: item?.[f.easing] || TransitionEasing.EASE_IN_OUT,
        ...(f.order
          ? { order: item?.[f.order] === TransitionOrder.PREV_OVER_NEXT
            ? TransitionOrder.PREV_OVER_NEXT
            : TransitionOrder.NEXT_OVER_PREV }
          : null),
        options: resolveAdvancedTransitionOptions(type, item?.[f.options]) || {},
      };
    });
    return seed;
  });

  const cur = draft[slot];
  const patch = (next) => setDraft((prev) => ({ ...prev, [slot]: { ...prev[slot], ...next } }));
  const selectionForTransition = (value) => ({
    value,
    ...(value !== cur.value && (isLocalAdvancedTransitionType(value) || getAdvancedTransitionPreset(value)?.selectAtDefaultDuration)
      ? { duration: getAdvancedTransitionDefaultDuration(value) }
      : null),
    options: resolveAdvancedTransitionOptions(value, value === cur.value ? cur.options : null) || {},
  });
  const selectTransition = (value) => patch(selectionForTransition(value));

  const isLayer = slot !== 'cross';
  const isOut = slot === 'out';
  const mirroredOrder = slot === 'cross' && cur.order === TransitionOrder.PREV_OVER_NEXT;
  const customRenderer = useMemo(
    () => createCustomRenderer(item?.[TRANSITION_SLOT_FIELDS[slot].config], isLayer),
    [item, slot, isLayer],
  );
  const advancedPreset = getAdvancedTransitionPreset(cur.value);
  const advancedOptions = resolveAdvancedTransitionOptions(cur.value, cur.options);
  // The in/out slots run the advanced trio one-sided, so a control that needs
  // both clips (Wiggle → "Both clips share it") is not offered there.
  const advancedOptionFields = advancedTransitionOptionFields(advancedPreset, slot);

  const options = useMemo(() => {
    void registryRevision;
    return trpOptions(slot, cur.value);
  }, [slot, cur.value, registryRevision]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter((o) => (
      (category === 'all' || o.cat === category)
      && (!q || o.name.toLowerCase().includes(q) || o.desc.toLowerCase().includes(q))
    ));
  }, [options, category, query]);
  const countFor = useCallback(
    (id) => (id === 'all' ? options.length : options.filter((o) => o.cat === id).length),
    [options],
  );

  const changeSlot = (next) => {
    if (next === slot) return;
    setSlot(next);
    // A cross-only category can be empty on the layer list, which would leave
    // the wall blank with no obvious cause.
    setCategory('all');
  };

  // Apply commits every slot whose draft moved, not just the visible one — the
  // segmented invites editing two slots in one sitting.
  const apply = (pick, selectedDraft = null) => {
    const chosen = pick || cur.value;
    if (!chosen) return;
    const next = { ...draft, [slot]: { ...cur, ...(selectedDraft || {}), value: chosen } };
    const props = {};
    const touched = [];
    Object.entries(TRANSITION_SLOT_FIELDS).forEach(([key, f]) => {
      const d = next[key];
      if (!d.value) return;
      const resolvedOptions = resolveAdvancedTransitionOptions(d.value, d.options);
      const currentOptions = resolveAdvancedTransitionOptions(item?.[f.type], item?.[f.options]);
      const sameOptions = resolvedOptions == null
        || JSON.stringify(currentOptions) === JSON.stringify(resolvedOptions);
      const currentOrder = item?.[f.order] === TransitionOrder.PREV_OVER_NEXT
        ? TransitionOrder.PREV_OVER_NEXT
        : TransitionOrder.NEXT_OVER_PREV;
      const same = item?.[f.type] === d.value
        && item?.[f.duration] === d.duration
        && item?.[f.easing] === d.easing
        && (!f.order || currentOrder === d.order)
        && sameOptions;
      if (same) return;
      props[f.type] = d.value;
      props[f.duration] = d.duration;
      props[f.easing] = d.easing;
      if (f.order) props[f.order] = d.order || TransitionOrder.NEXT_OVER_PREV;
      if (resolvedOptions) props[f.options] = resolvedOptions;
      touched.push(key);
    });
    // Re-applying the same choice is a no-op, not an empty undo entry. Ripple
    // only means something for the cross slot: an entrance or exit never moves
    // a clip on the timeline.
    if (touched.length) onApply(props, touched, { ripple: ripple && touched.includes('cross') });
    onClose();
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'Enter') {
        // Enter inside a band field means "commit this number", not "apply".
        if (!cur.value || e.target?.closest?.('.ve-kfp-when input, .ve-kfp-when select')) return;
        e.preventDefault();
        apply();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (!visible.length) return;
      e.preventDefault();
      const at = visible.findIndex((o) => o.value === cur.value);
      const next = e.key === 'ArrowDown'
        ? Math.min(visible.length - 1, at + 1)
        : (at < 0 ? visible.length - 1 : Math.max(0, at - 1));
      const value = visible[next].value;
      selectTransition(value);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, cur, apply, onClose]);

  useEffect(() => {
    if (!cur.value || !wallRef.current) return;
    wallRef.current.querySelector(`[data-trans-name="${CSS.escape(cur.value)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [cur.value, slot]);

  const label = TRANSITION_SLOT_FIELDS[slot].label;
  // Previews play at the chosen length and curve, so the band is not an
  // abstract number — the whole wall speeds up or slows down with it.
  const cycle = trpClamp((cur.duration * 1000) / 0.7, 700, 5000);
  const appliedType = item?.[TRANSITION_SLOT_FIELDS[slot].type];
  const hasCurrent = !!appliedType && appliedType !== 'None';
  const canRemoveCurrent = hasCurrent
    && (appliedType === TransitionType.CUSTOM || isLocalAdvancedTransitionType(appliedType));

  return createPortal(
    <div className="ve-kfp-overlay" data-dir={slot} onMouseDown={onClose}>
      <div className="ve-kfp-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ve-kfp-head">
          <span className="ve-kfp-title">Transition</span>
          <div className="ve-kfp-spacer" />
          <div className="ve-kfp-seg">
            {[['cross', 'Cross'], ['in', 'In'], ['out', 'Out']]
              .filter(([value]) => !(crossDisabled && value === 'cross'))
              .map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  className={slot === value ? 'active' : ''}
                  onClick={() => changeSlot(value)}
                >
                  {text}
                </button>
              ))}
          </div>
          <button type="button" className="ve-kf-modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="ve-kfp-bar">
          <div className="ve-kfp-search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
            </svg>
            <input
              type="text"
              autoFocus
              placeholder={`Search ${slot} transitions…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="ve-kfp-chips">
            {[{ id: 'all', name: 'All' }, ...TRP_CATEGORIES].map((cat) => (
              <button
                key={cat.id}
                type="button"
                className={`ve-kfp-chip${category === cat.id ? ' active' : ''}`}
                disabled={countFor(cat.id) === 0}
                onClick={() => setCategory(cat.id)}
              >
                {cat.name}<b>{countFor(cat.id)}</b>
              </button>
            ))}
          </div>
        </div>

        <div className="ve-kfp-wall" ref={wallRef}>
          {visible.map((opt) => (
            <button
              key={opt.value}
              type="button"
              data-trans-name={opt.value}
              className={`ve-kfp-tile${cur.value === opt.value ? ' active' : ''}`}
              title={opt.desc}
              onClick={() => selectTransition(opt.value)}
              onDoubleClick={() => apply(opt.value, selectionForTransition(opt.value))}
            >
              <span className="ve-kf-preset-preview ve-trp-preview">
                {opt.previewVideo ? (
                  <video src={opt.previewVideo} poster={opt.thumbnail || undefined} muted loop autoPlay playsInline />
                ) : opt.thumbnail ? (
                  <img src={opt.thumbnail} alt="" />
                ) : (
                  <TransitionPreview
                    render={pickRenderer(opt.value, { isLayer, isOut, customRenderer, advancedOptions: opt.value === cur.value ? advancedOptions : null })}
                    cycle={cycle}
                    startTime={previewStartTime}
                    easing={cur.easing}
                    backdrop={isLayer}
                    radius={9}
                  />
                )}
              </span>
              <span className="ve-kfp-tile-txt">
                <span className="ve-kfp-tile-name">{opt.name}</span>
                <span className="ve-kfp-tile-desc">{opt.desc}</span>
              </span>
              <span className="ve-kfp-tile-cat">{opt.hasAudio ? '♪ ' : ''}{opt.source === 'local' ? 'LOCAL' : (TRP_CAT_NAME[opt.cat] || '')}</span>
            </button>
          ))}
          {visible.length === 0 && <div className="ve-kfp-empty">No transitions match this filter.</div>}
        </div>

        {advancedOptionFields.length > 0 && advancedOptions && (
          <div className="ve-trp-advanced-options">
            <div className="ve-kfp-row ve-kfp-when-head">
              <span className="ve-kfp-lbl">{advancedPreset?.plain ? 'Options' : 'Advanced options'}</span>
              <div className="ve-kfp-spacer" />
              <span className="ve-kfp-hint">Stored with this transition</span>
            </div>
            <div className="ve-kfp-row ve-trp-option-scroll">
              {advancedOptionFields.map((field) => {
                // A preset with many options splits them with section markers.
                // This row is a flat wrap, so a marker is just a full-width
                // label that breaks the run — no collapsing, that belongs to
                // the inspector where the list is read top to bottom.
                if (field.type === 'section') {
                  return <div className="ve-trp-option-section" key={field.key || field.label}>{field.label}</div>;
                }
                if (field.type === 'switch') {
                  const enabled = !!advancedOptions[field.key];
                  return (
                    <button
                      key={field.key}
                      type="button"
                      className={`ve-kfp-chip${enabled ? ' active' : ''}`}
                      aria-pressed={enabled}
                      onClick={() => patch({ options: { ...advancedOptions, [field.key]: !enabled } })}
                    >
                      {field.label}
                    </button>
                  );
                }
                if (field.type === 'select') {
                  return (
                    <label className="ve-trp-option-number" key={field.key}>
                      <span>{field.label}</span>
                      <select
                        className="ve-trp-sel"
                        value={advancedOptions[field.key]}
                        onChange={(event) => patch({ options: { ...advancedOptions, [field.key]: event.target.value } })}
                      >
                        {(field.options || []).map((option) => {
                          const value = typeof option === 'object' ? option.value : option;
                          const label = typeof option === 'object' ? option.label : option;
                          return <option key={value} value={value}>{label}</option>;
                        })}
                      </select>
                    </label>
                  );
                }
                if (field.type === 'text' || field.type === 'textarea' || field.type === 'color') {
                  const InputTag = field.type === 'textarea' ? 'textarea' : 'input';
                  return (
                    <label className="ve-trp-option-number" key={field.key}>
                      <span>{field.label}</span>
                      <InputTag
                        className="ve-trp-sel"
                        type={field.type === 'color' ? 'color' : undefined}
                        rows={field.type === 'textarea' ? (field.rows || 3) : undefined}
                        value={advancedOptions[field.key] ?? ''}
                        onChange={(event) => patch({ options: { ...advancedOptions, [field.key]: event.target.value } })}
                      />
                    </label>
                  );
                }
                if (field.type === 'point') {
                  return (
                    <div className="ve-trp-option-point" key={field.key}>
                      <PointField
                        label={field.label}
                        axes={field.axes || 2}
                        value={advancedOptions[field.key] ?? advancedPreset.optionDefaults?.[field.key]}
                        onInput={(value) => patch({ options: { ...advancedOptions, [field.key]: value } })}
                      />
                    </div>
                  );
                }
                return (
                  <div className="ve-trp-option-number" key={field.key}>
                    <span>{field.label}</span>
                    <NumberField
                      value={advancedOptions[field.key]}
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      suffix={field.suffix}
                      title={field.label}
                      onInput={(value) => patch({ options: { ...advancedOptions, [field.key]: trpClamp(value, field.min, field.max) } })}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Order — which clip carries the motion. Cross only: an entrance or
             exit has a single clip, so there is no second lane to trade with. ── */}
        {slot === 'cross' && (
          <div className="ve-kfp-when">
            <div className="ve-kfp-row ve-kfp-when-head">
              <span className="ve-kfp-lbl">Order</span>
              <div className="ve-kfp-spacer" />
              <span className="ve-kfp-hint">Which clip moves to make the overlap</span>
            </div>
            <div className="ve-kfp-row">
              <span className="ve-kfp-rowlabel">Motion</span>
              {TRP_ORDERS.map(([value, text, hint]) => (
                <button
                  key={value}
                  type="button"
                  title={hint}
                  className={`ve-kfp-chip${(cur.order || TransitionOrder.NEXT_OVER_PREV) === value ? ' active' : ''}`}
                  onClick={() => patch({ order: value })}
                >
                  {text}
                </button>
              ))}
            </div>
            <div className="ve-kfp-row">
              <span className="ve-kfp-rowlabel">Timeline</span>
              <button
                type="button"
                aria-pressed={ripple}
                className={`ve-kfp-chip ve-trp-ripple-chip${ripple ? ' active' : ''}`}
                title="Layers after the cut, on every channel, move with the incoming clip — the edit after the transition stays in sync"
                onClick={() => { setRipple(!ripple); writeRipplePref(!ripple); }}
              >
                Ripple transition
              </button>
              <div className="ve-kfp-spacer" />
              <span className="ve-kfp-hint">
                {!ripple
                  ? 'Other layers keep their time'
                  : (cur.order === TransitionOrder.PREV_OVER_NEXT
                    ? 'Prev over next: nothing after the cut moves'
                    : 'Later layers move with the cut')}
              </span>
            </div>
          </div>
        )}

        {/* ── Timing — Duration and Easing, which the per-row cog used to hide ── */}
        <div className="ve-kfp-when">
          <div className="ve-kfp-row ve-kfp-when-head">
            <span className="ve-kfp-lbl">Timing</span>
            <div className="ve-kfp-spacer" />
            <span className="ve-kfp-hint">
              {slot === 'cross' ? 'Sits on the cut, split across both clips' : `Runs at the ${isOut ? 'end' : 'start'} of the clip`}
            </span>
          </div>

          <div className="ve-kfp-row">
            <span className="ve-kfp-rowlabel">Length</span>
            {TRP_LENGTHS.map((sec) => (
              <button
                key={sec}
                type="button"
                className={`ve-kfp-chip${Math.abs(cur.duration - sec) < 0.005 ? ' active' : ''}`}
                onClick={() => patch({ duration: sec })}
              >
                {sec}s
              </button>
            ))}
            <div className="ve-kfp-num">
              <NumberField
                value={cur.duration}
                step={0.05}
                precision={2}
                min={0.05}
                max={slot === 'cross' && isLocalAdvancedTransitionType(cur.value) ? ADVANCED_TRANSITION_MAX_DURATION : 3}
                suffix="s"
                title="How long the transition runs"
                onInput={(v) => patch({
                  duration: trpClamp(
                    v,
                    0.05,
                    slot === 'cross' && isLocalAdvancedTransitionType(cur.value) ? ADVANCED_TRANSITION_MAX_DURATION : 3,
                  ),
                })}
              />
            </div>
          </div>

          <div className="ve-kfp-row">
            <span className="ve-kfp-rowlabel">Ease</span>
            {TRP_QUICK_EASINGS.map((name) => (
              <button
                key={name}
                type="button"
                className={`ve-kfp-chip${cur.easing === name ? ' active' : ''}`}
                onClick={() => patch({ easing: name })}
              >
                {name}
              </button>
            ))}
            <div className="ve-kfp-spacer" />
            <select
              className="ve-trp-sel"
              value={cur.easing}
              title="Easing curve"
              onChange={(e) => patch({ easing: e.target.value })}
            >
              {TRANSITION_EASING_OPTIONS.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="ve-kfp-foot">
          <div className="ve-trp-foot-tools">
            <button type="button" className="ve-trp-builder" onClick={() => { onClose(); onOpenBuilder(slot); }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              Builder
            </button>
            {appTools && (
              <>
                <button type="button" className="ve-trp-sdk-btn" onClick={copyAdvancedTransitionSkillPath}>
                  {skillPathCopied ? 'Copied!' : 'Skill for Custom'}
                </button>
                <button
                  type="button"
                  className="ve-trp-sdk-btn"
                  disabled={importBusy}
                  onClick={() => importInputRef.current?.click()}
                >
                  {importBusy ? 'Importing…' : 'Upload Transition'}
                </button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".js,.zip,.gltransition"
                  hidden
                  onChange={importTransition}
                />
              </>
            )}
          </div>
          {importNotice && <span className="ve-trp-import-notice" title={importNotice}>{importNotice}</span>}
          <span className="ve-kfp-readout-foot">
            {cur.value
              ? `${cur.value} · ${label} · ${cur.duration.toFixed(2)}s · ${cur.easing}${mirroredOrder ? ' · prev over next' : ''}${slot === 'cross' && ripple ? ' · ripple' : ''}`
              : `${label} · nothing selected`}
          </span>
          <div className="ve-kfp-spacer" />
          {canRemoveCurrent && (
            <button type="button" className="ve-trp-none" onClick={() => { onRemove(slot); onClose(); }}>Remove</button>
          )}
          <button type="button" className="ve-kf-cancel-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="ve-kf-apply-btn" disabled={!cur.value} onClick={() => apply()}>
            Apply<i aria-hidden="true">⏎</i>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
