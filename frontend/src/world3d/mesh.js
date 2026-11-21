// MeshData helpers. A mesh is { position, normal, uv, index } in typed arrays, plus an optional `color` (3 per vertex) that
// only instanceRealize writes. Vertices are split wherever a normal or a uv changes, so "same point" always means "same
// position after weld()": every topological question in this folder is asked of welded positions, never of vertex indices.

import { DEG, det3, normalMatrix } from './mat.js';

const toF32 = (a) => (a instanceof Float32Array ? a : Float32Array.from(a));

export function makeMesh({ position, normal, uv, index, color } = {}) {
  const pos = toF32(position || []);
  const count = pos.length / 3;
  const mesh = {
    position: pos,
    normal: normal ? toF32(normal) : null,
    uv: uv ? toF32(uv) : new Float32Array(count * 2),
    index: index ? (index instanceof Uint32Array ? index : Uint32Array.from(index)) : Uint32Array.from({ length: count }, (_, i) => i),
  };
  if (color) mesh.color = toF32(color);
  return mesh.normal ? mesh : computeNormals(mesh);
}

export const emptyMesh = () => ({
  position: new Float32Array(0), normal: new Float32Array(0), uv: new Float32Array(0), index: new Uint32Array(0),
});

export const triangleCount = (mesh) => mesh.index.length / 3;

export function bounds(mesh) {
  const P = mesh.position;
  if (!P.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      const v = P[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/** Concatenates meshes. A colour on any of them means a colour on the result, white where it was missing. */
export function merge(meshes) {
  const list = meshes.filter((m) => m && m.index.length);
  if (!list.length) return emptyMesh();
  if (list.length === 1) return list[0];
  let nv = 0, ni = 0;
  for (const m of list) { nv += m.position.length / 3; ni += m.index.length; }
  const position = new Float32Array(nv * 3), normal = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const index = new Uint32Array(ni);
  const color = list.some((m) => m.color) ? new Float32Array(nv * 3).fill(1) : null;
  // A part without materials of its own wears the object's first.
  const slots = list.some((m) => m.slots) ? new Uint16Array(ni / 3) : null;
  // Vertex groups: weight 0 on a part that has none.
  const groups = {};
  for (const m of list) for (const key of groupKeysOf(m)) groups[key] ||= new Float32Array(nv);
  let v = 0, t = 0;
  for (const m of list) {
    position.set(m.position, v * 3);
    normal.set(m.normal, v * 3);
    uv.set(m.uv, v * 2);
    if (color && m.color) color.set(m.color, v * 3);
    if (slots && m.slots) slots.set(m.slots, t / 3);
    for (const key in groups) if (m[key]) groups[key].set(m[key], v);
    for (let i = 0; i < m.index.length; i += 1) index[t + i] = m.index[i] + v;
    v += m.position.length / 3;
    t += m.index.length;
  }
  const out = { position, normal, uv, index };
  if (color) out.color = color;
  if (slots) out.slots = slots;
  Object.assign(out, groups);
  // Region names: the first part to name a slot keeps the name.
  if (slots && list.some((m) => m.regions)) out.regions = Object.assign({}, ...list.map((m) => m.regions || {}).reverse());
  return out;
}

/** The vertex groups a mesh carries: Float32Arrays keyed 'group:<name>', one weight per vertex (ops/editKit.js). */
export function groupKeysOf(mesh) {
  const out = [];
  for (const key in mesh) if (key.startsWith('group:') && ArrayBuffer.isView(mesh[key])) out.push(key);
  return out;
}

export function transform(mesh, m) {
  const n = mesh.position.length / 3;
  const P = mesh.position, N = mesh.normal;
  const position = new Float32Array(n * 3), normal = new Float32Array(n * 3);
  const k = normalMatrix(m);
  for (let i = 0; i < n; i += 1) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    position[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
    position[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    position[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    const a = N[i * 3], b = N[i * 3 + 1], c = N[i * 3 + 2];
    const nx = k[0] * a + k[1] * b + k[2] * c, ny = k[3] * a + k[4] * b + k[5] * c, nz = k[6] * a + k[7] * b + k[8] * c;
    const len = Math.hypot(nx, ny, nz) || 1;
    normal[i * 3] = nx / len; normal[i * 3 + 1] = ny / len; normal[i * 3 + 2] = nz / len;
  }
  let index = mesh.index;
  if (det3(m) < 0) { // a mirror turns every triangle inside out
    index = index.slice();
    for (let i = 0; i < index.length; i += 3) { const t = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = t; }
  }
  return { ...mesh, position, normal, index };
}

/**
 * vertex -> first vertex at the same position. The table holds one entry per distinct point, and a point near a cell wall
 * also looks across it, so a rounding difference straddling a cell boundary cannot keep a seam open.
 */
export function weld(position, eps) {
  const n = position.length / 3;
  const ids = new Int32Array(n);
  if (!n) return ids;
  let tol = eps;
  if (tol == null) {
    const { min, max } = bounds({ position });
    tol = Math.max(1e-7, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 1e-6);
  }
  const inv = 1 / (tol * 4), tol2 = tol * tol;
  let size = 16;
  while (size < n * 2) size *= 2;
  const mask = size - 1;
  const head = new Int32Array(size).fill(-1), next = new Int32Array(n);
  const slot = (x, y, z) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
  for (let v = 0; v < n; v += 1) {
    const x = position[v * 3], y = position[v * 3 + 1], z = position[v * 3 + 2];
    const gx = x * inv, gy = y * inv, gz = z * inv;
    const ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz);
    const x0 = gx - ix < 0.25 ? ix - 1 : ix, x1 = gx - ix > 0.75 ? ix + 1 : ix;
    const y0 = gy - iy < 0.25 ? iy - 1 : iy, y1 = gy - iy > 0.75 ? iy + 1 : iy;
    const z0 = gz - iz < 0.25 ? iz - 1 : iz, z1 = gz - iz > 0.75 ? iz + 1 : iz;
    let found = -1;
    for (let a = x0; a <= x1 && found < 0; a += 1) {
      for (let b = y0; b <= y1 && found < 0; b += 1) {
        for (let c = z0; c <= z1 && found < 0; c += 1) {
          for (let u = head[slot(a, b, c)]; u >= 0; u = next[u]) {
            const dx = position[u * 3] - x, dy = position[u * 3 + 1] - y, dz = position[u * 3 + 2] - z;
            if (dx * dx + dy * dy + dz * dz <= tol2) { found = u; break; }
          }
        }
      }
    }
    if (found >= 0) { ids[v] = found; continue; }
    ids[v] = v;
    const s = slot(ix, iy, iz);
    next[v] = head[s];
    head[s] = v;
  }
  return ids;
}

/** Rebuilds a mesh from a list of source vertices. `index` already refers to positions in `source`. */
export function pickVertices(mesh, source, index) {
  const n = source.length;
  const position = new Float32Array(n * 3), normal = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  const color = mesh.color ? new Float32Array(n * 3) : null;
  const P = mesh.position, N = mesh.normal, U = mesh.uv, C = mesh.color;
  for (let i = 0; i < n; i += 1) {
    const s = source[i];
    position[i * 3] = P[s * 3]; position[i * 3 + 1] = P[s * 3 + 1]; position[i * 3 + 2] = P[s * 3 + 2];
    if (N) { normal[i * 3] = N[s * 3]; normal[i * 3 + 1] = N[s * 3 + 1]; normal[i * 3 + 2] = N[s * 3 + 2]; }
    uv[i * 2] = U[s * 2]; uv[i * 2 + 1] = U[s * 2 + 1];
    if (C) { color[i * 3] = C[s * 3]; color[i * 3 + 1] = C[s * 3 + 1]; color[i * 3 + 2] = C[s * 3 + 2]; }
  }
  const out = { position, normal, uv, index };
  if (color) out.color = color;
  for (const key of groupKeysOf(mesh)) {
    const W = mesh[key], w = new Float32Array(n);
    for (let i = 0; i < n; i += 1) w[i] = W[source[i]];
    out[key] = w;
  }
  return out;
}

/** Keeps only the vertices the index uses. */
export function compact(mesh, index = mesh.index) {
  const n = mesh.position.length / 3;
  const remap = new Int32Array(n).fill(-1);
  const source = [];
  const out = new Uint32Array(index.length);
  for (let i = 0; i < index.length; i += 1) {
    const v = index[i];
    if (remap[v] < 0) { remap[v] = source.length; source.push(v); }
    out[i] = remap[v];
  }
  return pickVertices(mesh, source, out);
}

/**
 * Merges vertices with the same position and uv (colour too), ignoring normals. For triangle soups, and for meshes whose
 * normals are about to be recomputed anyway.
 */
export function dedupe(mesh) {
  const n = mesh.position.length / 3;
  const P = mesh.position, U = mesh.uv, C = mesh.color;
  const buckets = new Map();
  const remap = new Int32Array(n);
  const source = [];
  const same = (a, b) => P[a * 3] === P[b * 3] && P[a * 3 + 1] === P[b * 3 + 1] && P[a * 3 + 2] === P[b * 3 + 2]
    && U[a * 2] === U[b * 2] && U[a * 2 + 1] === U[b * 2 + 1]
    && (!C || (C[a * 3] === C[b * 3] && C[a * 3 + 1] === C[b * 3 + 1] && C[a * 3 + 2] === C[b * 3 + 2]));
  for (let v = 0; v < n; v += 1) {
    const key = (Math.imul(Math.round(P[v * 3] * 4096), 73856093) ^ Math.imul(Math.round(P[v * 3 + 1] * 4096), 19349663)
      ^ Math.imul(Math.round(P[v * 3 + 2] * 4096), 83492791) ^ Math.imul(Math.round(U[v * 2] * 4096), 2654435761)) | 0;
    let bucket = buckets.get(key);
    if (!bucket) { bucket = []; buckets.set(key, bucket); }
    let found = -1;
    for (const b of bucket) if (same(source[b], v)) { found = b; break; }
    if (found < 0) { found = source.length; source.push(v); bucket.push(found); }
    remap[v] = found;
  }
  return pickVertices(mesh, source, mesh.index.map((v) => remap[v]));
}

const nextCorner = (c) => (c % 3 === 2 ? c - 2 : c + 1);

/**
 * Normals with an angle threshold and face weighting: Blender's Weighted Normal, the premium hard-surface look, where a big
 * flat face pulls its corners towards itself and stays flat right up to a small bevel. `angle` is the sharp-edge limit in
 * degrees. `weight` is 'area-angle', 'area', 'angle' or 'none'.
 *
 * 'area-angle' is the default because everything here is triangles. Blender weighs a whole quad; plain 'area' counts a quad
 * twice at a corner its diagonal runs through, so a low-poly cylinder's side normals all lean the same way. The corner angle
 * is split by that diagonal in step with the area, which cancels it out.
 *
 * Corners are grouped by walking across smooth edges only, so one vertex can land in several groups: a box corner is three
 * groups, and a sharp edge does not leak shading through a far-away smooth fan the way a plain dot-product test does.
 * Vertices are split per group, and existing uv seams stay split.
 */
export function computeNormals(mesh, { angle = 30, weight = 'area-angle' } = {}) {
  const P = mesh.position, I = mesh.index;
  const nv = P.length / 3, nc = I.length, nt = nc / 3;
  const ids = weld(P);
  const FN = new Float64Array(nt * 3), FA = new Float64Array(nt);
  for (let f = 0; f < nt; f += 1) {
    const a = I[f * 3] * 3, b = I[f * 3 + 1] * 3, c = I[f * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const len = Math.hypot(x, y, z);
    FA[f] = len / 2;
    if (len > 0) { FN[f * 3] = x / len; FN[f * 3 + 1] = y / len; FN[f * 3 + 2] = z / len; }
  }

  const parent = new Int32Array(nc);
  for (let i = 0; i < nc; i += 1) parent[i] = i;
  const find = (i) => {
    let c = i;
    while (parent[c] !== c) { parent[c] = parent[parent[c]]; c = parent[c]; }
    return c;
  };
  const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent[x < y ? y : x] = x < y ? x : y; };

  const limit = Math.cos(angle * DEG) - 1e-9;
  const edges = new Map(); // welded edge -> its first corner, or -1 once paired
  for (let c = 0; c < nc; c += 1) {
    const d = nextCorner(c);
    const a = ids[I[c]], b = ids[I[d]];
    if (a === b) continue;
    const key = a < b ? a * nv + b : b * nv + a;
    const o = edges.get(key);
    if (o === undefined) { edges.set(key, c); continue; }
    if (o < 0) continue; // a third face on the edge stays on its own side
    edges.set(key, -1);
    const f = (c / 3) | 0, g = (o / 3) | 0;
    const dot = FN[f * 3] * FN[g * 3] + FN[f * 3 + 1] * FN[g * 3 + 1] + FN[f * 3 + 2] * FN[g * 3 + 2];
    // A zero-area face has no opinion: let it join, or its corners would end up with no normal at all.
    if (FA[f] && FA[g] && dot < limit) continue;
    const od = nextCorner(o);
    if (ids[I[o]] === a) { union(c, o); union(d, od); } else { union(c, od); union(d, o); }
  }

  const sum = new Float64Array(nc * 3);
  for (let c = 0; c < nc; c += 1) {
    const f = (c / 3) | 0;
    let w = 1;
    if (weight === 'area' || weight === 'area-angle') w = FA[f];
    if (weight === 'angle' || weight === 'area-angle') w *= cornerAngle(P, I, c);
    const r = find(c);
    sum[r * 3] += FN[f * 3] * w; sum[r * 3 + 1] += FN[f * 3 + 1] * w; sum[r * 3 + 2] += FN[f * 3 + 2] * w;
  }

  const seen = new Map();
  const source = [], roots = [];
  const index = new Uint32Array(nc);
  for (let c = 0; c < nc; c += 1) {
    const r = find(c);
    const key = r * nv + I[c];
    let out = seen.get(key);
    if (out === undefined) { out = source.length; seen.set(key, out); source.push(I[c]); roots.push(r); }
    index[c] = out;
  }
  const result = pickVertices({ ...mesh, normal: null }, source, index);
  const N = result.normal;
  for (let v = 0; v < roots.length; v += 1) {
    const r = roots[v];
    let x = sum[r * 3], y = sum[r * 3 + 1], z = sum[r * 3 + 2];
    let len = Math.hypot(x, y, z);
    if (len < 1e-30) { // opposing faces cancel out, or everything here has zero area
      const f = (r / 3) | 0;
      x = FN[f * 3]; y = FN[f * 3 + 1]; z = FN[f * 3 + 2];
      len = Math.hypot(x, y, z);
      if (len === 0) { x = 0; y = 1; z = 0; len = 1; }
    }
    N[v * 3] = x / len; N[v * 3 + 1] = y / len; N[v * 3 + 2] = z / len;
  }
  return result;
}

function cornerAngle(P, I, c) {
  const o = I[c] * 3, a = I[nextCorner(c)] * 3, b = I[nextCorner(nextCorner(c))] * 3;
  const ux = P[a] - P[o], uy = P[a + 1] - P[o + 1], uz = P[a + 2] - P[o + 2];
  const vx = P[b] - P[o], vy = P[b + 1] - P[o + 1], vz = P[b + 2] - P[o + 2];
  const len = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz);
  if (!len) return 0;
  const cos = (ux * vx + uy * vy + uz * vz) / len;
  return Math.acos(cos < -1 ? -1 : cos > 1 ? 1 : cos);
}

/** Edge census on welded positions: closed = every edge has exactly two faces, running opposite ways. */
export function edgeStats(mesh) {
  const I = mesh.index;
  const ids = weld(mesh.position);
  const nv = mesh.position.length / 3;
  const edges = new Map(); // key -> [faces, direction sum]
  for (let c = 0; c < I.length; c += 1) {
    const a = ids[I[c]], b = ids[I[nextCorner(c)]];
    if (a === b) continue;
    const key = a < b ? a * nv + b : b * nv + a;
    let e = edges.get(key);
    if (!e) { e = [0, 0]; edges.set(key, e); }
    e[0] += 1;
    e[1] += a < b ? 1 : -1;
  }
  let boundary = 0, nonManifold = 0, flipped = 0;
  for (const [faces, dir] of edges.values()) {
    if (faces === 1) boundary += 1;
    else if (faces > 2) nonManifold += 1;
    else if (dir !== 0) flipped += 1;
  }
  return { edges: edges.size, boundary, nonManifold, flipped, closed: boundary === 0 && nonManifold === 0 && flipped === 0 };
}

export const isClosed = (mesh) => edgeStats(mesh).closed;

export function surfaceArea(mesh) {
  const P = mesh.position, I = mesh.index;
  let area = 0;
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return area;
}

/** Signed volume by the divergence theorem. Positive for a closed mesh with outward faces. */
export function volume(mesh) {
  const P = mesh.position, I = mesh.index;
  let sum = 0;
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
    sum += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
      + P[a + 1] * (P[b + 2] * P[c] - P[b] * P[c + 2])
      + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return sum / 6;
}
