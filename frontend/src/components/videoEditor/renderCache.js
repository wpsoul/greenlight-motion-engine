// ── Smart render cache ──
// DaVinci Resolve's "Smart" render cache for the preview: playback measures which
// parts of the timeline it cannot draw in real time (a red line over the ruler),
// the editor renders those parts in the background while the user is idle (the
// server render path, one short time range per job), and playback then shows the
// rendered file instead of compositing live (a blue line).
//
// The cache never guesses what is static. A cached file is only played for a
// SEGMENT (a fixed slice of the timeline) whose fingerprint still matches the one
// recorded when the file was rendered. The fingerprint covers every item whose
// visual extent touches the segment, everything those items reference, the clips
// they draw, the channel settings and the project-wide picture settings — so an
// edit only throws away the segments it can change, and the worst case is "not
// cached yet" (live, as without the cache), never a stale picture.
//
// Pure functions, no editor imports beyond the timeline layout, so the module is
// unit-testable in Node (renderCache.test.mjs).

import { getTimelineLayout } from './speedUtils.js';

export const RENDER_CACHE_SEGMENT_SEC = 1;
export const RENDER_CACHE_MODES = Object.freeze(['off', 'smart', 'user']);
export const DEFAULT_RENDER_CACHE_MODE = 'smart';
// Bumped when what a cached file means changes (format, alignment, hashing), so
// every entry recorded under the old meaning stops matching.
export const RENDER_CACHE_FORMAT = 'rc1';
// Items are counted into a segment if they come this close to it: motion blur
// samples around the frame time, and a few effects read neighbouring frames.
const EXTENT_MARGIN_SEC = 0.25;

export function sanitizeRenderCacheMode(value) {
  return RENDER_CACHE_MODES.includes(value) ? value : DEFAULT_RENDER_CACHE_MODE;
}

// FNV-1a over a string — the digest the layer and sequence prerenders use.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Sorted keys, no undefined members: an object edited in memory and the same object
// after a save/load round trip must digest identically. `skip` drops top-level keys
// only (a nested `name` can be a font name, which draws); `prerender` records are
// dropped at every depth (a nested sequence's own prerender does not change what
// the outer timeline shows).
function stableJson(value, skip = null, depth = 0) {
  if (value === null || typeof value !== 'object') {
    const json = JSON.stringify(value);
    return json === undefined ? 'null' : json;
  }
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v, null, depth + 1)).join(',')}]`;
  const keys = Object.keys(value).filter((k) => (
    value[k] !== undefined && k !== 'prerender' && !(depth === 0 && skip && skip.has(k))
  )).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k], null, depth + 1)}`).join(',')}}`;
}

const digestOf = (json) => `${fnv1a(json)}${json.length.toString(36)}`;

// Bookkeeping that never draws. `prerender` records (layer or sequence) are a
// faithful stand-in for the live layer, so one arriving or going stale does not
// change the picture; names do not draw.
const ITEM_SKIP = new Set(['prerender', 'customName']);
const CLIP_SKIP = new Set(['prerender', 'name']);
const CHANNEL_SKIP = new Set(['items']);

const itemDigestCache = new WeakMap();
function itemDigest(item) {
  let d = itemDigestCache.get(item);
  if (!d) {
    d = digestOf(stableJson(item, ITEM_SKIP));
    itemDigestCache.set(item, d);
  }
  return d;
}

const clipDigestCache = new WeakMap();
function clipDigest(clip) {
  if (!clip || typeof clip !== 'object') return '-';
  let d = clipDigestCache.get(clip);
  if (!d) {
    d = digestOf(stableJson(clip, CLIP_SKIP));
    clipDigestCache.set(clip, d);
  }
  return d;
}

// Channel settings without its items (solo, hidden, blend, channel effects…).
const channelDigestCache = new WeakMap();
function channelDigest(channel) {
  let d = channelDigestCache.get(channel);
  if (!d) {
    d = digestOf(stableJson(channel || {}, CHANNEL_SKIP));
    channelDigestCache.set(channel, d);
  }
  return d;
}

// Every other item id an item's fields mention — parent, matte source, follow
// target, tracker… Walking the values instead of naming the fields keeps a link
// type added later inside the fingerprint without anyone remembering to list it.
// The walk is memoised per item object as the set of short strings it holds; the
// id filter runs per call (the id set is rebuilt with every recompute).
const refCandidateCache = new WeakMap(); // item -> string[]
function itemRefs(item, idSet) {
  let candidates = refCandidateCache.get(item);
  if (!candidates) {
    const found = new Set();
    const walk = (v, depth) => {
      if (depth > 12 || v == null) return;
      if (typeof v === 'string') {
        if (v.length <= 96 && v !== item.id) found.add(v);
        return;
      }
      if (typeof v !== 'object') return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      for (const k of Object.keys(v)) if (k !== 'id') walk(v[k], depth + 1);
    };
    for (const k of Object.keys(item || {})) if (k !== 'id' && k !== 'clipId') walk(item[k], 0);
    candidates = [...found];
    refCandidateCache.set(item, candidates);
  }
  return candidates.filter((s) => idSet.has(s));
}

/**
 * Project-wide picture settings digest. `state` is the persisted project state;
 * the denylist names what is known NOT to draw, so a field added later is
 * included (a needless re-render, never a stale picture).
 */
const GLOBAL_SKIP = new Set([
  'channels', 'clips', 'version', 'activeChannelId', 'selectedTimelineId', 'currentTime',
  'previewFps', 'aiFillZones',
]);
export function renderCacheGlobalKey(state, { width, height, fps, renderer } = {}) {
  const json = stableJson(state || {}, GLOBAL_SKIP);
  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  return `${RENDER_CACHE_FORMAT}:${digestOf(json)}:${w}x${h}@${Number(fps) || 30}:${renderer || 'webgl'}`;
}

/** Timeline end over every channel (seconds). */
export function renderCacheTimelineEnd(channels) {
  let end = 0;
  for (const ch of channels || []) {
    for (const l of getTimelineLayout(ch.items || [], { unsnapped: ch.unsnapped })) {
      if (Number.isFinite(l?.endTime)) end = Math.max(end, l.endTime);
    }
  }
  return end;
}

export function segmentCount(duration, segSec = RENDER_CACHE_SEGMENT_SEC) {
  return Math.max(0, Math.ceil((Number(duration) || 0) / segSec - 1e-6));
}

export const segmentIndexAt = (t, segSec = RENDER_CACHE_SEGMENT_SEC) => Math.max(0, Math.floor((Number(t) || 0) / segSec + 1e-9));

// Two independent 32-bit lanes per key (FNV-1a and a second multiplier/seed): a
// segment is "the same" only when both lanes and the key count match, so a stale
// frame would need a 64-bit collision.
function keyLanes(str) {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return [a >>> 0, b >>> 0];
}
// Order-dependent fold of one key into a segment's running lanes (murmur3-style mix).
function mix(h, k) {
  let x = Math.imul(h ^ k, 0xcc9e2d51);
  x = (x << 15) | (x >>> 17);
  x = Math.imul(x, 0x1b873593);
  x ^= x >>> 13;
  return Math.imul(x, 0x85ebca6b) >>> 0;
}

/**
 * One fingerprint per segment: segment i covers [i·segSec, (i+1)·segSec).
 * Returns { hashes: string[], duration }. Item, clip and channel digests are
 * memoised per object, so an edit re-digests only what changed; every key is
 * hashed ONCE and folded into the segments it covers as two integer lanes, so the
 * per-segment work is a few integer ops per layer, not a string per segment.
 */
export function computeSegmentHashes({ channels, clips, globalKey, segSec = RENDER_CACHE_SEGMENT_SEC }) {
  const chs = Array.isArray(channels) ? channels : [];
  const clipMap = new Map((clips || []).map((c) => [c.id, c]));
  const itemById = new Map();
  for (const ch of chs) for (const it of ch.items || []) if (it?.id) itemById.set(it.id, it);
  const idSet = new Set(itemById.keys());

  const duration = renderCacheTimelineEnd(chs);
  const n = segmentCount(duration, segSec);
  // Per segment: the running lanes and key count of everything that draws in it,
  // folded in channel order.
  const laneA = new Uint32Array(n);
  const laneB = new Uint32Array(n);
  const count = new Uint32Array(n);
  const fold = (lanes, s) => {
    laneA[s] = mix(laneA[s], lanes[0]);
    laneB[s] = mix(laneB[s] ^ 0x5f3759df, lanes[1]);
    count[s] += 1;
  };
  chs.forEach((ch, ci) => {
    const chLanes = keyLanes(`c${ci}:${channelDigest(ch)}`);
    for (let s = 0; s < n; s += 1) fold(chLanes, s);
    const items = ch.items || [];
    const layout = getTimelineLayout(items, { unsnapped: ch.unsnapped });
    items.forEach((item, ii) => {
      const l = layout[ii];
      if (!l || !Number.isFinite(l.startTime) || !Number.isFinite(l.endTime)) return;
      const a = Math.max(0, l.startTime - EXTENT_MARGIN_SEC);
      const b = l.endTime + EXTENT_MARGIN_SEC;
      const first = Math.max(0, Math.floor(a / segSec));
      const last = Math.min(n - 1, Math.ceil(b / segSec) - 1);
      if (last < first) return;
      // The item, the clip it draws, and — transitively — every item it references
      // (and their clips), wherever those sit on the timeline.
      const seen = new Set([item.id]);
      const queue = [item];
      const keys = [];
      while (queue.length) {
        const it = queue.shift();
        keys.push(`${itemDigest(it)}/${clipDigest(clipMap.get(it.clipId))}@${it === item ? `${l.startTime.toFixed(4)}` : 'ref'}`);
        for (const rid of itemRefs(it, idSet)) {
          if (seen.has(rid)) continue;
          seen.add(rid);
          const ref = itemById.get(rid);
          if (ref) queue.push(ref);
        }
      }
      const itemLanes = keyLanes(`i${ci}.${ii}:${keys.join(',')}`);
      for (let s = first; s <= last; s += 1) fold(itemLanes, s);
    });
  });
  const g = globalKey || '';
  const hashes = new Array(n);
  for (let s = 0; s < n; s += 1) {
    hashes[s] = `${g}|${s}|${laneA[s].toString(16)}.${laneB[s].toString(16)}.${count[s]}`;
  }
  return { hashes, duration };
}

// ── Cost map ──
// Live playback records every painted frame. A segment is SLOW — the healer's
// to-do list — only when it plays below a smooth-enough rate: 25 fps, or the
// project's own rate when that is lower (renderCacheTargetFps). 25 fps already
// reads as film motion, so a 60 fps project playing at 40 is left alone.

export const RENDER_CACHE_MIN_FPS = 25;
const SAMPLE_WINDOW = 40;
const MIN_SAMPLES = 6;
// Timer jitter: 24.6 fps measured on a project that holds 25 is still 25.
const FPS_TOLERANCE = 0.97;

/** The frame rate below which a second of playback counts as slow. */
export function renderCacheTargetFps(projectFps, capFps = null) {
  const project = Number(projectFps) > 0 ? Number(projectFps) : 30;
  const cap = Number(capFps) > 0 ? Number(capFps) : Infinity;
  return Math.max(1, Math.min(RENDER_CACHE_MIN_FPS, project, cap));
}

export function createCostMap() {
  return { segs: new Map(), version: 0, slow: 0 };
}

/** Any segment currently judged slow (O(1): kept up to date on every verdict change). */
export const hasSlowSegments = (map) => (map?.slow || 0) > 0;

/**
 * `sample` = { t, gapMs, targetMs } — `gapMs` the time since the previous painted
 * frame, `targetMs` = 1000 / renderCacheTargetFps(). A low-confidence sample
 * (taken while a background render shares the machine) can only count a frame as
 * on time — it never makes a segment slow.
 * Returns true when the segment's verdict changed.
 */
export function recordCostSample(map, sample, segSec = RENDER_CACHE_SEGMENT_SEC, lowConfidence = !!sample?.lowConfidence) {
  if (!map || !sample) return false;
  const targetMs = Number(sample.targetMs) || 0;
  const gap = Number(sample.gapMs) || 0;
  if (!(targetMs > 0) || !(gap > 0)) return false;
  if (lowConfidence && gap > targetMs / FPS_TOLERANCE) return false;
  const i = segmentIndexAt(sample.t, segSec);
  let seg = map.segs.get(i);
  if (!seg) {
    seg = { gaps: [], verdict: 'unknown' };
    map.segs.set(i, seg);
  }
  seg.gaps.push(gap);
  if (seg.gaps.length > SAMPLE_WINDOW) seg.gaps.shift();
  const before = seg.verdict;
  seg.verdict = costVerdict(seg, targetMs);
  if (seg.verdict !== before) {
    map.slow += (seg.verdict === 'slow' ? 1 : 0) - (before === 'slow' ? 1 : 0);
    map.version += 1;
    return true;
  }
  return false;
}

// The segment's measured frame rate (frames over the time they took) against the bar.
function costVerdict(seg, targetMs) {
  const n = seg.gaps.length;
  if (n < MIN_SAMPLES) return seg.verdict === 'slow' ? 'slow' : 'unknown';
  const meanGap = seg.gaps.reduce((a, b) => a + b, 0) / n;
  return 1000 / meanGap < (1000 / targetMs) * FPS_TOLERANCE ? 'slow' : 'ok';
}

/** The measured frame rate of a segment (diagnostics), or null. */
export function segmentFps(map, i) {
  const gaps = map?.segs.get(i)?.gaps;
  if (!gaps?.length) return null;
  return 1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length);
}

export function segmentVerdict(map, i) {
  return map?.segs.get(i)?.verdict || 'unknown';
}

/** Mark segments slow without measuring (tests, the "debug" hook). */
export function forceSlowSegments(map, from, to) {
  for (let i = from; i <= to; i += 1) {
    if (map.segs.get(i)?.verdict !== 'slow') map.slow += 1;
    map.segs.set(i, { gaps: [], verdict: 'slow' });
  }
  map.version += 1;
}

export function clearCostMap(map) {
  map.segs.clear();
  map.slow = 0;
  map.version += 1;
}

// ── Entries ──
// entry = { id, url, t0, t1, w, h, fps, segHashes: { [i]: hash }, at }
// A segment is cached when an entry covers it with the segment's CURRENT hash.

export function entryForSegment(entries, i, hash) {
  if (!hash) return null;
  for (let k = (entries?.length || 0) - 1; k >= 0; k -= 1) {
    const e = entries[k];
    if (e?.segHashes?.[i] === hash) return e;
  }
  return null;
}

export function cachedEntryAt(entries, hashes, t, segSec = RENDER_CACHE_SEGMENT_SEC) {
  const i = segmentIndexAt(t, segSec);
  const entry = entryForSegment(entries, i, hashes?.[i]);
  if (!entry || t < entry.t0 - 1e-6 || t >= entry.t1 - 1e-6) return null;
  return { entry, localTime: t - entry.t0, segment: i };
}

/** Entries with at least one segment still valid; the rest are dead files. */
export function partitionEntries(entries, hashes) {
  const live = [];
  const dead = [];
  for (const e of entries || []) {
    const ok = Object.keys(e?.segHashes || {}).some((k) => hashes?.[Number(k)] === e.segHashes[k]);
    (ok ? live : dead).push(e);
  }
  return { live, dead };
}

// ── Planner ──

/**
 * Segments that are slow and not validly cached, merged into contiguous ranges of
 * at most `maxJobSec`, ordered: the range under/after the playhead first, then
 * the rest ahead in timeline order, then everything behind it.
 * Returns [{ t0, t1, segments: number[] }].
 */
export function planCacheJobs({
  costMap, hashes, entries, playhead = 0, duration, busy = null,
  segSec = RENDER_CACHE_SEGMENT_SEC, maxJobSec = 8,
}) {
  const n = hashes?.length || 0;
  const todo = [];
  for (let i = 0; i < n; i += 1) {
    if (segmentVerdict(costMap, i) !== 'slow') continue;
    if (busy && busy.has(i)) continue;
    if (entryForSegment(entries, i, hashes[i])) continue;
    todo.push(i);
  }
  const maxSegs = Math.max(1, Math.floor(maxJobSec / segSec));
  const end = Number.isFinite(duration) ? duration : n * segSec;
  const jobs = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const t0 = run[0] * segSec;
    const t1 = Math.min(end, (run[run.length - 1] + 1) * segSec);
    if (t1 - t0 > 0.05) jobs.push({ t0, t1, segments: run });
    run = [];
  };
  for (const i of todo) {
    if (run.length && (i !== run[run.length - 1] + 1 || run.length >= maxSegs)) flush();
    run.push(i);
  }
  flush();
  const here = segmentIndexAt(playhead, segSec);
  const ahead = jobs.filter((j) => j.segments[j.segments.length - 1] >= here);
  const behind = jobs.filter((j) => j.segments[j.segments.length - 1] < here).reverse();
  return [...ahead, ...behind];
}

// ── Status for the ruler ──

/**
 * Runs of segment states for the ruler line: 'cached' | 'pending' | 'slow'.
 * Segments with no state are left out. Returns [{ t0, t1, state }].
 */
export function renderCacheRuns({ costMap, hashes, entries, pending, duration, segSec = RENDER_CACHE_SEGMENT_SEC }) {
  const n = hashes?.length || 0;
  const end = Number.isFinite(duration) ? duration : n * segSec;
  const runs = [];
  for (let i = 0; i < n; i += 1) {
    let state = null;
    if (entryForSegment(entries, i, hashes[i])) state = 'cached';
    else if (pending && pending.has(i)) state = 'pending';
    else if (segmentVerdict(costMap, i) === 'slow') state = 'slow';
    if (!state) continue;
    const t0 = i * segSec;
    const t1 = Math.min(end, (i + 1) * segSec);
    const last = runs[runs.length - 1];
    if (last && last.state === state && Math.abs(last.t1 - t0) < 1e-6) last.t1 = t1;
    else runs.push({ t0, t1, state });
  }
  return runs;
}

// ── Storage ──
// Entries are a per-device cache, kept out of the project JSON (no autosave,
// history or collaboration churn). Losing them only costs a re-render.

const STORAGE_PREFIX = 'gl_ve_render_cache:v1:';
const MAX_ENTRIES = 300;

export function renderCacheStorageKey(boardId, projectId) {
  if (!projectId) return null;
  return `${STORAGE_PREFIX}${boardId || '-'}:${projectId}`;
}

export function loadRenderCacheEntries(storage, key) {
  if (!storage || !key) return [];
  try {
    const raw = storage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((e) => e && typeof e.url === 'string' && Number.isFinite(e.t0) && Number.isFinite(e.t1) && e.segHashes)
      : [];
  } catch {
    return [];
  }
}

export function saveRenderCacheEntries(storage, key, entries) {
  if (!storage || !key) return;
  try {
    const list = (entries || []).slice(-MAX_ENTRIES);
    if (list.length) storage.setItem(key, JSON.stringify(list));
    else storage.removeItem(key);
  } catch { /* storage full or blocked — the cache just stays in memory */ }
}
