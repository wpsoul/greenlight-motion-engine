/*
 * OBJECT PLATE — the Canvas2D chassis the GEOMETRY programs draw on.
 *
 * WHY THESE SIX ARE NOT SHADERS
 * -----------------------------
 * The pixel programs (objectEffects.js) are per-fragment functions of the plate
 * and the weight field, so they compile to a fragment body. These are not: they
 * draw thousands of independent strokes, bordered marks, a Delaunay graph and —
 * for Node Labels — actual set type. There is no fragment formulation of "stroke
 * this polyline" that is not a worse drawing, and a hand-rolled glyph atlas is a
 * worse drawing of text than the browser's own text engine.
 *
 * So they follow the MOCKUP FRAME precedent that is already in Player.jsx:
 * Canvas2D → THREE.CanvasTexture → composited by a trivial fragment. That
 * machinery exists; this file does not invent a second one.
 *
 * COORDINATES. The plate IS the layer's box: it is drawn at the box's aspect,
 * with canvas y DOWN, and the shader samples it at `vec2(p.x, 1 - p.y)` where p
 * is fxLocal(). Same convention as the subject field (image row 0 = the top), so
 * the whole family flips in exactly one place per backend.
 *
 * COST. Nothing here runs unless a geometry effect is live: the Player builds a
 * plate only for an entry that survived the enabled / mix / Active-Range gates,
 * and re-draws only when the frame, the size or the params actually change — a
 * still draws once for the life of the project.
 */

import * as THREE from 'three';
import {
  getExtraction, mediaToken, delaunayTris, delaunayEdges, proximityEdges, chainEdges,
  spacedPoints, normStateFor, resetNormState,
} from './objectExtract';
import { createStabilizer, stabilize, stabOptions } from './objectStabilize';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* Colours arrive as the chain's hex strings. */
function hex2rgb(hex) {
  const h = String(hex || '#ffffff').replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const n = parseInt(s, 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [255, 255, 255];
}
const rgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${clamp(a, 0, 1)})`;

/*
 * Stable per-node randomness: a hash of WHERE the node is, never a sequence.
 * A sequence re-rolls every mark the moment the point order changes — which it
 * does every frame on video — and the whole field boils.
 */
function nodeHash(a, b, seed) {
  let x = Math.sin((a * 127.1 + b * 311.7 + seed * 0.731) * 43758.5453);
  x -= Math.floor(x);
  return x;
}

const OPEN_SHAPES = new Set(['cross', 'plus', 'bracket']);
const SHAPE_NAMES = ['circle', 'square', 'diamond', 'triangle', 'hex', 'cross', 'plus', 'bracket'];
const shapeName = (v) => SHAPE_NAMES[clamp(Math.round(v), 0, SHAPE_NAMES.length - 1)] || 'circle';

/* A node mark is an OUTLINE, not a dot — at these sizes a filled dot has no shape
   to read, and the reference's nodes are all bordered marks. */
function nodeShapePath(ctx, shape, x, y, r, rot) {
  ctx.beginPath();
  if (shape === 'circle') { ctx.arc(x, y, r, 0, TAU); return; }
  const pt = (a, rr) => [x + Math.cos(a + rot) * (rr === undefined ? r : rr),
    y + Math.sin(a + rot) * (rr === undefined ? r : rr)];
  if (shape === 'square' || shape === 'diamond') {
    const off = shape === 'diamond' ? 0 : Math.PI / 4;
    for (let i = 0; i < 4; i++) {
      const [px, py] = pt(off + (i / 4) * TAU, r * (shape === 'square' ? 1.32 : 1));
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.closePath();
    return;
  }
  if (shape === 'triangle' || shape === 'hex') {
    const n = shape === 'triangle' ? 3 : 6;
    for (let i = 0; i < n; i++) {
      const [px, py] = pt(-Math.PI / 2 + (i / n) * TAU);
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.closePath();
    return;
  }
  if (shape === 'cross' || shape === 'plus') {
    const a0 = shape === 'plus' ? 0 : Math.PI / 4;
    for (let i = 0; i < 2; i++) {
      const a = a0 + i * (Math.PI / 2);
      const [x1, y1] = pt(a);
      const [x2, y2] = pt(a + Math.PI);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    return;
  }
  // bracket — the reference's signature corner marks
  const k = r * 0.55;
  ctx.moveTo(x - r, y - r + k); ctx.lineTo(x - r, y - r); ctx.lineTo(x - r + k, y - r);
  ctx.moveTo(x + r - k, y - r); ctx.lineTo(x + r, y - r); ctx.lineTo(x + r, y - r + k);
  ctx.moveTo(x + r, y + r - k); ctx.lineTo(x + r, y + r); ctx.lineTo(x + r - k, y + r);
  ctx.moveTo(x - r + k, y + r); ctx.lineTo(x - r, y + r); ctx.lineTo(x - r, y + r - k);
}

/* ── The programs ───────────────────────────────────────────────────────────
   Every one takes the same context: the plate ctx, its size, the extraction (in
   PLATE coordinates already), the palette and the resolved params. */

const LABEL_WORDS = ['SIGNAL', 'FIELD', 'NODE', 'VECTOR', 'TRACE', 'EDGE', 'POINT', 'PHASE'];
const MONO = '"SFMono-Regular", Menlo, Consolas, monospace';

/*
 * Which marks are heroes. SHIPPED takes the top `hero%` BY RANK INDEX, which
 * reshuffles every frame on video even when the points barely moved — the second
 * half of churn source 4. Once points have identities they are ranked by their
 * SMOOTHED strength instead, so a hero stays a hero.
 */
function heroSet(P, heroPct, byId) {
  const n = Math.round(P.length * (heroPct / 100));
  const out = new Set();
  if (n <= 0) return out;
  if (!byId) {
    for (let i = 0; i < n && i < P.length; i++) out.add(P[i]);
    return out;
  }
  const rank = P.slice().sort((a, b) => (b.ms ?? b.m) - (a.ms ?? a.m));
  for (let i = 0; i < n && i < rank.length; i++) out.add(rank[i]);
  return out;
}

function drawNodes(ctx, W, H, ex, P, p, C, o = {}) {
  const heroes = heroSet(P, p.hero, !!o.byId);
  const vary = p.vary / 100;
  const jitter = p.random / 100;
  const sizePx = p.size * (H / 1080);
  const weightPx = Math.max(0.2, p.weight * (H / 1080));
  for (let i = 0; i < P.length; i++) {
    const q = P[i];
    const alpha = q.alpha ?? 1;
    if (alpha <= 0.002) continue;
    const hero = heroes.has(q);
    // hu/hv are the BIRTH uv: on an easing point, hashing the LIVE position
    // slowly re-rolls the mark's own shape and jitter as it travels.
    const h1 = nodeHash(q.hu ?? q.u, q.hv ?? q.v, p.seed);
    const h2 = nodeHash(q.hv ?? q.v, q.hu ?? q.u, p.seed + 17);
    const shape = p.shape >= SHAPE_NAMES.length
      ? SHAPE_NAMES[(h2 * 6) | 0]
      : shapeName(p.shape);
    const r = (sizePx / 2)
      * lerp(1, 0.55 + 0.9 * q.m, vary)
      * lerp(1, 0.3 + h1 * 1.7, jitter)
      * (hero ? p.heroScale / 100 : 1);
    const rot = (q.a + Math.PI / 2) * (p.rotate / 100);
    if (p.fill > 0 && !OPEN_SHAPES.has(shape)) {
      ctx.fillStyle = rgba(hero ? C.accent : C.ink, alpha * (p.fill / 100) * (hero ? 0.9 : 0.5 + 0.4 * q.w));
      nodeShapePath(ctx, shape, q.x, q.y, r, rot);
      ctx.fill();
    }
    ctx.lineWidth = weightPx * (hero ? 1.35 : 1);
    ctx.strokeStyle = rgba(hero ? C.accent : C.ink2, alpha * (hero ? 0.95 : 0.4 + 0.5 * q.w));
    nodeShapePath(ctx, shape, q.x, q.y, r, rot);
    ctx.stroke();
    if (hero && p.ring > 0) {
      ctx.strokeStyle = rgba(C.ink, alpha * (p.ring / 100) * 0.7);
      ctx.lineWidth = Math.max(0.4, weightPx * 0.6);
      ctx.beginPath();
      ctx.arc(q.x, q.y, r * 1.9, 0, TAU);
      ctx.stroke();
    }
  }
  if (p.labels > 0) drawLabels(ctx, W, H, P, p, C, o);
}

/*
 * NODE LABELS — a label is a MARK, not loose text: a chip, a boxed readout or a
 * tag on a rule, anchored to its node by a one-kink leader and an anchor square.
 * Floating text vanishes into any busy picture, which is what the first pass got
 * wrong. This is the one program in the family that can set real type, because
 * it is the one that draws on a canvas.
 */
function drawLabels(ctx, W, H, P, p, C, o = {}) {
  const size = Math.max(7, (p.labelSize || 11) * (H / 1080));
  ctx.font = `${size}px ${MONO}`;
  ctx.textBaseline = 'middle';
  const picks = spacedPoints(P, Math.round(p.labels / 100 * 26), Math.max(40, size * 6));
  const style = Math.round(p.labelStyle || 0);
  picks.forEach((q, i) => {
    const alpha = q.alpha ?? 1;
    if (alpha <= 0.002) return;
    const h1 = nodeHash(q.hu ?? q.u, q.hv ?? q.v, p.seed + 3);
    // SHIPPED numbers by rank index, so every label renumbers whenever the
    // ranking moves. With identities the number rides its own point.
    const num = o.byId && q.id !== undefined ? (q.id % 100) : i;
    const txt = style === 3
      ? `${LABEL_WORDS[(h1 * LABEL_WORDS.length) | 0]}_${String(10 + ((h1 * 89) | 0))}`
      : `N${String(num).padStart(2, '0')}·${((q.m * 999) | 0)}`;
    const tw = ctx.measureText(txt).width;
    const dir = q.x < W / 2 ? 1 : -1;
    const lx = q.x + dir * size * 3.2;
    const ly = q.y - size * 1.6;

    ctx.strokeStyle = rgba(C.ink, alpha * 0.5);
    ctx.lineWidth = Math.max(0.5, 0.9 * (H / 1080));
    ctx.beginPath();
    ctx.moveTo(q.x, q.y);
    ctx.lineTo(q.x + dir * size * 1.2, ly);
    ctx.lineTo(dir > 0 ? lx - 3 : lx + 3, ly);
    ctx.stroke();
    ctx.fillStyle = rgba(C.accent, alpha * 0.9);
    ctx.fillRect(q.x - 1.5, q.y - 1.5, 3, 3);

    const bx = dir > 0 ? lx : lx - tw - 10;
    if (style === 0) {                                   // chip
      ctx.fillStyle = rgba(C.ink2, alpha * 0.75);
      ctx.fillRect(bx, ly - size * 0.75, tw + 10, size * 1.5);
      ctx.fillStyle = rgba(C.paper, alpha * 0.95);
    } else if (style === 1) {                            // outlined box
      ctx.strokeStyle = rgba(C.accent, alpha * 0.8);
      ctx.strokeRect(bx, ly - size * 0.75, tw + 10, size * 1.5);
      ctx.fillStyle = rgba(C.accent, alpha * 0.9);
    } else {                                             // tag on a rule
      ctx.strokeStyle = rgba(C.ink, alpha * 0.6);
      ctx.beginPath();
      ctx.moveTo(bx, ly + size * 0.85);
      ctx.lineTo(bx + tw + 10, ly + size * 0.85);
      ctx.stroke();
      ctx.fillStyle = rgba(C.ink, alpha * 0.9);
    }
    ctx.fillText(txt, bx + 5, ly);
  });
  ctx.textBaseline = 'alphabetic';
}

function drawLinks(ctx, W, H, ex, P, p, C, o = {}) {
  const maxDist = (p.dist / 100) * Math.max(W, H);
  const conf = p.conf / 100;
  const mode = Math.round(p.mode);
  let edges = [];
  if (mode === 0) edges = proximityEdges(P, maxDist);
  else if (mode === 1) edges = delaunayEdges(P, 700, maxDist * 2.2);
  else if (mode === 2) edges = chainEdges(P, maxDist);
  else if (mode === 3) {
    const hubs = P.slice(0, Math.max(1, Math.round(P.length * 0.02)));
    for (const q of P) {
      let best = hubs[0];
      let bd = Infinity;
      for (const hh of hubs) {
        const d = (q.x - hh.x) ** 2 + (q.y - hh.y) ** 2;
        if (d < bd) { bd = d; best = hh; }
      }
      if (best && Math.sqrt(bd) < maxDist * 2.5) edges.push([q, best]);
    }
  } else if (mode === 4) {
    edges = proximityEdges(P, maxDist).map(([a, b]) => [a, b, 'L']);
  } else {
    edges = delaunayEdges(P, 420, maxDist * 1.6).concat(proximityEdges(P, maxDist * 0.5));
  }
  ctx.lineWidth = Math.max(0.2, p.weight * (H / 1080));
  /*
   * One path, one stroke — as shipped — unless a point is mid-fade, in which
   * case its segments have to fade with it. Four alpha buckets keep that to four
   * strokes rather than one per segment.
   */
  const BUCKETS = 4;
  const buckets = o.byId ? Array.from({ length: BUCKETS }, () => []) : null;
  ctx.beginPath();
  for (const e of edges) {
    const [a, b] = e;
    if ((a.m + b.m) / 2 < (1 - conf) * 0.6) continue;
    if (buckets) {
      const al = Math.min(a.alpha ?? 1, b.alpha ?? 1);
      if (al <= 0.002) continue;
      if (al < 0.999) { buckets[clamp(Math.ceil(al * BUCKETS) - 1, 0, BUCKETS - 1)].push(e); continue; }
    }
    if (e[2] === 'L') {
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, a.y); ctx.lineTo(b.x, b.y);
    } else {
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
  }
  ctx.strokeStyle = rgba(C.ink2, 0.55);
  ctx.stroke();
  if (buckets) {
    for (let i = 0; i < BUCKETS; i++) {
      if (!buckets[i].length) continue;
      ctx.beginPath();
      for (const e of buckets[i]) {
        const [a, b] = e;
        if (e[2] === 'L') { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, a.y); ctx.lineTo(b.x, b.y); }
        else { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      }
      ctx.strokeStyle = rgba(C.ink2, 0.55 * ((i + 1) / BUCKETS));
      ctx.stroke();
    }
  }
  return edges.length;
}

function drawFacets(ctx, W, H, ex, P, p, C, o = {}) {
  const tris = delaunayTris(P, Math.round(p.detail));
  const fading = !!o.byId;
  const img = ex.img.data;
  const subjOnly = p.subject / 100;
  /*
   * THE HULL SLIVERS, again. The plan records this for the link graph — raw
   * Delaunay draws long rays from the subject out to the frame corners, and they
   * read as a bug rather than a look. The FILLED version is worse: those slivers
   * become pale wedges fanning across the whole frame. Capping the longest SIDE
   * drops exactly the degenerate boundary triangles and nothing else.
   */
  const maxSide = (p.maxSide / 100) * Math.max(W, H);
  ctx.lineJoin = 'round';
  for (const t of tris) {
    const longest = Math.max(
      Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y),
      Math.hypot(t[1].x - t[2].x, t[1].y - t[2].y),
      Math.hypot(t[2].x - t[0].x, t[2].y - t[0].y),
    );
    if (longest > maxSide) continue;
    const cx = (t[0].x + t[1].x + t[2].x) / 3;
    const cy = (t[0].y + t[1].y + t[2].y) / 3;
    const u = cx / W;
    const v = cy / H;
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    const wgt = (t[0].w + t[1].w + t[2].w) / 3;
    if (subjOnly > 0 && wgt < subjOnly * 0.9) continue;
    const alpha = fading ? Math.min(t[0].alpha ?? 1, t[1].alpha ?? 1, t[2].alpha ?? 1) : 1;
    if (alpha <= 0.002) continue;
    const ax = clamp(Math.round(u * ex.aw), 0, ex.aw - 1);
    const ay = clamp(Math.round(v * ex.ah), 0, ex.ah - 1);
    const i = (ay * ex.aw + ax) * 4;
    let r = img[i];
    let g = img[i + 1];
    let b = img[i + 2];
    if (p.shade === 2) {                       // monochrome
      const l = ex.raw[ay * ex.aw + ax];
      r = lerp(C.ink[0], C.accent[0], l);
      g = lerp(C.ink[1], C.accent[1], l);
      b = lerp(C.ink[2], C.accent[2], l);
    } else if (p.shade === 1) {                // facing ramp
      const ang = Math.atan2(t[1].y - t[0].y, t[1].x - t[0].x);
      const k = 0.28 * (0.5 + 0.5 * Math.sin(ang * 2));
      r = lerp(r, C.accent[0], k);
      g = lerp(g, C.accent[1], k);
      b = lerp(b, C.accent[2], k);
    }
    ctx.beginPath();
    ctx.moveTo(t[0].x, t[0].y);
    ctx.lineTo(t[1].x, t[1].y);
    ctx.lineTo(t[2].x, t[2].y);
    ctx.closePath();
    ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${clamp(alpha * p.fill / 100, 0, 1)})`;
    ctx.fill();
    if (p.edge > 0) {
      ctx.lineWidth = p.edge * (H / 1080);
      ctx.strokeStyle = rgba(C.ink2, alpha * 0.5);
      ctx.stroke();
    }
  }
}

function drawMeasure(ctx, W, H, ex, P, p, C, ctxExtra) {
  const { box, face } = ctxExtra;
  let b = null;
  const target = Math.round(p.target);
  if (target === 2) b = { x: 0, y: 0, w: 1, h: 1 };
  else if (target === 1) b = face ? { x: face[0], y: face[1], w: face[2], h: face[3] } : null;
  else b = box ? { x: box[0], y: box[1], w: box[2], h: box[3] } : null;
  if (!b) return;

  const pad = p.pad / 100;
  const x0 = (b.x - b.w * pad) * W;
  const y0 = (b.y - b.h * pad) * H;
  const bw = b.w * (1 + pad * 2) * W;
  const bh = b.h * (1 + pad * 2) * H;
  const k1 = H / 1080;
  ctx.lineWidth = Math.max(0.3, p.weight * k1);
  ctx.font = `${Math.max(8, 12 * k1)}px ${MONO}`;
  ctx.textBaseline = 'middle';
  const A = rgba(C.accent, 0.95);
  const B = rgba(C.ink, 0.7);

  if (p.corners > 0) {
    ctx.strokeStyle = A;
    const k = Math.min(bw, bh) * 0.11 * (p.corners / 100);
    ctx.beginPath();
    ctx.moveTo(x0, y0 + k); ctx.lineTo(x0, y0); ctx.lineTo(x0 + k, y0);
    ctx.moveTo(x0 + bw - k, y0); ctx.lineTo(x0 + bw, y0); ctx.lineTo(x0 + bw, y0 + k);
    ctx.moveTo(x0 + bw, y0 + bh - k); ctx.lineTo(x0 + bw, y0 + bh); ctx.lineTo(x0 + bw - k, y0 + bh);
    ctx.moveTo(x0 + k, y0 + bh); ctx.lineTo(x0, y0 + bh); ctx.lineTo(x0, y0 + bh - k);
    ctx.stroke();
  }
  if (p.dims > 0) {
    ctx.globalAlpha = p.dims / 100;
    ctx.strokeStyle = B;
    const off = 18 * k1;
    const tick = 6 * k1;
    ctx.beginPath();
    ctx.moveTo(x0, y0 - off); ctx.lineTo(x0 + bw, y0 - off);
    ctx.moveTo(x0, y0 - off - tick); ctx.lineTo(x0, y0 - off + tick);
    ctx.moveTo(x0 + bw, y0 - off - tick); ctx.lineTo(x0 + bw, y0 - off + tick);
    ctx.moveTo(x0 + bw + off, y0); ctx.lineTo(x0 + bw + off, y0 + bh);
    ctx.moveTo(x0 + bw + off - tick, y0); ctx.lineTo(x0 + bw + off + tick, y0);
    ctx.moveTo(x0 + bw + off - tick, y0 + bh); ctx.lineTo(x0 + bw + off + tick, y0 + bh);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (p.cross > 0) {
    const cx = x0 + bw / 2;
    const cy = y0 + bh / 2;
    const k = Math.min(bw, bh) * 0.07;
    ctx.globalAlpha = p.cross / 100;
    ctx.strokeStyle = A;
    ctx.beginPath();
    ctx.moveTo(cx - k, cy); ctx.lineTo(cx + k, cy);
    ctx.moveTo(cx, cy - k); ctx.lineTo(cx, cy + k);
    ctx.arc(cx, cy, k * 0.45, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (p.readout > 0) {
    ctx.globalAlpha = p.readout / 100;
    ctx.fillStyle = A;
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(bw)} px`, x0 + bw / 2, y0 - 30 * k1);
    ctx.save();
    ctx.translate(x0 + bw + 30 * k1, y0 + bh / 2);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(`${Math.round(bh)} px`, 0, 0);
    ctx.restore();
    ctx.textAlign = 'left';
    const tag = target === 1 ? `FACE ${(((face?.[4] || 0) * 100) | 0)}%`
      : (target === 2 ? 'FRAME' : `SUBJECT ${((ctxExtra.coverage || 0) * 100).toFixed(1)}%`);
    ctx.fillText(tag, x0, y0 + bh + 16 * k1);
    ctx.globalAlpha = 1;
  }
  ctx.textBaseline = 'alphabetic';
}

const PROGRAMS = {
  objectNodes: drawNodes,
  objectLinks: drawLinks,
  objectFacets: drawFacets,
  objectMeasure: drawMeasure,
};

/** Does this effect id draw on a plate rather than in a fragment? */
export function isPlateProgram(id) {
  return Object.prototype.hasOwnProperty.call(PROGRAMS, id);
}

/*
 * ── The per-instance plate ──────────────────────────────────────────────────
 * One canvas + CanvasTexture per eid, exactly like the field texture in
 * objectTracking.js: keyed by the effect INSTANCE so two geometry effects on one
 * layer never fight over a canvas, and re-drawn only when its key changes.
 *
 * The raster budget is Mockup Frame's rule: the plate never exceeds
 * MAX_PLATE px on its long edge, however big the render is. A 4K render does not
 * get a 4K canvas of hairlines — it gets the same drawing, sampled up.
 */
const MAX_PLATE = 1600;
const PLATES = new Map();
/* The stabiliser's memory, per effect INSTANCE — the live point set with its
   identities. Lives and dies with the plate: released and evicted together. */
const STABS = new Map();
let plateSeq = 0;
const MAX_PLATES = 8;

function evictPlates() {
  while (PLATES.size > MAX_PLATES) {
    let oldest = null;
    let oldestUsed = Infinity;
    for (const [k, v] of PLATES) if (v.used < oldestUsed) { oldestUsed = v.used; oldest = k; }
    const hit = PLATES.get(oldest);
    try { hit?.texture?.dispose(); } catch { /* already gone */ }
    PLATES.delete(oldest);
    STABS.delete(oldest);
  }
}

export function releaseObjectPlate(eid) {
  STABS.delete(eid);
  const hit = eid && PLATES.get(eid);
  if (!hit) return;
  try { hit.texture?.dispose(); } catch { /* already gone */ }
  PLATES.delete(eid);
}

export function releaseAllObjectPlates() {
  for (const k of [...PLATES.keys()]) releaseObjectPlate(k);
}

/**
 * Build (or reuse) this instance's geometry plate.
 *
 *   id        the effect id — picks the program
 *   eid       the effect INSTANCE — owns the canvas
 *   media     the layer's media element (the extraction's pixels)
 *   boxPx     the layer's on-screen box size, [w, h] in plate px
 *   params    the resolved param object
 *   colors    { ink, ink2, accent, paper } as hex strings
 *   field     decoded subject weight field (or null), with fieldW/fieldH
 *   frameKey  a value that changes when the SOURCE FRAME changes
 *   isVideo   the layer is a video — the only case the stabiliser runs for
 *   timeMs    the source time, so a seek reads as a discontinuity
 *
 * Returns { texture, w, h } or null when there is nothing to draw yet.
 */
export function resolveObjectPlate({
  id, eid, media, boxPx, params, colors, field = null, fieldW = 64, fieldH = 64,
  face = null, box = null, coverage = 0, frameKey = 'still', quality = 1,
  isVideo = false, timeMs = 0,
}) {
  const program = PROGRAMS[id];
  if (!program || !eid || !media) return null;

  /*
   * THE DENSITY LADDER (Mockup Frame's rule). On a still the plate is drawn once
   * and held, so the authored density is free. On VIDEO it is redrawn every
   * frame — measured at +23.5 ms/frame for a 600-point Delaunay at a 384-px
   * analysis — and that is what makes scrubbing heavy. While the preview is in
   * its interactive mode the analysis drops to 256 and the point budget to 60%;
   * a full-quality preview and every export keep exactly what was authored.
   */
  const interactive = quality < 0.99;
  const effParams = interactive
    ? {
      ...params,
      analysis: Math.min(params.analysis || 384, 256),
      density: Math.max(40, Math.round((params.density || 600) * 0.6)),
    }
    : params;

  const longEdge = Math.max(boxPx[0], boxPx[1]) || 1;
  const scale = Math.min(1, MAX_PLATE / longEdge);
  const W = Math.max(16, Math.round(boxPx[0] * scale));
  const H = Math.max(16, Math.round(boxPx[1] * scale));

  /*
   * ONE canonical signature, used by both caches below. Everything the drawing
   * depends on and nothing it does not: WHICH PICTURE (a shared global cache
   * keyed only by time handed one video's geometry to another), the frame, the
   * plate size, the quality rung, every param the program reads, the colours, and
   * the subject field with its dimensions and the face box that shapes it.
   */
  const faceSig = face ? face.slice(0, 4).map((n) => Math.round(n * 1000)).join(',') : 'noface';
  const sig = `${mediaToken(media)}|${frameKey}|${interactive ? 'i' : 'f'}|${fieldW}x${fieldH}|${field ? field.length : 0}|${faceSig}`;
  const key = `${id}|${W}x${H}|${sig}|${JSON.stringify(effParams)}|${JSON.stringify(colors)}`;

  let hit = PLATES.get(eid);
  if (hit && (hit.canvas.width !== W || hit.canvas.height !== H)) {
    releaseObjectPlate(eid);
    hit = null;
  }
  if (!hit) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.premultiplyAlpha = false;
    /*
     * flipY FALSE, and this is the family's one non-obvious orientation line.
     * THREE.Texture defaults flipY to TRUE (DataTexture opts out, CanvasTexture
     * does not), so the canvas would upload upside down and the shader's single
     * `1 - p.y` flip would then be the SECOND one — putting the drawing back
     * where it started while every other program in the pack was correct. With
     * flipY off, v=0 is canvas row 0 is the top of the layer, exactly like the
     * subject field.
     */
    texture.flipY = false;
    // `used` is stamped BEFORE the eviction sweep, not after. With `used: 0` the
    // entry that was just created is the lowest-scoring one in the map, so the
    // sweep evicts it immediately — and every frame then redraws every plate
    // while looking exactly like a cache that is merely cold. Caught by
    // probe_plate_cost.mjs: a cache HIT was costing a full 7 ms redraw.
    hit = { canvas, ctx: canvas.getContext('2d'), texture, key: null, used: ++plateSeq };
    PLATES.set(eid, hit);
    evictPlates();
  }
  hit.used = ++plateSeq;

  /*
   * THE STABILISER — video only, and only for the programs that draw points
   * (Measure Rig annotates a box). See objectStabilize.js for what it fixes.
   * At Stabilise 0 this whole branch is skipped and the flow below is exactly
   * the pre-10.9.77 one: one draw per (frame, size, params), stills once ever.
   */
  const stabPct = (isVideo && id !== 'objectMeasure')
    ? clamp(Number(effParams.stabilise) || 0, 0, 100) : 0;
  const o = stabPct > 0 ? stabOptions(stabPct) : null;
  let S = null;
  if (o) {
    S = STABS.get(eid);
    if (!S) { S = createStabilizer(); STABS.set(eid, S); }
  }
  if (hit.key === key) return { texture: hit.texture, w: W, h: H };

  /*
   * The extraction key repeats every input the extraction READS, including the
   * three that used to be passed in but left out of it — Face Protect, the face
   * box and the seed. Leaving them out meant flipping Face Protect from Off to
   * Exclude redrew the plate from the PREVIOUS point set (zero visible change),
   * and two effects with different protection settings depended on which one
   * drew first. The stabiliser's dial is in it too: it moves the points.
   */
  const analysis = effParams.analysis || 384;
  const exOpts = {
    analysis,
    preBlur: effParams.preBlur ?? 1,
    threshold: (effParams.threshold ?? 5) / 100,
    density: effParams.density ?? 600,
    bias: (effParams.bias ?? 70) / 100,
    field,
    fieldW,
    fieldH,
    face,
    faceProtect: Math.round(effParams.faceProtect || 0),
    seed: effParams.seed || 7,
  };
  const exKeyBase = `${exOpts.analysis}|${exOpts.preBlur}|${effParams.threshold ?? 5}|${exOpts.density}|${effParams.bias ?? 70}|${exOpts.faceProtect}|${exOpts.seed}`;

  /*
   * Everything a seek-free run must keep constant for the easing to be valid:
   * the picture and every rule that decides WHICH ridges become points. NOT
   * analysis or density — the interactive ladder scales both while scrubbing,
   * and a reset there would re-deal the marks at every scrub; the budget is
   * enforced per solve and positions are rescaled across the rung instead.
   */
  const contSig = `${mediaToken(media)}|${effParams.threshold ?? 5}|${exOpts.preBlur}|${effParams.bias ?? 70}|${exOpts.faceProtect}|${exOpts.seed}`;
  let snap = false;
  if (S) {
    /*
     * A DISCONTINUITY is anything the easing must not try to bridge: a seek, a
     * different clip, a changed extraction rule. The analysis rung is NOT one —
     * scrubbing flips it 384→256 and back, and a reset on every scrub would
     * read as the marks re-dealing themselves; live positions are rescaled
     * across the rung instead, below.
     */
    snap = S.sig !== contSig
      || !Number.isFinite(S.lastT)
      || timeMs < S.lastT - 1
      || timeMs - S.lastT > 250;
    S.normKey = `${contSig}|${analysis}`;
    if (snap) resetNormState(S.normKey);
    exOpts.centroid = o.centroid;
    exOpts.normState = normStateFor(S.normKey, o.normEase);
  }

  const ex = getExtraction(`${sig}|${exKeyBase}|s${o ? o.s.toFixed(2) : 0}`, media, exOpts);
  if (!ex) return null;

  let P;
  if (S) {
    if (S.aw && (S.aw !== ex.aw || S.ah !== ex.ah)) {
      const kx = ex.aw / S.aw;
      const ky = ex.ah / S.ah;
      for (const q of S.live) { q.x *= kx; q.y *= ky; }
    }
    /*
     * ONE advance per SOURCE frame. A repaint of the same frame — an export
     * waiting on another asset, a paused preview — must draw the same thing,
     * so the state only moves when the frame does. Easing is therefore per
     * video frame, which is exactly what the lab measured.
     */
    if (snap || S.lastFrameKey !== frameKey) {
      stabilize(S, ex, o, snap);
      S.lastFrameKey = frameKey;
      S.sig = contSig;
      S.lastT = timeMs;
      S.aw = ex.aw;
      S.ah = ex.ah;
    }
    P = S.live.map((q) => ({ ...q, x: q.u * W, y: q.v * H }));
  } else {
    // The extraction works in ANALYSIS px; the plate is the layer's box. Points
    // carry their own uv, so the map is one multiply and never a re-run.
    P = ex.pts.map((q) => ({ ...q, x: q.u * W, y: q.v * H }));
  }

  const { ctx } = hit;
  ctx.clearRect(0, 0, W, H);
  ctx.lineCap = 'round';
  const C = {
    ink: hex2rgb(colors.ink),
    ink2: hex2rgb(colors.ink2 || colors.ink),
    accent: hex2rgb(colors.accent || '#ffffff'),
    paper: hex2rgb(colors.paper || '#000000'),
  };
  program(ctx, W, H, ex, P, effParams, C, { face, box, coverage, byId: !!S });

  hit.texture.needsUpdate = true;
  hit.key = key;
  return { texture: hit.texture, w: W, h: H };
}
