/*
 * TSL twin of particleLayer.js's instanced billboard — matrix row 15.
 *
 * Ported from the verdicted pair 15 (69 states; 58 with zero pixels over the
 * bar, the other 11 differing on 1-24 isolated pixels of 926,886 and traced
 * away from the shader). Both shaders the layer owns are here: VERT (the
 * view-space billboard, size ramp, per-particle twinkle, spin, tumble squash and
 * the right-handed velocity-stretch basis) and FRAG (three procedural sprite
 * SDFs, both 256-texel ramp LUTs, the artwork branch with tint, colour-from-
 * source and colour-from-speed, the three ignition modes, the premultiplied
 * emit and all three discards).
 *
 * PARTICLES ARE THE WORST CASE FOR §13. ShaderMaterial forces
 * forceSinglePass = true and every NodeMaterial inherits Material's false, so a
 * transparent DoubleSide port silently gains the renderer's back-then-front
 * two-pass split. Every particle quad overlaps its neighbours, and the cloud is
 * sorted back-to-front on the CPU each frame — the split would re-order the
 * whole thing against that sort. This is not a subtle few pixels; it is the
 * entire alpha stack drawn in the wrong order.
 *
 * The material's other state is copied from the ShaderMaterial it replaces
 * rather than restated, so the two cannot drift.
 */
import * as THREE from 'three/webgpu';
import {
  uniform, texture, attribute, varying, vec2, vec3, vec4, float,
  mix, clamp, max, abs, mod, floor, length, sin, cos, pow, select,
  Fn, If, Discard, uv, screenCoordinate, screenSize,
  positionGeometry, modelViewMatrix, cameraProjectionMatrix,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';

/** Null-safe binding facade — see tslSampler.js for why null must never
 * reach TextureNode.value, and why the fallback is created once. */
const makeSampler = () => makeTslSampler({ rgba: [0, 0, 0, 0] });

/**
 * `proto` is the ShaderMaterial this replaces — its blend/side/depth state is
 * copied off it so the twin cannot drift from the original.
 */
export function createParticleNodeMaterial(proto) {
  const S = {
    uRamp: makeSampler(),
    uRamp2: makeSampler(),
    uMap: makeSampler(),
    uUseMap: uniform(0),
    uSprite: uniform(0),
    uOpacity: uniform(1),
    uTwinkle: uniform(0),
    uSizeStart: uniform(10),
    uSizeEnd: uniform(10),
    uStretch: uniform(0),
    uScale: uniform(1),
    uAspect: uniform(1),
    uTint: uniform(0),
    uColorFromSource: uniform(0),
    uColorFromSpeed: uniform(0),
    uIgniteMode: uniform(0),
    uIgniteColor: uniform(new THREE.Color('#ffd7a0')),
  };
  // SEED FROM THE PROTO. The app binds several uniforms exactly ONCE, when it
  // constructs the ShaderMaterial — `uRamp` and `uRamp2` are handed in at
  // construction and afterwards only their texture CONTENTS are mutated, never
  // re-assigned. A twin that starts from placeholders therefore never receives
  // them: the ramp sample returns (0,0,0,0), alpha comes out 0, and the whole
  // system renders an empty frame while still reporting a full instance count
  // and a correct vertex placement. Copy every value the proto already holds.
  for (const [k, v] of Object.entries(proto?.uniforms || {})) {
    const slot = S[k];
    if (!slot || v?.value === undefined || v.value === null) continue;
    if (slot.value && typeof slot.value === 'object' && typeof slot.value.copy === 'function'
        && v.value.isColor === slot.value.isColor) {
      slot.value.copy(v.value);          // Color / Vector: keep the node's own instance
    } else {
      slot.value = v.value;              // textures and scalars
    }
  }

  // The lab's binding names, aliased so its bodies below stay verbatim.
  const rampNode = S.uRamp;
  const ramp2Node = S.uRamp2;
  const mapNode = S.uMap;

  const material = new THREE.NodeMaterial();

    // PACKED — five vec4s, matching particleLayer.js's geometry. WebGPU caps a
  // pipeline at 8 VERTEX BUFFERS; the eight loose instanced attributes this used
  // to read, plus position and uv, came to TEN, so CreateRenderPipeline failed
  // and the system drew NOTHING while still reporting its instance count. The
  // lane map lives on the GLSL VERT's attribute block and is mirrored here.
  const iA = attribute('iA', 'vec4');
  const iB = attribute('iB', 'vec4');
  const iC = attribute('iC', 'vec4');
  const iD = attribute('iD', 'vec4');
  const iE = attribute('iE', 'vec4');
  const iPos = iA.xyz;
  const iSpeedT = iA.w;
  const iAgeLife = iB.xy;
  const iJitter = iB.zw;
  const iVel = iC.xyz;
  const iSpin = iD;
  const iColor = iE.xyz;
  const iHold = iC.w;
  const iIgnite = iE.w;

    // ── Varyings — one for one with the GLSL's ─────────────────────────────────
    const lifeT = clamp(iAgeLife.x.div(max(iAgeLife.y, 1e-4)), 0.0, 1.0);
    const vUv = uv();
    const vLifeT = varying(lifeT, 'vLifeT');
    const vSquash = varying(iSpin.y, 'vSquash');
    const vKill = varying(iSpin.w, 'vKill');
    const vColor = varying(iColor, 'vColor');
    const vHold = varying(iHold, 'vHold');
    const vIgnite = varying(iIgnite, 'vIgnite');
    const vSpeedT = varying(iSpeedT, 'vSpeedT');
    // Twinkle is a per-particle sine on its OWN age and phase — mod() here has
    // FLOAT operands, which is the safe half of PORTING-GUIDE §8.
    const vAlphaMul = varying(
      float(1.0).sub(
        S.uTwinkle.mul(0.5).mul(
          float(1.0).add(sin(iJitter.y.add(iAgeLife.x.mul(float(5.0).add(mod(iJitter.y, 7.0)))))),
        ),
      ),
      'vAlphaMul',
    );

    // ── Sprite SDFs — every helper carries a LAYOUT (PORTING-GUIDE §2) ────────
    // Without one, TSL inlines the closure at every call site; `star()` alone is
    // eight pow() chains and each of its arguments is mentioned twice.
    const softDisc = Fn(([p]) => {
      const t = clamp(float(1.0).sub(length(p)), 0.0, 1.0).toVar();
      return t.mul(t).mul(float(0.45).add(float(0.55).mul(t).mul(t)));
    }).setLayout({ name: 'p15SoftDisc', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

    const star = Fn(([p]) => {
      const r = length(p).toVar();
      const core = pow(max(0.0, float(1.0).sub(r)), 5.0).toVar();
      const sx = pow(max(0.0, float(1.0).sub(abs(p.x).mul(7.0))), 1.5)
        .mul(pow(max(0.0, float(1.0).sub(abs(p.y))), 2.5)).toVar();
      const sy = pow(max(0.0, float(1.0).sub(abs(p.y).mul(7.0))), 1.5)
        .mul(pow(max(0.0, float(1.0).sub(abs(p.x))), 2.5)).toVar();
      const d = vec2(p.x.add(p.y), p.x.sub(p.y)).mul(0.7071).toVar();
      const dx = pow(max(0.0, float(1.0).sub(abs(d.x).mul(14.0))), 1.5)
        .mul(pow(max(0.0, float(1.0).sub(abs(d.y).mul(2.2))), 2.5)).toVar();
      const dy = pow(max(0.0, float(1.0).sub(abs(d.y).mul(14.0))), 1.5)
        .mul(pow(max(0.0, float(1.0).sub(abs(d.x).mul(2.2))), 2.5)).toVar();
      return clamp(core.add(sx.add(sy).mul(0.85)).add(dx.add(dy).mul(0.4)), 0.0, 1.0);
    }).setLayout({ name: 'p15Star', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

    const spark = Fn(([p]) => {
      const body = pow(max(0.0, float(1.0).sub(length(vec2(p.x.mul(3.2), p.y)))), 2.0).toVar();
      const head = pow(
        max(0.0, float(1.0).sub(length(vec2(p.x.mul(2.2), p.y.add(0.55).mul(1.6))).mul(2.2))),
        2.0,
      ).toVar();
      return clamp(body.mul(0.75).add(head), 0.0, 1.0);
    }).setLayout({ name: 'p15Spark', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

    // ── The port ──────────────────────────────────────────────────────────────
    //
    // The lab specialized the artwork branch at BUILD time (one material per
    // artwork + blend mode). This port keeps the GLSL's RUNTIME `uUseMap`
    // instead, because the app keeps ONE material and flips that flag per draw —
    // see the branch below.


      material.vertexNode = Fn(() => {
        // A held particle is the artwork: it sits at its start size, and the flare a
        // freshly released one carries is a pure function of its age.
        const size = mix(S.uSizeStart, S.uSizeEnd, select(iHold.greaterThan(0.5), float(0.0), lifeT))
          .mul(iJitter.x).mul(S.uScale).mul(iSpin.z).mul(float(1.0).add(iIgnite))
          .toVar();

        // Billboard: the quad is built in VIEW space, so it faces the camera
        // whatever the layer's own rotation is.
        const mv = modelViewMatrix.mul(vec4(iPos, 1.0)).toVar();
        const quad = positionGeometry.xy.mul(vec2(size.mul(iSpin.y), size.mul(S.uAspect))).toVar();

        If(iSpin.x.notEqual(0.0), () => {
          const cs = cos(iSpin.x).toVar();
          const sn = sin(iSpin.x).toVar();
          quad.assign(vec2(
            quad.x.mul(cs).sub(quad.y.mul(sn)),
            quad.x.mul(sn).add(quad.y.mul(cs)),
          ));
        });

        If(S.uStretch.greaterThan(0.0), () => {
          // Stretch along the velocity as the camera sees it. THE BASIS MUST STAY
          // RIGHT-HANDED — det([side, fwd]) = +1 — or every stretched quad is
          // mirrored, turns back-facing and is silently culled (the app's note).
          const vv = modelViewMatrix.mul(vec4(iPos.add(iVel.mul(S.uStretch)), 1.0)).xyz.sub(mv.xyz).toVar();
          const len = length(vv.xy).toVar();
          If(len.greaterThan(1e-4), () => {
            const fwd = vv.xy.negate().div(len).toVar();
            const side = vec2(fwd.y, fwd.x.negate()).toVar();
            quad.assign(
              side.mul(positionGeometry.x.mul(size))
                .add(fwd.mul(positionGeometry.y.mul(size.add(len)))),
            );
          });
        });

        return cameraProjectionMatrix.mul(vec4(mv.xy.add(quad), mv.z, mv.w));
      })();

      material.fragmentNode = Fn(() => {
        // HELD (Grow Points, 'frozen') reads the HEAD of the ramp at full opacity.
        const c = rampNode.sample(vec2(select(vHold.greaterThan(0.5), float(0.0), vLifeT), 0.5)).toVar();
        const rgb = c.rgb.toVar();
        const a = float(0.0).toVar();

        // RUNTIME branch on uUseMap, matching the GLSL. The lab specialized this
        // at BUILD time because it was already making one material per (artwork,
        // blend mode); the app keeps ONE material and flips `uUseMap` per draw,
        // so a compile-time boolean here would freeze whichever value it had at
        // construction and silently render either sprites or layer objects wrong.
        //
        // Sampling `uMap` inside this branch is legal: `uUseMap` is a UNIFORM, so
        // the control flow is uniform across the draw, which is the condition
        // WGSL actually requires for implicit-LOD sampling — the rule is about
        // non-uniform flow, not about branches as such.
        If(S.uUseMap.greaterThan(0.5), () => {
          // A layer object: the artwork IS the sprite.
          const art = mapNode.sample(vUv).toVar();
          If(art.a.lessThanEqual(0.004), () => { Discard(); });
          rgb.assign(select(S.uTint.greaterThan(0.5), art.rgb.mul(c.rgb), art.rgb));
          // Edge-on cards catch less light; without this a tumble reads as a flicker.
          const edge = float(0.45).add(float(0.55).mul(clamp(vSquash, 0.0, 1.0))).toVar();
          a.assign(art.a.mul(c.a).mul(S.uOpacity).mul(vAlphaMul).mul(vKill).mul(edge));
          If(vHold.greaterThan(0.5), () => {
            a.assign(art.a.mul(S.uOpacity).mul(edge));
          });
        }).Else(() => {
          const p = vUv.sub(0.5).mul(2.0).toVar();
          const shape = float(0.0).toVar();
          If(S.uSprite.equal(1.0), () => {
            shape.assign(star(p));
          }).ElseIf(S.uSprite.equal(2.0), () => {
            shape.assign(spark(p));
          }).Else(() => {
            shape.assign(softDisc(p));
          });
          If(shape.lessThanEqual(0.002), () => { Discard(); });
          // RGB comes from the ramp (age), the emitted pixel, or the velocity
          // gradient. ALPHA stays the life ramp in every case.
          rgb.assign(mix(c.rgb, vColor, S.uColorFromSource));
          rgb.assign(mix(rgb, ramp2Node.sample(vec2(vSpeedT, 0.5)).rgb, S.uColorFromSpeed));
          a.assign(c.a.mul(shape).mul(S.uOpacity).mul(vAlphaMul).mul(vKill));
          If(vHold.greaterThan(0.5), () => {
            a.assign(shape.mul(S.uOpacity));
          });
        });

        // Ignition: the leading edge of the sweep, painted rather than brightened.
        If(vIgnite.greaterThan(0.0001).and(vHold.lessThan(0.5)), () => {
          If(S.uIgniteMode.greaterThan(1.5), () => {
            const ig = ramp2Node.sample(vec2(clamp(float(1.0).sub(vIgnite), 0.0, 1.0), 0.5)).toVar();
            rgb.assign(mix(rgb, ig.rgb, clamp(vIgnite.mul(ig.a), 0.0, 1.0)));
          }).ElseIf(S.uIgniteMode.greaterThan(0.5), () => {
            rgb.assign(mix(rgb, S.uIgniteColor, clamp(vIgnite, 0.0, 1.0)));
          });
          a.assign(clamp(a.add(vIgnite.mul(0.55)), 0.0, 1.0));
        });

        a.assign(clamp(a, 0.0, 1.0));
        If(a.lessThanEqual(0.002), () => { Discard(); });

        // Premultiplied out, matching every other compositor layer.
        return vec4(rgb.mul(a), a);
      })();

      // Everything below is the app's ShaderMaterial state, copied — plus the one
      // thing a node material does NOT inherit.

  // Copied off the material being replaced, not restated.
  material.transparent = proto.transparent;
  material.side = proto.side;
  material.depthTest = proto.depthTest;
  material.depthWrite = proto.depthWrite;
  material.blending = proto.blending;
  material.blendSrc = proto.blendSrc;
  material.blendDst = proto.blendDst;
  material.blendSrcAlpha = proto.blendSrcAlpha;
  material.blendDstAlpha = proto.blendDstAlpha;
  // See the header: without this the whole sorted cloud composites in the wrong
  // order (§13).
  material.forceSinglePass = true;
  material.uniforms = S;
  return material;
}
