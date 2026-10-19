/*
 * Transition package SDK — v3.
 *
 * TWO ENGINES SHIP, AND A PACKAGE IS WRITTEN FOR ONE OF THEM. The app-wide
 * Video Editor setting chooses the classic WebGLRenderer with GLSL or the
 * WebGPURenderer with TSL nodes. Nothing
 * translates between them at runtime, and the mismatch is SILENT both ways — a
 * GLSL ShaderMaterial handed to WebGPURenderer does not throw, it draws nothing,
 * and a node material on the classic renderer draws nothing either. So a package
 * that picks the wrong one looks installed and renders blank; the authoring skill
 * (`skills/advanced-transitions`) makes choosing the engine step one and shows
 * the `renderer.isWebGPURenderer` guard that turns the blank frame into a
 * message.
 *
 * Hence one shading entry point per engine:
 *
 *   `createShaderMaterial({ fragment })` — TSL. `fragment` is a FUNCTION, not a
 *   string, called with the TSL namespace plus the package's own uniforms, and
 *   returning the node that becomes the fragment. That keeps a package's shading
 *   a first-class value the SDK can validate before anything reaches the GPU,
 *   instead of a string nobody can check until draw time — which is also why it
 *   REFUSES a `fragmentShader` string rather than passing GLSL to a backend that
 *   cannot compile it.
 *
 *   `createGlslMaterialForWebgl({ fragmentShader, uniforms })` — GLSL, for the
 *   classic engine, below.
 *
 * Both return a material whose `.uniforms.<name>.value` is written the same way,
 * so between two ports of one transition only the shader body differs.
 */
/*
 * WHICH THREE THE SDK HANDS OUT, AND WHY IT IS NOT FIXED AT IMPORT TIME.
 *
 * `three/webgpu` is a SECOND 1.9 MB copy of three, and importing it here put it
 * in the editor's chunk for everyone — including a WebGL-only project, which
 * cannot use a single line of it. So the base module speaks core three, and the
 * WebGPU build is installed over it by `transitionPackageSdkNodes.js` when the
 * app initialises that backend (materialFactory's initMaterialBackend).
 *
 * Swapped WHOLESALE rather than per-helper: on WebGPU every object this SDK
 * makes — planes, render targets, colours — must come from the same build the
 * node materials do, which is what shipped before this was made lazy. On WebGL
 * they now come from the same build as the renderer itself, which is the
 * pairing that was always meant.
 */
import * as coreTHREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { selectedBackend } from './videoRenderer.js';

export { EXRLoader, FontLoader, GLTFLoader, MTLLoader, OBJLoader, RGBELoader, TextGeometry };

export const RUNTIME_VERSION = 3;

/** The Three.js namespace packages get: core three, or the WebGPU build. */
export let THREE = coreTHREE;

/**
 * The TSL builders a package's `fragment` receives, or null on the classic
 * engine, where there is no such thing. Exported so a package can also import
 * them directly for helpers defined outside the fragment.
 */
export let TSL = null;

/**
 * Install the WebGPU half. Called by `transitionPackageSdkNodes.js`, which is
 * the module that carries the `three/webgpu` import — so nothing on the WebGL
 * path ever reaches it.
 */
export function installNodeSdk(impl) {
  THREE = impl.THREE;
  TSL = impl.TSL;
}

/** Restore the classic SDK after a complete WebGPU Player session is removed. */
export function resetNodeSdk() {
  THREE = coreTHREE;
  TSL = null;
}

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const clamp01 = (value) => clamp(value, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (edge0, edge1, value) => {
  const t = clamp01((value - edge0) / Math.max(1e-9, edge1 - edge0));
  return t * t * (3 - 2 * t);
};
export const hashNoise = (seed) => {
  const value = Math.sin(Number(seed) || 0) * 43758.5453123;
  return value - Math.floor(value);
};

export function createShaderMaterial({
  fragment,
  uniforms = {},
  transparent = true,
  depthTest = false,
  depthWrite = false,
  blending = THREE.NormalBlending,
  side = THREE.DoubleSide,
} = {}) {
  if (typeof fragment !== 'function') {
    throw new Error('createShaderMaterial requires a `fragment` function: ({ tsl, uniforms }) => node');
  }
  /*
   * SAY IT HERE, WHERE THE CAUSE IS. A node material on the classic renderer
   * draws nothing and reports nothing, so a package written for the wrong engine
   * is indistinguishable from a package with a bug in its maths. The engine is
   * known at this exact moment; nothing downstream ever gets a better chance to
   * name it.
   */
  if (!TSL) {
    if (selectedBackend() !== 'webgpu') {
      throw new Error('this package\'s shading is TSL, which only the WebGPU renderer builds — '
        + 'the app is using WebGL. Select WebGPU in App Settings, or use a '
        + 'package whose shading is GLSL.');
    }
    throw new Error('transition SDK: initMaterialBackend() must be awaited before a package builds TSL shading');
  }

  // Build EAGERLY so a broken package fails here, where the installer can report
  // it, rather than inside a deferred Fn() at draw time — losing a frame with no
  // indication which package caused it.
  let fragmentNode;
  try {
    fragmentNode = fragment({ tsl: TSL, uniforms, ...TSL, ...uniforms });
  } catch (err) {
    throw new Error(`transition package fragment failed to build: ${err.message}`);
  }
  if (fragmentNode === undefined || fragmentNode === null) {
    throw new Error('transition package fragment returned nothing — it must return a node');
  }

  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = fragmentNode;
  material.transparent = transparent;
  material.depthTest = depthTest;
  material.depthWrite = depthWrite;
  material.blending = blending;
  material.side = side;
  // ShaderMaterial forced this true and every NodeMaterial inherits false; a
  // transparent DoubleSide quad would otherwise be drawn back-then-front and
  // composited twice.
  material.forceSinglePass = true;
  material.uniforms = uniforms;
  return material;
}

/**
 * The GLSL side: a fullscreen ShaderMaterial for packages targeting the CLASSIC
 * engine, and what the app's own built-ins use whenever `materialFactory` hands
 * back no TSL twin (i.e. on WebGL).
 *
 * The name keeps saying `ForWebgl` because that is the whole contract — this
 * material draws on the classic renderer and nowhere else. It comes back
 * `transparent: false`, which suits a full-frame cross; a package drawing over
 * the frame sets `transparent` (and `premultipliedAlpha` for the premultiplied
 * layer plates) itself.
 */
export function createGlslMaterialForWebgl({ fragmentShader, uniforms = {} }) {
  // The mirror of the check in createShaderMaterial: GLSL handed to
  // WebGPURenderer does not throw on its own, it silently draws nothing.
  if (selectedBackend() === 'webgpu') {
    throw new Error('this package\'s shading is GLSL, which no WebGPU renderer compiles — '
      + 'the app is using WebGPU. Select WebGL in App Settings, or use a '
      + 'package whose shading is TSL.');
  }
  return new THREE.ShaderMaterial({
    vertexShader: `varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader,
    uniforms,
    transparent: false,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

export function createFullscreenPlane(width, height, material, z = 0.02) {
  const geometry = new THREE.PlaneGeometry(Math.max(1, width), Math.max(1, height));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.z = z;
  mesh.frustumCulled = false;
  return mesh;
}

export function replacePlaneGeometry(mesh, width, height) {
  if (!mesh) return;
  mesh.geometry?.dispose?.();
  mesh.geometry = new THREE.PlaneGeometry(Math.max(1, width), Math.max(1, height));
}

export function createRenderTarget(width, height, options = {}) {
  return new THREE.WebGLRenderTarget(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)), {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    ...options,
  });
}

export function resizeRenderTarget(target, width, height) {
  if (!target) return;
  const nextWidth = Math.max(1, Math.round(width));
  const nextHeight = Math.max(1, Math.round(height));
  if (target.width !== nextWidth || target.height !== nextHeight) target.setSize(nextWidth, nextHeight);
}

// Render an arbitrary package-owned scene/pass without leaking renderer state into
// the editor compositor. Packages may still use the raw renderer when they need it.
export function renderToTarget(renderer, {
  scene,
  camera,
  target = null,
  clear = true,
  clearColor = 0x000000,
  clearAlpha = 0,
} = {}) {
  if (!renderer || !scene || !camera) throw new Error('renderToTarget requires renderer, scene, and camera.');
  const previousTarget = renderer.getRenderTarget();
  const previousAutoClear = renderer.autoClear;
  const previousColor = renderer.getClearColor(new THREE.Color()).clone();
  const previousAlpha = renderer.getClearAlpha();
  try {
    renderer.setRenderTarget(target);
    renderer.autoClear = false;
    if (clear) {
      renderer.setClearColor(clearColor, clearAlpha);
      renderer.clear(true, true, true);
    }
    renderer.render(scene, camera);
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
    renderer.setClearColor(previousColor, previousAlpha);
  }
  return target?.texture || null;
}

export function setUniform(material, name, value) {
  const uniform = material?.uniforms?.[name];
  if (!uniform) return false;
  if (uniform.value?.copy && (value?.isVector2 || value?.isVector3 || value?.isVector4 || value?.isColor || value?.isMatrix3 || value?.isMatrix4)) {
    uniform.value.copy(value);
  } else {
    uniform.value = value;
  }
  return true;
}

export function disposeObject3D(root) {
  if (!root) return;
  root.traverse?.((object) => {
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material?.dispose?.();
  });
  root.clear?.();
}

export async function loadTextAsset(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Asset fetch failed (${response.status}): ${url}`);
  return response.text();
}

export async function loadBinaryAsset(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Asset fetch failed (${response.status}): ${url}`);
  return response.arrayBuffer();
}
