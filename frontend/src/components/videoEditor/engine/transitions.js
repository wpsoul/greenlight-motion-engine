/*
 * The engine side of transitions (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 10 — moved verbatim out of
 * the Player, `xRef.current` → `engine.x`): the media a transition package plays (its own videos and pictures, kept
 * in step with the transition's progress and decoded into textures the package GLSL samples), and the render-target
 * banks that run a layer's overlay effects BEFORE a transition takes it.
 *
 *   ensureTransitionPackageMedia(cs, definition) / deactivateTransitionPackageMedia(cs)
 *   syncTransitionPackageMedia(engine, cs, preset, rawProgress, transitionDuration, { repaint })
 *       → a frozen map of the package's media this frame; `repaint` redraws when a source lands
 *   ensurePreTransitionFxTargets(engine, key, w, h, needPyramid) / releaseUnusedPreTransitionFxTargets(engine)
 *
 * Engine fields: exportActive, isPlaying, jumpHold, primeInFlight, preTransitionFxRT, preTransitionFxUsed.
 */
import * as THREE from 'three';
import { forgetPerfVideo } from '../perfRegistry.js';
import { transitionMediaVideoNeedsSeek } from '../advancedTransitions';
import { createVideoElement } from './previewMedia';
import { normalizeUrl, getImageTexture, getVideoTexture, ensureVideoFrameLoop } from './mediaTextures';

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

export function ensureTransitionPackageMedia(cs, definition) {
  let entry = cs.transitionPackageMedia.get(definition.id);
  if (entry && entry.type === definition.type) return entry;
  if (entry?.video) {
    forgetPerfVideo(entry.video);
    try { entry.video.pause(); entry.video.src = ''; entry.video.load(); } catch { /* no-op */ }
  }
  entry = {
    id: definition.id,
    type: definition.type,
    video: definition.type === 'video' ? createVideoElement(false) : null,
    source: '',
  };
  if (entry.video) entry.video.muted = true;
  cs.transitionPackageMedia.set(definition.id, entry);
  return entry;
}

export function deactivateTransitionPackageMedia(cs) {
  for (const entry of cs?.transitionPackageMedia?.values?.() || []) {
    if (entry.video?.src && !entry.video.paused) {
      try { entry.video.pause(); } catch { /* no-op */ }
    }
  }
}

export function syncTransitionPackageMedia(engine, cs, preset, rawProgress, transitionDuration, { repaint }) {
  const resolved = new Map();
  for (const definition of preset?.media || []) {
    if (!definition?.id || !definition.src) continue;
    const entry = ensureTransitionPackageMedia(cs, definition);
    let texture = null;
    if (definition.type === 'image') {
      texture = getImageTexture(engine, definition.src, repaint);
    } else if (definition.type === 'video') {
      const video = entry.video;
      if (normalizeUrl(entry.source) !== normalizeUrl(definition.src)) {
        try { video.pause(); } catch { /* no-op */ }
        video.src = definition.src;
        video.preload = 'auto';
        video.muted = true;
        video.load();
        video.addEventListener('loadeddata', repaint, { once: true });
        video.addEventListener('canplay', repaint, { once: true });
        entry.source = definition.src;
      }
      const trimStart = Math.max(0, finiteNumber(definition.trimStart, 0));
      const trimEnd = Number.isFinite(definition.trimEnd)
        ? Math.max(trimStart, definition.trimEnd)
        : (Number.isFinite(video.duration) ? video.duration : trimStart + Math.max(0.05, transitionDuration));
      const sourceTime = trimStart + Math.max(0, Math.min(1, rawProgress)) * Math.max(0.001, trimEnd - trimStart);
      if (!engine.exportActive) {
        if (transitionMediaVideoNeedsSeek(video.currentTime, sourceTime, engine.isPlaying)) {
          try { video.currentTime = sourceTime; } catch { /* metadata not ready */ }
        }
        if (engine.isPlaying && video.paused && !engine.jumpHold.active) {
          video.play().catch(() => {});
        } else if (!engine.isPlaying && video.readyState < 2 && !video.error && !engine.primeInFlight.has(video)) {
          engine.primeInFlight.add(video);
          video.play().then(() => {
            video.pause();
            engine.primeInFlight.delete(video);
            repaint();
          }).catch(() => engine.primeInFlight.delete(video));
        }
        ensureVideoFrameLoop(engine, video);
      }
      texture = getVideoTexture(engine, video);
    }
    const image = texture?.image;
    resolved.set(definition.id, Object.freeze({
      id: definition.id,
      type: definition.type,
      src: definition.src,
      texture,
      ready: !!texture,
      width: image?.videoWidth || image?.width || 0,
      height: image?.videoHeight || image?.height || 0,
      duration: entry.video?.duration || 0,
    }));
  }
  return Object.freeze({
    get: (id) => resolved.get(id) || null,
    has: (id) => resolved.has(id),
    values: () => resolved.values(),
    entries: () => resolved.entries(),
  });
}

export function ensurePreTransitionFxTargets(engine, key, w, h, needPyramid) {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  const make = () => new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  let bank = engine.preTransitionFxRT.get(key);
  if (!bank) {
    const scene = new THREE.Scene();
    const proxy = new THREE.Mesh();
    proxy.frustumCulled = false;
    scene.add(proxy);
    bank = {
      source: make(),
      a: make(),
      b: make(),
      c: make(),
      d: null,
      e: null,
      f: null,
      scene,
      proxy,
    };
    engine.preTransitionFxRT.set(key, bank);
  }
  if (needPyramid && !bank.d) {
    bank.d = make(); bank.e = make(); bank.f = make();
  }
  for (const targetKey of ['source', 'a', 'b', 'c', 'd', 'e', 'f']) {
    const target = bank[targetKey];
    if (target && (target.width !== width || target.height !== height)) target.setSize(width, height);
  }
  return bank;
}

export function releaseUnusedPreTransitionFxTargets(engine) {
  for (const [key, bank] of engine.preTransitionFxRT.entries()) {
    if (engine.preTransitionFxUsed.has(key)) continue;
    for (const targetKey of ['source', 'a', 'b', 'c', 'd', 'e', 'f']) {
      bank[targetKey]?.dispose();
    }
    bank.scene?.clear();
    engine.preTransitionFxRT.delete(key);
  }
}
