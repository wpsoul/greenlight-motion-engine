/*
 * OBJECT SHAPES — what a layer object is made of when Packing collides it by its
 * outline instead of as a circle (`packing.shape: 'object'`).
 *
 * Pure: no DOM, no three.js. The renderer rasterises each member's artwork into
 * an alpha mask (it has the canvas) and this turns the mask into a CLUMP — a
 * rigid set of circles that together fill the silhouette. The solver collides
 * clumps circle-against-circle, which keeps the whole contact machinery it
 * already has (the uniform grid, sleeping, the collider SDF, the walls) and only
 * adds a rotation to each body. A concave letter needs nothing special: the K's
 * notch and the O's hole are simply places with no circle in them.
 *
 * WHY CIRCLES AND NOT POLYGONS. A polygon solver (SAT, convex decomposition) is
 * the textbook answer and a second physics engine: it would share none of the
 * packing code, and letters would need decomposing into convex pieces first. A
 * clump is one more loop around the existing circle test.
 *
 * Also here: which member a particle IS. The renderer used to be the only one
 * that knew — objects were "a render-only concern" — and the solver cannot give
 * a particle the K's outline without knowing it is a K. Both sides now read the
 * same two functions, so they cannot disagree.
 */

import { hash32 } from './rng.js';

/**
 * The weighted pick table over the INCLUDED members: each member gets slots in
 * proportion to its weight (32 in total), at least one each.
 *
 * Moved here verbatim from particleLayer.js so the solver can reproduce the
 * draw's assignment exactly.
 */
export function objectPickTable(members) {
  const total = members.reduce((sum, m) => sum + Math.max(0, m.weight), 0);
  if (total <= 0) return members.map((_, i) => i);
  const table = [];
  for (let i = 0; i < members.length; i++) {
    const slots = Math.max(1, Math.round((Math.max(0, members[i].weight) / total) * 32));
    for (let k = 0; k < slots; k++) table.push(i);
  }
  return table.length ? table : members.map((_, i) => i);
}

/** Which included member particle `u` stamps. `random` is `objects.pick === 'random'`. */
export function objectMemberOf(u, table, random) {
  const slot = random ? hash32(u * 7 + 3) % table.length : u % table.length;
  return table[slot];
}

/** Longest side of the mask grid the clump is built on, in cells. */
export const CLUMP_GRID = 56;

/**
 * At most this many circles per object. Cost scales with it (a contact between
 * two objects is up to n x n circle tests), so it is a budget, not a quality
 * dial: 40 covers a bold condensed K or O to ~98% of its pixels.
 */
export const CLUMP_MAX = 40;

/*
 * Stop once this fraction of the silhouette is covered. The last few percent are
 * antialiased corners and serif tips, each of which would cost a circle of its
 * own for a sliver nobody can see overlap.
 */
const CLUMP_COVER = 0.985;

/**
 * Squared Euclidean distance transform, 1D (Felzenszwalb & Huttenlocher).
 * `f` holds 0 on background and a large number on foreground.
 */
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * A mask cell's distance to the nearest background cell centre, in cells. The
 * grid is padded by one background cell on every side, so artwork that touches
 * the edge of its raster still has an edge there.
 */
function distanceField(mask, gw, gh) {
  const W = gw + 2, H = gh + 2;
  const BIG = 1e12;
  const g = new Float64Array(W * H);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) if (mask[y * gw + x]) g[(y + 1) * W + x + 1] = BIG;
  }
  const n = Math.max(W, H);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = g[y * W + x];
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) g[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = g[y * W + x];
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) g[y * W + x] = d[x];
  }
  const out = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) out[y * gw + x] = Math.sqrt(g[(y + 1) * W + x + 1]);
  }
  return out;
}

/**
 * Grid size for an artwork drawn `aspect` (height / width) tall, with square
 * cells and CLUMP_GRID cells along the longer side.
 */
export function clumpGridSize(aspect) {
  const a = Math.max(0.01, aspect || 1);
  return a >= 1
    ? { gw: Math.max(2, Math.round(CLUMP_GRID / a)), gh: CLUMP_GRID }
    : { gw: CLUMP_GRID, gh: Math.max(2, Math.round(CLUMP_GRID * a)) };
}

/**
 * Build a clump from an alpha mask.
 *
 *   alpha   Uint8Array(gw * gh), row 0 is the TOP of the artwork (canvas order)
 *   aspect  height / width of the quad the artwork is DRAWN on
 *
 * Every length it returns is in units of the drawn quad's WIDTH, +y UP (the
 * solver's convention), so the solver scales it by the particle's drawn size.
 * Circle centres are relative to the silhouette's CENTRE OF MASS, which is what
 * the body rotates about; `comX/comY` is where that centre sits relative to the
 * quad's middle, so the draw can put the artwork back where the body is.
 *
 * Circles come from a greedy cover of the distance field: take the uncovered
 * pixel deepest inside the shape, place the largest circle that stays inside
 * it, mark what it covers, repeat. Deepest-first puts the big circles down the
 * middle of each stroke and the small ones into corners; every circle touches
 * the true edge, so the clump's outline IS the artwork's outline at those
 * points and a little inside it between them.
 */
export function clumpFromMask(alpha, gw, gh, aspect, threshold = 128) {
  const N = gw * gh;
  const mask = new Uint8Array(N);
  let count = 0;
  for (let i = 0; i < N; i++) if (alpha[i] >= threshold) { mask[i] = 1; count++; }

  // Cell size in quad-width units. Cells are square to within a rounding step,
  // so one size serves both axes for distances.
  const csx = 1 / gw;
  const csy = Math.max(0.01, aspect || 1) / gh;
  const cs = (csx + csy) * 0.5;
  const cellX = (x) => (x + 0.5) * csx - 0.5;
  const cellY = (y) => (0.5 - (y + 0.5) / gh) * Math.max(0.01, aspect || 1);

  if (count === 0) {
    // Nothing opaque (or nothing readable): collide as the quad's inscribed
    // circle, which is what the circle mode would have done.
    return {
      n: 1, x: new Float32Array([0]), y: new Float32Array([0]), r: new Float32Array([0.5]),
      comX: 0, comY: 0, area: Math.PI * 0.25, inertia: Math.PI * 0.25 * 0.125, bound: 0.5, cover: 0,
    };
  }

  // Mass properties from the silhouette itself, not from the circles: the
  // circles are a collision proxy, the artwork is what has weight.
  let sx = 0, sy = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) if (mask[y * gw + x]) { sx += cellX(x); sy += cellY(y); }
  }
  const comX = sx / count, comY = sy / count;
  const cellArea = csx * csy;
  let inertia = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (!mask[y * gw + x]) continue;
      const dx = cellX(x) - comX, dy = cellY(y) - comY;
      inertia += (dx * dx + dy * dy) * cellArea;
    }
  }
  const area = count * cellArea;
  inertia += area * (csx * csx + csy * csy) / 12;

  // Inscribed radius at each foreground cell, in cells: the distance to the
  // nearest background CENTRE, less half a cell to reach its EDGE.
  const dist = distanceField(mask, gw, gh);
  const covered = new Uint8Array(N);
  let left = count;
  const target = count * (1 - CLUMP_COVER);
  const xs = [], ys = [], rs = [];
  while (xs.length < CLUMP_MAX && left > target) {
    let best = -1, bestD = -1;
    for (let i = 0; i < N; i++) {
      if (!mask[i] || covered[i]) continue;
      if (dist[i] > bestD) { bestD = dist[i]; best = i; }
    }
    if (best < 0) break;
    const bx = best % gw, by = (best / gw) | 0;
    const rc = Math.max(0.5, bestD - 0.5);          // cells
    // Cells whose centres the circle reaches are covered. Reaching half a cell
    // further counts the pixels the circle's edge runs through.
    const reach = rc + 0.5;
    const x0 = Math.max(0, Math.floor(bx - reach)), x1 = Math.min(gw - 1, Math.ceil(bx + reach));
    const y0 = Math.max(0, Math.floor(by - reach)), y1 = Math.min(gh - 1, Math.ceil(by + reach));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * gw + x;
        if (!mask[i] || covered[i]) continue;
        const dx = x - bx, dy = y - by;
        if (dx * dx + dy * dy <= reach * reach) { covered[i] = 1; left--; }
      }
    }
    xs.push(cellX(bx) - comX);
    ys.push(cellY(by) - comY);
    rs.push(rc * cs);
  }

  const n = xs.length;
  const X = new Float32Array(xs), Y = new Float32Array(ys), R = new Float32Array(rs);
  let bound = 0;
  for (let k = 0; k < n; k++) bound = Math.max(bound, Math.hypot(X[k], Y[k]) + R[k]);
  return { n, x: X, y: Y, r: R, comX, comY, area, inertia, bound, cover: 1 - left / count };
}

/**
 * Split a clump's circles into a few COMPACT groups, each with its own bounding
 * circle, so a contact test can throw away whole groups at once.
 *
 * THIS IS WHERE SHAPE MODE'S COST WENT. Two touching letters are two bounding
 * circles that overlap a lot — a tall K's bounding circle is most of a letter
 * wide — so "is this circle anywhere near the other letter" rejected almost
 * nothing, and the contact test walked ~40 x 40 circle pairs. Measured on a
 * 65-letter pile: 3.2 s of a 3.4 s bake was the narrow phase. With groups the
 * test is group against group first, and only the few group pairs that touch
 * walk their circles.
 *
 * Farthest-point seeds and a few rounds of k-means over the circle centres:
 * deterministic (no random init), and compact — which a split into bands along
 * the long axis is not: a band through an O holds both of its sides.
 */
function groupClump(c) {
  const n = c.n;
  const G = Math.max(1, Math.min(6, Math.round(n / 7)));
  const assign = new Int32Array(n);
  if (G > 1) {
    const sx = new Float64Array(G), sy = new Float64Array(G);
    sx[0] = c.x[0]; sy[0] = c.y[0];
    const dmin = new Float64Array(n).fill(Infinity);
    for (let g = 1; g < G; g++) {
      let far = 0, farD = -1;
      for (let k = 0; k < n; k++) {
        const d = (c.x[k] - sx[g - 1]) ** 2 + (c.y[k] - sy[g - 1]) ** 2;
        if (d < dmin[k]) dmin[k] = d;
        if (dmin[k] > farD) { farD = dmin[k]; far = k; }
      }
      sx[g] = c.x[far]; sy[g] = c.y[far];
    }
    for (let it = 0; it < 8; it++) {
      for (let k = 0; k < n; k++) {
        let best = 0, bestD = Infinity;
        for (let g = 0; g < G; g++) {
          const d = (c.x[k] - sx[g]) ** 2 + (c.y[k] - sy[g]) ** 2;
          if (d < bestD) { bestD = d; best = g; }
        }
        assign[k] = best;
      }
      const ax = new Float64Array(G), ay = new Float64Array(G), an = new Float64Array(G);
      for (let k = 0; k < n; k++) { ax[assign[k]] += c.x[k]; ay[assign[k]] += c.y[k]; an[assign[k]]++; }
      for (let g = 0; g < G; g++) if (an[g]) { sx[g] = ax[g] / an[g]; sy[g] = ay[g] / an[g]; }
    }
  }
  const groups = [];
  for (let g = 0; g < G; g++) {
    const idx = [];
    for (let k = 0; k < n; k++) if (assign[k] === g) idx.push(k);
    if (!idx.length) continue;
    // Bounding circle: centred on the group's extent, reaching its farthest rim.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const k of idx) {
      x0 = Math.min(x0, c.x[k] - c.r[k]); x1 = Math.max(x1, c.x[k] + c.r[k]);
      y0 = Math.min(y0, c.y[k] - c.r[k]); y1 = Math.max(y1, c.y[k] + c.r[k]);
    }
    const gx = (x0 + x1) / 2, gy = (y0 + y1) / 2;
    let gr = 0;
    for (const k of idx) gr = Math.max(gr, Math.hypot(c.x[k] - gx, c.y[k] - gy) + c.r[k]);
    groups.push({ idx, x: gx, y: gy, r: gr });
  }
  return groups;
}

/**
 * Flatten one clump per included member into the bag of typed arrays the
 * worker receives (spawnPayload only carries top-level numbers, strings and
 * typed arrays — see client.js).
 *
 *   mg       groups of member m are mg[m] .. mg[m + 1] - 1
 *   gOffs    circles of group g are gOffs[g] .. gOffs[g + 1] - 1
 *   gx gy gr group bounding circle (relative to the centre of mass)
 *   offs     circles of member m are offs[m] .. offs[m + 1] - 1 (all groups)
 *   cx cy cr circle centre (relative to the centre of mass) and radius
 *   area inert bound comX comY meanR   per member
 */
export function packClumps(clumps, key) {
  const count = clumps.length;
  const grouped = clumps.map(groupClump);
  const offs = new Int32Array(count + 1);
  const mg = new Int32Array(count + 1);
  let total = 0, totalG = 0;
  for (let m = 0; m < count; m++) {
    offs[m] = total; total += clumps[m].n;
    mg[m] = totalG; totalG += grouped[m].length;
  }
  offs[count] = total; mg[count] = totalG;
  const cx = new Float32Array(total), cy = new Float32Array(total), cr = new Float32Array(total);
  const gOffs = new Int32Array(totalG + 1);
  const gx = new Float32Array(totalG), gy = new Float32Array(totalG), gr = new Float32Array(totalG);
  const area = new Float32Array(count), inert = new Float32Array(count), bound = new Float32Array(count);
  const comX = new Float32Array(count), comY = new Float32Array(count), meanR = new Float32Array(count);
  let ci = 0, gi = 0;
  for (let m = 0; m < count; m++) {
    const c = clumps[m];
    // Circles are stored GROUP BY GROUP, so a group is a contiguous range.
    for (const g of grouped[m]) {
      gOffs[gi] = ci;
      gx[gi] = g.x; gy[gi] = g.y; gr[gi] = g.r;
      for (const k of g.idx) { cx[ci] = c.x[k]; cy[ci] = c.y[k]; cr[ci] = c.r[k]; ci++; }
      gi++;
    }
    area[m] = c.area; inert[m] = c.inertia; bound[m] = c.bound;
    comX[m] = c.comX; comY[m] = c.comY;
    let s = 0;
    for (let k = 0; k < c.n; k++) s += c.r[k];
    meanR[m] = c.n ? s / c.n : 0.5;
  }
  gOffs[totalG] = ci;
  return { key, count, offs, cx, cy, cr, mg, gOffs, gx, gy, gr, area, inert, bound, comX, comY, meanR };
}

/**
 * Do two posed clumps overlap? Member `ma` at (ax, ay) turned to (ac, as) =
 * (cos, sin) and scaled by `sa`, against member `mb` likewise; circles count
 * as touching inside `k` x their summed radii (k < 1 allows an interlock).
 * Used to decide whether a birth has room — never inside the solver's step.
 */
export function clumpsOverlap(D, ma, ax, ay, ac, as, sa, mb, bx, by, bc, bs, sb, k) {
  for (let g = D.mg[ma]; g < D.mg[ma + 1]; g++) {
    const gra = D.gr[g] * sa;
    const gax = ax + (ac * D.gx[g] - as * D.gy[g]) * sa, gay = ay + (as * D.gx[g] + ac * D.gy[g]) * sa;
    for (let h = D.mg[mb]; h < D.mg[mb + 1]; h++) {
      const grb = D.gr[h] * sb;
      const gbx = bx + (bc * D.gx[h] - bs * D.gy[h]) * sb, gby = by + (bs * D.gx[h] + bc * D.gy[h]) * sb;
      const lim = (gra + grb) * k;
      if ((gbx - gax) ** 2 + (gby - gay) ** 2 > lim * lim) continue;
      for (let a = D.gOffs[g]; a < D.gOffs[g + 1]; a++) {
        const ra = D.cr[a] * sa;
        const px = ax + (ac * D.cx[a] - as * D.cy[a]) * sa, py = ay + (as * D.cx[a] + ac * D.cy[a]) * sa;
        for (let b = D.gOffs[h]; b < D.gOffs[h + 1]; b++) {
          const rb = D.cr[b] * sb;
          const qx = bx + (bc * D.cx[b] - bs * D.cy[b]) * sb, qy = by + (bs * D.cx[b] + bc * D.cy[b]) * sb;
          const rr = (ra + rb) * k;
          if ((qx - px) ** 2 + (qy - py) ** 2 < rr * rr) return true;
        }
      }
    }
  }
  return false;
}
