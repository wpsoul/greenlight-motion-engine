/*
 * "Smooth path" — one popover for every bezier path in the app.
 *
 * Hosts (shape/line paths, layer masks, object motion paths, the project camera
 * path, and the Flipbook's camera + Line Path objects) hand it a point list and a
 * way to write one back. It owns the settings and the numbers; it knows nothing
 * about where the path lives or what units it is in — see pathSmooth.js.
 *
 * THE PREVIEW IS THE PROJECT ITSELF. Every settings change writes the smoothed
 * points straight into the path, so what you judge is the real canvas at real
 * size, with the real anchors and handles. Dismissing the popover any way other
 * than Apply puts the original back.
 *
 * Two things that keeps honest:
 *   • every computation runs on the ORIGINAL points, captured once on mount, so
 *     dragging a slider never re-smooths an already-smoothed path; and
 *   • the restore runs from an unmount cleanup, so it covers Cancel, Escape,
 *     clicking away AND the host tearing the popover down (a selection change) —
 *     rather than only the dismissal paths someone remembered to handle.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  COUNT_SAFE_MODES,
  SMOOTH_DEFAULTS,
  smoothPath,
} from './pathSmooth';

const MODES = [
  {
    id: 'fit',
    label: 'Fit',
    blurb: 'Refits the curve with as few segments as the tolerance allows. Fewest points — but they land in new places.',
  },
  {
    id: 'reduce',
    label: 'Reduce',
    blurb: 'Deletes only the redundant points and refits the handles. Survivors keep their exact position and rotation.',
  },
  {
    id: 'even',
    label: 'Even',
    blurb: 'Rebuilds the path with an exact number of points, spaced by arc length.',
  },
  {
    id: 'relax',
    label: 'Relax',
    blurb: 'Keeps every point and averages out the shake. For traced, tracked or hand-drawn paths.',
  },
];

// Settings persist for the session so tuning once covers the next path too.
let lastSettings = { ...SMOOTH_DEFAULTS };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function useLeftAnchoredPopover(anchorRef, onClose) {
  const popRef = useRef(null);
  const [pos, setPos] = useState(null);
  // Layout effect, not effect: the popover is measured and moved before paint, so
  // it never flashes at the top-left corner first.
  useLayoutEffect(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const pop = popRef.current?.getBoundingClientRect();
    if (!anchor || !pop) return;
    setPos({
      left: Math.max(8, Math.min(anchor.left - pop.width - 12, window.innerWidth - pop.width - 8)),
      top: Math.max(8, Math.min(anchor.top, window.innerHeight - pop.height - 8)),
    });
  }, [anchorRef]);
  useEffect(() => {
    const onDown = (event) => {
      if (popRef.current?.contains(event.target)) return;
      if (anchorRef.current?.contains(event.target)) return;
      onClose();
    };
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);
  return {
    popRef,
    style: pos ? { left: pos.left, top: pos.top, visibility: 'visible' } : { left: 0, top: 0, visibility: 'hidden' },
  };
}

/**
 * @param points     the path's points, in the host's own units
 * @param closed     closed ring or open run
 * @param keyed      the path is keyframed — see the note at the foot of the panel
 * @param keyCount   how many keys, for the wording
 * @param unitLabel  'px', or null for unit-box paths where only % means anything
 * @param onWrite    (points, stats, { preview }) => void — put these points on the
 *                   path. `preview` writes come per settings change and should
 *                   coalesce into one undo entry; the final one does not.
 * @param onRestore  () => void — put the path back exactly as it was found
 */
export default function SmoothPathPopover({
  anchorRef,
  points,
  closed = false,
  keyed = false,
  keyCount = 0,
  unitLabel = 'px',
  title = 'Smooth path',
  onWrite,
  onRestore,
  onClose,
}) {
  const { popRef, style } = useLeftAnchoredPopover(anchorRef, onClose);
  // The path as it was when the popover opened. Everything is computed from this,
  // never from the `points` prop — which is now the live preview, and re-smoothing
  // it on every slider tick would compound the smoothing away to nothing.
  const sourceRef = useRef(points);
  const source = sourceRef.current;
  const [settings, setSettings] = useState(() => ({ ...lastSettings }));
  const set = useCallback((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      lastSettings = next;
      return next;
    });
  }, []);

  // A keyed path must keep the same point count in every key, so only the modes
  // that can be replayed identically on every key are offered. Fit picks its own
  // count per key — key 1 lands on 9 anchors, key 2 on 11, and the morph breaks.
  const modeAllowed = useCallback((id) => (
    !keyed || COUNT_SAFE_MODES.includes(id) || id === 'reduce' || id === 'even'
  ), [keyed]);

  const mode = modeAllowed(settings.mode) ? settings.mode : 'reduce';
  const activeMode = MODES.find((m) => m.id === mode) || MODES[0];

  const result = useMemo(() => {
    if (!Array.isArray(source) || source.length < 3) return null;
    return smoothPath(source, closed, { ...settings, mode });
  }, [source, closed, settings, mode]);

  // Live preview, written into the project a frame at a time. Latest-wins: a slider
  // drag fires far faster than a big path can be refitted and re-rendered.
  const writeRef = useRef(onWrite);
  const restoreRef = useRef(onRestore);
  writeRef.current = onWrite;
  restoreRef.current = onRestore;
  const frameRef = useRef(0);
  const appliedRef = useRef(false);
  useEffect(() => {
    if (!result) return undefined;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      writeRef.current?.(result.points, result.stats, { preview: true });
    });
    return () => cancelAnimationFrame(frameRef.current);
  }, [result]);
  useEffect(() => () => {
    cancelAnimationFrame(frameRef.current);
    if (!appliedRef.current) restoreRef.current?.();
  }, []);

  const stats = result?.stats;
  const before = source?.length || 0;
  const after = stats?.after ?? before;

  const devLabel = useMemo(() => {
    if (!stats) return '—';
    const pct = `${stats.maxDeviationPct.toFixed(2)}%`;
    if (!unitLabel) return pct;
    const abs = stats.maxDeviation;
    return `${abs < 10 ? abs.toFixed(2) : Math.round(abs)} ${unitLabel} · ${pct}`;
  }, [stats, unitLabel]);

  const devClass = stats && stats.maxDeviationPct < 0.4
    ? 'is-good'
    : (stats && stats.maxDeviationPct < 1.5 ? 'is-warn' : 'is-bad');

  const apply = () => {
    if (!result) return;
    appliedRef.current = true;
    cancelAnimationFrame(frameRef.current);
    onWrite?.(result.points, result.stats, { preview: false });
    onClose?.();
  };

  return createPortal(
    <div ref={popRef} className="ve-smooth-pop" style={style}>
      <div className="ve-smooth-head">
        <span className="ve-smooth-title">{title}</span>
        <span className="ve-smooth-count">
          <b>{before}</b> → <b className={after < before ? 'is-good' : ''}>{after}</b> points
        </span>
      </div>

      <div className="ve-smooth-tabs">
        {MODES.map((m) => {
          const allowed = modeAllowed(m.id);
          return (
            <button
              key={m.id}
              type="button"
              className={`${m.id === mode ? 'is-on' : ''}${allowed ? '' : ' is-off'}`}
              disabled={!allowed}
              title={allowed
                ? m.blurb
                : `${m.label} chooses its own point count, which a keyframed path can't have — use Reduce, Even or Relax.`}
              onClick={() => set({ mode: m.id })}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      <div className="ve-smooth-blurb">{activeMode.blurb}</div>

      {(mode === 'fit' || mode === 'reduce') && (
        <>
          <div className="ve-smooth-row">
            <label htmlFor="ve-smooth-amount">Smoothing</label>
            <span className="ve-smooth-val">{Math.round(settings.amount)}%</span>
          </div>
          <input
            id="ve-smooth-amount"
            className="ve-smooth-range"
            type="range"
            min="0"
            max="100"
            step="1"
            value={settings.amount}
            onChange={(e) => set({ amount: Number(e.target.value) })}
          />
          <div className="ve-smooth-chips">
            {[['Light', 8], ['Medium', 26], ['Strong', 48], ['Max', 72]].map(([label, value]) => (
              <button
                key={label}
                type="button"
                className={Math.round(settings.amount) === value ? 'is-on' : ''}
                onClick={() => set({ amount: value })}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="ve-smooth-row">
            <label className="ve-smooth-check">
              <input
                type="checkbox"
                checked={settings.limitPoints}
                onChange={(e) => set({ limitPoints: e.target.checked })}
              />
              <span>Limit points</span>
            </label>
            <input
              className="ve-smooth-num"
              type="number"
              min="2"
              max="400"
              disabled={!settings.limitPoints}
              value={settings.maxPoints}
              onChange={(e) => set({ maxPoints: clamp(Math.round(Number(e.target.value) || 2), 2, 400) })}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>
        </>
      )}

      {mode === 'even' && (
        <>
          <div className="ve-smooth-row">
            <label htmlFor="ve-smooth-even">Point count</label>
            <span className="ve-smooth-val">{settings.evenCount}</span>
          </div>
          <input
            id="ve-smooth-even"
            className="ve-smooth-range"
            type="range"
            min="3"
            max={Math.max(12, Math.min(120, before * 2))}
            step="1"
            value={settings.evenCount}
            onChange={(e) => set({ evenCount: Number(e.target.value) })}
          />
        </>
      )}

      {mode === 'relax' && (
        <>
          <div className="ve-smooth-row">
            <label htmlFor="ve-smooth-strength">Strength</label>
            <span className="ve-smooth-val">{settings.relaxStrength}%</span>
          </div>
          <input
            id="ve-smooth-strength"
            className="ve-smooth-range"
            type="range"
            min="0"
            max="100"
            step="1"
            value={settings.relaxStrength}
            onChange={(e) => set({ relaxStrength: Number(e.target.value) })}
          />
          <div className="ve-smooth-row">
            <label htmlFor="ve-smooth-passes">Passes</label>
            <span className="ve-smooth-val">{settings.relaxPasses}</span>
          </div>
          <input
            id="ve-smooth-passes"
            className="ve-smooth-range"
            type="range"
            min="1"
            max="24"
            step="1"
            value={settings.relaxPasses}
            onChange={(e) => set({ relaxPasses: Number(e.target.value) })}
          />
          <label className="ve-smooth-check ve-smooth-row-solo">
            <input
              type="checkbox"
              checked={settings.relaxPinCorners !== false}
              onChange={(e) => set({ relaxPinCorners: e.target.checked })}
            />
            <span>Pin corners &amp; ends</span>
          </label>
        </>
      )}

      {mode !== 'relax' && mode !== 'even' && (
        <div className="ve-smooth-row">
          <label htmlFor="ve-smooth-corner" title="Turns sharper than this stay sharp. 180° smooths straight through every corner.">
            Keep corners over
          </label>
          <span className="ve-smooth-val">{settings.cornerDeg}°</span>
        </div>
      )}
      {mode !== 'relax' && mode !== 'even' && (
        <input
          id="ve-smooth-corner"
          className="ve-smooth-range"
          type="range"
          min="0"
          max="180"
          step="1"
          value={settings.cornerDeg}
          onChange={(e) => set({ cornerDeg: Number(e.target.value) })}
        />
      )}

      <div className="ve-smooth-stats">
        <div>
          <span className="k">Max deviation</span>
          <span className={`v ${devClass}`}>{devLabel}</span>
        </div>
        <div>
          <span className="k">Length change</span>
          <span className="v">{stats ? `${stats.lengthDeltaPct >= 0 ? '+' : ''}${stats.lengthDeltaPct.toFixed(2)}%` : '—'}</span>
        </div>
        {mode === 'fit' && (
          <div>
            <span className="k">Corners kept</span>
            <span className="v">{stats ? stats.corners : '—'}</span>
          </div>
        )}
      </div>

      {keyed && (
        <div className="ve-smooth-note">
          {mode === 'reduce'
            ? `Keyframed — the same points are dropped from all ${keyCount || ''} keys, so the morph stays 1:1.`
            : mode === 'even'
              ? `Keyframed — every one of the ${keyCount || ''} keys is rebuilt with the same count.`
              : `Keyframed — each of the ${keyCount || ''} keys is smoothed in place; the count never changes.`}
        </div>
      )}

      <div className="ve-smooth-foot">
        <button type="button" className="ve-smooth-btn" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="ve-smooth-btn is-primary"
          disabled={!result}
          onClick={apply}
        >
          Apply
        </button>
      </div>
    </div>,
    document.body
  );
}
