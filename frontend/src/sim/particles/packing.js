/*
 * PACKING — particle-to-PARTICLE collision, for the baked solver.
 *
 * `collision` (fluid.js / solver.js) is particle-to-OBJECT: the picked layer's
 * artwork becomes a signed-distance field and every particle is pushed out of
 * it. Nothing in it makes two particles aware of each other, so until this file
 * they occupied the same point happily. This is the other half — the one that
 * turns a spray into a pour, a pile, a jar of beads, a mould filling up.
 *
 * Ported from html/particle-packing-lab.html, whose header is the record of what
 * the measurements changed. Plan: PLANS/VIDEO_EDITOR_PARTICLE_PACKING_PLAN.md.
 *
 * Pure: no DOM, no three.js, no imports from the editor. Same contract as
 * proximity.js, and for the same reason — it has to run inside bakeWorker.
 *
 *
 * THE ONE STRUCTURAL DIFFERENCE FROM THE LAB, and it touches every loop.
 *
 * The lab's pool is densely packed with swap-remove, so it iterates 0..count.
 * The solver's is SLOT-ALIGNED with holes: slot i in snapshot A and slot i in
 * snapshot B are the same particle iff their uids match, and that aliasing is
 * what makes sampling an index lookup instead of a per-frame id map. A dead slot
 * has uid 0 and must never become a contact. So every loop here runs over a
 * compacted `live` index list that the caller rebuilds each step, and `order`
 * holds SLOT indices rather than positions in a dense array.
 *
 *
 * WHERE THE FORCES ARE — AND THE VERSION OF THIS THAT DID NOT WORK.
 *
 * The solver's "forces" are fluid advection, proximity fields, path follow and
 * layer drives, and re-running those four per substep is exactly what would make
 * this feature unaffordable. So the caller runs its whole force pipeline ONCE
 * per frame, exactly as it always has, and hands the resulting velocity DELTA
 * here as `dv`. Packing re-applies `dv / substeps` inside each substep, so the
 * total impulse over the frame is unchanged and the expensive sampling happens
 * once.
 *
 * The first version of this file did the obvious thing instead — take the
 * post-force velocity and substep position only, on the reasoning that substeps
 * buy CONTACT convergence rather than a finer sampling of gravity. That
 * reasoning is wrong, and measurably so. A bead resting on the floor gets the
 * whole frame's gravity in substep 1; the projection answers it and re-derives
 * the velocity to ~0; and substeps 2..N then run with no driving force at all,
 * so they cannot consolidate anything. The pack settles into whatever the first
 * substep happened to give and stops. Measured on 160 mono-disperse beads in a
 * box: phi 0.43 against 0.79 for the same pack with no friction, a pile 163 px
 * tall where the hexagonal answer is 83 — and raising iters and substeps made it
 * WORSE (phi 0.37), because more projection pushing apart with no gravity to
 * re-compress is exactly the wrong direction. A pack that gets looser when you
 * give the solver more work is the signature of this bug.
 */

import { clumpsOverlap } from './shapes.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Cell size slack. The neighbour query has to see a pair that is merely TOUCHING
 * (for the contact tally and for cohesion), not only one that overlaps, so the
 * cell is grown 3% past the contact distance and the 3x3x3 stencil still covers
 * every pair it must.
 */
const TOUCH = 1.03;

/**
 * A cap on the grid, not on the particles. One particle flung far from the rest
 * makes the bounding box enormous and the cell count with it; growing the CELL
 * is the cheap fix and costs only a few extra neighbour tests.
 */
const MAXCELLS = 1 << 20;

/**
 * Tangential velocity damping per contact, as a fraction of `friction`.
 *
 * POSITION-LEVEL FRICTION IS NOT ENOUGH, and this constant is why. Macklin's
 * clamp is limited to mu x overlap, and a converged pack has almost no overlap —
 * so precisely where you want friction, there is none, and a sand pile slides
 * out into a flat carpet instead of heaping. The angle of repose comes from
 * damping relative tangential VELOCITY at each contact instead.
 */
const TDAMP_K = 0.18;

/**
 * Per-particle state that has to survive between steps: which particles are
 * asleep, and where they were when they last moved. Sized to the pool.
 *
 * Returns null when packing is off, so the caller's gate is `if (PK)` and the
 * feature costs a disabled system one null check per bake.
 */
export function createPacking(cfg, maxP, shapes = null) {
  if (!cfg || !cfg.enabled) return null;
  const n = Math.max(1, maxP | 0);
  const rad = new Float32Array(n);
  return {
    cfg,
    // Geometry, refreshed per step from the drawn size (see radiusOf in solver).
    rad,
    /*
     * The radius the CONTACT thresholds are measured against — how deep an
     * overlap has to be to wake a sleeper, how converged a contact must be
     * before it may sleep. For a circle it is the radius itself (the same
     * array, so circle packing reads exactly what it always read). For an
     * object it is the typical radius of the circles it is made of: a letter's
     * bounding circle is several strokes wide, and a push that is deep for a
     * stroke is nothing against that.
     */
    tr: shapes ? new Float32Array(n) : rad,
    invm: new Float32Array(n),
    shape: shapes ? createShapeState(shapes, n) : null,
    // Predicted positions. XPBD projects THESE, never the committed p.
    qx: new Float32Array(n), qy: new Float32Array(n), qz: new Float32Array(n),
    // Position at the start of the substep, for the friction displacement.
    sx: new Float32Array(n), sy: new Float32Array(n), sz: new Float32Array(n),
    // Sleeping, and the anchor drift is tested against.
    slept: new Uint8Array(n),
    sleepT: new Uint16Array(n),
    anx: new Float32Array(n), any: new Float32Array(n), anz: new Float32Array(n),
    // The force impulse this particle was carrying when it fell asleep — see the
    // wake-on-force test in packingStep.
    sdx: new Float32Array(n), sdy: new Float32Array(n), sdz: new Float32Array(n),
    // Contacts and deepest overlap this substep — the sleep gate reads both.
    cont: new Uint16Array(n),
    ovl: new Float32Array(n),
    // Wall/collider normals, recorded during the position clamp and consumed
    // after the velocity is re-derived. They cannot be applied where they are
    // found: see `wallResponse`.
    wnx: new Float32Array(n), wny: new Float32Array(n), wnz: new Float32Array(n),
    wallHit: new Uint8Array(n),
    // Grid.
    order: new Int32Array(n),
    cellStart: new Int32Array(1),
    cellFill: new Int32Array(1),
    gcs: 1, gx: 1, gy: 1, gz: 1, gox: 0, goy: 0, goz: 0, cellCount: 0, maxRad: 1,
    // Diagnostics, published once per step for the dev readout.
    stat: { contacts: 0, pen: 0, maxPen: 0, awake: 0, phi: 0 },
  };
}

/*
 * ── SHAPE MODE: every particle is a rigid CLUMP of circles ──────────────────
 *
 * `packing.shape: 'object'`, for layer objects only. Each particle is the
 * silhouette of the member it stamps (shapes.js builds the clump from the
 * artwork), it has an angle and a spin, and a contact is between two circles of
 * two different bodies. The position correction is the same XPBD projection the
 * circle mode does, with the inverse mass generalised by the lever arm — which
 * is the whole of rigid-body XPBD (Müller et al. 2020): a push off-centre moves
 * the body AND turns it.
 *
 * The broad phase is the circle mode's own grid, over each body's BOUNDING
 * circle; the narrow phase walks the two clumps. So the grid, the CFL speed cap
 * and every sleep rule are the ones that already exist, measured on the body.
 *
 * 2D only: a flat Solver Box. The artwork is drawn facing the camera, so a
 * clump is a flat thing, and a third axis would need a 3D shape it does not have.
 */
function createShapeState(D, n) {
  return {
    D,
    mem: new Int32Array(n),       // member index per slot
    sc: new Float32Array(n),      // collision scale: px per quad-width unit
    iinv: new Float32Array(n),    // inverse moment of inertia
    // The angle and spin arrays belong to the solver (they are snapshotted);
    // bound by the caller via bindShapeAngles.
    ang: null, angv: null,
    qa: new Float32Array(n),      // predicted angle — what the projection moves
    sa: new Float32Array(n),      // angle at the start of the substep (friction)
    anA: new Float32Array(n),     // sleep anchor, like anx/any
    cs: new Float32Array(n), sn: new Float32Array(n),   // cos/sin of qa, kept current
    // The deepest wall/collider contact of this substep, as a lever arm from
    // the body's centre — the wall response needs WHERE it was touched.
    wrx: new Float32Array(n), wry: new Float32Array(n), wdep: new Float32Array(n),
    // True when a body's scale can change while it sleeps (a proximity Size
    // effector). Set by the solver; see the both-asleep skip in the projection.
    scaleMoves: false,
  };
}

/** Hand the solver's angle and angular-velocity arrays to the packing state. */
export function bindShapeAngles(K, ang, angv) {
  K.shape.ang = ang;
  K.shape.angv = angv;
}

/**
 * Member, scale, mass and inertia for the live set — the shape-mode setRadii.
 * `rad` becomes the bounding radius (the grid and the sleep drift read it) and
 * `tr` the member's mean circle radius (the contact thresholds read it).
 */
export function setShapeBodies(K, live, nlive, memberOf, scaleOf) {
  const S = K.shape, D = S.D;
  const { rad, tr, invm } = K;
  for (let k = 0; k < nlive; k++) {
    const i = live[k];
    const m = memberOf(i);
    const s = Math.max(0.05, scaleOf(i));
    S.mem[i] = m; S.sc[i] = s;
    rad[i] = Math.max(0.05, D.bound[m] * s);
    tr[i] = Math.max(0.05, D.meanR[m] * s);
    invm[i] = 1 / Math.max(1e-6, D.area[m] * s * s);
    S.iinv[i] = 1 / Math.max(1e-6, D.inert[m] * s * s * s * s);
  }
}

function refreshRot(S, i) {
  S.cs[i] = Math.cos(S.qa[i]);
  S.sn[i] = Math.sin(S.qa[i]);
}

/**
 * Push body `i` so that its material point (x, y) moves `depth` along the unit
 * normal (nx, ny) — a contact against something that does not move: a Solver
 * Box wall or the collider. Off-centre, so it turns the body as well; that is
 * what lets a letter landing on its corner tip over instead of standing on it.
 *
 * Friction is applied here, at position level, against the tangential slip of
 * that point over the substep. A floor with only velocity-level friction lets a
 * resting letter creep and rock for ever, because the projection itself keeps
 * re-introducing the slip the velocity pass removes.
 */
export function shapeWallPush(K, i, x, y, nx, ny, depth) {
  if (!(depth > 0)) return;
  const S = K.shape;
  const rx = x - K.qx[i], ry = y - K.qy[i];
  const wi = K.invm[i], ii = S.iinv[i];
  const c = rx * ny - ry * nx;
  const dl = depth / (wi + ii * c * c);
  K.qx[i] += nx * dl * wi; K.qy[i] += ny * dl * wi; S.qa[i] += ii * c * dl;
  const mu = K.cfg.friction;
  if (mu > 0) {
    const da = S.qa[i] - S.sa[i];
    let tx = (K.qx[i] - K.sx[i]) - da * ry;
    let ty = (K.qy[i] - K.sy[i]) + da * rx;
    const tn = tx * nx + ty * ny;
    tx -= nx * tn; ty -= ny * tn;
    const tl = Math.sqrt(tx * tx + ty * ty);
    if (tl > 1e-6) {
      tx /= tl; ty /= tl;
      const ct = rx * ty - ry * tx;
      const dlt = Math.min(tl, mu * depth) / (wi + ii * ct * ct);
      K.qx[i] -= tx * dlt * wi; K.qy[i] -= ty * dlt * wi; S.qa[i] -= ii * ct * dlt;
    }
  }
  refreshRot(S, i);
  K.wallHit[i] = 1; K.wnx[i] += nx; K.wny[i] += ny;
  if (depth > S.wdep[i]) { S.wdep[i] = depth; S.wrx[i] = rx; S.wry[i] = ry; }
}

/**
 * Body-vs-body contacts, clump against clump. The shape-mode projectPairs.
 *
 * Gauss-Seidel like the circle version: every correction moves the two bodies
 * at once, and the next circle test sees where they are now. That is why the
 * world centre of circle `a` is recomputed after each correction rather than
 * once per pair.
 */
function projectShapePairs(K, live, nlive, tally) {
  const C = K.cfg, S = K.shape, D = S.D;
  const mu = C.friction, coh = C.cohesion, cohR = 1 + C.cohesionRange;
  const stiff = C.stiffness, gap = C.gap;
  const { qx, qy, sx, sy, rad, invm, slept, cont, ovl, order, cellStart } = K;
  const { qa, sa, iinv, mem, sc, cs, sn } = S;
  const { mg, gOffs, gx: ugx, gy: ugy, gr: ugr, cx: ux, cy: uy, cr: ur } = D;
  const slack = coh > 0 ? Math.max(cohR, TOUCH) : TOUCH;
  let pen = 0, maxPen = 0, contacts = 0, overlapN = 0;

  if (tally) {
    for (let k = 0; k < nlive; k++) { cont[live[k]] = 0; ovl[live[k]] = 0; }
  }
  for (let k = 0; k < nlive; k++) refreshRot(S, live[k]);

  for (let oi = 0; oi < nlive; oi++) {
    const i = order[oi];
    const cxi = clamp(((qx[i] - K.gox) / K.gcs) | 0, 0, K.gx - 1);
    const cyi = clamp(((qy[i] - K.goy) / K.gcs) | 0, 0, K.gy - 1);
    for (let dy = -1; dy <= 1; dy++) {
      const cy = cyi + dy; if (cy < 0 || cy >= K.gy) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const cx = cxi + dx; if (cx < 0 || cx >= K.gx) continue;
        const c = cy * K.gx + cx;
        const e = cellStart[c + 1];
        for (let kk = cellStart[c]; kk < e; kk++) {
          const j = order[kk];
          if (j <= i) continue;
          // Broad: bounding circles.
          const bxv = qx[j] - qx[i], byv = qy[j] - qy[i];
          const reachB = (rad[i] + rad[j] + gap) * slack;
          if (bxv * bxv + byv * byv > reachB * reachB) continue;

          /*
           * Two sleepers never move each other. The circle mode still walks such
           * a pair for its contact tally, and that is affordable for circles; for
           * clumps it was a large share of a settled pile's bake. The one thing
           * that CAN make two sleepers overlap is a scale that changes under them
           * (a proximity Size effector) — then the pair is checked once per
           * substep so the overlap can wake it.
           */
          if (slept[i] && slept[j] && !(S.scaleMoves && tally)) continue;

          const si = sc[i], sj = sc[j];
          const ma = mem[i], mb = mem[j];
          for (let ga = mg[ma], gae = mg[ma + 1]; ga < gae; ga++) {
            const gra = ugr[ga] * si;
            const gax = qx[i] + (cs[i] * ugx[ga] - sn[i] * ugy[ga]) * si;
            const gay = qy[i] + (sn[i] * ugx[ga] + cs[i] * ugy[ga]) * si;
            {
              const lim = (gra + rad[j] + gap) * slack;
              if ((qx[j] - gax) ** 2 + (qy[j] - gay) ** 2 > lim * lim) continue;
            }
          for (let gb = mg[mb], gbe = mg[mb + 1]; gb < gbe; gb++) {
            const grb = ugr[gb] * sj;
            {
              // Group against group. Positions from the start of this group
              // pair; a correction inside it moves things by a fraction of an
              // overlap, which the slack covers, and the next iteration re-tests.
              const gbx = qx[j] + (cs[j] * ugx[gb] - sn[j] * ugy[gb]) * sj;
              const gby = qy[j] + (sn[j] * ugx[gb] + cs[j] * ugy[gb]) * sj;
              const glim = (gra + grb + gap) * slack;
              if ((gbx - gax) ** 2 + (gby - gay) ** 2 > glim * glim) continue;
            }
          for (let a = gOffs[ga], ae = gOffs[ga + 1]; a < ae; a++) {
            const ra = ur[a] * si;
            let ax = qx[i] + (cs[i] * ux[a] - sn[i] * uy[a]) * si;
            let ay = qy[i] + (sn[i] * ux[a] + cs[i] * uy[a]) * si;
            // This circle against the other group's bounding circle, before
            // any of its circles. Recomputed per circle: a correction moves j.
            {
              const gbx = qx[j] + (cs[j] * ugx[gb] - sn[j] * ugy[gb]) * sj;
              const gby = qy[j] + (sn[j] * ugx[gb] + cs[j] * ugy[gb]) * sj;
              const lim = (ra + grb + gap) * slack;
              if ((gbx - ax) ** 2 + (gby - ay) ** 2 > lim * lim) continue;
            }
            for (let b = gOffs[gb], be = gOffs[gb + 1]; b < be; b++) {
              const rb = ur[b] * sj;
              const bwx = qx[j] + (cs[j] * ux[b] - sn[j] * uy[b]) * sj;
              const bwy = qy[j] + (sn[j] * ux[b] + cs[j] * uy[b]) * sj;
              let dxv = bwx - ax, dyv = bwy - ay;
              const rest = ra + rb + gap;
              const reach = coh > 0 ? Math.max(rest * TOUCH, rest * cohR) : rest * TOUCH;
              const d2 = dxv * dxv + dyv * dyv;
              if (d2 > reach * reach) continue;
              let dist = Math.sqrt(d2);
              if (dist < 1e-6) { dxv = 0.01; dyv = 0; dist = 0.01; }
              const nx = dxv / dist, ny = dyv / dist;
              const overlap = rest - dist;

              if (tally && dist < rest * TOUCH) {
                contacts++; cont[i]++; cont[j]++;
                if (overlap > ovl[i]) ovl[i] = overlap;
                if (overlap > ovl[j]) ovl[j] = overlap;
                if (slept[i] !== slept[j]) wakeIsland(K, slept[i] ? i : j, slept[i] ? j : i, false);
                if (overlap > 0) { pen += overlap; overlapN++; if (overlap > maxPen) maxPen = overlap; }
              }
              if (overlap > 0) { wake(K, i, overlap); wake(K, j, overlap); }

              const wi = slept[i] ? 0 : invm[i], wj = slept[j] ? 0 : invm[j];
              const ii = slept[i] ? 0 : iinv[i], ij = slept[j] ? 0 : iinv[j];
              if (wi + wj <= 0) continue;

              // Contact point: half-way through the overlap, on the line
              // between the two circle centres.
              const reachA = ra - overlap * 0.5;
              const pcx = ax + nx * reachA, pcy = ay + ny * reachA;
              const rix = pcx - qx[i], riy = pcy - qy[i];
              const rjx = pcx - qx[j], rjy = pcy - qy[j];

              if (overlap > 0) {
                const ci = rix * ny - riy * nx, cj = rjx * ny - rjy * nx;
                const dl = (overlap * stiff) / (wi + ii * ci * ci + wj + ij * cj * cj);
                qx[i] -= nx * dl * wi; qy[i] -= ny * dl * wi; qa[i] -= ii * ci * dl;
                qx[j] += nx * dl * wj; qy[j] += ny * dl * wj; qa[j] += ij * cj * dl;

                if (mu > 0) {
                  // Slip of the contact point on each body over this substep:
                  // the body's travel plus its turn about its centre.
                  const dai = qa[i] - sa[i], daj = qa[j] - sa[j];
                  let rx = ((qx[i] - sx[i]) - dai * riy) - ((qx[j] - sx[j]) - daj * rjy);
                  let ry = ((qy[i] - sy[i]) + dai * rix) - ((qy[j] - sy[j]) + daj * rjx);
                  const rn = rx * nx + ry * ny;
                  rx -= nx * rn; ry -= ny * rn;
                  const tl = Math.sqrt(rx * rx + ry * ry);
                  if (tl > 1e-6) {
                    const tx = rx / tl, ty = ry / tl;
                    const cti = rix * ty - riy * tx, ctj = rjx * ty - rjy * tx;
                    // static below mu*d, dynamic (clamped) above — as circles
                    const dlt = Math.min(tl, mu * overlap) / (wi + ii * cti * cti + wj + ij * ctj * ctj);
                    qx[i] -= tx * dlt * wi; qy[i] -= ty * dlt * wi; qa[i] -= ii * cti * dlt;
                    qx[j] += tx * dlt * wj; qy[j] += ty * dlt * wj; qa[j] += ij * ctj * dlt;
                  }
                }
              } else if (coh > 0 && dist < reach) {
                const ci = rix * ny - riy * nx, cj = rjx * ny - rjy * nx;
                const t = 1 - (dist - rest) / (reach - rest);
                const dl = (coh * t * t * 0.5 * Math.min(rest, dist)) / (wi + ii * ci * ci + wj + ij * cj * cj);
                qx[i] += nx * dl * wi; qy[i] += ny * dl * wi; qa[i] += ii * ci * dl;
                qx[j] -= nx * dl * wj; qy[j] -= ny * dl * wj; qa[j] -= ij * cj * dl;
                wake(K, i, 0.5); wake(K, j, 0.5);
              } else {
                continue;
              }
              refreshRot(S, i); refreshRot(S, j);
              ax = qx[i] + (cs[i] * ux[a] - sn[i] * uy[a]) * si;
              ay = qy[i] + (sn[i] * ux[a] + cs[i] * uy[a]) * si;
            }
          }
          }
          }
        }
      }
    }
  }
  if (tally) {
    K.stat.contacts = contacts;
    K.stat.pen = overlapN ? pen / overlapN : 0;
    K.stat.maxPen = maxPen;
  }
}

/**
 * Restitution and tangential damping between clumps, on the derived velocity —
 * the shape-mode contactVelocityPass. The velocity of a contact point is the
 * body's plus its spin times the lever arm, and the impulse goes back through
 * the same generalised mass the projection uses.
 */
function contactVelocityPassShape(K, live, nlive, vx, vy) {
  const e = K.cfg.restitution;
  const tdamp = clamp(K.cfg.friction * TDAMP_K, 0, 0.9);
  const S = K.shape, D = S.D;
  const { qx, qy, rad, invm, slept, order, cellStart } = K;
  const { iinv, mem, sc, cs, sn, angv } = S;
  const { mg, gOffs, gx: ugx, gy: ugy, gr: ugr, cx: ux, cy: uy, cr: ur } = D;
  const gap = K.cfg.gap;
  for (let k = 0; k < nlive; k++) refreshRot(S, live[k]);
  for (let oi = 0; oi < nlive; oi++) {
    const i = order[oi];
    const wi = slept[i] ? 0 : invm[i], ii = slept[i] ? 0 : iinv[i];
    const cxi = clamp(((qx[i] - K.gox) / K.gcs) | 0, 0, K.gx - 1);
    const cyi = clamp(((qy[i] - K.goy) / K.gcs) | 0, 0, K.gy - 1);
    for (let dy = -1; dy <= 1; dy++) {
      const cy = cyi + dy; if (cy < 0 || cy >= K.gy) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const cx = cxi + dx; if (cx < 0 || cx >= K.gx) continue;
        const c = cy * K.gx + cx;
        const en = cellStart[c + 1];
        for (let kk = cellStart[c]; kk < en; kk++) {
          const j = order[kk];
          if (j <= i) continue;
          const wj = slept[j] ? 0 : invm[j], ij = slept[j] ? 0 : iinv[j];
          if (wi + wj <= 0) continue;
          const bxv = qx[j] - qx[i], byv = qy[j] - qy[i];
          const reachB = (rad[i] + rad[j] + gap) * 1.02;
          if (bxv * bxv + byv * byv > reachB * reachB) continue;
          const si = sc[i], sj = sc[j];
          const ma = mem[i], mb = mem[j];
          for (let ga = mg[ma], gae = mg[ma + 1]; ga < gae; ga++) {
            const gra = ugr[ga] * si;
            const gax = qx[i] + (cs[i] * ugx[ga] - sn[i] * ugy[ga]) * si;
            const gay = qy[i] + (sn[i] * ugx[ga] + cs[i] * ugy[ga]) * si;
          for (let gb = mg[mb], gbe = mg[mb + 1]; gb < gbe; gb++) {
            const grb = ugr[gb] * sj;
            const gbx = qx[j] + (cs[j] * ugx[gb] - sn[j] * ugy[gb]) * sj;
            const gby = qy[j] + (sn[j] * ugx[gb] + cs[j] * ugy[gb]) * sj;
            const glim = (gra + grb + gap) * 1.02;
            if ((gbx - gax) ** 2 + (gby - gay) ** 2 > glim * glim) continue;
          for (let a = gOffs[ga], ae = gOffs[ga + 1]; a < ae; a++) {
            const ra = ur[a] * si;
            const ax = qx[i] + (cs[i] * ux[a] - sn[i] * uy[a]) * si;
            const ay = qy[i] + (sn[i] * ux[a] + cs[i] * uy[a]) * si;
            for (let b = gOffs[gb], be = gOffs[gb + 1]; b < be; b++) {
              const rb = ur[b] * sj;
              const bwx = qx[j] + (cs[j] * ux[b] - sn[j] * uy[b]) * sj;
              const bwy = qy[j] + (sn[j] * ux[b] + cs[j] * uy[b]) * sj;
              const dxv = bwx - ax, dyv = bwy - ay;
              const rest = ra + rb + gap;
              const d2 = dxv * dxv + dyv * dyv;
              if (d2 > rest * rest * 1.04 || d2 < 1e-9) continue;
              const dist = Math.sqrt(d2);
              const nx = dxv / dist, ny = dyv / dist;
              const pcx = ax + nx * ra, pcy = ay + ny * ra;
              const rix = pcx - qx[i], riy = pcy - qy[i];
              const rjx = pcx - qx[j], rjy = pcy - qy[j];
              // Contact-point velocities: v + w x r.
              const rvx = (vx[j] - angv[j] * rjy) - (vx[i] - angv[i] * riy);
              const rvy = (vy[j] + angv[j] * rjx) - (vy[i] + angv[i] * rix);
              const vn = rvx * nx + rvy * ny;
              if (tdamp > 0) {
                const tvx = rvx - nx * vn, tvy = rvy - ny * vn;
                const tl = Math.sqrt(tvx * tvx + tvy * tvy);
                if (tl > 1e-6) {
                  const tx = tvx / tl, ty = tvy / tl;
                  const cti = rix * ty - riy * tx, ctj = rjx * ty - rjy * tx;
                  const J = (tdamp * tl) / (wi + ii * cti * cti + wj + ij * ctj * ctj);
                  vx[i] += tx * J * wi; vy[i] += ty * J * wi; angv[i] += ii * cti * J;
                  vx[j] -= tx * J * wj; vy[j] -= ty * J * wj; angv[j] -= ij * ctj * J;
                }
              }
              if (e <= 0.005 || vn >= 0) continue;
              const ci = rix * ny - riy * nx, cj = rjx * ny - rjy * nx;
              const J = (-(1 + e) * vn) / (wi + ii * ci * ci + wj + ij * cj * cj);
              vx[i] -= nx * J * wi; vy[i] -= ny * J * wi; angv[i] -= ii * ci * J;
              vx[j] += nx * J * wj; vy[j] += ny * J * wj; angv[j] += ij * cj * J;
            }
          }
          }
          }
        }
      }
    }
  }
}

/**
 * Wall restitution and friction for clumps, at the deepest contact point this
 * substep — the shape-mode wallResponse.
 */
function wallResponseShape(K, live, nlive, vx, vy) {
  const e = K.cfg.restitution;
  const mu = clamp(K.cfg.friction, 0, 1);
  const S = K.shape;
  const { angv, iinv, wrx, wry } = S;
  for (let k = 0; k < nlive; k++) {
    const i = live[k];
    if (!K.wallHit[i] || K.slept[i]) continue;
    let nx = K.wnx[i], ny = K.wny[i];
    const nl = Math.sqrt(nx * nx + ny * ny);
    if (nl < 1e-6) continue;
    nx /= nl; ny /= nl;
    const rx = wrx[i], ry = wry[i];
    const wi = K.invm[i], ii = iinv[i];
    const pvx = vx[i] - angv[i] * ry, pvy = vy[i] + angv[i] * rx;
    const vn = pvx * nx + pvy * ny;
    if (vn < 0) {
      const c = rx * ny - ry * nx;
      const J = (-(1 + e) * vn) / (wi + ii * c * c);
      vx[i] += nx * J * wi; vy[i] += ny * J * wi; angv[i] += ii * c * J;
    }
    if (mu > 0) {
      const qvx = vx[i] - angv[i] * ry, qvy = vy[i] + angv[i] * rx;
      const vn2 = qvx * nx + qvy * ny;
      const tvx = qvx - nx * vn2, tvy = qvy - ny * vn2;
      const tl = Math.sqrt(tvx * tvx + tvy * tvy);
      if (tl > 1e-6) {
        const tx = tvx / tl, ty = tvy / tl;
        const ct = rx * ty - ry * tx;
        const f = clamp(mu * TDAMP_K * 4, 0, 1);
        const J = (f * tl) / (wi + ii * ct * ct);
        vx[i] -= tx * J * wi; vy[i] -= ty * J * wi; angv[i] -= ii * ct * J;
      }
    }
  }
}

/**
 * Re-index the occupancy grid from the current positions and the current live
 * set.
 *
 * The contact grid is rebuilt inside every substep, so nothing INSIDE the step
 * needs this. What needs it is anything that moves or removes a particle AFTER
 * the step: `wrap` teleports one across the box, and the bounds/age kill takes
 * one out of the pool. Both leave `cellStart`/`order` describing the world as it
 * was, and next frame's emission asks that index whether a point is free — so a
 * wrapped particle is defended where it used to be and handed out where it now
 * is, and a dead one goes on reserving its spot for a frame.
 */
export function reindexOccupancy(K, live, nlive, zOn) {
  buildGrid(K, live, nlive, zOn);
}

/**
 * Uniform grid over the live set, by counting sort. Rebuilt every substep,
 * because a projection pass moves everything.
 */
function buildGrid(K, live, nlive, zOn) {
  if (nlive === 0) { K.cellCount = 0; return; }
  const { qx, qy, qz, rad } = K;
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  let maxRad = 1e-3;
  for (let k = 0; k < nlive; k++) {
    const i = live[k];
    const x = qx[i], y = qy[i], z = qz[i];
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
    if (rad[i] > maxRad) maxRad = rad[i];
  }
  K.maxRad = maxRad;
  K.gcs = Math.max((2 * maxRad + K.cfg.gap) * TOUCH, 1e-3);
  const span = () => {
    K.gx = Math.max(1, Math.ceil((maxx - minx) / K.gcs) + 1);
    K.gy = Math.max(1, Math.ceil((maxy - miny) / K.gcs) + 1);
    K.gz = zOn ? Math.max(1, Math.ceil((maxz - minz) / K.gcs) + 1) : 1;
    return K.gx * K.gy * K.gz;
  };
  let cells = span();
  let guard = 0;
  while (cells > MAXCELLS && guard++ < 40) { K.gcs *= 1.6; cells = span(); }
  K.gox = minx; K.goy = miny; K.goz = minz;
  K.cellCount = cells;

  if (K.cellStart.length < cells + 1) {
    K.cellStart = new Int32Array(cells + 1);
    K.cellFill = new Int32Array(cells + 1);
  }
  const { cellStart, cellFill, order } = K;
  cellStart.fill(0, 0, cells + 1);
  for (let k = 0; k < nlive; k++) cellStart[cellOf(K, live[k], zOn) + 1]++;
  for (let c = 0; c < cells; c++) cellStart[c + 1] += cellStart[c];
  cellFill.set(cellStart.subarray(0, cells + 1));
  for (let k = 0; k < nlive; k++) {
    const i = live[k];
    order[cellFill[cellOf(K, i, zOn)]++] = i;
  }
}

function cellOf(K, i, zOn) {
  const cx = clamp(((K.qx[i] - K.gox) / K.gcs) | 0, 0, K.gx - 1);
  const cy = clamp(((K.qy[i] - K.goy) / K.gcs) | 0, 0, K.gy - 1);
  const cz = zOn ? clamp(((K.qz[i] - K.goz) / K.gcs) | 0, 0, K.gz - 1) : 0;
  return (cz * K.gy + cy) * K.gx + cx;
}

/**
 * Is there already a particle within `r` of this point?
 *
 * EMISSION MUST REFUSE TO SPAWN INTO OCCUPIED SPACE, and this is not polish. A
 * 2600/s nozzle stacked a frame's worth — 43 grains — on one point in the lab,
 * and the solver answered the resulting 6px overlap with a 10,000 px/s ejection.
 * Rate then self-throttles to what physically fits, which is correct.
 *
 * The grid is one substep stale when emission calls this (emission runs before
 * the step), which is close enough to refuse a spawn — but only for particles
 * that were already in it. The caller must also test the frame's OWN spawns; see
 * `occupiedByFresh`.
 */
export function occupied(K, x, y, z, r, zOn) {
  if (!K || K.cellCount === 0) return false;
  const { cellStart, order, qx, qy, qz, rad } = K;
  const cxi = clamp(((x - K.gox) / K.gcs) | 0, 0, K.gx - 1);
  const cyi = clamp(((y - K.goy) / K.gcs) | 0, 0, K.gy - 1);
  const czi = zOn ? clamp(((z - K.goz) / K.gcs) | 0, 0, K.gz - 1) : 0;
  for (let dz = zOn ? -1 : 0; dz <= (zOn ? 1 : 0); dz++) {
    const cz = czi + dz; if (cz < 0 || cz >= K.gz) continue;
    for (let dy = -1; dy <= 1; dy++) {
      const cy = cyi + dy; if (cy < 0 || cy >= K.gy) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const cx = cxi + dx; if (cx < 0 || cx >= K.gx) continue;
        const c = (cz * K.gy + cy) * K.gx + cx;
        const e = cellStart[c + 1];
        for (let k = cellStart[c]; k < e; k++) {
          const j = order[k];
          const ddx = qx[j] - x, ddy = qy[j] - y, ddz = zOn ? qz[j] - z : 0;
          const rest = (r + rad[j]) * 0.9;   // 10% interlock is a pack, not a pile-up
          if (ddx * ddx + ddy * ddy + ddz * ddz < rest * rest) return true;
        }
      }
    }
  }
  return false;
}

/**
 * NO INTERLOCK FOR A SHAPE BIRTH — a birth must clear every outline outright.
 *
 * The circle test lets a new bead sit 10% into its neighbours ("a pack, not a
 * pile-up"), and copying that here was a measured mistake. A clump's circles are
 * a stroke wide, so 10% of two of them is a few px of overlap — which the first
 * substep resolves in 1/240 s and derives as ~1,000 px/s. On the user's own
 * 24-letter swirl the burst came out at a mean 1,135 px/s a tenth of a second
 * in (circles: 122) and flung most of the letters out of the box.
 */
const SHAPE_BIRTH_K = 1.02;

/**
 * Shape-mode `occupied`: would member `m` at (x, y), scale `s`, angle `a` overlap
 * a body already in the grid?
 *
 * The circle test on a letter's BOUNDING circle refused far too much: a tall K's
 * bounding circle is most of a letter wide, so a birth anywhere near a letter was
 * turned away, and a 60-letter swirl came out with 40. This tests the outlines.
 */
export { SHAPE_BIRTH_K };

export function occupiedShape(K, x, y, m, s, a) {
  if (!K || K.cellCount === 0) return false;
  const S = K.shape, D = S.D;
  const { cellStart, order, qx, qy, rad } = K;
  const R = D.bound[m] * s;
  const ac = Math.cos(a), as = Math.sin(a);
  const cxi = clamp(((x - K.gox) / K.gcs) | 0, 0, K.gx - 1);
  const cyi = clamp(((y - K.goy) / K.gcs) | 0, 0, K.gy - 1);
  for (let dy = -1; dy <= 1; dy++) {
    const cy = cyi + dy; if (cy < 0 || cy >= K.gy) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const cx = cxi + dx; if (cx < 0 || cx >= K.gx) continue;
      const c = cy * K.gx + cx;
      const e = cellStart[c + 1];
      for (let k = cellStart[c]; k < e; k++) {
        const j = order[k];
        const lim = R + rad[j];
        if ((qx[j] - x) ** 2 + (qy[j] - y) ** 2 > lim * lim) continue;
        if (clumpsOverlap(D, m, x, y, ac, as, s, S.mem[j], qx[j], qy[j],
          Math.cos(S.qa[j]), Math.sin(S.qa[j]), S.sc[j], SHAPE_BIRTH_K)) return true;
      }
    }
  }
  return false;
}

/** Refresh radius and inverse mass for the live set. Mass goes as r^3 (r^2 flat). */
export function setRadii(K, live, nlive, radiusOf, zOn) {
  const { rad, invm } = K;
  for (let k = 0; k < nlive; k++) {
    const i = live[k];
    const r = Math.max(0.05, radiusOf(i));
    rad[i] = r;
    invm[i] = 1 / (zOn ? r * r * r : r * r);
  }
}

/* ── PBD pair projection ────────────────────────────────────────────────────
   For every pair inside the 3x3x3 stencil: push apart along the normal by the
   overlap, split by inverse mass. Then Macklin's static-friction clamp on the
   TANGENTIAL part of this substep's displacement — that clamp is what gives a
   pile an angle of repose instead of a puddle. */
function projectPairs(K, live, nlive, zOn, tally) {
  const C = K.cfg;
  const mu = C.friction, coh = C.cohesion, cohR = 1 + C.cohesionRange;
  const stiff = C.stiffness, gap = C.gap;
  const { qx, qy, qz, sx, sy, sz, rad, invm, slept, cont, ovl, order, cellStart } = K;
  let pen = 0, maxPen = 0, contacts = 0, overlapN = 0;

  // Contacts are a per-SUBSTEP quantity, not a per-iteration one: tallying them
  // every iteration multiplied the pressure read by `iters`.
  if (tally) {
    for (let k = 0; k < nlive; k++) { cont[live[k]] = 0; ovl[live[k]] = 0; }
  }

  for (let oi = 0; oi < nlive; oi++) {
    const i = order[oi];
    const ri = rad[i];
    const cxi = clamp(((qx[i] - K.gox) / K.gcs) | 0, 0, K.gx - 1);
    const cyi = clamp(((qy[i] - K.goy) / K.gcs) | 0, 0, K.gy - 1);
    const czi = zOn ? clamp(((qz[i] - K.goz) / K.gcs) | 0, 0, K.gz - 1) : 0;

    for (let dz = zOn ? -1 : 0; dz <= (zOn ? 1 : 0); dz++) {
      const cz = czi + dz; if (cz < 0 || cz >= K.gz) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const cy = cyi + dy; if (cy < 0 || cy >= K.gy) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const cx = cxi + dx; if (cx < 0 || cx >= K.gx) continue;
          const c = (cz * K.gy + cy) * K.gx + cx;
          const e = cellStart[c + 1];
          for (let k = cellStart[c]; k < e; k++) {
            const j = order[k];
            if (j <= i) continue;                       // each pair once

            let dxv = qx[j] - qx[i], dyv = qy[j] - qy[i], dzv = zOn ? qz[j] - qz[i] : 0;
            const rest = ri + rad[j] + gap;
            const reach = Math.max(rest * TOUCH, coh > 0 ? rest * cohR : 0);
            const d2 = dxv * dxv + dyv * dyv + dzv * dzv;
            if (d2 > reach * reach) continue;
            let dist = Math.sqrt(d2);
            if (dist < 1e-6) { dxv = 0.01; dyv = 0; dzv = 0; dist = 0.01; }
            const nx = dxv / dist, ny = dyv / dist, nz = dzv / dist;
            const overlap = rest - dist;

            // Counted BEFORE the sleep test: a contact between two sleeping
            // particles is still a contact, a settled pile is mostly those, and
            // a residual measured only over the awake handful described the
            // wrong pack entirely.
            if (tally && dist < rest * TOUCH) {
              contacts++; cont[i]++; cont[j]++;
              if (overlap > ovl[i]) ovl[i] = overlap;
              if (overlap > ovl[j]) ovl[j] = overlap;
              if (slept[i] !== slept[j]) wakeIsland(K, slept[i] ? i : j, slept[i] ? j : i, zOn);
              if (overlap > 0) { pen += overlap; overlapN++; if (overlap > maxPen) maxPen = overlap; }
            }

            // Waking happens BEFORE the both-asleep skip, or a pair that fell
            // asleep already overlapping is frozen that way for ever: it can
            // never be projected apart and neither can wake the other.
            if (overlap > 0) { wake(K, i, overlap); wake(K, j, overlap); }

            const wi = slept[i] ? 0 : invm[i], wj = slept[j] ? 0 : invm[j];
            const wsum = wi + wj;
            if (wsum <= 0) continue;                    // both asleep

            if (overlap > 0) {
              const s = (overlap * stiff) / wsum;
              qx[i] -= nx * s * wi; qy[i] -= ny * s * wi; if (zOn) qz[i] -= nz * s * wi;
              qx[j] += nx * s * wj; qy[j] += ny * s * wj; if (zOn) qz[j] += nz * s * wj;

              if (mu > 0) {
                // relative displacement this substep, tangential component only
                let rx = (qx[i] - sx[i]) - (qx[j] - sx[j]);
                let ry = (qy[i] - sy[i]) - (qy[j] - sy[j]);
                let rz = zOn ? (qz[i] - sz[i]) - (qz[j] - sz[j]) : 0;
                const rn = rx * nx + ry * ny + rz * nz;
                rx -= nx * rn; ry -= ny * rn; rz -= nz * rn;
                const tl = Math.sqrt(rx * rx + ry * ry + rz * rz);
                if (tl > 1e-6) {
                  // static below mu*d, dynamic (clamped) above — one branch, both
                  const k2 = Math.min(1, (mu * overlap) / tl);
                  const fi = (k2 * wi) / wsum, fj = (k2 * wj) / wsum;
                  qx[i] -= rx * fi; qy[i] -= ry * fi; if (zOn) qz[i] -= rz * fi;
                  qx[j] += rx * fj; qy[j] += ry * fj; if (zOn) qz[j] += rz * fj;
                }
              }
            } else if (coh > 0 && dist < reach) {
              // short-range attraction: falls off to nothing at `reach`
              const t = 1 - (dist - rest) / (reach - rest);
              const s = coh * t * t * 0.5 * Math.min(rest, dist) / wsum;
              qx[i] += nx * s * wi; qy[i] += ny * s * wi; if (zOn) qz[i] += nz * s * wi;
              qx[j] -= nx * s * wj; qy[j] -= ny * s * wj; if (zOn) qz[j] -= nz * s * wj;
              wake(K, i, 0.5); wake(K, j, 0.5);
            }
          }
        }
      }
    }
  }
  if (tally) {
    K.stat.contacts = contacts;
    K.stat.pen = overlapN ? pen / overlapN : 0;
    K.stat.maxPen = maxPen;
  }
}

/*
 * ISLAND PROPAGATION. A sleeper wakes when a particle it is touching is
 * genuinely MOVING — measured as drift from that neighbour's own anchor, the
 * same criterion sleeping uses, so there is no second magic threshold.
 *
 * Without this a bead whose support drains out from under it hangs in mid-air:
 * losing your support leaves a GAP, not an overlap, so the push-based `wake`
 * below never fires. It is what jammed the lab's hopper solid while the throat
 * kept flowing. `a` is the sleeper, `b` the awake neighbour.
 */
function wakeIsland(K, a, b, zOn) {
  const th = K.cfg.sleepDrift * K.rad[b];
  const dx = K.qx[b] - K.anx[b], dy = K.qy[b] - K.any[b], dz = zOn ? K.qz[b] - K.anz[b] : 0;
  if (dx * dx + dy * dy + dz * dz > th * th) {
    K.slept[a] = 0; K.sleepT[a] = 0;
    K.anx[a] = K.qx[a]; K.any[a] = K.qy[a]; K.anz[a] = K.qz[a];
    if (K.shape) K.shape.anA[a] = K.shape.qa[a];
  }
}

/*
 * A sleeping particle wakes when something actually PUSHES into it, not merely
 * when it is touched. The threshold has to sit well above the solver's own
 * steady-state residual — at 2% of a radius the pack's leftover overlap woke
 * every sleeper on the next substep and nothing ever settled.
 */
function wake(K, i, overlap) {
  if (K.slept[i] && overlap > K.tr[i] * 0.2) {
    K.slept[i] = 0; K.sleepT[i] = 0;
    K.anx[i] = K.qx[i]; K.any[i] = K.qy[i]; K.anz[i] = K.qz[i];
    if (K.shape) K.shape.anA[i] = K.shape.qa[i];
  }
}

/*
 * Restitution and tangential damping, as an explicit impulse pass.
 *
 * PBD's position projection is perfectly inelastic, so any bounce has to be
 * added back deliberately — and it has to be added AFTER the velocity is
 * re-derived, or (q - p)/h simply overwrites it. Skipped at e ~ 0 with no
 * friction, which is the packing case and the common one.
 */
function contactVelocityPass(K, live, nlive, vx, vy, vz, zOn) {
  const e = K.cfg.restitution;
  const tdamp = clamp(K.cfg.friction * TDAMP_K, 0, 0.9);
  const { qx, qy, qz, rad, invm, slept, order, cellStart } = K;
  const gap = K.cfg.gap;
  for (let oi = 0; oi < nlive; oi++) {
    const i = order[oi];
    const wi = slept[i] ? 0 : invm[i];
    const cxi = clamp(((qx[i] - K.gox) / K.gcs) | 0, 0, K.gx - 1);
    const cyi = clamp(((qy[i] - K.goy) / K.gcs) | 0, 0, K.gy - 1);
    const czi = zOn ? clamp(((qz[i] - K.goz) / K.gcs) | 0, 0, K.gz - 1) : 0;
    for (let dz = zOn ? -1 : 0; dz <= (zOn ? 1 : 0); dz++) {
      const cz = czi + dz; if (cz < 0 || cz >= K.gz) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const cy = cyi + dy; if (cy < 0 || cy >= K.gy) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const cx = cxi + dx; if (cx < 0 || cx >= K.gx) continue;
          const c = (cz * K.gy + cy) * K.gx + cx;
          const en = cellStart[c + 1];
          for (let k = cellStart[c]; k < en; k++) {
            const j = order[k];
            if (j <= i) continue;
            const wj = slept[j] ? 0 : invm[j], wsum = wi + wj;
            if (wsum <= 0) continue;
            const dxv = qx[j] - qx[i], dyv = qy[j] - qy[i], dzv = zOn ? qz[j] - qz[i] : 0;
            const rest = rad[i] + rad[j] + gap;
            const d2 = dxv * dxv + dyv * dyv + dzv * dzv;
            if (d2 > rest * rest * 1.04 || d2 < 1e-9) continue;
            const dist = Math.sqrt(d2);
            const nx = dxv / dist, ny = dyv / dist, nz = dzv / dist;
            const rvx = vx[j] - vx[i], rvy = vy[j] - vy[i], rvz = zOn ? vz[j] - vz[i] : 0;
            const vn = rvx * nx + rvy * ny + rvz * nz;

            if (tdamp > 0) {
              const tx = rvx - nx * vn, ty = rvy - ny * vn, tz = zOn ? rvz - nz * vn : 0;
              const ji = (tdamp * wi) / wsum, jj = (tdamp * wj) / wsum;
              vx[i] += tx * ji; vy[i] += ty * ji; if (zOn) vz[i] += tz * ji;
              vx[j] -= tx * jj; vy[j] -= ty * jj; if (zOn) vz[j] -= tz * jj;
            }

            if (e <= 0.005 || vn >= 0) continue;         // already separating
            const J = (-(1 + e) * vn) / wsum;
            vx[i] -= nx * J * wi; vy[i] -= ny * J * wi; if (zOn) vz[i] -= nz * J * wi;
            vx[j] += nx * J * wj; vy[j] += ny * J * wj; if (zOn) vz[j] += nz * J * wj;
          }
        }
      }
    }
  }
}

/**
 * One frame of packing.
 *
 * The caller has already run its whole force pipeline and holds the post-force
 * velocity in vx/vy/vz, plus the delta that pipeline produced this frame in
 * dvx/dvy/dvz. This substeps position + contacts, writes the corrected position
 * back into px/py/pz and the derived velocity back into vx/vy/vz.
 *
 * `dv` is REMOVED once on entry and re-applied in `substeps` equal parts, so the
 * frame's total impulse is identical to the caller's own and every substep has a
 * driving force. See the header for what happens without that.
 *
 * `clampPos(i)` is the caller's walls and SDF collider, operating on K.qx/qy/qz.
 * It must record the contact normal via `markWall` and must NOT touch velocity:
 * the derivation two lines later would discard it, which is exactly how the
 * lab's wall friction turned out to be dead code and why its sand pile slid out
 * flat instead of heaping.
 *
 * `travelOf(i)` is the caller's per-particle step scale (proximity Speed x and
 * Freeze). It is the DIVISOR in the velocity derivation, not STEP_DT: dividing
 * by dt would turn a step-distance scale into a permanent velocity rescale, and
 * at Freeze 100% (travel 0) it would zero the momentum the particle is
 * documented to keep.
 */
export function packingStep(K, px, py, pz, vx, vy, vz, live, nlive, dt, zOn, clampPos, travelOf, dvx, dvy, dvz) {
  const C = K.cfg;
  const N = Math.max(1, C.substeps | 0);
  const iters = Math.max(1, C.iters | 0);
  const h = dt / N;
  const { qx, qy, qz, sx, sy, sz, slept, cont, ovl, anx, any, anz, wallHit } = K;
  const hasDv = !!dvx;
  // Shape mode: rigid clumps with an angle. Null for circles, and every branch
  // below that reads it leaves the circle arithmetic exactly as it was.
  const SH = K.shape;
  const ang = SH ? SH.ang : null, angv = SH ? SH.angv : null;

  /*
   * WAKE ON A CHANGED FORCE — the rule the lab has no way to discover, because
   * nothing in it animates a field over a settled pack.
   *
   * A sleeping particle is skipped by the prediction, so it stops responding to
   * anything the force pipeline does. The three wake rules carried over from the
   * lab are "a neighbour is moving", "something pushed into me" and the pointer;
   * none of them is "the field around me changed". Without a fourth, a pile that
   * settles in a calm field and is then hit by a gust, a pulse blast or a vortex
   * ramping up stays frozen while the gust flows past a stack of statues.
   *
   * `dv` is the whole frame's force impulse and it is already computed, so this
   * costs nothing and covers every source at once — fluid, blasts, vortices,
   * Layer Velocity, proximity. The test is against the impulse the particle was
   * carrying when it fell asleep, not against zero, because gravity is in `dv`
   * every frame including for a pack that is quite properly asleep.
   *
   * The threshold is the sleep threshold, reused: a change big enough to move
   * the particle further than `sleepDrift` radii in one frame is by definition a
   * change big enough that it should not be asleep. No second magic number.
   */
  if (hasDv) {
    const { sdx, sdy, sdz, rad } = K;
    for (let k = 0; k < nlive; k++) {
      const i = live[k];
      if (!slept[i]) continue;
      const ex = dvx[i] - sdx[i], ey = dvy[i] - sdy[i], ez = zOn ? dvz[i] - sdz[i] : 0;
      const th = (C.sleepDrift * rad[i]) / dt;
      if (ex * ex + ey * ey + ez * ez > th * th) {
        slept[i] = 0; K.sleepT[i] = 0;
        anx[i] = px[i]; any[i] = py[i]; anz[i] = pz[i];
        if (SH) SH.anA[i] = ang[i];
      }
    }
  }

  // Rewind the frame's force impulse; it goes back on in N equal parts below.
  if (hasDv) {
    for (let k = 0; k < nlive; k++) {
      const i = live[k];
      vx[i] -= dvx[i]; vy[i] -= dvy[i]; if (zOn) vz[i] -= dvz[i];
    }
  }

  for (let sub = 0; sub < N; sub++) {
    if (hasDv) {
      for (let k = 0; k < nlive; k++) {
        const i = live[k];
        if (slept[i]) continue;
        vx[i] += dvx[i] / N; vy[i] += dvy[i] / N; if (zOn) vz[i] += dvz[i] / N;
      }
    }
    // 1 — predict. A sleeping particle is skipped entirely and behaves as static
    // mass in the projection; that is where most of the win in a settled pile is.
    let awake = 0;
    for (let k = 0; k < nlive; k++) {
      const i = live[k];
      sx[i] = px[i]; sy[i] = py[i]; sz[i] = zOn ? pz[i] : 0;
      if (SH) { SH.sa[i] = ang[i]; SH.qa[i] = ang[i]; SH.wdep[i] = 0; }
      if (slept[i]) { qx[i] = px[i]; qy[i] = py[i]; qz[i] = zOn ? pz[i] : 0; continue; }
      awake++;
      const tv = travelOf(i) / N;
      qx[i] = px[i] + vx[i] * tv;
      qy[i] = py[i] + vy[i] * tv;
      qz[i] = zOn ? pz[i] + vz[i] * tv : 0;
      // The turn is scaled by the same step scale as the travel, so Freeze
      // stops a spinning letter as well as a moving one.
      if (SH) SH.qa[i] = ang[i] + angv[i] * tv;
    }
    K.stat.awake = awake;

    // 2 — pairs.
    if (nlive > 1) {
      buildGrid(K, live, nlive, zOn);
      if (SH) for (let it = 0; it < iters; it++) projectShapePairs(K, live, nlive, it === iters - 1);
      else for (let it = 0; it < iters; it++) projectPairs(K, live, nlive, zOn, it === iters - 1);
    }
    // The clamp below places circles by the body's current angle.
    if (SH) for (let k = 0; k < nlive; k++) refreshRot(SH, live[k]);

    // 3 — walls and the collider, AFTER the pairs, so a particle squeezed by its
    // neighbours can never end up outside the container.
    for (let k = 0; k < nlive; k++) {
      const i = live[k];
      wallHit[i] = 0; K.wnx[i] = 0; K.wny[i] = 0; K.wnz[i] = 0;
      if (!slept[i]) clampPos(i);
    }

    /*
     * 4 — velocity from the corrected position.
     *
     * SPEED CEILING. A deep overlap resolved in one substep becomes an enormous
     * velocity — a 43-grain pile-up at a nozzle mouth ejected grains at
     * 10,000 px/s in the lab. Capping the POSITION correction instead was worse:
     * it stopped the ejection but left fast grains unable to get out of each
     * other's way, so they tunnelled through the pile and it settled as a
     * one-grain carpet that never heaped. The cap belongs on velocity, at the
     * limit the grid can honour anyway — beyond ~1/3 of a cell per substep the
     * 3x3x3 stencil cannot see the pair it is about to miss. That is the CFL
     * condition, not a fudge.
     */
    const vmax = (K.cellCount > 0 ? K.gcs : 2 * K.maxRad) * 0.35 / h;
    for (let k = 0; k < nlive; k++) {
      const i = live[k];
      if (slept[i]) continue;
      const tv = travelOf(i) / N;
      if (tv > 1e-9) {
        // Freeze 100% (tv = 0) skips the derivation and HOLDS the velocity, so
        // the particle keeps the momentum it arrived with and resumes when it
        // leaves the field — the documented behaviour of Freeze.
        const inv = 1 / tv;
        vx[i] = (qx[i] - px[i]) * inv;
        vy[i] = (qy[i] - py[i]) * inv;
        vz[i] = zOn ? (qz[i] - pz[i]) * inv : 0;
        if (SH) angv[i] = (SH.qa[i] - ang[i]) * inv;
      }
      const sp2 = vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i];
      if (SH) {
        // The fastest point of a spinning body is on its rim: the cap is on
        // travel plus spin times the bounding radius, both scaled together.
        const reachV = Math.sqrt(sp2) + Math.abs(angv[i]) * K.rad[i];
        if (reachV > vmax) {
          const kk = vmax / reachV;
          vx[i] *= kk; vy[i] *= kk; angv[i] *= kk;
          qx[i] = px[i] + vx[i] * tv; qy[i] = py[i] + vy[i] * tv;
          SH.qa[i] = ang[i] + angv[i] * tv;
        }
        px[i] = qx[i]; py[i] = qy[i];
        ang[i] = SH.qa[i];
        continue;
      }
      if (sp2 > vmax * vmax) {
        const kk = vmax / Math.sqrt(sp2);
        vx[i] *= kk; vy[i] *= kk; vz[i] *= kk;
        // the position has to follow the clamped velocity, or the next substep
        // re-derives the speed we just removed
        qx[i] = px[i] + vx[i] * tv; qy[i] = py[i] + vy[i] * tv;
        if (zOn) qz[i] = pz[i] + vz[i] * tv;
      }
      px[i] = qx[i]; py[i] = qy[i]; if (zOn) pz[i] = qz[i];
    }

    // 5 — restitution and wall response, on the DERIVED velocity.
    if (SH) {
      wallResponseShape(K, live, nlive, vx, vy);
      if (nlive > 1 && (C.restitution > 0.005 || C.friction > 0)) {
        contactVelocityPassShape(K, live, nlive, vx, vy);
      }
    } else {
      wallResponse(K, live, nlive, vx, vy, vz, zOn);
      if (nlive > 1 && (C.restitution > 0.005 || C.friction > 0)) {
        contactVelocityPass(K, live, nlive, vx, vy, vz, zOn);
      }
    }
  }

  // 6 — sleeping, tested on DRIFT rather than on speed. The derivation gives a
  // settled pack a permanent velocity floor of roughly residual/h, so no speed
  // threshold low enough to mean "stopped" will ever fire; the jitter is
  // oscillatory, so net displacement from an anchor stays near zero and that is
  // what distinguishes a settled bead from a slowly creeping one.
  if (C.sleep) {
    for (let k = 0; k < nlive; k++) {
      const i = live[k];
      if (slept[i]) continue;
      const dr = C.sleepDrift * K.rad[i];
      const dx = px[i] - anx[i], dy = py[i] - any[i], dz = zOn ? pz[i] - anz[i] : 0;
      // A body also has to stop TURNING: its rim's drift is the angle it has
      // turned through times its bounding radius.
      const da = SH ? (ang[i] - SH.anA[i]) * K.rad[i] : 0;
      // Only a SUPPORTED particle may sleep — one with no contacts is in free
      // fall — and never on an unconverged contact: a pack that slept mid-solve
      // froze 10% overlap permanently, and sleeping pairs are never projected
      // again.
      if (cont[i] > 0 && ovl[i] < K.tr[i] * 0.06 && dx * dx + dy * dy + dz * dz < dr * dr && da * da < dr * dr) {
        if (++K.sleepT[i] > C.sleepFrames) {
          slept[i] = 1; vx[i] = 0; vy[i] = 0; vz[i] = 0;
          if (SH) angv[i] = 0;
          // Remember the force it slept under, so a CHANGE can wake it.
          if (hasDv) { K.sdx[i] = dvx[i]; K.sdy[i] = dvy[i]; K.sdz[i] = dvz[i]; }
        }
      } else {
        K.sleepT[i] = 0; anx[i] = px[i]; any[i] = py[i]; anz[i] = pz[i];
        if (SH) SH.anA[i] = ang[i];
      }
    }
  } else {
    for (let k = 0; k < nlive; k++) { slept[live[k]] = 0; K.sleepT[live[k]] = 0; }
  }
}

/** Record a wall/collider contact normal, pointing INTO the domain. */
export function markWall(K, i, nx, ny, nz) {
  K.wallHit[i] = 1; K.wnx[i] += nx; K.wny[i] += ny; K.wnz[i] += nz;
}

/*
 * Wall restitution and friction, applied AFTER the derivation.
 *
 * This function exists because of the single most expensive finding in the lab:
 * XPBD re-derives velocity as (q - p)/h, which silently discards anything
 * written to v after the position prediction. Wall bounce and wall friction were
 * both written there and were both dead code — and wall friction being inert is
 * why a sand pile slid out into a flat two-grain carpet instead of heaping. The
 * floor it rested on had none.
 */
function wallResponse(K, live, nlive, vx, vy, vz, zOn) {
  const e = K.cfg.restitution;
  const mu = clamp(K.cfg.friction, 0, 1);
  for (let k = 0; k < nlive; k++) {
    const i = live[k];
    if (!K.wallHit[i] || K.slept[i]) continue;
    let nx = K.wnx[i], ny = K.wny[i], nz = zOn ? K.wnz[i] : 0;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl < 1e-6) continue;
    nx /= nl; ny /= nl; nz /= nl;
    const vn = vx[i] * nx + vy[i] * ny + vz[i] * nz;
    if (vn < 0) {
      // reflect the approaching part
      const j = -(1 + e) * vn;
      vx[i] += nx * j; vy[i] += ny * j; vz[i] += nz * j;
    }
    if (mu > 0) {
      // Coulomb-ish tangential damping. The pile's angle of repose comes from
      // here and from the contact pass, never from the position clamp.
      const vn2 = vx[i] * nx + vy[i] * ny + vz[i] * nz;
      const tx = vx[i] - nx * vn2, ty = vy[i] - ny * vn2, tz = vz[i] - nz * vn2;
      const f = clamp(mu * TDAMP_K * 4, 0, 1);
      vx[i] -= tx * f; vy[i] -= ty * f; vz[i] -= tz * f;
    }
  }
}

/**
 * Packing fraction over the live set, for the dev readout.
 *
 * The number the whole feature is named after: ~0.84 is dense random 2D, and
 * 0.9069 is perfect hexagonal.
 *
 * TAKES THE COMMITTED POSITIONS, not K.qx. The first version read the predicted
 * array, which is only meaningful in the middle of a substep — called before the
 * first step it saw an all-zero pool and reported a packing fraction of 125.7.
 *
 * It is bounding-box based, so it is EDGE-BIASED on a small pack: a finite
 * hexagonal lattice measures 0.866 through this, not 0.9069, because the box
 * drawn round it includes the half-diameter stagger of the odd rows and the
 * radius margin at every face. That is a property of the measure and not of the
 * pack, which is why the tests gate lattice DRIFT — a number with an exact
 * answer — and use this only as a plausibility band.
 */
export function packingFraction(K, px, py, pz, live, nlive, zOn) {
  if (nlive < 4) return 0;
  const qx = px, qy = py, qz = pz;
  const { rad } = K;
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  let vol = 0;
  for (let k = 0; k < nlive; k++) {
    const i = live[k];
    const r = rad[i];
    if (qx[i] - r < minx) minx = qx[i] - r; if (qx[i] + r > maxx) maxx = qx[i] + r;
    if (qy[i] - r < miny) miny = qy[i] - r; if (qy[i] + r > maxy) maxy = qy[i] + r;
    if (zOn) { if (qz[i] - r < minz) minz = qz[i] - r; if (qz[i] + r > maxz) maxz = qz[i] + r; }
    vol += zOn ? (4 / 3) * Math.PI * r * r * r : Math.PI * r * r;
  }
  const box = zOn
    ? Math.max(1e-6, (maxx - minx) * (maxy - miny) * (maxz - minz))
    : Math.max(1e-6, (maxx - minx) * (maxy - miny));
  return vol / box;
}
