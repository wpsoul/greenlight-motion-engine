/*
 * Per-pixel camera depth of field for 3D passes — the CPU half.
 *
 * A 2D layer is a flat plane, so one circle of confusion per layer is exact for
 * it. A 3D model is not: a set built in Blender holds a character in focus and a
 * wall metres behind it, and blurring the whole pass by its bounding-box centre
 * blurred the character as much as the wall. A camera-baked pass already hands
 * the compositor its depth buffer (in the compositor's own near/far encoding, for
 * occlusion), so the DOF pass reads each pixel's distance from it and blurs each
 * pixel by its own CoC — cameraDof.js / compositeNodes.js do the gather.
 *
 * Kept free of imports so the node tests can load it directly. cocAtDistance is
 * projectCamera.getCameraCoCRadius in the units the shader works in (target px,
 * capped), and the shader's cocOf() must stay the same expression.
 */

/** The DOF pass's CoC cap, in target pixels (the gather loop has 40 taps). */
export const DOF_MAX_COC_PX = 64;

/** Window depth at or past this is the cleared far plane: nothing was drawn. */
export const FAR_PLANE_DEPTH = 0.999999;

/**
 * Window-space depth [0,1] → positive view distance, for a perspective camera
 * with this near/far. Same value on WebGL and WebGPU: three maps WebGL's ndc z
 * onto [0,1] and WebGPU's projection lands there directly, both as
 * far·(dist − near) / ((far − near)·dist).
 */
export function viewDistanceFromDepth(depth, near, far) {
  return (near * far) / (far - depth * (far - near));
}

/** The inverse: positive view distance → window depth. */
export function depthFromViewDistance(dist, near, far) {
  const d = Math.max(near, dist);
  return (far * (d - near)) / ((far - near) * d);
}

/** One pixel's CoC radius in target px: the shader's cocOf(). */
export function cocAtDistance(p, dist) {
  if (!p) return 0;
  const d = Math.max(1, dist);
  return Math.min(p.maxCocPx, (p.cocScale * Math.abs(p.focusDistance - d)) / d);
}

/**
 * Everything the depth-aware DOF pass needs for one 3D pass, or null when the
 * camera's DOF does nothing.
 *
 * @param {object} dof          getCameraDofSettings() for this frame
 * @param {{near:number, far:number}|null} range  the pass's bounding-box depth
 *                              span along the view axis (nearest / farthest
 *                              corner); null falls back to the centre alone
 * @param {number} centerDistance  the bounding-box centre's view distance —
 *                              one more point the span's CoC is bounded over
 * @param {number} [scale=1]    target px per composition px (the supersample)
 * @returns {{cocScale, focusDistance, maxCocPx, fallbackDistance, spreadPx, peakPx}|null}
 *   `peakPx` bounds every pixel's CoC (CoC is monotonic on each side of the focus
 *   plane, so the span's ends hold the maximum): it decides whether the pass
 *   needs blurring at all, and is how far a blurred surface may scatter onto the
 *   empty pixels around it; `spreadPx` is how far the pass's NEARER-than-focus
 *   part can blur out over what lies behind it — 0 when nothing is in front of
 *   the focus plane, which skips the foreground gather entirely.
 */
export function modelDofParams(dof, range, centerDistance, scale = 1) {
  if (!dof?.enabled || !(dof.aperture > 0) || !(dof.blurLevel > 0)) return null;
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const p = {
    cocScale: dof.aperture * (dof.blurLevel / 100) * s,
    focusDistance: Math.max(1, dof.focusDistance),
    maxCocPx: DOF_MAX_COC_PX,
    fallbackDistance: Math.max(1, Number.isFinite(centerDistance) ? centerDistance : dof.focusDistance),
    spreadPx: 0,
    peakPx: 0,
  };
  const near = Number.isFinite(range?.near) ? Math.max(1, range.near) : p.fallbackDistance;
  const far = Number.isFinite(range?.far) ? Math.max(near, range.far) : Math.max(near, p.fallbackDistance);
  p.peakPx = Math.max(cocAtDistance(p, near), cocAtDistance(p, far), cocAtDistance(p, p.fallbackDistance));
  p.spreadPx = near < p.focusDistance ? cocAtDistance(p, near) : 0;
  return p;
}
