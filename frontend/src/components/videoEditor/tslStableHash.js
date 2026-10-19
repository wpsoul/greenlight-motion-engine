/*
 * A per-pixel hash that is BIT-IDENTICAL on both backends.
 *
 * The port's two remaining parity failures both traced to `fract`-based hashes.
 * Measured over a known input range (html/webgpu-migration/port/transcendentals.html):
 *
 *   hash12      (DOF spiral rotation)  identical at gain 1, 2.7% different at 4096
 *   fract hash  (glow flicker)         32.2% different at gain 1
 *
 * A chaotic `fract(sin(...))`-style hash amplifies a single ULP into a
 * completely different value, so the two backends' float units cannot be
 * expected to agree. Integer arithmetic can: it is exact on both.
 *
 * THE INPUT MATTERS AS MUCH AS THE MIX, and this is the part that is easy to get
 * wrong. A first attempt fed `uint(uv.x * 4096)` into the same integer mix and
 * still differed on 741 pixels — not because the arithmetic was unstable, but
 * because 4096 is not the frame width, so the products landed at arbitrary
 * fractional positions and any that fell within a ULP of an integer truncated
 * differently on the two backends. Feeding the PIXEL INDEX puts every sample at
 * a pixel centre — exactly i + 0.5, the furthest possible point from a
 * truncation boundary. With that input the mix measures IDENTICAL at both gains.
 *
 * So: pass `screenCoordinate.xy` (or any exact pixel-centre coordinate). Do not
 * pass a rescaled uv.
 *
 * NOT YET ADOPTED, deliberately. Both hashes it would replace also exist in the
 * GLSL implementations, and swapping only the TSL side makes the two compute
 * different values by design. Trying exactly that on the camera-DOF spiral moved
 * its parity numbers by under 1% — which usefully proved the rotation is not
 * what those states measure, but is not a fix. Adoption means changing both
 * sides, and that belongs with an eventual removal of the GLSL path (where the
 * question disappears) rather than being smuggled in as a parity fix. Both
 * pipelines currently ship, so until then changing only the TSL side would make
 * the two renderers disagree by construction.
 */
import { Fn, uint, float } from 'three/tsl';

/**
 * PCG-style integer bit-mix → float in [0, 1).
 *
 * Not laid out with `.setLayout()`: it takes a vec2 and returns a float, but the
 * body mixes integer types, and a layout would have to describe those too. It is
 * short enough that inlining costs nothing (PORTING-GUIDE §2 — layouts are for
 * helpers whose inlining duplicates a large expression tree).
 *
 * @param {object} pixel  exact pixel-centre coordinate, e.g. `screenCoordinate.xy`
 */
export const stableHash12 = Fn(([pixel]) => {
  const ix = uint(pixel.x);
  const iy = uint(pixel.y);
  const h = ix.mul(uint(747796405)).add(iy.mul(uint(2891336453))).add(uint(1)).toVar();
  const w = h.shiftRight(h.shiftRight(uint(28)).add(uint(4))).bitXor(h).mul(uint(277803737)).toVar();
  const r = w.shiftRight(uint(22)).bitXor(w);
  // 24 bits is plenty for a dither and keeps the division exact.
  return float(r.bitAnd(uint(0xffffff))).div(16777216.0);
});
