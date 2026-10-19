// The FLUID force field — a grid the emission stirs and the particles ride.
//
// A leaf module like fields.js: no DOM, no three.js, no editor imports, so the
// solver, the bake worker and the tests share one implementation.
//
// WHAT THIS IS
// ------------
// Every other force in the solver is a formula in (p, t). This one is a
// SIMULATION: an incompressible velocity field on a coarse grid (Stam's stable
// fluids — splat → forces → semi-Lagrangian advect → diffuse → pressure
// project), which is what gives smoke a memory: a plume meets the eddies it
// left behind. It fits the bake exactly — the grid steps at STEP_DT with the
// particles and is thrown away with the pool; only particle snapshots are
// cached. Units are composition pixels in the box's local space, +y up.
//
// The passes here were tuned and verified in html/fluid-particles-lab.html
// against a WebGPU twin; the constants are the lab's. Three things in the
// physics that were found the hard way and must stay:
//   * OPEN bounds need all three of: Dirichlet pressure outside the box, an
//     absorbing sponge in the outer cells, and a CFL clamp in advection. With
//     buoyancy and no back-pressure the field otherwise runs away.
//   * Vorticity confinement injects energy at cell scale everywhere; without an
//     unsteady source (emission variance, in solver.js) every plume becomes a
//     carpet of same-sized curls.
//   * A collider is solid to the FIELD too: velocity dies in solid cells, so the
//     projection routes the flow around it — no extra force needed.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

/** Grid resolutions by fidelity key (schema: PARTICLE_FLUID_FIDELITIES). */
export const FLUID_FIDELITY = {
  low: { nx: 48, ny: 27, nz: 12 },
  medium: { nx: 64, ny: 36, nz: 16 },
  high: { nx: 96, ny: 54, nz: 24 },
  ultra: { nx: 128, ny: 72, nz: 32 },
  // Ultra's cell budget spent in-plane — thin columns need in-plane resolution.
  'flat-hd': { nx: 256, ny: 144, nz: 8 },
  // Cubic ~10 px cells, for looks that are seen in depth.
  'volume-hd': { nx: 192, ny: 108, nz: 48 },
};

/**
 * A fidelity's cell budget laid out at the BOX's aspect. The table above is
 * 16:9; a portrait box used to get the same 16:9 grid stretched over it — cells
 * twice as tall as wide, a cigarette column two cells wide — so the grid keeps
 * its in-plane cell count and follows the box instead. Exact at 16:9 (every
 * table entry is 16:9), so 1080p projects are byte-identical.
 */
export function fluidGridDims(fidelity, box) {
  const d = FLUID_FIDELITY[fidelity] || FLUID_FIDELITY.medium;
  const a = box && box.x > 0 && box.y > 0 ? box.x / box.y : 16 / 9;
  const cells = d.nx * d.ny;
  const nx = Math.max(8, Math.round(Math.sqrt(cells * a)));
  const ny = Math.max(8, Math.round(cells / nx));
  return { nx, ny, nz: d.nz };
}

/** Allocate a grid spanning `box` ({x, y, z} full sizes, centred on the origin). */
export function makeFluidGrid(fidelity, box) {
  const dims = fluidGridDims(fidelity, box);
  const { nx, ny, nz } = dims;
  const n = nx * ny * nz;
  const f = () => new Float32Array(n);
  return {
    nx, ny, nz, n,
    box: { x: box.x, y: box.y, z: box.z },
    hx: box.x / nx, hy: box.y / ny, hz: box.z / nz,
    vx: f(), vy: f(), vz: f(), vx2: f(), vy2: f(), vz2: f(),
    den: f(), den2: f(), heat: f(), heat2: f(),
    prs: f(), prs2: f(), div: f(),
    // Curl (xyz + magnitude) for confinement; free between forces and
    // divergence, so they double as the MacCormack backward temp.
    cx: f(), cy: f(), cz: f(), cm: f(),
    // Per-column ink mask from the collider (nx*ny), or null.
    maskInk: null,
    // Clamped neighbour indices per axis. The hot loops index through these
    // instead of calling a clamping closure per neighbour — V8 does not reliably
    // inline the closure, and the pressure solve alone reads six neighbours per
    // cell per iteration, twenty iterations a step.
    im: Int32Array.from({ length: nx }, (_, i) => Math.max(0, i - 1)),
    ip: Int32Array.from({ length: nx }, (_, i) => Math.min(nx - 1, i + 1)),
    jm: Int32Array.from({ length: ny }, (_, j) => Math.max(0, j - 1)),
    jp: Int32Array.from({ length: ny }, (_, j) => Math.min(ny - 1, j + 1)),
    km: Int32Array.from({ length: nz }, (_, k) => Math.max(0, k - 1)),
    kp: Int32Array.from({ length: nz }, (_, k) => Math.min(nz - 1, k + 1)),
  };
}

/* world → continuous cell coords (cell centres at integers) */
const gX = (g, x) => (x + g.box.x / 2) / g.hx - 0.5;
const gY = (g, y) => (y + g.box.y / 2) / g.hy - 0.5;
const gZ = (g, z) => (z + g.box.z / 2) / g.hz - 0.5;

/** Trilinear read of one grid array at continuous cell coords (clamped). */
export function triSample(g, a, x, y, z) {
  const { nx, ny, nz } = g;
  const x0 = clamp(Math.floor(x), 0, nx - 1), y0 = clamp(Math.floor(y), 0, ny - 1), z0 = clamp(Math.floor(z), 0, nz - 1);
  const x1 = Math.min(nx - 1, x0 + 1), y1 = Math.min(ny - 1, y0 + 1), z1 = Math.min(nz - 1, z0 + 1);
  const fx = clamp(x - x0, 0, 1), fy = clamp(y - y0, 0, 1), fz = clamp(z - z0, 0, 1);
  const nxy = nx * ny;
  const o00 = x0 + nx * y0 + nxy * z0, o10 = x1 + nx * y0 + nxy * z0;
  const o01 = x0 + nx * y1 + nxy * z0, o11 = x1 + nx * y1 + nxy * z0;
  const c00 = lerp(a[o00], a[o10], fx), c10 = lerp(a[o01], a[o11], fx);
  const dz = nxy * (z1 - z0);
  const c01 = lerp(a[o00 + dz], a[o10 + dz], fx), c11 = lerp(a[o01 + dz], a[o11 + dz], fx);
  return lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz);
}

/** The field's velocity at a world point, written into `out` (length 3). */
export function fluidVelocityAt(g, out, x, y, z) {
  const cx = gX(g, x), cy = gY(g, y), cz = gZ(g, z);
  out[0] = triSample(g, g.vx, cx, cy, cz);
  out[1] = triSample(g, g.vy, cx, cy, cz);
  out[2] = triSample(g, g.vz, cx, cy, cz);
  return out;
}

/**
 * Splats BLEND cell velocity toward their own rather than adding an impulse:
 * additive impulses stack without bound when the emitter sits still; a blend
 * self-limits at the emission speed, which is what stays stable at any rate.
 * splat = { x, y, z, r, tvx, tvy, tvz, k, den, heat }
 */
function applySplats(g, splats, dtf) {
  const { nx, ny, nz, hx, hy, hz } = g;
  for (let s = 0; s < splats.length; s++) {
    const sp = splats[s];
    const cgx = gX(g, sp.x), cgy = gY(g, sp.y), cgz = gZ(g, sp.z);
    const rx = sp.r / hx, ry = sp.r / hy, rz = sp.r / hz;
    const x0 = clamp(Math.ceil(cgx - rx * 2), 0, nx - 1), x1 = clamp(Math.floor(cgx + rx * 2), 0, nx - 1);
    const y0 = clamp(Math.ceil(cgy - ry * 2), 0, ny - 1), y1 = clamp(Math.floor(cgy + ry * 2), 0, ny - 1);
    const z0 = clamp(Math.ceil(cgz - rz * 2), 0, nz - 1), z1 = clamp(Math.floor(cgz + rz * 2), 0, nz - 1);
    for (let k = z0; k <= z1; k++) for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
      const dx = (i - cgx) / rx, dy = (j - cgy) / ry, dz = (k - cgz) / rz;
      const w = Math.exp(-(dx * dx + dy * dy + dz * dz));
      if (w < 1e-3) continue;
      const o = i + nx * (j + ny * k);
      const a = clamp(sp.k * w * dtf * 10, 0, 1);
      g.vx[o] += (sp.tvx - g.vx[o]) * a;
      g.vy[o] += (sp.tvy - g.vy[o]) * a;
      g.vz[o] += (sp.tvz - g.vz[o]) * a;
      g.den[o] = Math.min(2, g.den[o] + sp.den * w * dtf);
      g.heat[o] = Math.min(2, g.heat[o] + sp.heat * w * dtf);
    }
  }
}

/**
 * Draft: a gusting wind on the field. Its variation is purely TEMPORAL —
 * smooth incommensurate sines of t — because any spatial pattern is visible as
 * a pattern; purely temporal variation reads as weather. Returns [ax, ay].
 */
export function draftVec(draft, t) {
  if (!draft || draft.strength <= 0) return [0, 0];
  const gust = draft.gust;
  const g1 = 0.5 + 0.28 * Math.sin(0.73 * t + 1.1) + 0.16 * Math.sin(1.77 * t + 4.2) + 0.06 * Math.sin(3.1 * t + 2.0);
  const g2 = 0.28 * Math.sin(0.61 * t + 0.4) + 0.17 * Math.sin(1.43 * t + 3.3);
  const amp = draft.strength * (1 - gust + gust * 2 * g1);
  const a = (draft.direction + gust * 55 * g2) * (Math.PI / 180);
  return [Math.cos(a) * amp, Math.sin(a) * amp];
}

function forces(g, cfg, dtf, t) {
  const { nx, ny, nz, n, hx, hy, hz } = g;
  if (cfg.smoke) {
    const b = cfg.buoyancy * 1.6, w = cfg.weight * 1.6;
    for (let o = 0; o < n; o++) g.vy[o] += (b * g.heat[o] - w * g.den[o]) * dtf;
  }
  const [wx2, wy2] = draftVec(cfg.draft, t);
  if (Math.abs(wx2) + Math.abs(wy2) > 0) {
    for (let o = 0; o < n; o++) { g.vx[o] += wx2 * dtf; g.vy[o] += wy2 * dtf; }
  }
  // Point forces on the FIELD — the solver's vortex and the vortex-kind force
  // emitters, evaluated at every cell centre. cfg.pointForce(out, x, y, z, t)
  // writes an acceleration in px/s²; the solver builds it from the same
  // functions that act on the particles, so field and particles agree.
  if (cfg.pointForce) {
    const acc = [0, 0, 0];
    const nxy = nx * ny;
    for (let k = 0; k < nz; k++) {
      const wz = (k + 0.5) * hz - g.box.z / 2;
      for (let j = 0; j < ny; j++) {
        const wy = (j + 0.5) * hy - g.box.y / 2;
        for (let i = 0; i < nx; i++) {
          const o = i + nx * j + nxy * k;
          cfg.pointForce(acc, (i + 0.5) * hx - g.box.x / 2, wy, wz, t);
          g.vx[o] += acc[0] * dtf; g.vy[o] += acc[1] * dtf; g.vz[o] += acc[2] * dtf;
        }
      }
    }
  }
  if (cfg.swirl > 0.5) {
    // Vorticity confinement: ω = ∇×v, force = ε·(∇|ω|̂ × ω). Semi-Lagrangian
    // advection is dissipative; this pays the grid back its small eddies.
    const { im, ip, jm, jp, km, kp, vx, vy, vz, cx, cy, cz, cm } = g;
    const nxy = nx * ny;
    const i2hx = 1 / (2 * hx), i2hy = 1 / (2 * hy), i2hz = 1 / (2 * hz);
    for (let k = 0; k < nz; k++) {
      const kk = k * nxy, kmm = km[k] * nxy, kpp = kp[k] * nxy;
      for (let j = 0; j < ny; j++) {
        const jj = j * nx, jmm = jm[j] * nx, jpp = jp[j] * nx;
        for (let i = 0; i < nx; i++) {
          const o = kk + jj + i;
          const xp = kk + jj + ip[i], xm = kk + jj + im[i];
          const yp = kk + jpp + i, ym = kk + jmm + i;
          const zp = kpp + jj + i, zm = kmm + jj + i;
          const wx = (vz[yp] - vz[ym]) * i2hy - (vy[zp] - vy[zm]) * i2hz;
          const wy = (vx[zp] - vx[zm]) * i2hz - (vz[xp] - vz[xm]) * i2hx;
          const wz = (vy[xp] - vy[xm]) * i2hx - (vx[yp] - vx[ym]) * i2hy;
          cx[o] = wx; cy[o] = wy; cz[o] = wz; cm[o] = Math.sqrt(wx * wx + wy * wy + wz * wz);
        }
      }
    }
    // Swirl SIZE: the gradient of |ω| over a ±R-cell baseline steers
    // confinement by structure R cells wide — fat eddies vs cell-scale curls.
    const eps = cfg.swirl * 2.4 * dtf;
    const R = Math.max(1, Math.round(cfg.swirlSize));
    const ixR = 1 / (2 * hx * R), iyR = 1 / (2 * hy * R), izR = 1 / (2 * hz * R);
    for (let k = 0; k < nz; k++) {
      const kk = k * nxy, kmm = Math.max(0, k - R) * nxy, kpp = Math.min(nz - 1, k + R) * nxy;
      for (let j = 0; j < ny; j++) {
        const jj = j * nx, jmm = Math.max(0, j - R) * nx, jpp = Math.min(ny - 1, j + R) * nx;
        for (let i = 0; i < nx; i++) {
          const o = kk + jj + i;
          let nxg = (cm[kk + jj + Math.min(nx - 1, i + R)] - cm[kk + jj + Math.max(0, i - R)]) * ixR;
          let nyg = (cm[kk + jpp + i] - cm[kk + jmm + i]) * iyR;
          let nzg = (cm[kpp + jj + i] - cm[kmm + jj + i]) * izR;
          const l = 1 / (Math.sqrt(nxg * nxg + nyg * nyg + nzg * nzg) + 1e-5);
          nxg *= l; nyg *= l; nzg *= l;
          vx[o] += eps * (nyg * cz[o] - nzg * cy[o]);
          vy[o] += eps * (nzg * cx[o] - nxg * cz[o]);
          vz[o] += eps * (nxg * cy[o] - nyg * cx[o]);
        }
      }
    }
  }
}

function advect(g, cfg, dtf) {
  const { nx, ny, nz, hx, hy, hz } = g;
  const denK = 1 / (1 + cfg.dissipate * dtf), heatK = 1 / (1 + cfg.cooling * dtf);
  const fadeK = 1 / (1 + cfg.fade * dtf);
  // CFL clamp: 2.5 cells per step per axis. Non-binding in any sane state; it
  // exists so no combination of controls can run the field away.
  const cvx = 2.5 * hx / dtf, cvy = 2.5 * hy / dtf, cvz = 2.5 * hz / dtf;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const o = i + nx * (j + ny * k);
    const x = i - g.vx[o] * dtf / hx, y = j - g.vy[o] * dtf / hy, z = k - g.vz[o] * dtf / hz;
    g.vx2[o] = clamp(triSample(g, g.vx, x, y, z) * fadeK, -cvx, cvx);
    g.vy2[o] = clamp(triSample(g, g.vy, x, y, z) * fadeK, -cvy, cvy);
    g.vz2[o] = clamp(triSample(g, g.vz, x, y, z) * fadeK, -cvz, cvz);
    if (cfg.smoke) {
      g.den2[o] = triSample(g, g.den, x, y, z) * denK;
      g.heat2[o] = triSample(g, g.heat, x, y, z) * heatK;
    }
  }
  [g.vx, g.vx2] = [g.vx2, g.vx]; [g.vy, g.vy2] = [g.vy2, g.vy]; [g.vz, g.vz2] = [g.vz2, g.vz];
  if (cfg.smoke) { [g.den, g.den2] = [g.den2, g.den]; [g.heat, g.heat2] = [g.heat2, g.heat]; }
  if (cfg.sharp) {
    // MacCormack corrector for velocity. After the swap: vx = forward result,
    // vx2 = the ORIGINAL field. The curl arrays hold the backward pass.
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const o = i + nx * (j + ny * k);
      const x = i + g.vx2[o] * dtf / hx, y = j + g.vy2[o] * dtf / hy, z = k + g.vz2[o] * dtf / hz;
      g.cx[o] = triSample(g, g.vx, x, y, z);
      g.cy[o] = triSample(g, g.vy, x, y, z);
      g.cz[o] = triSample(g, g.vz, x, y, z);
    }
    const nxy = nx * ny;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const o = i + nx * j + nxy * k;
      const bx = i - g.vx2[o] * dtf / hx, by = j - g.vy2[o] * dtf / hy, bz = k - g.vz2[o] * dtf / hz;
      const x0 = clamp(Math.floor(bx), 0, nx - 1), y0 = clamp(Math.floor(by), 0, ny - 1), z0 = clamp(Math.floor(bz), 0, nz - 1);
      const x1 = Math.min(nx - 1, x0 + 1), y1 = Math.min(ny - 1, y0 + 1), z1 = Math.min(nz - 1, z0 + 1);
      let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
      for (let zz = z0; zz <= z1; zz += (z1 - z0) || 1) for (let yy = y0; yy <= y1; yy += (y1 - y0) || 1) for (let xx = x0; xx <= x1; xx += (x1 - x0) || 1) {
        const q = xx + nx * yy + nxy * zz;
        const a = g.vx2[q], b = g.vy2[q], c = g.vz2[q];
        if (a < mnx) mnx = a; if (a > mxx) mxx = a;
        if (b < mny) mny = b; if (b > mxy) mxy = b;
        if (c < mnz) mnz = c; if (c > mxz) mxz = c;
      }
      g.vx[o] = clamp(g.vx[o] + 0.5 * (g.vx2[o] - g.cx[o]), mnx, mxx);
      g.vy[o] = clamp(g.vy[o] + 0.5 * (g.vy2[o] - g.cy[o]), mny, mxy);
      g.vz[o] = clamp(g.vz[o] + 0.5 * (g.vz2[o] - g.cz[o]), mnz, mxz);
    }
  }
}

function diffuse(g, cfg, dtf) {
  if (cfg.viscosity < 0.5) return;
  // Two sweeps of a normalised neighbour blend — unconditionally stable, and at
  // the viscosities a look needs, indistinguishable from more Jacobi.
  const a = clamp(cfg.viscosity * 0.02 * dtf * 60, 0, 0.92);
  const { nx, ny, nz, im, ip, jm, jp, km, kp } = g;
  const nxy = nx * ny, ah = a * 0.5, s6 = 1 / 6;
  for (let pass = 0; pass < 2; pass++) {
    for (const [src, dst] of [[g.vx, g.vx2], [g.vy, g.vy2], [g.vz, g.vz2]]) {
      for (let k = 0; k < nz; k++) {
        const kk = k * nxy, kmm = km[k] * nxy, kpp = kp[k] * nxy;
        for (let j = 0; j < ny; j++) {
          const jj = j * nx, jmm = jm[j] * nx, jpp = jp[j] * nx;
          for (let i = 0; i < nx; i++) {
            const o = kk + jj + i;
            const avg = (src[kk + jj + im[i]] + src[kk + jj + ip[i]] + src[kk + jmm + i] + src[kk + jpp + i] + src[kmm + jj + i] + src[kpp + jj + i]) * s6;
            dst[o] = src[o] + (avg - src[o]) * ah;
          }
        }
      }
    }
    [g.vx, g.vx2] = [g.vx2, g.vx]; [g.vy, g.vy2] = [g.vy2, g.vy]; [g.vz, g.vz2] = [g.vz2, g.vz];
  }
}

function project(g, cfg) {
  const { nx, ny, nz, hx, hy, hz } = g;
  const iters = cfg.pressureSteps;
  const { im, ip, jm, jp, km, kp, vx, vy, vz, div } = g;
  const nxy = nx * ny;
  const I = (i, j, k) => i + nx * (j + ny * k);
  const cx = 1 / (hx * hx), cy = 1 / (hy * hy), cz = 1 / (hz * hz);
  const idenom = 1 / (2 * (cx + cy + cz));
  const i2hx = 1 / (2 * hx), i2hy = 1 / (2 * hy), i2hz = 1 / (2 * hz);
  for (let k = 0; k < nz; k++) {
    const kk = k * nxy, kmm = km[k] * nxy, kpp = kp[k] * nxy;
    for (let j = 0; j < ny; j++) {
      const jj = j * nx, jmm = jm[j] * nx, jpp = jp[j] * nx;
      for (let i = 0; i < nx; i++) {
        div[kk + jj + i] = (vx[kk + jj + ip[i]] - vx[kk + jj + im[i]]) * i2hx
          + (vy[kk + jpp + i] - vy[kk + jmm + i]) * i2hy
          + (vz[kpp + jj + i] - vz[kmm + jj + i]) * i2hz;
      }
    }
  }
  g.prs.fill(0);
  const open = cfg.open;
  // Closed: clamped read = Neumann (a wall). Open: zero outside = Dirichlet, the
  // textbook outflow condition — without it rim divergence is never corrected.
  // The boundary weights make that a multiply, not a branch, in the hot loop.
  const wxm = new Float32Array(nx).fill(1), wxp = new Float32Array(nx).fill(1);
  const wym = new Float32Array(ny).fill(1), wyp = new Float32Array(ny).fill(1);
  const wzm = new Float32Array(nz).fill(1), wzp = new Float32Array(nz).fill(1);
  if (open) { wxm[0] = 0; wxp[nx - 1] = 0; wym[0] = 0; wyp[ny - 1] = 0; wzm[0] = 0; wzp[nz - 1] = 0; }
  let p = g.prs, q = g.prs2;
  for (let it = 0; it < iters; it++) {
    for (let k = 0; k < nz; k++) {
      const kk = k * nxy, kmm = km[k] * nxy, kpp = kp[k] * nxy, wk0 = wzm[k], wk1 = wzp[k];
      for (let j = 0; j < ny; j++) {
        const jj = j * nx, jmm = jm[j] * nx, jpp = jp[j] * nx, wj0 = wym[j], wj1 = wyp[j];
        const row = kk + jj;
        for (let i = 0; i < nx; i++) {
          const o = row + i;
          q[o] = (cx * (p[row + im[i]] * wxm[i] + p[row + ip[i]] * wxp[i])
            + cy * (p[kk + jmm + i] * wj0 + p[kk + jpp + i] * wj1)
            + cz * (p[kmm + jj + i] * wk0 + p[kpp + jj + i] * wk1)
            - div[o]) * idenom;
        }
      }
    }
    [p, q] = [q, p];
  }
  g.prs = p; g.prs2 = q;
  for (let k = 0; k < nz; k++) {
    const kk = k * nxy, kmm = km[k] * nxy, kpp = kp[k] * nxy, wk0 = wzm[k], wk1 = wzp[k];
    for (let j = 0; j < ny; j++) {
      const jj = j * nx, jmm = jm[j] * nx, jpp = jp[j] * nx, wj0 = wym[j], wj1 = wyp[j];
      const row = kk + jj;
      for (let i = 0; i < nx; i++) {
        const o = row + i;
        vx[o] -= (p[row + ip[i]] * wxp[i] - p[row + im[i]] * wxm[i]) * i2hx;
        vy[o] -= (p[kk + jpp + i] * wj1 - p[kk + jmm + i] * wj0) * i2hy;
        vz[o] -= (p[kpp + jj + i] * wk1 - p[kmm + jj + i] * wk0) * i2hz;
      }
    }
  }
  if (!open) {
    // Closed box: no flow through the walls.
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) { g.vx[I(0, j, k)] = 0; g.vx[I(nx - 1, j, k)] = 0; }
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) { g.vy[I(i, 0, k)] = 0; g.vy[I(i, ny - 1, k)] = 0; }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { g.vz[I(i, j, 0)] = 0; g.vz[I(i, j, nz - 1)] = 0; }
  } else {
    // Open: an absorbing sponge — the face stands in for infinite still air.
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const dEdge = Math.min(i, nx - 1 - i, j, ny - 1 - j, k, nz - 1 - k);
      if (dEdge >= 3) continue;
      const f = 0.75 + 0.25 * dEdge / 3;
      const o = I(i, j, k);
      g.vx[o] *= f; g.vy[o] *= f; g.vz[o] *= f;
    }
  }
  // The collider is solid to the field: velocity dies in solid cells, so the
  // next projection routes flow around it (obstacle) or keeps it inside.
  const cm = cfg.colliderMode;
  if (cm && g.maskInk) {
    const halfD = cfg.colliderHalfDepth;
    for (let k = 0; k < nz; k++) {
      const wz = (k + 0.5) * hz - g.box.z / 2;
      const inSlab = Math.abs(wz) < halfD;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const inside3 = g.maskInk[i + j * nx] === 1 && inSlab;
        const solid = cm === 1 ? inside3 : !inside3;
        if (!solid) continue;
        const o = I(i, j, k);
        g.vx[o] *= 0.05; g.vy[o] *= 0.05; g.vz[o] *= 0.05;
      }
    }
  }
}

/**
 * One field step. `cfg` is flat (built once per bake by the solver):
 *   smoke, buoyancy, weight, cooling, dissipate, swirl, swirlSize, viscosity,
 *   fade, sharp, open, pressureSteps, draft {strength, direction, gust},
 *   colliderMode (0 none · 1 obstacle · 2 contain), colliderHalfDepth
 * `dtf` is the field's step (STEP_DT × timeFactor); `t` the clip time for the draft.
 */
export function fluidStep(g, cfg, splats, dtf, t) {
  applySplats(g, splats, dtf);
  forces(g, cfg, dtf, t);
  advect(g, cfg, dtf);
  diffuse(g, cfg, dtf);
  project(g, cfg);
}

// ── Paths ──────────────────────────────────────────────────────────────────

/** Samples per resampled path; each sample is x, y, z, tx, ty, tz. */
export const PATH_N = 192;

/**
 * Catmull-Rom through the anchors (world px), resampled to PATH_N points of
 * even arc length with a unit tangent each — the same normalisation the shape
 * editor's pathSmooth does, so a scribble and a careful trace give the same
 * density of emission sites and the same follow field. Null for < 2 anchors.
 */
export function resamplePath(anchors) {
  const A = anchors;
  if (!A || A.length < 2) return null;
  const pts = [];
  for (let i = 0; i < A.length - 1; i++) {
    const p0 = A[Math.max(0, i - 1)], p1 = A[i], p2 = A[i + 1], p3 = A[Math.min(A.length - 1, i + 2)];
    for (let s = 0; s < 24; s++) {
      const t = s / 24, t2 = t * t, t3 = t2 * t;
      pts.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  pts.push({ x: A[A.length - 1].x, y: A[A.length - 1].y });
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = cum[cum.length - 1] || 1;
  const S = new Float32Array(PATH_N * 6);
  let j = 0;
  for (let i = 0; i < PATH_N; i++) {
    const d = (i / (PATH_N - 1)) * total;
    while (j < pts.length - 2 && cum[j + 1] < d) j++;
    const f = (d - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
    const o = i * 6;
    S[o] = lerp(pts[j].x, pts[j + 1].x, f);
    S[o + 1] = lerp(pts[j].y, pts[j + 1].y, f);
    S[o + 2] = 0;
  }
  for (let i = 0; i < PATH_N; i++) {
    const o = i * 6, oa = Math.max(0, i - 1) * 6, ob = Math.min(PATH_N - 1, i + 1) * 6;
    const tx = S[ob] - S[oa], ty = S[ob + 1] - S[oa + 1], tz = S[ob + 2] - S[oa + 2];
    const l = Math.hypot(tx, ty, tz) || 1;
    S[o + 3] = tx / l; S[o + 4] = ty / l; S[o + 5] = tz / l;
  }
  return S;
}

/**
 * Nearest path sample to a point, from a cached index (-1 = unknown): a coarse
 * seed once, then hill descent — the path is smooth and particles move
 * continuously, so this converges in a step or two. Never a full scan.
 */
export function nearestOnPath(S, cached, px, py, pz) {
  let bi = cached;
  const d2at = (s) => { const o = s * 6, dx = S[o] - px, dy = S[o + 1] - py, dz = S[o + 2] - pz; return dx * dx + dy * dy + dz * dz; };
  if (bi < 0) {
    let bd = Infinity;
    for (let s = 0; s < PATH_N; s += 8) { const d = d2at(s); if (d < bd) { bd = d; bi = s; } }
  }
  let bd = d2at(bi);
  for (let step = 0; step < 24; step++) {
    let moved = false;
    if (bi > 0 && d2at(bi - 1) < bd) { bd = d2at(--bi); moved = true; }
    else if (bi < PATH_N - 1 && d2at(bi + 1) < bd) { bd = d2at(++bi); moved = true; }
    if (!moved) break;
  }
  return bi;
}

/**
 * Path-follow acceleration for one particle, added to `v` (length 3) in place:
 * attract toward the nearest sample, flow along its tangent, swirl around it —
 * all × 1 / (1 + (d / proximity)²). Returns the nearest index to cache.
 */
export function pathFollowStep(S, cached, px, py, pz, v, pf, dt) {
  const s = nearestOnPath(S, cached, px, py, pz), o = s * 6;
  const dx = S[o] - px, dy = S[o + 1] - py, dz = S[o + 2] - pz;
  const d = Math.hypot(dx, dy, dz) + 1e-5;
  const q = d / pf.proximity;
  const fall = 1 / (1 + q * q);
  const att = pf.attract * 3 * fall * dt;
  v[0] += (dx / d) * att; v[1] += (dy / d) * att; v[2] += (dz / d) * att;
  const flw = pf.flow * 3 * fall * dt;
  v[0] += S[o + 3] * flw; v[1] += S[o + 4] * flw; v[2] += S[o + 5] * flw;
  if (pf.swirl > 0.5) {
    const rx = -dx / d, ry = -dy / d, rz = -dz / d;
    const sw = pf.swirl * 3 * fall * dt;
    v[0] += (S[o + 4] * rz - S[o + 5] * ry) * sw;
    v[1] += (S[o + 5] * rx - S[o + 3] * rz) * sw;
    v[2] += (S[o + 3] * ry - S[o + 4] * rx) * sw;
  }
  return s;
}

// ── Collision: a signed distance field in the box's XY plane ───────────────

export const SDF_W = 384;
export const SDF_H = 216;

/**
 * Signed distance (world px, negative INSIDE) from an alpha mask laid over the
 * whole box, via a two-pass 3-4 chamfer transform. `alpha` is SDF_W×SDF_H
 * bytes, row 0 = the TOP of the box (canvas order); threshold at 128.
 * Returns { sdf, w, h, boxW, boxH }.
 */
export function sdfFromMask(alpha, boxW, boxH) {
  const W = SDF_W, H = SDF_H;
  const INF = 1e6;
  const dO = new Float32Array(W * H), dI = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) { const solid = alpha[i] > 127; dO[i] = solid ? 0 : INF; dI[i] = solid ? INF : 0; }
  const chamfer = (d) => {
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const o = i + j * W; let v = d[o];
      if (i > 0) v = Math.min(v, d[o - 1] + 3);
      if (j > 0) { v = Math.min(v, d[o - W] + 3); if (i > 0) v = Math.min(v, d[o - W - 1] + 4); if (i < W - 1) v = Math.min(v, d[o - W + 1] + 4); }
      d[o] = v;
    }
    for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
      const o = i + j * W; let v = d[o];
      if (i < W - 1) v = Math.min(v, d[o + 1] + 3);
      if (j < H - 1) { v = Math.min(v, d[o + W] + 3); if (i < W - 1) v = Math.min(v, d[o + W + 1] + 4); if (i > 0) v = Math.min(v, d[o + W - 1] + 4); }
      d[o] = v;
    }
  };
  chamfer(dO); chamfer(dI);
  const k = (boxW / W) / 3;
  const sdf = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) sdf[i] = (dO[i] - dI[i]) * k;
  return { sdf, w: W, h: H, boxW, boxH };
}

/** Bilinear signed distance at a world point (px). */
export function sdfAt(table, x, y) {
  const { w: W, h: H, sdf: d } = table;
  const gx = clamp((x / table.boxW + 0.5) * W - 0.5, 0, W - 1.001);
  const gy = clamp((0.5 - y / table.boxH) * H - 0.5, 0, H - 1.001);
  const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
  const o = x0 + y0 * W;
  return lerp(lerp(d[o], d[o + 1], fx), lerp(d[o + W], d[o + W + 1], fx), fy);
}

/** Per-column ink mask for the grid (1 = inside the 2D shape), from the SDF. */
export function gridInkMask(g, table) {
  const mask = new Uint8Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const sd = sdfAt(table, (i + 0.5) * g.hx - g.box.x / 2, (j + 0.5) * g.hy - g.box.y / 2);
    mask[i + j * g.nx] = sd < 0 ? 1 : 0;
  }
  return mask;
}

/**
 * Resolve one particle against the collider, in place. `p` and `v` are length-3
 * arrays. mode 1 = obstacle (outer faces), 2 = contain (inner faces). The shape
 * is a finite-depth extrusion: sd3 = max(sd2d, |z| − halfDepth), with ±z caps.
 * The push-out is capped per step so a stray spawned deep on the wrong side
 * glides to the surface over a few frames instead of teleporting.
 */
/**
 * Push a particle out of the collider.
 *
 * `margin` is the contact skin — how far from the surface the particle is held.
 * It defaults to 6 px, which is what this has always used and what every caller
 * without packing still gets: a point particle with a fixed skin.
 *
 * PACKING PASSES ITS RADIUS INSTEAD, and needs the response split in two. With
 * particle-to-particle collision on, a radius-blind wall lets beads sink half
 * their body into the mould, which reads wrong at every size. And the VELOCITY
 * half has to be withheld: XPBD re-derives velocity from the corrected position
 * immediately afterwards, so anything written to `v` here is discarded. When
 * `nOut` is supplied this writes the contact normal into it and leaves `v`
 * alone, for the caller to apply after its own derivation (see packing.js's
 * wallResponse). Without it, the original behaviour is unchanged.
 */
/**
 * OPENING A SIDE OF A COLLIDER.
 *
 * A container is a closed shape, and the thing people actually want from one is
 * for it to stop being closed: a letter that fills with beads and then lets them
 * pour out of its bottom, a jar that opens at the top.
 *
 * The gate is on the CONTACT NORMAL, not on position, and that is what makes it
 * behave like a door rather than like a cut. `bottom` opens every surface whose
 * inward normal points up — the floor of every stroke of a letter, not a
 * half-plane through the middle of it — and it keeps working after the particle
 * has left, because a point below the shape has the same inward normal as the
 * floor it fell through. A position-based cut would let a particle out and then
 * suck it straight back in.
 *
 * `amount` is 0 closed, 1 fully open, and it scales the constraint inside the
 * cone rather than switching it, so a door can open over time instead of
 * blinking. Returns the fraction of the push to KEEP: 1 is solid, 0 is a hole.
 *
 * Directions are WORLD space. "Top" means the top of the frame, which is what it
 * means when you say it out loud, and it stays true for a collider that follows
 * a rotating layer.
 */
export const COLLISION_OPEN_SIDES = ['none', 'top', 'bottom', 'left', 'right'];

const OPEN_DIR = {
  // The INWARD normal of the named side: a container's floor pushes up.
  bottom: [0, 1, 0],
  top: [0, -1, 0],
  left: [1, 0, 0],
  right: [-1, 0, 0],
};

export function collisionOpenKeep(open, amount, nx, ny, nz) {
  if (!open || !amount || open.side === 'none') return 1;
  const dir = OPEN_DIR[open.side];
  if (!dir) return 1;
  const d = nx * dir[0] + ny * dir[1] + nz * dir[2];
  const half = Math.max(1, Math.min(180, open.spread || 90)) * 0.5 * Math.PI / 180;
  const cut = Math.cos(half);
  // A feathered edge rather than a hard cone: a hard one leaves a visible seam
  // of particles clinging to the last solid degree of the doorway.
  const soft = Math.cos(Math.max(0, half - 0.18));
  if (d <= cut) return 1;
  const u = soft <= cut ? 1 : Math.min(1, (d - cut) / (soft - cut));
  return 1 - amount * u * u * (3 - 2 * u);
}

/** How far open the door is at clip-local time `t`. 0 closed, 1 fully open. */
export function collisionOpenAmount(open, t) {
  if (!open || open.side === 'none') return 0;
  const at = open.at || 0;
  if (t <= at) return 0;
  const fade = Math.max(1e-3, open.fade || 0);
  const u = (t - at) / fade;
  return u >= 1 ? 1 : u;
}

export function resolveCollision(table, mode, halfDepth, bounce, p, v, margin = 6, nOut = null, openCfg = null, openAmt = 0, releaseOutside = false) {
  const CM = margin;
  const s2 = sdfAt(table, p[0], p[1]);
  const zd = Math.abs(p[2]) - halfDepth;
  const useZ = zd > s2;
  const sd = Math.max(s2, zd);
  if (!(mode === 1 ? sd < CM : sd > -CM)) return false;
  /*
   * ONCE THEY ARE OUT, THEY STAY OUT.
   *
   * A container hauls back anything outside it, which is the right repair while
   * it is sealed: emission is clipped to the inside, so "outside" can only be
   * numerical drift. Open a side and that stops being true — and the repair
   * turns vicious. The pull is capped at 60 px per STEP and the solver re-derives
   * velocity from position, so on the user's own settings — 34 px beads at
   * radiusScale 0.6, four substeps — one re-capture is 60 px in 4.17 ms, which
   * derives 14,400 px/s and clamps to 1,765 px/s UPWARD. Gravity adds 11.7 px/s
   * in a whole frame. A bead fell out of the doorway and shot back like a
   * bullet, which is exactly what it was reported as.
   *
   * So while a door is open, a container only constrains what is inside it or
   * touching it. Beyond the contact margin the particle has left, and leaving is
   * the whole point of the door. It also covers the case the normal cone cannot:
   * a bead that exits at the EDGE of the doorway, where the corner's normal has
   * already swung out of the open arc.
   */
  if (mode === 2 && sd > CM && (releaseOutside || (openCfg && openAmt > 0))) return false;
  let nx = 0, ny = 0, nz = 0;
  if (useZ) {
    nz = p[2] >= 0 ? 1 : -1;
  } else {
    nx = (sdfAt(table, p[0] + 6, p[1]) - sdfAt(table, p[0] - 6, p[1])) / 12;
    ny = (sdfAt(table, p[0], p[1] + 6) - sdfAt(table, p[0], p[1] - 6)) / 12;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
  }
  if (mode === 2) { nx = -nx; ny = -ny; nz = -nz; }
  let pen = Math.min(60, mode === 1 ? CM - sd : sd + CM);
  if (openCfg) {
    const keep = collisionOpenKeep(openCfg, openAmt, nx, ny, nz);
    if (keep <= 0.001) return false;      // this part of the wall is a doorway
    pen *= keep;
  }
  p[0] += nx * pen; p[1] += ny * pen; p[2] += nz * pen;
  if (nOut) { nOut[0] = nx; nOut[1] = ny; nOut[2] = nz; return true; }
  const vn = v[0] * nx + v[1] * ny + v[2] * nz;
  if (vn < 0) {
    v[0] -= nx * vn * (1 + bounce);
    v[1] -= ny * vn * (1 + bounce);
    v[2] -= nz * vn * (1 + bounce);
  }
  return true;
}

/** True when a world point is inside the container (contain mode), with a margin. */
export function insideCollider(table, halfDepth, x, y, z, margin = 6) {
  return sdfAt(table, x, y) < -margin && Math.abs(z) < halfDepth - margin;
}

export { TAU as FLUID_TAU };

/**
 * A vortex emitter's acceleration at a point: rigid-core rotation about
 * (cx, cy) in the comp plane — zero at the eye, peaking near `radius`,
 * decaying outside — with the same gentle inward bias the solver's vortex
 * has, so it gathers instead of flinging outward. `amp` is signed (spin).
 * Written into `out` (length 3), z untouched.
 */
/**
 * A blower ("jet" kind) acting on a particle directly — the no-field case.
 * Inside its radius the particle's velocity is blended toward the blower's
 * push (a target velocity along `dirDeg`, +y up) with a gaussian falloff, at a
 * rate set by `strength` — the same blend the splat applies to the FIELD, so
 * with and without a field a blower means the same thing. `v` is edited in
 * place (length ≥ 2).
 */
export function jetPointPush(v, cx, cy, radius, strength, dirDeg, push, x, y, dt) {
  const r = Math.max(1, radius);
  const dx = (x - cx) / r, dy = (y - cy) / r;
  const w = Math.exp(-(dx * dx + dy * dy));
  if (w < 1e-3) return v;
  const a = Math.min(1, (strength / 100) * w * dt * 10);
  const ang = dirDeg * (Math.PI / 180);
  v[0] += (Math.cos(ang) * push - v[0]) * a;
  v[1] += (Math.sin(ang) * push - v[1]) * a;
  return v;
}

export function vortexPointAccel(out, cx, cy, radius, amp, x, y) {
  const px = x - cx, py = y - cy;
  const r = Math.hypot(px, py) + 1e-4;
  const q = r / Math.max(1, radius);
  const fall = q * Math.exp(1 - q * q);
  const rx = px / r, ry = py / r;
  out[0] = (-ry * amp - rx * Math.abs(amp) * 0.15) * fall;
  out[1] = (rx * amp - ry * Math.abs(amp) * 0.15) * fall;
  out[2] = 0;
  return out;
}
