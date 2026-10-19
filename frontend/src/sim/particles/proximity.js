import { collisionOpenKeep } from './fluid.js';
/*
 * PROXIMITY EFFECTORS — a particle's distance to another layer's SHAPE.
 *
 * A leaf module: no DOM, no three.js, no editor imports, because the solver runs
 * it in a worker and the renderer runs it on the main thread and both need the
 * identical number. The BAKE lives next door in the editor
 * (particleProxField.js) because it needs a canvas; everything here is pure
 * arithmetic over the Float32Array it produces.
 *
 * ── THE ONE DECISION THIS FILE ENCODES ────────────────────────────────────
 *
 * The field is baked in the source artwork's OWN LOCAL SPACE, once, and sampled
 * through the source's live inverse transform every frame.
 *
 * The shipped collider (fluid.js `sdfFromMask`) does the opposite: it lays the
 * alpha over the whole solver box at a fixed 384x216 and bakes there. That is
 * right for a static obstacle and wrong for this, for two reasons that both bite
 * immediately:
 *
 *   1. RESOLUTION FOLLOWS SIZE. A source a quarter of the box wide gets a
 *      quarter of the raster, so its silhouette is blocky exactly where the
 *      falloff band lives — and the falloff band is the whole picture.
 *   2. EVERY MOVE INVALIDATES THE BAKE. The headline case for this feature is a
 *      source that MOVES, and re-chamfering a 384x216 field per frame is not a
 *      thing anyone can ship.
 *
 * Baking locally fixes both. The shape gets its full raster budget whatever size
 * it is drawn at, and moving / rotating / pulsing the source costs three
 * multiplies per particle. Verified in html/particle-proximity-lab.html: two
 * seconds of motion plus 70 deg/s spin plus a 30 % scale pulse leaves the bake
 * counter at one.
 *
 * ── WHAT A POSE IS ────────────────────────────────────────────────────────
 *
 * `{ x, y, scale, rot, cos, sin, t, on }` where cos/sin are of MINUS rot (the
 * world → local rotation, precomputed because it is per-source and the sample is
 * per-particle). `t` is the baked table. The solver receives a flat per-step
 * table instead and rebuilds poses with `proxPoseFromTrack`, the same shape of
 * hand-off `layerDrive` uses and for the same reason: the solver cannot resolve
 * a timeline item's transform itself.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Floats per source per step in the solver's pose track: x, y, scale, rot. */
export const PROX_POSE_STRIDE = 4;

/*
 * ── THE PER-STEP PARAMETER TRACK ──────────────────────────────────────────
 *
 * The block's numbers can be KEYFRAMED (`px:<param>` tracks on the particle
 * layer), and a force has to be integrated, so the solver cannot read one
 * static config for the whole clip any more than it can read one static pose.
 * It gets a second flat table alongside the pose track — same shape, same
 * reason, same hand-off — and rebuilds its working config per step.
 *
 * ONLY THE SOLVER'S OWN PARAMETERS RIDE HERE. The look amounts (size, opacity,
 * colour, spin, bright, stretch, twinkle) are read at DRAW time from the same
 * tracks, per frame, by particleLayer.js — putting them in this table would
 * pull them into the bake key and make animating a look free thing re-simulate,
 * which is the one promise the LOOK / SIM badge in the panel makes.
 *
 * The order below IS the packing order; particleProxTrack.js writes it and
 * `proxParamsAtStep` reads it, so neither restates the list.
 */
export const PROX_PARAM_KEYS = Object.freeze([
  'range', 'falloff', 'depth',
  'attract', 'flow', 'orbit', 'drag', 'speed', 'turb', 'freeze', 'life',
]);
export const PROX_PARAM_STRIDE = PROX_PARAM_KEYS.length;
/** key → slot in one step's row of the params table. */
export const PROX_PARAM_SLOT = Object.freeze(
  PROX_PARAM_KEYS.reduce((acc, k, i) => { acc[k] = i; return acc; }, {}),
);
const S_RANGE = PROX_PARAM_SLOT.range;
const S_FALLOFF = PROX_PARAM_SLOT.falloff;
const S_DEPTH = PROX_PARAM_SLOT.depth;
const S_ATTRACT = PROX_PARAM_SLOT.attract;
const S_FLOW = PROX_PARAM_SLOT.flow;
const S_ORBIT = PROX_PARAM_SLOT.orbit;
const S_DRAG = PROX_PARAM_SLOT.drag;
const S_SPEED = PROX_PARAM_SLOT.speed;
const S_TURB = PROX_PARAM_SLOT.turb;
const S_FREEZE = PROX_PARAM_SLOT.freeze;
const S_LIFE = PROX_PARAM_SLOT.life;

/**
 * Overwrite a working cfg and amount pair from one step of the params table.
 *
 * MUTATES both, deliberately: this runs once per simulation step for the life of
 * a bake, and two fresh objects per step is garbage the hot loop does not need.
 * The enum-ish fields (measure, shape, combine, invert) are never animated — see
 * PARTICLE_PROX_KF_FIELDS — so `cfgOut` keeps whatever it was seeded with.
 */
export function proxParamsAtStep(track, step, cfgOut, amtOut) {
  const d = track.pdata;
  if (!d) return;
  const n = track.n | 0;
  const s = step < 0 ? 0 : step >= n ? n - 1 : step | 0;
  const o = s * PROX_PARAM_STRIDE;
  cfgOut.range = d[o + S_RANGE];
  cfgOut.falloff = d[o + S_FALLOFF];
  cfgOut.depth = d[o + S_DEPTH];
  amtOut.attract = d[o + S_ATTRACT];
  amtOut.flow = d[o + S_FLOW];
  amtOut.orbit = d[o + S_ORBIT];
  amtOut.drag = d[o + S_DRAG];
  // The same unit conversions proxMotionAmounts does, because these are the same
  // numbers arriving by a different road.
  amtOut.speed = d[o + S_SPEED] / 100;
  amtOut.turb = d[o + S_TURB] / 100;
  amtOut.freeze = d[o + S_FREEZE] / 100;
  amtOut.life = d[o + S_LIFE] / 100;
}

/**
 * Bilinear signed distance in LOCAL artwork px — origin at the artwork's centre,
 * +y up, negative INSIDE.
 *
 * Outside the baked box the field is genuinely unknown, so the query is clamped
 * to the border and the remaining straight-line distance added back. That is
 * EXACT on the border and a slight over-estimate beyond it, and it is continuous
 * everywhere — which matters more than exactness, because a discontinuity would
 * show as a hard edge in whatever the effector drives. The bake's padding is
 * sized so the whole usable falloff band sits inside the box (see
 * particleProxField.js), which is what keeps the approximation out of the part
 * of the field anyone can see.
 */
export function sdfLocal(t, x, y) {
  const hx = t.boxW / 2, hy = t.boxH / 2;
  const cx = clamp(x, -hx, hx), cy = clamp(y, -hy, hy);
  const dx = x - cx, dy = y - cy;
  const outside = dx || dy ? Math.sqrt(dx * dx + dy * dy) : 0;
  const W = t.w, H = t.h, d = t.sdf;
  const gx = clamp((cx / t.boxW + 0.5) * W - 0.5, 0, W - 1.001);
  const gy = clamp((0.5 - cy / t.boxH) * H - 0.5, 0, H - 1.001);
  const x0 = gx | 0, y0 = gy | 0, fx = gx - x0, fy = gy - y0;
  const o = x0 + y0 * W;
  return lerp(lerp(d[o], d[o + 1], fx), lerp(d[o + W], d[o + W + 1], fx), fy) + outside;
}

/**
 * Build a pose from a source's live transform.
 * @param {object} table  the baked SDF (needs artW to turn `size` into a scale)
 * @param {number} px,py  the source's centre in the SOLVER BOX's own space
 * @param {number} sizePx the artwork's width in composition px
 * @param {number} rotDeg the source's roll, layer-panel sign
 */
export function makeProxPose(table, px, py, sizePx, rotDeg, on = true) {
  const scale = Math.max(1e-3, sizePx / Math.max(1, table.artW));
  const rot = (rotDeg || 0) * Math.PI / 180;
  return { x: px, y: py, scale, rot, cos: Math.cos(-rot), sin: Math.sin(-rot), t: table, on };
}

/** Byte-free index of one (step, source) slot; out-of-range steps clamp. */
export function proxPoseOffset(track, step, src) {
  const n = track.n | 0;
  const s = step < 0 ? 0 : step >= n ? n - 1 : step | 0;
  return (s * (track.count | 0) + src) * PROX_POSE_STRIDE;
}

/** Rebuild the pose array for one simulation step from the flat track. */
export function proxPosesAtStep(out, track, tables, step) {
  const count = track.count | 0;
  const n = track.n | 0;
  const sIdx = step < 0 ? 0 : step >= n ? n - 1 : step | 0;
  for (let i = 0; i < count; i++) {
    const o = proxPoseOffset(track, step, i);
    const t = tables[i];
    if (!t) { out[i] = null; continue; }
    // `on` is the source layer's presence on the TIMELINE at this step: a
    // following source only acts while the layer it follows is there. Tracks
    // built before the lane existed carry no `on`, and are always on.
    const live = track.on ? track.on[sIdx * count + i] !== 0 : true;
    out[i] = makeProxPose(t, track.data[o], track.data[o + 1], track.data[o + 2], track.data[o + 3], live);
  }
  return out;
}

/*
 * The influence, 0..1, plus the surface normal when `out` is given.
 *
 * Reads like `proximityInfluence` in gridLayout.js on purpose — same Range,
 * Falloff, Shape, Combine and Invert. The only thing that differs is the
 * distance underneath, which is a shape rather than a point.
 *
 * `out.nx/ny` is the world-space gradient of the field at the particle: the
 * SURFACE NORMAL, pointing away from the shape. It is what makes Attract leave a
 * letterform perpendicular to its edge instead of radially from its centre, and
 * it costs four extra samples — so callers pass null whenever nothing reads a
 * direction. That gate is a 5x difference in the per-particle cost.
 */
export function proxInfluence(cfg, poses, x, y, z, out) {
  const n = poses.length;
  const combine = cfg.combine;
  let acc = combine === 'min' ? 1 : 0;
  let live = 0;
  let bestU = -1, bnx = 0, bny = 0;

  for (let i = 0; i < n; i++) {
    const P = poses[i];
    if (!P || P.on === false) continue;
    live += 1;

    // world → local: translate, un-rotate, un-scale.
    const wx = x - P.x, wy = y - P.y;
    const rx = wx * P.cos - wy * P.sin;
    const ry = wx * P.sin + wy * P.cos;

    let d, gxl = 0, gyl = 0;
    if (cfg.measure === 'centre') {
      d = Math.sqrt(rx * rx + ry * ry);
      const L = d || 1e-4; gxl = rx / L; gyl = ry / L;
    } else if (cfg.measure === 'x') {
      d = Math.abs(rx); gxl = rx >= 0 ? 1 : -1;
    } else if (cfg.measure === 'y') {
      d = Math.abs(ry); gyl = ry >= 0 ? 1 : -1;
    } else {
      const lx = rx / P.scale, ly = ry / P.scale;
      const sd = sdfLocal(P.t, lx, ly) * P.scale;
      // 'inside' is DEPTH INTO the shape, and anything not inside has depth 0 —
      // so un-inverted it lights everything outside and fades going in, and
      // INVERTED it lights the core and leaves the outside completely alone.
      // The core look is the one people want; the panel says so on the row.
      d = cfg.measure === 'edge' ? (sd < 0 ? -sd : sd)
        : cfg.measure === 'inside' ? (sd < 0 ? -sd : 0)
          : (sd > 0 ? sd : 0);
      if (out) {
        // Central differences at one raster cell, in LOCAL px. Any smaller and
        // the chamfer's own quantisation dominates the direction.
        const h = (P.t.boxW / P.t.w) * 1.5;
        gxl = sdfLocal(P.t, lx + h, ly) - sdfLocal(P.t, lx - h, ly);
        gyl = sdfLocal(P.t, lx, ly + h) - sdfLocal(P.t, lx, ly - h);
        const gl = Math.sqrt(gxl * gxl + gyl * gyl) || 1;
        gxl /= gl; gyl /= gl;
        // On the Outline measure the distance folds at the contour, so the
        // gradient has to fold with it or the inner half pushes the wrong way.
        if (cfg.measure === 'edge' && sd < 0) { gxl = -gxl; gyl = -gyl; }
      }
    }

    // Depth: the source is a flat plate extruded through z, the same finite
    // extrusion the collider uses (sd3 = max(sd2d, |z| - halfDepth)). At 0 the
    // field is flat and z is ignored, which is what a 2D-authored look expects.
    if (cfg.depth > 0) {
      const zd = (z < 0 ? -z : z) - cfg.depth;
      if (zd > d) d = zd;
    }

    let u;
    if (d <= cfg.range) u = 1;
    else {
      u = clamp01(1 - (d - cfg.range) / (cfg.falloff > 1 ? cfg.falloff : 1));
      u = cfg.shape === 'linear' ? u : cfg.shape === 'sharp' ? u * u : u * u * (3 - 2 * u);
    }

    if (out && u > bestU) {
      bestU = u;
      // Local → world is a rotation by +rot; P.cos/P.sin are of -rot, so
      // cos(rot) = P.cos and sin(rot) = -P.sin.
      bnx = gxl * P.cos + gyl * P.sin;
      bny = -gxl * P.sin + gyl * P.cos;
    }
    if (combine === 'max') { if (u > acc) acc = u; }
    else if (combine === 'min') { if (u < acc) acc = u; }
    else acc += u;
  }

  if (!live) { if (out) { out.nx = 0; out.ny = 0; } return 0; }
  if (combine === 'add') acc = clamp01(acc);
  else if (combine === 'average') acc /= live;

  if (out) { out.nx = bnx; out.ny = bny; }
  return cfg.invert ? 1 - acc : acc;
}

/**
 * The subset of a proximity block the SOLVER reads, flattened to plain numbers.
 * Anything absent is 0, so the hot loop tests numbers and never property
 * existence, and a look-only setup costs the solver one branch.
 */
export function proxMotionAmounts(fx) {
  const f = fx || {};
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return {
    attract: n(f.attract),
    flow: n(f.flow),
    orbit: n(f.orbit),
    drag: n(f.drag),
    speed: n(f.speed) / 100,
    turb: n(f.turb) / 100,
    freeze: n(f.freeze) / 100,
    life: n(f.life) / 100,
  };
}

/** Does any motion amount need the surface normal? Four samples ride on this. */
export function proxNeedsNormal(M) {
  return M.attract !== 0 || M.flow !== 0 || M.orbit !== 0;
}


/**
 * Resolve a particle against a POSED collider — the follow path.
 *
 * The shipped collider (fluid.js `resolveCollision`) bakes the artwork's alpha
 * over the whole Solver Box, which is right for something that never moves and
 * useless for something that does: every frame of motion invalidates the bake.
 * This samples the field in the ARTWORK's own local space instead, through the
 * inverse of a per-step pose, so a collider can be keyframed, parented, scaled
 * and spun for the cost of the same three multiplies a proximity source pays.
 *
 * `pose` is a makeProxPose object. `mode` matches the shipped collider: 1 =
 * obstacle (stay OUT), 2 = container (stay IN). `margin` is the particle's own
 * radius. Writes the corrected position into `p` and the contact normal into
 * `nOut` — and deliberately does NOT touch velocity, because the caller
 * re-derives it from the corrected position immediately afterwards.
 *
 * Returns true when it moved the particle.
 */
export function resolveCollisionPosed(pose, mode, halfDepth, margin, p, nOut, openCfg = null, openAmt = 0, releaseOutside = false) {
  if (!pose || pose.on === false) return false;
  const t = pose.t;
  if (!t || t.empty) return false;
  const sc = pose.scale || 1;

  // world -> local: translate, un-rotate, un-scale. Exactly proxInfluence's.
  const wx = p[0] - pose.x, wy = p[1] - pose.y;
  const lx = (wx * pose.cos - wy * pose.sin) / sc;
  const ly = (wx * pose.sin + wy * pose.cos) / sc;

  // The field is in LOCAL artwork px; a world distance is that times the scale.
  const sd2 = sdfLocal(t, lx, ly) * sc;
  const zd = Math.abs(p[2]) - halfDepth;
  const useZ = zd > sd2;
  const sd = useZ ? zd : sd2;
  if (!(mode === 1 ? sd < margin : sd > -margin)) return false;
  // Once they are out, they stay out — see resolveCollision in fluid.js for why
  // a container with an open side must not re-capture what has already left.
  if (mode === 2 && sd > margin && (releaseOutside || (openCfg && openAmt > 0))) return false;

  let nx = 0, ny = 0, nz = 0;
  if (useZ) {
    nz = p[2] >= 0 ? 1 : -1;
  } else {
    // Central differences in LOCAL space, then rotated back by +rot. The step is
    // in local px and the gradient is dimensionless, so no scale appears here.
    const h = 6 / sc;
    const gx = (sdfLocal(t, lx + h, ly) - sdfLocal(t, lx - h, ly)) / (2 * h);
    const gy = (sdfLocal(t, lx, ly + h) - sdfLocal(t, lx, ly - h)) / (2 * h);
    const gl = Math.hypot(gx, gy) || 1;
    const ux = gx / gl, uy = gy / gl;
    // Local -> world is a rotation by +rot; cos/sin are of -rot.
    nx = ux * pose.cos + uy * pose.sin;
    ny = -ux * pose.sin + uy * pose.cos;
  }
  if (mode === 2) { nx = -nx; ny = -ny; nz = -nz; }
  let pen = Math.min(60, mode === 1 ? margin - sd : sd + margin);
  if (openCfg) {
    const keep = collisionOpenKeep(openCfg, openAmt, nx, ny, nz);
    if (keep <= 0.001) return false;      // this part of the wall is a doorway
    pen *= keep;
  }
  p[0] += nx * pen; p[1] += ny * pen; p[2] += nz * pen;
  if (nOut) { nOut[0] = nx; nOut[1] = ny; nOut[2] = nz; }
  return true;
}

/** Is a point inside a posed CONTAINER, with a margin? Twin of insideCollider. */
export function insideCollisionPosed(pose, halfDepth, x, y, z, margin = 6) {
  if (!pose || pose.on === false || !pose.t || pose.t.empty) return true;
  const sc = pose.scale || 1;
  const wx = x - pose.x, wy = y - pose.y;
  const lx = (wx * pose.cos - wy * pose.sin) / sc;
  const ly = (wx * pose.sin + wy * pose.cos) / sc;
  return sdfLocal(pose.t, lx, ly) * sc < -margin && Math.abs(z) < halfDepth - margin;
}
