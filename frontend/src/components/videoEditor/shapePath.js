// Editable bezier outlines for shape layers.
//
// Points live in UNIT BOX space: (0, 0) is the centre of the shape's own box and
// ±0.5 is its edge. That keeps the SHAPE section's Width/Height fields scaling the
// path, keeps the preview transform gizmo's own size maths correct, and makes a
// keyframed morph resolution-independent. Points may travel outside ±0.5 — the
// texture plate grows to cover them.
//
// Tangents are stored as OFFSETS from their anchor (`hIn` / `hOut`), so dragging an
// anchor takes its handles with it; `manual` marks a hand-shaped anchor that the
// auto-tangent pass must leave alone.
//
// This is the 2D port of the camera path in projectCamera.js — same field names,
// same Catmull-Rom auto-tangent maths, same uniform-parameter evaluation — so the
// two editors behave identically and one set of gotchas covers both.
//
// Layer Mask (layerMask.js) stores its outlines in exactly this shape, so every
// helper below applies to a mask verbatim — that is the whole reason masks are
// bezier paths in a unit box rather than their own geometry model.

import { isMaskPathTrackKey } from './keyframeProps.js';
import {
  resolveLineStroke,
  strokeEngineActive,
  strokeEngineReach,
  STROKE_KF_TRACKS,
  strokeKfTrack,
} from './pathStroke.js';

const num = (value, fallback = 0) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const round4 = (n) => Math.round(n * 10000) / 10000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Circle/ellipse control-handle length for a quarter arc, scaled to the ±0.5 box.
const KAPPA = 0.5522847498307936 * 0.5;

export const SHAPE_PATH_DEFAULT = { points: [], closed: true };

// Reserved keyframe track key. Its value is a JSON point list rather than a
// number or a colour — the only non-scalar track in the editor — so every site
// that samples or seeds a track needs an explicit branch on it.
export const SHAPE_PATH_KF_KEY = 'shapePath';

export const SHAPE_PATH_KF_GROUP = 'Shape';

const vec2 = (v) => {
  if (!v || typeof v !== 'object') return null;
  return { x: num(v.x), y: num(v.y) };
};

export function sanitizeShapePathPoints(points) {
  if (!Array.isArray(points)) return [];
  const clean = [];
  for (const p of points) {
    if (!p || typeof p !== 'object') continue;
    if (!Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) continue;
    // Keep points on a sane leash: a runaway drag (or a corrupt file) must not be
    // able to demand a texture plate thousands of box-widths across.
    const point = { x: clamp(num(p.x), -8, 8), y: clamp(num(p.y), -8, 8) };
    const hIn = vec2(p.hIn);
    const hOut = vec2(p.hOut);
    if (hIn) point.hIn = { x: clamp(hIn.x, -8, 8), y: clamp(hIn.y, -8, 8) };
    if (hOut) point.hOut = { x: clamp(hOut.x, -8, 8), y: clamp(hOut.y, -8, 8) };
    if (p.manual === true) point.manual = true;
    clean.push(point);
  }
  return clean;
}

export function sanitizeShapePath(path) {
  if (!path || typeof path !== 'object') return null;
  const points = sanitizeShapePathPoints(path.points);
  if (!points.length) return null;
  return { points, closed: path.closed !== false };
}

export function shapePathIsLive(path) {
  return Array.isArray(path?.points) && path.points.length >= 2;
}

// Auto tangents for anchors the user hasn't shaped. Derived from the Catmull-Rom
// tangent m = (P[i+1] - P[i-1]) / 2, whose equivalent cubic-bezier control offset
// is m/3 — so an untouched path is exactly the Catmull-Rom curve through its
// points, and a hand-dragged handle is a local departure from it.
//
// MUTATES IN PLACE, and rewrites every non-`manual` anchor — never call it while a
// tangent is being dragged, or it will fight the gesture.
export function refreshShapePathHandles(points, closed) {
  const n = points.length;
  if (n < 2) return points;
  const at = (i) => {
    const idx = closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    return points[idx];
  };
  for (let i = 0; i < n; i += 1) {
    if (points[i].manual) continue;
    const prev = at(i - 1);
    const next = at(i + 1);
    let mx; let my;
    if (!closed && i === 0) {
      mx = next.x - points[0].x; my = next.y - points[0].y;
    } else if (!closed && i === n - 1) {
      mx = points[n - 1].x - prev.x; my = points[n - 1].y - prev.y;
    } else {
      mx = (next.x - prev.x) * 0.5; my = (next.y - prev.y) * 0.5;
    }
    mx /= 3; my /= 3;
    points[i].hOut = { x: round4(mx), y: round4(my) };
    points[i].hIn = { x: round4(-mx), y: round4(-my) };
  }
  return points;
}

const bezier = (a, b, c, d, t) => {
  const u = 1 - t;
  return (u * u * u * a) + (3 * u * u * t * b) + (3 * u * t * t * c) + (t * t * t * d);
};

const bezierDeriv = (a, b, c, d, t) => {
  const u = 1 - t;
  return (3 * u * u * (b - a)) + (6 * u * t * (c - b)) + (3 * t * t * (d - c));
};

// Segment count: a closed path wraps the last point back to the first.
export function shapePathSegments(points, closed) {
  const n = points?.length || 0;
  if (n < 2) return 0;
  return closed ? n : n - 1;
}

// Resolve a global 0-1 parameter to { index, t } within one segment.
export function shapePathSegmentAt(points, closed, u) {
  const segments = shapePathSegments(points, closed);
  if (!segments) return null;
  const clamped = closed ? ((u % 1) + 1) % 1 : clamp(u, 0, 1);
  const scaled = clamped * segments;
  let index = Math.floor(scaled);
  if (index >= segments) index = segments - 1;
  return { index, t: scaled - index };
}

/**
 * Point (and unit tangent) at `u` (0-1) along the path.
 *
 * Segments are walked at uniform parameter rather than by arc length — same
 * trade-off as the camera path: exactness is not worth resampling the whole curve
 * for what is a drawing/hit-testing aid.
 */
export function evaluateShapePath(points, closed, u) {
  const hit = shapePathSegmentAt(points, closed, u);
  if (!hit) return null;
  const a = points[hit.index];
  const b = points[(hit.index + 1) % points.length];
  const ah = a.hOut || { x: 0, y: 0 };
  const bh = b.hIn || { x: 0, y: 0 };
  const axis = (k) => {
    const p0 = a[k];
    const p1 = a[k] + ah[k];
    const p2 = b[k] + bh[k];
    const p3 = b[k];
    return { value: bezier(p0, p1, p2, p3, hit.t), slope: bezierDeriv(p0, p1, p2, p3, hit.t) };
  };
  const x = axis('x'); const y = axis('y');
  const len = Math.hypot(x.slope, y.slope) || 1;
  const segments = shapePathSegments(points, closed);
  return {
    position: { x: x.value, y: y.value },
    tangent: { x: x.slope / len, y: y.slope / len },
    // Raw derivative with respect to the GLOBAL 0-1 parameter (the per-segment
    // slope times the segment count). Resampling needs the magnitude, not just the
    // direction, to rebuild handles that reproduce the same curve.
    derivative: { x: x.slope * segments, y: y.slope * segments },
  };
}

/**
 * Rebuild the same outline with exactly `n` anchors.
 *
 * Used when a preset is applied to a path that is already keyframed: every key has
 * to keep the same point count, so the preset is matched to it instead of the
 * keyframes being thrown away. Anchors land at equal ARC LENGTH, and each handle is
 * the curve's own derivative scaled into the new segment's parameter range — so a
 * resample to the point count the shape already has is exact, not an approximation.
 */
export function resampleShapePath(points, closed, n) {
  if (!Array.isArray(points) || points.length < 2 || n < 2) return points;
  const segments = shapePathSegments(points, closed);
  // Arc length by dense sampling: uniform parameter bunches anchors up on the
  // tight parts of a curve, which reads as a lopsided shape.
  const STEPS = Math.max(400, segments * 80);
  const us = [0];
  const lens = [0];
  let prev = evaluateShapePath(points, closed, 0).position;
  let total = 0;
  for (let i = 1; i <= STEPS; i += 1) {
    const u = i / STEPS;
    const p = evaluateShapePath(points, closed, u).position;
    total += Math.hypot(p.x - prev.x, p.y - prev.y);
    us.push(u); lens.push(total);
    prev = p;
  }
  if (total <= 1e-9) return points;
  const uAt = (target) => {
    // lens is monotonic; walk once per lookup (n is small).
    for (let i = 1; i < lens.length; i += 1) {
      if (lens[i] >= target) {
        const span = lens[i] - lens[i - 1] || 1;
        const f = (target - lens[i - 1]) / span;
        return us[i - 1] + (us[i] - us[i - 1]) * f;
      }
    }
    return 1;
  };
  const count = closed ? n : n - 1;
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const u = i === 0 ? 0 : uAt((total * i) / count);
    samples.push({ u, hit: evaluateShapePath(points, closed, Math.min(u, 1)) });
  }
  const out = samples.map((s, i) => {
    const next = samples[(i + 1) % samples.length];
    const prevS = samples[(i - 1 + samples.length) % samples.length];
    // Parameter width of the segment on each side, wrapping for a closed path.
    const spanOut = (closed && i === samples.length - 1) ? (1 - s.u) + next.u : next.u - s.u;
    const spanIn = (closed && i === 0) ? s.u + (1 - prevS.u) : s.u - prevS.u;
    const dOut = (closed || i < samples.length - 1) ? Math.max(spanOut, 0) / 3 : 0;
    const dIn = (closed || i > 0) ? Math.max(spanIn, 0) / 3 : 0;
    return {
      x: round4(s.hit.position.x),
      y: round4(s.hit.position.y),
      hOut: { x: round4(s.hit.derivative.x * dOut), y: round4(s.hit.derivative.y * dOut) },
      hIn: { x: round4(-s.hit.derivative.x * dIn), y: round4(-s.hit.derivative.y * dIn) },
      manual: true,
    };
  });
  return out;
}

/**
 * The outline as `n` positions at equal ARC LENGTH, in unit-box space — a
 * Float32Array of xy pairs ready to bake into a GPU lookup (Neon Path Glow reads
 * it as a 1-D texture). Closed paths cover [0,1) with the seam excluded (sample n
 * wraps back onto sample 0); open paths land their last sample exactly on the end
 * point. Same dense-walk arc-length table as resampleShapePath, minus the handle
 * reconstruction that sampler exists for.
 */
export function sampleShapePathPolyline(points, closed, n) {
  if (!Array.isArray(points) || points.length < 2 || !(n >= 2)) return null;
  const segments = shapePathSegments(points, closed);
  const STEPS = Math.max(240, segments * 60);
  const us = [0];
  const lens = [0];
  let prev = evaluateShapePath(points, closed, 0).position;
  let total = 0;
  for (let i = 1; i <= STEPS; i += 1) {
    const u = i / STEPS;
    const p = evaluateShapePath(points, closed, u).position;
    total += Math.hypot(p.x - prev.x, p.y - prev.y);
    us.push(u); lens.push(total);
    prev = p;
  }
  const out = new Float32Array(n * 2);
  if (total <= 1e-9) {
    for (let i = 0; i < n; i += 1) { out[i * 2] = prev.x; out[i * 2 + 1] = prev.y; }
    return out;
  }
  // lens is monotonic and the targets ascend, so one cursor walks the table once.
  let cursor = 1;
  const count = closed ? n : n - 1;
  for (let i = 0; i < n; i += 1) {
    const target = (total * i) / count;
    while (cursor < lens.length - 1 && lens[cursor] < target) cursor += 1;
    const span = lens[cursor] - lens[cursor - 1] || 1;
    const f = clamp((target - lens[cursor - 1]) / span, 0, 1);
    const u = us[cursor - 1] + (us[cursor] - us[cursor - 1]) * f;
    const hit = evaluateShapePath(points, closed, Math.min(u, 1));
    out[i * 2] = hit.position.x;
    out[i * 2 + 1] = hit.position.y;
  }
  return out;
}

/**
 * Unit points → a Path2D in canvas coordinates, centred on (cx, cy) and scaled by
 * the shape's box (w, h). Returns null for a path too short to draw.
 */
export function buildPathOutline(points, closed, cx, cy, w, h) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const px = (p) => cx + p.x * w;
  const py = (p) => cy + p.y * h;
  const path = new Path2D();
  path.moveTo(px(points[0]), py(points[0]));
  const segments = shapePathSegments(points, closed);
  for (let i = 0; i < segments; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ah = a.hOut || { x: 0, y: 0 };
    const bh = b.hIn || { x: 0, y: 0 };
    path.bezierCurveTo(
      cx + (a.x + ah.x) * w, cy + (a.y + ah.y) * h,
      cx + (b.x + bh.x) * w, cy + (b.y + bh.y) * h,
      px(b), py(b)
    );
  }
  if (closed) path.closePath();
  return path;
}

/**
 * The outline flattened to a point list in canvas coordinates. Straight segments
 * contribute their endpoint only, so a rectangle flattens to its four corners.
 *
 * `tolerancePx` bounds the chord's sagitta, and the step count follows sqrt(len)
 * because that is how sagitta scales: a curve four times as long needs twice the
 * segments to stay the same distance off it, not four times as many. A fixed
 * step would put ~170 segments on a 1024 px arc for the same 0.3 px accuracy 23
 * segments buy — and every one of those is a separate capsule for the caller to
 * rasterize.
 */
function flattenOutlinePoints(points, closed, cx, cy, w, h, tolerancePx) {
  const px = (p) => cx + p.x * w;
  const py = (p) => cy + p.y * h;
  const out = [[px(points[0]), py(points[0])]];
  const segments = shapePathSegments(points, closed);
  const tol = Math.max(0.05, tolerancePx);
  for (let i = 0; i < segments; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ah = a.hOut || { x: 0, y: 0 };
    const bh = b.hIn || { x: 0, y: 0 };
    const x0 = px(a); const y0 = py(a);
    const x1 = cx + (a.x + ah.x) * w; const y1 = cy + (a.y + ah.y) * h;
    const x2 = cx + (b.x + bh.x) * w; const y2 = cy + (b.y + bh.y) * h;
    const x3 = px(b); const y3 = py(b);
    // Both handles collapsed onto their anchors = a straight cubic.
    if (Math.abs(x1 - x0) + Math.abs(y1 - y0) + Math.abs(x2 - x3) + Math.abs(y2 - y3) < 0.01) {
      out.push([x3, y3]);
      continue;
    }
    // The control polygon bounds the curve's own length, so it sizes the step
    // without measuring the curve.
    const poly = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
    const n = Math.max(4, Math.min(256, Math.ceil(Math.sqrt((poly * 0.2) / tol))));
    for (let s = 1; s <= n; s += 1) {
      const t = s / n;
      const u = 1 - t;
      const uu = u * u; const tt = t * t;
      out.push([
        uu * u * x0 + 3 * uu * t * x1 + 3 * u * tt * x2 + tt * t * x3,
        uu * u * y0 + 3 * uu * t * y1 + 3 * u * tt * y2 + tt * t * y3,
      ]);
    }
  }
  return out;
}

/**
 * The outline as ONE DISJOINT LINE SEGMENT PER FLATTENED STEP — the path to
 * round-cap STROKE when the stroke is standing in for a Minkowski offset (the
 * layer mask's Expand/Grow). Not a drawable outline: stroke it, never fill it.
 *
 * Stroking the outline itself is the obvious way to offset it and it fails,
 * twice over, because that hands the rasterizer ONE self-intersecting contour:
 *   • On the CUBIC path, the offset curve folds through itself once r outgrows a
 *     segment's radius of curvature. The band then gets SMALLER as r grows and
 *     then disappears — measured on a circle mask 20% of a 1024×576 plate,
 *     coverage peaks near r=300 px (0.47), falls to 0.11 at r=600 and is back to
 *     the bare fill by r=900. That is a mask that VANISHES partway through a Grow.
 *   • Flattening to a closed polyline pushes the failure out but does not remove
 *     it: the inner offset contour still reverses orientation and cancels under
 *     the nonzero rule, which stalls a full-box circle at 0.95 coverage however
 *     much further r runs.
 * One capsule per segment has neither problem: every subpath is convex and
 * consistently wound, and their union IS the boundary dilated by r (the fill
 * supplies the interior), exact at any radius. Measured full coverage at every
 * radius from 50 to 8000 px on curved and straight masks alike, and within 2e-4
 * coverage of the cubic stroke at offsets it still renders correctly.
 *
 * The failure is in the CPU rasterizer only — GPU-rastered canvases stroke the
 * cubic correctly — which is exactly why it cannot be left alone: Chromium moves
 * a canvas to software raster on its own (read-back heuristics, blocklisted GPUs,
 * headless export), so the same project renders differently on two machines.
 */
export function buildOffsetStrokePath(points, closed, cx, cy, w, h, tolerancePx = 0.3) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const flat = flattenOutlinePoints(points, closed, cx, cy, w, h, tolerancePx);
  const path = new Path2D();
  for (let i = 0; i + 1 < flat.length; i += 1) {
    path.moveTo(flat[i][0], flat[i][1]);
    path.lineTo(flat[i + 1][0], flat[i + 1][1]);
  }
  if (closed && flat.length > 1) {
    path.moveTo(flat[flat.length - 1][0], flat[flat.length - 1][1]);
    path.lineTo(flat[0][0], flat[0][1]);
  }
  return path;
}

/**
 * Unit-space bounds of the drawn curve. A bezier is contained by the convex hull
 * of its control polygon, so taking anchors AND control points is a safe (slightly
 * generous) bound — and far cheaper than solving for the real extrema, which only
 * matters here for sizing the texture plate.
 */
export function shapePathBounds(points, closed) {
  if (!Array.isArray(points) || !points.length) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  const add = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  const segments = shapePathSegments(points, closed);
  for (const p of points) add(p.x, p.y);
  for (let i = 0; i < segments; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a.hOut) add(a.x + a.hOut.x, a.y + a.hOut.y);
    if (b.hIn) add(b.x + b.hIn.x, b.y + b.hIn.y);
  }
  return { minX, minY, maxX, maxY };
}

// ── Presets and conversion ──

const corner = (x, y) => ({ x, y, hIn: { x: 0, y: 0 }, hOut: { x: 0, y: 0 }, manual: true });

function ellipsePoints() {
  // Clockwise from the right quadrant (canvas y points down).
  return [
    { x: 0.5, y: 0, hIn: { x: 0, y: -KAPPA }, hOut: { x: 0, y: KAPPA }, manual: true },
    { x: 0, y: 0.5, hIn: { x: KAPPA, y: 0 }, hOut: { x: -KAPPA, y: 0 }, manual: true },
    { x: -0.5, y: 0, hIn: { x: 0, y: KAPPA }, hOut: { x: 0, y: -KAPPA }, manual: true },
    { x: 0, y: -0.5, hIn: { x: -KAPPA, y: 0 }, hOut: { x: KAPPA, y: 0 }, manual: true },
  ];
}

function rectPoints() {
  return [corner(-0.5, -0.5), corner(0.5, -0.5), corner(0.5, 0.5), corner(-0.5, 0.5)];
}

// Rounded rectangle as 8 anchors: two per corner, joined by a quarter-arc bezier.
// The straight edges carry zero handles; only the handles facing into a corner are
// non-zero. `rx`/`ry` are unit-space radii, so a non-square box gets corners that
// follow its aspect — which is what the parametric rectangle already does.
function roundedRect(rx, ry) {
  const x = clamp(rx ?? 0.18, 0.001, 0.5);
  const y = clamp(ry ?? 0.18, 0.001, 0.5);
  const kx = x * 0.5522847498307936;
  const ky = y * 0.5522847498307936;
  const L = -0.5; const R = 0.5; const T = -0.5; const B = 0.5;
  const zero = () => ({ x: 0, y: 0 });
  return [
    { x: L + x, y: T, hIn: { x: -kx, y: 0 }, hOut: zero(), manual: true },
    { x: R - x, y: T, hIn: zero(), hOut: { x: kx, y: 0 }, manual: true },
    { x: R, y: T + y, hIn: { x: 0, y: -ky }, hOut: zero(), manual: true },
    { x: R, y: B - y, hIn: zero(), hOut: { x: 0, y: ky }, manual: true },
    { x: R - x, y: B, hIn: { x: kx, y: 0 }, hOut: zero(), manual: true },
    { x: L + x, y: B, hIn: zero(), hOut: { x: -kx, y: 0 }, manual: true },
    { x: L, y: B - y, hIn: { x: 0, y: ky }, hOut: zero(), manual: true },
    { x: L, y: T + y, hIn: zero(), hOut: { x: 0, y: -ky }, manual: true },
  ];
}

// Regular n-gon inscribed in the unit box, first vertex at the top.
function polygonPoints(sides) {
  const out = [];
  for (let i = 0; i < sides; i += 1) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
    out.push(corner(round4(Math.cos(a) * 0.5), round4(Math.sin(a) * 0.5)));
  }
  return out;
}

function starPoints(tips = 5, inner = 0.42) {
  const out = [];
  for (let i = 0; i < tips * 2; i += 1) {
    const a = -Math.PI / 2 + (i * Math.PI) / tips;
    const r = (i % 2 === 0 ? 0.5 : 0.5 * inner);
    out.push(corner(round4(Math.cos(a) * r), round4(Math.sin(a) * r)));
  }
  return out;
}

// Organic blob: points on a circle with varied radii, left to the auto-tangent
// pass so the result is a smooth closed curve rather than a polygon.
function blobPoints() {
  const radii = [0.5, 0.38, 0.47, 0.34, 0.5, 0.4];
  return radii.map((r, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / radii.length;
    return { x: round4(Math.cos(a) * r), y: round4(Math.sin(a) * r) };
  });
}

// Superellipse-ish: the four quadrant points of a circle with over-long handles,
// which pushes the curve out toward the corners.
function squirclePoints() {
  const k = KAPPA * 1.34;
  return [
    { x: 0.5, y: 0, hIn: { x: 0, y: -k }, hOut: { x: 0, y: k }, manual: true },
    { x: 0, y: 0.5, hIn: { x: k, y: 0 }, hOut: { x: -k, y: 0 }, manual: true },
    { x: -0.5, y: 0, hIn: { x: 0, y: k }, hOut: { x: 0, y: -k }, manual: true },
    { x: 0, y: -0.5, hIn: { x: -k, y: 0 }, hOut: { x: k, y: 0 }, manual: true },
  ];
}

// Closed-shape presets. `build` returns unit points; anything without explicit
// handles is smoothed by the auto-tangent pass in buildShapePathPreset.
export const SHAPE_PATH_PRESETS = [
  { id: 'circle', label: 'Circle', build: () => ellipsePoints() },
  { id: 'rect', label: 'Rectangle', build: () => rectPoints() },
  { id: 'roundedRect', label: 'Rounded', build: () => roundedRect() },
  { id: 'triangle', label: 'Triangle', build: () => polygonPoints(3) },
  { id: 'diamond', label: 'Diamond', build: () => polygonPoints(4) },
  { id: 'pentagon', label: 'Pentagon', build: () => polygonPoints(5) },
  { id: 'hexagon', label: 'Hexagon', build: () => polygonPoints(6) },
  { id: 'star', label: 'Star', build: () => starPoints(5) },
  { id: 'burst', label: 'Burst', build: () => starPoints(8, 0.62) },
  { id: 'blob', label: 'Blob', build: () => blobPoints() },
  { id: 'squircle', label: 'Squircle', build: () => squirclePoints() },
];

// Open-line presets, for the Line shape and for an un-closed path.
export const LINE_PATH_PRESETS = [
  { id: 'straight', label: 'Straight', build: () => [corner(-0.5, 0), corner(0.5, 0)] },
  {
    id: 'arc',
    label: 'Arc',
    build: () => [{ x: -0.5, y: 0.28 }, { x: 0, y: -0.34 }, { x: 0.5, y: 0.28 }],
  },
  {
    id: 'scurve',
    label: 'S-curve',
    build: () => [{ x: -0.5, y: 0.32 }, { x: 0, y: 0 }, { x: 0.5, y: -0.32 }],
  },
  {
    id: 'wave',
    label: 'Wave',
    build: () => [
      { x: -0.5, y: 0 }, { x: -0.25, y: -0.3 }, { x: 0, y: 0 }, { x: 0.25, y: 0.3 }, { x: 0.5, y: 0 },
    ],
  },
  {
    id: 'zigzag',
    label: 'Zigzag',
    build: () => [
      corner(-0.5, 0.25), corner(-0.25, -0.25), corner(0, 0.25), corner(0.25, -0.25), corner(0.5, 0.25),
    ],
  },
  {
    id: 'corner',
    label: 'Corner',
    build: () => [corner(-0.5, -0.32), corner(0.12, -0.32), corner(0.12, 0.32)],
  },
];

const ALL_PRESETS = [...SHAPE_PATH_PRESETS, ...LINE_PATH_PRESETS];
const LINE_PRESET_IDS = new Set(LINE_PATH_PRESETS.map((p) => p.id));

/**
 * A preset as a ready-to-store path. `pointCount` matches it to an existing
 * keyframed path so the animation survives — the whole point of applying a preset
 * mid-edit is to key rectangle → circle in two clicks.
 */
export function buildShapePathPreset(id, { pointCount = 0 } = {}) {
  const preset = ALL_PRESETS.find((p) => p.id === id) || SHAPE_PATH_PRESETS[1];
  const closed = !LINE_PRESET_IDS.has(preset.id);
  let points = refreshShapePathHandles(preset.build(), closed);
  // Only resample when the counts actually differ: an equal-count resample is
  // exact, but skipping it keeps the preset's own anchors (a rectangle's corners
  // rather than four points spaced evenly around its perimeter).
  if (pointCount >= 2 && points.length !== pointCount) {
    points = resampleShapePath(points, closed, pointCount);
  }
  return { points, closed };
}

/**
 * The shape's own box in composition pixels — what the ±0.5 unit box measures.
 *
 * Lives here rather than in the Player because it is the other half of the unit-box
 * contract: anything converting points into (or out of) real pixels needs exactly
 * this box, and two copies of it would drift.
 */
export function shapeBoxSize(item, compositionWidth, compositionHeight) {
  const type = item?.shapeType || 'rectangle';
  const usePx = item?.shapeSizeUnit === 'px';
  const wPct = (compositionWidth * Math.max(1, Number(item?.shapeWidthPct) || 40)) / 100;
  const hPct = (compositionHeight * Math.max(1, Number(item?.shapeHeightPct) || 40)) / 100;
  let w = usePx && Number.isFinite(Number(item?.shapeWidthPx)) ? Math.max(1, Number(item.shapeWidthPx)) : wPct;
  let h = usePx && Number.isFinite(Number(item?.shapeHeightPx)) ? Math.max(1, Number(item.shapeHeightPx)) : hPct;
  if (type === 'circle') {
    // Circles size from a single radius: % of the shorter composition side, or px.
    const rPct = (Math.min(compositionWidth, compositionHeight) * Math.max(1, Number(item?.shapeRadiusPct) || 20)) / 100;
    const r = usePx && Number.isFinite(Number(item?.shapeRadiusPx))
      ? Math.max(1, Number(item.shapeRadiusPx))
      : rPct;
    w = h = r * 2;
  }
  return { width: w, height: h };
}

// ── Corner radius (rectangles) ──
// `borderRadius` — or, with `borderRadiusLinked: false`, the four per-corner fields —
// in composition px, or with `borderRadiusUnit: 'pct'` in % of the shape's SHORTER
// side (50 = a full pill at any aspect). It is resolved against the box actually
// being drawn, so changing Width / Height never stretches a corner the way scaling
// the layer does. Corners clamp to half the shorter side, where they meet.
export const SHAPE_CORNER_KF_KEYS = ['borderRadius', 'borderRadiusTL', 'borderRadiusTR', 'borderRadiusBR', 'borderRadiusBL'];
export function shapeCornerRadii(item, width, height) {
  const side = Math.max(0, Math.min(num(width), num(height)));
  const base = Math.max(0, num(item?.borderRadius));
  const raw = item?.borderRadiusLinked === false
    ? [item.borderRadiusTL, item.borderRadiusTR, item.borderRadiusBR, item.borderRadiusBL]
      .map((v) => Math.max(0, num(v, base)))
    : [base, base, base, base];
  const k = item?.borderRadiusUnit === 'pct' ? side / 100 : 1;
  return raw.map((r) => Math.min(r * k, side / 2));
}

// ── Keyframed size ──
// Width / Height (or a circle's Radius) are keyframable in whichever unit the shape
// is sized in. Tracks are named after the field they override, so a track for the
// unit NOT in use is simply inert (switching units converts the tracks too). A
// rectangle's corner radius rides the same registry: one track per radius field,
// valued in the item's `borderRadiusUnit`.
export const SHAPE_SIZE_KF_KEYS = ['shapeWidthPx', 'shapeHeightPx', 'shapeWidthPct', 'shapeHeightPct', 'shapeRadiusPx', 'shapeRadiusPct', ...SHAPE_CORNER_KF_KEYS];
const SIZE_KF_META = {
  shapeWidthPx: { displayLabel: 'Shape width', unit: 'px', max: 20000 },
  shapeHeightPx: { displayLabel: 'Shape height', unit: 'px', max: 20000 },
  shapeWidthPct: { displayLabel: 'Shape width', unit: '%', max: 2000 },
  shapeHeightPct: { displayLabel: 'Shape height', unit: '%', max: 2000 },
  shapeRadiusPx: { displayLabel: 'Shape radius', unit: 'px', max: 10000 },
  shapeRadiusPct: { displayLabel: 'Shape radius', unit: '%', max: 1000 },
  borderRadius: { displayLabel: 'Border radius', unit: 'px', placeholder: '0', min: 0, max: 9999 },
  borderRadiusTL: { displayLabel: 'Radius top left', unit: 'px', placeholder: '0', min: 0, max: 9999 },
  borderRadiusTR: { displayLabel: 'Radius top right', unit: 'px', placeholder: '0', min: 0, max: 9999 },
  borderRadiusBR: { displayLabel: 'Radius bottom right', unit: 'px', placeholder: '0', min: 0, max: 9999 },
  borderRadiusBL: { displayLabel: 'Radius bottom left', unit: 'px', placeholder: '0', min: 0, max: 9999 },
};
export const SHAPE_SIZE_KF_PROPS = SHAPE_SIZE_KF_KEYS.map((label) => ({
  label,
  group: SHAPE_PATH_KF_GROUP,
  placeholder: '100',
  type: 'number',
  min: 1,
  step: 1,
  ...SIZE_KF_META[label],
}));
export function shapeSizeKfMeta(label) {
  return SHAPE_SIZE_KF_PROPS.find((p) => p.label === label) || null;
}
/**
 * The size tracks worth offering: the current unit's pair (a circle: its radius),
 * a rectangle's corner radius (one track, or four when the corners are unlinked),
 * plus any already keyed.
 */
export function buildShapeSizeKfProps(item) {
  const px = item?.shapeSizeUnit === 'px';
  const want = item?.shapeType === 'circle'
    ? [px ? 'shapeRadiusPx' : 'shapeRadiusPct']
    : (px ? ['shapeWidthPx', 'shapeHeightPx'] : ['shapeWidthPct', 'shapeHeightPct']);
  if ((item?.shapeType || 'rectangle') === 'rectangle') {
    if (item?.borderRadiusLinked === false) want.push(...SHAPE_CORNER_KF_KEYS.slice(1));
    else want.push('borderRadius');
  }
  const keyed = item?.propertyKeyframes || {};
  const radiusUnit = item?.borderRadiusUnit === 'pct' ? '%' : 'px';
  return SHAPE_SIZE_KF_PROPS
    .filter((p) => want.includes(p.label) || keyed[p.label]?.length)
    .map((p) => (SHAPE_CORNER_KF_KEYS.includes(p.label) && p.unit !== radiusUnit ? { ...p, unit: radiusUnit } : p));
}
/** `item` with this frame's keyframed size laid over it (the same object when nothing is keyed). */
export function withShapeSizeKeyframes(item, kfValues) {
  if (!item || !kfValues) return item;
  let out = null;
  for (const key of SHAPE_SIZE_KF_KEYS) {
    const v = kfValues[key];
    if (Number.isFinite(v)) {
      if (!out) out = { ...item };
      out[key] = Math.max(SIZE_KF_META[key].min ?? 1, v);
    }
  }
  return out || item;
}

/**
 * Convert a parametric shape's outline into unit points, so switching a placed
 * rectangle/ellipse/triangle/arrow to Path does not move a single pixel.
 *
 * `width`/`height`/`radii` (the shape's current px box and its per-corner radii)
 * are only needed to express rounded rectangles, which are authored in px; without
 * them a rounded rectangle converts to a plain one. Custom SVG silhouettes have no
 * outline we can read back — the caller falls back to a preset.
 */
export function unitOutlineFromShape(item, { width = 0, height = 0, radii = null } = {}) {
  const type = item?.shapeType || 'rectangle';
  if (type === 'ellipse' || type === 'circle') return ellipsePoints();
  if (type === 'triangle') {
    const dir = item.shapeTriDirection || 'up';
    const apexPct = Number.isFinite(Number(item.shapeTriApexPct)) ? Number(item.shapeTriApexPct) : 50;
    const apex = clamp(apexPct, 0, 100) / 100;
    if (dir === 'down') return [corner(-0.5 + apex, 0.5), corner(-0.5, -0.5), corner(0.5, -0.5)];
    if (dir === 'left') return [corner(-0.5, -0.5 + apex), corner(0.5, -0.5), corner(0.5, 0.5)];
    if (dir === 'right') return [corner(0.5, -0.5 + apex), corner(-0.5, 0.5), corner(-0.5, -0.5)];
    return [corner(-0.5 + apex, -0.5), corner(0.5, 0.5), corner(-0.5, 0.5)];
  }
  if (type === 'arrow') {
    const headPct = clamp(num(item.shapeArrowHeadPct, 45) || 45, 5, 90);
    const shaftPct = clamp(num(item.shapeArrowShaftPct, 42) || 42, 2, 100);
    const head = headPct / 100;
    const shaft = shaftPct / 200; // half-thickness in unit space
    const notch = 0.5 - head;
    return [
      corner(-0.5, -shaft), corner(notch, -shaft), corner(notch, -0.5),
      corner(0.5, 0), corner(notch, 0.5), corner(notch, shaft), corner(-0.5, shaft),
    ];
  }
  if (type === 'custom' || type === 'vector' || type === 'path') return null;
  // Rectangle — honour the corner radii when we know the box size. Per-corner
  // radii collapse to their largest: eight anchors can express one radius, and a
  // path with independent corners is exactly what the user is about to hand-edit.
  const w = width > 0 ? width : 0;
  const h = height > 0 ? height : 0;
  const largest = Array.isArray(radii) && w && h
    ? radii.reduce((acc, r) => Math.max(acc, num(r)), 0)
    : 0;
  if (largest > 0) {
    const r = Math.min(largest, Math.min(w, h) / 2);
    return roundedRect(r / w, r / h);
  }
  return rectPoints();
}

/**
 * A motion path (objectMotionPath.js: world pixels, +y UP, origin at the
 * composition centre) as a shape outline (unit box, +y DOWN). Returns the unit
 * points plus the world box they were measured against, so the caller can size
 * the shape layer to that box and pan it onto the box centre — which lands the
 * outline exactly where the motion path runs. The box carries a `cz` too: a flat
 * shape has a single depth, so the caller needs the depth the path itself sits at
 * to place the outline against the layer that travels it.
 *
 * Both models evaluate the same cubic with handles stored as offsets, so copying
 * the handles verbatim reproduces the curve; every anchor is marked `manual` to
 * keep the auto-tangent pass from reshaping it.
 *
 * A closed path comes back OPEN with its first anchor repeated at the end: a Line
 * is open by definition, and the repeat draws exactly the closing segment (same
 * last.hOut → first.hIn) instead of losing it.
 */
export function shapeOutlineFromMotionPath(path) {
  const src = Array.isArray(path?.points) ? path.points : [];
  if (src.length < 2) return null;
  const wrapped = path?.closed === true;
  const pts = wrapped ? [...src, src[0]] : src;
  const last = pts.length - 1;
  // The curve is contained by the convex hull of its control polygon, so bounding
  // anchors plus the handles that are actually drawn covers it.
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  // Depth is measured over ANCHORS only: it is not part of the flattened outline,
  // just the plane the path lives on, and a handle that leans in Z would drag that
  // plane off the anchors the user placed.
  let minZ = Infinity; let maxZ = -Infinity;
  const add = (x, y) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  pts.forEach((p, i) => {
    add(num(p.x), num(p.y));
    const pz = num(p.z);
    if (pz < minZ) minZ = pz;
    if (pz > maxZ) maxZ = pz;
    if (p.hIn && i > 0) add(num(p.x) + num(p.hIn.x), num(p.y) + num(p.hIn.y));
    if (p.hOut && i < last) add(num(p.x) + num(p.hOut.x), num(p.y) + num(p.hOut.y));
  });
  // A dead-straight path has zero extent on one axis; the box still needs a real
  // size to divide by, and every unit coordinate on that axis is 0 anyway.
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const points = pts.map((p, i) => {
    const point = { x: round4((num(p.x) - cx) / w), y: round4(-(num(p.y) - cy) / h), manual: true };
    if (p.hIn && i > 0) point.hIn = { x: round4(num(p.hIn.x) / w), y: round4(-num(p.hIn.y) / h) };
    if (p.hOut && i < last) point.hOut = { x: round4(num(p.hOut.x) / w), y: round4(-num(p.hOut.y) / h) };
    return point;
  });
  const cz = Number.isFinite(minZ) ? (minZ + maxZ) / 2 : 0;
  return { points, closed: false, box: { w, h, cx, cy, cz } };
}

// ── Stroked shapes (Line, and any un-closed path) ──

export const LINE_CAPS = ['butt', 'round', 'square'];
export const LINE_JOINS = ['round', 'miter', 'bevel'];
// `custom` reads its pattern from `lineDashPattern` and always draws through the
// Path Stroke engine (pathStroke.js).
export const LINE_DASHES = ['solid', 'dashed', 'dotted', 'custom'];

export const LINE_DEFAULTS = {
  lineWidth: 8,
  lineCap: 'round',
  lineJoin: 'round',
  lineDash: 'solid',
  lineTrimStart: 0,
  lineTrimEnd: 100,
  lineTrimOffset: 0,
};

/** Does this shape render as a stroke rather than a fill? */
export function isStrokeShape(item) {
  if (!item) return false;
  if (item.shapeType === 'line') return true;
  return item.shapeType === 'path'
    && (item.shapePath?.closed === false || item.shapePathRenderMode === 'stroke');
}

/**
 * Stroke + trim settings for one frame: the item's own fields with any keyframed
 * track laid over them. Resolved once per frame so the outline builder and the
 * drawer can't disagree, and so the texture plate is sized for the width actually
 * about to be painted (a keyframed stroke that grows would otherwise get clipped).
 */
export function resolveLineSettings(item, kfValues = null) {
  const pick = (key, fallback, lo, hi) => {
    const kf = kfValues?.[key];
    const v = Number.isFinite(kf) ? kf : num(item?.[key], fallback);
    return clamp(v, lo, hi);
  };
  return {
    width: pick('lineWidth', LINE_DEFAULTS.lineWidth, 0, 400),
    cap: LINE_CAPS.includes(item?.lineCap) ? item.lineCap : LINE_DEFAULTS.lineCap,
    join: LINE_JOINS.includes(item?.lineJoin) ? item.lineJoin : LINE_DEFAULTS.lineJoin,
    dash: LINE_DASHES.includes(item?.lineDash) ? item.lineDash : LINE_DEFAULTS.lineDash,
    trimStart: pick('lineTrimStart', 0, 0, 100),
    trimEnd: pick('lineTrimEnd', 100, 0, 100),
    trimOffset: pick('lineTrimOffset', 0, -100, 100),
    // Path Stroke options (outline style, custom dashes, per-segment trim, ghost
    // track, and the cards: taper, profile, warp, arrowheads…) — see pathStroke.js.
    ...resolveLineStroke(item, kfValues),
  };
}

/**
 * How far the drawn stroke reaches past the outline, in px — what the texture
 * plate must be padded by. The plain stroke is strokeOutset(); a stroke that runs
 * through the Path Stroke engine can also grow wider (pressure, rough edges), be
 * displaced (warp), fan out (copies) or carry arrowheads and stamps.
 */
export function strokeReach(line, points, closed, w, h) {
  if (!strokeEngineActive(line)) return strokeOutset(line, points, closed, w, h);
  const bounds = Array.isArray(points) && points.length >= 2 ? shapePathBounds(points, closed) : null;
  return strokeEngineReach(
    line,
    (width) => strokeOutset({ ...line, width }, points, closed, w, h),
    { w, h },
    bounds
  );
}

/** Is any trim actually cutting the path (so the drawer must sample it)? */
export function isTrimActive(line) {
  if (!line) return false;
  return line.trimStart > 0.01 || line.trimEnd < 99.99 || Math.abs(line.trimOffset) > 0.01;
}

// Canvas' default: past this ratio a miter join is drawn as a bevel instead.
const MITER_LIMIT = 10;
// A hair either side of an anchor, in GLOBAL path parameter. Sampling the join
// itself is no good: at a hard corner both handles are zero, so the bezier's
// derivative vanishes exactly there and the tangent is undefined.
const JOIN_EPS = 1e-3;

function tangentPx(points, closed, u, w, h) {
  const hit = evaluateShapePath(points, closed, u);
  if (!hit) return null;
  const x = hit.tangent.x * w;
  const y = hit.tangent.y * h;
  const len = Math.hypot(x, y);
  return len > 1e-9 ? { x: x / len, y: y / len } : null;
}

/**
 * How far a stroke reaches OUTSIDE the curve it is drawn on, in pixels.
 *
 * Half the width covers a butt or round cap and a round or bevel join, but not
 * the two shapes that stick out further. A SQUARE cap adds another half-width
 * along the tangent, so its far corner sits at √2·(width/2) from the end point.
 * A MITER join spikes to (width/2)/cos(φ/2) at a corner turning by φ, until
 * canvas gives up and bevels it at `MITER_LIMIT`.
 *
 * Sizes the texture plate: under-pad it and the cap corner or the miter spike is
 * clipped off at the plate edge — which is what a wide square-capped line did.
 *
 * `w`/`h` are the shape's box in pixels, because a non-square box skews the turn
 * — the join has to be measured in the space it is actually drawn in.
 */
export function strokeOutset(line, points, closed, w, h) {
  const width = Math.max(0, num(line?.width, 0));
  if (!width) return 0;
  // Caps are not confined to the two ends of an open path: a dashed or dotted
  // stroke caps every dash, and a trim caps wherever it cut.
  const capped = !closed || (line?.dash && line.dash !== 'solid') || isTrimActive(line);
  // `reach` counts half-widths.
  let reach = capped && line?.cap === 'square' ? Math.SQRT2 : 1;
  if (line?.join === 'miter' && Array.isArray(points) && points.length >= 3) {
    const segments = shapePathSegments(points, closed);
    const first = closed ? 0 : 1;
    const last = closed ? points.length - 1 : points.length - 2;
    for (let i = first; i <= last && reach < MITER_LIMIT; i += 1) {
      const u = i / segments;
      const a = tangentPx(points, closed, u - JOIN_EPS, w, h);
      const b = tangentPx(points, closed, u + JOIN_EPS, w, h);
      if (!a || !b) continue;
      // cos φ between the two legs; cos(φ/2) = √((1 + cos φ)/2).
      const cos = clamp(a.x * b.x + a.y * b.y, -1, 1);
      reach = Math.max(reach, Math.min(Math.sqrt(2 / Math.max(1e-6, 1 + cos)), MITER_LIMIT));
    }
  }
  return (width / 2) * reach;
}

/**
 * After Effects-style Trim Paths: keep only the arc-length range
 * [start+offset, end+offset] of the outline.
 *
 * Trimming is done on a dense polyline in CANVAS space, so the visible length is
 * what gets divided — trimming by curve parameter would run visibly fast through
 * tight corners and slow along straight runs. The exact bezier Path2D is still used
 * whenever no trim is active, so nothing pays for this until it's switched on.
 */
export function buildTrimmedOutline(points, closed, cx, cy, w, h, trim = {}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const start = num(trim.start, 0) / 100;
  const end = num(trim.end, 100) / 100;
  const offset = num(trim.offset, 0) / 100;
  let a = start + offset;
  let b = end + offset;
  if (b - a <= 1e-6) return null;                     // nothing left to draw

  const STEPS = Math.max(240, shapePathSegments(points, closed) * 90);
  const pts = [];
  const cum = [0];
  for (let i = 0; i <= STEPS; i += 1) {
    const hit = evaluateShapePath(points, closed, i / STEPS);
    const p = { x: cx + hit.position.x * w, y: cy + hit.position.y * h };
    pts.push(p);
    if (i > 0) cum.push(cum[i - 1] + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y));
  }
  const total = cum[cum.length - 1];
  if (total <= 1e-6) return null;

  if (closed) {
    if (b - a >= 1) { a = 0; b = 1; }
    else { const shift = Math.floor(a); a -= shift; b -= shift; }
  } else {
    a = clamp(a, 0, 1);
    b = clamp(b, 0, 1);
    if (b - a <= 1e-6) return null;
  }

  // Point on the polyline at arc-length fraction f, plus the sample index after it.
  const at = (f) => {
    const target = clamp(f, 0, 1) * total;
    for (let i = 1; i < cum.length; i += 1) {
      if (cum[i] >= target) {
        const span = cum[i] - cum[i - 1] || 1;
        const t = (target - cum[i - 1]) / span;
        return {
          index: i,
          p: { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t },
        };
      }
    }
    return { index: pts.length - 1, p: pts[pts.length - 1] };
  };

  const path = new Path2D();
  const stroke = (from, to) => {
    if (to - from <= 1e-6) return;
    const s = at(from);
    const e = at(to);
    path.moveTo(s.p.x, s.p.y);
    for (let i = s.index; i < e.index; i += 1) path.lineTo(pts[i].x, pts[i].y);
    path.lineTo(e.p.x, e.p.y);
  };
  stroke(a, Math.min(b, 1));
  // A closed path's range can run past the seam; the remainder wraps to the start.
  if (b > 1) stroke(0, b - 1);
  return path;
}

const STROKE_KF_DISPLAY = {
  lineOutlineWidth: 'Outline width',
  lineDashOffset: 'Dash offset',
  lineDashSpeed: 'Dash march',
  lineGhost: 'Ghost track',
  lineTaperStartLength: 'Taper start length',
  lineTaperEndLength: 'Taper end length',
  lineTaperStartWidth: 'Taper start width',
  lineTaperEndWidth: 'Taper end width',
  lineProfileOffset: 'Profile offset',
  lineWidthWaveAmount: 'Width wave amount',
  lineWidthWavePhase: 'Width wave phase',
  lineWarpOffset: 'Warp offset',
  lineZigzagSize: 'Zig zag size',
  lineWiggleSize: 'Wiggle size',
  lineWarpWaveAmplitude: 'Warp wave amplitude',
  lineCopySpacing: 'Copy spacing',
  lineEndsSize: 'Arrowhead size',
  lineStampOffset: 'Stamp offset',
  lineGradientOffset: 'Gradient offset',
  lineFadeIn: 'Fade in',
  lineFadeOut: 'Fade out',
};

// Line/trim options exposed as keyframe tracks (KF_PROPS-shaped, like
// buildMotionKfProps). Offered only on shapes that actually stroke.
export const LINE_KF_PROPS = [
  { label: 'lineWidth', displayLabel: 'Stroke width', group: SHAPE_PATH_KF_GROUP, placeholder: '8', unit: 'px', type: 'number', min: 0, max: 400, step: 1 },
  { label: 'lineTrimStart', displayLabel: 'Trim start', group: SHAPE_PATH_KF_GROUP, placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 0.5 },
  { label: 'lineTrimEnd', displayLabel: 'Trim end', group: SHAPE_PATH_KF_GROUP, placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 0.5 },
  { label: 'lineTrimOffset', displayLabel: 'Trim offset', group: SHAPE_PATH_KF_GROUP, placeholder: '0', unit: '%', type: 'number', min: -100, max: 100, step: 0.5 },
  // Path Stroke tracks, declared once in pathStroke.js' schema. `card` names the
  // lineStroke card whose value the track overrides (null = a flat line* field).
  ...STROKE_KF_TRACKS.map((t) => (t.color
    ? {
      label: t.label,
      displayLabel: STROKE_KF_DISPLAY[t.label] || t.displayLabel,
      group: SHAPE_PATH_KF_GROUP,
      placeholder: Array.isArray(t.spec.default) ? (t.spec.default[t.index] || t.spec.default[0]) : (t.spec.default || '#ffffff'),
      unit: '',
      inputType: 'color',
      card: t.card,
      field: t.field,
      index: t.index,
    }
    : {
      label: t.label,
      displayLabel: STROKE_KF_DISPLAY[t.label] || t.displayLabel || t.label,
      group: SHAPE_PATH_KF_GROUP,
      placeholder: String(t.spec.default),
      unit: t.spec.unit === '×' ? 'x' : (t.spec.unit || ''),
      type: 'number',
      min: t.spec.min,
      max: t.spec.max,
      step: t.spec.step,
      card: t.card,
      field: t.field,
      index: t.index,
    })),
];

// Track keys the project loader must keep for a shape layer (see the whitelist in
// VideoEditor.jsx's sanitizePropertyKeyframes — anything not listed is dropped).
export const LINE_KF_KEYS = LINE_KF_PROPS.map((p) => p.label);

export function lineKfMeta(label) {
  return LINE_KF_PROPS.find((p) => p.label === label) || null;
}

/**
 * The line tracks worth offering for this item: the four classic ones always, a
 * Path Stroke track only while its option is in use (its card is on the layer, the
 * dash or outline style it animates is picked) — or when it already has keys.
 */
export function lineKfPropsFor(item) {
  const cards = item?.lineStroke || {};
  const keyed = item?.propertyKeyframes || {};
  return LINE_KF_PROPS.filter((p) => {
    if (keyed[p.label]?.length) return true;
    const track = strokeKfTrack(p.label);
    if (!track) return true;
    if (track.card) {
      // a stamp colour track only once the stamps have a colour of their own
      if (track.color && track.index === undefined && !cards[track.card]?.[track.field]) return false;
      if (track.index === 2 && (cards[track.card]?.[track.field] || []).length < 3) return false;
      return !!cards[track.card];
    }
    if (p.label === 'lineDashOffset' || p.label === 'lineDashSpeed') return !!item?.lineDash && item.lineDash !== 'solid';
    if (track.field === 'lineDashPattern') return item?.lineDash === 'custom';
    if (p.label === 'lineOutlineWidth') return item?.lineStyle === 'outline';
    return true;
  });
}

/** A line track's static value — flat `line*` fields or a lineStroke card field. */
export function lineStaticValue(item, label, fallback) {
  const meta = lineKfMeta(label);
  if (!meta) return fallback;
  const src = meta.card ? item?.lineStroke?.[meta.card]?.[meta.field] : item?.[meta.field || label];
  const v = Number.isInteger(meta.index) ? (Array.isArray(src) ? src[meta.index] : undefined) : src;
  if (meta.inputType === 'color') return typeof v === 'string' && v ? v : fallback;
  return Number.isFinite(v) ? v : fallback;
}

// ── Structural edits ──

export function deleteShapePathPoint(points, index) {
  if (!Array.isArray(points) || index < 0 || index >= points.length) return points;
  return points.filter((_, i) => i !== index);
}

/** Drop a point's hand-shaped handles so the auto-tangent pass owns it again. */
export function resetShapePathHandles(points, index) {
  return points.map((p, i) => {
    if (i !== index) return p;
    const { manual, hIn, hOut, ...rest } = p; // eslint-disable-line no-unused-vars
    return rest;
  });
}

/** Flip a point between a hard corner (zero handles) and an auto-smoothed one. */
export function toggleShapePathCorner(points, index) {
  const p = points[index];
  if (!p) return points;
  const isCorner = p.manual
    && Math.hypot(p.hIn?.x || 0, p.hIn?.y || 0) < 1e-6
    && Math.hypot(p.hOut?.x || 0, p.hOut?.y || 0) < 1e-6;
  if (isCorner) return resetShapePathHandles(points, index);
  return points.map((q, i) => (
    i === index ? { ...q, manual: true, hIn: { x: 0, y: 0 }, hOut: { x: 0, y: 0 } } : q
  ));
}

/**
 * Split the curve at `u` and insert an anchor there. Uses de Casteljau, so the
 * outline is bit-for-bit unchanged by the insert — a click on the path adds a
 * handle rather than reshaping it.
 */
export function insertShapePathPoint(points, closed, u) {
  const hit = shapePathSegmentAt(points, closed, u);
  if (!hit) return points;
  const i = hit.index;
  const j = (i + 1) % points.length;
  const t = hit.t;
  const a = points[i];
  const b = points[j];
  const P0 = { x: a.x, y: a.y };
  const P1 = { x: a.x + (a.hOut?.x || 0), y: a.y + (a.hOut?.y || 0) };
  const P2 = { x: b.x + (b.hIn?.x || 0), y: b.y + (b.hIn?.y || 0) };
  const P3 = { x: b.x, y: b.y };
  const mix = (p, q) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const Q0 = mix(P0, P1); const Q1 = mix(P1, P2); const Q2 = mix(P2, P3);
  const R0 = mix(Q0, Q1); const R1 = mix(Q1, Q2);
  const S = mix(R0, R1);
  const off = (p, o) => ({ x: round4(p.x - o.x), y: round4(p.y - o.y) });
  const next = points.map((p) => ({ ...p }));
  next[i] = { ...a, manual: true, hIn: a.hIn || { x: 0, y: 0 }, hOut: off(Q0, P0) };
  next[j] = { ...b, manual: true, hIn: off(Q2, P3), hOut: b.hOut || { x: 0, y: 0 } };
  const inserted = {
    x: round4(S.x), y: round4(S.y),
    hIn: off(R0, S), hOut: off(R1, S), manual: true,
  };
  next.splice(i + 1, 0, inserted);
  return next;
}

/**
 * Move one tangent handle. Illustrator rules: shaping a handle marks the anchor
 * `manual`, and the opposite handle mirrors it (keeping its own length) unless the
 * caller asks to break the pair. Ported from the camera path's tangent drag.
 */
export function setShapePathHandle(points, index, key, offset, { mirror = true } = {}) {
  const p = points[index];
  if (!p) return points;
  const off = { x: round4(offset.x), y: round4(offset.y) };
  const next = points.map((q, i) => (i === index ? { ...q, manual: true, [key]: off } : q));
  if (!mirror) return next;
  const other = key === 'hIn' ? 'hOut' : 'hIn';
  const cur = p[other] || { x: 0, y: 0 };
  const curLen = Math.hypot(cur.x, cur.y);
  const offLen = Math.hypot(off.x, off.y) || 1e-6;
  const k = (curLen || offLen) / offLen;
  next[index] = { ...next[index], [other]: { x: round4(-off.x * k), y: round4(-off.y * k) } };
  return next;
}

// ── Keyframe morphing ──

/**
 * Point-wise blend of two path snapshots, positions and handles alike.
 *
 * Structural edits are mirrored across every key so the lists always match; the
 * clamp to the shorter list is a guard against a hand-edited project, not a
 * supported authoring mode.
 */
export function interpolateShapePaths(a, b, t) {
  if (!Array.isArray(a) || !a.length) return Array.isArray(b) ? b : [];
  if (!Array.isArray(b) || !b.length) return a;
  // A non-finite t would lerp every coordinate to NaN, and NaN geometry poisons
  // both the Path2D and the SVG gizmo — hold the earlier key instead.
  if (!Number.isFinite(t) || t <= 0) return a;
  if (t >= 1) return b;
  const n = Math.min(a.length, b.length);
  const lerp = (p, q) => p + (q - p) * t;
  const lerpVec = (p, q) => ({
    x: lerp(p?.x || 0, q?.x || 0),
    y: lerp(p?.y || 0, q?.y || 0),
  });
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = {
      x: lerp(a[i].x, b[i].x),
      y: lerp(a[i].y, b[i].y),
      hIn: lerpVec(a[i].hIn, b[i].hIn),
      hOut: lerpVec(a[i].hOut, b[i].hOut),
      // The blended handles are explicit geometry — never let an auto-tangent
      // pass downstream decide it knows better.
      manual: true,
    };
  }
  return out;
}

// Keyframe key values are strings everywhere in the editor, so a path snapshot
// travels as compact JSON — the POINTS only. `closed` is a property of the shape,
// not of a moment in time (toggling it is a structural edit), so it stays on
// item.shapePath and is never duplicated into a key.
//
// Handles are always written out (the auto-tangent pass has already materialised
// them) so a key is self-contained.
export function encodeShapePathValue(points) {
  return JSON.stringify((points || []).map((p) => ({
    x: round4(p.x), y: round4(p.y),
    hIn: { x: round4(p.hIn?.x || 0), y: round4(p.hIn?.y || 0) },
    hOut: { x: round4(p.hOut?.x || 0), y: round4(p.hOut?.y || 0) },
    manual: true,
  })));
}

export function decodeShapePathValue(value) {
  if (Array.isArray(value)) return sanitizeShapePathPoints(value);
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const points = sanitizeShapePathPoints(JSON.parse(value));
    return points.length ? points : null;
  } catch {
    return null;
  }
}

/**
 * Re-serialize a key value through the sanitizer — the project loader passes this
 * to cleanTrack in place of clampKeyValue, which would `parseFloat` the JSON and
 * collapse every key to the track minimum. Returns '' for an unusable value so the
 * caller drops the key.
 */
export function coerceShapePathValue(value) {
  const points = decodeShapePathValue(value);
  return points ? encodeShapePathValue(points) : '';
}

/**
 * THE key-position rounding authority — 4dp. 2dp is not enough: at 60fps
 * adjacent frames sit 0.028% apart on a 60s clip, so they collapse to one
 * position and cleanTrack's exact-position dedupe then deletes them on the
 * next load. Every writer of a keyframe `position` must round through this.
 */
export const roundKeyPosition = (pct) => Math.round(pct * 1e4) / 1e4;

/**
 * Write a point list into a path track at `pct` — updating the key already there,
 * or inserting one. Shared by the canvas editor and the panel so "move a point" and
 * "apply a preset" land in the same place, with the same easing rule.
 */
export function writeShapePathKey(track, pct, tolerancePct, points, easing) {
  const value = encodeShapePathValue(points);
  const list = Array.isArray(track) ? track : [];
  const idx = list.findIndex(
    (k) => Math.abs(num(k?.position, -1) - pct) <= Math.max(0.001, tolerancePct || 0)
  );
  if (idx >= 0) return list.map((k, i) => (i === idx ? { ...k, value } : k));
  return [...list, {
    position: roundKeyPosition(pct),
    value,
    easing,
  }].sort((a, b) => a.position - b.position);
}

// KF_PROPS-shaped entries so the Keyframe Builder's row list, "Add Property"
// dropdown and timeline pill pick these up like any other property. Mirrors
// buildMotionKfProps in motionKf.js. `kind: 'path'` marks the outline track
// non-scalar so the value editor shows a point count instead of a number input.
export function buildShapePathKfProps(item) {
  const type = item?.shapeType;
  if (type !== 'path' && type !== 'line') return [];
  const out = [];
  if (type === 'path' || type === 'line') {
    out.push({
      label: SHAPE_PATH_KF_KEY,
      displayLabel: type === 'line' ? 'Line path' : 'Shape path',
      group: SHAPE_PATH_KF_GROUP,
      kind: 'path',
      placeholder: '',
      unit: '',
    });
  }
  if (isStrokeShape(item)) out.push(...lineKfPropsFor(item));
  return out;
}

export function isShapePathTrackKey(prop) {
  return prop === SHAPE_PATH_KF_KEY;
}

/**
 * Track keys whose VALUE is a point list rather than a number or a colour: the
 * shape layer's own outline, plus every layer-mask outline.
 *
 * ONE predicate, so a new non-scalar track can never be half-wired — every site
 * that samples, seeds, sanitizes or labels a track branches on this, not on
 * `=== SHAPE_PATH_KF_KEY`.
 */
export function isPathTrackKey(prop) {
  return prop === SHAPE_PATH_KF_KEY || isMaskPathTrackKey(prop);
}
