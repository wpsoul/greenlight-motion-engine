// Advanced Animations ▸ Presets — the keyframe preset modal's layout (the
// shared .ve-kfp-* shell: search, category chips, a wall of live tiles, a tuning band,
// Cancel / Add) for the textAnimatorPresets catalogue. Every tile plays the preset with
// the real engine (textAnimatorPreview.js); the band previews it on the layer's own
// text with the timing the user picks. Applying is presetPatch() — one updateItem.
// Classic groups = the retired Text Animation presets as animators (the generated
// textAnimatorClassicPresets.js). Voice presets speak the tile text with a made-up
// voice; on the layer they follow the caption's word times.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NumberField } from './Fields';
import { CATEGORIES, PRESETS, presetSpan, isTimed, build, fakeVoice, usesVoice, hasExit, withExit } from './textAnimatorPresets';
import { CLASSIC_PRESETS, CLASSIC_CATEGORIES } from './textAnimatorClassicPresets';
import { presetPatch } from './textAnimatorPresetPatch';
import { drawPreviewFrame } from './textAnimatorPreview';

const SIDE_LABEL = { in: 'IN', out: 'OUT', inOut: 'IN·OUT', once: 'ONCE', loop: 'LOOP' };
const SIDE_TITLE = { in: 'Entrance', out: 'Exit at the end of the layer', inOut: 'Entrance, and an exit that ends with the layer', once: 'Plays once near the start', loop: 'Runs for the whole layer' };
const TILE_TEXT = 'Text in motion';
const CYCLE = 3.2;
const SPEEDS = [['0.5×', 0.5], ['1×', 1], ['1.5×', 1.5], ['2×', 2]];

// Dark ink vanishes on the near-black viewport, so the tiles and band switch to a light
// one (CSS only, nothing is drawn differently). Average WCAG luminance of the colours in
// the layer's colour string (gradients too); below 0.18 the light viewport has more contrast.
const prefersLightView = (css) => {
  const lum = [];
  for (const m of String(css || '').matchAll(/#([0-9a-f]{3,8})\b|rgba?\(([^)]*)\)/gi)) {
    let rgb;
    if (m[1]) {
      const h = m[1].length < 6 ? [...m[1].slice(0, 3)].map((c) => c + c).join('') : m[1];
      rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    } else rgb = m[2].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
    if (rgb.length < 3 || rgb.some((v) => !Number.isFinite(v))) continue;
    const [r, g, b] = rgb.map((v) => { const c = Math.min(255, Math.max(0, v)) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    lum.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  return lum.length > 0 && lum.reduce((a, v) => a + v, 0) / lum.length < 0.18;
};

export default function TextAnimatorPresetModal({ item, fontFamily, fontWeight, textColor, fontPx, clipSec, onApply, onClose }) {
  const { ALL, CATS, CAT_NAME } = useMemo(() => {
    const cats = [...CATEGORIES, ...CLASSIC_CATEGORIES];
    return { ALL: [...PRESETS, ...CLASSIC_PRESETS], CATS: cats, CAT_NAME: Object.fromEntries(cats.map((c) => [c.id, c.name])) };
  }, []);
  const hasTimings = Array.isArray(item?.textWordTimings) && item.textWordTimings.length > 0;
  const [query, setQuery] = useState('');
  // A caption (spoken word times) opens on the Voice presets.
  const [category, setCategory] = useState(hasTimings ? 'voice' : 'all');
  const [selectedId, setSelectedId] = useState((hasTimings ? PRESETS.find(usesVoice) : null)?.id || PRESETS[0].id);
  const [duration, setDuration] = useState(null);
  const [speed, setSpeed] = useState(1);
  const [exit, setExit] = useState(false);
  const hasAnimators = Array.isArray(item?.textAnimators) && item.textAnimators.length > 0;
  const [mode, setMode] = useState('replace');
  const view = useMemo(() => (prefersLightView(textColor) ? ' light' : ''), [textColor]);
  const wallRef = useRef(null);
  const bandRef = useRef(null);
  const tileRefs = useRef(new Map());
  const visibleTiles = useRef(new Set());

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ALL.filter((p) => (category === 'all' || p.cat === category)
      && (!q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)));
  }, [ALL, query, category]);
  const countFor = (id) => (id === 'all' ? ALL.length : ALL.filter((p) => p.cat === id).length);
  const picked = ALL.find((p) => p.id === selectedId) || null;
  // Exit: an entrance-only preset gains a fade-out that ends with the layer (seconds
  // from the end, so trimming never stretches it).
  const canExit = !!picked && picked.sides !== 'loop' && picked.sides !== 'out' && !hasExit(picked);
  const selected = picked && exit && canExit ? withExit(picked) : picked;
  const span = selected ? presetSpan(selected) : 0;
  const timed = selected ? isTimed(selected) : false;
  const effDuration = timed ? Math.min(duration ?? span, Math.max(0.2, clipSec)) : 0;

  const apply = (pick) => {
    const target = pick || selected;
    if (!target) return;
    // A double-clicked tile that is not the selected one applies with its own timing.
    const own = target === selected;
    onApply({
      ...presetPatch(item, target, {
        clipSec, fontPx,
        duration: own && isTimed(target) ? duration : null,
        speed: own ? speed : 1,
        mode,
      }),
      // A Classic preset's caption bar / Randomizer, as the regular preset writes them.
      ...(target.layerProps || null),
    });
    onClose();
  };

  // Keyboard: Esc closes, Enter applies, ↑/↓ move through the visible list.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === 'Enter') {
        if (!selected || e.target?.closest?.('.ve-kfp-when input')) return;
        e.preventDefault();
        apply();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (!visible.length) return;
      e.preventDefault();
      const at = visible.findIndex((p) => p.id === selectedId);
      const next = e.key === 'ArrowDown' ? Math.min(visible.length - 1, at + 1) : (at < 0 ? visible.length - 1 : Math.max(0, at - 1));
      setSelectedId(visible[next].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    wallRef.current?.querySelector(`[data-preset-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  // Only tiles on screen are drawn.
  useEffect(() => {
    const root = wallRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const id = en.target.dataset.presetId;
        if (en.isIntersecting) visibleTiles.current.add(id); else visibleTiles.current.delete(id);
      }
    }, { root, rootMargin: '40px' });
    for (const el of root.querySelectorAll('[data-preset-id]')) io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  // One loop for every preview: tiles on a fixed sample (or the preset's own `tile`
  // text, when it needs two rows to show), the band on the layer's text.
  const bandState = useRef({});
  useEffect(() => { bandState.current = { selected, effDuration, timed, speed }; });
  useEffect(() => {
    const family = fontFamily || 'Inter, sans-serif';
    const weight = fontWeight || 700;
    const tileBuilds = new Map();
    const layerText = String(item?.textContent || 'Advanced Animations').split('\n').slice(0, 2).map((r) => r.slice(0, 40)).join('\n');
    let bandKey = '';
    let bandBuild = null;
    let bandCycle = CYCLE;
    let raf = 0;
    const t0 = performance.now();
    const frame = (now) => {
      const sec = (now - t0) / 1000;
      ALL.forEach((p, i) => {
        if (!visibleTiles.current.has(p.id)) return;
        const cv = tileRefs.current.get(p.id);
        if (!cv) return;
        let tb = tileBuilds.get(p.id);
        const pct = (((sec / CYCLE) + ((i * 0.13) % 1)) % 1) * 100;
        const tileText = p.tile || TILE_TEXT;
        if (!tb) {
          // Built against the tile's own font size, so em sizes look right in it.
          const L = drawPreviewFrame(cv, { text: tileText, family, weight, color: textColor, built: null, pct: 0, clipSec: CYCLE });
          tb = { ...build(p, { clipSec: CYCLE, fontPx: L.size }), voiceWins: usesVoice(p) ? fakeVoice(tileText, { start: 0.25 }) : null };
          tileBuilds.set(p.id, tb);
        }
        drawPreviewFrame(cv, { text: tileText, family, weight, color: textColor, built: tb, pct, clipSec: CYCLE, voiceWins: tb.voiceWins });
      });
      const band = bandRef.current;
      const st = bandState.current;
      if (band && st.selected) {
        const key = `${st.selected.id}|${st.selected.animators.length}|${st.effDuration}|${st.speed}`;
        if (key !== bandKey) {
          bandKey = key;
          // A voice preset plays as long as the made-up voice takes to say the text.
          const said = usesVoice(st.selected) ? fakeVoice(layerText, { start: 0.25, rate: st.speed }) : null;
          bandCycle = st.timed ? Math.max(CYCLE, st.effDuration + 1.6) : CYCLE * 1.25;
          if (said && said.length) bandCycle = Math.max(bandCycle, said[said.length - 1].e + 1.2);
          const L = drawPreviewFrame(band, { text: layerText, family, weight, color: textColor, built: null, pct: 0, clipSec: bandCycle, maxSize: 46 });
          bandBuild = { ...build(st.selected, { clipSec: bandCycle, fontPx: L.size, duration: st.timed ? st.effDuration : null, speed: st.speed }), voiceWins: said };
        }
        drawPreviewFrame(band, { text: layerText, family, weight, color: textColor, built: bandBuild, pct: ((sec % bandCycle) / bandCycle) * 100, clipSec: bandCycle, maxSize: 46, voiceWins: bandBuild.voiceWins });
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [ALL, item, fontFamily, fontWeight, textColor]);

  const readout = () => {
    if (!selected) return 'Pick an animation';
    const parts = [selected.name, CAT_NAME[selected.cat]];
    if (usesVoice(selected)) parts.push(hasTimings ? 'on the spoken words' : 'no spoken word times here: runs on Time');
    if (exit && canExit) parts.push('with exit');
    if (timed) parts.push(`${effDuration.toFixed(2)} s ${selected.anchor === 'end' ? 'at the end' : 'from the start'}`);
    else if (speed !== 1) parts.push(`speed ${speed}×`);
    parts.push(`${selected.animators.length} animator${selected.animators.length === 1 ? '' : 's'}`);
    if (hasAnimators) parts.push(mode === 'add' ? 'added to yours' : 'replaces yours');
    return parts.join(' · ');
  };

  return createPortal(
    <div className="ve-kfp-overlay" onMouseDown={onClose}>
      <div className="ve-kfp-modal ve-txa-pm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ve-kfp-head">
          <span className="ve-kfp-title">Advanced Animation Preset</span>
          <div className="ve-kfp-spacer" />
          <button type="button" className="ve-kf-modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="ve-kfp-bar">
          <div className="ve-kfp-search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
            </svg>
            <input type="text" autoFocus placeholder="Search advanced animations…" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
          </div>
          <div className="ve-kfp-chips">
            {[{ id: 'all', name: 'All' }, ...CATS].map((cat) => (
              <button key={cat.id} type="button" className={`ve-kfp-chip${category === cat.id ? ' active' : ''}`} onClick={() => setCategory(cat.id)}>
                {cat.name}<b>{countFor(cat.id)}</b>
              </button>
            ))}
          </div>
        </div>

        <div className="ve-kfp-wall" ref={wallRef}>
          {visible.map((p) => (
            <button
              key={p.id}
              type="button"
              data-preset-id={p.id}
              className={`ve-kfp-tile${selectedId === p.id ? ' active' : ''}`}
              title={p.description}
              onClick={() => { setSelectedId(p.id); setDuration(null); }}
              onDoubleClick={() => apply(p.id === selectedId ? selected : p)}
            >
              <canvas
                className={`ve-kf-preset-preview ve-txa-pm-preview${view}`}
                ref={(el) => { if (el) tileRefs.current.set(p.id, el); else tileRefs.current.delete(p.id); }}
              />
              <span className="ve-kfp-tile-txt">
                <span className="ve-kfp-tile-name">{p.name}</span>
                <span className="ve-kfp-tile-desc">{p.description}</span>
              </span>
              <span className="ve-tap-sides" title={SIDE_TITLE[p.sides]}>
                <span className="ve-tap-side on">{SIDE_LABEL[p.sides]}</span>
              </span>
              <span className="ve-kfp-tile-cat">{CAT_NAME[p.cat]}</span>
            </button>
          ))}
          {visible.length === 0 && <div className="ve-kfp-empty">No animations match this filter.</div>}
        </div>

        <div className="ve-kfp-when">
          <div className="ve-kfp-row ve-kfp-when-head">
            <span className="ve-kfp-lbl">Preview &amp; Timing</span>
            {(duration != null || speed !== 1) && (
              <button type="button" className="ve-tap-reset" onClick={() => { setDuration(null); setSpeed(1); }}>Reset to preset</button>
            )}
            <div className="ve-kfp-spacer" />
            <span className="ve-kfp-hint">On your text</span>
          </div>
          <canvas ref={bandRef} className={`ve-txa-pm-band${view}`} />
          <div className="ve-kfp-row">
            <span className="ve-kfp-rowlabel">Timing</span>
            {timed ? (
              <>
                <span className="ve-kfp-hint">Duration</span>
                <div className="ve-kfp-num">
                  <NumberField
                    value={Number(effDuration.toFixed(2))}
                    step={0.05}
                    precision={2}
                    min={0.2}
                    max={Math.max(0.2, Math.min(10, clipSec))}
                    suffix="s"
                    title={selected?.anchor === 'end' ? 'How long the exit takes, ending with the layer' : 'How long the animation takes from the layer\'s start'}
                    onInput={(v) => setDuration(Math.max(0.2, Math.min(10, Number(v) || span)))}
                  />
                </div>
                <span className="ve-kfp-hint">{selected?.anchor === 'end' ? 'ends with the layer' : 'from the layer\'s start'}</span>
              </>
            ) : (
              <>
                <span className="ve-kfp-hint">Speed</span>
                {SPEEDS.map(([label, v]) => (
                  <button key={label} type="button" className={`ve-kfp-chip${speed === v ? ' active' : ''}`} onClick={() => setSpeed(v)}>{label}</button>
                ))}
              </>
            )}
          </div>
          <div className="ve-kfp-row">
            <span className="ve-kfp-rowlabel">Exit</span>
            <button type="button" className={`ve-kfp-chip${!exit || !canExit ? ' active' : ''}`} disabled={!canExit} onClick={() => setExit(false)}>None</button>
            <button type="button" className={`ve-kfp-chip${exit && canExit ? ' active' : ''}`} disabled={!canExit} onClick={() => setExit(true)}>Fade out</button>
            <span className="ve-kfp-hint">{canExit ? 'Units fade out as the layer ends' : picked && hasExit(picked) ? 'This preset has its own exit' : 'Runs for the whole layer'}</span>
          </div>
          <div className="ve-kfp-row">
            <span className="ve-kfp-rowlabel">Apply</span>
            <button type="button" className={`ve-kfp-chip${mode === 'replace' ? ' active' : ''}`} onClick={() => setMode('replace')}>Replace</button>
            <button type="button" className={`ve-kfp-chip${mode === 'add' ? ' active' : ''}`} disabled={!hasAnimators} onClick={() => setMode('add')}>Add to mine</button>
            <span className="ve-kfp-hint">{hasAnimators ? (mode === 'add' ? 'Kept, the preset is added after them' : 'This layer\'s animators are replaced') : 'This layer has no animators yet'}</span>
          </div>
        </div>

        <div className="ve-kfp-foot">
          <span className="ve-kfp-readout-foot">{readout()}</span>
          <div className="ve-kfp-spacer" />
          <button type="button" className="ve-kf-cancel-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="ve-kf-apply-btn" disabled={!selected} onClick={() => apply()}>
            Add Animation<i aria-hidden="true">⏎</i>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
