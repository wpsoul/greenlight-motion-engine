// Strip — a bar along the top and the bottom edge of the layer (the frame on an
// adjustment layer, or on a layer that fills it: a letterbox). Look-dev and gates:
// html/strip-lab, tests/strip-lab.
//
// Height is each bar's thickness in % of the box height; Color is the bars' colour and
// the effect's Mix their opacity.
//
// Entrance / Outro: the top bar slides down into place from above the box and the bottom
// bar slides up from below it; the outro plays the same move backwards and ends on the
// last frame of the layer (of the Active Range when the effect has one — the runner
// rebases the clock onto it). A solid bar sliding in from outside the box is the same
// picture as a bar growing from its edge, so the whole animation is one number, `reach`
// (1 at rest, 0 = both bars outside), that scales Height:
//     reach = ease_in(t / inDur) × (1 − ease_out((t − (dur − outDur)) / outDur))
// Each factor is 1 while its animation is off or not running; when the two overlap (a
// layer shorter than both) the product turns the bars back early instead of jumping, and
// an overshooting curve pushes them past Height for a moment, as on a keyframe. reach is
// computed on the CPU with the editor's own easing curves (appEases) and handed to the
// shader in internal slot 24 by `frameUniforms`.
//
// One pass, a handful of ALU. Height 0, reach 0 (before the entrance has started, after
// the outro has finished) or mix 0 → bypass: no pass at all.
import { TRANSITION_EASING_OPTIONS } from './types.js';
import { playedEase } from './appEases.js';

export const STRIP_EFFECT_ID = 'strip';

const ONOFF = [{ value: 0, label: 'Off' }, { value: 1, label: 'On' }];

export const STRIP_PARAMS = [
  { key: 'height', slot: 0, label: 'Height', min: 0, max: 50, step: 0.1, default: 8, suffix: '%' },
  { key: 'color', type: 'color', label: 'Color', default: '#000000' },
  { key: 'intro', slot: 1, label: 'Entrance', type: 'select', segmented: true, default: 1, options: ONOFF },
  { key: 'introDuration', slot: 2, label: 'Duration', min: 0.05, max: 5, step: 0.05, default: 1.25, suffix: 's',
    static: true, showIf: { key: 'intro', equals: 1 } },
  { key: 'introEasing', type: 'easing', label: 'Easing', default: 'Smooth', options: TRANSITION_EASING_OPTIONS,
    showIf: { key: 'intro', equals: 1 } },
  { key: 'outro', slot: 3, label: 'Outro', type: 'select', segmented: true, default: 0, options: ONOFF },
  { key: 'outroDuration', slot: 4, label: 'Duration', min: 0.05, max: 5, step: 0.05, default: 0.8, suffix: 's',
    static: true, showIf: { key: 'outro', equals: 1 } },
  { key: 'outroEasing', type: 'easing', label: 'Easing', default: 'Smooth', options: TRANSITION_EASING_OPTIONS,
    showIf: { key: 'outro', equals: 1 } },
];

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Entrance × Outro at clip-local time `t` of a layer (or Active Range) `dur` seconds
// long. An unknown duration (0 / missing) leaves the outro unplayed.
export function stripReach(params, t, dur) {
  const time = Number.isFinite(t) ? t : 0;
  let k = 1;
  if (Number(params?.intro) > 0.5) {
    const d = Math.max(Number(params.introDuration) || 0, 1e-3);
    k *= playedEase(params.introEasing)(clamp01(time / d));
  }
  if (Number(params?.outro) > 0.5 && dur > 0 && Number.isFinite(dur)) {
    const d = Math.max(Number(params.outroDuration) || 0, 1e-3);
    k *= 1 - playedEase(params.outroEasing)(clamp01((time - (dur - d)) / d));
  }
  return Math.max(0, k);
}

const STRIP_FX = /* glsl */ `
// Box px, y up (0 = the box's bottom edge). Each bar's pixel coverage is measured from
// its own outer edge, so a bar stopping on a fraction of a pixel (every frame of the
// slide) gets a soft 1 px edge instead of a stair; clipped to the box (its sides on a
// turned layer, always 1 in frame scope).
vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  vec2 res = fxRes();
  vec2 px = fxLocal(uv) * res;
  float hPx = clamp(uParams[0] / 100.0, 0.0, 0.5) * max(uParams[24], 0.0) * res.y;
  float bottom = clamp(hPx - px.y + 0.5, 0.0, 1.0);
  float top = clamp(hPx - (res.y - px.y) + 0.5, 0.0, 1.0);
  vec2 inside = clamp(min(px, res - px) + 0.5, 0.0, 1.0);
  float cov = max(top, bottom) * inside.x * inside.y;
  return src * (1.0 - cov) + vec4(uColor, 1.0) * cov;
}
`;

export const STRIP_EFFECT = {
  id: STRIP_EFFECT_ID,
  name: 'Strip',
  group: 'Graphic',
  animated: false,
  // The bars cover the layer's box whatever its alpha (a letterbox over a cut-out
  // still reads as a letterbox); the body clips them to the box itself.
  layerMatte: 'expand',
  // The card lists the controls in this order (Height, Color, then each animation with
  // its own Duration and Easing) instead of grouping them by field type.
  ordered: true,
  params: STRIP_PARAMS,
  fragment: STRIP_FX,
  // Per frame, before the draw: reach on the effect's own clock.
  frameUniforms(slots, params, ctx) {
    slots[24] = stripReach(params, ctx.time, ctx.duration);
  },
  bypassIf(params, ctx) {
    if (!(Number(params.height) > 0)) return true;
    return Number.isFinite(ctx?.time) && !(stripReach(params, ctx.time, ctx.duration) > 0);
  },
};
