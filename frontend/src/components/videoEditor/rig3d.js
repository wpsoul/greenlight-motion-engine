/*
 * 3D Rig — the shared set for models and flat shadow plates: lights, cyclorama,
 * environment and shadow maps.
 *
 * A LEAF module, like types.js. It imports nothing from the editor, so the project
 * sanitizer in VideoEditor.jsx, the panel in EditorPanel.jsx, the render pass in
 * model3dLayer.js and the node test runner can all pull it in without closing a
 * cycle. Nothing here touches three.js — the shapes and the maths only.
 *
 * See PLANS/SCENE_3D_RIG_PLAN.md. Three decisions from that plan are encoded here
 * rather than left to call sites, because getting them wrong is silent:
 *
 *   1. Light placement is SPHERICAL around the rig origin (az/elev degrees + a
 *      world distance), not cartesian. That is how people describe lighting ("key
 *      45 degrees camera-left, a bit above"), it keeps a light aimed at the subject
 *      for free, and it survives a composition resize.
 *   2. Cyclorama dimensions are stored in MULTIPLES OF COMPOSITION HEIGHT, not
 *      pixels — see CYC_DEFAULTS. A comp resize then needs no migration at all.
 *   3. A light that is switched off keeps its object and gets intensity 0. Never
 *      add/remove to toggle: NUM_DIR_LIGHTS and friends are shader #defines, so a
 *      count change recompiles every material in the shared world scene.
 */

// ── Timeline identity ───────────────────────────────────────────────────────
// Mirrors CAMERA_MEDIA_TYPE / CAMERA_CHANNEL_KIND in projectCamera.js. Unlike the
// camera, a rig clip DRAWS (the cyclorama), so it is not a SYNTHETIC_MEDIA_TYPE.
export const RIG_MEDIA_TYPE = 'rig';
export const RIG_CHANNEL_KIND = 'rig';
export const RIG_CLIP_DURATION_SECONDS = 5;

// A light count change recompiles every material in the shared world scene, so the
// list is capped rather than left open. Eight is well past any real lighting setup
// and keeps the worst-case recompile bounded.
export const MAX_LIGHTS = 8;

export const LIGHT_TYPES = ['directional', 'point', 'spot', 'ambient', 'hemisphere'];
export const CYC_SHAPES = ['cyc', 'floor', 'wall', 'corner', 'room', 'cylinder', 'dome', 'disc', 'none'];
export const CYC_MATERIAL_MODES = ['solid', 'shadowCatcher', 'image'];
export const ENV_SOURCES = ['preset', 'custom', 'none'];
export const SHADOW_MODES = ['off', 'contact', 'map'];

// Same discipline rigDeform.js uses for pin ids: short, url-safe, no separators
// that would collide with the `sc:<lid>:<chan>` keyframe key format below.
const LID_RE = /^[A-Za-z0-9_-]{1,12}$/;

export function isValidLid(lid) {
  return typeof lid === 'string' && LID_RE.test(lid);
}

export function isRigChannel(channel) {
  return !!channel && channel.kind === RIG_CHANNEL_KIND;
}

export function findRigChannel(channels) {
  return (channels || []).find(isRigChannel) || null;
}

/**
 * The rig channel sits directly UNDER the camera channel — the two author the set
 * and the lens on it, so they read as one block at the top of the stack rather than
 * the rig being stranded at the far end of a long timeline.
 *
 * MUST be composed with pinCameraChannelTop in ONE call on every channel write, and
 * AFTER it: this places the rig relative to wherever the camera ended up, so running
 * them independently (or in the other order) lands the rig in a different slot
 * depending on which pass ran last.
 */
export function pinRigChannelUnderCamera(channels, isCameraChannelFn) {
  if (!Array.isArray(channels) || channels.length < 2) return channels;
  const index = channels.findIndex(isRigChannel);
  if (index < 0) return channels;
  const next = channels.slice();
  const [rigChannel] = next.splice(index, 1);
  // Channel order is z-order and the LAST entry renders highest, so "under the
  // camera" is the slot before it — or the top of the stack when there is no camera.
  const camIndex = typeof isCameraChannelFn === 'function' ? next.findIndex(isCameraChannelFn) : -1;
  const at = camIndex >= 0 ? camIndex : next.length;
  next.splice(at, 0, rigChannel);
  return next;
}

// ── Small local helpers ─────────────────────────────────────────────────────
// Deliberately local: importing the editor's sanitizeNumber would make this a
// non-leaf module and reintroduce the cycle this file exists to avoid.

function num(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function str(value, fallback) {
  return typeof value === 'string' && value ? value : fallback;
}

// Colours are stored as authored (hex or rgba string) and parsed at apply time, the
// same contract the rest of the editor's colour fields use.
function color(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// ── Spherical placement ─────────────────────────────────────────────────────
//
// Convention, fixed here so the panel dial, the world-view drag write-back and the
// render pass cannot disagree:
//
//   elev  angle above the horizon plane, +90 straight overhead, -90 straight under.
//         The 3D pass scene is Y-UP, so this needs no sign flip — but the editor's
//         2D layer space is +Y DOWN, so never carry a `py` into this space unchanged.
//   az    angle around the vertical axis measured FROM +Z toward +X. The camera sits
//         on +Z, so az 0 is IN FRONT of the subject (between it and the camera),
//         az +90 is camera-right and az 180 is behind the subject. The panel's dial
//         is a plan view with az 180 at the TOP, which is how a map reads: up is
//         away from you.
//   dist  world distance from the rig origin (composition pixels)
//
// For a directional light only the direction matters — `dist` positions its shadow
// camera. For point and spot it is a real position and drives the falloff.

// The 3D pass scene is Y-UP — verified by rendering, not assumed: a mesh placed at
// y = +540 draws at the TOP of the frame. (The editor's 2D layer space is +Y down,
// which is the trap: `prs.py` and this space do not share a sign, and every builder
// that assumed they did produced a set that was upside down but plausible-looking.)
//
// So +elev really is above the horizon and needs no negation, and the legacy key
// light at {1, 1.4, 1.2} genuinely lights from above.
export function vectorFromSpherical(az, elev, dist = 1) {
  const a = az * D2R;
  const e = elev * D2R;
  const horiz = Math.cos(e) * dist;
  return { x: Math.sin(a) * horiz, y: Math.sin(e) * dist, z: Math.cos(a) * horiz };
}

export function sphericalFromVector(x, y, z) {
  const dist = Math.sqrt(x * x + y * y + z * z);
  if (!(dist > 0)) return { az: 0, elev: 0, dist: 0 };
  return {
    az: Math.atan2(x, z) * R2D,
    elev: Math.asin(Math.max(-1, Math.min(1, y / dist))) * R2D,
    dist,
  };
}

// ── Point / spot intensity ──────────────────────────────────────────────────
//
// three r155+ treats point and spot intensity as CANDELA, and the surface receives
// candela / d^decay (decay 2 = physically correct). One world unit here is one
// composition pixel, so an un-normalised intensity of 1 at 3000 px delivers ~10⁻⁷
// of what the user expects and the light reads as switched off.
//
// Normalise at APPLY time so the stored number stays the one the user typed, and
// so it means what it means on a directional light: the light the SET receives at
// the light's own distance. A spot of 2 at 2400 px therefore lights the subject
// like a directional of 2, and falls off physically around it.
//
// (This used to divide by a 1000 px "reference distance" squared, which left every
// point and spot light a millionth as bright as its number — effectively off.)
export function candelaIntensity(uiIntensity, distWorld, decay = 2) {
  const ui = num(uiIntensity, 0, 0, Infinity);
  const d = num(distWorld, 0, 0, Infinity);
  const k = num(decay, 2, 0, 4);
  // Monotonic in d and finite at d = 0 (a light at the origin contributes nothing
  // rather than dividing by zero somewhere downstream). decay 0 = no falloff, so the
  // number is already the received light.
  if (k === 0) return ui;
  return ui * Math.pow(d, k);
}

// ── Legacy three-light default ──────────────────────────────────────────────
//
// The exact vectors makeLights() has always used in model3dLayer.js. Kept as data
// so normalizeRig can reproduce the historical look bit-for-bit: every project
// saved before the rig existed must light identically after it.
//
// A DirectionalLight's position IS its direction (it aims at the origin), so only
// the normalised vector matters — the rig stores a world-scale `dist` instead,
// which positions the shadow camera without changing the shading at all.
export const LEGACY_LIGHT_VECTORS = Object.freeze({
  key: Object.freeze({ x: 1, y: 1.4, z: 1.2 }),
  fill: Object.freeze({ x: -1.2, y: 0.4, z: 0.8 }),
  rim: Object.freeze({ x: -0.4, y: 0.8, z: -1.4 }),
});

export const LEGACY_LIGHT_INTENSITIES = Object.freeze({ key: 1, fill: 0.45, rim: 0.35 });

// Where the legacy directionals sit once given a world distance. Directional light
// shading is unaffected by distance; this only has to be far enough out that the
// fitted shadow frustum contains the set.
export const LEGACY_LIGHT_DISTANCE = 3000;

function legacyLight(name, lid, intensity) {
  const v = LEGACY_LIGHT_VECTORS[name];
  const { az, elev } = sphericalFromVector(v.x, v.y, v.z);
  return {
    lid,
    type: 'directional',
    name: name.charAt(0).toUpperCase() + name.slice(1),
    on: true,
    color: '#ffffff',
    intensity,
    az,
    elev,
    dist: LEGACY_LIGHT_DISTANCE,
    castShadow: false,
    shadowSoftness: 1,
    shadowMapSize: 1024,
  };
}

/** The three historical directionals as rig lights. Identical directions, identical
 *  intensities — the migration reference and the "no rig layer" fallback. */
export function legacyRigLights(intensities = null) {
  const i = intensities && typeof intensities === 'object' ? intensities : LEGACY_LIGHT_INTENSITIES;
  return [
    legacyLight('key', 'k1', num(i.key, LEGACY_LIGHT_INTENSITIES.key, 0, 10)),
    legacyLight('fill', 'f1', num(i.fill, LEGACY_LIGHT_INTENSITIES.fill, 0, 10)),
    legacyLight('rim', 'r1', num(i.rim, LEGACY_LIGHT_INTENSITIES.rim, 0, 10)),
  ];
}

// ── Defaults ────────────────────────────────────────────────────────────────
//
// Cyclorama dimensions are MULTIPLES OF COMPOSITION HEIGHT, not pixels. A 1080-tall
// comp therefore gets a 4320 x 2430 x 3240 px set from the numbers below. Storing
// them relative is what makes a composition resize a no-op: the alternative (world
// px plus a re-fit hook) needs a migration that has to run everywhere a comp size
// can change, and silently mis-sizes every set it misses. The panel multiplies by
// comp height for display, so users still type pixels — see cycSizePx().
// Sized against WHAT THE CAMERA ACTUALLY SEES, which is the difference between a set
// and a wash. At the neutral lens the frame is 1 comp height tall and 1.78 wide at
// the subject, so a 4 x 2.25 x 3 set (the first pass at these numbers) put every
// edge, corner and curve outside the shot: Corner looked identical to Cyclorama,
// Room had no visible walls, and the whole feature read as "it just draws a plate".
// 2.2 wide leaves the side walls inside the frustum a little behind the subject.
export const CYC_DEFAULTS = Object.freeze({
  shape: 'cyc',
  width: 2.2,
  height: 1.6,
  depth: 1.8,
  curve: 0.3,
  x: 0, y: 0, z: 0,
  rotX: 0, rotY: 0, rotZ: 0,
  scale: 1,
  material: Object.freeze({
    mode: 'solid',
    color: '#d8d8d8',
    imageUrl: null,
    roughness: 0.8,
    metalness: 0,
    opacity: 1,
    receiveShadow: true,
    castShadow: false,
  }),
});

// "Shadows only" paints its shadows in material.shadowColor, this until one is set.
export const CYC_SHADOW_TINT = '#000000';

export const ENV_DEFAULTS = Object.freeze({
  source: 'preset',
  preset: 'studio_small_03_1k',
  url: null,
  intensity: 1,
  exposure: 1,
  rotX: 0, rotY: 0, rotZ: 0,
});

// The ten HDRIs committed to frontend/public/hdr/ for offline use. Anything beyond
// this list is an upload (source: 'custom') or routes through the R2-backed
// /api/model-cache proxy — see the plan's Environment section. Deliberately NOT
// grown: 10 maps already cost ~15 MB in the repo.
export const ENV_PRESETS = Object.freeze([
  { id: 'studio_small_03_1k', name: 'Studio Small' },
  { id: 'st_fagans_interior_1k', name: 'Interior' },
  { id: 'empty_warehouse_01_1k', name: 'Warehouse' },
  { id: 'potsdamer_platz_1k', name: 'Potsdamer Platz' },
  { id: 'venice_sunset_1k', name: 'Venice Sunset' },
  { id: 'kiara_1_dawn_1k', name: 'Dawn' },
  { id: 'lebombo_1k', name: 'Lebombo' },
  { id: 'rooitou_park_1k', name: 'Park' },
  { id: 'forest_slope_1k', name: 'Forest Slope' },
  { id: 'dikhololo_night_1k', name: 'Night' },
]);

/**
 * The URL an environment block resolves to, or null for "no environment".
 *
 * The PMREM cache is keyed on THIS STRING, not on a bare preset name — that is what
 * lets an uploaded /media/... HDRI and a bundled preset share one cache without the
 * uploaded one being mistaken for a preset of the same basename.
 */
export function resolveEnvUrl(env) {
  const e = env || {};
  if (e.source === 'none') return null;
  if (e.source === 'custom') return typeof e.url === 'string' && e.url ? e.url : null;
  const preset = str(e.preset, ENV_DEFAULTS.preset);
  return `/hdr/${preset}.hdr`;
}

export const SHADOW_DEFAULTS = Object.freeze({ mode: 'map', maxCasters: 2 });

// Ordinary artwork stays a flat animated plate. These flags only opt that plate
// into the Rig's shadow map; they never extrude it or turn it into a solid.
export const SHADOW_PLATE_DEFAULTS = Object.freeze({
  castShadow: false,
  receiveShadow: false,
  // Depth participation is independent from lighting: a plate can intersect real
  // geometry without casting or receiving a shadow. Kept off by default so merely
  // enabling a shadow does not change an existing timeline's compositing.
  occludes: false,
});

/** Cyclorama size in world pixels for a composition H pixels tall. */
export function cycSizePx(cyc, compHeight) {
  const h = num(compHeight, 1080, 1, Infinity);
  return {
    width: num(cyc?.width, CYC_DEFAULTS.width, 0, Infinity) * h,
    height: num(cyc?.height, CYC_DEFAULTS.height, 0, Infinity) * h,
    depth: num(cyc?.depth, CYC_DEFAULTS.depth, 0, Infinity) * h,
  };
}

// ── Normalisation ───────────────────────────────────────────────────────────

function normalizeLight(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const type = pick(raw.type, LIGHT_TYPES, 'directional');
  const lid = isValidLid(raw.lid) ? raw.lid : `l${index}`;
  const out = {
    lid,
    type,
    name: str(raw.name, `Light ${index + 1}`).slice(0, 40),
    // `on` is presentation only — a light switched off keeps its object and gets
    // intensity 0 at apply time. Never implement it as add/remove.
    on: raw.on !== false,
    color: color(raw.color, '#ffffff'),
    intensity: num(raw.intensity, 1, 0, 100),
  };
  if (type === 'ambient') return out;
  if (type === 'hemisphere') {
    out.groundColor = color(raw.groundColor, '#3a2f26');
    return out;
  }
  out.az = num(raw.az, 0, -360, 360);
  out.elev = num(raw.elev, 30, -90, 90);
  out.dist = num(raw.dist, LEGACY_LIGHT_DISTANCE, 0, 100000);
  out.castShadow = raw.castShadow === true;
  out.shadowSoftness = num(raw.shadowSoftness, 1, 0, 10);
  out.shadowMapSize = pick(num(raw.shadowMapSize, 1024, 256, 4096), [256, 512, 1024, 2048, 4096], 1024);
  if (type === 'point') {
    out.range = num(raw.range, 0, 0, 100000);
    out.decay = num(raw.decay, 2, 0, 4);
  }
  if (type === 'spot') {
    out.angle = num(raw.angle, 32, 1, 89);
    out.penumbra = num(raw.penumbra, 0.5, 0, 1);
    out.targetX = num(raw.targetX, 0, -100000, 100000);
    out.targetY = num(raw.targetY, 0, -100000, 100000);
    out.targetZ = num(raw.targetZ, 0, -100000, 100000);
  }
  return out;
}

function normalizeLights(raw) {
  // The legacy shape: model3dConfig.lights was { key, fill, rim } intensities.
  // Accepted on read, yielding the identical three directionals, so a project
  // saved before the rig existed lights exactly as it always did.
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return legacyRigLights(raw);
  }
  if (!Array.isArray(raw)) return legacyRigLights();
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (out.length >= MAX_LIGHTS) break;
    const light = normalizeLight(entry, out.length);
    if (!light) continue;
    // Duplicate lids would make the `sc:<lid>:<chan>` keyframe tracks ambiguous
    // and the diff in syncLightsToScene non-deterministic.
    if (seen.has(light.lid)) continue;
    seen.add(light.lid);
    out.push(light);
  }
  return out.length ? out : legacyRigLights();
}

function normalizeCyclorama(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const m = c.material && typeof c.material === 'object' ? c.material : {};
  const D = CYC_DEFAULTS;
  return {
    shape: pick(c.shape, CYC_SHAPES, D.shape),
    width: num(c.width, D.width, 0.01, 100),
    height: num(c.height, D.height, 0.01, 100),
    depth: num(c.depth, D.depth, 0.01, 100),
    curve: num(c.curve, D.curve, 0, 1),
    x: num(c.x, 0, -100000, 100000),
    y: num(c.y, 0, -100000, 100000),
    z: num(c.z, 0, -100000, 100000),
    rotX: num(c.rotX, 0, -360, 360),
    rotY: num(c.rotY, 0, -360, 360),
    rotZ: num(c.rotZ, 0, -360, 360),
    scale: num(c.scale, 1, 0.01, 100),
    material: {
      mode: pick(m.mode, CYC_MATERIAL_MODES, D.material.mode),
      color: color(m.color, D.material.color),
      imageUrl: str(m.imageUrl, null),
      roughness: num(m.roughness, D.material.roughness, 0, 1),
      metalness: num(m.metalness, D.material.metalness, 0, 1),
      opacity: num(m.opacity, D.material.opacity, 0, 1),
      receiveShadow: m.receiveShadow !== false,
      castShadow: m.castShadow === true,
      // Only once set: an always-present default would change rigLookHash for
      // every saved rig and mark each look "edited".
      ...(m.shadowColor != null ? { shadowColor: color(m.shadowColor, CYC_SHADOW_TINT) } : {}),
    },
  };
}

/**
 * The colour the backdrop actually shows: the surface's own colour when Solid, the
 * shadows' tint when "Shadows only". The two are separate fields. Sharing one made
 * a paper set paint its shadows in the paper's colour — invisible on the paper
 * background they land on, and pale patches over anything else.
 */
/** Whether this rig puts a backdrop on screen: a 3D pass the frame must composite. */
export function rigDrawsBackdrop(rig) {
  return !!rig && normalizeRig(rig).cyclorama.shape !== 'none';
}

export function cycSurfaceColor(material) {
  if (material?.mode === 'shadowCatcher') return material.shadowColor || CYC_SHADOW_TINT;
  return material?.color || CYC_DEFAULTS.material.color;
}

function normalizeEnv(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const D = ENV_DEFAULTS;
  return {
    source: pick(e.source, ENV_SOURCES, D.source),
    preset: str(e.preset, D.preset),
    url: str(e.url, null),
    intensity: num(e.intensity, D.intensity, 0, 5),
    exposure: num(e.exposure, D.exposure, 0.05, 8),
    rotX: num(e.rotX, 0, -360, 360),
    rotY: num(e.rotY, 0, -360, 360),
    rotZ: num(e.rotZ, 0, -360, 360),
  };
}

/**
 * Any saved rig shape (current, partial, or the legacy `{key,fill,rim}` light
 * block) to the canonical one. Total: never throws, never returns null, so a
 * corrupt rig degrades to the legacy three-light default rather than darkness.
 */
export function normalizeRig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const s = r.shadows && typeof r.shadows === 'object' ? r.shadows : {};
  return {
    cyclorama: normalizeCyclorama(r.cyclorama),
    lights: normalizeLights(r.lights),
    env: normalizeEnv(r.env),
    shadows: {
      mode: pick(s.mode, SHADOW_MODES, SHADOW_DEFAULTS.mode),
      maxCasters: num(s.maxCasters, SHADOW_DEFAULTS.maxCasters, 0, 4),
    },
  };
}

/** The rig a NEW Scene Rig layer starts with (VideoEditor's add-rig): the
 *  historical three directionals, no cyclorama, the studio environment, and real
 *  shadows from the Key light. Projects without a rig layer never read this — see
 *  resolveRigAt() — and a saved rig keeps its own values, so changing these only
 *  changes rigs added from now on. */
export function defaultRig() {
  const rig = normalizeRig({});
  // A cyclorama is a look you opt into, so a fresh rig has none.
  rig.cyclorama.shape = 'none';
  // The ENVIRONMENT, though, must be on. The rig owns lighting the moment it
  // exists, so a rig that shipped `source: 'none'` silently stripped every model of
  // the image-based lighting it had a second earlier — adding a Rig layer made the
  // whole scene fall dark, which reads as "the rig broke my models" rather than as
  // a setting. Same map the models defaulted to on their own.
  rig.env.source = 'preset';
  rig.env.preset = 'studio_small_03_1k';
  // Real shadows from the Key light: one shadow map per frame, shared by every
  // model. Fill and Rim stay off — extra casters add faint second shadows and cost.
  rig.shadows.mode = 'map';
  const key = rig.lights.find((l) => l.lid === 'k1');
  if (key) key.castShadow = true;
  return rig;
}

/**
 * Strict sanitizer for the project file. Same contract as sanitizeModel3dConfig in
 * VideoEditor.jsx: returns a spreadable object, and `{}` for an item that carries
 * no rig — an always-present field would make the first save of an old project read
 * as a real content change in every other open window.
 */
export function sanitizeRig(item) {
  const raw = item?.rig;
  if (!raw || typeof raw !== 'object') return {};
  return { rig: normalizeRig(raw) };
}

/**
 * Strict project-file sanitizer for flat shadow plates.
 *
 * `layer3d` is read once as a migration source so projects made with the removed
 * 3D-layer toggle keep their cast/receive/depth intent. It is never written back:
 * thickness, bevel, material and back-face fields disappear on the next save.
 */
export function sanitizeShadowPlate(item) {
  const current = item?.shadowPlate;
  if (current && typeof current === 'object') {
    return {
      shadowPlate: {
        castShadow: current.castShadow === true,
        receiveShadow: current.receiveShadow === true,
        occludes: current.occludes === true,
      },
    };
  }
  const legacy = item?.layer3d;
  if (!legacy || typeof legacy !== 'object' || legacy.enabled !== true) return {};
  return {
    shadowPlate: {
      castShadow: legacy.castShadow !== false,
      receiveShadow: legacy.receiveShadow !== false,
      // Preserve the old opt-in when migrating away from extrusion. This restores
      // depth intersection without restoring thickness, bevel or materials.
      occludes: legacy.occludes === true,
    },
  };
}

// ── Flat shadow plates ──────────────────────────────────────────────────────

/** Audio, cameras and adjustment layers own no artwork plate; models are already
 * real geometry. Text, shape, image and video can lend their animated alpha plate
 * to the shared Rig shadow map. */
export const SHADOW_PLATE_MEDIA_TYPES = Object.freeze(['image', 'video', 'text', 'shape']);

export function supportsShadowPlate(clip) {
  return SHADOW_PLATE_MEDIA_TYPES.includes(clip?.mediaType);
}

export function isShadowPlate(item, clip) {
  if (!supportsShadowPlate(clip)) return false;
  return item?.shadowPlate?.castShadow === true
    || item?.shadowPlate?.receiveShadow === true
    || item?.shadowPlate?.occludes === true;
}

/**
 * A plate that needs a real object in the shared world scene: one that casts a
 * shadow onto the set, or one whose own pixels have to be darkened by it.
 *
 * Depth occlusion is deliberately NOT on this list. A flat layer already lives in
 * the composition's 3D space — same world units, same project camera, same
 * depth-buffered target — so making it intersect a model needs nothing more than
 * letting its own quad test and write depth (`isDepthPlate` below). Routing it
 * through the shared scene as well would only cost it its position.
 */
export function isScenePlate(item, clip) {
  if (!supportsShadowPlate(clip)) return false;
  return item?.shadowPlate?.castShadow === true || item?.shadowPlate?.receiveShadow === true;
}

/** A flat layer whose visible pixels take part in the frame's depth buffer. */
export function isDepthPlate(item, clip) {
  return supportsShadowPlate(clip) && item?.shadowPlate?.occludes === true;
}

/** Models and opted-in flat plates are both rendered in the shared scene. */
export function isWorld3dLayer(item, clip) {
  return clip?.mediaType === 'model3d' || isShadowPlate(item, clip);
}

/** True when the project camera has already been rendered into this clip's
 * full-frame texture. These plates must be composited through the neutral camera;
 * filming them through the posed camera again projects the shot twice. The error is
 * subtle from the front, but once an orbit reaches the back hemisphere the plate
 * becomes edge-on/back-facing and the model appears to flatten or fly away.
 *
 * Only RECEIVING a shadow forces a flat layer down this road, because only that
 * needs the layer's own pixels re-lit inside the shared scene. Casting and depth
 * occlusion both leave the layer an ordinary quad — which is what keeps its
 * position, its per-layer effects and the 3D view's picture of it exact. */
export function isCameraBaked3dPlate(clip, item = null) {
  return clip?.mediaType === 'model3d'
    || clip?.mediaType === RIG_MEDIA_TYPE
    || (supportsShadowPlate(clip) && item?.shadowPlate?.receiveShadow === true);
}

// ── The never-go-dark rule ──────────────────────────────────────────────────
//
// The ONE place the rig must not copy the camera. A camera clip's neutral state is
// identity, which is harmless; a rig clip's neutral state is "no lights", i.e. every
// model goes black the moment the playhead leaves the clip. So outside every rig
// clip we fall back to the NEAREST one, and with no rig layer at all to the legacy
// three-light default. Nothing may go dark because of where the playhead is.
//
// `entries` are { startTime, endTime, rig } in seconds, any order.

export function resolveRigAt(entries, time) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const t = Number.isFinite(time) ? time : 0;
  let nearest = null;
  let nearestGap = Infinity;
  for (const e of entries) {
    if (!e) continue;
    const start = num(e.startTime, 0, -Infinity, Infinity);
    const end = num(e.endTime, start, -Infinity, Infinity);
    if (t >= start && t <= end) return e;
    const gap = t < start ? start - t : t - end;
    // Ties go to the earlier clip, so the fallback is stable rather than depending
    // on array order.
    if (gap < nearestGap || (gap === nearestGap && nearest && start < nearest.startTime)) {
      nearest = e;
      nearestGap = gap;
    }
  }
  return nearest;
}

// ── Keyframe tracks ─────────────────────────────────────────────────────────
//
// `rig:` is already taken by the puppet-pin deformer (keyframeProps.js), hence
// `sc:` for scene. Two prefixes because isColorTrackKey picks numeric vs RGBA
// interpolation from the key STRING alone — it never sees the value.
//
//   sc:<lid|cyc|env>:<chan>   numeric
//   scc:<lid|cyc>:col         RGBA
export const RIG_KF_PREFIX = 'sc:';
export const RIG_KF_COLOR_PREFIX = 'scc:';

export const RIG_KF_SCOPE_CYC = 'cyc';
export const RIG_KF_SCOPE_ENV = 'env';

export function rigKfKey(scope, chan) {
  return `${RIG_KF_PREFIX}${scope}:${chan}`;
}

export function rigColorKfKey(scope) {
  return `${RIG_KF_COLOR_PREFIX}${scope}:col`;
}

export function isRigTrackKey(key) {
  return typeof key === 'string'
    && (key.startsWith(RIG_KF_PREFIX) || key.startsWith(RIG_KF_COLOR_PREFIX));
}

export function isRigColorTrackKey(key) {
  return typeof key === 'string' && key.startsWith(RIG_KF_COLOR_PREFIX);
}

/** `sc:k1:az` → { scope: 'k1', chan: 'az', color: false }. Null when the key is not
 *  a rig track or is malformed, so callers can treat it as "not mine". */
export function parseRigKfKey(key) {
  if (typeof key !== 'string') return null;
  const isColor = key.startsWith(RIG_KF_COLOR_PREFIX);
  if (!isColor && !key.startsWith(RIG_KF_PREFIX)) return null;
  const body = key.slice((isColor ? RIG_KF_COLOR_PREFIX : RIG_KF_PREFIX).length);
  const sep = body.indexOf(':');
  if (sep <= 0 || sep === body.length - 1) return null;
  const scope = body.slice(0, sep);
  const chan = body.slice(sep + 1);
  if (!chan || chan.includes(':')) return null;
  if (scope !== RIG_KF_SCOPE_CYC && scope !== RIG_KF_SCOPE_ENV && !isValidLid(scope)) return null;
  return { scope, chan, color: isColor };
}

// Per-light animatable channels. Refused, each for a reason that is a shader or a
// bake rather than a preference — stated here so the next person does not "fix" it:
//   type, on/off, add/remove  changes NUM_*_LIGHTS, a #define → recompiles every
//                             material in the shared scene
//   castShadow, shadowMapSize toggles NUM_*_LIGHT_SHADOWS / resizes a render target
const LIGHT_KF_CHANS = Object.freeze({
  intensity: { label: 'Intensity', unit: '', min: 0, max: 100, step: 0.05, neutral: 1 },
  az: { label: 'Azimuth', unit: 'deg', min: -360, max: 360, step: 1, neutral: 0 },
  elev: { label: 'Elevation', unit: 'deg', min: -90, max: 90, step: 1, neutral: 30 },
  dist: { label: 'Distance', unit: 'px', min: 0, max: 100000, step: 10, neutral: 3000 },
  angle: { label: 'Cone Angle', unit: 'deg', min: 1, max: 89, step: 1, neutral: 32 },
  penumbra: { label: 'Penumbra', unit: '', min: 0, max: 1, step: 0.01, neutral: 0.5 },
});

const LIGHT_KF_CHANS_BY_TYPE = Object.freeze({
  directional: ['intensity', 'az', 'elev', 'dist'],
  point: ['intensity', 'az', 'elev', 'dist'],
  spot: ['intensity', 'az', 'elev', 'dist', 'angle', 'penumbra'],
  ambient: ['intensity'],
  hemisphere: ['intensity'],
});

// Cyclorama: placement and paint only. Shape and dimensions rebuild the geometry,
// so they are refused for the same reason as the extrude parameters.
const CYC_KF_CHANS = Object.freeze({
  x: { label: 'Position X', unit: 'px', min: -100000, max: 100000, step: 5, neutral: 0 },
  y: { label: 'Position Y', unit: 'px', min: -100000, max: 100000, step: 5, neutral: 0 },
  z: { label: 'Position Z', unit: 'px', min: -100000, max: 100000, step: 5, neutral: 0 },
  rotX: { label: 'Rotate X', unit: 'deg', min: -360, max: 360, step: 1, neutral: 0 },
  rotY: { label: 'Rotate Y', unit: 'deg', min: -360, max: 360, step: 1, neutral: 0 },
  rotZ: { label: 'Rotate Z', unit: 'deg', min: -360, max: 360, step: 1, neutral: 0 },
  scale: { label: 'Scale', unit: '', min: 0.01, max: 100, step: 0.01, neutral: 1 },
  opacity: { label: 'Opacity', unit: '', min: 0, max: 1, step: 0.01, neutral: 1 },
});

// Environment: render-time only. source/preset/url are refused because each is a
// PMREM bake — one HDRI would fan out into N baked render targets per frame.
const ENV_KF_CHANS = Object.freeze({
  intensity: { label: 'Intensity', unit: '', min: 0, max: 5, step: 0.01, neutral: 1 },
  exposure: { label: 'Exposure', unit: '', min: 0.05, max: 8, step: 0.01, neutral: 1 },
  rotX: { label: 'Rotate X', unit: 'deg', min: -360, max: 360, step: 1, neutral: 0 },
  rotY: { label: 'Rotate Y', unit: 'deg', min: -360, max: 360, step: 1, neutral: 0 },
  rotZ: { label: 'Rotate Z', unit: 'deg', min: -360, max: 360, step: 1, neutral: 0 },
});

/** Every keyframe key this rig can legitimately carry — the authority the
 *  sanitizer uses to drop orphan tracks (a light the user deleted). */
export function rigKfKeysFor(rig) {
  const r = normalizeRig(rig);
  const keys = new Set();
  for (const light of r.lights) {
    for (const chan of LIGHT_KF_CHANS_BY_TYPE[light.type] || []) {
      keys.add(rigKfKey(light.lid, chan));
    }
    keys.add(rigColorKfKey(light.lid));
  }
  for (const chan of Object.keys(CYC_KF_CHANS)) keys.add(rigKfKey(RIG_KF_SCOPE_CYC, chan));
  keys.add(rigColorKfKey(RIG_KF_SCOPE_CYC));
  for (const chan of Object.keys(ENV_KF_CHANS)) keys.add(rigKfKey(RIG_KF_SCOPE_ENV, chan));
  return keys;
}

/**
 * Fold evaluated `sc:` / `scc:` values into a rig.
 *
 * Pure, and takes ALREADY-EVALUATED values rather than the tracks: interpolation
 * (and its easing, and its colour handling) lives in gsapTransitions, and this
 * module stays free of it — the same split rigDeform.js uses.
 *
 * `values` is `{ 'sc:k1:az': 40, 'scc:cyc:col': '#ff0000', ... }`. Keys it does not
 * recognise, and channels the light's type does not have, are ignored: a track can
 * outlive the light it was authored for by exactly one autosave.
 *
 * Returns a NEW rig; the caller's object is never mutated, because the same rig
 * object is read by the panel while the render loop is evaluating it.
 */
export function applyRigKeyframes(rig, values) {
  const r = normalizeRig(rig);
  if (!values || typeof values !== 'object') return r;
  const entries = Object.entries(values);
  if (entries.length === 0) return r;

  let lights = null;      // copied lazily, so an untouched rig allocates nothing
  const cyc = { ...r.cyclorama, material: { ...r.cyclorama.material } };
  const env = { ...r.env };
  let cycDirty = false;
  let envDirty = false;

  for (const [key, value] of entries) {
    const parsed = parseRigKfKey(key);
    if (!parsed || value === undefined || value === null) continue;
    const { scope, chan, color } = parsed;

    if (scope === RIG_KF_SCOPE_CYC) {
      if (color) {
        // One colour track: whichever colour the current surface shows.
        if (cyc.material.mode === 'shadowCatcher') cyc.material.shadowColor = String(value);
        else cyc.material.color = String(value);
        cycDirty = true;
        continue;
      }
      const meta = CYC_KF_CHANS[chan];
      if (!meta) continue;
      if (chan === 'opacity') cyc.material.opacity = num(value, cyc.material.opacity, meta.min, meta.max);
      else cyc[chan] = num(value, cyc[chan], meta.min, meta.max);
      cycDirty = true;
      continue;
    }
    if (scope === RIG_KF_SCOPE_ENV) {
      const meta = ENV_KF_CHANS[chan];
      if (!meta || color) continue;
      env[chan] = num(value, env[chan], meta.min, meta.max);
      envDirty = true;
      continue;
    }

    const idx = r.lights.findIndex((l) => l.lid === scope);
    if (idx < 0) continue;
    if (!lights) lights = r.lights.map((l) => ({ ...l }));
    if (color) { lights[idx].color = String(value); continue; }
    // Type-gated: a spot's `penumbra` track on a light later switched to directional
    // must not resurrect a field that light type does not have.
    if (!(LIGHT_KF_CHANS_BY_TYPE[lights[idx].type] || []).includes(chan)) continue;
    const meta = LIGHT_KF_CHANS[chan];
    if (!meta) continue;
    lights[idx][chan] = num(value, lights[idx][chan], meta.min, meta.max);
  }

  if (!lights && !cycDirty && !envDirty) return r;
  return {
    ...r,
    ...(lights ? { lights } : {}),
    ...(cycDirty ? { cyclorama: cyc } : {}),
    ...(envDirty ? { env } : {}),
  };
}

/** Remove one animated rig property and make its evaluated value the new static
 * rig value. The caller evaluates the track at the playhead because interpolation
 * belongs to gsapTransitions; this leaf helper owns the nested rig write and the
 * track removal so numeric, colour, cyclorama and environment stopwatches cannot
 * drift into four different toggle behaviours. */
export function buildStaticRigTrackUpdates(item, key, evaluatedValue) {
  const sourceTracks = item?.propertyKeyframes;
  if (!isRigTrackKey(key) || !Array.isArray(sourceTracks?.[key]) || sourceTracks[key].length === 0) {
    return null;
  }
  const propertyKeyframes = { ...sourceTracks };
  delete propertyKeyframes[key];
  const updates = { propertyKeyframes };
  if (evaluatedValue !== undefined && evaluatedValue !== null) {
    updates.rig = applyRigKeyframes(item?.rig, { [key]: evaluatedValue });
  }
  return updates;
}

/**
 * KF_PROPS-shaped entries so the Keyframe Builder's row list, "Add Property"
 * dropdown, timeline pill and graph editor pick rig tracks up like any other
 * property — the buildRigKfProps / buildGridKfProps / buildMotionKfProps pattern.
 */
export function buildRigKfPropsFor(rig) {
  const r = normalizeRig(rig);
  const out = [];
  const push = (label, group, displayLabel, meta, inputType) => {
    if (inputType === 'color') {
      out.push({ label, group, displayLabel, placeholder: '#ffffff', unit: '', inputType: 'color', hasAlpha: false });
      return;
    }
    out.push({
      label,
      group,
      displayLabel,
      placeholder: String(meta.neutral),
      unit: meta.unit,
      type: 'number',
      min: meta.min,
      max: meta.max,
      step: meta.step,
    });
  };

  for (const light of r.lights) {
    const group = light.name || light.lid;
    for (const chan of LIGHT_KF_CHANS_BY_TYPE[light.type] || []) {
      push(rigKfKey(light.lid, chan), group, `${group} · ${LIGHT_KF_CHANS[chan].label}`, LIGHT_KF_CHANS[chan]);
    }
    push(rigColorKfKey(light.lid), group, `${group} · Colour`, null, 'color');
  }
  for (const [chan, meta] of Object.entries(CYC_KF_CHANS)) {
    push(rigKfKey(RIG_KF_SCOPE_CYC, chan), 'Cyclorama', `Cyclorama · ${meta.label}`, meta);
  }
  push(rigColorKfKey(RIG_KF_SCOPE_CYC), 'Cyclorama', 'Cyclorama · Colour', null, 'color');
  for (const [chan, meta] of Object.entries(ENV_KF_CHANS)) {
    push(rigKfKey(RIG_KF_SCOPE_ENV, chan), 'Environment', `Environment · ${meta.label}`, meta);
  }
  return out;
}

/**
 * Read the authored value behind one rig keyframe track.
 *
 * The shared Keyframe Builder normally seeds a newly-added property from its
 * registry placeholder. That is only a neutral example, not the value the set is
 * currently using: adding a 2.2-intensity softbox as a track must not immediately
 * turn it into a 1.0 light. Keeping the lookup here beside the channel registry
 * also means the inspector cannot drift from applyRigKeyframes' nested paths.
 */
export function rigKfBaseValue(rig, key) {
  const r = normalizeRig(rig);
  if (!rigKfKeysFor(r).has(key)) return undefined;
  const parsed = parseRigKfKey(key);
  if (!parsed) return undefined;
  const { scope, chan, color: colorTrack } = parsed;

  if (scope === RIG_KF_SCOPE_CYC) {
    if (colorTrack) return cycSurfaceColor(r.cyclorama.material);
    if (chan === 'opacity') return r.cyclorama.material.opacity;
    return r.cyclorama[chan];
  }
  if (scope === RIG_KF_SCOPE_ENV) {
    return colorTrack ? undefined : r.env[chan];
  }

  const light = r.lights.find((entry) => entry.lid === scope);
  if (!light) return undefined;
  return colorTrack ? light.color : light[chan];
}

/**
 * Turn an absolute 3D light-proxy drag into either a resting-rig edit or rig
 * keyframes at the playhead. Kept in this leaf module so the same pure contract is
 * exercised by the rig test suite without loading three.js or the React editor.
 *
 * Once any rig track exists, direct manipulation auto-keys every spherical channel
 * the gizmo touched. That is the editor-wide rule for animated objects and prevents
 * a drag from changing a base value that the evaluated keyframes immediately hide.
 */
export function buildRigLightTransformUpdates(
  { item, pct, keyTolerancePct = 0.001, easing = 'Smooth' } = {},
  lid,
  props,
) {
  const lights = item?.rig?.lights;
  if (!item || !Array.isArray(lights) || !props || !lid) return null;
  const light = lights.find((entry) => entry?.lid === lid);
  if (!light) return null;

  const sourceTracks = item.propertyKeyframes && typeof item.propertyKeyframes === 'object'
    ? item.propertyKeyframes
    : {};
  const tracks = { ...sourceTracks };
  const autoTrack = Object.values(sourceTracks).some((track) => Array.isArray(track) && track.length > 0);
  const basePatch = {};
  let tracksChanged = false;
  const position = Math.max(0, Math.min(100, num(pct, 0, -Infinity, Infinity)));
  const tolerance = Math.max(0.001, num(keyTolerancePct, 0.001, 0, Infinity));

  for (const chan of ['az', 'elev', 'dist']) {
    const value = Number(props[chan]);
    if (!Number.isFinite(value)) continue;
    const rounded = Math.round(value * 10000) / 10000;
    const key = rigKfKey(lid, chan);
    const track = Array.isArray(tracks[key]) ? tracks[key] : [];
    if (!track.length && !autoTrack) {
      basePatch[chan] = rounded;
      continue;
    }
    const index = track.findIndex((entry) => Math.abs(num(entry?.position, 0) - position) <= tolerance);
    if (index >= 0) {
      tracks[key] = track.map((entry, i) => (i === index ? { ...entry, value: String(rounded) } : entry));
    } else {
      tracks[key] = [
        ...track,
        { position: Math.round(position * 100) / 100, value: String(rounded), easing },
      ].sort((a, b) => num(a.position, 0) - num(b.position, 0));
    }
    tracksChanged = true;
  }

  const updates = {};
  if (tracksChanged) updates.propertyKeyframes = tracks;
  if (Object.keys(basePatch).length > 0) {
    updates.rig = {
      ...item.rig,
      lights: lights.map((entry) => (entry.lid === lid ? { ...entry, ...basePatch } : entry)),
    };
  }
  return Object.keys(updates).length > 0 ? updates : null;
}
