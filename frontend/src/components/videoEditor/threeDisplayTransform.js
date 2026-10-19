/*
 * The Video Editor's display transform for linear-HDR 3D pixels.
 *
 * The camera/model passes cannot use WebGLRenderer.toneMapping globally: the same
 * renderer also runs the already-display-referred 2D compositor. They therefore use
 * DISPLAY_TRANSFORM_GLSL in an explicit fullscreen pass. World View draws the real
 * MeshStandardMaterial geometry straight to the canvas, so it temporarily selects
 * Three's otherwise-unused CustomToneMapping slot. Installing the exact same GLSL in
 * that slot keeps both views on one curve without changing ordinary 2D ShaderMaterials.
 */

export const DISPLAY_TRANSFORM_GLSL = /* glsl */ `
vec3 veAces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 veToSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 veDisplayTransform(vec3 linearColor, float exposure) {
  return veToSRGB(veAces(linearColor * exposure));
}
`;

const CUSTOM_TONE_IDENTITY = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
const CUSTOM_TONE_VIDEO_EDITOR = `${DISPLAY_TRANSFORM_GLSL}
vec3 CustomToneMapping( vec3 color ) {
  return veDisplayTransform(color, toneMappingExposure);
}`;

/** Pure helper kept separate so the ShaderChunk patch is easy to regression-test. */
export function videoEditorToneMappingChunk(chunk) {
  const source = String(chunk || '');
  if (source.includes('veDisplayTransform')) return source;
  return source.replace(CUSTOM_TONE_IDENTITY, CUSTOM_TONE_VIDEO_EDITOR);
}

/**
 * Install the editor curve into Three's CustomToneMapping slot once. No renderer
 * state changes here; WorldView enables that slot only around its direct canvas draw.
 */
export function installVideoEditorToneMapping(three) {
  const chunks = three?.ShaderChunk;
  if (!chunks?.tonemapping_pars_fragment) return false;
  const next = videoEditorToneMappingChunk(chunks.tonemapping_pars_fragment);
  if (!next.includes('veDisplayTransform')) return false;
  chunks.tonemapping_pars_fragment = next;
  return true;
}
