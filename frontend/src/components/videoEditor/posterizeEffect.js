// Posterize — After Effects' Posterize, decoded from AE 2026's own renders
// (html/posterize-lab is the look-dev, tests/posterize-lab/ae the measurement).
//
// Per channel, on the STRAIGHT (unpremultiplied) colour, v = 0..255:
//     k   = floor(v · Level / 255)
//     out = min(255, round(k · 255 / (Level − 1)))
// so the bins are equal slices of 0..255 and the outputs run from 0 to 255
// inclusive (Level 3 → 0 / 128 / 255, edges at 85 and 170). Alpha is never
// touched. Level is NOT rounded: AE keeps fractions (keyed 2 → 3 reads 2.5
// halfway); the top bin just narrows and every band slides, so a keyed Level
// sweep moves smoothly exactly as it does in AE. With Dither 0 every pixel
// matches AE (verified on a ramp chart, a photo and a soft-edged cut-out).
//
// Beyond AE:
//   Channels: Luminance posterizes brightness only and keeps the colour: the
//     blend-mode luma goes through the same bins and SetLum puts it back (the
//     Luminosity blend mode's maths, BLEND_FUNCTIONS_GLSL).
//   Dither: an ordered Bayer 8×8 threshold added before the floor, in bins
//     (±0.5 at 100 %), so the band edges stay where AE puts them and dissolve
//     around them. On fxCoord: the pattern rides the layer and never re-rolls as
//     it moves. Dither Size = the pattern cell in plate px, like Grain's Size.
//
// One pass, no targets, nothing to bake.
import { BLEND_FUNCTIONS_GLSL } from './blendComposite.js';

export const POSTERIZE_PARAMS = [
  { key: 'level', slot: 0, label: 'Level', min: 2, max: 255, step: 1, default: 5 },
  { key: 'channels', slot: 1, label: 'Channels', type: 'select', default: 0, options: [
    { value: 0, label: 'RGB' }, { value: 1, label: 'Luminance' }] },
  { key: 'dither', slot: 2, label: 'Dither', min: 0, max: 100, step: 1, default: 9, suffix: '%' },
  { key: 'ditherSize', slot: 3, label: 'Dither Size', min: 1, max: 8, step: 1, default: 1, suffix: 'px' },
];

const POSTERIZE_FX = /* glsl */ `
${BLEND_FUNCTIONS_GLSL}
// Bayer 8x8 threshold in [0, 63/64], from three nested 2x2 steps (no arrays, no bit ops).
float pzBayer2(vec2 a) { a = mod(floor(a), 2.0); return fract(a.x * 0.5 + a.y * 0.75); }
float pzBayer8(vec2 a) { return pzBayer2(a * 0.25) * 0.0625 + pzBayer2(a * 0.5) * 0.25 + pzBayer2(a); }
// AE Posterize on 0..1 straight colour. An 8-bit code is snapped first so AE's exact
// ties (v * L / 255 landing on a whole number, e.g. 85 at Level 3) fall the same way;
// d = dither offset in bins. The small biases keep the GPU's reciprocal division off
// the wrong side of a tie.
vec3 pzLevels(vec3 c, float L, float d) {
  vec3 v = c * 255.0;
  vec3 vr = floor(v + 0.5);
  v = mix(v, vr, step(abs(v - vr), vec3(1e-3)));
  vec3 k = max(floor(v * L / 255.0 + d + 1e-4), 0.0);
  return min(floor(k * 255.0 / (L - 1.0) + 0.5 + 1e-4), 255.0) / 255.0;
}
vec4 fx(vec2 uv) {
  vec4 s = texture2D(uTexture, uv);
  if (s.a <= 0.0) return s;
  vec3 c = unpremult(s);
  float L = clamp(uParams[0], 2.0, 255.0);
  float amt = clamp(uParams[2] / 100.0, 0.0, 1.0);
  float d = 0.0;
  if (amt > 0.0) {
    vec2 cell = floor(fxCoord(uv) / max(1.0, floor(uParams[3] + 0.5)));
    d = (pzBayer8(cell) + 0.0078125 - 0.5) * amt;
  }
  if (uParams[1] > 0.5) c = bmSetLum(c, pzLevels(vec3(bmLum(c)), L, d).x);
  else c = pzLevels(c, L, d);
  return premult(c, s.a);
}
`;

export const POSTERIZE_EFFECT = {
  id: 'posterize',
  name: 'Posterize',
  group: 'Color',
  animated: false,
  // Alpha is never touched, so the output already IS the item's silhouette.
  // Clipping would multiply a semi-transparent pixel by its own alpha a second
  // time (the matte clip scales rgba by the matte's alpha): a 50 % card would
  // come out at 25 %. Clip to layer stays available per instance.
  layerMatte: 'expand',
  params: POSTERIZE_PARAMS,
  colorPresets: [
    { name: 'Seven Tones', params: { level: 7, channels: 0, dither: 0, ditherSize: 1 } },      // = AE's default
    { name: 'Screenprint', params: { level: 3, channels: 0, dither: 0, ditherSize: 1 } },
    { name: 'Primaries', params: { level: 2, channels: 0, dither: 0, ditherSize: 1 } },
    { name: 'Tone Bands', params: { level: 5, channels: 1, dither: 0, ditherSize: 1 } },
    { name: 'Retro Dither', params: { level: 3, channels: 0, dither: 100, ditherSize: 2 } },
    { name: 'Soft Contour', params: { level: 8, channels: 1, dither: 40, ditherSize: 1 } },
  ],
  fragment: POSTERIZE_FX,
};
