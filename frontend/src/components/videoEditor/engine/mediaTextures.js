/*
 * Media textures (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 6 — moved verbatim out of the Player,
 * `xRef.current` → `engine.x`): image textures and their in-flight loads, <video> textures with the
 * hold-the-last-good-frame gating, the requestVideoFrameCallback frame loop that says when a video has a fresh
 * frame, the presented/uploaded media times a source warp is sampled at, canvas textures (export decode canvases,
 * animated-image lanes), priming a prepared video's texture before a hard cut, and disposing a texture only once
 * nothing on screen still samples it.
 *
 * Engine fields used: imageTextureCache, imageTextureLoads, videoTextureCache, canvasTextureCache, pendingSeek,
 * awaitingFreshFrame, preparedVideoTexturePrime, videoFrameReady, rvfcLoop, presentedMediaTime,
 * uploadedMediaTime, pendingDisposal, isPlaying, channelStates, renderer.
 */
import * as THREE from 'three';
import { isWebmUrl } from '../webmFrameCache';
import { preparedVideoTexturePrimeState, shouldPrimePreparedVideoTexture } from '../previewMediaLifecycle';

export function normalizeUrl(url) {
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url || '';
  }
}

export function getClipPlaybackUrl(clip) {
  if (!clip) return '';
  if (clip.mediaType !== 'video') return clip.url || '';
  // WebM can carry an alpha channel, but its playback proxy is opaque H.264 MP4
  // (the transcode flattens transparency onto black). Play the ORIGINAL WebM so the
  // alpha reaches the VideoTexture; every other format keeps the smoother proxy.
  if (isWebmUrl(clip.url)) return clip.url || clip.proxyUrl || '';
  // PROXY badge toggle: the user opted this clip into full-res preview (a zoomed
  // proxy looks soft) — play the original despite the heavier decode.
  if (clip.previewOriginal) return clip.url || clip.proxyUrl || '';
  return clip.proxyUrl || clip.url || '';
}

export function getClipExportUrl(clip) {
  if (!clip) return '';
  return clip.mediaType === 'video' ? (clip.url || clip.proxyUrl || '') : (clip.url || '');
}

// Image textures still decoding (engine.imageTextureLoads). The preview repaints when one lands (`onLoad`), but a
// one-shot capture (captureFrameAtTime, the headless render-still) reads the canvas after a single render — an
// image layer whose texture had not arrived yet came out as a BLACK frame. Keyed like the cache; settled loads
// drop out.
export function getImageTexture(engine, url, onLoad) {
  if (!url) return null;
  const key = normalizeUrl(url);
  const cached = engine.imageTextureCache.get(key);
  if (cached) return cached;
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  let settle = null;
  engine.imageTextureLoads.set(key, new Promise((resolve) => { settle = resolve; }));
  const done = () => {
    engine.imageTextureLoads.delete(key);
    settle?.();
  };
  const texture = loader.load(key, () => {
    done();
    onLoad();
  }, undefined, done);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  engine.imageTextureCache.set(key, texture);
  return texture;
}

// Resolves once every in-flight image texture has landed (or failed), true if
// anything was actually waited for. Bounded: a stalled load must not hang a
// capture, it just captures without that layer.
export async function awaitImageTextures(engine, timeoutMs = 15000) {
  const pending = [...engine.imageTextureLoads.values()];
  if (!pending.length) return false;
  await Promise.race([
    Promise.all(pending),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return true;
}

// rVFC hands over the mediaTime of the frame it just presented. That timestamp —
// never `currentTime`, which a seek advances synchronously while the old picture
// is still on screen — is what a per-frame source warp has to be sampled at.
// Stamped against the source it came from so a landed seek on a NEW file cannot
// hand the previous clip's time to the next one.
export function recordPresentedMediaTime(engine, video, metadata) {
  if (!video || video.__decodeCanvas) return; // export decodes to a canvas; the element is not what is drawn
  const time = Number(metadata?.mediaTime);
  if (!Number.isFinite(time)) return;
  engine.presentedMediaTime.set(video, { time, src: video.currentSrc || video.src || '' });
}

// Called at the one moment the texture takes a new picture. Until then the
// shader is still sampling the previous frame, and so must the source warp.
export function promoteUploadedMediaTime(engine, video) {
  const presented = video ? engine.presentedMediaTime.get(video) : null;
  if (presented) engine.uploadedMediaTime.set(video, presented);
}

// Start (or keep) a self-perpetuating requestVideoFrameCallback loop that flags
// each freshly-decoded frame so getVideoTexture knows when to push it to the GPU.
// Critically this must run for ANY playing video — including a clip that was
// preloaded paused (allowPlayback:false) and only starts playing once it becomes
// the active clip at a shot boundary. Without it that video's VideoTexture never
// gets needsUpdate set and freezes on its first frame (the flashing/stuck frame).
export function ensureVideoFrameLoop(engine, video) {
  if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
  const existing = engine.rvfcLoop.get(video);
  if (existing && existing.live) return; // already looping
  // A fresh token identifies THIS loop; stale in-flight callbacks from a prior loop
  // see live=false and terminate, so we never accumulate duplicate loops.
  const token = { live: true };
  engine.rvfcLoop.set(video, token);
  const onFrame = (_now, metadata) => {
    if (!token.live) return;
    recordPresentedMediaTime(engine, video, metadata);
    engine.videoFrameReady.add(video);
    if (engine.isPlaying && video.src && !video.paused) {
      video.requestVideoFrameCallback(onFrame);
    } else {
      token.live = false; // loop ends; re-armed on next play
    }
  };
  video.requestVideoFrameCallback(onFrame);
}

// True while `texture` is still referenced by anything on screen (a mesh material
// or a channel's last-good backstop). Used to avoid disposing a texture out from
// under the renderer — which would draw a black/garbage frame at a shot boundary.
export function isTexturePinned(engine, texture) {
  if (!texture) return false;
  for (const cs of engine.channelStates.values()) {
    if (cs.currMaterial.uniforms.uTexture.value === texture) return true;
    if (cs.prevMaterial.uniforms.uTexture.value === texture) return true;
    if (cs.lastGoodTexture === texture) return true;
    for (const entry of cs.transitionPackageInstances?.values?.() || []) {
      let pinned = false;
      entry.root?.traverse?.((object) => {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          for (const uniform of Object.values(material?.uniforms || {})) {
            if (uniform?.value === texture) pinned = true;
          }
        }
      });
      if (pinned) return true;
    }
  }
  return false;
}

// Dispose a texture now if it's safe; otherwise defer until it's no longer on
// screen (swept each frame in renderFrame). Keeps memory bounded without ever
// disposing a currently-displayed frame.
export function queueTextureDisposal(engine, texture) {
  if (!texture) return;
  if (isTexturePinned(engine, texture)) {
    engine.pendingDisposal.add(texture);
  } else {
    try { texture.dispose(); } catch { /* no-op */ }
  }
}

export function textureFromCanvas(engine, cnv) {
  let entry = engine.canvasTextureCache.get(cnv);
  if (!entry) {
    const texture = new THREE.CanvasTexture(cnv);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    entry = { texture };
    engine.canvasTextureCache.set(cnv, entry);
  }
  entry.texture.needsUpdate = true;
  return entry.texture;
}

// An animated image's lane canvas only changes when the file advances to a NEW
// frame, which is far rarer than once per rendered frame — a 10fps GIF on a 60fps
// timeline changes on one frame in six. `revision` is what makes that cheap:
// flagging needsUpdate unconditionally (what textureFromCanvas does, correctly,
// for a video that really does have a new frame each time) would re-upload the
// whole picture 60 times a second to show the same six.
export function animatedFrameTexture(engine, lane) {
  let entry = engine.canvasTextureCache.get(lane.canvas);
  if (!entry) {
    const texture = new THREE.CanvasTexture(lane.canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    entry = { texture, revision: -1 };
    engine.canvasTextureCache.set(lane.canvas, entry);
  }
  if (entry.revision !== lane.revision) {
    entry.texture.needsUpdate = true;
    entry.revision = lane.revision;
  }
  return entry.texture;
}

// `holdKey` (Posterize Time while playing): while it is unchanged the texture keeps
// the frame it already shows. The decoded-frame flag is left set, so the step that
// changes the key uploads the newest frame at once. null = no hold (every caller
// but a playing posterized layer).
export function getVideoTexture(engine, video, holdKey = null) {
  // Fast export path: this clip's frame was decoded (WebCodecs / WebM cache) onto
  // an offscreen canvas, not seeked into the <video>. Sample that canvas instead.
  if (video?.__decodeCanvas) return textureFromCanvas(engine, video.__decodeCanvas);
  if (!video?.src) return null;
  const source = normalizeUrl(video.src);
  const cached = engine.videoTextureCache.get(video);
  const seekPending = engine.pendingSeek.has(video) || video.seeking;
  const awaitingFreshFrame = engine.awaitingFreshFrame.has(video);

  if (cached && cached.src === source) {
    // During seeks: return the last good frame WITHOUT updating the texture.
    // This keeps the previous frame visible instead of flashing black/placeholder.
    if (seekPending || awaitingFreshFrame || video.readyState < 2) {
      return cached.hadFrame ? cached.texture : null;
    }
    if (holdKey !== null && cached.hadFrame && cached.holdKey === holdKey) return cached.texture;
    // Use RVFC frame-ready signal when available for precise texture updates
    if (engine.videoFrameReady.has(video)) {
      cached.texture.needsUpdate = true;
      cached.hadFrame = true;
      cached.holdKey = holdKey;
      engine.videoFrameReady.delete(video);
      promoteUploadedMediaTime(engine, video);
    } else if (typeof video.requestVideoFrameCallback !== 'function') {
      // Fallback: always update when RVFC not supported
      cached.texture.needsUpdate = true;
      cached.hadFrame = true;
      cached.holdKey = holdKey;
      promoteUploadedMediaTime(engine, video);
    }
    return cached.texture;
  }

  // Source changed — keep old texture alive until new one is ready to prevent flash
  if (cached) {
    if (seekPending || awaitingFreshFrame || video.readyState < 2) {
      // Return stale texture from old source while new source loads
      return cached.hadFrame ? cached.texture : null;
    }
    queueTextureDisposal(engine, cached.texture);
    engine.videoTextureCache.delete(video);
  }

  if (seekPending || awaitingFreshFrame || video.readyState < 2) return null;

  const texture = new THREE.VideoTexture(video);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  // VideoTexture's constructor arms its own self-perpetuating rVFC loop that
  // marks EVERY presented frame dirty — including mid-seek frames and frames of
  // a source this buffer was re-pointed to while its texture is still on screen.
  // That silently bypasses all of the hold-last-good-frame gating above and is
  // one source of wrong-frame flashes at shot boundaries. For gated clip buffers
  // the app's own frame flags decide when to upload (same cancel as dispose()).
  //
  // LOAD-BEARING ON BOTH BACKENDS — measured, not assumed. Pair 16 A1/A1neg ran
  // this gate on WebGPU: 109 renders of a playing, still-decoding video produced
  // exactly ONE GPU frame with the gate closed, and five with the cancel removed.
  // The loop lives in three.core.js, not in either backend, so this cancel is
  // exactly as necessary on WebGPU as on WebGL. Do not drop it in a port.
  if (video.__gatedTextureUpdates
    && texture._requestVideoFrameCallbackId
    && typeof video.cancelVideoFrameCallback === 'function') {
    video.cancelVideoFrameCallback(texture._requestVideoFrameCallbackId);
    texture._requestVideoFrameCallbackId = 0;
  }
  texture.needsUpdate = true;
  promoteUploadedMediaTime(engine, video);
  engine.videoTextureCache.set(video, { src: source, texture, hadFrame: true });
  return texture;
}

// Loading and seeking the inactive <video> decodes its first frame, but Three.js
// normally waits until that texture is visible before allocating/uploading it on
// the GPU. On a hard cut that upload can consume the first displayed frame; a tiny
// fade masks it because both meshes render beforehand. Prime the prepared texture
// explicitly so a zero-duration cut gets the same warm path without changing the
// edit or blending the shots.
export function primePreparedVideoTexture(engine, video, clip, targetTime, projectFps) {
  const texture = getVideoTexture(engine, video);
  const source = normalizeUrl(getClipPlaybackUrl(clip));
  const cached = engine.videoTextureCache.get(video);
  const ready = !!(
    texture
    && cached?.texture === texture
    && cached.src === source
    && cached.hadFrame
    && video.readyState >= 2
    && !video.seeking
    && !engine.pendingSeek.has(video)
    && !engine.awaitingFreshFrame.has(video)
  );
  const previous = engine.preparedVideoTexturePrime.get(video) || null;
  if (!shouldPrimePreparedVideoTexture({
    previous,
    texture,
    source,
    targetTime,
    fps: projectFps,
    ready,
  })) return false;

  try {
    texture.needsUpdate = true;
    engine.renderer?.initTexture?.(texture);
    engine.preparedVideoTexturePrime.set(video, preparedVideoTexturePrimeState({
      texture,
      source,
      targetTime,
      fps: projectFps,
    }));
    return true;
  } catch {
    // A lost/not-yet-created WebGL context can recover on a later preview frame.
    return false;
  }
}
