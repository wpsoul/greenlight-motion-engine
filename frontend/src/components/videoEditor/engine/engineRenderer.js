/*
 * The engine's renderer, scene and camera (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 2).
 *
 * Moved out of the Player's renderer effect: creating the backend renderer (videoRenderer.js — WebGL or
 * WebGPU, the adapter probe and the shared settings live there), the readiness gate every first paint waits
 * on, the main scene and the main camera, and the watchers for a lost GPU: `webglcontextlost` /
 * `webglcontextrestored` on the canvas, and the WebGPU device's `lost` promise (which raises no canvas
 * event — without it the editor would just stop painting, with nothing in the console).
 *
 * What the APP does about those events stays with the caller, as callbacks: the Player shows its error
 * text, repaints, re-bakes model environments, rebuilds the pipeline. `onReady` / `onError` / the device
 * watch fire only while this renderer is live, so a renderer replaced by a rebuild can't report into the
 * new one.
 *
 *   createEngineRenderer(engine, { canvas, backend, width, height, fov, distance, onReady, onError,
 *                                  onContextLost, onContextRestored, onDeviceLost, beforeListen })
 *   stopEngineRenderer(engine)      first thing in a teardown: nothing of this renderer reports any more
 *   disposeEngineRenderer(engine)   last thing in a teardown: listeners off, renderer disposed, fields cleared
 */
import * as THREE from 'three';
import { createVideoRenderer } from '../videoRenderer';

export function createEngineRenderer(engine, {
  canvas, backend, width, height, fov, distance,
  onReady, onError, onContextLost, onContextRestored, onDeviceLost, beforeListen,
}) {
  const { renderer, ready } = createVideoRenderer({ canvas, backend, width, height });
  // Everything after this only BUILDS things (scenes, materials, targets); nothing paints until
  // renderFrame runs, and that is gated on readiness. So setup stays synchronous on both backends and
  // only the first paint waits.
  engine.rendererReady = false;
  const session = { live: true, deviceLossWatched: true, canvas, onContextLost, onContextRestored };
  engine.rendererSession = session;
  // The node modules load alongside the renderer. On WebGL this resolves immediately (those materials are
  // statically imported), so the only path it actually gates is WebGPU — where creating a material before
  // the modules land throws loudly rather than drawing nothing.
  ready.then(() => {
    if (!session.live) return;
    engine.rendererReady = true;
    onReady?.();
  }).catch((err) => {
    if (!session.live) return;
    onError?.(err);
  });

  beforeListen?.();
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);
  // `reason === 'destroyed'` is our own teardown calling renderer.dispose(), not a fault — rebuilding on
  // that would loop.
  Promise.resolve(ready).then(() => {
    const device = renderer.backend?.device;
    if (!session.deviceLossWatched || !device?.lost) return;
    device.lost.then((info) => {
      if (!session.deviceLossWatched) return;
      if (info?.reason === 'destroyed') return;
      onDeviceLost?.(info);
    });
  }).catch(() => { /* the ready path already reports its own failure */ });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, width / height, 1, 100000);
  camera.position.set(0, 0, distance);
  camera.lookAt(0, 0, 0);

  engine.renderer = renderer;
  engine.scene = scene;
  engine.camera = camera;
  return { renderer, scene, camera };
}

export function stopEngineRenderer(engine) {
  const session = engine.rendererSession;
  if (session) session.live = false;
  engine.rendererReady = false;
}

export function disposeEngineRenderer(engine) {
  const session = engine.rendererSession;
  engine.rendererSession = null;
  if (session) {
    session.deviceLossWatched = false;
    session.canvas.removeEventListener('webglcontextlost', session.onContextLost);
    session.canvas.removeEventListener('webglcontextrestored', session.onContextRestored);
  }
  engine.renderer?.dispose();
  engine.renderer = null;
  engine.scene = null;
  engine.camera = null;
}
