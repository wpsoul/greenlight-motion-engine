/*
 * TSL twin of runningGlow.js's two passes — matrix row 12.
 *
 * Ported from the verdicted pair 12 (html/webgpu-migration/webgpu/12-running-glow.html),
 * which matched on 35 states. The pass bodies below are that lab's, and they are
 * kept VERBATIM: the only adaptation is at the bindings, aliased just under the
 * uniform bank so the lab's `plateNode` / `fieldNode` / `rtUv` names still read
 * the way the verdicted code does.
 *
 * The two passes bind DIFFERENT things to the same uniform name, which is the
 * whole of the flip question here:
 *
 *   pre   uTexture = the layer plate, an UPLOADED texture — never flipped.
 *   main  uTexture = the FIELD render target — flipped on WebGPU (§3.4);
 *         uSource  = the layer plate again, still not flipped.
 *
 * So `main`'s uTexture declares `flipY` at construction rather than waiting for a
 * caller to remember: unlike the adjustment effects, whose uTexture is sometimes
 * a plate and sometimes an intermediate, this binding is STRUCTURALLY always the
 * field target. Getting it wrong is silent — the glow just runs along the wrong
 * rows and still looks like a glow.
 *
 * Every helper carries an explicit `.setLayout()`. That is not tidiness: without
 * one, TSL inlines the closure at every call site (PORTING-GUIDE §2), and `geMask`
 * alone is called ~130x per fragment in the pre pass.
 */
import * as THREE from 'three/webgpu';
import {
  uniform, texture, vec2, vec3, vec4, float, clamp, mix, max, min, abs, length, step, sign,
  dot, fract, floor, cos, sin, exp, atan, radians, smoothstep,
  Fn, If, Loop, Break, screenCoordinate, screenSize, positionGeometry,
} from 'three/tsl';
import { GLOW_DEFAULTS } from './runningGlow.js';
import { makeTslSampler } from './tslSampler.js';
import { stableAtan2 } from './stableAtan2.js';

/** Null-safe binding facade — see tslSampler.js for why null must never
 * reach TextureNode.value, and why the fallback is created once. */
const makeSampler = (flip = false) => makeTslSampler({ rgba: [0, 0, 0, 0], flipY: flip });

// Mirrors runningGlow.js's baseUniforms() key for key, so
// applyRunningGlowUniforms drives these materials unchanged.
function makeUniforms(isMain) {
  return {
    /*
     * MAIN's uTexture is the field target the pre pass wrote, and it flips;
     * PRE's uTexture is the plate, and does not.
     *
     * WHAT WAS MEASURED, by reading the intermediate FIELD TARGET back from the
     * app on both backends — the instrument that finally separated the two
     * passes after three bindings had been guessed and eliminated:
     *
     *   * the glow SOURCE target matches directly (0 px over);
     *   * the FIELD target does NOT — it is an EXACT vertical mirror, matching
     *     WebGL's flipped at 0 px over, max 1;
     *   * main's flip cancels that mirror, and the final output is
     *     BYTE-IDENTICAL to the alternative pairing (`!isMain`), which produces
     *     an unmirrored field instead.
     *
     * So orientation is NOT the cause of the remaining app-path difference —
     * both arrangements give the same pixels — and the residual lives in main's
     * arithmetic on a field that is provably reproducible.
     *
     * The pairing is left as `isMain` because the alternative, while it yields a
     * tidier intermediate, breaks 20 of the 40 lab states: the lab's pass
     * arrangement is the OPPOSITE of the app's for this binding. That
     * disagreement is real and worth fixing, but swapping a green test for an
     * unverified change buys nothing measurable here.
     */
    uTexture: makeSampler(isMain),
    uSource: makeSampler(false),
    uResolution: uniform(new THREE.Vector2(1280, 720)),
    uTime: uniform(0),
    uMix: uniform(1),
    uQuality: uniform(1),
    uEdgeWidth: uniform(GLOW_DEFAULTS.glowEdgeWidth),
    uGlowRadius: uniform(GLOW_DEFAULTS.glowRadius),
    uEdgeLevel: uniform(GLOW_DEFAULTS.glowEdgeLevel),
    uGlowLevel: uniform(GLOW_DEFAULTS.glowLevel),
    uSpeed: uniform(GLOW_DEFAULTS.glowSpeed),
    uCount: uniform(GLOW_DEFAULTS.glowCount),
    uTrail: uniform(GLOW_DEFAULTS.glowTrail),
    uStaticRim: uniform(GLOW_DEFAULTS.glowStaticRim),
    uEdgeOffset: uniform(GLOW_DEFAULTS.glowOffset),
    uPathMode: uniform(GLOW_DEFAULTS.glowPathMode),
    uAngle: uniform(GLOW_DEFAULTS.glowAngle),
    uFlicker: uniform(GLOW_DEFAULTS.glowFlicker),
    uMaskMode: uniform(GLOW_DEFAULTS.glowMaskMode),
    uMaskThreshold: uniform(GLOW_DEFAULTS.glowMaskThreshold),
    uSourceLevel: uniform(GLOW_DEFAULTS.glowSourceLevel),
    uCenterX: uniform(GLOW_DEFAULTS.glowCenterX),
    uCenterY: uniform(GLOW_DEFAULTS.glowCenterY),
    uSoftness: uniform(GLOW_DEFAULTS.glowSoftness),
    uHeadGlint: uniform(GLOW_DEFAULTS.glowHeadGlint),
    uSpread: uniform(GLOW_DEFAULTS.glowSpread),
    uTraceThin: uniform(GLOW_DEFAULTS.glowTraceThin),
    uHeadColor: uniform(new THREE.Color(0xffffff)),
    uTailColor: uniform(new THREE.Color(0x37d6ff)),
    uGlowColor: uniform(new THREE.Color(0x1f6bff)),
    uHeadAlpha: uniform(1),
    uTailAlpha: uniform(1),
    uGlowAlpha: uniform(1),
  };
}

function buildPass(isMain, standaloneTarget) {
  const u = makeUniforms(isMain);
  const uRes = u.uResolution;
  // GLSL derives uv from gl_FragCoord/uResolution, which is y-UP; WebGPU's
  // fragment builtin is y-DOWN. Reproduce the arithmetic, don't substitute uv().
  /*
   * GLSL derives uv from gl_FragCoord/uResolution, which is y-UP; WebGPU's
   * fragment builtin is y-DOWN. Reproduce the arithmetic, don't substitute uv().
   *
   * Measured equivalent to `positionGeometry.xy * 0.5 + 0.5` for this pass —
   * swapping one for the other produced a byte-identical frame. That holds
   * because the vertex stage writes clip space by hand from a SYMMETRIC
   * fullscreen quad, so the two derivations coincide; it is not a general
   * identity, and repetile (whose vertex maps data, not a symmetric quad) is the
   * counterexample.
   */
  const uvv = vec2(screenCoordinate.x, screenSize.y.sub(screenCoordinate.y)).div(uRes);
  // Sampling a render-target texture and doing screen-space geometry are NOT the
  // same coordinate problem. `uvv` compensates texture orientation; Three's
  // screenCoordinate already matches gl_FragCoord for arithmetic that samples
  // nothing (proved by the composite fragcoord probe). Reusing `uvv` for the
  // orbit mirrored only its Y phase. The angle-0 linear sweep hid that because
  // it reads X alone, which is why changing atan2 never moved the residual.
  // The shipped Player adds this pass to its target/composite chain, where the
  // direct coordinate is the visual screen coordinate. The isolated row-12
  // harness reads this target back immediately; its logical readback convention
  // needs the texture-oriented coordinate to compare that intermediate. The
  // real-player test covers the default production branch.
  const frameUv = standaloneTarget ? uvv : screenCoordinate.xy.div(uRes);

  // The lab's binding names, aliased onto this pass's uniforms so its bodies
  // below stay verbatim. `rtUv` is the identity because makeSampler already
  // applies the flip at the binding, which is where it belongs.
  const plateNode = isMain ? u.uSource : u.uTexture;
  const fieldNode = u.uTexture;
  const rtUv = (s) => s;

  const luma = Fn(([c]) => dot(c, vec3(0.2126, 0.7152, 0.0722)))
      .setLayout({ name: 'geLuma', type: 'float', inputs: [{ name: 'c', type: 'vec3' }] });

    const unpremult = Fn(([c]) => c.rgb.div(max(c.a, 1e-4)))
      .setLayout({ name: 'geUnpremult', type: 'vec3', inputs: [{ name: 'c', type: 'vec4' }] });

    const hash21 = Fn(([pIn]) => {
      const p = fract(pIn.mul(vec2(123.34, 456.21))).toVar();
      p.addAssign(dot(p, p.add(45.32)));
      return fract(p.x.mul(p.y));
    }).setLayout({ name: 'geHash21', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

    // ── SHARED (mask + the two field radii) ───────────────────────────────────
    const GE_BW = 0.22;

    // geMask() reads uMaskThreshold/uMaskMode from the uniform block in GLSL; here
    // they are explicit arguments so the helper stays a pure function and its
    // layout is unambiguous.
    const geMask = Fn(([s, thrRaw, mode]) => {
      const thr = clamp(thrRaw.div(100.0), 0.0, 0.99).toVar();
      const lum = smoothstep(thr, min(thr.add(0.30), 1.0), luma(unpremult(s))).mul(s.a).toVar();
      const out = float(0.0).toVar();
      If(mode.greaterThan(1.5), () => { out.assign(min(s.a, lum)); })
        .ElseIf(mode.greaterThan(0.5), () => { out.assign(lum); })
        .Else(() => { out.assign(s.a); });
      return out;
    }).setLayout({
      name: 'geMask', type: 'float',
      inputs: [{ name: 's', type: 'vec4' }, { name: 'thrRaw', type: 'float' }, { name: 'mode', type: 'float' }],
    });

    const geScale = () => uRes.y.div(1080.0);
    const geNarrowR = () => max(max(u.uEdgeWidth.mul(1.55), abs(u.uEdgeOffset).mul(1.35)), 1.2).mul(geScale());
    const geWideR = () => max(max(u.uGlowRadius.mul(1.55), abs(u.uEdgeOffset).mul(1.35)), 4.0).mul(geScale());
    // GLSL: int(clamp(geWideR()*0.55, 12, 48) * mix(0.6, 1, quality)). The argument
    // is always positive, so int() truncation == floor().
    const geWideHalf = () => floor(
      clamp(geWideR().mul(0.55), 12.0, 48.0).mul(mix(0.6, 1.0, clamp(u.uQuality, 0.0, 1.0)))
    );

    // ── Bands + comet (MAIN_FX helpers) ───────────────────────────────────────
    const geBand = Fn(([f, c, w]) => {
      const iw = float(1.0).div(max(w, 0.015)).toVar();
      const d = f.sub(c).mul(iw).toVar();
      const rawE = exp(d.mul(-2.0).mul(d)).toVar();
      const p0 = c.mul(iw).toVar();
      const p1 = float(1.0).sub(c).mul(iw).toVar();
      const ped = max(exp(p0.mul(-2.0).mul(p0)), exp(p1.mul(-2.0).mul(p1))).toVar();
      return clamp(rawE.sub(ped).div(max(float(1.0).sub(ped), 1e-3)), 0.0, 1.0);
    }).setLayout({
      name: 'geBand', type: 'float',
      inputs: [{ name: 'f', type: 'float' }, { name: 'c', type: 'float' }, { name: 'w', type: 'float' }],
    });

    const geComet = Fn(([w, lenT, lenF]) => {
      const v = w.lessThan(0.0).select(
        exp(w.div(max(lenT, 1e-4))),
        exp(w.mul(w).negate().div(max(lenF.mul(lenF), 1e-8)))
      ).toVar();
      const ped = exp(float(-0.5).div(max(lenT, 1e-4))).toVar();
      return clamp(v.sub(ped).div(max(float(1.0).sub(ped), 1e-3)), 0.0, 1.0);
    }).setLayout({
      name: 'geComet', type: 'float',
      inputs: [{ name: 'w', type: 'float' }, { name: 'lenT', type: 'float' }, { name: 'lenF', type: 'float' }],
    });

    const uvClamp = (s) => clamp(s, vec2(0.0), vec2(1.0));

    // ── Pass 1 — horizontal Gaussian of the content mask at both radii ────────
    const preFn = Fn(() => {
      const rN = geNarrowR().toVar();
      const rW = geWideR().toVar();

      const accN = float(0.0).toVar();
      const wsN = float(0.0).toVar();
      Loop(33, ({ i }) => {
        const q = float(i).sub(16.0).div(16.0).toVar();
        const w = exp(q.mul(-2.0).mul(q)).toVar();
        const s = uvv.add(vec2(q.mul(2.0).mul(rN).div(uRes.x), 0.0)).toVar();
        accN.addAssign(geMask(plateNode.sample(uvClamp(s)), u.uMaskThreshold, u.uMaskMode).mul(w));
        wsN.addAssign(w);
      });

      const accW = float(0.0).toVar();
      const wsW = float(0.0).toVar();
      // Radius 0 disables the bloom, so don't pay for its taps (a perf guard — with
      // the loop skipped wsW stays 0 and the field reads 0 either way).
      If(u.uGlowRadius.greaterThanEqual(0.5), () => {
        const halfW = geWideHalf().toVar();
        Loop(97, ({ i }) => {
          If(float(i).greaterThan(halfW.mul(2.0)), () => { Break(); });
          const q = float(i).sub(halfW).div(halfW).toVar();
          const w = exp(q.mul(-2.0).mul(q)).toVar();
          const s = uvv.add(vec2(q.mul(2.0).mul(rW).div(uRes.x), 0.0)).toVar();
          accW.addAssign(geMask(plateNode.sample(uvClamp(s)), u.uMaskThreshold, u.uMaskMode).mul(w));
          wsW.addAssign(w);
        });
      });

      return vec4(accN.div(max(wsN, 1e-4)), accW.div(max(wsW, 1e-4)), 0.0, 1.0);
    });

    // ── Pass 2 — vertical completion, bands, runner, composite ────────────────
    const mainFn = Fn(() => {
      const rN = geNarrowR().toVar();
      const rW = geWideR().toVar();

      const accN = float(0.0).toVar();
      const wsN = float(0.0).toVar();
      Loop(33, ({ i }) => {
        const q = float(i).sub(16.0).div(16.0).toVar();
        const w = exp(q.mul(-2.0).mul(q)).toVar();
        const s = uvClamp(uvv.add(vec2(0.0, q.mul(2.0).mul(rN).div(uRes.y)))).toVar();
        accN.addAssign(fieldNode.sample(rtUv(s)).r.mul(w));
        wsN.addAssign(w);
      });

      const accW = float(0.0).toVar();
      const wsW = float(0.0).toVar();
      If(u.uGlowRadius.greaterThanEqual(0.5), () => {
        const halfW = geWideHalf().toVar();
        Loop(97, ({ i }) => {
          If(float(i).greaterThan(halfW.mul(2.0)), () => { Break(); });
          const q = float(i).sub(halfW).div(halfW).toVar();
          const w = exp(q.mul(-2.0).mul(q)).toVar();
          const s = uvClamp(uvv.add(vec2(0.0, q.mul(2.0).mul(rW).div(uRes.y)))).toVar();
          accW.addAssign(fieldNode.sample(rtUv(s)).g.mul(w));
          wsW.addAssign(w);
        });
      });

      const fN = accN.div(max(wsN, 1e-4)).toVar();
      const fW = accW.div(max(wsW, 1e-4)).toVar();

      // ---- the two bands -----------------------------------------------------
      const offPx = u.uEdgeOffset.mul(geScale()).toVar();
      const soft = mix(0.7, 1.6, clamp(u.uSoftness.div(100.0), 0.0, 1.0)).toVar();

      const cN = clamp(float(0.5).add(float(0.4).mul(offPx).div(rN)), 0.06, 0.94).toVar();
      const core = geBand(fN, cN, GE_BW).toVar();

      const cW = clamp(float(0.5).add(float(0.4).mul(offPx).div(rW)), 0.06, 0.94).toVar();
      const haloW = float(GE_BW).mul(soft).toVar();
      const halo = geBand(fW, cW, haloW).toVar();

      // THIN mode — the fields ARE the line for stroke content (a band centred on
      // 0.5 finds nothing on a 3px stroke at a 50px radius).
      If(u.uTraceThin.greaterThan(0.5), () => {
        const w = max(u.uEdgeWidth, 0.5).mul(geScale()).toVar();
        const peakN = clamp(w.div(max(rN.mul(1.6), 1e-3)), 0.02, 1.0).toVar();
        const peakW = clamp(w.div(max(rW.mul(1.6), 1e-3)), 0.01, 1.0).toVar();
        core.assign(clamp(fN.div(peakN), 0.0, 1.0));
        halo.assign(clamp(fW.div(peakW), 0.0, 1.0));
        If(offPx.greaterThan(0.001), () => {
          halo.mulAssign(clamp(float(1.0).sub(core.mul(0.85)), 0.0, 1.0));
        });
      });

      If(u.uGlowRadius.lessThan(0.5), () => { halo.assign(0.0); });

      // Spread: which side of the contour the bloom may land on.
      const bias = clamp(u.uSpread.div(100.0), -1.0, 1.0).toVar();
      If(abs(bias).greaterThan(0.001), () => {
        const outward = cW.sub(fW).div(max(haloW, 1e-3)).toVar();
        halo.mulAssign(mix(1.0, smoothstep(-0.9, 0.9, outward.mul(sign(bias))), abs(bias)));
      });

      // ---- the runner --------------------------------------------------------
      const ar = uRes.x.div(uRes.y).toVar();
      const ctr = vec2(float(0.5).add(u.uCenterX.div(100.0)), float(0.5).add(u.uCenterY.div(100.0))).toVar();
      const p = frameUv.sub(ctr).mul(vec2(ar, 1.0)).toVar();

      const phase = float(0.0).toVar();
      If(u.uPathMode.lessThan(0.5), () => {
        // Polynomial rather than hardware atan2 keeps the two backends stable at
        // quadrant boundaries. See stableAtan2.js.
        phase.assign(stableAtan2(p.y, p.x).div(6.2831853).add(0.5));
      }).Else(() => {
        const a = radians(u.uAngle).toVar();
        const dir = vec2(cos(a), sin(a)).toVar();
        const span = abs(dir.x).mul(ar).add(abs(dir.y)).toVar();
        phase.assign(dot(p, dir).div(max(span, 1e-3)).add(0.5));
      });

      const count = max(1.0, floor(u.uCount.add(0.5))).toVar();
      const x = fract(phase.mul(count).sub(u.uTime.mul(u.uSpeed))).toVar();
      const wrapped = x.sub(floor(x.add(0.5))).toVar();
      If(u.uSpeed.lessThan(0.0), () => { wrapped.assign(wrapped.negate()); });

      const trail = clamp(u.uTrail.div(100.0), 0.0, 1.0).toVar();
      const lenT = mix(0.012, 0.34, trail).toVar();
      const lenF = mix(0.006, 0.05, trail).toVar();
      const comet = geComet(wrapped, lenT, lenF).toVar();
      const cometH = geComet(wrapped, lenT.mul(1.3), lenF.mul(3.2)).toVar();

      const baseLvl = clamp(u.uStaticRim.div(100.0), 0.0, 1.0).toVar();
      const run = baseLvl.add(float(1.0).sub(baseLvl).mul(comet)).toVar();
      const runH = baseLvl.add(float(1.0).sub(baseLvl).mul(cometH)).toVar();

      const flick = clamp(u.uFlicker.div(100.0), 0.0, 1.0).toVar();
      If(flick.greaterThan(0.001), () => {
        const tn = u.uTime.mul(13.0).toVar();
        const n = mix(
          hash21(vec2(floor(tn), 3.7)),
          hash21(vec2(floor(tn).add(1.0), 3.7)),
          smoothstep(0.0, 1.0, fract(tn))
        ).toVar();
        const fmul = mix(1.0, float(0.4).add(float(0.85).mul(n)), flick).toVar();
        run.mulAssign(fmul);
        runH.mulAssign(fmul);
      });

      // ---- colour ------------------------------------------------------------
      const hotness = geComet(wrapped, lenT.mul(0.34), lenF.mul(1.6)).toVar();
      const lineCol = mix(u.uTailColor, u.uHeadColor, hotness).toVar();
      const lineAlpha = mix(u.uTailAlpha, u.uHeadAlpha, hotness).toVar();
      const glint = geComet(wrapped, lenF.mul(1.2), lenF.mul(0.7))
        .mul(clamp(u.uHeadGlint.div(100.0), 0.0, 2.0)).toVar();
      lineCol.assign(mix(lineCol, vec3(1.0), clamp(glint, 0.0, 1.0)));

      // ---- composite ---------------------------------------------------------
      const base = plateNode.sample(uvv).mul(clamp(u.uSourceLevel.div(100.0), 0.0, 1.0)).toVar();

      const coreI = core.mul(run).mul(max(u.uEdgeLevel, 0.0)).mul(float(1.0).add(glint)).mul(lineAlpha).toVar();
      const haloI = halo.mul(runH).mul(max(u.uGlowLevel, 0.0)).mul(u.uGlowAlpha).toVar();

      const add = lineCol.mul(coreI).add(u.uGlowColor.mul(haloI)).toVar();
      const addA = clamp(coreI.add(haloI), 0.0, 1.0).toVar();
      const outA = clamp(base.a.add(addA), 0.0, 1.0).toVar();
      const fxCol = vec4(min(base.rgb.add(add), vec3(outA)), outA).toVar();

      // MAIN's wrapper: mix(texture2D(uSource, uv), fx(uv), clamp(uMix, 0, 1)).
      return mix(plateNode.sample(uvv), fxCol, clamp(u.uMix, 0.0, 1.0));
    });
  return { u, fn: isMain ? mainFn : preFn };
}

/**
 * Same shape `createRunningGlowMaterials()` returns — `{ pre, main }`, each with
 * a `.uniforms` facade — so applyRunningGlowUniforms drives them unchanged.
 */
export function createRunningGlowNodeMaterials({ standaloneTarget = false } = {}) {
  const mk = (isMain) => {
    const { u, fn } = buildPass(isMain, standaloneTarget);
    const m = new THREE.MeshBasicNodeMaterial();
    m.vertexNode = vec4(positionGeometry.xy, 0.0, 1.0);   // the app's raw clip-space VS
    m.fragmentNode = fn();
    m.transparent = false;
    m.blending = THREE.NoBlending;
    m.depthTest = false;
    m.depthWrite = false;
    // ShaderMaterial defaults this true, every NodeMaterial false (§13).
    m.forceSinglePass = true;
    m.uniforms = u;
    return m;
  };
  return { pre: mk(false), main: mk(true) };
}
