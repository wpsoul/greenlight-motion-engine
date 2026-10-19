import * as THREE from 'three';
import { MASK_KF_PREFIX } from './keyframeProps.js';
import {
  sanitizeShapePathPoints,
  buildShapePathPreset,
  buildPathOutline,
  buildOffsetStrokePath,
  SHAPE_PATH_PRESETS,
  decodeShapePathValue,
  encodeShapePathValue,
  roundKeyPosition,
} from './shapePath.js';

/*
 * Layer Mask — one or more animatable vector masks that cut a layer's OWN pixels.
 *
 * See PLANS/LAYER_MASK_PLAN.md. Look-dev truth: html/finished/layer-mask-lab.html
 * (every constant and every composite operation here was proved there first).
 *
 * A mask is a bezier path in UNIT-BOX space — byte-identical in shape to
 * item.shapePath — so every helper in shapePath.js applies verbatim. The stack
 * rides a typed Layer Effect (item.layerEffects[], id 'layerMask') with the mask
 * list top-level on the entry: the rigPins / autoFill.points precedent.
 *
 *   item.layerEffects[] → { id:'layerMask', eid, enabled,
 *                           params:{ mskAmount, mskQuality },
 *                           masks:[ { mid, mode, path, x,y,w,h,rot,
 *                                     feather, expand, opacity, grow, … } ] }
 *
 *   item.propertyKeyframes → 'msk:<mid>:x' … 'msk:<mid>:grow'   numeric
 *                            'msk:<mid>:path'                   NON-SCALAR
 *                            'mskAmount'                        static registry
 *
 * FREE — deliberately no PRO gate, no containsPro* walker, nothing in
 * handleRenderInBackground. `MASK_IS_PRO` exists so that decision is stated in
 * code rather than implied by an absence.
 *
 * ── Units are load-bearing ─────────────────────────────────────────────────
 * x/y/w/h are PERCENT OF THE LAYER BOX (not px, not raw unit-box fractions) so
 * the mask rides layer resize/zoom/parenting for free AND so the stored field,
 * the track value and the panel number are the SAME NUMBER. The panel
 * stopwatch's promote() writes String(current) into a constant track; a unit
 * mismatch there silently teleports the mask the instant it is keyed.
 * MASK_KF_CHAN_META is the single authority, and sanitizeLayerMask clamps to
 * exactly the same min/max the tracks clamp to.
 *
 * feather / expand / grow are COMPOSITION px (the borderRadius / shadows
 * convention, not the authored-@1080 convention of glowRadius) — a mask edge is
 * a hard geometric statement about the final frame. This is a DELIBERATE
 * divergence from AE, which feathers in layer px so scaling a layer scales its
 * feather. Every other px field in this editor is comp-referenced; we follow
 * the editor.
 *
 * A mask is ALPHA ONLY. There is no colour channel and no `mskc:` namespace.
 */

export const LAYER_MASK_EFFECT_ID = 'layerMask';

// FREE. Not a placeholder — see the header. Nothing reads this to gate a render.
export const MASK_IS_PRO = false;

export const MASK_MAX = 16;

// Per-mask geometry is authored, not generated: past a couple of dozen anchors a
// mask is a traced silhouette and belongs in a shape layer.
const MAX_MASK_POINTS = 128;

export const MASK_DEFAULTS = {
  mskAmount: 100,
  mskQuality: 0,
};

export const MASK_NUMBER_FIELDS = [
  { key: 'mskAmount', label: 'Amount', min: 0, max: 100, step: 1, suffix: '%', kf: true },
];

export const MASK_ENUM_FIELDS = [
  {
    key: 'mskQuality',
    label: 'Feather quality',
    options: [[0, 'Fast'], [1, 'High']],
  },
];

// ── Combine table ───────────────────────────────────────────────────────────
// AE math ⇄ native canvas composite operation. EXACT matches, not
// approximations — the single strongest argument for rasterizing coverage on the
// CPU rather than solving winding on the GPU.
export const MASK_MODES = ['add', 'subtract', 'intersect', 'difference'];

/*
 * A mask draws its coverage either from its PATH (the default, everything the
 * pen editor and the presets make) or from a baked per-frame RASTER MATTE —
 * what RotoScope writes when the user asks for a matte instead of a contour.
 *
 * A matte mask still carries a real path: the traced outline of its first
 * frame. It is what the pen editor, the panel and every existing consumer see,
 * and it is what coverage falls back to if the matte file cannot be decoded —
 * a mask that degrades to a rough outline is far better than one that vanishes.
 *
 * `matte` is { url, w, h, fps, frames, t0 } — t0 being the SOURCE second of the
 * matte's frame 0, so a mask on a trimmed / speed-ramped clip still lands on
 * the right frame. Expand and Grow do not apply to a matte (they are offsets of
 * a contour, and a matte has no contour); Feather, Invert, Opacity and the
 * mode fold all work exactly as they do for a path.
 */
export const MASK_KIND_MATTE = 'matte';

export function isMatteMask(mask) {
  return mask?.kind === MASK_KIND_MATTE && !!mask?.matte?.url;
}

export function sanitizeMaskMatte(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = typeof raw.url === 'string' ? raw.url.slice(0, 2048) : '';
  if (!url) return null;
  const pos = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    url,
    w: Math.round(pos(raw.w, 2)),
    h: Math.round(pos(raw.h, 2)),
    fps: pos(raw.fps, 30),
    frames: Math.round(pos(raw.frames, 1)),
    t0: Number.isFinite(Number(raw.t0)) ? Number(raw.t0) : 0,
  };
}

export const MASK_MODE_LABELS = {
  add: 'Add',
  subtract: 'Subtract',
  intersect: 'Intersect',
  difference: 'Difference',
};

export const MASK_MODE_GCO = {
  add: 'lighter',                 // clamp(acc + m)
  subtract: 'destination-out',    // acc · (1 − m)
  intersect: 'destination-in',    // acc · m
  difference: 'xor',              // acc + m − 2·acc·m
};

// Identity dots only. The panel row itself stays neutral grey (project rule);
// this exists so a row and its outline on canvas are visibly the same mask.
export const MASK_COLORS = ['#e3c368', '#79c07a', '#dd9a55', '#d97a7a', '#7aa8ff', '#b06aff'];

export const MASK_KF_CHANNELS = ['x', 'y', 'w', 'h', 'rot', 'feather', 'expand', 'opacity', 'grow'];

export const MASK_PATH_CHAN = 'path';

/**
 * The single authority on every per-mask channel's unit and range.
 *
 * `neutral` is what an un-keyed channel falls back to when the mask entry itself
 * omits the field, and what a promoted track seeds from when there is nothing on
 * screen to read. min/max are enforced BOTH here (track clamping) and in
 * sanitizeLayerMask (stored fields) — they must never drift apart.
 */
export const MASK_KF_CHAN_META = {
  x: { label: 'X', unit: '%', min: -300, max: 300, step: 0.5, neutral: 0 },
  y: { label: 'Y', unit: '%', min: -300, max: 300, step: 0.5, neutral: 0 },
  w: { label: 'Width', unit: '%', min: 2, max: 400, step: 0.5, neutral: 100 },
  h: { label: 'Height', unit: '%', min: 2, max: 400, step: 0.5, neutral: 100 },
  rot: { label: 'Rotation', unit: 'deg', min: -1080, max: 1080, step: 1, neutral: 0 },
  feather: { label: 'Feather', unit: 'px', min: 0, max: 500, step: 1, neutral: 0 },
  expand: { label: 'Expand', unit: 'px', min: -500, max: 500, step: 1, neutral: 0 },
  opacity: { label: 'Opacity', unit: '%', min: 0, max: 100, step: 1, neutral: 100 },
  // A RATE, in composition px PER SECOND, added to Expand over the clip. The
  // Player INTEGRATES the track rather than multiplying it (see resolveLayerMaskParams)
  // so a keyed ramp accelerates the edge smoothly instead of teleporting it.
  grow: { label: 'Grow', unit: 'px/s', min: -10000, max: 10000, step: 1, neutral: 0 },
};

// The mask-shape picker offers the closed presets only — an open path has no
// interior to fill, so it would rasterize as nothing.
export const MASK_SHAPE_PRESETS = SHAPE_PATH_PRESETS;

const MID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const MASK_KF_RE = /^msk:([A-Za-z0-9_-]{1,24}):(x|y|w|h|rot|feather|expand|opacity|grow|path)$/;

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const clampNum = (v, fallback, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const clampChan = (chan, v, fallback) => {
  const meta = MASK_KF_CHAN_META[chan];
  return clampNum(v, fallback ?? meta.neutral, meta.min, meta.max);
};

// ── Track keys ──────────────────────────────────────────────────────────────

export function maskKfKey(mid, chan) {
  return `${MASK_KF_PREFIX}${mid}:${chan}`;
}

export function parseMaskKfKey(key) {
  if (typeof key !== 'string') return null;
  const m = MASK_KF_RE.exec(key);
  return m ? { mid: m[1], chan: m[2] } : null;
}

export function isMaskTrackKey(key) {
  return parseMaskKfKey(key) != null;
}

/** Every track key one mask can own — the delete path strips exactly these. */
export function maskTrackKeysFor(mid) {
  return [...MASK_KF_CHANNELS.map((c) => maskKfKey(mid, c)), maskKfKey(mid, MASK_PATH_CHAN)];
}

// ── Effect entry ────────────────────────────────────────────────────────────

export function getLayerMaskEffect(item) {
  const list = Array.isArray(item?.layerEffects) ? item.layerEffects : [];
  return list.find((effect) => effect?.id === LAYER_MASK_EFFECT_ID) || null;
}

export function getLayerMasks(item) {
  const effect = getLayerMaskEffect(item);
  return Array.isArray(effect?.masks) ? effect.masks : [];
}

/**
 * Active = enabled AND at least one enabled mask with a fillable outline.
 *
 * An empty stack must NOT force the extra isolate pass — adding the card and
 * then deleting every mask has to cost exactly nothing.
 */
export function isLayerMaskEnabled(item) {
  const effect = getLayerMaskEffect(item);
  if (!effect || effect.enabled === false) return false;
  const masks = Array.isArray(effect.masks) ? effect.masks : [];
  return masks.some((m) => m?.enabled !== false && (m?.path?.points?.length || 0) >= 3);
}

// ── Sanitizers ──────────────────────────────────────────────────────────────
// Autosave strips whatever isn't re-emitted here (the standing item-field
// whitelist hazard), so every mask field must be spelled out.

export function sanitizeLayerMask(raw, { mid: fallbackMid = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const mid = typeof raw.mid === 'string' && MID_RE.test(raw.mid) ? raw.mid : fallbackMid;
  if (!mid) return null;
  const points = sanitizeShapePathPoints(raw.path?.points).slice(0, MAX_MASK_POINTS);
  if (points.length < 3) return null;
  // Conditional spreads, so a path mask round-trips byte-identical to what it
  // was before matte masks existed.
  const matte = raw.kind === MASK_KIND_MATTE ? sanitizeMaskMatte(raw.matte) : null;
  return {
    mid,
    ...(matte ? { kind: MASK_KIND_MATTE, matte } : {}),
    name: typeof raw.name === 'string' && raw.name ? raw.name.slice(0, 40) : 'Mask',
    mode: MASK_MODES.includes(raw.mode) ? raw.mode : 'add',
    enabled: raw.enabled !== false,
    inverted: raw.inverted === true,
    // `closed` is structural and never keyframed (the shapePath.js:930 rule).
    // A mask always fills, so it is always closed — stored explicitly anyway so
    // the shape is byte-identical to item.shapePath.
    path: { points, closed: true },
    x: clampChan('x', raw.x),
    y: clampChan('y', raw.y),
    w: clampChan('w', raw.w),
    h: clampChan('h', raw.h),
    rot: clampChan('rot', raw.rot),
    feather: clampChan('feather', raw.feather),
    expand: clampChan('expand', raw.expand),
    opacity: clampChan('opacity', raw.opacity),
    grow: clampChan('grow', raw.grow),
  };
}

export function sanitizeLayerMasks(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const mask = sanitizeLayerMask(raw);
    if (!mask || seen.has(mask.mid)) continue;
    seen.add(mask.mid);
    out.push(mask);
    if (out.length >= MASK_MAX) break;
  }
  return out;
}

export function nextMaskId(masks) {
  let max = 0;
  for (const m of Array.isArray(masks) ? masks : []) {
    const hit = /^m(\d+)$/.exec(m?.mid || '');
    if (hit) max = Math.max(max, Number(hit[1]));
  }
  return `m${max + 1}`;
}

// A brand-new mask is deliberately SMALLER than the layer box: a 100% rectangle
// is a perfect no-op, so "add a mask" would look broken. The sanitizer's default
// for a missing w/h is still 100 (identity), because a stored mask that lost a
// field must not shrink on load.
const NEW_MASK_SIZE = 70;

export function makeLayerMask(presetId = 'circle', masks = [], overrides = {}) {
  const mid = nextMaskId(masks);
  const preset = buildShapePathPreset(presetId);
  return sanitizeLayerMask({
    mid,
    name: `Mask ${masks.length + 1}`,
    mode: 'add',
    enabled: true,
    inverted: false,
    path: { points: preset.points, closed: true },
    x: 0,
    y: 0,
    w: NEW_MASK_SIZE,
    h: NEW_MASK_SIZE,
    rot: 0,
    feather: 0,
    expand: 0,
    opacity: 100,
    grow: 0,
    ...overrides,
  }, { mid });
}

// ── Per-frame resolution ────────────────────────────────────────────────────

/**
 * Constant-rate fallback for `integrateRate`. Exactly the integral of a constant,
 * so it is CORRECT for every un-keyed Grow — which is why forgetting to pass the
 * real integrator only misbehaves once someone keys Grow.
 *
 * Callers that can see keyframes MUST pass `integratePathRate` from
 * gsapTransitions.js. It lives there, not here, because this module is a leaf
 * that `node --test` imports directly.
 */
const constantRate = (item, key, staticValue, localTime) => localTime * staticValue;

/**
 * The mask stack for one frame: stored fields with any keyframe track laid over
 * them, Grow integrated into Expand, everything clamped to MASK_KF_CHAN_META.
 *
 * `kfValues` is getItemKeyframeValues(item, progress) — numeric channels arrive
 * as numbers, `msk:<mid>:path` as an already-morphed point array.
 *
 * Returns null when the stack cuts nothing, so every caller can bypass on falsy.
 */
export function resolveLayerMaskParams(item, kfValues, {
  localTime = 0,
  duration = 0,
  integrateRate = constantRate,
} = {}) {
  const effect = getLayerMaskEffect(item);
  if (!effect || effect.enabled === false) return null;
  const stored = Array.isArray(effect.masks) ? effect.masks : [];
  const kf = kfValues || {};
  const params = effect.params || {};

  const amountRaw = Number.isFinite(kf.mskAmount)
    ? kf.mskAmount
    : num(params.mskAmount, MASK_DEFAULTS.mskAmount);
  const amount = Math.min(1, Math.max(0, amountRaw / 100));

  const masks = [];
  for (const mask of stored) {
    if (!mask || mask.enabled === false) continue;
    const mid = mask.mid;
    if (!mid) continue;

    const chan = (name) => {
      const v = kf[maskKfKey(mid, name)];
      const base = Number.isFinite(Number(mask[name])) ? Number(mask[name]) : MASK_KF_CHAN_META[name].neutral;
      return clampChan(name, Number.isFinite(v) ? v : base, base);
    };

    const keyed = kf[maskKfKey(mid, MASK_PATH_CHAN)];
    const points = Array.isArray(keyed) && keyed.length >= 3 ? keyed : mask.path?.points;
    if (!Array.isArray(points) || points.length < 3) continue;

    // Grow is a RATE: integrate the track, never sample-and-multiply. phase =
    // t·s(t) teleports by t·Δs the moment the rate changes; the integral
    // accelerates smoothly and stays a pure function of (track, localTime,
    // duration), so a cold-start range render lands on the same edge.
    const growPx = integrateRate(item, maskKfKey(mid, 'grow'), chan('grow'), localTime, duration);

    masks.push({
      mid,
      ...(isMatteMask(mask) ? { kind: MASK_KIND_MATTE, matte: mask.matte } : {}),
      mode: MASK_MODES.includes(mask.mode) ? mask.mode : 'add',
      inverted: mask.inverted === true,
      points,
      closed: true,
      x: chan('x'),
      y: chan('y'),
      w: chan('w'),
      h: chan('h'),
      rot: chan('rot'),
      feather: chan('feather'),
      opacity: chan('opacity') / 100,
      // Expand and Grow are the same quantity — one authored, one accumulated.
      offsetPx: chan('expand') + growPx,
    });
  }
  if (!masks.length) return null;
  return { amount, quality: num(params.mskQuality, MASK_DEFAULTS.mskQuality) === 1 ? 1 : 0, masks };
}

/**
 * Which mask does the fold start from?
 *
 * Left fold from an EMPTY base — but if the first enabled mask's mode is
 * subtract or intersect the base starts FULL instead, otherwise a lone Subtract
 * mask blanks the layer instead of cutting a hole out of it. A leading
 * `difference` is treated as `add` (xor against an empty base is a plain draw).
 *
 * Exported and unit-tested because it is the rule people get wrong.
 */
export function maskFoldStartsFull(masks) {
  const first = masks?.[0]?.mode;
  return first === 'subtract' || first === 'intersect';
}

/** The composite operation the i-th mask actually draws with, fold rule applied. */
export function maskFoldGco(masks, i) {
  const mode = masks[i]?.mode || 'add';
  if (i === 0 && !maskFoldStartsFull(masks)) return 'source-over';
  return MASK_MODE_GCO[mode] || 'source-over';
}

// ── Keyframe Builder rows ───────────────────────────────────────────────────

/**
 * KF_PROPS-shaped entries so the Keyframe Builder's row list, "Add Property"
 * dropdown, timeline pill and graph editor pick the mask tracks up like any
 * other property (the buildRigKfProps / buildMotionKfProps pattern).
 *
 * `kind: 'path'` marks the outline track non-scalar, which is what makes the
 * registry-driven Add-key and key-value rows in EditorPanel show a point count
 * instead of a number input — no extra edits needed at those two sites.
 */
export function buildLayerMaskKfProps(item) {
  const effect = getLayerMaskEffect(item);
  if (!effect) return [];
  const masks = Array.isArray(effect.masks) ? effect.masks : [];
  const out = [];
  for (const mask of masks) {
    const label = mask?.name || mask?.mid;
    for (const chan of MASK_KF_CHANNELS) {
      const meta = MASK_KF_CHAN_META[chan];
      out.push({
        label: maskKfKey(mask.mid, chan),
        group: 'Mask',
        displayLabel: `${label} · ${meta.label}`,
        placeholder: String(meta.neutral),
        unit: meta.unit,
        type: 'number',
        min: meta.min,
        max: meta.max,
        step: meta.step,
      });
    }
    out.push({
      label: maskKfKey(mask.mid, MASK_PATH_CHAN),
      group: 'Mask',
      displayLabel: `${label} · Path`,
      kind: 'path',
      placeholder: '',
      unit: '',
    });
  }
  return out;
}

// ── Numeric key writes ──────────────────────────────────────────────────────

/**
 * Insert-or-update one key at the playhead — PreviewTransformOverlay's
 * applyKeyframeUpdate contract: within tolerance = rewrite that key's value.
 *
 * Hoisted here from RigPinOverlay rather than copied a third time. `easing` is
 * passed in so this stays free of the types.js import (which would break the
 * node --test entry point).
 */
export function writeKeyAt(track, pct, tolerancePct, value, easing) {
  const keys = Array.isArray(track) ? [...track] : [];
  const idx = keys.findIndex((k) => Math.abs(num(k?.position) - pct) <= Math.max(0.001, tolerancePct || 0));
  if (idx >= 0) {
    keys[idx] = { ...keys[idx], value: String(value) };
    return keys;
  }
  keys.push({ position: roundKeyPosition(pct), value: String(value), easing });
  keys.sort((a, b) => num(a?.position) - num(b?.position));
  return keys;
}

/**
 * Keyframed-outline coercer for the project loader. coerceShapePathValue alone
 * has no count cap, so a >MAX_MASK_POINTS track would survive load while the
 * static path truncates — and the two then disagree in count, which
 * interpolateShapePaths resolves by silently truncating geometry.
 */
export function coerceMaskPathValue(value) {
  const points = decodeShapePathValue(value);
  return points ? encodeShapePathValue(points.slice(0, MAX_MASK_POINTS)) : '';
}

// ── Coverage rasterization ──────────────────────────────────────────────────
//
// A 2D canvas plate sized to the LAYER BOX, not to the frame.
//
// Frame-space rasterization would mean a canvas the size of the isolate — a
// 33 MB texSubImage every frame at 4K, paid even when the mask is completely
// static, because the layer moved. Layer-space decouples them: the plate depends
// only on mask geometry and layer SIZE, never on position or rotation, so a
// static mask on a flying layer rasterizes exactly once for the whole clip.
//
// The plate is deliberately NOT padded. The isolate is zero-alpha outside the
// layer quad, and eroding at the plate border is correct AE behaviour (a
// full-box rect mask with Expand −10 really does pull in from the edge).

// Chromium silently clamps very large blur radii, so cap feather in plate px.
const MAX_FEATHER_PLATE_PX = 250;

let rawCanvas = null;
let scratchCanvas = null;

function scratch(which, w, h) {
  let c = which === 'raw' ? rawCanvas : scratchCanvas;
  if (!c) {
    c = document.createElement('canvas');
    if (which === 'raw') rawCanvas = c; else scratchCanvas = c;
  }
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}

/**
 * The offset stroke radius in PLATE px — Expand+Grow measured against the plate,
 * bounded to the widest offset that can still change a pixel.
 *
 * Grow is a RATE, so on a long clip it legitimately reaches thousands of px.
 * Once every point of the plate is within r of the outline the plate is already
 * fully white (or, eroding, fully clear) and a wider stroke only costs more, so
 * the bound is exactly that distance: the farthest plate corner from the mask
 * centre plus the outline's own reach from that centre (its box half-diagonal,
 * which holds under any rotation). Bounding here also keeps maskGeomHash stable
 * once the mask saturates, so a still-accelerating Grow stops re-rasterizing a
 * plate that cannot change.
 */
export function maskOffsetPlatePx(mask, plateW, plateH, plateRef) {
  const r = mask.offsetPx * plateRef;
  if (!Number.isFinite(r)) return 0;
  const cx = plateW / 2 + plateW * (mask.x / 100);
  const cy = plateH / 2 + plateH * (mask.y / 100);
  const dx = Math.max(Math.abs(cx), Math.abs(plateW - cx));
  const dy = Math.max(Math.abs(cy), Math.abs(plateH - cy));
  const reach = Math.hypot(dx, dy)
    + Math.hypot(plateW * (mask.w / 100), plateH * (mask.h / 100)) / 2;
  return Math.max(-reach, Math.min(reach, r));
}

/**
 * One resolved mask → an alpha-only plate on the shared scratch canvas, with
 * Expand+Grow, Feather and Invert applied. Returns the canvas.
 *
 * `plateRef` converts composition px → plate px.
 */
function drawMaskPlate(mask, plateW, plateH, plateRef) {
  const raw = scratch('raw', plateW, plateH);
  const rc = raw.getContext('2d');
  rc.setTransform(1, 0, 0, 1, 0, 0);
  rc.globalCompositeOperation = 'source-over';
  rc.globalAlpha = 1;
  rc.clearRect(0, 0, plateW, plateH);

  const bw = plateW * (mask.w / 100);
  const bh = plateH * (mask.h / 100);
  const cx = plateW / 2 + plateW * (mask.x / 100);
  const cy = plateH / 2 + plateH * (mask.y / 100);
  const path = buildPathOutline(mask.points, true, 0, 0, bw, bh);
  if (!path) return null;

  rc.save();
  rc.translate(cx, cy);
  // Rotate the CONTEXT rather than the points: a rigid rotation keeps the offset
  // stroke's width uniform, where rotating a non-square box's points would skew it.
  rc.rotate((mask.rot * Math.PI) / 180);
  rc.fillStyle = '#fff';
  rc.fill(path);

  // Expand + Grow. A round-joined stroke of width 2r IS the Minkowski offset by
  // r — geometrically exact, and exactly what AE's Mask Expansion is. Separable
  // box morphology only approximates it, and staircases past ~24 taps.
  //
  // Stroked one capsule per flattened step, never on `path` itself: stroking the
  // outline hands Skia a self-intersecting offset contour, which folds through
  // itself and makes the mask SHRINK — then vanish — as Expand/Grow rises (see
  // buildOffsetStrokePath, which measures both failures). The fill above keeps
  // the exact curve; only the offset band needs the segments.
  const r = maskOffsetPlatePx(mask, plateW, plateH, plateRef);
  if (Math.abs(r) > 0.05) {
    const offsetPath = buildOffsetStrokePath(mask.points, true, 0, 0, bw, bh) || path;
    rc.lineJoin = 'round';
    rc.lineCap = 'round';
    rc.lineWidth = Math.abs(r) * 2;
    if (r > 0) {
      rc.strokeStyle = '#fff';
      rc.stroke(offsetPath);
    } else {
      rc.globalCompositeOperation = 'destination-out';
      rc.stroke(offsetPath);
    }
  }
  rc.restore();

  return finishMaskPlate(raw, mask, plateW, plateH, plateRef);
}

/*
 * Feather → Invert → out. Shared by the path plate and the matte plate: both
 * arrive as an alpha-only `raw` canvas and both composite mask DENSITY.
 */
function finishMaskPlate(raw, mask, plateW, plateH, plateRef) {
  const out = scratch('scratch', plateW, plateH);
  const sc = out.getContext('2d');
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.globalCompositeOperation = 'source-over';
  sc.globalAlpha = 1;
  sc.clearRect(0, 0, plateW, plateH);
  // Feather BEFORE the combine: AE composites mask DENSITY, not mask SHAPE.
  const featherPx = mask.feather * plateRef;
  const canFilter = 'filter' in sc;
  if (featherPx > 0.25 && !canFilter) {
    // iPad WebKit may not expose Canvas Filters. A white shadow is the same
    // blurred alpha plate: shadowBlur's Gaussian sigma is half its value.
    // Draw the sharp source outside the plate and offset only its shadow back
    // into place. This needs no pixel readback, extra canvas, or JS blur loop.
    // Restore before invert/fold, which must not cast shadows of their own.
    const sigma = Math.min(MAX_FEATHER_PLATE_PX, featherPx);
    const offset = plateW + Math.ceil(sigma * 3) + 1;
    sc.save();
    sc.shadowColor = '#fff';
    sc.shadowBlur = sigma * 2;
    sc.shadowOffsetX = offset;
    sc.shadowOffsetY = 0;
    sc.drawImage(raw, -offset, 0);
    sc.restore();
  } else {
    if (featherPx > 0.25) sc.filter = `blur(${Math.min(MAX_FEATHER_PLATE_PX, featherPx)}px)`;
    sc.drawImage(raw, 0, 0);
  }
  if (canFilter) sc.filter = 'none';

  // Invert AFTER feather, so the plate border stays full (1 − 0 = 1) instead of
  // smearing the outside-full region inward. `xor` against a full white rect is
  // exactly a + b − 2ab = 1 + m − 2m = 1 − m.
  if (mask.inverted) {
    sc.globalCompositeOperation = 'xor';
    sc.fillStyle = '#fff';
    sc.fillRect(0, 0, plateW, plateH);
    sc.globalCompositeOperation = 'source-over';
  }
  return out;
}

/*
 * Luma → alpha.
 *
 * The matte travels as a grayscale MP4 because no in-browser encoder carries an
 * alpha channel (rotoMatteEncode.js says why), but coverage is read from `.a`
 * (createLayerMaskMaterial samples texture2D(uMask, p).a). So each decoded
 * frame is lifted once — r into a, rgb to white — and cached until the decoder
 * moves the lane on. One readback of an analysis-resolution frame, not a
 * per-pixel cost on the plate.
 */
const matteAlphaCache = new Map();

function matteAlphaFrame(mid, source, stamp) {
  if (!source) return null;
  const sw = source.width | 0;
  const sh = source.height | 0;
  if (!(sw > 0 && sh > 0)) return null;
  let hit = matteAlphaCache.get(mid);
  if (!hit) {
    hit = { canvas: document.createElement('canvas'), stamp: null };
    matteAlphaCache.set(mid, hit);
    // The cache is per MASK, and a project can only hold MASK_MAX of them per
    // layer — but layers come and go, so bound it rather than trusting that.
    if (matteAlphaCache.size > 32) {
      const oldest = matteAlphaCache.keys().next().value;
      if (oldest !== mid) matteAlphaCache.delete(oldest);
    }
  }
  if (hit.stamp === stamp && hit.canvas.width === sw && hit.canvas.height === sh) return hit.canvas;
  if (hit.canvas.width !== sw || hit.canvas.height !== sh) { hit.canvas.width = sw; hit.canvas.height = sh; }
  const c = hit.canvas.getContext('2d', { willReadFrequently: true });
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.clearRect(0, 0, sw, sh);
  c.drawImage(source, 0, 0);
  const img = c.getImageData(0, 0, sw, sh);
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    px[i + 3] = px[i];
    px[i] = 255; px[i + 1] = 255; px[i + 2] = 255;
  }
  c.putImageData(img, 0, 0);
  hit.stamp = stamp;
  return hit.canvas;
}

/*
 * One resolved MATTE mask → the same alpha-only plate a path mask produces.
 *
 * The matte fills the mask box exactly as a path outline does, so a mask whose
 * box is the media's contain-fit rect lands on the pixels it was traced from
 * whatever the layer is doing. Expand/Grow are skipped: they are offsets of a
 * contour, and this mask has none.
 */
function drawMatteMaskPlate(mask, plateW, plateH, plateRef, frame) {
  const alpha = matteAlphaFrame(mask.mid, frame?.source, frame?.stamp);
  if (!alpha) return null;

  const raw = scratch('raw', plateW, plateH);
  const rc = raw.getContext('2d');
  rc.setTransform(1, 0, 0, 1, 0, 0);
  rc.globalCompositeOperation = 'source-over';
  rc.globalAlpha = 1;
  rc.clearRect(0, 0, plateW, plateH);

  const bw = plateW * (mask.w / 100);
  const bh = plateH * (mask.h / 100);
  rc.save();
  rc.translate(plateW / 2 + plateW * (mask.x / 100), plateH / 2 + plateH * (mask.y / 100));
  rc.rotate((mask.rot * Math.PI) / 180);
  rc.imageSmoothingQuality = 'high';
  rc.drawImage(alpha, -bw / 2, -bh / 2, bw, bh);
  rc.restore();

  return finishMaskPlate(raw, mask, plateW, plateH, plateRef);
}

/**
 * The whole stack → `ctx` (an alpha accumulation plate), left fold in array
 * order. The panel list order IS the semantic order: Intersect and Difference
 * are order-dependent, which is why the ▲/▼ buttons rewrite the array.
 *
 * Coverage lives in `.a`; rgb is left at 1 so the buffer stays debuggable.
 */
export function drawMaskCoverage(ctx, plateW, plateH, masks, plateRef, frameFor = null) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, plateW, plateH);
  if (!masks?.length) return;

  if (maskFoldStartsFull(masks)) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, plateW, plateH);
  }

  masks.forEach((mask, i) => {
    const gco = maskFoldGco(masks, i);
    ctx.globalCompositeOperation = gco;
    ctx.globalAlpha = Math.max(0, Math.min(1, mask.opacity));

    // A matte mask is a picture, so it never takes the fill fast path. When its
    // frame has not decoded yet (or the file is gone) it falls THROUGH to the
    // path branches below and draws its traced outline instead of nothing.
    if (isMatteMask(mask)) {
      const plate = drawMatteMaskPlate(mask, plateW, plateH, plateRef, frameFor?.(mask) || null);
      if (plate) {
        ctx.globalCompositeOperation = gco;
        ctx.globalAlpha = Math.max(0, Math.min(1, mask.opacity));
        ctx.drawImage(plate, 0, 0);
        return;
      }
    }

    // Fast path — the overwhelmingly common case. A hard-edged, un-inverted,
    // un-offset mask is ONE ctx.fill() straight into the accumulator: no
    // scratch canvas, no blur, no intermediate drawImage.
    //
    // The offset is what disqualifies it, not the cost: fill-then-stroke under
    // `destination-in` or `xor` would composite the two operations against each
    // other instead of against the accumulator. Those need a plate.
    if (mask.feather * plateRef <= 0.25 && !mask.inverted && Math.abs(mask.offsetPx * plateRef) <= 0.05) {
      const bw = plateW * (mask.w / 100);
      const bh = plateH * (mask.h / 100);
      const path = buildPathOutline(mask.points, true, 0, 0, bw, bh);
      if (path) {
        ctx.save();
        ctx.translate(plateW / 2 + plateW * (mask.x / 100), plateH / 2 + plateH * (mask.y / 100));
        ctx.rotate((mask.rot * Math.PI) / 180);
        ctx.fillStyle = '#fff';
        ctx.fill(path);
        ctx.restore();
      }
      return;
    }

    const plate = drawMaskPlate(mask, plateW, plateH, plateRef);
    if (!plate) return;
    ctx.globalCompositeOperation = gco;
    ctx.globalAlpha = Math.max(0, Math.min(1, mask.opacity));
    ctx.drawImage(plate, 0, 0);
  });
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

/**
 * Content hash of everything the raster depends on — the cache key that keeps a
 * static mask from re-rasterizing when the layer merely moves.
 *
 * djb2, in the pathFxCacheKey convention. Quantization is what makes it useful:
 * a slow Grow must not invalidate the plate every single frame, so the offset is
 * rounded to a quarter plate pixel. It hashes the BOUNDED offset (the plate
 * dimensions are arguments for that reason alone), so a Grow that has already
 * saturated the plate stops invalidating it however much further it runs.
 */
export function maskGeomHash(masks, plateRef, plateW, plateH, frameFor = null) {
  let h = 5381;
  const push = (s) => {
    const str = String(s);
    for (let i = 0; i < str.length; i += 1) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  };
  for (const m of masks) {
    push(m.mid); push(m.mode); push(m.inverted ? 1 : 0);
    // A matte mask re-rasters when its DECODED FRAME changes — the stamp is the
    // lane's drawn timestamp, so a stale frame keeps the plate it drew and the
    // arriving one replaces it. Without this the plate would cache the first
    // frame of the matte for the whole clip.
    if (isMatteMask(m)) { push(m.matte.url); push(frameFor?.(m)?.stamp ?? 'pending'); }
    push(Math.round(m.opacity * 1000));
    push(Math.round(m.x * 1000)); push(Math.round(m.y * 1000));
    push(Math.round(m.w * 1000)); push(Math.round(m.h * 1000));
    push(Math.round(m.rot * 1000));
    push(Math.round(m.feather * 20));
    // Quarter of a PLATE pixel, so the quantization tracks the raster's own
    // resolution rather than a composition-px constant.
    push(Math.round(maskOffsetPlatePx(m, plateW, plateH, plateRef) * 4));
    for (const p of m.points) {
      push(Math.round(p.x * 10000)); push(Math.round(p.y * 10000));
      push(Math.round((p.hIn?.x || 0) * 10000)); push(Math.round((p.hIn?.y || 0) * 10000));
      push(Math.round((p.hOut?.x || 0) * 10000)); push(Math.round((p.hOut?.y || 0) * 10000));
    }
  }
  return h.toString(36);
}

// ── The apply pass ──────────────────────────────────────────────────────────

const MASK_VERTEX = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Multiply the coverage plate into the layer isolate.
 *
 * No varyings — fragments derive uv from gl_FragCoord, the createMatteClipMaterial
 * convention. `uFxOrigin/uFxAxisX/uFxAxisY` are computeLayerBox's projected quad,
 * so frame uv resolves to the layer's own 0..1 box: the plate is sampled in the
 * space it was authored in, whatever the layer is doing on screen.
 */
export function createLayerMaskMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: MASK_VERTEX,
    fragmentShader: /* glsl */ `
precision highp float;
uniform sampler2D uTexture;
uniform sampler2D uMask;
uniform vec2 uResolution;
uniform vec2 uFxOrigin;
uniform vec2 uFxAxisX;
uniform vec2 uFxAxisY;
uniform mat3 uFxHom;      // fx box uv (p) -> frame uv, homogeneous (the plane's projective map)
uniform mat3 uFxHomInv;   // frame uv -> fx box uv, homogeneous
uniform float uAmount;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 src = texture2D(uTexture, uv);

  // frame uv -> layer-box 0..1 (EFFECT_PRELUDE's fxLocal(), inlined)
  // Through the layer plane's projective map (the affine frame cannot describe the
  // trapezoid a 3D tilt projects, and clipped the mask at the layer's near edge).
  vec3 hp = uFxHomInv * vec3(uv, 1.0);
  vec2 p = hp.z < 1e-6 ? vec2(-1e3) : hp.xy / hp.z;

  // Outside the plate there is NO mask data. Coverage is 0 there, not the
  // clamped edge texel — ClampToEdge would smear the border row across the
  // whole frame.
  float cov = (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0)
    ? 0.0
    : texture2D(uMask, p).a;

  // uAmount is a MIX toward "no mask", not a multiplier on coverage: at 0 the
  // layer is untouched (the effectAmount / glowAmount convention), at 1 the
  // mask cuts fully. Multiplying instead would make Amount 0 erase the layer.
  float m = clamp(mix(1.0, cov, clamp(uAmount, 0.0, 1.0)), 0.0, 1.0);

  // BOTH rgb and a scale by the SAME coverage. The isolate is PREMULTIPLIED; if
  // rgb kept its old value while alpha shrank, every feathered texel would
  // un-premultiply to near-white and the export flatten would resolve it as a
  // bright fringe — the hazard maskCompositeFragmentShader documents.
  gl_FragColor = vec4(src.rgb * m, src.a * m);
}
`,
    uniforms: {
      uTexture: { value: null },
      uMask: { value: null },
      uResolution: { value: new THREE.Vector2(1280, 720) },
      uFxOrigin: { value: new THREE.Vector2(0.5, 0.5) },
      uFxAxisX: { value: new THREE.Vector2(0.5, 0) },
      uFxAxisY: { value: new THREE.Vector2(0, 0.5) },
      uFxHom: { value: new THREE.Matrix3() },
      uFxHomInv: { value: new THREE.Matrix3() },
      uAmount: { value: 1 },
    },
    transparent: true,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

/**
 * Adjustment Mask: MIX the graded composite back toward the ungraded one by
 * mask coverage. An adjustment layer has no pixels of its own — its "plate" is
 * the whole below-stack, graded — so cutting alpha (createLayerMaskMaterial)
 * would punch through to the project background outside the mask instead of
 * revealing the original stack. Same box mapping and uAmount convention as the
 * cut pass (0 = mask off = graded everywhere); both inputs are premultiplied,
 * so the plain lerp is the correct composite.
 */
export function createAdjustmentMaskMixMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: MASK_VERTEX,
    fragmentShader: /* glsl */ `
precision highp float;
uniform sampler2D uTexture;
uniform sampler2D uSource;
uniform sampler2D uMask;
uniform vec2 uResolution;
uniform vec2 uFxOrigin;
uniform vec2 uFxAxisX;
uniform vec2 uFxAxisY;
uniform mat3 uFxHom;      // fx box uv (p) -> frame uv, homogeneous (the plane's projective map)
uniform mat3 uFxHomInv;   // frame uv -> fx box uv, homogeneous
uniform float uAmount;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 graded = texture2D(uTexture, uv);
  vec4 below = texture2D(uSource, uv);

  // frame uv -> layer-box 0..1 (EFFECT_PRELUDE's fxLocal(), inlined)
  // Through the layer plane's projective map (the affine frame cannot describe the
  // trapezoid a 3D tilt projects, and clipped the mask at the layer's near edge).
  vec3 hp = uFxHomInv * vec3(uv, 1.0);
  vec2 p = hp.z < 1e-6 ? vec2(-1e3) : hp.xy / hp.z;

  // Outside the plate there is NO mask data — coverage 0, so the pixel returns
  // to the ungraded stack (not the clamped edge texel).
  float cov = (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0)
    ? 0.0
    : texture2D(uMask, p).a;

  float m = clamp(mix(1.0, cov, clamp(uAmount, 0.0, 1.0)), 0.0, 1.0);
  gl_FragColor = mix(below, graded, m);
}
`,
    uniforms: {
      uTexture: { value: null },
      uSource: { value: null },
      uMask: { value: null },
      uResolution: { value: new THREE.Vector2(1280, 720) },
      uFxOrigin: { value: new THREE.Vector2(0.5, 0.5) },
      uFxAxisX: { value: new THREE.Vector2(0.5, 0) },
      uFxAxisY: { value: new THREE.Vector2(0, 0.5) },
      uFxHom: { value: new THREE.Matrix3() },
      uFxHomInv: { value: new THREE.Matrix3() },
      uAmount: { value: 1 },
    },
    transparent: true,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}
