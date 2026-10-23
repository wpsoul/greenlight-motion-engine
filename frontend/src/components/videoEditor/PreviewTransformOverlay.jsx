import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CAMERA_PLANE_COLORS, CAMERA_UNGROUPED_COLOR } from './cameraSolve';
import { usePreviewView } from './PreviewStage';
import { useVideoEditorStore } from './videoEditorStore';
import { getTimelineLayout } from './speedUtils';
import { getModelFootprint } from './model3dFootprint';
import { imagePlateSize, subscribeImagePlate } from './imagePlate';
import { htmlClipPlateSize } from './htmlClips';
import { getTextFootprint, subscribeTextFootprint } from './textFootprint';
import { getVideoPlate, subscribeVideoPlate } from './videoPlate';
import { projectFramePoint } from './projectCamera';
import { getItemKeyframeValues, evaluatePropertyTrack, evaluatePathTrack, itemHasKeyframes } from './gsapTransitions';
import {
  buildParentIndex,
  resolveParentTransform,
  localPrs,
  applyParenting,
  prsToFrameCenter,
  prsRotationZDeg,
  localAxisScale,
  PARENTING_FULL_COPY,
} from './keyframeParenting';
import { TransitionEasing, resolveTextFontSize, DEFAULT_TEXT_FONT_FAMILY } from './types';
import { setInlineTextEdit } from './inlineTextEdit';
import {
  evaluateShapePath,
  shapePathSegmentAt,
  refreshShapePathHandles,
  insertShapePathPoint,
  deleteShapePathPoint,
  toggleShapePathCorner,
  setShapePathHandle,
  encodeShapePathValue,
  decodeShapePathValue,
  writeShapePathKey,
  roundKeyPosition,
  SHAPE_PATH_KF_KEY,
  withShapeSizeKeyframes,
} from './shapePath';
import { objectMotionPathIsLive } from './objectMotionPath';
import { isNullClip, nullLayerSize } from './nullLayer';
import { flattenRotoNodes, smoothRotoNodes } from './rotoRegion';
import {
  showPointLoupe, hidePointLoupe, disposePointLoupe, queuePointLoupe, usePointLoupeCommit, nextPenCurve,
} from './pointLoupe';
import { isTouchEvent, liftForTouch } from './pathPointer';

const SNAP_PX = 7;
// How close (css px) a pen click must land on the first roto anchor to close.
const ROTO_PEN_CLOSE_PX = 11;
// The loupe's view of a roto edit, read from the overlay as it was just
// committed: the outlines, the anchors of the outline being edited and — while
// a tangent is pulled, or hovering the pen — the handles of ONE point. `kind`
// is whose anchors: the pen draft, the region fine-tune, the correction outline.
const ROTO_LOUPE_PARTS = {
  draft: { anchor: '.ve-preview-roto-draft-anchor', knob: '.ve-preview-roto-draft-knob', stem: '.ve-preview-roto-draft-stem' },
  region: { anchor: '.ve-preview-roto-region-anchor', knob: '.ve-preview-roto-region-knob', stem: '.ve-preview-roto-region-stem' },
  correction: { anchor: '.ve-preview-roto-outline.is-correction .ve-preview-roto-anchor', knob: null, stem: null },
};
function rotoLoupeScene(root, { kind, index = null, key = null, handles = true }) {
  const parts = ROTO_LOUPE_PARTS[kind];
  const withHandles = handles && parts.knob;
  return {
    target: index != null ? root.querySelector(`${parts.anchor}[data-loupe-anchor="${index}"]`) : null,
    tip: key && parts.knob ? root.querySelector(`${parts.knob}[data-key="${key}"]`) : null,
    stems: withHandles ? root.querySelectorAll(parts.stem) : [],
    knobs: withHandles ? root.querySelectorAll(parts.knob) : [],
    paths: root.querySelectorAll('.ve-preview-roto-region, .ve-preview-roto-draft-path, .ve-preview-roto-outline polygon'),
    anchors: root.querySelectorAll(parts.anchor),
  };
}
const HANDLE_PX = 10;
// Anchors and tangent dots are smaller than the transform handles — a path can
// carry a dozen of them and full-size squares would cover the artwork.
const ANCHOR_PX = 8;
const TANGENT_PX = 5;
// Samples used to draw the curve and to find the nearest point on it. 160 keeps a
// full-frame path smooth without making every pointermove expensive.
const CURVE_SAMPLES = 160;
// Gap between the selected anchors and the box drawn around them, in screen
// pixels. Wide enough that a grip on the box edge clears an anchor sitting on
// it (ANCHOR_PX/2 + HANDLE_PX/2 + slack) — otherwise the two squares overlap and
// neither is grabbable. It also keeps the box non-degenerate when every selected
// anchor is collinear, so a flat run of points can still be scaled.
const GROUP_PAD_PX = 12;
// Scale grips around the multi-selection box, as fractions of it. A 0.5 on an
// axis means that axis is pinned — the classic edge-grip behaviour.
const GROUP_HANDLES = [
  { hx: 0, hy: 0, cursor: 'nwse-resize' },
  { hx: 0.5, hy: 0, cursor: 'ns-resize' },
  { hx: 1, hy: 0, cursor: 'nesw-resize' },
  { hx: 1, hy: 0.5, cursor: 'ew-resize' },
  { hx: 1, hy: 1, cursor: 'nwse-resize' },
  { hx: 0.5, hy: 1, cursor: 'ns-resize' },
  { hx: 0, hy: 1, cursor: 'nesw-resize' },
  { hx: 0, hy: 0.5, cursor: 'ew-resize' },
];
// Side grips on a shape's box: the two corners (geometry() order TL, TR, BR, BL)
// that bound the side, and the shape dimension a drag on it resizes.
const SHAPE_EDGES = [
  { a: 0, b: 1, axis: 'height' },
  { a: 1, b: 2, axis: 'width' },
  { a: 2, b: 3, axis: 'height' },
  { a: 3, b: 0, axis: 'width' },
];
const RESIZE_CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
// Cursor for a grip pushing along (dx, dy) in frame space (y down), so a rotated
// box still shows the arrow that matches the way the side actually moves.
function resizeCursor(dx, dy) {
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI % 180 + 180) % 180;
  return RESIZE_CURSORS[Math.round(deg / 45) % 4];
}
// Stable identity for "no extra anchors selected", so the default prop value
// never re-triggers the selection memos.
const NO_EXTRAS = [];
// 'html' plays its bake exactly like a video (htmlClips.js), so it gets the same frame-sized box.
const SUPPORTED = new Set(['text', 'image', 'video', 'motion', 'shape', 'model3d', 'html']);
// Slack around the selection box for the corner handles and the rotation stem,
// as a fraction of the frame width.
const GIZMO_MARGIN_FRAC = 0.08;
// The overlay grows in quarter-frame steps so its box (and therefore the
// measured px-per-user-unit) stays put while a layer is being dragged.
const PAD_STEP_FRAC = 0.25;

// How far the overlay must extend past the frame for the whole gizmo to stay
// inside its own SVG viewport — the frame box itself is clipped (rounded
// corners), so a layer dragged half out of frame would otherwise lose its
// handles. Padding is uniform, which keeps the element's aspect ratio equal to
// the viewBox's and so keeps pointer mapping a plain linear scale.
function overlayPadding(geo, cam, width, height) {
  if (!geo) return 0;
  let overflow = 0;
  for (const corner of geo.corners) {
    const p = cam.forward(corner.x, corner.y);
    overflow = Math.max(overflow, -p.x, p.x - width, -p.y, p.y - height);
  }
  const step = PAD_STEP_FRAC * width;
  return Math.ceil((overflow + GIZMO_MARGIN_FRAC * width) / step) * step;
}

const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round4 = (n) => Math.round(n * 10000) / 10000;
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// A text layer's paint can be a full CSS gradient; a textarea's `color` cannot.
// The first stop is what the renderer itself falls back to for outlines, so the
// editor showing it reads as the same text, just unswept.
function firstColorOf(paint, fallback = '#ffffff') {
  if (typeof paint !== 'string' || !paint.trim()) return fallback;
  if (!/gradient\s*\(/i.test(paint)) return paint;
  const m = paint.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/i);
  return m ? m[0] : fallback;
}

// A still click on the empty area AROUND the frame — outside the frame box but
// still inside the preview's own surface (clicks in the panels or the timeline
// are none of this overlay's business), and barely moved between down and up,
// because a drag out there PANS the preview and a pan is not a click. Both the
// gizmo dismissal and the inline text editor honour this gesture; it cannot be
// scoped by target because the pan gesture preventDefaults its pointerdown, so
// nothing out there ever produces a click or a blur. Returns the remover.
function onStillClickOutsideFrame(callback) {
  const outsideFrame = (event) => {
    const target = event.target;
    if (!target?.closest) return false;
    return !!target.closest('.ve-player-viewport') && !target.closest('.ve-player-container');
  };
  let down = null;
  const onDown = (event) => { down = outsideFrame(event) ? { x: event.clientX, y: event.clientY } : null; };
  const onUp = (event) => {
    const from = down;
    down = null;
    if (!from || !outsideFrame(event)) return;
    if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > 4) return;
    callback();
  };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', onUp, true);
  return () => {
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointerup', onUp, true);
  };
}

// The wrap box the text renderer lays out in, in composition px, mirrored from
// Player.jsx's text branch (textNoWrap / textWidthUnit / textWidthPct). The
// editor sits exactly on this box so left/right alignment lands where the
// glyphs will: its left edge IS textMarginX, because the box is centred.
function textWrapBoxWidth(item, compW) {
  if (item.textNoWrap) return compW * 0.86;
  if (item.textWidthUnit === 'px' && Number.isFinite(item.textWidthPx) && item.textWidthPx > 0) {
    return clampNum(item.textWidthPx, 40, compW * 4);
  }
  return compW * (clampNum(Number(item.textWidthPct) || 86, 5, 100) / 100);
}

function shapeSize(item, frameWidth, frameHeight) {
  const usePx = item.shapeSizeUnit === 'px';
  const percentWidth = (frameWidth * Math.max(1, number(item.shapeWidthPct, 40))) / 100;
  const percentHeight = (frameHeight * Math.max(1, number(item.shapeHeightPct, 40))) / 100;
  if (item.shapeType === 'circle') {
    const percentRadius = (Math.min(frameWidth, frameHeight) * Math.max(1, number(item.shapeRadiusPct, 20))) / 100;
    const radius = usePx && Number.isFinite(Number(item.shapeRadiusPx))
      ? Math.max(1, Number(item.shapeRadiusPx))
      : percentRadius;
    return { width: radius * 2, height: radius * 2 };
  }
  return {
    width: usePx && Number.isFinite(Number(item.shapeWidthPx))
      ? Math.max(1, Number(item.shapeWidthPx))
      : percentWidth,
    height: usePx && Number.isFinite(Number(item.shapeHeightPx))
      ? Math.max(1, Number(item.shapeHeightPx))
      : percentHeight,
  };
}

// Exported for AutoFillPointsOverlay, which needs the same as-rendered layer
// geometry (parenting + keyframes included) to map its points into the box.
//
// `includeAdjustment` is an OPT-IN for MaskOverlay only: an adjustment layer is
// an invisible full-frame plane, so listing it here by default would let it
// swallow every canvas click in the transform overlay's hit-test.
//
// `shownNullId`: a null layer is listed only while the preview is drawing it —
// when it is the selected layer (nullLayer.js). An unselected null is invisible,
// so it must not catch clicks meant for the layers under it.
export function activeLayers(channels, clipsMap, time, width, height, fps = 30, { includeAdjustment = false, shownNullId = null } = {}) {
  const layers = [];
  // Layouts up front so the parenting index can be built over the whole level —
  // a parent may live on any channel, above or below the child.
  const layouts = new Map(
    (channels || []).map((ch) => [ch.id, getTimelineLayout(ch.items, { unsnapped: ch.unsnapped })])
  );
  const parentIndex = buildParentIndex(channels, (ch) => layouts.get(ch.id));
  const prsCtx = { W: width, H: height, evalKeyframes: getItemKeyframeValues };
  channels.forEach((channel, channelIndex) => {
    if (channel.visible === false) return;
    const layout = layouts.get(channel.id) || [];
    channel.items.forEach((item, index) => {
      const span = layout[index];
      const clip = clipsMap.get(item.clipId);
      if (!span || !clip) return;
      if (!SUPPORTED.has(clip.mediaType)
        && !(includeAdjustment && clip.mediaType === 'adjustment')
        && !(isNullClip(clip) && item.id === shownNullId)) return;
      if (time < span.startTime - 1e-6 || time > span.endTime + 1e-6) return;
      const baseZoom = Number.isFinite(item.zoom) ? item.zoom : 1;
      const baseRotation = Number.isFinite(item.rotateZ) ? item.rotateZ : (Number.isFinite(item.rotation) ? item.rotation : 0);
      const progress = Math.max(0, Math.min(1, (time - span.startTime) / Math.max(span.duration, 1e-6)));
      const keyProps = getItemKeyframeValues(item, progress);
      const pct = progress * 100;
      const keyTolerancePct = 50 / Math.max(span.duration * (fps || 30), 1); // half of one project frame
      // Selection geometry has to match what the renderer actually drew, so it goes
      // through the same PRS evaluator (Player.jsx's applyMeshTransform does too).
      // Unparented layers resolve to exactly the old arithmetic.
      const parentXform = resolveParentTransform(parentIndex, item, time, prsCtx);
      const prs = applyParenting(parentXform?.prs, localPrs(item, keyProps, width, height), parentXform?.type);
      const centre = prsToFrameCenter(prs, width, height);
      // The box is sized per axis (Scale X / Scale Y stretch it independently),
      // but a corner drag writes the UNIFORM Scale — so `zoom` is the resolved
      // scale with this layer's own per-axis multipliers divided back out.
      const sx = prs.sx;
      const sy = prs.sy;
      const axis = localAxisScale(item, keyProps);
      const zoom = Math.abs(axis.x) > 1e-9 ? sx / axis.x : sx;
      const rotation = prsRotationZDeg(prs);
      // A model's box is its fitted footprint, published by the render pass — a model
      // does not fill the frame the way a plane layer does. Before its first drawn
      // frame the footprint is unknown; fall back to the frame so the layer is still
      // selectable rather than invisible to the gizmo.
      // An image layer can draw on a plate of its own size (imagePlate.js) — every
      // SVG, and any raster photo that fits inside the frame — so its box is the
      // artwork, not the frame. Until it has decoded (or when it is bigger than the
      // frame and therefore fitted into it), the frame is the only honest fallback.
      // A video's plate is the frame-shaped box its masks, pins and tracking were drawn
      // on, shrunk with the picture when the clip is smaller than the frame (videoPlate.js).
      const videoPlate = clip.mediaType === 'video' && !clip.htmlSource ? getVideoPlate(item.id) : null;
      const baseSize = clip.mediaType === 'shape'
        ? shapeSize(withShapeSizeKeyframes(item, keyProps), width, height)
        : isNullClip(clip)
          ? { width: nullLayerSize(item), height: nullLayerSize(item) }
        : clip.mediaType === 'model3d'
          ? (getModelFootprint(item.id) || { width, height })
          : clip.mediaType === 'image'
            ? (imagePlateSize(clip, width, height) || { width, height })
            : (clip.mediaType === 'html' || clip.htmlSource)
              ? (htmlClipPlateSize(clip, width, height) || { width, height })
              : videoPlate
                ? { width: videoPlate.frameWidth, height: videoPlate.frameHeight }
                : { width, height };
      // ── The SELECTION box, when it isn't the layer quad ──
      // A text layer draws on a frame-sized plate with the words placed inside it, so
      // the quad above is the whole preview however small the text is. The draw
      // publishes the block it laid out (textFootprint.js) and the gizmo uses THAT.
      // Deliberately a separate field: `width/height/cx/cy` stay the plate, because
      // the sibling overlays (mask %, rig pins, AutoFill uv) map their geometry onto
      // the plate exactly as the renderer does.
      //
      // The offset matters because a left- or right-aligned block does not sit on the
      // layer's origin the way a shape or a model does; it scales and rotates with the
      // layer like any other piece of the plate.
      const footprint = clip.mediaType === 'text' ? getTextFootprint(item.id) : null;
      let box = null;
      if (footprint) {
        const rot = (rotation * Math.PI) / 180;
        // Scale first, then rotate — the order the composed matrix (R·S) applies
        // them in, so the offset lands right for a stretched layer too.
        const ox = footprint.offsetX * sx;
        const oy = footprint.offsetY * sy;
        box = {
          cx: centre.cx + ox * Math.cos(rot) - oy * Math.sin(rot),
          cy: centre.cy + ox * Math.sin(rot) + oy * Math.cos(rot),
          width: footprint.width * sx,
          height: footprint.height * sy,
        };
      }
      // A video draws only its picture (videoPlate.js) — the gizmo hugs that, while
      // masks, pins and tracking keep the frame-shaped plate above.
      if (videoPlate && (videoPlate.width < videoPlate.frameWidth - 0.5 || videoPlate.height < videoPlate.frameHeight - 0.5)) {
        box = {
          cx: centre.cx,
          cy: centre.cy,
          width: videoPlate.width * sx,
          height: videoPlate.height * sy,
        };
      }
      layers.push({
        item, clip, channelId: channel.id, channelIndex,
        // On-timeline span. MaskOverlay needs it to reproduce the renderer's
        // clip-local clock: Layer Mask's Grow is a rate integrated over the
        // clip, so without the duration the gizmo would draw the un-grown edge.
        startTime: span.startTime,
        duration: span.duration,
        cx: centre.cx,
        cy: centre.cy,
        // Null unless the selection box differs from the quad — see above.
        box,
        // Depth matters to the perspective projection used for selection under
        // dolly/tilt — a layer pushed toward the camera covers more of the screen.
        pz: Number.isFinite(prs?.pz) ? prs.pz : 0,
        width: baseSize.width * sx, height: baseSize.height * sy, zoom, rotation, baseZoom, baseRotation,
        // A shape's own Width/Height before any scaling — what its side grips resize.
        shapeBase: clip.mediaType === 'shape' ? baseSize : null,
        pct, keyTolerancePct,
        // The parent's contribution, so a gesture can be converted from the world
        // space the user drags in back into the child's own local PRS.
        parentPrs: parentXform?.prs || null,
        parentType: parentXform?.type || null,
      });
    });
  });
  return layers;
}

function rotatedPoint(cx, cy, x, y, deg) {
  const r = deg * Math.PI / 180;
  return { x: cx + x * Math.cos(r) - y * Math.sin(r), y: cy + x * Math.sin(r) + y * Math.cos(r) };
}

// Layer uv → frame, and a uv OFFSET (a tangent) → frame offset. The region's
// nodes live in layer uv so they survive a layer move; drawing needs frame px.
const layerUvToFrame = (layer, u, v) => rotatedPoint(
  layer.cx, layer.cy, (u - 0.5) * layer.width, (v - 0.5) * layer.height, layer.rotation
);
const uvDeltaToFrame = (layer, du, dv) => {
  const p = rotatedPoint(0, 0, du * layer.width, dv * layer.height, layer.rotation);
  return { x: p.x, y: p.y };
};
const frameDeltaToUv = (layer, dx, dy) => {
  const r = -layer.rotation * Math.PI / 180;
  return {
    u: (dx * Math.cos(r) - dy * Math.sin(r)) / Math.max(layer.width, 1e-6),
    v: (dx * Math.sin(r) + dy * Math.cos(r)) / Math.max(layer.height, 1e-6),
  };
};
const clamp01 = (t) => Math.max(0, Math.min(1, t));

// Tap-to-circle radius (frame px) — "the subject is HERE" for a single roto
// pen click.
const rotoTapRadius = (layer) => Math.max(12, layer.height * 0.13);

// What the gizmo draws, hit-tests and snaps: the layer's own selection box (a text
// layer's laid-out block) or, for everything else, the layer quad itself. `dx/dy`
// shifts it without rebuilding the layer — a live move drag needs the box at the
// dragged position, and spreading the layer would leave `box` behind at the old one.
function selectionBox(layer, dx = 0, dy = 0) {
  const b = layer.box || layer;
  return { cx: b.cx + dx, cy: b.cy + dy, width: b.width, height: b.height };
}

function geometry(layer, dx = 0, dy = 0) {
  const b = selectionBox(layer, dx, dy);
  const hw = b.width / 2, hh = b.height / 2;
  const corners = [
    rotatedPoint(b.cx, b.cy, -hw, -hh, layer.rotation),
    rotatedPoint(b.cx, b.cy, hw, -hh, layer.rotation),
    rotatedPoint(b.cx, b.cy, hw, hh, layer.rotation),
    rotatedPoint(b.cx, b.cy, -hw, hh, layer.rotation),
  ];
  return { corners, left: Math.min(...corners.map((p) => p.x)), right: Math.max(...corners.map((p) => p.x)), top: Math.min(...corners.map((p) => p.y)), bottom: Math.max(...corners.map((p) => p.y)) };
}

// The layer's four corners as they actually land on screen, in frame coordinates.
// Goes through projectFramePoint (which builds the camera with cameraProxyFromPose,
// the same function the renderer uses) so this cannot drift from what is drawn.
// Returns null if any corner has no projection — at or behind the camera.
function projectedQuad(layer, pose, W, H) {
  const r = (layer.rotation * Math.PI) / 180;
  const cos = Math.cos(r); const sin = Math.sin(r);
  const b = selectionBox(layer);
  const hw = b.width / 2; const hh = b.height / 2;
  const out = [];
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const lx = sx * hw; const ly = sy * hh;
    const fx = b.cx + lx * cos - ly * sin;
    const fy = b.cy + lx * sin + ly * cos;
    const p = projectFramePoint(pose, W, H, fx, fy, layer.pz || 0);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

// Winding test — a projected quad is convex but not axis-aligned, so the plain
// rotate-and-compare in hitLayer cannot be used under perspective.
function pointInQuad(quad, x, y) {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i]; const b = quad[(i + 1) % 4];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function hitLayer(layer, x, y) {
  const b = selectionBox(layer);
  const r = -layer.rotation * Math.PI / 180;
  const dx = x - b.cx, dy = y - b.cy;
  const lx = dx * Math.cos(r) - dy * Math.sin(r);
  const ly = dx * Math.sin(r) + dy * Math.cos(r);
  return Math.abs(lx) <= b.width / 2 && Math.abs(ly) <= b.height / 2;
}

// The project camera as a 2D affine over frame-pixel coordinates. Layer maths in
// this file is all in un-cameraed frame space, so the camera is handled at the two
// boundaries only: pointer coordinates come back through `inverse`, and the drawn
// selection goes out through `svg`. Dolly/tilt are true perspective and cannot be
// expressed here — `perspective` reports that so the caller disables the gizmo
// instead of drawing a box in the wrong place.
// Exported for the sibling overlays (AutoFillPointsOverlay, RigPinOverlay,
// MaskOverlay) — this is the canonical copy, the only one carrying `forward`
// and `identity`. Anything that draws inside the camera-transformed group needs
// exactly this affine, and a fourth private copy would be a fourth thing to
// keep in step.
export function cameraAffine(pose, W, H) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const zoom = pose && Number.isFinite(pose.camZoom) && pose.camZoom > 0 ? pose.camZoom : 1;
  const roll = pose ? n(pose.camRoll) : 0;
  const tx = pose ? -(n(pose.camX) / 100) * W : 0;
  const ty = pose ? -(n(pose.camY) / 100) * H : 0;
  const perspective = !!pose && (Math.abs(n(pose.camDolly)) > 1e-4 || Math.abs(n(pose.camTiltX)) > 1e-4 || Math.abs(n(pose.camTiltY)) > 1e-4);
  const identity = !pose || (Math.abs(zoom - 1) < 1e-4 && Math.abs(roll) < 1e-4 && Math.abs(tx) < 1e-4 && Math.abs(ty) < 1e-4);
  const r = (roll * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return {
    zoom,
    identity,
    perspective,
    svg: identity ? null : `translate(${W / 2 + tx} ${H / 2 + ty}) rotate(${roll}) scale(${zoom}) translate(${-W / 2} ${-H / 2})`,
    // Frame space → drawn (post-camera) space; the exact composition `svg`
    // applies. Used to work out how far outside the frame the gizmo will land.
    forward: (x, y) => {
      if (identity) return { x, y };
      const dx = x - W / 2;
      const dy = y - H / 2;
      return {
        x: W / 2 + tx + zoom * (dx * cos - dy * sin),
        y: H / 2 + ty + zoom * (dx * sin + dy * cos),
      };
    },
    inverse: (x, y) => {
      if (identity) return { x, y };
      const dx = x - W / 2 - tx;
      const dy = y - H / 2 - ty;
      return {
        x: (dx * cos + dy * sin) / zoom + W / 2,
        y: (-dx * sin + dy * cos) / zoom + H / 2,
      };
    },
  };
}

// Clone before handing points to refreshShapePathHandles: it rewrites every
// non-`manual` anchor in place, and the array it is given may still be the item's.
function withAutoHandles(points, closed) {
  return refreshShapePathHandles(points.map((p) => ({ ...p })), closed);
}

/* The tracked box. During playback the committed time — and everything computed
   from it, including the static box geometry — stops updating; only the store's
   playheadTime moves (mirrored per frame from the Player's clock). This leaf
   subscribes to that live playhead WHILE PLAYING and recomputes its own
   geometry, so only this small SVG group re-renders per frame, nothing above
   it. Paused, the selector pins to null and the cheap static path is back. */
function MotionTrackBox({ box, atTime, dragHandlers }) {
  const isPlaying = useVideoEditorStore((s) => s.isPlaying);
  const livePlayhead = useVideoEditorStore((s) => (s.isPlaying ? s.playheadTime : null));
  const follow = livePlayhead != null && !!atTime && !box.live;
  const geo = (follow && atTime(livePlayhead)) || box;
  if (!geo?.corners || geo.corners.length !== 4) return null;
  const weak = geo.conf < 0.35;
  const c = geo.center;
  const arm = 14;
  // Dragging a correction onto a moving target is not a thing — adjust waits
  // for pause.
  const editable = !!box.editable && !isPlaying;
  return (
    <g className={`ve-preview-track-box${weak ? ' is-weak' : ''}${box.live ? ' is-live' : ''}${geo.outOfSpan || box.dimmed ? ' is-outside' : ''}${editable ? ' is-editable' : ''}`}>
      <polygon
        points={geo.corners.map((p) => `${p.x},${p.y}`).join(' ')}
        {...(editable ? dragHandlers : {})}
      />
      <path d={`M ${c.x - arm} ${c.y} H ${c.x + arm} M ${c.x} ${c.y - arm} V ${c.y + arm}`} />
      {geo.corners.map((p, i) => (
        <rect key={i} x={p.x - 3} y={p.y - 3} width={6} height={6} />
      ))}
    </g>
  );
}

export default function PreviewTransformOverlay({
  channels, clips, currentTime, videoWidth, videoHeight,
  // Project fps — the keyframe write tolerance is half a FRAME, so it must
  // know the real frame duration (hardcoding 30 made 60fps keying overwrite
  // the neighbouring frame's key).
  fps = 30,
  selectedItemId, onSelectItem, onTransformItem, disabled, cameraPose = null,
  pathEditItemId = null, pathEditPointIndex = -1, pathEditPointExtras = NO_EXTRAS,
  onPathEditPointSelect = null, onExitPathEdit = null,
  motionPathEditItemId = null,
  // Auto Fill point editing owns the preview the same way path edit does.
  afPointsEditItemId = null,
  rigPinEditItemId = null,
  maskEditItemId = null,
  distortEditItemId = null,
  // Motion Tracking. `trackRegionDraw` = { itemId, trackId? } puts the preview into
  // box-draw mode for one layer; trackId set means "re-anchor this track here and
  // continue". The box is reported in the LAYER's uv, not the frame's — only the
  // decoder knows the true source aspect needed to reach source coordinates.
  trackRegionDraw = null,
  onTrackRegionDrawn = null,
  onCancelTrackRegionDraw = null,
  // Camera tracking. The solved point cloud for THIS frame, already in
  // composition pixels ({ points: [{ id, x, y, group, on }] }), plus the two
  // selection verbs. The overlay never holds the solve: it draws what it is
  // given and reports ids back, so a stale render cannot resurrect points.
  cameraCloud = null,
  onCameraSelect = null,
  onCameraSelectSurface = null,
  // The resolved path of the selected layer's track (composition px, y down) so a
  // user can see what was analysed without exporting.
  motionTrackPath = null,
  // The tracked REGION on this frame — corners + centre + confidence. This is the
  // primary read: the path alone says where the thing went, the box says whether
  // the tracker is still on it. `editable` makes it draggable (manual per-frame
  // correction); `dimmed` ghosts it while a re-anchor is being placed.
  motionTrackBox = null,
  // (t) => box geometry — lets the box follow the live playhead during playback,
  // when the committed time (and therefore motionTrackBox) stops updating.
  motionTrackBoxAtTime = null,
  // Reported in frame px with a phase ('start'|'move'|'end') — the editor owns
  // the geometry that turns the pointer into a track sample.
  onMotionTrackPointDrag = null,
  // The re-anchor ghost: the box the user drags onto the re-appeared subject
  // before continuing a lost track. Same drag contract as the point drag.
  motionTrackGhost = null,
  onMotionTrackGhostDrag = null,
  // 'both' | 'box' | 'off' — the path is genuinely noisy on a busy shot, so it
  // has to be switchable rather than something to put up with.
  motionTrackOverlayMode = 'both',
  // RotoScope: the stored subject region ({itemId, uv}) and the traced-outline
  // preview ({itemId, sourceW, sourceH, points, live}) — points in unit-box
  // fractions of the source frame (±0.5, +y down).
  rotoRegion = null,
  rotoPreview = null,
  onRotoPreviewPointsChange = null,
  rotoRegionEditItemId = null,
  onRotoRegionChange = null,
  // How many anchors the pen region draft holds — the panel's Finish button
  // lights up on three. Reported, never held: the draft is the overlay's.
  onRotoDraftChange = null,
  // Roto ▸ SAM 3 on an image layer: { itemId, tool: 'points'|'box'|null,
  // points: [{u, v, label}], box } in the LAYER's uv (= the picture's own 0–1).
  // Reported as { type: 'point', u, v, label } / { type: 'box', u0, v0, u1, v1 }.
  samPick = null,
  onSamPick = null,
}) {
  const rootRef = useRef(null);
  const dragRef = useRef(null);
  // Rubber-band box while one is being dragged, in frame coordinates (null = none).
  const [marquee, setMarquee] = useState(null);
  // Mirror of the current viewBox, so pointer mapping doesn't have to rebuild
  // its callback every time the overlay's padding changes.
  const vbRef = useRef({ x: 0, y: 0, w: videoWidth, h: videoHeight });
  // Layout (untransformed) width of the overlay; combined with the preview's
  // zoom it converts screen pixels to user units for the handle sizes.
  const [layoutWidth, setLayoutWidth] = useState(0);
  const { view: previewView } = usePreviewView();
  // The transform box/handles only appear for selections made by clicking the
  // layer in the preview — selecting a clip in the timeline keeps the preview
  // clean until the user clicks the layer here.
  const [previewClickId, setPreviewClickId] = useState(null);
  const [guides, setGuides] = useState([]);
  // Inline text editing (double-click a text layer in the preview). Holds the
  // item id and the text as it stood on entry; the textarea itself is
  // uncontrolled — its live value only matters at commit. Mirrored into a ref
  // so the commit can run from a native blur without chasing state.
  const [textEdit, setTextEdit] = useState(null);
  const textEditRef = useRef(null);
  const textEditTaRef = useRef(null);
  const clipsMap = useMemo(() => new Map(clips.map((clip) => [clip.id, clip])), [clips]);
  // Some layers only learn their box from the render loop: an image layer's own
  // artwork size (SVG always, a raster photo that fits inside the frame) once the
  // file has decoded, a video's fitted picture once a frame has been drawn, and a
  // text layer's laid-out block once it has been drawn. All land outside React
  // (the Player redraws its canvas without re-rendering anyone), so without these
  // the gizmo would keep the frame-sized fallback until some
  // unrelated state change happened to recompute the memo.
  const [vectorVersion, setVectorVersion] = useState(0);
  useEffect(() => subscribeImagePlate(() => setVectorVersion((version) => version + 1)), []);
  useEffect(() => subscribeTextFootprint(() => setVectorVersion((version) => version + 1)), []);
  useEffect(() => subscribeVideoPlate(() => setVectorVersion((version) => version + 1)), []);
  const layers = useMemo(
    () => activeLayers(channels, clipsMap, currentTime, videoWidth, videoHeight, fps, { shownNullId: selectedItemId }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- vectorVersion is a recompute trigger, not an input
    [channels, clipsMap, currentTime, videoWidth, videoHeight, fps, vectorVersion, selectedItemId]
  );
  const cam = useMemo(() => cameraAffine(cameraPose, videoWidth, videoHeight), [cameraPose, videoWidth, videoHeight]);
  // Under dolly/tilt the on-screen shape of a layer is a true perspective quad, so
  // the gizmo would lie about where the layer is — hide it rather than mislead.
  const camBlocked = cam.perspective;
  // Deliberately keyed on selectedItemId alone: it must clear only when the
  // selection changes to something the preview didn't click (timeline click,
  // deselect) — not on the render right after a preview click.
  useEffect(() => {
    setPreviewClickId((current) => (current === selectedItemId ? current : null));
  }, [selectedItemId]);
  // A click on the empty area AROUND the frame puts the gizmo away without
  // touching the selection: the layer stays selected (panel, keyframes and the
  // timeline keep working on it), the preview just stops being covered in
  // handles. Clicking the layer again brings them back — the same toggle a
  // still click on the layer itself performs.
  //
  // Bound on window rather than in PreviewStage because the state lives here,
  // and scoped by geometry rather than by target: a drag in that area PANS the
  // preview, and a pan is not a click, so the gesture is only honoured if the
  // pointer barely moved between down and up.
  useEffect(() => {
    if (previewClickId == null) return undefined;
    const remove = onStillClickOutsideFrame(() => setPreviewClickId(null));
    return remove;
  }, [previewClickId]);
  // contentRect is layout-only, so the preview's CSS zoom never perturbs it —
  // that factor is applied separately where the handles are sized.
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width;
      if (width > 0) setLayoutWidth(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // ── Shape path Edit mode ──
  // The layer being point-edited, and the points as actually rendered right now
  // (a keyframed track morphs them, and the gizmo must sit on what you can see).
  const pathLayer = useMemo(() => {
    if (!pathEditItemId || disabled || camBlocked) return null;
    const layer = layers.find((l) => l.item.id === pathEditItemId);
    if (!layer || layer.clip.mediaType !== 'shape') return null;
    if (layer.item.shapeType !== 'path' && layer.item.shapeType !== 'line') return null;
    return layer;
  }, [layers, pathEditItemId, disabled, camBlocked]);
  // A line is an open path by definition, whatever the stored flag says.
  const pathClosed = pathLayer
    ? (pathLayer.item.shapeType !== 'line' && pathLayer.item.shapePath?.closed !== false)
    : true;
  const pathPoints = useMemo(() => {
    if (!pathLayer) return null;
    const track = pathLayer.item.propertyKeyframes?.[SHAPE_PATH_KF_KEY];
    if (Array.isArray(track) && track.length) {
      const sampled = evaluatePathTrack(track, pathLayer.pct);
      if (Array.isArray(sampled) && sampled.length >= 2) return sampled;
    }
    return pathLayer.item.shapePath?.points || null;
  }, [pathLayer]);
  const pathActive = !!pathLayer && Array.isArray(pathPoints) && pathPoints.length > 0;

  // Unit box (±0.5 of the layer's own box) ↔ frame pixels. The layer's width and
  // height already include its zoom, and the rotation is applied here, so anchors
  // land exactly where the shape is drawn.
  const unitToFrame = useCallback((p) => (
    pathLayer ? rotatedPoint(pathLayer.cx, pathLayer.cy, p.x * pathLayer.width, p.y * pathLayer.height, pathLayer.rotation) : { x: 0, y: 0 }
  ), [pathLayer]);
  const frameToUnit = useCallback((x, y) => {
    if (!pathLayer) return { x: 0, y: 0 };
    const r = -pathLayer.rotation * Math.PI / 180;
    const dx = x - pathLayer.cx;
    const dy = y - pathLayer.cy;
    return {
      x: (dx * Math.cos(r) - dy * Math.sin(r)) / Math.max(pathLayer.width, 1e-6),
      y: (dx * Math.sin(r) + dy * Math.cos(r)) / Math.max(pathLayer.height, 1e-6),
    };
  }, [pathLayer]);
  // Handle offsets are deltas, so they rotate but never translate.
  const frameDeltaToUnit = useCallback((dx, dy) => {
    if (!pathLayer) return { x: 0, y: 0 };
    const r = -pathLayer.rotation * Math.PI / 180;
    return {
      x: (dx * Math.cos(r) - dy * Math.sin(r)) / Math.max(pathLayer.width, 1e-6),
      y: (dx * Math.sin(r) + dy * Math.cos(r)) / Math.max(pathLayer.height, 1e-6),
    };
  }, [pathLayer]);

  // The drawn curve, in frame coordinates — reused for the polyline and for
  // finding where a click on the path landed.
  const curveSamples = useMemo(() => {
    if (!pathActive || pathPoints.length < 2) return [];
    const out = [];
    for (let i = 0; i <= CURVE_SAMPLES; i += 1) {
      const u = i / CURVE_SAMPLES;
      const hit = evaluateShapePath(pathPoints, pathClosed, u);
      if (hit) out.push({ ...unitToFrame(hit.position), u });
    }
    return out;
  }, [pathActive, pathPoints, pathClosed, unitToFrame]);
  const anchorPoints = useMemo(
    () => (pathActive ? pathPoints.map((p) => unitToFrame(p)) : []),
    [pathActive, pathPoints, unitToFrame]
  );

  // The selected anchors, primary first. Indices that no longer resolve (a point
  // was deleted, or a keyframed path changed length) are dropped here during
  // render rather than in an effect, so a stale index can never reach the drag
  // maths — the same trick the keyframe builder's multi-select uses.
  const selectedIndices = useMemo(() => {
    if (!pathActive) return NO_EXTRAS;
    const n = pathPoints.length;
    const out = [];
    const seen = new Set();
    const push = (i) => {
      const idx = Number(i);
      if (!Number.isInteger(idx) || idx < 0 || idx >= n || seen.has(idx)) return;
      seen.add(idx);
      out.push(idx);
    };
    push(pathEditPointIndex);
    (pathEditPointExtras || NO_EXTRAS).forEach(push);
    return out;
  }, [pathActive, pathPoints, pathEditPointIndex, pathEditPointExtras]);
  const selectedSet = useMemo(() => new Set(selectedIndices), [selectedIndices]);
  const multiSelected = selectedIndices.length > 1;
  // One way in and out of the selection: `primary` drives the panel's coordinate
  // fields and the tangent handles, `extras` is everything else in the group.
  const selectPoints = useCallback((primary, extras = null) => {
    onPathEditPointSelect?.(primary, extras && extras.length ? extras : null);
  }, [onPathEditPointSelect]);

  // Path edit owns the preview while it is on — a transform box over the same
  // layer would put two overlapping gizmos on one shape.
  const fromPreview = selectedItemId != null && selectedItemId === previewClickId && !camBlocked && !pathActive
    && selectedItemId !== motionPathEditItemId
    && selectedItemId !== afPointsEditItemId
    && selectedItemId !== rigPinEditItemId
    && selectedItemId !== maskEditItemId
    && selectedItemId !== distortEditItemId;
  const selected = fromPreview ? (layers.find((layer) => layer.item.id === selectedItemId) || null) : null;
  const selectedGeo = selected ? geometry(selected) : null;
  // Full Copy: the parent owns this layer's PRS, so there is nothing here a drag
  // could write. The selection box still draws (it shows where the layer actually
  // is) but the move/scale/rotate handles are withheld rather than silently no-op.
  const prsOwnedByParent = selected?.parentType === PARENTING_FULL_COPY;
  const positionOwnedByPath = objectMotionPathIsLive(selected?.item?.motionPath);

  // The SVG element and its viewBox grow together by `pad` frame-pixels on every
  // side, so one viewBox unit still means one frame pixel on screen. In path mode
  // the anchors are what must stay reachable, and they can sit outside the layer's
  // own box, so they stand in for the selection corners.
  const padGeo = pathActive
    ? (anchorPoints.length ? { corners: anchorPoints } : null)
    : selectedGeo;
  const pad = overlayPadding(padGeo, cam, videoWidth, videoHeight);
  const vb = { x: -pad, y: -pad, w: videoWidth + 2 * pad, h: videoHeight + 2 * pad };
  vbRef.current = vb;

  // User units per on-screen pixel: the overlay's own scale, undone by the
  // preview zoom (a CSS transform, so it never shows up in layout metrics) and
  // by the project camera, inside whose transformed group the handles live.
  // Both divisions keep the handles a constant size on screen. Computed here
  // rather than with the other render values because the multi-selection box
  // below is padded in screen pixels, and its geometry drives the drag maths.
  const unitsPerCssPx = layoutWidth > 0 ? vb.w / layoutWidth : vb.w / (rootRef.current?.clientWidth || vb.w);
  const cssUnit = unitsPerCssPx / Math.max(previewView?.scale || 1, 1e-6) / cam.zoom;

  // Axis-aligned box around the selected anchors, in frame coordinates. Frame
  // space (not the layer's own unit box) on purpose: the user scales and rotates
  // in what they see, so a rotated layer still gets an upright box.
  const groupBox = (() => {
    if (!multiSelected) return null;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const i of selectedIndices) {
      const p = anchorPoints[i];
      if (!p) continue;
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    if (!Number.isFinite(x0)) return null;
    const gap = GROUP_PAD_PX * cssUnit;
    // `raw` is the anchors' own bounds; the drawn box is that plus a constant
    // SCREEN-pixel gap. A scale has to pin a corner of `raw`, not of the drawn
    // box: the gap is re-added at its fixed width afterwards, so anchoring on the
    // padded corner would slide the pinned edge by gap × (scale − 1).
    const raw = { x0, y0, w: x1 - x0, h: y1 - y0 };
    return {
      raw,
      x0: x0 - gap, y0: y0 - gap, x1: x1 + gap, y1: y1 + gap,
      w: (x1 - x0) + 2 * gap, h: (y1 - y0) + 2 * gap,
      cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
    };
  })();

  const makeUpdates = useCallback((layer, values) => {
    // A gesture edits each affected property's own track — updating the key
    // under the playhead or inserting a new one there. Properties without a
    // track fall back to the item's base transform fields, unless keyframes are
    // enabled on this layer: then the gesture creates the track it needs
    // (xPercent/yPercent/scale/rotate) so the gizmo alone can build an
    // animation without pre-adding properties in the Keyframes panel.
    const tracks = { ...(layer.item.propertyKeyframes || {}) };
    const autoTrack = itemHasKeyframes(layer.item);
    const updates = {};
    let tracksChanged = false;
    const round = (n) => Math.round(n * 10000) / 10000;
    const editedTrack = (track, neutral, compute) => {
      const idx = track.findIndex((k) => Math.abs(number(k.position) - layer.pct) <= Math.max(0.001, layer.keyTolerancePct));
      if (idx >= 0) {
        const cur = number(track[idx].value, neutral);
        return track.map((k, i) => (i === idx ? { ...k, value: String(round(compute(cur))) } : k));
      }
      const cur = number(evaluatePropertyTrack(track, layer.pct, false), neutral);
      // Always Smooth — matching the 3D gizmo. Inheriting the previous key's
      // easing meant a track seeded from a Sine Smooth preset kept producing
      // Sine Smooth keys for every gesture after it.
      const newKey = {
        position: roundKeyPosition(layer.pct),
        value: String(round(compute(cur))),
        easing: TransitionEasing.EASE_IN_OUT,
      };
      return [...track, newKey].sort((a, b) => a.position - b.position);
    };
    const editOrBase = (prop, neutral, compute, applyBase) => {
      const track = tracks[prop];
      const hasTrack = Array.isArray(track) && track.length > 0;
      // A freshly seeded track starts as a single key at the playhead (constant
      // until a second gesture at another time adds the next key) — the same
      // shape editedTrack produces for an existing track.
      if (hasTrack || autoTrack) {
        tracks[prop] = editedTrack(hasTrack ? track : [], neutral, compute);
        tracksChanged = true;
      } else {
        applyBase();
      }
    };
    // A gesture is expressed in WORLD (frame) space, but it must land on the
    // child's own local PRS. With a parent that only rotates in Z and scales
    // uniformly — the case the 2D gizmo can draw at all — the inverse is exact:
    // undo the parent's rotation, then its scale. (A parent tilted in X/Y makes
    // the layer a perspective quad, which this overlay already can't represent;
    // the 3D world view is the tool for that.)
    const pScale = layer.parentPrs ? Math.max(1e-6, Math.abs(layer.parentPrs.sx)) : 1;
    const pRotDeg = layer.parentPrs ? prsRotationZDeg(layer.parentPrs) : 0;
    const pRot = (pRotDeg * Math.PI) / 180;
    const cosP = Math.cos(pRot);
    const sinP = Math.sin(pRot);
    // World Δ → parent-local Δ, in frame pixels.
    const localDX = (dx, dy) => (dx * cosP + dy * sinP) / pScale;
    const localDY = (dx, dy) => (-dx * sinP + dy * cosP) / pScale;

    const dxWorld = values.cx != null ? values.cx - layer.cx : 0;
    const dyWorld = values.cy != null ? values.cy - layer.cy : 0;
    if (values.cx != null || values.cy != null) {
      const dxLocal = localDX(dxWorld, dyWorld);
      const dyLocal = localDY(dxWorld, dyWorld);
      if (values.cx != null) {
        editOrBase('xPercent', 0,
          (cur) => cur + (dxLocal / videoWidth) * 100,
          () => { updates.panX = number(layer.item.panX) + (dxLocal / videoWidth) * 100; });
      }
      if (values.cy != null) {
        editOrBase('yPercent', 0,
          (cur) => cur + (dyLocal / videoHeight) * 100,
          () => { updates.panY = number(layer.item.panY) + (dyLocal / videoHeight) * 100; });
      }
    }
    if (values.zoom != null) {
      const localZoom = values.zoom / pScale;
      editOrBase('scale', 1,
        () => localZoom / Math.max(layer.baseZoom, 1e-6),
        () => { updates.zoom = localZoom; });
    }
    if (values.rotation != null) {
      const localRotation = values.rotation - pRotDeg;
      editOrBase('rotate', 0,
        () => localRotation - layer.baseRotation,
        () => { Object.assign(updates, { rotateZ: localRotation, rotation: 0 }); });
    }
    // A shape size field (shapeWidthPx, shapeHeightPct, shapeRadiusPx, …) as an
    // absolute value — same track-or-base rule as the transform props above.
    if (values.shapeSize) {
      const { key, value } = values.shapeSize;
      editOrBase(key, value, () => value, () => { updates[key] = value; });
    }
    if (tracksChanged) updates.propertyKeyframes = tracks;
    return updates;
  }, [videoWidth, videoHeight]);

  // Pointer in frame coordinates WITHOUT the camera inverse. Under perspective there
  // is no usable inverse, so selection compares this against forward-projected quads.
  const eventPointRaw = useCallback((event) => {
    const rect = rootRef.current.getBoundingClientRect();
    return {
      x: vbRef.current.x + (event.clientX - rect.left) * vbRef.current.w / rect.width,
      y: vbRef.current.y + (event.clientY - rect.top) * vbRef.current.h / rect.height,
    };
  }, []);

  // ── Motion Tracking: draw the region ──────────────────────────────────────
  // Rubber band in frame coordinates while the drag is live.
  const [trackBand, setTrackBand] = useState(null);
  const [samBand, setSamBand] = useState(null);
  // Camera-tracking point picking: marquee band, and the last click for
  // double-click detection. The click is timed rather than handled with a
  // dblclick listener because selecting re-renders this overlay, and replacing
  // the node a dblclick would be delivered to means that event never arrives.
  const [camBand, setCamBand] = useState(null);
  const camClickRef = useRef(null);
  // Roto's PEN draft (frame coords) while the region is being placed: anchors
  // with optional tangents, a cursor for the lead line, the selected anchor.
  // Rendered live — the one moment you most need to see what you drew is while
  // you are drawing it. Its own undo history: one snapshot per gesture.
  const [rotoDraft, setRotoDraftState] = useState(null);
  const rotoDraftRef = useRef(null);
  const rotoDraftHistRef = useRef({ past: [], future: [] });
  const rotoDraftDragRef = useRef(null);
  const setRotoDraft = useCallback((next) => { rotoDraftRef.current = next; setRotoDraftState(next); }, []);
  const pushRotoDraftHistory = useCallback((points) => {
    const h = rotoDraftHistRef.current;
    h.past.push((points || []).map((q) => ({ ...q })));
    if (h.past.length > 200) h.past.shift();
    h.future = [];
  }, []);
  // Fine-tune: which region anchor shows its tangent knobs.
  const [rotoRegionSel, setRotoRegionSel] = useState(null);
  const rotoRegionDragRef = useRef(null);
  // The camera <g>: frame coords → client px, for the loupe's magnified target.
  const rotoCamGroupRef = useRef(null);
  const rotoPreviewDragRef = useRef(null);
  const trackDrawLayer = useMemo(
    () => (trackRegionDraw ? layers.find((l) => l.item.id === trackRegionDraw.itemId) || null : null),
    [trackRegionDraw, layers]
  );
  const trackDrawActive = !!trackDrawLayer && !camBlocked;
  // Roto ▸ SAM 3 Points / Box on an image layer own the clicks the same way the
  // box draw does — the layer's own move / frame hits must not swallow them.
  const samPickActive = !!samPick?.tool && !camBlocked && layers.some((l) => l.item.id === samPick.itemId);
  // Same rule the box draw follows: under dolly/tilt a layer is a perspective
  // quad, the affine inverse behind eventPoint is a lie, and every click would
  // land on the wrong point. Refuse rather than mislead.
  const cameraPickActive = !!cameraCloud && !disabled && !camBlocked;
  // Hundreds of marks as ONE path per colour. A node per point makes React
  // reconcile the whole cloud on every playhead move, which is felt immediately
  // on a 600-point solve.
  const cameraCloudPaths = useMemo(() => {
    if (!cameraPickActive) return null;
    const r = 5 * cssUnit;
    const ring = r * 1.9;
    const byColor = new Map();
    let sel = '';
    for (const p of cameraCloud.points) {
      const cross = `M${p.x - r} ${p.y - r}L${p.x + r} ${p.y + r}M${p.x + r} ${p.y - r}L${p.x - r} ${p.y + r}`;
      const color = p.group >= 0
        ? CAMERA_PLANE_COLORS[p.group % CAMERA_PLANE_COLORS.length]
        : CAMERA_UNGROUPED_COLOR;
      byColor.set(color, (byColor.get(color) || '') + cross);
      if (p.on) {
        sel += `${cross}M${p.x + ring} ${p.y}A${ring} ${ring} 0 1 1 ${p.x - ring} ${p.y}A${ring} ${ring} 0 1 1 ${p.x + ring} ${p.y}`;
      }
    }
    return { byColor: [...byColor.entries()], sel };
  }, [cameraPickActive, cameraCloud, cssUnit]);
  const cameraHitAt = useCallback((x, y) => {
    if (!cameraCloud) return null;
    const tol = 11 * cssUnit;
    let best = null;
    let bd = Infinity;
    for (const q of cameraCloud.points) {
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < bd) { bd = d; best = q; }
    }
    return bd <= tol ? best : null;
  }, [cameraCloud, cssUnit]);
  // Frame point → the layer quad's own uv. Un-rotates and un-scales about the
  // layer centre, so a box drawn on a rotated or zoomed layer still describes the
  // same piece of footage.
  const frameToLayerUv = useCallback((layer, x, y) => {
    const r = -layer.rotation * Math.PI / 180;
    const dx = x - layer.cx;
    const dy = y - layer.cy;
    return {
      u: (dx * Math.cos(r) - dy * Math.sin(r)) / Math.max(layer.width, 1e-6) + 0.5,
      v: (dx * Math.sin(r) + dy * Math.cos(r)) / Math.max(layer.height, 1e-6) + 0.5,
    };
  }, []);

  const eventPoint = useCallback((event) => {
    // getBoundingClientRect reports the box as actually painted, so the preview's
    // own zoom/pan transform is already folded into this mapping.
    const rect = rootRef.current.getBoundingClientRect();
    // Map the pointer back through the camera so every consumer below keeps
    // working in plain frame coordinates.
    const p = cam.inverse(
      vbRef.current.x + (event.clientX - rect.left) * vbRef.current.w / rect.width,
      vbRef.current.y + (event.clientY - rect.top) * vbRef.current.h / rect.height
    );
    return {
      x: p.x,
      y: p.y,
      // Snapping should stay a constant on-SCREEN distance, so the tolerance
      // shrinks as the camera (or the preview view) zooms in.
      threshold: (SNAP_PX * vbRef.current.w / rect.width) / cam.zoom,
    };
  }, [cam]);

  // ── Inline text editing ────────────────────────────────────────────────────
  const openTextEdit = useCallback((layer) => {
    const next = {
      itemId: layer.item.id,
      initial: typeof layer.item.textContent === 'string' ? layer.item.textContent : '',
    };
    textEditRef.current = next;
    setTextEdit(next);
    setInlineTextEdit(next.itemId);
  }, []);
  const closeTextEdit = useCallback((commit) => {
    const cur = textEditRef.current;
    if (!cur) return;
    const value = commit && textEditTaRef.current ? textEditTaRef.current.value : null;
    textEditRef.current = null;
    setTextEdit(null);
    setInlineTextEdit(null);
    if (commit && value != null && value !== cur.initial) {
      // One undo entry for the whole edit, on the same write channel the gizmo uses.
      onTransformItem(cur.itemId, { textContent: value }, false);
    }
  }, [onTransformItem]);
  // The editor cannot outlive its context: playback disables the overlay, a
  // perspective camera has no affine to place the box with, path edit owns the
  // preview, the playhead can leave the clip, and a selection change means the
  // user has moved on. These close with COMMIT — the blur that usually precedes
  // them has committed already (making this a no-op), and when it didn't
  // (keyboard-driven changes), silently losing typed words is the worse surprise.
  useEffect(() => {
    if (!textEdit) return;
    if (disabled || camBlocked || pathActive
      || selectedItemId !== textEdit.itemId
      || !layers.some((layer) => layer.item.id === textEdit.itemId)) closeTextEdit(true);
  }, [textEdit, disabled, camBlocked, pathActive, selectedItemId, layers, closeTextEdit]);
  // Whatever unmounts the overlay must not leave the Player suppressing paint.
  useEffect(() => () => setInlineTextEdit(null), []);
  // Focus arrives with everything selected — the double-click intent is almost
  // always "replace these words", and arrow keys still reach any spot.
  useEffect(() => {
    if (!textEdit) return;
    const ta = textEditTaRef.current;
    if (!ta) return;
    ta.style.height = '0px';
    ta.style.height = `${ta.scrollHeight}px`;
    ta.focus({ preventScroll: true });
    ta.select();
  }, [textEdit]);
  // A still click on the empty area around the frame closes the editor the way
  // it puts the gizmo away — commit, selection untouched. It cannot ride the
  // blur that handles every other outside click: the pan gesture
  // preventDefaults its pointerdown, so a click out there never blurs the
  // textarea at all. The gizmo dismissal fires on the same click, so the
  // handles stay away too — exactly the gizmo-mode behaviour.
  useEffect(() => {
    if (!textEdit) return undefined;
    return onStillClickOutsideFrame(() => closeTextEdit(true));
  }, [textEdit, closeTextEdit]);
  // Double-click detection, TIMED on pointerdown rather than a dblclick
  // listener, for two reasons this file already documents: selecting re-renders
  // the overlay (the second click can land on a freshly mounted node), and the
  // move gesture preventDefaults its pointerdown — which suppresses the
  // browser's derived mouse events, dblclick included. So the two entry points
  // a click pair can take (the frame hit rect and the selection polygon) both
  // report their pointerdowns here, and the second one within the window opens
  // the editor.
  const textClickRef = useRef(null);
  const maybeOpenTextEdit = (layer, point) => {
    if (!layer || layer.clip.mediaType !== 'text' || disabled || camBlocked || pathActive) return false;
    // Path text has no resting block to type into — its glyphs ride the curve
    // (it publishes no footprint for the same reason).
    if (layer.item.textPathEnabled && Array.isArray(layer.item.motionPath?.points) && layer.item.motionPath.points.length >= 2) return false;
    const now = Date.now();
    const prev = textClickRef.current;
    textClickRef.current = { id: layer.item.id, t: now, x: point.x, y: point.y };
    if (!prev || prev.id !== layer.item.id || now - prev.t >= 400) return false;
    // A constant screen-distance wobble allowance, like the drag threshold.
    if (Math.hypot(point.x - prev.x, point.y - prev.y) > (point.threshold || 8) * 1.5) return false;
    textClickRef.current = null;
    // The click pair may just have toggled the gizmo off (the still-click
    // behaviour); editing re-asserts the preview selection.
    setPreviewClickId(layer.item.id);
    onSelectItem(layer.item.id, layer.channelId);
    openTextEdit(layer);
    return true;
  };

  // Fine-tune the region itself. These handlers intentionally own their pointer
  // capture instead of entering the transform gizmo's shared drag state: the
  // region is transient analysis input, not project geometry or an undo step.
  // A drag moves an anchor (its tangents ride along — they are offsets), a
  // knob drag shapes a tangent (mirrored unless Alt) and marks the anchor
  // MANUAL so the auto-smoothing pass leaves it alone, Alt-click toggles a
  // corner. Every release re-flattens the outline and stamps a re-trace.
  const emitRegionNodes = (nodes, commit) => {
    onRotoRegionChange?.(rotoRegion.itemId, { nodes, pts: flattenRotoNodes(nodes) }, commit);
  };
  const rotoRegionAnchorHandlers = (layer, index) => ({
    onPointerDown: (event) => {
      if (rotoRegionEditItemId !== rotoRegion?.itemId || !Array.isArray(rotoRegion?.nodes)) return;
      event.preventDefault();
      event.stopPropagation();
      const nodes = rotoRegion.nodes.map((q) => ({ ...q }));
      if (event.altKey) {
        const q = nodes[index];
        const isCorner = q.manual && !(q.hIn?.u || q.hIn?.v || q.hOut?.u || q.hOut?.v);
        nodes[index] = isCorner
          ? { u: q.u, v: q.v }
          : { u: q.u, v: q.v, hIn: { u: 0, v: 0 }, hOut: { u: 0, v: 0 }, manual: true };
        setRotoRegionSel(index);
        emitRegionNodes(nodes, true);
        return;
      }
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setRotoRegionSel(index);
      const at = eventPoint(event);
      rotoRegionDragRef.current = { mode: 'anchor', index, nodes, origin: at, last: null, touchStart: rotoTouchStart(event) };
    },
    onPointerMove: (event) => {
      const drag = rotoRegionDragRef.current;
      if (!drag || drag.mode !== 'anchor' || drag.index !== index || !event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
      const p = rotoLift(eventPoint(event), drag.touchStart);
      const d = frameDeltaToUv(layer, p.x - drag.origin.x, p.y - drag.origin.y);
      const q = drag.nodes[index];
      const next = drag.nodes.map((z, i) => (i === index
        ? { ...z, u: clamp01(q.u + d.u), v: clamp01(q.v + d.v) }
        : z));
      drag.last = next;
      emitRegionNodes(next, false);
      rotoLoupe(event, { kind: 'region', index });
    },
    onPointerUp: (event) => {
      hidePointLoupe();
      const drag = rotoRegionDragRef.current;
      if (!drag || drag.mode !== 'anchor' || drag.index !== index) return;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
      rotoRegionDragRef.current = null;
      if (drag.last) emitRegionNodes(drag.last, true);
    },
    onPointerCancel: () => { rotoRegionDragRef.current = null; hidePointLoupe(); },
  });
  const rotoRegionKnobHandlers = (layer, index, key) => ({
    onPointerDown: (event) => {
      if (rotoRegionEditItemId !== rotoRegion?.itemId || !Array.isArray(rotoRegion?.nodes)) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      // Start from the SMOOTHED nodes: an auto anchor's knob sits where the
      // derived tangent puts it, and pulling it should continue from there.
      rotoRegionDragRef.current = { mode: 'knob', index, key, nodes: smoothRotoNodes(rotoRegion.nodes), last: null, touchStart: rotoTouchStart(event) };
    },
    onPointerMove: (event) => {
      const drag = rotoRegionDragRef.current;
      if (!drag || drag.mode !== 'knob' || drag.index !== index || drag.key !== key || !event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
      const p = rotoLift(eventPoint(event), drag.touchStart);
      const q = drag.nodes[index];
      const a = layerUvToFrame(layer, q.u, q.v);
      const h = frameDeltaToUv(layer, p.x - a.x, p.y - a.y);
      const other = key === 'hOut' ? 'hIn' : 'hOut';
      const keep = q[other] || { u: 0, v: 0 };
      const next = drag.nodes.map((z, i) => (i === index ? {
        u: z.u, v: z.v, manual: true,
        [key]: h,
        [other]: event.altKey ? { ...keep } : { u: -h.u, v: -h.v },
      } : z));
      drag.last = next;
      emitRegionNodes(next, false);
      rotoLoupe(event, { kind: 'region', index, key, mode: 'handle' });
    },
    onPointerUp: (event) => {
      hidePointLoupe();
      const drag = rotoRegionDragRef.current;
      if (!drag || drag.mode !== 'knob' || drag.index !== index || drag.key !== key) return;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
      rotoRegionDragRef.current = null;
      if (drag.last) emitRegionNodes(drag.last, true);
    },
    onPointerCancel: () => { rotoRegionDragRef.current = null; hidePointLoupe(); },
  });

  // ── Roto pen draft ─────────────────────────────────────────────────────────
  const rotoDrawActive = trackDrawActive && trackRegionDraw?.purpose === 'roto';
  // The loupe for a dragged roto point (draft anchors / tangents, region
  // fine-tune, correction anchors), centred on the ANCHOR being edited — while
  // a tangent is pulled the pointer is its tip, far from the curve it bends.
  // On TOUCH the point rides above the fingertip (`liftForTouch`); the anchor
  // is read from the committed overlay, so it is wherever the point now is,
  // while `pointer` stays on the finger and keeps the loupe out of its way.
  // `mode` 'anchor' (the point moves) or 'handle' (`key` is being pulled).
  const rotoLoupe = (event, { kind, index, key = null, mode = 'anchor' }) => {
    const pointer = { x: event.clientX, y: event.clientY };
    queuePointLoupe(() => {
      const root = rootRef.current;
      if (!root) return null;
      return { ...rotoLoupeScene(root, { kind, index, key, handles: mode === 'handle' }), svg: root, mode, pointer };
    }, rootRef.current);
  };
  // Roto pen out, nothing pressed: where the next point lands, and the curve
  // that click would make (dashed). `queued`: this move re-renders the draft.
  const rotoHoverLoupe = (event, p, queued) => {
    if (!p || event.pointerType === 'touch') return;
    const pointer = { x: event.clientX, y: event.clientY };
    const d = rotoDraftRef.current;
    const first = d?.points?.length >= 3 ? d.points[0] : null;
    const closing = !!first && Math.hypot(first.x - p.x, first.y - p.y) <= ROTO_PEN_CLOSE_PX * cssUnit;
    const build = () => {
      const root = rootRef.current;
      if (!root) return null;
      const live = rotoDraftRef.current;
      const curve = live?.points?.length ? nextPenCurve(live.points, p, { closing }) : null;
      return {
        ...rotoLoupeScene(root, { kind: 'draft' }),
        svg: root,
        mode: 'hover',
        target: pointer,
        pointer,
        preview: curve && rotoCamGroupRef.current ? { el: rotoCamGroupRef.current, d: curve } : null,
      };
    };
    if (queued) queuePointLoupe(build, rootRef.current);
    else showPointLoupe(build());
  };
  // A touch drag's origin, carrying the frame-units-per-5-screen-px scale the
  // lift ramp is expressed in (PTO's cssUnit IS frame units per css px).
  const rotoTouchStart = (event) => (isTouchEvent(event)
    ? { ...eventPoint(event), threshold: 5 * cssUnit }
    : null);
  const rotoLift = (p, start) => (start ? liftForTouch(p, start) : p);
  // Unmount is DISPOSAL, not a hide: the loupe's module globals hold this
  // viewport and the preview canvas, and a hidden node keeps both reachable
  // after the editor is gone.
  useEffect(() => () => disposePointLoupe(), []);
  // The loupe paints a move once it is COMMITTED (see pointLoupe.js).
  usePointLoupeCommit(rootRef);
  useEffect(() => { if (!rotoDrawActive) hidePointLoupe(); }, [rotoDrawActive]);
  useEffect(() => { if (rotoRegionEditItemId == null) hidePointLoupe(); }, [rotoRegionEditItemId]);

  /**
   * Close the draft and hand the region over. One anchor is a tap: it becomes
   * a circle around that point (the lab's rule — a tap is not a failed drag).
   * Two anchors cannot close; three or more become a smooth closed outline
   * (manual tangents kept, the rest Catmull-Rom) in layer uv, flattened into
   * the polygon the tracker gates on.
   */
  const commitRotoDraft = useCallback(() => {
    const d = rotoDraftRef.current;
    const layer = trackDrawLayer;
    if (!d?.points?.length || !layer) return;
    let nodes;
    if (d.points.length === 1) {
      const c = d.points[0];
      const r = rotoTapRadius(layer);
      const k = 0.5523 * r;
      const ring = [
        { x: c.x, y: c.y - r, hIn: { x: -k, y: 0 }, hOut: { x: k, y: 0 } },
        { x: c.x + r, y: c.y, hIn: { x: 0, y: -k }, hOut: { x: 0, y: k } },
        { x: c.x, y: c.y + r, hIn: { x: k, y: 0 }, hOut: { x: -k, y: 0 } },
        { x: c.x - r, y: c.y, hIn: { x: 0, y: k }, hOut: { x: 0, y: -k } },
      ];
      nodes = ring.map((q) => {
        const uv = frameToLayerUv(layer, q.x, q.y);
        return { u: uv.u, v: uv.v, hIn: frameDeltaToUv(layer, q.hIn.x, q.hIn.y), hOut: frameDeltaToUv(layer, q.hOut.x, q.hOut.y), manual: true };
      });
    } else if (d.points.length < 3) {
      return;
    } else {
      nodes = d.points.map((q) => {
        const uv = frameToLayerUv(layer, q.x, q.y);
        const node = { u: clamp01(uv.u), v: clamp01(uv.v) };
        if (q.manual) {
          node.manual = true;
          node.hIn = frameDeltaToUv(layer, q.hIn?.x || 0, q.hIn?.y || 0);
          node.hOut = frameDeltaToUv(layer, q.hOut?.x || 0, q.hOut?.y || 0);
        }
        return node;
      });
    }
    rotoDraftDragRef.current = null;
    rotoDraftHistRef.current = { past: [], future: [] };
    setRotoDraft(null);
    onTrackRegionDrawn?.(layer.item.id, { pts: flattenRotoNodes(nodes), nodes }, {
      w: layer.width,
      h: layer.height,
      trackId: null,
    });
  }, [trackDrawLayer, frameToLayerUv, onTrackRegionDrawn, setRotoDraft]);

  // The draft belongs to the draw mode: leaving it (Escape, the panel, a
  // finished draw) drops whatever was placed.
  useEffect(() => {
    if (rotoDrawActive) return undefined;
    rotoDraftDragRef.current = null;
    rotoDraftHistRef.current = { past: [], future: [] };
    setRotoDraft(null);
    return undefined;
  }, [rotoDrawActive, setRotoDraft]);
  // Editing a region: the tangent selection is per region.
  useEffect(() => { setRotoRegionSel(null); }, [rotoRegionEditItemId, rotoRegion?.itemId]);
  const rotoDraftCount = rotoDrawActive ? (rotoDraft?.points?.length || 0) : 0;
  useEffect(() => { onRotoDraftChange?.(rotoDraftCount); }, [rotoDraftCount, onRotoDraftChange]);
  // The panel's Finish button: a nonce on the draw request.
  const rotoFinishNonce = rotoDrawActive ? trackRegionDraw?.finish || 0 : 0;
  const rotoFinishSeenRef = useRef(0);
  useEffect(() => {
    if (!rotoFinishNonce || rotoFinishNonce === rotoFinishSeenRef.current) return;
    rotoFinishSeenRef.current = rotoFinishNonce;
    commitRotoDraft();
  }, [rotoFinishNonce, commitRotoDraft]);

  // Keys while the pen region is being placed, captured on window ahead of the
  // editor's shortcuts (focus is usually still in the panel that armed the
  // draw): Enter closes, Escape drops the draft (a second Escape leaves the
  // mode), Backspace steps back a point, ⌘Z / ⌘⇧Z walk the draft's own history
  // — letting ⌘Z through would undo the project under the drawing.
  useEffect(() => {
    if (!rotoDrawActive) return undefined;
    const onKey = (e) => {
      if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const d = rotoDraftRef.current;
      const mod = e.metaKey || e.ctrlKey;
      const isZ = mod && !e.altKey && (e.key === 'z' || e.key === 'Z');
      const isY = mod && !e.altKey && (e.key === 'y' || e.key === 'Y');
      if (isZ || isY) {
        const h = rotoDraftHistRef.current;
        const redo = isY || e.shiftKey;
        if (redo) {
          if (!h.future.length) return;
          e.preventDefault(); e.stopPropagation();
          const next = h.future.pop();
          h.past.push((d?.points || []).map((q) => ({ ...q })));
          setRotoDraft({ ...(d || {}), cursor: null, points: next, sel: null });
          return;
        }
        if (!d) return;
        e.preventDefault(); e.stopPropagation();
        const prev = h.past.pop();
        if (!prev) return;
        h.future.push(d.points.map((q) => ({ ...q })));
        rotoDraftDragRef.current = null;
        setRotoDraft(prev.length ? { ...d, cursor: null, points: prev, sel: null } : null);
        return;
      }
      if (e.key === 'Enter') {
        if (!d?.points?.length) return;
        e.preventDefault(); e.stopPropagation();
        commitRotoDraft();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        if (d?.points?.length) {
          rotoDraftDragRef.current = null;
          rotoDraftHistRef.current = { past: [], future: [] };
          setRotoDraft(null);
        } else {
          onCancelTrackRegionDraw?.();
        }
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (!d?.points?.length || mod) return;
        e.preventDefault(); e.stopPropagation();
        pushRotoDraftHistory(d.points);
        const points = d.points.slice(0, -1);
        setRotoDraft(points.length ? { ...d, points, sel: null } : null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [rotoDrawActive, commitRotoDraft, onCancelTrackRegionDraw, setRotoDraft, pushRotoDraftHistory]);

  // Motion-track box / re-anchor ghost drags: self-contained pointer capture on
  // the element itself, reporting frame-space points plus a phase. The editor
  // owns the geometry that turns a point into a track sample — this only maps
  // the pointer. (The root's shared move/end handlers no-op for these drags:
  // they key off dragRef, which stays null here.)
  const trackDragHandlers = (report) => (report ? {
    onPointerDown: (e) => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      report(eventPoint(e), 'start');
    },
    onPointerMove: (e) => {
      if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
      report(eventPoint(e), 'move');
    },
    onPointerUp: (e) => {
      if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      report(eventPoint(e), 'end');
    },
    onPointerCancel: (e) => {
      report(eventPoint(e), 'end');
    },
  } : {});

  // ── Marquee (rubber-band) anchor selection ──
  // Dragged from anywhere in the frame that isn't an anchor, a tangent or the
  // multi-selection box. Held in frame coordinates so it survives preview zoom,
  // camera zoom and a rotated layer without any second mapping.
  const startMarquee = (event) => {
    if (!pathActive) return;
    event.preventDefault(); event.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const p = eventPoint(event);
    dragRef.current = {
      mode: 'marquee', p, moved: 0, box: null,
      // Shift/⌘ keeps what is already selected and adds to it.
      additive: event.shiftKey || event.metaKey || event.ctrlKey,
      base: selectedIndices.slice(),
    };
    setMarquee({ x: p.x, y: p.y, w: 0, h: 0 });
  };

  const moveMarquee = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.mode !== 'marquee') return;
    const p = eventPoint(event);
    drag.moved = Math.max(drag.moved, Math.hypot(p.x - drag.p.x, p.y - drag.p.y));
    drag.box = {
      x: Math.min(drag.p.x, p.x), y: Math.min(drag.p.y, p.y),
      w: Math.abs(p.x - drag.p.x), h: Math.abs(p.y - drag.p.y),
    };
    setMarquee(drag.box);
  };

  const endMarquee = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    setMarquee(null);
    if (!drag) return;
    // Under the drag threshold it was a plain click on empty space: clear the
    // selection, unless the modifier said "add to what's there".
    if (!drag.box || drag.moved <= drag.p.threshold * 0.5) {
      if (!drag.additive) selectPoints(-1);
      return;
    }
    const box = drag.box;
    const hits = [];
    anchorPoints.forEach((q, i) => {
      if (q.x >= box.x && q.x <= box.x + box.w && q.y >= box.y && q.y <= box.y + box.h) hits.push(i);
    });
    // Base first, so an additive sweep leaves the existing primary in charge.
    const merged = drag.additive ? [...new Set([...drag.base, ...hits])] : hits;
    if (!merged.length) selectPoints(-1);
    else selectPoints(merged[0], merged.slice(1));
  };

  const start = (event, mode, corner = 0) => {
    if (disabled || camBlocked || !selected || prsOwnedByParent || (mode === 'move' && positionOwnedByPath)) return;
    // The second click of a double-click on a selected text layer lands here,
    // on the polygon — it opens the inline editor instead of starting a drag.
    // preventDefault matters: it suppresses the compat mousedown that would
    // otherwise focus the SVG root and blur (= instantly close) the editor.
    if (mode === 'move' && maybeOpenTextEdit(selected, eventPoint(event))) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault(); event.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const p = eventPoint(event);
    const selectedGeometry = geometry(selected);
    const originalUpdates = {
      propertyKeyframes: selected.item.propertyKeyframes,
      panX: selected.item.panX, panY: selected.item.panY, zoom: selected.item.zoom,
      rotateZ: selected.item.rotateZ, rotation: selected.item.rotation,
    };
    dragRef.current = { mode, corner, p, selected, selectedGeometry, originalUpdates, changed: false, moved: 0 };
  };

  const move = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = eventPoint(event);
    drag.moved = Math.max(drag.moved, Math.hypot(p.x - drag.p.x, p.y - drag.p.y));
    const base = drag.selected;
    let updates = {};
    const nextGuides = [];
    if (drag.mode === 'move') {
      // Snapping compares SELECTION boxes (a text layer's is its block, not its
      // frame-sized plate), so the drag is carried as a delta and only converted to
      // the layer origin at the end — the two differ for an offset box.
      let dx = p.x - drag.p.x;
      let dy = p.y - drag.p.y;
      if (!event.altKey) {
        const own = geometry(base, dx, dy);
        const ownCentre = selectionBox(base, dx, dy);
        const xTargets = [0, videoWidth / 2, videoWidth];
        const yTargets = [0, videoHeight / 2, videoHeight];
        layers.filter((l) => l.item.id !== base.item.id).forEach((l) => {
          const g = geometry(l); const c = selectionBox(l);
          xTargets.push(g.left, c.cx, g.right); yTargets.push(g.top, c.cy, g.bottom);
        });
        let bestX = null, bestY = null;
        [own.left, ownCentre.cx, own.right].forEach((edge) => xTargets.forEach((target) => { const d = target - edge; if (Math.abs(d) <= p.threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, target }; }));
        [own.top, ownCentre.cy, own.bottom].forEach((edge) => yTargets.forEach((target) => { const d = target - edge; if (Math.abs(d) <= p.threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, target }; }));
        if (bestX) { dx += bestX.d; nextGuides.push({ axis: 'x', value: bestX.target }); }
        if (bestY) { dy += bestY.d; nextGuides.push({ axis: 'y', value: bestY.target }); }
      }
      updates = makeUpdates(base, { cx: base.cx + dx, cy: base.cy + dy });
    } else if (drag.mode === 'scale') {
      // Shift scales about the box centre; otherwise the opposite corner is pinned.
      // Either way the anchor is a point of the LAYER, so mapping the origin through
      // the same scale (below) pins it exactly — including for an offset box, whose
      // own distance from the origin grows with the zoom.
      const anchor = event.shiftKey
        ? { x: selectionBox(base).cx, y: selectionBox(base).cy }
        : drag.selectedGeometry.corners[(drag.corner + 2) % 4];
      const startDistance = Math.hypot(drag.p.x - anchor.x, drag.p.y - anchor.y) || 1;
      const distance = Math.hypot(p.x - anchor.x, p.y - anchor.y);
      const unclampedFactor = distance / startDistance;
      const zoom = Math.max(0.1, Math.min(20, base.zoom * unclampedFactor));
      const factor = zoom / base.zoom;
      const cx = anchor.x + (base.cx - anchor.x) * factor;
      const cy = anchor.y + (base.cy - anchor.y) * factor;
      updates = makeUpdates(base, { zoom, cx, cy });
    } else if (drag.mode === 'edge' && base.shapeBase) {
      // A side grip resizes the shape ITSELF — Width or Height (a circle's
      // radius), never Scale, so stroke and corner radius are not stretched —
      // with the opposite side pinned. Shift resizes about the centre, and so
      // does a live motion path, which owns the position the pin would move.
      const edge = SHAPE_EDGES[drag.corner];
      const c = drag.selectedGeometry.corners;
      const box = selectionBox(base);
      const ox = (c[edge.a].x + c[edge.b].x) / 2 - box.cx;
      const oy = (c[edge.a].y + c[edge.b].y) / 2 - box.cy;
      const half = Math.hypot(ox, oy);
      if (half > 1e-6) {
        const nx = ox / half;
        const ny = oy / half;
        const centred = event.shiftKey || positionOwnedByPath;
        const along = (p.x - drag.p.x) * nx + (p.y - drag.p.y) * ny;
        const factor = Math.max(0, (2 * half + (centred ? 2 * along : along)) / (2 * half));
        const item = base.item;
        const usePx = item.shapeSizeUnit === 'px';
        const circle = item.shapeType === 'circle';
        const field = circle
          ? { key: usePx ? 'shapeRadiusPx' : 'shapeRadiusPct', span: Math.min(videoWidth, videoHeight), size: base.shapeBase.width / 2 }
          : edge.axis === 'width'
            ? { key: usePx ? 'shapeWidthPx' : 'shapeWidthPct', span: videoWidth, size: base.shapeBase.width }
            : { key: usePx ? 'shapeHeightPx' : 'shapeHeightPct', span: videoHeight, size: base.shapeBase.height };
        // Whole px (what the Size field shows) or 0.01 %, floored at the
        // renderer's own minimum of 1.
        const raw = usePx ? field.size * factor : (field.size * factor * 100) / field.span;
        const value = Math.max(1, usePx ? Math.round(raw) : Math.round(raw * 100) / 100);
        // Pin from the size actually stored, so rounding never slides the far side.
        const storedFactor = (usePx ? value : (value / 100) * field.span) / Math.max(field.size, 1e-6);
        const shift = centred ? 0 : half * (storedFactor - 1);
        updates = makeUpdates(base, {
          ...(shift ? { cx: base.cx + nx * shift, cy: base.cy + ny * shift } : {}),
          shapeSize: { key: field.key, value },
        });
      }
    } else if (drag.mode === 'rotate') {
      const a0 = Math.atan2(drag.p.y - base.cy, drag.p.x - base.cx);
      const a1 = Math.atan2(p.y - base.cy, p.x - base.cx);
      let rotation = base.rotation + (a1 - a0) * 180 / Math.PI;
      if (event.shiftKey) rotation = Math.round(rotation / 15) * 15;
      else if (!event.altKey) [-180, -90, 0, 90, 180].forEach((a) => { if (Math.abs(rotation - a) < 4) rotation = a; });
      updates = makeUpdates(base, { rotation: Math.max(-180, Math.min(180, rotation)) });
    }
    setGuides(nextGuides);
    onTransformItem(base.item.id, updates, drag.changed);
    drag.changed = true;
  };

  const end = () => {
    const drag = dragRef.current;
    if (drag && drag.mode === 'marquee') { endMarquee(); return; }
    // Path gestures commit as they go and have no click-to-deselect behaviour.
    if (drag && (drag.mode === 'anchor' || drag.mode === 'tangent')) {
      dragRef.current = null;
      return;
    }
    if (drag && drag.mode === 'group') {
      if (drag.moved <= drag.p.threshold * 0.5) {
        // A still click inside the box clears the selection — otherwise the box
        // would permanently shield the area under it from a fresh marquee. On
        // one of its members it collapses to that anchor instead, which is the
        // only way back to a single point without leaving the group first.
        if (drag.fromBox) selectPoints(-1);
        else if (drag.anchorIndex != null) selectPoints(drag.anchorIndex);
      }
      dragRef.current = null;
      return;
    }
    // A plain click on the already-active layer (no real drag) toggles the
    // gizmo off; the next click on the layer brings it back. Jittery sub-
    // threshold drags are rolled back so the click stays a no-op transform.
    if (drag && drag.mode === 'move' && drag.moved <= drag.p.threshold * 0.5) {
      if (drag.changed) onTransformItem(drag.selected.item.id, drag.originalUpdates, true);
      setPreviewClickId(null);
    }
    dragRef.current = null;
    setGuides([]);
  };

  /**
   * Apply an edit to the layer's path, routing it to the right home.
   *
   * With no keyframe track the points live on the item. With one, a POSITIONAL
   * edit rewrites the key under the playhead (inserting one there if absent, seeded
   * from the morphed geometry so nothing jumps), while a STRUCTURAL edit — anything
   * that changes the point count or their order — has to run on every key, or the
   * lists stop matching and the morph becomes undefined.
   */
  const applyPathEdit = useCallback((op, { replace = false, structural = false } = {}) => {
    if (!pathLayer) return;
    const item = pathLayer.item;
    const closed = pathClosed;
    const basePoints = item.shapePath?.points || [];
    const track = item.propertyKeyframes?.[SHAPE_PATH_KF_KEY];
    const hasTrack = Array.isArray(track) && track.length > 0;
    const updates = {};
    if (!hasTrack) {
      updates.shapePath = { points: op(basePoints), closed };
    } else if (structural) {
      updates.propertyKeyframes = {
        ...item.propertyKeyframes,
        [SHAPE_PATH_KF_KEY]: track.map((key) => ({
          ...key,
          value: encodeShapePathValue(op(decodeShapePathValue(key.value) || basePoints)),
        })),
      };
      // The static path is what shows if the track is later removed — keep it in step.
      updates.shapePath = { points: op(basePoints), closed };
    } else {
      const idx = track.findIndex(
        (k) => Math.abs(number(k.position) - pathLayer.pct) <= Math.max(0.001, pathLayer.keyTolerancePct)
      );
      const current = idx >= 0
        ? (decodeShapePathValue(track[idx].value) || basePoints)
        : (evaluatePathTrack(track, pathLayer.pct) || basePoints);
      updates.propertyKeyframes = {
        ...item.propertyKeyframes,
        // Always Smooth for a newly inserted key, matching every other gesture.
        [SHAPE_PATH_KF_KEY]: writeShapePathKey(
          track, pathLayer.pct, pathLayer.keyTolerancePct, op(current), TransitionEasing.EASE_IN_OUT
        ),
      };
    }
    onTransformItem(item.id, updates, replace);
  }, [pathLayer, pathClosed, onTransformItem]);

  const startPathDrag = (event, mode, index, key = null) => {
    if (!pathActive) return;
    event.preventDefault(); event.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    // Alt on an anchor is the corner/smooth toggle, not the start of a drag.
    if (mode === 'anchor' && event.altKey) {
      selectPoints(index);
      applyPathEdit((pts) => withAutoHandles(toggleShapePathCorner(pts, index), pathClosed), { structural: true });
      return;
    }
    if (mode === 'anchor') {
      const primary = selectedIndices.length ? selectedIndices[0] : -1;
      // Shift/⌘ adds or removes one anchor. No drag follows: the click is the
      // whole gesture, so a mis-aimed nudge can't reshape the path.
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        if (selectedSet.has(index)) {
          const rest = selectedIndices.filter((i) => i !== index);
          selectPoints(rest.length ? rest[0] : -1, rest.slice(1));
        } else if (primary >= 0) {
          // The primary stays put so the panel's coordinate fields don't jump.
          selectPoints(primary, [...selectedIndices.slice(1), index]);
        } else {
          selectPoints(index);
        }
        return;
      }
      // Grabbing a member of a group drags the whole group; grabbing anything
      // else collapses the selection to that one anchor.
      if (multiSelected && selectedSet.has(index)) {
        selectPoints(index, selectedIndices.filter((i) => i !== index));
        startGroupDrag(event, 'move', 0, false, index);
        return;
      }
      selectPoints(index);
    }
    const p = eventPoint(event);
    dragRef.current = {
      mode, index, key, p,
      itemId: pathLayer.item.id,
      origin: pathPoints[index] ? { ...pathPoints[index] } : null,
      // Snapshot for Escape: a path gesture can land in either home, so both go back.
      originalUpdates: {
        shapePath: pathLayer.item.shapePath,
        propertyKeyframes: pathLayer.item.propertyKeyframes,
      },
      changed: false,
    };
  };

  const movePath = (event) => {
    const drag = dragRef.current;
    if (!drag || (drag.mode !== 'anchor' && drag.mode !== 'tangent') || !drag.origin) return;
    const p = eventPoint(event);
    let dx = p.x - drag.p.x;
    let dy = p.y - drag.p.y;
    if (event.shiftKey) {
      // Constrain to the dominant screen axis — measured before the layer's own
      // rotation is undone, so it locks to what the user sees.
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0;
    }
    const delta = frameDeltaToUnit(dx, dy);
    const index = drag.index;
    if (drag.mode === 'anchor') {
      const next = { x: drag.origin.x + delta.x, y: drag.origin.y + delta.y };
      applyPathEdit((pts) => withAutoHandles(
        pts.map((q, i) => (i === index ? { ...q, x: round4(next.x), y: round4(next.y) } : q)),
        pathClosed
      ), { replace: drag.changed });
    } else {
      const base = drag.origin[drag.key] || { x: 0, y: 0 };
      const offset = { x: base.x + delta.x, y: base.y + delta.y };
      // Alt breaks the smooth pair, exactly as in the 3D camera-path editor.
      // No auto-handle refresh here: it would fight the gesture mid-drag.
      applyPathEdit(
        (pts) => setShapePathHandle(pts, index, drag.key, offset, { mirror: !event.altKey }),
        { replace: drag.changed }
      );
    }
    drag.changed = true;
  };

  // ── Multi-selection transform box ──
  // The whole gesture runs in frame coordinates: every selected anchor (and both
  // of its tangent tips) is snapshotted where it is drawn, mapped through one
  // affine, then converted back to the layer's unit box. Carrying the tips along
  // is what keeps a scaled or rotated selection's curvature intact instead of
  // re-smoothing it into a different shape.
  const startGroupDrag = (event, op, handle = 0, fromBox = false, anchorIndex = null) => {
    if (!pathActive || !groupBox) return;
    event.preventDefault(); event.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const tip = (p, key) => (p[key] ? unitToFrame({ x: p.x + p[key].x, y: p.y + p[key].y }) : null);
    dragRef.current = {
      mode: 'group', op, handle, moved: 0,
      // What was grabbed, so end() can tell a still click apart from a drag:
      // only the box's own body counts as "clicked the box", and a click on one
      // of the members collapses to it. A still click on a grip does neither.
      fromBox, anchorIndex,
      p: eventPoint(event),
      box: groupBox,
      itemId: pathLayer.item.id,
      origins: selectedIndices
        .filter((i) => anchorPoints[i])
        .map((i) => ({
          index: i,
          pos: { ...anchorPoints[i] },
          hIn: tip(pathPoints[i], 'hIn'),
          hOut: tip(pathPoints[i], 'hOut'),
        })),
      // Snapshot for Escape: a path gesture can land in either home, so both go back.
      originalUpdates: {
        shapePath: pathLayer.item.shapePath,
        propertyKeyframes: pathLayer.item.propertyKeyframes,
      },
      changed: false,
    };
  };

  const moveGroup = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.mode !== 'group' || !drag.origins?.length) return;
    const p = eventPoint(event);
    drag.moved = Math.max(drag.moved, Math.hypot(p.x - drag.p.x, p.y - drag.p.y));
    const box = drag.box;
    let xf;
    if (drag.op === 'move') {
      let dx = p.x - drag.p.x;
      let dy = p.y - drag.p.y;
      // Constrain to the dominant screen axis, matching the single-anchor drag.
      if (event.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
      xf = (q) => ({ x: q.x + dx, y: q.y + dy });
    } else if (drag.op === 'scale') {
      const h = GROUP_HANDLES[drag.handle] || GROUP_HANDLES[0];
      // Alt scales about the box centre; otherwise the opposite side of the
      // anchors' own bounds is pinned (see `raw` above).
      const ax = event.altKey ? box.cx : box.raw.x0 + (1 - h.hx) * box.raw.w;
      const ay = event.altKey ? box.cy : box.raw.y0 + (1 - h.hy) * box.raw.h;
      // An edge grip pins its own axis, and a start distance of ~0 has no ratio
      // to report — hold that axis rather than blowing the geometry up.
      const ratio = (from, to, pinned) => (pinned || Math.abs(from) < 1e-6 ? 1 : to / from);
      let sx = ratio(drag.p.x - ax, p.x - ax, h.hx === 0.5);
      let sy = ratio(drag.p.y - ay, p.y - ay, h.hy === 0.5);
      if (event.shiftKey && h.hx !== 0.5 && h.hy !== 0.5) {
        const s = Math.max(Math.abs(sx), Math.abs(sy));
        sx = (sx < 0 ? -1 : 1) * s;
        sy = (sy < 0 ? -1 : 1) * s;
      }
      xf = (q) => ({ x: ax + (q.x - ax) * sx, y: ay + (q.y - ay) * sy });
    } else {
      const a0 = Math.atan2(drag.p.y - box.cy, drag.p.x - box.cx);
      const a1 = Math.atan2(p.y - box.cy, p.x - box.cx);
      let deg = (a1 - a0) * 180 / Math.PI;
      if (event.shiftKey) deg = Math.round(deg / 15) * 15;
      const r = deg * Math.PI / 180;
      const cos = Math.cos(r);
      const sin = Math.sin(r);
      xf = (q) => ({
        x: box.cx + (q.x - box.cx) * cos - (q.y - box.cy) * sin,
        y: box.cy + (q.x - box.cx) * sin + (q.y - box.cy) * cos,
      });
    }
    const patches = new Map();
    for (const o of drag.origins) {
      const at = xf(o.pos);
      const pos = frameToUnit(at.x, at.y);
      const patch = { x: round4(pos.x), y: round4(pos.y) };
      for (const key of ['hIn', 'hOut']) {
        if (!o[key]) continue;
        const t = xf(o[key]);
        const u = frameToUnit(t.x, t.y);
        patch[key] = { x: round4(u.x - pos.x), y: round4(u.y - pos.y) };
      }
      patches.set(o.index, patch);
    }
    applyPathEdit((pts) => withAutoHandles(
      // Auto anchors are derived from their neighbours, so withAutoHandles gets
      // the last word — a transformed point must be able to pull an untouched
      // neighbour's tangent with it. Hand-shaped (`manual`) points are skipped
      // there, which is exactly why their tips were carried through `xf` above.
      pts.map((q, i) => (patches.has(i) ? { ...q, ...patches.get(i) } : q)),
      pathClosed
    ), { replace: drag.changed });
    drag.changed = true;
  };

  // Insert an anchor where the pointer landed on the curve. The split is exact, so
  // the outline does not move — the click adds a handle rather than reshaping.
  const insertOnCurve = (event) => {
    if (!pathActive || curveSamples.length < 2) return;
    event.preventDefault(); event.stopPropagation();
    const p = eventPoint(event);
    let best = null;
    for (const s of curveSamples) {
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (!best || d < best.d) best = { d, u: s.u };
    }
    if (!best) return;
    const hitAt = shapePathSegmentAt(pathPoints, pathClosed, best.u);
    applyPathEdit((pts) => insertShapePathPoint(pts, pathClosed, best.u), { structural: true });
    if (hitAt) selectPoints(hitAt.index + 1);
  };

  const deleteSelectedPoint = useCallback(() => {
    if (!pathActive || !selectedIndices.length) return;
    // Below two anchors there is no curve left to edit, so refuse rather than
    // leaving the layer rendering nothing. A group delete is all-or-nothing:
    // silently keeping some of what was selected is worse than doing nothing.
    if (pathPoints.length - selectedIndices.length < 2) return;
    // Descending, so each removal leaves the indices still to come untouched.
    const doomed = [...selectedIndices].sort((a, b) => b - a);
    applyPathEdit((pts) => {
      let out = pts;
      for (const i of doomed) out = deleteShapePathPoint(out, i);
      return withAutoHandles(out, pathClosed);
    }, { structural: true });
    selectPoints(-1);
  }, [pathActive, selectedIndices, pathPoints, pathClosed, applyPathEdit, selectPoints]);

  // While point editing is on, Delete belongs to the path — not to the timeline.
  // The editor-wide shortcut on window would otherwise delete the whole clip out
  // from under the anchor being removed, so this listener runs in the CAPTURE
  // phase (ahead of every bubble-phase shortcut) and swallows the key. Hanging it
  // on window rather than on the SVG's own onKeyDown also means it fires wherever
  // focus happens to be — entering the mode from the panel leaves focus there.
  useEffect(() => {
    if (!pathActive) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Never steal the key from a field the user is typing in.
      if (event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      // Consumed even when it is a no-op (nothing selected, or the path is down to
      // its last two points) — falling through would take the clip with it.
      deleteSelectedPoint();
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pathActive, deleteSelectedPoint]);

  const handleKeyDown = (event) => {
    // Every key belongs to the inline text editor while it is open — the arrow
    // nudge below would move the layer under the caret. The textarea stops its
    // own keys from bubbling; this guard covers focus landing anywhere else.
    if (textEdit) return;
    // Escape leaves region-draw mode outright — half-drawn box or not, the user
    // is asking to get their normal preview back.
    if (event.key === 'Escape' && trackDrawActive) {
      setTrackBand(null);
      onCancelTrackRegionDraw?.();
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape' && dragRef.current) {
      const drag = dragRef.current;
      if (drag.mode === 'marquee') {
        dragRef.current = null;
        setMarquee(null);
        event.preventDefault();
        return;
      }
      if (drag.mode === 'anchor' || drag.mode === 'tangent' || drag.mode === 'group') {
        if (drag.changed) onTransformItem(drag.itemId, drag.originalUpdates, true);
        dragRef.current = null;
        event.preventDefault();
        return;
      }
      if (drag.changed) onTransformItem(drag.selected.item.id, drag.originalUpdates, true);
      end();
      event.preventDefault();
      return;
    }
    if (pathActive) {
      if (event.key === 'Escape') { onExitPathEdit?.(); event.preventDefault(); return; }
      // Select every anchor — the keyboard route to what a marquee does.
      if ((event.metaKey || event.ctrlKey) && (event.key === 'a' || event.key === 'A')) {
        const all = pathPoints.map((_, i) => i);
        selectPoints(all[0], all.slice(1));
        event.preventDefault();
        return;
      }
      // Delete/Backspace are handled by the capture-phase listener above.
      if (selectedIndices.length && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        const step = event.shiftKey ? 10 : 1;
        const delta = frameDeltaToUnit(
          event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
          event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
        );
        applyPathEdit((pts) => withAutoHandles(
          pts.map((q, i) => (selectedSet.has(i) ? { ...q, x: round4(q.x + delta.x), y: round4(q.y + delta.y) } : q)),
          pathClosed
        ));
        event.preventDefault();
      }
      return;
    }
    if (!selected || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const step = event.shiftKey ? 10 : 1;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    onTransformItem(selected.item.id, makeUpdates(selected, { cx: selected.cx + dx, cy: selected.cy + dy }), false);
    event.preventDefault();
  };
  const handleSize = HANDLE_PX * cssUnit;
  const path = selectedGeo ? `${selectedGeo.corners.map((p) => `${p.x},${p.y}`).join(' ')} ${selectedGeo.corners[0].x},${selectedGeo.corners[0].y}` : '';
  const topMid = selectedGeo ? { x: (selectedGeo.corners[0].x + selectedGeo.corners[1].x) / 2, y: (selectedGeo.corners[0].y + selectedGeo.corners[1].y) / 2 } : null;
  const rotateHandle = selected && topMid ? rotatedPoint(topMid.x, topMid.y, 0, -36 * cssUnit, selected.rotation) : null;

  const anchorSize = ANCHOR_PX * cssUnit;
  const tangentRadius = TANGENT_PX * cssUnit;
  const curvePoints = curveSamples.map((s) => `${s.x},${s.y}`).join(' ');
  // Tangent arms are drawn only for a single selected anchor — every handle at
  // once turns a long path into confetti (same call the 3D camera-path editor
  // makes), and with a group box on screen the dots would fight its grips.
  const primaryIndex = selectedIndices.length && !multiSelected ? selectedIndices[0] : -1;
  const selectedAnchor = primaryIndex >= 0 ? pathPoints[primaryIndex] : null;
  const tangentHandles = selectedAnchor
    ? ['hIn', 'hOut']
      // A corner's handles are zero-length, so their dots would sit exactly on the
      // anchor and swallow its own drag. Alt-click (or Reset handles) brings them back.
      .filter((key) => selectedAnchor[key] && Math.hypot(selectedAnchor[key].x, selectedAnchor[key].y) > 1e-4)
      .map((key) => ({
        key,
        anchor: anchorPoints[primaryIndex],
        dot: unitToFrame({
          x: selectedAnchor.x + selectedAnchor[key].x,
          y: selectedAnchor.y + selectedAnchor[key].y,
        }),
      }))
    : [];
  // Grips sit on the padded box; the rotation dot hangs off its top edge, the
  // same offset the layer gizmo uses so the two read as one tool.
  const groupHandleSize = HANDLE_PX * cssUnit;
  const groupRotate = groupBox ? { x: groupBox.cx, y: groupBox.y0 - 34 * cssUnit } : null;

  // The root is pointer-transparent so that dragging the empty area around the
  // frame pans the preview; the frame rect below and the gizmo parts opt back in.
  return <svg ref={rootRef} className="ve-preview-transform-overlay"
    viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
    style={{
      left: `${(-pad / videoWidth) * 100}%`,
      top: `${(-pad / videoHeight) * 100}%`,
      width: `${(vb.w / videoWidth) * 100}%`,
      height: `${(vb.h / videoHeight) * 100}%`,
    }}
    tabIndex="0" aria-label={pathActive ? 'Shape path point editor' : 'Preview layer transform controls'}
    onKeyDown={handleKeyDown}
    onPointerMove={(e) => {
      const mode = dragRef.current?.mode;
      if (mode === 'anchor' || mode === 'tangent') movePath(e);
      else if (mode === 'group') moveGroup(e);
      else if (mode === 'marquee') moveMarquee(e);
      else move(e);
    }}
    onPointerUp={end} onPointerCancel={end}>
    {/* Click target for select/deselect: exactly the frame, so clicks outside it
        fall through to the viewport's pan handling. In path mode it starts a
        marquee instead, which collapses to a deselecting click if it never moves
        — leaving the mode is the panel's / Escape's job. */}
    {/* Region draw owns the whole frame while it is on: a click that lands on
        another layer must not change the selection out from under the box being
        drawn. Rendered BEFORE the ordinary hit rect so it wins the pointer. */}
    {rotoDrawActive && (
      <rect
        className="ve-preview-track-hit is-pen" x="0" y="0" width={videoWidth} height={videoHeight}
        onPointerDown={(event) => {
          event.stopPropagation();
          event.preventDefault();
          const p = eventPoint(event);
          const cur = rotoDraftRef.current;
          // Three points down and a click back on the first one: close.
          if (cur?.points?.length >= 3) {
            const f = cur.points[0];
            if (Math.hypot(f.x - p.x, f.y - p.y) <= ROTO_PEN_CLOSE_PX * cssUnit) { commitRotoDraft(); return; }
          }
          // Smooth is the default; Alt places a CORNER (manual, no tangents).
          const placed = event.altKey
            ? { x: p.x, y: p.y, hIn: { x: 0, y: 0 }, hOut: { x: 0, y: 0 }, manual: true }
            : { x: p.x, y: p.y };
          pushRotoDraftHistory(cur?.points || []);
          const points = [...(cur?.points || []), placed];
          setRotoDraft({ points, cursor: p, sel: points.length - 1 });
          event.currentTarget.setPointerCapture(event.pointerId);
          rotoDraftDragRef.current = { mode: 'pen', index: points.length - 1, origin: p, touchStart: rotoTouchStart(event) };
        }}
        onPointerMove={(event) => {
          const drag = rotoDraftDragRef.current;
          const p = rotoLift(eventPoint(event), drag?.touchStart);
          const d = rotoDraftRef.current;
          if (drag?.mode === 'pen' && d && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            // Dragging out of the click pulls a MIRRORED tangent — the pen
            // contract: a curve costs no second pass, and letting go without
            // moving leaves the auto-smoothed anchor.
            if (Math.hypot(p.x - drag.origin.x, p.y - drag.origin.y) < 3 * cssUnit) return;
            const h = { x: p.x - drag.origin.x, y: p.y - drag.origin.y };
            setRotoDraft({
              ...d,
              cursor: p,
              points: d.points.map((q, i) => (i !== drag.index ? q : {
                x: q.x, y: q.y, hOut: h, hIn: { x: -h.x, y: -h.y }, manual: true,
              })),
            });
            rotoLoupe(event, { kind: 'draft', index: drag.index, key: 'hOut', mode: 'handle' });
            return;
          }
          if (drag) return;
          if (d?.points?.length) setRotoDraft({ ...d, cursor: p });
          rotoHoverLoupe(event, p, !!d?.points?.length);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          }
          rotoDraftDragRef.current = null;
          hidePointLoupe();
          // Straight back to the pen's hover view, after this release commits.
          rotoHoverLoupe(event, eventPoint(event), true);
        }}
        onPointerCancel={() => { rotoDraftDragRef.current = null; hidePointLoupe(); }}
        // Onto a draft anchor is still over the drawing; anywhere else, gone.
        onPointerLeave={(event) => {
          if (!rotoDraftDragRef.current && !event.relatedTarget?.closest?.('.ve-preview-roto-draft')) hidePointLoupe();
        }}
      />
    )}
    {samPick && (() => {
      const layer = layers.find((l) => l.item.id === samPick.itemId);
      if (!layer) return null;
      const r = 7 * cssUnit;
      const box = samBand
        ? { u0: Math.min(samBand.a.u, samBand.b.u), v0: Math.min(samBand.a.v, samBand.b.v), u1: Math.max(samBand.a.u, samBand.b.u), v1: Math.max(samBand.a.v, samBand.b.v) }
        : samPick.box;
      const corners = box
        ? [[box.u0, box.v0], [box.u1, box.v0], [box.u1, box.v1], [box.u0, box.v1]].map(([u, v]) => layerUvToFrame(layer, u, v))
        : null;
      return (
        <g className="ve-preview-sam-marks" pointerEvents="none">
          {corners && (
            <polygon
              className={`ve-preview-sam-box${samBand ? ' is-drawing' : ''}`}
              points={corners.map((q) => `${q.x},${q.y}`).join(' ')}
            />
          )}
          {(samPick.points || []).map((q, i) => {
            const f = layerUvToFrame(layer, q.u, q.v);
            return (
              <g key={i} className={`ve-preview-sam-point${q.label === 0 ? ' is-out' : ''}`}>
                <circle cx={f.x} cy={f.y} r={r} />
                <path d={q.label === 0
                  ? `M${f.x - r * 0.45} ${f.y}H${f.x + r * 0.45}`
                  : `M${f.x - r * 0.45} ${f.y}H${f.x + r * 0.45}M${f.x} ${f.y - r * 0.45}V${f.y + r * 0.45}`} />
              </g>
            );
          })}
        </g>
      );
    })()}
    {samPickActive && (() => {
      const layer = layers.find((l) => l.item.id === samPick.itemId);
      if (!layer) return null;
      const inside = (q) => q.u >= 0 && q.u <= 1 && q.v >= 0 && q.v <= 1;
      const clampUv = (q) => ({ u: clamp01(q.u), v: clamp01(q.v) });
      return (
        <rect
          className="ve-preview-track-hit ve-preview-sam-hit" x="0" y="0" width={videoWidth} height={videoHeight}
          onPointerDown={(event) => {
            event.stopPropagation();
            const p = eventPoint(event);
            const uv = frameToLayerUv(layer, p.x, p.y);
            if (samPick.tool === 'points') {
              // Alt marks what to LEAVE OUT (SAM's background point, label 0).
              if (inside(uv)) onSamPick?.(layer.item.id, { type: 'point', u: uv.u, v: uv.v, label: event.altKey ? 0 : 1 });
              return;
            }
            const a = clampUv(uv);
            setSamBand({ a, b: a });
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!samBand) return;
            const p = eventPoint(event);
            setSamBand((b) => (b ? { ...b, b: clampUv(frameToLayerUv(layer, p.x, p.y)) } : b));
          }}
          onPointerUp={() => {
            const band = samBand;
            setSamBand(null);
            if (!band) return;
            const u0 = Math.min(band.a.u, band.b.u); const u1 = Math.max(band.a.u, band.b.u);
            const v0 = Math.min(band.a.v, band.b.v); const v1 = Math.max(band.a.v, band.b.v);
            // A click rather than a drag is not a box.
            if (u1 - u0 < 0.01 || v1 - v0 < 0.01) return;
            onSamPick?.(layer.item.id, { type: 'box', u0, v0, u1, v1 });
          }}
          onPointerCancel={() => setSamBand(null)}
        />
      );
    })()}
    {trackDrawActive && trackRegionDraw?.purpose !== 'roto' && (
      <rect
        className="ve-preview-track-hit" x="0" y="0" width={videoWidth} height={videoHeight}
        onPointerDown={(event) => {
          event.stopPropagation();
          const p = eventPoint(event);
          setTrackBand({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });   // replaces any held band
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!trackBand) return;
          const p = eventPoint(event);
          setTrackBand((b) => (b ? { ...b, x1: p.x, y1: p.y } : b));
        }}
        onPointerUp={(event) => {
          const band = trackBand;
          if (!band || !trackDrawLayer) { setTrackBand(null); return; }
          const a = frameToLayerUv(trackDrawLayer, Math.min(band.x0, band.x1), Math.min(band.y0, band.y1));
          const b = frameToLayerUv(trackDrawLayer, Math.max(band.x0, band.x1), Math.max(band.y0, band.y1));
          // A click rather than a drag: leave the mode alone rather than tracking
          // a degenerate box the user plainly didn't mean.
          if (Math.abs(b.u - a.u) < 0.004 || Math.abs(b.v - a.v) < 0.004) { setTrackBand(null); return; }
          onTrackRegionDrawn?.(trackDrawLayer.item.id, { u0: a.u, v0: a.v, u1: b.u, v1: b.v }, {
            w: trackDrawLayer.width,
            h: trackDrawLayer.height,
            trackId: trackRegionDraw?.trackId || null,
          });
          // Motion tracking HOLDS the band ("what is being analysed") until the
          // tracked box replaces it. A roto region is just a stored seed — the
          // run starts from the panel later — so a held band would linger
          // forever on the canvas.
          if (trackRegionDraw?.purpose === 'roto') setTrackBand(null);
          void event;
        }}
        onPointerCancel={() => setTrackBand(null)}
      />
    )}
    {cameraPickActive && camBand && (
      <rect
        className="ve-preview-cam-marquee"
        x={Math.min(camBand.x0, camBand.x1)}
        y={Math.min(camBand.y0, camBand.y1)}
        width={Math.abs(camBand.x1 - camBand.x0)}
        height={Math.abs(camBand.y1 - camBand.y0)}
      />
    )}
    {cameraPickActive && (
      <rect
        className="ve-preview-cam-hit" x="0" y="0" width={videoWidth} height={videoHeight}
        onPointerDown={(event) => {
          event.stopPropagation();
          const p = eventPoint(event);
          setCamBand({ x0: p.x, y0: p.y, x1: p.x, y1: p.y, add: event.shiftKey, sub: event.altKey });
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!camBand) return;
          const p = eventPoint(event);
          setCamBand((b) => (b ? { ...b, x1: p.x, y1: p.y } : b));
        }}
        onPointerUp={(event) => {
          const band = camBand;
          setCamBand(null);
          if (!band) return;
          const p = eventPoint(event);
          const mode = band.sub ? 'subtract' : band.add ? 'add' : 'replace';
          const dragged = Math.hypot(p.x - band.x0, p.y - band.y0) > 6 * cssUnit;
          if (dragged) {
            const x0 = Math.min(band.x0, p.x);
            const x1 = Math.max(band.x0, p.x);
            const y0 = Math.min(band.y0, p.y);
            const y1 = Math.max(band.y0, p.y);
            const ids = cameraCloud.points
              .filter((q) => q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1)
              .map((q) => q.id);
            camClickRef.current = null;
            onCameraSelect?.(ids, mode);
            return;
          }
          const hit = cameraHitAt(p.x, p.y);
          if (!hit) {
            camClickRef.current = null;
            if (mode === 'replace') onCameraSelect?.([], 'replace');
            return;
          }
          const now = Date.now();
          const prev = camClickRef.current;
          camClickRef.current = { id: hit.id, t: now };
          if (prev && prev.id === hit.id && now - prev.t < 400) {
            camClickRef.current = null;
            onCameraSelectSurface?.(hit.id, band.add);
            return;
          }
          onCameraSelect?.([hit.id], mode);
        }}
        onPointerCancel={() => setCamBand(null)}
      />
    )}
    {!disabled && !trackDrawActive && !cameraPickActive && !samPickActive && (
      <rect
        className="ve-preview-frame-hit" x="0" y="0" width={videoWidth} height={videoHeight}
        onPointerDown={(event) => {
          if (pathActive) { startMarquee(event); return; }
          // Under dolly/tilt a layer is a perspective quad, so test the raw pointer
          // against forward-projected corners. Without this the whole hit rect used
          // to be removed and nothing in the preview could be selected at all.
          let hit;
          if (camBlocked) {
            const p = eventPointRaw(event);
            hit = [...layers].reverse().find((layer) => {
              const quad = projectedQuad(layer, cameraPose, videoWidth, videoHeight);
              return quad ? pointInQuad(quad, p.x, p.y) : false;
            });
          } else {
            const p = eventPoint(event);
            hit = [...layers].reverse().find((layer) => hitLayer(layer, p.x, p.y));
            // preventDefault, as in start(): the compat mousedown would focus
            // the SVG root and blur the editor the moment it opened.
            if (hit && maybeOpenTextEdit(hit, p)) { event.preventDefault(); return; }
          }
          setPreviewClickId(hit ? hit.item.id : null);
          if (hit) onSelectItem(hit.item.id, hit.channelId); else onSelectItem(null, null);
        }}
      />
    )}
    {/* Under perspective the affine gizmo below is suppressed, so draw the true
        projected outline instead — the selection still needs to be visible, it just
        cannot offer drag handles (that would need an inverse this camera has none of). */}
    {!disabled && camBlocked && selected && (() => {
      const quad = projectedQuad(selected, cameraPose, videoWidth, videoHeight);
      if (!quad) return null;
      return (
        <polyline
          className="ve-preview-selection-box"
          points={[...quad, quad[0]].map((q) => `${q.x},${q.y}`).join(' ')}
        />
      );
    })()}
    {/* Everything below is authored in frame coordinates; this group re-applies the
        project camera so the gizmo sits over the layer as actually rendered. */}
    <g ref={rotoCamGroupRef} transform={cam.svg || undefined}>
      {/* The solved tracking points on this frame, coloured by the surface they
          were grouped into — the same palette the panel's surface list uses. */}
      {cameraCloudPaths && (
        <g className="ve-preview-cam-cloud">
          {cameraCloudPaths.byColor.map(([color, d2]) => (
            <path key={color} d={d2} stroke={color} />
          ))}
          {cameraCloudPaths.sel && <path className="is-sel" d={cameraCloudPaths.sel} stroke="#ffffff" />}
        </g>
      )}
      {/* The analysed path, and where on it the playhead sits. Low-confidence
          stretches are dashed: the tracker interpolates across them, and a solid
          line would present a guess as a measurement. */}
      {motionTrackOverlayMode === 'both' && motionTrackPath?.length > 1 && (() => {
        const runs = [];
        let run = null;
        for (const p of motionTrackPath) {
          const weak = p.conf < 0.35;
          if (!run || run.weak !== weak) {
            const prev = run?.pts[run.pts.length - 1];
            run = { weak, pts: prev ? [prev] : [] };
            runs.push(run);
          }
          run.pts.push(p);
        }
        return (
          <g className="ve-preview-track-path">
            {runs.map((r, i) => (r.pts.length > 1 ? (
              <polyline
                key={i}
                className={r.weak ? 've-track-path-weak' : 've-track-path-line'}
                points={r.pts.map((p) => `${p.x},${p.y}`).join(' ')}
              />
            ) : null))}
          </g>
        );
      })()}
      {/* The tracked region, posed by the track at this frame. Amber + dashed
          when the tracker was unsure there, so a drifting stretch is visible
          without opening the panel. */}
      {motionTrackOverlayMode !== 'off' && motionTrackBox?.corners?.length === 4 && (
        <MotionTrackBox
          box={motionTrackBox}
          atTime={motionTrackBoxAtTime}
          dragHandlers={trackDragHandlers(onMotionTrackPointDrag)}
        />
      )}
      {/* The re-anchor ghost: dragged onto the re-appeared subject, fine-tuned in
          the panel, then Continue analyses forward into the same track. Always
          interactive while it exists — it IS the interaction. */}
      {motionTrackGhost?.corners?.length === 4 && (() => {
        const c = motionTrackGhost.center;
        const arm = 16;
        return (
          <g className="ve-preview-track-ghost">
            <polygon
              points={motionTrackGhost.corners.map((p) => `${p.x},${p.y}`).join(' ')}
              {...trackDragHandlers(onMotionTrackGhostDrag)}
            />
            <path d={`M ${c.x - arm} ${c.y} H ${c.x + arm} M ${c.x} ${c.y - arm} V ${c.y + arm}`} />
          </g>
        );
      })()}
      {motionTrackOverlayMode !== 'off' && trackBand && !motionTrackBox && (
        <rect
          className="ve-preview-track-band"
          x={Math.min(trackBand.x0, trackBand.x1)}
          y={Math.min(trackBand.y0, trackBand.y1)}
          width={Math.abs(trackBand.x1 - trackBand.x0)}
          height={Math.abs(trackBand.y1 - trackBand.y0)}
        />
      )}
      {/* Roto pen draft, live while the region is being placed. Drawn from a
          SMOOTHED copy so the preview curves exactly the way the committed
          outline will; the draft in state stays raw so the `manual` flag never
          gets overwritten by its own preview. */}
      {rotoDrawActive && rotoDraft?.points?.length > 0 && (() => {
        const raw = rotoDraft.points;
        const shown = refreshShapePathHandles(raw.map((q) => ({ ...q })), false);
        const last = shown[shown.length - 1];
        const cursor = rotoDraft.cursor;
        const closable = shown.length >= 3;
        const sel = Number.isInteger(rotoDraft.sel) && rotoDraft.sel < shown.length ? rotoDraft.sel : null;
        const selQ = sel != null ? shown[sel] : null;
        const knobs = selQ && (selQ.hIn?.x || selQ.hIn?.y || selQ.hOut?.x || selQ.hOut?.y) ? {
          hIn: { x: selQ.x + (selQ.hIn?.x || 0), y: selQ.y + (selQ.hIn?.y || 0) },
          hOut: { x: selQ.x + (selQ.hOut?.x || 0), y: selQ.y + (selQ.hOut?.y || 0) },
        } : null;
        const d = [`M ${shown[0].x} ${shown[0].y}`];
        for (let i = 1; i < shown.length; i += 1) {
          const a = shown[i - 1];
          const b = shown[i];
          d.push(`C ${a.x + (a.hOut?.x || 0)} ${a.y + (a.hOut?.y || 0)} ${b.x + (b.hIn?.x || 0)} ${b.y + (b.hIn?.y || 0)} ${b.x} ${b.y}`);
        }
        const dash = `${4 * cssUnit} ${3 * cssUnit}`;
        const knobHandlers = (key) => ({
          onPointerDown: (e) => {
            e.preventDefault(); e.stopPropagation();
            const cur = rotoDraftRef.current;
            if (!cur) return;
            pushRotoDraftHistory(cur.points);
            e.currentTarget.setPointerCapture?.(e.pointerId);
            rotoDraftDragRef.current = { mode: 'draft-knob', index: sel, key, startPoint: selQ, touchStart: rotoTouchStart(e) };
          },
          onPointerMove: (e) => {
            const drag = rotoDraftDragRef.current;
            const cur = rotoDraftRef.current;
            // Hovering a knob is still hovering the drawing.
            if (!drag) { rotoHoverLoupe(e, eventPoint(e), false); return; }
            if (!cur || drag?.mode !== 'draft-knob' || drag.key !== key || !e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
            const p = rotoLift(eventPoint(e), drag.touchStart);
            const q0 = cur.points[drag.index];
            if (!q0) return;
            const h = { x: p.x - q0.x, y: p.y - q0.y };
            const other = key === 'hOut' ? 'hIn' : 'hOut';
            const keep = q0[other] || drag.startPoint[other] || { x: 0, y: 0 };
            setRotoDraft({
              ...cur,
              cursor: null,
              points: cur.points.map((q, i) => (i !== drag.index ? q : {
                x: q.x, y: q.y, manual: true,
                [key]: h,
                [other]: e.altKey ? { ...keep } : { x: -h.x, y: -h.y },
              })),
            });
            rotoLoupe(e, { kind: 'draft', index: drag.index, key, mode: 'handle' });
          },
          onPointerUp: (e) => {
            if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture?.(e.pointerId);
            rotoDraftDragRef.current = null;
            hidePointLoupe();
          },
          onPointerCancel: () => { rotoDraftDragRef.current = null; hidePointLoupe(); },
        });
        return (
          <g className="ve-preview-roto-draft">
            {shown.length > 1 && (
              <path className="ve-preview-roto-draft-path" d={d.join(' ')} />
            )}
            {cursor && !rotoDraftDragRef.current && (
              <line className="ve-preview-roto-draft-lead"
                x1={last.x} y1={last.y} x2={cursor.x} y2={cursor.y} strokeDasharray={dash} />
            )}
            {closable && cursor && !rotoDraftDragRef.current && (
              <line className="ve-preview-roto-draft-lead"
                x1={cursor.x} y1={cursor.y} x2={shown[0].x} y2={shown[0].y} strokeDasharray={dash} />
            )}
            {/* Tangent bars only for anchors the user SHAPED; the selected
                anchor shows its pair as knobs below, auto or not. */}
            {raw.map((q, i) => (i !== sel && q.manual && (q.hOut?.x || q.hOut?.y) ? (
              <line key={`t${i}`} className="ve-preview-roto-draft-tangent"
                x1={q.x + q.hIn.x} y1={q.y + q.hIn.y} x2={q.x + q.hOut.x} y2={q.y + q.hOut.y} />
            ) : null))}
            {knobs && (
              <line className="ve-preview-roto-draft-stem"
                x1={knobs.hIn.x} y1={knobs.hIn.y} x2={knobs.hOut.x} y2={knobs.hOut.y} />
            )}
            {/* Placed anchors stay LIVE mid-draw: click selects (and drags),
                Alt-click toggles a corner, the first anchor — once three are
                down — is the click that closes the outline. */}
            {shown.map((f, i) => (
              <circle key={i}
                data-loupe-anchor={i}
                className={`ve-preview-roto-draft-anchor${i === 0 && closable ? ' is-close' : ''}${i === sel ? ' is-selected' : ''}`}
                cx={f.x} cy={f.y} r={(i === 0 && closable ? 7 : 5.5) * cssUnit}
                onPointerDown={(e) => {
                  e.preventDefault(); e.stopPropagation();
                  const cur = rotoDraftRef.current;
                  if (!cur) return;
                  if (i === 0 && closable) { commitRotoDraft(); return; }
                  const q = cur.points[i];
                  pushRotoDraftHistory(cur.points);
                  if (e.altKey) {
                    const isCorner = q.manual && !(q.hIn?.x || q.hIn?.y || q.hOut?.x || q.hOut?.y);
                    setRotoDraft({
                      ...cur, cursor: null, sel: i,
                      points: cur.points.map((z, k) => (k !== i ? z : (isCorner
                        ? { x: z.x, y: z.y }
                        : { x: z.x, y: z.y, hIn: { x: 0, y: 0 }, hOut: { x: 0, y: 0 }, manual: true }))),
                    });
                    return;
                  }
                  const at = eventPoint(e);
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                  setRotoDraft({ ...cur, cursor: null, sel: i });
                  rotoDraftDragRef.current = { mode: 'draft-anchor', index: i, origin: at, start: { x: q.x, y: q.y }, touchStart: rotoTouchStart(e) };
                }}
                onPointerMove={(e) => {
                  const drag = rotoDraftDragRef.current;
                  const cur = rotoDraftRef.current;
                  // Hovering an anchor is still hovering the drawing.
                  if (!drag) { rotoHoverLoupe(e, eventPoint(e), false); return; }
                  if (!cur || drag?.mode !== 'draft-anchor' || drag.index !== i || !e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
                  const p = rotoLift(eventPoint(e), drag.touchStart);
                  const dx = p.x - drag.origin.x;
                  const dy = p.y - drag.origin.y;
                  setRotoDraft({
                    ...cur,
                    cursor: null,
                    points: cur.points.map((q, k) => (k !== i ? q : { ...q, x: drag.start.x + dx, y: drag.start.y + dy })),
                  });
                  rotoLoupe(e, { kind: 'draft', index: i });
                }}
                onPointerUp={(e) => {
                  if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture?.(e.pointerId);
                  rotoDraftDragRef.current = null;
                  hidePointLoupe();
                }}
                onPointerCancel={() => { rotoDraftDragRef.current = null; hidePointLoupe(); }}
              />
            ))}
            {knobs && ['hIn', 'hOut'].map((key) => (
              <circle key={key} className="ve-preview-roto-draft-knob" data-key={key}
                cx={knobs[key].x} cy={knobs[key].y} r={4.5 * cssUnit}
                {...knobHandlers(key)} />
            ))}
          </g>
        );
      })()}
      {/* RotoScope: the stored subject region (layer uv — pen nodes, a drawn
          polygon or a legacy box), always visible while set — this is the seed
          the tracker will use, so it must be seeable. Crosshair = the
          segmenter seed. In edit mode the anchors drag and the selected one
          shows its tangent knobs. */}
      {(rotoRegion?.nodes || rotoRegion?.pts || rotoRegion?.uv) && !rotoDraft && (() => {
        const layer = layers.find((l) => l.item.id === rotoRegion.itemId);
        if (!layer) return null;
        const nodes = Array.isArray(rotoRegion.nodes) ? smoothRotoNodes(rotoRegion.nodes) : null;
        const editingRegion = !camBlocked && rotoRegionEditItemId === rotoRegion.itemId && !!nodes;
        const uvList = rotoRegion.pts
          ? rotoRegion.pts.map((p) => [p.u ?? p.x, p.v ?? p.y])
          : nodes
            ? nodes.map((q) => [q.u, q.v])
            : [[rotoRegion.uv.u0, rotoRegion.uv.v0], [rotoRegion.uv.u1, rotoRegion.uv.v0],
              [rotoRegion.uv.u1, rotoRegion.uv.v1], [rotoRegion.uv.u0, rotoRegion.uv.v1]];
        const pts = uvList.map(([u, v]) => layerUvToFrame(layer, u, v));
        const cen = pts.reduce((s, p) => ({ x: s.x + p.x / pts.length, y: s.y + p.y / pts.length }), { x: 0, y: 0 });
        const arm = 4 * cssUnit;
        // The outline itself: the cubic path through the nodes when there are
        // nodes (so the region draws as the curve that was drawn, not as its
        // flattened polygon), the polygon otherwise.
        let outline = null;
        let anchors = null;
        if (nodes) {
          const F = nodes.map((q) => layerUvToFrame(layer, q.u, q.v));
          const H = (q, key) => uvDeltaToFrame(layer, q[key]?.u || 0, q[key]?.v || 0);
          const d = [`M ${F[0].x} ${F[0].y}`];
          for (let i = 0; i < nodes.length; i += 1) {
            const a = nodes[i]; const b = nodes[(i + 1) % nodes.length];
            const fa = F[i]; const fb = F[(i + 1) % nodes.length];
            const ho = H(a, 'hOut'); const hi = H(b, 'hIn');
            d.push(`C ${fa.x + ho.x} ${fa.y + ho.y} ${fb.x + hi.x} ${fb.y + hi.y} ${fb.x} ${fb.y}`);
          }
          d.push('Z');
          outline = (
            <path
              className={`ve-preview-roto-region${editingRegion ? ' is-editing' : ''}`}
              d={d.join(' ')}
            />
          );
          const sel = editingRegion && Number.isInteger(rotoRegionSel) && rotoRegionSel < nodes.length ? rotoRegionSel : null;
          const selQ = sel != null ? nodes[sel] : null;
          const knobs = selQ ? {
            hIn: { x: F[sel].x + H(selQ, 'hIn').x, y: F[sel].y + H(selQ, 'hIn').y },
            hOut: { x: F[sel].x + H(selQ, 'hOut').x, y: F[sel].y + H(selQ, 'hOut').y },
          } : null;
          anchors = editingRegion && (
            <>
              {knobs && (
                <line className="ve-preview-roto-region-stem"
                  x1={knobs.hIn.x} y1={knobs.hIn.y} x2={knobs.hOut.x} y2={knobs.hOut.y} />
              )}
              {F.map((p, i) => (
                <circle
                  key={i}
                  data-loupe-anchor={i}
                  className={`ve-preview-roto-region-anchor${i === sel ? ' is-selected' : ''}`}
                  cx={p.x}
                  cy={p.y}
                  r={4.2 * cssUnit}
                  {...rotoRegionAnchorHandlers(layer, i)}
                />
              ))}
              {knobs && ['hIn', 'hOut'].map((key) => (
                <circle key={key} className="ve-preview-roto-region-knob" data-key={key}
                  cx={knobs[key].x} cy={knobs[key].y} r={4 * cssUnit}
                  {...rotoRegionKnobHandlers(layer, sel, key)} />
              ))}
            </>
          );
        } else {
          outline = (
            <polygon
              className="ve-preview-roto-region"
              points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
            />
          );
        }
        return (
          <g className={editingRegion ? 'is-editing-roto-region' : undefined}>
            {outline}
            <path
              className="ve-preview-roto-seed"
              d={`M ${cen.x - arm} ${cen.y} H ${cen.x + arm} M ${cen.x} ${cen.y - arm} V ${cen.y + arm}`}
            />
            {anchors}
          </g>
        );
      })()}
      {/* RotoScope: the traced-outline PREVIEW. Points are unit-box fractions
          of the SOURCE frame; media is contain-fit in the layer plate, so the
          source→layer mapping shrinks the letterboxed axis. */}
      {rotoPreview?.points?.length >= 3 && (() => {
        const layer = layers.find((l) => l.item.id === rotoPreview.itemId);
        if (!layer) return null;
        const mediaAR = (rotoPreview.sourceW || 16) / Math.max(1, rotoPreview.sourceH || 9);
        const boxAR = layer.width / Math.max(1e-6, layer.height);
        let ku = 1, kv = 1;
        if (mediaAR > boxAR + 1e-6) kv = boxAR / mediaAR;       // letterboxed: source v span shrinks
        else if (mediaAR < boxAR - 1e-6) ku = mediaAR / boxAR;  // pillarboxed: source u span shrinks
        const pts = rotoPreview.points.map((p) => rotatedPoint(
          layer.cx, layer.cy,
          p.x * ku * layer.width,
          p.y * kv * layer.height,
          layer.rotation
        ));
        const editable = !!rotoPreview.editable && !camBlocked && !!onRotoPreviewPointsChange;
        const frameToSourcePoint = (event, start = null) => {
          const point = rotoLift(eventPoint(event), start);
          const radians = -layer.rotation * Math.PI / 180;
          const dx = point.x - layer.cx;
          const dy = point.y - layer.cy;
          return {
            x: (dx * Math.cos(radians) - dy * Math.sin(radians))
              / Math.max(1e-6, ku * layer.width),
            y: (dx * Math.sin(radians) + dy * Math.cos(radians))
              / Math.max(1e-6, kv * layer.height),
          };
        };
        const beginCorrectionDrag = (event, kind, index = -1) => {
          if (!editable) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          rotoPreviewDragRef.current = {
            pointerId: event.pointerId,
            kind,
            index,
            touchStart: rotoTouchStart(event),
            start: frameToSourcePoint(event),
            points: rotoPreview.points.map((point) => ({
              ...point,
              ...(point?.hIn ? { hIn: { ...point.hIn } } : {}),
              ...(point?.hOut ? { hOut: { ...point.hOut } } : {}),
            })),
          };
        };
        const moveCorrectionDrag = (event) => {
          const drag = rotoPreviewDragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          event.preventDefault();
          event.stopPropagation();
          const point = frameToSourcePoint(event, drag.touchStart);
          const next = drag.points.map((value) => ({
            ...value,
            ...(value?.hIn ? { hIn: { ...value.hIn } } : {}),
            ...(value?.hOut ? { hOut: { ...value.hOut } } : {}),
          }));
          if (drag.kind === 'anchor') {
            next[drag.index] = { ...next[drag.index], x: point.x, y: point.y };
          } else {
            const dx = point.x - drag.start.x;
            const dy = point.y - drag.start.y;
            next.forEach((value, index) => { next[index] = { ...value, x: value.x + dx, y: value.y + dy }; });
          }
          onRotoPreviewPointsChange(next);
          // The correction outline is the one place a single anchor is nudged
          // against the FOOTAGE to fix a bad trace — exactly what the loupe is
          // for. A whole-path move needs no magnifier.
          if (drag.kind === 'anchor') rotoLoupe(event, { kind: 'correction', index: drag.index });
        };
        const endCorrectionDrag = (event) => {
          if (rotoPreviewDragRef.current?.pointerId !== event.pointerId) return;
          moveCorrectionDrag(event);
          rotoPreviewDragRef.current = null;
          hidePointLoupe();
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        };
        const correctionDragHandlers = editable ? {
          onPointerMove: moveCorrectionDrag,
          onPointerUp: endCorrectionDrag,
          onPointerCancel: endCorrectionDrag,
        } : {};
        return (
          <g className={`ve-preview-roto-outline${rotoPreview.live ? ' live' : ''}${editable ? ' is-correction' : ''}`}>
            <polygon
              points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
              {...(editable ? {
                onPointerDown: (event) => beginCorrectionDrag(event, 'path'),
                ...correctionDragHandlers,
              } : {})}
            />
            {/* Anchor dots, the lab's correspondence read — every 8th slightly
                larger so a scramble is visible at a glance. */}
            {!rotoPreview.live && pts.map((p, i) => (
              <circle
                key={i}
                data-loupe-anchor={i}
                className="ve-preview-roto-anchor"
                cx={p.x} cy={p.y}
                r={(editable ? 4.2 : i % 8 === 0 ? 2.4 : 1.4) * cssUnit}
                {...(editable ? {
                  onPointerDown: (event) => beginCorrectionDrag(event, 'anchor', i),
                  ...correctionDragHandlers,
                } : {})}
              />
            ))}
          </g>
        );
      })()}
      {selected && !textEdit && rotoRegionEditItemId == null && !samPickActive && <>
        {!prsOwnedByParent && (
          <polygon className="ve-preview-selection-hit" points={path} onPointerDown={(e) => start(e, 'move')} />
        )}
        <polyline className="ve-preview-selection-box" points={path} />
        {!prsOwnedByParent && selectedGeo.corners.map((p, i) => <rect key={i} className="ve-preview-transform-handle" x={p.x - handleSize / 2} y={p.y - handleSize / 2} width={handleSize} height={handleSize} rx={2 * cssUnit} onPointerDown={(e) => start(e, 'scale', i)} />)}
        {/* Shapes also get a grip mid-side that resizes one dimension. Withheld
            when the side is too short on screen to keep it clear of the corners. */}
        {!prsOwnedByParent && selected.shapeBase && SHAPE_EDGES.map((edge, i) => {
          const a = selectedGeo.corners[edge.a];
          const b = selectedGeo.corners[edge.b];
          if (Math.hypot(b.x - a.x, b.y - a.y) < handleSize * 3) return null;
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          return (
            <rect key={`edge-${i}`} className="ve-preview-transform-handle" x={mx - handleSize / 2} y={my - handleSize / 2} width={handleSize} height={handleSize} rx={2 * cssUnit}
              style={{ cursor: resizeCursor(mx - selected.cx, my - selected.cy) }}
              onPointerDown={(e) => start(e, 'edge', i)} />
          );
        })}
        {!prsOwnedByParent && rotateHandle && <><line className="ve-preview-rotation-stem" x1={topMid.x} y1={topMid.y} x2={rotateHandle.x} y2={rotateHandle.y} /><circle className="ve-preview-rotation-handle" cx={rotateHandle.x} cy={rotateHandle.y} r={6 * cssUnit} onPointerDown={(e) => start(e, 'rotate')} /></>}
      </>}
      {pathActive && <>
        {/* A fat transparent copy under the visible curve is the click target for
            inserting an anchor — the drawn stroke is far too thin to hit. Both use
            non-scaling-stroke, so their widths are already in screen pixels. */}
        {curveSamples.length > 1 && <>
          <polyline className="ve-path-curve-hit" points={curvePoints} onPointerDown={insertOnCurve} />
          <polyline className="ve-path-curve" points={curvePoints} />
        </>}
        {tangentHandles.map(({ key, anchor, dot }) => (
          <line key={`arm-${key}`} className="ve-path-tangent-arm"
            x1={anchor.x} y1={anchor.y} x2={dot.x} y2={dot.y} />
        ))}
        {/* The multi-selection box, drawn UNDER the anchors so a member of the
            group can still be grabbed individually, while its grips go over them
            (below) so a corner anchor can't steal a resize. */}
        {groupBox && <>
          <rect className="ve-path-group-hit"
            x={groupBox.x0} y={groupBox.y0} width={groupBox.w} height={groupBox.h}
            /* With a modifier the box gets out of the way and lets a marquee
               through — otherwise it would permanently shield the anchors under
               it from an additive sweep. */
            onPointerDown={(e) => (e.shiftKey || e.metaKey || e.ctrlKey
              ? startMarquee(e)
              : startGroupDrag(e, 'move', 0, true))} />
          <rect className="ve-path-group-box"
            x={groupBox.x0} y={groupBox.y0} width={groupBox.w} height={groupBox.h} />
        </>}
        {anchorPoints.map((p, i) => (
          <rect
            key={`anchor-${i}`}
            className={`ve-path-anchor${selectedSet.has(i) ? ' selected' : ''}${selectedIndices[0] === i ? ' primary' : ''}`}
            x={p.x - anchorSize / 2} y={p.y - anchorSize / 2}
            width={anchorSize} height={anchorSize} rx={1.5 * cssUnit}
            onPointerDown={(e) => startPathDrag(e, 'anchor', i)}
          />
        ))}
        {groupBox && <>
          <line className="ve-path-group-rot-stem"
            x1={groupBox.cx} y1={groupBox.y0} x2={groupRotate.x} y2={groupRotate.y} />
          <circle className="ve-path-group-rot" cx={groupRotate.x} cy={groupRotate.y} r={5.5 * cssUnit}
            onPointerDown={(e) => startGroupDrag(e, 'rotate')} />
          {GROUP_HANDLES.map((h, i) => (
            <rect key={`grip-${i}`} className="ve-path-group-handle"
              style={{ cursor: h.cursor }}
              x={groupBox.x0 + h.hx * groupBox.w - groupHandleSize / 2}
              y={groupBox.y0 + h.hy * groupBox.h - groupHandleSize / 2}
              width={groupHandleSize} height={groupHandleSize} rx={2 * cssUnit}
              onPointerDown={(e) => startGroupDrag(e, 'scale', i)} />
          ))}
        </>}
        {tangentHandles.map(({ key, dot }) => (
          <circle key={`tan-${key}`} className="ve-path-tangent" cx={dot.x} cy={dot.y} r={tangentRadius}
            onPointerDown={(e) => startPathDrag(e, 'tangent', primaryIndex, key)} />
        ))}
        {marquee && (
          <rect className="ve-path-marquee"
            x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} />
        )}
      </>}
      {guides.map((g, i) => g.axis === 'x'
        ? <line key={i} className="ve-preview-snap-guide" x1={g.value} x2={g.value} y1="0" y2={videoHeight} />
        : <line key={i} className="ve-preview-snap-guide" x1="0" x2={videoWidth} y1={g.value} y2={g.value} />)}
      {/* ── Inline text editor ──
          A foreignObject inside this camera group, posed with the layer's own
          translate·rotate·scale, so everything is authored in frame pixels and
          rides the project camera and the preview zoom exactly like the gizmo.
          The box is the renderer's WRAP box (its left edge IS textMarginX,
          because the box is centred on the plate) at full plate height, with
          the textarea flex-centred inside — so as lines are added the block
          re-centres vertically exactly the way the canvas layout will place it.
          The Player blanks this layer's plate while this is open
          (inlineTextEdit.js), so the words are never drawn twice. */}
      {textEdit && (() => {
        const layer = layers.find((l) => l.item.id === textEdit.itemId);
        if (!layer) return null;
        const item = layer.item;
        // Text layers' base size is the composition, so the resolved per-axis
        // scale falls straight out of the layer's world box.
        const sx = layer.width / Math.max(videoWidth, 1e-6);
        const sy = layer.height / Math.max(videoHeight, 1e-6);
        if (!Number.isFinite(sx) || !Number.isFinite(sy) || Math.abs(sx) < 1e-4 || Math.abs(sy) < 1e-4) return null;
        const boxW = textWrapBoxWidth(item, videoWidth);
        const fontSize = resolveTextFontSize(item, videoHeight);
        const lineHeight = clampNum(Number(item.textLineHeight) || 1.15, 0.7, 3);
        const letterSpacing = clampNum(Number(item.textLetterSpacing) || 0, -20, 80);
        const textAlign = item.textAlign === 'left' || item.textAlign === 'right' ? item.textAlign : 'center';
        const letterCase = ['lowercase', 'capitalize', 'uppercase'].includes(item.textLetterCase) ? item.textLetterCase : 'none';
        const color = firstColorOf(item.textColor);
        const bg = item.textBgEnabled && typeof item.textBgColor === 'string' && item.textBgColor ? item.textBgColor : 'transparent';
        // Constant-screen-width dashed edge: cssUnit is frame units per screen
        // px OUTSIDE the layer's own scale, so that scale is divided back out
        // (x arbitrarily — a stretched layer gets a slightly uneven dash).
        const outlinePx = (1.5 * cssUnit) / Math.abs(sx);
        return (
          <g transform={`translate(${layer.cx} ${layer.cy}) rotate(${layer.rotation}) scale(${sx} ${sy})`}>
            <foreignObject
              className="ve-inline-text-edit-fo"
              x={-boxW / 2} y={-videoHeight / 2} width={boxW} height={videoHeight}
            >
              <div className="ve-inline-text-edit-wrap">
                <textarea
                  ref={textEditTaRef}
                  className="ve-inline-text-edit"
                  defaultValue={textEdit.initial}
                  placeholder="Type your text"
                  rows={1}
                  wrap={item.textNoWrap ? 'off' : 'soft'}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  style={{
                    fontFamily: (item.textFontFamily || DEFAULT_TEXT_FONT_FAMILY).trim(),
                    fontWeight: clampNum(Number(item.textFontWeight) || 400, 100, 900),
                    fontStyle: item.textFontStyle === 'italic' ? 'italic' : 'normal',
                    fontSize: `${fontSize}px`,
                    lineHeight,
                    letterSpacing: `${letterSpacing}px`,
                    textAlign,
                    textTransform: letterCase,
                    color,
                    caretColor: color,
                    background: bg,
                    outlineWidth: `${outlinePx}px`,
                  }}
                  onInput={(e) => {
                    e.target.style.height = '0px';
                    e.target.style.height = `${e.target.scrollHeight}px`;
                  }}
                  onKeyDown={(e) => {
                    // Every key is the textarea's while it is open: the SVG root
                    // above nudges the layer on arrows, and the window shortcuts
                    // are guarded against textareas but not against bubbling
                    // stopping here being cheaper than trusting all of them.
                    e.stopPropagation();
                    if (e.key === 'Escape') { e.preventDefault(); closeTextEdit(false); }
                    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); closeTextEdit(true); }
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onBlur={() => closeTextEdit(true)}
                />
              </div>
            </foreignObject>
          </g>
        );
      })()}
    </g>
  </svg>;
}
