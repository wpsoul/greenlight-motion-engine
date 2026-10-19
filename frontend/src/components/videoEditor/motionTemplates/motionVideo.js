// Video frames for motion templates.
//
// Templates are synchronous pure functions of time, but video frames only arrive
// asynchronously — so this module splits the two:
//
//   1. During a draw, a template calls `requestVideoFrame(url, t, lane)` (via
//      getMotionImage/getMotionMedia in mtl.js). That returns whatever frame the
//      lane currently holds — possibly a stale one, possibly null — and *records*
//      the request when the held frame isn't the one asked for.
//   2. Afterwards the caller (Player preview loop / exporter) checks
//      `motionMediaPending()` and awaits `pumpMotionMedia()`, then repaints. The
//      export repeats that until nothing is pending, so every encoded frame shows
//      the exact requested video frame and preview/export stay identical.
//
// Decoding reuses the timeline's WebCodecs path (ClipSource demuxes a URL once,
// one ClipDecoder per *consumer*) — see webcodecsClipDecoder.js. Only containers
// mp4box can demux are supported (MP4/MOV); anything else is reported as failed so
// templates fall back to their plate and the inspector can warn.
//
// No timers live here: draining is always caller-driven, which keeps the local
// template determinism check (localTemplates.js) stable.
import { ClipSource, ClipDecoder } from '../webcodecsClipDecoder';

const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi|flv|wmv|ogv|mpg|mpeg|3gp)(\?|#|$)/i;
const SUPPORTED_EXT_RE = /\.(mp4|m4v|mov)(\?|#|$)/i;

export function isMotionVideoUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (/^data:video\//i.test(url)) return true;
  return VIDEO_EXT_RE.test(url);
}

export function isSupportedMotionVideo(url) {
  if (!isMotionVideoUrl(url)) return false;
  if (/^data:video\/(mp4|quicktime|x-m4v)/i.test(url)) return true;
  return SUPPORTED_EXT_RE.test(url);
}

// A ClipSource keeps the whole encoded file in memory and a ClipDecoder holds a
// live VideoDecoder, so both are capped and evicted least-recently-used. Keep the
// caps above the biggest media list a template offers (7 cards in Card Fan, 10 in
// Scatter Cards): evicting a source that's still on screen would re-fetch and
// re-demux it every frame, which is far worse than holding it.
const MAX_SOURCES = 12;
const MAX_LANES = 24;

const sources = new Map(); // url -> source entry
const lanes = new Map();   // laneKey -> { url, decoder, drawnUs, requestUs, hasFrame, used }
const pendingLanes = new Set();
const decodingLanes = new Set(); // claimed by a pump, decode not finished yet
const unreadyUrls = new Set(); // requested while their source was still demuxing
const subs = new Set();
let useCounter = 0;
let pumpChain = Promise.resolve();

// Ambient clock — set by drawMotionFrame around each template draw so templates
// that only know about images (getMotionImage) still resolve a video frame for the
// clip's local time, on a lane private to that clip.
let clockTime = 0;
let clockScope = 'default';
export function setMotionMediaClock(timeSec, scope) {
  clockTime = Math.max(0, Number(timeSec) || 0);
  clockScope = scope || 'default';
}
export function clearMotionMediaClock() {
  clockTime = 0;
  clockScope = 'default';
}

function notify() {
  subs.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
}

export function onMotionMediaFrame(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

function evictSources() {
  while (sources.size > MAX_SOURCES) {
    let oldest = null;
    for (const entry of sources.values()) {
      if (!oldest || entry.used < oldest.used) oldest = entry;
    }
    if (!oldest) return;
    dropUrl(oldest.url);
  }
}

function evictLanes() {
  while (lanes.size > MAX_LANES) {
    let oldestKey = null;
    let oldest = null;
    for (const [key, lane] of lanes) {
      if (!oldest || lane.used < oldest.used) { oldest = lane; oldestKey = key; }
    }
    if (!oldestKey) return;
    closeLane(oldestKey, oldest);
  }
}

function closeLane(key, lane) {
  try { lane.decoder?.close(); } catch { /* ignore */ }
  pendingLanes.delete(lane);
  decodingLanes.delete(lane);
  lanes.delete(key);
}

function dropUrl(url) {
  for (const [key, lane] of [...lanes]) {
    if (lane.url === url) closeLane(key, lane);
  }
  sources.delete(url);
  unreadyUrls.delete(url);
}

// Demuxed source for a URL. Returns immediately; `.ready` settles when the sample
// table + codec config are available (or the file turned out to be undecodable).
export function getMotionVideoSource(url) {
  let entry = sources.get(url);
  if (!entry) {
    entry = {
      url,
      source: null,
      loaded: false,
      failed: false,
      reason: '',
      duration: 0,
      width: 0,
      height: 0,
      used: 0,
    };
    if (!isSupportedMotionVideo(url)) {
      entry.failed = true;
      entry.reason = 'container not supported (use MP4/MOV)';
      entry.ready = Promise.resolve(entry);
    } else {
      const source = new ClipSource(url);
      entry.source = source;
      entry.ready = source.init().then(
        (ok) => {
          if (ok) {
            entry.loaded = true;
            entry.width = source.width;
            entry.height = source.height;
            const last = source.samples[source.samples.length - 1];
            entry.duration = last ? (last.ts + (last.dur || 0)) / 1e6 : 0;
          } else {
            entry.failed = true;
            entry.reason = source.error || 'decode unavailable';
            console.warn(`[motion] Video unavailable for templates: ${url} (${entry.reason})`);
          }
          unreadyUrls.delete(url);
          return entry;
        },
        (err) => {
          entry.failed = true;
          entry.reason = err?.message || String(err);
          unreadyUrls.delete(url);
          return entry;
        },
      );
    }
    sources.set(url, entry);
  }
  entry.used = ++useCounter;
  evictSources();
  return entry;
}

// Preload hook for the Player: demux + report when durations are known.
export function prepareMotionVideo(url) {
  return getMotionVideoSource(url).ready;
}

function getLane(laneKey, url, sourceEntry) {
  let lane = lanes.get(laneKey);
  if (lane && lane.url !== url) { closeLane(laneKey, lane); lane = null; }
  if (!lane) {
    lane = { url, decoder: new ClipDecoder(sourceEntry.source), drawnUs: -1, requestUs: -1, hasFrame: false, used: 0 };
    lanes.set(laneKey, lane);
  }
  lane.used = ++useCounter;
  evictLanes();
  return lane;
}

// Frame for `timeSec` of `url` on its own decoder lane. Synchronous: returns the
// lane's current canvas (stale until the pump catches up) or null before the first
// decode, and flags the request as pending when it isn't satisfied yet.
export function requestVideoFrame(url, timeSec, laneKey) {
  const entry = getMotionVideoSource(url);
  if (entry.failed) return null;
  if (!entry.loaded) { unreadyUrls.add(url); return null; }

  const duration = entry.duration || 0;
  const clamped = duration > 0 ? Math.min(Math.max(0, timeSec), Math.max(0, duration - 1e-4)) : 0;
  const requestUs = Math.round(clamped * 1e6);
  const lane = getLane(laneKey || url, url, entry);
  if (lane.drawnUs !== requestUs) {
    lane.requestUs = requestUs;
    pendingLanes.add(lane);
  }
  return lane.hasFrame ? lane.decoder.canvas : null;
}

// The timestamp (µs) of the frame currently ON a lane's canvas, or null before
// its first decode. Callers that CACHE what they drew need this: the requested
// time alone can't tell a settled frame from a stale one, so a cache keyed on
// the request would hold the first frame forever.
export function videoLaneStamp(laneKey) {
  const lane = lanes.get(laneKey);
  return lane && lane.hasFrame ? lane.drawnUs : null;
}

// "Something a drawn frame asked for isn't on its canvas yet." Decodes already
// claimed by a running pump count too: a caller that checked between another
// pump's claim and its completion would otherwise believe the frame had settled
// and keep the stale one.
export function motionMediaPending() {
  return pendingLanes.size > 0 || decodingLanes.size > 0 || unreadyUrls.size > 0;
}

async function runPump() {
  let worked = false;
  if (unreadyUrls.size) {
    worked = true;
    await Promise.all([...unreadyUrls].map((url) => getMotionVideoSource(url).ready));
  }
  const batch = [...pendingLanes];
  pendingLanes.clear();
  if (batch.length) {
    worked = true;
    for (const lane of batch) decodingLanes.add(lane);
    await Promise.all(batch.map(async (lane) => {
      const targetUs = lane.requestUs;
      try {
        const drawn = await lane.decoder.drawFrameAt(targetUs / 1e6);
        if (drawn) lane.hasFrame = true;
      } catch { /* a dead decoder just keeps the previous frame */ } finally {
        lane.drawnUs = targetUs;
        decodingLanes.delete(lane);
      }
    }));
  }
  if (worked) notify();
}

// Decode every recorded request. Serialized: overlapping calls queue behind each
// other so two decode passes never fight over the same lane's decoder.
export function pumpMotionMedia() {
  pumpChain = pumpChain.then(runPump, runPump);
  return pumpChain;
}

export function releaseMotionMedia() {
  for (const [key, lane] of [...lanes]) closeLane(key, lane);
  sources.clear();
  pendingLanes.clear();
  decodingLanes.clear();
  unreadyUrls.clear();
}

// Entry shaped like the image cache's, resolved against the ambient clock: the
// frame loops with the motion clip's local time. This is what lets every template
// written against getMotionImage() show video without a single change.
export function getAmbientVideoEntry(url) {
  const entry = getMotionVideoSource(url);
  const base = {
    isVideo: true,
    ready: entry.ready,
    failed: entry.failed,
    duration: entry.duration,
    width: entry.width,
    height: entry.height,
    reason: entry.reason,
  };
  if (entry.failed || !entry.loaded) {
    if (!entry.failed) unreadyUrls.add(url);
    return { ...base, img: null, loaded: false };
  }
  const duration = entry.duration || 0;
  const time = duration > 0 ? clockTime % duration : 0;
  const canvas = requestVideoFrame(url, time, `${clockScope}::${url}`);
  return { ...base, img: canvas, loaded: !!canvas };
}
