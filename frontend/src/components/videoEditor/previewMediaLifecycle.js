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
