import * as THREE from 'three';

/*
 * Bend / Stretch Axis — geometry layer effect (port of html/distort-lab.html, AE's
 * CC Bend It).
 *
 * Everything outside the two axis handles stays rigid; the span between them bends
 * around an arc and can be stretched along its own axis. This is a FORWARD map, so it
 * displaces the vertices of a dense grid rather than resolving a source per fragment —
 * which is exactly why it is its own effect and not a mode of [regionDistort.js]
 * (an inverse/fragment warp). Nothing is shared but the coordinate conventions.
 *
 * Coordinate conventions (all three are load-bearing):
 *  - Authored params are PERCENT OF THE LAYER BOX, +y DOWN, like every other % field in
 *    the editor. The stored field, the keyframe value and the panel number are the same
 *    number (the layerMask.js rule) — a unit mismatch teleports geometry the instant it
 *    is keyed.
 *  - The shader works in box uv `b` ∈ [0,1]², +y DOWN, so the lab's warp math ports
 *    verbatim with no sign flips to get wrong.
 *  - Sampling converts box uv → frame uv through the computeLayerBox affine, because the
 *    isolate is a FULL-FRAME target in which the layer occupies a sub-rect. Edge handling
 *    therefore happens in box units; texture wrap modes would wrap the whole frame.
 */

export const BEND_LAYER_EFFECT_ID = 'bend';

/* The grid is overscanned past the layer box so a bend can throw content outside the
   original bounds instead of being clipped at the box edge. */
const OVERSCAN = 0.6;          // in box-uv units on each side
const GRID_SEGMENTS = 128;     // vertex-warp resolution

export const BN_DEFAULTS = {
  bnAX: 50,
  bnAY: 72,
  bnBX: 50,
  bnBY: 24,
  bnAngle: 45,
  bnStretch: 100,
};

/* group drives the panel sectioning; kf marks a keyframable channel. */
export const BN_NUMBER_FIELDS = [
  { key: 'bnAX', label: 'Start X', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'axis' },
  { key: 'bnAY', label: 'Start Y', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'axis' },
  { key: 'bnBX', label: 'End X', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'axis' },
  { key: 'bnBY', label: 'End Y', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'axis' },
  { key: 'bnAngle', label: 'Bend angle', min: -180, max: 180, step: 1, suffix: '°', kf: true, group: 'amount' },
  { key: 'bnStretch', label: 'Stretch span', min: 20, max: 300, step: 1, suffix: '%', kf: true, group: 'amount' },
];

export const BN_KF_KEYS = BN_NUMBER_FIELDS.filter((f) => f.kf).map((f) => f.key);

export const BN_PRESETS = [
  { name: 'Arc up', values: { bnAX: 50, bnAY: 72, bnBX: 50, bnBY: 24, bnAngle: 45, bnStretch: 100 } },
  { name: 'Flag lean', values: { bnAX: 12, bnAY: 50, bnBX: 88, bnBY: 50, bnAngle: -32, bnStretch: 115 } },
];

export function getBendEffect(item) {
  const list = Array.isArray(item?.layerEffects) ? item.layerEffects : [];
  return list.find((effect) => effect?.id === BEND_LAYER_EFFECT_ID) || null;
}

/* The Player's collector predicate AND the per-channel exact bypass. A straight axis at
   rest length is a true no-op, but a keyframed channel can ramp away from neutral, so a
   track on either shaping channel keeps the pass alive. */
export function isBendEnabled(item) {
  const effect = getBendEffect(item);
  if (!effect || effect.enabled === false) return false;
  const p = effect.params || {};
  const num = (key) => (Number.isFinite(p[key]) ? p[key] : BN_DEFAULTS[key]);
  const tracks = item?.propertyKeyframes || {};
  const keyed = (key) => Array.isArray(tracks[key]) && tracks[key].length > 0;
  if (Math.abs(num('bnAngle')) > 0.05 || Math.abs(num('bnStretch') - 100) > 0.05) return true;
  return keyed('bnAngle') || keyed('bnStretch');
}

export function resolveBendParams(item, keyframeProps) {
  const effect = getBendEffect(item);
  const stored = effect?.params || {};
  const out = {};
  for (const [key, fallback] of Object.entries(BN_DEFAULTS)) {
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

/* The arc lives in the vertex stage; the fragment only samples at rest and trims the
   overscan, so the two shaders share nothing but boxToFrame. */
const VERTEX = /* glsl */`
  precision highp float;
  attribute vec2 aRest;      // rest position in box uv (y down), overscanned past [0,1]
  varying vec2 vRest;
  uniform float uAspect;     // box px width / height
  uniform vec2 uP0;          // handle A, box uv (y down)
  uniform vec2 uP1;          // handle B, box uv (y down)
  uniform float uAngle;      // bend angle, radians
  uniform float uStretch;    // span stretch
${COMMON}

  vec2 A2() { return vec2(uAspect, 1.0); }
  vec2 rot2(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }

  /* rigid outside the span, arc + stretch inside */
  vec2 wBend(vec2 b) {
    vec2 A = uP0 * A2(), B = uP1 * A2(), P = b * A2();
    vec2 ab = B - A;
    float L = length(ab);
    if (L < 1e-5) return b;
    vec2 d = ab / L, n = vec2(-d.y, d.x);
    float u = dot(P - A, d), v = dot(P - A, n);
    float st = max(uStretch, 0.02);
    float LL = L * st;
    float uu = (u < 0.0) ? u : (u > L ? LL + (u - L) : u * st);
    float ang = uAngle;
    vec2 outP;
    if (abs(ang) < 1e-4) {
      outP = A + d * uu + n * v;
    } else {
      float R = LL / ang;
      vec2 C = A + n * R;
      float uc = clamp(uu, 0.0, LL);
      float th = uc / R;
      outP = C + rot2(-n * (R - v), th);
      if (uu > LL) outP += rot2(d, ang) * (uu - LL);
      else if (uu < 0.0) outP += d * uu;
    }
    return outP / A2();
  }

  void main() {
    vRest = aRest;
    gl_Position = vec4(boxToFrame(wBend(aRest)) * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const FRAGMENT = /* glsl */`
  precision highp float;
  uniform sampler2D uTexture;
  varying vec2 vRest;
${COMMON}
  void main() {
    // Edge handling in BOX units — the isolate is frame sized, so a texture wrap mode
    // here would wrap the whole frame instead of the layer.
    vec2 w = fwidth(vRest) + 1e-5;
    vec2 m = smoothstep(vec2(0.0), w, vRest) * (1.0 - smoothstep(vec2(1.0) - w, vec2(1.0), vRest));
    float mask = m.x * m.y;
    if (mask <= 0.0) discard;

    gl_FragColor = texture2D(uTexture, boxToFrame(clamp(vRest, 0.0, 1.0))) * mask;
  }
`;

export function createBendPass() {
  const geometry = new THREE.BufferGeometry();
  const seg = GRID_SEGMENTS;
  const verts = (seg + 1) * (seg + 1);
  const position = new Float32Array(verts * 3);
  const rest = new Float32Array(verts * 2);
  const lo = -OVERSCAN, span = 1 + OVERSCAN * 2;
  for (let j = 0; j <= seg; j++) {
    for (let i = 0; i <= seg; i++) {
      const k = j * (seg + 1) + i;
      rest[k * 2] = lo + (i / seg) * span;
      rest[k * 2 + 1] = lo + (j / seg) * span;
    }
  }
  const index = new Uint32Array(seg * seg * 6);
  let t = 0;
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
      index[t++] = a; index[t++] = c; index[t++] = b;
      index[t++] = b; index[t++] = c; index[t++] = d;
    }
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aRest', new THREE.BufferAttribute(rest, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,          // a bend past 180° flips winding
    extensions: { derivatives: true },
    blending: THREE.CustomBlending,  // the isolate is premultiplied
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: {
      uTexture: { value: null },
      uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
      uAxisX: { value: new THREE.Vector2(0.5, 0) },
      uAxisY: { value: new THREE.Vector2(0, 0.5) },
      uAspect: { value: 1 },
      uP0: { value: new THREE.Vector2(0.5, 0.72) },
      uP1: { value: new THREE.Vector2(0.5, 0.24) },
      uAngle: { value: 0 },
      uStretch: { value: 1 },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return { scene, mesh, geometry, material };
}

export function applyBendUniforms(material, p, box) {
  const u = material.uniforms;
  u.uOrigin.value.set(box.origin[0], box.origin[1]);
  u.uAxisX.value.set(box.axisX[0], box.axisX[1]);
  u.uAxisY.value.set(box.axisY[0], box.axisY[1]);
  u.uAspect.value = Math.max(1e-4, box.sizePx[0] / Math.max(1e-4, box.sizePx[1]));
  u.uP0.value.set(p.bnAX / 100, p.bnAY / 100);
  u.uP1.value.set(p.bnBX / 100, p.bnBY / 100);
  u.uAngle.value = (p.bnAngle * Math.PI) / 180;
  u.uStretch.value = Math.max(0.02, p.bnStretch / 100);
}
