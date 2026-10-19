// Motion blur pipeline (see MOTION_BLUR_PLAN.md). EXPORT-ONLY: accumulation /
// multi-sample. Render N sub-frames across the shutter window and average them
// in linear space (the renderer's output color space is already linear).
// Physically correct for every motion source the deterministic frame renderer
// evaluates — keyframes, speed ramps, adjustment-layer zoom — and per-layer
// correct, unlike a full-screen velocity blur (a preview variant of which was
// tried and removed: it blurred the whole frame for one moving layer).
//
// This module is loaded lazily (dynamic import) ONLY when an export runs with
// the project's motion-blur switch on — otherwise nothing loads or allocates.
import * as THREE from 'three';
import { materials as makeMaterial } from './materialFactory';

export const MOTION_BLUR_SHUTTER = 180; // degrees — classic half-frame exposure
const ACCUM_BASE_SAMPLES = 32; // samples for a full 360° shutter → 16 at 180°

const fullscreenVertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Weighted add of one sub-frame into the accumulation target (blending: One/One).
const accumulateFragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform float uWeight;
void main() {
  gl_FragColor = texture2D(uTexture, vUv) * uWeight;
}
`;

const blitFragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTexture;
void main() {
  gl_FragColor = texture2D(uTexture, vUv);
}
`;

/**
 * `setOutputTarget(target)` is the seam the sub-frame renders go through: the
 * caller's frame renderer must draw its finished composite into `target` (a
 * render target) instead of the canvas, and back onto the canvas for `null`.
 * The accumulation then samples that target directly.
 *
 * It used to grab the finished CANVAS with
 * `copyFramebufferToTexture(new THREE.FramebufferTexture(w, h))`, which no
 * WebGPU renderer can do: with no render target bound there is no render
 * context to copy from and the call throws (see
 * html/webgpu-migration/PORTING-GUIDE.md §3.5). Rendering the sub-frame into a
 * bound target and sampling it is measured byte-identical to the copy, so this
 * is the same pipeline reached a different way, not a different pipeline.
 */
export function createMotionBlurPipeline(renderer, { setOutputTarget } = {}) {
  // The two materials come from the registry when a twin exists, and fall back
  // to the GLSL literals below otherwise. Written as `?? literal` rather than a
  // branch so the GLSL stays the readable default and the WebGPU path is the
  // exception — and so this file keeps working unchanged on WebGL.
  if (typeof setOutputTarget !== 'function') {
    throw new Error('createMotionBlurPipeline: setOutputTarget is required — sub-frames render into a target, not the canvas');
  }
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.PlaneGeometry(2, 2);

  const accumulateMaterial = makeMaterial.motionBlurAccumulate() || new THREE.ShaderMaterial({
    vertexShader: fullscreenVertexShader,
    fragmentShader: accumulateFragmentShader,
    uniforms: { uTexture: { value: null }, uWeight: { value: 1 } },
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
    depthTest: false,
    depthWrite: false,
  });
  const accumulateScene = new THREE.Scene();
  accumulateScene.add(new THREE.Mesh(quadGeo, accumulateMaterial));

  const blitMaterial = makeMaterial.motionBlurBlit() || new THREE.ShaderMaterial({
    vertexShader: fullscreenVertexShader,
    fragmentShader: blitFragmentShader,
    uniforms: { uTexture: { value: null } },
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
  const blitScene = new THREE.Scene();
  blitScene.add(new THREE.Mesh(quadGeo, blitMaterial));

  // Where each sub-frame lands. It stands in for the canvas, so it carries the
  // canvas's own 8-bit quantization — the frames this pipeline has always
  // averaged were 8-bit, and a HalfFloat target here would be a *better* filter
  // and a *different* one. Depth is on because a sub-frame is a full scene
  // render (3D layers depth-test against it); the canvas has one too.
  // Accumulation reads the composited frame through this target, so it works
  // identically for the single-pass path AND the adjustment-layer RTT path.
  let frameTarget = null;
  let accumTarget = null;
  const sizeVec = new THREE.Vector2();

  const ensureFrameTarget = (w, h) => {
    if (!frameTarget) {
      frameTarget = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false,
      });
    } else if (frameTarget.width !== w || frameTarget.height !== h) {
      frameTarget.setSize(w, h);
    }
    return frameTarget;
  };

  const ensureAccumTarget = (w, h) => {
    if (!accumTarget) {
      accumTarget = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType,
        depthBuffer: false,
        stencilBuffer: false,
      });
    } else if (accumTarget.width !== w || accumTarget.height !== h) {
      accumTarget.setSize(w, h);
    }
    return accumTarget;
  };

  return {
    renderer,

    /**
     * Export path: render `samples` sub-frames across the shutter window centered
     * on `time` via `renderOne(t)` (the player's deterministic renderFrameAtTime,
     * routed into the frame target by `setOutputTarget`) and leave their average
     * on the canvas. `maxTime` clamps sample times so the last frames of the
     * timeline don't average in black beyond-the-end renders.
     */
    async renderAccumulated(renderOne, time, { fps = 30, shutter = MOTION_BLUR_SHUTTER, samples = 0, maxTime = Infinity } = {}) {
      const clampedShutter = Math.max(45, Math.min(360, shutter));
      const windowSec = (clampedShutter / 360) / Math.max(1, fps);
      const n = Math.max(2, Math.min(32, Math.round(samples || (clampedShutter / 360) * ACCUM_BASE_SAMPLES)));

      renderer.getDrawingBufferSize(sizeVec);
      const w = Math.max(1, Math.round(sizeVec.x));
      const h = Math.max(1, Math.round(sizeVec.y));
      const frame = ensureFrameTarget(w, h);
      const accum = ensureAccumTarget(w, h);

      const prevAutoClear = renderer.autoClear;
      const prevTarget = renderer.getRenderTarget();
      const prevClearColor = renderer.getClearColor(new THREE.Color());
      const prevClearAlpha = renderer.getClearAlpha();
      try {
        renderer.setRenderTarget(accum);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, false, false);
        renderer.setClearColor(prevClearColor, prevClearAlpha);
        renderer.setRenderTarget(null);
        renderer.autoClear = prevAutoClear;

        accumulateMaterial.uniforms.uWeight.value = 1 / n;
        for (let i = 0; i < n; i += 1) {
          const sampleTime = Math.max(0, Math.min(maxTime, time - windowSec / 2 + (windowSec * (i + 0.5)) / n));
          // The sub-frame renders into `frame` instead of the canvas. Reset the
          // seam even if the render throws — with it left set, the next preview
          // frame would draw into this target and the canvas would freeze.
          setOutputTarget(frame);
          try {
            await renderOne(sampleTime);
          } finally {
            setOutputTarget(null);
          }
          accumulateMaterial.uniforms.uTexture.value = frame.texture;
          renderer.autoClear = false;
          renderer.setRenderTarget(accum);
          renderer.render(accumulateScene, camera);
          renderer.setRenderTarget(null);
          renderer.autoClear = prevAutoClear;
        }

        blitMaterial.uniforms.uTexture.value = accum.texture;
        renderer.autoClear = false;
        renderer.setRenderTarget(null);
        renderer.render(blitScene, camera);
      } finally {
        setOutputTarget(null);
        renderer.autoClear = prevAutoClear;
        renderer.setRenderTarget(prevTarget || null);
        renderer.setClearColor(prevClearColor, prevClearAlpha);
      }
    },

    dispose() {
      try { frameTarget?.dispose(); } catch { /* no-op */ }
      try { accumTarget?.dispose(); } catch { /* no-op */ }
      frameTarget = null;
      accumTarget = null;
      quadGeo.dispose();
      accumulateMaterial.dispose();
      blitMaterial.dispose();
    },
  };
}
