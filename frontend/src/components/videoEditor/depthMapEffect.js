/*
 * Build Depth Map — the shared source every Depth Effect reads.
 *
 * WHY THIS IS ITS OWN EFFECT rather than a field on each consumer. A monocular
 * depth estimate costs a ~25 MB model download and a few seconds of inference,
 * and the result is a small base64 PNG that travels inside the project (the
 * .cube LUT precedent). Once there are SEVERAL effects that want it — 3D Depth's
 * parallax, Depth Scan's iso-contours, and the relight lab next — a per-effect
 * copy would mean running the model once per effect and storing the same
 * megabyte twice. So the map is owned by ONE entry in `item.layerEffects`
 * (`id: 'depthMap'`) and every consumer reads it from there.
 *
 * That is also why Build Depth Map is the FIRST row of the Depth pack in the
 * picker: it is the thing you make before any of the others can do anything,
 * and adding a consumer auto-adds it.
 *
 * BACK COMPAT. 3D Depth shipped owning the map itself (`entry.depthMap` on the
 * `depth3d` entry) and projects in the wild still carry it there. `getItemDepthMap`
 * therefore reads the shared entry FIRST and falls back to the legacy one, so an
 * old project keeps parallaxing with no migration step and no model re-run. The
 * panel adopts the legacy map into the shared entry the moment Build Depth Map is
 * added, which is the only place the two can diverge.
 *
 * The polarity flag lives here for the same reason: "white is near" is a property
 * of the MAP (an uploaded map from another tool may be either way round), not of
 * whoever samples it, and every consumer must agree or the two effects would
 * disagree about which end of the scene is close.
 */

import * as THREE from 'three';
import { mapTimelineToSource } from './speedUtils.js';

export const DEPTH_MAP_LAYER_EFFECT_ID = 'depthMap';

// 3D Depth's id, hardcoded rather than imported: depthParallax.js imports THIS
// module for the shared accessors, so importing it back would close a cycle.
const LEGACY_DEPTH_OWNER_ID = 'depth3d';

// Longest edge of a stored depth map. The fields these effects build from it are
// low-frequency, so a small map is visually indistinguishable from a
// full-resolution one and keeps the project JSON (and every autosave) light.
export const DEPTH_MAX_EDGE = 384;

export const DM_DEFAULTS = {
  dmInvert: 0,   // 0 = white is near (what Depth Anything V2 returns)
};

export const DM_ENUM_FIELDS = [
  {
    key: 'dmInvert',
    label: 'Near Is',
    options: [[0, 'White'], [1, 'Black']],
  },
];

export function getDepthMapEffect(item) {
  const list = item?.layerEffects;
  if (!Array.isArray(list)) return null;
  return list.find((effect) => effect?.id === DEPTH_MAP_LAYER_EFFECT_ID) || null;
}

const validMap = (d) => (d && typeof d.data === 'string' && d.data.length > 0 ? d : null);

/** The legacy 3D Depth entry's own map, for projects written before 10.4.89. */
export function getLegacyDepthMap(item) {
  const list = item?.layerEffects;
  if (!Array.isArray(list)) return null;
  const legacy = list.find((effect) => effect?.id === LEGACY_DEPTH_OWNER_ID);
  return validMap(legacy?.depthMap);
}

/** The map this layer's depth effects should sample. Shared entry wins. */
export function getItemDepthMap(item) {
  return validMap(getDepthMapEffect(item)?.depthMap) || getLegacyDepthMap(item);
}

export function hasDepthMap(item) {
  return !!getItemDepthMap(item);
}

/** Shared field-shaping params. Neutral by default, so nothing existing moves. */
export function resolveDepthMapParams(item) {
  const params = getDepthMapEffect(item)?.params || {};
  const invert = Number(params.dmInvert);
  return { dmInvert: Number.isFinite(invert) ? invert : DM_DEFAULTS.dmInvert };
}

/* Shared by every Depth Effect's `available` gate so the pack appears and
   disappears as one.

   VIDEO is in — on FROZEN depth: one map, estimated from one frame, held for the
   whole clip. That is a deliberate design, not a stopgap. A per-frame estimate is
   what the cost model cannot carry (hundreds of inferences and hundreds of PNGs
   inside the project autosave), and it is also what does not LOOK right: a
   monocular model has no temporal consistency, so each frame lands on its own
   arbitrary scale and shift and a raw per-frame map boils — which every depth
   effect then amplifies. A frozen map is exact for as long as the camera holds,
   which covers the locked-off shot, the talking head and the slow push, and it
   degrades understandably rather than noisily when the camera does move. */
export function canUseDepthEffects(clip) {
  return clip?.mediaType === 'image' || clip?.mediaType === 'video';
}

/*
 * WHICH frame the map is frozen from is the user's, and it is the PLAYHEAD's —
 * not frame 0. The first frame of a clip is routinely a fade-in, a slate or the
 * back of someone's head; the frame whose depth you want is the one you are
 * looking at. Stored on the map as `t` so the panel can name the frame it came
 * from, and so a re-freeze somewhere else is a visible change rather than a
 * silent one.
 */

/** Playhead (0..100 through the item) → this clip's SOURCE seconds, through its
 *  trim and speed ramp. `trimStart + t` would pick the wrong frame on any
 *  speed-ramped clip, which is the same trap rotoProcessor documents. */
export function depthSourceTimeAt(item, progressPct) {
  const trimStart = Number.isFinite(item?.trimStart) ? item.trimStart : 0;
  const trimEnd = Number.isFinite(item?.trimEnd) ? item.trimEnd : 0;
  const span = trimEnd - trimStart;
  if (!(span > 0)) return trimStart;
  const p = Math.max(0, Math.min(1, (Number(progressPct) || 0) / 100));
  return trimStart + mapTimelineToSource(item?.speedPoints, p) * span;
}

/** m:ss.s, for naming the frozen frame in the panel. */
export function formatDepthFrameTime(t) {
  const v = Math.max(0, Number(t) || 0);
  const m = Math.floor(v / 60);
  const s = v - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

// ── Depth texture cache ─────────────────────────────────────────────────────
// Keyed by the base64 payload (the map is immutable once generated), LRU-capped
// and disposed on evict — same contract as getLutTexture in adjustmentEffects.js.

const MAX_CACHED = 8;
const depthTextureCache = new Map();

// The Player repaints when a depth image finishes decoding — without this the
// first frame after enabling an effect would sample an empty texture.
const pendingDepthLoads = new Set();
export function onDepthTextureLoaded(fn) {
  pendingDepthLoads.add(fn);
  return () => pendingDepthLoads.delete(fn);
}

export function getDepthTexture(depthMap) {
  if (!depthMap || typeof depthMap.data !== 'string' || !depthMap.data) return null;
  const key = depthMap.data;
  const hit = depthTextureCache.get(key);
  if (hit) {
    // Refresh LRU position.
    depthTextureCache.delete(key);
    depthTextureCache.set(key, hit);
    return hit;
  }
  const img = new Image();
  const texture = new THREE.Texture(img);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  // Keep three's default flipY. The colour plate is loaded by TextureLoader, which
  // flips, so the depth map has to flip identically or it is sampled upside down —
  // the parallax then displaces the sky instead of the foreground, and the scan
  // sweeps from the wrong end of the scene. A centred subject hides this
  // completely, which is why it needs an asymmetric test.
  texture.flipY = true;
  img.onload = () => {
    texture.needsUpdate = true;
    for (const fn of pendingDepthLoads) fn();
  };
  img.src = depthMap.data.startsWith('data:') ? depthMap.data : `data:image/png;base64,${depthMap.data}`;

  if (depthTextureCache.size >= MAX_CACHED) {
    const oldestKey = depthTextureCache.keys().next().value;
    const oldest = depthTextureCache.get(oldestKey);
    try { oldest?.dispose(); } catch { /* no-op */ }
    depthTextureCache.delete(oldestKey);
  }
  depthTextureCache.set(key, texture);
  return texture;
}

// ── Generation ──────────────────────────────────────────────────────────────

let worker = null;
let workerApi = null;

/* Longest edge of the still handed to the model. The estimator resizes to its
   own ~518 px input anyway, so anything past this is decoded and thrown away —
   and the frame crosses to the worker as a data URL, where a full 4K frame would
   be megabytes of base64 for no gain. */
export const DEPTH_INPUT_MAX_EDGE = 1024;

/* Decode ONE frame of a video to a still, on the main thread. It has to be here
   rather than in depthWorker.js: seeking needs a <video> element, which a module
   worker does not have. A data URL out, because that is what the worker's
   existing `generate(imageUrl)` already takes — the model's input is a picture
   either way, so nothing about the worker changes for video. */
function grabVideoFrame(url, timeSec, maxEdge) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    let done = false;
    const finish = (out, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { v.src = ''; v.load(); } catch { /* no-op */ }
      if (err) reject(err); else resolve(out);
    };
    const timer = setTimeout(
      () => finish(null, new Error('The video took too long to reach that frame.')),
      20000
    );
    const grab = () => {
      try {
        const sw = v.videoWidth;
        const sh = v.videoHeight;
        if (!sw || !sh) { finish(null, new Error('Could not read a frame from this video.')); return; }
        const k = Math.min(1, maxEdge / Math.max(sw, sh));
        const w = Math.max(1, Math.round(sw * k));
        const h = Math.max(1, Math.round(sh * k));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(v, 0, 0, w, h);
        finish(c.toDataURL('image/jpeg', 0.92));
      } catch (err) {
        finish(null, err);
      }
    };
    /* A painted frame, not just a seeked one: requestVideoFrameCallback fires when
       the new frame is actually on the element, and drawImage before that can copy
       the PREVIOUS frame — on a cut, a different shot entirely.

       But rVFC is a PRESENTATION callback, and this element is never in the
       document and never plays, so there are contexts where nothing presents and
       it simply never fires — a hidden tab, a headless browser. Waiting on it
       alone is a hang that surfaces as "the video took too long". So: race it
       against a short timer, and let `grab` (which is idempotent through `done`)
       be whichever arrives first. 'seeked' already guarantees a decoded, drawable
       frame, so the timer is a correct fallback and rVFC is the precise one. */
    const afterSeek = () => {
      if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(grab);
      setTimeout(grab, 250);
    };
    v.addEventListener('error', () => finish(null, new Error('Could not read this video file.')), { once: true });
    v.addEventListener('loadedmetadata', () => {
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      const t = Math.max(0, Math.min(dur > 0 ? dur - 0.05 : 0, Number(timeSec) || 0));
      // Assigning currentTime the value it ALREADY holds fires no 'seeked' — the
      // t = 0 case, which is exactly the default on an untouched playhead, would
      // otherwise hang until the timeout.
      if (Math.abs(v.currentTime - t) < 0.001) {
        if (v.readyState >= 2) afterSeek();
        else v.addEventListener('loadeddata', afterSeek, { once: true });
        return;
      }
      v.addEventListener('seeked', afterSeek, { once: true });
      v.currentTime = t;
    }, { once: true });
    v.src = url;
  });
}

/** The still a depth map is estimated from: an image is its own URL, a video is
 *  the one frame at `timeSec` (SOURCE seconds). */
export async function resolveDepthSourceImage(url, mediaType, timeSec = 0) {
  if (mediaType !== 'video') return url;
  return grabVideoFrame(url, timeSec, DEPTH_INPUT_MAX_EDGE);
}

// Generate a depth map for a clip's media. `onProgress` receives
// { stage: 'frame'|'model'|'infer', pct } so the panel can show model-download
// progress (the first run pulls ~25 MB, cached by the browser afterwards).
// For a video, `timeSec` names the source frame the map is frozen from.
export async function generateDepthMap(mediaUrl, { onProgress, mediaType = 'image', timeSec = 0 } = {}) {
  if (mediaType === 'video') onProgress?.({ stage: 'frame', pct: 0 });
  const imageUrl = await resolveDepthSourceImage(mediaUrl, mediaType, timeSec);
  const Comlink = await import('comlink');
  if (!workerApi) {
    worker = new Worker(new URL('./depthWorker.js', import.meta.url), { type: 'module' });
    workerApi = Comlink.wrap(worker);
  }
  const proxied = onProgress ? Comlink.proxy(onProgress) : undefined;
  return workerApi.generate(imageUrl, DEPTH_MAX_EDGE, proxied);
}

// Free the worker (and the ~100 MB of ONNX session it holds) once the panel is
// done with it. Called when the effect section unmounts.
export function releaseDepthWorker() {
  if (worker) {
    try { worker.terminate(); } catch { /* no-op */ }
  }
  worker = null;
  workerApi = null;
}

// ── Loading a map made elsewhere ────────────────────────────────────────────
/*
 * The estimator is a convenience, not the only source. A depth map may already
 * exist — rendered out of a 3D app or a game engine (where it is EXACT rather
 * than guessed), painted by hand to art-direct what sits in front of what, or
 * produced by a better/newer model than the one this ships. Every one of those
 * beats a monocular guess, and none of them could be used before.
 *
 * It is loaded through the SAME shape the estimator writes — a small greyscale
 * PNG on the shared `depthMap` entry — so nothing downstream can tell the two
 * apart: the same texture cache, the same consumers, the same Near Is flag for
 * the half of the world whose maps are black-is-near. The only difference is
 * `name`, which the panel prints so the map says where it came from, and the
 * absence of `t`: a file is not frozen from a frame of this clip.
 *
 * The image is normalised on the way in rather than stored as handed over:
 *  - downscaled to DEPTH_MAX_EDGE, because the fields built from it are
 *    low-frequency and a full-res map is megabytes in every autosave;
 *  - flattened to LUMINANCE, because the shaders read `.r` — a map saved as a
 *    single-channel grey, an RGB grey, or a grey with an alpha channel all have
 *    to mean the same thing;
 *  - composited over black, so a transparent PNG has defined depth everywhere
 *    instead of whatever happened to be in the canvas.
 */

// What the file picker offers. Deliberately the ordinary image types: a depth
// map from another tool arrives as a PNG far more often than anything exotic,
// and anything the browser can decode into a canvas works here.
export const DEPTH_MAP_FILE_ACCEPT = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';

/* The sanitizer drops a map whose payload is longer than this on load — silently,
   since a project load cannot interrupt the user. So the loader has to refuse the
   same thing at the door, where it can say so. */
export const DEPTH_MAP_MAX_DATA = 2_000_000;

function decodeImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this image file.')); };
    img.src = url;
  });
}

/** A chosen file → the same `{ w, h, data, name }` map the estimator produces. */
export async function readDepthMapFile(file) {
  if (!file) throw new Error('No file was chosen.');
  if (file.type && !/^image\//.test(file.type)) {
    throw new Error('A depth map has to be an image — PNG, JPEG or WebP.');
  }
  const img = await decodeImageFile(file);
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  if (!(sw >= 2) || !(sh >= 2)) throw new Error('That image is too small to be a depth map.');

  const k = Math.min(1, DEPTH_MAX_EDGE / Math.max(sw, sh));
  const w = Math.max(2, Math.round(sw * k));
  const h = Math.max(2, Math.round(sh * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);

  const image = ctx.getImageData(0, 0, w, h);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const l = Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
    px[i] = l;
    px[i + 1] = l;
    px[i + 2] = l;
    px[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  const data = canvas.toDataURL('image/png');
  if (!data.startsWith('data:image/png;base64,')) throw new Error('Could not encode this depth map.');
  if (data.length > DEPTH_MAP_MAX_DATA) {
    throw new Error('That depth map is too detailed to store with the project. Try a smoother map.');
  }
  const name = String(file.name || 'Depth map').replace(/\.[a-z0-9]+$/i, '').slice(0, 60) || 'Depth map';
  return { w, h, data, name };
}
