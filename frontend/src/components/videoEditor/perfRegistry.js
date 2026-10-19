/*
 * What the Player is doing right now, readable from outside it.
 *
 * The Player owns the preview's <video> elements (detached from the DOM), the
 * renderer and the playback loop, so nothing else can count media stalls or
 * frames painted. This record is the seam: the Player writes plain counters into
 * it and the perf HUD (`frontend/src/mobile/perfHud.js`, behind `?perf=1`) and
 * the tier gates (tests/ve-tier/) read `window.__glPerfRegistry`.
 *
 * COST IS THE DESIGN CONSTRAINT. Every write here happens per frame or per media
 * event, so it is a counter increment or a field assignment — no allocation, no
 * timestamps per event, no listeners beyond four per element. Reading is the
 * HUD's job and happens on its own timer.
 */
export const perfRegistry = {
  /** Every live preview <video>; removed when its buffer is released. */
  videos: new Set(),
  /** Playback-loop rAF ticks. */
  frames: 0,
  /** renderFrame calls that actually painted (playing OR paused repaints). */
  rendered: 0,
  renderer: { backend: null, w: 0, h: 0, preserveDrawingBuffer: null },
  /** 'desktop' | 'touch' (previewDeviceTier), set when a Player mounts. */
  tier: null,
  /** The playback loop's effective fps cap: null renders every tick. */
  fpsCap: null,
  // `seek` = hard drift-correction seeks on audio elements (audioDriftSync.js);
  // `audioDrift` = the playing audio clip's position minus the clock, seconds (− = behind).
  events: { waiting: 0, stalled: 0, pause: 0, play: 0, seek: 0 },
  audioDrift: null,
  // JUMP_HOLD (Player.jsx): the last hold's length and why it ended ('landed' | 'timeout').
  jumpHold: null,
  lastUpdate: 0,
};

if (typeof window !== 'undefined') window.__glPerfRegistry = perfRegistry;

const EVENTS = ['waiting', 'stalled', 'pause', 'play'];

/** Register a preview element: one counter bump per media event, nothing else. */
export function trackPerfVideo(video) {
  if (!video || perfRegistry.videos.has(video)) return;
  perfRegistry.videos.add(video);
  for (const name of EVENTS) {
    video.addEventListener(name, () => {
      perfRegistry.events[name] += 1;
      perfRegistry.lastUpdate = performance.now();
    });
  }
}

/** The element's buffer was released; the listeners die with the element. */
export function forgetPerfVideo(video) {
  if (video) perfRegistry.videos.delete(video);
}

export function notePerfRenderer(patch) {
  Object.assign(perfRegistry.renderer, patch);
  perfRegistry.lastUpdate = performance.now();
}

/** How many preview buffers are downloading right now (HTMLMediaElement.NETWORK_LOADING). */
export function countLoadingPerfVideos() {
  let n = 0;
  for (const video of perfRegistry.videos) if (video.networkState === 2) n += 1;
  return n;
}
