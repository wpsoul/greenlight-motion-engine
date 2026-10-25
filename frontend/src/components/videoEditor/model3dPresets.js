// Built-in device models for 3D model layers.
//
// These are the SAME .glb files the mockup builder ships — imported by url so the
// bundler emits one copy shared by both features rather than duplicating ~20 MB of
// geometry. Each entry records where that model's screen lives, so a layer can have
// artwork put on it exactly the way the mockup builder does: the mesh is found by
// node name or by material name (the models disagree about which is stable) and its
// material is replaced with an unlit one carrying the texture.
//
// Devices whose screen is generated procedurally rather than authored as a mesh
// (PhoneModel's rounded-rect) are listed without a `screen`, so the panel simply
// doesn't offer the option for them.

import ipadUrl from '../mockupGenerator/models/ipad.glb?url';
import ipadMiniUrl from '../mockupGenerator/models/ipad_mini.glb?url';
import imacUrl from '../mockupGenerator/models/apple_imac.glb?url';
import macbookProUrl from '../mockupGenerator/models/macbookpro.glb?url';
import macbookAirUrl from '../mockupGenerator/models/apple_macbook_air_15_space_gray_2023.glb?url';
import iphoneProMaxUrl from '../mockupGenerator/models/iphone_17_pro_max.glb?url';
import doubleIphoneUrl from '../mockupGenerator/models/double_iphone.glb?url';
import iphoneAirUrl from '../mockupGenerator/models/iphone_air.glb?url';

export const MODEL_PRESETS = [
  {
    id: 'iphone_pro_max',
    name: 'iPhone 17 Pro Max',
    url: iphoneProMaxUrl,
    // Most of these GLBs are authored facing away from the viewer.
    faceCamera: true,
    screen: {
      material: '17ProMax_Screen',
      aspect: 0.46,
      // Mirrored AND rotated: the UV winding on this screen puts artwork upside down.
      mirrorX: true,
      rotate: Math.PI,
      // The glass pane sits in front of the screen and is opaque by default, which
      // hides the artwork completely.
      glass: { material: '17ProMax_glass', opacity: 0.15 },
    },
  },
  {
    id: 'iphone_air',
    name: 'iPhone Air',
    url: iphoneAirUrl,
    // Authored front-toward-viewer (the mockup builder's IPhoneAirModel never
    // flips it either) — the faceCamera it shipped with showed the back.
    faceCamera: false,
    // Same mesh the mockup builder's IPhoneAirModel textures.
    screen: { node: 'tppzCQmnlKcHIpP', aspect: 0.48 },
  },
  {
    id: 'double_iphone',
    name: 'Two iPhones',
    url: doubleIphoneUrl,
    faceCamera: true,
    screen: { material: 'material_11', mirrorX: true, aspect: 0.46 },
  },
  { id: 'ipad', name: 'iPad', url: ipadUrl, screen: { node: 'Plane_1', mirrorX: true, aspect: 0.75 } },
  { id: 'ipad_mini', name: 'iPad mini', url: ipadMiniUrl, faceCamera: true, screen: { node: 'iPad_Mini_Screen_0', mirrorX: true, aspect: 0.68 } },
  { id: 'macbook_pro', name: 'MacBook Pro', url: macbookProUrl, screen: { node: 'Object_123', aspect: 16 / 10 } },
  { id: 'macbook_air', name: 'MacBook Air', url: macbookAirUrl, screen: { material: 'VNZklasZKSWjWUk', aspect: 16 / 10 } },
  {
    id: 'imac',
    name: 'iMac',
    url: imacUrl,
    faceCamera: true,
    // Object_5 is the WHOLE front panel, edge to edge — artwork must not span
    // it. `inset` shrinks the drawn area and `insetFill` paints the revealed
    // border in the chassis aluminium, like the mockup builder's inset plane.
    screen: { node: 'Object_5', aspect: 16 / 9, inset: 0.06, insetFill: '#c9cbce' },
  },
];

const BY_ID = new Map(MODEL_PRESETS.map((p) => [p.id, p]));

// Retired presets, mapped to their nearest survivor. A saved project holding a
// retired id would otherwise resolve to no model at all and try to load the
// `model-preset:` sentinel as if it were a file, leaving an empty layer.
const RETIRED_IDS = { iphone_17: 'iphone_pro_max' };

export function getModelPreset(id) {
  if (!id) return null;
  return BY_ID.get(id) || BY_ID.get(RETIRED_IDS[id]) || null;
}

/** Every preset id (a retired one too) → the URL the app serves its .glb at: a .glvideo download packs the ones its
 *  project uses (the built file names carry a hash only this side knows). */
export function presetFileUrls() {
  const out = Object.fromEntries(MODEL_PRESETS.map((p) => [p.id, p.url]));
  for (const [old, now] of Object.entries(RETIRED_IDS)) if (BY_ID.get(now)) out[old] = BY_ID.get(now).url;
  return out;
}

export const DEFAULT_MODEL_PRESET = 'iphone_pro_max';

// Preset clips store this stable sentinel instead of the bundled file's URL: that URL
// is a content-hashed build artifact and changes with every release, so a saved project
// holding one would break on the next update.
export const MODEL_PRESET_URL_PREFIX = 'model-preset:';

export function presetUrlFor(id) {
  return `${MODEL_PRESET_URL_PREFIX}${id}`;
}

export function presetIdFromUrl(url) {
  return typeof url === 'string' && url.startsWith(MODEL_PRESET_URL_PREFIX)
    ? url.slice(MODEL_PRESET_URL_PREFIX.length)
    : null;
}

// ── Procedural shapes (Scene Rig ▸ Objects) ──────────────────────────────────
// Built in code (model3dPrimitives.js), so there is no file: the clip stores this
// sentinel the way device presets store `model-preset:`, and the layer's
// model3dConfig.primitive carries { kind, color, text }.
export const MODEL_PRIMITIVE_URL_PREFIX = 'model-primitive:';
export const PRIMITIVE_DEFAULT_TEXT = 'TEXT';
export const PRIMITIVE_DEFAULT_COLOR = '#d9d9d9';
export const MODEL_PRIMITIVES = [
  { id: 'cube', name: 'Cube' },
  { id: 'sphere', name: 'Sphere' },
  { id: 'card', name: 'Card' },
  { id: 'torus', name: 'Torus' },
  { id: 'cone', name: 'Cone' },
  { id: 'cylinder', name: 'Cylinder' },
  { id: 'human', name: 'Human' },
  { id: 'car', name: 'Car' },
  { id: 'text', name: 'Text' },
];
const PRIMITIVE_IDS = new Set(MODEL_PRIMITIVES.map((p) => p.id));

export function isPrimitiveKind(kind) {
  return PRIMITIVE_IDS.has(kind);
}

export function isPrimitiveUrl(url) {
  return typeof url === 'string' && url.startsWith(MODEL_PRIMITIVE_URL_PREFIX);
}

/** The clip sentinel for a shape — `model-primitive:cube`. */
export function primitiveUrlFor(kind) {
  return `${MODEL_PRIMITIVE_URL_PREFIX}${isPrimitiveKind(kind) ? kind : 'cube'}`;
}

/** The asset url the layer loads: Text carries its string, so a new string is a new
 *  asset (geometry) while a new colour is not (the material is per layer). */
function primitiveAssetUrl(primitive) {
  const kind = isPrimitiveKind(primitive?.kind) ? primitive.kind : 'cube';
  if (kind !== 'text') return primitiveUrlFor(kind);
  const text = typeof primitive?.text === 'string' && primitive.text ? primitive.text : PRIMITIVE_DEFAULT_TEXT;
  return `${primitiveUrlFor('text')}?t=${encodeURIComponent(text)}`;
}

/** The asset a model layer should load: its preset's bundled file, a procedural
 *  shape, or its own upload. */
export function resolveModelUrl(item, clip) {
  const cfg = item?.model3dConfig;
  if (cfg?.source === 'primitive') return primitiveAssetUrl(cfg.primitive);
  if (cfg?.source === 'preset') {
    const preset = getModelPreset(cfg.preset);
    if (preset) return preset.url;
  }
  // A clip saved as a preset resolves through the sentinel even if the item's config
  // was lost, so the layer still shows its device rather than nothing.
  const fromUrl = getModelPreset(presetIdFromUrl(clip?.url));
  if (fromUrl) return fromUrl.url;
  return clip?.url || '';
}

/** Default orientation for a preset, in degrees — most device GLBs face away. */
export function presetBaseRotation(id) {
  const p = getModelPreset(id);
  return p?.faceCamera ? { x: 0, y: 180, z: 0 } : { x: 0, y: 0, z: 0 };
}

/** Does this layer's model have a screen artwork can be put on? */
export function modelScreenTarget(item) {
  const cfg = item?.model3dConfig;
  if (cfg?.source !== 'preset') return null;
  return getModelPreset(cfg.preset)?.screen || null;
}
