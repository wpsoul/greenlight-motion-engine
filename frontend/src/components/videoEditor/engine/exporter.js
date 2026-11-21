/*
 * Export and stills (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 28d — moved verbatim out of the Player's
 * imperative API with tests/engine-extraction/tools/stage9_exporter.py): captureFrameAtTime renders one composited
 * frame at a time and returns it as a PNG data URL; exportVideo renders the project frame by frame into a video file
 * (WebCodecs mp4 / webm, alpha, motion blur, audio mix). The Player's handle keeps the same keys and calls these.
 */
import { settleWorldFrame, worldMovesBetween, finalFrameBudgetMs, worldMotionBlur, clearWorldMotion, worldHolds, reserveWorldMotion, worldDraftBlur, clearWorldDraftBlur, worldHdrOut, worldHdrFrame, worldSdrPixels, worldTakesLetters, worldRigIn, worldClockIn, primeWorldFrame, setWorldFarm, worldFarmHandoff, worldFrameFacts, releaseLostWorld, worldGuardSampling, worldHold, worldSceneOn } from '../world3dLayer';
import { averageHandoffs } from '../farmHandoff.js';
import { armFrameFaults, createFrameGuardLog, disarmFrameFaults, frameFaultOn, frameGuardError, frameVerdict, FRAME_GUARD_RETRIES } from '../frameGuard';
import { noteGpuReset } from '../gpuReset';
import { createSceneLight, hdrFloatReason, sceneOnlyReason } from '../hdrScene';
import { createHdrComposite } from '../hdrComposite';
import { createHdrEncoder } from '../hdrEncode';
import { text3dRunAt } from './channelRender';
import { posterizedTimeInClip } from '../posterizeTime';
import { PARTICLE_MEDIA_TYPE } from '../../../sim/particles/schema.js';
import { prepareLocalEffectsFor } from '../adjustmentEffects';
import { clampTransitionSoundCue, getAdvancedTransitionPreset, loadAdvancedTransitionPackages } from '../advancedTransitions';
import { animatedImagePending, preloadAnimatedImage, pumpAnimatedImages } from '../animatedImage';
import { bakesPending, bakesSettled, consumeBakeChange } from '../asyncBakes';
import { itemHasAudioFade, sanitizeAudioFadeCurve } from '../audioFade';
import { cssColorAlpha, isTransparentBackground } from '../backgroundLayer';
import { setAlphaExportMode } from '../clipShader';
import { releaseFrameResampler, resampleFrame } from '../frameResampler';
import { describeGpuLoad, gpuResetCount } from '../gpuReset';
import { evaluatePropertyTrack, getItemKeyframeValues, itemHasKeyframes } from '../gsapTransitions';
import { disposeHtmlLiveExportPages, htmlBlankCanvas, htmlLiveExportCanvas, htmlLiveSettleUsed, htmlLiveSupported } from '../htmlLive';
import { preloadImagePlate } from '../imagePlate';
import { preloadVideoPlate, videoPlateUrl } from '../videoPlate';
import { getParenting, localPrs } from '../keyframeParenting';
import { motionBlurLevelForShutter } from '../motionBlurLevels';
import { ensureMotionTemplate, motionMediaPending, pumpMotionMedia } from '../motionTemplates';
import { notePerfRenderer } from '../perfRegistry.js';
import { CAMERA_KF_LABELS, perspectiveDistance, resolveCameraPose } from '../projectCamera';
import { resolveScaledOutputSize, resolveScaledRenderSize } from '../renderOutputSize';
import { rigUsesWorld } from '../rig3d';
import { getTimelineLayout } from '../speedUtils';
import { waitForTransitionPackageInstances } from '../transitionPackageRuntime';
import { isContainerClip, SEQUENCE_MAX_DEPTH } from '../types';
import { exportVideo as runExport, exportAudioOnly, isWebCodecsSupported } from '../videoExporter';
import { filmFrames, rangeFrames } from '../frameGrid';
import { selectedBackend } from '../videoRenderer';
import { ClipDecoder, ClipSource, SegmentedClipDecoder, SegmentedSource } from '../webcodecsClipDecoder';
import { isWebmUrl, WebmFrameCache } from '../webmFrameCache';
import { WebmClipDecoder, WebmSource } from '../webmClipDecoder';
import { modelClipMovesBetween, rigKeysMove, rigKeysMoveBeyondLights, sceneMovesBetween, textAnimatorsMoveBetween } from '../worldMotion';
import { poseMayMove } from '../modelPose';
import { ensureSequenceState as ensureSequenceStateInEngine } from './channelStates';
import { resolveActiveIndex } from './compositeHelpers';
import { calculateVideoTime, clamp01 } from './layerHelpers';
import { getTotalDuration as getTotalDurationInEngine, releasePreviewSeekGate, seekAllVideosForTime as seekAllVideosForTimeInEngine, seekParticleObjectVideos as seekParticleObjectVideosInEngine, seekVideoAndWait as seekVideoAndWaitInEngine } from './mediaClock';
import { awaitImageTextures as awaitImageTexturesInEngine, getClipExportUrl, getClipPlaybackUrl, normalizeUrl } from './mediaTextures';
import { resolveFollow as resolveFollowInEngine, resolveParenting as resolveParentingInEngine } from './meshTransform';
import { ensureModel3dModule as ensureModel3dModuleInEngine, ensureParticleModule as ensureParticleModuleInEngine } from './modules3d';
import { getMotionBlurPipeline as getMotionBlurPipelineInEngine } from './motionPasses';
import { awaitShapeSvgImages, finiteNumber, preloadShapeSvgs } from './mediaHelpers';
import { phoneMode } from './phoneMode';
import { clipsBetween, dropPhonePictures } from './phoneMedia';

// The clips a still reads the sizes of: every top-level one (on a phone, what is on screen at that time, ./phoneMedia.js).
function stillClips(env, time) {
  return phoneMode() ? clipsBetween(env.channels, env.clipsMap, time, time) : env.channels.flatMap((ch) => ch.items.map((it) => env.clipsMap.get(it.clipId)));
}

// Every top-level video's real-size source (videoPlate.js reads the original, not the proxy).
function videoPlateUrls(env, time = null) {
  return [...new Set(
    (time == null ? env.channels.flatMap((ch) => ch.items.map((it) => env.clipsMap.get(it.clipId))) : stillClips(env, time))
      .filter((clip) => clip?.mediaType === 'video' && !clip.htmlSource && (clip.url || clip.proxyUrl))
      .map((clip) => videoPlateUrl(clip)),
  )];
}

// The project camera's magnification of the picture plane at `time`: its lens zoom,
// times a dolly's push-in (the camera at D − camDolly from a plane it frames from D).
// 1 with no camera under the playhead, and in world view, where the posed camera
// stands down (poseEngineCamera). Sizes a downscaled render's buffer
// (resolveScaledRenderSize).
function cameraMagnificationAt(engine, env, time) {
  if (engine.worldActive) return 1;
  const W = engine.videoSize?.w || env.videoWidth;
  const H = engine.videoSize?.h || env.videoHeight;
  const pose = resolveCameraPose(env.channels, env.clipsMap, (ch) => env.layoutMap.get(ch.id), time, { width: W, height: H });
  if (!pose) return 1;
  const zoom = Number.isFinite(pose.camZoom) && pose.camZoom > 0 ? pose.camZoom : 1;
  const D = perspectiveDistance(H);
  const dist = D - (Number.isFinite(pose.camDolly) ? pose.camDolly : 0);
  return dist > 0 ? (zoom * D) / dist : zoom;
}

/**
 * The 3D Scene settles after everything else in the frame has landed. A model's video screen decoded after a Final trace changed its
 * texture, which started the trace over, so the still or frame came back as the Draft picture. A screen first asked for by the traced
 * frame's own repaint (a world built late) is decoded and traced again.
 */
async function settleWorldLast(engine, opts) {
  if (await settleWorldFrame(engine, opts)) engine.renderFrame();
  for (let guard = 0; guard < 2 && motionMediaPending(); guard += 1) {
    await pumpMotionMedia();
    engine.renderFrame();
    if (await settleWorldFrame(engine, opts)) engine.renderFrame();
  }
}

/** (renderpro) The longest picture side this compositor can draw: its GPU's 2D texture limit (WebGPU device, WebGL context), 0 when
 *  unknown. A bigger render made every target invalid and came back as a black file with no error. */
export function maxPictureSide(renderer) {
  return renderer?.backend?.device?.limits?.maxTextureDimension2D || renderer?.capabilities?.maxTextureSize || 0;
}

/** Throws a machine-readable `[GPU_TEXTURE_LIMIT]` error when a w x h picture is past that limit; nothing otherwise. */
export function checkPictureSize(renderer, w, h) {
  const max = maxPictureSide(renderer);
  if (!max || (w <= max && h <= max)) return;
  const engineName = renderer?.backend?.device ? 'WebGPU' : 'WebGL';
  throw new Error(`[GPU_TEXTURE_LIMIT] The picture is ${w}x${h}, past the largest this GPU draws on the ${engineName} engine (${max} px a side). `
    + `Render at ${max} px or less on the long side.`);
}

// (badframes) The last kept still's frame guard (captureFrameAtTime): what was drawn again and why, for the still's report
// (VideoProjectRenderPage.renderStill: scene.frameGuard and scene.warnings). Null when nothing was.
let stillGuard = null;
export function stillGuardReport() {
  const g = stillGuard;
  return g && g.retried ? { summary: g.summary(), warnings: g.warnings() } : null;
}

export async function captureFrameAtTime(engine, env, time, opts = {}) {
  // A still is one render, so installed effect packages the project uses have
  // to be loaded before it (they are listed lazily).
  await prepareLocalEffectsFor(env.channels);
  const markTexturesFresh = () => {
    for (const cs of engine.channelStates.values()) {
      for (const video of [cs.videos.a, cs.videos.b]) {
        if (video.src && video.readyState >= 2) {
          // the still's own seek landed: no preview seek of this element holds its texture back (mediaClock.releasePreviewSeekGate)
          releasePreviewSeekGate(engine, video);
          engine.videoFrameReady.add(video);
          const cached = engine.videoTextureCache.get(video);
          if (cached) { cached.texture.needsUpdate = true; cached.hadFrame = true; }
        }
      }
    }
  };
  // Same one-pass problem as exportVideo: a still is captured from a single
  // render, so the particle runtime has to be in hand before it.
  // The module has to be in hand before the one render that becomes the
  // still. Waiting for the RUNTIMES cannot happen here — none exist until a
  // frame has asked for one; see env.settleParticlePlates, called below.
  if (env.hasParticleLayers()) { try { await ensureParticleModuleInEngine(engine); } catch { /* draws without */ } }
  if (env.hasModel3dLayers()) { try { await ensureModel3dModuleInEngine(engine); } catch { /* draws without */ } }
  const prevTime = engine.currentTime;
  const prevExporting = engine.exporting;
  // A transparent project background must survive into the still. The
  // preview and the flatten pass clear to OPAQUE black unless the renderer
  // is in alpha-export mode (the webm-alpha path flips it for the whole
  // export), so a PNG/WebP of a transparent project came back with no
  // alpha at all. Same switch, scoped to this one capture; left alone when
  // an alpha export already holds it.
  // "Transparent" is the transparent type, a zero-alpha solid (what the
  // background picker writes for "no background" — the project this was
  // found on carried rgba(0, 0, 0, 0)), or a solid with partial alpha.
  const renderer = engine.renderer;
  const bgConfig = engine.background;
  const bgAlpha = isTransparentBackground(bgConfig) ? 0
    : (bgConfig?.type === 'solid' ? cssColorAlpha(bgConfig.solidColor) : 1);
  const wantAlpha = bgAlpha < 1 && !engine.alphaExport;
  // Same-aspect output size (headless render-still at another resolution): a
  // SCALED copy of the composition. Downscale = render exactly as a full-size
  // still, then resample; upscale = render natively at the larger size. See
  // exportVideo.
  const stillScale = resolveScaledOutputSize(
    engine.outputSize,
    engine.videoSize?.w || env.videoWidth,
    engine.videoSize?.h || env.videoHeight,
  );
  // A downscale seen through a camera zoom draws at a buffer that shrinks with the
  // zoom, so the footage is not magnified and then shrunk again (resolveScaledRenderSize).
  const stillBuffer = stillScale?.upscale ? stillScale : resolveScaledRenderSize(
    stillScale,
    engine.videoSize?.w || env.videoWidth,
    engine.videoSize?.h || env.videoHeight,
    stillScale ? cameraMagnificationAt(engine, env, time) : 1,
  );
  let resampled = false;
  // (badframes) the frame guard (frameGuard.js): the picture read is checked before it leaves, drawn again when it is not whole, and
  // the still fails with a sentence when it never is. A warm-up's capture (`prime`) is not kept, so it is not checked.
  const guard = opts?.prime ? null : createFrameGuardLog();
  if (guard) stillGuard = guard;
  // Everything from the readiness waits to the read, once per attempt.
  const drawAndRead = async () => {
    // Same readiness the export loop insists on before its first frame:
    // template images, and the plate of every image layer (a plate resolved
    // late would capture the fitted, blown-up picture instead).
    try { await env.awaitMotionImages(); } catch { /* captures without */ }
    // Custom-shape SVGs load lazily; one that starts mid-timeline would be
    // requested by the capture render itself and miss the readback.
    preloadShapeSvgs(env.channels, env.clipsMap);
    await awaitShapeSvgImages();
    await Promise.all([...new Set(
      stillClips(env, time)
        .filter((clip) => clip?.mediaType === 'image' && clip.url)
        .map((clip) => clip.url),
    )].map((url) => Promise.all([preloadImagePlate(url), preloadAnimatedImage(url)]).catch(() => null)));
    await Promise.all(videoPlateUrls(env, time).map((url) => preloadVideoPlate(url).catch(() => null)));
    await seekAllVideosForTimeInEngine(engine, env, time);
    markTexturesFresh();
    engine.renderFrame();
    // That render is what ASKS for the image textures (getImageTexture runs
    // inside it), so only now can the capture wait for them. A texture that
    // lands after the readback is a black layer in the still, never repainted.
    if (await awaitImageTexturesInEngine(engine)) engine.renderFrame();
    // On a phone nothing was decoded ahead: a nested scene asks for its pictures only once its parent has drawn.
    if (phoneMode()) for (let i = 0; i < 3 && await awaitImageTexturesInEngine(engine); i += 1) engine.renderFrame();
    // Sequence/grid members' SVGs are first requested by that pass.
    if (await awaitShapeSvgImages()) engine.renderFrame();
    // Html clips drawn live (htmlLive.js): that render only stepped each page
    // toward its frame, and a step reaches the canvas at a later paint. Wait
    // until every page is drawn on its frame, then render again — without this
    // a still of an unbaked html clip came back with the layer empty.
    const htmlSettled = await htmlLiveSettleUsed();
    if (htmlSettled.failed.length && opts?.htmlLive === 'strict') {
      throw new Error(`[html-live] ${htmlSettled.failed.length} html page(s) could not be drawn live: ${htmlSettled.failed.join(', ')}`);
    }
    if (htmlSettled.waited) engine.renderFrame();
    // A still is an export too, so an animated image must be its real frame and
    // not the static fallback — a poster or a board thumbnail captured mid-decode
    // would otherwise freeze the layer on frame 0 for good.
    for (let guard = 0; guard < 3 && animatedImagePending(); guard += 1) {
      await pumpAnimatedImages();
      engine.renderFrame();
    }
    // Video frames asked for while drawing (3D model screens, motion templates,
    // video mattes) decode on lanes the render only REQUESTED — settle them and
    // repaint, exactly as an exported frame does, or the still keeps a stale frame.
    for (let guard = 0; guard < 3 && motionMediaPending(); guard += 1) {
      await pumpMotionMedia();
      engine.renderFrame();
    }
    // A still is a render too: a layer bake still in flight would capture
    // the previous one (same reason exportVideo settles).
    for (let guard = 0; guard < 4; guard += 1) {
      if (bakesPending()) await bakesSettled();
      if (!consumeBakeChange()) break;
      engine.renderFrame();
    }
    // (a warm-up's capture, renderWarmup `prime`: a Final Scene is drawn, not traced)
    await settleWorldLast(engine, opts?.prime ? { prime: true } : undefined);
    // ONE-SHOT CAPTURE MUST RENDER TWICE ON WEBGPU. The loop above only
    // re-renders when a bake actually landed, so a still with no pending
    // bake is read back after a single render — and WebGPU presents the
    // canvas asynchronously, so toDataURL() can serialise the surface
    // before that render reaches it. The failure is not an error: it is a
    // blank or one-frame-stale thumbnail, which looks like a timing bug in
    // whatever asked for the still. Costs one frame, and only on the
    // backend that needs it.
    /*
     * THE GPU PARTICLE PLATE, AFTER THE RENDER THAT FILLS IT.
     *
     * The pump used to run BEFORE the time was set and before anything was
     * drawn, which settles a device that has been asked for nothing — it
     * could not have made the still any fresher. The plate is painted by
     * renderFrame (that is when the runtime is stepped to this timecode and
     * its passes are submitted), so the wait belongs after it, and a repaint
     * belongs after the wait so the finished canvas is the one uploaded.
     *
     * The preview tolerates a one-frame-stale plate because the next frame
     * corrects it. A still has no next frame.
     */
    // ONE-SHOT CAPTURE MUST RENDER TWICE ON WEBGPU (see the note above), and
    // that extra render has to happen BEFORE the plates are settled — it
    // submits a frame of its own, so settling first and rendering after
    // would read the canvas with work still in flight.
    if (selectedBackend() === 'webgpu') engine.renderFrame();
    await env.settleParticlePlates();
    /*
     * THE READ MUST FOLLOW A RENDER IN THE SAME TASK. On the touch tier the
     * renderer runs with `preserveDrawingBuffer: false` (previewDeviceTier,
     * plan A4): the drawing buffer is discarded once a frame is composited,
     * and every `await` above crosses rendering opportunities. env.settleParticlePlates
     * only re-renders when a plate pump reported work, so without this line
     * a still with settled plates read back a cleared canvas. Unconditional
     * on purpose — on desktop it repaints the identical frame (same time,
     * same inputs; the particle plates are already settled), which is one
     * extra render per still and no pixel difference. WebGPU keeps its
     * double render here too, for the async-presentation reason above.
     */
    engine.renderFrame();
    if (selectedBackend() === 'webgpu') engine.renderFrame();
    if (stillScale && !stillScale.upscale) {
      // Downscale: resample the full-size frame (read in the same task as the
      // render, like toDataURL below) into the requested size. A camera-sized
      // buffer between output and composition takes the filtered resample
      // (frameResampler.js); the 2D one below then copies 1:1.
      let src = engine.canvas;
      if (!src) return null;
      if (stillBuffer && (src.width !== stillScale.w || src.height !== stillScale.h)) {
        resampled = true;
        src = resampleFrame(src, stillScale.w, stillScale.h) || src;
      }
      const out = document.createElement('canvas');
      out.width = stillScale.w;
      out.height = stillScale.h;
      const octx = out.getContext('2d');
      if (!octx) return null;
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(src, 0, 0, stillScale.w, stillScale.h);
      return out.toDataURL('image/png');
    }
    return engine.canvas?.toDataURL('image/png') || null;
  };
  try {
    // a picture past the GPU's largest texture comes back black with no error: say so instead (an agent reads the code)
    checkPictureSize(renderer, stillBuffer?.w || engine.canvas?.width || 0, stillBuffer?.h || engine.canvas?.height || 0);
    engine.currentTime = time;
    // A still capture is an export too: authoring aids (the grid's guide
    // line) must not appear in it.
    engine.exporting = true;
    if (stillBuffer && renderer) {
      renderer.setSize(stillBuffer.w, stillBuffer.h, false);
      notePerfRenderer({ w: stillBuffer.w, h: stillBuffer.h });
    }
    if (wantAlpha) {
      engine.alphaExport = true;
      setAlphaExportMode(true);
      renderer?.setClearColor(0x000000, 0);
    }
    for (let attempt = 0; ; attempt += 1) {
      const since = performance.now(), resets = gpuResetCount();
      if (guard) armFrameFaults();
      let dataUrl;
      try {
        dataUrl = await drawAndRead();
      } catch (err) {
        // (simgaps) a draw that threw because the Scene's GPU device was lost (the read of a dead device: "mapAsync ... Device is
        // lost"; macOS takes a page's device when the screen needs the GPU and another job keeps it busy): the world is loaded again on
        // a new device and the still drawn again, as a render's frame is (2 times at most); any other throw stops the still as before
        disarmFrameFaults();
        if (!guard || attempt >= FRAME_GUARD_RETRIES || !releaseLostWorld()) throw err;
        const detail = `the 3D Scene's GPU device was lost while the still was drawn (${String(err?.message || err).slice(0, 160)})`;
        guard.note('device', { time, detail });
        console.warn(`[frame guard] the still at ${time} s is drawn again (device): ${detail}`);
        continue;
      }
      if (guard && frameFaultOn('gpuReset')) noteGpuReset();
      const unchecked = guard && frameFaultOn('guardOff');
      disarmFrameFaults();
      if (!guard || !dataUrl || unchecked) return dataUrl;
      // what the read picture is, after the read (a target holds it; the canvas is read already): free on a good frame
      const facts = (await worldFrameFacts(engine, { since })) || {};
      // a rebuilt compositor is a new canvas this capture does not hold: no retry on it
      const rebuilt = engine.renderer !== renderer;
      if (rebuilt) facts.gpuReset = "the compositor's GPU device was lost and the compositor rebuilt";
      else if (gpuResetCount() !== resets && !facts.gpuReset) facts.gpuReset = 'a GPU context of the page was lost';
      const verdict = frameVerdict(facts, rebuilt ? FRAME_GUARD_RETRIES : attempt, { time });
      if (verdict.ok) return dataUrl;
      if (verdict.fail) throw frameGuardError(verdict);
      guard.note(verdict.retry, { time, detail: verdict.detail });
      console.warn(`[frame guard] the still at ${time} s is drawn again (${verdict.retry}): ${verdict.detail}`);
      // a lost device of the Scene's own: the world is built again on a new one by the next attempt
      if (verdict.retry === 'device') releaseLostWorld();
    }
  } catch (err) {
    // The headless render-still (opts.rethrow) needs the real error: an "[html-live]" one is what sends the backend to
    // bakes. Swallowed here, every still of a live html clip whose page could not be drawn (Chrome 157 before the
    // `content=drawable` attribute) came back as "Frame capture produced no output", and nothing fell back.
    console.warn('[still] capture failed:', err?.message || err);
    if (opts?.rethrow) throw err;
    return null;
  } finally {
    // Restore the frame the user was looking at.
    engine.currentTime = prevTime;
    engine.exporting = prevExporting;
    if (wantAlpha) {
      engine.alphaExport = false;
      setAlphaExportMode(false);
      renderer?.setClearColor(0x000000, 1);
    }
    if (resampled) releaseFrameResampler();
    if (stillBuffer && renderer) {
      const previewSize = engine.previewRenderSize;
      renderer.setSize(previewSize.w || env.renderWidth, previewSize.h || env.renderHeight, false);
      notePerfRenderer({ w: previewSize.w || env.renderWidth, h: previewSize.h || env.renderHeight });
    }
    try {
      await seekAllVideosForTimeInEngine(engine, env, prevTime);
      markTexturesFresh();
    } catch { /* best-effort restore */ }
    engine.renderFrame();
  }
}

export async function exportVideo(engine, env, format = 'mp4', onProgress, signal, exportFps = 30, onOutputChunk = null, frameSinks = null, timeRange = null, encodeOpts = null) {
  if (env.channels.every((ch) => ch.items.length === 0)) return;
  // Html clips (htmlLive.js): 'auto' draws them live where the browser can and
  // falls back to the bake; 'strict' (the server render) stops instead, so the
  // backend renders again from fresh bakes; false always plays the bake.
  const htmlLiveMode = encodeOpts?.htmlLive === 'strict' ? 'strict' : (encodeOpts?.htmlLive === false ? 'off' : 'auto');
  // Smart render cache file (renderCacheController.js): it stands in for the
  // PREVIEW, so it renders the way the preview draws — at its own (smaller)
  // size natively, without the export-only motion blur, and without sound
  // (playback keeps the layers' own audio).
  const previewCacheRender = encodeOpts?.previewCache === true;
  let htmlLiveFatal = null; // 'strict': stops the export (checkFatal) — the exporter swallows a frame's throw
  let worldFatal = null; // a Final 3D Scene frame that never finished tracing (world3dLayer.finalFrameBudgetMs): stops the export too
  if (!isWebCodecsSupported()) {
    alert('WebCodecs is not supported in this browser. Please use Chrome or Edge.');
    return;
  }

  // Installed effect packages the project uses must be loaded too (they are
  // listed lazily); a placeholder would render the first frames without them.
  await prepareLocalEffectsFor(env.channels);
  // Saved projects can reference a local package before the Transition modal
  // has ever opened. Resolve it before collecting audio/media or drawing the
  // first deterministic export frame.
  await loadAdvancedTransitionPackages();

  // (engine100) a timeline that plays is stopped and given 150 ms to come to rest; one that does not (every render page's export, an
  // export started while paused) has nothing to stop and only yields a task (not a frame: a hidden window runs no animation frames):
  // 150 ms off each export's start (finaltime / framestep)
  const wasPlaying = !!engine.isPlaying;
  env.setIsPlaying(false);
  // An export renders through the same scene, so world view has to be off
  // before the first frame — otherwise the rigs stay identity and the chrome
  // is still in the scene.
  if (engine.worldActive) await env.setWorldViewActive(false);
  // (farm1) a render whose Final Scene frames were traced on a render farm: its frames stand in for the traces (world3dLayer.js). Every
  // export sets it, so a render page kept warm between renders never carries one render's farm into the next.
  setWorldFarm(encodeOpts?.farm?.base ? encodeOpts.farm : null);
  // (lookfix) and with motion blur, each farm frame is its frame's whole shutter (the pod traced it as worldMotionBlur would here)
  const farmFrames = !!encodeOpts?.farm?.base;
  // (farmparity) a render farm pod's frames (VideoProjectRenderPage.jsx farmFrames): { onFrame(n, handoff, info), keep: [n…] } with the
  // frames in encodeOpts.frameRanges; each drawn as this export draws it and its Scene's picture handed back, nothing encoded
  const farmPod = !farmFrames && encodeOpts?.farmPod && typeof encodeOpts.farmPod.onFrame === 'function' ? encodeOpts.farmPod : null;
  engine.exporting = true;
  if (wasPlaying) await new Promise((r) => setTimeout(r, 150)); // let playback fully stop
  else await new Promise((r) => setTimeout(r, 0));
  // Motion-template images must be decoded before the first encoded frame;
  // template videos must at least be demuxed (their duration drives layout).
  await env.awaitMotionImages();
  // Custom-shape SVGs decode asynchronously; without this a layer that starts
  // mid-timeline encodes empty until its image lands (~1s with a dozen icons).
  preloadShapeSvgs(env.channels, env.clipsMap);
  await awaitShapeSvgImages();
  // Lazily-loaded templates (charts) must have their module in hand too —
  // preview repaints when one lands, but the encoder gets one pass per frame.
  await Promise.all([...new Set(
    env.channels.flatMap((ch) => ch.items.map((it) => it.motionTemplateId).filter(Boolean)),
  )].map((id) => ensureMotionTemplate(id)));
  // Image plates: a photo that fits inside the frame draws at its own size
  // (imagePlate.js), and a plate still decoding when its first frame is encoded
  // would bake in the fitted — blown up — version instead.
  await Promise.all([...new Set(
    env.channels.flatMap((ch) => ch.items.map((it) => env.clipsMap.get(it.clipId)))
      .filter((clip) => clip?.mediaType === 'image' && clip.url)
      .map((clip) => clip.url),
  )].map((url) => Promise.all([preloadImagePlate(url), preloadAnimatedImage(url)])));
  // Video plates the same way: a clip smaller than the frame draws at its real size
  // (videoPlate.js), read from the original file's header.
  await Promise.all(videoPlateUrls(env).map((url) => preloadVideoPlate(url)));
  // A Particle Solver draws through a lazily-imported module. In preview, a
  // frame that arrives before the import simply repaints when it lands — the
  // encoder gets ONE pass per frame, so without this the opening frames encode
  // with no particles in them and are never revisited.
  // The MODULE is what has to be in hand before the loop starts. The
  // RUNTIMES cannot be waited for here: none exist until a frame has asked
  // for one, so the wait belongs after the first render of each frame — see
  // env.settleParticlePlates, called at the end of renderFrameAtTime.
  if (env.hasParticleLayers()) await ensureParticleModuleInEngine(engine);
  if (env.hasModel3dLayers()) { try { await ensureModel3dModuleInEngine(engine); } catch { /* draws without */ } }

  const renderer = engine.renderer;
  const canvas = engine.canvas;
  if (!renderer || !canvas) return;

  const W = env.videoWidth;
  const H = env.videoHeight;
  // Output size. Normally the composition's own size. A headless render asked
  // for a same-aspect size (outputSize) delivers a SCALED copy instead: the
  // composition (W×H — layout, px values, camera) is untouched. A downscale
  // renders exactly as a full-size export and the exporter resamples each
  // frame; an upscale renders natively at the larger size (the buffer-larger-
  // than-composition state the preview's zoom buckets already use) so text and
  // shapes re-rasterize sharp instead of being stretched.
  const outScale = resolveScaledOutputSize(engine.outputSize, W, H);
  const OW = outScale ? outScale.w : W;
  const OH = outScale ? outScale.h : H;
  // The longest one frame of a Final 3D Scene may trace in this export (world3dLayer.finalFrameBudgetMs), from its samples and the larger of
  // the composition and the output. 0 without a Final Scene, which leaves every frame's watchdog exactly as it was.
  const finalFrameMs = env.channels.reduce((most, ch) => Math.max(most, ...(ch.items || []).map((it) => (rigUsesWorld(it.rig) && it.rig?.render?.mode === 'final'
    ? finalFrameBudgetMs(it.rig.render.spp ?? 64, Math.max(W, OW), Math.max(H, OH)) : 0))), 0);
  // Whether the frame at this export time (the loop's clock: a range render starts at 0) has a Final Scene as its active rig.
  const finalAt = (t) => {
    const at = isPartial ? (rangeStartFrames + Math.round(t * clampedFps)) / clampedFps
      : pieceFrames ? pieceFrames[Math.min(pieceFrames.length - 1, Math.round(t * clampedFps))] / clampedFps : t;
    const rig = engine.activeRigAt?.(at);
    return rigUsesWorld(rig) && rig?.render?.mode === 'final';
  };
  // A render cache file draws natively at its smaller size too, exactly as the
  // preview's own reduced buffer does — no full-size render to resample.
  const RW = (outScale?.upscale || (previewCacheRender && outScale)) ? OW : W;
  const RH = (outScale?.upscale || (previewCacheRender && outScale)) ? OH : H;

  // a render past the GPU's largest texture comes back black with no error: stop now with the reason (machine-readable code)
  try { checkPictureSize(renderer, RW, RH); } catch (e) { engine.exporting = false; throw e; }
  // Set renderer to full resolution for export
  renderer.setSize(RW, RH, false);
  notePerfRenderer({ w: RW, h: RH });
  // A downscale seen through a camera zoom draws each frame at a buffer that
  // shrinks with that frame's zoom (resolveScaledRenderSize) — down to the output,
  // where the exporter encodes the canvas as it is. Per frame, so an unzoomed
  // stretch keeps the full-size render; set before the frame's first render, so a
  // motion-blur accumulation keeps one size throughout. While the zoom moves the
  // buffer follows it in steps, not every frame: reallocating the canvas and every
  // target sized to it costs more than a few percent of pixels saves, and a moving
  // picture hides the slight resample. A hold (two frames that need the same size)
  // gets its exact size. A live Echo / Motion Trail / TimeShift / Repetile ring is
  // sized to the buffer and restarts when it changes, so the buffer holds while one
  // records.
  let resamplerUsed = false;
  let lastNeedW = 0;
  const sizeBufferForFrame = (outScale && !outScale.upscale && !previewCacheRender)
    ? (time) => {
      if (engine.echoState.size || engine.trailState.size || engine.timeshiftState.size || engine.repetileHist.size) return;
      const buf = resolveScaledRenderSize(outScale, W, H, cameraMagnificationAt(engine, env, time));
      const w = buf ? buf.w : RW;
      const h = buf ? buf.h : RH;
      const moving = w !== lastNeedW;
      lastNeedW = w;
      if (canvas.width === w && canvas.height === h) return;
      if (moving && Math.abs(canvas.width - w) < canvas.width * 0.04) return;
      renderer.setSize(w, h, false);
      notePerfRenderer({ w, h });
    }
    : null;

  // For alpha export, use transparent background. setAlphaExportMode also stops
  // clip letterboxing from filling its bars with opaque black (see clipShader).
  // ProRes 4444 (mov-prores4444) keeps its alpha as the transparent WebM does
  const useAlpha = format === 'webm-alpha' || format === 'mov-prores4444';
  if (useAlpha) {
    renderer.setClearColor(0x000000, 0);
    engine.alphaExport = true;
    setAlphaExportMode(true);
  }

  // Pause all videos and clear pending seek state for clean export
  for (const cs of engine.channelStates.values()) {
    for (const video of [cs.videos.a, cs.videos.b]) {
      try { video.pause(); } catch {}
      engine.pendingSeek.delete(video);
      engine.awaitingFreshFrame.delete(video);
      { const tk = engine.rvfcLoop.get(video); if (tk) tk.live = false; }
    }
  }

  const clampedFps = Math.max(1, Math.min(Number(exportFps) || 30, 240));
  const totalDuration = getTotalDurationInEngine(engine, env);
  // Partial ("Time range") render: encode only [rangeStart, rangeStart+exportDuration)
  // of the timeline. Frame rendering stays in absolute timeline time — only the
  // encoder's clock is shifted — so keyframes, transitions and the camera behave
  // exactly as they do inside the full render.
  let rangeStart = 0;
  let rangeStartFrames = 0;
  let exportDuration = totalDuration;
  // (polish3) the frames encoded, counted on the frame grid (frameGrid.js): the whole film's, or the range's from its snapped start to its
  // last frame before its end. ceil(exportDuration * fps) made 2.9-3.0 s at 30 fps four frames (its float 3.0000000000000027).
  let exportFrames = filmFrames(totalDuration, clampedFps);
  if (timeRange && Number.isFinite(Number(timeRange.end))) {
    const reqStart = Math.max(0, Math.min(Number(timeRange.start) || 0, totalDuration));
    const reqEnd = Math.max(reqStart, Math.min(Number(timeRange.end), totalDuration));
    if (reqEnd - reqStart > 0.01) {
      // SNAPPED to the frame grid, because the exporter walks `i / fps` from here:
      // an unsnapped start makes every rendered time a fraction of a frame away
      // from the one the full render evaluates, and `rangeStart + i / fps` is a
      // different double from `(rangeStart * fps + i) / fps` even when it is
      // snapped. A particle bake is read at floor(t * cacheHz), so that last ulp
      // decided whether a particle at the very start or end of its life existed —
      // about one frame in six of a range render disagreed with the full one.
      // Snapping here (not at the call site) keeps the audio window, which is
      // derived from the same rangeStart below, on the identical instant.
      rangeStartFrames = Math.round(reqStart * clampedFps);
      rangeStart = rangeStartFrames / clampedFps;
      exportDuration = reqEnd - rangeStart;
      exportFrames = rangeFrames(rangeStart, reqEnd, clampedFps).count;
    }
  }
  const isPartial = rangeStart > 0 || exportDuration < totalDuration - 1e-6;
  // Render only what changed (reuseRender.js, a server job with `reuse`): these
  // timeline frames [from, to), encoded back to back, each piece opening a GOP so
  // the backend can cut the file there; the sound is the whole film's.
  const totalFilmFrames = filmFrames(totalDuration, clampedFps);
  const pieces = !isPartial && Array.isArray(encodeOpts?.frameRanges)
    ? encodeOpts.frameRanges
      .map((r) => ({ from: Math.max(0, Math.floor(Number(r?.from))), to: Math.min(totalFilmFrames, Math.floor(Number(r?.to))) }))
      .filter((r) => Number.isFinite(r.from) && Number.isFinite(r.to) && r.to > r.from)
    : null;
  let pieceFrames = null;
  let pieceStarts = null;
  if (pieces?.length) {
    const count = pieces.reduce((n, r) => n + r.to - r.from, 0);
    pieceFrames = new Int32Array(count);
    pieceStarts = new Set();
    let at = 0;
    for (const r of pieces) {
      pieceStarts.add(at);
      for (let f = r.from; f < r.to; f += 1) pieceFrames[at++] = f;
    }
  }
  window.__exportPhase = "Setting up encoder";
  console.warn("[export-phase] Player.exportVideo: setup done, duration=" + totalDuration.toFixed(2) + "s"
    + (isPartial ? (", range=" + rangeStart.toFixed(2) + "s.." + (rangeStart + exportDuration).toFixed(2) + "s") : "")
    + ", collecting audio");

  // Collect audio clips for export mixing. Recurses into sequence (compound)
  // clips: inner audio is offset into parent time and clamped to the sequence
  // item's trim window (exact for flat-speed sequences; speed-curved sequences
  // skip inner audio with a warning — documented limitation).
  const exportAudioClips = [];
  const audioWindowStart = isPartial ? rangeStart : -Infinity;
  const audioWindowEnd = isPartial ? rangeStart + exportDuration : Infinity;
  for (const cue of encodeOpts?.noAudio === true ? [] : env.transitionSoundCues) {
    const clipped = clampTransitionSoundCue(cue, audioWindowStart, audioWindowEnd);
    if (!clipped) continue;
    exportAudioClips.push({
      url: clipped.url,
      startTime: clipped.startTime,
      trimStart: clipped.trimStart,
      trimEnd: clipped.trimEnd,
      volume: clipped.volume,
    });
  }
  const isFlatSpeedPoints = (pts) => !Array.isArray(pts) || pts.every((p) => Math.abs((p?.y ?? 1) - 1) < 1e-4);
  const collectExportAudio = (chs, cmap, layoutFor, offsetTime, depth, winStart, winEnd) => {
    for (const channel of chs) {
      if (channel.visible === false) continue;
      const layout = layoutFor(channel);
      if (!layout) continue;
      for (let i = 0; i < channel.items.length; i++) {
        const item = channel.items[i];
        const clip = cmap.get(item.clipId);
        const itemLayout = layout[i];
        if (!clip || !itemLayout) continue;

        if (isContainerClip(clip)) {
          if (depth >= SEQUENCE_MAX_DEPTH) continue;
          if (!isFlatSpeedPoints(item.speedPoints)) {
            console.warn('[export] Audio inside speed-curved sequence "' + clip.name + '" is skipped');
            continue;
          }
          const seqStart = offsetTime + itemLayout.startTime;
          const seqEnd = offsetTime + itemLayout.endTime;
          const innerCmap = new Map(clip.sequence.clips.map((c) => [c.id, c]));
          const innerLayouts = new Map(clip.sequence.channels.map((ch) => [ch.id, getTimelineLayout(ch.items, { unsnapped: ch.unsnapped })]));
          collectExportAudio(
            clip.sequence.channels,
            innerCmap,
            (ch) => innerLayouts.get(ch.id),
            seqStart - (item.trimStart || 0),
            depth + 1,
            Math.max(winStart, seqStart),
            Math.min(winEnd, seqEnd)
          );
          continue;
        }

        if (!clip.url) continue;
        const isAudio = clip.mediaType === 'audio';
        const isVideo = clip.mediaType === 'video';
        // Include dedicated audio clips AND the audio track embedded in video
        // clips. Video audio is skipped only when the item is explicitly muted.
        if (!isAudio && !(isVideo && !item.muted)) continue;
        let entryStart = offsetTime + itemLayout.startTime;
        const entryEnd = offsetTime + itemLayout.endTime;
        // The fade envelope spans the item's PLACED bounds, captured before the
        // window clamp below so a partial render mid-clip keeps the same shape.
        const placedStart = entryStart;
        const placedEnd = entryEnd;
        let trimStart = item.trimStart || 0;
        let trimEnd = item.trimEnd || clip.duration || 0;
        if (entryEnd <= winStart || entryStart >= winEnd) continue;
        // Clamp boundary items to the window (linear source mapping — exact for
        // flat item speed, which trimmed inner items always have in practice).
        if (entryStart < winStart) { trimStart += winStart - entryStart; entryStart = winStart; }
        if (entryEnd > winEnd) { trimEnd -= entryEnd - winEnd; }
        if (trimEnd - trimStart <= 0.01) continue;
        // Sound volume 0–100% → 0..1 gain for ffmpeg (the sanitizer caps stored
        // volume at 100, so legacy boosted values normalize to 100 on load).
        // Old audio clips stored volume in `opacity`; video defaults to 100%.
        const volPct = item.volume ?? (isAudio ? item.opacity : 100) ?? 100;
        exportAudioClips.push({
          url: clip.url,
          startTime: entryStart,
          trimStart,
          trimEnd,
          volume: Math.max(0, volPct / 100),
          ...(itemHasAudioFade(item) ? {
            fadeIn: Number(item.audioFadeIn) || 0,
            fadeOut: Number(item.audioFadeOut) || 0,
            fadeCurve: sanitizeAudioFadeCurve(item.audioFadeCurve),
            placedStart,
            placedEnd,
          } : {}),
        });
      }
    }
  };
  // (chatfarm2) a part of a render shared by several machines: `noAudio` encodes the part's frames without sound (the page joins the
  // parts and puts ONE sound under them: each part's own AAC would carry its own encoder priming at the seam); `audioOnly` is that one
  // sound — the whole film's (or the range's) mix as an audio-only MP4, no frame drawn
  const noAudio = encodeOpts?.noAudio === true;
  if (!previewCacheRender && !noAudio) collectExportAudio(
    env.channels, env.clipsMap, (ch) => env.layoutMap.get(ch.id), 0, 0,
    isPartial ? rangeStart : -Infinity,
    isPartial ? rangeStart + exportDuration : Infinity,
  );
  // The encoded file starts at rangeStart, so audio entries shift back to 0.
  // Placed fade bounds shift with it (they may go negative — the envelope
  // math works in output time either side of 0).
  if (isPartial) {
    for (const entry of exportAudioClips) {
      entry.startTime = Math.max(0, entry.startTime - rangeStart);
      if (entry.placedStart != null) {
        entry.placedStart -= rangeStart;
        entry.placedEnd -= rangeStart;
      }
    }
  }
  if (encodeOpts?.audioOnly === true) {
    window.__exportPhase = 'Mixing the sound';
    const blob = await exportAudioOnly({ audioClips: exportAudioClips, duration: exportDuration, audioBitrate: encodeOpts?.audioBitrate, signal, onProgress, codec: encodeOpts?.audioCodec || null });
    window.__exportPhase = null;
    return { blob, frameCount: 0, audioOnly: true, duration: exportDuration };
  }

  // ── Fast decode: WebCodecs. Decoding a clip sequentially is ~1000x faster
  // than seeking a <video> element per frame in headless. One demuxed
  // ClipSource per URL (fetch + parse once), but one ClipDecoder per
  // (video element, URL): two layers showing the same file at different
  // times (duplicated sequences, split segments crossfading, same footage
  // inside + outside a sequence) must not share a decoder — alternating two
  // target times on one shared decoder forces a keyframe reset and re-decode
  // on every exported frame. A clip that can't be demuxed/decoded falls back
  // to seeking, so mixed timelines still render (just slower for those clips).
  // Both caches store the IN-FLIGHT promise, not the settled value: when a
  // slow init overruns the per-frame watchdog, the exporter abandons that
  // frame and the next one re-requests the same URL — caching only settled
  // results made each stalled frame kick off a duplicate fetch+demux of the
  // whole file, compounding the stall into the 3-strike abort.
  const sourceCache = new Map(); // url -> Promise<ClipSource | 'failed'>
  // The live ClipSource for each URL, readable WHILE it loads. Without it
  // there is no way to say "420 MB of 954 MB" — only "still working".
  const sourceStates = new Map(); // url -> ClipSource
  // Why each source declined the fast path, by stage. This is the fact a
  // field investigation needed and could not get: "a clip likely can't be
  // decoded" is the same sentence whether the file is corrupt, unsupported,
  // or merely still arriving.
  const sourceFailures = new Map(); // url -> { kind, error }
  // Structured segment failures, for the Phase 5 transcode retry and for the
  // render error. Keyed by manifest so one bad derivative reports once.
  const segmentFailures = new Map(); // manifestUrl -> { clip, sourceTime, kind, part, message }
  // Off by default: a final render must not quietly substitute the 1280-wide
  // playback proxy for the pixels the user chose. `allowProxyRender` is the
  // explicit opt-in the plan reserves for a future user-facing option.
  const allowProxyExportFallback = encodeOpts?.allowProxyRender === true;
  // Also published on `window` so the backend can read them whether the render
  // finishes or aborts — an aborted render has no return value to carry them.
  const recordSegmentFailure = (descriptor, detail) => {
    const key = descriptor?.manifestUrl || descriptor?.baseUrl;
    if (!key || segmentFailures.has(key)) return;
    const entry = {
      code: 'SOURCE_SEGMENT_DECODE_FAILED',
      manifestUrl: descriptor?.manifestUrl || null,
      original: descriptor?.original || null,
      mode: descriptor?.mode || null,
      ...detail,
    };
    segmentFailures.set(key, entry);
    if (typeof window !== 'undefined') {
      window.__segmentDecodeFailures = [...segmentFailures.values()];
    }
  };
  if (typeof window !== 'undefined') window.__segmentDecodeFailures = [];
  const getSource = (url, acquireOpts = {}) => {
    if (!url) return Promise.resolve('failed');
    let pending = sourceCache.get(url);
    if (!pending) {
      pending = (async () => {
        const s = new ClipSource(url);
        sourceStates.set(url, s);
        let ok = false;
        try { ok = await s.init(null, acquireOpts); } catch { ok = false; }
        if (!ok) {
          sourceFailures.set(url, { kind: s.errorKind || 'unknown', error: s.error });
          console.warn('[export] ClipDecoder unavailable for ' + url
            + ' (' + (s.errorKind || 'unknown') + ': ' + s.error + ') — seek fallback');
        }
        return ok ? s : 'failed';
      })();
      sourceCache.set(url, pending);
    }
    return pending;
  };
  // WebM sources (webmClipDecoder.js), demuxed once per URL like ClipSource.
  const webmSourceCache = new Map(); // url -> Promise<WebmSource | 'failed'>
  const getWebmSource = (url) => {
    let pending = webmSourceCache.get(url);
    if (!pending) {
      pending = (async () => {
        const s = new WebmSource(url);
        const ok = await s.init();
        if (!ok) {
          console.warn('[export] WebM frame-exact decode unavailable for ' + url
            + ' (' + (s.errorKind || 'unknown') + ': ' + s.error + ') — playback frame cache');
        }
        return ok ? s : 'failed';
      })();
      webmSourceCache.set(url, pending);
    }
    return pending;
  };
  const decodersByEl = new Map(); // videoEl -> Map(url -> Promise<ClipDecoder | WebmClipDecoder | WebmFrameCache | 'failed'>)
  const allDecoders = [];
  // Segmented render sources, keyed by manifest URL. The backend prepares
  // these (see `_ensure_copy_segments` / `_ensure_transcoded_segments`) and
  // hands them over as `clip.renderVideoSource`, alongside — never instead of
  // — `clip.url`, which audio still reads.
  const segmentedSources = new Map(); // manifestUrl -> SegmentedSource
  const getSegmentedSource = (descriptor) => {
    const key = descriptor?.manifestUrl || descriptor?.baseUrl;
    if (!key) return null;
    let seg = segmentedSources.get(key);
    if (!seg) {
      seg = new SegmentedSource(descriptor);
      if (!seg.usable) return null;
      segmentedSources.set(key, seg);
    }
    return seg;
  };
  const getSegmentedDecoder = (videoEl, descriptor) => {
    const seg = getSegmentedSource(descriptor);
    if (!seg) return null;
    const key = seg.descriptor.manifestUrl || seg.baseUrl;
    let byUrl = decodersByEl.get(videoEl);
    if (!byUrl) { byUrl = new Map(); decodersByEl.set(videoEl, byUrl); }
    let dec = byUrl.get(key);
    if (!dec) {
      dec = new SegmentedClipDecoder(seg, { applyRotation: true });
      allDecoders.push(dec);
      byUrl.set(key, dec);
    }
    return dec;
  };
  const getDecoder = (videoEl, url) => {
    let byUrl = decodersByEl.get(videoEl);
    if (!byUrl) { byUrl = new Map(); decodersByEl.set(videoEl, byUrl); }
    let pending = byUrl.get(url);
    if (!pending) {
      pending = (async () => {
        // WebM can't be demuxed by the mp4box WebCodecs path (no moov box). It is
        // demuxed by webmClipDecoder.js and decoded with WebCodecs instead — alpha
        // included — so every time gets ITS frame, exactly as an mp4 does. The
        // playback frame cache below is only the fallback for a file that reader
        // cannot take: it plays the clip in real time and misses the frames shown
        // while a render holds the main thread (1-5 frames late under motion blur).
        // Over-budget clips return ready=false and drop through to the seek path
        // below (no regression).
        if (isWebmUrl(url)) {
          const webmSrc = await getWebmSource(url);
          if (webmSrc !== 'failed') {
            const d = new WebmClipDecoder(webmSrc);
            allDecoders.push(d);
            return d;
          }
          const cache = new WebmFrameCache(url);
          const ok = await cache.ensureReady();
          if (!ok) {
            console.warn('[export] WebM frame cache unavailable for ' + url + ' — seek fallback');
            return 'failed';
          }
          allDecoders.push(cache);
          return cache;
        }
        const src = await getSource(url);
        if (src === 'failed') return 'failed';
        // Upright, like the <video> element the preview draws: phone footage
        // stores the turn in its track header and VideoDecoder ignores it.
        const d = new ClipDecoder(src, { applyRotation: true });
        allDecoders.push(d);
        return d;
      })();
      byUrl.set(url, pending);
    }
    return pending;
  };
  const ensureVideoSourceForExport = async (videoEl, url) => {
    if (!url) return false;
    if (normalizeUrl(videoEl.src || '') !== normalizeUrl(url)) {
      videoEl.src = url;
      videoEl.preload = 'auto';
      videoEl.load();
    }
    if (videoEl.readyState >= 2 && !videoEl.error) return true;
    await new Promise((resolve) => {
      const done = () => {
        videoEl.removeEventListener('loadeddata', done);
        videoEl.removeEventListener('canplay', done);
        videoEl.removeEventListener('error', done);
        resolve();
      };
      videoEl.addEventListener('loadeddata', done, { once: true });
      videoEl.addEventListener('canplay', done, { once: true });
      videoEl.addEventListener('error', done, { once: true });
      setTimeout(done, 5000);
    });
    return videoEl.readyState >= 2 && !videoEl.error;
  };
  // ── Acquire every source BEFORE the frame loop ──────────────────────
  // `ClipSource.init` downloads and demuxes the WHOLE file, and it used to
  // run inside positionClip — that is, inside frame 0's watchdog. A field
  // log caught it exactly: a HEAD and a full-file GET fired the instant the
  // frame loop started, and 954 MB at that machine's measured 30 MB/s spent
  // 33 of frame 0's 60 seconds before a single byte was parsed. Frames 1 and
  // 2 then awaited the same memoised promise and burned their 15s each, and
  // the job reported "a clip likely can't be decoded" having never decoded
  // anything. 60 + 15 + 15 = the 90 seconds those renders always took.
  //
  // Every later clip had it worse: its first frame is an ordinary frame, so
  // its source had to arrive inside 15 seconds, not 60.
  //
  // Acquiring here costs no extra memory — sourceCache already held every
  // source for the whole export — and it buys a budget of its own, live
  // progress, and a failure that says which stage failed.
  const collectExportVideoUrls = (chs, cmap, layoutFor, offsetTime, depth, winStart, winEnd, out) => {
    for (const channel of chs) {
      if (channel.visible === false) continue;
      const layout = layoutFor(channel);
      if (!layout) continue;
      for (let i = 0; i < channel.items.length; i++) {
        const item = channel.items[i];
        const clip = cmap.get(item.clipId);
        const itemLayout = layout[i];
        if (!clip || !itemLayout) continue;
        const entryStart = offsetTime + itemLayout.startTime;
        const entryEnd = offsetTime + itemLayout.endTime;
        if (entryEnd <= winStart || entryStart >= winEnd) continue;
        if (isContainerClip(clip)) {
          if (depth >= SEQUENCE_MAX_DEPTH) continue;
          const innerCmap = new Map(clip.sequence.clips.map((c) => [c.id, c]));
          const innerLayouts = new Map(clip.sequence.channels.map(
            (ch) => [ch.id, getTimelineLayout(ch.items, { unsnapped: ch.unsnapped })]));
          collectExportVideoUrls(
            clip.sequence.channels, innerCmap, (ch) => innerLayouts.get(ch.id),
            entryStart - (item.trimStart || 0), depth + 1,
            Math.max(winStart, entryStart), Math.min(winEnd, entryEnd), out,
          );
          continue;
        }
        if (clip.mediaType !== 'video') continue;
        if (clip.renderVideoSource) {
          // Prepared segments are warmed by preflight below, not by loading
          // the whole thing — that is the point of preparing them.
          if (!segmentClips.some((c) => c.clip === clip)) segmentClips.push({ clip });
          continue;
        }
        const url = getClipExportUrl(clip);
        if (url && !out.includes(url)) out.push(url);
      }
    }
  };

  const warmUrls = [];
  const segmentClips = [];
  try {
    collectExportVideoUrls(
      env.channels, env.clipsMap, (ch) => env.layoutMap.get(ch.id), 0, 0,
      isPartial ? rangeStart : -Infinity,
      isPartial ? rangeStart + exportDuration : Infinity,
      warmUrls,
    );
  } catch (e) {
    console.warn('[export] source pre-scan failed, falling back to lazy loading: ' + (e?.message || e));
    warmUrls.length = 0;
  }
  if (warmUrls.length) {
    const setPhase = (text) => { if (typeof window !== 'undefined') window.__exportPhase = text; };
    console.warn(`[export-phase] acquiring ${warmUrls.length} video source(s) before the frame loop`);
    const warmStart = Date.now();
    for (let i = 0; i < warmUrls.length; i++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const url = warmUrls[i];
      const name = url.split('/').pop().split('?')[0];
      const label = warmUrls.length > 1 ? `Loading media ${i + 1} of ${warmUrls.length}` : 'Loading media';
      // WebM never goes through ClipSource (no moov box): its own demux runs here,
      // before the frame loop, like an mp4's.
      if (isWebmUrl(url)) {
        setPhase(`${label}: ${name}`);
        await getWebmSource(url);
        continue;
      }
      setPhase(`${label}: ${name}`);
      await getSource(url, {
        onProgress: (src) => setPhase(`${label}: ${src.describeProgress()}`),
      });
    }
    const failed = warmUrls.filter((u) => sourceFailures.has(u));
    console.warn(`[export-phase] sources acquired in ${((Date.now() - warmStart) / 1000).toFixed(1)}s`
      + (failed.length ? ` (${failed.length} on the seek fallback: `
        + failed.map((u) => `${u.split('/').pop().split('?')[0]} — ${sourceFailures.get(u).kind}`).join(', ') + ')' : ''));
    setPhase('Rendering frames');
  }

  // ── Preflight prepared segment sources ──────────────────────────────
  // Codec support and real decoding are RUNTIME facts: a derivative that is
  // valid on the machine that built it can still be undecodable on the one
  // rendering it. Finding that out at frame 0 wastes the whole build; finding
  // it out here turns it into a structured failure the backend can act on by
  // rebuilding the source as transcoded segments and retrying once.
  if (segmentClips.length) {
    const setPhase = (text) => { if (typeof window !== 'undefined') window.__exportPhase = text; };
    for (let i = 0; i < segmentClips.length; i++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const { clip } = segmentClips[i];
      const descriptor = clip.renderVideoSource;
      const key = descriptor.manifestUrl || descriptor.baseUrl;
      const name = clip.name || clip.id;
      setPhase(`Checking prepared media ${i + 1} of ${segmentClips.length}: ${name}`);
      const probe = new SegmentedClipDecoder(new SegmentedSource(descriptor), { applyRotation: true });
      let result;
      try {
        result = await probe.preflight();
      } catch (e) {
        result = { ok: false, error: { kind: 'preflight', message: e?.message || String(e) } };
      }
      probe.close();
      if (result.ok) {
        console.warn(`[export] segments ready for "${name}": ${descriptor.mode}, `
          + `${result.parts} part(s), ${result.probed} probed (first/middle/last)`);
      } else {
        const err = result.error || {};
        console.warn(`[export] SEGMENT PREFLIGHT FAILED for "${name}" — `
          + `part ${err.part ?? '?'} (${err.file || '?'}): ${err.kind}: ${err.message}`);
        recordSegmentFailure(descriptor, { clip: name, sourceTime: 0, stage: 'preflight', ...err });
      }
    }
    setPhase('Rendering frames');
    if (segmentFailures.size) {
      // Nothing is gained by starting a frame loop that is going to abort on
      // its first frame, and the backend can begin the rebuild that much
      // sooner.
      const f = [...segmentFailures.values()][0];
      throw new Error(
        `Prepared media for "${f.clip}" could not be decoded in this browser `
        + `(part ${f.part ?? '?'}, ${f.kind}: ${f.message}). `
        + `${segmentFailures.size} source(s) affected.`);
    }
  }

  // URLs proven unloadable (404 / decode-dead) this export. Without this a
  // single missing media file re-runs the whole load-timeout dance on every
  // frame (~5s each), which reads as a "render stalled" failure — instead the
  // verdict is cached, the layer renders empty, and the export completes.
  const unloadableUrls = new Set();
  // The clock html clips' live pages step on. The export's own fps unless motion
  // blur raises it (below), so each blur sub-frame gets its own page state.
  let htmlLivePageFps = clampedFps;
  // `instance`: which use of the clip this is (item + container path), for html
  // clips, whose live page is per use.
  const positionClip = async (videoEl, clip, sourceTime, seeks, instance = null) => {
    if (videoEl) videoEl.__htmlLive = false;
    if (clip?.htmlSource && instance && htmlLiveMode !== 'off') {
      const live = await htmlLiveExportCanvas(clip, sourceTime, {
        fps: htmlLivePageFps, videoSize: engine.videoSize, instance,
      });
      if (live) {
        videoEl.__decodeCanvas = live;
        return;
      }
      if (htmlLiveMode === 'strict' && htmlLiveSupported()) {
        htmlLiveFatal = htmlLiveFatal || `[html-live] the page of "${clip.name || clip.id}" could not be drawn live`;
        throw new Error(htmlLiveFatal);
      }
    }
    if (clip?.htmlLiveOnly) { // no bake to fall back to: the layer is empty
      videoEl.__decodeCanvas = htmlBlankCanvas(clip, engine.videoSize);
      return;
    }
    // A prepared segmented source is the render source. It is checked FIRST
    // and, unlike the whole-file path, it does not fall through to the
    // playback proxy: the point of preparing it was that the proxy is a
    // 1280-wide preview asset and a final render must never silently use it.
    const segmentDescriptor = clip?.renderVideoSource;
    if (segmentDescriptor) {
      const dec = getSegmentedDecoder(videoEl, segmentDescriptor);
      if (dec) {
        const drew = await dec.drawFrameAt(sourceTime);
        if (drew) {
          videoEl.__decodeCanvas = dec.canvas;
          return;
        }
        const why = dec.error
          ? `part ${dec.error.part} (${dec.error.file || '?'}) — ${dec.error.kind}: ${dec.error.message}`
          : 'no frame produced';
        console.warn(`[export] SEGMENT DECODE FAILED for "${clip.name || clip.id}" at ${sourceTime.toFixed(3)}s: ${why}`);
        recordSegmentFailure(segmentDescriptor, {
          clip: clip.name || clip.id, sourceTime, stage: 'decode', ...(dec.error || {}),
        });
      }
      videoEl.__decodeCanvas = null;
      return;
    }
    const primaryUrl = getClipExportUrl(clip);
    // The playback proxy is 1280 wide. It stays available as a LAST resort
    // only when the original cannot be loaded at all, and only because an
    // empty layer is worse than a soft one — never as an invisible upgrade
    // path for a clip that merely decoded slowly.
    const fallbackUrl = allowProxyExportFallback ? getClipPlaybackUrl(clip) : null;
    const urls = [primaryUrl, fallbackUrl].filter((url, idx, arr) => url && arr.indexOf(url) === idx);
    let allKnownBad = urls.length > 0;
    for (let idx = 0; idx < urls.length; idx += 1) {
      const url = urls[idx];
      if (unloadableUrls.has(url)) continue;
      allKnownBad = false;
      const dec = await getDecoder(videoEl, url);
      if (dec && dec !== 'failed') {
        await dec.drawFrameAt(sourceTime);
        videoEl.__decodeCanvas = dec.canvas; // getVideoTexture samples this
        return;
      }
      videoEl.__decodeCanvas = null;
      const canSeekOriginal = await ensureVideoSourceForExport(videoEl, url);
      if (canSeekOriginal) {
        seeks.push(seekVideoAndWaitInEngine(engine, videoEl, sourceTime));
        return;
      }
      unloadableUrls.add(url);
      if (idx === 0 && urls.length > 1) {
        console.warn('[export] Original video source unavailable for ' + primaryUrl + ' — falling back to proxy preview source');
      }
    }
    videoEl.__decodeCanvas = null;
    if (!allKnownBad) {
      // Name the stage each candidate failed at, not just that they failed:
      // "fetch" (missing/404), "demux" (not a parseable mp4), "too_slow" and
      // "too_large" (the file is fine, this path is not) need different fixes.
      const why = urls.map((u) => {
        const f = sourceFailures.get(u);
        return u.split('/').pop().split('?')[0] + (f ? ` (${f.kind}: ${f.error})` : ' (also failed to seek)');
      }).join(' , ');
      console.warn('[export] Clip media is missing or undecodable — layer "' + (clip.name || clip.id)
        + '" renders empty for this export. Checked: ' + why);
    }
  };
  // Position every active video for a frame — recursing into sequence clips so
  // their inner videos land on the mapped local time before the frame renders.
  //
  // Every layer is positioned AT ONCE (Promise.all), not one after another: the
  // positions are independent (one element / decoder / html page per layer),
  // and a live html page is a wait, not work — it steps and paints two
  // animation frames later. One after another, three visible pages cost three
  // of those waits per frame (≈30 ms each, measured); together they cost one.
  const positionChannelVideosForExport = async (chs, cmap, layoutFor, states, time, depth, seeks, scope = '') => {
    const instanceKeyOf = (it) => (scope ? `${scope}:${it.id}` : it.id);
    const pending = [];
    for (const channel of chs) {
      if (channel.visible === false) continue;
      const layout = layoutFor(channel);
      const cs = states.get(channel.id);
      if (!layout || !cs) continue;
      const activeIndex = resolveActiveIndex(layout, time);
      if (activeIndex < 0) continue;
      const item = channel.items[activeIndex];
      const itemLayout = layout[activeIndex];
      const clip = cmap.get(item.clipId);
      if (!clip) continue;
      const timeInClip = time - itemLayout.startTime;

      const inTransitionOverlap = activeIndex > 0
        && itemLayout.overlapIn > 0
        && timeInClip <= itemLayout.overlapIn;
      if (inTransitionOverlap) {
        const preset = getAdvancedTransitionPreset(item.transition);
        const rawProgress = Math.max(0, Math.min(1, timeInClip / itemLayout.overlapIn));
        for (const definition of preset?.media || []) {
          if (definition?.type !== 'video' || !definition.src) continue;
          const mediaState = env.ensureTransitionPackageMedia(cs, definition);
          const trimStart = Math.max(0, finiteNumber(definition.trimStart, 0));
          const trimEnd = Number.isFinite(definition.trimEnd)
            ? Math.max(trimStart, definition.trimEnd)
            : trimStart + itemLayout.overlapIn;
          const sourceTime = trimStart + rawProgress * Math.max(0.001, trimEnd - trimStart);
          pending.push(positionClip(
            mediaState.video,
            { id: `transition-media:${definition.id}`, name: definition.id, mediaType: 'video', url: definition.src },
            sourceTime,
            seeks,
          ));
        }
      }

      // Posterize Time: a posterized layer's media sits on its held step (the same
      // clock channelRender gives the layer).
      const layerTimeInClip = posterizedTimeInClip(item, timeInClip, itemLayout.duration);
      if (isContainerClip(clip) && depth < SEQUENCE_MAX_DEPTH) {
        const st = ensureSequenceStateInEngine(engine, item.id, clip);
        if (st) {
          const localTime = calculateVideoTime(item, Math.max(0, layerTimeInClip));
          pending.push(positionChannelVideosForExport(
            clip.sequence.channels, st.clipsMap, (ch) => st.layouts.get(ch.id), st.channelStates, localTime, depth + 1, seeks,
            instanceKeyOf(item),
          ));
        }
        continue;
      }

      if (clip.mediaType !== 'video') continue;
      const useVideoA = activeIndex % 2 === 0;
      const activeVideo = useVideoA ? cs.videos.a : cs.videos.b;
      pending.push(positionClip(activeVideo, clip, calculateVideoTime(item, layerTimeInClip), seeks, instanceKeyOf(item)));

      const inOverlap = activeIndex > 0 && itemLayout.overlapIn > 0 && timeInClip <= itemLayout.overlapIn;
      if (inOverlap) {
        const prevItem = channel.items[activeIndex - 1];
        const prevLayout = layout[activeIndex - 1];
        const prevClip = cmap.get(prevItem.clipId);
        if (prevClip?.mediaType === 'video') {
          const prevTimeInClip = Math.max(0, Math.min(prevLayout.duration, time - prevLayout.startTime));
          const previousVideo = useVideoA ? cs.videos.b : cs.videos.a;
          pending.push(positionClip(previousVideo, prevClip, calculateVideoTime(prevItem, prevTimeInClip), seeks, instanceKeyOf(prevItem)));
        }
      }
    }
    await Promise.all(pending);
  };
  const decodeAllVideosForTime = async (time) => {
    const seeks = [];
    await positionChannelVideosForExport(
      env.channels, env.clipsMap, (ch) => env.layoutMap.get(ch.id), engine.channelStates, time, 0, seeks
    );
    seeks.push(seekParticleObjectVideosInEngine(engine, env, time));
    await Promise.all(seeks);
  };

  // `footageTime`: the time the footage shows, the frame's own under the motion-blur accumulator (each sub-frame draws every layer at its
  // own time, and the footage's picture of the frame: it already carries its camera's blur).
  const renderFrameAtTime = async (time, footageTime = time) => {
    engine.currentTime = time;
    await decodeAllVideosForTime(footageTime);
    // Mark seek-fallback video textures fresh (decode clips update via canvas) —
    // top-level env.channels and any sequence-inner env.channels alike.
    const allChannelStates = [
      ...engine.channelStates.values(),
      ...[...engine.sequenceStates.values()].flatMap((st) => [...st.channelStates.values()]),
    ];
    for (const cs of allChannelStates) {
      for (const video of [cs.videos.a, cs.videos.b]) {
        if (!video.__decodeCanvas && video.src && video.readyState >= 2) {
          engine.videoFrameReady.add(video);
          const cached = engine.videoTextureCache.get(video);
          if (cached) { cached.texture.needsUpdate = true; cached.hadFrame = true; }
        }
      }
    }
    engine.renderFrame();
    // An image layer that first appears mid-timeline asks for its texture in the
    // pass above. Encoded before it lands, the frame has no picture for that layer
    // (or, before the draw-side guard, two opaque black letterbox bars). Wait and
    // repaint, exactly as a still capture does.
    if (await awaitImageTexturesInEngine(engine)) engine.renderFrame();
    // A custom-shape SVG first asked for by this pass (a sequence/grid member the
    // warm-up didn't reach) must land before the frame is encoded.
    if (await awaitShapeSvgImages()) engine.renderFrame();
    // A package may initialize shaders, lookup data, or scene assets
    // asynchronously. The first export frame must wait and repaint instead of
    // silently encoding the package's empty root while preview catches up later.
    if (await waitForTransitionPackageInstances(allChannelStates)) {
      engine.renderFrame();
    }
    // Motion templates ask for their video frames while drawing, so the first
    // pass can only paint what was already decoded. Decode what it asked for
    // and repaint until nothing is outstanding — that's what makes an exported
    // frame identical to the (eventually settled) preview.
    for (let guard = 0; guard < 3 && motionMediaPending(); guard += 1) {
      await pumpMotionMedia();
      engine.renderFrame();
    }
    // Animated images (GIF/WebP/APNG) settle the same way, and the warm-up above
    // only walked the TOP-LEVEL env.channels — a GIF inside a sequence or a grid cell
    // is first asked for here, by the pass that drew it. Without this it would
    // encode as its static first frame while preview showed it moving. One pump
    // settles a whole file, so this converges in a pass or two rather than
    // per-frame; the guard is for a nested layer revealed by the repaint.
    for (let guard = 0; guard < 3 && animatedImagePending(); guard += 1) {
      await pumpAnimatedImages();
      engine.renderFrame();
    }
    // Auto Fill bakes its arrival field, and the Rig tool its deform mesh,
    // off the matte the pass above just drew — and the readback that feeds
    // both is asynchronous. The paint above therefore used the previous one:
    // fine for preview, never for an exported frame. Settle and repaint
    // until nothing has landed unpainted; a landed bake can reveal the next
    // one, since a repaint asks for data the first pass could not have.
    //
    // The gate is "did a bake change something since the last paint", not
    // "is one in flight" — the latter is a race with microtask timing
    // whenever the readback resolves during one of the awaits above.
    for (let guard = 0; guard < 4; guard += 1) {
      if (bakesPending()) await bakesSettled();
      if (!consumeBakeChange()) break;
      engine.renderFrame();
    }
    // A world Scene lands late on its first frame, and a Final render traces every frame to its samples. The frame rate lets a frame that
    // follows the one before it carry that frame's soft light (world3dLayer.settleWorldFrame, softReuse).
    try {
      // (badframes) a frame the guard sent back reads the Scene's canvas as a still does (first since a rendering update)
      const redraw = engine.guardRedraw === true;
      engine.guardRedraw = false;
      await settleWorldLast(engine, { fps: clampedFps, handoff: redraw });
    } catch (e) {
      if (e?.finalStall) worldFatal = worldFatal || e.message;
      throw e;
    }
    /*
     * THE GPU PARTICLE PLATES, LAST — after every repaint above, because
     * each of those steps the runtimes again and submits more work.
     *
     * A Tier 2 runtime paints onto its own canvas on its own device, and the
     * compositor uploads that canvas as a texture in the SAME pass that
     * asked for it. Nothing makes the two devices agree on ordering, so the
     * frame that is encoded can carry the previous step's plate: invisible
     * in the preview, and in a render it is a systematic one-frame lag on
     * every particle layer in the project. Settle, then repaint so the
     * finished canvas is the one that gets uploaded.
     */
    await env.settleParticlePlates();
    /*
     * END ON A SYNCHRONOUS RENDER, IN THE TASK THE EXPORTER READS IN.
     *
     * videoExporter awaits this function and then hands `canvas` straight to
     * `new VideoFrame(canvas)` / `drawImage(canvas)`. Its continuation is a
     * microtask (through a Promise.race with a timeout — still a microtask),
     * so it runs BEFORE the next rendering opportunity as long as nothing
     * here awaits after the last paint. With `preserveDrawingBuffer: false`
     * (touch tier, plan A4) that ordering is the whole guarantee: the buffer
     * is discarded at compositing, and env.settleParticlePlates repaints only
     * when a pump reported work. Every await in this function is above this
     * line; this render is the last thing that happens, and the exporter's
     * read is the next. On desktop it repaints the identical frame (same
     * time, settled inputs) — no pixel difference, one render per frame.
     * Under the motion-blur accumulator this paints into the sub-frame
     * target like the renders above it; the accumulator's final blit to the
     * canvas is synchronous too.
     */
    engine.renderFrame();
  };

  // Motion blur (optional): when enabled, frames whose shutter window contains
  // real transform motion render as an N-sample accumulation (true blur); still
  // frames keep the single render so cost only grows where motion exists. A
  // disabled switch leaves renderFrameAtTime untouched — byte-for-byte today's
  // export.
  let renderExportFrame = renderFrameAtTime;
  // (farmparity) a render farm pod (encodeOpts.farmPod): each of its frames rendered as this export renders it, and the Scene's picture of
  // the frame (the world's handoff canvas) handed back in place of the composite. Motion blur sets its own below.
  let podFrame = farmPod ? async (time) => { await renderFrameAtTime(time); return worldFarmHandoff(engine); } : null;
  let motionBlurInfo = null; // for the GPU-reset message: which frames multiply
  // (hdrscene) this frame is an average of 2D sub-frames (no single world frame is its picture)
  let accumulatedNow = false;
  // (hdr2) an HDR render that keeps its Scene's light averages those sub-frames in float too (hdrComposite.js): set below when it does
  let hdrAccumulation = null;
  if (engine.motionBlurEnabled && !previewCacheRender) {
    try {
      if (!engine.motionBlurModule) engine.motionBlurModule = await import('../motionBlur');
      const pipeline = getMotionBlurPipelineInEngine(engine);
      // Strength from the project's Blur dropdown. The level carries both the
      // shutter angle and its sample count, so the detector's exposure window and
      // the accumulation agree.
      const level = motionBlurLevelForShutter(engine.motionBlurShutter);
      const shutterWindow = (level.shutter / 360) / clampedFps;
      // A Scene's keys are sampled as its world samples them, loaded only for a project with a Scene: a 2D project loads nothing of the world.
      const worldKeys = env.channels.some((ch) => ch.items?.some((it) => rigUsesWorld(it.rig)))
        ? await import('../../../world3d/keys.js') : null;
      const sampleTrack = worldKeys?.sampleTrack || null;
      // (animtools) drives on the Scene's clocks, ƒx on its keys and follow paths, sampled as the world samples them
      const fieldsMove = worldKeys?.fieldsMoveBetween || null;
      // Two poses differ by more than rounding. Thresholds: px, radians, scale factor.
      const prsMoves = (a, b) => Math.abs(a.px - b.px) > 5e-3 || Math.abs(a.py - b.py) > 5e-3
        || Math.abs(a.pz - b.pz) > 5e-3
        || Math.abs(a.rx - b.rx) > 1e-4 || Math.abs(a.ry - b.ry) > 1e-4
        || Math.abs(a.rz - b.rz) > 1e-4
        || Math.abs(a.sx - b.sx) > 5e-4 || Math.abs(a.sy - b.sy) > 5e-4;
      // A keyframed layer moves when its RESOLVED pose moves — the same localPrs the
      // renderer places it with — not when some named track changes. So Scale X/Y, a
      // live motion path (its progress, offsets or keyed shape) and a transform
      // origin all count, and positional tracks a live path overrides do not.
      const keyedPoseMoves = (it, entry, ta, tb) => {
        const d = entry.endTime - entry.startTime;
        if (!(d > 0)) return false;
        const ka = getItemKeyframeValues(it, clamp01((ta - entry.startTime) / d));
        const kb = getItemKeyframeValues(it, clamp01((tb - entry.startTime) / d));
        return prsMoves(localPrs(it, ka, W, H), localPrs(it, kb, W, H));
      };
      // Transform motion detector for one output frame: keyframed transforms
      // (incl. adjustment-layer zoom/pan) on the active top-level items, and the
      // same inside every active sequence clip.
      const layoutFor = (ch) => env.layoutMap.get(ch.id);
      // A sequence's own timeline over one output frame's shutter: its camera clip, and
      // each live inner layer's keyed transform, speed ramp, particles, live page or
      // nested sequence (down to the 4-level nesting limit). Times map in as the
      // sequence renders them (calculateVideoTime, as renderSequenceFrame's caller
      // does), and the export renders sequences live, so the sub-frames carry the motion.
      // Without this a camera move inside a sequence (Convert to scenes puts every
      // scene's move there) exported sharp. Inner parenting/follow links are not read.
      const sequenceHasMotion = (seqClip, seqItem, itemStart, ta, tb, depth) => {
        const inner = seqClip?.sequence;
        if (!inner || depth > 4) return false;
        const innerChannels = Array.isArray(inner.channels) ? inner.channels : [];
        const innerClips = new Map((inner.clips || []).map((c) => [c.id, c]));
        const a = calculateVideoTime(seqItem, Math.max(0, ta - itemStart));
        const b = calculateVideoTime(seqItem, Math.max(0, tb - itemStart));
        const layouts = new Map(innerChannels.map((ch) => [ch.id, getTimelineLayout(ch.items || [], { unsnapped: ch.unsnapped })]));
        const camFrame = { width: W, height: H };
        const ca = resolveCameraPose(innerChannels, innerClips, (ch) => layouts.get(ch.id), a, camFrame);
        const cb = resolveCameraPose(innerChannels, innerClips, (ch) => layouts.get(ch.id), b, camFrame);
        if (ca && cb) {
          for (const key of CAMERA_KF_LABELS) {
            if (Math.abs(ca[key] - cb[key]) > (key === 'camZoom' ? 5e-4 : 5e-3)) return true;
          }
        } else if (Boolean(ca) !== Boolean(cb)) {
          return true;
        }
        const mid = (a + b) / 2;
        for (const ch of innerChannels) {
          if (ch.visible === false) continue;
          const layout = layouts.get(ch.id);
          if (!layout) continue;
          const ai = resolveActiveIndex(layout, mid);
          if (ai < 0) continue;
          const it = ch.items[ai];
          const en = layout[ai];
          const c = innerClips.get(it?.clipId);
          if (!c) continue;
          if (c.mediaType === PARTICLE_MEDIA_TYPE && it?.particleSystem) return true;
          if (c.htmlSource && htmlLiveMode !== 'off' && htmlLiveSupported()) return true;
          if (c.mediaType === 'sequence' && sequenceHasMotion(c, it, en.startTime, a, b, depth + 1)) return true;
          if (c.mediaType === 'text' && textAnimatorsMoveBetween(it, en.startTime, a, b, evaluatePropertyTrack)) return true;
          if (c.mediaType === 'model3d' && it.model3dConfig?.animation?.clip && modelClipMovesBetween(it.model3dConfig.animation,
            engine.model3d?.modelAnimationClips?.(c, it) ?? null, a - en.startTime, b - en.startTime)) return true;
          // (pose) a model posed by model3dConfig.pose: its clips, keys and targets (modelPose.js poseMayMove)
          if (c.mediaType === 'model3d' && it.model3dConfig?.pose && poseMayMove(it.model3dConfig.pose, a - en.startTime, b - en.startTime)) return true;
          if (itemHasKeyframes(it) && keyedPoseMoves(it, en, a, b)) return true;
        }
        return false;
      };
      const frameHasMotion = (time) => {
        const t0 = time - shutterWindow / 2;
        const t1 = time + shutterWindow / 2;
        // The camera layer moves the whole stack, so a fast pan/punch has to blur
        // even when no individual layer is keyframed.
        const camFrame = { width: W, height: H };
        const camA = resolveCameraPose(env.channels, env.clipsMap, layoutFor, t0, camFrame);
        const camB = resolveCameraPose(env.channels, env.clipsMap, layoutFor, t1, camFrame);
        if (camA && camB) {
          for (const key of CAMERA_KF_LABELS) {
            if (Math.abs(camA[key] - camB[key]) > (key === 'camZoom' ? 5e-4 : 5e-3)) return true;
          }
        } else if (Boolean(camA) !== Boolean(camB)) {
          return true; // entering or leaving a camera clip
        }
        // The Rig's own keyframes, and what moves inside a Scene's world, move nothing a layer's transform shows (worldMotion.js): its
        // objects' and its camera's keys, its bodies, a .blend's baked playback, particles, smoke and cloth.
        if (rigKeysMove(engine.activeRigAt?.(t0), engine.activeRigAt?.(t1))) return true;
        const rigNow = engine.activeRigAt?.(time);
        const inWorld = rigUsesWorld(rigNow);
        // (mblur2) a rigged object's pose too (its clips, keys and targets)
        // (its keys on the Scene's own clock, from its clip's start: rig3d.js sceneTimeAt; worldMovesBetween turns timeline times itself)
        // (mblur5) the frame's own Scene's clock across its whole shutter, past a cut too (world3dLayer.js worldClockIn)
        const clock = worldClockIn(engine, time);
        if (inWorld && sceneMovesBetween(rigNow.scene, clock(t0), clock(t1),
          { runtime: () => worldMovesBetween(t0, t1, time), sampleTrack, poseMoves: poseMayMove, fieldsMove })) return true;
        for (const channel of env.channels) {
          if (channel.visible === false) continue;
          const layout = env.layoutMap.get(channel.id);
          if (!layout) continue;
          const ai = resolveActiveIndex(layout, time);
          if (ai < 0) continue;
          const item = channel.items[ai];
          const entry = layout[ai];
          const clip = env.clipsMap.get(item?.clipId);
          if (!clip) continue;
          // (a video's speed ramp is not motion here: the footage shows the frame's own picture in every sub-frame, renderFrameAtTime)
          if (clip.mediaType === 'sequence' && sequenceHasMotion(clip, item, entry.startTime, t0, t1, 1)) return true;
          // A particle system's CONTENT moves even when its layer does not: the
          // solver is running whatever the transform does. Without this a solver
          // with no keyframes is the one thing in the frame that exports sharp
          // while everything around it blurs. Each sub-frame then samples the
          // bake at its own time — it never advances the simulation.
          if (clip.mediaType === PARTICLE_MEDIA_TYPE && item?.particleSystem) return true;
          // Letters a Text Animator moves inside a still layer, 2D or 3D, while one of them really moves (worldMotion.js).
          if (clip.mediaType === 'text' && textAnimatorsMoveBetween(item, entry.startTime, t0, t1, evaluatePropertyTrack)) return true;
          // A model layer's own GLB clips, while they play and the pose changes; a model that falls in a Scene's world, until it rests.
          if (clip.mediaType === 'model3d') {
            if (item.model3dConfig?.animation?.clip && modelClipMovesBetween(item.model3dConfig.animation,
              engine.model3d?.modelAnimationClips?.(clip, item) ?? null, t0 - entry.startTime, t1 - entry.startTime)) return true;
            if (item.model3dConfig?.pose && poseMayMove(item.model3dConfig.pose, t0 - entry.startTime, t1 - entry.startTime)) return true;
            if (inWorld && !channel.cameraLocked && item.model3dConfig?.physics === 'falls' && worldMovesBetween(t0, t1, time) !== false) return true;
          }
          // Same for an html clip drawn live: its page animates inside a still
          // layer. Each sub-frame steps the page to its own time (htmlLivePageFps).
          // A bake is one picture per frame, so it has nothing to blur.
          if (clip.htmlSource && htmlLiveMode !== 'off' && htmlLiveSupported()) return true;
          // A parented layer moves when its PARENT moves, even with no keyframes
          // of its own — compare the resolved parent PRS across the shutter.
          if (getParenting(item)) {
            const pa = resolveParentingInEngine(engine, env.parentIndex, item, t0)?.prs;
            const pb = resolveParentingInEngine(engine, env.parentIndex, item, t1)?.prs;
            if (pa && pb && prsMoves(pa, pb)) return true;
          }
          // Same reasoning for a motion-track link: a layer with no keyframes
          // at all can be moving fast because the thing it follows is. Without
          // this the follower is the ONE layer in the frame that exports sharp
          // while everything around it blurs.
          if (item?.motionFollow) {
            const fa = resolveFollowInEngine(engine, env.parentIndex, item, t0);
            const fb = resolveFollowInEngine(engine, env.parentIndex, item, t1);
            if (fa && fb) {
              if (Math.abs(fa.dxPx - fb.dxPx) > 5e-3 || Math.abs(fa.dyPx - fb.dyPx) > 5e-3
                || Math.abs(fa.rotateDeg - fb.rotateDeg) > 5e-3
                || Math.abs(fa.scaleMul - fb.scaleMul) > 5e-4) return true;
            }
          }
          if (itemHasKeyframes(item) && keyedPoseMoves(item, entry, t0, t1)) return true;
        }
        return false;
      };
      // (mblur) Whether anything besides a Final Scene's own world moves across this frame's shutter: a layer the world does not draw (its
      // keys, parent, follow, text animators, particles, live page, a sequence's inside), the Rig's own keys (lights, environment,
      // backdrop), a model the world draws moving by its layer (keys, its clip, a fall), or the Camera layer while it films any layer but
      // the world. When nothing does, the world's trace takes the frame's motion itself (worldMotionBlur): one trace, not one a sub-frame.
      // (mblur3) The Rig's keys on its lights (colour, strength, place) and a model the world draws (its keys, clip, pose, a fall) are the
      // world's now: it relights and poses them at each of the shutter's times (world3dLayer.js worldMotionBlur / worldDraftBlur).
      // (mblur5) So are a 3D Text layer's letters the world takes (its Text Animators, its keys, its parent, its track): laid out at each of
      // those times (channelRender.js text3dRunAt) and traced moving as any object. Before, they sent the frame to the sub-frames (cloverx:
      // 158 s a Final frame where the titles' letters move, against 9.7 s).
      const textAt = env.setupMesh ? (channel, t) => text3dRunAt(engine, env, channel, t) : null;
      const outsideWorldMoves = (time) => {
        const t0 = time - shutterWindow / 2;
        const t1 = time + shutterWindow / 2;
        // (mblur5) the frame's own Scene layer's Rig across its whole shutter: past a cut into another Scene, the frame keeps its own
        const rigAt = worldRigIn(engine, time);
        if (rigKeysMoveBeyondLights(rigAt(t0), rigAt(t1))) return true;
        const camFrame = { width: W, height: H };
        const camA = resolveCameraPose(env.channels, env.clipsMap, layoutFor, t0, camFrame);
        const camB = resolveCameraPose(env.channels, env.clipsMap, layoutFor, t1, camFrame);
        let cameraMoves = Boolean(camA) !== Boolean(camB);
        if (camA && camB) {
          for (const key of CAMERA_KF_LABELS) {
            if (Math.abs(camA[key] - camB[key]) > (key === 'camZoom' ? 5e-4 : 5e-3)) cameraMoves = true;
          }
        }
        for (const channel of env.channels) {
          if (channel.visible === false) continue;
          const layout = env.layoutMap.get(channel.id);
          if (!layout) continue;
          const ai = resolveActiveIndex(layout, time);
          if (ai < 0) continue;
          const item = channel.items[ai];
          const entry = layout[ai];
          const clip = env.clipsMap.get(item?.clipId);
          if (!clip || clip.mediaType === 'audio' || clip.mediaType === 'camera' || channel.kind === 'camera') continue;
          // (mblur5) 3D Text letters the world takes move in it: laid out at each of the shutter's times (textAt)
          const worldLetters = !!textAt && clip.mediaType === 'text' && worldTakesLetters(engine, channel, item, clip);
          if (worldLetters) continue;
          const inWorld = rigUsesWorld(item.rig) || (clip.mediaType === 'model3d' && worldHolds(item.id));
          if (cameraMoves && !inWorld && !channel.cameraLocked) return true;
          if (clip.mediaType === 'sequence' && sequenceHasMotion(clip, item, entry.startTime, t0, t1, 1)) return true;
          if (clip.mediaType === PARTICLE_MEDIA_TYPE && item?.particleSystem) return true;
          if (clip.mediaType === 'text' && textAnimatorsMoveBetween(item, entry.startTime, t0, t1, evaluatePropertyTrack)) return true;
          // a model the world draws moves in the world (its keys, its clip, its pose, a fall: posed at each time of the shutter); one it does
          // not draw (its own pass) moves outside it
          const worldModel = clip.mediaType === 'model3d' && worldHolds(item.id);
          if (clip.mediaType === 'model3d' && !worldModel) {
            if (item.model3dConfig?.animation?.clip && modelClipMovesBetween(item.model3dConfig.animation,
              engine.model3d?.modelAnimationClips?.(clip, item) ?? null, t0 - entry.startTime, t1 - entry.startTime)) return true;
            if (item.model3dConfig?.pose && poseMayMove(item.model3dConfig.pose, t0 - entry.startTime, t1 - entry.startTime)) return true;
            if (item.model3dConfig?.physics === 'falls') return true;
          }
          if (clip.htmlSource && htmlLiveMode !== 'off' && htmlLiveSupported()) return true;
          if (getParenting(item)) {
            const pa = resolveParentingInEngine(engine, env.parentIndex, item, t0)?.prs;
            const pb = resolveParentingInEngine(engine, env.parentIndex, item, t1)?.prs;
            if (pa && pb && prsMoves(pa, pb)) return true;
          }
          if (item?.motionFollow) {
            const fa = resolveFollowInEngine(engine, env.parentIndex, item, t0);
            const fb = resolveFollowInEngine(engine, env.parentIndex, item, t1);
            if (fa && fb && (Math.abs(fa.dxPx - fb.dxPx) > 5e-3 || Math.abs(fa.dyPx - fb.dyPx) > 5e-3
              || Math.abs(fa.rotateDeg - fb.rotateDeg) > 5e-3 || Math.abs(fa.scaleMul - fb.scaleMul) > 5e-4)) return true;
          }
          if (!worldModel && itemHasKeyframes(item) && keyedPoseMoves(item, entry, t0, t1)) return true;
        }
        return false;
      };
      // (filmbugs) and only where a Scene layer is on the timeline (worldSceneOn): past its clip nothing of the world is in the frame
      const finalWorldAt = (time) => {
        const rig = engine.activeRigAt?.(time);
        return rigUsesWorld(rig) && rig?.render?.mode === 'final' && worldSceneOn(engine, time);
      };
      const cameraPoseAt = (t) => resolveCameraPose(env.channels, env.clipsMap, layoutFor, t, { width: W, height: H });
      if (pipeline) {
        // Html pages step through the sub-frames: K page frames per output frame, so
        // one page step lies between each two samples (the accumulator's clamps; K is
        // 32 for every Blur level). An output frame's own instant is page frame
        // K × its index, so the page passes through the same states as without blur.
        const blurSamples = Math.max(2, Math.min(32, Math.round(level.samples)));
        const blurShutter = Math.max(45, Math.min(360, level.shutter));
        htmlLivePageFps = clampedFps * Math.ceil((360 * blurSamples) / blurShutter - 1e-9);
        const maxTime = Math.max(0, totalDuration - 1e-3);
        // (mblur) a Final Scene's world makes room for the shutter's poses before its first trace, so its kernels are built once
        // (mblur2) and any Scene's sims are drawn at the time drawn (Draft's sub-frames between two sim frames see them move)
        if (env.channels.some((ch) => ch.items?.some((it) => rigUsesWorld(it.rig)))) {
          await reserveWorldMotion(true, { trace: !farmFrames && env.channels.some((ch) => ch.items?.some((it) => rigUsesWorld(it.rig) && it.rig?.render?.mode === 'final')) });
        }
        // (filmbugs) the frame at `time` with its world traced once with the shutter and held while the 2D sub-frames are drawn over it.
        // False (nothing drawn for the frame yet) when the world refuses its one pass or does not hold this frame (3D Text letters in it)
        const renderHeldWorldFrame = async (time) => {
          const window = (level.shutter / 360) / clampedFps;
          await primeWorldFrame(engine, time, window);
          if (!worldMotionBlur(engine, { time, window, maxTime, cameraPoseAt, env, textAt })) return false;
          try { await renderFrameAtTime(time); } finally { clearWorldMotion(); }
          if (!worldHold(true, engine)) return false;
          motionBlurInfo.held += 1;
          engine.shutterFrameTime = time;
          try {
            await pipeline.renderAccumulated((t) => renderFrameAtTime(t, time), time, { fps: clampedFps, shutter: level.shutter, samples: level.samples, maxTime });
          } finally {
            engine.shutterFrameTime = null;
            worldHold(false);
          }
          return true;
        };
        renderExportFrame = async (time) => {
          if (!frameHasMotion(time)) { await renderFrameAtTime(time); return; }
          // (mblur5) the first frame of another Scene layer (a cut): the world laid out and built for it before its shutter's poses are taken
          const worldOnly = !outsideWorldMoves(time);
          if (worldOnly) await primeWorldFrame(engine, time, (level.shutter / 360) / clampedFps);
          // (lookfix) a Final Scene frame a render farm traced: its picture is the shutter's already (the pod's `farmPod` frame below), drawn once
          if (farmFrames && finalWorldAt(time) && worldOnly) {
            await renderFrameAtTime(time);
            motionBlurInfo.traced += 1;
            return;
          }
          // (mblur) a Final Scene whose world is all that moves: its one trace gives each sample its own time in the shutter
          if (finalWorldAt(time) && worldOnly
            && worldMotionBlur(engine, { time, window: (level.shutter / 360) / clampedFps, maxTime, cameraPoseAt, env, textAt })) {
            try { await renderFrameAtTime(time); } finally { clearWorldMotion(); }
            motionBlurInfo.traced += 1;
            return;
          }
          // (mblur2) a Draft Scene whose world is all that moves: the world averages its own light over the shutter's times, filmed once
          // (as Final's trace does), and the frame is rendered once over it. A 2D project, or a Scene the world cannot average, as before
          if (!finalWorldAt(time) && worldOnly
            && worldDraftBlur(engine, { time, window: (level.shutter / 360) / clampedFps, samples: level.samples, maxTime, cameraPoseAt, env, textAt })) {
            try { await renderFrameAtTime(time); } finally { clearWorldDraftBlur(); }
            motionBlurInfo.averaged += 1;
            return;
          }
          // (filmbugs) a Final Scene under 2D layers that move: the world traced ONCE with its own shutter at the frame's time and held
          // (worldHold) while the 2D layers are drawn at the sub-frames' times over it. It was traced again at every sub-frame: 16 traces
          // a frame under a fading end card or moving titles. A render farm's pod hands the same one-pass picture (podFrame below)
          if (!farmFrames && !hdrAccumulation && finalWorldAt(time)) {
            if (await renderHeldWorldFrame(time)) return;
          }
          motionBlurInfo.accumulated += 1;
          accumulatedNow = true;
          // every sub-frame at its own time, the footage at the frame's (renderFrameAtTime); (smallfix) and a Scene's objects shown or
          // hidden as at the frame's time (their `visible` keys: a switch is never blurred, world3dLayer.js poseWorld)
          engine.shutterFrameTime = time;
          // (hdr2) and in float, each sub-frame's own float composite added in at its weight: the frame keeps its light
          const hdrSub = hdrAccumulation;
          hdrSub?.beginAccumulation(blurSamples);
          try {
            await pipeline.renderAccumulated(hdrSub
              ? async (t) => { await renderFrameAtTime(t, time); await hdrSub.subFrame(!!sceneLight?.checkDue()); }
              : (t) => renderFrameAtTime(t, time), time, {
              fps: clampedFps,
              shutter: level.shutter,
              samples: level.samples,
              maxTime,
            });
          } finally {
            engine.shutterFrameTime = null;
          }
        };
        // (farmparity) a render farm pod's frame with motion blur: the Scene's picture of the frame exactly as the home render above makes it.
        // The same choice as above: where only the world moves, the world's shutter in its one trace (worldMotionBlur) when it takes it;
        // otherwise (the world refuses one pass, or something outside it moves, which sends the home render to its sub-frames) the world at
        // the accumulator's own times (motionBlur.js renderAccumulated), each with the frame's `visible` keys, averaged as pictures
        // (farmHandoff.js): the very traces a home render averages. Home lays its own 2D sub-frames over that one farm picture.
        if (farmPod) {
          const podWindow = (blurShutter / 360) / clampedFps;
          podFrame = async (time) => {
            if (!frameHasMotion(time)) { await renderFrameAtTime(time); return worldFarmHandoff(engine); }
            const worldOnly = !outsideWorldMoves(time);
            // (filmbugs) where 2D layers move over the Scene, home holds the world's one-pass picture under them (renderHeldWorldFrame): the
            // pod hands that same picture, unless the frame's world took 3D Text letters (home renders those as sub-frames)
            await primeWorldFrame(engine, time, (level.shutter / 360) / clampedFps);
            if (finalWorldAt(time) && worldMotionBlur(engine, { time, window: (level.shutter / 360) / clampedFps, maxTime, cameraPoseAt, env, textAt })) {
              let h = null;
              try {
                await renderFrameAtTime(time);
                if (worldOnly || !engine.worldTakesText) h = await worldFarmHandoff(engine);
              } finally { clearWorldMotion(); }
              if (h) {
                motionBlurInfo.traced += 1;
                return { ...h, meta: { ...h.meta, motion: worldOnly ? 'traced' : 'held' } };
              }
            }
            motionBlurInfo.accumulated += 1;
            engine.shutterFrameTime = time;
            const subs = [];
            try {
              for (let k = 0; k < blurSamples; k += 1) {
                await renderFrameAtTime(Math.max(0, Math.min(maxTime, time - podWindow / 2 + (podWindow * (k + 0.5)) / blurSamples)), time);
                subs.push(await worldFarmHandoff(engine));
              }
            } finally {
              engine.shutterFrameTime = null;
            }
            return averageHandoffs(subs);
          };
        }
        motionBlurInfo = { label: level.label, samples: level.samples, hasMotion: frameHasMotion, traced: 0, accumulated: 0, averaged: 0, held: 0 };
        console.warn('[export] motion blur accumulation enabled ('
          + level.label + ' — shutter ' + level.shutter + '°, ' + level.samples + ' samples; html pages step at '
          + htmlLivePageFps + ' fps)');
      }
    } catch (e) {
      console.warn('[export] motion blur unavailable, exporting without it: ' + (e?.message || e));
    }
  }

  if (sizeBufferForFrame) {
    const renderSized = renderExportFrame;
    renderExportFrame = async (time) => { sizeBufferForFrame(time); await renderSized(time); };
  }

  // (hdrscene) An HDR render keeps its Scene's own light when the render is the Scene alone (../hdrScene.js): the world films each frame
  // through its HDR view too and the frame goes out as half floats. Anything else drawn with the Scene, and the render is today's.
  const hdrMode = (encodeOpts?.hdr === 'pq' || encodeOpts?.hdr === 'hlg') && typeof frameSinks?.onFrameImage === 'function' && !previewCacheRender ? encodeOpts.hdr : null;
  // (hdr2) Titles, cards, fades and the common transitions with the Scene: every frame composited again in float (../hdrComposite.js), the
  // Scene's plate carrying its own light and every 2D layer at SDR white. Also a Scene alone at another size than the project's (the float
  // picture resampled), and a frame averaged over 2D sub-frames in either (the float frames averaged). WebGPU only, as the Scene.
  // (hdr3) An HDR MP4's frames of light leave as the file's own 4:2:0 planes, luma-adjusted on the GPU (../hdrEncode.js), made on the first
  // frame that needs them; ProRes 4444 (4:4:4, alpha) keeps the planar half floats.
  let hdrEncoderMade = null;
  const encoderNow = () => {
    if (!hdrEncoderMade) hdrEncoderMade = createHdrEncoder(engine, { width: OW, height: OH, transfer: hdrMode });
    if (!hdrEncoderMade) throw new Error('the HDR frames could not be encoded on this GPU');
    return hdrEncoderMade;
  };
  const hdrEncoder = hdrMode && encodeOpts?.hdrYuv === true && !useAlpha && renderer.isWebGPURenderer ? {
    encodeData: (data, o) => encoderNow().encodeData(data, o),
    encodeTexture: (target, o) => encoderNow().encodeTexture(target, o),
    stats: () => hdrEncoderMade?.stats() || null,
    dispose: () => hdrEncoderMade?.dispose(),
  } : null;
  const hdrComposite = hdrMode && renderer.isWebGPURenderer ? createHdrComposite(engine, { width: OW, height: OH, alpha: useAlpha, encoder: hdrEncoder }) : null;
  // the frame being drawn's time: what it draws is the key its check goes by (a new set of layers, a transition's stretch, every 2 s)
  let litFrameTime = 0;
  const layerSignature = () => {
    const parts = [];
    for (const ch of env.channels) {
      if (ch.visible === false) continue;
      const layout = env.layoutMap.get(ch.id);
      if (!layout) continue;
      const ai = resolveActiveIndex(layout, litFrameTime);
      if (ai < 0) continue;
      const it = ch.items[ai], e = layout[ai];
      const into = litFrameTime - e.startTime, left = e.endTime - litFrameTime;
      const phase = e.overlapIn > 0 && into <= e.overlapIn ? 'x'
        : it.transitionInType && it.transitionInType !== 'None' && into < (Number(it.transitionInDuration) || 0) ? 'i'
          : it.transitionOutType && it.transitionOutType !== 'None' && left < (Number(it.transitionOutDuration) || 0) ? 'o' : '';
      parts.push(`${it.id}${phase}`);
    }
    return `${parts.join(',')}|${engine.worldFrameReady ? 'w' : ''}|${Math.floor((litFrameTime * clampedFps) / 60)}`;
  };
  const sceneLight = hdrMode ? createSceneLight({
    world: { hdrFrame: () => worldHdrFrame(engine), sdrPixels: () => worldSdrPixels(), off: () => worldHdrOut(false) },
    width: OW, height: OH, alpha: useAlpha, accumulated: () => accumulatedNow, worldDrew: () => engine.worldFrameReady === true,
    composite: hdrComposite, signature: layerSignature, encoder: hdrEncoder,
  }) : null;
  if (sceneLight) {
    const range = { channels: env.channels, clipsMap: env.clipsMap, layoutMap: env.layoutMap,
      start: isPartial ? rangeStart : 0, end: isPartial ? rangeStart + exportDuration : totalDuration, isWorldRig: rigUsesWorld };
    const alone = sceneOnlyReason({ ...range, background: engine.background, size: { w: W, h: H }, outSize: { w: OW, h: OH } });
    const floatWhy = alone ? (hdrComposite ? hdrFloatReason(range) : alone) : null;
    const mode = !alone ? 'scene' : !floatWhy ? 'composite' : null;
    const reason = mode ? null : floatWhy;
    if (mode) worldHdrOut(true, { alpha: useAlpha });
    sceneLight.start(reason, mode);
    if (mode && hdrComposite) hdrAccumulation = hdrComposite;
    const frames = hdrEncoder ? '4:2:0 planes made on the GPU (luma-adjusted)' : 'half-float frames';
    console.warn('[export-phase] HDR ' + hdrMode + ': ' + (reason ? 'today\'s 8-bit frames (' + reason + ')'
      : mode === 'composite' ? "the Scene's own light through the float composite (" + alone + '), ' + frames
        : "the Scene's own light, " + frames));
    const renderLit = renderExportFrame;
    renderExportFrame = async (time) => { accumulatedNow = false; litFrameTime = time; await renderLit(time); };
  }

  engine.exportActive = true; // renderFrame skips <video> seeks; uses decode canvases
  // A phone previews pictures small (./phoneMedia.js); a real render draws them at its own size.
  if (phoneMode() && !previewCacheRender) { engine.phonePictureEdge = Math.max(W, H); dropPhonePictures(engine); }
  try {
    console.warn("[export-phase] Player.exportVideo: calling runExport, audioClips=" + exportAudioClips.length);

    // Frame 0 has to prime a decoder for EVERY video clip that overlaps the
    // first exported frame, so its cost scales with how many of them stack
    // up there — not with whether the render is partial. A timeline whose
    // clips all start at 0 pays for all of them at once; the flat 15s
    // watchdog then fails a project that was merely slow to start, three
    // frames in. Budget per concurrent decoder, with a floor.
    const primeTime = isPartial ? rangeStart : (pieceFrames ? pieceFrames[0] / clampedFps : 0);
    let primeVideoCount = 0;
    for (const channel of env.channels) {
      if (channel.visible === false) continue;
      const layout = env.layoutMap.get(channel.id);
      if (!layout) continue;
      const ai = resolveActiveIndex(layout, primeTime);
      if (ai < 0) continue;
      const clip = env.clipsMap.get(channel.items[ai]?.clipId);
      if (clip?.mediaType === 'video') primeVideoCount += 1;
    }
    const firstFrameTimeoutMs = Math.min(180000, Math.max(60000, primeVideoCount * 20000));
    console.warn(`[export-phase] frame0 budget=${firstFrameTimeoutMs}ms (${primeVideoCount} video clip(s) at ${primeTime.toFixed(2)}s)`);

    // (badframes) the frame guard (frameGuard.js): every frame's picture is checked after it is read and before it is encoded or sent,
    // drawn again when it is not whole, and the render stops with a sentence when it never is. The checks read what the render keeps
    // anyway; a Scene's picture costs a 32 x 32 sample of it, drawn and sent for reading as the plate fills (worldGuardSampling), so
    // the check finds it read and does not wait on the GPU (world3dLayer.worldFrameFacts).
    const frameGuardLog = createFrameGuardLog();
    worldGuardSampling(true);
    const timelineFrame = (t) => (isPartial ? rangeStartFrames + Math.round(t * clampedFps)
      : pieceFrames ? pieceFrames[Math.min(pieceFrames.length - 1, Math.round(t * clampedFps))] : Math.round(t * clampedFps));
    const checkFrame = async (i, t, attempt, { error = null, since = 0, resets = 0 } = {}) => {
      const frame = timelineFrame(t);
      const time = frame / clampedFps;
      if (frameFaultOn('gpuReset')) noteGpuReset();
      const unchecked = frameFaultOn('guardOff');
      disarmFrameFaults();
      if (unchecked) return { ok: true };
      const facts = (await worldFrameFacts(engine, { since, time })) || {};
      if (error && !error.finalStall) facts.error = String(error?.message || error);
      // a rebuilt compositor draws on a new canvas this render does not hold: no retry on it
      const rebuilt = engine.renderer !== renderer;
      if (rebuilt) facts.gpuReset = "the compositor's GPU device was lost and the compositor rebuilt";
      else if (gpuResetCount() !== resets && !facts.gpuReset) facts.gpuReset = 'a GPU context of the page was lost';
      const verdict = frameVerdict(facts, rebuilt ? FRAME_GUARD_RETRIES : attempt, { frame, time });
      if (verdict.ok) return verdict;
      if (verdict.fail) throw frameGuardError(verdict);
      frameGuardLog.note(verdict.retry, { frame, time, detail: verdict.detail });
      console.warn(`[frame guard] frame ${frame} (${time.toFixed(3)} s) is drawn again (${verdict.retry}): ${verdict.detail}`);
      if (verdict.retry === 'device') releaseLostWorld();
      // the redraw reads the Scene's canvas as a still does: first since a rendering update (worldHandoff.js)
      engine.guardRedraw = true;
      return verdict;
    };

    // (farmparity) a render farm pod: its frames in turn, each checked by the frame guard as an encoded one is (drawn again when it is not
    // whole, the render stopped with a sentence when it never is), and each kept one's Scene picture handed to the pod's sink
    if (farmPod) {
      if (!pieceFrames?.length) throw new Error('[FARM_POD] no frames were given to this pod');
      const keep = new Set(Array.isArray(farmPod.keep) ? farmPod.keep.map(Number) : pieceFrames);
      let sent = 0;
      for (let i = 0; i < pieceFrames.length; i += 1) {
        const n = pieceFrames[i];
        for (let attempt = 0; ; attempt += 1) {
          if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
          armFrameFaults();
          const since = performance.now();
          const resets = gpuResetCount();
          let error = null, handoff = null;
          try { handoff = await podFrame(n / clampedFps); } catch (e) { error = e; }
          if (worldFatal || error?.finalStall) throw error || new Error(worldFatal);
          if (htmlLiveFatal) throw new Error(htmlLiveFatal);
          const verdict = await checkFrame(i, i / clampedFps, attempt, { error, since, resets });
          if (verdict?.retry) continue;
          if (error) throw error;
          if (keep.has(n)) { await farmPod.onFrame(n, handoff, { ms: Math.round(performance.now() - since), attempt }); sent += 1; }
          break;
        }
      }
      if (motionBlurInfo && (motionBlurInfo.traced || motionBlurInfo.accumulated)) {
        console.warn(`[export] farm pod motion blur: ${motionBlurInfo.traced} frame(s) traced once with their motion, ${motionBlurInfo.accumulated} from ${motionBlurInfo.samples} sub-frames`);
      }
      return { farmPod: true, frames: sent, frameGuard: frameGuardLog.summary() };
    }

    const out = await runExport({
      checkFrame,
      // The exporter's clock runs 0..exportDuration; shift into absolute
      // timeline time so a partial render shows the same frames as playback.
      // The shift is counted in FRAMES (rangeStart is frame-snapped above), so
      // frame i of a range render evaluates the identical double the full render
      // evaluates for the same instant — see the note where rangeStart is set.
      // (badframes) each attempt at a frame arms the guard tests' faults (frameGuard.armFrameFaults: one property read when none)
      renderFrameAtTime: (t) => {
        armFrameFaults();
        return isPartial
          ? renderExportFrame((rangeStartFrames + Math.round(t * clampedFps)) / clampedFps)
          : pieceFrames
            ? renderExportFrame(pieceFrames[Math.min(pieceFrames.length - 1, Math.round(t * clampedFps))] / clampedFps)
            : renderExportFrame(t);
      },
      canvas,
      // A camera-sized buffer between output and composition takes the filtered
      // resample (frameResampler.js) and is encoded at the output size as it is;
      // the composition-sized and output-sized buffers keep the exporter's own path.
      captureFrame: sizeBufferForFrame
        ? () => {
          if ((canvas.width === RW && canvas.height === RH) || (canvas.width === OW && canvas.height === OH)) return canvas;
          resamplerUsed = true;
          return resampleFrame(canvas, OW, OH) || canvas;
        }
        : undefined,
      duration: pieceFrames ? pieceFrames.length / clampedFps : exportDuration,
      frameCount: pieceFrames ? pieceFrames.length : exportFrames,
      ...(pieceFrames ? {
        keyFrameAt: (i) => pieceStarts.has(i),
        audioDuration: exportDuration,
      } : {}),
      encoderConfig: encodeOpts?.encoderConfig || null,
      fps: clampedFps,
      width: OW,
      height: OH,
      format,
      audioClips: exportAudioClips,
      onProgress,
      signal,
      onOutputChunk,
      onFrameImage: frameSinks?.onFrameImage || null,
      onAudioData: frameSinks?.onAudioData || null,
      onFrameTime: frameSinks?.onFrameTime || null,
      forceFrames: encodeOpts?.forceFrames === true,
      sceneLight,
      // Sized above from the decoders frame 0 actually has to cold-start;
      // error/log times shift back into absolute timeline time.
      firstFrameTimeoutMs,
      // A frame where a Final Scene is the active rig waits for its trace (settleWorldFrame: every sample and the denoiser's own end),
      // however long that takes: its watchdog is the world's own limit for a frame, a minute more, so the world's clearer error comes
      // first, and one stall stops the render. A blurred frame is `samples` renders, each traced. Every other frame, and every frame of a
      // project without a Final Scene, keeps the 15 s and three stalls in a row it always had.
      frameTimeoutMs: finalFrameMs ? (t) => (finalAt(t) ? (finalFrameMs + 60000) * (motionBlurInfo?.samples || 1) : 0) : 0,
      stallLimit: finalFrameMs ? (t) => (finalAt(t) ? 1 : 3) : 3,
      displayTimeOffset: rangeStart,
      // Prepared segments that will not decode here end the render. The
      // backend rebuilds that source as transcoded segments and retries once;
      // continuing would produce a finished-looking file with a blank layer.
      checkFatal: () => {
        if (worldFatal) return worldFatal;
        if (htmlLiveFatal) return htmlLiveFatal;
        if (!segmentFailures.size) return null;
        const f = [...segmentFailures.values()][0];
        return `prepared media for "${f.clip}" could not be decoded in this browser `
          + `(part ${f.part ?? '?'}, ${f.kind}: ${f.message}). `
          + `${segmentFailures.size} source(s) affected.`;
      },
      // Turn a stall into a sentence someone can act on. Acquisition state
      // first — a source still arriving is the single most common cause and
      // the one the old message actively pointed away from.
      describeStall: () => {
        const loading = [...sourceStates.values()].filter(
          (src) => src.phase !== 'ready' && src.phase !== 'failed');
        if (loading.length) {
          return 'still acquiring source media: ' + loading.map((src) => {
            const secs = ((src.timings.totalMs || 0) / 1000).toFixed(0);
            return src.describeProgress() + (Number(secs) > 0 ? ` after ${secs}s` : '');
          }).join('; ') + '. The render is waiting on the file, not on decoding it.';
        }
        if (segmentFailures.size) {
          return 'prepared segment media failed to decode in this browser: '
            + [...segmentFailures.values()].map((f) =>
              `"${f.clip}" part ${f.part ?? '?'} (${f.file || '?'}) — ${f.kind}: ${f.message}`).join('; ');
        }
        if (sourceFailures.size) {
          const slow = [...sourceFailures.entries()].filter(([, f]) => f.kind === 'too_slow');
          const rest = [...sourceFailures.entries()].filter(([, f]) => f.kind !== 'too_slow');
          const parts = [];
          if (slow.length) {
            parts.push('source media could not be loaded fast enough: '
              + slow.map(([, f]) => f.error).join('; '));
          }
          if (rest.length) {
            parts.push('these clips fell back to frame-by-frame seeking, which is far slower: '
              + rest.map(([url, f]) => `${url.split('/').pop().split('?')[0]} (${f.kind}: ${f.error})`).join('; '));
          }
          return parts.join(' — ');
        }
        if (finalFrameMs) {
          return `a Final 3D Scene frame did not finish tracing in ${Math.round(finalFrameMs / 60000)} min. Lower the Scene's samples or the `
            + 'video size, or render it in Draft.';
        }
        return null;
      },
      // A GPU reset kills the encoder silently; name what was on screen — the
      // heaviest active layers, and whether motion blur multiplied that frame.
      gpuResetCount,
      describeGpuReset: (t) => {
        const time = isPartial ? (rangeStartFrames + Math.round(t * clampedFps)) / clampedFps : t;
        const active = [];
        for (const channel of env.channels) {
          if (channel.visible === false) continue;
          const layout = env.layoutMap.get(channel.id);
          if (!layout) continue;
          const ai = resolveActiveIndex(layout, time);
          if (ai < 0) continue;
          const item = channel.items[ai];
          active.push({ item, clip: env.clipsMap.get(item?.clipId) });
        }
        let blur = null;
        try { if (motionBlurInfo?.hasMotion(time)) blur = motionBlurInfo; } catch { /* diagnosis only */ }
        return describeGpuLoad(active, blur);
      },
      // Render Settings overrides (bits/sec); absent = quality-based defaults.
      bitrate: encodeOpts?.videoBitrate || undefined,
      audioBitrate: encodeOpts?.audioBitrate || undefined,
      // Output-queue byte budget (RENDER_MAX_QUEUED_OUTPUT_BYTES); undefined
      // leaves the exporter on its own default.
      maxQueuedOutputBytes: Number.isFinite(encodeOpts?.maxQueuedOutputBytes)
        ? encodeOpts.maxQueuedOutputBytes
        : undefined,
    });

    // (hdr2) how an HDR render's frames were made, and the float composite's checks against the 8-bit picture
    if (sceneLight) {
      const r = sceneLight.report();
      if (r.mode) {
        console.warn('[export-phase] HDR frames: ' + JSON.stringify({ mode: r.mode, frames: r.frames, sdrFrames: r.sdrFrames, checks: r.checks, blurred: r.blurred,
          check: r.check ? { same: r.check.same, meanDiff: Math.round(r.check.meanDiff * 1000) / 1000, off: r.check.off, above: r.check.above } : null,
          reason: r.reason || null, ms: r.ms, composite: hdrComposite?.stats() || null, encode: hdrEncoder?.stats() || null }));
      }
    }
    // (mblur) how the blurred frames were made: traced once with the motion (a Final Scene's world), or accumulated sub-frames
    if (motionBlurInfo && (motionBlurInfo.traced || motionBlurInfo.accumulated || motionBlurInfo.averaged || motionBlurInfo.held)) {
      console.warn(`[export] motion blur: ${motionBlurInfo.traced} frame(s) traced once with their motion, ${motionBlurInfo.held} traced once under 2D sub-frames, ${motionBlurInfo.averaged} Draft frame(s) averaged in light, ${motionBlurInfo.accumulated} accumulated from ${motionBlurInfo.samples} sub-frames`);
    }

    // Hand the result back to the caller (download + board copy happen there).
    // When streamed, output already went out via onOutputChunk — there's no blob.
    const ext = format === 'mp4' ? 'mp4' : 'webm';
    // Structured segment failures ride out with the result so the backend can
    // rebuild that source as transcoded segments and retry ONCE, rather than
    // the render either failing opaquely or quietly degrading.
    const segmentDecodeFailures = [...segmentFailures.entries()].map(([manifestUrl, f]) => ({
      code: 'SOURCE_SEGMENT_DECODE_FAILED', manifestUrl, ...f,
    }));
    // (badframes) the frames drawn again, by reason: the render succeeded, and its report says so
    const frameGuard = frameGuardLog.summary();
    if (frameGuard) console.warn('[export] frame guard: ' + JSON.stringify(frameGuard).slice(0, 600));
    if (out?.framesMode) {
      return { framesMode: true, frames: out.frames, ext, segmentDecodeFailures, frameGuard,
        ...(sceneLight ? { hdrScene: { ...sceneLight.report(), ...(hdrComposite && sceneLight.report().mode ? { msComposite: hdrComposite.stats() } : {}) } } : {}) };
    }
    // audioWarning names clips whose sound could not be read. It rides all the
    // way out because the file itself is finished and looks fine — nothing
    // downstream can tell it went out partly silent unless we say so.
    const encoder = out?.encoder || null;
    if (out?.streamed) return { streamed: true, ext, audioWarning: out?.audioWarning || null, segmentDecodeFailures, encoder, frameGuard };
    return { blob: out?.blob, ext, audioWarning: out?.audioWarning || null, segmentDecodeFailures, encoder, frameGuard };
  } finally {
    // Tear down the fast-decode session: stop skipping seeks, free decoders +
    // their canvas textures, and detach decode canvases from the video elements.
    engine.exportActive = false;
    engine.exporting = false;
    worldGuardSampling(false);
    setWorldFarm(null);
    reserveWorldMotion(false);
    if (sceneLight) worldHdrOut(false);
    hdrComposite?.dispose();
    hdrEncoder?.dispose();
    if (engine.phonePictureEdge) { engine.phonePictureEdge = 0; dropPhonePictures(engine); }
    for (const d of allDecoders) { try { d.close(); } catch { /* ignore */ } }
    disposeHtmlLiveExportPages();
    sourceCache.clear(); // drop demuxed sample tables (can hold GBs for long 4K sources)
    webmSourceCache.clear();
    for (const cs of engine.channelStates.values()) {
      for (const video of [cs.videos.a, cs.videos.b]) { if (video) video.__decodeCanvas = null; }
    }
    for (const st of engine.sequenceStates.values()) {
      for (const cs of st.channelStates.values()) {
        for (const video of [cs.videos.a, cs.videos.b]) { if (video) video.__decodeCanvas = null; }
      }
    }
    for (const entry of engine.canvasTextureCache.values()) { try { entry.texture.dispose(); } catch { /* ignore */ } }
    engine.canvasTextureCache.clear();
    if (resamplerUsed) releaseFrameResampler();
    // Restore preview state
    engine.alphaExport = false;
    setAlphaExportMode(false);
    renderer.setClearColor(0x000000, 1);
    const previewSize = engine.previewRenderSize;
    renderer.setSize(previewSize.w || env.renderWidth, previewSize.h || env.renderHeight, false);
    notePerfRenderer({ w: previewSize.w || env.renderWidth, h: previewSize.h || env.renderHeight });
    engine.currentTime = 0;
    engine.committedTime = 0;
    env.setCurrentTime(0);
    env.setPlayheadTime?.(0);
  }
}
