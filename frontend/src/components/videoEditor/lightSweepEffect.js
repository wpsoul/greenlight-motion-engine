// Light Sweep — After Effects' CC Light Sweep (html/light-sweep-lab.html is the look-dev,
// tests/light-sweep-lab the gates; the curves and defaults below were read off AE 2026's
// own renders in tests/light-sweep-lab/ae).
//
// A straight beam of light runs through Center at Direction (0° = a vertical beam, clockwise
// as in AE). Across the beam the light falls off over 2 × Width px (Width is the half-width
// at half strength), with t = distance / (2 · Width):
//     Linear  1 − t        Smooth  (1 − t)²(1 + 2t)        Sharp  (1 − t)²
// light = Sweep Intensity / 100 × curve. Where the beam lands, the edges that face the
// Direction arrow catch more: 2 × Edge Intensity / 100 on the edge, fading to 0 at
// 2 × Edge Thickness px inside it (measured along the light), times the same curve.
// Light Reception: Add = colour + light × Light Color (clipped), Composite = the colour mixed
// toward Light Color by the light, Cutout = only the light. All three keep the layer's alpha
// as the limit, so nothing lands outside the artwork.
//
// Beyond AE — Animate: Sweep runs the beam across the layer box on the effect's own clock
// (an Active Range rebases it) instead of a keyframed Center: from fully off one side to fully
// off the other in Duration, on one of the editor's easing curves, Once or looping with a Gap,
// Forward / Backward / Back and forth. The progress is worked out per frame on the CPU
// (`frameUniforms`, internal slot 24), so the shader only places the beam. Manual keeps Center
// where it is set (keyframable).
//
// Sizes are px of a 1080-high frame (uResolution.y / 1080, the chain's `ref`), measured on the
// layer box, so the look rides the layer and matches between preview and export.
// One pass; up to 13 taps with edges on. Bypassed when nothing would light (zero intensities,
// or a sweep parked off the layer) — except Cutout, whose output is the light alone.
import { TRANSITION_EASING_OPTIONS } from './types.js';
import { playedEase } from './appEases.js';

export const LIGHT_SWEEP_EFFECT_ID = 'lightSweep';

const SWEEP = { key: 'animate', equals: 1 };
const MANUAL = { key: 'animate', equals: 0 };

export const LIGHT_SWEEP_PARAMS = [
  // `free`, as in AE: the ranges bound the slider, not the value. A keyed spin runs past ±180° (−30° → −271°),
  // the beam's pivot often sits far off the layer, and a big layer takes a Width or Edge Thickness past the slider.
  { key: 'direction', slot: 2, label: 'Direction', min: -180, max: 180, step: 0.5, default: -30, suffix: '°', free: true },
  { key: 'shape', slot: 3, label: 'Shape', type: 'select', segmented: true, default: 2, options: [
    { value: 0, label: 'Linear' }, { value: 1, label: 'Smooth' }, { value: 2, label: 'Sharp' }] },
  { key: 'width', slot: 4, label: 'Width', min: 1, max: 1000, step: 1, default: 50, suffix: 'px', free: true },
  { key: 'sweepIntensity', slot: 5, label: 'Sweep Intensity', min: 0, max: 500, step: 1, default: 25 },
  { key: 'edgeIntensity', slot: 6, label: 'Edge Intensity', min: 0, max: 500, step: 1, default: 50 },
  { key: 'edgeThickness', slot: 7, label: 'Edge Thickness', min: 0, max: 20, step: 0.1, default: 4, suffix: 'px', free: true },
  // Stacked: beside a swatch + hex value or a three-way switch the inspector cuts these labels down to "Li…".
  { key: 'lightColor', type: 'color', label: 'Light Color', default: '#fffaf0', stacked: true },
  { key: 'reception', slot: 8, label: 'Light Reception', type: 'select', segmented: true, stacked: true, default: 0, options: [
    { value: 0, label: 'Add' }, { value: 1, label: 'Composite' }, { value: 2, label: 'Cutout' }] },
  { key: 'animate', slot: 9, label: 'Animate', type: 'select', segmented: true, default: 1, options: [
    { value: 0, label: 'Manual' }, { value: 1, label: 'Sweep' }] },
  { key: 'centerX', slot: 0, label: 'Center X', min: -0.5, max: 1.5, step: 0.005, default: 0.5, free: true, showIf: MANUAL },
  { key: 'centerY', slot: 1, label: 'Center Y', min: -0.5, max: 1.5, step: 0.005, default: 0.25, free: true, showIf: MANUAL },
  // Duration and Gap shape the sweep's timeline, which is not integrated over time: a keyframed
  // value would make the beam jump, so they stay off keyframe tracks (as in Strip).
  { key: 'duration', slot: 10, label: 'Duration', min: 0.1, max: 10, step: 0.05, default: 1.2, suffix: 's',
    static: true, showIf: SWEEP },
  { key: 'easing', type: 'easing', label: 'Easing', default: 'Smooth', options: TRANSITION_EASING_OPTIONS,
    showIf: SWEEP },
  { key: 'repeat', slot: 12, label: 'Repeat', type: 'select', segmented: true, default: 1, showIf: SWEEP, options: [
    { value: 0, label: 'Once' }, { value: 1, label: 'Loop' }] },
  { key: 'gap', slot: 13, label: 'Gap', min: 0, max: 10, step: 0.05, default: 1.2, suffix: 's',
    static: true, showIf: SWEEP },
  { key: 'travel', slot: 14, label: 'Travel', type: 'select', default: 0, showIf: SWEEP, options: [
    { value: 0, label: 'Forward' }, { value: 1, label: 'Backward' }, { value: 2, label: 'Back and forth' }] },
];

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Where a sweep is at clip-local time t: 0 = the beam fully off the start side of the box,
// 1 = fully off the far side (an overshooting curve may go a little past either end, which is
// still off). Back and forth plays every second pass reversed; Once stops after its pass(es)
// and parks the beam where the last one ended.
export function lightSweepProgress(params, t) {
  const dur = Math.max(Number(params?.duration) || 0, 0.05);
  const period = dur + Math.max(Number(params?.gap) || 0, 0);
  const travel = Number(params?.travel) || 0;
  const pingpong = travel > 1.5 ? 1 : 0;
  const tc = Math.max(Number.isFinite(t) ? t : 0, 0);
  let n = Math.floor(tc / period);
  let tt = tc - n * period;
  if (!(Number(params?.repeat) > 0.5) && n > pingpong) { n = pingpong; tt = period; }
  let k = playedEase(params?.easing)(clamp01(tt / dur));
  if (pingpong && n % 2 === 1) k = 1 - k;
  if (travel > 0.5 && travel < 1.5) k = 1 - k;
  return k;
}

const LIGHT_SWEEP_FX = /* glsl */ `
// The falloff across the beam, t = distance / (2 · Width).
float lswProfile(float t, float shape) {
  t = clamp(t, 0.0, 1.0);
  float u = 1.0 - t;
  if (shape < 0.5) return u;
  if (shape < 1.5) return u * u * (1.0 + 2.0 * t);
  return u * u;
}
// One tap of the ray toward the light. The frame cuts a layer that runs past it, but the layer
// goes on out there (AE reads the whole layer), so a tap off the plate and still inside the box
// counts as this pixel's own alpha: only the layer's edges catch light, never the frame's.
float lswTap(vec2 q, float a) {
  if (q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0) return texture2D(uTexture, q).a;
  vec2 b = fxLocal(q);
  return (b.x >= 0.0 && b.x <= 1.0 && b.y >= 0.0 && b.y <= 1.0) ? a : 0.0;
}
vec4 fx(vec2 uv) {
  vec4 base = texture2D(uTexture, uv);
  float sc = max(uResolution.y / 1080.0, 1e-4);
  vec2 box = fxRes() / sc;
  vec2 l = fxLocal(uv);
  vec2 P = vec2(l.x, 1.0 - l.y) * box;           // y down from the box's top-left, like AE layer space
  float th = radians(uParams[2]);
  vec2 axis = vec2(sin(th), -cos(th));           // along the beam: the Direction arrow, where the light comes from
  vec2 across = vec2(cos(th), sin(th));          // across the beam: the way a sweep travels
  float W = max(uParams[4], 0.5);
  float d;
  if (uParams[9] > 0.5) {
    // A sweep starts and ends with the whole beam (2 · Width each side) past the box.
    float span = abs(across.x) * box.x + abs(across.y) * box.y;
    float reach = 0.5 * span + 2.0 * W + 2.0;
    d = dot(P - 0.5 * box, across) - mix(-reach, reach, uParams[24]);
  } else {
    d = dot(P - vec2(uParams[0], uParams[1]) * box, across);
  }
  float beam = lswProfile(abs(d) / (2.0 * W), uParams[3]);
  float light = beam * uParams[5] / 100.0;
  float edgeT = max(uParams[7], 0.0);
  if (uParams[6] > 0.0 && edgeT > 0.0 && beam > 0.0 && base.a > 0.0) {
    // The share of a ray toward the light, 2 · Edge Thickness long, that leaves the layer:
    // 1 on an edge that faces the light, 0 that far inside it; edges facing away get nothing.
    vec2 stepUv = fxDir(vec2(axis.x / box.x, -axis.y / box.y)) * (2.0 * edgeT);
    float inside = 0.0;
    for (int i = 1; i <= 12; i++) inside += lswTap(uv + stepUv * (float(i) / 12.0), base.a);
    light += 2.0 * (1.0 - inside / 12.0) * beam * uParams[6] / 100.0;
  }
  vec3 s = unpremult(base);
  float rec = uParams[8];
  if (rec < 0.5) return vec4(clamp(s + uColor * light, 0.0, 1.0) * base.a, base.a);
  if (rec < 1.5) return vec4(mix(s, uColor, clamp(light, 0.0, 1.0)) * base.a, base.a);
  float a = base.a * clamp(light, 0.0, 1.0);
  return vec4(uColor * a, a);
}
`;

export const LIGHT_SWEEP_EFFECT = {
  id: LIGHT_SWEEP_EFFECT_ID,
  name: 'Light Sweep',
  group: 'Light',
  desc: 'A streak of light across the layer, its edges catching the light (After Effects CC Light Sweep)',
  animated: true,
  // Every mode stays inside the layer's own alpha, so the output already IS the silhouette;
  // clipping would multiply a semi-transparent pixel by its alpha a second time.
  layerMatte: 'expand',
  // The card lists AE's controls in AE's order, then Animate and its own fields.
  ordered: true,
  params: LIGHT_SWEEP_PARAMS,
  colorPresets: [
    { name: 'AE Default', colors: ['#fffaf0'], params: { direction: -30, shape: 2, width: 50, sweepIntensity: 25, edgeIntensity: 50, edgeThickness: 4, reception: 0 } },
    { name: 'Logo Shine', colors: ['#ffffff'], params: { direction: -25, shape: 2, width: 60, sweepIntensity: 70, edgeIntensity: 60, edgeThickness: 3, reception: 0 } },
    { name: 'Soft Sheen', colors: ['#ffffff'], params: { direction: -35, shape: 1, width: 120, sweepIntensity: 35, edgeIntensity: 20, edgeThickness: 5, reception: 0 } },
    { name: 'Thin Glint', colors: ['#ffffff'], params: { direction: -20, shape: 0, width: 12, sweepIntensity: 120, edgeIntensity: 40, edgeThickness: 2, reception: 0 } },
    { name: 'Warm Gold', colors: ['#ffd98a'], params: { direction: -30, shape: 2, width: 70, sweepIntensity: 55, edgeIntensity: 80, edgeThickness: 4, reception: 0 } },
    { name: 'Bevel Catch', colors: ['#ffffff'], params: { direction: -40, shape: 1, width: 120, sweepIntensity: 10, edgeIntensity: 120, edgeThickness: 7, reception: 0 } },
    { name: 'Tinted Wash', colors: ['#9fd8ff'], params: { direction: -30, shape: 1, width: 90, sweepIntensity: 55, edgeIntensity: 30, edgeThickness: 4, reception: 1 } },
    { name: 'Light Only', colors: ['#ffffff'], params: { direction: -30, shape: 2, width: 60, sweepIntensity: 100, edgeIntensity: 70, edgeThickness: 4, reception: 2 } },
  ],
  fragment: LIGHT_SWEEP_FX,
  // Per frame, before the draw: the sweep's progress on the effect's own clock.
  frameUniforms(slots, params, ctx) {
    slots[24] = Number(params.animate) > 0.5 ? lightSweepProgress(params, ctx.time) : 0;
  },
  bypassIf(params, ctx) {
    if (Number(params.reception) > 1.5) return false;   // Cutout: the output is the light alone
    const edges = Number(params.edgeIntensity) > 0 && Number(params.edgeThickness) > 0;
    if (!(Number(params.sweepIntensity) > 0) && !edges) return true;
    if (Number(params.animate) > 0.5 && Number.isFinite(ctx?.time)) {
      const k = lightSweepProgress(params, ctx.time);
      return k <= 0 || k >= 1;
    }
    return false;
  },
};
