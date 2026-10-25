/*
 * GreenLight Motion Engine — the engine entry (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Part 3 "Step 1 — wrap").
 *
 * Drives the motion engine without React's editor (engine/motionEngine.js createMotionEngine, through
 * ./EngineCanvas.jsx — Stage 9 step 28e5; it wrapped the editor's own Player until then) behind a small
 * imperative API, built as ONE classic script
 * (`npm run build:motion-engine` → motion-engine/dist/greenlight-motion.js) that a double-clicked
 * file:// page can load:
 *
 *   const engine = await GreenLightMotion.create(containerEl, { renderer: 'webgpu', assets });
 *   const { missing } = await engine.load(project, { assets }); // a NORMALIZED project (see below)
 *   const png = await engine.renderFrame(t); // PNG data URL of the frame at t seconds
 *   const { blob } = await engine.export({ format: 'mp4', fps: 30, onProgress });
 *   engine.missingAssets();                  // refs asked for and not provided (models, HDRs …)
 *   GreenLightMotion.pluginStatus();         // the page's plugin packages (assets/plugins/) and their proofs
 *   engine.dispose();
 *
 *   GreenLightMotion.mountPage(el, { project, assets, theme }); // the viewer's page: preview, layers, options, Render (PlayerPage.jsx)
 *   GreenLightMotion.mountStudio(el, { project, sources, config }); // that page with the review interface (studio/)
 *
 * Also an ES module (motion-engine/dist/greenlight-motion.mjs) exporting `create` and `version`.
 *
 * `project` = a saved GreenLight Dash project's data, or one an agent wrote ({ channels, clips,
 * videoSize, background?, template? … } — any subset): the editor's own normalizeEditorState
 * (videoEditor/editorState.js) fills and sanitizes the rest, see ./normalize.js.
 * `assets` (map or function, see ./assets.js) supplies every file the project or the engine
 * refers to — `/media/…`, `/hdr/…`, `asset:…`, the model presets; a file:// page cannot read
 * local files itself.
 */
import { createRoot } from 'react-dom/client';
import { EngineCanvas } from './EngineCanvas';
import { activateVideoRenderer } from '../components/videoEditor/videoRenderer';
import { activateMaterialBackendForRenderer } from '../components/videoEditor/materialFactory';
import { installGpuResetWatch } from '../components/videoEditor/gpuReset';
import { waitForMediaReady } from '../components/videoEditor/renderWarmup';
import { PlayerPage } from './PlayerPage';
import { toEngineProject } from './normalize';
import { checkSoundCues } from './soundCues';
import { traceProject } from './trace';
import { SOUNDS } from './sfx';
import { checkTemplate } from './template';
import { installFetchLayer, createResolver, setActiveResolver, resolveProject, missingAssets, clearMissingAssets, pluginStatus } from './assets';
// the shared review interface (left rail, inspector, Edit · Notes · Highlight) every host mounts: studio/index.js
import { mountStudio } from './studio';

// the package version, put in at build time (vite.motion-engine.config.js); 'dev' when built some other way
const VERSION = typeof __GLM_VERSION__ === 'string' ? __GLM_VERSION__ : 'dev';
const noop = () => {};

installGpuResetWatch();
installFetchLayer();

function EngineView({ project, playerRef }) {
  const size = project.videoSize || { w: 1920, h: 1080 };
  return (
    <div style={{ width: size.w, height: size.h, background: '#000' }}>
      <EngineCanvas
        ref={playerRef}
        channels={project.channels || []}
        clips={project.clips || []}
        isPlaying={false}
        setIsPlaying={noop}
        currentTime={0}
        playheadTime={0}
        setCurrentTime={noop}
        setPlayheadTime={noop}
        soundEnabled={false}
        forceMuteAudio={false}
        videoWidth={size.w}
        videoHeight={size.h}
        outputSize={null}
        previewQuality="full"
        motionBlurEnabled={project.motionBlurEnabled === true}
        background={project.background || null}
        markers={project.markers || []}
        textVariables={project.textVariables || []}
        timecodeFps={project.fps || 30}
      />
    </div>
  );
}

const waitFor = async (test, timeoutMs, label) => {
  const until = performance.now() + timeoutMs;
  while (!test()) {
    if (performance.now() > until) throw new Error(`GreenLightMotion: timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 30));
  }
};

async function create(container, { renderer = 'webgpu', assets = null } = {}) {
  if (!container) throw new Error('GreenLightMotion.create needs a container element');
  if (renderer === 'webgpu' && !navigator.gpu) throw new Error('This browser has no WebGPU');
  activateVideoRenderer(renderer);
  activateMaterialBackendForRenderer(renderer);
  const root = createRoot(container);
  const playerRef = { current: null };
  let disposed = false;
  let resolver = createResolver(assets);
  setActiveResolver(resolver);
  let current = null;
  // Media warmed, fonts ready, 3D layers primed — the render page's own gate (renderWarmup.js).
  const warmUp = (range) => waitForMediaReady({
    channels: current?.channels || [], clips: current?.clips || [], getPlayer: () => playerRef.current, range,
  });

  const player = () => {
    if (disposed) throw new Error('GreenLightMotion: disposed');
    if (!playerRef.current) throw new Error('GreenLightMotion: load a project first');
    return playerRef.current;
  };

  return {
    version: VERSION,
    async load(project, { assets: loadAssets } = {}) {
      if (!project || typeof project !== 'object') throw new Error('GreenLightMotion.load needs a project');
      if (loadAssets) {
        resolver.dispose();
        resolver = createResolver(loadAssets);
        setActiveResolver(resolver);
      }
      clearMissingAssets();
      const normalized = await toEngineProject(project);
      const resolved = await resolveProject(normalized, resolver);
      current = resolved;
      root.render(<EngineView project={resolved} playerRef={playerRef} />);
      await waitFor(() => playerRef.current, 10000, 'the player');
      return { missing: missingAssets() };
    },
    missingAssets,
    async renderFrame(t, opts = {}) {
      const time = Math.max(0, Number(t) || 0);
      player();
      await warmUp({ start: time, end: time + 1e-3 });
      return player().captureFrameAtTime(time, opts);
    },
    isExportSupported() {
      try { return Boolean(player().isWebCodecsSupported?.()); } catch { return false; }
    },
    async export({ format = 'mp4', fps = 30, onProgress = noop, signal } = {}) {
      const p = player();
      if (!p.isWebCodecsSupported?.()) throw new Error('This browser cannot encode video (WebCodecs)');
      await warmUp(null);
      return p.exportVideo(format, onProgress, signal, fps);
    },
    dispose() {
      disposed = true;
      root.unmount();
      resolver.dispose();
      setActiveResolver(null);
    },
  };
}

/** The viewer's page in EL (WebGPU). theme: 'dark' (default), 'light' or 'auto' (follows the system).
 *  Returns { unmount }. */
function mountPage(el, { project, assets = null, theme = 'dark' } = {}) {
  if (!el) throw new Error('GreenLightMotion.mountPage needs an element');
  if (!project) throw new Error('GreenLightMotion.mountPage needs a project');
  activateVideoRenderer('webgpu');
  activateMaterialBackendForRenderer('webgpu');
  const root = createRoot(el);
  root.render(<PlayerPage project={project} assets={assets} theme={theme} />);
  return { unmount: () => root.unmount() };
}

window.GreenLightMotion = { create, mountPage, mountStudio, checkTemplate, checkSoundCues, sounds: SOUNDS, missingAssets, pluginStatus, normalize: toEngineProject, trace: async (project, opts) => traceProject(await toEngineProject(project), opts), version: VERSION };

export { create, mountPage, mountStudio, checkTemplate, checkSoundCues, SOUNDS as sounds, missingAssets, pluginStatus, toEngineProject as normalize, traceProject, VERSION as version };
