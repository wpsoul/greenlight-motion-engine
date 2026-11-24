/* Camera: a Camera layer's controls on the page, the app's camera panel (videoEditor/CameraPanel.jsx) in the page's own
   parts: Move (the Camera Motion window), Movement Free · Path · Rig · Zoom with the camera map and Capture keys, Lens.
   The controls are the page's (the inspector's sections, rows and number cells, its gizmo's look over the preview); what
   they do is the app's, bundled:
   - the Camera Motion window and its catalogue (CameraMotionModal.jsx, cameraMotionPresets.js);
   - moving a camera by hand (cameraPathCapture.js: no keys = the camera's own pose changes, on a key = that key, between
     keys = the whole move shifts; Capture = a key at the playhead, on a Path camera a path point at the playhead);
   - the camera map (cameraMoveMap.jsx): the route, points and tangents to drag;
   - the path (projectCamera.js, objectMotionPath.js, SmoothPathPopover.jsx), the rig (cameraRig.js);
   - Zoom (smartZoomCamera.js / smartZoom.js): the zoom ranges, their blocks on the camera layer (ZoomRangeLane.jsx, on the
     page's own timeline) and the preview's framing gestures (ZoomRangeOverlay.jsx);
   - a Path camera's Add point: the app's C key while capturing (a path point at the playhead from the pose there), as a
     control beside Capture keys, its points counted and stepped;
   - the Camera and 3D Scene rows in the app's sand (their place is every page's: rowOrder.js; PlayerPage.jsx, lab.js,
     camera.css).
   What the app's panel does around them (CameraPanel's handlers, VideoEditor's zoom handlers) is followed step by step.
   Every change is a layer value through the page API (setLayerValue), so Save, the .glvideo and a render carry it. */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import CameraMotionModal from '../../components/videoEditor/CameraMotionModal';
import CameraMoveMap from '../../components/videoEditor/cameraMoveMap';
import SmoothPathPopover from '../../components/videoEditor/SmoothPathPopover';
import ZoomRangeLane from '../../components/videoEditor/ZoomRangeLane';
import ZoomRangeOverlay from '../../components/videoEditor/ZoomRangeOverlay';
import { FocusPad } from '../../components/videoEditor/scenePanelMaps';
import { commonToPropertyKeyframes } from '../../components/videoEditor/gsapTransitions';
import { getTimelineLayout } from '../../components/videoEditor/speedUtils';
import { TransitionEasing } from '../../components/videoEditor/types';
import { makePathPointKeyframes } from '../../components/videoEditor/objectMotionPath';
import { sceneTargetOptions } from '../../components/videoEditor/cameraTargets';
import {
  CAMERA_KF_LABELS, CAMERA_NEUTRAL, CAMERA_RIG_PROPS, CAMERA_PATH_DEFAULT, CAMERA_PATH_OFFSETS, presetNeedsFreeCamera,
  sanitizeCameraPresetBase, cameraMoveHash, resolveCameraPose, isCameraChannel,
} from '../../components/videoEditor/projectCamera';
import {
  CAMERA_MOVE_MODES, CAMERA_MOVE_MODE_LABELS, CAMERA_RIG_TYPES, CAMERA_RIG_TYPE_LABELS, CAMERA_RIG_PARAMS, CAMERA_RIG_PARAM_META,
  CAMERA_RIG_DEFAULTS, CAMERA_RIG_PRESETS, CAMERA_RIG_AIMS, CAMERA_RIG_AIM_LABELS, normalizeCameraRig, seedCameraRigProgress, cameraRigPreset,
} from '../../components/videoEditor/cameraRig';
import {
  cameraMoveUpdates, moveWithoutKeys, freeKeyTimes, deleteFreeKey, pathAnchorTimes, deletePathKey, retimeCapturedTrack,
  carryPathRotation,
} from '../../components/videoEditor/cameraPathCapture';
import {
  SMART_ZOOM_MODE, ZOOM_MIN, ZOOM_MAX, addZoomRange, moveZoomRange, patchZoomRange, removeZoomRange, smartZoomEditForItem,
  zoomRangesOf, zoomRangesOnTimeline, zoomSourceAt, zoomZonesFor, zoomZoneFn, zoomZoneRoom,
} from '../../components/videoEditor/smartZoomCamera';
import { PRESETS as SMART_ZOOM_PRESETS, presetById as smartZoomPreset } from '../../components/videoEditor/smartZoom';
import { applyTiming } from '../pageEdits';
import { toEngineProject } from '../normalize';
// the app's own rules for the windows and surfaces above (videoEditor.css, cut by vite.motion-engine.config.js): only a page
// with the camera carries them
import editorCameraCss from 'virtual:editor-modal-css-camera';

// The app's capture grammar (CameraCaptureOverlay.jsx): degrees of tilt for a drag across the frame, the limits, a wheel burst
const ORBIT_DEG = 90, PAN_LIMIT = 200, DOLLY_LIMIT = 3000, WHEEL_BURST_MS = 400, CLICK_SLOP_PX = 3;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round = (v, k = 100) => Math.round(v * k) / k;

const svg = (paths, w = 14, sw = 1.6) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON = {
  camera: svg('<rect x="2.5" y="7" width="13" height="10" rx="2"/><path d="m15.5 12 6-3.4v6.8z"/>'),
  move: svg('<path d="M3 17c5 0 4-10 9-10h7M16 3l4 4-4 4"/>'),
  lens: svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/>'),
  key: (on) => `<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.2 10.8 6 6 10.8 1.2 6Z" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  prev: svg('<path d="m15 6-6 6 6 6"/>', 12, 2),
  next: svg('<path d="m9 6 6 6-6 6"/>', 12, 2),
  trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', 12, 1.8),
  // the app's row glyphs (CameraPanel.jsx FOLLOW_GLYPH, ZOOM_GLYPH, SmoothPathIcon's curve)
  follow: svg('<polygon points="3 11 22 2 13 21 11 13 3 11"/>', 13, 2),
  zoom: svg('<circle cx="11" cy="11" r="7"/><line x1="20.5" y1="20.5" x2="16" y2="16"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>', 13, 2),
  smooth: svg('<path d="M3 17c3-8 6 4 9-4s6-4 9-6"/>', 13, 1.8),
  // a key's diamond with a plus: Add point
  addPoint: svg('<path d="M12 2.8 21.2 12 12 21.2 2.8 12Z"/><path d="M12 8.5v7M8.5 12h7"/>', 12, 1.8),
  // the app's RETICLE_GLYPH (Pick in preview)
  reticle: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/></svg>',
};
// The rig types' pictures, the app's RigTypeGlyph (CameraPanel.jsx) as markup
const RIG_GLYPH = {
  orbit: '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><ellipse cx="12" cy="12" rx="9" ry="4.5"/><circle cx="21" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  dolly: '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><line x1="12" y1="21" x2="12" y2="16"/><polyline points="9.5 18.5 12 21 14.5 18.5"/><line x1="12" y1="8" x2="12" y2="3"/>',
  pushIn: '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><line x1="12" y1="22" x2="12" y2="15.5"/><polyline points="9 18.5 12 15.5 15 18.5"/><path d="M5 20a9 9 0 0 1 14 0"/>',
  truck: '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><line x1="3" y1="19" x2="21" y2="19"/><polyline points="6 16.5 3 19 6 21.5"/><polyline points="18 16.5 21 19 18 21.5"/>',
  crane: '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M4 20a12 12 0 0 0 16-13"/><polyline points="17 8.5 20 6.5 21 10"/>',
  spiral: '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M20 12a8 8 0 1 1-5.2-7.5M17 13a5 5 0 1 1-3.6-4.8"/>',
  handheld: '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M3 15c2-3 3 3 5 0s3 3 5 0 3 3 5 0"/>',
  follow: '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18.5" cy="5.5" r="1.6" fill="currentColor" stroke="none"/><line x1="17.2" y1="6.8" x2="13.4" y2="10.6"/><path d="M4.5 16.5a9.5 9.5 0 0 0 12 1.5"/>',
};
const PAGE_RIG_TYPES = CAMERA_RIG_TYPES;
const RIG_SHORT = { pushIn: 'Push', follow: 'Follow' };
const FRAMING = ['radius', 'height', 'startAngle', 'tilt', 'roll'];
const RIG_MATCH = ['type', ...Object.keys(CAMERA_RIG_PARAM_META)];
const DOF_PROPS = ['camFocusDistance', 'camFStop', 'camAperture', 'camBlurLevel', 'camHighlightGain', 'camFocusWidth', 'camFocusX', 'camFocusY'];
// the movement types as the app's segment names them (CameraPanel.jsx MOVE_MODE_SHORT), in its order (cameraRig.js)
const MODE_SHORT = { free: 'Free', path: 'Path', rig: 'Rig', smartZoom: 'Zoom' };
const LINEAR_TRAVEL = () => [
  { position: 0, value: '0', easing: TransitionEasing.LINEAR },
  { position: 100, value: '100', easing: TransitionEasing.LINEAR },
];

export function install(STUDIO) {
  const $ = (s) => document.querySelector(s);
  // next to the editor windows' own (PlayerPage.jsx), before the studio's: the cascade they had as one sheet
  if (!$('style[data-glm-editor-modals-camera]')) {
    const style = document.createElement('style');
    style.setAttribute('data-glm-editor-modals-camera', '');
    style.textContent = editorCameraCss;
    const windows = $('style[data-glm-editor-modals]');
    if (windows) windows.after(style); else document.head.append(style);
  }
  const api = () => window.GreenLightMotion?.page;

  // ── the camera as the page holds it: its item with the page's changes over it, and the pose where the renderer has it ──
  const rawItem = (id) => { for (const ch of window.GL_LAB_PROJECT?.channels || []) for (const it of ch.items || []) if (it.id === id) return it; return null; };
  const itemOf = (id) => { const it = rawItem(id); return it ? { ...it, ...(api()?.edits().itemEdits[id] || {}) } : null; };
  const frame = () => { const s = window.GL_LAB_PROJECT?.videoSize || { w: 1920, h: 1080 }; return { width: s.w, height: s.h }; };
  const layoutFor = (ch) => getTimelineLayout(ch.items || [], { unsnapped: ch.unsnapped });
  // the film as the page plays it: normalized as the page normalizes it (the editor's own defaults: a layer's speed, its
  // place…), its timing, and every layer's changes over it. The pose, a path's target and a Zoom's plan are read off this.
  let norm = { src: null, project: null };
  function normalized() {
    const src = window.GL_LAB_PROJECT;
    if (norm.src !== src) {
      const mine = { src, project: null }; norm = mine;
      toEngineProject(src).then((p) => { mine.project = p; chCache = {}; }).catch(() => {});
    }
    return norm.project || src;
  }
  let chCache = {};
  function channelsNow() {
    const proj = normalized(), ed = api().edits();
    if (chCache.proj === proj && chCache.items === ed.itemEdits && chCache.timing === ed.timing) return chCache.channels;
    const timed = applyTiming(proj, ed.timing);
    const channels = (timed.channels || []).map((ch) => ({ ...ch, items: (ch.items || []).map((it) => (ed.itemEdits[it.id] ? { ...it, ...ed.itemEdits[it.id] } : it)) }));
    chCache = { proj, items: ed.itemEdits, timing: ed.timing, channels };
    return channels;
  }
  const clipsMap = () => new Map((normalized().clips || []).map((c) => [c.id, c]));
  const layerOf = (id) => api()?.layers().find((l) => l.id === id) || null;
  const selected = () => { const p = api(); const id = p?.ready && p.selected(); const l = id && layerOf(id); return l && l.type === 'camera' ? l : null; };
  const nowT = () => { const st = api().state(); return st.playing ? num(st.playhead, st.currentTime) : st.currentTime; };
  const inside = (l) => { const t = nowT(); return t >= l.start - 1e-6 && t <= l.end + 1e-6; };
  const pctOf = (l) => clamp(((nowT() - l.start) / Math.max(1e-6, l.end - l.start)) * 100, 0, 100);
  const tolerance = (l) => 50 / Math.max((l.end - l.start) * 30, 1);   // half a frame at 30 fps, the app's "key under the playhead"
  // the camera's pose at this point of its clip, as the renderer works it out (a path's target, a Zoom's plan included)
  const poseOf = (l, pct) => {
    const t = clamp(l.start + (pct / 100) * (l.end - l.start), l.start + 1e-4, l.end - 1e-4);
    return resolveCameraPose(channelsNow(), clipsMap(), layoutFor, t, frame()) || { ...CAMERA_NEUTRAL };
  };
  const tracked = (item, prop) => Array.isArray(item?.propertyKeyframes?.[prop]) && item.propertyKeyframes[prop].length > 0;
  const modeOf = (item) => (CAMERA_MOVE_MODES.includes(item?.cameraMoveMode) ? item.cameraMoveMode : 'free');
  const seekPct = (l, pct) => { api().pause(); api().seek(l.start + (pct / 100) * (l.end - l.start)); };

  // writes coalesce to one per frame, as the gizmo's: every setLayerValue re-renders the page
  let queued = null;
  const flush = () => { const q = queued; queued = null; if (q) for (const [k, v] of Object.entries(q.patch)) api().setLayerValue(q.id, k, v === undefined ? null : v); };
  function write(id, patch, now = false) {
    const first = !queued || queued.id !== id;
    if (queued && queued.id !== id) flush();
    queued = { id, patch: { ...(queued?.patch || {}), ...patch } };
    if (now) flush(); else if (first) requestAnimationFrame(flush);
  }
  // one hand-made change of the camera's pose: the app's capture rules (cameraPathCapture.js), from the gesture's snapshot
  const gestureOf = (l) => { const item = itemOf(l.id); return { item, base: { ...CAMERA_NEUTRAL, ...poseOf(l, pctOf(l)) } }; };
  function moveCamera(l, props, gesture, capture = false) {
    const desc = { item: capture ? itemOf(l.id) : gesture.item, pct: pctOf(l), keyTolerancePct: tolerance(l) };
    const updates = cameraMoveUpdates(desc, gesture, { capture, frame: frame() }, props);
    if (updates && Object.keys(updates).length) write(l.id, updates);
  }
  // a typed or dragged field: a pose value moves the camera by the same rules (Capture off); a lens value is the camera's own
  // unless a move animates it (then it is the move's, as in the app, and the field only shows it)
  function setField(l, prop, v) {
    const item = itemOf(l.id);
    if (CAMERA_RIG_PROPS.includes(prop)) {
      const updates = moveWithoutKeys({ item, pct: pctOf(l), keyTolerancePct: tolerance(l), frame: frame() }, { [prop]: v });
      if (Object.keys(updates).length) write(l.id, updates);
    } else if (!tracked(item, prop)) write(l.id, { [prop]: v });
  }
  const valueAt = (l, prop) => num(poseOf(l, pctOf(l))[prop], CAMERA_NEUTRAL[prop]);
  // a rig change: the app's writeRig (a rig needs its Progress track 0 → 100 to move at all)
  function writeRig(l, patch, now = false) {
    const item = itemOf(l.id);
    const seeded = seedCameraRigProgress(item?.propertyKeyframes);
    write(l.id, { cameraRig: { ...normalizeCameraRig(item?.cameraRig), ...patch }, cameraMoveMode: 'rig', ...(seeded ? { propertyKeyframes: seeded } : {}) }, now);
  }
  // CameraPanel setMode: Zoom the first time is VideoEditor's enterZoom, a rig the first time is materialised
  function setMode(l, next) {
    const item = itemOf(l.id);
    if (next === SMART_ZOOM_MODE && !item?.smartZoom) { enterZoom(l); return; }
    if (next === 'rig' && !item?.cameraRig) {
      const seeded = seedCameraRigProgress(item?.propertyKeyframes);
      write(l.id, { cameraMoveMode: 'rig', cameraRig: { ...CAMERA_RIG_DEFAULTS }, ...(seeded ? { propertyKeyframes: seeded } : {}) }, true);
    } else write(l.id, { cameraMoveMode: next }, true);
  }

  // ── the Camera Motion window: the app's own, bundled (CameraPanel handleApplyMotion + VideoEditor applyCameraPreset) ──
  let modalRoot = null, modalBox = null, modalKey = 0;
  const rootIn = (className) => { const box = document.createElement('div'); box.className = className; document.body.append(box); return { box, root: createRoot(box) }; };
  function openMotion(l) {
    api().pause();
    if (!modalBox) ({ box: modalBox, root: modalRoot } = rootIn('mi-cam-modal'));
    const close = () => modalRoot.render(null);
    modalKey += 1;
    modalRoot.render(createElement(CameraMotionModal, {
      key: modalKey, open: true, customPresets: [],
      onApply: ({ preset, keyframes, base }) => { applyMotion(l, preset, keyframes, base); close(); },
      onClose: close,
    }));
  }
  // The move goes over the clip as it is (positions are % of the clip, nothing is resized); a pose move takes a Rig, Path
  // or Zoom camera back to Free, what it had kept, as the app does.
  function applyMotion(l, preset, keyframes, base) {
    const { propertyKeyframes } = commonToPropertyKeyframes(keyframes, CAMERA_KF_LABELS);
    const presetBase = sanitizeCameraPresetBase(base);
    const toFree = presetNeedsFreeCamera(itemOf(l.id), propertyKeyframes, presetBase);
    write(l.id, {
      propertyKeyframes, ...presetBase, ...(toFree ? { cameraMoveMode: 'free' } : {}),
      cameraPreset: preset ? { id: String(preset.id), name: String(preset.name || ''), hash: cameraMoveHash(propertyKeyframes) } : null,
    }, true);
    api().seek(l.start);
  }
  const moveName = (item) => {
    const rec = item?.cameraPreset;
    if (rec?.name) return cameraMoveHash(item.propertyKeyframes) === rec.hash ? rec.name : `${rec.name} · edited`;
    return CAMERA_KF_LABELS.some((p) => tracked(item, p)) ? 'Custom' : 'None';
  };

  // ── Capture keys: every move in the preview keys the camera at the playhead (a Path camera: a path point there) ──
  let capturing = false;
  const keyTimesOf = (item) => (modeOf(item) === 'path' ? pathAnchorTimes(item) : modeOf(item) === 'free' ? freeKeyTimes(item) : []);
  const keyNav = (l, item) => {
    const times = keyTimesOf(item), pct = pctOf(l), tol = tolerance(l), nav = { times, here: -1, prev: -1, next: -1 };
    times.forEach((t, i) => { if (Math.abs(t - pct) <= tol) nav.here = i; else if (t < pct) nav.prev = i; else if (nav.next < 0) nav.next = i; });
    return nav;
  };
  function removeKey(l) {
    const item = itemOf(l.id), k = keyNav(l, item);
    if (k.here < 0) return;
    if (modeOf(item) === 'path') write(l.id, deletePathKey(item, k.here), true);
    else write(l.id, { propertyKeyframes: deleteFreeKey(item, k.times[k.here], tolerance(l)), cameraPreset: null }, true);
  }

  // ── Path (CameraPanel CameraPathControls): the path is the camera item's own, its points move on the map ──
  const pathOf = (item) => item?.cameraPath || null;
  const patchPath = (l, patch, now = true) => write(l.id, { cameraPath: { ...CAMERA_PATH_DEFAULT, ...(pathOf(itemOf(l.id)) || {}), ...patch } }, now);
  // Following with no progress track would park the camera on the first point: the travel is seeded, linear
  function toggleFollow(l) {
    const item = itemOf(l.id), path = pathOf(item), follow = path?.follow !== true;
    if (follow && !tracked(item, 'camPathT')) {
      write(l.id, { cameraPath: { ...CAMERA_PATH_DEFAULT, ...(path || {}), follow: true }, propertyKeyframes: { ...(item.propertyKeyframes || {}), camPathT: LINEAR_TRAVEL() } }, true);
    } else patchPath(l, { follow });
  }
  // One Path Progress key per anchor, replacing the plain 0 → 100 travel (and back again when switched off)
  function togglePointKeyframes(l) {
    const item = itemOf(l.id), path = pathOf(item), points = path?.points || [];
    const enabled = path?.keyframesPerPoint !== true, closed = path?.closed === true;
    write(l.id, {
      cameraPath: { ...CAMERA_PATH_DEFAULT, ...(path || {}), keyframesPerPoint: enabled,
        ...(enabled ? { keyframesPerPointCount: points.length, keyframesPerPointClosed: closed } : { keyframesPerPointCount: undefined, keyframesPerPointClosed: undefined }) },
      propertyKeyframes: { ...(item.propertyKeyframes || {}), camPathT: enabled ? makePathPointKeyframes(points.length, closed, TransitionEasing.LINEAR) : LINEAR_TRAVEL() },
    }, true);
  }
  // CameraPathControls' effect: the per-point track follows the point count (a captured path keeps its times' span)
  function syncPointKeys(l) {
    const item = itemOf(l.id), path = pathOf(item), n = path?.points?.length || 0;
    if (path?.keyframesPerPoint !== true || n < 2) return;
    const closed = path.closed === true, progressTracked = tracked(item, 'camPathT');
    if (path.keyframesPerPointCount === n && path.keyframesPerPointClosed === closed && progressTracked) return;
    write(l.id, {
      cameraPath: { ...CAMERA_PATH_DEFAULT, ...path, keyframesPerPoint: true, keyframesPerPointCount: n, keyframesPerPointClosed: closed },
      propertyKeyframes: { ...(item.propertyKeyframes || {}), camPathT: path.aim === 'captured' && progressTracked
        ? retimeCapturedTrack(item.propertyKeyframes.camPathT, n, closed) : makePathPointKeyframes(n, closed, TransitionEasing.LINEAR) },
    });
  }
  // Smooth path…: the app's popover, its preview written onto the path itself, Cancel puts the points back
  let smooth = null;
  function openSmooth(l, anchor) {
    if (smooth) { smooth.close(); return; }
    const item = itemOf(l.id), path = pathOf(item);
    const { box, root } = rootIn('mi-cam-smooth');
    let snap = null;
    const close = () => { root.unmount(); box.remove(); smooth = null; };
    const onWrite = (nextPoints, _stats, { preview = false } = {}) => {
      if (!snap) snap = (pathOf(itemOf(l.id))?.points || []).map((p) => ({ ...p }));
      const kept = path?.aim === 'captured' ? carryPathRotation(nextPoints, snap) : nextPoints;
      if (!preview) snap = null;
      patchPath(l, { points: kept }, false);
    };
    const onRestore = () => { if (!snap) return; const s = snap; snap = null; patchPath(l, { points: s }, false); };
    smooth = { close };
    root.render(createElement(SmoothPathPopover, {
      anchorRef: { current: anchor }, points: path?.points || [], closed: path?.closed === true, keyed: false, unitLabel: 'px',
      title: 'Smooth camera path', onWrite, onRestore, onClose: () => queueMicrotask(close),
    }));
  }
  // What a camera can aim at, focus on, be built round or zoom to (CameraPanel CameraTargetOptions): a 3D Scene's objects
  // ("@<id>", the app's sceneTargetOptions on the page's film) and the timeline's layers. `kind` 'path' is the path's own list
  // (CameraPathControls: rig channels count, the channel's name); 'follow' the rig's (CameraRigControls: "#n" on a row of several).
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function targetList(kind = 'camera') {
    const channels = channelsNow();
    const scene = sceneTargetOptions(channels);
    const layers = [];
    for (const ch of channels) {
      if (isCameraChannel(ch) || ch.kind === 'audio' || ch.kind === 'voice' || (kind === 'camera' && ch.kind === 'rig')) continue;
      const items = ch.items || [];
      items.forEach((it, i) => {
        const own = typeof it.customName === 'string' && it.customName.trim() ? it.customName.trim() : null;
        layers.push({ value: it.id, label: kind === 'path' ? ch.name : own || (kind === 'follow' && items.length > 1 ? `${ch.name} #${i + 1}` : ch.name) });
      });
    }
    return { scene, layers };
  }
  function targetOptions(current, kind = 'camera') {
    const { scene, layers } = targetList(kind);
    const known = typeof current === 'string' && current && ![...scene, ...layers].some((o) => o.value === current);
    const opt = (o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`;
    if (kind === 'follow') return `${known ? `<option value="${esc(current)}">(missing layer)</option>` : ''}${[...layers, ...scene].map(opt).join('')}`;
    return `${known ? `<option value="${esc(current)}">${esc(current)} (missing)</option>` : ''}${scene.length ? `<optgroup label="3D Scene">${scene.map(opt).join('')}</optgroup>` : ''}${layers.length ? `<optgroup label="Layers">${layers.map(opt).join('')}</optgroup>` : ''}`;
  }

  // ── Focus (the Lens's focus pad and Pick in preview): the page's own renderer answers "how far is what shows at (x, y)",
  //    the editor Player's probe (engine/focusProbe.js, page.probeDepth) ──
  let focusPick = false;
  // the page can tell a depth at a point when its API has the probe (page.probeDepth)
  const canProbe = () => typeof api()?.probeDepth === 'function';
  const probe = (x, y) => { const d = api()?.probeDepth?.(x, y); return Number.isFinite(d) && d > 0 ? d : null; };
  // VideoEditor handleCameraFocusPick: the distance and the point; a keyed track gets a key at the playhead instead
  function focusPicked(l, { distance, xPercent, yPercent }) {
    const item = itemOf(l.id), values = { camFocusDistance: Math.max(1, Math.round(distance)), camFocusX: clamp(xPercent, 0, 100), camFocusY: clamp(yPercent, 0, 100) };
    const patch = {}, tracks = { ...(item.propertyKeyframes || {}) };
    const keyPosition = Math.round(pctOf(l) * 1000) / 1000;
    let wrote = false;
    for (const [prop, value] of Object.entries(values)) {
      const track = tracks[prop];
      if (!Array.isArray(track) || !track.length) { patch[prop] = value; continue; }
      const at = track.findIndex((k) => Math.abs(Number(k.position) - keyPosition) < 0.0005);
      if (at >= 0) tracks[prop] = track.map((k, i) => (i === at ? { ...k, value: String(value) } : k));
      else {
        const prev = [...track].sort((a, b) => Number(a.position) - Number(b.position)).reverse().find((k) => Number(k.position) < keyPosition);
        tracks[prop] = [...track, { position: keyPosition, value: String(value), easing: prev?.easing || TransitionEasing.EASE_IN_OUT }].sort((a, b) => Number(a.position) - Number(b.position));
      }
      wrote = true;
    }
    if (wrote) patch.propertyKeyframes = tracks;
    write(l.id, patch, true);
    focusPick = false;
  }

  // ── Zoom (VideoEditor's zoom model and handlers, smartZoomCamera.js) ──
  // A Zoom camera's ranges (its own, or the automatic ones from its recording's clicks), the edit they play through, where
  // they sit on the timeline, and the picked one ({ itemId, rangeId }).
  let zoomPick = null, zoomAdding = false;
  function zoomModel(id) {
    const item = channelsNow().flatMap((ch) => ch.items || []).find((it) => it.id === id) || itemOf(id);
    if (modeOf(item) !== SMART_ZOOM_MODE || !item.smartZoom) return null;
    const byId = clipsMap();
    const rec = item.smartZoom.clipId ? byId.get(item.smartZoom.clipId) || null : null;
    const { ranges, auto } = zoomRangesOf(item, rec);
    const edit = smartZoomEditForItem(item, channelsNow(), layoutFor);
    const limitMs = rec ? (Number(rec.duration) || 0) * 1000 : (edit[0]?.sourceEndMs || 0);
    const zones = zoomZonesFor(ranges, item.smartZoom.preset);
    const zoneOf = zoomZoneFn(zones, item.smartZoom.preset);
    return { item, rec, ranges, auto, edit, limitMs, zones, zoneOf, blocks: zoomRangesOnTimeline(ranges, edit, zones), preset: smartZoomPreset(item.smartZoom.preset) };
  }
  // the first edit of automatic ranges makes them the project's own
  function writeZoomRanges(id, fn, now = false) {
    const m = zoomModel(id);
    if (!m) return null;
    const next = fn(m.ranges.map((r) => ({ ...r })), m);
    if (!next) return null;
    write(id, { smartZoom: { ...m.item.smartZoom, ranges: next } }, now);
    return next;
  }
  // the playhead goes inside a picked range, past the zoom-in, so the preview shows the zoom being edited
  const seekIntoZoom = (a, b) => { api().pause(); api().seek(a + Math.min(1.4, Math.max(0, b - a) / 2)); };
  function pickZoom(id, rangeId) {
    if (api().selected() !== id) api().select(id);
    zoomPick = rangeId ? { itemId: id, rangeId } : null;
    const b = rangeId ? zoomModel(id)?.blocks.find((x) => x.id === rangeId) : null;
    if (b) seekIntoZoom(b.startSec, b.endSec);
  }
  function addZoomAt(id, timeSec) {
    const m = zoomModel(id);
    const at = m ? zoomSourceAt(m.edit, timeSec) : null;
    if (at === null || at === undefined) return;
    const res = addZoomRange(m.ranges, at, { limitMs: m.limitMs, zoneOf: m.zoneOf });
    if (!res) return;
    write(id, { smartZoom: { ...m.item.smartZoom, ranges: res.ranges } }, true);
    if (api().selected() !== id) api().select(id);
    zoomPick = { itemId: id, rangeId: res.range.id };
    seekIntoZoom(timeSec, timeSec + (res.range.endMs - res.range.startMs) / 1000);
  }
  // a block dragged on the camera layer: both edges = a move (the length is kept), one edge = a resize
  function moveZoomAt(id, rangeId, { startSec, endSec }) {
    writeZoomRanges(id, (ranges, m) => {
      const r = ranges.find((x) => x.id === rangeId);
      if (!r) return null;
      const s = Number.isFinite(startSec) ? zoomSourceAt(m.edit, startSec) : undefined;
      const e = Number.isFinite(endSec) ? zoomSourceAt(m.edit, endSec) : undefined;
      if (s === null || e === null) return null;
      if (Number.isFinite(startSec) && Number.isFinite(endSec)) return moveZoomRange(ranges, rangeId, { startMs: s, endMs: s + (r.endMs - r.startMs) }, { limitMs: m.limitMs, zoneOf: m.zoneOf });
      return moveZoomRange(ranges, rangeId, { startMs: s, endMs: e }, { limitMs: m.limitMs, zoneOf: m.zoneOf });
    });
  }
  function patchZoom(id, rangeId, patch) {
    writeZoomRanges(id, (ranges, m) => {
      // an ease zone may not reach into a neighbour's (nor a release be shorter than the spring needs)
      const room = (Number.isFinite(patch?.leadMs) || Number.isFinite(patch?.releaseMs)) ? zoomZoneRoom(ranges, rangeId, m.zoneOf) : null;
      const p = { ...patch };
      if (room && Number.isFinite(p.leadMs)) p.leadMs = Math.round(Math.min(room.maxLeadMs, Math.max(0, p.leadMs)));
      if (room && Number.isFinite(p.releaseMs)) p.releaseMs = Math.round(Math.min(room.maxReleaseMs, Math.max(room.minReleaseMs, p.releaseMs)));
      return patchZoomRange(ranges, rangeId, p);
    });
  }
  function removeZoom(id, rangeId) {
    writeZoomRanges(id, (ranges) => removeZoomRange(ranges, rangeId), true);
    if (zoomPick?.rangeId === rangeId) zoomPick = null;
  }
  // Zoom the first time: it follows the screen recording on the timeline (one whose clip has the recorder's click track), or,
  // with none, waits for zooms added by hand. Its Motion preset starts as Calm (VideoEditor enterZoom).
  function enterZoom(l) {
    const clips = window.GL_LAB_PROJECT?.clips || [];
    const onTimeline = new Set((window.GL_LAB_PROJECT?.channels || []).flatMap((ch) => (ch.items || []).map((it) => it.clipId)));
    const rec = clips.find((c) => c.mediaType === 'video' && c.recordingMeta && onTimeline.has(c.id)) || null;
    write(l.id, { cameraMoveMode: SMART_ZOOM_MODE, smartZoom: { clipId: rec ? rec.id : null, preset: 'calm' } }, true);
  }
  const pickedZoom = () => {
    const l = selected();
    if (!l || !zoomPick || zoomPick.itemId !== l.id) return null;
    const m = zoomModel(l.id), r = m?.ranges.find((x) => x.id === zoomPick.rangeId);
    return r ? { l, m, r, n: m.ranges.indexOf(r) + 1 } : null;
  };

  // ── the inspector's camera sections (inspector.js calls this for a selected Camera layer) ──
  let mapRoot = null, mapSel = [];
  function signature(layer) {
    const item = itemOf(layer.id), mode = modeOf(item), path = pathOf(item), zp = pickedZoom();
    const dof = item?.camDofEnabled === true || Number(item?.camDofEnabled) >= 0.5 || tracked(item, 'camDofEnabled');
    return [mode, mode === 'rig' ? [normalizeCameraRig(item.cameraRig).type, (normalizeCameraRig(item.cameraRig).targets || []).length] : '', dof, num(item?.camFStop, 0) > 0, canProbe(),
      mode === 'path' ? [Math.min(3, path?.points?.length || 0), path?.follow === true, path?.aim || 'tangent'] : 0,
      mode === SMART_ZOOM_MODE ? [zp ? zp.r.id : null, zp ? zp.r.mode : null, !!item.smartZoom?.clipId, !!zoomModel(layer.id)?.auto, sceneTargetOptions(window.GL_LAB_PROJECT?.channels || []).length > 0] : 0];
  }
  function inspect(layer, kit) {
    const { section, make, button, xrow, axisCell, live } = kit;
    const id = layer.id;
    const l = () => layerOf(id) || layer;
    const item = () => itemOf(id) || {};
    const dot = (title, changed, reset) => {
      const d = make('button', 'mi-dot'); d.type = 'button'; d.title = title; d.setAttribute('aria-label', title);
      d.onclick = () => { if (d.classList.contains('on')) reset(); };
      live(() => d.classList.toggle('on', !!changed()));
      return d;
    };
    const headDot = (body, ...a) => body.parentNode.querySelector('.mi-heading').append(dot(...a));
    // a row of the Transform section's cells; its label carries the reset dot
    const cellRow = (body, label, cells, changed, reset) => {
      const g = xrow(body, label);
      g.previousSibling.firstChild.after(dot(`Reset ${label}`, changed, reset));
      for (const c of cells) {
        axisCell(g, c.chip, c.title, c.get, c.set, c.opts);
        const cell = g.lastChild;
        live(() => { cell.classList.toggle('is-keyed', !!c.keyed?.()); cell.classList.toggle('is-off', !!c.disabled?.()); });
      }
      return g;
    };
    // one number on its own row: label · dot · a cell
    const numRow = (body, label, title, get, set, opts, changed, reset, keyed, disabled) => {
      const r = make('div', 'mi-row mi-cam-num'); body.append(r);
      const lab = make('span', 'mi-label', label); r.append(lab); lab.after(dot(`Reset ${label}`, changed, reset));
      const g = make('div', 'mi-cam-cell'); r.append(g);
      axisCell(g, '', title, get, set, opts);
      const cell = g.lastChild;
      live(() => { cell.classList.toggle('is-keyed', !!keyed?.()); cell.classList.toggle('is-off', !!disabled?.()); });
      return r;
    };
    const seg = (options, get, set, label) => {
      const s = make('div', 'mi-seg'); s.setAttribute('role', 'group'); s.setAttribute('aria-label', label);
      for (const o of options) {
        const b = button(o.label, () => { if (!b.disabled) set(o.value); }, 'mi-seg-btn'); b.dataset.value = String(o.value); b.title = o.title || o.label;
        s.append(b);
      }
      live(() => s.querySelectorAll('button').forEach((b) => {
        const o = options.find((x) => String(x.value) === b.dataset.value), on = b.dataset.value === String(get()), off = !!(typeof o.disabled === 'function' ? o.disabled() : o.disabled);
        b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.disabled = off; b.classList.toggle('is-off', off);
      }));
      return s;
    };
    // a labelled row with a control on the right
    const row = (body, label, control, d) => {
      const r = make('div', 'mi-row'); body.append(r);
      const lab = make('span', 'mi-label', label); r.append(lab);
      if (d) lab.after(d);
      if (control) r.append(control);
      return r;
    };
    const select = (label, html, get, set) => {
      const s = make('select', 'mi-cam-select'); s.setAttribute('aria-label', label); s.innerHTML = html;
      s.onchange = () => set(s.value);
      live(() => { if (document.activeElement !== s) s.value = get(); });
      return s;
    };
    const toggle = (icon, label, title, get, set, disabled) => {
      const b = button('', () => { if (!b.disabled) set(!get()); }, 'mi-mirror-btn mi-cam-toggle');
      live(() => {
        const on = !!get(); b.innerHTML = `${icon}<span>${typeof label === 'function' ? label(on) : label}</span>`;
        b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
        b.disabled = !!disabled?.(); b.title = typeof title === 'function' ? title() : title;
      });
      return b;
    };
    const keyedProp = (p) => () => tracked(item(), p);
    const poseChanged = (props) => () => props.some((p) => tracked(item(), p) || Math.abs(num(item()[p], CAMERA_NEUTRAL[p]) - CAMERA_NEUTRAL[p]) > 1e-6);
    const poseReset = (props) => () => {
      const it = item(), tracks = { ...(it.propertyKeyframes || {}) };
      props.forEach((p) => delete tracks[p]);
      write(id, { ...Object.fromEntries(props.map((p) => [p, CAMERA_NEUTRAL[p]])), propertyKeyframes: tracks, cameraPreset: null }, true);
    };
    const mode = modeOf(item());

    // MOVE: the Camera Motion window (the app's "Move preset" row)
    {
      const body = section('Move', ICON.move);
      headDot(body, 'Remove the move', () => CAMERA_KF_LABELS.some((p) => p !== 'camPathT' && tracked(item(), p)) || item().cameraPreset, () => {
        const tracks = { ...(item().propertyKeyframes || {}) };
        CAMERA_KF_LABELS.forEach((p) => { if (p !== 'camPathT' || modeOf(item()) === 'free') delete tracks[p]; });
        write(id, { propertyKeyframes: tracks, cameraPreset: null }, true);
      });
      const choice = make('div', 'mi-choice'); const name = make('span'); choice.append(name, button('Change', () => openMotion(l()), 'mi-quiet'));
      choice.lastChild.dataset.camAction = 'presets'; choice.lastChild.title = 'Camera Motion presets';
      row(body, 'Preset', choice);
      live(() => { name.textContent = moveName(item()); });
    }

    // MOVEMENT: Free · Path · Rig · Zoom, the map, and the mode's own controls
    {
      const body = section('Movement', ICON.camera);
      headDot(body, 'Reset the movement', () => modeOf(item()) !== 'free' || poseChanged(['camX', 'camY', 'camDolly', 'camTiltX', 'camTiltY', 'camRoll'])(), () => {
        write(id, { cameraMoveMode: 'free', camX: 0, camY: 0, camDolly: 0, camTiltX: 0, camTiltY: 0, camRoll: 0 }, true);
      });
      row(body, 'Type', seg(CAMERA_MOVE_MODES.map((m) => ({ value: m, label: MODE_SHORT[m], title: CAMERA_MOVE_MODE_LABELS[m] })), () => modeOf(item()), (v) => { zoomPick = null; zoomAdding = false; setMode(l(), v); }, 'Movement type'));
      mapBox(body, make, live);
      if (mode === 'free' || mode === 'path') keysRow(body, make, button, live);
      if (mode === 'free') {
        row(body, 'Look at', select('Look at', `<option value="">Nothing (Tilt)</option>${targetOptions(item().cameraLookAt)}`, () => (typeof item().cameraLookAt === 'string' ? item().cameraLookAt : ''), (v) => write(id, { cameraLookAt: v || null }, true)),
          dot('Reset Look at', () => !!item().cameraLookAt, () => write(id, { cameraLookAt: null }, true))).title = 'Turns the camera to keep this in the middle of the frame as it moves (Tilt then follows it)';
        const aims = () => !!item().cameraLookAt;
        cellRow(body, 'Pan · Dolly', [
          { chip: 'X', title: 'Pan X', get: () => valueAt(l(), 'camX'), set: (v) => setField(l(), 'camX', v), opts: { suffix: '%', min: -PAN_LIMIT, max: PAN_LIMIT }, keyed: keyedProp('camX') },
          { chip: 'Y', title: 'Pan Y', get: () => valueAt(l(), 'camY'), set: (v) => setField(l(), 'camY', v), opts: { suffix: '%', min: -PAN_LIMIT, max: PAN_LIMIT }, keyed: keyedProp('camY') },
          { chip: 'Z', title: 'Dolly: the viewpoint in and out', get: () => valueAt(l(), 'camDolly'), set: (v) => setField(l(), 'camDolly', v), opts: { suffix: 'px', min: -DOLLY_LIMIT, max: DOLLY_LIMIT }, keyed: keyedProp('camDolly') },
        ], poseChanged(['camX', 'camY', 'camDolly']), poseReset(['camX', 'camY', 'camDolly']));
        cellRow(body, 'Tilt · Roll', [
          { chip: 'X', title: 'Tilt X', get: () => valueAt(l(), 'camTiltX'), set: (v) => setField(l(), 'camTiltX', v), opts: { suffix: '°' }, keyed: keyedProp('camTiltX'), disabled: aims },
          { chip: 'Y', title: 'Tilt Y', get: () => valueAt(l(), 'camTiltY'), set: (v) => setField(l(), 'camTiltY', v), opts: { suffix: '°' }, keyed: keyedProp('camTiltY'), disabled: aims },
          { chip: 'Z', title: 'Roll', get: () => valueAt(l(), 'camRoll'), set: (v) => setField(l(), 'camRoll', v), opts: { suffix: '°', min: -180, max: 180 }, keyed: keyedProp('camRoll') },
        ], poseChanged(['camTiltX', 'camTiltY', 'camRoll']), poseReset(['camTiltX', 'camTiltY', 'camRoll']));
      } else if (mode === 'path') pathRows(body, { make, button, live, row, seg, select, toggle, numRow, cellRow, dot, l, item });
      else if (mode === 'rig') rigRows(body, { make, button, live, row, select, numRow, dot, l, item });
      else if (mode === SMART_ZOOM_MODE) zoomRows(body, { make, button, live, row, select, toggle, numRow, dot, l, item });
    }

    // LENS: Zoom and depth of field (CameraPanel's lens group): Focus (Pick in preview, Focus on, the focus pad, Point, Distance,
    // Focus area) and Blur (f-number, Aperture, Blur level, Highlight gain)
    {
      const body = section('Lens', ICON.lens);
      numRow(body, 'Zoom', 'Zoom: a lens zoom, framing without parallax', () => valueAt(l(), 'camZoom'), (v) => setField(l(), 'camZoom', v),
        { suffix: '×', min: 0.1, max: 50 }, poseChanged(['camZoom']), poseReset(['camZoom']), keyedProp('camZoom'));
      const it = item(), dofOn = () => item().camDofEnabled === true || Number(item().camDofEnabled) >= 0.5;
      const dofKeyed = tracked(it, 'camDofEnabled');
      row(body, 'Depth of field', seg([{ value: false, label: 'Off', disabled: dofKeyed }, { value: true, label: 'On', disabled: dofKeyed }], () => dofOn(), (v) => write(id, { camDofEnabled: v }, true), 'Depth of field'),
        dot('Reset Depth of field', () => dofOn() || DOF_PROPS.some((p) => item()[p] != null), () => write(id, { camDofEnabled: false, ...Object.fromEntries(DOF_PROPS.map((p) => [p, null])) }, true)));
      if (dofOn() || dofKeyed) {
        const H = frame().height, rest = (H * 0.5) / Math.tan((28 * Math.PI) / 360);
        const lens = (prop, label, title, d, opts) => numRow(body, label, title, () => (prop === 'camFocusDistance' ? (valueAt(l(), prop) > 0 ? valueAt(l(), prop) : rest) : valueAt(l(), prop)),
          (v) => setField(l(), prop, v), opts, () => item()[prop] != null && Math.abs(num(item()[prop], d) - d) > 1e-6, () => write(id, { [prop]: null }, true), keyedProp(prop), keyedProp(prop));
        const keysFocus = () => ['camFocusDistance', 'camFocusX', 'camFocusY'].some((p) => tracked(item(), p));
        // FOCUS: the app's sub-heading with its Pick in preview, when this page can tell a depth at a point of its picture
        const sub = make('div', 'mi-cam-sub mi-cam-subrow'); sub.append(make('span', '', 'Focus')); body.append(sub);
        if (canProbe()) {
          const pick = button('', () => { focusPick = !focusPick; }, 'mi-quiet mi-cam-pick'); pick.dataset.camAction = 'focus-pick';
          sub.append(pick);
          live(() => {
            pick.classList.toggle('on', focusPick); pick.setAttribute('aria-pressed', String(focusPick));
            pick.innerHTML = `${ICON.reticle}<span>${focusPick ? 'Click a layer…' : keysFocus() ? 'Key from preview' : 'Pick in preview'}</span>`;
            pick.title = keysFocus() ? 'Click a layer to set the focus tracks at the playhead' : 'Click a layer in the preview to set its focus point and depth';
          });
        }
        row(body, 'Focus on', select('Focus on', `<option value="">The distance below</option>${targetOptions(item().cameraFocusOn)}`, () => (typeof item().cameraFocusOn === 'string' ? item().cameraFocusOn : ''), (v) => write(id, { cameraFocusOn: v || null }, true)),
          dot('Reset Focus on', () => !!item().cameraFocusOn, () => write(id, { cameraFocusOn: null }, true))).title = 'Keeps this in focus on every frame, wherever it and the camera move (the distance follows it)';
        focusPadBox(body, make, live, l, item);
        cellRow(body, 'Point', ['camFocusX', 'camFocusY'].map((p, i) => ({
          chip: 'XY'[i], title: `Focus point ${'XY'[i]}`, get: () => valueAt(l(), p), set: (v) => setField(l(), p, v), opts: { min: 0, max: 100 }, keyed: keyedProp(p), disabled: keyedProp(p),
        })), () => ['camFocusX', 'camFocusY'].some((p) => !tracked(item(), p) && Math.abs(num(item()[p], 50) - 50) > 1e-6), () => write(id, { camFocusX: 50, camFocusY: 50 }, true));
        lens('camFocusDistance', 'Distance', 'Focus distance', Math.round(rest), { suffix: 'px', min: 1, max: 20000 });
        lens('camFocusWidth', 'Focus area', '0 keeps the focus point a depth probe only. Above 0 it also holds a region of the frame sharp', 0, { suffix: '%', min: 0, max: 200 });
        const blur = make('div', 'mi-cam-sub mi-cam-subrow'); const fnote = make('span', 'mi-cam-meta');
        blur.append(make('span', '', 'Blur'), fnote); body.append(blur);
        live(() => {
          const f = num(item().camFStop, 0) > 0 ? num(item().camFStop, 0) : (num(item().camAperture, 24) > 0 ? Math.max(0.7, 67.2 / num(item().camAperture, 24)) : null);
          fnote.textContent = f ? `≈ f/${f.toFixed(1)}` : 'closed';
        });
        lens('camFStop', 'f-number', 'A lens f-number: the blur follows the focus and the zoom. 0: Aperture sets it', 0, { min: 0, max: 64 });
        if (!(num(it.camFStop, 0) > 0)) lens('camAperture', 'Aperture', 'Aperture', 24, { suffix: 'px', min: 0, max: 300 });
        lens('camBlurLevel', 'Blur level', 'Blur level', 100, { suffix: '%', min: 0, max: 300 });
        lens('camHighlightGain', 'Highlight gain', 'Highlight gain', 0, { suffix: '%', min: 0, max: 300 });
      }
    }
  }

  // the app's focus pad (scenePanelMaps.jsx FocusPad): the point drags, and the distance follows what the picture shows there
  let padRoot = null;
  function focusPadBox(body, make, live, l, item) {
    const box = make('div', 'mi-cam-pad'); body.append(box);
    if (padRoot) { const old = padRoot; queueMicrotask(() => old.unmount()); }
    const root = createRoot(box); padRoot = root;
    let last = '';
    live(() => {
      if (!box.isConnected) return;
      const it = item(), fx = num(it.camFocusX, 50), fy = num(it.camFocusY, 50);
      const keyed = tracked(it, 'camFocusX') || tracked(it, 'camFocusY'), distKeyed = tracked(it, 'camFocusDistance');
      const props = { x: fx, y: fy, width: num(it.camFocusWidth, 0), aperture: num(it.camAperture, 24), blurLevel: num(it.camBlurLevel, 100), disabled: keyed };
      const sig = JSON.stringify(props); if (sig === last) return; last = sig;
      root.render(createElement(FocusPad, { ...props, onMove: (x, y) => {
        // The point is what focus rests on, so the distance follows it. Over empty frame it stays where it was.
        const depth = distKeyed || !canProbe() ? null : probe(x / 100, y / 100);
        write(l().id, { camFocusX: x, camFocusY: y, ...(depth > 0 ? { camFocusDistance: Math.round(depth) } : null) });
      } }));
    });
  }

  // PATH: CameraPathControls without what needs the app's 3D world view (Draw path, Focus layer / Position layer, the selected
  // point's fields, Open 3D view): there, as in the app with that view off, Capture keys builds the path from the preview and
  // the map moves its points and tangents.
  function pathRows(body, k) {
    const { make, button, live, row, seg, select, toggle, numRow, cellRow, dot, l, item } = k;
    const path = () => pathOf(item());
    const count = () => path()?.points?.length || 0;
    const meta = make('span', 'mi-cam-meta');
    const smoothBtn = button('', () => openSmooth(l(), smoothBtn), 'mi-quiet mi-cam-smoothbtn');
    smoothBtn.innerHTML = `${ICON.smooth}<span>Smooth</span>`; smoothBtn.dataset.camAction = 'smooth';
    const head = make('div', 'mi-cam-pair'); head.append(meta, smoothBtn);
    row(body, 'Path', head, dot('Remove the camera path', () => count() > 0, () => write(l().id, { cameraPath: null }, true)));
    live(() => {
      const n = count(); meta.textContent = n ? `${n} point${n === 1 ? '' : 's'}` : 'No path yet';
      smoothBtn.hidden = n < 3; smoothBtn.title = `Smooth the flight path and drop the points it doesn’t need (${n} now)`;
      syncPointKeys(l());
    });
    row(body, 'Travel', toggle(ICON.follow, (on) => (on ? 'Following' : 'Follow path'), () => (count() < 2 ? 'Capture at least two keys first' : 'The path drives the camera, animated by Path Progress'),
      () => path()?.follow === true, () => toggleFollow(l()), () => count() < 2)).lastChild.dataset.camAction = 'follow';
    if (!count()) return;
    const aimOptions = `<option value="tangent">Along the path</option><option value="target">Look at</option><option value="free">Free (keep Tilt / Roll)</option>${(path()?.points || []).some((p) => Number.isFinite(p.rx)) ? '<option value="captured">As captured</option>' : ''}`;
    row(body, 'Aim', select('Aim', aimOptions, () => path()?.aim || 'tangent', (v) => patchPath(l(), { aim: v })));
    if (path()?.aim === 'target') row(body, 'Target', select('Target', `<option value="">Comp centre</option>${targetOptions(path()?.targetId, 'path')}`, () => path()?.targetId || '', (v) => patchPath(l(), { targetId: v || null })));
    const following = () => path()?.follow === true;
    numRow(body, 'Progress', 'How far along the path the camera is (Path Progress)', () => valueAt(l(), 'camPathT'), (v) => write(l().id, { camPathT: v }),
      { suffix: '%', min: 0, max: 100 }, () => false, () => {}, () => tracked(item(), 'camPathT'), () => !following() || tracked(item(), 'camPathT'));
    const offKeyed = (i) => tracked(item(), CAMERA_PATH_OFFSETS[i]);
    cellRow(body, 'Offset', CAMERA_PATH_OFFSETS.map((key, i) => ({
      chip: 'XYZ'[i], title: ['Offset X: right of the path', 'Offset Y: below the path', 'Offset Z: in front of the path'][i],
      get: () => num(item()[key], 0), set: (v) => write(l().id, { [key]: v }), opts: { suffix: 'px', min: -10000, max: 10000 }, keyed: () => offKeyed(i),
      disabled: () => !following() || offKeyed(i),
    })), () => CAMERA_PATH_OFFSETS.some((key, i) => !offKeyed(i) && Math.abs(num(item()[key], 0)) > 1e-6), () => write(l().id, Object.fromEntries(CAMERA_PATH_OFFSETS.map((key) => [key, 0])), true));
    row(body, 'Closed loop', seg([{ value: false, label: 'Off', disabled: () => count() < 3 }, { value: true, label: 'On', disabled: () => count() < 3 }], () => path()?.closed === true, (v) => patchPath(l(), { closed: v }), 'Closed loop'));
    const perPoint = () => path()?.keyframesPerPoint === true;
    row(body, 'Key every point', seg([{ value: false, label: 'Off' }, { value: true, label: 'On', disabled: () => !perPoint() && (!following() || count() < 2) }], perPoint, (v) => { if (v !== perPoint()) togglePointKeyframes(l()); }, 'Key every point'));
  }

  // ZOOM: the panel's Zoom section; the zooms themselves are blocks on the camera layer (Add Zoom on: a click there adds one)
  // and the picked one is framed in the preview (drag, scroll, double-click: ZoomRangeOverlay)
  function zoomRows(body, k) {
    const { make, button, live, row, select, toggle, numRow, dot, l, item } = k;
    const cnt = make('span', 'mi-cam-meta');
    const add = toggle(ICON.zoom, (on) => (on ? 'Adding zooms' : 'Add Zoom'), () => (zoomAdding ? 'Zoom mode is on: a click on the camera layer adds a zoom there' : 'A click on the camera layer adds a zoom where you click'),
      () => zoomAdding, (on) => { zoomAdding = on; });
    add.dataset.camAction = 'zoom-mode';
    const pair = make('div', 'mi-cam-pair'); pair.append(cnt, add);
    row(body, 'Zooms', pair);
    live(() => { const m = zoomModel(l().id); const n = m?.ranges.length || 0; cnt.textContent = `${n ? `${n} zoom${n === 1 ? '' : 's'}` : 'none yet'}${m?.auto ? ' · from your clicks' : ''}`; });
    row(body, 'Feel', select('Feel', SMART_ZOOM_PRESETS.map((p) => `<option value="${p.id}" title="${String(p.hint || '').replace(/"/g, '&quot;')}">${p.name}</option>`).join(''),
      () => smartZoomPreset(item().smartZoom?.preset).id, (v) => write(l().id, { smartZoom: { ...item().smartZoom, preset: v } }, true)));
    const zp = pickedZoom();
    if (zp) {
      const rid = zp.r.id;
      const r = () => zoomModel(l().id)?.ranges.find((x) => x.id === rid) || zp.r;
      const presetZoom = () => smartZoomPreset(item().smartZoom?.preset).camera.zoom;
      const zone = () => { const m = zoomModel(l().id); return m ? m.zoneOf(r()) : { leadMs: 0, releaseMs: 0, settleMs: 0 }; };
      const room = () => { const m = zoomModel(l().id); return m ? zoomZoneRoom(m.ranges, rid, m.zoneOf) : null; };
      const sub = make('div', 'mi-cam-sub'); sub.textContent = `Zoom ${zp.n}`; body.append(sub);
      numRow(body, 'Zoom', 'Scroll or pinch on the preview to zoom, drag it to move', () => (Number(r().zoom) > 0 ? Number(r().zoom) : presetZoom()), (v) => patchZoom(l().id, rid, { zoom: v }),
        { suffix: '×', min: ZOOM_MIN, max: ZOOM_MAX }, () => Number(r().zoom) > 0 && Math.abs(Number(r().zoom) - presetZoom()) > 1e-6, () => patchZoom(l().id, rid, { zoom: presetZoom() })).dataset.zoomField = 'zoom';
      numRow(body, 'Ease in', 'How long before the zoom the camera already sets off', () => zone().leadMs / 1000, (v) => patchZoom(l().id, rid, { leadMs: Math.round(v * 1000) }),
        { suffix: 's', min: 0, max: Math.max(0, (room()?.maxLeadMs ?? 6000) / 1000) }, () => Number.isFinite(r().leadMs), () => patchZoom(l().id, rid, { leadMs: undefined }));
      numRow(body, 'Ease out', 'How long after the zoom the camera takes to come back to rest', () => zone().releaseMs / 1000, (v) => patchZoom(l().id, rid, { releaseMs: Math.round(v * 1000) }),
        { suffix: 's', min: (room()?.minReleaseMs ?? zone().settleMs) / 1000, max: Math.max((room()?.minReleaseMs ?? zone().settleMs) / 1000, (room()?.maxReleaseMs ?? 6000) / 1000) },
        () => Number.isFinite(r().releaseMs), () => patchZoom(l().id, rid, { releaseMs: undefined }));
      if (sceneTargetOptions(window.GL_LAB_PROJECT?.channels || []).length) {
        row(body, 'Zoom to', select('Zoom to', `<option value="">The point in the frame</option>${targetOptions(r().target)}`, () => (typeof r().target === 'string' ? r().target : ''), (v) => patchZoom(l().id, rid, { target: v || undefined })),
          dot('Reset Zoom to', () => !!r().target, () => patchZoom(l().id, rid, { target: undefined })));
      }
      const acts = make('div', 'mi-actions');
      if (zoomModel(l().id)?.rec && r().mode === 'fixed') {
        const back = button('Follow the clicks again', () => patchZoom(l().id, rid, { mode: 'follow', point: undefined }), 'mi-quiet');
        back.title = 'Aim this zoom at the clicks inside it instead of the point you set'; back.dataset.camAction = 'zoom-follow'; acts.append(back);
      }
      const rm = button('', () => removeZoom(l().id, rid), 'mi-quiet mi-cam-rm'); rm.innerHTML = `${ICON.trash}<span>Remove zoom</span>`; rm.dataset.camAction = 'zoom-remove';
      acts.append(rm); body.append(acts);
    }
    const m0 = zoomModel(l().id);
    if (m0?.rec && !m0.auto) {
      const acts = make('div', 'mi-actions');
      const auto = button('Back to automatic zooms', () => { const { ranges: _drop, ...rest } = item().smartZoom || {}; write(l().id, { smartZoom: rest }, true); zoomPick = null; }, 'mi-quiet');
      auto.title = 'Drop your zoom edits and zoom on the recording\'s clicks again'; auto.dataset.camAction = 'zoom-auto'; acts.append(auto);
      body.append(acts);
    }
  }

  // the rig's controls (CameraRigControls): the type tiles, its shots ("Start from"), what Follow Object rides, what the move is
  // built round (Around) and where it looks (Focus point), the numbers the type reads, Progress
  function rigRows(body, k) {
    const { make, button, live, row, select, numRow, dot, l, item } = k;
    const rig = () => normalizeCameraRig(item().cameraRig);
    const tiles = make('div', 'mi-cam-tiles'); body.append(tiles);
    for (const t of PAGE_RIG_TYPES) {
      const b = button('', () => writeRig(l(), { type: t }, true), 'mi-cam-tile'); b.dataset.rigType = t; b.title = CAMERA_RIG_TYPE_LABELS[t];
      b.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${RIG_GLYPH[t]}</svg><span>${RIG_SHORT[t] || CAMERA_RIG_TYPE_LABELS[t]}</span>`;
      tiles.append(b);
      live(() => { const on = rig().type === t; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    }
    // A shot is a SHOT, not project wiring: the follow list and the focus point survive it (the app's Start from)
    row(body, 'Start from', select('Start from', `<option value="">Custom</option>${PAGE_RIG_TYPES.map((t) => { const shots = CAMERA_RIG_PRESETS.filter((p) => p.rig.type === t); return shots.length ? `<optgroup label="${CAMERA_RIG_TYPE_LABELS[t]}">${shots.map((p) => `<option value="${p.id}">${p.name}</option>`).join('')}</optgroup>` : ''; }).join('')}`,
      () => { const cur = rig(); return CAMERA_RIG_PRESETS.find((p) => { const pr = normalizeCameraRig(p.rig); return RIG_MATCH.every((key) => pr[key] === cur[key]); })?.id || ''; },
      (v) => { if (v) { const cur = rig(); writeRig(l(), { ...cameraRigPreset(v), targets: cur.targets, aim: cur.aim }, true); } }));
    const type = rig().type;
    if (type === 'follow') {
      const sub = make('div', 'mi-cam-sub'); sub.textContent = 'Follow'; body.append(sub);
      const targets = rig().targets || [];
      targets.forEach((tid, i) => {
        const del = button('', () => writeRig(l(), { targets: (rig().targets || []).filter((_, j) => j !== i) }, true), 'mi-icon-button mi-cam-del');
        del.innerHTML = ICON.trash; del.title = 'Remove this object from the list'; del.setAttribute('aria-label', 'Remove this object from the list');
        const pair = make('div', 'mi-cam-pair');
        pair.append(select(`Object ${i + 1}`, targetOptions(tid, 'follow'), () => (rig().targets || [])[i] || '', (v) => { const next = [...(rig().targets || [])]; next[i] = v; writeRig(l(), { targets: next }, true); }), del);
        row(body, `Object ${i + 1}`, pair).dataset.followIndex = String(i);
      });
      const { scene, layers } = targetList('follow');
      const options = [...layers, ...scene];
      const add = button('+ Add object to follow', () => { const cur = rig().targets || []; const unused = options.find((o) => !cur.includes(o.value)) || options[0]; if (unused) writeRig(l(), { targets: [...cur, unused.value] }, true); }, 'mi-quiet mi-cam-add');
      add.disabled = !options.length; add.dataset.camAction = 'follow-add';
      const acts = make('div', 'mi-actions'); acts.append(add); body.append(acts);
      if (targets.length) {
        numRow(body, 'Follow object', 'Key it from 1 to 2 to hand the camera from one object to the next', () => valueAt(l(), 'camFollowTarget'), (v) => write(l().id, { camFollowTarget: v }),
          { min: 1, max: Math.max(1, targets.length) }, () => false, () => {}, () => tracked(item(), 'camFollowTarget'), () => tracked(item(), 'camFollowTarget'));
      }
    }
    const fr = make('div', 'mi-cam-sub'); fr.textContent = 'Framing'; body.append(fr);
    if (type !== 'follow') {
      row(body, 'Around', select('Around', `<option value="">Comp centre</option>${targetOptions(typeof rig().center === 'string' ? rig().center : '')}`, () => (typeof rig().center === 'string' ? rig().center : ''), (v) => writeRig(l(), { center: v || null }, true)),
        dot('Reset Around', () => !!rig().center, () => writeRig(l(), { center: null }, true))).title = 'What the move is built round: the comp centre, or a 3D Scene object or a layer it moves with';
    }
    row(body, 'Focus point', select('Focus point', CAMERA_RIG_AIMS.map((a) => `<option value="${a}">${CAMERA_RIG_AIM_LABELS[a]}</option>`).join(''), () => rig().aim, (v) => writeRig(l(), { aim: v }, true)),
      dot('Reset Focus point', () => rig().aim !== CAMERA_RIG_DEFAULTS.aim, () => writeRig(l(), { aim: CAMERA_RIG_DEFAULTS.aim }, true)))
      .title = type === 'follow' ? 'Center keeps the followed object in shot; Path align looks where the camera is travelling' : 'Center keeps the subject in shot; Path align looks where the camera is travelling';
    const active = CAMERA_RIG_PARAMS[type] || [];
    const param = (key) => {
      const meta = CAMERA_RIG_PARAM_META[key];
      numRow(body, meta.label, meta.label, () => rig()[key], (v) => writeRig(l(), { [key]: v }), { suffix: meta.suffix, min: meta.min, max: meta.max },
        () => rig()[key] !== CAMERA_RIG_DEFAULTS[key], () => writeRig(l(), { [key]: CAMERA_RIG_DEFAULTS[key] }, true));
    };
    FRAMING.filter((key) => active.includes(key)).forEach(param);
    const mv = make('div', 'mi-cam-sub'); mv.textContent = `Move · ${CAMERA_RIG_TYPE_LABELS[type]}`; body.append(mv);
    active.filter((key) => !FRAMING.includes(key)).forEach(param);
    numRow(body, 'Progress', 'How far along the move the camera is: the track that carries the move', () => valueAt(l(), 'camPathT'), (v) => write(l().id, { camPathT: v }),
      { suffix: '%', min: 0, max: 100 }, () => false, () => {}, () => tracked(item(), 'camPathT'), () => tracked(item(), 'camPathT'));
  }

  // the camera map: the app's own, a small 3D view of the set with the camera's real route, in every mode
  function mapBox(body, make, live) {
    const box = make('div', 'mi-cam-map'); body.append(box);
    if (mapRoot) { const old = mapRoot; queueMicrotask(() => old.unmount()); }
    const root = createRoot(box); mapRoot = root;
    let last = '';
    live(() => {
      const l = selected(); if (!l || !box.isConnected) return;
      const item = itemOf(l.id), mode = modeOf(item), st = api().state();
      const pct = st.playing || !inside(l) ? null : pctOf(l);
      const keyTimes = keyTimesOf(item);
      const rig = normalizeCameraRig(item.cameraRig);
      const zoomPose = mode === SMART_ZOOM_MODE ? poseOf(l, pct ?? 0) : null;
      const hud = mode === 'rig' ? `${Math.round(rig.radius)} px` : mode === SMART_ZOOM_MODE ? `${num(zoomPose?.camZoom, 1).toFixed(2)}×`
        : keyTimes.length ? `${keyTimes.length} key${keyTimes.length === 1 ? '' : 's'}` : mode === 'path' ? 'No path yet' : `Dolly ${Math.round(num(item.camDolly, 0))} px`;
      const sig = JSON.stringify([item, pct, mapSel, capturing, hud, zoomPose]);
      if (sig === last) return; last = sig;
      root.render(createElement(CameraMoveMap, {
        item, frame: frame(), playheadPct: pct, pose: zoomPose, keyTimes, keyTolerancePct: tolerance(l), capture: capturing,
        cameraMovable: pct != null && (mode === 'free' || (mode === 'path' && capturing)), selection: mapSel, onSelection: (s) => { mapSel = s; last = ''; },
        onWrite: (patch) => write(l.id, patch), onSeek: (p) => seekPct(l, p),
        onRigPatch: mode === 'rig' ? (patch) => writeRig(l, patch) : null, hud,
      }));
    });
  }
  // Capture keys, and the keys it made: ‹ › to step between them, the bin for the one under the playhead. A Path camera has
  // Add point first: the app's C key while capturing (CameraCaptureOverlay.jsx: the pose at the playhead keyed, here a path
  // point there, cameraPathCapture.js capturePathKey) as a control, outside the app's 3D view, where its Draw path lives. It
  // turns Capture on, so the next drag in the preview (or on the map) places the new point. Its points: "2 of 3" and ‹ ›.
  function keysRow(body, make, button, live) {
    const pathMode = modeOf(itemOf(selected()?.id)) === 'path';
    const r = make('div', 'mi-row mi-cam-keys'); body.append(r);
    let add = null;
    if (pathMode) {
      add = button('', () => addPathPoint(selected()), 'mi-mirror-btn mi-cam-capture mi-cam-addpoint'); add.dataset.camAction = 'add-point';
      add.innerHTML = `${ICON.addPoint}<span>Add point</span>`;
      r.append(add);
    }
    const cap = button('', () => { capturing = !capturing; hint(); }, 'mi-mirror-btn mi-cam-capture'); cap.dataset.camAction = 'capture';
    r.append(cap);
    const nav = make('div', 'mi-cam-nav');
    const count = make('span', 'mi-cam-count');
    const word = pathMode ? 'point' : 'key';
    const prev = button('', () => { const l = selected(); const k = keyNav(l, itemOf(l.id)); if (k.prev >= 0) seekPct(l, k.times[k.prev]); }, 'mi-icon-button'); prev.innerHTML = ICON.prev; prev.title = `Previous ${word}`; prev.setAttribute('aria-label', `Previous ${word}`);
    const next = button('', () => { const l = selected(); const k = keyNav(l, itemOf(l.id)); if (k.next >= 0) seekPct(l, k.times[k.next]); }, 'mi-icon-button'); next.innerHTML = ICON.next; next.title = `Next ${word}`; next.setAttribute('aria-label', `Next ${word}`);
    const del = button('', () => removeKey(selected()), 'mi-icon-button mi-cam-del'); del.innerHTML = ICON.trash; del.title = `Delete this ${word}`; del.setAttribute('aria-label', `Delete this ${word}`); del.dataset.camAction = 'delete-key';
    nav.append(count, prev, next, del);
    // a path's points on a row of their own, under Add point; a Free camera's keys beside Capture keys
    let navRow = r;
    if (pathMode) { navRow = make('div', 'mi-row mi-cam-keys mi-cam-points'); navRow.append(make('span', 'mi-label', 'Points')); body.append(navRow); }
    navRow.append(nav);
    live(() => {
      const l = selected(); if (!l) return;
      const path = modeOf(itemOf(l.id)) === 'path';
      cap.innerHTML = `${ICON.key(capturing)}<span>${capturing ? 'Capturing' : 'Capture keys'}</span>`;
      cap.classList.toggle('on', capturing); cap.setAttribute('aria-pressed', String(capturing));
      cap.title = capturing ? 'Stop adding keys' : path ? 'Every move in the preview sets the path key at the playhead' : 'Every move in the preview keys the camera at the playhead';
      const k = keyNav(l, itemOf(l.id));
      if (add) {
        const why = pointBlock(l, k);
        add.disabled = !!why; add.title = why || 'A path point at the playhead, from the camera\'s pose now (C). Drag the preview to place it';
      }
      if (navRow !== r) navRow.hidden = !k.times.length;
      nav.hidden = !k.times.length;
      const n = k.times.length;
      count.textContent = path
        ? (k.here >= 0 ? `${k.here + 1} of ${n}` : `${n} point${n === 1 ? '' : 's'}`)
        : (k.here >= 0 ? `${k.here + 1} / ${n}` : `${n} key${n === 1 ? '' : 's'}`);
      prev.disabled = k.prev < 0; next.disabled = k.next < 0; del.hidden = k.here < 0;
    });
  }
  // why Add point can't add one now (no answer: it can)
  function pointBlock(l, k = keyNav(l, itemOf(l.id))) {
    if (api().state().playing) return 'Pause playback to add a point';
    if (!inside(l)) return 'Move the playhead over this camera clip';
    if (k.here >= 0) return 'A point is at the playhead: drag the preview to move it';
    return '';
  }
  function addPathPoint(l) {
    if (!l || pointBlock(l)) return;
    capturing = true;
    const g = gestureOf(l);
    moveCamera(l, Object.fromEntries(CAMERA_RIG_PROPS.map((p) => [p, num(g.base[p], CAMERA_NEUTRAL[p])])), g, true);
    hint();
  }

  // ── the preview: drag the picture to move the camera, the app's capture grammar ──
  // left-drag orbits (Tilt X / Y), Shift- or right-drag pans (Pan X / Y), the wheel dollies. A press that does not move
  // is a click: it picks the layer under it, as the preview does. Drawn in the gizmo's look: viewfinder corners and a
  // centre mark; with Capture on, the app's capture ring. A Free camera moves; a Path camera with Capture on sets path keys.
  // A Zoom camera's picked zoom is framed by the app's own surface (ZoomRangeOverlay).
  let pickBox = null, surface = null, zoomBox = null, zoomRoot = null, drag = null, wheel = null, raf = 0, hintEl = null, hintTimer = 0, hintMsg = '';
  const frameEl = () => $('.glm-frame');
  // a film with a Camera layer (top level: the page's layers). Without one, nothing of the camera is on the page.
  const hasCamera = () => (window.GL_LAB_PROJECT?.channels || []).some((ch) => ch.kind === 'camera' && (ch.items || []).length);
  // the gesture names sit above the frame, never on the picture (the app keeps them above the viewport): a page that can
  // move the camera in the picture leaves a band for them over the preview. Set before the page first paints, so the
  // frame never shifts when the camera is picked.
  const band = () => document.body.classList.toggle('mi-cam-band', hasCamera());
  band();
  const editMode = () => document.body.classList.contains('rv-mode-edit') && !document.body.classList.contains('original') && !window.LabEdit?.rebuilding();
  function armed() {
    const p = api(), l = selected();
    if (!(l && p.ready && frameEl() && editMode() && !p.state().playing && inside(l))) return false;
    const mode = modeOf(itemOf(l.id));
    return mode === 'free' || (mode === 'path' && capturing);
  }
  // the picked zoom, framed while the playhead is inside it and playback is paused (Player.jsx zoomArmed)
  function zoomEditNow() {
    const zp = pickedZoom(); if (!zp || !editMode()) return null;
    const spans = zp.m.blocks.filter((b) => b.id === zp.r.id).map((b) => [b.startSec, b.endSec]);
    const t = nowT(), insideZoom = spans.some(([a, b]) => t >= a - 1e-3 && t <= b + 1e-3);
    return { edit: { itemId: zp.l.id, rangeId: zp.r.id, n: zp.n, range: zp.r, presetZoom: zp.m.preset.camera.zoom, spans, canFollow: !!zp.m.rec },
      armed: insideZoom && !api().state().playing, l: zp.l };
  }
  function placeOver(el, f) {
    const w = f.offsetWidth, h = f.offsetHeight;
    if (el.parentNode !== f.parentNode) f.parentNode.append(el);
    if (el.style.transform !== f.style.transform || el.style.width !== `${w}px`) Object.assign(el.style, { width: `${w}px`, height: `${h}px`, transform: f.style.transform });
  }
  let zoomSig = '';
  function paint() {
    raf = requestAnimationFrame(paint);
    band();
    const f = frameEl(); if (!f) return;
    if (!hasCamera()) {
      if (surface) { surface.remove(); surface = null; }
      if (zoomBox) { zoomRoot.unmount(); zoomBox.remove(); zoomBox = null; zoomRoot = null; zoomSig = ''; }
      if (hintEl) { hintEl.remove(); hintEl = null; hintMsg = ''; }
      if (pickBox) { pickBox.remove(); pickBox = null; }
      return;
    }
    if (!surface) {
      surface = document.createElement('div'); surface.className = 'mi-cam-surface'; surface.setAttribute('aria-hidden', 'true');
      surface.innerHTML = '<svg class="mi-cam-sight"></svg>';
      surface.addEventListener('pointerdown', down); surface.addEventListener('pointermove', moveDrag); surface.addEventListener('pointerup', up); surface.addEventListener('pointercancel', up);
      surface.addEventListener('contextmenu', (e) => e.preventDefault());
      surface.addEventListener('wheel', onWheel, { passive: false });
    }
    placeOver(surface, f);
    const w = f.offsetWidth, h = f.offsetHeight, on = armed();
    surface.classList.toggle('is-armed', on); surface.classList.toggle('is-capture', on && capturing); surface.classList.toggle('is-drag', !!drag?.moved);
    const sight = surface.firstChild, key = `${w}x${h}|${on}|${on && capturing}|${(f.getBoundingClientRect().width / Math.max(1, w)).toFixed(4)}`;
    if (sight.dataset.key !== key) {
      sight.dataset.key = key; sight.setAttribute('viewBox', `0 0 ${w} ${h}`);
      const u = w / Math.max(1, f.getBoundingClientRect().width), m = 26 * u, c = 34 * u, r = 13 * u, t = 7 * u;
      const corner = (x, y, sx, sy) => `M${x} ${y + sy * c}V${y}H${x + sx * c}`;
      const d = [corner(m, m, 1, 1), corner(w - m, m, -1, 1), corner(w - m, h - m, -1, -1), corner(m, h - m, 1, -1)].join('');
      sight.innerHTML = on ? `<path class="mi-cam-sh" d="${d}"/><path class="mi-cam-ln" d="${d}"/><g class="mi-cam-mid"><circle cx="${w / 2}" cy="${h / 2}" r="${r}" class="mi-cam-sh"/><circle cx="${w / 2}" cy="${h / 2}" r="${r}" class="mi-cam-ln"/><path class="mi-cam-ln" d="M${w / 2 - r - t} ${h / 2}h${t}M${w / 2 + r} ${h / 2}h${t}M${w / 2} ${h / 2 - r - t}v${t}M${w / 2} ${h / 2 + r}v${t}"/></g>${capturing ? `<rect class="mi-cam-ring" x="1" y="1" width="${w - 2}" height="${h - 2}"/>` : ''}` : '';
    }
    // the picked zoom's framing surface: the app's ZoomRangeOverlay over the frame
    const ze = zoomEditNow();
    if (!zoomBox) { zoomBox = document.createElement('div'); zoomBox.className = 'mi-cam-zoombox'; zoomRoot = createRoot(zoomBox); }
    placeOver(zoomBox, f);
    zoomBox.classList.toggle('is-armed', !!ze?.armed);
    const zs = ze?.armed ? JSON.stringify([ze.edit.itemId, ze.edit.rangeId, ze.edit.range, ze.edit.spans]) : '';
    if (zs !== zoomSig) {
      zoomSig = zs;
      zoomRoot.render(ze?.armed ? createElement(ZoomRangeOverlay, {
        edit: ze.edit, pose: poseOf(ze.l, pctOf(ze.l)), armed: true, onPatch: (itemId, rangeId, patch) => patchZoom(itemId, rangeId, patch),
      }) : null);
    }
    hint(on, ze);
    // Pick in preview: a click on the picture sets the focus where it lands (Player.jsx's focus capture surface)
    const pickOn = focusPick && !!selected() && editMode() && !api().state().playing;
    if (focusPick && !selected()) focusPick = false;
    if (!pickBox) {
      pickBox = document.createElement('div'); pickBox.className = 'mi-cam-pickbox'; pickBox.setAttribute('aria-hidden', 'true');
      pickBox.addEventListener('pointerdown', (e) => {
        const l = selected(); if (!focusPick || !l || e.button !== 0) return;
        const r = pickBox.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return;
        const x = clamp((e.clientX - r.left) / r.width, 0, 1), y = clamp((e.clientY - r.top) / r.height, 0, 1);
        const distance = probe(x, y);
        if (distance === null) return;
        e.preventDefault(); e.stopPropagation();
        focusPicked(l, { distance, xPercent: x * 100, yPercent: y * 100 });
      });
    }
    placeOver(pickBox, f);
    pickBox.classList.toggle('is-on', pickOn);
  }
  // the gesture names, above the picture for three seconds after the camera (or a zoom) is armed: the app's capture hint and
  // its zoom badge, in labels
  function hint(on = armed(), ze = zoomEditNow()) {
    const view = $('.glm-view'); if (!view) return;
    if (!hintEl || !hintEl.isConnected) { hintEl = document.createElement('div'); hintEl.className = 'mi-cam-hint'; hintEl.setAttribute('role', 'status'); view.append(hintEl); hintMsg = ''; }
    const path = on && modeOf(itemOf(selected()?.id)) === 'path';
    const msg = ze?.armed ? `zoom:${ze.edit.n}:${ze.edit.canFollow}` : !on ? '' : capturing ? (path ? 'path' : 'capture') : 'move';
    if (msg === hintMsg) return;
    hintMsg = msg; clearTimeout(hintTimer);
    if (!msg) { hintEl.classList.remove('is-on'); return; }
    hintEl.dataset.msg = msg.split(':')[0];
    hintEl.innerHTML = msg.startsWith('zoom')
      ? `<span><b>Zoom ${ze.edit.n}</b></span><span><b>Drag</b> move</span><span><b>Scroll</b> zoom</span><span><b>Double-click</b> ${ze.edit.canFollow ? 'follow clicks' : 'centre'}</span>`
      : `<span><b>Drag</b> orbit</span><span><b>Shift drag</b> pan</span><span><b>Scroll</b> dolly</span>${msg !== 'move' ? `<span><b>C</b> ${msg === 'path' ? 'path key' : 'key'}</span><span><b>D</b> rest</span>` : ''}`;
    hintEl.classList.add('is-on');
    hintTimer = setTimeout(() => hintEl?.classList.remove('is-on'), 3000);
  }
  function down(e) {
    if (!armed() || (e.button !== 0 && e.button !== 1 && e.button !== 2)) return;
    e.preventDefault(); e.stopPropagation();
    const l = selected();
    drag = { id: e.pointerId, l, mode: e.button !== 0 || e.shiftKey ? 'pan' : 'orbit', button: e.button, x: e.clientX, y: e.clientY, gesture: gestureOf(l), moved: false };
    surface.setPointerCapture?.(e.pointerId);
  }
  function moveDrag(e) {
    const d = drag; if (!d || d.id !== e.pointerId) return;
    const rect = surface.getBoundingClientRect(); if (rect.width <= 0) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < CLICK_SLOP_PX) return;
    d.moved = true;
    const b = d.gesture.base;
    const props = d.mode === 'pan'
      ? { camX: clamp(b.camX - (dx / rect.width) * 100, -PAN_LIMIT, PAN_LIMIT), camY: clamp(b.camY - (dy / rect.height) * 100, -PAN_LIMIT, PAN_LIMIT) }
      : { camTiltY: b.camTiltY - (dx / rect.width) * ORBIT_DEG, camTiltX: b.camTiltX - (dy / rect.height) * ORBIT_DEG };
    for (const k of Object.keys(props)) props[k] = round(props[k], 1000);
    moveCamera(d.l, props, d.gesture, capturing);
  }
  function up(e) {
    const d = drag; if (!d || (e && d.id !== e.pointerId)) return;
    drag = null;
    try { surface.releasePointerCapture?.(d.id); } catch { /* gone */ }
    // a plain click (Capture off): the layer under it, as a click on the preview picks it
    if (e?.type !== 'pointerup' || d.moved || d.button !== 0 || capturing) return;
    const f = frameEl(), r = f.getBoundingClientRect();
    const x = ((e.clientX - r.left) / Math.max(1e-6, r.width)) * f.offsetWidth, y = ((e.clientY - r.top) / Math.max(1e-6, r.height)) * f.offsetHeight;
    api().select(api().pickAt(x, y) || null);
  }
  function onWheel(e) {
    if (!armed()) return;
    e.preventDefault(); e.stopPropagation();
    const l = selected();
    if (!wheel || wheel.l.id !== l.id) wheel = { l, gesture: gestureOf(l), delta: 0, timer: 0 };
    clearTimeout(wheel.timer);
    wheel.timer = setTimeout(() => { wheel = null; }, WHEEL_BURST_MS);
    // dolly in frame px, scaled to the project's height; a pinch arrives an order of magnitude smaller than a notch
    const pinch = e.ctrlKey || e.metaKey ? 5 : 1;
    wheel.delta += -e.deltaY * pinch * (frame().height / 1080);
    moveCamera(l, { camDolly: round(clamp(wheel.gesture.base.camDolly + wheel.delta, -DOLLY_LIMIT, DOLLY_LIMIT), 100) }, wheel.gesture, capturing);
  }
  // C keys the current pose, D the camera at rest, at the playhead (Capture on), as in the app
  window.addEventListener('keydown', (e) => {
    if ((e.code !== 'KeyC' && e.code !== 'KeyD') || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (!capturing || !armed()) return;
    e.preventDefault();
    const l = selected(), g = gestureOf(l);
    const props = Object.fromEntries(CAMERA_RIG_PROPS.map((p) => [p, e.code === 'KeyC' ? num(g.base[p], CAMERA_NEUTRAL[p]) : CAMERA_NEUTRAL[p]]));
    moveCamera(l, props, g, true);
  });

  // ── Zoom on the page's own timeline: the app's ZoomRangeLane on each Zoom camera clip's bar ──
  const lanes = new Map();   // camera item id → { box, root, bar, sig }
  function laneTick() {
    const p = api();
    if (!p?.ready) return;
    const want = new Set();
    for (const l of p.layers().filter((x) => x.type === 'camera')) {
      const m = zoomModel(l.id);
      if (!m) continue;
      const bar = document.querySelector(`.glm-layer[data-layer="${CSS.escape(l.id)}"]`);
      if (!bar) continue;
      want.add(l.id);
      let lane = lanes.get(l.id);
      if (!lane || lane.bar !== bar || !lane.box.isConnected) {
        if (lane) { const old = lane.root; queueMicrotask(() => old.unmount()); lane.box.remove(); }
        const box = document.createElement('div'); box.className = 'mi-cam-lane';
        bar.append(box);
        lane = { box, root: createRoot(box), bar, sig: '' };
        lanes.set(l.id, lane);
      }
      const sel = p.selected() === l.id;
      const pps = bar.getBoundingClientRect().width / Math.max(1e-6, l.end - l.start);
      const sig = JSON.stringify([m.blocks, m.ranges, m.auto, sel && zoomPick?.itemId === l.id ? zoomPick.rangeId : null, sel && zoomAdding, Math.round(pps * 100), l.start]);
      if (sig === lane.sig) continue;
      lane.sig = sig;
      lane.root.render(createElement(ZoomRangeLane, {
        itemId: l.id, clipStartSec: l.start, pps,
        model: { blocks: m.blocks, auto: m.auto, edit: m.edit, ranges: m.ranges, presetZoom: m.preset.camera.zoom, newZone: m.zoneOf({ id: '__new__' }) },
        selectedId: sel && zoomPick?.itemId === l.id ? zoomPick.rangeId : null,
        adding: sel && zoomAdding,
        onAdd: (itemId, timeSec) => addZoomAt(itemId, timeSec),
        onMove: (itemId, rangeId, patch) => moveZoomAt(itemId, rangeId, patch),
        onSelect: (itemId, rangeId) => pickZoom(itemId, rangeId),
        onRemove: (itemId, rangeId) => removeZoom(itemId, rangeId),
        onHoverChange: () => {},
      }));
    }
    for (const [id, lane] of lanes) if (!want.has(id)) { const old = lane.root; queueMicrotask(() => old.unmount()); lane.box.remove(); lanes.delete(id); }
    // Add Zoom belongs to the panel: it drops the moment that camera isn't the one in Zoom being shown
    const s = selected();
    if (zoomAdding && !(s && modeOf(itemOf(s.id)) === SMART_ZOOM_MODE)) zoomAdding = false;
  }

  const start = () => {
    if (!api()?.ready || !frameEl()) { setTimeout(start, 100); return; }
    cancelAnimationFrame(raf); paint();
    setInterval(laneTick, 120);
  };
  start();
  window.addEventListener('rv:remount', () => { surface?.remove(); surface = null; pickBox?.remove(); pickBox = null; if (zoomBox) { zoomRoot.unmount(); zoomBox.remove(); zoomBox = null; zoomRoot = null; zoomSig = ''; } });

  STUDIO.camera = { inspect, signature };
}
