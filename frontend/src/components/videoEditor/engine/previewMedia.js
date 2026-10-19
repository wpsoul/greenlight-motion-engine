/*
 * The preview's device tier, the media-activation policy and the factory for the engine's <video> buffers
 * (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 5 — moved verbatim out of Player.jsx so the channel
 * states (./channelStates.js) can create their buffers outside the component).
 *
 * One tier and one activation policy per page: both are module singletons, as they were in the Player.
 */
import { getPreviewTier } from '../previewDeviceTier.js';
import { createMediaActivation } from '../mediaActivation.js';
import { trackPerfVideo } from '../perfRegistry.js';

export const PREVIEW_TIER = getPreviewTier();
// iOS activation policy for the preview buffers — a no-op on the desktop tier
// (see mediaActivation.js for the WebKit rules this exists for).
export const mediaActivation = createMediaActivation(PREVIEW_TIER);

export function createVideoElement(soundEnabled, gatedTextureUpdates = false) {
  const video = document.createElement('video');
  video.muted = !soundEnabled;
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  // 'auto' on desktop (today). On the touch tier a fresh buffer fetches metadata
  // only until syncVideo hands it a clip that is about to play (A7).
  video.preload = PREVIEW_TIER.preloadPolicy.idlePreload;
  // Touch tier: born muted and awaiting a user gesture — WebKit rejects an
  // unmuted play() outside one and pauses an element unmuted outside one.
  mediaActivation.noteCreated(video);
  trackPerfVideo(video);
  // Channel clip buffers gate their own GPU uploads (videoFrameReadyRef +
  // pendingSeek/awaitingFreshFrame in getVideoTexture) so a mid-seek frame — or a
  // buffer re-sourced to the NEXT shot while its texture is still on screen as the
  // channel fallback — never reaches the GPU at a shot boundary. Transition-package
  // media keep Three's default always-upload behavior.
  video.__gatedTextureUpdates = gatedTextureUpdates;
  return video;
}
