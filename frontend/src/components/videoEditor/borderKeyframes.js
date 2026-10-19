// Border keyframes — `borderWidth` / `borderColor` property-keyframe tracks.
//
// The border is card framing on every visual layer (and the outline stroke on shape
// layers). Its tracks override the static fields for the frame being drawn; every
// border consumer (the shape plate, the clip shader framing, the silhouette framing
// pass) reads the effective item from `withBorderKeyframes`.
//
// A LEAF module — no imports — so it runs under plain `node --test`.

export const BORDER_KF_KEYS = ['borderWidth', 'borderColor'];
export const BORDER_WIDTH_MAX = 200;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Does the item carry a border track with keys? */
export function hasBorderKeyframes(item) {
  const pk = item?.propertyKeyframes;
  if (!pk) return false;
  return BORDER_KF_KEYS.some((k) => Array.isArray(pk[k]) && pk[k].length > 0);
}

/** Can the border ever be visible? (static width, or a width track that rises above 0) */
export function borderCanShow(item) {
  if (!item || item.borderStyle === 'none') return false;
  if (isNum(item.borderWidth) && item.borderWidth > 0.25) return true;
  const track = item.propertyKeyframes?.borderWidth;
  return Array.isArray(track) && track.some((k) => Number.parseFloat(k?.value) > 0.25);
}

/**
 * The item with this frame's keyframed border applied. `kf` is the frame's resolved
 * keyframe values (interpolatePropertyKeyframes). Returns the same object when no
 * border track is live, so identity-keyed caches keep working.
 */
export function withBorderKeyframes(item, kf) {
  if (!item || !kf) return item;
  const w = kf.borderWidth;
  const c = kf.borderColor;
  const hasW = isNum(w);
  const hasC = typeof c === 'string' && c.trim() !== '';
  if (!hasW && !hasC) return item;
  const out = { ...item };
  if (hasW) out.borderWidth = Math.min(BORDER_WIDTH_MAX, Math.max(0, w));
  if (hasC) out.borderColor = c.trim();
  return out;
}
