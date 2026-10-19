import * as THREE from 'three';
import { TransitionType, LayerTransitionType, TransitionEasing, directionalTransition } from './types';
import { KF_PROP_LABELS, isColorTrackKey, hasAnyTrack } from './keyframeProps';
import { isCssGradient, parseGradient, buildGradient } from '../../utils/cssGradient';
import { isPathTrackKey, decodeShapePathValue, interpolateShapePaths } from './shapePath';
import { bezierEase } from './motionTemplates/mtl';
import { sanitizeBezier, sanitizeEaseSlice, sliceEase } from './easingCurves';
import { advancedTransitionEdgeMirror, resolveAdvancedTransitionOptions } from './advancedTransitions';
import { getTimelineDuration } from './speedUtils';
import { applyKeyframeFxToValues, hasAnyKeyframeFx, setKeyframeTrackSampler } from './keyframeFx';
import { getGsapEase, playedEase } from './appEases';

// The app's named curves and getGsapEase (name → GSAP-style ease string) live in
// appEases.js, shared with the easing picker and flipbooks; re-exported for callers here.
// Named curves resolve through appEases' playedEase, never through an easingEngine
// import of this file's own: registration and lookup must hit the same engine instance
// (vite can serve a second, timestamped copy of a module after a hot update).
export { getGsapEase };

// ── Per-key easing ──
// getGsapEase maps a NAME to a GSAP string, which is all a transition needs. A
// keyframe can additionally carry its own curve, so resolving one needs the whole
// key: CUSTOM reads `key.bezier`, HOLD steps rather than interpolating.
//
// This runs for every track on every layer on every frame, so both branches are
// cached: bezierEase allocates three closures per call, and a fresh one per frame
// per track would be pure garbage.
const HOLD_EASE = () => 0;
const customEaseCache = new Map();

function customEase(bezier) {
  const key = bezier.join(',');
  let fn = customEaseCache.get(key);
  if (!fn) {
    fn = bezierEase(...bezier);
    // Bounded so a session spent dragging handles cannot grow this without limit.
    if (customEaseCache.size > 256) customEaseCache.clear();
    customEaseCache.set(key, fn);
  }
  return fn;
}

// A key cut out of a longer segment by a split plays only part of its easing
// (easingCurves.js, "Ease slices"). Same caching rule: a slice is resolved once and
// reused every frame, keyed by everything that decides it, and an invalid one
// caches as null so the check is not repeated either.
const slicedEaseCache = new Map();

function slicedKeyEase(key) {
  const slice = key.easeSlice;
  const id = `${key.easing}|${slice.of}|${slice.from}|${slice.to}|${key.bezier || ''}|${slice.bezier || ''}`;
  let fn = slicedEaseCache.get(id);
  if (fn === undefined) {
    const valid = sanitizeEaseSlice(key);
    fn = valid ? sliceEase(resolveWholeKeyEase(key), valid.from, valid.to) : null;
    if (slicedEaseCache.size > 256) slicedEaseCache.clear();
    slicedEaseCache.set(id, fn);
  }
  return fn;
}

/**
 * The easing function for the segment that FOLLOWS `key`.
 * Falls back to Smooth when a CUSTOM key has lost or corrupted its bezier, so a bad
 * field degrades to a sane curve instead of a broken animation.
 */
export function resolveKeyEase(key) {
  if (key?.easeSlice) {
    const fn = slicedKeyEase(key);
    if (fn) return fn;
  }
  return resolveWholeKeyEase(key);
}

function resolveWholeKeyEase(key) {
  const easing = key?.easing || TransitionEasing.LINEAR;
  if (easing === TransitionEasing.HOLD) return HOLD_EASE;
  if (easing === TransitionEasing.CUSTOM) {
    const bezier = sanitizeBezier(key?.bezier);
    if (bezier) return customEase(bezier);
    return playedEase(TransitionEasing.EASE_IN_OUT);
  }
  return playedEase(easing);
}

export function applyGsapEasing(rawProgress, easingType) {
  if (getGsapEase(easingType) === 'none') return rawProgress;
  return playedEase(easingType)(rawProgress);
}

function applyMirroredTileUv(material, {
  moveX = 0,
  moveY = 0,
  scale = 1,
  rotXDeg = 0,
  rotYDeg = 0,
  rotZDeg = 0,
  progress = 1,
} = {}) {
  if (!material?.uniforms) return;
  const u = material.uniforms;
  u.uMirrorTile.value = 1.0;

  const rx = Math.abs(Math.sin((rotXDeg * Math.PI) / 180));
  const ry = Math.abs(Math.sin((rotYDeg * Math.PI) / 180));
  const rz = Math.abs(Math.sin((rotZDeg * Math.PI) / 180));

  const safeScale = Math.max(0.2, scale);
  const baseScale = 1 / safeScale;
  const tiltBoostX = 1 + ry * 0.7 + rz * 0.2;
  const tiltBoostY = 1 + rx * 0.7 + rz * 0.2;

  const uvScaleX = Math.max(1, baseScale * tiltBoostX);
  const uvScaleY = Math.max(1, baseScale * tiltBoostY);
  u.uUvScale.value.set(uvScaleX, uvScaleY);

  // Keep UV zoom centered, then apply directional movement in UV space.
  const centerOffsetX = (1 - uvScaleX) * 0.5;
  const centerOffsetY = (1 - uvScaleY) * 0.5;
  u.uUvOffset.value.x += centerOffsetX - (moveX / 100) * progress;
  u.uUvOffset.value.y += centerOffsetY + (moveY / 100) * progress;
}

function applyTileMeshCoverage(mesh, {
  scale = 1,
  rotXDeg = 0,
  rotYDeg = 0,
  rotZDeg = 0,
} = {}) {
  if (!mesh) return;
  const rx = (rotXDeg * Math.PI) / 180;
  const ry = (rotYDeg * Math.PI) / 180;
  const rz = (rotZDeg * Math.PI) / 180;
  const cosX = Math.max(0.2, Math.abs(Math.cos(rx)));
  const cosY = Math.max(0.2, Math.abs(Math.cos(ry)));
  const zSpread = Math.abs(Math.cos(rz)) + Math.abs(Math.sin(rz)); // 1..1.414
  const sx = Math.max(1, 1 / Math.max(0.2, scale * cosY / zSpread));
  const sy = Math.max(1, 1 / Math.max(0.2, scale * cosX / zSpread));
  mesh.scale.x *= sx;
  mesh.scale.y *= sy;
}

/* ── Point-aimed transitions ───────────────────────────────────────────────
 *
 * 'Advanced Zoom' and 'Advanced Movement' do all of their geometry in UV space
 * (uUvScale/uUvOffset) instead of moving the mesh. Three things fall out of that
 * which the mesh route cannot give:
 *
 *  - the layer always covers the frame, so mirror tile has something to fill
 *    the vacated area with at any pivot, not just the centre;
 *  - the fragment stage knows the motion, so it can smear along it — a mesh
 *    offset carries no velocity into the shader (which is why every existing
 *    sliding transition is unblurred);
 *  - the pivot is a fixed point of the transform, so the blur rays and the
 *    scale ramp cannot drift apart.
 *
 * Screen→source for a scale s about pivot c is  q = c + (p − c)/s, and for a
 * translation d it is  q = p − d. Both are  q = p·A + B, which is exactly the
 * uUvScale/uUvOffset pair the shader already applies.
 */
function applyUvTransform(material, { scale = 1, centre = { x: 0.5, y: 0.5 }, offset = { x: 0, y: 0 }, mirror = false }) {
  if (!material?.uniforms) return;
  const u = material.uniforms;
  const s = Math.max(0.02, scale);
  const inv = 1 / s;
  u.uUvScale.value.set(inv, inv);
  // uv → c + (uv − offset − c)/s, expanded into the shader's scale-then-offset form.
  u.uUvOffset.value.set(
    centre.x * (1 - inv) - offset.x * inv,
    centre.y * (1 - inv) - offset.y * inv,
  );
  u.uMirrorTile.value = mirror ? 1.0 : 0.0;
}

/*
 * Blur envelope.
 *
 * applyCrossTransition is handed progress that is ALREADY eased, so the speed of
 * the move is not directly available. Sampling the easing into a table lets us
 * recover it: the slope of the segment containing the current eased value is the
 * speed there, normalised by the curve's own peak so "strength" always means the
 * value at the peak whatever curve is chosen.
 *
 * (Overshooting curves are not monotone, so the located segment can be the wrong
 * one near the overshoot; the envelope stays in range, it just reads the speed of
 * a neighbouring segment.)
 */
const EASE_TABLE_STEPS = 64;
const easeTables = new Map();
function easeTable(easingType) {
  const key = easingType || '__default__';
  if (!easeTables.has(key)) {
    const values = new Float32Array(EASE_TABLE_STEPS + 1);
    for (let i = 0; i <= EASE_TABLE_STEPS; i++) values[i] = applyGsapEasing(i / EASE_TABLE_STEPS, easingType);
    let peak = 0;
    for (let i = 0; i < EASE_TABLE_STEPS; i++) peak = Math.max(peak, values[i + 1] - values[i]);
    easeTables.set(key, { values, peak: peak || 1 });
  }
  return easeTables.get(key);
}

function transitionBlurEnvelope(profile, easedProgress, easingType) {
  const t = Math.min(1, Math.max(0, easedProgress));
  if (profile === 'constant') return 1;
  if (profile === 'peak') return Math.sin(Math.PI * t);
  const { values, peak } = easeTable(easingType);
  let i = 0;
  while (i < EASE_TABLE_STEPS - 1 && values[i + 1] < t) i++;
  return Math.max(0, Math.min(1, (values[i + 1] - values[i]) / peak));
}

/** Cross-blend centred on the cut. A narrow window reads as a whip cut, a wide one as a dissolve. */
function transitionBlend(p, windowPercent, pointPercent) {
  const w = Math.max(0, (windowPercent ?? 26) / 100);
  const c = Math.min(1, Math.max(0, (pointPercent ?? 50) / 100));
  // No window at all is a hard cut ON the blend point: both lanes stay at full
  // opacity and the swap happens in one frame, with the move carrying it.
  if (w <= 0) return p < c ? 0 : 1;
  // The point is where the two clips are level, and it lands exactly where it
  // was put — at any window width. Each side gets half the window, or whatever
  // room is left between the point and that end if that is less, so the blend
  // always starts at 0 and is finished by the cut without the point having to be
  // pulled back toward the middle (which made it do nothing on a wide window).
  // A floor keeps a squeezed side a ramp rather than a step.
  const back = Math.max(0.01, Math.min(w / 2, c));
  const fwd = Math.max(0.01, Math.min(w / 2, 1 - c));
  const u = p <= c
    ? 0.5 * Math.max(0, (p - (c - back)) / back)
    : 0.5 + 0.5 * Math.min(1, (p - c) / fwd);
  return u * u * (3 - 2 * u);
}

/** A point option as frame fractions (0..1, top-left origin — the space it is stored in). */
function pointOption(options, key, fallbackX = 50, fallbackY = 50) {
  const raw = options?.[key];
  return {
    x: (Number.isFinite(raw?.x) ? raw.x : fallbackX) / 100,
    y: (Number.isFinite(raw?.y) ? raw.y : fallbackY) / 100,
  };
}

/** The same point in UV space, where v counts UP from the bottom of the frame. */
function uvPointOption(options, key, fallbackX = 50, fallbackY = 50) {
  const point = pointOption(options, key, fallbackX, fallbackY);
  return { x: point.x, y: 1 - point.y };
}

// Channel displacement at 100% RGB split: a fraction of the distance from the
// point (radial) or of the frame (directional). Past this the channels read as
// three separate images rather than as fringing on one.
const RGB_SPLIT_MAX = 0.05;

/* ── Fisheye + wiggle ──────────────────────────────────────────────────────
 *
 * Both hang off the SAME time envelope as the blur and the RGB split, so
 * everything the transition does builds into the cut and falls away together.
 *
 * The split of labour between JS and the shader follows what each thing IS. The
 * lens is a per-pixel warp, so it is a uniform. The tremble is a rigid move, so
 * it is JS — the shader only needs the roll, because a rotation is the one part
 * of it the scale/offset pair cannot express.
 */

// Slider 100% → this lens constant, and → this much frame HEIGHT of shake. Past
// these the lens folds and the shake stops reading as a camera.
const FISHEYE_K_MAX = 1.0;
const WIGGLE_MAX = 0.075;

function applyFisheyeUniforms(materials, { amount = 0, model, fit = true, centre } = {}) {
  for (const material of materials) {
    const u = material?.uniforms;
    if (!u?.uFisheye) continue;
    u.uFisheye.value = Number.isFinite(amount) ? amount : 0;
    u.uFisheyeModel.value = model === 'barrel' ? 1 : 0;
    u.uFisheyeFit.value = fit === false ? 0 : 1;
    u.uFisheyeCenter.value.set(centre?.x ?? 0.5, centre?.y ?? 0.5);
  }
}

/*
 * The tremble and Advanced Zoom's Rotation are the same camera roll, so they
 * share one uniform and one pivot: the angles ADD, and the pivot is the spin's
 * (the zoom point) whenever a spin is running. With Rotation at 0 — every
 * project written before it existed — `roll` is null and this is exactly the
 * frame-centre tremble it always was.
 */
function applyWiggleUniforms(materials, wiggle, roll) {
  for (const material of materials) {
    const u = material?.uniforms;
    if (!u?.uUvPreOffset) continue;
    u.uUvPreOffset.value.set(wiggle?.x || 0, wiggle?.y || 0);
    u.uUvRotate.value = (roll?.angle || 0) + (wiggle?.roll || 0);
    if (u.uUvRotateCenter) {
      u.uUvRotateCenter.value.set(roll?.centre?.x ?? 0.5, roll?.centre?.y ?? 0.5);
    }
  }
}

/*
 * Value noise with a quintic fade — C1 continuous, so the tremble accelerates
 * between samples instead of snapping the way raw white noise would. It is a
 * function of PROGRESS and nothing else: no wall-clock, no frame counter, no
 * accumulated state. A scrub, a live preview and an export must land on the
 * same tremble for the same frame, and only a pure function of progress does.
 */
function wiggleHash(i, seed) {
  const x = Math.sin(i * 127.1 + seed * 311.7 + 13.7) * 43758.5453;
  return x - Math.floor(x);
}

function wiggleNoise(t, seed) {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  const a = wiggleHash(i, seed) * 2 - 1;
  const b = wiggleHash(i + 1, seed) * 2 - 1;
  return a + (b - a) * u;
}

function wiggleFbm(t, seed, rough) {
  const base = wiggleNoise(t, seed);
  if (rough < 0.002) return base;
  return (base + rough * wiggleNoise(t * 2.73 + 11.3, seed + 7.5)) / (1 + rough);
}

/* A hump that can lean: rises to `peak`, falls after it. The tremble usually
 * wants to crest just BEFORE the cut rather than exactly on it, and `sharp` is
 * the exponent that decides how tightly it hugs that crest. */
function skewHump(t, peak, sharp) {
  const c = Math.min(0.98, Math.max(0.02, peak));
  const u = t < c ? t / c : (1 - t) / (1 - c);
  return Math.pow(Math.sin(Math.PI * 0.5 * Math.min(1, Math.max(0, u))), Math.max(0.15, sharp));
}

/* The fisheye's own envelope. 'blur' means "whatever the blur is doing", which
 * is the default because the three reading as one gesture is the point. */
function transitionFisheyeAmount(options, blurEnv, easedProgress, easingType) {
  const strength = (options.fisheye ?? 0) / 100;
  if (!strength) return 0;
  const profile = options.fisheyeProfile || 'blur';
  const env = profile === 'blur' ? blurEnv : transitionBlurEnvelope(profile, easedProgress, easingType);
  return strength * FISHEYE_K_MAX * env;
}

/* ── Exposure flash ────────────────────────────────────────────────────────
 *
 * The Transition Builder's fxFlash, shared by the point-aimed pair. Same curve
 * as the builder's (env^1.6, so the wash stays out of the way until the gesture
 * is really moving) and the same ceiling, so a config carried over from a
 * custom transition reads the same at the same percentage.
 *
 * Written as a uniform on the clip material, which is why one implementation
 * covers both renderers: the TSL clip material exposes the identical
 * `uFlashAmount` / `uFlashColor` facade the GLSL one does.
 */
function transitionFlashAmount(options, blurEnv, easedProgress, easingType) {
  const strength = (options.flash ?? 0) / 100;
  if (strength <= 0) return 0;
  const profile = options.flashProfile || 'blur';
  const env = profile === 'blur' ? blurEnv : transitionBlurEnvelope(profile, easedProgress, easingType);
  if (env <= 0) return 0;
  return Math.min(1, strength * Math.pow(env, 1.6));
}

/* Option colours arrive as '#rgb' / '#rrggbb', and the inspector's picker emits
 * 'rgba(r, g, b, a)' once its alpha slider is touched — so that form is parsed
 * too rather than falling back to white on a colour the user did pick. The alpha
 * half is dropped: the wash carries its own strength, and honouring both would
 * mean two controls fighting over one number. Anything else falls back. */
function optionColorHex(value, fallback = 0xffffff) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:[,/][^)]*)?\)$/i.exec(raw);
  if (rgb) {
    const channel = (index) => Math.min(255, Number(rgb[index]));
    return (channel(1) << 16) | (channel(2) << 8) | channel(3);
  }
  const hex = raw.replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return parseInt(hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2], 16);
  }
  if (/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return parseInt(hex.slice(0, 6), 16);
  return fallback;
}

/* ── Transition bloom ───────────────────────────────────────────────────────
 *
 * Highlights leaking while the move is at speed — the third member of the
 * optics cluster. env^1.4: softer knee than the flash's 1.6 so the leak is
 * already breathing while the gesture builds, but still parked at the ends.
 * Strength is deliberately unclamped up to 3 (the field's 300%) — an overdriven
 * bloom that blows the frame out is a look the flash can't fake, since the wash
 * converges on one colour where the bloom stays an image.
 */
function transitionBloomAmount(options, blurEnv, easedProgress, easingType) {
  const strength = (options.bloom ?? 0) / 100;
  if (strength <= 0) return 0;
  const profile = options.bloomProfile || 'blur';
  const env = profile === 'blur' ? blurEnv : transitionBlurEnvelope(profile, easedProgress, easingType);
  if (env <= 0) return 0;
  return Math.min(3, strength * Math.pow(env, 1.4));
}

function applyBloomUniforms(materials, { amount = 0, threshold = 60, radius = 36 } = {}) {
  for (const material of materials) {
    const u = material?.uniforms;
    if (!u?.uBloomAmount) continue;
    u.uBloomAmount.value = Math.max(0, Math.min(3, amount));
    // Like the flash colour, the shape uniforms are only written while the bloom
    // is actually on — resetMaterialUniforms cleared the amount this frame.
    if (amount > 0) {
      if (u.uBloomThreshold) u.uBloomThreshold.value = Math.max(0, Math.min(1, threshold / 100));
      if (u.uBloomRadius) u.uBloomRadius.value = Math.max(1, Math.min(200, radius));
    }
  }
}

function applyFlashUniforms(materials, { amount = 0, color } = {}) {
  for (const material of materials) {
    const u = material?.uniforms;
    if (!u?.uFlashAmount) continue;
    u.uFlashAmount.value = Math.max(0, Math.min(1, amount));
    // Only touch the colour when the wash is actually on: resetMaterialUniforms
    // already put it back to white this frame, and writing it regardless would
    // make the branch read as if the flash were always running.
    if (amount > 0 && u.uFlashColor) u.uFlashColor.value.setHex(optionColorHex(color));
  }
}

/*
 * One tremble sample.
 *
 * The envelope runs on EASED progress so its swell lines up with the blur peak
 * and the blend — which is what "peak at the cut" has to mean. The noise phase
 * runs on RAW time, so the shake keeps a constant frequency instead of speeding
 * up wherever the easing happens to be fast. They are different clocks on
 * purpose.
 *
 * Amount is the MASTER: it scales the roll as well as the offset, so 0 means no
 * tremble at all and the slider ramps the whole shake in continuously. Rotation
 * is how many degrees of roll the tremble reaches at Amount 100%, not a second
 * shake running on its own — a non-zero Rotation with Amount at 0 used to
 * wobble every point transition even though both default to OFF.
 */
function transitionWiggle(options, { easedProgress, rawProgress, duration, easingType, aspect, lane = 0 }) {
  const amount = (options.wiggle ?? 0) / 100;
  if (amount <= 0) return null;
  const rollDeg = options.wiggleRotate ?? 0;

  const profile = options.wiggleProfile || 'peak';
  const sharp = Math.max(0.15, options.wiggleSharp ?? 1.4);
  const t = Math.min(1, Math.max(0, easedProgress));
  const env = profile === 'constant'
    ? 1
    : profile === 'velocity'
      ? Math.pow(transitionBlurEnvelope('velocity', t, easingType), sharp)
      : skewHump(t, (options.wigglePeak ?? 50) / 100, sharp);
  if (env <= 0) return null;

  const seed = (options.wiggleSeed ?? 7) + lane * 23;
  const rough = (options.wiggleRough ?? 40) / 100;
  const phase = Math.max(0, rawProgress) * Math.max(0.01, duration || 1) * (options.wiggleFreq ?? 14);
  const amp = amount * WIGGLE_MAX * env;
  return {
    // amp is in frame HEIGHTS; x divides by the aspect so the shake stays
    // circular in pixels rather than being stretched by a wide comp.
    x: (wiggleFbm(phase, seed, rough) * amp) / (aspect || 1),
    y: wiggleFbm(phase + 57.3, seed + 3, rough) * amp,
    roll: wiggleFbm(phase * 0.83 + 21.7, seed + 11, rough) * ((rollDeg * Math.PI) / 180) * amount * env,
  };
}

/* Both layers share one tremble by default — a single offset is what reads as
 * ONE camera shaking. Per-layer seeds make the two clips disagree, which is
 * occasionally the point and usually a mistake. */
function applyTransitionCameraWarp(prevMesh, currMesh, options, ctx, rolls = null) {
  const wiggle = transitionWiggle(options, ctx);
  applyWiggleUniforms([prevMesh.material], wiggle, rolls?.prev);
  applyWiggleUniforms(
    [currMesh.material],
    options.wiggleShared === false ? transitionWiggle(options, { ...ctx, lane: 1 }) : wiggle,
    rolls?.curr,
  );
}

function applyPointBlurUniforms(materials, { centre, zoom = 0, move, split = 0, splitMove, tileFade = 0 } = {}) {
  for (const material of materials) {
    const u = material?.uniforms;
    if (!u) continue;
    u.uZoomBlur.value = Math.max(0, zoom);
    if (u.uZoomCenter && centre) u.uZoomCenter.value.set(centre.x, centre.y);
    if (u.uMoveBlur) u.uMoveBlur.value.set(move?.x || 0, move?.y || 0);
    if (u.uRgbSplit) u.uRgbSplit.value = Math.max(0, split);
    if (u.uSplitMove) u.uSplitMove.value.set(splitMove?.x || 0, splitMove?.y || 0);
    if (u.uTileFade) u.uTileFade.value = Math.max(0, Math.min(1, (tileFade ?? 0) / 100));
  }
}

/*
 * The blend window, both lanes.
 *
 * The outgoing lane ramps down while the incoming ramps up — the cross-blend the
 * Blend window control has always described, and it stays that way whatever the
 * edge fill is set to. What used to make "No fill" unusable was not this ramp
 * but the shader: the area a lane vacated was painted OPAQUE BLACK (its
 * letterbox path), so an incoming lane with no fill stamped a hard black
 * rectangle over the outgoing clip instead of letting it show through and fade
 * on its own ramp. That is fixed in clipShader/clipShaderNodes (`uvPushedOut`),
 * so the fade here is free to work exactly as it did.
 */
function applyLaneBlend(material, mix, lane) {
  material.uniforms.uOpacity.value *= lane === 'prev' ? (1 - mix) : mix;
}

/* ── The point-aimed pair, one lane at a time ───────────────────────────────
 *
 * A cross Advanced Zoom / Advanced Movement is TWO lanes of one continuous
 * move: the outgoing clip travels one "step" (a scale ratio, or a translation)
 * while the incoming starts one step behind and lands home. Neither lane knows
 * about the other — the only thing they share is the ramp and the blend.
 *
 * That is exactly why these work as layer entrances and exits. A layer has one
 * plate, not two, so an entrance IS the incoming lane on its own and an exit IS
 * the outgoing lane on its own. Splitting the per-lane work out here means the
 * cross path and the in/out path run the SAME arithmetic rather than two
 * implementations that drift; `lane` is the only thing that differs.
 *
 * `q` is always forward transition progress (0 = before, 1 = after) whichever
 * slot is driving, so the lane never has to reason about playback direction.
 */

function advancedZoomPlan(options, q, easingType) {
  // One continuous exponential ramp: 'prev' travels 1 → g and 'curr' g⁻¹ → 1,
  // so the two are always one octave apart on the SAME zoom and the cut is a
  // scale jump of exactly g. 'out' is the ramp inverted — one code path.
  const span = 0.55 * ((options.zoomStrength ?? 100) / 100);
  const growth = options.direction === 'out' ? 1 / (1 + span) : 1 + span;
  return {
    centre: uvPointOption(options, 'point', 50, 50),
    lnG: Math.log(growth),
    // Rotation is that same step in angle: 'prev' turns 0 → spin and 'curr'
    // −spin → 0, so the cut is a turn of exactly `spin` and the two lanes are
    // never spinning against each other. Positive is clockwise on screen (the
    // shader rotates the SAMPLING uv, which turns the picture the other way).
    spin: ((options.rotation ?? 0) * Math.PI) / 180,
    env: transitionBlurEnvelope(options.blurProfile, q, easingType),
    mix: transitionBlend(q, options.blendWindow, options.blendPoint),
  };
}

/*
 * The spin is a camera roll, not a UV window like the zoom, so it is handed to
 * the roll uniform the tremble already owns rather than applied here. null when
 * Rotation is 0 — the tremble then keeps its own frame-centre pivot.
 */
function advancedZoomLaneRoll(plan, q, lane) {
  if (!plan?.spin) return null;
  return { angle: plan.spin * (lane === 'prev' ? q : q - 1), centre: plan.centre };
}

function applyAdvancedZoomLane(material, plan, options, q, lane, easingType) {
  const { centre, env } = plan;
  // Edge fill is the one thing the two lanes may disagree on, so it is resolved
  // here rather than in the shared plan.
  const mirror = advancedTransitionEdgeMirror(options, lane);
  applyUvTransform(material, { scale: Math.exp(plan.lnG * (lane === 'prev' ? q : q - 1)), centre, mirror });
  applyLaneBlend(material, plan.mix, lane);
  applyPointBlurUniforms([material], {
    centre,
    zoom: ((options.blurStrength ?? 0) / 100) * env,
    // Radial split: the offset grows with distance from the point, so the
    // fringing spreads outward from whatever the zoom is aimed at.
    split: ((options.rgbSplit ?? 0) / 100) * env * RGB_SPLIT_MAX,
    tileFade: mirror ? options.tileFade : 0,
  });
  applyFisheyeUniforms([material], {
    amount: transitionFisheyeAmount(options, env, q, easingType),
    model: options.fisheyeModel,
    fit: options.fisheyeFit,
    centre: options.fisheyeCentre === 'frame' ? { x: 0.5, y: 0.5 } : centre,
  });
  // Both lanes take the SAME wash. They are cross-blending under it, so washing
  // only one would read as a colour cast on one clip rather than as the frame
  // blowing out.
  applyFlashUniforms([material], {
    amount: transitionFlashAmount(options, env, q, easingType),
    color: options.flashColor,
  });
  // Both lanes bloom together for the same reason the flash washes both.
  applyBloomUniforms([material], {
    amount: transitionBloomAmount(options, env, q, easingType),
    threshold: options.bloomThreshold,
    radius: options.bloomRadius,
  });
}

/* ── Motion path (Advanced Movement's second travel type) ───────────────────
 *
 * Instead of one straight direction, the travel follows a drawn path: anchors
 * in percent-of-comp (the shared point convention, so a path survives a
 * resolution change), auto-smoothed through with Catmull-Rom blended against
 * the polyline by `pathSmooth`, then resampled into a TIME-parameterized LUT —
 * each segment gets its timing share of the eased progress at constant speed,
 * so a short-share segment whips (and, below, blurs harder).
 *
 * The LUT lives in ASPECT space with y DOWN (the space the anchors are stored
 * in); the plan converts to UV on the way out. Anchors are relative to the
 * FIRST one — the path is a movement, not a position — and 'from' traverses it
 * reversed, shares included. Only the sampled offset/tangent reach the shader:
 * the GLSL is untouched, straight mode simply bypasses all of this.
 */
const MOVE_PATH_N = 192;
const MOVE_PATH_SEG = 24;
const movePathCache = new Map();

function buildMovePathLut(rel, weights, smooth) {
  // Dense samples of the smoothed curve: per segment, Catmull-Rom (clamped
  // ends) mixed against the straight chord. Anchor i lands at dense index
  // i·MOVE_PATH_SEG exactly, which is what lets the shares slice the curve.
  const n = rel.length;
  const P = (i) => rel[Math.max(0, Math.min(n - 1, i))];
  const qx = []; const qy = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = P(i - 1); const p1 = P(i); const p2 = P(i + 1); const p3 = P(i + 2);
    const last = i === n - 2;
    for (let k = 0; k <= (last ? MOVE_PATH_SEG : MOVE_PATH_SEG - 1); k++) {
      const u = k / MOVE_PATH_SEG; const u2 = u * u; const u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1; const h10 = u3 - 2 * u2 + u;
      const h01 = -2 * u3 + 3 * u2; const h11 = u3 - u2;
      const cr = (a0, a1, a2, a3) => h00 * a1 + h10 * 0.5 * (a2 - a0) + h01 * a2 + h11 * 0.5 * (a3 - a1);
      const cx = cr(p0[0], p1[0], p2[0], p3[0]); const cy = cr(p0[1], p1[1], p2[1], p3[1]);
      const lx = p1[0] + (p2[0] - p1[0]) * u; const ly = p1[1] + (p2[1] - p1[1]) * u;
      qx.push(lx + (cx - lx) * smooth);
      qy.push(ly + (cy - ly) * smooth);
    }
  }

  const M = qx.length - 1;
  const cum = new Float64Array(M + 1);
  for (let j = 1; j <= M; j++) cum[j] = cum[j - 1] + Math.hypot(qx[j] - qx[j - 1], qy[j] - qy[j - 1]);
  const Ltotal = Math.max(cum[M], 1e-9);

  const wSum = weights.reduce((a, b) => a + b, 0) || 1;
  const T = [0];
  weights.forEach((x) => T.push(T[T.length - 1] + x / wSum));
  T[T.length - 1] = 1;
  const A = weights.map((_, i) => cum[Math.min(M, (i + 1) * MOVE_PATH_SEG)]);
  A.unshift(0);

  const N = MOVE_PATH_N;
  const px = new Float64Array(N + 1); const py = new Float64Array(N + 1);
  const tx = new Float64Array(N + 1); const ty = new Float64Array(N + 1);
  const sp = new Float64Array(N + 1);
  let seg = 0; let j = 0;
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    while (seg < weights.length - 1 && t >= T[seg + 1]) seg++;
    const dT = Math.max(T[seg + 1] - T[seg], 1e-9);
    const u = Math.min(1, Math.max(0, (t - T[seg]) / dT));
    const target = A[seg] + (A[seg + 1] - A[seg]) * u;
    while (j < M - 1 && cum[j + 1] < target) j++;
    const dseg = Math.max(cum[j + 1] - cum[j], 1e-9);
    const f = Math.min(1, Math.max(0, (target - cum[j]) / dseg));
    px[k] = qx[j] + (qx[j + 1] - qx[j]) * f;
    py[k] = qy[j] + (qy[j + 1] - qy[j]) * f;
    const dx = qx[j + 1] - qx[j]; const dy = qy[j + 1] - qy[j];
    const nl = Math.hypot(dx, dy) || 1;
    tx[k] = dx / nl; ty[k] = dy / nl;
    sp[k] = (A[seg + 1] - A[seg]) / dT;
  }
  return { px, py, tx, ty, sp, N, Ltotal, net: [px[N], py[N]] };
}

function movePathLut(options, ar) {
  const path = options.travelPath;
  const pts = Array.isArray(path?.points) ? path.points : [];
  if (options.travelMode !== 'path' || pts.length < 2) return null;
  const shares = Array.isArray(path?.shares) ? path.shares : [];
  const smooth = Math.max(0, Math.min(1, (options.pathSmooth ?? 65) / 100));
  const strength = (options.travelStrength ?? 100) / 100;
  const reversed = options.direction === 'from';
  const key = JSON.stringify([pts, shares, smooth, strength, reversed, Math.round(ar * 1000)]);
  const hit = movePathCache.get(key);
  if (hit) return hit;
  let rel = pts.map((p) => [
    (((Number.isFinite(p?.x) ? p.x : 50) - (Number.isFinite(pts[0]?.x) ? pts[0].x : 50)) / 100) * ar * strength,
    (((Number.isFinite(p?.y) ? p.y : 50) - (Number.isFinite(pts[0]?.y) ? pts[0].y : 50)) / 100) * strength,
  ]);
  let weights = pts.slice(1).map((_, i) => {
    const w = shares[i];
    return Number.isFinite(w) ? Math.max(5, Math.min(500, w)) : 100;
  });
  if (reversed) {
    const last = rel[rel.length - 1];
    rel = rel.slice().reverse().map((p) => [p[0] - last[0], p[1] - last[1]]);
    weights = weights.slice().reverse();
  }
  const lut = buildMovePathLut(rel, weights, smooth);
  if (movePathCache.size > 16) movePathCache.clear();
  movePathCache.set(key, lut);
  return lut;
}

function movePathSample(lut, q) {
  const f = Math.min(1, Math.max(0, q)) * lut.N;
  const j = Math.min(lut.N - 1, Math.floor(f));
  const fr = f - j;
  const lerp = (a) => a[j] + (a[j + 1] - a[j]) * fr;
  let dx = lerp(lut.tx); let dy = lerp(lut.ty);
  const nl = Math.hypot(dx, dy) || 1;
  return { x: lerp(lut.px), y: lerp(lut.py), tx: dx / nl, ty: dy / nl, sp: lerp(lut.sp) };
}

function advancedMovePlan(options, q, easingType, W, H) {
  // Direction and distance are resolved in "aspect space" (the frame is ar × 1)
  // so an angle is the angle you see. Travel is measured in CLEARANCES — the
  // distance that exactly empties the frame along that direction — which is why
  // 100% means the same thing at any angle.
  const point = pointOption(options, 'point', 92, 50);
  const ar = H > 0 ? W / H : 1;
  let dx = (point.x - 0.5) * ar;
  let dy = (point.y - 0.5);
  let dist = Math.hypot(dx, dy);
  if (dist < 1e-4) { dx = 1; dy = 0; dist = 0; }   // dead centre → default right
  const norm = Math.hypot(dx, dy) || 1;
  const sign = options.direction === 'from' ? -1 : 1;
  const ux = (dx / norm) * sign;
  const uy = (dy / norm) * sign;

  const clearance = Math.abs(ux) * ar + Math.abs(uy);
  const halfDiagonal = Math.hypot(ar / 2, 0.5);
  const distanceFactor = options.usePointDistance ? Math.min(1.5, dist / halfDiagonal) : 1;
  const env = transitionBlurEnvelope(options.blurProfile, q, easingType);
  const travel = clearance * ((options.travelStrength ?? 100) / 100) * distanceFactor;
  // Aspect space → UV: x compresses by the aspect, y flips (UV counts up).
  const toUv = (length) => ({ x: (ux * length) / ar, y: -(uy * length) });

  const lut = movePathLut(options, ar);
  return {
    point,
    ar,
    env,
    mix: transitionBlend(q, options.blendWindow, options.blendPoint),
    squeeze: 1 - ((options.squeeze ?? 0) / 100) * env,
    travel,
    toUv,
    // The lane's travel offset at progress qq, in UV. Outgoing rides P(q); the
    // incoming rides the SAME path offset by the net displacement, P(q) − P(1),
    // so at q = 1 it lands exactly home — one continuous move whatever the
    // shape. With one straight leg this is the shipped `travel · (q | q−1)`.
    laneOffsetUv: (lane, qq) => {
      if (!lut) return toUv(travel * (lane === 'prev' ? qq : qq - 1));
      const s = movePathSample(lut, qq);
      const ox = lane === 'prev' ? s.x : s.x - lut.net[0];
      const oy = lane === 'prev' ? s.y : s.y - lut.net[1];
      return { x: ox / ar, y: -oy };
    },
    // A vector of aspect-space length `len` along the LOCAL travel direction at
    // progress qq, in UV — the blur and the RGB split follow the path's bends.
    travelVecUv: (len, qq) => {
      if (!lut) return toUv(len);
      const s = movePathSample(lut, qq);
      return { x: (s.tx * len) / ar, y: -(s.ty * len) };
    },
    // Unit travel direction in aspect space with y UP (the shader's frame),
    // for the perspective tilt's Auto axis.
    dirAspect: (qq) => {
      if (!lut) return { x: ux, y: -uy };
      const s = movePathSample(lut, qq);
      return { x: s.tx, y: -s.ty };
    },
    // Segments with a small timing share move faster than the mean — the blur
    // scales with that local speed, so a whip segment smears harder.
    speedFactor: (qq) => {
      if (!lut) return 1;
      return Math.min(2.5, movePathSample(lut, qq).sp / lut.Ltotal);
    },
  };
}

/*
 * Perspective (Advanced Movement): each lane's plate is a card tilted in 3D.
 * LEAN tips both lanes into the travel on the shared envelope; SWING is the
 * travel's own ramp in angle — out 0 → θ, in −θ → 0, one continuous card turn
 * across the cut. The Auto axis follows the LOCAL heading, so on a motion path
 * the plate leans into each bend in turn. The pivot rides the lane's travelled
 * centre (or holds the frame centre on 'camera'), and the whole thing is
 * per-lane state on per-lane materials — reset clears it every frame.
 */
function applyMovePerspective(material, plan, options, q, lane, laneOffset) {
  const u = material?.uniforms;
  if (!u?.uPerspTilt) return;
  const amt = (Math.max(-80, Math.min(80, options.perspective ?? 0)) * Math.PI) / 180;
  const tilt = !amt ? 0 : (options.perspectiveMode === 'swing'
    ? amt * (lane === 'prev' ? q : q - 1)
    : amt * plan.env);
  u.uPerspTilt.value = tilt;
  if (!tilt) return;
  let axisX = 0; let axisY = 1;
  if (options.perspectiveAxis === 'pitch') { axisX = 1; axisY = 0; }
  else if (options.perspectiveAxis !== 'yaw') {
    const dir = plan.dirAspect(q);
    const n = Math.hypot(dir.x, dir.y) || 1;
    axisX = -dir.y / n; axisY = dir.x / n;
  }
  u.uPerspAxis.value.set(axisX, axisY);
  u.uPerspDist.value = Math.max(0.2, options.perspectiveDepth ?? 1.8);
  const onPlate = options.perspectiveAttach !== 'camera';
  u.uPerspPivot.value.set(
    0.5 + (onPlate ? laneOffset.x : 0),
    0.5 + (onPlate ? laneOffset.y : 0),
  );
  u.uPerspShade.value = Math.max(0, Math.min(1, (options.perspectiveShade ?? 35) / 100));
}

function applyAdvancedMoveLane(material, plan, options, q, lane, easingType) {
  const { env } = plan;
  const mirror = advancedTransitionEdgeMirror(options, lane);
  // "Opposite on incoming" mirrors the squeeze about 1 on the arriving lane:
  // the outgoing gives back 1 − s while the incoming pushes 1 + s, so the
  // hand-off reads as a counter-move instead of both lanes breathing together.
  const scale = lane === 'curr' && options.squeezeOpposite ? 2 - plan.squeeze : plan.squeeze;
  const laneOffset = plan.laneOffsetUv(lane, q);
  applyUvTransform(material, { scale, offset: laneOffset, mirror });
  applyLaneBlend(material, plan.mix, lane);
  const speedBoost = plan.speedFactor(q);
  applyPointBlurUniforms([material], {
    move: plan.travelVecUv(((options.blurStrength ?? 0) / 100) * 0.5 * env * speedBoost, q),
    // Directional split: a flat offset along the travel, so the channels
    // trail the move rather than spreading from a centre.
    splitMove: plan.travelVecUv(((options.rgbSplit ?? 0) / 100) * env * RGB_SPLIT_MAX, q),
    tileFade: mirror ? options.tileFade : 0,
  });
  applyMovePerspective(material, plan, options, q, lane, laneOffset);
  // The travel already lives in uUvOffset, so the lens sits between the two:
  // content slides THROUGH a lens that stays put, which is what a real one
  // does. The point option is stored y-down; the lens reads frame UV.
  applyFisheyeUniforms([material], {
    amount: transitionFisheyeAmount(options, env, q, easingType),
    model: options.fisheyeModel,
    fit: options.fisheyeFit,
    centre: options.fisheyeCentre === 'point' ? { x: plan.point.x, y: 1 - plan.point.y } : { x: 0.5, y: 0.5 },
  });
  applyFlashUniforms([material], {
    amount: transitionFlashAmount(options, env, q, easingType),
    color: options.flashColor,
  });
  applyBloomUniforms([material], {
    amount: transitionBloomAmount(options, env, q, easingType),
    threshold: options.bloomThreshold,
    radius: options.bloomRadius,
  });
}

function applyMeshTransformOrigin(mesh, originX = 50, originY = 50, W = 1280, H = 720) {
  if (!mesh) return;
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) return;
  if (originX === 50 && originY === 50) return;

  const pivot = new THREE.Vector3(
    ((originX / 100) - 0.5) * W,
    (0.5 - (originY / 100)) * H,
    0
  );
  const transformedPivot = pivot.clone()
    .multiply(mesh.scale)
    .applyEuler(mesh.rotation);
  const delta = pivot.sub(transformedPivot);
  mesh.position.x += delta.x;
  mesh.position.y += delta.y;
}

/* ── Custom builder per-lane effects ────────────────────────────────────────
 *
 * The Transition Builder carries a full effect stack PER LAYER (fx* keys on
 * each config block): zoom-about-a-point, blur, RGB split, optics/fisheye,
 * exposure flash, opacity dip and wiggle. Every amount defaults to 0 = OFF,
 * so configs saved before these keys existed run exactly as they always did.
 *
 * Each lane rides its own envelope. 'ramp' follows the layer's distance from
 * home — it builds as prev exits and settles as next arrives, matching the
 * builder's Start/End vocabulary; 'peak' and 'constant' match the advanced
 * transitions. `q` is always forward transition progress.
 */

function customFxEnvelope(profile, lane, q) {
  if (profile === 'peak') return Math.sin(Math.PI * Math.min(1, Math.max(0, q)));
  if (profile === 'constant') return 1;
  return Math.min(1, Math.max(0, lane === 'prev' ? q : 1 - q)); // 'ramp'
}

/* Octave zoom: growth G = 2^(zoom/100); prev rides G^q, next G^(q-1), so equal
 * amounts on both columns keep the pair one octave apart — the same continuity
 * rule as Advanced Zoom, but each layer may also aim at its own point. */
function customZoomFactor(cfg, lane, q) {
  const zoomPct = Number.isFinite(cfg?.fxZoom) ? cfg.fxZoom : 0;
  if (!zoomPct) return 1;
  const growth = Math.pow(2, zoomPct / 100);
  return Math.pow(growth, lane === 'prev' ? q : q - 1);
}

// The builder's wiggle shakes the MESH (not the sample UV): the custom
// transition is mesh-based, so a UV tremble on a plate that is not covering
// the frame smears its edges and reads as nothing at all. Slider 100% → this
// fraction of frame HEIGHT — a touch above the advanced transitions' 0.075,
// because a mesh shake has no UV-scale boost helping it.
const CUSTOM_WIGGLE_MAX = 0.09;

/* Mirror-tile fill must reach the VIEW edge, not stop at the layer's plate.
 * The transition's own moves (the zoom-about-a-point compensation, the item's
 * transform, the wiggle) can shrink or displace the plate, so after everything
 * else the plate grows about its centre until it covers the farthest view
 * corner, and the UV window widens by the same factor so the content itself
 * does not move — only more mirrored fill becomes visible. */
function expandTileMeshToView(mesh, W, H) {
  const u = mesh?.material?.uniforms;
  if (!u?.uUvScale || !u.uUvOffset) return;
  const geo = mesh.geometry?.parameters;
  const gw = Math.abs((geo?.width || W) * (mesh.scale.x || 1));
  const gh = Math.abs((geo?.height || H) * (mesh.scale.y || 1));
  if (gw < 1e-3 || gh < 1e-3) return;
  const farX = W / 2 + Math.abs(mesh.position.x || 0);
  const farY = H / 2 + Math.abs(mesh.position.y || 0);
  // Farthest view corner from the plate centre over the plate's SHORT
  // half-side: covers any roll the transition may have applied.
  const k = (Math.hypot(farX, farY) / (Math.min(gw, gh) / 2)) * 1.02;
  if (!Number.isFinite(k) || k <= 1) return;
  mesh.scale.x *= k;
  mesh.scale.y *= k;
  const sx = u.uUvScale.value.x;
  const sy = u.uUvScale.value.y;
  u.uUvScale.value.set(sx * k, sy * k);
  // Widening the window about the plate centre: t'(uv) = uv·kS + (O + ½(1−k)S)
  u.uUvOffset.value.x += 0.5 * (1 - k) * sx;
  u.uUvOffset.value.y += 0.5 * (1 - k) * sy;
}

function applyCustomLaneEffects(mesh, cfg, lane, q, zoom, { W = 1280, H = 720, rawQ, duration } = {}) {
  const u = mesh?.material?.uniforms;
  if (!u || !cfg) return;
  const env = customFxEnvelope(cfg.fxProfile, lane, q);
  const pxX = Number.isFinite(cfg.fxPointX) ? cfg.fxPointX : 50;
  const pxY = Number.isFinite(cfg.fxPointY) ? cfg.fxPointY : 50;

  // Zoom about the picked point: the already-transformed mesh scales about the
  // screen point — i.e. a camera zoom aimed there. Geometry, so it runs on the
  // eased progress directly, not on the effect envelope.
  if (zoom !== 1) {
    const px = (pxX / 100 - 0.5) * W;
    const py = (0.5 - pxY / 100) * H;
    mesh.scale.x *= zoom;
    mesh.scale.y *= zoom;
    mesh.position.x = mesh.position.x * zoom + px * (1 - zoom);
    mesh.position.y = mesh.position.y * zoom + py * (1 - zoom);
  }

  if (env <= 0.001) return;

  // The layer's travel direction in UV space (v counts up): prev exits toward
  // its move; next travels home against its stored offset-from-final.
  let dirX = (cfg.moveX || 0) * (lane === 'prev' ? 1 : -1);
  let dirY = -(cfg.moveY || 0) * (lane === 'prev' ? 1 : -1);
  const dirLen = Math.hypot(dirX, dirY);
  if (dirLen < 1e-4) { dirX = 1; dirY = 0; } else { dirX /= dirLen; dirY /= dirLen; }

  const pointUv = { x: pxX / 100, y: 1 - pxY / 100 };

  // Blur + RGB split in one uniform write — radial variants share uZoomCenter.
  const blurStrength = Math.max(0, cfg.fxBlur || 0);
  const blurType = cfg.fxBlurType || 'gaussian';
  const split = Math.max(0, cfg.fxRgbSplit || 0);
  const along = cfg.fxRgbAlong || 'motion';
  const splitLen = (split / 100) * env * RGB_SPLIT_MAX;
  applyPointBlurUniforms([mesh.material], {
    centre: pointUv,
    zoom: blurType === 'radial' ? (blurStrength / 100) * env : 0,
    move: blurType === 'directional'
      ? { x: dirX * (blurStrength / 100) * 0.5 * env, y: dirY * (blurStrength / 100) * 0.5 * env }
      : null,
    split: along === 'radial' ? splitLen : 0,
    splitMove: along === 'radial'
      ? null
      : { x: (along === 'horizontal' ? 1 : dirX) * splitLen, y: (along === 'horizontal' ? 0 : dirY) * splitLen },
    tileFade: 0,
  });
  // The 13-tap gaussian is the ordinary layer blur; filters set it before the
  // transition runs, so the transition ADDS to whatever the item already has.
  if (blurType === 'gaussian' && blurStrength > 0) {
    u.uBlur.value += blurStrength * env * 0.35;
  }

  // Optics Compensation and Fisheye share the shader's single lens pass, so
  // they stack additively; when both are on, the fisheye's model/centre/fit win.
  const kOptics = ((cfg.fxOptics || 0) / 100) * FISHEYE_K_MAX * env;
  const kFisheye = ((cfg.fxFisheye || 0) / 100) * FISHEYE_K_MAX * env;
  if (kOptics !== 0 || kFisheye !== 0) {
    const fisheyeActive = kFisheye !== 0;
    applyFisheyeUniforms([mesh.material], {
      amount: Math.max(-2, Math.min(2, kOptics + kFisheye)),
      model: fisheyeActive ? cfg.fxFisheyeModel : 'spherical',
      fit: fisheyeActive ? cfg.fxFisheyeFit !== false : cfg.fxOpticsFit !== false,
      centre: fisheyeActive && cfg.fxFisheyeCentre === 'point' ? pointUv : { x: 0.5, y: 0.5 },
    });
  }

  if ((cfg.fxFlash || 0) > 0 && u.uFlashAmount) {
    u.uFlashAmount.value = Math.min(1, ((cfg.fxFlash || 0) / 100) * Math.pow(env, 1.6));
    const hex = typeof cfg.fxFlashColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(cfg.fxFlashColor)
      ? parseInt(cfg.fxFlashColor.slice(1), 16)
      : 0xffffff;
    u.uFlashColor.value.setHex(hex);
  }

  if ((cfg.fxOpacityDip || 0) > 0) {
    u.uOpacity.value *= 1 - Math.min(1, (cfg.fxOpacityDip || 0) / 100) * env;
  }

  // Wiggle shakes the MESH, riding the layer's own envelope like every other
  // effect here. The clocks stay the app's rule: envelope on eased progress,
  // noise phase on raw progress × duration, so the tremble holds a constant Hz
  // and scrub/preview/export land on the same frame.
  if ((cfg.fxWiggle || 0) > 0) {
    const amount = Math.min(1, cfg.fxWiggle / 100);
    const freq = cfg.fxWiggleFreq ?? 14;
    const seed = (cfg.fxWiggleSeed ?? 7) + (lane === 'prev' ? 0 : 23);
    const phase = Math.max(0, Number.isFinite(rawQ) ? rawQ : q) * Math.max(0.01, duration || 1) * freq;
    const amp = amount * CUSTOM_WIGGLE_MAX * env * H;
    mesh.position.x += wiggleFbm(phase, seed, 0.4) * amp;
    mesh.position.y += wiggleFbm(phase + 57.3, seed + 3, 0.4) * amp;
    // Rotation is degrees of roll at Amount 100% — amount gates and scales it.
    mesh.rotation.z += wiggleFbm(phase * 0.83 + 21.7, seed + 11, 0.4)
      * (((cfg.fxWiggleRotate ?? 1.6) * Math.PI) / 180) * amount * env;
  }
}

// ── Directional built-ins (types.js DIRECTIONAL_TRANSITIONS) ──
// Shader wipe types: 1 reveals left → right, 2 right → left, 3 a TOP band growing
// downward, 4 a BOTTOM band growing upward (plane uv.y = 1 at the top). World +y
// is screen UP (canvas previews are y-down).
const WIPE_SHADER_TYPE = { leftToRight: 1, rightToLeft: 2, topToBottom: 3, bottomToTop: 4 };
// the way a sweep / move goes, as a unit vector (world, y up)
const WAY_VECTOR = {
  left: [-1, 0], right: [1, 0], up: [0, 1], down: [0, -1],
  leftToRight: [1, 0], rightToLeft: [-1, 0], bottomToTop: [0, 1], topToBottom: [0, -1],
};

function applyDirectionalCross(prevMesh, currMesh, kind, way, p, W, H) {
  const [dx, dy] = WAY_VECTOR[way] || WAY_VECTOR.left;
  if (kind === 'Wipe') {
    // both clips drift 15 % along the sweep while the edge crosses
    prevMesh.position.x += W * 0.15 * p * dx;
    prevMesh.position.y += H * 0.15 * p * dy;
    currMesh.position.x += -W * 0.15 * (1 - p) * dx;
    currMesh.position.y += -H * 0.15 * (1 - p) * dy;
    currMesh.material.uniforms.uWipeType.value = WIPE_SHADER_TYPE[way] || 1;
    currMesh.material.uniforms.uWipeProgress.value = p;
    return;
  }
  // the incoming clip arrives from the far side and lands home
  currMesh.position.x += -W * (1 - p) * dx;
  currMesh.position.y += -H * (1 - p) * dy;
  if (kind === 'Push') {
    prevMesh.position.x += W * p * dx;
    prevMesh.position.y += H * p * dy;
  } else if (dx !== 0) {
    // Parallax sideways: the outgoing clip drifts the same way at 60 %
    prevMesh.position.x += W * 0.6 * p * dx;
  } else {
    // Parallax up / down: the outgoing clip sinks back instead
    const s = 1 - 0.12 * p;
    prevMesh.scale.x *= s;
    prevMesh.scale.y *= s;
  }
}

// One layer, `p` = how present it is. Slide Left / Right name the edge, so an
// exit is the entrance played back (it leaves by the edge it would enter from);
// Up / Down — and every wipe — name the way, so the exit keeps going that way:
// the vertical pair swaps on OUT, exactly as the old per-direction types did.
const OUT_SWAP_WAY = { up: 'down', down: 'up', bottomToTop: 'topToBottom', topToBottom: 'bottomToTop' };
function applyDirectionalLayer(mesh, kind, way0, p, W, H, isOut) {
  const way = isOut && OUT_SWAP_WAY[way0] ? OUT_SWAP_WAY[way0] : way0;
  if (kind === 'Wipe') {
    mesh.material.uniforms.uWipeType.value = WIPE_SHADER_TYPE[way] || 1;
    mesh.material.uniforms.uWipeProgress.value = p;
    return;
  }
  // Slide Left enters from the LEFT edge (moving right); Up rises from the bottom
  const from = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[way] || [-1, 0];
  mesh.position.x += W * (1 - p) * from[0];
  mesh.position.y += H * (1 - p) * from[1];
}

// ── Cross-transition: operates on prev/curr mesh objects ──
// Each mesh has: .position, .scale, .visible, .material.uniforms
// Returns { prev: {...props}, curr: {...props} } describing the state at given progress.

export function applyCrossTransition(prevMesh, currMesh, transition, progress, W = 1280, H = 720, customConfig, easingType, transitionOptions, timing) {
  prevMesh.material.uniforms.uWipeType.value = 0;
  prevMesh.material.uniforms.uWipeProgress.value = 1;
  currMesh.material.uniforms.uWipeType.value = 0;
  currMesh.material.uniforms.uWipeProgress.value = 1;

  const p = progress;

  // Push / Parallax / Wipe — and the per-direction names saved before they merged
  const directional = directionalTransition(transition, transitionOptions);
  if (directional) {
    applyDirectionalCross(prevMesh, currMesh, directional[0], directional[1], p, W, H);
    return null;
  }

  switch (transition) {
    case TransitionType.ZOOM_IN: {
      prevMesh.material.uniforms.uOpacity.value *= (1 - p);
      const s1 = 1 + p;
      prevMesh.scale.x *= s1;
      prevMesh.scale.y *= s1;
      currMesh.material.uniforms.uOpacity.value *= p;
      const s2 = 0.5 + 0.5 * p;
      currMesh.scale.x *= s2;
      currMesh.scale.y *= s2;
      break;
    }

    case TransitionType.ZOOM_OUT: {
      prevMesh.material.uniforms.uOpacity.value *= (1 - p);
      const s1 = 1 - 0.5 * p;
      prevMesh.scale.x *= s1;
      prevMesh.scale.y *= s1;
      currMesh.material.uniforms.uOpacity.value *= p;
      const s2 = 1.5 - 0.5 * p;
      currMesh.scale.x *= s2;
      currMesh.scale.y *= s2;
      break;
    }

    case TransitionType.ZOOM_POINT: {
      const options = resolveAdvancedTransitionOptions(transition, transitionOptions) || {};
      const plan = advancedZoomPlan(options, p, easingType);
      applyAdvancedZoomLane(prevMesh.material, plan, options, p, 'prev', easingType);
      applyAdvancedZoomLane(currMesh.material, plan, options, p, 'curr', easingType);
      applyTransitionCameraWarp(prevMesh, currMesh, options, {
        easedProgress: p,
        rawProgress: timing?.rawProgress ?? p,
        duration: timing?.duration,
        easingType,
        aspect: H > 0 ? W / H : 1,
      }, {
        prev: advancedZoomLaneRoll(plan, p, 'prev'),
        curr: advancedZoomLaneRoll(plan, p, 'curr'),
      });
      break;
    }

    case TransitionType.MOVE_POINT: {
      const options = resolveAdvancedTransitionOptions(transition, transitionOptions) || {};
      const plan = advancedMovePlan(options, p, easingType, W, H);
      applyAdvancedMoveLane(prevMesh.material, plan, options, p, 'prev', easingType);
      applyAdvancedMoveLane(currMesh.material, plan, options, p, 'curr', easingType);
      applyTransitionCameraWarp(prevMesh, currMesh, options, {
        easedProgress: p,
        rawProgress: timing?.rawProgress ?? p,
        duration: timing?.duration,
        easingType,
        aspect: plan.ar,
      });
      break;
    }

    case TransitionType.SCALE_SWAP: {
      // Prev: scale down and move away (right); curr: start scaled down and offset, then move to center and scale up; upper layer fades in smoothly
      const scaleMin = 0.25;
      const moveAmount = 0.4;
      prevMesh.material.uniforms.uOpacity.value *= (1 - p * 0.5);
      const prevScale = 1 + (scaleMin - 1) * p;
      prevMesh.scale.x *= prevScale;
      prevMesh.scale.y *= prevScale;
      prevMesh.position.x += moveAmount * W * p;
      currMesh.material.uniforms.uOpacity.value *= p;
      const currScale = scaleMin + (1 - scaleMin) * p;
      currMesh.scale.x *= currScale;
      currMesh.scale.y *= currScale;
      currMesh.position.x += -moveAmount * W * (1 - p);
      break;
    }

    case TransitionType.SIDE_BY_SIDE: {
      // Phase 1: scale down (eased). Phase 2: slide (eased). Phase 3: scale up (eased). Incoming layer starts fully off-viewport.
      const scaleMin = 0.5;
      const spacing = 0.18;
      const totalSlide = 0.85;   // enough so incoming layer (scale 0.5, right edge at -totalSlide*W + 0.25*W) is fully off left of viewport (-0.5*W)
      const p1 = 1 / 3;
      const p2 = 2 / 3;
      const ease = (t) => applyGsapEasing(t, easingType ?? TransitionEasing.EASE_IN_OUT);

      const linear = p;
      let e1; let e2; let e3; // eased progress per phase (0..1 within each phase)
      if (linear <= p1) {
        e1 = p1 > 0 ? ease(linear / p1) : 1;
        e2 = 0;
        e3 = 0;
      } else if (linear <= p2) {
        e1 = 1;
        e2 = ease((linear - p1) / (p2 - p1));
        e3 = 0;
      } else {
        e1 = 1;
        e2 = 1;
        e3 = (1 - p2) > 0 ? ease((linear - p2) / (1 - p2)) : 1;
      }

      const prevScale = e1 < 1 ? 1 + (scaleMin - 1) * e1 : scaleMin;
      const prevPosX = e2 * totalSlide * W;
      prevMesh.scale.x *= prevScale;
      prevMesh.scale.y *= prevScale;
      prevMesh.position.x += prevPosX;
      prevMesh.material.uniforms.uOpacity.value *= (linear <= p2 ? 1 : 0);

      const currScale = e2 < 1 ? scaleMin : scaleMin + (1 - scaleMin) * e3;
      const currPosX = e2 < 1 ? -totalSlide * W + e2 * totalSlide * W : 0;
      const currOpacity = linear <= p1 ? 0 : 1;
      currMesh.scale.x *= currScale;
      currMesh.scale.y *= currScale;
      currMesh.position.x += currPosX;
      currMesh.material.uniforms.uOpacity.value *= currOpacity;
      break;
    }

    case TransitionType.DIP_TO_BLACK:
      prevMesh.material.uniforms.uOpacity.value *= (p < 0.5 ? 1 - p * 2 : 0);
      currMesh.material.uniforms.uOpacity.value *= (p > 0.5 ? (p - 0.5) * 2 : 0);
      break;

    case TransitionType.RADIAL_WIPE: {
      const s1 = 1 + 0.1 * p;
      prevMesh.scale.x *= s1;
      prevMesh.scale.y *= s1;
      currMesh.material.uniforms.uWipeType.value = 5;
      currMesh.material.uniforms.uWipeProgress.value = p;
      const s2 = 1.08 - 0.08 * p;
      currMesh.scale.x *= s2;
      currMesh.scale.y *= s2;
      break;
    }

    case TransitionType.CUSTOM: {
      const nextCfg = customConfig?.next || customConfig || {};
      const prevCfg = customConfig?.prev || {};
      const nextTile = !!nextCfg.tile;
      const prevTile = !!prevCfg.tile;
      const prevScaleTarget = prevCfg.scaleFrom ?? 1;
      const prevScale = 1 + (prevScaleTarget - 1) * p;
      const prevRot = (prevCfg.rotation || 0) * p;
      const prevRotX = (prevCfg.rotateX || 0) * p;
      const prevRotY = (prevCfg.rotateY || 0) * p;
      // Per-lane effect context. The zoom factor feeds the tile fill below so a
      // zoomed-out tiled layer still covers the frame with mirrored content.
      const fxCtx = { W, H, easingType, rawQ: timing?.rawProgress ?? p, duration: timing?.duration };
      const zPrev = customZoomFactor(prevCfg, 'prev', p);
      const zNext = customZoomFactor(nextCfg, 'curr', p);

      // Outgoing (prev) animates from normal to configured end state.
      if (prevTile) {
        applyMirroredTileUv(prevMesh.material, {
          moveX: prevCfg.moveX || 0,
          moveY: prevCfg.moveY || 0,
          scale: prevScale * zPrev,
          rotXDeg: prevRotX,
          rotYDeg: prevRotY,
          rotZDeg: prevRot,
          progress: p,
        });
      } else {
        prevMesh.position.x += ((prevCfg.moveX || 0) / 100) * W * p;
        prevMesh.position.y += -((prevCfg.moveY || 0) / 100) * H * p;
      }
      prevMesh.scale.x *= prevScale;
      prevMesh.scale.y *= prevScale;
      if (prevTile) {
        applyTileMeshCoverage(prevMesh, {
          scale: prevScale * zPrev,
          rotXDeg: prevRotX,
          rotYDeg: prevRotY,
          rotZDeg: prevRot,
        });
      }
      prevMesh.material.uniforms.uOpacity.value *= (1 + ((prevCfg.opacityFrom ?? 0) - 1) * p);
      if (prevCfg.rotation) {
        prevMesh.rotation.z += prevCfg.rotation * p * Math.PI / 180;
      }
      if (prevCfg.rotateX) {
        prevMesh.rotation.x += prevCfg.rotateX * p * Math.PI / 180;
      }
      if (prevCfg.rotateY) {
        prevMesh.rotation.y += prevCfg.rotateY * p * Math.PI / 180;
      }
      applyMeshTransformOrigin(prevMesh, prevCfg.originX ?? 50, prevCfg.originY ?? 50, W, H);
      applyCustomLaneEffects(prevMesh, prevCfg, 'prev', p, zPrev, fxCtx);
      if (prevTile) expandTileMeshToView(prevMesh, W, H);

      // Incoming (next) animates from configured start state to normal.
      const scaleFrom = nextCfg.scaleFrom ?? 1;
      const scale = scaleFrom + (1 - scaleFrom) * p;
      const nextRot = (nextCfg.rotation || 0) * (1 - p);
      const nextRotX = (nextCfg.rotateX || 0) * (1 - p);
      const nextRotY = (nextCfg.rotateY || 0) * (1 - p);
      if (nextTile) {
        applyMirroredTileUv(currMesh.material, {
          moveX: nextCfg.moveX || 0,
          moveY: nextCfg.moveY || 0,
          scale: scale * zNext,
          rotXDeg: nextRotX,
          rotYDeg: nextRotY,
          rotZDeg: nextRot,
          progress: (1 - p),
        });
      } else {
        currMesh.position.x += ((nextCfg.moveX || 0) / 100) * W * (1 - p);
        currMesh.position.y += -((nextCfg.moveY || 0) / 100) * H * (1 - p);
      }

      currMesh.scale.x *= scale;
      currMesh.scale.y *= scale;
      if (nextTile) {
        applyTileMeshCoverage(currMesh, {
          scale: scale * zNext,
          rotXDeg: nextRotX,
          rotYDeg: nextRotY,
          rotZDeg: nextRot,
        });
      }

      const opacityFrom = nextCfg.opacityFrom ?? 0;
      currMesh.material.uniforms.uOpacity.value *= (opacityFrom + (1 - opacityFrom) * p);

      if (nextCfg.rotation) {
        currMesh.rotation.z += nextCfg.rotation * (1 - p) * Math.PI / 180;
      }
      if (nextCfg.rotateX) {
        currMesh.rotation.x += nextCfg.rotateX * (1 - p) * Math.PI / 180;
      }
      if (nextCfg.rotateY) {
        currMesh.rotation.y += nextCfg.rotateY * (1 - p) * Math.PI / 180;
      }
      applyMeshTransformOrigin(currMesh, nextCfg.originX ?? 50, nextCfg.originY ?? 50, W, H);
      applyCustomLaneEffects(currMesh, nextCfg, 'curr', p, zNext, fxCtx);
      if (nextTile) expandTileMeshToView(currMesh, W, H);
      break;
    }

    case TransitionType.FADE:
      // Cross-fade: keep prev fully visible, fade in curr on top.
      currMesh.material.uniforms.uOpacity.value *= p;
      break;

    default:
      // Unknown/deleted packages remain safely playable as a cross fade. Executable
      // transition packages run in Player through transitionPackageRuntime.
      currMesh.material.uniforms.uOpacity.value *= p;
      break;
  }
  return null;
}

// ── Layer transitions (per-clip in/out) ──
// Operates on a single mesh. `progress` goes 0→1 for entrance; OUT transitions
// call this with progress running 1→0 and direction='out'.
//
// Direction semantics (match the picker previews):
//   IN  — Slide Left/Right enter FROM that edge; Slide Up/Down enter MOVING in
//         that direction (up = rises from the bottom, down = drops from the top).
//   OUT — the layer always EXITS moving in the named direction. Horizontal is the
//         plain reverse of the entrance; vertical mirrors (an upward entrance
//         reversed would exit downward), so up/down swap when direction='out'.
//
// `advanced` carries what the Advanced Zoom / Advanced Movement lanes need on
// top of a plain mesh move: { options, easingType, duration, rawProgress }. The
// plain types ignore it, so every existing caller stays correct without it.

export function applyLayerTransition(mesh, type, progress, W = 1280, H = 720, customConfig, direction = 'in', advanced) {
  if (!mesh || type === LayerTransitionType.NONE) return;

  const p = progress;
  const isOut = direction === 'out';
  // Slide / Wipe — and the per-direction names saved before they merged
  const directional = directionalTransition(type, advanced?.options, 'layer');
  if (directional) {
    applyDirectionalLayer(mesh, directional[0], directional[1], p, W, H, isOut);
    return;
  }
  // Motion-named types swap their pair on OUT so the exit truly moves in the
  // named direction (a reversed upward ENTRANCE would exit downward — wrong):
  // Slide/Wipe Up↔Down, Zoom In↔Out. Edge-named horizontal types don't swap —
  // their plain reverse already exits toward the named edge.
  let t = type;
  if (isOut) {
    if (t === LayerTransitionType.ZOOM_IN) t = LayerTransitionType.ZOOM_OUT;
    else if (t === LayerTransitionType.ZOOM_OUT) t = LayerTransitionType.ZOOM_IN;
  }

  switch (t) {
    case LayerTransitionType.FADE:
    case LayerTransitionType.DIP_BLACK:
      mesh.material.uniforms.uOpacity.value *= p;
      break;

    case LayerTransitionType.ZOOM_IN: {
      mesh.material.uniforms.uOpacity.value *= p;
      const s = 0.5 + 0.5 * p;
      mesh.scale.x *= s;
      mesh.scale.y *= s;
      break;
    }

    case LayerTransitionType.ZOOM_OUT: {
      mesh.material.uniforms.uOpacity.value *= p;
      const s = 1.5 - 0.5 * p;
      mesh.scale.x *= s;
      mesh.scale.y *= s;
      break;
    }

    case LayerTransitionType.RADIAL_WIPE: {
      mesh.material.uniforms.uWipeType.value = 5;
      mesh.material.uniforms.uWipeProgress.value = p;
      const s = 0.92 + 0.08 * p;
      mesh.scale.x *= s;
      mesh.scale.y *= s;
      break;
    }

    /* ── Advanced Zoom / Advanced Movement as one lane ──────────────────────
     *
     * The cross versions run two lanes off one ramp (see advancedZoomPlan).
     * A layer has one plate, so an ENTRANCE is the incoming lane and an EXIT
     * the outgoing lane — same arithmetic, one side of it.
     *
     * `q` is forward transition progress. IN already arrives that way; OUT is
     * handed p running 1 → 0 (the layer-transition convention: p is "how
     * present the layer is"), so q = 1 − p. That also means the exit plays the
     * chosen easing reversed, exactly as every other OUT type here does.
     */
    case LayerTransitionType.ZOOM_POINT:
    case LayerTransitionType.MOVE_POINT: {
      const options = resolveAdvancedTransitionOptions(t, advanced?.options) || {};
      const lane = isOut ? 'prev' : 'curr';
      const q = isOut ? 1 - p : p;
      const easingType = advanced?.easingType;
      const rawQ = Number.isFinite(advanced?.rawProgress)
        ? (isOut ? 1 - advanced.rawProgress : advanced.rawProgress)
        : q;
      const aspect = H > 0 ? W / H : 1;

      const plan = t === LayerTransitionType.ZOOM_POINT
        ? advancedZoomPlan(options, q, easingType)
        : advancedMovePlan(options, q, easingType, W, H);
      // The cross-blend exists to mask the cut between two clips. An exit has
      // no second clip, so on the outgoing lane it read as an automatic
      // fade-out on top of the motion — the zoom/move alone carries the exit.
      if (isOut) plan.mix = 0;
      if (t === LayerTransitionType.ZOOM_POINT) {
        applyAdvancedZoomLane(mesh.material, plan, options, q, lane, easingType);
      } else {
        applyAdvancedMoveLane(mesh.material, plan, options, q, lane, easingType);
      }
      // One layer, so there is nothing to share the tremble with — `wiggleShared`
      // is a cross-only option and the layer slots hide it.
      applyWiggleUniforms([mesh.material], transitionWiggle(options, {
        easedProgress: q,
        rawProgress: rawQ,
        duration: advanced?.duration,
        easingType,
        aspect,
      }), t === LayerTransitionType.ZOOM_POINT ? advancedZoomLaneRoll(plan, q, lane) : null);
      break;
    }

    case LayerTransitionType.CUSTOM: {
      const cfg = customConfig || {};
      const moveX = cfg.moveX || 0;
      const moveY = cfg.moveY || 0;
      const scaleFrom = cfg.scaleFrom ?? 1;
      const opacityFrom = cfg.opacityFrom ?? 0;
      const rot = cfg.rotation || 0;
      const rotX = cfg.rotateX || 0;
      const rotY = cfg.rotateY || 0;
      const scale = scaleFrom + (1 - scaleFrom) * p;
      const currRot = rot * (1 - p);
      const currRotX = rotX * (1 - p);
      const currRotY = rotY * (1 - p);
      // One plate: an entrance is the incoming lane, an exit the outgoing lane.
      // `p` is presence here (OUT is fed 1→0), so forward progress q re-derives.
      const fxLane = isOut ? 'prev' : 'curr';
      const fxQ = isOut ? 1 - p : p;
      const z = customZoomFactor(cfg, fxLane, fxQ);

      if (cfg.tile) {
        applyMirroredTileUv(mesh.material, {
          moveX,
          moveY,
          scale: scale * z,
          rotXDeg: currRotX,
          rotYDeg: currRotY,
          rotZDeg: currRot,
          progress: (1 - p),
        });
      } else {
        mesh.position.x += (moveX / 100) * W * (1 - p);
        mesh.position.y += -(moveY / 100) * H * (1 - p);
      }

      mesh.scale.x *= scale;
      mesh.scale.y *= scale;
      if (cfg.tile) {
        applyTileMeshCoverage(mesh, {
          scale: scale * z,
          rotXDeg: currRotX,
          rotYDeg: currRotY,
          rotZDeg: currRot,
        });
      }

      mesh.material.uniforms.uOpacity.value *= (opacityFrom + (1 - opacityFrom) * p);

      if (rot !== 0) {
        mesh.rotation.z += rot * (1 - p) * Math.PI / 180;
      }
      if (rotX !== 0) {
        mesh.rotation.x += rotX * (1 - p) * Math.PI / 180;
      }
      if (rotY !== 0) {
        mesh.rotation.y += rotY * (1 - p) * Math.PI / 180;
      }
      applyMeshTransformOrigin(mesh, cfg.originX ?? 50, cfg.originY ?? 50, W, H);
      applyCustomLaneEffects(mesh, cfg, fxLane, fxQ, z, {
        W,
        H,
        rawQ: Number.isFinite(advanced?.rawProgress)
          ? (isOut ? 1 - advanced.rawProgress : advanced.rawProgress)
          : fxQ,
        duration: advanced?.duration,
      });
      if (cfg.tile) expandTileMeshToView(mesh, W, H);
      break;
    }

    default:
      break;
  }
}

// ── Keyframe interpolation ──
// Converts keyframe array + clip progress into interpolated property values.
// Uses GSAP's easing for inter-keyframe interpolation.

export function interpolateKeyframes(keyframes, progress) {
  if (!Array.isArray(keyframes) || keyframes.length < 2) return null;

  const pct = progress * 100;
  const sorted = [...keyframes].sort((a, b) => a.position - b.position);
  const colorKeys = new Set(['color', 'backgroundColor']);

  const readProps = (frame) => {
    const values = {};
    for (const [key, val] of Object.entries(frame.properties || {})) {
      const parsed = Number.parseFloat(val);
      if (Number.isFinite(parsed)) {
        values[key] = parsed;
        continue;
      }
      if (colorKeys.has(key) && typeof val === 'string') {
        values[key] = val.trim();
      }
    }
    values.transformOrigin = typeof frame.transformOrigin === 'string' && frame.transformOrigin.trim()
      ? frame.transformOrigin.trim()
      : 'center';
    return values;
  };

  if (pct <= sorted[0].position) return readProps(sorted[0]);
  if (pct >= sorted[sorted.length - 1].position) return readProps(sorted[sorted.length - 1]);

  let low = sorted[0];
  let high = sorted[1];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    if (pct >= sorted[i].position && pct <= sorted[i + 1].position) {
      low = sorted[i];
      high = sorted[i + 1];
      break;
    }
  }

  const range = high.position - low.position;
  const linearT = range > 0 ? (pct - low.position) / range : 0;
  const easeFn = resolveKeyEase(low);
  const t = easeFn(linearT);

  const lowProps = low.properties || {};
  const highProps = high.properties || {};
  const keys = new Set([...Object.keys(lowProps), ...Object.keys(highProps)]);
  const values = {
    transformOrigin: typeof low.transformOrigin === 'string' && low.transformOrigin.trim()
      ? low.transformOrigin.trim()
      : 'center',
  };

  for (const key of keys) {
    const lerped = lerpValue(lowProps[key], highProps[key], t, colorKeys.has(key));
    if (lerped !== undefined) values[key] = lerped;
  }

  return values;
}

// Lerp a single keyframe value pair. Numeric values lerp linearly under the
// (already eased) t; color values lerp in RGBA. Returns undefined when neither
// side yields a usable value.
function lerpValue(lowRaw, highRaw, t, isColor) {
  const lowValue = Number.parseFloat(lowRaw);
  const highValue = Number.parseFloat(highRaw);
  if (Number.isFinite(lowValue) && Number.isFinite(highValue)) {
    return lowValue + (highValue - lowValue) * t;
  }
  if (Number.isFinite(lowValue)) return lowValue;
  if (Number.isFinite(highValue)) return highValue;
  if (isColor) {
    // A paint track's key may hold a full CSS gradient (text fill / shape fill in
    // gradient mode). Blend stop-by-stop; a solid endpoint borrows the gradient's
    // stop layout so solid↔gradient tweens fade smoothly instead of jumping.
    if (isCssGradient(lowRaw) || isCssGradient(highRaw)) {
      const blended = lerpGradientValue(lowRaw, highRaw, t);
      if (blended) return blended;
    }
    const lowColor = parseColorWithAlpha(lowRaw);
    const highColor = parseColorWithAlpha(highRaw);
    if (lowColor && highColor) {
      return toRgbaString({
        r: lowColor.r + (highColor.r - lowColor.r) * t,
        g: lowColor.g + (highColor.g - lowColor.g) * t,
        b: lowColor.b + (highColor.b - lowColor.b) * t,
        a: lowColor.a + (highColor.a - lowColor.a) * t,
      });
    }
    if (typeof lowRaw === 'string' && lowRaw.trim()) return lowRaw.trim();
    if (typeof highRaw === 'string' && highRaw.trim()) return highRaw.trim();
  }
  return undefined;
}

// Colour of a parsed gradient at `pos` (0-100): clamp outside the stop range,
// piecewise-lerp between the bracketing stops inside it.
function sampleGradientAt(stops, pos) {
  if (pos <= stops[0].position) return stops[0].color;
  const last = stops[stops.length - 1];
  if (pos >= last.position) return last.color;
  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i];
    const b = stops[i + 1];
    if (pos >= a.position && pos <= b.position) {
      const range = b.position - a.position;
      const t = range > 0 ? (pos - a.position) / range : 0;
      const ca = parseColorWithAlpha(a.color);
      const cb = parseColorWithAlpha(b.color);
      if (!ca || !cb) return t < 0.5 ? a.color : b.color;
      return toRgbaString({
        r: ca.r + (cb.r - ca.r) * t,
        g: ca.g + (cb.g - ca.g) * t,
        b: ca.b + (cb.b - ca.b) * t,
        a: ca.a + (cb.a - ca.a) * t,
      });
    }
  }
  return last.color;
}

// Blend two paints where at least one is a CSS gradient. Both are sampled at the
// union of their stop positions, each sampled pair lerps in RGBA, and the result
// is re-serialized through buildGradient — so the output stays a valid track
// value. A solid endpoint becomes a constant gradient over the other side's stop
// layout. Returns undefined when the gradient side fails to parse.
function lerpGradientValue(lowRaw, highRaw, t) {
  const lowParsed = isCssGradient(lowRaw) ? parseGradient(lowRaw) : null;
  const highParsed = isCssGradient(highRaw) ? parseGradient(highRaw) : null;
  const template = lowParsed || highParsed;
  if (!template) return undefined;
  const solidToConstant = (raw) => ({
    type: template.type,
    angle: template.angle,
    stops: template.stops.map((s) => ({ color: typeof raw === 'string' && raw.trim() ? raw.trim() : '#ffffff', position: s.position })),
  });
  const a = lowParsed || solidToConstant(lowRaw);
  const b = highParsed || solidToConstant(highRaw);
  const positions = [...new Set(
    [...a.stops, ...b.stops].map((s) => Number(s.position.toFixed(2)))
  )].sort((x, y) => x - y);
  const stops = positions.map((pos) => {
    const ca = parseColorWithAlpha(sampleGradientAt(a.stops, pos));
    const cb = parseColorWithAlpha(sampleGradientAt(b.stops, pos));
    if (!ca || !cb) return { position: pos, color: t < 0.5 ? sampleGradientAt(a.stops, pos) : sampleGradientAt(b.stops, pos) };
    return {
      position: pos,
      color: toRgbaString({
        r: ca.r + (cb.r - ca.r) * t,
        g: ca.g + (cb.g - ca.g) * t,
        b: ca.b + (cb.b - ca.b) * t,
        a: ca.a + (cb.a - ca.a) * t,
      }),
    };
  });
  // Shortest-path angle blend so 350° → 10° sweeps 20°, not 340°.
  const delta = (((b.angle - a.angle) % 360) + 540) % 360 - 180;
  const angle = a.angle + delta * t;
  return buildGradient(t < 0.5 ? a.type : b.type, angle, stops);
}

// ── Per-property keyframe tracks ('properties' keyframe mode) ──
// A track is [{ position: 0-100, value: string, easing }] for one property.
// Easing on a key shapes the segment AFTER that key, same as common mode.

// Evaluate one track at pct (0-100). A single-key track is a constant value;
// outside the first/last key the track clamps to the endpoint value.
export function evaluatePropertyTrack(track, pct, isColor = false) {
  if (!Array.isArray(track) || track.length === 0) return undefined;
  const sorted = [...track].sort((a, b) => a.position - b.position);
  const readValue = (key) => {
    if (isColor) {
      return typeof key.value === 'string' && key.value.trim() ? key.value.trim() : undefined;
    }
    const parsed = Number.parseFloat(key.value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  if (sorted.length === 1 || pct <= sorted[0].position) return readValue(sorted[0]);
  if (pct >= sorted[sorted.length - 1].position) return readValue(sorted[sorted.length - 1]);

  let low = sorted[0];
  let high = sorted[1];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    if (pct >= sorted[i].position && pct <= sorted[i + 1].position) {
      low = sorted[i];
      high = sorted[i + 1];
      break;
    }
  }
  const range = high.position - low.position;
  const linearT = range > 0 ? (pct - low.position) / range : 0;
  const easeFn = resolveKeyEase(low);
  return lerpValue(low.value, high.value, easeFn(linearT), isColor);
}

/**
 * Path track: each key holds a whole point list (JSON), morphed point-by-point.
 * Shared verbatim by the shape layer's `shapePath` and by every layer mask's
 * `msk:<mid>:path` — both decode and blend through shape-agnostic helpers, so
 * only the dispatch in interpolatePropertyKeyframes knows the difference.
 *
 * Deliberately a separate function rather than a third branch inside
 * evaluatePropertyTrack — that one runs for every numeric and colour track on every
 * layer of every frame, and these are the only non-scalar tracks in the editor.
 * Returns an array of unit-space points, or undefined when the track is unusable.
 */
export function evaluatePathTrack(track, pct) {
  if (!Array.isArray(track) || track.length === 0) return undefined;
  const sorted = [...track].sort((a, b) => a.position - b.position);
  const read = (key) => decodeShapePathValue(key?.value) || undefined;
  if (sorted.length === 1 || pct <= sorted[0].position) return read(sorted[0]);
  if (pct >= sorted[sorted.length - 1].position) return read(sorted[sorted.length - 1]);

  let low = sorted[0];
  let high = sorted[1];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    if (pct >= sorted[i].position && pct <= sorted[i + 1].position) {
      low = sorted[i];
      high = sorted[i + 1];
      break;
    }
  }
  const a = read(low);
  const b = read(high);
  if (!a) return b;
  if (!b) return a;
  const range = high.position - low.position;
  const linearT = range > 0 ? (pct - low.position) / range : 0;
  const easeFn = resolveKeyEase(low);
  return interpolateShapePaths(a, b, easeFn(linearT));
}

// Property-mode equivalent of interpolateKeyframes: returns the same flat
// { [prop]: number|string, transformOrigin } shape so downstream consumers
// (applyMeshTransform, applyFilterUniforms) need no mode awareness.
export function interpolatePropertyKeyframes(propertyKeyframes, progress, transformOrigin = 'center') {
  if (!propertyKeyframes || typeof propertyKeyframes !== 'object') return null;
  const pct = progress * 100;
  const values = {};
  let any = false;
  for (const [prop, track] of Object.entries(propertyKeyframes)) {
    // A path track's value is a point list, not a scalar — the shape layer's own
    // outline and every layer-mask outline. Every other consumer reads named
    // numeric props, so the extra entries are inert to them.
    //
    // Hottest line in the layer-mask feature: this runs per track, per layer, per
    // frame, so isPathTrackKey is a cheap string compare plus one anchored regex.
    const v = isPathTrackKey(prop)
      ? evaluatePathTrack(track, pct)
      : evaluatePropertyTrack(track, pct, isColorTrackKey(prop));
    if (v !== undefined) {
      values[prop] = v;
      any = true;
    }
  }
  if (!any) return null;
  values.transformOrigin = typeof transformOrigin === 'string' && transformOrigin.trim()
    ? transformOrigin.trim()
    : 'center';
  return values;
}

// Item-level helpers so runtime consumers share one entry point.
export function itemHasKeyframes(item) {
  return !!item && hasAnyTrack(item.propertyKeyframes);
}

// ƒx expressions repeat an animation (loopOut/loopIn) by re-reading the track at
// other times, and that has to go through the SAME eased evaluator the rest of
// the app uses. keyframeFx cannot import this module (this one imports it), so
// the evaluator is handed over once, here, at import time.
setKeyframeTrackSampler((track, pct) => evaluatePropertyTrack(track, pct, false));

export function getItemKeyframeValues(item, progress) {
  if (!item) return null;
  const values = interpolatePropertyKeyframes(item.propertyKeyframes, progress, item.keyframeTransformOrigin);
  if (!values || !hasAnyKeyframeFx(item.propertyKeyframeFx)) return values;
  // Track expressions (ƒx) need real seconds — the placed clip span, which is
  // derivable from the item alone (same math the timeline layout uses), so this
  // stays a pure function of (item, progress) for every consumer including the
  // deterministic export.
  const durationSec = getTimelineDuration(
    Math.max(0, (Number(item.trimEnd) || 0) - (Number(item.trimStart) || 0)),
    item.speedPoints,
  );
  return applyKeyframeFxToValues(item, values, progress, durationSec);
}

// ── Keyframed RATE integration (Neon Glow's Speed, Grow Fill, Repetile scroll,
// Layer Mask's Grow) ────────────────────────────────────────────────────────
// A rate track cannot just be sampled and multiplied by time — the effect would
// teleport whenever the value changes (phase = t·s(t) jumps by t·Δs). The
// correct phase is the INTEGRAL of the track, so a speed ramp accelerates
// smoothly. The cumulative table is built once per track edit by sampling the
// real keyframe evaluator (easings included) at 30 Hz across the clip and
// trapezoid-summing; lookups lerp the table. Everything stays a pure function
// of (track, time, duration), so preview and the deterministic export agree
// exactly — a range render from a cold start lands on the same value.
//
// Lives here rather than in the Player because getItemKeyframeValues (the
// evaluator it samples) is already this module's, and four consumers now need
// it: Player.jsx, layerMask.js, MaskOverlay.jsx and the mask panel summary.
const pathRateIntegralCache = new Map();

export function integratePathRate(item, rateKey, staticValue, localTime, durationSec) {
  const track = item?.propertyKeyframes?.[rateKey];
  if (!Array.isArray(track) || track.length === 0 || !(durationSec > 0)) {
    return localTime * staticValue;
  }
  const cacheId = `${item.id}|${rateKey}`;
  const key = `${JSON.stringify(track)}:${Math.round(durationSec * 1000)}`;
  let entry = pathRateIntegralCache.get(cacheId);
  if (!entry || entry.key !== key) {
    const steps = Math.max(8, Math.min(3600, Math.ceil(durationSec * 30)));
    const cum = new Float64Array(steps + 1);
    const dt = durationSec / steps;
    const valueAt = (progress) => {
      const v = getItemKeyframeValues(item, progress)[rateKey];
      return Number.isFinite(v) ? v : staticValue;
    };
    let prev = valueAt(0);
    for (let i = 1; i <= steps; i += 1) {
      const v = valueAt(i / steps);
      cum[i] = cum[i - 1] + ((prev + v) / 2) * dt;
      prev = v;
    }
    entry = { key, cum, steps };
    pathRateIntegralCache.set(cacheId, entry);
    if (pathRateIntegralCache.size > 64) {
      const first = pathRateIntegralCache.keys().next().value;
      if (first !== cacheId) pathRateIntegralCache.delete(first);
    }
  }
  const f = Math.max(0, Math.min(1, localTime / durationSec)) * entry.steps;
  const i = Math.min(Math.floor(f), entry.steps - 1);
  return entry.cum[i] + (entry.cum[i + 1] - entry.cum[i]) * (f - i);
}

// Peak keyframed scale for an item (1 when scale is never keyframed) — used
// to size render intermediates / supersampling.
export function getItemPeakKeyframeScale(item) {
  let peak = 1;
  for (const key of item?.propertyKeyframes?.scale || []) {
    const v = Number.parseFloat(key?.value);
    if (Number.isFinite(v)) peak = Math.max(peak, v);
  }
  return peak;
}

// ── Common-shape → property-track conversion ──
// Presets and the auto-zoom generator are authored as whole-snapshot keyframe
// lists ({ position, easing, transformOrigin, properties }); this converts them
// into the per-property track shape the editor uses.

// `allowedProps` defaults to the layer registry; the project camera panel passes its
// own label list so camera presets (camZoom, camX, …) survive the filter.
export function commonToPropertyKeyframes(keyframes, allowedProps = KF_PROP_LABELS) {
  const propertyKeyframes = {};
  const list = Array.isArray(keyframes) ? [...keyframes].sort((a, b) => a.position - b.position) : [];
  let transformOrigin = 'center';
  if (list.length && typeof list[0].transformOrigin === 'string' && list[0].transformOrigin.trim()) {
    transformOrigin = list[0].transformOrigin.trim();
  }
  for (const kf of list) {
    for (const [prop, raw] of Object.entries(kf.properties || {})) {
      if (!allowedProps.includes(prop)) continue;
      if (raw == null || String(raw).trim() === '') continue;
      if (!propertyKeyframes[prop]) propertyKeyframes[prop] = [];
      propertyKeyframes[prop].push({
        position: kf.position,
        value: String(raw),
        easing: kf.easing || TransitionEasing.EASE_IN_OUT,
        // A CUSTOM key carries its own curve; without this a preset authored with a
        // hand-shaped segment (or one saved off a graph-edited camera move) would
        // silently fall back to Smooth in resolveKeyEase.
        ...(kf.easing === TransitionEasing.CUSTOM && Array.isArray(kf.bezier)
          ? { bezier: [...kf.bezier] }
          : {}),
      });
    }
  }
  return { propertyKeyframes, transformOrigin };
}

// ── Placing a preset on a slice of the clip ──
// Presets are authored across the full 0–100 of a clip. These three helpers let the
// preset modal drop one into an arbitrary window instead (start point + length), and
// run it backwards for an outro.

// Mirror a common-shape keyframe list around its midpoint, so an entrance plays as an
// exit. Easing shapes the segment AFTER a key, so once the list is reversed each key
// has to inherit the easing of the key that used to follow it.
export function mirrorCommonKeyframes(keyframes) {
  const list = Array.isArray(keyframes) ? [...keyframes].sort((a, b) => a.position - b.position) : [];
  if (list.length < 2) return list;
  const reversed = list.map((kf) => ({ ...kf, position: 100 - kf.position })).reverse();
  const easings = reversed.map((kf) => kf.easing);
  // A CUSTOM key's curve lives on the key too, so it has to travel with the easing
  // it belongs to — otherwise the mirrored list pairs a Custom easing with the
  // previous key's handles.
  const beziers = reversed.map((kf) => kf.bezier);
  return reversed.map((kf, i) => ({
    ...kf,
    easing: easings[i + 1] || TransitionEasing.LINEAR,
    bezier: beziers[i + 1],
  }));
}

// Squeeze whole-clip tracks (0–100) into [startPct, endPct]. Outside that window the
// track simply clamps to its endpoint values — the editor's own evaluation rule — so
// the layer holds the preset's first/last pose rather than snapping.
export function scalePropertyKeyframesToRange(propertyKeyframes, startPct, endPct) {
  const from = Math.max(0, Math.min(100, startPct));
  const to = Math.max(from, Math.min(100, endPct));
  const span = to - from;
  if (span <= 0) return {};
  const out = {};
  for (const [prop, track] of Object.entries(propertyKeyframes || {})) {
    out[prop] = track.map((key) => ({
      ...key,
      position: Math.round((from + (key.position / 100) * span) * 10000) / 10000,
    }));
  }
  return out;
}

// Drop `incoming` into `existing` over [startPct, endPct], keeping any keys the layer
// already has OUTSIDE that window. That is what makes "intro at the head, outro at the
// tail" work: the second preset must not wipe the first.
export function mergePropertyKeyframesInRange(existing, incoming, startPct, endPct) {
  const lo = Math.min(startPct, endPct) - 0.001;
  const hi = Math.max(startPct, endPct) + 0.001;
  const next = { ...(existing || {}) };
  for (const [prop, track] of Object.entries(incoming || {})) {
    if (!track.length) continue;
    const kept = (next[prop] || []).filter((key) => key.position < lo || key.position > hi);
    next[prop] = [...kept, ...track].sort((a, b) => a.position - b.position);
  }
  return next;
}

function parseColorWithAlpha(value) {
  if (typeof value !== 'string') return null;
  const str = value.trim();
  if (!str) return null;

  const hex = str.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const r = parseInt(h[0] + h[0], 16) / 255;
      const g = parseInt(h[1] + h[1], 16) / 255;
      const b = parseInt(h[2] + h[2], 16) / 255;
      const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16) / 255;
      const g = parseInt(h.slice(2, 4), 16) / 255;
      const b = parseInt(h.slice(4, 6), 16) / 255;
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
  }

  const rgba = str.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(',').map((s) => s.trim());
    if (parts.length === 3 || parts.length === 4) {
      const r = Math.max(0, Math.min(1, (Number.parseFloat(parts[0]) || 0) / 255));
      const g = Math.max(0, Math.min(1, (Number.parseFloat(parts[1]) || 0) / 255));
      const b = Math.max(0, Math.min(1, (Number.parseFloat(parts[2]) || 0) / 255));
      const a = parts.length === 4 ? Math.max(0, Math.min(1, Number.parseFloat(parts[3]))) : 1;
      return { r, g, b, a };
    }
  }

  try {
    const color = new THREE.Color(str);
    return { r: color.r, g: color.g, b: color.b, a: 1 };
  } catch {
    return null;
  }
}

function toRgbaString({ r, g, b, a }) {
  const rc = Math.round(Math.max(0, Math.min(1, r)) * 255);
  const gc = Math.round(Math.max(0, Math.min(1, g)) * 255);
  const bc = Math.round(Math.max(0, Math.min(1, b)) * 255);
  const ac = Math.max(0, Math.min(1, a));
  return `rgba(${rc}, ${gc}, ${bc}, ${ac.toFixed(3)})`;
}
