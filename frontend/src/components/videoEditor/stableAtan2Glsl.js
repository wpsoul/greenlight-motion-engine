/*
 * The stable atan2 polynomial as GLSL, for the WebGL materials.
 *
 * WHY THIS IS ITS OWN FILE, AND MUST STAY THAT WAY.
 *
 * The GLSL string and the TSL function used to live together in stableAtan2.js.
 * That file imports `three/tsl`, so every importer of the GLSL string imported
 * `three/tsl` too — and the only importer is `runningGlow.js`, which is the
 * WEBGL path. materialFactory.js promises the opposite in as many words: the
 * WebGL path "is not merely unchanged, it is UNTOUCHED", and the node modules
 * load lazily so `three/webgpu` stays out of the WebGL bundle. One shared
 * constant quietly broke that.
 *
 * In the app the damage was invisible, because vite resolves bare specifiers and
 * bundles both. The webgl lab is what noticed: it serves the app's real modules
 * over plain HTTP with an import map that maps `three` alone, so the WebGL glow
 * lab died on "Failed to resolve module specifier three/tsl" before any code
 * ran — a blank page, no error box, and the pair silently stopped being tested.
 *
 * So: NOTHING in this file may import anything. It is a string.
 */

/**
 * The identical function as GLSL, for the WebGL materials.
 *
 * NOTE the name: `veStableAtan2`, not `atan2`, and not `atan`. GLSL's `atan`
 * already exists with a two-argument overload, and shadowing a builtin is a
 * compile error in some drivers and silently ignored in others.
 *
 * NOTE ALSO: no backticks anywhere in this string's comments — a backtick
 * inside GLSL that is embedded in a JS template literal terminates the literal,
 * and the resulting build error points somewhere else entirely.
 */
export const STABLE_ATAN2_GLSL = /* glsl */ `
float veStableAtan2(float y, float x) {
  float ay = abs(y);
  float ax = abs(x);
  float a = min(ax, ay) / max(max(ax, ay), 1e-12);
  float s = a * a;
  float r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
  if (ay > ax) r = 1.57079637 - r;
  if (x < 0.0) r = 3.14159274 - r;
  if (y < 0.0) r = -r;
  return r;
}
`;
