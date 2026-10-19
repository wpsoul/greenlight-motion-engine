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
  Loop, Break, int, abs, fract, sin, cos, sqrt, step, smoothstep, distance, max as tslMax,
  screenCoordinate, screenSize, exp,
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
export function createAdjustmentNodeMaterial() {
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
  };
  /*
   * The whole fragment is built inside Fn(). `If()` and `.toVar()` append to the
   * CURRENT BUILD STACK, and at material-construction time there is no stack —
   * outside an Fn they have nowhere to land. Same for `Discard()` in the two
   * depth passes below.
   */
  const fragment = Fn(() => {
    const raw = sampleBlurred(u, uv());
    // Premultiplied stack in, alpha-blended write out: grade the straight colour
    // (see the GLSL twin) so semi-transparent pixels are not darkened twice.
    let c = raw.rgb.div(tslMax(raw.a, 0.0001)).mul(u.uBrightness);
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
    c = clamp(c.mul(u.uTintColor), 0.0, 1.0);
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
export function createMaskCompositeNodeMaterial() {
  const u = { uTexture: makeSampler(), uMask: makeSampler(), uInvert: uniform(0) };
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

/**
 * Colour + real depth for a camera-baked 3D pass.
 *
 * A model or plate reaches the compositor as a full-frame colour texture whose
 * proxy quad has no useful Z of its own, so stamping depth AFTER drawing colour
 * lets the whole proxy overwrite an earlier 3D layer before the depth test runs.
 * Writing the sampled depth at the same time as the premultiplied colour
 * resolves two crossing surfaces per pixel instead of by channel order.
 */
export function createDepthCompositeNodeMaterial() {
  const u = {
    uColor: makeSampler(),
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
    // A transparent pixel must never become an invisible depth wall.
    Discard(color.a.lessThan(0.02));
    Discard(u.uDepth.sample(uvn).r.greaterThanEqual(FAR_PLANE).and(u.uFallback.lessThan(0.0)));
    return vec4(color.rgb.add(u.uBlendIdentity.mul(float(1.0).sub(color.a))), color.a);
  })();
  // Survivors at the far plane are exactly the ones with a usable fallback, so
  // the select needs no second guard.
  material.depthNode = Fn(() => {
    const rawDepth = u.uDepth.sample(uvn).r;
    return select(rawDepth.greaterThanEqual(FAR_PLANE), u.uFallback, rawDepth);
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
    uFocusPointPx: uniform(new THREE.Vector2(0, 0)),
    uFocusInnerPx: uniform(0),
    uFocusOuterPx: uniform(0),
  };

  // GLSL `mod(abs(p), 2.0)` — the argument is non-negative, so floor-mod and
  // TSL's truncating `%` agree here and no glslMod helper is needed.
  const mirrorUv = (p) => {
    const m = abs(p).mod(2.0);
    return mix(m, vec2(2.0).sub(m), step(1.0, m));
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
  // Straight-alpha highlight boost, re-premultiplied. Guarded on alpha because
  // dividing a fully transparent texel by its own alpha is where bloom picks up
  // the colour of pixels nobody can see.
  const boostedSample = (uvIn) => {
    const s = u.uTexture.sample(mirrorUv(uvIn)).toVar();
    const straight = s.rgb.div(tslMax(s.a, 0.00001));
    const luma = dot(straight, vec3(0.2126, 0.7152, 0.0722));
    const boost = float(1.0).add(tslMax(float(0.0), luma.sub(HIGHLIGHT_THRESHOLD)).mul(u.uHighlightGain));
    const boosted = vec4(straight.mul(boost).mul(s.a), s.a);
    return select(s.a.lessThanEqual(0.00001).or(u.uHighlightGain.lessThanEqual(0.00001)), s, boosted);
  };

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
    const falloff = select(
      u.uFocusOuterPx.lessThanEqual(0.0), float(1.0),
      smoothstep(u.uFocusInnerPx, u.uFocusOuterPx, distance(fragXY, u.uFocusPointPx)),
    );
    const radiusPx = u.uRadiusPx.mul(falloff).toVar();
    const out = vec4(0.0).toVar();
    If(radiusPx.lessThan(0.25), () => {
      out.assign(u.uTexture.sample(vUv));
    }).Else(() => {
      const sum = boostedSample(vUv).toVar();
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
        sum.addAssign(boostedSample(vUv.add(vec2(offset.x, offset.y.negate()))));
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
