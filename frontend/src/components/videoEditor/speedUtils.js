import { TransitionType } from './types.js';
import { movesPreviousClip } from './crossTransitionOrder.js';

/*
 * SPEED CURVES
 *
 * `speedPoints` is a list of `{ x, y }` anchors: x is progress along the clip's own
 * TIMELINE (0-1), y is the playback rate there. Source time is the INTEGRAL of y
 * over x — that is why a slower curve makes a longer clip.
 *
 * Every segment between two anchors is a CUBIC BEZIER, shaped by the tangent
 * handles the anchors carry (`hIn` / `hOut`, stored as OFFSETS from their anchor so
 * dragging an anchor takes its handles with it — the same convention as shapePath.js
 * and the camera path). An anchor without `manual: true` gets AUTO handles a third of
 * the way along the straight line to its neighbour: control points at 1/3 and 2/3 of
 * a segment reproduce that segment EXACTLY, so an unshaped curve is still piecewise
 * linear and reads identically to the pre-tangent editor — no existing project
 * retimes itself. Handles are only ever a departure the user draws.
 *
 * Two invariants make the maths safe, and both are enforced in resolveSpeedCurve():
 *  - a handle's x offset stays inside its own segment, so x(t) is monotonic and the
 *    curve stays a FUNCTION of time (no folding back);
 *  - a control point's y stays inside [SPEED_MIN, SPEED_MAX], and a bezier never
 *    leaves the convex hull of its controls — so the sampled rate can never reach 0
 *    (which would stall the time mapping) or run away.
 */

export const SPEED_MIN = 0.1;
export const SPEED_MAX = 20;

// Auto handle length as a fraction of the segment. 1/3 is the value that makes a
// bezier trace its own chord — the whole reason an unshaped curve stays linear.
const AUTO_HANDLE = 1 / 3;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/*
 * THE GRAPH AXIS, and speedToNorm / normToSpeed are the only place that knows its
 * shape — the editor maps every anchor, handle, grid rule and label through them.
 *
 * It is SPLIT at 1x, which gets a fixed SLOW_SHARE of the plot's height: the whole
 * slow-motion range (SPEED_MIN up to 1x) owns the bottom quarter and everything
 * above 1x owns the top three quarters. That division is deliberate and does not
 * move when the ceiling does — a plain linear ruler gave slow motion a twelfth of
 * the box (13px of a 160px plot, no room to place a point in) and a plain log one
 * hands it nearly half, which is more than the range deserves next to every
 * speed-up there is.
 *
 * Inside each half the mapping is LOGARITHMIC, because speed is a RATIO: 1x -> 2x
 * gets as much height as 2x -> 4x, so the rates people actually reach for are not
 * crushed against the 1x line by the one time someone asks for 20x.
 *
 * Always finite: resolveSpeedCurve clamps every control point into
 * [SPEED_MIN, SPEED_MAX] and a bezier stays inside the convex hull of its
 * controls, so a sampled rate can never reach the 0 that log() has no answer for.
 */
const SLOW_SHARE = 0.25;                          // height below the 1x rule
const LOG_SLOW = -Math.log(SPEED_MIN);            // SPEED_MIN .. 1x, in log units
const LOG_FAST = Math.log(SPEED_MAX);             // 1x .. SPEED_MAX

// speed -> 0 (SPEED_MIN, floor of the plot) .. 1 (SPEED_MAX, ceiling).
export const speedToNorm = (speed) => {
  const v = clamp(num(speed, 1), SPEED_MIN, SPEED_MAX);
  return v <= 1
    ? SLOW_SHARE * (1 + (Math.log(v) / LOG_SLOW))
    : SLOW_SHARE + ((1 - SLOW_SHARE) * (Math.log(v) / LOG_FAST));
};

// ...and back, for a pointer position read off the plot.
export const normToSpeed = (norm) => {
  const n = clamp(num(norm, 0), 0, 1);
  const v = n <= SLOW_SHARE
    ? Math.exp(((n / SLOW_SHARE) - 1) * LOG_SLOW)
    : Math.exp(((n - SLOW_SHARE) / (1 - SLOW_SHARE)) * LOG_FAST);
  return clamp(v, SPEED_MIN, SPEED_MAX);
};

// The rate ladder the plot rules lines at. Halving below the 1x rule and doubling
// above it — the log inside each half spaces both evenly. The 1x entry is the
// reference line the editor colours.
export const SPEED_GRID = [0.25, 0.5, 1, 2, 4, 8, 16];

const cubic = (a, b, c, d, t) => {
  const u = 1 - t;
  return (u * u * u * a) + (3 * u * u * t * b) + (3 * u * t * t * c) + (t * t * t * d);
};

const cubicDeriv = (a, b, c, d, t) => {
  const u = 1 - t;
  return (3 * u * u * (b - a)) + (6 * u * t * (c - b)) + (3 * t * t * (d - c));
};

const speedCurveCache = new WeakMap();

/**
 * The evaluable form of a speed curve: sorted anchors with their handles resolved
 * and clamped, the bezier segments built from them, and the total area (= average
 * speed) already integrated.
 *
 * Cached per points ARRAY — the editor replaces the array on every edit, so a new
 * identity is exactly when the curve needs rebuilding.
 */
export function resolveSpeedCurve(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const cached = speedCurveCache.get(points);
  if (cached) return cached;

  const sorted = points
    .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
    .map((p) => ({
      x: num(p.x),
      y: clamp(num(p.y, 1), SPEED_MIN, SPEED_MAX),
      manual: p.manual === true,
      hIn: p.hIn ? { x: num(p.hIn.x), y: num(p.hIn.y) } : null,
      hOut: p.hOut ? { x: num(p.hOut.x), y: num(p.hOut.y) } : null,
    }))
    .sort((a, b) => a.x - b.x);

  if (sorted.length === 0) return null;

  const anchors = sorted.map((p, i) => {
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    const shape = (raw, neighbour) => {
      if (!neighbour) return null;
      const dx = neighbour.x - p.x;
      const auto = { x: dx * AUTO_HANDLE, y: (neighbour.y - p.y) * AUTO_HANDLE };
      const h = (p.manual && raw) ? raw : auto;
      return {
        // Inside the segment only: x must never run backwards past its anchor or
        // forwards past the next one, or the curve stops being a function of time.
        x: dx >= 0 ? clamp(h.x, 0, dx) : clamp(h.x, dx, 0),
        // Convex hull: a legal control point means a legal curve.
        y: clamp(p.y + h.y, SPEED_MIN, SPEED_MAX) - p.y,
      };
    };
    return { x: p.x, y: p.y, manual: p.manual, hIn: shape(p.hIn, prev), hOut: shape(p.hOut, next) };
  });

  const segments = [];
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const ah = a.hOut || { x: 0, y: 0 };
    const bh = b.hIn || { x: 0, y: 0 };
    const seg = {
      x0: a.x, x1: a.x + ah.x, x2: b.x + bh.x, x3: b.x,
      y0: a.y, y1: a.y + ah.y, y2: b.y + bh.y, y3: b.y,
    };
    seg.linear = isLinearSegment(seg);
    seg.area = segmentArea(seg, 1);
    segments.push(seg);
  }

  const curve = {
    anchors,
    segments,
    area: segments.reduce((sum, s) => sum + s.area, 0),
    first: anchors[0],
    last: anchors[anchors.length - 1],
  };
  speedCurveCache.set(points, curve);
  return curve;
}

/*
 * Is this segment still the straight line between its anchors? Controls sitting at
 * exactly a third and two thirds of the chord make the cubic collapse to that line,
 * which is what an unshaped anchor produces.
 *
 * Worth detecting: the straight case then takes the closed-form trapezoid instead of
 * the quadrature, so a project that has never been shaped keeps its old durations to
 * the last bit rather than picking up 1e-16 of numerical drift.
 */
function isLinearSegment(seg) {
  const dx = seg.x3 - seg.x0;
  const dy = seg.y3 - seg.y0;
  const eps = 1e-9 * Math.max(1, Math.abs(dx), Math.abs(dy));
  return Math.abs(seg.x1 - (seg.x0 + (dx / 3))) <= eps
    && Math.abs(seg.x2 - (seg.x0 + ((2 * dx) / 3))) <= eps
    && Math.abs(seg.y1 - (seg.y0 + (dy / 3))) <= eps
    && Math.abs(seg.y2 - (seg.y0 + ((2 * dy) / 3))) <= eps;
}

// The parameter t where a segment crosses time `x`. x(t) is monotonic by
// construction, so Newton converges from the linear guess; the bisection fallback
// covers a segment whose x barely moves (two anchors almost on top of each other).
function solveSegmentT(seg, x) {
  const span = seg.x3 - seg.x0;
  if (span <= 1e-9) return 0;
  let t = clamp((x - seg.x0) / span, 0, 1);
  if (seg.linear) return t;
  for (let i = 0; i < 8; i += 1) {
    const err = cubic(seg.x0, seg.x1, seg.x2, seg.x3, t) - x;
    if (Math.abs(err) < 1e-7) return t;
    const d = cubicDeriv(seg.x0, seg.x1, seg.x2, seg.x3, t);
    if (Math.abs(d) < 1e-7) break;
    t = clamp(t - err / d, 0, 1);
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) * 0.5;
    if (cubic(seg.x0, seg.x1, seg.x2, seg.x3, mid) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/*
 * Add an anchor at time `x` (rate `y`) WITHOUT putting a corner there. A bare
 * `{ x, y }` gets auto handles along each of its two new chords, and those chords
 * meet at an angle — the fresh point reads as a kink until the first tangent drag
 * mirrors the pair. So the segment the point lands in is SPLIT at x (de Casteljau):
 * the new anchor carries the curve's own tangent there as a collinear pair of
 * manual handles, and a hand-shaped neighbour keeps just the part of its handle
 * that still belongs to its now-shorter segment (an auto neighbour stays auto).
 * Dropped at the curve's own rate the point reproduces the curve exactly; at any
 * other rate it is a smooth bump. Returns a new sorted array.
 */
export function insertSpeedPoint(points, x, y) {
  const rate = clamp(num(y, 1), SPEED_MIN, SPEED_MAX);
  const sorted = Array.isArray(points) ? [...points].sort((a, b) => num(a?.x) - num(b?.x)) : [];
  const curve = resolveSpeedCurve(points);
  const idx = curve ? curve.segments.findIndex((s) => x > s.x0 && x < s.x3) : -1;
  const seg = idx >= 0 ? curve.segments[idx] : null;
  if (!seg || seg.x3 - seg.x0 <= 1e-6 || sorted.length !== curve.anchors.length) {
    return [...sorted, { x, y: rate }].sort((a, b) => a.x - b.x);
  }
  const { q0, q2, r0, r1, s } = splitSegment(seg, solveSegmentT(seg, x));

  const next = [...sorted];
  const prev = next[idx];
  const after = next[idx + 1];
  if (prev?.manual === true && prev.hOut) {
    next[idx] = { ...prev, hOut: { x: q0.x - seg.x0, y: q0.y - seg.y0 } };
  }
  if (after?.manual === true && after.hIn) {
    next[idx + 1] = { ...after, hIn: { x: q2.x - seg.x3, y: q2.y - seg.y3 } };
  }
  next.splice(idx + 1, 0, {
    x,
    y: rate,
    manual: true,
    hIn: { x: r0.x - s.x, y: r0.y - s.y },
    hOut: { x: r1.x - s.x, y: r1.y - s.y },
  });
  return next;
}

// de Casteljau at parameter t: the left half is P0 q0 r0 s, the right half s r1 q2 P3.
function splitSegment(seg, t) {
  const lerp = (a, b) => a + ((b - a) * t);
  const q0 = { x: lerp(seg.x0, seg.x1), y: lerp(seg.y0, seg.y1) };
  const q1 = { x: lerp(seg.x1, seg.x2), y: lerp(seg.y1, seg.y2) };
  const q2 = { x: lerp(seg.x2, seg.x3), y: lerp(seg.y2, seg.y3) };
  const r0 = { x: lerp(q0.x, q1.x), y: lerp(q0.y, q1.y) };
  const r1 = { x: lerp(q1.x, q2.x), y: lerp(q1.y, q2.y) };
  const s = { x: lerp(r0.x, r1.x), y: lerp(r0.y, r1.y) };
  return { q0, q1, q2, r0, r1, s };
}

/*
 * The two halves of a resolved segment cut at time `x`, each as its four control
 * points in curve space — what splitting a clip does to the keyed segment it lands
 * in (speedKeyframes.splitSpeedTrack). Null when `x` is not strictly inside one.
 */
export function splitSpeedSegmentAt(points, x) {
  const curve = resolveSpeedCurve(points);
  const seg = curve?.segments.find((sg) => x > sg.x0 && x < sg.x3);
  if (!seg) return null;
  const { q0, q2, r0, r1, s } = splitSegment(seg, solveSegmentT(seg, x));
  const p0 = { x: seg.x0, y: seg.y0 };
  const p3 = { x: seg.x3, y: seg.y3 };
  return { left: [p0, q0, r0, s], right: [s, r1, q2, p3] };
}

/*
 * Cut a curve in two at timeline progress `u` (0-1): what splitting a CLIP does to
 * its retiming. Each piece is its own side of the curve with x stretched back to
 * 0-1; a rate is a rate, so y is untouched. That makes the cut invisible — piece one
 * fills exactly u of the uncut clip's timeline span and piece two the rest, and
 * every frame of both maps to the same source time the uncut clip showed there.
 *
 * The segment the cut lands in is split by de Casteljau, so each side keeps its
 * exact shape. Every other anchor is copied as it is stored — auto stays auto,
 * because an auto handle is a third of its chord and stretching x is affine, so it
 * resolves to the same control point. Only the two ends of the cut segment can need
 * more: an end whose handle into that segment was AUTO is written out with its
 * resolved handles as manual ones, unless the segment is straight (then auto still
 * lands on the sub-segment exactly, and the curve stays as plain as it was).
 *
 * Returns { first, second, sourceFraction }: sourceFraction is the share of the
 * clip's SOURCE the first piece plays (mapTimelineToSource at u) — where the trim
 * cut goes. Null when u is not strictly inside 0-1 or there is no curve.
 */
export function splitSpeedPoints(points, u) {
  const curve = resolveSpeedCurve(points);
  if (!curve || !(u > 0) || !(u < 1)) return null;
  // The same filter and order resolveSpeedCurve used, so raw[i] is anchors[i].
  const raw = points
    .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
    .sort((a, b) => num(a.x) - num(b.x));
  const { anchors } = curve;

  const handle = (h, scale) => (h ? { x: num(h.x) * scale, y: num(h.y) } : null);
  // A stored anchor moved into a piece that starts at `from` and is `scale` times
  // shorter. `hIn` / `hOut` override what the anchor stores (null drops it).
  const place = (p, from, scale, over = {}) => {
    const out = { x: (num(p.x) - from) * scale, y: clamp(num(p.y, 1), SPEED_MIN, SPEED_MAX) };
    const hIn = 'hIn' in over ? over.hIn : handle(p.hIn, scale);
    const hOut = 'hOut' in over ? over.hOut : handle(p.hOut, scale);
    if (hIn) out.hIn = hIn;
    if (hOut) out.hOut = hOut;
    if ((over.manual ?? p.manual === true) && (hIn || hOut)) out.manual = true;
    return out;
  };
  const pinEnds = (piece) => {
    piece[0].x = 0;
    piece[piece.length - 1].x = 1;
    return piece;
  };
  const sourceFraction = mapTimelineToSource(points, u);
  const s1 = 1 / u;
  const s2 = 1 / (1 - u);

  // On an existing anchor: nothing to split, each side keeps its own segments.
  const at = anchors.findIndex((a) => Math.abs(a.x - u) <= 1e-9);
  if (at > 0 && at < anchors.length - 1) {
    return {
      first: pinEnds(raw.slice(0, at + 1).map((p, i) => place(p, 0, s1, i === at ? { hOut: null } : {}))),
      second: pinEnds(raw.slice(at).map((p, i) => place(p, u, s2, i === 0 ? { hIn: null } : {}))),
      sourceFraction,
    };
  }

  const idx = curve.segments.findIndex((sg) => u > sg.x0 && u < sg.x3);
  const seg = curve.segments[idx];
  if (!seg || raw.length !== anchors.length) {
    // Before the first anchor / after the last one the rate holds: both pieces
    // are that constant rate.
    const y = getSpeedAtTime(points, u);
    const flat = [{ x: 0, y }, { x: 1, y }];
    return { first: flat, second: flat.map((p) => ({ ...p })), sourceFraction };
  }

  const { q0, q2, r0, r1, s } = splitSegment(seg, solveSegmentT(seg, u));
  const a = anchors[idx];
  const b = anchors[idx + 1];
  const off = (pt, from, scale) => ({ x: (pt.x - from.x) * scale, y: pt.y - from.y });
  // The cut segment's ends. A manual end gets the sub-segment's control point; an
  // auto end keeps auto only while the segment is straight.
  const keepA = !a.manual && seg.linear;
  const keepB = !b.manual && seg.linear;
  const resolved = (h, scale) => (h ? { x: h.x * scale, y: h.y } : null);
  const aOver = keepA ? {} : { manual: true, hIn: a.manual ? handle(raw[idx].hIn, s1) : resolved(a.hIn, s1), hOut: off(q0, a, s1) };
  const bOver = keepB ? {} : { manual: true, hIn: off(q2, b, s2), hOut: b.manual ? handle(raw[idx + 1].hOut, s2) : resolved(b.hOut, s2) };
  const y = clamp(s.y, SPEED_MIN, SPEED_MAX);
  const cutIn = seg.linear ? { x: 1, y } : { x: 1, y, manual: true, hIn: off(r0, s, s1) };
  const cutOut = seg.linear ? { x: 0, y } : { x: 0, y, manual: true, hOut: off(r1, s, s2) };

  const first = raw.slice(0, idx + 1).map((p, i) => place(p, 0, s1, i === idx ? aOver : {}));
  const second = raw.slice(idx + 1).map((p, i) => place(p, u, s2, i === 0 ? bOver : {}));
  return { first: pinEnds([...first, cutIn]), second: pinEnds([cutOut, ...second]), sourceFraction };
}

// 4-point Gauss-Legendre. The integrand y(t)·x'(t) is degree 5, so this is EXACT,
// not an approximation — the source time a curve consumes is computed, not sampled.
const GAUSS = [
  [-0.8611363115940526, 0.3478548451374538],
  [-0.3399810435848563, 0.6521451548625461],
  [0.3399810435848563, 0.6521451548625461],
  [0.8611363115940526, 0.3478548451374538],
];

// ∫ y dx over the segment's parameter range [0, tEnd].
function segmentArea(seg, tEnd) {
  if (tEnd <= 0) return 0;
  if (seg.linear) {
    // Trapezoid, exactly as the pre-tangent evaluator computed it.
    const width = (seg.x3 - seg.x0) * tEnd;
    const yAtT = seg.y0 + ((seg.y3 - seg.y0) * tEnd);
    return width * (seg.y0 + yAtT) / 2;
  }
  const half = tEnd * 0.5;
  let sum = 0;
  for (const [node, weight] of GAUSS) {
    const t = half * (node + 1);
    sum += weight * cubic(seg.y0, seg.y1, seg.y2, seg.y3, t)
      * cubicDeriv(seg.x0, seg.x1, seg.x2, seg.x3, t);
  }
  return sum * half;
}

// A point ON a resolved segment, in curve space. The editor draws with this: under
// a non-linear axis a cubic no longer maps to a cubic, so the picture is sampled
// from the same segments this module integrates rather than re-emitted as a bezier.
export const speedSegmentPoint = (seg, t) => ({
  x: cubic(seg.x0, seg.x1, seg.x2, seg.x3, t),
  y: cubic(seg.y0, seg.y1, seg.y2, seg.y3, t),
});

export const getSpeedAtTime = (points, x) => {
  const curve = resolveSpeedCurve(points);
  if (!curve) return 1;
  if (x <= curve.first.x) return curve.first.y;
  if (x >= curve.last.x) return curve.last.y;
  for (const seg of curve.segments) {
    if (x >= seg.x0 && x <= seg.x3) {
      const t = solveSegmentT(seg, x);
      if (seg.linear) return seg.y0 + ((seg.y3 - seg.y0) * t);
      return cubic(seg.y0, seg.y1, seg.y2, seg.y3, t);
    }
  }
  return 1;
};

export const getAverageSpeed = (points) => {
  const curve = resolveSpeedCurve(points);
  if (!curve) return 1;
  if (curve.segments.length === 0) return curve.first.y || 1;
  return curve.area || 1;
};

export const mapTimelineToSource = (points, t) => {
  const curve = resolveSpeedCurve(points);
  if (!curve || curve.segments.length === 0) return t;
  const totalArea = curve.area;
  if (totalArea === 0) return 0;
  let currentArea = 0;
  for (const seg of curve.segments) {
    if (seg.x3 <= t) {
      currentArea += seg.area;
    } else if (seg.x0 < t) {
      currentArea += segmentArea(seg, solveSegmentT(seg, t));
      break;
    } else {
      break;
    }
  }
  return currentArea / totalArea;
};

export const getTimelineDuration = (sourceDuration, points) => {
  const avgSpeed = getAverageSpeed(points);
  return sourceDuration / avgSpeed;
};

// Slowest point on the curve — the ratio the whole smooth-slow-motion feature is
// built on. With tangents a segment can dip BELOW both its anchors, so the minimum
// is taken over each cubic's own turning points as well as its ends.
export const getMinSpeed = (points) => {
  const curve = resolveSpeedCurve(points);
  if (!curve) return 1;
  let min = curve.first.y;
  for (const seg of curve.segments) {
    min = Math.min(min, seg.y0, seg.y3);
    const A = seg.y1 - seg.y0;
    const B = seg.y2 - seg.y1;
    const C = seg.y3 - seg.y2;
    // y'(t)/3 = (A - 2B + C)t² + 2(B - A)t + A
    const a = A - (2 * B) + C;
    const b = 2 * (B - A);
    const c = A;
    const roots = [];
    if (Math.abs(a) < 1e-9) {
      if (Math.abs(b) > 1e-9) roots.push(-c / b);
    } else {
      const disc = (b * b) - (4 * a * c);
      if (disc >= 0) {
        const root = Math.sqrt(disc);
        roots.push((-b + root) / (2 * a), (-b - root) / (2 * a));
      }
    }
    for (const t of roots) {
      if (t > 0 && t < 1) min = Math.min(min, cubic(seg.y0, seg.y1, seg.y2, seg.y3, t));
    }
  }
  return Number.isFinite(min) ? min : 1;
};

export const isFlatSpeed = (points) => {
  const curve = resolveSpeedCurve(points);
  if (!curve) return true;
  const first = curve.first.y;
  // Control points too: a flat pair of anchors with a handle pulled off them is a
  // curve that bulges, and treating it as flat would skip the retiming path.
  return curve.segments.every((seg) => Math.abs(seg.y0 - first) < 1e-6
    && Math.abs(seg.y1 - first) < 1e-6
    && Math.abs(seg.y2 - first) < 1e-6
    && Math.abs(seg.y3 - first) < 1e-6)
    && Math.abs(curve.last.y - first) < 1e-6;
};

export const SPEED_POINTS_DEFAULT = [{ x: 0, y: 1 }, { x: 1, y: 1 }];

/**
 * Load guard for a stored curve. Anchors are clamped into the editor's own box and
 * the ends are pinned to 0 and 1; tangent handles ride along, so a hand-shaped
 * curve survives a save/load round trip (without this they would be dropped on the
 * next open and every shaped segment would silently snap back to straight).
 */
export function sanitizeSpeedPoints(points) {
  if (!Array.isArray(points) || points.length < 2) return SPEED_POINTS_DEFAULT.map((p) => ({ ...p }));

  const handle = (h) => {
    if (!h || typeof h !== 'object') return null;
    if (!Number.isFinite(Number(h.x)) || !Number.isFinite(Number(h.y))) return null;
    return { x: clamp(num(h.x), -1, 1), y: clamp(num(h.y), -SPEED_MAX, SPEED_MAX) };
  };

  const normalized = points
    .filter((p) => p && typeof p === 'object')
    .map((point) => {
      const clean = {
        x: clamp(num(point.x, 0), 0, 1),
        y: clamp(num(point.y, 1), SPEED_MIN, SPEED_MAX),
      };
      const hIn = handle(point.hIn);
      const hOut = handle(point.hOut);
      if (hIn) clean.hIn = hIn;
      if (hOut) clean.hOut = hOut;
      if (point.manual === true && (hIn || hOut)) clean.manual = true;
      return clean;
    })
    .sort((a, b) => a.x - b.x);

  if (normalized.length < 2) return SPEED_POINTS_DEFAULT.map((p) => ({ ...p }));
  normalized[0].x = 0;
  normalized[normalized.length - 1].x = 1;
  return normalized;
}

// How many times more frames the source needs for a slowed clip to still hit
// the project frame rate at its slowest point. At speed `s` one second of
// timeline consumes `s` seconds of source, so it only shows `sourceFps * s`
// real frames — the whole slow-motion feature is this ratio.
// Returns 1 when nothing needs generating.
export const getInterpolationFactor = (sourceFps, minSpeed, targetFps) => {
  if (!Number.isFinite(sourceFps) || sourceFps <= 0) return 1;
  if (!Number.isFinite(minSpeed) || minSpeed <= 0 || minSpeed >= 1) return 1;
  if (!Number.isFinite(targetFps) || targetFps <= 0) return 1;
  const effectiveFps = sourceFps * minSpeed;
  if (effectiveFps >= targetFps) return 1;
  return Math.max(2, Math.ceil(targetFps / effectiveFps));
};

// A free-positioned clip only takes a cross transition when it actually TOUCHES
// the clip before it. Half a frame of slack at 60fps absorbs the rounding a drag
// leaves behind; anything further apart is a deliberate gap, and silently
// overlapping across it would move a clip the user placed by hand.
const UNSNAPPED_TOUCH_EPSILON = 1 / 120;

/*
 * 'Previous over next': the clip BEFORE the cut is the one that gives ground.
 *
 * It slides LATER by the overlap so its tail comes to rest on the head of the
 * clip after it, which has not moved — and EVERYTHING already laid down before
 * it slides with it, keeping the edit behind the cut exactly as it was.
 *
 * That "everything" is the whole point. Sliding only the clips joined by a
 * TRANSITION looks equivalent and is not: a plain hard cut is a join too, and
 * leaving its left-hand neighbour behind tore a hole of silence and black into
 * the middle of the edit every time a transition was applied further down the
 * channel. Nothing behind the cut may notice this move; the length it costs is
 * paid once, in front of the first clip.
 */
const slideEarlierClipsLater = (layout, anchorEnds, index, amount) => {
  if (!(amount > 0)) return;
  for (let j = index; j >= 0; j--) {
    layout[j].startTime += amount;
    layout[j].endTime += amount;
    if (anchorEnds[j] != null) anchorEnds[j] += amount;
  }
};

export const getTimelineLayout = (timeline, { unsnapped } = {}) => {
  const layout = [];
  let currentCursor = 0;
  // Where each item ends BEFORE its successor's overlap pulls it back. Chained
  // transitions have to test adjacency against this, not against the shifted
  // end, or the second transition in a run would stop seeing its neighbour.
  const anchorEnds = [];
  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    const sourceDuration = item.trimEnd - item.trimStart;
    const tlDuration = getTimelineDuration(sourceDuration, item.speedPoints);
    if (unsnapped && item.freeStart != null) {
      // Adjacency is a property of the PAIR, not of the transition on it: a
      // seam exists wherever this clip starts where the previous one ended,
      // whether or not something is currently blending across it. Computed
      // before the transition test so callers can ask "is there a seam here?"
      // (the timeline's seam button) with the same answer the overlap uses.
      const prevAnchorEnd = i > 0 ? anchorEnds[i - 1] : null;
      const touchingPrev = prevAnchorEnd != null
        && Math.abs(prevAnchorEnd - item.freeStart) <= UNSNAPPED_TOUCH_EPSILON;
      let overlap = 0;
      if (touchingPrev && item.transition !== TransitionType.NONE) {
        overlap = Math.min(layout[i - 1].duration, tlDuration, item.transitionDuration);
      }
      // Which clip gives ground. 'Previous over next' leaves this one exactly
      // where it was placed and slides the clip BEFORE it later instead.
      const previousMoves = overlap > 0 && movesPreviousClip(item.transitionOrder);
      // A joined clip is placed against where the previous one actually ENDS UP,
      // not against its own freeStart. Adjacency is judged in freeStart space
      // (anchorEnds), but a chain of transitions draws each clip earlier than its
      // anchor — so measuring this one from its own freeStart drops the shift the
      // clip before it already took, and the two are drawn apart by the
      // difference even though the layout has them crossing. Unjoined clips keep
      // the position they were placed at, which is the whole point of the channel.
      const startTime = overlap > 0
        ? (previousMoves ? layout[i - 1].endTime : layout[i - 1].endTime - overlap)
        : item.freeStart;
      const endTime = startTime + tlDuration;
      layout.push({ startTime, endTime, duration: tlDuration, overlapIn: overlap, touchingPrev });
      anchorEnds.push(item.freeStart + tlDuration);
      currentCursor = endTime;
      if (previousMoves) slideEarlierClipsLater(layout, anchorEnds, i - 1, overlap);
    } else {
      let overlap = 0;
      if (i > 0 && item.transition !== TransitionType.NONE) {
        const prevLayout = layout[i - 1];
        const maxOverlap = Math.min(prevLayout.duration, tlDuration, item.transitionDuration);
        overlap = maxOverlap;
      }
      const previousMoves = overlap > 0 && movesPreviousClip(item.transitionOrder);
      const startTime = previousMoves ? currentCursor : currentCursor - overlap;
      const endTime = startTime + tlDuration;
      // A snapped channel is a chain: every clip after the first abuts its
      // predecessor by construction.
      layout.push({ startTime, endTime, duration: tlDuration, overlapIn: overlap, touchingPrev: i > 0 });
      anchorEnds.push(endTime);
      currentCursor = endTime;
      if (previousMoves) slideEarlierClipsLater(layout, anchorEnds, i - 1, overlap);
    }
  }
  return layout;
};

// Free-positioned channels can temporarily carry items whose array order does
// not match their `freeStart` order (for example, after moving a layer). Project
// duration must describe the latest visible end, not whichever item happens to
// be stored last in that array.
export const getTimelineEndTime = (layout) => {
  let endTime = 0;
  for (const entry of layout || []) {
    if (Number.isFinite(entry?.endTime)) endTime = Math.max(endTime, entry.endTime);
  }
  return endTime;
};

/*
 * On a free-positioned channel, clips only overlap where the user put them — so a
 * cross transition asked for on a clip floating somewhere in the middle of the
 * timeline has nothing to cross INTO. Rather than refuse it (which is what the
 * editor used to do), move that clip up against the one before it: that is the
 * only position where the transition means anything, and it is what the user is
 * asking for by choosing one.
 *
 * Only the edited clip moves, and only when a transition is actually set —
 * everything else on the channel keeps the position it was placed at. Returns the
 * same array when nothing needs to move, so callers can skip a re-render.
 */
export const snapForCrossTransition = (items, editedId) => {
  const index = items.findIndex((it) => it.id === editedId);
  if (index <= 0) return items;                     // nothing before it to cross into
  const item = items[index];
  if (!item.transition || item.transition === TransitionType.NONE) return items;

  const layout = getTimelineLayout(items, { unsnapped: true });
  const prev = items[index - 1];
  // Where the previous clip visually ends, ignoring any overlap pulled into IT.
  const prevStart = Number.isFinite(prev.freeStart) ? prev.freeStart : layout[index - 1].startTime;
  const prevEnd = Math.max(0, prevStart + layout[index - 1].duration);
  const currentStart = Number.isFinite(item.freeStart) ? item.freeStart : layout[index].startTime;
  if (Math.abs(currentStart - prevEnd) < 1e-4) return items;

  const next = items.slice();
  next[index] = { ...item, freeStart: prevEnd };
  return next;
};
