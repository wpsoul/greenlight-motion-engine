// Full executable transition starter for the WebGPU engine. This package owns
// the shader and lifecycle.
//
// Shading is TSL, which is what the WebGPU engine builds — the app's engine
// when GET /api/video-editor/engine reports "webgpu". For the classic engine
// start from starter-transition-glsl.js instead; it is the same transition
// written in GLSL. Only one of the two ever draws, which is what `renderer`
// below is for: declare it and the editor refuses it on the other engine by
// name instead of rendering an empty frame.
//
// `fragment` is a FUNCTION that returns a node — it is called once when the
// package is installed, with the TSL builders and this package's uniforms in
// scope. That means a broken shader is caught at install, with a message,
// instead of drawing an empty frame at playback.
import {
  clamp01, createShaderMaterial, createFullscreenPlane, replacePlaneGeometry,
} from './transition-sdk';

export const id = 'my-shader-transition';
export const name = 'My Shader Transition';
// The engine this package's shading is written for: 'webgpu' or 'webgl'.
export const renderer = 'webgpu';
// Optional initial editor length in seconds (0.05–30). Omit to use 1 second.
// Users can still change Length after applying the transition.
export const defaultDuration = 4;
export const optionDefaults = { intensity: 1, tint: '#ffffff', muteSound: false };
export const optionFields = [
  { key: 'intensity', label: 'Intensity', type: 'range', min: 0, max: 2, step: 0.01 },
  { key: 'tint', label: 'Tint', type: 'color' },
  { key: 'muteSound', label: 'Mute sound', type: 'switch' },
];

// The two clip plates arrive as textures on uPrevious / uCurrent, and `uv()` is
// the fullscreen quad's own coordinate — no varying to declare.
const fragment = ({ tsl, uniforms }) => {
  const { vec2, float, uv, sin, mix, clamp, smoothstep } = tsl;
  const { uPrevious, uCurrent, uProgress, uIntensity } = uniforms;

  const p = clamp(uProgress, 0.0, 1.0);
  const wave = sin(uv().y.add(p).mul(28.0))
    .mul(0.012).mul(uIntensity)
    .mul(sin(p.mul(3.14159265)));
  const a = uPrevious.sample(uv().add(vec2(wave, 0.0)));
  const b = uCurrent.sample(uv().sub(vec2(wave, 0.0)));
  return mix(a, b, smoothstep(0.0, 1.0, p));
};

export function createInstance({ root, width, height, sdk }) {
  // Uniforms are TSL uniform nodes, and `.value` assignment in render() below
  // works the same way a ShaderMaterial's uniforms do.
  const { uniform, texture } = sdk.TSL;
  const uniforms = {
    uPrevious: texture(null),
    uCurrent: texture(null),
    uProgress: uniform(0),
    uIntensity: uniform(1),
  };
  const material = createShaderMaterial({ fragment, uniforms });
  // Layer order: never set renderOrder on root/meshes, and keep mesh z within
  // ±0.05 of root — otherwise the transition draws above higher timeline
  // channels. createFullscreenPlane's default z (0.02) is already correct.
  const mesh = createFullscreenPlane(width, height, material);
  root.add(mesh);
  return {
    resize(size) { replacePlaneGeometry(mesh, size.width, size.height); },
    render({ progress, options, previous, current }) {
      if (!previous.texture || !current.texture) { mesh.visible = false; return; }
      previous.mesh.visible = false;
      current.mesh.visible = false;
      mesh.visible = true;
      uniforms.uPrevious.value = previous.texture;
      uniforms.uCurrent.value = current.texture;
      uniforms.uProgress.value = clamp01(progress);
      uniforms.uIntensity.value = Math.max(0, Number(options.intensity) || 0);
    },
    dispose() { mesh.geometry.dispose(); material.dispose(); },
  };
}

export default {
  id,
  name,
  renderer,
  defaultDuration,
  description: 'Package-owned TSL transition starter — WebGPU engine',
  optionDefaults,
  optionFields,
  createInstance,
};
