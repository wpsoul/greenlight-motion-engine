import * as THREE from 'three';

/*
 * Chroma Key — layer effect (port of html/chroma-key-lab.html).
 *
 * A keyer is a screen-ness function s(pixel) ∈ [0,1] (1 = screen) followed by
 * levels. Four functions share that one contract, so the levels, choke, feather,
 * despill and light-wrap stages are written ONCE:
 *
 *   diff    Colour Difference (the Keylight family). The KEY HUE IS ROTATED ONTO
 *           GREEN — a rotation of RGB about the grey axis, exact for the three
 *           primaries — and then s = G′ − mix(max(R′,B′), min(R′,B′), balance),
 *           normalised by the same measure of the key colour. Being a
 *           DIFFERENCE and not a distance, a dark fold on the screen keys as
 *           cleanly as the lit centre. Works for ANY hue: the rotation is what
 *           makes nothing here green-specific.
 *   chroma  Distance from the key in the CbCr plane, ignoring brightness.
 *   luma    Distance in Y with a chroma guard — white / black / grey backdrops.
 *   dist3d  Euclidean distance in weighted YCbCr — any colour including grey.
 *
 * The SAME rotation drives the despill: clamp G′ to the other two channels'
 * envelope, add the removed luma back as grey (or a tint), rotate back. One
 * matrix buys a colour-agnostic matte AND a colour-agnostic despill.
 *
 * Passes, all fullscreen quads on the isolate (the layer-mask apply precedent):
 *   KEY    plate (premultiplied) → STRAIGHT colour + matte           → pooled A
 *   CHOKE  min/max over a disc, skipped at 0                          → pooled B
 *   OUT    feather + light wrap + plate coverage + premultiply + view → the plate
 * It runs FIRST of all per-layer stages, in place, so every later stage — mask,
 * rig, Auto Fill, DOF, Running Glow's contour, the overlay chain's matte, track
 * matte — reads the KEYED silhouette. A keyed layer's shape IS the subject.
 *
 * Settled in the lab, and the numbers to remember when this looks wrong:
 *  - Auto key = the bigger of (dominant hue cluster, dominant colourless luma
 *    cluster), border pixels weighted ×2. Border-only sampling picked olive /
 *    brown / black on real plates; a black backdrop must beat a blue shirt.
 *  - Dark skin on a yellow-green cloth needs Screen Balance ≈35 and Clip White
 *    ≈62, or the face sits at 60% alpha (Keylight's screen-balance lesson).
 *  - The intermediate is STRAIGHT colour on purpose: a choke that GROWS reveals
 *    the source pixel under the matte, which is the right colour to reveal, and
 *    the plate's own coverage is re-applied at the end so growth never leaves
 *    the layer box.
 */

export const CHROMA_KEY_LAYER_EFFECT_ID = 'chromaKey';

// Free. Keying is table stakes for an editor; flip this to gate the RENDER the
// way Droste / Running Glow do (VideoEditor's handleRenderInBackground reads
// containsProChromaKeyEffect, which honours this flag).
export const CK_IS_PRO = false;

export const CK_DEFAULTS = {
  ckKeyColor: '#3fb14a',  // the screen colour; the panel samples it from the clip
  ckMethod: 0,            // 0 auto (from the key colour), 1 diff, 2 chroma, 3 luma, 4 dist3d
  // screen matte
  ckBalance: 40,          // % — diff: 0 compare against the stronger other channel, 100 the weaker
  ckAdapt: 40,            // % — diff: scale the expected screen level by the pixel's own brightness
  ckTolerance: 0.3,       // chroma / luma / dist3d: distance that counts as fully "not screen"
  ckLumaWeight: 0.5,      // dist3d: weight of Y against CbCr
  ckChromaGuard: 1.8,     // luma: weight of CbCr, so a saturated bright colour is not "white"
  ckGain: 115,            // % — screen-ness multiplier before levels
  ckClipBlack: 8,         // % — matte levels
  ckClipWhite: 70,        // %
  // refine
  ckShrink: 0,            // composition px — negative erodes, positive grows
  ckFeather: 0,           // composition px
  // spill
  ckSpill: 100,           // %
  ckSpillBias: 30,        // % — 0 clamp to the average of the other two channels, 100 to the stronger
  ckSpillLuma: 70,        // % — put the removed brightness back as grey
  ckSpillTintAmt: 0,      // %
  ckSpillTint: '#c9a58a',
  // light wrap (a colour, not the scene — a layer effect cannot see the layers below)
  ckWrapAmt: 0,           // %
  ckWrapWidth: 12,        // composition px
  ckWrapColor: '#ffe9c9',
  // output
  ckView: 0,              // 0 result, 1 matte, 2 status (black / grey partial / white) — RENDERS
  ckAmount: 100,          // % master mix (keyframable); 0 is an exact bypass
};

export const CK_NUMBER_FIELDS = [
  { key: 'ckBalance', label: 'Screen Balance', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'screen', methods: [1] },
  { key: 'ckAdapt', label: 'Brightness Adapt', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'screen', methods: [1] },
  { key: 'ckTolerance', label: 'Tolerance', min: 0.02, max: 1, step: 0.01, kf: true, group: 'screen', methods: [2, 3, 4] },
  { key: 'ckLumaWeight', label: 'Luma Weight', min: 0, max: 2, step: 0.05, kf: true, group: 'screen', methods: [4] },
  { key: 'ckChromaGuard', label: 'Chroma Guard', min: 0, max: 4, step: 0.1, kf: true, group: 'screen', methods: [3] },
  { key: 'ckGain', label: 'Screen Gain', min: 50, max: 300, step: 1, suffix: '%', kf: true, group: 'screen' },
  { key: 'ckClipBlack', label: 'Clip Black', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'screen' },
  { key: 'ckClipWhite', label: 'Clip White', min: 1, max: 100, step: 1, suffix: '%', kf: true, group: 'screen' },
  { key: 'ckShrink', label: 'Choke', min: -6, max: 6, step: 0.1, suffix: 'px', kf: true, group: 'refine' },
  { key: 'ckFeather', label: 'Feather', min: 0, max: 12, step: 0.1, suffix: 'px', kf: true, group: 'refine' },
  { key: 'ckSpill', label: 'Spill Removal', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'spill' },
  { key: 'ckSpillBias', label: 'Spill Bias', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'spill' },
  { key: 'ckSpillLuma', label: 'Restore Luma', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'spill' },
  { key: 'ckSpillTintAmt', label: 'Tint', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'spill' },
  { key: 'ckWrapAmt', label: 'Amount', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'wrap' },
  { key: 'ckWrapWidth', label: 'Width', min: 1, max: 40, step: 0.5, suffix: 'px', kf: true, group: 'wrap' },
  { key: 'ckAmount', label: 'Effect Amount', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'output' },
];

export const CK_METHODS = [
  [0, 'Auto (from key colour)'],
  [1, 'Colour Difference'],
  [2, 'Chroma Distance'],
  [3, 'Luma'],
  [4, '3D Colour Distance'],
];

export const CK_ENUM_FIELDS = [
  { key: 'ckMethod', label: 'Keyer', group: 'key', options: CK_METHODS },
  { key: 'ckView', label: 'View', group: 'output', options: [[0, 'Result'], [1, 'Matte'], [2, 'Status']] },
];

export const CK_COLOR_FIELDS = [
  { key: 'ckKeyColor', label: 'Key Colour', group: 'key' },
  { key: 'ckSpillTint', label: 'Spill Tint', group: 'spill' },
  { key: 'ckWrapColor', label: 'Wrap Colour', group: 'wrap' },
];

// Keyframable params, registered in keyframeProps.js.
export const CK_KF_KEYS = CK_NUMBER_FIELDS.filter((f) => f.kf).map((f) => f.key);

/* Looks, sweep-tuned in the lab against ground-truth mattes. Each writes the FULL
   pose EXCEPT the key colour — that belongs to the footage, not to the look — so
   switching looks can never leave a stray knob from the last one. */
const { ckKeyColor: _ignoredKey, ...CK_POSE_DEFAULTS } = CK_DEFAULTS;
const preset = (values) => ({ ...CK_POSE_DEFAULTS, ...values });
export const CK_PRESETS = [
  { name: 'Clean Screen', values: preset({}) },
  { name: 'Fine Hair', values: preset({ ckAdapt: 40, ckGain: 100, ckClipBlack: 10, ckClipWhite: 85 }) },
  { name: 'Dark Subject', values: preset({ ckBalance: 35, ckClipWhite: 62 }) },
  { name: 'Compressed Footage', values: preset({ ckGain: 125, ckClipBlack: 14, ckClipWhite: 80, ckShrink: -0.6, ckFeather: 1.2, ckWrapAmt: 25, ckWrapWidth: 8 }) },
  { name: 'Uneven Screen', values: preset({ ckAdapt: 80, ckGain: 135, ckClipBlack: 12, ckClipWhite: 76, ckBalance: 45 }) },
  { name: 'White Backdrop', values: preset({ ckMethod: 3, ckTolerance: 0.38, ckChromaGuard: 3, ckGain: 120, ckClipBlack: 14, ckClipWhite: 85, ckSpill: 0 }) },
  { name: 'Black Backdrop', values: preset({ ckMethod: 3, ckTolerance: 0.2, ckChromaGuard: 2, ckGain: 130, ckClipBlack: 8, ckClipWhite: 80, ckSpill: 0 }) },
  { name: 'Grey Backdrop', values: preset({ ckMethod: 4, ckTolerance: 0.34, ckLumaWeight: 1.4, ckGain: 130, ckClipBlack: 8, ckClipWhite: 70, ckSpill: 0 }) },
];

export function getChromaKeyEffect(item) {
  const list = Array.isArray(item?.layerEffects) ? item.layerEffects : [];
  return list.find((effect) => effect?.id === CHROMA_KEY_LAYER_EFFECT_ID) || null;
}

/* The Player's collector predicate AND the per-channel exact bypass. Only Effect
   Amount can switch it off; a keyframed amount ramping up from a static 0 keeps
   the pass alive (the Droste precedent). */
export function isChromaKeyEnabled(item) {
  const effect = getChromaKeyEffect(item);
  if (!effect || effect.enabled === false) return false;
  const amount = Number.isFinite(effect.params?.ckAmount) ? effect.params.ckAmount : CK_DEFAULTS.ckAmount;
  if (amount > 0.01) return true;
  const track = item?.propertyKeyframes?.ckAmount;
  return Array.isArray(track) && track.length > 0;
}

function chromaKeyGatesRender(item) {
  if (!CK_IS_PRO) return false;
  return isChromaKeyEnabled(item);
}

// Project sequences can nest other sequences, so inspect the complete saved
// editor state rather than only the currently visible timeline level.
export function containsProChromaKeyEffect(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (chromaKeyGatesRender(value)) return true;
  if (Array.isArray(value)) return value.some((entry) => containsProChromaKeyEffect(entry, seen));
  return Object.values(value).some((entry) => containsProChromaKeyEffect(entry, seen));
}

/** Effective params for a frame: keyframe track ?? stored param ?? default. */
export function resolveChromaKeyParams(item, keyframeProps) {
  const effect = getChromaKeyEffect(item);
  const params = effect?.params || {};
  const out = {};
  for (const [key, fallback] of Object.entries(CK_DEFAULTS)) {
    if (typeof fallback === 'string') {
      const raw = params[key];
      out[key] = typeof raw === 'string' && raw ? raw : fallback;
      continue;
    }
    const kf = keyframeProps?.[key];
    if (Number.isFinite(kf)) { out[key] = kf; continue; }
    const stored = params[key];
    out[key] = Number.isFinite(stored) ? stored : fallback;
  }
  return out;
}

/* ── colour helpers, shared by the panel (auto key), the tests and the shader driver ── */

export const hexToRgb = (hex) => {
  const s = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#000000';
  return [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255];
};
export const rgbToHex = (r, g, b) => {
  const q = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  return `#${q(r)}${q(g)}${q(b)}`;
};
export function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx > 1e-6 ? d / mx : 0, mx];
}
export const keySat = (hex) => rgbToHsv(...hexToRgb(hex))[1];
export const keyLuma = (hex) => { const [r, g, b] = hexToRgb(hex); return 0.299 * r + 0.587 * g + 0.114 * b; };
/** A key with no hue (white, black, grey) has nothing to rotate; despill is off for it. */
export const keyHasHue = (hex) => keySat(hex) > 0.12;

/* Rotation about the grey axis (1,1,1)/√3 by `deg`, as row-major rows. +120° is
   the cyclic permutation R→G→B, so rotating by (120° − hue(key)) lands the key
   colour on the green axis exactly for the three primaries and monotonically for
   everything in between. */
export function hueRotationRows(deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const k = (1 - c) / 3;
  const q = s / Math.sqrt(3);
  return [
    [c + k, k - q, k + q],
    [k + q, c + k, k - q],
    [k - q, k + q, c + k],
  ];
}
export const mulRows = (M, v) => [0, 1, 2].map((i) => M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2]);

/** The rotation that puts the key hue on green, and its inverse. Identity for a hue-less key. */
export function keyRotation(hex) {
  const [h, s] = rgbToHsv(...hexToRgb(hex));
  if (s < 0.05) return { M: hueRotationRows(0), Mi: hueRotationRows(0), deg: 0 };
  const deg = 120 - h;
  return { M: hueRotationRows(deg), Mi: hueRotationRows(-deg), deg };
}

/** What Auto picks for a key colour: saturated → Colour Difference; very light or
    very dark → Luma; a mid grey → 3D distance. Returns the panel's enum value. */
export function methodForKey(hex) {
  const s = keySat(hex);
  const y = keyLuma(hex);
  if (s > 0.22) return 1;
  if (y > 0.72 || y < 0.22) return 3;
  return 4;
}
/** The keyer that actually runs, as the panel enum (1–4). */
export function effectiveMethod(p) {
  const m = Math.round(Number.isFinite(p?.ckMethod) ? p.ckMethod : 0);
  return m >= 1 && m <= 4 ? m : methodForKey(p?.ckKeyColor);
}
export const CK_METHOD_NAMES = { 1: 'Colour Difference', 2: 'Chroma Distance', 3: 'Luma', 4: '3D Colour' };

/*
 * The screen colour, from a frame's RGBA pixels: the dominant HUE cluster (36
 * bins, border pixels weighted ×2 — a screen touches the frame edge, a person
 * rarely does on every side) against the dominant COLOURLESS luminance cluster,
 * and the bigger cluster wins. That is what lets a black backdrop beat a blue
 * shirt, and a green cloth beat a green-ish jacket.
 */
export function autoKeyColorFromPixels(data, w, h) {
  if (!data || !w || !h) return null;
  const band = Math.max(4, Math.round(Math.min(w, h) * 0.07));
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 120000)));
  const hueHist = new Float32Array(36);
  const lumHist = new Float32Array(16);
  const px = [];
  let satMass = 0;
  let total = 0;
  const isBorder = (x, y) => x < band || x >= w - band || y < band || y >= h - band;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 8) continue;               // transparent — not part of the picture
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const [hh, ss, vv] = rgbToHsv(r, g, b);
      const wgt = isBorder(x, y) ? 2 : 1;
      total += wgt;
      if (ss > 0.22 && vv > 0.08) {
        hueHist[Math.floor(hh / 10) % 36] += wgt;
        satMass += wgt;
        px.push(hh, r, g, b, wgt);
      } else {
        lumHist[Math.min(15, Math.floor(vv * 16))] += wgt;
      }
    }
  }
  if (!total) return null;
  let hueN = 0;
  let hr = 0;
  let hg = 0;
  let hb = 0;
  if (satMass > total * 0.08) {
    let best = 0;
    let bestV = -1;
    for (let k = 0; k < 36; k++) {
      const v = hueHist[k] + 0.5 * (hueHist[(k + 35) % 36] + hueHist[(k + 1) % 36]);
      if (v > bestV) { bestV = v; best = k; }
    }
    const hc = best * 10 + 5;
    for (let j = 0; j < px.length; j += 5) {
      let dh = Math.abs(px[j] - hc);
      if (dh > 180) dh = 360 - dh;
      if (dh <= 18) {
        const wgt = px[j + 4];
        hueN += wgt; hr += px[j + 1] * wgt; hg += px[j + 2] * wgt; hb += px[j + 3] * wgt;
      }
    }
  }
  let bestL = 0;
  let bestLV = -1;
  for (let k = 0; k < 16; k++) {
    const v = lumHist[k] + 0.5 * (lumHist[Math.max(0, k - 1)] + lumHist[Math.min(15, k + 1)]);
    if (v > bestLV) { bestLV = v; bestL = k; }
  }
  const lc = (bestL + 0.5) / 16;
  let lumN = 0;
  let lr = 0;
  let lg = 0;
  let lb = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 8) continue;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const [, ss, vv] = rgbToHsv(r, g, b);
      if (ss <= 0.22 && Math.abs(vv - lc) < 0.09) {
        const wgt = isBorder(x, y) ? 2 : 1;
        lumN += wgt; lr += r * wgt; lg += g * wgt; lb += b * wgt;
      }
    }
  }
  if (hueN && hueN >= lumN) return rgbToHex(hr / hueN, hg / hueN, hb / hueN);
  if (lumN) return rgbToHex(lr / lumN, lg / lumN, lb / lumN);
  return null;
}

/**
 * Sample the screen colour from a clip's media (browser only). Images decode
 * once; a video is seeked to `timeSec` and its frame read. Resolves to a hex or
 * null when the media cannot be read (cross-origin, decode failure).
 */
export async function sampleKeyColorFromMedia(url, mediaType, timeSec = 0) {
  if (typeof document === 'undefined' || !url) return null;
  const readFrame = (source, sw, sh) => {
    const scale = Math.min(1, 480 / Math.max(1, sw));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    return autoKeyColorFromPixels(ctx.getImageData(0, 0, w, h).data, w, h);
  };
  if (mediaType === 'video') {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
      let done = false;
      const finish = (hex) => { if (done) return; done = true; try { v.src = ''; } catch { /* no-op */ } resolve(hex); };
      const timer = setTimeout(() => finish(null), 8000);
      v.addEventListener('error', () => { clearTimeout(timer); finish(null); }, { once: true });
      v.addEventListener('loadedmetadata', () => {
        const t = Math.max(0, Math.min(Number.isFinite(v.duration) ? v.duration - 0.05 : 0, timeSec));
        const grab = () => {
          try { clearTimeout(timer); finish(readFrame(v, v.videoWidth, v.videoHeight)); } catch { clearTimeout(timer); finish(null); }
        };
        v.addEventListener('seeked', () => {
          if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(grab);
          else setTimeout(grab, 60);
        }, { once: true });
        v.currentTime = t;
      }, { once: true });
      v.src = url;
    });
  }
  return new Promise((resolve) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => { try { resolve(readFrame(im, im.naturalWidth, im.naturalHeight)); } catch { resolve(null); } };
    im.onerror = () => resolve(null);
    im.src = url;
  });
}

/* ── shaders ─────────────────────────────────────────────────────────────── */

const CK_VERTEX = /* glsl */`
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const CK_COMMON = /* glsl */`
  precision highp float;
  uniform vec2 uResolution;
  const float TAU_C = 6.28318530718;
  vec3 ycc(vec3 c) {
    return vec3(dot(c, vec3(0.299, 0.587, 0.114)),
                dot(c, vec3(-0.168736, -0.331264, 0.5)),
                dot(c, vec3(0.5, -0.418688, -0.081312)));
  }
`;

/* KEY: premultiplied plate in → STRAIGHT despilled colour + matte out. The
   plate's own coverage (its alpha) is NOT folded in here — OUT re-applies it,
   so a grown matte can never leave the layer box. */
const CK_KEY_FRAGMENT = CK_COMMON + /* glsl */`
  uniform sampler2D uTexture;
  uniform vec3 uKey;
  uniform mat3 uHue;
  uniform mat3 uHueInv;
  uniform float uMethod;     // 0 diff, 1 chroma, 2 luma, 3 dist3d
  uniform float uBalance, uAdapt, uTol, uLumaW, uChromaW, uGain, uClipB, uClipW;
  uniform float uSpill, uSpillBias, uSpillLuma, uSpillTintAmt, uHasHue;
  uniform vec3 uSpillTint;

  float sdiff(vec3 c) {
    vec3 r = uHue * c;
    return r.g - mix(max(r.r, r.b), min(r.r, r.b), uBalance);
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec4 s = texture2D(uTexture, uv);
    vec3 c = s.a > 1e-4 ? s.rgb / s.a : vec3(0.0);
    vec3 yk = ycc(uKey);
    vec3 yc = ycc(c);
    float scr;
    if (uMethod < 0.5) {
      float sk = max(sdiff(uKey), 1e-3);
      float ratio = clamp(yc.x / max(yk.x, 1e-3), 0.35, 1.6);
      float ref = sk * mix(1.0, ratio, uAdapt);
      scr = sdiff(c) / ref;
    } else {
      vec3 d = yc - yk;
      float lw = uMethod < 1.5 ? 0.0 : (uMethod < 2.5 ? 1.0 : uLumaW);
      float cw = uMethod < 1.5 ? 1.0 : (uMethod < 2.5 ? uChromaW : 1.0);
      float dist = length(vec3(d.x * lw, d.yz * cw));
      scr = 1.0 - dist / max(uTol, 1e-4);
    }
    float a0 = 1.0 - clamp(scr * uGain, 0.0, 1.0);
    float a = clamp((a0 - uClipB) / max(uClipW - uClipB, 1e-3), 0.0, 1.0);

    vec3 c2 = c;
    if (uHasHue > 0.5 && uSpill > 0.0) {
      vec3 r = uHue * c;
      float lim = mix((r.r + r.b) * 0.5, max(r.r, r.b), uSpillBias);
      float sp = max(r.g - lim, 0.0) * uSpill;
      r.g -= sp;
      c2 = uHueInv * r;
      float ya = ycc(c2).x;
      c2 += vec3((yc.x - ya) * uSpillLuma);
      c2 += uSpillTint * sp * uSpillTintAmt;
      c2 = clamp(c2, 0.0, 1.0);
    }
    gl_FragColor = vec4(c2, a);
  }
`;

/* CHOKE: negative shrinks (min over a disc), positive grows (max). Straight in, straight out. */
const CK_CHOKE_FRAGMENT = CK_COMMON + /* glsl */`
  uniform sampler2D uTexture;
  uniform vec2 uTexel;       // one COMPOSITION pixel, in uv
  uniform float uShrink;
  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec4 s = texture2D(uTexture, uv);
    float a = s.a;
    float r = abs(uShrink);
    for (int i = 0; i < 12; i++) {
      float t = float(i) / 12.0 * TAU_C;
      vec2 d = vec2(cos(t), sin(t)) * uTexel;
      float v1 = texture2D(uTexture, uv + d * r).a;
      float v2 = texture2D(uTexture, uv + d * r * 0.5).a;
      a = uShrink < 0.0 ? min(a, min(v1, v2)) : max(a, max(v1, v2));
    }
    gl_FragColor = vec4(s.rgb, a);
  }
`;

/* OUT: feather, light wrap, the plate's coverage, premultiply, views, amount. */
const CK_OUT_FRAGMENT = CK_COMMON + /* glsl */`
  uniform sampler2D uTexture;   // straight keyed colour + matte
  uniform sampler2D uSource;    // the original premultiplied plate
  uniform vec2 uTexel;
  uniform float uFeather, uWrapAmt, uWrapWidth, uView, uAmount;
  uniform vec3 uWrapColor;
  const float GA = 2.39996323;
  float blurA(vec2 uv, float rad, int n) {
    float acc = 0.0;
    for (int i = 0; i < 24; i++) {
      if (i >= n) break;
      float f = (float(i) + 0.5) / float(n);
      float r = sqrt(f) * rad;
      float t = float(i) * GA;
      acc += texture2D(uTexture, uv + vec2(cos(t), sin(t)) * r * uTexel).a;
    }
    return acc / float(n);
  }
  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec4 k = texture2D(uTexture, uv);
    float a = k.a;
    if (uFeather > 0.0) a = blurA(uv, uFeather, 24);
    vec3 col = k.rgb;
    if (uWrapAmt > 0.0) {
      float wide = blurA(uv, uWrapWidth, 16);
      float w = clamp((1.0 - wide) * uWrapAmt * 1.5, 0.0, 1.0) * step(0.001, a);
      col = mix(col, uWrapColor, w);
    }
    vec4 src = texture2D(uSource, uv);
    float cov = src.a;
    float fa = a * cov;
    // Premultiply, and clamp rgb to alpha so a semi-transparent edge never
    // un-premultiplies past white in the export flatten.
    vec4 keyed = vec4(min(clamp(col, 0.0, 1.0) * fa, vec3(fa)), fa);
    vec4 o;
    if (uView < 0.5) o = mix(src, keyed, uAmount);
    else if (uView < 1.5) o = vec4(vec3(a) * cov, cov);
    else {
      float st = a <= 0.004 ? 0.0 : (a >= 0.996 ? 1.0 : 0.5);
      o = vec4(vec3(st) * cov, cov);
    }
    gl_FragColor = o;
  }
`;

const passMaterial = (fragmentShader, uniforms) => new THREE.ShaderMaterial({
  vertexShader: CK_VERTEX,
  fragmentShader,
  uniforms,
  transparent: true,
  blending: THREE.NoBlending,
  depthTest: false,
  depthWrite: false,
});

/** The three GLSL pass materials. Same `.uniforms.<name>.value` surface as the TSL twins. */
export function createChromaKeyMaterials() {
  const key = passMaterial(CK_KEY_FRAGMENT, {
    uTexture: { value: null },
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uKey: { value: new THREE.Vector3(0.25, 0.7, 0.3) },
    uHue: { value: new THREE.Matrix3() },
    uHueInv: { value: new THREE.Matrix3() },
    uMethod: { value: 0 },
    uBalance: { value: 0.4 },
    uAdapt: { value: 0.4 },
    uTol: { value: 0.3 },
    uLumaW: { value: 0.5 },
    uChromaW: { value: 1.8 },
    uGain: { value: 1.15 },
    uClipB: { value: 0.08 },
    uClipW: { value: 0.7 },
    uSpill: { value: 1 },
    uSpillBias: { value: 0.3 },
    uSpillLuma: { value: 0.7 },
    uSpillTintAmt: { value: 0 },
    uSpillTint: { value: new THREE.Vector3(0.8, 0.65, 0.54) },
    uHasHue: { value: 1 },
  });
  const choke = passMaterial(CK_CHOKE_FRAGMENT, {
    uTexture: { value: null },
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    uShrink: { value: 0 },
  });
  const out = passMaterial(CK_OUT_FRAGMENT, {
    uTexture: { value: null },
    uSource: { value: null },
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    uFeather: { value: 0 },
    uWrapAmt: { value: 0 },
    uWrapWidth: { value: 12 },
    uWrapColor: { value: new THREE.Vector3(1, 0.91, 0.79) },
    uView: { value: 0 },
    uAmount: { value: 1 },
  });
  return { key, choke, out };
}

const setMat3Rows = (m3, rows) => {
  // Matrix3.set takes ROW-major arguments.
  m3.set(
    rows[0][0], rows[0][1], rows[0][2],
    rows[1][0], rows[1][1], rows[1][2],
    rows[2][0], rows[2][1], rows[2][2],
  );
};

/**
 * Drive all three materials from resolved params.
 * `pxScale` converts composition px → plate px (plate width / composition width).
 * Returns the shader method index and whether the choke pass is needed.
 */
export function applyChromaKeyUniforms(mats, p, { width, height, pxScale = 1 }) {
  const method = effectiveMethod(p);
  const hasHue = keyHasHue(p.ckKeyColor);
  const rot = keyRotation(p.ckKeyColor);
  const key = hexToRgb(p.ckKeyColor);
  const tint = hexToRgb(p.ckSpillTint);
  const wrap = hexToRgb(p.ckWrapColor);
  const texelX = pxScale / Math.max(1, width);
  const texelY = pxScale / Math.max(1, height);

  const k = mats.key.uniforms;
  k.uResolution.value.set(width, height);
  k.uKey.value.set(key[0], key[1], key[2]);
  setMat3Rows(k.uHue.value, rot.M);
  setMat3Rows(k.uHueInv.value, rot.Mi);
  k.uMethod.value = method - 1;
  k.uBalance.value = clamp01(p.ckBalance / 100);
  k.uAdapt.value = clamp01(p.ckAdapt / 100);
  k.uTol.value = Math.max(0.01, p.ckTolerance);
  k.uLumaW.value = Math.max(0, p.ckLumaWeight);
  k.uChromaW.value = Math.max(0, p.ckChromaGuard);
  k.uGain.value = Math.max(0.1, p.ckGain / 100);
  k.uClipB.value = clamp01(p.ckClipBlack / 100);
  k.uClipW.value = clamp01(p.ckClipWhite / 100);
  k.uSpill.value = clamp01(p.ckSpill / 100);
  k.uSpillBias.value = clamp01(p.ckSpillBias / 100);
  k.uSpillLuma.value = clamp01(p.ckSpillLuma / 100);
  k.uSpillTintAmt.value = clamp01(p.ckSpillTintAmt / 100);
  k.uSpillTint.value.set(tint[0], tint[1], tint[2]);
  k.uHasHue.value = hasHue ? 1 : 0;

  const c = mats.choke.uniforms;
  c.uResolution.value.set(width, height);
  c.uTexel.value.set(texelX, texelY);
  c.uShrink.value = Math.max(-6, Math.min(6, p.ckShrink));

  const o = mats.out.uniforms;
  o.uResolution.value.set(width, height);
  o.uTexel.value.set(texelX, texelY);
  o.uFeather.value = Math.max(0, p.ckFeather);
  o.uWrapAmt.value = clamp01(p.ckWrapAmt / 100);
  o.uWrapWidth.value = Math.max(0.5, p.ckWrapWidth);
  o.uWrapColor.value.set(wrap[0], wrap[1], wrap[2]);
  o.uView.value = Math.max(0, Math.min(2, Math.round(p.ckView)));
  o.uAmount.value = clamp01(p.ckAmount / 100);

  return { method, needsChoke: Math.abs(p.ckShrink) > 1e-3 };
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
