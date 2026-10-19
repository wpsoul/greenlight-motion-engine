import * as THREE from 'three';

/*
 * Corner Pin — geometry layer effect (port of html/distort-lab.html, AE's Corner Pin).
 *
 * The layer box mapped onto an arbitrary quad through a projective homography, so
 * parallel edges converge like a plane seen at an angle instead of stretching evenly.
 * That perspective is the whole point of the effect, and it is why this is an INVERSE
 * map resolved per fragment rather than a forward vertex warp like [bendLayer.js]: a
 * forward warp interpolates affinely inside each triangle, which flattens exactly the
 * convergence the effect exists to produce. Being a fragment warp it shares its cheap
 * single-quad geometry with [regionDistort.js], and nothing else.
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

export const CORNER_PIN_LAYER_EFFECT_ID = 'cornerPin';

/* The quad is overscanned past the layer box so a pinned corner can sit outside the
   original bounds instead of being clipped at the box edge. Corner fields are clamped to
   the same ±50% this leaves room for. */
const OVERSCAN = 0.6;          // in box-uv units on each side

export const CP_DEFAULTS = {
  cpULX: 12,
  cpULY: 6,
  cpURX: 88,
  cpURY: 6,
  cpLRX: 100,
  cpLRY: 94,
  cpLLX: 0,
  cpLLY: 94,
};

/* The pose at which the pin is a no-op, in the same units as the fields. Anything that
   needs "is this doing nothing" compares against this rather than CP_DEFAULTS, which
   deliberately leans the top edge back so a freshly added effect shows what it does. */
export const CP_IDENTITY = {
  cpULX: 0, cpULY: 0, cpURX: 100, cpURY: 0, cpLRX: 100, cpLRY: 100, cpLLX: 0, cpLLY: 100,
};

/* The four draggable points, in the winding the homography expects (UL → UR → LR → LL).
   The on-canvas control iterates this instead of hard-coding key names, so a handle and
   its panel row can never disagree about which corner they edit. */
export const CP_CORNER_POINTS = [
  { id: 'ul', label: 'UL', xKey: 'cpULX', yKey: 'cpULY' },
  { id: 'ur', label: 'UR', xKey: 'cpURX', yKey: 'cpURY' },
  { id: 'lr', label: 'LR', xKey: 'cpLRX', yKey: 'cpLRY' },
  { id: 'll', label: 'LL', xKey: 'cpLLX', yKey: 'cpLLY' },
];

/* group drives the panel sectioning; kf marks a keyframable channel. Every corner is
   keyframable — that is how a pin tracks a moving surface. */
export const CP_NUMBER_FIELDS = [
  { key: 'cpULX', label: 'Upper Left X', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'top' },
  { key: 'cpULY', label: 'Upper Left Y', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'top' },
  { key: 'cpURX', label: 'Upper Right X', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'top' },
  { key: 'cpURY', label: 'Upper Right Y', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'top' },
  { key: 'cpLRX', label: 'Lower Right X', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'bottom' },
  { key: 'cpLRY', label: 'Lower Right Y', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'bottom' },
  { key: 'cpLLX', label: 'Lower Left X', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'bottom' },
  { key: 'cpLLY', label: 'Lower Left Y', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'bottom' },
];

export const CP_KF_KEYS = CP_NUMBER_FIELDS.filter((f) => f.kf).map((f) => f.key);

export const CP_PRESETS = [
  { name: 'Lean back', values: { ...CP_DEFAULTS } },
  { name: 'Screen right', values: { cpULX: 8, cpULY: 16, cpURX: 74, cpURY: 2, cpLRX: 74, cpLRY: 98, cpLLX: 8, cpLLY: 84 } },
  { name: 'Screen left', values: { cpULX: 26, cpULY: 2, cpURX: 92, cpURY: 16, cpLRX: 92, cpLRY: 84, cpLLX: 26, cpLLY: 98 } },
  { name: 'Floor plane', values: { cpULX: 34, cpULY: 42, cpURX: 66, cpURY: 42, cpLRX: 128, cpLRY: 100, cpLLX: -28, cpLLY: 100 } },
  { name: 'Reset corners', values: { ...CP_IDENTITY } },
];

export function getCornerPinEffect(item) {
  const list = Array.isArray(item?.layerEffects) ? item.layerEffects : [];
  return list.find((effect) => effect?.id === CORNER_PIN_LAYER_EFFECT_ID) || null;
}

/* The Player's collector predicate AND the per-channel exact bypass. An identity quad is
   a true no-op, but a keyframed corner can ramp away from it, so a track on any corner
   channel keeps the pass alive. */
export function isCornerPinEnabled(item) {
  const effect = getCornerPinEffect(item);
  if (!effect || effect.enabled === false) return false;
  const p = effect.params || {};
  const num = (key) => (Number.isFinite(p[key]) ? p[key] : CP_DEFAULTS[key]);
  const tracks = item?.propertyKeyframes || {};
  const keyed = (key) => Array.isArray(tracks[key]) && tracks[key].length > 0;
  for (const [key, rest] of Object.entries(CP_IDENTITY)) {
    if (Math.abs(num(key) - rest) > 0.05 || keyed(key)) return true;
  }
  return false;
}

export function resolveCornerPinParams(item, keyframeProps) {
  const effect = getCornerPinEffect(item);
  const stored = effect?.params || {};
  const out = {};
  for (const [key, fallback] of Object.entries(CP_DEFAULTS)) {
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
  uniform vec2 uBoxPx;       // layer box size in plate pixels — the AA footprint
  uniform vec2 uP0;          // upper left, box uv (y down)
  uniform vec2 uP1;          // upper right
  uniform vec2 uP2;          // lower right
  uniform vec2 uP3;          // lower left
  varying vec2 vRest;
${COMMON}

  /* Rows of the inverse homography, evaluated at q. They arrive already divided by the
     determinant, so w's sign is meaningful. */
  vec2 cpMap(vec3 r0, vec3 r1, vec3 r2, vec2 q) {
    vec3 hq = vec3(q, 1.0);
    float w = dot(r2, hq);
    return vec2(dot(r0, hq), dot(r1, hq)) / (abs(w) < 1e-6 ? 1e-6 : w);
  }

  void main() {
    // Unit square → quad, closed form: the diagonal defect gives the two projective
    // denominators g/h, the rest is affine.
    float dx1 = uP1.x - uP2.x, dx2 = uP3.x - uP2.x, dx3 = uP0.x - uP1.x + uP2.x - uP3.x;
    float dy1 = uP1.y - uP2.y, dy2 = uP3.y - uP2.y, dy3 = uP0.y - uP1.y + uP2.y - uP3.y;
    float den = dx1 * dy2 - dy1 * dx2;
    if (abs(den) < 1e-9) discard;                    // three corners collinear
    float g = (dx3 * dy2 - dy3 * dx2) / den;
    float h = (dx1 * dy3 - dy1 * dx3) / den;
    vec3 cA = vec3(uP1.x - uP0.x + g * uP1.x, uP1.y - uP0.y + g * uP1.y, g);
    vec3 cB = vec3(uP3.x - uP0.x + h * uP3.x, uP3.y - uP0.y + h * uP3.y, h);
    vec3 cC = vec3(uP0.x, uP0.y, 1.0);
    // The rows of the inverse are the cross products of the forward matrix's columns —
    // GLSL ES 1.00 has no transpose(), and this needs no matrix built either way.
    vec3 r0 = cross(cB, cC), r1 = cross(cC, cA), r2 = cross(cA, cB);
    float det = dot(cA, r0);
    if (abs(det) < 1e-9) discard;
    r0 /= det; r1 /= det; r2 /= det;

    vec3 hq = vec3(vRest, 1.0);
    float w = dot(r2, hq);
    if (w <= 1e-6) discard;                          // past the projective horizon
    vec2 src = vec2(dot(r0, hq), dot(r1, hq)) / w;

    // Antialias the pinned edge by measuring the fragment's real footprint in source
    // space (two extra evaluations) rather than relying on shader derivatives, which
    // fwidth() would take across the overscanned quad. The ramp STRADDLES the boundary
    // instead of sitting inside it, so an untilted pin keeps its outermost pixel row at
    // full strength and identity corners stay a bit-exact bypass. Edge handling is in
    // BOX units — the isolate is frame sized, so a texture wrap would wrap the frame.
    vec2 stepPx = 1.0 / max(uBoxPx, vec2(1.0));
    vec2 fw = abs(cpMap(r0, r1, r2, vRest + vec2(stepPx.x, 0.0)) - src)
            + abs(cpMap(r0, r1, r2, vRest + vec2(0.0, stepPx.y)) - src) + 1e-6;
    vec2 hw = fw * 0.5;
    vec2 m = smoothstep(-hw, hw, src) * (vec2(1.0) - smoothstep(vec2(1.0) - hw, vec2(1.0) + hw, src));
    float mask = m.x * m.y;
    if (mask <= 0.0) discard;

    gl_FragColor = texture2D(uTexture, boxToFrame(clamp(src, 0.0, 1.0))) * mask;
  }
`;

export function createCornerPinPass() {
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
      uBoxPx: { value: new THREE.Vector2(1920, 1080) },
      uP0: { value: new THREE.Vector2(0.12, 0.06) },
      uP1: { value: new THREE.Vector2(0.88, 0.06) },
      uP2: { value: new THREE.Vector2(1, 0.94) },
      uP3: { value: new THREE.Vector2(0, 0.94) },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return { scene, mesh, geometry, material };
}

export function applyCornerPinUniforms(material, p, box) {
  const u = material.uniforms;
  u.uOrigin.value.set(box.origin[0], box.origin[1]);
  u.uAxisX.value.set(box.axisX[0], box.axisX[1]);
  u.uAxisY.value.set(box.axisY[0], box.axisY[1]);
  u.uBoxPx.value.set(Math.max(1, box.sizePx[0]), Math.max(1, box.sizePx[1]));
  u.uP0.value.set(p.cpULX / 100, p.cpULY / 100);
  u.uP1.value.set(p.cpURX / 100, p.cpURY / 100);
  u.uP2.value.set(p.cpLRX / 100, p.cpLRY / 100);
  u.uP3.value.set(p.cpLLX / 100, p.cpLLY / 100);
}
