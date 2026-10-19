/*
 * Pool and instance strides — the numbers, with no shader text attached.
 *
 * These live apart from drawWgsl.js and deriveWgsl.js for one specific reason:
 * ParticlePanel imports tier.js to size its VRAM estimate, and tier.js needs
 * these two constants. If it took them from the shader modules, the WHOLE
 * WGSL — every pass, every string — would be pulled into the editor's static
 * bundle for every project, including the ones with no Solver Box. It was, and
 * the build check in tests/particles-gpu-scale/ now fails if it happens again.
 *
 * One source of truth still: the shader modules import from here rather than
 * restating the numbers, and shaders.test.mjs checks them against the WGSL
 * struct declarations.
 */

/** Floats per pool slot — three vec4s: pos+uid, vel+near, birth/life/release. */
export const PART_FLOATS = 12;
export const PART_BYTES = PART_FLOATS * 4;

/**
 * Floats per drawn instance — FOUR vec4 banks.
 *
 * It was five, mirroring the GLSL path's banks one for one. Four of those
 * twenty floats could not vary on this engine, and carrying them cost 16 bytes
 * a particle — 128 MB at eight million — to move constants around:
 *
 *   rotation, tumble squash   object mode owns both, and object mode is Tier 1
 *                             only (gpuUnsupported refuses `render.mode:
 *                             'layers'`), so this engine always billboards
 *                             upright and unsquashed: 0 and 1, every particle,
 *                             every frame.
 *   held                      Grow Points, also Tier 1 only. Always 0.
 *   ignite                    the Grow Points flare. `igniteFor` is zero unless
 *                             the activation mode is 'grow', so also always 0.
 *
 * The draw shader now uses the constants directly instead of reading them back
 * out of memory, and three varyings went with them. If Grow Points or object
 * members ever come to Tier 2, this is where the lanes come back — as new
 * fields, with the tier exclusion lifted in the same change.
 */
export const INST_FLOATS = 16;
export const INST_BYTES = INST_FLOATS * 4;
