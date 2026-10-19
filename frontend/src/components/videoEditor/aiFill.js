import { multiMediaPostKey } from '../../ai/mediaParams.js';

/*
 * AI Fill — which models can fill a gap, and the request each one is sent.
 *
 * Two model families can bridge the frame before a gap and the frame after it:
 *
 *  - first/last-frame models take the two frames in dedicated start/end slots;
 *  - reference models (Omni, References to Video) take a list of images. The
 *    frames go in as the first two entries — @image1 and @image2, the numbering
 *    the Generate panel's @-mentions use — and the prompt asks for the
 *    transition between them. Extra references the user adds follow as
 *    @image3, @image4, … and can be mentioned in the prompt by that tag.
 *
 * Imports only pure modules, so `node --test` can load it (models.js pulls in
 * the API client).
 */

export const AI_FILL_PROMPT = 'Generate a smooth, natural transition between the two frames.';
export const AI_FILL_REFERENCE_PROMPT =
  'Start exactly on @image1 and transition smoothly and naturally into @image2, ending exactly on @image2.';

const REFERENCE_MODEL_TYPES = new Set(['omni', 'references_to_video']);
const MEDIA_FIELD_TYPES = new Set(['image', 'video', 'audio', 'media']);

// Reference models whose API cannot end a clip on a given frame: their images
// only say who or what is in the scene, so the end frame is ignored. HeyGen
// Video 1 opens on @image1 and never reaches @image2 — its API has no last-frame
// input, and naming <Picture 2> in the prompt does not change that.
const NO_END_FRAME_MODEL_IDS = new Set(['heygen/heygen-video-1/reference-to-video']);

// GenerationPanel's mediaSlotLimit: a references-to-video `image_url` slot that
// declares no max_files has always taken a list of up to this many.
const LEGACY_REFERENCE_IMAGE_SLOTS = 10;

function declaredMaxFiles(field) {
  return Number.isFinite(field?.max_files) && field.max_files > 1 ? Math.floor(field.max_files) : 1;
}

/**
 * The image list a reference model takes, or null when the model is not one AI
 * Fill can drive that way.
 *
 * `key` is the declared field, `postKey` the key the list is sent under and
 * `max` how many images it holds (start + end + extras).
 */
export function getAiFillReferenceSlot(model) {
  if (!model || !REFERENCE_MODEL_TYPES.has(model.model_type)) return null;
  if (NO_END_FRAME_MODEL_IDS.has(model.id)) return null;
  const fields = model.fields || [];
  // A model that needs a source clip or track (video-edit endpoints, Kling's
  // video reference) has nothing to work from inside an empty gap.
  const needsOtherMedia = fields.some(
    (f) => f.field_type !== 'image' && MEDIA_FIELD_TYPES.has(f.field_type) && f.required !== false
  );
  if (needsOtherMedia) return null;
  const field = fields
    .filter((f) => f.field_type === 'image')
    .reduce((best, f) => (!best || declaredMaxFiles(f) > declaredMaxFiles(best) ? f : best), null);
  if (!field) return null;
  let max = declaredMaxFiles(field);
  if (max === 1 && field.key === 'image_url' && model.model_type === 'references_to_video') {
    max = LEGACY_REFERENCE_IMAGE_SLOTS;
  }
  if (max < 2) return null; // the start and end frames alone need two
  return { key: field.key, postKey: multiMediaPostKey(model, field), max };
}

export function isAiFillReferenceModel(model) {
  return !!getAiFillReferenceSlot(model);
}

/** First/last-frame models first (the existing default), then reference models. */
export function getAiFillModels(models, firstLastFrameModels) {
  const ids = new Set((firstLastFrameModels || []).map((m) => m.id));
  return [
    ...(firstLastFrameModels || []),
    ...(models || []).filter((m) => !ids.has(m.id) && isAiFillReferenceModel(m)),
  ];
}

/** How many extra references (beyond the start and end frames) the model takes. */
export function getAiFillExtraReferenceLimit(model) {
  const slot = getAiFillReferenceSlot(model);
  return slot ? slot.max - 2 : 0;
}

export function defaultAiFillPrompt(model) {
  return isAiFillReferenceModel(model) ? AI_FILL_REFERENCE_PROMPT : AI_FILL_PROMPT;
}

/** True for an untouched prompt, which follows the model when it changes. */
export function isDefaultAiFillPrompt(text) {
  const t = String(text ?? '').trim();
  return t === AI_FILL_PROMPT || t === AI_FILL_REFERENCE_PROMPT;
}

/** Every image a generate sends, in @imageN order. */
export function getAiFillImageUrls(model, zone) {
  const frames = [zone?.startImageUrl, zone?.endImageUrl];
  const slot = getAiFillReferenceSlot(model);
  if (!slot) return frames.filter(Boolean);
  const extras = (Array.isArray(zone?.referenceImages) ? zone.referenceImages : []).filter(Boolean);
  return [...frames, ...extras].filter(Boolean).slice(0, slot.max);
}

function parseRatio(value) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(value ?? ''));
  if (!m) return null;
  const r = Number(m[1]) / Number(m[2]);
  return Number.isFinite(r) && r > 0 ? r : null;
}

function nearestByRatio(items, target, ratioOf) {
  let best = null;
  let bestDist = Infinity;
  for (const item of items || []) {
    const r = ratioOf(item);
    if (!r) continue;
    const dist = Math.abs(Math.log(r / target));
    if (dist < bestDist) {
      best = item;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Request params for one AI Fill generate. `frameKeys` is the first/last-frame
 * model's { startKey, endKey } (models.js getTransitionFrameKeys); reference
 * models ignore it.
 */
export function buildAiFillParams(model, zone, { videoSize, frameKeys } = {}) {
  const fields = model?.fields || [];
  const slot = getAiFillReferenceSlot(model);
  const params = {};

  if (slot) {
    // Every declared option at its default, as the Generate panel opens them —
    // several reference models declare required selects (resolution, mode)
    // that a bare request would leave out.
    for (const f of fields) {
      if (f.key === 'prompt' || MEDIA_FIELD_TYPES.has(f.field_type)) continue;
      if (f.default !== null && f.default !== undefined) params[f.key] = f.default;
    }
    params[slot.postKey] = getAiFillImageUrls(model, zone);
  } else {
    const startKey = frameKeys?.startKey || 'start_image_url';
    const endKey = frameKeys?.endKey || 'end_image_url';
    params[startKey] = zone.startImageUrl;
    params[endKey] = zone.endImageUrl;
  }

  const promptField = fields.find((f) => f.key === 'prompt');
  if (promptField) params.prompt = zone.prompt || defaultAiFillPrompt(model);

  const durationField = fields.find(
    (f) => (f.key === 'duration' || f.key === 'duration_seconds') && f.options?.length
  );
  if (durationField) {
    const opts = durationField.options
      .map((o) => ({ raw: o, n: parseFloat(String(o).replace(/[^\d.]/g, '')) }))
      .filter((o) => Number.isFinite(o.n));
    if (opts.length) {
      const best = opts.reduce((a, b) => (Math.abs(b.n - zone.duration) < Math.abs(a.n - zone.duration) ? b : a));
      params[durationField.key] = best.raw;
    }
  }

  if (videoSize?.w && videoSize?.h) {
    params.image_size = { width: videoSize.w, height: videoSize.h };
    if (slot) {
      // A first/last-frame model takes its shape from the frames; a reference
      // model is told it, so match the project's aspect as closely as the
      // model allows.
      const target = videoSize.w / videoSize.h;
      const aspectField = fields.find(
        (f) => (f.key === 'aspect_ratio' || f.key === 'ratio') && f.options?.length
      );
      const option = aspectField ? nearestByRatio(aspectField.options, target, parseRatio) : null;
      if (option != null) params[aspectField.key] = option;
      const size = nearestByRatio(model.supported_sizes, target, (s) =>
        s?.width > 0 && s?.height > 0 ? s.width / s.height : parseRatio(s?.aspect_ratio)
      );
      if (size?.width && size?.height) params.image_size = { width: size.width, height: size.height };
    }
  }

  return params;
}

/*
 * Takes. Every Generate adds a take to the zone instead of replacing the last
 * result, so several models / lengths can run side by side. One take at a time
 * is "in use": the zone's timeline item plays it and the gap is that take's
 * length. A zone's `status` is DERIVED from its takes (never set by hand):
 *
 *   ready      — the take in use has its video
 *   generating — nothing in use yet and at least one take is running
 *   error      — nothing in use, nothing running, the newest take failed
 *   idle       — no takes, or only discarded / finished-but-unused ones
 */

/** The take the timeline plays, or null. */
export function activeAiFillTake(zone) {
  const takes = Array.isArray(zone?.takes) ? zone.takes : [];
  const take = takes.find((t) => t.id === zone?.activeTakeId);
  return take && take.status === 'ready' ? take : null;
}

export function aiFillZoneStatus(zone) {
  if (activeAiFillTake(zone)) return 'ready';
  const takes = Array.isArray(zone?.takes) ? zone.takes : [];
  if (takes.some((t) => t.status === 'generating')) return 'generating';
  const newest = takes[takes.length - 1];
  if (newest?.status === 'error' && !takes.some((t) => t.status === 'ready')) return 'error';
  return 'idle';
}

/** `zone` with its derived status filled in — apply after every takes change. */
export function withAiFillStatus(zone) {
  const status = aiFillZoneStatus(zone);
  return zone.status === status ? zone : { ...zone, status };
}

/** Number for the next take (takes are never renumbered when one is discarded). */
export function nextAiFillTakeNumber(zone) {
  const takes = Array.isArray(zone?.takes) ? zone.takes : [];
  const used = takes.reduce((n, t) => Math.max(n, Number(t.n) || 0), 0);
  return Math.max(Number(zone?.nextTakeN) || 1, used + 1);
}

/** The length the next take asks for: the chosen length, else the gap. */
export function aiFillNextTakeLength(zone) {
  const d = Number(zone?.takeDuration);
  return Number.isFinite(d) && d > 0 ? d : Number(zone?.duration) || 0;
}

/** What survives a save: ready takes only (a running or failed one is gone on reload). */
export function persistableAiFillTakes(zone) {
  return (Array.isArray(zone?.takes) ? zone.takes : [])
    .filter((t) => t.status === 'ready' && t.resultUrl)
    .map((t) => ({
      id: t.id,
      n: t.n,
      modelId: t.modelId || null,
      modelName: t.modelName || '',
      duration: t.duration,
      prompt: t.prompt || '',
      resultUrl: t.resultUrl,
      resultProxyUrl: t.resultProxyUrl || null,
      resultThumbnailUrl: t.resultThumbnailUrl || null,
    }));
}

/** Rebuild saved takes (sanitized) — all ready, none in use until picked again. */
export function restoreAiFillTakes(raw) {
  if (!Array.isArray(raw)) return [];
  const str = (v) => (typeof v === 'string' && v ? v : null);
  return raw
    .filter((t) => t && typeof t === 'object' && str(t.id) && str(t.resultUrl))
    .map((t, i) => ({
      id: t.id,
      n: Number.isFinite(Number(t.n)) && Number(t.n) > 0 ? Math.round(Number(t.n)) : i + 1,
      modelId: str(t.modelId),
      modelName: typeof t.modelName === 'string' ? t.modelName : '',
      duration: Math.max(0.1, Math.min(60, Number(t.duration) || 0)) || 5,
      prompt: typeof t.prompt === 'string' ? t.prompt : '',
      status: 'ready',
      error: null,
      videoClipId: null,
      resultUrl: t.resultUrl,
      resultProxyUrl: str(t.resultProxyUrl),
      resultThumbnailUrl: str(t.resultThumbnailUrl),
      fresh: false,
    }));
}

/**
 * A reload of the SAME project (an outside edit, an agent, a backend restart)
 * rebuilds the zones from the save, which only knows finished takes and none
 * in use. Carry the in-memory takes across so a take still generating lands
 * when it finishes instead of being dropped, and mark the take that was in use
 * (`restoreTakeId`) so the editor can put it back on the timeline.
 */
export function carryAiFillRuntime(incomingZones, currentZones) {
  const current = new Map((currentZones || []).map((z) => [z.id, z]));
  return (incomingZones || []).map((zone) => {
    const live = current.get(zone.id);
    if (!live || !Array.isArray(live.takes) || !live.takes.length) return zone;
    return withAiFillStatus({
      ...zone,
      // The preview clips did not survive the reload; Use rebuilds them.
      takes: live.takes.map((t) => ({ ...t, videoClipId: null })),
      activeTakeId: null,
      nextTakeN: Math.max(Number(zone.nextTakeN) || 1, Number(live.nextTakeN) || 1),
      restoreTakeId: activeAiFillTake(live)?.id || null,
    });
  });
}
