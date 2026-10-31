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

export const EngineCanvas = forwardRef(function EngineCanvas(props, ref) {
  const {
    channels, clips, isPlaying = false, setIsPlaying, currentTime = 0, setCurrentTime,
    soundEnabled = false, forceMuteAudio = false, videoWidth, videoHeight, outputSize = null,
    previewQuality = 'full', motionBlurEnabled = false, motionBlurShutter, textureQuality,
    background = null, markers = [], textVariables = [], timecodeFps = null, backend = null, renderCache = null,
  } = props;
  const canvasRef = useRef(null);
  const [engine, setEngine] = useState(null);
  const [ready, setReady] = useState(false);   // the engine is up AND has had the project once: the ref is usable
  const [error, setError] = useState(null);
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
  // has HTML-in-canvas (htmlLive.js, the desktop app) — handed over as 'html' they were never drawn. The same arrays
  // come back for a project without html clips.
  const played = useMemo(() => substituteHtmlClips(channels || [], clips || []), [channels, clips]);

  // the project and options, exactly as the Player received them
  useEffect(() => {
    if (!engine) return;
    engine.setProject({
      channels: played.channels, clips: played.clips, videoWidth, videoHeight, outputSize, previewQuality, soundEnabled,
      forceMuteAudio, motionBlurEnabled, background, markers, textVariables, timecodeFps,
      ...(motionBlurShutter != null ? { motionBlurShutter } : {}), ...(textureQuality != null ? { textureQuality } : {}),
    }).then(() => setReady(true));
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

  // null until the engine is ready (callers wait for the ref, as they waited for the Player's)
  useImperativeHandle(ref, () => (engine && ready ? {
    exportVideo: (...args) => engine.exportVideo(...args),
    captureFrameAtTime: (time, opts) => engine.captureFrameAtTime(time, opts),
    isWebCodecsSupported,
    engine,
  } : null), [engine, ready]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#000' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      {error ? <p role="alert" style={{ position: 'absolute', inset: 'auto 12px 12px', margin: 0, color: '#fff', font: '13px/1.4 system-ui' }}>{error}</p> : null}
    </div>
  );
});
