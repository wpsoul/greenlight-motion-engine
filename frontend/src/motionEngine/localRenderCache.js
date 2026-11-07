// The render cache on a phone: the app's Smart cache (components/videoEditor/renderCacheController.js) with no server. The
// slow stretches are rendered here in the page, a few seconds at a time at the preview's size, once nothing happens for a
// moment; the page plays the files instead of compositing live. They stay in this browser and go with the page.
// A render takes over the preview's engine, so a still of the frame stands in for it meanwhile (begin / end).
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

export function localCacheDeps({ player, playhead, size, busy, begin, end }) {
  const jobs = new Map();
  const urls = new Set();
  let serial = 0;
  async function run(job, { rangeStart, rangeEnd, width, height, fps }) {
    try {
      const p = player();
      if (!p?.isWebCodecsSupported?.()) throw new Error('this browser cannot encode video');
      await begin(await p.captureFrameAtTime(playhead()), { w: width, h: height });
      await nextPaint();
      if (job.stop.signal.aborted) { job.status = 'cancelled'; return; }
      const res = await p.exportVideo('mp4', (v) => { job.progress = v; }, job.stop.signal, fps, null, null, { start: rangeStart, end: rangeEnd }, { previewCache: true });
      if (!res?.blob) throw new Error('the render produced no file');
      const url = URL.createObjectURL(res.blob);
      urls.add(url);
      job.result = { url };
      job.status = 'completed';
    } catch (e) {
      job.status = job.stop.signal.aborted ? 'cancelled' : 'failed';
      job.error = String(e?.message || e);
    } finally {
      end();
    }
  }
  return {
    save: async () => true,
    otherRenderActive: async () => busy(),
    createJob: async (body) => {
      serial += 1;
      const id = `local-${serial}`, job = { status: 'processing', progress: 0, stop: new AbortController() };
      jobs.set(id, job);
      run(job, body);
      return { id };
    },
    getJob: async (id) => jobs.get(id) || { status: 'failed', error: 'no such job' },
    cancelJob: async (id) => { jobs.get(id)?.stop.abort(); },
    getPlayhead: playhead,
    cacheSize: size,
    dispose: () => { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); },
  };
}

// The status beside the time: what the line over the ruler says, in words. null: nothing to say.
export function cacheStatus(snap) {
  const seconds = (state) => (snap?.runs || []).filter((r) => r.state === state).reduce((n, r) => n + r.t1 - r.t0, 0);
  const slow = seconds('slow'), pending = seconds('pending'), cached = seconds('cached');
  if (snap?.job || pending > 0) {
    const all = slow + pending + cached;
    return { state: 'pending', text: `Caching ${all > 0 ? Math.round(((cached + pending * (snap.job?.progress || 0)) / all) * 100) : 0}%` };
  }
  if (slow > 0) return { state: 'slow', text: 'Too slow' };
  return cached > 0 ? { state: 'cached', text: 'Cached' } : null;
}
