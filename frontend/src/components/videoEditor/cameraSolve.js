/*
 * Camera solve — the pure half.
 *
 * The After Effects "3D Camera Tracker" move, reduced to what this app's 2.5D
 * transform model can actually consume: analyse the WHOLE frame, keep every
 * feature's trajectory, fit the dominant camera motion per frame, segment the
 * trajectories into surfaces that move as one, let the user select some, and
 * turn that selection into a normal motion track.
 *
 * Nothing here touches OpenCV or the decoder: the worker (cameraTracker.js) and
 * the panel both import this module, and the panel must not drag a 10 MB WASM
 * loader into the main bundle. Same split as motionTracking.js ⇄ motionTracker.js.
 *
 * All of it was measured first in html/camera-tracker-lab.html against a
 * synthetic clip with exact ground truth (four planes at known depths plus a
 * subject on its own path): a null built from a selected plane lands 0.68 px
 * mean / 1.8 px max on a 1280 px composition, rotation 0.34°, scale 0.006.
 *
 * COORDINATES. Trajectories travel as SOURCE uv (0..1 on each axis), like every
 * stored motion-track sample, so they survive a proxy swap or a resolution
 * change. Geometry cannot be done in that space — the axes have different
 * scales, so a rotation in uv shears — so every fit converts to analysis pixels
 * first (`toPx`/`toUv` below) and back afterwards. Getting this wrong is
 * invisible on a 1:1 frame and wrong on every other one.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
export const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

export const CAMERA_SOLVE_VERSION = 1;

/* One palette for the plane swatches in the panel and the point marks on the
   canvas — a surface the user clicked in the list has to be the same colour
   over the footage or the two readings of "which points" disagree. */
export const CAMERA_PLANE_COLORS = [
  '#7dd3c0', '#e0a45c', '#8fa4e0', '#e07a7a', '#b58fe0', '#7ec27e', '#d0c07a', '#7ac6d0',
];
export const CAMERA_UNGROUPED_COLOR = '#8d93a3';

/* Mirrored by CAMERA_SOLVE_DEFAULTS' consumer in the panel. Kept deliberately
   small: every knob here is one the lab actually needed to move. */
export const CAMERA_SOLVE_DEFAULTS = {
  analysisWidth: 640,
  maxPoints: 320,
  gridX: 8,
  gridY: 5,
  quality: 0.006,
  minDistance: 7,
  winSize: 21,
  levels: 3,
  fbThreshold: 1,
  ransacPx: 1.5,
  reseedEvery: 6,
  planeThreshold: 1.8,
  maxPlanes: 5,
  minTrackLength: 12,
  // Shot-boundary detection between consecutive frames (see cameraTracker.js):
  // LK survival below this, or survivors agreeing on one similarity below
  // this, or a single-frame step larger than this fraction of the width /
  // this scale change / this rotation, ends the shot and starts a new one.
  cutSurvival: 0.4,
  cutAgree: 0.35,
  cutJump: 0.04,
  cutScale: 0.08,
  cutRotDeg: 3,
};

export function sanitizeCameraSolveOptions(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const d = CAMERA_SOLVE_DEFAULTS;
  return {
    analysisWidth: clamp(Math.round(num(o.analysisWidth, d.analysisWidth)), 320, 1280),
    maxPoints: clamp(Math.round(num(o.maxPoints, d.maxPoints)), 60, 900),
    gridX: clamp(Math.round(num(o.gridX, d.gridX)), 2, 16),
    gridY: clamp(Math.round(num(o.gridY, d.gridY)), 2, 12),
    quality: clamp(num(o.quality, d.quality), 0.001, 0.2),
    minDistance: clamp(Math.round(num(o.minDistance, d.minDistance)), 2, 40),
    winSize: clamp(Math.round(num(o.winSize, d.winSize)) | 1, 9, 41),
    levels: clamp(Math.round(num(o.levels, d.levels)), 1, 5),
    fbThreshold: clamp(num(o.fbThreshold, d.fbThreshold), 0.2, 6),
    ransacPx: clamp(num(o.ransacPx, d.ransacPx), 0.4, 8),
    reseedEvery: clamp(Math.round(num(o.reseedEvery, d.reseedEvery)), 1, 60),
    planeThreshold: clamp(num(o.planeThreshold, d.planeThreshold), 0.4, 8),
    maxPlanes: clamp(Math.round(num(o.maxPlanes, d.maxPlanes)), 1, 8),
    minTrackLength: clamp(Math.round(num(o.minTrackLength, d.minTrackLength)), 2, 240),
    cutSurvival: clamp(num(o.cutSurvival, d.cutSurvival), 0, 1),
    cutAgree: clamp(num(o.cutAgree, d.cutAgree), 0, 1),
    cutJump: clamp(num(o.cutJump, d.cutJump), 0.005, 1),
    cutScale: clamp(num(o.cutScale, d.cutScale), 0.01, 1),
    cutRotDeg: clamp(num(o.cutRotDeg, d.cutRotDeg), 0.2, 45),
  };
}

/* ── Trajectory access ─────────────────────────────────────────────────────
   A trajectory is contiguous by construction: it is born on one frame, tracked
   until LK loses it, and never resumes. That is what makes the index maths here
   a subtraction rather than a search. */
export const trajEnd = (tr) => tr.f0 + tr.xs.length - 1;
export const trajLen = (tr) => tr.xs.length;
export function trajAt(tr, f) {
  const i = f - tr.f0;
  return (i >= 0 && i < tr.xs.length) ? [tr.xs[i], tr.ys[i]] : null;
}

/* ── Similarity geometry ──────────────────────────────────────────────────
   Position + uniform scale + rotation: four degrees of freedom, exactly the
   channels a layer can inherit here. */
export const posePt = (p, x, y) => {
  const c = Math.cos(p.th) * p.s;
  const s = Math.sin(p.th) * p.s;
  return [c * x - s * y + p.tx, s * x + c * y + p.ty];
};
export const poseInv = (p, x, y) => {
  const c = Math.cos(p.th);
  const s = Math.sin(p.th);
  const dx = (x - p.tx) / p.s;
  const dy = (y - p.ty) / p.s;
  return [c * dx + s * dy, -s * dx + c * dy];
};
export const residTo = (m, p, q) => {
  const c = Math.cos(m.th) * m.s;
  const s = Math.sin(m.th) * m.s;
  return Math.hypot(c * p[0] - s * p[1] + m.tx - q[0], s * p[0] + c * p[1] + m.ty - q[1]);
};

/** Closed-form Umeyama similarity (uniform scale, no reflection). */
export function fitSimilarity(ref, cur, active) {
  const idx = active || ref.map((_, i) => i);
  const n = idx.length;
  if (!n) return null;
  if (n < 2) {
    const i = idx[0];
    return { s: 1, th: 0, tx: cur[i][0] - ref[i][0], ty: cur[i][1] - ref[i][1], n, med: 0, idx };
  }
  let mpx = 0; let mpy = 0; let mqx = 0; let mqy = 0;
  for (const i of idx) { mpx += ref[i][0]; mpy += ref[i][1]; mqx += cur[i][0]; mqy += cur[i][1]; }
  mpx /= n; mpy /= n; mqx /= n; mqy /= n;
  let a = 0; let b = 0; let sp = 0;
  for (const i of idx) {
    const px = ref[i][0] - mpx; const py = ref[i][1] - mpy;
    const qx = cur[i][0] - mqx; const qy = cur[i][1] - mqy;
    a += px * qx + py * qy;
    b += px * qy - py * qx;
    sp += px * px + py * py;
  }
  if (sp < 1e-9) return { s: 1, th: 0, tx: mqx - mpx, ty: mqy - mpy, n, med: 0, idx };
  const th = Math.atan2(b, a);
  const s = clamp(Math.hypot(a, b) / sp, 1e-3, 1e3);
  const c = Math.cos(th) * s;
  const si = Math.sin(th) * s;
  return { s, th, tx: mqx - (c * mpx - si * mpy), ty: mqy - (si * mpx + c * mpy), n, med: 0, idx };
}

/** Two correspondences determine a similarity exactly (complex division). */
export function simFrom2(p1, p2, q1, q2) {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const den = dx * dx + dy * dy;
  if (den < 4) return null;                       // too close together to be stable
  const ex = q2[0] - q1[0];
  const ey = q2[1] - q1[1];
  const a = (ex * dx + ey * dy) / den;
  const b = (ey * dx - ex * dy) / den;
  const s = Math.hypot(a, b);
  if (!(s > 1e-3 && s < 1e3)) return null;
  return { s, th: Math.atan2(b, a), tx: q1[0] - (a * p1[0] - b * p1[1]), ty: q1[1] - (b * p1[0] + a * p1[1]) };
}

/** Trimmed least squares — for sets whose outlier fraction is already small. */
export function robustFit(ref, cur, rounds = 2) {
  let idx = ref.map((_, i) => i);
  let fit = fitSimilarity(ref, cur, idx);
  if (!fit) return null;
  for (let r = 0; r < rounds && idx.length >= 6; r += 1) {
    const res = idx.map((i) => residTo(fit, ref[i], cur[i]));
    const med = median(res);
    const thr = Math.max(1.0, 2.5 * med);
    const keep = idx.filter((_, k) => res[k] <= thr);
    if (keep.length < 4 || keep.length === idx.length) { fit.med = med; break; }
    idx = keep;
    fit = fitSimilarity(ref, cur, idx);
    fit.med = median(idx.map((i) => residTo(fit, ref[i], cur[i])));
  }
  fit.idx = idx;
  fit.n = idx.length;
  if (!Number.isFinite(fit.med)) fit.med = 0;
  return fit;
}

/**
 * RANSAC similarity. The camera fit needs this rather than trimming: a moving
 * subject can own a third of the points and agree with itself perfectly, which
 * is precisely the case a least-squares fit with outlier trimming walks into.
 */
export function ransacSim(ref, cur, thr, iters, rnd) {
  const n = ref.length;
  if (n < 2) return null;
  if (n < 4) {
    const fit = fitSimilarity(ref, cur);
    return fit ? { fit, mask: ref.map(() => true), inliers: n, med: 0 } : null;
  }
  let best = null;
  for (let it = 0; it < iters; it += 1) {
    const i = Math.floor(rnd() * n);
    const j = Math.floor(rnd() * n);
    if (i === j) continue;
    const m = simFrom2(ref[i], ref[j], cur[i], cur[j]);
    if (!m || m.s < 0.2 || m.s > 5) continue;
    let cnt = 0;
    for (let k = 0; k < n; k += 1) if (residTo(m, ref[k], cur[k]) < thr) cnt += 1;
    if (!best || cnt > best.cnt) best = { m, cnt };
    if (best.cnt > n * 0.92) break;
  }
  if (!best) return null;
  let fit = best.m;
  for (let pass = 0; pass < 2; pass += 1) {
    const idx = [];
    for (let k = 0; k < n; k += 1) if (residTo(fit, ref[k], cur[k]) < thr) idx.push(k);
    if (idx.length < 3) break;
    fit = fitSimilarity(ref, cur, idx);
  }
  const mask = [];
  const res = [];
  for (let k = 0; k < n; k += 1) {
    const r = residTo(fit, ref[k], cur[k]);
    mask.push(r < thr);
    if (r < thr) res.push(r);
  }
  return { fit, mask, inliers: res.length, med: median(res) };
}

/* ── Analysis-pixel space ──────────────────────────────────────────────────
   Trajectories are stored in source uv; fits happen in analysis pixels, where
   the axes share a scale. */
export function pxMappers(solve) {
  const aw = Math.max(1, num(solve?.analysis?.w, 640));
  const ah = Math.max(1, num(solve?.analysis?.h, 360));
  return {
    aw,
    ah,
    toPx: (p) => [p[0] * aw, p[1] * ah],
    toUv: (p) => [p[0] / aw, p[1] / ah],
    atPx: (tr, f) => { const p = trajAt(tr, f); return p ? [p[0] * aw, p[1] * ah] : null; },
  };
}

/* ── Motion segmentation: "planes" ─────────────────────────────────────────
   One similarity describes ONE surface. Under a translating camera each depth
   moves at its own screen rate and a moving subject at another, and the
   per-frame camera fit can only call the minority ones outliers. Segmenting
   them explicitly is what makes "select a surface" possible at all — the
   interaction AE gets from a real 3D solve.

   Measured: selecting a segmented plane gives a null at 0.68 px, while taking
   every point that merely STARTED on that surface gives 77% low-confidence
   frames, because an occluder drags some of them off it. */

export function bestRefFrame(members, F) {
  const cnt = new Int32Array(F);
  for (const tr of members) {
    const b = Math.min(F - 1, trajEnd(tr));
    for (let f = Math.max(0, tr.f0); f <= b; f += 1) cnt[f] += 1;
  }
  let bi = 0;
  for (let f = 1; f < F; f += 1) if (cnt[f] > cnt[bi]) bi = f;
  return bi;
}

/** Per-frame fit over the group, then drop members whose average residual across
 *  the clip is too high. A two-frame model is enough to FIND a group; only time
 *  can confirm one. */
export function verifyGroup(members, F, thr, at) {
  let cur = members;
  for (let pass = 0; pass < 2 && cur.length >= 3; pass += 1) {
    const refF = bestRefFrame(cur, F);
    const refPts = cur.map((tr) => at(tr, refF));
    const sum = new Float64Array(cur.length);
    const cnt = new Int32Array(cur.length);
    const step = Math.max(1, Math.floor(F / 60));
    for (let f = 0; f < F; f += step) {
      const ref = []; const now = []; const who = [];
      for (let i = 0; i < cur.length; i += 1) {
        if (!refPts[i]) continue;
        const p = at(cur[i], f);
        if (!p) continue;
        ref.push(refPts[i]); now.push(p); who.push(i);
      }
      if (ref.length < 3) continue;
      const fit = robustFit(ref, now);
      if (!fit) continue;
      for (let k = 0; k < ref.length; k += 1) {
        sum[who[k]] += residTo(fit, ref[k], now[k]);
        cnt[who[k]] += 1;
      }
    }
    const keep = [];
    for (let i = 0; i < cur.length; i += 1) {
      const m = cnt[i] ? sum[i] / cnt[i] : Infinity;
      cur[i].groupResid = m;
      if (m <= thr) keep.push(cur[i]);
    }
    if (keep.length === cur.length) { cur = keep; break; }
    cur = keep;
  }
  return cur;
}

/**
 * Everything in `pool` that agrees with this group's own motion, tested at one
 * reference frame across the whole clip.
 *
 * Without this pass the segmenter splits ONE rigid wall into several "planes":
 * a model fitted from two points is only locally accurate, so the far side of
 * the same surface reads as something else. Called at two reference frames
 * because a candidate has to be alive at the reference to be testable at all.
 */
export function absorbIntoGroup(members, pool, F, thr, refF, at) {
  const set = new Set(members);
  const refPts = members.map((tr) => at(tr, refF));
  if (refPts.filter(Boolean).length < 3) return members;
  const step = Math.max(1, Math.floor(F / 40));
  const sum = new Map();
  const cnt = new Map();
  for (let f = 0; f < F; f += step) {
    const ref = []; const now = [];
    for (let i = 0; i < members.length; i += 1) {
      if (!refPts[i]) continue;
      const p = at(members[i], f);
      if (!p) continue;
      ref.push(refPts[i]); now.push(p);
    }
    if (ref.length < 3) continue;
    const fit = robustFit(ref, now);
    if (!fit) continue;
    for (const tr of pool) {
      if (set.has(tr)) continue;
      const a = at(tr, refF);
      const b = at(tr, f);
      if (!a || !b) continue;
      const r = residTo(fit, a, b);
      sum.set(tr, (sum.get(tr) || 0) + r);
      cnt.set(tr, (cnt.get(tr) || 0) + 1);
    }
  }
  const out = [...members];
  for (const tr of pool) {
    const n = cnt.get(tr) || 0;
    if (n >= 3 && sum.get(tr) / n <= thr) { tr.groupResid = sum.get(tr) / n; out.push(tr); }
  }
  return out;
}

/** Deterministic PRNG — a solve that reshuffles its planes on every re-run would
 *  make the plane list unusable as a stable thing to click. */
const lcg = (seed) => () => {
  let s = seed;
  s = (s * 1664525 + 1013904223) >>> 0;
  seed = s;
  return s / 4294967296;
};

export function segmentPlanes({ trajs, F, aw, ah, threshold, maxPlanes, minLength }) {
  const at = (tr, f) => { const p = trajAt(tr, f); return p ? [p[0] * aw, p[1] * ah] : null; };
  const rnd = lcg(4242);
  let remaining = trajs.filter((tr) => trajLen(tr) >= Math.max(6, minLength));
  const groups = [];
  const minSpan = Math.max(4, Math.floor(F * 0.15));
  // A similarity from two points is only as good as their separation: at a few
  // pixels apart the rotation and scale it implies are pure LK noise.
  const minBase = Math.max(24, aw * 0.12);
  for (let g = 0; g < maxPlanes && remaining.length >= 5; g += 1) {
    let best = null;
    for (let it = 0; it < 260; it += 1) {
      const fa = Math.floor(rnd() * F);
      const fb = Math.floor(rnd() * F);
      if (Math.abs(fa - fb) < minSpan) continue;
      const alive = remaining.filter((tr) => trajAt(tr, fa) && trajAt(tr, fb));
      if (alive.length < 5) continue;
      const i = Math.floor(rnd() * alive.length);
      const j = Math.floor(rnd() * alive.length);
      if (i === j) continue;
      const pa = at(alive[i], fa);
      const pb = at(alive[j], fa);
      if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) < minBase) continue;
      const m = simFrom2(pa, pb, at(alive[i], fb), at(alive[j], fb));
      if (!m || m.s < 0.2 || m.s > 5) continue;
      let cnt = 0;
      for (const tr of alive) if (residTo(m, at(tr, fa), at(tr, fb)) < threshold) cnt += 1;
      if (!best || cnt > best.cnt) best = { cnt, fa, fb, m, alive };
    }
    if (!best || best.cnt < 5) break;
    const seed = best.alive.filter((tr) => residTo(best.m, at(tr, best.fa), at(tr, best.fb)) < threshold);
    let members = verifyGroup(seed, F, threshold, at);
    if (members.length >= 4) {
      const r1 = bestRefFrame(members, F);
      members = absorbIntoGroup(members, remaining.filter((tr) => !members.includes(tr)), F, threshold, r1, at);
      const late = clamp(Math.round(r1 + F * 0.35), 0, F - 1);
      if (late !== r1) {
        members = absorbIntoGroup(members, remaining.filter((tr) => !members.includes(tr)), F, threshold, late, at);
      }
    }
    if (members.length < 4) {
      // Nothing coherent here — drop the seed so the search cannot loop on it.
      const dead = new Set(seed);
      remaining = remaining.filter((tr) => !dead.has(tr));
      continue;
    }
    const set = new Set(members);
    groups.push({ members, refFrame: bestRefFrame(members, F) });
    remaining = remaining.filter((tr) => !set.has(tr));
  }
  groups.sort((a, b) => b.members.length - a.members.length);
  groups.forEach((grp, i) => {
    grp.index = i;
    grp.size = grp.members.length;
    grp.resid = median(grp.members.map((tr) => tr.groupResid || 0));
    grp.inlFrac = mean(grp.members.map((tr) => tr.inlFrac || 0));
    for (const tr of grp.members) tr.group = i;
  });
  return groups;
}

/**
 * How far each plane DEPARTS from the dominant one, over time.
 *
 * For static surfaces under a translating camera every departure is the same
 * vector process scaled by the difference in inverse depth — so they are
 * collinear, and the scalar is a relative depth. A subject moving on its own
 * path is not collinear with them. That difference is the only handle a 2D
 * solve has on "another depth" versus "another object", and the size of the
 * departure is what says whether a shot has parallax at all: measured 52.5 px
 * handheld against 2.2 px on a tripod, same scene.
 */
export function analysePlanes({ groups, trajs, F, aw, ah }) {
  if (!groups.length) return { series: [], parallaxPx: 0, refFrame: 0 };
  const at = (tr, f) => { const p = trajAt(tr, f); return p ? [p[0] * aw, p[1] * ah] : null; };
  const refF = bestRefFrame(trajs.filter((tr) => trajLen(tr) >= 8), F);
  const dom = groups[0];
  const domMembers = dom.members.filter((tr) => trajAt(tr, refF));
  const domRef = domMembers.map((tr) => at(tr, refF));
  const domPose = new Array(F);
  for (let f = 0; f < F; f += 1) {
    const ref = []; const now = [];
    for (let i = 0; i < domMembers.length; i += 1) {
      const p = at(domMembers[i], f);
      if (!p) continue;
      ref.push(domRef[i]); now.push(p);
    }
    domPose[f] = ref.length >= 3 ? robustFit(ref, now) : null;
  }
  const series = groups.map((g) => {
    // MEDIAN of per-member departures, not the departure of the centroid: which
    // members are alive changes frame to frame, and a centroid over a shifting
    // subset moves on its own — that reads as parallax that is not there.
    const mem = g.members.filter((tr) => trajAt(tr, refF));
    const e = new Array(F).fill(null);
    for (let f = 0; f < F; f += 1) {
      const dp = domPose[f];
      if (!dp) continue;
      const dx = []; const dy = [];
      for (const tr of mem) {
        const p = at(tr, f);
        if (!p) continue;
        const a = at(tr, refF);
        const pred = posePt(dp, a[0], a[1]);
        dx.push(p[0] - pred[0]);
        dy.push(p[1] - pred[1]);
      }
      if (dx.length < 2) continue;
      e[f] = [median(dx), median(dy)];
    }
    const mag = e.filter(Boolean).map((v) => Math.hypot(v[0], v[1]));
    return {
      index: g.index,
      e,
      valid: mem.length >= 3 && mag.length >= Math.max(3, F * 0.2),
      departure: mag.length ? median(mag) : 0,
    };
  });
  let base = null;
  for (let i = 1; i < series.length; i += 1) {
    if (series[i].valid && (!base || series[i].departure > base.departure)) base = series[i];
  }
  for (const s of series) {
    if (!base || s.index === base.index || s.index === 0) {
      s.k = s.index === 0 ? 0 : 1;
      s.r2 = 1;
      continue;
    }
    let numr = 0; let den = 0;
    for (let f = 0; f < F; f += 1) {
      const a = s.e[f]; const b = base.e[f];
      if (!a || !b) continue;
      numr += a[0] * b[0] + a[1] * b[1];
      den += b[0] * b[0] + b[1] * b[1];
    }
    const k = den > 1e-9 ? numr / den : 0;
    let sse = 0; let sst = 0;
    for (let f = 0; f < F; f += 1) {
      const a = s.e[f]; const b = base.e[f];
      if (!a || !b) continue;
      sse += (a[0] - k * b[0]) ** 2 + (a[1] - k * b[1]) ** 2;
      sst += a[0] * a[0] + a[1] * a[1];
    }
    s.k = k;
    s.r2 = sst > 1e-9 ? 1 - sse / sst : 0;
  }
  for (const s of series) delete s.e;              // transport: the series itself is debug
  const valid = series.slice(1).filter((s) => s.valid);
  return { series, parallaxPx: valid.length ? Math.max(...valid.map((s) => s.departure)) : 0, refFrame: refF };
}

/* ── Selection ─────────────────────────────────────────────────────────────*/

/** Points alive at `frame`, in source uv, for the canvas overlay. */
export function cloudPointsAt(solve, frame, { minLength = 0 } = {}) {
  if (!solve?.trajs) return [];
  const out = [];
  for (const tr of solve.trajs) {
    if (trajLen(tr) < minLength) continue;
    const p = trajAt(tr, frame);
    if (!p) continue;
    out.push({ id: tr.id, u: p[0], v: p[1], group: tr.group, cls: tr.cls });
  }
  return out;
}

/** The k nearest points at `frame`. A single point cannot seed a similarity —
 *  two is the minimum — so "select the surface under this point" has to start
 *  from a neighbourhood and let the grow pass throw back whatever is on
 *  something else. */
export function neighboursOf(solve, tr, frame, k = 14, minLength = 0) {
  const p = trajAt(tr, frame);
  if (!p) return [tr];
  return solve.trajs
    .map((t) => {
      if (trajLen(t) < minLength) return null;
      const q = trajAt(t, frame);
      return q ? { t, d: Math.hypot(q[0] - p[0], q[1] - p[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.d - b.d)
    .slice(0, k)
    .map((x) => x.t);
}

/**
 * Grow a selection to every point that moves as one surface with it —
 * membership decided by agreement with the selection's OWN per-frame
 * similarity, over the whole clip rather than a single frame.
 */
export function growSelection({ solve, ids, threshold, minLength = 0 }) {
  const F = solve.frames;
  const { aw, ah } = pxMappers(solve);
  const at = (tr, f) => { const p = trajAt(tr, f); return p ? [p[0] * aw, p[1] * ah] : null; };
  const byId = solve.byId || new Map(solve.trajs.map((t) => [t.id, t]));
  let members = [...ids].map((id) => byId.get(id)).filter(Boolean);
  if (!members.length) return [];
  const pool = solve.trajs.filter((tr) => trajLen(tr) >= minLength);
  for (let round = 0; round < 2; round += 1) {
    const refF = bestRefFrame(members, F);
    const refPts = members.map((tr) => at(tr, refF));
    const step = Math.max(1, Math.floor(F / 40));
    const sum = new Map();
    const cnt = new Map();
    for (let f = 0; f < F; f += step) {
      const ref = []; const now = [];
      for (let i = 0; i < members.length; i += 1) {
        if (!refPts[i]) continue;
        const p = at(members[i], f);
        if (!p) continue;
        ref.push(refPts[i]); now.push(p);
      }
      if (ref.length < 2) continue;
      const fit = robustFit(ref, now);
      if (!fit) continue;
      for (const tr of pool) {
        const a = at(tr, refF);
        const b = at(tr, f);
        if (!a || !b) continue;
        const r = residTo(fit, a, b);
        sum.set(tr.id, (sum.get(tr.id) || 0) + r);
        cnt.set(tr.id, (cnt.get(tr.id) || 0) + 1);
      }
    }
    const next = pool.filter((tr) => {
      const n = cnt.get(tr.id) || 0;
      return n >= 3 && (sum.get(tr.id) / n) <= threshold;
    });
    if (next.length <= members.length) { members = next.length ? next : members; break; }
    members = next;
  }
  return members.map((tr) => tr.id);
}

/**
 * Does this selection move as ONE surface? Measured the way the null's own fit
 * will be, and reported in SOURCE pixels so the number means something to a
 * user. This is the only warning available on real footage — there is no ground
 * truth there — and it is the difference between a clean null and one built on
 * points that a passing object dragged off the surface.
 */
export function selectionCoherence({ solve, ids }) {
  const byId = solve.byId || new Map(solve.trajs.map((t) => [t.id, t]));
  const members = [...ids].map((id) => byId.get(id)).filter(Boolean);
  if (members.length < 3) return null;
  const F = solve.frames;
  const { aw, ah } = pxMappers(solve);
  const at = (tr, f) => { const p = trajAt(tr, f); return p ? [p[0] * aw, p[1] * ah] : null; };
  const refF = bestRefFrame(members, F);
  const refPts = members.map((tr) => at(tr, refF));
  const step = Math.max(1, Math.floor(F / 24));
  const meds = [];
  for (let f = 0; f < F; f += step) {
    const ref = []; const now = [];
    for (let i = 0; i < members.length; i += 1) {
      if (!refPts[i]) continue;
      const p = at(members[i], f);
      if (!p) continue;
      ref.push(refPts[i]); now.push(p);
    }
    if (ref.length < 3) continue;
    const fit = robustFit(ref, now);
    if (fit) meds.push(median(ref.map((r, i) => residTo(fit, r, now[i]))));
  }
  if (!meds.length) return null;
  // Analysis px → source px: what the user sees quoted next to their footage.
  const scale = num(solve.sourceWidth, aw) / aw;
  return median(meds) * scale;
}

/* ── A selection becomes a track ───────────────────────────────────────────*/

/**
 * Fit the selection's motion, frame by frame, against its own reference frame.
 * Identity at the reference by construction — which is exactly the stored track
 * contract (a track is identity at refTime, and where the follower sits at that
 * frame IS the offset), so the result needs no offset fields.
 *
 * Points born after the reference frame are ADOPTED: their position is pushed
 * back through the pose at the frame they appear, the same way the solve anchors
 * re-seeded features. Without it a selection whose points churn — anything
 * small, spinning or partly occluded — loses support fast, measured as a null
 * that drifted 8.9 px once only the original survivors counted.
 */
/**
 * Which frame a null should be identity at.
 *
 * The playhead, when the selection actually exists there — that is what a user
 * means by "make a null here", and it keeps the null's placement predictable.
 * But on real footage a surface's features live for a window, not the whole
 * clip: measured on a 14 s handheld shot, a solved plane's points were all dead
 * by the time the playhead sat a third of the way in, and building from the
 * playhead simply failed. Falling back to the frame that surface is best
 * supported on always produces the null the user asked for; the adoption pass in
 * fitNullPoses then extends it outward from there.
 */
export function nullRefFrameFor({ solve, ids, preferredFrame }) {
  const byId = solve.byId || new Map(solve.trajs.map((t) => [t.id, t]));
  const members = [...ids].map((id) => byId.get(id)).filter(Boolean);
  if (!members.length) return null;
  const f = clamp(Math.round(num(preferredFrame, 0)), 0, solve.frames - 1);
  if (members.some((tr) => trajAt(tr, f))) return f;
  const best = bestRefFrame(members, solve.frames);
  return members.some((tr) => trajAt(tr, best)) ? best : null;
}

export function fitNullPoses({ solve, ids, refFrame }) {
  const F = solve.frames;
  const { aw, ah } = pxMappers(solve);
  const at = (tr, f) => { const p = trajAt(tr, f); return p ? [p[0] * aw, p[1] * ah] : null; };
  const byId = solve.byId || new Map(solve.trajs.map((t) => [t.id, t]));
  const members = [...ids].map((id) => byId.get(id)).filter(Boolean);
  const seed = members.map((tr) => at(tr, refFrame));
  if (!seed.some(Boolean)) return null;

  const live = seed.filter(Boolean);
  const anchor = [mean(live.map((p) => p[0])), mean(live.map((p) => p[1]))];
  const poses = new Array(F).fill(null);
  const refPos = seed.slice();

  const runPass = (from, to, step) => {
    let last = { s: 1, th: 0 };
    for (let f = from; step > 0 ? f <= to : f >= to; f += step) {
      const ref = []; const now = [];
      for (let i = 0; i < members.length; i += 1) {
        if (!refPos[i]) continue;
        const p = at(members[i], f);
        if (!p) continue;
        ref.push(refPos[i]); now.push(p);
      }
      if (!ref.length) continue;
      let fit;
      if (ref.length >= 3) {
        fit = robustFit(ref, now);
        if (fit) last = { s: fit.s, th: fit.th };
      } else {
        // Two points determine a similarity EXACTLY, so they also transmit their
        // own noise into scale and rotation with no averaging — measured as
        // scale spikes wherever a selection thins out. Translate on what is
        // left and carry the last well-supported scale/rotation.
        let dx = 0; let dy = 0;
        const c = Math.cos(last.th) * last.s;
        const si = Math.sin(last.th) * last.s;
        for (let i = 0; i < ref.length; i += 1) {
          dx += now[i][0] - (c * ref[i][0] - si * ref[i][1]);
          dy += now[i][1] - (si * ref[i][0] + c * ref[i][1]);
        }
        fit = { s: last.s, th: last.th, tx: dx / ref.length, ty: dy / ref.length, med: 0, thin: true };
      }
      if (!fit) continue;
      fit.n = ref.length;
      // Leverage: how far the anchor sits OUTSIDE the points still holding it,
      // in units of their own spread. Inside the cloud a coherent error moves
      // the anchor by about that error; far outside, the same rotation or scale
      // error is multiplied by the distance.
      const cx = mean(ref.map((p) => p[0]));
      const cy = mean(ref.map((p) => p[1]));
      const spread = Math.sqrt(mean(ref.map((p) => (p[0] - cx) ** 2 + (p[1] - cy) ** 2)));
      fit.lev = Math.hypot(anchor[0] - cx, anchor[1] - cy) / Math.max(1e-6, spread);
      poses[f] = fit;
      for (let i = 0; i < members.length; i += 1) {
        if (refPos[i]) continue;
        const p = at(members[i], f);
        if (!p) continue;
        refPos[i] = poseInv(fit, p[0], p[1]);
      }
    }
  };
  runPass(refFrame, F - 1, 1);
  runPass(refFrame, 0, -1);

  return { poses, anchor, members: members.map((tr) => tr.id) };
}

/**
 * Confidence, and the three things measurement said it has to be made of:
 *
 *   support   n/8, NOT n/(points you selected). A similarity has four degrees of
 *             freedom and eight well-spread points determine it. Dividing by the
 *             selection size reported a plane accurate to 0.8 px as
 *             low-confidence for 67% of the shot, purely because ordinary
 *             feature churn had halved the count — a warning that fires on
 *             healthy tracking is one users learn to ignore.
 *   leverage  the anchor extrapolated outside its remaining support. On a
 *             failing tail this read 0.76 against 0.06 on good frames.
 *   residual  the fit's own disagreement, which is what actually catches a
 *             collapsing selection: it drove those same frames to 0 while
 *             support alone still looked like 45%.
 */
function poseConfidence(p) {
  const support = clamp01(p.n / 8);
  const levTerm = clamp01(1.25 - 0.5 * (p.lev || 0));
  const resid = 1 - clamp01(((p.med || 0) - 0.3) / 2.4);
  return clamp01(support * levTerm * resid);
}

/**
 * Poses → stored samples: `[tSource, cx, cy, scale, rotDeg, conf]`, source
 * seconds, normalised to the source frame. Byte-identical in shape to what the
 * region tracker emits, which is the whole point — a camera-tracked null is an
 * ordinary motion-track follower and needs no new render path.
 */
export function nullSamplesFrom({ solve, poses, anchor }) {
  const { aw, ah } = pxMappers(solve);
  const fps = Math.max(1, num(solve.fps, 30));
  const t0 = num(solve.startTime, 0);
  const out = [];
  for (let f = 0; f < solve.frames; f += 1) {
    const p = poses[f];
    if (!p) continue;
    const c = posePt(p, anchor[0], anchor[1]);
    out.push([
      Number((t0 + f / fps).toFixed(4)),
      Number((c[0] / aw).toFixed(5)),
      Number((c[1] / ah).toFixed(5)),
      Number(p.s.toFixed(5)),
      Number(((p.th * 180) / Math.PI).toFixed(4)),
      Number(poseConfidence(p).toFixed(3)),
    ]);
  }
  return out;
}

/** The selection's bounding box at the reference frame, in source uv — what the
 *  stored track shows as its region (the overlay draws a box from it). */
export function nullRegionFrom({ solve, ids, refFrame }) {
  const byId = solve.byId || new Map(solve.trajs.map((t) => [t.id, t]));
  const pts = [...ids].map((id) => trajAt(byId.get(id) || {}, refFrame)).filter(Boolean);
  if (!pts.length) return { x: 0.45, y: 0.45, w: 0.1, h: 0.1 };
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const pad = 0.012;
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  const x1 = Math.max(...xs) + pad;
  const y1 = Math.max(...ys) + pad;
  return {
    x: Number(x0.toFixed(4)),
    y: Number(y0.toFixed(4)),
    w: Number(Math.max(0.01, x1 - x0).toFixed(4)),
    h: Number(Math.max(0.01, y1 - y0).toFixed(4)),
  };
}

/** Rebuild the id → trajectory map after a structured-clone across the worker
 *  boundary (Maps survive, but the solve is assembled fresh on arrival). */
export function indexSolve(solve) {
  if (!solve?.trajs) return solve;
  solve.byId = new Map(solve.trajs.map((t) => [t.id, t]));
  return solve;
}
