import { useRef, useState } from 'react';
import { ZOOM_RANGE_DEFAULT_MS, ZOOM_RANGE_MIN_MS, zoomSourceAt } from './smartZoomCamera';

/*
 * Zoom mode on the camera layer (smartZoomCamera.js): the camera clip's zoom ranges as blocks.
 *
 * - Add Zoom mode ON (the Zoom panel's button, `adding`): the whole layer is the zoom tool. Hover shows a ghost zoom
 *   with a + at the pointer, as long as a new zoom would be (it stops at the next one); a click adds it there. A block
 *   drags to move it.
 * - Add Zoom OFF: the layer is a plain camera clip again (it drags, trims and selects as one); only the blocks answer.
 *   A click picks a block, dragging a block's body drags the camera clip.
 * - Both: drag an end to resize a block, × removes it; a picked block is edited by the panel and the preview's gestures.
 * - Automatic zooms (made from the recording's clicks) are dashed until the first edit makes them the project's own.
 * - Each block's ease zones show as faded ends: before it, where the camera already sets off (lead); after it, where it
 *   is still coming back to rest (release). New and moved zooms keep out of them, so two zooms never ease over
 *   each other; their lengths are set in the panel (Ease in / Ease out).
 *
 * Times on the layer are timeline seconds; VideoEditor maps them into the recording's own time.
 */
export default function ZoomRangeLane({
  itemId,
  clipStartSec,
  pps,
  model, // { blocks (with leadSec / releaseSec), auto, ranges, presetZoom, edit, newZone }
  selectedId = null,
  adding = false,
  onAdd,
  onMove,
  onSelect,
  onRemove,
  onHoverChange,
}) {
  const laneRef = useRef(null);
  const dragRef = useRef(null);
  const [ghost, setGhost] = useState(null); // { left, width, timeSec }
  const blocks = model?.blocks || [];
  const byId = new Map((model?.ranges || []).map((r) => [r.id, r]));

  const timeAt = (clientX) => {
    const rect = laneRef.current?.getBoundingClientRect();
    return rect ? clipStartSec + (clientX - rect.left) / pps : null;
  };
  const updateGhost = (e) => {
    if (dragRef.current || e.target.closest('.ve-zoom-block')) { setGhost(null); return; }
    const t = timeAt(e.clientX);
    const leadNew = (Number(model?.newZone?.leadMs) || 0) / 1000;
    const relNew = (Number(model?.newZone?.releaseMs) || 0) / 1000;
    // not on a block, nor where a new zoom would set off inside the last one's release
    if (t === null || zoomSourceAt(model?.edit, t) === null
      || blocks.some((b) => t >= b.startSec && t < b.endSec + (b.releaseSec || 0) + leadNew)) { setGhost(null); return; }
    const next = blocks.filter((b) => b.startSec > t).reduce((m, b) => Math.min(m, b.startSec - (b.leadSec || 0) - relNew), Infinity);
    const len = Math.min(ZOOM_RANGE_DEFAULT_MS / 1000, next - t);
    if (len < ZOOM_RANGE_MIN_MS / 1000) { setGhost(null); return; }
    setGhost({ left: (t - clipStartSec) * pps, width: len * pps, timeSec: t });
  };
  // The clip's native drag waits while the pointer is on a part that drags by itself: the whole lane in Add Zoom, an
  // end or × otherwise. A drag that ends somewhere else hands it back.
  const partHover = (on) => { if (!adding && !dragRef.current) onHoverChange?.(on); };
  const settleHover = (x, y) => {
    const el = document.elementFromPoint(x, y);
    onHoverChange?.(!!el?.closest(adding ? '.ve-zoom-lane' : '.ve-zoom-edge, .ve-zoom-del'));
  };

  // Drag a block (kind 'move') or one of its ends ('start' / 'end'). The first write opens the undo entry, the rest
  // merge into it; a press that never moves is just the pick.
  const startDrag = (e, block, kind) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect?.(itemId, block.id);
    dragRef.current = { kind, id: block.id, x: e.clientX, start: block.startSec, end: block.endSec, moved: false, wrote: false };
    setGhost(null);
    const onMoveEvt = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.x;
      if (!d.moved && Math.abs(dx) < 3) return;
      d.moved = true;
      const dt = dx / pps;
      const patch = kind === 'move'
        ? { startSec: d.start + dt, endSec: d.end + dt }
        : kind === 'start' ? { startSec: d.start + dt } : { endSec: d.end + dt };
      onMove?.(itemId, d.id, patch, d.wrote);
      d.wrote = true;
    };
    const onUp = (ev) => {
      const moved = dragRef.current?.moved;
      dragRef.current = null;
      window.removeEventListener('pointermove', onMoveEvt);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      settleHover(ev.clientX, ev.clientY);
      // A drag released off its block clicks the camera clip under it, which would toggle the clip's selection off.
      if (moved) {
        const eat = (ce) => ce.stopPropagation();
        window.addEventListener('click', eat, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 0);
      }
    };
    window.addEventListener('pointermove', onMoveEvt);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  return (
    <div
      ref={laneRef}
      className={`ve-zoom-lane${adding ? ' adding' : ''}${model?.auto ? ' auto' : ''}`}
      {...(adding ? {
        onPointerEnter: () => onHoverChange?.(true),
        onPointerLeave: () => { setGhost(null); onHoverChange?.(false); },
        onPointerMove: updateGhost,
        onPointerDown: (e) => { e.stopPropagation(); },
        onClick: (e) => {
          e.stopPropagation();
          if (ghost && !e.target.closest('.ve-zoom-block')) {
            onAdd?.(itemId, ghost.timeSec);
            setGhost(null);
          }
        },
        onDoubleClick: (e) => e.stopPropagation(),
      } : {})}
    >
      {blocks.map((b) => (
        <span key={`zone:${b.id}:${b.startSec.toFixed(3)}`} aria-hidden="true">
          {b.leadSec > 0.001 && (
            <span
              className={`ve-zoom-ease in${b.id === selectedId ? ' sel' : ''}`}
              style={{ left: `${(b.startSec - b.leadSec - clipStartSec) * pps}px`, width: `${b.leadSec * pps}px` }}
              title="Ease in: the camera sets off before the zoom starts"
            />
          )}
          {b.releaseSec > 0.001 && (
            <span
              className={`ve-zoom-ease out${b.id === selectedId ? ' sel' : ''}`}
              style={{ left: `${(b.endSec - clipStartSec) * pps}px`, width: `${b.releaseSec * pps}px` }}
              title="Ease out: the camera is still coming back to rest — other zooms keep out of it"
            />
          )}
        </span>
      ))}
      {blocks.map((b) => {
        const r = byId.get(b.id);
        const zoom = Number(r?.zoom) > 0 ? Number(r.zoom) : model?.presetZoom || 1.45;
        const sel = b.id === selectedId;
        return (
          <div
            key={`${b.id}:${b.startSec.toFixed(3)}`}
            className={`ve-zoom-block${sel ? ' sel' : ''}${model?.auto ? ' auto' : ''}${r?.mode === 'fixed' ? ' fixed' : ''}${r?.disabled ? ' off' : ''}`}
            data-zoom-id={b.id}
            style={{ left: `${(b.startSec - clipStartSec) * pps}px`, width: `${Math.max(2, (b.endSec - b.startSec) * pps)}px` }}
            title={`Zoom ${b.n} · ${zoom.toFixed(2)}×${model?.auto ? ' · made from your clicks' : ''}${r?.mode === 'fixed' ? ' · fixed point' : ''} — ${adding ? 'drag to move' : 'click to pick'}, drag an end to resize`}
            // Add Zoom off: the press goes on to the camera clip, so dragging the body drags the clip.
            onPointerDown={adding ? (e) => startDrag(e, b, 'move') : undefined}
            onClick={(e) => {
              e.stopPropagation();
              if (!adding) onSelect?.(itemId, b.id);
            }}
          >
            {!b.clippedStart && (
              <span
                className="ve-zoom-edge l"
                onPointerEnter={() => partHover(true)}
                onPointerLeave={() => partHover(false)}
                onPointerDown={(e) => startDrag(e, b, 'start')}
              />
            )}
            <span className="ve-zoom-label">{`${b.n} · ${zoom.toFixed(2)}×`}</span>
            {!b.clippedEnd && (
              <span
                className="ve-zoom-edge r"
                onPointerEnter={() => partHover(true)}
                onPointerLeave={() => partHover(false)}
                onPointerDown={(e) => startDrag(e, b, 'end')}
              />
            )}
            <button
              type="button"
              className="ve-zoom-del"
              aria-label={`Remove zoom ${b.n}`}
              title="Remove this zoom"
              onPointerEnter={() => partHover(true)}
              onPointerLeave={() => partHover(false)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onRemove?.(itemId, b.id);
                // the button goes with its zoom, so its pointer-leave never comes
                if (!adding) onHoverChange?.(false);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      {ghost && (
        <div className="ve-zoom-ghost" style={{ left: `${ghost.left}px`, width: `${ghost.width}px` }} aria-hidden="true">
          <span className="ve-zoom-plus">+</span>
        </div>
      )}
    </div>
  );
}
