// ── Keyframe track expressions (ƒx) ─────────────────────────────────────────
// A rule attached to one keyframe track, the way an After Effects expression sits
// on a property. Stored on the item as `propertyKeyframeFx: { [trackKey]: { type,
// params } }`, sanitized on load like every other item field, and applied inside
// getItemKeyframeValues so every consumer (Player, camera, masks, overlays,
// export) agrees on the result.
//
// The five types relate to the keyframed value differently, which is the thing to
// keep straight when reading this file:
//   elastic / bounce  RESHAPE the move — each keyframe transition is replayed
//                     through a profile, superseding the keys' own easing.
//   glide             SOFTENS it — the keyed motion (easing included) is run
//                     through an all-positive filter, so it lands late and soft.
//   wiggle            ADDS to it — the base motion is untouched.
//   custom            REPLACES it — the expression's result is the value, and
//                     `value` is how an author opts back into the keyframed one.
//
// Everything here is a pure function of (track, config, time) — no Math.random,
// no Date — so the preview and the deterministic export land on identical frames.
// The one exception is a Custom expression reading another layer, which needs the
// per-frame scene the renderer publishes below.
//
// Explicit .js on the import: this module is loaded directly by `node --test`,
// whose ESM resolver (unlike Vite's) does not add the extension. keyframeExpr is
// itself import-free, so the suite still runs without gsap/three.
import { runExpression, smoothNoise, stringSeed, glideValue, MAX_EXPR_LENGTH } from './keyframeExpr.js';
import { KF_PROP_LABELS } from './keyframeProps.js';
import { resolvePlaceholderText } from './textPlaceholders.js';
import { isContainerClip } from './types.js';
import { getTimelineLayout, getTimelineDuration, mapTimelineToSource } from './speedUtils.js';

// Parameter metadata drives the popover UI, the sanitizer clamps and the
// defaults, so the three can never disagree. `def` may be a function of the
// track's property metadata (wiggle's amplitude is in the property's own units,
// so one static default cannot fit both `scale` and `translateX`).
export const KEYFRAME_FX_TYPES = [
  {
    id: 'elastic',
    label: 'Elastic',
    hint: 'The move itself becomes springy: it launches at the key before, overshoots the target and wobbles into place.',
    params: [
      // Percent mix between the plain keyframed motion (0) and the full spring
      // (100); past 100 the spring is extrapolated for exaggeration.
      { key: 'amp', label: 'Strength', min: 0, max: 300, step: 1, def: 100, suffix: '%' },
      // Wobbles across the MOVE, not Hz: the profile is normalized to each
      // segment, so a 0.3s move and a 3s move both read as the same gesture.
      // Lower it for a soft landing that overshoots once around the key; raise
      // it for a fast arrival followed by several wobbles.
      { key: 'freq', label: 'Wobbles', min: 0.3, max: 5, step: 0.1, def: 1.1 },
      // Paired with the default Wobbles this gives a ~10% overshoot that has
      // decayed to under 1% by the key — so a final key still lands on its
      // value — while leaving enough tail to carry into a following segment.
      { key: 'decay', label: 'Decay', min: 0.5, max: 15, step: 0.1, def: 5 },
    ],
  },
  {
    id: 'bounce',
    label: 'Bounce',
    hint: 'The move falls onto the target like a dropped ball and rebounds in decaying hops, settling on the key.',
    params: [
      { key: 'amp', label: 'Strength', min: 0, max: 300, step: 1, def: 100, suffix: '%' },
      // How much of the segment the hops occupy vs. the fall — the profile is
      // self-normalizing (fall + every hop fit the move exactly), so no gravity
      // or hop-time knob is needed and it is unit-independent by construction.
      { key: 'elasticity', label: 'Bounciness', min: 5, max: 80, step: 1, def: 45, suffix: '%' },
      { key: 'bounces', label: 'Max Bounces', min: 1, max: 10, step: 1, def: 5 },
    ],
  },
  {
    id: 'wiggle',
    label: 'Wiggle',
    hint: 'Continuous smooth jitter around the keyframed value, like AE wiggle().',
    params: [
      // In the property's own units (AE parity), so the default comes from the
      // property's step: ±10 steps reads as "visible but not violent" everywhere.
      { key: 'amp', label: 'Amplitude', min: 0, max: 2000, step: 0.1, def: (meta) => defaultWiggleAmp(meta) },
      { key: 'freq', label: 'Frequency', min: 0.1, max: 20, step: 0.1, def: 3, suffix: 'Hz' },
    ],
  },
  {
    id: 'glide',
    label: 'Glide',
    hint: 'The move lands soft and keeps sliding on in the direction it travelled, never past the key and never back. On a camera it keeps the shot alive between keys.',
    // One-click starting points, shown as tags above the options. The four
    // landings tuned on the owner's "Easing examples" board (rows 3–6); a preset
    // only sets the params, so every option stays free to change afterwards. The
    // first equals the param defaults, so a fresh Glide opens on it.
    presets: [
      { id: 'soft', label: 'Soft', hint: 'Lands soft and keeps sliding a little (Easing examples row 3)', params: { fast: 0.1, slow: 0.6, weight: 25, delay: 0 } },
      { id: 'floaty', label: 'Floaty', hint: 'A heavier tail: a floatier, longer landing (row 4)', params: { fast: 0.1, slow: 1, weight: 40, delay: 0 } },
      { id: 'trailing', label: 'Trailing', hint: 'The last quarter of the move starts 0.1 s late, like an AE null chain (row 5)', params: { fast: 0.1, slow: 0.45, weight: 25, delay: 0.1 } },
      { id: 'endless', label: 'Endless', hint: 'A long, light tail that never visibly stops before the next move (row 6)', params: { fast: 0.1, slow: 2, weight: 14, delay: 0 } },
    ],
    params: [
      // Time constant of the part that tracks the keys. Keep it near 0.1 s so
      // most of the move still arrives on time.
      { key: 'fast', label: 'Response', min: 0.01, max: 3, step: 0.01, def: 0.1, suffix: 's' },
      // Time constant of the slow tail — how long the drift keeps going.
      { key: 'slow', label: 'Tail Length', min: 0.05, max: 8, step: 0.05, def: 0.6, suffix: 's' },
      // Share of every move carried by the tail (glide()'s `weight` × 100).
      { key: 'weight', label: 'Tail Share', min: 0, max: 100, step: 1, def: 25, suffix: '%' },
      // How much later the tail starts than the fast part.
      { key: 'delay', label: 'Tail Delay', min: 0, max: 3, step: 0.01, def: 0, suffix: 's' },
    ],
  },
  {
    id: 'custom',
    label: 'Custom',
    hint: 'Write your own expression. The result becomes the property value.',
    params: [
      // The one non-numeric param in the registry: `kind: code` switches the
      // panel to a textarea + snippet picker, and the sanitizer to a length-capped
      // string. See keyframeExpr.js for the language.
      { key: 'code', label: 'Expression', kind: 'code', def: 'value' },
    ],
  },
];

export function keyframeFxType(id) {
  return KEYFRAME_FX_TYPES.find((t) => t.id === id) || null;
}

function defaultWiggleAmp(meta) {
  const step = Number(meta?.step);
  if (!Number.isFinite(step) || step <= 0) return 10;
  return Math.min(2000, step * 10);
}

function paramDefault(param, propMeta) {
  return typeof param.def === 'function' ? param.def(propMeta) : param.def;
}

// Fresh config for enabling `typeId` on a track whose registry entry is
// `propMeta` (a KF_PROPS-shaped object, or null when unknown).
export function defaultKeyframeFxConfig(typeId, propMeta = null) {
  const type = keyframeFxType(typeId);
  if (!type) return null;
  const params = {};
  for (const p of type.params) params[p.key] = paramDefault(p, propMeta);
  return { type: type.id, params };
}

// ── Sanitizer ──
// Whitelist rebuild, mirroring sanitizePropertyKeyframes: unknown types and
// params are dropped, numbers are clamped into the registry ranges, and — when a
// track map is provided — configs whose track no longer exists die as orphans.
export function sanitizeKeyframeFxMap(raw, propertyKeyframes = null) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [prop, cfg] of Object.entries(raw)) {
    if (propertyKeyframes && !Array.isArray(propertyKeyframes[prop])) continue;
    const type = keyframeFxType(cfg?.type);
    if (!type) continue;
    const params = {};
    for (const p of type.params) {
      const fallback = paramDefault(p, null);
      if (p.kind === 'code') {
        // Kept as text and never compiled here — expressions are interpreted by
        // keyframeExpr.js, never handed to a JS compiler. Length is capped so a
        // pasted blob cannot bloat every autosave.
        const raw = cfg?.params?.[p.key];
        params[p.key] = typeof raw === 'string' ? raw.slice(0, MAX_EXPR_LENGTH) : fallback;
        continue;
      }
      const v = Number.parseFloat(cfg?.params?.[p.key]);
      params[p.key] = Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : fallback;
    }
    out[prop] = { type: type.id, params };
  }
  return out;
}

export function hasAnyKeyframeFx(map) {
  return !!map && typeof map === 'object' && Object.keys(map).length > 0;
}

// ── Evaluation ──────────────────────────────────────────────────────────────
//
// Elastic and Bounce RESHAPE THE MOVE ITSELF. They are not rings appended after
// a key: that model (the literal AE Smart Bounce translation) reads as two
// separate animations here, because this editor's default easing is ease-in-out
// — the base motion visibly decelerates to a full stop at the key, and only
// then would a ring start. It is also dead on the commonest track of all (keys
// at 0 and 100), where there is no time after the last key to ring in.
//
// Instead each keyframe transition is treated as a STEP of size A = value[i] −
// value[i−1], and the step is played back through a normalized profile f(u),
// u = (t − t[i−1]) / segmentDuration:
//
//   value(t) = value[0] + Σ A_i · f(u_i)      (f(u≤0) = 0, f(u→∞) = 1)
//
// So the spring/bounce shape IS the interpolation: the layer launches at the
// previous key, overshoots the target, and wobbles into place — one continuous
// gesture. Superposition handles overlapping keys for free: a ring that has not
// settled simply carries into the next segment, and the sum stays continuous
// everywhere. Because u is normalized per segment, a 0.3s move and a 3s move
// read as the same gesture, and the result never depends on the property's
// units. `base` is used only for the Strength mix, so 0% is exactly the
// unmodified keyframed motion.

function numOr(v, fallback) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

// Damped sinusoid step response. f(0) = 0, f(∞) = 1; it crosses the target at
// u = 1/(4·wobbles), peaks half a period later, then rings down under the
// e^(−decay·u) envelope. Envelope and frequency are independent (unlike a real
// mass-spring), which is what lets a slow arrival still wobble quickly.
function elasticProfile(u, wobbles, decay) {
  if (u <= 0) return 0;
  if (decay * u > 6.9) return 1; // envelope below 0.1% — settled
  return 1 - Math.exp(-decay * u) * Math.cos(2 * Math.PI * wobbles * u);
}

// Ball-drop profile: accelerate onto the target, then rebound in hops that lose
// `e` of their speed each time. Self-normalizing — the fall plus every hop are
// scaled to fit exactly in u = [0, 1], so the motion settles ON the key with no
// gravity or hop-duration knob to tune.
function bounceProfile(u, e, nMax) {
  if (u <= 0) return 0;
  // Total = fall + Σ hops = T0·(1 + 2e(1−e^n)/(1−e)) ≡ 1.
  const hopSum = (2 * e * (1 - Math.pow(e, nMax))) / (1 - e);
  const T0 = 1 / (1 + hopSum);
  if (u >= 1) return 1;
  if (u < T0) {
    const r = u / T0;
    return r * r; // ½gu² with g chosen so the fall covers 1 in T0
  }
  const g = 2 / (T0 * T0);
  const v = g * T0;
  let vk = v * e;
  let hop = (2 * vk) / g;
  let tb = u - T0;
  let nb = 1;
  while (tb > hop && nb <= nMax) {
    tb -= hop;
    vk *= e;
    hop *= e;
    nb += 1;
  }
  if (nb > nMax) return 1;
  // Rebound travels back the way it came, so it subtracts from the target.
  return 1 - (vk * tb - (g * tb * tb) / 2);
}

// Superpose every keyframe step through `profile`, then mix with the base.
function profiledValue(track, pct, base, durationSec, strength, profile) {
  if (track.length < 2 || !(strength > 0)) return base;
  const t = (pct / 100) * durationSec;
  let value = numOr(track[0].value, NaN);
  if (!Number.isFinite(value)) return base;
  for (let i = 1; i < track.length; i += 1) {
    const prev = numOr(track[i - 1].value, NaN);
    const cur = numOr(track[i].value, NaN);
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) return base;
    const step = cur - prev;
    if (step === 0) continue; // a hold never wobbles
    const tPrev = (Number(track[i - 1].position) / 100) * durationSec;
    const segSec = (Number(track[i].position) / 100) * durationSec - tPrev;
    if (!(segSec > 0)) continue;
    value += step * profile((t - tPrev) / segSec);
  }
  return base + strength * (value - base);
}

function elasticValue(cfg, track, pct, base, durationSec) {
  const { amp, freq, decay } = cfg.params;
  return profiledValue(track, pct, base, durationSec, amp / 100, (u) => elasticProfile(u, freq, decay));
}

function bounceValue(cfg, track, pct, base, durationSec) {
  const { amp, elasticity, bounces } = cfg.params;
  const e = Math.min(0.95, Math.max(0.01, elasticity / 100));
  const nMax = Math.max(1, Math.round(bounces));
  return profiledValue(track, pct, base, durationSec, amp / 100, (u) => bounceProfile(u, e, nMax));
}

// Wiggle — smooth value-noise around the keyframed value, seeded per
// (item, track) so two layers with identical tracks don't jitter in sync. Shares
// the expression language's generator, so `wiggle()` written by hand in a Custom
// expression and the Wiggle type produce the same shape.
function wiggleOffset(cfg, tSec, seed) {
  const amp = cfg.params.amp;
  if (!(amp > 0)) return 0;
  return amp * smoothNoise(tSec * cfg.params.freq, seed);
}

// ── Scene context (Custom expressions only) ─────────────────────────────────
// `time`, `frame` and other layers' values need things a single item cannot know:
// the project clock, the frame rate, and every other layer's placement. The
// renderer publishes them here once per frame (Player.renderFrame), and the
// evaluator reads them. Absent — the keyframe panel's own preview, a unit test —
// expressions still evaluate, with time running inside the clip and layer
// lookups resolving to null.
let scene = null;

/**
 * @param {object|null} next
 *   time      absolute project time, seconds
 *   fps       project frame rate
 *   index     Map(itemId -> { item, startTime, duration, channelIndex }) from buildParentIndex
 *   nameOf    (entry) => display name, so the renderer keeps the naming rule
 *   evaluate  (item, progress) => values — injected to avoid importing gsapTransitions
 */
export function setKeyframeFxScene(next) {
  scene = next || null;
}

// name -> entry, cached per index Map identity. The index is a useMemo in the
// Player, so this is rebuilt only when the timeline actually changes, not per
// frame. WeakMap: a stale index is collectable.
const layerNameCache = new WeakMap();

function layersByName() {
  if (!scene?.index) return null;
  const hit = layerNameCache.get(scene.index);
  if (hit) return hit;
  const map = new Map();
  for (const entry of scene.index.values()) {
    const name = String(scene.nameOf?.(entry) || '').trim().toLowerCase();
    // First writer wins, so two layers sharing a name resolve to the topmost.
    if (name && !map.has(name)) map.set(name, entry);
  }
  layerNameCache.set(scene.index, map);
  return map;
}

// Static stand-ins for the handful of properties that have an item-level value
// when they are not keyframed. Everything else reads 0 — a layer that never
// animates `blur` has no meaningful blur to report.
function staticPropValue(item, prop) {
  switch (prop) {
    case 'opacity': return (Number(item.opacity) || 0) / 100;
    case 'scale': return Number(item.zoom) || 1;
    case 'scaleX': return Number(item.scaleX) || 1;
    case 'scaleY': return Number(item.scaleY) || 1;
    case 'rotate': case 'rotateZ': return Number(item.rotateZ ?? item.rotation) || 0;
    case 'rotateX': return Number(item.rotateX) || 0;
    case 'rotateY': return Number(item.rotateY) || 0;
    case 'xPercent': return Number(item.panX) || 0;
    case 'yPercent': return Number(item.panY) || 0;
    case 'translateZ': return Number(item.panZ) || 0;
    case 'motionPathT': return Number(item.motionPathT) || 0;
    default: return 0;
  }
}

// How deep we are inside cross-layer evaluation. Two layers may reference each
// other; without this the pair would recurse until the stack blew. At the cap a
// layer reports its plain keyframed value (expressions skipped), which is a
// stable, obviously-correct answer rather than a crash.
let evalDepth = 0;
const MAX_LAYER_DEPTH = 2;

const KNOWN_PROP_NAMES = new Set(KF_PROP_LABELS);

// ── Reading INTO a container (sequence / grid) ──────────────────────────────
// A container layer owns a private timeline (`clip.sequence`). Its inner items
// are invisible to the outer index, so `layer("Seq").layer("Inner").scale` walks
// down: map the outer clock onto the container's inner timeline (exactly the
// mapping the renderer uses — trim + speed), then resolve the inner item there.
// Nesting works because each level hands the next one its own clock.

// name -> { item, startTime, duration }, cached per channels-array identity so
// this is rebuilt only when the nested timeline is actually edited.
const innerIndexCache = new WeakMap();

function innerIndexOf(clip) {
  const channels = clip?.sequence?.channels;
  if (!Array.isArray(channels)) return null;
  const hit = innerIndexCache.get(channels);
  if (hit) return hit;
  const clipsMap = new Map((clip.sequence.clips || []).map((c) => [c.id, c]));
  const byName = new Map();
  channels.forEach((channel) => {
    const layout = getTimelineLayout(channel.items || [], { unsnapped: channel.unsnapped });
    (channel.items || []).forEach((item, i) => {
      const span = layout[i];
      if (!span) return;
      const inner = clipsMap.get(item.clipId);
      const name = String(
        item.customName
        || (inner?.mediaType === 'text' ? (resolvePlaceholderText(item.textContent) || inner?.name) : inner?.name)
        || '',
      ).trim().toLowerCase();
      if (!name || byName.has(name)) return;
      byName.set(name, {
        item,
        clip: inner,
        startTime: span.startTime,
        duration: Math.max(0, span.endTime - span.startTime),
      });
    });
  });
  innerIndexCache.set(channels, byName);
  return byName;
}

// Where a container's inner timeline is at `outerLocal` seconds into the clip —
// the same trim + speed mapping the Player's calculateVideoTime performs.
function containerInnerTime(item, outerLocal) {
  const trimStart = Number(item.trimStart) || 0;
  const sourceDuration = (Number(item.trimEnd) || 0) - trimStart;
  if (!(sourceDuration > 0)) return Math.max(0, outerLocal);
  const timelineDuration = getTimelineDuration(sourceDuration, item.speedPoints);
  const normalized = timelineDuration > 0
    ? Math.max(0, Math.min(1, outerLocal / timelineDuration))
    : 0;
  return trimStart + mapTimelineToSource(item.speedPoints, normalized) * sourceDuration;
}

/**
 * A readable layer at some level of the composition.
 * `entry`  { item, startTime, duration, clip? }
 * `nowOf`  () => the current time on the timeline THIS entry lives on
 * `label`  what to call it in an error message
 */
function layerReader(entry, nowOf, label) {
  if (!entry) return null;
  const localTime = () => Math.max(0, (Number(nowOf()) || 0) - (Number(entry.startTime) || 0));
  return {
    get(prop) {
      const item = entry.item;
      if (!item) return 0;
      const dur = Number(entry.duration) || 0;
      const progress = dur > 0 ? Math.max(0, Math.min(1, localTime() / dur)) : 0;
      if (Array.isArray(item.propertyKeyframes?.[prop]) && typeof scene?.evaluate === 'function') {
        evalDepth += 1;
        try {
          const v = scene.evaluate(item, progress)?.[prop];
          const n = Number.parseFloat(v);
          if (Number.isFinite(n)) return n;
        } finally {
          evalDepth -= 1;
        }
      }
      // A name that is not a property AT ALL is a typo, and reading 0 for it
      // hides the mistake behind a plausible number — `layer("X").scalevalue`
      // silently animating to zero is indistinguishable from a layer that really
      // sits at zero. A REAL property that this layer simply doesn't animate is
      // different: that has a legitimate static value to report.
      if (!KNOWN_PROP_NAMES.has(prop)) {
        throw new Error(`"${label}" has no property "${prop}"`);
      }
      return staticPropValue(item, prop);
    },
    // Drill into a container layer's own timeline.
    child(name) {
      const clip = entry.clip || scene?.clipOf?.(entry.item);
      if (!isContainerClip(clip)) throw new Error(`"${label}" is not a sequence, so it has no layers inside it`);
      if (evalDepth >= MAX_LAYER_DEPTH) return null;
      const index = innerIndexOf(clip);
      const found = index?.get(String(name).trim().toLowerCase());
      if (!found) throw new Error(`"${label}" has no layer named ${JSON.stringify(String(name))} inside it`);
      // The inner timeline's clock, derived from this entry's own local time.
      const innerNow = () => containerInnerTime(entry.item, localTime());
      return layerReader(found, innerNow, `${label} › ${name}`);
    },
  };
}

function readerFor(entry) {
  return layerReader(entry, () => Number(scene?.time) || 0, scene?.nameOf?.(entry) || 'that layer');
}

// ── Track sampling (loopOut / loopIn / valueAtTime) ─────────────────────────
// Repeating an animation means reading the property's own track at OTHER times,
// with its easings applied. That evaluator lives in gsapTransitions (which
// imports this module), so it is injected once at import time rather than
// imported back. Until then a linear fallback keeps the loop shapes correct —
// only the easing within a segment would differ.
let trackSampler = null;

export function setKeyframeTrackSampler(fn) {
  if (typeof fn === 'function') trackSampler = fn;
}

function linearSampleTrack(track, pct) {
  const keys = [...track].sort((a, b) => Number(a.position) - Number(b.position));
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (pct <= Number(first.position)) return numOr(first.value, 0);
  if (pct >= Number(last.position)) return numOr(last.value, 0);
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i];
    const b = keys[i + 1];
    const pa = Number(a.position);
    const pb = Number(b.position);
    if (pct >= pa && pct <= pb) {
      const u = pb > pa ? (pct - pa) / (pb - pa) : 0;
      return numOr(a.value, 0) + (numOr(b.value, 0) - numOr(a.value, 0)) * u;
    }
  }
  return numOr(last.value, 0);
}

function sampleTrackAt(track, pct) {
  const v = trackSampler ? trackSampler(track, pct) : linearSampleTrack(track, pct);
  return numOr(v, 0);
}

// Glide: the track's own keyed motion through the same filter a Custom
// `glide(…)` runs, fed the same clock and sampler, so the type and the
// hand-written expression land on identical frames. Only the stored share
// differs: a percent here, a 0–1 weight in the language.
function glideTrackValue(cfg, track, pct, base, durationSec) {
  const { fast, slow, weight, delay } = cfg.params;
  const ctx = {
    value: base,
    time: (pct / 100) * durationSec,
    valueAt: (tSec) => sampleTrackAt(track, (tSec / durationSec) * 100),
  };
  return glideValue(ctx, fast, slow, weight / 100, delay);
}

// The evaluation context for one (item, track, moment).
function expressionContext(item, track, pct, base, durationSec, seedKey) {
  const localTime = (pct / 100) * durationSec;
  const fps = Number(scene?.fps) > 0 ? Number(scene.fps) : 30;
  const selfEntry = scene?.index?.get(item?.id) || null;
  const keys = Array.isArray(track) ? track : [];
  return {
    value: base,
    time: localTime,
    frame: Math.floor(localTime * fps + 1e-6),
    fps,
    duration: durationSec,
    progress: pct / 100,
    index: selfEntry?.channelIndex ?? 0,
    seed: stringSeed(seedKey),
    // This property's own keyframes, in clip-local seconds, plus a sampler —
    // what loopOut/loopIn/valueAtTime read.
    keyTimes: keys
      .map((k) => (Number(k.position) / 100) * durationSec)
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b),
    valueAt: (tSec) => (durationSec > 0 ? sampleTrackAt(keys, (tSec / durationSec) * 100) : base),
    resolveLayer: (name) => {
      if (evalDepth >= MAX_LAYER_DEPTH) return null;
      if (typeof name === 'number') {
        for (const entry of scene?.index?.values() || []) {
          if (entry.channelIndex === Math.trunc(name)) return readerFor(entry);
        }
        return null;
      }
      const found = layersByName()?.get(String(name).trim().toLowerCase());
      return found ? readerFor(found) : null;
    },
    resolveSelf: () => (selfEntry ? readerFor(selfEntry) : null),
  };
}

/**
 * Run a Custom expression outside the render loop — the panel uses this to show
 * a live result or the parse error under the editor. Same context builder as the
 * real evaluation, so what the panel reports is what the canvas will do.
 */
export function testKeyframeExpression(code, { item, track, pct, base, durationSec, seedKey = '' } = {}) {
  const ctx = expressionContext(item || {}, track, Number(pct) || 0, Number(base) || 0, Number(durationSec) || 1, seedKey);
  return runExpression(code, ctx);
}

// One track, one config, one moment. `base` is the interpolated track value
// (the plain keyframed motion); returns the expression-adjusted value.
export function evaluateKeyframeFx(cfg, track, pct, base, durationSec, seedKey = '', item = null) {
  if (!cfg || !Array.isArray(track) || track.length === 0) return base;
  if (!Number.isFinite(base) || !(durationSec > 0)) return base;
  switch (cfg.type) {
    case 'elastic':
      return elasticValue(cfg, track, pct, base, durationSec);
    case 'bounce':
      return bounceValue(cfg, track, pct, base, durationSec);
    case 'wiggle':
      return base + wiggleOffset(cfg, (pct / 100) * durationSec, stringSeed(seedKey));
    case 'glide':
      return glideTrackValue(cfg, track, pct, base, durationSec);
    case 'custom': {
      // A broken expression must never break a render: runExpression returns the
      // untouched base value alongside the message the panel shows.
      const ctx = expressionContext(item || {}, track, pct, base, durationSec, seedKey);
      return runExpression(cfg.params.code, ctx).value;
    }
    default:
      return base;
  }
}

// Map-level application: post-processes the values object produced by
// interpolatePropertyKeyframes. Non-numeric values (colors, paths) are left
// alone; the object is only cloned when something actually changes.
export function applyKeyframeFxToValues(item, values, progress, durationSec) {
  const fxMap = item?.propertyKeyframeFx;
  if (!values || !hasAnyKeyframeFx(fxMap)) return values;
  // Reached through another layer's expression, at the recursion cap: report the
  // plain keyframed values rather than recursing further.
  if (evalDepth >= MAX_LAYER_DEPTH) return values;
  let out = values;
  let cloned = false;
  const pct = progress * 100;
  for (const [prop, cfg] of Object.entries(fxMap)) {
    const track = item.propertyKeyframes?.[prop];
    if (!Array.isArray(track) || track.length === 0) continue;
    const base = Number.parseFloat(out[prop]);
    if (!Number.isFinite(base)) continue;
    const v = evaluateKeyframeFx(cfg, track, pct, base, durationSec, `${item.id || ''}|${prop}`, item);
    if (v !== base) {
      if (!cloned) { out = { ...values }; cloned = true; }
      out[prop] = v;
    }
  }
  return out;
}
