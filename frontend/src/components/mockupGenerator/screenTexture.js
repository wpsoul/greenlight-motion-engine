import { createContext, createElement, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useLoader } from '@react-three/fiber';

export const DEFAULT_IMAGE = "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=2564&auto=format&fit=crop";
// The image slot of a VIDEO screen (the hooks are unconditional) and the aspect
// probe of one: a 1×1 inline pixel, never the remote DEFAULT_IMAGE — a video
// mockup's scene (and the headless render waiting on it) must not hang on a
// third-party fetch it never shows.
const VIDEO_SLOT_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAABAAAAAQBPJcTWAAAADElEQVR4nGOQktQDAACyAGKaaUOlAAAAAElFTkSuQmCC';
export const ScreenPlaybackContext = createContext(null);
// { reportPending(delta), reportTiming(message) } channel for grid cells. Grid
// cells suspend behind per-cell fallbacks (so one slow image can't blank the
// whole scene), which hides their loads from the scene-level Suspense beacon —
// the surface combines the pending count with that beacon for render readiness,
// and reportTiming surfaces slow-load phase breakdowns in the builder UI.
export const GridLoadContext = createContext(null);

function createMissingTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, 2, 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.userData.missing = true;
  return texture;
}

// TextureLoader that never rejects: a missing/broken image resolves to a dark
// placeholder texture instead of throwing through suspense to the app error
// boundary (boards can reference media that was later deleted).
export class SafeTextureLoader extends THREE.TextureLoader {
  load(url, onLoad, onProgress) {
    return super.load(url, onLoad, onProgress, () => {
      console.warn(`Mockup texture missing, using placeholder: ${url}`);
      onLoad?.(createMissingTexture());
    });
  }
}

export function ScreenPlaybackProvider({ value, children }) {
  return createElement(ScreenPlaybackContext.Provider, { value }, children);
}

function createFallbackTexture(texture) {
  const fallback = texture.clone();
  fallback.colorSpace = THREE.SRGBColorSpace;
  fallback.needsUpdate = true;
  return fallback;
}

export function createCanvasSurface(screenAspect, resolutionScale = 1) {
  const canvas = document.createElement('canvas');
  const baseHeight = Math.min(4096, Math.max(1024, Math.round(2048 * resolutionScale)));
  const baseWidth = Math.max(1, Math.round(baseHeight * screenAspect));
  canvas.width = baseWidth;
  canvas.height = baseHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  return { canvas, ctx, texture };
}

function roundedRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/* Animated scroll: Offset X/Y are the resting position, the scroll adds speed × time
   (fraction of the screen per second). + X moves the artwork LEFT (scrolling right),
   + Y moves it UP (scrolling down a page). `wrap` tiles the artwork so the scroll
   never runs off into a blank screen. */
export function isScreenScrolling(screenOptions) {
  return Boolean(screenOptions && (screenOptions.scrollX || screenOptions.scrollY));
}

export function scrolledScreenOffset(screenOptions = {}, time = 0) {
  const { offsetX = 0, offsetY = 0, scrollX = false, scrollY = false, scrollXSpeed = 0, scrollYSpeed = 0 } = screenOptions;
  const t = Number.isFinite(time) ? time : 0;
  return {
    offsetX: offsetX - (scrollX ? scrollXSpeed * t : 0),
    offsetY: offsetY - (scrollY ? scrollYSpeed * t : 0),
  };
}

export function drawMediaToCanvas(ctx, canvas, media, screenOptions = {}, time = 0) {
  const { scale = 1, rotation = 0, padding = 0, fitMode = 'cover', borderRadius = 0, wrap = false } = screenOptions;
  const { offsetX, offsetY } = scrolledScreenOffset(screenOptions, time);
  const mediaWidth = media?.videoWidth || media?.naturalWidth || media?.width || 0;
  const mediaHeight = media?.videoHeight || media?.naturalHeight || media?.height || 0;

  if (!mediaWidth || !mediaHeight) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const padX = padding * canvas.width;
  const padY = padding * canvas.height;
  const areaW = canvas.width - padX * 2;
  const areaH = canvas.height - padY * 2;

  const coverScale = fitMode === 'contain'
    ? Math.min(areaW / mediaWidth, areaH / mediaHeight)
    : Math.max(areaW / mediaWidth, areaH / mediaHeight);
  const drawScale = coverScale * scale;
  const drawWidth = mediaWidth * drawScale;
  const drawHeight = mediaHeight * drawScale;
  const offsetPxX = offsetX * canvas.width;
  const offsetPxY = offsetY * canvas.height;
  const rotationRad = rotation * (Math.PI / 180);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();

  // Apply clipping for padding and/or border radius
  if (padding > 0 || borderRadius > 0) {
    const clipR = borderRadius * Math.min(areaW, areaH) / 2;
    roundedRectPath(ctx, padX, padY, areaW, areaH, clipR);
    ctx.clip();
  }

  ctx.translate(canvas.width / 2 + offsetPxX, canvas.height / 2 + offsetPxY);
  ctx.rotate(rotationRad);
  if (wrap && drawWidth > 0 && drawHeight > 0) {
    // Tile around the copy that holds the canvas centre. The centre sits at
    // (-offset) in canvas space; rotate it into media space to pick the index
    // range, and cover a full diagonal either way so rotation never shows a gap.
    const cos = Math.cos(rotationRad);
    const sin = Math.sin(rotationRad);
    const cxM = (-offsetPxX) * cos + (-offsetPxY) * sin;
    const cyM = -(-offsetPxX) * sin + (-offsetPxY) * cos;
    const half = Math.hypot(canvas.width, canvas.height) / 2;
    const i0 = Math.floor((cxM - half) / drawWidth - 0.5);
    const i1 = Math.ceil((cxM + half) / drawWidth + 0.5);
    const j0 = Math.floor((cyM - half) / drawHeight - 0.5);
    const j1 = Math.ceil((cyM + half) / drawHeight + 0.5);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        ctx.drawImage(media, i * drawWidth - drawWidth / 2, j * drawHeight - drawHeight / 2, drawWidth, drawHeight);
      }
    }
  } else {
    ctx.drawImage(media, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  }
  ctx.restore();
}

// Every wait on the screen video is bounded and names its stage, so an export
// fails with "Screen video seek to 2.50s timed out" instead of hanging. The seek
// budget stays under the exporter's 15 s per-frame watchdog so the specific
// error, not a generic stall, is what surfaces.
const SCREEN_VIDEO_LOAD_TIMEOUT_MS = 20000;
const SCREEN_VIDEO_SEEK_TIMEOUT_MS = 10000;
// Chromium truncates currentTime to whole microseconds while the demuxer rounds
// frame timestamps, so a seek to an exact frame boundary (4/60 s over a 30 fps
// clip) landed on the PREVIOUS frame — a judder every few frames of an export.
// A 0.1 ms nudge is far below any frame duration.
const SEEK_BOUNDARY_NUDGE_S = 1e-4;

function describeMediaError(video) {
  const error = video.error;
  if (!error) return 'unknown error';
  return `media error ${error.code}${error.message ? `: ${error.message}` : ''}`;
}

// A wait also settles when its element is disposed under it (src removed →
// `emptied`): no `loadeddata` or `seeked` will ever follow, and sitting out the
// timeout failed the frame although the replacement element was loading fine.
// The caller sees the element is no longer current and syncs the new one.
function waitForVideoEvent(video, eventName, timeoutMs, stage) {
  return new Promise((resolve, reject) => {
    let timer = 0;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(eventName, onSuccess);
      video.removeEventListener('error', onError);
      video.removeEventListener('emptied', onEmptied);
    };
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Screen video ${stage} failed (${describeMediaError(video)})`));
    };
    // ensureVideoReady's own load() empties the element too, src still set.
    const onEmptied = () => {
      if (video.hasAttribute('src')) return;
      cleanup();
      resolve();
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Screen video ${stage} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    video.addEventListener(eventName, onSuccess, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.addEventListener('emptied', onEmptied);
  });
}

async function ensureVideoReady(video) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const loaded = waitForVideoEvent(video, 'loadeddata', SCREEN_VIDEO_LOAD_TIMEOUT_MS, 'load');
  // Restart only an element that is not already fetching (never started, or
  // failed): reloading one mid-fetch just throws away what it has buffered.
  if (video.readyState === HTMLMediaElement.HAVE_NOTHING && video.networkState !== HTMLMediaElement.NETWORK_LOADING) {
    video.load();
  }
  await loaded;
}

function normalizeLoopTime(video, time) {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (duration <= 0) return Math.max(0, time);
  if (duration <= 0.05) return 0;
  const wrapped = time % duration;
  return Math.min(wrapped < 0 ? wrapped + duration : wrapped, duration - 0.01);
}

// `seeked` is the completion signal: the paused element already holds the landed
// frame (measured on Chromium 151 / Chrome 155 — the frame drawn at `seeked` was
// the target every time). requestVideoFrameCallback is NOT one: it reports
// presentations, and an element that is neither in the document nor playing
// presents rarely — never when the seek lands on the frame already shown, which
// is every other frame of a 60 fps export over a 30 fps clip. Waiting on it hung
// each of those frames until the exporter's watchdog gave up.
async function seekVideoToTime(video, time) {
  const targetTime = normalizeLoopTime(video, time);
  if (Math.abs((video.currentTime || 0) - targetTime) < 1 / 120 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }

  const seeked = waitForVideoEvent(video, 'seeked', SCREEN_VIDEO_SEEK_TIMEOUT_MS, `seek to ${targetTime.toFixed(2)}s`);
  video.currentTime = targetTime + SEEK_BOUNDARY_NUDGE_S;
  await seeked;
}

function useImageScreenTexture(imageSrc, screenOptions = {}, screenAspect = 0.47) {
  const texture = useLoader(SafeTextureLoader, imageSrc || DEFAULT_IMAGE);
  const playback = useContext(ScreenPlaybackContext);
  const {
    scale = 1, offsetX = 0, offsetY = 0, rotation = 0, padding = 0, fitMode = 'cover', borderRadius = 0,
    scrollX = false, scrollY = false, scrollXSpeed = 0, scrollYSpeed = 0, wrap = false,
  } = screenOptions;
  const resolutionScale = playback?.resolutionScale ?? 1;
  const drawOptions = useMemo(
    () => ({ scale, offsetX, offsetY, rotation, padding, fitMode, borderRadius, scrollX, scrollY, scrollXSpeed, scrollYSpeed, wrap }),
    [scale, offsetX, offsetY, rotation, padding, fitMode, borderRadius, scrollX, scrollY, scrollXSpeed, scrollYSpeed, wrap],
  );
  const optionsRef = useRef(drawOptions);
  const surfaceRef = useRef(null);
  const lastTimeRef = useRef(null);
  const scrolling = isScreenScrolling(drawOptions);

  const result = useMemo(() => {
    const img = texture.image;
    if (!img || !img.width || !img.height || typeof document === 'undefined') {
      return { texture: createFallbackTexture(texture), surface: null, img: null };
    }

    const surface = createCanvasSurface(screenAspect, resolutionScale);
    if (!surface) {
      return { texture: createFallbackTexture(texture), surface: null, img: null };
    }

    const time = typeof playback?.getTime === 'function' ? playback.getTime() : 0;
    drawMediaToCanvas(surface.ctx, surface.canvas, img, drawOptions, time);
    surface.texture.needsUpdate = true;
    return { texture: surface.texture, surface, img };
  }, [texture, drawOptions, screenAspect, resolutionScale, playback]);
  useEffect(() => {
    optionsRef.current = drawOptions;
    surfaceRef.current = result;
    lastTimeRef.current = null;
  });

  // A scrolling still is redrawn as time moves: every frame in the live preview,
  // and on demand (syncToTime) while an export drives the clock.
  useFrame(() => {
    if (!scrolling) return;
    if (playback?.mode === 'controlled') return;
    const cur = surfaceRef.current;
    if (!cur?.surface || !cur.img) return;
    const time = typeof playback?.getTime === 'function' ? playback.getTime() : 0;
    if (lastTimeRef.current === time) return;
    lastTimeRef.current = time;
    drawMediaToCanvas(cur.surface.ctx, cur.surface.canvas, cur.img, optionsRef.current, time);
    cur.surface.texture.needsUpdate = true;
  });

  useEffect(() => {
    if (!scrolling || !playback?.registerController) return undefined;
    const controller = {
      syncToTime: async (time) => {
        const cur = surfaceRef.current;
        if (!cur?.surface || !cur.img) return;
        drawMediaToCanvas(cur.surface.ctx, cur.surface.canvas, cur.img, optionsRef.current, time);
        cur.surface.texture.needsUpdate = true;
      },
    };
    return playback.registerController(controller);
  }, [playback, scrolling]);

  return result.texture;
}

// The <video> lives as long as its source; the canvas it is drawn into is sized
// by the render resolution and swaps on its own. They used to share one effect,
// so entering an export (resolutionScale 1 → 1.5/2) — and every captureFramePng,
// which enters and leaves controlled mode — threw the loaded video away while a
// sync was seeking it: the seek waited forever on an emptied element. Changing any
// screen option did the same in the builder, and the live loop kept drawing the
// disposed element, so the screen went blank.
function useVideoScreenTexture(videoSrc, screenOptions = {}, screenAspect = 0.47) {
  const playback = useContext(ScreenPlaybackContext);
  const {
    scale = 1, offsetX = 0, offsetY = 0, rotation = 0, padding = 0, fitMode = 'cover', borderRadius = 0,
    scrollX = false, scrollY = false, scrollXSpeed = 0, scrollYSpeed = 0, wrap = false,
  } = screenOptions;
  const drawOptions = { scale, offsetX, offsetY, rotation, padding, fitMode, borderRadius, scrollX, scrollY, scrollXSpeed, scrollYSpeed, wrap };
  const optionsRef = useRef(drawOptions);
  const surfaceRef = useRef(null);
  const videoRef = useRef(null);
  const resolutionScale = playback?.resolutionScale ?? 1;
  const hasVideo = Boolean(videoSrc) && typeof document !== 'undefined';

  optionsRef.current = drawOptions;

  const surface = useMemo(
    () => (hasVideo ? createCanvasSurface(screenAspect, resolutionScale) : null),
    [hasVideo, screenAspect, resolutionScale],
  );

  useEffect(() => {
    if (!hasVideo) return undefined;

    const video = document.createElement('video');
    video.src = videoSrc;
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.autoplay = false;
    videoRef.current = video;

    return () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (videoRef.current === video) videoRef.current = null;
    };
  }, [hasVideo, videoSrc]);

  // Layout effect: the new surface must be the draw target in the same commit
  // that puts its texture on the material, before any frame is captured.
  useLayoutEffect(() => {
    if (!surface) return undefined;
    surfaceRef.current = surface;
    // A resized surface starts empty — carry over the frame the video is on.
    const video = videoRef.current;
    if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const time = typeof playback?.getTime === 'function' ? playback.getTime() : 0;
      drawMediaToCanvas(surface.ctx, surface.canvas, video, optionsRef.current, time);
      surface.texture.needsUpdate = true;
    }
    return () => {
      surface.texture.dispose();
      if (surfaceRef.current === surface) surfaceRef.current = null;
    };
  }, [surface]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    if (playback?.mode === 'controlled') {
      video.pause();
      return undefined;
    }

    let frameId = 0;
    const renderFrame = () => {
      const target = surfaceRef.current;
      if (target && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        const time = typeof playback?.getTime === 'function' ? playback.getTime() : 0;
        drawMediaToCanvas(target.ctx, target.canvas, video, optionsRef.current, time);
        target.texture.needsUpdate = true;
      }
      frameId = requestAnimationFrame(renderFrame);
    };

    video.play().catch(() => {});
    renderFrame();

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [playback?.mode, hasVideo, videoSrc]);

  useEffect(() => {
    if (!hasVideo || !playback?.registerController) return undefined;

    const controller = {
      syncToTime: async (time) => {
        // The <video> can be replaced while a sync waits on it (a new source): the
        // old element's waits settle on disposal and the sync carries on with the
        // current one. No current element = this screen unmounted; the registry
        // owner syncs whatever replaced it.
        for (;;) {
          const video = videoRef.current;
          if (!video) return;
          await ensureVideoReady(video);
          if (videoRef.current !== video) continue;
          await seekVideoToTime(video, time);
          if (videoRef.current !== video) continue;
          // Read the surface after the waits: entering an export swaps it.
          const target = surfaceRef.current;
          if (!target) return;
          drawMediaToCanvas(target.ctx, target.canvas, video, optionsRef.current, time);
          target.texture.needsUpdate = true;
          return;
        }
      },
    };

    return playback.registerController(controller);
  }, [playback, hasVideo]);

  return surface?.texture ?? null;
}

export function useScreenTexture(mediaSrc, mediaType = 'image', screenOptions = {}, screenAspect = 0.47) {
  const imageTexture = useImageScreenTexture(mediaType === 'image' ? mediaSrc : VIDEO_SLOT_IMAGE, screenOptions, screenAspect);
  const videoTexture = useVideoScreenTexture(mediaType === 'video' ? mediaSrc : null, screenOptions, screenAspect);

  return mediaType === 'video' ? (videoTexture || imageTexture) : imageTexture;
}

export function useMediaAspect(mediaSrc, mediaType = 'image') {
  // A video's aspect comes from its metadata below; loading the clip through the
  // image loader only fetched it as a broken picture.
  const texture = useLoader(SafeTextureLoader, mediaType === 'video' ? VIDEO_SLOT_IMAGE : (mediaSrc || DEFAULT_IMAGE));
  const [videoAspect, setVideoAspect] = useState(null);

  useEffect(() => {
    if (mediaType !== 'video' || !mediaSrc) {
      setVideoAspect(null);
      return;
    }
    const video = document.createElement('video');
    video.src = mediaSrc;
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';
    const onLoaded = () => {
      if (video.videoWidth && video.videoHeight) {
        setVideoAspect(video.videoWidth / video.videoHeight);
      }
      video.removeAttribute('src');
      video.load();
    };
    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    return () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeAttribute('src');
      video.load();
    };
  }, [mediaSrc, mediaType]);

  if (mediaType === 'video') {
    return videoAspect || 16 / 9;
  }
  const img = texture?.image;
  if (img && img.width && img.height) {
    return img.width / img.height;
  }
  return 16 / 9;
}

export function useRoundedRectMaskTexture(width, height, radius) {
  return useMemo(() => {
    if (typeof document === 'undefined') return null;

    const canvas = document.createElement('canvas');
    const baseHeight = 2048;
    const baseWidth = Math.max(1, Math.round(baseHeight * (width / height)));
    canvas.width = baseWidth;
    canvas.height = baseHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const minDimension = Math.min(width, height);
    const radiusRatio = minDimension > 0 ? radius / minDimension : 0;
    const pixelRadius = Math.max(0, Math.min(Math.min(canvas.width, canvas.height) / 2, radiusRatio * Math.min(canvas.width, canvas.height)));

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(pixelRadius, 0);
    ctx.lineTo(canvas.width - pixelRadius, 0);
    ctx.quadraticCurveTo(canvas.width, 0, canvas.width, pixelRadius);
    ctx.lineTo(canvas.width, canvas.height - pixelRadius);
    ctx.quadraticCurveTo(canvas.width, canvas.height, canvas.width - pixelRadius, canvas.height);
    ctx.lineTo(pixelRadius, canvas.height);
    ctx.quadraticCurveTo(0, canvas.height, 0, canvas.height - pixelRadius);
    ctx.lineTo(0, pixelRadius);
    ctx.quadraticCurveTo(0, 0, pixelRadius, 0);
    ctx.closePath();
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
  }, [width, height, radius]);
}
