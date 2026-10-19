/*
 * LAYER VELOCITY — the editor half.
 *
 * Samples the layers a particle system's Layer Velocity sources point at, once
 * per simulation step, and hands the result to the solver as a flat table
 * (sim/particles/layerDrive.js has the maths and the slot layout). The solver
 * is pure and runs in a worker, so it can no more resolve a timeline item's
 * transform than it can decode a video — the same reason the collision SDF is
 * rasterised here and posted in as `opts.collider`.
 *
 * WHERE THE NUMBERS COME FROM. `resolveItemPrs` is the authority on where a
 * layer is at time t: base fields, keyframe tracks, motion paths, speed ramps
 * and the whole parent chain, in canonical THREE-space. It is the same function
 * the preview gizmos and the Force Emitter overlay resolve with, and its
 * arithmetic is (by its own docstring) a mirror of applyMeshTransform — so a
 * velocity measured from it is the velocity the layer is actually drawn with.
 *
 * WHY IT IS 3D. Motion Blur measures the same thing but only needs the screen
 * map, so it works with two projected boxes and loses z. Nothing here projects:
 * a layer travelling in z, or tumbling on rotateX/rotateY, drives the particles
 * in z too — which is the whole point of a solver whose box has depth.
 *
 * THE FRAME. The simulation lives in the particle layer's OWN space, so a
 * source layer's motion is expressed as seen from there:
 *
 *     M_box(t) = M_particle(t)⁻¹ · M_source(t)
 *
 * That is what makes the drag behave when the particle layer is itself animated
 * — parented, scaled, riding a camera move — instead of the source appearing to
 * fly through the box every time the box moves.
 */

import { resolveItemPrs, getParenting, PRS_BASE_FIELDS } from './keyframeParenting';
import { getItemKeyframeValues } from './gsapTransitions';
import { STEP_DT } from '../../sim/particles/solver';
import {
  LAYER_DRIVE_STRIDE, MAX_LAYER_DRIVES,
  writeLayerDriveSlot, prsToMatrix, mul34, invert34,
} from '../../sim/particles/layerDrive';

/** Tables live only as long as their inputs do; a handful is plenty. */
const tables = new Map();

const IDENTITY_34 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** The force emitters that are Layer Velocity sources, in table-row order. */
export function layerDriveSources(system) {
  return (system?.forceEmitters || []).filter((f) => f.kind === 'layer').slice(0, MAX_LAYER_DRIVES);
}

/**
 * Everything about one item that can move it, plus the same for every ancestor.
 * A table must be rebuilt when any of it changes — and only then, because this
 * runs on every rendered frame.
 */
function prsSignature(index, itemId, seen = new Set()) {
  if (!itemId || seen.has(itemId)) return '';
  seen.add(itemId);
  const entry = index?.get(itemId);
  if (!entry) return `${itemId}:missing`;
  const it = entry.item;
  const base = PRS_BASE_FIELDS.map((k) => it[k] ?? '').join(',');
  const kf = it.propertyKeyframes ? JSON.stringify(it.propertyKeyframes) : '';
  const fx = it.propertyKeyframeFx ? JSON.stringify(it.propertyKeyframeFx) : '';
  const path = it.motionPath ? JSON.stringify(it.motionPath) : '';
  const speed = it.speedPoints ? JSON.stringify(it.speedPoints) : '';
  const parenting = getParenting(it);
  const span = `${entry.startTime}:${entry.endTime}`;
  const up = parenting ? prsSignature(index, parenting.parentItemId, seen) : '';
  return `${itemId}|${span}|${base}|${kf}|${fx}|${path}|${speed}|${parenting ? parenting.type : ''}[${up}]`;
}

/**
 * The Layer Velocity table for one particle system, or null when it has no
 * layer sources (or none of them resolves to a layer that still exists).
 *
 *   system    the particle system
 *   item      the particle layer's own timeline item
 *   index     buildParentIndex(channels, layoutFor)
 *   layout    { startTime, duration } of the particle clip
 *   W, H      composition size
 */
export function layerDriveTableFor({ system, item, index, layout, W, H }) {
  const sources = layerDriveSources(system);
  if (!sources.length || !index || !item) return null;

  const preRoll = Math.max(0, system.solver?.preRoll || 0);
  const duration = Math.max(0.1, layout?.duration || 0);
  const start = layout?.startTime || 0;
  // Exactly the bake's step count (solver.js), so row s is step s and no
  // consumer has to interpolate or guess where the track ends.
  const n = Math.ceil((preRoll + duration) / STEP_DT) + 1;

  const key = [
    'ld1', n, preRoll.toFixed(4), duration.toFixed(4), start.toFixed(4),
    prsSignature(index, item.id),
    ...sources.map((fe) => `${fe.fromItemId || ''}#${fe.radius}#${prsSignature(index, fe.fromItemId)}`),
  ].join('|');

  const hit = tables.get(key);
  if (hit !== undefined) return hit;

  const ctx = { W, H, evalKeyframes: (it, progress) => getItemKeyframeValues(it, progress) };
  // A source whose layer has gone (deleted, or never picked) contributes a row
  // of zeros rather than shifting every row after it: the table's rows are
  // positional, matched to `drivers` order in the solver.
  const live = sources.map((fe) => (fe.fromItemId && index.get(fe.fromItemId) ? fe : null));
  if (!live.some(Boolean)) {
    tables.set(key, null);
    return null;
  }

  const count = sources.length;
  const data = new Float32Array(n * count * LAYER_DRIVE_STRIDE);
  const mp = new Float32Array(12), ms = new Float32Array(12);
  const boxNow = new Float32Array(12), boxPrev = new Float32Array(12);
  const now = new Float32Array(12), prev = new Float32Array(12);

  // Where the particle box is at time `t`, inverted — the frame everything else
  // is measured in. Falls back to the composition when the particle layer
  // resolves to nothing usable (a singular scale, or an item off the index).
  const boxInverseAt = (out, t) => {
    const prs = resolveItemPrs(index, item.id, t, ctx);
    if (!prs) { out.set(IDENTITY_34); return out; }
    prsToMatrix(mp, prs);
    if (!invert34(out, mp)) out.set(IDENTITY_34);
    return out;
  };

  const sourceInBoxAt = (out, boxInv, fromItemId, t) => {
    const prs = resolveItemPrs(index, fromItemId, t, ctx);
    if (!prs) return null;
    prsToMatrix(ms, prs);
    return mul34(out, boxInv, ms);
  };

  for (let s = 0; s < n; s++) {
    // Clip-local time, the solver's own definition. Pre-roll runs the layer at
    // its first frame: the source has not started animating yet, so a system
    // that pre-rolls settles into a still field instead of being kicked by a
    // burst of motion that never happens on screen.
    const tc = s * STEP_DT - preRoll;
    const t = start + Math.max(0, tc);
    const tPrev = start + Math.max(0, tc - STEP_DT);
    const dt = t - tPrev > 1e-6 ? t - tPrev : STEP_DT;
    boxInverseAt(boxNow, t);
    boxInverseAt(boxPrev, tPrev);
    for (let k = 0; k < count; k++) {
      const fe = live[k];
      if (!fe) continue;                       // already a row of zeros
      if (!sourceInBoxAt(now, boxNow, fe.fromItemId, t)) continue;
      if (!sourceInBoxAt(prev, boxPrev, fe.fromItemId, tPrev)) prev.set(now);
      writeLayerDriveSlot(data, (s * count + k) * LAYER_DRIVE_STRIDE, now, prev, dt,
        now[3], now[7], now[11], fe.radius);
    }
  }

  const table = { key, hz: Math.round(1 / STEP_DT), n, count, data };
  if (tables.size > 6) tables.clear();
  tables.set(key, table);
  return table;
}

/** Drop every cached table — for a project switch or a teardown. */
export function clearLayerDriveTables() {
  tables.clear();
}
