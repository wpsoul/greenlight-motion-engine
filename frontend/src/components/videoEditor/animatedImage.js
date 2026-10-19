/*
 * Animated raster media — GIF, animated WebP, APNG — as a moving picture layer.
 *
 * These files arrive as `mediaType: 'image'` and always have: the clip panel, the
 * plate rules (imagePlate.js), filters, transitions, masks and effects all treat a
 * GIF as the picture it is. The ONLY thing that was missing is that a
 * `TextureLoader` shows frame 0 forever. So this module is deliberately narrow —
 * it answers one question, "which pixels does this file show at local time t",
 * and changes nothing else about what an image layer is.
 *
 * WHY WHOLE-FILE DECODE RATHER THAN A DECODER LANE PER LAYER
 *
 *   The video path (webcodecsClipDecoder.js, motionTemplates/motionVideo.js) keeps
 *   a live decoder per consumer and seeks it, because a 4-minute clip cannot be
 *   resident. An animated image is the opposite case: it is short, it LOOPS, and —
 *   the part that decides it — GIF/APNG frames are DELTAS. Seeking backwards one
 *   frame costs a decode from the last keyframe, so a scrub through a 60-frame GIF
 *   is O(n²) with a seeking decoder and free from an array. Frames are decoded once
 *   and held.
 *
 *   That trade only holds while the frames FIT, so it is enforced rather than
 *   assumed: `DECODED_BUDGET_BYTES` caps what one file may hold, and anything over
 *   it is stored downscaled (see `storeScaleFor`). Downscaling is the right lever
 *   because the fit-contain maths in clipShader reads uResolution's ASPECT, not its
 *   size — a smaller store is softer, never mis-placed — whereas an eviction cache
 *   would reintroduce exactly the O(n²) scrub this design exists to avoid.
 *
 * THE SYNC/ASYNC SPLIT, AND WHY EXPORT IS CORRECT
 *
 *   `renderFrame` is synchronous; decoding is not. Same split as motionVideo.js and
 *   the same contract, so the export loop that already settles that one settles this
 *   one too:
 *
 *     1. During a draw, Player calls `requestAnimatedImageFrame(url, t, laneKey)`.
 *        It returns the lane's canvas — or null while the file is still decoding —
 *        and RECORDS the url as outstanding in that second case.
 *     2. The caller then checks `animatedImagePending()` and awaits
 *        `pumpAnimatedImages()` before repainting. Preview does this lazily (a
 *        subscriber repaints when a file lands); export does it up front and
 *        repeats until nothing is outstanding, so an encoded frame can never be
 *        the static-first-frame fallback.
 *
 *   Once a file is ready every frame of it is O(1) and synchronous, so `pending`
 *   only ever describes the initial load. That is what makes a scrub jitter-free
 *   and an export deterministic: after the first pump, preview and export resolve
 *   the same index from the same table.
 *
 * No timers live here. Nothing advances on its own — the frame shown is a pure
 * function of the local time Player hands in, which is what keeps preview and a
 * headless render identical.
 */

// Extensions worth opening. JPEG/BMP/SVG can't animate, so they never pay the
// fetch. `.png` is in the list because APNG almost always ships as `.png` — the
// `.apng` extension is rare in the wild — and the sniff below rejects a plain PNG
// after a chunk walk, without constructing a decoder.
const CANDIDATE_RE = /\.(gif|webp|png|apng)(\?|#|$)/i;

// One file's decoded frames. Beyond this the store is downscaled to fit rather
// than evicted — see the header. 256 MB is roughly a 900-frame 480p GIF, or a
// 60-frame 1080p animated WebP, both comfortably past anything hand-authored.
const DECODED_BUDGET_BYTES = 256 * 1024 * 1024;
// A store is never shrunk past this: below it the layer reads as a broken thumbnail
// rather than a soft picture, and failing loudly is better than that.
const MIN_STORE_SCALE = 0.2;
// Backstop against a pathological file (a 10k-frame APNG) pinning the main thread
// in the decode sweep. Frames past this are dropped and the loop shortens.
const MAX_FRAMES = 1500;
// A frame delay of 0 is legal in GIF and means "as fast as possible"; every browser
// substitutes 100ms. Matching that keeps playback the same speed as the same file
// in an <img> tag.
const ZERO_DELAY_US = 100000;
const DEFAULT_DELAY_US = 100000;

// Decoded files are held until the editor unmounts (releaseAnimatedImages), but a
// project that cycles through many GIFs must not grow without bound.
const MAX_FILES = 24;
const MAX_LANES = 48;

// Bounds for the clip length a freshly imported animation gets — see
// `animatedClipDuration`, which is the only thing that reads them.
const MIN_CLIP_SECONDS = 1;
const MAX_CLIP_SECONDS = 30;

const files = new Map();   // url -> file entry
const lanes = new Map();   // laneKey -> { url, canvas, ctx, index, revision }
const outstanding = new Set(); // urls a draw asked for that are still loading
const subs = new Set();
let useCounter = 0;

function notify() {
  for (const fn of [...subs]) {
    try { fn(); } catch { /* a dead subscriber must not stall the rest */ }
  }
}

/** Repaint hook: a file that lands mid-preview needs the frame drawn again. */
export function onAnimatedImageFrame(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

/**
 * Could this url hold an animated raster? Extension-only and deliberately loose —
 * it gates the fetch, not the decision. `isAnimatedImageReady` is the truth, and it
 * only answers after the file has actually been sniffed.
 */
export function isAnimatedImageCandidate(url) {
  if (typeof url !== 'string' || !url) return false;
  if (/^data:image\/(gif|webp|apng|png)/i.test(url)) return true;
  return CANDIDATE_RE.test(url);
}

// ── Container sniffing ──
// Answers "is there more than one frame in here" from the bytes, so a plain PNG
// costs a chunk walk instead of an ImageDecoder + a full decode sweep. Each walk
// follows the real container structure rather than scanning for a marker: pixel
// data can spell `acTL` by chance, a chunk header cannot.

export function sniffAnimatedContainer(buffer) {
  const bytes = new Uint8Array(buffer);
  const ascii = (off, len) => {
    let s = '';
    for (let i = 0; i < len; i += 1) s += String.fromCharCode(bytes[off + i]);
    return s;
  };

  // GIF — 'GIF87a' / 'GIF89a'. Only GIF89a can carry an animation, and rather than
  // walk the block chain (variable-length sub-blocks, extension types) the decoder
  // is asked: a static GIF costs one ImageDecoder that reports frameCount 1.
  if (bytes.length >= 6 && ascii(0, 3) === 'GIF') {
    return { mime: 'image/gif', animated: true };
  }

  // PNG / APNG — animated iff an `acTL` chunk appears before the first `IDAT`.
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === 'PNG') {
    const view = new DataView(buffer);
    let off = 8;
    while (off + 8 <= bytes.length) {
      const len = view.getUint32(off);
      const type = ascii(off + 4, 4);
      if (type === 'acTL') return { mime: 'image/png', animated: true };
      // `acTL` is required to precede `IDAT`, so reaching pixel data settles it.
      if (type === 'IDAT' || type === 'IEND') break;
      off += 12 + len; // length + type + data + crc
    }
    return { mime: 'image/png', animated: false };
  }

  // WebP — a RIFF container; animated iff it holds an `ANIM` chunk.
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const view = new DataView(buffer);
    let off = 12;
    while (off + 8 <= bytes.length) {
      const type = ascii(off, 4);
      const len = view.getUint32(off + 4, true); // RIFF is little-endian
      if (type === 'ANIM') return { mime: 'image/webp', animated: true };
      off += 8 + len + (len & 1); // chunks are padded to even length
    }
    return { mime: 'image/webp', animated: false };
  }

  return { mime: '', animated: false };
}

/**
 * How far the store must shrink for `frameCount` frames to fit the budget. 1 when
 * they already do — the overwhelmingly common case, and the only one that is
 * pixel-exact.
 */
function storeScaleFor(width, height, frameCount) {
  const bytes = width * height * 4 * frameCount;
  if (bytes <= DECODED_BUDGET_BYTES) return 1;
  return Math.max(MIN_STORE_SCALE, Math.sqrt(DECODED_BUDGET_BYTES / bytes));
}

function evictFiles() {
  while (files.size > MAX_FILES) {
    let oldest = null;
    for (const entry of files.values()) {
      // Never evict something still decoding: its `ready` is awaited by a pump.
      if (entry.status === 'loading') continue;
      if (!oldest || entry.used < oldest.used) oldest = entry;
    }
    if (!oldest) return;
    dropFile(oldest.url);
  }
}

function dropFile(url) {
  const entry = files.get(url);
  if (entry) {
    for (const bitmap of entry.frames) { try { bitmap.close?.(); } catch { /* ignore */ } }
    entry.frames = [];
  }
  for (const [key, lane] of [...lanes]) if (lane.url === url) lanes.delete(key);
  files.delete(url);
  outstanding.delete(url);
}

function evictLanes() {
  while (lanes.size > MAX_LANES) {
    let oldestKey = null;
    let oldest = null;
    for (const [key, lane] of lanes) {
      if (!oldest || lane.used < oldest.used) { oldest = lane; oldestKey = key; }
    }
    if (!oldestKey) return;
    lanes.delete(oldestKey);
  }
}

async function loadFile(entry) {
  const url = entry.url;
  if (typeof ImageDecoder === 'undefined') {
    entry.status = 'failed';
    entry.reason = 'ImageDecoder unavailable';
    return entry;
  }
  let decoder = null;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const { mime, animated } = sniffAnimatedContainer(buffer);
    if (!mime || !animated) {
      // A still picture in animated clothing (a plain PNG, a single-frame WebP).
      // Marked, not failed: the caller keeps its ordinary image texture and this
      // url is never fetched again.
      entry.status = 'static';
      return entry;
    }
    if (!(await ImageDecoder.isTypeSupported(mime))) {
      entry.status = 'static';
      entry.reason = `${mime} not decodable`;
      return entry;
    }

    decoder = new ImageDecoder({ data: buffer, type: mime });
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    // `frameCount` is only final once the whole buffer is parsed — which it is
    // here, because `data` was handed over complete rather than as a stream.
    const total = Math.max(1, track?.frameCount || 1);
    if (total <= 1) {
      entry.status = 'static';
      return entry;
    }
    const frameCount = Math.min(total, MAX_FRAMES);
    if (total > MAX_FRAMES) {
      console.warn(`[animated-image] ${url}: ${total} frames, using the first ${MAX_FRAMES}`);
    }

    // Frame 0 establishes the source size, which the budget needs before the sweep
    // decides whether the rest can be stored 1:1.
    const first = await decoder.decode({ frameIndex: 0 });
    const width = first.image.displayWidth || first.image.codedWidth;
    const height = first.image.displayHeight || first.image.codedHeight;
    const scale = storeScaleFor(width, height, frameCount);
    const storeWidth = Math.max(1, Math.round(width * scale));
    const storeHeight = Math.max(1, Math.round(height * scale));
    if (scale < 1) {
      console.warn(
        `[animated-image] ${url}: ${frameCount} frames at ${width}x${height} exceed the `
        + `decode budget — stored at ${storeWidth}x${storeHeight}`
      );
    }

    const frames = [];
    const starts = new Float64Array(frameCount);
    let elapsedUs = 0;
    for (let i = 0; i < frameCount; i += 1) {
      const result = i === 0 ? first : await decoder.decode({ frameIndex: i });
      const image = result.image;
      starts[i] = elapsedUs / 1e6;
      const raw = Number(image.duration);
      elapsedUs += Number.isFinite(raw) && raw > 0 ? raw : ZERO_DELAY_US;
      try {
        frames.push(scale < 1
          ? await createImageBitmap(image, {
            resizeWidth: storeWidth, resizeHeight: storeHeight, resizeQuality: 'high',
          })
          : await createImageBitmap(image));
      } finally {
        // The VideoFrame owns decoder memory; the ImageBitmap is now the copy we
        // keep. Not closing it here is a leak the GC will not clear up for us.
        image.close();
      }
    }

    entry.width = width;
    entry.height = height;
    entry.storeWidth = storeWidth;
    entry.storeHeight = storeHeight;
    entry.frameCount = frames.length;
    entry.frames = frames;
    entry.starts = starts;
    // A file whose every delay was unreadable still has to loop at SOME rate;
    // 10fps is the historical GIF default and matches ZERO_DELAY_US.
    entry.duration = elapsedUs > 0 ? elapsedUs / 1e6 : (frames.length * DEFAULT_DELAY_US) / 1e6;
    entry.status = 'ready';
  } catch (err) {
    entry.status = 'failed';
    entry.reason = err?.message || String(err);
    console.warn(`[animated-image] ${url}: ${entry.reason}`);
  } finally {
    try { decoder?.close(); } catch { /* ignore */ }
    outstanding.delete(url);
  }
  return entry;
}

/**
 * The decode entry for `url`, starting the load on first ask. Returns
 * synchronously — read `.status` and await `.ready` if you need the frames.
 */
export function getAnimatedImage(url) {
  let entry = files.get(url);
  if (!entry) {
    entry = {
      url,
      status: 'loading',
      reason: '',
      width: 0,
      height: 0,
      storeWidth: 0,
      storeHeight: 0,
      frameCount: 0,
      duration: 0,
      frames: [],
      starts: null,
      used: 0,
    };
    files.set(url, entry);
    entry.ready = loadFile(entry);
    evictFiles();
  }
  entry.used = ++useCounter;
  return entry;
}

/** True once `url` has decoded frames to show. Static/failed files answer false. */
export function isAnimatedImageReady(url) {
  return files.get(url)?.status === 'ready';
}

/** Loop length in seconds, or 0 if `url` is not a ready animation. */
export function animatedImageDuration(url) {
  const entry = files.get(url);
  return entry?.status === 'ready' ? entry.duration : 0;
}

/** Frame count, or 0 if `url` is not a ready animation. Panel copy only. */
export function animatedImageFrameCount(url) {
  const entry = files.get(url);
  return entry?.status === 'ready' ? entry.frameCount : 0;
}

/**
 * Index of the frame on screen at `timeSec` of the loop. Binary search rather than
 * `t / duration * frameCount`: GIF delays vary frame to frame (a hold frame is
 * routinely 10x its neighbours) and the uniform guess lands on the wrong one.
 */
export function animatedFrameIndexAt(entry, timeSec) {
  const starts = entry.starts;
  const n = entry.frameCount;
  if (!starts || n <= 1) return 0;
  if (!(timeSec > starts[0])) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= timeSec) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function getLane(laneKey, url, entry) {
  let lane = lanes.get(laneKey);
  // A lane whose url changed (media replaced on the same layer) is rebuilt: its
  // canvas is sized to the old file and its drawn index means nothing now.
  if (lane && (lane.url !== url || lane.canvas.width !== entry.storeWidth
    || lane.canvas.height !== entry.storeHeight)) {
    lanes.delete(laneKey);
    lane = null;
  }
  if (!lane) {
    const canvas = document.createElement('canvas');
    canvas.width = entry.storeWidth;
    canvas.height = entry.storeHeight;
    lane = {
      url,
      canvas,
      // `alpha: true` matters — a GIF's transparent pixels must reach the texture
      // as transparent, not as the black an opaque context would leave behind.
      ctx: canvas.getContext('2d', { alpha: true }),
      index: -1,
      // Bumped whenever the canvas content changes, so the caller can upload to
      // the GPU only on a real frame change instead of every rendered frame.
      revision: 0,
      used: 0,
    };
    lanes.set(laneKey, lane);
    evictLanes();
  }
  lane.used = ++useCounter;
  return lane;
}

/**
 * The lane holding `url`'s frame at clip-local `localTime`, or null while the file
 * is still decoding or if it turned out to be a still.
 *
 * The loop/hold/ping-pong fold happens HERE rather than at the call site, because
 * only this side knows the loop length — a caller that asked for the duration first
 * would read 0 on the very frame that starts the load and mis-fold once.
 *
 * Synchronous by contract. A null answer records the url as outstanding so
 * `animatedImagePending()` reports it and the caller can pump and repaint.
 *
 * @returns {{canvas: HTMLCanvasElement, revision: number, index: number}|null}
 */
export function requestAnimatedImageFrame(url, localTime, laneKey, { mode = 'loop', speed = 1 } = {}) {
  if (!url) return null;
  const entry = getAnimatedImage(url);
  if (entry.status === 'loading') { outstanding.add(url); return null; }
  if (entry.status !== 'ready') return null;

  const index = animatedFrameIndexAt(entry, resolveAnimatedTime(localTime, entry.duration, mode, speed));
  const lane = getLane(laneKey || url, url, entry);
  if (lane.index !== index) {
    const bitmap = entry.frames[index];
    if (bitmap) {
      // Cleared first: APNG/WebP frames may carry alpha, and painting the new one
      // over the last would composite two frames together.
      lane.ctx.clearRect(0, 0, lane.canvas.width, lane.canvas.height);
      lane.ctx.drawImage(bitmap, 0, 0, lane.canvas.width, lane.canvas.height);
      lane.index = index;
      lane.revision += 1;
    }
  }
  return lane.index >= 0 ? lane : null;
}

// The layer's playback modes, and the range its speed multiplier may take. Shared
// so the panel, the sanitizer and the renderer cannot drift apart — a mode the
// sanitizer does not know is silently rewritten to the default on the next save,
// and a range the sanitizer clips is a panel control that appears to do nothing.
export const GIF_LOOP_MODES = ['loop', 'hold', 'pingpong'];
export const GIF_LOOP_MODE_DEFAULT = 'loop';
export const GIF_SPEED_DEFAULT = 1;
export const GIF_SPEED_MIN = 0.1;
export const GIF_SPEED_MAX = 10;

/**
 * Clip-local seconds → seconds into the loop, under the layer's playback mode.
 * Pure, so preview and export agree, and exported here so the panel's frame
 * readout resolves exactly what the renderer will draw.
 *
 * @param {number} localTime  clip-local source seconds (trim included)
 * @param {number} duration   one loop, seconds
 * @param {string} mode       'loop' | 'hold' | 'pingpong'
 * @param {number} speed      playback multiplier
 */
export function resolveAnimatedTime(localTime, duration, mode = 'loop', speed = 1) {
  if (!(duration > 0)) return 0;
  const rate = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const t = Math.max(0, localTime) * rate;
  if (mode === 'hold') {
    // Strictly inside the last frame's span, so the final frame is what holds
    // rather than wrapping to frame 0 on the exact boundary.
    return Math.min(t, duration - 1e-6);
  }
  if (mode === 'pingpong') {
    const cycle = duration * 2;
    const phase = t % cycle;
    return phase <= duration ? phase : Math.max(0, cycle - phase - 1e-6);
  }
  return t % duration;
}

/** "A draw asked for a file that has not decoded yet." */
export function animatedImagePending() {
  return outstanding.size > 0;
}

/**
 * Settle every outstanding load. Serialized by the entries' own `ready`
 * promises, so overlapping calls cannot decode a file twice.
 */
export async function pumpAnimatedImages() {
  if (!outstanding.size) return;
  const batch = [...outstanding].map((url) => files.get(url)?.ready).filter(Boolean);
  await Promise.all(batch);
  notify();
}

/**
 * Decode `url` ahead of time — the export/headless warm-up. An export gets ONE
 * pass per encoded frame, so a file still decoding when its first frame is
 * encoded would bake the static fallback into the video.
 */
export function preloadAnimatedImage(url, timeoutMs = 20000) {
  if (!isAnimatedImageCandidate(url)) return Promise.resolve();
  const entry = getAnimatedImage(url);
  if (entry.status !== 'loading') return Promise.resolve();
  return Promise.race([
    entry.ready.then(() => undefined),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/**
 * Loop length for a url that may not be loaded yet — what a freshly added GIF's
 * clip duration is built from. Resolves 0 for stills and undecodable files, which
 * the caller reads as "use the ordinary image duration".
 */
export async function probeAnimatedImageDuration(url, timeoutMs = 20000) {
  if (!isAnimatedImageCandidate(url)) return 0;
  await preloadAnimatedImage(url, timeoutMs);
  return animatedImageDuration(url);
}

/**
 * How long a clip holding this file should be when it first lands on the timeline.
 *
 * The natural loop, so it plays through exactly ONCE — a GIF cut off at the still
 * default's 3s, or padded past its end, is the thing that makes an animated import
 * feel broken. Two adjustments, both about landing on a loop BOUNDARY:
 *
 *   · A loop under a second is repeated a whole number of times until it clears one,
 *     because a 0.3s clip is barely visible on the timeline. Whole loops, so it
 *     still ends where the animation does rather than mid-motion.
 *   · A very long file is capped, since past a point the user is trimming anyway and
 *     a 4-minute clip dropped without warning is worse than one they extend.
 *
 * @param {number} natural   loop length in seconds, 0 for a still/undecodable file
 * @param {number} fallback  the caller's ordinary still-image duration
 */
export function animatedClipDuration(natural, fallback) {
  if (!(natural > 0)) return fallback;
  const loops = Math.max(1, Math.ceil(MIN_CLIP_SECONDS / natural));
  return Math.min(MAX_CLIP_SECONDS, natural * loops);
}

/** Editor teardown. Frees every decoded frame and every lane canvas. */
export function releaseAnimatedImages() {
  for (const url of [...files.keys()]) dropFile(url);
  files.clear();
  lanes.clear();
  outstanding.clear();
}
