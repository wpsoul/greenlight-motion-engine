/*
 * Echo's GPU material, split out from echoEffect.js.
 *
 * WHY THE SPLIT: echoEffect.js is imported by adjustmentEffects.js, which the
 * capability generator and the effect registry pull into plain Node. Keeping
 * `three` and the material factory on this side leaves the param list, the tap
 * planner and the ring maths as a testable leaf with no renderer in its import
 * graph — and it removes the materialFactory -> echoNodes -> echoEffect cycle.
 *
 * Only ONE material lives here. Echo's tap pass is Motion Trail's warp (same
 * job: read a plate through a src->dst box pair, weighted and tinted) and its
 * output pass is Motion Trail's compose, so the operator set is the only thing
 * Echo has to own — and therefore the only place its two backends can drift.
 */
import * as THREE from 'three';
import { materials as makeMaterial } from './materialFactory';
import { ECHO_OP_BACK } from './echoEffect';

const VERTEX = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/*
 * Fold one image into the running stack. `uFirst` writes the image straight
 * through, so the stack starts as the live plate rather than as a blend against
 * a cleared target — an operator like Minimum or Blend would otherwise see a
 * transparent first operand and collapse the whole stack.
 *
 * Everything is premultiplied. Blend keeps its own running count so it is an
 * equal-weight average of the images actually drawn, not of the images asked for
 * (the weight cutoff can end the stack early).
 */
const ACC_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uAcc;
uniform sampler2D uTap;
uniform vec2 uResolution;
uniform float uOp, uFirst, uFolded;
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 e = texture2D(uTap, uv);
  if (uFirst > 0.5) { gl_FragColor = e; return; }
  vec4 a = texture2D(uAcc, uv);
  vec4 r;
  if (uOp < 0.5)      r = a + e;                                        // Add
  else if (uOp < 1.5) r = vec4(1.0) - (vec4(1.0) - a) * (vec4(1.0) - e); // Screen
  else if (uOp < 2.5) r = max(a, e);                                    // Maximum
  else if (uOp < 3.5) r = min(a, e);                                    // Minimum
  else if (uOp < 4.5) r = a + e * (1.0 - a.a);                          // Composite In Back
  else if (uOp < 5.5) r = e + a * (1.0 - e.a);                          // Composite In Front
  else                r = (a * uFolded + e) / (uFolded + 1.0);          // Blend
  r = clamp(r, 0.0, 1.0);
  r.rgb = min(r.rgb, vec3(r.a));
  gl_FragColor = r;
}
`;

export function createEchoAccMaterial() {
  return makeMaterial.echoAcc() ?? new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: ACC_FRAGMENT,
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uAcc: { value: null },
      uTap: { value: null },
      uResolution: { value: new THREE.Vector2(1920, 1080) },
      uOp: { value: ECHO_OP_BACK },
      uFirst: { value: 0 },
      uFolded: { value: 0 },
    },
  });
}
