/*
 * The project background (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 4 — moved verbatim out of the
 * Player, `xRef.current` → `engine.x`).
 *
 * The backgroundConfig rasterizes into a canvas used as scene.background, so it renders behind every channel
 * plane — in preview, WebCodecs export, and the headless render route alike. Async assets (image / gradient
 * raster) repaint once decoded via the shared cache. Animated backgrounds (shaders / animated gradients) are
 * repainted each frame from the playhead time, so they work in preview and deterministic export.
 *
 *   setEngineBackground(engine, background, { width, height, onPaint })  → cancel(); onPaint after every paint
 *   repaintAnimatedBackground(engine)   per composited frame, before compositing
 *   disposeBackgroundShader(engine)     with the pipeline: this engine's private shader-background GL renderer
 */
import * as THREE from 'three';
import { backgroundTextureNode } from '../materialFactory';
import { getMotionImage } from '../motionTemplates/mtl';
import { drawEditorBackground, collectBackgroundUrls, isTransparentBackground, isAnimatedBackground } from '../backgroundLayer';
import { disposeShaderRenderer } from '../../../utils/shaderBackground';

// Shader backgrounds are rendered by a module-global GL renderer cache keyed by a usage tag. A shared tag means
// two engines — the outgoing board's and the incoming one's, briefly alive together — fight over one renderer,
// and the previous board's shader can end up blitted into the new board's background. Each engine gets its own
// key, disposed with the rest of its GL state.
let engineShaderSeq = 0;

export function backgroundShaderKey(engine) {
  if (!engine.backgroundShaderKey) engine.backgroundShaderKey = `editor-bg-${engineShaderSeq++}`;
  return engine.backgroundShaderKey;
}

export function setEngineBackground(engine, background, { width, height, onPaint }) {
  engine.background = background;
  const scene = engine.scene;
  if (!scene) return undefined;
  if (isTransparentBackground(background)) {
    if (scene.background) { try { scene.background.dispose(); } catch { /* no-op */ } }
    scene.background = null;
    scene.backgroundNode = null;
    engine.backgroundTexSize = null;
    onPaint?.();
    return undefined;
  }
  let cancelled = false;
  if (!engine.backgroundCanvas) engine.backgroundCanvas = document.createElement('canvas');
  const canvas = engine.backgroundCanvas;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const paint = () => {
    const complete = drawEditorBackground(ctx, width, height, background, engine.currentTime, { shaderKey: backgroundShaderKey(engine) });
    // A CanvasTexture allocates immutable GL storage (texStorage2D) at the size
    // of its first upload and only texSubImage2D's after that — so once the
    // rasterization canvas is resized (a project with a different videoSize,
    // e.g. switching boards) `needsUpdate` alone silently keeps the OLD pixels
    // (bigger canvas) or pastes the new frame into a corner of the old texture
    // (smaller canvas). Reuse only while the size still matches.
    const texSize = engine.backgroundTexSize;
    if (scene.background && scene.background.image === canvas
      && texSize && texSize.w === canvas.width && texSize.h === canvas.height) {
      scene.background.needsUpdate = true;
    } else {
      if (scene.background) { try { scene.background.dispose(); } catch { /* no-op */ } }
      const tex = new THREE.CanvasTexture(canvas);
      // The whole compositor is a byte-pass-through pipeline (outputColorSpace is
      // LinearSRGB, so nothing is encoded on the way out). Tagging this texture
      // SRGB makes three's background pass DECODE it to linear and then emit that
      // undecoded — the stage renders darker than the picked colour while every
      // layer plane (untagged) comes out exact. NoColorSpace keeps it byte-exact.
      tex.colorSpace = THREE.NoColorSpace;
      // Every project background (solid / gradient / pattern / image / shader) is
      // this one canvas → CanvasTexture → scene.background. WebGPU's default
      // background node samples with `screenUV.flipY()` assuming an upload flip
      // that does not land the same way as WebGL's UNPACK_FLIP_Y for canvases, so
      // the whole plate mirrors. Skip the upload flip and sample with plain
      // screenUV so canvas top stays screen top.
      const backgroundNode = backgroundTextureNode(tex);
      if (backgroundNode) tex.flipY = false;
      scene.backgroundNode = backgroundNode;
      scene.background = tex;
      engine.backgroundTexSize = { w: canvas.width, h: canvas.height };
    }
    onPaint?.();
    return complete;
  };
  if (!paint()) {
    Promise.all(collectBackgroundUrls(background, width, height).map((u) => getMotionImage(u).ready))
      .then(() => { if (!cancelled) paint(); });
  }
  return () => { cancelled = true; };
}

export function repaintAnimatedBackground(engine) {
  const bgCanvas = engine.backgroundCanvas;
  const scene = engine.scene;
  if (bgCanvas && scene.background && isAnimatedBackground(engine.background)) {
    drawEditorBackground(bgCanvas.getContext('2d'), bgCanvas.width, bgCanvas.height, engine.background, engine.currentTime, { shaderKey: backgroundShaderKey(engine) });
    scene.background.needsUpdate = true;
  }
}

export function disposeBackgroundShader(engine) {
  if (!engine.backgroundShaderKey) return;
  try { disposeShaderRenderer(engine.backgroundShaderKey); } catch { /* no-op */ }
}
