// Smart Zoom in the editor — the camera panel's Zoom mode.
//
// A camera item in mode 'smartZoom' (the Movement tab "Zoom") zooms in over ZOOM RANGES:
//   item.smartZoom = { clipId, preset, ranges? }
// - clipId: the screen recording it follows (null: a plain Zoom camera, ranges placed by hand).
// - preset: the Motion preset (Studio, Calm, …): the spring, the default zoom, how a range aims.
// - ranges: [{ id, startMs, endMs, zoom?, mode: 'follow' | 'fixed', point?, disabled? }]. Absent = automatic, made
//   from the recording's clicks. The first edit copies the automatic list (same ids) and edits that. Times are the
//   recording's SOURCE ms, so trimming earlier footage keeps a zoom on its moment; with no recording they are the
//   camera clip's own ms. A 'fixed' range centres the view exactly on `point` (0..1 of the frame).
// smartZoom.js does the maths. This file adapts it to the timeline: it maps the recording's items (trims, splits,
// speed) to the maths' edit, caches the plan, and writes camZoom / camX / camY. Nothing is baked into keyframes, so
// trimming or moving the recording re-aims the camera, and preview, scrubbing and export evaluate the same curve.
//
// The camera simulates in TIMELINE time (a cut or a speed change never jumps it); its targets live in the recording's
// SOURCE time. Outside the recording's items the camera rests (zoom 1, centred).
import { CAMERA_DEFAULTS, ZOOM_ZONE_MAX_MS, autoRanges, buildCameraPlan, evalCamera, presetById, takeFromEventTrack, zoomZoneMs } from './smartZoom.js';
import { getTimelineDuration, getTimelineLayout, mapTimelineToSource } from './speedUtils.js';
import { sanitizeCameraRef } from './cameraTargets.js';

export const SMART_ZOOM_MODE = 'smartZoom';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export const ZOOM_RANGE_DEFAULT_MS = 2400;
export const ZOOM_RANGE_MIN_MS = 400;
export const ZOOM_MIN = 1.05;
export const ZOOM_MAX = 4;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r4 = (v) => Math.round(v * 1e4) / 1e4;

const zoneField = (key, v) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0
  ? { [key]: Math.round(Math.min(ZOOM_ZONE_MAX_MS, Number(v))) } : {});

/** Zoom ranges as saved: known fields, in range, sorted by start. undefined for "not a list" (= automatic). */
export function sanitizeZoomRanges(list) {
  if (!Array.isArray(list)) return undefined;
  const out = [];
  const ids = new Set();
  for (const r of list.slice(0, 200)) {
    if (!r || typeof r !== 'object') continue;
    const s = Number(r.startMs);
    const e = Number(r.endMs);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e - s < 100) continue;
    let id = typeof r.id === 'string' && r.id ? r.id.slice(0, 40) : `z${out.length + 1}`;
    while (ids.has(id)) id = `${id}x`;
    ids.add(id);
    const z = Number(r.zoom);
    const p = r.point && Number.isFinite(Number(r.point.x)) && Number.isFinite(Number(r.point.y))
      ? { x: r4(clamp(Number(r.point.x), 0, 1)), y: r4(clamp(Number(r.point.y), 0, 1)) }
      : null;
    out.push({
      id,
      startMs: Math.max(0, Math.round(s)),
      endMs: Math.round(e),
      ...(Number.isFinite(z) && z >= 1 ? { zoom: Math.round(clamp(z, 1, ZOOM_MAX) * 1000) / 1000 } : {}),
      mode: r.mode === 'fixed' ? 'fixed' : 'follow',
      ...(p ? { point: p } : {}),
      // (camlayer) what a zoom on a posed camera (a 3D Scene's shot) turns to and follows: a Scene object "@<id>", a layer, a point
      ...(sanitizeCameraRef(r.target) ? { target: sanitizeCameraRef(r.target) } : {}),
      // its ease zones (smartZoom.zoomZoneMs): set off this long before the start / be back at rest this long after the end
      ...zoneField('leadMs', r.leadMs),
      ...zoneField('releaseMs', r.releaseMs),
      ...(r.disabled ? { disabled: true } : {}),
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Strict sanitizer, same spread contract as sanitizeCameraRig: `{}` for an item without Zoom. An unknown preset
 *  becomes the default (Studio). A camera with no recording keeps its Zoom only while in Zoom mode or with ranges. */
export function sanitizeSmartZoom(item) {
  const raw = item?.smartZoom;
  if (!raw || typeof raw !== 'object') return {};
  const clipId = typeof raw.clipId === 'string' && raw.clipId ? raw.clipId.slice(0, 120) : null;
  const ranges = sanitizeZoomRanges(raw.ranges);
  if (!clipId && !ranges && item?.cameraMoveMode !== SMART_ZOOM_MODE) return {};
  return { smartZoom: { clipId, preset: presetById(raw.preset).id, ...(ranges ? { ranges } : {}) } };
}

const constantSpeed = (points) => !Array.isArray(points) || points.length < 2
  || points.every((p) => Math.abs(num(p?.y, 1) - num(points[0]?.y, 1)) < 1e-9);

/**
 * The linked recording's pieces on the timeline, as the maths' edit ([{ sourceStartMs, sourceEndMs, timeScale,
 * outputStartMs }], timeline order). Every item of `clipId` on any channel counts. A constant-speed item is one
 * piece; a speed ramp is cut into ~100 ms pieces, close enough that the camera can't tell. The source mapping is
 * the video's own (motionTracking.compTimeToSourceTime / Player's calculateVideoTime). Overlapping pieces (the same
 * recording twice at once) keep the earlier one.
 */
export function smartZoomEditFor(channels, layoutFor, clipId) {
  const pieces = [];
  for (const ch of channels || []) {
    const items = ch?.items || [];
    if (!items.some((it) => it?.clipId === clipId)) continue;
    const layout = layoutFor(ch);
    if (!layout) continue;
    items.forEach((it, i) => {
      if (it?.clipId !== clipId) return;
      const entry = layout[i];
      if (!entry) return;
      const trimStart = num(it.trimStart, 0);
      const srcDur = num(it.trimEnd, 0) - trimStart;
      if (!(srcDur > 0)) return;
      const tlDur = getTimelineDuration(srcDur, it.speedPoints);
      if (!(tlDur > 0)) return;
      const start = num(entry.startTime, 0);
      const n = constantSpeed(it.speedPoints) ? 1 : Math.min(400, Math.max(8, Math.ceil(tlDur / 0.1)));
      for (let k = 0; k < n; k += 1) {
        const a = k / n;
        const b = (k + 1) / n;
        const sa = trimStart + mapTimelineToSource(it.speedPoints, a) * srcDur;
        const sb = trimStart + mapTimelineToSource(it.speedPoints, b) * srcDur;
        const oa = start + a * tlDur;
        const ob = start + b * tlDur;
        if (!(sb > sa) || !(ob > oa)) continue;
        pieces.push({ sourceStartMs: sa * 1000, sourceEndMs: sb * 1000, timeScale: (sb - sa) / (ob - oa), outputStartMs: oa * 1000 });
      }
    });
  }
  pieces.sort((p, q) => p.outputStartMs - q.outputStartMs);
  const out = [];
  let end = -Infinity;
  for (const p of pieces) {
    let q = p;
    if (q.outputStartMs < end - 1e-6) {
      const cut = end - q.outputStartMs;
      const outLen = (q.sourceEndMs - q.sourceStartMs) / q.timeScale;
      if (cut >= outLen - 1e-6) continue;
      q = { ...q, sourceStartMs: q.sourceStartMs + cut * q.timeScale, outputStartMs: end };
    }
    out.push(q);
    end = q.outputStartMs + (q.sourceEndMs - q.sourceStartMs) / q.timeScale;
  }
  return out;
}

// A small FNV-1a over the numbers that shape a plan, so the per-frame cache lookup never builds long strings.
function hashEdit(edit, seed) {
  let h = 2166136261 ^ seed.length;
  const mix = (v) => {
    const x = Math.round(v * 10);
    h ^= x & 0xffff;
    h = Math.imul(h, 16777619);
    h ^= (x >>> 16) & 0xffff;
    h = Math.imul(h, 16777619);
  };
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  for (const p of edit) {
    mix(p.sourceStartMs);
    mix(p.sourceEndMs);
    mix(p.outputStartMs);
    mix(p.timeScale * 10000); // same trims at another speed is another plan
  }
  return `${h >>> 0}:${edit.length}`;
}

const planCache = new Map(); // key → { track, plan }
const CACHE_MAX = 24;

const rangesKey = (list) => (list
  ? list.map((r) => `${r.id}:${r.startMs}:${r.endMs}:${r.zoom || ''}:${r.mode || ''}:${r.point ? `${r.point.x},${r.point.y}` : ''}:${r.disabled ? 1 : 0}:${r.target ? JSON.stringify(r.target) : ''}:${r.leadMs ?? ''}:${r.releaseMs ?? ''}`).join(';')
  : 'auto');
const emptyTake = (durationMs) => ({ durationMs, width: 1920, height: 1080, moves: { t: [], x: [], y: [], s: [] }, shapes: ['arrow'], clicks: [] });

/** The camera plan for a Zoom item, or null (nothing to zoom over). Cached by the recording's track object, the
 *  preset, the ranges and the edit, so evaluating a frame is a lookup plus one formula. */
export function smartZoomPlan(item, recordingClip, edit) {
  if (!Array.isArray(edit) || !edit.length) return null;
  const sz = item?.smartZoom || {};
  const own = Array.isArray(sz.ranges) ? sz.ranges : null;
  const preset = presetById(sz.preset);
  const track = sz.clipId ? recordingClip?.recordingMeta || null : null;
  // A recording without its click track (or no recording at all) can still zoom over ranges placed by hand.
  if (!track && !own) return null;
  const durationMs = sz.clipId ? num(recordingClip?.duration, 0) * 1000 : edit[0].sourceEndMs;
  const key = hashEdit(edit, `${sz.clipId || '-'}|${preset.id}|${durationMs}|${rangesKey(own)}`);
  const hit = planCache.get(key);
  if (hit && hit.track === track) return hit.plan;
  const take = track ? takeFromEventTrack(track, durationMs) : emptyTake(durationMs);
  if (!take) return null;
  // (camlayer) a range with a target zooms about the middle of the frame: the camera turns its head to the target (projectCamera.js
  // applyZoomLens), the plan only carries the zoom's spring
  const ranges = own ? own.map((r) => (r.target ? { ...r, mode: 'fixed', point: { x: 0.5, y: 0.5 } } : r)) : own;
  const plan = buildCameraPlan({ take, settings: preset.camera, slices: edit, ranges });
  planCache.set(key, { track, plan });
  if (planCache.size > CACHE_MAX) planCache.delete(planCache.keys().next().value);
  return plan;
}

// Where a camera item sits on the timeline (ms), or null.
function cameraItemSpan(item, channels, layoutFor) {
  for (const ch of channels || []) {
    const i = (ch?.items || []).findIndex((it) => it?.id === item?.id);
    if (i < 0) continue;
    const e = layoutFor(ch)?.[i];
    return e ? { startMs: num(e.startTime, 0) * 1000, durMs: (num(e.endTime, 0) - num(e.startTime, 0)) * 1000 } : null;
  }
  return null;
}

/** The edit a Zoom camera runs on: its recording's pieces, or (no recording) its own clip, where source = the
 *  camera's own time. */
export function smartZoomEditForItem(item, channels, layoutFor) {
  const clipId = item?.smartZoom?.clipId;
  if (clipId) return smartZoomEditFor(channels, layoutFor, clipId);
  const span = cameraItemSpan(item, channels, layoutFor);
  return span && span.durMs > 0 ? [{ sourceStartMs: 0, sourceEndMs: span.durMs, timeScale: 1, outputStartMs: span.startMs }] : [];
}

/** What resolveCameraPose hands getCameraPose for a Zoom camera: the plan and the timeline time. */
export function smartZoomFrame(item, channels, clipsMap, layoutFor, time) {
  if (!item?.smartZoom) return null;
  const edit = smartZoomEditForItem(item, channels, layoutFor);
  const plan = smartZoomPlan(item, item.smartZoom.clipId ? clipsMap.get(item.smartZoom.clipId) : null, edit);
  // (camlayer) the source time playing now, for which target range the camera turns to
  return plan ? { plan, timeMs: time * 1000, sourceMs: zoomSourceAt(edit, time) } : null;
}

/**
 * (camlayer) A Zoom camera's state at this frame for a posed camera (projectCamera.js applyZoomLens): the zoom's spring (`zoom`, ≥ 1),
 * the point of the frame it centres (`cx`, `cy`, 0..1, of the camera's view before the zoom), and the governing range's `target` (null:
 * the range aims by cx/cy) with how far the zoom has come into it (`share`, 0..1). Between two ranges: `target2`, `share2`, `mix`.
 * Null without a plan.
 */
export function smartZoomLensState(item, frame) {
  if (item?.cameraMoveMode !== SMART_ZOOM_MODE) return null;
  const sz = frame?.smartZoom;
  if (!sz?.plan) return null;
  const c = evalCamera(sz.plan, sz.timeMs, {});
  const out = { zoom: c.zoom, cx: c.cx, cy: c.cy, target: null, share: 0 };
  const src = sz.sourceMs;
  // Every range takes part: one with a target turns the camera to it, one without aims by its own point (cx, cy: what
  // the preview drag sets). Only targets were looked at once, so a range without one borrowed its neighbour's target and
  // dragging it did nothing.
  const ranges = (item.smartZoom?.ranges || []).filter((r) => !r.disabled).sort((a, b) => a.startMs - b.startMs);
  if (ranges.some((r) => r.target) && Number.isFinite(src)) {
    const shareOf = (r) => {
      if (!r.target) return 0;
      const zr = Math.max(1, Number(r.zoom) > 0 ? Number(r.zoom) : num(sz.plan.settings?.zoom, 1));
      return zr > 1 + 1e-6 ? clamp((c.zoom - 1) / (zr - 1), 0, 1) : (c.zoom > 1 + 1e-6 ? 1 : 0);
    };
    const inside = ranges.find((r) => src >= r.startMs && src <= r.endMs);
    const prev = inside ? null : ranges.filter((r) => r.endMs < src).pop() || null;
    const next = inside ? null : ranges.find((r) => r.startMs > src) || null;
    if (inside || !prev || !next || (!prev.target && !next.target)) {
      const r = inside || (prev && next ? null : prev || next);
      out.target = r?.target || null;
      out.share = r ? shareOf(r) : 0;
    } else {
      // Between two zooms the turn hands over from the last zoom's target to the next one's as a blend, never a step:
      // across the rest between their ease zones (the previous one's release, the next one's lead), or, where those
      // zones overlap, across the overlap. Choosing the nearer range here made the aim jump at the gap's middle
      // while the camera was still coming back from the last zoom.
      const zones = new Map((sz.plan.zones || []).map((z) => [z.id, z]));
      const relEnd = prev.endMs + num(zones.get(prev.id)?.releaseMs, 0);
      const leadStart = next.startMs - num(zones.get(next.id)?.leadMs, 0);
      let a = relEnd;
      let b = leadStart;
      if (!(b - a > 1)) {
        a = Math.max(prev.endMs, leadStart);
        b = Math.min(next.startMs, relEnd);
        if (!(b - a > 1)) { a = prev.endMs; b = next.startMs; }
      }
      const u = clamp((src - a) / Math.max(1, b - a), 0, 1);
      out.target = prev.target || null;
      out.share = shareOf(prev);
      out.target2 = next.target || null;
      out.share2 = shareOf(next);
      out.mix = u * u * (3 - 2 * u);
    }
  }
  return out;
}

/** Each zoom range's ease zones in ms of its own time (smartZoom.zoomZoneMs) for the Motion preset `presetId`:
 *  Map id → { leadMs, releaseMs, settleMs }. */
export function zoomZonesFor(ranges, presetId) {
  const settings = { ...CAMERA_DEFAULTS, ...presetById(presetId).camera };
  return new Map((ranges || []).map((r) => [r.id, zoomZoneMs(r, settings)]));
}

/** range → its ease zones under preset `presetId` (a range not in `zones`, such as one about to be added, gets the
 *  preset's own). For addZoomRange / moveZoomRange's `zoneOf`. */
export function zoomZoneFn(zones, presetId) {
  const settings = { ...CAMERA_DEFAULTS, ...presetById(presetId).camera };
  return (r) => zones?.get?.(r?.id) || zoomZoneMs(r || {}, settings);
}

/** The most a range's `leadMs` / `releaseMs` may be without easing into its neighbours' zones (ms), and the least
 *  release the spring allows (`minReleaseMs`). */
export function zoomZoneRoom(ranges, id, zoneOf) {
  const list = (ranges || []).slice().sort((a, b) => a.startMs - b.startMs);
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const r = list[i];
  const own = zoneOf(r);
  const prev = list[i - 1];
  const next = list[i + 1];
  return {
    maxLeadMs: Math.max(0, Math.min(ZOOM_ZONE_MAX_MS, prev ? r.startMs - prev.endMs - num(zoneOf(prev).releaseMs, 0) : r.startMs)),
    maxReleaseMs: Math.max(num(own.settleMs, 0), Math.min(ZOOM_ZONE_MAX_MS, next ? next.startMs - num(zoneOf(next).leadMs, 0) - r.endMs : ZOOM_ZONE_MAX_MS)),
    minReleaseMs: num(own.settleMs, 0),
  };
}

/** (camlayer) Whether a Zoom camera has a range with a target (it is a 3D shot's zoom: a turn and a lens). */
export function smartZoomHasTargets(item) {
  return (item?.smartZoom?.ranges || []).some((r) => r.target && !r.disabled);
}

// ── Zoom ranges in the editor (the camera layer's blocks, the panel, the preview's gestures) ────────────────────
const autoCache = new WeakMap(); // track → Map(key → list)

/** The ranges a Zoom camera runs and whether they are the automatic ones (ids r1, r2… — the first edit keeps them). */
export function zoomRangesOf(item, recordingClip) {
  const sz = item?.smartZoom;
  if (!sz) return { ranges: [], auto: false };
  if (Array.isArray(sz.ranges)) return { ranges: sz.ranges, auto: false };
  const track = sz.clipId ? recordingClip?.recordingMeta : null;
  if (!track || typeof track !== 'object') return { ranges: [], auto: !!sz.clipId };
  const preset = presetById(sz.preset);
  const durationMs = num(recordingClip?.duration, 0) * 1000;
  const key = `${preset.id}|${durationMs}`;
  let byKey = autoCache.get(track);
  if (!byKey) { byKey = new Map(); autoCache.set(track, byKey); }
  let list = byKey.get(key);
  if (!list) {
    const take = takeFromEventTrack(track, durationMs);
    list = take
      ? autoRanges(take.clicks, durationMs, { ...CAMERA_DEFAULTS, ...preset.camera })
        .map((r, i) => ({ id: `r${i + 1}`, startMs: Math.round(r.startMs), endMs: Math.round(r.endMs), mode: 'follow' }))
      : [];
    byKey.set(key, list);
  }
  return { ranges: list, auto: true };
}

/** Each range where it plays on the timeline (seconds): one entry per stretch of the edit it falls in, so a range a
 *  split cuts in two shows as two blocks with the same id. `n` is its number (1-based). With `zones`
 *  (zoomZonesFor) a block also carries its ease zones on the timeline: `leadSec` before its start, `releaseSec` after
 *  its end (0 where the block is cut there). */
export function zoomRangesOnTimeline(ranges, edit, zones = null) {
  const out = [];
  (ranges || []).forEach((r, i) => {
    const zone = zones?.get?.(r.id) || null;
    for (const p of edit || []) {
      const a = Math.max(r.startMs, p.sourceStartMs);
      const b = Math.min(r.endMs, p.sourceEndMs);
      if (!(b > a)) continue;
      out.push({
        id: r.id,
        n: i + 1,
        startSec: (p.outputStartMs + (a - p.sourceStartMs) / p.timeScale) / 1000,
        endSec: (p.outputStartMs + (b - p.sourceStartMs) / p.timeScale) / 1000,
        clippedStart: a > r.startMs,
        clippedEnd: b < r.endMs,
        leadSec: zone && !(a > r.startMs) ? num(zone.leadMs, 0) / p.timeScale / 1000 : 0,
        releaseSec: zone && !(b < r.endMs) ? num(zone.releaseMs, 0) / p.timeScale / 1000 : 0,
      });
    }
  });
  return out;
}

/** Timeline seconds → the source ms playing there, or null where the recording isn't on screen. */
export function zoomSourceAt(edit, timeSec) {
  const t = timeSec * 1000;
  for (const p of edit || []) {
    const len = (p.sourceEndMs - p.sourceStartMs) / p.timeScale;
    if (t >= p.outputStartMs - 1e-6 && t <= p.outputStartMs + len + 1e-6) return p.sourceStartMs + (t - p.outputStartMs) * p.timeScale;
  }
  return null;
}

const nextZoomId = (list) => {
  let n = 0;
  for (const r of list) { const m = /^[rz](\d+)$/.exec(r.id || ''); if (m) n = Math.max(n, Number(m[1])); }
  return `z${n + 1}`;
};

/** A new range starting at source ms `atMs`, the default length but never into its neighbour (or past `limitMs`).
 *  With `zoneOf` (range → { leadMs, releaseMs }, zoomZonesFor) it also keeps out of the neighbours' ease zones and
 *  keeps its own out of theirs. → { ranges, range }, or null when it would land on a range or has no room. */
export function addZoomRange(ranges, atMs, { lengthMs = ZOOM_RANGE_DEFAULT_MS, limitMs = Infinity, zoneOf = null } = {}) {
  const list = (ranges || []).slice().sort((a, b) => a.startMs - b.startMs);
  if (!Number.isFinite(atMs) || list.some((r) => atMs >= r.startMs && atMs < r.endMs)) return null;
  const zone = (r) => (zoneOf ? zoneOf(r) || {} : {});
  const prev = list.filter((r) => r.endMs <= atMs).pop();
  const own = zone({ id: '__new__' });
  if (prev && atMs - num(own.leadMs, 0) < prev.endMs + num(zone(prev).releaseMs, 0)) return null; // in the last one's release
  const next = list.find((r) => r.startMs > atMs);
  const end = Math.min(atMs + lengthMs, next ? next.startMs - num(zone(next).leadMs, 0) - num(own.releaseMs, 0) : Infinity, limitMs);
  if (end - atMs < ZOOM_RANGE_MIN_MS) return null;
  const range = { id: nextZoomId(list), startMs: Math.round(atMs), endMs: Math.round(end), mode: 'follow' };
  return { ranges: [...list, range].sort((a, b) => a.startMs - b.startMs), range };
}

/** Moves / resizes range `id` to [startMs, endMs] (either may be omitted), kept between its neighbours, inside
 *  [0, limitMs] and at least ZOOM_RANGE_MIN_MS long. A move (both edges) keeps the length. */
export function moveZoomRange(ranges, id, { startMs, endMs }, { limitMs = Infinity, zoneOf = null } = {}) {
  const list = (ranges || []).slice().sort((a, b) => a.startMs - b.startMs);
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return list;
  const r = list[i];
  // With zoneOf (range → { leadMs, releaseMs }) a range keeps its lead out of the last range's release and its release
  // out of the next range's lead, so two zooms never ease over each other.
  const zone = (x) => (zoneOf ? zoneOf(x) || {} : {});
  const own = zone(r);
  let lo = i > 0 ? list[i - 1].endMs + num(zone(list[i - 1]).releaseMs, 0) + num(own.leadMs, 0) : 0;
  let hi = i + 1 < list.length ? list[i + 1].startMs - num(zone(list[i + 1]).leadMs, 0) - num(own.releaseMs, 0) : limitMs;
  // Neighbours already easing into this range (an older project, a release made longer): too little room to keep
  // the zones apart falls back to the plain neighbour limits rather than squeezing the range.
  const need = Number.isFinite(startMs) && Number.isFinite(endMs) ? r.endMs - r.startMs : ZOOM_RANGE_MIN_MS;
  if (hi - lo < need) {
    lo = i > 0 ? list[i - 1].endMs : 0;
    hi = i + 1 < list.length ? list[i + 1].startMs : limitMs;
  }
  let s = Number.isFinite(startMs) ? startMs : r.startMs;
  let e = Number.isFinite(endMs) ? endMs : r.endMs;
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    const len = Math.min(e - s, hi - lo);
    s = clamp(s, lo, hi - len);
    e = s + len;
  } else {
    s = clamp(s, lo, e - ZOOM_RANGE_MIN_MS);
    e = clamp(e, s + ZOOM_RANGE_MIN_MS, hi);
  }
  list[i] = { ...r, startMs: Math.round(s), endMs: Math.round(e) };
  return list;
}

/** Range `id` with `patch` merged (zoom / mode / point / disabled); `undefined` values remove the field. */
export function patchZoomRange(ranges, id, patch) {
  return (ranges || []).map((r) => {
    if (r.id !== id) return r;
    const next = { ...r, ...patch };
    for (const k of Object.keys(patch || {})) if (patch[k] === undefined) delete next[k];
    return next;
  });
}

export function removeZoomRange(ranges, id) {
  return (ranges || []).filter((r) => r.id !== id);
}

/**
 * Writes the Smart Zoom pose into a camera pose's values. The maths gives a view (zoom, centre cx/cy as 0..1 of the
 * frame); the camera pans in screen percent at its own zoom — the same conversion autoZoomToCameraKeyframes uses for
 * the keyframed auto-zoom. Roll, dolly, tilt and depth of field keep coming from the item and its tracks.
 */
export function applySmartZoom(item, values, frame) {
  if (item?.cameraMoveMode !== SMART_ZOOM_MODE) return false;
  const sz = frame?.smartZoom;
  if (!sz?.plan) return false;
  const c = evalCamera(sz.plan, sz.timeMs, {});
  values.camZoom = c.zoom;
  values.camX = (c.cx - 0.5) * 100 * c.zoom;
  values.camY = (c.cy - 0.5) * 100 * c.zoom;
  return true;
}

/**
 * Keeps every Smart Zoom camera clip spanning its recording: from the start of the recording's first piece on the
 * timeline to the end of its last. Runs on every history snapshot and on load (editorState.pinSingletonChannels), so
 * moving, trimming, splitting or rippling the recording carries its camera along, and undo restores both together.
 * Only items still in Smart Zoom mode on an unsnapped camera channel follow; a camera switched to Free stays where the
 * user leaves it. Returns the SAME array when nothing moved.
 */
export function syncSmartZoomCameraSpans(channels) {
  if (!Array.isArray(channels)) return channels;
  const camIdx = channels.findIndex((ch) => ch?.kind === 'camera' && ch.unsnapped
    && (ch.items || []).some((it) => it?.cameraMoveMode === SMART_ZOOM_MODE && it.smartZoom?.clipId));
  if (camIdx < 0) return channels;
  const cam = channels[camIdx];
  const layoutFor = (ch) => getTimelineLayout(ch.items || [], { unsnapped: ch.unsnapped });
  let changed = false;
  const items = cam.items.map((it) => {
    if (it?.cameraMoveMode !== SMART_ZOOM_MODE || !it.smartZoom?.clipId) return it;
    const pieces = smartZoomEditFor(channels.filter((ch) => ch !== cam), layoutFor, it.smartZoom.clipId);
    if (!pieces.length) return it;
    const start = Math.min(...pieces.map((p) => p.outputStartMs)) / 1000;
    const end = Math.max(...pieces.map((p) => p.outputStartMs + (p.sourceEndMs - p.sourceStartMs) / p.timeScale)) / 1000;
    const len = end - start;
    const curLen = getTimelineDuration(num(it.trimEnd, 0) - num(it.trimStart, 0), it.speedPoints);
    if (Math.abs(num(it.freeStart, 0) - start) < 1e-4 && Math.abs(curLen - len) < 1e-4) return it;
    changed = true;
    return { ...it, freeStart: start, trimStart: 0, trimEnd: len, speedPoints: [{ x: 0, y: 1 }, { x: 1, y: 1 }] };
  });
  if (!changed) return channels;
  const next = channels.slice();
  next[camIdx] = { ...cam, items: items.slice().sort((a, b) => num(a.freeStart, 0) - num(b.freeStart, 0)) };
  return next;
}
