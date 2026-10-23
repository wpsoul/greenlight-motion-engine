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

// Shared by the layer pass and the depth-aware pass below: one hash, one tap, one
// focus area, so the two can never drift apart.
const DOF_COMMON_GLSL = /* glsl */ `
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

  // Taps read the source PREFILTERED when it has mips (uMipOn): at the level of
  // the spacing between taps. A wide gather of thin bright detail — strokes far
  // behind the focus — otherwise lands on a stroke in one pixel and beside it in
  // the next (the rotation is per pixel), which reads as salt noise.
  float tapLod(float spacingPx) {
    return uMipOn > 0.5 ? log2(max(1.0, spacingPx)) : 0.0;
  }

  vec4 boostedSample(vec2 uv, float lod) {
    vec4 s = textureLod(uTexture, mirrorUv(uv), lod);
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
  uniform float uMipOn;
  // Screen-space focus area: the frame stays sharp within uFocusInnerPx of the focus
  // point and reaches the layer's full CoC by uFocusOuterPx. uFocusOuterPx <= 0
  // disables it, leaving blur governed by the layer's depth alone.
  uniform vec2 uFocusPointPx;
  uniform float uFocusInnerPx;
  uniform float uFocusOuterPx;
${DOF_COMMON_GLSL}  void main() {
    // Per-pixel radius: the layer's depth CoC, held off inside the focus area.
    float radiusPx = uRadiusPx * focusFalloff();
    if (radiusPx < 0.25) {
      fragColor = texture(uTexture, vUv);
      return;
    }
    float lod = tapLod(radiusPx * 1.4 / sqrt(max(1.0, uSamples)));
    vec4 sum = boostedSample(vUv, lod);
    float total = 1.0;
    float rotation = hash12(gl_FragCoord.xy) * 6.2831853;
    for (int i = 0; i < 40; i++) {
      if (float(i) >= uSamples) break;
      float fi = float(i) + 0.5;
      float radius = sqrt(fi / max(1.0, uSamples)) * radiusPx;
      float angle = fi * GOLDEN_ANGLE + rotation;
      vec2 offset = vec2(cos(angle), sin(angle)) * radius / uResolution;
      sum += boostedSample(vUv + offset, lod);
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
      uMipOn: { value: 0 },
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

/*
 * Depth-aware DOF for a camera-baked 3D pass (a model, a cyclorama): every pixel
 * blurs by its OWN circle of confusion, read from the pass's depth buffer, rather
 * than the whole pass by its bounding-box centre. modelDof.js computes the inputs;
 * cocOf() below must stay modelDof.cocAtDistance().
 *
 * Two gathers, both scatter-as-gather — a tap only lands on this pixel if ITS blur
 * reaches this far:
 *
 *   1. Own disk (radius = this pixel's CoC). A tap BEHIND this pixel may blur no
 *      further over it than this pixel blurs itself, so a defocused background
 *      never smears across an in-focus foreground edge; a sharp tap is too small
 *      to reach, so a sharp foreground never haloes onto the blurred background
 *      around it. On a pass of uniform depth every tap counts, exactly the layer
 *      pass's kernel.
 *   2. Foreground reach (radius = uSpreadPx, outside the own disk), only when part
 *      of the pass sits in front of the focus plane: a NEARER surface whose blur
 *      is wider than this pixel's covers it from outside — a blurred foreground
 *      edge spreads over the sharp set behind it, and past the silhouette. Each
 *      tap stands for its ring's area and covers this pixel by 1/(π·CoC²), so the
 *      sum is the covered fraction; the foreground colour goes over the own
 *      result by that much.
 *
 * Empty pixels (the cleared far plane): as a tap they stand at the centre's
 * depth, so a surface's alpha edge blurs into transparency as in the layer pass —
 * read UNFILTERED, or the prefilter would carry the colour of the surfaces around
 * them into it. As the centre they lie behind everything and have nothing of their
 * own to blur: they only receive what blurred surfaces scatter onto them, through
 * the reach gather out to uReachPx (the largest CoC in the pass). Gathering them
 * over a disk of the pass's centre CoC instead found a thin stroke's blur with a
 * handful of taps — salt noise around blurred letters.
 */
const cameraDofDepthFragmentShader = /* glsl */ `
  precision highp float;
  precision highp int;
  in vec2 vUv;
  out vec4 fragColor;
  uniform sampler2D uTexture;
  uniform sampler2D uDepth;
  uniform vec2 uResolution;
  uniform float uHighlightGain;
  uniform float uSamples;
  uniform float uSpreadSamples;
  uniform float uMipOn;
  uniform vec2 uFocusPointPx;
  uniform float uFocusInnerPx;
  uniform float uFocusOuterPx;
  uniform float uNear;
  uniform float uFar;
  uniform float uFocusDistance;
  uniform float uCocScale;
  uniform float uMaxCocPx;
  uniform float uReachPx;
  uniform float uSpreadPx;
  uniform vec2 uDepthTexel;
${DOF_COMMON_GLSL}  // View distance at a uv, or -1 where the pass drew nothing.
  float viewDistanceAt(vec2 uv) {
    float d = texture(uDepth, uv).r;
    if (d >= 0.999999) return -1.0;
    return uNear * uFar / (uFar - d * (uFar - uNear));
  }

  float cocOf(float dist) {
    return min(uMaxCocPx, uCocScale * abs(uFocusDistance - dist) / max(dist, 1.0));
  }

  void main() {
    float falloff = focusFalloff();
    float centerRaw = viewDistanceAt(vUv);
    // An antialiased silhouette edge: the depth resolve kept one sample (none of
    // the surface), the colour kept its coverage. It belongs to the surface beside it.
    if (centerRaw < 0.0 && texture(uTexture, vUv).a > 0.004) {
      centerRaw = max(
        max(viewDistanceAt(vUv + vec2(uDepthTexel.x, 0.0)), viewDistanceAt(vUv - vec2(uDepthTexel.x, 0.0))),
        max(viewDistanceAt(vUv + vec2(0.0, uDepthTexel.y)), viewDistanceAt(vUv - vec2(0.0, uDepthTexel.y))));
    }
    bool centerEmpty = centerRaw < 0.0;
    float centerDist = centerEmpty ? 1e30 : centerRaw;
    float cc = centerEmpty ? 0.0 : cocOf(centerRaw) * falloff;
    float spread = (centerEmpty ? uReachPx : uSpreadPx) * falloff;
    if (cc < 0.25 && spread < 0.25) {
      fragColor = texture(uTexture, vUv);
      return;
    }
    float rotation = hash12(gl_FragCoord.xy) * 6.2831853;

    float lodOwn = tapLod(cc * 1.4 / sqrt(max(1.0, uSamples)));
    vec4 sum = boostedSample(vUv, lodOwn);
    float total = 1.0;
    if (cc >= 0.25) {
      for (int i = 0; i < 40; i++) {
        if (float(i) >= uSamples) break;
        float fi = float(i) + 0.5;
        float radius = sqrt(fi / max(1.0, uSamples)) * cc;
        float angle = fi * GOLDEN_ANGLE + rotation;
        vec2 tapUv = vUv + vec2(cos(angle), sin(angle)) * radius / uResolution;
        float tapRaw = viewDistanceAt(mirrorUv(tapUv));
        float tapCoc = tapRaw < 0.0 ? cc : cocOf(tapRaw) * falloff;
        if (tapRaw > centerDist) tapCoc = min(tapCoc, cc);
        float w = smoothstep(radius - 1.0, radius, tapCoc);
        sum += boostedSample(tapUv, tapRaw < 0.0 ? 0.0 : lodOwn) * w;
        total += w;
      }
    }
    vec4 own = sum / total;

    if (spread > cc + 0.25) {
      vec4 fg = vec4(0.0);
      float cover = 0.0;
      float n = max(1.0, uSpreadSamples);
      float span = spread - cc;
      float lodSpread = tapLod(span / n * 1.4);
      for (int j = 0; j < 20; j++) {
        if (float(j) >= uSpreadSamples) break;
        float fj = float(j) + 0.5;
        // Evenly spaced radii outside the own disk: as many taps near this pixel as
        // far from it, so a narrow foreground blur is found as reliably as a wide one.
        float radius = cc + span * fj / n;
        float angle = fj * GOLDEN_ANGLE + rotation + 1.0;
        vec2 tapUv = vUv + vec2(cos(angle), sin(angle)) * radius / uResolution;
        float tapRaw = viewDistanceAt(mirrorUv(tapUv));
        float tapCoc = cocOf(tapRaw) * falloff;
        float w = (tapRaw >= 0.0 && tapRaw < centerDist && tapCoc >= 2.0) ? smoothstep(radius - 1.0, radius, tapCoc) : 0.0;
        // This tap's ring (2*pi*r*span/n of area) over its blur disk (pi*CoC^2),
        // capped so one tap can never decide the pixel alone.
        float c = min(0.5, w * 2.0 * radius * span / (n * max(tapCoc * tapCoc, 1.0)));
        fg += boostedSample(tapUv, lodSpread) * c;
        cover += c;
      }
      if (cover > 0.0) {
        fragColor = mix(own, fg / cover, min(cover, 1.0));
        return;
      }
    }
    fragColor = own;
  }
`;

export function createCameraDofDepthMaterial() {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: cameraDofVertexShader,
    fragmentShader: cameraDofDepthFragmentShader,
    uniforms: {
      uTexture: { value: null },
      uDepth: { value: null },
      uResolution: { value: new THREE.Vector2(DEFAULT_W, DEFAULT_H) },
      uHighlightGain: { value: 0 },
      uSamples: { value: 40 },
      uSpreadSamples: { value: 20 },
      uMipOn: { value: 0 },
      uFocusPointPx: { value: new THREE.Vector2(0, 0) },
      uFocusInnerPx: { value: 0 },
      uFocusOuterPx: { value: 0 },
      uNear: { value: 1 },
      uFar: { value: 1000 },
      uFocusDistance: { value: 1000 },
      uCocScale: { value: 0 },
      uMaxCocPx: { value: 64 },
      uReachPx: { value: 0 },
      uSpreadPx: { value: 0 },
      uDepthTexel: { value: new THREE.Vector2(1 / DEFAULT_W, 1 / DEFAULT_H) },
    },
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}
