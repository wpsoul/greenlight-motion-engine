/*
 * A polynomial atan2, in both languages, from one file.
 *
 * WHY. Hardware `atan2` is NOT bit-stable across the two backends — measured on
 * a known input sweep, it differs on 753 of 141,141 sampled pixels at max Δ 255
 * (html/webgpu-migration/port/transcendentals.html, op `atan`). Every other
 * operation Running Glow uses — exp, sin, cos, pow, sqrt — is bit-identical.
 *
 * It was not the cause of Running Glow's app-path parity failure: replacing it
 * in both paths left that frame byte-identical. The actual bug was reuse of a
 * texture-orientation UV for screen-space orbit geometry. The polynomial stays
 * because it independently removes a measured unstable primitive.
 *
 * THIS APPROXIMATION uses only multiply, add, divide and compare — all four
 * measured bit-identical. It scores 3 differing pixels against the hardware
 * version's 753: roughly 250x more stable. It is NOT perfect; the residual sits
 * at quadrant boundaries where a borderline comparison can flip, and
 * verify_transcendentals.js records it as unstable rather than rounding that
 * away. Accuracy is ~1e-7 absolute, far below anything a phase drives here.
 *
 * BOTH LANGUAGES LIVE HERE ON PURPOSE. Changing one side alone would leave the
 * two backends computing different values BY DESIGN, which is worse than the
 * instability being fixed — the DOF hash experiment demonstrated exactly that.
 * Keeping the GLSL string next to the TSL makes divergence between them a
 * visible edit rather than an invisible drift.
 */
import { Fn, float, abs, min, max, select } from 'three/tsl';

/**
 * atan2(y, x) → radians in (-π, π].
 *
 * Not laid out with `.setLayout()`: it is a handful of arithmetic nodes, so
 * inlining duplicates nothing worth hoisting (PORTING-GUIDE §2).
 */
export const stableAtan2 = Fn(([y, x]) => {
  const ay = abs(y);
  const ax = abs(x);
  // The ratio of the smaller magnitude to the larger keeps the series argument
  // in [0,1] for every quadrant; the max() guards the origin.
  const a = min(ax, ay).div(max(max(ax, ay), 1e-12));
  const s = a.mul(a);
  const r = s.mul(-0.0464964749).add(0.15931422).mul(s).sub(0.327622764)
    .mul(s).mul(a).add(a).toVar();
  // Fold the [0, π/4] result out to the correct octant, then quadrant, then sign.
  r.assign(select(ay.greaterThan(ax), float(1.57079637).sub(r), r));
  r.assign(select(x.lessThan(0.0), float(3.14159274).sub(r), r));
  return select(y.lessThan(0.0), r.negate(), r);
});

/*
 * The GLSL twin lives in stableAtan2Glsl.js and is deliberately NOT re-exported
 * here. A re-export would resolve, and would put `three/tsl` right back into
 * every WebGL importer's graph — the exact coupling the split removes.
 */
