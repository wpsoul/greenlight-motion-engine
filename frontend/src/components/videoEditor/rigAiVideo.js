/*
 * Scene Rig ▸ AI video — pure logic (no React, no API), so `node --test` can load it.
 *
 * The flow it supports:
 *   1. The rig's set (camera + rig + 3D-object channels) is rendered over the rig's
 *      time window — the PRERENDER — and becomes the source video, @video1.
 *   2. An Omni model (catalog model_type 'omni': every one takes a video input) gets
 *      @video1, optional reference images (@image1…) and a prompt.
 *   3. Every run is a TAKE kept on the rig item; using one places the generated
 *      video over the rig's window, above the 3D layers, which stay underneath.
 *
 * The rig item stores all of it as `rigAi` (sanitizeRigAi is the whitelist).
 */

import { multiMediaPostKey } from '../../ai/mediaParams.js';

export const RIG_AI_DEFAULT_PROMPT =
  'Re-shoot @video1 as a real, photographic shot. Keep its camera move, framing and blocking exactly — replace the grey stand-ins with real objects.';
export const RIG_AI_DEFAULT_PROMPT_WITH_REFS =
  'Re-shoot @video1 as a real, photographic shot. Keep its camera move, framing and blocking exactly — replace the grey stand-ins with real objects that match @image1.';

const MEDIA_FIELD_TYPES = new Set(['image', 'video', 'audio', 'media']);
const MAX_TAKES = 30;
const MAX_REFS = 30;

// ── models ──────────────────────────────────────────────────────────────────

/** The models AI video can drive: Omni ones, i.e. those that take a video. */
export function rigAiModels(models) {
  return (models || []).filter((m) => m?.model_type === 'omni' && rigAiVideoField(m));
}

export function rigAiVideoField(model) {
  return (model?.fields || []).find((f) => f.field_type === 'video') || null;
}

export function rigAiImageField(model) {
  return (model?.fields || []).find((f) => f.field_type === 'image') || null;
}

/** A model that REQUIRES the video edits it (and keeps its length) rather than
 *  taking it as a reference. */
export function isRigAiEditModel(model) {
  return rigAiVideoField(model)?.required === true;
}

/** How many reference images the model takes (0 = none). */
export function rigAiMaxRefs(model) {
  const f = rigAiImageField(model);
  if (!f) return 0;
  return Number.isFinite(f.max_files) && f.max_files > 0 ? Math.floor(f.max_files) : 1;
}

function durationField(model) {
  return (model?.fields || []).find((f) => (f.key === 'duration' || f.key === 'duration_seconds') && f.options?.length) || null;
}

/** Lengths (seconds) the model offers, ascending — null when it makes its own
 *  (a video-edit model follows its source). */
export function rigAiDurationOptions(model) {
  const f = durationField(model);
  if (!f) return null;
  const secs = [...new Set(f.options
    .map((o) => parseFloat(String(typeof o === 'object' ? o?.value : o).replace(/[^\d.]/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
  return secs.length ? secs : null;
}

/** The option nearest `seconds` (the rig's length, by default). */
export function rigAiSnapLength(model, seconds) {
  const opts = rigAiDurationOptions(model);
  if (!opts) return null;
  const want = Number.isFinite(seconds) && seconds > 0 ? seconds : opts[0];
  return opts.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
}

function parseRatio(value) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(value ?? ''));
  if (!m) return null;
  const r = Number(m[1]) / Number(m[2]);
  return Number.isFinite(r) && r > 0 ? r : null;
}

function nearestRatio(options, target) {
  let best = null; let bestDist = Infinity;
  for (const o of options || []) {
    const raw = typeof o === 'object' ? o?.value : o;
    const r = parseRatio(raw);
    if (!r) continue;
    const d = Math.abs(Math.log(r / target));
    if (d < bestDist) { best = raw; bestDist = d; }
  }
  return best;
}

/**
 * The /api/ai/generate params for one take.
 *
 * Mirrors the Generate panel's conventions: every non-media field at its default
 * (several Omni models declare required selects), ONE video sent as a bare string
 * under its declared key, one image the same way and several as a list under the
 * shared list-key rule (multiMediaPostKey), the duration snapped to an option, the
 * aspect ratio matched to the project.
 */
export function buildRigAiParams(model, { prompt, videoUrl, refs = [], seconds, videoSize } = {}) {
  const fields = model?.fields || [];
  const params = {};
  for (const f of fields) {
    if (f.key === 'prompt' || MEDIA_FIELD_TYPES.has(f.field_type)) continue;
    if (f.default !== null && f.default !== undefined) params[f.key] = f.default;
  }

  const video = rigAiVideoField(model);
  if (video && videoUrl) params[video.key] = videoUrl;

  const imageField = rigAiImageField(model);
  const images = (refs || []).filter(Boolean).slice(0, rigAiMaxRefs(model));
  if (imageField && images.length === 1) params[imageField.key] = images[0];
  else if (imageField && images.length > 1) params[multiMediaPostKey(model, imageField)] = images;

  if (fields.some((f) => f.key === 'prompt')) {
    params.prompt = (prompt && prompt.trim()) || (images.length ? RIG_AI_DEFAULT_PROMPT_WITH_REFS : RIG_AI_DEFAULT_PROMPT);
  }

  const dur = durationField(model);
  if (dur) {
    const want = rigAiSnapLength(model, seconds);
    const raw = dur.options.find((o) => parseFloat(String(typeof o === 'object' ? o?.value : o).replace(/[^\d.]/g, '')) === want);
    if (raw != null) params[dur.key] = typeof raw === 'object' ? raw.value : raw;
  }

  if (videoSize?.w > 0 && videoSize?.h > 0) {
    const target = videoSize.w / videoSize.h;
    const aspect = fields.find((f) => (f.key === 'aspect_ratio' || f.key === 'ratio') && f.options?.length);
    const pick = aspect ? nearestRatio(aspect.options, target) : null;
    if (pick != null) params[aspect.key] = pick;
  }
  return params;
}

/** Estimated cost in USD for a take of `seconds`, or null when the provider bills
 *  it itself / the catalog has no price. Same rules as the Generate panel's quote
 *  at default settings. */
export function rigAiCost(model, seconds) {
  const base = Number(model?.price_per_generation);
  if (!(base > 0)) return null;
  if (model.price_unit !== 'per_second') return base;
  const res = (model.fields || []).find((f) => f.key === 'resolution');
  const mult = model.price_resolution_mult && res ? (model.price_resolution_mult[res.default] ?? 1) : 1;
  let s = Math.max(Number(seconds) || 0, model.price_min_seconds || 0);
  if (model.price_max_seconds) s = Math.min(s, model.price_max_seconds);
  return base * s * mult;
}

// ── the source (prerender) ──────────────────────────────────────────────────

/** The channels a scene prerender renders: the camera, the rig, and every
 *  channel holding a 3D model layer. */
export function rigSceneChannelIds(channels, clips) {
  const modelClipIds = new Set((clips || []).filter((c) => c?.mediaType === 'model3d').map((c) => c.id));
  return (channels || [])
    .filter((ch) => ch && (ch.kind === 'camera' || ch.kind === 'rig'
      || (ch.items || []).some((it) => modelClipIds.has(it.clipId))))
    .map((ch) => ch.id);
}

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/**
 * Fingerprint of what a prerender would show. A stored source whose hash differs
 * is "out of date". Fields that change nothing on screen are left out — above all
 * the rig item's own `rigAi` (takes arriving must not stale the source).
 */
export function rigSceneHash(channels, clips, { videoSize, window } = {}) {
  const ids = new Set(rigSceneChannelIds(channels, clips));
  const scene = (channels || []).filter((ch) => ids.has(ch.id)).map((ch) => ({
    id: ch.id,
    visible: ch.visible !== false,
    items: (ch.items || []).map(({ rigAi: _a, rigLook: _l, cameraPreset: _c, prerender: _p, customName: _n, ...rest }) => rest),
  }));
  const used = new Set(scene.flatMap((ch) => ch.items.map((it) => it.clipId)));
  const sceneClips = (clips || []).filter((c) => used.has(c.id)).map((c) => ({ id: c.id, url: c.url, mediaType: c.mediaType }));
  return fnv(JSON.stringify({ scene, sceneClips, size: videoSize || null, window: window || null }));
}

// ── persistence ─────────────────────────────────────────────────────────────

const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null;
};

function sanitizeTake(t) {
  if (!t || typeof t !== 'object' || !str(t.id, 80) || !str(t.resultUrl, 2000)) return null;
  return {
    id: str(t.id, 80),
    n: Math.max(1, Math.round(num(t.n, 1, 9999) || 1)),
    modelId: str(t.modelId, 200),
    modelName: str(t.modelName, 200),
    resultUrl: str(t.resultUrl, 2000),
    proxyUrl: str(t.proxyUrl, 2000),
    thumbnailUrl: str(t.thumbnailUrl, 2000),
    duration: num(t.duration, 0.1, 600) || 5,
    prompt: str(t.prompt, 4000),
    clipId: str(t.clipId, 80),
    createdAt: num(t.createdAt, 0, 9e15),
  };
}

/** Whitelist for the rig item's `rigAi` field. Only READY takes persist — a run in
 *  flight or a failure is session state, like AI Fill's. */
export function sanitizeRigAi(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw.source && typeof raw.source === 'object' && str(raw.source.url, 2000)
    ? {
        url: str(raw.source.url, 2000),
        proxyUrl: str(raw.source.proxyUrl, 2000),
        thumbnailUrl: str(raw.source.thumbnailUrl, 2000),
        duration: num(raw.source.duration, 0.1, 600) || null,
        hash: str(raw.source.hash, 40),
      }
    : null;
  const takes = (Array.isArray(raw.takes) ? raw.takes : []).map(sanitizeTake).filter(Boolean).slice(-MAX_TAKES);
  const placed = raw.placed && typeof raw.placed === 'object' && str(raw.placed.itemId, 80) && str(raw.placed.takeId, 80)
    ? { itemId: str(raw.placed.itemId, 80), takeId: str(raw.placed.takeId, 80) }
    : null;
  const out = {
    modelId: str(raw.modelId, 200),
    prompt: typeof raw.prompt === 'string' ? raw.prompt.slice(0, 4000) : null,
    length: num(raw.length, 1, 600),
    refs: (Array.isArray(raw.refs) ? raw.refs : []).map((r) => str(r, 2000)).filter(Boolean).slice(0, MAX_REFS),
    source: src,
    takes,
    nextTakeN: Math.max(1, Math.round(num(raw.nextTakeN, 1, 99999) || (takes.length ? Math.max(...takes.map((t) => t.n)) + 1 : 1))),
    placed: placed && takes.some((t) => t.id === placed.takeId) ? placed : null,
  };
  return out;
}
