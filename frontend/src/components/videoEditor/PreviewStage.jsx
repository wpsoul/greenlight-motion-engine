import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePreviewViewport, IDENTITY_VIEW, MIN_PREVIEW_SCALE, MAX_PREVIEW_SCALE } from './usePreviewViewport';

// The preview view (zoom/pan) is deliberately kept OUT of Player's own state:
// Player re-rendering on every wheel tick would re-run its whole memo/effect
// graph. The provider owns the state, Player passes its canvas/overlay through
// as `children` (stable elements, so the canvas never remounts), and only the
// three small consumers below re-render while zooming.
const PreviewViewContext = createContext({
  view: IDENTITY_VIEW,
  viewportRef: null,
  frameWidth: 0,
  setFrameWidth: () => {},
  zoomIn: () => {},
  zoomOut: () => {},
  zoomTo: () => {},
  resetView: () => {},
});

export function usePreviewView() {
  return useContext(PreviewViewContext);
}

export function PreviewViewProvider({ apiRef, gesturesDisabled = false, onViewMetrics = null, children }) {
  const viewport = usePreviewViewport(gesturesDisabled);
  // Layout (untransformed) width of the frame box, kept here so the zoom menu
  // can offer a true 1:1 pixel zoom and the gizmo can size its handles.
  const [frameWidth, setFrameWidth] = useState(0);

  const { zoomIn, zoomOut, zoomTo, resetView } = viewport;
  useEffect(() => {
    if (!apiRef) return undefined;
    apiRef.current = { zoomIn, zoomOut, zoomTo, resetView };
    return () => { apiRef.current = null; };
  }, [apiRef, zoomIn, zoomOut, zoomTo, resetView]);

  // Entering 3D view hands the surface to the orbit camera; a leftover CSS zoom
  // would just be a second, invisible transform on top of it.
  useEffect(() => {
    if (gesturesDisabled) resetView();
  }, [gesturesDisabled, resetView]);

  // The view transform itself remains isolated in this small provider, but the WebGL
  // backing store needs its scale + fitted CSS width to stay pixel-sharp under a zoom.
  // Player quantizes these metrics before resizing, so wheel events still do not
  // rerender its React tree or allocate a new target on every tick.
  useEffect(() => {
    onViewMetrics?.({ scale: viewport.view.scale, frameWidth });
  }, [frameWidth, onViewMetrics, viewport.view.scale]);

  const value = useMemo(
    () => ({ ...viewport, frameWidth, setFrameWidth, gesturesDisabled }),
    [viewport, frameWidth, gesturesDisabled]
  );
  return <PreviewViewContext.Provider value={value}>{children}</PreviewViewContext.Provider>;
}

/**
 * Pan/zoom surface for the preview. `.ve-player-viewport` is the gesture target
 * and the size container the frame fits itself into; `.ve-player-stage` carries
 * the view transform. Children (canvas + gizmo overlay) come from Player.
 */
export function PreviewStage({ videoWidth, videoHeight, children }) {
  const { view, viewportRef, setFrameWidth, resetView, gesturesDisabled } = usePreviewView();
  const containerRef = useRef(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;
    const measure = () => setFrameWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [setFrameWidth]);

  return (
    <div
      className={`ve-player-viewport${gesturesDisabled ? ' gestures-off' : ''}`}
      ref={viewportRef}
      onDoubleClick={(event) => {
        // Only the empty area around the frame — a double-click on a layer is
        // the gizmo's business. In 3D view the preview transform is pinned at
        // identity, so there is nothing to reset.
        if (gesturesDisabled) return;
        if (!event.target.closest('.ve-preview-transform-overlay')
          && !event.target.closest('.ve-rig-pin-overlay')
          && !event.target.closest('.ve-cc-compare-line')
      && !event.target.closest('.ve-distort-overlay')) resetView();
      }}
    >
      <div
        className="ve-player-stage"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      >
        <div className="ve-player-container" ref={containerRef} style={{ aspectRatio: `${videoWidth}/${videoHeight}` }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Toggle for the 3D world view, in the transport bar beside the zoom group.
 * Only mounted when the project has a camera layer — see `hasCameraChannel` in
 * Player. The view itself (and three's control addons) loads on the first click.
 */
export function WorldViewToggle({ active, onToggle, busy = false }) {
  return (
    <button
      type="button"
      className={`ve-player-info-btn ve-world-toggle${active ? ' active' : ''}`}
      onClick={() => onToggle(!active)}
      disabled={busy}
      aria-pressed={active}
      title={active
        ? 'Back to the camera view'
        : '3D view — see the scene and the camera in space'}
      aria-label="Toggle 3D world view"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2.6 21 7.4v9.2L12 21.4 3 16.6V7.4z" />
        <path d="M3 7.4 12 12l9-4.6" />
        <path d="M12 12v9.4" />
      </svg>
    </button>
  );
}

const GIZMO_MODES = [
  { id: 'translate', label: 'Move', key: 'W' },
  { id: 'rotate', label: 'Rotate', key: 'E' },
  { id: 'scale', label: 'Scale', key: 'R' },
];

/** Floating gizmo-mode picker, shown over the preview while 3D view is on. */
export function WorldViewHud({ mode, onModeChange, hasSelection, pathPointCount = 0 }) {
  // A path selection outranks the layer hint: the handles are on the anchors, and
  // the group case is the one that needs saying out loud.
  const hint = pathPointCount > 1
    ? `${pathPointCount} path points — move, rotate or scale them together`
    : pathPointCount === 1
      ? 'Drag the anchor; Shift-click more to transform them together'
      : hasSelection ? 'Drag the handles to place this layer' : 'Click a layer to place it';
  return (
    <div className="ve-world-hud">
      <span className="ve-world-hud-hint">{hint}</span>
      <div className="ve-world-hud-modes">
        {GIZMO_MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`ve-world-hud-btn${mode === item.id ? ' active' : ''}`}
            onClick={() => onModeChange(item.id)}
            disabled={!hasSelection}
            title={`${item.label} (${item.key})`}
            aria-pressed={mode === item.id}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const ZOOM_PRESETS = [0.25, 0.5, 1, 2, 4];

/** −/percentage/+ group for the transport bar. 100% means "fits the window". */
export function PreviewZoomControls({ videoWidth }) {
  const { view, zoomIn, zoomOut, zoomTo, resetView, frameWidth, gesturesDisabled } = usePreviewView();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  // 100% = fit-to-window (what the preview has always shown). A true 1:1 zoom —
  // one video pixel per screen pixel — is a preset, since on a 4K project inside
  // an 800px preview that is a very different number.
  const oneToOne = frameWidth > 0 ? videoWidth / frameWidth : 1;
  const percent = Math.round(view.scale * 100);
  const atOneToOne = Math.abs(view.scale - oneToOne) < 0.005;

  return (
    <div className={`ve-zoom-controls${gesturesDisabled ? ' disabled' : ''}`} ref={menuRef}>
      <button
        type="button"
        className="ve-player-info-btn ve-zoom-btn"
        onClick={zoomOut}
        disabled={gesturesDisabled || view.scale <= MIN_PREVIEW_SCALE + 1e-6}
        title={gesturesDisabled ? 'Preview zoom is off in 3D view — scroll to dolly the camera' : 'Zoom out (Cmd/Ctrl −)'}
        aria-label="Zoom out preview"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <button
        type="button"
        className={`ve-zoom-readout${view.scale !== 1 ? ' changed' : ''}`}
        onClick={() => setMenuOpen((open) => !open)}
        disabled={gesturesDisabled}
        title="Preview zoom — double-click the empty area or Cmd/Ctrl 0 to reset"
      >
        {percent}%
      </button>
      <button
        type="button"
        className="ve-player-info-btn ve-zoom-btn"
        onClick={zoomIn}
        disabled={gesturesDisabled || view.scale >= MAX_PREVIEW_SCALE - 1e-6}
        title={gesturesDisabled ? 'Preview zoom is off in 3D view — scroll to dolly the camera' : 'Zoom in (Cmd/Ctrl +)'}
        aria-label="Zoom in preview"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <button
        type="button"
        className="ve-player-info-btn ve-zoom-btn"
        onClick={resetView}
        disabled={gesturesDisabled || (view.scale === 1 && view.x === 0 && view.y === 0)}
        title="Fit to window, 100% (Cmd/Ctrl 0)"
        aria-label="Reset preview zoom"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <line x1="22" y1="12" x2="18" y2="12" />
          <line x1="6" y1="12" x2="2" y2="12" />
          <line x1="12" y1="6" x2="12" y2="2" />
          <line x1="12" y1="22" x2="12" y2="18" />
        </svg>
      </button>
      {menuOpen && (
        <div className="ve-zoom-menu" role="menu">
          {ZOOM_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`ve-zoom-item${Math.abs(view.scale - preset) < 0.005 ? ' active' : ''}`}
              role="menuitem"
              onClick={() => {
                if (preset === 1) resetView(); else zoomTo(preset);
                setMenuOpen(false);
              }}
            >
              <span className="ve-zoom-check" aria-hidden>{Math.abs(view.scale - preset) < 0.005 ? '✓' : ''}</span>
              <span>{preset === 1 ? 'Fit to window (100%)' : `${preset * 100}%`}</span>
            </button>
          ))}
          <div className="ve-zoom-divider" />
          <button
            type="button"
            className={`ve-zoom-item${atOneToOne ? ' active' : ''}`}
            role="menuitem"
            onClick={() => { zoomTo(oneToOne); setMenuOpen(false); }}
          >
            <span className="ve-zoom-check" aria-hidden>{atOneToOne ? '✓' : ''}</span>
            <span>1:1 pixels ({Math.round(oneToOne * 100)}%)</span>
          </button>
        </div>
      )}
    </div>
  );
}
