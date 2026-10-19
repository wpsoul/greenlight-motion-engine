// Keeping PLAYING media elements on the master clock — intervene as rarely as
// the engine can afford. Audio clips and transition cues are handled whole here
// (`startPlayingAudio` / `syncPlayingAudio` / `parkAudio`); the channel VIDEO
// buffers keep their own seek machinery in Player.syncVideo and borrow only the
// WebKit pieces (`applyMute`, `learnStartLag`, the stall lead and the seek
// cooldown) — an UNMUTED WebKit video starts ~0.3 s late exactly like an audio
// element. Keep drift recovery bounded without suppressing audible content.
//
// WHY: the Player used to re-seek an audio element whenever it drifted more than
// 0.3 s from the master clock. On WebKit (iPad, Safari) that was a self-sustaining
// loop: WebKit's `play()` starts ~0.25 s late, so the first seek fired within a
// second, and EVERY intervention on a playing WebKit audio element — a seek, or a
// pitch-preserving playbackRate change — silences it for ~0.4 s while AVFoundation
// rebuilds its pipeline (measured standalone: a seek lands in 62 ms but the
// position resumes ~0.4 s later; rate 1→1.1→1 loses ~0.45 s per change; setting
// `volume` or `muted` every frame costs nothing). Each correction therefore
// created the next one: one seek every 0.6 s, the music playing half of every
// second, heard as "the music keeps interrupting". Chromium seeks and re-rates in
// milliseconds and never entered the loop, which is why the desktop never showed it.
// Measurements: tests/ve-webkit-audio-sync/.
//
// POLICY
// - Start: play the exact requested content without a mute window or lead-in
//   skip. If startup leaves > 0.3 s drift after 1.2 s, allow one correction.
// - Steady state, WebKit: leave it alone. A hard seek only past 1.0 s of drift,
//   aimed the learned lag ahead so it lands in sync after the stall, and
//   never twice within the cooldown or while a seek is in flight.
// - Steady state, other engines (desktop Chromium / Electron): the old rule — a
//   seek straight to the target past 0.3 s, nothing else. The ±15 % tempo nudge
//   this file used to apply there (between 0.12 and 0.6 s) was audible: it fired
//   at every cut inside one audio file and switched the audio renderer in and out
//   of time-stretching dozens of times per play.
// - Paused / scrubbing: park on the target, but only when not already there —
//   writing the same `currentTime` is still a seek on WebKit (101 seeks in 2 s of
//   same-value writes, measured), which is what made a paused editor churn.

/**
 * WebKit-family engine: Safari on Mac and iPad (also with its "Macintosh" desktop
 * UA), every iOS/iPadOS browser (all WebKit by platform rule, "CriOS" included),
 * and Playwright's WebKit. Chromium-based browsers and Electron carry "Chrome" in
 * the UA and are excluded; Firefox has no "AppleWebKit". A UA test, because the
 * prefixed `webkitAudioContext` is no longer a reliable WebKit marker.
 */
const UA = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
export const isWebKitEngine = /AppleWebKit/i.test(UA)
  && (/iPhone|iPad|iPod/i.test(UA) || !/Chrome|Chromium|Edg\/|OPR\/|Electron/i.test(UA));

export const AUDIO_HARD_SEEK_DRIFT = isWebKitEngine ? 1.0 : 0.6;
export const AUDIO_NUDGE_DRIFT = 0.12;
export const AUDIO_NUDGE_MAX_RATE = 1.15;
export const AUDIO_NUDGE_MIN_RATE = 0.85;
export const AUDIO_SEEK_COOLDOWN_MS = 2000;
/** Desktop: drift a playing audio element may have before it is seeked (no nudge, no cooldown). */
export const DESKTOP_AUDIO_SEEK_DRIFT = 0.3;
/** Residual drift after a start that earns ONE early corrective seek (see the learn step). */
export const AUDIO_START_CORRECT_DRIFT = 0.3;
// What a start or a seek COSTS on WebKit, per media kind — learned at run time,
// shared by every element of that kind (channel buffers alternate, so a
// per-element memory would re-learn on every cut), for bounded corrective seeks. Seeds are what
// Playwright WebKit measured inside the Player: an
// <audio> comes up ~0.25 s behind, a <video> seek while playing costs ~0.5 s;
// Chromium starts within a frame or two.
const LEARNED_LAG = { audio: isWebKitEngine ? 0.25 : 0.05, video: isWebKitEngine ? 0.5 : 0.05 };
const kindOf = (el) => (el && el.tagName === 'AUDIO' ? 'audio' : 'video');
/** Lead a corrective seek is aimed ahead by on WebKit (0 elsewhere). */
export const seekStallLead = (el) => (isWebKitEngine ? LEARNED_LAG[kindOf(el)] : 0);
function learn(el, measured) {
  const kind = kindOf(el);
  LEARNED_LAG[kind] = LEARNED_LAG[kind] * 0.5 + measured * 0.5;
  stateOf(el).startupLag = LEARNED_LAG[kind];
}

function stateOf(el) {
  return el.__glDriftSync || (el.__glDriftSync = { seekAt: 0, startupLag: LEARNED_LAG[kindOf(el)], startedAt: 0, startLead: 0, pendingUntil: 0 });
}
/** How long a start may stay "paused" before we treat the play() as lost and start again. */
const START_PENDING_MS = 2500;

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Start at the requested content, including short cues; never skip a cold lead-in. */
export function startPlayingAudio(el, target, now = nowMs(), sourceEnd = Infinity) {
  const state = stateOf(el);
  if (now < state.pendingUntil) return state.playPromise || Promise.resolve();
  state.pendingUntil = now + START_PENDING_MS;
  const start = clampAudioTarget(el, target, sourceEnd);
  if (Number.isFinite(start) && !el.seeking && Math.abs(el.currentTime - start) > 0.02) {
    try { el.currentTime = start; } catch { /* metadata may still be loading */ }
  }
  if (el.playbackRate !== 1) el.playbackRate = 1;
  state.startedAt = now;
  state.startLead = 0;
  const failed = (error) => {
    state.pendingUntil = 0;
    state.startedAt = 0;
    state.playPromise = null;
    throw error;
  };
  try {
    // Keep the play call synchronous so a transport gesture can authorize it.
    state.playPromise = Promise.resolve(el.play()).then(() => {
      state.pendingUntil = 0;
      state.playPromise = null;
    }, failed);
    return state.playPromise;
  } catch (error) {
    state.pendingUntil = 0;
    state.startedAt = 0;
    return Promise.reject(error);
  }
}

function clampAudioTarget(el, target, sourceEnd) {
  const end = Math.min(sourceEnd, Number.isFinite(el.duration) ? el.duration : Infinity);
  return Math.max(0, Math.min(target, Math.max(0, end - 0.001)));
}

/**
 * Keep a playing element on `target` (seconds in the element's own timeline).
 * Returns what it did — 'seeking' | 'cooldown' | 'seek' | 'nudge' | 'locked' —
 * so callers and gates can count seeks. `onSeek(drift)` fires on a hard seek.
 */
export function syncPlayingAudio(el, target, now = nowMs(), onSeek = null, sourceEnd = Infinity) {
  if (!el || !Number.isFinite(target)) return 'locked';
  if (el.seeking) return 'seeking';
  const state = stateOf(el);
  state.pendingUntil = 0; // it is playing: the start has landed
  const drift = el.currentTime - target; // + ahead of the clock, − behind it
  const magnitude = Math.abs(drift);

  // Desktop (Chromium / Electron): the rule from before the WebKit work — leave the
  // element alone, seek straight to the target once it is more than 0.3 s off (a cut
  // inside one file, a jump). Never a tempo nudge: a playbackRate other than 1 with
  // pitch preserved switches Chromium's audio renderer into time-stretching and back,
  // which is audible, and the nudge ran on every drift past 0.12 s (40+ rate writes
  // in 8 s of a project with one cut in its music, measured on Electron 33 and 40).
  if (!isWebKitEngine) {
    state.startedAt = 0;
    if (el.playbackRate !== 1) el.playbackRate = 1;
    if (magnitude <= DESKTOP_AUDIO_SEEK_DRIFT) return 'locked';
    state.seekAt = now;
    try { el.currentTime = clampAudioTarget(el, target, sourceEnd); } catch { /* metadata may still be loading */ }
    if (onSeek) onSeek(drift);
    return 'seek';
  }

  // Learn the start-up lag once the start has settled (WebKit keeps stalling for
  // a moment after `playing`, so the first reading under-measures it): the element
  // was parked `startLead` ahead, so its remaining lag is lead − drift. If the
  // residual is still large — WebKit's lag varies between a cold play and a
  // resume — correct it ONCE here, aimed ahead of the stall, rather than leave
  // the picture and the music half a second apart for the whole play.
  if (state.startedAt && now - state.startedAt > 1200 && now - state.startedAt < 4000) {
    if (state.startLead > 0) learn(el, Math.max(0, Math.min(1.5, state.startLead - drift))); // a resume (lead 0) says nothing about the cold lag
    state.startedAt = 0;
    if (magnitude > AUDIO_START_CORRECT_DRIFT && now - state.seekAt >= AUDIO_SEEK_COOLDOWN_MS) {
      state.seekAt = now;
      try { el.currentTime = clampAudioTarget(el, target + seekStallLead(el), sourceEnd); } catch { /* metadata may still be loading */ }
      if (onSeek) onSeek(drift);
      return 'seek';
    }
  }

  if (magnitude > AUDIO_HARD_SEEK_DRIFT) {
    if (now - state.seekAt < AUDIO_SEEK_COOLDOWN_MS) return 'cooldown';
    state.seekAt = now;
    if (el.playbackRate !== 1) el.playbackRate = 1;
    try { el.currentTime = clampAudioTarget(el, target + seekStallLead(el), sourceEnd); } catch { /* metadata may still be loading */ }
    if (onSeek) onSeek(drift);
    return 'seek';
  }
  if (isWebKitEngine) return 'locked'; // a rate change costs as much as a seek here
  if (magnitude > AUDIO_NUDGE_DRIFT) {
    const rate = Math.max(AUDIO_NUDGE_MIN_RATE, Math.min(AUDIO_NUDGE_MAX_RATE, 1 - drift * 0.6));
    if (Math.abs(el.playbackRate - rate) > 0.005) el.playbackRate = rate;
    return 'nudge';
  }
  if (el.playbackRate !== 1) el.playbackRate = 1;
  return 'locked';
}

/** Paused / scrubbing: park the element on `target`, only when it is not already there. */
export function parkAudio(el, target) {
  if (!el || !Number.isFinite(target)) return false;
  const state = stateOf(el);
  state.pendingUntil = 0; // a park while paused ends any pending start
  if (el.playbackRate !== 1) el.playbackRate = 1;
  if (el.seeking || Math.abs(el.currentTime - target) < 0.002) return false;
  try { el.currentTime = target; } catch { return false; }
  return true;
}

// ── Video buffers (WebKit only; a no-op elsewhere) ─────────────────────────────

/** Only explicit project/clip mute controls silence media. A delayed unmute
 * after play/seek can remain latched forever, and discards short sound effects. */
export function applyMute(el, shouldMute) {
  if (el && el.muted !== !!shouldMute) el.muted = !!shouldMute;
}

/**
 * THE WEBKIT VIDEO START RULE — a VOLUME gate, never a mute. Measured on
 * Playwright WebKit as an iPad, sounding clip, presented frame vs the clock:
 * unmuted start 0.33 s behind (stays there); muted start 0.01 but iOS never
 * authorises sound for an element that only ever played muted; UNMUTED start at
 * volume 0, volume raised 300 ms after `playing`: 0.01 with sound on, and the
 * unmuted play() inside the gesture IS the audible-permission request iOS wants.
 * A resume after pause: 0.08 the same way. So on WebKit a <video>'s volume is 0
 * until it has been playing for AUDIBLE_AFTER_PLAYING_MS since its last
 * start / seek / stall, then the Player's wanted volume applies — evaluated on
 * every frame from the element's live state, so it cannot latch: a `waiting`
 * that never gets its `playing` self-heals after a second of steady playback.
 * <audio> elements gain only 0.32 → 0.22–0.31 s from the same trick and keep
 * the plain assignment. Other engines: plain assignment.
 */
export const AUDIBLE_AFTER_PLAYING_MS = 300;

function armVolumeGate(el) {
  if (el.__glVolumeGate) return;
  el.__glVolumeGate = true;
  const playing = !el.paused && !el.seeking && el.readyState >= 3;
  el.__glAudibleAt = playing ? nowMs() + AUDIBLE_AFTER_PLAYING_MS : Infinity;
  el.__glQuietSince = playing ? 0 : nowMs();
  el.addEventListener('playing', () => { el.__glAudibleAt = nowMs() + AUDIBLE_AFTER_PLAYING_MS; el.__glQuietSince = 0; });
  for (const ev of ['pause', 'seeking', 'waiting', 'emptied']) {
    el.addEventListener(ev, () => { el.__glAudibleAt = Infinity; el.__glQuietSince = nowMs(); });
  }
}

/** Set a media element's volume the way the Player wants it, through the WebKit video start rule. */
export function applyVolume(el, wanted) {
  if (!el) return;
  const v = Math.max(0, Math.min(1, Number.isFinite(wanted) ? wanted : 1));
  let effective = v;
  if (isWebKitEngine && el.tagName === 'VIDEO' && v > 0) {
    armVolumeGate(el);
    const now = nowMs();
    const steady = !el.paused && !el.seeking && el.readyState >= 3;
    if (steady && el.__glAudibleAt === Infinity && el.__glQuietSince && now - el.__glQuietSince > 1000) {
      el.__glAudibleAt = now; // self-heal: playing for a second with no `playing` event
    }
    if (!steady || now < el.__glAudibleAt) effective = 0;
  }
  if (Math.abs(el.volume - effective) > 0.01) el.volume = effective;
}

/**
 * Called every sync while a WebKit video buffer plays: learns the start-up lag
 * from the settled drift (as the audio path does) and says whether the residual
 * earns the ONE early corrective seek. Never fires twice for one start.
 */
export function learnStartLag(el, drift, now = nowMs()) {
  if (!isWebKitEngine || !el) return false;
  const state = stateOf(el);
  state.pendingUntil = 0;
  if (!state.startedAt || now - state.startedAt <= 1200) return false;
  if (now - state.startedAt >= 4000) { state.startedAt = 0; return false; }
  learn(el, Math.max(0, Math.min(1.5, state.startLead - drift)));
  state.startedAt = 0;
  return Math.abs(drift) > AUDIO_START_CORRECT_DRIFT;
}

/** Playing-buffer corrective seek on WebKit: honour the cooldown; returns the target to aim at (ahead by the stall lead) or null to skip. */
export function webkitPlayingSeekTarget(el, target, maxTarget, now = nowMs()) {
  if (!isWebKitEngine || !el) return target;
  const state = stateOf(el);
  if (now - state.seekAt < AUDIO_SEEK_COOLDOWN_MS) return null;
  state.seekAt = now;
  return Math.min(maxTarget, target + seekStallLead(el));
}
