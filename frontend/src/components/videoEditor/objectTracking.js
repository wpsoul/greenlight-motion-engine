/*
 * OBJECT TRACKING — the subject field every Object overlay effect reads.
 *
 * WHY EACH EFFECT OWNS ITS OWN SCAN
 * ---------------------------------
 * The depth pack put one `depthMap` entry in charge of a map every depth effect
 * shared, because a monocular estimate costs a 25 MB model and a megabyte of
 * base64 — sharing it was the only sane answer. Object tracking is the opposite
 * trade: the models are already vendored (249 KB + 230 KB), a scan is ~40 ms a
 * frame, and what one effect wants from the subject is NOT what the next one
 * wants. Dither Print wants a hard silhouette to print only the person; Portrait
 * Window wants the face box and nothing else; Field Isolines wants the field
 * feathered wide so its rings have somewhere to go. Forcing one scan on all of
 * them would mean one Feather slider, one Source select, one everything.
 *
 * So the scan lives ON THE EFFECT ENTRY (`eff.track`), authored by that card's
 * own TRACKING block, and two Object effects on the same layer can be tracking
 * different things with different settings. This module owns that data: its
 * shape, its encoding, its sanitizer, and the GPU texture the chain samples.
 *
 * THE FIELD IS NOT A MATTE
 * ------------------------
 * It is a WEIGHT: 0 = background, 255 = subject, feathered between. Nothing here
 * cuts anything out. An effect reads it to decide where to concentrate, where to
 * stay away, or (Field Isolines) draws the level sets of the weight itself.
 *
 * STORAGE
 * -------
 * A still is ONE sample. A video is sampled at a few Hz and lerped — the field
 * is a density weight, so a 6 Hz sample grid is imperceptible, and it is the
 * difference between 60 KB and 4 MB of project JSON. Each sample's field is
 * run-length encoded then base64'd (a silhouette is mostly flat, so RLE earns
 * its keep: ~1 KB per 64×64 sample instead of 5.5 KB).
 *
 * TIME IS SOURCE TIME. Samples are stored at the media's own timestamps, so
 * re-trimming or speed-ramping the clip afterwards keeps the track aligned;
 * the Player maps clip-local → source with the same calculateVideoTime() the
 * video texture uses.
 */

import * as THREE from 'three';

export const OBJECT_TRACK_VERSION = 1;

// 64×64 is the measured sweet spot: the lab ran 96×96 and the extra rows changed
// no look (every consumer blurs or steps the field anyway) while costing 2.25× the
// bytes on a per-frame video track.
export const TRACK_FIELD_W = 64;
export const TRACK_FIELD_H = 64;

// Video sampling. 6 Hz is the plan's floor; the cap is what keeps a long clip from
// turning into megabytes of JSON — a 2-minute clip lands on ~1.7 Hz instead, which
// is still well under the rate at which a density weight reads as stepping.
export const TRACK_RATE_HZ = 6;
export const TRACK_MAX_SAMPLES = 200;

// Refuse to persist a track bigger than this. Nothing in the app enforces a project
// size, which is exactly why this has to: a silently 8 MB project is a sync bill and
// an autosave stall, and the user would have no way to see which effect caused it.
export const TRACK_MAX_BYTES = 900 * 1024;

export const TRACK_SOURCES = [
  { value: 0, label: 'Person silhouette' },
  { value: 1, label: 'Face' },
  { value: 2, label: 'Person + face' },
];

export const trackSourceName = (v) => (TRACK_SOURCES.find((s) => s.value === Number(v)) || TRACK_SOURCES[0]).label;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ── Encoding ──────────────────────────────────────────────────────────────
 * [value, runLength] byte pairs → base64. A run longer than 255 is split. The
 * decoder validates the total against w*h and returns null on any mismatch, so a
 * truncated or hand-edited project can never hand a short buffer to the GPU.
 */
export function encodeTrackField(field) {
  if (!field || !field.length) return '';
  const out = [];
  let i = 0;
  while (i < field.length) {
    const v = field[i];
    let n = 1;
    while (i + n < field.length && field[i + n] === v && n < 255) n++;
    out.push(v, n);
    i += n;
  }
  let s = '';
  const CHUNK = 8192;
  for (let k = 0; k < out.length; k += CHUNK) {
    s += String.fromCharCode.apply(null, out.slice(k, k + CHUNK));
  }
  return btoa(s);
}

/**
 * Longest base64 a LEGAL field of `count` cells can encode: worst case is one
 * run per cell (2 bytes each), base64'd. Anything longer is padding — runs that
 * cover nothing — and is rejected before atob() rather than after, so a project
 * cannot make the main thread decode megabytes on its way to being thrown away.
 */
export function maxEncodedFieldChars(count) {
  return Math.ceil((2 * count) / 3) * 4 + 4;
}

export function decodeTrackField(b64, count) {
  if (typeof b64 !== 'string' || !b64) return null;
  if (!(count > 0) || b64.length > maxEncodedFieldChars(count)) return null;
  let bin;
  try { bin = atob(b64); } catch { return null; }
  // A pair is [value, runLength]. An odd byte count means the last pair is cut in
  // half, and a zero-length run covers nothing: both are malformed, and both used
  // to be skipped silently — which is how arbitrary padding stayed "valid".
  if (bin.length === 0 || bin.length % 2 !== 0) return null;
  const field = new Uint8Array(count);
  let w = 0;
  for (let i = 0; i < bin.length; i += 2) {
    const v = bin.charCodeAt(i);
    const n = bin.charCodeAt(i + 1);
    if (n === 0 || w + n > count) return null;
    field.fill(v, w, w + n);
    w += n;
  }
  return w === count ? field : null;
}

/* ── Sanitizer ─────────────────────────────────────────────────────────────
 * Runs on every project load (sanitizeEffectChain). Anything malformed drops the
 * whole track rather than half of one — a partial track renders as a subject that
 * teleports, which reads as a render bug rather than as "re-scan this".
 */
function sanitizeBox(raw) {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const b = raw.slice(0, 5).map((n) => (Number.isFinite(Number(n)) ? Number(n) : NaN));
  if (b.some((n) => !Number.isFinite(n))) return null;
  if (!(b[2] > 0) || !(b[3] > 0)) return null;
  return b.length >= 5 ? [b[0], b[1], b[2], b[3], clamp(b[4], 0, 1)] : [b[0], b[1], b[2], b[3]];
}

/**
 * The scan's own settings, carried on the track so the panel can tell that the
 * stored field is no longer what the current controls would produce. Strings and
 * numbers only — it is compared, never rendered from.
 */
function sanitizeScanSig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const media = typeof raw.media === 'string' ? raw.media.slice(0, 200) : '';
  return {
    media,
    feather: num(raw.feather),
    faceBoost: num(raw.faceBoost),
    from: num(raw.from),
    to: num(raw.to),
  };
}

export function sanitizeObjectTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // An unknown version is not a track this build knows how to read. Dropping it
  // costs a re-scan; guessing at it renders as a subject in the wrong place.
  if (raw.v !== undefined && Number(raw.v) !== OBJECT_TRACK_VERSION) return null;
  const w = Math.round(Number(raw.w));
  const h = Math.round(Number(raw.h));
  if (!(w >= 8 && w <= 256 && h >= 8 && h <= 256)) return null;
  const samplesRaw = Array.isArray(raw.samples) ? raw.samples : [];
  // Bound the WORK, not just the result: a million-entry array was previously
  // walked in full and only the first 200 survivors kept.
  if (!samplesRaw.length || samplesRaw.length > TRACK_MAX_SAMPLES) return null;
  const samples = [];
  let bytes = 160;
  for (const s of samplesRaw) {
    // One bad sample drops the WHOLE track (what this file's header promises):
    // keeping the rest renders as a subject that teleports mid-clip, which reads
    // as a render bug instead of as "re-scan this".
    if (!s || typeof s !== 'object') return null;
    const t = Number(s.t);
    if (!Number.isFinite(t) || t < 0) return null;
    if (typeof s.f !== 'string' || !s.f) return null;
    bytes += s.f.length + 64;
    if (bytes > TRACK_MAX_BYTES) return null;          // refuse before decoding
    if (!decodeTrackField(s.f, w * h)) return null;    // validate, don't keep
    samples.push({
      t,
      f: s.f,
      ...(sanitizeBox(s.b) ? { b: sanitizeBox(s.b) } : {}),
      ...(sanitizeBox(s.fc) ? { fc: sanitizeBox(s.fc) } : {}),
    });
  }
  if (!samples.length) return null;
  samples.sort((a, b) => a.t - b.t);
  const scan = sanitizeScanSig(raw.scan);
  return {
    v: OBJECT_TRACK_VERSION,
    ...(scan ? { scan } : {}),
    w,
    h,
    src: clamp(Math.round(Number(raw.src) || 0), 0, 2),
    kind: raw.kind === 'video' ? 'video' : 'image',
    mw: Math.max(1, Math.round(Number(raw.mw) || 0)) || 1,
    mh: Math.max(1, Math.round(Number(raw.mh) || 0)) || 1,
    person: clamp(Number(raw.person) || 0, 0, 1),
    faceScore: clamp(Number(raw.faceScore) || 0, 0, 1),
    found: raw.found !== false,
    at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : 0,
    samples,
  };
}

/** Rough serialized size, for the panel's "this is what it costs" line. */
export function objectTrackBytes(track) {
  if (!track?.samples?.length) return 0;
  let n = 160;
  for (const s of track.samples) n += (s.f?.length || 0) + 64;
  return n;
}

/** One-line description of what a scan found — the panel's status row. */
export function objectTrackSummary(track) {
  if (!track) return null;
  const parts = [];
  if (!track.found) parts.push('no subject found');
  else {
    if (track.person > 0.001) parts.push(`subject ${(track.person * 100).toFixed(0)}% of frame`);
    if (track.faceScore > 0) parts.push(`face ${(track.faceScore * 100).toFixed(0)}%`);
    if (!parts.length) parts.push('subject found');
  }
  parts.push(track.samples.length === 1 ? '1 sample' : `${track.samples.length} samples`);
  const kb = objectTrackBytes(track) / 1024;
  parts.push(kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`);
  return parts.join(' · ');
}

/* ── Sampling ──────────────────────────────────────────────────────────────── */

/** Index of the last sample at or before t, and the blend to the next one. */
function locate(samples, t) {
  if (samples.length === 1) return { i: 0, j: 0, k: 0 };
  let lo = 0;
  let hi = samples.length - 1;
  if (t <= samples[0].t) return { i: 0, j: 0, k: 0 };
  if (t >= samples[hi].t) return { i: hi, j: hi, k: 0 };
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid; else hi = mid;
  }
  const span = samples[hi].t - samples[lo].t;
  return { i: lo, j: hi, k: span > 1e-6 ? clamp((t - samples[lo].t) / span, 0, 1) : 0 };
}

const lerp = (a, b, k) => a + (b - a) * k;

function lerpBox(a, b, k) {
  if (!a) return b || null;
  if (!b) return a;
  const n = Math.min(a.length, b.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = lerp(a[i], b[i], k);
  return out;
}

/**
 * Subject bounds straight off the weight field (the lab's Measure Rig rule:
 * cells at or above half weight). Computed once per decoded sample and cached on
 * it, because it is a 4096-cell walk and the render tick must not pay for it.
 */
function boundsOf(field, w, h) {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  let any = false;
  let sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = field[y * w + x];
      sum += v;
      if (v < 128) continue;
      any = true;
      if (x / w < minX) minX = x / w;
      if ((x + 1) / w > maxX) maxX = (x + 1) / w;
      if (y / h < minY) minY = y / h;
      if ((y + 1) / h > maxY) maxY = (y + 1) / h;
    }
  }
  return {
    box: any ? [minX, minY, maxX - minX, maxY - minY] : null,
    coverage: sum / (w * h * 255),
  };
}

const decoded = new WeakMap(); // sample object → { field, box, coverage }

function decodeSample(sample, w, h) {
  let hit = decoded.get(sample);
  if (hit) return hit;
  const field = decodeTrackField(sample.f, w * h);
  if (!field) return null;
  const { box, coverage } = boundsOf(field, w, h);
  hit = { field, box, coverage };
  decoded.set(sample, hit);
  return hit;
}

/*
 * ── The GPU side ───────────────────────────────────────────────────────────
 * One RGBA8 DataTexture per effect INSTANCE, keyed by eid so two Object effects
 * on one layer never fight over a texture. R carries the weight; G/B/A are
 * reserved (a later program wants edge magnitude in G without a second binding).
 *
 * The texture is re-uploaded ONLY when the sample pair or the blend actually
 * moves — a still uploads once for the life of the project, and a 6 Hz video
 * track uploads 6 times a second at 60 fps playback, not 60.
 */
const TEX_CACHE = new Map(); // eid → { texture, data, w, h, key, lastUsed }
let texSeq = 0;
const MAX_TEX = 12;

function evictTextures() {
  while (TEX_CACHE.size > MAX_TEX) {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [k, v] of TEX_CACHE) if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestKey = k; }
    if (oldestKey == null) break;
    try { TEX_CACHE.get(oldestKey).texture?.dispose(); } catch { /* already gone */ }
    TEX_CACHE.delete(oldestKey);
  }
}

/** Drop one instance's texture (the entry was removed, or re-scanned). */
export function releaseTrackTexture(eid) {
  const hit = eid && TEX_CACHE.get(eid);
  if (!hit) return;
  try { hit.texture?.dispose(); } catch { /* already gone */ }
  TEX_CACHE.delete(eid);
}

export function releaseAllTrackTextures() {
  for (const k of [...TEX_CACHE.keys()]) releaseTrackTexture(k);
}

/**
 * The chain's per-frame read: the field at THIS source time, as a texture, plus
 * the boxes the shader needs in uniform slots.
 *
 * `sourceTime` is media seconds — the caller maps clip-local time through the
 * clip's trim and speed ramp first, so a re-trimmed or ramped clip stays in sync.
 *
 * Returns null when there is no usable track, and the caller leaves uTexture1
 * unbound: the sampler's white placeholder reads 1.0 everywhere, which is exactly
 * the "no subject — the whole picture is the subject" fallback every program is
 * written against.
 */
export function resolveTrackFrame(eid, track, sourceTime) {
  if (!track?.samples?.length || !eid) return null;
  const { w, h, samples } = track;
  const { i, j, k } = locate(samples, Number.isFinite(sourceTime) ? sourceTime : 0);
  const a = decodeSample(samples[i], w, h);
  if (!a) return null;
  const b = k > 0 ? decodeSample(samples[j], w, h) : null;
  // Quantized so that re-rendering the same frame twice hits the cache, and so a
  // sub-percent drift between frames does not force an upload. `at` (the scan's
  // timestamp) is part of the key because a RE-SCAN keeps the same eid and can
  // land the same sample count — without it the cache would serve the old field
  // forever and re-scanning would look like it did nothing.
  const key = `${track.at || 0}:${i}:${b ? j : i}:${Math.round(k * 64)}`;

  let hit = TEX_CACHE.get(eid);
  if (hit && (hit.w !== w || hit.h !== h)) {
    releaseTrackTexture(eid);
    hit = null;
  }
  if (!hit) {
    const data = new Uint8Array(w * h * 4);
    // The same weights as a PLAIN byte per cell. The geometry programs run on the
    // CPU and want the field itself, not an RGBA texture they would have to walk
    // at stride 4 — and they are the only reason this second copy exists.
    const plain = new Uint8Array(w * h);
    const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    // LINEAR: the field is a weight, and nearest sampling prints the 64×64 grid
    // as visible stair-steps in every program that ramps on it.
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    // Stamped BEFORE the sweep — see objectPlate.js for what `lastUsed: 0` does
    // here: it makes the brand-new entry the eviction victim, so past the cache
    // size every frame re-uploads every field.
    hit = { texture, data, plain, w, h, key: null, lastUsed: ++texSeq };
    TEX_CACHE.set(eid, hit);
    evictTextures();
  }
  if (hit.key !== key) {
    const { data, plain } = hit;
    const fa = a.field;
    const fb = b ? b.field : null;
    for (let p = 0, q = 0; p < fa.length; p++, q += 4) {
      const v = fb ? (fa[p] + (fb[p] - fa[p]) * k) : fa[p];
      data[q] = v;
      data[q + 3] = 255;
      plain[p] = v;
    }
    hit.texture.needsUpdate = true;
    hit.key = key;
  }
  hit.lastUsed = ++texSeq;

  const face = lerpBox(samples[i].fc || null, b ? (samples[j].fc || null) : null, k);
  const box = lerpBox(a.box, b ? b.box : null, k);
  // `key` identifies WHICH field this is (scan + sample pair). The geometry
  // plates put it in their own cache key — a re-scan has to redraw them.
  return { texture: hit.texture, field: hit.plain, key, w, h, face, box, coverage: a.coverage };
}

/*
 * Slots 18–27 of uParams are the TRACK BLOCK — the one place the chain's shared
 * scalar array carries this family's geometry. An Object effect's own params must
 * therefore claim slots 0–17 (documented on every descriptor). This mirrors the
 * existing 24–27 "internal" convention the LUT and path effects already use; they
 * and the Object family never coexist on one descriptor.
 */
export const TRACK_SLOT_HAS_FIELD = 18;
export const TRACK_SLOT_HAS_FACE = 19;
export const TRACK_SLOT_FACE = 20;   // 20..23 — x, y, w, h in media uv (y down)
export const TRACK_SLOT_BOX = 24;    // 24..27 — subject bounds, same space

export function writeTrackSlots(arr, frame) {
  arr[TRACK_SLOT_HAS_FIELD] = frame ? 1 : 0;
  arr[TRACK_SLOT_HAS_FACE] = frame?.face ? 1 : 0;
  const f = frame?.face || [0.3, 0.3, 0.4, 0.4];
  for (let i = 0; i < 4; i++) arr[TRACK_SLOT_FACE + i] = f[i];
  const b = frame?.box || [0, 0, 1, 1];
  for (let i = 0; i < 4; i++) arr[TRACK_SLOT_BOX + i] = b[i];
}

/*
 * The GLSL every Object effect shares. Appended to the effect prelude for
 * `usesTrack` descriptors only, so no other effect pays a line for it.
 *
 * ORIENTATION, stated once because this is the family's one flip hazard:
 * `fxLocal()` hands back the layer box's own space with +y UP (it is built from
 * the projected quad's axes). The field was written from an image, whose row 0 is
 * the TOP. So the read is `vec2(p.x, 1.0 - p.y)` — and the TSL twin does exactly
 * the same thing with no extra negation, because fxLocal box-space positions port
 * verbatim between the backends (see project_fxlocal_orientation_parity).
 */
export const TRACK_PRELUDE = /* glsl */ `
// Layer-local point → the subject weight at it. 1.0 everywhere with no scan.
float trkFieldAt(vec2 p) {
  if (uParams[18] < 0.5) return 1.0;
  vec2 fuv = vec2(clamp(p.x, 0.0, 1.0), clamp(1.0 - p.y, 0.0, 1.0));
  return texture2D(uTexture1, fuv).r;
}
float trkWeight(vec2 uv) { return trkFieldAt(fxLocal(uv)); }
bool trkHasField() { return uParams[18] > 0.5; }
bool trkHasFace() { return uParams[19] > 0.5; }
// Boxes come back in LAYER-LOCAL space (+y up, origin bottom-left), so they can
// be compared with fxLocal() directly. The stored box is image-space (y from the
// TOP), so its origin flips to 1 - y - h — here and nowhere else.
// A vec4 box is (x, y, w, h) → .x .y .z .w, so the flipped origin is 1 - y - h.
vec4 trkFaceBox() {
  vec4 b = vec4(uParams[20], uParams[21], uParams[22], uParams[23]);
  return vec4(b.x, 1.0 - b.y - b.w, b.z, b.w);
}
vec4 trkSubjectBox() {
  vec4 b = vec4(uParams[24], uParams[25], uParams[26], uParams[27]);
  return vec4(b.x, 1.0 - b.y - b.w, b.z, b.w);
}
`;
