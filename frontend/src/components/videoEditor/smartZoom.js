// Smart Zoom maths: the spring camera and the drawn cursor for screen recordings
// (PLANS/SCREEN_RECORDER_SMOOTH_MOTION_PLAN.md). Look-dev'd in html/smart-zoom-lab/ against Screen Studio's measured
// export; the labs load THIS file as a classic-script bundle (tests/smart-zoom/build_lab.mjs → SmartZoom global).
//
// It is a LEAF on purpose: no imports, no DOM, no editor state. smartZoomCamera.js adapts it to the editor's
// timeline and camera; the recorder's setup panel runs it for its Motion preview.
//
// Everything that moves is a damped spring solved in CLOSED FORM. A spring's target is piecewise linear in time (a
// step is a zero-length segment), so each segment's response follows exactly from the previous segment's end state.
// Building a track costs O(knots); evaluating any time is a binary search plus one formula. Nothing is stepped frame
// by frame, so preview, scrubbing and export agree to the last bit, in any order.
//
// Units: the public API takes MILLISECONDS and normalized screen coordinates (0..1 of the recorded area, y down).
// Springs run in seconds, with stiffness / damping / mass as Screen Studio stores them.
// ── Presets ────────────────────────────────────────────────────────────────────────────────────────────────────
// "studio" values are Screen Studio's own, read from the owner's project files (a behaviour target to measure
// against, not a promise). The others are starting points for the lab; the owner picks (plan D5).
export const CAMERA_PRESETS = {
  studio: { label: 'Studio', stiffness: 170, damping: 50, mass: 3 }, // ζ 1.11, halfway 240 ms
  calm: { label: 'Calm', stiffness: 110, damping: 46, mass: 3 }, // ζ 1.27, slow tail
  smooth: { label: 'Smooth', stiffness: 200, damping: 49, mass: 3 }, // ζ 1.00, halfway 205 ms
  snappy: { label: 'Snappy', stiffness: 340, damping: 66, mass: 3 }, // ζ 1.03, halfway 160 ms
};
export const CURSOR_PRESETS = {
  studio: { label: 'Studio', stiffness: 470, damping: 70, mass: 3 }, // ζ 0.93, trails ~150 ms
  soft: { label: 'Soft', stiffness: 300, damping: 60, mass: 3 }, // ζ 1.00
  tight: { label: 'Tight', stiffness: 900, damping: 100, mass: 3 }, // ζ 0.96
};
export const CLICK_SPRING = { stiffness: 700, damping: 30, mass: 1 }; // ζ 0.57: a press that rebounds ~11%

// Whole looks the owner picks between (2026-10-26; Studio = his pick and the default). Each one sets EVERY camera and
// cursor option. The recorder's setup panel offers the same list before a take starts.
export const PRESETS = [
  {
    id: 'studio',
    hint: 'Smooth spring zoom toward your clicks, like Screen Studio.',
    short: 'Like Screen Studio',
    name: 'Studio',
    note: 'Matches Screen Studio as measured: spring zoom, aims part-way to the clicks, the cursor trails your hand a little.',
    camera: { preset: 'studio', stiffness: 170, damping: 50, mass: 3, zoom: 1.45, motion: 'independent', zoomSpace: 'linear', follow: 'clicks', boxRatio: 0.7, aim: 0.6, retargetLeadMs: 1000, holdMinMs: 1500, rampMs: 40, edgeSnap: 0, preRollMs: 0 },
    cursor: { smoothing: 'spring', preset: 'studio', strength: 1, splineTolPx: 2.5, landMs: 120, shakePx: 3, size: 1.5, clickEffect: 'press', tilt: 0, hideIdleMs: 0 },
  },
  {
    id: 'calm',
    hint: 'A slower, gentler zoom that keeps the clicked spot in place.',
    short: 'Slow, gentle zoom',
    name: 'Calm',
    note: 'Slow, gentle and less zoom. The clicked spot stays put while the camera zooms. The cursor glides with no lag and fades when idle.',
    camera: { preset: 'calm', stiffness: 110, damping: 46, mass: 3, zoom: 1.35, motion: 'aboutPoint', zoomSpace: 'linear', follow: 'clicks', boxRatio: 0.7, aim: 0.5, retargetLeadMs: 1200, holdMinMs: 1800, rampMs: 80, edgeSnap: 0, preRollMs: 0 },
    cursor: { smoothing: 'zerolag', preset: 'soft', strength: 0.8, splineTolPx: 2.5, landMs: 160, shakePx: 3, size: 1.4, clickEffect: 'press', tilt: 0, hideIdleMs: 2500 },
  },
  {
    id: 'precise',
    hint: 'A closer zoom that centres what you click.',
    short: 'Closer, clicks centred',
    name: 'Precise',
    note: 'Closer zoom that puts the clicks near the middle. The cursor follows your real path exactly, minus the shake. A ring shows each click.',
    camera: { preset: 'smooth', stiffness: 200, damping: 49, mass: 3, zoom: 1.6, motion: 'aboutPoint', zoomSpace: 'linear', follow: 'clicks', boxRatio: 0.7, aim: 0.85, retargetLeadMs: 800, holdMinMs: 1500, rampMs: 40, edgeSnap: 0, preRollMs: 0 },
    cursor: { smoothing: 'spline', preset: 'studio', strength: 1, splineTolPx: 2, landMs: 80, shakePx: 3, size: 1.3, clickEffect: 'ring', tilt: 0, hideIdleMs: 0 },
  },
  {
    id: 'lively',
    hint: 'A fast, punchy zoom that goes in further.',
    short: 'Quick, punchy zoom',
    name: 'Lively',
    note: 'Quick, punchy zooms that go in further. The cursor is tight and tilts as it moves, for short social clips.',
    camera: { preset: 'snappy', stiffness: 340, damping: 66, mass: 3, zoom: 1.7, motion: 'independent', zoomSpace: 'log', follow: 'clicks', boxRatio: 0.7, aim: 0.75, retargetLeadMs: 600, holdMinMs: 1200, rampMs: 20, edgeSnap: 0, preRollMs: 0 },
    cursor: { smoothing: 'spring', preset: 'tight', strength: 1, splineTolPx: 2.5, landMs: 100, shakePx: 3, size: 1.6, clickEffect: 'press', tilt: 10, hideIdleMs: 0 },
  },
  {
    id: 'follow',
    hint: 'While zoomed in, the camera follows your cursor.',
    short: 'Follows the cursor',
    name: 'Follow',
    note: 'While zoomed in, the camera follows the cursor, moving only when it leaves a box around the view, not just on clicks. The cursor has no lag.',
    camera: { preset: 'smooth', stiffness: 200, damping: 49, mass: 3, zoom: 1.5, motion: 'independent', zoomSpace: 'linear', follow: 'cursor', boxRatio: 0.6, aim: 0.8, retargetLeadMs: 300, holdMinMs: 1500, rampMs: 60, edgeSnap: 0, preRollMs: 0 },
    cursor: { smoothing: 'zerolag', preset: 'studio', strength: 1, splineTolPx: 2.5, landMs: 120, shakePx: 3, size: 1.5, clickEffect: 'press', tilt: 0, hideIdleMs: 0 },
  },
];
export const DEFAULT_PRESET = 'studio';

// The preset with this id; an unknown or missing one falls back to the default (Studio).
export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS.find((p) => p.id === DEFAULT_PRESET);
}

export const CAMERA_DEFAULTS = {
  preset: 'studio',
  spring: null, // { stiffness, damping, mass } overrides the preset
  zoom: 1.45, // Screen Studio's default in recent projects
  // Auto ranges, decoded from 185 Screen Studio ranges: [first mouseDown − 300 ms, last mouseUp + 2.5 s], merged
  // while the gap is under 2.5 s, never split by distance.
  leadMs: 300,
  tailMs: 2500,
  mergeGapMs: 2500,
  skipLastMs: 1000, // a click this close to the end (the stop click) makes no range
  minRangeMs: 0,
  preRollMs: 0, // the camera starts this long before the range start
  // Inside a range the target follows the action:
  //   'clicks' = click groups (clicks within clickGroupMaxDistance of the group's first click share one target)
  //   'cursor' = runs of cursor movement whose bounding box fits a dead-zone box of the zoomed view
  //   'fixed'  = one point (the range's own point, else the centroid of its clicks)
  follow: 'clicks',
  clickGroupMaxDistance: 0.3, // in screen widths, true proportions (a tall jump counts as tall)
  // How far the view moves from the screen centre toward a target: 1 centres it. Fitted on Screen Studio's export of
  // the 2026-10-07 take (tests/smart-zoom/reference): 0.6, with no edge sticking (the aim error is 37 pt; with
  // aim 1 + edge sticking 0.25 it was 103 pt).
  aim: 0.6,
  boxRatio: 0.7, // dead-zone box, as a fraction of the zoomed view
  minDwellMs: 400, // 'cursor': a pass-through shorter than this (with no click) does not move the camera
  retargetLeadMs: 1000, // the camera leaves for the next group this long before its first click (Screen Studio: 1 s)
  // No half-stops: a target change that would come while the camera is still settling from the last one (sooner than
  // holdMinMs) moves earlier, to flowMs after it, so the camera flows on instead of nearly stopping and setting off
  // again. Changes holdMinMs or more apart keep a real hold. holdMinMs 0 turns this off.
  holdMinMs: 1500,
  flowMs: 700,
  rampMs: 40, // targets glide over this long instead of stepping, so acceleration stays continuous (40 ms matches
  // Screen Studio's measured zoom-in 567 / zoom-out 617 ms best with its own spring)
  edgeSnap: 0, // the outer share of the view's travel that sticks to the edge (Screen Studio's export showed none)
  // 'independent' = springs on zoom and centre; 'aboutPoint' = springs on zoom and centre·zoom, which keeps the
  // fixed point of the move still on screen (the clicked spot does not swing away while the zoom rises).
  motion: 'independent',
  zoomSpace: 'linear', // 'linear' | 'log' (independent motion only)
};

export const CURSOR_DEFAULTS = {
  smoothing: 'spring', // 'off' | 'spring' (causal, trails) | 'zerolag' (forward-backward spring) | 'spline'
  preset: 'studio',
  spring: null,
  strength: 1, // scales the spring's stiffness (higher = follows tighter)
  splineTolPx: 2.5, // 'spline': points closer than this to the simplified path are dropped
  landMs: 120, // the cursor is pulled onto the real position this long before a mouseDown, and held through it
  shakePx: 3, // a cursor that stays within this radius for shakeMs is held still (0 = off)
  shakeMs: 150,
  holdGapMs: null, // raw track: a gap longer than this means the cursor stood still (null = from the sample rate)
  clickEffect: 'press', // 'press' | 'ring' | 'none'
  pressDepth: 0.18,
  ringMs: 450,
  tilt: 0, // degrees per (screen width / s) of horizontal speed
  tiltMax: 18,
  hideIdleMs: 0, // fade the cursor after this long without movement (0 = never)
  shapeDebounceMs: 80,
};

// ── Springs ────────────────────────────────────────────────────────────────────────────────────────────────────

export function springParams(spring) {
  const k = Math.max(1e-6, Number(spring && spring.stiffness) || 0);
  const c = Math.max(0, Number(spring && spring.damping) || 0);
  const m = Math.max(1e-6, Number(spring && spring.mass) || 1);
  const w0 = Math.sqrt(k / m);
  return { k, c, m, w0, zeta: c / (2 * Math.sqrt(k * m)), lag: c / k };
}

// State after dt seconds of a spring whose target moves as y0 + s·τ. The particular solution follows the ramp,
// trailing it by (c/k)·s; the error decays as a free damped oscillator (under-, critically or over-damped).
export function springAdvance(p, x0, v0, y0, s, dt, out) {
  const e0 = x0 - (y0 - p.lag * s);
  const ev0 = v0 - s;
  const w0 = p.w0;
  const zeta = p.zeta;
  let e;
  let ev;
  if (Math.abs(zeta - 1) < 1e-6) {
    const B = ev0 + w0 * e0;
    const ex = Math.exp(-w0 * dt);
    e = (e0 + B * dt) * ex;
    ev = (B - w0 * (e0 + B * dt)) * ex;
  } else if (zeta < 1) {
    const a = zeta * w0;
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const B = (ev0 + a * e0) / wd;
    const ex = Math.exp(-a * dt);
    const co = Math.cos(wd * dt);
    const si = Math.sin(wd * dt);
    e = ex * (e0 * co + B * si);
    ev = ex * ((B * wd - a * e0) * co - (e0 * wd + a * B) * si);
  } else {
    const r = w0 * Math.sqrt(zeta * zeta - 1);
    const r1 = -zeta * w0 + r;
    const r2 = -zeta * w0 - r;
    const C2 = (ev0 - r1 * e0) / (r2 - r1);
    const C1 = e0 - C2;
    const x1 = Math.exp(r1 * dt);
    const x2 = Math.exp(r2 * dt);
    e = C1 * x1 + C2 * x2;
    ev = C1 * r1 * x1 + C2 * r2 * x2;
  }
  out[0] = y0 + s * dt - p.lag * s + e;
  out[1] = s + ev;
  return out;
}

// Last index i with T[i] <= t (the last of equal times, so a step is already taken), or -1 before the first knot.
function lastAtOrBefore(T, n, t) {
  if (n === 0 || !(t >= T[0])) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (T[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// knots: [{ t (s), y }] sorted by t; equal times make a step. The spring starts at rest on the first target unless
// `init` ({ x, v }) says otherwise.
export function buildSpringTrack(knots, spring, init) {
  const p = springParams(spring);
  const n = knots.length;
  const T = new Float64Array(n);
  const Y = new Float64Array(n);
  const S = new Float64Array(n);
  const X = new Float64Array(n);
  const V = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    T[i] = knots[i].t;
    Y[i] = knots[i].y;
  }
  for (let i = 0; i + 1 < n; i += 1) {
    const dt = T[i + 1] - T[i];
    S[i] = dt > 1e-12 ? (Y[i + 1] - Y[i]) / dt : 0;
  }
  if (n) {
    X[0] = init && Number.isFinite(init.x) ? init.x : Y[0];
    V[0] = init && Number.isFinite(init.v) ? init.v : 0;
  }
  const tmp = [0, 0];
  for (let i = 0; i + 1 < n; i += 1) {
    const dt = T[i + 1] - T[i];
    if (dt > 1e-12) springAdvance(p, X[i], V[i], Y[i], S[i], dt, tmp);
    else {
      tmp[0] = X[i];
      tmp[1] = V[i];
    }
    X[i + 1] = tmp[0];
    V[i + 1] = tmp[1];
  }
  return { p, T, Y, S, X, V, n };
}

// → [x, v, a] at time t (s).
export function evalSpringTrack(tr, t, out) {
  const o = out || [0, 0, 0];
  if (!tr.n) {
    o[0] = 0;
    o[1] = 0;
    o[2] = 0;
    return o;
  }
  const i = lastAtOrBefore(tr.T, tr.n, t);
  if (i < 0) {
    o[0] = tr.X[0];
    o[1] = tr.V[0];
    o[2] = 0;
    return o;
  }
  const s = i + 1 < tr.n ? tr.S[i] : 0;
  const dt = t - tr.T[i];
  springAdvance(tr.p, tr.X[i], tr.V[i], tr.Y[i], s, dt, o);
  const p = tr.p;
  o[2] = (p.k * (tr.Y[i] + s * dt - o[0]) - p.c * o[1]) / p.m;
  return o;
}

// ── Small helpers ──────────────────────────────────────────────────────────────────────────────────────────────

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const lerp = (a, b, u) => a + (b - a) * u;

function resolveSpring(presets, presetId, custom, fallback) {
  if (custom && Number(custom.stiffness) > 0) return { stiffness: +custom.stiffness, damping: +custom.damping, mass: +custom.mass || 1 };
  return presets[presetId] || presets[fallback];
}

// Where the view sits for a wanted centre. Along the travel the centre can have at zoom z ([h, 1 − h]), the outer
// `snap` share on each side maps onto the edge and the middle stretches to fill: a view near an edge sticks to it,
// a centred view stays centred, and nearby points stay nearby (the remap is continuous). Never shows past the screen.
export function placeView(cx, cy, z, snap) {
  const h = 0.5 / z;
  const travel = 1 - 2 * h;
  const s = clamp(Number(snap) || 0, 0, 0.45);
  const remap = (c) => {
    if (travel <= 1e-9) return 0.5;
    const u = clamp((c - h) / travel, 0, 1);
    const v = s > 0 ? clamp((u - s) / (1 - 2 * s), 0, 1) : u;
    return h + v * travel;
  };
  return { x: remap(cx), y: remap(cy) };
}

// ── Edit (two clocks) ──────────────────────────────────────────────────────────────────────────────────────────
// slices: [{ sourceStartMs, sourceEndMs, timeScale }] in playback order (the recording's items on the timeline).
// The camera simulates in OUTPUT time; targets live in SOURCE time. A cut is just a target change.

export function normalizeSlices(slices, durationMs) {
  const list = Array.isArray(slices) && slices.length ? slices : [{ sourceStartMs: 0, sourceEndMs: durationMs, timeScale: 1 }];
  let o = 0;
  return list.map((s) => {
    const scale = Number(s.timeScale) > 0 ? +s.timeScale : 1;
    // A piece placed on a timeline says where it starts; pieces without one follow each other with no gap.
    const o0 = Number.isFinite(+s.outputStartMs) && s.outputStartMs !== null && s.outputStartMs !== undefined ? +s.outputStartMs : o;
    const out = { s0: +s.sourceStartMs, s1: +s.sourceEndMs, scale, o0, o1: o0 + (s.sourceEndMs - s.sourceStartMs) / scale };
    o = out.o1;
    return out;
  });
}

export function outputToSource(edit, tOutMs) {
  if (!edit.length) return tOutMs;
  let i = edit.length - 1;
  for (let k = 0; k < edit.length; k += 1) {
    if (tOutMs < edit[k].o1) {
      i = k;
      break;
    }
  }
  const e = edit[i];
  return clamp(e.s0 + (tOutMs - e.o0) * e.scale, e.s0, e.s1);
}

// Every output time at which `tSrcMs` plays (a source moment can play twice, or not at all).
export function sourceToOutput(edit, tSrcMs) {
  const out = [];
  for (const e of edit) if (tSrcMs >= e.s0 && tSrcMs <= e.s1) out.push(e.o0 + (tSrcMs - e.s0) / e.scale);
  return out;
}

// Value of piecewise-linear knots [{t, v:[...]}] at t; side < 0 takes the left limit at a step.
function knotValueAt(knots, t, side) {
  const n = knots.length;
  if (!n) return null;
  if (t < knots[0].t || (side < 0 && t === knots[0].t)) return knots[0].v.slice();
  let i = 0;
  if (side < 0) {
    while (i + 1 < n && knots[i + 1].t < t) i += 1;
  } else {
    while (i + 1 < n && knots[i + 1].t <= t) i += 1;
  }
  if (i + 1 >= n) return knots[n - 1].v.slice();
  const a = knots[i];
  const b = knots[i + 1];
  const span = b.t - a.t;
  const u = span > 1e-9 ? clamp((t - a.t) / span, 0, 1) : 1;
  return a.v.map((x, d) => lerp(x, b.v[d], u));
}

// Source-time knots → output-time knots through the edit. Where the recording is not on screen (before its first piece,
// between pieces, after its last) the target is `neutral`: the camera rests there.
function knotsToOutput(knots, edit, neutral) {
  const out = [];
  let prevEnd = null;
  for (const e of edit) {
    const gap = prevEnd === null ? e.o0 > 0 : e.o0 - prevEnd > 1e-6;
    if (gap && neutral) {
      if (prevEnd !== null) out.push({ t: prevEnd, v: neutral.slice() });
      out.push({ t: e.o0, v: neutral.slice() });
    }
    out.push({ t: e.o0, v: knotValueAt(knots, e.s0, +1) });
    for (const k of knots) if (k.t > e.s0 && k.t < e.s1) out.push({ t: e.o0 + (k.t - e.s0) / e.scale, v: k.v.slice() });
    out.push({ t: e.o1, v: knotValueAt(knots, e.s1, -1) });
    prevEnd = e.o1;
  }
  if (neutral && prevEnd !== null) out.push({ t: prevEnd, v: neutral.slice() });
  return out;
}

// ── Ranges ─────────────────────────────────────────────────────────────────────────────────────────────────────

// clicks: [{ t (mouseDown ms), up (mouseUp ms), x, y }] → [{ id, startMs, endMs }]. Like Screen Studio, a mouseDown
// and its mouseUp are separate events, each opening [t − lead, t + tail]: a long drag can make two ranges.
export function autoRanges(clicks, durationMs, settings) {
  const o = Object.assign({}, CAMERA_DEFAULTS, settings);
  const limit = Number.isFinite(durationMs) ? durationMs : Infinity;
  const times = [];
  for (const c of clicks || []) {
    if (!Number.isFinite(c.t)) continue;
    times.push(c.t);
    if (Number.isFinite(c.up) && c.up > c.t) times.push(c.up);
  }
  times.sort((a, b) => a - b);
  const out = [];
  for (const t of times) {
    if (t > limit - o.skipLastMs) continue;
    const s = Math.max(0, t - o.leadMs);
    const e = Math.min(limit, t + o.tailMs);
    const last = out[out.length - 1];
    if (last && s - last.endMs < o.mergeGapMs) last.endMs = Math.max(last.endMs, e);
    else out.push({ startMs: s, endMs: e });
  }
  return out.map((r, i) => ({
    id: `auto-${i}`,
    startMs: r.startMs,
    endMs: Math.min(limit, Math.max(r.endMs, r.startMs + o.minRangeMs)),
  }));
}

// ── The recorder's event track ─────────────────────────────────────────────────────────────────────────────────
// A clip's `recordingMeta` (useScreenRecording buildEventTrack): { cursor: [{ t (s), x, y }], events: [{ t, type,
// x, y, button }], screen: { width, height }, durationSec }, positions already 0..1 of the recorded area. → a take.
export function takeFromEventTrack(track, durationMs) {
  if (!track || typeof track !== 'object') return null;
  const scr = track.screen && typeof track.screen === 'object' ? track.screen : {};
  const finite = (...v) => v.every((x) => Number.isFinite(x));
  const moves = { t: [], x: [], y: [], s: [] };
  for (const c of Array.isArray(track.cursor) ? track.cursor : []) {
    if (!c || !finite(c.t, c.x, c.y)) continue;
    moves.t.push(c.t * 1000);
    moves.x.push(c.x);
    moves.y.push(c.y);
    moves.s.push(0);
  }
  const events = (Array.isArray(track.events) ? track.events : [])
    .filter((e) => e && (e.type === 'mousedown' || e.type === 'mouseup') && finite(e.t, e.x, e.y))
    .slice()
    .sort((a, b) => a.t - b.t);
  const clicks = [];
  const open = new Map();
  for (const e of events) {
    const key = e.button === undefined || e.button === null ? 'left' : String(e.button);
    if (e.type === 'mousedown') {
      const c = { t: e.t * 1000, up: null, x: e.x, y: e.y };
      open.set(key, c);
      clicks.push(c);
    } else {
      const c = open.get(key);
      if (!c) continue;
      c.up = Math.max(c.t, e.t * 1000);
      c.upX = e.x;
      c.upY = e.y;
      open.delete(key);
    }
  }
  for (const c of clicks) if (c.up === null) c.up = c.t + 80;
  const dur = Number.isFinite(durationMs) ? durationMs : (Number(track.durationSec) || 0) * 1000;
  return {
    durationMs: dur,
    width: Number(scr.width) > 0 ? +scr.width : 1920,
    height: Number(scr.height) > 0 ? +scr.height : 1080,
    moves,
    shapes: ['arrow'],
    clicks,
  };
}

// ── Camera targets ─────────────────────────────────────────────────────────────────────────────────────────────

// Raw cursor as a function of source time (linear between samples, standing still across a gap).
export function rawPathFrom(take, holdGapMs) {
  const mv = take.moves || { t: [], x: [], y: [] };
  const pts = [];
  for (let i = 0; i < mv.t.length; i += 1) pts.push({ t: mv.t[i], x: mv.x[i], y: mv.y[i], click: false });
  for (const c of take.clicks || []) {
    pts.push({ t: c.t, x: c.x, y: c.y, click: true });
    if (Number.isFinite(c.up) && c.up > c.t) pts.push({ t: c.up, x: Number.isFinite(c.upX) ? c.upX : c.x, y: Number.isFinite(c.upY) ? c.upY : c.y, click: true });
  }
  pts.sort((a, b) => a.t - b.t || (a.click ? 1 : 0) - (b.click ? 1 : 0));
  const dedup = [];
  for (const p of pts) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(last.t - p.t) < 0.5) {
      if (p.click) dedup[dedup.length - 1] = p;
      continue;
    }
    dedup.push(p);
  }
  const gap = Number.isFinite(holdGapMs) && holdGapMs > 0 ? holdGapMs : estimateHoldGap(dedup);
  const out = [];
  for (let i = 0; i < dedup.length; i += 1) {
    const p = dedup[i];
    const prev = out[out.length - 1];
    if (prev && p.t - prev.t > gap) out.push({ t: p.t - gap, x: prev.x, y: prev.y, click: false, hold: true });
    out.push(p);
  }
  return { pts: out, holdGapMs: gap };
}

// A recorder that logs every OS event (Screen Studio: ~9 ms) and one that samples at 10 Hz need different ideas of
// "the cursor stood still": twice the typical interval between samples while moving.
function estimateHoldGap(pts) {
  const gaps = [];
  for (let i = 1; i < pts.length; i += 1) {
    const g = pts[i].t - pts[i - 1].t;
    if (g > 0.5 && g < 250) gaps.push(g);
  }
  if (!gaps.length) return 100;
  gaps.sort((a, b) => a - b);
  return clamp(2 * gaps[gaps.length >> 1], 16, 160);
}

export function rawAt(path, t, out) {
  const pts = path.pts;
  const o = out || { x: 0.5, y: 0.5 };
  const n = pts.length;
  if (!n) return o;
  if (t <= pts[0].t) {
    o.x = pts[0].x;
    o.y = pts[0].y;
    return o;
  }
  if (t >= pts[n - 1].t) {
    o.x = pts[n - 1].x;
    o.y = pts[n - 1].y;
    return o;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
  o.x = lerp(a.x, b.x, u);
  o.y = lerp(a.y, b.y, u);
  return o;
}

// Greedy runs of points whose bounding box fits w × h. Offline, so each run's centre is known before it starts.
function boxRuns(points, w, h) {
  const runs = [];
  let cur = null;
  for (const p of points) {
    if (cur) {
      const x0 = Math.min(cur.x0, p.x);
      const x1 = Math.max(cur.x1, p.x);
      const y0 = Math.min(cur.y0, p.y);
      const y1 = Math.max(cur.y1, p.y);
      if (x1 - x0 <= w && y1 - y0 <= h) {
        Object.assign(cur, { x0, x1, y0, y1, t1: p.t, click: cur.click || p.click });
        continue;
      }
    }
    cur = { t0: p.t, t1: p.t, x0: p.x, x1: p.x, y0: p.y, y1: p.y, click: p.click };
    runs.push(cur);
  }
  return runs.map((r) => ({ t: r.t0, t1: r.t1, x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2, click: r.click }));
}

// Centre targets inside one range, as [{ t (ms), x, y }], the first at the range start.
function rangeTargets(range, take, path, o, z) {
  const ar = (take.height || 1) / (take.width || 1); // y distances in screen widths
  const clicks = (take.clicks || []).filter((c) => c.t >= range.startMs && c.t <= range.endMs).sort((a, b) => a.t - b.t);
  const mode = range.mode === 'fixed' || o.follow === 'fixed' ? 'fixed' : o.follow;
  const start = range.startMs;
  if (mode === 'fixed' || (mode === 'clicks' && !clicks.length)) {
    if (range.point && Number.isFinite(range.point.x)) return [{ t: start, x: range.point.x, y: range.point.y }];
    if (clicks.length) {
      const x = clicks.reduce((s, c) => s + c.x, 0) / clicks.length;
      const y = clicks.reduce((s, c) => s + c.y, 0) / clicks.length;
      return [{ t: start, x, y }];
    }
    const p = rawAt(path, start + o.leadMs);
    return [{ t: start, x: p.x, y: p.y }];
  }
  if (mode === 'clicks') {
    const groups = [];
    for (const c of clicks) {
      const g = groups[groups.length - 1];
      if (g && Math.hypot(c.x - g.first.x, (c.y - g.first.y) * ar) <= o.clickGroupMaxDistance) g.list.push(c);
      else groups.push({ first: c, list: [c] });
    }
    const out = [];
    groups.forEach((g, i) => {
      const x = g.list.reduce((s, c) => s + c.x, 0) / g.list.length;
      const y = g.list.reduce((s, c) => s + c.y, 0) / g.list.length;
      const t = i === 0 ? start : Math.max(out[out.length - 1].t + 1, g.first.t - o.retargetLeadMs);
      out.push({ t, x, y });
    });
    return out;
  }
  // 'cursor': follow the cursor with a dead-zone box; transit shorter than minDwellMs is ignored.
  const pts = [];
  let lastT = -Infinity;
  for (const p of path.pts) {
    if (p.t < start - 1 || p.t > range.endMs) continue;
    if (!p.click && p.t - lastT < 40) continue;
    lastT = p.t;
    pts.push(p);
  }
  if (!pts.length) {
    const p = rawAt(path, start);
    return [{ t: start, x: p.x, y: p.y }];
  }
  const box = o.boxRatio / z;
  const runs = boxRuns(pts, box, box).filter((r, i, all) => {
    const next = all[i + 1];
    const dwell = (next ? next.t : range.endMs) - r.t;
    return i === 0 || r.click || dwell >= o.minDwellMs;
  });
  const out = [];
  runs.forEach((r, i) => {
    const t = i === 0 ? start : Math.max(out[out.length - 1].t + 1, r.t - o.retargetLeadMs);
    out.push({ t, x: r.x, y: r.y });
  });
  return out;
}

// ── Camera plan ────────────────────────────────────────────────────────────────────────────────────────────────

// take: { durationMs, moves {t,x,y}, clicks [{t,up,x,y}] }; ranges: [{ startMs, endMs, zoom?, mode?, point?,
// disabled? }] in SOURCE time (null = auto from clicks); slices: the edit (null = the whole recording once).
export function buildCameraPlan(input) {
  const take = input.take;
  const o = Object.assign({}, CAMERA_DEFAULTS, input.settings);
  const spring = resolveSpring(CAMERA_PRESETS, o.preset, o.spring, 'studio');
  const durationMs = Number(take.durationMs) || 0;
  const ranges = (input.ranges || autoRanges(take.clicks, durationMs, o)).filter((r) => !r.disabled && r.endMs > r.startMs);
  const path = input.path || rawPathFrom(take, null);
  const ramp = Math.max(0, o.rampMs);

  // Piecewise-constant targets in source time: [{ t, z, x, y }], then glides of `ramp` ms between them.
  const steps = [{ t: -Infinity, z: 1, x: 0.5, y: 0.5 }];
  const targets = [];
  for (const r of ranges) {
    const z = Math.max(1, Number(r.zoom) > 0 ? +r.zoom : o.zoom);
    const list = rangeTargets(r, take, path, o, z);
    const pre = Math.max(0, o.preRollMs);
    const aim = Number.isFinite(+o.aim) ? clamp(+o.aim, 0, 1) : 1;
    if (o.holdMinMs > 0) {
      let prevT = r.startMs - Math.max(0, o.preRollMs);
      for (let i = 1; i < list.length; i += 1) {
        const gap = list[i].t - prevT;
        if (gap < o.holdMinMs && gap > o.flowMs) list[i].t = prevT + o.flowMs;
        prevT = list[i].t;
      }
    }
    // A point placed by hand (a 'fixed' range with a point) is where the view centres, exactly; only targets the
    // maths picks (clicks, the cursor) are aimed part-way.
    const a = r.mode === 'fixed' && r.point && Number.isFinite(+r.point.x) ? 1 : aim;
    list.forEach((p, i) => {
      const v = placeView(0.5 + a * (p.x - 0.5), 0.5 + a * (p.y - 0.5), z, o.edgeSnap);
      const t = i === 0 ? r.startMs - pre : p.t;
      steps.push({ t, z, x: v.x, y: v.y });
      targets.push({ t, z, x: v.x, y: v.y, rangeId: r.id });
    });
    steps.push({ t: r.endMs, z: 1, x: 0.5, y: 0.5 });
  }
  // Ranges are disjoint after merging, but user ranges may touch: keep step times increasing.
  for (let i = 1; i < steps.length; i += 1) if (steps[i].t < steps[i - 1].t) steps[i].t = steps[i - 1].t;

  const enc = (s) => {
    if (o.motion === 'aboutPoint') return [s.z, s.x * s.z, s.y * s.z];
    if (o.zoomSpace === 'log') return [Math.log(s.z), s.x, s.y];
    return [s.z, s.x, s.y];
  };
  const srcKnots = [{ t: Math.min(0, steps[1] ? steps[1].t : 0) - 1, v: enc(steps[0]) }];
  for (let i = 1; i < steps.length; i += 1) {
    const prev = steps[i - 1];
    const s = steps[i];
    const next = steps[i + 1];
    const glide = Math.min(ramp, next ? Math.max(0, next.t - s.t) : ramp);
    srcKnots.push({ t: s.t, v: enc(prev) });
    srcKnots.push({ t: s.t + glide, v: enc(s) });
  }
  const edit = normalizeSlices(input.slices, durationMs);
  const outKnots = knotsToOutput(srcKnots, edit, enc(steps[0]));
  const tracks = [0, 1, 2].map((d) => buildSpringTrack(outKnots.map((k) => ({ t: k.t / 1000, y: k.v[d] })), spring));
  return { settings: o, spring, ranges, targets, edit, tracks, outKnots, durationMs, outDurationMs: edit.length ? Math.max(...edit.map((e) => e.o1)) : durationMs };
}

const _e0 = [0, 0, 0];
const _e1 = [0, 0, 0];
const _e2 = [0, 0, 0];

// → { zoom, cx, cy } at OUTPUT time tMs.
export function evalCamera(plan, tMs, out) {
  const o = out || { zoom: 1, cx: 0.5, cy: 0.5 };
  const t = tMs / 1000;
  const a = evalSpringTrack(plan.tracks[0], t, _e0)[0];
  const b = evalSpringTrack(plan.tracks[1], t, _e1)[0];
  const c = evalSpringTrack(plan.tracks[2], t, _e2)[0];
  let z;
  let x;
  let y;
  if (plan.settings.motion === 'aboutPoint') {
    z = a;
    x = b / Math.max(1e-6, a);
    y = c / Math.max(1e-6, a);
  } else {
    z = plan.settings.zoomSpace === 'log' ? Math.exp(a) : a;
    x = b;
    y = c;
  }
  z = Math.max(1, z);
  const h = 0.5 / z;
  o.zoom = z;
  o.cx = clamp(x, h, 1 - h);
  o.cy = clamp(y, h, 1 - h);
  return o;
}

// ── Cursor ─────────────────────────────────────────────────────────────────────────────────────────────────────

// Hold the cursor still while it stays within `px` of where a still spell began (hand shake while aiming).
function removeShake(pts, pxX, pxY, minMs) {
  if (!(pxX > 0) || !(minMs > 0)) return pts;
  const out = pts.map((p) => Object.assign({}, p));
  let i = 0;
  while (i < out.length) {
    let j = i + 1;
    while (j < out.length && Math.hypot((out[j].x - out[i].x) / pxX, (out[j].y - out[i].y) / pxY) <= 1) j += 1;
    const last = j - 1;
    if (last > i && out[last].t - out[i].t >= minMs) {
      let sx = 0;
      let sy = 0;
      for (let k = i; k <= last; k += 1) {
        sx += out[k].x;
        sy += out[k].y;
      }
      const mx = sx / (last - i + 1);
      const my = sy / (last - i + 1);
      for (let k = i; k <= last; k += 1) {
        if (out[k].click) continue; // a click keeps its real position (the landing pulls onto it)
        out[k].x = mx;
        out[k].y = my;
      }
      i = last + 1;
    } else i += 1;
  }
  return out;
}

// Ramer–Douglas–Peucker in time-aware form: keeps clicks, holds, and points farther than tol from the chord.
function simplify(pts, tolX, tolY) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  for (let i = 0; i < n; i += 1) if (pts[i].click || pts[i].hold) keep[i] = 1;
  const stack = [];
  let a = 0;
  for (let i = 1; i < n; i += 1) {
    if (keep[i]) {
      stack.push([a, i]);
      a = i;
    }
  }
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;
    const A = pts[s];
    const B = pts[e];
    let best = -1;
    let bestD = 0;
    for (let i = s + 1; i < e; i += 1) {
      const u = (pts[i].t - A.t) / Math.max(1e-9, B.t - A.t);
      const dx = (pts[i].x - lerp(A.x, B.x, u)) / tolX;
      const dy = (pts[i].y - lerp(A.y, B.y, u)) / tolY;
      const d = dx * dx + dy * dy;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0 && bestD > 1) {
      keep[best] = 1;
      stack.push([s, best], [best, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// Time-parametrised cubic Hermite through knots, with per-axis slopes limited so it never overshoots a knot.
function buildSpline(pts) {
  const n = pts.length;
  const T = new Float64Array(n);
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  const MX = new Float64Array(n);
  const MY = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    T[i] = pts[i].t;
    X[i] = pts[i].x;
    Y[i] = pts[i].y;
  }
  const slope = (V, M) => {
    for (let i = 0; i < n; i += 1) {
      if (i === 0 || i === n - 1) {
        M[i] = 0;
        continue;
      }
      const d0 = (V[i] - V[i - 1]) / Math.max(1e-9, T[i] - T[i - 1]);
      const d1 = (V[i + 1] - V[i]) / Math.max(1e-9, T[i + 1] - T[i]);
      if (d0 * d1 <= 0) {
        M[i] = 0;
        continue;
      }
      const m = (V[i + 1] - V[i - 1]) / Math.max(1e-9, T[i + 1] - T[i - 1]);
      const lim = 3 * Math.min(Math.abs(d0), Math.abs(d1));
      M[i] = Math.sign(m) * Math.min(Math.abs(m), lim);
    }
  };
  slope(X, MX);
  slope(Y, MY);
  // A hold is a real stop: zero slope at both of its ends.
  for (let i = 0; i < n; i += 1) {
    if (pts[i].hold || (i + 1 < n && pts[i + 1].hold)) {
      MX[i] = 0;
      MY[i] = 0;
    }
  }
  return { T, X, Y, MX, MY, n };
}

function evalSpline(sp, t, out) {
  const o = out;
  const n = sp.n;
  if (!n) return o;
  if (t <= sp.T[0]) {
    o.x = sp.X[0];
    o.y = sp.Y[0];
    return o;
  }
  if (t >= sp.T[n - 1]) {
    o.x = sp.X[n - 1];
    o.y = sp.Y[n - 1];
    return o;
  }
  const i = lastAtOrBefore(sp.T, n, t);
  const h = sp.T[i + 1] - sp.T[i];
  const u = (t - sp.T[i]) / h;
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  o.x = h00 * sp.X[i] + h10 * h * sp.MX[i] + h01 * sp.X[i + 1] + h11 * h * sp.MX[i + 1];
  o.y = h00 * sp.Y[i] + h10 * h * sp.MY[i] + h01 * sp.Y[i + 1] + h11 * h * sp.MY[i + 1];
  return o;
}

function scaledSpring(spring, strength) {
  return { stiffness: spring.stiffness * Math.max(0.05, strength || 1), damping: spring.damping * Math.sqrt(Math.max(0.05, strength || 1)), mass: spring.mass };
}

// A zero-phase smoother: the spring forward, then the same spring backward over its output, on a 240 Hz grid.
// Possible only because recordings are smoothed after the take, never live.
function buildZeroLag(pts, spring) {
  const HZ = 240;
  const t0 = pts[0].t / 1000;
  const t1 = pts[pts.length - 1].t / 1000 + 1;
  const n = Math.max(2, Math.ceil((t1 - t0) * HZ) + 1);
  const pass = (knotsX, knotsY, sign) => {
    const tx = buildSpringTrack(knotsX, spring);
    const ty = buildSpringTrack(knotsY, spring);
    const X = new Float64Array(n);
    const Y = new Float64Array(n);
    const VX = new Float64Array(n);
    const VY = new Float64Array(n);
    const e = [0, 0, 0];
    for (let i = 0; i < n; i += 1) {
      const t = sign > 0 ? t0 + i / HZ : -(t0 + (n - 1 - i) / HZ);
      evalSpringTrack(tx, t, e);
      X[i] = e[0];
      VX[i] = e[1];
      evalSpringTrack(ty, t, e);
      Y[i] = e[0];
      VY[i] = e[1];
    }
    return { X, Y, VX, VY };
  };
  const f = pass(pts.map((p) => ({ t: p.t / 1000, y: p.x })), pts.map((p) => ({ t: p.t / 1000, y: p.y })), +1);
  // Backward: time reversed (τ = −t), knots in increasing τ.
  const bx = [];
  const by = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    bx.push({ t: -(t0 + i / HZ), y: f.X[i] });
    by.push({ t: -(t0 + i / HZ), y: f.Y[i] });
  }
  const b = pass(bx, by, -1);
  // b[i] holds τ = −(t0 + (n−1−i)/HZ); flip back to forward time with negated velocity.
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  const VX = new Float64Array(n);
  const VY = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const j = n - 1 - i;
    X[i] = b.X[j];
    Y[i] = b.Y[j];
    VX[i] = -b.VX[j];
    VY[i] = -b.VY[j];
  }
  return { t0: t0 * 1000, hz: HZ, n, X, Y, VX, VY };
}

function evalGrid(g, tMs, out) {
  const o = out;
  const f = ((tMs - g.t0) / 1000) * g.hz;
  if (f <= 0) {
    o.x = g.X[0];
    o.y = g.Y[0];
    return o;
  }
  if (f >= g.n - 1) {
    o.x = g.X[g.n - 1];
    o.y = g.Y[g.n - 1];
    return o;
  }
  const i = Math.floor(f);
  const u = f - i;
  const h = 1 / g.hz;
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  o.x = h00 * g.X[i] + h10 * h * g.VX[i] + h01 * g.X[i + 1] + h11 * h * g.VX[i + 1];
  o.y = h00 * g.Y[i] + h10 * h * g.VY[i] + h01 * g.Y[i + 1] + h11 * h * g.VY[i + 1];
  return o;
}

// take: { width, height (points), moves {t,x,y,s}, shapes, clicks }. Simulates in SOURCE time: the cursor belongs to
// the screen content, unlike the camera.
export function buildCursorPlan(input) {
  const take = input.take;
  const o = Object.assign({}, CURSOR_DEFAULTS, input.settings);
  const W = Math.max(1, take.width || 1920);
  const H = Math.max(1, take.height || 1080);
  const raw = input.path || rawPathFrom(take, o.holdGapMs);
  const base = removeShake(raw.pts, o.shakePx / W, o.shakePx / H, o.shakeMs);
  const spring = scaledSpring(resolveSpring(CURSOR_PRESETS, o.preset, o.spring, 'studio'), o.strength);
  const plan = { settings: o, raw, width: W, height: H, smoothing: o.smoothing, spring };
  if (!base.length) plan.smoothing = 'off';
  else if (o.smoothing === 'spring') {
    plan.tx = buildSpringTrack(base.map((p) => ({ t: p.t / 1000, y: p.x })), spring);
    plan.ty = buildSpringTrack(base.map((p) => ({ t: p.t / 1000, y: p.y })), spring);
  } else if (o.smoothing === 'zerolag') {
    plan.grid = buildZeroLag(base, scaledSpring(spring, 2));
  } else if (o.smoothing === 'spline') {
    plan.spline = buildSpline(simplify(base, o.splineTolPx / W, o.splineTolPx / H));
  } else {
    plan.base = { pts: base };
  }

  // Landing windows: ramp onto the real position before each mouseDown, hold it through the mouseUp.
  const land = Math.max(0, o.landMs);
  plan.windows = (take.clicks || [])
    .map((c) => ({ a: c.t - land, d: c.t, u: Number.isFinite(c.up) ? Math.max(c.up, c.t) : c.t, b: (Number.isFinite(c.up) ? Math.max(c.up, c.t) : c.t) + land }))
    .sort((p, q) => p.a - q.a);
  plan.land = land;

  // Click press: a spring that goes to 1 on mouseDown and back to 0 on mouseUp.
  const press = [{ t: -1, y: 0 }];
  for (const c of (take.clicks || []).slice().sort((p, q) => p.t - q.t)) {
    const d = c.t / 1000;
    const u = Math.max(c.t, Number.isFinite(c.up) ? c.up : c.t + 80) / 1000;
    if (d < press[press.length - 1].t) continue;
    press.push({ t: d, y: 0 }, { t: d, y: 1 }, { t: u, y: 1 }, { t: u, y: 0 });
  }
  plan.press = buildSpringTrack(press, CLICK_SPRING);
  plan.clickT = Float64Array.from((take.clicks || []).map((c) => c.t).sort((p, q) => p - q));

  // Shapes, debounced: a shape must last shapeDebounceMs before the cursor changes to it.
  const mv = take.moves || {};
  const shapes = take.shapes || ['arrow'];
  const seg = [];
  if (Array.isArray(mv.s) && mv.s.length) {
    let cur = mv.s[0];
    let candidate = null;
    seg.push({ t: -Infinity, s: cur });
    for (let i = 1; i < mv.s.length; i += 1) {
      const s = mv.s[i];
      if (s === cur) {
        candidate = null;
        continue;
      }
      if (!candidate || candidate.s !== s) candidate = { s, t: mv.t[i] };
      if (mv.t[i] - candidate.t >= o.shapeDebounceMs || i === mv.s.length - 1) {
        cur = s;
        seg.push({ t: candidate.t, s });
        candidate = null;
      }
    }
  } else seg.push({ t: -Infinity, s: 0 });
  plan.shapeT = Float64Array.from(seg.map((x) => x.t));
  plan.shapeS = seg.map((x) => shapes[x.s] || 'arrow');

  // Movement times, for idle hiding.
  plan.moveT = Float64Array.from(raw.pts.filter((p, i, a) => i === 0 || Math.hypot((p.x - a[i - 1].x) * W, (p.y - a[i - 1].y) * H) > 0.5).map((p) => p.t));
  return plan;
}

const _r = { x: 0, y: 0 };
const _s = { x: 0, y: 0 };
const _ev = [0, 0, 0];

function smoothAt(plan, tMs, out) {
  const o = out;
  if (plan.smoothing === 'spring') {
    o.x = evalSpringTrack(plan.tx, tMs / 1000, _ev)[0];
    o.y = evalSpringTrack(plan.ty, tMs / 1000, _ev)[0];
  } else if (plan.smoothing === 'zerolag') evalGrid(plan.grid, tMs, o);
  else if (plan.smoothing === 'spline') evalSpline(plan.spline, tMs, o);
  else rawAt(plan.base || plan.raw, tMs, o);
  return o;
}

function landingWeight(plan, tMs) {
  const w = plan.windows;
  if (!w.length || !(plan.land >= 0)) return 0;
  let lo = 0;
  let hi = w.length - 1;
  if (tMs < w[0].a) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (w[mid].a <= tMs) lo = mid;
    else hi = mid - 1;
  }
  let best = 0;
  for (let k = lo; k >= 0 && k >= lo - 4; k -= 1) {
    const x = w[k];
    let v = 0;
    if (tMs >= x.d && tMs <= x.u) v = 1;
    else if (tMs < x.d) v = plan.land > 0 ? smoothstep((tMs - x.a) / plan.land) : 0;
    else if (tMs <= x.b) v = plan.land > 0 ? 1 - smoothstep((tMs - x.u) / plan.land) : 0;
    if (v > best) best = v;
  }
  return best;
}

// Cursor position only (normalized), with the landing applied.
export function cursorPosition(plan, tMs, out) {
  const o = out || { x: 0, y: 0 };
  smoothAt(plan, tMs, _s);
  const w = landingWeight(plan, tMs);
  if (w > 0) {
    rawAt(plan.raw, tMs, _r);
    o.x = lerp(_s.x, _r.x, w);
    o.y = lerp(_s.y, _r.y, w);
  } else {
    o.x = _s.x;
    o.y = _s.y;
  }
  return o;
}

const _p0 = { x: 0, y: 0 };
const _p1 = { x: 0, y: 0 };

// → { x, y, shape, scale, angle (deg), opacity, ring (0..1, or -1) } at SOURCE time tMs.
export function evalCursor(plan, tMs, out) {
  const o = out || {};
  cursorPosition(plan, tMs, o);
  const o2 = plan.settings;
  const si = lastAtOrBefore(plan.shapeT, plan.shapeT.length, tMs);
  o.shape = plan.shapeS[Math.max(0, si)];
  o.scale = o2.clickEffect === 'press' ? 1 - o2.pressDepth * evalSpringTrack(plan.press, tMs / 1000, _ev)[0] : 1;
  o.ring = -1;
  if (o2.clickEffect === 'ring' && plan.clickT.length) {
    const i = lastAtOrBefore(plan.clickT, plan.clickT.length, tMs);
    if (i >= 0 && tMs - plan.clickT[i] <= o2.ringMs) o.ring = (tMs - plan.clickT[i]) / o2.ringMs;
  }
  o.angle = 0;
  if (o2.tilt) {
    cursorPosition(plan, tMs - 8, _p0);
    cursorPosition(plan, tMs + 8, _p1);
    const vx = (_p1.x - _p0.x) / 0.016; // screen widths per second
    o.angle = clamp(-o2.tilt * vx, -o2.tiltMax, o2.tiltMax);
  }
  o.opacity = 1;
  if (o2.hideIdleMs > 0 && plan.moveT.length) {
    const i = lastAtOrBefore(plan.moveT, plan.moveT.length, tMs);
    const last = i >= 0 ? plan.moveT[i] : -Infinity;
    const next = i + 1 < plan.moveT.length ? plan.moveT[i + 1] : Infinity;
    const idle = tMs - last - o2.hideIdleMs;
    const fadeOut = smoothstep(idle / 300);
    const fadeIn = smoothstep((next - tMs) / 150);
    o.opacity = 1 - Math.min(fadeOut, fadeIn);
  }
  return o;
}

// ── Metrics (shared definitions with tests/smart-zoom/measure_reference.py) ──────────────────────────────────

function median(a) {
  if (!a.length) return NaN;
  const s = a.slice().sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// camAt(tMs) → { zoom, cx, cy }. ranges in OUTPUT ms: [{ startMs, endMs, firstClickMs, zoom? (the zoom asked for) }].
export function cameraMetrics(camAt, ranges, t0, t1) {
  const FPS = 60;
  const dt = 1000 / FPS;
  const n = Math.max(3, Math.floor((t1 - t0) / dt) + 1);
  const T = new Float64Array(n);
  const Z = new Float64Array(n);
  const CX = new Float64Array(n);
  const CY = new Float64Array(n);
  const v = { zoom: 1, cx: 0.5, cy: 0.5 };
  for (let i = 0; i < n; i += 1) {
    T[i] = t0 + i * dt;
    const r = camAt(T[i], v);
    Z[i] = r.zoom;
    CX[i] = r.cx;
    CY[i] = r.cy;
  }
  const speed = new Float64Array(n);
  for (let i = 1; i < n - 1; i += 1) {
    const h = (T[i + 1] - T[i - 1]) / 1000;
    const pan = Math.hypot((CX[i + 1] - CX[i - 1]) * Z[i], (CY[i + 1] - CY[i - 1]) * Z[i]) / h;
    speed[i] = pan + Math.abs(Math.log(Z[i + 1]) - Math.log(Z[i - 1])) / h;
  }
  speed[0] = speed[1];
  speed[n - 1] = speed[n - 2];
  const idx = (t) => clamp(Math.round((t - t0) / dt), 0, n - 1);
  const per = [];
  let stops = 0;
  let holds = 0;
  for (const r of ranges) {
    const a = idx(r.startMs - 1500);
    const b = idx(r.endMs);
    let zp = 1;
    for (let i = idx(r.startMs); i <= b; i += 1) zp = Math.max(zp, Z[i]);
    if (zp < 1.01) {
      per.push({ zoomInMs: NaN });
      continue;
    }
    const lo = 1 + 0.02 * (zp - 1);
    const hi90 = 1 + 0.9 * (zp - 1);
    const lo10 = 1 + 0.1 * (zp - 1);
    let iStart = -1;
    for (let i = a; i <= b; i += 1) if (Z[i] > lo) { iStart = i; break; }
    let i90 = -1;
    for (let i = Math.max(0, iStart); i <= b; i += 1) if (Z[i] >= hi90) { i90 = i; break; }
    let iLast90 = -1;
    for (let i = b; i >= Math.max(0, i90); i -= 1) if (Z[i] >= hi90) { iLast90 = i; break; }
    let iOut10 = -1;
    for (let i = Math.max(0, iLast90); i < n; i += 1) if (Z[i] <= lo10) { iOut10 = i; break; }
    const plateau = [];
    let zmax = 1;
    for (let i = Math.max(0, i90); i <= Math.max(0, iLast90); i += 1) {
      plateau.push(Z[i]);
      zmax = Math.max(zmax, Z[i]);
    }
    // Hitches inside the zoomed window: the camera slows to a halt (speed < 0.02 for at least 2 frames) and moves
    // again (> 0.1 within 300 ms) after resting less than 400 ms. A longer rest is a hold — the camera arrived and
    // waits for the next action — and is counted separately.
    let rangeStops = 0;
    let rangeHolds = 0;
    if (i90 >= 0 && iLast90 > i90) {
      let i = i90;
      while (i <= iLast90) {
        if (speed[i] >= 0.02) {
          i += 1;
          continue;
        }
        let j = i;
        while (j <= iLast90 && speed[j] < 0.02) j += 1;
        const frames = j - i;
        if (j <= iLast90 && frames >= 2) {
          let moves = false;
          for (let k = j; k <= Math.min(iLast90, j + Math.round(300 / dt)); k += 1) if (speed[k] > 0.1) moves = true;
          if (frames * dt < 400 && moves) rangeStops += 1;
          else if (frames * dt >= 400) rangeHolds += 1;
        }
        i = j;
      }
    }
    stops += rangeStops;
    holds += rangeHolds;
    per.push({
      zp,
      zoomInMs: iStart >= 0 && i90 >= 0 ? T[i90] - T[iStart] : NaN,
      startVsRangeMs: iStart >= 0 ? T[iStart] - r.startMs : NaN,
      startVsClickMs: iStart >= 0 && Number.isFinite(r.firstClickMs) ? T[iStart] - r.firstClickMs : NaN,
      zoomOutMs: iLast90 >= 0 && iOut10 >= 0 ? T[iOut10] - T[iLast90] : NaN,
      // against the zoom the camera was asked for (the range's own), else the plateau's median
      overshootPct: plateau.length ? (Math.max(0, zmax - (Number(r.zoom) > 1 ? r.zoom : median(plateau))) / ((Number(r.zoom) > 1 ? r.zoom : zp) - 1)) * 100 : NaN,
      stops: rangeStops,
      holds: rangeHolds,
    });
  }
  // Acceleration jumps: on a 1 ms grid inside ranges, the largest change of acceleration between neighbours, in
  // screen widths / s² (pan) + log-zoom / s². A spring with stepped targets or eased keys jumps; glides don't.
  let maxJump = 0;
  const g = { zoom: 1, cx: 0.5, cy: 0.5 };
  for (const r of ranges) {
    const s = r.startMs - 1500;
    const e = r.endMs + 1500;
    let prevA = null;
    const w = [];
    for (let t = s; t <= e; t += 1) {
      const c = camAt(t, g);
      w.push([Math.log(c.zoom), c.cx * c.zoom, c.cy * c.zoom]);
      if (w.length > 3) w.shift();
      if (w.length === 3) {
        const acc = [0, 1, 2].map((d) => (w[2][d] - 2 * w[1][d] + w[0][d]) / 1e-6);
        if (prevA) maxJump = Math.max(maxJump, Math.hypot(acc[0] - prevA[0], acc[1] - prevA[1], acc[2] - prevA[2]));
        prevA = acc;
      }
    }
  }
  const pick = (k) => median(per.map((p) => p[k]).filter(Number.isFinite));
  return {
    perRange: per,
    zoomInMs: pick('zoomInMs'),
    startVsRangeMs: pick('startVsRangeMs'),
    startVsClickMs: pick('startVsClickMs'),
    zoomOutMs: pick('zoomOutMs'),
    overshootPct: per.length ? Math.max(...per.map((p) => (Number.isFinite(p.overshootPct) ? p.overshootPct : 0))) : NaN,
    stops,
    holds,
    maxAccelJump: maxJump,
    curve: { T, Z, CX, CY, speed },
  };
}

// drawnAt(tMs) / rawAt(tMs) → { x, y } normalized; W, H in points; clicks: [{ t, x, y }].
export function cursorMetrics(drawnAt, rawAtFn, clicks, W, H, t0, t1) {
  const HZ = 240;
  const n = Math.max(8, Math.floor(((t1 - t0) / 1000) * HZ));
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const rx = new Float64Array(n);
  const ry = new Float64Array(n);
  const p = { x: 0, y: 0 };
  for (let i = 0; i < n; i += 1) {
    const t = t0 + (i * 1000) / HZ;
    drawnAt(t, p);
    dx[i] = p.x * W;
    dy[i] = p.y * H;
    rawAtFn(t, p);
    rx[i] = p.x * W;
    ry[i] = p.y * H;
  }
  const vel = (X) => {
    const V = new Float64Array(n);
    for (let i = 1; i < n - 1; i += 1) V[i] = (X[i + 1] - X[i - 1]) * (HZ / 2);
    return V;
  };
  const dvx = vel(dx);
  const dvy = vel(dy);
  const rvx = vel(rx);
  const rvy = vel(ry);
  // lag: drawn(t) ≈ raw(t − lag); coarse 10 ms steps, then 2 ms around the best
  const corr = (ms) => {
    const k = Math.round((ms / 1000) * HZ);
    let s = 0;
    for (let i = Math.max(1, k + 1); i < Math.min(n - 1, n - 1 + k); i += 1) s += dvx[i] * rvx[i - k] + dvy[i] * rvy[i - k];
    return s;
  };
  let best = -Infinity;
  let lagMs = 0;
  for (let ms = -400; ms <= 400; ms += 10) {
    const s = corr(ms);
    if (s > best) {
      best = s;
      lagMs = ms;
    }
  }
  const coarse = lagMs;
  for (let ms = coarse - 8; ms <= coarse + 8; ms += 2) {
    const s = corr(ms);
    if (s > best) {
      best = s;
      lagMs = ms;
    }
  }
  // jitter: high-pass energy (minus a centred 100 ms boxcar) while the cursor HOVERS — where shake shows. On moves
  // the boxcar residual is the move's own curvature, not shake, and a trailing cursor is still catching up after the
  // hand stopped. Hover = the 100 ms-boxcar speed of BOTH the raw and the drawn path under 20 px/s.
  const half = Math.round(0.05 * HZ);
  const box = (X) => {
    const c = new Float64Array(n + 1);
    for (let i = 0; i < n; i += 1) c[i + 1] = c[i] + X[i];
    const B = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const a = Math.max(0, i - half);
      const b = Math.min(n - 1, i + half);
      B[i] = (c[b + 1] - c[a]) / (b - a + 1);
    }
    return B;
  };
  const brx = box(rx);
  const bry = box(ry);
  const bdx = box(dx);
  const bdy = box(dy);
  const slow = new Uint8Array(n);
  for (let i = half + 1; i < n - half - 1; i += 1) {
    const sr = Math.hypot(brx[i + 1] - brx[i - 1], bry[i + 1] - bry[i - 1]) * (HZ / 2);
    const sd = Math.hypot(bdx[i + 1] - bdx[i - 1], bdy[i + 1] - bdy[i - 1]) * (HZ / 2);
    slow[i] = sr < 20 && sd < 20 ? 1 : 0;
  }
  const hp = (X, Y) => {
    const BX = box(X);
    const BY = box(Y);
    let e = 0;
    let cnt = 0;
    for (let i = 0; i < n; i += 1) {
      if (!slow[i]) continue;
      e += (X[i] - BX[i]) ** 2 + (Y[i] - BY[i]) ** 2;
      cnt += 1;
    }
    return cnt ? e / cnt : 0;
  };
  const jitterRaw = hp(rx, ry);
  const jitterDrawn = hp(dx, dy);
  const errs = [];
  for (const c of clicks || []) {
    if (c.t < t0 || c.t > t1) continue;
    drawnAt(c.t, p);
    errs.push(Math.hypot((p.x - c.x) * W, (p.y - c.y) * H));
  }
  return {
    lagMs,
    jitterRaw,
    jitterDrawn,
    jitterRawRms: Math.sqrt(jitterRaw),
    jitterDrawnRms: Math.sqrt(jitterDrawn),
    // A recorder that logs nothing while the hand is still has no hover shake to remove: no percentage then.
    jitterCutPct: jitterRaw >= 0.01 ? 100 * (1 - jitterDrawn / jitterRaw) : NaN,
    clickErrorPx: errs.length ? median(errs) : NaN,
    clickErrorMaxPx: errs.length ? Math.max(...errs) : NaN,
  };
}
