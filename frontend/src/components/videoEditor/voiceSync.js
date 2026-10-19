// Voice link — a text layer's spoken word times taken from ANOTHER layer's speech.
//
// A text layer links to an audio / video / voice layer (`textVoiceSource`). Its
// `textWordTimings` (one { startMs, endMs } per whitespace word, item-source ms — see
// captionTimings.js) are then DERIVED: the layer's words are matched against the
// source's transcript words where they sit on the timeline right now. So after the
// text is edited, the layer is moved, or the voice is moved or retimed, a Resync
// rebuilds the timings and Voice animators / transcript timing follow again.
//
// Matching is an alignment, not a lookup: words may be fixed, inserted or dropped
// (a corrected typo still lands on its spoken word; an inserted word takes the time
// between its neighbours). The search looks under the layer first and only then
// across the whole transcript, preferring what is spoken closest to the layer.
//
// A LEAF module (speedUtils only), so it runs under plain `node --test`.

import { mapTimelineToSource, getTimelineDuration, isFlatSpeed } from './speedUtils.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** A word as compared: lower case, letters and digits only ("Colour," → "colour"). */
export function normWord(w) {
  return String(w || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

// How alike two normalised words are: 1 = the same, down to 0. Spelling variants
// (colour / color), a trailing s, a cut-off word all still score well.
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
export function wordSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest >= 4 && (a.startsWith(b) || b.startsWith(a))) return 0.85;
  return clamp(1 - levenshtein(a, b) / longest, 0, 1);
}

/** The transcript a layer carries: a saved AI transcript on the item, else the clip's. */
export function transcriptOf(item, clip) {
  const fromItem = item?.aiData?.transcribe;
  if (Array.isArray(fromItem?.words) && fromItem.words.length) return fromItem;
  if (clip?.transcript && Array.isArray(clip.transcript.words) && clip.transcript.words.length) return clip.transcript;
  return null;
}

/**
 * Seconds from a layer's timeline start at which its SOURCE second `ws` plays —
 * through its trim and its speed curve (the inverse of mapTimelineToSource).
 * Null when that second is trimmed away.
 */
export function sourceToTimelineOffset(item, ws) {
  const trimStart = Number(item?.trimStart) || 0;
  const trimEnd = Number(item?.trimEnd) || 0;
  const span = trimEnd - trimStart;
  if (!(span > 0) || ws < trimStart - 1e-6 || ws > trimEnd + 1e-6) return null;
  const p = clamp((ws - trimStart) / span, 0, 1);
  const tl = getTimelineDuration(span, item.speedPoints);
  if (!item.speedPoints || isFlatSpeed(item.speedPoints)) return p * tl;
  let lo = 0, hi = 1;
  for (let k = 0; k < 40; k += 1) {
    const mid = (lo + hi) / 2;
    if (mapTimelineToSource(item.speedPoints, mid) < p) lo = mid; else hi = mid;
  }
  return ((lo + hi) / 2) * tl;
}

/**
 * The source layer's spoken words on the TIMELINE: [{ word, n, s, e }] in seconds,
 * only what is not trimmed away. `layerStart` = the source layer's timeline start.
 */
export function speechOnTimeline(item, clip, layerStart) {
  const tr = transcriptOf(item, clip);
  if (!tr) return [];
  const out = [];
  for (const w of tr.words) {
    const s = Number(w?.start), e = Number(w?.end);
    const word = String(w?.word || '').trim();
    if (!word || !Number.isFinite(s) || !Number.isFinite(e)) continue;
    const a = sourceToTimelineOffset(item, s);
    const b = sourceToTimelineOffset(item, Math.min(e, Number(item.trimEnd) || e));
    if (a === null || b === null) continue;
    out.push({ word, n: normWord(word), s: layerStart + a, e: layerStart + Math.max(a, b) });
  }
  return out;
}

// ── Alignment ───────────────────────────────────────────────────────────────
// Semi-global: every text word is placed (matched or not), the speech run may start
// and end anywhere. Scores: a word pair by its similarity (≥ 0.6 counts as a match),
// a text word with no spoken word −0.6, a spoken word the text skips −0.25 (fillers,
// a dropped word). `near(j)` (≥ 0) is a bonus for runs spoken near the layer.
const MATCH_AT = 0.6;
const GAP_TEXT = -0.6;
const GAP_SPEECH = -0.25;
function align(textN, speech, near) {
  const n = textN.length, m = speech.length;
  const W = m + 1;
  const H = new Float64Array((n + 1) * W);
  const P = new Uint8Array((n + 1) * W); // 1 diag, 2 up (text gap), 3 left (speech gap)
  for (let i = 1; i <= n; i += 1) { H[i * W] = H[(i - 1) * W] + GAP_TEXT; P[i * W] = 2; }
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const sim = wordSimilarity(textN[i - 1], speech[j - 1].n);
      const d = H[(i - 1) * W + j - 1] + (sim >= MATCH_AT ? 1 + sim : -0.7);
      const u = H[(i - 1) * W + j] + GAP_TEXT;
      const l = H[i * W + j - 1] + GAP_SPEECH;
      let best = d, p = 1;
      if (u > best) { best = u; p = 2; }
      if (l > best) { best = l; p = 3; }
      H[i * W + j] = best;
      P[i * W + j] = p;
    }
  }
  // Free end: the best last column for the whole text, nudged toward the layer.
  let bj = 0, bs = -Infinity;
  for (let j = 0; j <= m; j += 1) {
    const sc = H[n * W + j] + (j > 0 ? near(j - 1) : 0);
    if (sc > bs) { bs = sc; bj = j; }
  }
  const idx = new Int32Array(n).fill(-1);
  let i = n, j = bj;
  while (i > 0) {
    const p = j > 0 ? P[i * W + j] : 2;
    if (p === 1) {
      if (wordSimilarity(textN[i - 1], speech[j - 1].n) >= MATCH_AT) idx[i - 1] = j - 1;
      i -= 1; j -= 1;
    } else if (p === 2) i -= 1;
    else j -= 1;
  }
  return idx;
}

/**
 * Spoken times for a text layer's words from the speech on the timeline.
 *   text        the layer's text (its whitespace words are what gets timed)
 *   layerStart  / layerEnd   the layer's timeline span;  trimStart its own trim
 *   speech      speechOnTimeline(...) of the source layer
 * → { timings: [{ startMs, endMs }] (item-source ms, one per word) | null,
 *     matched, total, spanStart, spanEnd (timeline s of the matched words), outside }
 * Words with no spoken match are spread between their matched neighbours.
 */
export function syncWordTimings({ text, layerStart, layerEnd, trimStart = 0, speech }) {
  const words = String(text || '').match(/\S+/g) || [];
  const total = words.length;
  const none = { timings: null, matched: 0, total, spanStart: null, spanEnd: null, outside: false };
  if (!total || !speech || !speech.length) return none;
  const textN = words.map(normWord);
  const mid = (layerStart + layerEnd) / 2;
  const half = Math.max(0.5, (layerEnd - layerStart) / 2);
  // Under the layer (with a margin) first; the whole transcript only when that
  // finds less than half of the words.
  const margin = 2;
  const local = speech.filter((w) => w.e >= layerStart - margin && w.s <= layerEnd + margin);
  const run = (pool) => {
    const near = (j) => {
      const d = Math.max(0, Math.abs((pool[j].s + pool[j].e) / 2 - mid) - half);
      return -0.15 * d; // a run spoken 10 s away costs 1.5
    };
    const idx = align(textN, pool, near);
    let matched = 0;
    for (const k of idx) if (k >= 0) matched += 1;
    return { idx, matched, pool };
  };
  let best = local.length ? run(local) : { idx: new Int32Array(total).fill(-1), matched: 0, pool: local };
  if (best.matched * 2 < total) {
    const all = run(speech);
    if (all.matched > best.matched) best = all;
  }
  if (!best.matched) return none;
  const { idx, pool } = best;
  // Times per word: matched ones from the speech; the rest spread between the
  // matched neighbours (or a typical word length beyond the first / last).
  const s = new Float64Array(total).fill(NaN);
  const e = new Float64Array(total).fill(NaN);
  for (let k = 0; k < total; k += 1) if (idx[k] >= 0) { s[k] = pool[idx[k]].s; e[k] = pool[idx[k]].e; }
  const WORD = 0.32;
  let k = 0;
  while (k < total) {
    if (!Number.isNaN(s[k])) { k += 1; continue; }
    let j = k;
    while (j < total && Number.isNaN(s[j])) j += 1;
    const count = j - k;
    const from = k > 0 ? e[k - 1] : (j < total ? s[j] - count * WORD : layerStart);
    const to = j < total ? s[j] : from + count * WORD;
    const step = Math.max(0, to - from) / count;
    for (let q = 0; q < count; q += 1) { s[k + q] = from + q * step; e[k + q] = from + (q + 1) * step; }
    k = j;
  }
  const local0 = (t) => Math.max(0, Math.round((t - layerStart + trimStart) * 1000));
  const timings = words.map((_, q) => {
    const a = local0(s[q]);
    return { startMs: a, endMs: Math.max(a, local0(e[q])) };
  });
  let spanStart = Infinity, spanEnd = -Infinity;
  for (let q = 0; q < total; q += 1) if (idx[q] >= 0) { spanStart = Math.min(spanStart, s[q]); spanEnd = Math.max(spanEnd, e[q]); }
  const inside = Math.max(0, Math.min(spanEnd, layerEnd) - Math.max(spanStart, layerStart));
  const outside = inside < (spanEnd - spanStart) * 0.5;
  return { timings, matched: best.matched, total, spanStart, spanEnd, outside };
}

// ── The link on the item ────────────────────────────────────────────────────
// textVoiceSource: { itemId, clipId, text, at, srcAt, matched, total }
//   itemId / clipId  the source layer (clipId finds it again if the item was replaced)
//   text, at, srcAt  what the last sync saw: the text, the layer's and the source's
//                    timeline starts — a change means the timings may be stale
//   matched / total  words found in the speech at that sync
const ID_RE = /^[\w-]{1,80}$/;
export function sanitizeVoiceSource(raw) {
  if (!raw || typeof raw !== 'object' || !ID_RE.test(String(raw.itemId || ''))) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 1000) / 1000 : null);
  const int = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
  return {
    itemId: String(raw.itemId),
    clipId: ID_RE.test(String(raw.clipId || '')) ? String(raw.clipId) : null,
    text: typeof raw.text === 'string' ? raw.text.slice(0, 4000) : '',
    at: num(raw.at),
    srcAt: num(raw.srcAt),
    matched: int(raw.matched),
    total: int(raw.total),
  };
}

/**
 * Where a linked layer stands now:
 *   'none' | 'missing' (source layer gone) | 'untranscribed' | 'edited' (text changed)
 *   | 'moved' (layer or voice moved) | 'nowords' | 'synced'
 */
export function voiceLinkStatus({ link, text, layerStart, source, sourceStart, hasTranscript }) {
  if (!link) return 'none';
  if (!source) return 'missing';
  if (!hasTranscript) return 'untranscribed';
  if (link.text !== String(text || '')) return 'edited';
  const off = (a, b) => a === null || b === null || Math.abs(a - b) > 0.02;
  if (off(link.at, layerStart) || off(link.srcAt, sourceStart)) return 'moved';
  if (!link.matched) return 'nowords';
  return 'synced';
}
