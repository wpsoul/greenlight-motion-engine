// After Effects-style layer parenting for the Video Editor.
//
// A parent contributes ONLY its effective Position, Rotation and Scale (PRS) to a
// child. The relationship is non-destructive (the child keeps its own stored PRS
// and keyframe tracks) and is evaluated at render time from ABSOLUTE timeline
// time, so the inspector, the preview gizmos, playback, nested sequences and the
// WebCodecs export cannot disagree.
//
// This module is deliberately dependency-free (no three, no gsap, no React): the
// keyframe sampler is injected as a callback, which keeps every runtime consumer
// on one evaluator and lets the whole thing be unit-tested under plain `node
// --test` (see keyframeParenting.test.mjs).
//
// Canonical PRS is expressed in the Player's THREE space, so it can be written to
// a mesh unchanged:
//   px  +right      py  +UP (panel Y is negated)      pz  +toward camera
//   rx/ry/rz  radians, negated from the panel's degrees (matches applyMeshTransform)
//   sx/sy/sz  plain multipliers, mirror NOT included (mirror is a child appearance
//             setting applied after parenting)

import { resolveObjectMotionPath, textOnPathIsLive } from './objectMotionPath.js';
//
// A layer's `zoom` is one uniform number, and it is carried on ALL THREE scale axes
// here even though the rendered plane only uses x/y. That keeps every composed
// matrix a similarity transform, so a 3D-rotated parent still yields a clean
// rotation + uniform scale on decomposition instead of a sheared basis. The Player
// writes 1 into mesh.scale.z, exactly as it always has — a plane has no depth.
//
// `scaleX`/`scaleY` (panel: Scale X / Scale Y) are per-axis multipliers ON TOP of
// that uniform master, and they are the one thing that can make a layer's basis
// non-similar. They ride on x/y only — z keeps the uniform value, since a plane
// has no depth to stretch. Both default to 1, so a project that never touches
// them composes exactly as it did before.
//
// The honest limit: composing a non-uniformly scaled layer THROUGH a rotated
// parent is a shear, and a shear cannot be expressed as rotation + scale, so
// decomposeLinear returns the nearest one. Squash-and-stretch under a spinning
// parent is therefore approximate; every unrotated or uniformly scaled chain —
// which is nearly all of them — stays exact.

export const PARENTING_ADDITIVE = 'additive';
export const PARENTING_FULL_COPY = 'full-copy';
export const PARENTING_TYPES = [PARENTING_ADDITIVE, PARENTING_FULL_COPY];

export const PARENTING_TYPE_LABELS = {
  [PARENTING_ADDITIVE]: 'Additive',
  [PARENTING_FULL_COPY]: 'Full Copy',
};

// Base (static) item fields that make up PRS. Everything else on the item —
// opacity, mirror, filters, effects, colours, masks, content, timing — is
// explicitly NOT inherited.
export const PRS_BASE_FIELDS = [
  'panX', 'panY', 'panZ',
  'rotateX', 'rotateY', 'rotateZ', 'rotation',
  'zoom', 'scaleX', 'scaleY',
];

// Keyframe track keys that make up PRS. Used by the Full Copy locks in the
// inspector (these tracks become read-only) and by the motion-blur probe.
export const PRS_KF_PROPS = [
  'translateX', 'translateY', 'translateZ',
  'xPercent', 'yPercent',
  'rotate', 'rotateX', 'rotateY',
  'scale', 'scaleX', 'scaleY',
  // Path Progress belongs here too: a live motion path is the final authority on
  // local position (see localPrs), so animating it on a layer whose PRS is owned
  // by something else does nothing at all. Its offsets are the same story — they
  // only displace the position the path just claimed.
  'motionPathT',
  'motionPathOffsetX', 'motionPathOffsetY', 'motionPathOffsetZ',
  // The animated path itself (objectMotionPath.js MOTION_PATH_KF_KEY), same reason.
  'motionPathPoints',
];

const PRS_KF_PROP_SET = new Set(PRS_KF_PROPS);

export function isPrsKeyframeProp(prop) {
  return PRS_KF_PROP_SET.has(prop);
}

// Layer kinds that may take part in parenting, as parent or as child. Audio-only
// clips have no transform and camera clips pose every channel instead of drawing,
// so both are excluded (V1 non-goal). A null ('null', nullLayer.js) is a transform
// and nothing else — being a parent is what it is for. (A literal, not the
// constant: this file stays dependency-free for `node --test`.)
const PARENTABLE_MEDIA_TYPES = new Set([
  'image', 'video', 'text', 'shape', 'motion', 'sequence', 'grid', 'adjustment', 'null',
]);

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── Data model ───────────────────────────────────────────────────────────────

/**
 * Normalize an item's `keyframeParenting` field. Returns null for anything that
 * isn't a usable relationship, so callers can treat "no parenting" as falsy.
 * Unknown types normalize to Additive rather than dropping the relationship.
 */
export function normalizeParenting(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const parentItemId = typeof raw.parentItemId === 'string' ? raw.parentItemId.trim() : '';
  if (!parentItemId) return null;
  const type = raw.type === PARENTING_FULL_COPY ? PARENTING_FULL_COPY : PARENTING_ADDITIVE;
  return { parentItemId, type };
}

export function getParenting(item) {
  return normalizeParenting(item?.keyframeParenting);
}

export function isFullCopy(item) {
  return getParenting(item)?.type === PARENTING_FULL_COPY;
}

// ── Timeline indexing ────────────────────────────────────────────────────────

/**
 * Index every item at ONE editing level (top-level channels, or a sequence's inner
 * channels) by item id, with its timeline span and stack position.
 *
 * `layoutFor(channel)` returns that channel's getTimelineLayout() result. Passing
 * the layout in (rather than computing it) keeps this module free of speedUtils
 * and lets the Player reuse the layouts it already memoized per frame.
 */
export function buildParentIndex(channels, layoutFor, clipFor = null) {
  const byId = new Map();
  (channels || []).forEach((channel, channelIndex) => {
    if (!channel) return;
    const layout = layoutFor ? layoutFor(channel) : null;
    (channel.items || []).forEach((item, itemIndex) => {
      if (!item || typeof item.id !== 'string' || !item.id) return;
      const span = layout ? layout[itemIndex] : null;
      const startTime = span ? num(span.startTime) : 0;
      const endTime = span ? num(span.endTime) : 0;
      byId.set(item.id, {
        item,
        itemIndex,
        channelId: channel.id,
        channelIndex,
        channelName: typeof channel.name === 'string' ? channel.name : '',
        channelKind: channel.kind || null,
        channelVisible: channel.visible !== false,
        startTime,
        endTime,
        duration: Math.max(0, endTime - startTime),
        // The item's clip, where the caller has one: Motion Follow sizes the tracked
        // layer's box from it (videoPlate.js real size).
        clip: clipFor ? clipFor(item) || null : null,
      });
    });
  });
  return byId;
}

/**
 * Do two timeline spans share at least one rendered output frame?
 *
 * A frame-grid test rather than a duration epsilon: at the export FPS, frame N is
 * sampled at N/fps, so two clips overlap only when some sample time falls inside
 * both. `{ startTime, endTime }` in seconds.
 */
export function timelineSpansShareFrame(a, b, fps = 30) {
  if (!a || !b) return false;
  const rate = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : 30;
  const start = Math.max(num(a.startTime), num(b.startTime));
  const end = Math.min(num(a.endTime), num(b.endTime));
  if (!(end >= start)) return false;
  // Nudge by a hair so floating-point starts/ends that land exactly on a frame
  // boundary aren't excluded by a 1e-16 rounding error.
  const firstFrame = Math.ceil(start * rate - 1e-6);
  const lastFrame = Math.floor(end * rate + 1e-6);
  return firstFrame <= lastFrame;
}

/**
 * Would making `parentId` the parent of `childId` create a cycle? True when
 * `parentId` is `childId` itself or already a descendant of it.
 */
export function wouldCreateCycle(index, childId, parentId) {
  if (!childId || !parentId) return false;
  if (childId === parentId) return true;
  const seen = new Set();
  let cursor = parentId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const entry = index.get(cursor);
    const parenting = getParenting(entry?.item);
    if (!parenting) return false;
    if (parenting.parentItemId === childId) return true;
    cursor = parenting.parentItemId;
  }
  return false;
}

export function isParentableClip(clip, item) {
  if (!clip || !PARENTABLE_MEDIA_TYPES.has(clip.mediaType)) return false;
  // An unapplied AI Fill zone is a placeholder spacer, not a real layer.
  if (item && typeof item.aiFillZoneId === 'string' && item.aiFillZoneId) return false;
  return true;
}

/**
 * Eligible parents for `item`, at its own editing level.
 *
 * Options carry the clip name, channel name and timeline range so duplicate layer
 * names stay distinguishable, and are sorted by stack order (top channel first)
 * then start time. The item's CURRENT parent is always included — if the clips
 * were moved apart after parenting we surface it with `noOverlap` rather than
 * silently detaching a relationship the user built.
 */
export function collectParentCandidates({ index, item, clipsMap, fps = 30, clipNameFor = null }) {
  const out = [];
  if (!index || !item) return out;
  const childEntry = index.get(item.id);
  if (!childEntry) return out;
  const currentParentId = getParenting(item)?.parentItemId || null;

  for (const [id, entry] of index) {
    if (id === item.id) continue;
    const clip = clipsMap ? clipsMap.get(entry.item.clipId) : null;
    const isCurrent = id === currentParentId;
    if (!isCurrent) {
      if (!isParentableClip(clip, entry.item)) continue;
      if (wouldCreateCycle(index, item.id, id)) continue;
      if (!timelineSpansShareFrame(childEntry, entry, fps)) continue;
    }
    out.push({
      id,
      name: (clipNameFor ? clipNameFor(entry.item, clip) : clip?.name) || 'Layer',
      channelName: entry.channelName || 'Channel',
      channelIndex: entry.channelIndex,
      startTime: entry.startTime,
      endTime: entry.endTime,
      isCurrent,
      noOverlap: !timelineSpansShareFrame(childEntry, entry, fps),
    });
  }

  // Stack order is z-order: the last channel renders highest, so list top-down.
  out.sort((a, b) => (b.channelIndex - a.channelIndex) || (a.startTime - b.startTime));
  return out;
}

/**
 * Layers a ƒx Custom expression on `item` can reference — every layer that shares
 * at least one rendered frame with it, including itself (a property may read a
 * sibling property of its own layer).
 *
 * Looser than collectParentCandidates on purpose: reading a value creates no
 * transform relationship, so cycles and clip kind do not disqualify anything —
 * only overlap in time matters, because a layer that is never on screen at the
 * same moment has no value to read.
 *
 * Each option carries `props`: that layer's keyframed track names (what the
 * expression can meaningfully read), so the panel's snippet picker can offer
 * them directly.
 */
export function collectExpressionLayers({ index, item, clipsMap, fps = 30, clipNameFor = null }) {
  const out = [];
  if (!index || !item) return out;
  const selfEntry = index.get(item.id);
  if (!selfEntry) return out;

  const keyframedProps = (it) => {
    const tracks = it?.propertyKeyframes || {};
    return Object.keys(tracks).filter((key) => Array.isArray(tracks[key]) && tracks[key].length > 0).sort();
  };

  for (const [id, entry] of index) {
    if (id !== item.id && !timelineSpansShareFrame(selfEntry, entry, fps)) continue;
    const clip = clipsMap ? clipsMap.get(entry.item.clipId) : null;
    // A container layer (sequence / grid) hides a whole timeline an expression
    // can read into, so its animated inner layers are offered too.
    const inner = [];
    if (clip?.sequence?.channels) {
      const innerClips = new Map((clip.sequence.clips || []).map((c) => [c.id, c]));
      for (const channel of clip.sequence.channels) {
        for (const innerItem of channel.items || []) {
          const props = keyframedProps(innerItem);
          if (!props.length) continue;
          const innerClip = innerClips.get(innerItem.clipId);
          const name = (clipNameFor ? clipNameFor(innerItem, innerClip) : innerClip?.name) || 'Layer';
          if (inner.some((e) => e.name === name)) continue; // first wins, like the resolver
          inner.push({ name, props });
        }
      }
    }
    out.push({
      id,
      name: (clipNameFor ? clipNameFor(entry.item, clip) : clip?.name) || 'Layer',
      channelIndex: entry.channelIndex,
      isSelf: id === item.id,
      startTime: entry.startTime,
      endTime: entry.endTime,
      props: keyframedProps(entry.item),
      ...(inner.length ? { inner } : {}),
    });
  }

  out.sort((a, b) => (Number(b.isSelf) - Number(a.isSelf))
    || (b.channelIndex - a.channelIndex)
    || (a.startTime - b.startTime));
  return out;
}

// ── Canonical PRS ────────────────────────────────────────────────────────────

export function identityPrs() {
  return { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };
}

/**
 * The per-axis Scale X / Scale Y multipliers of ONE item — base field × its own
 * keyframe track — with neither the uniform Scale nor any parent contribution.
 *
 * Published separately because the 2D gizmo needs both halves apart: it draws a
 * box of sx × sy but a corner drag writes the UNIFORM Scale, so it has to divide
 * these back out of the resolved PRS to know what to write.
 */
export function localAxisScale(item, kf) {
  let x = num(item?.scaleX, 1);
  let y = num(item?.scaleY, 1);
  if (kf) {
    if (Number.isFinite(kf.scaleX)) x *= kf.scaleX;
    if (Number.isFinite(kf.scaleY)) y *= kf.scaleY;
  }
  return { x, y };
}

// ── Transform origin: the pivot ──────────────────────────────────────────────
//
// `keyframeTransformOrigin` (the keyframe panel's Origin: 'center', 'top', 'bottom left', …, or CSS-style
// 'x% y%') is the point of the layer that Rotate X / Y / Z and the keyframed Scale turn and grow about — static
// and keyed values alike, in 3D as in 2D, exactly as the panel's preview has always shown it. Position keeps its
// meaning: Pan X / Y / Z place the layer's CENTRE as it rests unrotated, and the static Scale sizes the layer about
// that centre. So a card with Origin 'bottom' and Rotate X −90 stands up on the line its bottom edge lay on.
//
// The pivot sits on the layer's own box: the drawn plate for a shape, picture, SVG or html page, the laid-out
// block for text (whose plate is wider than its words). The render publishes that box per item each frame
// (setLayerPivotBox, before it poses the layer); until it has, the frame is the box.
const ORIGIN_WORDS = { left: [-0.5, null], right: [0.5, null], top: [null, 0.5], bottom: [null, -0.5], center: [null, null] };
const originCache = new Map();
// → { ox, oy } in −0.5…0.5 of the box (y UP), or null for the centre (no pivot shift: the old behaviour exactly).
export function parseTransformOrigin(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (!key || key === 'center' || key === 'centre' || key === 'center center') return null;
  if (originCache.has(key)) return originCache.get(key);
  let ox = 0;
  let oy = 0;
  const parts = key.split(/\s+/).slice(0, 2);
  parts.forEach((part, k) => {
    const word = ORIGIN_WORDS[part === 'centre' ? 'center' : part];
    if (word) {
      if (word[0] !== null) ox = word[0];
      if (word[1] !== null) oy = word[1];
      return;
    }
    const pct = /^(-?[\d.]+)%$/.exec(part);
    if (pct && Number.isFinite(Number(pct[1]))) {
      // CSS order: the first percentage is x, the second y (y down).
      if (k === 0) ox = Number(pct[1]) / 100 - 0.5; else oy = 0.5 - Number(pct[1]) / 100;
    }
  });
  const out = ox === 0 && oy === 0 ? null : { ox, oy };
  if (originCache.size > 64) originCache.clear();
  originCache.set(key, out);
  return out;
}

const pivotBoxes = new Map();
// box = { w, h, cx, cy }: the layer's box in composition px at Scale 1, its centre relative to the plate centre
// (y up). Called by the render for every layer it poses.
export function setLayerPivotBox(itemId, box) {
  if (!itemId || !box || !(box.w > 0) || !(box.h > 0)) return;
  pivotBoxes.set(itemId, { w: box.w, h: box.h, cx: num(box.cx), cy: num(box.cy) });
}
export function getLayerPivotBox(itemId) {
  return pivotBoxes.get(itemId) || null;
}

// Move `prs` so the origin point stays where it is when the layer turns (and grows by its keyed Scale):
// p += o − R·Sk·o, o = the pivot's offset from the layer centre at the static Scale.
function applyPivot(prs, item, kf, W, H) {
  const origin = parseTransformOrigin(item.keyframeTransformOrigin);
  if (!origin) return prs;
  const box = pivotBoxes.get(item.id) || { w: W, h: H, cx: 0, cy: 0 };
  const zoom = num(item.zoom, 1);
  const bx = zoom * num(item.scaleX, 1);
  const by = zoom * num(item.scaleY, 1);
  const ox = (box.cx + origin.ox * box.w) * bx;
  const oy = (box.cy + origin.oy * box.h) * by;
  // The keyed part of the scale (the static part already sizes the box above).
  const kx = Math.abs(bx) > 1e-9 ? prs.sx / bx : 1;
  const ky = Math.abs(by) > 1e-9 ? prs.sy / by : 1;
  const m = prsLinear({ rx: prs.rx, ry: prs.ry, rz: prs.rz, sx: kx, sy: ky, sz: 1 });
  const t = transform3(m, ox, oy, 0);
  return { ...prs, px: prs.px + ox - t.x, py: prs.py + oy - t.y, pz: prs.pz - t.z };
}

/**
 * An item's own effective PRS at one moment — base fields plus its keyframed PRS
 * values — in canonical (THREE-space) form. Mirror is deliberately excluded.
 *
 * The arithmetic (and every sign) mirrors applyMeshTransform in Player.jsx: that
 * is the definition of where a layer sits, and an unparented layer must resolve to
 * byte-identical numbers through this path.
 *
 * A layer with a Transform origin turns about it (applyPivot above).
 */
export function localPrs(item, kf, W, H) {
  if (!item) return identityPrs();
  const prs = ownPrs(item, kf, W, H);
  return item.keyframeTransformOrigin ? applyPivot(prs, item, kf, num(W, 1920), num(H, 1080)) : prs;
}

function ownPrs(item, kf, W, H) {
  if (!item) return identityPrs();
  const width = num(W, 1920);
  const height = num(H, 1080);

  let px = (num(item.panX) / 100) * width;
  let py = -(num(item.panY) / 100) * height;
  let pz = num(item.panZ);

  let rotXDeg = num(item.rotateX);
  let rotYDeg = num(item.rotateY);
  let rotZDeg = Number.isFinite(Number(item.rotateZ)) ? Number(item.rotateZ) : num(item.rotation);

  let scale = num(item.zoom, 1);
  // Per-axis Scale X/Y, applied on top of the uniform master (see the header note
  // on what non-uniform scale costs when a rotated parent is in the chain).
  const axis = localAxisScale(item, kf);

  if (kf) {
    if (Number.isFinite(kf.translateX)) px += kf.translateX;
    if (Number.isFinite(kf.xPercent)) px += (kf.xPercent / 100) * width;
    if (Number.isFinite(kf.translateY)) py -= kf.translateY;
    if (Number.isFinite(kf.yPercent)) py -= (kf.yPercent / 100) * height;
    if (Number.isFinite(kf.translateZ)) pz += kf.translateZ;
    if (Number.isFinite(kf.rotateX)) rotXDeg += kf.rotateX;
    if (Number.isFinite(kf.rotateY)) rotYDeg += kf.rotateY;
    if (Number.isFinite(kf.rotate)) rotZDeg += kf.rotate;
    if (Number.isFinite(kf.scale)) scale *= kf.scale;
  }

  // A live motion path is the final authority on local position. Positional base
  // fields and tracks stay stored (turning Follow Path off restores them), but do
  // not contribute while the path is live. Along Path similarly owns orientation;
  // Free leaves all rotation fields/tracks intact.
  // Text on Path hands the curve to the glyph run inside the text canvas — the
  // quad must stay put, or the path would apply twice.
  const pathPose = textOnPathIsLive(item) ? null : resolveObjectMotionPath(item, kf);
  if (pathPose) {
    px = pathPose.position.x;
    py = pathPose.position.y;
    pz = pathPose.position.z;
    if (pathPose.rotation) {
      return {
        px, py, pz,
        rx: pathPose.rotation.rx,
        ry: pathPose.rotation.ry,
        rz: pathPose.rotation.rz,
        sx: scale * axis.x, sy: scale * axis.y, sz: scale,
      };
    }
  }

  return {
    px, py, pz,
    rx: -rotXDeg * DEG2RAD,
    ry: -rotYDeg * DEG2RAD,
    rz: -rotZDeg * DEG2RAD,
    sx: scale * axis.x, sy: scale * axis.y, sz: scale,
  };
}

// ── Matrix composition ───────────────────────────────────────────────────────
// Column-major 3×3 linear part (rotation ∘ scale) + a translation vector, i.e. the
// affine a 4×4 would carry. Composition MUST be matrix-based: rotating or scaling
// a parent has to move the child's positional offset too, which adding component
// values would not do.

function prsLinear(p) {
  const cx = Math.cos(p.rx), sx = Math.sin(p.rx);
  const cy = Math.cos(p.ry), sy = Math.sin(p.ry);
  const cz = Math.cos(p.rz), sz = Math.sin(p.rz);
  // R = Rx · Ry · Rz — THREE's default Euler order ('XYZ'), so a decomposed result
  // can be written straight to mesh.rotation.
  const m = [
    cy * cz, sx * sy * cz + cx * sz, -cx * sy * cz + sx * sz,
    -cy * sz, -sx * sy * sz + cx * cz, cx * sy * sz + sx * cz,
    sy, -sx * cy, cx * cy,
  ];
  m[0] *= p.sx; m[1] *= p.sx; m[2] *= p.sx;
  m[3] *= p.sy; m[4] *= p.sy; m[5] *= p.sy;
  m[6] *= p.sz; m[7] *= p.sz; m[8] *= p.sz;
  return m;
}

function multiply3(a, b) {
  const out = new Array(9);
  for (let col = 0; col < 3; col += 1) {
    for (let row = 0; row < 3; row += 1) {
      out[col * 3 + row] =
        a[row] * b[col * 3] +
        a[3 + row] * b[col * 3 + 1] +
        a[6 + row] * b[col * 3 + 2];
    }
  }
  return out;
}

function transform3(m, x, y, z) {
  return {
    x: m[0] * x + m[3] * y + m[6] * z,
    y: m[1] * x + m[4] * y + m[7] * z,
    z: m[2] * x + m[5] * y + m[8] * z,
  };
}

// Linear part → scale + Euler XYZ, matching THREE.Matrix4.decompose +
// Euler.setFromRotationMatrix('XYZ') so preview and export agree exactly.
function decomposeLinear(m) {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[3], m[4], m[5]);
  const sz = Math.hypot(m[6], m[7], m[8]);
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[3] * (m[1] * m[8] - m[2] * m[7]) +
    m[6] * (m[1] * m[5] - m[2] * m[4]);
  if (det < 0) sx = -sx;

  const ix = Math.abs(sx) > 1e-9 ? 1 / sx : 0;
  const iy = sy > 1e-9 ? 1 / sy : 0;
  const iz = sz > 1e-9 ? 1 / sz : 0;
  const r = [
    m[0] * ix, m[1] * ix, m[2] * ix,
    m[3] * iy, m[4] * iy, m[5] * iy,
    m[6] * iz, m[7] * iz, m[8] * iz,
  ];

  // Row/col in the maths below is 0-indexed: r[col * 3 + row].
  const m02 = Math.max(-1, Math.min(1, r[6]));
  const ry = Math.asin(m02);
  let rx;
  let rz;
  if (Math.abs(m02) < 0.9999999) {
    rx = Math.atan2(-r[7], r[8]);
    rz = Math.atan2(-r[3], r[0]);
  } else {
    rx = Math.atan2(r[5], r[4]);
    rz = 0;
  }
  return { rx, ry, rz, sx, sy, sz };
}

/**
 * Compose a parent's effective PRS with a child's LOCAL PRS (Additive mode):
 * world = parent ∘ child.
 */
export function composePrs(parent, child) {
  if (!parent) return child;
  if (!child) return parent;
  const pm = prsLinear(parent);
  const cm = prsLinear(child);
  const linear = multiply3(pm, cm);
  const offset = transform3(pm, child.px, child.py, child.pz);
  const { rx, ry, rz, sx, sy, sz } = decomposeLinear(linear);
  return {
    px: parent.px + offset.x,
    py: parent.py + offset.y,
    pz: parent.pz + offset.z,
    rx, ry, rz, sx, sy, sz,
  };
}

/**
 * Turn a WORLD-space translation delta into the child's own local space.
 *
 * Direct manipulation happens in world space (the user drags where the layer is
 * drawn) but writes the child's LOCAL position, so the parent's contribution has
 * to be undone first. The linear part is treated as R·s and inverted as Rᵀ/s,
 * which is exact for the uniform case — a parent carrying Scale X ≠ Scale Y makes
 * the drag track the cursor slightly loosely on one axis, the same approximation
 * the 2D gizmo already accepts for a parent tilted in X/Y.
 */
export function worldDeltaToLocal(parentPrs, dx, dy, dz = 0) {
  if (!parentPrs) return { x: dx, y: dy, z: dz };
  const s = Math.abs(parentPrs.sx) > 1e-9 ? parentPrs.sx : 1;
  const m = prsLinear({ ...parentPrs, sx: 1, sy: 1, sz: 1 }); // rotation only
  // Rᵀ · d  —  transpose means reading the matrix's ROWS as the basis.
  return {
    x: (m[0] * dx + m[1] * dy + m[2] * dz) / s,
    y: (m[3] * dx + m[4] * dy + m[5] * dz) / s,
    z: (m[6] * dx + m[7] * dy + m[8] * dz) / s,
  };
}

/** Apply a resolved parent to a child's local PRS according to the mode. */
export function applyParenting(parentPrs, childLocal, type) {
  if (!parentPrs) return childLocal;
  return type === PARENTING_FULL_COPY ? { ...parentPrs } : composePrs(parentPrs, childLocal);
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Progress (0–1) of ABSOLUTE timeline time `t` inside an indexed span. Outside the
 * span the first/last value is held, which is what aligns parents and children
 * with different starts, durations and trims.
 */
export function progressAt(entry, t) {
  if (!entry) return 0;
  if (!(entry.duration > 0)) return t < entry.startTime ? 0 : 1;
  return clamp01((t - entry.startTime) / entry.duration);
}

/**
 * The fully resolved (parent-inclusive) PRS of one indexed item at absolute time
 * `t`. `ctx` = { W, H, evalKeyframes(item, progress) }.
 *
 * `visited` guards against cycles that sanitization missed (hand-edited or
 * agent-authored JSON) — a repeat visit resolves to the item's own local PRS
 * instead of recursing forever.
 */
export function resolveItemPrs(index, itemId, t, ctx, visited = new Set()) {
  const entry = index?.get(itemId);
  if (!entry) return null;
  if (visited.has(itemId)) return null;
  visited.add(itemId);

  const kf = ctx?.evalKeyframes ? ctx.evalKeyframes(entry.item, progressAt(entry, t)) : null;
  const local = localPrs(entry.item, kf, ctx?.W, ctx?.H);
  const parenting = getParenting(entry.item);
  if (!parenting) return local;
  const parentPrs = resolveItemPrs(index, parenting.parentItemId, t, ctx, visited);
  if (!parentPrs) return local;
  return applyParenting(parentPrs, local, parenting.type);
}

/**
 * What a render path needs for ONE child: the resolved parent PRS plus the mode,
 * or null when the item is unparented (or its parent is missing at this level).
 *
 * Render paths keep computing the child's own keyframe values as they do today —
 * only PRS is inherited, so opacity, filters, effects, colours and shape paths all
 * stay on the child's ordinary evaluation path.
 */
export function resolveParentTransform(index, item, t, ctx) {
  const parenting = getParenting(item);
  if (!parenting || !index) return null;
  const prs = resolveItemPrs(index, parenting.parentItemId, t, ctx, new Set([item.id]));
  if (!prs) return null;
  return { prs, type: parenting.type };
}

// ── 2D helpers for the preview gizmo ─────────────────────────────────────────

/** Canonical PRS → the frame-space centre the 2D overlay works in. */
export function prsToFrameCenter(prs, W, H) {
  return { cx: num(W) / 2 + prs.px, cy: num(H) / 2 - prs.py };
}

/** Canonical PRS → the panel's clockwise-positive Z rotation, in degrees. */
export function prsRotationZDeg(prs) {
  return -prs.rz * RAD2DEG;
}

/** Canonical PRS → the horizontal scale (== the uniform scale when Scale X is 1). */
export function prsUniformScale(prs) {
  return prs.sx;
}

// ── Sanitization / reference repair ──────────────────────────────────────────

/**
 * Item-level pass: keep only a well-formed relationship with a non-empty parent id
 * that isn't the item itself. Cross-item validity (missing parents, cycles) cannot
 * be judged here — that needs the whole level, see repairParentingReferences.
 */
export function sanitizeParentingField(item) {
  const parenting = normalizeParenting(item?.keyframeParenting);
  if (!parenting) return null;
  if (parenting.parentItemId === item?.id) return null;
  return parenting;
}

/**
 * Level-wide pass, run AFTER every item at a level is known: drop references to
 * layers that don't exist here, and break cycles deterministically (the edge
 * closest to the end of the walk is the one removed). Returns the same channel
 * array when nothing changed, so callers can skip a re-render.
 */
export function repairParentingReferences(channels) {
  if (!Array.isArray(channels) || channels.length === 0) return channels;
  const ids = new Set();
  let anyParenting = false;
  for (const ch of channels) {
    for (const item of ch?.items || []) {
      if (item?.id) ids.add(item.id);
      if (item?.keyframeParenting) anyParenting = true;
    }
  }
  if (!anyParenting) return channels;

  // First pass: keep only relationships whose parent exists at this level.
  const parentOf = new Map();
  for (const ch of channels) {
    for (const item of ch?.items || []) {
      const parenting = sanitizeParentingField(item);
      if (parenting && ids.has(parenting.parentItemId)) parentOf.set(item.id, parenting.parentItemId);
    }
  }

  // Second pass: walk each chain and cut the edge that closes a cycle.
  const safe = new Set();
  for (const startId of parentOf.keys()) {
    if (safe.has(startId)) continue;
    const path = [];
    const onPath = new Set();
    let cursor = startId;
    while (cursor && parentOf.has(cursor) && !safe.has(cursor)) {
      if (onPath.has(cursor)) {
        parentOf.delete(cursor);
        break;
      }
      path.push(cursor);
      onPath.add(cursor);
      cursor = parentOf.get(cursor);
    }
    for (const id of path) safe.add(id);
  }

  let changed = false;
  const next = channels.map((ch) => {
    let chChanged = false;
    const items = (ch?.items || []).map((item) => {
      const keep = parentOf.get(item?.id);
      const had = item?.keyframeParenting;
      if (!had) return item;
      if (!keep) {
        chChanged = true;
        const { keyframeParenting, ...rest } = item;
        void keyframeParenting;
        return rest;
      }
      const normalized = normalizeParenting(had);
      if (normalized && normalized.parentItemId === keep && normalized.type === had.type) return item;
      chChanged = true;
      return { ...item, keyframeParenting: { parentItemId: keep, type: normalized?.type || PARENTING_ADDITIVE } };
    });
    if (!chChanged) return ch;
    changed = true;
    return { ...ch, items };
  });
  return changed ? next : channels;
}

/**
 * Remap parent ids after items were cloned with fresh ids (paste, ungroup, preset
 * insertion). `idMap` is oldId → newId; a relationship whose parent wasn't part of
 * the same copy is DROPPED rather than left pointing at the original layer.
 */
export function remapParentingIds(item, idMap) {
  const parenting = normalizeParenting(item?.keyframeParenting);
  if (!parenting) return item;
  const mapped = idMap?.get ? idMap.get(parenting.parentItemId) : idMap?.[parenting.parentItemId];
  if (!mapped) {
    const { keyframeParenting, ...rest } = item;
    void keyframeParenting;
    return rest;
  }
  return { ...item, keyframeParenting: { parentItemId: mapped, type: parenting.type } };
}

/** Strip parenting from an item outright (single-layer / cross-project paste). */
export function stripParenting(item) {
  if (!item?.keyframeParenting) return item;
  const { keyframeParenting, ...rest } = item;
  void keyframeParenting;
  return rest;
}

/**
 * Detach every direct child of the given item ids, so deleting a parent leaves no
 * dangling reference. Returns the same array when nothing pointed at them.
 */
export function detachChildrenOf(channels, removedIds) {
  const removed = removedIds instanceof Set ? removedIds : new Set(removedIds || []);
  if (!removed.size || !Array.isArray(channels)) return channels;
  let changed = false;
  const next = channels.map((ch) => {
    let chChanged = false;
    const items = (ch?.items || []).map((item) => {
      const parenting = normalizeParenting(item?.keyframeParenting);
      if (!parenting || !removed.has(parenting.parentItemId)) return item;
      chChanged = true;
      return stripParenting(item);
    });
    if (!chChanged) return ch;
    changed = true;
    return { ...ch, items };
  });
  return changed ? next : channels;
}
