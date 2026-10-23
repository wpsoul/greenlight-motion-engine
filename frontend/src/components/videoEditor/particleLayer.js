// Particle layer — the Solver Box's pixels.
//
// Same boundary as model3dLayer: the Player asks for a texture and gets one back,
// plus a representative view distance for channel ordering and depth of field. All
// of three.js lives behind this module, which is why Player lazy-imports it.
//
// WHAT THIS FILE DOES AND DOES NOT DO
// -----------------------------------
// It NEVER advances a simulation. Positions come from the bake cache, sampled at an
// absolute clip-local time (solver.js explains why). Drawing is a pure function of
// (cache, time, look) — which is what makes a paused preview frame, a Download and
// a headless /video-render frame the same picture.
//
// Look is evaluated per-particle on the GPU from `age`, but every RANDOM input is
// computed on the CPU from the seeded rng and uploaded as an instance attribute.
// A hash in GLSL would be one sin() precision difference away from a machine-
// dependent frame, which is exactly the class of bug the bake exists to prevent.

import * as THREE from 'three';
import { cameraProxyFromPose } from './projectCamera';
import { sampleParticles, SAMPLE_STRIDE, TTL_ALIVE } from '../../sim/particles/solver.js';
import { rnd, srnd } from '../../sim/particles/rng.js';
import {
  objectPickTable, objectMemberOf, clumpFromMask, clumpGridSize, packClumps,
} from '../../sim/particles/shapes.js';
import {
  ensureObjectRaster, ensureSpawnTable, ensureMultiSpawnTable, objectVideoElement, objectVideoFrame,
  prepareObjectVideos, disposeObjectVideos, objectRasterKey, EMITTER_RASTER_PX,
  refreshSpawnTableColors,
} from './particleObjectRaster';
import { sdfFromMask, SDF_W, SDF_H, resamplePath, PATH_N } from '../../sim/particles/fluid.js';
import { ensureProxField, proxFieldKey } from './particleProxField';
import { collidersOf, emitterSourcesOf } from '../../sim/particles/schema.js';

// Re-exported so the Player can put live video objects on the right frame before
// it draws one — the runtime it holds is this module.
export { prepareObjectVideos, disposeObjectVideos };
import { ensureGrowField, growFieldKey } from './particleGrowField';
import { proxInfluence } from '../../sim/particles/proximity.js';
import { linePathIndex, lineLook, buildTrailLines, buildRowLines } from '../../sim/particles/lines.js';
import { materials as makeMaterial } from './materialFactory';

const SPRITE_INDEX = { 'soft-disc': 0, star: 1, spark: 2 };

const _size = new THREE.Vector2();
const _mv = new THREE.Matrix4();
const _worldPos = new THREE.Vector3();
const _boxCorner = new THREE.Vector3();

// The posed Solver Box in world space and the eye, for ordering this layer against
// 3D models (compositeSortDepth.js orderByBoxes): particles over a page draw after it.
function solverBoxRange(outer, size, cam) {
  if (!size) return null;
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  let near = Infinity;
  let far = -Infinity;
  for (let i = 0; i < 8; i++) {
    _boxCorner.set((i & 1 ? 0.5 : -0.5) * size.x, (i & 2 ? 0.5 : -0.5) * size.y, (i & 4 ? 0.5 : -0.5) * size.z)
      .applyMatrix4(outer.matrixWorld);
    box[0] = Math.min(box[0], _boxCorner.x); box[3] = Math.max(box[3], _boxCorner.x);
    box[1] = Math.min(box[1], _boxCorner.y); box[4] = Math.max(box[4], _boxCorner.y);
    box[2] = Math.min(box[2], _boxCorner.z); box[5] = Math.max(box[5], _boxCorner.z);
    const d = -_boxCorner.applyMatrix4(cam.matrixWorldInverse).z;
    near = Math.min(near, d);
    far = Math.max(far, d);
  }
  if (!box.every(Number.isFinite)) return null;
  cam.getWorldPosition(_boxCorner);
  return { near: Math.max(cam.near, near), far: Math.max(cam.near, far), box, eye: [_boxCorner.x, _boxCorner.y, _boxCorner.z] };
}

// ── Shaders ────────────────────────────────────────────────────────────────────

const VERT = /* glsl */ `
  // PACKED INTO FIVE vec4s, and that packing is not cosmetic: WebGPU caps a
  // pipeline at 8 VERTEX BUFFERS. The eight separate instanced attributes this
  // used to declare, plus position and uv, came to TEN - over the limit, so
  // CreateRenderPipeline failed outright and the whole particle system drew
  // NOTHING on WebGPU while still reporting its instance count. Five vec4s plus
  // position and uv is seven, with room left.
  // (No backticks in here: this is a template literal.)
  //
  //   iA  xyz = position          w = speedT   (2nd-ramp lookup, CPU-computed)
  //   iB  xy  = age, life         zw = jitter  (size multiplier, twinkle phase)
  //   iC  xyz = velocity          w  = held    (Activation: front not yet here)
  //   iD  xyzw= rotation, tumble squash, kill scale, kill alpha
  //   iE  xyz = emitted colour    w  = ignite  (flare, already faded on the CPU)
  attribute vec4 iA;
  attribute vec4 iB;
  attribute vec4 iC;
  attribute vec4 iD;
  attribute vec4 iE;
  #define iPos      iA.xyz
  #define iSpeedT   iA.w
  #define iAgeLife  iB.xy
  #define iJitter   iB.zw
  #define iVel      iC.xyz
  #define iSpin     iD
  #define iColor    iE.xyz

  uniform float uSizeStart;
  uniform float uSizeEnd;
  uniform float uStretch;
  uniform float uScale;      // the layer's own scale, so particles grow with it
  uniform float uTwinkle;
  uniform float uAspect;     // object artwork: height / width

  varying vec2 vUv;
  varying float vLifeT;
  varying float vAlphaMul;
  varying float vSquash;
  varying float vKill;
  varying vec3 vColor;
  varying float vHold;
  varying float vIgnite;
  varying float vSpeedT;

  void main() {
    vUv = uv;
    vSquash = iSpin.y;
    vKill = iSpin.w;
    vColor = iColor;
    vHold = iC.w;
    vIgnite = iE.w;
    vSpeedT = iSpeedT;
    float life = max(iAgeLife.y, 1e-4);
    vLifeT = clamp(iAgeLife.x / life, 0.0, 1.0);

    // Twinkle is a per-particle sine on its OWN age and phase — never on wall
    // clock, or a scrubbed frame would not match a played one.
    vAlphaMul = 1.0 - uTwinkle * 0.5 * (1.0 + sin(iJitter.y + iAgeLife.x * (5.0 + mod(iJitter.y, 7.0))));

    // A held particle is the artwork: it sits at its start size, and the flare a
    // freshly released one carries is a pure function of its age.
    float size = mix(uSizeStart, uSizeEnd, vHold > 0.5 ? 0.0 : vLifeT)
      * iJitter.x * uScale * iSpin.z * (1.0 + iE.w);

    // Billboard: the quad is built in VIEW space, so it always faces the camera
    // whatever the layer's own rotation is. An object also carries its artwork's
    // aspect, its own spin, and (tumbling) the squash that fakes the third axis.
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    vec2 quad = position.xy * vec2(size * iSpin.y, size * uAspect);
    if (iSpin.x != 0.0) {
      float cs = cos(iSpin.x), sn = sin(iSpin.x);
      quad = vec2(quad.x * cs - quad.y * sn, quad.x * sn + quad.y * cs);
    }

    if (uStretch > 0.0) {
      // Stretch along the velocity as the camera sees it, so a spark leans into
      // its travel instead of smearing in a fixed screen direction.
      //
      // THE BASIS MUST STAY RIGHT-HANDED: det([side, fwd]) has to be +1. Built the
      // other way round (side = (-fwd.y, fwd.x)) every quad is MIRRORED, which
      // reverses its winding — so every stretched particle turns back-facing and is
      // silently culled. The symptom is an empty frame with correct instance counts,
      // uniforms, attributes and no GL error, which is a miserable thing to debug.
      vec3 vv = (modelViewMatrix * vec4(iPos + iVel * uStretch, 1.0)).xyz - mv.xyz;
      float len = length(vv.xy);
      if (len > 1e-4) {
        // Local +y points AGAINST travel, so the sprite's head (its -y end) leads.
        vec2 fwd = -vv.xy / len;
        vec2 side = vec2(fwd.y, -fwd.x);
        quad = side * (position.x * size) + fwd * (position.y * (size + len));
      }
    }

    mv.xy += quad;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D uRamp;
  uniform sampler2D uRamp2;   // velocity gradient, or the ignition gradient
  uniform sampler2D uMap;
  uniform int uSprite;
  uniform float uOpacity;
  uniform float uUseMap;
  uniform float uTint;
  uniform float uColorFromSource;
  uniform float uColorFromSpeed;
  uniform float uIgniteMode;   // 0 flash · 1 solid · 2 gradient
  uniform vec3 uIgniteColor;

  varying vec2 vUv;
  varying float vLifeT;
  varying float vAlphaMul;
  varying float vSquash;
  varying float vKill;
  varying vec3 vColor;
  varying float vHold;
  varying float vIgnite;
  varying float vSpeedT;

  float softDisc(vec2 p) {
    float t = clamp(1.0 - length(p), 0.0, 1.0);
    return t * t * (0.45 + 0.55 * t * t);
  }

  float star(vec2 p) {
    float r = length(p);
    float core = pow(max(0.0, 1.0 - r), 5.0);
    // Two long spikes and two short diagonals — the classic anamorphic twinkle.
    float sx = pow(max(0.0, 1.0 - abs(p.x) * 7.0), 1.5) * pow(max(0.0, 1.0 - abs(p.y)), 2.5);
    float sy = pow(max(0.0, 1.0 - abs(p.y) * 7.0), 1.5) * pow(max(0.0, 1.0 - abs(p.x)), 2.5);
    vec2 d = vec2(p.x + p.y, p.x - p.y) * 0.7071;
    float dx = pow(max(0.0, 1.0 - abs(d.x) * 14.0), 1.5) * pow(max(0.0, 1.0 - abs(d.y) * 2.2), 2.5);
    float dy = pow(max(0.0, 1.0 - abs(d.y) * 14.0), 1.5) * pow(max(0.0, 1.0 - abs(d.x) * 2.2), 2.5);
    return clamp(core + (sx + sy) * 0.85 + (dx + dy) * 0.4, 0.0, 1.0);
  }

  float spark(vec2 p) {
    // A comet: bright head, tail thinning along -y.
    float body = pow(max(0.0, 1.0 - length(vec2(p.x * 3.2, p.y))), 2.0);
    float head = pow(max(0.0, 1.0 - length(vec2(p.x * 2.2, (p.y + 0.55) * 1.6)) * 2.2), 2.0);
    return clamp(body * 0.75 + head, 0.0, 1.0);
  }

  void main() {
    // HELD (Grow Points, 'frozen'): the particle is standing on the pixel it came
    // from, waiting for the front. It reads the HEAD of the ramp at full opacity
    // — every preset's first stop is transparent, so its living colour would be
    // an invisible layer — and skips twinkle and the leaving fade, neither of
    // which has happened to it yet.
    vec4 c = texture2D(uRamp, vec2(vHold > 0.5 ? 0.0 : vLifeT, 0.5));
    vec3 rgb = c.rgb;
    float a;

    if (uUseMap > 0.5) {
      // A layer object: the artwork IS the sprite. The ramp still drives its fade
      // in and out (and its colour too, but only when Tint is on — otherwise a
      // white ramp would wash a coloured logo).
      vec4 art = texture2D(uMap, vUv);
      if (art.a <= 0.004) discard;
      rgb = uTint > 0.5 ? art.rgb * c.rgb : art.rgb;
      // Edge-on cards catch less light; without this a tumble reads as a flicker.
      a = art.a * c.a * uOpacity * vAlphaMul * vKill * (0.45 + 0.55 * clamp(vSquash, 0.0, 1.0));
      if (vHold > 0.5) a = art.a * uOpacity * (0.45 + 0.55 * clamp(vSquash, 0.0, 1.0));
    } else {
      vec2 p = (vUv - 0.5) * 2.0;
      float shape = uSprite == 1 ? star(p) : (uSprite == 2 ? spark(p) : softDisc(p));
      if (shape <= 0.002) discard;
      // Emitted from a layer's pixels: each particle wears the colour it came
      // from, and the ramp is left driving alpha alone — which is what makes a
      // dissolve look like the picture coming apart rather than being recoloured.
      // RGB comes from the ramp (age), the emitted pixel, or the velocity
      // gradient. ALPHA stays the life ramp in every case — it is the envelope
      // that lets a particle arrive and leave, and a colour source that owned it
      // would make particles pop in and out at full opacity.
      rgb = mix(c.rgb, vColor, uColorFromSource);
      rgb = mix(rgb, texture2D(uRamp2, vec2(vSpeedT, 0.5)).rgb, uColorFromSpeed);
      a = c.a * shape * uOpacity * vAlphaMul * vKill;
      if (vHold > 0.5) a = shape * uOpacity;
    }
    // Ignition: the leading edge of the sweep, painted rather than only brightened.
    if (vIgnite > 0.0001 && vHold < 0.5) {
      if (uIgniteMode > 1.5) {
        // Gradient: read across the flare's own life, so the band has an inside
        // and an outside instead of one flat colour.
        vec4 ig = texture2D(uRamp2, vec2(clamp(1.0 - vIgnite, 0.0, 1.0), 0.5));
        rgb = mix(rgb, ig.rgb, clamp(vIgnite * ig.a, 0.0, 1.0));
      } else if (uIgniteMode > 0.5) {
        rgb = mix(rgb, uIgniteColor, clamp(vIgnite, 0.0, 1.0));
      }
      a = clamp(a + vIgnite * 0.55, 0.0, 1.0);
    }
    a = clamp(a, 0.0, 1.0);
    if (a <= 0.002) discard;

    // Premultiplied out, matching what every other layer contributes to the
    // compositor's accumulation buffer.
    gl_FragColor = vec4(rgb * a, a);
  }
`;

/**
 * The spawn table for a 'layer' emitter — the artwork's opaque pixels as emission
 * sites, with their colours. Shared by the bake (positions) and the draw (colours);
 * the Player hands it to ensureParticleCache so both see the same one.
 *
 * Site count scales with the particle cap so a dense system does not visibly reuse
 * the same handful of pixels, and is capped so a huge system does not sample a
 * 512² raster into something enormous.
 */
// Spawn tables that have had an arrival field folded in, keyed by that field.
const grownTables = new Map();

export function spawnTableFor(system) {
  const em = system?.emitters?.[0];
  if (em?.shape !== 'layer' || !em.source) return null;
  const A = system.activation;
  // GROW POINTS pairs one site with one particle, for the whole clip: the solver
  // keys a slot's release time off its own index, and the renderer reads that
  // slot's colour from the same index. So the table is exactly the cap here,
  // not the usual oversample.
  const growing = A?.mode === 'grow';
  const count = growing
    ? Math.max(1, Math.round(system.solver.maxParticles))
    : Math.min(8192, Math.max(1024, Math.round(system.solver.maxParticles * 2)));
  /*
   * SEVERAL SOURCES merge into ONE table, weighted by artwork area — see
   * ensureMultiSpawnTable for why area and not an even split. Every source keeps
   * its own rect, and the merge re-projects them all into the emitter's box, so
   * nothing downstream of here knows there was more than one.
   *
   * Grow Points is left on the single-source path deliberately: the front is a
   * sweep through ONE artwork's arrival field, and a merged table has no single
   * field for it to travel through. Said in the panel rather than silently
   * producing a front that means nothing.
   */
  const extra = emitterSourcesOf(em);
  const table = (extra.length > 1 && !growing)
    ? ensureMultiSpawnTable(
      extra.map((x) => x.source),
      count,
      extra.map((x) => ({ size: x.size, position: x.position })),
      { size: em.size, position: em.position },
    )
    : ensureSpawnTable(em.source, count);
  if (!table || !growing) return table;

  // The arrival field is part of the table because it is part of the SIMULATION
  // input — it rides in on the table's key, which is what makes ensureParticleCache
  // re-bake when a seed moves without adding another hash for the caller to
  // remember. Until the artwork has rasterised there is no field, and the solver
  // falls back to activating everything at once rather than drawing nothing.
  const fieldKey = growFieldKey(em.source, A, count);
  const field = ensureGrowField(em.source, A, table.positions, table.count, fieldKey);
  if (!field) return table;
  // Memoised beside the table, never ON it: this runs every frame, and rebuilding
  // the wrapper would hand ensureParticleCache a new object sixty times a second.
  // Keeping the memo out of the table also keeps the table a flat bag of data,
  // which is what makes it safe to post to the worker whole.
  const memo = grownTables.get(fieldKey);
  if (memo && memo.count === table.count) return memo;
  const grown = {
    ...table,
    growKey: fieldKey,
    key: `${table.key}|${fieldKey}`,
    arrival: field.arrival,
    growUnreachable: field.unreachable,
  };
  if (grownTables.size > 8) grownTables.clear();
  grownTables.set(fieldKey, grown);
  return grown;
}

// ── Collider table ─────────────────────────────────────────────────────────────
//
// The picked layer's artwork, laid over the Solver Box at the collision block's
// size and position, rasterised to an alpha mask and turned into a signed
// distance field (fluid.js). Like the spawn table it is a SIMULATION input
// that identifies itself by key, so ensureParticleCache re-bakes when the
// artwork, its size or its place changes — and like the spawn table it is a
// flat bag of typed arrays and numbers, safe to post to the worker whole.
const colliderTables = new Map();

/**
 * @param {object} system
 * @param {object|null} liveSource  the FOLLOWED source layer's artwork as it is
 *   right now. Only used when `collision.follow` is on, and only as the artwork
 *   — the stored `source` remains the fallback for a layer that is gone.
 */
/**
 * The field for EVERY collider on this system, in `collidersOf` order.
 *
 * One entry per collider, and an entry may be null while its artwork is still
 * decoding — the solver skips a collider with no table, which is what makes a
 * decoding image cost nothing instead of a missing wall.
 *
 * @param {object} system
 * @param {Array<object|null>} liveSources  the FOLLOWED source layers' artwork
 *   as it is right now, positional. Only used where `follow` is on, and only as
 *   the artwork — the stored `source` remains the fallback for a layer that has
 *   been deleted.
 */
export function colliderTablesFor(system, liveSources = []) {
  /*
   * The WHOLE system with one collider swapped in, never a `{ collision }` stub.
   * colliderTableFor reads `system.solver.bounds.size` — the box the field is
   * rasterised over — so a stub with only a collision block threw on the first
   * frame and took the whole editor down with it.
   */
  return collidersOf(system).map((c, i) => (
    colliderTableFor({ ...system, collision: c }, liveSources[i] || null)
  ));
}

export function colliderTableFor(system, liveSource = null) {
  const C = system?.collision;
  if (!C?.source) return null;
  /*
   * A FOLLOWED collider is baked in the ARTWORK's own local space, once, and
   * sampled through its live pose — the same field a proximity source uses, and
   * for the same reason: a field rasterised over the whole Solver Box is
   * invalidated by every frame of motion, so it can describe something that
   * stands still and nothing that moves.
   */
  if (C.follow && C.fromItemId) {
    // Live artwork when the layer is still there, the snapshot when it is not.
    const art = liveSource || C.source;
    const field = ensureProxField(art);
    return field && !field.empty ? { ...field, key: `follow:${proxFieldKey(art)}` } : null;
  }
  const raster = ensureObjectRaster(C.source, EMITTER_RASTER_PX);
  if (!raster?.ready || !raster.canvas) return null;   // still decoding; try next frame
  const b = system.solver.bounds.size;
  const key = `${objectRasterKey(C.source)}|${C.size}|${C.position.x}|${C.position.y}|${b.x}|${b.y}`;
  const hit = colliderTables.get(key);
  if (hit !== undefined) return hit;
  let alpha;
  try {
    const c = document.createElement('canvas');
    c.width = SDF_W; c.height = SDF_H;
    const x = c.getContext('2d');
    const sx = SDF_W / b.x, sy = SDF_H / b.y;
    /*
     * `aspect` IS HEIGHT / WIDTH. Every rasteriser in particleObjectRaster.js
     * returns it that way — `ih / iw` for an image, `videoHeight / videoWidth`
     * for a video, `h / w` for text — and so does the `aspect` stored on an
     * image or video source once it has decoded.
     *
     * This divided by it, and its own fallback used the INVERSE
     * (canvas.width / canvas.height), so the two branches disagreed and only one
     * of them could be right. A tall glyph came out squat and a wide banner came
     * out as a tall column; only a square collider was unaffected, which is why
     * it survived. Found by pouring letters into a text container: the 'G' was
     * rasterised at 700 x 437 instead of 700 x 1120, so the emitter sat entirely
     * above the shape and every birth was clipped away.
     */
    const aspect = raster.aspect || (raster.canvas.height / raster.canvas.width) || 1;
    const w = C.size, h = C.size * aspect;
    const cx = (C.position.x / b.x + 0.5) * SDF_W, cy = (0.5 - C.position.y / b.y) * SDF_H;
    x.drawImage(raster.canvas, cx - (w * sx) / 2, cy - (h * sy) / 2, w * sx, h * sy);
    const data = x.getImageData(0, 0, SDF_W, SDF_H).data;
    alpha = new Uint8Array(SDF_W * SDF_H);
    for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
  } catch {
    // A tainted canvas cannot be read back: no collider rather than a broken one.
    colliderTables.set(key, null);
    return null;
  }
  const table = { ...sdfFromMask(alpha, b.x, b.y), key };
  if (colliderTables.size > 8) colliderTables.clear();
  colliderTables.set(key, table);
  return table;
}

// ── Object shapes (Packing ▸ Shape: Object) ─────────────────────────────────────
//
// One clump of circles per included member, built from the member's artwork at
// the aspect it is DRAWN at (keepRatio off stretches the artwork to a square,
// and then so does its outline). Like the collider's field it is a simulation
// input that identifies itself by key, so a member re-snapshotted from its layer
// re-bakes, and a flat bag of typed arrays so it can be posted to the worker.

const objectClumps = new Map();      // raster key|aspect -> clump
let objectShapesMemo = null;         // { key, table }

function objectClumpFor(source, raster, aspect) {
  const key = `${objectRasterKey(source)}|${aspect.toFixed(4)}`;
  const hit = objectClumps.get(key);
  if (hit) return hit;
  const { gw, gh } = clumpGridSize(aspect);
  let alpha;
  try {
    const c = document.createElement('canvas');
    c.width = gw; c.height = gh;
    const x = c.getContext('2d');
    x.drawImage(raster.canvas, 0, 0, gw, gh);
    const d = x.getImageData(0, 0, gw, gh).data;
    alpha = new Uint8Array(gw * gh);
    for (let i = 0; i < alpha.length; i++) alpha[i] = d[i * 4 + 3];
  } catch {
    // A tainted canvas cannot be read back. Collide as the whole quad — the
    // artwork's box — rather than as nothing.
    alpha = new Uint8Array(gw * gh).fill(255);
  }
  const clump = { ...clumpFromMask(alpha, gw, gh, aspect), key };
  if (objectClumps.size > 64) objectClumps.clear();
  objectClumps.set(key, clump);
  return clump;
}

/**
 * The clumps for a system whose Packing collides by OBJECT SHAPE, or null —
 * for any other system, and while any member's artwork is still decoding (the
 * solver packs circles meanwhile, and the key change re-bakes when they land).
 */
export function objectShapesFor(system) {
  const pk = system?.packing;
  if (!pk?.enabled || pk.shape !== 'object' || system.render?.mode !== 'layers') return null;
  // Flat boxes only: the solver's own test (packing's 2D read).
  if ((system.solver?.bounds?.size?.z || 0) / 2 > 1) return null;
  const O = system.objects;
  const included = (O?.members || []).filter((m) => m && m.included !== false);
  if (!included.length) return null;
  const clumps = [];
  for (const member of included) {
    const raster = ensureObjectRaster(member.source);
    if (!raster?.ready || !raster.canvas) return null;   // still decoding
    const aspect = O.keepRatio
      ? (raster.aspect || (raster.canvas.height / raster.canvas.width) || 1)
      : 1;
    clumps.push(objectClumpFor(member.source, raster, aspect));
  }
  const key = clumps.map((c) => c.key).join(',');
  if (objectShapesMemo && objectShapesMemo.key === key) return objectShapesMemo.table;
  const table = packClumps(clumps, key);
  objectShapesMemo = { key, table };
  return table;
}

// ── Editor chrome ──────────────────────────────────────────────────────────────
//
// The Solver Box, the emitter and the force arrows exist ONLY for the 3D world
// view. They hang inside the layer's own group, so they move, rotate and scale
// with it, and they are visible only while the world view has borrowed that group
// — which is also the only time the compositor pass is not drawing this layer.
// Nothing here can reach the render or an export.

const CHROME_BOX = 0x33efab;
const CHROME_EMITTER = 0xa78bfa;
const CHROME_GRAVITY = 0xffb454;
const CHROME_WIND = 0x7dd3c0;

function disposeChrome(group) {
  if (!group) return;
  group.traverse((o) => {
    o.geometry?.dispose?.();
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
    else o.material?.dispose?.();
  });
  group.removeFromParent();
}

function lineMat(color, opacity = 0.8) {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });
}

function wireBox(sx, sy, sz, color, opacity) {
  const geo = new THREE.BoxGeometry(Math.max(1, sx), Math.max(1, sy), Math.max(1, sz));
  const edges = new THREE.EdgesGeometry(geo);
  geo.dispose();
  return new THREE.LineSegments(edges, lineMat(color, opacity));
}

function ringPoints(radius, axis) {
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const c = Math.cos(a) * radius, s2 = Math.sin(a) * radius;
    if (axis === 'y') pts.push(new THREE.Vector3(c, 0, s2));
    else if (axis === 'x') pts.push(new THREE.Vector3(0, c, s2));
    else pts.push(new THREE.Vector3(c, s2, 0));
  }
  return pts;
}

function forceArrow(vec, color) {
  const len = Math.hypot(vec.x, vec.y, vec.z);
  if (len < 0.01) return null;
  const dir = new THREE.Vector3(vec.x / len, vec.y / len, vec.z / len);
  // Compressed so a gravity of 600 and a wind of 8 are both readable arrows
  // rather than one off-screen and one invisible.
  const draw = Math.min(420, 60 + Math.sqrt(len) * 22);
  const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), draw, color, draw * 0.18, draw * 0.09);
  arrow.line.material.depthTest = false;
  arrow.cone.material.depthTest = false;
  return arrow;
}

/** Rebuild the helpers when the shape they describe changes — not every frame. */
function ensureChrome(entry, system) {
  const em = system.emitters[0];
  const sig = JSON.stringify([
    system.solver.bounds.size, em.shape, em.position, em.size, em.direction, em.spread,
    system.forces.gravity, system.forces.wind,
    em.ring, em.path, em.detach, system.forceEmitters, system.pathFollow,
    system.collision && [!!system.collision.source, system.collision.size, system.collision.position, system.collision.depth, system.collision.faces],
  ]);
  if (entry.chromeSig === sig) return;
  entry.chromeSig = sig;
  disposeChrome(entry.chrome);

  const g = new THREE.Group();
  g.name = 'particle-chrome';
  g.visible = !!entry.attached;
  // Helpers draw over the particles rather than being lost inside the cloud.
  g.renderOrder = 999;

  const b = system.solver.bounds.size;
  g.add(wireBox(b.x, b.y, b.z, CHROME_BOX, 0.75));

  const eg = new THREE.Group();
  eg.position.set(em.position.x, em.position.y, em.position.z);
  const pathLine = (anchors, size, origin, color, opacity) => {
    const S = resamplePath((anchors || []).map((a) => ({ x: origin.x + a.x * size.x, y: origin.y + a.y * size.y })));
    if (!S) return null;
    const pts = [];
    for (let i = 0; i < PATH_N; i++) pts.push(new THREE.Vector3(S[i * 6], S[i * 6 + 1], S[i * 6 + 2]));
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat(color, opacity));
  };
  if (em.shape === 'box' || em.shape === 'block') {
    eg.add(wireBox(em.size.x, em.size.y, em.size.z, CHROME_EMITTER, 0.7));
  } else if (em.shape === 'ring') {
    // The annulus: centre line plus the inner and outer edges, in the comp plane.
    const r = Math.max(1, em.ring?.radius || 1), t = (em.ring?.thickness || 0) / 2;
    eg.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPoints(r, 'z')), lineMat(CHROME_EMITTER, 0.8)));
    if (t > 1) {
      eg.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPoints(Math.max(1, r - t), 'z')), lineMat(CHROME_EMITTER, 0.4)));
      eg.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPoints(r + t, 'z')), lineMat(CHROME_EMITTER, 0.4)));
    }
  } else if (em.shape === 'path') {
    // The emitter's spline (anchors are in the emitter's unit space, around eg).
    const line = pathLine(em.path?.anchors, em.size, { x: 0, y: 0 }, CHROME_EMITTER, 0.85);
    if (line) eg.add(line);
  } else if (em.shape === 'sphere') {
    const r = Math.max(1, em.size.x / 2);
    ['x', 'y', 'z'].forEach((axis) => {
      eg.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPoints(r, axis)), lineMat(CHROME_EMITTER, 0.7)));
    });
  } else if (em.shape === 'cone') {
    const r = Math.max(1, em.size.x / 2);
    eg.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPoints(r, 'y')), lineMat(CHROME_EMITTER, 0.7)));
  } else {
    const k = 26;
    const pts = [
      new THREE.Vector3(-k, 0, 0), new THREE.Vector3(k, 0, 0),
      new THREE.Vector3(0, -k, 0), new THREE.Vector3(0, k, 0),
      new THREE.Vector3(0, 0, -k), new THREE.Vector3(0, 0, k),
    ];
    eg.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat(CHROME_EMITTER, 0.9)));
  }
  // Which way it fires, and how wide.
  const dl = Math.hypot(em.direction.x, em.direction.y, em.direction.z) || 1;
  const dir = new THREE.Vector3(em.direction.x / dl, em.direction.y / dl, em.direction.z / dl);
  const axis = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), 220, CHROME_EMITTER, 40, 20);
  axis.line.material.depthTest = false;
  axis.cone.material.depthTest = false;
  eg.add(axis);
  g.add(eg);

  const gravity = forceArrow(system.forces.gravity, CHROME_GRAVITY);
  if (gravity) g.add(gravity);
  const wind = forceArrow(system.forces.wind, CHROME_WIND);
  if (wind) g.add(wind);

  // v3 — force emitters: a cross at the base, the radius it stirs, the orbit or
  // sweep it travels, and the direction of its jet.
  if (em.detach && Array.isArray(system.forceEmitters)) {
    for (const fe of system.forceEmitters) {
      const fg = new THREE.Group();
      fg.position.set(fe.position.x, fe.position.y, fe.position.z || 0);
      const k = 18;
      fg.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-k, 0, 0), new THREE.Vector3(k, 0, 0), new THREE.Vector3(0, -k, 0), new THREE.Vector3(0, k, 0),
      ]), lineMat(CHROME_WIND, 0.95)));
      fg.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPoints(Math.max(1, fe.radius), 'z')), lineMat(CHROME_WIND, 0.35)));
      if (fe.motion === 'orbit') fg.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPoints(Math.max(1, fe.motionRadius), 'z')), lineMat(CHROME_WIND, 0.5)));
      else if (fe.motion === 'sweep') fg.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-fe.motionRadius, 0, 0), new THREE.Vector3(fe.motionRadius, 0, 0)]), lineMat(CHROME_WIND, 0.5)));
      const a = (fe.direction || 0) * (Math.PI / 180);
      const jet = new THREE.ArrowHelper(new THREE.Vector3(Math.cos(a), Math.sin(a), 0), new THREE.Vector3(0, 0, 0), 120, CHROME_WIND, 26, 13);
      jet.line.material.depthTest = false; jet.cone.material.depthTest = false;
      fg.add(jet);
      g.add(fg);
    }
  }
  // v3 — path follow's own spline (anchors in the box's unit space).
  const PF = system.pathFollow;
  if (PF?.enabled && PF.anchors?.length >= 2) {
    const line = pathLine(PF.anchors, system.solver.bounds.size, { x: 0, y: 0 }, CHROME_GRAVITY, 0.7);
    if (line) g.add(line);
  }
  // v3 — the collider's slab: green for a container, amber for an obstacle.
  const C = system.collision;
  if (C?.source) {
    const cg = new THREE.Group();
    cg.position.set(C.position.x, C.position.y, 0);
    // Height / width, as in colliderTableFor — this box has to agree with the
    // SDF it is drawing, and both were inverted together, which is exactly why
    // the wireframe never gave the bug away.
    const aspect = C.source.aspect || ensureObjectRaster(C.source, EMITTER_RASTER_PX)?.aspect || 1;
    cg.add(wireBox(C.size, C.size * aspect, C.depth, C.faces === 'inner' ? CHROME_BOX : CHROME_GRAVITY, 0.55));
    g.add(cg);
  }

  entry.chrome = g;
  entry.outer.add(g);
}

// Artwork textures, cached by the canvas the rasteriser handed back — two members
// with the same artwork (and two solvers using it) share one upload.
const objectTextures = new Map();
// Live video objects. Keyed by the ELEMENT, so two members playing the same file
// share one texture and one decode.
const videoTextures = new Map();

/**
 * The live texture for a video member, or null when its element is not ready.
 * Its frame is whatever the element currently holds — the Player is what puts the
 * element on the right time (see prepareObjectVideos).
 */
function objectVideoTexture(source) {
  const frame = objectVideoFrame(source);
  if (!frame) return null;
  let tex = videoTextures.get(frame.canvas);
  if (!tex) {
    tex = new THREE.CanvasTexture(frame.canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    videoTextures.set(frame.canvas, tex);
  }
  // The canvas was just repainted with this frame, so the upload must happen.
  tex.needsUpdate = true;
  tex.__aspect = frame.aspect;
  return tex;
}

function objectTexture(raster) {
  let tex = objectTextures.get(raster.canvas);
  if (!tex) {
    tex = new THREE.CanvasTexture(raster.canvas);
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    // Particles are small on screen and their artwork is drawn once, so a mip
    // chain is worth it here: without one, a 512px logo at 40px crawls.
    tex.needsUpdate = true;
    objectTextures.set(raster.canvas, tex);
  }
  return tex;
}

// ── Per-layer runtime ──────────────────────────────────────────────────────────

const layers = new Map();   // runtimeKey -> entry

function makeRampTexture() {
  const tex = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

const parseHex = (hex) => {
  const s = String(hex || '#ffffff').replace('#', '');
  const n = (i) => parseInt(s.slice(i, i + 2), 16) || 0;
  return s.length >= 8
    ? [n(0), n(2), n(4), n(6) / 255]
    : [n(0), n(2), n(4), 1];
};

/*
 * The proximity colour ramp, as a plain 256 x RGB table.
 *
 * Not a texture: this one is read on the CPU, because the whole point of the
 * colour target is that the final RGB is composed here and handed to the shader
 * through the lane it already has for per-particle colour. Cached on the entry
 * beside the two ramp textures and rebuilt only when the stops change.
 */
function proxRampLut(entry, P) {
  if (P.colorMode !== 'ramp') return null;
  const key = JSON.stringify(P.colorRamp);
  if (entry.proxLutKey === key && entry.proxLut) return entry.proxLut;
  const list = [...P.colorRamp].sort((a, b) => a.at - b.at);
  const out = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = list[0], b = list[list.length - 1];
    for (let k = 0; k < list.length - 1; k++) {
      if (t >= list[k].at && t <= list[k + 1].at) { a = list[k]; b = list[k + 1]; break; }
    }
    if (t <= list[0].at) { a = list[0]; b = list[0]; }
    if (t >= list[list.length - 1].at) { a = list[list.length - 1]; b = a; }
    const span = Math.max(1e-6, b.at - a.at);
    const f = Math.min(1, Math.max(0, (t - a.at) / span));
    const ca = parseHex(a.color), cb = parseHex(b.color);
    out[i * 3] = (ca[0] + (cb[0] - ca[0]) * f) / 255;
    out[i * 3 + 1] = (ca[1] + (cb[1] - ca[1]) * f) / 255;
    out[i * 3 + 2] = (ca[2] + (cb[2] - ca[2]) * f) / 255;
  }
  entry.proxLutKey = key;
  entry.proxLut = out;
  return out;
}

/** Bake the colour-over-life ramp into the 256-texel lookup the shader samples. */
function writeRamp(entry, stops, slot = 'ramp') {
  const keyName = slot === 'ramp' ? 'rampKey' : 'ramp2Key';
  const key = JSON.stringify(stops);
  if (entry[keyName] === key) return;
  entry[keyName] = key;
  const list = [...stops].sort((a, b) => a.at - b.at);
  const data = entry[slot].image.data;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = list[0], b = list[list.length - 1];
    for (let k = 0; k < list.length - 1; k++) {
      if (t >= list[k].at && t <= list[k + 1].at) { a = list[k]; b = list[k + 1]; break; }
    }
    if (t <= list[0].at) { a = list[0]; b = list[0]; }
    if (t >= list[list.length - 1].at) { a = list[list.length - 1]; b = a; }
    const span = Math.max(1e-6, b.at - a.at);
    const f = Math.min(1, Math.max(0, (t - a.at) / span));
    const ca = parseHex(a.color), cb = parseHex(b.color);
    data[i * 4] = ca[0] + (cb[0] - ca[0]) * f;
    data[i * 4 + 1] = ca[1] + (cb[1] - ca[1]) * f;
    data[i * 4 + 2] = ca[2] + (cb[2] - ca[2]) * f;
    data[i * 4 + 3] = (ca[3] + (cb[3] - ca[3]) * f) * 255;
  }
  entry[slot].needsUpdate = true;
}

function makeEntry(key, maxParticles) {
  const geometry = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geometry.setAttribute('position', quad.getAttribute('position'));
  geometry.setAttribute('uv', quad.getAttribute('uv'));
  geometry.setIndex(quad.getIndex());
  quad.dispose();

  // Five vec4s, not eight loose attributes — see the VERT header: ten vertex
  // buffers exceeds WebGPU's limit of eight and the pipeline never builds.
  const iA = new THREE.InstancedBufferAttribute(new Float32Array(maxParticles * 4), 4);
  const iB = new THREE.InstancedBufferAttribute(new Float32Array(maxParticles * 4), 4);
  const iC = new THREE.InstancedBufferAttribute(new Float32Array(maxParticles * 4), 4);
  const iD = new THREE.InstancedBufferAttribute(new Float32Array(maxParticles * 4), 4);
  const iE = new THREE.InstancedBufferAttribute(new Float32Array(maxParticles * 4), 4);
  [iA, iB, iC, iD, iE].forEach((a) => { a.setUsage(THREE.DynamicDrawUsage); });
  geometry.setAttribute('iA', iA);
  geometry.setAttribute('iB', iB);
  geometry.setAttribute('iC', iC);
  geometry.setAttribute('iD', iD);
  geometry.setAttribute('iE', iE);
  geometry.instanceCount = 0;

  const ramp = makeRampTexture();
  // The second ramp is shared by the two features that need a gradient but never
  // at the same time: velocity colour is read per particle, the ignition band only
  // on particles the front has just released — and a system that colours by
  // velocity has no ignition to paint (Grow Points owns that).
  const ramp2 = makeRampTexture();
  const glslMaterial = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uRamp: { value: ramp },
      uRamp2: { value: ramp2 },
      uSprite: { value: 0 },
      uOpacity: { value: 1 },
      uTwinkle: { value: 0 },
      uSizeStart: { value: 10 },
      uSizeEnd: { value: 10 },
      uStretch: { value: 0 },
      uScale: { value: 1 },
      uAspect: { value: 1 },
      uMap: { value: null },
      uUseMap: { value: 0 },
      uTint: { value: 0 },
      uColorFromSource: { value: 0 },
      uColorFromSpeed: { value: 0 },
      uIgniteMode: { value: 0 },
      uIgniteColor: { value: new THREE.Color('#ffd7a0') },
    },
    transparent: true,
    // A billboard has no back face: never let a winding flip (see the basis note in
    // VERT) make a particle invisible.
    side: THREE.DoubleSide,
    // Particles are volumetric-ish and unlit: they neither test nor write depth
    // against each other. Alpha systems are instead sorted back-to-front on the
    // CPU each frame (see fillInstances), which is stable — an exact per-frame
    // sort makes particles at equal depth flicker.
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });

  // The node twin, when one exists, copies its blend/side/depth state off the
  // ShaderMaterial above rather than restating it — so the two cannot drift, and
  // the GLSL literal stays the single readable description of that state. Its
  // `.uniforms` is a facade of TSL uniform nodes with the same keys, so every
  // `u.uSprite.value = …` write in this file reaches it unchanged.
  const material = makeMaterial.particles(glslMaterial) || glslMaterial;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;   // instance positions are invisible to the bounds test

  const outer = new THREE.Group();
  outer.add(mesh);

  const scene = new THREE.Scene();
  scene.add(outer);

  const entry = {
    key, maxParticles, geometry, material, mesh, outer, scene, ramp, ramp2,
    rampKey: null,
    ramp2Key: null,
    camera: new THREE.PerspectiveCamera(28, 1, 1, 100000),
    target: null,
    // Scratch, allocated once: sampling and sorting must not allocate per frame.
    sample: new Float32Array(maxParticles * SAMPLE_STRIDE),
    // 'Colour at birth' with a video source: the colour each live particle was
    // emitted with, kept by uid so it survives the pool's slot recycling.
    bornUid: new Int32Array(maxParticles),
    bornCol: new Uint8Array(maxParticles * 3),
    uids: new Int32Array(maxParticles),
    order: new Uint32Array(maxParticles),
    depth: new Float32Array(maxParticles),
    attached: null,
  };
  layers.set(key, entry);
  return entry;
}

function ensureEntry(key, maxParticles) {
  const existing = layers.get(key);
  if (existing && existing.maxParticles >= maxParticles) return existing;
  if (existing) disposeParticleLayer(key);
  return makeEntry(key, maxParticles);
}

function ensureTarget(entry, width, height) {
  if (entry.target && entry.target.width === width && entry.target.height === height) return;
  entry.target?.dispose();
  entry.target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
}

/**
 * Sample the cache and fill the instance attributes for this frame.
 * Returns the number of instances written.
 */
/**
 * Which object each particle stamps.
 *
 * A short lookup table rather than `uid % members.length`, so **Share** actually
 * does something: a member with twice the weight simply takes twice as many slots.
 * Built from the member list alone, so the same particle keeps the same object for
 * its whole life and across a re-open.
 *
 * Lives in shapes.js now, because Packing's object-shape mode needs the solver to
 * know which member a particle is — and the two sides must read one function.
 */
const buildPickTable = objectPickTable;

/**
 * Sample the cache and fill the instance attributes for this frame.
 *
 * `memberIndex` >= 0 keeps only the particles assigned to that object, so every
 * object draws as its own instanced batch with its own artwork.
 * Returns the number of instances written.
 */
/**
 * One read of the particles for this frame. A LIVE engine (the WebGPU preview)
 * hands over its pool directly; a cache is sampled at `time`. Same layout.
 */
function takeSample(cache, time, entry) {
  if (cache.live) return cache.sample(entry.sample, entry.uids);
  // Packing's object-shape mode stores each particle's simulated angle. The
  // buffer exists only once a cache has one.
  let rotOut = null;
  if (cache.rot) {
    if (!entry.sampleRot || entry.sampleRot.length < entry.uids.length) entry.sampleRot = new Float32Array(entry.uids.length);
    rotOut = entry.sampleRot;
  }
  entry.sampleHasRot = !!rotOut;
  return sampleParticles(cache, time, entry.sample, entry.uids, rotOut);
}

/*
 * PROXIMITY ▸ LOOK — read at draw time, folded into lanes that already exist.
 *
 * NO NEW VERTEX ATTRIBUTE, on purpose. WebGPU caps a pipeline at 8 vertex
 * buffers and this geometry already spends 7 (position, uv, iA..iE); a sixth
 * bank would sit exactly on the cap with nothing left, and the packing comment
 * on VERT exists because going over it once already made the whole system draw
 * nothing while still reporting its instance count.
 *
 * So every look target lands on a lane whose meaning it can share:
 *
 *   size      iB.z   the per-particle size jitter, which VERT already multiplies
 *   opacity   iD.w   `leaving`, which FRAG already multiplies into alpha
 *   twinkle   iD.w   same lane: the extra flicker is computed here, from the
 *                    particle's OWN age and phase, never from wall clock
 *   spin      iD.x   the roll, added
 *   stretch   iC.xyz the velocity VERT stretches along — scaling it IS the
 *                    per-particle stretch, and nothing else reads that lane
 *   colour    iE.xyz the per-particle RGB the shader already blends in for
 *   bright    iE.xyz same lane, as a multiply
 *
 * Colour is the one that needs care. `uColorFromSource` normally means "this
 * particle wears the pixel it was emitted from"; when proximity drives colour or
 * brightness we compute the FINAL rgb here — base ramp included — and turn that
 * same switch on. The base has to be read from the identical 256-texel LUT the
 * shader samples, or a particle far from the shape (u = 0, nothing driven) would
 * shift colour the moment the effector is switched on. `sampleRampLut` below
 * replicates the texture's linear filtering exactly for that reason.
 *
 * The whole pass is skipped unless something is actually driven, so a system
 * with no effector pays one boolean.
 */

/** The LUT read the shader does: 256 texels, linear, clamped. */
function sampleRampLut(data, t, out) {
  const x = (t < 0 ? 0 : t > 1 ? 1 : t) * 255;
  const i0 = Math.min(255, Math.max(0, Math.floor(x)));
  const i1 = Math.min(255, i0 + 1);
  const f = x - i0;
  const a = i0 * 4, b = i1 * 4;
  out[0] = (data[a] + (data[b] - data[a]) * f) / 255;
  out[1] = (data[a + 1] + (data[b + 1] - data[a + 1]) * f) / 255;
  out[2] = (data[a + 2] + (data[b + 2] - data[a + 2]) * f) / 255;
  return out;
}

const parseHexRgb = (hex) => {
  const c = parseHex(hex);
  return [c[0] / 255, c[1] / 255, c[2] / 255];
};

/**
 * The proximity look amounts a fill pass needs, or null when nothing is driven.
 *
 * `cfg` is the block AS OF THIS FRAME — the caller resolves any `px:` keyframe
 * tracks first (particleProxKf.js `proxCfgAt`) and hands the result in, because
 * this file knows nothing about the timeline. It falls back to the stored block,
 * which is what it is for an un-animated effector.
 */
export function proxLookPlan(system, poses, cfg = null) {
  const P = cfg || system?.proximity;
  if (!P?.enabled || !poses?.length || !poses.some(Boolean)) return null;
  const fx = P.fx || {};
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const plan = {
    cfg: P,
    poses,
    size: n(fx.size) / 100,
    opacity: n(fx.opacity) / 100,
    spin: n(fx.spin) * Math.PI / 180,
    stretch: n(fx.stretch) / 100,
    twinkle: n(fx.twinkle) / 100,
    color: n(fx.color) / 100,
    bright: n(fx.bright) / 100,
  };
  plan.takesColor = plan.color > 0 || plan.bright !== 0;
  const any = plan.size || plan.opacity || plan.spin || plan.stretch
    || plan.twinkle || plan.takesColor;
  if (!any) return null;
  plan.solid = parseHexRgb(P.color);
  return plan;
}

function fillInstances(entry, cache, system, time, sortMatrix, pick = null, memberIndex = -1, slab = null, prox = null) {
  // Only a moving source needs a decision about WHEN its colour was read.
  const bornColors = system.render.colorMode === 'source'
    && system.render.colorSourceTime === 'birth'
    && system.emitters[0]?.source?.kind === 'video';
  // The sample is taken ONCE per frame and reused by every object batch. It used
  // to be re-taken per member, which is the same read of the same cache four
  // times over for a four-object system.
  const n = (entry.sampleTime === time && entry.sampleCache === cache && (!cache.live || entry.sampleVersion === cache.version))
    ? entry.sampleCount
    : takeSample(cache, time, entry);
  entry.sampleTime = time;
  entry.sampleCache = cache;
  entry.sampleVersion = cache.live ? cache.version : 0;
  entry.sampleCount = n;
  if (!n) return 0;
  // Grow Points, 'frozen': a particle the front has not reached yet is standing
  // on its own pixel. It draws at the HEAD of the ramp at full opacity — the
  // artwork, not a living particle — because every preset's first stop is
  // transparent and sampling the ramp at its real life would show an empty layer.
  const holdOn = !!cache.grow?.frozen;
  const A = system.activation;
  const igniteFor = A?.mode === 'grow' ? Math.max(0, A.ignite) : 0;
  const igniteBoost = igniteFor ? Math.max(0, A.igniteBoost) / 100 : 0;

  const seed = system.seed | 0;
  const frac = system.quality.previewFraction;
  const src = entry.sample;
  const sizeRandom = memberIndex >= 0 ? system.objects.sizeRandom : system.render.size.random;

  // Deterministic preview subset: a stable hash of the uid, never a shuffle, so
  // reducing density thins the system without reshuffling which particles exist.
  // Export always runs at previewFraction 1.
  let m = 0;
  const keep = entry.order;
  const mvSort = sortMatrix ? sortMatrix.elements : null;
  for (let i = 0; i < n; i++) {
    const u = entry.uids[i];
    if (frac < 1 && rnd(seed, u, 31) >= frac) continue;
    if (memberIndex >= 0) {
      if (objectMemberOf(u, pick.table, pick.random) !== memberIndex) continue;
    }
    // A DEPTH SLAB, when several objects are being drawn back to front. Sorting
    // inside each object's batch is not enough on its own: the batches themselves
    // draw in member order, so a far particle of the second object paints over a
    // near particle of the first. Slicing the depth range and drawing every
    // object within each slice puts the ordering back, for slices x objects draw
    // calls instead of one per object.
    if (slab && mvSort) {
      const k = i * SAMPLE_STRIDE;
      const z = mvSort[2] * src[k] + mvSort[6] * src[k + 1] + mvSort[10] * src[k + 2] + mvSort[14];
      if (z < slab.min || z >= slab.max) continue;
    }
    keep[m++] = i;
  }
  if (!m) return 0;

  // Back-to-front for alpha blending. Additive is order-independent, so it skips
  // the sort entirely.
  if (system.render.blend === 'alpha' && sortMatrix) {
    const e = sortMatrix.elements;
    const depth = entry.depth;
    for (let j = 0; j < m; j++) {
      const k = keep[j] * SAMPLE_STRIDE;
      depth[keep[j]] = e[2] * src[k] + e[6] * src[k + 1] + e[10] * src[k + 2] + e[14];
    }
    const view = keep.subarray(0, m);
    Array.prototype.sort.call(view, (a, b) => depth[a] - depth[b]);
  }

  // The five packed banks. Every write below is `bank.array[j * 4 + lane]`, and
  // the lane map is the one documented on VERT's attribute block.
  const bA = entry.geometry.getAttribute('iA');   // pos.xyz, speedT
  const bB = entry.geometry.getAttribute('iB');   // age, life, jitter.xy
  const bC = entry.geometry.getAttribute('iC');   // vel.xyz, held
  const bD = entry.geometry.getAttribute('iD');   // rot, squash, killScale, killAlpha
  const bE = entry.geometry.getAttribute('iE');   // colour.rgb, ignite
  // Velocity colour: the sample already carries the differenced velocity, so this
  // is a length and a lerp — no second pass over the cache.
  const byVelocity = system.render.colorMode === 'velocity';
  const vMin = system.render.velocityRange.min;
  const vSpan = Math.max(1e-3, system.render.velocityRange.max - vMin);
  // The same table the bake drew spawn positions from, indexed the same way — so a
  // particle's colour is the colour of the pixel it actually came from.
  const table = system.render.colorMode === 'source' ? spawnTableFor(system) : null;
  // A VIDEO source keeps moving: take its colours from the frame it is showing
  // rather than from the one the table was built on. Positions are untouched,
  // so this costs a texture read and never a re-simulation.
  if (table && system.emitters[0]?.source?.kind === 'video') refreshSpawnTableColors(table, system.emitters[0].source);
  // Which numbering the bake that produced this cache used for its sites.
  const growSites = !!cache.grow?.on;
  // How a particle leaves. `ttl` is baked (solver.js), so this is the one thing in
  // the frame that can act on a death BEFORE it happens — including a bounds kill,
  // which a particle has no way of anticipating on its own.
  // `fade` is the LEAVING WINDOW in seconds and `scale` is how far the particle
  // shrinks across it. One window for both: two independent durations would need a
  // third control to express, and there is no look that wants them different.
  const kill = system.render.onKill;
  const killFade = kill.fade > 0.001 ? kill.fade : 0;
  const killScale = killFade ? kill.scale : 0;
  const O = system.objects;
  const isObject = memberIndex >= 0;
  const facing = isObject ? O.facing : 'billboard';
  const spinRate = isObject ? O.spin * (O.members[memberIndex]?.spinScale ?? 1) : 0;
  // Screen-space velocity needs the view rotation; the sort matrix already is
  // (view x model), so its upper 3x3 turns a local velocity into a view one.
  const mvE = sortMatrix ? sortMatrix.elements : null;
  /*
   * PACKING ▸ SHAPE: OBJECT. The simulation owns the angle — it is what the
   * outline collided at — so the draw takes it from the sample instead of
   * making one up, and Facing does not apply. The quad is built in VIEW space,
   * so the box's own roll in view (the layer's 2D rotation, a rolled camera)
   * is added back: without it a rotated layer would draw every letter turned
   * against the outline it collided with.
   */
  const shapeRot = isObject && entry.sampleHasRot && cache.rot ? entry.sampleRot : null;
  const viewRoll = shapeRot && mvE ? Math.atan2(mvE[1], mvE[0]) : 0;
  let depthSum = 0;

  // ── PROXIMITY ▸ LOOK ──
  // One influence read per particle. Never a normal: no look target reads a
  // direction, and the gradient is four extra samples.
  const rampData = entry.ramp?.image?.data || null;
  const ramp2Data = entry.ramp2?.image?.data || null;
  const proxColor = prox?.takesColor ? proxRampLut(entry, prox.cfg) : null;
  const _rgb = [0, 0, 0];

  for (let j = 0; j < m; j++) {
    const i = keep[j];
    const k = i * SAMPLE_STRIDE;
    const u = entry.uids[i];
    bA.array[j * 4] = src[k];
    bA.array[j * 4 + 1] = src[k + 1];
    bA.array[j * 4 + 2] = src[k + 2];
    if (mvE) depthSum -= mvE[2] * src[k] + mvE[6] * src[k + 1] + mvE[10] * src[k + 2] + mvE[14];
    bB.array[j * 4] = src[k + 3];
    bB.array[j * 4 + 1] = src[k + 4];
    bC.array[j * 4] = src[k + 5];
    bC.array[j * 4 + 1] = src[k + 6];
    bC.array[j * 4 + 2] = src[k + 7];
    // Seeded on the CPU so the same particle is the same size on every machine.
    bB.array[j * 4 + 2] = 1 + srnd(seed, u, 21) * sizeRandom;
    bB.array[j * 4 + 3] = rnd(seed, u, 22) * 6.283185;

    // Orientation. Computed here rather than in the shader for the same reason
    // every other random is: a GLSL hash would be one precision difference away
    // from a machine-dependent frame.
    let rot = 0;
    let squash = 1;
    if (shapeRot) {
      rot = shapeRot[i] + viewRoll;
    } else if (isObject) {
      const age = src[k + 3];
      const dirSign = rnd(seed, u, 23) < 0.5 ? -1 : 1;
      const rate = spinRate * (0.6 + rnd(seed, u, 26) * 1.1) * dirSign;
      if (facing === 'velocity' && mvE) {
        const vxv = mvE[0] * src[k + 5] + mvE[4] * src[k + 6] + mvE[8] * src[k + 7];
        const vyv = mvE[1] * src[k + 5] + mvE[5] * src[k + 6] + mvE[9] * src[k + 7];
        if (vxv * vxv + vyv * vyv > 1e-6) rot = Math.atan2(vyv, vxv) - Math.PI / 2;
      } else {
        rot = rnd(seed, u, 24) * 6.283185 + age * rate * 2.2;
        if (facing === 'tumble') {
          // Fake the third axis: a card seen edge-on is a thin, dimmer sliver.
          squash = Math.max(0.06, Math.abs(Math.cos(rnd(seed, u, 25) * 6.283185 + age * rate * 1.7)));
        }
      }
    }
    // 1 while the particle has a future, ramping to 0 at the moment it is removed.
    let leaving = 1;
    if (killFade) {
      const ttl = src[k + 8];
      if (ttl < TTL_ALIVE) leaving = Math.min(1, ttl / killFade);
    }
    if (table) {
      // THE SITE INDEX MUST BE THE ONE THE BAKE USED, and the two paths number
      // their sites differently:
      //   rate / burst emission  slot is recycled, so the site is uid % count
      //   Grow Points            slot i IS site i for the whole clip (uid = i + 1)
      // Reading `u % count` for a grown bake is off by one — and because the table
      // picks its pixels through a hash, the next site is a spatially unrelated
      // pixel, so every particle wore a random colour instead of its own. The
      // picture came apart into confetti and looked like a colour bug.
      const idx = growSites ? (u - 1) : u;
      const site = ((idx % table.count) + table.count) % table.count * 3;
      let cr = table.colors[site], cg = table.colors[site + 1], cb = table.colors[site + 2];
      if (bornColors) {
        // First frame this uid is drawn, it takes what the source shows NOW and
        // keeps it; after that the video can move on without it.
        const slot = ((u % entry.bornUid.length) + entry.bornUid.length) % entry.bornUid.length;
        if (entry.bornUid[slot] !== u) {
          entry.bornUid[slot] = u;
          entry.bornCol[slot * 3] = cr; entry.bornCol[slot * 3 + 1] = cg; entry.bornCol[slot * 3 + 2] = cb;
        } else {
          cr = entry.bornCol[slot * 3]; cg = entry.bornCol[slot * 3 + 1]; cb = entry.bornCol[slot * 3 + 2];
        }
      }
      bE.array[j * 4] = cr / 255;
      bE.array[j * 4 + 1] = cg / 255;
      bE.array[j * 4 + 2] = cb / 255;
    }
    // Particle Activation. A held particle waits at its site; a just-released one
    // flares. Both are pure functions of what the bake already stored, so neither
    // costs a re-simulation when the flare is tuned.
    const releaseAt = src[k + 9];
    const heldNow = holdOn && time < releaseAt - 1e-6;
    let ignite = 0;
    if (!heldNow && igniteFor > 0) {
      const ageNow = src[k + 3];
      if (ageNow < igniteFor) {
        const f = 1 - ageNow / igniteFor;
        ignite = f * f * igniteBoost;
      }
    }
    bC.array[j * 4 + 3] = heldNow ? 1 : 0;
    bE.array[j * 4 + 3] = ignite;
    if (byVelocity) {
      const sp = Math.hypot(src[k + 5], src[k + 6], src[k + 7]);
      bA.array[j * 4 + 3] = Math.max(0, Math.min(1, (sp - vMin) / vSpan));
    }

    bD.array[j * 4] = rot;
    bD.array[j * 4 + 1] = squash;
    // Shrink toward (1 - strength) of its size, and fade to nothing, over the last
    // `fade` seconds. Each is off at 0, so neither costs anything unasked for.
    bD.array[j * 4 + 2] = killScale ? 1 - killScale * (1 - leaving) : 1;
    bD.array[j * 4 + 3] = leaving;

    // Every look target folds into a lane that already exists — see the note on
    // proxLookPlan for which, and why there is no sixth attribute bank.
    if (prox) {
      const pu = proxInfluence(prox.cfg, prox.poses, src[k], src[k + 1], src[k + 2], null);
      if (pu > 0.0001) {
        if (prox.size) bB.array[j * 4 + 2] *= Math.max(0, 1 + prox.size * pu);
        if (prox.spin) bD.array[j * 4] += prox.spin * pu;
        if (prox.stretch) {
          const f = Math.max(0, 1 + prox.stretch * pu);
          bC.array[j * 4] *= f; bC.array[j * 4 + 1] *= f; bC.array[j * 4 + 2] *= f;
        }
        let alphaMul = prox.opacity ? Math.max(0, Math.min(1, 1 + prox.opacity * pu)) : 1;
        if (prox.twinkle) {
          // The shader's own twinkle, repeated on the particle's OWN age and
          // phase. Never wall clock: a scrubbed frame has to match a played one.
          const phase = bB.array[j * 4 + 3];
          const age = src[k + 3];
          const amt = prox.twinkle * pu * 0.5;
          alphaMul *= Math.max(0, 1 - amt * (1 + Math.sin(phase + age * (5 + (phase % 7)))));
        }
        if (alphaMul !== 1) bD.array[j * 4 + 3] *= alphaMul;

        if (prox.takesColor) {
          // Base RGB exactly as the shader would have produced it, so switching
          // the effector on cannot shift a particle the field does not reach.
          if (table) {
            _rgb[0] = bE.array[j * 4]; _rgb[1] = bE.array[j * 4 + 1]; _rgb[2] = bE.array[j * 4 + 2];
          } else if (byVelocity && ramp2Data) {
            sampleRampLut(ramp2Data, bA.array[j * 4 + 3], _rgb);
          } else if (rampData) {
            sampleRampLut(rampData, heldNow ? 0 : Math.min(1, Math.max(0, src[k + 3] / Math.max(1e-4, src[k + 4]))), _rgb);
          } else { _rgb[0] = 1; _rgb[1] = 1; _rgb[2] = 1; }

          if (prox.color > 0) {
            const mixAmt = prox.color * pu;
            let tr, tg, tb;
            if (proxColor) {
              const o = Math.min(255, Math.max(0, Math.round(pu * 255))) * 3;
              tr = proxColor[o]; tg = proxColor[o + 1]; tb = proxColor[o + 2];
            } else { tr = prox.solid[0]; tg = prox.solid[1]; tb = prox.solid[2]; }
            _rgb[0] += (tr - _rgb[0]) * mixAmt;
            _rgb[1] += (tg - _rgb[1]) * mixAmt;
            _rgb[2] += (tb - _rgb[2]) * mixAmt;
          }
          if (prox.bright) {
            const b = Math.max(0, 1 + prox.bright * pu);
            _rgb[0] *= b; _rgb[1] *= b; _rgb[2] *= b;
          }
          bE.array[j * 4] = _rgb[0];
          bE.array[j * 4 + 1] = _rgb[1];
          bE.array[j * 4 + 2] = _rgb[2];
        }
      } else if (prox.takesColor) {
        // u = 0 still has to write the lane, because the shader is now reading
        // rgb from it for EVERY particle — leaving it stale paints the far
        // half of the cloud with whatever the last frame's near half wore.
        if (!table) {
          if (byVelocity && ramp2Data) sampleRampLut(ramp2Data, bA.array[j * 4 + 3], _rgb);
          else if (rampData) sampleRampLut(rampData, heldNow ? 0 : Math.min(1, Math.max(0, src[k + 3] / Math.max(1e-4, src[k + 4]))), _rgb);
          else { _rgb[0] = 1; _rgb[1] = 1; _rgb[2] = 1; }
          bE.array[j * 4] = _rgb[0];
          bE.array[j * 4 + 1] = _rgb[1];
          bE.array[j * 4 + 2] = _rgb[2];
        }
      }
    }
  }
  // Mean view depth of what this batch drew — see the note on viewDistance.
  if (mvE && m) {
    entry.depthSum = (entry.depthSum || 0) + depthSum;
    entry.depthCount = (entry.depthCount || 0) + m;
  }
  // A carries speedT and C/E carry the activation flags, so the banks that used
  // to be uploaded conditionally are now part of banks that always change.
  bA.needsUpdate = true;
  bB.needsUpdate = true;
  bC.needsUpdate = true;
  bD.needsUpdate = true;
  bE.needsUpdate = true;
  entry.geometry.instanceCount = m;
  return m;
}

/**
 * View-depth span of everything alive at this time, for slicing into slabs.
 * Reads the sample fillInstances has already taken (or takes it once), so this
 * costs one pass over the particles rather than a second sampling.
 */
function viewDepthRange(entry, cache, system, time, sortMatrix) {
  if (!sortMatrix) return null;
  const n = (entry.sampleTime === time && entry.sampleCache === cache && (!cache.live || entry.sampleVersion === cache.version))
    ? entry.sampleCount
    : takeSample(cache, time, entry);
  entry.sampleTime = time;
  entry.sampleCache = cache;
  entry.sampleVersion = cache.live ? cache.version : 0;
  entry.sampleCount = n;
  if (!n) return null;
  const e = sortMatrix.elements;
  const src = entry.sample;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) {
    const k = i * SAMPLE_STRIDE;
    const z = e[2] * src[k] + e[6] * src[k + 1] + e[10] * src[k + 2] + e[14];
    if (z < min) min = z;
    if (z > max) max = z;
  }
  if (!(max > min)) return null;
  return { min, max };
}

function proxyDistance(H) {
  return (H * 0.5) / Math.tan((28 * Math.PI) / 180 / 2);
}

// ── LINES ────────────────────────────────────────────────────────────────────
//
// `render.mode: 'lines'` joins particles into ribbons (sim/particles/lines.js
// builds the polylines; this turns them into geometry). The ribbon is expanded
// on the CPU, facing the camera, with a one-pixel FEATHER on each side: four
// vertices per point — outer (alpha 0), inner, inner, outer (alpha 0) — so the
// edge is anti-aliased by plain vertex-colour interpolation.
//
// That is why it is a stock MeshBasicMaterial and not a shader: it draws the
// same on WebGL and WebGPU with no node twin to keep in step, and a line thinner
// than a pixel keeps a pixel of width and loses alpha instead of breaking up.
// Built lazily, so a system that never draws lines pays nothing for it.

function ensureLineMesh(entry) {
  if (entry.lines) return entry.lines;
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  entry.outer.add(mesh);
  entry.lines = { mesh, material, capV: 0, capI: 0, buf: {} };
  return entry.lines;
}

/** Room for `nv` vertices and `ni` indices, grown by half again when short. */
function lineCapacity(LM, nv, ni) {
  if (nv <= LM.capV && ni <= LM.capI) return;
  const capV = Math.max(nv, Math.ceil(LM.capV * 1.5), 4096);
  const capI = Math.max(ni, Math.ceil(LM.capI * 1.5), 12288);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capV * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(capV * 4), 4).setUsage(THREE.DynamicDrawUsage));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(capI), 1).setUsage(THREE.DynamicDrawUsage));
  LM.mesh.geometry.dispose();
  LM.mesh.geometry = g;
  LM.capV = capV; LM.capI = capI;
}

/** The pool read once per frame, shared with fillInstances' memo. */
function sampleOnce(entry, cache, time) {
  const n = (entry.sampleTime === time && entry.sampleCache === cache && (!cache.live || entry.sampleVersion === cache.version))
    ? entry.sampleCount
    : takeSample(cache, time, entry);
  entry.sampleTime = time;
  entry.sampleCache = cache;
  entry.sampleVersion = cache.live ? cache.version : 0;
  entry.sampleCount = n;
  return n;
}

const _camLocal = new THREE.Vector3();

/**
 * Build this frame's ribbons. Returns how many lines were drawn (0 = none, and
 * the mesh is hidden). `heightPx` is the target's height: it sets how wide one
 * pixel is at each point's distance, which is what the feather is made of.
 */
function fillLines(entry, cache, system, time, cam, heightPx) {
  const LM = ensureLineMesh(entry);
  const R = system.render, em = system.emitters[0];
  const o = lineLook(system, entry.ramp.image.data, entry.ramp2.image.data, cache.duration || 6);
  const buf = LM.buf;
  // Along rows needs a rows grid; without one, a line is a trail — never a
  // silently empty layer.
  const rows = R.lines.connect === 'rows' && em?.shape === 'rows';
  const nLines = rows
    ? buildRowLines(entry.sample, entry.uids, sampleOnce(entry, cache, time), em, o, buf)
    : buildTrailLines(linePathIndex(cache), time, o, buf);
  if (!nLines) { LM.mesh.visible = false; return 0; }

  const nPts = buf.nPts;
  const nSeg = nPts - nLines;
  lineCapacity(LM, nPts * 4, nSeg * 18);
  const g = LM.mesh.geometry;
  const pos = g.attributes.position.array, col = g.attributes.color.array, ind = g.index.array;
  const P = buf.P, HW = buf.HW, C = buf.C;

  // The camera in the box's own space: ribbons face it point by point.
  _camLocal.copy(cam.position);
  entry.outer.worldToLocal(_camLocal);
  const cx = _camLocal.x, cy = _camLocal.y, cz = _camLocal.z;
  // World units per screen pixel at unit distance. In box space the layer's own
  // scale cancels: a point twice as far in box units is twice as far in world.
  const kPx = (2 * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(1, heightPx);

  let ni = 0;
  for (let l = 0; l < nLines; l++) {
    const a = buf.start[l], len = buf.len[l];
    let nx0 = 0, ny0 = 1, nz0 = 0;
    for (let q = 0; q < len; q++) {
      const k = a + q;
      const kp = a + Math.max(0, q - 1), kn = a + Math.min(len - 1, q + 1);
      const tx = P[kn * 3] - P[kp * 3], ty = P[kn * 3 + 1] - P[kp * 3 + 1], tz = P[kn * 3 + 2] - P[kp * 3 + 2];
      const px = P[k * 3], py = P[k * 3 + 1], pz = P[k * 3 + 2];
      let vx = cx - px, vy = cy - py, vz = cz - pz;
      const d = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      vx /= d; vy /= d; vz /= d;
      let nx = ty * vz - tz * vy, ny = tz * vx - tx * vz, nz = tx * vy - ty * vx;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      // Pointing straight at the camera there is no "across": keep the last one.
      if (nl > 1e-9) { nx /= nl; ny /= nl; nz /= nl; nx0 = nx; ny0 = ny; nz0 = nz; } else { nx = nx0; ny = ny0; nz = nz0; }
      const pxW = d * kPx;
      const hw = HW[k];
      const core = Math.max(hw, pxW * 0.5);
      const thin = hw < pxW * 0.5 ? hw / (pxW * 0.5) : 1;
      const inner = core - pxW * 0.5, outer = core + pxW * 0.5;
      const v = k * 4;
      const r = C[k * 4], gg = C[k * 4 + 1], b = C[k * 4 + 2], al = C[k * 4 + 3] * thin;
      for (let s4 = 0; s4 < 4; s4++) {
        const off = s4 === 0 ? -outer : s4 === 1 ? -inner : s4 === 2 ? inner : outer;
        const o3 = (v + s4) * 3, o4 = (v + s4) * 4;
        pos[o3] = px + nx * off; pos[o3 + 1] = py + ny * off; pos[o3 + 2] = pz + nz * off;
        col[o4] = r; col[o4 + 1] = gg; col[o4 + 2] = b; col[o4 + 3] = s4 === 0 || s4 === 3 ? 0 : al;
      }
      if (q > 0) {
        const p0 = (k - 1) * 4, p1 = k * 4;
        for (let s3 = 0; s3 < 3; s3++) {
          const A0 = p0 + s3, A1 = p0 + s3 + 1, B0 = p1 + s3, B1 = p1 + s3 + 1;
          ind[ni++] = A0; ind[ni++] = A1; ind[ni++] = B1;
          ind[ni++] = A0; ind[ni++] = B1; ind[ni++] = B0;
        }
      }
    }
  }
  const nv = nPts * 4;
  for (const [attr, n] of [[g.attributes.position, nv * 3], [g.attributes.color, nv * 4], [g.index, ni]]) {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, n);
    attr.needsUpdate = true;
  }
  g.setDrawRange(0, ni);
  // Same convention as the sprites: the target ends up premultiplied either way.
  const blending = R.blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending;
  if (LM.material.blending !== blending) { LM.material.blending = blending; LM.material.needsUpdate = true; }
  LM.mesh.visible = true;
  return nLines;
}

/**
 * Draw one particle layer.
 *
 * opts: { key, system, cache, pose, prs, W, H, width, height, time, near, far }
 * Returns { texture, viewDistance, drawn } — or a null texture when there is
 * nothing alive at this time, which the Player treats as "draw no layer".
 */
export function renderParticleLayer(renderer, opts) {
  const { key, system, cache, pose, prs, W, H, width, height, time } = opts;
  /*
   * A TIER 2 LAYER HAS NO BAKE, and that is the point — Player.jsx stops asking
   * for one the moment the GPU runtime owns the layer. This function used to
   * return empty on a null cache before it ever reached the GPU branch below, so
   * skipping the bake would have made every Tier 2 layer invisible.
   *
   * The CPU entry is still built, because the GPU branch borrows three things
   * from it: the two ramp LUTs, the camera, and the world-view chrome. It is
   * built at its MINIMUM size — the instanced geometry it would otherwise size
   * to the bake's particle count is dead weight when nothing draws through it.
   */
  const gpuOn = !!(opts.gpu && opts.gpu.ok);
  if (!system || (!cache && !gpuOn)) return { texture: null, viewDistance: null, drawn: 0 };

  const entry = ensureEntry(key, cache ? cache.maxP : 1);
  if (!gpuOn) ensureTarget(entry, Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));

  // The Solver Box IS the layer: its transform is the layer's PRS, so moving,
  // rotating, scaling, parenting or keyframing the layer moves the whole volume.
  // V1 simulates in local space, so the particles travel with it.
  entry.outer.position.set(prs?.px || 0, prs?.py || 0, prs?.pz || 0);
  entry.outer.rotation.set(prs?.rx || 0, prs?.ry || 0, prs?.rz || 0, 'XYZ');
  const sx = Number.isFinite(prs?.sx) && prs.sx > 0 ? prs.sx : 1;
  const sy = Number.isFinite(prs?.sy) && prs.sy > 0 ? prs.sy : sx;
  const sz = Number.isFinite(prs?.sz) && prs.sz > 0 ? prs.sz : sx;
  entry.outer.scale.set(sx, sy, sz);
  entry.scene.updateMatrixWorld(true);

  // Camera: the same forward pose as every other spatial layer, with camZoom
  // folded into an effective FOV.
  const cam = entry.camera;
  const proxy = pose ? cameraProxyFromPose(pose, W, H) : null;
  const D = proxyDistance(H);
  if (proxy) {
    cam.position.copy(proxy.position);
    cam.quaternion.copy(proxy.quaternion);
    cam.fov = proxy.fov;
  } else {
    cam.position.set(0, 0, D);
    cam.quaternion.identity();
    cam.fov = 28;
  }
  cam.aspect = W / H;
  cam.near = Number.isFinite(opts.near) && opts.near > 0 ? opts.near : Math.max(1, D * 0.001);
  cam.far = Number.isFinite(opts.far) && opts.far > cam.near ? opts.far : D * 20;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);

  // World-view helpers. Built here so they always describe the CURRENT solver, and
  // hidden unless the world view has borrowed this group.
  ensureChrome(entry, system);
  if (entry.chrome) entry.chrome.visible = !!entry.attached;

  _mv.multiplyMatrices(cam.matrixWorldInverse, entry.outer.matrixWorld);

  // Depth for channel ordering and camera depth of field.
  //
  // The BOX centre is the wrong answer whenever the particles are not centred in
  // it — a fountain living in the bottom of a tall box, or a cloud that has
  // drifted downwind — and depth of field would focus on empty space. The mean
  // depth of what is actually drawn is where the layer really is. Falls back to
  // the box centre when nothing is alive, so the layer keeps a stable place in
  // the stack rather than jumping when it empties.
  entry.outer.getWorldPosition(_worldPos);
  _worldPos.applyMatrix4(cam.matrixWorldInverse);
  let viewDistance = -_worldPos.z;
  const viewRange = solverBoxRange(entry.outer, system.solver?.bounds?.size, cam);
  entry.depthSum = 0;
  entry.depthCount = 0;

  // Layer objects: every included member that has finished rasterising becomes one
  // instanced batch with its own artwork. A member whose image is still decoding is
  // simply skipped this frame — the next one picks it up.
  const O = system.objects;
  const batches = [];
  if (system.render.mode === 'layers') {
    const included = O.members.filter((m) => m.included);
    const pick = { table: buildPickTable(included), random: O.pick === 'random' };
    const liveVideo = O.playVideo === true;
    included.forEach((member, index) => {
      // A live video member is drawn from its element, not from a raster — so it
      // is ready as soon as the element has a frame, and it never waits on the
      // still.
      if (liveVideo && member.source?.kind === 'video') {
        // Anything that goes wrong reaching for a live frame drops this member to
        // its still. A throw here used to take the whole frame with it — the
        // export logs one warning and encodes black — and no look control may be
        // able to do that.
        let tex = null;
        try { tex = objectVideoTexture(member.source); } catch { tex = null; }
        // FALLS BACK TO THE STILL, never to nothing. A live texture can be
        // missing for a while — the element is still loading, or the frame has
        // not decoded — and a member that skipped itself in that window made the
        // whole layer disappear the moment the switch was turned on. Showing the
        // snapshot until the video is there is always the smaller wrong.
        // The texture carries its own aspect: its image is the frame CANVAS, so
        // there is no videoWidth to read here.
        if (tex) {
          batches.push({ member, index, pick, video: tex, aspect: tex.__aspect || 1 });
          return;
        }
      }
      const raster = ensureObjectRaster(member.source);
      if (!raster?.ready || !raster.canvas) return;
      batches.push({ member, index, pick, raster });
    });
    // Every object still decoding (or none picked yet) means nothing to draw —
    // fall through to the sprite rather than leaving the layer blank.
    if (!batches.length) O.__fallback = true; else O.__fallback = false;
  }

  const R = system.render;
  writeRamp(entry, R.colorOverLife);
  const A = system.activation;
  /*
   * PROXIMITY ▸ LOOK. `opts.proxPoses` is resolved by the caller — the source
   * layers' live transforms in this box's own space (particleProxTrack.js),
   * because this file knows nothing about the timeline. Null / empty means the
   * effector is off, has no source, or its artwork is still decoding, and the
   * whole pass is skipped.
   *
   * `opts.proxCfg` is the same caller's answer to the other timeline question:
   * the block with this frame's `px:` keyframe values folded in. It is the SAME
   * object as system.proximity when nothing is animated, so an un-keyed effector
   * allocates nothing and the ramp LUT's identity check still holds.
   */
  const proxPlan = proxLookPlan(system, opts.proxPoses, opts.proxCfg);
  const byVelocity = R.colorMode === 'velocity' && R.mode !== 'layers';
  const ignitePaints = A?.mode === 'grow' && A.ignite > 0.001 && A.igniteMode !== 'flash';
  // One second ramp, two consumers — velocity colour wins if a system somehow
  // asks for both, because it applies to every particle and the flare to a few.
  if (byVelocity) writeRamp(entry, R.velocityRamp, 'ramp2');
  else if (ignitePaints) writeRamp(entry, A.igniteRamp, 'ramp2');

  // ONE MAPPING, TWO CONSUMERS. These values feed the GLSL material below and,
  // when the system is on the GPU runtime, that engine's own shader. Computing
  // them once is what stops the two from drifting: a look tweak that reached
  // only one path would show up as "the preview and the export disagree", which
  // is the hardest class of bug to trace back to a uniform.
  const drawScalars = {
    sprite: SPRITE_INDEX[R.sprite] ?? 0,
    opacity: R.opacity,
    twinkle: R.twinkle,
    scale: (sx + sy) / 2,
    tint: O.tint ? 1 : 0,
    /*
     * When proximity drives colour or brightness, `fillInstances` composes the
     * FINAL rgb per particle — base ramp, tint and brightness together — and
     * hands it over through the lane the shader already reads for source
     * colour. So this switch goes on, and the speed switch goes OFF: the
     * velocity gradient has already been folded in, and leaving it on would
     * blend it a second time over the top.
     */
    colorFromSource: (proxPlan?.takesColor || (R.colorMode === 'source' && R.mode !== 'layers')) ? 1 : 0,
    colorFromSpeed: byVelocity && !proxPlan?.takesColor ? 1 : 0,
    igniteMode: !ignitePaints || byVelocity ? 0 : (A.igniteMode === 'gradient' ? 2 : 1),
  };

  const u = entry.material.uniforms;
  u.uSprite.value = drawScalars.sprite;
  u.uOpacity.value = drawScalars.opacity;
  u.uTwinkle.value = drawScalars.twinkle;
  u.uScale.value = drawScalars.scale;
  u.uTint.value = drawScalars.tint;
  u.uColorFromSource.value = drawScalars.colorFromSource;
  u.uColorFromSpeed.value = drawScalars.colorFromSpeed;
  u.uIgniteMode.value = drawScalars.igniteMode;
  if (ignitePaints) u.uIgniteColor.value.set(A.igniteColor.slice(0, 7));
  const additive = R.blend === 'additive';
  const wantDst = additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor;
  if (entry.material.blendDst !== wantDst) {
    entry.material.blendDst = wantDst;
    entry.material.blendDstAlpha = wantDst;
    entry.material.needsUpdate = true;
  }

  // ── TIER 2: the system draws itself, and we publish its canvas ────────────
  //
  // The runtime owns a WebGPU device, a canvas and a depth buffer of its own,
  // and it has already been stepped to this time by the manager. All that is
  // left is to hand it the camera and the look, and wrap the result.
  //
  // The compositor cannot tell the difference: renderParticleLayer has always
  // returned a flat texture and never a depth texture (Player.jsx's note on
  // viewDistance says why), so a CanvasTexture goes exactly where the render
  // target's texture used to.
  if (opts.gpu && opts.gpu.ok) {
    const g = opts.gpu;
    g.resize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
    // The ramps are LUTs the CPU has already built for the GLSL path; hand the
    // same bytes over rather than rebuilding them, and only when they change.
    /*
     * RE-UPLOAD WHEN THE RUNTIME CHANGES, NOT ONLY WHEN THE RAMP DOES.
     *
     * These textures live on the RUNTIME; the memo that decides whether to send
     * them lives on the LAYER. The two have different lifetimes, and switching
     * Preview to Baked and back proves it: Baked drops the runtime, Auto builds
     * a fresh one with empty ramps, and the layer — still holding the old key —
     * decides there is nothing to upload. Every particle then samples a ramp
     * that is entirely zero, which is zero alpha, so the layer draws a full pool
     * of completely invisible particles. The runtime reports itself healthy
     * throughout (ready, stepping, a million uids issued) because it IS: it is
     * faithfully drawing nothing.
     *
     * Reloading the editor fixed it by discarding the layer entry, which is what
     * made it look like a stuck cache rather than a lifetime mismatch.
     *
     * The plate texture below already compares against `g.canvas` for the same
     * reason; the ramps simply never got the same treatment.
     */
    if (entry.gpuRampOwner !== g) { entry.gpuRampKey = null; entry.gpuRamp2Key = null; entry.gpuRampOwner = g; }
    if (entry.gpuRampKey !== entry.rampKey) { g.setRamp(1, entry.ramp.image.data); entry.gpuRampKey = entry.rampKey; }
    if (entry.gpuRamp2Key !== entry.ramp2Key) { g.setRamp(2, entry.ramp2.image.data); entry.gpuRamp2Key = entry.ramp2Key; }

    g.render({
      t: time,
      mv: _mv.elements,
      proj: cam.projectionMatrix.elements,
      derive: {
        sizeRandom: R.size.random,
        velMin: R.velocityRange.min,
        velSpan: Math.max(1e-3, R.velocityRange.max - R.velocityRange.min),
        byVelocity: byVelocity ? 1 : 0,
        killFade: R.onKill.fade > 0.001 ? R.onKill.fade : 0,
        killScale: R.onKill.fade > 0.001 ? R.onKill.scale : 0,
        igniteFor: A?.mode === 'grow' ? Math.max(0, A.ignite) : 0,
        igniteBoost: A?.mode === 'grow' ? Math.max(0, A.igniteBoost) / 100 : 0,
        holdOn: 0,
        previewFraction: system.quality.previewFraction,
        colorFromTable: drawScalars.colorFromSource,
        growSites: 0,
      },
      scalars: {
        ...drawScalars,
        sizeStart: R.size.start,
        sizeEnd: R.size.end,
        stretch: R.stretch || 0,
        aspect: 1,
        useMap: 0,
      },
      igniteColor: ignitePaints ? [...parseHex(A.igniteColor).map((c) => c / 255), 1] : [1, 0.843, 0.627, 1],
      blend: R.blend === 'additive' ? 'additive' : 'alpha',
    });

    if (!entry.gpuTexture || entry.gpuCanvas !== g.canvas) {
      entry.gpuTexture?.dispose();
      entry.gpuTexture = new THREE.CanvasTexture(g.canvas);
      /*
       * MATCH THE RENDER TARGET THIS REPLACES, flag for flag.
       *
       * `ensureTarget` builds a plain WebGLRenderTarget: NoColorSpace, no
       * premultiply on upload. The compositor samples whatever it is handed and
       * converts once on output, so any conversion here is a SECOND one.
       *
       * SRGBColorSpace was the bug that made particles nearly invisible in the
       * app while looking perfect in every harness: three decodes sRGB to linear
       * when sampling, so 0.1 arrives as 0.01. A test that renders the plate and
       * then encodes back to sRGB on output cancels it exactly and sees nothing
       * wrong — which is what mine did. Only the real compositor, which converts
       * once at the end, shows it.
       *
       * The canvas is already premultiplied (alphaMode: 'premultiplied'), so
       * premultiplyAlpha must stay false or the RGB is multiplied by alpha twice.
       */
      entry.gpuTexture.colorSpace = THREE.NoColorSpace;
      entry.gpuTexture.premultiplyAlpha = false;
      /*
       * THIS PLATE IS NOT A RENDER TARGET, AND THE COMPOSITOR HAS TO KNOW.
       *
       * On WebGPU the compositor flips V for every override plate except the
       * ones it knows are already screen-oriented (model3d, the Rig, a grid) —
       * because a compositor render target really is on the opposite V axis
       * there. The Tier 1 particle plate IS such a target, so it wants that
       * flip; this one is a CANVAS from a different device, which arrives in
       * image orientation like an uploaded picture, and flipping it puts the
       * layer upside down.
       *
       * It only showed up in renders. WebGL's texture upload flips a canvas on
       * the way in, so the two paths agree there and the editor looks right on
       * the default backend — the mirror only appears once something is drawn on
       * WebGPU, which for most projects is the export.
       *
       * Marked on the texture rather than by media type, because a particle
       * layer is Tier 1 or Tier 2 frame by frame and only one of the two wants
       * the flip. See Player.jsx's plateAlreadyNormalized.
       */
      entry.gpuTexture.userData.plateNormalized = true;
      entry.gpuTexture.minFilter = THREE.LinearFilter;
      entry.gpuTexture.magFilter = THREE.LinearFilter;
      entry.gpuCanvas = g.canvas;
    }
    entry.gpuTexture.needsUpdate = true;
    return { texture: entry.gpuTexture, viewDistance, viewRange, drawn: -1 };
  }

  // ── Draw. The renderer is shared, so every piece of state touched here is
  // saved and restored; the composite loop runs with autoClear = false.
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevClearAlpha = renderer.getClearAlpha();

  renderer.autoClear = false;
  renderer.setRenderTarget(entry.target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);

  let drawn = 0;
  // The ribbon mesh lives in the same group; only a lines frame shows it.
  if (entry.lines) entry.lines.mesh.visible = false;
  entry.mesh.visible = true;
  if (R.mode === 'lines') {
    drawn = fillLines(entry, cache, system, time, cam, Math.max(1, Math.round(height)));
    // Show particles: the sprites draw under the lines, as they would alone.
    const dots = R.lines.showParticles ? fillInstances(entry, cache, system, time, _mv, null, -1, null, proxPlan) : 0;
    entry.mesh.visible = dots > 0;
    if (dots) {
      u.uUseMap.value = 0;
      u.uMap.value = null;
      u.uAspect.value = 1;
      u.uSizeStart.value = R.size.start;
      u.uSizeEnd.value = R.size.end;
      u.uStretch.value = R.stretch;
    }
    if (drawn || dots) renderer.render(entry.scene, cam);
    drawn += dots;
  } else if (batches.length) {
    // One instanced batch per object. Instance attributes have to be refilled
    // between them (WebGL has no per-draw instance offset), which is a few hundred
    // floats per member — far cheaper than a texture atlas would be to keep in
    // sync with artwork that can change from the panel at any moment.
    //
    // ORDER ACROSS OBJECTS. Sorting inside each batch is not enough: the batches
    // themselves draw one after another, so every particle of object B lands on
    // top of every particle of object A regardless of depth. Invisible on small
    // confetti, obvious the moment two large translucent objects interpenetrate.
    // The depth range is therefore cut into slabs and every object is drawn
    // within each slab, far to near — correct ordering at slab granularity for
    // slabs x objects draw calls. Additive blending is order-independent and a
    // single object has nothing to cross, so both keep the one-pass path.
    let liveDrawError = null;
    const needsOrder = system.render.blend === 'alpha' && batches.length > 1;
    let slabs = null;
    if (needsOrder) {
      // Bounded so a twelve-object system cannot turn into hundreds of draws.
      const count = Math.max(1, Math.min(8, Math.floor(48 / batches.length)));
      const range = viewDepthRange(entry, cache, system, time, _mv);
      if (range && count > 1) {
        slabs = [];
        // Far to near: the sort inside a slab is the same direction.
        const step = (range.max - range.min) / count;
        for (let k = 0; k < count; k++) {
          slabs.push({ min: range.min + step * k, max: k === count - 1 ? Infinity : range.min + step * (k + 1) });
        }
      }
    }
    const passes = slabs || [null];
    for (const slab of passes) {
      for (const batch of batches) {
        const count = fillInstances(entry, cache, system, time, _mv, batch.pick, batch.index, slab, proxPlan);
        if (!count) continue;
        const size = O.size * (batch.member.sizeScale ?? 1);
        u.uUseMap.value = 1;
        u.uMap.value = batch.video || objectTexture(batch.raster);
        u.uAspect.value = O.keepRatio ? (batch.video ? batch.aspect : batch.raster.aspect) : 1;
        u.uSizeStart.value = size;
        u.uSizeEnd.value = size;
        u.uStretch.value = 0;
        renderer.render(entry.scene, cam);
        drawn += count;
      }
    }
  } else {
    drawn = fillInstances(entry, cache, system, time, _mv, null, -1, null, proxPlan);
    if (drawn) {
      u.uUseMap.value = 0;
      u.uMap.value = null;
      u.uAspect.value = 1;
      u.uSizeStart.value = R.size.start;
      u.uSizeEnd.value = R.size.end;
      u.uStretch.value = R.stretch;
      renderer.render(entry.scene, cam);
    }
  }

  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  renderer.setClearColor(prevClear, prevClearAlpha);

  if (!drawn) return { texture: null, viewDistance, viewRange, drawn: 0 };
  if (entry.depthCount) viewDistance = entry.depthSum / entry.depthCount;
  return { texture: entry.target.texture, viewDistance, viewRange, drawn };
}

// ── World view ────────────────────────────────────────────────────────────────
//
// The 3D world view borrows the live particle object into its own scene rather
// than building a second one, so what you orbit is exactly what renders.

export function attachParticlesToScene(key, scene) {
  const entry = layers.get(key);
  if (!entry || !scene || entry.outer.parent === scene) return null;
  const home = entry.outer.parent || entry.scene;
  scene.add(entry.outer);
  entry.attached = scene;
  if (entry.chrome) entry.chrome.visible = true;
  return () => {
    entry.attached = null;
    if (entry.chrome) entry.chrome.visible = false;
    if (home) home.add(entry.outer);
  };
}

/** The stable outer group, for the world-view transform gizmo. */
export function getParticleWorldObject(key) {
  return layers.get(key)?.outer || null;
}

export function disposeParticleLayer(key) {
  const entry = layers.get(key);
  if (!entry) return;
  disposeChrome(entry.chrome);
  entry.chrome = null;
  if (entry.lines) { entry.lines.mesh.geometry.dispose(); entry.lines.material.dispose(); entry.lines = null; }
  entry.geometry.dispose();
  entry.material.dispose();
  entry.ramp.dispose();
  entry.ramp2.dispose();
  entry.target?.dispose();
  entry.outer.removeFromParent();
  layers.delete(key);
}

/** Live video textures are shared, so they are dropped with the runtimes. */
export function disposeParticleVideoTextures() {
  for (const tex of videoTextures.values()) tex.dispose();
  videoTextures.clear();
}

export function disposeAllParticleLayers() {
  for (const key of [...layers.keys()]) disposeParticleLayer(key);
  disposeParticleVideoTextures();
}

/** Drop runtimes for layers no longer on the timeline. */
export function gcParticleLayers(liveKeys) {
  for (const key of [...layers.keys()]) {
    if (!liveKeys.has(key)) disposeParticleLayer(key);
  }
}
