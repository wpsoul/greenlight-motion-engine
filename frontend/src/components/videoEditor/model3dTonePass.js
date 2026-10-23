/*
 * The 3D path's tone pass material, as GLSL.
 *
 * Extracted from model3dLayer.js so the port harness can A/B it without
 * importing that whole module (loaders, rig scene, plate machinery). The
 * alternative was copying the shader into the lab, and a copied shader drifts
 * silently the moment either side is edited. Nothing about the shader changed.
 */
import * as THREE from 'three';
import { DISPLAY_TRANSFORM_GLSL } from './threeDisplayTransform';

const TONEMAP_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform float uExposure;
uniform float uDisplay;
// Screens (model3dConfig.screen/screens) carry display-referred media — a UI, a page,
// a video. Their coverage (depth-tested, so whatever stands in front still hides
// them) skips the scene's tone curve: the pixel is the media's own colour, exactly
// what the same file shows as a 2D layer. AgX cannot reach saturated colours at all,
// so no pre-correction in the screen material could do this.
uniform sampler2D uScreenMask;
uniform float uScreenMaskOn;
${DISPLAY_TRANSFORM_GLSL}
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 src = texture2D(uTexture, uv);
  float a = clamp(src.a, 0.0, 1.0);
  // Unpremultiply before the non-linear maths, re-premultiply after, or transparent
  // edges come back with dark fringes.
  vec3 lin = a > 1e-4 ? src.rgb / a : vec3(0.0);
  // uDisplay 0 is the flat-plate case. That pass carries the layer's OWN artwork,
  // which is display-referred from end to end — the bake is raw, the plate material
  // samples it raw, and the shadow is a multiply. So it passes straight through.
  // Anything else changes an ordinary 2D layer's colour the moment it starts
  // catching a shadow: ACES desaturates it, and a bare encode washes it out (the
  // second sRGB encode of #e11d48 is #f15f91 — measured, not guessed).
  vec3 mapped = uDisplay > 0.5 ? veDisplayTransform(lin, uExposure) : lin;
  if (uScreenMaskOn > 0.5) mapped = mix(mapped, veToSRGB(lin), texture2D(uScreenMask, uv).r);
  gl_FragColor = vec4(mapped * a, a);
}
`;

const TONEMAP_VERT = /* glsl */ `
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

/** The GLSL tone material. `ensureTonePass()` swaps in the twin on WebGPU. */
export function createModelTonePassMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTexture: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uExposure: { value: 1 },
      uDisplay: { value: 1 },
      uScreenMask: { value: null },
      uScreenMaskOn: { value: 0 },
    },
    vertexShader: TONEMAP_VERT,
    fragmentShader: TONEMAP_FRAG,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    // A full-frame COPY into a target that was just cleared, whose output is
    // already premultiplied (`mapped * a`). Ordinary source-alpha blending would
    // multiply by alpha a second time, darkening every antialiased silhouette
    // into a dirty outline.
    blending: THREE.NoBlending,
  });
}
