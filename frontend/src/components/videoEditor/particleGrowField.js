// Particle Activation · Grow Points — the arrival-time field.
//
// Grow Fill's bake, with the paint step removed. A multi-source Dijkstra runs
// over the emitter artwork's alpha (8-connected, per-node cost 1/speed, seed
// delays folded in, bridges to cross a gap at a toll), and each EMISSION SITE
// reads its arrival out of the finished field. The solver then treats that
// arrival as a spawn — or a release — time.
//
// NOT a Euclidean distance transform. Euclidean leaps across the hole in a D and
// the far side of a letter lights up before its own stem; travelling through the
// artwork is the whole reason the front reads as the picture coming apart rather
// than a wipe passing over it. It is the same decision, for the same reason, as
// autofillField.js — see PLANS/AUTOFILL_PLAN.md.
//
// Lives next to particleObjectRaster because it needs the rasterised artwork;
// everything below the raster read is pure and could move into a worker.

import { ensureObjectRaster, ctx2d, EMITTER_RASTER_PX } from './particleObjectRaster';
import { hash32 } from '../../sim/particles/rng.js';
import { vnoise3 } from '../../sim/particles/fields.js';

// The field grid. 192 x 108 is the same order as Grow Fill's 480 x 270 scaled to
// what a particle system needs: sites are sampled far more coarsely than pixels,
// so a finer grid buys nothing and costs a Dijkstra.
const GW = 192, GH = 108;
const MAX_FIELDS = 6;
const cache = new Map();   // key -> { arrival, unreachable, ms }

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);

/**
 * Identity of the FIELD. Everything the Dijkstra reads, nothing else — `start`,
 * `speed` and `softness` shape the schedule, not the field, so dragging Speed
 * must not rebuild it (it still re-bakes, which is unavoidable).
 */
export function growFieldKey(source, A, count) {
  if (!source || !A || A.mode !== 'grow') return '';
  const pts = (A.points || []).map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)},${(p.delay || 0).toFixed(3)}`).join(';');
  return [
    source.kind, source.url || source.text || '', source.fontFamily || '', source.fontWeight || '',
    source.fontSize || '', Array.isArray(source.points) ? source.points.length : 0,
    count, A.from, A.seedCount, A.seedStagger, A.speedMap, A.noiseScale, A.noiseContrast, A.noiseSeed,
    A.bridges ? 1 : 0, A.bridgeReach, A.bridgeSlow, pts,
  ].join('|');
}

/**
 * Arrival in 0..1 for every site in `positions` (unit space, +y up), or null
 * while the artwork is still decoding. Cached by growFieldKey.
 */
export function ensureGrowField(source, A, positions, count, key) {
  if (!key) return null;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  // The SAME raster the sites came from — a field baked from a different
  // resolution of the artwork would put the front slightly off its own particles.
  const raster = ensureObjectRaster(source, EMITTER_RASTER_PX);
  if (!raster?.ready || !raster.canvas) return null;   // decoding; try next frame

  let data;
  try {
    const ctx = ctx2d(raster.canvas);
    data = ctx.getImageData(0, 0, raster.canvas.width, raster.canvas.height).data;
  } catch {
    // A cross-origin image taints the canvas. Without a mask there is no field;
    // the solver falls back to activating everything at once.
    cache.set(key, null);
    return null;
  }

  const built = buildField(data, raster.canvas.width, raster.canvas.height, A, positions, count);
  if (cache.size >= MAX_FIELDS) cache.delete(cache.keys().next().value);
  cache.set(key, built);
  return built;
}

function buildField(rgba, srcW, srcH, A, positions, count) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
  const n = GW * GH;
  const inside = new Uint8Array(n);      // 1 = artwork, 2 = bridge corridor
  const speed = new Float32Array(n).fill(1);

  // Downsample the alpha with a MAX over each block: a thin stem that averages
  // away would cut the only path along a letter.
  const bx = srcW / GW, by = srcH / GH;
  for (let gy = 0; gy < GH; gy++) {
    const y0 = Math.floor(gy * by), y1 = Math.min(srcH, Math.ceil((gy + 1) * by));
    for (let gx = 0; gx < GW; gx++) {
      const x0 = Math.floor(gx * bx), x1 = Math.min(srcW, Math.ceil((gx + 1) * bx));
      let mx = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const a = rgba[(y * srcW + x) * 4 + 3];
          if (a > mx) mx = a;
        }
      }
      if (mx > 24) inside[gy * GW + gx] = 1;
    }
  }

  // Bridges: dilate the PATHFINDING domain, never the render. Reach is authored
  // in source pixels — one grid cell is several of them, and treating the two as
  // the same unit dilates a whole word into one slab that lights up at once.
  if (A.bridges && A.bridgeReach > 0) {
    const steps = Math.max(1, Math.round(A.bridgeReach * (GW / srcW)));
    let cur = inside.slice();
    for (let s = 0; s < steps; s++) {
      const next = cur.slice();
      for (let gy = 0; gy < GH; gy++) {
        for (let gx = 0; gx < GW; gx++) {
          if (cur[gy * GW + gx]) continue;
          let touch = false;
          for (let dy = -1; dy <= 1 && !touch; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const x = gx + dx, y = gy + dy;
              if (x < 0 || y < 0 || x >= GW || y >= GH) continue;
              if (cur[y * GW + x]) { touch = true; break; }
            }
          }
          if (touch) next[gy * GW + gx] = 2;
        }
      }
      cur = next;
    }
    inside.set(cur);
  }

  // Speed map: uniform, or noise-modulated so the front eats through the artwork
  // unevenly — the difference between a ruler and a flame front.
  if (A.speedMap === 'turbulent') {
    const wl = Math.max(2, A.noiseScale / 6);
    const contrast = clamp01(A.noiseContrast / 100);
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        const nz = vnoise3(gx / wl, gy / wl, 0, A.noiseSeed) * 0.6
                 + vnoise3((gx / wl) * 2.1, (gy / wl) * 2.1, 11.3, A.noiseSeed + 7) * 0.4;
        speed[gy * GW + gx] = Math.max(1 - contrast * 0.92 * (1 - clamp01(nz)), 0.06);
      }
    }
  }
  for (let i = 0; i < n; i++) if (inside[i] === 2) speed[i] /= Math.max(1, A.bridgeSlow);

  const seeds = resolveSeeds(inside, A);
  const dist = new Float64Array(n).fill(Infinity);
  const heapT = new Float64Array(n * 4);
  const heapI = new Int32Array(n * 4);
  let hn = 0;

  const push = (t, i) => {
    if (hn >= heapT.length) return;
    let j = hn++; heapT[j] = t; heapI[j] = i;
    while (j > 0) {
      const p = (j - 1) >> 1;
      if (heapT[p] <= heapT[j]) break;
      const tt = heapT[p], ti = heapI[p];
      heapT[p] = heapT[j]; heapI[p] = heapI[j]; heapT[j] = tt; heapI[j] = ti; j = p;
    }
  };

  const run = (list) => {
    dist.fill(Infinity); hn = 0;
    for (const s of list) {
      if (s.idx < 0 || s.idx >= n || !inside[s.idx]) continue;
      if (s.t0 < dist[s.idx]) { dist[s.idx] = s.t0; push(s.t0, s.idx); }
    }
    while (hn > 0) {
      const t = heapT[0], i = heapI[0];
      hn--;
      heapT[0] = heapT[hn]; heapI[0] = heapI[hn];
      let j = 0;
      for (;;) {
        const l = j * 2 + 1, r = l + 1; let m = j;
        if (l < hn && heapT[l] < heapT[m]) m = l;
        if (r < hn && heapT[r] < heapT[m]) m = r;
        if (m === j) break;
        const tt = heapT[m], ti = heapI[m];
        heapT[m] = heapT[j]; heapI[m] = heapI[j]; heapT[j] = tt; heapI[j] = ti; j = m;
      }
      if (t > dist[i]) continue;
      const gx = i % GW, gy = (i / GW) | 0;
      const ci = 1 / speed[i];
      // 8-connected, never 16-conn or knight moves: that experiment in the Grow
      // Fill lab blew the bake from 30 ms to 360 ms for a marginal gain, and one
      // smoothing pass buys the same roundness for nothing.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const x = gx + dx, y = gy + dy;
          if (x < 0 || y < 0 || x >= GW || y >= GH) continue;
          const b = y * GW + x;
          if (!inside[b]) continue;
          const len = (dx && dy) ? 1.41421356 : 1;
          const nt = t + len * (ci + 1 / speed[b]) * 0.5;
          if (nt < dist[b]) { dist[b] = nt; push(nt, b); }
        }
      }
    }
    let mx = 0;
    for (let i = 0; i < n; i++) if (Number.isFinite(dist[i]) && dist[i] > mx) mx = dist[i];
    return mx;
  };

  // Two passes when the seeds are staggered: the first learns the span, so a
  // delay expressed as a share of the whole sweep means the same at any size.
  let span = run(seeds.map((s) => ({ idx: s.idx, t0: 0 })));
  if (seeds.some((s) => s.delay > 0) && span > 0) {
    span = run(seeds.map((s) => ({ idx: s.idx, t0: s.delay * span })));
  }
  span = Math.max(span, 1e-9);

  // ── The overflow pass: NOTHING may be left unreachable ────────────────────
  //
  // A word's letters are separate islands. If Reach does not clear the gap, the
  // Dijkstra above finishes with most of them at infinity — and giving those a
  // fixed arrival (1, or anything else) means the sweep eats one letter and then
  // the ENTIRE REST OF THE WORD activates on the same frame. That block pop is
  // the single worst thing this feature can do, and no setting should be able to
  // cause it.
  //
  // So the front always continues, off the artwork, at a toll: a second Dijkstra
  // over the WHOLE grid, seeded from everything the first pass reached, with
  // off-artwork travel costing `bridgeSlow`x (or a lot more with Bridges off, so
  // an island still arrives late — but in ORDER, spread over time, not as a lump).
  const offCost = A.bridges ? Math.max(1, A.bridgeSlow) : 12;
  {
    const seedList = [];
    for (let i = 0; i < n; i++) if (Number.isFinite(dist[i])) seedList.push(i);
    if (seedList.length && seedList.length < n) {
      hn = 0;
      for (const i of seedList) push(dist[i], i);
      while (hn > 0) {
        const t = heapT[0], i = heapI[0];
        hn--;
        heapT[0] = heapT[hn]; heapI[0] = heapI[hn];
        let j = 0;
        for (;;) {
          const l = j * 2 + 1, r = l + 1; let m = j;
          if (l < hn && heapT[l] < heapT[m]) m = l;
          if (r < hn && heapT[r] < heapT[m]) m = r;
          if (m === j) break;
          const tt = heapT[m], ti = heapI[m];
          heapT[m] = heapT[j]; heapI[m] = heapI[j]; heapT[j] = tt; heapI[j] = ti; j = m;
        }
        if (t > dist[i]) continue;
        const gx = i % GW, gy = (i / GW) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const x = gx + dx, y = gy + dy;
            if (x < 0 || y < 0 || x >= GW || y >= GH) continue;
            const b = y * GW + x;
            const len = (dx && dy) ? 1.41421356 : 1;
            // Crossing empty space costs; arriving back ON artwork is normal again.
            const nt = t + len * (inside[b] ? 1 : offCost);
            if (nt < dist[b]) { dist[b] = nt; push(nt, b); }
          }
        }
      }
    }
  }

  // One Laplacian pass — the same role as Grow Fill's masked blur: it rounds the
  // metric's faceting without moving the front.
  const sm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(dist[i])) { sm[i] = dist[i]; continue; }
    const gx = i % GW, gy = (i / GW) | 0;
    let s = dist[i] * 2, w = 2;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = gx + dx, y = gy + dy;
        if (x < 0 || y < 0 || x >= GW || y >= GH) continue;
        const d = dist[y * GW + x];
        if (Number.isFinite(d)) { s += d; w += 1; }
      }
    }
    sm[i] = s / w;
  }

  // Scatter to sites, and normalise by the LAST SITE rather than by the artwork
  // pass's span. Normalising by the earlier span would push everything the
  // overflow pass reached past 1, where it clamps — which is exactly the block
  // pop the overflow pass exists to remove.
  const arrival = new Float32Array(count);
  const raw = new Float64Array(count);
  let unreachable = 0;
  let last = 0;
  for (let i = 0; i < count; i++) {
    const gx = clamp(Math.floor((positions[i * 2] + 0.5) * GW), 0, GW - 1);
    const gy = clamp(Math.floor((0.5 - positions[i * 2 + 1]) * GH), 0, GH - 1);
    const d = sm[gy * GW + gx];
    if (!Number.isFinite(d)) { raw[i] = -1; unreachable++; continue; }
    raw[i] = d;
    if (d > last) last = d;
  }
  const norm = Math.max(last, 1e-9);
  for (let i = 0; i < count; i++) {
    // Only a site with no path at all — an empty mask — is left at the end now.
    arrival[i] = raw[i] < 0 ? 1 : clamp01(raw[i] / norm);
  }

  return {
    arrival,
    unreachable,
    ms: (typeof performance !== 'undefined' ? performance.now() : 0) - t0,
  };
}

/** Seed cells: the hand-placed points, or the From preset as a fallback. */
function resolveSeeds(inside, A) {
  const cells = [];
  for (let i = 0; i < GW * GH; i++) if (inside[i] === 1) cells.push(i);
  if (!cells.length) return [];
  const at = (c) => ({ x: c % GW, y: (c / GW) | 0 });

  if (A.points && A.points.length) {
    // Nearest cell that is actually artwork, so a click just off a letter still
    // starts the sweep at the nearest pixel instead of nowhere.
    return A.points.map((p) => {
      const tx = clamp(Math.round((p.x + 0.5) * GW), 0, GW - 1);
      const ty = clamp(Math.round((0.5 - p.y) * GH), 0, GH - 1);
      let best = cells[0], bd = Infinity;
      for (const c of cells) {
        const q = at(c);
        const d = (q.x - tx) * (q.x - tx) + (q.y - ty) * (q.y - ty);
        if (d < bd) { bd = d; best = c; }
      }
      return { idx: best, delay: clamp01(p.delay || 0) };
    });
  }

  const count = clamp(Math.round(A.seedCount), 1, 8);
  const picked = [];
  // Seeded, never Math.random: the same system must bake to the same field on
  // every machine and every re-open.
  const pick = (k, pool) => pool[hash32(k * 2654435761 + 17) % pool.length];
  if (A.from === 'scatter') {
    for (let k = 0; k < count; k++) picked.push(pick(k, cells));
  } else if (A.from === 'center') {
    let cx = 0, cy = 0;
    for (const c of cells) { const q = at(c); cx += q.x; cy += q.y; }
    cx /= cells.length; cy /= cells.length;
    let best = cells[0], bd = Infinity;
    for (const c of cells) {
      const q = at(c);
      const d = (q.x - cx) * (q.x - cx) + (q.y - cy) * (q.y - cy);
      if (d < bd) { bd = d; best = c; }
    }
    picked.push(best);
    for (let k = 1; k < count; k++) picked.push(pick(k + 31, cells));
  } else {
    const axis = (A.from === 'top' || A.from === 'bottom') ? 'y' : 'x';
    const flip = (A.from === 'right' || A.from === 'bottom');
    let bestV = flip ? -Infinity : Infinity;
    for (const c of cells) {
      const v = at(c)[axis];
      if (flip ? v > bestV : v < bestV) bestV = v;
    }
    const tol = axis === 'x' ? GW * 0.04 : GH * 0.06;
    const band = cells.filter((c) => Math.abs(at(c)[axis] - bestV) <= tol);
    const pool = band.length ? band : cells;
    for (let k = 0; k < count; k++) picked.push(pick(k + 61, pool));
  }
  const stagger = clamp01(A.seedStagger / 100);
  return picked.map((idx, i) => ({ idx, delay: count > 1 ? stagger * (i / (count - 1)) : 0 }));
}

export function clearGrowFields() {
  cache.clear();
}
