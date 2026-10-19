/*
 * Overlay-effect materials and the histogram probe (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 13 — moved
 * verbatim out of the Player, `xRef.current` → `engine.x`).
 *
 *   getEffectMaterial(engine, eff, pass, flips, variant)   the compiled material for one effect entry, cached
 *   captureFxProbe(engine, request, srcTarget)             serve the Extract panel's histogram request
 *
 * Engine fields: effectMaterials (key → { material, error, lastUsed }), effectMaterialSeq, fxProbeRT, and the
 * pipeline's renderer / orthoCamera / blitScene / blitMaterial.
 */
import * as THREE from 'three';
import { getAdjustmentEffect, createEffectMaterial, customEffectKey, validateCustomEffect } from '../adjustmentEffects';
import {
  createEffectMaterialForBackend, localEffectEngineReason, webGpuUnsupportedEffect, effectFlipCacheKey,
} from '../materialFactory';
import { readTargetPixels } from '../readTargetPixels';

// Resolve (and lazily compile + cache) the ShaderMaterial for an effect entry.
// Built-ins are cached by id; custom slots by a hash of their code. A custom
// slot that fails to compile is cached as an error and skipped (returns null)
// so a broken shader never blanks the frame or thrashes the compiler each frame.
export function getEffectMaterial(engine, eff, pass = 'main', flips = null, variant = '') {
  const def = getAdjustmentEffect(eff?.id);
  if (!def) return null;
  // An installed package whose shading has not loaded (or failed to) is skipped
  // like an absent effect; the registry listener below repaints when it lands.
  if (def.isLocal && !def.ready) return null;
  if (pass === 'pre' && (def.isCustom || !def.prePass)) return null;
  if (pass === 'pyramid' && (def.isCustom || !def.pyramidPass)) return null;
  const cache = engine.effectMaterials;
  const passSuffix = pass === 'main' ? '' : `:${pass}`;
  const flipSuffix = effectFlipCacheKey(flips);
  // A package's key carries its install revision: a re-imported package is new code.
  const baseKey = def.isCustom ? customEffectKey(eff.code) : def.isLocal ? `${def.id}@${def.rev}` : def.id;
  const key = baseKey + passSuffix + flipSuffix + (variant ? `|${variant}` : '');
  let entry = cache.get(key);
  if (!entry) {
    /*
     * ASK FOR EVERY EFFECT, NOT JUST CUSTOM ONES.
     *
     * This guard was written for the custom-GLSL case and wired only into that
     * branch, which left every OTHER unported effect throwing out of material
     * creation — and that throw is not contained: it unmounts the Player, so
     * the next render reports "Video render player is not ready" and the whole
     * editor is gone. One unported effect in a project meant no editor.
     *
     * Measured across the catalogue on WebGPU: 17 of 42 effects took the
     * editor down this way. With roughly half the catalogue still unported,
     * "this effect does not render yet" has to degrade to a skipped layer with
     * a reason, exactly as a broken custom shader already did.
     */
    const unsupported = localEffectEngineReason(def) || webGpuUnsupportedEffect(def);
    if (unsupported) {
      entry = { material: null, error: unsupported };
    } else if (def.isCustom) {
      const error = validateCustomEffect(eff.code);
      entry = error ? { material: null, error } : { material: createEffectMaterialForBackend(def, eff.code) ?? createEffectMaterial(def, eff.code), error: null };
    } else {
      entry = { material: createEffectMaterialForBackend(def, undefined, pass, flips) ?? createEffectMaterial(def, undefined, pass), error: null };
    }
    cache.set(key, entry);
    // Bound the cache: keep built-ins, evict the least-recently-used custom entry.
    if (cache.size > 32) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [k, v] of cache) {
        if (!k.startsWith('custom:')) continue;
        if ((v.lastUsed ?? 0) < oldest) { oldest = v.lastUsed ?? 0; oldestKey = k; }
      }
      if (oldestKey && oldestKey !== key) {
        try { cache.get(oldestKey).material?.dispose(); } catch { /* no-op */ }
        cache.delete(oldestKey);
      }
    }
  }
  entry.lastUsed = engine.effectMaterialSeq++;
  return entry.material;
}

/* Histogram probe (Extract). The panel arms a request through fxProbeBroker;
 * the chain serves it the next time it reaches that entry, by blitting the
 * effect's INPUT down to a small target and reading it back. Small on purpose:
 * a 192px-wide readback is ~110KB and stalls the pipeline for well under a
 * frame, where reading the full 1080p buffer would not. */
export function captureFxProbe(engine, request, srcTarget) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  const blitScene = engine.blitScene;
  const blitMaterial = engine.blitMaterial;
  if (!renderer || !orthoCamera || !blitScene || !blitMaterial || !srcTarget) return false;
  const width = Math.max(16, Math.min(320, Math.round(request.width || 192)));
  const height = Math.max(9, Math.round(width * (srcTarget.height / Math.max(1, srcTarget.width))));
  let target = engine.fxProbeRT;
  if (!target) {
    target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    engine.fxProbeRT = target;
  } else if (target.width !== width || target.height !== height) {
    target.setSize(width, height);
  }
  const prevTarget = renderer.getRenderTarget();
  blitMaterial.uniforms.uTexture.value = srcTarget.texture;
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(blitScene, orthoCamera);

  // ASYNC readback. `readRenderTargetPixels` is synchronous and does not exist on
  // WebGPURenderer at all, so this is one of the four sites that must be
  // restructured rather than ported (see html/webgpu-migration/PORT-PLAN.md §2).
  //
  // Two things must stay synchronous and do:
  //   - the blit above, which snapshots the effect's input while it still exists
  //     (`read` lives for microseconds inside runEffectChain);
  //   - restoring the previous render target, BEFORE any await — the caller is
  //     mid-frame and every later pass would otherwise draw into the probe RT.
  // The copy is enqueued at call time by both backends, so the pixels are the
  // ones from this frame even though they arrive later.
  //
  // A fresh buffer per request, not a shared scratch: with the read in flight, a
  // second request could otherwise overwrite the first one's pixels.
  renderer.setRenderTarget(prevTarget);
  // One shared readback for both backends (readTargetPixels): WebGPU returns the pixels through the promise, not
  // through a destination buffer.
  readTargetPixels(renderer, target, width, height)
    .then((data) => request.settle({ data, width, height }))
    .catch(() => request.settle(null));   // lost context / disposed target
  return true;
}
