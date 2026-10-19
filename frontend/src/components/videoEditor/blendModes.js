/*
 * The layer blend-mode catalogue — Photoshop's full set.
 *
 * Two families, one list:
 *
 *   HARDWARE modes (`normal | multiply | screen | add | lighten | darken`) map
 *   onto GPU blend factors (THREE.CustomBlending). A layer using one is drawn
 *   straight into the accumulation buffer with NO extra pass, exactly as
 *   before — see applyBlendMode in clipShader.js.
 *
 *   SHADER modes (everything else — overlay, soft light, the dodges and burns,
 *   difference, hue/saturation/color/luminosity…) need to READ the destination.
 *   Hardware blending cannot, so such a layer takes the compositor's isolate
 *   branch: it is rendered alone into a plate and a full-screen pass computes
 *   `blend(stack, plate)` into the ping-pong partner (blendComposite.js /
 *   blendCompositeNodes.js). That costs one extra pass per such layer and
 *   nothing at all for a project that never picks one.
 *
 * `BLEND_MODE_INDEX` is the integer the composite shaders switch on — the GLSL
 * and TSL implementations are kept in that order and MUST agree with it.
 */

export const HW_BLEND_MODES = ['normal', 'multiply', 'screen', 'add', 'lighten', 'darken'];

// Photoshop's menu order, with its separators as groups. `add` is Photoshop's
// "Linear Dodge (Add)".
export const BLEND_MODE_GROUPS = [
  { label: 'Normal', modes: [
    ['normal', 'Normal'],
    ['dissolve', 'Dissolve'],
  ] },
  { label: 'Darken', modes: [
    ['darken', 'Darken'],
    ['multiply', 'Multiply'],
    ['colorBurn', 'Color Burn'],
    ['linearBurn', 'Linear Burn'],
    ['darkerColor', 'Darker Color'],
  ] },
  { label: 'Lighten', modes: [
    ['lighten', 'Lighten'],
    ['screen', 'Screen'],
    ['colorDodge', 'Color Dodge'],
    ['add', 'Linear Dodge (Add)'],
    ['lighterColor', 'Lighter Color'],
  ] },
  { label: 'Contrast', modes: [
    ['overlay', 'Overlay'],
    ['softLight', 'Soft Light'],
    ['hardLight', 'Hard Light'],
    ['vividLight', 'Vivid Light'],
    ['linearLight', 'Linear Light'],
    ['pinLight', 'Pin Light'],
    ['hardMix', 'Hard Mix'],
  ] },
  { label: 'Inversion', modes: [
    ['difference', 'Difference'],
    ['exclusion', 'Exclusion'],
    ['subtract', 'Subtract'],
    ['divide', 'Divide'],
  ] },
  { label: 'Component', modes: [
    ['hue', 'Hue'],
    ['saturation', 'Saturation'],
    ['color', 'Color'],
    ['luminosity', 'Luminosity'],
  ] },
];

export const BLEND_MODES = BLEND_MODE_GROUPS.flatMap((g) => g.modes.map(([id]) => id));

// The shader switch. Order is the contract with blendComposite.js and
// blendCompositeNodes.js — append, never reorder.
export const BLEND_MODE_INDEX = Object.freeze({
  normal: 0,
  multiply: 1,
  screen: 2,
  add: 3,
  lighten: 4,
  darken: 5,
  overlay: 6,
  softLight: 7,
  hardLight: 8,
  colorDodge: 9,
  colorBurn: 10,
  linearBurn: 11,
  vividLight: 12,
  linearLight: 13,
  pinLight: 14,
  hardMix: 15,
  difference: 16,
  exclusion: 17,
  subtract: 18,
  divide: 19,
  darkerColor: 20,
  lighterColor: 21,
  hue: 22,
  saturation: 23,
  color: 24,
  luminosity: 25,
  dissolve: 26,
});

export function normalizeBlendMode(mode) {
  return typeof mode === 'string' && BLEND_MODES.includes(mode) ? mode : 'normal';
}

/** True for a mode the GPU blend unit cannot do — the layer needs the composite pass. */
export function isShaderBlendMode(mode) {
  const m = normalizeBlendMode(mode);
  return m !== 'normal' && !HW_BLEND_MODES.includes(m);
}
