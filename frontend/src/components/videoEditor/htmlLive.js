// Live HTML clips (PLANS/HTML_CLIP_LAYER_PLAN.md §2.3, Phase 2).
//
// Where the browser has HTML-in-canvas (Chromium's CanvasDrawElement feature: the
// desktop app on Electron 44 with the flag, the render browser), an html clip's page
// runs inside the editor and is drawn into a canvas that the Player samples like a
// decoded video frame (`video.__decodeCanvas`). Everywhere else, and whenever a page
// fails here, the clip plays its bake exactly as before.
//
// The page loads from /api/html-clips/live/<media path>, which installs the bake's
// clock (backend html_clips.CLOCK_SCRIPT) before any page script, and it is stepped
// through exactly the frames the bake steps: 0, 1/fps, 2/fps … up to the frame on
// screen. A live frame and the baked frame of the same time are therefore the same
// picture. Script state cannot run backwards, so an earlier frame reloads the page
// and steps forward again.
//
// Measured on Chromium 151 / Electron 44 (Chromium 152):
// - drawElementImage draws the page as it was last PAINTED — a change made in the
//   same task is not in the drawing yet. So a frame is drawn from the canvas's
//   `paint` event, which fires after the rendering update that painted it;
// - the host canvas has to be rendered: fully clipped (clip-path) or off-screen it
//   draws nothing. At the top-left corner, scaled to 1 % and behind the app, the
//   whole page draws at full size, even a page larger than the window;
// - Chromium 145 (the backend's render browser) has drawElementImage but no paint
//   event / requestPaint: there a frame is drawn two animation frames after it was
//   stepped, which puts a full rendering update (its paint) in between.
// - EXPORT pages always take that two-frame path. In a headless Chrome 153 render
//   (the desktop app renders in the user's Chrome) requestPaint + a paint-event draw
//   while the WebGPU renderer composites crashed the renderer process at frame 0,
//   and the render job sat at "Warming media 8%" with a dead page. WebGL did not.

const LIVE_PREFIX = '/api/html-clips/live';
const IDLE_DISPOSE_MS = 10000;
const SWEEP_MS = 2000;
const STEP_SLICE_MS = 12;        // stepping yields to the app at least this often
const PAINT_FALLBACK_MS = 250;   // preview: draw anyway if no paint event comes
const EXPORT_PAINT_WAIT_MS = 10000; // export: how long a frame may take to paint
const EXPORT_STALL_MS = 30000;   // export: a page that makes no progress this long fails (its bake takes over)
const LOAD_TIMEOUT_MS = 20000;   // a page that never finishes loading fails (the bake takes over)
const FONTS_WAIT_MS = 5000;      // the bake waits the same for fonts before frame 0
const EXPORT_HOLD_FRAMES = 2;    // export: a step back this small holds the frame (see below)
const PLAYING_HOLD_FRAMES = 2;   // preview while playing: a page this far ahead waits for the playhead
// Preview, going BACK: a page cannot step back, so it reloads and steps forward again.
// Scrubbing back asked for that on nearly every mouse move, and each reload is a new
// iframe inside the experimental HTML-in-canvas element — a scrub back through a long
// page crashed the renderer (the app reloaded). The frame on screen is held instead
// until the playhead has stopped moving back, and a page never reloads faster than this.
const BACK_SETTLE_MS = 150;
const RELOAD_MIN_MS = 400;
// Preview: a jump (the frame on screen more than a couple of frames from the playhead)
// holds that frame while the page catches up, which reads as a freeze. Past LOADING_SHOW_MS the
// timeline puts its Loading overlay on the clip, for at least LOADING_MIN_MS so a
// catch-up that ends just after it appears does not flash it.
const LOADING_SHOW_MS = 150;
const LOADING_MIN_MS = 400;

let supported = null;

export function htmlLiveSupported() {
  if (supported !== null) return supported;
  supported = false;
  try {
    if (typeof document === 'undefined') return false;
    // A/B switch for gates and debugging: localStorage 'gl-html-live' = 'off'.
    try { if (localStorage.getItem('gl-html-live') === 'off') return false; } catch { /* storage blocked */ }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    supported = typeof ctx?.drawElementImage === 'function';
  } catch {
    supported = false;
  }
  return supported;
}

export function htmlLivePageUrl(mediaUrl) {
  const raw = String(mediaUrl || '');
  const path = raw.split(/[?#]/)[0];
  if (!path.startsWith('/media/')) return null;
  // A HyperFrames clip's variable values ride in its url (hyperframesClips.js): its page gets them.
  const vars = raw.match(/[?&]gl-vars=([^&#]*)/);
  return `${LIVE_PREFIX}${path}${vars ? `?gl-vars=${vars[1]}` : ''}`;
}

// The bake frame a source time shows: frame k covers [k/fps, (k+1)/fps).
export function htmlLiveFrameAt(sourceSeconds, fps) {
  const f = Number(fps) || 30;
  return Math.max(0, Math.floor((Number(sourceSeconds) || 0) * f + 1e-6));
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

let hostEl = null;
function hostElement() {
  if (hostEl?.isConnected) return hostEl;
  hostEl = document.createElement('div');
  hostEl.className = 'gl-html-live-host';
  hostEl.setAttribute('aria-hidden', 'true');
  hostEl.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:-1;pointer-events:none;';
  document.body.appendChild(hostEl);
  return hostEl;
}

let frameListener = null;

class LivePage {
  constructor({ url, width, height, fps, forExport = false, instance = null }) {
    this.instance = instance; // the use of the clip (htmlLiveCanvas `instance`): what the timeline marks Loading
    this.url = url;
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.forExport = forExport;
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('layoutsubtree', '');
    this.canvas.width = width;
    this.canvas.height = height;
    // CSS size == pixel size, or the page is drawn scaled by the ratio.
    this.canvas.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;`
      + 'transform:scale(0.01);transform-origin:0 0;';
    this.ctx = this.canvas.getContext('2d');
    this.iframe = null;
    this.loading = null;   // promise of the current load
    this.stepped = -1;     // the frame the page is stepped to (-1: not yet since load)
    this.drawn = -1;       // the frame on the canvas
    this.painted = -1;     // the last frame drawn from a real paint (what an export trusts)
    this.target = 0;
    this.backAt = 0;       // when the target last moved BACK (preview reload throttle)
    this.progressAt = performance.now(); // export watchdog: the last step / draw
    this.watchdog = null;
    this.loadedAt = 0;     // when the page last started loading
    this.revision = 0;
    this.failed = null;
    this.busy = false;
    this.stepping = false; // inside the step loop: a paint now is a frame on the way, not the target
    this.shown = false;    // on screen (htmlLiveCanvas), not just loaded ahead (htmlLivePrepare)
    this.waiting = false;  // the Loading notice is up (setWaiting)
    this.waitingSince = 0;
    this.showTimer = null;
    this.hideTimer = null;
    this.version = null;   // the file version loaded (htmlClips.js htmlVersion)
    this.stale = false;    // the file changed: reload, keep showing the old frame meanwhile
    // A HyperFrames composition (backend html_clips: the runtime + adapter are in the page)
    // jumps straight to a frame with window.__glSeek instead of stepping every frame.
    // A jump BACK can keep a GSAP `set` that ran later, so in the preview it is shown at
    // once and marked `inexact`; once the playhead rests the page reloads and jumps again.
    this.direct = false;
    this.inexact = false;
    this.movedAt = 0;      // when the target last changed (preview: "the playhead rests")
    this.paintWaiters = [];
    this.settleWaiters = [];
    this.lastUsed = performance.now();
    this.usedEpoch = renderEpoch;
    // Playback renders: how many sampled the exact frame, an earlier or a later one.
    this.stats = { renders: 0, exact: 0, behind: 0, ahead: 0 };
    this.canvas.addEventListener('paint', () => this.onPaint());
    hostElement().appendChild(this.canvas);
  }

  seek(frame) {
    if (frame < this.target) this.backAt = performance.now();
    if (frame !== this.target) this.movedAt = performance.now();
    this.target = frame;
    this.lastUsed = performance.now();
    if (!this.busy && !this.failed && (this.stale || this.stepped !== frame || this.drawn !== frame || this.wantsExactReload())) this.pump();
  }

  // Preview of a direct page showing a frame reached by jumping back: reload for the exact one.
  wantsExactReload() {
    return this.direct && this.inexact && !this.forExport;
  }

  // One jump of a direct page to `frame` (paints in between are not the target: see onPaint).
  async jump(frame) {
    const win = this.iframe.contentWindow;
    this.stepping = true;
    try {
      await win.__glSeek(frame / this.fps);
    } finally {
      this.stepping = false;
    }
    this.stepped = frame;
    this.progressAt = performance.now();
  }

  // Waits until the target has not moved for BACK_SETTLE_MS and the last load is
  // RELOAD_MIN_MS old. False: nothing to do any more (failed, stale, or now exact).
  // A target that moves (playback) ends the wait at once, so its frames keep coming.
  async restSettled() {
    for (;;) {
      if (this.failed || this.stale || !this.wantsExactReload() || this.target !== this.stepped) return false;
      const now = performance.now();
      const wait = Math.max(BACK_SETTLE_MS - (now - this.movedAt), RELOAD_MIN_MS - (now - this.loadedAt));
      if (wait <= 0) return true;
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 15)));
    }
  }

  // A new version of the file reloads the page; the canvas keeps the old picture
  // until the new page has drawn this frame. The first version known only labels
  // the page already loading.
  setVersion(version) {
    if (!version || version === this.version) return;
    if (this.version) this.stale = true;
    this.version = version;
  }

  load() {
    this.stepped = -1;
    this.inexact = false;
    this.loadedAt = performance.now();
    this.loads = (this.loads || 0) + 1;
    const iframe = document.createElement('iframe');
    // The same trust as an HTML card on the board.
    iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts');
    iframe.style.cssText = `border:0;width:${this.width}px;height:${this.height}px;background:transparent;`;
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the page did not finish loading')), LOAD_TIMEOUT_MS);
      iframe.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    iframe.src = this.url;
    if (this.iframe) this.iframe.replaceWith(iframe);
    else this.canvas.appendChild(iframe);
    this.iframe = iframe;
    this.loading = loaded.then(async () => {
      const win = iframe.contentWindow;
      if (typeof win?.__glHtmlClipSeek !== 'function') throw new Error('the page clock did not install');
      // An iframe whose color-scheme differs from its page is painted opaque.
      try { iframe.style.colorScheme = win.getComputedStyle(win.document.documentElement).colorScheme || 'normal'; } catch { /* default */ }
      try {
        await Promise.race([win.document.fonts?.ready, new Promise((r) => setTimeout(r, FONTS_WAIT_MS))]);
      } catch { /* fonts are best effort, as in the bake */ }
      this.direct = typeof win.__glSeek === 'function' && !!win.__glHfAdapter;
      if (this.direct && !(await win.__glHfAdapter.ready())) throw new Error('the HyperFrames runtime did not get ready');
    });
    return this.loading;
  }

  async pump() {
    this.busy = true;
    try {
      while (!this.failed && (this.stale || this.stepped !== this.target || this.drawn !== this.target || this.wantsExactReload())) {
        // What is on screen decides, not the work: pausing reloads the page to step back
        // from the look-ahead frame, but the frame shown is right to within a frame.
        this.setWaiting(this.drawn < 0 || Math.abs(this.target - this.drawn) > PLAYING_HOLD_FRAMES);
        if (this.direct && this.loading && !this.stale && !this.forExport) {
          await this.loading;
          if (this.target < this.stepped) {
            // Back: the quick jump now, the exact frame once the playhead rests.
            await this.jump(this.target);
            this.inexact = true;
            await this.paint();
            continue;
          }
          if (this.wantsExactReload() && this.stepped === this.target && this.drawn === this.target) {
            if (!(await this.restSettled())) continue;
            await this.load();
            await this.jump(this.target);
            await this.paint();
            continue;
          }
        }
        // Back while scrubbing: hold this frame until the playhead rests (see BACK_SETTLE_MS).
        if (this.loading && !this.stale && this.target < this.stepped && !this.forExport) {
          if (!(await this.backSettled())) continue;
        }
        if (!this.loading || this.stale || this.target < this.stepped) {
          this.stale = false;
          await this.load();
        } else await this.loading;
        if (this.direct) {
          // Forward (or from a fresh load): one jump, no catch-up steps.
          if (this.stepped !== this.target && !this.stale) await this.jump(this.target);
          if (this.stepped === this.target && !this.stale) await this.paint();
          continue;
        }
        const win = this.iframe.contentWindow;
        let slice = performance.now();
        // A render that starts inside the page steps it through every frame before
        // the first one it draws; say so, or the job sits on "Warming media".
        const catchUp = this.forExport && this.target - this.stepped > 30;
        const phaseBefore = catchUp && typeof window !== 'undefined' ? window.__exportPhase : null;
        this.stepping = true;
        while (this.stepped < this.target && !this.stale) {
          const frame = this.stepped + 1;
          // Media elements are seeked only on the frame that is drawn (the clock's
          // opts.media): a catch-up step on the way there needs timers and animations.
          await win.__glHtmlClipSeek((frame * 1000) / this.fps, { media: frame >= this.target });
          this.stepped = frame;
          this.progressAt = performance.now();
          if (performance.now() - slice > STEP_SLICE_MS) {
            if (catchUp) window.__exportPhase = `Preparing the HTML page: frame ${frame} of ${this.target}`;
            await nextTask();
            slice = performance.now();
          }
        }
        this.stepping = false;
        if (catchUp && phaseBefore != null) window.__exportPhase = phaseBefore;
        if (this.stepped === this.target && !this.stale) await this.paint();
      }
    } catch (err) {
      this.failed = err?.message || String(err);
      console.warn('[html-live] falling back to the bake:', this.url, this.failed);
    } finally {
      this.busy = false;
      this.stepping = false;
      this.setWaiting(false);
      this.flushSettled();
    }
  }

  setWaiting(on) {
    if (this.forExport) return;
    if (on) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
      if (this.waiting || this.showTimer) return;
      this.showTimer = setTimeout(() => {
        this.showTimer = null;
        this.waiting = true;
        this.waitingSince = performance.now();
        emitLoading();
      }, LOADING_SHOW_MS);
      return;
    }
    clearTimeout(this.showTimer);
    this.showTimer = null;
    if (!this.waiting || this.hideTimer) return;
    const hide = () => { this.hideTimer = null; this.waiting = false; emitLoading(); };
    const left = LOADING_MIN_MS - (performance.now() - this.waitingSince);
    if (left > 0) this.hideTimer = setTimeout(hide, left);
    else hide();
  }

  // Waits until the target has not moved back for BACK_SETTLE_MS and the last load is
  // RELOAD_MIN_MS old. True: reload now. False: nothing to reload any more (the target
  // came forward again, the file changed, or the page is gone).
  async backSettled() {
    for (;;) {
      if (this.failed || this.stale || this.target >= this.stepped) return false;
      const now = performance.now();
      const wait = Math.max(BACK_SETTLE_MS - (now - this.backAt), RELOAD_MIN_MS - (now - this.loadedAt));
      if (wait <= 0) return true;
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, BACK_SETTLE_MS)));
    }
  }

  // Export: resolves true once the page is stepped to `frame` AND a real paint drew
  // it; false if the page failed or no paint came (a window that is not rendering).
  settle(frame) {
    if (this.failed) return Promise.resolve(false);
    this.armWatchdog();
    return new Promise((resolve) => {
      this.settleWaiters.push({ frame, resolve });
      if (this.busy) this.target = frame;
      else if (this.stale || this.stepped !== frame || this.drawn !== frame) this.seek(frame);
      else this.flushSettled();
    });
  }

  // Export: a page that stops making progress (a step, a draw) for EXPORT_STALL_MS
  // fails, so the render stops waiting on it and its bake takes over — instead of
  // the job sitting at one percentage for good.
  armWatchdog() {
    if (this.watchdog) return;
    this.progressAt = performance.now();
    this.watchdog = setInterval(() => {
      if (!this.settleWaiters.length || this.failed) {
        clearInterval(this.watchdog);
        this.watchdog = null;
        return;
      }
      if (performance.now() - this.progressAt > EXPORT_STALL_MS) {
        this.failed = `the page made no progress for ${EXPORT_STALL_MS / 1000} s (frame ${this.stepped} of ${this.target})`;
        console.warn('[html-live] falling back to the bake:', this.url, this.failed);
        clearInterval(this.watchdog);
        this.watchdog = null;
        this.flushSettled();
      }
    }, 2000);
  }

  flushSettled() {
    const waiting = this.settleWaiters;
    this.settleWaiters = [];
    for (const w of waiting) {
      if (this.failed) w.resolve(false);
      else if (!this.stale && this.stepped === w.frame && this.drawn === w.frame) w.resolve(this.painted === w.frame);
      else this.settleWaiters.push(w);
    }
    if (this.settleWaiters.length && !this.busy && !this.failed) this.seek(this.settleWaiters[0].frame);
  }

  paint() {
    if (this.forExport || typeof this.canvas.requestPaint !== 'function') {
      return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => { this.draw(true); resolve(); }));
      });
    }
    return new Promise((resolve) => {
      const waiter = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this.paintWaiters = this.paintWaiters.filter((w) => w !== waiter);
        this.draw(false);
        resolve();
      }, this.forExport ? EXPORT_PAINT_WAIT_MS : PAINT_FALLBACK_MS);
      this.paintWaiters.push(waiter);
      try { this.canvas.requestPaint(); } catch { /* the fallback draws */ }
    });
  }

  onPaint() {
    // Export pages draw only on their own two-frame schedule (see the header).
    // A jump steps the page through every frame up to the playhead, yielding as it
    // goes, and the browser paints at those yields: drawing them flashed the frames
    // in between on screen. The canvas keeps the frame it has until the target's own
    // paint (requested by paint() once the steps are done).
    if (this.forExport || !this.iframe || this.stepped < 0 || this.stepping) return;
    this.draw(true);
    const waiters = this.paintWaiters;
    this.paintWaiters = [];
    for (const w of waiters) w();
  }

  // `fromPaint`: drawn in the paint event, so the drawing IS the stepped frame. The
  // no-paint fallback draws whatever was painted last, good enough for a preview.
  draw(fromPaint) {
    if (this.failed || !this.iframe || this.stepped < 0) return;
    try {
      this.ctx.clearRect(0, 0, this.width, this.height);
      this.ctx.drawElementImage(this.iframe, 0, 0);
      this.drawn = this.stepped;
      this.progressAt = performance.now();
      if (fromPaint) this.painted = this.stepped;
      this.revision += 1;
    } catch (err) {
      this.failed = err?.message || String(err);
      console.warn('[html-live] draw failed, falling back to the bake:', this.url, this.failed);
      return;
    }
    frameListener?.(this);
  }

  dispose() {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    clearTimeout(this.showTimer);
    clearTimeout(this.hideTimer);
    this.showTimer = null;
    this.hideTimer = null;
    if (this.waiting) { this.waiting = false; emitLoading(); }
    this.failed = this.failed || 'disposed';
    this.canvas.remove();
    this.iframe = null;
    this.flushSettled();
  }
}

const pages = new Map();
let sweepTimer = null;
const blanks = new Map(); // blank canvases by size (blankCanvas)
// Counts the Player's renders. A page is disposed only once renders have gone on
// without it for a while: a paused preview renders nothing, yet its page is on screen.
let renderEpoch = 0;

export function htmlLiveBeginFrame() {
  renderEpoch += 1;
}

// The uses (htmlLiveCanvas `instance`) whose page the preview is waiting on, for the
// timeline's Loading overlay (useSyncExternalStore). Only pages on screen count: one
// loading ahead of the playhead (htmlLivePrepare) keeps playing what is there.
const EMPTY_LOADING = Object.freeze([]);
let loadingSnapshot = EMPTY_LOADING;
let loadingKey = '';
const loadingListeners = new Set();

function emitLoading() {
  const ids = [];
  for (const p of pages.values()) if (p.waiting && p.shown && p.instance) ids.push(p.instance);
  ids.sort();
  const key = ids.join('\n');
  if (key === loadingKey) return;
  loadingKey = key;
  loadingSnapshot = ids.length ? Object.freeze(ids) : EMPTY_LOADING;
  for (const fn of loadingListeners) fn();
}

export function subscribeHtmlLiveLoading(fn) {
  loadingListeners.add(fn);
  return () => loadingListeners.delete(fn);
}

export function getHtmlLiveLoading() {
  return loadingSnapshot;
}

// The page's canvas (W×H): the clip's own, else the project size.
function pageSize(clip, videoSize) {
  return {
    width: Math.round(Number(clip?.htmlCanvas?.width) || Number(videoSize?.w) || 1920),
    height: Math.round(Number(clip?.htmlCanvas?.height) || Number(videoSize?.h) || 1080),
  };
}

// What a live-only clip (no bake yet) shows until its page has drawn, or if the page
// fails: nothing — never the picture its <video> element last played. It has the
// page's aspect: the clip shader fits a texture of another aspect into the layer and
// paints the bars OPAQUE BLACK, so a square blank on a 16:9 page showed two black
// strips. A short side of 128 px keeps the aspect within 0.004 (the shader allows 0.01).
function blankCanvas(clip, videoSize) {
  const { width, height } = pageSize(clip, videoSize);
  const scale = Math.min(1, 128 / Math.max(1, Math.min(width, height)));
  const w = Math.max(1, Math.min(4096, Math.round(width * scale)));
  const h = Math.max(1, Math.min(4096, Math.round(height * scale)));
  const key = `${w}x${h}`;
  let canvas = blanks.get(key);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    blanks.set(key, canvas);
  }
  return canvas;
}

function sweep() {
  const now = performance.now();
  for (const [key, page] of pages) {
    if (page.usedEpoch < renderEpoch && now - page.lastUsed > IDLE_DISPOSE_MS) {
      page.dispose();
      pages.delete(key);
    }
  }
  if (!pages.size) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

// Called with the page whenever a new frame lands on a canvas (the Player re-renders
// a paused frame from it).
export function setHtmlLiveFrameListener(fn) {
  frameListener = fn;
}

// The canvas an html clip's layer should show at `sourceSeconds`, or null to play
// the bake: live frames unsupported, the clip not an html clip, the page failed, or
// no frame drawn yet. `clip` is the Player's clip (htmlClips.js bakedPlaybackClip).
//
// A frame stepped now reaches the canvas only at this frame's paint, after the
// Player has already uploaded the canvas. So during playback the Player passes
// `stepSeconds`, the source time its NEXT render will show: the page is stepped
// there, and that render finds it drawn. Paused, it steps to `sourceSeconds`.
//
// `instance` names this USE of the clip (the item, and the container path above
// it): two items of one clip at different source times each need their own page.
function pageFor(clip, { fps, videoSize, instance, forExport = false }) {
  const url = htmlLivePageUrl(clip.htmlSource);
  if (!url) return null;
  const f = Number(fps) || 30;
  const { width, height } = pageSize(clip, videoSize);
  const key = `${forExport ? 'export:' : ''}${instance || clip.id}|${url}|${width}x${height}|${f}`;
  let page = pages.get(key);
  if (!page) {
    page = new LivePage({ url, width, height, fps: f, forExport, instance: instance || clip.id });
    pages.set(key, page);
    if (!sweepTimer) sweepTimer = setInterval(sweep, SWEEP_MS);
  }
  page.usedEpoch = renderEpoch;
  page.lastUsed = performance.now();
  if (!page.failed) page.setVersion(clip.htmlVersion || null);
  return page;
}

export function htmlLiveCanvas(clip, sourceSeconds, { fps, videoSize, stepSeconds = null, playing = false, instance = null } = {}) {
  if (!clip?.htmlSource) return null;
  if (!htmlLiveSupported()) return clip.htmlLiveOnly ? blankCanvas(clip, videoSize) : null;
  const page = pageFor(clip, { fps, videoSize, instance });
  const none = clip.htmlLiveOnly ? blankCanvas(clip, videoSize) : null;
  if (!page || page.failed) return none;
  const f = page.fps;
  const want = htmlLiveFrameAt(sourceSeconds, f);
  // Look ahead at most one frame: a slow tick must not throw the page far forward.
  let target = stepSeconds == null ? want : Math.max(want, Math.min(want + 1, htmlLiveFrameAt(stepSeconds, f)));
  // Playing, a page a frame or two ahead (the look-ahead) just waits for the playhead:
  // going back means reloading the page, which would stall playback. Paused, and on
  // a real jump back, it reloads so the frame is exact.
  if (playing && target < page.stepped && page.stepped - target <= PLAYING_HOLD_FRAMES) target = page.stepped;
  if (!page.shown) {
    page.shown = true;
    if (page.waiting) emitLoading();
  }
  page.seek(target);
  if (page.drawn < 0) return none;
  if (playing) {
    const st = page.stats;
    st.renders += 1;
    if (page.drawn === want) st.exact += 1;
    else if (page.drawn < want) st.behind += 1;
    else st.ahead += 1;
  }
  return page.canvas;
}

// Load an upcoming use's page and step it to its first frame, so the layer is live
// from its first rendered frame (the Player calls this within its preload lead).
export function htmlLivePrepare(clip, sourceSeconds, { fps, videoSize, instance = null } = {}) {
  if (!clip?.htmlSource || !htmlLiveSupported()) return;
  const page = pageFor(clip, { fps, videoSize, instance });
  if (!page || page.failed) return;
  if (page.shown) {
    page.shown = false;
    if (page.waiting) emitLoading();
  }
  page.seek(htmlLiveFrameAt(sourceSeconds, page.fps));
}

// Why a file's page could not run live (for the HTML panel), or null.
export function htmlLiveFailure(mediaUrl) {
  const url = htmlLivePageUrl(mediaUrl);
  for (const page of pages.values()) {
    if (page.url === url && !page.forExport && page.failed && page.failed !== 'disposed') return page.failed;
  }
  return null;
}

// Export: the canvas once this use's page (its own, apart from the preview's) is on
// EXACTLY the frame for `sourceSeconds`, painted — or null when live frames are
// unavailable or the page failed (the caller plays the bake instead, or stops).
// Motion blur: the caller passes `fps` K times the export's (Player's htmlLivePageFps),
// so each sub-frame sample is a page frame of its own, and the samples only ever move
// forward. A page cannot step back: a step back of up to EXPORT_HOLD_FRAMES keeps the
// frame it is on, instead of reloading the page.
export async function htmlLiveExportCanvas(clip, sourceSeconds, { fps, videoSize, instance = null } = {}) {
  if (!clip?.htmlSource || !htmlLiveSupported()) return null;
  const page = pageFor(clip, { fps, videoSize, instance, forExport: true });
  if (!page || page.failed) return null;
  const want = htmlLiveFrameAt(sourceSeconds, page.fps);
  const frame = want < page.stepped && page.stepped - want <= EXPORT_HOLD_FRAMES ? page.stepped : want;
  return (await page.settle(frame)) ? page.canvas : null;
}

// A still (Player.captureFrameAtTime, the headless render-still): the render before it
// stepped every page on screen toward its frame, but a step reaches the canvas only at
// a later paint, and a still has no next frame to show it in. This waits until every
// page that render used is drawn on its frame. `waited`: one was not yet (render again);
// `failed`: the pages that could not be drawn live (a strict caller stops, the backend
// then renders the still from bakes).
export async function htmlLiveSettleUsed({ timeoutMs = EXPORT_STALL_MS } = {}) {
  const used = [...pages.values()].filter((p) => !p.forExport && p.usedEpoch === renderEpoch);
  let waited = false;
  const failed = [];
  await Promise.all(used.map(async (page) => {
    const onFrame = () => !page.failed && !page.stale && page.stepped === page.target && page.drawn === page.target;
    if (!page.failed && onFrame()) return;
    waited = true;
    if (!page.failed) {
      let timer = null;
      await Promise.race([
        page.settle(page.target),
        new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
      clearTimeout(timer);
    }
    if (!onFrame()) failed.push(page.url);
  }));
  return { waited, failed };
}

// An unbaked html clip's picture where nothing better exists (no live page): empty.
export function htmlBlankCanvas(clip, videoSize) {
  return blankCanvas(clip, videoSize);
}

export function disposeHtmlLiveExportPages() {
  for (const [key, page] of pages) {
    if (!page.forExport) continue;
    page.dispose();
    pages.delete(key);
  }
}

// "Render again": reload every live page of this file now. A file the page LOADS (an
// image, a script) may have changed, which the page's version cannot see.
export function reloadHtmlLivePages(mediaUrl) {
  const url = htmlLivePageUrl(mediaUrl);
  if (!url) return;
  for (const page of pages.values()) {
    if (page.url !== url || page.failed) continue;
    page.stale = true;
    page.seek(page.target);
  }
}

// Point a Player <video> element at a live canvas (getVideoTexture samples
// `__decodeCanvas`), or release one this module set.
export function bindHtmlLiveCanvas(video, canvas) {
  if (!video) return;
  if (canvas) {
    video.__decodeCanvas = canvas;
    video.__htmlLive = true;
  } else if (video.__htmlLive) {
    video.__decodeCanvas = null;
    video.__htmlLive = false;
  }
}

if (typeof window !== 'undefined') {
  // For gates: which pages are live and the frame each one shows.
  window.__glHtmlLive = {
    supported: () => htmlLiveSupported(),
    pages: () => [...pages.entries()].map(([key, p]) => ({
      url: p.url, width: p.width, height: p.height, fps: p.fps,
      target: p.target, stepped: p.stepped, drawn: p.drawn, painted: p.painted, revision: p.revision, failed: p.failed,
      busy: p.busy,
      waiting: p.waiting, shown: p.shown, instance: p.instance,
      forExport: p.forExport,
      direct: p.direct, inexact: p.inexact,
      version: p.version, stale: p.stale, loads: p.loads, key,
      stats: { ...p.stats },
    })),
    resetStats: () => { for (const p of pages.values()) p.stats = { renders: 0, exact: 0, behind: 0, ahead: 0 }; },
  };
}
