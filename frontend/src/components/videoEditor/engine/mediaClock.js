/*
 * The media clock (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 28b — moved verbatim out of Player.jsx with
 * tests/engine-extraction/tools/stage9_step.py): syncVideo keeps one <video> on the timeline's time (play / pause /
 * seek / hold across a jump), the seek helpers bring every video and particle-object video to a time for a still or an
 * export, syncTransitionSounds plays the transition sound cues, resolvePlaybackClockTime / isJumpHoldLanded read the
 * playhead from the media, getTotalDuration sums the timeline, ensureChannelStates keeps one state per channel.
 *
 * Each takes an `env` with the editor values it reads, memoized over exactly the old callback's dependency list (a value
 * it read WITHOUT listing it — `forceMuteAudio` — rides along at the same staleness).
 */
import { PARTICLE_MEDIA_TYPE } from '../../../sim/particles/schema.js';
import { applyMute, isWebKitEngine, learnStartLag, parkAudio, startPlayingAudio, syncPlayingAudio, webkitPlayingSeekTarget } from '../audioDriftSync';
import { countLoadingPerfVideos, perfRegistry } from '../perfRegistry.js';
import { ensurePreviewAudio } from '../previewAudioMedia.js';
import { preloadForPreviewBuffer } from '../previewDeviceTier.js';
import { getPreviewVideoSeekPolicy, resolveRateTrim, resolveStartAlignment } from '../previewMediaLifecycle';
import { getTimelineEndTime, getTimelineLayout } from '../speedUtils';
import { isContainerClip, SEQUENCE_MAX_DEPTH } from '../types';
import { syncChannelStates } from './channelStates';
import { resolveActiveIndex } from './compositeHelpers';
import { calculateVideoTime } from './layerHelpers';
import { ensureVideoFrameLoop as ensureVideoFrameLoopInEngine, getClipPlaybackUrl, normalizeUrl, queueTextureDisposal as queueTextureDisposalInEngine, recordPresentedMediaTime as recordPresentedMediaTimeInEngine } from './mediaTextures';
import { mediaActivation, PREVIEW_TIER } from './previewMedia';
import { JUMP_HOLD, SEEKED_FRAME_GRACE_MS, mapSourceToTimeline } from './mediaHelpers';

// Buffers that already took their one start-alignment seek (resolveStartAlignment):
// cleared when the buffer starts or changes source.
const startRealigned = new WeakSet();

// CATCH-UP (resolveRateTrim). Per video: { err, factor, nominal } — `err` its smoothed
// offset from its target in timeline seconds (currentTime against the clock). Per
// engine: the reference, the median offset of every video synced in the previous
// frame. They all read currentTime a frame stale, so a lag they share is not an error,
// and a video with no other video playing is never trimmed. Measured on screen (a frame
// counter in both layers): an alpha WebM cut-out over the copy of its shot inside a
// sequence showed its frames one late on every frame of the shot; with the trim, on
// none from ~0.3 s after the cut. (Steering by the frames rVFC reports as presented
// instead was slower: those reports move in whole display refreshes.)
const rateTrims = new WeakMap();
const trimReferences = new WeakMap();

// The playbackRate factor a catch-up holds on `video` (1 = none): renderChannel's own
// rate check compares against speed × this, so it does not undo the trim.
export function playbackRateTrim(video) {
  return rateTrims.get(video)?.factor || 1;
}

function endRateTrim(video, nominal) {
  const st = rateTrims.get(video);
  if (!st) return;
  rateTrims.delete(video);
  const rate = nominal > 0 ? nominal : st.nominal;
  if (st.factor !== 1 && rate > 0) video.playbackRate = rate;
}

function trimReferenceFor(engine) {
  let ref = trimReferences.get(engine);
  if (!ref) {
    ref = { stamp: null, errs: [], median: null };
    trimReferences.set(engine, ref);
  }
  if (ref.stamp !== engine.sequenceFrameStamp) {
    const errs = ref.errs.sort((a, b) => a - b);
    const n = errs.length;
    ref.median = n >= 2 ? (n % 2 ? errs[n >> 1] : (errs[n / 2 - 1] + errs[n / 2]) / 2) : null;
    ref.errs = [];
    ref.stamp = engine.sequenceFrameStamp;
  }
  return ref;
}

function updateRateTrim(engine, env, video, nominal, targetTime) {
  const ref = trimReferenceFor(engine);
  const raw = (video.currentTime - targetTime) / nominal;
  const st = rateTrims.get(video) || { err: raw, factor: 1, nominal };
  st.err += (raw - st.err) * 0.3;
  st.nominal = nominal;
  rateTrims.set(video, st);
  ref.errs.push(st.err);
  // A sound would bend with the rate (preservesPitch is off): only silent videos are
  // trimmed — muted, or a file with no audio (Chromium: video decoded, no audio bytes).
  const silent = video.muted || video.volume === 0
    || (video.webkitAudioDecodedByteCount === 0 && video.webkitVideoDecodedByteCount > 200000);
  const factor = silent && ref.median !== null
    ? resolveRateTrim({ excess: st.err - ref.median, fps: env.projectFps, trimming: st.factor !== 1 })
    : 1;
  if (factor !== st.factor) {
    st.factor = factor;
    video.playbackRate = nominal * factor;
  } else if (factor !== 1 && Math.abs(video.playbackRate - nominal * factor) > 0.002) {
    video.playbackRate = nominal * factor; // a speed ramp moved the nominal rate
  }
}

export function syncVideo(engine, env, video, clip, targetTime, options = {}) {
  const clipSource = getClipPlaybackUrl(clip);
  if (!video || !clip || clip._placeholder || !clipSource) return false;
  const { allowPlayback = true, frameAccurate = false, nearCutBoundary = false, idleStaging = false } = options;
  const nextSource = normalizeUrl(clipSource);
  const currentSource = normalizeUrl(video.src || video.getAttribute('src') || '');
  let changedSource = false;
  if (nextSource !== currentSource) {
    // A7 (touch tier): a buffer STAGED for later waits its turn while the tier's
    // cap on concurrently downloading buffers is reached — renderChannel asks
    // again next tick, so the stage happens as soon as a download finishes. The
    // buffer that owns the playhead is never held back. Desktop: cap is Infinity.
    const loadCap = PREVIEW_TIER.preloadPolicy.maxLoadingBuffers;
    if (!allowPlayback && Number.isFinite(loadCap) && countLoadingPerfVideos() >= loadCap) return false;
    const sourceGen = (engine.sourceGeneration.get(video) || 0) + 1;
    engine.sourceGeneration.set(video, sourceGen);
    const isCurrentSourceLoad = () => (
      engine.sourceGeneration.get(video) === sourceGen
      && normalizeUrl(video.src || video.getAttribute('src') || '') === nextSource
    );
    const cachedTexture = engine.videoTextureCache.get(video);
    if (cachedTexture) {
      queueTextureDisposalInEngine(engine, cachedTexture.texture);
      engine.videoTextureCache.delete(video);
    }
    engine.preparedVideoTexturePrime.delete(video);
    { const tk = engine.rvfcLoop.get(video); if (tk) tk.live = false; } // old loop is stale once src changes
    try { video.pause(); } catch { /* no-op */ }
    try { video.removeAttribute('src'); video.load(); } catch { /* no-op */ }
    engine.awaitingFreshFrame.add(video);
    video.src = clipSource;
    // 'auto' on desktop. Touch: 'auto' for the playing buffer and the same-channel
    // next clip; metadata only for an idle channel's early stage (A7).
    video.preload = preloadForPreviewBuffer(PREVIEW_TIER, { active: allowPlayback, idleStaging });
    const triggerRender = () => {
      if (isCurrentSourceLoad()) engine.renderFrame();
    };
    const clearFreshFrameWait = () => {
      if (!isCurrentSourceLoad()) return;
      engine.awaitingFreshFrame.delete(video);
      // A gated buffer's texture only uploads on this flag — the new source's
      // first presented frame has to raise it itself now that Three's internal
      // rVFC loop is cancelled for clip buffers.
      engine.videoFrameReady.add(video);
      engine.renderFrame();
    };
    // Register the fresh-frame rVFC NOW, before load() can present anything.
    // Registering it inside 'loadeddata' (as this used to) races the browser:
    // if the first frame is presented before that handler runs, the callback
    // waits for a next presentation that a paused preload buffer never makes —
    // the awaitingFreshFrame gate then sticks until play() at the edge, and the
    // edge bridges 1-3 frames of the channel's previous shot. A pre-registered
    // callback cannot miss the first presentation (Chromium runs the deferred
    // trim-in seek before first decode, so that presentation IS the target
    // frame). The rAF fallback has no presentation semantics, so it stays tied
    // to 'loadeddata'.
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => {
        clearFreshFrameWait();
      });
    } else {
      video.addEventListener('loadeddata', () => {
        requestAnimationFrame(() => {
          clearFreshFrameWait();
        });
      }, { once: true });
    }
    // No play() at 'canplay': by then the clock has moved on from the position
    // asked for at load time (a load takes 60–300 ms), and a buffer started there
    // stays that far behind. The render 'canplay' triggers runs syncVideo, which
    // starts it aligned to the clock (start alignment below).
    video.addEventListener('loadeddata', triggerRender, { once: true });
    video.addEventListener('canplay', triggerRender, { once: true });
    video.addEventListener('error', triggerRender, { once: true });
    startRealigned.delete(video);
    endRateTrim(video);
    video.load();
    changedSource = true;
    engine.pendingSeek.delete(video);
    const pendingTimeout = engine.seekTimeout.get(video);
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      engine.seekTimeout.delete(video);
    }
  }
  // Touch tier: a buffer staged with preload=metadata that now owns the playhead
  // may download ahead. Desktop buffers are always 'auto', so this never writes.
  if (PREVIEW_TIER.touch && allowPlayback && video.preload !== 'auto') video.preload = 'auto';
  const hasKnownDuration = Number.isFinite(video.duration) && video.duration > 0;
  const clampedTargetTime = hasKnownDuration
    ? Math.max(0, Math.min(targetTime, Math.max(0, video.duration - 0.001)))
    : Math.max(0, targetTime);

  const tightSyncUntil = engine.tightSyncUntil.get(video) || 0;
  // nearCutBoundary borrows the handoff tight-sync policy: converge onto the
  // clip clock (and its trim-out clamp) in the last beat before a hard cut.
  const inTightSync = env.isPlaying && (performance.now() < tightSyncUntil || nearCutBoundary);

  // A keyed mask/roto outline is evaluated from the composition clock. While
  // PAUSED it must land within half a project frame so the outline is judged
  // against the requested frame. During live playback the video must free-run:
  // seeking it to chase rAF interrupts decode/presentation even when it is muted.
  // Because every enabled mask currently marks its layer frame-critical, the old
  // silent-only rule repeatedly sought even a static mask whenever project sound
  // was off, holding the last good texture between seeks and making playback jump.
  // Inactive cut buffers (`allowPlayback:false`) keep half-frame precision, and
  // deterministic export uses its decoder path rather than this preview policy.
  const { seekThreshold, pendingTolerance } = getPreviewVideoSeekPolicy({
    allowPlayback,
    frameAccurate,
    isPlaying: env.isPlaying,
    inTightSync,
    forceMuteAudio: engine.forceMuteAudio,
    fps: env.projectFps,
    slowSeeks: isWebKitEngine && !video.paused, // a held/paused buffer seeks precisely
  });
  const seekDelta = Math.abs(video.currentTime - clampedTargetTime);
  // WebKit, playing for real: learn this buffer's start-up lag from the settled
  // drift and allow ONE early correction when it is still > 0.3 s off — the
  // same rule as audio clips (audioDriftSync.js). `webkitPlaying` also routes
  // the seek below through the cooldown + stall-lead path.
  const webkitPlaying = isWebKitEngine && env.isPlaying && allowPlayback && !video.paused && !video.seeking;
  const earlyCorrection = webkitPlaying && learnStartLag(video, video.currentTime - clampedTargetTime);
  // START ALIGNMENT (resolveStartAlignment). A paused buffer about to start while
  // the project plays (after a jump, after a fresh load, on Play, at a cut) must
  // start ON the clock: started behind, it stays behind. Close enough it just
  // starts; AHEAD it stays paused until the clock reaches its frame; anywhere
  // else it is seeked a lead past the clock and waits there.
  let startAlign = null;
  let startLead = 0;
  if (env.isPlaying && allowPlayback && video.paused && !video.seeking
    && !engine.jumpHold.active && video.readyState >= 1 && !changedSource) {
    const decision = resolveStartAlignment({
      ahead: video.currentTime - clampedTargetTime,
      rate: video.playbackRate,
      fps: env.projectFps,
      jumpHold: JUMP_HOLD,
      realigned: startRealigned.has(video),
    });
    startAlign = decision.align;
    startLead = decision.lead;
  }
  // Off the touch tier the alignment owns a paused start outright: a buffer it
  // lets go (or holds) is not re-seeked to the bare clock by the ordinary
  // threshold — that seek would land behind it again.
  const alignOwnsStart = !JUMP_HOLD && (startAlign === 'go' || startAlign === 'wait');

  // If a previous seek is still pending, avoid issuing another one unless drift is large.
  const hasPendingSeek = engine.pendingSeek.has(video);
  if (hasPendingSeek) {
    if (!video.seeking) {
      engine.pendingSeek.delete(video);
      const pendingTimeout = engine.seekTimeout.get(video);
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        engine.seekTimeout.delete(video);
      }
    } else {
      if (seekDelta <= pendingTolerance) {
        return false;
      }
    }
  }

  if ((seekDelta > seekThreshold && !alignOwnsStart) || earlyCorrection || startAlign === 'seek') {
    // A playing WebKit buffer: at most one seek per cooldown, aimed ahead so the
    // picture lands on the clock once the ~0.4 s post-seek stall ends.
    let seekTo = clampedTargetTime;
    if (startAlign === 'seek') {
      seekTo = hasKnownDuration ? Math.min(clampedTargetTime + startLead, Math.max(clampedTargetTime, video.duration - 0.05)) : clampedTargetTime + startLead;
      startRealigned.add(video);
    } else if (webkitPlaying) {
      seekTo = webkitPlayingSeekTarget(video, clampedTargetTime, hasKnownDuration ? Math.max(clampedTargetTime, video.duration - 0.05) : clampedTargetTime + 0.4);
      if (seekTo === null) return false;
    }
    const gen = (engine.seekGeneration.get(video) || 0) + 1;
    engine.seekGeneration.set(video, gen);

    // The WebGL allocation can survive reuse of this buffer, but after a seek
    // its pixels still contain the previously-uploaded frame. Make the inactive
    // hard-cut preloader upload the newly-decoded target even when source,
    // texture identity, and trim-in frame are otherwise unchanged.
    engine.preparedVideoTexturePrime.delete(video);
    endRateTrim(video, options.rate);

    try {
      video.currentTime = seekTo;
    } catch {
      return false;
    }

    if (!engine.pendingSeek.has(video)) {
      engine.pendingSeek.add(video);
      const onSeeked = (_now, metadata) => {
        // While paused this rVFC is the ONLY confirmation of a presented frame —
        // the playback loop is not running — so it is also where a stepped
        // playhead's source warp learns which picture actually landed.
        recordPresentedMediaTimeInEngine(engine, video, metadata);
        engine.pendingSeek.delete(video);
        const pendingTimeout = engine.seekTimeout.get(video);
        if (pendingTimeout) {
          clearTimeout(pendingTimeout);
          engine.seekTimeout.delete(video);
        }
        // The gate suppressed uploads for the whole seek; the frame this rVFC
        // presented is the landed target, so let it through. While paused this
        // is the ONLY way the landed frame reaches the GPU (the play-driven
        // frame loop is not running, and Three's own loop is cancelled).
        // A landed seek is also a valid fresh-frame signal for a just-re-sourced
        // buffer (the deferred trim-in seek completing IS its first real frame),
        // so release that gate here too as a backstop for the pre-registered
        // rVFC in the source-change path.
        engine.awaitingFreshFrame.delete(video);
        engine.videoFrameReady.add(video);
        if (engine.seekGeneration.get(video) === gen) {
          engine.renderFrame();
        }
      };
      const timeoutId = setTimeout(() => {
        engine.pendingSeek.delete(video);
        engine.seekTimeout.delete(video);
        engine.videoFrameReady.add(video); // best effort: show whatever the stuck element presents
        engine.renderFrame();
      }, 1500);
      engine.seekTimeout.set(video, timeoutId);
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.addEventListener('seeked', () => {
          // Chromium fires NO frame callback after a PAUSED seek of a stream it
          // decodes in software — alpha VP9, i.e. a prerendered sequence or an
          // alpha WebM clip: the landed frame is decoded and drawable, but no
          // presentation is reported, so the 1.5 s backstop above was the only
          // thing that ever showed it (1.5 s per scrub step). `seeked` itself
          // guarantees the element holds the landed frame; give the callback one
          // short chance to report the precise media time, then let it through.
          let landed = false;
          const settle = (now, metadata) => {
            if (landed) return;
            landed = true;
            onSeeked(now, metadata);
          };
          video.requestVideoFrameCallback(settle);
          setTimeout(() => settle(performance.now(), undefined), SEEKED_FRAME_GRACE_MS);
        }, { once: true });
      } else {
        video.addEventListener('seeked', onSeeked, { once: true });
      }
    }
    return false;
  }
  if (!env.isPlaying && video.readyState < 2 && !video.error && !video.seeking) {
    if (!engine.primeInFlight.has(video)) {
      engine.primeInFlight.add(video);
      video.play().then(() => {
        video.pause();
        engine.primeInFlight.delete(video);
        engine.videoFrameReady.add(video); // the prime's decoded frame must pass the upload gate
        engine.renderFrame();
      }).catch(() => {
        engine.primeInFlight.delete(video);
      });
    }
    return false;
  }
  if (env.isPlaying && allowPlayback && video.readyState >= 2 && !video.seeking) {
    // Play if needed AND (re)arm the frame loop every sync — this is what keeps a
    // just-activated, previously-preloaded clip from freezing on its first frame.
    if (video.paused && !engine.jumpHold.active && startAlign !== 'wait') {
      startRealigned.delete(video);
      video.play().catch(() => {});
    }
    ensureVideoFrameLoopInEngine(engine, video);
  }
  // Catch-up: a video that has been playing (not one starting this frame) is
  // trimmed toward the others. `options.rate` is the clip's own speed — only the
  // playing buffers renderChannel drives pass it. Not on WebKit, where every rate
  // change silences the element for ~0.4 s.
  const nominalRate = Number(options.rate);
  if (!isWebKitEngine && nominalRate > 0 && env.isPlaying && allowPlayback && startAlign === null
    && !video.paused && !video.seeking && video.readyState >= 2 && !changedSource
    && hasKnownDuration && clampedTargetTime < video.duration - 0.1) {
    updateRateTrim(engine, env, video, nominalRate, clampedTargetTime);
  } else if (rateTrims.has(video)) {
    endRateTrim(video, nominalRate);
  }
  if (inTightSync && seekDelta <= seekThreshold) {
    engine.tightSyncUntil.delete(video);
  }
  if (changedSource) return false;
  return video.readyState >= 2 && !video.seeking;
}

export function seekVideoAndWait(engine, video, targetTime) {
  return new Promise((resolve) => {
    if (!video.src || video.readyState < 1) { resolve(); return; }
    const clampedTime = Number.isFinite(video.duration)
      ? Math.max(0, Math.min(targetTime, video.duration - 0.001))
      : Math.max(0, targetTime);
    if (Math.abs(video.currentTime - clampedTime) < 0.02) {
      // Already close enough
      if (video.readyState >= 2) { resolve(); return; }
      video.addEventListener('canplay', () => resolve(), { once: true });
      setTimeout(resolve, 2000);
      return;
    }
    video.currentTime = clampedTime;
    const onReady = () => {
      // Wait for actual frame via RVFC if available
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(() => resolve());
      } else {
        resolve();
      }
    };
    video.addEventListener('seeked', () => {
      if (video.readyState >= 2) onReady();
      else video.addEventListener('canplay', onReady, { once: true });
    }, { once: true });
    // Safety timeout
    setTimeout(resolve, 3000);
  });
}

export async function seekParticleObjectVideos(engine, env, time) {
  const partMod = engine.particle;
  if (!partMod?.prepareObjectVideos) return;
  const waits = [];
  // CLIP-LOCAL time, the same base renderParticleLayer draws at — a solver
  // that starts at 4 s must show its object video from the video's start, not
  // four seconds in.
  for (const channel of env.channels) {
    if (channel.visible === false) continue;
    const layout = env.layoutMap.get(channel.id);
    if (!layout) continue;
    const activeIndex = resolveActiveIndex(layout, time);
    if (activeIndex < 0) continue;
    const item = channel.items[activeIndex];
    const sys = item?.particleSystem;
    if (!sys) continue;
    const wantsEmitterVideo = sys.emitters?.[0]?.source?.kind === 'video' && sys.render?.colorMode === 'source';
    if (sys.objects?.playVideo !== true && !wantsEmitterVideo) continue;
    if (env.clipsMap.get(item.clipId)?.mediaType !== PARTICLE_MEDIA_TYPE) continue;
    const sources = (sys.objects.members || [])
      .filter((m) => m.included !== false && m.source?.kind === 'video')
      .map((m) => m.source);
    // The emitter's own source, when the particles take their colour from it.
    const emitSrc = sys.emitters?.[0]?.source;
    if (emitSrc?.kind === 'video' && sys.render?.colorMode === 'source') sources.push(emitSrc);
    if (!sources.length) continue;
    const timeInClip = Math.max(0, time - layout[activeIndex].startTime);
    // A failed seek must never take the FRAME down with it: this is awaited
    // alongside the timeline's own video seeks, and one rejection there
    // rejects the whole Promise.all — the exporter then logs a warning and
    // encodes a black frame.
    waits.push(Promise.resolve(partMod.prepareObjectVideos(sources, timeInClip, false)).catch(() => {}));
  }
  await Promise.all(waits);
}

export async function seekAllVideosForTime(engine, env, time) {
  const seekPromises = [];
  for (const channel of env.channels) {
    if (channel.visible === false) continue;
    const layout = env.layoutMap.get(channel.id);
    const cs = engine.channelStates.get(channel.id);
    if (!layout || !cs) continue;

    const activeIndex = resolveActiveIndex(layout, time);
    if (activeIndex < 0) continue;

    const item = channel.items[activeIndex];
    const itemLayout = layout[activeIndex];
    const clip = env.clipsMap.get(item.clipId);
    if (!clip || clip.mediaType !== 'video') continue;

    const timeInClip = time - itemLayout.startTime;
    const targetVideoTime = calculateVideoTime(item, timeInClip);
    const useVideoA = activeIndex % 2 === 0;
    const activeVideo = useVideoA ? cs.videos.a : cs.videos.b;

    // Load source if needed
    const clipSource = getClipPlaybackUrl(clip);
    if (clipSource && normalizeUrl(activeVideo.src || '') !== normalizeUrl(clipSource)) {
      activeVideo.src = clipSource;
      activeVideo.preload = 'auto';
      activeVideo.load();
      await new Promise((r) => {
        activeVideo.addEventListener('loadeddata', r, { once: true });
        setTimeout(r, 5000);
      });
    }

    seekPromises.push(seekVideoAndWait(engine, activeVideo, targetVideoTime));

    // Also handle overlap (previous clip during transition)
    const inOverlap = activeIndex > 0 && itemLayout.overlapIn > 0 && timeInClip <= itemLayout.overlapIn;
    if (inOverlap) {
      const prevItem = channel.items[activeIndex - 1];
      const prevLayout = layout[activeIndex - 1];
      const prevClip = env.clipsMap.get(prevItem.clipId);
      if (prevClip?.mediaType === 'video') {
        const prevTimeInClip = Math.max(0, Math.min(prevLayout.duration, time - prevLayout.startTime));
        const prevTargetTime = calculateVideoTime(prevItem, prevTimeInClip);
        const previousVideo = useVideoA ? cs.videos.b : cs.videos.a;
        const prevSource = getClipPlaybackUrl(prevClip);
        if (prevSource && normalizeUrl(previousVideo.src || '') !== normalizeUrl(prevSource)) {
          previousVideo.src = prevSource;
          previousVideo.preload = 'auto';
          previousVideo.load();
          await new Promise((r) => {
            previousVideo.addEventListener('loadeddata', r, { once: true });
            setTimeout(r, 5000);
          });
        }
        seekPromises.push(seekVideoAndWait(engine, previousVideo, prevTargetTime));
      }
    }
  }
  seekPromises.push(seekParticleObjectVideos(engine, env, time));
  await Promise.all(seekPromises);
}

export function syncTransitionSounds(engine, env, time) {
  const keyPrefix = '__transition_sfx__:';
  const keep = new Set();
  const validKeys = new Set(env.transitionSoundCues.map((cue) => `${keyPrefix}${cue.id}`));

  // Frame export mixes these cues separately. Never let the preview elements
  // leak into a deterministic export pass.
  if (!engine.exportActive && !engine.exporting) {
    for (const cue of env.transitionSoundCues) {
      const cueDuration = cue.trimEnd - cue.trimStart;
      const cueEnd = cue.startTime + cueDuration;
      // Preload shortly before the cut so the first audible frame is not late.
      if (time < cue.startTime - 0.75 || time >= cueEnd) continue;

      const key = `${keyPrefix}${cue.id}`;
      keep.add(key);
      const audioEl = ensurePreviewAudio(engine.audioElements, key, cue.url);
      applyMute(audioEl, engine.forceMuteAudio || !engine.soundEnabled || cue.volume <= 0);
      audioEl.volume = Math.max(0, Math.min(1, cue.volume));
      const target = cue.trimStart + Math.max(0, time - cue.startTime);
      const cueLive = time >= cue.startTime && engine.isPlaying && !engine.jumpHold.active;
      // Same drift policy as audio clips (audioDriftSync.js): a cue that is
      // playing is nudged, not re-seeked; before its cut it is parked once.
      const buffered = engine.shortAudio?.sync(key, {
        url: cue.url, offset: target, end: cue.trimEnd,
        volume: audioEl.muted ? 0 : audioEl.volume, active: cueLive,
      });
      if (buffered) {
        if (!audioEl.paused) audioEl.pause();
      } else if (cueLive) {
        if (audioEl.paused) startPlayingAudio(audioEl, target, undefined, cue.trimEnd).catch(() => {});
        else syncPlayingAudio(audioEl, target, undefined, () => { perfRegistry.events.seek += 1; }, cue.trimEnd);
      } else {
        if (!audioEl.paused) audioEl.pause();
        parkAudio(audioEl, target);
      }
    }
  }

  // Removing/changing the preset immediately tears down its owned audio.
  for (const [key, audioEl] of engine.audioElements.entries()) {
    if (!key.startsWith(keyPrefix) || keep.has(key)) continue;
    // Retain gesture-authorized cue elements for later cuts and loop passes.
    engine.shortAudio?.stop(key);
    if (mediaActivation.enabled && validKeys.has(key)) {
      if (!audioEl.paused) audioEl.pause();
      continue;
    }
    try { audioEl.pause(); audioEl.removeAttribute('src'); } catch { /* no-op */ }
    engine.audioElements.delete(key);
  }
}

export function resolvePlaybackClockTime(engine, env) {
  // Voice recording force-mutes timeline audio, so the mic/MediaRecorder clock is
  // the user's real reference. Do not let a muted <video> element pull the master
  // playhead forward during recording preview.
  if (engine.forceMuteAudio) return null;

  for (let ci = env.channels.length - 1; ci >= 0; ci -= 1) {
    const channel = env.channels[ci];
    if (channel.visible === false || channel.items.length === 0) continue;
    const layout = env.layoutMap.get(channel.id);
    const cs = engine.channelStates.get(channel.id);
    if (!layout || !cs) continue;
    const activeIndex = resolveActiveIndex(layout, engine.currentTime);
    if (activeIndex < 0) continue;
    const item = channel.items[activeIndex];
    const itemLayout = layout[activeIndex];
    const clip = env.clipsMap.get(item.clipId);
    if (!clip || clip.mediaType !== 'video') continue;

    const activeVideo = activeIndex % 2 === 0 ? cs.videos.a : cs.videos.b;
    if (!activeVideo?.src || activeVideo.readyState < 2 || activeVideo.seeking) continue;
    const nextItem = channel.items[activeIndex + 1];

    const sourceDuration = Math.max(0.001, item.trimEnd - item.trimStart);
    const atClipBoundary =
      activeVideo.ended ||
      (nextItem && activeVideo.currentTime >= item.trimEnd - 0.04);
    if (atClipBoundary) return null;

    const normalizedSource = Math.max(0, Math.min(1, (activeVideo.currentTime - item.trimStart) / sourceDuration));
    const normalizedTimeline = mapSourceToTimeline(item.speedPoints, normalizedSource);
    return itemLayout.startTime + normalizedTimeline * itemLayout.duration;
  }
  return null;
}

export function isJumpHoldLanded(engine, env) {
  const t = engine.currentTime;
  for (const channel of env.channels) {
    if (channel.visible === false || channel.items.length === 0) continue;
    const layout = env.layoutMap.get(channel.id);
    const cs = engine.channelStates.get(channel.id);
    if (!layout || !cs) continue;
    const idx = resolveActiveIndex(layout, t);
    if (idx < 0) continue;
    const item = channel.items[idx];
    if (env.clipsMap.get(item.clipId)?.mediaType !== 'video') continue;
    const owner = idx % 2 === 0 ? cs.videos.a : cs.videos.b;
    // Only the buffers the hold PAUSED are waited for — they are the ones a seek
    // while playing would leave 0.5 s late. A buffer that was idle or has to load
    // a new file is seeked while paused and started on the clock by syncVideo
    // anyway; waiting for its load (150+ ms, more over Wi-Fi) only delayed
    // every other layer.
    if (!engine.jumpHold.held?.has(owner)) continue;
    // readyState 2 (the landed frame is decoded) is all a PAUSED buffer reports
    // after a seek.
    if (!owner?.src || owner.seeking || owner.readyState < 2 || engine.pendingSeek.has(owner)) return false;
    const want = calculateVideoTime(item, Math.max(0, t - layout[idx].startTime));
    if (Math.abs(owner.currentTime - want) > 0.45) return false;
  }
  return true;
}

export function getTotalDuration(engine, env) {
  let maxDuration = 0;
  for (const channel of env.channels) {
    const layout = env.layoutMap.get(channel.id);
    maxDuration = Math.max(maxDuration, getTimelineEndTime(layout));
  }
  return maxDuration;
}

export function ensureChannelStates(engine, env) {
  // engine/channelStates.js: create / drop / z-order the top-level channel states
  syncChannelStates(engine, env.channels, {
    soundEnabled: env.soundEnabled,
    // Clean up audio elements for removed env.channels
    onRemoved: (id) => {
      const audioKey = `${id}_audio`;
      const audioEl = engine.audioElements.get(audioKey);
      if (audioEl) { audioEl.pause(); audioEl.removeAttribute('src'); engine.audioElements.delete(audioKey); }
    },
  });
}

export function activateMediaForGesture(engine, env, soundOn, willPlay) {
  if (!mediaActivation.enabled) return;
  engine.shortAudio?.activate();
  const videos = [];
  const active = new Set();
  const intended = new Map();
  for (const channel of env.channels) {
    const cs = engine.channelStates.get(channel.id);
    if (!cs) continue;
    videos.push(cs.videos.a, cs.videos.b);
    const idx = engine.lastActiveIndex.get(channel.id);
    if (Number.isInteger(idx) && idx >= 0) {
      const owner = idx % 2 === 0 ? cs.videos.a : cs.videos.b;
      if (willPlay && env.clipsMap.get(channel.items[idx]?.clipId)?.mediaType === 'video') active.add(owner);
      // The owning buffer keeps its clip's own mute so a muted clip never
      // blips inside the gesture; renderChannel refines the rest per frame.
      const item = channel.items[idx];
      intended.set(owner, !!item?.muted || (item?.volume ?? 100) <= 0);
    }
  }
  // Prepare every audio channel now, including tracks that begin later and
  // tracks inside sequences. Creating a new <audio> at a later cut loses the
  // gesture; reusing this element with another src retains it.
  const prepareAudio = (chs, cmap, at, depth = 0) => {
    if (depth > SEQUENCE_MAX_DEPTH) return;
    for (const ch of chs) {
      const layout = getTimelineLayout(ch.items, { unsnapped: ch.unsnapped });
      const idx = resolveActiveIndex(layout, at);
      const audioItems = ch.items.map((item, i) => ({ item, i, clip: cmap.get(item.clipId) }))
        .filter(({ clip }) => clip?.mediaType === 'audio');
      const candidate = audioItems.find(({ i }) => i === idx)
        || audioItems.find(({ i }) => layout[i]?.startTime >= at) || audioItems[0];
      if (candidate) {
        const { item, i, clip } = candidate;
        const audio = ensurePreviewAudio(engine.audioElements, `${ch.id}_audio`, clip.url || '', 'metadata');
        parkAudio(audio, item.trimStart + (i === idx ? Math.max(0, at - layout[i].startTime) : 0));
        videos.push(audio);
        intended.set(audio, ch.visible === false || !!item.muted || (item.volume ?? item.opacity ?? 100) <= 0);
      }
      for (let i = 0; i < ch.items.length; i++) {
        const item = ch.items[i], clip = cmap.get(item.clipId);
        if (!isContainerClip(clip)) continue;
        const local = calculateVideoTime(item, Math.max(0, at - (layout[i]?.startTime || 0)));
        prepareAudio(clip.sequence.channels, new Map(clip.sequence.clips.map((c) => [c.id, c])), local, depth + 1);
      }
    }
  };
  prepareAudio(env.channels, env.clipsMap, engine.currentTime);
  for (const cue of env.transitionSoundCues) {
    const audio = ensurePreviewAudio(engine.audioElements, `__transition_sfx__:${cue.id}`, cue.url, 'metadata');
    parkAudio(audio, cue.trimStart);
    videos.push(audio);
    intended.set(audio, cue.volume <= 0);
  }
  // Sequences already rendered at this playhead have their own video buffers.
  for (const st of engine.sequenceStates.values()) {
    for (const cs of st.channelStates.values()) videos.push(cs.videos.a, cs.videos.b);
  }
  mediaActivation.activate(videos, {
    intendedMuted: (video) => engine.forceMuteAudio || !soundOn || intended.get(video) === true,
    isActive: (video) => active.has(video),
  });
}
