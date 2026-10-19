// Number units of dynamic text: the COUNTER and TIMER placeholders (the tokens
// themselves, the sentinel pipeline and the run live in textPlaceholders.js).
//
//   {{{COUNTER:0-100}}}     the format is read from how the range is typed:
//     1,000-25,000 separators · 0.0-99.9 one decimal · 00-59 zero-padded ·
//     100-0 counts down · -50..50 negatives · 250 alone = 0 → 250
//   {{{TIMER:05:00-00:00}}} a clock: ss, mm:ss or h:mm:ss, optional .s decimals;
//     one value alone (05:00) counts down to zero
//
// A spec is a set of digit COLUMNS, each with its own place value and radix, so one
// Odometer / Roll / Count machinery drives a thousands-separated counter (every
// column base 10) and a clock (the seconds' tens column wraps at 6).
//
// Styles (each placeholder's card in PLACEHOLDERS, written into its token as options —
// textPlaceholders.js; the layer's legacy `textCounter*` fields are only the base):
//   odometer — every digit column rolls on its own from the start digit to the end
//              digit, extra turns growing to the right, columns landing in a cascade
//              (the UI Motion Kit lab's #odometer)
//   roll     — a mechanical odometer: the value rolls continuously, the last digit
//              spins fastest and each carry turns the next column
//   count    — the digits simply change
//
// Everything here is a pure function of (spec, settings, time): export renders frames
// out of order, so nothing may carry from one frame to the next.

export const COUNTER_STYLES = ['odometer', 'roll', 'count'];
export const COUNTER_PROGRESS_KF = 'textCounterProgress';

// Defaults tuned to the lab's #odometer: 1.8 s, three extra turns on the rightmost
// column, left column landing first at ~55% of the run, Power3 Out.
export const COUNTER_DEFAULTS = Object.freeze({
  textCounterStyle: 'odometer',
  textCounterDelay: 0,
  textCounterDuration: 1.8,
  textCounterEasing: 'POWER3_OUT',
  textCounterStagger: 0.15,
  textCounterWidth: 'fixed',
  textCounterTabular: true,
  textCounterTurns: 3,
  textCounterLand: 'left',
  textCounterCascade: 45,
  textCounterDirection: 'auto',
  textCounterBlur: 35,
});

// Column count cap: units must stay an exact integer in a double.
const MAX_COLUMNS = 15;
const RANGE_SEP = '\\s*(?:\\.\\.|→|–|—|to|-)\\s*';
const NUM_SRC = '[-−]?\\d[\\d,]*(?:\\.\\d+)?';
const COUNTER_RE = new RegExp(`^(${NUM_SRC})(?:${RANGE_SEP}(${NUM_SRC}))?$`, 'i');
const TIME_SRC = '\\d+(?::\\d+){0,2}(?:\\.\\d+)?';
const TIMER_RE = new RegExp(`^(${TIME_SRC})(?:${RANGE_SEP}(${TIME_SRC}))?$`, 'i');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);
const num = (v, fallback, lo, hi) => {
  const n = Number(v);
  return clamp(Number.isFinite(n) ? n : fallback, lo, hi);
};

export function resolveCounterSettings(item) {
  const d = COUNTER_DEFAULTS;
  const it = item || {};
  return {
    style: COUNTER_STYLES.includes(it.textCounterStyle) ? it.textCounterStyle : d.textCounterStyle,
    delay: num(it.textCounterDelay, d.textCounterDelay, 0, 3600),
    duration: num(it.textCounterDuration, d.textCounterDuration, 0.05, 600),
    easing: typeof it.textCounterEasing === 'string' && it.textCounterEasing ? it.textCounterEasing : d.textCounterEasing,
    stagger: num(it.textCounterStagger, d.textCounterStagger, 0, 10),
    fit: it.textCounterWidth === 'fit',
    tabular: it.textCounterTabular !== false,
    turns: Math.round(num(it.textCounterTurns, d.textCounterTurns, 0, 10)),
    land: ['left', 'right', 'together'].includes(it.textCounterLand) ? it.textCounterLand : d.textCounterLand,
    cascade: num(it.textCounterCascade, d.textCounterCascade, 0, 90) / 100,
    direction: ['auto', 'up', 'down'].includes(it.textCounterDirection) ? it.textCounterDirection : d.textCounterDirection,
    blur: num(it.textCounterBlur, d.textCounterBlur, 0, 100) / 100,
  };
}

// ── Specs ──
//
//   from, to   signed integer UNITS (the value × 10^decimals; a timer's unit is a
//              second × 10^decimals); `scale` = units per 1 (value or second)
//   cols       least significant first: { place, radix, lead } — place = units per
//              step of that digit; a `lead` column fades out while the value is too
//              small to need it (zero padding pins a column)
//   sepRight   { [col]: ',' | '.' | ':' } — a separator drawn right of that column

function digitCount(n) {
  return String(Math.floor(Math.abs(n))).length;
}

function parseLiteral(raw) {
  const s = raw.replace(/−/g, '-');
  const neg = s[0] === '-';
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf('.');
  const intRaw = dot >= 0 ? body.slice(0, dot) : body;
  const frac = dot >= 0 ? body.slice(dot + 1) : '';
  const intDigits = intRaw.replace(/,/g, '') || '0';
  return {
    value: Number(`${neg ? '-' : ''}${intDigits}${frac ? `.${frac}` : ''}`),
    decimals: frac.length,
    sep: intRaw.includes(','),
    pad: intDigits.length > 1 && intDigits[0] === '0' ? intDigits.length : 0,
  };
}

// "0-100" → a counter spec; null when the body is not a range, so the token stays
// visible as typed text.
export function parseCounterRange(body) {
  const m = COUNTER_RE.exec(String(body ?? '').trim());
  if (!m) return null;
  const single = m[2] == null;
  const a = single ? { value: 0, decimals: 0, sep: false, pad: 0 } : parseLiteral(m[1]);
  const b = parseLiteral(single ? m[1] : m[2]);
  if (!Number.isFinite(a.value) || !Number.isFinite(b.value)) return null;
  const decimals = Math.min(4, Math.max(a.decimals, b.decimals));
  const scale = 10 ** decimals;
  const pad = Math.max(a.pad, b.pad);
  const from = Math.round(a.value * scale);
  const to = Math.round(b.value * scale);
  const intCols = Math.max(1, pad, digitCount(Math.abs(from) / scale), digitCount(Math.abs(to) / scale));
  if (intCols + decimals > MAX_COLUMNS) return null;
  const cols = [];
  for (let j = 0; j < intCols + decimals; j += 1) {
    cols.push({ place: 10 ** j, radix: 10, lead: j - decimals >= Math.max(1, pad) });
  }
  const sepRight = {};
  if (decimals > 0) sepRight[decimals] = '.';
  if (a.sep || b.sep) for (let i = 3; i < intCols; i += 3) sepRight[decimals + i] = ',';
  return { kind: 'counter', from, to, scale, cols, sepRight, signed: from < 0 || to < 0 };
}

function parseTime(raw) {
  const dot = raw.indexOf('.');
  const main = dot >= 0 ? raw.slice(0, dot) : raw;
  const frac = dot >= 0 ? raw.slice(dot + 1) : '';
  const parts = main.split(':');
  // Everything below the top field is a clock field: two digits, under 60.
  for (let i = 1; i < parts.length; i += 1) {
    if (parts[i].length > 2 || Number(parts[i]) >= 60) return null;
  }
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + Number(p);
  return { parts, frac, seconds: seconds + (frac ? Number(`0.${frac}`) : 0) };
}

// "05:00-00:00" → a timer spec. One value counts down from it to zero.
export function parseTimerRange(body) {
  const m = TIMER_RE.exec(String(body ?? '').trim());
  if (!m) return null;
  const a = parseTime(m[1]);
  const b = m[2] != null ? parseTime(m[2]) : { parts: ['0'], frac: '', seconds: 0 };
  if (!a || !b) return null;
  const fields = Math.max(a.parts.length, b.parts.length);
  const decimals = Math.min(3, Math.max(a.frac.length, b.frac.length));
  const S = 10 ** decimals;
  const from = Math.round(a.seconds * S);
  const to = Math.round(b.seconds * S);
  const topPlace = fields === 3 ? 3600 * S : fields === 2 ? 60 * S : S;
  const typedTop = [a, b].filter((t) => t.parts.length === fields).map((t) => t.parts[0]);
  const pad = Math.max(0, ...typedTop.map((p) => (p.length > 1 && p[0] === '0' ? p.length : 0)));
  const topDigits = Math.max(1, pad, digitCount(Math.floor(from / topPlace)), digitCount(Math.floor(to / topPlace)));
  const cols = [];
  for (let k = 0; k < decimals; k += 1) cols.push({ place: 10 ** k, radix: 10, lead: false });
  const clockField = (place) => {
    cols.push({ place, radix: 10, lead: false });
    cols.push({ place: place * 10, radix: 6, lead: false });
  };
  if (fields >= 2) clockField(S);
  if (fields === 3) clockField(60 * S);
  for (let k = 0; k < topDigits; k += 1) {
    cols.push({ place: topPlace * 10 ** k, radix: 10, lead: k >= Math.max(1, pad) });
  }
  if (cols.length > MAX_COLUMNS) return null;
  const sepRight = {};
  if (decimals > 0) sepRight[decimals] = '.';
  if (fields >= 2) sepRight[decimals + 2] = ':';
  if (fields === 3) sepRight[decimals + 4] = ':';
  return { kind: 'timer', from, to, scale: S, cols, sepRight, signed: false };
}

// ── Formatting ──

function formatUnits(units, spec) {
  let out = '';
  for (let j = spec.cols.length - 1; j >= 0; j -= 1) {
    const c = spec.cols[j];
    if (c.lead && units < c.place) continue;
    out += String(Math.floor(units / c.place) % c.radix);
    if (j > 0 && spec.sepRight[j]) out += spec.sepRight[j];
  }
  return out;
}

export function formatCounterValue(units, spec) {
  const u = Math.abs(Math.round(units));
  return `${units < 0 && u > 0 ? '-' : ''}${formatUnits(u, spec)}`;
}

// ── Frames ──
//
// A frame is the unit's slot list, left to right, at one instant. Slot kinds: 'sign',
// 'digit', 'sep'. A digit slot either shows a fixed character (`ch`, Count style) or
// sits at a continuous roll position (`pos` in [0, radix), `abs` unwrapped for the
// speed estimate). `alpha` fades leading columns and the sign; `k` is the slot's
// width share for the Fit width mode.

function significant(col, units) {
  return !col.lead || units >= col.place;
}

function pushSlots(spec, colSlot, signAlpha) {
  const slots = [];
  if (spec.signed) slots.push({ kind: 'sign', ch: '-', alpha: signAlpha, k: signAlpha });
  for (let j = spec.cols.length - 1; j >= 0; j -= 1) {
    const col = spec.cols[j];
    const slot = colSlot(col, j);
    slot.radix = col.radix;
    slots.push(slot);
    const sep = j > 0 ? spec.sepRight[j] : null;
    if (sep) slots.push({ kind: 'sep', ch: sep, alpha: slot.alpha, k: slot.k });
  }
  return slots;
}

function countFrame(spec, eased) {
  const up = spec.to >= spec.from;
  const raw = spec.from + (spec.to - spec.from) * eased;
  // Truncate toward the START on the unit grid, so the start value holds for a
  // whole unit and the end value lands exactly when the run ends.
  const shown = clamp(up ? Math.floor(raw + 1e-6) : Math.ceil(raw - 1e-6), Math.min(spec.from, spec.to), Math.max(spec.from, spec.to));
  const u = Math.abs(shown);
  return pushSlots(spec, (col) => {
    const on = significant(col, u) ? 1 : 0;
    return { kind: 'digit', ch: String(Math.floor(u / col.place) % col.radix), alpha: on, k: on };
  }, shown < 0 ? 1 : 0);
}

function rollFrame(spec, eased) {
  const v = spec.from + (spec.to - spec.from) * eased;
  const u = Math.abs(v);
  return pushSlots(spec, (col) => {
    const whole = Math.floor(u / col.place);
    // A column turns only while everything below it rolls over (…9 → …0, 59 → 00):
    // the last unit before the carry. The lowest column is continuous.
    const carry = clamp01((u % col.place) - (col.place - 1));
    const presence = col.lead ? clamp01(u - (col.place - 1)) : 1;
    return { kind: 'digit', pos: (whole % col.radix) + carry, abs: whole + carry, alpha: presence, k: presence };
  }, clamp01(-v));
}

function odometerFrame(spec, rawP, ease, s) {
  const up = spec.to >= spec.from;
  const dir = up ? 1 : -1;
  const uFrom = Math.abs(spec.from);
  const uTo = Math.abs(spec.to);
  const n = spec.cols.length;
  const eased = ease(rawP);
  const signFrom = spec.from < 0 ? 1 : 0;
  const signTo = spec.to < 0 ? 1 : 0;
  return pushSlots(spec, (col, j) => {
    // Column position across the number: 0 = leftmost, 1 = rightmost. Extra turns
    // grow to the right; the landing rank (0 = lands first) sets how much of the run
    // the column gets — the last to land takes all of it.
    const xPos = n > 1 ? 1 - j / (n - 1) : 1;
    const rank = s.land === 'together' ? 1 : s.land === 'right' ? 1 - xPos : xPos;
    const share = 1 - s.cascade * (1 - rank);
    const p = ease(clamp01(rawP / Math.max(1e-6, share)));
    const r = col.radix;
    const a = Math.floor(uFrom / col.place) % r;
    const b = Math.floor(uTo / col.place) % r;
    const turns = Math.round(s.turns * xPos);
    const steps = (up ? (b - a + r) % r : (a - b + r) % r) + r * turns;
    const abs = a + dir * steps * p;
    const presence = col.lead
      ? (significant(col, uFrom) ? 1 : 0) * (1 - p) + (significant(col, uTo) ? 1 : 0) * p
      : 1;
    return { kind: 'digit', pos: ((abs % r) + r) % r, abs, alpha: presence, k: presence };
  }, signFrom + (signTo - signFrom) * eased);
}

export function counterFrame(spec, s, rawP, ease = (p) => p) {
  const p = clamp01(rawP);
  if (s.style === 'count') return countFrame(spec, ease(p));
  if (s.style === 'roll') return rollFrame(spec, ease(p));
  return odometerFrame(spec, p, ease, s);
}

// Direction the digits travel on screen: +1 = a rising digit enters from below.
function motionSign(spec, s) {
  const dir = spec.to >= spec.from ? 1 : -1;
  if (s.direction === 'up') return dir;
  if (s.direction === 'down') return -dir;
  return 1;
}

// ── Unit ──

// Distance between stacked digits = height of the roll window, in em (the lab's
// odometer uses 1.1× the type size). The window is centred on the digits' own ink
// box (M.inkMid), so the margin above and below them is even whatever the font.
export const ROLL_STEP_EM = 1.1;
export const SHUTTER_SEC = 1 / 60; // spin blur at 100% = the travel over one 60 fps frame
const MAX_BLUR_STEPS = 0.8; // longest streak, in digit steps
// Streak copies sit at most this far apart (em), so a smear reads as one continuous
// streak instead of a stack of ghost digits.
const SMEAR_SPACING_EM = 0.012;
const MAX_SMEAR_COPIES = 32;

export function drawWithAlpha(ctx, alpha, fn) {
  if (alpha <= 0.002) return;
  const prev = ctx.globalAlpha;
  if (alpha < 0.999) ctx.globalAlpha = prev * alpha;
  fn();
  ctx.globalAlpha = prev;
}

/**
 * One COUNTER / TIMER at one instant.
 * @param spec   parseCounterRange / parseTimerRange result
 * @param s      resolveCounterSettings(item)
 * @param clock  { tSec, kf, kfPrev, ease } — tSec is the item's SOURCE-local time;
 *               kf / kfPrev are the Counter Progress track (0–100) now and one frame
 *               earlier, or not finite when it is not keyed; ease maps 0..1 → eased.
 * @param index  this unit's rank among the layer's number units (stagger)
 * Returns { key, width(ctx, ls, M), draw(ctx, x, y, ls, paint, M) } — M is the
 * run's per-font metrics, paint.glyph(ch, x, y) paints one glyph in the caller's style.
 */
export function createNumberUnit(spec, s, clock, index) {
  const keyed = Number.isFinite(clock.kf);
  const ease = keyed ? (p) => p : (clock.ease || ((p) => p));
  const pAt = (tSec) => clamp01((tSec - s.delay - index * s.stagger) / s.duration);
  const rawP = keyed ? clamp01(clock.kf / 100) : pAt(clock.tSec);
  // Trailing shutter: the blur shows the travel since one frame EARLIER, so the first
  // frame of a count is sharp and a column that has just landed still streaks for a
  // frame, as a camera would record it.
  const rawPrev = keyed
    ? clamp01((Number.isFinite(clock.kfPrev) ? clock.kfPrev : clock.kf) / 100)
    : pAt(clock.tSec - SHUTTER_SEC);
  const slots = counterFrame(spec, s, rawP, ease);
  if (s.blur > 0 && s.style !== 'count' && rawPrev !== rawP) {
    const prev = counterFrame(spec, s, rawPrev, ease);
    for (let i = 0; i < slots.length; i += 1) {
      const a = slots[i];
      const b = prev[i];
      if (a.kind !== 'digit' || !b || !Number.isFinite(a.abs)) continue;
      a.blur = Math.min(MAX_BLUR_STEPS, (Math.abs(b.abs - a.abs) / SHUTTER_SEC) * s.blur * SHUTTER_SEC);
    }
  }
  const motion = motionSign(spec, s);
  // Width share of a slot: Fixed keeps every column's room (leading columns fade in
  // place), Fit closes the gap as they fade.
  const shareOf = (slot) => (s.fit ? slot.k : 1);
  const slotWidth = (slot, M) => {
    if (slot.kind !== 'digit') return M.charW(slot.ch);
    if (slot.ch != null && !s.tabular) return M.nat[Number(slot.ch)] || M.digitW;
    return M.digitW;
  };
  return {
    key: `${rawP.toFixed(6)}:${rawPrev.toFixed(6)}`,
    width(ctx, ls, M) {
      let w = 0;
      const last = slots.length - 1;
      slots.forEach((slot, i) => {
        const k = shareOf(slot);
        w += slotWidth(slot, M) * k + (i < last ? ls * k : 0);
      });
      return w;
    },
    draw(ctx, x, y, ls, paint, M) {
      const step = M.em * ROLL_STEP_EM;
      let cx = x;
      for (const slot of slots) {
        const k = shareOf(slot);
        const cellW = slotWidth(slot, M) * k;
        if (slot.kind === 'digit' && slot.pos != null) {
          const r = slot.radix || 10;
          const d0 = Math.floor(slot.pos + 1e-9) % r;
          const f = slot.pos - Math.floor(slot.pos + 1e-9);
          const blurPx = (slot.blur || 0) * step;
          const settled = f < 1e-4 && blurPx < 0.5;
          const centerX = (d) => cx + (cellW - M.nat[d]) / 2;
          drawWithAlpha(ctx, slot.alpha, () => {
            if (settled) {
              paint.glyph(String(d0), centerX(d0), y);
              return;
            }
            const d1 = (d0 + 1) % r;
            const y0 = y - f * step * motion;
            const y1 = y + (1 - f) * step * motion;
            ctx.save();
            ctx.beginPath();
            // Only vertical travel needs hiding — columns never move sideways, so the
            // window is generous horizontally (outline strokes and shadows keep room).
            ctx.rect(cx - M.em, y + M.inkMid * M.em - step / 2, cellW + M.em * 2, step);
            ctx.clip();
            const copies = blurPx < 0.5 ? 1
              : Math.max(2, Math.min(MAX_SMEAR_COPIES, Math.ceil(blurPx / Math.max(0.5, M.em * SMEAR_SPACING_EM))));
            // Equal copies whose overlap builds back to ~92% where the glyph sits
            // still across the whole shutter; the streak's ends thin out.
            if (copies > 1) ctx.globalAlpha *= 1 - Math.pow(0.08, 1 / copies);
            for (let i = 0; i < copies; i += 1) {
              const off = copies > 1 ? (i / (copies - 1) - 0.5) * blurPx : 0;
              paint.glyph(String(d0), centerX(d0), y0 + off);
              paint.glyph(String(d1), centerX(d1), y1 + off);
            }
            ctx.restore();
          });
        } else if (slot.kind === 'digit') {
          const d = Number(slot.ch);
          drawWithAlpha(ctx, slot.alpha, () => paint.glyph(slot.ch, cx + (cellW - (M.nat[d] || 0)) / 2, y));
        } else {
          drawWithAlpha(ctx, slot.alpha, () => paint.glyph(slot.ch, cx + (cellW - M.charW(slot.ch)) / 2, y));
        }
        cx += cellW + ls * k;
      }
    },
  };
}
