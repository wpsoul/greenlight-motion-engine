import * as THREE from 'three';
import { materials as makeMaterial } from './materialFactory';
import { trackBake } from './asyncBakes';
import { readTargetPixels } from './readTargetPixels';

/*
 * Auto Fill — CPU-baked geodesic arrival-time field.
 *
 * The effect needs "how long does an infection front take to reach this pixel,
 * travelling only through the layer's alpha" — a geodesic distance no GPU pass
 * computes cheaply (JFA is Euclidean and leaps across letter gaps). So the field
 * is baked here: the layer's matte is cropped to its box quad, downsampled to a
 * small grid, and a multi-source Dijkstra propagates arrival times from
 * procedurally-placed seeds. The result is packed into an RGBA8 DataTexture
 * (16-bit arrival hi/lo in R/G, mask/bridge in B, speed in A) that the shader
 * thresholds against the keyframable `progress` — so per-frame cost is one
 * texture sample and the bake reruns only when the silhouette or a bake-side
 * param actually changes.
 *
 * Baking in BOX space (not plate space) is what keeps this cheap: moving,
 * scaling or rotating the layer never invalidates the field, because the crop
 * pass normalises the transform away. Tuned in html/autofill-lab.html — the lab
 * is the source of truth for the algorithm constants. Deliberately 8-connected:
 * knight moves (16-conn) round the metric slightly but blow the bake from ~30 ms
 * to ~360 ms through heap churn; the 3× smoothing pass + the shader's bicubic
 * sampling deliver the smooth front instead.
 */

const GRID_BASE = 416;          // max grid dimension; height follows box aspect
const GRID_QUANT = 16;          // quantised so tiny box changes don't re-key
const MAX_CACHED = 8;
const NORM_SCALE = 0.98;        // arrival packs to [0, 0.98]; 1.0 = unreached sentinel

// Bake-side defaults — the caller (autoFillLayer.autoFillBakeParams) supplies
// the full param object; these only backfill missing keys defensively.
const BAKE_DEFAULTS = {
  seedMode: 0, seedCount: 1, seedSeed: 7, seedStagger: 0,
  speedType: 0, noiseScale: 140, noiseContrast: 55, noiseSeed: 7, contourBias: 40,
  bridges: 1, bridgeReach: 18, bridgeSlow: 2.5,
};

function normalizeBakeParams(bake) {
  const out = {};
  for (const key of Object.keys(BAKE_DEFAULTS)) {
    const v = Number(bake?.[key]);
    out[key] = Number.isFinite(v) ? v : BAKE_DEFAULTS[key];
  }
  out.points = Array.isArray(bake?.points) ? bake.points : [];
  return out;
}

// ── Crop/downsample pass ────────────────────────────────────────────────────
// Renders the box-quad region of the full-frame matte into a small target.
// The uv mapping is fxFrame() from EFFECT_PRELUDE (origin + (p·2−1)·axes), so
// the grid is exactly the space fxLocal() reconstructs in the effect shader.

let cropScene = null;
let cropMaterial = null;
let cropCamera = null;
// A free list rather than one shared target: the read that follows the crop is
// asynchronous (see readCroppedMask), so two layers baking in the same frame
// would otherwise both read whichever crop landed last.
const cropPool = [];
let cropRuntimeGeneration = 0;

/*
 * RELEASE THE POOLED RENDER TARGETS — they belong to ONE renderer.
 *
 * `cropPool` is module state, so it outlives any renderer. A WebGLRenderTarget
 * is not renderer-agnostic the way a Texture is: it owns a framebuffer bound to
 * the context that created it. After the pipeline is rebuilt (switching the
 * project's engine does exactly that), a pooled target from the previous
 * renderer is dead, and the autofill bake that reuses it silently produces
 * nothing — the effect looks broken with no error anywhere.
 *
 * Called from the Player's teardown, alongside the passes it disposes there.
 * The BAKED RESULTS are deliberately left alone: those are CPU-side arrays and
 * stay valid across renderers, so a rebuild does not force a re-bake.
 */
export function disposeAutoFillCropTargets() {
  cropRuntimeGeneration += 1;
  for (const target of cropPool) {
    try { target.dispose(); } catch { /* no-op */ }
  }
  cropPool.length = 0;
  // The pass material is backend-specific. Keeping the GLSL or node material
  // across a renderer switch makes the next backend draw an empty crop.
  try { cropMaterial?.dispose(); } catch { /* no-op */ }
  try { cropScene?.children?.[0]?.geometry?.dispose(); } catch { /* no-op */ }
  cropScene?.clear();
  cropScene = null;
  cropMaterial = null;
  cropCamera = null;
  // Outstanding readbacks carry the old generation and will dispose their
  // checked-out target when they settle. Clearing only the index lets the new
  // session start its own bake without the old promise deleting it later.
  inFlight.clear();
}
const CROP_POOL_MAX = 4;

/**
 * The crop material, exported so it can be BUILT without building the rig.
 *
 * Two reasons it is a named export rather than an inline literal. Its WebGPU
 * twin has to be swappable — WebGPURenderer cannot draw this ShaderMaterial at
 * all, so without a twin the bake produces no field and Auto Fill is simply
 * dead on that backend. And it has to be instantiable from a test: while it was
 * inline, verifying the twin meant duplicating this GLSL into a harness, which
 * is the "second, differently-wrong copy" trap the whole port has been avoiding.
 */
export function createAutoFillCropMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: null },
      uOutSize: { value: new THREE.Vector2(1, 1) },
      uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
      uAxisX: { value: new THREE.Vector2(0.5, 0) },
      uAxisY: { value: new THREE.Vector2(0, 0.5) },
    },
    vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uOutSize, uOrigin, uAxisX, uAxisY;
void main(){
  vec2 p = gl_FragCoord.xy / uOutSize;
  vec2 q = p * 2.0 - 1.0;
  vec2 uv = uOrigin + uAxisX * q.x + uAxisY * q.y;
  gl_FragColor = (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)
    ? vec4(0.0) : texture2D(uTex, uv);
}
`,
    depthTest: false,
    depthWrite: false,
  });
}

function ensureCropRig() {
  if (!cropScene) {
    cropMaterial = makeMaterial.autoFillCrop() ?? createAutoFillCropMaterial();
    cropScene = new THREE.Scene();
    cropScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), cropMaterial));
    cropCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
}

function acquireCropTarget(gw, gh) {
  const i = cropPool.findIndex((t) => t.width === gw && t.height === gh);
  if (i >= 0) return cropPool.splice(i, 1)[0];
  return new THREE.WebGLRenderTarget(gw, gh, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

function releaseCropTarget(target, generation = cropRuntimeGeneration) {
  if (!target) return;
  if (generation !== cropRuntimeGeneration) {
    target.dispose();
    return;
  }
  if (cropPool.length < CROP_POOL_MAX) cropPool.push(target);
  else target.dispose();
}

function gridSizeFor(box) {
  const w = Math.max(1, box?.sizePx?.[0] || 1);
  const h = Math.max(1, box?.sizePx?.[1] || 1);
  const quant = (v) => Math.min(GRID_BASE, Math.max(64, Math.round(v / GRID_QUANT) * GRID_QUANT));
  if (w >= h) return { gw: GRID_BASE, gh: quant(GRID_BASE * h / w) };
  return { gw: quant(GRID_BASE * w / h), gh: GRID_BASE };
}

// Snapshot the matte into a target of its own. SYNCHRONOUS on purpose, and the
// previous render target is restored before the caller can await anything: the
// caller is mid-frame, `matteTexture` is a pass target that later passes in the
// same frame overwrite, and every one of those passes would otherwise draw into
// the crop target. Only the READ of this snapshot is deferred.
function cropMatte(renderer, matteTexture, box, gw, gh) {
  ensureCropRig();
  const target = acquireCropTarget(gw, gh);
  const u = cropMaterial.uniforms;
  u.uTex.value = matteTexture;
  u.uOutSize.value.set(gw, gh);
  u.uOrigin.value.set(box.origin[0], box.origin[1]);
  u.uAxisX.value.set(box.axisX[0], box.axisX[1]);
  u.uAxisY.value.set(box.axisY[0], box.axisY[1]);
  const prev = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(cropScene, cropCamera);
  renderer.setRenderTarget(prev);
  renderer.setClearColor(prevClear, prevAlpha);
  return target;
}

// Read the cropped matte's alpha into a fresh Uint8 mask (1 = inside) + FNV hash.
//
// THE renderer-dependent step, and the reason this whole module is async-shaped:
// `readRenderTargetPixels` is synchronous and does not exist on a WebGPU
// renderer — there is only `readRenderTargetPixelsAsync`, whose result is the
// raw mapped staging buffer (rows carry WebGPU's mandatory 256-byte stride, and
// row 0 is the texture's TOP row where WebGL hands back the BOTTOM). Both
// defects read back as a plausible-looking buffer, so the unpad + row-flip goes
// in WITH the swap, here, and nowhere else — see
// html/webgpu-migration/PORTING-GUIDE.md §3.4.
//
// The buffer is allocated per read, never shared: with a read in flight a second
// bake would otherwise overwrite the first one's pixels.
async function readCroppedMask(renderer, target, gw, gh) {
  const pixels = await readTargetPixels(renderer, target, gw, gh);
  const n = gw * gh;
  const mask = new Uint8Array(n);
  let hash = 0x811c9dc5;
  for (let i = 0; i < n; i++) {
    const a = pixels[i * 4 + 3];
    const m = a >= 100 ? 1 : 0;
    mask[i] = m;
    hash ^= m;
    hash = Math.imul(hash, 0x01000193);
  }
  return { mask, hash: hash >>> 0 };
}

// ── Deterministic noise (JS twin of the prelude's hash21 value noise) ───────

function ihash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 974711369) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let xf = x - xi, yf = y - yi;
  xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf);
  const a = ihash(xi, yi, s), b = ihash(xi + 1, yi, s), c = ihash(xi, yi + 1, s), d = ihash(xi + 1, yi + 1, s);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
function fbm(x, y, s) {
  return vnoise(x, y, s) * 0.55 + vnoise(x * 2.03, y * 2.03, s + 11) * 0.3 + vnoise(x * 4.1, y * 4.1, s + 23) * 0.15;
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

// 3-4 chamfer distance to the nearest cell where inside() is true (units ×3).
function chamfer(out, gw, gh, inside) {
  const INF = 1e9;
  const n = gw * gh;
  for (let i = 0; i < n; i++) out[i] = inside(i) ? 0 : INF;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x; let d = out[i];
    if (x > 0) d = Math.min(d, out[i - 1] + 3);
    if (y > 0) d = Math.min(d, out[i - gw] + 3);
    if (x > 0 && y > 0) d = Math.min(d, out[i - gw - 1] + 4);
    if (x < gw - 1 && y > 0) d = Math.min(d, out[i - gw + 1] + 4);
    out[i] = d;
  }
  for (let y = gh - 1; y >= 0; y--) for (let x = gw - 1; x >= 0; x--) {
    const i = y * gw + x; let d = out[i];
    if (x < gw - 1) d = Math.min(d, out[i + 1] + 3);
    if (y < gh - 1) d = Math.min(d, out[i + gw] + 3);
    if (x < gw - 1 && y < gh - 1) d = Math.min(d, out[i + gw + 1] + 4);
    if (x > 0 && y < gh - 1) d = Math.min(d, out[i + gw - 1] + 4);
    out[i] = d;
  }
}

// ── Procedural seed synthesis ───────────────────────────────────────────────
// Modes: 0 Left, 1 Center, 2 Right, 3 Top, 4 Bottom, 5 Scatter — cells picked
// from the true mask so a seed always starts inside the artwork.

// Snap a grid cell to the nearest true-mask cell within a search radius (a
// manually placed point may land just outside the letterforms).
function snapToMask(mask, gw, gh, gx, gy) {
  gx = Math.min(Math.max(gx, 0), gw - 1);
  gy = Math.min(Math.max(gy, 0), gh - 1);
  if (mask[gy * gw + gx]) return gy * gw + gx;
  let best = -1, bestD = Infinity;
  const R = 48;
  for (let r = 1; r <= R; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      if (!mask[ny * gw + nx]) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = ny * gw + nx; }
    }
    if (best >= 0 && r > Math.sqrt(bestD) + 1) break;
  }
  return best;
}

function synthesizeSeeds(mask, gw, gh, params) {
  // Manual infection points (layer-box 0..1, y down = visual top at 0). The
  // grid's row 0 is the box's local -y side (the crop RT's bottom row), so the
  // vertical axis flips here.
  if (params.points && params.points.length) {
    const out = [];
    for (const p of params.points) {
      const gx = Math.round(p.x * (gw - 1));
      const gy = Math.round((1 - p.y) * (gh - 1));
      const idx = snapToMask(mask, gw, gh, gx, gy);
      if (idx >= 0) out.push({ idx, delay: Math.min(1, Math.max(0, Number(p.delay) || 0)) });
    }
    if (out.length) return out;
  }
  const cells = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) cells.push(i);
  if (!cells.length) return [{ idx: ((gh >> 1) * gw + (gw >> 1)), delay: 0 }];
  const count = Math.max(1, Math.min(8, Math.round(params.seedCount)));
  const rng = mulberry32(1013 + params.seedSeed * 7919);
  const mode = params.seedMode;
  const picked = [];
  if (mode === 5) {
    // Scatter with a spacing attempt: candidates rejected when too close.
    const minD2 = (gw * gh) / (count * 14);
    for (let k = 0; k < count; k++) {
      let best = -1;
      for (let tries = 0; tries < 24 && best < 0; tries++) {
        const c = cells[(rng() * cells.length) | 0];
        const cx = c % gw, cy = (c / gw) | 0;
        let ok = true;
        for (const p of picked) {
          const dx = cx - (p % gw), dy = cy - ((p / gw) | 0);
          if (dx * dx + dy * dy < minD2) { ok = false; break; }
        }
        if (ok || tries === 23) best = c;
      }
      picked.push(best);
    }
  } else if (mode === 1) {
    // Center: cells nearest the mask centroid, strided so >1 seeds spread a bit.
    let sx = 0, sy = 0;
    for (const c of cells) { sx += c % gw; sy += (c / gw) | 0; }
    const cx = sx / cells.length, cy = sy / cells.length;
    const sorted = cells.slice().sort((a, b) => {
      const da = (a % gw - cx) ** 2 + (((a / gw) | 0) - cy) ** 2;
      const db = (b % gw - cx) ** 2 + (((b / gw) | 0) - cy) ** 2;
      return da - db;
    });
    const stride = Math.max(1, Math.floor(sorted.length / (count * 20)));
    for (let k = 0; k < count; k++) picked.push(sorted[Math.min(k * stride, sorted.length - 1)]);
  } else {
    // Directional: the band of cells nearest that side, spread along the other axis.
    const horiz = mode === 0 || mode === 2;
    const axis = (c) => (horiz ? c % gw : (c / gw) | 0);
    const cross = (c) => (horiz ? (c / gw) | 0 : c % gw);
    // THE VERTICAL AXIS IS UPSIDE DOWN HERE. The grid's row 0 is the box's local
    // -y side — the crop target's BOTTOM row — which is why the manual-points
    // branch above converts with (1 - p.y). So "Top" wants the LARGEST gy and
    // "Bottom" the smallest; taking the same extreme as x made those two swap
    // places, and only those two (x needs no flip, which is why Left and Right
    // were always right).
    const flip = horiz ? mode === 2 : mode === 3;
    let extreme = flip ? -Infinity : Infinity;
    for (const c of cells) {
      const v = axis(c);
      extreme = flip ? Math.max(extreme, v) : Math.min(extreme, v);
    }
    const bandW = Math.max(3, Math.round((horiz ? gw : gh) * 0.06));
    const band = cells.filter((c) => Math.abs(axis(c) - extreme) <= bandW);
    band.sort((a, b) => cross(a) - cross(b));
    for (let k = 0; k < count; k++) {
      const t = count === 1 ? 0.5 : k / (count - 1);
      picked.push(band[Math.min(band.length - 1, Math.round(t * (band.length - 1)))]);
    }
  }
  const stagger = Math.max(0, Math.min(100, params.seedStagger)) / 100;
  return picked.map((idx, i) => ({
    idx,
    delay: count > 1 ? stagger * (i / (count - 1)) : 0,
  }));
}

// ── The bake ────────────────────────────────────────────────────────────────

function bakeField(mask, gw, gh, params) {
  const n = gw * gh;
  const distToMask = new Float32Array(n);
  const distIn = new Float32Array(n);
  chamfer(distToMask, gw, gh, (i) => mask[i] === 1);
  chamfer(distIn, gw, gh, (i) => mask[i] === 0);
  let maxDistIn = 1;
  for (let i = 0; i < n; i++) if (mask[i] && distIn[i] > maxDistIn) maxDistIn = distIn[i];

  // Domain = mask ∪ bridge corridor. Corridor cells travel but pay a cost toll;
  // rendering still clips to the true alpha, so nothing paints in a gap.
  const domain = new Uint8Array(n);
  const reachCells = (params.bridges >= 0.5 ? params.bridgeReach : 0) * (gw / GRID_BASE) * 3;
  for (let i = 0; i < n; i++) domain[i] = mask[i] || distToMask[i] <= reachCells ? 1 : 0;

  const speed = new Float32Array(n);
  const cost = new Float32Array(n);
  const type = params.speedType; // 0 uniform, 1 turbulent, 2 shape flow, 3 combine
  const freq = 1 / Math.max(params.noiseScale / 2, 2);
  const contrast = Math.max(0, Math.min(100, params.noiseContrast)) / 100;
  const bias = Math.max(-100, Math.min(100, params.contourBias)) / 100;
  const slow = Math.max(1, params.bridgeSlow);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x;
    if (!domain[i]) { speed[i] = 0; cost[i] = 1e9; continue; }
    let s = 1;
    if (type === 1 || type === 3) {
      const nz = fbm(x * freq, y * freq, params.noiseSeed);
      s *= 1 - contrast * 0.92 * (1 - Math.min(Math.max(nz, 0), 1));
    }
    if (type === 2 || type === 3) {
      const d = Math.min(distIn[i] / maxDistIn, 1);
      const edgeFast = Math.min(Math.max(1 - d, 0.06), 1);
      const coreFast = Math.min(Math.max(d, 0.06), 1);
      s *= bias >= 0 ? 1 + (edgeFast - 1) * bias : 1 + (coreFast - 1) * -bias;
    }
    s = Math.max(s, 0.06);
    if (!mask[i]) s /= slow;
    speed[i] = s;
    cost[i] = 1 / s;
  }

  const seeds = synthesizeSeeds(mask, gw, gh, params);

  // Multi-source Dijkstra, binary heap with lazy deletion.
  const arrival = new Float32Array(n).fill(Infinity);
  const cap = n * 10;
  const heapT = new Float32Array(cap);
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
  const DX = [-1, 1, 0, 0, -1, 1, -1, 1];
  const DY = [0, 0, -1, 1, -1, -1, 1, 1];
  const DW = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
  const run = (seedList) => {
    arrival.fill(Infinity);
    hn = 0;
    for (const s of seedList) {
      if (s.idx < 0 || !domain[s.idx]) continue;
      if (s.t0 < arrival[s.idx]) { arrival[s.idx] = s.t0; push(s.t0, s.idx); }
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
      if (t > arrival[i]) continue;
      const x = i % gw, y = (i / gw) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k], ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const ni = ny * gw + nx;
        if (!domain[ni]) continue;
        const nt = t + DW[k] * (cost[i] + cost[ni]) * 0.5;
        if (nt < arrival[ni]) { arrival[ni] = nt; push(nt, ni); }
      }
    }
    let mx = 0;
    for (let i = 0; i < n; i++) if (domain[i] && isFinite(arrival[i]) && arrival[i] > mx) mx = arrival[i];
    return mx;
  };

  let span = run(seeds.map((s) => ({ idx: s.idx, t0: 0 })));
  if (seeds.some((s) => s.delay > 0) && span > 0) {
    span = run(seeds.map((s) => ({ idx: s.idx, t0: s.delay * span })));
  }

  // Masked 3×3 smoothing — rounds grid-scale stair-steps and the 8-conn metric's
  // octagonal facets without moving the front (delays are already folded in).
  const tmp = new Float32Array(n);
  for (let it = 0; it < 3; it++) {
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (!domain[i] || !isFinite(arrival[i])) { tmp[i] = arrival[i]; continue; }
      let s = arrival[i] * 4, w = 4;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k], ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const ni = ny * gw + nx;
        if (!domain[ni] || !isFinite(arrival[ni])) continue;
        const wk = k < 4 ? 2 : 1;
        s += arrival[ni] * wk; w += wk;
      }
      tmp[i] = s / w;
    }
    arrival.set(tmp);
  }
  span = 0;
  for (let i = 0; i < n; i++) if (domain[i] && isFinite(arrival[i]) && arrival[i] > span) span = arrival[i];
  span = Math.max(span, 1e-6);

  // Pack: R/G = 16-bit arrival (normalised to 0.98, 1.0 sentinel = unreached),
  // B = mask/bridge (255 solid / 100 corridor / 0 outside), A = local speed.
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let v = 65535;
    if (domain[i] && isFinite(arrival[i])) v = Math.round((arrival[i] / span) * NORM_SCALE * 65535);
    data[o] = v >> 8;
    data[o + 1] = v & 255;
    data[o + 2] = mask[i] ? 255 : (domain[i] ? 100 : 0);
    data[o + 3] = Math.round(Math.min(speed[i], 1) * 255);
  }
  return { data, span };
}

// ── Cache + async bake ──────────────────────────────────────────────────────
// Per effect INSTANCE (eid). The cheap gate is (params key + item identity);
// when the item object changed we re-read the silhouette and only rebake when
// its content hash actually moved — so autosave churn costs a readback, not a
// bake.
//
// The bake CANNOT run inline any more. It is driven from the render loop, and
// its first step is reading a render target back, which no WebGPU renderer can
// do synchronously. So a miss kicks the bake and returns the instance's PREVIOUS
// field; the frame that asked paints with that, and repaints when the bake lands
// (Player subscribes through onAutofillBake).
//
// That staleness must never reach a render: every bake is registered with
// asyncBakes.js, and `Player.exportVideo` settles that queue and repaints before
// capturing each frame — so an exported frame always carries the settled field.
// The preview is the only place allowed to be one bake behind.

const fieldCache = new Map();       // cacheKey -> entry
const lastKeyByInstance = new Map();// instanceId -> the cacheKey it last served
const inFlight = new Map();         // instanceId -> Promise (at most one bake each)
let cacheSeq = 0;

function evictIfFull(key) {
  if (fieldCache.has(key) || fieldCache.size < MAX_CACHED) return;
  let oldestKey = null;
  let oldest = Infinity;
  for (const [k, v] of fieldCache) {
    if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestKey = k; }
  }
  if (!oldestKey) return;
  try { fieldCache.get(oldestKey).texture?.dispose(); } catch { /* no-op */ }
  fieldCache.delete(oldestKey);
}

function storeField(key, inst, paramsKey, itemRef, hash, gw, gh, data, span) {
  const prev = fieldCache.get(key);
  let texture = prev?.texture;
  if (texture && (texture.image.width !== gw || texture.image.height !== gh)) {
    texture.dispose();
    texture = null;
  }
  if (!texture) {
    texture = new THREE.DataTexture(data, gw, gh, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
  } else {
    texture.image.data = data;
  }
  texture.needsUpdate = true;
  const entry = {
    paramsKey, itemRef, maskHash: hash,
    texture, gridW: gw, gridH: gh, span,
    lastUsed: cacheSeq++,
  };
  evictIfFull(key);
  fieldCache.set(key, entry);
  lastKeyByInstance.set(inst, key);
  return entry;
}

function kickBake(renderer, matteTexture, box, params, paramsKey, key, inst, itemRef, gw, gh) {
  // The snapshot is taken NOW, from the matte the caller is holding; everything
  // after this point runs off a copy nothing else can touch.
  let target;
  try {
    target = cropMatte(renderer, matteTexture, box, gw, gh);
  } catch (err) {
    console.warn('[autofill] matte snapshot failed: ' + (err?.message || err));
    return;
  }
  const generation = cropRuntimeGeneration;
  const run = readCroppedMask(renderer, target, gw, gh)
    .then(({ mask, hash }) => {
      if (generation !== cropRuntimeGeneration) return false;
      const prev = fieldCache.get(key);
      if (prev && prev.paramsKey === paramsKey && prev.maskHash === hash) {
        // Same silhouette under a replaced item object (autosave churn): adopt
        // the new identity so the cheap gate hits again. Nothing to rebake and
        // nothing to repaint.
        prev.itemRef = itemRef;
        prev.lastUsed = cacheSeq++;
        lastKeyByInstance.set(inst, key);
        return false;
      }
      const { data, span } = bakeField(mask, gw, gh, params);
      storeField(key, inst, paramsKey, itemRef, hash, gw, gh, data, span);
      return true;
    })
    .catch(() => false) // reported by the settle registry
    .then((changed) => {
      releaseCropTarget(target, generation);
      if (inFlight.get(inst) === run) inFlight.delete(inst);
      return changed;
    });
  inFlight.set(inst, run);
  // The settle registry is what an export waits on — see asyncBakes.js.
  trackBake(run, 'autofill');
}

/**
 * bake = the un-prefixed bake params (+ optional points array); instanceId is a
 * stable per-instance id; itemRef gates the cheap identity path — a replaced
 * item object triggers a readback + content-hash check before any rebake.
 * maskStamp varies the cache key when an animated layer mask changes the alpha
 * the field is baked from without changing the item object; the instance's
 * previous field is what preview serves while the new one bakes.
 *
 * Returns synchronously, always: the settled field, else the instance's previous
 * one, else null (the effect's own "not ready" path, one frame at most).
 */
export function getAutofillField(renderer, matteTexture, box, bake, instanceId, itemRef, maskStamp) {
  if (!renderer || !matteTexture || !box) return null;
  const inst = instanceId || 'anon';
  const key = maskStamp ? `${inst}|${maskStamp}` : inst;
  const { gw, gh } = gridSizeFor(box);
  const params = normalizeBakeParams(bake);
  const pointsKey = params.points.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)},${(p.delay || 0).toFixed(3)}`).join(';');
  const paramsKey = `${gw}x${gh}|${Object.keys(BAKE_DEFAULTS).map((k) => params[k]).join(',')}|${pointsKey}`;
  const entry = fieldCache.get(key);
  if (entry && entry.paramsKey === paramsKey && entry.itemRef === itemRef) {
    entry.lastUsed = cacheSeq++;
    lastKeyByInstance.set(inst, key);
    return entry;
  }
  // One bake in flight per instance. An animated mask hands us a new key every
  // frame; without this the queue would take a ~30 ms bake per frame and never
  // drain. Skipping is safe — the next frame asks again with whatever state is
  // current then, which is the one worth baking.
  if (!inFlight.has(inst)) {
    kickBake(renderer, matteTexture, box, params, paramsKey, key, inst, itemRef, gw, gh);
  }
  if (entry) return entry;
  const lastKey = lastKeyByInstance.get(inst);
  return (lastKey !== undefined && fieldCache.get(lastKey)) || null;
}
