/*
 * OBJECT STABILISER — temporal coherence for the geometry programs.
 *
 * WHY THIS EXISTS. objectExtract.js solves each frame from scratch and carries
 * nothing between them, so on VIDEO the marks boil: they jump, pop in and out,
 * and the link web rewires wholesale every frame even when the picture barely
 * moved. Decoded in the html/object-stability-lab.html lab (since removed), which
 * ran the shipped path and this one side by side from the same pixels and measured
 * the difference; tests/object-effects/verify_stabilise.mjs is the gate now.
 *
 * FOUR CHURN SOURCES, and where each is answered:
 *
 *   1 PER-FRAME NORMALISATION — extract divides every gradient by maxMag, the
 *     single strongest edge IN THAT FRAME, so a highlight or a blink rescales
 *     the whole field at once.        → objectExtract.js, the norm EMA
 *   2 WINNER-TAKE-ALL CELLS — a point is its cell's argmax pixel, a step
 *     function that flips to a neighbour on any sub-pixel change.
 *                                     → objectExtract.js, the cell centroid
 *   3 HARD RANK CUT — sort by strength, truncate at the budget, so every point
 *     near the boundary pops in and out every frame. THE DOMINANT ONE.
 *                                     → here: incumbency + hysteresis
 *   4 NO CORRESPONDENCE — points are never matched frame to frame, and hero
 *     marks and label numbers are then chosen by RANK INDEX on top of that.
 *                                     → here: identity, matching, easing
 *
 * ONE DIAL. The panel exposes a single Stabilise 0–100%, and STAB_OPTS below
 * maps it onto all of it. At 0 the caller skips this module entirely and the
 * drawing is bit-for-bit the pre-10.9.77 output; at 100 it is the lab's setting.
 *
 * STILLS NEVER COME HERE. A still has no temporal anything to fix, and its plate
 * is drawn once for the life of the project — running a stabiliser over it would
 * turn a free draw into a per-frame one for no picture at all.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

/**
 * The single Stabilise dial → every knob the lab exposes separately.
 * s = 0..1. At s→0 each one degrades to its shipped value, so the dial is
 * continuous rather than a switch with a cliff at the bottom.
 */
export function stabOptions(stabilisePct) {
  const s = clamp((stabilisePct ?? 0) / 100, 0, 1);
  return {
    s,
    // 1 · how hard the gradient normaliser is damped (1 = this frame's max)
    normEase: lerp(1, 0.12, s),
    // 2 · argmax → magnitude-weighted cell centroid
    centroid: s,
    // 3 · how far below the entry bar an incumbent may sink and still hold
    hysteresis: 0.55 * s,
    coastFrames: Math.round(8 * s),
    // 4 · correspondence
    matchRadius: 4,                 // % of the analysis long edge
    posEase: lerp(1, 0.22, s),
    fadeFrames: Math.max(1, Math.round(1 + 9 * s)),
  };
}

export function createStabilizer() {
  return { live: [], nextId: 0, sig: null, maxStep: 0 };
}

/* Shortest-arc ease for the contour angle. A raw lerp across ±π spins the mark
   the long way round, which reads as a mark that flips rather than turns. */
function easeAngle(a, b, t) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

function sampleMag(mag, w, h, x, y) {
  const xi = clamp(Math.round(x), 0, w - 1);
  const yi = clamp(Math.round(y), 0, h - 1);
  return mag[yi * w + xi];
}

/**
 * Advance one solve.
 *
 *   S     the instance's stabiliser state (createStabilizer)
 *   ex    this frame's extraction — needs cand (the UNCUT pool), mag, aw, ah,
 *         budget and threshold
 *   o     stabOptions() output
 *   snap  true on the first solve after a discontinuity (a seek, a quality-rung
 *         change, a new clip): take the candidates as they are, at full alpha,
 *         so the frame is exactly what the shipped path would have drawn and the
 *         easing starts from there. Without this, a range render would open on a
 *         few frames of points converging out of nowhere.
 *
 * Returns the live set. Points carry { id, x, y, u, v, hu, hv, m, ms, a, w,
 * alpha } — hu/hv are the BIRTH uv the per-node hash is keyed to, so an easing
 * point keeps the shape and jitter it was born with.
 */
export function stabilize(S, ex, o, snap = false) {
  const {
    cand, mag, aw, ah, budget, threshold,
  } = ex;

  if (snap || !S.live.length) {
    S.live = [];
    const take = Math.min(budget, cand.length);
    for (let i = 0; i < take; i++) {
      const c = cand[i];
      S.live.push({
        id: S.nextId++, x: c.x, y: c.y, u: c.u, v: c.v, hu: c.u, hv: c.v,
        m: c.m, ms: c.m, a: c.a, w: c.w, miss: 0, dying: false, alpha: 1,
      });
    }
    S.maxStep = 0;
    return S.live;
  }

  const R = (o.matchRadius / 100) * Math.max(aw, ah);
  const R2 = R * R;
  const cell = Math.max(2, R);
  const grid = new Map();
  for (let i = 0; i < cand.length; i++) {
    const c = cand[i];
    const k = ((c.y / cell) | 0) * 100000 + ((c.x / cell) | 0);
    let list = grid.get(k);
    if (!list) { list = []; grid.set(k, list); }
    list.push(i);
  }
  const taken = new Uint8Array(cand.length);
  const claim = (x, y) => {
    const gx = (x / cell) | 0;
    const gy = (y / cell) | 0;
    let best = -1;
    let bd = R2;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const list = grid.get((gy + oy) * 100000 + (gx + ox));
        if (!list) continue;
        for (const i of list) {
          if (taken[i]) continue;
          const c = cand[i];
          const d = (c.x - x) ** 2 + (c.y - y) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
      }
    }
    if (best >= 0) taken[best] = 1;
    return best;
  };

  const keepBar = threshold * (1 - o.hysteresis);
  const ease = clamp(o.posEase, 0.02, 1);
  const fade = Math.max(1, o.fadeFrames);
  const next = [];
  let maxStep = 0;

  // 1 · incumbents claim their nearest candidate, strongest incumbent first.
  S.live.sort((a, b) => b.ms - a.ms);
  for (const p of S.live) {
    const i = claim(p.x, p.y);
    if (i >= 0) {
      const c = cand[i];
      const nx = lerp(p.x, c.x, ease);
      const ny = lerp(p.y, c.y, ease);
      const step = Math.hypot(nx - p.x, ny - p.y);
      if (step > maxStep) maxStep = step;
      p.x = nx; p.y = ny;
      p.u = nx / aw; p.v = ny / ah;
      p.m = lerp(p.m, c.m, ease);
      p.ms = lerp(p.ms, c.m, 0.2);
      p.a = easeAngle(p.a, c.a, ease);
      p.w = lerp(p.w, c.w, ease);
      p.miss = 0;
      p.dying = false;
      if (p.alpha < 1) { p.alpha = Math.min(1, p.alpha + 1 / fade); maxStep = Math.max(maxStep, 1); }
      next.push(p);
      continue;
    }
    /*
     * Nothing claimed it. HYSTERESIS — churn source 3. A point that already
     * earned its place keeps it while the picture where it stands is still above
     * a LOWER bar than a newcomer has to clear. This is what stops the budget
     * boundary from flickering: without it, the several hundred candidates a
     * loose threshold admits re-decide the whole set every frame.
     */
    const here = sampleMag(mag, aw, ah, p.x, p.y);
    if (here >= keepBar && p.miss < o.coastFrames) {
      p.miss++;
      p.ms = lerp(p.ms, here, 0.2);
      if (p.alpha < 1) { p.alpha = Math.min(1, p.alpha + 1 / fade); maxStep = Math.max(maxStep, 1); }
      next.push(p);
    } else {
      p.alpha -= 1 / fade;
      p.dying = true;
      maxStep = Math.max(maxStep, 1);
      if (p.alpha > 0) next.push(p);
    }
  }

  /*
   * 2 · THE CAP. A point that was fading can be claimed again and revive, and
   * a newcomer may already have taken its slot — so the live count can creep
   * past the budget and stay there. Enforce it here, weakest first: whatever is
   * over budget starts fading, and only then do newcomers get whatever is free.
   */
  let alive = 0;
  for (const p of next) if (!p.dying) alive++;
  if (alive > budget) {
    const order = next.filter((p) => !p.dying).sort((a, b) => a.ms - b.ms);
    for (let i = 0; i < alive - budget; i++) {
      const p = order[i];
      p.dying = true;
      p.alpha -= 1 / fade;
      maxStep = Math.max(maxStep, 1);
    }
    alive = budget;
    for (let i = next.length - 1; i >= 0; i--) if (next[i].dying && next[i].alpha <= 0) next.splice(i, 1);
  }
  let room = budget - alive;
  for (let i = 0; i < cand.length && room > 0; i++) {
    if (taken[i]) continue;
    const c = cand[i];
    taken[i] = 1;
    next.push({
      id: S.nextId++, x: c.x, y: c.y, u: c.u, v: c.v, hu: c.u, hv: c.v,
      m: c.m, ms: c.m, a: c.a, w: c.w, miss: 0, dying: false,
      alpha: fade > 1 ? 0 : 1,
    });
    if (fade > 1) maxStep = Math.max(maxStep, 1);
    room--;
  }

  S.live = next;
  S.maxStep = maxStep;
  return S.live;
}

