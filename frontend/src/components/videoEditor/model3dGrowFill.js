import * as THREE from 'three';
import { materials as makeMaterial } from './materialFactory';
import { getRampTexture, sanitizeEffectGradient } from './adjustmentEffects';
import { splitEdgeColor } from './autoFillLayer';

/*
 * Grow Fill on 3D models — the REAL 3D version.
 *
 * Instead of the 2D screen-space field (which infects the projected silhouette),
 * this bakes a geodesic arrival-time field OVER THE MESH SURFACE: vertices are
 * welded across UV/normal seams and touching meshes, edges come from the
 * triangles (weights = 3D length × 1/speed), and a multi-source Dijkstra runs
 * from the seed vertices. The per-vertex arrival rides the geometry through
 * skinning, morphs, rotation and the camera — the front creeps around the
 * surface and respects occlusion, because it IS on the surface.
 *
 * Injection strategy (see model3dLayer.js:776 — clones SHARE geometries and
 * materials with the cached asset): per entry we alias each mesh's geometry
 * (attributes shared by reference + our own aGrowArrival) and clone its
 * material with onBeforeCompile; originals are recorded and restored on
 * removal/dispose, mirroring the applyScreen originals pattern.
 *
 * Bake cache is keyed by (asset url + bake params + seeds), so two layers of
 * the same model with the same settings share one Dijkstra run. Seeds live in
 * ROOT-LOCAL space ({x,y,z,delay} on the effect entry's points3d), which
 * survives layer transforms, fit modes, and comp resizes.
 */

const MAX_BAKES = 4;
const NORM_SCALE = 0.98;
const bakeCache = new Map(); // key -> { byGeometry: Map(geometry.uuid -> Float32Array), span }
let bakeSeq = 0;

// ── Deterministic 3D value noise (bake-side twin of the shader's) ───────────
function ihash3(x, y, z, s) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + s * 974711369) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise3(x, y, z, s) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let xf = x - xi, yf = y - yi, zf = z - zi;
  xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf); zf = zf * zf * (3 - 2 * zf);
  const c = (dx, dy, dz) => ihash3(xi + dx, yi + dy, zi + dz, s);
  const lerp = (a, b, t) => a + (b - a) * t;
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), xf), lerp(c(0, 1, 0), c(1, 1, 0), xf), yf),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), xf), lerp(c(0, 1, 1), c(1, 1, 1), xf), yf),
    zf
  );
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Graph build ─────────────────────────────────────────────────────────────
// Collect every mesh under root; weld vertices by quantised ROOT-LOCAL position
// so infection crosses UV seams, material splits and touching meshes.

function collectMeshes(root) {
  const meshes = [];
  root.updateWorldMatrix(true, true);
  const invRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  root.traverse((n) => {
    if (!n.isMesh || !n.geometry?.attributes?.position) return;
    const toRoot = new THREE.Matrix4().multiplyMatrices(invRoot, n.matrixWorld);
    meshes.push({ mesh: n, geometry: n.geometry, toRoot });
  });
  return meshes;
}

function buildGraph(meshes) {
  // First pass: bounds for the weld quantum.
  const bounds = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += Math.max(1, Math.floor(pos.count / 500))) {
      bounds.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m.toRoot));
    }
  }
  const diag = Math.max(bounds.getSize(new THREE.Vector3()).length(), 1e-6);
  const q = diag * 2e-4;

  const nodeIds = new Map();      // quantised key -> node id
  const nodePos = [];             // flat xyz per node (root-local)
  const vertNode = [];            // per mesh: Int32Array vertex -> node
  const adj = [];                 // node -> [nodeB, len, nodeC, len, ...]
  const nodeOf = (x, y, z) => {
    const key = `${Math.round(x / q)},${Math.round(y / q)},${Math.round(z / q)}`;
    let id = nodeIds.get(key);
    if (id === undefined) {
      id = nodePos.length / 3;
      nodeIds.set(key, id);
      nodePos.push(x, y, z);
      adj.push([]);
    }
    return id;
  };
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    const map = new Int32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.toRoot);
      map[i] = nodeOf(v.x, v.y, v.z);
    }
    vertNode.push(map);
    const index = m.geometry.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    const at = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    const edge = (a, b) => {
      if (a === b) return;
      const dx = nodePos[a * 3] - nodePos[b * 3];
      const dy = nodePos[a * 3 + 1] - nodePos[b * 3 + 1];
      const dz = nodePos[a * 3 + 2] - nodePos[b * 3 + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      adj[a].push(b, len);
      adj[b].push(a, len);
    };
    for (let t = 0; t < triCount; t++) {
      const a = map[at(t, 0)], b = map[at(t, 1)], c = map[at(t, 2)];
      edge(a, b); edge(b, c); edge(c, a);
    }
  }
  return { nodePos, vertNode, adj, diag, bounds };
}

// Bridges: connect disconnected surface components whose nearest sampled
// points sit within reach, at a slowness-scaled cost — the fill can jump a
// small gap (a floating button, a detached letter) with a time toll.
function addBridges(graph, reachFrac, slow) {
  const n = graph.adj.length;
  const comp = new Int32Array(n).fill(-1);
  let comps = 0;
  const stack = [];
  for (let i = 0; i < n; i++) {
    if (comp[i] >= 0) continue;
    stack.push(i); comp[i] = comps;
    while (stack.length) {
      const a = stack.pop();
      const row = graph.adj[a];
      for (let k = 0; k < row.length; k += 2) {
        const b = row[k];
        if (comp[b] < 0) { comp[b] = comps; stack.push(b); }
      }
    }
    comps++;
  }
  if (comps <= 1) return;
  const reach = graph.diag * reachFrac;
  // Sample up to 160 nodes per component, brute-force nearest pairs.
  const samples = Array.from({ length: comps }, () => []);
  for (let i = 0; i < n; i++) {
    const s = samples[comp[i]];
    if (s.length < 160) s.push(i);
    else if (i % 7 === 0) s[(i / 7) % 160 | 0] = i;
  }
  for (let a = 0; a < comps; a++) {
    for (let b = a + 1; b < comps; b++) {
      let best = Infinity, bi = -1, bj = -1;
      for (const i of samples[a]) {
        for (const j of samples[b]) {
          const dx = graph.nodePos[i * 3] - graph.nodePos[j * 3];
          const dy = graph.nodePos[i * 3 + 1] - graph.nodePos[j * 3 + 1];
          const dz = graph.nodePos[i * 3 + 2] - graph.nodePos[j * 3 + 2];
          const d = dx * dx + dy * dy + dz * dz;
          if (d < best) { best = d; bi = i; bj = j; }
        }
      }
      const dist = Math.sqrt(best);
      if (bi >= 0 && dist <= reach) {
        graph.adj[bi].push(bj, dist * slow);
        graph.adj[bj].push(bi, dist * slow);
      }
    }
  }
}

function nearestNode(graph, x, y, z) {
  let best = -1, bd = Infinity;
  const n = graph.adj.length;
  for (let i = 0; i < n; i++) {
    const dx = graph.nodePos[i * 3] - x;
    const dy = graph.nodePos[i * 3 + 1] - y;
    const dz = graph.nodePos[i * 3 + 2] - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function synthesizeSeeds3d(graph, bake) {
  const seeds = [];
  if (bake.points && bake.points.length) {
    for (const p of bake.points) {
      const idx = nearestNode(graph, Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0);
      if (idx >= 0) seeds.push({ idx, delay: Math.min(1, Math.max(0, Number(p.delay) || 0)) });
    }
    if (seeds.length) return seeds;
  }
  const n = graph.adj.length;
  if (!n) return seeds;
  const count = Math.max(1, Math.min(8, Math.round(bake.seedCount)));
  const rng = mulberry32(1013 + bake.seedSeed * 7919);
  const mode = bake.seedMode; // 0 Left 1 Center 2 Right 3 Top 4 Bottom 5 Scatter
  const picked = [];
  if (mode === 5) {
    for (let k = 0; k < count; k++) picked.push((rng() * n) | 0);
  } else if (mode === 1) {
    const c = graph.bounds.getCenter(new THREE.Vector3());
    picked.push(nearestNode(graph, c.x, c.y, c.z));
    for (let k = 1; k < count; k++) picked.push((rng() * n) | 0);
  } else {
    // Root-local axes: Left/Right = ∓x, Top/Bottom = ±y.
    const axis = mode === 3 || mode === 4 ? 1 : 0;
    const flip = mode === 2 || mode === 3; // Right = +x, Top = +y
    let bestV = flip ? -Infinity : Infinity;
    for (let i = 0; i < n; i++) {
      const val = graph.nodePos[i * 3 + axis];
      if (flip ? val > bestV : val < bestV) bestV = val;
    }
    const band = [];
    const tol = graph.diag * 0.06;
    for (let i = 0; i < n; i++) {
      if (Math.abs(graph.nodePos[i * 3 + axis] - bestV) <= tol) band.push(i);
    }
    for (let k = 0; k < count; k++) {
      picked.push(band.length ? band[(rng() * band.length) | 0] : (rng() * n) | 0);
    }
  }
  const stagger = Math.max(0, Math.min(100, bake.seedStagger)) / 100;
  return picked.filter((i) => i >= 0).map((idx, i) => ({
    idx,
    delay: count > 1 ? stagger * (i / (count - 1)) : 0,
  }));
}

function bakeSurfaceField(meshes, bake) {
  const graph = buildGraph(meshes);
  const n = graph.adj.length;
  if (!n) return null;
  if (bake.bridges >= 0.5) {
    addBridges(graph, (Math.max(0, bake.bridgeReach) / 60) * 0.25, Math.max(1, bake.bridgeSlow));
  }

  // Per-node speed. Shape Flow has no 3D analogue (no "distance to silhouette
  // boundary" on a closed surface), so modes 2/3 degrade to Uniform/Turbulent.
  const turbulent = bake.speedType === 1 || bake.speedType === 3;
  const speed = new Float32Array(n).fill(1);
  if (turbulent) {
    const wavelength = Math.max(graph.diag * (bake.noiseScale / 400), graph.diag * 0.02);
    const contrast = Math.max(0, Math.min(100, bake.noiseContrast)) / 100;
    for (let i = 0; i < n; i++) {
      const x = graph.nodePos[i * 3] / wavelength;
      const y = graph.nodePos[i * 3 + 1] / wavelength;
      const z = graph.nodePos[i * 3 + 2] / wavelength;
      const nz = vnoise3(x, y, z, bake.noiseSeed) * 0.55
        + vnoise3(x * 2.03, y * 2.03, z * 2.03, bake.noiseSeed + 11) * 0.45;
      speed[i] = Math.max(1 - contrast * 0.92 * (1 - Math.min(Math.max(nz, 0), 1)), 0.06);
    }
  }

  const seeds = synthesizeSeeds3d(graph, bake);
  const dist = new Float64Array(n).fill(Infinity);
  const cap = Math.max(n * 8, 1024);
  const heapT = new Float64Array(cap);
  const heapI = new Int32Array(cap);
  let hn = 0;
  const push = (t, i) => {
    if (hn >= cap) return;
    let j = hn++; heapT[j] = t; heapI[j] = i;
    while (j > 0) {
      const p = (j - 1) >> 1;
      if (heapT[p] <= heapT[j]) break;
      const tt = heapT[p], ti = heapI[p];
      heapT[p] = heapT[j]; heapI[p] = heapI[j]; heapT[j] = tt; heapI[j] = ti; j = p;
    }
  };
  const run = (seedList) => {
    dist.fill(Infinity); hn = 0;
    for (const s of seedList) {
      if (s.idx < 0 || s.idx >= n) continue;
      if (s.t0 < dist[s.idx]) { dist[s.idx] = s.t0; push(s.t0, s.idx); }
    }
    while (hn > 0) {
      const t = heapT[0], i = heapI[0];
      hn--;
      heapT[0] = heapT[hn]; heapI[0] = heapI[hn];
      let j = 0;
      for (;;) {
        const l = j * 2 + 1, r = l + 1; let m = j;
        if (l < hn && heapT[l] < heapT[m]) m = l;
        if (r < hn && heapT[r] < heapT[m]) m = r;
        if (m === j) break;
        const tt = heapT[m], ti = heapI[m];
        heapT[m] = heapT[j]; heapI[m] = heapI[j]; heapT[j] = tt; heapI[j] = ti; j = m;
      }
      if (t > dist[i]) continue;
      const row = graph.adj[i];
      const ci = 1 / speed[i];
      for (let k = 0; k < row.length; k += 2) {
        const b = row[k];
        const nt = t + row[k + 1] * (ci + 1 / speed[b]) * 0.5;
        if (nt < dist[b]) { dist[b] = nt; push(nt, b); }
      }
    }
    let mx = 0;
    for (let i = 0; i < n; i++) if (isFinite(dist[i]) && dist[i] > mx) mx = dist[i];
    return mx;
  };
  let span = run(seeds.map((s) => ({ idx: s.idx, t0: 0 })));
  if (seeds.some((s) => s.delay > 0) && span > 0) {
    span = run(seeds.map((s) => ({ idx: s.idx, t0: s.delay * span })));
  }
  span = Math.max(span, 1e-9);

  // One Laplacian smoothing pass over the graph — same role as the 2D bake's
  // masked blur: rounds the metric's faceting without moving the front.
  const smooth = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!isFinite(dist[i])) { smooth[i] = dist[i]; continue; }
    let s = dist[i] * 2, w = 2;
    const row = graph.adj[i];
    for (let k = 0; k < row.length; k += 2) {
      const d = dist[row[k]];
      if (isFinite(d)) { s += d; w += 1; }
    }
    smooth[i] = s / w;
  }

  // Scatter back to per-original-vertex arrays, keyed by the SHARED geometry
  // uuid (clones alias the asset's geometries, so the same bake serves every
  // layer of the same model).
  const byGeometry = new Map();
  meshes.forEach((m, mi) => {
    const map = graph.vertNode[mi];
    const out = new Float32Array(map.length);
    for (let i = 0; i < map.length; i++) {
      const d = smooth[map[i]];
      out[i] = isFinite(d) ? (d / span) * NORM_SCALE : 1;
    }
    byGeometry.set(m.geometry.uuid, out);
  });
  return { byGeometry, span };
}

function bakeKey(url, bake) {
  const pts = (bake.points || [])
    .map((p) => `${(+p.x).toFixed(5)},${(+p.y).toFixed(5)},${(+p.z).toFixed(5)},${(+p.delay || 0).toFixed(3)}`)
    .join(';');
  return `${url}|${bake.seedMode},${bake.seedCount},${bake.seedSeed},${bake.seedStagger},${bake.speedType},${bake.noiseScale},${bake.noiseContrast},${bake.noiseSeed},${bake.bridges},${bake.bridgeReach},${bake.bridgeSlow}|${pts}`;
}

function getBake(entry, bake) {
  const key = bakeKey(entry.url, bake);
  let hit = bakeCache.get(key);
  if (!hit) {
    // Bake against the ORIGINAL geometries. After the first injection each mesh
    // carries an ALIAS geometry (aliasGeometry() builds a new BufferGeometry, so
    // a new uuid), and bakeSurfaceField keys its output by mesh.geometry.uuid —
    // while the injection below looks the field up under the original's uuid via
    // state.originals. Baking off the live meshes therefore filed every re-bake
    // under a uuid nobody reads, `if (!arrival) return` fired, and the layer kept
    // its FIRST field for life: every param in bakeKey() (seed mode/count/seed/
    // stagger, speed type, the 3 noise knobs, the 3 bridge knobs, manual points)
    // silently did nothing after the first bake.
    // collectMeshes returns plain records { mesh, geometry, toRoot }; state.originals
    // is keyed by the mesh NODE, so look up through m.mesh.
    const originals = entry.growState?.originals;
    const meshes = collectMeshes(entry.root).map((m) => {
      const orig = originals?.get(m.mesh)?.geometry;
      return orig && orig !== m.geometry ? { ...m, geometry: orig } : m;
    });
    const baked = bakeSurfaceField(meshes, bake);
    if (!baked) return null;
    hit = { ...baked, lastUsed: 0 };
    if (bakeCache.size >= MAX_BAKES) {
      let oldestKey = null, oldest = Infinity;
      for (const [k, v2] of bakeCache) if (v2.lastUsed < oldest) { oldest = v2.lastUsed; oldestKey = k; }
      if (oldestKey) bakeCache.delete(oldestKey);
    }
    bakeCache.set(key, hit);
  }
  hit.lastUsed = bakeSeq++;
  return { key, bake: hit };
}

// ── Material injection ──────────────────────────────────────────────────────

const GROW_FRAG_DECL = /* glsl */ `
varying float vGrowArr;
varying vec3 vGrowPos;
uniform float uGrowOn;
uniform float uGrowProgress;
uniform float uGrowMode;
uniform float uGrowStyle;
uniform float uGrowLoops;
uniform float uGrowFlow;
uniform float uGrowSoft;
uniform float uGrowWavAmp;
uniform float uGrowWavScale;
uniform float uGrowFeW;
uniform float uGrowFeMode;
uniform float uGrowFeGlowW;
uniform float uGrowFeGlowI;
uniform float uGrowBeOn;
uniform float uGrowBeOff;
uniform float uGrowBeW;
uniform float uGrowBeMode;
uniform float uGrowBeGlowW;
uniform float uGrowBeGlowI;
uniform float uGrowNoiseFreq;
uniform vec3 uGrowFillColor;
uniform vec3 uGrowFeColor;
uniform float uGrowFeAlpha;
uniform vec3 uGrowBeColor;
uniform float uGrowBeAlpha;
uniform sampler2D uGrowRamp;
uniform sampler2D uGrowRampFE;
uniform sampler2D uGrowRampBE;
float growHash(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float growVn(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = mix(growHash(i), growHash(i + vec3(1,0,0)), f.x);
  float b = mix(growHash(i + vec3(0,1,0)), growHash(i + vec3(1,1,0)), f.x);
  float c = mix(growHash(i + vec3(0,0,1)), growHash(i + vec3(1,0,1)), f.x);
  float d = mix(growHash(i + vec3(0,1,1)), growHash(i + vec3(1,1,1)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}
`;

// px-authored sliders map onto the normalised arrival span: /300 keeps the lab
// defaults feeling the same on a surface as they do on a text plate.
const GROW_FRAG_APPLY = /* glsl */ `
if (uGrowOn > 0.5 && vGrowArr < 0.995) {
  float softN = uGrowSoft / 300.0;
  float wavN = uGrowWavAmp / 300.0;
  float pad = softN + wavN + 0.03;
  float endPad = pad + (uGrowBeOn > 0.5 ? uGrowBeOff / 300.0 : 0.0);
  float p = -pad + clamp(uGrowProgress, 0.0, 1.0) * (0.98 + pad + endPad);
  float wn = growVn(vGrowPos * uGrowNoiseFreq + vec3(uGrowProgress * uGrowFlow * 0.7, 0.0, 0.0)) - 0.5;
  float arrE = vGrowArr + wn * 2.0 * wavN;
  float soft = max(softN, 0.002);
  float fillW = 1.0 - smoothstep(p - soft, p + soft, arrE);
  vec3 styleCol = uGrowFillColor;
  if (uGrowStyle > 0.5 && uGrowStyle < 1.5) {
    float age = clamp((p - arrE) / 0.35, 0.0, 1.0);
    styleCol = texture2D(uGrowRamp, vec2(1.0 - age, 0.5)).rgb;
  } else if (uGrowStyle > 1.5 && uGrowStyle < 2.5) {
    float ph = fract(arrE * uGrowLoops - uGrowProgress * uGrowFlow);
    styleCol = texture2D(uGrowRamp, vec2(ph, 0.5)).rgb;
  } else if (uGrowStyle > 2.5 && uGrowStyle < 3.5) {
    styleCol = uGrowFillColor * (growVn(vGrowPos * uGrowNoiseFreq * 4.0) * 0.9 + 0.25);
  }
  float aa = 0.005;
  float feHalf = uGrowFeW * 0.5 / 300.0;
  float feBand = uGrowFeW < 0.5 ? 0.0 : 1.0 - smoothstep(feHalf - aa, feHalf + aa, abs(arrE - p));
  float feT = clamp((p + feHalf - arrE) / max(feHalf * 2.0, 1e-5), 0.0, 1.0);
  vec3 feCol = uGrowFeMode > 0.5 ? texture2D(uGrowRampFE, vec2(feT, 0.5)).rgb : uGrowFeColor;
  float feGw = max(uGrowFeGlowW / 300.0, 1e-3);
  float feGlow = uGrowFeGlowW < 0.5 ? 0.0 : exp(-abs(arrE - p) / feGw) * uGrowFeGlowI;
  float beC = p - uGrowBeOff / 300.0;
  float beHalf = uGrowBeW * 0.5 / 300.0;
  float beBand = (uGrowBeOn < 0.5 || uGrowBeW < 0.5) ? 0.0 : 1.0 - smoothstep(beHalf - aa, beHalf + aa, abs(arrE - beC));
  float beT = clamp((beC + beHalf - arrE) / max(beHalf * 2.0, 1e-5), 0.0, 1.0);
  vec3 beCol = uGrowBeMode > 0.5 ? texture2D(uGrowRampBE, vec2(beT, 0.5)).rgb : uGrowBeColor;
  float beGw = max(uGrowBeGlowW / 300.0, 1e-3);
  float beGlow = (uGrowBeOn < 0.5 || uGrowBeGlowW < 0.5) ? 0.0 : exp(-abs(arrE - beC) / beGw) * uGrowBeGlowI;
  float paint = uGrowStyle > 3.5 ? 0.0 : fillW;
  if (uGrowMode < 0.5) {
    gl_FragColor.rgb = mix(gl_FragColor.rgb, styleCol, paint);
  } else if (uGrowMode < 1.5) {
    gl_FragColor.a *= (1.0 - fillW);
  } else {
    gl_FragColor.a *= fillW;
  }
  // The edge bands carry their colour's opacity, exactly as they do on a 2D
  // layer — one control cannot mean two things depending on the layer type.
  gl_FragColor.rgb = mix(gl_FragColor.rgb, beCol, beBand * uGrowBeAlpha);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, feCol, feBand * uGrowFeAlpha);
  gl_FragColor.rgb += beCol * beGlow;
  gl_FragColor.rgb += feCol * feGlow;
}
`;

/*
 * Exported so the null-binding test can build a material in PRODUCTION ORDER —
 * from a fresh, all-null uniform set. The lab used to construct the WebGL
 * material first, which populated the ramps before the TSL material existed and
 * hid a `texture(null)` build failure behind an ordering accident.
 */
export function makeGrowUniforms() {
  return {
    uGrowOn: { value: 0 },
    uGrowProgress: { value: 0 },
    uGrowMode: { value: 0 },
    uGrowStyle: { value: 0 },
    uGrowLoops: { value: 3 },
    uGrowFlow: { value: 1 },
    uGrowSoft: { value: 6 },
    uGrowWavAmp: { value: 8 },
    uGrowWavScale: { value: 60 },
    uGrowFeW: { value: 0 },
    uGrowFeMode: { value: 0 },
    uGrowFeGlowW: { value: 14 },
    uGrowFeGlowI: { value: 0.8 },
    uGrowBeOn: { value: 0 },
    uGrowBeOff: { value: 60 },
    uGrowBeW: { value: 4 },
    uGrowBeMode: { value: 0 },
    uGrowBeGlowW: { value: 10 },
    uGrowBeGlowI: { value: 0.6 },
    uGrowNoiseFreq: { value: 1 },
    uGrowFillColor: { value: new THREE.Color('#7dd3c0') },
    uGrowFeColor: { value: new THREE.Color('#ffd9a0') },
    uGrowFeAlpha: { value: 1 },
    uGrowBeColor: { value: new THREE.Color('#ffffff') },
    uGrowBeAlpha: { value: 1 },
    uGrowRamp: { value: null },
    uGrowRampFE: { value: null },
    uGrowRampBE: { value: null },
  };
}

function aliasGeometry(src, arrival) {
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) g.setAttribute(name, attr);
  if (src.index) g.setIndex(src.index);
  g.groups = src.groups;
  g.morphAttributes = src.morphAttributes;
  g.morphTargetsRelative = src.morphTargetsRelative;
  g.boundingBox = src.boundingBox;
  g.boundingSphere = src.boundingSphere;
  g.setAttribute('aGrowArrival', new THREE.BufferAttribute(arrival, 1));
  return g;
}

function injectMaterial(srcMat, uniforms) {
  const mat = srcMat.clone();
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGrowArrival;\nvarying float vGrowArr;\nvarying vec3 vGrowPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGrowArr = aGrowArrival;\nvGrowPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GROW_FRAG_DECL)
      .replace('#include <dithering_fragment>', GROW_FRAG_APPLY + '\n#include <dithering_fragment>');
  };
  // Three's program cache would otherwise hand this material the un-injected
  // program of a parameter-identical sibling (no precedent in the app — first
  // onBeforeCompile user).
  mat.customProgramCacheKey = () => 'growFill3d';
  return mat;
}

// ── Per-entry apply / remove (called every frame from renderModelLayer) ─────

export function applyModelGrowFill(entry, growFill, renderer = null) {
  if (!entry?.root) return;
  if (!growFill) {
    removeModelGrowFill(entry);
    return;
  }
  const { params, progress01 } = growFill;
  const bakeParams = {
    seedMode: params.afSeedMode, seedCount: params.afSeedCount, seedSeed: params.afSeedSeed,
    seedStagger: params.afSeedStagger, speedType: params.afSpeedType,
    noiseScale: params.afNoiseScale, noiseContrast: params.afNoiseContrast, noiseSeed: params.afNoiseSeed,
    bridges: params.afBridges, bridgeReach: params.afBridgeReach, bridgeSlow: params.afBridgeSlow,
    points: params.points3d || [],
  };
  const baked = getBake(entry, bakeParams);
  if (!baked) return;

  let state = entry.growState;
  if (!state || state.bakeKey !== baked.key) {
    // (Re)inject. Materials are injected once and reused across rebakes; a
    // rebake only refreshes the arrival attribute IN PLACE (never dispose an
    // aliased geometry — its position/normal/skin buffers are the asset's
    // shared originals, and disposing would tear them down for every layer).
    const prev = state;
    state = prev || {
      uniforms: makeGrowUniforms(),
      originals: new Map(),
      materials: new Map(), // src material uuid -> injected clone
    };
    state.bakeKey = baked.key;
    entry.root.traverse((n) => {
      if (!n.isMesh || !n.geometry?.attributes?.position) return;
      const srcGeo = state.originals.get(n)?.geometry || n.geometry;
      const arrival = baked.bake.byGeometry.get(srcGeo.uuid);
      if (!arrival) return;
      if (!state.originals.has(n)) {
        state.originals.set(n, { geometry: n.geometry, material: n.material });
      }
      const existing = n.geometry.attributes?.aGrowArrival;
      if (existing && existing.count === arrival.length) {
        existing.array.set(arrival);
        existing.needsUpdate = true;
      } else if (n.geometry === state.originals.get(n).geometry) {
        n.geometry = aliasGeometry(srcGeo, arrival);
      } else {
        n.geometry.setAttribute('aGrowArrival', new THREE.BufferAttribute(arrival, 1));
      }
      const srcMat = state.originals.get(n).material;
      const key = Array.isArray(srcMat) ? null : srcMat.uuid;
      if (key) {
        let injected = state.materials.get(key);
        if (!injected) {
          // The node twin is a full material, not an injection: TSL has no
          // onBeforeCompile, and WebGPU never calls it anyway. It still ADOPTS
          // srcMat rather than replacing it, so the asset's maps survive — hence
          // the renderer, which owns the conversion.
          injected = makeMaterial.modelGrowFill(state.uniforms, srcMat, renderer)
            ?? injectMaterial(srcMat, state.uniforms);
          state.materials.set(key, injected);
        }
        n.material = injected;
      }
    });
    entry.growState = state;
  }

  const u = state.uniforms;
  u.uGrowOn.value = 1;
  u.uGrowProgress.value = progress01;
  u.uGrowMode.value = params.afMode;
  u.uGrowStyle.value = params.afStyle;
  u.uGrowLoops.value = params.afLoops;
  u.uGrowFlow.value = params.afFlow;
  u.uGrowSoft.value = params.afSoftness;
  u.uGrowWavAmp.value = params.afWavAmp;
  u.uGrowWavScale.value = params.afWavScale;
  u.uGrowFeW.value = params.afFeWidth;
  u.uGrowFeMode.value = params.afFeColorMode;
  u.uGrowFeGlowW.value = params.afFeGlowW;
  u.uGrowFeGlowI.value = params.afFeGlowI / 100;
  u.uGrowBeOn.value = params.afBeEnable;
  u.uGrowBeOff.value = params.afBeOffset;
  u.uGrowBeW.value = params.afBeWidth;
  u.uGrowBeMode.value = params.afBeColorMode;
  u.uGrowBeGlowW.value = params.afBeGlowW;
  u.uGrowBeGlowI.value = params.afBeGlowI / 100;
  u.uGrowFillColor.value.set(params.afFillColor);
  const fe3 = splitEdgeColor(params.afFeColor);
  const be3 = splitEdgeColor(params.afBeColor);
  u.uGrowFeColor.value.set(fe3.rgb);
  u.uGrowFeAlpha.value = fe3.alpha;
  u.uGrowBeColor.value.set(be3.rgb);
  u.uGrowBeAlpha.value = be3.alpha;
  u.uGrowRamp.value = getRampTexture(sanitizeEffectGradient(params.afRamp), 0);
  u.uGrowRampFE.value = getRampTexture(sanitizeEffectGradient(params.afFeRamp), 0);
  u.uGrowRampBE.value = getRampTexture(sanitizeEffectGradient(params.afBeRamp), 0);
  // Waviness/noise frequency in root-local units: wave scale rides the model's
  // own size (bbox diag baked into the entry box).
  const size = entry.box?.getSize ? entry.box.getSize(new THREE.Vector3()).length() : 1;
  u.uGrowNoiseFreq.value = 1 / Math.max((size || 1) * (params.afWavScale / 400), 1e-6);

  // Unfill/Reveal cut alpha — the materials must blend for that to show.
  const wantsAlpha = params.afMode > 0.5;
  for (const mat of state.materials.values()) {
    // The node twin holds its own uniform() objects seeded from `state.uniforms`;
    // every scalar above REPLACES `.value` on the app's object rather than
    // mutating it, so the twin needs the mirror. Colours are wrapped by
    // reference and need none. A no-op on the GLSL path.
    mat.syncGrowUniforms?.();
    if (mat.transparent !== wantsAlpha && !mat.userData.growWasTransparent) {
      if (mat.transparent && !wantsAlpha) mat.transparent = mat.userData.growSrcTransparent || false;
      else if (wantsAlpha) {
        mat.userData.growSrcTransparent = mat.transparent;
        mat.transparent = true;
      }
    }
  }
}

export function removeModelGrowFill(entry) {
  const state = entry?.growState;
  if (!state) return;
  for (const [mesh, orig] of state.originals) {
    // NEVER dispose the aliased geometry — its heavy attributes are the shared
    // asset originals; three's dispose would deallocate their GL buffers for
    // every layer using this model. The alias objects are tiny and the entry
    // lives for the session anyway.
    mesh.geometry = orig.geometry;
    mesh.material = orig.material;
  }
  // Cloned materials own only their programs (textures stay shared and are NOT
  // disposed by material.dispose()).
  for (const mat of state.materials.values()) mat.dispose();
  entry.growState = null;
}
