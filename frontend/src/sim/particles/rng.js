// Deterministic randomness for the particle solver.
//
// NOTHING in the solver or the shader may call Math.random(). Every random draw
// is a pure function of (seed, particle uid, stream index), which is what makes a
// re-bake byte-identical and what keeps a particle's own look stable for its whole
// life — preview, scrubbing backwards, a range render and the headless render all
// have to agree frame for frame.

/** 32-bit integer avalanche (Wang-style). */
export function hash32(x) {
  let v = x | 0;
  v = (v ^ 61) ^ (v >>> 16);
  v = (v + (v << 3)) | 0;
  v ^= v >>> 4;
  v = Math.imul(v, 0x27d4eb2d);
  v ^= v >>> 15;
  return v >>> 0;
}

/** [0,1) from a seed, a particle uid and a stream index. */
export function rnd(seed, uid, stream) {
  return hash32(
    Math.imul(seed | 0, 374761393) ^ Math.imul(uid | 0, 668265263) ^ Math.imul((stream | 0) + 1, 2246822519)
  ) / 4294967296;
}

/** [-1,1) from the same triple. */
export function srnd(seed, uid, stream) {
  return rnd(seed, uid, stream) * 2 - 1;
}

/**
 * Curl-ish turbulence: the curl of a sum-of-sines potential.
 *
 * Cheap (12 sines per particle-step), smooth, and divergence-free enough to swirl
 * rather than pump. Deliberately NOT lattice/simplex noise: a table would have to
 * be identical in the solver here and in any future GPU path, and this closed form
 * has nothing to keep in sync.
 *
 * Writes ax/ay/az into `out` (a length-3 array) to stay allocation-free.
 */
export function turbulence(out, x, y, z, t, scale, phase) {
  const s = scale;
  out[0] = Math.sin(y * s * 1.3 + t * 1.10 + phase) - Math.sin(z * s * 0.9 - t * 0.70 + phase * 0.7);
  out[1] = Math.sin(z * s * 1.1 - t * 0.90 + phase) - Math.sin(x * s * 1.2 + t * 1.30 + phase * 1.3);
  out[2] = Math.sin(x * s * 0.8 + t * 0.80 + phase) - Math.sin(y * s * 1.4 - t * 1.20 + phase * 0.4);
}
