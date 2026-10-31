/*
 * Export and stills (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 28d — moved verbatim out of the Player's
 * imperative API with tests/engine-extraction/tools/stage9_exporter.py): captureFrameAtTime renders one composited
 * frame at a time and returns it as a PNG data URL; exportVideo renders the project frame by frame into a video file
 * (WebCodecs mp4 / webm, alpha, motion blur, audio mix). The Player's handle keeps the same keys and calls these.
 */
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
import { getItemKeyframeValues, itemHasKeyframes } from '../gsapTransitions';
import { disposeHtmlLiveExportPages, htmlBlankCanvas, htmlLiveExportCanvas, htmlLiveSettleUsed, htmlLiveSupported } from '../htmlLive';
import { preloadImagePlate } from '../imagePlate';
import { preloadVideoPlate } from '../videoPlate';
import { getParenting, localPrs } from '../keyframeParenting';
import { motionBlurLevelForShutter } from '../motionBlurLevels';
import { ensureMotionTemplate, motionMediaPending, pumpMotionMedia } from '../motionTemplates';
import { notePerfRenderer } from '../perfRegistry.js';
import { CAMERA_KF_LABELS, perspectiveDistance, resolveCameraPose } from '../projectCamera';
import { resolveScaledOutputSize, resolveScaledRenderSize } from '../renderOutputSize';
import { getTimelineLayout } from '../speedUtils';
import { waitForTransitionPackageInstances } from '../transitionPackageRuntime';
import { isContainerClip, SEQUENCE_MAX_DEPTH } from '../types';
import { exportVideo as runExport, isWebCodecsSupported } from '../videoExporter';
import { selectedBackend } from '../videoRenderer';
import { ClipDecoder, ClipSource, SegmentedClipDecoder, SegmentedSource } from '../webcodecsClipDecoder';
import { isWebmUrl, WebmFrameCache } from '../webmFrameCache';
import { WebmClipDecoder, WebmSource } from '../webmClipDecoder';
import { ensureSequenceState as ensureSequenceStateInEngine } from './channelStates';
import { resolveActiveIndex } from './compositeHelpers';
import { calculateVideoTime, clamp01 } from './layerHelpers';
import { getTotalDuration as getTotalDurationInEngine, seekAllVideosForTime as seekAllVideosForTimeInEngine, seekParticleObjectVideos as seekParticleObjectVideosInEngine, seekVideoAndWait as seekVideoAndWaitInEngine } from './mediaClock';
import { awaitImageTextures as awaitImageTexturesInEngine, getClipExportUrl, getClipPlaybackUrl, normalizeUrl } from './mediaTextures';
import { resolveFollow as resolveFollowInEngine, resolveParenting as resolveParentingInEngine } from './meshTransform';
import { ensureModel3dModule as ensureModel3dModuleInEngine, ensureParticleModule as ensureParticleModuleInEngine } from './modules3d';
import { getMotionBlurPipeline as getMotionBlurPipelineInEngine } from './motionPasses';
import { awaitShapeSvgImages, finiteNumber, preloadShapeSvgs } from './mediaHelpers';

// Every top-level video's real-size source (videoPlate.js reads the original, not the proxy).
function videoPlateUrls(env) {
  return [...new Set(
    env.channels.flatMap((ch) => ch.items.map((it) => env.clipsMap.get(it.clipId)))
      .filter((clip) => clip?.mediaType === 'video' && !clip.htmlSource && (clip.url || clip.proxyUrl))
      .map((clip) => clip.url || clip.proxyUrl),
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

export async function captureFrameAtTime(engine, env, time, opts = {}) {
  // A still is one render, so installed effect packages the project uses have
  // to be loaded before it (they are listed lazily).
  await prepareLocalEffectsFor(env.channels);
  const markTexturesFresh = () => {
    for (const cs of engine.channelStates.values()) {
      for (const video of [cs.videos.a, cs.videos.b]) {
        if (video.src && video.readyState >= 2) {
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
  try {
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
    // Same readiness the export loop insists on before its first frame:
    // template images, and the plate of every image layer (a plate resolved
    // late would capture the fitted, blown-up picture instead).
    try { await env.awaitMotionImages(); } catch { /* captures without */ }
    // Custom-shape SVGs load lazily; one that starts mid-timeline would be
    // requested by the capture render itself and miss the readback.
    preloadShapeSvgs(env.channels, env.clipsMap);
    await awaitShapeSvgImages();
    await Promise.all([...new Set(
      env.channels.flatMap((ch) => ch.items.map((it) => env.clipsMap.get(it.clipId)))
        .filter((clip) => clip?.mediaType === 'image' && clip.url)
        .map((clip) => clip.url),
    )].map((url) => Promise.all([preloadImagePlate(url), preloadAnimatedImage(url)]).catch(() => null)));
    await Promise.all(videoPlateUrls(env).map((url) => preloadVideoPlate(url).catch(() => null)));
    await seekAllVideosForTimeInEngine(engine, env, time);
    markTexturesFresh();
    engine.renderFrame();
    // That render is what ASKS for the image textures (getImageTexture runs
    // inside it), so only now can the capture wait for them. A texture that
    // lands after the readback is a black layer in the still, never repainted.
    if (await awaitImageTexturesInEngine(engine)) engine.renderFrame();
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
  } catch {
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

  env.setIsPlaying(false);
  // An export renders through the same scene, so world view has to be off
  // before the first frame — otherwise the rigs stay identity and the chrome
  // is still in the scene.
  if (engine.worldActive) await env.setWorldViewActive(false);
  engine.exporting = true;
  await new Promise((r) => setTimeout(r, 150)); // let playback fully stop
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
  // A render cache file draws natively at its smaller size too, exactly as the
  // preview's own reduced buffer does — no full-size render to resample.
  const RW = (outScale?.upscale || (previewCacheRender && outScale)) ? OW : W;
  const RH = (outScale?.upscale || (previewCacheRender && outScale)) ? OH : H;

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
  const useAlpha = format === 'webm-alpha';
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
    }
  }
  const isPartial = rangeStart > 0 || exportDuration < totalDuration - 1e-6;
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
  for (const cue of env.transitionSoundCues) {
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
  if (!previewCacheRender) collectExportAudio(
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

  const renderFrameAtTime = async (time) => {
    engine.currentTime = time;
    await decodeAllVideosForTime(time);
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
  let motionBlurInfo = null; // for the GPU-reset message: which frames multiply
  if (engine.motionBlurEnabled && !previewCacheRender) {
    try {
      if (!engine.motionBlurModule) engine.motionBlurModule = await import('../motionBlur');
      const pipeline = getMotionBlurPipelineInEngine(engine);
      // Strength from the project's Blur dropdown. The level carries both the
      // shutter angle and its sample count, so the detector's exposure window and
      // the accumulation agree.
      const level = motionBlurLevelForShutter(engine.motionBlurShutter);
      const shutterWindow = (level.shutter / 360) / clampedFps;
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
      // (incl. adjustment-layer zoom/pan) and speed-ramped video on the active
      // top-level items, and the same inside every active sequence clip.
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
          if (c.mediaType === 'video' && Array.isArray(it.speedPoints)
            && it.speedPoints.some((p) => Math.abs((p?.y ?? 1) - 1) > 1e-3)) return true;
          if (c.mediaType === PARTICLE_MEDIA_TYPE && it?.particleSystem) return true;
          if (c.htmlSource && htmlLiveMode !== 'off' && htmlLiveSupported()) return true;
          if (c.mediaType === 'sequence' && sequenceHasMotion(c, it, en.startTime, a, b, depth + 1)) return true;
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
          if (clip.mediaType === 'video' && Array.isArray(item.speedPoints)
            && item.speedPoints.some((p) => Math.abs((p?.y ?? 1) - 1) > 1e-3)) return true;
          if (clip.mediaType === 'sequence' && sequenceHasMotion(clip, item, entry.startTime, t0, t1, 1)) return true;
          // A particle system's CONTENT moves even when its layer does not: the
          // solver is running whatever the transform does. Without this a solver
          // with no keyframes is the one thing in the frame that exports sharp
          // while everything around it blurs. Each sub-frame then samples the
          // bake at its own time — it never advances the simulation.
          if (clip.mediaType === PARTICLE_MEDIA_TYPE && item?.particleSystem) return true;
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
      if (pipeline) {
        // Html pages step through the sub-frames: K page frames per output frame, so
        // one page step lies between each two samples (the accumulator's clamps; K is
        // 32 for every Blur level). An output frame's own instant is page frame
        // K × its index, so the page passes through the same states as without blur.
        const blurSamples = Math.max(2, Math.min(32, Math.round(level.samples)));
        const blurShutter = Math.max(45, Math.min(360, level.shutter));
        htmlLivePageFps = clampedFps * Math.ceil((360 * blurSamples) / blurShutter - 1e-9);
        renderExportFrame = async (time) => {
          if (!frameHasMotion(time)) { await renderFrameAtTime(time); return; }
          await pipeline.renderAccumulated(renderFrameAtTime, time, {
            fps: clampedFps,
            shutter: level.shutter,
            samples: level.samples,
            maxTime: Math.max(0, totalDuration - 1e-3),
          });
        };
        motionBlurInfo = { label: level.label, samples: level.samples, hasMotion: frameHasMotion };
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

  engine.exportActive = true; // renderFrame skips <video> seeks; uses decode canvases
  try {
    console.warn("[export-phase] Player.exportVideo: calling runExport, audioClips=" + exportAudioClips.length);

    // Frame 0 has to prime a decoder for EVERY video clip that overlaps the
    // first exported frame, so its cost scales with how many of them stack
    // up there — not with whether the render is partial. A timeline whose
    // clips all start at 0 pays for all of them at once; the flat 15s
    // watchdog then fails a project that was merely slow to start, three
    // frames in. Budget per concurrent decoder, with a floor.
    const primeTime = isPartial ? rangeStart : 0;
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

    const out = await runExport({
      // The exporter's clock runs 0..exportDuration; shift into absolute
      // timeline time so a partial render shows the same frames as playback.
      // The shift is counted in FRAMES (rangeStart is frame-snapped above), so
      // frame i of a range render evaluates the identical double the full render
      // evaluates for the same instant — see the note where rangeStart is set.
      renderFrameAtTime: isPartial
        ? (t) => renderExportFrame((rangeStartFrames + Math.round(t * clampedFps)) / clampedFps)
        : renderExportFrame,
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
      duration: exportDuration,
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
      forceFrames: encodeOpts?.forceFrames === true,
      // Sized above from the decoders frame 0 actually has to cold-start;
      // error/log times shift back into absolute timeline time.
      firstFrameTimeoutMs,
      displayTimeOffset: rangeStart,
      // Prepared segments that will not decode here end the render. The
      // backend rebuilds that source as transcoded segments and retries once;
      // continuing would produce a finished-looking file with a blank layer.
      checkFatal: () => {
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

    // Hand the result back to the caller (download + board copy happen there).
    // When streamed, output already went out via onOutputChunk — there's no blob.
    const ext = format === 'mp4' ? 'mp4' : 'webm';
    // Structured segment failures ride out with the result so the backend can
    // rebuild that source as transcoded segments and retry ONCE, rather than
    // the render either failing opaquely or quietly degrading.
    const segmentDecodeFailures = [...segmentFailures.entries()].map(([manifestUrl, f]) => ({
      code: 'SOURCE_SEGMENT_DECODE_FAILED', manifestUrl, ...f,
    }));
    if (out?.framesMode) return { framesMode: true, frames: out.frames, ext, segmentDecodeFailures };
    // audioWarning names clips whose sound could not be read. It rides all the
    // way out because the file itself is finished and looks fine — nothing
    // downstream can tell it went out partly silent unless we say so.
    if (out?.streamed) return { streamed: true, ext, audioWarning: out?.audioWarning || null, segmentDecodeFailures };
    return { blob: out?.blob, ext, audioWarning: out?.audioWarning || null, segmentDecodeFailures };
  } finally {
    // Tear down the fast-decode session: stop skipping seeks, free decoders +
    // their canvas textures, and detach decode canvases from the video elements.
    engine.exportActive = false;
    engine.exporting = false;
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
