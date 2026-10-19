// Dynamic text placeholders for Text layers: `{{{TYPE:args}}}` tokens in textContent.
//
//   COUNTER   {{{COUNTER:0-100}}}           a number rolling between two values
//   TIMER     {{{TIMER:05:00-00:00}}}       a clock counting down or up
//   CYCLE     {{{CYCLE:fast|simple|yours}}} words taking turns, each held, then rolled
//   SCRAMBLE  {{{SCRAMBLE:Access granted}}} random characters decoding into the text
//   VAR       {{{VAR:product}}}             a project variable (set once, used anywhere)
//   MARKER    {{{MARKER}}}                  the name of the last timeline marker passed
//   TIMECODE  {{{TIMECODE}}}                the playhead time, hh:mm:ss:ff
//   FRAME     {{{FRAME}}}                   the frame number
//
// Two kinds, two passes (Player.jsx, text branch):
//   STATIC   VAR and MARKER expand to plain text before anything else, so they wrap,
//            split into words and style like typed text (expandStaticPlaceholders).
//   UNITS    the rest become ONE Plane-15 private-use character each (a "sentinel")
//            before wrapping, so the word/symbol splitter, the randomizer, the
//            highlight and text on path see a single glyph; the Player's measure/draw
//            helpers hand any string holding a sentinel to the run built here, which
//            measures and paints the unit with whatever font and paint the caller has
//            set on the context (fill, outline, gradient, shadow, unit fonts).
//
// A token that doesn't parse — or a VAR with no value — stays visible as typed.
// Everything is a pure function of (text, settings, time): export renders frames out
// of order, so nothing may carry from one frame to the next.
import {
  COUNTER_DEFAULTS,
  createNumberUnit,
  drawWithAlpha,
  formatCounterValue,
  parseCounterRange,
  parseTimerRange,
  resolveCounterSettings,
} from './textCounter.js';

const SENTINEL_BASE = 0xF0000;
// High surrogate shared by every sentinel (U+F0000..U+F03FF): the cheap "might this
// string hold a unit" test.
const SENTINEL_HIGH = '\uDB80';
const MAX_UNITS = 64;
const TOKEN_RE = /\{\{\{\s*([A-Za-z]+)\s*(?::([^{}]*?))?\s*\}\}\}/g;

// The ƒx picker in TEXT LAYER ▸ Content: what each placeholder does and the token it
// inserts. `example` is dropped at the caret as is — every one renders straight away.
export const PLACEHOLDER_CATALOG = Object.freeze([
  {
    id: 'COUNTER', label: 'Counter', example: '{{{COUNTER:0-100}}}',
    description: 'Counts between two numbers. The format follows how you type them: 1,000-25,000 adds separators, 0.0-9.9 keeps a decimal, 00-59 pads, 10-0 counts down.',
  },
  {
    id: 'TIMER', label: 'Timer', example: '{{{TIMER:00:10-00:00}}}',
    description: 'A clock counting down or up — ss, mm:ss or h:mm:ss, with .s for tenths. Runs in real time; its card sets duration, easing and style. One value (05:00) counts down to zero.',
  },
  {
    id: 'CYCLE', label: 'Word cycle', example: '{{{CYCLE:fast|simple|yours}}}',
    description: 'Words separated by | take turns in the sentence: each one holds, then rolls or fades to the next.',
  },
  {
    id: 'SCRAMBLE', label: 'Scramble', example: '{{{SCRAMBLE:Access granted}}}',
    description: 'Random characters that decode into the text, one by one.',
  },
  {
    id: 'VAR', label: 'Variable', example: '{{{VAR:name}}}',
    description: 'A project variable: set its value once and every text using it updates. Values are edited right under Content.',
  },
  {
    id: 'MARKER', label: 'Marker name', example: '{{{MARKER}}}',
    description: 'The name of the last timeline marker the playhead passed — chapter titles that follow your markers. {{{MARKER:Intro}}} shows Intro before the first one.',
  },
  {
    id: 'TIMECODE', label: 'Timecode', example: '{{{TIMECODE}}}',
    description: 'The playhead time as hh:mm:ss:ff. Add clip for the layer\'s own time, or a format: {{{TIMECODE:clip mm:ss}}}.',
  },
  {
    id: 'FRAME', label: 'Frame number', example: '{{{FRAME}}}',
    description: 'The current frame number. {{{FRAME:clip}}} counts from the layer\'s start.',
  },
]);

export const COUNTER_TOKEN_EXAMPLE = '{{{COUNTER:0-100}}}';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);
const num = (v, fallback, lo, hi) => {
  const n = Number(v);
  return clamp(Number.isFinite(n) ? n : fallback, lo, hi);
};

// ── Settings ──

export const CYCLE_STYLES = ['roll', 'fade', 'blur'];
export const CYCLE_DEFAULTS = Object.freeze({
  textCycleStyle: 'roll',
  textCycleDelay: 0,
  textCycleHold: 1.2,
  textCycleDuration: 0.45,
  textCycleEasing: 'POWER3_OUT',
  textCycleLoop: true,
  textCycleWidth: 'fit',
  textCycleDirection: 'up',
  textCycleStagger: 0.15,
});

export function resolveCycleSettings(item) {
  const d = CYCLE_DEFAULTS;
  const it = item || {};
  return {
    style: CYCLE_STYLES.includes(it.textCycleStyle) ? it.textCycleStyle : d.textCycleStyle,
    delay: num(it.textCycleDelay, d.textCycleDelay, 0, 3600),
    hold: num(it.textCycleHold, d.textCycleHold, 0, 60),
    duration: num(it.textCycleDuration, d.textCycleDuration, 0.05, 10),
    easing: typeof it.textCycleEasing === 'string' && it.textCycleEasing ? it.textCycleEasing : d.textCycleEasing,
    loop: it.textCycleLoop !== false,
    fit: it.textCycleWidth !== 'fixed',
    direction: it.textCycleDirection === 'down' ? -1 : 1,
    stagger: num(it.textCycleStagger, d.textCycleStagger, 0, 10),
  };
}

export const SCRAMBLE_CHARSETS = Object.freeze({
  symbols: '!<>-_\\/[]{}=+*^?#%&@$',
  letters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  binary: '01',
  blocks: '█▓▒░',
});
export const SCRAMBLE_DEFAULTS = Object.freeze({
  textScrambleDelay: 0,
  textScrambleDuration: 1.2,
  textScrambleCharset: 'symbols',
  textScrambleOrder: 'ltr',
  textScrambleRate: 18,
});

export function resolveScrambleSettings(item) {
  const d = SCRAMBLE_DEFAULTS;
  const it = item || {};
  return {
    delay: num(it.textScrambleDelay, d.textScrambleDelay, 0, 3600),
    duration: num(it.textScrambleDuration, d.textScrambleDuration, 0.05, 60),
    charset: Object.hasOwn(SCRAMBLE_CHARSETS, it.textScrambleCharset) ? it.textScrambleCharset : d.textScrambleCharset,
    order: ['ltr', 'rtl', 'random'].includes(it.textScrambleOrder) ? it.textScrambleOrder : d.textScrambleOrder,
    rate: num(it.textScrambleRate, d.textScrambleRate, 1, 60),
  };
}

// ── Parsing ──
//
// A token is `{{{TYPE:body; key=value; key=value}}}`. The body is what the placeholder
// shows (a range, words, text); the options after `;` are its own animation settings,
// written by its card in the PLACEHOLDERS section — only the ones changed from the
// default, so an untouched token stays short. The settings travel with the token:
// copy the text anywhere and the animation comes along.

const TIMECODE_FORMATS = ['hh:mm:ss:ff', 'hh:mm:ss', 'mm:ss:ff', 'mm:ss', 'ss:ff', 'ss'];
const VAR_NAME_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_ .-]{0,39}$/u;
const EASING_VALUE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const KF_ID_RE = /^[a-z0-9]{1,8}$/;

// Option schemas. `num: [min, max]` numbers, `values` enums, `easing` a TransitionEasing
// key written lowercase (power3_out), `kf` a keyframe-track id. The same table drives
// parsing, the card fields and serialization.
export const PLACEHOLDER_OPTIONS = Object.freeze({
  number: {
    style: { values: ['odometer', 'roll', 'count'] },
    start: { num: [0, 3600] },
    duration: { num: [0.05, 36000] },
    easing: { easing: true },
    width: { values: ['fixed', 'fit'] },
    digits: { values: ['tabular', 'natural'] },
    turns: { num: [0, 10], int: true },
    lands: { values: ['left', 'right', 'together'] },
    cascade: { num: [0, 90] },
    direction: { values: ['auto', 'up', 'down'] },
    blur: { num: [0, 100] },
    kf: { kf: true },
  },
  cycle: {
    style: { values: ['roll', 'fade', 'blur'] },
    start: { num: [0, 3600] },
    hold: { num: [0, 60] },
    duration: { num: [0.05, 10] },
    easing: { easing: true },
    width: { values: ['fit', 'fixed'] },
    direction: { values: ['up', 'down'] },
    loop: { values: ['on', 'off'] },
  },
  scramble: {
    start: { num: [0, 3600] },
    duration: { num: [0.05, 60] },
    chars: { values: Object.keys(SCRAMBLE_CHARSETS) },
    order: { values: ['ltr', 'rtl', 'random'] },
    flicker: { num: [1, 60] },
  },
  readout: {},
});

function cleanOption(schema, raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!schema || !v) return null;
  if (schema.values) return schema.values.includes(v) ? v : null;
  if (schema.easing) return EASING_VALUE_RE.test(v) ? v : null;
  if (schema.kf) return KF_ID_RE.test(v) ? v : null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const c = clamp(n, schema.num[0], schema.num[1]);
  return schema.int ? Math.round(c) : Number(c.toFixed(3));
}

function splitBody(rawBody) {
  const parts = String(rawBody ?? '').split(';');
  const main = parts[0].trim();
  const options = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (key) options[key] = part.slice(eq + 1).trim();
  }
  return { main, options };
}

function parseReadoutArgs(body) {
  const words = String(body || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  const format = words.find((w) => TIMECODE_FORMATS.includes(w)) || null;
  const clip = words.includes('clip');
  if (words.some((w) => w !== 'clip' && w !== 'project' && !TIMECODE_FORMATS.includes(w))) return null;
  return { clip, format };
}

// One animated token → its unit description, or null (the token stays as text).
function parseUnit(type, rawBody) {
  const { main, options: rawOptions } = splitBody(rawBody);
  let unit = null;
  switch (type) {
    case 'COUNTER': {
      const spec = parseCounterRange(main);
      unit = spec ? { type: 'number', spec } : null;
      break;
    }
    case 'TIMER': {
      const spec = parseTimerRange(main);
      unit = spec ? { type: 'number', spec } : null;
      break;
    }
    case 'CYCLE': {
      const words = main.split('|').map((w) => w.trim()).filter(Boolean);
      unit = words.length ? { type: 'cycle', words } : null;
      break;
    }
    case 'SCRAMBLE':
      unit = main ? { type: 'scramble', text: main } : null;
      break;
    case 'TIMECODE': {
      const args = parseReadoutArgs(main);
      unit = args ? { type: 'readout', mode: 'timecode', clip: args.clip, format: args.format || 'hh:mm:ss:ff' } : null;
      break;
    }
    case 'FRAME': {
      const args = parseReadoutArgs(main);
      unit = args && !args.format ? { type: 'readout', mode: 'frame', clip: args.clip } : null;
      break;
    }
    default:
      return null;
  }
  if (!unit) return null;
  // Unknown or malformed options are ignored, never fatal: the token still renders.
  const schema = PLACEHOLDER_OPTIONS[unit.type];
  const options = {};
  for (const [k, v] of Object.entries(rawOptions)) {
    const clean = cleanOption(schema[k], v);
    if (clean !== null) options[k] = clean;
  }
  return { ...unit, tokenType: type, main, options };
}

const hasToken = (text) => typeof text === 'string' && text.indexOf('{{{') >= 0;

/**
 * Every animated token of a text, in order: { index, start, end, type, main,
 * options, unit }. `index` is the unit's rank — the key the cards and
 * updatePlaceholderToken use.
 */
export function scanPlaceholders(text) {
  const out = [];
  if (!hasToken(text)) return out;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text))) {
    const unit = parseUnit(m[1].toUpperCase(), m[2]);
    if (!unit) continue;
    out.push({ index: out.length, start: m.index, end: m.index + m[0].length, type: unit.tokenType, main: unit.main, options: unit.options, unit });
    if (out.length >= MAX_UNITS) break;
  }
  TOKEN_RE.lastIndex = 0;
  return out;
}

function formatOption(value) {
  return typeof value === 'number' ? String(Number(value.toFixed(3))) : String(value);
}

export function formatPlaceholderToken(type, main, options = {}) {
  const opts = Object.entries(options)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `; ${k}=${formatOption(v)}`)
    .join('');
  const body = `${main || ''}${opts}`;
  return body ? `{{{${type}:${body}}}}` : `{{{${type}}}}`;
}

/**
 * Rewrite the `index`-th animated token: `main` replaces its body, `options` patches
 * its options (null / undefined removes one). Returns the new text, or the same text
 * when the token is gone.
 */
export function updatePlaceholderToken(text, index, { main, options } = {}) {
  const tok = scanPlaceholders(text).find((t) => t.index === index);
  if (!tok) return text;
  const schema = PLACEHOLDER_OPTIONS[tok.unit.type];
  const next = { ...tok.options };
  for (const [k, v] of Object.entries(options || {})) {
    if (v === null || v === undefined) { delete next[k]; continue; }
    const clean = cleanOption(schema[k], v);
    if (clean !== null) next[k] = clean;
  }
  const token = formatPlaceholderToken(tok.type, main !== undefined ? main : tok.main, next);
  return text.slice(0, tok.start) + token + text.slice(tok.end);
}

// ── Per-placeholder settings ──
//
// Each unit's settings = its type's base (the layer's legacy textCounter* /
// textCycle* / textScramble* fields, from before settings lived in the token) with the
// token's own options on top. A timer's base is a real clock: it runs its own span in
// real time, Linear, the digits simply changing.

function unitSeconds(spec, units) {
  return Math.abs(units) / (spec.scale || 1);
}

const easingKey = (v) => String(v).toUpperCase();

export function resolveUnitSettings(unit, item) {
  const o = unit.options || {};
  if (unit.type === 'number') {
    const timer = unit.spec.kind === 'timer';
    const base = timer
      ? {
        ...resolveCounterSettings({}),
        style: 'count',
        duration: Math.max(0.05, unitSeconds(unit.spec, unit.spec.to - unit.spec.from)),
        easing: 'LINEAR',
      }
      : resolveCounterSettings(item);
    return {
      ...base,
      stagger: 0,
      style: o.style ?? base.style,
      delay: o.start ?? base.delay,
      duration: o.duration ?? base.duration,
      easing: o.easing ? easingKey(o.easing) : base.easing,
      fit: o.width ? o.width === 'fit' : base.fit,
      tabular: o.digits ? o.digits === 'tabular' : base.tabular,
      turns: o.turns ?? base.turns,
      land: o.lands ?? base.land,
      cascade: o.cascade != null ? o.cascade / 100 : base.cascade,
      direction: o.direction ?? base.direction,
      blur: o.blur != null ? o.blur / 100 : base.blur,
      kf: o.kf || null,
    };
  }
  if (unit.type === 'cycle') {
    const base = resolveCycleSettings(item);
    return {
      ...base,
      stagger: 0,
      style: o.style ?? base.style,
      delay: o.start ?? base.delay,
      hold: o.hold ?? base.hold,
      duration: o.duration ?? base.duration,
      easing: o.easing ? easingKey(o.easing) : base.easing,
      fit: o.width ? o.width === 'fit' : base.fit,
      direction: o.direction ? (o.direction === 'down' ? -1 : 1) : base.direction,
      loop: o.loop ? o.loop === 'on' : base.loop,
    };
  }
  if (unit.type === 'scramble') {
    const base = resolveScrambleSettings(item);
    return {
      ...base,
      delay: o.start ?? base.delay,
      duration: o.duration ?? base.duration,
      charset: o.chars ?? base.charset,
      order: o.order ?? base.order,
      rate: o.flicker ?? base.rate,
    };
  }
  return {};
}

// Keyframed number units read `ph:<id>` tracks (keyframeProps.js PLACEHOLDER_KF_PREFIX).
// A number unit without a `kf` option still honours the layer-wide Counter Progress
// track that 10.10.32–36 wrote, so those projects keep their animation.
export const PLACEHOLDER_KF_PREFIX = 'ph:';
export const LEGACY_COUNTER_KF = 'textCounterProgress';

export function placeholderTrackKey(unit, propertyKeyframes) {
  if (unit.type !== 'number') return null;
  if (unit.options?.kf) return `${PLACEHOLDER_KF_PREFIX}${unit.options.kf}`;
  const legacy = propertyKeyframes?.[LEGACY_COUNTER_KF];
  return Array.isArray(legacy) && legacy.length ? LEGACY_COUNTER_KF : null;
}

/** A free keyframe-track id for a new keyframed placeholder of this text. */
export function nextPlaceholderKfId(text, propertyKeyframes) {
  const used = new Set(scanPlaceholders(text).map((t) => t.options.kf).filter(Boolean));
  for (let n = 1; n < 1000; n += 1) {
    const id = String(n);
    if (!used.has(id) && !propertyKeyframes?.[`${PLACEHOLDER_KF_PREFIX}${id}`]) return id;
  }
  return null;
}

/** One-line summary of a unit, for its card and its keyframe track. */
export function placeholderSummary(unit) {
  if (unit.type === 'number') return `${formatCounterValue(unit.spec.from, unit.spec)} → ${formatCounterValue(unit.spec.to, unit.spec)}`;
  if (unit.type === 'cycle') return unit.words.join(' → ');
  if (unit.type === 'scramble') return unit.text;
  if (unit.mode === 'frame') return unit.clip ? 'from the layer start' : 'project';
  return `${unit.clip ? 'clip' : 'project'} · ${unit.format}`;
}

export const PLACEHOLDER_LABELS = Object.freeze({
  COUNTER: 'Counter', TIMER: 'Timer', CYCLE: 'Word cycle', SCRAMBLE: 'Scramble', TIMECODE: 'Timecode', FRAME: 'Frame number',
});

/** The builder rows for the text's keyframed placeholders (VEKeyframeBuilder extraKfProps). */
export function buildPlaceholderKfProps(item) {
  const out = [];
  for (const tok of scanPlaceholders(item?.textContent)) {
    if (tok.unit.type !== 'number' || !tok.options.kf) continue;
    out.push({
      label: `${PLACEHOLDER_KF_PREFIX}${tok.options.kf}`,
      group: 'Placeholders',
      displayLabel: `${PLACEHOLDER_LABELS[tok.type]} ${placeholderSummary(tok.unit)}`,
      placeholder: '0',
      unit: '%',
      type: 'number',
      min: 0,
      max: 100,
      step: 0.5,
    });
  }
  return out;
}

// ── Project variables ──
// `data.textVariables` on the project: [{ name, value }], names unique ignoring case.
export const MAX_TEXT_VARIABLES = 64;

export function isValidVariableName(name) {
  return typeof name === 'string' && VAR_NAME_RE.test(name.trim());
}

export function sanitizeTextVariables(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    const name = typeof v?.name === 'string' ? v.name.trim() : '';
    if (!isValidVariableName(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, value: typeof v.value === 'string' ? v.value.slice(0, 2000) : '' });
    if (out.length >= MAX_TEXT_VARIABLES) break;
  }
  return out;
}

/** Set (or add) one variable's value; the list is returned new. */
export function setTextVariable(variables, name, value) {
  const list = sanitizeTextVariables(variables);
  const key = String(name).trim().toLowerCase();
  const i = list.findIndex((v) => v.name.toLowerCase() === key);
  if (i >= 0) return list.map((v, j) => (j === i ? { ...v, value } : v));
  return sanitizeTextVariables([...list, { name: String(name).trim(), value }]);
}

function findVariable(variables, name) {
  if (!Array.isArray(variables)) return null;
  const key = name.toLowerCase();
  return variables.find((v) => String(v?.name || '').toLowerCase() === key) || null;
}

/**
 * VAR and MARKER → plain text. `env` = { variables: [{ name, value }], markers:
 * [{ time, name }] sorted by time, timeSec: the ROOT timeline time }. Returns the
 * input string itself when nothing changed.
 */
export function expandStaticPlaceholders(text, env = {}) {
  if (!hasToken(text)) return text;
  return text.replace(TOKEN_RE, (whole, rawType, body) => {
    const type = rawType.toUpperCase();
    if (type === 'VAR') {
      const name = String(body || '').trim();
      const v = name ? findVariable(env.variables, name) : null;
      return v && typeof v.value === 'string' ? v.value : whole;
    }
    if (type === 'MARKER') {
      const fallback = String(body || '').trim();
      const markers = Array.isArray(env.markers) ? env.markers : [];
      const t = Number(env.timeSec) || 0;
      let current = null;
      for (const m of markers) {
        if (Number(m?.time) <= t + 1e-6) current = m;
        else break;
      }
      return (current?.name || '').trim() || fallback;
    }
    return whole;
  });
}

/** Animated tokens → sentinels. Null when the text holds none. */
export function parsePlaceholderText(text) {
  if (!hasToken(text)) return null;
  const units = [];
  const out = text.replace(TOKEN_RE, (whole, rawType, body) => {
    if (units.length >= MAX_UNITS) return whole;
    const unit = parseUnit(rawType.toUpperCase(), body);
    if (!unit) return whole;
    units.push(unit);
    return String.fromCodePoint(SENTINEL_BASE + units.length - 1);
  });
  return units.length ? { text: out, units } : null;
}

export function sentinelIndex(ch) {
  const cp = ch.codePointAt(0);
  return cp >= SENTINEL_BASE && cp < SENTINEL_BASE + MAX_UNITS ? cp - SENTINEL_BASE : -1;
}

/** What the panel needs: the animated tokens (one card each), the VARs, MARKER use. */
export function describePlaceholders(text) {
  const out = { tokens: scanPlaceholders(text), variables: [], marker: false };
  if (!hasToken(text)) return out;
  const seenVars = new Set();
  text.replace(TOKEN_RE, (whole, rawType, body) => {
    const type = rawType.toUpperCase();
    if (type === 'VAR') {
      const name = String(body || '').trim();
      if (name && VAR_NAME_RE.test(name) && !seenVars.has(name.toLowerCase())) {
        seenVars.add(name.toLowerCase());
        out.variables.push(name);
      }
    } else if (type === 'MARKER') {
      out.marker = true;
    }
    return whole;
  });
  return out;
}

export function hasPlaceholders(text) {
  const d = describePlaceholders(text);
  return d.tokens.length + d.variables.length > 0 || d.marker;
}

// ── Readouts ──

export function formatTimecode(sec, fps, format = 'hh:mm:ss:ff') {
  const f = Math.max(1, Math.round(Number(fps) || 30));
  const frames = Math.max(0, Math.floor(sec * f + 1e-6));
  const ff = frames % f;
  const total = Math.floor(frames / f);
  const ss = total % 60;
  const mm = Math.floor(total / 60) % 60;
  const hh = Math.floor(total / 3600);
  const p2 = (n) => String(n).padStart(2, '0');
  const pf = (n) => String(n).padStart(String(f - 1).length, '0');
  switch (format) {
    case 'hh:mm:ss': return `${p2(hh)}:${p2(mm)}:${p2(ss)}`;
    case 'mm:ss:ff': return `${p2(Math.floor(total / 60))}:${p2(ss)}:${pf(ff)}`;
    case 'mm:ss': return `${p2(Math.floor(total / 60))}:${p2(ss)}`;
    case 'ss:ff': return `${p2(total)}:${pf(ff)}`;
    case 'ss': return p2(total);
    default: return `${p2(hh)}:${p2(mm)}:${p2(ss)}:${pf(ff)}`;
  }
}

/** A plain string for places that only need one: layer names, labels, particles. */
export function resolvePlaceholderText(text, env = {}) {
  if (!hasToken(text)) return text;
  const expanded = text.replace(TOKEN_RE, (whole, rawType, body) => {
    const type = rawType.toUpperCase();
    if (type === 'VAR') {
      const name = String(body || '').trim();
      const v = name ? findVariable(env.variables, name) : null;
      return v && typeof v.value === 'string' ? v.value : name || whole;
    }
    if (type === 'MARKER') return String(body || '').trim() || 'Marker';
    const unit = parseUnit(type, body);
    if (!unit) return whole;
    if (unit.type === 'number') return formatCounterValue(unit.spec.to, unit.spec);
    if (unit.type === 'cycle') return unit.words[0];
    if (unit.type === 'scramble') return unit.text;
    return unit.mode === 'frame' ? '0' : formatTimecode(0, env.fps, unit.format);
  });
  return expanded;
}

// ── Units ──

// A tiny seeded hash → [0, 1) — the scramble's "random" characters must be the same
// on every render of a frame.
function hash01(a, b, c) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// Per-character advance of a string (letter spacing between characters) — the cells
// a scramble's random glyphs sit in.
function cellsWidth(M, str, ls) {
  const chars = Array.from(str);
  let w = 0;
  for (const ch of chars) w += M.charW(ch);
  return w + ls * Math.max(0, chars.length - 1);
}

function createCycleUnit(unit, s, clock, index, transform) {
  const words = unit.words.map(transform);
  const n = words.length;
  const ease = clock.easeFor ? clock.easeFor(s.easing) : (p) => p;
  const tau = clock.tSec - s.delay - index * s.stagger;
  let i = 0;
  let j = 0;
  let q = 0;
  if (tau > 0 && n > 1) {
    const period = s.hold + s.duration;
    const step = Math.floor(tau / period);
    const within = tau - step * period;
    if (!s.loop && step >= n - 1) {
      i = n - 1;
      j = n - 1;
    } else {
      i = step % n;
      j = (step + 1) % n;
      q = within < s.hold ? 0 : ease(clamp01((within - s.hold) / s.duration));
    }
  }
  const moving = q > 1e-4 && q < 1 - 1e-4 && i !== j;
  const shown = q >= 1 - 1e-4 ? j : i;
  // Words are measured exactly as the Player draws them (M.measure = its own
  // kerning-aware run measure), so a held word sits like typed text.
  const widthOf = (M, ls) => {
    if (!s.fit) return Math.max(...words.map((w) => M.measure(w, ls)));
    if (!moving) return M.measure(words[shown], ls);
    return M.measure(words[i], ls) * (1 - q) + M.measure(words[j], ls) * q;
  };
  return {
    // Constant through every hold, so the plate is only repainted while a word moves.
    key: moving ? `${i}>${j}:${q.toFixed(5)}` : `${shown}`,
    width: (ctx, ls, M) => widthOf(M, ls),
    draw(ctx, x, y, ls, paint, M) {
      if (!moving) {
        paint.text(words[shown], x, y);
        return;
      }
      const boxW = Math.max(widthOf(M, ls), M.measure(words[i], ls), M.measure(words[j], ls));
      if (s.style === 'roll') {
        const top = y + M.lineTop;
        const h = M.lineBottom - M.lineTop;
        const pad = h * 0.1;
        const stepPx = h + pad * 2;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x - M.em, top - pad, boxW + M.em * 2, stepPx);
        ctx.clip();
        paint.text(words[i], x, y - q * stepPx * s.direction);
        paint.text(words[j], x, y + (1 - q) * stepPx * s.direction);
        ctx.restore();
        return;
      }
      const blurOf = (a) => (s.style === 'blur' ? M.em * 0.12 * (1 - a) : 0);
      for (const [w, a] of [[words[i], 1 - q], [words[j], q]]) {
        drawWithAlpha(ctx, a, () => {
          const b = blurOf(a);
          if (b < 0.3) { paint.text(w, x, y); return; }
          const prevFilter = ctx.filter;
          ctx.filter = prevFilter && prevFilter !== 'none' ? `${prevFilter} blur(${b.toFixed(2)}px)` : `blur(${b.toFixed(2)}px)`;
          paint.text(w, x, y);
          ctx.filter = prevFilter;
        });
      }
    },
  };
}

function createScrambleUnit(unit, s, clock, index, transform) {
  const chars = Array.from(transform(unit.text));
  const solid = chars.map((ch) => ch.trim() !== '');
  const count = solid.filter(Boolean).length;
  const pool = SCRAMBLE_CHARSETS[s.charset];
  // Resolve order: a rank in [0, 1] per solid character.
  const ranks = new Array(chars.length).fill(0);
  const solidIdx = chars.map((_, k) => k).filter((k) => solid[k]);
  if (s.order === 'random') {
    const shuffled = [...solidIdx].sort((a, b) => hash01(index, a, 7) - hash01(index, b, 7));
    shuffled.forEach((k, r) => { ranks[k] = count > 1 ? r / (count - 1) : 1; });
  } else {
    solidIdx.forEach((k, r) => {
      const t = count > 1 ? r / (count - 1) : 1;
      ranks[k] = s.order === 'rtl' ? 1 - t : t;
    });
  }
  const t = clock.tSec;
  const frame = Math.floor(t * s.rate);
  let resolved = 0;
  const shown = chars.map((ch, k) => {
    if (!solid[k]) return ch;
    // Each character resolves at its rank's share of the run; the last lands at the end.
    if (t >= s.delay + s.duration * ranks[k]) { resolved += 1; return ch; }
    let r = pool[Math.floor(hash01(index + 1, k, frame) * pool.length) % pool.length];
    if (s.charset === 'letters' && ch === ch.toLowerCase() && ch !== ch.toUpperCase()) r = r.toLowerCase();
    return r;
  });
  const done = resolved === count;
  return {
    key: done ? 'done' : `${frame}:${resolved}`,
    // The final text's own advance: random glyphs sit centred in the cell of the
    // character they will become, so nothing around the scramble ever moves.
    width: (ctx, ls, M) => cellsWidth(M, chars.join(''), ls),
    // Always glyph by glyph, settled or not, so the finished text sits exactly where
    // the scrambling one did.
    draw(ctx, x, y, ls, paint, M) {
      let cx = x;
      chars.forEach((ch, k) => {
        const cellW = M.charW(ch);
        const g = shown[k];
        if (g.trim()) paint.glyph(g, cx + (cellW - M.charW(g)) / 2, y);
        cx += cellW + ls;
      });
    },
  };
}

function createReadoutUnit(unit, clock) {
  const sec = unit.clip ? clock.clipSec : clock.rootSec;
  const fps = Math.max(1, Math.round(Number(clock.fps) || 30));
  const str = unit.mode === 'frame'
    ? String(Math.max(0, Math.floor((Number(sec) || 0) * fps + 1e-6)))
    : formatTimecode(Number(sec) || 0, fps, unit.format);
  // Digits sit in equal cells (the font's widest digit), so a running readout never
  // jitters sideways.
  const cellOf = (ch, M) => (/\d/.test(ch) ? M.digitW : M.charW(ch));
  return {
    key: str,
    width(ctx, ls, M) {
      const chars = Array.from(str);
      return chars.reduce((w, ch) => w + cellOf(ch, M), 0) + ls * Math.max(0, chars.length - 1);
    },
    draw(ctx, x, y, ls, paint, M) {
      let cx = x;
      for (const ch of str) {
        const cellW = cellOf(ch, M);
        paint.glyph(ch, cx + (cellW - M.charW(ch)) / 2, y);
        cx += cellW + ls;
      }
    },
  };
}

// ── Run: one layer's units at one instant ──

function emOf(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(font || '');
  return m ? Number(m[1]) : 16;
}

function inkBox(ctx, sample) {
  const box = ctx.measureText(sample);
  const up = Number(box?.actualBoundingBoxAscent);
  const down = Number(box?.actualBoundingBoxDescent);
  return Number.isFinite(up) && Number.isFinite(down) ? { top: -up, bottom: down } : null;
}

/**
 * @param parsed  parsePlaceholderText() result
 * @param item    the text layer's timeline item (legacy textCounter* / textCycle* /
 *                textScramble* fields are each type's base settings)
 * @param clock   { tSec: item SOURCE-local time (trimStart + clip time), clipSec: time
 *                since the layer started, rootSec: the timeline time, fps,
 *                track(key) → { now, prev } — a keyframe track's value now and one
 *                frame earlier (0–100), or null when the item has no such track,
 *                easeFor(key) → (p) → eased, transform(str) → the layer's letter case }
 */
export function buildPlaceholderRun(parsed, item, clock) {
  if (!parsed) return null;
  const transform = clock.transform || ((str) => str);
  let scrambleRank = 0;
  const units = parsed.units.map((u) => {
    const s = resolveUnitSettings(u, item);
    if (u.type === 'number') {
      const trackKey = placeholderTrackKey(u, item?.propertyKeyframes);
      const tr = trackKey && clock.track ? clock.track(trackKey) : null;
      return createNumberUnit(u.spec, s, {
        tSec: clock.tSec,
        kf: tr ? tr.now : null,
        kfPrev: tr ? tr.prev : null,
        ease: clock.easeFor ? clock.easeFor(s.easing || COUNTER_DEFAULTS.textCounterEasing) : null,
      }, 0);
    }
    if (u.type === 'cycle') return createCycleUnit(u, s, clock, 0, transform);
    if (u.type === 'scramble') return createScrambleUnit(u, s, clock, scrambleRank++, transform);
    return createReadoutUnit(u, clock);
  });
  const metricsCache = new Map();
  const metricsFor = (ctx, measurePlain) => {
    const font = ctx.font;
    let M = metricsCache.get(font);
    if (!M) {
      const nat = [];
      for (let d = 0; d < 10; d += 1) nat.push(ctx.measureText(String(d)).width);
      const em = emOf(font);
      const widths = new Map();
      const digitInk = inkBox(ctx, '0');
      const lineInk = inkBox(ctx, 'Hgjy|');
      M = {
        nat,
        digitW: Math.max(...nat),
        em,
        charW: (ch) => {
          let w = widths.get(ch);
          if (w === undefined) { w = ctx.measureText(ch).width; widths.set(ch, w); }
          return w;
        },
        // Vertical centre of a digit's ink relative to the draw y (the text path draws
        // with textBaseline 'top'), in em; em-based fallbacks where metrics are absent.
        inkMid: digitInk ? (digitInk.top + digitInk.bottom) / 2 / em : 0.55,
        lineTop: lineInk ? lineInk.top : em * 0.1,
        lineBottom: lineInk ? lineInk.bottom : em * 1.1,
      };
      metricsCache.set(font, M);
    }
    M.measure = (str, ls) => measurePlain(ctx, str, ls);
    return M;
  };
  // Walk a string that may hold sentinels: plain runs to `onPlain`, units to `onUnit`.
  // Letter spacing sits between every pair of neighbouring characters, a unit counting
  // as one character.
  const walk = (text, onPlain, onUnit) => {
    let buf = '';
    for (const ch of text) {
      const idx = sentinelIndex(ch);
      if (idx < 0 || idx >= units.length) { buf += ch; continue; }
      if (buf) { onPlain(buf); buf = ''; }
      onUnit(idx);
    }
    if (buf) onPlain(buf);
  };
  return {
    text: parsed.text,
    count: units.length,
    // Folded into the text plate's paint signature: a settled unit keeps the same key,
    // so the plate stops repainting once nothing moves.
    sig: units.map((u) => u.key).join(';'),
    holds: (text) => typeof text === 'string' && text.indexOf(SENTINEL_HIGH) >= 0,
    measure(ctx, text, ls, measurePlain) {
      const M = metricsFor(ctx, measurePlain);
      let total = 0;
      let segs = 0;
      walk(
        text,
        (plain) => { total += measurePlain(ctx, plain, ls); segs += 1; },
        (idx) => { total += units[idx].width(ctx, ls, M); segs += 1; },
      );
      return total + ls * Math.max(0, segs - 1);
    },
    // drawPlain(str, x, y) paints a plain run with letter spacing; glyph(ch, x, y)
    // paints one glyph — both in the caller's current style (fill or stroke).
    paint(ctx, text, x, y, ls, measurePlain, drawPlain, glyph) {
      const M = metricsFor(ctx, measurePlain);
      const paint = { glyph, text: (str, px, py) => drawPlain(str, px, py) };
      let cursor = x;
      walk(
        text,
        (plain) => { drawPlain(plain, cursor, y); cursor += measurePlain(ctx, plain, ls) + ls; },
        (idx) => { units[idx].draw(ctx, cursor, y, ls, paint, M); cursor += units[idx].width(ctx, ls, M) + ls; },
      );
    },
  };
}

