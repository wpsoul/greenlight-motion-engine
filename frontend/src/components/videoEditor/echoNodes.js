/*
 * TSL twin of echoMaterial.js's accumulator.
 *
 *   createEchoAccNodeMaterial()  ← createEchoAccMaterial()
 *
 * Echo needs only ONE material of its own. Its tap pass is Motion Trail's warp
 * (same job: read a plate through a src→dst box pair, weighted and tinted) and
 * its output pass is Motion Trail's compose, so both arrive already ported —
 * the fewer twins a temporal effect owns, the fewer places its two backends can
 * drift apart. The operator enum comes from the param leaf, not from the GLSL
 * module, so this file never pulls the WebGL build in behind it.
 *
 * Every plate this pass reads was written by one of these quad passes, so the
 * UV is plain `screenCoordinate` with no V flip anywhere — the provenance rule
 * motionTrailNodes.js documents at length. There is no camera-rendered input on
 * this path at all: the overlay chain hands the effect a quad-written plate.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, vec3, vec4, min, max, clamp, select, positionGeometry, screenCoordinate,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';
import { ECHO_OP_BACK } from './echoEffect.js';

const makeSampler = () => makeTslSampler({ rgba: [0, 0, 0, 0] });

/** Same as GLSL `gl_FragCoord.xy / uResolution`. */
const frameUv = (u) => screenCoordinate.xy.div(u.uResolution);

export function createEchoAccNodeMaterial() {
  const u = {
    uAcc: makeSampler(),
    uTap: makeSampler(),
    uResolution: uniform(new THREE.Vector2(1920, 1080)),
    uOp: uniform(ECHO_OP_BACK),
    uFirst: uniform(0),
    uFolded: uniform(0),
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = frameUv(u);
    const e = u.uTap.sample(uvn);
    const a = u.uAcc.sample(uvn);

    // The GLSL twin returns early on uFirst; a node graph has no early return,
    // so the whole ladder is built and selected between. Both halves are pure
    // arithmetic on two samples, so this costs the same either way.
    const add = a.add(e);
    const screen = vec4(1.0).sub(vec4(1.0).sub(a).mul(vec4(1.0).sub(e)));
    const back = a.add(e.mul(a.a.oneMinus()));
    const front = e.add(a.mul(e.a.oneMinus()));
    const blend = a.mul(u.uFolded).add(e).div(u.uFolded.add(1.0));
    const folded = select(u.uOp.lessThan(0.5), add,
      select(u.uOp.lessThan(1.5), screen,
        select(u.uOp.lessThan(2.5), max(a, e),
          select(u.uOp.lessThan(3.5), min(a, e),
            select(u.uOp.lessThan(4.5), back,
              select(u.uOp.lessThan(5.5), front, blend))))));

    const clamped = clamp(folded, 0.0, 1.0).toVar();
    clamped.rgb.assign(min(clamped.rgb, vec3(clamped.a)));
    return select(u.uFirst.greaterThan(0.5), e, clamped);
  })();

  material.vertexNode = vec4(positionGeometry.x, positionGeometry.y, 0.0, 1.0);
  material.transparent = false;
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  // ShaderMaterial's constructor sets this true; every NodeMaterial inherits
  // Material's false (PORTING-GUIDE §13).
  material.forceSinglePass = true;
  material.uniforms = u;
  return material;
}
