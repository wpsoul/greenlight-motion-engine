/*
 * Color Correction — a Lumetri-style per-layer fix: White Balance → Tone → Levels → Color →
 * Shadows/Midtones/Highlights wheels → HSL, in one per-pixel stage.
 *
 * Ported verbatim from the verdicted lab `html/color-correction-lab.html` (2026-10-02); the
 * lab's probe `tests/layer-effect-labs/probe_color_correction.js` holds the maths gates.
 *
 * Stored as `item.colorCorrection` (absent = nothing to do, zero cost). Every section carries
 * its own `on` flag; a section at its defaults is skipped, and the whole stage is a bypass when
 * no section is live, the card is muted, or Mix is 0.
 *
 * This module is pure: the parameter model, the sanitizer, the uniform values, the JS twins
 * of the shader (the Auto functions and the pickers solve through them), and the scope
 * renderers. The GLSL / TSL bodies live next to the clip material that runs them.
 */

export const CC_HSL_BANDS = [
  { name: 'Red', hue: 0 }, { name: 'Orange', hue: 30 }, { name: 'Yellow', hue: 60 }, { name: 'Green', hue: 120 },
  { name: 'Aqua', hue: 180 }, { name: 'Blue', hue: 240 }, { name: 'Purple', hue: 270 }, { name: 'Magenta', hue: 300 },
];
export const CC_SECTIONS = ['wb', 'tone', 'levels', 'color', 'wheels', 'hsl'];
export const CC_LEVEL_CHANNELS = ['rgb', 'r', 'g', 'b'];

export const ccLevelsDefault = () => ({ inB: 0, inW: 255, gamma: 1, outB: 0, outW: 255 });
const zeros8 = () => [0, 0, 0, 0, 0, 0, 0, 0];
export const ccDefault = () => ({
  enabled: true,
  mix: 100,
  wb: { on: true, temp: 0, tint: 0 },
  tone: { on: true, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 },
  levels: { on: true, rgb: ccLevelsDefault(), r: ccLevelsDefault(), g: ccLevelsDefault(), b: ccLevelsDefault() },
  color: { on: true, saturation: 100, vibrance: 0 },
  wheels: { on: true, shadows: { x: 0, y: 0, l: 0 }, midtones: { x: 0, y: 0, l: 0 }, highlights: { x: 0, y: 0, l: 0 } },
  hsl: { on: true, hue: zeros8(), sat: zeros8(), lum: zeros8() },
});
export const ccSectionDefault = (sec) => ccDefault()[sec];

import { CC_KF_PREFIX } from './keyframeProps.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

/** Whitelist + clamp a stored `colorCorrection` object. Anything else → null (dropped). */
export function sanitizeColorCorrection(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = ccDefault();
  const s = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
  const wb = s(raw.wb), tone = s(raw.tone), lv = s(raw.levels), col = s(raw.color), wh = s(raw.wheels), hsl = s(raw.hsl);
  const level = (o) => {
    o = s(o);
    const inB = Math.round(num(o.inB, 0, 0, 253));
    const inW = Math.round(num(o.inW, 255, inB + 2, 255));
    return { inB, inW, gamma: num(o.gamma, 1, 0.1, 9.99), outB: Math.round(num(o.outB, 0, 0, 255)), outW: Math.round(num(o.outW, 255, 0, 255)) };
  };
  const wheel = (o) => {
    o = s(o);
    let x = num(o.x, 0, -1, 1), y = num(o.y, 0, -1, 1);
    const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
    return { x, y, l: num(o.l, 0, -100, 100) };
  };
  const arr8 = (a) => (Array.isArray(a) ? Array.from({ length: 8 }, (_, i) => num(a[i], 0, -100, 100)) : zeros8());
  return {
    enabled: bool(raw.enabled, true),
    mix: num(raw.mix, d.mix, 0, 100),
    wb: { on: bool(wb.on, true), temp: num(wb.temp, 0, -100, 100), tint: num(wb.tint, 0, -100, 100) },
    tone: {
      on: bool(tone.on, true),
      exposure: num(tone.exposure, 0, -4, 4),
      contrast: num(tone.contrast, 0, -100, 100),
      highlights: num(tone.highlights, 0, -100, 100),
      shadows: num(tone.shadows, 0, -100, 100),
      whites: num(tone.whites, 0, -100, 100),
      blacks: num(tone.blacks, 0, -100, 100),
    },
    levels: { on: bool(lv.on, true), rgb: level(lv.rgb), r: level(lv.r), g: level(lv.g), b: level(lv.b) },
    color: { on: bool(col.on, true), saturation: num(col.saturation, 100, 0, 200), vibrance: num(col.vibrance, 0, -100, 100) },
    wheels: { on: bool(wh.on, true), shadows: wheel(wh.shadows), midtones: wheel(wh.midtones), highlights: wheel(wh.highlights) },
    hsl: { on: bool(hsl.on, true), hue: arr8(hsl.hue), sat: arr8(hsl.sat), lum: arr8(hsl.lum) },
  };
}

// ─── liveness: a section at defaults (or switched off) costs nothing ───
const stripOn = (o) => { const c = { ...o }; delete c.on; return JSON.stringify(c); };
const DEFAULT_SECTION_JSON = Object.fromEntries(CC_SECTIONS.map((k) => [k, stripOn(ccDefault()[k])]));
export function ccSectionIsDefault(cc, sec) { return !cc || !cc[sec] || stripOn(cc[sec]) === DEFAULT_SECTION_JSON[sec]; }
export function ccSectionLive(cc, sec) { return !!cc && !!cc[sec] && cc[sec].on !== false && !ccSectionIsDefault(cc, sec); }
/** True when the stage must run at all for this item. */
export function ccIsLive(cc) {
  if (!cc || cc.enabled === false || !(cc.mix > 0)) return false;
  return CC_SECTIONS.some((k) => ccSectionLive(cc, k));
}
/** Off-default anywhere (drives the section header's state dot). */
export function ccIsModified(cc) {
  if (!cc) return false;
  return cc.mix !== 100 || CC_SECTIONS.some((k) => !ccSectionIsDefault(cc, k));
}

/* ══════════════════════════════════════════════════════════════════════════
   Keyframes — every number is animatable as a `cc:<path>` track
   ══════════════════════════════════════════════════════════════════════════ */
const LV_PARTS = [
  ['inB', 'Input black', 0, 253, 1], ['gamma', 'Gamma', 0.1, 9.99, 0.01], ['inW', 'Input white', 2, 255, 1],
  ['outB', 'Output black', 0, 255, 1], ['outW', 'Output white', 0, 255, 1],
];
const LV_CH_NAMES = { rgb: 'RGB', r: 'Red', g: 'Green', b: 'Blue' };
const WHEEL_NAMES = { shadows: 'Shadows', midtones: 'Midtones', highlights: 'Highlights' };
const HSL_PROP_NAMES = { hue: 'Hue', sat: 'Saturation', lum: 'Luminance' };
const pm100 = { min: -100, max: 100, step: 1 };
/** The animatable numbers, in panel order. `path` addresses the value inside `colorCorrection`. */
export const CC_KF_FIELDS = [
  { path: 'mix', label: 'Mix', min: 0, max: 100, step: 1, unit: '%' },
  { path: 'wb.temp', label: 'Temperature', ...pm100 },
  { path: 'wb.tint', label: 'Tint', ...pm100 },
  { path: 'tone.exposure', label: 'Exposure', min: -4, max: 4, step: 0.01 },
  { path: 'tone.contrast', label: 'Contrast', ...pm100 },
  { path: 'tone.highlights', label: 'Highlights', ...pm100 },
  { path: 'tone.shadows', label: 'Shadows', ...pm100 },
  { path: 'tone.whites', label: 'Whites', ...pm100 },
  { path: 'tone.blacks', label: 'Blacks', ...pm100 },
  ...CC_LEVEL_CHANNELS.flatMap((ch) => LV_PARTS.map(([k, label, min, max, step]) => (
    { path: `levels.${ch}.${k}`, label: `Levels ${LV_CH_NAMES[ch]} · ${label}`, min, max, step }))),
  { path: 'color.saturation', label: 'Saturation', min: 0, max: 200, step: 1 },
  { path: 'color.vibrance', label: 'Vibrance', ...pm100 },
  ...Object.entries(WHEEL_NAMES).flatMap(([w, name]) => [
    { path: `wheels.${w}.x`, label: `${name} wheel · X`, min: -1, max: 1, step: 0.01 },
    { path: `wheels.${w}.y`, label: `${name} wheel · Y`, min: -1, max: 1, step: 0.01 },
    { path: `wheels.${w}.l`, label: `${name} wheel · Luminance`, ...pm100 },
  ]),
  ...Object.entries(HSL_PROP_NAMES).flatMap(([prop, name]) => CC_HSL_BANDS.map((band, i) => (
    { path: `hsl.${prop}.${i}`, label: `HSL ${band.name} · ${name}`, ...pm100 }))),
];
const CC_KF_BY_PATH = new Map(CC_KF_FIELDS.map((f) => [f.path, f]));
export const CC_KF_GROUP = 'Color Correction';
export const ccKfKey = (path) => `${CC_KF_PREFIX}${path}`;
export function parseCcKfKey(key) {
  if (typeof key !== 'string' || !key.startsWith(CC_KF_PREFIX)) return null;
  const path = key.slice(CC_KF_PREFIX.length);
  return CC_KF_BY_PATH.has(path) ? path : null;
}
export const ccKfFieldMeta = (path) => CC_KF_BY_PATH.get(path) || null;
export function ccGetPath(cc, path) {
  let o = cc || ccDefault();
  for (const part of path.split('.')) o = o == null ? undefined : o[part];
  return o;
}
/** Immutable set along `path` (copies every object / array on the way down). */
export function ccSetPath(cc, path, value) {
  const parts = path.split('.');
  const root = Array.isArray(cc) ? cc.slice() : { ...(cc || ccDefault()) };
  let o = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = o[parts[i]];
    o[parts[i]] = Array.isArray(next) ? next.slice() : { ...(next || {}) };
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
  return root;
}
/** Keyframe Builder entries (the `extraKfProps` shape): every animatable number, seeded
 *  with the item's current static value so adding a track never changes the frame. */
export function buildCcKfProps(item) {
  const cc = item?.colorCorrection || ccDefault();
  return CC_KF_FIELDS.map((f) => ({
    label: ccKfKey(f.path),
    group: CC_KF_GROUP,
    displayLabel: f.label,
    placeholder: String(ccGetPath(cc, f.path)),
    unit: f.unit || '',
    type: 'number',
    min: f.min,
    max: f.max,
    step: f.step ?? 1,
  }));
}
/** Does this keyframe map hold any Color Correction track? (cached per map object) */
const ccTrackCache = new WeakMap();
export function hasCcTracks(propertyKeyframes) {
  if (!propertyKeyframes || typeof propertyKeyframes !== 'object') return false;
  let v = ccTrackCache.get(propertyKeyframes);
  if (v === undefined) {
    v = Object.keys(propertyKeyframes).some((k) => parseCcKfKey(k) && propertyKeyframes[k]?.length);
    ccTrackCache.set(propertyKeyframes, v);
  }
  return v;
}
/**
 * Merge one frame's resolved `cc:` values over the static correction. Returns the
 * SAME object when there is nothing to merge (the uniform cache is keyed on identity,
 * so an un-animated layer must not get a fresh object every frame).
 */
export function applyCcKeyframes(cc, kfValues) {
  if (!kfValues) return cc;
  let out = null;
  for (const key in kfValues) {
    if (key.length < 4 || key.charCodeAt(0) !== 99 || key.charCodeAt(2) !== 58) continue;   // 'c?:' fast reject
    const path = parseCcKfKey(key);
    if (!path) continue;
    const v = Number(kfValues[key]);
    if (!Number.isFinite(v)) continue;
    const meta = CC_KF_BY_PATH.get(path);
    out = ccSetPath(out || cc || ccDefault(), path, clamp(v, meta.min, meta.max));
  }
  return out ? sanitizeColorCorrection(out) : cc;
}

/* ══════════════════════════════════════════════════════════════════════════
   Colour maths — the JS twins of the shader
   ══════════════════════════════════════════════════════════════════════════ */
export const LUMA709 = [0.2126, 0.7152, 0.0722];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const s2l = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
export const l2s = (v) => (v <= 0.0031308 ? Math.max(0, v) * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) S2L[i] = s2l(i / 255);

// White balance = luminance-normalised gains in linear light along two zero-sum log axes
// (temperature ≈ the Planckian locus around 6500 K, tint = green ↔ magenta), so any
// neutralising gain triple maps back to exactly one (temp, tint). Sliders are eased.
const TDIR = [0.52, 0.11, -0.63], NDIR = [0.5, -1.0, 0.5], KT = 3.0, KN = 1.6;
const wbEase = (x) => x * (0.5 + 0.5 * Math.abs(x));
const wbEaseInv = (e) => Math.sign(e) * (-0.5 + Math.sqrt(0.25 + 2 * Math.abs(e)));
export function ccWbGains(temp, tint) {
  const t = wbEase(temp / 100) * KT, n = wbEase(tint / 100) * KN;
  const g = [0, 1, 2].map((i) => Math.pow(2, t * TDIR[i] + n * NDIR[i]));
  const y = dot3(g, LUMA709);
  return g.map((v) => v / y);
}
export function ccGainsToTempTint(g) {
  const L = g.map((v) => Math.log2(Math.max(v, 1e-6)));
  const m = (L[0] + L[1] + L[2]) / 3, l = L.map((v) => v - m);
  const TT = dot3(TDIR, TDIR), NN = dot3(NDIR, NDIR), TN = dot3(TDIR, NDIR);
  const bT = dot3(TDIR, l), bN = dot3(NDIR, l), det = TT * NN - TN * TN;
  const a = (bT * NN - bN * TN) / det, b = (TT * bN - TN * bT) / det;
  return { temp: wbEaseInv(a / KT) * 100, tint: wbEaseInv(b / KN) * 100 };
}

// Tone curve on the RGB power norm (same formulas as the GLSL / TSL).
function tContrast(x, k) {
  if (!k) return x;
  const y = clamp(x, 0, 1), g = k > 0 ? 1 + 2 * k : 1 / (1 - 1.2 * k), p = 0.45;
  const sc = y < p ? p * Math.pow(y / p, g) : 1 - (1 - p) * Math.pow((1 - y) / (1 - p), g);
  return x + (sc - y) * 0.8;
}
function tHigh(x, h) {
  if (h >= 0) { const y = clamp(x, 0, 1); return x + h * 0.18 * 17.54 * y * y * y * Math.pow(1 - y, 1.5); }
  const k = 0.5, sc = x < k ? x : k + (1 - k) * (1 - Math.exp(-(x - k) / (1 - k)));
  return x + (sc - x) * -h;
}
function tShad(x, s) { const y = clamp(x, 0, 1); return x + s * 0.18 * 17.54 * Math.pow(y, 1.5) * (1 - y) * (1 - y) * (1 - y); }
function tWhites(x, w) { let m = clamp(x, 0, 1); m *= m; return x * (1 + (1 / (1 - 0.3 * w) - 1) * m); }
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function tBlacks(x, b) { return x + b * 0.1 * (1 - smooth(0, 0.6, x)); }
export function ccToneNorm(x, t) {
  x = tContrast(x, t.contrast / 100); x = tHigh(x, t.highlights / 100); x = tShad(x, t.shadows / 100);
  x = tWhites(x, t.whites / 100); x = tBlacks(x, t.blacks / 100); return x;
}
const pnorm = (r, g, b) => { const d = r * r + g * g + b * b; return d > 1e-10 ? (r * r * r + g * g * g + b * b * b) / d : 0; };

// Colour wheels: the puck is a CbCr direction (BT.709 — the vectorscope's axes), luma 0,
// plus the luminance slider as a neutral offset. Radius is eased for fine control near 0.
const WHEEL_CHROMA = 0.15, WHEEL_LUMA = 0.15;
export function ccYcc2rgb(y, cb, cr) { return [y + 1.5748 * cr, y - 0.1873 * cb - 0.4681 * cr, y + 1.8556 * cb]; }
export function ccWheelOffset(w) {
  const r = Math.hypot(w.x, w.y), k = r > 1e-6 ? Math.pow(r, 1.6) / r : 0;
  const o = ccYcc2rgb(0, w.x * k * WHEEL_CHROMA, w.y * k * WHEEL_CHROMA), L = (w.l / 100) * WHEEL_LUMA;
  return [o[0] + L, o[1] + L, o[2] + L];
}

/**
 * Everything the shader needs, already in shader units. `live` false = do not run the stage.
 * Sections that are off or at defaults come back neutral, so a single uniform set covers all.
 */
export function ccUniformValues(cc) {
  const live = ccIsLive(cc);
  const wbOn = live && ccSectionLive(cc, 'wb');
  const toneOn = live && ccSectionLive(cc, 'tone');
  const t = cc?.tone || ccDefault().tone;
  const curveOn = toneOn && !!(t.contrast || t.highlights || t.shadows || t.whites || t.blacks);
  const L = cc?.levels || ccDefault().levels;
  const W = cc?.wheels || ccDefault().wheels;
  const H = cc?.hsl || ccDefault().hsl;
  return {
    live,
    wb: wbOn ? ccWbGains(cc.wb.temp, cc.wb.tint) : [1, 1, 1],
    expo: toneOn ? Math.pow(2, t.exposure) : 1,
    toneOn: curveOn,
    tone: [t.contrast / 100, t.highlights / 100, t.shadows / 100, t.whites / 100],
    blacks: t.blacks / 100,
    lvOn: live && ccSectionLive(cc, 'levels'),
    lvInB: CC_LEVEL_CHANNELS.map((c) => L[c].inB / 255),
    lvInW: CC_LEVEL_CHANNELS.map((c) => L[c].inW / 255),
    lvGam: CC_LEVEL_CHANNELS.map((c) => L[c].gamma),
    lvOutB: CC_LEVEL_CHANNELS.map((c) => L[c].outB / 255),
    lvOutW: CC_LEVEL_CHANNELS.map((c) => L[c].outW / 255),
    colOn: live && ccSectionLive(cc, 'color'),
    sat: (cc?.color?.saturation ?? 100) / 100,
    vib: (cc?.color?.vibrance ?? 0) / 100,
    whOn: live && ccSectionLive(cc, 'wheels'),
    whS: ccWheelOffset(W.shadows), whM: ccWheelOffset(W.midtones), whH: ccWheelOffset(W.highlights),
    hslOn: live && ccSectionLive(cc, 'hsl'),
    hslH: H.hue.map((v) => v / 100), hslS: H.sat.map((v) => v / 100), hslL: H.lum.map((v) => v / 100),
    mix: live ? (cc.mix ?? 100) / 100 : 0,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   CPU grade (JS twin, display-referred 0..1 rgb) — used for analysis, never for rendering
   ══════════════════════════════════════════════════════════════════════════ */
// stage 'pre' = the input to Levels (after WB, exposure, tone); 'out' = the whole grade.
export function ccGradePixel(rgb, cc, stage = 'out', U = ccUniformValues(cc)) {
  if (!U.live) return rgb.slice();
  let c = rgb.map((v, i) => l2s(s2l(v) * U.wb[i] * U.expo));
  if (U.toneOn) {
    const p = c.map((v) => Math.max(0, v));
    const n = pnorm(p[0], p[1], p[2]);
    const m = ccToneNorm(n, cc.tone);
    const r = n > 1e-6 ? m / n : 1, k = clamp(r, 0, 3);
    c = c.map((v) => m + (v - n) * k);
  }
  if (stage === 'pre') return c.map((v) => clamp(v, 0, 1));
  // the remaining sections are only needed by tests; keep them short and faithful
  if (U.lvOn) {
    c = c.map((v, i) => {
      const k = i + 1;
      let x = clamp((v - U.lvInB[k]) / Math.max(U.lvInW[k] - U.lvInB[k], 1e-4), 0, 1);
      x = Math.pow(x, 1 / U.lvGam[k]);
      x = U.lvOutB[k] + x * (U.lvOutW[k] - U.lvOutB[k]);
      x = clamp((x - U.lvInB[0]) / Math.max(U.lvInW[0] - U.lvInB[0], 1e-4), 0, 1);
      return U.lvOutB[0] + Math.pow(x, 1 / U.lvGam[0]) * (U.lvOutW[0] - U.lvOutB[0]);
    });
  }
  if (U.colOn) { const Y = dot3(c, LUMA709); c = c.map((v) => Y + (v - Y) * U.sat); }
  if (U.whOn) {
    const Y = clamp(dot3(c, LUMA709), 0, 1), ws = (1 - Y) * (1 - Y), wh = Y * Y, wm = 1 - ws - wh;
    c = c.map((v, i) => v + ws * U.whS[i] + wm * U.whM[i] + wh * U.whH[i]);
  }
  c = c.map((v) => clamp(v, 0, 1));
  return rgb.map((v, i) => v + (c[i] - v) * U.mix);
}

/* ══════════════════════════════════════════════════════════════════════════
   Auto + pickers. Inputs are RGBA8 buffers of the layer's SOURCE pixels
   (straight alpha; transparent pixels never vote).
   ══════════════════════════════════════════════════════════════════════════ */
const opaque = (buf, i) => buf[i * 4 + 3] >= 128;

// Shades-of-Grey (Minkowski p=8) + a near-neutral refine weighted by luma³ — the
// lab's sweep winner (grey-world 11.0 → 7.4 mean ΔE), then the brightness weighting
// (2.89 → 2.34 on the port sweep; a scene full of warm-brown midtones no longer reads
// as a cast, while intended warmth still survives). Clipped / near-black never vote.
const WB_TUNE = { p: 8, refine: [0.4, 0.3, 0.22, 0.18], minNeutral: 0.02, darkY: 0.01 };
export function ccEstimateWhiteBalance(buf, n) {
  const lin = new Float32Array(n * 3), ok = new Uint8Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const r = buf[i * 4], g = buf[i * 4 + 1], bl = buf[i * 4 + 2];
    lin[i * 3] = S2L[r]; lin[i * 3 + 1] = S2L[g]; lin[i * 3 + 2] = S2L[bl];
    const y = S2L[r] * LUMA709[0] + S2L[g] * LUMA709[1] + S2L[bl] * LUMA709[2];
    ok[i] = opaque(buf, i) && Math.max(r, g, bl) < 250 && y > WB_TUNE.darkY ? 1 : 0;
    total += ok[i];
  }
  if (!total) return { temp: 0, tint: 0 };
  const P = WB_TUNE.p, e = [0, 0, 0];
  for (let i = 0; i < n; i++) { if (!ok[i]) continue; for (let c = 0; c < 3; c++) e[c] += Math.pow(lin[i * 3 + c], P); }
  const ill = e.map((v) => Math.pow(v / total, 1 / P)), iy = dot3(ill, LUMA709);
  let gains = ill.map((v) => iy / Math.max(v, 1e-6));
  for (const thr of WB_TUNE.refine) {
    let sr = 0, sg = 0, sb = 0, ws = 0, k = 0;
    for (let i = 0; i < n; i++) {
      if (!ok[i]) continue;
      const r = lin[i * 3] * gains[0], g = lin[i * 3 + 1] * gains[1], bl = lin[i * 3 + 2] * gains[2];
      const mx = Math.max(r, g, bl), ch = (mx - Math.min(r, g, bl)) / (mx + 1e-6);
      if (ch >= thr) continue;
      const y = r * LUMA709[0] + g * LUMA709[1] + bl * LUMA709[2], w = (1 - ch / thr) * y * y * y;
      sr += (r / y) * w; sg += (g / y) * w; sb += (bl / y) * w; ws += w; k++;
    }
    if (k < total * WB_TUNE.minNeutral || ws <= 0) break;
    const avg = [sr / ws, sg / ws, sb / ws], ay = dot3(avg, LUMA709);
    gains = gains.map((v, c) => v * ay / avg[c]);
  }
  const tt = ccGainsToTempTint(gains);
  return { temp: Math.round(clamp(tt.temp, -100, 100)), tint: Math.round(clamp(tt.tint, -100, 100)) };
}

/** WB picker: the sampled source colour (0..255 rgb) becomes neutral. */
export function ccPickWhiteBalance(rgb255) {
  const lin = rgb255.map((x) => s2l(clamp(x, 0, 255) / 255));
  const y = dot3(lin, LUMA709);
  if (y < 0.002) return null;
  const tt = ccGainsToTempTint(lin.map((x) => y / Math.max(x, 1e-5)));
  return { temp: Math.round(clamp(tt.temp, -100, 100)), tint: Math.round(clamp(tt.tint, -100, 100)) };
}

// Exposure: brighten until the 99th percentile reaches white or the median reaches 0.55,
// whichever first; darken only when the median is very high. Then fix only what is off.
export function ccAutoTone(buf, n, cc) {
  const wg = cc && ccSectionLive({ ...cc, enabled: true, mix: 100 }, 'wb') ? ccWbGains(cc.wb.temp, cc.wb.tint) : [1, 1, 1];
  const lin = [];
  for (let i = 0; i < n; i++) {
    if (!opaque(buf, i)) continue;
    lin.push(S2L[buf[i * 4]] * wg[0], S2L[buf[i * 4 + 1]] * wg[1], S2L[buf[i * 4 + 2]] * wg[2]);
  }
  const m = lin.length / 3;
  const t = { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 };
  if (!m) return t;
  const BINS = 1024;
  const histAt = (k) => {
    const hist = new Uint32Array(BINS);
    for (let i = 0; i < m; i++) hist[Math.min(BINS - 1, Math.floor(pnorm(l2s(lin[i * 3] * k), l2s(lin[i * 3 + 1] * k), l2s(lin[i * 3 + 2] * k)) / 2 * BINS))]++;
    const pct = (p) => { let acc = 0; for (let i = 0; i < BINS; i++) { acc += hist[i]; if (acc >= p * m) return (i + 0.5) / BINS * 2; } return 2; };
    const above = (v0) => { let a = 0; for (let i = Math.floor(v0 / 2 * BINS); i < BINS; i++) a += hist[i]; return a / m; };
    return { pct, above };
  };
  const h0 = histAt(1), p50 = h0.pct(0.5), p99 = h0.pct(0.99);
  let ev = Math.min(Math.log2(s2l(0.96) / s2l(clamp(p99, 0.004, 1))), Math.log2(s2l(0.55) / s2l(clamp(p50, 0.004, 1))));
  if (p50 > 0.62) ev = Math.min(ev, 0.6 * Math.log2(s2l(0.5) / s2l(p50)));
  ev = clamp(ev, -2, 3);
  if (Math.abs(ev) < 0.08) ev = 0;
  t.exposure = Math.round(ev * 100) / 100;
  const H = histAt(Math.pow(2, ev));
  const hiFrac = H.above(0.95);
  if (hiFrac > 0.03) t.highlights = -Math.round(clamp(hiFrac * 300, 10, 50));
  const q10 = H.pct(0.1), q50 = H.pct(0.5), q90 = H.pct(0.9);
  if (q10 < 0.06 && q50 < 0.4) t.shadows = Math.round(clamp((0.4 - q50) * 90, 0, 30));
  if (q90 - q10 < 0.5) t.contrast = Math.round(clamp((0.5 - (q90 - q10)) * 100, 0, 35));
  const solve = (key, x, target, lo, hi) => {
    for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; t[key] = mid; if (ccToneNorm(x, t) < target) lo = mid; else hi = mid; }
    t[key] = Math.round((lo + hi) / 2);
  };
  const p005 = H.pct(0.005), p995 = H.pct(0.995);
  for (let pass = 0; pass < 2; pass++) {
    const w = ccToneNorm(p995, t);
    if (w < 0.9) solve('whites', p995, 0.95, 0, 50); else if (w > 1.02) solve('whites', p995, 1.0, -50, 0);
    if (ccToneNorm(p005, t) > 0.045) solve('blacks', p005, 0.02, -50, 0);
  }
  return t;
}

/** RGBA8 buffer of the INPUT to Levels (WB + exposure + tone applied), for histograms / pickers. */
export function ccPreLevelsBuffer(buf, n, cc) {
  const out = new Uint8ClampedArray(n * 4);
  const live = cc ? { ...cc, enabled: true, mix: 100 } : null;
  const U = ccUniformValues(live);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const c = U.live ? ccGradePixel([buf[o] / 255, buf[o + 1] / 255, buf[o + 2] / 255], live, 'pre', U) : [buf[o] / 255, buf[o + 1] / 255, buf[o + 2] / 255];
    out[o] = c[0] * 255 + 0.5; out[o + 1] = c[1] * 255 + 0.5; out[o + 2] = c[2] * 255 + 0.5; out[o + 3] = buf[o + 3];
  }
  return out;
}

// Photoshop's "Enhance per-channel contrast" + "Snap neutral midtones", read at the input to Levels.
export function ccAutoLevels(pre, n) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let m = 0;
  for (let i = 0; i < n; i++) { if (!opaque(pre, i)) continue; hist[0][pre[i * 4]]++; hist[1][pre[i * 4 + 1]]++; hist[2][pre[i * 4 + 2]]++; m++; }
  const levels = { rgb: ccLevelsDefault(), r: ccLevelsDefault(), g: ccLevelsDefault(), b: ccLevelsDefault() };
  if (!m) return levels;
  const pc = (h, p) => { let a = 0; for (let i = 0; i < 256; i++) { a += h[i]; if (a >= p * m) return i; } return 255; };
  const keys = ['r', 'g', 'b'];
  keys.forEach((c, k) => {
    let lo = pc(hist[k], 0.001), hi = pc(hist[k], 0.999);
    if (hi - lo < 40) { const mid = (hi + lo) / 2; lo = Math.max(0, Math.round(mid - 20)); hi = Math.min(255, Math.round(mid + 20)); }
    Object.assign(levels[c], { inB: lo, inW: hi });
  });
  const s = [0, 0, 0]; let cnt = 0;
  for (let i = 0; i < n; i++) {
    if (!opaque(pre, i)) continue;
    const v = keys.map((c, k) => clamp((pre[i * 4 + k] - levels[c].inB) / (levels[c].inW - levels[c].inB), 0, 1));
    const y = dot3(v, LUMA709);
    if (y < 0.2 || y > 0.8 || Math.max(...v) - Math.min(...v) > 0.12) continue;
    s[0] += v[0]; s[1] += v[1]; s[2] += v[2]; cnt++;
  }
  if (cnt > m * 0.005) {
    const mm = s.map((v) => v / cnt), target = (mm[0] + mm[1] + mm[2]) / 3;
    keys.forEach((c, k) => { levels[c].gamma = +clamp(Math.log(mm[k]) / Math.log(target), 0.5, 2).toFixed(2); });
  }
  return levels;
}

/** Levels pickers: `pre` is the sampled input-to-Levels colour (0..255). Returns new per-channel levels. */
export function ccPickLevels(kind, pre, levels) {
  const out = { ...levels, r: { ...levels.r }, g: { ...levels.g }, b: { ...levels.b } };
  const keys = ['r', 'g', 'b'];
  if (kind === 'black') keys.forEach((c, k) => { out[c].inB = Math.round(clamp(pre[k], 0, out[c].inW - 2)); });
  if (kind === 'white') keys.forEach((c, k) => { out[c].inW = Math.round(clamp(pre[k], out[c].inB + 2, 255)); });
  if (kind === 'grey') {
    const v = keys.map((c, k) => clamp((pre[k] - out[c].inB) / (out[c].inW - out[c].inB), 0.01, 0.99));
    const target = dot3(v, LUMA709);
    keys.forEach((c, k) => { out[c].gamma = +clamp(Math.log(v[k]) / Math.log(target), 0.1, 9.99).toFixed(2); });
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   Scopes — draw into a 2D canvas from an RGBA8 frame buffer (w × h)
   ══════════════════════════════════════════════════════════════════════════ */
export function ccHistogram(buf, n) {
  const H = [new Float32Array(256), new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  for (let i = 0; i < n; i++) {
    const o = i * 4; if (buf[o + 3] < 8) continue;
    const r = buf[o], g = buf[o + 1], b = buf[o + 2];
    H[0][r]++; H[1][g]++; H[2][b]++; H[3][Math.round(r * 0.2126 + g * 0.7152 + b * 0.0722)]++;
  }
  return H;
}
function histScale(H, chans) {
  const vals = [];
  for (const c of chans) for (let i = 2; i < 254; i++) vals.push(H[c][i]);
  vals.sort((a, b) => a - b);
  return Math.max(1, vals[Math.floor(vals.length * 0.995)] * 1.08);
}
const CH_FILL = ['rgba(255,70,90,', 'rgba(60,230,130,', 'rgba(70,140,255,'];
/** mode: 'rgb' | 'luma' | 'r' | 'g' | 'b' */
export function ccDrawHistogram(ctx, w, h, H, mode = 'rgb', pad = 6) {
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
  for (let q = 1; q < 4; q++) { const x = Math.round(q / 4 * w) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  const single = { r: 0, g: 1, b: 2 }[mode];
  const chans = mode === 'luma' ? [3] : single != null ? [single] : [0, 1, 2];
  const top = histScale(H, chans);
  const path = (c) => {
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let i = 0; i < 256; i++) ctx.lineTo((i + 0.5) / 256 * w, h - Math.min(1, H[c][i] / top) * (h - pad));
    ctx.lineTo(w, h); ctx.closePath();
  };
  ctx.globalCompositeOperation = 'lighter';
  if (mode === 'luma') { path(3); ctx.fillStyle = 'rgba(220,220,228,0.55)'; ctx.fill(); }
  else for (const c of chans) { path(c); ctx.fillStyle = CH_FILL[c] + (single != null ? '0.7)' : '0.55)'); ctx.fill(); }
  ctx.globalCompositeOperation = 'source-over';
}

export function ccDrawWaveform(ctx, w, h, buf, bw, bh, mode = 'parade', dpr = 1) {
  const parade = mode === 'parade', secs = parade ? 3 : 1, gap = parade ? Math.round(4 * dpr) : 0;
  const sw = Math.max(1, Math.floor((w - gap * (secs - 1)) / secs));
  const padT = Math.round(6 * dpr), padB = Math.round(6 * dpr), hh = Math.max(2, h - padT - padB);
  const acc = new Float32Array(secs * sw * hh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const i = (y * bw + x) * 4; if (buf[i + 3] < 8) continue;
    const col = Math.min(sw - 1, Math.floor(x / bw * sw));
    if (parade) for (let c = 0; c < 3; c++) { const row = hh - 1 - Math.round(buf[i + c] / 255 * (hh - 1)); acc[(c * hh + row) * sw + col]++; }
    else { const yv = buf[i] * 0.2126 + buf[i + 1] * 0.7152 + buf[i + 2] * 0.0722, row = hh - 1 - Math.round(yv / 255 * (hh - 1)); acc[row * sw + col]++; }
  }
  const im = ctx.createImageData(w, h), d = im.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = 9; d[i + 1] = 9; d[i + 2] = 11; d[i + 3] = 255; }
  const norm = bh / hh * 0.9;
  const tint = parade ? [[255, 80, 96], [70, 235, 140], [80, 150, 255]] : [[200, 240, 215]];
  for (let s = 0; s < secs; s++) for (let r = 0; r < hh; r++) for (let c = 0; c < sw; c++) {
    const a = acc[(s * hh + r) * sw + c]; if (!a) continue;
    const k = Math.min(1, Math.sqrt(a / norm) * 0.55), o = ((r + padT) * w + s * (sw + gap) + c) * 4;
    d[o] = Math.min(255, 9 + tint[s][0] * k); d[o + 1] = Math.min(255, 9 + tint[s][1] * k); d[o + 2] = Math.min(255, 11 + tint[s][2] * k);
  }
  ctx.putImageData(im, 0, 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.font = `${Math.round(9 * dpr)}px Inter, sans-serif`;
  for (const q of [0, 25, 50, 75, 100]) {
    const y = Math.round(padT + (1 - q / 100) * (hh - 1)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    if (q && q < 100) ctx.fillText(String(q), 3 * dpr, y - 2 * dpr);
  }
}

export function ccDrawVectorscope(ctx, w, h, buf, n, zoom = 1, dpr = 1) {
  const S = Math.min(w, h), cx = w / 2, cy = h / 2, R = S * 0.46;
  const acc = new Float32Array(w * h), cr = new Float32Array(w * h), cg = new Float32Array(w * h), cb = new Float32Array(w * h);
  for (let i = 0; i < n; i++) {
    const o4 = i * 4; if (buf[o4 + 3] < 8) continue;
    const r = buf[o4] / 255, g = buf[o4 + 1] / 255, bl = buf[o4 + 2] / 255;
    const y = r * 0.2126 + g * 0.7152 + bl * 0.0722, Cb = (bl - y) / 1.8556, Cr = (r - y) / 1.5748;
    const px = Math.round(cx + Cb / 0.5 * R * zoom), py = Math.round(cy - Cr / 0.5 * R * zoom);
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const o = py * w + px; acc[o]++; cr[o] += r; cg[o] += g; cb[o] += bl;
  }
  const im = ctx.createImageData(w, h), d = im.data;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4; d[o] = 9; d[o + 1] = 9; d[o + 2] = 11; d[o + 3] = 255;
    const a = acc[i]; if (!a) continue;
    const k = Math.min(1, 0.35 + Math.log1p(a) / 4.5);
    let r = cr[i] / a, g = cg[i] / a, bl = cb[i] / a; const mx = Math.max(r, g, bl, 0.05);
    r /= mx; g /= mx; bl /= mx;
    d[o] = 9 + r * 246 * k; d[o + 1] = 9 + g * 246 * k; d[o + 2] = 11 + bl * 244 * k;
  }
  ctx.putImageData(im, 0, 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,200,150,0.35)'; ctx.setLineDash([3 * dpr, 3 * dpr]);
  const sa = 123 * Math.PI / 180; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(sa) * R, cy - Math.sin(sa) * R); ctx.stroke(); ctx.setLineDash([]);
  const T = [['R', [0.75, 0, 0]], ['Yl', [0.75, 0.75, 0]], ['G', [0, 0.75, 0]], ['Cy', [0, 0.75, 0.75]], ['B', [0, 0, 0.75]], ['Mg', [0.75, 0, 0.75]]];
  ctx.font = `${Math.round(8.5 * dpr)}px Inter, sans-serif`; ctx.fillStyle = 'rgba(255,255,255,0.32)'; ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  for (const [lbl, [r, g, bl]] of T) {
    const y = r * 0.2126 + g * 0.7152 + bl * 0.0722, Cb = (bl - y) / 1.8556, Cr = (r - y) / 1.5748;
    const px = cx + Cb / 0.5 * R * zoom, py = cy - Cr / 0.5 * R * zoom, q = 4 * dpr;
    if (Math.abs(px - cx) > w / 2 || Math.abs(py - cy) > h / 2) continue;
    ctx.strokeRect(px - q, py - q, q * 2, q * 2);
    ctx.fillText(lbl, px + q + 2, py + 3 * dpr);
  }
}

/** Wheel background (CbCr plane at mid grey), drawn once per size. */
export function ccWheelBackground(size) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d'), im = x.createImageData(size, size), d = im.data, R = size / 2 - 1;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const u = (i + 0.5 - size / 2) / R, v = -(j + 0.5 - size / 2) / R, r = Math.hypot(u, v), o = (j * size + i) * 4;
    if (r > 1) continue;
    const rgb = ccYcc2rgb(0.42, u * 0.3, v * 0.3);
    d[o] = clamp(rgb[0] * 255, 0, 255); d[o + 1] = clamp(rgb[1] * 255, 0, 255); d[o + 2] = clamp(rgb[2] * 255, 0, 255); d[o + 3] = clamp((1 - r) * R, 0, 1) * 255;
  }
  x.putImageData(im, 0, 0);
  return c;
}
