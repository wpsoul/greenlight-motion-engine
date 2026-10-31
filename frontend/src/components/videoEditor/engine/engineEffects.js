/*
 * What the engine does when the project, the time or the play state changes (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md,
 * Stage 9 step 28e3 — each moved verbatim out of a Player effect with tests/engine-extraction/tools/stage9_effects.py):
 * load the node-material modules, the fonts and the pictures a frame needs; prune what the timeline no longer uses
 * (transition packages, particle runtimes, 3D model layers); follow a seek; run the playback loop; poll a paused
 * preview's videos until they can paint. Each returns its cleanup, like the effect it came from; the Player's effects
 * call them on their old dependency lists, and a React-free driver calls them when the same things change.
 */
import { isText3dLayer } from '../text3d';
import { ensureFontsLoaded } from '../../../render-shims/FontFamilySelect';
import { PARTICLE_MEDIA_TYPE } from '../../../sim/particles/schema.js';
import { getAdjustmentEffect, loadLocalEffectPackages, onEffectRegistryChanged } from '../adjustmentEffects';
import { loadAdvancedTransitionPackages, onAdvancedTransitionPresetsChanged } from '../advancedTransitions';
import { onAnimatedImageFrame } from '../animatedImage';
import { onBakeLanded } from '../asyncBakes';
import { onDepthTextureLoaded } from '../depthParallax';
import { setHtmlLiveFrameListener } from '../htmlLive';
import { subscribeImagePlate } from '../imagePlate';
import { subscribeVideoSize } from '../videoPlate';
import { subscribeInlineTextEdit } from '../inlineTextEdit';
import { initMaterialBackend } from '../materialFactory';
import { setMockupSvgInvalidate } from '../mockupFrame';
import { onModelAssetLoaded } from '../model3dEvents';
import { onMotionMediaFrame, onMotionTemplatesLoaded } from '../motionTemplates';
import { perfRegistry } from '../perfRegistry.js';
import { TEXTURE_QUALITY_OFF } from '../rasterDensity';
import { isShadowPlate } from '../rig3d';
import { disposeTransitionPackageInstances, pruneTransitionPackageInstances } from '../transitionPackageRuntime';
import { isContainerClip, SEQUENCE_MAX_DEPTH } from '../types';
import { playbackActions } from '../videoEditorStore';
import { awaitMotionImages as awaitMotionImagesInEngine } from './frameQueries';
import { getTotalDuration as getTotalDurationInEngine, isJumpHoldLanded as isJumpHoldLandedInEngine, resolvePlaybackClockTime as resolvePlaybackClockTimeInEngine } from './mediaClock';
import { JUMP_HOLD } from './mediaHelpers';
import { ensureVideoFrameLoop as ensureVideoFrameLoopInEngine } from './mediaTextures';
import { JUMP_HOLD_MAX_MS } from './mediaHelpers';

export function applyTextureQuality(engine, env) {
  engine.adaptiveRaster = env.adaptiveRasterMode !== TEXTURE_QUALITY_OFF;
  // Supersampling is withdrawn (see rasterDensity.js); nothing turns it on.
  engine.rasterSupersample = false;
  // Any mode change must actually release the plates, not just change what gets
  // chosen next — the sizes are wrong for the new mode either way, so the next
  // frame re-rasterizes every text and shape layer.
  engine.rasterDensity.clear();
  engine.rasterBudget?.reset();
  engine.renderFrame?.();
}

export function pruneTransitionPackages(engine, env) {
  for (const channel of env.channels || []) {
    const cs = engine.channelStates.get(channel.id);
    if (!cs?.transitionPackageInstances?.size) continue;
    const items = channel.items || [];
    pruneTransitionPackageInstances(cs, (type, slot) => items.some((it) => (
      slot === 'in' ? it.transitionInType === type
        : slot === 'out' ? it.transitionOutType === type
          : it.transition === type
    )));
  }
  // Nested sequences (any depth): their channel states live in
  // sequenceStatesRef keyed by the sequence ITEM id. Collect every sequence
  // item's inner env.channels; a state whose item is gone drops all its instances.
  const seqChannelsByItem = new Map();
  const walk = (chs, cmap, depth) => {
    if (depth > SEQUENCE_MAX_DEPTH) return;
    for (const ch of chs || []) {
      for (const it of ch.items || []) {
        const clip = cmap.get(it.clipId);
        if (!isContainerClip(clip)) continue;
        const inner = clip.sequence?.channels || [];
        seqChannelsByItem.set(it.id, inner);
        walk(inner, new Map((clip.sequence?.clips || []).map((c) => [c.id, c])), depth + 1);
      }
    }
  };
  walk(env.channels, env.clipsMap, 0);
  for (const [itemId, st] of engine.sequenceStates) {
    const innerChannels = seqChannelsByItem.get(itemId);
    for (const [chId, cs] of st?.channelStates || []) {
      if (!cs?.transitionPackageInstances?.size) continue;
      const inner = innerChannels?.find((c) => c.id === chId);
      if (!inner) { disposeTransitionPackageInstances(cs); continue; }
      const items = inner.items || [];
      pruneTransitionPackageInstances(cs, (type, slot) => items.some((it) => (
        slot === 'in' ? it.transitionInType === type
          : slot === 'out' ? it.transitionOutType === type
            : it.transition === type
      )));
    }
  }
}

export function loadTextFonts(engine, env) {
  let cancelled = false;
  if (env.textFontLoadRequest.families.length === 0) return undefined;
  ensureFontsLoaded(env.textFontLoadRequest.families, {
    weights: env.textFontLoadRequest.weights.length > 0 ? env.textFontLoadRequest.weights : [400, 700],
    size: 72,
    sampleText: 'Typography',
  }).then(() => {
    if (!cancelled) env.setFontLoadVersion((version) => version + 1);
  });
  return () => {
    cancelled = true;
  };
}

export function loadMotionImages(engine, env) {
  if (env.motionImageUrls.length === 0 && env.shapeBackgroundUrls.length === 0) return undefined;
  let cancelled = false;
  awaitMotionImagesInEngine(engine, env).then(() => {
    if (!cancelled) env.setFontLoadVersion((version) => version + 1);
  });
  return () => {
    cancelled = true;
  };
}

export function pruneParticleRuntimes(engine, env) {
  const mod = engine.particle;
  if (!mod) return;
  const live = new Set();
  const walk = (chs, cmap, scope, depth) => {
    if (depth > SEQUENCE_MAX_DEPTH) return;
    for (const ch of chs) {
      for (const it of ch.items) {
        const c = cmap.get(it.clipId);
        if (c?.mediaType === PARTICLE_MEDIA_TYPE) live.add(scope ? `${scope}:${it.id}` : it.id);
        if (isContainerClip(c)) {
          walk(c.sequence.channels, new Map(c.sequence.clips.map((cc) => [cc.id, cc])),
            scope ? `${scope}:${it.id}` : it.id, depth + 1);
        }
      }
    }
  };
  walk(env.channels, env.clipsMap, '', 0);
  try { mod.gcParticleLayers?.(live); } catch { /* no-op */ }
  try { mod.gcParticleCaches?.(live); } catch { /* no-op */ }
  /*
   * AND THE TIER 2 RUNTIMES. A GPU runtime is the most expensive thing a
   * particle layer owns — a million-particle pool is 122 MB of VRAM plus its
   * share of the shared reservation ledger — and deleting the layer released
   * neither, because this sweep only knew about the two CPU-side caches. Three
   * deleted big layers and the budget was exhausted until a reload, with every
   * new layer told there was no room.
   */
  try { mod.gcParticleGpu?.(live); } catch { /* no-op */ }
}

export function pruneModelLayers(engine, env) {
  const mod = engine.model3d;
  if (!mod?.pruneModelLayers && !mod?.prunePlateLayers) return;
  const liveModels = new Set();
  const livePlates = new Set();
  const liveText3d = new Set();
  const walk = (chs, cmap, depth) => {
    if (depth > SEQUENCE_MAX_DEPTH) return;
    for (const ch of chs || []) {
      for (const item of ch.items || []) {
        const clip = cmap.get(item.clipId);
        if (clip?.mediaType === 'model3d') liveModels.add(item.id);
        else if (isText3dLayer(item, clip)) liveText3d.add(item.id);
        else if (isShadowPlate(item, clip)) livePlates.add(item.id);
        if (isContainerClip(clip)) {
          const innerMap = new Map((clip.sequence.clips || []).map((c) => [c.id, c]));
          walk(clip.sequence.channels, innerMap, depth + 1);
        }
      }
    }
  };
  walk(env.channels, env.clipsMap, 0);
  mod.pruneModelLayers?.(liveModels);
  mod.prunePlateLayers?.(livePlates);
  mod.pruneText3dLayers?.(liveText3d);
}

export function followCurrentTime(engine, env) {
  const prevTime = engine.currentTime;
  // Avoid stomping the live ref on no-op syncs (e.g. when isPlaying toggles
  // and env.currentTime hasn't actually changed): only update when the prop
  // really moved relative to where we are.
  if (Math.abs(env.currentTime - prevTime) < 0.0005) return undefined;
  engine.currentTime = env.currentTime;
  engine.committedTime = env.currentTime;
  engine.shortAudio?.stopAll();
  // An external seek re-baselines the clock, so the fps gate's deadline goes
  // with it (a stale deadline would either burst or skip after the jump).
  engine.nextRenderDeadline = 0;
  engine.rcSample = { lastPaint: 0, warmUntil: performance.now() + 400 }; // render cache: warm-up, not cost
  // Rebaseline the monotonic-playhead clamp on any seek/scrub so it doesn't
  // suppress an intentional jump (including a jump backward).
  engine.lastPlayhead = env.currentTime;

  // On a large live seek, invalidate old seeks but do not wake every cached
  // buffer. renderChannel below starts only the video(s) that own the new
  // playhead, which prevents a stale buffer from emitting even a brief sound.
  if (engine.isPlaying && Math.abs(env.currentTime - prevTime) > 0.5) {
    const held = new Set();
    for (const cs of engine.channelStates.values()) {
      for (const video of [cs.videos.a, cs.videos.b]) {
        if (!video.src) continue;
        engine.pendingSeek.delete(video);
        const pendingTimeout = engine.seekTimeout.get(video);
        if (pendingTimeout) { clearTimeout(pendingTimeout); engine.seekTimeout.delete(video); }
        // JUMP_HOLD: seek while paused (fast on WebKit), restart on release.
        if (JUMP_HOLD && !video.paused) { video.pause(); held.add(video); }
        ensureVideoFrameLoopInEngine(engine, video);
      }
      // Keep existing textures — last frame stays visible during seek
    }
    if (JUMP_HOLD) {
      for (const audio of engine.audioElements.values()) if (!audio.paused) audio.pause();
      engine.jumpHold = { active: held.size > 0, at: performance.now(), held };
    }
    engine.renderFrame();
  }
  return undefined;
}

export function loadMaterials(engine, env) {
  if (env.materialsReady) return undefined;
  let live = true;
  initMaterialBackend()
    .then(() => { if (live) env.setMaterialsReady(true); })
    .catch((err) => {
      if (!live) return;
      // Reachable with a real cause now: this promise carries the WebGPU
      // adapter preflight, so a machine that cannot run WebGPU fails HERE,
      // before a renderer exists. Same two-part presentation as the renderer's
      // own failure below — the sentence, then the reason in small print.
      console.error('[ve] renderer unavailable: ' + (err?.message || err));
      env.setRendererError(err?.userMessage || String(err?.message || err));
      env.setRendererErrorDetail(err?.detail || null);
    });
  return () => { live = false; };
}

export function runPlaybackLoop(engine, env) {
  const step = () => {
    if (!env.isPlaying) return;
    const now = performance.now();
    const rawDelta = (now - engine.lastTick) / 1000;
    // Clamp delta to avoid large jumps from tab-switch or GC pauses. Keep the
    // cap loose enough for screen recording: MediaRecorder can make rAF miss a
    // few beats while the <video> elements keep playing, and an over-tight cap
    // makes the master clock lag behind until syncVideo seeks backward.
    const delta = Math.min(rawDelta, 0.25);
    engine.lastTick = now;

    const totalDuration = getTotalDurationInEngine(engine, env);
    const prevTime = engine.currentTime;
    // JUMP_HOLD: the clock waits at the jump target until the owning buffers
    // have landed there; they restart on the frame it lets go.
    let holding = false;
    if (engine.jumpHold.active) {
      const landed = isJumpHoldLandedInEngine(engine, env);
      if (landed || now - engine.jumpHold.at > JUMP_HOLD_MAX_MS) {
        engine.jumpHold.active = false;
        perfRegistry.jumpHold = { ms: Math.round(now - engine.jumpHold.at), reason: landed ? 'landed' : 'timeout' };
      } else holding = true;
    }
    const mediaClockTime = holding ? null : resolvePlaybackClockTimeInEngine(engine, env);
    let nextTime = holding ? prevTime : prevTime + delta;
    engine.playbackStep = holding ? 0 : delta;
    if (Number.isFinite(mediaClockTime)) {
      const mediaDelta = mediaClockTime - nextTime;
      const mediaIsPlausible = mediaClockTime >= prevTime - 0.08 && Math.abs(mediaDelta) < 1.25;
      if (mediaIsPlausible && mediaDelta > 0.035) {
        nextTime = mediaClockTime;
      }
    }
    let reachedEnd = false;
    if (totalDuration <= 0) nextTime = 0;
    else if (nextTime >= totalDuration) {
      if (engine.loop) {
        nextTime = 0; // loop enabled: jump back to the start
      } else {
        nextTime = totalDuration; // no loop: settle on the last frame and stop
        reachedEnd = true;
      }
    }
    engine.currentTime = nextTime;

    // On loop, invalidate old seeks — but do NOT blind-seek buffers to zero:
    // each buffer's next clip re-targets it through syncVideo (whose target is
    // the clip's trim-in, not 0), and the idle-channel preload stages the wrap
    // ahead of time; resetting every element here destroyed exactly that
    // preparation and re-introduced the stale-frame flash at the loop edge.
    if (nextTime < prevTime - 0.5) {
      engine.lastPlayhead = nextTime;
      engine.nextRenderDeadline = 0; // loop wrap re-baselines the fps gate too
      engine.rcSample = { lastPaint: 0, warmUntil: performance.now() + 400 }; // render cache: warm-up, not cost
      for (const cs of engine.channelStates.values()) {
        for (const video of [cs.videos.a, cs.videos.b]) {
          if (!video.src) continue;
          engine.pendingSeek.delete(video);
          const pendingTimeout = engine.seekTimeout.get(video);
          if (pendingTimeout) { clearTimeout(pendingTimeout); engine.seekTimeout.delete(video); }
          ensureVideoFrameLoopInEngine(engine, video);
        }
        // Keep existing textures — last frame stays visible while new frame decodes
      }
    }

    // Drive the playhead from the SMOOTH master clock (nextTime), not the
    // media clock (video.currentTime). The media clock advances irregularly
    // under decode lag / corrective seeks, which made the playhead jitter; the
    // master clock ticks at a constant real-time rate. Written EVERY loop
    // iteration (no 33ms throttle): the store is transient and its subscribers
    // are per-frame style writers (Timeline's playhead rAF, useLivePlayhead),
    // so throttling here only quantized the playhead into visible steps.
    // (mediaClockTime is still resolved above for video A/B sync.)
    //
    // Published STRAIGHT to the transient store, never through the React
    // `env.setPlayheadTime` prop. Going through React re-rendered VideoEditor,
    // this Player and the whole Timeline once per frame (rebuilding the
    // timeline's snap points among much else) — and, because VideoEditor
    // mirrored the value into the store from an effect, the store everything
    // per-frame reads was a full commit of a 15k-line tree BEHIND the clock.
    // The React playhead is committed on pause/seek only (see the else branch
    // below); anything that must move per frame subscribes to the store.
    {
      let displayTime = nextTime;
      if (displayTime < engine.lastPlayhead && engine.lastPlayhead - displayTime < 1) {
        displayTime = engine.lastPlayhead;
      }
      engine.lastPlayhead = displayTime;
      playbackActions.setPlayheadTime(displayTime);
    }

    /*
     * A6 — CAP THE RENDER, NEVER THE TICK. Everything above (master clock,
     * media-clock reconciliation, the store publish, and syncVideo inside
     * renderChannel's next call) stays per rAF; only this paint is gated, by
     * the project's preview frame rate (60 unless the project picks another).
     * A deadline accumulator with a half-frame tolerance, not `elapsed <
     * 1/fps` — a whole-tick skip quantises 24 fps on 60 Hz into alternating 2
     * and 3 ticks and judders worse than uncapped; a cap at or above the
     * display rate paints every tick. The deadline advances from max(now,
     * deadline) so a resume or a long GC pause never bursts. Recording bypasses the gate:
     * MediaRecorder already makes rAF miss beats, and a gate on top can push
     * the take below project fps (forceMuteAudio is how recording reaches
     * the Player). Paused, imperative and media-readiness repaints do not
     * come through here and stay immediate.
     */
    perfRegistry.frames += 1;
    const fpsCap = engine.fpsCap;
    if (fpsCap == null || engine.forceMuteAudio) {
      engine.renderFrame();
    } else {
      const frameMs = 1000 / fpsCap;
      if (now >= engine.nextRenderDeadline - frameMs * 0.5) {
        engine.nextRenderDeadline = Math.max(now, engine.nextRenderDeadline) + frameMs;
        engine.renderFrame();
      }
    }

    if (reachedEnd) {
      env.setIsPlaying(false); // playback halts at the end when not looping
      return;
    }
    engine.animation = requestAnimationFrame(step);
  };

  if (env.isPlaying) {
    engine.lastTick = performance.now();
    // Baseline the monotonic-playhead clamp at the current position so it tracks
    // forward from here (and isn't pinned to a stale value across pause/resume).
    engine.lastPlayhead = engine.currentTime;
    // Play start and every playback-session restart (this effect re-running)
    // re-baseline the fps gate: the first tick paints, no burst, no gap.
    engine.nextRenderDeadline = 0;
    engine.rcSample = { lastPaint: 0, warmUntil: performance.now() + 400 }; // render cache: warm-up, not cost

    // Let renderChannel start only the media that owns the playhead. Starting
    // both cached buffers here wakes stale embedded audio before the first frame
    // can reconcile the channel, and an audio clip's early return used to leave
    // that stale video playing indefinitely.
    for (const cs of engine.channelStates.values()) {
      for (const video of [cs.videos.a, cs.videos.b]) {
        if (video.src) ensureVideoFrameLoopInEngine(engine, video);
      }
    }
    engine.renderFrame();
    engine.animation = requestAnimationFrame(step);
  } else {
    cancelAnimationFrame(engine.animation);
    for (const cs of engine.channelStates.values()) {
      cs.videos.a.pause();
      cs.videos.b.pause();
    }
    engine.rcStop();
    // Pause is where the React playhead catches up with the clock. Through the
    // whole preceding play the prop was never called — the loop published to
    // the store instead — so this one call is what re-renders the editor onto
    // the frame playback stopped at, and what every `playheadTime`-derived
    // memo up in VideoEditor is waiting for.
    const settledTime = engine.currentTime;
    env.setPlayheadTime?.(settledTime);
    if (Math.abs(engine.committedTime - settledTime) > 0.001) {
      engine.committedTime = settledTime;
      env.setCurrentTime(settledTime);
    }
  }

  return () => {
    cancelAnimationFrame(engine.animation);
  };
}

export function pollVideoReadiness(engine, env) {
  if (env.isPlaying) {
    clearInterval(engine.videoLoadPoll);
    engine.videoLoadPoll = null;
    return;
  }

  const hasUnreadyVideo = () => {
    for (const cs of engine.channelStates.values()) {
      for (const video of [cs.videos.a, cs.videos.b]) {
        if (video.src && video.readyState < 2 && !video.error) return true;
      }
    }
    return false;
  };

  const poll = () => {
    if (hasUnreadyVideo()) {
      engine.renderFrame();
    } else {
      clearInterval(engine.videoLoadPoll);
      engine.videoLoadPoll = null;
    }
  };

  // Start polling after a short delay to let event listeners fire first
  const startTimer = setTimeout(() => {
    if (hasUnreadyVideo()) {
      engine.videoLoadPoll = setInterval(poll, 300);
    }
  }, 500);

  return () => {
    clearTimeout(startTimer);
    clearInterval(engine.videoLoadPoll);
    engine.videoLoadPoll = null;
  };
}

export function repaintOnMockupSvg(engine) {
  setMockupSvgInvalidate(() => { engine.renderFrame?.(); });
  return () => setMockupSvgInvalidate(null);
}

export function repaintOnMotionTemplates(engine) {
  return onMotionTemplatesLoaded(() => engine.renderFrame());
}

export function repaintOnDepthTextures(engine) {
  return onDepthTextureLoaded(() => engine.renderFrame());
}

export function repaintOnModelAssets(engine) {
  return onModelAssetLoaded(() => {
    if (!engine.exporting && !engine.isPlaying) engine.renderFrame();
  });
}

export function repaintOnInlineTextEdit(engine) {
  return subscribeInlineTextEdit(() => {
    if (!engine.exporting) engine.renderFrame?.();
  });
}

export function watchTransitionPackages(engine, env) {
  const unsubscribe = onAdvancedTransitionPresetsChanged(() => {
    env.setTransitionRegistryRevision((revision) => revision + 1);
    engine.renderFrame();
  });
  loadAdvancedTransitionPackages();
  return unsubscribe;
}

export function watchEffectPackages(engine) {
  const unsubscribe = onEffectRegistryChanged(() => {
    const cache = engine.effectMaterials;
    for (const [key, entry] of cache) {
      const match = /^(local:[a-z0-9-]+)@([^|:]+)/.exec(key);
      if (!match) continue;
      const def = getAdjustmentEffect(match[1]);
      if (def && String(def.rev) === match[2]) continue;
      try { entry.material?.dispose(); } catch { /* no-op */ }
      cache.delete(key);
    }
    engine.renderFrame();
  });
  loadLocalEffectPackages();
  return unsubscribe;
}

export function repaintOnImagePlates(engine) {
  const repaint = () => { engine.renderFrame?.(); };
  // A video's real size lands the same way (videoPlate.js): until then it fits the frame.
  const offImage = subscribeImagePlate(repaint);
  const offVideo = subscribeVideoSize(repaint);
  return () => { offImage(); offVideo(); };
}

export function repaintOnMotionMediaFrames(engine) {
  return onMotionMediaFrame(() => {
    if (!engine.exporting && !engine.isPlaying) engine.renderFrame();
  });
}

export function repaintOnAnimatedImageFrames(engine) {
  return onAnimatedImageFrame(() => {
    if (!engine.exporting && !engine.isPlaying) engine.renderFrame();
  });
}

export function repaintOnBakes(engine) {
  return onBakeLanded(() => {
    if (!engine.exporting && !engine.isPlaying) engine.renderFrame();
  });
}

export function repaintOnHtmlLiveFrames(engine) {
  let pending = false;
  setHtmlLiveFrameListener(() => {
    if (engine.isPlaying || engine.exportActive || pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; engine.renderFrame?.(); });
  });
  return () => setHtmlLiveFrameListener(null);
}
