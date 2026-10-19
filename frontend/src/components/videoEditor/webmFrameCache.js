// Fast export decode for WebM clips — a drop-in replacement for ClipDecoder.
//
// The WebCodecs fast path (webcodecsClipDecoder) is mp4box-based and only handles
// MP4. WebM has no `moov` box, so it falls back to seeking the <video> element once
// per exported frame — and VP8/VP9 re-decode from the nearest keyframe on EVERY
// seek, which is the ~10x export slowdown users hit with (alpha) WebM overlays.
//
// Instead we decode the clip LINEARLY exactly once: play the <video> through and
// capture each presented frame (requestVideoFrameCallback) by drawing it into a 2D
// canvas — drawImage preserves the alpha channel. Because export consumes a clip's
// frames in increasing time order, we only keep a small SLIDING WINDOW of recent /
// upcoming frames and pause playback whenever the buffer is full (flow control), so
// memory stays bounded even for 1080p60 clips (store-everything would be gigabytes).
//
// drawFrameAt(t) is O(1)-ish: it waits until a frame at/after t has been decoded,
// serves the newest frame <= t, and evicts everything before it. All waits are
// timeout-guarded so a stalled decode can never hang the export (worst case: a
// slightly stale frame). ensureReady() returns false when the clip can't be set up
// (no RVFC, autoplay blocked, load error) so the caller keeps its seek path — no
// regression, only a speedup for the common case.

const BUFFER_CAP = 40;        // max frames held (~1080p → ~330MB ceiling); pause playback when hit
const RESUME_AT = 28;         // resume playback once the window drains below this
const FRAME_WAIT_MS = 2500;   // per-wait timeout while awaiting the next decoded frame
const FORWARD_SEEK_GAP_S = 5; // forward jump beyond this → seek (vs realtime play-through)

export function isWebmUrl(url) {
  return typeof url === 'string' && /\.webm(\?|#|$)/i.test(url);
}

export class WebmFrameCache {
  constructor(url) {
    this.url = url;
    this.ready = false;
    this.failed = false;
    this.error = null;
    this.width = 0;
    this.height = 0;
    // Shared output surface the compositor samples (stable identity → the Player's
    // CanvasTexture cache keeps ONE texture instead of one per frame).
    this.canvas = typeof document !== 'undefined'
      ? document.createElement('canvas')
      : (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : null);
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;

    this._video = null;
    this._buffer = [];        // { ts, canvas } ascending by ts (the sliding window)
    this._ended = false;
    this._paused = false;     // flow-control pause (buffer full), not user pause
    this._armed = false;      // an RVFC callback is pending
    this._waiters = [];       // resolve fns woken when a new frame (or end) arrives
    this._lastServed = -1;
    this._buildPromise = null;
    this._closed = false;
  }

  ensureReady() {
    if (!this._buildPromise) {
      this._buildPromise = this._init().catch((e) => {
        this.failed = true;
        this.error = e?.message || String(e);
        return false;
      });
    }
    return this._buildPromise;
  }

  async _init() {
    if (typeof document === 'undefined') return false;
    const v = document.createElement('video');
    this._video = v;
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    v.src = this.url;

    await new Promise((resolve, reject) => {
      const ok = () => { cleanup(); resolve(); };
      const bad = () => { cleanup(); reject(new Error('load error')); };
      const cleanup = () => {
        clearTimeout(timer);
        v.removeEventListener('loadedmetadata', ok);
        v.removeEventListener('error', bad);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('metadata timeout')); }, 15000);
      v.addEventListener('loadedmetadata', ok, { once: true });
      v.addEventListener('error', bad, { once: true });
      v.load();
    });

    if (!v.videoWidth || !v.videoHeight) return false;
    if (typeof v.requestVideoFrameCallback !== 'function') return false;

    this.width = v.videoWidth;
    this.height = v.videoHeight;
    this.canvas.width = this.width;
    this.canvas.height = this.height;

    v.addEventListener('ended', () => { this._ended = true; this._wake(); }, { once: true });
    this._arm();
    try { await v.play(); } catch { return false; } // muted autoplay is normally allowed
    // Wait for the very first decoded frame so the first drawFrameAt has something.
    await this._waitForFrameAfter(-1);
    this.ready = this._buffer.length > 0;
    return this.ready;
  }

  _arm() {
    const v = this._video;
    if (!v || this._armed || this._ended || this._closed) return;
    this._armed = true;
    v.requestVideoFrameCallback((_now, meta) => {
      this._armed = false;
      if (this._closed) return;
      const ts = typeof meta?.mediaTime === 'number' ? meta.mediaTime : v.currentTime;
      const c = document.createElement('canvas');
      c.width = this.width;
      c.height = this.height;
      const cx = c.getContext('2d');
      cx.clearRect(0, 0, this.width, this.height); // transparent base → keep alpha
      try { cx.drawImage(v, 0, 0, this.width, this.height); } catch { /* not ready */ }
      this._buffer.push({ ts, canvas: c });
      // Flow control: stop decoding ahead once the window is full; drawFrameAt
      // resumes once it drains. Keeps memory bounded when export < realtime.
      if (this._buffer.length >= BUFFER_CAP && !this._paused) {
        this._paused = true;
        try { v.pause(); } catch { /* ignore */ }
      }
      this._wake();
      this._arm(); // re-arm for the next presented frame (fires after resume if paused)
    });
  }

  _wake() {
    const list = this._waiters;
    this._waiters = [];
    for (const r of list) r();
  }

  _latestTs() {
    return this._buffer.length ? this._buffer[this._buffer.length - 1].ts : -Infinity;
  }

  // Resolve when a frame with ts >= t exists, the video ended, or a timeout fires.
  _waitForFrameAfter(t) {
    if (this._latestTs() >= t || this._ended || this._closed) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      this._waiters.push(fin);
      setTimeout(fin, FRAME_WAIT_MS);
    });
  }

  // Draw the frame for clip-local `targetSec` onto this.canvas (ClipDecoder API).
  async drawFrameAt(targetSec) {
    if (!this.ready || !this.ctx || this._closed) return;
    const t = Math.max(0, targetSec || 0);

    // Backward jump (reversed clip / speed ramp / loop): the window has already
    // moved past t. Re-seek the source and rebuild the window from there.
    if (this._buffer.length && t + 1e-3 < this._buffer[0].ts) {
      await this._resetTo(t);
    } else if (!this._ended && this._latestTs() + FORWARD_SEEK_GAP_S < t) {
      // Forward far-jump (partial render starting mid-clip, large trimStart, a
      // skip between items): playback advances in REAL TIME, so waiting for it to
      // reach t costs (t - latestTs) seconds of wall clock — deep entries trip the
      // exporter's per-frame watchdog. Seek instead. The gap gate keeps ordinary
      // consumption (≤ one frame's source step ahead) on the linear fast path,
      // since a per-frame VP8/VP9 seek re-decodes from the keyframe every time.
      await this._resetTo(t);
    }

    // Wait until playback has produced a frame at/after t (bounded by timeout).
    let guard = 0;
    while (this._latestTs() < t && !this._ended && !this._closed) {
      if (this._paused) this._resume();
      // eslint-disable-next-line no-await-in-loop
      await this._waitForFrameAfter(t);
      if (++guard > 400) break; // ~1000s worst case — never truly hang
    }

    const buf = this._buffer;
    if (!buf.length) return;
    // Newest frame with ts <= t (or the earliest available if all are ahead).
    let idx = 0;
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i].ts <= t + 1e-3) idx = i; else break;
    }
    const chosen = buf[idx];
    if (idx > 0) buf.splice(0, idx); // evict everything before the served frame
    this._lastServed = t;
    if (this._paused && this._buffer.length <= RESUME_AT) this._resume();

    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.drawImage(chosen.canvas, 0, 0, this.width, this.height);
  }

  _resume() {
    if (!this._paused || this._ended || this._closed) return;
    this._paused = false;
    try { this._video?.play?.(); } catch { /* ignore */ }
    this._arm();
  }

  async _resetTo(t) {
    const v = this._video;
    if (!v) return;
    this._paused = true;
    try { v.pause(); } catch { /* ignore */ }
    this._buffer = [];
    this._ended = false;
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); resolve(); };
      v.addEventListener('seeked', fin, { once: true });
      try { v.currentTime = Math.max(0, t); } catch { fin(); }
      setTimeout(fin, 3000);
    });
    this._resume();
    await this._waitForFrameAfter(t);
  }

  close() {
    this._closed = true;
    this._ended = true;
    this._wake();
    for (const f of this._buffer) { f.canvas.width = 0; f.canvas.height = 0; }
    this._buffer = [];
    this.ready = false;
    const v = this._video;
    if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ } this._video = null; }
  }
}
