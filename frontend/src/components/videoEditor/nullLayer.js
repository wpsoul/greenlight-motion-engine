// Null layer — a transform with no picture. It exists to be animated, tracked and
// used as a PARENT; it never paints into a render. In the preview it shows as a
// small filled circle, but only while it is the selected layer, so the user can
// see (and drag) the point everything hangs off.
//
// Its own look is two item fields, `nullColor` and `nullSize` (diameter, in
// composition px). Everything else a picture layer carries — Design, Effects,
// Mask — does not apply: the panel offers none of it and the preview draw below
// neutralises it, so a value that reaches the item by another route (pasted JSON,
// an agent) still cannot make the marker look like content.

import { KF_PROPS } from './keyframeProps.js';

export const NULL_MEDIA_TYPE = 'null';
export const NULL_CLIP_DURATION_SECONDS = 5;
export const NULL_DEFAULT_COLOR = '#ff3b30';
export const NULL_DEFAULT_SIZE = 24;
export const NULL_SIZE_MIN = 2;
export const NULL_SIZE_MAX = 2000;

export function isNullClip(clip) {
  return clip?.mediaType === NULL_MEDIA_TYPE;
}

export function nullLayerSize(item) {
  const v = Number(item?.nullSize);
  return Number.isFinite(v) ? Math.min(NULL_SIZE_MAX, Math.max(NULL_SIZE_MIN, v)) : NULL_DEFAULT_SIZE;
}

export function nullLayerColor(item) {
  return typeof item?.nullColor === 'string' && item.nullColor ? item.nullColor : NULL_DEFAULT_COLOR;
}

// The preview draws a null through the ordinary shape path: a px-sized ellipse
// with the look fields reset. Cached per stored object, so a frame that redraws
// an unchanged null hands the renderer the same item and clip it had before.
const NEUTRAL_LOOK = {
  shapeType: 'ellipse',
  shapeSizeUnit: 'px',
  shapeBackground: null,
  shapeClipMask: false,
  opacity: 100,
  blendMode: 'normal',
  trackMatte: undefined,
  effects: [],
  layerEffects: [],
  filterBlur: 0,
  filterBrightness: 100,
  filterContrast: 100,
  filterSaturation: 100,
  filterHueRotate: 0,
  filterGrayscale: 0,
  filterSepia: 0,
  filterInvert: 0,
  borderWidth: 0,
  shadows: [],
  backdropBlur: 0,
  shadowPlate: undefined,
  prerender: undefined,
};
// Keyframe tracks that only change how a layer LOOKS (opacity, colours, filters,
// effect amounts). The marker ignores them; position, rotation, scale and the
// motion path keep animating it.
const LOOK_TRACKS = new Set([
  'opacity', 'borderWidth', 'clipPath',
  ...KF_PROPS.filter((p) => p.group !== 'Transform').map((p) => p.label),
]);
const previewItems = new WeakMap();
const previewClips = new WeakMap();

function withoutLookTracks(tracks) {
  if (!tracks || typeof tracks !== 'object') return tracks;
  const keys = Object.keys(tracks);
  if (!keys.some((k) => LOOK_TRACKS.has(k))) return tracks;
  const out = {};
  for (const k of keys) if (!LOOK_TRACKS.has(k)) out[k] = tracks[k];
  return out;
}

export function nullPreviewItem(item) {
  let out = previewItems.get(item);
  if (!out) {
    const size = nullLayerSize(item);
    out = {
      ...item,
      ...NEUTRAL_LOOK,
      propertyKeyframes: withoutLookTracks(item.propertyKeyframes),
      shapeWidthPx: size,
      shapeHeightPx: size,
      shapeFillColor: nullLayerColor(item),
    };
    previewItems.set(item, out);
  }
  return out;
}

export function nullPreviewClip(clip) {
  let out = previewClips.get(clip);
  if (!out) {
    out = { ...clip, mediaType: 'shape' };
    previewClips.set(clip, out);
  }
  return out;
}
