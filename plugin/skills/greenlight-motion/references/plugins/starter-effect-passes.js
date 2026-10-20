// Effect package starter for a MULTI-PASS effect, on BOTH engines.
// Each pass carries GLSL (`fragment`, for WebGL) and TSL (`fragmentNode`, for WebGPU), so the
// package runs whichever engine the editor uses. Drop one of the two (and set `renderer`) for a
// single-engine package.
//
// Soft Glow: the bright parts of the picture, blurred at half size, added back in a colour.
//   bright (½ size) → blurX (½) → blurY (½) → composite (full size, the output)

export const id = 'soft-glow';                  // kebab-case; the effect is `local:soft-glow`
export const name = 'Soft Glow';
export const renderer = 'both';
export const description = 'Adds a soft coloured glow around the bright parts of the picture.';
export const animated = false;                  // never reads time

export const params = [
  { key: 'threshold', label: 'Threshold', type: 'range', min: 0, max: 1, step: 0.01, default: 0.6 },
  { key: 'radius', label: 'Radius', type: 'range', min: 0, max: 40, step: 0.5, default: 14, suffix: 'px' },
  { key: 'intensity', label: 'Intensity', type: 'range', min: 0, max: 4, step: 0.05, default: 1.6 },
  { key: 'glow', label: 'Glow', type: 'color', default: '#ffd27a' },
];

// One separable blur written once, used for both axes. It runs in the module when the package
// loads (pure string / node building, no side effects). `resolution` is THIS pass's size, so the
// step is one texel of the half-size target; Radius is in full-size px, hence the 0.5.
const blurGlsl = (input, dx, dy) => /* glsl */ `
vec4 fx(vec2 uv) {
  vec2 stepv = vec2(${dx}, ${dy}) / uResolution * max(P_radius * 0.5, 0.0) / 8.0;
  float taps = uQuality < 0.75 ? 4.0 : 8.0;
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = -8; i <= 8; i++) {
    if (abs(float(i)) > taps) continue;
    float t = float(i) / taps;
    float w = exp(-3.0 * t * t);
    acc += texture2D(${input}, uv + stepv * float(i) * (8.0 / taps)) * w;
    ws += w;
  }
  return acc / ws;
}`;

const blurNode = (input, dx, dy) => ({ tsl, uv, input: inputOf, param, resolution, quality }) => {
  const { vec2, vec4, float, int, exp, max, abs, select, If, Loop } = tsl;
  const taps = select(quality.lessThan(0.75), float(4.0), float(8.0)).toVar();
  const stepv = vec2(dx, dy).div(resolution).mul(max(param('radius').mul(0.5), 0.0).div(8.0)).toVar();
  const acc = vec4(0.0).toVar();
  const ws = float(0.0).toVar();
  Loop({ start: int(-8), end: int(9) }, ({ i }) => {
    const fi = float(i);
    If(abs(fi).lessThanEqual(taps), () => {
      const t = fi.div(taps);
      const w = exp(t.mul(t).mul(-3.0));
      acc.addAssign(inputOf(input).sample(uv.add(stepv.mul(fi).mul(float(8.0).div(taps)))).mul(w));
      ws.addAssign(w);
    });
  });
  return acc.div(ws);
};

// `inputs` name what a pass reads: 'source' (the effect's input), 'matte' (the layer's silhouette)
// or an earlier pass's key. GLSL reads them as B_<name>, TSL as input('<name>').sample(uv).
// The LAST pass is the output; the editor applies Mix to it.
export const passes = [
  {
    key: 'bright', inputs: ['source'], scale: 0.5,
    fragment: /* glsl */ `
vec4 fx(vec2 uv) {
  vec4 s = texture2D(B_source, uv);
  float l = luma(unpremult(s));
  float k = smoothstep(P_threshold, min(P_threshold + 0.2, 1.0), l) * s.a;
  return vec4(C_glow * k, k);
}`,
    fragmentNode: ({ tsl, uv, input, param, color }) => {
      const { vec3, vec4, dot, max, min, smoothstep } = tsl;
      const s = input('source').sample(uv);
      const l = dot(s.rgb.div(max(s.a, 0.0001)), vec3(0.2126, 0.7152, 0.0722));
      const k = smoothstep(param('threshold'), min(param('threshold').add(0.2), 1.0), l).mul(s.a);
      return vec4(color('glow').mul(k), k);
    },
  },
  { key: 'blurX', inputs: ['bright'], scale: 0.5, fragment: blurGlsl('B_bright', '1.0', '0.0'), fragmentNode: blurNode('bright', 1, 0) },
  { key: 'blurY', inputs: ['blurX'], scale: 0.5, fragment: blurGlsl('B_blurX', '0.0', '1.0'), fragmentNode: blurNode('blurX', 0, 1) },
  {
    key: 'composite', inputs: ['source', 'blurY'],
    fragment: /* glsl */ `
vec4 fx(vec2 uv) {
  vec4 s = texture2D(B_source, uv);
  vec4 g = texture2D(B_blurY, uv) * P_intensity;
  return vec4(s.rgb + g.rgb * (1.0 - s.a * 0.35), min(1.0, s.a + g.a));
}`,
    fragmentNode: ({ tsl, uv, input, param }) => {
      const { vec4, min } = tsl;
      const s = input('source').sample(uv);
      const g = input('blurY').sample(uv).mul(param('intensity'));
      return vec4(s.rgb.add(g.rgb.mul(s.a.mul(-0.35).add(1.0))), min(1.0, s.a.add(g.a)));
    },
  },
];

export default { id, name, renderer, description, animated, params, passes };
