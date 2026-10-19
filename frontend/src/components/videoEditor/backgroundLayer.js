// Project background for the Video Editor: rasterizes a mockup-builder
// backgroundConfig ({type: solid|gradient|pattern|image|video|transparent, ...})
// into a canvas that the Player uses as the scene background — behind every
// timeline layer, identical in live preview, WebCodecs export, and the headless
// /video-render route.
//
// Solid colors fill directly. Gradients/patterns are CSS strings (shared
// presets), rasterized via an SVG <foreignObject> data URL — cached in the
// shared deterministic image cache. Images use the shared drawBackgroundMedia
// (cover/contain/custom + position + repeat). Video configs draw their base
// color only (use a video clip on the timeline for animated backgrounds).
import { getBackgroundCSS, drawBackgroundMedia, PATTERN_PRESETS } from '../mockupGenerator/BackgroundSelector';
import { getMotionImage } from './motionTemplates/mtl';
import { drawShaderToContext, shaderMaxDim, resolveShaderParams, shaderCodeFor } from '../../utils/shaderBackground';
import { buildCanvasGradient } from '../../utils/cssGradient';

// Triangle wave 0→1→0 so animated gradients loop seamlessly (ping-pong pan).
function pingpong(x) {
  const f = ((x % 2) + 2) % 2;
  return f > 1 ? 2 - f : f;
}

// True when the config must be redrawn every frame (time-driven): GLSL shaders
// and animated gradients. The Player repaints these in its render loop so they
// animate in preview and export alike.
export function isAnimatedBackground(config) {
  if (!config) return false;
  if (config.type === 'shader') return true;
  if (config.type === 'gradient' && config.gradientAnimated) return true;
  return false;
}

function patternTileUrl(config) {
  const preset = PATTERN_PRESETS.find((x) => x.id === config.patternId) || PATTERN_PRESETS[0];
  return `data:image/svg+xml,${encodeURIComponent(preset.svg(config.patternColor || '#ffffff'))}`;
}

function cssRasterUrl(css, W, H) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
    + `<foreignObject width="100%" height="100%">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${W}px;height:${H}px;background:${css}"></div>`
    + `</foreignObject></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// URLs this config needs decoded before it can draw completely — preload these
// (and await them before export) through the shared cache.
export function collectBackgroundUrls(config, W, H) {
  if (!config || !W || !H) return [];
  if (config.type === 'gradient') {
    return [cssRasterUrl(getBackgroundCSS(config), W, H)];
  }
  if (config.type === 'pattern') return [patternTileUrl(config)];
  if (config.type === 'image' && config.mediaUrl) return [config.mediaUrl];
  return [];
}

// Alpha (0..1) of a CSS colour string, 1 when it cannot be read. Only the forms
// the background picker writes: #rgb(a) / #rrggbb(aa) / rgb(a)() / 'transparent'.
export function cssColorAlpha(value) {
  if (typeof value !== 'string') return 1;
  const str = value.trim().toLowerCase();
  if (str === 'transparent') return 0;
  const hex = str.match(/^#([0-9a-f]{4}|[0-9a-f]{8})$/);
  if (hex) {
    const h = hex[1];
    return h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : parseInt(h.slice(6, 8), 16) / 255;
  }
  const fn = str.match(/^rgba?\(([^)]+)\)$/);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 4) return 1;
    const raw = parts[3];
    const n = raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
  }
  return 1;
}

// True when the config renders as a fully transparent background (keep the
// renderer's clear color / alpha export behavior). A SOLID colour with zero
// alpha is the same thing: the background picker writes rgba(0, 0, 0, 0) for
// "no background", and drawing it as a texture is not harmless — three's
// WebGPU background pass runs an OPAQUE node material, which forces alpha to
// 1 over the whole frame, so an alpha export / still came out solid black.
export function isTransparentBackground(config) {
  if (!config || config.type === 'transparent') return true;
  return config.type === 'solid' && cssColorAlpha(config.solidColor) === 0;
}

// Draw the background config into ctx (W×H). Asynchronously-loading assets that
// aren't ready yet draw as the base color; returns false in that case so the
// caller can repaint once the preloads resolve (the Player subscribes via
// collectBackgroundUrls + the shared cache promises).
export function drawEditorBackground(ctx, W, H, config, time = 0, opts = {}) {
  if (isTransparentBackground(config)) { ctx.clearRect(0, 0, W, H); return true; }

  const base = config.solidColor || '#050505';
  ctx.clearRect(0, 0, W, H);

  if (config.type === 'solid') {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    return true;
  }

  if (config.type === 'shader') {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    const err = drawShaderToContext(ctx, W, H, shaderCodeFor(config),
      time * (config.shaderSpeed ?? 1), {
        usageKey: opts.shaderKey || 'editor-bg',
        maxDim: shaderMaxDim(W, H, config, opts.maxDim || 2048),
        zoom: config.shaderZoom,
        params: resolveShaderParams(config),
      });
    return err == null; // on compile error the base color stands in
  }

  if (config.type === 'gradient') {
    // Animated: emulate CSS `background-size:200%` + position ping-pong by
    // panning the canvas gradient box over an oversized area. Falls back to the
    // static raster below if the CSS can't be parsed into stops.
    if (config.gradientAnimated) {
      const phase = pingpong(time * (config.gradientAnimSpeed ?? 1) * 0.2);
      const box = { x: -phase * W, y: -phase * H, w: 2 * W, h: 2 * H };
      const grad = buildCanvasGradient(ctx, getBackgroundCSS(config), box);
      if (grad) {
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
        return true;
      }
    }
    const entry = getMotionImage(cssRasterUrl(getBackgroundCSS(config), W, H));
    if (entry?.loaded) {
      ctx.drawImage(entry.img, 0, 0, W, H);
      return true;
    }
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    return entry?.failed === true; // failed = final state, don't wait forever
  }

  if (config.type === 'pattern') {
    // Nested data-URI images don't load inside an SVG foreignObject raster, so
    // patterns tile natively: base fill + ctx.createPattern of the scaled tile.
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    const entry = getMotionImage(patternTileUrl(config));
    if (!entry?.loaded) return entry?.failed === true;
    const scale = Math.max(0.01, (config.patternScale || 100) / 100);
    const tw = Math.max(1, Math.round((entry.img.naturalWidth || 20) * scale));
    const th = Math.max(1, Math.round((entry.img.naturalHeight || 20) * scale));
    const tile = document.createElement('canvas');
    tile.width = tw;
    tile.height = th;
    tile.getContext('2d').drawImage(entry.img, 0, 0, tw, th);
    ctx.fillStyle = ctx.createPattern(tile, 'repeat');
    ctx.fillRect(0, 0, W, H);
    return true;
  }

  if (config.type === 'image' && config.mediaUrl) {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    const entry = getMotionImage(config.mediaUrl);
    if (entry?.loaded) {
      drawBackgroundMedia(ctx, W, H, entry.img, config);
      return true;
    }
    return entry?.failed === true;
  }

  // 'video' (and anything unknown): base color only.
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);
  return true;
}
