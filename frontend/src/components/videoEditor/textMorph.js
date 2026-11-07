/*
 * Text Morph — one text turning into the next (the approved lab:
 * GL_Promo_Films/promo-special/fx-labs/text_morph_lab.html). The letters both texts
 * share travel from their place in the first to their place in the second; the first
 * one's other letters leave and the second one's other letters arrive.
 *
 * Played by the CYCLE placeholder's `style=morph` and by a text layer's line states
 * (`textLineStates`, each line one state) — textPlaceholders.js builds the unit, this
 * file does the matching, the timing and the glyph poses. LEAF: no imports, no DOM, so
 * node can test it. Everything is a pure function of (states, settings, time): export
 * renders frames out of order, nothing carries from one frame to the next.
 *
 *   planMorph    the steps between consecutive states: which letters pair up, which
 *                leave and arrive, and each step's length (travel + stagger × the last
 *                rank) — strings only, no font metrics, so the clock never depends on them
 *   morphAt      where the schedule is at a time: a state at rest, or a step under way
 *   morphPose    every glyph at one instant, laid out with the caller's own measure
 *                (kerning-aware, letter spacing between characters)
 *
 * Settings (resolved, textPlaceholders.resolveUnitSettings):
 *   hold s at rest · duration s each letter travels · easing (the travel's curve, a
 *   function here) · loop · fit (the unit's width follows the text) · direction 1 up /
 *   −1 down · match order|any · ignoreCase · letterStagger s between ranks · arc 0–1 ·
 *   leave mask|fade|blur|scale · order left|center|all.
 */

export const MORPH_MATCH = Object.freeze(['order', 'any']);
export const MORPH_LEAVE = Object.freeze(['mask', 'fade', 'blur', 'scale']);
export const MORPH_ORDER = Object.freeze(['left', 'center', 'all']);
// What a morph plays when its token (or line states) leave a field out. The lab's
// presets travel 0.8–1 s on an Expo In Out with ~30 ms between letters.
export const MORPH_DEFAULTS = Object.freeze({
  duration: 0.8,
  easing: 'EXPO_IN_OUT',
  match: 'order',
  ignoreCase: true,
  letterStagger: 0.03,
  arc: 0,
  leave: 'fade',
  order: 'left',
});

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, p) => a + (b - a) * p;

// A CSS cubic-bezier as a function of x (Newton, then bisection) — the lab's curves.
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1; const bx = 3 * (x2 - x1) - cx; const ax = 1 - cx - bx;
  const cy = 3 * y1; const by = 3 * (y2 - y1) - cy; const ay = 1 - cy - by;
  const X = (s) => ((ax * s + bx) * s + cx) * s;
  const Y = (s) => ((ay * s + by) * s + cy) * s;
  const dX = (s) => (3 * ax * s + 2 * bx) * s + cx;
  return (u) => {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    let s = u;
    for (let i = 0; i < 8; i += 1) {
      const e = X(s) - u; const d = dX(s);
      if (Math.abs(e) < 1e-7 || Math.abs(d) < 1e-6) break;
      s -= e / d;
    }
    if (Math.abs(X(s) - u) > 1e-6) {
      let lo = 0; let hi = 1; s = u;
      for (let i = 0; i < 40; i += 1) { if (X(s) < u) lo = s; else hi = s; s = (lo + hi) / 2; }
    }
    return Y(s);
  };
}
// Leaving letters accelerate away, arriving ones brake into place, a case pair
// crossfades on a soft S (the lab's easeIn / easeOut / smooth).
const EASE_LEAVE = bezier(0.55, 0, 0.8, 0.3);
const EASE_ARRIVE = bezier(0.22, 1, 0.36, 1);
const EASE_SWAP = bezier(0.45, 0, 0.2, 1);

// ── States and matching ──

/** A state's characters and its letters (every non-space character, with its index). */
export function stateOf(str) {
  const chars = Array.from(String(str ?? ''));
  const letters = [];
  chars.forEach((ch, i) => { if (ch.trim()) letters.push({ ch, i }); });
  return { str: chars.join(''), chars, letters };
}

// Longest common subsequence: the pairs keep their order (the lab's "Keep order").
function matchOrder(A, B, key) {
  const n = A.length; const m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      L[i][j] = key(A[i].ch) === key(B[j].ch) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (key(A[i].ch) === key(B[j].ch)) { pairs.push([i, j]); i += 1; j += 1; }
    else if (L[i + 1][j] >= L[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

// Any letter can go anywhere: each takes its nearest free twin, nearest by its
// relative place in the text (the lab's "Any position" — anagrams).
function matchAny(A, B, key) {
  const rel = (len, k) => (len < 2 ? 0.5 : k / (len - 1));
  const cand = [];
  B.forEach((b, j) => A.forEach((a, i) => {
    if (key(a.ch) === key(b.ch)) cand.push([Math.abs(rel(A.length, i) - rel(B.length, j)), i, j]);
  }));
  // Ties break on the indices, so the pairing never depends on the sort's stability.
  cand.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  const usedA = new Set(); const usedB = new Set(); const pairs = [];
  for (const [, i, j] of cand) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i); usedB.add(j); pairs.push([i, j]);
  }
  return pairs.sort((p, q) => p[1] - q[1]);
}

/** The letter pairs between two states: [[letter index in A, letter index in B], …]. */
export function matchLetters(A, B, { match = 'order', ignoreCase = true } = {}) {
  const key = ignoreCase ? (ch) => ch.toLowerCase() : (ch) => ch;
  return match === 'any' ? matchAny(A.letters, B.letters, key) : matchOrder(A.letters, B.letters, key);
}

// ── Schedule ──

function planStep(A, B, s) {
  const pairs = matchLetters(A, B, s);
  const inA = new Set(pairs.map((p) => p[0]));
  const inB = new Set(pairs.map((p) => p[1]));
  const events = [];
  for (const [a, b] of pairs) events.push({ kind: 'move', a, b });
  A.letters.forEach((_, a) => { if (!inA.has(a)) events.push({ kind: 'out', a }); });
  B.letters.forEach((_, b) => { if (!inB.has(b)) events.push({ kind: 'in', b }); });
  // Every event takes a rank (by place, at draw time); the last starts letterStagger ×
  // (count − 1) after the first. All at once: everyone on rank 0.
  const maxRank = s.order === 'all' ? 0 : Math.max(0, events.length - 1);
  return {
    events,
    len: s.duration + s.letterStagger * maxRank,
    counts: { move: pairs.length, out: A.letters.length - pairs.length, in: B.letters.length - pairs.length },
  };
}

/**
 * The whole schedule: every state, and one step per change — n − 1 steps, or n with
 * Loop (the last state turns back into the first). Step k rests `hold` s on state k
 * from t0, then morphs from tm for `len` s.
 */
export function planMorph(states, s) {
  const S = states.map(stateOf);
  const n = S.length;
  const count = n < 2 ? 0 : (s.loop ? n : n - 1);
  const steps = [];
  let t = 0;
  for (let k = 0; k < count; k += 1) {
    const to = (k + 1) % n;
    const st = { k, from: k, to, ...planStep(S[k], S[to], s), t0: t, tm: t + s.hold };
    t = st.tm + st.len;
    steps.push(st);
  }
  return { states: S, steps, period: t };
}

/**
 * Where the schedule is `tau` s after it starts (tau ≤ 0 = the first state):
 * { held: stateIndex } or { step, tau: seconds into its morph }.
 */
export function morphAt(plan, tau) {
  const { steps } = plan;
  if (!steps.length || !(tau > 0)) return { held: 0 };
  let t = tau;
  const looped = steps.length === plan.states.length;
  if (looped) t %= plan.period;
  else if (t >= plan.period) return { held: plan.states.length - 1 };
  for (const st of steps) {
    if (t < st.tm) return { held: st.from };
    if (t < st.tm + st.len) return { step: st, tau: t - st.tm };
  }
  return { held: steps[steps.length - 1].to };
}

// ── Layout and poses ──

/**
 * A state laid out by `measure(str)` (the caller's run measure: kerning and letter
 * spacing as the Player draws) and `charW(ch)`: its width and each letter's left x.
 * A letter sits where the prefix through it ends, less its own advance, so the kerning
 * pair in front of it counts exactly as in the whole string drawn at once.
 */
export function layoutState(state, measure, charW) {
  const width = state.str ? measure(state.str) : 0;
  const xs = state.letters.map(({ ch, i }) => {
    const w = charW(ch);
    return { x: measure(state.chars.slice(0, i + 1).join('')) - w, w };
  });
  return { width, xs };
}

/**
 * One instant of the morph, relative to the unit's left edge and the draw y:
 *   { held, heldX, width, glyphs: [{ ch, x, y, w, alpha, scale, blur, clip, q }] }
 * `held` is the state at rest (drawn whole by the caller, exactly like typed text), or
 * null mid-step. A glyph's x is its left edge; scale turns around its ink centre; `clip`
 * = inside the line mask (leave=mask); `q` how far it has left (0 = at rest, 1 = gone).
 *
 * @param at    morphAt() result
 * @param lay   (stateIndex) → layoutState()
 * @param o     { align 0 left | 0.5 centre | 1 right, box (Fixed width: the widest
 *              state), em, travel (a masked letter's way out: the mask's height) }
 */
export function morphPose(plan, at, s, lay, o) {
  const k = o.align;
  const ease = s.easing || ((p) => p);
  // The unit's width now: the state's own (Fit) or the widest (Fixed); a Fit unit
  // grows or shrinks along the step on the travel's curve.
  if (at.held != null) {
    const L = lay(at.held);
    const width = o.box ?? L.width;
    return { held: at.held, heldX: k * (width - L.width), width, glyphs: [] };
  }
  const st = at.step;
  const tau = at.tau;
  const A = plan.states[st.from]; const B = plan.states[st.to];
  const LA = lay(st.from); const LB = lay(st.to);
  const width = o.box ?? lerp(LA.width, LB.width, ease(clamp01(tau / st.len)));
  // Each state sits in the unit by the line's alignment, around the point that stays
  // put while the width changes (the left edge, the centre or the right edge).
  const anchor = k * width;
  const leftA = anchor - k * LA.width;
  const leftB = anchor - k * LB.width;
  const cxA = (a) => leftA + LA.xs[a].x + LA.xs[a].w / 2;
  const cxB = (b) => leftB + LB.xs[b].x + LB.xs[b].w / 2;
  // Ranks by place: from the left, or from each text's centre outward.
  const midA = leftA + LA.width / 2; const midB = leftB + LB.width / 2;
  const placeOf = (e) => {
    const x = e.kind === 'out' ? cxA(e.a) : cxB(e.b);
    return s.order === 'center' ? Math.abs(x - (e.kind === 'out' ? midA : midB)) : x;
  };
  const ranked = st.events.map((e, idx) => ({ e, idx, p: placeOf(e) }));
  if (s.order !== 'all') ranked.sort((p, q) => p.p - q.p || p.idx - q.idx);
  const em = o.em;
  const d = s.direction < 0 ? -1 : 1;
  const stag = s.letterStagger;
  const dur = s.duration;
  const glyphs = [];
  const push = (ch, cx, y, w, alpha, scale = 1, blur = 0, clip = false, q = 0) => {
    if (alpha > 0.002) glyphs.push({ ch, x: cx - w / 2, y, w, alpha, scale, blur, clip, q });
  };
  // q = 0 at rest, 1 gone. Leaving goes the direction's way; arriving comes from the
  // other side (canvas y grows down, so "up" is negative).
  const away = (ch, cx, w, q, leaving) => {
    const sgn = leaving ? -d : d;
    switch (s.leave) {
      case 'mask': push(ch, cx, sgn * o.travel * q, w, 1, 1, 0, true, q); break;
      case 'blur': push(ch, cx, 0, w, 1 - q, 1 + 0.25 * q, 0.17 * em * q, false, q); break;
      case 'scale': push(ch, cx, 0, w, 1 - q * q, 1 - 0.8 * q, 0, false, q); break;
      default: push(ch, cx, sgn * 0.42 * em * q, w, 1 - q, 1, 0, false, q);
    }
  };
  ranked.forEach(({ e }, r) => {
    const rank = s.order === 'all' ? 0 : r;
    if (e.kind === 'move') {
      const u = clamp01((tau - rank * stag) / dur);
      const p = ease(u);
      const ga = A.letters[e.a]; const gb = B.letters[e.b];
      const x0 = cxA(e.a); const x1 = cxB(e.b);
      const cx = lerp(x0, x1, p);
      const y = -s.arc * Math.min(0.75 * em, Math.abs(x1 - x0) * 0.4) * Math.sin(Math.PI * clamp01(p)) * d;
      if (ga.ch === gb.ch) {
        push(ga.ch, cx, y, LA.xs[e.a].w, 1);
      } else {
        // A case pair (i ↔ I): the two glyphs crossfade on the way.
        const c = EASE_SWAP(clamp01((u - 0.2) / 0.6));
        push(ga.ch, cx, y, LA.xs[e.a].w, 1 - c, 1 - 0.08 * c);
        push(gb.ch, cx, y, LB.xs[e.b].w, c, 0.92 + 0.08 * c);
      }
    } else if (e.kind === 'out') {
      const u = clamp01((tau - rank * stag * 0.6) / (dur * 0.55));
      away(A.letters[e.a].ch, cxA(e.a), LA.xs[e.a].w, EASE_LEAVE(u), true);
    } else {
      const u = clamp01((tau - dur * 0.42 - rank * stag * 0.6) / (dur * 0.58));
      away(B.letters[e.b].ch, cxB(e.b), LB.xs[e.b].w, 1 - EASE_ARRIVE(u), false);
    }
  });
  return { held: null, heldX: 0, width, glyphs };
}

/** The glyphs of a state at rest (3D text has no "whole string" draw). */
export function restingGlyphs(state, L, left = 0) {
  return state.letters.map(({ ch }, a) => ({ ch, x: left + L.xs[a].x, y: 0, w: L.xs[a].w, alpha: 1, scale: 1, blur: 0, clip: false, q: 0 }));
}
