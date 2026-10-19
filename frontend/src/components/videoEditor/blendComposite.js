/*
 * The destination-reading blend pass (WebGL). TSL twin: blendCompositeNodes.js.
 *
 * `blend(stack, plate)` for the SHADER blend modes of blendModes.js — the ones
 * the GPU blend unit cannot express because they need the colour already
 * under the layer. The compositor renders the layer alone (its isolate plate,
 * premultiplied, opacity already in its alpha) and this pass writes the
 * accumulated stack with the layer blended in, into the ping-pong partner.
 *
 * Maths is the W3C compositing-1 / PDF formula on premultiplied inputs:
 *
 *   Co = (1 − αs)·Cd′ + (1 − αd)·Cs′ + αs·αd·B(Cd, Cs)
 *   αo = αs + αd·(1 − αs)
 *
 * (′ = premultiplied, plain = un-premultiplied). Where the stack is empty the
 * layer lands plain; where the layer is absent the stack is untouched; at a
 * soft edge the two cross-fade through the blend, so opacity and antialiasing
 * both come out right with no per-mode identity trick.
 *
 * Both inputs are read at gl_FragCoord / uResolution — the same storage-
 * identity read the Backdrop Blur mix uses, which is what lets the camera-axis
 * stack pass through and come out on the same axis (identity on WebGL either
 * way; the TSL twin is where it matters).
 */
import * as THREE from 'three';
import { BLEND_MODE_INDEX } from './blendModes.js';

const vertexShader = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Shared by the GLSL pass and any GLSL effect that wants the same table.
export const BLEND_FUNCTIONS_GLSL = /* glsl */ `
float bmLum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 bmClipColor(vec3 c) {
  float l = bmLum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-5);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-5);
  return c;
}
vec3 bmSetLum(vec3 c, float l) { return bmClipColor(c + (l - bmLum(c))); }
float bmSat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 bmSetSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
vec3 bmScreen(vec3 b, vec3 s) { return b + s - b * s; }
vec3 bmColorDodge(vec3 b, vec3 s) {
  vec3 r = min(vec3(1.0), b / max(1.0 - s, vec3(1e-5)));
  r = mix(r, vec3(1.0), step(vec3(1.0), s));
  r = mix(r, vec3(0.0), step(b, vec3(0.0)));
  return r;
}
vec3 bmColorBurn(vec3 b, vec3 s) {
  vec3 r = 1.0 - min(vec3(1.0), (1.0 - b) / max(s, vec3(1e-5)));
  r = mix(r, vec3(0.0), step(s, vec3(0.0)));
  r = mix(r, vec3(1.0), step(vec3(1.0), b));
  return r;
}
vec3 bmHardLight(vec3 b, vec3 s) {
  vec3 m = step(s, vec3(0.5));
  return mix(bmScreen(b, 2.0 * s - 1.0), b * 2.0 * s, m);
}
vec3 bmSoftLight(vec3 b, vec3 s) {
  vec3 d = mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, step(b, vec3(0.25)));
  vec3 lo = b - (1.0 - 2.0 * s) * b * (1.0 - b);
  vec3 hi = b + (2.0 * s - 1.0) * (d - b);
  return mix(hi, lo, step(s, vec3(0.5)));
}
// b = backdrop (the stack), s = source (the layer); both un-premultiplied.
vec3 bmBlend(int mode, vec3 b, vec3 s) {
  if (mode == ${BLEND_MODE_INDEX.multiply}) return b * s;
  if (mode == ${BLEND_MODE_INDEX.screen}) return bmScreen(b, s);
  if (mode == ${BLEND_MODE_INDEX.add}) return min(vec3(1.0), b + s);
  if (mode == ${BLEND_MODE_INDEX.lighten}) return max(b, s);
  if (mode == ${BLEND_MODE_INDEX.darken}) return min(b, s);
  if (mode == ${BLEND_MODE_INDEX.overlay}) return bmHardLight(s, b);
  if (mode == ${BLEND_MODE_INDEX.softLight}) return bmSoftLight(b, s);
  if (mode == ${BLEND_MODE_INDEX.hardLight}) return bmHardLight(b, s);
  if (mode == ${BLEND_MODE_INDEX.colorDodge}) return bmColorDodge(b, s);
  if (mode == ${BLEND_MODE_INDEX.colorBurn}) return bmColorBurn(b, s);
  if (mode == ${BLEND_MODE_INDEX.linearBurn}) return max(vec3(0.0), b + s - 1.0);
  if (mode == ${BLEND_MODE_INDEX.vividLight}) {
    vec3 m = step(s, vec3(0.5));
    return mix(bmColorDodge(b, 2.0 * s - 1.0), bmColorBurn(b, 2.0 * s), m);
  }
  if (mode == ${BLEND_MODE_INDEX.linearLight}) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
  if (mode == ${BLEND_MODE_INDEX.pinLight}) {
    vec3 m = step(s, vec3(0.5));
    return mix(max(b, 2.0 * s - 1.0), min(b, 2.0 * s), m);
  }
  if (mode == ${BLEND_MODE_INDEX.hardMix}) return step(vec3(1.0), b + s);
  if (mode == ${BLEND_MODE_INDEX.difference}) return abs(b - s);
  if (mode == ${BLEND_MODE_INDEX.exclusion}) return b + s - 2.0 * b * s;
  if (mode == ${BLEND_MODE_INDEX.subtract}) return max(vec3(0.0), b - s);
  if (mode == ${BLEND_MODE_INDEX.divide}) {
    vec3 r = min(vec3(1.0), b / max(s, vec3(1e-5)));
    return mix(r, vec3(1.0), step(s, vec3(0.0)));
  }
  if (mode == ${BLEND_MODE_INDEX.darkerColor}) return bmLum(s) < bmLum(b) ? s : b;
  if (mode == ${BLEND_MODE_INDEX.lighterColor}) return bmLum(s) > bmLum(b) ? s : b;
  if (mode == ${BLEND_MODE_INDEX.hue}) return bmSetLum(bmSetSat(s, bmSat(b)), bmLum(b));
  if (mode == ${BLEND_MODE_INDEX.saturation}) return bmSetLum(bmSetSat(b, bmSat(s)), bmLum(b));
  if (mode == ${BLEND_MODE_INDEX.color}) return bmSetLum(s, bmLum(b));
  if (mode == ${BLEND_MODE_INDEX.luminosity}) return bmSetLum(b, bmLum(s));
  return s; // normal
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D uTexture; // the accumulated stack (destination), premultiplied
uniform sampler2D uLayer;   // the layer's finished isolate (source), premultiplied
uniform vec2 uResolution;   // the stack target's size
uniform int uMode;          // BLEND_MODE_INDEX
${BLEND_FUNCTIONS_GLSL}
float bmHash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 d = texture2D(uTexture, uv);
  vec4 s = texture2D(uLayer, uv);
  vec3 cd = d.a > 0.0 ? d.rgb / d.a : vec3(0.0);
  vec3 cs = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  int mode = uMode;
  if (mode == ${BLEND_MODE_INDEX.dissolve}) {
    // Photoshop's Dissolve: per pixel the layer is either fully there or not,
    // with probability = its alpha. Static noise, keyed to the pixel, so it
    // holds still across frames.
    float k = step(bmHash(floor(gl_FragCoord.xy)), s.a) * step(1e-4, s.a);
    s = vec4(cs * k, k);
    mode = ${BLEND_MODE_INDEX.normal};
  }
  vec3 b = bmBlend(mode, cd, cs);
  vec3 rgb = (1.0 - s.a) * d.rgb + (1.0 - d.a) * s.rgb + s.a * d.a * b;
  float a = s.a + d.a * (1.0 - s.a);
  gl_FragColor = vec4(rgb, a);
}
`;

export function createBlendCompositeMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uTexture: { value: null },
      uLayer: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uMode: { value: 0 },
    },
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}
