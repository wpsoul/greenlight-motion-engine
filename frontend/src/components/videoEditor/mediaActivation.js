import { isWebKitEngine } from './audioDriftSync.js';
/*
 * iOS media activation for preview video buffers and audio elements (plan A7 [rev]).
 *
 * WebKit's policy (https://webkit.org/blog/6784/new-video-policies-for-ios/):
 * an UNMUTED play() needs a user gesture, and unmuting a playing element outside
 * a gesture PAUSES it. Both are per element, and both are lifted for good once
 * that element has been play()ed from inside a gesture. The Player's own habits
 * collide with this head-on: buffers are created unmuted whenever project sound
 * is on, and they are started from `canplay` handlers, rVFC callbacks and the
 * rAF loop — never from the tap. On an iPad that reads as "first frames freeze
 * and stutter after every cut", because each swallowed play() and each
 * unmute-induced pause is a buffer that is not where the clock says it should be.
 *
 * THE RULE, IN ONE PLACE:
 *   - a buffer is created MUTED and marked `__needsActivation`;
 *   - it may be unmuted only once it is `__activated`, and activation happens
 *     exclusively inside the Play button's / sound toggle's click handler, where
 *     `activate()` play()s (then pause()s, unless it is the buffer about to
 *     play) every channel buffer with its intended muted state so WebKit
 *     records the gesture on each element;
 *   - buffers created later (a new channel) are activated by the next tap;
 *   - pre-warm play()s outside a gesture leave the element's muted state alone,
 *     so an un-activated element stays muted and is never rejected;
 *   - intentionally muted media (channel mute, clip volume 0, sound off) is a
 *     separate decision the Player makes per frame; `canUnmute` only adds
 *     "and the element is allowed to make sound at all".
 *
 * On the desktop tier every method is a no-op and `canUnmute` is always true,
 * so the packaged app's element lifecycle is unchanged.
 */

const NOOP = Object.freeze({
  enabled: false,
  noteCreated() {},
  canUnmute() { return true; },
  activate() { return 0; },
});

export function createMediaActivation(tier) {
  if (!tier?.touch) return NOOP;
  return {
    enabled: true,
    /** A fresh buffer: silent until a tap says otherwise. */
    noteCreated(video) {
      if (!video) return;
      video.muted = true;
      video.__needsActivation = true;
      video.__activated = false;
    },
    /** May the Player flip this element's `muted` to false right now? */
    canUnmute(video) {
      return !!video && video.__activated === true;
    },
    /**
     * Inside a user gesture. `intendedMuted(video)` is the state the Player wants
     * for that element; `isActive(video)` says whether it is the buffer that owns
     * the playhead (left playing) or a prepared one (paused straight after).
     * The synchronous play() call is what WebKit keys the activation on; the
     * returned promise is irrelevant here and its rejection (a pause() right
     * after, or an element with no source yet) is expected.
     */
    activate(videos, { intendedMuted = () => true, isActive = () => false } = {}) {
      let count = 0;
      for (const video of videos) {
        if (!video) continue;
        const muted = !!intendedMuted(video);
        const active = isActive(video);
        const volume = video.volume;
        try {
          const play = () => {
            const p = video.play();
            if (p && typeof p.catch === 'function') p.catch((error) => {
              if (error?.name === 'NotAllowedError') {
                video.__activated = false;
                video.__needsActivation = true;
              }
            });
          };
          // A muted play does not authorize later sound. Inactive/muted owners
          // make an audible-permission request and pause in this same task,
          // before any media can advance. Restore their actual mute afterwards.
          // WebKit <video>: the audible owner ALSO starts at volume 0 — an unmuted
          // start at audible volume puts its picture 0.3 s behind the clock for the
          // whole clip; applyVolume (audioDriftSync.js) raises it 300 ms in.
          const quietStart = isWebKitEngine && video.tagName === 'VIDEO';
          if (!active || muted || quietStart) video.volume = 0;
          video.muted = false;
          play();
          if (!active || muted) {
            video.pause();
            video.volume = quietStart ? 0 : volume;
            video.muted = muted;
            if (active) play();
          }
          video.__activated = true;
          video.__needsActivation = false;
          count += 1;
        } catch {
          video.__activated = false;
          video.__needsActivation = true;
        } finally {
          // The WebKit video keeps volume 0 here; the per-frame gate restores it.
          if (!(isWebKitEngine && video.tagName === 'VIDEO')) video.volume = volume;
          video.muted = muted;
        }
      }
      return count;
    },
  };
}
