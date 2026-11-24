// Camera Motion preset modal — big live previews for CAMERA_MOTION_PRESETS.
//
// Reuses the keyframe-preset modal skeleton (.ve-kfp-*, the Graphite surface) with
// a 3-column wall of animated viewports instead of list rows. Each preview is ONE
// white rounded object on a flat ground (the approved look-dev scene — see
// html/camera-motion-presets-modal.html) driven by the preset's real cam* keyframe
// tracks: the scene gets the camera's inverse transform, so a camera pan right
// slides the object left, a dolly translates it in Z under a CSS perspective, and
// zoom scales it. Previews run outside React state on one rAF clock — per-frame
// work writes DOM styles through refs, the Player convention for playhead-rate
// updates.
//
// Apply hands back { keyframes, base } in the CAMERA_PRESETS common shape;
// CameraPanel owns the conversion to property tracks and the one atomic update.
// Applying NEVER resizes the camera clip — positions are 0–100% of the clip, so
// a move simply spreads across whatever length the clip already has.
//
// The user's saved presets (the API catalog CameraPanel loads) surface here as a
// "Saved" category with the same live previews, replacing the retired popover.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TransitionEasing } from './types';
import { bezierEase } from './easingEngine';
import { namedEase, playedEase } from './appEases';
import { TrashIcon } from './Icons';
import {
  CAMERA_MOTION_PRESETS,
  CAMERA_MOTION_CATEGORIES,
  evalMotionPose,
} from './cameraMotionPresets';

// ── easing resolution ──
// The curve the editor plays for that name (appEases.js); a CUSTOM segment plays
// its own handles through the editor's bezierEase. Unknown names play Smooth.

const easeFnCache = new Map();
// `bezier` is the low key's own handles — only a CUSTOM segment has them, and they
// key the cache separately so two hand-shaped segments don't share one function.
function easeFnFor(easing, bezier) {
  const custom = easing === TransitionEasing.CUSTOM && Array.isArray(bezier) && bezier.length === 4;
  const cacheKey = custom ? `${easing}:${bezier.join(',')}` : easing;
  if (easeFnCache.has(cacheKey)) return easeFnCache.get(cacheKey);
  let fn;
  if (custom) fn = bezierEase(...bezier);
  else fn = namedEase(easing) || playedEase(TransitionEasing.EASE_IN_OUT);
  easeFnCache.set(cacheKey, fn);
  return fn;
}

// ── the ease-override row ──
// "Preset" keeps each key's authored easing; anything else rewrites every key,
// except HOLD keys — overriding a cut into an interpolation would change what the
// preset IS (Step Zoom would stop being cuts), not how it feels.
const EASE_OVERRIDES = [
  { id: 'preset', label: 'Preset', easing: null },
  { id: 'linear', label: 'Linear', easing: TransitionEasing.LINEAR },
  { id: 'smooth', label: 'Smooth', easing: TransitionEasing.EASE_IN_OUT },
  { id: 'ae', label: 'AE Smooth', easing: TransitionEasing.AE_SMOOTH },
  { id: 'snappy', label: 'Snappy', easing: TransitionEasing.EXPO_OUT },
  { id: 'back', label: 'Back', easing: TransitionEasing.BACK_OUT },
];

const PREVIEW_HOLD_MS = 900; // parked on the last frame before replaying

function applyEaseOverride(keyframes, easing) {
  if (!easing) return keyframes;
  return keyframes.map((kf) => {
    if (kf.easing === TransitionEasing.HOLD) return kf;
    // The override replaces a CUSTOM segment, so its handles must go with it —
    // leaving them behind writes a dead `bezier` into the user's project.
    const next = { ...kf, easing };
    delete next.bezier;
    return next;
  });
}

// Dolly → CSS Z. Below 300 dolly (every other preset's whole range) this is exactly
// the historical 0.3×, so the approved previews are untouched. Punch Through runs to
// 2600, which at 0.3× would be 780px — past the viewport's own `perspective: 480px`,
// where the browser culls the subject instead of blasting it past the lens. Above the
// knee the surplus compresses onto an asymptote just short of the eye, so the punch
// still overruns the frame the way the real render does.
function dollyZ(dolly) {
  const z = dolly * 0.3;
  if (z <= 90) return z;
  return 90 + 340 * (1 - Math.exp(-(z - 90) / 200));
}

// Camera inverse → CSS transform for one preview. W/H is the viewport box.
function poseTransform(pose, W, H) {
  const n = (v, d = 0) => (Number.isFinite(v) ? v : d);
  const tx = (-n(pose.camX) / 100) * W;
  const ty = (n(pose.camY) / 100) * H;
  const tz = dollyZ(n(pose.camDolly));
  return (
    `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, ${tz.toFixed(2)}px) ` +
    `rotateX(${n(pose.camTiltX).toFixed(3)}deg) rotateY(${(-n(pose.camTiltY)).toFixed(3)}deg) ` +
    `rotateZ(${(-n(pose.camRoll)).toFixed(3)}deg) scale(${n(pose.camZoom, 1).toFixed(4)})`
  );
}

// The preview subject sits at the depth the Focus presets call "near" (1350) —
// racking focus away from it defocuses the white object, which is the whole
// story a DOF preset has to tell at tile size.
function poseBlur(pose) {
  if (!(Number.isFinite(pose.camDofEnabled) && pose.camDofEnabled >= 0.5)) return 0;
  const fd = Number.isFinite(pose.camFocusDistance) ? pose.camFocusDistance : 1350;
  const level = Number.isFinite(pose.camBlurLevel) ? pose.camBlurLevel / 100 : 1;
  return Math.min(5, (Math.abs(fd - 1350) / 350) * level);
}

export default function CameraMotionModal({ open, customPresets = [], onDeleteCustom, onApply, onClose }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [selectedId, setSelectedId] = useState(CAMERA_MOTION_PRESETS[0].id);
  const [easeOverride, setEaseOverride] = useState('preset');

  // Per-card animation state, outside React: { rig, obj, bar, t0 } keyed by id.
  const cardsRef = useRef(new Map());
  const wallRef = useRef(null);

  // Saved presets join the catalog as their own category, previews included —
  // their keyframes are the same common-snapshot shape (cameraItemToPreset).
  const allPresets = useMemo(() => [
    ...CAMERA_MOTION_PRESETS,
    ...customPresets.map((p) => ({
      id: `custom-${p.id}`,
      rawId: p.id,
      custom: true,
      category: 'Saved',
      name: p.name || 'Saved preset',
      description: p.description || 'Your saved camera move',
      duration: Number.isFinite(Number(p.duration)) && Number(p.duration) > 0 ? Number(p.duration) : 3,
      easeLabel: 'Saved',
      keyframes: Array.isArray(p.keyframes) ? p.keyframes : [],
      base: p.base || null,
    })),
  ], [customPresets]);

  const selected = useMemo(
    () => allPresets.find((p) => p.id === selectedId) || allPresets[0],
    [allPresets, selectedId]
  );

  // No reset-on-open effect: CameraPanel mounts this component fresh each time the
  // modal opens, so every useState above starts at its default. Preview clocks are
  // staggered in the rig ref callback for the same reason.

  const chipCategories = useMemo(() => [
    'All',
    ...CAMERA_MOTION_CATEGORIES,
    ...(customPresets.length ? ['Saved'] : []),
  ], [customPresets.length]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allPresets.filter((p) => {
      if (category !== 'All' && p.category !== category) return false;
      if (!q) return true;
      return `${p.name} ${p.description} ${p.category}`.toLowerCase().includes(q);
    });
  }, [allPresets, category, query]);

  // One clock for every visible preview.
  useEffect(() => {
    if (!open) return undefined;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    let raf = 0;
    const tick = (now) => {
      for (const preset of visible) {
        const card = cardsRef.current.get(preset.id);
        if (!card?.rig || preset.keyframes.length < 2) continue;
        if (!card.t0) card.t0 = now;
        const durMs = preset.duration * 1000;
        let t = (now - card.t0) / durMs;
        if (t > 1 + PREVIEW_HOLD_MS / durMs) { card.t0 = now; t = 0; }
        t = Math.max(0, Math.min(1, t));
        const box = card.rig.parentElement;
        const pose = evalMotionPose(preset, reduced ? 0.5 : t, easeFnFor);
        card.rig.style.transform = poseTransform(pose, box.clientWidth || 344, box.clientHeight || 193);
        if (!card.obj) card.obj = card.rig.querySelector('.ve-cmm-obj');
        if (card.obj) {
          const blur = poseBlur(pose);
          card.obj.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : '';
        }
        if (card.bar) card.bar.style.width = `${(t * 100).toFixed(1)}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open, visible]);

  const selectPreset = useCallback((preset) => {
    setSelectedId(preset.id);
    setEaseOverride('preset');
    const card = cardsRef.current.get(preset.id);
    if (card) card.t0 = performance.now(); // replay on select
  }, []);

  const handleApply = useCallback(() => {
    const override = EASE_OVERRIDES.find((e) => e.id === easeOverride)?.easing || null;
    const keyframes = applyEaseOverride(selected.keyframes, override);
    onApply?.({ preset: selected, keyframes, base: selected.base || null });
  }, [easeOverride, onApply, selected]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); }
      else if (e.key === 'Enter' && e.target.tagName !== 'INPUT') handleApply();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [handleApply, onClose, open]);

  if (!open) return null;

  // A property is "motion" when its value VARIES across the keys — a constant
  // value (Focus presets' aperture, a loop's fixed zoom) is setup, not motion.
  const animatedProps = (() => {
    const values = new Map();
    for (const kf of selected.keyframes) {
      for (const [prop, raw] of Object.entries(kf.properties || {})) {
        if (!values.has(prop)) values.set(prop, new Set());
        values.get(prop).add(String(raw));
      }
    }
    const names = {
      camZoom: 'zoom', camX: 'pan x', camY: 'pan y', camRoll: 'roll',
      camDolly: 'dolly', camTiltX: 'tilt x', camTiltY: 'tilt y',
      camFocusDistance: 'focus', camFocusX: 'focus pt', camFocusY: 'focus pt',
      camAperture: 'aperture', camBlurLevel: 'blur', camHighlightGain: 'bloom',
      camFocusWidth: 'focus area', camDofEnabled: null,
    };
    const out = [];
    for (const [prop, set] of values) {
      const name = names[prop];
      if (set.size > 1 && name && !out.includes(name)) out.push(name);
    }
    return out.join(' + ');
  })();

  return (
    <div className="ve-kfp-overlay" onMouseDown={onClose}>
      <div className="ve-kfp-modal ve-cmm" onMouseDown={(e) => e.stopPropagation()}>

        <div className="ve-kfp-head">
          <span className="ve-kfp-title">Camera Motion</span>
          <span className="ve-kfp-spacer" />
          <button type="button" className="ve-kf-modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="ve-kfp-search">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            value={query}
            placeholder="Search camera moves…"
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="ve-kfp-chips">
          {chipCategories.map((cat) => {
            const count = cat === 'All'
              ? allPresets.length
              : allPresets.filter((p) => p.category === cat).length;
            return (
              <button
                type="button"
                key={cat}
                className={`ve-kfp-chip${category === cat ? ' active' : ''}`}
                onClick={() => setCategory(cat)}
              >
                {cat} <b>{count}</b>
              </button>
            );
          })}
        </div>

        <div className="ve-kfp-wall ve-cmm-wall" ref={wallRef}>
          {visible.map((preset, idx) => (
            <div
              key={preset.id}
              role="button"
              tabIndex={0}
              className={`ve-cmm-card${preset.id === selectedId ? ' active' : ''}`}
              onClick={() => selectPreset(preset)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectPreset(preset); } }}
              onMouseEnter={() => {
                const card = cardsRef.current.get(preset.id);
                if (card) card.t0 = performance.now();
              }}
            >
              <span className="ve-cmm-view">
                <span
                  className="ve-cmm-rig"
                  ref={(el) => {
                    const map = cardsRef.current;
                    if (el) {
                      const card = map.get(preset.id) || {};
                      card.rig = el;
                      card.obj = null;
                      // Stagger the ambient clocks so the wall doesn't move in lockstep.
                      if (!card.t0) card.t0 = performance.now() - idx * 700;
                      map.set(preset.id, card);
                    } else {
                      map.delete(preset.id);
                    }
                  }}
                >
                  <span className="ve-cmm-ground" />
                  <span className="ve-cmm-obj" />
                </span>
                <span className="ve-cmm-frame" aria-hidden />
                <span className="ve-cmm-progress">
                  <i ref={(el) => {
                    const card = cardsRef.current.get(preset.id);
                    if (card) card.bar = el;
                  }}
                  />
                </span>
              </span>
              <span className="ve-cmm-meta">
                <span className="ve-cmm-name">{preset.name}</span>
                <span className="ve-cmm-tags">
                  <span className="ve-cmm-tag">{preset.duration.toFixed(1).replace(/\.0$/, '')}s</span>
                  <span className={`ve-cmm-tag ease${preset.easeLabel === 'Linear' ? ' linear' : ''}`}>{preset.easeLabel}</span>
                  <span className="ve-cmm-tag cat">{preset.category}</span>
                </span>
              </span>
              <span className="ve-cmm-desc">{preset.description}</span>
              {preset.custom && onDeleteCustom && (
                <button
                  type="button"
                  className="ve-cmm-delete"
                  title="Delete this saved preset"
                  onClick={(e) => { e.stopPropagation(); onDeleteCustom(preset.rawId); }}
                >
                  <TrashIcon style={{ width: 10, height: 10 }} />
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="ve-kfp-when">
          <div className="ve-kfp-row">
            <span className="ve-kfp-rowlabel">Ease</span>
            {EASE_OVERRIDES.map((e) => (
              <button
                type="button"
                key={e.id}
                className={`ve-kfp-chip${easeOverride === e.id ? ' active' : ''}`}
                onClick={() => setEaseOverride(e.id)}
              >
                {e.label}
              </button>
            ))}
            <span className="ve-kfp-hint">the move spreads across the clip&rsquo;s current length</span>
          </div>
        </div>

        <div className="ve-kfp-foot">
          <span className="ve-kfp-readout-foot">
            {selected.name} · {selected.duration.toFixed(2)}s · {selected.keyframes.length} keyframes · {animatedProps} · {selected.easeLabel}
          </span>
          <button type="button" className="ve-kf-cancel-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="ve-kf-apply-btn" onClick={handleApply}>Apply<i>⏎</i></button>
        </div>

      </div>
    </div>
  );
}
