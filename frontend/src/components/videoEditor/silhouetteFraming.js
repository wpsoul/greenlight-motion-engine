/*
 * Silhouette framing — BORDER and SHADOWS that follow a keyed layer's real
 * outline instead of its rectangle.
 *
 * On a media layer (video / image) the clip shader draws the BORDER ring and the
 * SHADOWS list around the layer's box (`hasFraming` in clipShader.js). With a
 * Chroma Key on the layer that box is the green screen, not the subject: the
 * shadow fell under the quad and the ring outlined the quad, and both stayed
 * there after the key had cut the plate down to the person. This pass draws
 * them AFTER the key, from the keyed alpha, so they hug the silhouette.
 *
 * Three fullscreen passes over the isolate (the compositor's rt.c, or the
 * pre-transition bank's source):
 *
 *   DIST H  — per row: how far, in texels, to the nearest pixel of the OTHER
 *             class (inside ↔ outside, thresholded at half the layer's alpha).
 *   DIST V  — per column: min over rows of sqrt(dy² + h²). That is the exact
 *             Euclidean distance transform within the search range, both ways:
 *             R = distance to the nearest INSIDE pixel (an outside pixel's
 *             distance to the silhouette), G = distance to the nearest OUTSIDE
 *             pixel (an inside pixel's depth), B = the pixel's own class.
 *   COMPOSE — the clip shader's framing block, verbatim in spirit, with the
 *             rounded-rect SDF replaced by (dOut − dIn): the ring is the band
 *             0 < sd < width OUTSIDE the silhouette (a sticker outline, which is
 *             what a keyed subject wants; the rect version's inside ring would
 *             eat into the person), outward shadows are the SDF shifted by the
 *             offset, grown by the spread and softened over ±blur, inset shadows
 *             the inverse clipped to the coverage. CSS order: the first shadow
 *             is on top.
 *
 * Distances are in TEXELS of the isolate; the driver converts the authored
 * composition px through `pxScale` (isolate width / composition width × the
 * layer's own scale, so a keyed clip scaled to 50 % keeps the shadow size it had
 * as a rectangle). The search range is only what the look needs — border width
 * plus the widest (spread + blur) — and is capped; the loop takes every texel up
 * to SF_FINE and then strides, so a 200-texel reach still costs ≤ SF_MAX_TAPS
 * fetches per pass and per pixel. The offset itself needs NO range: the shadow
 * at p reads the field at p − offset, whose distance is measured there.
 *
 * Dashed and dotted borders need an arc length along the contour, which a
 * distance field does not have — both draw solid here; double keeps its two
 * thirds. Corner radius stays on the clip shader: it clips the plate's
 * rectangle, which is a different thing from framing the silhouette.
 *
 * Distances are stored as 8-bit fractions of the range (1/255 · R, ≤ 1 texel at
 * the cap) so the pooled UnsignedByte targets serve, on both backends.
 *
 * TSL twin: silhouetteFramingNodes.js — same uniform surface, driven by the same
 * applySilhouetteFramingUniforms.
 */
import * as THREE from 'three';
import { getItemShadows, parseCssColor } from './clipShader.js';
import { borderCanShow } from './borderKeyframes.js';

/** Every texel is visited up to this distance… */
export const SF_FINE = 32;
/** …then the loop strides so the total never exceeds this many taps per side. */
export const SF_MAX_TAPS = 96;
/** Hard cap on the search range, in isolate texels. */
export const SF_MAX_RANGE = 256;

const nonZeroShadow = (s) => {
  const blur = Number.isFinite(s?.blur) ? s.blur : 0;
  const spread = Number.isFinite(s?.spread) ? s.spread : 0;
  const x = Number.isFinite(s?.x) ? s.x : 0;
  const y = Number.isFinite(s?.y) ? s.y : 0;
  return blur > 0.01 || Math.abs(spread) > 0.01 || Math.abs(x) > 0.01 || Math.abs(y) > 0.01;
};

/** The item's border width in composition px, 0 when the style is 'none'. */
export function itemBorderWidth(item) {
  if (item?.borderStyle === 'none') return 0;
  const w = Number.isFinite(item?.borderWidth) ? item.borderWidth : 0;
  return Math.max(0, w);
}

/** Does this item carry any framing the silhouette pass would draw? */
export function hasSilhouetteFraming(item) {
  if (itemBorderWidth(item) > 0.25 || borderCanShow(item)) return true;
  return getItemShadows(item).some(nonZeroShadow);
}

/**
 * Resolve the pass's geometry from the item and the texel scale. Returns null
 * when there is nothing to draw (the caller bypasses exactly).
 *   range   — search radius in texels
 *   fine    — taps at stride 1
 *   step    — stride beyond `fine`
 *   count   — loop iterations (≤ SF_MAX_TAPS)
 */
export function silhouetteFramingSpec(item, pxScale = 1) {
  const border = itemBorderWidth(item) * pxScale;
  const shadows = getItemShadows(item).filter(nonZeroShadow).slice(0, 4);
  if (!(border > 0.25) && shadows.length === 0) return null;
  let reach = border;
  for (const s of shadows) {
    const spread = Math.abs(Number.isFinite(s.spread) ? s.spread : 0) * pxScale;
    const blur = Math.max(0, Number.isFinite(s.blur) ? s.blur : 0) * pxScale;
    // The soft band is ±blur around the (grown) edge, and an outward shadow is
    // cast by the silhouette PLUS its ring.
    reach = Math.max(reach, spread + Math.max(blur, 1) + (s.inset ? 0 : border));
  }
  const range = Math.min(SF_MAX_RANGE, Math.ceil(reach + 3));
  const fine = Math.min(range, SF_FINE);
  const rest = range - fine;
  const step = rest > 0 ? Math.max(1, Math.ceil(rest / (SF_MAX_TAPS - fine))) : 1;
  const count = fine + (rest > 0 ? Math.ceil(rest / step) : 0);
  return { range, fine, step, count, border, shadows };
}

/* ── shaders ─────────────────────────────────────────────────────────────── */

const SF_VERTEX = /* glsl */`
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const SF_COMMON = /* glsl */`
  precision highp float;
  uniform vec2 uResolution;
  uniform vec2 uTexel;
  uniform float uRange;
  const int SF_MAX = ${SF_MAX_TAPS};
`;

// Tap i → distance in texels: 1..uFine at stride 1, then uFine + k·uStep.
const SF_TAP = /* glsl */`
  uniform float uFine;
  uniform float uStep;
  uniform float uCount;
  float tapDistance(int i) {
    float fi = float(i);
    return fi < uFine ? fi + 1.0 : uFine + (fi - uFine + 1.0) * uStep;
  }
`;

/* DIST H — reads the plate (camera-axis aware), writes per-row distances. */
const SF_DIST_H_FRAGMENT = SF_COMMON + SF_TAP + /* glsl */`
  uniform sampler2D uTexture;
  uniform float uFlipV;
  uniform float uAlphaRef;
  float insideAt(vec2 uv) {
    vec2 c = clamp(uv, 0.0, 1.0);
    c.y = mix(c.y, 1.0 - c.y, uFlipV);
    return texture2D(uTexture, c).a > uAlphaRef ? 1.0 : 0.0;
  }
  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float in0 = insideAt(uv);
    float found = uRange;
    for (int i = 0; i < SF_MAX; i++) {
      if (float(i) >= uCount) break;
      float d = tapDistance(i);
      if (d >= uRange) break;
      vec2 o = vec2(d * uTexel.x, 0.0);
      if (insideAt(uv - o) != in0 || insideAt(uv + o) != in0) { found = d; break; }
    }
    // R: to the nearest INSIDE pixel (0 when inside), G: to the nearest OUTSIDE.
    float hIn = in0 > 0.5 ? 0.0 : found;
    float hOut = in0 > 0.5 ? found : 0.0;
    gl_FragColor = vec4(hIn / uRange, hOut / uRange, in0, 1.0);
  }
`;

/* DIST V — combines rows into the Euclidean distance, both ways. */
const SF_DIST_V_FRAGMENT = SF_COMMON + SF_TAP + /* glsl */`
  uniform sampler2D uTexture;
  vec3 rowAt(vec2 uv) { return texture2D(uTexture, clamp(uv, 0.0, 1.0)).rgb; }
  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec3 h0 = rowAt(uv);
    float in0 = h0.b;
    // Only the OTHER class is ever searched: the pixel's own distance is 0.
    float best = (in0 > 0.5 ? h0.g : h0.r) * uRange;
    for (int i = 0; i < SF_MAX; i++) {
      if (float(i) >= uCount) break;
      float d = tapDistance(i);
      // sqrt(d² + h²) ≥ d: no farther row can beat what we have.
      if (d >= best) break;
      vec2 o = vec2(0.0, d * uTexel.y);
      vec3 hu = rowAt(uv + o);
      vec3 hd = rowAt(uv - o);
      float h = min(in0 > 0.5 ? hu.g : hu.r, in0 > 0.5 ? hd.g : hd.r) * uRange;
      best = min(best, sqrt(d * d + h * h));
    }
    best = min(best, uRange);
    float dIn = in0 > 0.5 ? 0.0 : best;
    float dOut = in0 > 0.5 ? best : 0.0;
    gl_FragColor = vec4(dIn / uRange, dOut / uRange, in0, 1.0);
  }
`;

/* COMPOSE — the framing block over the premultiplied plate. */
const SF_COMPOSE_FRAGMENT = SF_COMMON + /* glsl */`
  uniform sampler2D uTexture;   // the isolate, premultiplied
  uniform sampler2D uSdf;       // DIST V
  uniform float uFlipV;
  uniform float uOpacity;
  uniform float uBorderWidth;   // texels
  uniform float uBorderStyle;   // 0 solid, 1 dashed, 2 dotted, 3 double (1/2 draw solid)
  uniform vec4 uBorderColor;
  uniform float uShadowCount;
  uniform vec4 uShadowColors[4];
  uniform vec4 uShadowParams[4]; // x offset, y offset, blur, spread — texels
  uniform float uShadowInset[4];

  // Signed distance: positive outside the silhouette, negative inside. R is
  // the distance to the nearest INSIDE pixel (so it is the outside pixels'
  // distance), G the distance to the nearest OUTSIDE pixel (the inside ones').
  float sdfAt(vec2 uv) {
    vec3 s = texture2D(uSdf, clamp(uv, 0.0, 1.0)).rgb;
    return (s.r - s.g) * uRange;
  }
  // A straight colour placed UNDER a premultiplied top.
  vec4 underlay(vec4 top, vec3 rgb, float a) { return top + vec4(rgb * a, a) * (1.0 - top.a); }
  // A straight colour placed OVER a premultiplied base.
  vec4 overlay(vec3 rgb, float a, vec4 base) { return vec4(rgb * a, a) + base * (1.0 - a); }

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec2 puv = vec2(uv.x, mix(uv.y, 1.0 - uv.y, uFlipV));
    vec4 color = texture2D(uTexture, puv);
    float sd = sdfAt(uv);
    float aa = 1.5;
    float bw = uBorderWidth;

    // Border: the band just OUTSIDE the silhouette, under the content.
    if (bw > 0.25) {
      float ring = (1.0 - smoothstep(-aa, aa, sd - bw)) * smoothstep(-aa, aa, sd);
      if (uBorderStyle > 2.5) {
        float third = bw / 3.0;
        float inner = 1.0 - smoothstep(third - aa * 0.5, third + aa * 0.5, sd);
        float outer = smoothstep(2.0 * third - aa * 0.5, 2.0 * third + aa * 0.5, sd);
        ring *= max(inner, outer);
      }
      color = underlay(color, uBorderColor.rgb, uBorderColor.a * ring * uOpacity);
    }

    // Outward shadows, cast by the silhouette plus its ring. Loop order keeps
    // CSS semantics: the first shadow sits on top.
    for (int i = 0; i < 4; i++) {
      if (float(i) >= uShadowCount) break;
      if (uShadowInset[i] > 0.5) continue;
      vec4 sp = uShadowParams[i];
      float ds = sdfAt(uv - vec2(sp.x, -sp.y) * uTexel) - bw - sp.w;
      float soft = max(sp.z, 1.0);
      float mask = 1.0 - smoothstep(-soft, soft, ds);
      color = underlay(color, uShadowColors[i].rgb, uShadowColors[i].a * mask * uOpacity);
    }

    // Inset shadows over the content, clipped to its real (feathered) coverage.
    float cover = clamp(color.a / max(uOpacity, 1e-3), 0.0, 1.0);
    for (int i = 0; i < 4; i++) {
      if (float(i) >= uShadowCount) break;
      if (uShadowInset[i] < 0.5) continue;
      vec4 sp = uShadowParams[i];
      float ds = sdfAt(uv - vec2(sp.x, -sp.y) * uTexel) + sp.w;
      float soft = max(sp.z, 1.0);
      float mask = smoothstep(-soft, soft, ds) * cover;
      color = overlay(uShadowColors[i].rgb, uShadowColors[i].a * mask * uOpacity, color);
    }

    gl_FragColor = color;
  }
`;

const passMaterial = (fragmentShader, uniforms) => new THREE.ShaderMaterial({
  vertexShader: SF_VERTEX,
  fragmentShader,
  uniforms,
  transparent: true,
  blending: THREE.NoBlending,
  depthTest: false,
  depthWrite: false,
});

const vec4s = () => [new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0)];

/** The three GLSL pass materials. Same `.uniforms.<name>.value` surface as the TSL twins. */
export function createSilhouetteFramingMaterials() {
  const distH = passMaterial(SF_DIST_H_FRAGMENT, {
    uTexture: { value: null },
    uFlipV: { value: 0 },
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    uRange: { value: 8 },
    uFine: { value: 8 },
    uStep: { value: 1 },
    uCount: { value: 8 },
    uAlphaRef: { value: 0.5 },
  });
  const distV = passMaterial(SF_DIST_V_FRAGMENT, {
    uTexture: { value: null },
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    uRange: { value: 8 },
    uFine: { value: 8 },
    uStep: { value: 1 },
    uCount: { value: 8 },
  });
  const compose = passMaterial(SF_COMPOSE_FRAGMENT, {
    uTexture: { value: null },
    uSdf: { value: null },
    uFlipV: { value: 0 },
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    uRange: { value: 8 },
    uOpacity: { value: 1 },
    uBorderWidth: { value: 0 },
    uBorderStyle: { value: 0 },
    uBorderColor: { value: new THREE.Vector4(1, 1, 1, 1) },
    uShadowCount: { value: 0 },
    uShadowColors: { value: vec4s() },
    uShadowParams: { value: vec4s() },
    uShadowInset: { value: [0, 0, 0, 0] },
  });
  return { distH, distV, compose };
}

const BORDER_STYLE_INDEX = { solid: 0, dashed: 1, dotted: 2, double: 3 };

/**
 * Drive all three materials.
 *   width/height — the isolate's size (texels)
 *   pxScale      — composition px → texels (already including the layer's scale)
 *   opacity      — the layer's effective opacity, i.e. what the plate's alpha was
 *                  multiplied by; the class threshold sits at half of it
 * Returns the resolved spec, or null when there is nothing to draw.
 */
export function applySilhouetteFramingUniforms(mats, item, { width, height, pxScale = 1, opacity = 1 }) {
  const spec = silhouetteFramingSpec(item, pxScale);
  if (!spec) return null;
  const texelX = 1 / Math.max(1, width);
  const texelY = 1 / Math.max(1, height);
  const alphaRef = Math.max(0.002, Math.min(0.5, 0.5 * (Number.isFinite(opacity) ? opacity : 1)));

  for (const m of [mats.distH, mats.distV, mats.compose]) {
    const u = m.uniforms;
    u.uResolution.value.set(width, height);
    u.uTexel.value.set(texelX, texelY);
    u.uRange.value = spec.range;
  }
  for (const m of [mats.distH, mats.distV]) {
    const u = m.uniforms;
    u.uFine.value = spec.fine;
    u.uStep.value = spec.step;
    u.uCount.value = spec.count;
  }
  mats.distH.uniforms.uAlphaRef.value = alphaRef;

  const c = mats.compose.uniforms;
  c.uOpacity.value = Number.isFinite(opacity) ? Math.max(0, opacity) : 1;
  c.uBorderWidth.value = spec.border;
  c.uBorderStyle.value = BORDER_STYLE_INDEX[item?.borderStyle] ?? 0;
  const bc = parseCssColor(item?.borderColor, { r: 1, g: 1, b: 1, a: 1 });
  c.uBorderColor.value.set(bc.r, bc.g, bc.b, bc.a);
  c.uShadowCount.value = spec.shadows.length;
  for (let i = 0; i < 4; i++) {
    const s = spec.shadows[i];
    if (!s) {
      c.uShadowColors.value[i].set(0, 0, 0, 0);
      c.uShadowParams.value[i].set(0, 0, 0, 0);
      c.uShadowInset.value[i] = 0;
      continue;
    }
    const sc = parseCssColor(s.color, { r: 0, g: 0, b: 0, a: 0.65 });
    c.uShadowColors.value[i].set(sc.r, sc.g, sc.b, sc.a);
    c.uShadowParams.value[i].set(
      (Number.isFinite(s.x) ? s.x : 0) * pxScale,
      (Number.isFinite(s.y) ? s.y : 0) * pxScale,
      Math.max(0, Number.isFinite(s.blur) ? s.blur : 0) * pxScale,
      (Number.isFinite(s.spread) ? s.spread : 0) * pxScale,
    );
    c.uShadowInset.value[i] = s.inset ? 1 : 0;
  }
  return spec;
}
