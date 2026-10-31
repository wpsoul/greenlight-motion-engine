// HTML clips (PLANS/HTML_CLIP_LAYER_PLAN.md) — the pure half of the editor side.
//
// An html clip is a clip whose `url` is an .html file. The Player never sees it:
// substituteHtmlClips() hands the Player an ordinary 'video' clip (same id) that
// plays the clip's BAKE — a transparent WebM of the page rendered on its virtual
// clock, so page time = the clip's source time (trim, speed and speed curve work
// exactly as they do for video). The file is the source of truth; the bake is a
// cache the backend (backend/html_clips.py) can always re-make. Keys, rounding and
// the "covers" rule mirror that module — keep the two in step.
//
// Where the Player draws pages LIVE (htmlLive.js), the same 'video' clip also names
// its page (`htmlSource`, `htmlCanvas`, `htmlVersion`) and the live canvas takes over
// its texture. A clip with no bake yet is ALWAYS kept, as a clip with no file: live it
// plays the page, otherwise it shows nothing until its bake lands. Dropping it would
// pull every later clip of a snapped track earlier in the preview than the timeline.

export const HTML_MEDIA_TYPE = 'html';
export const HTML_BAKE_ENGINE = 'hb2';
export const HTML_CLIP_DURATION_SECONDS = 5;

export const isHtmlClip = (clip) => !!clip && clip.mediaType === HTML_MEDIA_TYPE;

export function isHtmlUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  const path = url.split(/[?#]/)[0].toLowerCase();
  return path.endsWith('.html') || path.endsWith('.htm');
}

// The page's own canvas (W×H), falling back to the project size.
export function htmlClipCanvasSize(clip, videoSize) {
  const w = Math.round(Number(clip?.html?.width) || 0);
  const h = Math.round(Number(clip?.html?.height) || 0);
  if (w >= 16 && h >= 16) return { w: Math.min(w, 7680), h: Math.min(h, 7680) };
  return { w: Math.round(Number(videoSize?.w) || 1920), h: Math.round(Number(videoSize?.h) || 1080) };
}

// The plate an html clip's layer draws on, in composition px: the PAGE's shape, fit into
// the frame the way the clip shader fits a picture (so at zoom 1 the page is exactly as
// big as before, only without the bars). A video-type layer draws on a frame-sized
// plate and letterboxes its picture into it, painting the bars OPAQUE BLACK — fine for
// a video, wrong for a page: a 300x160 counter or a portrait card sat on a black 16:9
// slab, its transparent background included. null — no size of its own, or the frame's
// shape (within the shader's 0.01 tolerance) — keeps the frame-sized plate unchanged.
// Takes the editor's html clip (`html`) or the Player's clip (`htmlCanvas`).
export function htmlClipPlateSize(clip, frameW, frameH) {
  if (!clip || !(clip.htmlSource || isHtmlClip(clip))) return null;
  const w = Number(clip.htmlCanvas?.width) || Number(clip.html?.width) || 0;
  const h = Number(clip.htmlCanvas?.height) || Number(clip.html?.height) || 0;
  if (!(w >= 1 && h >= 1) || !(frameW > 0) || !(frameH > 0)) return null;
  const aspect = w / h;
  const frameAspect = frameW / frameH;
  if (Math.abs(aspect - frameAspect) <= 0.01) return null;
  return aspect > frameAspect
    ? { width: frameW, height: frameW / aspect }
    : { width: frameH * aspect, height: frameH };
}

export function htmlFpsToken(fps) {
  const v = Number(fps) || 30;
  if (Math.abs(v - Math.round(v)) < 1e-6) return String(Math.round(v));
  return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

export function htmlBakeKey(sha1, w, h, fps) {
  return `${HTML_BAKE_ENGINE}-${String(sha1 || '').slice(0, 16)}-${Math.round(w)}x${Math.round(h)}-${htmlFpsToken(fps)}`;
}

// Bakes are whole seconds (at least 1 s): a few frames of edge drag never re-bake.
export function htmlBakeSeconds(neededSeconds) {
  const needed = Math.max(0, Number(neededSeconds) || 0);
  return Math.max(1, Math.ceil(needed - 1e-6));
}

// Longest source time each html clip's items reach (max trimEnd), for ONE scope:
// an item's clipId resolves in the clips list that sits next to its channels.
export function htmlClipNeeds(channels) {
  const needs = new Map();
  for (const ch of channels || []) {
    for (const item of ch?.items || []) {
      if (!item?.clipId) continue;
      const end = Number(item.trimEnd) || 0;
      if (end > (needs.get(item.clipId) || 0)) needs.set(item.clipId, end);
    }
  }
  return needs;
}

// Every html clip in the project (root and nested containers), with the source
// length its items need.
export function collectHtmlClips(channels, clips, depth = 0, out = []) {
  const needs = htmlClipNeeds(channels);
  for (const clip of clips || []) {
    if (isHtmlClip(clip)) out.push({ clip, needed: needs.get(clip.id) || 0 });
    else if (clip?.sequence && depth < 8) collectHtmlClips(clip.sequence.channels, clip.sequence.clips, depth + 1, out);
  }
  return out;
}

export function projectHasHtmlClips(clips, depth = 0) {
  for (const clip of clips || []) {
    if (isHtmlClip(clip)) return true;
    if (clip?.sequence && depth < 8 && projectHasHtmlClips(clip.sequence.clips, depth + 1)) return true;
  }
  return false;
}

// none  — no bake yet (the Player leaves its items out)
// stale — a bake exists but is of an older file, another size/fps, or too short
//         (it keeps playing, frames past its end hold its last frame)
// valid — current
// `sourceSha1` undefined means "not checked yet": only size/fps/length decide.
export function htmlClipBakeState(clip, { sourceSha1, fps, videoSize, neededSeconds = 0 } = {}) {
  const pre = clip?.prerender;
  if (!pre || typeof pre.url !== 'string' || !pre.url) return 'none';
  if (sourceSha1 && pre.sourceSha1 && pre.sourceSha1 !== sourceSha1) return 'stale';
  const { w, h } = htmlClipCanvasSize(clip, videoSize);
  if (pre.hash !== htmlBakeKey(pre.sourceSha1, w, h, fps)) return 'stale';
  if ((Number(pre.duration) || 0) + 1e-6 < htmlBakeSeconds(neededSeconds)) return 'stale';
  return 'valid';
}

const syntheticCache = new WeakMap();

// What the live layer needs to know about the page: its canvas, and a version that
// changes when the file does (the editor's html-source-info sha1, else the bake's).
function livePageFields(clip, sourceSha1) {
  const pre = clip.prerender || {};
  return {
    htmlSource: clip.url,
    htmlCanvas: {
      width: Number(clip.html?.width) || Number(pre.width) || 0,
      height: Number(clip.html?.height) || Number(pre.height) || 0,
    },
    htmlVersion: sourceSha1 || pre.sourceSha1 || null,
  };
}

function bakedPlaybackClip(clip, sourceSha1) {
  const pre = clip.prerender;
  // A forced re-render replaces the file under the same name: `at` versions the
  // url so the browser does not keep playing the cached copy.
  const url = pre.at ? `${pre.url}?v=${pre.at}` : pre.url;
  const sig = `${url}|${pre.duration}|${sourceSha1 || ''}`;
  const hit = syntheticCache.get(clip);
  if (hit && hit.sig === sig) return hit.clip;
  const synthetic = {
    ...clip,
    mediaType: 'video',
    url,
    proxyUrl: null,
    previewOriginal: false,
    duration: Math.max(0.1, Number(pre.duration) || clip.duration || HTML_CLIP_DURATION_SECONDS),
    thumbnailUrl: pre.thumbnailUrl || clip.thumbnailUrl || null,
    prerenderOf: clip.id,
    ...livePageFields(clip, sourceSha1),
  };
  delete synthetic.prerender;
  delete synthetic.html;
  syntheticCache.set(clip, { sig, clip: synthetic });
  return synthetic;
}

// No bake yet: a 'video' clip with no file, whose texture only ever comes from the
// live canvas — or is empty (htmlLive.js blank canvas) where pages are not drawn live.
function liveOnlyPlaybackClip(clip, sourceSha1) {
  const sig = `live|${sourceSha1 || ''}`;
  const hit = syntheticCache.get(clip);
  if (hit && hit.sig === sig) return hit.clip;
  const synthetic = {
    ...clip,
    mediaType: 'video',
    url: '',
    proxyUrl: null,
    previewOriginal: false,
    duration: Math.max(0.1, Number(clip.duration) || HTML_CLIP_DURATION_SECONDS),
    htmlLiveOnly: true,
    ...livePageFields(clip, sourceSha1),
  };
  delete synthetic.prerender;
  delete synthetic.html;
  syntheticCache.set(clip, { sig, clip: synthetic });
  return synthetic;
}

function substituteScope(channels, clips, depth, opts) {
  let changed = false;
  const nextClips = (clips || []).map((clip) => {
    if (isHtmlClip(clip)) {
      changed = true;
      const sha = opts.shas?.[clip.url] || null;
      if (clip.prerender?.url) return bakedPlaybackClip(clip, sha);
      return liveOnlyPlaybackClip(clip, sha);
    }
    if (clip?.sequence && depth < 8) {
      const inner = substituteScope(clip.sequence.channels, clip.sequence.clips, depth + 1, opts);
      if (inner.channels !== clip.sequence.channels || inner.clips !== clip.sequence.clips) {
        changed = true;
        return { ...clip, sequence: { ...clip.sequence, channels: inner.channels, clips: inner.clips } };
      }
    }
    return clip;
  });
  if (!changed) return { channels, clips };
  return { channels, clips: nextClips };
}

// What the Player plays: every baked html clip becomes a 'video' clip of its bake
// (same id, so items are untouched); a not-yet-baked one becomes a clip with no file
// that keeps its place on the timeline (live, or empty), so a .html file is never
// loaded as a video texture. `live` is kept for callers; `shas` (url -> sha1, the
// editor's html-source-info) versions the live page. The SAME arrays come back when
// the project has no html clips — nothing downstream re-renders.
export function substituteHtmlClips(channels, clips, { live = false, shas = null } = {}) {
  if (!projectHasHtmlClips(clips)) return { channels, clips };
  return substituteScope(channels, clips, 0, { live, shas });
}
