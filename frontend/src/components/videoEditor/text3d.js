// 3D Text — real extruded letters for an ordinary TEXT layer (item.text3d).
//
// The text layer keeps everything it is: the editor's fonts, wrapping, Text
// Animators (each letter moves, scales and turns — Rotate 3D becomes a REAL turn
// of a solid letter), Text on Path, keyframes and the layer transform. Only the
// pixels change: instead of painting glyphs onto the 2D plate, every letter
// becomes an extruded, bevelled mesh, lit by the 3D Rig (or its own studio light
// and environment) and filmed by the project camera in the 3D pass
// (model3dLayer.js renderText3dLayer). Letters are traced from the font the
// layer really draws with (text3dGlyphs.js), so any font works — Google, uploaded,
// system, any weight.
//
// Dependency-free on purpose: the sanitizer and the predicates are imported by
// editorState.js, rig3d.js and plain-node tests.

export const TEXT3D_DEFAULTS = Object.freeze({
  enabled: false,
  depth: 30, // extrusion, % of the font size
  bevel: 18, // roundness: the bevel size, % of the font size (capped per glyph so thin strokes survive)
  bevelSegments: 5, // smoothness of the rounded edge
  faceColor: null, // null = the letter's own text colour (incl. random / animator colours)
  sideColor: null, // null = the face colour, darkened
  sideShade: 35, // % darker for the derived side colour
  palette: [], // letter colours cycled per letter (toy look); empty = off
  material: 'plastic', // plastic | matte | metal | glass
  light: 'studio', // studio | soft | dramatic — used when no 3D Rig lights the scene
  envIntensity: 1, // environment reflections strength (no Rig)
  castShadow: true, // (bugsB) the letters' shadow on the set, the models and each other (a Rig's or a Scene's light)
  receiveShadow: true, // (bugsB) the set's and the models' shadows on the letters (raster; Final traces real light either way)
});

export const TEXT3D_MATERIALS = ['plastic', 'matte', 'metal', 'glass'];
export const TEXT3D_LIGHTS = ['studio', 'soft', 'dramatic'];

// Number fields as the panel shows them. None is keyframable: depth and bevel
// rebuild every letter's geometry, which must never happen per frame.
export const TEXT3D_NUMBER_FIELDS = [
  { key: 'depth', label: 'Depth', min: 0, max: 200, step: 1, suffix: '%' },
  { key: 'bevel', label: 'Roundness', min: 0, max: 40, step: 1, suffix: '%' },
  { key: 'bevelSegments', label: 'Smoothness', min: 1, max: 10, step: 1 },
  { key: 'sideShade', label: 'Side Shade', min: 0, max: 90, step: 1, suffix: '%' },
  { key: 'envIntensity', label: 'Reflections', min: 0, max: 3, step: 0.05 },
];

const HEX_RE = /^#[0-9a-f]{6}$/i;
const num = (v, d, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const color = (v) => (typeof v === 'string' && HEX_RE.test(v.trim()) ? v.trim().toLowerCase() : null);

/** A clean text3d block, or null when there is nothing worth storing. */
export function sanitizeText3d(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = { enabled: raw.enabled === true };
  for (const f of TEXT3D_NUMBER_FIELDS) {
    out[f.key] = num(raw[f.key], TEXT3D_DEFAULTS[f.key], f.min, f.max);
    if (f.step >= 1) out[f.key] = Math.round(out[f.key]);
  }
  out.faceColor = color(raw.faceColor);
  out.sideColor = color(raw.sideColor);
  out.palette = Array.isArray(raw.palette) ? raw.palette.map(color).filter(Boolean).slice(0, 12) : [];
  out.material = TEXT3D_MATERIALS.includes(raw.material) ? raw.material : TEXT3D_DEFAULTS.material;
  out.light = TEXT3D_LIGHTS.includes(raw.light) ? raw.light : TEXT3D_DEFAULTS.light;
  // (bugsB) the letters' shadows, on unless switched off
  out.castShadow = raw.castShadow !== false;
  out.receiveShadow = raw.receiveShadow !== false;
  // (polish2) in a world Scene the letters wear this Scene material, by its id (an animated one included); only when set
  const scene = typeof raw.sceneMaterial === 'string' ? raw.sceneMaterial.trim().slice(0, 64) : '';
  if (scene) out.sceneMaterial = scene;
  return out;
}

/** The effective settings: stored values over the defaults. */
export function resolveText3d(item) {
  const raw = item?.text3d;
  return { ...TEXT3D_DEFAULTS, ...(raw && typeof raw === 'object' ? sanitizeText3d(raw) : {}) };
}

/** A text layer drawn as real 3D letters. One property read for every other layer. */
export function isText3dLayer(item, clip) {
  return item?.text3d?.enabled === true && clip?.mediaType === 'text';
}

// Flat text in the Scene's world (item.textInWorld): on a frame a world Scene draws, every letter of an ordinary text layer
// becomes a flat card in the world's space, filmed by the world's camera (world3dText.js worldFlatLetters). Sparse: `enabled`,
// and the options only when set. `lit` takes the scene's light and its shadows (`receiveShadow: false` keeps them off),
// `castShadow` drops the letters' shadow on the world. `true` alone is read as `{ enabled: true }`.
const TEXT_IN_WORLD_OPTIONS = ['lit', 'castShadow'];

/** A clean textInWorld block, or null when there is nothing worth storing. */
export function sanitizeTextInWorld(raw) {
  if (raw === true) return { enabled: true };
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (raw.enabled === true) out.enabled = true;
  for (const k of TEXT_IN_WORLD_OPTIONS) if (raw[k] === true) out[k] = true;
  if (raw.receiveShadow === false) out.receiveShadow = false;
  return Object.keys(out).length ? out : null;
}

/** A text layer whose letters stand in a world Scene as flat cards. 3D Text has its own way in, and a clip mask never joins. */
export function isTextInWorldLayer(item, clip) {
  const v = item?.textInWorld;
  return (v === true || v?.enabled === true) && clip?.mediaType === 'text' && !item.textClipMask && item.text3d?.enabled !== true;
}

/** How the letters stand there: `{ lit, castShadow, receiveShadow }`. */
export function resolveTextInWorld(item) {
  const v = sanitizeTextInWorld(item?.textInWorld) || {};
  return { lit: v.lit === true, castShadow: v.castShadow === true, receiveShadow: v.lit === true && v.receiveShadow !== false };
}
