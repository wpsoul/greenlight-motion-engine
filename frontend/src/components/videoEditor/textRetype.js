/*
 * Retype — a line-state / CYCLE style (`style: 'retype'`): MotionFast's Prompt Typewriter
 * (motionTemplates/promptTypewriter.js, the approved look-dev html/prompt-typewriter.html) as a
 * text style, so a text layer whose lines are its states plays it with no template:
 *   1. the first line arrives word by word, each word sliding in from the right (word tints);
 *   2. a caret grows from a point at the line's left, then a ray of light reaches out ahead of it
 *      while it sweeps right on an eased curve, eating the line character by character;
 *   3. the caret carries the next line back with it, typing as it travels (the TEXT hangs off
 *      the caret: start = caret − visible width), then blinks.
 * More than two lines: after each typed line holds `hold` s, the caret grows at its left and the
 * erase → retype runs again.
 *
 * The maths are MotionFast's, line for line (its timeline is pure arithmetic on character counts,
 * a character goes once the caret has CROSSED it — the inverse of the erase curve — and the typing
 * steps are hashed, never random); the parity test (tests/essential-templates/
 * prompt_typewriter_parity.test.mjs) checks every glyph, the caret and the ray against the module's
 * own draw calls. Characters advance by their own width + letter spacing (MotionFast's layout, no
 * kerning). Auto-fit: when the widest line is wider than the text box, everything shrinks to fit
 * (MotionFast's maxWidth), around the line's alignment anchor and its vertical centre.
 *
 * LEAF (no imports): node can test it. Pure function of time — export renders frames out of order.
 */

const P1_START = 0.12;   // the first word starts
const GLIDE = 0.38;      // the caret's travel back, overlapped with typing
const TYPE_GAP = 0.05;   // erase end → first new character
const TYPE_FADE = 0.09;  // a typed character fades in over this
const BLINK = 1.06;      // idle blink period, on for the first 0.62 s of it
const BLINK_ON = 0.62;

export const RETYPE_DEFAULTS = Object.freeze({
  stagger: 0.2, wordTime: 0.55, slide: 0.7,
  lead: 0.28, grow: 0.34, wipe: 0.38, reach: 0.5, light: 0.55,
  erase: 26, eraseEase: 'smooth', fade: 0.14,
  type: 14, humanize: 0.5, anchor: 'center', speed: 1,
  caret: '#ffffff', tints: [],
});

const clamp01 = (p) => Math.max(0, Math.min(1, p));
// a glyph's alpha, exactly (the shared drawWithAlpha rounds 0.999+ to 1; the parity test reads every value)
function withAlpha(ctx, alpha, fn) {
  if (!(alpha > 0.002)) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  fn();
  ctx.globalAlpha = prev;
}
const easeOut3 = (p) => 1 - Math.pow(1 - clamp01(p), 3);
const smoother = (p) => { const t = clamp01(p); return t * t * t * (t * (t * 6 - 15) + 10); };

// ── MotionFast's erase curves (mtl.js EASES), with its own bezier solver (easingEngine.bezierEase) ──
function mfBezier(p1x, p1y, p2x, p2y) {
  const bx = (t) => 3 * p1x * t * (1 - t) * (1 - t) + 3 * p2x * t * t * (1 - t) + t * t * t;
  const by = (t) => 3 * p1y * t * (1 - t) * (1 - t) + 3 * p2y * t * t * (1 - t) + t * t * t;
  return (x) => {
    x = Math.max(0, Math.min(1, x));
    let lo = 0; let hi = 1; let t = x;
    for (let i = 0; i < 24; i += 1) {
      const cx = bx(t);
      if (Math.abs(cx - x) < 1e-4) break;
      if (cx < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return by(t);
  };
}
const powerOut = (n) => (t) => 1 - Math.pow(1 - clamp01(t), n);
function backOut(t, c1 = 1.70158) { t = clamp01(t); const c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
const expoOut = (t) => { t = clamp01(t); return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); };
function bounceOut(t) {
  t = clamp01(t);
  const n1 = 7.5625; const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
  if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
  t -= 2.625 / d1;
  return n1 * t * t + 0.984375;
}
// Names are lower case (token options are): smooth power2 … slowdown aein aesmooth aeout.
const EASES = {
  smooth: mfBezier(0.5, 0, 0, 1),
  power2: powerOut(3), power3: powerOut(4), power4: powerOut(5),
  back: (t) => backOut(t), bounce: bounceOut, expo: expoOut,
  natural: mfBezier(0.8, 0, 0.2, 1), slowdown: mfBezier(0, 0, 0, 1),
  aein: mfBezier(0.3141666673, 0, 0.0875000209, 1),
  aesmooth: mfBezier(0.8820833270, 0, 0.2445833683, 1),
  aeout: mfBezier(0.8699999754, 0, 0.6433336333, 1),
};
// MotionFast's sampled curves play the editor's curves of the same name (the editor's Overshoot,
// Impulse and Swing are those samples; its Elastic is GSAP's elastic.out, close to MotionFast's).
const SAMPLED = { elastic: 'ELASTIC_OUT', overshoot: 'OVERSHOOT', impulse: 'IMPULSE', swing: 'SWING' };
export const RETYPE_EASES = Object.freeze([...Object.keys(EASES), ...Object.keys(SAMPLED)]);

/** The erase curve for a name (MotionFast's names, any case); unknown = smooth. */
export function retypeEase(name, easeFor = null) {
  const key = String(name || '').toLowerCase();
  if (EASES[key]) return EASES[key];
  if (SAMPLED[key] && easeFor) return easeFor(SAMPLED[key]);
  return EASES.smooth;
}

// hash, not Math.random (MotionFast's hash01): a frame is the same every time it is drawn.
function hash01(i, seed) {
  let h = ((i + 1) * 2654435761) ^ (seed * 40503);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// the TIME the caret reaches a character: the inverse of its distance curve, by bisection
function easeInv(ease, y) {
  let lo = 0; let hi = 1;
  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2;
    if (ease(mid) < y) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
const charList = (text) => Array.from(String(text == null ? '' : text));
const wordCount = (text) => charList(text).filter((c) => c === ' ').length + 1;

/**
 * The timeline, in the style's own seconds (× speed = layer seconds ÷ … see unit): pure arithmetic
 * on character COUNTS, so a template's length needs no canvas and always agrees with the drawing.
 *   → { arrivalEnd, steps: [{ from, to, caretIn, bandIn, eraseStart, eat[], sweep, eraseEnd,
 *       typeStart, times[], typeEnd }], end }
 */
export function retypeTimeline(states, s, ease = EASES.smooth) {
  const list = states.length ? states : [''];
  const arrivalEnd = P1_START + (wordCount(list[0]) - 1) * s.stagger + s.wordTime;
  const steps = [];
  let caretIn = arrivalEnd - s.lead;
  for (let k = 0; k + 1 < list.length; k += 1) {
    const a = charList(list[k]);
    const b = charList(list[k + 1]);
    const nA = Math.max(1, a.length);
    const bandIn = caretIn + s.grow;
    const eraseStart = bandIn;
    const sweep = nA / Math.max(1, s.erase);
    const eat = [];
    for (let i = 0; i < nA; i += 1) eat.push(eraseStart + sweep * easeInv(ease, (i + 1) / nA));
    const eraseEnd = eraseStart + sweep + s.fade;
    const typeStart = eraseEnd + TYPE_GAP;
    const times = [];
    let acc = typeStart;
    const base = 1 / Math.max(1, s.type);
    for (let i = 0; i < b.length; i += 1) {
      times.push(acc);
      // the first change keeps MotionFast's seed; later ones get their own rhythm
      let step = base * (1 + (hash01(i, 7 + k) - 0.5) * 1.4 * clamp01(s.humanize));
      if (b[i] === ' ') step *= 1.6;      // a breath between words
      acc += step;
    }
    steps.push({ from: k, to: k + 1, caretIn, bandIn, eraseStart, eat, sweep, eraseEnd, typeStart, times, typeEnd: acc });
    caretIn = acc + s.hold;
  }
  return { arrivalEnd, steps, end: steps.length ? steps[steps.length - 1].typeEnd : arrivalEnd };
}

/** The style's own length in layer seconds, a `tail` held after the last character (MotionFast's getDuration). */
export function retypeDuration(states, s, tail = 0) {
  const tl = retypeTimeline(states, s);
  return Math.max(0.6, (tl.end + tail) / (Number(s.speed) || 1));
}

// ── one instant ──

function layoutChars(chars, charW, track) {
  const out = [];
  let x = 0;
  let word = 0;
  for (const ch of chars) {
    const w = charW(ch) + track;
    out.push({ ch, x, w, word });
    x += w;
    if (ch === ' ') word += 1;
  }
  return { chars: out, width: x };
}
function caretOffset(idx, line) {
  const n = line.chars.length;
  if (idx >= n) return line.width;
  const j = Math.max(0, Math.min(n - 1, Math.floor(idx)));
  return line.chars[j].x + (idx - Math.floor(idx)) * line.chars[j].w;
}
const reachLen = (remaining, full, px, reach) => Math.min(remaining, full * reach) + px * 0.45;
const blink = (t) => ((t % BLINK) < BLINK_ON ? 1 : 0);

/**
 * What is drawn at style time t, about the anchor (x 0) and the line's vertical centre (y 0), at
 * the layer's font size px (the caller scales by the auto-fit): MotionFast's paint() as data.
 *   → { glyphs: [{ ch, x, alpha, tint }], caret: { x, alpha, scaleY } | null, band: { x0, len, alpha } | null }
 *   lines  the states laid out (layoutChars); k = the alignment (0 left, 0.5 centre, 1 right)
 */
export function retypePose(tl, lines, s, t, px, k = 0.5) {
  const glyphs = [];
  let caret = null;
  let band = null;
  const startOf = (line) => -k * line.width;
  const bandAt = (caretX, len, alpha) => (alpha <= 0 || len < 2 ? null : { x0: caretX - px * 0.05, len, alpha });
  const tinted = (i) => (i === 0 ? (c) => c.word : () => -1);
  // a line at rest with the caret growing at its left (before each erase)
  const growing = (li, step) => {
    const line = lines[li];
    const x0 = startOf(line);
    const tint = tinted(li);
    for (const c of line.chars) glyphs.push({ ch: c.ch, x: x0 + c.x, alpha: 1, tint: tint(c) });
    const g = smoother((t - step.caretIn) / s.grow);
    const wipe = easeOut3((t - step.bandIn) / s.wipe);
    const caretX = x0 - px * 0.06;
    band = bandAt(caretX, reachLen(line.width, line.width, px, s.reach) * wipe, s.light);
    caret = { x: caretX, alpha: Math.min(1, g * 2.2), scaleY: 0.12 + 0.88 * g };
  };
  const first = tl.steps[0];
  if (!first || t < first.eraseStart) {
    // zone 1 — the first line's words arrive from the right, one per stagger step
    const la = lines[0];
    const x0 = startOf(la);
    for (const c of la.chars) {
      const prog = clamp01((t - (P1_START + c.word * s.stagger)) / s.wordTime);
      if (prog <= 0) continue;
      const e = easeOut3(prog);
      glyphs.push({ ch: c.ch, x: x0 + c.x + (1 - e) * s.slide * px, alpha: e, tint: c.word });
    }
    if (first && t >= first.caretIn) {
      const g = smoother((t - first.caretIn) / s.grow);
      const wipe = easeOut3((t - first.bandIn) / s.wipe);
      const caretX = x0 - px * 0.06;
      band = bandAt(caretX, reachLen(la.width, la.width, px, s.reach) * wipe, s.light);
      caret = { x: caretX, alpha: Math.min(1, g * 2.2), scaleY: 0.12 + 0.88 * g };
    }
    return { glyphs, caret, band };
  }
  let j = 0;
  while (j + 1 < tl.steps.length && t >= tl.steps[j + 1].caretIn) j += 1;
  const st = tl.steps[j];
  if (t < st.eraseStart) { growing(st.from, st); return { glyphs, caret, band }; }
  const la = lines[st.from];
  const lb = lines[st.to];
  const xa = startOf(la);
  if (t < st.eraseEnd) {
    // zone 2 — the caret sweeps the line on the eased curve, eating characters
    const n = la.chars.length;
    const ease = s.easeFn || EASES.smooth;
    const idx = n * ease(clamp01((t - st.eraseStart) / st.sweep));
    const tint = tinted(st.from);
    for (let i = 0; i < n; i += 1) {
      const alpha = 1 - clamp01((t - st.eat[i]) / s.fade);
      if (alpha <= 0) continue;
      glyphs.push({ ch: la.chars[i].ch, x: xa + la.chars[i].x, alpha, tint: tint(la.chars[i]) });
    }
    const xNow = caretOffset(idx, la);
    const caretX = xa + xNow - px * 0.06;
    const remaining = la.width - xNow;
    const tail = clamp01(remaining / (px * 1.2));
    const grow = easeOut3((t - st.bandIn) / s.wipe);
    band = bandAt(caretX, reachLen(remaining, la.width, px, s.reach) * grow, s.light * tail);
    caret = { x: caretX, alpha: 1, scaleY: 1 };
    return { glyphs, caret, band };
  }
  // zone 3 — the caret travels back and the text hangs off it, glued the whole way in
  let vis = 0;
  for (const time of st.times) { if (t >= time) vis += 1; else break; }
  const wVis = vis ? lb.chars[vis - 1].x + lb.chars[vis - 1].w : 0;
  const gap = px * 0.05;
  const settled = (s.anchor === 'left' ? -k * lb.width : -k * wVis) + wVis + gap;
  let caretX = settled;
  const glide = clamp01((t - st.eraseEnd) / GLIDE);
  if (glide < 1) {
    const from = xa + caretOffset(la.chars.length, la) - px * 0.06;
    caretX = from + (settled - from) * easeOut3(glide);
  }
  const startX = caretX - wVis - gap;
  for (let i = 0; i < vis; i += 1) glyphs.push({ ch: lb.chars[i].ch, x: startX + lb.chars[i].x, alpha: clamp01((t - st.times[i]) / TYPE_FADE), tint: -1 });
  const idle = t > st.typeEnd + 0.15;
  caret = { x: caretX, alpha: idle ? blink(t) : 1, scaleY: 1 };
  return { glyphs, caret, band };
}

// ── the light sprites: gradients, never shadowBlur (MotionFast's, same sizes and stops) ──
let SPRITES = null;
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return null;
}
function featherY(c, w, h, edge) {
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(edge, 'rgba(0,0,0,1)');
  g.addColorStop(1 - edge, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.globalCompositeOperation = 'destination-in';
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'source-over';
}
export function retypeSprites() {
  if (SPRITES) return SPRITES;
  const band = makeCanvas(512, 128);
  const core = makeCanvas(256, 128);
  const glow = makeCanvas(64, 64);
  if (!band || !core || !glow) return { band: { width: 512, height: 128 }, core: { width: 256, height: 128 }, glow: { width: 64, height: 64 }, stub: true };
  const bc = band.getContext('2d');
  const gh = bc.createLinearGradient(0, 0, 512, 0);
  [[0, 0.92], [0.05, 0.7], [0.28, 0.58], [0.55, 0.46], [0.75, 0.3], [0.9, 0.13], [1, 0]].forEach(([o, a]) => gh.addColorStop(o, `rgba(255,255,255,${a})`));
  bc.fillStyle = gh;
  bc.fillRect(0, 0, 512, 128);
  featherY(bc, 512, 128, 0.06);
  const cc = core.getContext('2d');
  const gk = cc.createLinearGradient(0, 0, 256, 0);
  [[0, 0.85], [0.28, 0.3], [1, 0]].forEach(([o, a]) => gk.addColorStop(o, `rgba(255,255,255,${a})`));
  cc.fillStyle = gk;
  cc.fillRect(0, 0, 256, 128);
  featherY(cc, 256, 128, 0.16);
  const gc = glow.getContext('2d');
  const rg = gc.createRadialGradient(32, 32, 2, 32, 32, 32);
  rg.addColorStop(0, 'rgba(255,255,255,0.55)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  gc.fillStyle = rg;
  gc.fillRect(0, 0, 64, 64);
  SPRITES = { band, core, glow };
  return SPRITES;
}

/**
 * The unit (textPlaceholders.js buildPlaceholderRun): constant width (the widest line, shrunk to the
 * text box), so a background box around it never jumps and the anchor never moves.
 *   s      resolved settings (textPlaceholders.resolveUnitSettings, style 'retype')
 *   clock  { tSec, easeFor, align, boxWidth, fillMode } — boxWidth / fillMode may be functions (the
 *          Player builds the run before its layout knows them; they are read at measure / draw)
 */
export function createRetypeUnit(words, s, clock) {
  const r = s.retype;
  const easeFn = retypeEase(r.eraseEase, clock.easeFor || null);
  const states = words.length ? words : [''];
  const tl = retypeTimeline(states, { ...r, hold: s.hold }, easeFn);
  const t = Math.max(0, (Number(clock.tSec) || 0) - (Number(s.delay) || 0)) * (Number(r.speed) || 1);
  const k = clock.align === 'left' ? 0 : clock.align === 'right' ? 1 : 0.5;
  const read = (v) => (typeof v === 'function' ? v() : v);
  const done = !tl.steps.length ? t >= tl.arrivalEnd : t > tl.steps[tl.steps.length - 1].typeEnd + 0.15;
  const cache = new Map();
  const layoutFor = (ctx, ls, M) => {
    const key = `${ctx.font}\u0001${ls}`;
    let L = cache.get(key);
    if (!L) {
      const lines = states.map((w) => layoutChars(charList(w), M.charW, ls));
      const widest = Math.max(1, ...lines.map((l) => l.width));
      const boxW = Number(read(clock.boxWidth));
      L = { lines, widest, fit: boxW > 0 ? Math.min(1, boxW / widest) : 1 };
      cache.set(key, L);
    }
    return L;
  };
  const resolved = { ...r, hold: s.hold, easeFn };
  return {
    // repaint while anything moves; once typed, only on the caret's blink
    key: done ? `idle:${blink(t)}` : t < P1_START ? 'pre' : t.toFixed(4),
    width: (ctx, ls, M) => { const L = layoutFor(ctx, ls, M); return L.widest * L.fit; },
    draw(ctx, x, y, ls, paint, M) {
      const L = layoutFor(ctx, ls, M);
      const px = M.em;
      const pose = retypePose(tl, L.lines, resolved, t, px, k);
      // the line box's vertical centre (the engine draws glyphs `glyphDrop` below its top) and
      // MotionFast's baseline about it: the 'Hxg' ink centred on the line
      const fb = ctx.measureText('H');
      const fA = Number(fb.fontBoundingBoxAscent) || 0;
      const fD = Number(fb.fontBoundingBoxDescent) || px;
      const cy = y - (fA - fD) / 2;
      ctx.save();
      ctx.textBaseline = 'alphabetic';
      const m = ctx.measureText('Hxg');
      const asc = Number(m.actualBoundingBoxAscent) || px * 0.72;
      const desc = Number(m.actualBoundingBoxDescent) || px * 0.22;
      const baseline = (asc - desc) / 2;
      ctx.translate(x + k * L.widest * L.fit, cy);
      if (L.fit < 1) ctx.scale(L.fit, L.fit);
      const tints = r.tints || [];
      const fillPass = paint.pass !== 'stroke';
      for (const g of pose.glyphs) {
        withAlpha(ctx, g.alpha, () => {
          const tint = g.tint >= 0 && tints.length ? tints[g.tint % tints.length] : null;
          if (tint && fillPass) { const prev = ctx.fillStyle; ctx.fillStyle = tint; paint.glyph(g.ch, g.x, baseline); ctx.fillStyle = prev; }
          else paint.glyph(g.ch, g.x, baseline);
        });
      }
      // the caret and the light: once, on the fill pass (or the outline pass of outline-only type)
      if (fillPass || read(clock.fillMode) === 'outline') {
        const sp = retypeSprites();
        if (pose.band) {
          const H = px * 1.32;
          if (pose.band.len * L.fit >= 2) {
            ctx.save();
            ctx.globalAlpha *= pose.band.alpha;
            ctx.drawImage(sp.band, pose.band.x0, -H / 2, pose.band.len, H);
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha *= 0.5;
            ctx.drawImage(sp.core, pose.band.x0, -H / 2, Math.min(pose.band.len * 0.5, px * 2.6), H);
            ctx.restore();
          }
        }
        const c = pose.caret;
        if (c && c.alpha > 0) {
          const h = px * 1.18 * c.scaleY;
          const w = Math.max(2 / L.fit, px * 0.055);
          ctx.save();
          ctx.globalAlpha *= c.alpha * 0.22 * c.scaleY;
          ctx.drawImage(sp.glow, c.x - px * 0.34, -h * 0.62, px * 0.68, h * 1.24);
          ctx.restore();
          ctx.save();
          ctx.globalAlpha *= c.alpha;
          ctx.fillStyle = r.caret;
          const rr = w / 2;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(c.x - rr, -h / 2, w, h, rr);
          else ctx.rect(c.x - rr, -h / 2, w, h);
          ctx.fill();
          ctx.restore();
        }
      }
      ctx.restore();
    },
  };
}
