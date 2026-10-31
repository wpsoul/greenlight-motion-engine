// 3D Text letters (text3d.js): one extruded, bevelled solid per glyph.
//
// The outline comes from the font the layer REALLY draws with: the glyph is
// rasterised with the same canvas font string the 2D text uses (so Google,
// uploaded and system fonts, any weight, synthetic bold/italic all work — no font
// file is needed) and traced at its 0.5 alpha iso-line (rasterTracer.js), which
// is the anti-aliased edge itself. Outlines and holes are told apart by nesting,
// so an "O" or "%" keeps its counters.
//
// Geometry is built once per (font, character, depth, bevel) at a fixed raster
// size and shared by every letter that uses it; a mesh scales it to its font size.
// Main thread on purpose: document fonts are not visible to workers.

import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { traceContours, polygonArea, smoothClosed, rdpClosed } from './rasterTracer.js';

// 160 px (text3dGlyphConstants.js) keeps a counter of a light weight several pixels
// wide while a glyph traces in a millisecond or two.
import { GLYPH_RASTER_PX } from './text3dGlyphConstants.js';

export { GLYPH_RASTER_PX };

const GEOMETRY_LIMIT = 800;
const geometries = new Map(); // key → { geometry, advance } | null (blank glyph)

let canvas = null;
let ctx = null;
function rasterContext(w, h) {
  if (!canvas) {
    canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (canvas.width < w) canvas.width = w;
  if (canvas.height < h) canvas.height = h;
  return ctx;
}

/** The layer's canvas font string with the size swapped for the raster size. */
export function rasterFontFor(fontCss) {
  return String(fontCss || '').replace(/(\d+(?:\.\d+)?)px/, `${GLYPH_RASTER_PX}px`);
}

// Point-in-polygon (even-odd), for nesting.
function inside(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i]; const b = poly[j];
    if (((a.y > pt.y) !== (b.y > pt.y)) && (pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x)) c = !c;
  }
  return c;
}

/**
 * The traced outline of one glyph in RASTER px, origin at the 2D draw origin
 * (textBaseline 'top', y DOWN): { shapes: [{ outer, holes }], strokeWidth } or
 * null for a blank glyph (a space).
 */
export function traceGlyph(fontCss, ch) {
  const font = rasterFontFor(fontCss);
  const R = GLYPH_RASTER_PX;
  const c0 = rasterContext(8, 8);
  c0.font = font;
  c0.textBaseline = 'top';
  const m = c0.measureText(ch);
  const left = Math.max(0, Math.ceil(m.actualBoundingBoxLeft || 0));
  const right = Math.ceil(Math.max(m.width, m.actualBoundingBoxRight || 0));
  const above = Math.max(0, Math.ceil(m.actualBoundingBoxAscent || 0));
  const below = Math.ceil(Math.max(R * 1.3, m.actualBoundingBoxDescent || 0));
  const pad = 6;
  const ox = pad + left;
  const oy = pad + above;
  const w = Math.max(4, ox + right + pad);
  const h = Math.max(4, oy + below + pad);
  const c = rasterContext(w, h);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, w, h);
  c.font = font;
  c.textBaseline = 'top';
  c.fillStyle = '#ffffff';
  c.fillText(ch, ox, oy);
  const px = c.getImageData(0, 0, w, h).data;
  const field = new Float32Array(w * h);
  let any = false;
  for (let i = 0; i < w * h; i += 1) {
    const a = px[i * 4 + 3] / 255;
    field[i] = a;
    if (a > 0.5) any = true;
  }
  if (!any) return null;
  const loops = traceContours(field, w, h, 0.5)
    .map((pts) => rdpClosed(smoothClosed(pts, 1), 0.35))
    .filter((pts) => pts.length >= 3 && Math.abs(polygonArea(pts)) > 2)
    .map((pts) => pts.map((p) => ({ x: p.x - ox, y: p.y - oy })));
  if (!loops.length) return null;
  // Nesting depth: even = an outline, odd = a hole of the smallest outline around it.
  const depthOf = loops.map((l, i) => loops.reduce((d, other, j) => (j !== i && inside(l[0], other) ? d + 1 : d), 0));
  const shapes = [];
  const owners = [];
  loops.forEach((l, i) => { if (depthOf[i] % 2 === 0) { shapes.push({ outer: l, holes: [] }); owners.push(i); } });
  loops.forEach((l, i) => {
    if (depthOf[i] % 2 === 0) return;
    let best = -1; let bestArea = Infinity;
    owners.forEach((oi, k) => {
      if (depthOf[oi] !== depthOf[i] - 1 || !inside(l[0], loops[oi])) return;
      const a = Math.abs(polygonArea(loops[oi]));
      if (a < bestArea) { bestArea = a; best = k; }
    });
    if (best >= 0) shapes[best].holes.push(l);
  });
  // Typical stroke width ≈ 2·area / perimeter — what the bevel is sized against.
  let area = 0; let perim = 0;
  loops.forEach((l, i) => {
    area += depthOf[i] % 2 === 0 ? Math.abs(polygonArea(l)) : -Math.abs(polygonArea(l));
    for (let k = 0; k < l.length; k += 1) {
      const a = l[k]; const b = l[(k + 1) % l.length];
      perim += Math.hypot(b.x - a.x, b.y - a.y);
    }
  });
  return { shapes, strokeWidth: perim > 0 ? (2 * Math.max(0, area)) / perim : GLYPH_RASTER_PX * 0.1 };
}

const toShapePath = (pts, flip) => {
  // y DOWN → y UP for three (the mesh frame); points as a closed polyline.
  const list = pts.map((p) => new THREE.Vector2(p.x, flip ? -p.y : p.y));
  return list;
};

/**
 * Shared extruded geometry for one glyph, in RASTER px, oriented like the mesh
 * frame: x right, y UP, origin at the 2D draw origin, FRONT face on z = 0 and the
 * body behind it (z < 0). Material groups: 0 = front and back caps, 1 = sides.
 * `depth` and `bevel` are fractions of the font size. null for a blank glyph.
 */
export function glyphGeometry(fontCss, ch, depth, bevel, bevelSegments, fontVersion = 0) {
  // fontVersion: the engine's font-load counter — a glyph traced before its web font
  // arrived (in the fallback face) is never reused once the real one has landed.
  const key = `${rasterFontFor(fontCss)}|${ch}|${depth.toFixed(3)}|${bevel.toFixed(3)}|${bevelSegments}|${fontVersion}`;
  if (geometries.has(key)) {
    const hit = geometries.get(key);
    geometries.delete(key);
    geometries.set(key, hit); // most recently used last
    return hit;
  }
  const traced = traceGlyph(fontCss, ch);
  let out = null;
  if (traced) {
    const R = GLYPH_RASTER_PX;
    // The FACE is the 2D glyph's exact outline; the rounded bevel swells the sides
    // outward from it (a puffy, toy edge). Not inward: three offsets an inward bevel
    // with per-vertex miters, which folds a concave letter (an E's bars) over itself
    // and fills it solid. Capped at 35 % of the typical stroke so neighbouring
    // strokes stay apart.
    const bevelSize = Math.min(bevel * R, traced.strokeWidth * 0.35);
    const depthPx = Math.max(0.5, depth * R);
    const bevelThickness = bevelSize > 0.05 ? Math.min(bevelSize, depthPx * 0.5 + bevelSize * 0.5) : 0;
    const shapes = traced.shapes.map(({ outer, holes }) => {
      const s = new THREE.Shape(toShapePath(outer, true));
      for (const h of holes) s.holes.push(new THREE.Path(toShapePath(h, true)));
      return s;
    });
    const geometry = new THREE.ExtrudeGeometry(shapes, {
      depth: depthPx,
      steps: 1,
      curveSegments: 1,
      bevelEnabled: bevelSize > 0.05,
      bevelThickness,
      bevelSize,
      bevelOffset: 0,
      bevelSegments: Math.max(1, Math.round(bevelSegments)),
    });
    // Front cap (the +z one, toward the viewer) onto the plate plane.
    geometry.translate(0, 0, -(depthPx + bevelThickness));
    // Smooth across the bevel and the sides, crisp at the letter's corners.
    toCreasedNormals(geometry, (38 * Math.PI) / 180);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    out = { geometry };
  }
  geometries.set(key, out);
  while (geometries.size > GEOMETRY_LIMIT) {
    const oldest = geometries.keys().next().value;
    geometries.get(oldest)?.geometry?.dispose();
    geometries.delete(oldest);
  }
  return out;
}

/** Drop every cached glyph (fonts changed under us, or a context loss). */
export function clearGlyphGeometries() {
  for (const v of geometries.values()) v?.geometry?.dispose();
  geometries.clear();
}
