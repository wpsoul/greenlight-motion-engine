/*
 * PROXIMITY EFFECTORS — the editor half.
 *
 * Resolves where each proximity source LAYER is, in the particle box's own
 * space, and hands that on as poses. Twin of layerVelocity.js, for the same
 * reason it exists: the solver is pure and runs in a worker, so it can no more
 * resolve a timeline item's transform than it can decode a video.
 *
 * TWO CONSUMERS, ONE FRAME OF REFERENCE:
 *
 *   proxPosesAt()   one time — what the RENDERER needs to shade the frame it is
 *                   drawing. Look targets are read at draw time, so this is the
 *                   whole story for size / opacity / colour / rotation.
 *   proxTrackFor()  every simulation step — what the SOLVER needs, because a
 *                   force has to be integrated and the bake runs ahead of time.
 *
 * WHAT IS AND IS NOT RE-BAKED. The FIELD is baked from the artwork alone and
 * lives in particleProxField.js; nothing here can invalidate it. What this file
 * produces is a pose — position, in-plane rotation, scale — which is three
 * numbers per source per step. That split is the feature: a source layer can be
 * keyframed, parented, put on a motion path or speed-ramped and the distance
 * field is still baked exactly once.
 *
 * THE FRAME, as in layerVelocity:
 *
 *     M_box(t) = M_particle(t)⁻¹ · M_source(t)
 *
 * so a particle layer that is itself animated — parented, scaled, riding a
 * camera move — keeps its effector where the source visually is, instead of
 * having the source fly through the box every time the box moves.
 */

import { resolveItemPrs, getParenting, PRS_BASE_FIELDS } from './keyframeParenting';
import { getItemKeyframeValues } from './gsapTransitions';
import { STEP_DT } from '../../sim/particles/solver';
import { prsToMatrix, mul34, invert34 } from '../../sim/particles/layerDrive';
import { PROX_POSE_STRIDE, PROX_PARAM_KEYS, PROX_PARAM_STRIDE, makeProxPose } from '../../sim/particles/proximity';
import { collidersOf } from '../../sim/particles/schema.js';
import {
  PARTICLE_MAX_PROX_SOURCES, PARTICLE_PROX_MOTION_KEYS,
  particleProxKfField, particleProxParamValue,
} from '../../sim/particles/schema.js';
import { ensureProxFields } from './particleProxField';
import { proxAnimatedParams, proxKfKey } from './particleProxKf';

const IDENTITY_34 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const tracks = new Map();

/*
 * ── THE SOLVER'S PARAMETER TABLE ────────────────────────────────────────────
 *
 * Alongside the pose track: one row per simulation step holding the effector's
 * own numbers — Range, Falloff, Depth and the eight motion amounts — as they
 * stand at that step. Un-keyed parameters repeat their stored value, so the
 * solver reads ONE table and never branches on whether a particular number
 * happens to be animated.
 *
 * Built only when the layer actually carries `px:` tracks. Without them the
 * table is null, the solver falls back to the static block, and a project that
 * has never animated an effector pays nothing — the same shape of gate as
 * `proxSolverInputFor`'s.
 *
 * WHAT IS NOT IN IT: the look amounts. They are read at draw time from the same
 * tracks (particleProxKf.js `proxCfgAt`), which is what keeps animating a Size
 * or a Colour out of the bake key — see the LOOK / SIM note in that file.
 */
const PROX_PARAM_META = PROX_PARAM_KEYS.map((key, slot) => ({
  key, slot, trackKey: proxKfKey(key), meta: particleProxKfField(key),
}));
// Which slots are FORCES rather than the field's shape — derived, not counted,
// so reordering PROX_PARAM_KEYS cannot quietly move the boundary.
const PROX_FORCE_SLOTS = PROX_PARAM_META
  .filter((p) => PARTICLE_PROX_MOTION_KEYS.includes(p.key))
  .map((p) => p.slot);
const clampParam = (v, meta) => (v < meta.min ? meta.min : v > meta.max ? meta.max : v);

/** Does this row reach the solver at all — is any force non-zero at this step? */
function rowDrivesMotion(data, o) {
  for (const slot of PROX_FORCE_SLOTS) if (data[o + slot]) return true;
  return false;
}

/** The proximity sources of a system, in table-row order. */
export function proxSourcesOf(system) {
  const P = system?.proximity;
  if (!P?.enabled) return [];
  return (P.sources || []).slice(0, PARTICLE_MAX_PROX_SOURCES);
}

/* Everything about an item that can move it, plus every ancestor — the signature
   a cached track is keyed on. Same shape as layerVelocity's, deliberately. */
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

/*
 * The source's pose in the box, from the composed 3x4.
 *
 * Column 0 is the image of the artwork's own +X axis, so its length is the
 * in-plane scale and its angle is the in-plane rotation — the two things a flat
 * distance field can actually use. Rotation out of the plane (rotateX/rotateY)
 * foreshortens the artwork, which a 2D SDF cannot express; the field keeps its
 * unforeshortened shape and only follows the in-plane part. Worth knowing before
 * someone tumbles a source and asks why the field did not squash.
 */
function poseFromMatrix(m) {
  const sx = Math.hypot(m[0], m[4]) || 1e-3;
  return { x: m[3], y: m[7], scale: sx, rotDeg: Math.atan2(m[4], m[0]) * 180 / Math.PI };
}

function makeCtx(W, H) {
  return { W, H, evalKeyframes: (it, progress) => getItemKeyframeValues(it, progress) };
}

/*
 * A source's LIVE pose at `t`, or null when its layer is gone. `pickScale` is
 * the layer's scale at the moment the source was picked, so `size` keeps meaning
 * "how wide the artwork looked when you chose it" and following tracks changes
 * from there rather than multiplying the base zoom in twice.
 */
function livePose(index, ctx, item, sx, t, boxInv, mS, mOut) {
  const prs = resolveItemPrs(index, sx.fromItemId, t, ctx);
  if (!prs) return null;
  prsToMatrix(mS, prs);
  mul34(mOut, boxInv, mS);
  const p = poseFromMatrix(mOut);
  const pick = Number(sx.pickScale) > 0 ? Number(sx.pickScale) : 1;
  return { x: p.x, y: p.y, size: sx.size * (p.scale / pick), rotDeg: p.rotDeg + (sx.rotation || 0) };
}

/*
 * IS A SOURCE LAYER ON THE TIMELINE AT `t`?
 *
 * A following source IS that layer, so when the layer is not there the effector
 * is not there either — no falloff, no drive, nothing. It does NOT fall back to
 * a stored pose: an effector that goes on shaping the cloud after its layer has
 * ended is a force nobody can see.
 *
 * The span has to be tested explicitly. `resolveItemPrs` resolves an item at any
 * time by clamping its progress to its own ends, which is right for reading a
 * transform and says nothing about whether the layer is on screen — so following
 * alone keeps a source alive for the whole clip.
 *
 * A source pinned to a manual pose (`follow: false`) is not tracking anything and
 * is always on: it borrowed the artwork and owns its own placement.
 */
function sourcePresent(index, sx, t) {
  if (!sx.follow || !sx.fromItemId) return true;
  const e = index?.get?.(sx.fromItemId);
  if (!e) return true;                       // gone entirely — the stored pose stands in
  /*
   * THE SPAN, AND NOT VISIBILITY.
   *
   * "On the timeline" is where the clip is, not whether it is drawn. Hiding the
   * donor layer is the normal way to build a dissolve — the artwork is a
   * snapshot, so the layer's job is done the moment it is picked and it is meant
   * to be switched off. Treating hidden as absent would have broken that recipe
   * and every effector built the same way.
   */
  const EPS = STEP_DT * 0.5;
  return t >= e.startTime - EPS && t <= e.endTime + EPS;
}

/** The span/visibility of every followed source, for a cache key. */
function sourceSpanSig(index, sources) {
  return sources.map((sx) => {
    if (!sx.follow || !sx.fromItemId) return '-';
    const e = index?.get?.(sx.fromItemId);
    return e ? `${e.startTime}:${e.endTime}` : 'gone';
  }).join(',');
}

function boxInverseAt(out, index, ctx, item, t, scratch) {
  const prs = resolveItemPrs(index, item.id, t, ctx);
  if (!prs) { out.set(IDENTITY_34); return out; }
  prsToMatrix(scratch, prs);
  if (!invert34(out, scratch)) out.set(IDENTITY_34);
  return out;
}

/**
 * Poses at ONE time, for the renderer. Returns [] when the effector is inert or
 * no source's artwork has finished baking — the caller then simply skips the
 * whole proximity pass, which is what makes a decoding image cost nothing.
 *
 *   time   COMPOSITION time (not clip-local); the caller already has it
 */
export function proxPosesAt({ system, item, index, layout, W, H, time }) {
  const sources = proxSourcesOf(system);
  if (!sources.length) return [];
  const tables = ensureProxFields(sources);
  if (!tables.some(Boolean)) return [];

  const ctx = makeCtx(W, H);
  const boxInv = new Float32Array(12);
  const mS = new Float32Array(12);
  const mOut = new Float32Array(12);
  const canFollow = !!index && !!item;
  if (canFollow) boxInverseAt(boxInv, index, ctx, item, time, mS);

  const out = [];
  for (let i = 0; i < sources.length; i++) {
    const t = tables[i];
    const sx = sources[i];
    if (!t || t.empty) { out.push(null); continue; }
    // A source that follows a layer which is gone falls back to its stored pose
    // rather than collapsing to the origin — the same rule the collider keeps.
    const live = sx.follow && canFollow && sx.fromItemId
      ? livePose(index, ctx, item, sx, time, boxInv, mS, mOut)
      : null;
    const p = live || { x: sx.position.x, y: sx.position.y, size: sx.size, rotDeg: sx.rotation || 0 };
    out.push(makeProxPose(t, p.x, p.y, p.size, p.rotDeg, sourcePresent(index, sx, time)));
  }
  return out;
}

/**
 * The per-simulation-step pose track, for the solver. Rows are positional and
 * match `sources` order, so a source whose layer is gone contributes its stored
 * pose rather than shifting every row after it.
 *
 * Returns null when nothing here reaches the solver, so a look-only effector
 * never appears in the bake key and never costs a re-simulation.
 */
export function proxTrackFor({ system, item, index, layout, W, H }) {
  const sources = proxSourcesOf(system);
  if (!sources.length || !item) return null;

  const preRoll = Math.max(0, system.solver?.preRoll || 0);
  const duration = Math.max(0.1, layout?.duration || 0);
  const start = layout?.startTime || 0;
  // Exactly the bake's step count (solver.js), so row s is step s and nothing
  // downstream has to interpolate or guess where the track ends.
  const n = Math.ceil((preRoll + duration) / STEP_DT) + 1;

  /*
   * The animated parameters, and the block they animate away from.
   *
   * Both go in the KEY. prsSignature already carries the item's whole
   * propertyKeyframes blob, but only when the item is IN the index — a source
   * pinned to a manual pose resolves without one, and a track edit would then be
   * invisible to the cache. Naming the px tracks explicitly makes the key true
   * in both cases.
   */
  const animated = proxAnimatedParams(item);
  const P = system.proximity;
  const keyedParams = PROX_PARAM_META.filter((p) => animated.has(p.key));

  const key = [
    'px2', n, preRoll.toFixed(4), duration.toFixed(4), start.toFixed(4),
    prsSignature(index, item.id),
    // The base values the un-keyed slots repeat; a static edit to Range must
    // rebuild the table even when nothing on this layer is animated.
    PROX_PARAM_META.map((p) => particleProxParamValue(P, p.key)).join(','),
    keyedParams.map((p) => `${p.key}=${JSON.stringify(item.propertyKeyframes?.[p.trackKey] || 0)}`).join(';'),
    item.propertyKeyframeFx ? JSON.stringify(item.propertyKeyframeFx) : '',
    ...sources.map((sx) => [
      sx.fromItemId || '', sx.follow ? 1 : 0, sx.size, sx.rotation,
      sx.position?.x, sx.position?.y, sx.pickScale || 1,
      sx.follow ? prsSignature(index, sx.fromItemId) : '',
    ].join('#')),
    // A source's SPAN and visibility decide when it acts at all, so trimming or
    // hiding that layer has to rebuild this track.
    sourceSpanSig(index, sources),
  ].join('|');

  const hit = tracks.get(key);
  if (hit !== undefined) return hit;

  const ctx = makeCtx(W, H);
  const count = sources.length;
  const data = new Float32Array(n * count * PROX_POSE_STRIDE);
  // Presence on the TIMELINE, per source per step — see sourcePresent.
  const on = new Uint8Array(n * count);
  // Null unless something is animated: the solver then reads the static block
  // and this whole table costs nothing to a project that never keyed one.
  const pdata = keyedParams.length ? new Float32Array(n * PROX_PARAM_STRIDE) : null;
  // The base row, written once and copied into every step before the animated
  // slots overwrite theirs.
  const baseRow = pdata ? PROX_PARAM_META.map((p) => particleProxParamValue(P, p.key)) : null;
  let pmotion = false;
  const boxInv = new Float32Array(12);
  const mS = new Float32Array(12);
  const mOut = new Float32Array(12);
  const canFollow = !!index;

  for (let s = 0; s < n; s++) {
    // Clip-local time, the solver's own definition. Pre-roll holds the source at
    // its first frame: it has not started animating yet on screen, so a system
    // that pre-rolls settles into a still field instead of being shaped by
    // motion the viewer never sees.
    const tc = s * STEP_DT - preRoll;
    const t = start + Math.max(0, tc);
    if (canFollow && item) boxInverseAt(boxInv, index, ctx, item, t, mS);
    for (let k = 0; k < count; k++) {
      const sx = sources[k];
      const live = sx.follow && canFollow && sx.fromItemId
        ? livePose(index, ctx, item, sx, t, boxInv, mS, mOut)
        : null;
      const p = live || { x: sx.position.x, y: sx.position.y, size: sx.size, rotDeg: sx.rotation || 0 };
      const o = (s * count + k) * PROX_POSE_STRIDE;
      data[o] = p.x; data[o + 1] = p.y; data[o + 2] = p.size; data[o + 3] = p.rotDeg;
      on[s * count + k] = sourcePresent(index, sx, t) ? 1 : 0;
    }
    if (pdata) {
      // The layer's OWN progress at this step — clip-local, pre-roll clamped to
      // the first frame, which is the same definition the poses above use and
      // the same one the renderer reads per frame. Two definitions here would
      // show up as the preview and the bake disagreeing by a few frames.
      const prog = Math.min(1, Math.max(0, tc) / duration);
      const kf = getItemKeyframeValues(item, prog);
      const o = s * PROX_PARAM_STRIDE;
      for (let k = 0; k < PROX_PARAM_STRIDE; k++) pdata[o + k] = baseRow[k];
      for (const p of keyedParams) {
        const v = Number(kf?.[p.trackKey]);
        if (Number.isFinite(v)) pdata[o + p.slot] = clampParam(v, p.meta);
      }
      if (!pmotion && rowDrivesMotion(pdata, o)) pmotion = true;
    }
  }

  const track = { key, hz: Math.round(1 / STEP_DT), n, count, data, on, pdata, pmotion };
  if (tracks.size > 6) tracks.clear();
  tracks.set(key, track);
  return track;
}

/**
 * Everything the SOLVER needs, as one value: the pose track and the field each
 * pose samples. Null when nothing is ready or nothing drives motion.
 *
 * THE TABLES ARE PART OF THE KEY, and that is not tidiness.
 *
 * An image or a video poster takes a frame or two to decode, so the first bake
 * of a freshly-picked source would run with no field at all. Keyed on the track
 * alone that bake looks valid for ever: the poses have not changed, the hash has
 * not changed, and the effector silently never fires — visible as "it works
 * after I nudge something, not when I pick the layer". Folding readiness into
 * the key makes the arrival of a field a new simulation, which is exactly what
 * it is.
 */
export function proxSolverInputFor(args) {
  const track = proxTrackFor(args);
  if (!track) return null;
  const tables = ensureProxFields(proxSourcesOf(args.system));
  if (!tables.some((t) => t && !t.empty)) return null;
  const ready = tables.map((t) => (t && !t.empty ? '1' : '0')).join('');
  return { track: { ...track, key: `${track.key}|f${ready}` }, tables };
}

/** Identity key — what the simulation hash reads so a moved source re-bakes. */
export const proxTrackKey = (track) => (track ? track.key : '');

/** Drop every cached track — for a project switch or a teardown. */
export function clearProxTracks() {
  tracks.clear();
}

/* ══════════════════════════════════════════════════════════════════════════
   THE COLLIDER'S POSE TRACK

   A followed collider is the same problem a proximity source is: another
   layer's live transform, sampled per simulation step, handed to a solver that
   has no timeline. It lives here rather than in its own module so it uses the
   same `livePose` / `boxInverseAt` — one implementation of "where is that layer
   in this system's box", not two that can drift apart.

   The difference is what it feeds. A proximity source drives a falloff; a
   collider is a hard constraint, so its field is baked in the ARTWORK's local
   space (ensureProxField, the same bake) and the solver samples it through the
   inverse of these poses. A box-space field would be invalidated by every frame
   of motion, which is exactly why a collider could not follow anything before.
   ══════════════════════════════════════════════════════════════════════════ */

const colliderTracks = new Map();
const emitterGates = new Map();

/**
 * Every collider's source in the shape `livePose` expects, positional in
 * `collidersOf` order.
 *
 * A collider that does not follow still occupies a ROW — null rather than
 * absent — so a track row and a collider stay the same index. Dropping the
 * non-followers would shift every row after them the moment one was switched
 * off, which is the bug proximity's positional rows exist to avoid.
 */
function colliderSources(system) {
  return collidersOf(system).map((C) => (
    C.follow && C.fromItemId
      ? {
        fromItemId: C.fromItemId,
        follow: true,
        size: C.size,
        rotation: C.rotation || 0,
        position: C.position || { x: 0, y: 0 },
        pickScale: Number(C.pickScale) > 0 ? Number(C.pickScale) : 1,
      }
      : null
  ));
}

/**
 * Per-step poses for a FOLLOWED collider: `{ n, data }`, four floats a step
 * (x, y, size, rotDeg) — the same layout PROX_POSE_STRIDE describes, so
 * `makeProxPose` builds from it unchanged.
 *
 * Null when the collider does not follow, so an ordinary collider costs one
 * property read and nothing else.
 */
export function colliderTracksFor({ system, item, index, layout, W, H }) {
  const sources = colliderSources(system);
  if (!sources.length || !item) return [];
  return sources.map((sx, i) => (sx ? oneColliderTrack(sx, i, { system, item, index, layout, W, H }) : null));
}

/** Backwards-compatible single-collider entry point. */
export function colliderTrackFor(args) {
  return colliderTracksFor(args)[0] || null;
}

function oneColliderTrack(sx, slot, { system, item, index, layout, W, H }) {
  const preRoll = Math.max(0, system.solver?.preRoll || 0);
  const duration = Math.max(0.1, layout?.duration || 0);
  const start = layout?.startTime || 0;
  // Exactly the bake's step count (solver.js), so row s is step s.
  const n = Math.ceil((preRoll + duration) / STEP_DT) + 1;

  const key = [
    'coll2', slot, n, preRoll.toFixed(4), duration.toFixed(4), start.toFixed(4),
    prsSignature(index, item.id),
    sx.fromItemId, sx.size, sx.rotation, sx.position.x, sx.position.y, sx.pickScale,
    prsSignature(index, sx.fromItemId),
    // The source's SPAN decides when the collider exists at all, so trimming
    // that layer has to rebuild this track.
    (() => { const e = index?.get?.(sx.fromItemId); return e ? `${e.startTime}:${e.endTime}` : 'gone'; })(),
  ].join('|');

  const hit = colliderTracks.get(key);
  if (hit !== undefined) return hit;

  const ctx = makeCtx(W, H);
  const data = new Float32Array(n * PROX_POSE_STRIDE);
  const on = new Uint8Array(n);
  const boxInv = new Float32Array(12);
  const mS = new Float32Array(12);
  const mOut = new Float32Array(12);
  const canFollow = !!index;
  const srcEntry = canFollow ? index.get(sx.fromItemId) : null;
  let moves = false;
  let x0 = 0, y0 = 0, s0 = 0, r0 = 0, on0 = 0;

  for (let s = 0; s < n; s++) {
    // Clip-local time, the solver's own definition. Pre-roll holds the source at
    // its first frame — it has not started animating on screen yet.
    const tc = s * STEP_DT - preRoll;
    const t = start + Math.max(0, tc);
    if (canFollow) boxInverseAt(boxInv, index, ctx, item, t, mS);
    const live = canFollow ? livePose(index, ctx, item, sx, t, boxInv, mS, mOut) : null;
    // The SPAN, not visibility — see sourcePresent for why hiding a donor layer
    // must not switch its collider off. Half a frame of slack at each end so a
    // collider does not flicker off for one step on a boundary.
    const EPS = STEP_DT * 0.5;
    const present = !!live && !!srcEntry
      && t >= srcEntry.startTime - EPS && t <= srcEntry.endTime + EPS;
    // The stored pose is still the fallback for a source that is GONE rather
    // than merely not here yet; `on` is what decides whether it collides at all.
    const p = live || { x: sx.position.x, y: sx.position.y, size: sx.size, rotDeg: sx.rotation };
    const o = s * PROX_POSE_STRIDE;
    data[o] = p.x; data[o + 1] = p.y; data[o + 2] = p.size; data[o + 3] = p.rotDeg;
    on[s] = present ? 1 : 0;
    if (s === 0) { x0 = p.x; y0 = p.y; s0 = p.size; r0 = p.rotDeg; on0 = on[s]; }
    else if (!moves
      && (Math.abs(p.x - x0) > 0.01 || Math.abs(p.y - y0) > 0.01
        || Math.abs(p.size - s0) > 0.01 || Math.abs(p.rotDeg - r0) > 0.01
        // Coming or going counts as moving: the pose has to be re-read.
        || on[s] !== on0)) moves = true;
  }

  const track = { n, count: 1, data, on, key, moves };
  if (colliderTracks.size > 24) colliderTracks.clear();
  colliderTracks.set(key, track);
  return track;
}

export function clearColliderTracks() { colliderTracks.clear(); }


/**
 * When may a LAYER EMITTER emit? One byte per simulation step.
 *
 * Same rule the collider and the effectors keep — the source layer's own span on
 * the timeline — and the same reasoning for why it is the span and not the
 * visibility. Null unless the emitter asked for it (`followTimeline`), so an
 * ordinary emitter costs one property read.
 */
export function emitterGateFor({ system, item, index, layout }) {
  const em = system?.emitters?.[0];
  if (!em?.followTimeline || !em.fromItemId || !item || !index) return null;
  const e = index.get(em.fromItemId);
  if (!e) return null;                       // the layer is gone; emit as before

  const preRoll = Math.max(0, system.solver?.preRoll || 0);
  const duration = Math.max(0.1, layout?.duration || 0);
  const start = layout?.startTime || 0;
  const n = Math.ceil((preRoll + duration) / STEP_DT) + 1;
  const key = `emg1|${n}|${preRoll.toFixed(4)}|${duration.toFixed(4)}|${start.toFixed(4)}`
    + `|${em.fromItemId}|${e.startTime}|${e.endTime}`;

  const hit = emitterGates.get(key);
  if (hit !== undefined) return hit;

  const on = new Uint8Array(n);
  const EPS = STEP_DT * 0.5;
  for (let s = 0; s < n; s++) {
    const t = start + Math.max(0, s * STEP_DT - preRoll);
    on[s] = (t >= e.startTime - EPS && t <= e.endTime + EPS) ? 1 : 0;
  }
  const gate = { n, on, key };
  if (emitterGates.size > 24) emitterGates.clear();
  emitterGates.set(key, gate);
  return gate;
}

export function clearEmitterGates() { emitterGates.clear(); }
