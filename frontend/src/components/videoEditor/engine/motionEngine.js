/*
 * createMotionEngine — the GreenLight Motion Engine without React (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9
 * step 28e4). It drives the very code the video editor's Player drives:
 *   - the envs and engine handles come from ./driverWiring.js, GENERATED from Player.jsx
 *     (tests/engine-extraction/tools/gen_driver_wiring.py), so the two can never wire the engine differently;
 *   - the editor's effects are engine functions (./engineEffects.js, ./engineLifecycle.js …), run here on the same
 *     dependency lists React runs them on — a state change schedules one flush (like a React render), the flush
 *     rewires and runs every effect whose dependencies changed, in the Player's order, cleanup first.
 * What it does not have is the editor: no selection, overlays, World view or cached playback. A render cache
 * controller (../renderCacheController.js) can be attached to MEASURE playback — the seconds that play too slowly, the
 * engine page's red line — but nothing is rendered ahead or played from a cache.
 *
 *   const me = await createMotionEngine({ canvas });            // backend: 'webgl' | 'webgpu' (default: the app's pick)
 *   me.setProject({ channels, clips, videoWidth, videoHeight, background, markers, textVariables, projectFps });
 *   me.seek(1.5); me.play(); me.pause(); me.setLoop(true);
 *   me.setRenderCache(controller);                              // measure playback: controller.recordSample per paint
 *   const png = await me.captureFrameAtTime(2);                 // a data URL, as the editor's still capture
 *   const out = await me.exportVideo('mp4', onProgress, signal, 30);
 *   const off = me.on('time', (t) => …);                        // 'time' | 'play' | 'ready' | 'error'
 *   me.dispose();
 */
import { createEngineState } from './engineState';
import { wireEngine, syncEngineFields, ENV_DEPS } from './driverWiring';
import { mountEngine, resizeEngine, disposeEngine } from './engineLifecycle';
import { setEngineBackground } from './background';
import { pruneSequenceStates } from './channelStates';
import {
  deriveBackgroundUrls, deriveClipsMap, deriveLayoutMap, deriveMotionImageUrls, deriveParentIndex,
  deriveShapeBackgroundUrls, deriveTextFontLoadRequest, deriveTransitionSoundCues,
} from './projectDerive';
import { CAMERA_FOV, getPerspectiveDistance } from './compositeHelpers';
import { activateMaterialBackendForRenderer, initMaterialBackend } from '../materialFactory';
import { activateVideoRenderer, resolveVideoRenderer, selectedBackend } from '../videoRenderer';
import { DEFAULT_PREVIEW_FPS } from '../previewDeviceTier.js';
import { DEFAULT_MOTION_BLUR_SHUTTER } from '../motionBlurLevels';
import { DEFAULT_TEXTURE_QUALITY, sanitizeTextureQuality } from '../rasterDensity';
import { PREVIEW_MAX_LONG_EDGE } from '../videoSizePresets';

// The Player's own values, mirrored (tests/engine-extraction/driver_mirror.test.mjs fails when the Player's lines change).
const SCRUB_SETTLE_MS = 180;
const DEFAULT_W = 1280;
const DEFAULT_H = 720;

// The project / option fields setProject accepts, with the Player's prop defaults.
const DEFAULTS = {
  channels: [], clips: [], videoWidth: DEFAULT_W, videoHeight: DEFAULT_H, projectFps: 30, previewFps: DEFAULT_PREVIEW_FPS,
  previewQuality: 'full', background: null, markers: [], textVariables: [], timecodeFps: null,
  soundEnabled: false, forceMuteAudio: false, motionBlurEnabled: false, motionBlurShutter: DEFAULT_MOTION_BLUR_SHUTTER,
  textureQuality: DEFAULT_TEXTURE_QUALITY, outputSize: null,
};

export async function createMotionEngine({ canvas, backend = null } = {}) {
  if (!canvas) throw new Error('createMotionEngine: a canvas is required');
  const engine = createEngineState();
  engine.canvas = canvas;
  // the fields the Player starts from its props / state (`useRef(prop)`); the rest of those are set by
  // syncEngineFields on every flush. driver_mirror.test.mjs lists the Player's and fails on a new one.
  Object.assign(engine, {
    videoSize: { w: DEFAULT_W, h: DEFAULT_H }, previewRenderSize: { w: DEFAULT_W, h: DEFAULT_H },
    currentTime: 0, committedTime: 0, selectedItemId: null,
    placeholderEnv: { markers: [], textVariables: [], fps: 30 },
  });
  // code moved out of the Player sometimes hands a REF itself to a helper (`ensureTextTexture(cacheRef, …)`); with no
  // Player there are no refs, so each field gets one stable `{ current }` view onto the engine's own value
  const refViews = new Map();
  engine.refObjects = new Proxy({}, {
    get(_, key) {
      if (typeof key !== 'string') return undefined;
      if (!refViews.has(key)) {
        refViews.set(key, Object.defineProperty({}, 'current', {
          get: () => engine[key], set: (value) => { engine[key] = value; }, enumerable: true,
        }));
      }
      return refViews.get(key);
    },
  });
  const listeners = new Map();
  const emit = (type, payload) => {
    for (const fn of listeners.get(type) || []) { try { fn(payload); } catch (err) { console.error(err); } }
  };
  // the editor's props and state, as plain fields
  const s = {
    ...DEFAULTS, currentTime: 0, isPlaying: false, loop: false, fontLoadVersion: 0, transitionRegistryRevision: 0,
    pipelineRevision: 0, rendererError: null, renderCache: null,
  };
  let disposed = false;
  let scheduled = false;
  let wired = null;
  const effectState = new Map();   // name → { deps, cleanup }

  // ── the derived data, memoized on its inputs exactly as the Player's useMemos are ──
  const memos = new Map();
  const memo = (key, deps, fn) => {
    const m = memos.get(key);
    if (m && m.deps.length === deps.length && m.deps.every((d, i) => Object.is(d, deps[i]))) return m.value;
    const value = fn();
    memos.set(key, { deps, value });
    return value;
  };
  const set = (patch) => {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      const next = typeof v === 'function' ? v(s[k]) : v;   // a React-style updater, as the engine's setters get
      if (!Object.is(s[k], next)) { s[k] = next; changed = true; }
    }
    if (changed) schedule();
  };
  const setters = {
    setCurrentTime: (t) => { set({ currentTime: t }); emit('time', s.currentTime); },
    setPlayheadTime: () => {},
    setIsPlaying: (p) => { set({ isPlaying: p }); emit('play', s.isPlaying); },
    setFontLoadVersion: (n) => set({ fontLoadVersion: n }),
    setMaterialsReady: () => {},
    setRendererError: (e) => { s.rendererError = e; if (e) emit('error', e); },
    setRendererErrorDetail: () => {},
    setTransitionRegistryRevision: (n) => set({ transitionRegistryRevision: n }),
    setWorldViewActive: async () => {},   // the World view is the editor's
  };

  function values() {
    const clipsMap = memo('clipsMap', [s.clips], () => deriveClipsMap({ clips: s.clips }));
    const layoutMap = memo('layoutMap', [s.channels], () => deriveLayoutMap({ channels: s.channels }));
    const { channels, videoWidth, videoHeight, background, isPlaying, previewQuality } = s;
    // the Player: interactivePreviewEnabled = previewQuality === 'auto' && isPlaying, and the render size
    const interactivePreviewEnabled = previewQuality === 'auto' && isPlaying;
    const capScale = previewQuality === 'full' ? 1 : Math.min(1, PREVIEW_MAX_LONG_EDGE / Math.max(1, videoWidth, videoHeight));
    const renderScale = (interactivePreviewEnabled ? 0.75 : 1) * capScale;
    return {
      ...s, ...setters, SCRUB_SETTLE_MS, interactivePreviewEnabled,
      materialsReady: true, motionPathEditItemId: null, rotoPreview: null, selectedLightId: null,
      // a render cache only measures here (frameRender.js: renderCache.recordSample while playing); nothing is cached,
      // so the Player's own rcStop / rcFrameTexture stop nothing and return null (draw live)
      renderCache: s.renderCache, rcFrameTexture: () => null, rcStop: () => {},
      renderWidth: Math.max(320, Math.round(videoWidth * renderScale)),
      renderHeight: Math.max(180, Math.round(videoHeight * renderScale)),
      adaptiveRasterMode: sanitizeTextureQuality(s.textureQuality),
      clipsMap, layoutMap,
      transitionSoundCues: memo('cues', [channels, clipsMap, layoutMap, s.transitionRegistryRevision],
        () => deriveTransitionSoundCues({ channels, clipsMap, layoutMap, transitionRegistryRevision: s.transitionRegistryRevision })),
      parentIndex: memo('parentIndex', [channels, layoutMap, clipsMap], () => deriveParentIndex({ channels, layoutMap, clipsMap })),
      textFontLoadRequest: memo('fonts', [channels, clipsMap], () => deriveTextFontLoadRequest({ channels, clipsMap })),
      motionImageUrls: memo('motionImages', [channels, clipsMap], () => deriveMotionImageUrls({ channels, clipsMap })),
      backgroundUrls: memo('bgUrls', [background, videoWidth, videoHeight], () => deriveBackgroundUrls({ background, videoWidth, videoHeight })),
      shapeBackgroundUrls: memo('shapeBgUrls', [channels, clipsMap, videoHeight, videoWidth],
        () => deriveShapeBackgroundUrls({ channels, clipsMap, videoHeight, videoWidth })),
    };
  }

  // ── the effects, in the Player's order, each on the Player's dependency list ──
  const read = (v, path) => path.split(/\?\.|\./).reduce((o, k) => (o == null ? o : o[k]), v);
  const envDeps = (env) => (v) => (ENV_DEPS[env] || []).map((d) => read(v, d));
  const EFFECTS = [
    ['applyTextureQuality', envDeps('applyTextureQualityEnv'), (h) => h.applyTextureQuality()],
    ['repaintOnMockupSvg', () => [], (h) => h.repaintOnMockupSvg()],
    ['repaintOnMotionTemplates', () => [], (h) => h.repaintOnMotionTemplates()],
    ['repaintOnDepthTextures', () => [], (h) => h.repaintOnDepthTextures()],
    ['repaintOnModelAssets', () => [], (h) => h.repaintOnModelAssets()],
    ['repaintOnInlineTextEdit', () => [], (h) => h.repaintOnInlineTextEdit()],
    ['pruneTransitionPackages', envDeps('pruneTransitionPackagesEnv'), (h) => h.pruneTransitionPackages()],
    ['watchTransitionPackages', envDeps('watchTransitionPackagesEnv'), (h) => h.watchTransitionPackages()],
    ['watchEffectPackages', () => [], (h) => h.watchEffectPackages()],
    ['loadTextFonts', envDeps('loadTextFontsEnv'), (h) => h.loadTextFonts()],
    ['repaintOnImagePlates', () => [], (h) => h.repaintOnImagePlates()],
    ['loadMotionImages', envDeps('loadMotionImagesEnv'), (h) => h.loadMotionImages()],
    ['repaintOnMotionMediaFrames', () => [], (h) => h.repaintOnMotionMediaFrames()],
    ['repaintOnAnimatedImageFrames', () => [], (h) => h.repaintOnAnimatedImageFrames()],
    ['repaintOnBakes', () => [], (h) => h.repaintOnBakes()],
    ['pruneSequenceStates', (v) => [v.channels, v.clipsMap], (h, v) => { pruneSequenceStates(engine, v.channels, v.clipsMap); }],
    ['pruneParticleRuntimes', envDeps('pruneParticleRuntimesEnv'), (h) => h.pruneParticleRuntimes()],
    ['pruneModelLayers', envDeps('pruneModelLayersEnv'), (h) => h.pruneModelLayers()],
    ['followCurrentTime', envDeps('followCurrentTimeEnv'), (h) => h.followCurrentTime()],
    ['repaintOnHtmlLiveFrames', () => [], (h) => h.repaintOnHtmlLiveFrames()],
    ['mount', (v) => [v.pipelineRevision], () => mount()],
    ['resize', (v) => [v.videoWidth, v.videoHeight, v.renderWidth, v.renderHeight, v.pipelineRevision], (h, v) => {
      if (!resizeEngine(engine, v.videoWidth, v.videoHeight, v.renderWidth, v.renderHeight)) return;
      engine.renderFrame();
    }],
    ['placeholders', (v) => [v.timecodeFps || v.projectFps, JSON.stringify(v.textVariables || []),
      (v.markers || []).map((m) => `${m.time}:${m.name || ''}`).join(',')], (h, v) => {
      engine.placeholderEnv = { markers: v.markers, textVariables: v.textVariables, fps: v.timecodeFps || v.projectFps };
      engine.renderFrame?.();
    }],
    ['background', (v) => [v.background, v.videoWidth, v.videoHeight, v.pipelineRevision], (h, v) => setEngineBackground(engine,
      v.background, { width: v.videoWidth, height: v.videoHeight, onPaint: () => engine.renderFrame?.() })],
    ['runPlaybackLoop', envDeps('runPlaybackLoopEnv'), (h) => h.runPlaybackLoop()],
    ['repaintWhenPaused', (v) => [v.currentTime, v.isPlaying, v.channels, v.clips], (h, v) => { if (!v.isPlaying) engine.renderFrame(); }],
    ['repaintOnFonts', (v) => [v.fontLoadVersion, v.isPlaying], (h, v) => { if (!v.isPlaying) engine.renderFrame(); }],
    ['pollVideoReadiness', envDeps('pollVideoReadinessEnv'), (h) => h.pollVideoReadiness()],
  ];

  function mount() {
    const { w, h } = engine.videoSize || { w: s.videoWidth, h: s.videoHeight };
    mountEngine(engine, {
      canvas, backend: chosen, width: w, height: h, fov: CAMERA_FOV, distance: getPerspectiveDistance(h),
      onReady: () => { s.rendererError = null; emit('ready'); engine.renderFrame?.(); },
      onError: (err) => { s.rendererError = err?.userMessage || String(err?.message || err); emit('error', s.rendererError); },
      onContextLost: wired.h.handleContextLost,
      onContextRestored: wired.h.handleContextRestored,
      onDeviceLost: (info) => {
        emit('error', `The graphics device was reset (${info?.message || info?.reason || 'unknown'}) — rebuilding`);
        set({ pipelineRevision: s.pipelineRevision + 1 });
      },
      beforeListen: () => engine.model3d?.handleModelContextRestored?.(),
    });
    return () => disposeEngine(engine);
  }

  function flush() {
    scheduled = false;
    if (disposed) return;
    const v = values();
    wired = wireEngine(engine, v);
    syncEngineFields(engine, wired.h, v);
    engine.renderFrame = wired.h.renderFrame;
    for (const [name, depsOf, run] of EFFECTS) {
      const deps = depsOf(v);
      const prev = effectState.get(name);
      if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => Object.is(d, deps[i]))) continue;
      if (typeof prev?.cleanup === 'function') { try { prev.cleanup(); } catch (err) { console.error(err); } }
      let cleanup;
      try { cleanup = run(wired.h, v); } catch (err) { console.error(`[motion-engine] ${name}:`, err); }
      effectState.set(name, { deps, cleanup });
    }
  }
  function schedule() {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(flush);
  }

  // the backend, activated the way the editor's renderer session does (useVideoRendererSession), then the node-material
  // modules land before the first build (the Player's materialsReady)
  const chosen = backend ? resolveVideoRenderer(backend) : selectedBackend();
  activateVideoRenderer(chosen);
  activateMaterialBackendForRenderer(chosen);
  await initMaterialBackend();
  flush();

  return {
    engine,
    setProject(project = {}) {
      const patch = {};
      for (const k of Object.keys(DEFAULTS)) if (k in project) patch[k] = project[k] ?? DEFAULTS[k];
      set(patch);
      return new Promise((resolve) => queueMicrotask(resolve));
    },
    seek(time) { set({ currentTime: Math.max(0, Number(time) || 0) }); emit('time', s.currentTime); },
    play() { setters.setIsPlaying(true); },
    pause() { setters.setIsPlaying(false); },
    setLoop(on) { set({ loop: !!on }); },
    setRenderCache(controller) { set({ renderCache: controller || null }); },
    get currentTime() { return s.currentTime; },
    get isPlaying() { return s.isPlaying; },
    get duration() { return wired?.h.getTotalDuration() || 0; },
    get error() { return s.rendererError; },
    captureFrameAtTime: (time, opts) => wired.h.captureFrameAtTimeImpl
      ? wired.h.captureFrameAtTimeImpl(time, opts) : Promise.reject(new Error('not ready')),
    exportVideo: (...args) => wired.h.exportVideoImpl(...args),
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [name] of [...EFFECTS].reverse()) {
        const st = effectState.get(name);
        if (typeof st?.cleanup === 'function') { try { st.cleanup(); } catch (err) { console.error(err); } }
      }
      effectState.clear();
      listeners.clear();
    },
  };
}
