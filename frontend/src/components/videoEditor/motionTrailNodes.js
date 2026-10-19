/*
 * TSL twins of motionTrailLayer.js's five passes.
 *
 *   createMotionTrailNodeMaterial()   ← createMotionTrailMaterial()   (multi-tap)
 *   createTrailWarpNodeMaterial()     ← createTrailWarpMaterial()
 *   createTrailAccNodeMaterial()      ← createTrailAccMaterial()
 *   createTrailErodeNodeMaterial()    ← createTrailErodeMaterial()
 *   createTrailComposeNodeMaterial()  ← createTrailComposeMaterial()
 *
 * SAMPLE-SIDE V FLIP, BY PLATE PROVENANCE
 *
 * These passes write a full-screen quad straight to clip space and read with
 * plain `screenCoordinate` UV — measured byte-identical to GLSL's
 * `gl_FragCoord`, and computeLayerBox axes are in that same space. What a pass
 * must do at the SAMPLE point depends on who wrote the plate it reads: a
 * camera-rendered isolate (rt.c fresh from the channel camera) is stored on
 * the opposite V axis under WebGPU and needs uFlipV = 1; every plate these
 * passes write themselves (history, tap, acc, erode buffers) is already in
 * frame-UV space and needs 0. The app sets the flag per draw from
 * rtcCameraAxis; the GLSL twins never need it.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, If, Break, Loop, uniform, uniformArray, vec2, vec3, vec4, float, int,
  abs, min, max, clamp, mix, dot, pow, cos, sin, select, positionGeometry, screenCoordinate,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';
import { TRAIL_MAX_TAPS } from './motionTrailLayer.js';

const LW = vec3(0.299, 0.587, 0.114);

/** Null-safe binding facade; see tslSampler.js. */
const makeSampler = () => makeTslSampler({ rgba: [0, 0, 0, 0] });

/*
 * `uniformArray` keeps its DATA on `.array` and uses `.value` for something
 * else — the packed Float32Array it uploads, refilled from `.array` every
 * render. Redirecting `.value` onto `.array` would make the packer write into
 * its own source and upload nothing, so the app's writers get a separate
 * accessor whose `.value` IS the node's `.array`. That keeps
 * `u.uTapO.value[i].set(x, y)` working with exactly one copy of the data.
 */
function makeVec2Array(length) {
  const node = uniformArray(Array.from({ length }, () => new THREE.Vector2()), 'vec2');
  return {
    node,
    get value() { return node.array; },
    set value(next) { node.array = next; },
  };
}

/** The four premultiplied trail blend modes, shared by three of the passes. */
const trailBlend = (under, over, mode) => {
  const behind = over.add(under.mul(over.a.oneMinus()));
  const add = under.add(over);
  const screen = vec4(1.0).sub(vec4(1.0).sub(under).mul(vec4(1.0).sub(over)));
  return select(mode.lessThan(0.5), behind,
    select(mode.lessThan(1.5), add,
      select(mode.lessThan(2.5), screen, max(under, over))));
};

/** Premultiplied invariant: colour may never exceed its own alpha. */
const clampPremul = (c) => {
  const v = clamp(c, 0.0, 1.0).toVar();
  v.rgb.assign(min(v.rgb, vec3(v.a)));
  return v;
};

/*
 * The full-screen quad, written straight to clip space exactly as the GLSL
 * vertex shader does. Shared by all five materials.
 */
function finish(material, uniforms) {
  material.vertexNode = vec4(positionGeometry.x, positionGeometry.y, 0.0, 1.0);
  material.transparent = false;
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  // ShaderMaterial's constructor sets this true; every NodeMaterial inherits
  // Material's false (PORTING-GUIDE §13).
  material.forceSinglePass = true;
  material.uniforms = uniforms;
  return material;
}

/** Same as GLSL `gl_FragCoord.xy / uResolution` (fragcoord probe: max Δ 0). */
const frameUv = (u) => screenCoordinate.xy.div(u.uResolution);

// ── 1. The multi-tap trail ──────────────────────────────────────────────────

export function createMotionTrailNodeMaterial() {
  const u = {
    uTexture: makeSampler(),
    uResolution: uniform(new THREE.Vector2(1920, 1080)),
    uCurrO: uniform(new THREE.Vector2()),
    uCurrX: uniform(new THREE.Vector2()),
    uCurrY: uniform(new THREE.Vector2()),
    uTapO: makeVec2Array(TRAIL_MAX_TAPS),
    uTapX: makeVec2Array(TRAIL_MAX_TAPS),
    uTapY: makeVec2Array(TRAIL_MAX_TAPS),
    uCount: uniform(0),
    // 1 while uTexture is the camera-rendered isolate; 0 for quad-written plates.
    uFlipV: uniform(0),
    uDecay: uniform(0.88),
    uColorize: uniform(0),
    uTint: uniform(new THREE.Color(0x4fd6ff)),
    uBlend: uniform(0),
    uMix: uniform(1),
  };

  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = frameUv(u);
    const srcUv = vec2(uvn.x, mix(uvn.y, uvn.y.oneMinus(), u.uFlipV));
    const src = u.uTexture.sample(srcUv).toVar();
    const out = vec4(src).toVar();

    If(u.uMix.greaterThan(0.001).and(u.uCount.greaterThanEqual(0.5)), () => {
      const trail = vec4(0.0).toVar();
      Loop({ start: int(0), end: int(TRAIL_MAX_TAPS), type: 'int' }, ({ i }) => {
        If(float(i).greaterThanEqual(u.uCount), () => { Break(); });
        const O = u.uTapO.node.element(i);
        const X = u.uTapX.node.element(i);
        const Y = u.uTapY.node.element(i);
        const det = X.x.mul(Y.y).sub(X.y.mul(Y.x));
        // GLSL `continue`s on a degenerate box; the guarded If is the same
        // thing without a second control-flow construct.
        If(abs(det).greaterThanEqual(1e-9), () => {
          const d = uvn.sub(O);
          const a = d.x.mul(Y.y).sub(d.y.mul(Y.x)).div(det);
          const b = d.x.mul(X.y).negate().add(d.y.mul(X.x)).div(det);
          /*
           * Outside this repeat's own quad. REQUIRED, not an optimisation: a
           * text or motion layer's plate is comp-sized, so without it a
           * far-away pixel samples real artwork instead of nothing.
           */
          If(abs(a).lessThanEqual(1.0).and(abs(b).lessThanEqual(1.0)), () => {
            const tapUv = u.uCurrO.add(u.uCurrX.mul(a)).add(u.uCurrY.mul(b));
            const outside = tapUv.x.lessThan(0.0).or(tapUv.x.greaterThan(1.0))
              .or(tapUv.y.lessThan(0.0)).or(tapUv.y.greaterThan(1.0));
            const c = select(outside, vec4(0.0),
              u.uTexture.sample(vec2(tapUv.x, mix(tapUv.y, tapUv.y.oneMinus(), u.uFlipV)))).toVar();
            If(c.a.greaterThan(0.0), () => {
              If(u.uColorize.greaterThan(0.0), () => {
                const l = dot(c.rgb, LW);
                c.rgb.assign(mix(c.rgb, u.uTint.mul(l).mul(1.35),
                  u.uColorize.mul(float(i).add(1.0)).div(u.uCount)));
              });
              c.mulAssign(pow(u.uDecay, float(i).add(1.0)));
              /*
               * ACCUMULATOR OVER, new tap UNDER — the GLSL writes this one
               * inline as `trail + c * (1 - trail.a)` rather than through
               * trailBlend, and getting the operands the other way round is
               * invisible in three of the four modes: add, screen and max are
               * symmetric. Only Behind exposes it, which is exactly the set of
               * states that failed.
               */
              trail.assign(trailBlend(c, trail, u.uBlend));
            });
          });
        });
      });
      const t = clamp(trail, 0.0, 1.0);
      out.assign(mix(src, clampPremul(trailBlend(t, src, u.uBlend)), u.uMix));
    });
    return out;
  })();

  return finish(material, u);
}

// ── 2. Warp one plate through a box pair ────────────────────────────────────

export function createTrailWarpNodeMaterial() {
  const u = {
    uTexture: makeSampler(),
    uResolution: uniform(new THREE.Vector2(1920, 1080)),
    uSrcO: uniform(new THREE.Vector2()),
    uSrcX: uniform(new THREE.Vector2()),
    uSrcY: uniform(new THREE.Vector2()),
    uDstO: uniform(new THREE.Vector2()),
    uDstX: uniform(new THREE.Vector2()),
    uDstY: uniform(new THREE.Vector2()),
    uWeight: uniform(1),
    uColorize: uniform(0),
    uDepth: uniform(0),
    uTint: uniform(new THREE.Color(0x4fd6ff)),
    // 1 when uTexture is the camera-rendered isolate; 0 for recorded/quad plates.
    uFlipV: uniform(0),
  };

  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = frameUv(u);
    const out = vec4(0.0).toVar();
    const det = u.uDstX.x.mul(u.uDstY.y).sub(u.uDstX.y.mul(u.uDstY.x));
    If(abs(det).greaterThanEqual(1e-9), () => {
      const d = uvn.sub(u.uDstO);
      const a = d.x.mul(u.uDstY.y).sub(d.y.mul(u.uDstY.x)).div(det);
      const b = d.x.mul(u.uDstX.y).negate().add(d.y.mul(u.uDstX.x)).div(det);
      If(abs(a).lessThanEqual(1.0).and(abs(b).lessThanEqual(1.0)), () => {
        const s = u.uSrcO.add(u.uSrcX.mul(a)).add(u.uSrcY.mul(b));
        const inside = s.x.greaterThanEqual(0.0).and(s.x.lessThanEqual(1.0))
          .and(s.y.greaterThanEqual(0.0)).and(s.y.lessThanEqual(1.0));
        If(inside, () => {
          const c = u.uTexture.sample(vec2(s.x, mix(s.y, s.y.oneMinus(), u.uFlipV))).toVar();
          If(u.uColorize.greaterThan(0.0), () => {
            const l = dot(c.rgb, LW);
            c.rgb.assign(mix(c.rgb, u.uTint.mul(l).mul(1.35), u.uColorize.mul(u.uDepth)));
          });
          out.assign(c.mul(u.uWeight));
        });
      });
    });
    return out;
  })();

  return finish(material, u);
}

// ── 3. Accumulate one warped repeat ─────────────────────────────────────────

export function createTrailAccNodeMaterial() {
  const u = {
    uAcc: makeSampler(),
    uTap: makeSampler(),
    uResolution: uniform(new THREE.Vector2(1920, 1080)),
    uBlend: uniform(0),
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = frameUv(u);
    // The trail stacks front-to-back, so a nearer repeat already in acc wins.
    return clampPremul(trailBlend(u.uTap.sample(uvn), u.uAcc.sample(uvn), u.uBlend));
  })();
  return finish(material, u);
}

// ── 4. Trail Buffer: one erode + fade + union step ──────────────────────────

export function createTrailErodeNodeMaterial() {
  const u = {
    uSrc: makeSampler(),
    uAcc: makeSampler(),
    uResolution: uniform(new THREE.Vector2(1920, 1080)),
    uPersist: uniform(0.96),
    uTaper: uniform(1.6),
    uColorize: uniform(0),
    uTint: uniform(new THREE.Color(0x4fd6ff)),
    uBlend: uniform(0),
    // 1 when uSrc is the camera-rendered isolate; 0 for the reprojected plate.
    uFlipSrc: uniform(0),
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = frameUv(u);
    const texel = vec2(u.uTaper).div(u.uResolution);
    const src = u.uSrc.sample(vec2(uvn.x, mix(uvn.y, uvn.y.oneMinus(), u.uFlipSrc)));
    const c0 = u.uAcc.sample(uvn).toVar();
    /*
     * A morphological min over alpha — this is what TAPERS the tail. It eats a
     * fixed number of pixels off the silhouette every frame, so the oldest part
     * is the thinnest: a continuous smear no repeat count can produce.
     */
    const mn = c0.a.toVar();
    Loop({ start: int(0), end: int(8), type: 'int' }, ({ i }) => {
      const ang = float(i).div(8.0).mul(6.2831853);
      const dir = vec2(cos(ang), sin(ang));
      mn.assign(min(mn, u.uAcc.sample(uvn.add(dir.mul(texel))).a));
      mn.assign(min(mn, u.uAcc.sample(uvn.add(dir.mul(texel).mul(0.5))).a));
    });
    const k = select(c0.a.greaterThan(0.002), mn.div(c0.a), float(0.0));
    const aged = c0.mul(k.mul(u.uPersist)).toVar();
    If(u.uColorize.greaterThan(0.0), () => {
      const l = dot(aged.rgb, LW);
      aged.rgb.assign(mix(aged.rgb, u.uTint.mul(l).mul(1.35), u.uColorize.mul(0.16)));
    });
    aged.rgb.assign(min(aged.rgb, vec3(aged.a)));
    return clampPremul(trailBlend(aged, src, u.uBlend));
  })();
  return finish(material, u);
}

// ── 5. Final composite ──────────────────────────────────────────────────────

export function createTrailComposeNodeMaterial() {
  const u = {
    uSrc: makeSampler(),
    uTrail: makeSampler(),
    uResolution: uniform(new THREE.Vector2(1920, 1080)),
    uBlend: uniform(0),
    uMix: uniform(1),
    uHasSource: uniform(0),
    // 1 when uSrc is the camera-rendered isolate; 0 for quad-written plates.
    uFlipSrc: uniform(0),
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = frameUv(u);
    const src = u.uSrc.sample(vec2(uvn.x, mix(uvn.y, uvn.y.oneMinus(), u.uFlipSrc)));
    const trail = u.uTrail.sample(uvn);
    // The buffer step already unioned the source in; the echo accumulator has not.
    const outc = select(u.uHasSource.greaterThan(0.5), trail, trailBlend(trail, src, u.uBlend));
    return mix(src, clampPremul(outc), u.uMix);
  })();
  return finish(material, u);
}
