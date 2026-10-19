/*
 * The compositor's camera depth-of-field pass.
 *
 * Extracted from Player.jsx so the port harness can import it. It used to be a
 * module-local function, which meant the only way to A/B it against its TSL twin
 * was to copy the shader source into the lab — and a copied shader drifts
 * silently the moment either side is edited. Nothing else about it changed.
 */
import * as THREE from 'three';

const DEFAULT_W = 1280;
const DEFAULT_H = 720;

const cameraDofVertexShader = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const cameraDofFragmentShader = /* glsl */ `
  precision highp float;
  precision highp int;
  in vec2 vUv;
  out vec4 fragColor;
  uniform sampler2D uTexture;
  uniform vec2 uResolution;
  uniform float uRadiusPx;
  uniform float uHighlightGain;
  uniform float uSamples;
  // Screen-space focus area: the frame stays sharp within uFocusInnerPx of the focus
  // point and reaches the layer's full CoC by uFocusOuterPx. uFocusOuterPx <= 0
  // disables it, leaving blur governed by the layer's depth alone.
  uniform vec2 uFocusPointPx;
  uniform float uFocusInnerPx;
  uniform float uFocusOuterPx;

  const float GOLDEN_ANGLE = 2.39996323;
  const float HIGHLIGHT_THRESHOLD = 0.72;

  /*
   * PCG-style integer bit-mix on the PIXEL INDEX — the twin of
   * tslStableHash.js, and bit-identical to it on both backends.
   *
   * This was a fract()-based hash. Measured, it differed between backends,
   * and a chaotic hash turns one ULP into a completely different spiral
   * rotation. The effect is DILUTED BY SAMPLE COUNT, which is what made it hard
   * to see: at 40 samples the difference averages down to mean 0.89, but at
   * ONE sample — two taps — it is mean 9.14. An earlier test that swapped only
   * the TSL side at default sample counts moved the numbers by under 1% and
   * looked like an exoneration; the sample-count sweep is what exposed it.
   *
   * Integer arithmetic is exact on both backends. gl_FragCoord.xy is already a
   * pixel centre (i + 0.5), so the truncation is nowhere near a boundary — the
   * input matters as much as the mix.
   */
  float hash12(vec2 p) {
    uint ix = uint(p.x);
    uint iy = uint(p.y);
    uint h = ix * 747796405u + iy * 2891336453u + 1u;
    uint w = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
    uint r = (w >> 22u) ^ w;
    return float(r & 0xffffffu) / 16777216.0;
  }

  vec2 mirrorUv(vec2 p) {
    vec2 m = mod(abs(p), 2.0);
    return mix(m, 2.0 - m, step(1.0, m));
  }

  vec4 boostedSample(vec2 uv) {
    vec4 s = texture(uTexture, mirrorUv(uv));
    if (s.a <= 0.00001 || uHighlightGain <= 0.00001) return s;
    vec3 straight = s.rgb / max(s.a, 0.00001);
    float luma = dot(straight, vec3(0.2126, 0.7152, 0.0722));
    float boost = 1.0 + max(0.0, luma - HIGHLIGHT_THRESHOLD) * uHighlightGain;
    return vec4(straight * boost * s.a, s.a);
  }

  // How much of this layer's circle of confusion survives at this pixel.
  float focusFalloff() {
    if (uFocusOuterPx <= 0.0) return 1.0;
    float d = distance(gl_FragCoord.xy, uFocusPointPx);
    return smoothstep(uFocusInnerPx, uFocusOuterPx, d);
  }

  void main() {
    // Per-pixel radius: the layer's depth CoC, held off inside the focus area.
    float radiusPx = uRadiusPx * focusFalloff();
    if (radiusPx < 0.25) {
      fragColor = texture(uTexture, vUv);
      return;
    }
    vec4 sum = boostedSample(vUv);
    float total = 1.0;
    float rotation = hash12(gl_FragCoord.xy) * 6.2831853;
    for (int i = 0; i < 40; i++) {
      if (float(i) >= uSamples) break;
      float fi = float(i) + 0.5;
      float radius = sqrt(fi / max(1.0, uSamples)) * radiusPx;
      float angle = fi * GOLDEN_ANGLE + rotation;
      vec2 offset = vec2(cos(angle), sin(angle)) * radius / uResolution;
      sum += boostedSample(vUv + offset);
      total += 1.0;
    }
    fragColor = sum / total;
  }
`;

export function createCameraDofMaterial() {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,   // the stable hash needs uint arithmetic
    vertexShader: cameraDofVertexShader,
    fragmentShader: cameraDofFragmentShader,
    uniforms: {
      uTexture: { value: null },
      uResolution: { value: new THREE.Vector2(DEFAULT_W, DEFAULT_H) },
      uRadiusPx: { value: 0 },
      uHighlightGain: { value: 0 },
      uSamples: { value: 40 },
      uFocusPointPx: { value: new THREE.Vector2(0, 0) },
      uFocusInnerPx: { value: 0 },
      uFocusOuterPx: { value: 0 },
    },
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}
