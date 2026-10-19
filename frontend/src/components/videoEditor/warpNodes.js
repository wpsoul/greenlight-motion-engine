/*
 * TSL twins of the warp layer effects — matrix rows 10/10b.
 *
 * These are the first ported materials with a VERTEX stage. Everything before
 * them was a fullscreen fragment; a warp deforms a grid mesh, so the work splits:
 * the vertex node moves each grid vertex and hands the fragment its REST
 * position through a varying, and the fragment samples at rest and trims the
 * overscan. Three consequences worth stating once, because every warp shares
 * them:
 *
 *   The custom `aRest` attribute is read with `attribute('aRest', 'vec2')`, and
 *   the geometry that supplies it is built by the app's own pass factory — the
 *   grid, its overscan and its index buffer are renderer-agnostic and are not
 *   duplicated here.
 *
 *   `gl_Position` becomes a `vertexNode` in CLIP SPACE. The GLSL writes
 *   `vec4(frameUv * 2 - 1, 0, 1)` directly rather than going through a
 *   projection matrix, so the node does the same instead of using the default
 *   MVP — a warp positions itself.
 *
 *   The edge trim uses `fwidth`, which exists in TSL. It is what keeps the
 *   overscanned grid from showing: the mask is computed in BOX units because the
 *   isolate is frame-sized, so a texture wrap mode would wrap the whole frame
 *   rather than the layer.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Break, uniform, uniformArray, texture, attribute, varying, vec2, vec3, vec4, float,
  dot, cross, mix, clamp, abs, max, min, length, sin, cos, floor, ceil, int, smoothstep, step, select,
  fwidth, Discard, atan, log, exp, pow, sqrt, mod, fract,
  refract, normalize, exp2, sign, screenCoordinate,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';

/** Shared box→frame affine (COMMON in the GLSL): box uv y-DOWN → frame uv. */
/** Null-safe binding facade; see tslSampler.js. Transparent fallback: an
 * unbound warp source contributes nothing rather than a white plate. */
const makeSampler = () => makeTslSampler({ rgba: [0, 0, 0, 0] });

function boxToFrameOf(u) {
  return (b) => {
    const l = vec2(b.x.mul(2.0).sub(1.0), float(1.0).sub(b.y.mul(2.0)));
    return u.uOrigin.add(u.uAxisX.mul(l.x)).add(u.uAxisY.mul(l.y));
  };
}

function finishWarp(material, uniforms, side = THREE.DoubleSide) {
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  // DoubleSide for the warps drawn as ONE mesh (a fold past 180° flips winding).
  // Bezier and Mesh Warp instead draw the two facings as two meshes so the fold
  // can be ordered explicitly, and pass FrontSide/BackSide here.
  material.side = side;
  // ShaderMaterial's CONSTRUCTOR defaults forceSinglePass to true (three.core
  // ShaderMaterial); every NodeMaterial inherits Material's default of false.
  // So porting a ShaderMaterial to a node material silently opts INTO the
  // transparent+DoubleSide two-pass draw — all back faces, then all front
  // faces — and a warp that folds then composites its overlap in a different
  // ORDER than the app does. Nothing else changes: same fragments, same masks,
  // same coordinates, identical under commutative blending. Restore the flag
  // the material being replaced actually had.
  material.forceSinglePass = true;
  material.blending = THREE.CustomBlending;  // the isolate is premultiplied
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.uniforms = uniforms;
  return material;
}

/**
 * Bend: rigid outside the span, arc + stretch inside. The arc lives entirely in
 * the vertex stage; the fragment only samples at rest and trims the overscan.
 */
export function createBendNodeMaterial() {
  const u = {
    uTexture: makeSampler(),
    // 1 while the bound plate is the camera-rendered isolate (rt.c fresh from
    // the channel camera); 0 for any quad-written plate. Set per draw.
    uFlipV: uniform(0),
    uOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uAxisX: uniform(new THREE.Vector2(0.5, 0)),
    uAxisY: uniform(new THREE.Vector2(0, 0.5)),
    uAspect: uniform(1),
    uP0: uniform(new THREE.Vector2(0.5, 0.72)),
    uP1: uniform(new THREE.Vector2(0.5, 0.24)),
    uAngle: uniform(0),
    uStretch: uniform(1),
  };
  const boxToFrame = boxToFrameOf(u);
  const aRest = attribute('aRest', 'vec2');
  const vRest = varying(aRest, 'vRest');

  const A2 = () => vec2(u.uAspect, 1.0);
  const rot2 = (p, a) => {
    const c = cos(a);
    const s = sin(a);
    return vec2(c.mul(p.x).sub(s.mul(p.y)), s.mul(p.x).add(c.mul(p.y)));
  };

  const wBend = (b) => {
    const A = u.uP0.mul(A2());
    const B = u.uP1.mul(A2());
    const P = b.mul(A2());
    const ab = B.sub(A);
    const L = length(ab);
    const out = vec2(b).toVar();
    If(L.greaterThanEqual(1e-5), () => {
      const d = ab.div(L);
      const n = vec2(d.y.negate(), d.x);
      const uu0 = dot(P.sub(A), d);
      const v = dot(P.sub(A), n);
      const st = max(u.uStretch, 0.02);
      const LL = L.mul(st);
      // Rigid before the span, stretched inside it, rigid after.
      const uu = select(uu0.lessThan(0.0), uu0,
        select(uu0.greaterThan(L), LL.add(uu0.sub(L)), uu0.mul(st)));
      const ang = u.uAngle;
      const outP = vec2(0.0).toVar();
      If(abs(ang).lessThan(1e-4), () => {
        outP.assign(A.add(d.mul(uu)).add(n.mul(v)));
      }).Else(() => {
        const R = LL.div(ang);
        const C = A.add(n.mul(R));
        const uc = clamp(uu, float(0.0), LL);
        const th = uc.div(R);
        outP.assign(C.add(rot2(n.negate().mul(R.sub(v)), th)));
        // Outside the arc the geometry leaves tangentially at each end.
        If(uu.greaterThan(LL), () => { outP.addAssign(rot2(d, ang).mul(uu.sub(LL))); })
          .ElseIf(uu.lessThan(0.0), () => { outP.addAssign(d.mul(uu)); });
      });
      out.assign(outP.div(A2()));
    });
    return out;
  };

  const material = new THREE.MeshBasicNodeMaterial();
  // Clip space directly, exactly as the GLSL does — no projection matrix. Wrapped
  // in Fn() because `If()` needs an active TSL stack: control flow cannot live in
  // a bare node expression, and building one outside an Fn fails with
  // "Cannot read properties of null (reading 'If')" rather than anything that
  // points at the cause.
  material.vertexNode = Fn(() => clipFromFrame(boxToFrame(wBend(aRest))))();
  // Identical to every other warp's trim, so it is the shared one: sample at
  // rest, feather in BOX units, discard what the overscan added.
  material.fragmentNode = Fn(() => trimAndSample(u, boxToFrame, vRest))();
  return finishWarp(material, u);
}

/* ── shared fragment-warp plumbing ──────────────────────────────────────────
 * regionDistort and cornerPin are the two warps whose vertex stage does
 * NOTHING but place the overscanned quad: the deformation is solved per
 * fragment, by inverting a map from screen back to source. So both share the
 * same rest attribute, the same pass-through vertex node, and the same trim,
 * and differ only in how they compute `src`.
 */
function restQuad() {
  const aRest = attribute('aRest', 'vec2');
  return { aRest, vRest: varying(aRest, 'vRest') };
}

/** The trim both fragment warps end with: fwidth feather in BOX units, then sample. */
/*
 * Frame uv -> clip space, with the y NEGATED.
 *
 * All five warps write clip space by hand from vertex DATA (`aRest`), which
 * bypasses three's coordinate compensation along with the camera — the same
 * shape as repetile and the rig warp. None of them negated y, and the LAB PAIRS
 * COULD NOT SEE IT: a lab chooses its own targets and pass order, so it only
 * ever confirmed that the arrangement it built was self-consistent. The app's
 * chain is what ships, and there bend was off by mean Δ 14.7 on 63,864 pixels.
 *
 * Every warp already sets DoubleSide (a fold past 180° flips winding on its
 * own), so the reversed winding this introduces needs no extra handling.
 */
const clipFromFrame = (f) => vec4(f.x.mul(2.0).sub(1.0), float(1.0).sub(f.y.mul(2.0)), 0.0, 1.0);

function trimAndSample(u, boxToFrame, src) {
  const w = fwidth(src).add(1e-5);
  const m = smoothstep(vec2(0.0), w, src)
    .mul(vec2(1.0).sub(smoothstep(vec2(1.0).sub(w), vec2(1.0), src)));
  const mask = m.x.mul(m.y);
  If(mask.lessThanEqual(0.0), () => { Discard(); });
  /*
   * Sample-side V flip, driven by PLATE PROVENANCE through uFlipV. Clip Y is
   * negated for placement, but that only fixes where the warp DRAWS. What it
   * READS depends on who wrote the plate: a camera-rendered isolate (rt.c
   * straight out of the channel camera) is stored on the opposite V axis under
   * WebGPU and must be flipped at the sample point; a quad-written plate
   * (DoF, glow, the overlay chain, an earlier warp) is already in this pass's
   * frame-UV space and must not be. The app sets the uniform per draw; the
   * GLSL twin never needs it (WebGL isolate storage is already upright).
   */
  const sUv = boxToFrame(clamp(src, 0.0, 1.0));
  return u.uTexture.sample(vec2(sUv.x, mix(sUv.y, sUv.y.oneMinus(), u.uFlipV))).mul(mask);
}

/*
 * Region Distort: a monotone density integral, inverted by bisection.
 *
 * The three helpers below take `.setLayout()` because each is a pure function
 * of its parameters — none of them reads a uniform, which is the condition that
 * makes a layout safe (PORTING-GUIDE §2). The arithmetic is transcribed with
 * its ASSOCIATION intact: GLSL's `u * u * u` is `(u*u)*u` and its
 * `0.5 * u * u * u * u` is `(((0.5*u)*u)*u)*u`, and re-associating either would
 * move the last bits (§12). Operand ORDER within one multiply is left as the
 * GLSL has it where it costs nothing, though `w * 0.5` and `0.5 * w` are
 * bit-identical.
 */
const regG = Fn(([t]) => {
  const out = float(0.0).toVar();
  If(t.greaterThan(0.0), () => {
    If(t.greaterThanEqual(1.0), () => {
      out.assign(t.sub(0.5));
    }).Else(() => {
      out.assign(t.mul(t).mul(t).sub(float(0.5).mul(t).mul(t).mul(t).mul(t)));
    });
  });
  return out;
});
regG.setLayout({ name: 'regG', type: 'float', inputs: [{ name: 't', type: 'float' }] });

const regF = Fn(([y, a, b, w, s]) => y.add(
  s.sub(1.0).mul(w).mul(
    regG(y.sub(a.sub(float(0.5).mul(w))).div(w))
      .sub(regG(y.sub(b.sub(float(0.5).mul(w))).div(w))),
  ),
));
regF.setLayout({
  name: 'regF',
  type: 'float',
  inputs: [{ name: 'y', type: 'float' }, { name: 'a', type: 'float' }, { name: 'b', type: 'float' },
    { name: 'w', type: 'float' }, { name: 's', type: 'float' }],
});

const regInv = Fn(([yo, a0, b0, f, s, keep]) => {
  const w = max(f, 0.0025).mul(2.0);
  const a = max(a0, float(0.5).mul(w));
  const b = min(b0, float(1.0).sub(float(0.5).mul(w))).toVar();
  If(b.lessThanEqual(a.add(1e-4)), () => { b.assign(a.add(1e-4)); });
  // The GLSL ternary picks between two values, so evaluating regF on both sides
  // is free of consequence: it is pure, and `w` is bounded away from 0 above.
  const target = select(keep.greaterThan(0.5), yo.mul(regF(float(1.0), a, b, w, s)), yo);
  const lo = float(-2.0).toVar();
  const hi = float(3.0).toVar();
  // 26 bisection steps, the count the GLSL fixes — not a convergence test, so
  // the loop is a plain Loop() and lands on exactly the same interval.
  Loop(26, () => {
    const m = lo.add(hi).mul(0.5);
    If(regF(m, a, b, w, s).lessThan(target), () => { lo.assign(m); }).Else(() => { hi.assign(m); });
  });
  return lo.add(hi).mul(0.5);
});
regInv.setLayout({
  name: 'regInv',
  type: 'float',
  inputs: [{ name: 'yo', type: 'float' }, { name: 'a0', type: 'float' }, { name: 'b0', type: 'float' },
    { name: 'f', type: 'float' }, { name: 's', type: 'float' }, { name: 'keep', type: 'float' }],
});

export function createRegionDistortNodeMaterial() {
  const u = {
    uTexture: makeSampler(),
    // 1 while the bound plate is the camera-rendered isolate (rt.c fresh from
    // the channel camera); 0 for any quad-written plate. Set per draw.
    uFlipV: uniform(0),
    uOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uAxisX: uniform(new THREE.Vector2(0.5, 0)),
    uAxisY: uniform(new THREE.Vector2(0, 0.5)),
    uP0: uniform(new THREE.Vector2(0.08, 0.05)),
    uP1: uniform(new THREE.Vector2(0.92, 0.33)),
    uSX: uniform(1),
    uSY: uniform(1.55),
    uFeather: uniform(0.03),
    // The GLSL declares `uniform int uKeep` and tests `== 1`; a float uniform
    // tested against 0.5 is the same predicate for the only two values the
    // writer ever sends (`p.dsKeepSize ? 1 : 0`), and keeps the facade a plain
    // number so applyRegionDistortUniforms drives it unchanged.
    uKeep: uniform(0),
  };
  const boxToFrame = boxToFrameOf(u);
  const { aRest, vRest } = restQuad();

  const material = new THREE.MeshBasicNodeMaterial();
  material.vertexNode = clipFromFrame(boxToFrame(aRest));
  material.fragmentNode = Fn(() => {
    const src = vec2(
      regInv(vRest.x, u.uP0.x, u.uP1.x, u.uFeather, u.uSX, u.uKeep),
      regInv(vRest.y, u.uP0.y, u.uP1.y, u.uFeather, u.uSY, u.uKeep),
    );
    return trimAndSample(u, boxToFrame, src);
  })();
  return finishWarp(material, u);
}

/*
 * Corner Pin: the closed-form unit-square → quad homography, inverted.
 *
 * Its antialiasing deliberately does NOT use fwidth: the footprint is measured
 * by evaluating the map at a one-pixel step in each direction, because fwidth
 * would take the derivative across the OVERSCANNED quad rather than across the
 * source. That is a semantic choice in the original (it keeps an untilted pin's
 * outermost row at full strength and identity corners a bit-exact bypass), so
 * the port keeps the two extra evaluations rather than "simplifying" to fwidth.
 */
const cpMap = Fn(([r0, r1, r2, q]) => {
  const hq = vec3(q, 1.0);
  const w = dot(r2, hq);
  return vec2(dot(r0, hq), dot(r1, hq)).div(select(abs(w).lessThan(1e-6), float(1e-6), w));
});
cpMap.setLayout({
  name: 'cpMap',
  type: 'vec2',
  inputs: [{ name: 'r0', type: 'vec3' }, { name: 'r1', type: 'vec3' },
    { name: 'r2', type: 'vec3' }, { name: 'q', type: 'vec2' }],
});

export function createCornerPinNodeMaterial() {
  const u = {
    uTexture: makeSampler(),
    // 1 while the bound plate is the camera-rendered isolate (rt.c fresh from
    // the channel camera); 0 for any quad-written plate. Set per draw.
    uFlipV: uniform(0),
    uOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uAxisX: uniform(new THREE.Vector2(0.5, 0)),
    uAxisY: uniform(new THREE.Vector2(0, 0.5)),
    uBoxPx: uniform(new THREE.Vector2(1920, 1080)),
    uP0: uniform(new THREE.Vector2(0.12, 0.06)),
    uP1: uniform(new THREE.Vector2(0.88, 0.06)),
    uP2: uniform(new THREE.Vector2(1, 0.94)),
    uP3: uniform(new THREE.Vector2(0, 0.94)),
  };
  const boxToFrame = boxToFrameOf(u);
  const { aRest, vRest } = restQuad();

  const material = new THREE.MeshBasicNodeMaterial();
  material.vertexNode = clipFromFrame(boxToFrame(aRest));
  material.fragmentNode = Fn(() => {
    const dx1 = u.uP1.x.sub(u.uP2.x);
    const dx2 = u.uP3.x.sub(u.uP2.x);
    const dx3 = u.uP0.x.sub(u.uP1.x).add(u.uP2.x).sub(u.uP3.x);
    const dy1 = u.uP1.y.sub(u.uP2.y);
    const dy2 = u.uP3.y.sub(u.uP2.y);
    const dy3 = u.uP0.y.sub(u.uP1.y).add(u.uP2.y).sub(u.uP3.y);
    const den = dx1.mul(dy2).sub(dy1.mul(dx2));
    If(abs(den).lessThan(1e-9), () => { Discard(); });   // three corners collinear
    const g = dx3.mul(dy2).sub(dy3.mul(dx2)).div(den);
    const h = dx1.mul(dy3).sub(dy1.mul(dx3)).div(den);
    const cA = vec3(u.uP1.x.sub(u.uP0.x).add(g.mul(u.uP1.x)), u.uP1.y.sub(u.uP0.y).add(g.mul(u.uP1.y)), g);
    const cB = vec3(u.uP3.x.sub(u.uP0.x).add(h.mul(u.uP3.x)), u.uP3.y.sub(u.uP0.y).add(h.mul(u.uP3.y)), h);
    const cC = vec3(u.uP0.x, u.uP0.y, 1.0);
    // Rows of the inverse as cross products of the forward columns — the GLSL
    // avoids transpose() (absent in GLSL ES 1.00) and builds no matrix; there is
    // nothing to gain by introducing one here, and a mat3 would change the
    // arithmetic order.
    const r0 = cross(cB, cC).toVar();
    const r1 = cross(cC, cA).toVar();
    const r2 = cross(cA, cB).toVar();
    const det = dot(cA, r0);
    If(abs(det).lessThan(1e-9), () => { Discard(); });
    r0.divAssign(det); r1.divAssign(det); r2.divAssign(det);

    const hq = vec3(vRest, 1.0);
    const w = dot(r2, hq);
    If(w.lessThanEqual(1e-6), () => { Discard(); });     // past the projective horizon
    const src = vec2(dot(r0, hq), dot(r1, hq)).div(w);

    const stepPx = vec2(1.0).div(max(u.uBoxPx, vec2(1.0)));
    const fw = abs(cpMap(r0, r1, r2, vRest.add(vec2(stepPx.x, 0.0))).sub(src))
      .add(abs(cpMap(r0, r1, r2, vRest.add(vec2(0.0, stepPx.y))).sub(src))).add(1e-6);
    const hw = fw.mul(0.5);
    // The ramp STRADDLES the boundary (-hw..hw), it does not sit inside it.
    const m = smoothstep(hw.negate(), hw, src)
      .mul(vec2(1.0).sub(smoothstep(vec2(1.0).sub(hw), vec2(1.0).add(hw), src)));
    const mask = m.x.mul(m.y);
    If(mask.lessThanEqual(0.0), () => { Discard(); });
    // Same provenance-driven sample flip as trimAndSample.
    const sUv = boxToFrame(clamp(src, 0.0, 1.0));
    return u.uTexture.sample(vec2(sUv.x, mix(sUv.y, sUv.y.oneMinus(), u.uFlipV))).mul(mask);
  })();
  return finishWarp(material, u);
}

/*
 * Bezier Warp: a Coons patch over a 12-point ring.
 *
 * Two things make this the odd one out among the warps, and both are structural
 * rather than arithmetic:
 *
 *   ONE uniform block, TWO materials. A patch pushed past itself folds, and the
 *   folded part is inside out. Drawn as a single DoubleSide mesh the overlap is
 *   settled by index order alone, which made the same gesture read differently
 *   at opposite ends of the shape — so the app splits the draw by facing and
 *   orders the two meshes explicitly (`setFoldOnTop`). The port keeps that
 *   split: it returns a FrontSide and a BackSide material that SHARE the uniform
 *   facade, so `applyBezierWarpUniforms` writing `pass.material.uniforms` drives
 *   both. This is also why these two never take the transparent+DoubleSide
 *   two-pass path that bend needed `forceSinglePass` for (§13): neither is
 *   DoubleSide, because the app already made the ordering explicit.
 *
 *   `uPts` is an ARRAY uniform. A UniformArrayNode keeps its data on `.array`
 *   and uses `.value` for the packed upload buffer, so the facade hands the app
 *   a separate accessor whose `.value` IS `.array` — the same treatment the clip
 *   material's shadow banks get, and for the same reason: the writer does
 *   `bank[i].set(...)` in place.
 */
const bez = Fn(([a, b, c, d, t]) => {
  const m = float(1.0).sub(t);
  // Association as the GLSL has it: ((m*m)*m)*a + (((3*m)*m)*t)*b + …, summed
  // left to right. Re-associating a Bernstein sum moves the last bits (§12).
  return m.mul(m).mul(m).mul(a)
    .add(float(3.0).mul(m).mul(m).mul(t).mul(b))
    .add(float(3.0).mul(m).mul(t).mul(t).mul(c))
    .add(t.mul(t).mul(t).mul(d));
});
bez.setLayout({
  name: 'bez',
  type: 'vec2',
  inputs: [{ name: 'a', type: 'vec2' }, { name: 'b', type: 'vec2' }, { name: 'c', type: 'vec2' },
    { name: 'd', type: 'vec2' }, { name: 't', type: 'float' }],
});

/** Front and back share one uniform facade, so one write drives both passes. */
export function createBezierWarpNodeMaterials() {
  const T3 = 100 / 3;
  const ring = [
    [0, 0], [T3, 0], [T3 * 2, 0], [100, 0],
    [100, T3], [100, T3 * 2], [100, 100], [T3 * 2, 100],
    [T3, 100], [0, 100], [0, T3 * 2], [0, T3],
  ].map(([x, y]) => new THREE.Vector2(x / 100, y / 100));
  const uPtsNode = uniformArray(ring, 'vec2');

  const u = {
    uTexture: makeSampler(),
    // 1 while the bound plate is the camera-rendered isolate (rt.c fresh from
    // the channel camera); 0 for any quad-written plate. Set per draw.
    uFlipV: uniform(0),
    uOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uAxisX: uniform(new THREE.Vector2(0.5, 0)),
    uAxisY: uniform(new THREE.Vector2(0, 0.5)),
    // Redirecting `.value` onto the node itself would have the packer write into
    // its own source and upload nothing (PORTING-GUIDE §7).
    uPts: {
      node: uPtsNode,
      get value() { return uPtsNode.array; },
      set value(next) { uPtsNode.array = next; },
    },
  };
  const boxToFrame = boxToFrameOf(u);
  const { aRest, vRest } = restQuad();
  const P = (i) => uPtsNode.element(i);

  // Reads uniforms, so NO layout — a laid-out helper that closes over a uniform
  // emits a stale uniform index (§2/§7b).
  const wBezier = (b) => {
    const UL = P(0); const t1 = P(1); const t2 = P(2); const UR = P(3);
    const r1 = P(4); const r2 = P(5); const LR = P(6); const b1 = P(7);
    const b2 = P(8); const LL = P(9); const l1 = P(10); const l2 = P(11);
    const uu = b.x;
    const vv = b.y;
    const top = bez(UL, t1, t2, UR, uu);
    const bot = bez(LL, b2, b1, LR, uu);
    const lft = bez(UL, l2, l1, LL, vv);
    const rgt = bez(UR, r1, r2, LR, vv);
    // The two ruled surfaces minus the bilinear corner patch.
    const ruled = mix(top, bot, vv).add(mix(lft, rgt, uu));
    const corner = mix(mix(UL, UR, uu), mix(LL, LR, uu), vv);
    return ruled.sub(corner);
  };

  // Built once and shared by both materials, so the two facings cannot drift
  // apart arithmetically — they differ in `side` and nothing else.
  const vertexNode = Fn(() => clipFromFrame(boxToFrame(wBezier(aRest))))();
  const fragmentNode = Fn(() => trimAndSample(u, boxToFrame, vRest))();

  const mk = (side) => {
    const m = new THREE.MeshBasicNodeMaterial();
    m.vertexNode = vertexNode;
    m.fragmentNode = fragmentNode;
    return finishWarp(m, u, side);
  };
  return { material: mk(THREE.FrontSide), backMaterial: mk(THREE.BackSide) };
}

/*
 * Mesh Warp: a Catmull-Rom bicubic over a cols x rows lattice.
 *
 * Two things here that no earlier warp needed:
 *
 *   DYNAMIC indexing of a uniform array. `latPt(i, j)` clamps a pair of ints and
 *   reads `uPts[j * uCols + i]`, so the index is computed in the shader rather
 *   than fixed at build time — `uniformArray().element()` takes a node index, so
 *   this ports directly, but it is why `latPt` must NOT be laid out: it reads
 *   uCols/uRows/uPts, and a layout on a helper that closes over a uniform emits a
 *   stale uniform index (§2/§7b).
 *
 *   INTEGER uniforms in arithmetic. uCols/uRows drive both the index and the
 *   cell size, so they stay ints and convert explicitly where the GLSL does.
 *
 * The bank is MW_MAX² = 25 slots whatever the live lattice is, exactly as the
 * GLSL declares it — a fixed array length, with the tail holding rest positions.
 * Like bezier, it draws front and back as two meshes and shares one uniform
 * facade (it imports the very same `setFoldOnTop`).
 */
const MW_SLOT_COUNT = 25;

const cr = Fn(([p0, p1, p2, p3, t]) => {
  const t2 = t.mul(t);
  const t3 = t2.mul(t);
  // Association as written: 0.5 * (((2p1 + (-p0+p2)t) + C t²) + D t³).
  const C = float(2.0).mul(p0).sub(float(5.0).mul(p1)).add(float(4.0).mul(p2)).sub(p3);
  const D = p0.negate().add(float(3.0).mul(p1)).sub(float(3.0).mul(p2)).add(p3);
  return float(2.0).mul(p1)
    .add(p0.negate().add(p2).mul(t))
    .add(C.mul(t2))
    .add(D.mul(t3))
    .mul(0.5);
});
cr.setLayout({
  name: 'crSpline',
  type: 'vec2',
  inputs: [{ name: 'p0', type: 'vec2' }, { name: 'p1', type: 'vec2' }, { name: 'p2', type: 'vec2' },
    { name: 'p3', type: 'vec2' }, { name: 't', type: 'float' }],
});

/** Front and back share one uniform facade, so one write drives both passes. */
export function createMeshWarpNodeMaterials() {
  const bank = Array.from({ length: MW_SLOT_COUNT }, () => new THREE.Vector2(0, 0));
  const uPtsNode = uniformArray(bank, 'vec2');
  const uCols = uniform(4, 'int');
  const uRows = uniform(4, 'int');

  const u = {
    uTexture: makeSampler(),
    // 1 while the bound plate is the camera-rendered isolate (rt.c fresh from
    // the channel camera); 0 for any quad-written plate. Set per draw.
    uFlipV: uniform(0),
    uOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uAxisX: uniform(new THREE.Vector2(0.5, 0)),
    uAxisY: uniform(new THREE.Vector2(0, 0.5)),
    uCols,
    uRows,
    uPts: {
      node: uPtsNode,
      get value() { return uPtsNode.array; },
      set value(next) { uPtsNode.array = next; },
    },
  };
  const boxToFrame = boxToFrameOf(u);
  const { aRest, vRest } = restQuad();

  // Reads uniforms — no layout. The GLSL's nested ternaries are a clamp.
  const latPt = (i, j) => {
    const ci = max(min(i, uCols.sub(1)), int(0));
    const cj = max(min(j, uRows.sub(1)), int(0));
    return uPtsNode.element(cj.mul(uCols).add(ci));
  };

  const wMesh = (b) => {
    const fx = b.x.mul(float(uCols.sub(1)));
    const fy = b.y.mul(float(uRows.sub(1)));
    const ix = max(min(int(floor(fx)), uCols.sub(2)), int(0)).toVar();
    const iy = max(min(int(floor(fy)), uRows.sub(2)), int(0)).toVar();
    const tx = clamp(fx.sub(float(ix)), 0.0, 1.0);
    const ty = clamp(fy.sub(float(iy)), 0.0, 1.0);
    const row = (dj) => cr(
      latPt(ix.sub(1), iy.add(dj)), latPt(ix, iy.add(dj)),
      latPt(ix.add(1), iy.add(dj)), latPt(ix.add(2), iy.add(dj)), tx,
    );
    return cr(row(-1), row(0), row(1), row(2), ty);
  };

  const vertexNode = Fn(() => clipFromFrame(boxToFrame(wMesh(aRest))))();
  const fragmentNode = Fn(() => trimAndSample(u, boxToFrame, vRest))();

  const mk = (side) => {
    const m = new THREE.MeshBasicNodeMaterial();
    m.vertexNode = vertexNode;
    m.fragmentNode = fragmentNode;
    return finishWarp(m, u, side);
  };
  // clipFromFrame() reverses winding for WebGPU. Keep the pass's semantic
  // "front then back" draw order by swapping the cull sides; without this,
  // self-intersecting lattices composite the opposite fold on top.
  return { material: mk(THREE.BackSide), backMaterial: mk(THREE.FrontSide) };
}

/*
 * Droste: the Escher / Print Gallery map — the recursion is a `mod` in log-polar
 * space, so every level exists at once in one fragment.
 *
 * Structurally this is the third FRAGMENT warp (region and corner pin are the
 * others): the vertex stage only places the quad, and the whole map is solved per
 * fragment. Two things here that neither of those needed:
 *
 *   NO OVERSCAN AND NO TRIM. The fold resolves every point inside the box, and a
 *   Droste resamples the layer rather than displacing it, so the quad is exactly
 *   [0,1]² and there is nothing outside it to feather away. It therefore does NOT
 *   use `trimAndSample` — its own `fetchBox` carries the edge modes instead, in BOX
 *   units, for the usual reason (the isolate is frame sized).
 *
 *   AN ADAPTIVE TAP LOOP. The centre of a Droste is infinitely fine, and the
 *   jacobian |A|·rho'/rho IS the fragment's footprint in source pixels (source and
 *   output share one pixel grid), so the tap count follows it and the last few
 *   pixels — where no budget wins — fade out. Same constant-bound + guarded Break
 *   shape the GLSL uses, and the same golden-angle offsets, so the two produce the
 *   same taps rather than merely the same number of them.
 */
export function createDrosteNodeMaterial() {
  const uMirror = uniform(0, 'int');
  const uEdge = uniform(0, 'int');
  const uMaxTaps = uniform(4, 'int');
  const u = {
    uTexture: makeSampler(),
    // 1 while the bound plate is the camera-rendered isolate (rt.c fresh from
    // the channel camera); 0 for any quad-written plate. Set per draw.
    uFlipV: uniform(0),
    uOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uAxisX: uniform(new THREE.Vector2(0.5, 0)),
    uAxisY: uniform(new THREE.Vector2(0, 0.5)),
    uBoxPx: uniform(new THREE.Vector2(1920, 1080)),
    uCentre: uniform(new THREE.Vector2(0.5, 0.5)),
    uR1: uniform(0.32),
    uR2: uniform(1),
    uK: uniform(16),
    uAx: uniform(1),
    uAy: uniform(1),
    uTwist: uniform(0),
    uSpin: uniform(0),
    uLevel: uniform(0),
    uFade: uniform(0),
    uTintAmount: uniform(0),
    uDepthLimit: uniform(0),
    uVoidOpacity: uniform(0),
    uDetail: uniform(0),
    uAmount: uniform(1),
    uTint: uniform(new THREE.Vector3(0, 0, 0)),
    uVoid: uniform(new THREE.Vector3(0, 0, 0)),
    uMirror,
    uEdge,
    uMaxTaps,
  };
  const boxToFrame = boxToFrameOf(u);
  const { aRest, vRest } = restQuad();

  const TAU_C = 6.28318530718;
  const GOLDEN = 2.39996322973;

  // Reads uniforms, so NO layout (§2/§7b). `select` evaluates both arms; both are
  // finite for every reachable input, so the branchless form is exact here.
  const shapeNorm = (d) => {
    const a = abs(vec2(d.x.div(u.uAx), d.y.div(u.uAy)));
    const soft = pow(pow(a.x, u.uK).add(pow(a.y, u.uK)), float(1.0).div(u.uK));
    return select(u.uK.greaterThanEqual(13.0), max(a.x, a.y), soft);
  };

  const fetchBox = (b) => {
    const s = vec2(b).toVar();
    const m = mod(s, 2.0);
    const picked = select(uEdge.equal(int(2)), fract(s),
      select(uEdge.equal(int(3)), min(m, vec2(2.0).sub(m)), clamp(s, 0.0, 1.0)));
    // Edge 0 (transparent) is a GATE, not a wrap: the GLSL returns before it
    // samples, and multiplying the clamped sample by 0 is the same result.
    const inside = step(float(0.0), s.x).mul(step(float(0.0), s.y))
      .mul(step(s.x, float(1.0))).mul(step(s.y, float(1.0)));
    const gate = select(uEdge.equal(int(0)), inside, float(1.0));
    const sUv = boxToFrame(picked);
    // Same provenance-driven sample flip as trimAndSample.
    return u.uTexture.sample(vec2(sUv.x, mix(sUv.y, sUv.y.oneMinus(), u.uFlipV))).mul(gate);
  };

  /* One Droste sample. Returns the colour with the jacobian and the depth beside
     it — the GLSL writes those through `out` params, which TSL has no equivalent
     of, so the helper hands back an object and the caller pins what it needs. */
  const drosteSample = (b) => {
    const q = b.sub(u.uCentre).mul(2.0);
    const rho = max(shapeNorm(q), 1e-7).toVar();
    const th = atan(q.y, q.x);

    const LN1 = log(u.uR1);
    const LN2 = log(u.uR2);
    const L = max(LN2.sub(LN1), 1e-4).toVar();

    const uu = log(rho);
    const v = th;

    // A = 1 - i*c. The second line is what keeps the map CONFORMAL — drop it and
    // this is a shear, which squashes the artwork instead of rotating it.
    const c = u.uTwist.mul(L).div(TAU_C).toVar();
    const up = uu.add(c.mul(v)).add(u.uLevel.mul(L)).toVar();
    const vp = v.sub(c.mul(uu)).add(u.uSpin);

    // Fold the scale axis into a single period. This one line IS the recursion.
    const lu = up.sub(LN1).div(L).toVar();
    const fl = floor(lu).toVar();
    const fr = lu.sub(fl).toVar();
    If(uMirror.equal(int(1)).and(mod(fl, 2.0).greaterThan(0.5)), () => {
      fr.assign(float(1.0).sub(fr));
    });

    const rp = exp(LN1.add(fr.mul(L))).toVar();
    const dir = vec2(cos(vp), sin(vp));
    const qp = dir.mul(rp.div(max(shapeNorm(dir), 1e-7)));
    return {
      col: fetchBox(u.uCentre.add(qp.mul(0.5))),
      jac: sqrt(float(1.0).add(c.mul(c))).mul(rp).div(rho),
      dep: max(float(0.0), LN2.sub(uu).div(L)),
      // Which copy of the stack this is. Carries uLevel, so it moves WITH the
      // stack — see the GLSL for why both ends of that stack have to be bounded.
      depCut: float(1.0).sub(lu),
      rho,
      L,
    };
  };

  const material = new THREE.MeshBasicNodeMaterial();
  material.vertexNode = clipFromFrame(boxToFrame(aRest));
  material.fragmentNode = Fn(() => {
    const b = vec2(vRest).toVar();
    const px = vec2(1.0).div(max(u.uBoxPx, vec2(1.0)));

    const first = drosteSample(b);
    const acc = vec4(first.col).toVar();
    const jac = float(first.jac).toVar();
    const dep = float(first.dep).toVar();
    const rho = float(first.rho).toVar();
    const lvl = float(first.L).toVar();
    const depCut = float(first.depCut).toVar();

    const taps = int(1).toVar();
    If(uMaxTaps.greaterThan(int(1)), () => {
      taps.assign(int(clamp(ceil(jac.mul(1.5)), float(1.0), float(uMaxTaps))));
    });
    If(taps.greaterThan(int(1)), () => {
      const n = float(taps).toVar();
      Loop({ start: int(1), end: int(16), type: 'int' }, ({ i }) => {
        If(i.greaterThanEqual(taps), () => { Break(); });
        const fi = float(i).add(0.5);
        const rr = sqrt(fi.div(n)).mul(0.5);
        const aa = fi.mul(GOLDEN);
        acc.addAssign(drosteSample(b.add(vec2(cos(aa), sin(aa)).mul(rr).mul(px))).col);
      });
      acc.assign(acc.div(n));
    });

    const cut = float(3.0).mul(float(uMaxTaps)).mul(pow(float(2.0), u.uDetail)).toVar();
    const keep = float(1.0).sub(smoothstep(cut, cut.mul(3.0), jac)).toVar();
    // A finite copy count cuts ON the level boundary, feathered by ONE PIXEL —
    // see the GLSL for why the feather is analytic rather than a fixed fraction
    // of a level.
    // A FINITE STACK: both ends bounded, because the fold will manufacture a
    // copy at any depth in either direction. See the GLSL for the full reasoning.
    If(u.uDepthLimit.greaterThan(0.5), () => {
      const fw = float(2.0).div(max(lvl.mul(rho).mul(min(u.uBoxPx.x, u.uBoxPx.y)), 1e-3));
      keep.mulAssign(float(1.0).sub(smoothstep(u.uDepthLimit.sub(fw), u.uDepthLimit.add(fw), depCut)));
      keep.mulAssign(smoothstep(u.uDepthLimit.negate().sub(fw), u.uDepthLimit.negate().add(fw), depCut));
    });

    // Depth shading, on the premultiplied isolate.
    If(u.uTintAmount.greaterThan(0.0), () => {
      const k = clamp(u.uTintAmount.mul(float(1.0).sub(exp(dep.mul(-0.65)))), 0.0, 1.0);
      acc.rgb.assign(mix(acc.rgb, u.uTint.mul(acc.a), k));
    });
    If(u.uFade.greaterThan(0.0), () => {
      acc.rgb.mulAssign(pow(max(float(1.0).sub(u.uFade), 0.0), dep));
    });
    const shaded = mix(vec4(u.uVoid.mul(u.uVoidOpacity), u.uVoidOpacity), acc, keep);
    return select(u.uAmount.greaterThanEqual(0.999), shaded, mix(fetchBox(b), shaded, u.uAmount));
  })();
  return finishWarp(material, u);
}

/*
 * Pryzm — the TSL twin of pryzmLayer.js.
 *
 * Everything structural about the GLSL survives: box-uv `b`, the same
 * tessellations, the same profiles, the same slab shift. Four things had to be
 * said differently, and they are the four this file keeps warning about:
 *
 *   NO `out` PARAMS. `cell()` writes four values through them in GLSL; here it
 *   hands back an object and the caller pins what it needs, the same way
 *   drosteSample does above.
 *
 *   `glassH` READS UNIFORMS, so no `.setLayout()` — it is a plain arrow and is
 *   inlined at each of its five call sites (the value plus four central
 *   differences). That is a large graph, and it is the honest cost of a
 *   numerical gradient; the alternative is five analytic normals that can each
 *   be wrong on their own.
 *
 *   THE LATTICE IS A `select` CHAIN, NOT `If`. `cell` returns four values that
 *   the caller needs as expressions, and every branch is finite for every
 *   reachable input, so the branchless form is exact and composes.
 *
 *   GRAIN USES `screenCoordinate`, NEVER `uv()`. This pass draws a box into a
 *   frame-sized target, so uv() is not the fragment's raster position and would
 *   mirror the pattern; screenCoordinate is gl_FragCoord's twin.
 */
export function createPryzmNodeMaterial() {
  const uLat = uniform(0, 'int');
  const uProfile = uniform(0, 'int');
  const uWarpSrc = uniform(2, 'int');
  const uWarpAxis = uniform(1, 'int');
  const uSpectrum = uniform(1, 'int');
  const uTaps = uniform(21, 'int');
  const uEdge = uniform(3, 'int');
  const u = {
    uTexture: makeSampler(),
    // 1 while the bound plate is the camera-rendered isolate (rt.c fresh from
    // the channel camera); 0 for any quad-written plate. Set per draw.
    uFlipV: uniform(0),
    uOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uAxisX: uniform(new THREE.Vector2(0.5, 0)),
    uAxisY: uniform(new THREE.Vector2(0, 0.5)),
    uBoxPx: uniform(new THREE.Vector2(1920, 1080)),
    uAspect: uniform(1),
    uLatOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uCell: uniform(0.16),
    uStretch: uniform(0.44),
    uRot: uniform(0),
    uWarpAmt: uniform(0.95),
    uWarpScale: uniform(1.4),
    uRelief: uniform(0.01),
    uBevel: uniform(0.25),
    uTilt: uniform(0.8),
    uGroove: uniform(0),
    uIor: uniform(2.06),
    uThick: uniform(0.28),
    uDisp: uniform(0.525),
    uMagnify: uniform(1),
    uFrost: uniform(0.105),
    uLightDir: uniform(new THREE.Vector3(0, 0, 1)),
    uHighlight: uniform(new THREE.Vector3(1, 1, 1)),
    uTint: uniform(new THREE.Vector3(1, 1, 1)),
    uSpec: uniform(0.26),
    uGloss: uniform(32),
    uSheen: uniform(0.21),
    uSheenFall: uniform(4.3),
    uTintAmt: uniform(0.7),
    uAbsorb: uniform(0),
    uSeam: uniform(0.24),
    uSeamW: uniform(0.005),
    uBloom: uniform(0.1),
    uGrain: uniform(0.04),
    uExposure: uniform(0.04),
    uAmount: uniform(1),
    uTime: uniform(0),
    uMaxLod: uniform(8),
    uDriftT: uniform(0),
    uFlowT: uniform(0),
    uLat,
    uProfile,
    uWarpSrc,
    uWarpAxis,
    uSpectrum,
    uTaps,
    uEdge,
  };
  const boxToFrame = boxToFrameOf(u);
  const { aRest, vRest } = restQuad();

  const TAU_C = 6.28318530718;

  const lum = (c) => dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Pure maths on their arguments — these are the only helpers here that COULD
  // take a layout. Left inline for symmetry with the rest of the file.
  const hash11 = (n) => fract(sin(float(n).mul(127.1)).mul(43758.5453123));
  const hash21 = (p) => {
    const q = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
    q.addAssign(dot(q, q.yzx.add(33.33)));
    return fract(q.x.add(q.y).mul(q.z));
  };
  const vnoise = (p) => {
    const i = floor(p).toVar();
    const f = fract(p).toVar();
    const w = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
    return mix(
      mix(hash21(i), hash21(i.add(vec2(1.0, 0.0))), w.x),
      mix(hash21(i.add(vec2(0.0, 1.0))), hash21(i.add(vec2(1.0, 1.0))), w.x),
      w.y,
    );
  };
  const fbm = (p0) => {
    const p = vec2(p0).toVar();
    const acc = float(0.0).toVar();
    const a = float(0.5).toVar();
    Loop({ start: int(0), end: int(4), type: 'int' }, () => {
      acc.addAssign(a.mul(vnoise(p)));
      p.assign(p.mul(2.03).add(7.1));
      a.mulAssign(0.5);
    });
    return acc;
  };

  /* The plate behind the glass. Edge handling in BOX units — identical
     semantics to fetchBox in every other warp, transparent included: edge 0 is
     a GATE, and multiplying the clamped sample by 0 is the same result as the
     GLSL's early return. */
  const fetchBox = (b, lod) => {
    const s = vec2(b).toVar();
    const m = mod(s, 2.0);
    const picked = select(uEdge.equal(int(2)), fract(s),
      select(uEdge.equal(int(3)), min(m, vec2(2.0).sub(m)), clamp(s, 0.0, 1.0)));
    const inside = step(float(0.0), s.x).mul(step(float(0.0), s.y))
      .mul(step(s.x, float(1.0))).mul(step(s.y, float(1.0)));
    const gate = select(uEdge.equal(int(0)), inside, float(1.0));
    const sUv = boxToFrame(picked);
    /* Same provenance-driven sample flip as trimAndSample, then an EXPLICIT
       level: this pass's offsets jump between cells, so the derivative-based
       level is meaningless. `.level()` is TSL's textureLod. */
    return u.uTexture.sample(vec2(sUv.x, mix(sUv.y, sUv.y.oneMinus(), u.uFlipV))).level(lod).mul(gate);
  };

  const toL = (p) => {
    const q = p.sub(u.uLatOrigin.mul(vec2(u.uAspect, 1.0))).toVar();
    const sn = sin(u.uRot);
    const cs = cos(u.uRot);
    const r = vec2(cs.mul(q.x).sub(sn.mul(q.y)), sn.mul(q.x).add(cs.mul(q.y))).toVar();
    r.assign(r.div(max(u.uCell, 0.0005)));
    return vec2(r.x.div(max(u.uStretch, 0.02)), r.y);
  };
  /* Only the LINEAR part is inverted — the warp is not invertible and does not
     need to be. All this is used for is pointing at the middle of a cell. */
  const fromLDelta = (dq) => {
    const d = vec2(dq.x.mul(max(u.uStretch, 0.02)), dq.y).mul(max(u.uCell, 0.0005)).toVar();
    const sn = sin(u.uRot.negate());
    const cs = cos(u.uRot.negate());
    return vec2(cs.mul(d.x).sub(sn.mul(d.y)), sn.mul(d.x).add(cs.mul(d.y)));
  };

  /* The tessellations. Returns { cc, t, dE, rnd } — the GLSL writes those
     through `out` params, which TSL has no equivalent of. */
  const cell = (q0) => {
    const q = vec2(q0).toVar();

    // flute — ribs
    const fq = vec2(q.x.sub(u.uDriftT), q.y).toVar();
    const fi = floor(fq.x.add(0.5)).toVar();
    const fd = abs(fq.x.sub(fi)).toVar();
    const fluteCc = vec2(fi.add(u.uDriftT), fq.y);
    const fluteT = float(1.0).sub(fd.mul(2.0));
    const fluteE = float(0.5).sub(fd);
    const fluteR = hash11(fi);

    // rings — concentric. Drift rides the RADIUS, so they travel outward.
    const len = length(q).toVar();
    const rr = len.sub(u.uDriftT).toVar();
    const ri = floor(rr.add(0.5)).toVar();
    const rd = abs(rr.sub(ri)).toVar();
    const dir = select(len.greaterThan(1e-5), q.div(max(len, 1e-5)), vec2(1.0, 0.0));
    const ringCc = dir.mul(max(ri.add(u.uDriftT), 0.0));
    const ringT = float(1.0).sub(rd.mul(2.0));
    const ringE = float(0.5).sub(rd);
    const ringR = hash11(ri);

    // rhomb — a grid at 45
    const hq = vec2(q.x.sub(u.uDriftT), q.y).toVar();
    const hr = vec2(hq.x.add(hq.y), hq.y.sub(hq.x)).mul(0.70710678).toVar();
    const hi = floor(hr.add(0.5)).toVar();
    const hf = abs(hr.sub(hi)).toVar();
    const hm = max(hf.x, hf.y).toVar();
    const back = vec2(hi.x.sub(hi.y), hi.x.add(hi.y)).mul(0.70710678);
    const rhombCc = back.add(vec2(u.uDriftT, 0.0));
    const rhombT = float(1.0).sub(hm.mul(2.0));
    const rhombE = float(0.5).sub(hm);
    const rhombR = hash21(hi);

    return {
      cc: select(uLat.equal(int(0)), fluteCc, select(uLat.equal(int(1)), ringCc, rhombCc)),
      t: select(uLat.equal(int(0)), fluteT, select(uLat.equal(int(1)), ringT, rhombT)),
      dE: select(uLat.equal(int(0)), fluteE, select(uLat.equal(int(1)), ringE, rhombE)),
      rnd: select(uLat.equal(int(0)), fluteR, select(uLat.equal(int(1)), ringR, rhombR)),
    };
  };

  /* Cell shape -> height. The whole material vocabulary, as a select chain:
     every arm is finite for t in [0,1], so branchless is exact. */
  const profile = (t0, loc, rnd) => {
    const t = clamp(t0, 0.0, 1.0).toVar();
    const inv = float(1.0).sub(t).toVar();
    const dome = sqrt(max(float(0.0), float(1.0).sub(inv.mul(inv))));
    const round = smoothstep(0.0, 1.0, t);
    const flat = smoothstep(float(0.0), max(u.uBevel, 0.02), t);
    const concave = float(1.0).sub(sqrt(max(float(0.0), float(1.0).sub(t.mul(t)))));
    const sine = float(0.5).sub(cos(t.mul(3.14159265)).mul(0.5));
    const a = rnd.mul(TAU_C);
    const facet = smoothstep(0.0, 0.3, t)
      .mul(clamp(float(0.5).add(dot(vec2(cos(a), sin(a)), loc).mul(u.uTilt).mul(0.5)), 0.0, 1.5));
    return select(uProfile.equal(int(0)), dome,
      select(uProfile.equal(int(1)), round,
        select(uProfile.equal(int(2)), flat,
          select(uProfile.equal(int(3)), t,
            select(uProfile.equal(int(4)), concave,
              select(uProfile.equal(int(5)), sine, facet))))));
  };

  /* The height field. Returns h with the cell data beside it, because magnify
     needs the centre and the seam needs the edge distance. */
  const glassH = (b) => {
    const p = vec2(b.x.mul(u.uAspect), b.y);
    const q = vec2(toL(p)).toVar();

    /*
     * CELL WARP — why SEPARABLE is a mode and not a refinement. Warping q by a
     * field that varies in both axes bends the cell edges: a rib stops being a
     * rib. Straight cells of UNEVEN WIDTH are a one-dimensional remap of each
     * lattice axis, and the lattice origin is at (0,0) in L by construction,
     * which is what makes the axis samples exact under rotation.
     */
    If(u.uWarpAmt.greaterThan(0.0).and(uWarpSrc.greaterThan(int(0))), () => {
      const sepNoise = vec2(
        vnoise(vec2(q.x.mul(u.uWarpScale), u.uFlowT)),
        vnoise(vec2(q.y.mul(u.uWarpScale).add(31.7), u.uFlowT.add(5.0))),
      ).sub(0.5).mul(u.uWarpAmt);
      const freeNoise = vec2(
        fbm(q.mul(u.uWarpScale).add(vec2(0.0, u.uFlowT))),
        fbm(q.mul(u.uWarpScale).add(vec2(5.2, u.uFlowT.add(3.1)))),
      ).sub(0.5).mul(u.uWarpAmt);

      const org = u.uLatOrigin.mul(vec2(u.uAspect, 1.0));
      const ax = fromLDelta(vec2(q.x, 0.0)).add(org);
      const ay = fromLDelta(vec2(0.0, q.y)).add(org);
      // The warp reads a BLURRED plate on purpose — cell edges must not chase noise.
      const lx = lum(fetchBox(vec2(ax.x.div(max(u.uAspect, 1e-4)), ax.y), float(3.0)).rgb);
      const ly = lum(fetchBox(vec2(ay.x.div(max(u.uAspect, 1e-4)), ay.y), float(3.0)).rgb);
      const sepLuma = vec2(lx, ly).sub(0.45).mul(u.uWarpAmt);
      const freeLuma = vec2(lum(fetchBox(b, float(3.0)).rgb).sub(0.45).mul(u.uWarpAmt));

      const noiseArm = select(uWarpAxis.equal(int(1)), sepNoise, freeNoise);
      const lumaArm = select(uWarpAxis.equal(int(1)), sepLuma, freeLuma);
      q.addAssign(select(uWarpSrc.equal(int(1)), noiseArm, lumaArm));
    });

    const c = cell(q);
    const dE = float(c.dE).toVar();
    const h = float(profile(c.t, q.sub(c.cc), c.rnd)).toVar();
    If(u.uGroove.greaterThan(0.0), () => {
      h.mulAssign(smoothstep(u.uGroove.mul(0.35), u.uGroove, dE));
    });
    return { h, dE, ccL: c.cc, qOut: q };
  };

  /* Eye response, roughly. Enough to make a continuum of IORs read as a
     spectrum instead of as three ghosts. */
  const specW = (t) => vec3(
    exp(t.sub(0.10).mul(t.sub(0.10)).mul(-15.0)),
    exp(t.sub(0.50).mul(t.sub(0.50)).mul(-15.0)),
    exp(t.sub(0.90).mul(t.sub(0.90)).mul(-15.0)),
  );

  const material = new THREE.MeshBasicNodeMaterial();
  material.vertexNode = clipFromFrame(boxToFrame(aRest));
  material.fragmentNode = Fn(() => {
    const b = vec2(vRest).toVar();
    const g0 = glassH(b);
    const h = float(g0.h).toVar();
    const dE = float(g0.dE).toVar();

    /*
     * CENTRAL differences, one plate pixel out. A forward difference puts the
     * whole of a rim's near-vertical wall into the pixel on ONE side of it,
     * which stamps the same lopsided wedge into every cell of every lattice.
     */
    const ex = float(1.0).div(max(u.uBoxPx.y, 1.0)).toVar();
    const eu = vec2(ex.div(max(u.uAspect, 1e-4)), 0.0);
    const ev = vec2(0.0, ex);
    const hx1 = glassH(b.add(eu)).h;
    const hx0 = glassH(b.sub(eu)).h;
    const hy1 = glassH(b.add(ev)).h;
    const hy0 = glassH(b.sub(ev)).h;

    // Relief is normalised by cell size, so resizing the cells does not change
    // the material's shape — only how many of it there are.
    const amp = u.uRelief.mul(max(u.uCell, 0.0005)).toVar();
    const N = normalize(vec3(
      hx1.sub(hx0).div(ex.mul(2.0)).mul(amp).negate(),
      hy1.sub(hy0).div(ex.mul(2.0)).mul(amp).negate(),
      1.0,
    )).toVar();

    // Cell magnify — a lens focused on the plate, not a stronger refraction.
    const base = vec2(b).toVar();
    If(u.uMagnify.greaterThan(0.0), () => {
      const dP = fromLDelta(g0.ccL.sub(g0.qOut));
      base.addAssign(vec2(dP.x.div(max(u.uAspect, 1e-4)), dP.y).mul(u.uMagnify));
    });

    const frostLod = clamp(u.uFrost.mul(u.uMaxLod), float(0.0), u.uMaxLod).toVar();
    const col = vec3(0.0).toVar();
    const wsum = vec3(1e-5).toVar();
    const alpha = float(0.0).toVar();
    const asum = float(1e-5).toVar();

    Loop({ start: int(0), end: int(32), type: 'int' }, ({ i }) => {
      If(i.greaterThanEqual(uTaps), () => { Break(); });
      const fi = float(i).toVar();
      const denom = max(float(uTaps).sub(1.0), 1.0);
      const lam = select(uTaps.lessThanEqual(int(1)), float(0.5), fi.div(denom)).toVar();
      const rgb = select(i.equal(int(0)), vec3(1.0, 0.0, 0.0),
        select(i.equal(int(1)), vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0)));
      const w = select(uSpectrum.equal(int(0)), rgb, specW(lam)).toVar();
      const ior = max(float(1.0), u.uIor.add(u.uDisp.mul(lam.sub(0.5))));
      const T = refract(vec3(0.0, 0.0, -1.0), N, float(1.0).div(ior)).toVar();
      /* refract() returns 0 on total internal reflection — a real outcome at
         high IOR on a steep rim. It must go dark, not sample some arbitrary
         direction, so the weight still counts and the colour does not. */
      const ok = step(0.25, dot(T, T)).toVar();
      const off = T.xy.div(max(T.z.negate(), 0.02)).mul(u.uThick).mul(ok).toVar();
      const sPos = base.add(vec2(off.x.div(max(u.uAspect, 1e-4)), off.y));
      /* FROST is the mip level, so every tap reads an AREA AVERAGE — which is
         what keeps a wide dispersion smooth instead of confetti. */
      const tex = fetchBox(sPos, frostLod).toVar();
      col.addAssign(tex.rgb.mul(w).mul(ok));
      wsum.addAssign(w);
      const lw = w.x.add(w.y).add(w.z).toVar();
      alpha.addAssign(tex.w.mul(lw).mul(ok));
      asum.addAssign(lw);
    });
    col.assign(col.div(wsum));
    alpha.assign(alpha.div(asum));

    // Lighting ON the glass, not on the plate.
    const L = normalize(u.uLightDir);
    const Hv = normalize(L.add(vec3(0.0, 0.0, 1.0)));
    const sp = pow(max(dot(N, Hv), 0.0), u.uGloss).mul(u.uSpec);
    const fr = pow(float(1.0).sub(clamp(N.z, 0.0, 1.0)), u.uSheenFall).mul(u.uSheen);

    const outc = vec3(col).toVar();
    If(u.uTintAmt.greaterThan(0.0), () => {
      outc.mulAssign(mix(vec3(1.0), u.uTint, u.uTintAmt));
    });
    If(u.uAbsorb.greaterThan(0.0), () => {
      outc.mulAssign(exp(h.mul(u.uAbsorb).negate()));
    });
    If(u.uSeam.greaterThan(0.0), () => {
      outc.mulAssign(float(1.0).sub(u.uSeam.mul(float(1.0).sub(smoothstep(float(0.0), max(u.uSeamW, 0.0005), dE)))));
    });

    /* The isolate is PREMULTIPLIED, so every additive term is scaled by the
       coverage it is added to — otherwise sheen and specular paint light onto
       pixels the layer does not cover and the glass grows a bounding-box halo. */
    outc.addAssign(u.uHighlight.mul(sp).mul(alpha));
    outc.addAssign(mix(vec3(1.0), u.uHighlight, 0.5).mul(fr).mul(alpha));

    /* Bloom: a high level of the same chain, screen blended. */
    If(u.uBloom.greaterThan(0.0), () => {
      const bl = fetchBox(base, max(u.uMaxLod.sub(1.5), float(0.0))).rgb;
      outc.assign(float(1.0).sub(float(1.0).sub(outc).mul(float(1.0).sub(clamp(bl.mul(u.uBloom), 0.0, 1.0)))));
      outc.mulAssign(alpha);            // stay premultiplied after the screen
    });

    outc.mulAssign(exp2(u.uExposure));
    /* screenCoordinate, NEVER uv(): this pass draws a BOX into a frame-sized
       target, so uv() is not the fragment's raster position. */
    If(u.uGrain.greaterThan(0.0), () => {
      outc.addAssign(hash21(screenCoordinate.xy.add(u.uTime.mul(91.7))).sub(0.5).mul(u.uGrain).mul(alpha));
    });

    const res = vec4(max(outc, vec3(0.0)), alpha);
    return select(u.uAmount.greaterThanEqual(0.999), res, mix(fetchBox(b, float(0.0)), res, u.uAmount));
  })();
  return finishWarp(material, u);
}
