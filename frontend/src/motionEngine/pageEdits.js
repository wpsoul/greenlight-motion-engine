/*
 * GreenLight Motion Engine — the changes a viewer makes on the page (PlayerPage.jsx), as data.
 *
 * Three kinds, kept apart because they reach the project at different stages:
 *   itemEdits  { [itemId]: { [path]: value } }   a layer's own values (text, colours, size, opacity…)
 *   clipEdits  { [clipId]: { [path]: value } }   its source (a replaced picture: url + proxyUrl)
 *   structEdits { [itemId]: { [path]: value } }  values that change where clips sit or how they meet: a cross
 *              transition (`transition`, `transitionDuration`, `transitionOptions`) and a layer's own entrance /
 *              exit (`transitionInType`…); they go in with the timing, before normalizing
 *   timing     { channels: { [channelId]: true }, items: { [itemId]: { freeStart, trimStart, trimEnd } } }
 *              where a layer sits and how long it plays. A channel that was "snapped" (items back to back) is
 *              written out as unsnapped with every item's place frozen, so moving one never moves the others.
 * Timing goes into the RAW project before it is normalized, so sound cues anchored to a layer follow it
 * (soundCues.js re-places them); values go on top of the normalized project, so typing stays instant.
 * A value a template field already owns is changed through the field instead (the page routes it), so the
 * options panel and the layer panel always agree.
 *
 * editsToOps() writes the same changes as `apply` edits (motion-engine/cli/apply.mjs) for an agent;
 * glvideoFile() writes the changed project as a .glvideo for GreenLight Dash (backend motion_light.py imports it; the
 * desktop app opens one on a double-click).
 */
import { getTimelineLayout } from '../components/videoEditor/speedUtils';
import { zipStore } from './reviewNotes';

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
export const EMPTY_TIMING = Object.freeze({ channels: {}, items: {} });

// items and clips at any depth (sequences and grids carry their own)
function eachItem(project, fn) {
  const walk = (channels, clips) => {
    for (const ch of channels || []) for (const it of ch.items || []) fn(it, ch);
    for (const clip of clips || []) if (clip?.sequence) walk(clip.sequence.channels, clip.sequence.clips);
  };
  walk(project?.channels, project?.clips);
}
function eachClip(project, fn) {
  const walk = (clips) => { for (const clip of clips || []) { fn(clip); if (clip?.sequence) walk(clip.sequence.clips); } };
  walk(project?.clips);
}
function setPath(holder, path, value) {
  const keys = String(path).split('.');
  let node = holder;
  for (const key of keys.slice(0, -1)) {
    if (node[key] == null || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}
export function getPath(holder, path) {
  let node = holder;
  for (const key of String(path).split('.')) {
    if (node == null) return undefined;
    node = node[key];
  }
  return node;
}
const isEmpty = (o) => !o || !Object.keys(o).length;

/** PROJECT with the layer values and replaced sources written in (a copy; the same object when there are none). */
export function applyItemEdits(project, itemEdits, clipEdits) {
  if (!project || (isEmpty(itemEdits) && isEmpty(clipEdits))) return project;
  const next = clone(project);
  if (!isEmpty(itemEdits)) eachItem(next, (it) => { const e = itemEdits[it.id]; if (e) for (const [p, v] of Object.entries(e)) setPath(it, p, v); });
  if (!isEmpty(clipEdits)) eachClip(next, (c) => { const e = clipEdits[c.id]; if (e) for (const [p, v] of Object.entries(e)) setPath(c, p, v); });
  return next;
}

/** PROJECT with the timing written in (top-level channels; a copy, or the same object when there is none). */
export function applyTiming(project, timing) {
  if (!project || !timing || (isEmpty(timing.channels) && isEmpty(timing.items))) return project;
  const next = clone(project);
  for (const ch of next.channels || []) {
    if (timing.channels?.[ch.id]) ch.unsnapped = true;
    for (const it of ch.items || []) {
      const t = timing.items?.[it.id];
      if (t) Object.assign(it, t);
    }
  }
  return next;
}

export function mergeTiming(a, b) {
  if (!b) return a || EMPTY_TIMING;
  return { channels: { ...(a?.channels || {}), ...(b.channels || {}) }, items: { ...(a?.items || {}), ...(b.items || {}) } };
}

// clips whose source has its own clock: trimming the front of one skips into it
const SOURCE_CLOCK = new Set(['video', 'audio', 'sequence']);
export const MIN_LENGTH = 2 / 30;

/**
 * The timing that puts layer ITEM_ID (top-level) at [start, end] on the timeline, dragged by `zone`
 * ('move' | 'left' | 'right'), worked out on the normalized PROJECT: { channels, items }, ready for mergeTiming.
 * The channel is frozen as unsnapped the first time one of its layers moves.
 */
export function retime(project, itemId, { start, end, zone }) {
  for (const ch of project?.channels || []) {
    const index = (ch.items || []).findIndex((it) => it.id === itemId);
    if (index < 0) continue;
    const layout = getTimelineLayout(ch.items, { unsnapped: ch.unsnapped });
    const out = { channels: {}, items: {} };
    if (!ch.unsnapped) {
      out.channels[ch.id] = true;
      ch.items.forEach((it, i) => {
        if (layout[i]) out.items[it.id] = { freeStart: round(layout[i].startTime), trimStart: it.trimStart || 0, trimEnd: it.trimEnd };
      });
    }
    const it = ch.items[index];
    const at = layout[index];
    const clip = (project.clips || []).find((c) => c.id === it.clipId);
    const played = Math.max(1e-6, (it.trimEnd ?? 0) - (it.trimStart || 0));
    const k = played / Math.max(1e-6, at.endTime - at.startTime);   // source seconds per timeline second (speed)
    const length = Math.max(MIN_LENGTH, end - start);
    let trimStart = it.trimStart || 0;
    if (zone === 'left' && SOURCE_CLOCK.has(clip?.mediaType)) trimStart = Math.max(0, trimStart + (start - at.startTime) * k);
    out.items[itemId] = { freeStart: round(Math.max(0, start)), trimStart: round(trimStart), trimEnd: round(trimStart + length * k) };
    return out;
  }
  return null;
}
const round = (v) => Math.round(v * 10000) / 10000;

/** How far a layer may go: its neighbours on the same channel, and its source's own length. */
export function limitsFor(project, itemId) {
  for (const ch of project?.channels || []) {
    const index = (ch.items || []).findIndex((it) => it.id === itemId);
    if (index < 0) continue;
    const layout = getTimelineLayout(ch.items, { unsnapped: ch.unsnapped });
    const at = layout[index];
    let minStart = 0; let maxEnd = Infinity;
    layout.forEach((o, i) => {
      if (i === index || !o) return;
      if (o.endTime <= at.startTime + 1e-6) minStart = Math.max(minStart, o.endTime);
      if (o.startTime >= at.endTime - 1e-6) maxEnd = Math.min(maxEnd, o.startTime);
    });
    const it = ch.items[index];
    const clip = (project.clips || []).find((c) => c.id === it.clipId);
    const played = Math.max(1e-6, (it.trimEnd ?? 0) - (it.trimStart || 0));
    const k = played / Math.max(1e-6, at.endTime - at.startTime);
    const source = SOURCE_CLOCK.has(clip?.mediaType) && Number(clip?.duration) > 0 ? Number(clip.duration) : null;
    return {
      start: at.startTime, end: at.endTime, minStart, maxEnd,
      // with a source clock: the front can open up to its start, the back up to its end
      maxLeftOpen: source != null ? (it.trimStart || 0) / k : Infinity,
      maxRightOpen: source != null ? Math.max(0, source - (it.trimEnd ?? source)) / k : Infinity,
      sourceClock: source != null,
    };
  }
  return null;
}

/** The changes as `apply` edits (motion-engine/cli/apply.mjs), for an agent to keep them in project.json. */
export function editsToOps({ itemEdits, clipEdits, timing, structEdits }) {
  const ops = [];
  for (const [id, e] of Object.entries(structEdits || {})) for (const [p, v] of Object.entries(e)) ops.push({ op: 'set', item: id, path: p, value: v });
  for (const id of Object.keys(timing?.channels || {})) ops.push({ op: 'set', channel: id, path: 'unsnapped', value: true });
  for (const [id, t] of Object.entries(timing?.items || {})) for (const [p, v] of Object.entries(t)) ops.push({ op: 'set', item: id, path: p, value: v });
  for (const [id, e] of Object.entries(itemEdits || {})) for (const [p, v] of Object.entries(e)) ops.push({ op: 'set', item: id, path: p, value: v });
  for (const [id, e] of Object.entries(clipEdits || {})) {
    for (const [p, v] of Object.entries(e)) if (!String(v).startsWith('blob:')) ops.push({ op: 'set', clip: id, path: p, value: v });
  }
  return ops;
}
export const hasEdits = ({ itemEdits, clipEdits, timing, structEdits }) => !isEmpty(itemEdits) || !isEmpty(clipEdits)
  || !isEmpty(structEdits) || !isEmpty(timing?.items) || !isEmpty(timing?.channels);

/**
 * The project as it stands on the page, ready to leave it: blob: URLs (pictures picked on the page) become
 * files in the asset map. Returns { project, assets }.
 */
export async function bakeForExport(project, assets) {
  const out = clone(project);
  const files = { ...(assets && typeof assets === 'object' ? assets : {}) };
  const seen = new Map();
  let n = 0;
  const blobToRef = async (url) => {
    if (seen.has(url)) return seen.get(url);
    const blob = await (await fetch(url)).blob();
    const ext = (blob.type.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
    const ref = `asset:page/picture-${(n += 1)}.${ext}`;
    files[ref] = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = no; r.readAsDataURL(blob); });
    seen.set(url, ref);
    return ref;
  };
  const walk = async (node) => {
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i += 1) node[i] = typeof node[i] === 'string' && node[i].startsWith('blob:') ? await blobToRef(node[i]) : (await walk(node[i]), node[i]); return; }
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        if (typeof node[k] === 'string' && node[k].startsWith('blob:')) node[k] = await blobToRef(node[k]);
        else await walk(node[k]);
      }
    }
  };
  await walk(out);
  return { project: out, assets: files };
}

// Where a ref's file sits in a project folder: the CLI's assets/ layout, which GreenLight Dash's importer reads back
// (backend motion_light.py _asset_keys). Refs nothing can be stored for (a web address) stay refs.
function folderPathOf(ref) {
  const rel = ref.startsWith('asset:') ? ref.slice('asset:'.length)
    : /^\/(media|hdr)\//.test(ref) ? ref.slice(1)
      : ref.startsWith('motion-engine-unbundled:') ? `models/${ref.slice('motion-engine-unbundled:'.length)}`
        : null;
  return rel && !rel.split('/').some((p) => !p || p === '.' || p === '..') ? rel : null;
}

/**
 * PROJECT (with its files, as bakeForExport hands them) as a .glvideo: a project folder in one zip —
 * glvideo.json (what the file is), project.json, assets/<each file>. Stored, not compressed: the files are
 * pictures and sounds, and the project is small. Returns the file's bytes.
 */
export async function glvideoFile({ title, project, assets }) {
  const files = [
    { name: 'glvideo.json', data: JSON.stringify({ format: 'glvideo', version: 1, title: title || project?.name || '' }) },
    { name: 'project.json', data: JSON.stringify(project) },
  ];
  const stored = new Set();
  for (const [ref, src] of Object.entries(assets && typeof assets === 'object' ? assets : {})) {
    const rel = folderPathOf(ref);
    if (!rel || stored.has(rel) || typeof src !== 'string' || !/^(data|blob):/.test(src)) continue;
    stored.add(rel);
    files.push({ name: `assets/${rel}`, data: new Uint8Array(await (await fetch(src)).arrayBuffer()) });
  }
  return zipStore(files);
}
