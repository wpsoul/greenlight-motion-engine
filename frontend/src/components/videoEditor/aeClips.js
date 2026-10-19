// After Effects clips — mediaType 'after-effects' (look-dev: html/ae-clip-lab.html).
//
// The clip's url is the .aep / .aepx on the board. `clip.ae` holds what the
// inspector read from it and what the user picked:
//   ae.inspection  the analysis (/api/ae/projects/inspect, a script run inside After
//                  Effects), trimmed to what the panel and the render need
//   ae.comp        the composition to render; the clip takes its duration
//   ae.output      the render's file format (the canvas inspector's formats)
//   ae.values      replacements, sparse: text / media / ctrl → key → value. A key
//                  that is absent means "the project's own value".
// `clip.prerender` is the render After Effects made — { url, proxyUrl, thumbnailUrl,
// hash, duration, width, height, comp, name, at } — where `hash` digests the render
// payload it was made from, so any later change to a replacement makes it stale
// (the previous render keeps playing). The editor's job runner (VideoEditor)
// analyzes and renders; the Player only ever sees substituteAeClips' output: the
// render as a video clip, or before one exists a drawn placeholder — and in an
// export nothing at all.

export const AE_MEDIA_TYPE = 'after-effects';
export const AE_CLIP_DURATION_SECONDS = 5;

// The canvas inspector's formats (Canvas.jsx AE_OUTPUT_FORMATS → backend
// _build_ae_encode_cmd). Auto = WebM when the comp renders with alpha, else MP4.
export const AE_OUTPUT_FORMATS = [
  { value: 'auto', label: 'Auto (alpha-aware)', description: 'WebM if transparent, MP4 otherwise' },
  { value: 'mp4_h264', label: 'MP4 (H.264)', description: 'Web-friendly, no transparency' },
  { value: 'webm_vp9', label: 'WebM (VP9)', description: 'Keeps alpha, plays in browsers' },
  { value: 'mov_prores_4444', label: 'MOV (ProRes 4444)', description: 'High quality, with alpha' },
  { value: 'mov_prores_422', label: 'MOV (ProRes 422 HQ)', description: 'High quality, no alpha' },
];

export const isAeClip = (clip) => clip?.mediaType === AE_MEDIA_TYPE;
export const isAeProjectUrl = (value) => /\.aepx?(\?.*)?(#.*)?$/i.test(String(value || ''));
export const isAeMediaFile = (file) => !!file && (file.type === AE_MEDIA_TYPE || isAeProjectUrl(file.filename || file.name || file.url));

// ── Analysis ───────────────────────────────────────────────────────────────

export const aeLayerKey = (compName, layer) => `${compName || 'Comp'}::${layer?.index || 0}::${layer?.name || ''}`;
export const aeControlKey = (compName, control) => `${compName || 'Comp'}::${control?.layerIndex || 0}::${control?.effectIndex || 0}::${control?.effectName || 'Effect'}`;

// Template authors ship dummy Slider Controls named "===== TEXT 01 =====" as
// separators in AE's Effect Controls; they head a group, they are not inputs.
// Returns the cleaned title, or null for a real control (as in Canvas.jsx).
export function aeSeparatorTitle(name) {
  const raw = String(name || '');
  if (!/[=\-_*~#]{3,}/.test(raw)) return null;
  return raw.replace(/[=\-_*~#]{3,}/g, ' ').replace(/\s+/g, ' ').trim();
}

// Only true file footage is replaceable (the backend already drops nulls, solids,
// shapes and adjustments; isFileFootage guards the rest).
export function aeMediaLayers(comp) {
  return (comp?.mediaLayers || []).filter((layer) => {
    const src = layer?.source;
    if (!src) return false;
    return typeof src.isFileFootage === 'boolean' ? src.isFileFootage : true;
  });
}
export const aeRealControls = (comp) => (comp?.expressionControls || []).filter((c) => aeSeparatorTitle(c?.effectName) === null);
export const aeEditableCount = (comp) => (comp?.textLayers?.length || 0) + aeMediaLayers(comp).length + aeRealControls(comp).length;

// The picked comp and every comp nested under it (precompLayers, transitively):
// templates keep their inputs in precomps, so the render comp alone often has none.
// Inspection order. Falls back to the first comp when the name is unknown.
export function aeRelatedComps(comps, name) {
  if (!Array.isArray(comps) || comps.length === 0) return [];
  const byId = new Map();
  const byName = new Map();
  for (const c of comps) {
    if (c?.id != null) byId.set(c.id, c);
    if (c?.name) byName.set(c.name, c);
  }
  const keyOf = (c) => (c.id != null ? `id:${c.id}` : `name:${c.name}`);
  const start = byName.get(name) || comps[0];
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const c = stack.pop();
    const k = keyOf(c);
    if (seen.has(k)) continue;
    seen.add(k);
    for (const p of c.precompLayers || []) {
      const child = (p.sourceCompId != null && byId.get(p.sourceCompId)) || (p.sourceCompName && byName.get(p.sourceCompName));
      if (child) stack.push(child);
    }
  }
  return comps.filter((c) => seen.has(keyOf(c)));
}
export const aeTreeInputCount = (comps, name) => aeRelatedComps(comps, name).reduce((n, c) => n + aeEditableCount(c), 0);
export function chooseAeDefaultComp(comps) {
  if (!Array.isArray(comps) || comps.length === 0) return '';
  return (comps.find((c) => aeEditableCount(c) > 0) || comps[0]).name || '';
}

const num = (v, fb = 0) => (Number.isFinite(Number(v)) ? Number(v) : fb);

// The inspection as stored on the clip: no per-layer dump (comp.layers), only what
// the inputs and the render read. Keeps a saved project small.
export function trimAeInspection(result) {
  const comps = Array.isArray(result?.compositions) ? result.compositions : [];
  return {
    project: { name: String(result?.project?.name || '') },
    compositions: comps.map((c) => ({
      id: c.id ?? null,
      name: String(c.name || ''),
      width: Math.max(1, Math.round(num(c.width, 1920))),
      height: Math.max(1, Math.round(num(c.height, 1080))),
      frameRate: num(c.frameRate, 30) || 30,
      duration: Math.max(0.04, num(c.duration, AE_CLIP_DURATION_SECONDS)),
      textLayers: (c.textLayers || []).map((l) => ({ index: l.index ?? 0, name: String(l.name ?? ''), value: String(l.value ?? ''), property: l.property || 'Source Text' })),
      mediaLayers: aeMediaLayers(c).map((l) => ({
        index: l.index ?? 0,
        name: String(l.name ?? ''),
        source: {
          name: String(l.source?.name || ''),
          path: String(l.source?.path || ''),
          width: Math.round(num(l.source?.width)),
          height: Math.round(num(l.source?.height)),
          isFileFootage: true,
        },
      })),
      expressionControls: (c.expressionControls || []).map((x) => ({
        layerIndex: x.layerIndex ?? 0,
        layerName: String(x.layerName ?? ''),
        effectIndex: x.effectIndex ?? 0,
        effectName: String(x.effectName ?? ''),
        controlType: x.controlType,
        value: x.value,
      })),
      precompLayers: (c.precompLayers || []).map((p) => ({ sourceCompId: p.sourceCompId ?? null, sourceCompName: p.sourceCompName || '' })),
    })),
  };
}

export const aeComps = (clip) => clip?.ae?.inspection?.compositions || [];
export const aeIsAnalyzed = (clip) => aeComps(clip).length > 0;
export function aeSelectedComp(clip) {
  const comps = aeComps(clip);
  return comps.find((c) => c.name === clip?.ae?.comp) || comps[0] || null;
}

// ── Values ─────────────────────────────────────────────────────────────────

function findLayer(clip, kind, key) {
  for (const comp of aeComps(clip)) {
    if (kind === 'text') {
      for (const l of comp.textLayers || []) if (aeLayerKey(comp.name, l) === key) return l;
    } else if (kind === 'media') {
      for (const l of comp.mediaLayers || []) if (aeLayerKey(comp.name, l) === key) return l;
    } else {
      for (const c of comp.expressionControls || []) if (aeControlKey(comp.name, c) === key) return c;
    }
  }
  return null;
}
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The project's own value for an input (text string, original source url = null,
// control value).
export function aeOriginalValue(clip, kind, key) {
  const layer = findLayer(clip, kind, key);
  if (!layer) return null;
  if (kind === 'text') return layer.value ?? '';
  if (kind === 'media') return null;
  return layer.value ?? null;
}
export function aeValue(clip, kind, key) {
  const values = clip?.ae?.values?.[kind] || {};
  return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : aeOriginalValue(clip, kind, key);
}
export function aeIsChanged(clip, kind, key) {
  const values = clip?.ae?.values?.[kind] || {};
  if (!Object.prototype.hasOwnProperty.call(values, key)) return false;
  if (kind === 'media') return !!values[key];
  return !sameValue(values[key], aeOriginalValue(clip, kind, key));
}
// The `values` after setting one input: a value equal to the project's own drops
// the key, so a field put back by hand reads as untouched again.
export function aeWithValue(clip, kind, key, value) {
  const values = clip?.ae?.values || {};
  const bucket = { ...(values[kind] || {}) };
  const original = aeOriginalValue(clip, kind, key);
  if (value == null || (kind !== 'media' && sameValue(value, original)) || (kind === 'media' && !value)) delete bucket[key];
  else bucket[key] = value;
  return { ...values, [kind]: bucket };
}

// ── Render payload + fingerprint ───────────────────────────────────────────

// The body of /api/ae/projects/render(-jobs), minus url / board / flags: the
// picked comp's tree, every text (the project's or the replacement), the replaced
// media only, every real control — as the canvas inspector sends it.
export function aeRenderPayload(clip) {
  const comps = aeComps(clip);
  const comp = aeSelectedComp(clip);
  if (!comp) return null;
  const textEdits = [];
  const mediaEdits = [];
  const expressionEdits = [];
  for (const c of aeRelatedComps(comps, comp.name)) {
    for (const l of c.textLayers || []) {
      textEdits.push({ layerName: l.name, value: String(aeValue(clip, 'text', aeLayerKey(c.name, l)) ?? ''), property: l.property || 'Source Text', composition: c.name });
    }
    for (const l of c.mediaLayers || []) {
      const url = aeValue(clip, 'media', aeLayerKey(c.name, l));
      if (url) mediaEdits.push({ layerName: l.name, url, composition: c.name });
    }
    for (const x of aeRealControls(c)) {
      const value = aeValue(clip, 'ctrl', aeControlKey(c.name, x));
      if (value == null) continue;
      expressionEdits.push({ layerName: x.layerName, effectName: x.effectName, effectIndex: x.effectIndex, controlType: x.controlType, value, composition: c.name });
    }
  }
  const fps = Math.max(1, Math.round(comp.frameRate || 30));
  return {
    composition: comp.name,
    textEdits,
    mediaEdits,
    expressionEdits,
    width: comp.width,
    height: comp.height,
    fps,
    frames_total: Math.max(1, Math.round(comp.duration * (comp.frameRate || 30))),
    output_format: clip?.ae?.output || 'auto',
  };
}

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
// The project file plus the payload: a render made from anything else is stale.
export function aeRenderHash(clip) {
  const payload = aeRenderPayload(clip);
  return payload ? `ae1-${fnv1a(`${clip.url}|${JSON.stringify(payload)}`)}` : '';
}
export function aeRenderState(clip) {
  const pre = clip?.prerender;
  if (!pre || !pre.url) return 'none';
  return pre.hash && pre.hash === aeRenderHash(clip) ? 'valid' : 'stale';
}

// What the timeline, the inspector and the placeholder show. `job` is the editor's
// transient job for the clip: { kind: 'analyze'|'render', progress, stage, error }.
//   analyzing | analyze-failed | unanalyzed   (no inspection yet)
//   running | done | stale | error | idle     (analyzed)
export function aeClipUiState(clip, job) {
  const running = job && !job.error;
  if (running && job.kind === 'analyze') return 'analyzing';
  if (!aeIsAnalyzed(clip)) return job?.error ? 'analyze-failed' : 'unanalyzed';
  if (running && job.kind === 'render') return 'running';
  const render = aeRenderState(clip);
  if (render === 'valid') return 'done';
  if (render === 'stale') return 'stale';
  if (job?.error) return 'error';
  return 'idle';
}

// A request error → what the panel says. 409 is the backend's "After Effects is
// not running" (require_running); a script that may not write files is AE's
// Scripting & Expressions setting.
export function aeErrorInfo(err) {
  const message = String(err?.message || err || 'After Effects failed.');
  if (err?.status === 409 || err?.code === 'ae_not_running' || /isn['’]t open/i.test(message)) {
    return { code: 'not_running', message };
  }
  if (/not installed/i.test(message)) return { code: 'not_installed', message: 'After Effects isn’t installed on this computer.' };
  if (/write files|access network|scripting\s*&\s*expressions|scripting is disabled/i.test(message)) {
    return { code: 'scripting', message: 'After Effects blocked the script. Turn on Settings ▸ Scripting & Expressions ▸ Allow Scripts to Write Files and Access Network.' };
  }
  return { code: 'other', message };
}

export function aeColorToHex(value) {
  const arr = Array.isArray(value) ? value : [0, 0, 0];
  const ch = (c) => Math.round(Math.max(0, Math.min(1, Number(c) || 0)) * 255).toString(16).padStart(2, '0');
  return `#${ch(arr[0])}${ch(arr[1])}${ch(arr[2])}`;
}
export function hexToAeColor(hex, alpha = 1) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
}

export const aeProjectName = (clip) => {
  try {
    return decodeURIComponent(String(clip?.url || '').split('?')[0].split('/').pop() || '') || clip?.name || 'Project.aep';
  } catch {
    return clip?.name || 'Project.aep';
  }
};

// ── Player substitution ────────────────────────────────────────────────────

// The placeholder's words per UI state (the lab's placeholder, without a live %:
// it is a texture, redrawn only when the state changes).
const PLACEHOLDER_LINES = {
  unanalyzed: ['Analyzing the project…', ''],
  analyzing: ['Analyzing the project…', 'Reading compositions in After Effects'],
  idle: ['Not rendered yet', 'Pick a composition and render it in the inspector'],
  running: ['Rendering in After Effects…', ''],
};
function placeholderLines(uiState, error) {
  if (PLACEHOLDER_LINES[uiState]) return { tone: uiState === 'running' ? 'run' : 'idle', lines: PLACEHOLDER_LINES[uiState] };
  const again = uiState === 'analyze-failed' ? 'analyze again' : 'render again';
  if (error?.code === 'not_running') return { tone: 'err', lines: ['After Effects isn’t open', `Open After Effects, then ${again}`] };
  if (error?.code === 'not_installed') return { tone: 'err', lines: ['After Effects isn’t installed', 'Rendering an .aep needs After Effects on this computer'] };
  if (error?.code === 'scripting') return { tone: 'err', lines: ['After Effects blocked the script', 'Allow scripts to write files in its settings'] };
  return { tone: 'err', lines: [uiState === 'analyze-failed' ? 'Couldn’t analyze this project' : 'The render failed', 'Details are in the inspector'] };
}

const placeholderCache = new Map(); // key -> data URL
function drawPlaceholder(clip, uiState, error) {
  const comp = aeSelectedComp(clip);
  const cw = comp?.width || 1920;
  const ch = comp?.height || 1080;
  const { tone, lines } = placeholderLines(uiState, error);
  const name = aeProjectName(clip);
  const meta = comp ? `${comp.name} · ${comp.width}×${comp.height} · ${Math.round(comp.frameRate)} fps · ${comp.duration.toFixed(1)} s` : 'After Effects project';
  const key = `${cw}x${ch}|${name}|${meta}|${tone}|${lines.join('|')}`;
  const hit = placeholderCache.get(key);
  if (hit) return hit;
  if (typeof document === 'undefined') return '';
  // The comp's own size: an image layer draws at its picture's pixel size
  // (imagePlate.js), so this sits exactly where the render will. Capped for huge comps.
  const scale = Math.min(1, 3840 / Math.max(cw, ch));
  const w = Math.max(16, Math.round(cw * scale));
  const h = Math.max(16, Math.round(ch * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) return '';
  const bg = g.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#2d2242');
  bg.addColorStop(1, '#101016');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  const m = Math.min(w, h);
  const step = Math.max(8, w * 0.06);
  g.strokeStyle = 'rgba(215,182,255,0.06)';
  g.lineWidth = 1;
  g.beginPath();
  for (let x = (w / 2) % step; x < w; x += step) { g.moveTo(Math.round(x) + 0.5, 0); g.lineTo(Math.round(x) + 0.5, h); }
  for (let y = (h / 2) % step; y < h; y += step) { g.moveTo(0, Math.round(y) + 0.5); g.lineTo(w, Math.round(y) + 0.5); }
  g.stroke();
  g.strokeStyle = 'rgba(215,182,255,0.16)';
  g.strokeRect(0.5, 0.5, w - 1, h - 1);
  const font = (weight, size) => `${weight} ${Math.round(size)}px Inter, "SF Pro Display", -apple-system, "Segoe UI", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const cx = w / 2;
  let y = h / 2 - m * 0.16;
  g.fillStyle = '#d7b6ff';
  g.font = font(800, m * 0.15);
  g.fillText('Ae', cx, y);
  y += m * 0.15;
  const fit = (text, size, maxW) => {
    let s = size;
    g.font = font(600, s);
    while (s > 8 && g.measureText(text).width > maxW) { s -= 1; g.font = font(600, s); }
    return s;
  };
  g.fillStyle = '#f1eafd';
  fit(name, m * 0.042, w * 0.86);
  g.fillText(name, cx, y);
  y += m * 0.05;
  g.fillStyle = '#b7a6d2';
  g.font = font(450, m * 0.028);
  g.fillText(meta, cx, y);
  y += m * 0.075;
  g.fillStyle = tone === 'err' ? '#fca5a5' : tone === 'run' ? '#33efab' : '#e9e2f7';
  const stateSize = m * 0.032;
  g.font = font(600, stateSize);
  const tw = g.measureText(lines[0]).width;
  g.beginPath();
  g.arc(cx - tw / 2 - stateSize * 0.6, y, stateSize * 0.22, 0, Math.PI * 2);
  g.fill();
  g.fillText(lines[0], cx + stateSize * 0.2, y);
  if (lines[1]) {
    y += m * 0.048;
    g.fillStyle = '#a99bc2';
    g.font = font(450, m * 0.026);
    g.fillText(lines[1], cx, y);
  }
  let url = '';
  // Opaque, so JPEG: a comp-size gradient as PNG runs to megabytes.
  try { url = canvas.toDataURL('image/jpeg', 0.86); } catch { url = ''; }
  if (placeholderCache.size > 48) placeholderCache.clear();
  placeholderCache.set(key, url);
  return url;
}

// A fully transparent PNG: what an unrendered AE clip is in an export.
const TRANSPARENT_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const syntheticCache = new WeakMap();
function renderPlaybackClip(clip) {
  const pre = clip.prerender;
  const url = pre.at ? `${pre.url}?v=${pre.at}` : pre.url;
  const sig = `r|${url}|${pre.duration}`;
  const hit = syntheticCache.get(clip);
  if (hit && hit.sig === sig) return hit.clip;
  const synthetic = {
    ...clip,
    mediaType: 'video',
    url,
    // A WebM render keeps its alpha only from the original; an MP4 may use its proxy.
    proxyUrl: /\.webm(\?|$)/i.test(pre.url) ? null : (pre.proxyUrl || null),
    previewOriginal: false,
    duration: Math.max(0.1, Number(pre.duration) || clip.duration || AE_CLIP_DURATION_SECONDS),
    thumbnailUrl: pre.thumbnailUrl || clip.thumbnailUrl || null,
    prerenderOf: clip.id,
  };
  delete synthetic.ae;
  delete synthetic.prerender;
  syntheticCache.set(clip, { sig, clip: synthetic });
  return synthetic;
}
function imagePlaybackClip(clip, url, tag) {
  const sig = `i|${tag}|${url.length}|${url.slice(-32)}`;
  const hit = syntheticCache.get(clip);
  if (hit && hit.sig === sig) return hit.clip;
  const synthetic = { ...clip, mediaType: 'image', url, proxyUrl: null, aePlaceholder: true };
  delete synthetic.ae;
  delete synthetic.prerender;
  syntheticCache.set(clip, { sig, clip: synthetic });
  return synthetic;
}

const hasAeClips = (clips, depth = 0) => (clips || []).some((c) => isAeClip(c) || (depth < 8 && c?.sequence && hasAeClips(c.sequence.clips, depth + 1)));

function substituteScope(channels, clips, depth, opts) {
  let changed = false;
  const nextClips = (clips || []).map((clip) => {
    if (isAeClip(clip)) {
      changed = true;
      // A render plays even when stale: the previous render stands in until the next.
      if (clip.prerender?.url) return renderPlaybackClip(clip);
      if (!opts.placeholders) return imagePlaybackClip(clip, TRANSPARENT_PNG, 'none');
      const st = opts.states?.[clip.id];
      const url = drawPlaceholder(clip, st?.state || (aeIsAnalyzed(clip) ? 'idle' : 'unanalyzed'), st?.error || null) || TRANSPARENT_PNG;
      return imagePlaybackClip(clip, url, 'ph');
    }
    if (clip?.sequence && depth < 8) {
      const inner = substituteScope(clip.sequence.channels, clip.sequence.clips, depth + 1, opts);
      if (inner.clips !== clip.sequence.clips) {
        changed = true;
        return { ...clip, sequence: { ...clip.sequence, clips: inner.clips } };
      }
    }
    return clip;
  });
  return changed ? { channels, clips: nextClips } : { channels, clips };
}

// What the Player plays for every AE clip (same id, items untouched): its render
// as a video clip; with none, the placeholder picture (`placeholders`, the editor's
// preview — `states` maps clipId → { state, error } from aeClipUiState) or, in an
// export, a transparent picture. The same arrays come back when there are no AE clips.
export function substituteAeClips(channels, clips, { placeholders = false, states = null } = {}) {
  if (!hasAeClips(clips)) return { channels, clips };
  return substituteScope(channels, clips, 0, { placeholders, states });
}
