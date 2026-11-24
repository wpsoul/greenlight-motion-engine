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

export const RIG_AI_LOOKS = [
  { id: 'blocking', label: 'Clay + Grid', shortLabel: 'Grid' },
  { id: 'clay', label: 'Clay', shortLabel: 'Clay' },
  { id: 'lit', label: 'Lit 3D', shortLabel: 'Lit' },
];
export const RIG_AI_DEFAULT_LOOK = 'blocking';
const VALID_LOOKS = new Set(RIG_AI_LOOKS.map((l) => l.id));
export function normalizeRigAiLook(look) {
  return VALID_LOOKS.has(look) ? look : RIG_AI_DEFAULT_LOOK;
}

export const RIG_AI_DEFAULT_PROMPT =
  'Use @video1 strictly as a 3D camera movement and spatial blocking reference (not as final visuals). Re-shoot as a photorealistic live-action scene, replacing all grey clay blocks, stand-ins, mannequin figures, and floor grids with real objects, people, and environments.';
export const RIG_AI_DEFAULT_PROMPT_WITH_REFS =
  'Use @video1 strictly as a 3D camera movement and spatial blocking reference (not as final visuals). Re-shoot as a photorealistic live-action scene matching the real subjects, styling, and environment from @image1, replacing every grey clay block, mannequin, and floor grid while keeping @video1 camera motion and staging.';
export const RIG_AI_GOOGLE_OMNI_PROMPT =
  'Treat @video1 as a 3D pre-vis blocking pass defining exact camera motion, lens perspective, speed, and spatial staging. Re-shoot it as a real photographic live-action shot with natural lighting, realistic materials, and consistent motion, replacing all clay stand-ins and grid planes while keeping the exact camera trajectory.';
export const RIG_AI_GOOGLE_OMNI_PROMPT_WITH_REFS =
  'Treat @video1 as a 3D pre-vis blocking pass defining exact camera motion, lens perspective, speed, and spatial staging. Re-shoot it as a real photographic live-action shot matching the visual identity, wardrobe, and subjects from the reference images while keeping the exact camera trajectory and blocking from @video1.';

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

export function rigAiResolutionField(model) {
  return (model?.fields || []).find((f) => f.key === 'resolution' && Array.isArray(f.options) && f.options.length) || null;
}

function parseResolutionRank(raw) {
  const s = String(typeof raw === 'object' ? raw?.value : raw ?? '').trim().toLowerCase();
  const p = /^(\d+(?:\.\d+)?)p$/.exec(s);
  if (p) return parseFloat(p[1]);
  const k = /^(\d+(?:\.\d+)?)k$/.exec(s);
  if (k) {
    const n = parseFloat(k[1]);
    return n === 4 ? 2160 : n === 2 ? 1440 : Math.round(n * 540);
  }
  const dims = /^(\d+)\s*[x*]\s*(\d+)$/.exec(s);
  if (dims) return Math.min(Number(dims[1]), Number(dims[2]));
  const numOnly = parseFloat(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(numOnly) ? numOnly : Infinity;
}

/** Output resolutions the model offers, sorted lowest to highest. */
export function rigAiResolutionOptions(model) {
  const f = rigAiResolutionField(model);
  if (!f) return null;
  const seen = new Set();
  const list = [];
  for (const o of f.options) {
    const val = String(typeof o === 'object' ? o?.value : o ?? '').trim();
    if (!val || seen.has(val)) continue;
    seen.add(val);
    list.push(val);
  }
  if (!list.length) return null;
  return list.sort((a, b) => parseResolutionRank(a) - parseResolutionRank(b));
}

/** Lowest supported output resolution (used for cheap fast Draft takes). */
export function rigAiDraftResolution(model) {
  const opts = rigAiResolutionOptions(model);
  return opts ? opts[0] : null;
}

export function rigAiStandardResolution(model) {
  const f = rigAiResolutionField(model);
  const opts = rigAiResolutionOptions(model);
  if (!opts) return null;
  const def = f?.default != null ? String(f.default).trim() : null;
  if (def && opts.includes(def)) return def;
  return opts.find((o) => parseResolutionRank(o) >= 720) || opts[opts.length - 1];
}

export function rigAiResolveResolution(model, { draft = false, resolution = null } = {}) {
  const opts = rigAiResolutionOptions(model);
  if (!opts) return null;
  if (draft) return opts[0];
  if (typeof resolution === 'string' && opts.includes(resolution)) return resolution;
  return rigAiStandardResolution(model);
}

/**
 * Compute uniform cover zoom (>= 1) so placed low-res / draft / 720p takes fill
 * 100% of the composition window with zero borders.
 *
 * `videoPlate.js` draws video layers at their native pixel dimensions when smaller
 * than the frame (or contain-fitted when larger), so scaling up uniformly by
 * `max(canvasW / plateW, canvasH / plateH)` makes any resolution fill [cw, ch]
 * edge-to-edge cleanly.
 */
export function rigAiFitWindowZoom(mediaW, mediaH, canvasW, canvasH) {
  const mw = Number(mediaW);
  const mh = Number(mediaH);
  const cw = Number(canvasW);
  const ch = Number(canvasH);
  if (!(mw > 0 && mh > 0 && cw > 0 && ch > 0)) return 1;
  const plateFit = Math.min(1, cw / mw, ch / mh);
  const plateW = mw * plateFit;
  const plateH = mh * plateFit;
  if (!(plateW > 0 && plateH > 0)) return 1;
  const coverZoom = Math.max(cw / plateW, ch / plateH);
  if (!(coverZoom > 1)) return 1;
  return Math.min(20, Math.round(coverZoom * 10000) / 10000);
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
export function buildRigAiParams(model, {
  prompt, videoUrl, refs = [], seconds, videoSize, previousInteractionId, draft = false, resolution = null,
} = {}) {
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
    const isGoogleOmni = model?.provider === 'google' || String(model?.id || '').includes('gemini-omni');
    const fallbackPrompt = isGoogleOmni
      ? (images.length ? RIG_AI_GOOGLE_OMNI_PROMPT_WITH_REFS : RIG_AI_GOOGLE_OMNI_PROMPT)
      : (images.length ? RIG_AI_DEFAULT_PROMPT_WITH_REFS : RIG_AI_DEFAULT_PROMPT);
    params.prompt = (prompt && prompt.trim()) || fallbackPrompt;
  }

  if (previousInteractionId && fields.some((f) => f.key === 'previous_interaction_id')) {
    params.previous_interaction_id = String(previousInteractionId);
  }

  const dur = durationField(model);
  if (dur) {
    const want = rigAiSnapLength(model, seconds);
    const raw = dur.options.find((o) => parseFloat(String(typeof o === 'object' ? o?.value : o).replace(/[^\d.]/g, '')) === want);
    if (raw != null) params[dur.key] = typeof raw === 'object' ? raw.value : raw;
  }

  const resField = rigAiResolutionField(model);
  if (resField) {
    const resolvedRes = rigAiResolveResolution(model, { draft, resolution });
    if (resolvedRes != null) params[resField.key] = resolvedRes;
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
 *  it itself / the catalog has no price. Accounts for Draft / resolution multiplier. */
export function rigAiCost(model, seconds, { draft = false, resolution = null } = {}) {
  const base = Number(model?.price_per_generation);
  if (!(base > 0)) return null;
  if (model.price_unit !== 'per_second') return base;
  const resolvedRes = rigAiResolveResolution(model, { draft, resolution });
  const mult = model.price_resolution_mult && resolvedRes
    ? (model.price_resolution_mult[resolvedRes] ?? 1)
    : 1;
  let s = Math.max(Number(seconds) || 0, model.price_min_seconds || 0);
  if (model.price_max_seconds) s = Math.min(s, model.price_max_seconds);
  return base * s * mult;
}

// ── the source (prerender) ──────────────────────────────────────────────────

/** The channels a scene prerender renders: the camera, the rig, and every
 *  channel holding a 3D model layer not marked as post-take 'composite'. */
export function rigSceneChannelIds(channels, clips) {
  const modelClipIds = new Set((clips || []).filter((c) => c?.mediaType === 'model3d').map((c) => c.id));
  return (channels || [])
    .filter((ch) => ch && (ch.kind === 'camera' || ch.kind === 'rig'
      || (ch.items || []).some((it) => modelClipIds.has(it.clipId) && it.aiRole !== 'composite')))
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
 * the rig item's own `rigAi` (takes arriving must not stale the source) — and so is
 * a camera's `cameraSolveOverride`: Lock camera to take solves the camera FROM a take,
 * and the prerender films the authored camera without it (main.py
 * _apply_scene_channels_target), so locking or unlocking never stales @video1.
 */
export function rigSceneHash(channels, clips, { videoSize, window, look } = {}) {
  const ids = new Set(rigSceneChannelIds(channels, clips));
  const scene = (channels || []).filter((ch) => ids.has(ch.id)).map((ch) => ({
    id: ch.id,
    visible: ch.visible !== false,
    items: (ch.items || [])
      .filter((it) => it?.aiRole !== 'composite')
      .map(({ rigAi: _a, rigLook: _l, cameraPreset: _c, prerender: _p, customName: _n, cameraSolveOverride: _s, ...rest }) => rest),
  }));
  const used = new Set(scene.flatMap((ch) => ch.items.map((it) => it.clipId)));
  const sceneClips = (clips || []).filter((c) => used.has(c.id)).map((c) => ({ id: c.id, url: c.url, mediaType: c.mediaType }));
  return fnv(JSON.stringify({ scene, sceneClips, size: videoSize || null, window: window || null, look: normalizeRigAiLook(look) }));
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
    interactionId: str(t.interactionId, 400),
    parentTakeId: str(t.parentTakeId, 80),
    imported: Boolean(t.imported),
    sourceLook: VALID_LOOKS.has(t.sourceLook) ? t.sourceLook : null,
    draft: Boolean(t.draft),
    resolution: str(t.resolution, 32),
    width: num(t.width, 16, 16384),
    height: num(t.height, 16, 16384),
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
        look: VALID_LOOKS.has(raw.source.look) ? raw.source.look : null,
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
    look: normalizeRigAiLook(raw.look),
    draft: Boolean(raw.draft),
    resolution: str(raw.resolution, 32),
    fitSpeed: raw.fitSpeed !== false,
    hideBlockingWhenPlaced: raw.hideBlockingWhenPlaced !== false,
    refs: (Array.isArray(raw.refs) ? raw.refs : []).map((r) => str(r, 2000)).filter(Boolean).slice(0, MAX_REFS),
    source: src,
    takes,
    nextTakeN: Math.max(1, Math.round(num(raw.nextTakeN, 1, 99999) || (takes.length ? Math.max(...takes.map((t) => t.n)) + 1 : 1))),
    placed: placed && takes.some((t) => t.id === placed.takeId) ? placed : null,
  };
  return out;
}

// ── placement & blocking stand-in muting ─────────────────────────────────────

function activeChannelItemAt(items, layout, time) {
  if (!Array.isArray(items) || !Array.isArray(layout)) return null;
  const EPS = 1e-6;
  for (let i = layout.length - 1; i >= 0; i -= 1) {
    const e = layout[i];
    if (e && time >= e.startTime - EPS && time <= e.endTime + EPS) return items[i] || null;
  }
  return null;
}

/**
 * True when an active Scene Rig has an active placed AI take on a visible
 * channel AND `hideBlockingWhenPlaced !== false` (and we aren't currently
 * prerendering `@video1`). Used to automatically mute clay/blocking 3D
 * stand-ins while keeping 3D Text and `aiRole === 'composite'` layers visible.
 */
export function findBlockingMuteRigAt(channels, layoutFor, time) {
  let placedId = null;
  for (const ch of channels || []) {
    if (!ch || ch.kind !== 'rig' || ch.visible === false) continue;
    const it = activeChannelItemAt(ch.items, layoutFor(ch), time);
    if (!it) continue;
    if (it.rig?.prerenderLook) return false;
    if (it.rigAi?.hideBlockingWhenPlaced !== false && it.rigAi?.placed?.itemId) {
      placedId = it.rigAi.placed.itemId;
      break;
    }
  }
  if (!placedId) return false;
  for (const ch of channels || []) {
    if (!ch || ch.visible === false) continue;
    const it = activeChannelItemAt(ch.items, layoutFor(ch), time);
    if (it?.id === placedId) return true;
  }
  return false;
}

/**
 * Insert the camera-locked `"AI video"` channel at the top of the contiguous
 * bottom `cameraLocked` lead plate run so it stays inside `lockedLeadChannels`
 * (rendering UNDER `world3d` 3D Text / `'composite'` models and 2D overlays,
 * never drifting under camera moves).
 */
export function insertAiVideoChannel(channels, aiChannel) {
  const list = Array.isArray(channels) ? channels.slice() : [];
  let idx = 0;
  while (idx < list.length && list[idx]?.cameraLocked) idx += 1;
  list.splice(idx, 0, { ...aiChannel, cameraLocked: true });
  return list;
}
