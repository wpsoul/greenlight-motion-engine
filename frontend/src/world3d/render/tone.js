// The editor's AgX (threeDisplayTransformNodes.js), plus the contrast step Blender calls a Look. Our Cycles films use
// "AgX - Medium High Contrast"; plain AgX next to them reads flat and pale. Blender's looks are a contrast around grey in
// AgX's log space (1.2 Medium High, 1.4 High, 1.57 Very High), so highlights still roll off without hue shifts.
import { Fn, vec3, mat3, clamp, pow, max, min, log2, dot, uniform, float, select, mix, step, exp } from 'three/tsl';
import { veToSRGB } from '../../components/videoEditor/threeDisplayTransformNodes.js';

// Columns, as in the original: mat3 with nine numbers reads them in rows.
const SRGB_TO_REC2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
const REC2020_TO_SRGB = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const INSET = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
const OUTSET = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
const MIN_EV = -12.47393, MAX_EV = 4.026069;

const contrast = Fn(([x]) => {
  const x2 = x.mul(x), x4 = x2.mul(x2);
  return x4.mul(x2).mul(15.5).sub(x4.mul(x).mul(40.14)).add(x4.mul(31.96)).sub(x2.mul(x).mul(6.868)).add(x2.mul(0.4298)).add(x.mul(0.1191)).sub(0.00232);
});

export const lookContrast = uniform(1.25);
export const lookSaturation = uniform(1.3);
const PIVOT = 0.6061;                  // scene grey (0.18) in AgX's log encoding: contrast turns around it, as Blender's looks do

/** The curve with its Look as arguments. The editor films a model a world Scene let go of through it too (model3dNodes.js), with the
 *  Scene's numbers, so the model looks the same on both sides of the switch. */
export const filmCurve = Fn(([linearColor, exposure, contrastAmount, saturationAmount]) => {
  let c = INSET.mul(SRGB_TO_REC2020.mul(linearColor.mul(exposure).mul(1.35)));
  c = clamp(log2(max(c, vec3(1e-10))).sub(MIN_EV).div(MAX_EV - MIN_EV), 0, 1);
  c = clamp(c.sub(PIVOT).mul(contrastAmount).add(PIVOT), 0, 1);
  c = contrast(c);
  const luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = OUTSET.mul(luma.add(c.sub(luma).mul(saturationAmount)));
  c = pow(max(vec3(0), c), vec3(2.2));
  return veToSRGB(clamp(REC2020_TO_SRGB.mul(c), 0, 1));
});

export const filmTransform = Fn(([linearColor, exposure]) => filmCurve(linearColor, exposure, lookContrast, lookSaturation));

/** (vfx) Footage's own encoding, for objects put into a clip (`look.tone: "plate"`): the environment and the floor were read off the
 *  plate by undoing sRGB, so the picture goes back through sRGB alone. A grey the plate shows at 0.5 comes back at 0.5, and the sky in
 *  a chrome ball is as bright as the sky in the shot; AgX would roll both off. */
export const plateTransform = Fn(([linearColor, exposure]) => veToSRGB(clamp(linearColor.mul(exposure), 0, 1)));

/** (roomlook) The camera's white balance: `look.whiteBalance` in kelvin is the colour of the light the camera takes for white, as on a
 *  camera (Planckian locus, Kim et al. 2002; linear sRGB). 6500 changes nothing; a higher number warms the picture (a camera set for
 *  shade, in overcast daylight), a lower one cools it (set for tungsten). Gains for linear light, their luminance 1. */
export function whiteBalanceGains(kelvin) {
  const rgbOf = (t) => {
    const T = Math.min(Math.max(t, 1667), 25000), T2 = T * T, T3 = T2 * T;
    const x = T <= 4000 ? -0.2661239e9 / T3 - 0.2343589e6 / T2 + 0.8776956e3 / T + 0.17991 : -3.0258469e9 / T3 + 2.1070379e6 / T2 + 0.2226347e3 / T + 0.24039;
    const y = T <= 2222 ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
      : T <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
    const X = x / y, Z = (1 - x - y) / y;
    return [3.2406 * X - 1.5372 - 0.4986 * Z, -0.9689 * X + 1.8758 + 0.0415 * Z, 0.0557 * X - 0.204 + 1.057 * Z];
  };
  if (!(kelvin > 0)) return [1, 1, 1];
  const ref = rgbOf(6500), at = rgbOf(kelvin);
  const g = ref.map((v, i) => v / Math.max(at[i], 1e-6));
  const l = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
  return g.map((v) => v / l);
}

// ── (octane2) Other view transforms (`look.view`), beside AgX ──────────────────────────────────────────────────────────────────────
// Each takes the scene's linear light at the same exposure as AgX (× 1.35: `exposure` 1/1.35 is Blender's view at exposure 0 in every one)
// and gives display sRGB. Blender 5.1 ships the same three views ("ACES 1.3", "Khronos PBR Neutral", "Standard"), which is the reference
// (tests/world3d-lab/octane2/views.py).
export const VIEWS = ['agx', 'aces', 'neutral', 'standard'];

// The nodes are made on first use, never when the module loads: a node made at import takes an id, and every node after it (the tracer's
// buffers among them) would be named one further on in every scene's WGSL, used or not.
const lazy = (make) => { let f = null; return (...args) => (f ??= make())(...args); };

// ACES 1.3's RRT + sRGB ODT as Stephen Hill fitted it (BakingLab, MIT): linear Rec.709 into the RRT's space, the fitted curve, back out.
export const acesTransform = lazy(() => {
  const inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  return Fn(([linearColor, exposure]) => {
    const v = inM.mul(linearColor.mul(exposure).mul(1.35));
    const fit = v.mul(v.add(0.0245786)).sub(0.000090537).div(v.mul(v.mul(0.983729).add(0.4329510)).add(0.238081));
    return veToSRGB(clamp(outM.mul(fit), 0, 1));
  });
});

/** Khronos PBR Neutral (Apache 2.0 reference): colours stay as authored up to 0.76, then only the brightest are compressed and lose
 *  saturation toward white. For product shots whose colours must read true. */
export const neutralTransform = lazy(() => Fn(([linearColor, exposure]) => {
  const c0 = linearColor.mul(exposure).mul(1.35);
  const x = min(c0.x, min(c0.y, c0.z));
  const offset = select(x.lessThan(0.08), x.sub(x.mul(x).mul(6.25)), float(0.04));
  const c = c0.sub(offset);
  const peak = max(c.x, max(c.y, c.z));
  const start = 0.8 - 0.04, d = 1 - start;
  const newPeak = float(1).sub(float(d * d).div(peak.add(d - start)));
  const g = float(1).sub(float(1).div(peak.sub(newPeak).mul(0.15).add(1)));
  const compressed = mix(c.mul(newPeak.div(max(peak, float(1e-6)))), vec3(newPeak), g);
  return veToSRGB(clamp(select(peak.lessThan(start), c, compressed), 0, 1));
}));

/** Standard: sRGB alone, clipped (as `look.tone: "plate"`, at the views' exposure). */
export const standardTransform = lazy(() => Fn(([linearColor, exposure]) => veToSRGB(clamp(linearColor.mul(exposure).mul(1.35), 0, 1))));

/** (octane2) An albedo pass as a picture: its linear colours sRGB-encoded, so they read as the colours they are. */
export const albedoDisplay = lazy(() => Fn(([c]) => veToSRGB(clamp(c, 0, 1))));

/** The film for a view name: AgX (with the look's contrast and saturation) unless the view is one of the others. */
export const viewTransformOf = (view) => (view === 'aces' ? acesTransform : view === 'neutral' ? neutralTransform : view === 'standard' ? standardTransform : filmTransform);

// The same curves in plain JS (tests, and the references' check): linear sRGB in, display sRGB (0-1) out.
const srgbOetf = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const mulRows = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
export function viewJS(view, rgb, exposure = 1) {
  const c0 = rgb.map((v) => v * exposure * 1.35);
  let out;
  if (view === 'aces') {
    const v = mulRows([[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]], c0);
    const fit = v.map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081));
    out = mulRows([[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]], fit);
  } else if (view === 'neutral') {
    const x = Math.min(...c0);
    const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    const c = c0.map((v) => v - offset);
    const peak = Math.max(...c), start = 0.76, d = 0.24;
    if (peak < start) out = c;
    else {
      const newPeak = 1 - (d * d) / (peak + d - start);
      const g = 1 - 1 / (0.15 * (peak - newPeak) + 1);
      out = c.map((v) => (v * newPeak) / peak * (1 - g) + newPeak * g);
    }
  } else out = c0;
  return out.map((v) => srgbOetf(Math.min(1, Math.max(0, v))));
}

// ── (hdrscene) The HDR view: the SDR view's own picture, with the light above diffuse white given room up to 1000 cd/m² ──────────────────
// An HDR render of a Scene alone (the editor's exporter, components/videoEditor/hdrScene.js) films the scene's light twice: through its view
// as always (the SDR picture: Draft and Final pictures, and every SDR file, are untouched), and through this one into a float target. Display
// light is counted in SDR whites: 1 is the SDR picture's white, placed at 203 cd/m² as ITU-R BT.2408 places graphics white.
//   Below the knee the HDR view IS the SDR view: a pixel whose every channel of scene light is at most the knee's has exactly the SDR picture's
// light, so mid-tones, skin and diffuse white sit where the SDR file has them. The knee is diffuse white (scene light 1 at the film's exposure),
// or lower where a view already shows diffuse white brighter than 0.8 of SDR white (Standard's clip, Neutral's top): it is taken where the
// view still has room.
//   Above it the light goes on rising at the rate the view had at the knee (its slope there, in display light per unit of scene light: the
// curve and its first derivative are continuous, so no edge shows), up to 500 cd/m², then rolls off exponentially into the 1000 cd/m² peak,
// which it meets only in the limit. Derived from the scene's own look: the knee's height and slope are the view's own (AgX with the look's
// contrast, ACES, Neutral, Standard, footage's plate), so the SDR and HDR files of one scene read as one grade.
//   A pixel's colour above the knee is the SDR picture's colour (its view's hue and its LUT), its light raised by the ratio of the HDR curve to
// the SDR curve at the pixel's brightest channel of scene light; a colour whose brightest channel would pass the peak is scaled down as a
// whole (its hue kept).
export const HDR_WHITE_NITS = 203;
export const HDR_PEAK = 1000 / HDR_WHITE_NITS;
export const HDR_ROLL = HDR_PEAK / 2;
export const HDR_KNEE_LIGHT = 1;
export const HDR_KNEE_MAX = 0.8;

const mulCols = (cols, v) => [0, 1, 2].map((i) => cols[0][i] * v[0] + cols[1][i] * v[1] + cols[2][i] * v[2]);
const JS_SRGB_TO_REC2020 = [[0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.0880], [0.0433, 0.0113, 0.8956]];
const JS_REC2020_TO_SRGB = [[1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]];
const JS_INSET = [[0.856627153315983, 0.137318972929847, 0.11189821299995], [0.0951212405381588, 0.761241990602591, 0.0767994186031903], [0.0482516061458583, 0.101439036467562, 0.811302368396859]];
const JS_OUTSET = [[1.1271005818144368, -0.1413297634984383, -0.14132976349843826], [-0.11060664309660323, 1.157823702216272, -0.11060664309660294], [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405]];
const polyJS = (x) => 15.5 * x ** 6 - 40.14 * x ** 5 + 31.96 * x ** 4 - 6.868 * x ** 3 + 0.4298 * x ** 2 + 0.1191 * x - 0.00232;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** filmCurve in plain JS: linear sRGB in, display light (linear, 0-1) out. */
export function agxJS(rgb, exposure = 1, contrast = 1.25, saturation = 1.3) {
  let c = mulCols(JS_INSET, mulCols(JS_SRGB_TO_REC2020, rgb.map((v) => v * exposure * 1.35)));
  c = c.map((v) => clamp01((Math.log2(Math.max(v, 1e-10)) - MIN_EV) / (MAX_EV - MIN_EV)));
  c = c.map((v) => polyJS(clamp01((v - PIVOT) * contrast + PIVOT)));
  const luma = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  c = mulCols(JS_OUTSET, c.map((v) => luma + (v - luma) * saturation)).map((v) => Math.max(0, v) ** 2.2);
  return mulCols(JS_REC2020_TO_SRGB, c).map(clamp01);
}

const srgbEotfJS = (e) => (e <= 0.04045 ? e / 12.92 : ((e + 0.055) / 1.055) ** 2.4);

/** The SDR view's display light (linear, 1 = SDR white) for grey scene light `v` (the film's exposure in it): the curve the HDR one comes from.
 *  `view`: 'agx' (or null), 'aces', 'neutral', 'standard', 'plate'. */
export function greyJS(view, v, { contrast = 1.25 } = {}) {
  if (view === 'plate') return clamp01(v);
  if (!view || view === 'agx') return agxJS([v, v, v], 1, contrast)[1];
  return srgbEotfJS(viewJS(view, [v, v, v])[1]);
}

/** The knee of the HDR view for a view and look: scene light `vk` (the film's exposure in it), its display light `k`, and the view's slope
 *  there (display light per unit of scene light), which the HDR view keeps above it. */
export function hdrKnee(view, look = {}) {
  const g = (v) => greyJS(view, v, look);
  let vk = HDR_KNEE_LIGHT;
  if (g(vk) > HDR_KNEE_MAX) {
    let lo = 1e-4, hi = vk;
    for (let i = 0; i < 60; i += 1) { const mid = Math.sqrt(lo * hi); if (g(mid) > HDR_KNEE_MAX) hi = mid; else lo = mid; }
    vk = lo;
  }
  const d = vk * 1e-3;
  return { vk, k: g(vk), slope: Math.max(1e-3, (g(vk + d) - g(vk - d)) / (2 * d)) };
}

/** The roll-off into the peak: straight up to HDR_ROLL, then exponential, continuous with its slope, meeting HDR_PEAK in the limit. */
export const hdrRollJS = (z) => (z <= HDR_ROLL ? z : HDR_ROLL + (HDR_PEAK - HDR_ROLL) * (1 - Math.exp(-(z - HDR_ROLL) / (HDR_PEAK - HDR_ROLL))));

/** The HDR view's display light (SDR whites) for grey scene light `v`: the prediction a render's patches are checked against. */
export function hdrGreyJS(view, v, look = {}) {
  const kn = hdrKnee(view, look);
  return v <= kn.vk ? greyJS(view, v, look) : hdrRollJS(kn.k + kn.slope * (v - kn.vk));
}

/** sRGB-encoded display values back to display light (the IEC 61966-2-1 curve the backend's encode uses). */
export const srgbToLinear = lazy(() => Fn(([c]) => mix(c.div(12.92), pow(max(c, vec3(0)).add(0.055).div(1.055), vec3(2.4)), step(0.04045, c)))
  .setLayout({ name: 'glSrgbToLinear', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }] }));

/** (screensharp2) Display light laid over a filmed picture: `toned` display sRGB (0-1), `light` linear display light (a live screen's page
 *  in its own colours, screenLayer.js); display sRGB back. */
export const addDisplayLight = lazy(() => Fn(([toned, light]) => veToSRGB(clamp(srgbToLinear(clamp(toned, 0, 1)).add(light), 0, 1))));

/** The HDR view's gain over the SDR picture at a pixel: `m` its brightest channel of scene light before the exposure, `film` the SDR view
 *  (linear colour, exposure) -> display sRGB, `u` the knee's uniforms { vk, k, slope }. 1 at and below the knee. */
export function hdrGain(m, exposure, film, u) {
  const v = m.mul(exposure);
  const g = srgbToLinear(film(vec3(m), exposure)).y;
  const z = u.k.add(u.slope.mul(v.sub(u.vk)));
  const rolled = float(HDR_ROLL).add(float(HDR_PEAK - HDR_ROLL).mul(float(1).sub(exp(z.sub(HDR_ROLL).div(HDR_PEAK - HDR_ROLL).negate()))));
  const h = select(z.lessThan(HDR_ROLL), z, rolled);
  return select(v.greaterThan(u.vk), h.div(max(g, float(1e-4))), float(1));
}
