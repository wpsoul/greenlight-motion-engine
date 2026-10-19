// The keyframe preset modal ("Spotlight": search, category chips, a wall of live previews, the timing band,
// Cancel / Add), moved out of EditorPanel.jsx so the GreenLight Motion page (frontend/src/motionEngine/PlayerPage.jsx)
// opens the same window. Styles: videoEditor.css's .ve-kfp-* block (the engine build carries those rules).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { interpolateKeyframes, interpolatePropertyKeyframes, commonToPropertyKeyframes, mirrorCommonKeyframes } from './gsapTransitions';
import { applyKeyframeFxToValues } from './keyframeFx';
import { KFP_CATEGORIES, KFP_DEFAULT_LENGTH, kfpVariants } from './keyframePresetCatalog';
import { directedKeyframes, directionsOf, oppositeDirection, DIRECTION_LABEL } from './presetDirections';
import DirectionPad from './DirectionPad';
import { NumberField } from './Fields';

function clampNumber(v, min = -Infinity, max = Infinity) {
  return Math.max(min, Math.min(max, v));
}

function readNumber(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// `boxColor` is the stand-in layer's fill. Presets that animate `color` still
// paint over it — for those the colour IS the preset.
export function KeyframePresetPreview({ keyframes, boxColor = '#8b5cf6', fx = null, seconds = 1.5 }) {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const duration = 2400;
    let frameId = 0;
    const start = performance.now();
    const tick = (ts) => {
      const elapsed = (ts - start) % duration;
      setProgress(elapsed / duration);
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, []);

  // A preset with ƒx has to be previewed the way it plays: per-property tracks
  // (what applyPreset writes) with the expression map on top. Presets without one
  // keep the common-snapshot path the thumbnails have always used.
  const hasFx = !!fx && Object.keys(fx).length > 0;
  const fxItem = useMemo(() => {
    if (!hasFx) return null;
    const { propertyKeyframes, transformOrigin } = commonToPropertyKeyframes(keyframes);
    return { id: '__preset-preview__', propertyKeyframes, keyframeTransformOrigin: transformOrigin, propertyKeyframeFx: fx };
  }, [hasFx, keyframes, fx]);
  let props = null;
  if (keyframes.length >= 2) {
    if (fxItem) {
      const base = interpolatePropertyKeyframes(fxItem.propertyKeyframes, progress, fxItem.keyframeTransformOrigin);
      props = base ? applyKeyframeFxToValues(fxItem, base, progress, seconds > 0 ? seconds : 1.5) : null;
    } else {
      props = interpolateKeyframes(keyframes, progress);
    }
  }
  const scale = readNumber(props?.scale, 1);
  const rotate = readNumber(props?.rotate, 0);
  const rotateX = readNumber(props?.rotateX, 0);
  const rotateY = readNumber(props?.rotateY, 0);
  const translateX = readNumber(props?.translateX, 0) * 0.25 + readNumber(props?.xPercent, 0) * 0.4;
  const translateY = readNumber(props?.translateY, 0) * 0.25 + readNumber(props?.yPercent, 0) * 0.25;
  const translateZ = readNumber(props?.translateZ, 0) * 0.1;
  const opacity = clampNumber(readNumber(props?.opacity, 1), 0, 2);
  const blur = Math.max(0, readNumber(props?.blur, 0)) * 0.4;
  const brightness = Math.max(0, readNumber(props?.brightness, 100));
  const contrast = Math.max(0, readNumber(props?.contrast, 100));
  const saturate = Math.max(0, readNumber(props?.saturate, 100));
  const hue = readNumber(props?.['hue-rotate'], 0);
  const squareColor = typeof props?.color === 'string' ? props.color : boxColor;
  const bgColor = typeof props?.backgroundColor === 'string' ? props.backgroundColor : '#0f1017';

  return (
    <div className="ve-kf-preset-preview" style={{ background: bgColor }}>
      <div
        className="ve-kf-preset-preview-box"
        style={{
          transform: `translate3d(${translateX}px, ${translateY}px, ${translateZ}px) scale(${scale}) rotate(${rotate}deg) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`,
          background: squareColor,
          opacity,
          filter: `blur(${blur}px) brightness(${brightness}%) contrast(${contrast}%) saturate(${saturate}%) hue-rotate(${hue}deg)`,
        }}
      />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Keyframe preset modal — "Spotlight"
   Presets used to be a popover that always spread the animation across the
   WHOLE clip. This modal adds the two things that were missing — where the
   animation starts, and how long it runs — plus intro/outro and type filters.
   Laid out in command-palette order: search leads, the preset list is the
   surface, and the timing controls sit in a compact bar above the footer.
   Look-dev harness for the layout: html/keyframe-presets-modal-v2.html (4)
   ══════════════════════════════════════════════════════════════════════════ */

// "Saved" is the owner's own presets (userPresets.js) — a category only when there are some.
const KFP_CAT_NAME = { ...Object.fromEntries(KFP_CATEGORIES.map((c) => [c.id, c.name])), saved: 'Saved' };
// Length presets, in seconds. 'whole' is the old behaviour, kept as an option.
const KFP_LENGTHS = [
  { id: '0.5', label: '0.5s' },
  { id: '1', label: '1s' },
  { id: '1.5', label: '1.5s' },
  { id: '2', label: '2s' },
  { id: '3', label: '3s' },
  { id: 'whole', label: 'Whole Layer' },
];
// The preview square reads as a neutral stand-in layer here, not as the violet
// accent the builder's own preview uses.
const KFP_BOX_COLOR = '#d8d8e2';

const kfpClamp = (v, min, max) => Math.max(min, Math.min(max, v));
const kfpFmt = (s) => `${s.toFixed(2)}s`;


export default function VEKeyframePresetModal({
  presets,
  renderPresetPreview,
  // Clip length in seconds. 0 when the caller does not know it — the modal then
  // offers whole-layer only, which is exactly the pre-modal behaviour.
  itemDuration = 0,
  // Playhead position inside the clip as a percent, or null (playing / off-clip).
  playheadProgress = null,
  onApply,
  onClose,
  // removes one of the owner's saved presets (cat 'saved'); absent = no remove control
  onDeleteSaved = null,
  // 'in' (Intro) or 'out' (Outro): which side the modal opens on
  initialDir = 'in',
}) {
  const duration = itemDuration > 0 ? itemDuration : 0;
  const categories = useMemo(() => (
    presets.some((p) => p.cat === 'saved') ? [{ id: 'saved', name: 'Saved' }, ...KFP_CATEGORIES] : KFP_CATEGORIES
  ), [presets]);
  const hasTimeline = duration > 0;
  const playheadSec = hasTimeline && playheadProgress != null
    ? kfpClamp((playheadProgress / 100) * duration, 0, duration)
    : null;

  const [dir, setDir] = useState(initialDir === 'out' ? 'out' : 'in');
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [lengthMode, setLengthMode] = useState(() => {
    if (!hasTimeline || duration <= KFP_DEFAULT_LENGTH) return 'whole';
    return String(KFP_DEFAULT_LENGTH);
  });
  const [customLength, setCustomLength] = useState(KFP_DEFAULT_LENGTH);
  const [startSec, setStartSec] = useState(() => (initialDir === 'out' && hasTimeline && duration > KFP_DEFAULT_LENGTH
    ? duration - KFP_DEFAULT_LENGTH : (playheadSec ?? 0)));
  const [selectedId, setSelectedId] = useState(null);
  // the direction chosen on the pad for the selected directional preset (presetDirections.js); kept across presets
  // of the same kind, reset to a preset's own direction when it does not offer the one in force
  const [direction, setDirection] = useState(null);
  const trackRef = useRef(null);
  const wallRef = useRef(null);

  const lengthSec = useMemo(() => {
    if (!hasTimeline || lengthMode === 'whole') return duration;
    const raw = lengthMode === 'custom' ? customLength : Number.parseFloat(lengthMode);
    return kfpClamp(Number.isFinite(raw) ? raw : KFP_DEFAULT_LENGTH, 0.05, duration);
  }, [hasTimeline, lengthMode, customLength, duration]);

  const maxStart = Math.max(0, duration - lengthSec);
  const start = kfpClamp(startSec, 0, maxStart);
  const end = Math.min(duration, start + lengthSec);
  const startPct = hasTimeline ? (start / duration) * 100 : 0;
  const endPct = hasTimeline ? (end / duration) * 100 : 100;
  const spanPct = endPct - startPct;
  const playheadPct = playheadSec != null ? (playheadSec / duration) * 100 : null;

  const variants = useMemo(() => kfpVariants(presets, dir), [presets, dir]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return variants.filter((preset) => (
      (category === 'all' || preset.cat === category)
      && (!q || preset.name.toLowerCase().includes(q) || (preset.description || '').toLowerCase().includes(q))
    ));
  }, [variants, category, query]);
  const countFor = useCallback(
    (id) => (id === 'all' ? variants.length : variants.filter((p) => p.cat === id).length),
    [variants],
  );
  const selected = visible.find((p) => p.id === selectedId) || null;
  // What a tile shows and what Add applies: a directional preset turned to its direction (the selected one to the
  // pad's, the others to their own); an Outro of one is turned to the OPPOSITE direction and played backwards, so
  // it leaves the way the pad points.
  const dirOf = (preset) => {
    const allowed = directionsOf(preset);
    if (!allowed) return null;
    return preset.id === selectedId && allowed.includes(direction) ? direction : preset.baseDir;
  };
  const resolve = (preset) => {
    const d = dirOf(preset);
    if (!d) return preset;
    if (preset.outro) {
      const turned = directedKeyframes(preset, oppositeDirection(d));
      return { ...preset, keyframes: mirrorCommonKeyframes(turned.keyframes), fx: turned.fx };
    }
    return { ...preset, ...directedKeyframes(preset, d) };
  };

  // Flipping to Outro moves the window to the tail of the clip, which is where an
  // exit belongs; flipping back returns it to the playhead.
  const changeDir = (next) => {
    setDir(next);
    if (!hasTimeline || lengthMode === 'whole') return;
    setStartSec(next === 'out' ? Math.max(0, duration - lengthSec) : (playheadSec ?? 0));
  };
  // An In and Out preset (enter, glide across, leave) reads as the WHOLE layer: it takes the whole range unless the
  // user has set a length or dragged the window themselves.
  const lengthTouched = useRef(false);
  const changeLength = (mode) => {
    lengthTouched.current = true;
    setLengthMode(mode);
    if (mode === 'whole') setStartSec(0);
  };
  const selectPreset = (preset) => {
    setSelectedId(preset.id);
    const allowed = directionsOf(preset);
    if (allowed && !allowed.includes(direction)) setDirection(preset.baseDir);
    if (preset.inOut && !lengthTouched.current && lengthMode !== 'whole') {
      setLengthMode('whole');
      setStartSec(0);
    }
  };

  const applySelected = (preset) => {
    const target = preset || selected;
    if (!target) return;
    onApply(resolve(target), target.inOut && !lengthTouched.current ? { startPct: 0, endPct: 100 } : { startPct, endPct });
  };

  /* ── Range strip drags ──
     `move` slides the window, the edge handles resize it (which switches Length to
     custom), and the click-through on the track jumps the start point. */
  const beginDrag = (mode) => (e) => {
    if (!hasTimeline || !trackRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    lengthTouched.current = true;   // the user placed the window: an In and Out preset keeps it
    const rect = trackRef.current.getBoundingClientRect();
    const pxPerSec = rect.width / duration;
    const x0 = e.clientX;
    const s0 = start;
    const l0 = lengthSec;
    const onMove = (ev) => {
      const delta = (ev.clientX - x0) / pxPerSec;
      if (mode === 'move') {
        setStartSec(kfpClamp(s0 + delta, 0, Math.max(0, duration - l0)));
      } else if (mode === 'left') {
        const nextStart = kfpClamp(s0 + delta, 0, s0 + l0 - 0.05);
        setStartSec(nextStart);
        setCustomLength(kfpClamp(l0 + (s0 - nextStart), 0.05, duration));
        setLengthMode('custom');
      } else {
        setCustomLength(kfpClamp(l0 + delta, 0.05, duration - s0));
        setLengthMode('custom');
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  const jumpTo = (e) => {
    if (!hasTimeline || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    setStartSec(kfpClamp(((e.clientX - rect.left) / rect.width) * duration, 0, maxStart));
  };

  /* ── Keyboard ──
     The list is the primary surface and the Add button advertises ⏎, so the
     modal has to actually answer to the keyboard: ↑/↓ walk the filtered list,
     Enter applies, Esc closes. Enter is ignored inside the timing bar, where
     it means "commit this number", not "apply the preset". */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'Enter') {
        if (!selected || e.target?.closest?.('.ve-kfp-when')) return;
        e.preventDefault();
        applySelected();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (!visible.length) return;
      e.preventDefault();
      const at = visible.findIndex((p) => p.id === selectedId);
      const next = e.key === 'ArrowDown'
        ? Math.min(visible.length - 1, at + 1)
        : (at < 0 ? visible.length - 1 : Math.max(0, at - 1));
      selectPreset(visible[next]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, selectedId, selected, applySelected, onClose, direction, lengthMode]);   // selectPreset reads both

  // Keep the keyboard selection on screen. `nearest` makes a click on an
  // already-visible row a no-op.
  useEffect(() => {
    if (!selectedId || !wallRef.current) return;
    wallRef.current.querySelector(`[data-preset-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const dirLabel = dir === 'out' ? 'Outro' : 'Intro';
  const rangeLabel = `${kfpFmt(start)} → ${kfpFmt(end)} · ${lengthSec.toFixed(2)}s`;
  // The range block is too thin to carry its own label, so the footer always
  // states the window — with the preset name in front of it once one is picked.
  const footLabel = selected
    ? `${selected.name}${dirOf(selected) ? ` ${DIRECTION_LABEL[dirOf(selected)]}` : ''} · ${dirLabel}${hasTimeline ? ` · ${rangeLabel}` : ''}`
    : (hasTimeline ? `${dirLabel} · ${rangeLabel}` : 'Pick a preset');

  return createPortal(
    <div className="ve-kfp-overlay" data-dir={dir} onMouseDown={onClose}>
      <div className="ve-kfp-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ve-kfp-head">
          <span className="ve-kfp-title">Presets</span>
          <div className="ve-kfp-spacer" />
          <div className="ve-kfp-seg">
            {[['in', 'Intro'], ['out', 'Outro']].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={dir === value ? 'active' : ''}
                onClick={() => changeDir(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" className="ve-kf-modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        {/* ── Browse — search leads, the way a command bar does ── */}
        <div className="ve-kfp-bar">
          <div className="ve-kfp-search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
            </svg>
            <input
              type="text"
              autoFocus
              placeholder={`Search ${dir === 'out' ? 'outro' : 'intro'} presets…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="ve-kfp-chips">
            {[{ id: 'all', name: 'All' }, ...categories].map((cat) => (
              <button
                key={cat.id}
                type="button"
                className={`ve-kfp-chip${category === cat.id ? ' active' : ''}`}
                onClick={() => setCategory(cat.id)}
              >
                {cat.name}<b>{countFor(cat.id)}</b>
              </button>
            ))}
          </div>
        </div>

        <div className="ve-kfp-wall" ref={wallRef}>
          {visible.map((preset) => (
            <button
              key={preset.id}
              type="button"
              data-preset-id={preset.id}
              className={`ve-kfp-tile${selectedId === preset.id ? ' active' : ''}`}
              title={preset.description}
              onClick={() => selectPreset(preset)}
              onDoubleClick={() => applySelected(preset)}
            >
              {renderPresetPreview
                ? renderPresetPreview(resolve(preset))
                : <KeyframePresetPreview keyframes={resolve(preset).keyframes} fx={resolve(preset).fx || null} seconds={lengthSec} boxColor={KFP_BOX_COLOR} />}
              <span className="ve-kfp-tile-txt">
                <span className="ve-kfp-tile-name">{preset.name}</span>
                <span className="ve-kfp-tile-desc">{preset.description}</span>
              </span>
              <span className="ve-kfp-tile-cat">{KFP_CAT_NAME[preset.cat] || ''}</span>
              {preset.cat === 'saved' && onDeleteSaved && (
                <span
                  className="ve-kfp-tile-del"
                  role="button"
                  tabIndex={-1}
                  title={`Remove “${preset.name}” from your presets`}
                  onClick={(e) => { e.stopPropagation(); onDeleteSaved(preset.id); if (selectedId === preset.id) setSelectedId(null); }}
                >
                  ×
                </span>
              )}
            </button>
          ))}
          {visible.length === 0 && <div className="ve-kfp-empty">No presets match this filter.</div>}
        </div>

        {/* ── When — where the animation starts and how long it runs ── */}
        <div className="ve-kfp-when">
          <div className="ve-kfp-row ve-kfp-when-head">
            <span className="ve-kfp-lbl">When</span>
            <div className="ve-kfp-spacer" />
            <span className="ve-kfp-hint">
              {hasTimeline ? 'Drag the block · edges resize' : 'Clip length unknown — whole layer'}
            </span>
          </div>

          {selected && directionsOf(selected) && (
            <div className="ve-kfp-row ve-kfp-dir-row">
              <span className="ve-kfp-rowlabel">Direction</span>
              <DirectionPad value={dirOf(selected)} options={directionsOf(selected)} onChange={setDirection} />
              <span className="ve-kfp-dir-text">
                Travels <b>{DIRECTION_LABEL[dirOf(selected)]}</b>
                <small>{selected.inOut ? 'in on one side, out on the other' : (dir === 'out' ? 'leaves this way' : 'comes in this way')}</small>
              </span>
            </div>
          )}

          {hasTimeline && (
            <div className="ve-kfp-strip">
              <div className="ve-kfp-track" ref={trackRef} onPointerDown={jumpTo}>
                <div className="ve-kfp-layer"><span>Layer · {kfpFmt(duration)}</span></div>
                <div className="ve-kfp-shade" style={{ left: 0, width: `${startPct}%` }} />
                <div className="ve-kfp-shade" style={{ left: `${endPct}%`, right: 0 }} />
                <div
                  className="ve-kfp-range"
                  style={{ left: `${startPct}%`, width: `${spanPct}%` }}
                  onPointerDown={beginDrag('move')}
                >
                  <span className="ve-kfp-handle left" onPointerDown={beginDrag('left')} />
                  <span className="ve-kfp-handle right" onPointerDown={beginDrag('right')} />
                  {selected?.keyframes.map((key, i) => (
                    <span key={`${key.position}-${i}`} className="ve-kfp-key" style={{ left: `${key.position}%` }} />
                  ))}
                </div>
                {playheadPct != null && (
                  <div className="ve-kfp-playhead" style={{ left: `${playheadPct}%` }} />
                )}
              </div>
            </div>
          )}

          {hasTimeline && (
            <div className="ve-kfp-row">
              <span className="ve-kfp-rowlabel">Start</span>
              <div className="ve-kfp-num">
                <NumberField
                  value={start}
                  step={0.05}
                  precision={2}
                  min={0}
                  max={maxStart}
                  suffix="s"
                  title="First keyframe, in seconds from the start of the clip"
                  onInput={(v) => setStartSec(kfpClamp(v, 0, maxStart))}
                />
              </div>
              <button
                type="button"
                className={`ve-kfp-btn${playheadSec != null && Math.abs(playheadSec - start) < 0.005 ? ' primary' : ''}`}
                disabled={playheadSec == null}
                title={playheadSec == null ? 'Playhead is not over this layer' : 'Start at the playhead'}
                onClick={() => playheadSec != null && setStartSec(kfpClamp(playheadSec, 0, maxStart))}
              >
                Playhead
              </button>
              <button type="button" className="ve-kfp-btn" onClick={() => setStartSec(0)}>Layer start</button>
              <button type="button" className="ve-kfp-btn" onClick={() => setStartSec(maxStart)}>Layer end</button>
            </div>
          )}

          <div className="ve-kfp-row">
            <span className="ve-kfp-rowlabel">Length</span>
            {KFP_LENGTHS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`ve-kfp-chip${lengthMode === opt.id ? ' active' : ''}`}
                disabled={!hasTimeline && opt.id !== 'whole'}
                onClick={() => changeLength(opt.id)}
              >
                {opt.label}
              </button>
            ))}
            {hasTimeline && (
              <div className="ve-kfp-num">
                <NumberField
                  value={lengthSec}
                  step={0.1}
                  precision={2}
                  min={0.05}
                  max={duration}
                  suffix="s"
                  title="How long the animation runs"
                  onInput={(v) => {
                    setCustomLength(kfpClamp(v, 0.05, duration));
                    setLengthMode('custom');
                  }}
                />
              </div>
            )}
          </div>
        </div>

        <div className="ve-kfp-foot">
          <span className="ve-kfp-readout-foot">{footLabel}</span>
          <div className="ve-kfp-spacer" />
          <button type="button" className="ve-kf-cancel-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="ve-kf-apply-btn" disabled={!selected} onClick={() => applySelected()}>
            Add Keyframes<i aria-hidden="true">⏎</i>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
