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
import { Fn, vec3, clamp, mix, pow, step, max, uniform } from 'three/tsl';

/** ACES filmic approximation — the same five constants as the GLSL. */
export const veAces = Fn(([x]) => {
  const a = 2.51;
  const b = 0.03;
  const c = 2.43;
  const d = 0.59;
  const e = 0.14;
  // Association exactly as the GLSL has it: (x*(a*x+b)) / (x*(c*x+d)+e).
  return clamp(
    x.mul(x.mul(a).add(b)).div(x.mul(x.mul(c).add(d)).add(e)),
    0.0, 1.0,
  );
}).setLayout({ name: 'veAces', type: 'vec3', inputs: [{ name: 'x', type: 'vec3' }] });

/** Linear → sRGB, piecewise, with the GLSL's own `step`-based select. */
export const veToSRGB = Fn(([c]) => mix(
  c.mul(12.92),
  pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)).mul(1.055).sub(0.055),
  step(0.0031308, c),
)).setLayout({ name: 'veToSRGB', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }] });

export const veDisplayTransform = Fn(([linearColor, exposure]) => veToSRGB(veAces(linearColor.mul(exposure))))
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
