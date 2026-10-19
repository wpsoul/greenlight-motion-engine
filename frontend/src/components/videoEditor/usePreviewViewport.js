import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppPref } from '../../hooks/appPrefs';
import {
  ZOOM_SPEED_PREF,
  ZOOM_SPEED_DEFAULT,
  clampZoomFactor,
  createWheelGestureClassifier,
  pinchFactor,
  wheelNotchFactor,
} from '../../utils/zoomRate';

// Zoom/pan for the video-editor preview, modelled on the board canvas gesture
// stack (hooks/useCanvas.js): rAF-coalesced wheel, ctrl-key/pinch zoom at the
// cursor, trackpad two-finger pan, Safari gesture events. It is display-only —
// the transform lives on a wrapper div, never on the canvas backing store, so
// nothing here can change a render.
export const MIN_PREVIEW_SCALE = 0.1;
export const MAX_PREVIEW_SCALE = 8;
export const IDENTITY_VIEW = { scale: 1, x: 0, y: 0 };

const clampScale = (scale) => Math.min(Math.max(scale, MIN_PREVIEW_SCALE), MAX_PREVIEW_SCALE);

// The stage is flex-centred and transformed about its own centre, so a frame
// point p lands at screen offset (from the viewport centre) s·p + x. Holding an
// anchor a fixed across a scale change therefore gives x' = a - (a - x)·(s'/s).
// Anchors are always measured from the viewport centre, not its top-left.
function zoomAbout(view, factor, ax = 0, ay = 0) {
  const scale = clampScale(view.scale * factor);
  const ratio = scale / view.scale;
  if (ratio === 1) return view;
  return { scale, x: ax - (ax - view.x) * ratio, y: ay - (ay - view.y) * ratio };
}

// A left-drag pans only where it can't mean anything else: the empty area around
// the frame. Over the frame itself it stays a select/deselect click (and during
// playback, where the gizmo's hit target is absent, it must still do nothing).
// Middle-drag and Alt+drag pan from anywhere, After Effects style.
function isPanStart(event) {
  if (event.button === 1) return true;
  if (event.button !== 0) return false;
  if (event.altKey) return true;
  const target = event.target;
  if (!target?.closest) return true;
  // ⚠️ This is an ALLOW-LIST, and it is silent: an editing overlay missing from
  // it still mounts and still draws, but every pointerdown on it is swallowed as
  // a pan start (preventDefault + setPointerCapture on the viewport), so the
  // gizmo simply drags the canvas instead. Any new on-canvas editor belongs here.
  return !target.closest('.ve-preview-transform-overlay')
    && !target.closest('.ve-object-motion-path-overlay')
    && !target.closest('.ve-af-points-overlay')
    && !target.closest('.ve-rig-pin-overlay')
    && !target.closest('.ve-mask-overlay')
    && !target.closest('.ve-distort-overlay')
    && !target.closest('.ve-force-emitter-overlay')
    && !target.closest('.ve-cc-compare-line')
    && !target.closest('.ve-player-frame');
}

/**
 * `disabled` suspends the gestures without detaching anything — the 3D world view
 * needs the wheel for its orbit dolly and left-drag for orbiting, and two zoom
 * models fighting over one surface is the confusing outcome to avoid. The
 * listeners stay bound so nothing remounts on the way in or out.
 */
export function usePreviewViewport(disabled = false) {
  const [view, setView] = useState(IDENTITY_VIEW);
  const viewRef = useRef(view);
  viewRef.current = view;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  // Callback ref so listeners attach even when the node arrives after a
  // conditional render (same reason useCanvas does it this way).
  const [node, setNode] = useState(null);
  const viewportRef = useCallback((next) => setNode(next), []);

  const rectRef = useRef(null);
  const pendingRef = useRef(null);
  const rafRef = useRef(0);
  const panRef = useRef(null);

  // "Zoom speed" in App settings; kept in a ref so the wheel listener never
  // re-attaches on a preference change.
  const zoomSpeed = useAppPref(ZOOM_SPEED_PREF, ZOOM_SPEED_DEFAULT);
  const zoomSpeedRef = useRef(zoomSpeed);
  zoomSpeedRef.current = zoomSpeed;

  const flushWheel = useCallback(() => {
    rafRef.current = 0;
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    setView((prev) => {
      let next = prev;
      // Rate-limit the batch — a stalled frame collects many more wheel events
      // than a healthy one. See utils/zoomRate.js.
      if (pending.zoomFactor !== 1) {
        next = zoomAbout(
          prev,
          clampZoomFactor(pending.zoomFactor, zoomSpeedRef.current),
          pending.anchorX,
          pending.anchorY,
        );
      }
      if (pending.panDx !== 0 || pending.panDy !== 0) {
        next = { ...next, x: next.x + pending.panDx, y: next.y + pending.panDy };
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!node) return undefined;

    const updateRect = () => { rectRef.current = node.getBoundingClientRect(); };
    updateRect();
    const observer = new ResizeObserver(updateRect);
    const classifyWheelGesture = createWheelGestureClassifier();
    observer.observe(node);
    window.addEventListener('resize', updateRect);

    // Anchor relative to the viewport CENTRE — see zoomAbout.
    const anchorOf = (event) => {
      const rect = rectRef.current;
      if (!rect) return { ax: 0, ay: 0 };
      return {
        ax: event.clientX - rect.left - rect.width / 2,
        ay: event.clientY - rect.top - rect.height / 2,
      };
    };

    const onWheel = (event) => {
      // Let the wheel through to whatever owns the surface instead (OrbitControls).
      if (disabledRef.current) return;
      event.preventDefault();
      const { ax, ay } = anchorOf(event);
      if (!pendingRef.current) {
        pendingRef.current = { panDx: 0, panDy: 0, zoomFactor: 1, anchorX: ax, anchorY: ay };
      }
      const pending = pendingRef.current;
      if (event.ctrlKey || event.metaKey) {
        // Trackpad pinch (browsers synthesise ctrlKey) and Cmd/Ctrl + wheel.
        pending.zoomFactor *= pinchFactor(event.deltaY, zoomSpeedRef.current);
        pending.anchorX = ax; pending.anchorY = ay;
      } else if (classifyWheelGesture(event) === 'zoom') {
        // Physical mouse wheel. Keep one mode through the gesture so trackpad
        // momentum cannot be mistaken for a wheel when its delta grows.
        pending.zoomFactor *= wheelNotchFactor(event.deltaY, zoomSpeedRef.current);
        pending.anchorX = ax; pending.anchorY = ay;
      } else {
        pending.panDx -= event.deltaX;
        pending.panDy -= event.deltaY;
      }
      if (rafRef.current === 0) rafRef.current = requestAnimationFrame(flushWheel);
    };

    // Safari pinch doesn't arrive as ctrlKey wheel events.
    let lastGestureScale = 1;
    const onGestureStart = (event) => { event.preventDefault(); lastGestureScale = 1; };
    const onGestureChange = (event) => {
      if (disabledRef.current) return;
      event.preventDefault();
      const factor = event.scale / lastGestureScale;
      lastGestureScale = event.scale;
      const { ax, ay } = anchorOf(event);
      setView((prev) => zoomAbout(prev, factor, ax, ay));
    };
    const onGestureEnd = (event) => event.preventDefault();

    const onPointerDown = (event) => {
      if (disabledRef.current) return;
      if (!isPanStart(event)) return;
      event.preventDefault();
      panRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      node.setPointerCapture?.(event.pointerId);
      node.classList.add('panning');
    };
    const onPointerMove = (event) => {
      const pan = panRef.current;
      if (!pan || pan.id !== event.pointerId) return;
      const dx = event.clientX - pan.x;
      const dy = event.clientY - pan.y;
      if (dx === 0 && dy === 0) return;
      pan.x = event.clientX; pan.y = event.clientY;
      setView((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
    };
    const endPan = (event) => {
      const pan = panRef.current;
      if (!pan || (event && pan.id !== event.pointerId)) return;
      panRef.current = null;
      node.releasePointerCapture?.(pan.id);
      node.classList.remove('panning');
    };

    node.addEventListener('wheel', onWheel, { passive: false });
    node.addEventListener('gesturestart', onGestureStart);
    node.addEventListener('gesturechange', onGestureChange);
    node.addEventListener('gestureend', onGestureEnd);
    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('pointermove', onPointerMove);
    node.addEventListener('pointerup', endPan);
    node.addEventListener('pointercancel', endPan);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateRect);
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('gesturestart', onGestureStart);
      node.removeEventListener('gesturechange', onGestureChange);
      node.removeEventListener('gestureend', onGestureEnd);
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', endPan);
      node.removeEventListener('pointercancel', endPan);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      pendingRef.current = null;
      panRef.current = null;
    };
  }, [node, flushWheel]);

  const zoomIn = useCallback(() => setView((prev) => zoomAbout(prev, 1.25)), []);
  const zoomOut = useCallback(() => setView((prev) => zoomAbout(prev, 1 / 1.25)), []);
  // Zoom to an absolute factor about the viewport centre.
  const zoomTo = useCallback((scale) => {
    setView((prev) => zoomAbout(prev, clampScale(scale) / prev.scale));
  }, []);
  const resetView = useCallback(() => setView(IDENTITY_VIEW), []);

  return { view, viewportRef, zoomIn, zoomOut, zoomTo, resetView };
}
