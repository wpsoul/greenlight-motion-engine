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

// AgX (three.js r183's AgXToneMapping, itself Filament's port of Blender's AgX) with a
// GLEA look — the filmic curve Blender renders with: highlights roll off without hue
// shifts. Two settings make it the editor's default without changing scenes tuned
// before it: a ×1.35 gain (+0.43 EV, in veDisplayTransform) puts mid-grey exactly where the
// old ACES fit had it (sRGB 0.555), and 1.2 saturation (in AgX's log space, like
// Filament's agxLook) keeps brand colours vivid where plain AgX would desaturate them.
// It replaced the ACES fit as the 3D default (2D layers never pass through it).
// Every name is ve-prefixed: World View splices this text into three's own
// tonemapping chunk, which already declares LINEAR_* matrices and AgXToneMapping.
export const DISPLAY_TRANSFORM_GLSL = /* glsl */ `
vec3 veAgxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 veAgx(vec3 color) {
  const mat3 veSrgbToRec2020 = mat3(
    vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 veRec2020ToSrgb = mat3(
    vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 veAgxInset = mat3(
    vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 veAgxOutset = mat3(
    vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float veAgxMinEv = -12.47393;
  const float veAgxMaxEv = 4.026069;
  color = veAgxInset * (veSrgbToRec2020 * color);
  color = clamp((log2(max(color, 1e-10)) - veAgxMinEv) / (veAgxMaxEv - veAgxMinEv), 0.0, 1.0);
  color = veAgxContrast(color);
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = veAgxOutset * (luma + 1.2 * (color - luma));
  color = pow(max(vec3(0.0), color), vec3(2.2));
  return clamp(veRec2020ToSrgb * color, 0.0, 1.0);
}
vec3 veToSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 veDisplayTransform(vec3 linearColor, float exposure) {
  return veToSRGB(veAgx(linearColor * exposure * 1.35));
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
