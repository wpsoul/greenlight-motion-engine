/*
 * Mockup Frame — geometry layer effect (port of html/mockup-frame-lab.html).
 *
 * Draws a device chassis AROUND the layer and re-seats the layer's own pixels in the
 * chassis's screen. Unlike every other warp in this folder it is not a displacement of
 * the plate: the plate keeps its shape and is *placed*, and the new pixels are chrome
 * this module draws itself.
 *
 * Why the chassis is PATH GEOMETRY and never a sprite: the whole point of the effect is
 * that a camera push or a zoom finds more detail, not a softer edge. So the frame is
 * re-drawn into a canvas at the isolate's live pixel size (`renderMockupChassis`), the
 * same way a motion template is drawn, and the Player uploads that as a texture. A PNG
 * atlas would blur at exactly the moment the effect is being shown off.
 *
 * Three conventions are load-bearing:
 *  - Device geometry is in MILLIMETRES of the real hardware, and screen rects are derived
 *    from the panel's pixel count and ppi, so the bezels are the ones the device has.
 *    Nothing outside this file sees mm: `buildMockupDevice` returns a box and the caller
 *    scales it into the layer box.
 *  - Authored params are PERCENT of the layer box / of the screen, +y DOWN, like every
 *    other % field in the editor, and they are plain numbers so they keyframe through the
 *    static KF_PROPS registry for free.
 *  - Corners are Apple's CONTINUOUS corner (quarter superellipse, n≈5) for the devices
 *    that have one, and a true CIRCLE (n = 2) for the laptops and desktops, whose
 *    reference frames measurably use one. Shrinking a radius by the band width to draw an
 *    inset is wrong on a superellipse — it leaves the band ~1.23x fatter through the 45°
 *    diagonal — so `squircle()` takes the OUTER box plus an offset distance and walks the
 *    true normal instead.
 */

import imacSvgUrl from './assets/mockupFrames/imac-27.svg?url';
import iphoneSvgUrl from './assets/mockupFrames/iphone-17.svg?url';

import { affineBoxHomography, squareToQuadHomography, homographyApply, invertHomography } from './homography';

export { affineBoxHomography, squareToQuadHomography, homographyApply, invertHomography };

export const MOCKUP_FRAME_LAYER_EFFECT_ID = 'mockupFrame';

/* ------------------------------------------------------------------ params */

export const MF_DEFAULTS = {
  mfDevice: 'mbp16',
  mfFinish: '',
  mfOrient: 'native',
  mfSizeMode: 0,          // 0 fit the chassis in the layer box, 1 screen = layer box
  mfFit: 70,
  mfOffsetX: 0,
  mfOffsetY: 0,
  mfRot: 0,
  mfMediaFit: 0,          // 0 cover, 1 contain, 2 stretch
  mfMediaScale: 100,
  mfMediaX: 0,
  mfMediaY: 0,
  mfMediaRot: 0,
  mfMediaUpright: 1,
  mfScrollX: 0,           // animated scroll along X (0/1); the offset is speed × clip time
  mfScrollY: 0,
  mfScrollSpeedX: 10,     // % of the screen per second; + moves the artwork LEFT (scrolling right)
  mfScrollSpeedY: 10,     // + moves the artwork UP (scrolling down a page)
  mfScrollWrap: 0,        // tile the artwork so a scroll never runs off into the backdrop
  mfScreenBg: '#0b0d12',
  mfGlare: 35,
  mfShadow: 55,
  mfShadowBlur: 60,
  mfShadowY: 26,
  mfShadowSpread: 0,
  mfVariant: 'safari',
  mfTheme: 'dark',
  mfUrl: 'greenlightdash.com',
  mfContentAspect: 1.6,
  mfStand: 1,
  mfNano: 0,
  mfBand: 1,
};

/* `kf` marks a keyframable channel. Everything that positions the chassis or the artwork
   inside it animates — that is how a mockup pushes in, tilts or hands off between shots. */
export const MF_NUMBER_FIELDS = [
  { key: 'mfFit', label: 'Scale', min: 5, max: 200, step: 0.5, suffix: '%', kf: true, group: 'frame' },
  { key: 'mfOffsetX', label: 'Offset X', min: -100, max: 100, step: 0.5, suffix: '%', kf: true, group: 'frame' },
  { key: 'mfOffsetY', label: 'Offset Y', min: -100, max: 100, step: 0.5, suffix: '%', kf: true, group: 'frame' },
  { key: 'mfRot', label: 'Rotation', min: -180, max: 180, step: 0.5, suffix: '°', kf: true, group: 'frame' },
  { key: 'mfMediaScale', label: 'Scale', min: 10, max: 400, step: 0.5, suffix: '%', kf: true, group: 'media' },
  { key: 'mfMediaX', label: 'Position X', min: -100, max: 100, step: 0.5, suffix: '%', kf: true, group: 'media' },
  { key: 'mfMediaY', label: 'Position Y', min: -100, max: 100, step: 0.5, suffix: '%', kf: true, group: 'media' },
  { key: 'mfMediaRot', label: 'Rotation', min: -180, max: 180, step: 0.5, suffix: '°', kf: true, group: 'media' },
  { key: 'mfGlare', label: 'Glass Glare', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'media' },
  // Rates, like Repetile's scroll: keyframed, the Player INTEGRATES the track so a speed
  // change never makes the picture jump.
  { key: 'mfScrollSpeedX', label: 'Scroll Speed X', min: -300, max: 300, step: 0.5, suffix: '%/s', kf: true, group: 'scroll' },
  { key: 'mfScrollSpeedY', label: 'Scroll Speed Y', min: -300, max: 300, step: 0.5, suffix: '%/s', kf: true, group: 'scroll' },
  { key: 'mfShadow', label: 'Shadow Opacity', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'shadow' },
  { key: 'mfShadowBlur', label: 'Shadow Blur', min: 0, max: 200, step: 1, kf: true, group: 'shadow' },
  { key: 'mfShadowY', label: 'Shadow Offset Y', min: -60, max: 160, step: 1, kf: true, group: 'shadow' },
  { key: 'mfShadowSpread', label: 'Shadow Spread', min: -20, max: 30, step: 0.5, suffix: '%', kf: true, group: 'shadow' },
];

export const MF_KF_KEYS = MF_NUMBER_FIELDS.filter((f) => f.kf).map((f) => f.key);

/* 0/1 flags. An ABSENT flag falls back to its default, never to 0 — see the sanitizer. */
export const MF_BOOL_KEYS = ['mfMediaUpright', 'mfStand', 'mfNano', 'mfBand', 'mfScrollX', 'mfScrollY', 'mfScrollWrap'];

export const MF_ENUM_FIELDS = [
  {
    key: 'mfSizeMode',
    label: 'Size mode',
    group: 'frame',
    options: [[0, 'Fit device in box'], [1, 'Screen = box']],
  },
  {
    key: 'mfMediaFit',
    label: 'Fit',
    group: 'media',
    options: [[0, 'Cover'], [1, 'Contain'], [2, 'Stretch']],
  },
];

export const MF_COLOR_FIELDS = [
  { key: 'mfScreenBg', label: 'Screen backdrop', group: 'media' },
];

/* String params are chosen from lists the panel owns, so they are resolved by identity
   rather than by number and never take a keyframe. */
export const MF_STRING_FIELDS = ['mfDevice', 'mfFinish', 'mfOrient', 'mfVariant', 'mfTheme', 'mfUrl', 'mfScreenBg'];

function getMockupEffect(item) {
  const chain = Array.isArray(item?.layerEffects) ? item.layerEffects : [];
  return chain.find((e) => e && e.id === MOCKUP_FRAME_LAYER_EFFECT_ID) || null;
}

export function resolveMockupFrameParams(item, keyframeProps) {
  const effect = getMockupEffect(item);
  const params = effect?.params || {};
  const out = {};
  for (const [key, fallback] of Object.entries(MF_DEFAULTS)) {
    if (typeof fallback === 'string') {
      const raw = params[key];
      out[key] = typeof raw === 'string' && raw ? raw : fallback;
      continue;
    }
    const kf = keyframeProps?.[key];
    if (Number.isFinite(kf)) { out[key] = kf; continue; }
    const raw = params[key];
    out[key] = Number.isFinite(raw) ? raw : fallback;
  }
  return out;
}

/* ------------------------------------------------------- vector primitives */

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* units -> device px for the shape being drawn; drives how finely a corner is sampled so
   it is smooth at a close camera and cheap at thumbnail size. */
let QSCALE = 1;
const cornerSteps = (r) => clamp(Math.ceil(Math.abs(r) * QSCALE / 1.6), 6, 96);

const SQ_CACHE = new Map();
/* One quarter corner, offset INWARD by t along the true normal. n = 2 gives an exact
   circle (and exact circular normals), n ≈ 5 Apple's continuous corner. */
function sqCorner(r, n, t, N) {
  const key = `${r}|${n}|${t}|${N}`;
  let pts = SQ_CACHE.get(key);
  if (pts) return pts;
  const k = 2 / n;
  pts = [];
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * Math.PI / 2;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    const ax = r * Math.pow(c, k);
    const ay = r * Math.pow(sn, k);
    let nx;
    let ny;
    if (i === 0) { nx = 1; ny = 0; } else if (i === N) { nx = 0; ny = 1; } else {
      nx = Math.pow(sn, k - 1) * c;
      ny = Math.pow(c, k - 1) * sn;
      const L = Math.hypot(nx, ny) || 1;
      nx /= L; ny /= L;
    }
    pts.push([ax - t * nx, ay - t * ny]);
  }
  if (SQ_CACHE.size > 400) SQ_CACHE.clear();
  SQ_CACHE.set(key, pts);
  return pts;
}

export function squircle(ctx, x, y, w, h, r, n, t) {
  const nn = n || 5;
  const tt = t || 0;
  const rr0 = Math.min(Math.abs(r), Math.min(w, h) / 2);
  if (rr0 <= 0.0001) {
    ctx.rect(x + tt, y + tt, Math.max(0, w - tt * 2), Math.max(0, h - tt * 2));
    return;
  }
  const N = cornerSteps(rr0);
  const A = sqCorner(rr0, nn, tt, N);
  const x1 = x + w;
  const y1 = y + h;
  const tlx = x + rr0;
  const tly = y + rr0;
  const trx = x1 - rr0;
  const tryy = y + rr0;
  const brx = x1 - rr0;
  const bry = y1 - rr0;
  const blx = x + rr0;
  const bly = y1 - rr0;
  ctx.moveTo(tlx - A[N][0], tly - A[N][1]);
  ctx.lineTo(trx + A[N][0], tryy - A[N][1]);
  for (let i = N; i >= 0; i--) ctx.lineTo(trx + A[i][0], tryy - A[i][1]);
  ctx.lineTo(brx + A[0][0], bry + A[0][1]);
  for (let i = 0; i <= N; i++) ctx.lineTo(brx + A[i][0], bry + A[i][1]);
  ctx.lineTo(blx - A[N][0], bly + A[N][1]);
  for (let i = N; i >= 0; i--) ctx.lineTo(blx - A[i][0], bly + A[i][1]);
  ctx.lineTo(tlx - A[0][0], tly - A[0][1]);
  for (let i = 0; i <= N; i++) ctx.lineTo(tlx - A[i][0], tly - A[i][1]);
  ctx.closePath();
}

export function roundRect(ctx, x, y, w, h, tl, tr, br, bl) {
  let a = tl;
  let b = tr;
  let c = br;
  let d = bl;
  if (b === undefined) { b = a; c = a; d = a; }
  const m = Math.min(w, h) / 2;
  a = Math.min(a, m); b = Math.min(b, m); c = Math.min(c, m); d = Math.min(d, m);
  ctx.moveTo(x + a, y);
  ctx.lineTo(x + w - b, y); ctx.arcTo(x + w, y, x + w, y + b, b);
  ctx.lineTo(x + w, y + h - c); ctx.arcTo(x + w, y + h, x + w - c, y + h, c);
  ctx.lineTo(x + d, y + h); ctx.arcTo(x, y + h, x, y + h - d, d);
  ctx.lineTo(x, y + a); ctx.arcTo(x, y, x + a, y, a);
  ctx.closePath();
}

function lg(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const s of stops) g.addColorStop(clamp(s[0], 0, 1), s[1]);
  return g;
}
function rg(ctx, x0, y0, r0, x1, y1, r1, stops) {
  const g = ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
  for (const s of stops) g.addColorStop(clamp(s[0], 0, 1), s[1]);
  return g;
}
function hex2rgb(h) {
  let s = String(h).replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}
function tone(hex, k) {
  const [r, g, b] = hex2rgb(hex).split(',').map(Number);
  const q = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${q(r)},${q(g)},${q(b)})`;
}
const tinted = (hex) => ({ hi: tone(hex, 1.09), base: hex, lo: tone(hex, 0.90), edge: tone(hex, 0.78) });

/* The chamfer catching light: a metal band reads as a bright hairline at each edge with
   the body colour between, which is why this is a horizontal ramp and not a flat fill. */
function metalX(ctx, x, w, f) {
  return lg(ctx, x, 0, x + w, 0, [
    [0, f.edge], [0.012, f.hi], [0.045, f.base], [0.2, f.lo],
    [0.5, f.base], [0.8, f.lo], [0.955, f.base], [0.988, f.hi], [1, f.edge],
  ]);
}

/* ---------------------------------------------------------------- finishes */

export const MF_FINISHES = {
  natTitanium: { label: 'Natural Titanium', sw: '#c8c3b9', hi: '#f4f0e8', base: '#c8c3b9', lo: '#9b968c', edge: '#736e65' },
  blackTitan: { label: 'Space Black', sw: '#2c2c30', hi: '#63636a', base: '#2c2c30', lo: '#18181b', edge: '#0a0a0c' },
  cloudWhite: { label: 'Cloud White', sw: '#ece8e1', hi: '#ffffff', base: '#ece8e1', lo: '#c8c3ba', edge: '#a09a91' },
  skyBlue: { label: 'Sky Blue', sw: '#a9c8de', hi: '#e2f0fa', base: '#a9c8de', lo: '#7ba2bd', edge: '#5a7f99' },
  lightGold: { label: 'Light Gold', sw: '#e6d3b4', hi: '#fdf3e2', base: '#e6d3b4', lo: '#c1ab88', edge: '#9a8768' },
  silver: { label: 'Silver', sw: '#d8dade', hi: '#fafbfb', base: '#dcdee1', lo: '#b7babf', edge: '#95999e' },
  spaceGray: { label: 'Space Gray', sw: '#6d7176', hi: '#a8adb3', base: '#6d7176', lo: '#4a4e53', edge: '#33363a' },
  midnight: { label: 'Midnight', sw: '#1f2937', hi: '#4d5a6e', base: '#1f2937', lo: '#121924', edge: '#080c12' },
  starlight: { label: 'Starlight', sw: '#efe9dd', hi: '#fffdf8', base: '#efe9dd', lo: '#cdc5b6', edge: '#a49c8d' },
  obsidian: { label: 'Obsidian', sw: '#24272b', hi: '#585d64', base: '#24272b', lo: '#131518', edge: '#08090b' },
  porcelain: { label: 'Porcelain', sw: '#ece7df', hi: '#fffdfa', base: '#ece7df', lo: '#c9c3b8', edge: '#a09a8f' },
  moonstone: { label: 'Moonstone', sw: '#9fb0b8', hi: '#d6e2e8', base: '#9fb0b8', lo: '#77878f', edge: '#576368' },
  pixelJade: { label: 'Jade', sw: '#8fb59a', hi: '#cde3d3', base: '#8fb59a', lo: '#6b8f76', edge: '#4e6b57' },
  jetBlack: { label: 'Jet Black', sw: '#1a1a1c', hi: '#4a4a50', base: '#1a1a1c', lo: '#0d0d0f', edge: '#050506' },
  roseGold: { label: 'Rose Gold', sw: '#e3bfb2', hi: '#f9e2d9', base: '#e3bfb2', lo: '#bf9689', edge: '#98736a' },
  /* An iMac's FRONT is light aluminium on every COLOUR — only the chin and the stand
     carry the (pastel) tint, and the saturated tone lives on the back you cannot see.
     A neutral finish is the exception and tints the whole body. */
  imacGrey: { label: 'Space Grey', sw: '#8c9095', chin: '#8c9095', stand: '#7d8186', neutral: true },
  imacSilver: { label: 'Silver', sw: '#cbcfd4', chin: '#cbcfd4', stand: '#bbbfc4', neutral: true },
  imacBlue: { label: 'Blue', sw: '#b3c9de', chin: '#b3c9de', stand: '#a9bdcd' },
  imacGreen: { label: 'Green', sw: '#b6d2c0', chin: '#b6d2c0', stand: '#a7c4b1' },
  imacYellow: { label: 'Yellow', sw: '#e2d8ab', chin: '#e2d8ab', stand: '#d3c99c' },
  imacOrange: { label: 'Orange', sw: '#e8c4ae', chin: '#e8c4ae', stand: '#d9b49e' },
  imacRed: { label: 'Red', sw: '#e4b5af', chin: '#e4b5af', stand: '#d4a49e' },
  imacPurple: { label: 'Purple', sw: '#c8bcdc', chin: '#c8bcdc', stand: '#b8abcd' },
};

const GLASS = { top: '#141519', mid: '#0a0b0d', bot: '#101115' };
const ALU = { hi: '#fbfcfc', base: '#eaecee', lo: '#d6d9dd', edge: '#b4b8bd' };
const XDR_FACE = { hi: '#2e2e30', base: '#0b0b0c', lo: '#060607', edge: '#000000' };

/* --------------------------------------------------------- shared chassis bits */

function slabBody(ctx, o, g) {
  const { x, y, w, h, r, rim } = g;
  const f = o.f;
  ctx.beginPath(); squircle(ctx, x, y, w, h, r, g.n || 5);
  ctx.fillStyle = metalX(ctx, x, w, f); ctx.fill();
  ctx.fillStyle = lg(ctx, 0, y, 0, y + h, [
    [0, 'rgba(255,255,255,.20)'], [0.08, 'rgba(255,255,255,.02)'],
    [0.85, 'rgba(0,0,0,.06)'], [1, 'rgba(0,0,0,.22)'],
  ]);
  ctx.fill();
  ctx.beginPath(); squircle(ctx, x, y, w, h, r, g.n || 5, rim);
  ctx.fillStyle = lg(ctx, 0, y, 0, y + h, [[0, GLASS.top], [0.5, GLASS.mid], [1, GLASS.bot]]); ctx.fill();
  ctx.beginPath(); squircle(ctx, x, y, w, h, r, g.n || 5, rim);
  ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = rim * 0.3; ctx.stroke();
}

function glassGlare(ctx, s, amt, spath) {
  if (amt <= 0) return;
  ctx.save();
  ctx.beginPath(); spath(ctx); ctx.clip();
  const d = Math.max(s.w, s.h);
  ctx.translate(s.x + s.w * 0.5, s.y + s.h * 0.5);
  ctx.rotate(-24 * D2R);
  ctx.fillStyle = lg(ctx, -d, 0, d * 0.55, 0, [
    [0, 'rgba(255,255,255,0)'], [0.30, `rgba(255,255,255,${0.05 * amt})`],
    [0.47, `rgba(255,255,255,${0.20 * amt})`], [0.52, `rgba(255,255,255,${0.20 * amt})`],
    [0.66, `rgba(255,255,255,${0.03 * amt})`], [1, 'rgba(255,255,255,0)'],
  ]);
  ctx.fillRect(-d * 1.6, -d * 1.6, d * 3.2, d * 3.2);
  ctx.restore();
}

function sideBtn(ctx, x, y, w, h, f, right) {
  ctx.beginPath(); roundRect(ctx, x, y, w, h, Math.min(w, h) * 0.42);
  ctx.fillStyle = lg(ctx, x, 0, x + w, 0, right
    ? [[0, f.lo], [0.4, f.base], [1, f.hi]]
    : [[0, f.hi], [0.6, f.base], [1, f.lo]]);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = w * 0.1; ctx.stroke();
}

export { QSCALE, hex2rgb, tone, tinted, lg, rg, metalX, slabBody, glassGlare, sideBtn, ALU, XDR_FACE, GLASS, clamp, lerp, D2R, TAU };

export function setQualityScale(v) { QSCALE = v; }

/* -------------------------------------------------------------- chassis builders */

function buildPhone(o, S) {
  const pad = S.btnOut;
  const x = pad; const y = 0; const w = S.w; const h = S.h; const r = S.r; const rim = S.rim; const bez = S.bez;
  const s = { x: x + bez, y: y + bez, w: w - bez * 2, h: h - bez * 2, r: r - bez };
  const f = o.f;
  const spath = (c) => squircle(c, x, y, w, h, r, 5, bez);
  return {
    w: w + pad * 2, h, screen: s, screenPath: spath,
    silhouette(c) { squircle(c, x, y, w, h, r); },
    body(c) { slabBody(c, o, { x, y, w, h, r, rim }); },
    front(c) {
      glassGlare(c, s, o.glare, spath);
      if (S.island) {
        const iw = s.w * 0.306; const ih = iw * 0.286;
        const ix = x + w / 2 - iw / 2; const iy = s.y + s.h * 0.021;
        c.beginPath(); roundRect(c, ix, iy, iw, ih, ih / 2); c.fillStyle = '#000'; c.fill();
        const lx = ix + ih * 0.54; const ly = iy + ih * 0.5;   // lens sits LEFT on the real island
        c.beginPath(); c.arc(lx, ly, ih * 0.22, 0, TAU);
        c.fillStyle = rg(c, lx - ih * 0.06, ly - ih * 0.06, 0, lx, ly, ih * 0.22, [[0, '#1b2740'], [1, '#05060a']]); c.fill();
        c.beginPath(); c.arc(lx - ih * 0.05, ly - ih * 0.05, ih * 0.075, 0, TAU);
        c.fillStyle = 'rgba(96,132,205,.6)'; c.fill();
      } else {
        const cr = S.holeR; const cx = x + w / 2; const cy = s.y + S.holeY;
        c.beginPath(); c.arc(cx, cy, cr, 0, TAU); c.fillStyle = '#000'; c.fill();
        c.beginPath(); c.arc(cx, cy, cr * 0.62, 0, TAU);
        c.fillStyle = rg(c, cx - cr * 0.2, cy - cr * 0.2, 0, cx, cy, cr, [[0, '#28374d'], [1, '#05070b']]); c.fill();
      }
      for (const b of S.btns) {
        const bw = pad + rim * 0.5;
        if (b.side === 'l') sideBtn(c, x - pad, b.y, bw, b.h, f, false);
        else sideBtn(c, x + w - rim * 0.5, b.y, bw, b.h, f, true);
      }
    },
  };
}

function buildTablet(o, S) {
  const x = 0; const y = 0; const w = S.w; const h = S.h; const r = S.r; const rim = S.rim; const bez = S.bez;
  const s = { x: bez, y: bez, w: w - bez * 2, h: h - bez * 2, r: r - bez };
  const spath = (c) => squircle(c, x, y, w, h, r, 5, bez);
  return {
    w, h, screen: s, screenPath: spath,
    silhouette(c) { squircle(c, x, y, w, h, r); },
    body(c) { slabBody(c, o, { x, y, w, h, r, rim }); },
    front(c) {
      glassGlare(c, s, o.glare, spath);
      const cx = x + w / 2; const cy = bez * 0.5; const cr = bez * 0.16;
      c.beginPath(); c.arc(cx, cy, cr, 0, TAU);
      c.fillStyle = rg(c, cx - cr * 0.3, cy - cr * 0.3, 0, cx, cy, cr, [[0, '#2b3a4f'], [1, '#04060a']]); c.fill();
      c.beginPath(); c.arc(cx - cr * 0.25, cy - cr * 0.28, cr * 0.3, 0, TAU);
      c.fillStyle = 'rgba(150,190,255,.35)'; c.fill();
    },
  };
}

/* Laptop matched 1:1 to shots.so's MacBook render (measured off
   /mockups/Macbook Pro 16/portrait/silver.png at 9.46 px/mm): a thin metal rim on the
   lid edge, an edge-to-edge BLACK glass face — the bezels, the chin and the notch are
   one black slab — a hinge panel low on the chin, and a wide flat base (1.18x the lid
   width) carrying the thumb scoop and two feet. The lid corner is CIRCULAR (n = 2). */
function buildLaptop(o, S) {
  const w = S.baseW; const lidX = (S.baseW - S.lidW) / 2;
  const baseY = S.lidH; const h = S.lidH + S.baseH;
  const s = { x: lidX + S.bez, y: S.bezT, w: S.lidW - S.bez * 2, h: S.lidH - S.bezT - S.chin, r: S.screenR };
  const f = o.f; const N = 2;
  /* The display's TOP corners carry the radius; the bottom corners are square, exactly
     as the reference punches them. */
  const spath = (c) => roundRect(c, s.x, s.y, s.w, s.h, s.r, s.r, 0, 0);
  const basePath = (c) => roundRect(c, 0, baseY, w, S.baseH, S.baseH * 0.10, S.baseH * 0.10, S.baseR, S.baseR);
  return {
    w, h, screen: s, screenPath: spath,
    silhouette(c) { squircle(c, lidX, 0, S.lidW, S.lidH, S.lidR, N); basePath(c); },
    body(c) {
      /* base slab */
      c.beginPath(); basePath(c);
      c.fillStyle = lg(c, 0, baseY, 0, baseY + S.baseH, [[0, f.hi], [0.42, f.base], [0.8, f.lo], [1, f.edge]]); c.fill();
      c.beginPath(); basePath(c);
      c.fillStyle = metalX(c, 0, w, f); c.globalAlpha = 0.35; c.fill(); c.globalAlpha = 1;
      c.beginPath(); c.moveTo(S.baseR * 0.4, baseY + S.baseH * 0.05); c.lineTo(w - S.baseR * 0.4, baseY + S.baseH * 0.05);
      c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = S.baseH * 0.06; c.stroke();
      /* thumb scoop, brightest element of the base */
      const scX = w / 2 - S.scoopW / 2;
      c.beginPath(); roundRect(c, scX, baseY, S.scoopW, S.scoopH, 0, 0, S.scoopH * 0.55, S.scoopH * 0.55);
      c.fillStyle = lg(c, 0, baseY, 0, baseY + S.scoopH, [[0, tone(f.base, 0.82)], [0.35, f.hi], [1, f.hi]]); c.fill();
      /* feet */
      const ftY = baseY + S.baseH - S.footH;
      for (const fx of [S.footInset, w - S.footInset - S.footW]) {
        c.beginPath(); roundRect(c, fx, ftY, S.footW, S.footH, S.footH * 0.45);
        c.fillStyle = lg(c, 0, ftY, 0, ftY + S.footH, [[0, '#3a3b3d'], [1, '#1e1f21']]); c.fill();
      }
      /* lid: metal rim, dark seam, then the black glass face */
      c.beginPath(); squircle(c, lidX, 0, S.lidW, S.lidH, S.lidR, N);
      c.fillStyle = metalX(c, lidX, S.lidW, f); c.fill();
      c.beginPath(); squircle(c, lidX, 0, S.lidW, S.lidH, S.lidR, N, S.rim);
      c.fillStyle = '#2c2d2f'; c.fill();
      c.beginPath(); squircle(c, lidX, 0, S.lidW, S.lidH, S.lidR, N, S.rim + 0.5);
      c.fillStyle = lg(c, 0, 0, 0, S.lidH, [[0, '#0a0a0b'], [0.5, '#070606'], [1, '#0b0b0c']]); c.fill();
      /* hinge panel low on the chin */
      c.beginPath(); roundRect(c, lidX + S.hingeInset, S.lidH - S.hingeH, S.lidW - S.hingeInset * 2, S.hingeH, 0, 0, S.hingeR, S.hingeR);
      c.fillStyle = lg(c, 0, S.lidH - S.hingeH, 0, S.lidH, [[0, '#28292b'], [0.25, '#1d1e20'], [1, '#0e0f10']]); c.fill();
    },
    front(c) {
      glassGlare(c, s, o.glare, spath);
      /* Notch OVER the media: vertical walls, rounded bottom corners, and two small
         fillets where the walls meet the screen's top edge — the media's corner curves
         into the notch the way the macOS menu bar does. Same fill as the face. */
      const nw = S.notchW; const nh = S.notchH; const nx = lidX + S.lidW / 2 - nw / 2;
      const fr = nh * 0.25; const br = nh * 0.41; const ny = s.y - 0.01;
      c.beginPath();
      c.moveTo(nx - fr, ny);
      c.arc(nx - fr, ny + fr, fr, -Math.PI / 2, 0);
      c.lineTo(nx, ny + nh - br);
      c.arc(nx + br, ny + nh - br, br, Math.PI, Math.PI / 2, true);
      c.lineTo(nx + nw - br, ny + nh);
      c.arc(nx + nw - br, ny + nh - br, br, Math.PI / 2, 0, true);
      c.lineTo(nx + nw, ny + fr);
      c.arc(nx + nw + fr, ny + fr, fr, Math.PI, Math.PI * 1.5);
      c.closePath();
      c.fillStyle = '#070606'; c.fill();
      /* camera: a soft dark disk with a tiny lens, centred in the notch */
      const cx = nx + nw / 2; const cy = ny + nh * 0.52; const cr = S.camR;
      c.beginPath(); c.arc(cx, cy, cr, 0, TAU);
      c.fillStyle = rg(c, cx, cy - cr * 0.2, 0, cx, cy, cr, [[0, '#202124'], [0.7, '#17181b'], [1, '#0e0f11']]); c.fill();
      c.beginPath(); c.arc(cx, cy, cr * 0.34, 0, TAU);
      c.fillStyle = rg(c, cx - cr * 0.1, cy - cr * 0.1, 0, cx, cy, cr * 0.34, [[0, '#31435f'], [1, '#05070b']]); c.fill();
    },
  };
}

function buildDesktop(o, S) {
  const w = S.panelW; const px = 0; const N = 2;
  const h = S.panelH + (o.stand ? S.neckH : 0);
  const s = { x: S.bx, y: S.bt, w: S.panelW - S.bx * 2, h: S.panelH - S.bt - S.chin, r: S.screenR };
  const f = o.f;
  const neutral = S.twoTone && f.neutral;
  const bodyCol = S.frontDark ? XDR_FACE : neutral ? tinted(f.chin) : (S.twoTone ? ALU : f);
  const chinCol = S.twoTone ? tinted(f.chin || '#d5d6d8') : f;
  const standCol = S.twoTone ? tinted(f.stand || f.chin || '#c6c7c9') : f;
  const neckX = w / 2 - S.neckW / 2; const neckY = S.panelH;
  const footW = S.footW || 0; const footH = S.footH || 0;
  const spath = (c) => squircle(c, s.x, s.y, s.w, s.h, s.r, N);
  const neckPath = (c) => {
    const t = ((S.neckWBot || S.neckW) - S.neckW) / 2;
    c.moveTo(neckX, neckY); c.lineTo(neckX + S.neckW, neckY);
    c.lineTo(neckX + S.neckW + t, neckY + S.neckH);
    c.lineTo(neckX - t, neckY + S.neckH); c.closePath();
  };
  const footPath = (c) => roundRect(c, w / 2 - footW / 2, neckY + S.neckH, footW, footH, S.footR || footH * 0.28);
  return {
    w, h, screen: s, screenPath: spath,
    silhouette(c) {
      squircle(c, px, 0, S.panelW, S.panelH, S.panelR, N);
      if (o.stand) { neckPath(c); if (footW) footPath(c); }
    },
    body(c) {
      if (o.stand) {
        c.beginPath(); neckPath(c);
        c.fillStyle = lg(c, neckX, 0, neckX + S.neckW, 0, [
          [0, standCol.edge], [0.05, standCol.hi], [0.22, standCol.base], [0.5, standCol.base],
          [0.78, standCol.lo], [0.95, standCol.hi], [1, standCol.edge]]); c.fill();
        c.beginPath(); neckPath(c);
        c.fillStyle = lg(c, 0, neckY, 0, neckY + S.neckH, [
          [0, 'rgba(0,0,0,.20)'], [0.18, 'rgba(0,0,0,0)'], [0.9, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,.22)']]); c.fill();
        if (footW) {
          c.beginPath(); footPath(c);
          c.fillStyle = lg(c, 0, neckY + S.neckH, 0, neckY + S.neckH + footH,
            [[0, standCol.hi], [0.16, standCol.base], [0.62, standCol.lo], [1, standCol.edge]]); c.fill();
          c.beginPath();
          c.moveTo(w / 2 - footW / 2 + footH * 0.3, neckY + S.neckH + footH * 0.10);
          c.lineTo(w / 2 + footW / 2 - footH * 0.3, neckY + S.neckH + footH * 0.10);
          c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = footH * 0.09; c.stroke();
        }
      }
      c.beginPath(); squircle(c, px, 0, S.panelW, S.panelH, S.panelR, N);
      c.fillStyle = metalX(c, px, S.panelW, bodyCol); c.fill();
      if (S.frontDark) {
        c.beginPath(); squircle(c, px, 0, S.panelW, S.panelH, S.panelR, N);
        c.strokeStyle = 'rgba(190,196,204,.35)'; c.lineWidth = S.rim * 0.5; c.stroke();
      }
      if (S.twoTone) {
        c.save(); c.beginPath(); squircle(c, px, 0, S.panelW, S.panelH, S.panelR, N); c.clip();
        c.beginPath(); c.rect(px, S.panelH - S.chin, S.panelW, S.chin);
        c.fillStyle = metalX(c, px, S.panelW, chinCol); c.fill();
        c.fillStyle = lg(c, 0, S.panelH - S.chin, 0, S.panelH, [
          [0, 'rgba(255,255,255,.11)'], [0.22, 'rgba(255,255,255,0)'],
          [0.75, 'rgba(0,0,0,.06)'], [1, 'rgba(0,0,0,.16)']]); c.fill();
        c.restore();
      }
      if (S.lightBezel) {
        /* the iMac's frame is the SAME aluminium as the chin — the only dark thing on
           the front is a hairline ring hugging the display */
        const t = S.panelW * 0.0042;
        c.beginPath(); squircle(c, s.x - t, s.y - t, s.w + t * 2, s.h + t * 2, s.r + t, N);
        c.fillStyle = '#131418'; c.fill();
        c.beginPath(); squircle(c, s.x - t, s.y - t, s.w + t * 2, s.h + t * 2, s.r + t, N);
        c.strokeStyle = 'rgba(0,0,0,.18)'; c.lineWidth = t * 0.7; c.stroke();
        c.fillStyle = lg(c, 0, 0, 0, S.panelH, [[0, 'rgba(255,255,255,.13)'], [0.10, 'rgba(255,255,255,0)']]);
        c.beginPath(); squircle(c, px, 0, S.panelW, S.panelH, S.panelR, N); c.fill();
      } else {
        c.save();
        c.beginPath(); c.rect(px, 0, S.panelW, S.panelH - S.chin); c.clip();
        c.beginPath(); squircle(c, px, 0, S.panelW, S.panelH, S.panelR, N, S.rim);
        c.fillStyle = lg(c, 0, 0, 0, S.panelH, [[0, '#101115'], [0.6, '#08090b'], [1, '#0b0c0f']]); c.fill();
        c.restore();
      }
    },
    front(c) {
      glassGlare(c, s, o.nano ? o.glare * 0.25 : o.glare, spath);
      if (o.nano) {
        c.save(); c.beginPath(); spath(c); c.clip();
        c.fillStyle = 'rgba(190,200,215,.055)'; c.fillRect(s.x, s.y, s.w, s.h); c.restore();
      }
      if (S.camera) {
        const cx = px + S.panelW / 2; const cy = S.bt * 0.44; const cr = S.panelW * 0.0072;
        c.beginPath(); c.arc(cx, cy, cr, 0, TAU);
        c.fillStyle = rg(c, cx - cr * 0.3, cy - cr * 0.3, 0, cx, cy, cr, [[0, '#2b3a4f'], [1, '#04060a']]); c.fill();
      }
    },
  };
}

function buildWatch(o, S) {
  const bandExt = o.band ? S.bandExt : 0;
  const pad = S.crownOut; const x = pad; const y = bandExt; const w = S.w; const h = S.h;
  const s = { x: x + S.bez, y: y + S.bez, w: S.w - S.bez * 2, h: S.h - S.bez * 2, r: S.screenR };
  const f = o.f; const b = o.bandF || f;
  const spath = (c) => squircle(c, s.x, s.y, s.w, s.h, s.r, 2);
  return {
    w: w + pad * 2, h: h + bandExt * 2, screen: s, screenPath: spath,
    silhouette(c) { squircle(c, x, y, w, h, S.r, 4.2); },
    body(c) {
      if (o.band) {
        const cx = x + w / 2; const nx = S.bandW / 2; const fx = S.bandW * 0.43;
        const rb = hex2rgb(b.base); const re = hex2rgb(b.edge); const rh = hex2rgb(b.hi);
        for (const up of [true, false]) {
          const near = up ? y + S.r * 0.5 : y + h - S.r * 0.5;
          const far = up ? y - bandExt : y + h + bandExt;
          c.beginPath();
          c.moveTo(cx - nx, near); c.lineTo(cx - fx, far);
          c.lineTo(cx + fx, far); c.lineTo(cx + nx, near); c.closePath();
          /* the strap fades out, and the fade has to live in the fill's own ALPHA —
             painting the background over it only works on one background */
          c.fillStyle = lg(c, 0, near, 0, far, [
            [0, `rgba(${rb},1)`], [0.35, `rgba(${rb},.95)`], [0.78, `rgba(${rb},.45)`], [1, `rgba(${rb},0)`]]);
          c.fill();
          for (const sg of [-1, 1]) {
            c.beginPath();
            c.moveTo(cx + sg * nx, near); c.lineTo(cx + sg * fx, far);
            c.strokeStyle = lg(c, 0, near, 0, far, [[0, `rgba(${re},.95)`], [0.7, `rgba(${re},.4)`], [1, `rgba(${re},0)`]]);
            c.lineWidth = S.bandW * 0.10; c.stroke();
          }
          c.beginPath();
          c.moveTo(cx - nx * 0.34, near); c.lineTo(cx - fx * 0.34, far);
          c.strokeStyle = lg(c, 0, near, 0, far, [[0, `rgba(${rh},.22)`], [0.6, `rgba(${rh},.08)`], [1, `rgba(${rh},0)`]]);
          c.lineWidth = S.bandW * 0.16; c.stroke();
        }
      }
      slabBody(c, o, { x, y, w, h, r: S.r, rim: S.rim, n: S.n });
      c.beginPath(); squircle(c, x, y, w, h, S.r, S.n, S.rim * 1.9);
      c.strokeStyle = 'rgba(255,255,255,.06)'; c.lineWidth = S.rim * 0.5; c.stroke();
      c.beginPath(); spath(c); c.fillStyle = '#000'; c.fill();
    },
    front(c) {
      glassGlare(c, s, o.glare, spath);
      const cw = S.crownOut + S.rim; const cx = x + w - S.rim * 0.4;
      const cy = y + h * 0.30; const ch = h * 0.155;
      c.beginPath(); roundRect(c, cx, cy, cw, ch, cw * 0.35);
      c.fillStyle = lg(c, cx, 0, cx + cw, 0, [[0, f.lo], [0.35, f.hi], [1, f.edge]]); c.fill();
      c.strokeStyle = 'rgba(0,0,0,.4)'; c.lineWidth = cw * 0.12; c.stroke();
      c.save(); c.beginPath(); roundRect(c, cx, cy, cw, ch, cw * 0.35); c.clip();
      c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = ch * 0.035;
      for (let i = 1; i < 9; i++) {
        const gy = cy + ch * i / 9;
        c.beginPath(); c.moveTo(cx, gy); c.lineTo(cx + cw, gy); c.stroke();
      }
      c.restore();
      const by = y + h * 0.55; const bh = h * 0.19;
      c.beginPath(); roundRect(c, cx, by, cw * 0.72, bh, cw * 0.3);
      c.fillStyle = lg(c, cx, 0, cx + cw * 0.72, 0, [[0, f.lo], [0.4, f.base], [1, f.edge]]); c.fill();
      /* Action Button: 1.1% of the case width and ~26% of its height, LOW on the rail */
      const aW = w * 0.0115; const aH = h * 0.255; const aY = y + h * 0.46; const aX = x - aW * 0.30;
      c.beginPath(); roundRect(c, aX, aY, aW, aH, aW * 0.36);
      c.fillStyle = lg(c, aX, 0, aX + aW, 0, [[0, '#a9490c'], [0.34, '#f28c2c'], [0.75, '#d9701a'], [1, '#8a3e0c']]);
      c.fill();
      c.strokeStyle = 'rgba(0,0,0,.30)'; c.lineWidth = aW * 0.11; c.stroke();
    },
  };
}

/* ------------------------------------------------------------------ devices
   Dimensions are the real hardware in mm; screen rects follow from the panel's
   pixel count and ppi, so the bezels are the ones the device actually has. */
export const MF_DEVICES = [
  { id: 'browser', label: 'Browser', group: 'web', native: 'landscape', rotatable: false,
    opts: ['variant', 'theme', 'url', 'contentAspect'],
    build: (o) => buildBrowser(o) },
  { id: 'iphone17air', label: 'iPhone 17 Air', group: 'phone', native: 'portrait',
    finishes: ['cloudWhite', 'skyBlue', 'lightGold', 'blackTitan'],
    build: (o) => buildPhone(o, {
      w: 74.7, h: 156.2, r: 12.4, rim: 0.42, bez: 1.95, btnOut: 0.8, island: true,
      btns: [{ side: 'l', y: 29, h: 5.6 }, { side: 'l', y: 40, h: 8.8 }, { side: 'l', y: 51.5, h: 8.8 }, { side: 'r', y: 45, h: 12.6 }],
    }) },
  { id: 'pixel', label: 'Pixel 10 Pro', group: 'phone', native: 'portrait',
    finishes: ['obsidian', 'porcelain', 'moonstone', 'pixelJade'],
    build: (o) => buildPhone(o, {
      w: 72.0, h: 152.8, r: 11.4, rim: 0.46, bez: 2.3, btnOut: 0.75, island: false, holeR: 1.7, holeY: 4.4,
      btns: [{ side: 'r', y: 36, h: 10.5 }, { side: 'r', y: 50, h: 17 }],
    }) },
  { id: 'ipad13', label: 'iPad Pro 13"', group: 'tablet', native: 'landscape',
    finishes: ['silver', 'spaceGray'],
    build: (o) => buildTablet(o, { w: 281.6, h: 215.5, r: 18.5, rim: 0.8, bez: 7.2 }) },
  { id: 'mbp16', label: 'MacBook Pro 16"', group: 'laptop', native: 'landscape', rotatable: false,
    finishes: ['blackTitan', 'silver'],
    build: (o) => buildLaptop(o, {
      lidW: 355.7, lidH: 240.9, lidR: 7.9, rim: 0.85, bez: 5.6, bezT: 5.8, chin: 12.7, screenR: 3.1,
      notchW: 36.8, notchH: 6.35, camR: 1.25, hingeH: 9.0, hingeInset: 2.0, hingeR: 4.2,
      baseW: 420.8, baseH: 16.2, baseR: 7.9, scoopW: 64, scoopH: 5.8, footW: 21, footH: 1.6, footInset: 21,
    }) },
  { id: 'mba15', label: 'MacBook Air 15"', group: 'laptop', native: 'landscape', rotatable: false,
    finishes: ['midnight', 'starlight', 'silver', 'spaceGray'],
    build: (o) => buildLaptop(o, {
      lidW: 340.4, lidH: 228.6, lidR: 8.0, rim: 0.8, bez: 6.9, bezT: 6.9, chin: 10.4, screenR: 3.0,
      notchW: 35, notchH: 6.0, camR: 1.2, hingeH: 7.5, hingeInset: 2.0, hingeR: 3.6,
      baseW: 395, baseH: 11.5, baseR: 5.6, scoopW: 58, scoopH: 4.6, footW: 18, footH: 1.4, footInset: 18,
    }) },
  { id: 'imac24', label: 'iMac', group: 'desktop', native: 'landscape', rotatable: false,
    finishes: ['imacGrey', 'imacSilver', 'imacBlue', 'imacGreen', 'imacYellow', 'imacOrange', 'imacRed', 'imacPurple'],
    build: (o) => buildDesktop(o, {
      panelW: 547, panelH: 375, panelR: 11, rim: 0.9, bx: 13.9, bt: 13.9, chin: 66, screenR: 4,
      neckW: 128, neckWBot: 122, neckH: 77, footW: 136, footH: 13.5, footR: 3.5,
      twoTone: true, camera: true, lightBezel: true,
    }) },
  { id: 'xdr', label: 'Pro Display XDR', group: 'desktop', native: 'landscape', rotatable: false,
    finishes: ['silver'],
    build: (o) => buildDesktop(o, {
      panelW: 717.7, panelH: 412, panelR: 5.0, rim: 1.0, bx: 9.5, bt: 9.5, chin: 9.5, screenR: 2,
      neckW: 179.1, neckH: 120.6, neckR: 4, twoTone: false, camera: false, frontDark: true,
    }) },
  { id: 'iphone17', label: 'iPhone 17', group: 'phone', native: 'portrait', artwork: true,
    build: (o) => buildSvgFrame(o, {
      url: iphoneSvgUrl, w: 71.5, ratio: 2.06897,
      sx: 0.04095, sy: 0.03448, sw: 0.91810, sh: 2.0, sr: 0.12716,
      island: { x: 0.35453, y: 0.06681, w: 0.28879, h: 0.08190 },
    }) },
  { id: 'imacSpaceGrey', label: 'iMac Space Grey', group: 'desktop', native: 'landscape', rotatable: false, artwork: true,
    build: (o) => buildSvgFrame(o, {
      url: imacSvgUrl, w: 650, ratio: 0.82667,
      sx: 0.03833, sy: 0.03833, sw: 0.92334, sh: 0.51938, sr: 0,
    }) },
  { id: 'watch', label: 'Apple Watch 46mm', group: 'wear', native: 'portrait',
    finishes: ['jetBlack', 'natTitanium', 'silver', 'roseGold'],
    build: (o) => buildWatch(o, {
      w: 39, h: 46, r: 12.6, n: 2, rim: 0.55, bez: 3.3, screenR: 9.1,
      crownOut: 1.7, bandW: 25, bandExt: 27,
    }) },
];
const MF_DEV_BY_ID = Object.fromEntries(MF_DEVICES.map((d) => [d.id, d]));

/* Rotating a chassis carries its screen with it, exactly as real hardware does; the
   caller can counter-rotate the artwork with mfMediaUpright. */
function orient(dev, cw) {
  const S = dev.screen;
  const screen = cw
    ? { x: dev.h - (S.y + S.h), y: S.x, w: S.h, h: S.w, r: S.r }
    : { x: S.y, y: dev.w - (S.x + S.w), w: S.h, h: S.w, r: S.r };
  return {
    w: dev.h,
    h: dev.w,
    screen,
    screenLocal: dev.screenLocal || dev.screen,
    screenClipR: dev.screenClipR || 0,
    svgReady: dev.svgReady,
    shadowCast: dev.shadowCast ? (c) => dev.shadowCast(c) : undefined,
    rotDeg: cw ? 90 : -90,
    pre: (c) => {
      if (cw) { c.translate(dev.h, 0); c.rotate(Math.PI / 2); } else { c.translate(0, dev.w); c.rotate(-Math.PI / 2); }
    },
    screenPath: (c) => dev.screenPath(c),
    silhouette: (c) => dev.silhouette(c),
    body: (c) => dev.body(c),
    front: (c) => dev.front(c),
  };
}

/* The chassis texture is drawn on a PADDED field: a drop shadow reaches well past the
   device, and a canvas sized to the device alone cuts it off square. */
export function mockupShadowPad(dev, p) {
  if (!(p.mfShadow > 0)) return 0;
  const blur = dev.h * p.mfShadowBlur / 400;
  const offY = Math.abs(dev.h * p.mfShadowY / 400);
  const spread = Math.max(0, p.mfShadowSpread / 100) * Math.max(dev.w, dev.h) * 0.5;
  return Math.ceil(blur * 1.6 + offY + spread + Math.max(dev.w, dev.h) * 0.01);
}

export function buildMockupDevice(p) {
  const spec = MF_DEV_BY_ID[p.mfDevice] || MF_DEV_BY_ID.mbp16;
  const list = spec.finishes || [];
  const fin = list.includes(p.mfFinish) ? p.mfFinish : list[0];
  const f = (fin && MF_FINISHES[fin]) || MF_FINISHES.silver;
  const o = {
    f,
    bandF: fin === 'jetBlack' ? { hi: '#2a2a2e', base: '#1a1a1c', lo: '#111113', edge: '#0a0a0c' }
      : fin === 'roseGold' ? { hi: '#f3cfc4', base: '#e0b6a9', lo: '#c1968a', edge: '#9a746a' }
        : { hi: '#3a3d42', base: '#26292d', lo: '#191b1e', edge: '#0e1012' },
    glare: clamp(p.mfGlare, 0, 100) / 100,
    variant: p.mfVariant,
    theme: p.mfTheme,
    url: p.mfUrl,
    contentAspect: p.mfContentAspect > 0 ? p.mfContentAspect : 1.6,
    stand: p.mfStand !== 0,
    nano: p.mfNano === 1,
    band: p.mfBand !== 0,
  };
  let dev = spec.build(o);
  dev.screenLocal = dev.screen;
  if (spec.rotatable !== false && p.mfOrient !== 'native' && p.mfOrient !== spec.native) {
    dev = orient(dev, spec.native === 'portrait');
  }
  return dev;
}

/* Where the chassis sits inside the layer box. `screenBox` keeps the artwork at its
   original size and lets the chassis overflow — that is the case that wants the auto
   ~70% scale, and `autoFit` is the exact percentage that brings it all back in view. */
export function layoutMockupFrame(dev, boxW, boxH, p) {
  const fit = p.mfFit / 100;
  const screenBox = p.mfSizeMode === 1;
  const scale = screenBox
    ? fit * Math.min(boxW / dev.screen.w, boxH / dev.screen.h)
    : fit * Math.min(boxW / dev.w, boxH / dev.h);
  const autoFit = screenBox
    ? Math.min(boxW / dev.w, boxH / dev.h) / Math.min(boxW / dev.screen.w, boxH / dev.screen.h)
    : 1;
  return {
    scale,
    autoFit,
    cx: boxW / 2 + (p.mfOffsetX / 100) * boxW,
    cy: boxH / 2 + (p.mfOffsetY / 100) * boxH,
    rot: p.mfRot * D2R,
  };
}

/* Where the layer's own pixels land, in the chassis's local space. The Player turns this
   into the inverse affine it samples the isolate with. */
export function mockupMediaPlacement(dev, p, mediaW, mediaH) {
  const s = dev.screenLocal || dev.screen;
  const up = (p.mfMediaUpright !== 0 && dev.rotDeg) ? dev.rotDeg : 0;
  const bw = up ? s.h : s.w;
  const bh = up ? s.w : s.h;
  const k = p.mfMediaScale / 100;
  let sx;
  let sy;
  if (p.mfMediaFit === 2) { sx = (bw / mediaW) * k; sy = (bh / mediaH) * k; } else {
    const f = p.mfMediaFit === 1
      ? Math.min(bw / mediaW, bh / mediaH)
      : Math.max(bw / mediaW, bh / mediaH);
    sx = f * k; sy = f * k;
  }
  return {
    cx: s.x + s.w / 2 + (p.mfMediaX / 100) * s.w,
    cy: s.y + s.h / 2 + (p.mfMediaY / 100) * s.h,
    rot: (p.mfMediaRot - up) * D2R,
    sx,
    sy,
  };
}

/* THE SEAT: how the layer's own plane has to move so the artwork lands in the chassis
   screen — the same placement mockupMediaPlacement describes, expressed as a transform
   of the artwork in the box's plane (px, y DOWN, relative to the box centre). The Player
   poses the layer mesh through this for the isolate render, so the isolate already
   holds the artwork inside the screen (with every upstream effect applied to it) and
   the pass reads it at identity — it never needs artwork pixels that a big or tilted
   layer projects OFF the frame, which is what smeared a rotated mockup's screen.
   Returns { kx, ky (scale), theta (radians, y-down), tx, ty (px) } with
   p' = R(theta) · diag(kx, ky) · p + t. */
export function mockupSeatTransform(dev, p, layout, boxW, boxH) {
  const m = mockupMediaPlacement(dev, p, boxW, boxH);
  const s = layout.scale;
  const c = Math.cos(layout.rot);
  const sn = Math.sin(layout.rot);
  // the artwork centre in the chassis's device space, carried into box px
  const dx = (m.cx - dev.w / 2) * s;
  const dy = (m.cy - dev.h / 2) * s;
  return {
    kx: m.sx * s,
    ky: m.sy * s,
    theta: layout.rot + m.rot,
    tx: layout.cx + (c * dx - sn * dy) - boxW / 2,
    ty: layout.cy + (sn * dx + c * dy) - boxH / 2,
  };
}

/* Draws the chassis into a 2D context with the SCREEN PUNCHED OUT, so the Player can
   composite it straight over the re-seated layer pixels. `unitScale` is device-units to
   canvas px: it drives the corner tessellation and the (CTM-immune) canvas shadow. */
function renderMockupChassisUnderlay(ctx, dev, p, unitScale) {
  QSCALE = unitScale;
  const withDev = (fn) => { ctx.save(); if (dev.pre) dev.pre(ctx); fn(ctx); ctx.restore(); };
  if (p.mfShadow > 0) {
    /* Filling the silhouette in place paints the CASTER as well as its shadow, so any
       spread showed up as a hard black ring. Park the caster far off-canvas and use
       shadowOffsetX to bring only the shadow back — shadow offsets ignore the CTM,
       which is exactly what makes this work. */
    const blur = dev.h * p.mfShadowBlur / 400;
    const offY = dev.h * p.mfShadowY / 400;
    const sp = 1 + p.mfShadowSpread / 100;
    const K = 100000;
    const m = ctx.getTransform();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(-K, 0);
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.shadowColor = `rgba(4,6,10,${clamp(p.mfShadow, 0, 100) / 100})`;
    ctx.shadowBlur = Math.min(blur * unitScale, 900);
    ctx.shadowOffsetX = K;
    ctx.shadowOffsetY = offY * unitScale;
    ctx.fillStyle = '#000';
    ctx.translate(dev.w / 2, dev.h / 2); ctx.scale(sp, sp); ctx.translate(-dev.w / 2, -dev.h / 2);
    withDev((c) => {
      if (dev.shadowCast) dev.shadowCast(c);
      else { c.beginPath(); dev.silhouette(c); c.fill(); }
    });
    ctx.restore();
  }
  withDev((c) => dev.body(c));
  /* Punch the display to FULLY transparent. The backdrop colour is not painted here:
     the Player fills it inside the screen rect and composites the layer's pixels over
     it, then this chrome over that — so `front()`'s glare and island keep their partial
     alpha above the artwork instead of being buried under it. */
  withDev((c) => {
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.beginPath(); dev.screenPath(c);
    c.fillStyle = '#000';
    c.fill();
    c.restore();
  });
}

function renderMockupChassisFront(ctx, dev, unitScale) {
  QSCALE = unitScale;
  ctx.save();
  if (dev.pre) dev.pre(ctx);
  dev.front(ctx);
  ctx.restore();
}

/* Public one-canvas draw used by thumbnails/tests. The Player uses the split under/front
   canvases below so the GPU can put live media BETWEEN them, in the exact same order as
   the HTML lab: body -> clipped media -> glass/island/front details. */
export function renderMockupChassis(ctx, dev, p, unitScale) {
  renderMockupChassisUnderlay(ctx, dev, p, unitScale);
  renderMockupChassisFront(ctx, dev, unitScale);
}

/* ------------------------------------------------------------------ browser
   Not hardware: a window whose content area follows the media's own aspect. Icons are
   stroked paths for the same reason the chassis is — they have to survive a push-in. */
function ico(c, color, w) { c.strokeStyle = color; c.lineWidth = w || 1.7; c.lineCap = 'round'; c.lineJoin = 'round'; }
const RELOAD_PATH = 'M10 22v2c0 7.72 6.28 14 14 14s14-6.28 14-14-6.28-14-14-14h-4V4l-8 8 8 8v-6h4c5.514 0 10 4.486 10 10s-4.486 10-10 10-10-4.486-10-10v-2z';
let RELOAD_P2D = null;
const ICONS = {
  chevL(c, x, y, s) { c.beginPath(); c.moveTo(x + s * 0.3, y - s * 0.5); c.lineTo(x - s * 0.25, y); c.lineTo(x + s * 0.3, y + s * 0.5); c.stroke(); },
  chevR(c, x, y, s) { c.beginPath(); c.moveTo(x - s * 0.3, y - s * 0.5); c.lineTo(x + s * 0.25, y); c.lineTo(x - s * 0.3, y + s * 0.5); c.stroke(); },
  sidebar(c, x, y, s) {
    c.beginPath(); roundRect(c, x - s * 0.6, y - s * 0.45, s * 1.2, s * 0.9, s * 0.18); c.stroke();
    c.beginPath(); c.moveTo(x - s * 0.17, y - s * 0.45); c.lineTo(x - s * 0.17, y + s * 0.45); c.stroke();
  },
  reload(c, x, y, s) {
    if (!RELOAD_P2D && typeof Path2D !== 'undefined') RELOAD_P2D = new Path2D(RELOAD_PATH);
    if (!RELOAD_P2D) return;
    c.save(); c.translate(x, y); const k = s / 34; c.scale(k, k); c.translate(-24, -21);
    c.fillStyle = c.strokeStyle; c.fill(RELOAD_P2D); c.restore();
  },
  shield(c, x, y, s) {
    c.beginPath(); c.moveTo(x, y - s * 0.55); c.lineTo(x + s * 0.42, y - s * 0.34); c.lineTo(x + s * 0.42, y + s * 0.1);
    c.quadraticCurveTo(x + s * 0.42, y + s * 0.45, x, y + s * 0.58);
    c.quadraticCurveTo(x - s * 0.42, y + s * 0.45, x - s * 0.42, y + s * 0.1);
    c.lineTo(x - s * 0.42, y - s * 0.34); c.closePath(); c.stroke();
  },
  share(c, x, y, s) {
    c.beginPath(); c.moveTo(x - s * 0.4, y - s * 0.05); c.lineTo(x - s * 0.4, y + s * 0.55); c.lineTo(x + s * 0.4, y + s * 0.55); c.lineTo(x + s * 0.4, y - s * 0.05); c.stroke();
    c.beginPath(); c.moveTo(x, y + s * 0.28); c.lineTo(x, y - s * 0.58); c.stroke();
    c.beginPath(); c.moveTo(x - s * 0.26, y - s * 0.3); c.lineTo(x, y - s * 0.58); c.lineTo(x + s * 0.26, y - s * 0.3); c.stroke();
  },
  down(c, x, y, s) {
    c.beginPath(); c.arc(x, y, s * 0.5, 0, TAU); c.stroke();
    c.beginPath(); c.moveTo(x, y - s * 0.26); c.lineTo(x, y + s * 0.24);
    c.moveTo(x - s * 0.2, y + s * 0.03); c.lineTo(x, y + s * 0.24); c.lineTo(x + s * 0.2, y + s * 0.03); c.stroke();
  },
  plus(c, x, y, s) { c.beginPath(); c.moveTo(x - s * 0.42, y); c.lineTo(x + s * 0.42, y); c.moveTo(x, y - s * 0.42); c.lineTo(x, y + s * 0.42); c.stroke(); },
  tabs(c, x, y, s) {
    c.beginPath(); roundRect(c, x - s * 0.55, y - s * 0.42, s * 0.84, s * 0.84, s * 0.16); c.stroke();
    c.beginPath(); roundRect(c, x - s * 0.25, y - s * 0.58, s * 0.84, s * 0.84, s * 0.16); c.stroke();
  },
  dots(c, x, y, s) { c.fillStyle = c.strokeStyle; for (let i = -1; i <= 1; i++) { c.beginPath(); c.arc(x, y + i * s * 0.34, s * 0.1, 0, TAU); c.fill(); } },
  home(c, x, y, s) {
    c.beginPath(); c.moveTo(x - s * 0.45, y + s * 0.05); c.lineTo(x, y - s * 0.45); c.lineTo(x + s * 0.45, y + s * 0.05);
    c.lineTo(x + s * 0.45, y + s * 0.5); c.lineTo(x - s * 0.45, y + s * 0.5); c.closePath(); c.stroke();
  },
  star(c, x, y, s) {
    c.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5; const rr2 = i % 2 ? s * 0.22 : s * 0.5; if (i) c.lineTo(x + Math.cos(a) * rr2, y + Math.sin(a) * rr2); else c.moveTo(x + Math.cos(a) * rr2, y + Math.sin(a) * rr2); }
    c.closePath(); c.stroke();
  },
  puzzle(c, x, y, s) {
    c.beginPath(); roundRect(c, x - s * 0.45, y - s * 0.45, s * 0.9, s * 0.9, s * 0.2); c.stroke();
    c.beginPath(); c.arc(x + s * 0.45, y - s * 0.1, s * 0.17, 0, TAU); c.stroke();
  },
};

function buildBrowser(o) {
  const arc = o.variant === 'arc';
  const W = 1440;
  const R = arc ? 18 : o.variant === 'chrome' ? 12 : 14;
  const barH = arc ? 46 : o.variant === 'chrome' ? 84 : o.variant === 'minimal' ? 40 : 52;
  const pad = arc ? 13 : 0;
  const cw = W - pad * 2;
  const contentH = Math.round(cw / Math.max(0.25, o.contentAspect));
  const H = barH + contentH + pad;
  const dark = o.theme === 'dark';
  const s = { x: pad, y: barH, w: cw, h: contentH, r: arc ? 12 : R };
  const spath = arc
    ? (c) => roundRect(c, pad, barH, cw, contentH, 12)
    : (c) => roundRect(c, 0, barH, W, contentH, 0, 0, R, R);
  const chromeBg = dark ? (o.variant === 'chrome' ? '#35363a' : '#2b2c30') : (o.variant === 'chrome' ? '#ffffff' : '#e9e9ec');
  const inkHi = dark ? '#e8eaee' : '#1f2226';
  const inkLo = dark ? '#9aa0aa' : '#5f6570';
  const pillBg = dark ? '#1e1f23' : '#f1f2f5';
  function lights(c, cy) {
    ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => {
      const cx = 22 + i * 20;
      c.beginPath(); c.arc(cx, cy, 6, 0, TAU); c.fillStyle = col; c.fill();
      c.beginPath(); c.arc(cx, cy, 6, 0, TAU); c.strokeStyle = 'rgba(0,0,0,.14)'; c.lineWidth = 0.9; c.stroke();
      c.beginPath(); c.arc(cx - 1.6, cy - 2, 2.4, 0, TAU); c.fillStyle = 'rgba(255,255,255,.35)'; c.fill();
    });
  }
  return {
    w: W, h: H, screen: s, screenPath: spath,
    silhouette(c) { roundRect(c, 0, 0, W, H, R); },
    body(c) {
      c.beginPath(); roundRect(c, 0, 0, W, H, R); c.fillStyle = chromeBg; c.fill();
      c.beginPath(); roundRect(c, 0, 0, W, barH, R, R, 0, 0);
      c.fillStyle = lg(c, 0, 0, 0, barH, dark ? [[0, '#3a3b40'], [1, '#2a2b2f']] : [[0, '#fbfbfc'], [1, '#e6e6ea']]);
      c.fill();
      if (arc) {
        c.beginPath(); roundRect(c, 0, 0, W, H, R);
        c.fillStyle = lg(c, 0, 0, 0, H, dark ? [[0, '#332a4d'], [1, '#241e39']] : [[0, '#ece2fa'], [1, '#ded1f2']]);
        c.fill();
        lights(c, barH * 0.52);
        c.fillStyle = dark ? 'rgba(205,192,238,.78)' : 'rgba(94,74,140,.78)';
        c.font = '500 12.5px Inter, -apple-system, sans-serif'; c.textAlign = 'center';
        c.fillText(o.url, W / 2, barH * 0.52 + 4.5); c.textAlign = 'left';
        ico(c, dark ? 'rgba(205,192,238,.8)' : 'rgba(94,74,140,.8)', 1.6);
        ICONS.sidebar(c, 108, barH * 0.52, 16);
        ICONS.reload(c, W - 34, barH * 0.52, 15);
        ICONS.plus(c, W - 72, barH * 0.52, 15);
        c.save();
        c.shadowColor = 'rgba(20,10,40,.30)'; c.shadowBlur = 16; c.shadowOffsetY = 3;
        c.beginPath(); spath(c); c.fillStyle = dark ? '#15121f' : '#ffffff'; c.fill();
        c.restore();
      } else if (o.variant === 'chrome') {
        c.beginPath(); roundRect(c, 0, 0, W, 40, R, R, 0, 0);
        c.fillStyle = dark ? '#202124' : '#dee1e6'; c.fill();
        c.beginPath(); roundRect(c, 8, 6, 250, 36, 10, 10, 0, 0);
        c.fillStyle = dark ? '#35363a' : '#ffffff'; c.fill();
        c.beginPath(); c.arc(28, 24, 7, 0, TAU); c.fillStyle = '#5ee08a'; c.fill();
        c.fillStyle = inkHi; c.font = '500 13px Inter, -apple-system, sans-serif';
        c.fillText(o.title || 'GreenLight Dash', 44, 29);
        ico(c, inkLo, 1.5); ICONS.plus(c, 244, 24, 11);
        c.beginPath(); roundRect(c, 272, 12, 170, 24, 8);
        c.fillStyle = dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.05)'; c.fill();
        ico(c, inkLo, 1.6); ICONS.plus(c, 462, 24, 13);
        ico(c, inkLo, 1.8);
        ICONS.chevL(c, 26, 62, 15); ICONS.chevR(c, 60, 62, 15); ICONS.reload(c, 94, 62, 17); ICONS.home(c, 128, 62, 15);
        c.beginPath(); roundRect(c, 152, 48, W - 152 - 150, 28, 14); c.fillStyle = pillBg; c.fill();
        ico(c, inkLo, 1.5); ICONS.shield(c, 172, 62, 13);
        c.fillStyle = inkLo; c.font = '400 13px Inter, -apple-system, sans-serif';
        c.fillText(o.url, 190, 66);
        ico(c, inkLo, 1.7);
        ICONS.star(c, W - 176, 62, 15); ICONS.puzzle(c, W - 106, 62, 15); ICONS.dots(c, W - 30, 62, 15);
        c.beginPath(); c.arc(W - 66, 62, 11, 0, TAU); c.fillStyle = dark ? '#4b5563' : '#c7cbd2'; c.fill();
      } else if (o.variant === 'minimal') {
        lights(c, barH / 2);
        c.fillStyle = inkLo; c.font = '600 12.5px Inter, -apple-system, sans-serif'; c.textAlign = 'center';
        c.fillText(o.title || 'GreenLight Dash', W / 2, barH / 2 + 4.5); c.textAlign = 'left';
      } else {
        lights(c, barH / 2);
        ico(c, inkLo, 1.7);
        ICONS.sidebar(c, 98, 26, 17); ICONS.chevL(c, 140, 26, 15); ICONS.chevR(c, 172, 26, 15);
        const pw = 430; const pxx = (W - pw) / 2;
        c.beginPath(); roundRect(c, pxx, 11, pw, 30, 8);
        c.fillStyle = dark ? '#1e1f23' : '#dfdfe4'; c.fill();
        ico(c, inkLo, 1.4); ICONS.shield(c, pxx + 20, 26, 13);
        c.fillStyle = dark ? '#c9ced6' : '#37393e';
        c.font = '400 13px Inter, -apple-system, sans-serif'; c.textAlign = 'center';
        c.fillText(o.url, W / 2 + 6, 30.5); c.textAlign = 'left';
        ico(c, inkLo, 1.5); ICONS.reload(c, pxx + pw - 20, 26, 15);
        ico(c, inkLo, 1.7);
        ICONS.down(c, W - 150, 26, 16); ICONS.share(c, W - 110, 26, 16); ICONS.plus(c, W - 70, 26, 16); ICONS.tabs(c, W - 30, 26, 16);
      }
      c.beginPath(); c.moveTo(0, barH - 0.5); c.lineTo(W, barH - 0.5);
      c.strokeStyle = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.10)'; c.lineWidth = 1; c.stroke();
    },
    front(c) {
      if (arc) { c.beginPath(); spath(c); c.strokeStyle = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.07)'; c.lineWidth = 1; c.stroke(); }
      c.beginPath(); roundRect(c, 0.5, 0.5, W - 1, H - 1, R);
      c.strokeStyle = dark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.13)'; c.lineWidth = 1; c.stroke();
      glassGlare(c, s, o.glare * 0.5, spath);
    },
  };
}

/* ------------------------------------------------- frames from vector artwork
   Third-party CC BY-SA SVGs (see assets/mockupFrames/CREDITS.md). The file is
   rasterised into an offscreen at the size the current draw needs and re-rendered when
   that grows, so it stays as sharp as the path-built frames — never a fixed sprite.
   Every S.* fraction is against the frame WIDTH, so one number set survives any size. */
const SVG_ASSETS = new Map();
/* An artwork frame decodes asynchronously. Without this the first frame draws nothing and
   NOTHING asks for another one, so the device is simply invisible until some unrelated
   edit forces a redraw — which is exactly how the iMac shipped. */
let SVG_INVALIDATE = null;
export function setMockupSvgInvalidate(fn) { SVG_INVALIDATE = typeof fn === 'function' ? fn : null; }
export function primeMockupSvg(url) {
  let a = SVG_ASSETS.get(url);
  if (!a) {
    a = { img: null, ready: false, lod: null };
    SVG_ASSETS.set(url, a);
    if (typeof Image !== 'undefined') {
      const img = new Image();
      a.img = img;
      img.onload = () => { a.ready = true; if (SVG_INVALIDATE) SVG_INVALIDATE(); };
      img.src = url;
    }
  }
  return a;
}
function drawSvgAsset(c, a, w, h) {
  if (!a.ready || !a.img) return;
  const need = clamp(Math.ceil(w * QSCALE), 64, 8192);
  const lod = Math.min(8192, Math.pow(2, Math.ceil(Math.log2(need))));
  if (!a.lod || a.lod.w !== lod) {
    const oc = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(lod, Math.max(1, Math.round(lod * h / w)))
      : Object.assign(document.createElement('canvas'), { width: lod, height: Math.max(1, Math.round(lod * h / w)) });
    const octx = oc.getContext('2d');
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(a.img, 0, 0, oc.width, oc.height);
    a.lod = { w: lod, c: oc };
  }
  c.drawImage(a.lod.c, 0, 0, w, h);
}
function buildSvgFrame(o, S) {
  const a = primeMockupSvg(S.url);
  const w = S.w;
  const h = w * S.ratio;
  const s = { x: w * S.sx, y: w * S.sy, w: w * S.sw, h: w * S.sh, r: w * (S.sr || 0) };
  const spath = (c) => { if (s.r) roundRect(c, s.x, s.y, s.w, s.h, s.r); else c.rect(s.x, s.y, s.w, s.h); };
  return {
    // The artwork is transparent past the phone's silhouette, so the shader needs
    // the analytic corner radius to keep media out of the screen RECT's corners.
    w, h, screen: s, screenPath: spath, svgReady: () => a.ready, screenClipR: s.r,
    silhouette(c) { roundRect(c, 0, 0, w, h, w * 0.02); },
    shadowCast(c) { drawSvgAsset(c, a, w, h); },   // the shadow follows the artwork's alpha
    body(c) { drawSvgAsset(c, a, w, h); },
    front(c) {
      glassGlare(c, s, o.glare, spath);
      if (S.island) {   // the artwork paints it under where the media now sits
        const i = S.island;
        const ix = w * i.x; const iy = w * i.y; const iw = w * i.w; const ih = w * i.h;
        c.beginPath(); roundRect(c, ix, iy, iw, ih, ih / 2); c.fillStyle = '#000'; c.fill();
        const cx = ix + iw - ih * 0.52; const cy = iy + ih * 0.5; const cr = ih * 0.21;
        c.beginPath(); c.arc(cx, cy, cr, 0, TAU);
        c.fillStyle = rg(c, cx - cr * 0.3, cy - cr * 0.3, 0, cx, cy, cr, [[0, '#22304a'], [1, '#05060a']]); c.fill();
      }
    },
  };
}

/* ------------------------------------------------------------------- pass
   The layer's plate is not displaced — it is RE-SEATED. So this is an inverse map like
   the pin: every fragment asks "which part of the chassis am I, and if I am its display,
   which pixel of the plate lands here". Chrome is sampled from a canvas texture the
   caller re-draws at the isolate's live pixel size; the display is punched out of it, so
   one texture carries both the frame and the glare that sits ABOVE the artwork. */


/* The chassis is painted ON THE LAYER'S PLANE, so it goes through the same projective
   map the plane itself did: a 3x3 homography from box uv (y down) to frame uv, fitted
   to the four projected box corners (see layerPlaneBox in Player). The warps use the
   two-axis affine frame instead, which is exact for a flat layer but flattens a 3D
   tilt — the screen kept its keystone while the frame around it stayed a rectangle.
   The quad is a FRAME-uv rectangle (the projected chassis bounds, clamped to the frame)
   and every fragment inverts the homography itself, so a tilt steep enough to throw a
   quad corner behind the camera still draws — an overscanned box quad could not. */
const MF_COMMON = /* glsl */`
  uniform mat3 uHom;         // box uv (y down) -> frame uv, homogeneous
  uniform mat3 uHomInv;      // frame uv -> box uv, homogeneous
  uniform vec4 uQuad;        // frame-uv rect the quad covers (x0, y0, x1, y1)

  vec2 boxToFrame(vec2 b) {
    vec3 h = uHom * vec3(b, 1.0);
    return h.xy / h.z;
  }
`;

const MF_VERTEX = /* glsl */`
  precision highp float;
  attribute vec2 aRest;
  varying vec2 vFrame;
${MF_COMMON}
  void main() {
    vFrame = mix(uQuad.xy, uQuad.zw, aRest);
    gl_Position = vec4(vFrame * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const MF_FRAGMENT = /* glsl */`
  precision highp float;
  uniform sampler2D uTexture;    // the layer isolate, premultiplied
  uniform sampler2D uChassis;    // body/shadow with display punched out, straight alpha
  uniform sampler2D uFront;      // glare/island/front details, straight alpha
  uniform vec2 uBoxPx;           // layer box size in plate px
  uniform vec2 uDevSize;         // chassis bounds in device units
  uniform vec2 uTexSize;         // the PADDED field the chassis texture covers
  uniform float uPad;            // shadow margin, device units
  uniform vec2 uCenter;          // chassis centre, box px
  uniform vec2 uRot;             // cos, sin of the chassis rotation
  uniform float uInvScale;       // device units per box px
  uniform vec4 uScreen;          // display rect in device units (x, y, w, h)
  uniform vec2 uMediaC;          // artwork centre, device units
  uniform vec2 uMediaRot;        // cos, sin
  uniform vec2 uMediaInv;        // 1 / (scale * media size), device units -> uv
  uniform float uMediaWrap;      // 1 = tile the artwork (fract the uv) so a scroll never ends
  uniform float uScreenR;        // artwork frames only: analytic screen corner radius
  uniform float uSeated;         // 1 = the isolate already holds the artwork seated in the screen
  uniform vec3 uScreenBg;
  varying vec2 vFrame;
${MF_COMMON}

  void main() {
    // frame uv -> box uv through the inverse homography; a point past the camera
    // plane has no box position and draws nothing.
    vec3 bh = uHomInv * vec3(vFrame, 1.0);
    if (bh.z <= 1e-6) discard;
    vec2 vRest = bh.xy / bh.z;
    // box uv -> chassis-local device units (the inverse of translate/rotate/scale)
    vec2 q = vRest * uBoxPx - uCenter;
    vec2 r = vec2(q.x * uRot.x + q.y * uRot.y, -q.x * uRot.y + q.y * uRot.x);
    vec2 d = r * uInvScale + uDevSize * 0.5;

    vec2 dUV = (d + vec2(uPad)) / uTexSize;
    vec4 under = vec4(0.0);
    vec4 front = vec4(0.0);
    if (dUV.x >= 0.0 && dUV.x <= 1.0 && dUV.y >= 0.0 && dUV.y <= 1.0) {
      // A canvas upload arrives with STRAIGHT alpha — WebGL un-premultiplies the 2D
      // backing store — so it has to be premultiplied here. Reading it as premultiplied
      // blows the glare out to solid white over the artwork.
      vec2 cuv = vec2(dUV.x, 1.0 - dUV.y);
      vec4 rawUnder = texture2D(uChassis, cuv);
      vec4 rawFront = texture2D(uFront, cuv);
      under = vec4(rawUnder.rgb * rawUnder.a, rawUnder.a);
      front = vec4(rawFront.rgb * rawFront.a, rawFront.a);
    }

    // The exact rounded/continuous display shape comes from the complementary alpha
    // punched into the underlay with the device's real Canvas2D path.
    vec4 media = vec4(0.0);
    vec2 rel = d - uScreen.xy;
    float inScreen = 0.0;
    if (rel.x >= 0.0 && rel.y >= 0.0 && rel.x <= uScreen.z && rel.y <= uScreen.w) {
      // The underlay was punched with THE DEVICE'S ACTUAL Canvas2D screenPath.
      // Its missing alpha is therefore the exact complementary screen coverage,
      // including the same antialiasing as the metal edge. Re-solving the rounded
      // rect here produced a second, slightly different edge and squared the
      // coverage into the dark border that surrounded every screen.
      inScreen = clamp(1.0 - under.a, 0.0, 1.0);
      // An ARTWORK chassis is transparent past its own silhouette, so complementary
      // alpha alone lets media leak into the square corners of the screen rect
      // there. The analytic corner only kills pixels clearly OUTSIDE the rounded
      // path (its feather starts half a plate px past the edge), so wherever the
      // bezel exists the punched alpha still owns the coverage single-handedly.
      if (uScreenR > 0.0) {
        vec2 hc = uScreen.zw * 0.5;
        vec2 pq = abs(rel - hc) - hc + vec2(uScreenR);
        float sd = length(max(pq, 0.0)) - uScreenR;
        float fe = max(uInvScale, 1e-4);
        inScreen *= 1.0 - smoothstep(0.5 * fe, 1.5 * fe, sd);
      }
    }
    if (inScreen > 0.0) {
      vec2 m = d - uMediaC;
      vec2 mr = vec2(m.x * uMediaRot.x + m.y * uMediaRot.y, -m.x * uMediaRot.y + m.y * uMediaRot.x);
      vec2 uv = mr * uMediaInv + 0.5;
      if (uMediaWrap > 0.5) uv = fract(uv);
      // the backdrop shows wherever the artwork does not reach (contain, or scaled down)
      media = vec4(uScreenBg, 1.0);
      if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
        // Seated isolate: the artwork is already where this fragment is. Otherwise
        // (a plate that could not be re-posed) read it from where the box projects.
        vec4 src = texture2D(uTexture, uSeated > 0.5 ? vFrame : boxToFrame(uv));
        media = src + media * (1.0 - src.a);
      }
      media *= inScreen;
    }

    // Exact lab order: punched body + clipped media (complementary coverages), then
    // the separate front glass/island texture source-over both. Keeping glare out of
    // the underlay is what prevents it from attenuating the screen edge twice.
    vec4 bodyAndMedia = under + media;
    gl_FragColor = front + bodyAndMedia * (1.0 - front.a);
    if (gl_FragColor.a <= 0.0) discard;
  }
`;

export function createMockupFramePass(THREE) {
  const geometry = new THREE.BufferGeometry();
  const rest = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
  geometry.setAttribute('aRest', new THREE.BufferAttribute(rest, 2));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 2, 1, 0, 3, 2]), 1));

  const material = new THREE.ShaderMaterial({
    vertexShader: MF_VERTEX,
    fragmentShader: MF_FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,   // the isolate is premultiplied
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: {
      uTexture: { value: null },
      uChassis: { value: null },
      uFront: { value: null },
      uHom: { value: new THREE.Matrix3() },
      uHomInv: { value: new THREE.Matrix3() },
      uQuad: { value: new THREE.Vector4(0, 0, 1, 1) },
      uBoxPx: { value: new THREE.Vector2(1920, 1080) },
      uDevSize: { value: new THREE.Vector2(1, 1) },
      uTexSize: { value: new THREE.Vector2(1, 1) },
      uPad: { value: 0 },
      uCenter: { value: new THREE.Vector2(0, 0) },
      uRot: { value: new THREE.Vector2(1, 0) },
      uInvScale: { value: 1 },
      uScreen: { value: new THREE.Vector4(0, 0, 1, 1) },
      uMediaC: { value: new THREE.Vector2(0, 0) },
      uMediaRot: { value: new THREE.Vector2(1, 0) },
      uMediaInv: { value: new THREE.Vector2(1, 1) },
      uMediaWrap: { value: 0 },
      uScreenR: { value: 0 },
      uSeated: { value: 0 },
      uScreenBg: { value: new THREE.Color('#0b0d12') },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return { scene, mesh, geometry, material };
}

/* The chassis canvas is re-drawn whenever the params or the on-screen size change, and
   only then — the redraw is the expensive part and a still frame must not repeat it. */
export function updateMockupChassisCanvas(state, dev, p, boxPx, scale) {
  const pad = mockupShadowPad(dev, p);
  const fw = dev.w + pad * 2;
  const fh = dev.h + pad * 2;
  const px = Math.max(16, Math.min(8192, Math.round(fw * scale)));
  let lod = Math.min(8192, Math.pow(2, Math.ceil(Math.log2(px))));
  // Chromium renders a 2D canvas BLANK past its area cap instead of throwing, so the
  // per-axis limit is not enough on a tall chassis.
  while (lod > 256 && lod * (lod * fh / fw) > 36e6) lod /= 2;
  const key = `${p.mfDevice}|${p.mfFinish}|${p.mfOrient}|${p.mfVariant}|${p.mfTheme}|${p.mfUrl}|`
    + `${p.mfContentAspect}|${p.mfStand}|${p.mfNano}|${p.mfBand}|${p.mfGlare}|${p.mfScreenBg}|`
    + `${p.mfShadow}|${p.mfShadowBlur}|${p.mfShadowY}|${p.mfShadowSpread}|${lod}|`
    + `${dev.svgReady ? (dev.svgReady() ? 1 : 0) : 1}`;
  if (state.key === key && state.canvas && state.frontCanvas) return false;
  const h = Math.max(1, Math.round(lod * fh / fw));
  if (!state.canvas) state.canvas = document.createElement('canvas');
  if (!state.frontCanvas) state.frontCanvas = document.createElement('canvas');
  const cv = state.canvas;
  const fv = state.frontCanvas;
  if (cv.width !== lod || cv.height !== h) { cv.width = lod; cv.height = h; }
  if (fv.width !== lod || fv.height !== h) { fv.width = lod; fv.height = h; }
  const ctx = cv.getContext('2d');
  const fctx = fv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  fctx.setTransform(1, 0, 0, 1, 0, 0);
  fctx.clearRect(0, 0, fv.width, fv.height);
  const unit = lod / fw;
  ctx.setTransform(unit, 0, 0, unit, unit * pad, unit * pad);
  fctx.setTransform(unit, 0, 0, unit, unit * pad, unit * pad);
  renderMockupChassisUnderlay(ctx, dev, p, unit);
  renderMockupChassisFront(fctx, dev, unit);
  state.key = key;
  state.pad = pad;
  state.frameW = fw;
  state.frameH = fh;
  return true;
}

/* Where the chassis (with its shadow margin) lands in box uv, unioned with the box
   itself: the geometry stages that follow Mockup Frame reshape THIS rectangle, so a
   chassis that overflows the layer box (`Screen = box`) still bends and pins whole. */
export function mockupChassisBoundsUv(dev, layout, pad, boxW, boxH) {
  const s = layout.scale;
  const fw = (dev.w + pad * 2) * s;
  const fh = (dev.h + pad * 2) * s;
  const c = Math.abs(Math.cos(layout.rot));
  const sn = Math.abs(Math.sin(layout.rot));
  const hx = (fw * c + fh * sn) / 2;
  const hy = (fw * sn + fh * c) / 2;
  return [
    Math.min(0, (layout.cx - hx) / boxW),
    Math.min(0, (layout.cy - hy) / boxH),
    Math.max(1, (layout.cx + hx) / boxW),
    Math.max(1, (layout.cy + hy) / boxH),
  ];
}

/* The affine layer box grown to a box-uv rectangle [x0, y0, x1, y1] ⊇ [0,1]². Returns
   the input box untouched when nothing overflows, so a fitted chassis changes nothing
   for the stages after it. */
export function expandLayerBox(box, b) {
  const [x0, y0, x1, y1] = b;
  if (x0 >= 0 && y0 >= 0 && x1 <= 1 && y1 <= 1) return box;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const lx = cx * 2 - 1;
  const ly = 1 - cy * 2;
  const [ox, oy] = box.origin;
  const [ax, ay] = box.axisX;
  const [bx, by] = box.axisY;
  const kx = x1 - x0;
  const ky = y1 - y0;
  return {
    origin: [ox + ax * lx + bx * ly, oy + ay * lx + by * ly],
    axisX: [ax * kx, ay * kx],
    axisY: [bx * ky, by * ky],
    sizePx: [box.sizePx[0] * kx, box.sizePx[1] * ky],
  };
}

/* Frame-uv rectangle the pass has to cover: the box-uv bounds `b` ([x0, y0, x1, y1])
   projected through H and clamped to the frame. Any corner at or past the camera
   plane makes the region unbounded, so the whole frame is drawn. */
export function mockupPassQuad(H, b) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [u, v] of [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]) {
    const q = homographyApply(H, u, v);
    if (!(q[2] > 1e-4)) return [0, 0, 1, 1];
    const x = q[0] / q[2]; const y = q[1] / q[2];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [0, 0, 1, 1];
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  // One px of slack for the edge antialiasing and the rounding of the bounds.
  const s = 0.002;
  return [Math.max(0, x0 - s), Math.max(0, y0 - s), Math.min(1, x1 + s), Math.min(1, y1 + s)];
}

/* `box.sizePlane` (the box measured ON THE LAYER'S PLANE) is the unit the chassis is
   laid out in when the caller supplies it; the projected `sizePx` is exact only for a
   flat layer. `quad` is the frame-uv rect from mockupPassQuad (default: the frame). */
export function applyMockupFrameUniforms(material, dev, p, layout, box, chassisTexture, frontTexture, pad, quad = null, seated = false) {
  const u = material.uniforms;
  if (u.uSeated) u.uSeated.value = seated ? 1 : 0;
  const pd = Number.isFinite(pad) ? pad : 0;
  u.uPad.value = pd;
  u.uTexSize.value.set(dev.w + pd * 2, dev.h + pd * 2);
  let H = box.hom || affineBoxHomography(box);
  let Hi = invertHomography(H);
  if (!Hi) { H = affineBoxHomography(box); Hi = invertHomography(H) || [1, 0, 0, 0, 1, 0, 0, 0, 1]; }
  u.uHom.value.set(H[0], H[1], H[2], H[3], H[4], H[5], H[6], H[7], H[8]);
  u.uHomInv.value.set(Hi[0], Hi[1], Hi[2], Hi[3], Hi[4], Hi[5], Hi[6], Hi[7], Hi[8]);
  const q = quad || [0, 0, 1, 1];
  u.uQuad.value.set(q[0], q[1], q[2], q[3]);
  const size = box.sizePlane || box.sizePx;
  const bw = Math.max(1, size[0]);
  const bh = Math.max(1, size[1]);
  u.uBoxPx.value.set(bw, bh);
  u.uDevSize.value.set(dev.w, dev.h);
  u.uCenter.value.set(layout.cx, layout.cy);
  u.uRot.value.set(Math.cos(layout.rot), Math.sin(layout.rot));
  u.uInvScale.value = layout.scale > 1e-6 ? 1 / layout.scale : 1;
  const s = dev.screenLocal || dev.screen;
  u.uScreen.value.set(s.x, s.y, s.w, s.h);
  u.uScreenR.value = dev.screenClipR || 0;
  const m = mockupMediaPlacement(dev, p, bw, bh);
  u.uMediaC.value.set(m.cx, m.cy);
  u.uMediaRot.value.set(Math.cos(m.rot), Math.sin(m.rot));
  u.uMediaInv.value.set(1 / Math.max(1e-6, m.sx * bw), 1 / Math.max(1e-6, m.sy * bh));
  if (u.uMediaWrap) u.uMediaWrap.value = p.mfScrollWrap ? 1 : 0;
  u.uScreenBg.value.set(p.mfScreenBg || '#0b0d12');
  u.uChassis.value = chassisTexture || null;
  u.uFront.value = frontTexture || null;
}

/* "Is this doing anything" — a chain entry with no device chosen still frames the layer,
   so unlike the warps there is no identity pose to compare against. */
export function isMockupFrameActive(item) {
  const effect = getMockupEffect(item);
  return Boolean(effect) && effect.enabled !== false;
}
