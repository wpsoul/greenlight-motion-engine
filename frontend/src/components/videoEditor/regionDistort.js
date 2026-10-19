import * as THREE from 'three';

/*
 * Region Distort — geometry layer effect (port of html/distort-lab.html).
 *
 * Rescales only what is inside a rectangular band; the rest of the layer slides but
 * keeps its shape. This is the "stretch the word, not the burger" tool. The map is an
 * INVERSE one — solved per fragment by bisecting a monotone density integral — so the
 * whole warp is a fragment pass over a single overscanned quad.
 *
 * Its sibling [bendLayer.js] is the other half of the same lab. They ship as two
 * separate effects rather than one id with a type selector: the two are unrelated maps
 * (this one inverse/fragment, Bend forward/vertex), they share no parameter, and a
 * layer that wants both should be able to have both — stacked, region first.
 *
 * Coordinate conventions (all three are load-bearing):
 *  - Authored params are PERCENT OF THE LAYER BOX, +y DOWN, like every other % field in
 *    the editor. The stored field, the keyframe value and the panel number are the same
 *    number (the layerMask.js rule) — a unit mismatch teleports geometry the instant it
 *    is keyed. The `ds` prefix is the distort family's, shared with nothing else.
 *  - The shader works in box uv `b` ∈ [0,1]², +y DOWN, so the lab's warp math ports
 *    verbatim with no sign flips to get wrong.
 *  - Sampling converts box uv → frame uv through the computeLayerBox affine, because the
 *    isolate is a FULL-FRAME target in which the layer occupies a sub-rect. Edge handling
 *    therefore happens in box units; texture wrap modes would wrap the whole frame.
 */

export const REGION_DISTORT_LAYER_EFFECT_ID = 'regionDistort';

/* The quad is overscanned past the layer box so a stretch can throw content outside the
   original bounds instead of being clipped at the box edge. */
const OVERSCAN = 0.6;          // in box-uv units on each side

export const DS_DEFAULTS = {
  dsRegX: 50,
  dsRegY: 19,
  dsRegW: 84,
  dsRegH: 28,
  dsScaleX: 100,
  dsScaleY: 155,
  dsFeather: 3,
  dsKeepSize: 0,
};

/* group drives the panel sectioning; kf marks a keyframable channel. */
export const DS_NUMBER_FIELDS = [
  { key: 'dsRegX', label: 'Region X', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'region' },
  { key: 'dsRegY', label: 'Region Y', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'region' },
  { key: 'dsRegW', label: 'Region width', min: 1, max: 200, step: 0.5, suffix: '%', kf: true, group: 'region' },
  { key: 'dsRegH', label: 'Region height', min: 1, max: 200, step: 0.5, suffix: '%', kf: true, group: 'region' },
  { key: 'dsScaleX', label: 'Stretch X', min: 10, max: 400, step: 1, suffix: '%', kf: true, group: 'amount' },
  { key: 'dsScaleY', label: 'Stretch Y', min: 10, max: 400, step: 1, suffix: '%', kf: true, group: 'amount' },
  { key: 'dsFeather', label: 'Feather', min: 0.2, max: 35, step: 0.2, suffix: '%', kf: true, group: 'amount' },
];

export const DS_ENUM_FIELDS = [
  {
    key: 'dsKeepSize',
    label: 'Keep original size',
    group: 'amount',
    options: [[0, 'Off — the layer grows'], [1, 'On — rescale back to fit']],
  },
];

export const DS_KF_KEYS = DS_NUMBER_FIELDS.filter((f) => f.kf).map((f) => f.key);

export const DS_PRESETS = [
  { name: 'Stretch a word', values: { dsRegX: 50, dsRegY: 19, dsRegW: 84, dsRegH: 28, dsScaleX: 100, dsScaleY: 155, dsFeather: 3, dsKeepSize: 0 } },
  { name: 'Squash band', values: { dsRegX: 50, dsRegY: 50, dsRegW: 90, dsRegH: 40, dsScaleX: 100, dsScaleY: 55, dsFeather: 6, dsKeepSize: 0 } },
  { name: 'Widen middle', values: { dsRegX: 50, dsRegY: 50, dsRegW: 40, dsRegH: 100, dsScaleX: 190, dsScaleY: 100, dsFeather: 8, dsKeepSize: 0 } },
];

export function getRegionDistortEffect(item) {
  const list = Array.isArray(item?.layerEffects) ? item.layerEffects : [];
  return list.find((effect) => effect?.id === REGION_DISTORT_LAYER_EFFECT_ID) || null;
}

/* The Player's collector predicate AND the per-channel exact bypass. A neutral stretch
   is a true no-op, but a keyframed channel can ramp away from neutral, so a track on
   either scale keeps the pass alive. */
export function isRegionDistortEnabled(item) {
  const effect = getRegionDistortEffect(item);
  if (!effect || effect.enabled === false) return false;
  const p = effect.params || {};
  const num = (key) => (Number.isFinite(p[key]) ? p[key] : DS_DEFAULTS[key]);
  const tracks = item?.propertyKeyframes || {};
  const keyed = (key) => Array.isArray(tracks[key]) && tracks[key].length > 0;
  if (Math.abs(num('dsScaleX') - 100) > 0.05 || Math.abs(num('dsScaleY') - 100) > 0.05) return true;
  return keyed('dsScaleX') || keyed('dsScaleY');
}

export function resolveRegionDistortParams(item, keyframeProps) {
  const effect = getRegionDistortEffect(item);
  const stored = effect?.params || {};
  const out = {};
  for (const [key, fallback] of Object.entries(DS_DEFAULTS)) {
    const keyed = keyframeProps?.[key];
    const value = Number.isFinite(keyed) ? keyed : stored[key];
    out[key] = Number.isFinite(value) ? value : fallback;
  }
  return out;
}

/* ── shader ─────────────────────────────────────────────────────────────── */

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

/* The quad carries no warp of its own — it exists only to cover the overscanned box so
   a stretch has somewhere to spill. `aRest` interpolates exactly across two triangles. */
const VERTEX = /* glsl */`
  precision highp float;
  attribute vec2 aRest;      // rest position in box uv (y down), overscanned past [0,1]
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
  uniform vec2 uP0;          // region min, box uv (y down)
  uniform vec2 uP1;          // region max, box uv (y down)
  uniform float uSX;         // stretch x
  uniform float uSY;         // stretch y
  uniform float uFeather;    // feather, box uv
  uniform int uKeep;         // rescale back to the original size
  varying vec2 vRest;
${COMMON}

  /* ── monotone density integral, inverted by bisection ── */
  float regG(float u) {
    if (u <= 0.0) return 0.0;
    if (u >= 1.0) return u - 0.5;
    return u * u * u - 0.5 * u * u * u * u;
  }
  float regF(float y, float a, float b, float w, float s) {
    return y + (s - 1.0) * w * (regG((y - (a - 0.5 * w)) / w) - regG((y - (b - 0.5 * w)) / w));
  }
  float regInv(float yo, float a0, float b0, float f, float s, bool keep) {
    float w = max(f, 0.0025) * 2.0;
    float a = max(a0, 0.5 * w), b = min(b0, 1.0 - 0.5 * w);
    if (b <= a + 1e-4) b = a + 1e-4;
    float target = keep ? yo * regF(1.0, a, b, w, s) : yo;
    float lo = -2.0, hi = 3.0;
    for (int i = 0; i < 26; i++) {
      float m = 0.5 * (lo + hi);
      if (regF(m, a, b, w, s) < target) lo = m; else hi = m;
    }
    return 0.5 * (lo + hi);
  }

  void main() {
    bool keep = uKeep == 1;
    vec2 src = vec2(regInv(vRest.x, uP0.x, uP1.x, uFeather, uSX, keep),
                    regInv(vRest.y, uP0.y, uP1.y, uFeather, uSY, keep));

    // Edge handling in BOX units — the isolate is frame sized, so a texture wrap mode
    // here would wrap the whole frame instead of the layer.
    vec2 w = fwidth(src) + 1e-5;
    vec2 m = smoothstep(vec2(0.0), w, src) * (1.0 - smoothstep(vec2(1.0) - w, vec2(1.0), src));
    float mask = m.x * m.y;
    if (mask <= 0.0) discard;

    gl_FragColor = texture2D(uTexture, boxToFrame(clamp(src, 0.0, 1.0))) * mask;
  }
`;

export function createRegionDistortPass() {
  const geometry = new THREE.BufferGeometry();
  const lo = -OVERSCAN, hi = 1 + OVERSCAN;
  const rest = new Float32Array([lo, lo, hi, lo, hi, hi, lo, hi]);
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
    extensions: { derivatives: true },
    blending: THREE.CustomBlending,  // the isolate is premultiplied
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: {
      uTexture: { value: null },
      uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
      uAxisX: { value: new THREE.Vector2(0.5, 0) },
      uAxisY: { value: new THREE.Vector2(0, 0.5) },
      uP0: { value: new THREE.Vector2(0.08, 0.05) },
      uP1: { value: new THREE.Vector2(0.92, 0.33) },
      uSX: { value: 1 },
      uSY: { value: 1.55 },
      uFeather: { value: 0.03 },
      uKeep: { value: 0 },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return { scene, mesh, geometry, material };
}

/* Panel/overlay helper: the region is authored as centre + size, the shader wants
   min/max. One conversion, used by both so a handle drag and the shader never disagree. */
export function regionDistortBounds(p) {
  const w = Math.max(0.01, (p.dsRegW ?? DS_DEFAULTS.dsRegW) / 100);
  const h = Math.max(0.01, (p.dsRegH ?? DS_DEFAULTS.dsRegH) / 100);
  const cx = (p.dsRegX ?? DS_DEFAULTS.dsRegX) / 100;
  const cy = (p.dsRegY ?? DS_DEFAULTS.dsRegY) / 100;
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
}

export function applyRegionDistortUniforms(material, p, box) {
  const u = material.uniforms;
  u.uOrigin.value.set(box.origin[0], box.origin[1]);
  u.uAxisX.value.set(box.axisX[0], box.axisX[1]);
  u.uAxisY.value.set(box.axisY[0], box.axisY[1]);
  const r = regionDistortBounds(p);
  u.uP0.value.set(r.x0, r.y0);
  u.uP1.value.set(r.x1, r.y1);
  u.uSX.value = Math.max(0.02, p.dsScaleX / 100);
  u.uSY.value = Math.max(0.02, p.dsScaleY / 100);
  u.uFeather.value = Math.max(0.002, p.dsFeather / 100);
  u.uKeep.value = p.dsKeepSize ? 1 : 0;
}
