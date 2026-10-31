/*
 * GreenLight Motion Engine — the page a viewer opens (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 3).
 *
 *   GreenLightMotion.mountPage(el, { project, assets, theme });
 *
 * The GL Motion preview's "studio inspector" look (workflows/motion-film/templates/preview.html):
 * an app bar, the preview, a transport, a layer timeline, and an inspector with the options the
 * project's template offers (./template.js) and a Render panel (MP4, 30/60 fps, motion blur) that
 * slides in over it. A layer — clicked on the timeline or in the preview — opens its own options in
 * the inspector (text, colours, size, a picture, its place and length); on the timeline it moves and
 * trims by dragging. Everything else is full editing: "Open in GreenLight Dash" hands the project, with
 * the changes made here, to the app (./pageEdits.js). An agent never writes UI.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { EngineCanvas } from './EngineCanvas';
import { useVideoEditorStore } from '../components/videoEditor/videoEditorStore';
import { getTimelineLayout } from '../components/videoEditor/speedUtils';
import { waitForMediaReady } from '../components/videoEditor/renderWarmup';
import { applyTemplateValues, fieldValues } from './template';
import { createResolver, resolveProject, setActiveResolver, missingAssets } from './assets';
import { toEngineProject } from './normalize';
import { mixProject, hasSound, hasSoundEffects } from './mix';
import { activeLayers } from '../components/videoEditor/PreviewTransformOverlay';
import { TransitionType, LayerTransitionType } from '../components/videoEditor/types';
import { createRenderCacheController } from '../components/videoEditor/renderCacheController';
import { renderCacheGlobalKey, RENDER_CACHE_MIN_FPS } from '../components/videoEditor/renderCache';
import { KEYFRAME_PRESETS, KFP_CATEGORIES, KFP_DEFAULT_LENGTH, kfpVariants, resolvePresetVariant, applyKeyframePreset } from '../components/videoEditor/keyframePresetCatalog';
import { DIRECTION_LABEL } from '../components/videoEditor/presetDirections';
import { CATEGORIES as TEXT_CATEGORIES, PRESETS as TEXT_PRESETS } from '../components/videoEditor/textAnimatorPresets';
import { presetPatch } from '../components/videoEditor/textAnimatorPresetPatch';
import TextAnimatorPresetModal from '../components/videoEditor/TextAnimatorPresetModal';
import VEKeyframePresetModal from '../components/videoEditor/KeyframePresetModal';
import { TransitionPresetModal, TRANSITION_SLOT_FIELDS } from '../components/videoEditor/TransitionPicker';
import editorModalCss from 'virtual:editor-modal-css';
import {
  applyItemEdits, applyTiming, mergeTiming, retime, limitsFor, editsToOps, hasEdits, bakeForExport, glvideoFile,
  getPath, EMPTY_TIMING, MIN_LENGTH,
} from './pageEdits';
import { ReviewLayer } from './ReviewLayer';
import { ReviewBar, NoteComposer, NotesSection } from './ReviewUI';
import { useReview } from './useReview';
import { REVIEW_TOOLS } from './reviewNotes';
import './playerPage.css';

// The editor's own preset windows (text animation, entrance / exit, transitions) open here too, with their live
// previews. Their styles are the rules of videoEditor.css they use, cut out by the engine build
// (vite.motion-engine.config.js), put on the page once.
if (typeof document !== 'undefined' && !document.querySelector('style[data-glm-editor-modals]')) {
  const style = document.createElement('style');
  style.setAttribute('data-glm-editor-modals', '');
  style.textContent = editorModalCss;
  document.head.appendChild(style);
}

// What a layer already carries, whoever put it there (the project, an agent, the editor). A text preset is known by
// the names presetPatch gives its animators: the preset whose animators include all of the layer's, the closest first
// (a project may keep only a preset's entrance). Unknown animators read as a count.
let textPresetSigs = null;
function textPresetName(item) {
  const names = (item?.textAnimators || []).map((a) => a?.name).filter(Boolean);
  if (!names.length) return null;
  textPresetSigs ||= TEXT_PRESETS.map((p) => {
    try { return { name: p.name, names: presetPatch({ textContent: 'Text', textFontSize: 100 }, p, { clipSec: 4, fontPx: 100, mode: 'replace' }).textAnimators.map((a) => a.name) }; } catch { return null; }
  }).filter(Boolean);
  let best = null;
  for (const sig of textPresetSigs) {
    if (!names.every((n) => sig.names.includes(n))) continue;
    if (!best || names.length / sig.names.length > names.length / best.names.length) best = sig;
  }
  return best ? best.name : `${names.length} text animator${names.length === 1 ? '' : 's'}`;
}
// Keyframes on a moving / fading track in the layer's first (or last) stretch are its own entrance (or exit).
const MOTION_TRACKS = ['opacity', 'scale', 'scaleX', 'scaleY', 'translateX', 'translateY', 'xPercent', 'yPercent', 'rotate', 'rotateX', 'rotateY', 'blur'];
function keyframedAt(item, side) {
  const pk = item?.propertyKeyframes || {};
  return MOTION_TRACKS.some((k) => {
    const pos = (Array.isArray(pk[k]) ? pk[k] : []).map((x) => Number(x?.position)).filter(Number.isFinite);
    if (pos.length < 2) return false;
    return side === 'in' ? Math.min(...pos) <= 15 : Math.max(...pos) >= 85;
  });
}

const noop = () => {};
const GET_APP_URL = 'https://greenlightdash.pro/';
// A page opened from a file can hand GreenLight Dash its own path (desktop deep-links.js →
// greenlightdash://open?path=…; the app imports the folder, or the one-file page itself).
const OPEN_IN_APP = (() => {
  if (typeof location === 'undefined' || location.protocol !== 'file:') return null;
  let p = decodeURIComponent(location.pathname);
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);   // Windows: /C:/… → C:/…
  return `greenlightdash://open?path=${encodeURIComponent(p)}`;
})();
const FRAME = 1 / 30;

// Every layer on the timeline, in the editor's order (one row per channel), with its place in time.
function layersOf(channels, clips) {
  const byId = new Map((clips || []).map((c) => [c.id, c]));
  const rows = [];
  let end = 0;
  for (const ch of channels || []) {
    if (!ch?.items?.length || ch.visible === false) continue;
    const layout = getTimelineLayout(ch.items, { unsnapped: ch.unsnapped });
    const row = { id: ch.id, layers: [] };
    ch.items.forEach((item, i) => {
      const at = layout[i];
      if (!at) return;
      end = Math.max(end, at.endTime);
      const clip = byId.get(item.clipId) || null;
      const type = clip?.mediaType || item.mediaType || 'layer';
      const text = typeof item.textContent === 'string' ? item.textContent.replace(/\s+/g, ' ').trim() : '';
      row.layers.push({
        id: item.id,
        type,
        name: item.name || clip?.name || (text ? text.slice(0, 48) : TYPE_LABEL[type] || 'Layer'),
        start: at.startTime,
        end: at.endTime,
        appOnly: APP_ONLY[type] || null,
        clipId: item.clipId,
        // a sound cue's layer is placed by its cue (soundCues.js): it follows the layer it is cued on
        locked: String(item.id).startsWith('sfx-cue-'),
        // the cross transition INTO this layer from the one before it on the row (the overlap the layout made)
        prevId: i > 0 ? ch.items[i - 1]?.id || null : null,
        overlapIn: at.overlapIn || 0,
        touchingPrev: Boolean(at.touchingPrev) && i > 0,
        transition: item.transition && item.transition !== TransitionType.NONE ? item.transition : null,
        transIn: item.transitionInType && item.transitionInType !== LayerTransitionType.NONE ? item.transitionInType : null,
        transOut: item.transitionOutType && item.transitionOutType !== LayerTransitionType.NONE ? item.transitionOutType : null,
      });
    });
    if (row.layers.length) rows.push(row);
  }
  return { rows, duration: end };
}

// Layers the engine keeps as data and does not draw: they play in GreenLight Dash only.
const APP_ONLY = { motion: 'MotionFast template', ae: 'After Effects clip', 'after-effects': 'After Effects clip' };

const TYPE_LABEL = {
  text: 'Text', shape: 'Shape', image: 'Picture', video: 'Video', audio: 'Sound', camera: 'Camera', model3d: '3D model',
  particles: 'Particles', adjustment: 'Adjustment', sequence: 'Sequence', null: 'Null', html: 'HTML', motion: 'Motion',
};

const clock = (t, digits = 1) => {
  const s = Math.max(0, t || 0);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(digits).padStart(digits ? 3 + digits : 2, '0')}`;
};
const seconds = (t) => `${(Math.round((t || 0) * 10) / 10).toFixed(1)} s`;
const slug = (s) => String(s || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'video';
const sizeLabel = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// A file the viewer keeps: a Claude artifact must go through its downloads capability (it may not
// start a download itself); a double-clicked or hosted page uses a plain link.
async function saveFile(blob, filename) {
  const downloads = await window.claude?.use?.('downloads');
  if (downloads) return downloads.save({ filename, data: blob });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return undefined;
}

const Icon = {
  play: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4.5 2.6v10.8a.8.8 0 0 0 1.22.68l8.6-5.4a.8.8 0 0 0 0-1.36l-8.6-5.4A.8.8 0 0 0 4.5 2.6z" /></svg>,
  pause: <svg viewBox="0 0 16 16" aria-hidden="true"><rect fill="currentColor" x="3.5" y="2.5" width="3.2" height="11" rx="1" /><rect fill="currentColor" x="9.3" y="2.5" width="3.2" height="11" rx="1" /></svg>,
  prev: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" d="M10 3.5 5.5 8l4.5 4.5" /></svg>,
  next: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" d="M6 3.5 10.5 8 6 12.5" /></svg>,
  loop: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" d="M3 7.5V7a3 3 0 0 1 3-3h6.5M10.5 2l2 2-2 2M13 8.5V9a3 3 0 0 1-3 3H3.5M5.5 14l-2-2 2-2" /></svg>,
  film: <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path fill="currentColor" d="M6.8 6.1v3.8L10 8z" /></svg>,
  back: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" d="M10 3.5 5.5 8l4.5 4.5" /></svg>,
  close: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="m4 4 8 8M12 4l-8 8" /></svg>,
  chat: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2H7l-3 2.5v-2.5h0a1.5 1.5 0 0 1-1.5-1.5z" /></svg>,
  app: <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M2.5 6h11M5 9h4M5 11h6" /></svg>,
  copy: <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" /><path fill="none" stroke="currentColor" strokeWidth="1.4" d="M10.5 3.5v-.3A1.2 1.2 0 0 0 9.3 2H3.7A1.2 1.2 0 0 0 2.5 3.2v5.6A1.2 1.2 0 0 0 3.7 10h.3" /></svg>,
  save: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M3 13.5h10" /></svg>,
  arrow: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" d="M5 11 11 5M6 5h5v5" /></svg>,
  note: <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" d="M10.6 2.6 13.4 5.4 6 12.8l-3.5.7.7-3.5zM9.2 4l2.8 2.8" /></svg>,
};

/* ── options ─────────────────────────────────────────────────────────────────────────────────────── */

function Field({ field, value, onChange }) {
  const id = `glm-field-${field.key}`;
  const label = field.label || field.key;
  if (field.type === 'choose') {
    return (
      <div className="glm-field">
        <span className="glm-l"><span>{label}</span></span>
        <div className="glm-c glm-anim"><span>{value || 'None'}</span>
          <button type="button" className="glm-btn" data-choose={field.key} onClick={field.open}>Choose…</button></div>
      </div>
    );
  }
  let control;
  if (field.type === 'color') {
    const hex = /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#000000';
    control = (
      <label className="glm-color">
        <i style={{ background: value || hex }} />
        <input id={id} type="color" value={hex} onChange={(e) => onChange(e.target.value)} aria-label={label} />
        <span>{String(value || '').toUpperCase()}</span>
      </label>
    );
  } else if (field.type === 'image') {
    control = (
      <div className="glm-img">
        {value ? <i style={{ backgroundImage: `url("${value}")` }} /> : <i className="is-empty" />}
        <label className="glm-btn" htmlFor={id}>Choose…</label>
        <input id={id} type="file" accept="image/*" hidden aria-label={label} onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onChange(URL.createObjectURL(file));
          e.target.value = '';
        }} />
      </div>
    );
  } else if (field.type === 'number') {
    const n = Number(value);
    const min = field.min ?? 0;
    const max = field.max ?? 100;
    const v = Number.isFinite(n) ? n : min;
    control = (
      <div className="glm-slider">
        <input className="glm-range" type="range" min={min} max={max} step={field.step ?? 1} value={v} aria-label={label}
          style={{ '--p': `${((v - min) / Math.max(1e-9, max - min)) * 100}%` }} onChange={(e) => onChange(Number(e.target.value))} />
        <input id={id} className="glm-in glm-in-mini" type="number" min={field.min} max={field.max} step={field.step ?? 1}
          value={Number.isFinite(n) ? n : ''} aria-label={`${label} value`} onChange={(e) => onChange(Number(e.target.value))} />
      </div>
    );
  } else if (field.type === 'select') {
    control = (
      <select id={id} className="glm-select" value={value ?? ''} aria-label={label} onChange={(e) => onChange(e.target.value)}>
        {(field.options || []).map((o) => (
          <option key={String(o.value ?? o)} value={o.value ?? o}>{o.label ?? o.value ?? o}</option>
        ))}
      </select>
    );
  } else if (field.type === 'toggle') {
    control = (
      <button type="button" id={id} role="switch" aria-checked={Boolean(value)} aria-label={label} className="glm-switch" onClick={() => onChange(!value)}><u /></button>
    );
  } else if (String(value ?? '').length > 34 || field.multiline) {
    control = <textarea id={id} className="glm-in glm-area" rows={2} value={value ?? ''} aria-label={label} onChange={(e) => onChange(e.target.value)} />;
  } else {
    control = <input id={id} className="glm-in" type="text" value={value ?? ''} aria-label={label} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className={`glm-field${field.type === 'toggle' ? ' is-inline' : ''}`}>
      <label className="glm-l" htmlFor={id}><span>{label}</span></label>
      <div className="glm-c">{control}</div>
    </div>
  );
}

/* ── transport + timeline: both follow the transient playhead the Player publishes every frame
      (videoEditorStore), so only these small pieces re-render while it plays ─────────────────────── */

function useLiveTime(playing, currentTime) {
  const live = useVideoEditorStore((s) => s.playheadTime);
  return playing ? live : currentTime;
}

function Transport({ duration, playing, currentTime, onPlay, onStep, loop, onLoop, rows }) {
  const t = Math.min(useLiveTime(playing, currentTime) || 0, duration);
  const now = [];
  for (const row of rows) for (const l of row.layers) if (t >= l.start && t < l.end && now.length < 3) now.push(l.name);
  return (
    <div className="glm-transport">
      <div className="glm-tgroup">
        <button type="button" className="glm-play" onClick={onPlay} aria-keyshortcuts="Space">
          {playing ? Icon.pause : Icon.play}<span>{playing ? 'Pause' : 'Play'}</span>
        </button>
        <button type="button" className="glm-icon" onClick={() => onStep(-1)} aria-label="Previous frame" title="Previous frame (←) · Shift: 1 s back">{Icon.prev}</button>
        <button type="button" className="glm-icon" onClick={() => onStep(1)} aria-label="Next frame" title="Next frame (→) · Shift: 1 s on">{Icon.next}</button>
      </div>
      <div className="glm-time"><b>{clock(t, 2)}</b><span>/ {clock(duration, 2)}</span></div>
      <div className="glm-now">{now.length ? <><span>Now</span><b>{now.join(' · ')}</b></> : null}</div>
      <div className="glm-tgroup">
        <button type="button" className="glm-icon" aria-pressed={loop} onClick={onLoop} aria-label="Loop" title="Loop">{Icon.loop}<span>Loop</span></button>
      </div>
    </div>
  );
}

function rulerSteps(duration, width) {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const pxPerSec = width / Math.max(duration, 0.001);
  const major = steps.find((s) => s * pxPerSec >= 84) || steps[steps.length - 1];
  const minor = major / (major === 0.25 || major === 2.5 ? 5 : major >= 1 && major % 5 === 0 ? 5 : 4);
  return { major, minor };
}

function Playhead({ duration, playing, currentTime }) {
  const t = Math.min(useLiveTime(playing, currentTime) || 0, duration);
  const p = duration > 0 ? t / duration : 0;
  // A full-width layer moved by transform (compositor only); the line sits on its left edge.
  return <div className="glm-headtrack" style={{ transform: `translateX(${p * 100}%)` }}><div className="glm-head" /></div>;
}

// The seconds that played too slowly on this computer (below 25 fps): the editor's render-cache line over the ruler,
// measure-only here — the page renders nothing ahead, so a red second stays red until it plays fast enough.
function SlowLine({ meter, duration }) {
  const snap = useSyncExternalStore(meter.subscribe, meter.getSnapshot);
  const runs = (snap?.runs || []).filter((r) => r.state === 'slow');
  if (!runs.length) return null;
  return (
    <div className="glm-slow">
      {runs.map((r) => (
        <span key={r.t0} className="glm-slow-run" data-slow={`${r.t0}-${r.t1}`}
          style={{ left: `${(r.t0 / duration) * 100}%`, width: `${((r.t1 - r.t0) / duration) * 100}%` }}
          title={`Plays below ${RENDER_CACHE_MIN_FPS} fps on this computer (${clock(r.t0)}–${clock(r.t1)})`} />
      ))}
    </div>
  );
}

function Timeline({ rows, duration, playing, currentTime, onSeek, onSelect, selected, limitsOf, onDrag, onDragEnd, selectedTrans, onTransition, onAddTransition, flags = [], onFlag, meter = null }) {
  const barRef = useRef(null);
  const [width, setWidth] = useState(600);
  const [ghost, setGhost] = useState(null);
  const [drag, setDrag] = useState(false);
  const [moving, setMoving] = useState(null);   // the layer being dragged: { id, zone }
  // the scale stays put while a layer is dragged, or the timeline would rescale under the pointer
  const frozen = useRef(null);
  const D = frozen.current || duration;
  // the selected layer's row comes into view (a layer picked in the preview may sit on a row scrolled out of sight)
  const rowsRef = useRef(null);
  useEffect(() => {
    const box = rowsRef.current;
    const el = selected ? box?.querySelector(`[data-layer="${CSS.escape(selected)}"]`) : null;
    const row = el?.parentElement;
    if (!row) return;
    const top = row.offsetTop; const bottom = top + row.offsetHeight;
    if (top >= box.scrollTop && bottom <= box.scrollTop + box.clientHeight) return;
    const to = Math.max(0, top - (box.clientHeight - row.offsetHeight) / 2);
    box.scrollTo({ top: to, behavior: Math.abs(to - box.scrollTop) > box.clientHeight * 3 ? 'instant' : 'smooth' });
  }, [selected]);

  useEffect(() => {
    const el = barRef.current;
    if (!el) return undefined;
    // an observer reports the starting size too
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const timeAt = (clientX) => {
    const r = barRef.current.getBoundingClientRect();
    return Math.min(D, Math.max(0, ((clientX - r.left) / Math.max(1, r.width)) * D));
  };
  const onDown = (e) => {
    if (e.button !== 0 || e.target.closest('.glm-layer')) return;
    e.preventDefault();
    setDrag(true);
    onSeek(timeAt(e.clientX));
    const move = (ev) => onSeek(timeAt(ev.clientX));
    const up = () => { setDrag(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // A layer: drag its body to move it, an edge to trim it; a press that does not move selects it.
  // It snaps to the playhead and to the other layers' edges, and never runs into its neighbours on the
  // same row (one channel never overlaps itself) or past its source's own length.
  const onLayerDown = (e, l, zone) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = barRef.current.getBoundingClientRect();
    const pxPerSec = r.width / Math.max(1e-6, D);
    const lim = l.locked ? null : limitsOf(l.id);
    const x0 = e.clientX;
    const snaps = [0, currentTime];
    for (const row of rows) for (const o of row.layers) if (o.id !== l.id) snaps.push(o.start, o.end);
    const snap = (v) => {
      let best = v; let bestPx = 8;
      for (const s of snaps) { const px = Math.abs(s - v) * pxPerSec; if (px < bestPx) { bestPx = px; best = s; } }
      return best;
    };
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - x0;
      if (!lim || (!moved && Math.abs(dx) < 3)) return;
      if (!moved) { moved = true; frozen.current = D; setMoving({ id: l.id, zone }); }
      const dt = dx / pxPerSec;
      const len = l.end - l.start;
      let start = l.start; let end = l.end;
      if (zone === 'move') {
        start = l.start + dt;
        const a = snap(start); const b = snap(start + len);
        if (a !== start) start = a; else if (b !== start + len) start = b - len;
        start = Math.max(0, Math.min(Math.max(start, lim.minStart), lim.maxEnd - len));
        end = start + len;
      } else if (zone === 'left') {
        start = Math.min(Math.max(snap(l.start + dt), lim.minStart, l.start - lim.maxLeftOpen, 0), l.end - MIN_LENGTH);
      } else {
        end = Math.max(Math.min(snap(l.end + dt), lim.maxEnd, l.end + lim.maxRightOpen), l.start + MIN_LENGTH);
      }
      onDrag(l.id, { start, end, zone });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (moved) { frozen.current = null; setMoving(null); onDragEnd(l.id); } else onSelect(l);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const { major, minor } = rulerSteps(D, width);
  const ticks = [];
  for (let k = 0, s = 0; s <= D + 1e-6 && k < 2000; k += 1, s = k * minor) {
    const isMajor = Math.abs(s / major - Math.round(s / major)) < 1e-6;
    ticks.push(
      <div key={k} className={`glm-tick${isMajor ? ' is-major' : ''}`} style={{ left: `${(s / D) * 100}%` }}>
        {isMajor && s < D - 1e-6 ? <span>{major < 1 ? `${+s.toFixed(2)}s` : s >= 60 ? clock(s, 0) : `${Math.round(s)}s`}</span> : null}
      </div>,
    );
  }
  const t = playing ? null : currentTime;

  return (
    <div className="glm-tlwrap">
      <div
        ref={barRef}
        className={`glm-bar${drag ? ' is-drag' : ''}${moving ? ' is-moving' : ''}${ghost != null ? ' is-hover' : ''}`}
        role="slider"
        tabIndex={0}
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={Number(D.toFixed(3))}
        aria-valuenow={t == null ? undefined : Number(t.toFixed(3))}
        aria-valuetext={t == null ? 'playing' : clock(t, 2)}
        onPointerDown={onDown}
        onPointerMove={(e) => setGhost(timeAt(e.clientX))}
        onPointerLeave={() => setGhost(null)}
      >
        <div className="glm-ruler">{ticks}
          {meter && <SlowLine meter={meter} duration={D} />}
          {flags.map((f) => (
            <button key={f.key} type="button" className="glm-flag" data-flag={f.n} style={{ left: `${(f.t / D) * 100}%` }}
              title={`Note ${f.n} · ${clock(f.t, 2)}`} aria-label={`Note ${f.n} at ${clock(f.t, 2)}`}
              onPointerDown={(e) => e.stopPropagation()} onClick={() => onFlag?.(f)}>{f.n}</button>
          ))}
        </div>
        <div className="glm-rows" ref={rowsRef} style={{ '--rows': rows.length }}>
          {rows.map((row) => (
            <div key={row.id} className="glm-row">
              {row.layers.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  data-layer={l.id}
                  className={`glm-layer t-${l.type}${l.appOnly ? ' is-app-only' : ''}${l.locked ? ' is-locked' : ''}${selected === l.id ? ' is-on' : ''}${moving?.id === l.id ? ' is-moving' : ''}${l.overlapIn > 0 && l.transition ? ' has-xin' : ''}`}
                  // a cross transition INTO this layer: its name starts after the transition's band (as in GreenLight
                  // Dash's timeline) — a padding in % of the row, the layer's containing block
                  style={{ left: `${(l.start / D) * 100}%`, width: `${((l.end - l.start) / D) * 100}%`,
                    ...(l.overlapIn > 0 && l.transition ? { paddingLeft: `calc(${(l.overlapIn / D) * 100}% + 6px)` } : null) }}
                  aria-pressed={selected === l.id}
                  onPointerDown={(e) => onLayerDown(e, l, 'move')}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(l); } }}
                  title={`${l.name} · ${TYPE_LABEL[l.type] || l.type} · ${clock(l.start)}–${clock(l.end)}${l.appOnly ? ' · plays in GreenLight Dash only' : ''}${l.locked ? ' · follows its cue' : ''}`}
                >
                  {!l.locked && <b className="glm-trim is-l" onPointerDown={(e) => onLayerDown(e, l, 'left')} aria-hidden="true" />}
                  {l.transIn && <em className="glm-ramp is-in" title={`Entrance: ${l.transIn}`} />}
                  {l.transOut && <em className="glm-ramp is-out" title={`Exit: ${l.transOut}`} />}
                  <i /><span>{l.name}</span>
                  {!l.locked && <b className="glm-trim is-r" onPointerDown={(e) => onLayerDown(e, l, 'right')} aria-hidden="true" />}
                </button>
              ))}
              {row.layers.map((l) => (l.overlapIn > 0 && l.transition ? (
                <button key={`x-${l.id}`} type="button" data-trans={l.id}
                  className={`glm-xfade${selectedTrans === l.id ? ' is-on' : ''}`}
                  style={{ left: `${(l.start / D) * 100}%`, width: `${(l.overlapIn / D) * 100}%` }}
                  onPointerDown={(e) => { e.stopPropagation(); }}
                  onClick={() => onTransition(l)}
                  title={`${l.transition} · ${seconds(l.overlapIn)} · click to change`}
                  aria-label={`${l.transition}, ${seconds(l.overlapIn)}: change the transition`}>
                  <span>{l.transition}</span>
                </button>
              ) : (l.touchingPrev && !l.transition && !l.locked && l.type !== 'model3d' ? (
                <button key={`s-${l.id}`} type="button" className="glm-seam" data-seam={l.id}
                  style={{ left: `${(l.start / D) * 100}%` }}
                  onPointerDown={(e) => { e.stopPropagation(); }}
                  onClick={() => onAddTransition(l)} title="Add a transition here" aria-label="Add a transition here">+</button>
              ) : null)))}
            </div>
          ))}
        </div>
        {ghost != null && !moving && <div className="glm-ghost" style={{ left: `${(ghost / D) * 100}%` }}><span>{clock(ghost, 2)}</span></div>}
        <Playhead duration={D} playing={playing} currentTime={currentTime} />
      </div>
      <div className="glm-tlfoot">
        <div className="glm-keys"><span><kbd>Space</kbd> play</span><span><kbd>←</kbd><kbd>→</kbd> frame</span><span><kbd>Shift</kbd> 1 s</span></div>
        <span className="glm-tlnote">Click a layer or a transition to change it. Drag a layer to move it, an edge to trim it.</span>
      </div>
    </div>
  );
}

/* ── a layer's own options: what it shows, where it sits, and the way to full editing ───────────────── */

// The values a viewer may change on a layer, by kind. Everything else is full editing (GreenLight Dash).
const LAYER_FIELDS = {
  text: [
    { path: 'textContent', label: 'Text', type: 'text', multiline: true },
    { path: 'textColor', label: 'Colour', type: 'color' },
    { path: 'textFontSize', label: 'Size', type: 'number', min: 8, max: 600, step: 1 },
  ],
  shape: [{ path: 'shapeFillColor', label: 'Fill', type: 'color' }],
};
const SEEN = new Set(['text', 'shape', 'image', 'video', 'model3d', 'particles', 'sequence', 'html']);

function LayerPanel({ layer, controls, animations = [], edited, onReset, onBack, onOpenApp, title }) {
  const [copied, setCopied] = useState(false);
  const request = `In the video "${title}", please change the layer "${layer.name}" (${TYPE_LABEL[layer.type] || layer.type}, id "${layer.id}", ${clock(layer.start)}–${clock(layer.end)}): `;
  const copy = async () => {
    try { await navigator.clipboard.writeText(request); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <>
      <div className="glm-lhead">
        <button type="button" className="glm-icon" onClick={onBack} aria-label="Back to Options" title="Back to Options (Esc)">{Icon.back}</button>
        <div>
          <h2 id="glm-h-layer">{layer.name}</h2>
          <p>{TYPE_LABEL[layer.type] || layer.type} · {clock(layer.start)} – {clock(layer.end)}</p>
        </div>
      </div>
      <section className="glm-panel" aria-labelledby="glm-h-layer">
        {layer.locked && <p className="glm-sec glm-sub">This sound is placed by its cue: it follows the layer it is cued on, so move that layer and the sound moves with it.</p>}
        {layer.appOnly && <p className="glm-sec glm-sub">This layer is a {layer.appOnly}: it plays in GreenLight Dash only, so this page leaves it out.</p>}
        {controls.length > 0 && (
          <div className="glm-sec">
            <div className="glm-rows-f">{controls.map((c) => <Field key={c.key} field={c} value={c.value} onChange={c.set} />)}</div>
          </div>
        )}
        {animations.length > 0 && (
          <div className="glm-sec">
            <h3 className="glm-h">Animation</h3>
            <div className="glm-rows-f">
              {animations.map((a) => (
                <div key={a.key} className="glm-field">
                  <span className="glm-l"><span>{a.label}</span></span>
                  <div className="glm-c glm-anim"><span>{a.current || 'None'}</span>
                    <button type="button" className="glm-btn" data-anim={a.key} onClick={a.open}>Choose…</button></div>
                </div>
              ))}
            </div>
          </div>
        )}
        {edited && (
          <div className="glm-sec">
            <button type="button" className="glm-btn is-quiet" onClick={onReset}>Undo the changes to this layer</button>
          </div>
        )}
        <div className="glm-full">
          <span className="glm-glyph">{Icon.app}</span>
          <div>
            <b>For full editing, use GreenLight Dash</b>
            <span>Keyframes, animations, effects, the 3D camera and every other setting, on a real timeline. The project opens there with the changes you made here.</span>
            <div className="glm-way-actions">
              <button type="button" className="glm-btn" onClick={onOpenApp}>{Icon.app}Open in GreenLight Dash</button>
              <button type="button" className="glm-link-quiet" onClick={copy}>{copied ? 'Copied: paste it to your agent' : 'Or ask your agent'}</button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/* ── animation presets: the editor's own catalogues (keyframe presets, text animation presets) ───────────── */

// the owner's priority picks among the text presets (the engine skill's "Preferred" lists), shown first
/* ── a cross transition: which one, and how long ─────────────────────────────────────────────────────── */

function TransitionPanel({ layer, prevName, onChange, onChoose, onBack, onOpenApp }) {
  return (
    <>
      <div className="glm-lhead">
        <button type="button" className="glm-icon" onClick={onBack} aria-label="Back to Options" title="Back to Options (Esc)">{Icon.back}</button>
        <div>
          <h2 id="glm-h-trans">Transition</h2>
          <p>{prevName} → {layer.name} · {clock(layer.start)}</p>
        </div>
      </div>
      <section className="glm-panel" aria-labelledby="glm-h-trans">
        <div className="glm-sec">
          <div className="glm-rows-f">
            <Field field={{ key: 'glm-trans-type', label: 'Transition', type: 'choose', open: onChoose }}
              value={layer.transition && layer.transition !== TransitionType.NONE ? layer.transition : 'No transition (a cut)'} />
            <Field field={{ key: 'glm-trans-duration', label: 'Length', type: 'number', min: 0.1, max: 4, step: 0.05 }}
              value={Number(layer.overlapIn.toFixed(2))} onChange={(v) => onChange({ transitionDuration: Math.max(0.1, Number(v) || 0.1) })} />
          </div>
          <p className="glm-sub">The two clips overlap for its length. Pick another and the preview follows.</p>
        </div>
        <div className="glm-full">
          <span className="glm-glyph">{Icon.app}</span>
          <div>
            <b>For full editing, use GreenLight Dash</b>
            <span>Every transition's own options (direction, easing, colours, the custom builder) are in GreenLight Dash's transition window.</span>
            <div className="glm-way-actions">
              <button type="button" className="glm-btn" onClick={onOpenApp}>{Icon.app}Open in GreenLight Dash</button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/* ── Open in GreenLight Dash: one click from a page on disk; elsewhere a small file that carries it ──── */

function OpenInAppDialog({ title, direct, onSave, onClose }) {
  const [opening, setOpening] = useState('');   // '' | 'trying' | 'nothing'
  const [saved, setSaved] = useState(null);      // { name } | { error }
  const [busy, setBusy] = useState(false);
  const panelRef = useRef(null);
  // The app answers by taking focus; a page that still has it a moment later opened nothing.
  const tryOpen = () => {
    setOpening('trying');
    setTimeout(() => setOpening(document.hasFocus() ? 'nothing' : ''), 2200);
  };
  const save = async () => {
    setBusy(true);
    try { setSaved({ name: await onSave() }); } catch (e) { setSaved({ error: e?.code === 'declined' ? 'Saving was cancelled.' : `Could not save it: ${e?.message || e}` }); }
    setBusy(false);
  };
  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="glm-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="glm-modal" role="dialog" aria-modal="true" aria-labelledby="glm-open-h" tabIndex={-1} ref={panelRef}>
        <header>
          <div><h2 id="glm-open-h">Open in GreenLight Dash</h2><p>{title}</p></div>
          <button type="button" className="glm-icon" onClick={onClose} aria-label="Close">{Icon.close}</button>
        </header>
        <p className="glm-modal-lead">GreenLight Dash is the full editor this video was made with. The project opens there as a new video project, with the changes you made on this page.</p>
        <div className="glm-ways">
          {direct ? (
            <section className="glm-way">
              <span className="glm-glyph">{Icon.app}</span>
              <div>
                <b>Open it now</b>
                <span>This page is a file on your computer, so GreenLight Dash can open it straight away.</span>
                <div className="glm-way-actions">
                  <a className="glm-btn" href={direct} onClick={tryOpen}>{Icon.app}Open in GreenLight Dash</a>
                </div>
                {opening === 'nothing' && <span className="glm-way-hint">Nothing opened? GreenLight Dash may not be installed yet. <a href={GET_APP_URL} target="_blank" rel="noopener noreferrer">Get it here</a>, then try again.</span>}
              </div>
            </section>
          ) : (
            <section className="glm-way">
              <span className="glm-glyph">{Icon.save}</span>
              <div>
                <b>Save it for GreenLight Dash</b>
                <span>Saves one .glvideo file with the project and its files. Double-click it to open it in GreenLight Dash, or drag it onto GreenLight Dash.</span>
                <div className="glm-way-actions">
                  <button type="button" className="glm-btn" onClick={save} disabled={busy}>{Icon.save}{busy ? 'Saving…' : 'Save for GreenLight Dash'}</button>
                </div>
                {saved?.name && <span className="glm-way-hint is-good">Saved as <b>{saved.name}</b>. Double-click it in your Downloads, or click it in your browser’s downloads, and it opens in GreenLight Dash.</span>}
                {saved?.error && <span className="glm-way-hint is-bad">{saved.error}</span>}
              </div>
            </section>
          )}
        </div>
        <footer>
          <span>Don’t have it yet? <a className="glm-link-quiet" href={GET_APP_URL} target="_blank" rel="noopener noreferrer">Get GreenLight Dash</a></span>
          <button type="button" className="glm-btn is-quiet" onClick={onClose}>Not now</button>
        </footer>
      </div>
    </div>
  );
}

/* ── the page ──────────────────────────────────────────────────────────────────────────────────── */

export function PlayerPage({ project: source, assets, theme = 'dark' }) {
  const playerRef = useRef(null);
  const viewRef = useRef(null);
  const frameRef = useRef(null);
  const abortRef = useRef(null);
  const resolverRef = useRef(null);
  const [base, setBase] = useState(null);
  const [values, setValues] = useState({});
  const [playing, setPlayingState] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [fit, setFit] = useState({ scale: 1, x: 0, y: 0 });
  const [fps, setFps] = useState(30);
  const [motionBlur, setMotionBlur] = useState(source?.motionBlurEnabled === true);
  const [loop, setLoop] = useState(true);
  const [volume, setVolume] = useState(100);   // the page's sound mix (./mix.js): preview AND render
  const [sfx, setSfx] = useState(true);
  const [pane, setPane] = useState('options');   // 'options' | 'render'
  const [render, setRender] = useState(null);    // { progress, phase } while rendering
  const [notice, setNotice] = useState(null);    // { text, tone }
  const [missing, setMissing] = useState([]);
  // the viewer's own changes (./pageEdits.js): a layer's values, a replaced picture, where layers sit
  const [selectedId, setSelectedId] = useState(null);
  const [itemEdits, setItemEdits] = useState({});
  const [clipEdits, setClipEdits] = useState({});
  const [timing, setTiming] = useState(EMPTY_TIMING);
  const [structEdits, setStructEdits] = useState({});   // transitions: they move clips, so they go in before normalizing
  const [selectedTrans, setSelectedTrans] = useState(null);   // the layer a selected cross transition leads INTO
  const [dragTiming, setDragTiming] = useState(null);
  const dragRef = useRef(null);
  const [openApp, setOpenApp] = useState(false);
  const [presetFor, setPresetFor] = useState(null);   // { layerId, kind: 'in' | 'out' | 'text' } while a preset window is open
  const [transFor, setTransFor] = useState(null);     // { layerId, slot: 'cross' | 'in' | 'out' } while the transitions window is open
  const [applied, setApplied] = useState({});         // layerId → { in, out, text }: the preset names applied here
  const initialValues = useRef('{}');

  // A new project starts clean.
  useEffect(() => {
    setSelectedId(null); setSelectedTrans(null); setItemEdits({}); setClipEdits({}); setStructEdits({}); setTiming(EMPTY_TIMING); setDragTiming(null);
  }, [source]);
  // One resolver for the page's files: normalizing again after a layer moves re-uses every file already fetched.
  useEffect(() => {
    const resolver = createResolver(assets);
    setActiveResolver(resolver);
    resolverRef.current = resolver;
    return () => { resolver.dispose(); if (resolverRef.current === resolver) resolverRef.current = null; };
  }, [assets]);
  // Timing and transitions go in BEFORE normalizing, so sound cues anchored to a layer follow it (soundCues.js).
  const raw = useMemo(() => applyItemEdits(applyTiming(source, timing), structEdits, null), [source, timing, structEdits]);
  const loadedFor = useRef(null);
  useEffect(() => {
    let alive = true;
    const resolver = resolverRef.current;
    if (!resolver) return undefined;
    toEngineProject(raw).then((normalized) => resolveProject(normalized, resolver)).then((resolved) => {
      if (!alive) return;
      setBase(resolved);
      if (loadedFor.current !== source) {
        loadedFor.current = source;
        const v = fieldValues(resolved);
        initialValues.current = JSON.stringify(v);
        setValues(v);
      }
    });
    return () => { alive = false; };
  }, [raw, assets, source]);

  const template = base?.template || null;
  // layer values on the normalized project (typing stays instant), then the template's values, then where
  // layers sit (again, so a move shows at once while the project is normalized anew), then a drag in progress
  const valued = useMemo(() => (base ? applyTemplateValues(applyItemEdits(base, itemEdits, clipEdits), values, template) : null),
    [base, itemEdits, clipEdits, values, template]);
  const settled = useMemo(() => applyTiming(applyItemEdits(valued, structEdits, null), timing), [valued, structEdits, timing]);
  const project = useMemo(() => (dragTiming ? applyTiming(settled, dragTiming) : settled), [settled, dragTiming]);
  // what the Player plays and renders: the project with the page's mix (the same object at 100 % with effects on)
  const mixed = useMemo(() => mixProject(project, { volume, sfx }), [project, volume, sfx]);
  // Playback speed, measured as it plays (the engine reports each painted frame's gap): the slow seconds show as the
  // red line on the ruler. The editor's render cache controller with no renderer wired in, so it never renders.
  const [slowMeter] = useState(() => {
    const meter = createRenderCacheController({ storage: null });
    meter.setEnabled(true);
    return meter;
  });
  useEffect(() => () => slowMeter.dispose(), [slowMeter]);
  const sound = useMemo(() => ({ any: hasSound(project), effects: hasSoundEffects(project) }), [project]);
  const size = project?.videoSize || { w: 1920, h: 1080 };
  const { rows, duration } = useMemo(() => layersOf(project?.channels, project?.clips), [project]);
  const meterKey = useMemo(() => renderCacheGlobalKey({
    videoSize: { w: size.w, h: size.h }, motionBlurEnabled: motionBlur, background: project?.background || null,
    markers: project?.markers || [], textVariables: project?.textVariables || [],
  }, { width: size.w, height: size.h, fps: project?.projectFps || 30 }),
  [size.w, size.h, motionBlur, project?.background, project?.markers, project?.textVariables, project?.projectFps]);
  useEffect(() => {
    if (mixed) slowMeter.setInputs({ channels: mixed.channels || [], clips: mixed.clips || [], globalKey: meterKey, fps: project?.projectFps || 30 });
  }, [slowMeter, mixed, meterKey, project?.projectFps]);
  useEffect(() => { slowMeter.setPlaying(playing); }, [slowMeter, playing]);
  const layerCount = rows.reduce((n, r) => n + r.layers.length, 0);
  const title = template?.title || project?.name || 'Untitled video';
  const selected = useMemo(() => rows.flatMap((r) => r.layers).find((l) => l.id === selectedId) || null, [rows, selectedId]);
  const dirty = hasEdits({ itemEdits, clipEdits, timing, structEdits }) || JSON.stringify(values) !== initialValues.current;
  const selectedT = useMemo(() => rows.flatMap((r) => r.layers).find((l) => l.id === selectedTrans) || null, [rows, selectedTrans]);

  // The preview fits the view; the Player keeps drawing at the project's own size.
  const hasProject = project != null;
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return undefined;
    const measure = () => {
      const scale = Math.min(el.clientWidth / size.w, el.clientHeight / size.h) || 1;
      setFit({ scale, x: (el.clientWidth - size.w * scale) / 2, y: (el.clientHeight - size.h * scale) / 2 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [size.w, size.h, hasProject]);

  const seek = useCallback((t) => {
    setPlayingState(false);
    setCurrentTime(t);
    useVideoEditorStore.getState().setPlayheadTime(t);
  }, []);

  // The Player stops itself at the end; with Loop on, the page starts it again from the top.
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const setPlaying = useCallback((next) => {
    const value = typeof next === 'function' ? next(false) : next;
    if (!value && loopRef.current && !abortRef.current) {
      const at = useVideoEditorStore.getState().playheadTime || 0;
      if (at >= durationRef.current - FRAME * 1.5) {
        seek(0);
        requestAnimationFrame(() => setPlayingState(true));
        return;
      }
    }
    setPlayingState(value);
  }, [seek]);

  const togglePlay = useCallback(() => {
    if (render) return;
    if (!playing && currentTime >= duration - 1e-3) seek(0);
    setPlayingState(!playing);
  }, [playing, currentTime, duration, render, seek]);

  const step = useCallback((dir, big = false) => {
    const from = playing ? (useVideoEditorStore.getState().playheadTime || 0) : currentTime;
    seek(Math.min(duration, Math.max(0, from + dir * (big ? 1 : FRAME))));
  }, [playing, currentTime, duration, seek]);

  useEffect(() => {
    const onKey = (e) => {
      if (openApp || presetFor || transFor || /INPUT|TEXTAREA|SELECT/.test(e.target?.tagName || '') || e.metaKey || e.ctrlKey || e.altKey) return;
      const rv = reviewRef.current;
      if (rv?.on) {
        const tool = REVIEW_TOOLS.find((t) => t.key === e.key.toLowerCase());
        if (tool && (rv.mode !== 'comments' || tool.id === 'pin' || tool.id === 'box')) { e.preventDefault(); rv.setTool(tool.id); return; }
        if (e.key === 'Escape') { e.preventDefault(); if (rv.composer) rv.cancelComposer(); else rv.toggle(false); return; }
      }
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); setPlayingState(false); rv?.toggle(); return; }
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1, e.shiftKey); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1, e.shiftKey); }
      else if (e.key === 'Home') { e.preventDefault(); seek(0); }
      else if (e.key === 'End') { e.preventDefault(); seek(duration); }
      else if (e.key === 'Escape' && pane === 'render' && !render) setPane('options');
      else if (e.key === 'Escape' && (selectedId || selectedTrans)) { setSelectedId(null); setSelectedTrans(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, step, seek, duration, pane, render, openApp, presetFor, transFor, selectedId, selectedTrans]);

  const setValue = (key, v) => setValues((prev) => ({ ...prev, [key]: v }));

  // ── a layer's changes. A value a template field owns goes through the field, so both panels agree.
  const fieldFor = useCallback((target) => (template?.fields || []).find((f) => (f.targets || []).some((t) => t.path === target.path
    && ((target.itemId && t.itemId === target.itemId) || (target.clipId && t.clipId === target.clipId)))) || null, [template]);
  const setItemValue = useCallback((itemId, path, v) => {
    const f = fieldFor({ itemId, path });
    if (f) { setValue(f.key, v); return; }
    setItemEdits((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] || {}), [path]: v } }));
  }, [fieldFor]);
  const setPicture = useCallback((clipId, url) => {
    const f = fieldFor({ clipId, path: 'url' });
    if (f) { setValue(f.key, url); return; }
    setClipEdits((prev) => ({ ...prev, [clipId]: { ...(prev[clipId] || {}), url, proxyUrl: url } }));
  }, [fieldFor]);
  const setStruct = useCallback((itemId, patch) => {
    setStructEdits((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] || {}), ...patch } }));
  }, []);
  // a cross transition INTO layer l: its type and length; a new type starts from its own defaults
  const changeTransition = useCallback((l, patch) => {
    const next = { ...patch };
    if (patch.transition) next.transitionOptions = {};
    if (patch.transition && patch.transition !== TransitionType.NONE && !l.transition) next.transitionDuration = 1;
    setStruct(l.id, next);
  }, [setStruct]);
  const findItem = useCallback((id) => {
    for (const ch of project?.channels || []) for (const it of ch.items || []) if (it.id === id) return it;
    return null;
  }, [project]);
  const controlsFor = (layer) => {
    const item = findItem(layer.id);
    if (!item || layer.locked) return [];
    const out = (LAYER_FIELDS[layer.type] || []).map((f) => ({
      ...f, key: `layer-${f.path}`, value: getPath(item, f.path), set: (v) => setItemValue(layer.id, f.path, v),
    }));
    if (layer.type === 'image') {
      const clip = (project.clips || []).find((c) => c.id === layer.clipId);
      out.push({ key: 'layer-picture', label: 'Picture', type: 'image', value: clip?.url, set: (v) => setPicture(layer.clipId, v) });
    }
    if (SEEN.has(layer.type) && layer.type !== 'model3d') {
      // the layer's own entrance and exit (no transitions on 3D models: their pass does not run them)
      for (const [side, label] of [['In', 'Entrance'], ['Out', 'Exit']]) {
        const type = item[`transition${side}Type`] || LayerTransitionType.NONE;
        out.push({ key: `layer-trans-${side}`, label, type: 'choose', value: type === LayerTransitionType.NONE ? 'None' : type,
          open: () => { setPlayingState(false); setTransFor({ layerId: layer.id, slot: side.toLowerCase() }); } });
        if (type !== LayerTransitionType.NONE) {
          out.push({ key: `layer-trans-${side}-d`, label: `${label} length`, type: 'number', min: 0.1, max: 3, step: 0.05,
            value: Number(item[`transition${side}Duration`]) || 0.6, set: (v) => setStruct(layer.id, { [`transition${side}Duration`]: Math.max(0.1, Number(v) || 0.1) }) });
        }
      }
    }
    if (SEEN.has(layer.type)) {
      const o = Number(item.opacity);
      out.push({ key: 'layer-opacity', label: 'Opacity', type: 'number', min: 0, max: 100, step: 1, value: Number.isFinite(o) ? o : 100,
        set: (v) => setItemValue(layer.id, 'opacity', Math.max(0, Math.min(100, Number(v) || 0))) });
    }
    return out;
  };
  // animation presets: a keyframe preset over the layer's first / last stretch (In and Out ones: the whole layer),
  // a text animation preset the way the editor's Presets window applies it (presetPatch)
  const applyPreset = (layer, kind, id, direction) => {
    const item = findItem(layer.id);
    if (!item) return;
    const dur = Math.max(1e-3, layer.end - layer.start);
    let patch; let name;
    if (kind === 'text') {
      const preset = TEXT_PRESETS.find((p) => p.id === id);
      if (!preset) return;
      patch = presetPatch(item, preset, { clipSec: dur, fontPx: Number(item.textFontSize) || 100, mode: 'replace' });
      name = preset.name;
    } else {
      const variant = kfpVariants(KEYFRAME_PRESETS, kind).find((p) => p.id === id);
      if (!variant) return;
      const span = Math.min(100, (KFP_DEFAULT_LENGTH / dur) * 100);
      const range = variant.inOut ? { startPct: 0, endPct: 100 } : kind === 'out' ? { startPct: 100 - span, endPct: 100 } : { startPct: 0, endPct: span };
      patch = applyKeyframePreset(item, resolvePresetVariant(variant, direction), range);
      name = variant.name;
    }
    setItemEdits((prev) => ({ ...prev, [layer.id]: { ...(prev[layer.id] || {}), ...patch } }));
    setApplied((prev) => ({ ...prev, [layer.id]: { ...(prev[layer.id] || {}), [kind]: name } }));
    seek(kind === 'out' ? Math.max(layer.start, layer.end - Math.min(KFP_DEFAULT_LENGTH, dur) - 0.2) : layer.start);
  };
  const animationsFor = (layer) => {
    if (layer.locked || !SEEN.has(layer.type)) return [];
    const open = (kind) => () => { setPlayingState(false); setPresetFor({ layerId: layer.id, kind }); };
    const done = applied[layer.id] || {};
    const item = findItem(layer.id);
    const out = [
      { key: 'in', label: 'Entrance animation', current: done.in || (keyframedAt(item, 'in') ? 'Keyframes' : null), open: open('in') },
      { key: 'out', label: 'Exit animation', current: done.out || (keyframedAt(item, 'out') ? 'Keyframes' : null), open: open('out') },
    ];
    if (layer.type === 'text') out.unshift({ key: 'text', label: 'Text animation', current: textPresetName(item), open: open('text') });
    return out;
  };
  // what one of the editor's windows applied: into the layer's edits, then the playhead goes where it shows
  const applyPatch = (layer, kind, patch, name = null) => {
    setItemEdits((prev) => ({ ...prev, [layer.id]: { ...(prev[layer.id] || {}), ...patch } }));
    if (name) setApplied((prev) => ({ ...prev, [layer.id]: { ...(prev[layer.id] || {}), [kind]: name } }));
    const dur = Math.max(1e-3, layer.end - layer.start);
    seek(kind === 'out' ? Math.max(layer.start, layer.end - Math.min(KFP_DEFAULT_LENGTH, dur) - 0.2) : layer.start);
  };
  const layerEdited = (layer) => Boolean(itemEdits[layer.id] || structEdits[layer.id] || timing.items?.[layer.id] || clipEdits[layer.clipId]);
  const resetLayer = (layer) => {
    setItemEdits((prev) => { const n = { ...prev }; delete n[layer.id]; return n; });
    setStructEdits((prev) => { const n = { ...prev }; delete n[layer.id]; return n; });
    setApplied((prev) => { const n = { ...prev }; delete n[layer.id]; return n; });
    setClipEdits((prev) => { const n = { ...prev }; delete n[layer.clipId]; return n; });
    setTiming((prev) => { const items = { ...prev.items }; delete items[layer.id]; return { ...prev, items }; });
  };

  // ── where layers sit: a drag shows live (dragTiming), and lands in `timing` when it ends
  const limitsOf = useCallback((id) => limitsFor(settled, id), [settled]);
  const onLayerDrag = useCallback((id, span) => {
    const t = retime(settled, id, span);
    dragRef.current = t;
    setDragTiming(t);
  }, [settled]);
  const onLayerDragEnd = useCallback((id) => {
    const t = dragRef.current;
    dragRef.current = null;
    setDragTiming(null);
    if (t) setTiming((prev) => mergeTiming(prev, t));
    setSelectedId(id);
  }, []);
  const retimeLayer = useCallback((id, span) => {
    const lim = limitsFor(settled, id);
    if (!lim) return;
    const len = Math.max(MIN_LENGTH, span.end - span.start);
    let { start, end } = span;
    if (span.zone === 'move') { start = Math.max(0, Math.min(Math.max(start, lim.minStart), lim.maxEnd - len)); end = start + len; }
    else end = Math.max(start + MIN_LENGTH, Math.min(end, lim.maxEnd, lim.end + lim.maxRightOpen));
    const t = retime(settled, id, { start, end, zone: span.zone });
    if (t) setTiming((prev) => mergeTiming(prev, t));
  }, [settled]);

  // ── picking a layer in the preview: the editor's own geometry for the frame on screen (top layer wins)
  const pickAt = useCallback((x, y, at) => {
    if (!project) return null;
    const clipsMap = new Map((project.clips || []).map((c) => [c.id, c]));
    const hits = activeLayers(project.channels || [], clipsMap, at, size.w, size.h, fps);
    const hit = [...hits].reverse().find((l) => {
      const b = l.box || l;
      const r = (-(l.rotation || 0) * Math.PI) / 180;
      const dx = x - b.cx; const dy = y - b.cy;
      const lx = dx * Math.cos(r) - dy * Math.sin(r);
      const ly = dx * Math.sin(r) + dy * Math.cos(r);
      return Math.abs(lx) <= b.width / 2 && Math.abs(ly) <= b.height / 2;
    });
    return hit ? hit.item.id : null;
  }, [project, size.w, size.h, fps]);
  const onPreviewDown = (e) => {
    if (e.button !== 0 || !frameRef.current) return;
    const r = frameRef.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / Math.max(1e-6, r.width)) * size.w;
    const y = ((e.clientY - r.top) / Math.max(1e-6, r.height)) * size.h;
    const at = playing ? (useVideoEditorStore.getState().playheadTime || 0) : currentTime;
    const id = pickAt(x, y, at);
    if (id) { if (playing) seek(at); setSelectedId(id); } else setSelectedId(null);
  };
  // review notes: marks on the paused frame, each with the viewer's words (./useReview.js)
  const capture = useCallback(async (t) => {
    if (!project || !playerRef.current) return null;
    await waitForMediaReady({ channels: project.channels, clips: project.clips, getPlayer: () => playerRef.current, range: { start: t, end: t + 1e-3 } });
    return playerRef.current?.captureFrameAtTime(Math.max(0, t));
  }, [project]);
  const review = useReview({
    title, slugName: slug(title), size, fps: project?.projectFps || project?.fps || 30, rows, pickAt, frameRef,
    currentTime, playing, seek, capture,
  });
  const reviewRef = useRef(review);
  useEffect(() => { reviewRef.current = review; });
  const [savingNotes, setSavingNotes] = useState(false);
  const saveNotes = async () => {
    setSavingNotes(true);
    try {
      const blob = await review.zip();
      await saveFile(blob, `${slug(title)}-notes.zip`);
      review.setStatus({ text: `Saved ${slug(title)}-notes.zip: NOTES.md and a picture of each moment. Give it to your agent.`, tone: 'good' });
    } catch (err) {
      review.setStatus({ text: `Couldn’t save the notes: ${err?.message || err}`, tone: 'bad' });
    } finally {
      setSavingNotes(false);
    }
  };
  // the selected layer's outline on the paused frame
  const outline = useMemo(() => {
    if (!selectedId || playing || !project) return null;
    const clipsMap = new Map((project.clips || []).map((c) => [c.id, c]));
    const l = activeLayers(project.channels || [], clipsMap, currentTime, size.w, size.h, fps).find((o) => o.item.id === selectedId);
    if (!l) return null;
    const b = l.box || l;
    const r = ((l.rotation || 0) * Math.PI) / 180;
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const lx = (sx * b.width) / 2; const ly = (sy * b.height) / 2;
      return `${b.cx + lx * Math.cos(r) - ly * Math.sin(r)},${b.cy + lx * Math.sin(r) + ly * Math.cos(r)}`;
    }).join(' ');
  }, [selectedId, playing, project, currentTime, size.w, size.h, fps]);

  // ── what the viewer hands back: to an agent (settings + `apply` edits), or to GreenLight Dash (a project)
  const editOps = () => editsToOps({ itemEdits, clipEdits, timing, structEdits });
  const settingsJson = () => JSON.stringify({ template: template?.title || null, values, edits: editOps() }, null, 2);
  const copySettings = async () => {
    try {
      await navigator.clipboard.writeText(settingsJson());
      setNotice({ text: 'Settings copied. Paste them to your agent.', tone: 'good' });
    } catch {
      setNotice({ text: 'Copying is blocked here. Use Save instead.', tone: 'bad' });
    }
  };
  const saveSettings = async () => {
    try {
      await saveFile(new Blob([settingsJson()], { type: 'application/json' }), `${slug(title)}.settings.json`);
      setNotice({ text: 'Settings saved.', tone: 'good' });
    } catch (e) {
      setNotice({ text: e?.code === 'declined' ? 'Saving was cancelled.' : `Could not save the settings: ${e?.message || e}`, tone: 'bad' });
    }
  };
  // The project as it stands here, in the file format (refs, not loaded files): the page's own source with the
  // changes written in, pictures picked here added to the files.
  const exportProject = useCallback(async () => {
    const changed = applyTemplateValues(applyItemEdits(applyItemEdits(applyTiming(source, timing), structEdits, null), itemEdits, clipEdits), values, source?.template);
    return bakeForExport(changed, assets);
  }, [source, timing, structEdits, itemEdits, clipEdits, values, assets]);
  const saveForApp = useCallback(async () => {
    const { project: p, assets: a } = await exportProject();
    const name = `${slug(title)}.glvideo`;
    await saveFile(new Blob([await glvideoFile({ title, project: p, assets: a })], { type: 'application/x-greenlight-video' }), name);
    return name;
  }, [exportProject, title]);

  const startRender = async () => {
    const player = playerRef.current;
    if (!player || render) return;
    if (!player.isWebCodecsSupported?.()) { setNotice({ text: 'This browser cannot encode video. Try Chrome or Edge.', tone: 'bad' }); return; }
    setPlayingState(false);
    setNotice(null);
    const abort = new AbortController();
    abortRef.current = abort;
    setRender({ progress: 0, phase: 'Preparing' });
    try {
      await waitForMediaReady({ channels: project.channels, clips: project.clips, getPlayer: () => playerRef.current, range: null });
      setRender({ progress: 0, phase: 'Rendering' });
      const res = await player.exportVideo('mp4', (p) => setRender({ progress: p, phase: 'Rendering' }), abort.signal, fps);
      if (!res?.blob) throw new Error('the render produced no file');
      setRender({ progress: 1, phase: 'Saving' });
      await saveFile(res.blob, `${slug(title)}.mp4`);
      const mixNote = `${volume !== 100 ? ` · sound ${volume}%` : ''}${sfx ? '' : ' · no sound effects'}`;
      setNotice({ text: `Rendered ${seconds(duration)} at ${fps} fps${motionBlur ? ' with motion blur' : ''}${mixNote} · ${sizeLabel(res.blob.size)}`, tone: 'good' });
    } catch (e) {
      if (abort.signal.aborted) setNotice({ text: 'Render stopped.', tone: '' });
      else setNotice({ text: e?.code === 'declined' ? 'Saving was cancelled.' : `The render failed: ${e?.message || e}`, tone: 'bad' });
    } finally {
      abortRef.current = null;
      setRender(null);
    }
  };

  useEffect(() => {
    // Asked-for files nobody provided: shown so the viewer (or the agent) knows what is missing.
    const id = setInterval(() => {
      const list = missingAssets();
      setMissing((prev) => (prev.length === list.length ? prev : list));
    }, 1500);
    return () => clearInterval(id);
  }, []);

  // The page's own API, for the CLI and for agents driving the page headless (stills, options,
  // a render without clicking): window.GreenLightMotion.page. Rebound every render, so it always
  // sees the latest values.
  useEffect(() => {
    if (!window.GreenLightMotion || !project) return undefined;
    window.GreenLightMotion.page = {
      ready: true,
      duration,
      layers: () => rows.flatMap((r) => r.layers.map((l) => ({ ...l }))),
      values: () => ({ ...values }),
      setValue: (key, v) => setValue(key, v),
      state: () => ({ playing, currentTime, playhead: useVideoEditorStore.getState().playheadTime, fps, motionBlur, loop, volume, sfx }),
      // the sound mix the preview plays and a render writes: { volume: 0–100, sfx: true | false }
      setMix: ({ volume: v, sfx: x } = {}) => {
        if (v !== undefined) setVolume(Math.max(0, Math.min(100, Number(v) || 0)));
        if (x !== undefined) setSfx(x !== false);
      },
      // a layer's own changes, as the inspector makes them: select, set a value, move / trim, read them back
      select: (id) => setSelectedId(id || null),
      selected: () => selectedId,
      setLayerValue: (id, path, v) => setItemValue(id, path, v),
      retimeLayer: (id, span) => retimeLayer(id, span),
      pickAt: (x, y, at = currentTime) => pickAt(x, y, at),
      edits: () => ({ itemEdits, clipEdits, timing, structEdits, ops: editOps(), dirty }),
      // the seconds that played below 25 fps on this computer so far (the ruler's red line): [{ start, end }]
      slowParts: () => (slowMeter.getSnapshot().runs || []).filter((r) => r.state === 'slow').map((r) => ({ start: r.t0, end: r.t1 })),
      // what was measured, per second of the timeline: { [second]: 'slow|ok|unknown:<frames>:<fps>fps' }
      playbackSpeed: () => slowMeter.debug.state().verdicts,
      applyPreset: (id, kind, presetId, dir = null) => { const l = rows.flatMap((r) => r.layers).find((o) => o.id === id); if (l) applyPreset(l, kind, presetId, dir); },
      selectTransition: (id) => { setSelectedId(null); setSelectedTrans(id || null); },
      setTransition: (id, patch) => { const l = rows.flatMap((r) => r.layers).find((o) => o.id === id); if (l) changeTransition(l, patch); },
      exportProject,
      // the .glvideo "Save for GreenLight Dash" writes, as base64 (for the CLI and tests)
      glvideo: async () => {
        const { project: p, assets: a } = await exportProject();
        const bytes = await glvideoFile({ title, project: p, assets: a });
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(bin);
      },
      // review notes: where they go ('comments' | 'server' | 'local'), the notes, and the same as a mark + words
      review: { mode: review.mode, notes: () => review.notes, threads: () => review.threads, add: review.add, markdown: review.markdown, on: review.on, toggle: review.toggle },
      play: () => { if (!playing) togglePlay(); },
      pause: () => setPlayingState(false),
      seek,
      // A whole render without the UI (the CLI's `render`): base64 MP4, so a headless driver can read it.
      renderVideo: async ({ fps: f = 30, motionBlur: mb = false, volume: v, sfx: x, onProgress = noop } = {}) => {
        setPlayingState(false);
        setMotionBlur(Boolean(mb));
        if (v !== undefined) setVolume(Math.max(0, Math.min(100, Number(v) || 0)));
        if (x !== undefined) setSfx(x !== false);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await waitForMediaReady({ channels: project.channels, clips: project.clips, getPlayer: () => playerRef.current, range: null });
        const res = await playerRef.current.exportVideo('mp4', onProgress, undefined, Number(f) || 30);
        if (!res?.blob) throw new Error('the render produced no file');
        const b64 = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(res.blob); });
        return { base64: b64, size: res.blob.size, fps: Number(f) || 30, motionBlur: Boolean(mb), volume: v ?? volume, sfx: x ?? sfx };
      },
      renderFrame: async (t) => {
        await waitForMediaReady({ channels: project.channels, clips: project.clips, getPlayer: () => playerRef.current, range: { start: t, end: t + 1e-3 } });
        return playerRef.current?.captureFrameAtTime(Math.max(0, Number(t) || 0));
      },
    };
    return undefined;
  });

  if (!project) return <div className="glm-app glm-loading" data-theme={theme}><span>Loading the video…</span></div>;
  const fields = template?.fields || [];
  const isRender = pane === 'render';
  // straight to the app from a page on disk with nothing changed; otherwise the changes travel in a file
  const direct = OPEN_IN_APP && !dirty ? OPEN_IN_APP : null;

  return (
    <div className={`glm-app${isRender ? ' is-render' : ''}`} data-theme={theme}>
      <header className="glm-top">
        <h1>{title}</h1>
        <span className="glm-badge glm-num"><span>{size.w}×{size.h}</span><span>{seconds(duration)}</span><span>{layerCount} {layerCount === 1 ? 'layer' : 'layers'}</span></span>
        <span className="glm-mode"><i /><span>Live preview</span></span>
        <button type="button" className="glm-tbtn glm-notes-btn" aria-pressed={review.on} onClick={() => { setPlayingState(false); review.toggle(); }}
          title={review.mode === 'comments' ? 'Mark a spot and send your note to Claude (N)' : 'Mark what should change, right on the frame (N)'}>
          {Icon.note}<span>Notes</span>{review.count > 0 && <b className="glm-count">{review.count}</b>}
        </button>
        <button type="button" className="glm-tbtn" onClick={() => { setPlayingState(false); setOpenApp(true); }} title="Edit everything in GreenLight Dash, the full editor">
          {Icon.app}<span>Open in GreenLight Dash</span>
        </button>
        <button type="button" className="glm-xbtn" aria-expanded={isRender} aria-controls="glm-render-pane"
          onClick={() => setPane(isRender ? 'options' : 'render')} title="Render a video file">
          {Icon.film}<span>Render</span>{render && <span className="glm-dot is-busy" />}
        </button>
      </header>

      <div className="glm-main">
        <div className="glm-view" ref={viewRef}>
          <div className="glm-frame" ref={frameRef} style={{ width: size.w, height: size.h, transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})` }}>
            <EngineCanvas
              ref={playerRef}
              channels={mixed.channels || []}
              clips={mixed.clips || []}
              isPlaying={playing}
              setIsPlaying={setPlaying}
              currentTime={currentTime}
              playheadTime={currentTime}
              setCurrentTime={setCurrentTime}
              setPlayheadTime={noop}
              soundEnabled={!render}
              forceMuteAudio={false}
              videoWidth={size.w}
              videoHeight={size.h}
              outputSize={null}
              previewQuality="full"
              motionBlurEnabled={motionBlur}
              background={project.background || null}
              markers={project.markers || []}
              textVariables={project.textVariables || []}
              timecodeFps={fps}
              renderCache={slowMeter}
            />
            <div className="glm-pick" onPointerDown={onPreviewDown} aria-hidden="true" />
            {outline && (
              <svg className="glm-sel" viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true">
                <polygon points={outline} vectorEffect="non-scaling-stroke" />
              </svg>
            )}
            <ReviewLayer size={size} scale={fit.scale} shown={review.shown} active={review.on && !review.composer} tool={review.tool} onFinish={review.onFinish} />
          </div>
          {review.on && <ReviewBar review={review} />}
          {review.composer && <NoteComposer composer={review.composer} fit={fit} size={size} onSave={review.saveComposer} onCancel={review.cancelComposer} />}
        </div>
        <Transport duration={duration} playing={playing} currentTime={currentTime} onPlay={togglePlay} onStep={step}
          loop={loop} onLoop={() => setLoop((v) => !v)} rows={rows} />
        <Timeline rows={rows} duration={duration || 1} playing={playing} currentTime={currentTime} onSeek={seek}
          onSelect={(l) => { setPlayingState(false); setSelectedTrans(null); setSelectedId(l.id); setPane('options'); }} selected={selectedId}
          limitsOf={limitsOf} onDrag={onLayerDrag} onDragEnd={onLayerDragEnd}
          selectedTrans={selectedTrans}
          onTransition={(l) => { setPlayingState(false); setSelectedId(null); setSelectedTrans(l.id); setPane('options'); }}
          onAddTransition={(l) => { setPlayingState(false); changeTransition(l, { transition: TransitionType.FADE }); setSelectedId(null); setSelectedTrans(l.id); setPane('options'); }}
          flags={review.flags} onFlag={(f) => seek(f.t)} meter={slowMeter} />
      </div>

      <aside className="glm-side" aria-label="Inspector">
        <div className="glm-track">
          <div className="glm-insp" inert={isRender}>
            {selectedT ? (
              <TransitionPanel layer={selectedT} prevName={rows.flatMap((r) => r.layers).find((o) => o.id === selectedT.prevId)?.name || 'the clip before'}
                onChange={(patch) => changeTransition(selectedT, patch)} onBack={() => setSelectedTrans(null)}
                onChoose={() => { setPlayingState(false); setTransFor({ layerId: selectedT.id, slot: 'cross' }); }}
                onOpenApp={() => { setPlayingState(false); setOpenApp(true); }} />
            ) : selected ? (
              <LayerPanel layer={selected} controls={controlsFor(selected)} animations={animationsFor(selected)} title={title}
                edited={layerEdited(selected)} onReset={() => resetLayer(selected)}
                onBack={() => setSelectedId(null)} onOpenApp={() => { setPlayingState(false); setOpenApp(true); }} />
            ) : (
              <>
                <div className="glm-tabs"><span className="glm-tab" aria-current="true">Options <small>{fields.length || ''}</small></span></div>
                <section className="glm-panel">
                  {fields.length ? (
                    <div className="glm-sec">
                      <p className="glm-sub">Change these and the preview follows. Click a layer, on the timeline or in the preview, for its own options.</p>
                      <div className="glm-rows-f">{fields.map((f) => <Field key={f.key} field={f} value={values[f.key]} onChange={(v) => setValue(f.key, v)} />)}</div>
                    </div>
                  ) : <p className="glm-sec glm-sub">Click a layer, on the timeline or in the preview, to change it.</p>}
                  {(fields.length > 0 || dirty) && (
                    <div className="glm-sec">
                      <h3 className="glm-h">Your choices</h3>
                      <p className="glm-sub">Hand them back to your agent to keep them in the project.</p>
                      <div className="glm-actions">
                        <button type="button" className="glm-btn" onClick={copySettings}>{Icon.copy}Copy settings</button>
                        <button type="button" className="glm-btn" onClick={saveSettings}>{Icon.save}Save settings</button>
                      </div>
                    </div>
                  )}
                  {sound.any && (
                    <div className="glm-sec">
                      <h3 className="glm-h">Sound</h3>
                      <p className="glm-sub">What you hear here is what the render writes.</p>
                      <div className="glm-rows-f">
                        <Field field={{ key: 'glm-volume', label: 'Volume', type: 'number', min: 0, max: 100, step: 1 }} value={volume}
                          onChange={(v) => setVolume(Math.max(0, Math.min(100, Number(v) || 0)))} />
                        {sound.effects && <Field field={{ key: 'glm-sfx', label: 'Sound effects', type: 'toggle' }} value={sfx} onChange={(v) => setSfx(Boolean(v))} />}
                      </div>
                    </div>
                  )}
                  {(review.count > 0 || review.on || review.mode === 'comments') && (
                    <NotesSection review={review} onJump={(n) => seek(n.t)} onSave={saveNotes} saving={savingNotes} />
                  )}
                  {notice && !isRender && <p className={`glm-status glm-sec is-${notice.tone || 'plain'}`} role="status">{notice.text}</p>}
                  {missing.length > 0 && (
                    <p className="glm-warn">Missing files: {missing.slice(0, 4).join(', ')}{missing.length > 4 ? ` and ${missing.length - 4} more` : ''}</p>
                  )}
                  <div className="glm-hint">
                    <span className="glm-glyph">{Icon.chat}</span>
                    <span>Want something else changed? Ask your agent, or <button type="button" className="glm-link" onClick={() => setOpenApp(true)}>open it in GreenLight Dash</button> for full editing.</span>
                  </div>
                </section>
              </>
            )}
          </div>

          <section className="glm-deliver" id="glm-render-pane" aria-labelledby="glm-h-render" inert={!isRender}>
            <div className="glm-dhead">
              <button type="button" className="glm-icon" onClick={() => setPane('options')} aria-label="Back to Options" title="Back (Esc)" disabled={!!render}>{Icon.back}</button>
              <div><h2 id="glm-h-render">Render</h2><p>An MP4 of the whole video, saved to your computer.</p></div>
              <kbd>Esc</kbd>
            </div>
            <div className="glm-dbody">
              <section className="glm-sec">
                <h3 className="glm-h">Frame rate <span>{size.w}×{size.h} · {seconds(duration)}</span></h3>
                <div className="glm-fmts" role="group" aria-label="Frame rate">
                  {[[30, 'Plays anywhere'], [60, 'Smoother motion']].map(([f, sub]) => (
                    <button key={f} type="button" aria-pressed={fps === f} disabled={!!render} onClick={() => setFps(f)}><b>{f} fps</b><span>{sub}</span></button>
                  ))}
                </div>
                <label className="glm-toggle"><b>Motion blur</b><small>Smoother fast moves, slower render</small>
                  <input type="checkbox" checked={motionBlur} disabled={!!render} onChange={(e) => setMotionBlur(e.target.checked)} /><u aria-hidden="true" />
                </label>
                {render ? (
                  <div className="glm-progress" role="status">
                    <div className="glm-pbar"><span style={{ transform: `scaleX(${render.progress})` }} /></div>
                    <div className="glm-prow"><span>{render.phase} · {Math.round(render.progress * 100)}%</span>
                      <button type="button" className="glm-btn" onClick={() => abortRef.current?.abort()}>Stop</button></div>
                  </div>
                ) : (
                  <button type="button" className="glm-go" onClick={startRender}>{Icon.film}Render MP4</button>
                )}
                {notice && isRender && <p className={`glm-status is-${notice.tone || 'plain'}`} role="status">{notice.text}</p>}
              </section>
            </div>
          </section>
        </div>
      </aside>

      {presetFor && (() => {
        const l = rows.flatMap((r) => r.layers).find((o) => o.id === presetFor.layerId);
        const item = l && findItem(l.id);
        if (!item) return null;
        const dur = Math.max(1e-3, l.end - l.start);
        const close = () => setPresetFor(null);
        if (presetFor.kind === 'text') {
          return (
            <TextAnimatorPresetModal item={item} clipSec={dur} fontPx={Number(item.textFontSize) || 100}
              fontFamily={String(item.textFontFamily || 'Inter').trim()} fontWeight={item.textFontWeight || 400}
              textColor={typeof item.textColor === 'string' ? item.textColor : '#ffffff'}
              onApply={(patch) => applyPatch(l, 'text', patch)} onClose={close} />
          );
        }
        const inside = currentTime >= l.start && currentTime <= l.end;
        return (
          <VEKeyframePresetModal presets={KEYFRAME_PRESETS} itemDuration={dur} initialDir={presetFor.kind}
            playheadProgress={inside ? ((currentTime - l.start) / dur) * 100 : null}
            onApply={(preset, range) => { applyPatch(l, preset.outro || range.startPct >= 50 ? 'out' : 'in', applyKeyframePreset(item, preset, range), preset.name); close(); }}
            onClose={close} />
        );
      })()}
      {transFor && (() => {
        const l = rows.flatMap((r) => r.layers).find((o) => o.id === transFor.layerId);
        const item = l && findItem(l.id);
        if (!item) return null;
        const none = (slot) => (slot === 'cross' ? TransitionType.NONE : LayerTransitionType.NONE);
        return (
          <TransitionPresetModal initialSlot={transFor.slot} item={item} crossDisabled={!(l.overlapIn > 0 || l.touchingPrev)} appTools={false}
            onApply={(props) => setStruct(l.id, props)}
            onRemove={(slot) => setStruct(l.id, { [TRANSITION_SLOT_FIELDS[slot].type]: none(slot) })}
            onOpenBuilder={() => { setTransFor(null); setOpenApp(true); }}
            onClose={() => setTransFor(null)} />
        );
      })()}
      {openApp && <OpenInAppDialog title={title} direct={direct} onSave={saveForApp} onClose={() => setOpenApp(false)} />}
    </div>
  );
}
