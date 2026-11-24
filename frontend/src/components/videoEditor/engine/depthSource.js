/*
 * Runtime depth texture resolver for browser WebGL/WebGPU render passes.
 * Bridges both per-frame stabilized `depthVideo` (MP4 decoded on its own
 * WebCodecs lane via motionVideo.js) AND single-frame `depthMap` (PNG texture),
 * returning `{ texture, size: [w, h], invert, nearM, farM, isVideo }` or null.
 *
 * Kept inside `engine/` so `depthMapEffect.js` stays leaf-clean and Node-testable.
 */
import * as THREE from 'three';
import { getDepthTexture, getItemDepthMap, getItemDepthVideo, resolveDepthMapParams } from '../depthMapEffect';
import { compTimeToSourceTime } from '../motionTracking';
import { requestVideoFrame, videoLaneFrameStamp } from '../motionTemplates/motionVideo';

const videoDepthTextures = new Map(); // lane -> { texture, canvas, stamp }

/** Dispose cached CanvasTextures owned by Video Depth lanes when the engine shuts down. */
export function clearVideoDepthTextures() {
  for (const entry of videoDepthTextures.values()) {
    try { entry.texture?.dispose(); } catch { /* ignore */ }
  }
  videoDepthTextures.clear();
}

export function resolveLayerDepthSource(item, entry, t) {
  if (!item) return null;
  const dmParams = resolveDepthMapParams(item);
  const dv = getItemDepthVideo(item);
  if (dv?.url) {
    const lane = `depthvid:${item.id}`;
    const tSource = entry ? compTimeToSourceTime(item, entry, t) : 0;
    const localTime = Math.max(0, tSource - (dv.startTime || 0));
    const canvas = requestVideoFrame(dv.url, localTime, lane);
    if (canvas) {
      const stamp = videoLaneFrameStamp(lane);
      let cached = videoDepthTextures.get(lane);
      if (!cached || cached.canvas !== canvas) {
        try { cached?.texture?.dispose(); } catch { /* ignore */ }
        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.generateMipmaps = false;
        texture.flipY = true;
        cached = { texture, canvas, stamp: null };
        videoDepthTextures.set(lane, cached);
      }
      if (cached.stamp !== stamp) {
        cached.stamp = stamp;
        cached.texture.needsUpdate = true;
      }
      return {
        texture: cached.texture,
        size: [dv.w || canvas.width || 384, dv.h || canvas.height || 216],
        invert: dmParams.dmInvert,
        nearM: dmParams.dmDepthNear,
        farM: dmParams.dmDepthFar,
        isVideo: true,
      };
    }
    // While the first decoded video frame is landing, fall back to a stored frozen map if present.
  }

  const map = getItemDepthMap(item);
  if (!map) return null;
  const texture = getDepthTexture(map);
  if (!texture) return null;
  return {
    texture,
    size: [map.w || 1, map.h || 1],
    invert: dmParams.dmInvert,
    nearM: dmParams.dmDepthNear,
    farM: dmParams.dmDepthFar,
    isVideo: false,
  };
}
