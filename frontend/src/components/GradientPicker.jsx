import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';
import ColorPicker from './ColorPicker';
import { buildGradient, gradientFirstStopColor, isCssGradient, parseGradient } from '../utils/cssGradient';

const DEFAULT_ACCENT = '#8b5cf6';

function defaultGradient(value) {
  const start = isCssGradient(value) ? gradientFirstStopColor(value, '#ffffff') : (value || '#ffffff');
  return buildGradient('linear', 90, [
    { color: start, position: 0 },
    { color: DEFAULT_ACCENT, position: 100 },
  ]);
}

function normalizeState(value) {
  return parseGradient(value) || parseGradient(defaultGradient(value));
}

function clampPosition(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function useDrag(onMove) {
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  return useCallback((e, payload) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.parentElement.getBoundingClientRect();
    const move = (ev) => onMoveRef.current(ev, rect, payload);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    move(e);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, []);
}

export default function GradientPicker({ value, onChange, popoverPlacement = 'start' }) {
  const [open, setOpen] = useState(false);
  const [gradient, setGradient] = useState(() => normalizeState(value));
  const [selectedIndex, setSelectedIndex] = useState(0);
  const wrapRef = useRef(null);
  const popRef = useRef(null);
  const lastEmittedRef = useRef(value);

  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    const next = normalizeState(value);
    setGradient(next);
    setSelectedIndex((idx) => Math.min(idx, next.stops.length - 1));
  }, [value]);

  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  /* Rendered into <body> at fixed coordinates rather than absolutely inside the
     trigger: this panel is far taller and wider than the row that opens it, so
     anchored it was clipped by whatever scrolls. Mirrors ColorPicker. */
  const [popPos, setPopPos] = useState(null);
  useLayoutEffect(() => {
    if (!open) { setPopPos(null); return undefined; }
    const compute = () => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const w = popRef.current?.offsetWidth || 240;
      const h = popRef.current?.offsetHeight || 380;
      const gap = 5;
      const openUp = window.innerHeight - r.bottom < h + gap + 8 && r.top > window.innerHeight - r.bottom;
      const rawLeft = popoverPlacement === 'end' ? r.right - w : r.left;
      setPopPos({
        left: Math.max(8, Math.min(window.innerWidth - w - 8, rawLeft)),
        top: openUp ? null : Math.max(8, Math.min(r.bottom + gap, window.innerHeight - h - 8)),
        bottom: openUp ? window.innerHeight - r.top + gap : null,
      });
    };
    compute();
    const raf = requestAnimationFrame(compute);
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open, popoverPlacement]);

  const emit = useCallback((next) => {
    const css = buildGradient(next.type, next.angle, next.stops);
    lastEmittedRef.current = css;
    setGradient(parseGradient(css) || next);
    onChange(css);
  }, [onChange]);

  const updateStop = useCallback((index, patch) => {
    const stops = gradient.stops.map((stop, idx) => idx === index ? { ...stop, ...patch } : stop);
    emit({ ...gradient, stops });
  }, [emit, gradient]);

  const selectedStop = gradient.stops[selectedIndex] || gradient.stops[0];
  const cssValue = buildGradient(gradient.type, gradient.angle, gradient.stops);

  const addStopAt = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const position = clampPosition(((e.clientX - rect.left) / rect.width) * 100);
    const stops = [...gradient.stops, { color: selectedStop?.color || '#ffffff', position }]
      .sort((a, b) => a.position - b.position);
    const nextIndex = stops.findIndex((stop) => stop.position === position && stop.color === (selectedStop?.color || '#ffffff'));
    setSelectedIndex(Math.max(0, nextIndex));
    emit({ ...gradient, stops });
  }, [emit, gradient, selectedStop]);

  const stopDrag = useDrag((e, rect, index) => {
    updateStop(index, { position: clampPosition(((e.clientX - rect.left) / rect.width) * 100) });
  });

  const deleteStop = useCallback(() => {
    if (gradient.stops.length <= 2) return;
    const stops = gradient.stops.filter((_, idx) => idx !== selectedIndex);
    setSelectedIndex(Math.min(selectedIndex, stops.length - 1));
    emit({ ...gradient, stops });
  }, [emit, gradient, selectedIndex]);

  return (
    <div className="cp-wrap gp-wrap" ref={wrapRef}>
      <button
        type="button"
        className="cp-swatch-btn"
        onClick={() => setOpen((v) => !v)}
        title={cssValue}
      >
        <span className="cp-swatch" style={{ background: cssValue }} />
        <span className="cp-swatch-label">Gradient</span>
      </button>
      {open && popPos && createPortal(
        <div
          className="cp-portal"
          style={{
            position: 'fixed',
            left: popPos.left,
            top: popPos.top ?? undefined,
            bottom: popPos.bottom ?? undefined,
            zIndex: 100020,
          }}
        >
        <div
          className={`cp-popover gp-popover ${popoverPlacement === 'end' ? 'cp-popover-end' : ''}`.trim()}
          ref={popRef}
        >
          <div className="gp-row">
            <label className="gp-label">
              <span>Type</span>
              <select
                className="gp-select"
                value={gradient.type}
                onChange={(e) => emit({ ...gradient, type: e.target.value })}
              >
                <option value="linear">Linear</option>
                <option value="radial">Radial</option>
              </select>
            </label>
            {gradient.type === 'linear' && (
              <label className="gp-label">
                <span>Angle</span>
                <input
                  className="gp-number"
                  type="number"
                  min="-360"
                  max="360"
                  step="1"
                  value={Math.round(gradient.angle)}
                  onChange={(e) => emit({ ...gradient, angle: Number(e.target.value) || 0 })}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </label>
            )}
          </div>

          <div className="gp-bar" style={{ background: cssValue }} onMouseDown={addStopAt}>
            {gradient.stops.map((stop, idx) => (
              <button
                key={`${stop.color}-${idx}`}
                type="button"
                className={`gp-stop${idx === selectedIndex ? ' active' : ''}`}
                style={{ left: `${stop.position}%`, background: stop.color }}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedIndex(idx);
                }}
                onMouseDown={(e) => {
                  setSelectedIndex(idx);
                  stopDrag(e, idx);
                }}
                title={`${Math.round(stop.position)}%`}
              />
            ))}
          </div>

          <div className="gp-stop-editor">
            <div className="gp-stop-header">
              <span className="gp-stop-title">Stop</span>
              <input
                className="gp-position-input"
                type="number"
                min="0"
                max="100"
                step="1"
                value={Math.round(selectedStop?.position ?? 0)}
                onChange={(e) => updateStop(selectedIndex, { position: clampPosition(e.target.value) })}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="gp-icon-btn"
                onClick={deleteStop}
                disabled={gradient.stops.length <= 2}
                title="Delete stop"
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
            <ColorPicker
              embedded
              withAlpha
              value={selectedStop?.color || '#ffffff'}
              onChange={(color) => updateStop(selectedIndex, { color })}
            />
          </div>
        </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
