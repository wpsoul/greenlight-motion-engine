// Effect package starter for the WebGPU engine (GET /api/video-editor/engine → "webgpu").
// The shading is TSL: `fragmentNode(ctx)` returns a vec4 node and is called inside the effect
// material, like a built-in effect's body. For the WebGL engine start from starter-effect-glsl.js.
//
// Chromatic Drift: splits red and blue along an angle, with a slow wobble and an optional tint.
// The same effect as the GLSL starter, so the two read side by side.

export const id = 'chromatic-drift-gpu';       // kebab-case; the effect is `local:chromatic-drift-gpu`
export const name = 'Chromatic Drift (WebGPU)';
export const renderer = 'webgpu';              // TSL draws on WebGPU only
export const description = 'Splits red and blue along an angle, with a slow wobble.';
export const animated = true;                  // reads ctx.time

// ≤ 16 number params (range, number, select, switch) and ≤ 5 colours, read by key:
// ctx.param('amount') is a float node, ctx.color('tint') a vec3 node (0–1).
export const params = [
  { key: 'amount', label: 'Amount', type: 'range', min: 0, max: 40, step: 0.5, default: 6, suffix: 'px' },
  { key: 'angle', label: 'Angle', type: 'range', min: -180, max: 180, step: 1, default: 0, suffix: '°' },
  { key: 'speed', label: 'Wobble', type: 'range', min: 0, max: 4, step: 0.05, default: 0.5 },
  { key: 'tint', label: 'Tint', type: 'color', default: '#ffffff' },
  { key: 'tintMix', label: 'Tint amount', type: 'range', min: 0, max: 1, step: 0.01, default: 0 },
];

// ctx: tsl (the whole TSL namespace — the package imports nothing), uv (0–1, y DOWN — sample
// with it), geoUv (0–1, y up, for maths that must match GLSL), src (the layer at uv,
// premultiplied), sample(uv), param(key), color(key), time, progress, resolution, quality, and
// the layer-box helpers fxLocal, fxFrame, fxDir, fxRes, fxAspect, fxCoord, fxGeoLocal, fxGeoCoord.
// Directions are built y-up, exactly as in GLSL, and mapped with fxDir() (pixels → uv, in the
// layer's own frame); positions use fxLocal(uv). Never flip y by hand: fxDir and fxLocal are what
// keep the picture upright on both engines, so shading ports between the starters line for line.
// Return premultiplied colour; the editor applies Mix afterwards.
export function fragmentNode({ tsl, uv, sample, param, color, time, fxDir, fxRes }) {
  const { vec2, vec3, vec4, sin, cos, radians, mix, max } = tsl;
  const a = radians(param('angle'));
  const dir = vec2(cos(a), sin(a));
  const wobble = sin(time.mul(param('speed')).mul(6.2831853)).mul(0.5).add(0.5);
  const off = fxDir(dir.mul(param('amount').mul(mix(0.4, 1.0, wobble)).div(fxRes())));
  const r = sample(uv.add(off));
  const g = sample(uv);
  const b = sample(uv.sub(off));
  const alpha = max(g.a, max(r.a, b.a));
  const rgb = vec3(r.r, g.g, b.b);
  return vec4(mix(rgb, rgb.mul(color('tint')), param('tintMix')), alpha);
}

export default { id, name, renderer, description, animated, params, fragmentNode };
