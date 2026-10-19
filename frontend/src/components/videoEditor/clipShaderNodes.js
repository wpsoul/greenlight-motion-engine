/*
 * TSL twin of clipShader.js's clip material — matrix rows 01-05 (grade chain,
 * fx stack, framing SDF, plate & fit, depth), which are ONE shader in the app
 * and are therefore ported as one.
 *
 * Two things make this a drop-in rather than a rewrite:
 *
 *   THE UNIFORM SURFACE IS IDENTICAL. `material.uniforms.<name>.value` reads and
 *   writes exactly as it does on the GLSL material, so applyFilterUniforms,
 *   resetMaterialUniforms, applyDepthUniforms and applyBlendMode drive this one
 *   unchanged. A TSL uniform node already has `.value`, so the nodes ARE the
 *   facade — no mirror to keep in sync (pair 12 finding 3). The two array
 *   uniforms are the exception: `uniformArray` keeps its data on `.array`, so a
 *   `value` accessor onto it is defined below, which is what lets the app keep
 *   writing `u.uShadowColors.value[i].set(...)`.
 *
 *   THE ORDER AND THE GUARDS ARE THE GLSL'S. Where the GLSL guards a block with
 *   `if (uX > 0)`, the guard is kept when it is SEMANTIC — the hue rotation
 *   clamps INSIDE itself, so running it at angle 0 would clamp values that must
 *   pass through — and dropped only where the zero value is mathematically
 *   neutral (html/webgpu-migration/PORTING-GUIDE.md §1).
 *
 * Every helper carries an explicit `.setLayout()`. Without one, TSL inlines the
 * closure at every call site and re-emits its whole body per call; nested
 * helpers multiply, and this shader nests four deep.
 *
 * TWO RULES ABOUT LAYOUTS, both of which cost a debugging session here and both
 * of which fail as a BLACK FRAME — an invalid pipeline drops the draw, and the
 * only other trace is a console line:
 *
 *   A layout may only go on a helper that is a PURE FUNCTION OF ITS PARAMETERS.
 *   A laid-out helper that reads an outer uniform is emitted as a real WGSL
 *   function ahead of the main body, and it captures that uniform's index BEFORE
 *   the uniform struct is finished — so the emitted `object.nodeUniformN` can
 *   land on a slot of a different type entirely ("no matching overload for
 *   operator >= (vec2<f32>, abstract-float)" was a float uniform read out of a
 *   vec2 slot). The seven helpers below that read uniforms are therefore
 *   deliberately un-laid-out and inline at their call sites, which is also what
 *   the verdicted labs do — none of pair 02/03's helpers carry a layout.
 *
 *   A LAYOUT'S PARAMETER NAMES ARE EMITTED INTO WGSL VERBATIM, so they must
 *   avoid WGSL's reserved words. The GLSL's `move` parameter is one of them, and
 *   it fails as a shader-module PARSE error. Hence `travel` here.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Break, Discard, uniform, uniformArray, texture, uv,
  vec2, vec3, vec4, float, int, mat3, dot, mix, clamp, smoothstep, abs, max, min,
  length, fract, mod, atan, sin, cos, tan, sqrt, select, sign, bool, exp, screenCoordinate,
  pow, step, modelViewProjection,
} from 'three/tsl';
import { isAlphaExportMode } from './clipShader.js';
import { makeTslSampler } from './tslSampler.js';

const HALF_PI = 1.5707963;
// Lens soft caps — the same constants, and for the same reason: two of the four
// quadrants stop being a lens if pushed far enough (tan blows through its
// asymptote, the barrel's polynomial crosses zero), and the caps are the
// IDENTITY over the amounts the slider used to reach.
const LENS_X_SOFT = 1.35;
const LENS_X_MAX = 1.53;
const LENS_G_SOFT = 0.35;
const LENS_G_MIN = 0.12;



/**
 * Build the clip material's node graph and its uniform facade.
 *
 * Returns `{ material, uniforms }`; `createClipNodeMaterial()` below hangs the
 * second off the first so callers see the same shape a ShaderMaterial has.
 */
function buildClipNodes() {
  // ── Uniforms: same names, same types, same defaults as createClipMaterial ──
  // Both go through the null-safe facade. uDepthMap is the one that actually
  // bit: resetMaterialUniforms() clears it to null EVERY frame, TSL rejected
  // that at build time, and three silently fell back to the default shader —
  // a black frame from a feature that was switched off. See tslSampler.js.
  const uTexture = makeTslSampler({ rgba: [255, 255, 255, 255] });
  const uDepthMap = makeTslSampler({ rgba: [255, 255, 255, 255] });
  const uOpacity = uniform(1.0);
  // Blend modes (see applyBlendMode). uBlendCustom = 1 when a non-normal mode is
  // active; uBlendIdentity is that mode's NEUTRAL colour — the value that leaves
  // the destination untouched (black for screen/add/lighten, white for
  // multiply/darken).
  const uBlendCustom = uniform(0.0);
  const uBlendIdentity = uniform(new THREE.Vector3(0, 0, 0));
  const uBrightness = uniform(1.0);
  const uContrast = uniform(1.0);
  const uSaturation = uniform(1.0);
  const uHueRotate = uniform(0.0);
  const uGrayscale = uniform(0.0);
  const uSepia = uniform(0.0);
  const uInvert = uniform(0.0);
  // Color Correction — names and defaults as clipShader.js createColorCorrectionUniforms.
  const uCcCtl = uniform(new THREE.Vector4(0, -1, 0, 0));
  const uCcGain = uniform(new THREE.Vector3(1, 1, 1));
  const uCcTone = uniform(new THREE.Vector4(0, 0, 0, 0));
  const uCcTone2 = uniform(new THREE.Vector4(0, 0, 1, 0));
  const uCcFlags = uniform(new THREE.Vector4(0, 0, 0, 0));
  const uCcLvInB = uniform(new THREE.Vector4(0, 0, 0, 0));
  const uCcLvInW = uniform(new THREE.Vector4(1, 1, 1, 1));
  const uCcLvGam = uniform(new THREE.Vector4(1, 1, 1, 1));
  const uCcLvOutB = uniform(new THREE.Vector4(0, 0, 0, 0));
  const uCcLvOutW = uniform(new THREE.Vector4(1, 1, 1, 1));
  const uCcWhS = uniform(new THREE.Vector3(0, 0, 0));
  const uCcWhM = uniform(new THREE.Vector3(0, 0, 0));
  const uCcWhH = uniform(new THREE.Vector3(0, 0, 0));
  const uCcHslH0 = uniform(new THREE.Vector4(0, 0, 0, 0));
  const uCcHslH1 = uniform(new THREE.Vector4(0, 0, 0, 0));
  const uCcHslS0 = uniform(new THREE.Vector4(0, 0, 0, 0));
  const uCcHslS1 = uniform(new THREE.Vector4(0, 0, 0, 0));
  const uCcHslL0 = uniform(new THREE.Vector4(0, 0, 0, 0));
  const uCcHslL1 = uniform(new THREE.Vector4(0, 0, 0, 0));
  const uBlur = uniform(0.0);
  const uZoomBlur = uniform(0.0);
  const uZoomCenter = uniform(new THREE.Vector2(0.5, 0.5));
  const uMoveBlur = uniform(new THREE.Vector2(0, 0));
  const uRgbSplit = uniform(0.0);
  const uSplitMove = uniform(new THREE.Vector2(0, 0));
  const uTileFade = uniform(0.0);
  const uClipPathInset = uniform(0.0);
  const uLetterSpacing = uniform(0.0);
  const uTintColor = uniform(new THREE.Color(0xffffff));
  const uBgColor = uniform(new THREE.Vector4(0, 0, 0, 0));
  const uFlashColor = uniform(new THREE.Color(0xffffff));
  const uFlashAmount = uniform(0.0);
  const uBloomAmount = uniform(0.0);
  const uBloomThreshold = uniform(0.6);
  const uBloomRadius = uniform(36.0);
  const uResolution = uniform(new THREE.Vector2(1280, 720));
  const uCanvasSize = uniform(new THREE.Vector2(1280, 720));
  const uStabilizeOn = uniform(0.0);
  const uStabilizeLinear = uniform(new THREE.Vector4(1, 0, 0, 1));
  const uStabilizeOffset = uniform(new THREE.Vector2(0, 0));
  const uStabilizeSize = uniform(new THREE.Vector2(1, 1));
  const uCellCrop = uniform(new THREE.Vector2(1, 1));
  const uGridCell = uniform(0.0);
  const uUvOffset = uniform(new THREE.Vector2(0, 0));
  const uUvScale = uniform(new THREE.Vector2(1, 1));
  const uFisheye = uniform(0.0);
  const uFisheyeFit = uniform(1.0);
  const uFisheyeModel = uniform(0, 'int');
  const uFisheyeCenter = uniform(new THREE.Vector2(0.5, 0.5));
  const uUvPreOffset = uniform(new THREE.Vector2(0, 0));
  const uUvRotate = uniform(0.0);
  // Frame UV the roll turns about: the frame centre for the camera tremble,
  // the zoom point for Advanced Zoom's Rotation (see clipShader.js).
  const uUvRotateCenter = uniform(new THREE.Vector2(0.5, 0.5));
  // Advanced Movement's Perspective option — see clipShader.js for the model.
  const uPerspTilt = uniform(0.0);
  const uPerspAxis = uniform(new THREE.Vector2(0, 1));
  const uPerspDist = uniform(1.8);
  const uPerspPivot = uniform(new THREE.Vector2(0.5, 0.5));
  const uPerspShade = uniform(0.0);
  const uMirrorTile = uniform(0.0);
  // Seeded from the shared flag, NOT hardcoded to 0. createClipMaterial() does
  // the same at construction, and the asymmetry was a real bug: a material built
  // DURING a transparent export and drawn before the next
  // resetMaterialUniforms() started with letterboxing enabled, so the bars of
  // every mismatched clip filled opaque black — which is exactly what the
  // app-level A/B measured as a solid box around a text layer's glyphs.
  const uAlphaExport = uniform(isAlphaExportMode() ? 1.0 : 0.0);
  const uInputPremultiplied = uniform(0.0);
  // WebGPU: compositor RTs sampled on a perspective clip plane (particles, 3D,
  // sequences) — same §3.4 V flip as flipAdjustmentGeoV / lab pair 15.
  const uInputFlipV = uniform(0.0);
  const uPlaneExpand = uniform(0.0);
  const uWipeType = uniform(0, 'int');
  const uWipeProgress = uniform(1.0);
  const uCornerRadii = uniform(new THREE.Vector4(0, 0, 0, 0));
  const uBorderWidth = uniform(0.0);
  const uBorderStyle = uniform(0, 'int');
  const uBorderColor = uniform(new THREE.Vector4(1, 1, 1, 1));
  const uShadowCount = uniform(0, 'int');
  const uShadowColors = uniformArray([
    new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0),
    new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0),
  ], 'vec4').setName('uShadowColors');
  const uShadowParams = uniformArray([
    new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0),
    new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0),
  ], 'vec4').setName('uShadowParams');
  const uShadowInset = uniformArray([0, 0, 0, 0], 'float').setName('uShadowInset');
  const uDepthOn = uniform(0.0);
  const uDepthShift = uniform(new THREE.Vector2(0, 0));
  const uDepthDolly = uniform(0.0);
  const uDepthFocus = uniform(0.45);
  const uDepthCut = uniform(0.0);

  // ── Helpers, each with an explicit layout ─────────────────────────────────

  // CSS-style pairwise clamp so adjacent corner radii never overlap.
  const clampRadii = Fn(([r, halfSize]) => {
    const w = halfSize.x.mul(2.0);
    const h = halfSize.y.mul(2.0);
    const s = float(1.0).toVar();
    s.assign(min(s, w.div(max(r.x.add(r.y), 1e-3))));
    s.assign(min(s, w.div(max(r.w.add(r.z), 1e-3))));
    s.assign(min(s, h.div(max(r.x.add(r.w), 1e-3))));
    s.assign(min(s, h.div(max(r.y.add(r.z), 1e-3))));
    return r.mul(s);
  }).setLayout({
    name: 'clampRadii', type: 'vec4',
    inputs: [{ name: 'r', type: 'vec4' }, { name: 'halfSize', type: 'vec2' }],
  });

  // Signed distance to a rounded rect with per-corner radii (r = TL,TR,BR,BL; y-up).
  const roundedRectSDF = Fn(([p, halfSize, r]) => {
    const rad = select(p.x.lessThan(0.0), select(p.y.greaterThan(0.0), r.x, r.w),
      select(p.y.greaterThan(0.0), r.y, r.z));
    const q = abs(p).sub(halfSize).add(rad);
    return min(max(q.x, q.y), 0.0).add(length(max(q, vec2(0.0)))).sub(rad);
  }).setLayout({
    name: 'roundedRectSDF', type: 'float',
    inputs: [{ name: 'p', type: 'vec2' }, { name: 'halfSize', type: 'vec2' }, { name: 'r', type: 'vec4' }],
  });

  // Arc-length coordinate along the rounded-rect boundary (clockwise from the
  // top edge's left end), so dashes and dots keep a steady rhythm round the
  // whole outline, corners included.
  const perimeterCoord = Fn(([p, b, r]) => {
    const lTop = b.x.mul(2.0).sub(r.x).sub(r.y);
    const lRight = b.y.mul(2.0).sub(r.y).sub(r.z);
    const lBot = b.x.mul(2.0).sub(r.z).sub(r.w);
    const sTR = lTop;
    const sRight = sTR.add(r.y.mul(HALF_PI));
    const sBR = sRight.add(lRight);
    const sBot = sBR.add(r.z.mul(HALF_PI));
    const sBL = sBot.add(lBot);
    const sLeft = sBL.add(r.w.mul(HALF_PI));
    const sTL = sLeft.add(b.y.mul(2.0).sub(r.w).sub(r.x));

    const cTL = vec2(b.x.negate().add(r.x), b.y.sub(r.x));
    const cTR = vec2(b.x.sub(r.y), b.y.sub(r.y));
    const cBR = vec2(b.x.sub(r.z), b.y.negate().add(r.z));
    const cBL = vec2(b.x.negate().add(r.w), b.y.negate().add(r.w));

    // GLSL's early returns become an If/ElseIf chain — the form pair 03 verdicted
    // (html/webgpu-migration/webgpu/03-clip-framing.html).
    const out = float(0.0).toVar();
    If(p.x.greaterThan(cTR.x).and(p.y.greaterThan(cTR.y)), () => {
      const a = atan(p.y.sub(cTR.y), p.x.sub(cTR.x));
      out.assign(sTR.add(float(HALF_PI).sub(a).mul(r.y)));
    }).ElseIf(p.x.greaterThan(cBR.x).and(p.y.lessThan(cBR.y)), () => {
      const a = atan(cBR.y.sub(p.y), p.x.sub(cBR.x));
      out.assign(sBR.add(a.mul(r.z)));
    }).ElseIf(p.x.lessThan(cBL.x).and(p.y.lessThan(cBL.y)), () => {
      const a = atan(cBL.y.sub(p.y), cBL.x.sub(p.x));
      out.assign(sBL.add(float(HALF_PI).sub(a).mul(r.w)));
    }).ElseIf(p.x.lessThan(cTL.x).and(p.y.greaterThan(cTL.y)), () => {
      const a = atan(p.y.sub(cTL.y), cTL.x.sub(p.x));
      out.assign(sTL.add(a.mul(r.x)));
    }).Else(() => {
      const dTop = b.y.sub(p.y);
      const dBot = p.y.add(b.y);
      const dLeft = p.x.add(b.x);
      const dRight = b.x.sub(p.x);
      const m = min(min(dTop, dBot), min(dLeft, dRight));
      If(m.equal(dTop), () => {
        out.assign(p.x.sub(b.x.negate().add(r.x)));
      }).ElseIf(m.equal(dRight), () => {
        out.assign(sRight.add(cTR.y.sub(p.y)));
      }).ElseIf(m.equal(dBot), () => {
        out.assign(sBot.add(cBR.x.sub(p.x)));
      }).Else(() => {
        out.assign(sLeft.add(p.y.sub(cBL.y)));
      });
    });
    return out;
  }).setLayout({
    name: 'perimeterCoord', type: 'float',
    inputs: [{ name: 'p', type: 'vec2' }, { name: 'b', type: 'vec2' }, { name: 'r', type: 'vec4' }],
  });

  // 0..1 mask shaping the border ring into its style's pattern.
  const borderPatternMask = Fn(([p, b, r, d, w]) => {
    const out = float(1.0).toVar();
    If(uBorderStyle.equal(int(1)), () => {           // dashed: 3w dash / 2w gap
      const s = perimeterCoord(p, b, r);
      const t = abs(mod(s, w.mul(5.0)).sub(w.mul(1.5)));
      out.assign(float(1.0).sub(smoothstep(w.mul(1.5).sub(0.75), w.mul(1.5).add(0.75), t)));
    }).ElseIf(uBorderStyle.equal(int(2)), () => {    // dotted: dots of diameter w, gap w
      const s = perimeterCoord(p, b, r);
      const along = mod(s, w.mul(2.0)).sub(w);
      const across = d.add(w.mul(0.5));
      const dd = length(vec2(along, across)).sub(w.mul(0.5));
      out.assign(float(1.0).sub(smoothstep(-0.75, 0.75, dd)));
    }).ElseIf(uBorderStyle.equal(int(3)), () => {    // double: outer + inner thirds
      const t = d.negate().div(max(w, 1e-3));
      out.assign(clamp(float(1.0).sub(smoothstep(0.31, 0.36, t)).add(smoothstep(0.64, 0.69, t)), 0.0, 1.0));
    });
    return out;
  });

  // Straight-alpha "src over dst".
  const overComposite = Fn(([src, dst]) => {
    const a = src.a.add(dst.a.mul(float(1.0).sub(src.a)));
    const rgb = src.rgb.mul(src.a).add(dst.rgb.mul(dst.a).mul(float(1.0).sub(src.a))).div(max(a, 1e-5));
    // The GLSL returns vec4(0) below a = 1e-5; select keeps that exactly while
    // the divide above stays finite for every lane.
    return select(a.lessThan(1e-5), vec4(0.0), vec4(rgb, a));
  }).setLayout({
    name: 'overComposite', type: 'vec4',
    inputs: [{ name: 'src', type: 'vec4' }, { name: 'dst', type: 'vec4' }],
  });

  // ── Color Correction — TSL twin of clipShader.js's cc* block, same formulas.
  // Every helper is a pure function of its parameters (uniforms are passed in at
  // the call site), so each carries a layout; parameter names avoid WGSL's
  // reserved words.
  const ccToLin = Fn(([c]) => mix(c.div(12.92), pow(c.add(0.055).div(1.055), vec3(2.4)), step(vec3(0.04045), c)))
    .setLayout({ name: 'ccToLin', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }] });
  const ccToDisp = Fn(([cIn]) => {
    const c = max(cIn, vec3(0.0));
    return mix(c.mul(12.92), pow(c, vec3(1.0 / 2.4)).mul(1.055).sub(0.055), step(vec3(0.0031308), c));
  }).setLayout({ name: 'ccToDisp', type: 'vec3', inputs: [{ name: 'cIn', type: 'vec3' }] });
  const ccContrast = Fn(([x, k]) => {
    const y = clamp(x, 0.0, 1.0);
    const g = select(k.greaterThan(0.0), k.mul(2.0).add(1.0), float(1.0).div(float(1.0).sub(k.mul(1.2))));
    const lo = pow(y.div(0.45), g).mul(0.45);
    const hi = float(1.0).sub(pow(float(1.0).sub(y).div(0.55), g).mul(0.55));
    return x.add(select(y.lessThan(0.45), lo, hi).sub(y).mul(0.8));
  }).setLayout({ name: 'ccContrast', type: 'float', inputs: [{ name: 'x', type: 'float' }, { name: 'k', type: 'float' }] });
  const ccHigh = Fn(([x, h]) => {
    const y = clamp(x, 0.0, 1.0);
    const up = x.add(h.mul(3.1572).mul(y).mul(y).mul(y).mul(pow(float(1.0).sub(y), 1.5)));
    const sc = select(x.lessThan(0.5), x, float(0.5).add(float(0.5).mul(float(1.0).sub(exp(x.sub(0.5).div(0.5).negate())))));
    return select(h.greaterThanEqual(0.0), up, mix(x, sc, h.negate()));
  }).setLayout({ name: 'ccHigh', type: 'float', inputs: [{ name: 'x', type: 'float' }, { name: 'h', type: 'float' }] });
  const ccShad = Fn(([x, sv]) => {
    const y = clamp(x, 0.0, 1.0);
    const iy = float(1.0).sub(y);
    return x.add(sv.mul(3.1572).mul(pow(y, 1.5)).mul(iy).mul(iy).mul(iy));
  }).setLayout({ name: 'ccShad', type: 'float', inputs: [{ name: 'x', type: 'float' }, { name: 'sv', type: 'float' }] });
  const ccWhites = Fn(([x, wv]) => {
    const m = clamp(x, 0.0, 1.0);
    return x.mul(mix(float(1.0), float(1.0).div(float(1.0).sub(wv.mul(0.3))), m.mul(m)));
  }).setLayout({ name: 'ccWhites', type: 'float', inputs: [{ name: 'x', type: 'float' }, { name: 'wv', type: 'float' }] });
  const ccBlacks = Fn(([x, bv]) => x.add(bv.mul(0.1).mul(float(1.0).sub(smoothstep(0.0, 0.6, x)))))
    .setLayout({ name: 'ccBlacks', type: 'float', inputs: [{ name: 'x', type: 'float' }, { name: 'bv', type: 'float' }] });
  const ccTone = Fn(([c, tone, blk]) => {
    const p = max(c, vec3(0.0));
    const d = dot(p, p);
    const n = select(d.greaterThan(1e-10), dot(p.mul(p), p).div(max(d, 1e-10)), float(0.0));
    const m = ccBlacks(ccWhites(ccShad(ccHigh(ccContrast(n, tone.x), tone.y), tone.z), tone.w), blk);
    const r = select(n.greaterThan(1e-6), m.div(max(n, 1e-6)), float(1.0));
    return vec3(m).add(c.sub(vec3(n)).mul(clamp(r, 0.0, 3.0)));
  }).setLayout({
    name: 'ccTone', type: 'vec3',
    inputs: [{ name: 'c', type: 'vec3' }, { name: 'tone', type: 'vec4' }, { name: 'blk', type: 'float' }],
  });
  const ccLevels = Fn(([cIn, inb, inw, gam, outb, outw]) => {
    const c1 = clamp(cIn.sub(inb.yzw).div(max(inw.yzw.sub(inb.yzw), vec3(1e-4))), 0.0, 1.0);
    const c2 = outb.yzw.add(pow(c1, vec3(1.0).div(gam.yzw)).mul(outw.yzw.sub(outb.yzw)));
    const c3 = clamp(c2.sub(inb.x).div(max(inw.x.sub(inb.x), 1e-4)), 0.0, 1.0);
    return vec3(outb.x).add(pow(c3, vec3(float(1.0).div(gam.x))).mul(outw.x.sub(outb.x)));
  }).setLayout({
    name: 'ccLevels', type: 'vec3',
    inputs: [{ name: 'cIn', type: 'vec3' }, { name: 'inb', type: 'vec4' }, { name: 'inw', type: 'vec4' },
      { name: 'gam', type: 'vec4' }, { name: 'outb', type: 'vec4' }, { name: 'outw', type: 'vec4' }],
  });
  const ccColor = Fn(([c, sat, vib]) => {
    const Y = dot(c, vec3(0.2126, 0.7152, 0.0722));
    const mx = max(c.r, max(c.g, c.b));
    const mn = min(c.r, min(c.g, c.b));
    const s = select(mx.greaterThan(1e-5), mx.sub(mn).div(max(mx, 1e-5)), float(0.0));
    const q = c.g.sub(c.b).div(max(c.r.sub(c.b), 1e-5));
    const skin = select(c.r.greaterThanEqual(c.g).and(c.g.greaterThanEqual(c.b)),
      float(1.0).sub(smoothstep(0.08, 0.32, abs(q.sub(0.45)))), float(0.0));
    const ns = float(1.0).sub(s);
    const v0 = vib.mul(ns).mul(ns);
    const v = select(vib.greaterThan(0.0), v0.mul(float(1.0).sub(skin.mul(0.6))), v0);
    return vec3(Y).add(c.sub(vec3(Y)).mul(sat.mul(float(1.0).add(v))));
  }).setLayout({
    name: 'ccColor', type: 'vec3',
    inputs: [{ name: 'c', type: 'vec3' }, { name: 'sat', type: 'float' }, { name: 'vib', type: 'float' }],
  });
  const ccWheels = Fn(([c, sh, mi, hi]) => {
    const Y = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    const ws = float(1.0).sub(Y).mul(float(1.0).sub(Y));
    const wh = Y.mul(Y);
    return c.add(sh.mul(ws)).add(mi.mul(float(1.0).sub(ws).sub(wh))).add(hi.mul(wh));
  }).setLayout({
    name: 'ccWheels', type: 'vec3',
    inputs: [{ name: 'c', type: 'vec3' }, { name: 'sh', type: 'vec3' }, { name: 'mi', type: 'vec3' }, { name: 'hi', type: 'vec3' }],
  });
  const ccRgb2Hsv = Fn(([c]) => {
    const K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    const p = mix(vec4(c.b, c.g, K.w, K.z), vec4(c.g, c.b, K.x, K.y), step(c.b, c.g));
    const q = mix(vec4(p.x, p.y, p.w, c.r), vec4(c.r, p.y, p.z, p.x), step(p.x, c.r));
    const d = q.x.sub(min(q.w, q.y));
    return vec3(abs(q.z.add(q.w.sub(q.y).div(d.mul(6.0).add(1e-10)))), d.div(q.x.add(1e-10)), q.x);
  }).setLayout({ name: 'ccRgb2Hsv', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }] });
  const ccHsv2Rgb = Fn(([c]) => {
    const p = abs(fract(vec3(c.x).add(vec3(1.0, 2.0 / 3.0, 1.0 / 3.0))).mul(6.0).sub(3.0));
    return mix(vec3(1.0), clamp(p.sub(1.0), 0.0, 1.0), c.y).mul(c.z);
  }).setLayout({ name: 'ccHsv2Rgb', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }] });
  const ccHat = Fn(([h, lo, mid, hi]) => select(h.lessThan(mid), smoothstep(lo, mid, h), float(1.0).sub(smoothstep(mid, hi, h))))
    .setLayout({
      name: 'ccHat', type: 'float',
      inputs: [{ name: 'h', type: 'float' }, { name: 'lo', type: 'float' }, { name: 'mid', type: 'float' }, { name: 'hi', type: 'float' }],
    });
  const ccHsl = Fn(([cIn, h0, h1, s0, s1, l0, l1]) => {
    const hsv = ccRgb2Hsv(clamp(cIn, 0.0, 1.0));
    const d = hsv.x.mul(360.0);
    const hat = (a, m, b) => ccHat(d, float(a), float(m), float(b));
    const w0 = vec4(max(hat(-60, 0, 30), hat(300, 360, 390)), hat(0, 30, 60), hat(30, 60, 120), hat(60, 120, 180));
    const w1 = vec4(hat(120, 180, 240), hat(180, 240, 270), hat(240, 270, 300), hat(270, 300, 360));
    const dh = dot(w0, h0).add(dot(w1, h1));
    const ds = dot(w0, s0).add(dot(w1, s1));
    const dl = dot(w0, l0).add(dot(w1, l1));
    const w = smoothstep(0.0, 0.12, hsv.y.mul(hsv.z));
    const rgb = ccHsv2Rgb(vec3(
      fract(hsv.x.add(dh.mul(w).mul(30.0 / 360.0))),
      clamp(hsv.y.mul(float(1.0).add(ds.mul(w))), 0.0, 1.0),
      hsv.z,
    ));
    return rgb.mul(float(1.0).add(dl.mul(0.5).mul(w)));
  }).setLayout({
    name: 'ccHsl', type: 'vec3',
    inputs: [{ name: 'cIn', type: 'vec3' }, { name: 'h0', type: 'vec4' }, { name: 'h1', type: 'vec4' },
      { name: 's0', type: 'vec4' }, { name: 's1', type: 'vec4' }, { name: 'l0', type: 'vec4' }, { name: 'l1', type: 'vec4' }],
  });

  const mirrorRepeat = Fn(([v]) => {
    const t = fract(v.mul(0.5));
    return float(1.0).sub(abs(t.mul(2.0).sub(1.0)));
  }).setLayout({ name: 'mirrorRepeat', type: 'float', inputs: [{ name: 'v', type: 'float' }] });

  const mirrorRepeat2 = Fn(([p]) => vec2(mirrorRepeat(p.x), mirrorRepeat(p.y)))
    .setLayout({ name: 'mirrorRepeat2', type: 'vec2', inputs: [{ name: 'p', type: 'vec2' }] });

  // Same column-major matrix, degrees in, and the clamp stays INSIDE — which is
  // why the caller's `abs(angle) > 0.5` guard is semantic and is kept.
  const applyHueRotation = Fn(([color, angle]) => {
    const rad = angle.mul(3.14159265 / 180.0);
    const cosA = cos(rad);
    const sinA = sin(rad);
    const m = mat3(
      cosA.mul(0.787).add(0.213).sub(sinA.mul(0.213)),
      float(0.213).sub(cosA.mul(0.213)).add(sinA.mul(0.143)),
      float(0.213).sub(cosA.mul(0.213)).sub(sinA.mul(0.787)),
      float(0.715).sub(cosA.mul(0.715)).sub(sinA.mul(0.715)),
      cosA.mul(0.285).add(0.715).add(sinA.mul(0.140)),
      float(0.715).sub(cosA.mul(0.715)).add(sinA.mul(0.715)),
      float(0.072).sub(cosA.mul(0.072)).add(sinA.mul(0.928)),
      float(0.072).sub(cosA.mul(0.072)).sub(sinA.mul(0.283)),
      cosA.mul(0.928).add(0.072).add(sinA.mul(0.072)),
    );
    return clamp(m.mul(color), 0.0, 1.0);
  }).setLayout({
    name: 'applyHueRotation', type: 'vec3',
    inputs: [{ name: 'color', type: 'vec3' }, { name: 'angle', type: 'float' }],
  });

  // Layer blur = a real 2D Gaussian with CSS semantics (σ = uBlur px) — clipShader.js's
  // sampleBlurred, tap for tap: 48 Gaussian-weighted taps on a golden-angle spiral out to 2.5σ,
  // turned per pixel. The zero branch is perf-only (at σ 0 every tap is the centre texel).
  const sampleBlurred = Fn(([p]) => {
    const out = vec4(0.0).toVar();
    If(uBlur.lessThanEqual(0.0), () => {
      out.assign(uTexture.sample(p));
    }).Else(() => {
      const sigma = uBlur;
      const reach = sigma.mul(2.5);
      const spin = fract(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))).mul(52.9829189)).mul(6.2831853);
      const sum = uTexture.sample(p).toVar();
      const wsum = float(1.0).toVar();
      Loop({ start: 0, end: 48, type: 'int' }, ({ i }) => {
        const fi = float(i).add(0.5);
        const r = reach.mul(sqrt(fi.div(48.0)));
        const a = fi.mul(2.39996323).add(spin);
        const w = exp(r.mul(r).negate().div(sigma.mul(sigma).mul(2.0)));
        sum.addAssign(uTexture.sample(p.add(vec2(cos(a), sin(a)).mul(r).div(uResolution))).mul(w));
        wsum.addAssign(w);
      });
      out.assign(sum.div(wsum));
    });
    return out;
  });

  // Exponential soft cap/floor: identity on the safe side of the knee,
  // asymptotic to the limit on the other, C1 across the join.
  const lensSoftCap = Fn(([v, soft, limit]) => select(
    v.lessThanEqual(soft), v,
    limit.sub(limit.sub(soft).mul(v.sub(soft).div(limit.sub(soft)).negate().exp())),
  )).setLayout({
    name: 'lensSoftCap', type: 'float',
    inputs: [{ name: 'v', type: 'float' }, { name: 'soft', type: 'float' }, { name: 'limit', type: 'float' }],
  });

  const lensSoftFloor = Fn(([v, soft, limit]) => select(
    v.greaterThanEqual(soft), v,
    limit.add(soft.sub(limit).mul(v.sub(soft).div(soft.sub(limit)).exp())),
  )).setLayout({
    name: 'lensSoftFloor', type: 'float',
    inputs: [{ name: 'v', type: 'float' }, { name: 'soft', type: 'float' }, { name: 'limit', type: 'float' }],
  });

  const transitionLensProfile = Fn(([r, k]) => {
    const out = float(1.0).toVar();
    If(uFisheyeModel.equal(int(1)), () => {
      out.assign(lensSoftFloor(float(1.0).add(k.mul(1.7).mul(r).mul(r)), float(LENS_G_SOFT), float(LENS_G_MIN)));
    }).Else(() => {
      const a = abs(k).mul(1.35);
      const x = r.mul(a).toVar();
      If(x.greaterThanEqual(0.0008), () => {
        // atan has no asymptote, so only the dome needs capping — the pinch
        // keeps squeezing for as far as the slider goes.
        If(k.greaterThan(0.0), () => {
          x.assign(lensSoftCap(x, float(LENS_X_SOFT), float(LENS_X_MAX)));
          out.assign(tan(x).div(x));
        }).Else(() => {
          out.assign(atan(x).div(x));
        });
      });
    });
    return out;
  });

  const applyTransitionLens = Fn(([p, frameAspect]) => {
    const out = p.toVar();
    If(abs(uFisheye).greaterThanEqual(0.0015), () => {
      const d = p.sub(uFisheyeCenter).mul(frameAspect);
      // Farthest corner FROM THE LENS CENTRE, so an off-centre lens normalises
      // against its own reach rather than the frame's middle.
      const far = max(uFisheyeCenter, vec2(1.0).sub(uFisheyeCenter)).mul(frameAspect);
      const f = transitionLensProfile(length(d).div(max(length(far), 0.0001)), uFisheye).toVar();
      If(uFisheyeFit.greaterThan(0.5), () => {
        f.divAssign(transitionLensProfile(float(1.0), uFisheye));
      });
      out.assign(uFisheyeCenter.add(d.mul(f).div(frameAspect)));
    });
    return out;
  });

  const applyTransitionRoll = Fn(([p, frameAspect]) => {
    const out = p.toVar();
    If(abs(uUvRotate).greaterThanEqual(0.00002), () => {
      const d = p.sub(uUvRotateCenter).mul(frameAspect);
      const s = sin(uUvRotate);
      const c = cos(uUvRotate);
      out.assign(uUvRotateCenter.add(vec2(d.x.mul(c).sub(d.y.mul(s)), d.x.mul(s).add(d.y.mul(c))).div(frameAspect)));
    });
    return out;
  });

  // Inverse perspective tilt (Advanced Movement) — the GLSL's closed form:
  // w0 = w·d/(cosθ·d + w·sinθ), t0 = t·(d − z)/d, z = w0·sinθ, one denominator
  // guard for both fractions. Returns warped point in .xy, depth in .z and
  // .w = 0 past the horizon. Reads uniforms, so deliberately un-laid-out —
  // see the layout rules at the top of this file.
  const applyTransitionPerspective = Fn(([p, frameAspect]) => {
    const out = vec4(0.0).toVar();
    const q = p.sub(uPerspPivot).mul(frameAspect);
    const axis = vec2(uPerspAxis.x, uPerspAxis.y);
    const tdir = vec2(uPerspAxis.y, uPerspAxis.x.negate());
    const tp = dot(q, axis);
    const wp = dot(q, tdir);
    const cs = cos(uPerspTilt);
    const sn = sin(uPerspTilt);
    const d = max(uPerspDist, 0.2);
    const den = cs.mul(d).add(wp.mul(sn));
    If(den.greaterThanEqual(0.03), () => {
      const w0 = wp.mul(d).div(den);
      const z = w0.mul(sn);
      const t0 = tp.mul(d.sub(z)).div(d);
      out.assign(vec4(uPerspPivot.add(axis.mul(t0).add(tdir.mul(w0)).div(frameAspect)), z, 1.0));
    });
    return out;
  });

  // One march serves both transition blurs: a zoom-only vector gives the radial
  // streak, a move-only vector the directional smear. `channel` shifts every
  // tap's ray length, which is how the RGB split follows the same geometry as
  // the blur instead of being a flat pixel offset.
  const marchTransitionBlur = Fn(([p, centre, travel, splitMove, channel]) => {
    const split = p.sub(centre).mul(uRgbSplit).add(splitMove).mul(channel);
    const walk = p.sub(centre).mul(uZoomBlur).add(travel);
    const out = vec4(0.0).toVar();
    If(dot(walk, walk).lessThan(0.0000001), () => {
      out.assign(uTexture.sample(clamp(p.sub(split), 0.0, 1.0)));
    }).Else(() => {
      const sum = vec4(0.0).toVar();
      Loop({ start: 0, end: 16, type: 'int' }, ({ i }) => {
        const t = float(i).div(15.0).sub(0.5);
        sum.addAssign(uTexture.sample(clamp(p.sub(walk.mul(t)).sub(split), 0.0, 1.0)));
      });
      out.assign(sum.div(16.0));
    });
    return out;
  });

  const sampleWithZoomBlur = Fn(([p, centre, travel, splitMove]) => {
    const blurred = uZoomBlur.greaterThan(0.0001).or(dot(travel, travel).greaterThan(0.0000001));
    const split = uRgbSplit.greaterThan(0.00001).or(dot(splitMove, splitMove).greaterThan(0.0000001));
    const out = vec4(0.0).toVar();
    If(blurred.not().and(split.not()), () => {
      out.assign(sampleBlurred(p));
    }).Else(() => {
      If(split.not(), () => {
        out.assign(marchTransitionBlur(p, centre, travel, splitMove, float(0.0)));
      }).Else(() => {
        const r = marchTransitionBlur(p, centre, travel, splitMove, float(1.0));
        const g = marchTransitionBlur(p, centre, travel, splitMove, float(0.0));
        const b = marchTransitionBlur(p, centre, travel, splitMove, float(-1.0));
        out.assign(vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a)));
      });
    });
    return out;
  });

  // ── main() ────────────────────────────────────────────────────────────────
  const fragment = Fn(() => {
    const vUv = uv();
    // Map the (possibly expanded) quad's UVs back onto the logical canvas rect —
    // fragments in the margin land outside [0,1] and only the shadow paints there.
    const sampleUv = vUv.toVar();
    If(uPlaneExpand.greaterThan(0.5).and(uCanvasSize.x.greaterThan(0.0)).and(uCanvasSize.y.greaterThan(0.0)), () => {
      const expanded = uCanvasSize.add(uPlaneExpand.mul(2.0));
      sampleUv.assign(vUv.sub(0.5).mul(expanded.div(uCanvasSize)).add(0.5));
    });

    // Camera tremble, roll and lens, in that order — all in frame space, all
    // BEFORE the layer's UV transform and the mirror fold, so whatever they push
    // past the source edge is still caught by the fill.
    If(abs(uFisheye).greaterThan(0.0).or(abs(uUvRotate).greaterThan(0.0))
      .or(dot(uUvPreOffset, uUvPreOffset).greaterThan(0.0)), () => {
      const frameAspect = vec2(1.0).toVar();
      If(uCanvasSize.x.greaterThan(0.0).and(uCanvasSize.y.greaterThan(0.0)), () => {
        frameAspect.x.assign(max(uCanvasSize.x.div(uCanvasSize.y), 0.0001));
      });
      sampleUv.assign(applyTransitionLens(applyTransitionRoll(sampleUv.add(uUvPreOffset), frameAspect), frameAspect));
    });

    // Perspective tilt (Advanced Movement). After the camera chain — the tilted
    // plate is seen THROUGH the lens/roll — and before the lane's UV window.
    // The past-horizon wedge holds no image at all: discarded, never routed
    // into the letterbox path (which paints opaque black).
    const perspDepth = float(0.0).toVar();
    If(abs(uPerspTilt).greaterThan(0.0005), () => {
      const frameAspect = vec2(1.0).toVar();
      If(uCanvasSize.x.greaterThan(0.0).and(uCanvasSize.y.greaterThan(0.0)), () => {
        frameAspect.x.assign(max(uCanvasSize.x.div(uCanvasSize.y), 0.0001));
      });
      const warped = applyTransitionPerspective(sampleUv, frameAspect).toVar();
      If(warped.w.lessThan(0.5), () => { Discard(); });
      sampleUv.assign(warped.xy);
      perspDepth.assign(warped.z);
    });

    const transformedUv = sampleUv.mul(uUvScale).add(uUvOffset);

    // How far past the source this fragment landed, before the mirror folds it
    // back — i.e. whether we are looking at real image or at tiled fill.
    const tileFill = float(0.0).toVar();
    // Set where a transition's UV window pushed this fragment past the source
    // with no fill to catch it — the letterbox path below must leave those
    // EMPTY rather than painting its opaque black over the other lane.
    const uvPushedOut = float(0.0).toVar();
    If(uMirrorTile.greaterThan(0.5), () => {
      const over = max(vec2(0.0).sub(transformedUv), transformedUv.sub(vec2(1.0)));
      tileFill.assign(clamp(max(over.x, over.y).mul(3.0), 0.0, 1.0));
      sampleUv.assign(mirrorRepeat2(transformedUv));
    }).Else(() => {
      const over = max(vec2(0.0).sub(transformedUv), transformedUv.sub(vec2(1.0)));
      const overMax = max(over.x, over.y);
      // Same edge rule as clipShader.js: a fragment less than 0.0001 past the
      // plate is ON its edge (a pixel centre exactly on the quad's edge, off by
      // float error) — clamp it back instead of letting the letterbox path paint
      // it opaque black. A real letterbox bar stays black after the fit.
      If(overMax.lessThan(0.0001), () => {
        sampleUv.assign(clamp(transformedUv, 0.0, 1.0));
      }).Else(() => {
        sampleUv.assign(transformedUv);
        uvPushedOut.assign(1.0);
      });
    });

    If(uInputFlipV.greaterThan(0.5), () => {
      sampleUv.y.assign(float(1.0).sub(sampleUv.y));
    });

    If(abs(uLetterSpacing).greaterThan(0.001), () => {
      const spread = clamp(uLetterSpacing.div(1000.0), -0.2, 0.2);
      sampleUv.x.assign(sampleUv.x.sub(0.5).mul(float(1.0).add(spread)).add(0.5));
    });

    If(uClipPathInset.greaterThan(0.001), () => {
      const inset = clamp(uClipPathInset.div(100.0), 0.0, 0.49);
      If(sampleUv.x.lessThan(inset).or(sampleUv.x.greaterThan(float(1.0).sub(inset)))
        .or(sampleUv.y.lessThan(inset)).or(sampleUv.y.greaterThan(float(1.0).sub(inset))), () => {
        Discard();
      });
    });

    // Wipe masking
    If(uWipeType.greaterThan(int(0)).and(uWipeProgress.lessThan(1.0)), () => {
      const masked = bool(false).toVar();
      If(uWipeType.equal(int(1)), () => { masked.assign(sampleUv.x.greaterThan(uWipeProgress)); });
      If(uWipeType.equal(int(2)), () => { masked.assign(sampleUv.x.lessThan(float(1.0).sub(uWipeProgress))); });
      If(uWipeType.equal(int(3)), () => { masked.assign(sampleUv.y.lessThan(float(1.0).sub(uWipeProgress))); });
      If(uWipeType.equal(int(4)), () => { masked.assign(sampleUv.y.greaterThan(uWipeProgress)); });
      If(uWipeType.equal(int(5)), () => {
        // 0.7071 = sqrt(0.5) = max corner distance
        masked.assign(length(sampleUv.sub(vec2(0.5))).greaterThan(uWipeProgress.mul(0.7071)));
      });
      If(masked, () => { Discard(); });
    });

    // Fit-contain: keep the FULL media plate visible (never crop). The letterbox
    // is a scale about the middle, kept as `fitScale` so anything else that has
    // to live in texture space — the transition blur's centre and direction —
    // rides the identical remap instead of guessing.
    const texUv = sampleUv.toVar();
    const contentHalf = uCanvasSize.mul(0.5).toVar();
    const fitScale = vec2(1.0).toVar();
    If(uResolution.x.greaterThan(0.0).and(uResolution.y.greaterThan(0.0))
      .and(uCanvasSize.x.greaterThan(0.0)).and(uCanvasSize.y.greaterThan(0.0)), () => {
      const mediaAR = uResolution.x.div(uResolution.y);
      const canvasAR = uCanvasSize.x.div(uCanvasSize.y);
      If(abs(mediaAR.sub(canvasAR)).greaterThan(0.01), () => {
        If(mediaAR.greaterThan(canvasAR), () => {
          // Media wider than the frame → fit width, letterbox top/bottom.
          fitScale.y.assign(mediaAR.div(canvasAR));
          texUv.y.assign(sampleUv.y.sub(0.5).mul(fitScale.y).add(0.5));
          contentHalf.y.assign(uCanvasSize.y.mul(0.5).mul(canvasAR.div(mediaAR)));
        }).Else(() => {
          // Media taller than the frame → fit height, pillarbox left/right.
          fitScale.x.assign(canvasAR.div(mediaAR));
          texUv.x.assign(sampleUv.x.sub(0.5).mul(fitScale.x).add(0.5));
          contentHalf.x.assign(uCanvasSize.x.mul(0.5).mul(mediaAR.div(canvasAR)));
        });
      });
    });

    // Same display-oriented inverse source warp as clipShader.js. It is placed
    // after fit-contain so the stabilization always works in video pixels, not
    // in the composition/layer box or any camera coordinate system.
    If(uStabilizeOn.greaterThan(0.5).and(uStabilizeSize.x.greaterThan(0.0))
      .and(uStabilizeSize.y.greaterThan(0.0)), () => {
      const outPx = vec2(texUv.x.mul(uStabilizeSize.x),
        float(1.0).sub(texUv.y).mul(uStabilizeSize.y));
      const srcPx = vec2(
        uStabilizeLinear.x.mul(outPx.x).add(uStabilizeLinear.y.mul(outPx.y)),
        uStabilizeLinear.z.mul(outPx.x).add(uStabilizeLinear.w.mul(outPx.y)),
      ).add(uStabilizeOffset);
      texUv.assign(vec2(srcPx.x.div(uStabilizeSize.x),
        float(1.0).sub(srcPx.y.div(uStabilizeSize.y))));
    });

    // Crop the content rect to the grid cell. Done on the rect the letterbox
    // just resolved, so it hugs the DRAWN pixels rather than the quad.
    If(uCellCrop.x.lessThan(0.999).or(uCellCrop.y.lessThan(0.999)), () => {
      const pCell = sampleUv.sub(0.5).mul(uCanvasSize);
      If(abs(pCell.x).greaterThan(contentHalf.x.mul(uCellCrop.x))
        .or(abs(pCell.y).greaterThan(contentHalf.y.mul(uCellCrop.y))), () => {
        Discard();
      });
    });

    // Card framing needs the letterbox area to stay transparent so what is below
    // shows through, so it opts out of the early return the plain path takes.
    const hasShadow = uShadowCount.greaterThan(int(0));
    const hasFraming = uCornerRadii.x.add(uCornerRadii.y).add(uCornerRadii.z).add(uCornerRadii.w)
      .greaterThan(0.25).or(uBorderWidth.greaterThan(0.25)).or(hasShadow);

    const insideMedia = bool(true).toVar();
    const resolved = bool(false).toVar();   // the GLSL's early `return`
    const outColor = vec4(0.0).toVar();

    If(uMirrorTile.greaterThan(0.5), () => {
      texUv.assign(mirrorRepeat2(texUv));
    }).Else(() => {
      If(texUv.x.lessThan(0.0).or(texUv.x.greaterThan(1.0))
        .or(texUv.y.lessThan(0.0)).or(texUv.y.greaterThan(1.0)), () => {
        If(hasFraming.not(), () => {
          // Letterbox/pillarbox area of a clip that doesn't match the canvas
          // aspect. Normally opaque black — the bars read like a video player's
          // and hide the layers below. In a transparent export they must stay
          // empty instead, or one mismatched clip makes the whole alpha channel
          // opaque; a grid cell keeps them empty too, since a cell is not the frame.
          const empty = vec4(0.0, 0.0, 0.0,
            uOpacity.mul(float(1.0).sub(uAlphaExport)).mul(float(1.0).sub(uGridCell))
              .mul(float(1.0).sub(uvPushedOut))).toVar();
          If(uBgColor.a.greaterThan(0.001).and(uvPushedOut.lessThan(0.5)), () => {
            empty.rgb.assign(mix(uBgColor.rgb, empty.rgb, empty.a));
            empty.a.assign(max(empty.a, uBgColor.a));
          });
          outColor.assign(empty);
          resolved.assign(true);
        }).Else(() => {
          insideMedia.assign(false);
          texUv.assign(clamp(texUv, 0.0, 1.0));
        });
      });
    });

    If(resolved.not(), () => {
      // 3D Depth: displace the sampling UV by this pixel's depth so the camera's
      // move parts near pixels from far ones. The loop is the point — one lookup
      // would use the depth of the pixel we started from, so a silhouette drags
      // its own background along with it.
      If(uDepthOn.greaterThan(0.5).and(insideMedia), () => {
        // Unrolled in JS, which is the form pair 05 verdicted — the loop-carried
        // value stays a NODE (`shifted` is a var), so the three iterations fold
        // at f32 exactly as the GLSL's do.
        const shifted = texUv.toVar();
        for (let i = 0; i < 3; i += 1) {
          const d = uDepthMap.sample(shifted).r.sub(uDepthFocus);
          // Dolly MAGNIFIES the near plane, and magnifying means sampling closer
          // to the centre — hence the minus.
          shifted.assign(texUv.add(uDepthShift.mul(d)).sub(texUv.sub(0.5).mul(uDepthDolly.mul(d))));
        }
        texUv.assign(clamp(shifted, 0.0, 1.0));
      });

      // The zoom pivot is a FIXED POINT of the layer's UV transform, so it needs
      // no un-zooming here — only the letterbox remap that separates frame space
      // from texture space.
      const color = sampleWithZoomBlur(
        texUv,
        vec2(0.5).add(uZoomCenter.sub(0.5).mul(fitScale)),
        uMoveBlur.mul(fitScale),
        uSplitMove.mul(fitScale),
      ).toVar();
      If(insideMedia.not(), () => { color.assign(vec4(0.0)); });

      // Per-layer Overlay Effects render into a transparent framebuffer, whose
      // RGB is premultiplied. Transitions reuse this material, which normally
      // accepts straight alpha, so recover straight RGB before opacity/wipe/blend
      // — otherwise soft edges are multiplied twice.
      If(uInputPremultiplied.greaterThan(0.5).and(color.a.greaterThan(0.00001)), () => {
        color.rgb.divAssign(color.a);
      });

      If(uTileFade.greaterThan(0.001).and(tileFill.greaterThan(0.0)), () => {
        color.rgb.mulAssign(float(1.0).sub(uTileFade.mul(tileFill)));
      });

      // Lit-card shading from the perspective tilt's source depth: the receding
      // half falls into shadow, the near half gets a whisper of lift.
      If(uPerspShade.greaterThan(0.001).and(abs(uPerspTilt).greaterThan(0.0005)), () => {
        const shadeR = perspDepth.div(max(uPerspDist, 0.2).mul(0.35));
        color.rgb.mulAssign(float(1.0).sub(uPerspShade.mul(0.85).mul(clamp(shadeR.negate(), 0.0, 1.0))));
        color.rgb.mulAssign(float(1.0).add(uPerspShade.mul(0.15).mul(clamp(shadeR, 0.0, 1.0))));
      });

      // Color Correction fixes the SOURCE, ahead of the stylising filters. The
      // Before/After split compares the frame x of the interpolated clip
      // position — the GLSL's vCcClip — with the split.
      If(uCcCtl.x.greaterThan(0.5), () => {
        const frameX = modelViewProjection.x.div(modelViewProjection.w).mul(0.5).add(0.5);
        If(uCcCtl.y.lessThan(0.0).or(frameX.greaterThanEqual(uCcCtl.y)), () => {
          const src = clamp(color.rgb, 0.0, 1.0).toVar();
          const g = ccToDisp(ccToLin(src).mul(uCcGain)).toVar();
          If(uCcTone2.y.greaterThan(0.5), () => { g.assign(ccTone(g, uCcTone, uCcTone2.x)); });
          If(uCcCtl.w.lessThan(0.5), () => {
            If(uCcFlags.x.greaterThan(0.5), () => { g.assign(ccLevels(g, uCcLvInB, uCcLvInW, uCcLvGam, uCcLvOutB, uCcLvOutW)); });
            If(uCcFlags.y.greaterThan(0.5), () => { g.assign(ccColor(g, uCcTone2.z, uCcTone2.w)); });
            If(uCcFlags.z.greaterThan(0.5), () => { g.assign(ccWheels(g, uCcWhS, uCcWhM, uCcWhH)); });
            If(uCcFlags.w.greaterThan(0.5), () => { g.assign(ccHsl(g, uCcHslH0, uCcHslH1, uCcHslS0, uCcHslS1, uCcHslL0, uCcHslL1)); });
          });
          color.rgb.assign(mix(src, clamp(g, 0.0, 1.0), uCcCtl.z));
        });
      });

      color.rgb.mulAssign(uBrightness);                                          // brightness
      color.rgb.assign(color.rgb.sub(0.5).mul(uContrast).add(0.5));              // contrast
      const luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));            // saturation
      color.rgb.assign(mix(vec3(luminance), color.rgb, uSaturation));
      If(abs(uHueRotate).greaterThan(0.5), () => {                               // hue — guard is SEMANTIC
        color.rgb.assign(applyHueRotation(color.rgb, uHueRotate));
      });
      If(uGrayscale.greaterThan(0.0), () => {                                    // grayscale
        const gray = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
        color.rgb.assign(mix(color.rgb, vec3(gray), uGrayscale));
      });
      If(uSepia.greaterThan(0.0), () => {                                        // sepia
        const sepiaColor = vec3(
          dot(color.rgb, vec3(0.393, 0.769, 0.189)),
          dot(color.rgb, vec3(0.349, 0.686, 0.168)),
          dot(color.rgb, vec3(0.272, 0.534, 0.131)),
        );
        color.rgb.assign(mix(color.rgb, sepiaColor, uSepia));
      });
      If(uInvert.greaterThan(0.0), () => {                                       // invert
        color.rgb.assign(mix(color.rgb, vec3(1.0).sub(color.rgb), uInvert));
      });
      color.rgb.mulAssign(uTintColor);                                           // tint
      // Transition bloom — the GLSL's 16-tap golden-angle spiral, JS-unrolled so
      // the constant weights fold at f32 like the GLSL's. Bloom sits under the
      // flash: leaked light is still light, so the wash blows it out too. The
      // guard branches on a uniform, so the samples stay in uniform control flow.
      If(uBloomAmount.greaterThan(0.001), () => {
        const rad = vec2(uCanvasSize.y.div(max(uCanvasSize.x, 1.0)), 1.0)
          .mul(uBloomRadius.div(1080.0)).mul(fitScale).toVar();
        const acc = vec3(0.0).toVar();
        const ws = float(0.0).toVar();
        for (let i = 0; i < 16; i += 1) {
          const ang = float(i).mul(2.39996);
          const rr = sqrt(float(i).add(0.5).div(16.0));
          const s = uTexture.sample(clamp(texUv.add(vec2(cos(ang), sin(ang)).mul(rr).mul(rad)), 0.0, 1.0)).rgb;
          const w = float(1.0).sub(rr.mul(0.7));
          const bright = max(float(0.0), dot(s, vec3(0.2126, 0.7152, 0.0722)).sub(uBloomThreshold))
            .div(max(float(1.0).sub(uBloomThreshold), 1e-3));
          acc.addAssign(s.mul(bright).mul(w));
          ws.addAssign(w);
        }
        color.rgb.addAssign(acc.div(max(ws, 1e-3)).mul(uBloomAmount));
      });
      If(uFlashAmount.greaterThan(0.001), () => {                                // flash
        color.rgb.assign(mix(color.rgb, uFlashColor, uFlashAmount));
      });
      color.rgb.assign(clamp(color.rgb, 0.0, 1.0));
      color.a.mulAssign(uOpacity);

      If(hasFraming, () => {
        // p = px from the content-rect centre, in this layer's (possibly
        // UV-shifted) space.
        const p = sampleUv.sub(0.5).mul(uCanvasSize);
        const maxR = min(contentHalf.x, contentHalf.y);
        const radii = clampRadii(clamp(uCornerRadii, vec4(0.0), vec4(maxR)), contentHalf);
        const d = roundedRectSDF(p, contentHalf, radii);
        const aa = float(1.5);

        // Clip the content to the rounded rect.
        color.a.mulAssign(float(1.0).sub(smoothstep(aa.negate(), aa, d)));

        // Drop shadows under the content. Loop order preserves CSS semantics:
        // the first shadow sits on top.
        Loop({ start: 0, end: 4, type: 'int' }, ({ i }) => {
          If(i.greaterThanEqual(uShadowCount), () => { Break(); });
          If(uShadowInset.element(i).lessThanEqual(0.5), () => {
            const sp = uShadowParams.element(i);
            const ds = roundedRectSDF(
              p.sub(vec2(sp.x, sp.y.negate())),
              max(contentHalf.add(vec2(sp.w)), vec2(0.5)),
              max(radii.add(vec4(sp.w)), vec4(0.0)),
            );
            const soft = max(sp.z, 1.0);
            const shadowMask = float(1.0).sub(smoothstep(soft.negate(), soft, ds));
            const sc = uShadowColors.element(i);
            color.assign(overComposite(color, vec4(sc.rgb, sc.a.mul(shadowMask).mul(uOpacity))));
          });
        });

        // Inset shadows drawn over the content, clipped to the rounded rect.
        Loop({ start: 0, end: 4, type: 'int' }, ({ i }) => {
          If(i.greaterThanEqual(uShadowCount), () => { Break(); });
          If(uShadowInset.element(i).greaterThanEqual(0.5), () => {
            const sp = uShadowParams.element(i);
            const ds = roundedRectSDF(
              p.sub(vec2(sp.x, sp.y.negate())),
              max(contentHalf.sub(vec2(sp.w)), vec2(0.5)),
              max(radii.sub(vec4(sp.w)), vec4(0.0)),
            );
            const soft = max(sp.z, 1.0);
            const shadowMask = smoothstep(soft.negate(), soft, ds)
              .mul(float(1.0).sub(smoothstep(aa.negate(), aa, d)));
            const sc = uShadowColors.element(i);
            color.assign(overComposite(vec4(sc.rgb, sc.a.mul(shadowMask).mul(uOpacity)), color));
          });
        });

        // Border ring on top, hugging the inside of the rounded edge.
        If(uBorderWidth.greaterThan(0.25), () => {
          const ring = float(1.0).sub(smoothstep(aa.negate(), aa, d))
            .mul(smoothstep(uBorderWidth.negate().sub(aa), uBorderWidth.negate().add(aa), d))
            .mul(borderPatternMask(p, contentHalf, radii, d, uBorderWidth));
          color.assign(overComposite(vec4(uBorderColor.rgb, uBorderColor.a.mul(ring).mul(uOpacity)), color));
        });
      });

      If(uBgColor.a.greaterThan(0.001), () => {
        outColor.assign(vec4(mix(uBgColor.rgb, color.rgb, color.a), max(color.a, uBgColor.a)));
      }).Else(() => {
        outColor.assign(color);
      });
    });

    // Depth mode (the 3D view). With depth writing on, transparent fragments
    // must be discarded or a layer would occlude with its empty pixels.
    If(uDepthCut.greaterThan(0.5).and(outColor.a.lessThan(0.02)), () => { Discard(); });

    // Blend modes: fade the source toward the mode's IDENTITY by its own alpha
    // (coverage × layer opacity) before the hardware blend sees it. GPU blending
    // cannot do it for us — Min/Max ignore the blend factors entirely, and
    // screen's OneMinusSrcColor factor never looks at alpha — so without this a
    // layer at 30% opacity would still screen/lighten/darken at FULL strength.
    // Covers the letterbox path too: `outColor` is the single exit.
    If(uBlendCustom.greaterThan(0.5), () => {
      outColor.rgb.assign(mix(uBlendIdentity, outColor.rgb, outColor.a));
    });

    return outColor;
  });

  const uniforms = {
    uTexture, uDepthMap, uOpacity, uBlendCustom, uBlendIdentity,
    uBrightness, uContrast, uSaturation, uHueRotate,
    uGrayscale, uSepia, uInvert, uBlur, uZoomBlur, uZoomCenter, uMoveBlur, uRgbSplit, uSplitMove,
    uCcCtl, uCcGain, uCcTone, uCcTone2, uCcFlags, uCcLvInB, uCcLvInW, uCcLvGam, uCcLvOutB, uCcLvOutW,
    uCcWhS, uCcWhM, uCcWhH, uCcHslH0, uCcHslH1, uCcHslS0, uCcHslS1, uCcHslL0, uCcHslL1,
    uTileFade, uClipPathInset, uLetterSpacing, uTintColor, uBgColor, uFlashColor,
    uFlashAmount, uBloomAmount, uBloomThreshold, uBloomRadius,
    uResolution, uCanvasSize, uStabilizeOn, uStabilizeLinear, uStabilizeOffset,
    uStabilizeSize, uCellCrop, uGridCell, uUvOffset, uUvScale,
    uFisheye, uFisheyeFit, uFisheyeModel, uFisheyeCenter, uUvPreOffset, uUvRotate, uUvRotateCenter,
    uPerspTilt, uPerspAxis, uPerspDist, uPerspPivot, uPerspShade,
    uMirrorTile, uAlphaExport, uInputPremultiplied, uInputFlipV, uPlaneExpand, uWipeType, uWipeProgress,
    uCornerRadii, uBorderWidth, uBorderStyle, uBorderColor, uShadowCount, uShadowColors,
    uShadowParams, uShadowInset, uDepthOn, uDepthShift, uDepthDolly, uDepthFocus, uDepthCut,
  };

  // The array uniforms are the one place the nodes canNOT be the facade
  // themselves. A `UniformArrayNode` keeps the DATA on `.array` and uses
  // `.value` for something else entirely — the packed Float32Array it uploads,
  // which `update()` fills from `.array` every render. Redirecting `.value` onto
  // `.array` would therefore have the packer write vectors into its own source
  // and upload nothing. So these three get a separate accessor object whose
  // `.value` is the node's `.array`: the app keeps writing
  // `u.uShadowColors.value[i].set(…)`, there is still exactly one copy of the
  // data, and the node is left alone to pack it.
  for (const name of ['uShadowColors', 'uShadowParams', 'uShadowInset']) {
    const node = uniforms[name];
    uniforms[name] = {
      node,
      get value() { return node.array; },
      set value(next) { node.array = next; },
    };
  }

  return { fragment: fragment(), uniforms };
}

/**
 * The TSL clip material. Same shape a `createClipMaterial()` result has —
 * `.uniforms.<name>.value` included — so the Player and every uniform writer
 * treat the two interchangeably.
 */
export function createClipNodeMaterial() {
  const { fragment, uniforms } = buildClipNodes();
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = fragment;
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  // ShaderMaterial defaults this to true, every NodeMaterial to false; leaving
  // it false opts a transparent DoubleSide material into the two-pass
  // back/front draw and reorders any self-overlap (PORTING-GUIDE §13).
  material.forceSinglePass = true;
  material.uniforms = uniforms;
  return material;
}
