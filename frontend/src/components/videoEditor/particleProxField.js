/*
 * Particle Proximity — baking a source layer's artwork into a distance field.
 *
 * The DOM half of the effector. Everything after the readback is pure and lives
 * in sim/particles/proximity.js, which is what the solver and the renderer both
 * call; this file exists only because a chamfer needs pixels and pixels need a
 * canvas. Same split, and the same reason, as particleGrowField.js next door.
 *
 * ── WHY THIS DOES NOT REUSE THE COLLIDER'S BAKE ───────────────────────────
 *
 * fluid.js `sdfFromMask` lays the alpha over the WHOLE SOLVER BOX at a fixed
 * 384x216 and chamfers there. For a static obstacle that is exactly right. For
 * an effector it fails twice:
 *
 *   1. A source a quarter of the box wide gets a quarter of the raster, so its
 *      silhouette is blocky precisely where the falloff band lives — and the
 *      falloff band IS the effect.
 *   2. Position, scale and rotation are baked in, so the headline case for this
 *      feature (a source that moves) would re-chamfer every frame.
 *
 * Baking in the ARTWORK's own local space fixes both at once. The field is
 * identical whatever the source is doing on the timeline, so the cache key is
 * the ARTWORK ALONE — drag, spin, scale and animate the layer all day and this
 * runs once.
 */

import { ensureObjectRaster, ctx2d, objectRasterKey } from './particleObjectRaster';

/*
 * Resolution of the baked field on its LONG side.
 *
 * 320 is chosen against the thing that actually limits the picture: the field is
 * sampled bilinearly and then fed through a falloff hundreds of px wide, so what
 * matters is that the SILHOUETTE is resolved, not that the distances are exact.
 * At 320 the pad-inclusive box gives ~170 px across the artwork itself, which
 * resolves a letterform's counters and stem — the features a user tunes against.
 * The cost is one Float32Array of 320 x 180 x 4 B = 230 KB per source.
 */
const FIELD_LONG = 320;

/*
 * How far past the artwork the field is baked, as a fraction of its long side,
 * on each side.
 *
 * This is the one number that decides where the out-of-box approximation in
 * `sdfLocal` starts to be visible, so it is sized against what the falloff can
 * reach rather than picked. At 0.85 a 900 px-wide word carries an accurate field
 * ~765 px beyond itself, which is past any falloff anyone tunes on a 1920-wide
 * composition. Beyond that the extension is continuous and monotone — it just
 * slightly over-states distance, which reads as the influence ending a touch
 * early, never as an edge.
 */
const PAD_FRAC = 0.85;

const MAX_FIELDS = 8;             // the source cap plus headroom for a swap
const cache = new Map();          // key -> table | null (null = un-bakeable)

/**
 * Identity of the FIELD. The artwork and nothing else — deliberately NOT the
 * source's size, position or rotation, because those are applied at sample time
 * and re-baking for them is the entire mistake this module exists to avoid.
 */
export function proxFieldKey(source) {
  const base = objectRasterKey(source);
  return base ? `${base}@prox${FIELD_LONG}` : '';
}

/**
 * The baked table for one source, or null while its artwork is still decoding
 * (an image or a video poster resolves over a frame or two — the caller simply
 * skips that source until it does, exactly as the emitter's spawn table does).
 *
 * Shape matches what sim/particles/proximity.js expects:
 *   { sdf, w, h, boxW, boxH, artW, artH }
 * with `sdf` in LOCAL ARTWORK PIXELS, negative inside, origin at the artwork's
 * centre and +y UP.
 */
export function ensureProxField(source) {
  const key = proxFieldKey(source);
  if (!key) return null;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const raster = ensureObjectRaster(source, FIELD_LONG);
  if (!raster?.ready || !raster.canvas) return null;      // decoding; try next frame

  const artW = raster.canvas.width, artH = raster.canvas.height;
  const long = Math.max(artW, artH);
  const pad = long * PAD_FRAC;
  const boxW = artW + pad * 2, boxH = artH + pad * 2;
  const W = Math.max(48, Math.round(boxW >= boxH ? FIELD_LONG : (FIELD_LONG * boxW) / boxH));
  const H = Math.max(48, Math.round(boxH >= boxW ? FIELD_LONG : (FIELD_LONG * boxH) / boxW));

  let rgba;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = ctx2d(c);
  try {
    g.drawImage(raster.canvas, (pad / boxW) * W, (pad / boxH) * H, (artW / boxW) * W, (artH / boxH) * H);
    rgba = g.getImageData(0, 0, W, H).data;
  } catch {
    // A cross-origin image taints the canvas. Without a mask there is no field;
    // cache the miss so this is not retried on every frame of the timeline.
    cache.set(key, null);
    return null;
  }

  const table = chamferField(rgba, W, H, boxW, boxH, artW, artH);
  if (cache.size >= MAX_FIELDS) cache.delete(cache.keys().next().value);
  cache.set(key, table);
  return table;
}

/*
 * Two-pass 3-4 chamfer, the same transform fluid.js uses for the collider — kept
 * deliberately identical so a shape that collides and a shape that drives an
 * effector agree about where their own edge is. Threshold at alpha 128.
 *
 * `k` converts chamfer units to LOCAL ARTWORK px; the sampler multiplies by the
 * source's scale to reach composition px, which is why a scale animation is
 * free.
 */
function chamferField(rgba, W, H, boxW, boxH, artW, artH) {
  const INF = 1e6;
  const N = W * H;
  const dO = new Float32Array(N), dI = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const solid = rgba[i * 4 + 3] > 127;
    dO[i] = solid ? 0 : INF;
    dI[i] = solid ? INF : 0;
  }
  const chamfer = (d) => {
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const o = i + j * W; let v = d[o];
      if (i > 0) v = Math.min(v, d[o - 1] + 3);
      if (j > 0) {
        v = Math.min(v, d[o - W] + 3);
        if (i > 0) v = Math.min(v, d[o - W - 1] + 4);
        if (i < W - 1) v = Math.min(v, d[o - W + 1] + 4);
      }
      d[o] = v;
    }
    for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
      const o = i + j * W; let v = d[o];
      if (i < W - 1) v = Math.min(v, d[o + 1] + 3);
      if (j < H - 1) {
        v = Math.min(v, d[o + W] + 3);
        if (i < W - 1) v = Math.min(v, d[o + W + 1] + 4);
        if (i > 0) v = Math.min(v, d[o + W - 1] + 4);
      }
      d[o] = v;
    }
  };
  chamfer(dO); chamfer(dI);
  const k = (boxW / W) / 3;
  const sdf = new Float32Array(N);
  for (let i = 0; i < N; i++) sdf[i] = (dO[i] - dI[i]) * k;

  // An artwork with NO opaque pixels chamfers to "infinitely far from
  // everything", which would silently read as a field that never fires. Say so
  // instead, so the panel can tell the user their source has no silhouette.
  let solid = false;
  for (let i = 0; i < N; i++) { if (dO[i] === 0) { solid = true; break; } }

  return { sdf, w: W, h: H, boxW, boxH, artW, artH, empty: !solid };
}

/** Every source's table, index-aligned with `sources`; null where not ready. */
export function ensureProxFields(sources) {
  const list = Array.isArray(sources) ? sources : [];
  const out = new Array(list.length);
  for (let i = 0; i < list.length; i++) out[i] = list[i]?.source ? ensureProxField(list[i].source) : null;
  return out;
}

/** Drop every baked field. Called when the board changes, like the raster cache. */
export function clearProxFields() {
  cache.clear();
}

/** How many fields are baked right now — the panel's honesty check. */
export const proxFieldCount = () => cache.size;
