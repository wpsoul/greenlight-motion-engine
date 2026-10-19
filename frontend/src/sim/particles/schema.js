// Particle system schema: defaults, bounded sanitizer, and the simulation hash.
//
// A leaf module — no React, no three.js, no editor imports — because the sanitizer
// in VideoEditor, the inspector in EditorPanel, the solver and the renderer all
// need these and those modules already import each other.
//
// The stored config is MATERIALISED, never a live reference to a preset: applying
// "Fire" writes a complete system onto the item, so changing preset defaults in a
// later app version can never change a saved project. `preset` is metadata.

/**
 * 1 → 2 adds force PATTERNS and Particle Activation. The bump exists for one
 * reason: pattern 'billow' is the default a new solver gets, and a project saved
 * at version 1 has no pattern field — defaulting it the same way would silently
 * restyle every existing turbulence. Version 1 systems therefore keep 'smooth',
 * which is the field they were authored against.
 */
/**
 * 2 → 3 adds the FLUID force field (Particular-style grid physics: fluid and
 * smoke models, draft, force emitters), the ring / path / block emitter shapes,
 * path-follow and collision. Every new block defaults to OFF
 * (`fluid.model: 'off'`, no force emitters, `pathFollow.enabled: false`, no
 * collider), so a version-2 system sanitised at version 3 is
 * the same simulation it was — nothing here needs the legacy branch below.
 */
/**
 * 3 → 4 adds PROXIMITY EFFECTORS: another layer's SHAPE driving this system's
 * look and motion. Every field defaults to inert (`proximity.enabled: false`,
 * no sources, empty `fx`), so a version-3 system sanitised at version 4 is the
 * same simulation and the same picture it was — nothing here needs a legacy
 * branch. The bump exists so a project written by this version is not silently
 * re-read as a version-3 one by an older build that would drop the block.
 */
export const PARTICLE_SCHEMA_VERSION = 4;

// ── Timeline identity ───────────────────────────────────────────────────────
// Like RIG_MEDIA_TYPE, a particle clip DRAWS, so it is not a synthetic type that
// the compositor can skip — it owns a real spatial pass.
export const PARTICLE_MEDIA_TYPE = 'particles';
export const isParticleClip = (clip) => clip?.mediaType === PARTICLE_MEDIA_TYPE;

// Hard caps. Raising these is a measured decision, not a convenience.
// Set against what the CACHE costs, not what the GPU can draw: a snapshot is 24
// bytes per particle and there are 30 of them a second, so a 6 s solver at the
// cap holds ~420 MB and takes ~13 s to simulate. Drawing it is nothing (0.3 ms
// a frame to sample). Two things make that ceiling usable rather than a trap:
// the per-UID constants that keep a snapshot to five floats (solver.js), and the
// first bake of a big system going to the worker instead of freezing the editor
// (client.js). It is a ceiling for ONE heavy system, not a size to build a whole
// project out of.
export const PARTICLE_MAX_PARTICLES = 100000;

/*
 * TIER 2 CAPS (see PLANS/VIDEO_EDITOR_PARTICLE_GPU_SCALE_PLAN.md).
 *
 * PARTICLE_MAX_PARTICLES above keeps its value and its meaning, so a saved
 * project sanitises exactly as it always has. These are additional ceilings the
 * PANEL applies, not the sanitiser — the sanitiser cannot see which runtime a
 * layer will get, and a project authored on a WebGPU machine must not have its
 * particle count quietly clamped when it opens somewhere without one.
 *
 * The three numbers are measured, not chosen. On an Apple M-series at 1920x1080,
 * through the full chain (reap, emit, integrate, derive, indirect draw):
 *
 *   1,000,000   6.1 ms/frame   comfortably 60 fps
 *   4,000,000  17.2 ms/frame   ~58 fps, just over the line
 *   8,000,000  34.1 ms/frame   ~29 fps — export and offline only
 *
 * so SMOOTH is what the editor should offer by default, MAX is what a user may
 * opt into knowing the preview will not hold 60, and the panel must say which is
 * which rather than presenting eight million as though it were free.
 */
/*
 * WHERE THE GPU ENGINE TAKES OVER. A ROUTING THRESHOLD, NEVER A CAP.
 *
 * Below this a system stays on the bake, which is the better answer when it
 * fits: cached, scrubs backwards for free, bit-reproducible everywhere. Above
 * it the GPU engine is worth its cost.
 *
 * It must never CLAMP anything. The bake has always allowed
 * PARTICLE_MAX_PARTICLES (100,000) and still does; a machine that cannot run the
 * GPU engine keeps all of it. Treating this number as a limit is how a feature
 * meant to raise a ceiling ended up lowering it — it appeared as a cap in the
 * panel, in the fluid gate and in the no-WebGPU fallback, and every one of those
 * took something away from someone it could not help.
 */
export const PARTICLE_GPU_THRESHOLD = 50000;
/** @deprecated the old name, kept so nothing breaks mid-refactor. */
export const PARTICLE_MAX_CPU = PARTICLE_GPU_THRESHOLD;
export const PARTICLE_SMOOTH_GPU = 1000000;    // Tier 2: holds 60 fps with room to spare
export const PARTICLE_MAX_GPU = 8000000;       // Tier 2: the hard ceiling
export const PARTICLE_MAX_EMITTERS = 8;
export const PARTICLE_MAX_RAMP_STOPS = 16;
export const PARTICLE_MAX_OBJECTS = 12;

export const PARTICLE_CLIP_DURATION_SECONDS = 6;

/** Which side of a collider may be opened. 'none' is closed, and the default. */
export const PARTICLE_COLLISION_OPEN_SIDES = ['none', 'top', 'bottom', 'left', 'right'];

export const PARTICLE_SPRITES = ['soft-disc', 'star', 'spark'];
export const PARTICLE_BLENDS = ['alpha', 'additive'];
// 'ring' / 'path' / 'block' are the v3 additions: an annulus in the comp plane,
// a drawn spline (anchors in the emitter's unit space), and a filled slab.
//
// 'rows' is READY-MADE LINES: a grid of tracer particles — `rows.count` rows of
// `rows.points` each — placed once, all at the emitter's start, at rest. They
// never die of age and never stir the fluid, so the only thing that moves them
// is the forces; drawn with `render.mode: 'lines'` (connect 'rows') every row is
// whole from the first frame and the medium bends it. The pool IS the grid:
// `solver.maxParticles` is forced to count × points by the sanitiser.
export const PARTICLE_EMITTER_SHAPES = ['point', 'box', 'sphere', 'cone', 'layer', 'ring', 'path', 'block', 'rows'];
/** A rows grid is a baked pool, so it stays inside the bake's comfortable size. */
export const PARTICLE_ROWS_MAX_COUNT = 400;
export const PARTICLE_ROWS_MAX_POINTS = 1000;
/** Rows × points never exceeds this — the CPU tier's ceiling. */
export const PARTICLE_ROWS_MAX_TOTAL = 50000;
/** How many tracers a rows emitter places (0 for any other shape). */
export function particleRowsTotal(em) {
  if (!em || em.shape !== 'rows' || !em.rows) return 0;
  return Math.max(1, em.rows.count | 0) * Math.max(2, em.rows.points | 0);
}

/*
 * HOW A PARTICLE IS DRAWN. 'lines' joins particles into ribbons instead of
 * stamping each one:
 *   connect 'time' — one particle's own path (a trail), read from the bake;
 *   connect 'rows' — neighbours in a rows emitter's grid, at this instant.
 * Render-only like the rest of the look: none of it re-simulates.
 */
export const PARTICLE_RENDER_MODES = ['sprite', 'layers', 'lines'];
export const PARTICLE_LINE_CONNECTS = ['time', 'rows'];
export const PARTICLE_LINE_SHAPES = ['trail', 'full'];
export const PARTICLE_LINE_ENDS = ['cut', 'retract', 'stay'];
export const PARTICLE_LINE_PROFILES = ['linear', 'smooth', 'swell'];
export const PARTICLE_LINE_COLOR_MODES = ['particle', 'along', 'moved'];
export const PARTICLE_LINE_SMOOTHING = [1, 2, 4, 8];
// Launch direction for ring and path: the cone (direction + spread), or relative
// to the shape — outward / normal to it, or along its tangent.
export const PARTICLE_EMIT_DIR_MODES = ['cone', 'outward', 'tangent'];
/*
 * EMISSION DISTRIBUTION — how spawn sites are SPREAD inside whichever shape is
 * chosen. Orthogonal to the shape: the sampler produces a point in the unit
 * cube and every existing shape map is unchanged (see distribution.js).
 *
 * 'random' is what the emitter has always done and stays the default — the
 * sampler returns those exact rnd(seed, uid, 1..3) values, so it is
 * byte-identical and NO SAVED PROJECT MOVES. That is also why this needed no
 * schema version bump: a system with no `distribution` block sanitises to
 * 'random', which is the simulation it was authored against.
 */
export const PARTICLE_DISTRIBUTIONS = [
  'random', 'stratified', 'grid', 'packed', 'relaxed', 'lowdisc',
  'sunflower', 'rings', 'clustered', 'falloff', 'shell',
];
// The order a set-based mode walks its own sites in. 'scan' is reading order,
// which fills the emitter ONE CORNER AT A TIME on anything that emits over
// time; 'scramble' is bit-reversal and 'shuffle' a hash, both of which reach
// the whole shape immediately. See distribution.js's orderedIndex.
export const PARTICLE_FILL_ORDERS = ['scan', 'scramble', 'shuffle'];
export const PARTICLE_DIST_SEQUENCES = ['r2', 'halton'];
// The fluid force field. 'fluid' is velocity only; 'smoke' adds a density/heat
// pair riding the same field (buoyancy, weight, cooling, dissipation).
export const PARTICLE_FLUID_MODELS = ['off', 'fluid', 'smoke'];
// Grid resolution. Cells are ~10 px at 'volume-hd' on every axis; 'flat-hd'
// spends the same cell budget in-plane for thin-column looks.
export const PARTICLE_FLUID_FIDELITIES = ['low', 'medium', 'high', 'ultra', 'flat-hd', 'volume-hd'];
export const PARTICLE_FLUID_BOUNDS = ['closed', 'open'];
// Who rides the flow: every particle in the box (the field is the whole medium),
// or only those near a force emitter — the source as a LOCAL force, the way a
// Houdini source drives what is close to it and leaves the rest alone.
export const PARTICLE_FLUID_REACHES = ['box', 'sources'];
export const PARTICLE_FORCE_EMITTER_MOTIONS = ['hold', 'orbit', 'sweep'];
// A force emitter is a JET (pushes along a direction) or a VORTEX (a rigid-core
// rotation about its position, in the comp plane). Both stir the fluid when
// the field is on; a vortex also acts on the particles directly when it is off.
// 'jet' is a Blower (momentum), 'vortex' a whirlpool, 'smoke' a SOURCE: it
// injects material (density + heat) into the field at its point, so smoke can
// come from a place you choose instead of from the particle emitter.
// Force emitters. 'layer' is the odd one out: its push is another timeline
// layer's own animation, sampled per step by the caller (see layerDrive.js).
export const PARTICLE_FORCE_EMITTER_KINDS = ['jet', 'vortex', 'smoke', 'burst', 'layer'];
export const PARTICLE_FORCE_EMITTER_SPINS = ['ccw', 'cw'];
export const PARTICLE_MAX_FORCE_EMITTERS = 3;

/* ── PROXIMITY EFFECTORS (v4) ───────────────────────────────────────────────
 *
 * The grid's Proximity effector (gridLayout.js) measures a cell's distance to a
 * POINT — the referenced layer's centre. This measures a particle's distance to
 * the layer's SILHOUETTE, so a word, a logo or a moving shape drives the cloud
 * along its own outline instead of as a circle around its middle.
 *
 * The vocabulary is deliberately the grid's — Range, Falloff, Shape, Combine,
 * Invert — because it is the same feature in a second place, and a user who has
 * tuned one should not have to learn the other.
 *
 * Look-dev: html/particle-proximity-lab.html.
 */
// Which distance the falloff curve is fed.
//   shape  — to the silhouette, outside only (solid inside). The default.
//   edge   — |signed distance|: a band that peaks ON the contour, both sides.
//   inside — measured INWARD from the contour; invert it for the core only.
//   centre — radial distance to the source's origin: the grid's behaviour,
//            kept so the two can be compared without rebuilding the setup.
export const PARTICLE_PROX_MEASURES = ['shape', 'edge', 'inside', 'centre', 'x', 'y'];
export const PARTICLE_PROX_SHAPES = ['smooth', 'linear', 'sharp'];
export const PARTICLE_PROX_COMBINES = ['max', 'add', 'average', 'min'];
export const PARTICLE_PROX_COLOR_MODES = ['solid', 'ramp'];
// Four is the force-emitter order of magnitude, and each source costs one SDF
// sample per particle per step — the cheapest thing in the loop, but not free.
export const PARTICLE_MAX_PROX_SOURCES = 4;

/*
 * WHAT PROXIMITY CAN DRIVE. `kind` is the whole reason this table exists:
 *
 *   look   — read at DRAW time. Free to change, and it never invalidates the
 *            bake, exactly like `objects` and `render.onKill` today.
 *   motion — a force or an integration change, so it is part of the simulation
 *            and editing it re-bakes.
 *
 * The panel prints that badge on every row, because "why did my system just
 * re-simulate" is the question this feature would otherwise generate all day.
 * `core` rows are always shown; the rest arrive through "Add property".
 */
export const PARTICLE_PROX_TARGETS = Object.freeze([
  { key: 'size', label: 'Size', kind: 'look', unit: ' %', min: -100, max: 400, step: 1, def: 140, core: true },
  { key: 'opacity', label: 'Opacity', kind: 'look', unit: ' %', min: -100, max: 100, step: 1, def: 70, core: true },
  { key: 'color', label: 'Colour', kind: 'look', unit: ' %', min: 0, max: 100, step: 1, def: 100, core: true },
  { key: 'spin', label: 'Rotation', kind: 'look', unit: '°', min: -1440, max: 1440, step: 5, def: 180 },
  { key: 'bright', label: 'Brightness', kind: 'look', unit: ' %', min: -100, max: 400, step: 1, def: 180 },
  { key: 'stretch', label: 'Stretch', kind: 'look', unit: ' %', min: -100, max: 400, step: 1, def: 200 },
  { key: 'twinkle', label: 'Twinkle', kind: 'look', unit: ' %', min: -100, max: 100, step: 1, def: 90 },

  { key: 'attract', label: 'Attract / Repel', kind: 'motion', unit: ' px/s²', min: -6000, max: 6000, step: 50, def: -2200, core: true },
  { key: 'flow', label: 'Surface flow', kind: 'motion', unit: ' px/s²', min: -6000, max: 6000, step: 50, def: 1600 },
  { key: 'orbit', label: 'Orbit centre', kind: 'motion', unit: ' px/s²', min: -6000, max: 6000, step: 50, def: 1400 },
  { key: 'drag', label: 'Drag +', kind: 'motion', unit: '', min: 0, max: 24, step: 0.25, def: 7 },
  { key: 'speed', label: 'Speed ×', kind: 'motion', unit: ' %', min: -100, max: 400, step: 1, def: -85 },
  { key: 'turb', label: 'Turbulence ×', kind: 'motion', unit: ' %', min: -100, max: 400, step: 1, def: 250 },
  { key: 'freeze', label: 'Freeze on shape', kind: 'motion', unit: ' %', min: 0, max: 100, step: 1, def: 100 },
  { key: 'life', label: 'Lifetime ×', kind: 'motion', unit: ' %', min: -100, max: 400, step: 1, def: -75 },
]);
const PROX_TARGET_BY_KEY = new Map(PARTICLE_PROX_TARGETS.map((t) => [t.key, t]));
export const particleProxTarget = (key) => PROX_TARGET_BY_KEY.get(key) || null;
/** Keys the SOLVER reads — the set that makes an edit re-bake. */
export const PARTICLE_PROX_MOTION_KEYS = Object.freeze(
  PARTICLE_PROX_TARGETS.filter((t) => t.kind === 'motion').map((t) => t.key),
);

/*
 * WHAT PROXIMITY CAN ANIMATE — the `px:<param>` keyframe tracks.
 *
 * The effector's own numbers are ordinary scalars, so they inherit the whole
 * keyframe machinery unchanged: the stopwatch in the panel, the Keyframes list,
 * the graph editor, custom easing, HOLD and the ƒx expressions. A Range that
 * opens over a shot, an Attract that lets go at the beat, a Size that swells and
 * settles — none of that needed a new animation system, only a track key.
 *
 * WHAT IS NOT HERE, and why:
 *   measure / shape / combine / invert — enums and a flag. There is no halfway
 *     between Smooth and Sharp, and a track that steps between two of them is a
 *     cut, which the timeline already does better.
 *   colorMode / color / colorRamp — the colour is a RAMP KEYED ON DISTANCE. It
 *     is already a function of the field; making it a function of time as well
 *     is two curves fighting over one output.
 *   sources — a source's pose is not stored animation, it is READ off the layer
 *     every frame (Transform ▸ Follow). Keyframe the source layer instead; that
 *     is the whole design.
 *
 * `where` says which half of the block the value lives in: 'field' is a
 * top-level number, 'fx' an entry in the driven-property map (and therefore only
 * animatable once that property has been added). `kind` carries the LOOK / SIM
 * split through to the panel and the builder, so a row can say whether animating
 * it re-simulates.
 */
const PARTICLE_PROX_KF_FIELD_PARAMS = Object.freeze([
  { key: 'range', label: 'Range', unit: ' px', min: 0, max: 100000, step: 5 },
  { key: 'falloff', label: 'Falloff', unit: ' px', min: 1, max: 100000, step: 10 },
  { key: 'depth', label: 'Depth', unit: ' px', min: 0, max: 100000, step: 10 },
]);
export const PARTICLE_PROX_KF_FIELDS = Object.freeze([
  // The field's own shape. Read by BOTH halves — the draw-time influence and the
  // solver's forces — so animating one costs a re-bake only when something in
  // `fx` drives motion, exactly like editing it statically does today.
  ...PARTICLE_PROX_KF_FIELD_PARAMS.map((f) => Object.freeze({ ...f, where: 'field', kind: 'field' })),
  // Every driven amount, look and motion alike.
  ...PARTICLE_PROX_TARGETS.map((t) => Object.freeze({
    key: t.key, label: t.label, unit: t.unit, min: t.min, max: t.max, step: t.step,
    where: 'fx', kind: t.kind, def: t.def,
  })),
]);
const PROX_KF_FIELD_BY_KEY = new Map(PARTICLE_PROX_KF_FIELDS.map((f) => [f.key, f]));
export const particleProxKfField = (key) => PROX_KF_FIELD_BY_KEY.get(key) || null;

/**
 * The value a `px:` track starts from — what the block holds for `key` today, so
 * arming a stopwatch never changes the frame.
 */
export function particleProxParamValue(prox, key) {
  const f = PROX_KF_FIELD_BY_KEY.get(key);
  if (!f || !prox) return 0;
  const v = f.where === 'fx' ? prox.fx?.[key] : prox[key];
  return Number.isFinite(v) ? v : (f.def ?? 0);
}

/**
 * Which parameters this block can actually offer a track for. The field trio is
 * always animatable once a source exists; an `fx` amount only once that property
 * has been added, because a track on a property nothing drives does nothing and
 * an inert stopwatch is worse than no stopwatch (the Grid panel's rule).
 */
export function particleProxKfFieldsFor(prox) {
  if (!prox?.sources?.length) return [];
  return PARTICLE_PROX_KF_FIELDS.filter((f) => f.where === 'field' || prox.fx?.[f.key] !== undefined);
}
export const PARTICLE_MAX_PATH_ANCHORS = 64;
// Collision faces: 'outer' = the shape is an obstacle, 'inner' = it is a container.
export const PARTICLE_COLLISION_FACES = ['outer', 'inner'];
export const PARTICLE_BOUNDS_BEHAVIORS = ['kill', 'wrap', 'bounce'];
// How the editor previews the solver: live on WebGPU when it holds 60 fps
// (auto), always live, or always the bake. Not a simulation input.
export const PARTICLE_PREVIEW_ENGINES = ['auto', 'live', 'baked'];
/**
 * How much bigger or smaller than 1920×1080 a composition is, by AREA — the
 * factor radii and sizes scale by. Scaling them by the width alone made a
 * portrait comp (1024×1280) get half-size stir radii while its frame is nearly
 * as tall as 1080p: the splats deposit ∝ radius², so its smoke came out a
 * quarter as dense and read as "almost invisible".
 */
export const compScale = (w, h) => Math.sqrt((Math.max(1, w) * Math.max(1, h)) / (1920 * 1080));
export const PARTICLE_OBJECT_PICKS = ['cycle', 'random'];
// 'video' is the one object kind that is NOT self-contained: with Play video on
// it is a live texture, so every particle shows the same current frame. That is a
// deliberate exception to the snapshot rule, and it is opt-in per system (see
// objects.playVideo) — off, a video member is one still frame like any other.
export const PARTICLE_OBJECT_KINDS = ['image', 'shape', 'text', 'video'];
// A shape outline is stored as unit points; cap it so a hand-drawn path with
// thousands of anchors cannot bloat every save of the project.
export const PARTICLE_MAX_OUTLINE_POINTS = 256;
export const PARTICLE_OBJECT_FACINGS = ['billboard', 'tumble', 'velocity'];
/**
 * What a particle collides AS when Packing is on. 'circle' is the fast default
 * and the only choice for sprites. 'object' is for layer objects: each particle
 * collides as its artwork's outline and turns when it is hit (packing.js, shape
 * mode) — exact, and a good deal slower, so it is for tens to a few hundred
 * objects rather than thousands.
 */
export const PARTICLE_PACKING_SHAPES = ['circle', 'object'];
/**
 * Where a particle's RGB comes from. Alpha is always the colour-over-life ramp —
 * it is the life envelope, and a particle that cannot fade out at the end of its
 * life pops however it was coloured.
 *   age       the ramp, read at how far through its life the particle is
 *   source    the pixel it was emitted from (layer emitters only)
 *   velocity  a second gradient, read at how fast it is going
 */
export const PARTICLE_COLOR_MODES = ['age', 'source', 'velocity'];
// With a VIDEO source: 'live' re-reads the frame playing now (the cloud is the
// moving picture), 'birth' keeps the colour each particle was emitted with.
export const PARTICLE_COLOR_SOURCE_TIMES = ['live', 'birth'];
// Kept for the v1 field it migrates from.
export const PARTICLE_COLOR_SOURCES = ['ramp', 'source'];
// How the emitter runs. 'static' fills the system once and never emits again —
// one cloud, born together; 'continuous' keeps the rate and bursts running.
export const PARTICLE_EMIT_MODES = ['continuous', 'static'];
// What the front does to a particle it has just released.
export const PARTICLE_IGNITE_MODES = ['flash', 'solid', 'gradient'];

// Particle Activation. 'immediate' is the shipped behaviour — every particle
// emits on schedule. 'grow' hands the emission sites to Grow Fill's arrival bake
// so a front sweeps through the artwork and switches them on as it passes.
export const PARTICLE_ACTIVATIONS = ['immediate', 'grow'];
// What an un-activated particle is: not there at all, or standing on its own
// pixel until the front releases it (so the layer reads as the artwork first).
export const PARTICLE_INACTIVE_MODES = ['hidden', 'frozen'];
export const PARTICLE_GROW_FROMS = ['left', 'right', 'top', 'bottom', 'center', 'scatter'];
export const PARTICLE_GROW_SPEED_MAPS = ['uniform', 'turbulent'];
export const PARTICLE_MAX_GROW_POINTS = 8;

import {
  PARTICLE_TURBULENCE_PATTERNS, PARTICLE_FIELD_MODES, PARTICLE_FIELD_AXES,
} from './fields.js';

export { PARTICLE_TURBULENCE_PATTERNS, PARTICLE_FIELD_MODES, PARTICLE_FIELD_AXES };

const num = (v, fallback, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n < min ? min : n > max ? max : n;
};
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const vec3 = (raw, fx, fy, fz, min, max) => {
  const v = raw && typeof raw === 'object' ? raw : {};
  return { x: num(v.x, fx, min, max), y: num(v.y, fy, min, max), z: num(v.z, fz, min, max) };
};
const HEX8 = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const RGBA = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;
const hh = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/**
 * Ramp stops are stored as #rrggbbaa so the renderer's parse is one shape. The
 * shared ColorPicker emits `rgba(r, g, b, a)` once a colour has alpha, so accept
 * that too and normalise — otherwise picking a transparent stop silently reverts.
 */
export function normalizeParticleColor(v, fallback = '#ffffffff') {
  if (typeof v !== 'string') return fallback;
  const trimmed = v.trim();
  if (HEX8.test(trimmed)) return trimmed.length === 7 ? `${trimmed}ff` : trimmed.toLowerCase();
  const m = RGBA.exec(trimmed);
  if (!m) return fallback;
  const a = m[4] === undefined ? 1 : Number(m[4]);
  return `#${hh(Number(m[1]))}${hh(Number(m[2]))}${hh(Number(m[3]))}${hh((Number.isFinite(a) ? a : 1) * 255)}`;
}

const color = (v, fallback) => normalizeParticleColor(v, fallback);

/**
 * The Dust system, sized to a composition. Every preset in presets.js starts here
 * and overrides, so a new field only has to be defaulted once.
 */
export function particleSystemDefaults(compW = 1920, compH = 1080) {
  const w = num(compW, 1920, 16, 16384);
  const h = num(compH, 1080, 16, 16384);
  const K = compScale(w, h);
  return {
    schemaVersion: PARTICLE_SCHEMA_VERSION,
    preset: 'dust',
    seed: 184729,

    solver: {
      cacheHz: 30,
      engine: 'auto',
      maxParticles: 1600,
      // Pre-roll for an ambient preset is ONE FULL LIFETIME: the box has to be
      // populated at t = 0, not filling up while the viewer watches.
      preRoll: 5.5,
      space: 'local',
      bounds: {
        shape: 'box',
        size: { x: Math.round(w * 1.15), y: Math.round(h * 1.15), z: 900 },
        // KILL is the default a new solver gets. A wrap is a teleport, and the one
        // thing it cannot survive is being looked at: slow the system down, or make
        // its particles big, and motes visibly jump the box. Kill is the honest
        // reading of a wall, so the preset a user lands on has no such surprise.
        // Presets that were AUTHORED against wrap pin it themselves (presets.js).
        behavior: 'kill',
      },
    },

    emitters: [{
      id: 'emitter-1',
      emit: 'continuous',
      shape: 'box',
      position: { x: 0, y: 0, z: 0 },
      size: { x: Math.round(w * 1.1), y: Math.round(h * 1.1), z: 800 },
      rate: 260,
      // No pulses by default. It used to be one burst of ZERO particles, which
      // is a no-op the panel still had to draw a row for — and now that a pulse
      // can be removed, "none" is a state the UI can actually express.
      bursts: [],
      start: 0,
      end: 9999,
      lifetime: { value: 5, random: 1.5 },
      speed: { value: 22, random: 12 },
      direction: { x: 0, y: 1, z: 0 },
      spread: 180,
      // v3 — ring / path / block geometry and how emission couples to the fluid.
      ring: { radius: Math.round(259 * K), thickness: 30 },
      dirMode: 'cone',
      // How the sites are spread inside the shape. 'random' = the emitter's
      // original three raw draws, so this whole block is inert by default.
      // `sites: 0` means AUTO — as many distinct places as there are particles,
      // which is the only value at which nothing doubles up.
      distribution: {
        mode: 'random',
        jitter: 0,
        order: 'scramble',
        sites: 0,
        rings: 7,
        clusters: 24,
        tightness: 0.05,
        bias: 0,
        thickness: 0.08,
        sequence: 'r2',
        // 'relaxed' only. Past roughly fifteen passes the set has converged and
        // more only costs bake time, which is what the docs say and what the
        // measurements agree with.
        relaxIters: 12,
      },
      // Anchors in the emitter's unit space (-0.5..0.5, +y up), like activation
      // points, so a drawn path survives a composition resize.
      path: { anchors: [] },
      // Emission variance: direction / strength / heat wobble on smooth time
      // noise. The difference between a steady round source (a carpet of
      // same-sized curls) and a plume with billows at every scale.
      variance: 0.35,
      // How hard emission stirs the fluid, and over what radius. Inert unless
      // forces.fluid.model is on.
      stir: { strength: 80, radius: Math.round(120 * K) },
      // Detached: this emitter deposits material only; the force emitters own
      // the field's momentum.
      detach: false,
      // Layer kind only: stop emitting outside the source layer's own span on
      // the timeline. Off — the artwork is a snapshot, and the usual recipe
      // trims the donor layer away after picking it.
      followTimeline: false,
      // The layer sources past the first — see emitterSourcesOf.
      sources: [],
      // shape 'rows' only: the grid of ready-made lines, spread over `size`.
      rows: { count: 60, points: 160 },
    }],

    // Keyed by kind rather than an array: the V1 inspector exposes exactly these
    // five, and a keyed block is what makes `pt:forces.wind.x` a stable keyframe
    // path. A later version that wants two turbulence fields migrates to a list.
    //
    // `pattern` and `mode` are the SHAPE of each field; every pattern is gain-
    // matched (fields.js), so switching one keeps the amount of motion and
    // changes only its character — Strength never has to be re-tuned.
    forces: {
      gravity: { x: 0, y: 0, z: 0 },
      wind: { x: 8, y: 0, z: 0 },
      drag: 0.12,
      turbulence: {
        strength: 26, scale: 0.0038, speed: 0.3,
        pattern: 'billow', complexity: 3, direction: 0,
      },
      vortex: { strength: 0, scale: 700, mode: 'vortex', axis: 'y', lift: 0.5 },

      // THE FLUID FIELD (v3). A force with MEMORY: an incompressible grid the
      // emission stirs and the particles ride. Unlike turbulence it is not a
      // formula in (p, t) — it is simulated, which is what makes smoke curl
      // back on itself. It fits the bake exactly: the grid steps at 1/60 with
      // everything else. Parameter set is Particular's Physics > Fluid.
      fluid: {
        model: 'off',
        force: 200,          // how fast a particle trades its own velocity for the field's
        timeFactor: 1,       // the field's clock, not the particles'
        viscosity: 6,
        swirl: 80,           // vorticity confinement
        swirlSize: 1,        // confinement baseline in cells — fat eddies vs cell-scale curls
        fidelity: 'medium',
        pressureSteps: 20,
        fade: 0.05,
        sharp: false,        // MacCormack for the velocity field
        bounds: 'closed',    // 'open' = outflow (Dirichlet pressure + sponge)
        reach: 'box',        // 'sources' = only particles near a force emitter ride it
        smoke: { buoyancy: 260, weight: 60, heat: 55, cooling: 0.8, dissipate: 0.35 },
      },
      // A gusting wind on the FIELD. Its variation is purely temporal — smooth
      // sines of time — because any spatial pattern reads as a pattern.
      draft: { strength: 0, direction: 0, gust: 0.5 },
      /*
       * RETURN — every particle is pulled back toward the place it was born, at
       * `strength` per second (each step closes 1 − e^(−strength·dt) of the gap,
       * after the particle has moved). Riding a flow of speed v, a particle
       * settles about v / strength away from home: so rows of lines BULGE where
       * smoke passes and relax behind it, and a logo made of particles comes back
       * together after a gust. 0 is off, and off is the solver exactly as it was.
       */
      return: { strength: 0 },
    },

    // FORCE EMITTERS (v3) — pushers with no particles of their own: jets and
    // vortices at a position that may orbit or sweep. They stir the fluid
    // whenever the field is on (the emitter's own stirring is what `detach`
    // switches off); a vortex also drives the particles directly without it.
    forceEmitters: [],

    // PATH FOLLOW (v3) — Particular's "move along path". Particles seek the
    // nearest sample of a spline (attract), ride its tangent (flow) and braid
    // around it (swirl), falling off past `proximity`. Anchors in the solver
    // box's unit space. Empty anchors = the emitter's own path.
    pathFollow: { enabled: false, attract: 220, flow: 260, proximity: Math.round(160 * K), swirl: 0, anchors: [] },

    // COLLISION (v3) — a layer's artwork as a signed-distance collider. Outer
    // faces make it an obstacle, inner faces a container; the fluid respects it
    // too (flow routes around, or stays inside). `source` is the same bounded
    // artwork snapshot a particle object carries; null = no collider.
    collision: {
      source: null,
      faces: 'outer',
      bounce: 0.35,
      depth: 200,
      size: Math.round(422 * K),
      position: { x: 0, y: 0 },
      rotation: 0,
      /*
       * FOLLOW THE SOURCE LAYER — off by default, and off is the shipped
       * behaviour rather than a lesser one.
       *
       * `source` is a bounded artwork SNAPSHOT with no transform, so `size` /
       * `position` / `rotation` say where to lay it in the Solver Box. They are
       * filled in when the layer is picked and then they are frozen: move the
       * layer and the collider stays. With `follow` on they become the FALLBACK
       * — for a source that has been deleted or trimmed out of the current time
       * — and the live pose comes off `fromItemId` every step, keyframes,
       * parenting and scale included. Same contract as a proximity source.
       *
       * It costs a different bake: a followed collider is baked in the ARTWORK's
       * own local space and sampled through the source's inverse transform,
       * because a box-space field would be invalidated by every frame of motion.
       */
      follow: false,
      // The source layer's scale when it was picked, so following tracks the
      // change SINCE then rather than counting the layer's own zoom twice.
      pickScale: 1,
      /*
       * OPEN A SIDE — a container that stops being closed, at a time you choose.
       *
       * `side: 'none'` is the whole block inert and it contributes nothing to the
       * simulation's identity, so a collider that never opens hashes exactly as
       * it did before this existed.
       *
       * The opening is gated on the CONTACT NORMAL, not on position: `bottom`
       * opens every surface whose inward normal points up — the floor of every
       * stroke of a letter rather than a half-plane through the middle — and it
       * keeps working once a particle is outside, because the ground under the
       * shape has the same inward normal as the floor it fell through.
       *
       * Time is expressed here rather than as a keyframe track because it is one
       * scalar with one shape: it opens at `at` and takes `fade` seconds to do
       * it. The solver has the clip-local time already, so this needs no track,
       * no per-step table and no new keyframe namespace — and `amount` can grow
       * a curve later without the gate changing at all.
       */
      /*
       * RELEASE WHAT IS ALREADY OUTSIDE. Off, which is the shipped behaviour.
       *
       * A container hauls back anything outside it, and while it is the only
       * thing placing particles that is right: emission is clipped to the
       * inside, so "outside" can only be drift and pulling it back is a repair.
       *
       * It stops being right the moment the container is not the whole story —
       * a collider that appears part-way through a clip finds a cloud already
       * spread across the frame and sucks all of it inward, which reads as the
       * shape inhaling. On, it holds what is inside it and lets the rest be.
       *
       * An open side forces this on for as long as the door is open, whatever
       * this says: letting particles out and then dragging them back is not a
       * behaviour anyone would choose.
       */
      releaseOutside: false,
      open: {
        side: 'none',
        spread: 90,   // degrees of arc the doorway covers
        at: 0,        // clip-local seconds when it starts opening
        fade: 0.3,    // seconds from closed to fully open
      },
    },

    /*
     * The colliders past the first. `collision` above stays the canonical FIRST
     * one — see collidersOf for why the schema is shaped this way rather than as
     * a single list.
     */
    colliders: [],

    /*
     * PACKING (v4) — particle-to-PARTICLE collision.
     *
     * `collision` above is particle-to-OBJECT: the picked layer's artwork
     * becomes an SDF and every particle is pushed out of it. Nothing there makes
     * two particles aware of each other, so until this block they occupy the
     * same point happily. This is the missing half — the one that turns a spray
     * into a pour, a pile, a jar of beads, a mould filling up.
     *
     * OFF, AND THAT IS LOAD-BEARING RATHER THAN CAUTIOUS. A contact needs a
     * RADIUS, and radius comes from `render.size` — which is deliberately absent
     * from particleSimHash so that resizing a system never re-simulates. Wiring
     * size into the hash unconditionally would re-bake every saved particle
     * system in every project the first time it was opened. With `enabled`
     * false the whole block contributes a literal 0 to the hash and the
     * simulation is character-identical to the one before it existed.
     *
     * See PLANS/VIDEO_EDITOR_PARTICLE_PACKING_PLAN.md; the look-dev it was
     * ported from is html/particle-packing-lab.html.
     */
    packing: {
      enabled: false,
      // Substeps matter more than iterations: XPBD's convergence comes from the
      // step size, so 4x3 stacks visibly better than 1x12 for the same work.
      substeps: 4,
      iters: 3,
      stiffness: 1,          // fraction of the overlap resolved per iteration
      gap: 0,                // extra rest separation, px — beads that don't touch
      friction: 0.45,        // Coulomb mu at particle contacts
      restitution: 0.05,
      /*
       * Drawn sprite radius -> collision radius. Not a fudge factor: a
       * soft-disc sprite's visible mass is well inside its quad, so packing at
       * the literal drawn radius reads as a loose scatter rather than a pack.
       */
      radiusScale: 1,
      // 'circle' | 'object' — see PARTICLE_PACKING_SHAPES.
      shape: 'circle',
      cohesion: 0,           // short-range attraction — clumps, foam, wet sand
      cohesionRange: 0.45,   // x contact distance
      sleep: true,
      sleepDrift: 0.03,      // x radius — net drift under this counts as settled
      sleepFrames: 24,
    },

    // PARTICLE ACTIVATION — when each particle is allowed to exist.
    //
    // 'immediate' is the shipped behaviour and the default: rate and bursts
    // decide, and this whole block is inert. 'grow' only means anything for a
    // `layer` emitter, because it needs artwork for the front to travel through.
    activation: {
      mode: 'immediate',
      inactive: 'frozen',
      // Grow Fill's pair: progress = start + the integral of speed over the clip.
      start: 0,
      speed: 42,
      reverse: false,
      from: 'left',
      seedCount: 1,
      seedStagger: 40,
      // Hand-placed seeds in the emitter's own unit space (-0.5..0.5, +y up), so
      // a point stays on the same letter when the composition is resized.
      points: [],
      softness: 14,
      // IGNITION — what the front leaves on a particle it has just released, and
      // the particle answer to Grow Fill's front edge. 'flash' only brightens what
      // is already there; 'solid' and 'gradient' paint the leading band its own
      // colour, which is the thing that makes a sweep read as fire, or as a laser
      // line, rather than as dots getting bigger.
      ignite: 0.35,
      igniteBoost: 120,
      igniteMode: 'flash',
      // #rrggbbaa like every other stored colour — the sanitizer normalises to it,
      // and a default written short does not survive its own round trip.
      igniteColor: '#ffd7a0ff',
      igniteRamp: [
        { at: 0, color: '#ffffffff' },
        { at: 0.45, color: '#ffc46bff' },
        { at: 1, color: '#ff5a2400' },
      ],
      speedMap: 'uniform',
      noiseScale: 60,
      noiseContrast: 55,
      noiseSeed: 3,
      // Reach has to clear the gap BETWEEN letters or each one is its own island
      // and only the seeded one ever activates.
      bridges: true,
      bridgeReach: 14,
      bridgeSlow: 3,
    },

    render: {
      mode: 'sprite',
      sprite: 'soft-disc',
      blend: 'alpha',
      opacity: 1,
      size: { start: 9, end: 6, random: 0.5 },
      colorOverLife: [
        { at: 0, color: '#ffffff00' },
        { at: 0.22, color: '#efe6d2c4' },
        { at: 0.75, color: '#d8c9ad7a' },
        { at: 1, color: '#ffffff00' },
      ],
      twinkle: 0.2,
      stretch: 0,
      // Where RGB comes from. The ramp above always owns ALPHA, whichever this is.
      colorMode: 'age',
      colorSourceTime: 'live',
      // Read at the particle's own speed, in composition px/s, clamped to the
      // range below — which is why the range is authored rather than auto-fitted:
      // a range that tracked the fastest particle alive would re-colour the whole
      // system every time one of them left the frame.
      velocityRamp: [
        { at: 0, color: '#2f6bffff' },
        { at: 0.5, color: '#33efabff' },
        { at: 1, color: '#ffd166ff' },
      ],
      velocityRange: { min: 0, max: 400 },
      // How a particle LEAVES. Both are render-only — the bake already knows when
      // each particle is removed (see STRIDE in solver.js), so changing these is
      // instant and never re-simulates.
      //   fade  — seconds of fade-out before it goes (0 = off)
      //   scale — how far it shrinks on the way out, 0..1 (0 = off, 1 = to nothing)
      onKill: { fade: 0, scale: 0 },
      /*
       * mode 'lines' only. Everything here is drawn, never simulated.
       *   connect     'time' = trails (a particle's past), 'rows' = a rows grid
       *   width       px at the comp plane; widthRandom 0..1 per line
       *   taperStart / taperEnd   0..1 thinning at the head / tail of a trail,
       *               the left / right end of a row; `profile` shapes it
       *   speedWidth  −1..1 thinner / thicker where the particle moves fast
       *   movedWidth  0..3 thicker where it has moved from its birth point
       *   length      s of past a trail shows; shape 'full' = since birth
       *   end         what a trail does when its particle dies
       *   stayFade    s a stayed trail takes to fade (0 = it stays)
       *   share       0..1 of particles that get a trail
       *   tailFade / fadeCurve   alpha falloff toward the tail
       *   pinEnds     0..0.5 of each row held to its rest line (rows)
       *   smooth      Catmull-Rom sub-samples between neighbouring points
       *   colorMode   'particle' (the Colour section's ramp at each point),
       *               'along' (colorStart → colorEnd down the line / the rows),
       *               'moved' (colorStart at rest → colorEnd at movedRange px)
       *   showParticles  also draw the particles themselves
       */
      lines: {
        connect: 'time',
        width: 2,
        widthRandom: 0.3,
        taperStart: 0.2,
        taperEnd: 1,
        profile: 'smooth',
        speedWidth: 0,
        movedWidth: 0,
        length: 1.5,
        shape: 'trail',
        end: 'retract',
        stayFade: 0,
        share: 1,
        tailFade: 1,
        fadeCurve: 1,
        pinEnds: 0,
        smooth: 4,
        colorMode: 'particle',
        colorStart: '#ffffffff',
        colorEnd: '#3a6bffff',
        movedRange: 160,
        showParticles: false,
      },
    },

    // Layer objects: which layers this system stamps at each particle instead of a
    // procedural sprite. Objects are a RENDER-only concern — the solver moves
    // anonymous points — so editing this block never invalidates the bake.
    objects: {
      members: [],
      pick: 'cycle',
      facing: 'billboard',
      // Relative to the composition, like every other default here: a fixed 90 px
      // is a quarter of the frame on a 360p project and a speck on a 4K one.
      size: Math.round(w * 0.047),
      sizeRandom: 0.35,
      spin: 1,
      keepRatio: true,
      tint: false,
      // Off by default, because it breaks the one rule every other object keeps:
      // a snapshot is self-contained and the same at every frame. With it on, a
      // video member becomes a live texture and every particle shows the same
      // current frame of it.
      playVideo: false,
    },

    // PROXIMITY EFFECTORS (v4) — another layer's shape driving this system.
    // Wholly inert until a source is picked AND something is in `fx`, so the
    // block's mere presence changes nothing about an existing project.
    proximity: {
      enabled: false,
      // Each entry REFERENCES a timeline layer for its transform and SNAPSHOTS
      // its artwork for the field. That split is the feature: the bake is in the
      // artwork's own local space and never repeats, while position, rotation
      // and scale come live off the layer every frame — so a source that moves,
      // spins or pulses costs three multiplies per particle, not a re-bake.
      sources: [],
      measure: 'shape',
      range: Math.round(90 * K),      // px of full influence
      falloff: Math.round(340 * K),   // px it fades out over
      shape: 'smooth',
      combine: 'max',
      // 0 keeps the field FLAT — z is ignored, so a plate influences the whole
      // depth of the solver box, which is what a 2D-authored look expects.
      // Above 0 the shape becomes a slab: sd3 = max(sd2d, |z| − depth), the same
      // finite extrusion the collider uses.
      depth: 0,
      invert: false,
      // { <target key>: amount } — see PARTICLE_PROX_TARGETS.
      fx: {},
      // Where the Colour target reads from. A ramp keyed on PROXIMITY rather
      // than on age is the thing that makes a moving word read out of a cloud.
      colorMode: 'solid',
      color: '#33efabff',
      colorRamp: [
        { at: 0, color: '#2f6bffff' },
        { at: 0.5, color: '#33efabff' },
        { at: 1, color: '#ffffffff' },
      ],
    },

    quality: { previewFraction: 1 },
  };
}

/*
 * One proximity source. `source` is the same bounded artwork snapshot a particle
 * object and the collider carry, so all three go through sanitizeObjectSource.
 *
 * `fromItemId` is not decoration: it is where the live transform comes from. The
 * stored size / position / rotation are the FALLBACK for when that layer is gone
 * (deleted, or trimmed out of the current time), so a source keeps its last
 * known pose instead of collapsing to the origin.
 */
function sanitizeProxSource(raw, compW) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const source = r.source ? sanitizeObjectSource(r.source) : null;
  if (!source) return null;
  return {
    id: typeof r.id === 'string' && r.id ? r.id.slice(0, 64) : `prox-${Math.round(num(r.seed, 1, 0, 1e9))}`,
    source,
    ...(typeof r.sourceName === 'string' && r.sourceName ? { sourceName: r.sourceName.slice(0, 80) } : {}),
    ...(typeof r.fromItemId === 'string' && r.fromItemId ? { fromItemId: r.fromItemId.slice(0, 64) } : {}),
    // `follow` off pins the source to the stored pose and ignores the layer —
    // useful when the layer is only there to donate its artwork.
    follow: r.follow !== false,
    size: num(r.size, Math.round(num(compW, 1920, 16, 16384) * 0.33), 1, 100000),
    position: {
      x: num(r.position?.x, 0, -100000, 100000),
      y: num(r.position?.y, 0, -100000, 100000),
    },
    rotation: num(r.rotation, 0, -100000, 100000),
    /*
     * The source layer's scale at the moment it was picked.
     *
     * `size` means "how wide the artwork looked when you chose it", so following
     * the layer has to track the change SINCE then — size x (liveScale /
     * pickScale). Without this the layer's own zoom is counted twice: once
     * baked into `size` by the picker's screen rect, once again by the live
     * matrix, and a source on a 2x layer drives a field four times too big.
     */
    pickScale: num(r.pickScale, 1, 0.0001, 10000),
  };
}

function sanitizeProximity(raw, D, compW) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const sources = (Array.isArray(p.sources) ? p.sources : [])
    .slice(0, PARTICLE_MAX_PROX_SOURCES)
    .map((r) => sanitizeProxSource(r, compW))
    .filter(Boolean);
  const rawFx = p.fx && typeof p.fx === 'object' ? p.fx : {};
  const fx = {};
  // Bounded by the registry, so an amount can never arrive out of the range the
  // panel and the solver both assume.
  for (const t of PARTICLE_PROX_TARGETS) {
    if (rawFx[t.key] === undefined) continue;
    const v = num(rawFx[t.key], t.def, t.min, t.max);
    if (Number.isFinite(v)) fx[t.key] = v;
  }
  return {
    enabled: p.enabled === true,
    sources,
    measure: pick(p.measure, PARTICLE_PROX_MEASURES, D.measure),
    range: num(p.range, D.range, 0, 100000),
    falloff: num(p.falloff, D.falloff, 1, 100000),
    shape: pick(p.shape, PARTICLE_PROX_SHAPES, D.shape),
    combine: pick(p.combine, PARTICLE_PROX_COMBINES, D.combine),
    depth: num(p.depth, D.depth, 0, 100000),
    invert: p.invert === true,
    fx,
    colorMode: pick(p.colorMode, PARTICLE_PROX_COLOR_MODES, D.colorMode),
    color: normalizeParticleColor(p.color, D.color),
    colorRamp: sanitizeRamp(p.colorRamp, D.colorRamp),
  };
}

/**
 * Is this block actually doing anything? Both the renderer and the bake key ask,
 * and they must agree — a block that is "on" with no source and no driven
 * property must not invalidate a cache or cost a per-particle branch.
 */
/**
 * Does the proximity effector feed PACKING?
 *
 * `size` is a look target, so an effector that only drives it is not handed to
 * the solver at all — `proximityDrivesMotion` is the gate, and it is right for
 * everything except this. With packing on the size target is the CONTACT RADIUS,
 * so the tables and the pose track have to make the trip.
 *
 * ONE predicate, used by all three places that have to agree: the sim hash, the
 * renderer's hand-off to the solver, and the solver's own gate. They were
 * written separately the first time and the hand-off was missed, so the hash
 * re-baked and the bake had nothing to read.
 */
export function proximityFeedsPacking(system, animated = null) {
  if (!system?.packing?.enabled) return false;
  if (!proximityActive(system.proximity)) return false;
  if ((system.proximity?.fx?.size || 0) !== 0) return true;
  return !!animated?.has?.('size');
}

export function proximityActive(prox) {
  return !!(prox && prox.enabled && prox.sources?.length && Object.keys(prox.fx || {}).length);
}

/**
 * Does anything in this block reach the SOLVER? If not, an edit is free.
 *
 * `animated` is the set of proximity parameters carrying a `px:` keyframe track
 * (resolved by the editor — this module knows nothing about track keys). A
 * motion amount whose STORED value is 0 but which is animated away from 0 still
 * reaches the solver, and without this the whole solver hand-off was skipped for
 * exactly the setup people reach for first: park Attract at 0, key it up on the
 * beat, watch nothing happen.
 */
export function proximityDrivesMotion(prox, animated = null) {
  if (!proximityActive(prox)) return false;
  return PARTICLE_PROX_MOTION_KEYS.some((k) => (
    (Number.isFinite(prox.fx[k]) && prox.fx[k] !== 0)
    || (prox.fx[k] !== undefined && animated?.has?.(k))
  ));
}

function sanitizeObjectSource(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const kind = pick(src.kind, PARTICLE_OBJECT_KINDS, null);
  if (!kind) return null;
  if (kind === 'image') {
    const url = typeof src.url === 'string' && src.url ? src.url.slice(0, 2048) : '';
    if (!url) return null;
    return {
      kind: 'image',
      url,
      aspect: num(src.aspect, 1, 0.01, 100),
      // A silhouette SVG carries the colour its layer floods it with. Only stored
      // when there is one, so an ordinary photo source is byte-identical to what
      // it has always been.
      ...(typeof src.tint === 'string' && src.tint ? { tint: src.tint.slice(0, 64) } : {}),
    };
  }
  if (kind === 'video') {
    const url = typeof src.url === 'string' && src.url ? src.url.slice(0, 2048) : '';
    if (!url) return null;
    return {
      kind: 'video',
      url,
      aspect: num(src.aspect, 1, 0.01, 100),
      // The still to stamp when Play video is off (and before the first frame
      // decodes when it is on) — a layer's own thumbnail, so a paused system
      // still looks like the clip rather than like nothing.
      ...(typeof src.poster === 'string' && src.poster ? { poster: src.poster.slice(0, 2048) } : {}),
    };
  }

  if (kind === 'text') {
    const text = typeof src.text === 'string' ? src.text.slice(0, 200) : '';
    if (!text.trim()) return null;
    return {
      kind: 'text',
      text,
      fontFamily: typeof src.fontFamily === 'string' && src.fontFamily ? src.fontFamily.slice(0, 200) : 'sans-serif',
      fontWeight: Math.round(num(src.fontWeight, 700, 100, 1000)),
      fontSize: num(src.fontSize, 96, 4, 2000),
      lineHeight: num(src.lineHeight, 1.15, 0.5, 4),
      color: typeof src.color === 'string' && src.color ? src.color.slice(0, 64) : '#ffffff',
    };
  }
  // Shape: the resolved outline in unit space, so the rasteriser needs none of the
  // shape layer's own schema and a later shape type cannot silently break it.
  const points = Array.isArray(src.points) ? src.points.slice(0, PARTICLE_MAX_OUTLINE_POINTS) : [];
  if (points.length < 2) return null;
  const pt = (v) => ({ x: num(v?.x, 0, -10, 10), y: num(v?.y, 0, -10, 10) });
  return {
    kind: 'shape',
    closed: src.closed !== false,
    fill: typeof src.fill === 'string' && src.fill ? src.fill.slice(0, 64) : '#ffffff',
    stroke: typeof src.stroke === 'string' && src.stroke ? src.stroke.slice(0, 64) : '',
    strokeWidth: num(src.strokeWidth, 0, 0, 200),
    aspect: num(src.aspect, 1, 0.01, 100),
    points: points.map((p) => ({
      ...pt(p),
      ...(p?.hIn ? { hIn: pt(p.hIn) } : {}),
      ...(p?.hOut ? { hOut: pt(p.hOut) } : {}),
    })),
  };
}

function sanitizeEmitter(raw, D) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const life = e.lifetime && typeof e.lifetime === 'object' ? e.lifetime : {};
  const speed = e.speed && typeof e.speed === 'object' ? e.speed : {};
  const bursts = Array.isArray(e.bursts) ? e.bursts.slice(0, 8) : D.bursts;
  return {
    id: typeof e.id === 'string' && e.id ? e.id.slice(0, 64) : D.id,
    emit: pick(e.emit, PARTICLE_EMIT_MODES, D.emit),
    shape: pick(e.shape, PARTICLE_EMITTER_SHAPES, D.shape),
    position: vec3(e.position, 0, 0, 0, -100000, 100000),
    size: vec3(e.size, D.size.x, D.size.y, D.size.z, 0, 100000),
    rate: num(e.rate, D.rate, 0, 20000),
    /*
     * A PULSE IS CAPPED BY THE ENGINE'S CEILING, NOT THE BAKE'S.
     *
     * This clamped at PARTICLE_MAX_PARTICLES (100,000) — the number the BAKE can
     * hold — which is the same confusion `solver.maxParticles` was already fixed
     * for two lines below. A system with Max particles at four million and one
     * pulse could ask for at most a fortieth of its own capacity, and typing a
     * bigger number silently rewrote it on the next save. The pulse's real limit
     * is the pool it fires into, and the solver clamps a step's births to the
     * cap anyway, so nothing here needs to be smaller than the cap itself.
     */
    bursts: bursts.map((b) => ({
      time: num(b?.time, 0, 0, 3600),
      count: Math.round(num(b?.count, 0, 0, PARTICLE_MAX_GPU)),
    })),
    start: num(e.start, D.start, 0, 3600),
    end: num(e.end, D.end, 0, 99999),
    lifetime: {
      value: num(life.value, D.lifetime.value, 0.05, 600),
      random: num(life.random, D.lifetime.random, 0, 600),
    },
    speed: {
      value: num(speed.value, D.speed.value, 0, 100000),
      random: num(speed.random, D.speed.random, 0, 100000),
    },
    direction: vec3(e.direction, 0, 1, 0, -1000, 1000),
    spread: num(e.spread, D.spread, 0, 180),
    ring: {
      radius: num(e.ring?.radius, D.ring.radius, 1, 100000),
      thickness: num(e.ring?.thickness, D.ring.thickness, 0, 100000),
    },
    dirMode: pick(e.dirMode, PARTICLE_EMIT_DIR_MODES, D.dirMode),
    // A missing block sanitises to the defaults, whose mode is 'random' — the
    // simulation every pre-distribution project was authored against.
    distribution: (() => {
      const s = e.distribution && typeof e.distribution === 'object' ? e.distribution : {};
      const DD = D.distribution;
      return {
        mode: pick(s.mode, PARTICLE_DISTRIBUTIONS, DD.mode),
        jitter: num(s.jitter, DD.jitter, 0, 1),
        order: pick(s.order, PARTICLE_FILL_ORDERS, DD.order),
        // 0 is AUTO and has to survive the round trip, so the floor is 0 rather
        // than the 16 the sampler clamps a real value to.
        sites: Math.round(num(s.sites, DD.sites, 0, PARTICLE_MAX_GPU)),
        rings: Math.round(num(s.rings, DD.rings, 1, 512)),
        clusters: Math.round(num(s.clusters, DD.clusters, 1, 4096)),
        tightness: num(s.tightness, DD.tightness, 0.001, 0.5),
        bias: num(s.bias, DD.bias, -1, 1),
        thickness: num(s.thickness, DD.thickness, 0.002, 0.5),
        sequence: pick(s.sequence, PARTICLE_DIST_SEQUENCES, DD.sequence),
        relaxIters: Math.round(num(s.relaxIters, DD.relaxIters, 0, 40)),
      };
    })(),
    path: { anchors: sanitizeAnchors(e.path?.anchors) },
    variance: num(e.variance, D.variance, 0, 1),
    stir: {
      strength: num(e.stir?.strength, D.stir.strength, 0, 200),
      radius: num(e.stir?.radius, D.stir.radius, 1, 100000),
    },
    detach: e.detach === true,
    // shape: 'layer' — the artwork whose opaque pixels become emission sites.
    // Same bounded snapshot a particle object carries, for the same reasons.
    ...(e.source ? (() => {
      const source = sanitizeObjectSource(e.source);
      return source ? {
        source,
        ...(typeof e.sourceName === 'string' && e.sourceName ? { sourceName: e.sourceName.slice(0, 80) } : {}),
        ...(typeof e.fromItemId === 'string' && e.fromItemId ? { fromItemId: e.fromItemId.slice(0, 64) } : {}),
      } : {};
    })() : {}),
    /*
     * EMIT ONLY WHILE THE SOURCE LAYER IS ON THE TIMELINE. Off by default.
     *
     * Opt-in rather than automatic, and for one specific reason: the artwork is
     * a SNAPSHOT, so the usual dissolve recipe picks a layer and then trims or
     * removes it, and turning that into "stops emitting" would silently break
     * every project built that way. Off, it emits on its own schedule exactly as
     * it always has.
     *
     * It is the clip's SPAN, never its visibility — hiding the donor layer is
     * part of the same recipe.
     */
    followTimeline: !!e.followTimeline && !!e.fromItemId,
    /*
     * The layer sources past the first. `source` above stays the canonical FIRST
     * one, exactly as `collision` does for the colliders — same reasoning, and
     * the same `emitterSourcesOf` helper shape.
     *
     * Each carries its OWN rect, because two layers do not share one: a word and
     * a mark are in different places at different sizes, and the emitter's own
     * `size`/`position` is only the box the merged result is expressed in.
     */
    sources: (Array.isArray(e.sources) ? e.sources : [])
      .slice(0, PARTICLE_MAX_EMITTER_SOURCES - 1)
      .map((x) => {
        const source = x?.source ? sanitizeObjectSource(x.source) : null;
        if (!source) return null;
        return {
          source,
          ...(typeof x.sourceName === 'string' && x.sourceName ? { sourceName: x.sourceName.slice(0, 80) } : {}),
          ...(typeof x.fromItemId === 'string' && x.fromItemId ? { fromItemId: x.fromItemId.slice(0, 64) } : {}),
          size: {
            x: num(x.size?.x, D.size.x, 1, 100000),
            y: num(x.size?.y, D.size.y, 1, 100000),
          },
          position: {
            x: num(x.position?.x, 0, -100000, 100000),
            y: num(x.position?.y, 0, -100000, 100000),
          },
          followTimeline: !!x.followTimeline && !!x.fromItemId,
        };
      })
      .filter(Boolean),
    rows: (() => {
      const count = Math.round(num(e.rows?.count, D.rows.count, 1, PARTICLE_ROWS_MAX_COUNT));
      const points = Math.round(num(e.rows?.points, D.rows.points, 2, PARTICLE_ROWS_MAX_POINTS));
      // The grid is the pool, so the PRODUCT is what has to stay bakeable.
      return { count, points: Math.max(2, Math.min(points, Math.floor(PARTICLE_ROWS_MAX_TOTAL / count))) };
    })(),
  };
}

/**
 * Every layer source this emitter fires from, first-and-canonical first.
 * `emitters[0].source` is the first; `emitters[0].sources[]` holds the rest.
 */
export function emitterSourcesOf(em) {
  const out = [];
  if (em?.source) {
    out.push({
      source: em.source,
      sourceName: em.sourceName,
      fromItemId: em.fromItemId,
      size: em.size,
      position: em.position,
      followTimeline: !!em.followTimeline,
    });
  }
  for (const x of em?.sources || []) if (x?.source) out.push(x);
  return out;
}

/** How many layers one emitter may fire from. Matches the collider cap. */
export const PARTICLE_MAX_EMITTER_SOURCES = 4;

function sanitizeRamp(raw, fallback) {
  if (!Array.isArray(raw) || !raw.length) return fallback.map((s) => ({ ...s }));
  const stops = raw
    .slice(0, PARTICLE_MAX_RAMP_STOPS)
    .map((s) => ({ at: num(s?.at, 0, 0, 1), color: color(s?.color, '#ffffffff') }))
    .sort((a, b) => a.at - b.at);
  return stops.length ? stops : fallback.map((s) => ({ ...s }));
}

/**
 * A member's artwork, SNAPSHOT from the layer it was picked from.
 *
 * Deliberately not a live reference to that layer. A snapshot is self-contained
 * (the system keeps working if the source layer is trimmed, hidden or deleted),
 * bounded (this is exactly the field list below, nothing else rides along), and
 * deterministic — the same reasons preset configs are materialised rather than
 * pointed at. "Update from layer" can re-take the snapshot later.
 */
function sanitizeObjects(raw, D) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const members = Array.isArray(o.members) ? o.members : [];
  return {
    members: members.slice(0, PARTICLE_MAX_OBJECTS).reduce((out, m) => {
      // A member with no usable artwork is dropped rather than kept as a blank row
      // that silently stamps nothing.
      const source = sanitizeObjectSource(m?.source);
      if (!source) return out;
      out.push({
        id: typeof m.id === 'string' && m.id ? m.id.slice(0, 64) : `m-${out.length}`,
        name: typeof m.name === 'string' && m.name ? m.name.slice(0, 80) : 'Object',
        // The layer this artwork was taken from, so it can be re-taken later. Only
        // a hint: the layer may be long gone, and the snapshot still works.
        ...(typeof m.fromItemId === 'string' && m.fromItemId ? { fromItemId: m.fromItemId.slice(0, 64) } : {}),
        source,
        included: m.included !== false,
        weight: num(m.weight, 1, 0, 10),
        sizeScale: num(m.sizeScale, 1, 0.05, 20),
        spinScale: num(m.spinScale, 1, 0, 20),
      });
      return out;
    }, []),
    pick: pick(o.pick, PARTICLE_OBJECT_PICKS, D.pick),
    facing: pick(o.facing, PARTICLE_OBJECT_FACINGS, D.facing),
    size: num(o.size, D.size, 1, 4000),
    sizeRandom: num(o.sizeRandom, D.sizeRandom, 0, 1),
    spin: num(o.spin, D.spin, 0, 20),
    keepRatio: o.keepRatio !== false,
    tint: o.tint === true,
    playVideo: o.playVideo === true,
  };
}

/**
 * Version-aware, bounded sanitizer. Unknown fields fall to defaults; malicious or
 * corrupt counts are capped. Returns a complete system — callers attach it ONLY to
 * items that actually carry one, so old projects never acquire the field on save.
 */
/**
 * Particle Activation, bounded. Points are clamped into the emitter's unit space
 * and capped, because they arrive from a saved project and from a click.
 */
function sanitizeActivation(raw, D) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const points = Array.isArray(a.points) ? a.points.slice(0, PARTICLE_MAX_GROW_POINTS) : [];
  return {
    mode: pick(a.mode, PARTICLE_ACTIVATIONS, D.mode),
    inactive: pick(a.inactive, PARTICLE_INACTIVE_MODES, D.inactive),
    start: num(a.start, D.start, 0, 100),
    speed: num(a.speed, D.speed, 0, 400),
    reverse: a.reverse === true,
    from: pick(a.from, PARTICLE_GROW_FROMS, D.from),
    seedCount: Math.round(num(a.seedCount, D.seedCount, 1, PARTICLE_MAX_GROW_POINTS)),
    seedStagger: num(a.seedStagger, D.seedStagger, 0, 100),
    points: points.map((p) => ({
      x: num(p?.x, 0, -0.5, 0.5),
      y: num(p?.y, 0, -0.5, 0.5),
      delay: num(p?.delay, 0, 0, 1),
    })),
    softness: num(a.softness, D.softness, 0, 60),
    ignite: num(a.ignite, D.ignite, 0, 4),
    igniteBoost: num(a.igniteBoost, D.igniteBoost, 0, 400),
    igniteMode: pick(a.igniteMode, PARTICLE_IGNITE_MODES, D.igniteMode),
    igniteColor: color(a.igniteColor, D.igniteColor),
    igniteRamp: sanitizeRamp(a.igniteRamp, D.igniteRamp),
    speedMap: pick(a.speedMap, PARTICLE_GROW_SPEED_MAPS, D.speedMap),
    noiseScale: num(a.noiseScale, D.noiseScale, 4, 400),
    noiseContrast: num(a.noiseContrast, D.noiseContrast, 0, 100),
    noiseSeed: Math.round(num(a.noiseSeed, D.noiseSeed, 0, 999)),
    bridges: a.bridges !== false,
    bridgeReach: Math.round(num(a.bridgeReach, D.bridgeReach, 1, 80)),
    bridgeSlow: num(a.bridgeSlow, D.bridgeSlow, 1, 12),
  };
}

/** Path anchors, clamped into unit space (-0.5..0.5) and capped. */
function sanitizeAnchors(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, PARTICLE_MAX_PATH_ANCHORS).map((p) => ({
    x: num(p?.x, 0, -0.5, 0.5),
    y: num(p?.y, 0, -0.5, 0.5),
  }));
}

function sanitizeLines(raw, D) {
  const l = raw && typeof raw === 'object' ? raw : {};
  return {
    connect: pick(l.connect, PARTICLE_LINE_CONNECTS, D.connect),
    width: num(l.width, D.width, 0.1, 400),
    widthRandom: num(l.widthRandom, D.widthRandom, 0, 1),
    taperStart: num(l.taperStart, D.taperStart, 0, 1),
    taperEnd: num(l.taperEnd, D.taperEnd, 0, 1),
    profile: pick(l.profile, PARTICLE_LINE_PROFILES, D.profile),
    speedWidth: num(l.speedWidth, D.speedWidth, -1, 1),
    movedWidth: num(l.movedWidth, D.movedWidth, 0, 3),
    length: num(l.length, D.length, 0.02, 60),
    shape: pick(l.shape, PARTICLE_LINE_SHAPES, D.shape),
    end: pick(l.end, PARTICLE_LINE_ENDS, D.end),
    stayFade: num(l.stayFade, D.stayFade, 0, 60),
    share: num(l.share, D.share, 0.01, 1),
    tailFade: num(l.tailFade, D.tailFade, 0, 1),
    fadeCurve: num(l.fadeCurve, D.fadeCurve, 0.1, 6),
    pinEnds: num(l.pinEnds, D.pinEnds, 0, 0.5),
    smooth: PARTICLE_LINE_SMOOTHING.includes(l.smooth) ? l.smooth : D.smooth,
    colorMode: pick(l.colorMode, PARTICLE_LINE_COLOR_MODES, D.colorMode),
    colorStart: normalizeParticleColor(l.colorStart, D.colorStart),
    colorEnd: normalizeParticleColor(l.colorEnd, D.colorEnd),
    movedRange: num(l.movedRange, D.movedRange, 1, 100000),
    showParticles: l.showParticles === true,
  };
}

function sanitizeFluid(raw, D) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const sm = f.smoke && typeof f.smoke === 'object' ? f.smoke : {};
  return {
    model: pick(f.model, PARTICLE_FLUID_MODELS, D.model),
    force: num(f.force, D.force, 0, 400),
    timeFactor: num(f.timeFactor, D.timeFactor, 0.1, 4),
    viscosity: num(f.viscosity, D.viscosity, 0, 100),
    swirl: num(f.swirl, D.swirl, 0, 200),
    swirlSize: Math.round(num(f.swirlSize, D.swirlSize, 1, 6)),
    fidelity: pick(f.fidelity, PARTICLE_FLUID_FIDELITIES, D.fidelity),
    pressureSteps: Math.round(num(f.pressureSteps, D.pressureSteps, 4, 60)),
    fade: num(f.fade, D.fade, 0, 1),
    sharp: f.sharp === true,
    bounds: pick(f.bounds, PARTICLE_FLUID_BOUNDS, D.bounds),
    reach: pick(f.reach, PARTICLE_FLUID_REACHES, D.reach || 'box'),
    smoke: {
      buoyancy: num(sm.buoyancy, D.smoke.buoyancy, -200, 600),
      weight: num(sm.weight, D.smoke.weight, 0, 400),
      heat: num(sm.heat, D.smoke.heat, 0, 100),
      cooling: num(sm.cooling, D.smoke.cooling, 0, 4),
      dissipate: num(sm.dissipate, D.smoke.dissipate, 0, 4),
    },
  };
}

function sanitizeDraft(raw, D) {
  const d = raw && typeof raw === 'object' ? raw : {};
  return {
    strength: num(d.strength, D.strength, 0, 300),
    direction: num(d.direction, D.direction, 0, 360),
    gust: num(d.gust, D.gust, 0, 1),
  };
}

function sanitizeForceEmitters(raw, compW) {
  if (!Array.isArray(raw)) return [];
  const w = num(compW, 1920, 16, 16384);
  return raw.slice(0, PARTICLE_MAX_FORCE_EMITTERS).map((f, i) => {
    const e = f && typeof f === 'object' ? f : {};
    return {
      id: typeof e.id === 'string' && e.id ? e.id.slice(0, 64) : `force-${i + 1}`,
      kind: pick(e.kind, PARTICLE_FORCE_EMITTER_KINDS, 'jet'),
      spin: pick(e.spin, PARTICLE_FORCE_EMITTER_SPINS, 'ccw'),
      position: vec3(e.position, 0, 0, 0, -100000, 100000),
      radius: num(e.radius, Math.round(180 * compScale(w, w * 9 / 16)), 1, 100000),
      // 0..2000, not 0..300. A blower or a thermal saturates long before 300
      // (its splat's coupling `k` is strength/100, clamped at 1), but Attract
      // and Repel are a plain acceleration that is LINEAR in strength and falls
      // off with distance — at 300 over a full-frame radius they are a drift.
      // The panel still offers 300 for every other kind; the headroom is only
      // reachable where it does something.
      strength: num(e.strength, 130, 0, 2000),
      // Smoke sources only: how much material a second, and how hot it is
      // (heat is what buoyancy lifts, on the same scale as forces.fluid.smoke.heat).
      density: num(e.density, 2.2, 0, 8),
      heat: num(e.heat, 55, 0, 100),
      // Burst kind only: when the impulses land. `pulseEvery: 0` fires once.
      pulseStart: num(e.pulseStart, 0, 0, 3600),
      pulseEvery: num(e.pulseEvery, 1.5, 0, 3600),
      // Force kind only: the same five shapes GLOBAL FORCE has, at a point.
      mode: pick(e.mode, PARTICLE_FIELD_MODES, 'vortex'),
      lift: num(e.lift, 0.5, 0, 4),
      push: num(e.push, 400, 0, 100000),
      direction: num(e.direction, 90, 0, 360),
      motion: pick(e.motion, PARTICLE_FORCE_EMITTER_MOTIONS, 'hold'),
      motionSpeed: num(e.motionSpeed, 0.6, 0.1, 3),
      motionRadius: num(e.motionRadius, Math.round(280 * compScale(w, w * 9 / 16)), 0, 100000),
      // Layer kind only: WHICH layer drives it. Stored the same way the
      // collision block stores its pick — the id is the live reference, the
      // name is only for the panel to show.
      ...(typeof e.fromItemId === 'string' && e.fromItemId ? { fromItemId: e.fromItemId.slice(0, 64) } : {}),
      ...(typeof e.sourceName === 'string' && e.sourceName ? { sourceName: e.sourceName.slice(0, 80) } : {}),
      // Layer kind only: whether rotation and scale contribute their velocity
      // GRADIENT, or only the centre's travel. A spinning layer with the
      // gradient off pushes nothing, which is sometimes exactly what you want.
      spinDrag: e.spinDrag !== false,
    };
  });
}

function sanitizePathFollow(raw, D) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: p.enabled === true,
    attract: num(p.attract, D.attract, 0, 600),
    flow: num(p.flow, D.flow, 0, 600),
    proximity: num(p.proximity, D.proximity, 1, 100000),
    swirl: num(p.swirl, D.swirl, 0, 400),
    anchors: sanitizeAnchors(p.anchors),
  };
}

function sanitizeCollision(raw, D) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const source = c.source ? sanitizeObjectSource(c.source) : null;
  return {
    source,
    ...(source && typeof c.sourceName === 'string' && c.sourceName ? { sourceName: c.sourceName.slice(0, 80) } : {}),
    ...(source && typeof c.fromItemId === 'string' && c.fromItemId ? { fromItemId: c.fromItemId.slice(0, 64) } : {}),
    faces: pick(c.faces, PARTICLE_COLLISION_FACES, D.faces),
    bounce: num(c.bounce, D.bounce, 0, 1),
    depth: num(c.depth, D.depth, 1, 100000),
    size: num(c.size, D.size, 1, 100000),
    position: {
      x: num(c.position?.x, D.position.x, -100000, 100000),
      y: num(c.position?.y, D.position.y, -100000, 100000),
    },
    rotation: num(c.rotation, D.rotation ?? 0, -100000, 100000),
    releaseOutside: !!c.releaseOutside,
    open: {
      side: pick(c.open?.side, PARTICLE_COLLISION_OPEN_SIDES, D.open?.side ?? 'none'),
      spread: num(c.open?.spread, D.open?.spread ?? 90, 1, 180),
      at: num(c.open?.at, D.open?.at ?? 0, 0, 3600),
      fade: num(c.open?.fade, D.open?.fade ?? 0.3, 0, 3600),
    },
    // Follow needs a layer to follow; without one it is inert, so it sanitizes
    // to false rather than sitting on as a promise nothing can keep.
    follow: !!c.follow && !!source && typeof c.fromItemId === 'string' && !!c.fromItemId,
    pickScale: num(c.pickScale, D.pickScale ?? 1, 0.0001, 10000),
  };
}

/**
 * Every collider on this system, first-and-canonical first.
 *
 * `collision` STAYS THE NAME OF THE FIRST COLLIDER and `colliders[]` holds the
 * rest. That is not the tidiest schema — the tidy one is a single list with
 * `collision` deleted — and it is the one that costs nothing: every saved
 * project has a `collision` object, so the tidy version would need a migration
 * on all of them, a second shape for particleSimHash to produce, and a panel
 * that has to work out which it is holding. This costs one helper, and
 * `emitters[]` has been an array with one entry since V1 without anyone minding.
 *
 * A collider with no `source` is a block that has never been pointed at a layer;
 * it is not a collider and is dropped here rather than checked for everywhere.
 */
export function collidersOf(system) {
  const out = [];
  const c = system?.collision;
  if (c?.source) out.push(c);
  const rest = system?.colliders;
  if (Array.isArray(rest)) for (const x of rest) if (x?.source) out.push(x);
  return out;
}

/** How many colliders one system may carry. Matches PARTICLE_MAX_PROX_SOURCES. */
export const PARTICLE_MAX_COLLIDERS = 4;

/** True when this system's collider takes its pose from a live layer. */
export function collisionFollows(system) {
  const c = system?.collision;
  return !!(c && c.source && c.follow && c.fromItemId);
}

/*
 * PACKING. Every field is inert while `enabled` is false, but they are still
 * sanitised and still round-trip: a user who switches it off to compare must get
 * their tuning back when they switch it on again.
 */
function sanitizePacking(raw, D) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: !!c.enabled,
    substeps: Math.round(num(c.substeps, D.substeps, 1, 8)),
    iters: Math.round(num(c.iters, D.iters, 1, 12)),
    stiffness: num(c.stiffness, D.stiffness, 0.05, 1),
    gap: num(c.gap, D.gap, 0, 200),
    friction: num(c.friction, D.friction, 0, 2),
    restitution: num(c.restitution, D.restitution, 0, 1),
    radiusScale: num(c.radiusScale, D.radiusScale, 0.1, 3),
    shape: pick(c.shape, PARTICLE_PACKING_SHAPES, D.shape),
    cohesion: num(c.cohesion, D.cohesion, 0, 2),
    cohesionRange: num(c.cohesionRange, D.cohesionRange, 0, 2),
    sleep: c.sleep === undefined ? D.sleep : !!c.sleep,
    sleepDrift: num(c.sleepDrift, D.sleepDrift, 0, 1),
    sleepFrames: Math.round(num(c.sleepFrames, D.sleepFrames, 1, 240)),
  };
}

export function sanitizeParticleSystem(raw, compW, compH) {
  const D = particleSystemDefaults(compW, compH);
  if (!raw || typeof raw !== 'object') return D;
  // A stored system with no schemaVersion is version 1 — the field was written
  // from the first release, so its absence means "older than that".
  const legacy = num(raw.schemaVersion, 1, 0, 999) < 2;

  const solver = raw.solver && typeof raw.solver === 'object' ? raw.solver : {};
  const bounds = solver.bounds && typeof solver.bounds === 'object' ? solver.bounds : {};
  const forces = raw.forces && typeof raw.forces === 'object' ? raw.forces : {};
  const turb = forces.turbulence && typeof forces.turbulence === 'object' ? forces.turbulence : {};
  const vort = forces.vortex && typeof forces.vortex === 'object' ? forces.vortex : {};
  const render = raw.render && typeof raw.render === 'object' ? raw.render : {};
  const size = render.size && typeof render.size === 'object' ? render.size : {};
  const quality = raw.quality && typeof raw.quality === 'object' ? raw.quality : {};
  const emitters = Array.isArray(raw.emitters) && raw.emitters.length ? raw.emitters : D.emitters;
  const ems = emitters.slice(0, PARTICLE_MAX_EMITTERS).map((e) => sanitizeEmitter(e, D.emitters[0]));
  // A rows emitter's pool IS its grid — every other consumer (tier choice, the
  // live engine, the bake budget) reads maxParticles, so it has to say so.
  const rowsTotal = particleRowsTotal(ems[0]);

  return {
    schemaVersion: PARTICLE_SCHEMA_VERSION,
    preset: typeof raw.preset === 'string' && raw.preset ? raw.preset.slice(0, 40) : D.preset,
    seed: Math.round(num(raw.seed, D.seed, 0, 2147483647)),

    solver: {
      cacheHz: 30,
      engine: pick(solver.engine, PARTICLE_PREVIEW_ENGINES, 'auto'),
      /*
       * CEILING IS THE GPU'S, NOT THE BAKE'S.
       *
       * This used to clamp at PARTICLE_MAX_PARTICLES, which meant a count above
       * 100,000 could never survive a save however high the panel let it go —
       * the GPU engine's millions were sanitised away on the way back in.
       *
       * The bake is protected where it belongs instead: `ensureParticleCache`
       * clamps what it will actually simulate, so a large number costs GPU
       * memory when the GPU runs it and costs the bake nothing when it does not.
       */
      maxParticles: rowsTotal || Math.round(num(solver.maxParticles, D.solver.maxParticles, 1, PARTICLE_MAX_GPU)),
      preRoll: num(solver.preRoll, D.solver.preRoll, 0, 30),
      space: 'local',
      bounds: {
        shape: 'box',
        size: vec3(bounds.size, D.solver.bounds.size.x, D.solver.bounds.size.y, D.solver.bounds.size.z, 1, 100000),
        behavior: pick(bounds.behavior, PARTICLE_BOUNDS_BEHAVIORS, D.solver.bounds.behavior),
      },
    },

    emitters: ems,

    forces: {
      gravity: vec3(forces.gravity, 0, 0, 0, -100000, 100000),
      wind: vec3(forces.wind, D.forces.wind.x, 0, 0, -100000, 100000),
      drag: num(forces.drag, D.forces.drag, 0, 20),
      turbulence: {
        strength: num(turb.strength, D.forces.turbulence.strength, 0, 20000),
        scale: num(turb.scale, D.forces.turbulence.scale, 0.00001, 1),
        speed: num(turb.speed, D.forces.turbulence.speed, 0, 20),
        // THE MIGRATION: a version-1 system was authored against the curl-of-
        // sines field, so it keeps it. Only a system that has seen version 2 gets
        // the new default. Without this line every old project restyles itself on
        // open — the same class of change as an enum rename.
        pattern: pick(turb.pattern, PARTICLE_TURBULENCE_PATTERNS,
          legacy ? 'smooth' : D.forces.turbulence.pattern),
        complexity: Math.round(num(turb.complexity, D.forces.turbulence.complexity, 1, 6)),
        direction: num(turb.direction, D.forces.turbulence.direction, 0, 360),
      },
      vortex: {
        strength: num(vort.strength, D.forces.vortex.strength, 0, 20000),
        scale: num(vort.scale, D.forces.vortex.scale, 1, 100000),
        mode: pick(vort.mode, PARTICLE_FIELD_MODES, D.forces.vortex.mode),
        axis: pick(vort.axis, PARTICLE_FIELD_AXES, D.forces.vortex.axis),
        lift: num(vort.lift, D.forces.vortex.lift, 0, 4),
      },
      fluid: sanitizeFluid(forces.fluid, D.forces.fluid),
      draft: sanitizeDraft(forces.draft, D.forces.draft),
      return: { strength: num(forces.return?.strength, D.forces.return.strength, 0, 60) },
    },

    forceEmitters: sanitizeForceEmitters(raw.forceEmitters, compW),
    pathFollow: sanitizePathFollow(raw.pathFollow, D.pathFollow),
    collision: sanitizeCollision(raw.collision, D.collision),
    /*
     * The colliders past the first. Same sanitizer, so a second one gets Faces,
     * Follow, Open side and the rest without a second definition of any of them.
     * Entries with no artwork are dropped rather than kept as blank rows — the
     * same rule an object member follows.
     */
    colliders: (Array.isArray(raw.colliders) ? raw.colliders : [])
      .slice(0, PARTICLE_MAX_COLLIDERS - 1)
      .map((c) => sanitizeCollision(c, D.collision))
      .filter((c) => !!c.source),
    packing: sanitizePacking(raw.packing, D.packing),
    proximity: sanitizeProximity(raw.proximity, D.proximity, compW),

    activation: sanitizeActivation(raw.activation, D.activation),

    render: {
      // 'layers' falls back to the sprite while it has no objects; anything this
      // version does not know (a newer mode) reads as the sprite.
      mode: pick(render.mode, PARTICLE_RENDER_MODES, 'sprite'),
      lines: sanitizeLines(render.lines, D.render.lines),
      sprite: pick(render.sprite, PARTICLE_SPRITES, D.render.sprite),
      blend: pick(render.blend, PARTICLE_BLENDS, D.render.blend),
      opacity: num(render.opacity, D.render.opacity, 0, 1),
      size: {
        start: num(size.start, D.render.size.start, 0.1, 4000),
        end: num(size.end, D.render.size.end, 0.1, 4000),
        random: num(size.random, D.render.size.random, 0, 1),
      },
      colorOverLife: sanitizeRamp(render.colorOverLife, D.render.colorOverLife),
      // v1 stored `colorFrom: 'ramp' | 'source'`. 'ramp' is what is now called
      // 'age' — the same behaviour under a name that says what it reads.
      colorMode: pick(
        render.colorMode || (render.colorFrom === 'source' ? 'source' : render.colorFrom === 'ramp' ? 'age' : null),
        PARTICLE_COLOR_MODES, D.render.colorMode,
      ),
      colorSourceTime: pick(render.colorSourceTime, PARTICLE_COLOR_SOURCE_TIMES, D.render.colorSourceTime || 'live'),
      velocityRamp: sanitizeRamp(render.velocityRamp, D.render.velocityRamp),
      velocityRange: {
        min: num(render.velocityRange?.min, D.render.velocityRange.min, 0, 100000),
        max: Math.max(
          num(render.velocityRange?.min, D.render.velocityRange.min, 0, 100000) + 1,
          num(render.velocityRange?.max, D.render.velocityRange.max, 1, 100000),
        ),
      },
      twinkle: num(render.twinkle, D.render.twinkle, 0, 1),
      // 'Line draw' in the UI: how far a particle is smeared along its own
      // velocity. Was capped at 0.5 (a nudge); 4 lets it draw real streaks.
      stretch: num(render.stretch, D.render.stretch, 0, 4),
      onKill: {
        fade: num(render.onKill?.fade, D.render.onKill.fade, 0, 10),
        scale: num(render.onKill?.scale, D.render.onKill.scale, 0, 1),
      },
    },

    objects: sanitizeObjects(raw.objects, D.objects),

    quality: { previewFraction: num(quality.previewFraction, 1, 0.05, 1) },
  };
}

/**
 * Identity of the SIMULATION, for cache invalidation.
 *
 * Only inputs the solver actually reads go in. Appearance (sprite, ramp, blend,
 * twinkle, objects) is evaluated at draw time and must NOT rebake — that is what
 * makes recolouring, resizing and swapping objects instant.
 */
export function particleSimHash(system, duration, spawnKey = '', colliderKey = '', layerDriveKey = '', proxTrackKey = '', colliderKeys = []) {
  const s = system.solver;
  const e = system.emitters[0];
  const f = system.forces;
  const a = system.activation;
  const c = system.collision;
  const pk = system.packing;
  return JSON.stringify([
    system.schemaVersion, system.seed, Math.round(duration * 1000),
    // The artwork a 'layer' emitter fires from is a simulation input: change the
    // picture and every spawn position changes with it.
    spawnKey,
    s.maxParticles, s.preRoll, s.cacheHz, s.bounds.behavior, s.bounds.size,
    e.emit, e.shape, e.position, e.size, e.rate, e.bursts, e.start, e.end, e.lifetime, e.speed, e.direction, e.spread,
    // v3 emitter geometry and coupling — all read by the bake.
    e.ring, e.dirMode, e.path, e.variance, e.stir, e.detach,
    // Gating emission on the source layer's span is a simulation input; off it
    // contributes a literal 0, so a project that never asks for it is unchanged.
    e.followTimeline ? 1 : 0,
    // The sources past the first. A literal 0 while the list is empty, so an
    // emitter that fires from one layer hashes exactly as it always has.
    (e.sources || []).length
      ? e.sources.map((x) => [x.sourceName || '', x.fromItemId || '', x.size, x.position, x.followTimeline ? 1 : 0])
      : 0,
    /*
     * DISTRIBUTION contributes NOTHING while it is 'random', and this is not a
     * micro-optimisation — it is the difference between shipping this feature
     * and re-baking every particle system in every saved project the first time
     * one is opened. Mode 'random' returns the same three rnd() draws the
     * emitter always made, so the simulation genuinely has not changed and its
     * cache is genuinely still valid. Every other field in the block is inert
     * under 'random' (jitter, order and sites are only read by the set-based
     * modes), so folding them all to 0 is exact rather than approximate.
     */
    e.distribution && e.distribution.mode !== 'random' ? e.distribution : 0,
    f.gravity, f.wind, f.drag, f.turbulence, f.vortex,
    // The fluid field and everything that pushes it are simulation state.
    f.fluid, f.draft, system.forceEmitters, system.pathFollow,
    // A Layer Velocity source is driven by ANOTHER layer's animation, which
    // lives outside this system entirely: the sampled track rides in on its own
    // key, so moving a keyframe on the source layer re-bakes this one.
    layerDriveKey,
    // Collision: the SDF rides in on its own key (like the spawn table); the
    // rest of the block is geometry the bake reads.
    /*
     * Collision. The SDF rides in on its own key (like the spawn table); the
     * rest of the block is geometry the bake reads.
     *
     * A FOLLOWED collider takes its pose from another layer, which lives outside
     * this system entirely — so the sampled pose track rides in on
     * `colliderKey` the same way a Layer Velocity source does, and the stored
     * size/position/rotation become a fallback that still has to be hashed
     * (they are what a vanished source falls back to).
     */
    c ? [colliderKey, c.faces, c.bounce, c.depth, c.size, c.position,
      c.follow ? [1, c.rotation, c.pickScale] : 0,
      // A closed collider contributes a literal 0, so a project that never opens
      // one hashes exactly as it did before the option existed.
      c.open && c.open.side !== 'none' ? [c.open.side, c.open.spread, c.open.at, c.open.fade] : 0,
      // Off contributes a literal 0, so a container that captures as it always
      // has hashes exactly as it did before the option existed.
      c.releaseOutside ? 1 : 0] : 0,
    /*
     * The colliders past the first. A literal 0 while the list is empty, so a
     * project with one collider — which is every project written before this —
     * hashes exactly as it did.
     */
    (system.colliders || []).length
      ? system.colliders.map((x, i) => [
        colliderKeys[i] || '', x.faces, x.bounce, x.depth, x.size, x.position,
        x.follow ? [1, x.rotation, x.pickScale] : 0,
        x.open && x.open.side !== 'none' ? [x.open.side, x.open.spread, x.open.at, x.open.fade] : 0,
        x.releaseOutside ? 1 : 0,
      ])
      : 0,
    /*
     * PACKING, AND THE ONE REASON render.size APPEARS IN THIS FUNCTION AT ALL.
     *
     * Size is drawn, not simulated — that is what makes resizing a system
     * instant, and it is why it has never been in this hash. Packing breaks that
     * on purpose: a contact needs a radius, and the radius IS the drawn size, so
     * with packing on a size change is a genuine change of simulation.
     *
     * The gate is the same shape as `distribution` above. While `enabled` is
     * false the whole expression is a literal 0 — every packing field is inert,
     * size is invisible to the hash again, and resizing stays instant. So the
     * cost of this feature to a project that never turns it on is one `0`.
     *
     * `render.size.random` is in here with start/end because the per-particle
     * multiplier is srnd(seed, uid, 21) * random and it scales every radius.
     */
    pk && pk.enabled
      ? [
        pk,
        // A LAYER-OBJECTS system draws objects.size, not render.size, so that is
        // the field the radius comes from and the field that must re-bake. Both
        // are listed rather than branching: the inactive one is a constant that
        // nothing reads, and a branch here would mean two hash shapes for one
        // feature.
        system.render.mode,
        system.render.size.start, system.render.size.end, system.render.size.random,
        system.objects.size, system.objects.sizeRandom,
        (system.objects.members || []).map((m) => [m?.included !== false, m?.weight ?? 1, m?.sizeScale ?? 1]),
        /*
         * OBJECT SHAPE MODE makes three more look fields geometry: which member
         * a particle is (the pick order), how fast it is born spinning, and
         * whether the artwork keeps its aspect (the clump is built at the drawn
         * aspect). The artwork itself rides in on the clumps' key, beside the
         * collider's. A literal 0 in circle mode, so nothing else changes there.
         */
        pk.shape === 'object'
          ? [system.objects.pick, system.objects.spin, system.objects.keepRatio,
            (system.objects.members || []).map((m) => m?.spinScale ?? 1)]
          : 0,
      ]
      : 0,
    // Activation decides WHEN each particle exists, so it is a simulation input
    // — but only the parts the bake reads. `ignite` and `igniteBoost` are drawn,
    // not simulated, and must stay out or every flare tweak would re-bake.
    a ? [a.mode, a.inactive, a.start, a.speed, a.reverse, a.softness] : 0,
    // The arrival field itself rides in on the spawn key (see growFieldKey), so
    // the seeds, speed map and bridges do not need repeating here.
    /*
     * PROXIMITY: ONLY THE HALF THE SOLVER READS.
     *
     * The look targets (size, opacity, colour, brightness, rotation, stretch,
     * twinkle) are evaluated at draw time and MUST stay out of this, or every
     * tint tweak would re-simulate — the same rule that keeps `ignite` out of
     * the activation entry above. `proximityDrivesMotion` is the gate, so a
     * look-only effector contributes a literal 0 and a project that has never
     * enabled one hashes exactly as it did at version 3.
     *
     * The FIELD does not appear here at all: it is baked from the artwork, and
     * the artwork already rides in on `proxTrackKey` through the source list.
     * What does appear is the sampled pose track, so animating a source layer
     * re-bakes this system — the same contract as a Layer Velocity source.
     *
     * The gate reads `proxTrackKey` FIRST because the caller has already decided
     * — it built a track — and its answer accounts for `px:` keyframes, which a
     * look at the stored numbers alone cannot: an Attract parked at 0 and keyed
     * up on the beat reaches the solver and must reach this hash with it.
     */
    /*
     * ...WITH ONE EXCEPTION ONCE PACKING IS ON: the SIZE target.
     *
     * It is drawn everywhere else, which is exactly why it is excluded above.
     * With packing on it decides how big a CONTACT is, so an effector that
     * swells the cloud has to re-bake it — the same trade `render.size` already
     * makes. Only `size`: nothing else the effector drives can change what a
     * circle collides with.
     */
    (proxTrackKey || proximityDrivesMotion(system.proximity)
      || proximityFeedsPacking(system))
      ? [
        proxTrackKey,
        system.proximity.measure, system.proximity.range, system.proximity.falloff,
        system.proximity.shape, system.proximity.combine, system.proximity.depth,
        system.proximity.invert,
        PARTICLE_PROX_MOTION_KEYS.map((k) => system.proximity.fx[k] ?? 0),
        // Only while packing reads it as a radius; 0 otherwise, so a look-only
        // effector on a system without packing hashes exactly as it always has.
        system.packing?.enabled ? (system.proximity.fx?.size ?? 0) : 0,
      ]
      : 0,
    /*
     * ROWS and RETURN. Each a literal 0 unless it is in use: the grid only means
     * something for a rows emitter, and Return at 0 is the solver exactly as it
     * was. (render.lines never appears: lines are drawn, not simulated.)
     */
    e.shape === 'rows' && e.rows ? [e.rows.count, e.rows.points] : 0,
    f.return && f.return.strength > 0 ? f.return.strength : 0,
  ]);
}
