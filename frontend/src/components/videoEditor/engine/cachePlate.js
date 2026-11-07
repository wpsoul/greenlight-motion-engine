/*
 * The render cache's picture in the engine's page on a phone (./phoneMode.js): while a cached stretch plays, the frame is
 * the rendered file instead of the composite. The Player's own plate (Player.jsx rcPlate / rcFrameTexture), for the engine
 * without a Player: a muted <video> cued ~1 s ahead, its texture handed to frameRender.js; not ready = the frame is live.
 *
 * Engine fields used: rcPlate, isPlaying, exporting, exportActive, worldActive, fsQuadGeo, orthoCamera.
 */
import * as THREE from 'three';

export function createCachePlate(engine, cacheOf) {
  let lookedAt = 0;
  const plateOf = () => {
    if (engine.rcPlate) return engine.rcPlate;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const plate = { video, url: null, texture: null, mesh: null, scene: null, material: null };
    video.addEventListener('error', () => {
      const url = plate.url;
      plate.url = null;
      if (url) cacheOf()?.dropEntry(url);
    });
    engine.rcPlate = plate;
    return plate;
  };
  const cue = (plate, url, localTime) => {
    const video = plate.video;
    if (plate.url !== url) {
      plate.url = url;
      if (plate.texture) { try { plate.texture.dispose(); } catch { /* no-op */ } plate.texture = null; }
      video.src = url;
      try { video.currentTime = Math.max(0, localTime); } catch { /* not loaded yet: set on play */ }
      return;
    }
    if (!video.seeking && Math.abs(video.currentTime - localTime) > 0.04) {
      try { video.currentTime = Math.max(0, localTime); } catch { /* no-op */ }
    }
  };
  const stop = () => {
    const plate = engine.rcPlate;
    if (plate && !plate.video.paused) plate.video.pause();
  };
  // The cached frame for timeline time `t`, or null (= draw live).
  const frameTexture = (t) => {
    const rc = cacheOf();
    if (!rc || !engine.isPlaying || engine.exporting || engine.exportActive || engine.worldActive
      || !engine.fsQuadGeo || !engine.orthoCamera || !rc.hasEntries()) {
      stop();
      return null;
    }
    const hit = rc.entryAt(t);
    if (!hit) {
      stop();
      const now = performance.now();
      if (now - lookedAt > 200) {
        lookedAt = now;
        for (let dt = 0.1; dt <= 1.2001; dt += 0.1) {
          const ahead = rc.entryAt(t + dt);
          if (ahead) { cue(plateOf(), ahead.entry.url, ahead.localTime); break; }
        }
      }
      return null;
    }
    const plate = plateOf();
    const video = plate.video;
    if (plate.url !== hit.entry.url) { cue(plate, hit.entry.url, hit.localTime); return null; }
    if (video.seeking || video.readyState < 2) return null;
    if (Math.abs(video.currentTime - hit.localTime) > 0.15) {
      try { video.currentTime = Math.max(0, hit.localTime + (video.paused ? 0 : 0.05)); } catch { /* no-op */ }
      return null;
    }
    if (video.paused) video.play().catch(() => {});
    if (!plate.texture) {
      const texture = new THREE.VideoTexture(video);
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.colorSpace = THREE.NoColorSpace;   // byte pass-through like every layer plane
      plate.texture = texture;
    }
    return plate.texture;
  };
  const dispose = () => {
    const plate = engine.rcPlate;
    if (!plate) return;
    try { plate.video.pause(); plate.video.removeAttribute('src'); plate.video.load(); } catch { /* no-op */ }
    try { plate.texture?.dispose(); } catch { /* no-op */ }
    try { plate.material?.dispose(); } catch { /* no-op */ }
    engine.rcPlate = null;
  };
  return { frameTexture, stop, dispose };
}
