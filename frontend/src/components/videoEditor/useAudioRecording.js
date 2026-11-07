import { useCallback, useEffect, useRef, useState } from 'react';

// Pick the first MediaRecorder mime type the browser supports, with a sane extension.
function pickRecordingFormat() {
  const candidates = [
    { mime: 'audio/mp4', ext: 'm4a' },
    { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
    { mime: 'audio/webm;codecs=opus', ext: 'webm' },
    { mime: 'audio/webm', ext: 'webm' },
  ];
  const supported = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported;
  for (const c of candidates) {
    if (!supported || MediaRecorder.isTypeSupported(c.mime)) return c;
  }
  return { mime: '', ext: 'webm' };
}

/**
 * Mic recording hook, shared by the video editor and GenerationInputPopover.
 *
 * @param {object} opts
 * @param {(blob: Blob, ext: string) => void} [opts.onStopped] called (async) once the
 *        finished blob is available, after MediaRecorder fires `stop`.
 *
 * @returns {{
 *   recording: boolean,                      // true from start to stop, paused included
 *   paused: boolean,
 *   recordSeconds: number,                   // time captured, pauses not counted
 *   recordError: string,
 *   startRecording: () => Promise<boolean>,  // resolves true once mr.start() ran
 *   pauseRecording: () => boolean,           // the same take carries on after resumeRecording
 *   resumeRecording: () => boolean,
 *   stopRecording: () => void,
 *   reset: () => void,
 * }}
 */
export function useAudioRecording({ onStopped } = {}) {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [recordError, setRecordError] = useState('');

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const extRef = useRef('webm');
  // Time captured before the current run; a run ends at every pause.
  const capturedMsRef = useRef(0);
  const runStartedAtRef = useRef(0);
  // Keep the latest onStopped without re-creating startRecording.
  const onStoppedRef = useRef(onStopped);
  useEffect(() => { onStoppedRef.current = onStopped; }, [onStopped]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    runStartedAtRef.current = performance.now();
    timerRef.current = setInterval(() => {
      setRecordSeconds(Math.floor((capturedMsRef.current + performance.now() - runStartedAtRef.current) / 1000));
    }, 250);
  }, []);

  const startRecording = useCallback(async () => {
    setRecordError('');
    setRecordSeconds(0);
    capturedMsRef.current = 0;
    chunksRef.current = [];
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setRecordError("Recording isn't supported here.");
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const fmt = pickRecordingFormat();
      extRef.current = fmt.ext;
      const mr = fmt.mime ? new MediaRecorder(stream, { mimeType: fmt.mime }) : new MediaRecorder(stream);
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        onStoppedRef.current?.(blob, extRef.current);
      };
      mr.start();
      recorderRef.current = mr;
      setRecording(true);
      setPaused(false);
      startTimer();
      return true;
    } catch {
      setRecordError('Microphone access was denied or unavailable.');
      return false;
    }
  }, [startTimer]);

  const pauseRecording = useCallback(() => {
    const mr = recorderRef.current;
    if (mr?.state !== 'recording') return false;
    mr.pause();
    capturedMsRef.current += performance.now() - runStartedAtRef.current;
    clearTimer();
    setPaused(true);
    return true;
  }, [clearTimer]);

  const resumeRecording = useCallback(() => {
    const mr = recorderRef.current;
    if (mr?.state !== 'paused') return false;
    mr.resume();
    startTimer();
    setPaused(false);
    return true;
  }, [startTimer]);

  const stopRecording = useCallback(() => {
    clearTimer();
    setRecording(false);
    setPaused(false);
    try { recorderRef.current?.stop(); } catch { /* ignore */ }
  }, [clearTimer]);

  const reset = useCallback(() => {
    setRecordError('');
    setRecordSeconds(0);
  }, []);

  // Release the mic + timer if the consumer unmounts mid-recording.
  useEffect(() => {
    return () => {
      clearTimer();
      try { recorderRef.current?.state !== 'inactive' && recorderRef.current?.stop(); } catch { /* ignore */ }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [clearTimer]);

  return { recording, paused, recordSeconds, recordError, startRecording, pauseRecording, resumeRecording, stopRecording, reset };
}

export default useAudioRecording;
