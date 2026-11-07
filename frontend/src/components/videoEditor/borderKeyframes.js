// Border keyframes — `borderWidth` / `borderColor` property-keyframe tracks, and the
// corner radius tracks with their scale lock.
//
// The border is card framing on every visual layer (and the outline stroke on shape
// layers). Its tracks override the static fields for the frame being drawn; every
// border consumer (the shape plate, the clip shader framing, the silhouette framing
// pass) reads the effective item from `withBorderKeyframes`. The corner radius rounds
// the same plate (a media layer's card, a rectangle shape's outline): its tracks go
// through `withRadiusKeyframes`, its scale lock through `withRadiusScaleLock`.
//
// A LEAF module — no imports — so it runs under plain `node --test`.

export const BORDER_KF_KEYS = ['borderWidth', 'borderColor'];
// `borderRadius`, or the four corners while `borderRadiusLinked` is false. Values are
// in the item's radius unit: px, or % of a shape's shorter side (`borderRadiusUnit`).
export const RADIUS_KF_KEYS = ['borderRadius', 'borderRadiusTL', 'borderRadiusTR', 'borderRadiusBR', 'borderRadiusBL'];
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

/** The item with this frame's keyframed corner radii applied (the same object when none is keyed). */
export function withRadiusKeyframes(item, kf) {
  if (!item || !kf) return item;
  let out = null;
  for (const key of RADIUS_KF_KEYS) {
    const v = kf[key];
    if (isNum(v)) {
      if (!out) out = { ...item };
      out[key] = Math.max(0, v);
    }
  }
  return out || item;
}

/**
 * Keep the corners on screen (`borderRadiusScaleLock`). The plate is drawn at the
 * layer's scale (its Scale, its keyframes, its parents), so a 24 px corner on a tile
 * that grows 4× is 96 px on screen. Locked, every radius is divided by that scale and
 * the corner keeps its size while the tile grows. Border and shadows follow the
 * rounded outline, so they need nothing of their own. The same object comes back when
 * the lock is off or the scale is 1.
 */
export function withRadiusScaleLock(item, scale) {
  if (!item?.borderRadiusScaleLock) return item;
  const s = Number(scale);
  if (!(s > 1e-3) || Math.abs(s - 1) < 1e-4) return item;
  const out = { ...item };
  for (const key of RADIUS_KF_KEYS) {
    if (isNum(item[key])) out[key] = Math.max(0, item[key]) / s;
  }
  return out;
}
