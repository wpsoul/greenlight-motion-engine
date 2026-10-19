/*
 * The one texture-binding façade for every TSL sampler in the port.
 *
 * WHY THIS EXISTS — the bug that produced it.
 *
 * `resetMaterialUniforms()` clears the 3D-depth plate every frame with
 * `u.uDepthMap.value = null`, which is correct and harmless on a
 * ShaderMaterial. On a NodeMaterial the same line assigns null to a
 * `TextureNode`, and TSL rejects it at BUILD time:
 *
 *     THREE.TSL: `texture( value )` function expects a valid instance of
 *     THREE.Texture(). "TextureNode.setup()"
 *
 * three CATCHES that error and silently falls back to the material's default
 * shader — so the clip material compiled to `DiffuseColor` (opaque black),
 * kept its geometry and alpha, and rendered a black frame with no exception
 * reaching the app. The branch never even runs at draw time (depth was off);
 * TSL compiles it regardless, so a disabled feature broke every frame.
 *
 * TWO RULES, both learned the hard way:
 *
 * 1. A sampler's underlying `TextureNode.value` must NEVER be null. Assigning
 *    null selects a persistent 1x1 fallback instead.
 * 2. That fallback is created ONCE per sampler and reused. An earlier facade
 *    minted a fresh DataTexture on every null assignment — correct output, but
 *    `resetMaterialUniforms` runs ~300 times per exported frame, so it leaked a
 *    texture per reset.
 *
 * ORIENTATION IS STRUCTURAL, and that is a correction to what the port's own
 * comments used to claim.
 *
 * Several modules said "the DRIVER declares what it bound:
 * `mat.uniforms.uTexture.flipY = true`". No driver ever did — a sweep of the
 * whole tree found the setter had ZERO callers, and every sampler has always run
 * on the value its factory passed at construction. The mechanism was fiction
 * describing a footgun: `Fn()` resolves the flip branch into the graph when the
 * material first builds, so a later assignment silently changes nothing.
 *
 * So the flag is now construction-only, and assigning it THROWS rather than
 * doing nothing quietly. Where orientation genuinely varies per binding it is
 * expressed where it belongs — runningGlow passes `makeSampler(isMain)`, because
 * its main pass reads a scratch target and its pre-pass does not.
 *
 * The fallback is per-sampler rather than shared for a third reason: TSL's
 * `texture()` DEDUPES BY TEXTURE OBJECT, so building several samplers from one
 * shared placeholder returns the same node for all of them. They then alias —
 * assigning one sampler's `.value` silently retargets every other, last write
 * wins, nothing throws. That cost the particle system a whole frame once:
 * correct geometry, correct uniforms, empty output.
 */
import * as THREE from 'three/webgpu';
import { texture, vec2, float } from 'three/tsl';

/**
 * @param {object}  [opts]
 * @param {number[]} [opts.rgba]  the fallback's colour. Match what the shader
 *   should see when nothing is bound — WHITE where the sample is a multiplier,
 *   TRANSPARENT where it is a layer, BLACK where it is a backdrop.
 * @param {boolean} [opts.flipY]  whether this BINDING's render-target sample
 *   arrives v-flipped. STRUCTURAL — fixed here, never changed later.
 * @param {number} [opts.filter]  structural min/mag filter used while TSL
 *   builds the binding. Defaults to LinearFilter; pass NearestFilter for data
 *   textures whose texels must not be interpolated.
 */
export function makeTslSampler({
  rgba = [0, 0, 0, 0],
  flipY = false,
  filter = THREE.LinearFilter,
} = {}) {
  const fallback = new THREE.DataTexture(new Uint8Array(rgba), 1, 1);
  /*
   * FILTER TYPE is structural, and this is not cosmetic on a 1x1 texture.
   *
   * TSL decides at BUILD time whether a sampler compiles to a filtered
   * `textureSample` or an unfiltered `textureLoad`, and it decides from the
   * texture BOUND AT THAT MOMENT — which is always this placeholder. A
   * DataTexture defaults to NearestFilter, so a sampler intended for a linear
   * render target would compile to textureLoad if we left the placeholder at
   * its default. Conversely, packed data fields must remain nearest-filtered.
   *
   * Most passes never noticed: they sample at uv() or at the fragment's own
   * position, which lands on a texel centre where a load and a filtered sample
   * agree. Camera DOF samples at arbitrary SUB-TEXEL spiral offsets, so WebGL
   * interpolated while WebGPU snapped to the nearest texel — the difference was
   * worst at one sample (mean 9.14) and averaged down as taps were added.
   *
   * Same shape as the flipY bug: a property read once at graph-build time, and a
   * later assignment that silently changes nothing.
   */
  fallback.minFilter = filter;
  fallback.magFilter = filter;
  fallback.needsUpdate = true;
  const node = texture(fallback);
  // What the APP last assigned, so `.value` reads back exactly what a
  // ShaderMaterial's would — null included. The node keeps the fallback.
  let assigned = null;
  return {
    node,
    get value() { return assigned; },
    set value(next) {
      assigned = next || null;
      node.value = next || fallback;
    },
    /**
     * Read-only, and deliberately so — see the ORIENTATION note in the header.
     * Exposed for diagnostics; assigning it would be a silent no-op, so it
     * throws instead.
     */
    get flipY() { return flipY; },
    set flipY(next) {
      if (next === flipY) return;
      throw new Error('tslSampler: flipY is STRUCTURAL and fixed at construction. '
        + 'Setting it after the graph is built silently changes nothing, because '
        + 'the branch is already resolved into the compiled shader. Pass it to '
        + 'makeTslSampler() instead.');
    },
    /** Sample at frame UV, applying this binding's fixed orientation. */
    sample(uvIn) {
      return flipY ? node.sample(vec2(uvIn.x, float(1.0).sub(uvIn.y))) : node.sample(uvIn);
    },
  };
}
