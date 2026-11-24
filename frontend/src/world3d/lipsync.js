// (lipsync) A character that speaks: the mouth of a model posed by `pose.speech` (plan track B2.2), as a pure function of time.
//
// A pose's `speech: { clock: "voice" }` reads one of the Scene's clocks (scene.clocks.voice: an audio clock on the voice clip, placed
// where its item plays). With the clock's `lipsync` (backend/world3d_lipsync.py: one key per mouth shape, [t, viseme, open] in the
// file's seconds) the mouth takes each sound's shape; without it the jaw follows the clock's loudness alone. Either way the result is
// how far the jaw is open and how much of each of the 15 Oculus / Ready Player Me visemes the mouth shows, laid on the model's own
// names: a jaw bone, ARKit's jawOpen and mouth shapes, Oculus `viseme_*`, VRChat `vrc.v_*`, VRM `aa ih ou ee oh`, VRoid
// `Fcl_MTH_*`, or one open-mouth morph (speechTargets). modelPose.js applies it in the pose's morph and bone steps, on top of keys.
//
// (quality) How a mouth reads as speech, measured on two speakers (MediaPipe's ARKit curves on 257 s of public-domain NASA interviews,
// with NVIDIA Audio2Face-3D on the same sound as a second reference): neighbouring sounds blend, the tongue sounds barely show (at
// t d k g n l the jaw stays at 0.96 of its neighbouring vowels' opening, at s z 0.99, at b p m 0.82, at f v 0.73), the jaw turns about
// 3.3 times a second, the face moves ~50 ms before the sound, and the mouth holds part open in short pauses. So
// each key is a dominance bump (co-articulation): vowels and the lip sounds own the mouth, the rest only colour it; the jaw is its
// own, slower channel; b p m seal the lips with the jaw part open (ARKit's mouthClose); and the face lives: blinks at pauses and some
// stressed beats, small eye darts, brows and a little smile on the accents, all from the track, so every frame of a render agrees.
//
// Nothing here runs for a pose without `speech`, and nothing is imported but plain data helpers.

export const VISEMES = Object.freeze(['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U']);
const VI = Object.fromEntries(VISEMES.map((v, i) => [v, i]));
// How far each shape opens the jaw at full voice (world3d_lipsync.py JAW, the same numbers)
export const JAW = Object.freeze({ sil: 0, PP: 0, FF: 0.1, TH: 0.2, DD: 0.22, kk: 0.28, CH: 0.2, SS: 0.1, nn: 0.2, RR: 0.26, aa: 0.9, E: 0.55, I: 0.35, O: 0.65, U: 0.3 });
export const LIPSYNC_VERSION = 1;
// (emphasis) at most one nod in this many seconds; a nod eases down over ACCENT_RISE before its syllable and back over ACCENT_FALL
const ACCENT_GAP = 0.8, ACCENT_RISE = 0.15, ACCENT_FALL = 0.5;
/** The head's nod at a full accent, degrees (`emphasis` 1), and the brows' lift (a share of ARKit's browInnerUp / browOuterUp). */
export const NOD_DEGREES = 1.2;
export const BROW_LIFT = 0.25;
// (realface) ARKit's jawOpen at 1 is the jaw dropped as far as it goes (46 mm at the lower lip on a measured CC character): a talking
// mouth uses about the first half of it, so the voice's opening (0..1) is laid on jawOpen at this share, whichever way jawOpen was
// found (with ARKit's lip shapes, alone, or named in a `morphs` map)
export const ARKIT_JAW = 0.45;
/** (quality) The face moves this far ahead of the sound, s (two speakers' lips close a median 57 ms and their jaw peaks 47 ms before). */
export const LEAD = 0.045;
// Dominance (Cohen–Massaro co-articulation): how strongly each sound holds the lips (DOM) and the jaw (JAW_DOM), and how wide its hold
// may grow (the room to its neighbours, between WIDTH's min and max, s: a bump as wide as the gap, so neighbours always blend and a
// weak sound between two strong ones is outvoted, never a shape of its own for a frame). Rounding (o, oo, ch, r) starts early: its bump reaches
// ROUND_EARLY times further before it than after, and a rounded vowel holds longer (a speaker's rounding spans its consonants).
const DOM = { sil: 1, PP: 6, FF: 3, TH: 0.3, DD: 0.25, kk: 0.25, CH: 1, SS: 0.45, nn: 0.25, RR: 0.6, aa: 1, E: 1, I: 1, O: 1.2, U: 1.4 };
const JAW_DOM = { sil: 1, PP: 0.15, FF: 0.3, TH: 0.1, DD: 0.08, kk: 0.1, CH: 0.25, SS: 0.06, nn: 0.08, RR: 0.2, aa: 1, E: 1, I: 1, O: 1, U: 1 };
/**
 * (round 5) How much the mouth articulates each syllable, the one strength to pick: 0 is the smooth mouth of round 4 (its syllables
 * melted: the jaw closed visibly on 41 % of a slow reading's syllables, Audio2Face-3D's on 71 %), 1 closes the jaw between
 * syllables about as far as Audio2Face's does, more is stronger. It moves the jaw's pull of each consonant toward JAW_DOM_SAID, the
 * jaw's bumps narrower, the pauses' held opening down, and the spread (ee, s) back up.
 */
export const ARTICULATION = 1;
const JAW_DOM_SAID = { sil: 1, PP: 0.8, FF: 0.8, TH: 0.5, DD: 0.5, kk: 0.5, CH: 0.6, SS: 0.4, nn: 0.5, RR: 0.6, aa: 1, E: 1, I: 1, O: 1, U: 1 };
const art = (smoothValue, saidValue, k = ARTICULATION) => smoothValue + (saidValue - smoothValue) * k;
// past 0.6 the openings themselves grow with it too (1: 1.12 times round 4's, 1.8: 1.36)
export const OPEN_GAIN = 1 + 0.3 * Math.max(0, ARTICULATION - 0.6);
const WIDTH = { lip: [0.035, 0.05], vowel: [0.06, 0.14], round: [0.07, 0.16], other: [0.05, 0.08], sil: [0.05, 0.16] };
const ROUND_EARLY = 1.8;
const JAW_GAP = 0.65, JAW_WIDTH = [0.045, 0.1];   // the jaw's bumps: this share of the gap, within these widths (s)
const REST = 0.002;       // the rest pose's own pull: wins only far from every key
const WIDEST = 0.2, PAUSE_WIDEST = 0.4;   // s: no bump wider than this (a pause's rest: PAUSE_WIDEST, so it holds the pause)
const WINDOW = 4 * PAUSE_WIDEST;           // s: a key further than four of its widths has no say (its bump is e^-16 there)
// Life: blinks (close 75 ms, hold 35 ms, open 170 ms: a speaker's median blink is 0.2-0.33 s), at most one in BLINK_MIN s and at
// least one in BLINK_MAX s while the voice plays (two speakers measured: 23-36 and 73-88 a minute, 38-68 % of them at a pause)
const BLINK_CLOSE = 0.075, BLINK_HOLD = 0.035, BLINK_OPEN = 0.17, BLINK_MIN = 0.9, BLINK_MAX = 4.2;
const DART = 0.05;        // s: an eye dart's move
/** A little smile and cheek on the stressed beats (a share of ARKit's mouthSmile / cheekSquint at a full accent). */
export const SMILE_LIFT = 0.07;
/** An eye bone's turn for a dart of 1 (a share of ARKit's eyeLook), degrees: a dart of 0.05-0.14 turns the eyes 1.5-4 degrees. */
export const EYE_DEGREES = 30;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (x) => { const s = clamp01(x); return s * s * (3 - 2 * s); };

/** Whether a stored `lipsync` can be read: version, keys [[t, viseme, open], ...] in time order. A string says why not. */
export function lipsyncProblem(track) {
  if (!track || typeof track !== 'object') return 'lipsync is not an object';
  if (track.v !== LIPSYNC_VERSION) return `lipsync version ${track.v} (this app reads ${LIPSYNC_VERSION}): make it again with POST /api/world3d/lipsync`;
  const keys = track.keys;
  if (!Array.isArray(keys) || !keys.length) return 'lipsync has no keys';
  let last = -Infinity;
  for (const k of keys) {
    if (!Array.isArray(k) || !Number.isFinite(k[0]) || !(k[1] in VI) || !Number.isFinite(k[2])) return 'lipsync.keys holds an entry that is not [t, viseme, open]';
    if (k[0] < last) return 'lipsync.keys are not in time order';
    last = k[0];
  }
  return '';
}

const prepared = new WeakMap();
const LIP = new Set(['PP', 'FF']);
const VOWEL = new Set(['aa', 'E', 'I', 'O', 'U']);
const ROUNDS = new Set(['O', 'U', 'CH', 'RR']);
const WEAKV = new Set(['TH', 'DD', 'kk', 'nn', 'SS', 'RR']);   // the sounds that only colour the mouth

// a small seeded random (mulberry32): the life of a face is the same on every render of the same track
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let z = Math.imul(x ^ (x >>> 15), 1 | x);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/** A track's keys as typed arrays, each key's dominance bump (its strength and widths), its accents, blinks and eye darts: once per track object. */
function prep(track) {
  let p = prepared.get(track);
  if (p) return p;
  const keys = track.keys;
  const n = keys.length;
  const t = new Float64Array(n), v = new Uint8Array(n), o = new Float32Array(n);
  for (let i = 0; i < n; i += 1) { t[i] = keys[i][0]; v[i] = VI[keys[i][1]]; o[i] = clamp01(keys[i][2]); }
  // each key's bump: the room to its neighbours, within its kind's limits; a pause's rest pulls only as hard as the pause is long
  // (a speaker's mouth holds through short pauses: the jaw stays at 0.4-0.6 of its speaking opening)
  const dom = new Float32Array(n), jdom = new Float32Array(n), sL = new Float32Array(n), sR = new Float32Array(n), jL = new Float32Array(n), jR = new Float32Array(n);
  const prevStrong = new Int32Array(n), nextStrong = new Int32Array(n);
  for (let i = 0, last = -1; i < n; i += 1) { prevStrong[i] = last; if (!WEAKV.has(VISEMES[v[i]])) last = i; }
  for (let i = n - 1, next = n; i >= 0; i -= 1) { nextStrong[i] = next; if (!WEAKV.has(VISEMES[v[i]])) next = i; }
  for (let i = 0; i < n; i += 1) {
    const id = VISEMES[v[i]];
    const kind = LIP.has(id) ? 'lip' : id === 'O' || id === 'U' ? 'round' : VOWEL.has(id) ? 'vowel' : id === 'sil' ? 'sil' : 'other';
    const [lo, hi] = WIDTH[kind];
    // the room to the neighbours: a weak sound's to its very neighbours, every other's to the nearest sound that is not weak (a vowel's
    // bump spans the t or n beside it, so the tongue sounds neither narrow it nor dip the jaw)
    const weak = WEAKV.has(id);
    const pi = weak ? i - 1 : prevStrong[i], ni = weak ? i + 1 : nextStrong[i];
    const gL = pi >= 0 ? t[i] - t[pi] : 0.4, gR = ni < n ? t[ni] - t[i] : 0.4;
    // nothing reaches into a closed lip: toward a b p m / f v the other sounds' bumps end halfway to it
    const lipL = kind !== 'lip' && pi >= 0 && LIP.has(VISEMES[v[pi]]), lipR = kind !== 'lip' && ni < n && LIP.has(VISEMES[v[ni]]);
    const side = (g, toLip) => (toLip ? Math.min(hi, Math.max(0.015, 0.5 * g)) : Math.min(hi, Math.max(lo, g)));
    const early = ROUNDS.has(id) ? ROUND_EARLY : 1;
    sL[i] = Math.min(WIDEST, side(gL, lipL) * early);
    sR[i] = side(gR, lipR);
    // the jaw's bumps: about two thirds of the gap (one slow channel that still rides each syllable), not cut at a closed lip (the jaw only
    // dips for b p m: the lips close it)
    // (round 5) with ARTICULATION the jaw's bumps reach only to the very next sound (each consonant gets its own say) and are narrower
    const k1 = Math.min(1, ARTICULATION);
    const jgL = art(gL, i > 0 ? t[i] - t[i - 1] : 0.4, k1), jgR = art(gR, i < n - 1 ? t[i + 1] - t[i] : 0.4, k1);
    const jawGap = Math.max(0.3, art(JAW_GAP, 0.45)), jawMax = Math.max(0.05, art(JAW_WIDTH[1], 0.075));
    jL[i] = Math.min(WIDEST, Math.min(jawMax, Math.max(JAW_WIDTH[0], jawGap * jgL)) * early);
    jR[i] = Math.min(jawMax, Math.max(JAW_WIDTH[0], jawGap * jgR));
    dom[i] = DOM[id];
    jdom[i] = Math.max(0.02, art(JAW_DOM[id], JAW_DOM_SAID[id]));
    if (id === 'sil') {
      // the pause this rest sits in: up to the next / from the previous key when that is a rest too, else the stretch's edge
      const pause = Math.max(i > 0 && v[i - 1] === 0 ? t[i] - t[i - 1] : 0, i < n - 1 && v[i + 1] === 0 ? t[i + 1] - t[i] : 0, i === 0 || i === n - 1 ? 1 : 0);
      const f = 0.12 + 0.88 * smooth((pause - 0.2) / 0.45);
      dom[i] *= f;
      jdom[i] *= f;
      // a short pause rests the lips but holds the jaw part open (a speaker's stays at 0.3-0.5 of its speaking opening), a long one shuts it
      let near = 0, cnt = 0;
      for (const j of [i - 1, i + 1, i - 2, i + 2]) if (j >= 0 && j < n && v[j] !== 0 && cnt < 2) { near += o[j]; cnt += 1; }
      o[i] = cnt ? Math.max(0, art(0.45, 0.1, Math.min(1, ARTICULATION))) * (near / cnt) * (1 - smooth((pause - 0.3) / 0.8)) : 0;
      // a rest reaches across its pause, so the pause holds still (a far sound's tail never opens it early)
      if (i > 0 && v[i - 1] === 0) sL[i] = jL[i] = Math.min(PAUSE_WIDEST, Math.max(sL[i], 0.6 * (t[i] - t[i - 1])));
      if (i < n - 1 && v[i + 1] === 0) sR[i] = jR[i] = Math.min(PAUSE_WIDEST, Math.max(sR[i], 0.6 * (t[i + 1] - t[i])));
    }
  }
  // accents, the beats a head nods on: the first vowel of each phrase (after a pause) and a vowel clearly wider than the one before it
  // (+0.35 and at least 0.6 open), never two within ACCENT_GAP (the stronger stays): a few per sentence, not every syllable
  const accents = [];
  let lastVowelOpen = 0, sinceSil = true;
  for (let i = 0; i < n; i += 1) {
    const id = VISEMES[v[i]];
    if (id === 'sil') { sinceSil = true; lastVowelOpen = 0; continue; }
    if (id === 'aa' || id === 'E' || id === 'I' || id === 'O' || id === 'U') {
      const stress = sinceSil ? o[i] >= 0.3 : o[i] >= 0.6 && o[i] - lastVowelOpen >= 0.35;
      if (stress) {
        const strength = Math.min(1, o[i] / 0.8);
        const k = accents.length;
        if (k && t[i] - accents[k - 2] < ACCENT_GAP) {
          if (strength > accents[k - 1] + 0.15) { accents[k - 2] = t[i]; accents[k - 1] = strength; }
        } else accents.push(t[i], strength);
      }
      lastVowelOpen = o[i];
      sinceSil = false;
    }
  }
  p = { t, v, o, n, dom, jdom, sL, sR, jL, jR, accents: Float64Array.from(accents) };
  life(p);
  prepared.set(track, p);
  return p;
}

/**
 * (quality) The face's life from the track alone: blinks (most as a pause begins, some just after a stressed beat, the rest filling so
 * none is further than BLINK_MAX from the last, none nearer than BLINK_MIN) and eye darts (with some blinks and at phrase starts).
 */
function life(p) {
  const { t, v, n, accents } = p;
  let seed = n * 2654435761;
  for (let i = 0; i < n; i += 7) seed = (seed ^ Math.round(t[i] * 1000 + v[i] * 17)) * 16777619;
  const r = rng(seed);
  const first = n ? t[0] : 0, last = n ? t[n - 1] : 0;
  const pauses = [];
  for (let i = 1; i < n; i += 1) if (v[i] === 0 && v[i - 1] === 0 && t[i] - t[i - 1] >= 0.3) pauses.push([t[i - 1], t[i]]);
  const cand = [];
  for (const [a] of pauses) if (r() < 0.85) cand.push(a + 0.05 + 0.15 * r());
  for (let k = 0; k < accents.length; k += 2) if (r() < 0.3) cand.push(accents[k] + 0.04 + 0.1 * r());
  cand.sort((x, y) => x - y);
  const blinks = [];
  for (const c of cand) if (c > first + 0.3 && c < last && (!blinks.length || c - blinks[blinks.length - 1] >= BLINK_MIN)) blinks.push(c);
  // fill the long stretches: from the voice's start, between blinks, and to its end
  const filled = [];
  let prev = first + 0.3 - BLINK_MIN;
  for (const b of [...blinks, last + BLINK_MAX]) {
    while (b - prev > BLINK_MAX) {
      const at = prev + 1.8 + 1.8 * r();
      if (at > last || b - at < BLINK_MIN) break;
      filled.push(at);
      prev = at;
    }
    if (b <= last) { filled.push(b); prev = b; }
  }
  p.blinks = Float64Array.from(filled);
  // eye darts: a new place to look with about half the blinks and at the start of most phrases; a third of them back to the middle
  const darts = [];
  const dart = (at) => {
    if (r() < 0.35) darts.push(at, 0, 0);
    else darts.push(at, (r() < 0.5 ? -1 : 1) * (0.05 + 0.09 * r()), (r() - 0.5) * 0.1);
  };
  const when = [];
  for (const b of filled) if (r() < 0.45) when.push(b + 0.03);
  for (const [, b] of pauses) if (r() < 0.5) when.push(b - 0.1);
  when.sort((x, y) => x - y);
  for (const w of when) if (!darts.length || w - darts[darts.length - 3] > 0.6) dart(w);
  p.darts = Float64Array.from(darts);
}

/** The index of the last key at or before s (−1 before the first). */
function keyAt(t, s) {
  let lo = 0, hi = t.length - 1;
  if (!(s >= t[0])) return -1;
  if (s >= t[hi]) return hi;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= s) lo = mid; else hi = mid; }
  return lo;
}

/**
 * The mouth at `s` seconds of the voice's file: { open (0..1, the jaw), w: Float32Array(15) the share of each viseme (sums to 1),
 * emphasis (0..1, the accent's nod), blink (0..1), lookX / lookY (the eyes' dart, a share of ARKit's eyeLook) }. Every key is a bump
 * of dominance around its time (co-articulation): the shares are each viseme's part of the bumps at LEAD seconds ahead of `s`, so
 * neighbouring sounds blend, a weak sound between two strong ones barely shows, and a closed lip (b, p, m) still seals; the jaw blends
 * the keys' openings with its own, wider bumps. Before the first key and after the last the mouth eases to rest.
 */
export function lipsyncAt(track, s, out = null) {
  const r = out || { open: 0, w: new Float32Array(VISEMES.length), emphasis: 0, blink: 0, lookX: 0, lookY: 0 };
  r.w.fill(0);
  r.open = 0;
  r.emphasis = 0;
  r.blink = 0;
  r.lookX = 0;
  r.lookY = 0;
  if (!Number.isFinite(s)) { r.w[0] = 1; return r; }
  const p = prep(track);
  const at = s + LEAD;
  let i = Math.max(0, keyAt(p.t, at - WINDOW));
  let sum = REST, jawSum = REST, jaw = 0;
  r.w[0] = REST;
  for (; i < p.n && p.t[i] <= at + WINDOW; i += 1) {
    const d = at - p.t[i];
    const sig = d < 0 ? p.sL[i] : p.sR[i];
    const x = d / sig;
    if (x * x < 16) {
      const g = p.dom[i] * Math.exp(-x * x);
      r.w[p.v[i]] += g;
      sum += g;
    }
    const xj = d / (d < 0 ? p.jL[i] : p.jR[i]);
    if (xj * xj < 16) {
      const gj = p.jdom[i] * Math.exp(-xj * xj);
      jaw += gj * p.o[i];
      jawSum += gj;
    }
  }
  for (let k = 0; k < r.w.length; k += 1) r.w[k] /= sum;
  r.open = jaw / jawSum;
  r.emphasis = accentAt(p.accents, s);
  if (s >= p.t[0] - 0.2 && s <= p.t[p.n - 1] + 0.5) {
    r.blink = blinkAt(p.blinks, s);
    lookAt(p.darts, s, r);
  }
  return r;
}

/** A blink's lid (0 open .. 1 shut): down fast, a short hold, up slower. */
function blinkAt(blinks, s) {
  let b = 0;
  for (let k = 0; k < blinks.length; k += 1) {
    const d = s - blinks[k];
    if (d < 0) break;
    if (d > BLINK_CLOSE + BLINK_HOLD + BLINK_OPEN) continue;
    b = Math.max(b, d < BLINK_CLOSE ? smooth(d / BLINK_CLOSE) : d < BLINK_CLOSE + BLINK_HOLD ? 1 : 1 - smooth((d - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN));
  }
  return b;
}

/** Where the eyes look at `s`: the last dart's place, reached over DART seconds from the one before (darts are 0.6 s apart or more). */
function lookAt(darts, s, r) {
  let px = 0, py = 0, x = 0, y = 0;
  for (let k = 0; k < darts.length; k += 3) {
    if (darts[k] > s) break;
    const f = smooth((s - darts[k]) / DART);
    x = px + (darts[k + 1] - px) * f;
    y = py + (darts[k + 2] - py) * f;
    px = darts[k + 1];
    py = darts[k + 2];
  }
  r.lookX = x;
  r.lookY = y;
}

/** A nod's curve on an accent: easing down over ACCENT_RISE before it (the head leads the voice a little), back over ACCENT_FALL. */
function accentAt(acc, s) {
  let e = 0;
  for (let k = 0; k < acc.length; k += 2) {
    const d = s - acc[k];
    if (d < -ACCENT_RISE || d > ACCENT_FALL) continue;
    const shape = d < 0 ? smooth((d + ACCENT_RISE) / ACCENT_RISE) : 1 - smooth(d / ACCENT_FALL);
    e = Math.max(e, shape * acc[k + 1]);
  }
  return e;
}

const moveA = { open: 0, w: new Float32Array(VISEMES.length), emphasis: 0, blink: 0, lookX: 0, lookY: 0 };
const moveB = { open: 0, w: new Float32Array(VISEMES.length), emphasis: 0, blink: 0, lookX: 0, lookY: 0 };
// (quality) a change under STILL (a share of a morph's whole weight) cannot be seen across one frame: the bumps' far tails count as still
const STILL = 0.002;
const differs = (a, b) => Math.abs(a.open - b.open) > STILL || Math.abs(a.emphasis - b.emphasis) > STILL || Math.abs(a.blink - b.blink) > STILL
  || Math.abs(a.lookX - b.lookX) > STILL || Math.abs(a.lookY - b.lookY) > STILL || a.w.some((x, i) => Math.abs(x - b.w[i]) > STILL);
/**
 * (mblur) Whether a voice's mouth (or its nod) changes over file seconds `sa`..`sb` (null: where the voice does not play): sampled at
 * both ends and the middle (`sm`), as the export's motion checks sample a move. A held pause is still: a motion-blurred render draws it
 * sharp, the same picture its averaged sub-frames make.
 */
export function lipsyncMovesBetween(track, sa, sb, sm) {
  const f = (s) => (s === null || s === undefined ? NaN : s);
  lipsyncAt(track, f(sa), moveA);
  lipsyncAt(track, f(sb), moveB);
  if (differs(moveA, moveB)) return true;
  lipsyncAt(track, f(sm), moveB);
  return differs(moveA, moveB);
}

/** The jaw's opening from a clock's loudness alone (Phase 1: no words): quiet below `gate` reads as closed, the rest eased open. */
export function openFromLevel(level, gate = 0.08) {
  const x = clamp01((Number(level) - gate) / Math.max(1e-3, 1 - gate));
  return 0.9 * x ** 0.75;
}

/** Emphasis from a loudness curve `at(t)` alone: a clear rise (0.25 in 80 ms) eases the head down and back over ACCENT_FALL. */
export function emphasisFromLevel(at, t) {
  let e = 0;
  for (let k = 0; k <= 12; k += 1) {
    const back = k * 0.04;
    const rise = at(t - back) - at(t - back - 0.08);
    if (rise > 0.25) e = Math.max(e, Math.min(1, rise / 0.6) * (1 - smooth(back / ACCENT_FALL)));
  }
  return e;
}

// ── what a model has to speak with ────────────────────────────────────────────────────────────────────────────────────────────

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/left$/, 'l').replace(/right$/, 'r');
// Oculus / RPM ids, then VRChat's, then the five vowels VRM and VRoid name
const VRC = { sil: 'sil', PP: 'pp', FF: 'ff', TH: 'th', DD: 'dd', kk: 'kk', CH: 'ch', SS: 'ss', nn: 'nn', RR: 'rr', aa: 'aa', E: 'e', I: 'ih', O: 'oh', U: 'ou' };
const FIVE = {
  sil: {}, PP: {}, FF: { I: 0.3 }, TH: { E: 0.4 }, DD: { E: 0.4, A: 0.1 }, kk: { E: 0.3, A: 0.2 }, CH: { U: 0.5, I: 0.2 }, SS: { I: 0.5 },
  nn: { E: 0.3, A: 0.1 }, RR: { O: 0.3, U: 0.3 }, aa: { A: 1 }, E: { E: 1 }, I: { I: 1 }, O: { O: 1 }, U: { U: 1 },
};
// ARKit's mouth shapes per viseme (jawOpen is the jaw's own opening, set from `open`; b p m also seal with mouthClose). (quality) The
// spread shapes are half what they were: a talking mouth's stretch + smile stays under ~0.3 (the speakers measured; Audio2Face 0.16)
const ARKIT = {
  sil: {}, PP: { mouthpressl: 0.35, mouthpressr: 0.35, mouthrolllower: 0.25, mouthrollupper: 0.15 },
  FF: { mouthrolllower: 0.55, mouthupperupl: 0.2, mouthupperupr: 0.2 }, TH: { mouthrolllower: 0.15, tongueout: 0.2 },
  DD: {}, kk: {},
  CH: { mouthfunnel: 0.45, mouthpucker: 0.3, mouthshrugupper: 0.15 }, SS: { mouthstretchl: 0.12, mouthstretchr: 0.12, mouthsmilel: 0.04, mouthsmiler: 0.04 },
  nn: {}, RR: { mouthpucker: 0.35, mouthfunnel: 0.25 }, aa: { mouthlowerdownl: 0.25, mouthlowerdownr: 0.25 },
  E: { mouthstretchl: 0.2, mouthstretchr: 0.2, mouthsmilel: 0.1, mouthsmiler: 0.1, mouthlowerdownl: 0.15, mouthlowerdownr: 0.15 },
  I: { mouthstretchl: 0.25, mouthstretchr: 0.25, mouthsmilel: 0.15, mouthsmiler: 0.15 }, O: { mouthfunnel: 0.6, mouthpucker: 0.3 },
  U: { mouthpucker: 0.9, mouthfunnel: 0.35 },
};
const BROWS = ['browinnerup', 'browouterupl', 'browouterupr'];
// (quality) life: the lids, the eyes' look (ARKit), a smile and cheek
const BLINKS = [['eyeblinkl', 'eyeblinkr'], ['eyeblinkleft', 'eyeblinkright'], ['blink'], ['eyesclosed'], ['fcleyeclose'], ['eyeclose'], ['blinkboth']];
const LOOKS = ['eyelookoutl', 'eyelookoutr', 'eyelookinl', 'eyelookinr', 'eyelookupl', 'eyelookupr', 'eyelookdownl', 'eyelookdownr'];
const CHEEKS = ['mouthsmilel', 'mouthsmiler', 'cheeksquintl', 'cheeksquintr'];
const OPEN_NAMES = ['jawopen', 'mouthopen', 'openmouth', 'mouthopened', 'jawdrop', 'mouthjawopen', 'mtha', 'mouth_a', 'mouth_open'].map(norm);

/** A jaw bone among `bones` (names): "jaw" first, then a name with jaw, mandible or chin in it; never an end or tip node. */
export function findJaw(bones) {
  const ok = bones.filter((b) => !/(end|tip|top|upper|nub)$/i.test(b) && !/_end\b/i.test(b));
  const tail = (b) => b.toLowerCase().replace(/^.*[:|/]/, '');
  return ok.find((b) => /^(def[-_.])?jaw(bone)?([-_.]?(root|master|c|x|m))?$/i.test(tail(b)))
    || ok.find((b) => /jaw/i.test(b) && !/(open|ctrl|control|mch|helper)/i.test(b))
    || ok.find((b) => /(mandible|lowerjaw|chin)/i.test(b)) || null;
}

/** (quality) The eye bones among `bones`, [left, right] (LeftEye, mixamorig:LeftEye, CC_Base_L_Eye, eye.L, J_Adj_L_FaceEye), or null. */
export function findEyes(bones) {
  const eyes = bones.filter((b) => /eye/i.test(b) && !/(lid|brow|lash|end|tip|target|socket|occlusion|tear|_nub)/i.test(b));
  const tail = (b) => b.toLowerCase().replace(/^.*[:|/]/, '');
  const side = (re) => eyes.find((b) => re.test(tail(b)));
  const left = side(/(^|[^a-z])(left|l)([^a-z]|$)|^lefteye|eyeleft/), right = side(/(^|[^a-z])(right|r)([^a-z]|$)|^righteye|eyeright/);
  return left && right && left !== right ? [left, right] : null;
}

/** The head bone among `bones`: a name ending in "head" (Head, mixamorig:Head, CC_Base_Head, J_Bip_C_Head). */
export function findHead(bones) {
  return bones.find((b) => /(^|[^a-z])head$/i.test(b) && !/(top|end)/i.test(b)) || bones.find((b) => /^head/i.test(b) && !/(top|end|_end)/i.test(b)) || null;
}

/**
 * What a model speaks with: { set, morphs (target name per viseme id, or per ARKit / five-vowel key), open (the open-mouth morph),
 * brows, jaw (a bone), head (a bone), useJaw }. `morphs` and `bones` are the model's names. `spec` is `pose.speech`: its `jaw`
 * (a bone name, false, or "auto"), `head`, `morphs` ({ "<viseme id or open>": "<morph name>" } or false). `set` is null when the
 * model has no mouth morphs of a kind it knows.
 */
export function speechTargets(morphNames, boneNames, spec = {}) {
  const byNorm = new Map();
  for (const m of morphNames) if (!byNorm.has(norm(m))) byNorm.set(norm(m), m);
  const has = (n) => byNorm.get(norm(n));
  const out = { set: null, visemes: null, five: null, arkit: null, open: null, brows: [], jaw: null, head: null, useJaw: false, custom: null, close: null, blink: [], look: null, cheeks: [], eyeBones: null };
  if (spec.morphs && typeof spec.morphs === 'object') {
    out.set = 'custom';
    out.custom = {};
    for (const [k, name] of Object.entries(spec.morphs)) {
      const real = has(name);
      if (real && (k === 'open' || k in VI)) out.custom[k] = real;
    }
    out.open = out.custom.open || null;
  } else if (spec.morphs !== false) {
    const ocu = {}, vrc = {};
    for (const id of VISEMES) {
      const a = has(`viseme_${id}`);
      if (a) ocu[id] = a;
      const b = byNorm.get(`vrcv${VRC[id]}`) || byNorm.get(`v${VRC[id]}`);
      if (b) vrc[id] = b;
    }
    const five = {};
    for (const [vowel, names] of Object.entries({ A: ['aa', 'fclmtha', 'mtha', 'vrma'], I: ['ih', 'fclmthi', 'mthi', 'vrmi'], U: ['ou', 'fclmthu', 'mthu', 'vrmu'], E: ['ee', 'fclmthe', 'mthe', 'vrme'], O: ['oh', 'fclmtho', 'mtho', 'vrmo'] })) {
      for (const n of names) { const real = byNorm.get(n); if (real) { five[vowel] = real; break; } }
    }
    const arkit = {};
    for (const shape of Object.values(ARKIT)) for (const k of Object.keys(shape)) { const real = byNorm.get(k); if (real) arkit[k] = real; }
    out.open = OPEN_NAMES.map((n) => byNorm.get(n)).find(Boolean) || null;
    if (Object.keys(ocu).length >= 5) { out.set = 'oculus'; out.visemes = ocu; }
    else if (Object.keys(vrc).length >= 5) { out.set = 'vrchat'; out.visemes = vrc; }
    else if (Object.keys(five).length >= 3) { out.set = 'vowels'; out.five = five; }
    else if (byNorm.get('jawopen') && Object.keys(arkit).length >= 2) { out.set = 'arkit'; out.arkit = arkit; out.open = byNorm.get('jawopen'); }
    else if (out.open) out.set = 'open';
  }
  // (realface) the brows lift on the accents whichever mouth shapes the model speaks with (its own map included)
  out.brows = BROWS.map((b) => byNorm.get(b)).filter(Boolean);
  // (quality) b p m seal the lips with ARKit's mouthClose (the jaw stays part open, as a speaker's does); the face's life
  out.close = byNorm.get('mouthclose') || null;
  out.blink = (BLINKS.map((set) => set.map((b) => byNorm.get(b))).find((set) => set.every(Boolean))) || [];
  const looks = LOOKS.map((l) => byNorm.get(l));
  out.look = looks.every(Boolean) ? looks : null;
  out.cheeks = CHEEKS.map((c) => byNorm.get(c)).filter(Boolean);
  // without the eyeLook shapes, eye bones dart instead
  out.eyeBones = out.look ? null : findEyes(boneNames);
  out.jaw = spec.jaw === false ? null : (typeof spec.jaw === 'string' && spec.jaw !== 'auto' ? (boneNames.includes(spec.jaw) ? spec.jaw : null) : findJaw(boneNames));
  out.head = spec.head === false ? null : (typeof spec.head === 'string' && spec.head !== 'auto' ? (boneNames.includes(spec.head) ? spec.head : null) : findHead(boneNames));
  // the jaw bone turns when nothing else opens the mouth, or when it is named
  const morphOpens = out.set === 'oculus' || out.set === 'vrchat' || out.set === 'vowels' || !!out.open || (out.set === 'custom' && Object.keys(out.custom).length > 0);
  out.useJaw = !!out.jaw && ((typeof spec.jaw === 'string' && spec.jaw !== 'auto') || !morphOpens);
  return out;
}

/** (quality) The face's life a pose may turn off one by one (`pose.speech.blink` / `eyes` / `brows` / `cheeks`: false). */
export const LIFE = Object.freeze({ blink: true, eyes: true, brows: true, cheeks: true });
const PP_I = VI.PP;

/**
 * The morph weights a mouth (lipsyncAt's) asks of a model's targets (speechTargets), scaled by `amount`: [[name, weight], ...] to add,
 * and the jaw's opening (0..1) and the emphasis for the bones. `life` ({ blink, eyes, brows, cheeks }, each true by default) says
 * which of the face's life to show; a model without those shapes shows none of it.
 */
export function speechWeights(targets, mouth, amount = 1, emphasis = 1, life = LIFE) {
  const out = [];
  const add = (name, w) => { if (name && w > 1e-4) out.push([name, w]); };
  let open = clamp01(clamp01(mouth.open) * OPEN_GAIN) * amount;
  const pp = mouth.w[PP_I] || 0;
  // b p m: a set with no lip-closing shape of its own (one open morph, a jaw bone, ARKit without mouthClose) shuts the jaw instead
  const sealsItself = targets.set === 'oculus' || targets.set === 'vrchat' || (targets.set === 'arkit' && targets.close)
    || (targets.set === 'custom' && targets.custom && targets.custom.PP);
  if (!sealsItself) open *= 1 - 0.9 * pp;
  const opening = (name) => open * (name && norm(name) === 'jawopen' ? ARKIT_JAW : 1);
  // a viseme set opens the mouth itself: its shapes are scaled to the voice's own opening (a quiet "ah" opens less), the closed and
  // narrow ones (b, f, s) stay whole
  let mixJaw = 0;
  for (let i = 0; i < VISEMES.length; i += 1) mixJaw += mouth.w[i] * JAW[VISEMES[i]];
  const scale = mixJaw > 0.05 ? Math.min(1.25, (mouth.open * OPEN_GAIN) / mixJaw) : 1;
  const visemeWeight = (i) => mouth.w[i] * (JAW[VISEMES[i]] > 0.05 ? scale : 1) * amount;
  if (targets.set === 'oculus' || targets.set === 'vrchat') {
    for (let i = 0; i < VISEMES.length; i += 1) add(targets.visemes[VISEMES[i]], visemeWeight(i));
  } else if (targets.set === 'vowels') {
    const acc = {};
    for (let i = 0; i < VISEMES.length; i += 1) {
      const w = visemeWeight(i);
      if (w <= 0) continue;
      for (const [k, x] of Object.entries(FIVE[VISEMES[i]])) acc[k] = (acc[k] || 0) + w * x;
    }
    for (const [k, w] of Object.entries(acc)) add(targets.five[k], Math.min(1, w));
  } else if (targets.set === 'arkit') {
    const jw = opening(targets.open);
    add(targets.open, jw);
    // mouthClose at the jaw's own weight brings the lips together over an open jaw (ARKit's convention)
    if (targets.close) add(targets.close, Math.min(jw, pp * jw));
    const acc = {};
    for (let i = 0; i < VISEMES.length; i += 1) {
      const w = mouth.w[i] * amount;
      if (w <= 0) continue;
      for (const [k, x] of Object.entries(ARKIT[VISEMES[i]])) acc[k] = (acc[k] || 0) + w * x;
    }
    // (round 5) the spread (ee, ih, s) comes back with ARTICULATION: halved in round 4, three quarters of 16.6.54's at 1
    const spread = Math.max(0, art(1, 1.5));
    for (const [k, w] of Object.entries(acc)) add(targets.arkit[k], Math.min(1, /^mouth(stretch|smile)/.test(k) ? w * spread : w));
  } else if (targets.set === 'custom') {
    if (targets.custom.open) add(targets.custom.open, opening(targets.custom.open));
    for (let i = 0; i < VISEMES.length; i += 1) add(targets.custom[VISEMES[i]], visemeWeight(i));
  } else if (targets.set === 'open') {
    add(targets.open, opening(targets.open));
  }
  const e = clamp01(mouth.emphasis) * emphasis;
  const on = (k) => !life || life[k] !== false;
  if (on('brows')) for (const b of targets.brows || []) add(b, BROW_LIFT * e);
  if (on('cheeks')) for (const c of targets.cheeks || []) add(c, SMILE_LIFT * Math.min(1, e));
  if (on('blink') && mouth.blink > 0) for (const b of targets.blink || []) add(b, mouth.blink);
  const darts = on('eyes') && targets.eyeBones && (mouth.lookX || mouth.lookY);
  if (on('eyes') && targets.look && (mouth.lookX || mouth.lookY)) {
    // + x: the eyes turn to the character's own left (its left eye out, its right eye in); + y: up
    const [outL, outR, inL, inR, upL, upR, downL, downR] = targets.look;
    const x = mouth.lookX || 0, y = mouth.lookY || 0;
    if (x > 0) { add(outL, x); add(inR, x); } else { add(outR, -x); add(inL, -x); }
    if (y > 0) { add(upL, y); add(upR, y); } else { add(downL, -y); add(downR, -y); }
  }
  return { morphs: out, open: targets.useJaw ? open : 0, emphasis: e, lookX: darts ? mouth.lookX : 0, lookY: darts ? mouth.lookY : 0 };
}
