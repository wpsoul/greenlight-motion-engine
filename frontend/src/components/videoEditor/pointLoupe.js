/*
 * Point loupe — the docked inspector for every on-canvas path edit.
 *
 * A finger hides the very pixels being edited and a mouse pointer sits on top
 * of a 1.5 px outline; the moments that need precision are the ones with the
 * least visibility. So while a mask or roto path is edited, a square lens in a
 * corner of the preview shows the frame magnified with the path drawn through it:
 *
 *  - HOVER (pen out, nothing pressed): centred on the cursor — where the next
 *    point will land — with the curve that click would make dashed in green.
 *    An auto anchor re-bends the previous segment too, which the straight lead
 *    on the overlay never shows.
 *  - DRAG: centred on the ANCHOR being edited, never on the pointer. Pulling a
 *    handle, the pointer is the handle TIP, often 60 px from the anchor; a lens
 *    centred there showed footage and a dot and none of the curve (the first
 *    version of this module did exactly that). The handle runs out of the lens
 *    and a marker on the rim points at it.
 *
 * The lens sits in the corner of the preview FARTHEST from the pointer and only
 * moves when the pointer comes near it, so it never covers the curve being
 * drawn. Zoom: [ and ] while it is up, or the wheel during a drag; remembered.
 * Look-dev: html/path-loupe-lab.html, variant D.
 *
 * What it draws is read from the overlay's OWN DOM — outlines, anchors, the
 * handles of the point being edited — through each element's getScreenCTM, so
 * the view zoom, the project camera group and a rotated mask box all come out
 * right without knowing any of them. Lines keep a constant lens width and dots
 * a constant size: magnified footage, not magnified chrome.
 *
 * WHEN it reads matters. A pointermove writes React state and React commits the
 * overlay in a LATER task, so a read inside the handler gets the path as it was
 * one move ago. Overlays therefore queue a build function (queuePointLoupe) and
 * call usePointLoupeCommit(), whose layout effect paints it right after the
 * commit. A move that changes nothing never commits: a short timer paints it,
 * or the caller paints at once with showPointLoupe.
 *
 * One DOM node, owned here and appended to `.ve-player-viewport` (the unscaled
 * pan/zoom surface, so the lens never inherits the stage's view transform).
 */
import { useLayoutEffect } from 'react';
import { refreshShapePathHandles } from './shapePath';

const BOX = 208;           // css px: the lens is a square this size …
const BOX_MIN = 120;       // … shrinking with a small preview, never below this
const MARGIN = 12;         // from the viewport edge
const BORDER = 2;          // .ve-point-loupe border, css px
const NEAR_PX = 56;        // the pointer this close → the lens takes the far corner
const DPR = 2;             // backing pixels per css px inside the lens
const ZOOM_DEFAULT = 4;
const ZOOM_MIN = 2;
const ZOOM_MAX = 10;
const ZOOM_KEY = 've.pointLoupe.zoom';
const PROBE_MS = 500;      // how often to re-ask whether the canvas reads back
const SNAP_MS = 90;        // fallback snapshot refresh while dragging (~4 ms each) …
const SNAP_HOVER_MS = 500; // … and while only hovering, when the frame is not changing
const COMMIT_FALLBACK_MS = 40;
const ACCENT = '#33efab';
const HALO = 'rgba(0, 0, 0, 0.55)';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let zoom = (() => {
  try {
    const z = Number(globalThis.localStorage?.getItem(ZOOM_KEY));
    return Number.isFinite(z) && z >= ZOOM_MIN && z <= ZOOM_MAX ? z : ZOOM_DEFAULT;
  } catch {
    return ZOOM_DEFAULT;
  }
})();

let node = null;
let ctx = null;
let badge = null;
let host = null;
let visible = false;
let slot = -1;          // corner the lens holds: 0 TL, 1 TR, 2 BL, 3 BR
let lastReq = null;     // repainted as is when the zoom changes
let listening = null;   // the viewport the wheel listener is on

/*
 * READING THE PREVIEW.
 *
 * On WebGL, drawImage(playerCanvas) returns the frame — the renderer keeps its
 * drawing buffer. On WebGPU it can come back EMPTY (measured: every pixel
 * transparent, while toDataURL on the same canvas returns the real frame), so
 * a magnifier that only knew drawImage would show an empty square on that
 * backend. Which one applies is a property of the browser and the adapter, not
 * something worth predicting: probe it, and fall back to a throttled snapshot
 * when the direct read gives nothing.
 */
const probeCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
let directOk = null;
let probedAt = 0;
let probedFor = null;

function canReadDirect(frame) {
  const now = performance.now();
  if (probedFor === frame && directOk !== null && now - probedAt < PROBE_MS) return directOk;
  probedFor = frame;
  probedAt = now;
  try {
    probeCanvas.width = 8;
    probeCanvas.height = 8;
    const p = probeCanvas.getContext('2d');
    p.clearRect(0, 0, 8, 8);
    p.drawImage(frame, 0, 0, 8, 8);
    const d = p.getImageData(0, 0, 8, 8).data;
    directOk = false;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) { directOk = true; break; }
  } catch {
    directOk = false;
  }
  return directOk;
}

// The fallback snapshot: a JPEG of the canvas, refreshed in the background so a
// drag never waits on one. Slightly behind the live frame — the alternative on
// that backend is nothing at all.
const snap = { img: null, at: 0, pending: false };
// Bumped by dispose(): a decode that finishes after the editor is gone must not
// put the old frame back into module state.
let generation = 0;

function snapshotFor(frame, maxAge) {
  const now = performance.now();
  if (!snap.pending && now - snap.at > maxAge) {
    snap.pending = true;
    const born = generation;
    try {
      const url = frame.toDataURL('image/jpeg', 0.7);
      const img = new Image();
      img.onload = () => { if (born !== generation) return; snap.img = img; snap.at = performance.now(); snap.pending = false; };
      img.onerror = () => { if (born === generation) snap.pending = false; };
      img.src = url;
    } catch {
      snap.pending = false;
    }
  }
  return snap.img;
}

function ensure(viewport) {
  if (node && host === viewport && node.parentNode === viewport) return node;
  if (node?.parentNode) node.parentNode.removeChild(node);
  node = document.createElement('div');
  node.className = 've-point-loupe';
  const canvas = document.createElement('canvas');
  node.appendChild(canvas);
  badge = document.createElement('span');
  badge.className = 've-point-loupe-zoom';
  node.appendChild(badge);
  ctx = canvas.getContext('2d');
  viewport.appendChild(node);
  host = viewport;
  visible = false;
  return node;
}

const polygonPath = (el) => {
  const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
  if (pts.length < 6) return null;
  let d = `M ${pts[0]} ${pts[1]}`;
  for (let i = 2; i + 1 < pts.length; i += 2) d += ` L ${pts[i]} ${pts[i + 1]}`;
  return new Path2D(d + ' Z');
};

const isElement = (v) => !!v && typeof v.getScreenCTM === 'function';

// A circle element (its centre) or a client point → client px.
function toClient(v) {
  if (isElement(v)) {
    const m = v.getScreenCTM();
    if (!m || !v.cx) return null;
    const p = new DOMPoint(v.cx.baseVal.value, v.cy.baseVal.value).matrixTransform(m);
    return { x: p.x, y: p.y };
  }
  return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x, y: v.y } : null;
}

const paintOf = (value, fallback) => (
  value && value !== 'none' && !value.startsWith('url(') ? value : fallback
);

// The corner farthest from the pointer, kept until the pointer comes near it.
function dockCorner(width, height, pointer, outer) {
  const corners = [
    [MARGIN, MARGIN],
    [width - outer - MARGIN, MARGIN],
    [MARGIN, height - outer - MARGIN],
    [width - outer - MARGIN, height - outer - MARGIN],
  ];
  const near = ([x, y]) => pointer.x > x - NEAR_PX && pointer.x < x + outer + NEAR_PX
    && pointer.y > y - NEAR_PX && pointer.y < y + outer + NEAR_PX;
  if (!(slot >= 0 && slot < 4) || near(corners[slot])) {
    let best = 1;
    let bestD = -Infinity;
    corners.forEach(([x, y], i) => {
      // Top-right wins a tie: the corner least likely to hold a subject.
      const d = Math.hypot(x + outer / 2 - pointer.x, y + outer / 2 - pointer.y) + (i === 1 ? 40 : 0);
      if (d > bestD) { bestD = d; best = i; }
    });
    slot = best;
  }
  return corners[slot];
}

/**
 * Show (or repaint) the lens.
 *  - `svg`: the overlay the edit lives in; the lens mounts in its viewport.
 *  - `mode`: 'hover' (where the next point lands), 'anchor' (a point is being
 *    dragged) or 'handle' (a tangent is being pulled).
 *  - `target`: the lens centre — a circle element (the anchor being edited) or
 *    a CLIENT point. Hover defaults to the pointer.
 *  - `pointer`: CLIENT px — the lens docks in the corner away from it.
 *  - `tip`: the handle being pulled (element or client point): drawn as the
 *    active knob, and marked on the rim when it is outside the lens.
 *  - `paths`: outlines (path / polygon) stroked through the lens.
 *  - `anchors`: anchor circles, drawn at a constant size.
 *  - `stems` / `knobs`: the tangent lines and knobs to show (only the edited
 *    point's — every anchor's handles at this zoom read as noise).
 *  - `preview`: { el, d } — the curve the next pen click would make, in el's
 *    user space, dashed.
 */
export function showPointLoupe(req) {
  const { svg, mode = 'anchor', pointer = null } = req || {};
  const viewport = svg?.closest?.('.ve-player-viewport');
  const frame = viewport?.querySelector('.ve-player-canvas');
  const target = toClient(req?.target) || (mode === 'hover' ? toClient(pointer) : null);
  if (!viewport || !frame || !target) { hideLens(); return; }
  lastReq = req;
  const el = ensure(viewport);
  const vp = viewport.getBoundingClientRect();
  const size = Math.round(clamp(Math.min(BOX, vp.width * 0.34, vp.height * 0.46), BOX_MIN, BOX));
  const outer = size + BORDER * 2;
  const canvas = ctx.canvas;
  if (canvas.width !== size * DPR) { canvas.width = size * DPR; canvas.height = size * DPR; }
  if (el.style.width !== `${size}px`) { el.style.width = `${size}px`; el.style.height = `${size}px`; }
  const at = toClient(pointer) || target;
  const [left, top] = dockCorner(vp.width, vp.height, { x: at.x - vp.left, y: at.y - vp.top }, outer);
  if (!visible) { el.style.transition = 'none'; el.style.display = 'block'; }
  el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  if (!visible) { void el.offsetWidth; el.style.transition = ''; visible = true; }
  const z = Math.round(zoom * 4) / 4;
  badge.textContent = `${Number.isInteger(z) ? z : z.toFixed(2).replace(/0$/, '')}×`;
  listen(viewport);

  const S = size * DPR;
  const half = S / 2;
  const loupeFromClient = new DOMMatrix()
    .translate(half, half)
    .scale(zoom * DPR)
    .translate(-target.x, -target.y);
  const through = (e) => {
    const ctm = e?.getScreenCTM?.();
    return ctm ? loupeFromClient.multiply(ctm) : null;
  };
  const at2 = (m, x, y) => new DOMPoint(x, y).matrixTransform(m);
  const inView = (p, pad = 12 * DPR) => p.x > -pad && p.y > -pad && p.x < S + pad && p.y < S + pad;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const r = frame.getBoundingClientRect();
  if (r.width > 0 && r.height > 0 && frame.width > 0 && frame.height > 0) {
    const source = canReadDirect(frame) ? frame : snapshotFor(frame, mode === 'hover' ? SNAP_HOVER_MS : SNAP_MS);
    if (source) {
      const m = loupeFromClient
        .translate(r.left, r.top)
        .scale(r.width / frame.width, r.height / frame.height);
      ctx.setTransform(m);
      // A snapshot carries the canvas's own pixel size, so one matrix serves both.
      try { ctx.drawImage(source, 0, 0, frame.width, frame.height); } catch { /* a lost context leaves the frame black */ }
    }
  }

  // An element's own path, stroked at a constant lens width with a dark halo
  // so it reads on bright footage.
  const strokeShape = (shape, color, width, dash = null) => {
    const m = through(shape);
    if (!m) return;
    const path = shape.tagName === 'polygon' ? polygonPath(shape) : new Path2D(shape.getAttribute('d') || '');
    if (!path) return;
    const k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
    ctx.setTransform(m);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash(dash ? dash.map((v) => (v * DPR) / k) : []);
    ctx.strokeStyle = HALO;
    ctx.lineWidth = ((width + 2.2) * DPR) / k;
    ctx.stroke(path);
    ctx.strokeStyle = color;
    ctx.lineWidth = (width * DPR) / k;
    ctx.stroke(path);
    ctx.setLineDash([]);
  };
  const strokeLine = (a, b, color, width) => {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = HALO;
    ctx.lineWidth = (width + 2.2) * DPR;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width * DPR;
    ctx.stroke();
  };
  const dot = (p, radius, fill, stroke) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius * DPR, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1.4 * DPR;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  };

  if (req.preview?.el && req.preview.d) {
    // Mapped through the element whose user space the curve was authored in.
    const m = through(req.preview.el);
    if (m) {
      const k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
      ctx.setTransform(m);
      ctx.lineCap = 'round';
      ctx.setLineDash([(5 * DPR) / k, (4 * DPR) / k]);
      ctx.strokeStyle = HALO;
      ctx.lineWidth = (3.7 * DPR) / k;
      const p2 = new Path2D(req.preview.d);
      ctx.stroke(p2);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = (1.5 * DPR) / k;
      ctx.stroke(p2);
      ctx.setLineDash([]);
    }
  }

  for (const p of req.paths || []) {
    if (!isElement(p)) continue;
    strokeShape(p, paintOf(getComputedStyle(p).stroke, '#e8ecf1'), 1.6);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  for (const s of req.stems || []) {
    const m = through(s);
    if (!m || !s.x1) continue;
    const a = at2(m, s.x1.baseVal.value, s.y1.baseVal.value);
    const b = at2(m, s.x2.baseVal.value, s.y2.baseVal.value);
    strokeLine(a, b, 'rgba(255, 255, 255, 0.88)', 1.2);
  }
  const tipEl = isElement(req.tip) ? req.tip : null;
  for (const kn of req.knobs || []) {
    const m = through(kn);
    if (!m || !kn.cx) continue;
    const p = at2(m, kn.cx.baseVal.value, kn.cy.baseVal.value);
    if (!inView(p)) continue;
    const active = kn === tipEl;
    dot(p, active ? 3.8 : 3.2, active ? ACCENT : paintOf(getComputedStyle(kn).fill, '#e9edf5'), '#16181c');
  }

  const focusEl = isElement(req.target) ? req.target : null;
  for (const a of req.anchors || []) {
    const m = through(a);
    if (!m || !a.cx) continue;
    const p = at2(m, a.cx.baseVal.value, a.cy.baseVal.value);
    if (!inView(p)) continue;
    if (a === focusEl) {
      // The point being dragged is the ring below; the one whose handle is
      // being pulled stays a solid white dot the handle swings around.
      if (mode === 'handle') dot(p, 4.4, '#ffffff', '#16181c');
      continue;
    }
    const cs = getComputedStyle(a);
    dot(p, 3.6, paintOf(cs.fill, '#e9edf5'), paintOf(cs.stroke, '#16181c'));
  }

  // The dragged point / the cursor: a hollow ring with a crosshair, so the one
  // pixel it sits on is the one thing never covered.
  if (mode !== 'handle') {
    const R = 7 * DPR;
    const arm = mode === 'hover' ? 12 * DPR : R;
    ctx.beginPath();
    ctx.arc(half, half, R, 0, Math.PI * 2);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(half + dx * 2.5 * DPR, half + dy * 2.5 * DPR);
      ctx.lineTo(half + dx * arm, half + dy * arm);
    }
    ctx.strokeStyle = HALO;
    ctx.lineWidth = 3.4 * DPR;
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.2 * DPR;
    ctx.stroke();
  }

  // The handle tip is outside the lens: a marker on the rim pointing at it.
  const tip = toClient(req.tip);
  if (tip) {
    const t = new DOMPoint(tip.x, tip.y).matrixTransform(loupeFromClient);
    if (t.x < 0 || t.y < 0 || t.x > S || t.y > S) {
      const dx = t.x - half;
      const dy = t.y - half;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d;
      const uy = dy / d;
      const reach = Math.min((half - 9 * DPR) / Math.max(1e-6, Math.abs(ux)), (half - 9 * DPR) / Math.max(1e-6, Math.abs(uy)));
      const ax = half + ux * reach;
      const ay = half + uy * reach;
      const s = DPR;
      ctx.beginPath();
      ctx.moveTo(ax + ux * 5 * s, ay + uy * 5 * s);
      ctx.lineTo(ax - ux * 3 * s - uy * 5 * s, ay - uy * 3 * s + ux * 5 * s);
      ctx.lineTo(ax - ux * 3 * s + uy * 5 * s, ay - uy * 3 * s - ux * 5 * s);
      ctx.closePath();
      ctx.lineWidth = 3 * DPR;
      ctx.strokeStyle = HALO;
      ctx.stroke();
      ctx.fillStyle = ACCENT;
      ctx.fill();
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ── zoom: [ / ] while the lens is up, the wheel during a drag ──
function setZoom(next) {
  zoom = clamp(next, ZOOM_MIN, ZOOM_MAX);
  try { globalThis.localStorage?.setItem(ZOOM_KEY, String(Math.round(zoom * 100) / 100)); } catch { /* storage blocked */ }
  if (visible && lastReq) showPointLoupe(lastReq);
}

function onKey(event) {
  if (event.key !== '[' && event.key !== ']') return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const t = event.target;
  if (t?.isContentEditable || t?.closest?.('input, textarea, select')) return;
  event.preventDefault();
  event.stopPropagation();
  setZoom(zoom * (event.key === ']' ? 1.25 : 0.8));
}

// Only during a drag: hovering, the wheel still pans and zooms the preview.
function onWheel(event) {
  if (!visible || !lastReq || lastReq.mode === 'hover') return;
  event.preventDefault();
  event.stopPropagation();
  setZoom(zoom * Math.exp(-event.deltaY * 0.0015));
}

function listen(viewport) {
  if (listening === viewport) return;
  unlisten();
  window.addEventListener('keydown', onKey, true);
  viewport.addEventListener('wheel', onWheel, { capture: true, passive: false });
  listening = viewport;
}

function unlisten() {
  if (!listening) return;
  window.removeEventListener('keydown', onKey, true);
  listening.removeEventListener('wheel', onWheel, { capture: true });
  listening = null;
}

function hideLens() {
  if (node) node.style.display = 'none';
  visible = false;
  lastReq = null;
  unlisten();
}

// ── paint after the commit ──
let pendingBuild = null;
let pendingOwner = null;
let pendingTimer = 0;

/**
 * Paint `build()` once the overlay has committed this move. `build` returns a
 * showPointLoupe request (read from the DOM at that moment) or null to hide.
 * `owner` is the overlay's root element: only its own commit flushes it.
 */
export function queuePointLoupe(build, owner = null) {
  pendingBuild = build;
  pendingOwner = owner;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(flushPointLoupe, COMMIT_FALLBACK_MS);
}

export function flushPointLoupe() {
  const build = pendingBuild;
  pendingBuild = null;
  pendingOwner = null;
  clearTimeout(pendingTimer);
  if (!build) return;
  const req = build();
  if (req) showPointLoupe(req);
  else hideLens();
}

/** In an overlay that queues: paints the queued lens right after each commit. */
export function usePointLoupeCommit(ownerRef) {
  useLayoutEffect(() => {
    if (pendingBuild && (!pendingOwner || pendingOwner === ownerRef?.current)) flushPointLoupe();
  });
}

/** End of a gesture / the pointer left: the lens goes away but stays ready. */
export function hidePointLoupe() {
  pendingBuild = null;
  pendingOwner = null;
  clearTimeout(pendingTimer);
  hideLens();
}

/**
 * The editor is going away. Hiding is not enough here: the module's globals hold
 * the lens node, its 2D context, the VIEWPORT it was mounted in, the canvas the
 * probe last read and the fallback snapshot — all of which would keep a detached
 * preview alive until some later drag happened to replace them. Drop the lot; the
 * next showPointLoupe() builds a fresh one.
 */
export function disposePointLoupe() {
  generation += 1;
  pendingBuild = null;
  pendingOwner = null;
  clearTimeout(pendingTimer);
  unlisten();
  if (node?.parentNode) node.parentNode.removeChild(node);
  if (ctx?.canvas) { ctx.canvas.width = 0; ctx.canvas.height = 0; }
  node = null;
  ctx = null;
  badge = null;
  host = null;
  visible = false;
  slot = -1;
  lastReq = null;
  directOk = null;
  probedAt = 0;
  probedFor = null;
  snap.img = null;
  snap.at = 0;
  snap.pending = false;
  if (probeCanvas) { probeCanvas.width = 0; probeCanvas.height = 0; }
}

/** Frame-space point of an overlay element → client px (through its screen CTM). */
export function elementPointToClient(el, x, y) {
  const ctm = el?.getScreenCTM?.();
  if (!ctm) return null;
  const p = new DOMPoint(x, y).matrixTransform(ctm);
  return { x: p.x, y: p.y };
}

/**
 * The curve the next pen click would make, as a path `d` in frame space:
 * the cursor appended as a smooth (auto) anchor — which re-bends the segment
 * before it, so both are returned — or, `closing`, the whole outline closed.
 * `points` are the draft as stored (raw, `manual` intact); `toFrame` maps the
 * draft's own space to the space `d` is drawn in.
 */
export function nextPenCurve(points, cursor, { closing = false, toFrame = (q) => q } = {}) {
  if (!Array.isArray(points) || !points.length || (!closing && !cursor)) return null;
  const pts = refreshShapePathHandles(
    (closing ? points : [...points, { x: cursor.x, y: cursor.y }]).map((q) => ({ ...q })),
    closing
  );
  const n = pts.length;
  if (n < 2) return null;
  const segs = closing ? n : n - 1;
  const from = closing ? 0 : Math.max(0, n - 3);
  const H = (q, k) => q[k] || { x: 0, y: 0 };
  const F = (q, h) => toFrame({ x: q.x + (h?.x || 0), y: q.y + (h?.y || 0) });
  const head = F(pts[from]);
  let d = `M ${head.x} ${head.y}`;
  for (let i = from; i < segs; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const c1 = F(a, H(a, 'hOut'));
    const c2 = F(b, H(b, 'hIn'));
    const e = F(b);
    d += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${e.x} ${e.y}`;
  }
  return closing ? `${d} Z` : d;
}
