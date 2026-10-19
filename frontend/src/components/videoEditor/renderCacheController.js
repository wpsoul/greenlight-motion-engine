// ── Smart render cache: the editor-side controller ──
// One per editor. Holds the cost map the Player feeds while playing live, the
// segment fingerprints of the current timeline, the rendered entries, and the
// background job queue (one server render at a time). The ruler line subscribes
// through subscribe/getSnapshot (useSyncExternalStore), so nothing here re-renders
// the editor. Pure logic lives in renderCache.js.

import {
  RENDER_CACHE_SEGMENT_SEC,
  computeSegmentHashes,
  createCostMap,
  recordCostSample,
  hasSlowSegments,
  forceSlowSegments,
  clearCostMap,
  planCacheJobs,
  cachedEntryAt,
  partitionEntries,
  renderCacheRuns,
  loadRenderCacheEntries,
  saveRenderCacheEntries,
  sanitizeRenderCacheMode,
} from './renderCache.js';

// Resolve's default: background caching starts after 5 s without activity.
export const RENDER_CACHE_IDLE_MS = 5000;
// Short jobs: the first green arrives sooner, and a job cancelled because the user
// came back loses little.
export const RENDER_CACHE_JOB_SEC = 4;
const POLL_MS = 600;
const NOTIFY_MS = 120;
const MAX_FAILURES = 3;

// Job ids this browser started for the cache. The editor's "reattach to a running
// render" on mount must not adopt one of these as the user's own render.
const JOB_IDS_KEY = 'gl_ve_render_cache_jobs';
function readJobIds() {
  try { return new Set(JSON.parse(sessionStorage.getItem(JOB_IDS_KEY) || '[]')); } catch { return new Set(); }
}
function rememberJobId(id) {
  try {
    const ids = [...readJobIds(), id].slice(-50);
    sessionStorage.setItem(JOB_IDS_KEY, JSON.stringify(ids));
  } catch { /* ignore */ }
}
export function isRenderCacheJobId(id) {
  return !!id && readJobIds().has(id);
}

function safeStorage() {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

class SkipJob extends Error {}

export function createRenderCacheController({ storage = safeStorage(), now = () => Date.now() } = {}) {
  const st = {
    mode: 'smart',
    enabled: false,
    costMap: createCostMap(),
    inputs: null,           // { channels, clips, globalKey, width, height, fps }
    hashes: null,           // string[] for `inputs`, or null when dirty
    duration: 0,
    entries: [],
    storageKey: null,
    job: null,              // { t0, t1, segments, segHashes, id, cancelled, progress }
    failures: 0,
    playing: false,
    lastActivity: now(),
    idleTimer: null,
    notifyTimer: null,
    drainQueue: false,      // "Render cache now": keep going until the plan is empty
    deps: null,             // { save, createJob, getJob, cancelJob, otherRenderActive, getPlayhead, cacheSize }
    listeners: new Set(),
    snapshot: null,
    disposed: false,
    hashRuns: 0,            // diagnostics: how often the fingerprints were computed
  };

  const active = () => st.enabled && st.mode !== 'off' && !st.disposed;
  // Fingerprints are only worth computing when something can use them: a slow
  // segment (the ruler line, the healer), an entry (playback), a running job. A
  // project that plays in real time never computes one.
  const needsHashes = () => hasSlowSegments(st.costMap) || st.entries.length > 0 || !!st.job;

  function getHashes() {
    if (!st.inputs) return null;
    if (!st.hashes) {
      st.hashRuns += 1;
      const { hashes, duration } = computeSegmentHashes({
        channels: st.inputs.channels,
        clips: st.inputs.clips,
        globalKey: st.inputs.globalKey,
      });
      st.hashes = hashes;
      st.duration = duration;
      // Entries with no segment left valid are dead weight (their file stays in
      // the stash until the server's 7-day prune).
      const { live, dead } = partitionEntries(st.entries, hashes);
      if (dead.length) {
        st.entries = live;
        saveRenderCacheEntries(storage, st.storageKey, st.entries);
      }
    }
    return st.hashes;
  }

  function buildSnapshot() {
    const hashes = active() && needsHashes() ? getHashes() : null;
    const runs = hashes ? renderCacheRuns({
      costMap: st.costMap,
      hashes,
      entries: st.entries,
      pending: st.job ? new Set(st.job.segments) : null,
      duration: st.duration,
    }) : [];
    return {
      mode: st.mode,
      enabled: st.enabled,
      runs,
      job: st.job ? { t0: st.job.t0, t1: st.job.t1, progress: st.job.progress } : null,
      entries: st.entries.length,
      failures: st.failures,
    };
  }

  function notifyNow() {
    clearTimeout(st.notifyTimer);
    st.notifyTimer = null;
    st.snapshot = buildSnapshot();
    for (const fn of st.listeners) {
      try { fn(); } catch { /* a listener must not break the others */ }
    }
  }
  function notify() {
    if (st.notifyTimer || st.disposed) return;
    st.notifyTimer = setTimeout(notifyNow, NOTIFY_MS);
  }

  // ── Idle scheduling ──
  function armIdle() {
    clearTimeout(st.idleTimer);
    st.idleTimer = null;
    if (!active() || st.mode !== 'smart' || st.playing || !st.deps || !hasSlowSegments(st.costMap)) return;
    st.idleTimer = setTimeout(() => {
      st.idleTimer = null;
      if (now() - st.lastActivity >= RENDER_CACHE_IDLE_MS - 50 && !st.playing) runNext();
      else armIdle();
    }, RENDER_CACHE_IDLE_MS);
  }
  function noteActivity() {
    st.lastActivity = now();
    // Smart caching is background work for idle time, like Resolve's: the moment
    // the user plays, edits or scrubs, a running job is cancelled so it never
    // competes with them (its range is planned again after the next idle period).
    // "Render cache now" was asked for explicitly and keeps going.
    const job = st.job;
    if (job && !job.cancelled && !st.drainQueue && st.mode === 'smart') {
      job.cancelled = true;
      if (job.id) st.deps?.cancelJob?.(job.id)?.catch?.(() => {});
    }
    armIdle();
  }

  // ── The job runner ──
  async function runNext() {
    if (st.job || !active() || !st.deps) return;
    if (!hasSlowSegments(st.costMap)) {
      st.drainQueue = false;
      return;
    }
    const hashes = getHashes();
    if (!hashes) return;
    const plan = planCacheJobs({
      costMap: st.costMap,
      hashes,
      entries: st.entries,
      playhead: st.deps.getPlayhead?.() || 0,
      duration: st.duration,
      maxJobSec: RENDER_CACHE_JOB_SEC,
    });
    if (!plan.length) {
      st.drainQueue = false;
      return;
    }
    const next = plan[0];
    const segHashes = {};
    for (const i of next.segments) segHashes[i] = hashes[i];
    const job = { ...next, segHashes, id: null, cancelled: false, progress: 0 };
    st.job = job;
    notify();
    try {
      if (await st.deps.otherRenderActive?.()) throw new SkipJob('another render is running');
      if (job.cancelled) throw new SkipJob('cancelled');
      if (await st.deps.save() === false) throw new SkipJob('project not saved');
      // The server renders what was SAVED. An edit that landed in between changes
      // the fingerprints we would stamp on the file — skip this round.
      const after = getHashes();
      if (!after || next.segments.some((i) => after[i] !== segHashes[i])) throw new SkipJob('edited while saving');
      if (job.cancelled) throw new SkipJob('cancelled');
      const size = st.deps.cacheSize();
      const created = await st.deps.createJob({
        rangeStart: next.t0,
        rangeEnd: next.t1,
        width: size.w,
        height: size.h,
        fps: st.inputs.fps,
        fileName: `rcache_${Math.round(next.t0 * 1000)}_${String(segHashes[next.segments[0]]).slice(-8).replace(/[^\w]/g, '')}`,
      });
      job.id = created?.id || null;
      if (!job.id) throw new Error('the server did not start the render job');
      rememberJobId(job.id);
      let misses = 0;
      for (;;) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (job.cancelled) {
          st.deps.cancelJob?.(job.id).catch?.(() => {});
          throw new SkipJob('cancelled');
        }
        let status;
        try {
          status = await st.deps.getJob(job.id);
          misses = 0;
        } catch (pollErr) {
          misses += 1;
          if (misses > 50) throw pollErr;
          continue;
        }
        const raw = Number(status?.progress);
        job.progress = Number.isFinite(raw) ? Math.min(0.99, raw > 1 ? raw / 100 : raw) : 0;
        notify();
        if (status?.status === 'completed') {
          const url = status?.result?.url;
          if (!url) throw new Error('the render produced no file');
          st.entries = [...st.entries, {
            id: job.id,
            url,
            t0: next.t0,
            t1: next.t1,
            w: size.w,
            h: size.h,
            fps: st.inputs.fps,
            segHashes,
            at: now(),
          }];
          saveRenderCacheEntries(storage, st.storageKey, st.entries);
          st.failures = 0;
          break;
        }
        if (status?.status === 'cancelled') throw new SkipJob('cancelled on the server');
        if (status?.status === 'failed') throw new Error(status.error || 'server render failed');
      }
    } catch (err) {
      if (!(err instanceof SkipJob)) {
        st.failures += 1;
        console.warn('[render cache] job failed:', err?.message || err);
      }
    } finally {
      if (st.job === job) st.job = null;
      notify();
    }
    if (!active() || st.failures >= MAX_FAILURES) {
      st.drainQueue = false;
      return;
    }
    // Keep going while the user stays idle (Smart) or until the plan is empty
    // ("Render cache now"). Otherwise the next idle period picks it up.
    if (st.drainQueue || (st.mode === 'smart' && !st.playing && now() - st.lastActivity >= RENDER_CACHE_IDLE_MS - 50)) {
      setTimeout(runNext, 0);
    } else {
      armIdle();
    }
  }

  // A running job whose segments were ALL edited away is pointless.
  function cancelStaleJob() {
    const job = st.job;
    if (!job) return;
    const hashes = getHashes();
    if (!hashes) return;
    if (job.segments.every((i) => hashes[i] !== job.segHashes[i])) job.cancelled = true;
  }

  const api = {
    // Wiring
    setDeps(deps) { st.deps = deps; armIdle(); },
    setProject(storageKey) {
      if (storageKey === st.storageKey) return;
      if (st.job) st.job.cancelled = true;
      st.storageKey = storageKey;
      st.entries = loadRenderCacheEntries(storage, storageKey);
      clearCostMap(st.costMap);
      st.hashes = null;
      st.failures = 0;
      notify();
    },
    setInputs(inputs) {
      const prev = st.inputs;
      if (prev && prev.channels === inputs.channels && prev.clips === inputs.clips
        && prev.globalKey === inputs.globalKey && prev.fps === inputs.fps) return;
      st.inputs = inputs;
      st.hashes = null;
      if (prev) {
        st.failures = 0; // an edit is a fresh chance for a failing range
        noteActivity();
        cancelStaleJob();
      }
      if (needsHashes()) notify();
    },
    setMode(mode) {
      const m = sanitizeRenderCacheMode(mode);
      if (m === st.mode) return;
      st.mode = m;
      if (m === 'off' && st.job) st.job.cancelled = true;
      armIdle();
      notify();
    },
    setEnabled(on) {
      const v = !!on;
      if (v === st.enabled) return;
      st.enabled = v;
      if (!v && st.job) st.job.cancelled = true;
      armIdle();
      notify();
    },
    setPlaying(playing) {
      const v = !!playing;
      if (v === st.playing) return;
      st.playing = v;
      noteActivity();
    },
    noteActivity,

    // Player hooks
    isActive: active,
    isRendering: () => !!st.job,
    recordSample(sample) {
      if (!active()) return;
      if (recordCostSample(st.costMap, sample, RENDER_CACHE_SEGMENT_SEC, !!st.job)) {
        notify();
        armIdle(); // a segment just turned slow (or back) — the healer may have work
      }
    },
    hasEntries: () => st.entries.length > 0,
    entryAt(t) {
      if (!active() || !st.entries.length) return null;
      const hashes = getHashes();
      return hashes ? cachedEntryAt(st.entries, hashes, t) : null;
    },
    dropEntry(url) {
      const next = st.entries.filter((e) => e.url !== url);
      if (next.length === st.entries.length) return;
      st.entries = next;
      saveRenderCacheEntries(storage, st.storageKey, st.entries);
      notify();
    },

    // Commands
    renderNow() {
      if (!active()) return;
      st.drainQueue = true;
      st.failures = 0;
      runNext();
    },
    clear() {
      if (st.job) st.job.cancelled = true;
      st.entries = [];
      saveRenderCacheEntries(storage, st.storageKey, st.entries);
      notify();
    },
    forgetMeasurements() {
      clearCostMap(st.costMap);
      notify();
    },

    // Store
    subscribe(fn) {
      st.listeners.add(fn);
      return () => st.listeners.delete(fn);
    },
    getSnapshot() {
      if (!st.snapshot) st.snapshot = buildSnapshot();
      return st.snapshot;
    },

    // Diagnostics / gates (window.__veRenderCache)
    debug: {
      forceSlow(t0, t1) {
        forceSlowSegments(st.costMap, Math.floor(t0 / RENDER_CACHE_SEGMENT_SEC), Math.ceil(t1 / RENDER_CACHE_SEGMENT_SEC) - 1);
        notify();
        armIdle();
      },
      state: () => ({
        mode: st.mode,
        enabled: st.enabled,
        playing: st.playing,
        duration: st.duration,
        segments: st.hashes?.length ?? null,
        slow: [...st.costMap.segs.entries()].filter(([, s]) => s.verdict === 'slow').map(([i]) => i),
        verdicts: Object.fromEntries([...st.costMap.segs.entries()].map(([i, s]) => [i, `${s.verdict}:${s.gaps.length}:${s.gaps.length ? (1000 / (s.gaps.reduce((a, b) => a + b, 0) / s.gaps.length)).toFixed(1) : '-'}fps`])),
        entries: st.entries.map((e) => ({ url: e.url, t0: e.t0, t1: e.t1, w: e.w, h: e.h, fps: e.fps, segs: Object.keys(e.segHashes).length })),
        job: st.job ? { t0: st.job.t0, t1: st.job.t1, id: st.job.id, progress: st.job.progress } : null,
        failures: st.failures,
        hashRuns: st.hashRuns,
        idleInMs: Math.max(0, RENDER_CACHE_IDLE_MS - (now() - st.lastActivity)),
      }),
      runNext: () => runNext(),
    },

    dispose() {
      st.disposed = true;
      clearTimeout(st.idleTimer);
      clearTimeout(st.notifyTimer);
      const job = st.job;
      if (job) {
        job.cancelled = true;
        if (job.id) st.deps?.cancelJob?.(job.id)?.catch?.(() => {});
      }
      st.listeners.clear();
    },
  };
  return api;
}
