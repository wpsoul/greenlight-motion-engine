// Lazy registry façade.
//
// The template modules live in ./registry, which is loaded with a *dynamic* import()
// so Vite emits it as its own bundle chunk. That chunk is fetched only the first time
// templates are actually needed — when the MotionFast panel is opened, or when a motion
// clip has to be rendered — NOT with the initial app bundle. So however many templates
// you add (10 or 100), none of that code loads until the editor needs it.
//
// Consumers use the synchronous accessors below. Until the chunk has loaded they return
// safe fallbacks and kick off the load; components subscribe via onMotionTemplatesLoaded
// to repaint once it's ready.
// Alongside the built-in chunk, user-imported "local" templates (see
// ./localTemplates.js) are fetched from the backend and merged into the same
// cache — every consumer keeps using the synchronous accessors unchanged.
import { setMotionMediaClock, clearMotionMediaClock } from './motionVideo';

// The media runtime behind template video params travels with this façade, so every
// consumer (Player preview + export, inspector) shares one module instance.
export {
  isMotionVideoUrl,
  isSupportedMotionVideo,
  prepareMotionVideo,
  pumpMotionMedia,
  motionMediaPending,
  onMotionMediaFrame,
  releaseMotionMedia,
  // Layer Mask's raster mattes ride the same lane (layerMask.js) — through this
  // façade, never straight from motionVideo, so they share the one instance.
  requestVideoFrame,
  videoLaneStamp,
} from './motionVideo';

let builtinList = null;
let localList = [];
let cache = null;   // { list, byId }
let loading = null;
const subs = new Set();

// Locally-imported templates load unconditionally. There used to be a consent
// toggle in App settings gating them; importing a template is itself the consent
// action, so the extra switch only got in the way. Imports still go through the
// static gate + shape/determinism validation in ./localTemplates.

function rebuildCache() {
  if (!builtinList) return;
  const list = [...builtinList, ...localList];
  cache = { list, byId: new Map(list.map((t) => [t.id, t])) };
}

function notifySubs() {
  subs.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
}

// (Re)load local templates and merge them in. Safe to call any time.
// `localHydrated` flips once the first load settles — before that, an unknown id may
// just be a local template that hasn't arrived yet, so no missing-placeholder is drawn.
let localLoadSeq = 0;
let localHydrated = false;
export function reloadLocalMotionTemplates() {
  const seq = ++localLoadSeq;
  return import('./localTemplates')
    .then((m) => m.loadLocalTemplates())
    .then((list) => {
      if (seq !== localLoadSeq) return; // superseded by a newer reload
      localList = list;
      rebuildCache();
      notifySubs();
    })
    .catch((err) => { console.warn('[motion] Local templates unavailable:', err?.message || err); })
    .finally(() => { localHydrated = true; notifySubs(); });
}

/*
 * RE-LISTING WHAT IS INSTALLED.
 *
 * Templates also arrive from outside the editor — an agent installs one over
 * the API while the editor is open. The list is re-read when one can matter:
 * the MotionFast tab opening, the editor reloading after an API change, and a
 * project drawing a template id this session does not know. A re-list is one
 * request (evaluated templates are cached per revision in ./localTemplates);
 * it never overlaps another and runs at most once per REFRESH_MIN_INTERVAL_MS.
 */
const REFRESH_MIN_INTERVAL_MS = 1000;
let localRefresh = null;
let lastLocalRefreshAt = 0;

export function refreshLocalMotionTemplates() {
  if (localRefresh) return localRefresh;
  if (Date.now() - lastLocalRefreshAt < REFRESH_MIN_INTERVAL_MS) return Promise.resolve();
  lastLocalRefreshAt = Date.now();
  localRefresh = reloadLocalMotionTemplates().finally(() => { localRefresh = null; });
  return localRefresh;
}

// The Player draws a missing template every frame, so an unknown id is re-asked
// with a growing gap: one installed a moment ago is found on the first try, one
// that was deleted settles at a request a minute.
const UNKNOWN_FIRST_RETRY_MS = 3000;
const UNKNOWN_MAX_RETRY_MS = 60000;
const unknownTemplates = new Map(); // id → { nextAt, delay }

function relistForUnknownTemplate(templateId) {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  const seen = unknownTemplates.get(templateId);
  if (seen && now < seen.nextAt) return;
  const delay = seen ? Math.min(seen.delay * 2, UNKNOWN_MAX_RETRY_MS) : UNKNOWN_FIRST_RETRY_MS;
  unknownTemplates.set(templateId, { nextAt: now + delay, delay });
  refreshLocalMotionTemplates();
}

// Validate + persist a user-picked template file, then refresh the gallery.
// Returns { id, name }; throws with an actionable message on any validation error.
export async function importLocalMotionTemplate(file) {
  await loadMotionTemplates();
  const m = await import('./localTemplates');
  const builtinIds = new Set(builtinList.map((t) => t.id));
  const result = await m.importLocalTemplateFile(file, builtinIds);
  await reloadLocalMotionTemplates();
  return result;
}

export async function deleteLocalMotionTemplate(templateId) {
  const template = localList.find((t) => t.id === templateId);
  if (!template) return;
  const m = await import('./localTemplates');
  await m.deleteLocalTemplateFile(template.localId);
  await reloadLocalMotionTemplates();
}

// Must stay in sync with the `pro` flag in each template's DEFAULT export (that
// flag drives the badge in the picker; this set drives the timeline badge and
// the actual paywall at render). Deliberately a hardcoded list rather than being
// derived from the registry: the registry is dynamic-imported as its own chunk,
// so a derived set would be empty until templates finish loading — long enough
// for a timeline to render unbadged and a render to slip past the gate.
export const PRO_MOTION_TEMPLATE_IDS = new Set([
  'advanced-typewriter',
  'gradient-sweep-text',
  'comment-card',
  'comment-thread-camera',
  'connected-steps',
  'media-orbit-burst',
  'cascading-ticker',
  'ask-anything-prompt',
  'prompt-card-click',
  'kinetic-typography',
  'scatter-cards-flow',
  'card-fan-cycle',
  'social-post',
  'tiled-gallery',
  'card-corridor',
  'tag-wall',
  'card-stack-drop',
  'card-stack-unstack',
  'spawn-zoom-cards',
  'ai-chat',
  'dynamic-list',
]);

export function isProMotionTemplate(templateId) {
  return PRO_MOTION_TEMPLATE_IDS.has(templateId);
}

// Project sequences can contain other sequences, so inspect the complete saved
// editor state rather than only the currently visible timeline level.
export function containsProMotionTemplate(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (isProMotionTemplate(value.motionTemplateId)) return true;
  if (Array.isArray(value)) return value.some((entry) => containsProMotionTemplate(entry, seen));
  return Object.values(value).some((entry) => containsProMotionTemplate(entry, seen));
}

export function loadMotionTemplates() {
  if (cache) return Promise.resolve(cache);
  if (!loading) {
    loading = import('./registry').then((m) => {
      builtinList = m.MOTION_TEMPLATES;
      rebuildCache();
      notifySubs();
      // Local templates arrive as a second, non-blocking merge; subscribers
      // repaint again once they land.
      refreshLocalMotionTemplates();
      return cache;
    });
  }
  return loading;
}

export function motionTemplatesReady() { return !!cache; }

// ---------------------------------------------------------------------------
// Lazy (stub) templates — every built-in (see ./registry.js).
//
// A stub carries only what the gallery needs (id/name/category/color/thumbnail)
// plus `load()`, its own dynamic import. Anything that actually needs to RUN the
// template resolves it first: insert and template-swap await ensureMotionTemplate,
// and drawMotionFrame kicks off the load and repaints via onMotionTemplatesLoaded
// (the same path the Player already uses while the registry chunk is in flight).
const resolving = new Map();

export function isLazyMotionTemplate(t) { return !!(t && t.lazy && typeof t.draw !== 'function' && typeof t.createInstance !== 'function'); }

export async function ensureMotionTemplate(templateId) {
  await loadMotionTemplates();
  const current = cache ? cache.byId.get(templateId) : null;
  if (!current || !isLazyMotionTemplate(current)) return current || null;
  if (!resolving.has(templateId)) {
    resolving.set(templateId, current.load()
      .then((mod) => {
        const real = mod.default || mod;
        if (!real || typeof real.getDuration !== 'function') throw new Error(`bad template module ${templateId}`);
        // Keep the stub's gallery art: the module doesn't ship one.
        const merged = { ...real, thumbnail: current.thumbnail, lazy: true };
        builtinList = builtinList.map((t) => (t.id === templateId ? merged : t));
        rebuildCache();
        notifySubs();
        return merged;
      })
      .catch((err) => {
        console.warn('[motion] Template module failed to load:', templateId, err?.message || err);
        resolving.delete(templateId);   // let a later use retry
        return current;
      }));
  }
  return resolving.get(templateId);
}

// Subscribe to be notified once the registry chunk has loaded (returns an unsubscribe).
export function onMotionTemplatesLoaded(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

// Full list; kicks off the load and returns [] until it's ready.
export function getMotionTemplatesSync() {
  if (!cache) { loadMotionTemplates(); return []; }
  return cache.list;
}

export function getMotionTemplate(id) {
  if (!cache) { loadMotionTemplates(); return null; }
  const template = cache.byId.get(id) || null;
  // Before the first local load settles an unknown id may simply not have arrived yet.
  if (template) { if (unknownTemplates.size) unknownTemplates.delete(id); }
  else if (id && localHydrated) relistForUnknownTemplate(id);
  return template;
}

// Duration (seconds) for a template + params, with a safe fallback.
export function getMotionDuration(templateId, params) {
  const t = getMotionTemplate(templateId);
  if (!t) return 5;
  // Unresolved stub: the manifest's placeholder until its module lands.
  if (isLazyMotionTemplate(t)) { ensureMotionTemplate(templateId); return Math.max(0.2, Number(t.duration) || 5); }
  try {
    const d = typeof t.getDuration === 'function' ? t.getDuration(params || t.defaultParams || {}) : 5;
    return Math.max(0.2, Number(d) || 5);
  } catch {
    return 5;
  }
}

// Draw a single frame of a template into a 2D context. `cacheEntry` (optional) lets
// the caller reuse a built instance across frames — pass an object `{}` and this keeps
// `{ sig, instance }` on it, rebuilding only when params/template change. If the
// registry chunk hasn't loaded yet, this kicks off the load and no-ops (a later frame
// paints it — the Player also subscribes via onMotionTemplatesLoaded to repaint).
// Explicit frame for a clip whose template no longer exists (e.g. a deleted local
// template). Deterministic, so preview and export show the same thing instead of
// silently rendering nothing.
function drawMissingTemplate(ctx, templateId, width, height) {
  const s = height / 1080;
  ctx.save();
  ctx.fillStyle = 'rgba(24, 24, 32, 0.95)';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(248, 113, 113, 0.55)';
  ctx.lineWidth = Math.max(1, 3 * s);
  ctx.setLineDash([14 * s, 10 * s]);
  const inset = 24 * s;
  ctx.strokeRect(inset, inset, width - inset * 2, height - inset * 2);
  ctx.setLineDash([]);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fca5a5';
  ctx.font = `700 ${Math.round(44 * s)}px Inter, sans-serif`;
  ctx.fillText('Missing motion template', width / 2, height / 2 - 32 * s);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.font = `500 ${Math.round(28 * s)}px Inter, sans-serif`;
  ctx.fillText(`"${templateId}" — re-import it or pick another template`, width / 2, height / 2 + 28 * s);
  ctx.restore();
}

// Lane ids for video params: every caller that keeps a `cacheEntry` (one per
// timeline item) gets its own decoder lane, so the same file used by two clips at
// different local times never fights over one decoder.
let laneSeq = 0;

// `baseParams` (optional) are the item's STATIC options, before any keyframed values
// were merged into `params`. Stateful instances are signed with those instead, so an
// animated option doesn't rebuild the instance every frame; the animated values reach
// the template through the opt-in `instance.setParams(p)` hook (see `liveParams` in
// MOTIONFAST_TEMPLATE_GUIDE.md). Stateless `draw` templates just receive `params`.
// `pixelScale` is the plate's raster density (1 unless a camera move magnifies the layer).
// It exists so a template that composes through its OWN offscreen buffer can size that
// buffer to the resolution the plate is really being drawn at — without it, the buffer is
// built at composition scale and then magnified by the CTM, which is the one way a template
// can still come out soft under a push-in. It is NOT needed for shadows or `filter: blur()`:
// the Player hands those a density-correcting context (see densityMotionCtx), so scaling
// them here as well would apply the density twice.
// Returns true only when the template itself drew this frame to the end. A lazy stub
// whose module is still loading, a missing template or one that threw draws nothing of
// its own, so the Player's CTM probe must not judge the template from such a frame.
export function drawMotionFrame(ctx, {
  templateId, params, baseParams, timeSec, width, height, pixelScale, cacheEntry,
}) {
  const template = getMotionTemplate(templateId);
  if (!template) {
    // Only claim "missing" once both built-ins and locals have had a chance to load.
    if (cache && localHydrated && templateId) {
      try { drawMissingTemplate(ctx, templateId, width, height); } catch { /* ignore */ }
    }
    return false;
  }
  // A stub clip in a saved project: fetch its module and paint on the repaint
  // that ensureMotionTemplate triggers. Never a missing-plate — it isn't missing.
  if (isLazyMotionTemplate(template)) { ensureMotionTemplate(templateId); return false; }
  const p = params || template.defaultParams || {};
  // Thumbnail/preview callers pass nothing; they always draw at composition scale.
  const ps = Number(pixelScale) > 0 ? Number(pixelScale) : 1;
  if (cacheEntry && !cacheEntry.lane) cacheEntry.lane = `clip${++laneSeq}`;
  setMotionMediaClock(timeSec, cacheEntry ? cacheEntry.lane : `tpl:${templateId}`);
  try {
    if (typeof template.createInstance === 'function') {
      // `rev` (set on local templates from the file mtime) invalidates cached
      // instances when a template is re-imported with unchanged params.
      const sig = `${templateId}@${template.rev || 0}::${JSON.stringify(baseParams || p)}`;
      let instance;
      if (cacheEntry && cacheEntry.sig === sig && cacheEntry.instance) {
        instance = cacheEntry.instance;
      } else {
        instance = template.createInstance(p);
        if (cacheEntry) { cacheEntry.sig = sig; cacheEntry.instance = instance; }
      }
      // Keyframed options: only templates that declare `liveParams` get offered a ◆
      // dot, and those implement setParams — everyone else never sees an animated `p`.
      if (baseParams && baseParams !== p) instance.setParams?.(p);
      instance.seek(Math.max(0, timeSec || 0));
      instance.render(ctx, { width, height, pixelScale: ps });
      return true;
    } else if (typeof template.draw === 'function') {
      template.draw(ctx, { width, height, pixelScale: ps, timeSec: Math.max(0, timeSec || 0), params: p });
      return true;
    }
    return false;
  } catch {
    // A misbehaving template must never break the render loop.
    return false;
  } finally {
    clearMotionMediaClock();
  }
}
