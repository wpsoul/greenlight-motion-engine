// Fast video-clip decode for export, using WebCodecs VideoDecoder instead of
// seeking an HTML <video> element frame-by-frame. Benchmarks (headless GPU
// Chromium) showed ~1,700-3,000 fps decode vs ~0.3 fps for <video> seeking.
//
// Split in two:
//  - ClipSource: fetches + demuxes one clip's MP4 (mp4box) once, holding the
//    sample table and decoder config. Shared per URL — the encoded bytes are
//    the heavy part and never need duplicating.
//  - ClipDecoder: one VideoDecoder + offscreen canvas per *consumer* (per
//    on-screen layer). Two layers showing the same file at different times
//    must NOT share a decoder: a VideoDecoder only moves forward, so alternating
//    two target times on one decoder forces a keyframe reset on every frame.
//
// Access per decoder is assumed mostly monotonic-forward (an export walks time
// forward); any jump re-enters at the nearest keyframe at/before the target.

import * as MP4Box from 'mp4box';

// Largest clip this decoder will take on. This used to be justified as a TIME
// budget — "~48MB/s from the local media server, so 1.2GB is ~25s of loading,
// comfortably inside the 60s first-frame budget" — and that justification was
// wrong on other machines. A Windows 11 field measurement put Chromium's own
// fetch at 30.3 MB/s for the identical request that curl served at 173 MB/s on
// the same box, which makes the same 1.2GB cap 39.6s, not 25s. A byte ceiling
// cannot express a time budget across hardware it was never measured on.
//
// So the two concerns are now separated. This one is a MEMORY ceiling: init()
// holds every encoded sample, and mp4box additionally retains the whole file
// until flush() when moov sits at the end, so peak resident is roughly 2x the
// file. Time is bounded by MAX_ACQUIRE_MS below, against the rate this transfer
// actually achieves rather than one assumed for it.
const MAX_DEMUX_BYTES = 1.2e9;

// How long a single source may take to ACQUIRE (download + demux) before the
// decoder gives up and lets the caller fall back. This is not a per-frame
// watchdog: acquisition now happens in the warm phase, before the frame loop,
// so it gets a budget of its own instead of being charged to frame 0.
//
// It is enforced against MEASURED throughput, not elapsed time alone: once
// enough of the file has arrived to estimate a rate, a transfer that cannot
// finish inside the budget is abandoned immediately rather than at the deadline,
// which is the difference between a useful error and four minutes of silence.
const MAX_ACQUIRE_MS = 300_000;
// A segment part is bounded by construction (RENDER_MAX_SEGMENT_BYTES, 300 MB),
// so it gets a much tighter budget than a whole file: a part that cannot be
// fetched in a minute is a real problem, not a large download.
const SEGMENT_ACQUIRE_MS = 60_000;
// Don't judge the rate off the first few packets — connection setup and the
// server's first read are not representative.
const RATE_ESTIMATE_MIN_MS = 4000;
const RATE_ESTIMATE_MIN_BYTES = 24 * 1024 * 1024;

/* The track's edit list (edts/elst) says which stretch of the stored samples is
   presented. `edits` is mp4box's `track.edits`; media_time is in the media
   timescale, segment_duration in the movie timescale, and media_time -1 marks
   an empty edit (a delay before the first image). Returns the first real edit,
   or null when the track has none.

   Most files carry one edit whose media_time equals the first frame's CTS
   (encoder delay), where the min-CTS origin below already lands. A trim saved
   without re-encoding (QuickTime/Photos "Trim" → "…-edited.mp4") keeps the
   GOP's earlier frames and starts its edit seconds into them. */
export function presentationEdit(edits, mediaTimescale = 1, movieTimescale = 1) {
  if (!Array.isArray(edits) || !edits.length) return null;
  const mediaScale = Math.max(1e-9, Number(mediaTimescale) || 1);
  const movieScale = Math.max(1e-9, Number(movieTimescale) || 1);
  let delayUs = 0;
  for (let i = 0; i < edits.length; i++) {
    const mediaTime = Number(edits[i].media_time);
    const segmentUs = ((Number(edits[i].segment_duration) || 0) * 1e6) / movieScale;
    if (!Number.isFinite(mediaTime)) return null;
    if (mediaTime < 0) { delayUs += segmentUs; continue; }
    return {
      mediaStartUs: Math.round((mediaTime * 1e6) / mediaScale),
      delayUs: Math.round(delayUs),
      durationUs: Math.round(segmentUs), // 0 = runs to the end of the media
      // Further real edits (a splice list) are not followed: only the first
      // presented stretch is mapped.
      followingEdits: edits.slice(i + 1).filter((e) => Number(e.media_time) >= 0).length,
    };
  }
  return null;
}

/* MP4 sample CTS values can begin above (or below) zero because of encoder
   delay/edit lists. HTMLVideoElement exposes the first presented image at the
   media timeline origin; WebCodecs preserves whatever timestamps we put on the
   chunks. Rebase the demuxed presentation clock so a requested source second
   addresses the same image in both playback paths.

   The origin is the earliest CTS, moved later when the edit list starts the
   presentation further in — <video> honours that edit, so ignoring it made an
   export show the hidden head of a trimmed shot. Like FFmpeg's mov demuxer
   (which <video> uses), the first frame STARTING at or after the edit is
   presented at 0; a frame that merely overlaps the edit start is dropped.
   Samples before the origin keep their (negative) timestamps: they are still
   needed to decode from the keyframe, and are never the frame chosen for t >= 0. */
export function normalizePresentationSamples(samples, timescale = 1, edit = null) {
  const scale = Math.max(1e-9, Number(timescale) || 1);
  const toUs = (ticks) => Math.round((ticks * 1e6) / scale);
  const list = Array.isArray(samples) ? samples : [];
  const ctsOf = list.map((sample) => Number(sample.cts));
  const mapped = list.map((sample) => ({
    type: sample.is_sync ? 'key' : 'delta',
    ts: 0,
    dur: toUs(Number(sample.duration) || 0),
    data: sample.data,
    isKey: !!sample.is_sync,
  }));
  let originUs = 0;
  let durationUs = 0;
  let editApplied = false;
  let presentedCount = 0;
  if (mapped.length) {
    // The origin is subtracted in TRACK TICKS, and only the difference is
    // rounded to microseconds. Rounding each CTS first and then subtracting a
    // rounded origin left some frames 1 µs late (a 60 fps file with a two-frame
    // encoder delay: frame 2 came out at 33334 µs, the export asked for 33333),
    // and the frame pick below rejected them — every third frame of the render
    // repeated the one before it.
    let originCts = ctsOf[0];
    for (let i = 1; i < ctsOf.length; i++) originCts = Math.min(originCts, ctsOf[i]);
    let delayUs = 0;
    if (edit) {
      let firstPresentedCts = Infinity;
      for (const cts of ctsOf) {
        if (toUs(cts) >= edit.mediaStartUs - 1 && cts < firstPresentedCts) firstPresentedCts = cts;
      }
      if (Number.isFinite(firstPresentedCts) && toUs(firstPresentedCts) - edit.delayUs > toUs(originCts)) {
        originCts = firstPresentedCts;
        delayUs = edit.delayUs;
        editApplied = true;
      }
    }
    originUs = toUs(originCts) - delayUs;
    for (let i = 0; i < mapped.length; i++) {
      const sample = mapped[i];
      sample.ts = toUs(ctsOf[i] - originCts) + delayUs;
      durationUs = Math.max(durationUs, sample.ts + Math.max(0, sample.dur));
    }
    if (editApplied && edit.durationUs > 0) {
      const editEndUs = edit.mediaStartUs + edit.durationUs - originUs;
      durationUs = Math.min(durationUs, Math.max(0, editEndUs));
    }
    for (const sample of mapped) {
      if (sample.ts + Math.max(0, sample.dur) > 0 && sample.ts < durationUs) presentedCount++;
    }
  }
  return { samples: mapped, originUs, durationUs, editApplied, presentedCount };
}

// A requested time and a sample timestamp are both whole microseconds rounded
// from fractions (1/60 s = 16666.67 µs), so they can disagree by 1 µs. A frame
// that close AFTER the target is that target's frame, not the next one.
export const FRAME_PICK_SLACK_US = 2;

// Pull the codec config record (avcC/hvcC/vpcC/av1C) out of the demuxed track so
// VideoDecoder can be configured. Standard mp4box + WebCodecs pattern.
function getDescription(mp4file, trackId) {
  const DS = MP4Box.DataStream;
  const trak = mp4file.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new DS(undefined, 0, DS.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8); // strip the 8-byte box header
    }
  }
  return null;
}

// Display rotation (0/90/180/270) from the track header matrix. Phone footage is
// often stored unrotated with the orientation only in tkhd; VideoDecoder outputs
// the unrotated buffers, so consumers that care must apply this themselves.
function getRotation(mp4file, trackId) {
  try {
    const m = mp4file.getTrackById(trackId)?.tkhd?.matrix;
    if (!m) return 0;
    const deg = Math.round((Math.atan2(m[1], m[0]) * 180) / Math.PI);
    return ((deg % 360) + 360) % 360;
  } catch {
    return 0;
  }
}

export class ClipSource {
  // Byte size of a clip without downloading it. Returns 0 when the server won't
  // say (no Content-Length, HEAD unsupported, network error) — unknown must mean
  // "proceed", or a quirky server would push every clip onto the slow path.
  static async probeSize(url, signal = null) {
    try {
      const resp = await fetch(url, { method: 'HEAD', cache: 'no-store', signal });
      if (!resp.ok) return 0;
      return Number(resp.headers.get('content-length')) || 0;
    } catch {
      return 0;
    }
  }

  constructor(url) {
    this.url = url;
    this.ready = false;
    this.failed = false;
    this.error = null;
    this.width = 0;
    this.height = 0;
    this.rotation = 0; // display rotation in degrees (0/90/180/270)

    this.samples = [];    // { type, ts(µs), dur(µs), data, isKey } in decode order
    this.keyIndices = []; // indices into samples where isKey (decode entry points)
    this.timescale = 1;
    this.presentationOriginUs = 0;
    this.presentationDurationUs = 0;
    // Samples whose image is presented — fewer than samples.length when an edit
    // list hides frames kept only for decoding. Use it for fps estimates.
    this.presentedSampleCount = 0;
    this.editListApplied = false;
    this.config = null;

    // Live acquisition state, readable while init() is still running. Without
    // this a stalled render could only say "a clip likely can't be decoded" —
    // which sent a competent bug reporter through days of container forensics on
    // a file that decodes perfectly, when the truth was "still downloading".
    this.phase = 'idle'; // idle | probing | downloading | demuxing | configuring | ready | failed
    this.loadedBytes = 0;
    this.totalBytes = 0;
    this.timings = { probeMs: 0, downloadMs: 0, demuxMs: 0, totalMs: 0 };
    // Which stage failed, for callers that must tell acquiring from decoding:
    // too_large | too_slow | fetch | demux | config | cancelled
    this.errorKind = null;
  }

  /** Human-readable acquisition state, e.g. "downloading (420 MB of 954 MB)". */
  describeProgress() {
    const name = (this.url || '').split('/').pop().split('?')[0];
    if (this.phase === 'downloading' && this.totalBytes > 0) {
      return `${name}: downloading (${(this.loadedBytes / 1e6).toFixed(0)} MB of `
        + `${(this.totalBytes / 1e6).toFixed(0)} MB)`;
    }
    if (this.phase === 'downloading') return `${name}: downloading (${(this.loadedBytes / 1e6).toFixed(0)} MB)`;
    return `${name}: ${this.phase}`;
  }

  /**
   * Fetch + demux this clip.
   *
   * @param {AbortSignal} [signal]
   * @param {object} [opts]
   * @param {Function} [opts.onProgress] — called with `this` as bytes arrive, so
   *   a caller can report "420 MB of 954 MB" instead of showing nothing.
   * @param {number} [opts.timeBudgetMs] — how long acquisition may take. Checked
   *   against the transfer's OWN measured rate, so a hopeless download is
   *   abandoned as soon as that is knowable rather than at the deadline.
   */
  async init(signal = null, opts = {}) {
    const { onProgress = null, timeBudgetMs = MAX_ACQUIRE_MS } = opts;
    const startedAt = (typeof performance !== 'undefined' ? performance : Date).now();
    const since = () => (typeof performance !== 'undefined' ? performance : Date).now() - startedAt;
    const report = () => { try { onProgress?.(this); } catch { /* reporting must never kill a load */ } };
    const fail = (kind, message) => {
      this.failed = true;
      this.phase = 'failed';
      this.errorKind = kind;
      this.error = message;
      this.timings.totalMs = Math.round(since());
      report();
      return false;
    };
    try {
      // This path buys its speed by demuxing the WHOLE file up front and holding
      // every sample in memory. That is a good trade at a few hundred MB and a
      // fatal one at multiple GB — see MAX_DEMUX_BYTES. Above the cap, decline
      // immediately so the caller drops to <video> seeking, which streams.
      this.phase = 'probing';
      report();
      const probeStart = since();
      const size = await ClipSource.probeSize(this.url, signal);
      this.timings.probeMs = Math.round(since() - probeStart);
      this.totalBytes = size;
      if (signal?.aborted) throw new Error('cancelled');
      if (size > MAX_DEMUX_BYTES) {
        return fail('too_large', `clip too large to demux (${(size / 1e9).toFixed(1)}GB > `
          + `${(MAX_DEMUX_BYTES / 1e9).toFixed(1)}GB cap)`);
      }

      const mp4 = MP4Box.createFile();
      const samples = [];
      let vtrack = null;
      const ready = new Promise((resolve, reject) => {
        mp4.onError = (e) => reject(new Error('mp4box: ' + e));
        mp4.onReady = (info) => {
          vtrack = (info.videoTracks || [])[0];
          if (!vtrack) { reject(new Error('no video track')); return; }
          mp4.setExtractionOptions(vtrack.id, null, { nbSamples: 1_000_000 });
          mp4.onSamples = (id, user, s) => { for (const x of s) samples.push(x); };
          mp4.start();
          resolve();
        };
      });

      // cache:'no-store' — Chromium may fail large responses with
      // net::ERR_CACHE_WRITE_FAILURE while writing them to the HTTP disk cache
      // (seen with a 308MB 4K clip in the headless export browser), which would
      // kick the export down to the ~0.3fps <video> seek fallback. Bypassing
      // the cache avoids the write entirely; retry once for transient errors.
      let resp;
      try {
        resp = await fetch(this.url, { cache: 'no-store', signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        resp = await fetch(this.url, { cache: 'no-store', signal });
      }
      if (!resp.ok) throw new Error('fetch ' + resp.status);

      // Stream the clip into mp4box in chunks rather than buffering the whole file.
      // A single ArrayBuffer can't exceed ~2GB in the browser, so resp.arrayBuffer()
      // throws ("Failed to fetch") on large clips — e.g. a 3.5GB 4K source — which
      // forced a fallback to ~0.3fps <video> seeking that stalls long exports.
      // Chunked append decodes the *original* at full resolution on the fast
      // WebCodecs path. (moov may live at EOF, so onReady can fire only after the
      // final chunk is appended — that's expected for non-faststart files.)
      this.phase = 'downloading';
      const downloadStart = since();
      report();
      if (resp.body?.getReader) {
        const reader = resp.body.getReader();
        const APPEND_BYTES = 16 * 1024 * 1024; // coalesce reads → fewer mp4box parse passes
        let offset = 0;
        let pending = [];
        let pendingLen = 0;
        let lastReportAt = 0;
        const flushPending = () => {
          if (!pendingLen) return;
          const merged = new Uint8Array(pendingLen);
          let p = 0;
          for (const part of pending) { merged.set(part, p); p += part.byteLength; }
          merged.buffer.fileStart = offset;
          offset += pendingLen;
          mp4.appendBuffer(merged.buffer);
          pending = [];
          pendingLen = 0;
        };
        for (;;) {
          if (signal?.aborted) throw new Error('cancelled');
          const { done, value } = await reader.read();
          if (done) break;
          pending.push(value);
          pendingLen += value.byteLength;
          this.loadedBytes += value.byteLength;
          const elapsed = since() - downloadStart;
          // Give up on a transfer that cannot finish in time, as soon as its own
          // rate says so. Waiting out the deadline wastes the budget AND loses
          // the measurement that explains why — which is exactly what made a
          // field failure unreadable: the render simply said the clip could not
          // be decoded, having never attempted to decode anything.
          if (timeBudgetMs > 0 && this.totalBytes > 0
              && elapsed >= RATE_ESTIMATE_MIN_MS && this.loadedBytes >= RATE_ESTIMATE_MIN_BYTES
              && this.loadedBytes < this.totalBytes) {
            const bytesPerMs = this.loadedBytes / elapsed;
            const projectedMs = this.totalBytes / bytesPerMs;
            if (projectedMs > timeBudgetMs) {
              try { await reader.cancel(); } catch { /* ignore */ }
              const rate = (bytesPerMs * 1000) / 1e6;
              const needed = (this.totalBytes / 1e6) / (timeBudgetMs / 1000);
              return fail('too_slow',
                `source is loading too slowly to render from directly — `
                + `${(this.loadedBytes / 1e6).toFixed(0)} MB of ${(this.totalBytes / 1e6).toFixed(0)} MB `
                + `in ${(elapsed / 1000).toFixed(0)}s (${rate.toFixed(1)} MB/s; this clip needs `
                + `${needed.toFixed(1)} MB/s to arrive inside the ${(timeBudgetMs / 1000).toFixed(0)}s budget)`);
            }
          }
          if (onProgress && elapsed - lastReportAt > 500) { lastReportAt = elapsed; report(); }
          if (pendingLen >= APPEND_BYTES) flushPending();
        }
        flushPending();
      } else {
        const buf = await resp.arrayBuffer();
        this.loadedBytes = buf.byteLength;
        buf.fileStart = 0;
        mp4.appendBuffer(buf);
      }
      this.timings.downloadMs = Math.round(since() - downloadStart);
      this.phase = 'demuxing';
      report();
      const demuxStart = since();
      mp4.flush();
      // The full file has been appended; if moov still hasn't been found the
      // data isn't a parseable mp4 (truncated file, or an HTML error page served
      // with status 200). Fail instead of awaiting onReady forever.
      await Promise.race([
        ready,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('no moov box found (not a valid/complete mp4)')), 10000,
        )),
      ]);

      this.timescale = vtrack.timescale;
      this.width = vtrack.video.width;
      this.height = vtrack.video.height;
      this.rotation = getRotation(mp4, vtrack.id);
      const description = getDescription(mp4, vtrack.id);
      this.config = { codec: vtrack.codec, codedWidth: this.width, codedHeight: this.height };
      if (description) this.config.description = description;

      this.timings.demuxMs = Math.round(since() - demuxStart);
      this.phase = 'configuring';
      report();

      const support = await VideoDecoder.isConfigSupported(this.config);
      if (!support.supported) {
        return fail('config', 'VideoDecoder config unsupported: ' + vtrack.codec);
      }

      const edit = presentationEdit(vtrack.edits, vtrack.timescale, vtrack.movie_timescale);
      const normalized = normalizePresentationSamples(samples, this.timescale, edit);
      this.samples = normalized.samples;
      this.presentationOriginUs = normalized.originUs;
      this.presentationDurationUs = normalized.durationUs;
      this.presentedSampleCount = normalized.presentedCount;
      this.editListApplied = normalized.editApplied;
      if (normalized.editApplied) {
        console.warn(`[export] ClipSource ${this.url.split('/').pop().split('?')[0]}: edit list starts the `
          + `picture ${(normalized.originUs / 1e6).toFixed(3)}s into the stored samples `
          + `(${this.samples.length - normalized.presentedCount} hidden frame(s) kept for decoding)`
          + (edit.followingEdits ? ` — ${edit.followingEdits} further edit(s) not followed` : ''));
      }
      this.keyIndices = [];
      for (let i = 0; i < this.samples.length; i++) {
        if (this.samples[i].isKey) this.keyIndices.push(i);
      }

      this.ready = true;
      this.phase = 'ready';
      this.timings.totalMs = Math.round(since());
      report();
      // Where acquisition time actually went, per source. Nothing recorded this
      // before, so the only way to answer "did frame 0 spend its budget
      // downloading?" was to ask the person whose render failed to run
      // experiments — which is what a field investigation cost.
      const gopSec = this.keyIndices.length > 1
        ? (this.presentationDurationUs / 1e6) / this.keyIndices.length
        : (this.presentationDurationUs / 1e6);
      console.warn(`[export] ClipSource ready ${this.url.split('/').pop().split('?')[0]}: `
        + `${(this.totalBytes / 1e6).toFixed(1)} MB, ${this.width}x${this.height}, `
        + `${this.samples.length} samples, ${this.keyIndices.length} sync (~${gopSec.toFixed(2)}s GOP) — `
        + `probe ${this.timings.probeMs}ms + download ${this.timings.downloadMs}ms `
        + `(${(this.totalBytes / 1e6 / Math.max(0.001, this.timings.downloadMs / 1000)).toFixed(1)} MB/s) `
        + `+ demux ${this.timings.demuxMs}ms = ${this.timings.totalMs}ms`);
    } catch (e) {
      const message = e?.message || String(e);
      const kind = /cancel/i.test(message) ? 'cancelled'
        : /fetch|network|load failed/i.test(message) ? 'fetch'
        : 'demux';
      return fail(kind, message);
    }
    return this.ready;
  }

  // Index of the last keyframe sample with timestamp <= targetUs (0 if none) —
  // the decode entry point for reaching targetUs without decoding what precedes it.
  keyIndexFor(targetUs) {
    const keys = this.keyIndices;
    let lo = 0;
    let hi = keys.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.samples[keys[mid]].ts <= targetUs + FRAME_PICK_SLACK_US) { best = keys[mid]; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }
}

export class ClipDecoder {
  /**
   * @param {ClipSource} source
   * @param {object} [opts]
   * @param {HTMLCanvasElement|OffscreenCanvas} [opts.canvas] — draw into this
   *   surface instead of allocating one. `SegmentedClipDecoder` passes a single
   *   canvas to every part's decoder, so crossing a segment boundary does not
   *   hand the compositor a different canvas object — which would orphan its
   *   cached texture and force a fresh upload at every boundary.
   * @param {boolean} [opts.applyRotation] — draw upright, applying the track
   *   header's display rotation (the canvas takes the display size). Off by
   *   default: the analysers (clipFrameSource, roto, face mosaic) turn
   *   `canvas` themselves and would turn it twice.
   * @param {Function} [opts.drawFrame] — called with the chosen VideoFrame INSTEAD
   *   of drawing it onto `canvas`. The frame stays open until the next
   *   drawFrameAt(). WebmClipDecoder reads a WebM's alpha stream through it.
   */
  constructor(source, opts = {}) {
    this.source = source;
    this.url = source.url;
    this.ready = source.ready;
    this.error = null;
    this.width = source.width;
    this.height = source.height;
    this.samples = source.samples;
    const rot = opts.applyRotation ? source.rotation || 0 : 0;
    this.rotation = rot === 90 || rot === 180 || rot === 270 ? rot : 0;
    const swap = this.rotation === 90 || this.rotation === 270;
    this.displayWidth = swap ? this.height : this.width;
    this.displayHeight = swap ? this.width : this.height;

    // Offscreen surface the compositor reads. In a worker (no DOM) use
    // OffscreenCanvas. Gated on `window`, not `document`: the roto worker
    // shims an empty document for MediaPipe's macOS touch probe, so document's
    // presence no longer implies a real DOM.
    this.ownsCanvas = !opts.canvas;
    this.canvas = opts.canvas || (typeof window !== 'undefined' && typeof document !== 'undefined'
      ? document.createElement('canvas')
      : new OffscreenCanvas(this.displayWidth, this.displayHeight));
    if (this.ownsCanvas) {
      this.canvas.width = this.displayWidth;
      this.canvas.height = this.displayHeight;
    }
    this.ctx = this.canvas.getContext('2d');

    this._frames = [];   // buffered decoded VideoFrames (presentation order)
    this._fedIdx = 0;    // next sample index to feed
    this._flushed = false;
    this._waiter = null;
    this._lastTargetUs = -1;
    this._drawFrame = typeof opts.drawFrame === 'function' ? opts.drawFrame : null;
    // Timestamp (µs) of the frame the last drawFrameAt() drew, null before one.
    this.drawnTimestampUs = null;
    // Target the output callback prunes against while catching up. -1 disables
    // pruning (no draw in flight), which only happens before the first draw.
    this._pruneTargetUs = -1;
    // Diagnostics: the largest _frames.length ever reached. tests/gop-stall's
    // t2 probe asserts this stays a small constant however far a seek catches up.
    this.peakHeldFrames = 0;
    this.decoder = null;
    this._createDecoder();
  }

  _createDecoder() {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this._frames.push(frame);
        // Release what we have already passed AS WE GO. Pruning only after the
        // catch-up loop returned made held memory
        // `framesSinceKeyframe x width x height x 1.5` with no bound — measured
        // at 1.67 GB for a single seek on a 4K source with a 6.84s GOP, and
        // 7.25 GB at 29s (tests/gop-stall t2). Nothing between the entry
        // keyframe and the target can ever be drawn, so nothing between them
        // needs keeping.
        if (this._pruneTargetUs >= 0) this._pruneFrames(this._pruneTargetUs);
        if (this._frames.length > this.peakHeldFrames) this.peakHeldFrames = this._frames.length;
        const w = this._waiter; this._waiter = null; if (w) w();
      },
      error: (e) => {
        this.error = e?.message || String(e);
        const w = this._waiter; this._waiter = null; if (w) w();
      },
    });
    this.decoder.configure(this.source.config);
  }

  // Reset the decoder to re-enter the stream at `startIdx` (a keyframe sample),
  // since VideoDecoder can only move forward from a keyframe.
  _reset(startIdx = 0) {
    try { this.decoder.close(); } catch { /* ignore */ }
    for (const f of this._frames) { try { f.close(); } catch { /* ignore */ } }
    this._frames = [];
    this._pruneTargetUs = -1;
    this._fedIdx = startIdx;
    this._flushed = false;
    this._createDecoder();
  }

  // Keep only the frames that can still be drawn for `targetUs`: the newest one
  // at or before it, plus everything after it (the next draw's lookahead, and
  // the fallback when the whole buffer is still ahead of the target). Everything
  // older has been passed and is closed here rather than held.
  //
  // The retained count is therefore bounded by the decoder's in-flight burst
  // (16 chunks per feed round, decodeQueueSize < 24) — a small constant — not by
  // how far the seek had to catch up.
  _pruneFrames(targetUs) {
    if (this._frames.length < 2) return;
    let best = null;
    for (const f of this._frames) {
      if (f.timestamp <= targetUs + FRAME_PICK_SLACK_US && (!best || f.timestamp > best.timestamp)) best = f;
    }
    if (!best) return; // every frame is still ahead of the target — all are candidates
    const keep = [];
    for (const f of this._frames) {
      if (f === best || f.timestamp > targetUs + FRAME_PICK_SLACK_US) keep.push(f);
      else { try { f.close(); } catch { /* ignore */ } }
    }
    this._frames = keep;
  }

  async _ensurePast(targetUs) {
    this._pruneTargetUs = targetUs;
    // Frames buffered for an earlier target are pruned against the new one up
    // front, so a forward step never carries the previous step's tail.
    this._pruneFrames(targetUs);
    // Feed samples until a buffered frame's timestamp passes the target (so the
    // best frame <= target is final), or until all samples are fed and flushed.
    for (let guard = 0; guard < 100000; guard++) {
      // If the decoder faulted (e.g. a sustained 4K decode exhausted the headless
      // GPU), stop — don't loop feeding a dead/closed codec forever (which would
      // hang the export). The caller then falls back to <video> seeking.
      if (this.error) return;
      const last = this._frames[this._frames.length - 1];
      if (last && last.timestamp > targetUs + FRAME_PICK_SLACK_US) return;
      if (this._fedIdx >= this.samples.length) {
        if (!this._flushed) { try { await this.decoder.flush(); } catch { /* ignore */ } this._flushed = true; }
        return;
      }
      // Bound in-flight work so large (4K) frames don't pile up and exhaust memory.
      for (let k = 0; k < 16 && this._fedIdx < this.samples.length && this.decoder.decodeQueueSize < 24; k++, this._fedIdx++) {
        const s = this.samples[this._fedIdx];
        try {
          this.decoder.decode(new EncodedVideoChunk({ type: s.type, timestamp: s.ts, duration: s.dur, data: s.data }));
        } catch (e) {
          this.error = e?.message || String(e);
          return;
        }
      }
      await new Promise((resolve) => {
        this._waiter = resolve;
        setTimeout(() => { if (this._waiter === resolve) { this._waiter = null; resolve(); } }, 3000);
      });
    }
  }

  // Draw the frame for `targetSec` (clip-local source time) onto this.canvas.
  // Returns true if a frame was drawn.
  async drawFrameAt(targetSec) {
    if (!this.ready) return false;
    const targetUs = Math.round(Math.max(0, targetSec) * 1e6);
    if (targetUs < this._lastTargetUs - 1) {
      // Backward jump: re-enter at the last keyframe at/before the target instead
      // of re-decoding the whole file from the start.
      this._reset(this.source.keyIndexFor(targetUs));
    } else {
      // Forward jump past an unfed keyframe (fresh decoder on a trimmed clip, or a
      // skip between items): enter there rather than decoding everything between.
      // Small monotonic steps never hit this — their keyframe is already fed.
      const keyIdx = this.source.keyIndexFor(targetUs);
      if (keyIdx > this._fedIdx) this._reset(keyIdx);
    }
    this._lastTargetUs = targetUs;

    await this._ensurePast(targetUs);

    let best = null;
    for (const f of this._frames) {
      if (f.timestamp <= targetUs + FRAME_PICK_SLACK_US && (!best || f.timestamp > best.timestamp)) best = f;
    }
    if (!best && this._frames.length) best = this._frames[0];
    if (best) this.drawnTimestampUs = best.timestamp;
    if (best && this._drawFrame) {
      this._drawFrame(best);
    } else if (best) {
      if (this.rotation) {
        // Same turn as clipFrameSource / rotoProcessor (clockwise, tkhd convention).
        const ctx = this.ctx;
        const W = this.displayWidth;
        const H = this.displayHeight;
        ctx.save();
        if (this.rotation === 90) { ctx.translate(W, 0); ctx.rotate(Math.PI / 2); }
        else if (this.rotation === 180) { ctx.translate(W, H); ctx.rotate(Math.PI); }
        else { ctx.translate(0, H); ctx.rotate(-Math.PI / 2); }
        ctx.drawImage(best, 0, 0, this.width, this.height);
        ctx.restore();
      } else {
        this.ctx.drawImage(best, 0, 0, this.width, this.height);
      }
    }
    // Free frames we've moved past, keeping the one we just drew.
    const keep = [];
    for (const f of this._frames) {
      if (f === best || f.timestamp > targetUs + FRAME_PICK_SLACK_US) keep.push(f);
      else { try { f.close(); } catch { /* ignore */ } }
    }
    this._frames = keep;
    return !!best;
  }

  close() {
    try { this.decoder?.close(); } catch { /* ignore */ }
    for (const f of this._frames) { try { f.close(); } catch { /* ignore */ } }
    this._frames = [];
  }
}


/* ────────────────────────────────────────────────────────────────────────────
   Segmented sources.

   A render source can arrive as a MANIFEST of picture-only parts instead of one
   whole file (backend: `_ensure_copy_segments` / `_ensure_transcoded_segments`).
   Two things that were structurally broken with whole files stop being possible:

   - Acquisition is bounded. `ClipSource.init` downloads and demuxes everything it
     is pointed at, so a 1 GB master costs 1 GB and ~9,400 samples before the
     first frame — measured at 33 s on a machine whose fetch runs at 30 MB/s. A
     60-second part is a ~120 MB fetch with roughly 750 samples, and that stays
     true however long the source is.
   - Peak memory is bounded by the PART, not by the source.

   The parts' `[sourceStart, sourceEnd)` bounds are the manifest's ACTUAL
   measured values, never `index * segmentSeconds`: ffmpeg's cut points move to
   the next available sync sample, and the numbers it reports for them are in
   decode order. The backend resolves both; this side must simply not re-derive
   them.
   ──────────────────────────────────────────────────────────────────────────── */

// How close to a part's end the decoder starts loading the next one. One second
// is comfortably longer than a part fetch takes and short enough that the
// prefetch does not compete with the current part's decode.
const SEGMENT_PREFETCH_LEAD_SEC = 1.0;

export class SegmentedSource {
  /**
   * @param {object} descriptor — `clip.renderVideoSource` from the render
   *   snapshot: { version, mode, baseUrl, manifestUrl, parts[], width, height,
   *   rotation, durationSec }.
   */
  constructor(descriptor) {
    this.descriptor = descriptor || {};
    this.mode = this.descriptor.mode || 'copy';
    this.baseUrl = (this.descriptor.baseUrl || '').replace(/\/+$/, '');
    this.parts = Array.isArray(this.descriptor.parts) ? this.descriptor.parts : [];
    this.width = this.descriptor.width || 0;
    this.height = this.descriptor.height || 0;
    this.rotation = this.descriptor.rotation || 0;
    this.durationSec = this.descriptor.durationSec || 0;
    this.error = null;
    this.errorKind = null;
  }

  get usable() {
    return this.parts.length > 0 && !!this.baseUrl;
  }

  partUrl(index) {
    const part = this.parts[index];
    return part ? `${this.baseUrl}/${part.file}` : '';
  }

  /**
   * Index of the part covering `sourceSec`, by binary search over the actual
   * half-open bounds. Times before the first part or after the last clamp to the
   * ends rather than failing: a trim can legitimately ask for a frame a hair
   * outside the covered range, and returning nothing there would blank a frame.
   */
  partIndexFor(sourceSec) {
    const parts = this.parts;
    if (!parts.length) return -1;
    let lo = 0;
    let hi = parts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sourceSec < parts[mid].sourceStart) hi = mid - 1;
      else if (sourceSec >= parts[mid].sourceEnd) lo = mid + 1;
      else return mid;
    }
    return sourceSec < parts[0].sourceStart ? 0 : parts.length - 1;
  }

  /** Source time -> the part's own rebased presentation clock. */
  localTimeFor(index, sourceSec) {
    const part = this.parts[index];
    if (!part) return 0;
    return Math.max(0, sourceSec - part.sourceStart);
  }
}

/**
 * One consumer's view of a segmented source: the same contract as `ClipDecoder`
 * (`drawFrameAt(sourceSec)` -> `canvas`), with parts loaded, cached and evicted
 * underneath.
 *
 * Retention is deliberately three parts wide — previous, current, next. The
 * previous one is kept because a crossfade or a backward step across a boundary
 * would otherwise re-fetch and re-demux the part it just discarded, on every
 * frame of the transition.
 */
export class SegmentedClipDecoder {
  constructor(segmented, opts = {}) {
    this.segmented = segmented;
    this.url = segmented.descriptor.manifestUrl || segmented.baseUrl;
    this.ready = segmented.usable;
    this.error = null;
    this.width = segmented.width;
    this.height = segmented.height;
    // Passed to every part's ClipDecoder. Each part's OWN header decides the
    // turn — a copy part keeps the source's, a transcoded part is already upright.
    this.applyRotation = !!opts.applyRotation;
    this._sizedFromPart = false;

    // ONE canvas for every part — see the note on ClipDecoder's `canvas` option.
    this.canvas = opts.canvas || (typeof window !== 'undefined' && typeof document !== 'undefined'
      ? document.createElement('canvas')
      : new OffscreenCanvas(this.width || 2, this.height || 2));
    if (this.width && this.height) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }

    this._entries = new Map(); // index -> { promise, source, decoder }
    this._activeIndex = -1;
    this.partsLoaded = 0;
    this.closed = false;
  }

  /** Load (or return the in-flight load of) one part. */
  _entry(index) {
    let entry = this._entries.get(index);
    if (entry) return entry;
    const url = this.segmented.partUrl(index);
    entry = { index, url, decoder: null, error: null };
    entry.promise = (async () => {
      const source = new ClipSource(url);
      let ok = false;
      try {
        // Per-part budget. A part is small by construction, so a part that
        // cannot be acquired quickly is a real failure rather than a big file.
        ok = await source.init(null, { timeBudgetMs: SEGMENT_ACQUIRE_MS });
      } catch (e) {
        ok = false;
        source.error = e?.message || String(e);
      }
      if (!ok) {
        entry.error = {
          kind: source.errorKind || 'unknown',
          message: source.error,
          part: index,
          file: this.segmented.parts[index]?.file,
          url,
        };
        return null;
      }
      if (this.closed) { return null; }
      entry.decoder = new ClipDecoder(source, { canvas: this.canvas, applyRotation: this.applyRotation });
      // The manifest records the STORED size; a turned part draws upright, so the
      // shared canvas takes the first part's display size. Once only — every
      // part of one source has the same size.
      const { displayWidth: dw, displayHeight: dh } = entry.decoder;
      if (!this._sizedFromPart || !this.canvas.width || !this.canvas.height) {
        this._sizedFromPart = true;
        if (this.canvas.width !== dw || this.canvas.height !== dh) {
          this.canvas.width = dw;
          this.canvas.height = dh;
        }
        this.width = dw;
        this.height = dh;
      }
      entry.source = source;
      this.partsLoaded += 1;
      return entry.decoder;
    })();
    this._entries.set(index, entry);
    return entry;
  }

  /** Drop everything outside [index-1, index+1] and close what it held. */
  _evictAround(index) {
    for (const [key, entry] of [...this._entries.entries()]) {
      if (key >= index - 1 && key <= index + 1) continue;
      this._entries.delete(key);
      // The decoder may still be loading; close once it settles rather than
      // leaking a VideoDecoder that nobody is holding.
      Promise.resolve(entry.promise).then(() => {
        try { entry.decoder?.close(); } catch { /* ignore */ }
      }).catch(() => {});
    }
  }

  async drawFrameAt(sourceSec) {
    if (!this.ready || this.closed) return false;
    const index = this.segmented.partIndexFor(sourceSec);
    if (index < 0) return false;

    const entry = this._entry(index);
    const decoder = await entry.promise;
    if (!decoder) {
      // Structured, and specific about WHICH part and WHEN — the whole reason a
      // field failure took days was that "a clip can't be decoded" named neither.
      this.error = entry.error || { kind: 'unknown', part: index, message: 'part unavailable' };
      return false;
    }
    this._activeIndex = index;
    this._evictAround(index);

    // Warm the next part before the boundary rather than at it, so a crossing
    // costs a decode rather than a fetch plus a demux.
    const part = this.segmented.parts[index];
    if (part && index + 1 < this.segmented.parts.length
        && sourceSec >= part.sourceEnd - SEGMENT_PREFETCH_LEAD_SEC) {
      this._entry(index + 1); // fire and forget
    }

    const drew = await decoder.drawFrameAt(this.segmented.localTimeFor(index, sourceSec));
    if (!drew && decoder.error) {
      this.error = { kind: 'decode', part: index, file: part?.file, message: decoder.error };
    }
    return drew;
  }

  /**
   * Check a segmented source BEFORE the frame loop: can the browser configure a
   * decoder for these parts, and do representative ones actually decode?
   *
   * First, middle and last, because the ways a derivative goes wrong are not
   * uniformly distributed — the first part carries the codec configuration, the
   * last is where a truncated build shows up, and the middle is an ordinary one.
   */
  async preflight() {
    const total = this.segmented.parts.length;
    if (!total) return { ok: false, error: { kind: 'manifest', message: 'no parts in the manifest' } };
    const probes = [...new Set([0, Math.floor(total / 2), total - 1])];
    for (const index of probes) {
      const entry = this._entry(index);
      const decoder = await entry.promise;
      if (!decoder) return { ok: false, error: entry.error };
      const part = this.segmented.parts[index];
      const drew = await decoder.drawFrameAt(0.001);
      if (!drew) {
        return {
          ok: false,
          error: {
            kind: 'decode', part: index, file: part?.file,
            message: decoder.error || 'the part configured a decoder but produced no frame',
          },
        };
      }
    }
    this._evictAround(0);
    return { ok: true, probed: probes.length, parts: total };
  }

  close() {
    this.closed = true;
    for (const entry of this._entries.values()) {
      Promise.resolve(entry.promise).then(() => {
        try { entry.decoder?.close(); } catch { /* ignore */ }
      }).catch(() => {});
    }
    this._entries.clear();
  }
}
