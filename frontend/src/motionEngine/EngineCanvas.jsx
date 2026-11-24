/*
 * EngineCanvas — the motion engine on a canvas, for the engine bundle's pages (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md,
 * Stage 9 step 28e5). It takes the props the editor's <Player> took from these pages (channels, clips, the play state
 * and time with their setters, size, background, sound, motion blur, markers, text variables, timecode fps) and its ref
 * gives the same `exportVideo` / `captureFrameAtTime` / `isWebCodecsSupported` — but underneath is createMotionEngine
 * (videoEditor/engine/motionEngine.js), the React-free driver, so the bundle carries the engine without the editor.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createMotionEngine } from '../components/videoEditor/engine/motionEngine';
import { isWebCodecsSupported } from '../components/videoEditor/videoExporter';
import { substituteHtmlClips } from '../components/videoEditor/htmlClips';
import { htmlPageVersions } from './htmlPages';

// (smallfix) A commit that never comes (a page that stopped rendering) does not hold a still forever: past this it goes on.
const SETTLE_CAP_MS = 5000;
const twoPaints = () => new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))); });

/** (smallfix) renderWarmup's `settle` for a page that holds an EngineCanvas (`getHandle()` its ref): the handle's settle(), capped;
 *  two paints, as before, while there is no handle yet. With it a still or a render waits for what its capture needs, not four
 *  fixed paints (~130 ms), as the app's render page has since framestep (renderSettle.js). */
export const engineSettle = (getHandle) => () => {
  const handle = getHandle();
  if (!handle?.settle) return twoPaints();
  let timer = 0;
  return Promise.race([handle.settle(), new Promise((resolve) => { timer = setTimeout(resolve, SETTLE_CAP_MS); })]).finally(() => clearTimeout(timer));
};

export const EngineCanvas = forwardRef(function EngineCanvas(props, ref) {
  const {
    channels, clips, isPlaying = false, setIsPlaying, currentTime = 0, setCurrentTime,
    soundEnabled = false, forceMuteAudio = false, videoWidth, videoHeight, outputSize = null,
    previewQuality = 'full', motionBlurEnabled = false, motionBlurShutter, textureQuality,
    background = null, markers = [], textVariables = [], timecodeFps = null, backend = null, renderCache = null, onState = null,
  } = props;
  const canvasRef = useRef(null);
  const [engine, setEngine] = useState(null);
  const [ready, setReady] = useState(false);   // the engine is up AND has had the project once: the ref is usable
  // (smallfix) the ref's settle(): every update React has scheduled committed (this component's tick batches with them) and the
  // project they hand the engine applied (the last setProject's promise), what a still or a render waits for instead of fixed paints
  const [settleTick, setSettleTick] = useState(0);
  const settleWaiters = useRef([]);
  const applied = useRef(Promise.resolve());
  const [error, setError] = useState(null);
  const [loadError, setLoadError] = useState(null);   // (0.5.5) the project's load failed: the ref stays null, the page says why
  // the latest setters, read by the engine's events
  const setters = useRef({ setIsPlaying, setCurrentTime });
  setters.current = { setIsPlaying, setCurrentTime };

  useEffect(() => {
    let me = null;
    let alive = true;
    const offs = [];
    createMotionEngine({ canvas: canvasRef.current, backend }).then((m) => {
      if (!alive) { m.dispose(); return; }
      me = m;
      offs.push(m.on('play', (p) => setters.current.setIsPlaying?.(p)));
      offs.push(m.on('time', (t) => setters.current.setCurrentTime?.(t)));
      offs.push(m.on('error', (e) => setError(String(e?.message || e))));
      setEngine(m);
    }).catch((err) => setError(String(err?.message || err)));
    return () => {
      alive = false;
      for (const off of offs) off();
      me?.dispose();
    };
  }, [backend]);

  // The app's html clips (a Video Editor project opened in the engine: a review card's source) go in as the editor's
  // Player gets them (htmlClips.js): a baked one plays its bake, and every one draws its page live where the browser
  // has HTML-in-canvas (htmlLive.js: the desktop app, Chrome 157+) — handed over as 'html' they were never drawn. Outside
  // the app a clip with no bake is drawn live from the project's own files (htmlPages.js; its version here, so a changed
  // page reloads) and one with a bake plays it. The same arrays come back for a project without html clips.
  const played = useMemo(() => substituteHtmlClips(channels || [], clips || [], { shas: htmlPageVersions() }), [channels, clips]);

  // the project and options, exactly as the Player received them
  useEffect(() => {
    if (!engine) return;
    applied.current = engine.setProject({
      channels: played.channels, clips: played.clips, videoWidth, videoHeight, outputSize, previewQuality, soundEnabled,
      forceMuteAudio, motionBlurEnabled, background, markers, textVariables, timecodeFps,
      ...(motionBlurShutter != null ? { motionBlurShutter } : {}), ...(textureQuality != null ? { textureQuality } : {}),
    }).then(() => { setLoadError(null); setReady(true); }, (e) => setLoadError(String(e?.message || e)));
  }, [engine, played, videoWidth, videoHeight, outputSize, previewQuality, soundEnabled, forceMuteAudio,
    motionBlurEnabled, motionBlurShutter, textureQuality, background, markers, textVariables, timecodeFps]);

  // a render cache controller that measures playback (the page's red line), or none
  useEffect(() => { engine?.setRenderCache(renderCache); }, [engine, renderCache]);

  // the play state and the time follow the page (the engine reports its own changes through 'play' / 'time')
  useEffect(() => {
    if (!engine) return;
    if (isPlaying && !engine.isPlaying) engine.play();
    if (!isPlaying && engine.isPlaying) engine.pause();
  }, [engine, isPlaying]);
  useEffect(() => {
    if (engine && Math.abs(engine.currentTime - currentTime) > 1e-6) engine.seek(currentTime);
  }, [engine, currentTime]);

  // (smallfix) after the project's effect above in the same commit: the settle waiters see the setProject it started
  useEffect(() => {
    if (!settleWaiters.current.length) return;
    const done = applied.current;
    for (const resolve of settleWaiters.current.splice(0)) done.then(resolve, resolve);
  }, [settleTick]);

  // null until the engine is ready (callers wait for the ref, as they waited for the Player's)
  useImperativeHandle(ref, () => (engine && ready ? {
    exportVideo: (...args) => engine.exportVideo(...args),
    captureFrameAtTime: (time, opts) => engine.captureFrameAtTime(time, opts),
    isWebCodecsSupported,
    settle: () => new Promise((resolve) => { settleWaiters.current.push(resolve); setSettleTick((t) => t + 1); }),
    engine,
  } : null), [engine, ready]);
  // (0.5.5) the page learns when the ref holds a handle (after the commit that set it) or why it never will: its renders wait for
  // the player instead of finding it null (pod-serve on a pod, 0.5.4: the page was ready before its player)
  const stateRef = useRef(onState);
  stateRef.current = onState;
  useEffect(() => { stateRef.current?.({ ready: !!(engine && ready), error: error || loadError }); }, [engine, ready, error, loadError]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#000' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      {error ? <p role="alert" style={{ position: 'absolute', inset: 'auto 12px 12px', margin: 0, color: '#fff', font: '13px/1.4 system-ui' }}>{error}</p> : null}
    </div>
  );
});
