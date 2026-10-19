// Particle LINES — the polylines `render.mode: 'lines'` draws.
//
// Two ways to join particles, both READS of what the solver already made:
//
//   connect 'time'  A TRAIL: one particle's own past. The bake cache is slot-
//                   aligned by uid at `cacheHz`, so a particle's path is its own
//                   earlier snapshots — `linePathIndex` packs them per uid once
//                   per bake, and `buildTrailLines` samples a window of it. Every
//                   force bends the line because it bent the particle. Bake only:
//                   the live engine keeps no history.
//
//   connect 'rows'  READY-MADE LINES: a rows emitter's grid, joined along each
//                   row at THIS instant. uid u is grid site u − 1 (emission.js),
//                   so a row is rebuilt from any sample of the pool — baked or
//                   live — with no history at all.
//
// Output is a set of polylines in the Solver Box's local space (box px, +y up):
// per point a position, a half width in px and a straight-alpha RGBA. Turning
// them into camera-facing ribbons is the renderer's job (particleLayer.js);
// this file has no three.js and no DOM, so it runs in node for the tests.

import { STRIDE, SAMPLE_STRIDE } from './solver.js';
import { ROWS_LIFE, rowsSiteOffset } from './emission.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);   // Math.hypot is several times slower

/*
 * HOW FINELY A LINE IS SAMPLED. Smoothing is a CEILING, not a rate: an interval
 * between two particles earns sub-samples only when it is visibly CURVED (the
 * Catmull-Rom midpoint strays from the straight chord by more than BEND_PX) and
 * long enough to show it (one per STEP_PX of its length). A trail also drops
 * snapshot points that sit closer than KEEP_PX along a straight run. All three
 * are decided per interval from fixed geometry, so they never change as the
 * playhead moves the window — no shimmer — and a slow, straight path costs a
 * handful of points instead of Smoothing × its snapshots.
 */
const BEND_PX = 0.2, STEP_PX = 3, KEEP_PX = 2.5;
const smooth01 = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

/** Deterministic 0..1 per uid and salt — which particles get a trail, and their width jitter. */
function hash01(u, salt) {
  let h = Math.imul(u ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Grow-only scratch: per-frame building must not allocate. */
function ensure(buf, key, Ctor, n) {
  if (!buf[key] || buf[key].length < n) buf[key] = new Ctor(Math.ceil(n * 1.5) + 256);
  return buf[key];
}

// ── The path index (trails) ──────────────────────────────────────────────────

const PATH_INDEX = new WeakMap();

/**
 * Every uid's snapshots, packed uid-major, built once per bake and memoised on
 * the cache. A PARTIAL cache (still baking) is rebuilt as it fills, keyed on how
 * far it has got; a live engine has no history and gets null.
 *
 * `brk[k] = 1` marks the step INTO point k as a wrap teleport — a line must not
 * be drawn across the box. The two spare snapshots at the tail repeat the last
 * real one (solver.js) and are left out, or every survivor would end standing
 * still.
 */
export function linePathIndex(cache) {
  if (!cache || cache.live || !cache.data) return null;
  const memo = PATH_INDEX.get(cache);
  const fill = cache.baked ?? -1;
  if (memo && memo.fill === fill) return memo;
  const { maxP, snapCount, data, uids, cacheHz, wrap } = cache;
  let lastSnap = Math.max(0, Math.min(snapCount - 1, Math.floor(cache.duration * cacheHz)));
  if (cache.baked != null) lastSnap = Math.min(lastSnap, cache.baked - 1);
  let maxU = 0;
  for (let k = 0, n = (lastSnap + 1) * maxP; k < n; k++) if (uids[k] > maxU) maxU = uids[k];
  const count = new Int32Array(maxU + 1);
  const first = new Int32Array(maxU + 1).fill(-1);
  for (let s = 0; s <= lastSnap; s++) {
    const base = s * maxP;
    for (let i = 0; i < maxP; i++) {
      const u = uids[base + i];
      if (!u) continue;
      if (first[u] < 0) first[u] = s;
      count[u]++;
    }
  }
  const off = new Int32Array(maxU + 2);
  for (let u = 0; u <= maxU; u++) off[u + 1] = off[u] + count[u];
  const total = off[maxU + 1];
  const pos = new Float32Array(total * 3);
  const brk = new Uint8Array(total);
  const age0 = new Float32Array(maxU + 1);
  const cur = off.slice(0, maxU + 1);
  for (let s = 0; s <= lastSnap; s++) {
    const base = s * maxP;
    for (let i = 0; i < maxP; i++) {
      const u = uids[base + i];
      if (!u) continue;
      const k = cur[u]++;
      const o = (base + i) * STRIDE;
      pos[k * 3] = data[o]; pos[k * 3 + 1] = data[o + 1]; pos[k * 3 + 2] = data[o + 2];
      if (k === off[u]) age0[u] = data[o + 3];
      else if (wrap) {
        const q = (k - 1) * 3;
        if (Math.abs(pos[k * 3] - pos[q]) > wrap.x || Math.abs(pos[k * 3 + 1] - pos[q + 1]) > wrap.y
          || Math.abs(pos[k * 3 + 2] - pos[q + 2]) > wrap.z) brk[k] = 1;
      }
    }
  }
  // Arc length from birth, per point (a wrap break adds nothing).
  const cum = new Float32Array(total);
  for (let u = 1; u <= maxU; u++) {
    const a = off[u], n = count[u];
    for (let j = 1; j < n; j++) {
      const k = a + j, q = k - 1;
      cum[k] = cum[q] + (brk[k] ? 0 : len3(pos[k * 3] - pos[q * 3], pos[k * 3 + 1] - pos[q * 3 + 1], pos[k * 3 + 2] - pos[q * 3 + 2]));
    }
  }
  // Speed per point, px/s, central difference (one-sided at the ends).
  const spd = new Float32Array(total);
  for (let u = 1; u <= maxU; u++) {
    const a = off[u], n = count[u];
    if (n < 2) continue;
    for (let j = 0; j < n; j++) {
      const k0 = a + Math.max(0, j - 1), k1 = a + Math.min(n - 1, j + 1);
      const dt = (k1 - k0) / cacheHz;
      const dx = pos[k1 * 3] - pos[k0 * 3], dy = pos[k1 * 3 + 1] - pos[k0 * 3 + 1], dz = pos[k1 * 3 + 2] - pos[k0 * 3 + 2];
      spd[a + j] = dt > 0 && !brk[k1] ? len3(dx, dy, dz) / dt : 0;
    }
  }
  // Drawable uids in birth order, so a frame stops at the first one not yet born.
  const list = [];
  for (let u = 1; u <= maxU; u++) if (count[u] >= 2) list.push(u);
  list.sort((p, q) => first[p] - first[q]);
  const idx = {
    fill, hz: cacheHz, lastSnap, first, count, off, pos, cum, spd, brk, age0,
    life: cache.lifeOf, list: Int32Array.from(list), points: total,
    duration: cache.duration,
  };
  PATH_INDEX.set(cache, idx);
  return idx;
}

// ── Look ─────────────────────────────────────────────────────────────────────

/**
 * Everything a frame of lines needs, resolved once per frame from the system.
 * `lifeLut` / `speedLut` are the renderer's 256-texel RGBA byte ramps (the
 * Colour section's colour-over-life and colour-by-speed), so a line in
 * 'particle' colour mode wears exactly what the sprite would have.
 */
export function lineLook(system, lifeLut, speedLut, duration) {
  const L = system.render.lines;
  const R = system.render;
  const parse = (hex) => {
    const s = String(hex || '#ffffffff').replace('#', '');
    const n = (i) => parseInt(s.slice(i, i + 2), 16) || 0;
    return [n(0) / 255, n(2) / 255, n(4) / 255, s.length >= 8 ? n(6) / 255 : 1];
  };
  return {
    ...L,
    opacity: R.opacity,
    // 'source' has no meaning for a line (a point is not a pixel of anything),
    // so it reads the life ramp like 'age'; 'velocity' reads the speed ramp.
    bySpeed: R.colorMode === 'velocity',
    velMin: R.velocityRange.min,
    velSpan: Math.max(1e-3, R.velocityRange.max - R.velocityRange.min),
    lifeLut, speedLut,
    startRGBA: parse(L.colorStart),
    endRGBA: parse(L.colorEnd),
    duration: Math.max(0.1, duration),
  };
}

/** The renderer's ramp read: 256 texels, linear, clamped, bytes → 0..1. */
function lut(data, t, out) {
  const x = clamp(t, 0, 1) * 255;
  const i0 = Math.min(255, Math.floor(x)), i1 = Math.min(255, i0 + 1), f = x - i0;
  const a = i0 * 4, b = i1 * 4;
  out[0] = (data[a] + (data[b] - data[a]) * f) / 255;
  out[1] = (data[a + 1] + (data[b + 1] - data[a + 1]) * f) / 255;
  out[2] = (data[a + 2] + (data[b + 2] - data[a + 2]) * f) / 255;
  out[3] = (data[a + 3] + (data[b + 3] - data[a + 3]) * f) / 255;
  return out;
}

const _c = [0, 0, 0, 0], _s = [0, 0, 0, 0];

/**
 * Colour of one point. `lifeT` 0..1 through the particle's life, `speed` px/s,
 * `along` 0..1 down the line (head → tail, top row → bottom), `moved` px from
 * where the particle was born. Writes straight-alpha RGBA into `out` at `o`.
 */
function colourAt(o, lifeT, speed, along, moved, out, q) {
  let r, g, b, a;
  if (o.colorMode === 'along' || o.colorMode === 'moved') {
    const m = o.colorMode === 'along' ? along : clamp(moved / o.movedRange, 0, 1);
    const A = o.startRGBA, B = o.endRGBA;
    r = A[0] + (B[0] - A[0]) * m; g = A[1] + (B[1] - A[1]) * m;
    b = A[2] + (B[2] - A[2]) * m; a = A[3] + (B[3] - A[3]) * m;
  } else {
    // THE COLOUR SECTION'S RULE: the life ramp always owns alpha; the mode only
    // decides where RGB comes from.
    lut(o.lifeLut, lifeT, _c);
    a = _c[3];
    if (o.bySpeed && o.speedLut) {
      lut(o.speedLut, (speed - o.velMin) / o.velSpan, _s);
      r = _s[0]; g = _s[1]; b = _s[2];
    } else { r = _c[0]; g = _c[1]; b = _c[2]; }
  }
  out[q] = r; out[q + 1] = g; out[q + 2] = b; out[q + 3] = a * o.opacity;
}

/** Width multiplier along a line, `a` 0 at the start (head / left) → 1 at the end. */
function taperAt(a, o, rows) {
  const sA = o.taperStart, sB = o.taperEnd;
  if (o.profile === 'swell') {
    // Fat in the middle, thin at both ends — a brush stroke.
    const m = Math.sin(Math.PI * clamp(a, 0, 1));
    return 1 - (a < 0.5 ? sA : sB) * (1 - m);
  }
  const shape = o.profile === 'smooth' ? (x) => x * x * (3 - 2 * x) : (x) => x;
  if (rows) {
    // A row tapers at both ends over its outer 15 %.
    const l = sA * shape(Math.max(0, 1 - a / 0.15));
    const r = sB * shape(Math.max(0, 1 - (1 - a) / 0.15));
    return Math.max(0, 1 - Math.max(l, r));
  }
  // A trail: the head eases in over its first 15 %, the tail thins over the whole length.
  const head = sA * Math.max(0, 1 - a / 0.15);
  const tail = sB * shape(a);
  return Math.max(0, 1 - Math.max(head, tail));
}

function pushLine(buf, start, len) {
  const n = buf.nLines | 0;
  ensure(buf, 'start', Int32Array, n + 1);
  ensure(buf, 'len', Int32Array, n + 1);
  buf.start[n] = start; buf.len[n] = len;
  buf.nLines = n + 1;
}
function grow(buf, nPts) {
  if (buf.P && buf.P.length >= nPts * 3) return;
  const keep = buf.nPts | 0;
  const P = new Float32Array(Math.ceil(nPts * 1.6) * 3), HW = new Float32Array(P.length / 3), C = new Float32Array(P.length / 3 * 4);
  if (buf.P) { P.set(buf.P.subarray(0, keep * 3)); HW.set(buf.HW.subarray(0, keep)); C.set(buf.C.subarray(0, keep * 4)); }
  buf.P = P; buf.HW = HW; buf.C = C;
}

// ── Trails ───────────────────────────────────────────────────────────────────

const _pt = [0, 0, 0, 0];

/**
 * Uniform Catmull-Rom through a uid's snapshots at continuous parameter `s`
 * (snapshot index relative to its first). Uniform is RIGHT here: the samples
 * are uniform in TIME, so this is the cubic Hermite with finite-difference
 * velocities — the trajectory's own shape. Never reaches across a wrap break.
 */
function crAt(idx, u, s, o4) {
  const a = idx.off[u], n = idx.count[u], P = idx.pos, B = idx.brk;
  let j = Math.floor(s);
  if (j >= n - 1) j = n - 2;
  if (j < 0) j = 0;
  const f = clamp(s - j, 0, 1);
  const k1 = a + j, k2 = k1 + 1;
  const k0 = j > 0 && !B[k1] ? k1 - 1 : k1;
  const k3 = j + 2 < n && !B[k2 + 1] ? k2 + 1 : k2;
  const f2 = f * f, f3 = f2 * f;
  const c0 = -0.5 * f3 + f2 - 0.5 * f, c1 = 1.5 * f3 - 2.5 * f2 + 1;
  const c2 = -1.5 * f3 + 2 * f2 + 0.5 * f, c3 = 0.5 * f3 - 0.5 * f2;
  for (let c = 0; c < 3; c++) o4[c] = c0 * P[k0 * 3 + c] + c1 * P[k1 * 3 + c] + c2 * P[k2 * 3 + c] + c3 * P[k3 * 3 + c];
  o4[3] = idx.spd[k1] + (idx.spd[k2] - idx.spd[k1]) * f;
  return o4;
}

/**
 * Every visible trail at clip time `t` into `buf` (see `out`). Returns the
 * number of lines.
 *
 * The samples sit on a FIXED 1/smooth grid of snapshot time plus the exact
 * head and tail, so a curve does not shimmer as the playhead moves.
 */
export function buildTrailLines(idx, t, o, buf) {
  buf.nLines = 0; buf.nPts = 0;
  if (!idx) return 0;
  const hz = idx.hz;
  const sNow = clamp(t, 0, idx.lastSnap / hz) * hz;
  const Lsn = Math.max(0.01, o.length) * hz;
  const S = Math.max(1, o.smooth | 0);
  const list = idx.list;
  const hwBase = o.width * 0.5;
  for (let li = 0; li < list.length; li++) {
    const u = list[li];
    const a0 = idx.first[u];
    if (a0 > sNow) break;                         // birth order: nobody later is born yet
    if (o.share < 1 && hash01(u, 7) >= o.share) continue;
    const b0 = a0 + idx.count[u] - 1;
    const aliveToEnd = b0 >= idx.lastSnap;
    let head, tail, fadeMul = 1;
    if (sNow <= b0) {
      head = sNow;
      tail = o.shape === 'full' ? a0 : Math.max(a0, sNow - Lsn);
    } else {
      if (aliveToEnd || o.end === 'cut') continue;
      const deadFor = (sNow - b0) / hz;
      head = b0;
      if (o.end === 'retract') {
        // The tail runs on to the point where the particle stopped, over one
        // Length (for a full-life line, over Length seconds whatever its size).
        tail = o.shape === 'full' ? a0 + (sNow - b0) * ((b0 - a0) / Lsn) : Math.max(a0, sNow - Lsn);
        if (tail >= b0) continue;
      } else {
        tail = o.shape === 'full' ? a0 : Math.max(a0, b0 - Lsn);
        if (o.stayFade > 0) {
          fadeMul = 1 - deadFor / o.stayFade;
          if (fadeMul <= 0) continue;
        }
      }
    }
    if (head - tail < 0.05) continue;
    const rel0 = tail - a0, rel1 = head - a0, span = rel1 - rel0;
    // Upper bound: every snapshot in the window, each interval at full Smoothing.
    grow(buf, buf.nPts + (Math.ceil(rel1) - Math.floor(rel0) + 1) * S + 2);
    const { P, HW, C } = buf;
    const wRand = 1 - o.widthRandom * hash01(u, 3);
    const life = idx.life[u] || 1;
    const lifeIsClip = life >= ROWS_LIFE * 0.5;
    const age0 = idx.age0[u];
    const P0 = idx.off[u];
    const bx = idx.pos[P0 * 3], by = idx.pos[P0 * 3 + 1], bz = idx.pos[P0 * 3 + 2];
    let start = buf.nPts, prevJ = -1;
    const emit = (rs) => {
      // A wrap break between the previous sample and this one starts a new line.
      const j = Math.floor(rs);
      if (prevJ >= 0) {
        let broke = false;
        for (let q = j + 1; q <= prevJ; q++) if (idx.brk[P0 + q]) { broke = true; break; }
        if (broke) {
          if (buf.nPts - start >= 2) pushLine(buf, start, buf.nPts - start);
          start = buf.nPts;
        }
      }
      prevJ = j;
      crAt(idx, u, rs, _pt);
      const k = buf.nPts++;
      P[k * 3] = _pt[0]; P[k * 3 + 1] = _pt[1]; P[k * 3 + 2] = _pt[2];
      const al = (rel1 - rs) / span;                 // 0 head → 1 tail
      const ageHere = age0 + rs / hz;
      const moved = len3(_pt[0] - bx, _pt[1] - by, _pt[2] - bz);
      colourAt(o, lifeIsClip ? ageHere / o.duration : ageHere / life, _pt[3], al, moved, C, k * 4);
      C[k * 4 + 3] *= fadeMul * (1 - o.tailFade * Math.pow(al, o.fadeCurve));
      let w = hwBase * wRand * taperAt(al, o, false);
      if (o.speedWidth) {
        const sp = clamp((_pt[3] - o.velMin) / o.velSpan, 0, 1);
        w *= Math.max(0.05, 1 + o.speedWidth * (sp - 0.5) * 1.8);
      }
      if (o.movedWidth) w *= 1 + o.movedWidth * clamp(moved / o.movedRange, 0, 1);
      HW[k] = w;
    };
    const n = idx.count[u], Pp = idx.pos, B = idx.brk, CUM = idx.cum;
    // Sub-samples interval j → j+1 earns (see BEND_PX).
    const subOf = (j) => {
      if (S <= 1 || j < 0 || j >= n - 1) return 1;
      const k1 = P0 + j, k2 = k1 + 1;
      if (B[k2]) return 1;
      const k0 = j > 0 && !B[k1] ? k1 - 1 : k1;
      const k3 = j + 2 < n && !B[k2 + 1] ? k2 + 1 : k2;
      // Catmull-Rom midpoint − chord midpoint = (p1 + p2 − p0 − p3) / 16
      const dev = len3(
        Pp[k1 * 3] + Pp[k2 * 3] - Pp[k0 * 3] - Pp[k3 * 3],
        Pp[k1 * 3 + 1] + Pp[k2 * 3 + 1] - Pp[k0 * 3 + 1] - Pp[k3 * 3 + 1],
        Pp[k1 * 3 + 2] + Pp[k2 * 3 + 2] - Pp[k0 * 3 + 2] - Pp[k3 * 3 + 2]) / 16;
      if (dev < BEND_PX) return 1;
      return Math.max(1, Math.min(S, Math.ceil((CUM[k2] - CUM[k1]) / STEP_PX)));
    };
    // Whether snapshot point j is needed: ends, breaks, curves, and one per KEEP_PX.
    const keep = (j) => {
      if (j <= 0 || j >= n - 1) return true;
      const k = P0 + j;
      if (B[k] || B[k + 1] || subOf(j) > 1 || subOf(j - 1) > 1) return true;
      return Math.floor(CUM[k] / KEEP_PX) !== Math.floor(CUM[k - 1] / KEEP_PX);
    };
    emit(rel1);
    for (let j = Math.ceil(rel1) - 1, jBot = Math.floor(rel0); j >= jBot; j--) {
      const sj = subOf(j);
      for (let q = sj - 1; q >= 1; q--) { const f = j + q / sj; if (f < rel1 && f > rel0) emit(f); }
      if (j > rel0 && j < rel1 && keep(j)) emit(j);
    }
    emit(rel0);
    if (buf.nPts - start >= 2) pushLine(buf, start, buf.nPts - start);
    else buf.nPts = start;
  }
  return buf.nLines;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/**
 * Every row of a rows emitter at this instant, from one sample of the pool
 * (`sample` in SAMPLE_STRIDE layout with `uids`, `n` live — what sampleParticles
 * and the live engine both hand the renderer). A missing point (killed at a
 * wall) breaks its row rather than bridging the gap.
 */
export function buildRowLines(sample, uids, n, em, o, buf) {
  buf.nLines = 0; buf.nPts = 0;
  if (!em || em.shape !== 'rows' || !em.rows) return 0;
  const R = Math.max(1, em.rows.count | 0), Pn = Math.max(2, em.rows.points | 0), N = R * Pn;
  const X = ensure(buf, 'rx', Float32Array, N), Y = ensure(buf, 'ry', Float32Array, N), Z = ensure(buf, 'rz', Float32Array, N);
  const SP = ensure(buf, 'rs', Float32Array, N), AG = ensure(buf, 'ra', Float32Array, N);
  const HAS = ensure(buf, 'rh', Uint32Array, N);
  buf.stamp = ((buf.stamp | 0) + 1) >>> 0 || 1;
  const stamp = buf.stamp;
  for (let i = 0; i < n; i++) {
    const u = uids[i];
    if (u < 1) continue;
    const site = (u - 1) % N, k = i * SAMPLE_STRIDE;
    X[site] = sample[k]; Y[site] = sample[k + 1]; Z[site] = sample[k + 2];
    AG[site] = sample[k + 3];
    SP[site] = len3(sample[k + 5], sample[k + 6], sample[k + 7]);
    HAS[site] = stamp;
  }
  const S = Math.max(1, o.smooth | 0);
  const hw = o.width * 0.5;
  const rest = [0, 0, 0];
  // Pinned positions of one row, before smoothing.
  const PX = ensure(buf, 'qx', Float32Array, Pn), PY = ensure(buf, 'qy', Float32Array, Pn), PZ = ensure(buf, 'qz', Float32Array, Pn);
  const PD = ensure(buf, 'qd', Float32Array, Pn), PS = ensure(buf, 'qs', Float32Array, Pn), PA = ensure(buf, 'qa', Float32Array, Pn);
  for (let r = 0; r < R; r++) {
    const rowF = R > 1 ? r / (R - 1) : 0;
    let c = 0;
    while (c < Pn) {
      // One unbroken run of present points.
      while (c < Pn && HAS[r * Pn + c] !== stamp) c++;
      const c0 = c;
      while (c < Pn && HAS[r * Pn + c] === stamp) c++;
      const c1 = c;                                  // exclusive
      const m = c1 - c0;
      if (m < 2) continue;
      for (let q = 0; q < m; q++) {
        const site = r * Pn + c0 + q;
        rowsSiteOffset(rest, em, site);
        rest[0] += em.position.x; rest[1] += em.position.y; rest[2] += em.position.z;
        const cf = (c0 + q) / (Pn - 1);
        const pin = o.pinEnds > 0 ? smooth01(0, o.pinEnds, Math.min(cf, 1 - cf)) : 1;
        PX[q] = rest[0] + (X[site] - rest[0]) * pin;
        PY[q] = rest[1] + (Y[site] - rest[1]) * pin;
        PZ[q] = rest[2] + (Z[site] - rest[2]) * pin;
        PD[q] = len3(PX[q] - rest[0], PY[q] - rest[1], PZ[q] - rest[2]);
        PS[q] = SP[site] * pin;
        PA[q] = AG[site];
      }
      const cnt = (m - 1) * S + 1;
      grow(buf, buf.nPts + cnt);
      const { P, HW, C } = buf;
      const start = buf.nPts;
      for (let q = 0; q < m - 1; q++) {
        const q0 = Math.max(0, q - 1), q2 = q + 1, q3 = Math.min(m - 1, q + 2);
        // A straight stretch of row (most of it, at rest) needs no sub-samples.
        const dev = len3(PX[q] + PX[q2] - PX[q0] - PX[q3], PY[q] + PY[q2] - PY[q0] - PY[q3], PZ[q] + PZ[q2] - PZ[q0] - PZ[q3]) / 16;
        const Sq = dev < BEND_PX ? 1 : S;
        for (let s = 0; s < Sq; s++) {
          const f = s / Sq, f2 = f * f, f3 = f2 * f;
          const w0 = -0.5 * f3 + f2 - 0.5 * f, w1 = 1.5 * f3 - 2.5 * f2 + 1;
          const w2 = -1.5 * f3 + 2 * f2 + 0.5 * f, w3 = 0.5 * f3 - 0.5 * f2;
          const k = buf.nPts++;
          P[k * 3] = w0 * PX[q0] + w1 * PX[q] + w2 * PX[q2] + w3 * PX[q3];
          P[k * 3 + 1] = w0 * PY[q0] + w1 * PY[q] + w2 * PY[q2] + w3 * PY[q3];
          P[k * 3 + 2] = w0 * PZ[q0] + w1 * PZ[q] + w2 * PZ[q2] + w3 * PZ[q3];
          rowPoint(o, buf, k, (c0 + q + f) / (Pn - 1), rowF,
            PD[q] + (PD[q2] - PD[q]) * f, PS[q] + (PS[q2] - PS[q]) * f, PA[q], hw);
        }
      }
      const k = buf.nPts++;
      P[k * 3] = PX[m - 1]; P[k * 3 + 1] = PY[m - 1]; P[k * 3 + 2] = PZ[m - 1];
      rowPoint(o, buf, k, (c1 - 1) / (Pn - 1), rowF, PD[m - 1], PS[m - 1], PA[m - 1], hw);
      pushLine(buf, start, buf.nPts - start);
    }
  }
  return buf.nLines;
}

function rowPoint(o, buf, k, along, rowF, moved, speed, age, hw) {
  // 'along' runs DOWN the rows (top row → bottom row) — the gradient a stack of
  // lines reads as; along a single row it would only repeat the taper.
  colourAt(o, age / o.duration, speed, rowF, moved, buf.C, k * 4);
  let w = hw * taperAt(along, o, true);
  if (o.speedWidth) {
    const sp = clamp((speed - o.velMin) / o.velSpan, 0, 1);
    w *= Math.max(0.05, 1 + o.speedWidth * (sp - 0.5) * 1.8);
  }
  if (o.movedWidth) w *= 1 + o.movedWidth * clamp(moved / o.movedRange, 0, 1);
  buf.HW[k] = w;
}
