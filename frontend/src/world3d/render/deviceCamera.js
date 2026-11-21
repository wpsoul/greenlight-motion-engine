// (physcam) The Scene camera as a physical device: an auto-exposure that meters the picture and lags behind it, sensor noise that grows
// with the camera's gain and in the dark, and device presets that set a group of camera and look fields at once. Plain JS (no three):
// the world draws the meter's small views of the set (WorldRenderer.meterView), the editor's bridge runs the filter below on the Scene's
// own clock (world3dLayer.js), and the tone pass takes the gain and the noise (WorldRenderer #buildTone). Tested in deviceCamera.test.mjs.
//
// Determinism: the exposure at a time is a pure function of the meter's samples on a fixed grid of the Scene's clock (AE_STEP apart, from
// the clip's start) over a window of five lags before it, started settled. A frame rendered alone measures the samples before it (a
// metering pre-pass); a frame inside a render reuses the ones its neighbours measured: the same numbers, so the same picture.

/** The meter's clock: a sample every AE_STEP seconds of the Scene's clock (a camera's exposure loop runs at 15–30 Hz). */
export const AE_STEP = 1 / 20;
/** The meter's view, at the frame's aspect: this many pixels along its longer side. */
export const METER_SIDE = 64;
/** The meter's histogram: log2 of scene luminance from HIST_LO to HIST_HI in HIST_BINS bins (a quarter stop each). */
export const HIST_LO = -24;
export const HIST_HI = 16;
export const HIST_BINS = 160;
const BIN = (HIST_HI - HIST_LO) / HIST_BINS;
const LN2 = Math.LN2;

/** The scene camera's fields that only change the picture's numbers (the device, its exposure, its noise, its distortion): an edit of one
 *  is taken in place (WorldRenderer.setCameraFilm), never a rebuild of the world. */
export const CAMERA_FILM_FIELDS = Object.freeze(['device', 'autoExposure', 'noise', 'exposureCompensation', 'distortion', 'iso', 'shutter', 'projection']);

/** The camera's picture-only fields, and the camera without them (the part a change of which builds the world again). */
export function splitCameraFilm(cam) {
  if (!cam || typeof cam !== 'object') return { film: null, rest: cam };
  const film = {}, rest = { ...cam };
  for (const k of CAMERA_FILM_FIELDS) if (k in rest) { film[k] = rest[k]; delete rest[k]; }
  return { film, rest };
}

/** Auto-exposure as it is when only `autoExposure: true` is written. */
export const AE_DEFAULTS = Object.freeze({ lag: 0.5, strength: 0.85, min: -3, max: 3, metering: 'center', key: 0.18 });
/** How much faster a camera stops down (into the bright) than it opens up (into the dark): a blown frame is worse than a dark one. */
export const AE_BRIGHT_SPEED = 2;
/** The sensor's white point over the metered grey, in stops: what is brighter than this counts as this bright (it clips on the sensor). */
export const AE_CLIP_STOPS = 2.5;

/** Device presets: the camera's fields (`camera.device`) and the look's (merged under `rig.look`) that the device gives a Scene, every one
 *  of them overridden by a field the scene writes itself. The action camera's lens is a stereographic fisheye (its `fov` the vertical view:
 *  72 gives the 116° across a 16:9 action camera has). */
export const DEVICES = Object.freeze({
  actionCam: {
    camera: { autoExposure: { lag: 0.6, strength: 0.8, min: -3, max: 4, metering: 'average' }, noise: 1, projection: 'stereographic' },
    look: { aberration: 0.45, vignette: 0.28, bloom: 0.06, bloomThreshold: 1.2 },
  },
  phone: {
    camera: { autoExposure: { lag: 0.35, strength: 0.9, min: -3, max: 5, metering: 'center' }, noise: 0.5, distortion: 0.03 },
    look: { aberration: 0.12, vignette: 0.1, bloom: 0.05, localTone: 0.35 },
  },
  cinema: {
    camera: { noise: 0.25 },
    look: { halation: 0.05, vignette: 0.15, bloom: 0.06 },
  },
});
export const DEVICE_IDS = Object.keys(DEVICES);

const num = (v, d, lo = -Infinity, hi = Infinity) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, Number(v))) : d);

/** The camera with its device's fields under its own (a scene's own field always wins; `autoExposure: true` takes the device's settings,
 *  an object is merged over them). The camera itself when it names no known device. */
export function withDevice(cam) {
  const dev = cam && DEVICES[cam.device];
  if (!dev) return cam;
  const own = cam.autoExposure;
  const ae = dev.camera.autoExposure;
  const autoExposure = own === undefined || own === true ? ae : own && typeof own === 'object' ? { ...(ae || {}), ...own } : own;
  return { ...dev.camera, ...cam, ...(autoExposure !== undefined ? { autoExposure } : {}) };
}

/** The look a device gives (merged under the scene's own look: a field the look writes, 0 included, wins). Null for none. */
export function deviceLook(device) {
  return DEVICES[device]?.look || null;
}

/** The look as the world films it: the device's under the scene's own. */
export function lookWithDevice(look, device) {
  const dev = deviceLook(device);
  return dev ? { ...dev, ...(look || {}) } : look;
}

/** The auto-exposure the camera asks for, every number in range, or null when it has none. */
export function aeSpec(cam) {
  const c = withDevice(cam);
  const v = c?.autoExposure;
  if (!v) return null;
  const o = v === true ? {} : typeof v === 'object' ? v : typeof v === 'number' && v > 0 ? { strength: v } : null;
  if (!o) return null;
  const lag = num(o.lag, AE_DEFAULTS.lag, 0.02, 10);
  const min = num(o.min, AE_DEFAULTS.min, -10, 0), max = num(o.max, AE_DEFAULTS.max, 0, 10);
  return {
    lag,
    lagBright: lag / AE_BRIGHT_SPEED,
    strength: num(o.strength, AE_DEFAULTS.strength, 0, 1),
    min, max,
    metering: ['center', 'average', 'spot'].includes(o.metering) ? o.metering : AE_DEFAULTS.metering,
    key: num(o.key, AE_DEFAULTS.key, 0.01, 1),
  };
}

/** The sensor noise the camera asks for (0 none). */
export function noiseAmount(cam) {
  const c = withDevice(cam);
  return num(c?.noise, 0, 0, 4);
}

/** The meter's view size at a frame's aspect. */
export function meterSize(aspect) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  return a >= 1 ? [METER_SIDE, Math.max(4, Math.round(METER_SIDE / a))] : [Math.max(4, Math.round(METER_SIDE * a)), METER_SIDE];
}

/** How much each meter pixel counts: `center` a centre-weighted average (a Gaussian a third of the half diagonal wide, on an even floor),
 *  `average` all alike, `spot` the middle tenth. */
export function meterWeight(metering, x, y) {
  if (metering === 'average') return 1;
  const r2 = x * x + y * y;          // x, y over the half diagonal: 1 at a corner
  if (metering === 'spot') return Math.exp(-r2 / (2 * 0.1 * 0.1));
  return 0.25 + Math.exp(-r2 / (2 * 0.33 * 0.33));
}

/** The meter's histogram of one view: `rgb(i)` the scene light of pixel i (linear, before any exposure), `w` x `h` pixels. Each bin holds
 *  the weight of the pixels whose luminance falls in it (log2 from HIST_LO, a quarter stop a bin). */
export function meterHistogram(rgb, w, h, metering = 'center') {
  const bins = new Float64Array(HIST_BINS);
  const diag = Math.hypot(w, h) / 2;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const [r, g, b] = rgb(i);
      let L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (!(L > 0)) L = 0;
      const l2 = L > 0 ? Math.log(L) / LN2 : HIST_LO;
      const k = Math.min(HIST_BINS - 1, Math.max(0, Math.floor((l2 - HIST_LO) / BIN)));
      bins[k] += meterWeight(metering, (x + 0.5 - w / 2) / diag, (y + 0.5 - h / 2) / diag);
    }
  }
  return bins;
}

/** The histogram of a read-back view: RGBA floats, `w` x `h`. */
export function meterHistogramRgba(px, w, h, metering = 'center') {
  return meterHistogram((i) => [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]], w, h, metering);
}

/** The metered scene brightness (log2) of a histogram for a camera exposed at `gainLog2` (log2 of everything that multiplies the light
 *  before the sensor): the weighted mean of log2 luminance, what lies past the sensor's white point counted at it, given back in the
 *  scene's light (the exposure taken off again). */
export function meteredLog2(bins, gainLog2, clipLog2) {
  let sum = 0, wsum = 0;
  for (let k = 0; k < HIST_BINS; k += 1) {
    const w = bins[k];
    if (!(w > 0)) continue;
    const c = HIST_LO + (k + 0.5) * BIN;
    sum += w * Math.min(c + gainLog2, clipLog2);
    wsum += w;
  }
  return wsum > 0 ? sum / wsum - gainLog2 : HIST_LO;
}

/** The exposure (log2, the auto-exposure's own share) the camera wants for one sample: `base` the log2 of what exposes the picture
 *  without it (the Rig's exposure, the camera's iso / shutter / fStop), `e` the exposure it is at now (what clips on the sensor depends on
 *  it). Partial: `strength` of the way to the key, so dark places stay a little dark and bright ones a little bright. */
export function aeTarget(bins, base, e, spec) {
  const key = Math.log(spec.key) / LN2;
  const m = meteredLog2(bins, base + e, key + AE_CLIP_STOPS) + base;
  return Math.min(spec.max, Math.max(spec.min, spec.strength * (key - m)));
}

/** The grid times (Scene clock, seconds) the exposure at Scene time `s` needs measured: from five lags before it (never before the clip's
 *  start, 0) to the first sample after it. { k0, k1, times }: times[i] is (k0 + i) * AE_STEP. */
export function aeGrid(s, spec) {
  const t = Math.max(0, Number(s) || 0);
  const k1 = Math.floor(t / AE_STEP + 1e-9);
  const window = Math.ceil((5 * Math.max(spec.lag, spec.lagBright)) / AE_STEP);
  const k0 = Math.max(0, k1 - window);
  const times = [];
  for (let k = k0; k <= k1 + 1; k += 1) times.push(+(k * AE_STEP).toFixed(6));
  return { k0, k1, times };
}

/** The auto-exposure's share of the exposure (log2) at Scene time `s`, from the samples on its grid (`sample(k)` → { bins, base } for grid
 *  step k, or null when it is not measured: then null). Started settled on the window's first sample, then each step moves toward its
 *  target by 1 − e^(−step/lag) (lag / AE_BRIGHT_SPEED when the target is darker), and `s` itself lies between two steps. `trace`, when
 *  given, gets every step's { t, target, e }. */
export function aeAt(s, spec, sample, trace = null) {
  const { k0, k1 } = aeGrid(s, spec);
  const first = sample(k0);
  if (!first) return null;
  let e = 0;
  for (let i = 0; i < 4; i += 1) e = aeTarget(first.bins, first.base, e, spec);
  if (trace) trace.push({ t: k0 * AE_STEP, target: e, e });
  const up = 1 - Math.exp(-AE_STEP / spec.lag), down = 1 - Math.exp(-AE_STEP / spec.lagBright);
  let eK1 = e;
  for (let k = k0 + 1; k <= k1 + 1; k += 1) {
    const sm = sample(k);
    if (!sm) return null;
    const target = aeTarget(sm.bins, sm.base, e, spec);
    e += (target - e) * (target > e ? up : down);
    if (trace) trace.push({ t: k * AE_STEP, target, e });
    if (k === k1) eK1 = e;
  }
  const u = Math.min(1, Math.max(0, Math.max(0, Number(s) || 0) / AE_STEP - k1));
  return eK1 + (e - eK1) * u;
}

/** The sensor's gain over its base (ISO 100, no auto-exposure gain): what scales its noise. The camera's ISO and the auto-exposure's gain
 *  (taken as ISO: a camera that cannot open its shutter further turns its gain up); never under a sixteenth. */
export function sensorGain(iso, aeLog2 = 0) {
  const isoGain = Number(iso) > 0 ? Number(iso) / 100 : 1;
  return Math.max(1 / 16, isoGain * 2 ** (Number(aeLog2) || 0));
}

/** The sensor's noise, as the tone pass adds it to the exposed light V (linear, before the film curve): σ² = gain·V·SHOT + (gain·READ)²,
 *  both times `amount`². Photon (shot) noise grows with the square root of the light and of the gain; read noise with the gain alone, so the
 *  shadows and a camera that gains up get grainier. At amount 1, base gain, mid grey (0.18): 3.5 % of the light (a small sensor at its
 *  base ISO); four stops of gain make it four times that. */
export const NOISE_SHOT = (0.035 ** 2) * 0.18;
export const NOISE_READ = 0.0012;
export function noiseSigma(V, gain, amount) {
  const a = Math.max(0, amount);
  return a * Math.sqrt(Math.max(0, gain * Math.max(0, V) * NOISE_SHOT + (gain * NOISE_READ) ** 2));
}
