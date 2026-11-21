// Layers of this project on 3D surfaces (PLANS/GREENLIGHT_3D_PLAN.md, "Живой экран"). A model's screen (model3dConfig.screen /
// screens[] `layer`), a Scene material's `screen` and a Scene card (layers2d `kind: "layer"`) show another layer of the same timeline:
// an HTML clip drawn live from its page (htmlLive.js), a video, an image. Nothing is baked first: the surface is drawn at its own size
// from the layer's picture at the playhead, an edit of the page shows as soon as its page reloads, and a render takes the same frames
// (the page's export copy, settled before the frame is encoded, like a decoded video frame: motionVideo.js trackMotionMediaWork).
//
// Cost: a surface draws again only when its source shows another picture (a page's frame stamp, a video lane's frame, an image's url):
// a paused or still source never uploads again and never restarts Final's samples. The canvas is the source's own size (a page's, a
// video's), never upscaled: a 1290x540 video on an ultrawide screen was drawn into a 4884x2048 canvas and uploaded at that size.
import * as THREE from 'three';
import { drawMediaToCanvas } from '../mockupGenerator/screenTexture';
import { htmlLiveCanvas, htmlLiveExportCanvas } from './htmlLive';
import { requestVideoFrame, isSupportedMotionVideo, getMotionVideoSource, videoLaneFrameStamp, trackMotionMediaWork } from './motionTemplates/motionVideo';
import { resolveActiveIndex } from './engine/compositeHelpers';
import { calculateVideoTime } from './engine/layerHelpers';
import { resolvePictureInWorld } from './world3dText.js';

/** The frame being drawn (frameRender.js): the timeline a surface finds its layer on, and the engine's clock. */
let frame = null;
export function setLiveLayerFrame(engine, env) {
  frame = { engine, env };
}

/** The timeline's seconds this frame (a model's screen is drawn with its own clip time; its layer lives on the timeline's). */
export function liveLayerTime(fallback = 0) {
  const t = frame?.engine?.currentTime;
  return Number.isFinite(t) ? t : fallback;
}

const isVideoUrl = (url) => /^data:video\//i.test(String(url || '')) || /\.(mp4|webm|mov|m4v|ogg)(\?.*)?$/i.test(String(url || ''));

const images = new Map();
function imageEntry(url) {
  let e = images.get(url);
  if (e) return e;
  e = { image: null, ready: false };
  images.set(url, e);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => { e.image = img; e.ready = true; frame?.engine?.renderFrame?.(); };
  img.onerror = () => { e.ready = true; };
  img.src = url;
  return e;
}

/** The layer a surface names: an item's id, or a channel's id (its item at the playhead, else the nearest one). */
export function findLiveLayer(ref, time) {
  const env = frame?.env;
  if (!env || !ref) return null;
  for (const ch of env.channels || []) {
    if (!ch.items?.length) continue;
    const layout = env.layoutMap?.get(ch.id);
    if (!layout?.length) continue;
    let index = -1;
    if (ch.id === ref) {
      index = resolveActiveIndex(layout, time);
      if (index < 0) {
        let best = Infinity;
        layout.forEach((l, i) => { const d = time < l.startTime ? l.startTime - time : time - l.endTime; if (d < best) { best = d; index = i; } });
      }
    } else index = ch.items.findIndex((it) => it?.id === ref);
    if (index < 0) continue;
    const item = ch.items[index];
    const clip = env.clipsMap?.get(item?.clipId);
    if (!clip) return null;
    return { item, clip, layout: layout[index], channel: ch };
  }
  return null;
}

/** What a surface shows at `time` (the timeline's seconds): { kind: 'html' | 'video' | 'image', ... } or null. `spec` is a screen's or
 *  a material's `screen`: `layer` (an item or channel id) or `url`, with a video url's own `offset` and `loop`. */
function sourceAt(spec, time) {
  if (spec.layer) {
    const hit = findLiveLayer(spec.layer, time);
    if (!hit) return null;
    const { item, clip, layout } = hit;
    // The layer's own picture at the playhead; before it starts or after it ends, its first or last frame.
    const local = Math.max(0, Math.min(layout.duration, time - layout.startTime));
    const t = calculateVideoTime(item, local);
    const engine = frame?.engine;
    const step = engine?.isPlaying && engine.playbackStep > 0
      ? calculateVideoTime(item, Math.min(layout.duration, local + engine.playbackStep)) : null;
    if (clip.htmlSource) return { kind: 'html', clip, item, time: t, step, bake: clip.url || null };
    if (clip.mediaType === 'video' && clip.url) return { kind: 'video', url: clip.url, time: t };
    if (clip.mediaType === 'image' && clip.url) return { kind: 'image', url: clip.url };
    return { kind: 'unsupported', type: clip.mediaType };
  }
  if (!spec.url) return null;
  if (!isVideoUrl(spec.url)) return { kind: 'image', url: spec.url };
  const t = Math.max(0, (Number(time) || 0) + (Number(spec.offset) || 0));
  return { kind: 'video', url: spec.url, time: t, loop: spec.loop !== false };
}

const warned = new Set();
function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
}

/** How a surface is drawn: fit, the look's black level. A monitor's black is the backlight through the panel, a few levels over 0. */
export function surfaceLook(spec = {}) {
  const monitor = spec.look === 'monitor';
  const black = Number.isFinite(spec.blackLevel) ? Math.min(0.5, Math.max(0, spec.blackLevel)) : monitor ? 0.02 : 0;
  return {
    fitMode: spec.fitMode === 'contain' || spec.fitMode === 'stretch' ? spec.fitMode : spec.fit === 'contain' || spec.fit === 'stretch' ? spec.fit : 'cover',
    scale: Number.isFinite(spec.scale) ? spec.scale : 1,
    offsetX: Number.isFinite(spec.offsetX) ? spec.offsetX : 0,
    offsetY: Number.isFinite(spec.offsetY) ? spec.offsetY : 0,
    rotation: Number.isFinite(spec.rotation) ? spec.rotation : 0,
    padding: Number.isFinite(spec.padding) ? Math.min(0.45, Math.max(0, spec.padding)) : 0,
    borderRadius: Number.isFinite(spec.borderRadius) ? spec.borderRadius : 0,
    black,
  };
}

/**
 * One surface's canvas: what it shows, drawn at the source's own size (or `resolution`), again only when the source shows another
 * picture. `update` returns true when the canvas changed. `canvas` is null until the first picture: a surface never shows a blank
 * frame in place of one that is coming.
 */
export class LiveSurface {
  constructor(lane) {
    this.lane = lane;          // its own decoder lane (a video's frame per surface)
    this.canvas = null;
    this.ctx = null;
    this.texture = null;       // the editor's own texture of it, made on first ask (a model's own pass)
    this.version = 0;
    this.generation = 0;       // a new canvas (a new size): whoever wears it takes the new one
    this.drawn = null;
    this.exportKey = null;
    this.exportCanvas = null;
    this.exportFrame = null;
  }

  #size(w, h, spec) {
    const res = Array.isArray(spec.resolution) ? spec.resolution : null;
    let width = res ? Number(res[0]) : w, height = res ? Number(res[1]) : h;
    if (!(width > 0 && height > 0)) return false;
    // the screen's own shape when it has one (a mesh's aspect), at the source's height
    if (!res && spec.aspect > 0 && Math.abs(spec.aspect - width / height) > 0.01) width = height * spec.aspect;
    const k = Math.min(1, 4096 / width, 4096 / height);
    width = Math.max(2, Math.round(width * k));
    height = Math.max(2, Math.round(height * k));
    if (this.canvas && this.canvas.width === width && this.canvas.height === height) return true;
    // A new size is a new canvas (and a new texture wherever it is worn): a texture never changes size under its users.
    this.texture?.dispose?.();
    this.texture = null;
    this.generation += 1;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.drawn = null;
    return true;
  }

  /** The editor's own texture of the canvas (a model drawn in its own pass). */
  editorTexture() {
    if (!this.canvas) return null;
    if (!this.texture) {
      this.texture = new THREE.CanvasTexture(this.canvas);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    }
    return this.texture;
  }

  #html(src, spec) {
    const engine = frame?.engine, env = frame?.env;
    const fps = Number(engine?.exportFps) || Number(env?.projectFps) || 30;
    const videoSize = engine?.videoSize;
    const res = Array.isArray(spec.resolution) ? { width: Number(spec.resolution[0]), height: Number(spec.resolution[1]) } : null;
    // A page laid out at the surface's resolution is a page of its own (htmlLive keys pages by size).
    const clip = res && res.width > 0 && res.height > 0 ? { ...src.clip, htmlCanvas: res } : src.clip;
    const instance = src.item.id;
    if (engine?.exporting) {
      // A render (a video or a still): the page's export copy, settled on exactly this frame before the frame is encoded.
      const key = `${clip.htmlSource}|${clip.htmlVersion || ''}|${Math.floor(src.time * fps + 1e-6)}|${res ? `${res.width}x${res.height}` : ''}`;
      if (this.exportFrame === key) return this.exportCanvas;
      if (this.exportKey !== key) {
        this.exportKey = key;
        trackMotionMediaWork(htmlLiveExportCanvas(clip, src.time, { fps, videoSize, instance }).then((c) => {
          if (this.exportKey !== key) return;
          this.exportCanvas = c;
          this.exportFrame = key;
        }));
      }
      return undefined;      // not yet: the pump waits for it and the frame is drawn again
    }
    return htmlLiveCanvas(clip, src.time, { fps, videoSize, playing: !!engine?.isPlaying, instance, stepSeconds: src.step });
  }

  /** Draw the surface for `time` (the timeline's seconds). True when the canvas holds a new picture. */
  update(spec, time) {
    let src = sourceAt(spec, time);
    if (!src) return false;
    let media = null, stamp = null;
    if (src.kind === 'html') {
      const page = this.#html(src, spec);
      if (page === undefined) return false;
      if (page) {
        media = page;
        stamp = `html:${page.__glStamp || ''}`;
        if (!page.__glStamp) return false;      // nothing drawn on it yet
      } else if (src.bake) src = { kind: 'video', url: src.bake, time: src.time };
      else return false;
    }
    if (src.kind === 'video') {
      if (isSupportedMotionVideo(src.url)) {
        const lane = `${this.lane}`;
        const v = getMotionVideoSource(src.url);
        let t = src.time;
        if (v.loaded && v.duration > 0) t = src.loop ? Math.min(v.duration - 1e-3, t % v.duration) : Math.min(t, v.duration - 1e-3);
        const f = requestVideoFrame(src.url, t, lane);
        if (!f) return false;
        media = f;
        // the frame on the lane, not the time asked for: a 30 fps video redraws 30 times a second whatever the preview's rate
        stamp = `video:${src.url}|${videoLaneFrameStamp(lane)}`;
      } else {
        warnOnce(`fmt:${src.url}`, `[live layers] ${src.url}: only MP4/MOV video plays on a 3D surface`);
        return false;
      }
    } else if (src.kind === 'image') {
      const e = imageEntry(src.url);
      if (!e.image) return false;
      media = e.image;
      stamp = `image:${src.url}`;
    } else if (src.kind === 'unsupported') {
      warnOnce(`kind:${spec.layer}`, `[live layers] layer ${spec.layer} is a ${src.type} layer: a 3D surface shows HTML clips, videos and images`);
      return false;
    }
    if (!media) return false;
    const w = media.videoWidth || media.naturalWidth || media.width || 0, h = media.videoHeight || media.naturalHeight || media.height || 0;
    if (!this.#size(w, h, spec)) return false;
    const look = surfaceLook(spec);
    const key = `${stamp}|${JSON.stringify(look)}|${this.canvas.width}x${this.canvas.height}`;
    if (key === this.drawn) return false;
    this.drawn = key;
    const { ctx, canvas } = this;
    if (look.fitMode === 'stretch') {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(media, 0, 0, canvas.width, canvas.height);
    } else drawMediaToCanvas(ctx, canvas, media, look);
    if (look.black > 0) {
      // a monitor's black: the backlight through the panel lifts every pixel by a few levels ('screen': black -> level, white stays)
      const v = Math.round(look.black * 255);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
    this.version += 1;
    if (this.texture) this.texture.needsUpdate = true;
    return true;
  }

  dispose() {
    this.texture?.dispose?.();
    this.texture = null;
    this.canvas = null;
    this.ctx = null;
  }
}

/** The Scene's own surfaces that show a layer or a video: materials with `screen` (`mat:<name>`) and cards with `kind: "layer"`
 *  (`l2d:<id>`), drawn for `time`; what the world wears (WorldRenderer.setLiveSurfaces). Null when the scene has none. A layer of the
 *  timeline shows its picture at the timeline's `time`; a video by url is the Scene's own and plays on its clock (`sceneTime`, the
 *  seconds from the Scene clip's start, rig3d.js sceneTimeAt), as a model layer's url screen plays on that layer's. */
const sceneSurfaces = new Map();
export function liveSceneSurfaces(scene, time, sceneTime = time) {
  const specs = [];
  for (const [name, m] of Object.entries(scene?.materials || {})) {
    if (m?.screen && (m.screen.layer || m.screen.url)) specs.push([`mat:${name}`, m.screen]);
  }
  for (const l of scene?.layers2d || []) if (l?.kind === 'layer' && (l.layer || l.url) && l.id) specs.push([`l2d:${l.id}`, l]);
  if (!specs.length && !sceneSurfaces.size) return null;
  const out = {};
  const keep = new Set();
  for (const [key, spec] of specs) {
    keep.add(key);
    let s = sceneSurfaces.get(key);
    if (!s) { s = new LiveSurface(`live:${key}`); sceneSurfaces.set(key, s); }
    s.update(spec, spec.layer ? time : sceneTime);
    if (s.canvas) out[key] = { canvas: s.canvas, version: s.version };
  }
  for (const [key, s] of sceneSurfaces) if (!keep.has(key)) { s.dispose(); sceneSurfaces.delete(key); }
  return out;
}

/** A picture layer standing in the world as a card (world3dText.js isPictureInWorldLayer), as the run flat text hands the world
 *  (layerMesh.js buildTextWorldRun): one card, the layer's picture fitted whole in the composition as its quad shows it (its own aspect,
 *  no bars), placed by the layer's quad transform and so at the layer's own Z. Null until the picture has its first frame. */
const worldCards = new Map();
export function pictureWorldRun(item, W, H, time) {
  let s = worldCards.get(item.id);
  if (!s) { s = new LiveSurface(`card:${item.id}`); worldCards.set(item.id, s); }
  s.update({ layer: item.id, fit: 'stretch' }, time);
  if (!s.canvas) return null;
  const a = s.canvas.width / s.canvas.height;
  const rw = Math.min(W, H * a), rh = rw / a;
  return {
    plateW: W, plateH: H,
    atlas: { canvas: s.canvas, version: s.version, width: s.canvas.width, height: s.canvas.height },
    cards: [{ m: [rw, 0, 0, W / 2, 0, rh, 0, H / 2, 0, 0, 1, 0, 0, 0, 0, 1], cell: [0, 0, s.canvas.width, s.canvas.height], poly: null, alpha: 1 }],
    options: resolvePictureInWorld(item),
  };
}
