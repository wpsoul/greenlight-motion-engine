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

/*
 * PLOT-SPACE CURVES (desktop 15.8.20)
 *
 * A curve whose anchors carry `tan` is built on the PLOT's own scale instead: each
 * segment is a cubic in (x, n), n being the height on the split-log axis above
 * (speedToNorm), and the rate that plays is normToSpeed(n). What the editor draws is
 * then exactly what plays, a handle is the exact tangent of the curve it shapes, and
 * two handles in a line make a point with no corner — on screen and in playback.
 * (A rate-space curve bends where it crosses 1×, an unshaped anchor is a corner and
 * a long handle's dot is not where the curve heads: the "hard to control" report of
 * 2026-11-01, measured in html/INTERFACE/speed-curve-tangents-lab.)
 *
 * An anchor keeps its rate in `y` — everything that reads `p.y` still works — and its
 * tangent as `tan`:
 *   'auto'      worked out from the neighbours (monotone: flat at a peak or a dip,
 *               never swinging past a point), re-worked whenever a point moves;
 *   'linked'    `mIn` = `mOut`: both sides turn and stretch together;
 *   'separate'  `mIn` / `mOut` on their own — a corner when they differ;
 *   'flat'      slope 0, the speed eases in and out of the point.
 * `mIn` / `mOut` are slopes in plot units (height per unit of progress), `kIn` / `kOut`
 * how far a handle reaches into the gap on its side (0-1). Both are relative, so moving
 * a point or its neighbours carries the shape along. A handle too tall for the plot is
 * shortened along its own line, never bent, so a pair in a line stays in a line.
 *
 * A curve without `tan` keeps the rate-space maths further down to the last bit: no
 * stored project retimes itself. The editor converts a curve the first time it is
 * edited (speedCurveToPlot) and writes rate-space `hIn` / `hOut` / `manual` alongside
 * (attachRateHandles), an approximation an older app or engine still plays closely.
 */
export const TANGENT_MODES = ['auto', 'linked', 'separate', 'flat'];
const TANGENT_SET = new Set(TANGENT_MODES);

export const isPlotSpeedCurve = (points) => Array.isArray(points)
  && points.some((p) => p && TANGENT_SET.has(p.tan));

/*
 * Monotone tangents (Fritsch–Butland, the PCHIP end rule): zero at a peak or a dip,
 * never steeper than a segment can take without overshooting its far point — so with
 * handles a third of the gap long the curve stays between every pair of anchors.
 */
export function speedAutoSlopes(xs, ys) {
  const n = xs.length;
  const m = new Array(n).fill(0);
  if (n < 2) return m;
  const h = [];
  const d = [];
  for (let i = 0; i < n - 1; i += 1) {
    h[i] = xs[i + 1] - xs[i];
    d[i] = h[i] > 1e-9 ? (ys[i + 1] - ys[i]) / h[i] : 0;
  }
  if (n === 2) {
    m[0] = d[0];
    m[1] = d[0];
    return m;
  }
  for (let i = 1; i < n - 1; i += 1) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = (2 * h[i]) + h[i - 1];
      const w2 = h[i] + (2 * h[i - 1]);
      m[i] = (w1 + w2) / ((w1 / d[i - 1]) + (w2 / d[i]));
    }
  }
  const end = (h0, h1, d0, d1) => {
    let s = ((((2 * h0) + h1) * d0) - (h0 * d1)) / (h0 + h1);
    if (Math.sign(s) !== Math.sign(d0)) s = 0;
    else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(s) > Math.abs(3 * d0)) s = 3 * d0;
    return s;
  };
  m[0] = end(h[0], h[1], d[0], d[1]);
  m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  return m;
}

// A handle of slope m reaching k of a gap dx (signed: + out, − in). Too tall for the
// plot → shortened along its own line, so its partner stays opposite.
function fitHandleK(n0, m, k, dx) {
  const dn = m * k * dx;
  const y = n0 + dn;
  if (y > 1 && dn > 0) return k * ((1 - n0) / dn);
  if (y < 0 && dn < 0) return k * ((0 - n0) / dn);
  return k;
}

// Where a plot segment crosses the 1× rule. The axis bends there, so the rate's
// integrand does too — the quadrature is split at these to stay exact.
function plotSegmentKinks(seg) {
  const ys = [seg.y0, seg.y1, seg.y2, seg.y3];
  if (Math.min(...ys) >= SLOW_SHARE || Math.max(...ys) <= SLOW_SHARE) return [];
  const f = (t) => cubic(seg.y0, seg.y1, seg.y2, seg.y3, t) - SLOW_SHARE;
  const out = [];
  const N = 24;
  for (let j = 0; j < N; j += 1) {
    let lo = j / N;
    let hi = (j + 1) / N;
    if (f(lo) * f(hi) >= 0) continue;
    for (let i = 0; i < 40; i += 1) {
      const mid = (lo + hi) * 0.5;
      if (f(lo) * f(mid) <= 0) hi = mid;
      else lo = mid;
    }
    out.push((lo + hi) * 0.5);
  }
  return out;
}

function resolvePlotCurve(points) {
  const sorted = points
    .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
    .map((p) => {
      const y = clamp(num(p.y, 1), SPEED_MIN, SPEED_MAX);
      return {
        x: num(p.x),
        y,
        n: speedToNorm(y),
        tan: TANGENT_SET.has(p.tan) ? p.tan : 'auto',
        mIn: num(p.mIn),
        mOut: num(p.mOut),
        kIn: clamp(num(p.kIn, AUTO_HANDLE), 0, 1),
        kOut: clamp(num(p.kOut, AUTO_HANDLE), 0, 1),
      };
    })
    .sort((a, b) => a.x - b.x);
  if (sorted.length === 0) return null;

  const auto = speedAutoSlopes(sorted.map((p) => p.x), sorted.map((p) => p.n));
  const anchors = sorted.map((p, i) => {
    let { mIn, mOut, kIn, kOut } = p;
    if (p.tan === 'auto') {
      mIn = auto[i];
      mOut = auto[i];
      kIn = AUTO_HANDLE;
      kOut = AUTO_HANDLE;
    } else if (p.tan === 'flat') {
      mIn = 0;
      mOut = 0;
    }
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    const dxL = prev ? p.x - prev.x : 0;
    const dxR = next ? next.x - p.x : 0;
    const kInE = prev ? fitHandleK(p.n, mIn, kIn, -dxL) : 0;
    const kOutE = next ? fitHandleK(p.n, mOut, kOut, dxR) : 0;
    return {
      x: p.x,
      y: p.y,
      n: p.n,
      tan: p.tan,
      mIn,
      mOut,
      kIn: kInE,
      kOut: kOutE,
      // The handles as plot-space offsets — what the editor draws and drags.
      pIn: prev ? { x: -kInE * dxL, y: -mIn * kInE * dxL } : null,
      pOut: next ? { x: kOutE * dxR, y: mOut * kOutE * dxR } : null,
    };
  });

  const segments = [];
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const seg = {
      space: 'norm',
      linear: false,
      x0: a.x, x1: a.x + a.pOut.x, x2: b.x + b.pIn.x, x3: b.x,
      y0: a.n, y1: a.n + a.pOut.y, y2: b.n + b.pIn.y, y3: b.n,
    };
    seg.flat = Math.abs(seg.y1 - seg.y0) < 1e-12 && Math.abs(seg.y2 - seg.y0) < 1e-12 && Math.abs(seg.y3 - seg.y0) < 1e-12;
    seg.kinks = seg.flat ? [] : plotSegmentKinks(seg);
    seg.area = segmentArea(seg, 1);
    segments.push(seg);
  }

  return {
    space: 'norm',
    anchors,
    segments,
    area: segments.reduce((sum, s) => sum + s.area, 0),
    first: anchors[0],
    last: anchors[anchors.length - 1],
  };
}

/*
 * Rate-space handles for a plot curve: each control point taken back to a rate. Not
 * the same curve (a cubic on one scale is not a cubic on the other), but close — what
 * an older app or the published engine plays, and the keyframe track's shape.
 */
export function speedCurveToRate(points) {
  if (!isPlotSpeedCurve(points)) return points;
  const curve = resolveSpeedCurve(points);
  if (!curve) return points;
  return curve.anchors.map((a) => {
    const out = { x: a.x, y: a.y };
    if (a.pIn) out.hIn = { x: a.pIn.x, y: normToSpeed(a.n + a.pIn.y) - a.y };
    if (a.pOut) out.hOut = { x: a.pOut.x, y: normToSpeed(a.n + a.pOut.y) - a.y };
    if (out.hIn || out.hOut) out.manual = true;
    return out;
  });
}

/**
 * A plot curve as it is stored: sorted, auto anchors without slopes, and the
 * rate-space `hIn` / `hOut` / `manual` fallback written alongside every anchor.
 */
export function attachRateHandles(points) {
  const sorted = [...points].sort((a, b) => num(a.x) - num(b.x)).map((p) => {
    const out = { x: num(p.x), y: clamp(num(p.y, 1), SPEED_MIN, SPEED_MAX), tan: TANGENT_SET.has(p.tan) ? p.tan : 'auto' };
    if (out.tan !== 'auto') {
      out.mIn = num(p.mIn);
      out.mOut = num(p.mOut);
      out.kIn = clamp(num(p.kIn, AUTO_HANDLE), 0, 1);
      out.kOut = clamp(num(p.kOut, AUTO_HANDLE), 0, 1);
    }
    return out;
  });
  const rate = speedCurveToRate(sorted);
  return sorted.map((p, i) => {
    const r = rate[i] || {};
    const out = { ...p };
    if (r.hIn) out.hIn = r.hIn;
    if (r.hOut) out.hOut = r.hOut;
    if (r.manual) out.manual = true;
    return out;
  });
}

// The plot's height-to-width ratio the editor draws at (160 / ~356 px): what "in a
// line on screen" means when two slopes have to be judged or averaged off-screen.
export const SPEED_PLOT_ASPECT = 0.45;

/**
 * A rate-space curve rewritten on the plot's scale — what the editor does before the
 * first edit. Unshaped anchors become 'auto' (their corners go smooth); a shaped one
 * keeps its handle dots where the old editor drew them (each control point mapped
 * onto the plot), 'linked' when the two already sit in a line, 'separate' otherwise.
 */
export function speedCurveToPlot(points) {
  if (!Array.isArray(points) || isPlotSpeedCurve(points)) return points;
  const curve = resolveSpeedCurve(points);
  if (!curve) return points;
  const { anchors } = curve;
  const list = anchors.map((a, i) => {
    if (!a.manual) return { x: a.x, y: a.y, tan: 'auto' };
    const n = speedToNorm(a.y);
    const prev = anchors[i - 1];
    const next = anchors[i + 1];
    // dir: +1 out, −1 in. Slope from the control point to the anchor, k of the gap;
    // a near-vertical handle keeps its dot by trading a sliver of reach for slope.
    const side = (h, gap, dir) => {
      if (!h || !(gap > 1e-9)) return null;
      const dx = Math.max(Math.abs(h.x), gap * 1e-4);
      const dn = speedToNorm(a.y + h.y) - n;
      return { m: dir > 0 ? dn / dx : -dn / dx, k: clamp(dx / gap, 0, 1) };
    };
    const o = next ? side(a.hOut, next.x - a.x, 1) : null;
    const ii = prev ? side(a.hIn, a.x - prev.x, -1) : null;
    const angle = (m) => Math.atan(m * SPEED_PLOT_ASPECT);
    let tan = 'linked';
    let mIn;
    let mOut;
    if (o && ii) {
      if (Math.abs(angle(o.m) - angle(ii.m)) < (2 * Math.PI) / 180) {
        mIn = Math.tan((angle(o.m) + angle(ii.m)) / 2) / SPEED_PLOT_ASPECT;
        mOut = mIn;
      } else {
        tan = 'separate';
        mIn = ii.m;
        mOut = o.m;
      }
    } else {
      const one = o || ii;
      mIn = one ? one.m : 0;
      mOut = mIn;
    }
    return { x: a.x, y: a.y, tan, mIn, mOut, kIn: ii ? ii.k : AUTO_HANDLE, kOut: o ? o.k : AUTO_HANDLE };
  });
  return attachRateHandles(list);
}

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
  if (isPlotSpeedCurve(points)) {
    const plot = resolvePlotCurve(points);
    if (plot) speedCurveCache.set(points, plot);
    return plot;
  }

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
  // A plot segment may carry a near-vertical handle (the rate dropping within a
  // frame), where a hair of x is a lot of rate: it is solved to float precision.
  // Rate-space segments keep their tolerance, so their numbers stay what they were.
  const plot = seg.space === 'norm';
  const tol = plot ? 1e-14 : 1e-7;
  for (let i = 0; i < (plot ? 30 : 8); i += 1) {
    const err = cubic(seg.x0, seg.x1, seg.x2, seg.x3, t) - x;
    if (Math.abs(err) < tol) return t;
    const d = cubicDeriv(seg.x0, seg.x1, seg.x2, seg.x3, t);
    if (Math.abs(d) < (plot ? 1e-12 : 1e-7)) break;
    t = clamp(t - err / d, 0, 1);
  }
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < (plot ? 60 : 24); i += 1) {
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
  // A plot curve takes an AUTOMATIC point: it is smooth by construction, and a shaped
  // neighbour keeps its reach as a share of its now-shorter gap.
  if (isPlotSpeedCurve(points)) {
    const list = [...points].sort((a, b) => num(a?.x) - num(b?.x));
    const at = list.findIndex((p, j) => j < list.length - 1 && x > num(p.x) && x < num(list[j + 1].x));
    if (at < 0) return list;
    list.splice(at + 1, 0, { x, y: rate, tan: 'auto' });
    return attachRateHandles(list);
  }
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
  if (curve.space === 'norm') return splitPlotSpeedPoints(points, curve, u);
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

/*
 * splitSpeedPoints for a plot curve. Same promise: each piece is its side of the curve
 * with x stretched back to 0-1, and every instant maps to the source time the uncut
 * clip showed there. Slopes steepen with the stretch (they are per unit of progress);
 * reaches are shares of a gap, so they stay. The cut segment is split by de Casteljau
 * on the plot's scale and the cut becomes a 'linked' point carrying the curve's own
 * tangent. An 'auto' anchor stays automatic only if its piece still works out the
 * same tangent for it — the ones whose neighbours changed are written out as they
 * play now ('linked'), or the pieces would retime.
 */
function splitPlotSpeedPoints(points, curve, u) {
  const { anchors } = curve;
  const sourceFraction = mapTimelineToSource(points, u);
  const s1 = 1 / u;
  const s2 = 1 / (1 - u);
  const place = (a, from, scale, over = {}) => ({
    x: (a.x - from) * scale,
    y: a.y,
    n: a.n,
    tan: a.tan,
    mIn: a.mIn / scale,
    mOut: a.mOut / scale,
    kIn: a.kIn,
    kOut: a.kOut,
    ...over,
  });

  let first;
  let second;
  const at = anchors.findIndex((a) => Math.abs(a.x - u) <= 1e-9);
  if (at > 0 && at < anchors.length - 1) {
    first = anchors.slice(0, at + 1).map((a) => place(a, 0, s1));
    second = anchors.slice(at).map((a) => place(a, u, s2));
  } else {
    const idx = curve.segments.findIndex((sg) => u > sg.x0 && u < sg.x3);
    const seg = curve.segments[idx];
    if (!seg) {
      const y = getSpeedAtTime(points, u);
      return {
        first: attachRateHandles([{ x: 0, y, tan: 'auto' }, { x: 1, y, tan: 'auto' }]),
        second: attachRateHandles([{ x: 0, y, tan: 'auto' }, { x: 1, y, tan: 'auto' }]),
        sourceFraction,
      };
    }
    const { q0, q2, r0, r1, s } = splitSegment(seg, solveSegmentT(seg, u));
    const a = anchors[idx];
    const b = anchors[idx + 1];
    const slope = (p, q) => (Math.abs(q.x - p.x) < 1e-12 ? Math.sign((q.y - p.y) || 1) * 1e6 : (q.y - p.y) / (q.x - p.x));
    const gapA = s.x - a.x;
    const gapB = b.x - s.x;
    const share = (len, gap) => (gap > 1e-12 ? clamp(len / gap, 0, 1) : 0);
    const y = clamp(normToSpeed(s.y), SPEED_MIN, SPEED_MAX);
    const mInCut = slope(r0, s) / s1;
    const mOutCut = slope(s, r1) / s2;
    first = [
      ...anchors.slice(0, idx).map((p) => place(p, 0, s1)),
      place(a, 0, s1, { kOut: share(q0.x - a.x, gapA) }),
      { x: 1, y, n: s.y, tan: 'linked', mIn: mInCut, mOut: mInCut, kIn: share(s.x - r0.x, gapA), kOut: AUTO_HANDLE },
    ];
    second = [
      { x: 0, y, n: s.y, tan: 'linked', mIn: mOutCut, mOut: mOutCut, kIn: AUTO_HANDLE, kOut: share(r1.x - s.x, gapB) },
      place(b, u, s2, { kIn: share(b.x - q2.x, gapB) }),
      ...anchors.slice(idx + 2).map((p) => place(p, u, s2)),
    ];
  }

  const settle = (piece) => {
    piece[0].x = 0;
    piece[piece.length - 1].x = 1;
    const auto = speedAutoSlopes(piece.map((p) => p.x), piece.map((p) => p.n));
    const near = (m, target) => Math.abs(m - target) <= 1e-9 * Math.max(1, Math.abs(target));
    return attachRateHandles(piece.map((p, i) => {
      const out = { x: p.x, y: p.y, tan: p.tan, mIn: p.mIn, mOut: p.mOut, kIn: p.kIn, kOut: p.kOut };
      if (p.tan !== 'auto') return out;
      const inOk = i === 0 || (near(auto[i], p.mIn) && Math.abs(p.kIn - AUTO_HANDLE) < 1e-12);
      const outOk = i === piece.length - 1 || (near(auto[i], p.mOut) && Math.abs(p.kOut - AUTO_HANDLE) < 1e-12);
      if (inOk && outOk) return { x: p.x, y: p.y, tan: 'auto' };
      out.tan = Math.abs(p.mIn - p.mOut) <= 1e-12 ? 'linked' : 'separate';
      return out;
    }));
  };
  return { first: settle(first), second: settle(second), sourceFraction };
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
  if (seg.space === 'norm') return plotSegmentArea(seg, tEnd);
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

// ∫ rate dx over a plot segment: rate = normToSpeed(n(t)) is no polynomial, so
// 4-point Gauss–Legendre on eight sub-steps of every stretch between 1× crossings
// (the axis bends there). A split clip's pieces add up to ~1e-11 of the whole, even
// across a near-vertical handle.
function plotSegmentArea(seg, tEnd) {
  const xAt = (t) => cubic(seg.x0, seg.x1, seg.x2, seg.x3, t);
  if (seg.flat) return (xAt(tEnd) - seg.x0) * normToSpeed(seg.y0);
  const cuts = [0, ...(seg.kinks || []).filter((t) => t < tEnd), tEnd];
  const SUB = 8;
  let sum = 0;
  for (let c = 0; c < cuts.length - 1; c += 1) {
    const step = (cuts[c + 1] - cuts[c]) / SUB;
    for (let s = 0; s < SUB; s += 1) {
      const half = step * 0.5;
      const mid = cuts[c] + (s * step) + half;
      for (const [node, weight] of GAUSS) {
        const t = mid + (half * node);
        sum += weight * half * normToSpeed(cubic(seg.y0, seg.y1, seg.y2, seg.y3, t))
          * cubicDeriv(seg.x0, seg.x1, seg.x2, seg.x3, t);
      }
    }
  }
  return sum;
}

// A point ON a resolved segment, in curve space (y is always a RATE). The editor
// draws with this: under a non-linear axis a cubic no longer maps to a cubic, so the
// picture is sampled from the same segments this module integrates rather than
// re-emitted as a bezier.
export const speedSegmentPoint = (seg, t) => {
  const y = cubic(seg.y0, seg.y1, seg.y2, seg.y3, t);
  return {
    x: cubic(seg.x0, seg.x1, seg.x2, seg.x3, t),
    y: seg.space === 'norm' ? normToSpeed(y) : y,
  };
};

export const getSpeedAtTime = (points, x) => {
  const curve = resolveSpeedCurve(points);
  if (!curve) return 1;
  if (x <= curve.first.x) return curve.first.y;
  if (x >= curve.last.x) return curve.last.y;
  for (const seg of curve.segments) {
    if (x >= seg.x0 && x <= seg.x3) {
      const t = solveSegmentT(seg, x);
      if (seg.linear) return seg.y0 + ((seg.y3 - seg.y0) * t);
      if (seg.space === 'norm') return normToSpeed(cubic(seg.y0, seg.y1, seg.y2, seg.y3, t));
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
  // A plot curve's segments are heights on the axis, which only grows with the rate:
  // the lowest height IS the slowest rate.
  const plot = curve.space === 'norm';
  let min = plot ? curve.first.n : curve.first.y;
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
  if (plot) return Number.isFinite(min) ? normToSpeed(min) : 1;
  return Number.isFinite(min) ? min : 1;
};

export const isFlatSpeed = (points) => {
  const curve = resolveSpeedCurve(points);
  if (!curve) return true;
  // Segments hold rates, or plot heights for a plot curve: compare like with like.
  const first = curve.space === 'norm' ? curve.first.n : curve.first.y;
  // Control points too: a flat pair of anchors with a handle pulled off them is a
  // curve that bulges, and treating it as flat would skip the retiming path.
  return curve.segments.every((seg) => Math.abs(seg.y0 - first) < 1e-6
    && Math.abs(seg.y1 - first) < 1e-6
    && Math.abs(seg.y2 - first) < 1e-6
    && Math.abs(seg.y3 - first) < 1e-6)
    && Math.abs(curve.last.y - curve.first.y) < 1e-6;
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
      // A plot curve's tangent (15.8.20). An auto anchor needs nothing else.
      if (TANGENT_SET.has(point.tan)) {
        clean.tan = point.tan;
        if (point.tan !== 'auto') {
          clean.mIn = clamp(num(point.mIn), -1e6, 1e6);
          clean.mOut = clamp(num(point.mOut), -1e6, 1e6);
          clean.kIn = clamp(num(point.kIn, AUTO_HANDLE), 0, 1);
          clean.kOut = clamp(num(point.kOut, AUTO_HANDLE), 0, 1);
        }
      }
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
