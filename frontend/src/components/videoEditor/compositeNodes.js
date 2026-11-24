/*
 * TSL twins of the COMPOSITING materials — the passes that assemble effects
 * rather than being one.
 *
 *   createBlitNodeMaterial()            ← createBlitMaterial()
 *   createOverBlitNodeMaterial()        ← createOverBlitMaterial()
 *   createAdjustmentNodeMaterial()      ← createAdjustmentMaterial()
 *   createMixNodeMaterial()             ← createMixMaterial()
 *   createMaskCompositeNodeMaterial()   ← createMaskCompositeMaterial()
 *   createTrackMatteNodeMaterial()      ← createTrackMatteMaterial()
 *   createDepthStampNodeMaterial()      ← createDepthStampMaterial()
 *   createDepthCompositeNodeMaterial()  ← createDepthCompositeMaterial()
 *
 * WHY THIS MODULE EXISTS LATE. The migration matrix is organised by EFFECT, and
 * none of these is an effect — they are the plumbing between effects. No lab
 * covered them, so no row flagged them, so the registry never listed them, and
 * `verify_material_factory.js` reported "0 unresolved" truthfully about an
 * incomplete list. On WebGPU a GLSL ShaderMaterial draws NOTHING, and in the
 * composite path that is not a missing layer, it is an opaque region — which is
 * the app-level A/B failure that finally led here. The inverse scan
 * (`verify_backend_coverage.js`) is what makes the list checkable now.
 *
 * All eight keep `.uniforms.<name>.value` as their write surface, so every
 * existing driver in Player.jsx and clipShader.js drives them unchanged.
 */
import * as THREE from 'three/webgpu';
import {
  uniform, texture, uv, vec2, vec3, vec4, float, dot, mix, clamp, select, Fn, If, Discard,
  Loop, Break, int, abs, fract, sin, cos, sqrt, step, smoothstep, distance, max as tslMax, min as tslMin,
  screenCoordinate, screenSize, screenUV, exp, log2, pow, textureLoad, ivec2, floor,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';
import { stableHash12 } from './tslStableHash.js';

/** Null-safe binding facade — see tslSampler.js for why null must never
 * reach TextureNode.value, and why the fallback is created once. */
const makeSampler = (flip = false) => makeTslSampler({ rgba: [0, 0, 0, 0], flipY: flip });

function finish(material, uniforms) {
  material.depthTest = false;
  material.depthWrite = false;
  // ShaderMaterial's constructor sets this true; every NodeMaterial inherits
  // Material's false, which opts a transparent DoubleSide material into a
  // back-then-front two-pass draw and reorders any self-overlap (§13).
  material.forceSinglePass = true;
  material.uniforms = uniforms;
  return material;
}

// ── (hdr3) An HDR render's float composite: display values up to white, light above it ──
// The stack of an HDR render's float composite (hdrComposite.js) holds each pixel's SDR display value up to white (1.0) and its light
// above white (1000 cd/m² = 4.93). These are its two halves of the sRGB curve: to light, and back, channel by channel (step(), not
// select(): a TSL select() on a vector tests all() of it, so a saturated colour's dark channel took the curve's upper branch and its
// display value went below zero, -14 levels for a channel at 0: the round-2 plate's encode did that, and its check failed on a red box).
const sdrToLin = (c) => mix(tslMax(c, vec3(0)).div(12.92), pow(tslMax(c, vec3(0)).add(0.055).div(1.055), vec3(2.4)), step(vec3(0.04045), c));
const sdrToDisplay = (c) => mix(tslMax(c, vec3(0)).mul(12.92), pow(tslMax(c, vec3(0)), vec3(1 / 2.4)).mul(1.055).sub(0.055), step(vec3(0.0031308), c));
const pastWhite = (c) => step(vec3(1), c);
const hybridToLin = (c) => mix(sdrToLin(clamp(c, 0.0, 1.0)), c, pastWhite(c));
const linToHybrid = (c) => mix(sdrToDisplay(clamp(c, 0.0, 1.0)), c, pastWhite(c));
// the sRGB curve's slope at white, display per unit of light: a light step x above white is a display step x·SRGB_SLOPE_AT_WHITE
const SRGB_SLOPE_AT_WHITE = 1.055 / 2.4;
// the sRGB curve to light, per channel, carried on above 1 (for a grade's slope)
const srgbToLinExt = (c) => mix(tslMax(c, vec3(0)).div(12.92), pow(tslMax(c, vec3(0)).add(0.055).div(1.055), vec3(2.4)), step(vec3(0.04045), c));

/**
 * (hdr3) A grade (or blend) `g` (display values in and out, as the SDR export applies it) carried onto a colour of the float composite:
 * the SDR result at the colour's display part, plus the light above white carried at the grade's own slope there, so the result is
 * continuous in value and slope at white: light = L(g(d)) + J·x, J·x the grade's change in light per unit of light at d along x (a
 * backward difference from the SDR side). `c` straight; returns the float composite's number (SDR display value where nothing is above
 * white). `clampTop`: the SDR grade's own top (1: the SDR export clamps its result to white).
 */
export function gradeHybrid(c, g, { clampTop = true } = {}) {
  const d = tslMin(c, vec3(1)).toVar();
  const x = tslMax(c.sub(vec3(1)), vec3(0)).toVar();
  const g0 = g(d).toVar();
  const sdr = clampTop ? clamp(g0, 0.0, 1.0) : tslMax(g0, vec3(0));
  const out = vec3(sdr).toVar();
  If(tslMax(x.r, tslMax(x.g, x.b)).greaterThan(0.0), () => {
    const dc = x.mul(SRGB_SLOPE_AT_WHITE);
    const eps = float(1e-3).div(tslMax(tslMax(dc.r, tslMax(dc.g, dc.b)), 1e-6));
    const g1 = g(d.sub(dc.mul(eps)));
    const slope = srgbToLinExt(g0).sub(srgbToLinExt(g1)).div(eps);
    out.assign(linToHybrid(tslMax(srgbToLinExt(sdr).add(slope), vec3(0))));
  });
  return out;
}

// ── 1/2. The two blits ──────────────────────────────────────────────────────
// Identical fragment; they differ only in how the result lands. Both are the
// composite path the app-level A/B exercises, which is why they went first.

/*
 * Built inside Fn() — and that is not a style choice.
 *
 * A fragment assembled eagerly captures whatever `flipY` held at CONSTRUCTION,
 * so a driver setting `mat.uniforms.uTexture.flipY = true` afterwards is
 * silently ignored: the sampler's branch was already resolved into the graph.
 * The bisect caught this in the sharpest possible way — the adjustment material
 * (already Fn-wrapped for its `If`) responded to --noflip and went to zero,
 * while the other six returned byte-identical numbers in BOTH columns. Same
 * flag, same loop, no effect, no error. Fn defers the body to build time, which
 * is the last moment a driver can still declare a binding.
 */
const blitFragment = (u) => Fn(() => u.uTexture.sample(uv()));

/**
 * Straight copy: replaces the destination.
 *
 * `flipTexture` reads the source at (u, 1−v). On WebGPU that is a STORAGE-
 * IDENTITY copy (PORTING-GUIDE §3.6: the hand-written flip cancels the
 * geometry-uv mirror), where the plain blit re-stores the plate on the opposite
 * V axis. The sequence compositor's final copy into the sequence RT needs the
 * identity: the plain-render path lands the plate camera-axis in ONE hop and
 * the clip material's uInputFlipV is calibrated for that, so a mirroring copy
 * there shipped every composited sequence (effects, masks, mattes inside a
 * group) upside down. Default stays plain — every other caller wants the hop.
 */
export function createBlitNodeMaterial({ flipTexture = false } = {}) {
  const u = { uTexture: makeSampler(flipTexture) };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = blitFragment(u)();
  material.transparent = false;
  material.blending = THREE.NoBlending;
  return finish(material, u);
}

/**
 * Picture plate copy — twin of createPictureCopyMaterial. An UPLOADED texture
 * (a clip's image / thumbnail) cover-fitted onto a frame-sized plate. The read
 * is flipped on purpose: the chain's plates are quad-blitted camera isolates,
 * and an uploaded texture through the plain blit lands on the opposite V axis
 * (measured: a red-top picture came back green-top inside Double Exposure).
 */
export function createPictureCopyNodeMaterial() {
  const u = {
    uTexture: makeSampler(true),
    uUvScale: uniform(new THREE.Vector2(1, 1)),
    uUvOffset: uniform(new THREE.Vector2(0, 0)),
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => u.uTexture.sample(uv().mul(u.uUvScale).add(u.uUvOffset)))();
  material.transparent = false;
  material.blending = THREE.NoBlending;
  return finish(material, u);
}

/**
 * Same copy composited OVER what is already there. The source RT was written by
 * alpha-blended passes so its RGB is already multiplied by its own coverage —
 * hence One, not SrcAlpha, for the source factor; SrcAlpha would darken every
 * antialiased edge a second time. This is the flatten onto an opaque backdrop
 * that keeps an exported frame free of partial alpha.
 */
export function createOverBlitNodeMaterial() {
  // uBlendIdentity: the blend mode's neutral colour (applyPremultipliedBlendMode).
  // A premultiplied source is already faded toward BLACK by its own coverage, so
  // the identity-0 modes need nothing; multiply/darken want WHITE where the layer
  // is absent, or they would blacken the frame outside it. 0 is an exact no-op.
  const u = { uTexture: makeSampler(), uBlendIdentity: uniform(new THREE.Vector3(0, 0, 0)) };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const src = u.uTexture.sample(uv());
    return vec4(src.rgb.add(u.uBlendIdentity.mul(float(1.0).sub(src.a))), src.a);
  })();
  material.transparent = true;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  return finish(material, u);
}

/*
 * (mblur4) The over-blit in linear light, for what stands for a share of the light below rather than a layer of paint: a shadow catcher's
 * shadow (its coverage is the share of the light the objects take from the floor, its colour the shadow's tint) and a Scene's frame whose
 * coverage is a shutter's share. lin = a·L(c / a) + (1 − a)·Lp(below), premultiplied in and out, sRGB to linear and back: a 50 % light loss
 * leaves the footage half its light, where the display-value blend left 22 %. `uBelow` is the stack as it stood before this draw (a
 * storage-identity copy, read flipped as createDepthCompositeNodeMaterial's linear draw reads it); the draw writes the whole result. A pixel
 * with no coverage, or full coverage, is what the plain blend gives.
 */
export function createOverBlitLinearNodeMaterial({ hdr = false } = {}) {
  const u = { uTexture: makeSampler(), uBelow: makeSampler(true) };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const src = u.uTexture.sample(uv());
    const below = u.uBelow.sample(uv());
    // (hdr3) `hdr`: an HDR render's float composite — the stack below holds the 3D Scene's light above white (display values up to white,
    // light above): its light is read as it is and the result written back the same way, so a catcher's shadow takes its share of that
    // light too instead of clamping it at white. Below white it is the SDR draw.
    const toLin = hdr ? hybridToLin : (c) => select(c.lessThanEqual(vec3(0.04045)), c.div(12.92), pow(c.add(0.055).div(1.055), vec3(2.4)));
    const toDisplay = hdr ? linToHybrid : (c) => select(c.lessThanEqual(vec3(0.0031308)), c.mul(12.92), pow(c, vec3(1 / 2.4)).mul(1.055).sub(0.055));
    const top = (c) => (hdr ? tslMax(c, vec3(0)) : c.clamp(0, 1));
    const a = src.a.clamp(0, 1), b = below.a.clamp(0, 1);
    const own = src.rgb.div(tslMax(a, 1e-4)).clamp(0, 1);
    const lin = toLin(own).mul(a)
      .add(toLin(top(below.rgb.div(tslMax(b, 1e-4)))).mul(b).mul(float(1).sub(a)));
    const outA = a.add(b.mul(float(1).sub(a)));
    // light the source adds past its coverage (a lit catcher's bounce: premultiplied colour beyond its alpha) goes on as it always did
    const extra = src.rgb.sub(own.mul(a)).max(0);
    return vec4(toDisplay(lin.div(tslMax(outA, 1e-4))).mul(outA).add(extra), outA);
  })();
  material.transparent = true;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.ZeroFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.ZeroFactor;
  return finish(material, u);
}

// ── 3. Adjustment layer ─────────────────────────────────────────────────────

/*
 * The adjustment layer's blur — clipShader.js's sampleBlurred, tap for tap: a real 2D Gaussian with
 * CSS semantics (σ = uBlur px), 48 Gaussian-weighted taps on a golden-angle spiral out to 2.5σ,
 * turned per pixel. Kept as a runtime branch: at uBlur = 0 — the overwhelmingly common case — it
 * is one tap.
 */
function sampleBlurred(u, uvn) {
  const out = vec4(0.0).toVar();
  If(u.uBlur.lessThanEqual(0.0), () => {
    out.assign(u.uTexture.sample(uvn));
  }).Else(() => {
    const sigma = float(u.uBlur);
    const reach = sigma.mul(2.5);
    const spin = fract(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))).mul(52.9829189)).mul(6.2831853);
    const sum = u.uTexture.sample(uvn).toVar();
    const wsum = float(1.0).toVar();
    Loop({ start: int(0), end: int(48), type: 'int' }, ({ i }) => {
      const fi = float(i).add(0.5);
      const r = reach.mul(sqrt(fi.div(48.0)));
      const a = fi.mul(2.39996323).add(spin);
      const w = exp(r.mul(r).negate().div(sigma.mul(sigma).mul(2.0)));
      sum.addAssign(u.uTexture.sample(uvn.add(vec2(cos(a), sin(a)).mul(r).div(u.uResolution))).mul(w));
      wsum.addAssign(w);
    });
    out.assign(sum.div(wsum));
  });
  return out;
}

/*
 * The GLSL builds a mat3 and multiplies. Written here as the three column
 * vectors scaled by r/g/b instead: a TSL mat3() from nine scalars has to be read
 * against GLSL's column-major fill order to check, and there is no reason to
 * make a reviewer do that when `m * c` IS col0*c.r + col1*c.g + col2*c.b.
 */
function applyHueRotation(c, angleDeg) {
  const rad = angleDeg.mul(Math.PI / 180.0);
  const cosA = rad.cos();
  const sinA = rad.sin();
  const col0 = vec3(
    cosA.mul(0.787).sub(sinA.mul(0.213)).add(0.213),
    cosA.mul(-0.213).add(sinA.mul(0.143)).add(0.213),
    cosA.mul(-0.213).sub(sinA.mul(0.787)).add(0.213),
  );
  const col1 = vec3(
    cosA.mul(-0.715).sub(sinA.mul(0.715)).add(0.715),
    cosA.mul(0.285).add(sinA.mul(0.140)).add(0.715),
    cosA.mul(-0.715).add(sinA.mul(0.715)).add(0.715),
  );
  const col2 = vec3(
    cosA.mul(-0.072).add(sinA.mul(0.928)).add(0.072),
    cosA.mul(-0.072).sub(sinA.mul(0.283)).add(0.072),
    cosA.mul(0.928).add(sinA.mul(0.072)).add(0.072),
  );
  return clamp(col0.mul(c.r).add(col1.mul(c.g)).add(col2.mul(c.b)), 0.0, 1.0);
}

const LUMA_709 = vec3(0.2126, 0.7152, 0.0722);

/**
 * Re-grades the already-composited "layers below" texture. The plane's own
 * transform IS the geometry, so the grade lands on the actual below pixels
 * rather than overlaying a copy. Opacity rides the RESULT'S ALPHA, so the
 * covered area fully replaces what is under it (no ghosting) and anything the
 * transformed plane misses falls through to the untouched below.
 */
export function createAdjustmentNodeMaterial({ hdr = false } = {}) {
  const u = {
    uTexture: makeSampler(),
    uResolution: uniform(new THREE.Vector2(1280, 720)),
    uOpacity: uniform(1.0),
    uBrightness: uniform(1.0),
    uContrast: uniform(1.0),
    uSaturation: uniform(1.0),
    uHueRotate: uniform(0.0),
    uGrayscale: uniform(0.0),
    uSepia: uniform(0.0),
    uInvert: uniform(0.0),
    uBlur: uniform(0.0),
    uTintColor: uniform(new THREE.Color(0xffffff)),
    // (hdr2) the top of the graded colour: display white, lifted only while an HDR render composites in float (hdrComposite.js)
    uRgbMax: uniform(1.0),
  };
  /*
   * The whole fragment is built inside Fn(). `If()` and `.toVar()` append to the
   * CURRENT BUILD STACK, and at material-construction time there is no stack —
   * outside an Fn they have nowhere to land. Same for `Discard()` in the two
   * depth passes below.
   */
  // The grade, display values in and out (its last clamp is the caller's, as the SDR export does it).
  const grade = (cIn) => {
    let c = cIn.mul(u.uBrightness);
    c = c.sub(0.5).mul(u.uContrast).add(0.5);
    c = mix(vec3(dot(c, LUMA_709)), c, u.uSaturation);
    // The GLSL guards each of these with an `if`; as pure arithmetic on values
    // already in registers, select() is the same result with no branch.
    c = select(u.uHueRotate.abs().greaterThan(0.5), applyHueRotation(c, u.uHueRotate), c);
    c = mix(c, vec3(dot(c, LUMA_709)), clamp(u.uGrayscale, 0.0, 1.0));
    const sepia = vec3(
      dot(c, vec3(0.393, 0.769, 0.189)),
      dot(c, vec3(0.349, 0.686, 0.168)),
      dot(c, vec3(0.272, 0.534, 0.131)),
    );
    c = mix(c, sepia, clamp(u.uSepia, 0.0, 1.0));
    c = mix(c, vec3(1.0).sub(c), clamp(u.uInvert, 0.0, 1.0));
    return c.mul(u.uTintColor);
  };
  const fragment = Fn(() => {
    const raw = sampleBlurred(u, uv());
    // Premultiplied stack in, alpha-blended write out: grade the straight colour
    // (see the GLSL twin) so semi-transparent pixels are not darkened twice.
    if (hdr) {
      // (hdr3) an HDR render's float composite: the SDR grade up to white, the light above white carried at the grade's slope there
      // (gradeHybrid), so a grade is the SDR export's on everything within white and continues smoothly into the 3D Scene's highlights.
      const c = gradeHybrid(raw.rgb.div(tslMax(raw.a, 0.0001)), grade);
      return vec4(c, raw.a.mul(u.uOpacity));
    }
    const c = clamp(grade(raw.rgb.div(tslMax(raw.a, 0.0001))), 0.0, u.uRgbMax);
    return vec4(c, raw.a.mul(u.uOpacity));
  });

  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = fragment();
  material.transparent = true;
  material.side = THREE.DoubleSide;
  return finish(material, u);
}

// ── 4. Mix ──────────────────────────────────────────────────────────────────

/** result = mix(uTexA, uTexB, uMix). */
export function createMixNodeMaterial() {
  const u = { uTexA: makeSampler(), uTexB: makeSampler(), uMix: uniform(1.0) };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = uv();
    return mix(u.uTexA.sample(uvn), u.uTexB.sample(uvn), u.uMix);
  })();
  material.transparent = false;
  material.blending = THREE.NoBlending;
  return finish(material, u);
}

// ── 5. Clip mask ────────────────────────────────────────────────────────────

/**
 * Keeps the accumulated below-composite only where the mask layer has coverage.
 * RGB scales by the SAME coverage as alpha, so a transparent antialiased edge
 * texel cannot leak its hidden colour into later post/export passes. `uInvert`
 * flips the matte for a knockout.
 */
// `flipTexture`: both inputs are CAMERA-rendered (the composite below and the mask layer), and a plain-uv quad pass
// re-stores a plate on the opposite V axis on WebGPU — so the clip-mask pass samples both flipped and the composite
// keeps its orientation for the layers drawn on top of it afterwards (without it the masked result came out
// upside down while later layers stayed upright).
export function createMaskCompositeNodeMaterial({ flipTexture = false } = {}) {
  const u = { uTexture: makeSampler(flipTexture), uMask: makeSampler(flipTexture), uInvert: uniform(0) };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = uv();
    const below = u.uTexture.sample(uvn);
    const cov = u.uMask.sample(uvn).a;
    const m = mix(cov, float(1.0).sub(cov), u.uInvert);
    return vec4(below.rgb.mul(m), below.a.mul(m));
  })();
  material.transparent = false;
  material.blending = THREE.NoBlending;
  return finish(material, u);
}

// ── 6. Track matte ──────────────────────────────────────────────────────────

/**
 * Multiplies ONE layer's finished isolate by another layer's coverage (AE's
 * Track Matte). Differs from the clip mask in scope — one consumer layer, not
 * the whole below-stack — and in supporting luma modes. Both textures are
 * premultiplied, so luma on premultiplied RGB equals straight-luma × alpha,
 * which is exactly AE's behaviour: a fully transparent matte texel contributes
 * nothing whatever its hidden colour.
 *
 * ORIENTATION — the two inputs do NOT share a provenance, and that is the whole
 * WebGPU story of this pass. The matte is always a CAMERA-rendered isolate
 * (view top in texture row 0 on WebGPU). The consumer is whatever the layer
 * stack finished with: at the top level `renderStyledLayerIsolate` always hands
 * back a finished QUAD plate (the opposite V axis), while inside a sequence it
 * may still be the raw camera isolate. Sampling both at plain `uv()` with mixed
 * provenance mirrors one of them against the other — and because this pass is
 * one more RT hop before overBlit, the LAYER came out upside down while the
 * matte stayed put (measured on the app path: mirror of WebGL, matte upright).
 *
 * `flipTexture` reads the consumer at (u, 1−v), which on WebGPU is a storage-
 * IDENTITY copy (PORTING-GUIDE §3.6) — so the pass preserves a quad plate's
 * layout for the overBlit that follows, and the plain-read matte lands in the
 * same view orientation as the layer. The driver picks the variant by the
 * consumer's provenance (Player keeps one of each, like matteClip). The default
 * stays plain: html/webgpu-migration/port/composite.html binds two same-
 * provenance targets and is self-consistent without a flip.
 */
export function createTrackMatteNodeMaterial({ flipTexture = false } = {}) {
  const u = {
    uTexture: makeSampler(flipTexture), uMatte: makeSampler(), uLuma: uniform(0), uInvert: uniform(0),
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = uv();
    const c = u.uTexture.sample(uvn);
    const s = u.uMatte.sample(uvn);
    const lumaMatte = mix(s.a, dot(s.rgb, vec3(0.299, 0.587, 0.114)), u.uLuma);
    const m = mix(lumaMatte, float(1.0).sub(lumaMatte), u.uInvert);
    return c.mul(m);   // premultiplied: rgb and alpha scale together
  })();
  material.transparent = false;
  material.blending = THREE.NoBlending;
  return finish(material, u);
}

// ── 7/8. The two depth passes ───────────────────────────────────────────────
//
// These are the only two materials in the port that write fragment depth. The
// GLSL pair had to declare `glslVersion: GLSL3` to get `gl_FragDepth` at all —
// three compiles a ShaderMaterial as ES 1.00 even on a WebGL2 context, where the
// builtin does not exist and the link fails silently. TSL has no such trap:
// `material.depthNode` is the fragment depth, and the backend emits whatever the
// target language spells it.

const FAR_PLANE = 0.999999;

/**
 * Copies a model pass's depth into the bound depth buffer, touching no colour.
 * That is what lets a 2D layer be occluded by a model's real SURFACE rather than
 * its flat silhouette — a card can pass through a phone and be cut by it per
 * pixel. Both sides share one projection, so the copied values need no
 * linearisation.
 */
/**
 * The world's canvas split in one draw: the picture over its depth (src/world3d/WorldRenderer.js, #handoffNode) into a
 * colour plate and a real depth texture, in the compositor's own near/far. WebGPU only: a 3D Scene does not draw on the WebGL
 * engine, so this has no GLSL twin.
 */
export function createWorldPlateNodeMaterial({ worldNear, worldFar, worldUnits }) {
  // (vfx) uK1, uLens: the footage's lens. The world draws through a pinhole; a solved wide lens bends its plate by one radial term
  // (x_bent = x · (1 + k1·r²), x in focal lengths), so the world's picture is read where each bent pixel's ray came from. uLens is
  // the frame in focal lengths (W / f, H / f). k1 = 0 reads the picture exactly as before.
  // (vfx34) uSoften, uBlack, uTexel: the footage's own softness and black level (look.soften px, look.black of 1), so an object sits
  // in the plate: the world's picture, coverage with it, through a small blur, and its darks lifted to the plate's. 0, 0 skip both.
  // (vfx) uGrain, uGrainSeed: the footage's grain (look.grain, the world's own grain units: uniform noise of 0.14 · grain), laid on
  // here AFTER the softness, where the world's picture joins the footage. In the world's own pass the blur above took a softened
  // footage's grain down to a third (soften 0.7 px and up): the object came out cleaner than the shot. 0 skips it.
  // (polish1) uWorldNear, uWorldRatio: the world camera's clip planes (near, far / near), which follow its set (WorldRenderer #fitClip); the
  // canvas's depth band holds distance as a log across them
  const u = { uHandoff: makeSampler(), uNear: uniform(1), uFar: uniform(100000), uWorldNear: uniform(worldNear), uWorldRatio: uniform(worldFar / worldNear), uShadow: uniform(0), uK1: uniform(0), uLens: uniform(new THREE.Vector2(1, 1)),
    uSoften: uniform(0), uBlack: uniform(0), uTexel: uniform(new THREE.Vector2(1 / 1920, 1 / 2160)), uGrain: uniform(0), uGrainSeed: uniform(0), uSharpen: uniform(0),
    uBlackTint: uniform(new THREE.Vector3(1, 1, 1)),
    // (octane2) where each band sits in the canvas (v scale, offset): the picture over its depth, and with the editor's world mattes a third
    // band of masks below them (world3dLayer.js); uMask k > 0 draws mask k (1..3) as premultiplied white instead of the picture
    uPicY: uniform(new THREE.Vector2(0.5, 0.5)), uBandY: uniform(new THREE.Vector2(0.5, 0)), uMaskY: uniform(new THREE.Vector2(0.5, 0)), uMask: uniform(0) };
  const material = new THREE.MeshBasicNodeMaterial();
  const c = uv().sub(0.5);
  const d = c.mul(u.uLens);
  // r_straight = r_bent · s with s = 1 / (1 + k1·r_straight²): four fixed-point steps (|k1·r²| is a few hundredths on a 105° lens)
  let s = float(1);
  for (let i = 0; i < 4; i += 1) s = float(1).div(float(1).add(u.uK1.mul(dot(d, d).mul(s.mul(s)))));
  const lensOn = u.uK1.notEqual(0);
  const at = lensOn.select(c.mul(s).add(0.5), uv());
  // a bent pixel whose ray the pinhole frame never drew (the corners of a barrel lens) shows nothing of the world
  const inside = at.x.greaterThanEqual(0).and(at.x.lessThanEqual(1)).and(at.y.greaterThanEqual(0)).and(at.y.lessThanEqual(1));
  // A canvas uploads top row first, so the picture is the half at high v, and depth the half below it.
  // The shadows go straight onto the stack, which a layer's plate does not: that hop has the other parity on WebGPU.
  const v = u.uShadow.greaterThan(0.5).select(at.y.oneMinus(), at.y);
  const top = vec2(at.x, v.mul(u.uPicY.x).add(u.uPicY.y));
  const below = vec2(at.x, v.mul(u.uBandY.x).add(u.uBandY.y));
  // A canvas drops alpha, so coverage comes in the depth band.
  const band = u.uHandoff.sample(below);
  const sharp = lensOn.and(inside.not()).select(vec4(0, 0, 0, 0), vec4(u.uHandoff.sample(top).rgb, band.b));
  // The shadows alone: what has coverage and no surface.
  const empty = band.r.greaterThanEqual(0.999).and(band.g.greaterThanEqual(0.999));
  // (vfxlook) a tap off the picture's own half: the canvas holds the picture over its depth band, so a blur tap from the picture's bottom
  // row (or the band's top row) crossed into the other half and laid the depth band's yellow (r, g = far) along the frame's bottom edge
  // (curved by a wide lens's bend) — the blind judge's "thin gold line across the bottom". Each tap stays in its half (nearest texels).
  const pictureAt = (o) => u.uHandoff.sample(vec2(top.x.add(o.x), top.y.add(o.y).clamp(u.uPicY.y.add(u.uTexel.y.mul(0.5)), u.uPicY.y.add(u.uPicY.x).sub(u.uTexel.y.mul(0.5)))));
  const bandAt = (o) => u.uHandoff.sample(vec2(below.x.add(o.x), below.y.add(o.y).clamp(u.uBandY.y.add(u.uTexel.y.mul(0.5)), u.uBandY.y.add(u.uBandY.x).sub(u.uTexel.y.mul(0.5)))));
  const picture = Fn(() => {
    const col = vec4(sharp).toVar();
    If(u.uSoften.greaterThan(0), () => {
      // a 3 × 3 binomial kernel whose step is the softness over 0.707 (its own sigma at one texel): premultiplied colour and coverage
      // blur together, so an edge softens into the footage, not into black
      const acc = vec4(0, 0, 0, 0).toVar();
      const step = u.uTexel.mul(u.uSoften.div(0.7071));
      for (const [dx, dy, w] of [[0, 0, 4], [1, 0, 2], [-1, 0, 2], [0, 1, 2], [0, -1, 2], [1, 1, 1], [-1, 1, 1], [1, -1, 1], [-1, -1, 1]]) {
        const o = vec2(dx, dy).mul(step);
        acc.addAssign(vec4(pictureAt(o).rgb, bandAt(o).b).mul(w / 16));
      }
      col.assign(lensOn.and(inside.not()).select(vec4(0, 0, 0, 0), acc));
    });
    // (vfxlook) the footage's sharpening (look.sharpen, from how far its edges ring): the world's own detail, high-passed at one texel
    // (its picture less its 3 × 3 binomial), added where it covers itself all round — inside the object, never at its outline, where the
    // ring would have to be against footage this pass cannot see
    If(u.uSharpen.greaterThan(0), () => {
      const near = vec4(0, 0, 0, 0).toVar();
      for (const [dx, dy, w] of [[0, 0, 4], [1, 0, 2], [-1, 0, 2], [0, 1, 2], [0, -1, 2], [1, 1, 1], [-1, 1, 1], [1, -1, 1], [-1, -1, 1]]) {
        const o = vec2(dx, dy).mul(u.uTexel);
        near.addAssign(vec4(pictureAt(o).rgb, bandAt(o).b).mul(w / 16));
      }
      const inside = near.a.greaterThanEqual(0.995).and(sharp.a.greaterThanEqual(0.995));
      col.assign(vec4(col.rgb.add(inside.select(sharp.rgb.sub(near.rgb).mul(u.uSharpen), vec3(0, 0, 0))).max(0), col.a));
    });
    // the plate's black: the world's darkest is lifted to it where the world covers (premultiplied) — on its SURFACES only. A catcher's
    // shadow is the footage darkened, already at the footage's own black: lifted, it turned to a neutral grey veil over the warm table
    // (the blind judge: "a broad, neutral-grey haze ... dulls the table")
    If(u.uBlack.greaterThan(0).and(empty.not()), () => {
      // (vfxlook) toward the veil's own colour (look.blackTint, the shot's average colour at unit luminance): a neutral grey lift made
      // a dark object greyer and cooler than a warm shot round it
      col.assign(vec4(col.rgb.mul(float(1).sub(u.uBlack)).add(u.uBlackTint.mul(u.uBlack).mul(col.a)), col.a));
    });
    // the footage's grain over the softened picture, at the world's coverage (premultiplied), a new pattern each frame (uGrainSeed
    // moves it by whole pixels: the hash wants pixel centres)
    If(u.uGrain.greaterThan(0), () => {
      const n = stableHash12(screenCoordinate.xy.add(vec2(u.uGrainSeed.mul(173), u.uGrainSeed.mul(97)))).sub(0.5);
      col.assign(vec4(col.rgb.add(vec3(n.mul(u.uGrain).mul(0.14).mul(col.a))).max(0), col.a));
    });
    return col;
  })();
  // (octane2) a world matte's mask: its channel of the third band, as premultiplied white (nothing outside a bent lens's frame)
  const maskBand = u.uHandoff.sample(vec2(at.x, v.mul(u.uMaskY.x).add(u.uMaskY.y)));
  const maskValue = u.uMask.lessThan(1.5).select(maskBand.r, u.uMask.lessThan(2.5).select(maskBand.g, maskBand.b));
  const mask = lensOn.and(inside.not()).select(float(0), maskValue);
  // (item 20) A sky the layers below show through (`background: 'env'` without `opaque`) is the panorama, drawn with full coverage, at the
  // far plane: the depth composite drops every far-plane pixel of a 3D pass, which is what lets the layers below through. A Scene layer with a
  // stack of its own (the Camera layer's depth of field, a glow, an effect) goes over the stack without that test, and the panorama came with
  // it: the whole sky, blurred, over the layers below. Here the far plane holds nothing, as a model's pass does; a catcher's shadow is the
  // shadow pass's (uShadow), and an opaque sky, gas against the sky and flat letters all stand at a depth of their own.
  const shadowPass = u.uShadow.greaterThan(0.5);
  material.colorNode = u.uMask.greaterThan(0.5).select(vec4(mask, mask, mask, mask),
    shadowPass.and(empty.not()).or(shadowPass.not().and(empty)).select(vec4(0, 0, 0, 0), picture));
  material.depthNode = Fn(() => {
    const packed = u.uHandoff.sample(below);
    const encoded = packed.r.mul(255).round().add(packed.g).div(255);
    const distance = u.uWorldNear.mul(u.uWorldRatio.pow(encoded)).div(float(worldUnits));
    const depth = u.uFar.mul(distance.sub(u.uNear)).div(u.uFar.sub(u.uNear).mul(distance));
    const far = packed.r.greaterThanEqual(0.999).and(packed.g.greaterThanEqual(0.999)).or(lensOn.and(inside.not()));
    return far.select(float(1), depth.min(0.99999));
  })();
  material.transparent = false;
  material.blending = THREE.NoBlending;     // an opaque NormalBlending material has its alpha forced to 1
  material.toneMapped = false;
  material.depthTest = true;
  material.depthFunc = THREE.AlwaysDepth;
  material.depthWrite = true;
  material.uniforms = u;
  return material;
}

/**
 * (vfx) Light wrap: the footage's own light round a placed object, wrapped onto the object's edge — what a real lens does with a bright
 * table or a window behind a dark camera body, and what keeps a rendered object from reading as cut out (the blind judge: "a hard outline,
 * none of the glow that bright areas spread onto nearby edges"). Drawn over the stack right after the world's picture landed in it,
 * while the footage under it is held aside (adjustmentComposite.js, the locked lead): per pixel, the footage round it where the world
 * is NOT (two rings of taps, `uRadius` in uv), mixed into the object's colour by how open its neighbourhood is (an edge, not the
 * middle) times `uAmount`. Alpha untouched (blending set by the caller: colour One / OneMinusSrcAlpha, alpha Zero / One).
 *   uPlate: the footage held aside (a storage-identity copy of the stack, read flipped); uWorld: the world's picture as the stack took it.
 */
export function createLightWrapNodeMaterial() {
  // uDepth: the world's depth as the stack took it (read flipped, as createDepthCompositeNodeMaterial reads it): only a SURFACE takes
  // the wrap; a catcher's shadow (coverage with no depth) is footage, and counts as the light round the object
  const u = { uPlate: makeSampler(true), uWorld: makeSampler(), uDepth: makeSampler(true), uRadius: uniform(new THREE.Vector2(0.005, 0.009)), uAmount: uniform(0) };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const p = uv();
    const surface = (q) => u.uDepth.sample(q).r.lessThan(FAR_PLANE).select(float(1), float(0));
    const a = u.uWorld.sample(p).a.mul(surface(p));
    Discard(a.lessThan(0.004));
    const bg = vec3(0, 0, 0).toVar();
    const open = float(0).toVar();
    const N = 12;
    for (const ring of [0.5, 1]) {
      for (let k = 0; k < N; k += 1) {
        const ang = ((k + (ring === 1 ? 0.5 : 0)) / N) * Math.PI * 2;
        const o = vec2(Math.cos(ang) * ring, Math.sin(ang) * ring).mul(u.uRadius);
        const w = float(1).sub(u.uWorld.sample(p.add(o)).a.mul(surface(p.add(o)))).max(0);
        bg.addAssign(u.uPlate.sample(p.add(o)).rgb.mul(w));
        open.addAssign(w);
      }
    }
    const frac = open.div(2 * N);
    const m = frac.mul(u.uAmount).min(1);
    // src = (m · a · bg, m): the blend leaves dst · (1 − m) + m · a · bg, i.e. the object's colour mixed toward the light round it
    return vec4(bg.div(open.max(1e-4)).mul(a).mul(m), m);
  })();
  material.transparent = true;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
  return finish(material, u);
}

export function createDepthStampNodeMaterial() {
  const u = {
    uDepth: makeSampler(),
    // Unused by the graph — the fullscreen quad's uv() IS gl_FragCoord/uResolution
    // at every pixel centre — but the app's writers set it, so it stays.
    uResolution: uniform(new THREE.Vector2(1, 1)),
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    // 1.0 is the CLEARED far plane: nothing was drawn there, so leave the buffer
    // alone rather than stamping the far plane over whatever else is in it.
    // WGSL's `discard` drops the depth write too, which is the whole point here.
    Discard(u.uDepth.sample(uv()).r.greaterThanEqual(FAR_PLANE));
    return vec4(0.0);
  })();
  material.depthNode = Fn(() => u.uDepth.sample(uv()).r)();
  material.colorWrite = false;
  material.transparent = false;
  material.uniforms = u;
  // Depth only, and unlike every other material here the test is ON: a model
  // must not stamp itself over something already nearer. The write is what later
  // layers are then cut against.
  material.depthTest = true;
  material.depthWrite = true;
  material.forceSinglePass = true;
  return material;
}

export function createFootageDepthStampNodeMaterial() {
  const u = {
    uDepth: makeSampler(),
    uColor: makeSampler(),
    uHasColor: uniform(0),
    uResolution: uniform(new THREE.Vector2(1, 1)),
    uFxOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uFxAxisX: uniform(new THREE.Vector2(0.5, 0)),
    uFxAxisY: uniform(new THREE.Vector2(0, 0.5)),
    uFxHom: uniform(new THREE.Matrix3()),
    uFxHomInv: uniform(new THREE.Matrix3()),
    uInvert: uniform(0),
    uDepthNearM: uniform(0.4),
    uDepthFarM: uniform(8.0),
    uCamNear: uniform(1),
    uCamFar: uniform(100000),
  };
  const fxLocal = (uvn) => {
    const h = u.uFxHomInv.mul(vec3(uvn.x, uvn.y, 1.0)).toVar();
    return select(h.z.lessThan(1e-6), vec2(-1e3, -1e3), h.xy.div(tslMax(h.z, 1e-6)));
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = screenCoordinate.xy.div(tslMax(vec2(1.0, 1.0), u.uResolution));
    const colA = u.uColor.sample(uv()).a;
    Discard(u.uHasColor.greaterThan(0.5).and(colA.lessThan(0.01)));
    const p = fxLocal(uvn);
    Discard(p.x.lessThan(0.0).or(p.x.greaterThan(1.0)).or(p.y.lessThan(0.0)).or(p.y.greaterThan(1.0)));
    return vec4(0.0);
  })();
  material.depthNode = Fn(() => {
    const uvn = screenCoordinate.xy.div(tslMax(vec2(1.0, 1.0), u.uResolution));
    const p = clamp(fxLocal(uvn), 0.0, 1.0);
    const raw0 = clamp(u.uDepth.sample(p).r, 0.0, 1.0);
    const raw = select(u.uInvert.greaterThan(0.5), raw0.oneMinus(), raw0);
    const invNear = float(1.0).div(tslMax(float(0.05), u.uDepthNearM));
    const invFar = float(1.0).div(tslMax(float(0.1), u.uDepthFarM));
    const invDist = mix(invFar, invNear, raw);
    const distPx = float(1000.0).div(tslMax(float(1e-4), invDist));
    const z = clamp(distPx, u.uCamNear.mul(1.01), u.uCamFar.mul(0.99));
    return clamp(u.uCamFar.mul(z.sub(u.uCamNear)).div(u.uCamFar.sub(u.uCamNear).mul(z)), 0.0, 0.99999);
  })();
  material.colorWrite = false;
  material.transparent = false;
  material.uniforms = u;
  material.depthTest = true;
  material.depthWrite = true;
  material.forceSinglePass = true;
  return material;
}

/**
 * (gaps1) A model pass filmed by a world Scene's orthographic camera writes depth that runs straight with distance; the compositor and the
 * world's plate keep depth as a perspective camera with the same near/far writes it. This rewrites one into the other, pixel for pixel
 * (distance = near + d (far - near), then the perspective depth of that distance), so the model sorts against the world and every other
 * layer as before. Nothing there (the cleared far plane) stays at the far plane. Depth only, written over whatever the target held.
 */
export function createOrthoDepthNodeMaterial() {
  const u = { uDepth: makeSampler(), uNear: uniform(1), uFar: uniform(100000) };
  const material = new THREE.MeshBasicNodeMaterial();
  // SCREEN UV, as the model pass's tone step reads its HDR target (model3dNodes.js): the pass's depth is read and written at the same
  // pixel of the frame, so the depth handed on keeps a filmed target's orientation (createDepthCompositeNodeMaterial flips for it)
  material.fragmentNode = Fn(() => {
    Discard(u.uDepth.sample(screenUV).r.greaterThanEqual(FAR_PLANE));
    return vec4(0.0);
  })();
  material.depthNode = Fn(() => {
    const d = u.uDepth.sample(screenUV).r;
    const z = u.uNear.add(d.mul(u.uFar.sub(u.uNear)));
    return u.uFar.mul(z.sub(u.uNear)).div(u.uFar.sub(u.uNear).mul(z)).min(0.99999);
  })();
  material.colorWrite = false;
  material.transparent = false;
  material.uniforms = u;
  material.depthTest = false;
  material.depthWrite = true;
  material.forceSinglePass = true;
  return material;
}

/**
 * Colour + real depth for a camera-baked 3D pass.
 *
 * A model or plate reaches the compositor as a full-frame colour texture whose
 * proxy quad has no useful Z of its own, so stamping depth AFTER drawing colour
 * lets the whole proxy overwrite an earlier 3D layer before the depth test runs.
 * Writing the sampled depth at the same time as the premultiplied colour
 * resolves two crossing surfaces per pixel instead of by channel order.
 */
export function createDepthCompositeNodeMaterial({ linear = false, hdr = false } = {}) {
  const u = {
    uColor: makeSampler(),
    // (mblur3) `linear`: the stack under it as it stood before this draw (a storage-identity copy, read flipped as the light wrap reads its
    // held plate), for the blend in linear light below
    ...(linear ? { uBelow: makeSampler(true) } : {}),
    /*
     * FLIPPED, for the same reason the model pass's tone step reads at
     * `screenUV`: a render target's DEPTH attachment carries WebGPU's
     * orientation just as its colour does, so sampling it at the quad's `uv()`
     * pairs each colour texel with the depth of the texel mirrored across the
     * frame. Measured on the "3d Rig test" project: 153275 differing pixels
     * without this, 4402 with it.
     */
    uDepth: makeSampler(true),
    /*
     * Depth for pixels the source left at the cleared far plane. A model or a
     * filmed plate has nothing there and discards (-1); an ordinary layer's
     * glow, shadow and blur spill DO belong to the frame, at the depth of the
     * plane they spilled from — anything else lets an effect change what
     * occludes what.
     */
    uFallback: uniform(-1),
    // One depth texel, for the silhouette-edge probe (see the GLSL).
    uDepthTexel: uniform(new THREE.Vector2(1 / 1280, 1 / 720)),
    // Opaque + transparent depth and which pixels this draw takes (see the GLSL).
    uTDepth: makeSampler(true),
    uPass: uniform(0),
    // See createOverBlitNodeMaterial — same premultiplied blend-mode identity.
    uBlendIdentity: uniform(new THREE.Vector3(0, 0, 0)),
  };
  const uvn = uv();
  const material = new THREE.MeshBasicNodeMaterial();
  /*
   * The GLSL nests the far-plane test inside the discard branch. Flattened here
   * to two independent discards, which is the same predicate: drop the fragment
   * if it is transparent, OR if it sits at the cleared far plane with no
   * fallback to stand in for it.
   */
  material.fragmentNode = Fn(() => {
    const color = u.uColor.sample(uvn);
    // A transparent pixel must never become an invisible depth wall. (lookfix) In linear light a faint pixel is not invisible: 2 % of a bright
    // object over a dark layer is 20 display levels, and a lens-blurred or moving edge dropped below 2 % ended on a hard, ragged line. There it
    // is drawn down to half a level of coverage, standing at the far plane (below), so it occludes nothing
    Discard(color.a.lessThan(linear ? 0.5 / 255 : 0.02));
    // A card — a transparent surface where the pass has no opaque surface of its
    // own: pass 2 only (see the GLSL).
    const tdepth = u.uTDepth.sample(uvn).r;
    const opaqueDepth = u.uDepth.sample(uvn).r;
    const card = tdepth.lessThan(FAR_PLANE).and(opaqueDepth.greaterThanEqual(FAR_PLANE));
    Discard(u.uPass.greaterThan(0.5).and(u.uPass.lessThan(1.5)).and(card));
    Discard(u.uPass.greaterThan(1.5).and(card.not()));
    Discard(u.uDepth.sample(uvn).r.greaterThanEqual(FAR_PLANE).and(u.uFallback.lessThan(0.0)).and(u.uPass.lessThan(1.5)));
    if (!linear) return vec4(color.rgb.add(u.uBlendIdentity.mul(float(1.0).sub(color.a))), color.a);
    // (mblur3) A 3D Scene's frame traced moving over a see-through sky: its coverage is the share of the shutter the world spends on the pixel,
    // so it goes over the stack in linear light (what the same frame filmed as many sub-frames, each composited, then averaged as light
    // gives), not in display values: lin = a·L(c) + (1 − a)·Lp(below), premultiplied in and out, sRGB to linear and back. A pixel the world
    // covers whole, or not at all, is what the plain blend gives
    const below = u.uBelow.sample(uvn);
    // (hdr3) `hdr`: an HDR render's float composite (both the Scene's frame and the stack hold light above white): read and written as it is
    const toLin = hdr ? hybridToLin : (c) => select(c.lessThanEqual(vec3(0.04045)), c.div(12.92), pow(c.add(0.055).div(1.055), vec3(2.4)));
    const toDisplay = hdr ? linToHybrid : (c) => select(c.lessThanEqual(vec3(0.0031308)), c.mul(12.92), pow(c, vec3(1 / 2.4)).mul(1.055).sub(0.055));
    const top = (c) => (hdr ? tslMax(c, vec3(0)) : c.clamp(0, 1));
    const a = color.a.clamp(0, 1), b = below.a.clamp(0, 1);
    const lin = toLin(top(color.rgb.div(tslMax(a, 1e-4)))).mul(a)
      .add(toLin(top(below.rgb.div(tslMax(b, 1e-4)))).mul(b).mul(float(1).sub(a)));
    const outA = a.add(b.mul(float(1).sub(a)));
    return vec4(toDisplay(lin.div(tslMax(outA, 1e-4))).mul(outA), outA);
  })();
  // Survivors at the far plane are exactly the ones with a usable fallback, so
  // the select needs no second guard.
  material.depthNode = Fn(() => {
    /*
     * Both depths are read HERE, unconditionally, before any select. A depth
     * texture is read with textureLoad at its textureDimensions, and TSL emits
     * that size into a variable once per texture, at its first use — this
     * depth output is generated ahead of the fragment body. Read inside the
     * select's branches, each size was assigned only on its own branch, and the
     * fragment's card test then loaded the OTHER depth at texel (0, 0): pass 1
     * saw no card anywhere and pass 2 saw a card everywhere, so a soft shadow
     * card wrote depth (a black disc) and the solid body skipped it.
     */
    const rawDepth = u.uDepth.sample(uvn).r.toVar();
    const tdepth = u.uTDepth.sample(uvn).r.toVar();
    // An antialiased silhouette edge the depth resolve missed stands with the
    // surface beside it; only true spill takes the fallback (see the GLSL). The
    // probe is symmetric, so the flipped binding needs no offset correction.
    const tx = vec2(u.uDepthTexel.x, 0.0);
    const ty = vec2(0.0, u.uDepthTexel.y);
    const edge = tslMin(
      tslMin(u.uDepth.sample(uvn.add(tx)).r, u.uDepth.sample(uvn.sub(tx)).r),
      tslMin(u.uDepth.sample(uvn.add(ty)).r, u.uDepth.sample(uvn.sub(ty)).r));
    const missing = select(edge.lessThan(FAR_PLANE), edge, u.uFallback);
    const opaque = select(rawDepth.greaterThanEqual(FAR_PLANE), missing, rawDepth);
    // A card is nudged toward the camera like a decal (see the GLSL).
    const placed = select(u.uPass.greaterThan(1.5), tdepth.sub(float(1.0).sub(tdepth).mul(0.002)), opaque);
    // (lookfix) a linear draw's faint pixel (under the 2 % an ordinary draw drops) at the far plane: drawn, never a wall
    return linear ? select(u.uColor.sample(uvn).a.lessThan(0.02), float(1.0), placed) : placed;
  })();
  material.transparent = true;
  // The isolated source texture is premultiplied by its coverage — the GLSL side
  // spells this applyPremultipliedBlendMode(material, 'normal').
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  // (mblur3) the linear blend writes the whole result (it read the stack itself): the pixel is replaced
  if (linear) {
    material.blendSrc = THREE.OneFactor; material.blendDst = THREE.ZeroFactor;
    material.blendSrcAlpha = THREE.OneFactor; material.blendDstAlpha = THREE.ZeroFactor;
  }
  material.depthTest = true;
  material.depthWrite = true;
  material.forceSinglePass = true;
  material.uniforms = u;
  return material;
}

// ── 9. Matte clip ───────────────────────────────────────────────────────────

/*
 * Frame UV from screenCoordinate — same convention as effect bodies / DOF probe.
 *
 * The MATTE isolate and the effect ping-pong RT do not share a V axis on WebGPU
 * (measured: same UV on both shreds the silhouette; texture plain + matte
 * flipped matches WebGL). The HTML labs never run applyMatteClip, which is why
 * they stayed green while the app shredded grain/vignette/curves/….
 */
const frameUv = (uResolution) => screenCoordinate.xy.div(uResolution);

/**
 * Keeps a layer effect inside the layer's real shape. `uMatte` is the layer
 * rendered ALONE before DOF and glow, so its alpha is the genuine silhouette —
 * glyph outlines, a traced path, a stroke, a PNG's cutout. Both textures are
 * premultiplied, so scaling rgba by coverage is the correct fringe-free cut with
 * no unpremultiply round trip.
 */
export function createMatteClipNodeMaterial({ flipMatte = true } = {}) {
  const u = {
    uTexture: makeSampler(),
    /*
     * Isolate / matte plate needs the RT V-flip; the effect chain target does
     * not. A 3D MODEL's isolate is the exception: it is produced by the model
     * pass, whose tone step reads its source at `screenUV`, so it already
     * arrives in the effect chain's orientation. Multiplying it by a flipped
     * copy of itself cuts the model down to its silhouette ∩ its own mirror —
     * measured at 99.97% agreement with that prediction, and worth 338776
     * differing pixels on the "TEST 3d" project.
     */
    uMatte: makeSampler(flipMatte),
    uResolution: uniform(new THREE.Vector2(1280, 720)),
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = frameUv(u.uResolution);
    return u.uTexture.sample(uvn).mul(u.uMatte.sample(uvn).a);
  })();
  material.transparent = true;
  material.blending = THREE.NoBlending;
  material.userData.matteClipUv = 'texPlain-matteFlipY';
  return finish(material, u);
}

// ── 10. Camera depth of field ───────────────────────────────────────────────

const GOLDEN_ANGLE = 2.39996323;
const HIGHLIGHT_THRESHOLD = 0.72;
const DOF_MAX_SAMPLES = 40;

// GLSL `mod(abs(p), 2.0)` — the argument is non-negative, so floor-mod and
// TSL's truncating `%` agree here and no glslMod helper is needed.
const dofMirrorUv = (p) => {
  const m = abs(p).mod(2.0);
  return mix(m, vec2(2.0).sub(m), step(1.0, m));
};

// Straight-alpha highlight boost, re-premultiplied. Guarded on alpha because
// dividing a fully transparent texel by its own alpha is where bloom picks up
// the colour of pixels nobody can see. Shared by both DOF passes.
const dofBoostedSample = (u) => (uvIn, lod) => {
  const s = u.uTexture.sample(dofMirrorUv(uvIn)).level(lod).toVar();
  const straight = s.rgb.div(tslMax(s.a, 0.00001));
  const luma = dot(straight, vec3(0.2126, 0.7152, 0.0722));
  const boost = float(1.0).add(tslMax(float(0.0), luma.sub(HIGHLIGHT_THRESHOLD)).mul(u.uHighlightGain));
  const boosted = vec4(straight.mul(boost).mul(s.a), s.a);
  return select(s.a.lessThanEqual(0.00001).or(u.uHighlightGain.lessThanEqual(0.00001)), s, boosted);
};

// The mip level of the spacing between taps when the source has mips (see the
// GLSL tapLod): a wide gather reads thin detail prefiltered instead of aliased.
const dofTapLod = (u, spacingPx) => select(u.uMipOn.greaterThan(0.5), log2(tslMax(float(1.0), spacingPx)), float(0.0));

// How much of the circle of confusion survives at this fragment (focus area).
const dofFocusFalloff = (u, fragXY) => select(
  u.uFocusOuterPx.lessThanEqual(0.0), float(1.0),
  smoothstep(u.uFocusInnerPx, u.uFocusOuterPx, distance(fragXY, u.uFocusPointPx)),
);

/**
 * Golden-angle spiral bokeh with a highlight boost and a focus hold-off.
 *
 * The sample count is a UNIFORM in the GLSL, with a `break` out of a fixed
 * 40-iteration loop — so the loop bound stays constant here and `Break()` does
 * the same job.
 *
 * The port's important orientation wrinkle is in the OFFSET, not the centre UV.
 * A centre sample hides the render-target inversion because read and write
 * orientation cancel. An off-centre +Y tap does not, so WebGPU negates the tap's
 * Y component below while leaving the centre coordinate unchanged. The focused
 * composite sweep covers one through forty samples and now stays within one
 * channel level of WebGL.
 */
export function createCameraDofNodeMaterial() {
  const u = {
    uTexture: makeSampler(),
    uResolution: uniform(new THREE.Vector2(1280, 720)),
    uRadiusPx: uniform(0),
    uHighlightGain: uniform(0),
    uSamples: uniform(40),
    uMipOn: uniform(0),
    uFocusPointPx: uniform(new THREE.Vector2(0, 0)),
    uFocusInnerPx: uniform(0),
    uFocusOuterPx: uniform(0),
  };

  /*
   * The spiral's per-pixel rotation, transcribed from the GLSL exactly.
   *
   * It was the prime suspect for the DOF residual and it is NOT the cause —
   * measured, and the measurement is worth keeping. Swapping this for the
   * bit-identical integer mix in tslStableHash.js left the two sides computing
   * ENTIRELY DIFFERENT rotations, and the DOF states barely moved
   * (0.4280 -> 0.4304, 2.4756 -> 2.4766). If the rotation choice mattered, that
   * change would have been dramatic in one direction or the other; instead the
   * spiral averages it out.
   *
   * So the hash stays matched to the GLSL. Adopting the stable mix would mean
   * changing BOTH implementations, which belongs with the §5 removal of the
   * GLSL path rather than being smuggled in as a parity fix that fixes nothing.
   */
  // The stable integer mix, matching cameraDof.js's GLSL exactly. See
  // tslStableHash.js for why the pixel index is the input.
  const hash12 = (p) => stableHash12(p);
  const boostedSample = dofBoostedSample(u);

  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const vUv = uv();
    /*
     * NO FLIP — measured, and the opposite of what an earlier matte-clip port did.
     * `?mode=fragcoord` on the port page renders gl_FragCoord.xy/uResolution on
     * both backends: unflipped is max Δ 0, flipped is max Δ 255. TSL's
     * screenCoordinate already IS gl_FragCoord. Matte clip used to flip and
     * shredded every layer-clipped overlay effect; it now matches this probe.
     *
     * DOF's hash and focus distance sample nothing, so there is nothing to
     * compensate with a texture-space flip either.
     */
    const fragXY = screenCoordinate.xy;
    // How much of this layer's circle of confusion survives here.
    const falloff = dofFocusFalloff(u, fragXY);
    const radiusPx = u.uRadiusPx.mul(falloff).toVar();
    const out = vec4(0.0).toVar();
    If(radiusPx.lessThan(0.25), () => {
      out.assign(u.uTexture.sample(vUv));
    }).Else(() => {
      const lod = dofTapLod(u, radiusPx.mul(1.4).div(sqrt(tslMax(float(1.0), u.uSamples)))).toVar();
      const sum = boostedSample(vUv, lod).toVar();
      const total = float(1.0).toVar();
      const rotation = hash12(fragXY).mul(6.2831853);
      Loop({ start: int(0), end: int(DOF_MAX_SAMPLES), type: 'int' }, ({ i }) => {
        If(float(i).greaterThanEqual(u.uSamples), () => { Break(); });
        const fi = float(i).add(0.5);
        const radius = sqrt(fi.div(tslMax(float(1.0), u.uSamples))).mul(radiusPx);
        const angle = fi.mul(GOLDEN_ANGLE).add(rotation);
        const offset = vec2(cos(angle), sin(angle)).mul(radius).div(u.uResolution);
        // Sampling exactly where the fragment writes hides render-target
        // orientation because the two flips cancel. A visual +Y OFFSET does not:
        // WebGPU's render-target texture axis runs opposite to WebGL's here, so
        // negate only the offset while keeping the centre sample untouched.
        sum.addAssign(boostedSample(vUv.add(vec2(offset.x, offset.y.negate())), lod));
        total.addAssign(1.0);
      });
      out.assign(sum.div(total));
    });
    return out;
  })();
  material.transparent = false;
  material.blending = THREE.NoBlending;
  return finish(material, u);
}

const DOF_SPREAD_MAX_SAMPLES = 20;

/**
 * Depth-aware DOF for a camera-baked 3D pass — the twin of cameraDof.js's
 * createCameraDofDepthMaterial; read its header for the two gathers.
 *
 * Orientation: every tap reads colour and depth at the SAME coordinate, both
 * plain. The colour arrives through plateToCameraAxis (a 3D pass's isolate is
 * upright, so it is blitted once onto the camera axis first), which is exactly
 * the orientation of the pass's depth attachment — createDepthCompositeNodeMaterial
 * flips its depth only because it pairs it with the UPRIGHT isolate. The tap
 * offset's Y is negated as in the layer pass.
 */
export function createCameraDofDepthNodeMaterial() {
  const u = {
    uTexture: makeSampler(),
    uDepth: makeSampler(),
    uResolution: uniform(new THREE.Vector2(1280, 720)),
    uHighlightGain: uniform(0),
    uSamples: uniform(40),
    uSpreadSamples: uniform(20),
    uMipOn: uniform(0),
    uFocusPointPx: uniform(new THREE.Vector2(0, 0)),
    uFocusInnerPx: uniform(0),
    uFocusOuterPx: uniform(0),
    uNear: uniform(1),
    uFar: uniform(1000),
    uFocusDistance: uniform(1000),
    uCocScale: uniform(0),
    uMaxCocPx: uniform(64),
    uReachPx: uniform(0),
    uSpreadPx: uniform(0),
    uDepthTexel: uniform(new THREE.Vector2(1 / 1280, 1 / 720)),
  };
  const boostedSample = dofBoostedSample(u);
  // View distance at a uv, or -1 where the pass drew nothing.
  const viewDistanceAt = (uvIn) => {
    const d = u.uDepth.sample(uvIn).r;
    return select(d.greaterThanEqual(FAR_PLANE), float(-1.0),
      u.uNear.mul(u.uFar).div(u.uFar.sub(d.mul(u.uFar.sub(u.uNear)))));
  };
  // modelDof.cocAtDistance, in target px.
  const cocOf = (dist) => tslMin(u.uMaxCocPx, u.uCocScale.mul(abs(u.uFocusDistance.sub(dist))).div(tslMax(dist, 1.0)));
  const tapAt = (vUv, angle, radius) => {
    const offset = vec2(cos(angle), sin(angle)).mul(radius).div(u.uResolution);
    return vUv.add(vec2(offset.x, offset.y.negate()));
  };

  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const vUv = uv();
    const fragXY = screenCoordinate.xy;
    const falloff = dofFocusFalloff(u, fragXY);
    const centerRaw = viewDistanceAt(vUv).toVar();
    // An antialiased silhouette edge belongs to the surface beside it (see the GLSL).
    If(centerRaw.lessThan(0.0).and(u.uTexture.sample(vUv).a.greaterThan(0.004)), () => {
      const tx = vec2(u.uDepthTexel.x, 0.0);
      const ty = vec2(0.0, u.uDepthTexel.y);
      centerRaw.assign(tslMax(
        tslMax(viewDistanceAt(vUv.add(tx)), viewDistanceAt(vUv.sub(tx))),
        tslMax(viewDistanceAt(vUv.add(ty)), viewDistanceAt(vUv.sub(ty)))));
    });
    const centerEmpty = centerRaw.lessThan(0.0);
    const centerDist = select(centerEmpty, float(1e30), centerRaw).toVar();
    // An empty pixel has nothing of its own to blur: it only receives what blurred
    // surfaces scatter onto it, out to the pass's largest CoC (see the GLSL).
    const cc = select(centerEmpty, float(0.0), cocOf(centerRaw).mul(falloff)).toVar();
    const spread = select(centerEmpty, u.uReachPx, u.uSpreadPx).mul(falloff).toVar();
    const out = vec4(0.0).toVar();
    If(cc.lessThan(0.25).and(spread.lessThan(0.25)), () => {
      out.assign(u.uTexture.sample(vUv));
    }).Else(() => {
      const rotation = stableHash12(fragXY).mul(6.2831853).toVar();
      const lodOwn = dofTapLod(u, cc.mul(1.4).div(sqrt(tslMax(float(1.0), u.uSamples)))).toVar();
      const sum = boostedSample(vUv, lodOwn).toVar();
      const total = float(1.0).toVar();
      If(cc.greaterThanEqual(0.25), () => {
        Loop({ start: int(0), end: int(DOF_MAX_SAMPLES), type: 'int' }, ({ i }) => {
          If(float(i).greaterThanEqual(u.uSamples), () => { Break(); });
          const fi = float(i).add(0.5);
          const radius = sqrt(fi.div(tslMax(float(1.0), u.uSamples))).mul(cc);
          const tapUv = tapAt(vUv, fi.mul(GOLDEN_ANGLE).add(rotation), radius);
          const tapRaw = viewDistanceAt(dofMirrorUv(tapUv));
          const tapOwn = select(tapRaw.lessThan(0.0), cc, cocOf(tapRaw).mul(falloff));
          // A tap behind this pixel may blur no further over it than it blurs itself.
          const tapCoc = select(tapRaw.greaterThan(centerDist), tslMin(tapOwn, cc), tapOwn);
          const w = smoothstep(radius.sub(1.0), radius, tapCoc);
          // An empty tap is read unfiltered: transparency, not its neighbours' colour.
          sum.addAssign(boostedSample(tapUv, select(tapRaw.lessThan(0.0), float(0.0), lodOwn)).mul(w));
          total.addAssign(w);
        });
      });
      const own = sum.div(total).toVar();
      out.assign(own);
      If(spread.greaterThan(cc.add(0.25)), () => {
        const fg = vec4(0.0).toVar();
        const cover = float(0.0).toVar();
        const n = tslMax(float(1.0), u.uSpreadSamples);
        const span = spread.sub(cc);
        const lodSpread = dofTapLod(u, span.div(n).mul(1.4)).toVar();
        Loop({ start: int(0), end: int(DOF_SPREAD_MAX_SAMPLES), type: 'int' }, ({ i }) => {
          If(float(i).greaterThanEqual(u.uSpreadSamples), () => { Break(); });
          const fj = float(i).add(0.5);
          // Evenly spaced radii outside the own disk (see the GLSL).
          const radius = cc.add(span.mul(fj).div(n));
          const tapUv = tapAt(vUv, fj.mul(GOLDEN_ANGLE).add(rotation).add(1.0), radius);
          const tapRaw = viewDistanceAt(dofMirrorUv(tapUv));
          const tapCoc = cocOf(tapRaw).mul(falloff);
          // Only a NEARER surface whose (non-trivial) blur reaches here.
          const reaches = tapRaw.greaterThanEqual(0.0).and(tapRaw.lessThan(centerDist)).and(tapCoc.greaterThanEqual(2.0));
          const w = select(reaches, smoothstep(radius.sub(1.0), radius, tapCoc), float(0.0));
          // Its ring's area over its blur disk, capped so one tap never decides alone.
          const c = tslMin(float(0.5), w.mul(2.0).mul(radius).mul(span).div(n.mul(tslMax(tapCoc.mul(tapCoc), 1.0))));
          fg.addAssign(boostedSample(tapUv, lodSpread).mul(c));
          cover.addAssign(c);
        });
        If(cover.greaterThan(0.0), () => {
          out.assign(mix(own, fg.div(cover), tslMin(cover, 1.0)));
        });
      });
    });
    return out;
  })();
  material.transparent = false;
  material.blending = THREE.NoBlending;
  return finish(material, u);
}

// ── (hdr2) An HDR render through 2D layers (hdrComposite.js) ────────────────
//
// The compositor works in display values (sRGB bytes, premultiplied). An HDR render that has 2D layers with its Scene composites the frame a
// second time into half floats, with the Scene's plate carrying the world's own light; these three passes are its own. Each reads its inputs
// texel for texel (textureLoad at the fragment's own pixel), so the storage layout it writes is the layout it read: no V hop to count.

/**
 * The world's HDR picture as the plate the compositor takes: the world's own light past its tone pass (linear BT.709, 1 = SDR white:
 * WorldRenderer.hdrPixels) in the compositor's terms — (hdr3) display values up to white, LIGHT above it (a channel past 1 is its light
 * as it is: 1000 cd/m² = 4.93) — premultiplied by the coverage of the SDR plate it stands in for (world3dLayer.js ensurePlate). Every layer,
 * blend, fade and mask then meets it as it meets the SDR plate, so below white it IS the SDR plate's picture (unquantized) and the SDR
 * export's blends are untouched, while above white the same blends act on light: a 50 % fade of a 1000 cd/m² glint is 500 cd/m² (the
 * sRGB curve carried on above 1, round 2, gave 200). A pixel the SDR plate leaves empty (a catcher's shadow alone) stays empty.
 * `straight`: the world's light is straight colour (a render that keeps alpha); otherwise it is the picture over black, as the plate's.
 * `flip`: the world's rows run the other way from the plate's. Returns { material, bind(hdr, sdr) }.
 */
export function createHdrPlateNodeMaterial({ hdr, sdr, straight = false, flip = false, height = 1 }) {
  const uHeight = uniform(height);
  // (hdr3) the Scene layer's own grade (its brightness, contrast, saturation, hue, grayscale, sepia, invert, tint: the clip shader's order),
  // applied here to its light with the slope rule (gradeHybrid) while the layer draws this plate ungraded (engine/layerMesh.js)
  const g = { uGrade: uniform(0), uBright: uniform(1), uContrast: uniform(1), uSat: uniform(1), uHue: uniform(0), uGray: uniform(0),
    uSepia: uniform(0), uInvert: uniform(0), uTint: uniform(new THREE.Color(1, 1, 1)) };
  const sceneGrade = (cIn) => {
    let c = cIn.mul(g.uBright);
    c = c.sub(0.5).mul(g.uContrast).add(0.5);
    c = mix(vec3(dot(c, LUMA_709)), c, g.uSat);
    c = select(g.uHue.abs().greaterThan(0.5), applyHueRotation(c, g.uHue), c);
    c = mix(c, vec3(dot(c, LUMA_709)), clamp(g.uGray, 0.0, 1.0));
    const sepia = vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131)));
    c = mix(c, sepia, clamp(g.uSepia, 0.0, 1.0));
    c = mix(c, vec3(1.0).sub(c), clamp(g.uInvert, 0.0, 1.0));
    return c.mul(g.uTint);
  };
  const p = ivec2(screenCoordinate.xy);
  const sdrNode = textureLoad(sdr, p);
  const row = flip ? int(uHeight).sub(1).sub(p.y) : p.y;
  const hdrNode = textureLoad(hdr, ivec2(p.x, row));
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const cover = sdrNode.a;
    // the world's light: straight when the render keeps alpha; otherwise the light of the premultiplied picture it hands the compositor
    // (WorldRenderer's HDR tone pass), so its encode is the SDR plate's premultiplied display value below the knee
    const lin = tslMax(hdrNode.rgb, vec3(0));
    // (hdr3) display values up to white, channel by channel; a channel past white is its light
    const enc = linToHybrid(lin);
    const base = straight ? enc.mul(cover) : enc;
    // (hdr3) the Scene layer's own grade on the straight colour, premultiplied back
    const graded = gradeHybrid(straight ? enc : enc.div(tslMax(cover, 1e-4)), sceneGrade).mul(cover);
    const rgb = select(g.uGrade.greaterThan(0.5), graded, base);
    return select(cover.greaterThan(0), vec4(rgb, cover), vec4(0, 0, 0, 0));
  })();
  material.transparent = false;
  material.blending = THREE.NoBlending;
  material.toneMapped = false;
  finish(material, { uHeight, ...g });
  return {
    material,
    bind(nextHdr, nextSdr, h) {
      if (nextHdr && hdrNode.value !== nextHdr) hdrNode.value = nextHdr;
      if (nextSdr && sdrNode.value !== nextSdr) sdrNode.value = nextSdr;
      if (Number.isFinite(h)) uHeight.value = h;
    },
    /** (hdr3) The Scene layer's grade this frame ({ brightness, contrast, saturation, hue, grayscale, sepia, invert, tint } as its clip
     *  material holds them), or null: none. */
    setGrade(gr) {
      const on = !!gr && !(gr.brightness === 1 && gr.contrast === 1 && gr.saturation === 1 && Math.abs(gr.hue) < 0.5 && !gr.grayscale && !gr.sepia
        && !gr.invert && gr.tint.r === 1 && gr.tint.g === 1 && gr.tint.b === 1);
      g.uGrade.value = on ? 1 : 0;
      if (!on) return;
      g.uBright.value = gr.brightness; g.uContrast.value = gr.contrast; g.uSat.value = gr.saturation; g.uHue.value = gr.hue;
      g.uGray.value = gr.grayscale; g.uSepia.value = gr.sepia; g.uInvert.value = gr.invert; g.uTint.value.copy(gr.tint);
    },
  };
}

/**
 * One sub-frame of the export's motion blur into the float average, added at its weight (storage to storage, One + One):
 * (A − B·uSub)·uWeight. The average is kept as its first sub-frame plus the weighted differences from it, so a pixel that does not move
 * is its first sub-frame to the bit (summed in half floats, sixteen values near white lost about 1 % on the way). Each pass makes its own
 * (its textures fixed at construction). Returns { material, bind(a, b) }.
 */
export function createHdrAccumulateNodeMaterial({ a, b }) {
  const uWeight = uniform(1);
  const uSub = uniform(0);
  const p = ivec2(screenCoordinate.xy);
  const aNode = textureLoad(a, p);
  const bNode = textureLoad(b, p);
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = aNode.sub(bNode.mul(uSub)).mul(uWeight);
  material.transparent = true;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.toneMapped = false;
  finish(material, { uWeight, uSub });
  return {
    material,
    bind(nextA, nextB) {
      if (nextA && aNode.value !== nextA) aNode.value = nextA;
      if (nextB && bNode.value !== nextB) bNode.value = nextB;
    },
  };
}

/**
 * A render at another size than the project's: one separable Lanczos-3 pass of the float picture along x (`horizontal`) or y, its support
 * widened by the scale (ffmpeg's lanczos, as frameResampler.js does the SDR frame), in the picture's own display values premultiplied, the
 * negative lobes clamped at 0 (the light above white is kept). Storage to storage. uScale: source texels per output texel along the axis.
 */
export function createHdrResampleNodeMaterial(src, { horizontal = true } = {}) {
  const uScale = uniform(1);
  const uSize = uniform(new THREE.Vector2(1, 1));
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const q = screenCoordinate.xy;
    const at = (horizontal ? q.x : q.y).mul(uScale);
    const across = int(horizontal ? q.y : q.x);
    const n = int(horizontal ? uSize.x : uSize.y);
    const stretch = tslMax(uScale, 1.0);
    const first = int(floor(at.sub(stretch.mul(3.0))));
    const sum = vec4(0).toVar();
    const wsum = float(0).toVar();
    Loop({ start: int(0), end: int(64), type: 'int' }, ({ i }) => {
      const k = first.add(i);
      const d = float(k).add(0.5).sub(at).div(stretch);
      If(d.greaterThan(3.0), () => { Break(); });
      const x = abs(d);
      const px = x.mul(Math.PI);
      const w = select(x.lessThan(1e-5), float(1), select(x.greaterThanEqual(3.0), float(0), sin(px).mul(sin(px.div(3.0))).mul(3.0).div(px.mul(px))));
      const t = clampInt(k, n);
      sum.addAssign(textureLoad(src, horizontal ? ivec2(t, across) : ivec2(across, t)).mul(w));
      wsum.addAssign(w);
    });
    return tslMax(sum.div(tslMax(wsum, 1e-6)), vec4(0));
  })();
  material.transparent = false;
  material.blending = THREE.NoBlending;
  material.toneMapped = false;
  finish(material, { uScale, uSize });
  // the source's size along both axes and its texels per output texel along this pass's axis
  return { material, bind({ scale, width, height }) { uScale.value = scale; uSize.value.set(width, height); } };
}

const clampInt = (k, n) => select(k.lessThan(0), int(0), select(k.greaterThanEqual(n), n.sub(1), k));

/**
 * (hdr3) The float composite's frame: the stack with the Scene's HDR plate (`b`) less what 2D layers alone pushed past white in the same
 * stack with its SDR plate (`a`), premultiplied in and out: b − max(a − coverage, 0). Where no light of the Scene's is above white, `a`
 * IS `b` and the frame is the SDR export's (an add of two 2D layers past white stays at white, as in the SDR export); above white it is
 * the Scene's light as the stack carried it. Storage to storage.
 */
export function createHdrCombineNodeMaterial({ a, b }) {
  const p = ivec2(screenCoordinate.xy);
  const aNode = textureLoad(a, p);
  const bNode = textureLoad(b, p);
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = vec4(bNode.rgb.sub(tslMax(aNode.rgb.sub(vec3(bNode.a)), vec3(0))), bNode.a);
  material.transparent = false;
  material.blending = THREE.NoBlending;
  material.toneMapped = false;
  finish(material, {});
  return { material };
}
