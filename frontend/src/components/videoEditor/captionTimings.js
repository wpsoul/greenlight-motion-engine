/*
 * Word-timing helpers for voice-synced captions ("Drive by transcription").
 *
 * A caption item can carry `textWordTimings: [{ startMs, endMs }]` — one entry
 * per whitespace word of its `textContent`, in ITEM-SOURCE-LOCAL milliseconds
 * (0 = the item's untrimmed start). The Player only honours the timings while
 * that 1:1 word↔timing invariant holds, so every builder here either preserves
 * it or returns null/[] — never a partial list.
 */

// Group word-level timestamps into caption-sized segments — fallback for when a
// recording's transcript didn't ship `segments`. Mirrors the backend segmenter:
// break on a long pause, sentence-ending punctuation, or a max word count.
// Each segment also carries its per-word timings (absolute source-media ms);
// entries with empty text are dropped so the segment text's whitespace word
// count stays 1:1 with the emitted timing list.
export function buildCaptionSegmentsFromWords(words) {
  if (!Array.isArray(words) || !words.length) return [];
  const segs = [];
  let cur = [];
  const flush = () => {
    const ws = cur.filter((w) => (w.word || '').trim());
    cur = [];
    if (!ws.length) return;
    segs.push({
      startMs: Math.round(ws[0].start * 1000),
      endMs: Math.round(ws[ws.length - 1].end * 1000),
      text: ws.map((w) => w.word.trim()).join(' '),
      words: ws.map((w) => ({
        word: w.word.trim(),
        startMs: Math.round(w.start * 1000),
        endMs: Math.round(w.end * 1000),
      })),
    });
  };
  for (const w of words) {
    if (!w || !Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
    if (cur.length) {
      const prevEnd = cur[cur.length - 1].end;
      const endsSentence = /[.!?]$/.test((cur[cur.length - 1].word || '').trim());
      if ((w.start - prevEnd) > 0.8 || endsSentence || cur.length >= 8) flush();
    }
    cur.push(w);
  }
  flush();
  return segs;
}

// Recover per-word timings for a segment that came without them (backend
// screen-recording sidecars ship only `{startMs, endMs, text}`): pick the
// transcript words (seconds) whose midpoint falls inside the segment window.
// Returns null unless exactly one timing per whitespace word of seg.text was
// found — a mismatch means the segment text was edited or re-chunked
// differently, and wrong timings are worse than none.
export function wordTimingsForSegment(seg, transcriptWords) {
  if (!seg || !Array.isArray(transcriptWords) || !transcriptWords.length) return null;
  const textWords = ((seg.text || '').match(/\S+/g) || []).length;
  if (!textWords) return null;
  const startMs = Number(seg.startMs) || 0;
  const endMs = Number(seg.endMs) || 0;
  const picked = [];
  for (const w of transcriptWords) {
    if (!w || !Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
    const midMs = ((w.start + w.end) / 2) * 1000;
    if (midMs >= startMs && midMs <= endMs) {
      picked.push({
        word: (w.word || '').trim(),
        startMs: Math.round(w.start * 1000),
        endMs: Math.round(w.end * 1000),
      });
    }
  }
  return picked.length === textWords ? picked : null;
}

// Rebase a segment's absolute word timings (ms) onto an item that covers the
// source window [sSec, eSec]. Boundary words are clamped into the window, not
// dropped, so the 1:1 invariant survives trim clipping at creation time.
export function buildItemWordTimings(segWords, sSec, eSec) {
  if (!Array.isArray(segWords) || !segWords.length) return null;
  const s = Number(sSec) || 0;
  const e = Math.max(s, Number(eSec) || 0);
  const spanMs = Math.round((e - s) * 1000);
  const baseMs = s * 1000;
  const out = [];
  for (const w of segWords) {
    if (!w || !Number.isFinite(w.startMs) || !Number.isFinite(w.endMs)) return null;
    const startMs = Math.min(spanMs, Math.max(0, Math.round(w.startMs - baseMs)));
    const endMs = Math.min(spanMs, Math.max(startMs, Math.round(w.endMs - baseMs)));
    out.push({ startMs, endMs });
  }
  return out;
}

const MAX_WORD_TIMINGS = 400;

// Autosave sanitizer for the item field. All-or-nothing: any invalid or excess
// entry invalidates the list (a truncated list would silently break the 1:1
// invariant and pin every later word to the wrong time).
export function sanitizeWordTimings(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_WORD_TIMINGS) return [];
  const out = [];
  for (const w of list) {
    const startRaw = Math.round(Number(w?.startMs));
    const endRaw = Math.round(Number(w?.endMs));
    if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) return [];
    const startMs = Math.max(0, startRaw);
    out.push({ startMs, endMs: Math.max(startMs, endRaw) });
  }
  return out;
}
