// Adaptive raster density for canvas-textured layers — "continuous rasterization"
// in the After Effects sense. See PLANS/CONTINUOUS_RASTERIZATION_PLAN.md.
//
// Text and shape layers are drawn into a 2D canvas at COMPOSITION resolution and
// uploaded as a CanvasTexture, so a close camera move magnifies texels instead of
// resolving detail. This module decides how much denser than composition scale a
// layer's backing canvas should be for the frame being drawn.
//
// Everything here is pure: no THREE, no DOM. The projection that produces
// `screenScaleFromCorners`' input lives in Player.jsx (it needs the real posed
// camera), and every policy decision made from it lives here so it can be tested.
//
// THE INVARIANT THIS MODULE EXISTS TO PROTECT: density changes SHARPNESS ONLY.
// Logical (composition-unit) dimensions drive the plane's world size, layout and
// uniforms and must never be multiplied by density. Physical dimensions
// (logical × density) belong to the backing canvas and the GL texture, nowhere
// else.

// Density steps. Quantized so a continuous camera push-in re-rasterizes a handful
// of times instead of every frame — reallocating a CanvasTexture disposes immutable
// GL storage, so unquantized density would stall the driver mid-move.
//
// Stops at 4x deliberately: text canvases are composition-sized, so 6x of a 4K
// composition is 23040x12960 — past every GPU's maxTextureSize and over a gigabyte.
export const RASTER_DENSITY_BUCKETS = Object.freeze([1, 1.5, 2, 3, 4]);

// Vector (SVG) media rasterizes from a plate the size of the ARTWORK rather than the
// composition, which is what makes the 4x ceiling above wrong for it: a 64px icon
// scaled up 12x really does need 12x, and 12x of 64px is a 768px canvas — nothing.
// The limits that matter here are the hardware ones, and clampDensityToCaps enforces
// those (as does the texture budget), so this ladder simply runs until they bite.
export const VECTOR_DENSITY_BUCKETS = Object.freeze([1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32]);

// How far a layer may exceed a bucket before it steps up to the next one.
//
// NOT a multiplier on the requirement. pickBucket already rounds UP, so a layer is
// never under-sampled; multiplying on top of that (an earlier version used 1.25)
// pushes a layer measuring exactly 1.0 into the 1.5x bucket, which would make every
// shape in every project allocate 2.25x the pixels for no visible gain. Caught by
// running the editor, not by the unit tests — an unmagnified shape came back at 1.5x.
//
// A few percent of under-sampling is invisible, and absorbing it here is what keeps
// the common case free.
export const BUCKET_TOLERANCE = 0.03;

// Used when renderer.capabilities is unreadable. Matches MAX_SHAPE_TEXTURE_DIM,
// which is the conservative floor every GPU we support clears.
export const FALLBACK_MAX_TEXTURE_DIM = 4096;

// Chromium refuses to back a 2D canvas larger than this and then renders it BLANK
// rather than throwing — a silent failure, so the cap is enforced by area as well
// as per-axis. 16384^2 exactly.
export const MAX_CANVAS_AREA = 268435456;

// Hysteresis band. A layer already at some bucket only drops once its need falls
// clearly below the bucket BENEATH it — measured against that lower bucket, not as a
// fraction of the current one. Keying off the current bucket looks reasonable and is
// wrong: 0.75 x 3 = 2.25 sits above the 2x bucket's ceiling, so the hold band between
// 2 and 3 would be empty and a layer parked on that boundary would re-rasterize every
// frame — exactly what the hysteresis exists to prevent.
// Preview only; export must be a pure function of the frame (see resolveDensity).
export const DOWNSHIFT_MARGIN = 0.9;

const GIB = 1024 * 1024 * 1024;

const isPos = (n) => Number.isFinite(n) && n > 0;

// ── Texture quality, a PER-PROJECT setting ──
// It belongs to the project, not the app: it changes what a render looks like, so it
// has to travel with the project rather than depend on which machine opened it.
//   'off'    — composition resolution, exactly the pre-8.9.23 behaviour
//   'smooth' — rasterize at the resolution the layer occupies on screen (default)
//   'extra'  — one bucket finer still, averaged back down for a wider AA edge
export const TEXTURE_QUALITY_OFF = 'off';
export const TEXTURE_QUALITY_SMOOTH = 'smooth';
export const TEXTURE_QUALITY_EXTRA = 'extra';
export const DEFAULT_TEXTURE_QUALITY = TEXTURE_QUALITY_SMOOTH;

/**
 * Accepts the legacy shapes this setting has had (it lived in app prefs first, as a
 * boolean and then as 'sharp') so an early project or pref cannot read as unknown and
 * silently disable itself.
 */
export function sanitizeTextureQuality(value) {
  if (value === true || value === 'sharp') return TEXTURE_QUALITY_SMOOTH;
  if (value === false) return TEXTURE_QUALITY_OFF;
  // 'extra' (supersampling) is WITHDRAWN, not merely hidden — see the note on
  // `supersample` in resolveDensity. Projects that stored it open as Smooth.
  if (value === TEXTURE_QUALITY_EXTRA) return TEXTURE_QUALITY_SMOOTH;
  return value === TEXTURE_QUALITY_OFF || value === TEXTURE_QUALITY_SMOOTH
    ? value
    : DEFAULT_TEXTURE_QUALITY;
}

/**
 * Worst-case on-screen magnification of a layer plane, in screen px per logical px.
 *
 * `corners` are the plane's four corners already projected to screen pixels:
 * { tl, tr, bl, br }, each { x, y }. Every edge is measured rather than just one,
 * because a tilted plane is magnified more at its near edge — taking the max is
 * what keeps that edge from being under-sampled.
 */
export function screenScaleFromCorners(corners, logicalW, logicalH) {
  if (!corners || !isPos(logicalW) || !isPos(logicalH)) return 1;
  const { tl, tr, bl, br } = corners;
  if (!tl || !tr || !bl || !br) return 1;
  const len = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const horizontal = Math.max(len(tl, tr), len(bl, br)) / logicalW;
  const vertical = Math.max(len(tl, bl), len(tr, br)) / logicalH;
  const scale = Math.max(horizontal, vertical);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/**
 * Smallest bucket >= needed, or the largest bucket when nothing is big enough.
 *
 * A non-finite need (a degenerate projection: plane edge-on, or behind the camera)
 * falls back to 1x deliberately — a broken measurement must never be the reason a
 * layer asks for a 4x allocation.
 */
export function pickBucket(needed, buckets = RASTER_DENSITY_BUCKETS) {
  if (!isPos(needed)) return buckets[0];
  for (const bucket of buckets) if (bucket >= needed) return bucket;
  return buckets[buckets.length - 1];
}

/** Largest bucket strictly below `bucket`, or `bucket` itself when it is the floor. */
export function nextLowerBucket(bucket, buckets = RASTER_DENSITY_BUCKETS) {
  let lower = buckets[0];
  for (const candidate of buckets) {
    if (candidate < bucket && candidate > lower) lower = candidate;
  }
  return lower < bucket ? lower : bucket;
}

/** Smallest bucket strictly above `bucket`, or `bucket` itself when it is the ceiling. */
export function nextHigherBucket(bucket, buckets = RASTER_DENSITY_BUCKETS) {
  let higher = buckets[buckets.length - 1];
  for (const candidate of buckets) {
    if (candidate > bucket && candidate < higher) higher = candidate;
  }
  return higher > bucket ? higher : bucket;
}

/**
 * Step a bucket DOWN until the physical canvas fits every hardware limit.
 *
 * `caps.maxDim` is the per-axis limit (renderer.capabilities.maxTextureSize, NOT a
 * hardcoded 8192 — Apple Silicon reports 16384 and clamping below it halves
 * achievable density at 4K). `caps.maxArea` is Chromium's canvas-area limit.
 */
export function clampDensityToCaps(density, logicalW, logicalH, caps = {}, buckets = RASTER_DENSITY_BUCKETS) {
  const maxDim = isPos(caps.maxDim) ? caps.maxDim : FALLBACK_MAX_TEXTURE_DIM;
  const maxArea = isPos(caps.maxArea) ? caps.maxArea : MAX_CANVAS_AREA;
  if (!isPos(logicalW) || !isPos(logicalH)) return 1;
  const fits = (d) => {
    const w = Math.ceil(logicalW * d);
    const h = Math.ceil(logicalH * d);
    return w <= maxDim && h <= maxDim && w * h <= maxArea;
  };
  const ordered = [...buckets].sort((a, b) => b - a);
  for (const bucket of ordered) {
    if (bucket <= density && fits(bucket)) return bucket;
  }
  // Even 1x may exceed the caps for an enormous plate; the caller's existing
  // downscale path (min(1, MAX_SHAPE_TEXTURE_DIM / plate)) still handles that.
  return 1;
}

/**
 * Bytes a layer costs at a given density. Counted TWICE because every magnified
 * layer allocates both a Canvas2D backing store and a GL texture; on unified-memory
 * hardware they come from the same pool, on discrete they come from two pools that
 * both matter.
 */
export function densityBytes(logicalW, logicalH, density) {
  if (!isPos(logicalW) || !isPos(logicalH) || !isPos(density)) return 0;
  return Math.ceil(logicalW * density) * Math.ceil(logicalH * density) * 4 * 2;
}

/**
 * The one entry point Player.jsx calls.
 *
 * `previous` + `interactive` enable hysteresis, which is STATEFUL and therefore
 * preview-only. Export passes interactive:false so the bucket is a pure function of
 * (frame transform, camera pose, output size) — that is what makes a range render at
 * frame N pick the same bucket as a full render at frame N.
 */
export function resolveDensity({
  screenScale,
  logicalW,
  logicalH,
  caps,
  previous = null,
  interactive = false,
  maxDensity = Infinity,
  tolerance = BUCKET_TOLERANCE,
  supersample = false,
  buckets = RASTER_DENSITY_BUCKETS,
}) {
  if (!isPos(screenScale)) return 1;
  const needed = screenScale / (1 + Math.max(0, tolerance));
  let bucket = pickBucket(needed, buckets);
  // Supersampling: rasterize one bucket ABOVE what the screen needs and let the
  // texture average it back down.
  //
  // NOT EXPOSED — kept because the bucket maths is right and tested, but it cannot
  // ship until the alpha pipeline changes. Plain LinearFilter minification is a 4-tap
  // point sample, so at the ~1.33x ratio one bucket gives it widens the antialiasing
  // ramp by nothing at all (measured: 1.06px -> 1.06px). Adding a mip chain does
  // widen it (1.06 -> 1.20) but the clip shader takes STRAIGHT-alpha canvas textures,
  // where transparent texels carry RGB 0 — so mip averaging drags glyph edges toward
  // black: measured 11% of edge pixels darker than both neighbours, versus 1%
  // without. Doing it properly means uploading premultiplied and dividing out in the
  // shader.
  if (supersample) bucket = nextHigherBucket(bucket, buckets);
  if (interactive && isPos(previous) && bucket < previous) {
    // Hold the higher bucket until the need falls clearly below the bucket beneath
    // it — see DOWNSHIFT_MARGIN for why the threshold is not a fraction of `previous`.
    const lower = nextLowerBucket(previous, buckets);
    if (needed > lower * DOWNSHIFT_MARGIN) bucket = previous;
  }
  if (isPos(maxDensity)) bucket = Math.min(bucket, pickBucket(maxDensity, buckets));
  return clampDensityToCaps(bucket, logicalW, logicalH, caps, buckets);
}

/**
 * Auto texture-memory budget.
 *
 * A constant is wrong in both directions: it under-serves a 64 GB unified-memory Mac
 * and over-serves a laptop with 8 GB of discrete VRAM. WebGL cannot report VRAM, so
 * discrete hardware gets a conservative fraction and the user gets an override.
 */
export function autoBudgetBytes({ totalMemoryBytes = 0, unified = false } = {}) {
  if (!isPos(totalMemoryBytes)) return 512 * 1024 * 1024;
  return unified
    ? Math.min(totalMemoryBytes * 0.25, 8 * GIB)
    : Math.min(totalMemoryBytes * 0.125, 1 * GIB);
}

/**
 * Tracks what the adaptive cache has allocated so magnified layers can be demoted
 * back toward 1x before an allocation pushes past the budget.
 *
 * The budget is the planned ceiling; the real backstop is context loss. The renderer
 * already listens for `webglcontextlost` and notes that Electron's GPU process
 * restarts from time to time — on loss while above baseline, halve() the limit and
 * persist it, so hardware that cannot sustain the budget self-corrects and hardware
 * that can is never throttled by a guess.
 */
export function createTextureBudget(limitBytes) {
  const sizes = new Map();
  const seen = new Map();
  let limit = isPos(limitBytes) ? limitBytes : 512 * 1024 * 1024;
  let total = 0;
  let seq = 0;
  return {
    limit: () => limit,
    setLimit(next) { if (isPos(next)) limit = next; },
    halve() { limit = Math.max(64 * 1024 * 1024, limit / 2); return limit; },
    total: () => total,
    note(key, bytes) {
      const value = isPos(bytes) ? bytes : 0;
      total += value - (sizes.get(key) || 0);
      sizes.set(key, value);
      seen.set(key, ++seq);
    },
    touch(key) { if (sizes.has(key)) seen.set(key, ++seq); },
    release(key) {
      total -= sizes.get(key) || 0;
      sizes.delete(key);
      seen.delete(key);
    },
    /** Would adding `bytes` for `key` (replacing whatever it holds) stay inside budget? */
    wouldFit(key, bytes) {
      const value = isPos(bytes) ? bytes : 0;
      return total - (sizes.get(key) || 0) + value <= limit;
    },
    /** Keys least recently magnified first — the order to demote in. */
    coldestKeys(excludeKey = null) {
      return [...sizes.keys()]
        .filter((k) => k !== excludeKey)
        .sort((a, b) => (seen.get(a) || 0) - (seen.get(b) || 0));
    },
    reset() { sizes.clear(); seen.clear(); total = 0; seq = 0; },
  };
}
