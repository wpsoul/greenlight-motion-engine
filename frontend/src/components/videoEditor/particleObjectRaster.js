/*
 * Particle objects: turning a picked layer into the sprite a particle stamps.
 *
 * Two jobs, kept in one leaf module so neither the panel nor the renderer has to
 * know about the other:
 *
 *   1. `particleSourceFromLayer` — SNAPSHOT a timeline layer's artwork into the
 *      bounded `source` block the schema stores (see sanitizeObjectSource).
 *   2. `ensureObjectRaster` — draw that snapshot into a tight canvas, cached.
 *
 * "Tight" is the whole point. The obvious implementation — pre-render the member
 * through the normal layer path — hands back a COMPOSITION-SIZED frame with the
 * artwork somewhere in the middle, so every particle would be a 1920-wide quad
 * mostly full of nothing: the stamp would be a fraction of the size the user
 * asked for, differently for every member, and the fill cost would be enormous.
 * Drawing the artwork on its own, at its own aspect, is what makes `Object size`
 * mean the same thing for a heart, a word and a logo.
 *
 * What a snapshot does NOT carry: the source layer's animation, effects, masks or
 * transform. A particle object is that layer's artwork, not a live instance of it.
 */

import { unitOutlineFromShape, shapeBoxSize, shapeCornerRadii, buildPathOutline, shapePathBounds } from './shapePath';
import { getTextFootprint } from './textFootprint';
import { resolvePlaceholderText } from './textPlaceholders';
import { imagePlateSize } from './imagePlate';
import { hash32 } from '../../sim/particles/rng.js';
import { resolveTextFontSize } from './types';

// Enough to look sharp on a large particle without turning a 12-member system
// into a texture-memory problem: 12 x 512^2 RGBA is ~12 MB worst case.
//
// The emitter reads the same raster. Raising ITS cap to 1024 was tried and
// reverted: it doubles the distinct emission pixels (measured: 100k particles on
// 66k distinct sites at 512, 90k at 1024) but that is not what limits the
// picture. A particle is drawn as a sprite several pixels across, so neighbouring
// source pixels land on top of each other and the extra distinctness is invisible
// — it would only show at a 1-2 px sprite. It cost 2.6 MB per artwork instead of
// 0.65 and a 4x bigger readback for no visible gain, which is a bad trade.
const MAX_RASTER_PX = 512;
export const EMITTER_RASTER_PX = MAX_RASTER_PX;

/* ── 1. Snapshot ──────────────────────────────────────────────────────────── */

/** Layer kinds that can become a particle object, for the picker's filter. */
export const PARTICLE_SOURCE_MEDIA_TYPES = new Set(['image', 'text', 'shape', 'video']);

const firstColor = (value, fallback) => {
  // Paint fields may hold a gradient object; a particle stamp takes its first
  // stop rather than refusing to rasterise.
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object') {
    const stop = Array.isArray(value.stops) ? value.stops[0] : null;
    if (typeof stop?.color === 'string') return stop.color;
    if (typeof value.color === 'string') return value.color;
  }
  return fallback;
};

/**
 * Snapshot `item`/`clip` into a `source` block, or null when this layer has no
 * artwork we can stamp.
 */
export function particleSourceFromLayer(item, clip, compW = 1920, compH = 1080) {
  const type = clip?.mediaType;
  if (type === 'image') {
    const url = clip.url || clip.proxyUrl || '';
    if (!url) return null;
    return { kind: 'image', url, aspect: 1 };   // real aspect is learned on decode
  }

  if (type === 'video') {
    const url = clip.url || clip.proxyUrl || '';
    if (!url) return null;
    // The poster is what a member stamps while Play video is off — and it is a
    // still, so the snapshot rule still holds for the default case.
    return { kind: 'video', url, aspect: 1, ...(clip.thumbnailUrl ? { poster: clip.thumbnailUrl } : {}) };
  }

  if (type === 'text') {
    // Placeholders stamp as the text they resolve to (a counter as its end value).
    const text = typeof item?.textContent === 'string' ? resolvePlaceholderText(item.textContent) : '';
    if (!text.trim()) return null;
    return {
      kind: 'text',
      text,
      fontFamily: item.textFontFamily || 'sans-serif',
      fontWeight: Number(item.textFontWeight) || 700,
      fontSize: resolveTextFontSize(item, compH),
      lineHeight: Number(item.textLineHeight) > 0 ? Number(item.textLineHeight) : 1.15,
      color: firstColor(item.textColor, '#ffffff'),
    };
  }

  if (type === 'shape') {
    const box = shapeBoxSize(item, compW, compH);
    const aspect = box.height / Math.max(1, box.width);

    // A CUSTOM SVG or a traced VECTOR has no outline to read back — it is a
    // picture, not a list of anchors — so it becomes an image source pointing at
    // the same file the layer draws. The browser rasterises an SVG <img> at
    // whatever size it is asked for, which is exactly what the object raster
    // wants, and it means one code path serves both.
    //
    // The two SVG shape types differ in COLOUR, and the stamp has to match what
    // the layer shows: 'custom' is a silhouette flooded with the layer's fill,
    // 'vector' is the full-colour preview that Image → Vector produced.
    const svgType = item?.shapeType;
    if ((svgType === 'custom' || svgType === 'vector') && item?.shapeSvgUrl) {
      return {
        kind: 'image',
        url: item.shapeSvgUrl,
        aspect,
        ...(svgType === 'custom' ? { tint: firstColor(item?.shapeFillColor, '#ffffff') } : {}),
      };
    }
    const fill = firstColor(item?.shapeFillColor, '#ffffff');
    const stroke = item?.shapeStrokeWidth > 0 ? firstColor(item?.shapeStrokeColor, '') : '';
    const strokeWidth = item?.shapeStrokeWidth > 0
      // Stroke width is in composition px against the shape's own box; store it in
      // the same unit space as the points so the raster is size-independent.
      ? (Number(item.shapeStrokeWidth) / Math.max(1, box.width))
      : 0;

    let points = unitOutlineFromShape(item, {
      width: box.width,
      height: box.height,
      radii: shapeCornerRadii(item, box.width, box.height),
    });
    let closed = true;
    if (!points) {
      // A drawn path (or a Line) carries its own points; a custom SVG has no
      // outline to read back, so it cannot become an object.
      const path = item?.shapePath;
      if (!Array.isArray(path?.points) || path.points.length < 2) return null;
      points = path.points;
      closed = path.closed !== false;
    }
    return {
      kind: 'shape',
      points: points.map((p) => ({
        x: p.x, y: p.y,
        ...(p.hIn ? { hIn: { x: p.hIn.x, y: p.hIn.y } } : {}),
        ...(p.hOut ? { hOut: { x: p.hOut.x, y: p.hOut.y } } : {}),
      })),
      closed,
      fill,
      stroke,
      strokeWidth,
      aspect,
    };
  }

  return null;
}

/* ── 2. Raster ────────────────────────────────────────────────────────────── */

// url -> { img, ready, failed }
const imageCache = new Map();

function getImage(url) {
  let entry = imageCache.get(url);
  if (!entry) {
    const img = new Image();
    entry = { img, ready: false, failed: false };
    img.crossOrigin = 'anonymous';
    img.onload = () => { entry.ready = true; };
    img.onerror = () => { entry.failed = true; };
    img.src = url;
    imageCache.set(url, entry);
  }
  return entry;
}

/** Identity of a raster: two members with the same artwork share one canvas. */
export function objectRasterKey(source) {
  if (!source) return '';
  if (source.kind === 'image') return `i:${source.url}:${source.tint || ''}`;
  if (source.kind === 'video') return `v:${source.poster || source.url}`;
  if (source.kind === 'text') {
    return `t:${source.fontWeight}:${Math.round(source.fontSize)}:${source.fontFamily}:${source.color}:${source.lineHeight}:${source.text}`;
  }
  return `s:${source.fill}:${source.stroke}:${source.strokeWidth}:${source.closed}:${JSON.stringify(source.points)}`;
}

const rasterCache = new Map();   // key -> { canvas, aspect, ready, version }

function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  return canvas;
}

/**
 * The 2d context for a raster canvas — ALWAYS with willReadFrequently.
 *
 * Every one of these canvases is read back: the spawn table samples its opaque
 * pixels, and Grow Points bakes its arrival field from the same alpha. Asking for
 * a plain context first and a readback-friendly one later does not upgrade it —
 * the attributes of the first getContext win, and Chrome warns that the readbacks
 * would be faster the other way round. So there is one accessor and everything
 * uses it.
 */
export function ctx2d(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}

function rasterImage(source, maxPx = MAX_RASTER_PX) {
  const entry = getImage(source.url);
  if (!entry.ready) return { canvas: null, aspect: source.aspect || 1, ready: false, failed: entry.failed };
  const iw = entry.img.naturalWidth || 1;
  const ih = entry.img.naturalHeight || 1;
  const scale = Math.min(1, maxPx / Math.max(iw, ih));
  const canvas = makeCanvas(iw * scale, ih * scale);
  const ictx = ctx2d(canvas);
  ictx.drawImage(entry.img, 0, 0, canvas.width, canvas.height);
  // A tinted source is a SILHOUETTE flooded with one colour — the same
  // source-in flood the shape layer does, so the stamp matches the layer.
  if (source.tint) {
    ictx.globalCompositeOperation = 'source-in';
    ictx.fillStyle = source.tint;
    ictx.fillRect(0, 0, canvas.width, canvas.height);
    ictx.globalCompositeOperation = 'source-over';
  }
  // boxFrac: the fraction of the LAYER's rect this canvas covers. A photo fills its
  // plate exactly, so it is the whole of it.
  return { canvas, aspect: ih / iw, ready: true, boxFracW: 1, boxFracH: 1 };
}

/**
 * The STILL for a video member — what it stamps with Play video off.
 *
 * A poster (the clip's own thumbnail) is an image, so it goes down the image
 * path and is done. Without one, a hidden video element is loaded and its first
 * frame taken; until that arrives the member reports not-ready and simply is not
 * drawn this frame, exactly like an image still decoding.
 */
function rasterVideoStill(source, maxPx = MAX_RASTER_PX) {
  if (source.poster) return rasterImage({ kind: 'image', url: source.poster, aspect: source.aspect }, maxPx);
  const entry = getObjectVideo(source.url);
  const v = entry.video;
  if (!entry.ready || !(v.videoWidth > 0)) return { canvas: null, aspect: source.aspect || 1, ready: false };
  const scale = Math.min(1, maxPx / Math.max(v.videoWidth, v.videoHeight));
  const canvas = makeCanvas(v.videoWidth * scale, v.videoHeight * scale);
  ctx2d(canvas).drawImage(v, 0, 0, canvas.width, canvas.height);
  return { canvas, aspect: v.videoHeight / v.videoWidth, ready: true, boxFracW: 1, boxFracH: 1 };
}

function rasterText(source, maxPx = MAX_RASTER_PX) {
  const lines = String(source.text).split('\n');
  // Measure at the stored size, then scale the whole raster to the cap — measuring
  // at the capped size instead would change the glyph metrics.
  const probe = ctx2d(makeCanvas(8, 8));
  const font = `${source.fontWeight} ${source.fontSize}px ${source.fontFamily}`;
  probe.font = font;
  const widths = lines.map((l) => probe.measureText(l).width);
  const textW = Math.max(1, ...widths);
  const lineH = source.fontSize * source.lineHeight;
  const textH = Math.max(1, lineH * lines.length);
  // Padding keeps descenders and any antialiased edge inside the sprite.
  const pad = source.fontSize * 0.18;
  const w = textW + pad * 2;
  const h = textH + pad * 2;
  const scale = Math.min(1, maxPx / Math.max(w, h));

  const canvas = makeCanvas(w * scale, h * scale);
  const ctx = ctx2d(canvas);
  ctx.scale(scale, scale);
  ctx.font = font;
  ctx.fillStyle = source.color;
  ctx.textAlign = 'center';
  /*
   * 'top', `drop` below the line's own top — the convention a text LAYER is laid
   * out with (engine/layerMesh.js: `textBaseline = 'top'`, one CSS line box per
   * row, the spare line height split evenly above and below the font's content
   * area, so the text sits centred in its line box).
   *
   * This used to draw 'middle' at pad + lineH*(i + 0.5). Both centre something
   * on the line box, but not the same something: 'middle' puts the em-box MIDDLE
   * on the line-box centre, while a layer puts the em-box TOP on the line-box
   * top — and for a typical face the em middle sits above the line-box centre.
   * Measured on Helvetica 900 at 668 px: the rasterised glyph sat 50 px LOWER
   * than the same glyph on the layer it was picked from — 7.5% of the font size,
   * 10.5% of the letter's own height.
   *
   * Everything built from this raster inherits that offset: a collider sits low
   * inside the letter it was picked from (particles spill past the baseline and
   * leave the cap empty), and a layer emitter's dissolve starts low in the same
   * way. Matching the layer is this function's whole job.
   */
  ctx.textBaseline = 'top';
  const fontBox = ctx.measureText('H');
  const drop = (lineH + (fontBox.fontBoundingBoxAscent || 0) - (fontBox.fontBoundingBoxDescent || source.fontSize)) / 2;
  lines.forEach((line, i) => {
    ctx.fillText(line, w / 2, pad + lineH * i + drop);
  });
  // The canvas is the text block PLUS padding, and the caller has to size the
  // emitter to that — not to the glyph block. Mapping this padded picture onto an
  // unpadded box squeezes the letters by the padding ratio and shifts them, which
  // is exactly how a text dissolve comes out a little small and a little low.
  return { canvas, aspect: h / w, ready: true, boxW: w, boxH: h, padFrac: pad / w };
}

function rasterShape(source, maxPx = MAX_RASTER_PX) {
  // Fit the outline's real bounds, not the unit box: a Line or a hand-drawn path
  // uses a fraction of its box, and the leftover would become dead sprite margin.
  const bounds = shapePathBounds(source.points, source.closed) || { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 };
  const bw = Math.max(1e-3, bounds.maxX - bounds.minX);
  const bh = Math.max(1e-3, bounds.maxY - bounds.minY);
  const aspect = (bh * source.aspect) / bw;

  const w = maxPx;
  const h = Math.max(1, Math.round(maxPx * aspect));
  const stroke = source.stroke ? Math.max(1, source.strokeWidth * w) : 0;
  const inset = stroke / 2 + 1;   // keep the stroke and its antialiasing inside

  const canvas = makeCanvas(w, h);
  const ctx = ctx2d(canvas);
  // buildPathOutline maps unit points through (cx + x*w, cy + y*h); centring on the
  // outline's own bounds is what crops the sprite to the drawn shape.
  const drawW = w - inset * 2;
  const drawH = h - inset * 2;
  const cx = inset + drawW * (-bounds.minX / bw);
  const cy = inset + drawH * (-bounds.minY / bh);
  const path = buildPathOutline(source.points, source.closed, cx, cy, drawW / bw, drawH / bh);
  if (!path) return { canvas: null, aspect: 1, ready: false, failed: true };

  if (source.fill) { ctx.fillStyle = source.fill; ctx.fill(path); }
  if (stroke) {
    ctx.strokeStyle = source.stroke;
    ctx.lineWidth = stroke;
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }
  // The canvas is cropped to the drawn OUTLINE, which for a line or an open path is
  // a fraction of the shape layer's box — so report that fraction rather than
  // letting the caller assume the whole box.
  return { canvas, aspect, ready: true, boxFracW: bw, boxFracH: bh };
}

/**
 * The sprite canvas for a member's source, cached by artwork.
 *
 * Returns `{ canvas, aspect, ready }`. An image that is still decoding comes back
 * `ready: false` with no canvas — the caller simply draws nothing for that member
 * this frame and picks it up on the next one.
 */
export function ensureObjectRaster(source, maxPx = MAX_RASTER_PX) {
  const base = objectRasterKey(source);
  if (!base) return null;
  // The cap is part of the key: the same artwork can legitimately be cached twice,
  // once as a sprite and once, larger, as an emission source.
  const key = `${base}@${maxPx}`;
  const hit = rasterCache.get(key);
  if (hit && (hit.ready || hit.failed)) return hit;

  let out = null;
  try {
    if (source.kind === 'video') out = rasterVideoStill(source, maxPx);
    else if (source.kind === 'image') out = rasterImage(source, maxPx);
    else if (source.kind === 'text') out = rasterText(source, maxPx);
    else out = rasterShape(source, maxPx);
  } catch {
    out = { canvas: null, aspect: 1, ready: false, failed: true };
  }
  // A pending image is cached too, so the <img> is created once, not per frame.
  rasterCache.set(key, out);
  return out;
}

/* ── 2a. Live video objects ───────────────────────────────────────────────── */
//
// THE ONE PLACE THE SNAPSHOT RULE IS BROKEN, ON PURPOSE.
//
// Every other object kind is a still: the same texture at every frame, which is
// what makes drawing a pure function of (cache, time, look). A video object with
// Play video on is a LIVE texture — one element, one current frame, shared by
// every particle stamping it. That is the whole feature; it is also why it is
// opt-in and why the element's time is driven from OUTSIDE rather than left to
// play on its own:
//
//   preview, playing   the element plays, and is nudged when it drifts
//   preview, paused    seeked, so scrubbing shows the right frame
//   export / still     seeked AND AWAITED before the frame is drawn, because a
//                      render gets one pass and an unseeked element would encode
//                      whatever frame happened to be decoded
//
// Without that last case this feature would be the "silently wrong in a
// delivered video" failure all over again: right on screen, wrong in the file.

const objectVideos = new Map();   // url -> { video, ready, failed }

function getObjectVideo(url) {
  let entry = objectVideos.get(url);
  if (!entry) {
    const video = document.createElement('video');
    entry = { video, ready: false, failed: false };
    // crossOrigin BEFORE src. Set afterwards the attribute does not apply to the
    // load already in flight, and an element fetched without it counts as unclean
    // — WebGL then throws a SecurityError on the texture upload, which happens
    // inside the renderer's draw and takes the whole frame down with it.
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.src = url;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.addEventListener('loadeddata', () => { entry.ready = true; }, { once: true });
    video.addEventListener('error', () => { entry.failed = true; }, { once: true });
    try { video.load(); } catch { entry.failed = true; }
    objectVideos.set(url, entry);
  }
  return entry;
}

/** The element for a video member, or null while it is still loading. */
export function objectVideoElement(source) {
  if (source?.kind !== 'video' || !source.url) return null;
  const entry = getObjectVideo(source.url);
  // READY IS NOT ENOUGH TO UPLOAD. A texture bound from an element that has
  // metadata but no decoded frame fails at the GL level — no exception, no
  // console error, just a lost frame for the whole compositor, which is why this
  // cost an afternoon to find. HAVE_CURRENT_DATA and real dimensions are the two
  // conditions that make texImage2D safe.
  const v = entry.video;
  const usable = entry.ready && !entry.failed && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0;
  return usable ? v : null;
}

/** Where in the source a given clip-local time lands. Loops, so a short clip
 *  keeps playing rather than freezing on its last frame. */
function videoTimeFor(video, time) {
  const d = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  if (!d) return 0;
  const t = time % d;
  return t < 0 ? t + d : t;
}

/**
 * Put every live video object on `time`, and resolve when their frames are
 * really there. `playing` lets preview run the element instead of seeking it
 * sixty times a second; an export always passes false.
 *
 * Resolves TRUE only when something was actually seeked. Paused preview repaints
 * on that answer, and a repaint asks again — resolving true unconditionally
 * would spin the compositor forever on a video already sitting on the right
 * frame.
 */
export function prepareObjectVideos(sources, time, playing = false) {
  const waits = [];
  for (const source of sources) {
    const video = objectVideoElement(source);
    if (!video) continue;
    const want = videoTimeFor(video, time);
    if (playing) {
      // Let it run; only correct a drift big enough to see. Seeking every frame
      // of playback stutters, and a fifth of a second is under one particle's
      // turn on screen.
      if (Math.abs(video.currentTime - want) > 0.2) video.currentTime = want;
      if (video.paused) video.play().catch(() => {});
      continue;
    }
    if (!video.paused) video.pause();
    if (Math.abs(video.currentTime - want) < 1e-3) continue;
    waits.push(new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      video.addEventListener('seeked', finish, { once: true });
      // A seek that never lands must not hang an export.
      setTimeout(finish, 2000);
      try { video.currentTime = want; } catch { finish(); }
    }));
  }
  return waits.length ? Promise.all(waits).then(() => true) : Promise.resolve(false);
}

// url -> canvas holding this video's CURRENT frame.
const videoFrames = new Map();

/**
 * The current frame of a video object, as a CANVAS.
 *
 * Not a THREE.VideoTexture. Binding one of those into this compositor's
 * render-target pass loses the whole frame — no exception, no console error, the
 * entire composite comes back black, which is a miserable thing to diagnose and
 * cost most of an afternoon. A canvas copy is the texture path every other object
 * already uses and is proven in this renderer; the cost is one drawImage of a
 * small picture per frame per video.
 */
export function objectVideoFrame(source) {
  const video = objectVideoElement(source);
  if (!video) return null;
  const w = Math.min(512, video.videoWidth);
  const h = Math.max(1, Math.round(w * (video.videoHeight / video.videoWidth)));
  let canvas = videoFrames.get(source.url);
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = makeCanvas(w, h);
    videoFrames.set(source.url, canvas);
  }
  try {
    ctx2d(canvas).drawImage(video, 0, 0, w, h);
  } catch {
    return null;   // a tainted element cannot be copied either; fall back to the still
  }
  return { canvas, aspect: video.videoHeight / video.videoWidth };
}

export function disposeObjectVideos() {
  videoFrames.clear();
  for (const { video } of objectVideos.values()) {
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* already gone */ }
  }
  objectVideos.clear();
}

/* ── 2b. Where the layer actually is ──────────────────────────────────────── */

/**
 * The rect a layer occupies on screen, in composition pixels, and where its centre
 * sits relative to the frame's.
 *
 * A layer emitter has to fire from the layer's OWN rect. Sizing it to a fraction of
 * the composition instead reproduces the artwork's shape at the wrong scale — the
 * dissolve of a small word covers the whole frame — which is exactly what you see
 * if you skip this.
 *
 * Falls back to null when the answer is not knowable yet (an image still decoding,
 * a text layer that has never been drawn); the caller then keeps whatever rect the
 * emitter already had.
 */
export function layerScreenRect(item, clip, compW, compH, source = null) {
  const scale = Number(item?.zoom) > 0 ? Number(item.zoom) : 1;
  const type = clip?.mediaType;
  let width = 0;
  let height = 0;
  // Text and image layers can sit off their own centre; a shape is centred on it.
  let offsetX = 0;
  let offsetY = 0;

  if (type === 'text') {
    // Size to the RASTER's box, not to the published glyph box.
    //
    // The two are not the same rect: the raster carries padding so descenders and
    // antialiasing survive, and mapping that padded picture onto the tight glyph
    // box shrinks every letter by the padding ratio and drops it by half of one.
    // The published box is still what says WHERE the block sits.
    const raster = source ? ensureObjectRaster(source) : null;
    if (!raster?.ready || !(raster.boxW > 0)) return null;
    width = raster.boxW;
    height = raster.boxH;
    const box = getTextFootprint(item?.id);
    if (box) {
      offsetX = box.offsetX || 0;
      offsetY = -(box.offsetY || 0);   // the footprint is y-down, the world is y-up
    }
  } else if (type === 'shape') {
    const box = shapeBoxSize(item, compW, compH);
    // The raster is cropped to the drawn outline; a Line or an open path covers
    // only part of its layer's box.
    const raster = source ? ensureObjectRaster(source) : null;
    width = box.width * (raster?.boxFracW ?? 1);
    height = box.height * (raster?.boxFracH ?? 1);
  } else if (type === 'image') {
    const plate = imagePlateSize(clip, compW, compH);
    if (!plate) return null;
    width = plate.width;
    height = plate.height;
  } else {
    return null;
  }
  if (!(width > 0) || !(height > 0)) return null;

  return {
    width: width * scale,
    height: height * scale,
    // panX / panY are percentages of the frame, y measured downward.
    x: ((Number(item?.panX) || 0) / 100) * compW + offsetX * scale,
    y: -((Number(item?.panY) || 0) / 100) * compH + offsetY * scale,
  };
}

/* ── 3. Spawn tables — a layer's pixels as emission sites ─────────────────── */

// One entry per (artwork, count). Sampling a 512² raster is a few ms, and the
// result is reused by both the bake (positions) and the draw (colours).
const spawnCache = new Map();

/** Identity of a spawn table, for the simulation hash and this cache. */
export function spawnTableKey(source, count) {
  return `${objectRasterKey(source)}#${count}`;
}

/**
 * Sample `count` emission sites from a layer's artwork.
 *
 * Returns unit-space positions (+y UP, matching the solver's world) and the pixel
 * colour at each, so a dissolve keeps the picture it came from. Both the solver and
 * the renderer index this by `uid % count`: the same index derives position and
 * colour, so they cannot drift apart and no colour has to travel through the
 * snapshot cache.
 *
 * Sites are drawn from the opaque pixels only — sampling the whole rect would put
 * most of a word's particles in the space around its letters.
 */
/*
 * The OPAQUE PIXEL LIST for one artwork, cached on its own.
 *
 * Split out of ensureSpawnTable because a multi-source emitter has to know how
 * much artwork each source HAS before it can decide how many sites each one
 * gets — and asking for a table to find that out would mean building a table to
 * throw away. The scan is the expensive half (a full readback and a pass over
 * every pixel); the site sampling below is cheap and depends on the count.
 */
const opaqueCache = new Map();

export function ensureSpawnOpaque(source) {
  const key = objectRasterKey(source);
  if (!key) return null;
  const hit = opaqueCache.get(key);
  if (hit !== undefined) return hit;

  const raster = ensureObjectRaster(source, EMITTER_RASTER_PX);
  if (!raster?.ready || !raster.canvas) return null;   // still decoding; try next frame

  let data;
  try {
    const ctx = ctx2d(raster.canvas);
    data = ctx.getImageData(0, 0, raster.canvas.width, raster.canvas.height).data;
  } catch {
    // A cross-origin image taints the canvas and readback throws. The emitter
    // falls back to its box, which is wrong-looking but never broken.
    opaqueCache.set(key, null);
    return null;
  }

  const w = raster.canvas.width;
  const h = raster.canvas.height;
  // Counted first, then filled into a typed array: at the emission cap this list
  // runs to ~1M entries, and a plain Array of that many boxed numbers is both
  // megabytes and a GC pause.
  let opaqueCount = 0;
  for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] > 8) opaqueCount++;
  if (!opaqueCount) { opaqueCache.set(key, null); return null; }
  const opaque = new Int32Array(opaqueCount);
  for (let i = 0, k = 0; i < w * h; i++) if (data[i * 4 + 3] > 8) opaque[k++] = i;

  const out = { key, data, opaque, opaqueCount, w, h, aspect: raster.aspect };
  if (opaqueCache.size > 12) opaqueCache.clear();
  opaqueCache.set(key, out);
  return out;
}

export function ensureSpawnTable(source, count) {
  const key = spawnTableKey(source, count);
  const hit = spawnCache.get(key);
  if (hit) return hit;

  const O = ensureSpawnOpaque(source);
  if (!O) return null;
  const { data, opaque, opaqueCount, w, h } = O;

  const positions = new Float32Array(count * 2);
  const colors = new Uint8Array(count * 3);
  // Which pixel each site came from, in the raster's own grid. Positions are a
  // SIMULATION input and never change, but colour is drawn — so a video source
  // can re-read these same pixels from the frame playing now.
  const sites = new Int32Array(count);
  for (let n = 0; n < count; n++) {
    // Deterministic pick — the same table on every rebuild, and every machine that
    // rasterised the artwork the same way.
    const pixel = opaque[hash32(n * 2654435761) % opaqueCount];
    const px = pixel % w;
    const py = (pixel - px) / w;
    positions[n * 2] = (px + 0.5) / w - 0.5;
    positions[n * 2 + 1] = 0.5 - (py + 0.5) / h;   // canvas y is down, the world's is up
    colors[n * 3] = data[pixel * 4];
    colors[n * 3 + 1] = data[pixel * 4 + 1];
    colors[n * 3 + 2] = data[pixel * 4 + 2];
    sites[n] = pixel;
  }

  const table = { key, count, positions, colors, sites, rw: w, rh: h, aspect: O.aspect, opaqueCount };
  spawnCache.set(key, table);
  return table;
}

/**
 * ONE spawn table from SEVERAL artworks.
 *
 * Each source keeps its own on-screen rect, so a site is re-projected out of its
 * own artwork's unit square and into the EMITTER's — which leaves emission
 * completely unchanged downstream: it still reads a unit position and scales it
 * by the emitter's own size and position, exactly as it does for one source.
 *
 * SITES ARE SHARED BY ARTWORK AREA, not evenly. A word and a full-stop are not
 * two equal shares of a cloud: they are a lot of artwork and a little, and
 * splitting the pool down the middle leaves the word as scattered dots and the
 * full-stop as a solid blob. Weighting by opaque pixel count is what makes the
 * DENSITY match across sources, which is what "emit from these layers" means.
 *
 * `rects` is positional, one per source: { size: {x, y}, position: {x, y} } in
 * composition px. `emRect` is the emitter's own box, the space the result is
 * expressed in. A source with no usable artwork is skipped, so a decoding image
 * costs its share and not the whole table.
 */
export function ensureMultiSpawnTable(sources, count, rects, emRect) {
  const parts = sources.map((src, i) => ({ src, i, O: src ? ensureSpawnOpaque(src) : null }))
    .filter((p) => p.O);
  if (!parts.length) return null;
  if (parts.length === 1 && rects[parts[0].i] === undefined) return ensureSpawnTable(parts[0].src, count);

  const key = `multi:${count}|${emRect.size.x}x${emRect.size.y}@${emRect.position.x},${emRect.position.y}|`
    + parts.map((p) => {
      const r = rects[p.i] || emRect;
      return `${p.O.key}#${r.size.x}x${r.size.y}@${r.position.x},${r.position.y}`;
    }).join(';');
  const hit = spawnCache.get(key);
  if (hit) return hit;

  const total = parts.reduce((sum, p) => sum + p.O.opaqueCount, 0);
  // Largest-remainder, so the shares add up to `count` exactly rather than
  // leaving a handful of slots unfilled by rounding.
  const share = parts.map((p) => (p.O.opaqueCount / total) * count);
  const give = share.map((v) => Math.floor(v));
  let left = count - give.reduce((a, b) => a + b, 0);
  const order = share.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0 && k < order.length; k++, left--) give[order[k][1]]++;
  // A source that rounded to nothing still gets one, or picking it becomes a
  // hole in the emitter rather than a small contribution.
  for (let i = 0; i < give.length; i++) if (give[i] === 0 && count >= parts.length) { give[i] = 1; }

  const positions = new Float32Array(count * 2);
  const colors = new Uint8Array(count * 3);
  const sites = new Int32Array(count);
  // Which source each slot came from, so the caller can tell whose timeline gate
  // and whose colour a particle answers to.
  const owner = new Uint8Array(count);
  const ex = Math.max(1e-3, emRect.size.x), ey = Math.max(1e-3, emRect.size.y);

  let n = 0;
  for (let k = 0; k < parts.length && n < count; k++) {
    const { O, i } = parts[k];
    const r = rects[i] || emRect;
    const { data, opaque, opaqueCount, w, h } = O;
    const take = Math.min(give[k], count - n);
    for (let m = 0; m < take; m++, n++) {
      // The same deterministic pick, offset per source so two sources with the
      // same artwork do not choose identical pixels.
      const pixel = opaque[hash32((m * 2654435761) ^ (k * 40503)) % opaqueCount];
      const px = pixel % w;
      const py = (pixel - px) / w;
      const u = (px + 0.5) / w - 0.5;
      const v = 0.5 - (py + 0.5) / h;
      // source unit -> composition px -> emitter unit.
      const wx = r.position.x + u * r.size.x;
      const wy = r.position.y + v * r.size.y;
      positions[n * 2] = (wx - emRect.position.x) / ex;
      positions[n * 2 + 1] = (wy - emRect.position.y) / ey;
      colors[n * 3] = data[pixel * 4];
      colors[n * 3 + 1] = data[pixel * 4 + 1];
      colors[n * 3 + 2] = data[pixel * 4 + 2];
      sites[n] = pixel;
      owner[n] = i;
    }
  }

  const table = {
    key, count: n, positions, colors, sites, owner,
    rw: parts[0].O.w, rh: parts[0].O.h, aspect: parts[0].O.aspect,
    multi: parts.map((p) => p.i),
  };
  spawnCache.set(key, table);
  return table;
}

export function clearObjectRasters() {
  rasterCache.clear();
  imageCache.clear();
  spawnCache.clear();
  opaqueCache.clear();
}

/**
 * Re-read a layer emitter's colours from the frame its VIDEO source is showing
 * now. Positions stay exactly as they were baked — this only touches `colors`,
 * which is read at draw time — so nothing re-simulates and the particles carry
 * the moving picture instead of the frame the table happened to be built from.
 *
 * A no-op for still sources (nothing to follow) and while the element has no
 * frame yet. Returns true when the colours changed.
 */
export function refreshSpawnTableColors(table, source) {
  if (!table?.sites || source?.kind !== 'video') return false;
  const video = objectVideoElement(source);
  if (!video || !video.videoWidth) return false;
  // One decode per drawn frame at most: the element's own clock says whether
  // there is anything new to read.
  const at = video.currentTime;
  if (table.colorTime === at) return false;
  const frame = objectVideoFrame(source);
  if (!frame?.canvas) return false;
  let data;
  try {
    data = ctx2d(frame.canvas).getImageData(0, 0, frame.canvas.width, frame.canvas.height).data;
  } catch {
    return false;   // tainted element; keep the colours we have
  }
  const { sites, colors, rw, rh, count } = table;
  const W = frame.canvas.width, H = frame.canvas.height;
  for (let n = 0; n < count; n++) {
    const pixel = sites[n];
    const px = pixel % rw;
    const py = (pixel - px) / rw;
    // Same point of the picture, whatever the two rasters' sizes are.
    const sx = Math.min(W - 1, Math.max(0, Math.round(((px + 0.5) / rw) * W - 0.5)));
    const sy = Math.min(H - 1, Math.max(0, Math.round(((py + 0.5) / rh) * H - 0.5)));
    const o = (sx + sy * W) * 4;
    colors[n * 3] = data[o];
    colors[n * 3 + 1] = data[o + 1];
    colors[n * 3 + 2] = data[o + 2];
  }
  table.colorTime = at;
  return true;
}
