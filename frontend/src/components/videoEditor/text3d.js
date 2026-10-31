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
