// Sketch → Agent: the drawing model shared by SketchOverlay and its tests.
// Ported from html/sketch-to-agent-lab.html (the owner picked its Dock toolbar).
//
// Marks live in SOURCE pixels (the frozen window picture), so what is drawn at
// the overlay's display scale exports 1:1. Each mark keeps `k` — source px per
// display px when it was made — so shadows and widths look the same on export.

export const TOOLS = [
  { id: "pen", key: "p", label: "Pen" },
  { id: "hl", key: "h", label: "Highlighter" },
  { id: "arrow", key: "a", label: "Arrow" },
  { id: "box", key: "r", label: "Box" },
  { id: "text", key: "t", label: "Text" },
  { id: "pin", key: "n", label: "Numbered pin" },
  { id: "hide", key: "x", label: "Hide (pixelate)" },
  { id: "crop", key: "c", label: "Crop" },
];

export const COLORS = [
  ["Red", "#ff4d4f"], ["Amber", "#ffb020"], ["Mint", "#33efab"],
  ["Blue", "#3b9eff"], ["White", "#ffffff"], ["Black", "#111214"],
];

// Display-pixel sizes per stroke weight.
export const SIZES = {
  S: { w: 3, text: 14, pin: 10, dot: 5, label: "Thin" },
  M: { w: 5, text: 18, pin: 13, dot: 8, label: "Medium" },
  L: { w: 9, text: 26, pin: 17, dot: 11, label: "Thick" },
};
export const SIZE_ORDER = ["S", "M", "L"];

// Long edge of the PNG an agent gets. Agents downscale bigger images anyway,
// so pixels past this only cost tokens.
export const MAX_EDGE = 2000;

const FONT = 'Inter, -apple-system, "Segoe UI", sans-serif';

export function contrast(hex) {
  const v = parseInt(String(hex).slice(1), 16);
  const r = (v >> 16) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? "#111214" : "#ffffff";
}

export const normRect = (o) => ({
  x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2),
  w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1),
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function capSize(w, h, cap = MAX_EDGE) {
  const long = Math.max(w, h);
  if (!cap || long <= cap) return { w, h, f: 1 };
  const f = cap / long;
  return { w: Math.round(w * f), h: Math.round(h * f), f };
}

// Anthropic's rule of thumb for image input: about width × height / 750 tokens.
export const estimateTokens = (w, h) => Math.round((w * h) / 750);
export const formatTokens = (n) => (n < 1000 ? String(Math.round(n)) : `${(n / 1000).toFixed(1)}k`);

/* ── history ─────────────────────────────────────────────────────────── */

export const createHistory = () => ({ objs: [], hist: [], fut: [] });

export function addMark(h, o) {
  h.objs.push(o);
  h.hist.push({ t: "add", o });
  h.fut = [];
}
export function clearMarks(h) {
  if (!h.objs.length) return false;
  h.hist.push({ t: "clear", objs: h.objs });
  h.objs = [];
  h.fut = [];
  return true;
}
export function undoMark(h) {
  const a = h.hist.pop();
  if (!a) return false;
  if (a.t === "add") h.objs.pop(); else h.objs = a.objs;
  h.fut.push(a);
  return true;
}
export function redoMark(h) {
  const a = h.fut.pop();
  if (!a) return false;
  if (a.t === "add") h.objs.push(a.o); else h.objs = [];
  h.hist.push(a);
  return true;
}

/* ── crop ────────────────────────────────────────────────────────────── */

// Which part of the crop a source-pixel point grabs: a corner, the inside, or nothing.
export function cropHit(crop, p, tol) {
  if (!crop) return null;
  const c = crop;
  const corners = { nw: [c.x, c.y], ne: [c.x + c.w, c.y], sw: [c.x, c.y + c.h], se: [c.x + c.w, c.y + c.h] };
  for (const [k, [x, y]] of Object.entries(corners)) {
    if (Math.abs(p.x - x) < tol && Math.abs(p.y - y) < tol) return k;
  }
  if (p.x > c.x && p.x < c.x + c.w && p.y > c.y && p.y < c.y + c.h) return "move";
  return null;
}

// Start a crop drag at p: move the crop, resize it from a corner, or draw a new one.
export function startCropDrag(crop, p, tol, iw, ih) {
  const hit = cropHit(crop, p, tol);
  if (hit === "move") return { drag: { mode: "move", start: p, orig: { ...crop } }, crop };
  if (hit) {
    const ax = hit.includes("w") ? crop.x + crop.w : crop.x;
    const ay = hit.includes("n") ? crop.y + crop.h : crop.y;
    return { drag: { mode: "resize", anchor: { x: ax, y: ay } }, crop };
  }
  const a = { x: clamp(p.x, 0, iw), y: clamp(p.y, 0, ih) };
  return { drag: { mode: "new", anchor: a }, crop: { x: a.x, y: a.y, w: 0, h: 0 } };
}

export function dragCrop(drag, p, iw, ih) {
  if (drag.mode === "move") {
    const o = drag.orig;
    return {
      x: clamp(o.x + p.x - drag.start.x, 0, iw - o.w),
      y: clamp(o.y + p.y - drag.start.y, 0, ih - o.h),
      w: o.w, h: o.h,
    };
  }
  const q = { x: clamp(p.x, 0, iw), y: clamp(p.y, 0, ih) }, a = drag.anchor;
  return { x: Math.min(a.x, q.x), y: Math.min(a.y, q.y), w: Math.abs(q.x - a.x), h: Math.abs(q.y - a.y) };
}

// A crop smaller than `minSource` px on a side is a click, not a crop.
export function finishCrop(crop, minSource) {
  if (!crop || crop.w < minSource || crop.h < minSource) return null;
  return { x: Math.round(crop.x), y: Math.round(crop.y), w: Math.round(crop.w), h: Math.round(crop.h) };
}

/* ── painting ────────────────────────────────────────────────────────── */

export function roundRectPath(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Canvas shadows ignore the transform, so they are given in device px.
function setShadow(g, o, pxScale) {
  g.shadowColor = "rgba(0,0,0,0.38)";
  g.shadowBlur = 3 * o.k * pxScale;
  g.shadowOffsetY = o.k * pxScale;
}

function strokeSmooth(g, pts) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 1) {
    g.lineTo(pts[0][0] + 0.01, pts[0][1]);
    g.stroke();
    return;
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const l = pts[pts.length - 1];
  g.lineTo(l[0], l[1]);
  g.stroke();
}

function drawArrow(g, o, pxScale) {
  const dx = o.x2 - o.x1, dy = o.y2 - o.y1, len = Math.hypot(dx, dy);
  if (len < 0.5) return;
  const ux = dx / len, uy = dy / len;
  const head = Math.min(Math.max(o.w * 3.2, 10 * o.k), len * 0.7), hw = head * 0.62;
  const bx = o.x2 - ux * head, by = o.y2 - uy * head;
  setShadow(g, o, pxScale);
  g.strokeStyle = g.fillStyle = o.color;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.lineWidth = o.w;
  g.beginPath();
  g.moveTo(o.x1, o.y1);
  g.lineTo(o.x2 - ux * head * 0.5, o.y2 - uy * head * 0.5);
  g.stroke();
  g.lineWidth = o.w * 0.5;
  g.beginPath();
  g.moveTo(o.x2, o.y2);
  g.lineTo(bx - uy * hw, by + ux * hw);
  g.lineTo(bx + uy * hw, by - ux * hw);
  g.closePath();
  g.fill();
  g.stroke();
}

// A text label is a filled pill; the overlay's live editor uses the same box
// (padding .3em .5em, line-height 1.25, radius .35em) so committing never jumps.
export function textBox(g, o) {
  g.font = `600 ${o.size}px ${FONT}`;
  const lines = o.text.split("\n");
  const lh = o.size * 1.25, padX = o.size * 0.5, padY = o.size * 0.3;
  const w = Math.max(...lines.map((l) => g.measureText(l).width)) + padX * 2;
  return { lines, lh, padX, padY, w, h: lines.length * lh + padY * 2 };
}

function drawText(g, o, pxScale) {
  const m = textBox(g, o);
  setShadow(g, o, pxScale);
  g.fillStyle = o.color;
  roundRectPath(g, o.x, o.y, m.w, m.h, o.size * 0.35);
  g.fill();
  g.shadowColor = "transparent";
  g.fillStyle = contrast(o.color);
  g.textBaseline = "middle";
  m.lines.forEach((l, i) => g.fillText(l, o.x + m.padX, o.y + m.padY + m.lh * (i + 0.5)));
}

function drawPin(g, o, n, pxScale) {
  const r = o.r;
  setShadow(g, o, pxScale);
  g.fillStyle = o.color;
  g.beginPath();
  g.arc(o.x, o.y, r, 0, Math.PI * 2);
  g.fill();
  g.shadowColor = "transparent";
  g.lineWidth = r * 0.16;
  g.strokeStyle = contrast(o.color) === "#ffffff" ? "#ffffff" : "rgba(0,0,0,0.3)";
  g.stroke();
  g.fillStyle = contrast(o.color);
  g.font = `700 ${r * 1.15}px ${FONT}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(String(n), o.x, o.y + r * 0.06);
}

// Hide = pixelate. The rect's source pixels are shrunk to one pixel per block
// and drawn back over exactly the same rect, so no unmasked edge can survive.
function drawHide(g, o, source, iw, ih) {
  const r = normRect(o);
  if (r.w < 1 || r.h < 1) return;
  const block = Math.max(6, Math.round(Math.max(iw, ih) / 110));
  const cols = Math.max(1, Math.ceil(r.w / block)), rows = Math.max(1, Math.ceil(r.h / block));
  const key = `${r.x},${r.y},${r.w},${r.h}`;
  if (o._key !== key) {
    const t = document.createElement("canvas");
    t.width = cols;
    t.height = rows;
    t.getContext("2d").drawImage(source, r.x, r.y, r.w, r.h, 0, 0, cols, rows);
    o._px = t;
    o._key = key;
  }
  g.imageSmoothingEnabled = false;
  g.drawImage(o._px, r.x, r.y, r.w, r.h);
}

// Paint marks in source-pixel space. `pxScale` = device px per source px.
export function paintMarks(g, objs, pxScale, source, iw, ih) {
  let pin = 0;
  for (const o of objs) {
    g.save();
    switch (o.type) {
      case "pen":
        setShadow(g, o, pxScale);
        g.strokeStyle = o.color;
        g.lineWidth = o.w;
        g.lineCap = "round";
        g.lineJoin = "round";
        strokeSmooth(g, o.pts);
        break;
      case "hl":
        g.globalAlpha = 0.4;
        g.strokeStyle = o.color;
        g.lineWidth = o.w;
        g.lineCap = "round";
        g.lineJoin = "round";
        strokeSmooth(g, o.pts);
        break;
      case "arrow":
        drawArrow(g, o, pxScale);
        break;
      case "box": {
        const r = normRect(o);
        setShadow(g, o, pxScale);
        g.strokeStyle = o.color;
        g.lineWidth = o.w;
        g.lineJoin = "round";
        roundRectPath(g, r.x, r.y, r.w, r.h, o.w * 1.4);
        g.stroke();
        break;
      }
      case "text":
        drawText(g, o, pxScale);
        break;
      case "pin":
        pin += 1;
        drawPin(g, o, pin, pxScale);
        break;
      case "hide":
        drawHide(g, o, source, iw, ih);
        break;
      default:
        break;
    }
    g.restore();
  }
}

// Keep a finished mark? Too-short arrows and too-small boxes are stray clicks.
// `s` = display px per source px.
export function finishMark(d, s, iw, ih) {
  if (d.type === "arrow") return Math.hypot(d.x2 - d.x1, d.y2 - d.y1) * s > 6 ? d : null;
  if (d.type === "box" || d.type === "hide") {
    if (!(Math.abs(d.x2 - d.x1) * s > 4 && Math.abs(d.y2 - d.y1) * s > 4)) return null;
    if (d.type === "hide") {
      const r = normRect(d);
      return {
        ...d,
        x1: Math.round(clamp(r.x, 0, iw)), y1: Math.round(clamp(r.y, 0, ih)),
        x2: Math.round(clamp(r.x + r.w, 0, iw)), y2: Math.round(clamp(r.y + r.h, 0, ih)),
      };
    }
  }
  return d;
}

/* ── export ──────────────────────────────────────────────────────────── */

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// Halve while more than 2× too big, then one high-quality step: sharper than a
// single big downscale, which drops whole rows of thin UI lines.
function capCanvas(c, cap) {
  const t = capSize(c.width, c.height, cap);
  if (t.f === 1) return c;
  let cur = c;
  while (cur.width / 2 > t.w) {
    const n = makeCanvas(Math.round(cur.width / 2), Math.round(cur.height / 2));
    const ng = n.getContext("2d");
    ng.imageSmoothingQuality = "high";
    ng.drawImage(cur, 0, 0, n.width, n.height);
    cur = n;
  }
  const out = makeCanvas(t.w, t.h);
  const og = out.getContext("2d");
  og.imageSmoothingQuality = "high";
  og.drawImage(cur, 0, 0, t.w, t.h);
  return out;
}

// The PNG the agent gets: the crop (or the whole picture), with marks unless
// `clean`, capped to `cap` on the long edge.
export async function exportSketch({ source, iw, ih, objs, crop, clean = false, cap = MAX_EDGE }) {
  const r = crop ? { ...crop } : { x: 0, y: 0, w: iw, h: ih };
  const c = makeCanvas(r.w, r.h);
  const g = c.getContext("2d");
  g.translate(-r.x, -r.y);
  g.drawImage(source, 0, 0);
  if (!clean) paintMarks(g, objs, 1, source, iw, ih);
  const out = capCanvas(c, cap);
  const blob = await new Promise((res) => out.toBlob(res, "image/png"));
  return { blob, width: out.width, height: out.height };
}
