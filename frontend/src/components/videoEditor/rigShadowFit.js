/*
 * Fitting a directional light's shadow map to what the camera actually SEES.
 *
 * Why: one shadow map spread over every caster in the set is fine for a product on
 * a cyclorama, and useless for a long set. A ten-metre page with a 120 px character
 * on it gave each shadow-map texel five world px — coarse, stair-stepped shadows and
 * acne bands across the character. The camera only ever sees a small part of such a
 * set, so the map is fitted to that part:
 *
 *   1. the visible receivers — the camera frustum clipped against the receivers'
 *      bounds (an exact convex clip, not the frustum's bounding box, so a camera
 *      whose far plane is kilometres away still fits only the set it looks at);
 *   2. intersected, in the light's own XY, with the casters' footprint — a
 *      directional shadow travels along the light's Z, so a caster can only darken
 *      receivers that share its light-space XY;
 *   3. reaching back toward the light far enough to include every caster.
 *
 * Stability: the fit is a pure function of the frame (renders of the same frame
 * agree, in any order), its size moves in 1/8-octave steps and its centre snaps to
 * whole texels, so a moving camera slides the shadows over a fixed texel grid
 * instead of making their edges crawl.
 */

import * as THREE from 'three';

/** Size steps per octave. 8 → each step is ~9%: rare enough while a camera moves
 *  that the texel grid stays put, fine enough that no fit wastes much of the map. */
export const SHADOW_FIT_STEPS_PER_OCTAVE = 8;

const _corners = Array.from({ length: 8 }, () => new THREE.Vector3());
const _p = new THREE.Vector3();
const _inv = new THREE.Matrix4();

/** The 8 frustum corners of a camera, in world space (near 4, then far 4). */
export function frustumCorners(camera, out = []) {
  camera.updateMatrixWorld?.();
  _inv.copy(camera.projectionMatrixInverse);
  // WebGPU's clip space runs z over [0, 1], WebGL's over [-1, 1].
  const zNear = camera.coordinateSystem === THREE.WebGPUCoordinateSystem ? 0 : -1;
  let i = 0;
  for (const z of [zNear, 1]) {
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const v = out[i] || (out[i] = new THREE.Vector3());
      v.set(x, y, z).applyMatrix4(_inv).applyMatrix4(camera.matrixWorld);
      i += 1;
    }
  }
  out.length = 8;
  return out;
}

// Faces of an 8-corner hexahedron ordered as frustumCorners / boxCorners return them
// (0-3 one end, 4-7 the other, same winding).
const HEX_FACES = [
  [0, 1, 2, 3], [4, 5, 6, 7],
  [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
];

function boxCorners(box, out) {
  const { min: a, max: b } = box;
  const pts = [
    [a.x, a.y, a.z], [b.x, a.y, a.z], [b.x, b.y, a.z], [a.x, b.y, a.z],
    [a.x, a.y, b.z], [b.x, a.y, b.z], [b.x, b.y, b.z], [a.x, b.y, b.z],
  ];
  for (let i = 0; i < 8; i += 1) (out[i] || (out[i] = new THREE.Vector3())).set(...pts[i]);
  out.length = 8;
  return out;
}

/** Inward-facing planes of a convex hexahedron given by its 8 corners. */
function hexPlanes(corners) {
  const c = new THREE.Vector3();
  for (const v of corners) c.add(v);
  c.multiplyScalar(1 / corners.length);
  return HEX_FACES.map((f) => {
    // Three non-collinear corners of the face; a degenerate (zero-thickness) box
    // face falls back to the next triple.
    const plane = new THREE.Plane();
    for (let s = 0; s < 4; s += 1) {
      plane.setFromCoplanarPoints(corners[f[s]], corners[f[(s + 1) % 4]], corners[f[(s + 2) % 4]]);
      if (Number.isFinite(plane.constant) && plane.normal.lengthSq() > 0.5) break;
    }
    if (plane.distanceToPoint(c) < 0) plane.negate();
    return plane;
  });
}

/** Sutherland–Hodgman: the part of a convex polygon on a plane's positive side. */
function clipPolygon(poly, plane, eps) {
  const out = [];
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = plane.distanceToPoint(a) + eps;
    const db = plane.distanceToPoint(b) + eps;
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) out.push(new THREE.Vector3().lerpVectors(a, b, da / (da - db)));
  }
  return out;
}

/**
 * The vertices of (camera frustum ∩ box) — the part of the box the camera can see.
 * The intersection of two convex solids is convex, and its vertices all lie on the
 * clipped faces of one or the other, so clipping both sets of faces by the other
 * solid's planes collects every one of them. Empty when the camera sees none of it.
 */
export function visibleBoxPoints(camera, box) {
  if (!camera || !box || box.isEmpty()) return [];
  const size = box.getSize(_p);
  // A flat receiver (a page, a floor plate) has a zero-thickness box. A little
  // tolerance keeps its one face from being clipped away by its own twin plane.
  const eps = Math.max(1e-3, Math.max(size.x, size.y, size.z) * 1e-6);
  const fr = frustumCorners(camera, _corners.map((v) => v.clone()));
  const bx = boxCorners(box, []);
  const frPlanes = hexPlanes(fr);
  const bxPlanes = hexPlanes(bx);
  const pts = [];
  const clipFaces = (corners, planes) => {
    for (const f of HEX_FACES) {
      let poly = f.map((i) => corners[i].clone());
      for (const pl of planes) {
        poly = clipPolygon(poly, pl, eps);
        if (!poly.length) break;
      }
      for (const v of poly) pts.push(v);
    }
  };
  clipFaces(bx, frPlanes);
  clipFaces(fr, bxPlanes);
  return pts;
}

function lightSpaceBounds(points, lightView, out) {
  out.makeEmpty();
  for (const v of points) out.expandByPoint(_p.copy(v).applyMatrix4(lightView));
  return out;
}

/** Round a size UP to the next 1/8-octave step. */
export function quantizeFitSize(size) {
  const s = Math.max(1e-6, size);
  return 2 ** (Math.ceil(Math.log2(s) * SHADOW_FIT_STEPS_PER_OCTAVE - 1e-9) / SHADOW_FIT_STEPS_PER_OCTAVE);
}

/**
 * The orthographic box (in the light's view space) for one directional light.
 *
 * @param lightView  world → light-view matrix (the shadow camera's matrixWorldInverse,
 *                   after shadow.updateMatrices(light))
 * @param view       the camera that films the frame, or null (then the casters'
 *                   footprint alone is fitted — the pre-fit behaviour)
 * @param receivers  world Box3 of every visible shadow-receiving mesh
 * @param casters    world Box3 of every visible shadow-casting mesh
 * @param pad        world px of margin around the region (penumbra + filter reach)
 * @param mapSize    shadow-map texels per side
 * @returns {left, right, bottom, top, near, far, texel, fitted} or null (no casters)
 */
export function fitDirectionalShadow({ lightView, view = null, receivers = null, casters, pad = 0, mapSize = 2048 }) {
  if (!casters || casters.isEmpty()) return null;
  const C = lightSpaceBounds(boxCorners(casters, []), lightView, new THREE.Box3());
  // Without a view, every receiver counts for depth: a floor beyond the casters
  // must stay inside the map's far plane or it silently receives nothing.
  const all = receivers && !receivers.isEmpty() ? lightSpaceBounds(boxCorners(receivers, []), lightView, new THREE.Box3()) : null;
  let R = null;
  if (view && receivers && !receivers.isEmpty()) {
    const pts = visibleBoxPoints(view, receivers);
    if (pts.length) R = lightSpaceBounds(pts, lightView, new THREE.Box3());
  }
  // XY: the visible receivers that a caster can actually reach.
  let x0 = C.min.x - pad, x1 = C.max.x + pad, y0 = C.min.y - pad, y1 = C.max.y + pad;
  if (R) {
    const rx0 = Math.max(x0, R.min.x - pad), rx1 = Math.min(x1, R.max.x + pad);
    const ry0 = Math.max(y0, R.min.y - pad), ry1 = Math.min(y1, R.max.y + pad);
    // No caster over anything visible: no shadow can show. Fit what is seen so the
    // map stays well-conditioned rather than collapsing.
    if (rx1 > rx0 && ry1 > ry0) { x0 = rx0; x1 = rx1; y0 = ry0; y1 = ry1; }
    else { x0 = R.min.x - pad; x1 = R.max.x + pad; y0 = R.min.y - pad; y1 = R.max.y + pad; }
  }
  const side = quantizeFitSize(Math.max(x1 - x0, y1 - y0, 1));
  const texel = side / Math.max(1, mapSize);
  const cx = Math.round(((x0 + x1) / 2) / texel) * texel;
  const cy = Math.round(((y0 + y1) / 2) / texel) * texel;
  // Depth: from the caster nearest the light (light-view z is negative in front of
  // the light, so "nearest" is the largest z) to the farthest receiver in view.
  const zTop = Math.max(C.max.z, R ? R.max.z : -Infinity) + pad;
  // A caster beyond every visible receiver can darken nothing on screen.
  const zBot = (R ? R.min.z : Math.min(C.min.z, all ? all.min.z : Infinity)) - pad;
  const step = side / 16;
  const near = Math.floor(-zTop / step) * step;
  const far = Math.max(near + step, Math.ceil(-zBot / step) * step);
  return {
    left: cx - side / 2, right: cx + side / 2,
    bottom: cy - side / 2, top: cy + side / 2,
    near, far, texel, fitted: !!R,
  };
}
