// Reads audio file lengths for tiles that show one (AudioTile).
//
// Every length costs a media player while it loads. An expanded Sound Library
// can put hundreds of audio tiles in the panel at once, and each tile used to
// carry its own hidden <audio preload="metadata">: ~400 players starting
// together stopped the window from painting ("Renderer became unresponsive"),
// and the panel reopens with the same folders expanded, so the editor froze on
// every launch. Here at most PROBE_CONCURRENCY files load at a time, a player is
// released as soon as its length is known, and each URL is read once per page.

const PROBE_CONCURRENCY = 4;
// A file that never answers must not hold a slot forever.
const PROBE_TIMEOUT_MS = 15000;

const durations = new Map(); // src -> seconds, or null when it can't be read
const waiters = new Map(); // src -> Set of callbacks, while queued or loading
const queue = [];
let active = 0;

// The length already known for `src`: seconds, null (unreadable) or undefined.
export function cachedAudioDuration(src) {
  return durations.get(src);
}

// Calls `onDone(seconds | null)` once the length of `src` is known. Returns a
// cancel function; cancelling before the probe starts takes it out of the queue,
// so tiles scrolled past never load at all.
export function requestAudioDuration(src, onDone) {
  if (durations.has(src)) {
    onDone(durations.get(src));
    return () => {};
  }
  let callbacks = waiters.get(src);
  if (!callbacks) {
    callbacks = new Set();
    waiters.set(src, callbacks);
    queue.push(src);
  }
  callbacks.add(onDone);
  pump();
  return () => {
    callbacks.delete(onDone);
    if (callbacks.size > 0 || waiters.get(src) !== callbacks) return;
    const queued = queue.indexOf(src);
    if (queued >= 0) {
      queue.splice(queued, 1);
      waiters.delete(src);
    }
  };
}

function pump() {
  while (active < PROBE_CONCURRENCY && queue.length > 0) {
    probe(queue.shift());
  }
}

function probe(src) {
  active += 1;
  const audio = new Audio();
  audio.preload = "metadata";
  let settled = false;
  const finish = (seconds, remember) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // Drop the source so the player and its connection go away now, not at GC.
    audio.removeAttribute("src");
    audio.load();
    if (remember) durations.set(src, seconds);
    const callbacks = waiters.get(src);
    waiters.delete(src);
    active -= 1;
    if (callbacks) for (const cb of callbacks) cb(seconds);
    pump();
  };
  // Not remembered: a slow server now is no reason to never show the length.
  const timer = setTimeout(() => finish(null, false), PROBE_TIMEOUT_MS);
  audio.addEventListener("loadedmetadata", () => {
    const seconds = audio.duration;
    finish(Number.isFinite(seconds) && seconds > 0 ? seconds : null, true);
  }, { once: true });
  audio.addEventListener("error", () => finish(null, true), { once: true });
  audio.src = src;
}
