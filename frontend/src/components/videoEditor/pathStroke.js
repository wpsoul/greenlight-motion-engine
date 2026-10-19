// Path Stroke engine — the advanced options for stroked shapes (a Line, or any
// path drawn as a stroke): taper, width profile, width wave, brush, warp, custom
// dashes, stamps, arrowheads, paint along the path, copies and the outline style.
// Ported from html/path-stroke-lab.html.
//
// A LEAF module (no imports) so node tests can drive it directly, and so
// shapePath.js can import it without a cycle. The GPU half lives in
// pathStrokeRenderer.js; this file only builds geometry.
//
// Nothing here runs for a plain stroke: `strokeEngineActive(line)` is false unless
// an option is actually on, and the Player keeps its Canvas 2D stroke for that case
// — so every project made before these options renders exactly as it did.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (t) => t * t * (3 - 2 * t);
const TAU = Math.PI * 2;
const num = (v, fallback) => {
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};
const HEX_RE = /^#[0-9a-f]{6}$/i;

// ── Schema ──────────────────────────────────────────────────────────────────
// One table drives the sanitizer, the defaults, the panel's ranges and reset dots
// and the keyframe tracks, so the four can never disagree. `kf` names a numeric
// property-keyframe track that overrides the stored value per frame.

const n = (def, min, max, step, extra = {}) => ({ type: 'num', default: def, min, max, step, ...extra });
const e = (def, values, extra = {}) => ({ type: 'enum', default: def, values, ...extra });
const b = (def, extra = {}) => ({ type: 'bool', default: def, ...extra });

export const STROKE_SPANS = ['path', 'trim', 'dash'];
export const STROKE_MARKERS = ['none', 'arrow', 'stealth', 'open', 'circle', 'ring', 'square', 'diamond', 'bar'];
export const STROKE_STAMP_SHAPES = ['dot', 'ring', 'square', 'diamond', 'triangle', 'chevron', 'star', 'bar', 'heart', 'cross'];
export const STROKE_PROFILES = ['lens', 'bulge', 'taperStart', 'taperEnd', 'fishtail', 'spindle', 'teardrop', 'beads', 'pulse', 'steps', 'custom'];

// Cards, in panel order. `group` is the picker group.
export const STROKE_CARDS = [
  {
    key: 'taper', label: 'Taper', group: 'Width',
    desc: 'Thin the stroke toward its start and end — can follow the drawn span',
    fields: {
      follow: e('trim', STROKE_SPANS),
      startLength: n(30, 0, 100, 1, { unit: '%', kf: 'lineTaperStartLength' }),
      endLength: n(30, 0, 100, 1, { unit: '%', kf: 'lineTaperEndLength' }),
      startWidth: n(0, 0, 100, 1, { unit: '%', kf: 'lineTaperStartWidth' }),
      endWidth: n(0, 0, 100, 1, { unit: '%', kf: 'lineTaperEndWidth' }),
      startEase: n(0, 0, 100, 1),
      endEase: n(0, 0, 100, 1),
    },
  },
  {
    key: 'profile', label: 'Width profile', group: 'Width',
    desc: 'Shape the width along the line: lens, bulge, beads, or your own curve',
    fields: {
      preset: e('lens', STROKE_PROFILES),
      points: { type: 'points', default: null },
      repeat: n(1, 1, 40, 1),
      offset: n(0, 0, 100, 0.5, { unit: '%', kf: 'lineProfileOffset' }),
      flow: n(0, -3, 3, 0.05, { unit: '/s' }),
      min: n(0, 0, 100, 1, { unit: '%' }),
    },
  },
  {
    key: 'widthWave', label: 'Width wave', group: 'Width',
    desc: 'Width pulses along the line, and can travel',
    fields: {
      amount: n(60, 0, 100, 1, { unit: '%', kf: 'lineWidthWaveAmount' }),
      wavelength: n(120, 4, 800, 1, { unit: 'px' }),
      phase: n(0, 0, 360, 1, { unit: '°', kf: 'lineWidthWavePhase' }),
      speed: n(0, -6, 6, 0.05, { unit: '/s' }),
    },
  },
  {
    key: 'brush', label: 'Brush', group: 'Width',
    desc: 'Calligraphic nib, pen pressure, rough edges, hand-drawn boil',
    fields: {
      nib: e('round', ['round', 'calligraphic']),
      nibAngle: n(35, -90, 90, 1, { unit: '°' }),
      nibRoundness: n(20, 0, 100, 1, { unit: '%' }),
      pressure: n(0, 0, 100, 1, { unit: '%' }),
      pressureScale: n(300, 20, 1200, 1, { unit: 'px' }),
      rough: n(0, 0, 100, 1, { unit: '%' }),
      roughScale: n(10, 1, 80, 0.5, { unit: 'px' }),
      boil: n(0, 0, 24, 1, { unit: 'fps' }),
      seed: n(7, 1, 99, 1),
    },
  },
  {
    key: 'warp', label: 'Warp path', group: 'Path',
    desc: 'Round corners, offset, zig zag, wiggle and a travelling wave',
    fields: {
      roundCorners: n(0, 0, 300, 1, { unit: 'px' }),
      offset: n(0, -150, 150, 1, { unit: 'px', kf: 'lineWarpOffset' }),
      zigzagSize: n(0, 0, 120, 0.5, { unit: 'px', kf: 'lineZigzagSize' }),
      zigzagRidges: n(24, 1, 160, 1),
      zigzagPoints: e('corner', ['corner', 'smooth']),
      zigzagSpeed: n(0, -8, 8, 0.1, { unit: '/s' }),
      wiggleSize: n(0, 0, 160, 0.5, { unit: 'px', kf: 'lineWiggleSize' }),
      wiggleDetail: n(5, 0.5, 40, 0.5),
      wiggleRate: n(1.5, 0, 12, 0.1, { unit: '/s' }),
      wigglePinEnds: b(true),
      waveAmplitude: n(0, 0, 240, 1, { unit: 'px', kf: 'lineWarpWaveAmplitude' }),
      waveLength: n(320, 20, 1400, 1, { unit: 'px' }),
      waveSpeed: n(0, -2000, 2000, 10, { unit: 'px/s' }),
      wavePinEnds: b(true),
    },
  },
  {
    key: 'copies', label: 'Copies', group: 'Path',
    desc: 'Parallel lines or a repeater, with falloff and trim stagger',
    fields: {
      mode: e('parallel', ['parallel', 'repeater']),
      count: n(3, 1, 24, 1),
      spacing: n(30, -120, 120, 0.5, { unit: 'px', kf: 'lineCopySpacing' }),
      moveX: n(0, -400, 400, 1, { unit: 'px' }),
      moveY: n(0, -400, 400, 1, { unit: 'px' }),
      rotate: n(15, -180, 180, 0.5, { unit: '°' }),
      scale: n(95, 50, 150, 0.5, { unit: '%' }),
      widthFalloff: n(0, 0, 100, 1, { unit: '%' }),
      opacityFalloff: n(0, 0, 100, 1, { unit: '%' }),
      color: e('same', ['same', 'cycle', 'across']),
      colors: { type: 'colors', default: ['#ef4444', '#f59e0b', '#fde047'] },
      stagger: n(0, 0, 2, 0.01, { unit: 's' }),
      order: e('forward', ['forward', 'reverse', 'center']),
      blend: e('normal', ['normal', 'add']),
    },
  },
  {
    key: 'ends', label: 'Arrowheads', group: 'Decorate',
    desc: 'Arrows, dots or bars on the start and end — they ride the trimmed end',
    fields: {
      start: e('none', STROKE_MARKERS),
      end: e('arrow', STROKE_MARKERS),
      size: n(3.2, 1, 12, 0.1, { unit: '×', kf: 'lineEndsSize' }),
      followTrim: b(true),
      grow: b(true),
    },
  },
  {
    key: 'stamps', label: 'Stamps along path', group: 'Decorate',
    desc: 'Dots, chevrons, ties or stars placed along the line',
    fields: {
      shape: e('dot', STROKE_STAMP_SHAPES),
      mode: e('only', ['only', 'below', 'above']),
      spacing: n(36, 2, 300, 1, { unit: 'px' }),
      offset: n(0, -1000, 1000, 1, { unit: 'px', kf: 'lineStampOffset' }),
      speed: n(0, -400, 400, 1, { unit: 'px/s' }),
      size: n(18, 1, 200, 0.5, { unit: 'px' }),
      aspect: n(100, 10, 400, 1, { unit: '%' }),
      followWidth: b(true),
      rotation: e('follow', ['follow', 'fixed', 'random']),
      angle: n(0, -180, 180, 1, { unit: '°' }),
      jitterSize: n(0, 0, 100, 1, { unit: '%' }),
      jitterRotation: n(0, 0, 180, 1, { unit: '°' }),
      jitterOffset: n(0, 0, 120, 1, { unit: 'px' }),
      seed: n(7, 1, 99, 1),
      color: { type: 'color', default: null },
    },
  },
  {
    key: 'paint', label: 'Paint along path', group: 'Decorate',
    desc: 'Gradient or rainbow along the length, a bright core, fades',
    fields: {
      mode: e('gradient', ['fill', 'gradient', 'rainbow']),
      colors: { type: 'colors', default: ['#8b5cf6', '#22d3ee'] },
      span: e('path', STROKE_SPANS),
      repeat: n(1, 1, 12, 1),
      mirror: b(true),
      offset: n(0, 0, 100, 0.5, { unit: '%', kf: 'lineGradientOffset' }),
      flow: n(0, -2, 2, 0.05, { unit: '/s' }),
      core: b(false),
      coreColor: { type: 'color', default: '#ffffff' },
      coreWidth: n(35, 0, 100, 1, { unit: '%' }),
      coreSoftness: n(50, 0, 100, 1, { unit: '%' }),
      fadeIn: n(0, 0, 100, 1, { unit: '%', kf: 'lineFadeIn' }),
      fadeOut: n(0, 0, 100, 1, { unit: '%', kf: 'lineFadeOut' }),
    },
  },
];
export const STROKE_CARD_BY_KEY = Object.fromEntries(STROKE_CARDS.map((c) => [c.key, c]));

// Flat item fields beside the existing lineWidth / lineDash / lineTrim*. Stored
// only once set, so older items round-trip unchanged.
export const LINE_EXTRA_FIELDS = {
  lineStyle: e('solid', ['solid', 'outline']),
  lineOutlineWidth: n(3, 0.5, 40, 0.5, { unit: 'px', kf: 'lineOutlineWidth' }),
  lineDashPattern: { type: 'pattern', default: [30, 18, 0, 0], kfPattern: ['lineDashLength1', 'lineDashGap1', 'lineDashLength2', 'lineDashGap2'] },
  lineDashOffset: n(0, -1000, 1000, 1, { unit: 'px', kf: 'lineDashOffset' }),
  lineDashSpeed: n(0, -400, 400, 1, { unit: 'px/s', kf: 'lineDashSpeed' }),
  lineDashCap: e('line', ['line', 'butt', 'round', 'square']),
  lineDashFit: b(false),
  lineTrimEach: b(false),
  lineGhost: n(0, 0, 100, 1, { unit: '%', kf: 'lineGhost' }),
};

// Every value that CAN move is keyframable: each numeric card field (a named track
// where one was declared above, otherwise `line<Card><Field>`), each colour
// (`kfColor`) and each entry of a colour list (`kfColors`). Choices and switches
// stay static — a dropdown has nothing to interpolate.
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const words = (w) => w.replace(/([A-Z])/g, ' $1').toLowerCase();
for (const c of STROKE_CARDS) {
  for (const [field, spec] of Object.entries(c.fields)) {
    if (spec.type === 'num' && !spec.kf) spec.kf = `line${cap(c.key)}${cap(field)}`;
    if (spec.type === 'color') spec.kfColor = `line${cap(c.key)}${cap(field)}`;
    if (spec.type === 'colors') spec.kfColors = [1, 2, 3].map((i) => `line${cap(c.key)}${cap(field.replace(/s$/, ''))}${i}`);
  }
}

// Keyframe tracks the schema declares, in panel order:
//   { label, card, field, spec, displayLabel, index?, color? }
const PATTERN_NAMES = ['Dash', 'Gap', 'Dash 2', 'Gap 2'];
// Short card names for track labels ("Stamp spacing", not "Stamps along path spacing").
const TRACK_PREFIX = { taper: 'Taper', profile: 'Profile', widthWave: 'Width wave', brush: 'Brush', warp: 'Warp', copies: 'Copies', ends: 'Arrowhead', stamps: 'Stamp', paint: 'Paint' };
export const STROKE_KF_TRACKS = [
  ...Object.entries(LINE_EXTRA_FIELDS).flatMap(([field, spec]) => {
    if (spec.kf) return [{ label: spec.kf, card: null, field, spec, displayLabel: null }];
    if (spec.kfPattern) {
      return spec.kfPattern.map((label, index) => ({
        label, card: null, field, index, displayLabel: `${PATTERN_NAMES[index]} length`,
        spec: { type: 'num', default: spec.default[index], min: 0, max: 400, step: 1, unit: 'px' },
      }));
    }
    return [];
  }),
  ...STROKE_CARDS.flatMap((c) => Object.entries(c.fields).flatMap(([field, spec]) => {
    const name = `${TRACK_PREFIX[c.key] || c.label} ${words(field)}`;
    if (spec.kf) return [{ label: spec.kf, card: c.key, field, spec, displayLabel: name }];
    if (spec.kfColor) return [{ label: spec.kfColor, card: c.key, field, spec, color: true, displayLabel: name }];
    if (spec.kfColors) {
      return spec.kfColors.map((label, index) => ({
        label, card: c.key, field, index, color: true, spec, displayLabel: `${TRACK_PREFIX[c.key] || c.label} colour ${index + 1}`,
      }));
    }
    return [];
  })),
];
const KF_BY_LABEL = Object.fromEntries(STROKE_KF_TRACKS.map((t) => [t.label, t]));
export function strokeKfTrack(label) { return KF_BY_LABEL[label] || null; }
/** The patch that takes every stroke option off `item`, their keyframe tracks included. */
export function clearStrokeOptionsPatch(item) {
  const tracks = { ...(item?.propertyKeyframes || {}) };
  for (const t of STROKE_KF_TRACKS) if (t.card) delete tracks[t.label];
  return { lineStroke: null, propertyKeyframes: tracks };
}
/** Colour tracks (the keyframe evaluator interpolates these as colours). */
export const STROKE_COLOR_KF_LABELS = new Set(STROKE_KF_TRACKS.filter((t) => t.color).map((t) => t.label));

// A keyframed colour comes back as #hex or rgb()/rgba(); the schema stores #rrggbb.
function kfHex(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return t.toLowerCase();
  if (/^#[0-9a-f]{8}$/i.test(t)) return t.slice(0, 7).toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(t)) return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`.toLowerCase();
  const m = t.match(/^rgba?\(([^)]+)\)$/i);
  if (!m) return null;
  const [r, g, bl] = m[1].split(',').map((x) => Math.round(clamp(Number.parseFloat(x) || 0, 0, 255)));
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

// ── Sanitizing ──────────────────────────────────────────────────────────────

function sanitizeField(spec, v) {
  switch (spec.type) {
    case 'num': return clamp(num(v, spec.default), spec.min, spec.max);
    case 'enum': return spec.values.includes(v) ? v : spec.default;
    case 'bool': return typeof v === 'boolean' ? v : spec.default;
    case 'color': return typeof v === 'string' && HEX_RE.test(v) ? v.toLowerCase() : spec.default;
    case 'colors': {
      const list = Array.isArray(v) ? v.filter((c) => typeof c === 'string' && HEX_RE.test(c)).map((c) => c.toLowerCase()).slice(0, 3) : [];
      return list.length >= 2 ? list : spec.default.slice();
    }
    case 'pattern': {
      const list = Array.isArray(v) ? v.slice(0, 4).map((x) => clamp(num(x, 0), 0, 400)) : spec.default.slice();
      while (list.length < 4) list.push(0);
      return list;
    }
    case 'points': {
      if (!Array.isArray(v)) return null;
      const pts = v
        .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
        .map((p) => ({ x: clamp(Number(p.x), 0, 1), y: clamp(Number(p.y), 0, 1) }))
        .sort((a, c) => a.x - c.x)
        .slice(0, 32);
      if (pts.length < 2) return null;
      pts[0].x = 0; pts[pts.length - 1].x = 1;
      return pts;
    }
    default: return spec.default;
  }
}

export function strokeCardDefaults(key) {
  const def = STROKE_CARD_BY_KEY[key];
  if (!def) return null;
  const out = { enabled: true };
  for (const [f, spec] of Object.entries(def.fields)) out[f] = Array.isArray(spec.default) ? spec.default.slice() : spec.default;
  return out;
}

export function sanitizeStrokeCard(key, raw) {
  const def = STROKE_CARD_BY_KEY[key];
  if (!def || !raw || typeof raw !== 'object') return null;
  const out = { enabled: raw.enabled !== false };
  for (const [f, spec] of Object.entries(def.fields)) out[f] = sanitizeField(spec, raw[f]);
  return out;
}

/** `item.lineStroke`: only the cards that are present survive (absent = not added). */
export function sanitizeLineStroke(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const c of STROKE_CARDS) {
    const card = sanitizeStrokeCard(c.key, raw[c.key]);
    if (card) out[c.key] = card;
  }
  return Object.keys(out).length ? out : null;
}

/** The flat extras that are set on `item`, sanitized — absent ones stay absent. */
export function sanitizeLineExtras(item) {
  const out = {};
  if (!item || typeof item !== 'object') return out;
  for (const [k, spec] of Object.entries(LINE_EXTRA_FIELDS)) {
    if (item[k] !== undefined) out[k] = sanitizeField(spec, item[k]);
  }
  return out;
}

// ── Per-frame resolution ────────────────────────────────────────────────────

/**
 * The advanced part of a stroke's settings for one frame: flat extras and every
 * enabled card, with keyframed tracks laid over the stored values. Merged into
 * resolveLineSettings()' result by shapePath.js.
 */
export function resolveLineStroke(item, kfValues = null) {
  const kfNum = (spec, stored) => {
    const v = spec.kf ? kfValues?.[spec.kf] : undefined;
    return Number.isFinite(v) ? clamp(v, spec.min, spec.max) : stored;
  };
  const extras = {};
  for (const [k, spec] of Object.entries(LINE_EXTRA_FIELDS)) {
    const stored = item?.[k] !== undefined ? sanitizeField(spec, item[k]) : (Array.isArray(spec.default) ? spec.default.slice() : spec.default);
    extras[k] = spec.type === 'num' ? kfNum(spec, stored) : stored;
    if (spec.kfPattern) {
      extras[k] = stored.map((v, i) => {
        const kv = kfValues?.[spec.kfPattern[i]];
        return Number.isFinite(kv) ? clamp(kv, 0, 400) : v;
      });
    }
  }
  const kfColor = (label, stored) => (label && kfHex(kfValues?.[label])) || stored;
  const cards = {};
  const src = item?.lineStroke;
  if (src && typeof src === 'object') {
    for (const c of STROKE_CARDS) {
      const raw = src[c.key];
      if (!raw || raw.enabled === false) continue;
      const card = sanitizeStrokeCard(c.key, raw);
      for (const [f, spec] of Object.entries(c.fields)) {
        if (spec.type === 'num') card[f] = kfNum(spec, card[f]);
        // a null stamp colour means "the stroke's paint" — a track only recolours a set one
        else if (spec.kfColor && card[f]) card[f] = kfColor(spec.kfColor, card[f]);
        else if (spec.kfColors) card[f] = card[f].map((col, i) => kfColor(spec.kfColors[i], col));
      }
      cards[c.key] = card;
    }
  }
  return {
    style: extras.lineStyle,
    outlineWidth: extras.lineOutlineWidth,
    dashPattern: extras.lineDashPattern,
    dashOffset: extras.lineDashOffset,
    dashSpeed: extras.lineDashSpeed,
    dashCap: extras.lineDashCap,
    dashFit: extras.lineDashFit,
    trimEach: extras.lineTrimEach,
    ghost: extras.lineGhost,
    cards,
  };
}

/** Does this resolved line need the engine (vs the plain Canvas 2D stroke)? */
export function strokeEngineActive(line) {
  if (!line) return false;
  if (line.style === 'outline' || line.trimEach || line.ghost > 0) return true;
  if (line.dash === 'custom') return true;
  if (line.dash && line.dash !== 'solid'
    && (line.dashOffset || line.dashSpeed || (line.dashCap && line.dashCap !== 'line') || line.dashFit)) return true;
  return !!line.cards && Object.keys(line.cards).length > 0;
}

/**
 * Does the drawn stroke change with the clock on its own (not through keyframes,
 * which the resolved values already carry)? The plate cache folds the time in only
 * when this is true — anything time-driven missing here freezes on its first frame.
 */
export function strokeEngineMoves(line) {
  if (!strokeEngineActive(line)) return false;
  const c = line.cards || {};
  if (line.dash && line.dash !== 'solid' && line.dashSpeed) return true;
  if (c.profile && c.profile.flow) return true;
  if (c.widthWave && c.widthWave.amount > 0 && c.widthWave.speed) return true;
  if (c.warp) {
    const w = c.warp;
    if (w.zigzagSize > 0 && w.zigzagSpeed) return true;
    if (w.wiggleSize > 0 && w.wiggleRate > 0) return true;
    if (w.waveAmplitude > 0 && w.waveSpeed) return true;
  }
  if (c.brush && c.brush.boil > 0 && (c.brush.rough > 0 || c.brush.pressure > 0 || (c.warp && c.warp.wiggleSize > 0))) return true;
  if (c.paint && c.paint.mode !== 'fill' && c.paint.flow) return true;
  if (c.stamps && c.stamps.speed) return true;
  return false;
}

// ── Deterministic noise (range renders start cold, so no state) ─────────────
function hash1(i, seed) {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(seed | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise1(x, seed) {
  const i = Math.floor(x); const f = x - i;
  const a = hash1(i, seed) * 2 - 1; const c = hash1(i + 1, seed) * 2 - 1;
  return a + (c - a) * smooth01(f);
}
function fbm1(x, seed) { return vnoise1(x, seed) * 0.66 + vnoise1(x * 2.13 + 17.3, seed + 31) * 0.34; }
function noiseST(x, t, seed) {
  const i = Math.floor(t); const f = smooth01(t - i);
  return lerp(fbm1(x, seed + i * 97), fbm1(x, seed + (i + 1) * 97), f);
}

// ── Polylines: { x, y: Float64Array, corner: Uint8Array, n, closed, s, L } ───
function mkPoly(count, closed) {
  return { x: new Float64Array(count), y: new Float64Array(count), corner: new Uint8Array(count), n: count, closed };
}
function polyFrom(xs, ys, cs, closed) {
  const p = mkPoly(xs.length, closed);
  p.x.set(xs); p.y.set(ys); if (cs) p.corner.set(cs);
  return p;
}
// Cumulative arc length; a closed poly has n+1 entries (the last is back at vertex 0).
function measure(p) {
  const m = p.closed ? p.n + 1 : p.n;
  const s = new Float64Array(Math.max(1, m));
  for (let i = 1; i < m; i += 1) {
    const a = (i - 1) % p.n; const c = i % p.n;
    s[i] = s[i - 1] + Math.hypot(p.x[c] - p.x[a], p.y[c] - p.y[a]);
  }
  p.s = s; p.L = s[m - 1] || 0;
  return p;
}
function normals(p) {
  const cnt = p.n; const nx = new Float64Array(cnt); const ny = new Float64Array(cnt);
  const seg = (i) => {
    const c = (i + 1) % cnt;
    const dx = p.x[c] - p.x[i]; const dy = p.y[c] - p.y[i]; const l = Math.hypot(dx, dy) || 1;
    return [dy / l, -dx / l];
  };
  for (let i = 0; i < cnt; i += 1) {
    let ax = 0; let ay = 0;
    if (p.closed || i > 0) { const s = seg((i - 1 + cnt) % cnt); ax += s[0]; ay += s[1]; }
    if (p.closed || i < cnt - 1) { const s = seg(i); ax += s[0]; ay += s[1]; }
    const l = Math.hypot(ax, ay) || 1;
    nx[i] = ax / l; ny[i] = ay / l;
  }
  p.nx = nx; p.ny = ny;
  return p;
}
function locate(p, sIn) {
  const L = p.L;
  const s = p.closed ? ((sIn % L) + L) % L : clamp(sIn, 0, L);
  let lo = 0; let hi = p.closed ? p.n : p.n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p.s[mid] <= s) lo = mid; else hi = mid; }
  const i = lo; const j = (i + 1) % p.n; const sl = p.s[i + 1] - p.s[i];
  const f = sl > 0 ? clamp01((s - p.s[i]) / sl) : 0;
  const out = { x: lerp(p.x[i], p.x[j], f), y: lerp(p.y[i], p.y[j], f), i, j, f };
  if (p.nx) {
    const nx = lerp(p.nx[i], p.nx[j], f); const ny = lerp(p.ny[i], p.ny[j], f); const l = Math.hypot(nx, ny) || 1;
    out.nx = nx / l; out.ny = ny / l;
  }
  const dx = p.x[j] - p.x[i]; const dy = p.y[j] - p.y[i]; const dl = Math.hypot(dx, dy) || 1;
  out.tx = dx / dl; out.ty = dy / dl;
  return out;
}
// Even spacing ≤ step between corners; corners and vertex 0 (where s = 0 lives on
// a loop) stay exact.
function resample(p, step) {
  const br = [];
  for (let i = 0; i < p.n; i += 1) if (p.corner[i]) br.push(i);
  if (!p.closed) { if (br[0] !== 0) br.unshift(0); if (br[br.length - 1] !== p.n - 1) br.push(p.n - 1); } else if (br[0] !== 0) br.unshift(0);
  const xs = []; const ys = []; const cs = [];
  const runs = p.closed ? br.length : br.length - 1;
  for (let k = 0; k < runs; k += 1) {
    const a = p.s[br[k]]; const c = k + 1 < br.length ? p.s[br[k + 1]] : p.L;
    const len = c - a; const sub = Math.max(1, Math.ceil(len / step));
    for (let j = 0; j < sub; j += 1) {
      const q = locate(p, a + (len * j) / sub);
      xs.push(q.x); ys.push(q.y); cs.push(j === 0 ? p.corner[br[k]] : 0);
    }
  }
  if (!p.closed) { xs.push(p.x[p.n - 1]); ys.push(p.y[p.n - 1]); cs.push(1); }
  const out = polyFrom(xs, ys, cs, p.closed);
  out.anchorFrac = p.anchorFrac;
  return measure(out);
}
function displace(p, fn) {
  normals(p);
  const q = mkPoly(p.n, p.closed);
  q.corner.set(p.corner);
  for (let i = 0; i < p.n; i += 1) {
    const d = fn(p.s[i]);
    q.x[i] = p.x[i] + p.nx[i] * d; q.y[i] = p.y[i] + p.ny[i] * d;
  }
  q.anchorFrac = p.anchorFrac;
  return measure(q);
}

// ── Anchors → px beziers, Round Corners, flatten ─────────────────────────────
function anchorsPx(points, box) {
  return points.map((q) => ({
    x: box.cx + num(q.x, 0) * box.w, y: box.cy + num(q.y, 0) * box.h,
    hin: { x: num(q.hIn?.x, 0) * box.w, y: num(q.hIn?.y, 0) * box.h },
    hout: { x: num(q.hOut?.x, 0) * box.w, y: num(q.hOut?.y, 0) * box.h },
  }));
}
// Fillet every hard corner (both handles ~0) with an arc of radius r, clamped to
// half of each neighbouring segment — on anchors, so the result is still beziers.
function roundCorners(A, closed, r) {
  if (!(r > 0) || A.length < 3) return A;
  const cnt = A.length; const out = [];
  const zero = (h) => Math.hypot(h.x, h.y) < 0.5;
  for (let i = 0; i < cnt; i += 1) {
    const a = A[i];
    const hasPrev = closed || i > 0; const hasNext = closed || i < cnt - 1;
    if (!hasPrev || !hasNext || !zero(a.hin) || !zero(a.hout)) { out.push(a); continue; }
    const p = A[(i - 1 + cnt) % cnt]; const q = A[(i + 1) % cnt];
    const pc = { x: p.x + p.hout.x, y: p.y + p.hout.y }; const qc = { x: q.x + q.hin.x, y: q.y + q.hin.y };
    const src = Math.hypot(a.x - pc.x, a.y - pc.y) > 0.5 ? pc : p;
    const dst = Math.hypot(qc.x - a.x, qc.y - a.y) > 0.5 ? qc : q;
    let ix = a.x - src.x; let iy = a.y - src.y; const il = Math.hypot(ix, iy) || 1; ix /= il; iy /= il;
    let ox = dst.x - a.x; let oy = dst.y - a.y; const ol = Math.hypot(ox, oy) || 1; ox /= ol; oy /= ol;
    const turn = Math.acos(clamp(ix * ox + iy * oy, -1, 1));
    if (turn < 0.02) { out.push(a); continue; }
    const lp = Math.hypot(a.x - p.x, a.y - p.y); const lq = Math.hypot(q.x - a.x, q.y - a.y);
    const d = Math.min(r * Math.tan(turn / 2), lp * 0.5, lq * 0.5);
    const re = d / Math.tan(turn / 2);
    const k = (4 / 3) * Math.tan(turn / 4) * re;
    out.push({ x: a.x - ix * d, y: a.y - iy * d, hin: { x: 0, y: 0 }, hout: { x: ix * k, y: iy * k } });
    out.push({ x: a.x + ox * d, y: a.y + oy * d, hin: { x: -ox * k, y: -oy * k }, hout: { x: 0, y: 0 } });
  }
  return out;
}
const bz = (a, c1, c2, d, t) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * d; };
// Flatten by arc length with ~`step` px spacing. Every anchor is a sample; one
// whose in/out tangents disagree by > 10° is flagged a corner (joins, Zig Zag and
// resampling keep it exact).
function flatten(A, closed, step) {
  const cnt = A.length; const segs = closed ? cnt : cnt - 1;
  const xs = []; const ys = []; const cs = []; const anchorAt = [];
  const ang = (fx, fy, tx, ty) => Math.atan2(ty - fy, tx - fx);
  const tanOut = (a, c) => {
    for (const q of [{ x: a.x + a.hout.x, y: a.y + a.hout.y }, { x: c.x + c.hin.x, y: c.y + c.hin.y }, c]) {
      if (Math.hypot(q.x - a.x, q.y - a.y) > 1e-3) return ang(a.x, a.y, q.x, q.y);
    }
    return 0;
  };
  const tanIn = (a, c) => {
    for (const q of [{ x: c.x + c.hin.x, y: c.y + c.hin.y }, { x: a.x + a.hout.x, y: a.y + a.hout.y }, a]) {
      if (Math.hypot(c.x - q.x, c.y - q.y) > 1e-3) return ang(q.x, q.y, c.x, c.y);
    }
    return 0;
  };
  const isCorner = (i) => {
    if (!closed && (i === 0 || i === cnt - 1)) return 1;
    let d = Math.abs(tanIn(A[(i - 1 + cnt) % cnt], A[i]) - tanOut(A[i], A[(i + 1) % cnt])) % TAU;
    if (d > Math.PI) d = TAU - d;
    return d > 0.175 ? 1 : 0;
  };
  const M = 48; const tab = new Float64Array(M + 1);
  for (let k = 0; k < segs; k += 1) {
    const a = A[k]; const c = A[(k + 1) % cnt];
    const X = [a.x, a.x + a.hout.x, c.x + c.hin.x, c.x]; const Y = [a.y, a.y + a.hout.y, c.y + c.hin.y, c.y];
    let px = X[0]; let py = Y[0]; tab[0] = 0;
    for (let j = 1; j <= M; j += 1) {
      const t = j / M; const x = bz(X[0], X[1], X[2], X[3], t); const y = bz(Y[0], Y[1], Y[2], Y[3], t);
      tab[j] = tab[j - 1] + Math.hypot(x - px, y - py); px = x; py = y;
    }
    const len = tab[M]; const sub = Math.max(1, Math.ceil(len / step));
    anchorAt.push(xs.length);
    let jj = 0;
    for (let q = 0; q < sub; q += 1) {
      const target = (q / sub) * len;
      while (jj < M - 1 && tab[jj + 1] < target) jj += 1;
      const f = tab[jj + 1] > tab[jj] ? (target - tab[jj]) / (tab[jj + 1] - tab[jj]) : 0;
      const t = (jj + clamp01(f)) / M;
      xs.push(bz(X[0], X[1], X[2], X[3], t)); ys.push(bz(Y[0], Y[1], Y[2], Y[3], t));
      cs.push(q === 0 ? isCorner(k) : 0);
    }
  }
  if (!closed) { const c = A[cnt - 1]; anchorAt.push(xs.length); xs.push(c.x); ys.push(c.y); cs.push(1); }
  const p = measure(polyFrom(xs, ys, cs, closed));
  p.anchorFrac = anchorAt.map((i) => (p.L > 0 ? p.s[i] / p.L : 0));
  if (closed) p.anchorFrac.push(1);
  return p;
}

// ── Warp (AE order: Offset → Zig Zag → Wiggle → Wave) ───────────────────────
const pinEnv = (s, L, closed, on) => {
  if (!on || closed) return 1;
  const edge = Math.min(L * 0.18, 140);
  return smooth01(clamp01(s / edge)) * smooth01(clamp01((L - s) / edge));
};
// Seamless noise on a loop: cross-fade the tail into the noise that continues s = 0.
function loopNoise(p, s, lam, tt, seed) {
  const a = noiseST(s / lam, tt, seed);
  if (!p.closed || s < p.L - lam) return a;
  return lerp(a, noiseST((s - p.L) / lam, tt, seed), smooth01((s - (p.L - lam)) / lam));
}
function zigzag(p, size, ridges, mode, phase) {
  let R = Math.max(1, Math.round(ridges));
  if (p.closed && R % 2) R += 1;
  const lam = p.L / R;
  if (mode === 'smooth') {
    const q = resample(p, Math.min(3, lam / 14));
    return displace(q, (s) => size * Math.sin(Math.PI * (s / lam + phase)));
  }
  normals(p);
  const tri = (x) => { const m = ((x % 2) + 2) % 2; return m < 0.5 ? 2 * m : m < 1.5 ? 2 - 2 * m : 2 * m - 4; };
  const list = [];
  if (!p.closed) list.push(0);
  for (let k = Math.floor(phase) - 1; list.length < 20000; k += 1) {
    const s = (k + 0.5 - phase) * lam;
    if (s >= p.L - 1e-6) break;
    if (s > 1e-6 || (p.closed && s >= 0)) list.push(s);
  }
  if (!p.closed) list.push(p.L);
  const xs = []; const ys = []; const cs = [];
  for (const s of list) {
    const q = locate(p, s); const d = size * tri(s / lam + phase);
    xs.push(q.x + q.nx * d); ys.push(q.y + q.ny * d); cs.push(1);
  }
  const out = measure(polyFrom(xs, ys, cs, p.closed));
  out.anchorFrac = p.anchorFrac;
  return resample(out, 4);
}
function warpPath(pIn, warp, brush, t) {
  let p = pIn;
  if (!warp) return p;
  const tw = brush && brush.boil > 0 ? Math.floor(t * brush.boil) / brush.boil : t;
  const seed = brush ? brush.seed : 7;
  if (Math.abs(warp.offset) > 0.01) p = displace(p, () => warp.offset);
  if (warp.zigzagSize > 0.01) p = zigzag(p, warp.zigzagSize, warp.zigzagRidges, warp.zigzagPoints, warp.zigzagSpeed * t);
  if (warp.wiggleSize > 0.01) {
    const lam = 1000 / Math.max(0.5, warp.wiggleDetail);
    const q = resample(p, Math.min(4, lam / 10));
    p = displace(q, (s) => warp.wiggleSize * loopNoise(q, s, lam, tw * warp.wiggleRate, 1000 + seed) * pinEnv(s, q.L, q.closed, warp.wigglePinEnds));
  }
  if (warp.waveAmplitude > 0.01) {
    let lam = Math.max(10, warp.waveLength);
    if (p.closed) lam = p.L / Math.max(1, Math.round(p.L / lam));
    const q = resample(p, Math.min(4, lam / 16));
    p = displace(q, (s) => warp.waveAmplitude * Math.sin((TAU * (s - warp.waveSpeed * t)) / lam) * pinEnv(s, q.L, q.closed, warp.wavePinEnds));
  }
  return p;
}

// ── Copies ──────────────────────────────────────────────────────────────────
function copyOrder(copies, c, count) {
  if (copies.order === 'reverse') return count - 1 - c;
  if (copies.order === 'center') return Math.abs(c - (count - 1) / 2);
  return c;
}
function makeCopies(p, copies, box) {
  const count = copies ? Math.max(1, Math.round(copies.count)) : 1;
  const out = [];
  for (let c = 0; c < count; c += 1) {
    const parallel = !copies || copies.mode === 'parallel';
    const rank = count > 1 ? (parallel ? Math.abs(c - (count - 1) / 2) / ((count - 1) / 2) : c / (count - 1)) : 0;
    let q = p;
    let scale = 1;
    if (count > 1 && parallel) {
      const o = (c - (count - 1) / 2) * copies.spacing;
      if (Math.abs(o) > 0.01) q = displace(p, () => o);
    } else if (count > 1 && c > 0) {
      scale = (copies.scale / 100) ** c;
      const rot = (copies.rotate * c * Math.PI) / 180;
      const cs = Math.cos(rot) * scale; const sn = Math.sin(rot) * scale;
      const tx = copies.moveX * c; const ty = copies.moveY * c;
      q = mkPoly(p.n, p.closed); q.corner.set(p.corner); q.anchorFrac = p.anchorFrac;
      for (let i = 0; i < p.n; i += 1) {
        const dx = p.x[i] - box.cx; const dy = p.y[i] - box.cy;
        q.x[i] = box.cx + dx * cs - dy * sn + tx; q.y[i] = box.cy + dx * sn + dy * cs + ty;
      }
      measure(q);
    }
    out.push({
      poly: q, index: c, count,
      wMul: 1 - ((copies?.widthFalloff || 0) / 100) * rank,
      aMul: 1 - ((copies?.opacityFalloff || 0) / 100) * rank,
      order: copies ? copyOrder(copies, c, count) : 0,
      scale,
    });
  }
  return out;
}

// ── Trim ────────────────────────────────────────────────────────────────────
function trimRanges(p, tr, each) {
  const L = p.L; const out = [];
  let lo = Math.min(tr.a, tr.b); let hi = Math.max(tr.a, tr.b);
  if (!p.closed) { lo = clamp01(lo); hi = clamp01(hi); }
  if (hi - lo < 1e-5) return out;
  if (!each) {
    if (p.closed) { let x = lo + tr.o; x -= Math.floor(x); out.push([x * L, (x + hi - lo) * L]); } else {
      const x = clamp01(lo + tr.o); const y = clamp01(hi + tr.o);
      if (y - x > 1e-5) out.push([x * L, y * L]);
    }
    return out;
  }
  const F = p.anchorFrac || [0, 1];
  for (let k = 0; k + 1 < F.length; k += 1) {
    const s0 = F[k] * L; const len = (F[k + 1] - F[k]) * L;
    if (len < 0.5) continue;
    const x = s0 + clamp01(lo + tr.o) * len; const y = s0 + clamp01(hi + tr.o) * len;
    if (y - x > 0.01) out.push([x, y]);
  }
  return out;
}

// ── Dashes: anchored to the path, so a draw-on reveals them in place ─────────
export function strokeDashPattern(line) {
  const w = Math.max(0.5, line.width);
  if (line.dash === 'dashed') return [w * 2.4, w * 1.8];
  if (line.dash === 'dotted') return [0, w * 2];
  if (line.dash === 'custom') {
    const p = line.dashPattern || [];
    const out = [];
    for (let i = 0; i + 1 < 4; i += 2) if ((p[i] || 0) > 0 || (p[i + 1] || 0) > 0) out.push(Math.max(0, p[i] || 0), Math.max(0, p[i + 1] || 0));
    return out;
  }
  return null;
}
function dashPieces(ranges, line, L, closed, t) {
  const out = [];
  const pat = strokeDashPattern(line);
  const total0 = pat ? pat.reduce((a, c) => a + c, 0) : 0;
  if (!pat || !pat.length || total0 < 1) {
    for (const r of ranges) out.push({ s0: r[0], s1: r[1], r0: r[0], r1: r[1], d0: r[0], d1: r[1] });
    return out;
  }
  let scale = 1;
  if (line.dashFit) {
    if (closed) { const k = Math.max(1, Math.round(L / total0)); scale = L / (k * total0); } else {
      let k = Math.max(0, Math.round((L - pat[0]) / total0));
      // a path shorter than half a repeat of a dot pattern (first dash 0) would fit
      // zero repeats of nothing — keep one, i.e. a dot at each end
      if (k * total0 + pat[0] < 1e-6) k = 1;
      scale = L / (k * total0 + pat[0]);
    }
  }
  const T = total0 * scale; const off = (line.dashOffset || 0) + (line.dashSpeed || 0) * t;
  for (const [a, c] of ranges) {
    for (let k = Math.floor((a - off) / T); out.length <= 6000; k += 1) {
      const base = off + k * T;
      if (base >= c) break;
      let pos = base;
      for (let j = 0; j < pat.length; j += 2) {
        const ds = pos; const de = pos + pat[j] * scale; pos = de + pat[j + 1] * scale;
        const x = Math.max(ds, a); const y = Math.min(de, c);
        // a zero-length dash is a dot (round / square ends), as in AE
        if (y - x > 0.05 || (pat[j] === 0 && ds >= a && ds <= c)) out.push({ s0: x, s1: Math.max(x, y), r0: a, r1: c, d0: ds, d1: de });
      }
    }
  }
  return out;
}

// ── Piece extraction (closed paths unrolled to two laps) ─────────────────────
function extract(p, s0, s1) {
  const cnt = p.n; const L = p.L;
  const S = (i) => (p.closed ? p.s[i % cnt] + Math.floor(i / cnt) * L : p.s[i]);
  const lastI = p.closed ? 2 * cnt : cnt - 1;
  let lo = 0; let hi = lastI;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S(mid) <= s0) lo = mid; else hi = mid; }
  const xs = []; const ys = []; const ss = []; const cs = [];
  // a cut that lands exactly on a vertex keeps its corner flag (a closed path's seam)
  const at = (s) => {
    const q = locate(p, s);
    xs.push(q.x); ys.push(q.y); ss.push(s);
    cs.push(q.f < 1e-6 ? p.corner[q.i] : q.f > 1 - 1e-6 ? p.corner[q.j] : 0);
  };
  at(s0);
  for (let i = lo + 1; i <= lastI && S(i) < s1; i += 1) {
    const s = S(i);
    if (s - ss[ss.length - 1] < 0.02) continue;
    xs.push(p.x[i % cnt]); ys.push(p.y[i % cnt]); ss.push(s); cs.push(p.corner[i % cnt]);
  }
  if (s1 - ss[ss.length - 1] > 0.02) at(s1);
  return { x: xs, y: ys, s: ss, c: cs };
}

// ── Width along the stroke ──────────────────────────────────────────────────
export const STROKE_PROFILE_FNS = {
  lens: (x) => Math.sin(Math.PI * x) ** 0.7,
  bulge: (x) => 0.3 + 0.7 * Math.sin(Math.PI * x),
  taperEnd: (x) => (1 - x) ** 0.8,
  taperStart: (x) => x ** 0.8,
  fishtail: (x) => 0.22 + 0.78 * Math.abs(2 * x - 1) ** 1.6,
  spindle: (x) => Math.min(1, Math.sin(Math.PI * x) * 1.8),
  teardrop: (x) => Math.min(1, 2.6 * Math.sqrt(Math.max(0, x)) * (1 - x)),
  beads: (x) => Math.abs(Math.sin(Math.PI * x)) ** 0.5,
  pulse: (x) => 0.25 + 0.75 * Math.exp(-(((x - 0.5) / 0.12) ** 2)),
  steps: (x) => 0.25 + (0.75 * Math.floor(x * 4 + 0.5)) / 4,
};
// Monotone cubic (Fritsch–Carlson) through the custom width points.
const customCache = { key: '', fn: null };
export function strokeCustomProfile(pts) {
  const key = JSON.stringify(pts);
  if (customCache.key === key) return customCache.fn;
  const P2 = pts.slice().sort((a, c) => a.x - c.x); const cnt = P2.length;
  const d = []; const m = new Array(cnt).fill(0);
  for (let i = 0; i < cnt - 1; i += 1) d.push((P2[i + 1].y - P2[i].y) / Math.max(1e-6, P2[i + 1].x - P2[i].x));
  m[0] = d[0] || 0; m[cnt - 1] = d[cnt - 2] || 0;
  for (let i = 1; i < cnt - 1; i += 1) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < cnt - 1; i += 1) {
    if (Math.abs(d[i]) < 1e-9) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i]; const c = m[i + 1] / d[i]; const h = a * a + c * c;
    if (h > 9) { const k = 3 / Math.sqrt(h); m[i] = k * a * d[i]; m[i + 1] = k * c * d[i]; }
  }
  const fn = (x) => {
    if (x <= P2[0].x) return P2[0].y;
    if (x >= P2[cnt - 1].x) return P2[cnt - 1].y;
    let i = 0; while (i < cnt - 2 && x > P2[i + 1].x) i += 1;
    const h = P2[i + 1].x - P2[i].x; const t = (x - P2[i].x) / h; const t2 = t * t; const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * P2[i].y + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * P2[i + 1].y + (t3 - t2) * h * m[i + 1];
  };
  customCache.key = key; customCache.fn = fn;
  return fn;
}
export function strokeProfileFn(profile) {
  if (profile.preset === 'custom' && profile.points) return strokeCustomProfile(profile.points);
  return STROKE_PROFILE_FNS[profile.preset] || STROKE_PROFILE_FNS.lens;
}
function profileAt(profile, u, t) {
  if (!profile) return 1;
  const fn = strokeProfileFn(profile);
  const R = Math.max(1, profile.repeat); const ph = profile.offset / 100 + profile.flow * t;
  let x = u * R + ph;
  x = R > 1 || ph !== 0 ? x - Math.floor(x) : clamp01(x);
  const m = profile.min / 100;
  return m + (1 - m) * clamp01(fn(x));
}
function taperAt(taper, u) {
  if (!taper) return 1;
  let ls = taper.startLength / 100; let le = taper.endLength / 100;
  const sum = ls + le; if (sum > 1) { ls /= sum; le /= sum; }
  let m = 1;
  if (ls > 0 && u < ls) { let x = clamp01(u / ls); x = lerp(x, Math.sin((x * Math.PI) / 2), taper.startEase / 100); m *= lerp(taper.startWidth / 100, 1, x); }
  if (le > 0 && u > 1 - le) { let x = clamp01((1 - u) / le); x = lerp(x, Math.sin((x * Math.PI) / 2), taper.endEase / 100); m *= lerp(taper.endWidth / 100, 1, x); }
  return m;
}
function fadeAt(paint, u) {
  if (!paint) return 1;
  let a = 1;
  if (paint.fadeIn > 0) a *= smooth01(clamp01(u / (paint.fadeIn / 100)));
  if (paint.fadeOut > 0) a *= smooth01(clamp01((1 - u) / (paint.fadeOut / 100)));
  return a;
}
const domainU = (mode, s, L, closed, pc) => {
  if (mode === 'trim') return clamp01((s - pc.r0) / Math.max(1e-6, pc.r1 - pc.r0));
  if (mode === 'dash') return clamp01((s - pc.d0) / Math.max(1e-6, pc.d1 - pc.d0));
  const w = closed ? ((s % L) + L) % L : s;
  return L > 0 ? clamp01(w / L) : 0;
};
// Brush noise along the path. On a closed path it wraps: the last stretch cross-fades
// into the noise that continues from s = 0, so the seam shows no step in width.
function pathFbm(F, s, scale, off, seed) {
  if (!F.closed || !(F.L > 0)) return fbm1(s / scale + off, seed);
  const w = ((s % F.L) + F.L) % F.L;
  const a = fbm1(w / scale + off, seed);
  const lam = Math.min(scale * 2, F.L / 2);
  if (w < F.L - lam) return a;
  return lerp(a, fbm1((w - F.L) / scale + off, seed), smooth01((w - (F.L - lam)) / lam));
}
// One sample's half-widths (left, right), paint u and alpha.
function sampleWidth(C, F, s, tx, ty, pc) {
  const follow = C.taper ? C.taper.follow : 'trim';
  const uS = domainU(follow, s, F.L, F.closed, pc);
  let w = F.baseW * taperAt(C.taper, uS) * profileAt(C.profile, uS, F.t);
  const wv = C.widthWave;
  if (wv && wv.amount > 0) {
    // a closed path fits a whole number of waves, so the seam doesn't break one
    let lam = Math.max(2, wv.wavelength);
    if (F.closed && F.L > 0) lam = F.L / Math.max(1, Math.round(F.L / lam));
    const ph = TAU * (s / lam) + (wv.phase * Math.PI) / 180 + TAU * wv.speed * F.t;
    w *= 1 - (wv.amount / 100) * (0.5 - 0.5 * Math.cos(ph));
  }
  let hl = w / 2; let hr = w / 2;
  const br = C.brush;
  if (br) {
    if (br.nib === 'calligraphic') {
      const r = br.nibRoundness / 100; const th = Math.atan2(ty, tx); const al = (br.nibAngle * Math.PI) / 180;
      const k = r + (1 - r) * Math.abs(Math.sin(th - al));
      hl *= k; hr *= k;
    }
    if (br.pressure > 0) {
      const k = clamp(1 + (br.pressure / 100) * 1.4 * pathFbm(F, s, Math.max(5, br.pressureScale), F.boilStep * 13.1, br.seed + 7), 0.04, 2.2);
      hl *= k; hr *= k;
    }
    if (br.rough > 0) {
      const sc = Math.max(1, br.roughScale); const amp = (br.rough / 100) * 0.9;
      hl *= Math.max(0, 1 + amp * pathFbm(F, s, sc, F.boilStep * 7.7, br.seed + 101));
      hr *= Math.max(0, 1 + amp * pathFbm(F, s, sc, F.boilStep * 7.7, br.seed + 202));
    }
  }
  return { hl, hr, pu: domainU(C.paint ? C.paint.span : 'path', s, F.L, F.closed, pc), al: fadeAt(C.paint, uS) };
}
// The widest a stroke can get relative to its base width (pressure and rough can
// push past 1; everything else only narrows). Used for the plate padding.
function widthGrowth(C) {
  let k = 1;
  if (C.brush) {
    if (C.brush.pressure > 0) k *= Math.min(2.2, 1 + (C.brush.pressure / 100) * 1.4);
    if (C.brush.rough > 0) k *= 1 + (C.brush.rough / 100) * 0.9;
  }
  return k;
}

// ── Geometry buffers ────────────────────────────────────────────────────────
// Ribbon vertex: x, y, e (px to the side edge), ec (px to a flat end), k (0 centre
// → 1 edge, for the core), pu (paint u), al (alpha) — 7 floats, plate px.
// Instance: cx, cy, hx, hy, rot, shape, param, pu, al — 9 floats. Shapes are SDFs:
// 0 circle · 1 ring · 2 box · 3 diamond · 4 triangle · 5 chevron · 6 star · 7 stealth · 8 heart · 9 cross
export const STROKE_RIBBON_STRIDE = 7;
export const STROKE_INSTANCE_STRIDE = 9;
const RS = STROKE_RIBBON_STRIDE; const IS = STROKE_INSTANCE_STRIDE;
function mkBuf(stride) { return { a: new Float32Array(stride * 1024), n: 0, stride }; }
function reserve(buf, count) {
  const need = (buf.n + count) * buf.stride;
  if (need <= buf.a.length) return;
  const na = new Float32Array(Math.max(need, buf.a.length * 2)); na.set(buf.a.subarray(0, buf.n * buf.stride)); buf.a = na;
}
function newGeom(px) { return { rib: mkBuf(RS), inst: mkBuf(IS), f: 1 / px, px }; }
function rv(G, x, y, ed, ec, k, pu, al) {
  const buf = G.rib; const o = buf.n * RS; const a = buf.a;
  a[o] = x; a[o + 1] = y; a[o + 2] = ed; a[o + 3] = ec; a[o + 4] = k; a[o + 5] = pu; a[o + 6] = al; buf.n += 1;
}
function inst(G, cx, cy, hx, hy, rot, shape, param, pu, al) {
  const buf = G.inst; reserve(buf, 1);
  const o = buf.n * IS; const a = buf.a;
  a[o] = cx; a[o + 1] = cy; a[o + 2] = hx; a[o + 3] = hy; a[o + 4] = rot; a[o + 5] = shape; a[o + 6] = param; a[o + 7] = pu; a[o + 8] = al; buf.n += 1;
}
// Anything thinner than a raster pixel is drawn one pixel wide and faded instead.
const hairAlpha = (G, h) => Math.min(1, h * 2 * G.px);
const hairMin = (G, h) => Math.max(h, 0.5 / G.px);
// One half of one segment: centre line A→B, pushed out along ±normal.
function halfQuad(G, ax, ay, anx, any, ah, aec, apu, aal, bx, by, bnx, bny, bh, bec, bpu, bal) {
  const f = G.f;
  const ha = hairMin(G, ah); const hb = hairMin(G, bh);
  const oax = ax + anx * (ha + f); const oay = ay + any * (ha + f);
  const obx = bx + bnx * (hb + f); const oby = by + bny * (hb + f);
  const ka = (ha + f) / ha; const kb = (hb + f) / hb;
  const aa = aal * hairAlpha(G, ah); const ba = bal * hairAlpha(G, bh);
  reserve(G.rib, 6);
  rv(G, ax, ay, ha, aec, 0, apu, aa); rv(G, oax, oay, -f, aec, ka, apu, aa); rv(G, obx, oby, -f, bec, kb, bpu, ba);
  rv(G, ax, ay, ha, aec, 0, apu, aa); rv(G, obx, oby, -f, bec, kb, bpu, ba); rv(G, bx, by, hb, bec, 0, bpu, ba);
}
// Fan from the corner vertex over outer points (bevel / miter corner fill).
function wedge(G, vx, vy, h, pts, pu, al) {
  const hh = hairMin(G, h); const a = al * hairAlpha(G, h); const k = (hh + G.f) / hh;
  reserve(G.rib, 3 * (pts.length - 1));
  for (let i = 0; i + 1 < pts.length; i += 1) {
    rv(G, vx, vy, hh, 1e4, 0, pu, a); rv(G, pts[i][0], pts[i][1], -G.f, 1e4, k, pu, a); rv(G, pts[i + 1][0], pts[i + 1][1], -G.f, 1e4, k, pu, a);
  }
}
const disc = (G, x, y, r, pu, al) => { const rr = hairMin(G, r); inst(G, x, y, rr, rr, 0, 0, 0, pu, al * hairAlpha(G, r)); };
const MITER_LIMIT = 10; // canvas' default, so a miter looks the same as the plain stroke's
// A trimmed / dashed piece → ribbon + joins + caps. `opt.loop`: the piece is a
// whole closed path (its last point repeats its first) — the seam is then an
// ordinary vertex joined like any other, with no caps.
function emitPiece(G, pc, W, opt) {
  const loop = !!opt.loop && pc.x.length >= 4;
  const m = loop ? pc.x.length - 1 : pc.x.length; // vertices
  const hAvg = (i) => (W.hl[i] + W.hr[i]) / 2;
  if (m < 2 || opt.s1 - opt.s0 < 0.3) {
    if (opt.cap !== 'butt' && m >= 1) {
      if (opt.cap === 'square') inst(G, pc.x[0], pc.y[0], hairMin(G, hAvg(0)), hairMin(G, hAvg(0)), 0, 2, 0, W.pu[0], W.al[0]);
      else disc(G, pc.x[0], pc.y[0], hAvg(0), W.pu[0], W.al[0]);
    }
    return;
  }
  const segs = loop ? m : m - 1;
  const next = (i) => (loop ? (i + 1) % m : i + 1);
  // the segment that ends at / starts from vertex v (-1 = none: an open end)
  const segIn = (v) => (loop ? (v - 1 + m) % m : v - 1);
  const segOut = (v) => (loop || v < m - 1 ? v : -1);
  const dx = new Float64Array(segs); const dy = new Float64Array(segs);
  let lx = 1; let ly = 0;
  for (let i = 0; i < segs; i += 1) {
    const j = next(i);
    let x = pc.x[j] - pc.x[i]; let y = pc.y[j] - pc.y[i]; const l = Math.hypot(x, y);
    if (l > 1e-6) { x /= l; y /= l; lx = x; ly = y; } else { x = lx; y = ly; }
    dx[i] = x; dy[i] = y;
  }
  const butt = opt.cap === 'butt' && !loop;
  const ecAt = (i) => (butt ? Math.min(pc.s[i] - opt.s0, opt.s1 - pc.s[i]) : 1e4);
  const interior = (v) => segIn(v) >= 0 && segOut(v) >= 0;
  const cornerAt = new Uint8Array(m);
  for (let v = 0; v < m; v += 1) {
    if (!interior(v)) continue;
    const a = segIn(v); const c = segOut(v);
    const turn = Math.acos(clamp(dx[a] * dx[c] + dy[a] * dy[c], -1, 1));
    if ((pc.c[v] && turn > 0.03) || turn > 0.6) cornerAt[v] = 1;
    // a tight bend folds the inner side of the strip — a disc keeps it covered
    else if (turn * Math.max(W.hl[v], W.hr[v]) * G.px > 0.9) disc(G, pc.x[v], pc.y[v], hAvg(v), W.pu[v], W.al[v]);
  }
  // Left normal of segment i at its start (end=0) or end (end=1), miter-scaled on smooth vertices.
  const nrm = (i, end) => {
    const v = end ? next(i) : i;
    let nx = dy[i]; let ny = -dx[i]; let sc = 1;
    const other = end ? segOut(v) : segIn(v);
    if (interior(v) && !cornerAt[v] && other >= 0) {
      let ax = nx + dy[other]; let ay = ny - dx[other]; const l = Math.hypot(ax, ay) || 1; ax /= l; ay /= l;
      sc = 1 / Math.max(0.6, ax * nx + ay * ny); nx = ax; ny = ay;
    }
    return [nx * sc, ny * sc];
  };
  for (let i = 0; i < segs; i += 1) {
    const na = nrm(i, 0); const nb = nrm(i, 1); const j = next(i);
    halfQuad(G, pc.x[i], pc.y[i], na[0], na[1], W.hl[i], ecAt(i), W.pu[i], W.al[i], pc.x[j], pc.y[j], nb[0], nb[1], W.hl[j], ecAt(j), W.pu[j], W.al[j]);
    halfQuad(G, pc.x[i], pc.y[i], -na[0], -na[1], W.hr[i], ecAt(i), W.pu[i], W.al[i], pc.x[j], pc.y[j], -nb[0], -nb[1], W.hr[j], ecAt(j), W.pu[j], W.al[j]);
  }
  for (let v = 0; v < m; v += 1) {
    if (!cornerAt[v]) continue;
    const vx = pc.x[v]; const vy = pc.y[v];
    if (opt.join === 'round') { disc(G, vx, vy, hAvg(v), W.pu[v], W.al[v]); continue; }
    const a = segIn(v); const c = segOut(v);
    const n1x = dy[a]; const n1y = -dx[a]; const n2x = dy[c]; const n2y = -dx[c];
    const sg = n1x * dx[c] + n1y * dy[c] > 0 ? -1 : 1; // the outer side of the turn
    const h = sg > 0 ? W.hl[v] : W.hr[v]; const hh = hairMin(G, h) + G.f;
    const o1 = [vx + sg * n1x * hh, vy + sg * n1y * hh]; const o2 = [vx + sg * n2x * hh, vy + sg * n2y * hh];
    let mx = n1x + n2x; let my = n1y + n2y; const ml = Math.hypot(mx, my) || 1; mx /= ml; my /= ml;
    const cosH = mx * n1x + my * n1y;
    if (opt.join === 'miter' && cosH > 1e-3 && 1 / cosH <= MITER_LIMIT) {
      wedge(G, vx, vy, h, [o1, [vx + (sg * mx * hh) / cosH, vy + (sg * my * hh) / cosH], o2], W.pu[v], W.al[v]);
    } else wedge(G, vx, vy, h, [o1, o2], W.pu[v], W.al[v]);
  }
  if (loop) return;
  for (const [i, tx, ty] of [[0, -dx[0], -dy[0]], [m - 1, dx[m - 2], dy[m - 2]]]) {
    const h = hAvg(i);
    if (opt.cap === 'round') disc(G, pc.x[i], pc.y[i], h, W.pu[i], W.al[i]);
    else if (opt.cap === 'square') {
      inst(G, pc.x[i] + (tx * h) / 2, pc.y[i] + (ty * h) / 2, hairMin(G, h / 2), hairMin(G, h), Math.atan2(ty, tx), 2, 0, W.pu[i], W.al[i] * hairAlpha(G, h));
    } else {
      // flat end: a one-pixel feather strip past it, so the cut is anti-aliased too
      const ex = pc.x[i] + tx * G.f; const ey = pc.y[i] + ty * G.f;
      const nn = i === 0 ? [-ty, tx] : [ty, -tx];
      halfQuad(G, ex, ey, nn[0], nn[1], W.hl[i], -G.f, W.pu[i], W.al[i], pc.x[i], pc.y[i], nn[0], nn[1], W.hl[i], 0, W.pu[i], W.al[i]);
      halfQuad(G, ex, ey, -nn[0], -nn[1], W.hr[i], -G.f, W.pu[i], W.al[i], pc.x[i], pc.y[i], -nn[0], -nn[1], W.hr[i], 0, W.pu[i], W.al[i]);
    }
  }
}

// ── Arrowheads ──────────────────────────────────────────────────────────────
// Pushes the instance and returns how far the stroke must pull back so the line
// never pokes through the tip. dir = unit vector pointing OUT of the stroke.
// `al` is the stroke's own alpha (fades) where the head meets it. The pull-back is
// the same whether or not the head is visible, so a fade never moves the line's end.
function marker(G, type, x, y, dirx, diry, S, width, g, pu, al) {
  if (type === 'none' || g <= 0.001) return 0;
  const rot = Math.atan2(diry, dirx); const hx = S * 0.5 * g; const hy = S * 0.42 * g;
  const put = al > 0.001 ? (...a) => inst(G, ...a, pu, al) : () => {};
  switch (type) {
    case 'arrow': put(x - dirx * hx, y - diry * hx, hx, hy, rot, 4, 0); return hx;
    case 'stealth': put(x - dirx * hx, y - diry * hx, hx, hy, rot, 7, 0); return hx * 0.9;
    case 'open': { const th = Math.max(2, width * 0.8) * g; put(x - dirx * hx, y - diry * hx, hx, hy, rot, 5, th); return th * 0.35; }
    case 'circle': { const r = S * 0.3 * g; put(x, y, r, r, 0, 0, 0); return 0; }
    case 'ring': { const r = S * 0.34 * g; const th = Math.max(2, width * 0.6) * g; put(x, y, r, r, 0, 1, th); return r - th * 0.5; }
    case 'square': { const r = S * 0.27 * g; put(x, y, r, r, rot, 2, 0); return 0; }
    case 'diamond': put(x, y, S * 0.4 * g, S * 0.3 * g, rot, 3, 0); return 0;
    case 'bar': put(x, y, Math.max(1, width * 0.3) * g, S * 0.46 * g, rot, 2, 0); return 0;
    default: return 0;
  }
}

// ── Stamps (scatter brush) ──────────────────────────────────────────────────
const STAMP_SDF = { dot: 0, ring: 1, square: 2, diamond: 3, triangle: 4, chevron: 5, star: 6, bar: 2, heart: 8, cross: 9 };
function emitStamps(G, p, ranges, C, F) {
  const st = C.stamps; const sp = Math.max(2, st.spacing); const off = st.offset + st.speed * F.t;
  const shape = STAMP_SDF[st.shape] ?? 0;
  let count = 0;
  for (const [a, c] of ranges) {
    const pc = { r0: a, r1: c, d0: a, d1: c };
    for (let k = Math.ceil((a - off) / sp); count <= 5000; k += 1) {
      const s = off + k * sp;
      if (s > c) break;
      const q = locate(p, s);
      const W = sampleWidth(C, F, s, q.tx, q.ty, pc);
      const wf = st.followWidth ? (W.hl + W.hr) / Math.max(0.01, F.baseW) : 1;
      const r1 = hash1(k, st.seed * 3 + 1); const r2 = hash1(k, st.seed * 5 + 2); const r3 = hash1(k, st.seed * 7 + 3);
      const size = (st.size / 2) * wf * (1 + (st.jitterSize / 100) * (r1 * 2 - 1));
      if (size < 0.2) continue;
      let rot = st.rotation === 'fixed' ? 0 : st.rotation === 'random' ? r2 * TAU : Math.atan2(q.ty, q.tx);
      rot += (st.angle * Math.PI) / 180 + ((st.jitterRotation * Math.PI) / 180) * (r2 * 2 - 1);
      const jo = st.jitterOffset * (r3 * 2 - 1);
      const bar = st.shape === 'bar';
      const hx = bar ? Math.max(0.75, size * 0.18) : size;
      const hy = size * (st.aspect / 100);
      const param = shape === 1 || shape === 5 ? Math.max(1.5, size * 0.28) : st.shape === 'square' ? size * 0.18 : 0;
      inst(G, q.x + q.nx * jo, q.y + q.ny * jo, hx, hy, rot, shape, param, W.pu, W.al);
      count += 1;
    }
  }
  return count;
}

// ── Scene ───────────────────────────────────────────────────────────────────
/**
 * Build everything one stroke draws, in plate px.
 *   points / closed — the unit-box outline (shapePath model)
 *   box — { cx, cy, w, h } of the shape in plate px
 *   line — resolveLineSettings() output (with `cards` from resolveLineStroke)
 *   time — clip-local seconds (dash march, flows, wiggle, boil…)
 *   px — raster pixels per plate pixel (feathering is one RASTER pixel)
 *   copyTrims — optional per-copy {start,end,offset} for a keyframed trim + stagger
 * Returns { layers: [{ G, alpha, paint, add }], stats }. Each layer is one union
 * (drawn with MAX blending), layers composite in order.
 */
export function buildStrokeScene({ points, closed, box, line, time = 0, px = 1, copyTrims = null }) {
  const C = line.cards || {};
  const t = Math.max(0, time || 0);
  const stats = { samples: 0, pieces: 0, tris: 0, instances: 0 };
  const layers = [];
  if (!Array.isArray(points) || points.length < 2 || !(line.width > 0)) return { layers, stats };
  let A = anchorsPx(points, box);
  if (C.warp && C.warp.roundCorners > 0) A = roundCorners(A, closed, C.warp.roundCorners);
  const step = clamp(3 / Math.max(1, px), 0.75, 3);
  let base = flatten(A, closed, step);
  base = warpPath(base, C.warp, C.brush, t);
  if (C.brush && C.brush.rough > 0) base = resample(base, clamp(C.brush.roughScale / 4, 0.5, step));
  normals(base);
  stats.samples = base.n;
  if (!(base.L > 0.01)) return { layers, stats };
  const boilStep = C.brush && C.brush.boil > 0 ? Math.floor(t * C.brush.boil) : 0;
  const copies = makeCopies(base, C.copies, box);
  const dashed = !!strokeDashPattern(line);
  // dotted needs a round end to be dots at all, as in the plain stroke
  let dashCap = line.dashCap && line.dashCap !== 'line' ? line.dashCap : line.cap;
  if (line.dash === 'dotted' && dashCap === 'butt') dashCap = 'round';
  const pieceCap = dashed ? dashCap : line.cap;
  const paintMode = C.paint ? C.paint.mode : 'fill';
  const baseTrim = { a: line.trimStart / 100, b: line.trimEnd / 100, o: line.trimOffset / 100 };

  const strokeLayer = (poly, F, ranges, markerMode, alpha, paint) => {
    const G = newGeom(px); const MG = markerMode === 'inset' ? newGeom(px) : G;
    const rs = ranges.map((r) => r.slice());
    const ends = C.ends;
    if (markerMode && ends && (ends.start !== 'none' || ends.end !== 'none')) {
      const S = F.baseW * ends.size; const follow = ends.followTrim && markerMode === 'draw';
      const spots = follow ? rs.map((r) => [r[0], r[1], r]) : [[0, poly.L, null]];
      for (const [r0, r1, rr] of spots) {
        const g = ends.grow && follow ? smooth01(clamp01((r1 - r0) / (S * 1.5))) : 1;
        const span = { r0, r1, d0: r0, d1: r1 };
        const tip = (s, back, type) => {
          const q = locate(poly, s); const qb = locate(poly, s + back);
          let tx = q.x - qb.x; let ty = q.y - qb.y; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
          // the head carries the stroke's fade from where it meets the shaft
          const base = clamp(s + (back < 0 ? -1 : 1) * S * 0.5 * g, r0, r1);
          const al = fadeAt(C.paint, domainU(C.taper ? C.taper.follow : 'trim', base, poly.L, poly.closed, span));
          return marker(MG, type, q.x, q.y, tx, ty, S, F.baseW, g, domainU(C.paint ? C.paint.span : 'path', s, poly.L, poly.closed, span), al);
        };
        if (ends.end !== 'none') {
          const ins = tip(r1, -1.5, ends.end);
          if (ins > 0) { if (rr) rr[1] = Math.max(rr[0], rr[1] - ins); else for (const r of rs) if (r[1] > poly.L - ins) r[1] = Math.max(r[0], poly.L - ins); }
        }
        if (ends.start !== 'none') {
          const ins = tip(r0, 1.5, ends.start);
          if (ins > 0) { if (rr) rr[0] = Math.min(rr[1], rr[0] + ins); else for (const r of rs) if (r[0] < ins) r[0] = Math.min(r[1], ins); }
        }
      }
    }
    const pieces = dashPieces(rs.filter((r) => r[1] - r[0] > 0.05), line, poly.L, poly.closed, t);
    stats.pieces += pieces.length;
    for (const pc of pieces) {
      const ex = extract(poly, pc.s0, pc.s1);
      const m = ex.x.length;
      const W = { hl: new Float64Array(m), hr: new Float64Array(m), pu: new Float64Array(m), al: new Float64Array(m) };
      for (let i = 0; i < m; i += 1) {
        const j = Math.min(m - 1, i + 1); const k = Math.max(0, i - 1);
        const tx = ex.x[j] - ex.x[k]; const ty = ex.y[j] - ex.y[k]; const l = Math.hypot(tx, ty) || 1;
        const w = sampleWidth(C, F, ex.s[i], tx / l, ty / l, pc);
        W.hl[i] = w.hl; W.hr[i] = w.hr; W.pu[i] = w.pu; W.al[i] = w.al;
      }
      // an untrimmed, undashed closed path is ONE loop: its seam is joined, not capped
      const loop = poly.closed && !dashed && pc.s1 - pc.s0 >= poly.L - 1e-3;
      emitPiece(G, ex, W, { cap: pieceCap, join: line.join, s0: pc.s0, s1: pc.s1, loop });
    }
    stats.tris += G.rib.n / 3; stats.instances += G.inst.n;
    layers.push({ G, alpha, paint, add: !!(C.copies && C.copies.blend === 'add') });
  };

  const paintFor = (c, count) => {
    const cp = C.copies;
    if (cp && count > 1 && cp.color !== 'same') {
      const cols = cp.colors;
      if (cp.color === 'cycle') return { mode: 'solid', color: cols[c % cols.length] };
      const x = c / (count - 1);
      return { mode: 'solid', color: cols.length < 3 ? mixHex(cols[0], cols[1], x) : x < 0.5 ? mixHex(cols[0], cols[1], x * 2) : mixHex(cols[1], cols[2], x * 2 - 1) };
    }
    return { mode: paintMode };
  };
  const stampLayer = () => {
    const G = newGeom(px);
    const F = { L: base.L, closed: base.closed, t, baseW: line.width, boilStep };
    const tr = copyTrims && copyTrims[0] ? { a: copyTrims[0].start / 100, b: copyTrims[0].end / 100, o: copyTrims[0].offset / 100 } : baseTrim;
    emitStamps(G, base, trimRanges(base, tr, line.trimEach), C, F);
    stats.instances += G.inst.n;
    layers.push({ G, alpha: 1, paint: C.stamps.color ? { mode: 'solid', color: C.stamps.color } : paintFor(0, 1), add: false });
  };
  if (C.stamps && C.stamps.mode === 'below') stampLayer();
  if (!(C.stamps && C.stamps.mode === 'only')) {
    for (const cp of copies) {
      const poly = cp.poly; normals(poly);
      const F = { L: poly.L, closed: poly.closed, t, baseW: line.width * cp.wMul * cp.scale, boilStep };
      const ct = copyTrims && copyTrims[cp.index];
      const tr = ct ? { a: ct.start / 100, b: ct.end / 100, o: ct.offset / 100 } : baseTrim;
      const paint = paintFor(cp.index, cp.count);
      if (line.ghost > 0) strokeLayer(poly, F, [[0, poly.L]], 'inset', (line.ghost / 100) * cp.aMul, paint);
      strokeLayer(poly, F, trimRanges(poly, tr, line.trimEach), 'draw', cp.aMul, paint);
    }
  }
  if (C.stamps && C.stamps.mode !== 'below') stampLayer();
  return { layers, stats };
}

function mixHex(a, c, x) {
  const pa = parseInt(a.slice(1), 16); const pc = parseInt(c.slice(1), 16);
  const ch = (v, s) => (v >> s) & 255;
  const m = (s) => Math.round(lerp(ch(pa, s), ch(pc, s), clamp01(x)));
  return `#${((m(16) << 16) | (m(8) << 8) | m(0)).toString(16).padStart(6, '0')}`;
}

/**
 * The staggered copies' trim times, in seconds after the layer's own: copy `c`
 * plays the keyframed trim `delay` seconds late. Null when there is nothing to
 * stagger (no copies card, no stagger).
 */
export function strokeCopyDelays(line) {
  const cp = line?.cards?.copies;
  if (!cp || !(cp.stagger > 0) || cp.count < 2) return null;
  const count = Math.round(cp.count);
  const out = [];
  for (let c = 0; c < count; c += 1) out.push(copyOrder(cp, c, count) * cp.stagger);
  return out;
}

/**
 * How far past the path outline the drawn stroke can reach, in plate px, beyond
 * `baseReach` (the plain stroke's half width × cap/join factor, which the caller
 * computes with the widest width this stroke can take). Analytic and time-free, so
 * the plate never changes size while an option animates.
 *   box — the shape box in px; bounds — the path's unit bounds (for the repeater).
 */
export function strokeEngineReach(line, baseReachAt, box, bounds) {
  const C = line.cards || {};
  const grow = widthGrowth(C);
  const w = C.warp;
  const disp = w ? Math.abs(w.offset) + w.zigzagSize + w.wiggleSize + w.waveAmplitude : 0;
  // What ONE copy reaches past its own (displaced) outline: the stroke, or its
  // arrowheads, whichever is bigger.
  let local = baseReachAt(line.width * grow);
  if (C.ends && (C.ends.start !== 'none' || C.ends.end !== 'none')) local = Math.max(local, line.width * C.ends.size * 0.55);
  local += disp;
  let reach = local;
  const cp = C.copies;
  if (cp && cp.count > 1) {
    if (cp.mode === 'parallel') reach += ((Math.round(cp.count) - 1) / 2) * Math.abs(cp.spacing);
    else if (box && bounds) {
      // Each copy is the outline transformed — its stroke, arrowheads and warp all
      // scale with it — so measure every copy's bounds against the original box.
      const corners = [[bounds.minX, bounds.minY], [bounds.maxX, bounds.minY], [bounds.maxX, bounds.maxY], [bounds.minX, bounds.maxY]]
        .map(([x, y]) => [x * box.w, y * box.h]);
      for (let c = 1; c < Math.round(cp.count); c += 1) {
        const sc = (cp.scale / 100) ** c; const rot = (cp.rotate * c * Math.PI) / 180;
        const cs = Math.cos(rot) * sc; const sn = Math.sin(rot) * sc;
        let over = 0;
        for (const [x, y] of corners) {
          const X = x * cs - y * sn + cp.moveX * c; const Y = x * sn + y * cs + cp.moveY * c;
          over = Math.max(over, Math.abs(X) - box.w / 2, Math.abs(Y) - box.h / 2);
        }
        reach = Math.max(reach, over + local * sc);
      }
    }
  }
  const st = C.stamps;
  if (st) {
    // stamps ride the base path only (never the copies)
    const half = (st.size / 2) * Math.max(1, st.aspect / 100) * (1 + st.jitterSize / 100) * (st.followWidth ? grow : 1);
    reach = Math.max(reach, half * Math.SQRT2 + st.jitterOffset + disp);
  }
  return reach;
}
