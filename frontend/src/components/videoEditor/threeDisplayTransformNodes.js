/*
 * TSL twin of threeDisplayTransform.js — §4's display transform.
 *
 * The GLSL version reaches the renderer by MONKEYPATCHING `THREE.ShaderChunk`'s
 * tone-mapping chunk. Node materials do not use ShaderChunk at all, so that
 * mechanism has no WebGPU equivalent — the node path registers the curve in the
 * renderer's NODE LIBRARY instead, under the same `CustomToneMapping` constant
 * World View already selects. That symmetry is the point: World View's own code
 * does not change, it still sets `renderer.toneMapping = CustomToneMapping`
 * around its direct canvas draw, and each backend resolves that constant its own
 * way.
 *
 * The first attempt assigned `renderer.toneMappingNode`, which DOES NOT EXIST in
 * r183 — and the guard `if (!('toneMappingNode' in renderer)) return false` made
 * it a permanent, silent no-op that nothing called anyway. Two failure modes in
 * one line: an API that was never there, and a guard that turned its absence
 * into a quiet `false` instead of a noise.
 *
 * KEEP RENDERER OUTPUT LINEAR. `veToSRGB` already does the sRGB encode, so
 * leaving `outputColorSpace` at sRGB would apply the curve TWICE — visibly
 * washed out, and in a way that looks like a grading bug rather than a
 * colour-management one. This is the same trap the 2D compositor's
 * NoColorSpace textures exist for.
 *
 * The two helpers are separate and laid out because they are pure functions of
 * their arguments, which is the condition that makes a layout safe (§2/§7b).
 */
import { Fn, vec3, mat3, clamp, mix, pow, step, max, log2, dot, uniform } from 'three/tsl';

/** Linear → sRGB, piecewise, with the GLSL's own `step`-based select. */
export const veToSRGB = Fn(([c]) => mix(
  c.mul(12.92),
  pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)).mul(1.055).sub(0.055),
  step(0.0031308, c),
)).setLayout({ name: 'veToSRGB', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }] });

// AgX with the GLEA look — the same constants and steps as veAgx in
// threeDisplayTransform.js (three's agxToneMapping plus the saturation look and the
// ×1.35 gain). It replaced veAces as the 3D default.
const VE_SRGB_TO_REC2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
const VE_REC2020_TO_SRGB = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const VE_AGX_INSET = mat3(
  vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
  vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
  vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
const VE_AGX_OUTSET = mat3(
  vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
  vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
  vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
const VE_AGX_MIN_EV = -12.47393;
const VE_AGX_MAX_EV = 4.026069;

export const veAgx = Fn(([color]) => {
  const c = VE_AGX_INSET.mul(VE_SRGB_TO_REC2020.mul(color)).toVar();
  c.assign(clamp(log2(max(c, vec3(1e-10))).sub(VE_AGX_MIN_EV).div(VE_AGX_MAX_EV - VE_AGX_MIN_EV), 0.0, 1.0));
  const x2 = c.mul(c);
  const x4 = x2.mul(x2);
  c.assign(x4.mul(x2).mul(15.5).sub(x4.mul(c).mul(40.14)).add(x4.mul(31.96)).sub(x2.mul(c).mul(6.868))
    .add(x2.mul(0.4298)).add(c.mul(0.1191)).sub(0.00232));
  const luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c.assign(VE_AGX_OUTSET.mul(c.sub(luma).mul(1.2).add(luma)));
  c.assign(pow(max(vec3(0.0), c), vec3(2.2)));
  return clamp(VE_REC2020_TO_SRGB.mul(c), 0.0, 1.0);
}).setLayout({ name: 'veAgx', type: 'vec3', inputs: [{ name: 'color', type: 'vec3' }] });

export const veDisplayTransform = Fn(([linearColor, exposure]) => veToSRGB(veAgx(linearColor.mul(exposure).mul(1.35))))
  .setLayout({
    name: 'veDisplayTransform',
    type: 'vec3',
    inputs: [{ name: 'linearColor', type: 'vec3' }, { name: 'exposure', type: 'float' }],
  });

/**
 * Register the editor curve in the renderer's node library under
 * `CustomToneMapping`, so `renderer.toneMapping = THREE.CustomToneMapping`
 * selects it exactly as it does on WebGL.
 *
 * THROWS rather than returning false when the renderer cannot take it. The
 * previous version returned a quiet `false`, and a silent negative is how the
 * whole thing sat dead for the entire port: nothing called it, and if anything
 * had, it would have reported "not installed" into a value nobody read.
 *
 * @param {object} renderer   a WebGPURenderer (or any node renderer)
 * @param {number} slot       the tone-mapping constant to register under
 */
export function installVideoEditorToneMappingNode(renderer, slot) {
  const library = renderer?.library;
  if (!library || typeof library.addToneMapping !== 'function') {
    throw new Error('installVideoEditorToneMappingNode: renderer has no node library '
      + '(three changed its tone-mapping registration, or this is not a node renderer)');
  }
  if (!Number.isInteger(slot)) {
    throw new Error('installVideoEditorToneMappingNode: needs the CustomToneMapping constant');
  }
  // Signature matches three's own built-ins: Fn(([color, exposure]) => vec3).
  library.addToneMapping(veDisplayTransform, slot);
  return true;
}
