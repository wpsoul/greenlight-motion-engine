/*
 * Backdrop Blur — matte / frosted glass on SHAPE layers.
 *
 * The CSS `backdrop-filter: blur()` idea inside the compositor: everything the
 * stack has accumulated BELOW the shape is blurred, and the blurred copy
 * replaces the stack inside the shape's outline. The shape's own fill then
 * draws over that exactly as before, so a semi-transparent white fill over a
 * blurred backdrop reads as frosted glass, a tinted fill as smoked glass.
 *
 * Why a Design section and not a Layer Effect: every Layer Effect restyles the
 * layer's OWN isolate. This one never touches the shape — it restyles the
 * layers behind it, which only the multi-pass compositor can see (it owns the
 * accumulation target). So it lives next to Border and Shadows, and it is
 * gated to shape layers: a shape's outline is the one silhouette that is
 * authored as a window rather than as content.
 *
 * Pipeline (Player.applyBackdropBlur), all fullscreen quad passes:
 *   1. box-downsample the stack ×2 per hop until the blur's sigma is a few
 *      small pixels (a 2×2 bilinear tap at the small pixel's centre IS a box
 *      filter, so thin detail is averaged rather than skipped — sampling one
 *      row in N would make a thin line under the glass flicker as it moves)
 *   2. separable gaussian, H then V, at that small size
 *   3. mix the stack toward the (bilinearly upsampled) blur by the shape's
 *      coverage, into the compositor's write target
 *
 * ORIENTATION. Every pass here samples at gl_FragCoord / uResolution, never at
 * the quad's uv — that read is a storage IDENTITY on both backends (WebGL is
 * identity either way; on WebGPU the quad's uv mirrors storage while
 * screenCoordinate does not — html/webgpu-migration/PORTING-GUIDE.md §3.6).
 * The stack target is camera-axis and stays camera-axis through the mix, so
 * the layers drawn after it land the right way up. The MATTE is the one input
 * whose provenance varies: a camera-rendered isolate (plain layer) or a
 * finished quad plate (a shape that also carries Layer Effects); the node
 * twin's `flipMatte` variant covers the second — see backdropBlurNodes.js.
 *
 * COVERAGE, not alpha. A frosted card is a shape with a 20–40 % fill, and its
 * plate alpha is that 0.2–0.4 — reading it as the blur amount would leave the
 * glass mostly clear. `uAlphaRef` is the fill's peak alpha × layer opacity
 * (shapePeakAlpha), so coverage = clamp(alpha / ref): 1 across the fill,
 * antialiased on the rim, and still proportional where a gradient fill fades.
 */
import * as THREE from 'three';
import { parseCssColor } from './clipShader.js';

export const BACKDROP_DEFAULTS = Object.freeze({ backdropBlur: 0, backdropSaturation: 100 });
export const BACKDROP_BLUR_MAX = 200;
export const BACKDROP_SATURATION_MAX = 300;
/** Below this sigma (in target px) the pass is a bypass — nothing to blur. */
export const BACKDROP_MIN_SIGMA = 0.3;
/** The shader's fixed loop bound; halfTaps is clamped to it. */
export const BACKDROP_MAX_HALF_TAPS = 24;
/** Keep the small-plate sigma in this window: ≥ SIGMA_LO keeps the bilinear
 *  upsample smooth, ≤ SIGMA_HI keeps the tap count inside the loop bound. */
const SIGMA_HI = 5;
const MAX_DOWNSCALE = 32;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Does this item carry a backdrop blur at all (static or keyframed)? Shape gate is the caller's. */
export function hasBackdropBlur(item) {
  if (!item || item.shapeClipMask) return false;
  if (isNum(item.backdropBlur) && item.backdropBlur > 0) return true;
  const track = item.propertyKeyframes?.backdropBlur;
  return Array.isArray(track) && track.length > 0;
}

/** Only shape layers get the section and the pass. A clip-mask shape never draws
 *  its fill (its alpha IS a mask), so it has no window to frost. */
export function isBackdropBlurLayer(item, clip) {
  return clip?.mediaType === 'shape' && hasBackdropBlur(item);
}

/** This frame's parameters: blur sigma (px, project space) and saturation (×). */
export function resolveBackdropParams(item, kf) {
  const blur = isNum(kf?.backdropBlur) ? kf.backdropBlur
    : (isNum(item?.backdropBlur) ? item.backdropBlur : BACKDROP_DEFAULTS.backdropBlur);
  const sat = isNum(kf?.backdropSaturation) ? kf.backdropSaturation
    : (isNum(item?.backdropSaturation) ? item.backdropSaturation : BACKDROP_DEFAULTS.backdropSaturation);
  return {
    blurPx: clamp(blur, 0, BACKDROP_BLUR_MAX),
    saturation: clamp(sat, 0, BACKDROP_SATURATION_MAX) / 100,
  };
}

// Every colour token in a string — a solid, a CSS gradient, or a serialised
// background config — and the largest alpha among them.
const COLOR_TOKEN = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
function peakAlphaIn(text) {
  if (typeof text !== 'string' || !text) return 0;
  let peak = 0;
  const tokens = text.match(COLOR_TOKEN);
  if (!tokens) return 0;
  for (const tok of tokens) {
    const a = parseCssColor(tok, { a: 0 }).a;
    if (a > peak) peak = a;
    if (peak >= 1) break;
  }
  return peak;
}

/** The most opaque alpha the shape's FILL paints (0 for a transparent fill). */
export function shapeFillPeakAlpha(item) {
  if (!item) return 1;
  const bg = item.shapeBackground;
  const type = bg?.type || 'solid';
  let fill = 0;
  if (type === 'transparent') fill = 0;
  else if (type === 'solid') fill = peakAlphaIn(bg?.solidColor || item.shapeFillColor || '#8b5cf6');
  else if (type === 'gradient') fill = peakAlphaIn(JSON.stringify(bg));
  else fill = 1; // shader / pattern / image paints are opaque
  // A keyed paint may be more opaque than the static one at some key.
  const track = item.propertyKeyframes?.shapeFill;
  if (Array.isArray(track)) for (const k of track) fill = Math.max(fill, peakAlphaIn(typeof k?.value === 'string' ? k.value : ''));
  return fill;
}

/** Is the fill a plain colour the panel can thin into glass (solid, not keyed)? */
export function shapeFillIsSolid(item) {
  const type = item?.shapeBackground?.type || 'solid';
  const track = item?.propertyKeyframes?.shapeFill;
  return type === 'solid' && !(Array.isArray(track) && track.length > 0);
}

/** The same colour at `alpha` — an rgba() string, whatever notation came in. */
export function withFillAlpha(color, alpha) {
  const c = parseCssColor(color, { r: 1, g: 1, b: 1, a: 1 });
  const ch = (v) => Math.round(clamp(v, 0, 1) * 255);
  return `rgba(${ch(c.r)},${ch(c.g)},${ch(c.b)},${Math.round(clamp(alpha, 0, 1) * 100) / 100})`;
}

/**
 * Thin a SOLID fill to `alpha` glass. The paint it replaces is remembered on
 * the item (`backdropGlassFill`) so turning the blur back off can put it back —
 * without that, Blur 0 left the shape see-through and the glass looked "still
 * on". {} for paints the panel can't thin (gradient, shader, keyed fill).
 */
export function glassFillPatch(item, alpha) {
  if (!shapeFillIsSolid(item)) return {};
  const bg = item.shapeBackground;
  const solid = bg?.type === 'solid' ? bg : null;
  const glass = withFillAlpha((solid && solid.solidColor) || item.shapeFillColor || '#8b5cf6', alpha);
  // A second thinning keeps the FIRST memo: that is the paint the user chose.
  const memo = item.backdropGlassFill || {
    glass,
    fill: typeof item.shapeFillColor === 'string' ? item.shapeFillColor : null,
    solid: solid && typeof solid.solidColor === 'string' ? solid.solidColor : null,
  };
  return {
    shapeFillColor: glass,
    ...(solid ? { shapeBackground: { ...solid, solidColor: glass } } : {}),
    backdropGlassFill: { ...memo, glass },
  };
}

/**
 * Undo glassFillPatch: the remembered paint comes back while the fill is still
 * the glass colour it wrote. A fill edited since then is the user's and stays.
 * Always drops the memo; {} when there is none.
 */
export function unglassFillPatch(item) {
  const memo = item?.backdropGlassFill;
  if (!memo) return {};
  const bg = item.shapeBackground;
  const solid = bg?.type === 'solid' ? bg : null;
  const current = (solid && solid.solidColor) || item.shapeFillColor;
  if (!shapeFillIsSolid(item) || current !== memo.glass) return { backdropGlassFill: null };
  return {
    shapeFillColor: memo.fill,
    ...(solid ? { shapeBackground: { ...solid, solidColor: memo.solid } } : {}),
    backdropGlassFill: null,
  };
}

/**
 * The alpha the shape's plate reaches across its FILL: the fill's peak alpha
 * (solid / gradient / keyed paint) × the layer's static opacity. Floored so the
 * shader's divide is safe; the fallback for an unparseable paint is "opaque",
 * which reads the plate alpha as-is — never MORE blur than the plate shows,
 * only never less.
 *
 * The border deliberately does NOT raise this. A 30 % fill with an opaque
 * white stroke was being normalised by the stroke's alpha, which cut the
 * interior's coverage to 30 % — the whole glass went nearly clear the moment
 * a border was added. Under the stroke itself the ratio clamps to 1, so the
 * outline is still inside the window; it just no longer sets the reference.
 * Only when the fill paints nothing (a stroke-only shape) is the stroke the
 * reference.
 */
export function shapePeakAlpha(item) {
  if (!item) return 1;
  let fill = shapeFillPeakAlpha(item);
  if (!(fill > 0) && isNum(item.borderWidth) && item.borderWidth > 0) fill = peakAlphaIn(item.borderColor || '#ffffff');
  if (!(fill > 0)) fill = 1;
  const opacity = isNum(item.opacity) ? clamp(item.opacity, 0, 100) / 100 : 1;
  return clamp(fill * opacity, 0.05, 1);
}

/**
 * How to run a gaussian of `sigma` target px: the ×2 downsample count that
 * brings the sigma into the small-plate window, the sigma at that size and the
 * half tap count (3σ, so the kernel is not visibly truncated).
 */
export function planBackdropBlur(sigma, width, height) {
  let ds = 1;
  const shortest = Math.max(1, Math.min(width, height));
  while (sigma / ds > SIGMA_HI && ds < MAX_DOWNSCALE && shortest / (ds * 2) >= 8) ds *= 2;
  const sigmaS = sigma / ds;
  const halfTaps = clamp(Math.ceil(sigmaS * 3), 1, BACKDROP_MAX_HALF_TAPS);
  return {
    ds,
    sigmaS,
    halfTaps,
    width: Math.max(1, Math.round(width / ds)),
    height: Math.max(1, Math.round(height / ds)),
  };
}

const vertexShader = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// One separable gaussian pass (uStep is the tap direction in SOURCE uv units).
// uHalfTaps 0 is a plain resample, which the driver uses as its 2×2 box
// downsample: sampling a linear-filtered source at the destination's pixel
// centre averages the four source texels under it.
const blurFragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uResolution; // THIS pass's target size
uniform vec2 uStep;       // one tap, in source uv (direction included)
uniform float uSigma;     // in taps
uniform int uHalfTaps;
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 sum = texture2D(uTexture, uv);
  float wsum = 1.0;
  float inv2s2 = 0.5 / max(uSigma * uSigma, 1e-4);
  for (int i = 1; i <= ${BACKDROP_MAX_HALF_TAPS}; i++) {
    if (i > uHalfTaps) break;
    float x = float(i);
    float w = exp(-x * x * inv2s2);
    vec2 o = uStep * x;
    sum += (texture2D(uTexture, clamp(uv + o, 0.0, 1.0)) + texture2D(uTexture, clamp(uv - o, 0.0, 1.0))) * w;
    wsum += 2.0 * w;
  }
  gl_FragColor = sum / wsum;
}
`;

export function createBackdropBlurMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: blurFragmentShader,
    uniforms: {
      uTexture: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uStep: { value: new THREE.Vector2(0, 0) },
      uSigma: { value: 1 },
      uHalfTaps: { value: 0 },
    },
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

// The stack, replaced by its blur inside the shape's coverage. All three
// inputs are premultiplied; the blur of a premultiplied plate is a valid
// premultiplied plate, and so is the mix. Saturation is a luma mix, which is
// linear and therefore commutes with premultiplication; the clamp keeps
// rgb ≤ alpha after a boost.
const mixFragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D uTexture; // the accumulated stack (below the shape)
uniform sampler2D uBlur;    // its blur, at the small size (linear filter)
uniform sampler2D uMatte;   // the shape's isolate
uniform vec2 uResolution;   // the stack target's size
uniform float uAlphaRef;    // plate alpha where the fill is fully painted
uniform float uSaturation;  // 1 = unchanged
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 src = texture2D(uTexture, uv);
  float m = clamp(texture2D(uMatte, uv).a / uAlphaRef, 0.0, 1.0);
  vec4 b = texture2D(uBlur, uv);
  float l = dot(b.rgb, vec3(0.2126, 0.7152, 0.0722));
  b.rgb = clamp(mix(vec3(l), b.rgb, uSaturation), vec3(0.0), vec3(b.a));
  gl_FragColor = mix(src, b, m);
}
`;

export function createBackdropMixMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: mixFragmentShader,
    uniforms: {
      uTexture: { value: null },
      uBlur: { value: null },
      uMatte: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uAlphaRef: { value: 1 },
      uSaturation: { value: 1 },
    },
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}
