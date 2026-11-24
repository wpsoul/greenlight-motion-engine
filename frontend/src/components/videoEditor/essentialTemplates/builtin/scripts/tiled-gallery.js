// Tiled Gallery (MotionFast `tiled-gallery`): an endless wall of media tiles whose lines slide past each other while a
// camera moves over it (drift, push in, pull out, sway, handheld); the intro pulls back from one tile to the wall, the
// outro pushes in until one tile fills the frame (the lines ease to a halt first).
//
// Built from ordinary layers and the sequence's own camera: the wall is laid out at the base zoom, and the camera (zoom,
// pan, roll) is MotionFast's view: the editor's camera draws screen = centre + zoom·R(roll)·(p − centre) − pan, the
// same similarity MotionFast's canvas applies. The camera's tracks are keyed by fitted pieces of MotionFast's own camera
// path (its log-space dolly, the AE Smooth intro / outro, the sway's sines, the handheld's steps 24 a second), within
// about 0.2 px.
//
// The tiles: as many layers as there are tiles ON SCREEN AT ONE TIME, not over the clip. Every tile copy's time on
// screen is found first (120 samples a second and both sides of each handheld step; a copy counts from the first step
// in which its rect, swept from the step's start to its end, comes within 2 px of the frame, to the last). A layer then
// shows one copy after another: when the copy it shows has left the frame for good and before the next one comes in,
// its keys jump (a Hold key 0.1 ms before the jump) to the next copy's place on its own line, so between its keys a
// layer always draws a real copy where MotionFast draws it (straight with its line, then the scroll's ease to rest: the
// app's Ease Out, exact). A layer only ever shows copies of one picture and one size (a photo, or a plate colour), so
// its picture never has to change; per picture, copies are handed to layers in the order they come in (the first layer
// that is free), which takes exactly as many layers as that picture has copies on screen at once. Where a wall shows
// more tiles at once than a template has layers (dense walls zoomed out: 12 lines of flat or tall tiles), each picture
// gets a share of the layers, a copy that finds all of its picture's layers busy waits for one to come free, and a
// warning says when and how many tiles are left out.
//
// A built-in script (PLANS/ESSENTIAL_TEMPLATES.md §14): it imports nothing, so this same text also runs as a
// `kind: "script"` source. Numbers and timing are MotionFast's (motionTemplates/tiledGallery.js).
const PALETTE = ['#f9492d', '#1d9bf1', '#ffffff', '#33efab', '#f9492d', '#ffffff', '#1d9bf1', '#33efab'];
const RATIOS = [0.72, 1.0, 1.34, 1.75];
const TAU = Math.PI * 2;
const AE_SMOOTH = [0.882083327, 0, 0.2445833683, 1];
const MAX_LAYERS = 400;   // the layers a template may have (scriptGuest.js SCRIPT_LIMITS.layers): the camera's and the tiles'
const RATE = 120;         // visibility samples a second
const PAD = 2;            // px around the frame within which a tile counts as on screen
const GAP = 0.004;        // s a layer's copy and its next one are both off screen, at least (the jump lies in it)

const fields = [
  { type: 'group', key: 'gMedia', label: 'Media' },
  { key: 'media', type: 'media', label: 'Media', slots: { from: 'media', max: 64 }, accept: 'media', ifFewer: 'reuse' },
  { type: 'group', key: 'gLayout', label: 'Layout' },
  { key: 'layout', type: 'select', label: 'Layout', default: 'grid', options: [
    { value: 'grid', label: 'Grid (uniform tiles)' }, { value: 'masonry', label: 'Masonry (mixed widths)' },
  ] },
  { key: 'masonryVariance', type: 'range', label: 'Masonry variance', default: 60, min: 0, max: 100, step: 1, suffix: '%', showIf: { key: 'layout', equals: 'masonry' } },
  { key: 'columns', type: 'range', label: 'Columns', default: 3, min: 1, max: 12, step: 1, integer: true },
  { key: 'rows', type: 'range', label: 'Rows', default: 2, min: 1, max: 12, step: 1, integer: true },
  { key: 'tileWidth', type: 'range', label: 'Tile width', default: 420, min: 80, max: 900, step: 5 },
  { key: 'tileAspect', type: 'range', label: 'Tile aspect', default: 1, min: 0.4, max: 2.5, step: 0.05 },
  { key: 'gap', type: 'range', label: 'Gap', default: 26, min: 0, max: 160, step: 1 },
  { type: 'group', key: 'gTiles', label: 'Tiles' },
  { key: 'tileRadius', type: 'range', label: 'Tile radius', default: 20, min: 0, max: 120, step: 1 },
  { key: 'tileOpacity', type: 'range', label: 'Tile opacity', default: 100, min: 0, max: 100, step: 1, suffix: '%' },
  { key: 'placeholderColor', type: 'text', label: 'Plate colour', default: '' },
  { type: 'group', key: 'gCamera', label: 'Camera & Motion' },
  { key: 'axis', type: 'select', label: 'Line axis', default: 'horizontal', options: [
    { value: 'horizontal', label: 'Rows slide sideways' }, { value: 'vertical', label: 'Columns slide up/down' },
  ] },
  { key: 'lineMotion', type: 'select', label: 'Line motion', default: 'alternate', options: [
    { value: 'alternate', label: 'Alternate directions' }, { value: 'same', label: 'All one direction' }, { value: 'wave', label: 'Wave (speed varies)' },
    { value: 'seeded', label: 'Random per line' }, { value: 'still', label: 'Static wall' },
  ] },
  { key: 'cameraMove', type: 'select', label: 'Camera', default: 'drift', options: [
    { value: 'static', label: 'Locked off' }, { value: 'drift', label: 'Diagonal drift' }, { value: 'pushIn', label: 'Slow push in' },
    { value: 'pullOut', label: 'Slow pull out' }, { value: 'sway', label: 'Sway / arc' }, { value: 'handheld', label: 'Handheld' },
  ] },
  { key: 'cameraAmount', type: 'range', label: 'Camera amount', default: 100, min: 0, max: 300, step: 5, suffix: '%' },
  { key: 'baseZoom', type: 'range', label: 'Base zoom', default: 100, min: 20, max: 400, step: 1, suffix: '%' },
  { key: 'tilt', type: 'range', label: 'Wall tilt', default: 0, min: -20, max: 20, step: 0.5, suffix: '°' },
  { type: 'group', key: 'gInOut', label: 'Intro & Outro' },
  { key: 'startFullView', type: 'switch', label: 'Start with full view', default: true },
  { key: 'introDuration', type: 'range', label: 'Intro length', default: 1.7, min: 0.2, max: 6, step: 0.05, suffix: 's' },
  { key: 'introZoom', type: 'range', label: 'Intro tile fill', default: 100, min: 40, max: 200, step: 1, suffix: '%' },
  { key: 'endFullView', type: 'switch', label: 'End with full view', default: true },
  { key: 'outroDuration', type: 'range', label: 'Outro length', default: 1.7, min: 0.2, max: 6, step: 0.05, suffix: 's' },
  { key: 'outroZoom', type: 'range', label: 'Outro tile fill', default: 100, min: 40, max: 200, step: 1, suffix: '%' },
  { type: 'group', key: 'gTiming', label: 'Timing' },
  { key: 'speed', type: 'range', label: 'Speed', default: 1, min: 0, max: 4, step: 0.05 },
  { key: 'duration', type: 'range', label: 'Duration', default: 5, min: 1, max: 30, step: 0.5, suffix: 's' },
];

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;
const r6 = (v) => { const x = Math.round(v * 1e6) / 1e6; return Object.is(x, -0) ? 0 : x; };
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const n = (v) => { const x = Number(v); return Math.abs(x) < 1e-12 ? '0' : String(Number(x.toPrecision(10))); };
const noise = (x) => { const y = Math.sin(x) * 10000; return y - Math.floor(y); };
const eoc = (t) => 1 - Math.pow(1 - clamp01(t), 3);
const eioc = (t) => { t = clamp01(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
function bezierCurve(p1x, p1y, p2x, p2y) {   // easingEngine.bezierEase: the same numbers
  const bx = (t) => 3 * p1x * t * (1 - t) * (1 - t) + 3 * p2x * t * t * (1 - t) + t * t * t;
  const by = (t) => 3 * p1y * t * (1 - t) * (1 - t) + 3 * p2y * t * t * (1 - t) + t * t * t;
  return (x) => {
    x = clamp01(x);
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 24; i += 1) { const cx = bx(t); if (Math.abs(cx - x) < 1e-4) break; if (cx < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return by(t);
  };
}
// AE Smooth solved to the end (MotionFast's solver stops at 1e-4 of x: a jitter far under a pixel that a fit must not
// chase); the keys are fitted to this smooth curve
function smoothBezier(p1x, p1y, p2x, p2y) {
  const bx = (t) => 3 * p1x * t * (1 - t) * (1 - t) + 3 * p2x * t * t * (1 - t) + t * t * t;
  const by = (t) => 3 * p1y * t * (1 - t) * (1 - t) + 3 * p2y * t * t * (1 - t) + t * t * t;
  return (x) => { x = clamp01(x); let lo = 0, hi = 1; for (let i = 0; i < 50; i += 1) { const m = (lo + hi) / 2; if (bx(m) < x) lo = m; else hi = m; } return by((lo + hi) / 2); };
}
const aeSmooth = smoothBezier(...AE_SMOOTH);
function lineVelocity(kind, j) {
  switch (kind) {
    case 'still': return 0;
    case 'same': return 1;
    case 'wave': return (j % 2 ? -1 : 1) * (0.55 + 0.45 * Math.sin(j * 1.1));
    case 'seeded': return (noise(j * 7.13 + 1.7) > 0.5 ? 1 : -1) * (0.5 + noise(j * 3.71 + 0.3));
    default: return j % 2 ? -1 : 1;
  }
}
function dolly(k, z0, z1, fromX, fromY, toX, toY) {
  const a = 1 / z0, b = 1 / z1;
  const z = Math.exp(lerp(Math.log(z0), Math.log(z1), k));
  const kp = Math.abs(b - a) > 1e-9 ? clamp01((1 / z - a) / (b - a)) : k;
  return { zoom: z, x: lerp(fromX, toX, kp), y: lerp(fromY, toY, kp) };
}

export default {
  id: 'tiled-gallery',
  name: 'Tiled Gallery',
  category: 'Carousels',
  // 2: a tile layer shows one copy after another (layers as many as tiles on screen at once): templates built at v1 rebuild
  v: 2,
  fields,
  build({ settings: P, media, frame }) {
    const { W, H } = frame;
    const s = H / 1080;
    const cols = Math.max(1, Math.round(num(P.columns, 3))), rows = Math.max(1, Math.round(num(P.rows, 2)));
    const tileW = Math.max(20, num(P.tileWidth, 420)), tileH = Math.max(20, tileW / Math.max(0.1, num(P.tileAspect, 1)));
    const gap = Math.max(0, num(P.gap, 26));
    const stepX = tileW + gap, stepY = tileH + gap;
    const radius = Math.max(0, num(P.tileRadius, 20));
    const horizontal = P.axis !== 'vertical';
    const masonry = P.layout === 'masonry';
    const mVar = clamp01(num(P.masonryVariance, 60) / 100);
    const lines = horizontal ? rows : cols, cells = horizontal ? cols : rows;
    const cellBase = horizontal ? tileW : tileH, crossSize = horizontal ? tileH : tileW, crossStep = horizontal ? stepY : stepX;
    const lineLayouts = [];
    for (let k = 0; k < lines; k += 1) {
      const items = [];
      let cur = 0, maxSize = 0;
      for (let c = 0; c < cells; c += 1) {
        let size = cellBase;
        if (masonry) size = cellBase * (1 + (RATIOS[Math.min(RATIOS.length - 1, Math.floor(noise(k * 17.31 + c * 5.113 + 2.4) * RATIOS.length))] - 1) * mVar);
        items.push({ a: cur, size, cell: c });
        cur += size + gap;
        maxSize = Math.max(maxSize, size);
      }
      lineLayouts.push({ items, period: Math.max(1, cur), maxSize });
    }
    const layoutOf = (j) => lineLayouts[((j % lines) + lines) % lines];
    const widestCell = Math.max(...lineLayouts.map((l) => l.maxSize));
    const D = Math.max(1, num(P.duration, 5));
    const introOn = P.startFullView !== false;
    const introD = Math.min(Math.max(0.2, num(P.introDuration, 1.7)), D);
    const outroOn = !!P.endFullView;
    const outroD = Math.min(Math.max(0.2, num(P.outroDuration, 1.7)), D);
    const outroT0 = Math.max(0, D - outroD), stopD = outroD * 0.55;
    const baseSpeed = num(P.speed, 1) * 150, camAmt = num(P.cameraAmount, 100) / 100, tiltRad = (num(P.tilt, 0) * Math.PI) / 180;
    const scrollTime = (t) => (!outroOn || t <= outroT0 ? t : outroT0 + stopD * eoc((t - outroT0) / stopD));
    const lineOffset = (j, tau) => { const p = layoutOf(j).period, raw = lineVelocity(P.lineMotion, j) * baseSpeed * tau; return ((raw % p) + p) % p; };
    const camera = (t) => {
      const u = D > 0 ? clamp01(t / D) : 0, a = camAmt;
      let zoom = 1, px = 0, py = 0, rot = 0;
      switch (P.cameraMove) {
        case 'drift': px = (u - 0.5) * stepX * 3.0 * a; py = (u - 0.5) * stepY * 1.2 * a; break;
        case 'pushIn': zoom = lerp(1, 1 + 0.45 * a, eioc(u)); break;
        case 'pullOut': zoom = lerp(1 + 0.45 * a, 1, eioc(u)); break;
        case 'sway':
          px = Math.sin(u * TAU * 0.75) * stepX * 0.9 * a; py = Math.cos(u * TAU * 0.55) * stepY * 0.5 * a;
          rot = Math.sin(u * TAU * 0.5) * 0.014 * a; zoom = 1 + 0.10 * a * Math.sin(u * TAU * 0.35); break;
        case 'handheld': {
          const q = Math.round(t * 24);
          px = (noise(q * 0.371) - 0.5) * tileW * 0.22 * a + (u - 0.5) * stepX * 0.7 * a;
          py = (noise(q * 0.517 + 9.1) - 0.5) * tileH * 0.22 * a + (u - 0.5) * stepY * 0.4 * a;
          rot = (noise(q * 0.233 + 3.3) - 0.5) * 0.016 * a; zoom = 1 + 0.05 * a * (noise(q * 0.157 + 5.5) - 0.5); break;
        }
        default: break;
      }
      return { zoom, px, py, rot };
    };
    const nearestTile = (cx, cy, tau) => {
      const along = horizontal ? cx : cy, across = horizontal ? cy : cx;
      const k = Math.round(across / crossStep), L = layoutOf(k), off = lineOffset(k, tau);
      const base = Math.floor((along - off) / L.period);
      let best = null, bestD = Infinity;
      for (let r = base - 1; r <= base + 1; r += 1) for (const it of L.items) {
        const c = off + r * L.period + it.a + it.size / 2, d = Math.abs(c - along);
        if (d < bestD) { bestD = d; best = { c, size: it.size }; }
      }
      return horizontal ? { x: best.c, y: k * crossStep, w: best.size, h: crossSize } : { x: k * crossStep, y: best.c, w: crossSize, h: best.size };
    };
    const blockLen = lineLayouts[0].period;
    const blockFit = Math.min(W / ((horizontal ? blockLen : cols * stepX) * s), H / ((horizontal ? rows * stepY : blockLen) * s)) * 1.02;
    const zr = (num(P.baseZoom, 100) / 100) * blockFit;   // the wall is laid out at this zoom; the camera zooms by view / zr
    const fillZoom = (w, h) => Math.max(W / (w * s), H / (h * s));
    const introTile = nearestTile(0, 0, 0);
    const z0 = Math.max(1e-4, fillZoom(introTile.w, introTile.h) * (num(P.introZoom, 100) / 100));
    const camEnd = camera(D), outroTile = nearestTile(camEnd.px, camEnd.py, scrollTime(D));
    const z1 = Math.max(1e-4, fillZoom(outroTile.w, outroTile.h) * (num(P.outroZoom, 100) / 100));
    // MotionFast's view at time t (render(): the camera path, then the intro and outro dollies)
    const view = (t) => {
      const cam = camera(t);
      let zoom = cam.zoom * zr, px = cam.px, py = cam.py;
      const rot = cam.rot + tiltRad;
      if (introOn && t < introD && zoom > 0) { const d = dolly(aeSmooth(t / introD), z0, zoom, introTile.x, introTile.y, px, py); zoom = d.zoom; px = d.x; py = d.y; }
      if (outroOn && t > outroT0 && zoom > 0) { const d = dolly(aeSmooth((t - outroT0) / outroD), zoom, z1, px, py, outroTile.x, outroTile.y); zoom = d.zoom; px = d.x; py = d.y; }
      return { zoom, px, py, rot };
    };

    // ── keys
    const keysOf = (f, pieces, fs, span) => {
      const pos = (t) => r6(Math.min(100, Math.max(0, ((t - fs) / span) * 100)));
      const out = [];
      for (const [a, b, how] of pieces) {
        if (b - a < 1e-9) continue;
        const { jump, ...ease } = how;
        out.push({ position: pos(a), value: f(a), ...(ease.easing ? ease : { easing: 'Linear' }) });
        if (jump) out.push({ position: pos(b - jump), value: f(b - jump), easing: 'Linear' });
      }
      const last = pieces[pieces.length - 1];
      out.push({ position: pos(last[1]), value: f(last[1]), easing: 'Linear' });
      const same = (x, y) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x));
      const dedup = out.filter((k, i) => i === 0 || k.position > out[i - 1].position);
      if (dedup.every((k) => same(k.value, dedup[0].value))) return [{ position: 0, value: n(dedup[0].value), easing: 'Linear' }];
      return dedup.map((k) => ({ ...k, value: n(k.value) }));
    };
    // the Custom bezier through f at 0, 1/3, 2/3, 1 of [a, b] (x handles at 1/3, 2/3), split while it misses by > tol
    const fitPieces = (f, a, b, tol, out, depth = 0) => {
      const y0 = f(a), y1 = f(a + (b - a) / 3), y2 = f(a + (2 * (b - a)) / 3), y3 = f(b), d = y3 - y0;
      const b1 = (18 * y1 - 9 * y2 - 5 * y0 + 2 * y3) / 6, b2 = (18 * y2 - 9 * y1 - 5 * y3 + 2 * y0) / 6;
      let ez = null;
      if (Math.abs(d) > 1e-9 * Math.max(1, Math.abs(y0))) {
        const p1 = (b1 - y0) / d, p2 = (b2 - y0) / d;
        if (p1 >= -3 && p1 <= 4 && p2 >= -3 && p2 <= 4) ez = { easing: 'Custom', bezier: [0.3333, r4(p1), 0.6667, r4(p2)] };
      }
      const curve = ez ? bezierCurve(...ez.bezier) : (q) => q;
      let worst = 0;
      for (const q of [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9]) worst = Math.max(worst, Math.abs(f(a + (b - a) * q) - (y0 + d * curve(q))));
      if (worst <= tol) { out.push([a, b, ez || { easing: 'Linear' }]); return; }
      if (depth >= 9 || b - a < 2e-3) { out.push([a, b, { easing: 'Linear' }]); return; }
      const m = (a + b) / 2;
      fitPieces(f, a, m, tol, out, depth + 1); fitPieces(f, m, b, tol, out, depth + 1);
    };

    const warnings = [];
    const layers = [];   // the camera's (the tiles' are built after it: its layers come off the budget)

    // ── the camera: zoom = view / zr, roll = the view's turn, pan = R(turn)·zoom·s·(px, py) as % of the frame
    const cam = (t) => {
      const v = view(Math.min(D, Math.max(0, t)));
      const c = Math.cos(v.rot), sn = Math.sin(v.rot), k = v.zoom * s;
      return { camZoom: v.zoom / zr, camRoll: (v.rot * 180) / Math.PI, camX: ((c * v.px - sn * v.py) * k * 100) / W, camY: ((sn * v.px + c * v.py) * k * 100) / H };
    };
    // The camera layers. Intro [0, introD] and outro [outroT0, D]: their keys hold the dolly's progress k on the app's
    // AE Smooth (MotionFast's very curve, solver included) and a ƒx turns k and the time into MotionFast's view; the
    // stretch between them is a ƒx of the time alone. Where the intro still runs when the outro starts (a short clip),
    // [outroT0, D] is keyed by fitted pieces instead (two dollies at once).
    const A = camAmt;
    const nz = (x) => `((sin(${x})*10000)%1+1)%1`;   // MotionFast's noise(): the fraction of sin(x)·10000
    // the camera path at the layer's time + t0 (written without nesting: the ƒx parser caps nesting at 40 levels)
    const camExpr = (t0, t1) => {
      const lin = (k) => (t0 ? `time*${n(k)}+${n(t0 * k)}` : `time*${n(k)}`);
      const u = `(${lin(1 / D)})`;   // the layer lies inside [0, D]: no clamp
      const e = { zoom: '1', px: '0', py: '0', rot: '0' };
      if (P.cameraMove === 'drift') { e.px = `(${u}-0.5)*${n(stepX * 3 * A)}`; e.py = `(${u}-0.5)*${n(stepY * 1.2 * A)}`; }
      else if (P.cameraMove === 'pushIn' || P.cameraMove === 'pullOut') {
        // MotionFast's ease in-out cubic; one branch where the layer lies on one side of the middle
        const io = t1 <= D / 2 + 1e-9 ? `4*pow(${u},3)` : t0 >= D / 2 - 1e-9 ? `(1-pow(2-2*${u},3)/2)` : `(${u}<0.5?4*pow(${u},3):1-pow(2-2*${u},3)/2)`;
        e.zoom = P.cameraMove === 'pushIn' ? `(1+${n(0.45 * A)}*${io})` : `(${n(1 + 0.45 * A)}-${n(0.45 * A)}*${io})`;
      } else if (P.cameraMove === 'sway') {
        e.px = `sin(${u}*${n(TAU * 0.75)})*${n(stepX * 0.9 * A)}`; e.py = `cos(${u}*${n(TAU * 0.55)})*${n(stepY * 0.5 * A)}`;
        e.rot = `sin(${u}*${n(TAU * 0.5)})*${n(0.014 * A)}`; e.zoom = `(1+${n(0.1 * A)}*sin(${u}*${n(TAU * 0.35)}))`;
      } else if (P.cameraMove === 'handheld') {
        // noise(x)·k = (sin(x)·10⁴ − floor(sin(x)·10⁴))·k, written flat; the linear drift's constants folded
        const q = `round(${lin(24)})`;
        const nk = (x, k) => `sin(${x})*${n(1e4 * k)}-floor(sin(${x})*10000)*${n(k)}`;
        const ul = (k) => `${lin(k / D)}`;   // u·k
        e.px = `(${nk(`${q}*0.371`, tileW * 0.22 * A)}+${ul(stepX * 0.7 * A)}-${n(0.5 * tileW * 0.22 * A + 0.5 * stepX * 0.7 * A)})`;
        e.py = `(${nk(`${q}*0.517+9.1`, tileH * 0.22 * A)}+${ul(stepY * 0.4 * A)}-${n(0.5 * tileH * 0.22 * A + 0.5 * stepY * 0.4 * A)})`;
        e.rot = `(${nk(`${q}*0.233+3.3`, 0.016 * A)}-${n(0.008 * A)})`; e.zoom = `(${n(1 - 0.025 * A)}+${nk(`${q}*0.157+5.5`, 0.05 * A)})`;
      }
      return e;
    };
    // MotionFast's dolly as text: zoom from Za to Zb in log space, the pan following 1 / zoom
    const dollyExpr = (K, Za, Zb, fx, fy, tx, ty) => {
      const Z = `pow(${Za},1-${K})*pow(${Zb},${K})`;
      // the pan's share (1/Z − 1/Za) / (1/Zb − 1/Za) = ((Za/Zb)^k − 1) / (Za/Zb − 1): in [0, 1] as the zoom moves between
      // the two (MotionFast clamps it), written shallow for the parser
      const R = `${Za}/(${Zb})`;
      const kp = `(pow(${R},${K})-1)/(${R}-1)`;
      // from·(1 − share) + to·share: each path term written once
      return { Z, X: `${fx}*(1-${kp})+${tx}*${kp}`, Y: `${fy}*(1-${kp})+${ty}*${kp}`, kp };
    };
    const camTracks = (Z, X, Y, rot) => {
      // a fixed turn (only the wall's tilt) is folded into numbers
      const cs = rot === '0' ? n(Math.cos(tiltRad)) : `cos(${rot}+${n(tiltRad)})`, sn = rot === '0' ? n(Math.sin(tiltRad)) : `sin(${rot}+${n(tiltRad)})`;
      return {
        camZoom: `${Z}*${n(1 / zr)}`,
        camRoll: rot === '0' ? n((tiltRad * 180) / Math.PI) : `(${rot}+${n(tiltRad)})*${n(180 / Math.PI)}`,
        camX: `(${cs}*(${X})-${sn}*(${Y}))*${Z}*${n((s * 100) / W)}`,
        camY: `(${sn}*(${X})+${cs}*(${Y}))*${Z}*${n((s * 100) / H)}`,
      };
    };
    // whether ƒx text fits the language's caps (keyframeExpr.js: 600 nodes, 4000 characters, parse depth 40), counted the
    // way its parser counts them
    const fitsFx = (code) => {
      if (code.length > 3900) return false;
      const tk = code.match(/[0-9]*\.?[0-9]+(?:e[-+]?[0-9]+)?|[A-Za-z_][A-Za-z0-9_]*|&&|\|\||[<>=!]=|\*\*|[-+*/%^<>!?:(),]/g) || [];
      const PREC = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '^': 8, '**': 8 };
      let i = 0, nodes = 0, deep = 0;
      const see = (d) => { deep = Math.max(deep, d); if (deep > 40 || nodes > 590) throw new Error('cap'); };
      const expr = (d) => { see(d); bin(0, d + 1); if (tk[i] === '?') { i += 1; expr(d + 1); i += 1; expr(d + 1); nodes += 1; } };
      const bin = (min, d) => { see(d); un(d + 1); for (;;) { const p2 = PREC[tk[i]]; if (p2 === undefined || p2 < min) break; i += 1; bin(tk[i - 1] === '^' || tk[i - 1] === '**' ? p2 : p2 + 1, d + 1); nodes += 1; } };
      const un = (d) => { if (tk[i] === '-' || tk[i] === '+' || tk[i] === '!') { i += 1; nodes += 1; un(d + 1); return; } post(d); };
      const post = (d) => { prim(d); while (tk[i] === '(') { i += 1; if (tk[i] !== ')') for (;;) { expr(d + 1); if (tk[i] === ',') { i += 1; continue; } break; } i += 1; nodes += 1; } };
      const prim = (d) => { const t = tk[i]; i += 1; if (t === '(') { expr(d + 1); i += 1; } else nodes += 1; };
      try { expr(0); return true; } catch (e) { return false; }
    };
    const camLayer = (key, a, b, codes, kOf) => {
      const fs = r4(a), span = r4(b - fs);
      const propertyKeyframes = {}, propertyKeyframeFx = {};
      if (Object.values(codes).some((c) => !fitsFx(c))) { fitted(key, a, b); return; }
      for (const [prop, code] of Object.entries(codes)) {
        propertyKeyframes[prop] = kOf ? [{ position: 0, value: '1', easing: 'AE Smooth' }, { position: 100, value: '2', easing: 'Linear' }] : [{ position: 0, value: '1', easing: 'Linear' }];
        propertyKeyframeFx[prop] = { type: 'custom', params: { code } };
      }
      layers.push({ key, type: 'camera', name: 'Camera', freeStart: fs, trimEnd: span, propertyKeyframes, propertyKeyframeFx });
    };
    const K = '(value-1)';
    const fitted = (key, a, b) => {
      // MotionFast's view keyed by fitted pieces (its AE Smooth solver's jitter left out: up to a few px in a dolly)
      const fs = r4(a), span = r4(b - fs);
      const propertyKeyframes = {};
      for (const prop of ['camZoom', 'camX', 'camY', 'camRoll']) {
        const f = (t) => cam(Math.min(D, t + 2e-7))[prop];
        const pieces = [];
        const cuts = [a, b];
        if (P.cameraMove === 'handheld') for (let q = 0; (q + 0.5) / 24 < b; q += 1) if ((q + 0.5) / 24 > a) cuts.push((q + 0.5) / 24);
        for (const x of [introD, outroT0]) if (x > a && x < b) cuts.push(x);
        const xs = [...new Set(cuts)].sort((u, v) => u - v);
        for (let j = 0; j + 1 < xs.length; j += 1) {
          const jump = P.cameraMove === 'handheld' && j + 2 < xs.length ? Math.min(1e-4, (xs[j + 1] - xs[j]) / 4) : 0;
          const got = [];
          fitPieces((t) => f(Math.min(t, xs[j + 1] - jump - 1e-9)), xs[j], xs[j + 1] - jump, { camZoom: 2e-4, camRoll: 5e-3, camX: 1e-2, camY: 1e-2 }[prop], got);
          got.forEach((q, i) => pieces.push(i === got.length - 1 && jump ? [q[0], xs[j + 1], { ...q[2], jump }] : q));
        }
        propertyKeyframes[prop] = keysOf(f, pieces, fs, span);
      }
      layers.push({ key, type: 'camera', name: 'Camera', freeStart: fs, trimEnd: span, propertyKeyframes });
    };
    const overlap = introOn && outroOn && outroT0 < introD - 1e-9;
    if (overlap) {
      // the intro still runs when the outro starts (a short clip): two dollies at once
      for (let a = 0; a < D - 1e-9; a += 6) fitted(`camera.${a / 6}`, a, Math.min(D, a + 6));
      warnings.push('The intro and the outro overlap (a short clip): the camera is keyed by fitted pieces, within about a pixel.');
    } else {
      const tI = introOn ? introD : 0, tO = outroOn ? outroT0 : D;
      if (introOn) {
        const c = camExpr(0, introD);
        const d = dollyExpr(K, n(z0), `${c.zoom}*${n(zr)}`, n(introTile.x), n(introTile.y), c.px, c.py);
        camLayer('camera.intro', 0, introD, camTracks(d.Z, d.X, d.Y, c.rot), true);
      }
      if (tO - tI > 1e-6) {
        const c = camExpr(r4(tI), tO);
        camLayer('camera.path', tI, tO, camTracks(`(${c.zoom}*${n(zr)})`, c.px, c.py, c.rot), false);
      }
      if (outroOn) {
        const c = camExpr(r4(outroT0), D);
        const d = dollyExpr(K, `${c.zoom}*${n(zr)}`, n(z1), c.px, c.py, n(outroTile.x), n(outroTile.y));
        camLayer('camera.outro', outroT0, D, camTracks(d.Z, d.X, d.Y, c.rot), true);
      }
    }

    // ── when each tile copy is on screen. A copy is (line k, repeat r, cell c): its centre along its line is
    // offRaw(k, τ) + r·period + cell start + size / 2 (the line's offset taken unwrapped, so a copy keeps its identity).
    const offRaw = (j, tau) => lineVelocity(P.lineMotion, j) * baseSpeed * tau;
    const alongOf = (C, t) => offRaw(C.k, scrollTime(t)) + C.r * layoutOf(C.k).period + C.it.a + C.it.size / 2;
    const times = [];
    for (let q = 0; q < D * RATE - 1e-6; q += 1) times.push(q / RATE);
    times.push(D);
    // the handheld camera jumps 24 times a second: a sample on each side of every jump, so no step sweeps across one
    if (P.cameraMove === 'handheld') for (let j = 0; (j + 0.5) / 24 < D - 1e-6; j += 1) times.push((j + 0.5) / 24 - 1e-6, (j + 0.5) / 24 + 1e-6);
    times.sort((x, y) => x - y);
    const TS = times.filter((t, i) => i === 0 || t - times[i - 1] > 1e-9);
    const steps = TS.length - 1;
    // the frame (grown by PAD px) in wall units at time t: its corners as [along, across] pairs, flat
    const quadAt = (t, out) => {
      const v = view(t);
      if (!(v.zoom > 0)) return false;
      const scl = v.zoom * s, c = Math.cos(v.rot) / scl, sn = Math.sin(v.rot) / scl, hw = W / 2 + PAD, hh = H / 2 + PAD;
      for (let i = 0; i < 4; i += 1) {
        const x = (i === 1 || i === 2 ? hw : -hw), y = (i >= 2 ? hh : -hh);
        const wx = v.px + x * c + y * sn, wy = v.py - x * sn + y * c;
        out[2 * i] = horizontal ? wx : wy; out[2 * i + 1] = horizontal ? wy : wx;
      }
      return true;
    };
    // where along a line the frame is: the frame's quad cut to the line's band [b0, b1] across (none: the quad's whole
    // stretch along, an outer bound)
    const bandRange = (Q, b0, b1, out) => {
      let lo = Infinity, hi = -Infinity, alo = Infinity, ahi = -Infinity;
      for (let i = 0; i < 4; i += 1) {
        const a1 = Q[2 * i], c1 = Q[2 * i + 1], j = (i + 1) % 4, a2 = Q[2 * j], c2 = Q[2 * j + 1];
        alo = Math.min(alo, a1); ahi = Math.max(ahi, a1);
        if (c1 >= b0 && c1 <= b1) { lo = Math.min(lo, a1); hi = Math.max(hi, a1); }
        if ((c1 - b0) * (c2 - b0) < 0) { const x = a1 + ((a2 - a1) * (b0 - c1)) / (c2 - c1); lo = Math.min(lo, x); hi = Math.max(hi, x); }
        if ((c1 - b1) * (c2 - b1) < 0) { const x = a1 + ((a2 - a1) * (b1 - c1)) / (c2 - c1); lo = Math.min(lo, x); hi = Math.max(hi, x); }
      }
      const hit = lo <= hi;
      out[0] = hit ? lo : alo; out[1] = hit ? hi : ahi;
      return hit;
    };
    // per step and line: the stretch of the line (in its own moving coordinate) the frame covers from the step's start to
    // its end; a copy is on screen in that step when its own stretch meets it
    const byLine = new Map();   // k → { q: [], lo: [], hi: [] }
    const Qa = new Float64Array(8), Qb = new Float64Array(8), ra = new Float64Array(2), rb = new Float64Array(2);
    let okA = quadAt(TS[0], Qa), tauA = scrollTime(TS[0]);
    for (let q = 0; q < steps; q += 1) {
      const okB = quadAt(TS[q + 1], Qb), tauB = scrollTime(TS[q + 1]);
      if (okA && okB) {
        let cMin = Infinity, cMax = -Infinity;
        for (let i = 1; i < 8; i += 2) { cMin = Math.min(cMin, Qa[i], Qb[i]); cMax = Math.max(cMax, Qa[i], Qb[i]); }
        for (let k = Math.ceil((cMin - crossSize / 2) / crossStep); k <= Math.floor((cMax + crossSize / 2) / crossStep); k += 1) {
          const b0 = k * crossStep - crossSize / 2, b1 = b0 + crossSize;
          const hitA = bandRange(Qa, b0, b1, ra), hitB = bandRange(Qb, b0, b1, rb);
          if (!hitA && !hitB) continue;
          const oa = offRaw(k, tauA), ob = offRaw(k, tauB);
          let e = byLine.get(k);
          if (!e) byLine.set(k, e = { q: [], lo: [], hi: [] });
          e.q.push(q); e.lo.push(Math.min(ra[0] - oa, rb[0] - ob)); e.hi.push(Math.max(ra[1] - oa, rb[1] - ob));
        }
      }
      Qa.set(Qb); okA = okB; tauA = tauB;
    }
    // the copies of each line and cell: first and last step on screen
    const span4 = [];   // { k, it, r0, first, last }
    for (const [k, e] of byLine) {
      const L = layoutOf(k), n0 = e.q.length;
      for (const it of L.items) {
        // the repeats r whose stretch [r·period + a, … + size] meets [lo, hi]
        const r0s = new Int32Array(n0), r1s = new Int32Array(n0);
        let r0 = Infinity, r1 = -Infinity;
        for (let i = 0; i < n0; i += 1) {
          r0s[i] = Math.ceil((e.lo[i] - it.a - it.size) / L.period); r1s[i] = Math.floor((e.hi[i] - it.a) / L.period);
          if (r0s[i] <= r1s[i]) { r0 = Math.min(r0, r0s[i]); r1 = Math.max(r1, r1s[i]); }
        }
        if (!(r0 <= r1)) continue;
        const len = r1 - r0 + 1, first = new Int32Array(len).fill(-1), last = new Int32Array(len);
        for (let i = 0; i < n0; i += 1) {
          const q = e.q[i];
          for (let r = r0s[i]; r <= r1s[i]; r += 1) { const j = r - r0; if (first[j] < 0) first[j] = q; last[j] = q; }
        }
        span4.push({ k, it, r0, first, last });
      }
    }
    // ── per picture (a photo, or a plate colour) and size: the copies in the order they come in
    const M = media.length;
    const op = clamp01(num(P.tileOpacity, 100) / 100);
    const plateColor = typeof P.placeholderColor === 'string' && /^#[0-9a-fA-F]{3,8}$|^rgba?\(/.test(P.placeholderColor.trim()) ? P.placeholderColor.trim() : '';
    const groups = new Map();
    for (const e of span4.sort((x, y) => x.k - y.k || x.it.cell - y.it.cell)) {
      const idx = (((e.k % lines) + lines) % lines) * cells + e.it.cell;
      const pic = M ? idx % M : (plateColor || PALETTE[idx % PALETTE.length]);
      const gk = `${pic}|${e.it.size}`;
      if (!groups.has(gk)) groups.set(gk, { pic, idx, size: e.it.size, copies: [] });
      const g = groups.get(gk);
      g.idx = Math.min(g.idx, idx);
      for (let j = 0; j < e.first.length; j += 1) {
        if (e.first[j] < 0) continue;
        // qOut: the first step the layer may show its next copy from (both off screen for GAP s in between)
        let qOut = e.last[j] + 1;
        while (qOut <= steps && TS[qOut] < TS[e.last[j] + 1] + GAP) qOut += 1;
        g.copies.push({ k: e.k, r: e.r0 + j, it: e.it, q0: e.first[j], q1: e.last[j], qOut });
      }
    }
    const order = [...groups.values()].sort((x, y) => x.idx - y.idx || x.size - y.size);
    // a layer holds a copy from its step q0 to qOut − 1: per picture, held[q] = the copies held at step q, and the layers
    // it needs = the most held at one step
    const budget = MAX_LAYERS - layers.length;
    for (const g of order) {
      const d = new Int32Array(steps + 2);
      for (const C of g.copies) { d[C.q0] += 1; d[C.qOut] -= 1; }
      g.held = new Int32Array(steps + 1);
      g.depth = 0;
      for (let q = 0, run = 0; q <= steps; q += 1) { run += d[q]; g.held[q] = run; g.depth = Math.max(g.depth, run); }
      g.layers = g.depth;
    }
    if (order.reduce((acc, g) => acc + g.depth, 0) > budget) {
      // more tiles on screen at once than a template holds. Each picture gets a share of the layers (one at a time to the
      // picture whose next layer would fill the most steps: the fewest tiles missing over the clip); a copy that comes in
      // while all its picture's layers are busy waits for the first one to come free (missing until then).
      for (const g of order) {
        const cnt = new Int32Array(g.depth + 2);
        for (let q = 0; q <= steps; q += 1) cnt[g.held[q]] += 1;
        g.over = new Int32Array(g.depth + 1);   // over[b]: the steps that hold more than b copies
        for (let v = g.depth - 1, acc = 0; v >= 0; v -= 1) { acc += cnt[v + 1]; g.over[v] = acc; }
        g.layers = 0;
      }
      for (let n0 = 0; n0 < budget; n0 += 1) {
        let best = null;
        for (const g of order) if (g.layers < g.depth && (!best || g.over[g.layers] > best.over[best.layers])) best = g;
        if (!best) break;
        best.layers += 1;
      }
      const onScreen = new Int32Array(steps + 2), short = new Int32Array(steps + 1);
      for (const g of order) {
        for (const C of g.copies) { onScreen[C.q0] += 1; onScreen[C.q1 + 1] -= 1; }
        for (let q = 0; q <= steps; q += 1) short[q] += Math.max(0, g.held[q] - g.layers);
      }
      let peak = 0, most = 0, from = -1, to = -1, worst = 0;
      for (let q = 0, run = 0; q <= steps; q += 1) {
        run += onScreen[q];
        if (run > most) { most = run; peak = q; }
        if (short[q] > 0) { if (from < 0) from = q; to = q; worst = Math.max(worst, short[q]); }
      }
      warnings.push(`At ${r4(TS[peak])} s the wall shows ${most} tiles at once, more than the ${budget} tile layers a template holds: from ${r4(TS[from])} s to ${r4(TS[Math.min(steps, to + 1)])} s up to ${worst} tiles are left out at a time.`);
    }
    // the layers: each copy, in the order they come in, to the free layer that was busy last (the fewest idle steps), else
    // a new layer while its picture has layers left; a copy that finds none waits (the one that stays longest first)
    const tileLayers = [];
    const tracksOf = [];
    order.forEach((g, gi) => {
      const own = [];
      const list = g.copies.slice().sort((x, y) => x.q0 - y.q0 || x.k - y.k || x.r - y.r || x.it.cell - y.it.cell);
      const place = (C, q) => {
        let best = null;
        for (const ly of own) if (ly.end <= q && (!best || ly.end > best.end)) best = ly;
        if (!best && own.length < g.layers) own.push(best = { list: [], end: 0 });
        if (!best) return false;
        C.at = q; best.list.push(C); best.end = C.qOut;
        return true;
      };
      let waiting = [];
      for (let i = 0, q = 0; q <= steps && (i < list.length || waiting.length);) {
        let came = false;
        while (i < list.length && list[i].q0 <= q) { waiting.push(list[i]); i += 1; came = true; }
        if (came) waiting.sort((x, y) => y.q1 - x.q1 || x.q0 - y.q0 || x.k - y.k || x.r - y.r || x.it.cell - y.it.cell);
        waiting = waiting.filter((C) => C.q1 >= q);   // gone before a layer came free
        let n0 = 0;
        while (n0 < waiting.length && place(waiting[n0], q)) n0 += 1;
        waiting = waiting.slice(n0);
        q = waiting.length ? q + 1 : (i < list.length ? list[i].q0 : steps + 1);
      }
      own.forEach((ly, j) => { if (ly.list.length) tracksOf.push({ g, gi, j, list: ly.list }); });
    });
    // keys: per copy, its line's slide (straight until the outro, then the scroll's ease to rest, then held); between
    // two copies a Hold key 0.1 ms before the jump, in the middle of the steps both are off screen
    const slide = (f, a, b, out) => {
      const xs = [a, ...(outroOn ? [outroT0, outroT0 + stopD] : []).filter((x) => x > a + 1e-9 && x < b - 1e-9), b];
      for (let i = 0; i + 1 < xs.length; i += 1) {
        const x = xs[i], y = xs[i + 1];
        if (!outroOn || y <= outroT0 + 1e-9 || x >= outroT0 + stopD - 1e-9) out.push([x, y, { easing: 'Linear' }]);
        else if (Math.abs(x - outroT0) < 1e-9 && Math.abs(y - outroT0 - stopD) < 1e-9) out.push([x, y, { easing: 'Ease Out' }]);
        else fitPieces(f, x, y, 1e-3, out);
      }
    };
    const built = tracksOf.map(({ g, gi, j, list }) => {
      const a = TS[list[0].at], b = TS[Math.min(steps, list[list.length - 1].q1 + 1)];
      let fs = Math.max(0, Math.floor(a * 1e4) / 1e4);
      const end = Math.min(r4(D), Math.ceil(b * 1e4) / 1e4);
      const span = r4(Math.max(0.1, end - fs));
      if (fs + span > D) fs = Math.max(0, r4(D - span));
      const along = [], across = [];
      list.forEach((C, i) => {
        const next = list[i + 1];
        const s0 = i === 0 ? fs : (TS[list[i - 1].q1 + 1] + TS[C.at]) / 2;
        const s1 = next ? (TS[C.q1 + 1] + TS[next.at]) / 2 : fs + span;
        const jump = next ? Math.min(1e-4, (TS[next.at] - TS[C.q1 + 1]) / 4) : 0;
        const f = (t) => alongOf(C, t);
        const pcs = [];
        slide(f, s0, s1 - jump, pcs);
        for (const [x, , how] of pcs) along.push({ t: x, v: f(x), ...how });
        along.push({ t: s1 - jump, v: f(s1 - jump), easing: next ? 'Hold' : 'Linear' });
        if (!across.length || across[across.length - 1].v !== C.k * crossStep) across.push({ t: s0, v: C.k * crossStep, easing: 'Hold' });
      });
      return { g, gi, j, fs, span, along, across };
    });
    // in % of the frame; values past ±190 % are written divided by an integer that a ƒx multiplies back
    const toPct = (v, axis) => (zr * s * v * 100) / (axis === 'x' ? W : H);
    const [ax, cx] = horizontal ? ['x', 'y'] : ['y', 'x'];
    let reach = 0;
    for (const B of built) for (const kf of [...B.along.map((x) => toPct(x.v, ax)), ...B.across.map((x) => toPct(x.v, cx))]) reach = Math.max(reach, Math.abs(kf));
    const kPos = reach > 190 ? Math.ceil(reach / 190) : 1;
    const fx = kPos > 1 ? { xPercent: { type: 'custom', params: { code: `value*${kPos}` } }, yPercent: { type: 'custom', params: { code: `value*${kPos}` } } } : null;
    const track = (list, axis, fs, span) => {
      const pos = (t) => r6(Math.min(100, Math.max(0, ((t - fs) / span) * 100)));
      const out = list.map(({ t, v, ...ease }) => ({ position: pos(t), value: n(toPct(v, axis) / kPos), ...ease })).filter((k, i, a) => i === 0 || k.position > a[i - 1].position);
      if (out.every((k) => k.value === out[0].value)) return [{ position: 0, value: out[0].value, easing: 'Linear' }];
      return out;
    };
    for (const { g, gi, j, fs, span, along, across } of built) {
      const w = (horizontal ? g.size : crossSize) * zr * s, h = (horizontal ? crossSize : g.size) * zr * s;
      const tracks = { [horizontal ? 'xPercent' : 'yPercent']: track(along, ax, fs, span), [horizontal ? 'yPercent' : 'xPercent']: track(across, cx, fs, span) };
      if (op < 1) tracks.opacity = [{ position: 0, value: n(op), easing: 'Linear' }];
      const base = { key: `tile[${gi}][${j}]`, name: `${M ? `Picture ${g.pic + 1}` : `Tile ${g.idx + 1}`}${j ? `.${j + 1}` : ''}`, freeStart: fs, trimEnd: span, propertyKeyframes: { xPercent: tracks.xPercent, yPercent: tracks.yPercent, ...(tracks.opacity ? { opacity: tracks.opacity } : {}) }, ...(fx ? { propertyKeyframeFx: fx } : {}) };
      if (M) {
        tileLayers.push({ ...base, type: media[g.pic].type === 'video' ? 'video' : 'image', media: g.pic, box: { w: r6(w), h: r6(h), fit: 'cover', radius: r6(radius * zr * s) } });
      } else {
        tileLayers.push({ ...base, type: 'shape', shapeType: 'rectangle', shapeSizeUnit: 'px', shapeWidthPx: r6(w), shapeHeightPx: r6(h),
          shapeFillColor: g.pic, borderRadius: r6(Math.min(radius, Math.min(w, h) / (2 * zr * s)) * zr * s) });
      }
    }
    if (M && media.some((x) => x.type === 'video')) warnings.push('A video on a tile plays once (no loop yet).');
    return { duration: D, layers: [...tileLayers, ...layers], warnings };
  },
};
