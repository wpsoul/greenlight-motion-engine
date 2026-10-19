// ── Sequence prerender ──
// "Prerender" in the SEQUENCE panel renders one container clip's inner timeline to
// a transparent WebM in the background (the server render path, `sequenceClipId`
// + `webm-alpha`, written to the board's hidden .renders stash) and stores the
// result on the clip as `clip.prerender = { url, hash, fps, width, height, at }`.
// The preview then plays that video in place of the live inner timeline; the
// export never does (it always renders live, at full quality).
//
// The `hash` is the fingerprint of everything the rendered pixels depend on: the
// inner timeline (clips + channels), the composition size and the frame rate. It
// is recomputed from the CURRENT clip on every use, so any edit inside the
// sequence — or a resize / fps change — makes the stored prerender stale and it is
// ignored at once (and dropped from the clip by the editor as soon as it notices).
// Nested `prerender` fields are left out of the fingerprint: an inner sequence
// getting or losing its own prerender does not change what the outer one renders.

import { isContainerClip } from './types';

// FNV-1a over a string — fast, and the input is memoized per `sequence` object so
// it only ever runs when the inner timeline object actually changes identity.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const sequenceDigestCache = new WeakMap(); // sequence object -> digest
function sequenceDigest(sequence) {
  if (!sequence || typeof sequence !== 'object') return '0';
  let d = sequenceDigestCache.get(sequence);
  if (d) return d;
  let json;
  try {
    json = JSON.stringify(sequence, (k, v) => (k === 'prerender' ? undefined : v));
  } catch {
    json = `${Date.now()}:${Math.random()}`;
  }
  d = `${fnv1a(json)}:${json.length}`;
  sequenceDigestCache.set(sequence, d);
  return d;
}

export function sequencePrerenderHash(clip, width, height, fps) {
  if (!clip?.sequence) return '';
  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  const f = Number(fps) || 30;
  return `v1:${sequenceDigest(clip.sequence)}:${w}x${h}@${f}`;
}

export function isSequencePrerenderValid(clip, width, height, fps) {
  const pre = clip?.prerender;
  if (!pre || typeof pre.url !== 'string' || !pre.url || typeof pre.hash !== 'string') return false;
  return pre.hash === sequencePrerenderHash(clip, width, height, fps);
}

// The clip the PREVIEW should render for `clip`: a synthetic video clip playing the
// prerendered file when a valid prerender exists, else null. Memoized on the clip
// object so the render loop hands the same object every frame (texture and media
// caches key on clips and urls, and a fresh object per frame would churn them).
const playbackClipCache = new WeakMap(); // container clip -> { key, clip }
export function prerenderPlaybackClip(clip, width, height, fps) {
  if (!isContainerClip(clip) || clip.mediaType !== 'sequence') return null;
  if (!isSequencePrerenderValid(clip, width, height, fps)) return null;
  const key = `${clip.prerender.url}|${clip.prerender.hash}`;
  const hit = playbackClipCache.get(clip);
  if (hit && hit.key === key) return hit.clip;
  // No `sequence`: nothing downstream may mistake this for a container. WebM plays
  // from its original url (never a proxy), which is what keeps the alpha channel.
  const { sequence, prerender, ...rest } = clip;
  const swapped = {
    ...rest,
    mediaType: 'video',
    url: prerender.url,
    proxyUrl: null,
    previewOriginal: false,
    prerenderOf: clip.id,
  };
  playbackClipCache.set(clip, { key, clip: swapped });
  return swapped;
}
