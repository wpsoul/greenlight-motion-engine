// Live preview keeps media elements detached from the DOM: one standalone
// <audio> per channel plus two alternating <video> elements for visual clips.
// Reconcile them as a CHANNEL, never as a project-wide pool, so independent
// audio/voice channels can mix while media left behind by a layer handoff stops.

function pauseIfPlaying(media) {
  if (!media || media.paused) return false;
  try {
    media.pause();
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop every preview element this channel does not own on the current frame.
 *
 * `allowedVideos` normally contains the active clip's buffer. During a real
 * video-to-video transition it contains both buffers. Standalone audio clips
 * set `allowAudio`; media on every other channel is deliberately untouched.
 */
export function reconcileChannelPreviewMedia({
  audio = null,
  videos = [],
  allowAudio = false,
  allowedVideos = [],
} = {}) {
  const allowed = new Set(allowedVideos.filter(Boolean));
  let pausedCount = 0;

  if (!allowAudio && pauseIfPlaying(audio)) pausedCount += 1;
  for (const video of videos) {
    if (!allowed.has(video) && pauseIfPlaying(video)) pausedCount += 1;
  }

  return pausedCount;
}

/**
 * Decide whether the channel's inactive video buffer may be repurposed for the
 * next shot. A VideoTexture keeps a live reference to its HTMLVideoElement, so
 * changing that element's src while its texture is still being used as the
 * channel fallback changes pixels that are currently on screen.
 */
export function shouldPrepareNextVideo({
  isPlaying = false,
  isExporting = false,
  hasNextItem = false,
  hasNextLayout = false,
  nextMediaType = '',
  timeUntilNextClip = Infinity,
  preloadLead = 0,
  inactiveTexturePinned = false,
} = {}) {
  return !!(
    isPlaying
    && !isExporting
    && hasNextItem
    && hasNextLayout
    && nextMediaType === 'video'
    && Number.isFinite(timeUntilNextClip)
    && timeUntilNextClip >= 0
    && timeUntilNextClip <= preloadLead
    && !inactiveTexturePinned
  );
}

export function isInactiveTextureNeededAsFallback({
  activeHasFreshFrame = false,
  inactiveTexture = null,
  currentTexture = null,
  lastGoodTexture = null,
} = {}) {
  return !!(
    !activeHasFreshFrame
    && inactiveTexture
    && (currentTexture === inactiveTexture || lastGoodTexture === inactiveTexture)
  );
}

/**
 * Resolve the live-preview seek policy. An inactive buffer prepared for a cut
 * must land within half a project frame even though the project is playing.
 * A frame-critical ACTIVE buffer gets that precision only while paused: seeking
 * a freely playing video to chase the rAF clock interrupts frame presentation
 * whether or not the element happens to be audible.
 */
export function getPreviewVideoSeekPolicy({
  allowPlayback = true,
  frameAccurate = false,
  isPlaying = false,
  inTightSync = false,
  forceMuteAudio = false,
  fps = 30,
  slowSeeks = false,
} = {}) {
  const safeFps = Math.max(1, Number(fps) || 30);
  const wantsFrameAccurate = !allowPlayback || (frameAccurate && !isPlaying);
  const halfFrame = 0.45 / safeFps;
  // `slowSeeks` (WebKit): a seek on a PLAYING buffer silences and freezes it for
  // ~0.4 s, so chasing the clock at 0.5 s — or the 0.08 s tight hold before a
  // cut — re-creates the drift it corrects and loops. A playing buffer there is
  // seeked only past 1 s (audioDriftSync.js aims the seek ahead and cools it
  // down); paused, staged and frame-accurate buffers keep their precision.
  const playingLoose = slowSeeks && isPlaying && allowPlayback && !wantsFrameAccurate && !forceMuteAudio;
  return {
    wantsFrameAccurate,
    seekThreshold: wantsFrameAccurate
      ? halfFrame
      : playingLoose ? 1.0
        : inTightSync || forceMuteAudio ? 0.08 : isPlaying ? 0.5 : 0.04,
    pendingTolerance: wantsFrameAccurate
      ? 1.5 / safeFps
      : playingLoose ? 1.2
        : inTightSync ? 0.12 : isPlaying ? 0.8 : 0.15,
  };
}

/**
 * START ALIGNMENT. A paused buffer about to start while the project plays (on
 * Play, after a jump, after a fresh load, at a cut) must start ON the clock: a
 * buffer started behind stays behind, because the playing tolerances above
 * (0.08 s in a hand-off, 0.5 s after it) leave a small lag alone for good.
 * `ahead` is the buffer's position minus the clock's, in source seconds.
 *   'go'   close enough — start now
 *   'wait' ahead of the clock — stay paused until the clock reaches its frame
 *   'seek' behind (or far ahead) — seek `lead` s past the clock and wait there
 *
 * WebKit touch tier (`jumpHold`): a frame or three behind just starts and the
 * 0.12 s lead covers its 40–90 ms paused seek. Elsewhere a paused seek is cheap,
 * so the window is 1.5 project frames behind (at least 35 ms) to half a frame
 * ahead, scaled by the playback rate (a 2× clip covers two source frames per
 * timeline frame). Without it a video loaded cold started the 60–80 ms its load
 * took behind the clock — and behind a cut-out of the same shot playing above it.
 * One realignment per start (`realigned`): a seek that lands late starts where it
 * landed instead of seeking again.
 */
export function resolveStartAlignment({ ahead = 0, rate = 1, fps = 30, jumpHold = false, realigned = false } = {}) {
  if (jumpHold) {
    return { align: ahead >= -0.1 && ahead <= 0.03 ? 'go' : ahead > 0.03 && ahead <= 0.4 ? 'wait' : 'seek', lead: 0.12 };
  }
  const r = Math.min(16, Math.max(0.0625, Math.abs(Number(rate)) || 1));
  const frame = 1 / Math.max(1, Number(fps) || 30);
  const lead = 0.08 * r;
  if (ahead > 0.5 * frame * r) return { align: ahead <= 0.4 * r || realigned ? 'wait' : 'seek', lead };
  return { align: ahead >= -Math.max(1.5 * frame, 0.035) * r || realigned ? 'go' : 'seek', lead };
}

/**
 * CATCH-UP. A PLAYING video that runs off the others is pulled back by a small
 * playbackRate trim — never a seek, which would interrupt a playing stream (see
 * getPreviewVideoSeekPolicy). `excess` is its offset from the reference in
 * timeline seconds (− behind, + ahead); the factor closes it over ~0.4 s (faster
 * overshoots: the offset is read a frame late), at most ±8 %. It starts past a
 * sixth of a project frame — two layers of one shot a third of a frame apart —
 * and stops inside a twentieth (`trimming` = already on),
 * in 0.5 % steps so the rate is not rewritten every frame. The case it exists
 * for: an alpha WebM cut-out (software VP9) gets going 10–30 ms after the copy of
 * its shot underneath, and the playing tolerances above never pull it back.
 */
export function resolveRateTrim({ excess = 0, fps = 30, trimming = false } = {}) {
  const frame = 1 / Math.max(1, Number(fps) || 30);
  if (!Number.isFinite(excess) || Math.abs(excess) < (trimming ? 0.05 : 0.16) * frame) return 1;
  const trim = Math.max(-0.08, Math.min(0.08, -excess / 0.4));
  return 1 + Math.round(trim / 0.005) * 0.005;
}

/**
 * A prepared <video> is not actually ready for a hard cut until its VideoTexture
 * has been uploaded once. Track that upload by source, target project frame, and
 * texture identity so the render loop primes once rather than on every tick.
 */
export function shouldPrimePreparedVideoTexture({
  previous = null,
  texture = null,
  source = '',
  targetTime = 0,
  fps = 30,
  ready = false,
} = {}) {
  if (!ready || !texture || !source) return false;
  const safeFps = Math.max(1, Number(fps) || 30);
  const targetFrame = Math.round(Math.max(0, Number(targetTime) || 0) * safeFps);
  return !previous
    || previous.texture !== texture
    || previous.source !== source
    || previous.targetFrame !== targetFrame;
}

export function preparedVideoTexturePrimeState({
  texture,
  source,
  targetTime = 0,
  fps = 30,
} = {}) {
  const safeFps = Math.max(1, Number(fps) || 30);
  return {
    texture,
    source,
    targetFrame: Math.round(Math.max(0, Number(targetTime) || 0) * safeFps),
  };
}
