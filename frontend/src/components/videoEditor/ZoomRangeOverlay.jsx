import { useEffect, useRef } from 'react';
import { ZOOM_MAX, ZOOM_MIN } from './smartZoomCamera';

/*
 * Zoom mode in the preview: with a zoom range picked on the camera layer, the preview is its framing surface.
 * Drag moves the zoomed view (the picture follows the pointer); scroll or pinch zooms, about the pointer.
 * Double-click gives the range back to the clicks (or, with no recording, centres it). Each gesture makes the range a
 * fixed point at its own zoom (smartZoomCamera.js: { mode: 'fixed', point, zoom }), so the view lands exactly there.
 *
 * Same surface rules as Capture Camera (CameraCaptureOverlay): native non-passive wheel, values re-derived from a
 * snapshot taken at gesture start, one undo entry per drag or wheel burst.
 */
const WHEEL_BURST_MS = 400;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fit = (c, z) => clamp(c, 0.5 / z, 1 - 0.5 / z); // a view that stays inside the frame

/** The strip above the preview (Capture Camera's), saying what the gestures do or why they wait. */
export function ZoomEditHint({ edit, inside, playing }) {
  return (
    <div className="ve-cam-capture-bar ve-zoom-edit-bar" role="status">
      <div className="ve-cam-capture-hint">
        {playing
          ? `Pause playback to frame zoom ${edit.n}`
          : !inside
            ? `Move the playhead into zoom ${edit.n} to frame it`
            : `Zoom ${edit.n} · Drag to move · Scroll or pinch to zoom · Double-click ${edit.canFollow ? 'to follow the clicks again' : 'to centre it'}`}
      </div>
    </div>
  );
}

export default function ZoomRangeOverlay({
  edit, // VideoEditor's zoomEdit: { itemId, rangeId, n, range, presetZoom, spans, canFollow }
  pose = null, // the evaluated camera at the playhead (camZoom / camX / camY)
  armed = false,
  onPatch,
}) {
  const rootRef = useRef(null);
  const editRef = useRef(edit); editRef.current = edit;
  const poseRef = useRef(pose); poseRef.current = pose;
  const armedRef = useRef(armed); armedRef.current = armed;
  const patchRef = useRef(onPatch); patchRef.current = onPatch;
  const dragRef = useRef(null);
  const wheelRef = useRef(null);

  // Where the range frames now: its own point and zoom, or (still following the clicks) what the preview shows.
  const baseline = () => {
    const e = editRef.current;
    const r = e?.range;
    const zSet = Number(r?.zoom) > 0 ? Number(r.zoom) : e?.presetZoom || 1.45;
    if (r?.mode === 'fixed' && r.point) return { x: r.point.x, y: r.point.y, z: zSet };
    const p = poseRef.current;
    const z = Number(p?.camZoom) > 1.01 ? Number(p.camZoom) : zSet;
    const x = Number(p?.camZoom) > 1.01 ? 0.5 + Number(p.camX || 0) / (100 * z) : 0.5;
    const y = Number(p?.camZoom) > 1.01 ? 0.5 + Number(p.camY || 0) / (100 * z) : 0.5;
    return { x, y, z };
  };
  const write = (v, replace) => {
    const e = editRef.current;
    if (!e) return;
    const z = Math.round(clamp(v.z, ZOOM_MIN, ZOOM_MAX) * 1000) / 1000;
    patchRef.current?.(e.itemId, e.rangeId, {
      mode: 'fixed',
      zoom: z,
      point: { x: Math.round(fit(v.x, z) * 1e4) / 1e4, y: Math.round(fit(v.y, z) * 1e4) / 1e4 },
    }, replace);
  };

  const onPointerDown = (event) => {
    if (!armedRef.current || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, base: baseline(), dirty: false };
    rootRef.current?.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event) => {
    const d = dragRef.current;
    if (!d || d.id !== event.pointerId) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const dx = (event.clientX - d.x) / rect.width;
    const dy = (event.clientY - d.y) / rect.height;
    if (!dx && !dy) return;
    // The picture follows the pointer: the view centre moves the other way, by the drag over the zoom.
    write({ x: d.base.x - dx / d.base.z, y: d.base.y - dy / d.base.z, z: d.base.z }, d.dirty);
    d.dirty = true;
  };
  const endDrag = (event) => {
    const d = dragRef.current;
    if (!d || (event && d.id !== event.pointerId)) return;
    dragRef.current = null;
    try { rootRef.current?.releasePointerCapture?.(d.id); } catch { /* gone */ }
  };
  const onDoubleClick = (event) => {
    const e = editRef.current;
    if (!armedRef.current || !e) return;
    event.preventDefault();
    if (e.canFollow) patchRef.current?.(e.itemId, e.rangeId, { mode: 'follow', point: undefined });
    else write({ x: 0.5, y: 0.5, z: baseline().z }, false);
  };

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return undefined;
    const onWheel = (event) => {
      if (!armedRef.current || !editRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = node.getBoundingClientRect();
      let burst = wheelRef.current;
      if (!burst) {
        burst = { cur: baseline(), dirty: false, timer: 0 };
        wheelRef.current = burst;
      }
      clearTimeout(burst.timer);
      burst.timer = setTimeout(() => { wheelRef.current = null; }, WHEEL_BURST_MS);
      // Pinch arrives as ctrl+wheel with small deltas; a mouse wheel in notches of ~100.
      const k = event.ctrlKey || event.metaKey ? 0.012 : 0.0018;
      const z0 = burst.cur.z;
      const z1 = clamp(z0 * Math.exp(-event.deltaY * k), ZOOM_MIN, ZOOM_MAX);
      // Zoom about the pointer: the picture point under it stays under it.
      const px = rect.width > 0 ? (event.clientX - rect.left) / rect.width - 0.5 : 0;
      const py = rect.height > 0 ? (event.clientY - rect.top) / rect.height - 0.5 : 0;
      const ux = burst.cur.x + px / z0;
      const uy = burst.cur.y + py / z0;
      burst.cur = { x: fit(ux - px / z1, z1), y: fit(uy - py / z1, z1), z: z1 };
      write(burst.cur, burst.dirty);
      burst.dirty = true;
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      node.removeEventListener('wheel', onWheel);
      if (wheelRef.current) clearTimeout(wheelRef.current.timer);
      wheelRef.current = null;
    };
    // Reads refs only, so the listener never re-attaches.
  }, []);

  return (
    <div
      ref={rootRef}
      className={`ve-cam-capture-overlay ve-zoom-edit-overlay${armed ? ' armed' : ''}`}
      data-zoom-edit={edit?.rangeId || ''}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
    />
  );
}
