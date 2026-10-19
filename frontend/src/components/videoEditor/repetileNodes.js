/*
 * TSL twin of repetileLayer.js's instanced tile pass.
 *
 * Shape worth knowing before reading: this pass BYPASSES the camera. Its vertex
 * shader writes clip space directly from the layer box's own two half-axes, so
 * the field tiles along the LAYER's orientation rather than the screen's. That
 * is why the twin sets `vertexNode` rather than leaning on the default MVP.
 *
 * The six instanced attributes all come from ONE `InstancedInterleavedBuffer`,
 * so this is two vertex buffers, not seven — comfortably inside WebGPU's cap of
 * eight, which the particle port had to be repacked to respect.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, If, Discard, attribute, varying, uniform, uv, vec2, vec3, vec4, float,
  abs, min, max, clamp, mix, floor, sin, cos, positionGeometry,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';

/*
 * GLSL `mod` is a FLOOR modulo; TSL's `.mod()` is `%`, which truncates toward
 * zero. They differ for negative inputs, and every use here is on a value that
 * goes negative — `mod(l + 1.0, 2.0)` with l in [-1,1] and the mirror fold.
 * Getting this wrong does not throw; it mirrors the wrong half of the tile.
 */
const glslMod = (x, y) => x.sub(y.mul(floor(x.div(y))));

/** Null-safe binding facade; see tslSampler.js. */
const makeSampler = () => makeTslSampler({ rgba: [0, 0, 0, 0] });

export function createRepetileNodeMaterial() {
  const u = {
    uTexture: makeSampler(),
    // Plate-provenance V flip: 1 while the bound plate is the camera-rendered
    // isolate (rt.c fresh from the channel camera), 0 for quad-written plates.
    uFlipV: uniform(0),
    uOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uAxisX: uniform(new THREE.Vector2(0.5, 0)),
    uAxisY: uniform(new THREE.Vector2(0, 0.5)),
    uHalfPx: uniform(new THREE.Vector2(100, 100)),
    uFeather: uniform(0),
    uClipCell: uniform(0),
    uEdgeMode: uniform(2),
  };

  const aCenter = attribute('aCenter', 'vec2');
  const aHalf = attribute('aHalf', 'vec2');
  const aRotAlpha = attribute('aRotAlpha', 'vec2');
  const aUvScale = attribute('aUvScale', 'vec2');
  const aCell = attribute('aCell', 'vec4');
  const aTint = attribute('aTint', 'vec4');

  // Box-local px for this corner, rotated by the tile's own angle.
  const corner = positionGeometry.xy;
  const c = cos(aRotAlpha.x);
  const s = sin(aRotAlpha.x);
  const p = corner.mul(aHalf);
  const boxPx = aCenter.add(vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c))));

  const vLocal = varying(corner);
  const vBoxPx = varying(boxPx);
  const vAlpha = varying(aRotAlpha.y);
  const vCell = varying(aCell);
  const vTint = varying(aTint);
  const vUvScale = varying(aUvScale);

  const material = new THREE.MeshBasicNodeMaterial();

  /*
   * Box-local px -> box units -> frame uv -> clip space, with no view or
   * projection matrix anywhere: the two half-axes ARE the projection.
   *
   * THE Y IS NEGATED, and only because this pass writes clip space BY HAND.
   * Every other twin goes through a camera, and three's projection matrix
   * already accounts for WebGPU's framebuffer origin; bypassing the camera
   * bypasses that compensation too. Measured, not assumed: without it the
   * output is an exact vertical mirror of the WebGL frame.
   *
   * Negating y also reverses triangle winding, so the material must not
   * back-face cull — the first attempt at this flip drew NOTHING at all,
   * which reads like "the material is broken" rather than "the winding
   * turned over". Hence DoubleSide below.
   *
   * The isolate SAMPLE flips only by plate provenance (uFlipV): a camera-
   * rendered isolate is stored on the opposite V axis under WebGPU and must be
   * flipped at the sample point; a quad-written plate (after DoF/glow/chain)
   * is already in frame-UV space and must not be. Hardcoding either way broke
   * one of the two arrangements — measured in the app, not the lab.
   */
  const l0 = boxPx.div(u.uHalfPx);
  const uvPos = u.uOrigin.add(u.uAxisX.mul(l0.x)).add(u.uAxisY.mul(l0.y));
  material.vertexNode = vec4(
    uvPos.x.mul(2.0).sub(1.0), float(1.0).sub(uvPos.y.mul(2.0)), 0.0, 1.0);

  material.fragmentNode = Fn(() => {
    If(u.uClipCell.greaterThan(0.5), () => {
      const d = abs(vBoxPx.sub(vCell.xy)).sub(vCell.zw);
      If(d.x.greaterThan(0.0).or(d.y.greaterThan(0.0)), () => { Discard(); });
    });
    const l = vLocal.mul(vUvScale).toVar();
    /*
     * Edge handling is in BOX units, never on the sampler. The box is a sub-rect
     * of a frame-sized isolate, so GL_REPEAT on the texture would wrap the whole
     * FRAME rather than the tile.
     */
    If(u.uEdgeMode.lessThan(0.5), () => {                       // repeat
      l.assign(glslMod(l.add(1.0), vec2(2.0)).sub(1.0));
    }).ElseIf(u.uEdgeMode.lessThan(1.5), () => {                // mirror
      const t = glslMod(l.add(1.0), vec2(4.0)).mul(0.5);
      l.assign(vec2(1.0).sub(abs(t.sub(1.0))).mul(2.0).sub(1.0));
    }).ElseIf(u.uEdgeMode.lessThan(2.5), () => {                // clamp
      l.assign(clamp(l, -1.0, 1.0));
    }).Else(() => {                                             // none
      If(abs(l.x).greaterThan(1.0).or(abs(l.y).greaterThan(1.0)), () => { Discard(); });
    });

    const uvn = u.uOrigin.add(u.uAxisX.mul(l.x)).add(u.uAxisY.mul(l.y));
    const col = u.uTexture.sample(vec2(uvn.x, mix(uvn.y, uvn.y.oneMinus(), u.uFlipV))).toVar();
    If(u.uFeather.greaterThan(0.001), () => {
      const e = vec2(1.0).sub(abs(vLocal)).div(u.uFeather);
      col.mulAssign(clamp(min(e.x, e.y), 0.0, 1.0));
    });
    // Tint on STRAIGHT colour, then re-premultiplied — mixing premultiplied rgb
    // toward a straight tint would darken every partially covered texel.
    If(vTint.a.greaterThan(0.001).and(col.a.greaterThan(0.0009)), () => {
      const straight = col.rgb.div(col.a);
      col.rgb.assign(mix(straight, vTint.rgb, vTint.a).mul(col.a));
    });
    return col.mul(vAlpha);
  })();

  material.transparent = true;
  material.side = THREE.DoubleSide;   // see the winding note on vertexNode
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  // ShaderMaterial's constructor sets this true, every NodeMaterial inherits
  // Material's false (PORTING-GUIDE §13).
  material.forceSinglePass = true;
  material.uniforms = u;
  return material;
}
