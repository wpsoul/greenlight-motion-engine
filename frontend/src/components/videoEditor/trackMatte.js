// After Effects-style Track Matte for the Video Editor.
//
// A consumer layer carries `trackMatte: { sourceId, mode }` — another layer on the
// same editing level whose alpha (or luma) masks the consumer. Unlike AE the
// pairing is an explicit id reference, not "the layer above": the compositor
// depth-sorts channels within a run, so positional pairing would be unstable.
// One source may matte several consumers; the source layer is hidden from the
// composite while at least one active consumer references it.
//
// Mirrors keyframeParenting.js deliberately — same normalize / sanitize / repair /
// remap lifecycle, same candidate collector contract — so every schema touch
// point (the item-field whitelist, paste remaps, sequence extraction) can be
// maintained side by side with the parenting field.
//
// Dependency-free on purpose (no three, no React): the Player and the editor both
// import it, and it stays unit-testable under plain `node --test`.

export const MATTE_MODE_ALPHA = 'alpha';
export const MATTE_MODE_ALPHA_INVERTED = 'alphaInverted';
export const MATTE_MODE_LUMA = 'luma';
export const MATTE_MODE_LUMA_INVERTED = 'lumaInverted';

export const MATTE_MODES = [
  MATTE_MODE_ALPHA, MATTE_MODE_ALPHA_INVERTED, MATTE_MODE_LUMA, MATTE_MODE_LUMA_INVERTED,
];

export const MATTE_MODE_LABELS = {
  [MATTE_MODE_ALPHA]: 'Alpha Matte',
  [MATTE_MODE_ALPHA_INVERTED]: 'Alpha Inverted',
  [MATTE_MODE_LUMA]: 'Luma Matte',
  [MATTE_MODE_LUMA_INVERTED]: 'Luma Inverted',
};

// Short forms for the timeline chip (α / α⁻¹ / L / L⁻¹).
export const MATTE_MODE_SHORT = {
  [MATTE_MODE_ALPHA]: 'α',
  [MATTE_MODE_ALPHA_INVERTED]: 'α⁻¹',
  [MATTE_MODE_LUMA]: 'L',
  [MATTE_MODE_LUMA_INVERTED]: 'L⁻¹',
};

const MATTE_MODE_SET = new Set(MATTE_MODES);

// Layer kinds that can act as matte SOURCE or CONSUMER. Everything that draws
// pixels qualifies; audio has no pixels, cameras pose instead of drawing, and an
// adjustment layer's "content" is the stack below it — none of the three has a
// silhouette of its own to matte with (or to be matted).
const MATTEABLE_MEDIA_TYPES = new Set([
  'image', 'video', 'text', 'shape', 'motion', 'sequence', 'grid', 'model3d',
]);

/**
 * Normalize an item's `trackMatte` field. Returns null for anything that isn't a
 * usable relationship, so callers can treat "no matte" as falsy. Unknown modes
 * normalize to Alpha rather than dropping the relationship.
 */
export function normalizeTrackMatte(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sourceId = typeof raw.sourceId === 'string' ? raw.sourceId.trim() : '';
  if (!sourceId) return null;
  const mode = MATTE_MODE_SET.has(raw.mode) ? raw.mode : MATTE_MODE_ALPHA;
  return { sourceId, mode };
}

export function getTrackMatte(item) {
  return normalizeTrackMatte(item?.trackMatte);
}

export function isMatteMode(mode) {
  return MATTE_MODE_SET.has(mode);
}

export function isMatteableClip(clip, item) {
  if (!clip || !MATTEABLE_MEDIA_TYPES.has(clip.mediaType)) return false;
  // An unapplied AI Fill zone is a placeholder spacer, not a real layer.
  if (item && typeof item.aiFillZoneId === 'string' && item.aiFillZoneId) return false;
  return true;
}

/**
 * Item-level pass: keep only a well-formed relationship with a non-empty source id
 * that isn't the item itself. Cross-item validity (missing sources, chains) cannot
 * be judged here — that needs the whole level, see repairTrackMatteReferences.
 */
export function sanitizeTrackMatteField(item) {
  const matte = normalizeTrackMatte(item?.trackMatte);
  if (!matte) return null;
  if (matte.sourceId === item?.id) return null;
  return matte;
}

/**
 * Level-wide pass, run AFTER every item at a level is known: drop references to
 * layers that don't exist here, and break source chains that close a cycle
 * (A mattes with B while B mattes with A) deterministically. Returns the same
 * channel array when nothing changed, so callers can skip a re-render.
 */
export function repairTrackMatteReferences(channels) {
  if (!Array.isArray(channels) || channels.length === 0) return channels;
  const ids = new Set();
  let anyMatte = false;
  for (const ch of channels) {
    for (const item of ch?.items || []) {
      if (item?.id) ids.add(item.id);
      if (item?.trackMatte) anyMatte = true;
    }
  }
  if (!anyMatte) return channels;

  // First pass: keep only relationships whose source exists at this level.
  const sourceOf = new Map();
  for (const ch of channels) {
    for (const item of ch?.items || []) {
      const matte = sanitizeTrackMatteField(item);
      if (matte && ids.has(matte.sourceId)) sourceOf.set(item.id, matte.sourceId);
    }
  }

  // Second pass: walk each source chain and cut the edge that closes a cycle.
  const safe = new Set();
  for (const startId of sourceOf.keys()) {
    if (safe.has(startId)) continue;
    const path = [];
    const onPath = new Set();
    let cursor = startId;
    while (cursor && sourceOf.has(cursor) && !safe.has(cursor)) {
      if (onPath.has(cursor)) {
        sourceOf.delete(cursor);
        break;
      }
      path.push(cursor);
      onPath.add(cursor);
      cursor = sourceOf.get(cursor);
    }
    for (const id of path) safe.add(id);
  }

  let changed = false;
  const next = channels.map((ch) => {
    let chChanged = false;
    const items = (ch?.items || []).map((item) => {
      const keep = sourceOf.get(item?.id);
      const had = item?.trackMatte;
      if (!had) return item;
      if (!keep) {
        chChanged = true;
        const { trackMatte, ...rest } = item;
        void trackMatte;
        return rest;
      }
      const normalized = normalizeTrackMatte(had);
      if (normalized && normalized.sourceId === keep && normalized.mode === had.mode) return item;
      chChanged = true;
      return { ...item, trackMatte: { sourceId: keep, mode: normalized?.mode || MATTE_MODE_ALPHA } };
    });
    if (!chChanged) return ch;
    changed = true;
    return { ...ch, items };
  });
  return changed ? next : channels;
}

/**
 * Remap source ids after items were cloned with fresh ids (paste, ungroup, preset
 * insertion). `idMap` is oldId → newId; a relationship whose source wasn't part of
 * the same copy is DROPPED rather than left pointing at the original layer.
 */
export function remapTrackMatteIds(item, idMap) {
  const matte = normalizeTrackMatte(item?.trackMatte);
  if (!matte) return item;
  const mapped = idMap?.get ? idMap.get(matte.sourceId) : idMap?.[matte.sourceId];
  if (!mapped) {
    const { trackMatte, ...rest } = item;
    void trackMatte;
    return rest;
  }
  return { ...item, trackMatte: { sourceId: mapped, mode: matte.mode } };
}

/** Strip the matte from an item outright (single-layer / cross-project paste). */
export function stripTrackMatte(item) {
  if (!item?.trackMatte) return item;
  const { trackMatte, ...rest } = item;
  void trackMatte;
  return rest;
}

/**
 * Eligible matte sources for `item`, at its own editing level.
 *
 * `index` is a buildParentIndex() map (keyframeParenting.js) — same shape, reused
 * so the Player and the editor share one item lookup. Options carry the clip name,
 * channel name and timeline range so duplicate layer names stay distinguishable,
 * and are sorted by stack order (top channel first) then start time. The item's
 * CURRENT source is always included — if the clips were moved apart afterwards we
 * surface it with `noOverlap` rather than silently detaching.
 */
export function collectMatteCandidates({ index, item, clipsMap, fps = 30, clipNameFor = null, spansShareFrame }) {
  const out = [];
  if (!index || !item) return out;
  const childEntry = index.get(item.id);
  if (!childEntry) return out;
  const currentSourceId = getTrackMatte(item)?.sourceId || null;

  const overlaps = (a, b) => (spansShareFrame ? spansShareFrame(a, b, fps) : true);

  for (const [id, entry] of index) {
    if (id === item.id) continue;
    const clip = clipsMap ? clipsMap.get(entry.item.clipId) : null;
    const isCurrent = id === currentSourceId;
    if (!isCurrent) {
      if (!isMatteableClip(clip, entry.item)) continue;
      // A → B while B → A would leave both hidden; refuse the closing edge here.
      if (getTrackMatte(entry.item)?.sourceId === item.id) continue;
      if (!overlaps(childEntry, entry)) continue;
    }
    out.push({
      id,
      name: (clipNameFor ? clipNameFor(entry.item, clip) : clip?.name) || 'Layer',
      channelName: entry.channelName || 'Channel',
      channelIndex: entry.channelIndex,
      startTime: entry.startTime,
      endTime: entry.endTime,
      isCurrent,
      noOverlap: !overlaps(childEntry, entry),
    });
  }

  // Stack order is z-order: the last channel renders highest, so list top-down.
  out.sort((a, b) => (b.channelIndex - a.channelIndex) || (a.startTime - b.startTime));
  return out;
}

/**
 * Layers an Overlay Effect can REFERENCE (Copy Color Profile's `type: 'layer'`
 * param): every other visual layer in the project, on any channel — hidden ones
 * included. The Player measures a reference LIVE when it is on screen together
 * with this item (its isolate as drawn), and from its source picture otherwise
 * (a hidden channel, a clip elsewhere in time, the same channel), so nothing
 * here needs filtering by overlap. `hidden` and `sameChannel` ride along for the
 * label. Same visual-layer kinds as a matte source.
 */
export function collectLayerRefCandidates({ index, item, clipsMap, fps = 30, clipNameFor = null, spansShareFrame }) {
  const out = [];
  if (!index || !item) return out;
  const childEntry = index.get(item.id);
  if (!childEntry) return out;
  // `noOverlap` is real when the caller passes spansShareFrame: a live-only
  // effect (`layerRefMode: 'live'`, Double Exposure) filters on it in the panel.
  const overlaps = (a, b) => (spansShareFrame ? spansShareFrame(a, b, fps) : true);
  for (const [id, entry] of index) {
    if (id === item.id) continue;
    const clip = clipsMap ? clipsMap.get(entry.item.clipId) : null;
    if (!isMatteableClip(clip, entry.item)) continue;
    out.push({
      id,
      name: (clipNameFor ? clipNameFor(entry.item, clip) : clip?.name) || 'Layer',
      channelName: entry.channelName || 'Channel',
      channelIndex: entry.channelIndex,
      startTime: entry.startTime,
      endTime: entry.endTime,
      hidden: entry.channelVisible === false,
      sameChannel: entry.channelId === childEntry.channelId,
      noOverlap: !overlaps(childEntry, entry),
    });
  }
  out.sort((a, b) => (b.channelIndex - a.channelIndex) || (a.startTime - b.startTime));
  return out;
}
