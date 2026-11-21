/*
 * (hdrscene) An HDR render of a 3D Scene alone keeps the Scene's own light.
 *
 * The compositor is 8-bit, so an HDR render of a project has always carried its SDR picture: white at 203 cd/m² and nothing brighter
 * (backend/render_pro.py). When the render is the Scene and nothing else (no 2D layer, card, effect or transition over or under it), the
 * picture IS the world's: the world then films each frame a second time through its HDR view (world3d/render/tone.js) into a float target,
 * and that frame goes to the backend as raw planar half floats (sceneLightFrame: linear BT.709 light, 1 = SDR white) instead of the 8-bit
 * PNG. Below
 * diffuse white it is the SDR picture's own light; above it the highlights get the room up to 1000 cd/m².
 *
 * Anything else, and the render is today's: `sceneOnlyReason` names what stops it before the first frame, and the first frame the world draws
 * is checked against the compositor's own picture (sameSdr) before any frame leaves. A frame of such a render that the world did not draw
 * (no Scene at that time, motion blur accumulated over 2D sub-frames) goes out as its 8-bit picture placed at SDR white (sdrToHalf), and is
 * counted.
 *
 * (hdr2) A render with 2D layers too (a title, a card, a lower third, a fade or a common transition) composites each frame a second time in
 * half floats (hdrComposite.js): the Scene's plate carries the world's own light, every other layer is drawn exactly as in the SDR export
 * (display values, graphics white = SDR white = 203 cd/m², BT.2408) and blends, fades, masks and transitions run as the compositor defines
 * them, in float, so nothing above white is clipped. `hdrFloatReason` names what that float composite cannot carry yet; each new set of
 * layers is checked against the compositor's own 8-bit picture (sameComposite) before its frames go out as light.
 *
 * Nothing here runs unless a render asks for HDR: an SDR render's frames, the preview and the world are as they were.
 */

import { hybridToLight } from './hdrYuv.js';

// planar half floats: G, B, R planes (and A when the render keeps alpha), the order ffmpeg's gbrpf16le / gbrapf16le hold them in. Packed
// rgbaf16le would go through swscale on its way to zscale, and that clips every value above 1.0 (backend/render_pro.py SCENE_LIGHT_FRAMES).
export const sceneLightFrame = (alpha) => (alpha ? 'gbrapf16le' : 'gbrpf16le');

// Layer fields that place a layer in time or name it: none of them changes the picture.
const TIME_KEYS = new Set(['id', 'clipId', 'rig', 'name', 'label', 'color', 'locked', 'muted', 'volume', 'notes', 'tags', 'selected',
  'start', 'startTime', 'freeStart', 'freeEnd', 'trimStart', 'trimEnd', 'duration', 'speed', 'speedPoints', 'linkId', 'linkedId', 'groupId',
  'createdAt', 'updatedAt', 'source', 'origin']);
// Channel fields the same way.
const CHANNEL_KEYS = new Set(['id', 'name', 'kind', 'visible', 'unsnapped', 'locked', 'muted', 'solo', 'collapsed', 'height', 'color', 'items',
  'cameraLocked', 'expanded', 'label']);
// Every layer carries every kind's fields at their defaults (VideoEditor makeTimelineItem): a Scene draws none of a text's, a shape's or a
// line's, and an easing, a duration or a transition's own settings do nothing while its type is none.
const NOT_FOR_A_SCENE = /^(text|shape|line|custom)|(Easing|Duration)$|^(keyframeTransformOrigin|motionPathT|borderRadiusLinked|borderStyle|borderColor|clipMaskInvert)$/;
// A field that holds one of these is not set (an empty list, an effect switched off, a transition of type none).
const UNSET_WORDS = new Set(['', 'none', 'None', 'NONE', 'normal', 'off']);
const ONE_KEYS = new Set(['scale', 'scaleX', 'scaleY', 'scaleZ', 'zoom']);
const HUNDRED_KEYS = new Set(['opacity', 'filterBrightness', 'filterContrast', 'filterSaturation', 'volume']);
// Media that draws nothing.
const SILENT_MEDIA = new Set(['audio', 'null']);
const SILENT_CHANNELS = new Set(['audio', 'voice']);

function unset(key, value) {
  if (value == null || value === false) return true;
  if (typeof value === 'number') return ONE_KEYS.has(key) ? value === 1 : HUNDRED_KEYS.has(key) ? value === 100 : value === 0;
  if (typeof value === 'string') return UNSET_WORDS.has(value);
  if (Array.isArray(value)) return value.every((v) => v && typeof v === 'object' && (v.muted === true || v.enabled === false));
  if (typeof value === 'object') return value.enabled === false || Object.entries(value).every(([k, v]) => unset(k, v));
  return false;
}

const BLACK = /^(#0{3}|#0{6}|#0{8}|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(,\s*[\d.]+\s*)?\))$/i;

/**
 * Why a render of [start, end) (timeline seconds) cannot keep its Scene's own light: one sentence, or null when it can.
 * `channels`, `clipsMap`, `layoutMap` as the editor holds them; `background` the project's (engine.background); `size` the composition's
 * and `outSize` the render's ({ w, h }); `isWorldRig(rig)` whether a layer's rig is a world Scene.
 */
export function sceneOnlyReason({ channels = [], clipsMap = new Map(), layoutMap = new Map(), background = null, start = 0, end = Infinity, size, outSize, isWorldRig }) {
  if (size && outSize && (Math.round(size.w) !== Math.round(outSize.w) || Math.round(size.h) !== Math.round(outSize.h))) {
    return `the render's size (${outSize.w}x${outSize.h}) is not the video's (${size.w}x${size.h})`;
  }
  const bg = background && typeof background === 'object' ? background : null;
  if (bg && bg.type && bg.type !== 'transparent' && !(bg.type === 'solid' && BLACK.test(String(bg.solidColor ?? bg.color ?? '#000000').trim()))) {
    return `the project's background (${bg.type}) is not black`;
  }
  const shown = [];
  let scenes = 0;
  for (const ch of channels) {
    if (!ch || ch.visible === false || SILENT_CHANNELS.has(ch.kind)) continue;
    const layout = layoutMap.get(ch.id) || [];
    (ch.items || []).forEach((item, i) => {
      const entry = layout[i];
      const clip = clipsMap.get(item?.clipId);
      if (!entry || !clip || SILENT_MEDIA.has(clip.mediaType)) return;
      const t0 = Number(entry.startTime), t1 = Number(entry.endTime ?? (entry.startTime + entry.duration));
      if (!(t1 > start && t0 < end)) return;
      shown.push({ ch, item, clip, t0, t1 });
    });
  }
  for (const s of shown) {
    const what = s.clip.mediaType === 'rig' ? 'Scene' : `${s.clip.mediaType || 'a'} layer${s.ch.name ? ` "${s.ch.name}"` : ''}`;
    if (s.clip.mediaType !== 'rig' || !isWorldRig?.(s.item.rig)) return `a ${what} is drawn with the Scene`;
    scenes += 1;
    for (const [k, v] of Object.entries(s.ch)) if (!CHANNEL_KEYS.has(k) && !unset(k, v)) return `the Scene's channel has "${k}" set`;
    for (const [k, v] of Object.entries(s.item)) if (!TIME_KEYS.has(k) && !NOT_FOR_A_SCENE.test(k) && !unset(k, v)) return `the Scene layer has "${k}" set`;
    const look = s.item.rig?.scene?.look || {};
    if (look.tone === 'plate' || Number(look.soften) > 0 || Number(look.black) > 0 || Number(look.sharpen) > 0 || Number(look.wrap) > 0) {
      return 'the Scene is filmed into footage (look.tone / soften / black / sharpen / wrap)';
    }
    // a Scene's own 2D layer is drawn over its finished SDR picture, unless it takes the scene's light (receiveShadow)
    if ((s.item.rig?.scene?.layers || []).some((l) => l && !l.receiveShadow)) return 'the Scene draws 2D layers over its picture (scene.layers)';
  }
  for (let i = 0; i < shown.length; i += 1) {
    for (let j = i + 1; j < shown.length; j += 1) {
      if (shown[i].t0 < shown[j].t1 && shown[j].t0 < shown[i].t1) return 'two Scenes overlap in time';
    }
  }
  return scenes ? null : 'the render has no 3D Scene';
}

// ── (hdr2) The float composite: what it carries ───────────────────────────────────────────────────────────────────────────────────────
// What a Scene layer may have and still go through the float composite: where and when it is, how it moves, its opacity, a blend the GPU
// blends (normal, add, screen, multiply, lighten, darken) and the common transitions. Anything else set on it (an effect, a filter, a
// mask, a matte, a colour correction, a border) is not carried yet: the render goes the old way and says which field.
// (hdr3) and its grade (brightness, contrast, saturation, hue, grayscale, sepia, invert, tint, blur: the clip shader's filters), carried at
// the grade's slope above white (compositeNodes.js createHdrPlateNodeMaterial)
const SCENE_FLOAT_KEYS = new Set(['rig', 'opacity', 'blendMode', 'zoom', 'scale', 'scaleX', 'scaleY', 'panX', 'panY', 'panZ', 'rotateX', 'rotateY',
  'rotateZ', 'rotation', 'propertyKeyframes', 'transition', 'transitionDuration', 'transitionEasing', 'transitionOptions', 'transitionOrder',
  'transitionInType', 'transitionInDuration', 'transitionInEasing', 'transitionInOptions', 'transitionOutType', 'transitionOutDuration',
  'transitionOutEasing', 'transitionOutOptions', 'filterBrightness', 'filterContrast', 'filterSaturation', 'filterHueRotate', 'filterGrayscale',
  'filterSepia', 'filterInvert', 'filterBlur']);
// keyframe tracks that move, fade or (hdr3) grade a layer (keyframeProps.js, Transform and Filters)
const MOVE_TRACKS = new Set(['opacity', 'scale', 'scaleX', 'scaleY', 'rotate', 'rotateX', 'rotateY', 'rotateZ', 'translateX', 'translateY', 'translateZ',
  'xPercent', 'yPercent', 'motionPathT', 'motionPathOffsetX', 'motionPathOffsetY', 'motionPathOffsetZ',
  'brightness', 'contrast', 'saturate', 'hue-rotate', 'grayscale', 'sepia', 'invert', 'blur', 'color']);
// the transitions drawn by the layer's own shader (opacity, a moving or scaled plate, a straight or round wipe): checked in float
const FLOAT_CROSS = new Set(['None', 'Cross Fade', 'Dip to Black', 'Push', 'Wipe', 'Zoom In', 'Zoom Out']);
const FLOAT_LAYER = new Set(['None', 'Fade', 'Dip to Black', 'Slide', 'Wipe', 'Zoom In', 'Zoom Out']);
const liveEffect = (e) => e && typeof e === 'object' && e.muted !== true && e.enabled !== false;

/**
 * (hdr2) Why an HDR render of [start, end) cannot keep its Scene's light even through the float composite: one sentence, or null when it
 * can. Same inputs as sceneOnlyReason (`size` / `outSize` / `background` are not needed: the float composite draws the background and
 * takes any size). What is drawn with the Scene must meet its light as the GPU blends it: an adjustment layer that grades, a blend mode
 * the compositor computes from the picture below, a backdrop blur or glass, a luma matte read off the Scene or an effect that reads the
 * Scene's picture are not carried yet. Wherever such a layer is in the channel list: a flat layer stands in the Scene's depth (the
 * compositor sorts it by distance), so its place in the list does not say whether it is drawn over the Scene.
 */
export function hdrFloatReason({ channels = [], clipsMap = new Map(), layoutMap = new Map(), start = 0, end = Infinity, isWorldRig }) {
  const shown = [];
  channels.forEach((ch) => {
    if (!ch || ch.visible === false || SILENT_CHANNELS.has(ch.kind)) return;
    const layout = layoutMap.get(ch.id) || [];
    (ch.items || []).forEach((item, i) => {
      const entry = layout[i];
      const clip = clipsMap.get(item?.clipId);
      if (!entry || !clip || SILENT_MEDIA.has(clip.mediaType)) return;
      const t0 = Number(entry.startTime), t1 = Number(entry.endTime ?? (entry.startTime + entry.duration));
      if (!(t1 > start && t0 < end)) return;
      shown.push({ ch, item, clip, t0, t1, i });
    });
  });
  const scenes = shown.filter((x) => x.clip.mediaType === 'rig' && isWorldRig?.(x.item.rig));
  if (!scenes.length) return 'the render has no 3D Scene';
  for (let i = 0; i < scenes.length; i += 1) {
    for (let j = i + 1; j < scenes.length; j += 1) {
      if (scenes[i].t0 < scenes[j].t1 && scenes[j].t0 < scenes[i].t1) return 'two Scenes overlap in time';
    }
  }
  for (const sc of scenes) {
    const { item } = sc;
    for (const [k, v] of Object.entries(item)) {
      if (TIME_KEYS.has(k) || NOT_FOR_A_SCENE.test(k) || SCENE_FLOAT_KEYS.has(k) || unset(k, v)) continue;
      return `the Scene layer has "${k}" set`;
    }
    for (const [k, v] of Object.entries(sc.ch)) if (!CHANNEL_KEYS.has(k) && k !== 'cameraLocked' && !unset(k, v)) return `the Scene's channel has "${k}" set`;
    // (hdr3) any blend mode: the float composite's blend pass carries the light above white (blendCompositeNodes.js blendHybrid)
    for (const [track, keys] of Object.entries(item.propertyKeyframes || {})) {
      if (Array.isArray(keys) && keys.length && !MOVE_TRACKS.has(track)) return `the Scene layer has "${track}" keys`;
    }
    if (!FLOAT_CROSS.has(item.transition || 'None')) return `the Scene's transition (${item.transition}) is not carried in float yet`;
    for (const slot of ['transitionInType', 'transitionOutType']) {
      if (!FLOAT_LAYER.has(item[slot] || 'None')) return `the Scene's ${slot === 'transitionInType' ? 'entrance' : 'exit'} (${item[slot]}) is not carried in float yet`;
    }
    // the clip after the Scene on its own channel, crossing into it
    const next = sc.ch.items?.[sc.i + 1];
    if (next && !FLOAT_CROSS.has(next.transition || 'None')) return `the transition out of the Scene (${next.transition}) is not carried in float yet`;
    const look = item.rig?.scene?.look || {};
    if (look.tone === 'plate' || Number(look.soften) > 0 || Number(look.black) > 0 || Number(look.sharpen) > 0 || Number(look.wrap) > 0) {
      return 'the Scene is filmed into footage (look.tone / soften / black / sharpen / wrap)';
    }
    if ((item.rig?.scene?.layers || []).some((l) => l && !l.receiveShadow)) return 'the Scene draws 2D layers over its picture (scene.layers)';
    const draft = item.rig?.render?.mode !== 'final';
    // what is drawn over it while it shows
    for (const o of shown) {
      if (o === sc || !(o.t0 < sc.t1 && sc.t0 < o.t1)) continue;
      const name = `${o.clip.mediaType || 'a'} layer${o.ch.name ? ` "${o.ch.name}"` : ''}`;
      // the Camera layer films the whole stack: its depth of field blurs a Draft Scene's light, and a solved lens bends its plate
      if (o.clip.mediaType === 'camera' || o.ch.kind === 'camera') {
        const keyed = (k) => Number(o.item[k]) || (o.item.propertyKeyframes?.[k] || []).some((kf) => Number(kf?.v ?? kf?.value));
        if (draft && keyed('camDofEnabled')) return "the Camera layer's depth of field blurs the Scene";
        if (keyed('camLensK1')) return "the Camera layer bends the Scene with a solved lens";
        continue;
      }
      // a layer that reads the Scene: a luma matte, or an effect that takes its picture
      const matte = o.item.trackMatte;
      if (matte && matte.sourceId === item.id && /luma/i.test(String(matte.mode || ''))) return `the ${name} takes a luma matte from the Scene`;
      if ((o.item.effects || []).some((e) => liveEffect(e) && Object.values(e.params || {}).includes(item.id))) return `an effect on the ${name} reads the Scene's picture`;
      if (o.clip.mediaType === 'adjustment') {
        // (hdr3) a move, a zoom, a blur, its opacity, its mask and its grade (brightness, contrast, saturation, hue, grayscale, sepia,
        // invert, tint) are carried: the grade is the SDR export's up to white and continues at its own slope above it (compositeNodes.js
        // gradeHybrid). Its effects chain and LUT are not carried yet.
        const adj = `the adjustment layer${o.ch.name ? ` "${o.ch.name}"` : ''} over the Scene`;
        if ((o.item.effects || []).some(liveEffect) || o.item.lut) return `${adj} runs effects on it`;
        continue;
      }
      // (hdr3) shader blend modes, Backdrop Blur and Glass read the Scene's picture in float (their twins in hdrComposite.js)
    }
  }
  return null;
}

// sRGB display values (8-bit) to display light as half floats: the 8-bit picture placed at SDR white = 1, as the backend's 8-bit HDR encode does
let srgbHalf = null;
function srgbHalfTable() {
  if (srgbHalf) return srgbHalf;
  srgbHalf = new Uint16Array(256);
  for (let i = 0; i < 256; i += 1) {
    const e = i / 255;
    srgbHalf[i] = toHalf(e <= 0.04045 ? e / 12.92 : ((e + 0.055) / 1.055) ** 2.4);
  }
  return srgbHalf;
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
/** A float to IEEE half (round to nearest), for values in [0, 65504]. */
export function toHalf(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return sign;
    m |= 0x800000;
    const shift = 14 - e;
    let h = m >>> shift;
    if ((m >>> (shift - 1)) & 1) h += 1;
    return sign | h;
  }
  if (e >= 31) return sign | 0x7c00;
  let h = sign | (e << 10) | (m >>> 13);
  if (m & 0x1000) h += 1;
  return h;
}

let halfFloat = null;
/** IEEE half -> float, as a table over every 16-bit pattern. */
export function halfTable() {
  if (halfFloat) return halfFloat;
  halfFloat = new Float32Array(65536);
  for (let h = 0; h < 65536; h += 1) {
    const s = h & 0x8000 ? -1 : 1, e = (h >>> 10) & 0x1f, m = h & 0x3ff;
    halfFloat[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return halfFloat;
}

/** An 8-bit RGBA frame (straight colour, as a canvas reads it) as rgba half floats: display light, 1 = SDR white. `alpha` keeps its
 *  coverage; otherwise the frame is opaque. */
export function sdrToHalf(rgba, { alpha = false } = {}) {
  const t = srgbHalfTable(), one = toHalf(1);
  const out = new Uint16Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = t[rgba[i]]; out[i + 1] = t[rgba[i + 1]]; out[i + 2] = t[rgba[i + 2]];
    out[i + 3] = alpha ? toHalf(rgba[i + 3] / 255) : one;
  }
  return out;
}

/** A frame (rgba half floats, packed) as the planes the backend takes (G, B, R, and A with `alpha`), and its light for MaxCLL / MaxFALL
 *  (CTA-861.3): its brightest channel anywhere, and the mean over pixels of each one's brightest channel, in SDR whites, as the file holds
 *  them (BT.2020 components: a saturated BT.709 colour's brightest channel is a little lower there). */
export function framePlanes(half, { alpha = false, lut = null } = {}) {
  const t = halfTable();
  const n = half.length >> 2;
  const planes = new Uint16Array(n * (alpha ? 4 : 3));
  const pg = 0, pb = n, pr = 2 * n, pa = 3 * n;
  let most = 0, sum = 0;
  // (hdr2) `lut`: each colour channel's half float looked up first (displayLightTable: the float composite's display values to light), and
  // a colour past the 1000 cd/m² peak (a 2D layer added onto the Scene's brightest light) brought down as a whole, its hue kept
  if (lut) {
    for (let p = 0, i = 0; p < n; p += 1, i += 4) {
      let hr = lut[half[i]], hg = lut[half[i + 1]], hb = lut[half[i + 2]];
      let r0 = t[hr], g0 = t[hg], b0 = t[hb];
      const top = r0 > g0 ? (r0 > b0 ? r0 : b0) : (g0 > b0 ? g0 : b0);
      if (top > LIGHT_PEAK) {
        const k = LIGHT_PEAK / top;
        hr = toHalf(r0 * k); hg = toHalf(g0 * k); hb = toHalf(b0 * k);
        r0 = t[hr]; g0 = t[hg]; b0 = t[hb];
      }
      planes[pg + p] = hg; planes[pb + p] = hb; planes[pr + p] = hr;
      if (alpha) planes[pa + p] = half[i + 3];
      const r = 0.6274 * r0 + 0.3293 * g0 + 0.0433 * b0, g = 0.0691 * r0 + 0.9195 * g0 + 0.0114 * b0, b = 0.0164 * r0 + 0.0880 * g0 + 0.8956 * b0;
      const m = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (m > most) most = m;
      if (m > 0) sum += m;
    }
    return { planes, light: { max: most, mean: n ? sum / n : 0 } };
  }
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    const hr = half[i], hg = half[i + 1], hb = half[i + 2];
    planes[pg + p] = hg; planes[pb + p] = hb; planes[pr + p] = hr;
    if (alpha) planes[pa + p] = half[i + 3];
    const r0 = t[hr], g0 = t[hg], b0 = t[hb];
    const r = 0.6274 * r0 + 0.3293 * g0 + 0.0433 * b0, g = 0.0691 * r0 + 0.9195 * g0 + 0.0114 * b0, b = 0.0164 * r0 + 0.0880 * g0 + 0.8956 * b0;
    const m = r > g ? (r > b ? r : b) : (g > b ? g : b);
    if (m > most) most = m;
    if (m > 0) sum += m;
  }
  return { planes, light: { max: most, mean: n ? sum / n : 0 } };
}

/**
 * Whether the compositor's 8-bit frame (`canvas`: straight RGBA, rows top first) is the world's own SDR picture (`world`: premultiplied
 * RGBA from its tone pass, the coverage in alpha): an opaque render shows it over black. `alpha`: the render keeps coverage (the canvas
 * is then straight colour with that coverage). { same, meanDiff, off } — `off` the share of pixels more than 3 levels apart.
 */
export function sameSdr(canvas, world, { alpha = false } = {}) {
  if (!canvas || !world || canvas.length !== world.length) return { same: false, meanDiff: Infinity, off: 1 };
  let diff = 0, off = 0, n = 0;
  for (let i = 0; i < canvas.length; i += 4) {
    const a = alpha ? canvas[i + 3] / 255 : 1;
    for (let c = 0; c < 3; c += 1) {
      const d = Math.abs(canvas[i + c] * a - world[i + c]);
      diff += d;
      if (d > 3) { off += 1; break; }
    }
    n += 1;
  }
  const meanDiff = diff / (3 * Math.max(1, n));
  const share = off / Math.max(1, n);
  return { same: meanDiff < 0.75 && share < 0.002, meanDiff, off: share };
}

// ── (hdr2) The float composite's frame: its numbers in float to light ─────────────────────────────────────────────────────────────────
// The HDR view's peak in SDR whites (world3d/render/tone.js HDR_PEAK: 1000 cd/m² over 203): the world's light never passes it, and a 2D
// layer added or screened onto it is brought down to it, hue kept, as the world brings its own colours down
const LIGHT_PEAK = 1000 / 203;
let displayHalf = null;
/** Every half float as one of the float composite's numbers to its light, as a half float, so one lookup a channel turns a frame into
 *  light (1 = SDR white). (hdr3) The stack holds display values up to white and light above it (hdrComposite.js): a number at or below 1
 *  goes through the sRGB curve, one above it is light already (hdrYuv.js hybridToLight). Negative and NaN are black. */
export function displayLightTable() {
  if (displayHalf) return displayHalf;
  const t = halfTable();
  displayHalf = new Uint16Array(65536);
  for (let h = 0; h < 65536; h += 1) displayHalf[h] = toHalf(hybridToLight(t[h]));
  return displayHalf;
}

/**
 * The float composite's frame (`enc`: rgba half floats, its numbers premultiplied as the compositor keeps them, rows top first) as the
 * frame the backend takes: rgba half floats of light, 1 = SDR white. An opaque render's alpha is 1; one that keeps alpha has its colour
 * made straight first, as the 8-bit path's frames are.
 */
export function compositeLight(enc, { alpha = false } = {}) {
  const lut = displayLightTable(), one = toHalf(1);
  const out = new Uint16Array(enc.length);
  const t = halfTable();
  if (!alpha) {
    for (let i = 0; i < enc.length; i += 4) {
      out[i] = lut[enc[i]]; out[i + 1] = lut[enc[i + 1]]; out[i + 2] = lut[enc[i + 2]]; out[i + 3] = one;
      const top = Math.max(t[out[i]], t[out[i + 1]], t[out[i + 2]]);
      if (top > LIGHT_PEAK) for (let c = 0; c < 3; c += 1) out[i + c] = toHalf((t[out[i + c]] * LIGHT_PEAK) / top);
    }
    return out;
  }
  const light = hybridToLight;
  for (let i = 0; i < enc.length; i += 4) {
    const a = Math.min(1, Math.max(0, t[enc[i + 3]] || 0));
    if (a <= 1e-5) { out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0; continue; }
    const vr = t[enc[i]] / a, vg = t[enc[i + 1]] / a, vb = t[enc[i + 2]] / a;
    const r = vr > 0 ? light(vr) : 0, g = vg > 0 ? light(vg) : 0, b = vb > 0 ? light(vb) : 0;
    const top = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const k = top > LIGHT_PEAK ? LIGHT_PEAK / top : 1;
    out[i] = toHalf(r * k); out[i + 1] = toHalf(g * k); out[i + 2] = toHalf(b * k);
    out[i + 3] = toHalf(a);
  }
  return out;
}

/**
 * Whether the float composite (`enc`: rgba half floats, display values, premultiplied) is the compositor's own 8-bit picture of the same
 * frame (`canvas`: straight RGBA bytes, as a canvas reads it) wherever the float one is within white: the same layers, drawn the same way.
 * Pixels above white (the Scene's highlights, which the 8-bit picture clips) are not compared. { same, meanDiff, off, above } — `off` the
 * share of compared pixels more than 3 levels apart, `above` the share of pixels above white.
 */
export function sameComposite(canvas, enc, { alpha = false } = {}) {
  if (!canvas || !enc || canvas.length !== enc.length) return { same: false, meanDiff: Infinity, off: 1, above: 0 };
  const t = halfTable();
  const top = 1 + 0.5 / 255;
  let diff = 0, off = 0, n = 0, above = 0;
  for (let i = 0; i < enc.length; i += 4) {
    const r = t[enc[i]], g = t[enc[i + 1]], b = t[enc[i + 2]];
    if (r > top || g > top || b > top) { above += 1; continue; }
    const a = alpha ? canvas[i + 3] / 255 : 1;
    let far = false;
    for (let c = 0; c < 3; c += 1) {
      const d = Math.abs(canvas[i + c] * a - t[enc[i + c]] * 255);
      diff += d;
      if (d > 3) far = true;
    }
    if (far) off += 1;
    n += 1;
  }
  const meanDiff = diff / (3 * Math.max(1, n));
  const share = off / Math.max(1, n);
  return { same: meanDiff < 0.75 && share < 0.002, meanDiff, off: share, above: above / Math.max(1, enc.length / 4) };
}

/** One line for the render's result: what an HDR render of this project carries. `composite`: its 2D layers came through the float
 *  composite, at SDR white. */
export function hdrSceneNote({ light, reason, frames = 0, sdrFrames = 0, composite = false }) {
  if (!light || (frames > 0 && sdrFrames >= frames)) {
    return `HDR: ${reason || 'the picture is not the Scene alone'}, so this file carries the picture with SDR white at 203 cd/m² and nothing brighter.`;
  }
  const own = composite ? "HDR: the Scene's own light (highlights up to 1000 cd/m²), with the 2D layers at SDR white (203 cd/m²)" : "HDR: the Scene's own light (highlights up to 1000 cd/m²)";
  if (sdrFrames) return `${own}; ${sdrFrames} of ${frames} frames had no Scene of their own and carry SDR white at 203 cd/m²${reason ? ` (${reason})` : ''}.`;
  return composite ? `${own}.` : "HDR: the Scene's own light, highlights up to 1000 cd/m².";
}

/**
 * The render's side of it: `start(reason, mode)` before the first frame; then `frame(read8)` after each frame is drawn — `read8()` the
 * compositor's 8-bit RGBA — which answers { data, kind, light } (the frame to send), or null: send it as today's PNG.
 *   mode 'scene' (no reason): the Scene alone, its frames the world's own light (`world` = { hdrFrame: () => Promise<{data,width,height}|null>,
 *     sdrPixels: () => Promise<{data}|null>, off() }; hdrFrame's `data`: rgba half floats, packed, rows top first).
 *   mode 'composite' (hdr2): 2D layers with the Scene; every frame is the float composite's (`composite.frame`), checked against the 8-bit
 *     picture once for each new set of layers (`signature()`: a key of what the frame draws).
 *   a reason and no mode: today's PNG frames, and the reason in the note.
 * Either light mode takes a frame averaged over 2D sub-frames (`accumulated()`) from the float composite's own average of them.
 * `composite` = { frame({ accumulated, read8 }) → Promise<{ data: rgba half floats, display values premultiplied, rows top first, at the
 * render's size; scene: whether the Scene's light was in it; check?: a sameComposite answer when read8 was given } | null>, dispose() }.
 */
export function createSceneLight({ world, width, height, alpha = false, accumulated = () => false, worldDrew = () => true, composite = null, signature = () => '',
  encoder = null }) {
  const s = { light: false, mode: null, reason: null, frames: 0, sdrFrames: 0, checked: false, peak: 0, fall: 0, msWorld: 0, msPlanes: 0, msFrame: 0,
    okSigs: new Set(), badSigs: new Set(), checks: 0, blurred: 0, fault: null };
  // (hdr3) an HDR MP4's frames leave as the file's own 4:2:0 planes, luma-adjusted on the GPU (hdrEncode.js); ProRes keeps the planar floats
  const kind = encoder ? 'yuv420p10le' : sceneLightFrame(alpha);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const noOwnPicture = () => (s.light && s.frames && s.sdrFrames >= s.frames ? 'the 3D Scene drew no picture of its own on any frame' : null);
  // a frame that goes through the float composite: every frame of a composite render, and a Scene-alone frame averaged over 2D sub-frames
  const viaComposite = () => !!composite && (s.mode === 'composite' || accumulated());
  const sigNow = () => `${signature()}${accumulated() ? '|blur' : ''}`;
  const ready = (sig) => s.okSigs.has(sig);
  const done = (bytes, light, t0, t1) => {
    s.frames += 1;
    s.msWorld += t1 - t0;
    s.msPlanes += now() - t1;
    if (light.max > s.peak) s.peak = light.max;
    if (light.mean > s.fall) s.fall = light.mean;
    return { data: bytes, kind, light };
  };
  // a frame of light (rgba half floats; `hybrid`: the float composite's numbers, `lut` turning them into light on the CPU)
  const finish = async (data, t0, t1, { lut = null, hybrid = false } = {}) => {
    if (encoder) {
      const enc = await encoder.encodeData(data, { hybrid });
      return done(enc.data, enc.light, t0, t1);
    }
    const { planes, light } = framePlanes(data, { alpha, lut });
    return done(new Uint8Array(planes.buffer, planes.byteOffset, planes.byteLength), light, t0, t1);
  };
  const off = () => { s.light = false; world.off(); composite?.dispose?.(); };
  return {
    report: () => ({ light: s.light && s.sdrFrames < s.frames, route: s.light ? kind : 'png', frames: s.frames, sdrFrames: s.sdrFrames,
      // every frame without a world picture of its own (the Scene never drew one: its scene failed to build) says so
      reason: s.reason || noOwnPicture(),
      peak: s.peak, fall: s.fall, check: s.check || null,
      // (hdr2) how the frames were made: the Scene alone ('scene') or the float composite with its 2D layers ('composite'); how many sets of
      // layers were checked against the 8-bit picture; frames averaged over 2D sub-frames in float
      ...(s.mode ? { mode: s.mode, checks: s.checks, blurred: s.blurred } : {}),
      note: hdrSceneNote({ ...s, composite: s.mode === 'composite', reason: s.reason || noOwnPicture() }),
      // where a frame's time went (ms a frame): the world's HDR pass and its read-back (or the float composite), the planes and the light
      ms: s.frames ? { frame: Math.round((s.msFrame / s.frames) * 10) / 10, world: Math.round((s.msWorld / s.frames) * 10) / 10,
        planes: Math.round((s.msPlanes / s.frames) * 10) / 10 } : null }),
    /** The whole frame's time (drawn, read, sent), for the report. */
    frameDone(ms) { s.msFrame += ms; },
    /** Whether this frame will go out as light without the compositor's 8-bit picture. Scene alone: checked already, the world drew it, and
     *  it is not an average of 2D sub-frames. Through the float composite: its set of layers was checked already. */
    /** Whether the frame being drawn goes through the float composite with a set of layers not checked yet (its 2D sub-frames then
     *  average their SDR-plate float composite too, for that check). */
    checkDue: () => s.light && viaComposite() && !ready(sigNow()) && !s.badSigs.has(sigNow()),
    lightOnly: () => {
      if (!s.light) return false;
      if (viaComposite()) return ready(sigNow());
      return s.checked && !!s.check?.same && !accumulated() && worldDrew();
    },
    start(reason, mode = null) {
      s.reason = reason || null;
      s.mode = mode || (reason ? null : 'scene');
      s.light = !!s.mode;
      // the float composite's own line is its reason for not being the Scene alone: kept only when it falls back
      if (s.mode === 'composite') s.reason = null;
      if (!s.light) off();
    },
    async frame(read8) {
      if (!s.light) return null;
      const t0 = now();
      if (viaComposite()) {
        const sig = sigNow();
        const blur = accumulated();
        let out = null;
        if (!s.badSigs.has(sig)) {
          try {
            out = await composite.frame({ accumulated: blur, read8: ready(sig) ? null : read8 });
          } catch (e) {
            s.fault = String(e?.message || e);
            console.warn('[hdr2] the float composite failed on this frame: ' + s.fault);
          }
        }
        const t1 = now();
        if (out?.check) {
          s.checks += 1;
          s.check = out.check;
          if (out.check.same) s.okSigs.add(sig);
          else {
            s.badSigs.add(sig);
            const pl = out.check.plate;
            s.reason = pl && !pl.same
              ? `the Scene's HDR plate is not its SDR picture below the knee (mean difference ${pl.meanDiff.toFixed(2)} levels, ${(pl.off * 100).toFixed(2)} % of pixels apart)`
              : `the float composite is not the 8-bit picture (mean difference ${out.check.meanDiff.toFixed(2)} levels, ${(out.check.off * 100).toFixed(2)} % of pixels apart)`;
            console.warn('[hdr2] ' + s.reason + ' on a new set of layers (' + sig + ')');
            if (s.frames === 0) { off(); return null; }
            out = null;
          }
        }
        if (out && blur) s.blurred += 1;
        // a frame of the float composite without the Scene's light (no Scene at this time, its light clipped on the way) is its SDR picture
        if (out && !out.scene) s.sdrFrames += 1;
        // (hdr3) an MP4's frame comes encoded from the GPU (out.yuv); ProRes: an opaque frame's numbers turn into light inside the planes'
        // own pass (one lookup a channel), alpha made straight first
        if (out?.yuv) return done(out.yuv.data, out.yuv.light, t0, t1);
        if (out) return alpha ? finish(compositeLight(out.data, { alpha }), t0, t1) : finish(out.data, t0, t1, { lut: displayLightTable(), hybrid: true });
        s.sdrFrames += 1;
        return finish(sdrToHalf(read8(), { alpha }), t0, t1);
      }
      const hdr = accumulated() ? null : await world.hdrFrame();
      const t1 = now();
      const fits = hdr && hdr.width === width && hdr.height === height && hdr.data?.length === width * height * 4;
      if (fits && !s.checked) {
        // the first frame the world drew: the compositor's picture must be the world's, nothing else in it
        const sdr = await world.sdrPixels();
        const cmp = sameSdr(read8(), sdr?.data, { alpha });
        s.checked = true;
        s.check = cmp;
        if (!cmp.same) {
          s.reason = `the frame is not the Scene's picture alone (mean difference ${cmp.meanDiff.toFixed(2)} levels, ${(cmp.off * 100).toFixed(2)} % of pixels apart)`;
          if (s.frames === 0) { off(); return null; }
        }
      }
      let data;
      if (fits && s.check?.same) data = hdr.data;
      else { data = sdrToHalf(read8(), { alpha }); s.sdrFrames += 1; }
      return finish(data, t0, t1);
    },
  };
}
