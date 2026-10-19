import * as THREE from 'three';

/*
 * Pryzm — glass, refraction and dispersion as a geometry layer effect.
 * Port of html/pryzm-lab.html.
 *
 * THE ONE IDEA
 * ------------
 * The three kinds of glass here — fluted ribs, concentric rings, a diamond
 * lattice — are not three effects. Each is a single scalar field
 *
 *     h(b) = PROFILE( distance from b to the edge of the cell it is in )
 *
 * and the shader never learns which lattice made it: it takes the numerical
 * gradient of h, builds a normal, and refracts through it. Adding a fourth kind
 * of glass is adding a tessellation to `cell()`, never a new render path.
 *
 * WHY A NUMERICAL GRADIENT AND NOT ANALYTIC NORMALS
 * -------------------------------------------------
 * Every lattice has an analytic normal you could derive and each derivation is a
 * different bug. Four evaluations of h around b cost the same on all of them and
 * cannot disagree with the height the effect is actually drawing. The contract
 * that makes it safe is that h = 0 ON every cell edge, so the field is continuous
 * across seams and the gradient there is the steep shoulder we want.
 *
 * They are CENTRAL differences. A forward difference puts the whole of a rim's
 * near-vertical wall into the pixel on one side of it, which stamps the same
 * lopsided wedge into every cell of every lattice — it reads as a tessellation
 * bug and is really a half-pixel bias. Measured in the lab, then fixed there.
 *
 * WHY DISPERSION IS A LOOP AND NOT AN RGB SPLIT
 * ---------------------------------------------
 * Sampling three times with three IORs gives red/green/blue fringes, which is
 * what "chromatic aberration" filters do and it looks like three overlaid
 * photos. Real glass has a continuum n(lambda), so the loop walks lambda from
 * red to violet and weights each tap by an approximate eye response. Three taps
 * is kept as the cheap mode because hard pink/cyan fringing is a look.
 *
 * REFRACTION IS A SLAB SHIFT, NOT A RAY MARCH
 * -------------------------------------------
 * A pixel looks straight in, bends at the surface, and travels `pzThick` before
 * it reaches the plate behind. The lateral shift is exactly t * T.xy / -T.z —
 * one texture fetch, no marching. That is what makes this a layer effect rather
 * than a renderer: the "plate" is the layer itself, flat, at a fixed distance.
 * Total internal reflection is a real outcome of that maths at high IOR on a
 * steep rim, and it is handled — the tap contributes black rather than sampling
 * a nonsense direction.
 *
 * MAGNIFY IS NOT REFRACTION
 * -------------------------
 * The shipped default reads as each rib showing ONE column of the plate, and its
 * Relief is 1% — refraction is barely bending anything. That is a lens with
 * enormous power, and reaching it through IOR falls apart everywhere else. So
 * Cell Magnify is its own control: pull the sample toward the centre of the
 * cell. Physically a thick lens focused on the plate; practically the knob that
 * makes a mosaic out of a glass.
 *
 * FROST IS A MIP, AND THE PASS BRINGS ITS OWN
 * -------------------------------------------
 * The app's isolate is a POOLED SCRATCH TARGET with LinearFilter and no mip
 * chain, so an explicit LOD against it silently returns level 0 (the trap
 * [drosteLayer.js] documents). The first cut of this port tried to dodge that by
 * riding the dispersion taps — every spectral sample also jittered inside an
 * equal-area disc, on the theory that a rough surface scatters each wavelength
 * over a cone anyway.
 *
 * IT DOES NOT WORK, and the failure is not subtle. Frost 70 is a ~64 px average;
 * 21 taps across that disc is wildly undersampled, so each wavelength
 * POINT-samples a different scrap of the plate and the spectrum resolves to
 * rainbow confetti instead of a smooth tint. Measured against the lab on the
 * same plate at the same params (tests/pryzm/verify_parity.js): not grainier,
 * a different effect.
 *
 * So the pass owns ONE extra target: the isolate blitted into a private,
 * mipmapped copy (`ensurePryzmSource` in Player.jsx), which every fetch then
 * reads with an explicit LOD. Frost IS that LOD, exactly as in the lab, and
 * bloom is a high level of the same chain. One extra full-frame blit per Pryzm
 * layer per frame buys an area average at any radius for the cost of a tap.
 *
 * `texture2DLodEXT` is not an extension here: three compiles every shader as
 * "#version 300 es" on WebGL2 and its own fragment prefix carries
 * "#define texture2DLodEXT textureLod", so this stays a GLSL1-style shader like
 * every other warp and still gets a true LOD fetch.
 *
 * Coordinate conventions, shared with every other warp ([cornerPinLayer.js]):
 *  - Authored params are PERCENT OF THE LAYER BOX, +y DOWN, like every other %.
 *  - The shader works in box uv `b` in [0,1]^2, +y DOWN, so the lab maths ports
 *    verbatim — the lab was already written in that space.
 *  - Sampling converts box uv -> frame uv through the computeLayerBox affine,
 *    because the isolate is a FULL-FRAME target in which the layer occupies a
 *    sub-rect. Edge handling is therefore in BOX units; a texture wrap would
 *    wrap the whole frame.
 *
 * Like Droste this quad is NOT overscanned. Pryzm resamples the layer, it does
 * not displace it past its own bounds, so it must not grow the footprint.
 */

export const PRYZM_LAYER_EFFECT_ID = 'pryzm';

/*
 * Not PRO. Running Glow, Droste, Motion Trail and the Rig are gated at render;
 * Pryzm deliberately is not, because that is a pricing decision and nobody has
 * made it. Flip this one constant and add `containsProPryzmEffect` beside the
 * others in VideoEditor's handleRenderInBackground to gate it — the plumbing
 * below is already shaped for it.
 */
export const PZ_IS_PRO = false;

/* Lattice ids — these must match the branches in `cell()` and in the TSL twin. */
export const PZ_LAT = { flute: 0, rings: 1, rhomb: 2 };
/* Profile ids — likewise. */
export const PZ_PRO = { dome: 0, round: 1, flat: 2, pyramid: 3, concave: 4, sine: 5, facet: 6 };

/*
 * THE DEFAULTS ARE THE APPROVED LOOK, not a neutral pose.
 *
 * Adding Pryzm to a layer lands on the fluted glass the effect was signed off
 * on: narrow ribs, each showing one blurred column of what is behind it, widths
 * driven by the plate's own luminance. Relief 1% is not a mistake — see MAGNIFY
 * IS NOT REFRACTION above.
 */
export const PZ_DEFAULTS = {
  // glass — which tessellation, and what shape each cell is
  pzGlass: PZ_LAT.flute,
  pzProfile: PZ_PRO.dome,
  pzCell: 16,           // % of box height — one cell across
  pzStretch: 44,        // % — widen the cells on their x axis (squashes rings to ellipses)
  pzRot: 0,             // ° — the lattice's own axes
  pzOX: 46.16,          // % of box, y down — lattice origin: rings centre AND warp crosshair
  pzOY: 45.61,
  // cell warp — what makes the cells UNEVEN
  pzWarpSrc: 2,         // 0 off, 1 noise, 2 the plate's own luminance
  pzWarpAxis: 1,        // 1 separable (cells stay straight), 0 free (cells bend)
  pzWarpAmt: 95,        // %
  pzWarpScale: 1.4,     // noise frequency
  // surface
  pzRelief: 1,          // % — how steep the glass is. THIS one is why it reads as magnify.
  pzBevel: 25,          // % — flat profile's shoulder width
  pzTilt: 80,           // % — facet profile's random tilt
  pzGroove: 0,          // % — a flat-bottomed channel cut along every seam
  // refraction
  pzIor: 2.06,
  pzThick: 188,         // % — how far the plate sits behind the surface
  pzDisp: 105,          // % — spread of n(lambda) across the spectrum
  pzSpectrum: 1,        // 0 RGB split (3 taps), 1 spectral
  pzTaps: 21,
  pzMagnify: 100,       // % — pull the sample to the cell centre
  pzFrost: 70,          // % — see FROST IS THE TAPS
  pzEdge: 3,            // off-plate: transparent / clamp / repeat / MIRROR
  // light on the glass itself
  pzLightX: 19.96,      // % of box, y down
  pzLightY: 48.11,
  pzLightZ: 65,         // % — how far in front of the surface the light sits
  pzSpec: 26,           // %
  pzGloss: 32,
  pzHighlight: '#ffffff',
  pzSheen: 21,          // % — fresnel rim on the steep parts
  pzSheenFall: 4.3,
  // look
  pzTint: '#ffffff',
  pzTintAmt: 70,        // % (a white tint at any amount is a no-op — it is the colour that matters)
  pzAbsorb: 0,          // % — thicker glass, darker
  pzSeam: 24,           // % — darken the cell edges
  pzSeamW: 1,           // %
  pzBloom: 10,          // %
  pzGrain: 12,          // %
  pzExposure: 4,        // %
  // motion — RATES, deliberately not keyframable (phase = t*rate jumps on a track)
  pzDrift: 0,           // cells/s (rings: rings/s outward)
  pzFlow: 0,            // noise evolution, /s
  // master
  pzAmount: 100,        // % (keyframable)
};

export const PZ_NUMBER_FIELDS = [
  { key: 'pzCell', label: 'Cell Size', min: 1, max: 40, step: 0.5, suffix: '%', kf: true, group: 'glass' },
  { key: 'pzStretch', label: 'Stretch', min: 15, max: 500, step: 1, suffix: '%', kf: true, group: 'glass' },
  { key: 'pzRot', label: 'Rotation', min: 0, max: 180, step: 1, suffix: '°', kf: true, group: 'glass' },
  { key: 'pzOX', label: 'Origin X', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'glass' },
  { key: 'pzOY', label: 'Origin Y', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'glass' },
  { key: 'pzWarpAmt', label: 'Warp Amount', min: 0, max: 300, step: 1, suffix: '%', kf: true, group: 'warp' },
  { key: 'pzWarpScale', label: 'Warp Scale', min: 0.2, max: 8, step: 0.1, kf: true, group: 'warp' },
  { key: 'pzRelief', label: 'Relief', min: 0, max: 400, step: 1, suffix: '%', kf: true, group: 'surface' },
  { key: 'pzBevel', label: 'Bevel Width', min: 2, max: 100, step: 1, suffix: '%', kf: true, group: 'surface' },
  { key: 'pzTilt', label: 'Facet Tilt', min: 0, max: 200, step: 1, suffix: '%', kf: true, group: 'surface' },
  { key: 'pzGroove', label: 'Groove', min: 0, max: 40, step: 1, suffix: '%', kf: true, group: 'surface' },
  { key: 'pzIor', label: 'IOR', min: 1, max: 2.8, step: 0.01, kf: true, group: 'refract' },
  { key: 'pzThick', label: 'Thickness', min: 0, max: 300, step: 1, suffix: '%', kf: true, group: 'refract' },
  { key: 'pzDisp', label: 'Dispersion', min: 0, max: 150, step: 1, suffix: '%', kf: true, group: 'refract' },
  // An integer BUDGET, not a look: a track would ramp it through values that
  // change the frost pattern as well as the spectrum. Same reasoning as
  // mblurSamples / glowCount.
  { key: 'pzTaps', label: 'Taps', min: 4, max: 32, step: 1, group: 'refract' },
  { key: 'pzMagnify', label: 'Cell Magnify', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'refract' },
  { key: 'pzFrost', label: 'Frost', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'refract' },
  { key: 'pzLightX', label: 'Light X', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'light' },
  { key: 'pzLightY', label: 'Light Y', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'light' },
  { key: 'pzLightZ', label: 'Light Height', min: 5, max: 300, step: 1, suffix: '%', kf: true, group: 'light' },
  { key: 'pzSpec', label: 'Specular', min: 0, max: 400, step: 1, suffix: '%', kf: true, group: 'light' },
  { key: 'pzGloss', label: 'Gloss', min: 4, max: 256, step: 1, kf: true, group: 'light' },
  { key: 'pzSheen', label: 'Edge Sheen', min: 0, max: 300, step: 1, suffix: '%', kf: true, group: 'light' },
  { key: 'pzSheenFall', label: 'Sheen Falloff', min: 0.5, max: 10, step: 0.1, kf: true, group: 'light' },
  { key: 'pzTintAmt', label: 'Tint', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'look' },
  { key: 'pzAbsorb', label: 'Absorption', min: 0, max: 200, step: 1, suffix: '%', kf: true, group: 'look' },
  { key: 'pzSeam', label: 'Seam Shade', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'look' },
  { key: 'pzSeamW', label: 'Seam Width', min: 1, max: 40, step: 1, suffix: '%', kf: true, group: 'look' },
  { key: 'pzBloom', label: 'Bloom', min: 0, max: 200, step: 1, suffix: '%', kf: true, group: 'look' },
  { key: 'pzGrain', label: 'Grain', min: 0, max: 60, step: 1, suffix: '%', kf: true, group: 'look' },
  { key: 'pzExposure', label: 'Exposure', min: -100, max: 100, step: 1, suffix: '%', kf: true, group: 'look' },
  { key: 'pzDrift', label: 'Drift', min: -8, max: 8, step: 0.05, suffix: ' cells/s', group: 'motion' },
  { key: 'pzFlow', label: 'Flow', min: 0, max: 200, step: 1, suffix: '%/s', group: 'motion' },
  { key: 'pzAmount', label: 'Effect Amount', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'motion' },
];

export const PZ_ENUM_FIELDS = [
  {
    key: 'pzGlass',
    label: 'Glass',
    group: 'glass',
    options: [[PZ_LAT.flute, 'Fluted'], [PZ_LAT.rings, 'Rain Ripple'], [PZ_LAT.rhomb, 'Diamond Cut']],
  },
  {
    key: 'pzProfile',
    label: 'Profile',
    group: 'surface',
    // The material vocabulary. Every glass wears every profile, and the crossings
    // are where the rest of the materials live: ribs + Flat are reeded bars,
    // rings + Pyramid is a cut tumbler base.
    options: [
      [PZ_PRO.dome, 'Dome — convex lens'], [PZ_PRO.round, 'Rounded'], [PZ_PRO.flat, 'Flat + bevel'],
      [PZ_PRO.pyramid, 'Pyramid'], [PZ_PRO.concave, 'Concave'], [PZ_PRO.sine, 'Sine swell'],
      [PZ_PRO.facet, 'Facet — random tilt'],
    ],
  },
  {
    key: 'pzWarpSrc',
    label: 'Cell Warp',
    group: 'warp',
    options: [[0, 'Off — even cells'], [1, 'Noise'], [2, 'The layer behind it']],
  },
  {
    key: 'pzWarpAxis',
    label: 'Warp Shape',
    group: 'warp',
    // Warping by a field that varies in BOTH axes bends the cell edges: a rib
    // stops being a rib. Straight cells of uneven width are a different thing —
    // a one-dimensional remap of each lattice axis — and that is Separable.
    options: [[1, 'Separable — cells stay straight'], [0, 'Free — cells bend']],
  },
  {
    key: 'pzSpectrum',
    label: 'Spectrum',
    group: 'refract',
    options: [[0, 'RGB split — 3 taps'], [1, 'Spectral']],
  },
  {
    key: 'pzEdge',
    label: 'Off-plate',
    group: 'refract',
    // Same four, in the same order, as every other warp's Outside field.
    options: [[0, 'Transparent'], [1, 'Clamp'], [2, 'Repeat'], [3, 'Mirror']],
  },
];

export const PZ_COLOR_FIELDS = [
  { key: 'pzHighlight', label: 'Highlight', group: 'light' },
  { key: 'pzTint', label: 'Glass Tint', group: 'look' },
];

// Keyframable params, registered in keyframeProps.js.
export const PZ_KF_KEYS = PZ_NUMBER_FIELDS.filter((f) => f.kf).map((f) => f.key);

/* The lab's three looks. Each preset writes the FULL pose rather than a delta,
   so switching between them can never leave a stray knob from the last one —
   the way DRO_PRESETS / REP_PRESETS already work. */
const preset = (values) => ({ ...PZ_DEFAULTS, ...values });
export const PZ_PRESETS = [
  { name: 'Fluted Ember', values: preset({}) },
  {
    name: 'Rain Drop',
    values: preset({
      pzGlass: PZ_LAT.rings, pzProfile: PZ_PRO.sine, pzCell: 7, pzStretch: 100,
      pzOX: 50, pzOY: 50, pzWarpSrc: 0, pzRelief: 130, pzThick: 85, pzDisp: 26, pzTaps: 14,
      pzMagnify: 0, pzFrost: 0, pzSpec: 65, pzGloss: 36, pzSheen: 30, pzSheenFall: 3,
      pzTintAmt: 0, pzSeam: 12, pzSeamW: 3, pzBloom: 0, pzGrain: 0, pzExposure: 6,
      pzDrift: -0.6,
    }),
  },
  {
    name: 'Crystal Cut',
    values: preset({
      pzGlass: PZ_LAT.rhomb, pzProfile: PZ_PRO.pyramid, pzCell: 13, pzStretch: 100,
      pzOX: 50, pzOY: 50, pzWarpSrc: 0, pzRelief: 100, pzIor: 1.7, pzThick: 85, pzDisp: 75,
      pzTaps: 14, pzMagnify: 0, pzFrost: 0, pzSpec: 150, pzGloss: 110, pzSheen: 55,
      pzSheenFall: 3, pzTintAmt: 0, pzSeam: 0, pzBloom: 0, pzGrain: 0, pzExposure: 14,
    }),
  },
];

export function getPryzmEffect(item) {
  const list = Array.isArray(item?.layerEffects) ? item.layerEffects : [];
  return list.find((effect) => effect?.id === PRYZM_LAYER_EFFECT_ID) || null;
}

/* The Player's collector predicate AND the per-channel exact bypass. There is no
   "identity pose" to compare against — glass at rest is still glass — so only
   Effect Amount can switch it off, and a keyframed amount ramping up from a
   static 0 keeps the pass alive. Same shape as isDrosteEnabled. */
export function isPryzmEnabled(item) {
  const effect = getPryzmEffect(item);
  if (!effect || effect.enabled === false) return false;
  const amount = Number.isFinite(effect.params?.pzAmount) ? effect.params.pzAmount : PZ_DEFAULTS.pzAmount;
  if (amount > 0.01) return true;
  const track = item?.propertyKeyframes?.pzAmount;
  return Array.isArray(track) && track.length > 0;
}

function pryzmGatesRender(item) {
  if (!PZ_IS_PRO) return false;
  return isPryzmEnabled(item);
}

// Project sequences can nest other sequences, so inspect the complete saved
// editor state rather than only the currently visible timeline level.
export function containsProPryzmEffect(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (pryzmGatesRender(value)) return true;
  if (Array.isArray(value)) return value.some((entry) => containsProPryzmEffect(entry, seen));
  return Object.values(value).some((entry) => containsProPryzmEffect(entry, seen));
}

/** Effective params for a frame: keyframe track ?? stored param ?? default. */
export function resolvePryzmParams(item, keyframeProps) {
  const effect = getPryzmEffect(item);
  const params = effect?.params || {};
  const out = {};
  for (const [key, fallback] of Object.entries(PZ_DEFAULTS)) {
    if (typeof fallback === 'string') {
      const raw = params[key];
      out[key] = typeof raw === 'string' && raw ? raw : fallback;
      continue;
    }
    const kf = keyframeProps?.[key];
    if (Number.isFinite(kf)) { out[key] = kf; continue; }
    const stored = params[key];
    out[key] = Number.isFinite(stored) ? stored : fallback;
  }
  return out;
}

const hexToRgb = (hex) => {
  const s = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#000000';
  return [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255];
};

/*
 * The tap count the shader is actually given. RGB split IS three taps — the
 * mode is not a hint, it is the loop bound — so the panel's Taps field is only
 * read in spectral mode. Clamped to the shader's constant loop ceiling.
 */
export const PZ_MAX_TAPS = 32;
export function pryzmTaps(p) {
  if (Math.round(p.pzSpectrum) === 0) return 3;
  const n = Math.round(Number.isFinite(p.pzTaps) ? p.pzTaps : PZ_DEFAULTS.pzTaps);
  return Math.max(1, Math.min(PZ_MAX_TAPS, n));
}

/* ── shader ─────────────────────────────────────────────────────────────── */

/* NO BACKTICKS ANYWHERE BELOW, comments included — these are JS template
   literals, so one backtick in a GLSL comment ends the string and the parse
   error lands on a line that looks fine. */
const COMMON = /* glsl */`
  uniform vec2 uOrigin;      // frame uv of the box centre
  uniform vec2 uAxisX;       // half-axis of the box in frame uv (+x)
  uniform vec2 uAxisY;       // half-axis of the box in frame uv (+y UP)

  // box uv (y down) → frame uv, through the layer-box affine
  vec2 boxToFrame(vec2 b) {
    vec2 l = vec2(b.x * 2.0 - 1.0, 1.0 - b.y * 2.0);
    return uOrigin + uAxisX * l.x + uAxisY * l.y;
  }
`;

const VERTEX = /* glsl */`
  precision highp float;
  attribute vec2 aRest;      // rest position in box uv (y down), exactly [0,1]
  varying vec2 vRest;
${COMMON}
  void main() {
    vRest = aRest;
    gl_Position = vec4(boxToFrame(aRest) * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const FRAGMENT = /* glsl */`
  precision highp float;
  uniform sampler2D uTexture;
  uniform vec2 uBoxPx;       // layer box size in plate pixels
  uniform float uAspect;     // box w/h — the lattice works in square units
  uniform vec2 uLatOrigin;   // box uv (y down)
  uniform float uCell, uStretch, uRot;
  uniform float uWarpAmt, uWarpScale;
  uniform float uRelief, uBevel, uTilt, uGroove;
  uniform float uIor, uThick, uDisp, uMagnify, uFrost;
  uniform vec3 uLightDir, uHighlight, uTint;
  uniform float uSpec, uGloss, uSheen, uSheenFall;
  uniform float uTintAmt, uAbsorb, uSeam, uSeamW, uBloom, uGrain, uExposure;
  uniform float uAmount, uTime, uDriftT, uFlowT;
  uniform float uMaxLod;     // log2 of the longest side of the mipped source
  uniform int uLat, uProfile, uWarpSrc, uWarpAxis, uSpectrum, uTaps, uEdge;
  varying vec2 vRest;
${COMMON}

  const float TAU_C = 6.28318530718;

  float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  float hash11(float n) { return fract(sin(n * 127.1) * 43758.5453123); }
  float hash21(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 7.1; a *= 0.5; }
    return s;
  }

  /*
   * The plate behind the glass. Edge handling is in BOX units — the isolate is
   * frame sized, so a texture wrap mode would wrap the whole frame rather than
   * the layer. Identical semantics to every other warp's fetchBox.
   */
  vec4 fetchBox(vec2 b, float lod) {
    vec2 s = b;
    if (uEdge == 0) {
      if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) return vec4(0.0);
    } else if (uEdge == 1) {
      s = clamp(s, 0.0, 1.0);
    } else if (uEdge == 2) {
      s = fract(s);
    } else {
      vec2 m = mod(s, 2.0);
      s = min(m, 2.0 - m);
    }
    /* A real LOD, not a bias: this pass's offsets jump between cells, so the
       automatic derivative-based level is meaningless here. */
    return texture2DLodEXT(uTexture, boxToFrame(s), lod);
  }

  /* ── lattice space ──────────────────────────────────────────────────────
     Here p is the box measured in SQUARE units: x in [0, aspect], y in [0, 1], y
     down, so a cell is as wide as it is tall on any layer shape. L is that
     space scaled and rotated so one cell is one unit. */
  vec2 toL(vec2 p) {
    vec2 q = p - uLatOrigin * vec2(uAspect, 1.0);
    float s = sin(uRot), c = cos(uRot);
    q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
    q /= max(uCell, 0.0005);
    q.x /= max(uStretch, 0.02);
    return q;
  }
  /* Only the LINEAR part is inverted — the warp is not invertible and does not
     need to be. All this is used for is pointing at the middle of a cell. */
  vec2 fromLDelta(vec2 dq) {
    dq.x *= max(uStretch, 0.02);
    dq *= max(uCell, 0.0005);
    float s = sin(-uRot), c = cos(-uRot);
    return vec2(c * dq.x - s * dq.y, s * dq.x + c * dq.y);
  }

  /* ── the tessellations ──────────────────────────────────────────────────
     Every one returns the same four things and nothing else:
       cc  centre of the cell, in L
       t   1 at the centre, 0 ON the edge — this is what the profile eats
       dE  distance to that edge in L units, for grooves and seams
       rnd a stable per-cell random
     t = 0 on the edge is the contract that keeps the height field continuous
     across seams, which is the only reason a numerical gradient is safe. */
  void cell(vec2 q, out vec2 cc, out float t, out float dE, out float rnd) {
    cc = q; t = 1.0; dE = 1.0; rnd = 0.0;

    if (uLat == 0) {                                   /* flute — ribs */
      q.x -= uDriftT;
      float i = floor(q.x + 0.5);
      float d = abs(q.x - i);
      cc = vec2(i + uDriftT, q.y); t = 1.0 - 2.0 * d; dE = 0.5 - d; rnd = hash11(i);

    } else if (uLat == 1) {                            /* rings — concentric */
      /* Drift rides the RADIUS, so the rings travel outward from the origin. */
      float r = length(q) - uDriftT;
      float i = floor(r + 0.5);
      float d = abs(r - i);
      vec2 dir = length(q) > 1e-5 ? normalize(q) : vec2(1.0, 0.0);
      cc = dir * max(i + uDriftT, 0.0);
      t = 1.0 - 2.0 * d; dE = 0.5 - d; rnd = hash11(i);

    } else {                                           /* rhomb — a grid at 45 */
      q.x -= uDriftT;
      vec2 r = vec2(q.x + q.y, q.y - q.x) * 0.70710678;
      vec2 i = floor(r + 0.5), f = abs(r - i);
      float m = max(f.x, f.y);
      vec2 back = vec2(i.x - i.y, i.x + i.y) * 0.70710678;
      cc = back + vec2(uDriftT, 0.0); t = 1.0 - 2.0 * m; dE = 0.5 - m; rnd = hash21(i);
    }
  }

  /* ── the profile: cell shape → height. The whole material vocabulary. ── */
  float profile(float t, vec2 loc, float rnd) {
    t = clamp(t, 0.0, 1.0);
    if (uProfile == 0) return sqrt(max(0.0, 1.0 - (1.0 - t) * (1.0 - t)));   /* dome */
    if (uProfile == 1) return smoothstep(0.0, 1.0, t);                       /* rounded */
    if (uProfile == 2) return smoothstep(0.0, max(uBevel, 0.02), t);         /* flat + bevel */
    if (uProfile == 3) return t;                                             /* pyramid */
    if (uProfile == 4) return 1.0 - sqrt(max(0.0, 1.0 - t * t));             /* concave */
    if (uProfile == 5) return 0.5 - 0.5 * cos(3.14159265 * t);               /* sine swell */
    float a = rnd * TAU_C;                                                   /* facet tilt */
    return smoothstep(0.0, 0.3, t) * clamp(0.5 + 0.5 * dot(vec2(cos(a), sin(a)), loc) * uTilt, 0.0, 1.5);
  }

  /* ── the height field. This IS the effect; everything after it is one
        refraction and some lighting. ─────────────────────────────────────── */
  float glassH(vec2 b, out vec2 ccL, out vec2 qOut, out float dE, out float rnd) {
    vec2 p = vec2(b.x * uAspect, b.y);
    vec2 q = toL(p);

    /*
     * CELL WARP — why SEPARABLE is a mode and not a refinement.
     *
     * Warping q by a field that varies in both axes bends the cell edges: a rib
     * stops being a rib. The look this effect exists for has DEAD STRAIGHT cells
     * of UNEVEN WIDTH, which is a one-dimensional remap of each lattice axis.
     * Separable does exactly that: q.x is displaced by a function of q.x alone,
     * so columns stay columns and only their spacing changes. The lattice origin
     * is the crosshair the plate is read along, and it is at (0,0) in L by
     * construction — which is what makes the axis samples exact under rotation.
     */
    if (uWarpAmt > 0.0 && uWarpSrc > 0) {
      if (uWarpSrc == 1) {
        if (uWarpAxis == 1) {
          q += (vec2(vnoise(vec2(q.x * uWarpScale, uFlowT)),
                     vnoise(vec2(q.y * uWarpScale + 31.7, uFlowT + 5.0))) - 0.5) * uWarpAmt;
        } else {
          q += (vec2(fbm(q * uWarpScale + vec2(0.0, uFlowT)),
                     fbm(q * uWarpScale + vec2(5.2, uFlowT + 3.1))) - 0.5) * uWarpAmt;
        }
      } else {
        if (uWarpAxis == 1) {
          vec2 org = uLatOrigin * vec2(uAspect, 1.0);
          vec2 ax = fromLDelta(vec2(q.x, 0.0)) + org;
          vec2 ay = fromLDelta(vec2(0.0, q.y)) + org;
          /* The warp reads a BLURRED plate on purpose — cell edges must not
             chase noise. Level 3 is the lab's own choice. */
          float lx = lum(fetchBox(vec2(ax.x / uAspect, ax.y), 3.0).rgb);
          float ly = lum(fetchBox(vec2(ay.x / uAspect, ay.y), 3.0).rgb);
          q += (vec2(lx, ly) - 0.45) * uWarpAmt;
        } else {
          q += (lum(fetchBox(b, 3.0).rgb) - 0.45) * uWarpAmt;
        }
      }
    }
    qOut = q;

    vec2 cc; float t;
    cell(q, cc, t, dE, rnd);
    ccL = cc;
    float h = profile(t, q - cc, rnd);
    if (uGroove > 0.0) h *= smoothstep(uGroove * 0.35, uGroove, dE);
    return h;
  }

  /* Eye response, roughly. Enough to make a continuum of IORs read as a
     spectrum instead of as three ghosts. */
  vec3 specW(float t) {
    return vec3(exp(-15.0 * (t - 0.10) * (t - 0.10)),
                exp(-15.0 * (t - 0.50) * (t - 0.50)),
                exp(-15.0 * (t - 0.90) * (t - 0.90)));
  }

  void main() {
    vec2 b = vRest;

    vec2 ccL, qc, dA, dB; float dE, rnd, dd, dr;
    float h = glassH(b, ccL, qc, dE, rnd);
    /*
     * CENTRAL differences, one plate pixel out. A forward difference puts the
     * whole of a rim's near-vertical wall into the pixel on ONE side of it,
     * which stamps the same lopsided wedge into every cell of every lattice.
     */
    float ex = 1.0 / max(uBoxPx.y, 1.0);          // one pixel, in box-uv y
    vec2 eu = vec2(ex / max(uAspect, 1e-4), 0.0); // the same distance in x
    vec2 ev = vec2(0.0, ex);
    float hx1 = glassH(b + eu, dA, dB, dd, dr);
    float hx0 = glassH(b - eu, dA, dB, dd, dr);
    float hy1 = glassH(b + ev, dA, dB, dd, dr);
    float hy0 = glassH(b - ev, dA, dB, dd, dr);

    /* Relief is normalised by cell size, so resizing the cells does not change
       the material's shape — only how many of it there are. */
    float amp = uRelief * max(uCell, 0.0005);
    vec3 N = normalize(vec3(-(hx1 - hx0) / (2.0 * ex) * amp,
                            -(hy1 - hy0) / (2.0 * ex) * amp, 1.0));

    /* Cell magnify — a lens focused on the plate, not a stronger refraction. */
    vec2 base = b;
    if (uMagnify > 0.0) {
      vec2 dP = fromLDelta(ccL - qc);
      base += vec2(dP.x / max(uAspect, 1e-4), dP.y) * uMagnify;
    }

    float frostLod = clamp(uFrost * uMaxLod, 0.0, uMaxLod);
    vec3 col = vec3(0.0);
    vec3 wsum = vec3(1e-5);
    float alpha = 0.0;
    float asum = 1e-5;
    int taps = uTaps;

    for (int i = 0; i < 32; i++) {
      if (i >= taps) break;
      float fi = float(i);
      float lam = taps <= 1 ? 0.5 : fi / float(taps - 1);
      vec3 w = uSpectrum == 0
        ? (i == 0 ? vec3(1.0, 0.0, 0.0) : (i == 1 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0)))
        : specW(lam);
      float ior = max(1.0, uIor + uDisp * (lam - 0.5));
      vec3 T = refract(vec3(0.0, 0.0, -1.0), N, 1.0 / ior);
      /* refract() returns 0 on total internal reflection — a real outcome at
         high IOR on a steep rim. It must go dark, not sample some arbitrary
         direction, so the weight still counts and the colour does not. */
      float ok = step(0.25, dot(T, T));
      vec2 off = (T.xy / max(-T.z, 0.02)) * uThick * ok;
      vec2 s = base + vec2(off.x / max(uAspect, 1e-4), off.y);
      /* FROST is the mip level. Every tap therefore reads an AREA AVERAGE, which
         is what keeps a wide dispersion smooth instead of confetti. */
      vec4 tex = fetchBox(s, frostLod);
      col += tex.rgb * w * ok;
      wsum += w;
      float lw = w.r + w.g + w.b;
      alpha += tex.a * lw * ok;
      asum += lw;
    }
    col /= wsum;
    alpha /= asum;

    /* Lighting ON the glass, not on the plate. */
    vec3 L = normalize(uLightDir);
    vec3 Hv = normalize(L + vec3(0.0, 0.0, 1.0));
    float sp = pow(max(dot(N, Hv), 0.0), uGloss) * uSpec;
    float fr = pow(1.0 - clamp(N.z, 0.0, 1.0), uSheenFall) * uSheen;

    vec3 outc = col;
    if (uTintAmt > 0.0) outc *= mix(vec3(1.0), uTint, uTintAmt);
    if (uAbsorb > 0.0) outc *= exp(-uAbsorb * h);
    if (uSeam > 0.0) outc *= 1.0 - uSeam * (1.0 - smoothstep(0.0, max(uSeamW, 0.0005), dE));

    /* The isolate is PREMULTIPLIED, so every additive term has to be scaled by
       the coverage it is being added to — otherwise sheen and specular paint
       light onto pixels the layer does not cover, and the glass grows a halo
       the shape of its own bounding box. */
    outc += uHighlight * sp * alpha;
    outc += mix(vec3(1.0), uHighlight, 0.5) * fr * alpha;

    /* Bloom: a high level of the same chain, screen blended. */
    if (uBloom > 0.0) {
      vec3 bl = fetchBox(base, max(uMaxLod - 1.5, 0.0)).rgb;
      outc = 1.0 - (1.0 - outc) * (1.0 - clamp(bl * uBloom, 0.0, 1.0));
      outc *= alpha;                       // stay premultiplied after the screen
    }

    outc *= exp2(uExposure);
    if (uGrain > 0.0) outc += (hash21(gl_FragCoord.xy + uTime * 91.7) - 0.5) * uGrain * alpha;

    vec4 res = vec4(max(outc, 0.0), alpha);
    gl_FragColor = uAmount >= 0.999 ? res : mix(fetchBox(b, 0.0), res, uAmount);
  }
`;

export function createPryzmPass() {
  const geometry = new THREE.BufferGeometry();
  // No overscan: Pryzm resamples the layer rather than displacing it past its
  // own bounds, exactly like Droste.
  const rest = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
  geometry.setAttribute('aRest', new THREE.BufferAttribute(rest, 2));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 2, 1, 0, 3, 2]), 1));

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,          // a mirrored layer flips the quad's winding
    blending: THREE.CustomBlending,  // the isolate is premultiplied
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: {
      uTexture: { value: null },
      uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
      uAxisX: { value: new THREE.Vector2(0.5, 0) },
      uAxisY: { value: new THREE.Vector2(0, 0.5) },
      uBoxPx: { value: new THREE.Vector2(1920, 1080) },
      uAspect: { value: 1 },
      uLatOrigin: { value: new THREE.Vector2(0.5, 0.5) },
      uCell: { value: 0.16 },
      uStretch: { value: 0.44 },
      uRot: { value: 0 },
      uWarpAmt: { value: 0.95 },
      uWarpScale: { value: 1.4 },
      uRelief: { value: 0.01 },
      uBevel: { value: 0.25 },
      uTilt: { value: 0.8 },
      uGroove: { value: 0 },
      uIor: { value: 2.06 },
      uThick: { value: 0.28 },
      uDisp: { value: 0.525 },
      uMagnify: { value: 1 },
      uFrost: { value: 0.105 },
      uLightDir: { value: new THREE.Vector3(0, 0, 1) },
      uHighlight: { value: new THREE.Vector3(1, 1, 1) },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uSpec: { value: 0.26 },
      uGloss: { value: 32 },
      uSheen: { value: 0.21 },
      uSheenFall: { value: 4.3 },
      uTintAmt: { value: 0.7 },
      uAbsorb: { value: 0 },
      uSeam: { value: 0.24 },
      uSeamW: { value: 0.005 },
      uBloom: { value: 0.1 },
      uGrain: { value: 0.04 },
      uExposure: { value: 0.04 },
      uAmount: { value: 1 },
      uTime: { value: 0 },
      uMaxLod: { value: 8 },
      uDriftT: { value: 0 },
      uFlowT: { value: 0 },
      uLat: { value: 0 },
      uProfile: { value: 0 },
      uWarpSrc: { value: 2 },
      uWarpAxis: { value: 1 },
      uSpectrum: { value: 1 },
      uTaps: { value: 21 },
      uEdge: { value: 3 },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return { scene, mesh, geometry, material };
}

export function applyPryzmUniforms(material, p, box, timeSec = 0) {
  const u = material.uniforms;
  u.uOrigin.value.set(box.origin[0], box.origin[1]);
  u.uAxisX.value.set(box.axisX[0], box.axisX[1]);
  u.uAxisY.value.set(box.axisY[0], box.axisY[1]);
  const boxW = Math.max(1, box.sizePx[0]);
  const boxH = Math.max(1, box.sizePx[1]);
  u.uBoxPx.value.set(boxW, boxH);
  const aspect = boxW / boxH;
  u.uAspect.value = aspect;

  u.uLatOrigin.value.set(p.pzOX / 100, p.pzOY / 100);
  u.uCell.value = Math.max(0.0005, p.pzCell / 100);
  u.uStretch.value = Math.max(0.02, p.pzStretch / 100);
  u.uRot.value = (p.pzRot * Math.PI) / 180;

  u.uWarpAmt.value = Math.max(0, p.pzWarpAmt / 100);
  u.uWarpScale.value = Math.max(0.02, p.pzWarpScale);
  u.uRelief.value = Math.max(0, p.pzRelief / 100);
  u.uBevel.value = Math.max(0.02, p.pzBevel / 100);
  u.uTilt.value = Math.max(0, p.pzTilt / 100);
  u.uGroove.value = Math.max(0, p.pzGroove / 200);

  u.uIor.value = Math.max(1, p.pzIor);
  // Thickness is in box-height units: 100% shifts the sample by 0.15 of the box
  // per unit of tan(theta), which puts the useful range in the middle of the slider.
  u.uThick.value = Math.max(0, (p.pzThick / 100) * 0.15);
  u.uDisp.value = Math.max(0, (p.pzDisp / 100) * 0.5);
  u.uMagnify.value = Math.max(0, Math.min(1, p.pzMagnify / 100));
  // Frost IS the mip level, as a fraction of the chain's depth.
  u.uFrost.value = Math.max(0, Math.min(1, p.pzFrost / 100));
  u.uMaxLod.value = Math.max(0, Math.floor(Math.log2(Math.max(2, Math.max(boxW, boxH)))));

  /* The light is authored as a POINT on the box (y down, like every other %
     position) and reaches the shader as a direction, so dragging it across the
     layer sweeps the highlight the way the lab's handle did. */
  const lx = (p.pzLightX / 100 - 0.5) * aspect;
  const ly = p.pzLightY / 100 - 0.5;
  const lz = Math.max(0.01, p.pzLightZ / 100);
  const ll = Math.hypot(lx, ly, lz) || 1;
  u.uLightDir.value.set(lx / ll, ly / ll, lz / ll);

  u.uSpec.value = Math.max(0, p.pzSpec / 100);
  u.uGloss.value = Math.max(1, p.pzGloss);
  u.uSheen.value = Math.max(0, p.pzSheen / 100);
  u.uSheenFall.value = Math.max(0.1, p.pzSheenFall);

  const hi = hexToRgb(p.pzHighlight);
  const tn = hexToRgb(p.pzTint);
  u.uHighlight.value.set(hi[0], hi[1], hi[2]);
  u.uTint.value.set(tn[0], tn[1], tn[2]);
  u.uTintAmt.value = Math.max(0, Math.min(1, p.pzTintAmt / 100));
  u.uAbsorb.value = Math.max(0, p.pzAbsorb / 50);
  u.uSeam.value = Math.max(0, Math.min(1, p.pzSeam / 100));
  u.uSeamW.value = Math.max(0.0005, p.pzSeamW / 200);
  u.uBloom.value = Math.max(0, p.pzBloom / 100);
  u.uGrain.value = Math.max(0, p.pzGrain / 300);
  u.uExposure.value = p.pzExposure / 100;
  u.uAmount.value = Math.max(0, Math.min(1, p.pzAmount / 100));

  const t = Number.isFinite(timeSec) ? timeSec : 0;
  u.uTime.value = t;
  u.uDriftT.value = (Number.isFinite(p.pzDrift) ? p.pzDrift : 0) * t;
  u.uFlowT.value = ((Number.isFinite(p.pzFlow) ? p.pzFlow : 0) / 100) * t;

  u.uLat.value = Math.max(0, Math.min(2, Math.round(p.pzGlass)));
  u.uProfile.value = Math.max(0, Math.min(6, Math.round(p.pzProfile)));
  u.uWarpSrc.value = Math.max(0, Math.min(2, Math.round(p.pzWarpSrc)));
  u.uWarpAxis.value = Math.round(p.pzWarpAxis) === 0 ? 0 : 1;
  u.uSpectrum.value = Math.round(p.pzSpectrum) === 0 ? 0 : 1;
  u.uTaps.value = pryzmTaps(p);
  u.uEdge.value = Math.max(0, Math.min(3, Math.round(p.pzEdge)));
}
