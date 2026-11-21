/*
 * One <video> brought to a time for a still or an exported frame (mediaClock.seekVideoAndWait), and the timing rules of a paused seek
 * the media clock shares. No imports: unit-tested in node (seekFrame.test.mjs); frame accuracy end to end in tests/still-frame-accuracy.
 */

// After a paused seek's `seeked`, how long to wait for a frame callback before treating the landed frame as presented anyway (see
// syncVideo and seekVideoFrame).
export const SEEKED_FRAME_GRACE_MS = 120;

// How far past the time asked for a still's seek lands. Chromium truncates a seek time to whole microseconds while the demuxer rounds
// each frame's time, so a time exactly on a frame boundary (k / fps: every step of the playhead, every exported frame) landed on the
// frame BEFORE it — at 30 fps (timescale 15360) every third boundary: t = 2/30 showed frame 1. The export's decoder takes the frame
// within 2 µs after the time (webcodecsClipDecoder FRAME_PICK_SLACK_US); 0.1 ms is far below any frame (8.3 ms at 120 fps).
export const FRAME_SEEK_NUDGE_S = 0.0001;

// A seek that never lands ends here.
export const SEEK_SAFETY_MS = 3000;

// An element this close to its frame's seek time is there: assigning currentTime the value it holds fires no 'seeked', and Chromium
// keeps a seek time to whole microseconds. Anything further is another position, possibly another frame (the 20 ms this used to
// allow kept the previous frame at 60 fps).
export const FRAME_AT_EPS_S = 1e-5;

// Where a seek for the frame at `targetTime` lands: just past the time (FRAME_SEEK_NUDGE_S), clamped into the element's media.
export function frameSeekTime(targetTime, duration) {
  const end = Number.isFinite(duration) ? Math.max(0, duration - 0.001) : Infinity;
  return Math.max(0, Math.min(targetTime + FRAME_SEEK_NUDGE_S, end));
}

/**
 * The frame callback of a paused seek, asked for BEFORE the seek (the preview's paused steps, mediaClock.syncVideo): Chrome presents
 * a paused element's landed frame just before 'seeked', so a callback asked for at 'seeked' waited for a presentation that had already
 * happened (the preview then showed the step's frame only after the grace). `arm` before setting currentTime; at 'seeked', `take`
 * says whether the landed frame was presented (with its metadata) or lets `onLate` have the callback when it comes after 'seeked'.
 * A new arm cancels the callback of the seek it replaces; `disarm` drops it (a seek of another kind, a new source).
 */
export function createLandedFrames() {
  const armed = new WeakMap();
  const disarm = (video) => {
    const st = armed.get(video);
    if (!st) return;
    armed.delete(video);
    if (!st.presented) {
      try { video.cancelVideoFrameCallback?.(st.id); } catch { /* no-op */ }
    }
  };
  return {
    arm(video) {
      disarm(video);
      if (typeof video?.requestVideoFrameCallback !== 'function') return false;
      const st = { id: 0, presented: false, metadata: undefined, onLate: null };
      st.id = video.requestVideoFrameCallback((now, metadata) => {
        st.presented = true;
        st.metadata = metadata;
        if (st.onLate) {
          const late = st.onLate;
          st.onLate = null;
          if (armed.get(video) === st) armed.delete(video);
          late(now, metadata);
        }
      });
      armed.set(video, st);
      return true;
    },
    disarm,
    /**
     * At 'seeked': null when nothing was armed (the caller asks for its own callback); else { presented, metadata, release } —
     * presented: the landed frame came, with its metadata (dropped when it names a frame after the landed position, which cannot
     * be the landed one); not presented: `onLate(now, metadata)` runs if the callback comes later, and `release()` (the grace
     * ended) cancels it unless a newer seek has armed the element since.
     */
    take(video, onLate) {
      const st = armed.get(video);
      if (!st) return null;
      if (st.presented) {
        armed.delete(video);
        const t = Number(st.metadata?.mediaTime);
        const fits = Number.isFinite(t) && t <= Number(video.currentTime) + 0.002;
        return { presented: true, metadata: fits ? st.metadata : undefined, release() {} };
      }
      st.onLate = onLate;
      return {
        presented: false,
        metadata: undefined,
        release() {
          st.onLate = null;
          if (armed.get(video) === st) disarm(video);
        },
      };
    },
  };
}

/**
 * Seek `video` to `targetTime` and resolve once the element holds that frame.
 *
 * The seek lands just past the time (FRAME_SEEK_NUDGE_S), so a time on a frame boundary shows that frame and not the one before.
 *
 * The frame callback is asked for BEFORE the seek. A paused element presents the landed frame just before 'seeked' (Chrome 157, off
 * the document: the callback came ~2 ms before 'seeked', with the landed frame, every time), so a callback asked for AT 'seeked' — as
 * this used to — waited for a presentation that had already happened: none came on the headless render page, and the 3 s safety timer
 * ended every wait (~3.0 s of every still of a project with a video layer, cold or warm). The element holds the landed frame at
 * 'seeked' (the frame drawn then = the frame 300 ms later, every time); a seek that lands on the frame already shown presents nothing,
 * so after 'seeked' the callback gets SEEKED_FRAME_GRACE_MS, then the frame goes through. Where the callback comes, the wait ends at
 * 'seeked' or at the callback, whichever is later, as before.
 *
 * An element whose source is still loading (no metadata yet: the preview's own buffer, created by the first frame a renderer that
 * has only just come up drew) is waited for — its metadata, at most `safetyMs` — and then sought. This used to resolve at once and
 * the still captured the layer empty: hidden by fixed waits before the capture (a cold WebGPU page's first still came out black
 * without them). An element with no source, one that failed or one not loading (preload none) resolves at once as before.
 */
export function seekVideoFrame(video, targetTime, { graceMs = SEEKED_FRAME_GRACE_MS, safetyMs = SEEK_SAFETY_MS } = {}) {
  if (video.src && video.readyState < 1 && !video.error && video.networkState === 2) {   // HTMLMediaElement.NETWORK_LOADING
    return new Promise((resolve) => {
      let timer = 0;
      const go = () => {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', go);
        video.removeEventListener('error', go);
        resolve(video.readyState >= 1 ? seekVideoFrame(video, targetTime, { graceMs, safetyMs }) : undefined);
      };
      video.addEventListener('loadedmetadata', go);
      video.addEventListener('error', go);
      timer = setTimeout(go, safetyMs);
    });
  }
  return new Promise((resolve) => {
    if (!video.src || video.readyState < 1) { resolve(); return; }
    const clampedTime = frameSeekTime(targetTime, video.duration);
    // Already there (the same time asked again, or the playhead put back where it was): assigning currentTime the value it holds
    // fires no 'seeked'. Only the same time is "there": the 20 ms this allowed kept the previous frame for the next one at 60 fps.
    if (Math.abs(video.currentTime - clampedTime) < FRAME_AT_EPS_S) {
      if (video.readyState >= 2) { resolve(); return; }
      video.addEventListener('canplay', () => resolve(), { once: true });
      setTimeout(resolve, 2000);
      return;
    }
    let settled = false;
    let landed = false;
    let presented = false;
    let callbackId = 0;
    let grace = 0;
    let safety = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      clearTimeout(safety);
      if (callbackId && !presented) {
        try { video.cancelVideoFrameCallback?.(callbackId); } catch { /* no-op */ }
      }
      resolve();
    };
    if (typeof video.requestVideoFrameCallback === 'function') {
      callbackId = video.requestVideoFrameCallback(() => {
        presented = true;
        if (landed) finish();
      });
    }
    video.currentTime = clampedTime;
    const onLanded = () => {
      landed = true;
      if (presented || !callbackId) finish();
      else grace = setTimeout(finish, graceMs);
    };
    video.addEventListener('seeked', () => {
      if (video.readyState >= 2) onLanded();
      else video.addEventListener('canplay', onLanded, { once: true });
    }, { once: true });
    safety = setTimeout(finish, safetyMs);
  });
}
