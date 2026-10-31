// The drawn cursor of a screen recording (PLANS/SCREEN_RECORDER_SMOOTH_MOTION_PLAN.md, Phase 3).
//
// A native macOS take (desktop/src/native-capture.js) has NO cursor in the picture: `clip.recordingMeta.cursorInVideo
// === false`. The editor draws one back from the hand's full path (the .glcursor file at `clip.recordingTrackUrl`,
// loaded lazily) with Smart Zoom's cursor maths: smoothing, landing exactly on each click, the click press, idle fade,
// tilt, the real cursor shapes. The engine stamps it into the recording's own picture (engine/recordingCursorPass.js),
// so masks, mockups, effects, transitions and the camera treat it exactly like a cursor that was recorded.
//
// The look follows the take's Smart Zoom preset (`item.recordingCursor.preset`, Studio by default); any field set on
// `item.recordingCursor` overrides the preset's:
//   item.recordingCursor = { enabled, preset, size, smoothing, clickEffect, hideIdleMs, tilt, motionBlur }
// This module is a leaf: no engine, React or three imports.
import { buildCursorPlan, evalCursor, presetById, takeFromEventTrack } from './smartZoom.js';
import { draw as drawCursorArt, ring as drawCursorRing } from './smartZoomCursors.js';

const SMOOTHING = ['off', 'spring', 'zerolag', 'spline'];
const CLICK_EFFECTS = ['press', 'ring', 'none'];

// Save-time sanitizer for the item field (editorState). Absent = draw with the preset defaults.
export function sanitizeRecordingCursor(item) {
  const rc = item?.recordingCursor;
  if (!rc || typeof rc !== 'object') return {};
  const out = { enabled: rc.enabled !== false };
  if (typeof rc.preset === 'string' && rc.preset) out.preset = rc.preset.slice(0, 32);
  if (Number.isFinite(rc.size)) out.size = Math.max(0.25, Math.min(6, rc.size));
  if (SMOOTHING.includes(rc.smoothing)) out.smoothing = rc.smoothing;
  if (CLICK_EFFECTS.includes(rc.clickEffect)) out.clickEffect = rc.clickEffect;
  if (Number.isFinite(rc.hideIdleMs)) out.hideIdleMs = Math.max(0, Math.min(60000, rc.hideIdleMs));
  if (Number.isFinite(rc.tilt)) out.tilt = Math.max(0, Math.min(40, rc.tilt));
  if (Number.isFinite(rc.motionBlur)) out.motionBlur = Math.max(0, Math.min(2, rc.motionBlur));
  return { recordingCursor: out };
}

// Does this item draw a cursor? Only a recording whose picture has none, and only while it is switched on.
export function drawsRecordingCursor(clip, item) {
  return clip?.mediaType === 'video'
    && clip.recordingMeta?.cursorInVideo === false
    && item?.recordingCursor?.enabled !== false;
}

// The resolved settings: the preset's cursor options, then the item's own.
export function recordingCursorSettings(item) {
  const rc = item?.recordingCursor || {};
  const preset = presetById(rc.preset);
  const s = { ...preset.cursor, preset: preset.cursor.preset, motionBlur: 1 };
  for (const k of ['size', 'smoothing', 'clickEffect', 'hideIdleMs', 'tilt', 'motionBlur']) {
    if (rc[k] !== undefined) s[k] = rc[k];
  }
  return s;
}

// ── The full-rate track (.glcursor), loaded once per URL ──────────────────────────────────────────────────────────
const tracks = new Map(); // url → { status: 'loading' | 'ready' | 'failed', track, promise, listeners }

function decodeImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Resolves when the track (and any app-specific cursor pictures in it) is ready, or failed (then the light 10 Hz
// track on the clip stands in). The export's warm-up awaits this.
export function loadRecordingCursorTrack(url) {
  if (!url) return Promise.resolve(null);
  let entry = tracks.get(url);
  if (entry) return entry.promise;
  entry = { status: 'loading', track: null, promise: null, listeners: new Set() };
  tracks.set(url, entry);
  entry.promise = (async () => {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const track = await res.json();
      if (!track || !Array.isArray(track.t) || !Array.isArray(track.x) || !Array.isArray(track.y)) throw new Error('not a cursor track');
      track.images = {};
      await Promise.all((Array.isArray(track.shapes) ? track.shapes : []).map(async (sh) => {
        if (sh && typeof sh.png === 'string' && sh.png.startsWith('data:image/png')) {
          const img = await decodeImage(sh.png);
          if (img) track.images[sh.id] = { img, size: sh.size || null, hotspot: sh.hotspot || null };
        }
      }));
      entry.track = track;
      entry.status = 'ready';
    } catch (err) {
      console.warn('[recording cursor] track not loaded, using the light track:', url, err?.message || err);
      entry.status = 'failed';
    }
    for (const l of entry.listeners) { try { l(); } catch { /* ignore */ } }
    entry.listeners.clear();
    return entry.track;
  })();
  return entry.promise;
}

// The track now, or null while it loads (kicks the load; `onReady` fires once when it lands).
export function recordingCursorTrackNow(url, onReady) {
  if (!url) return null;
  const entry = tracks.get(url);
  if (entry?.status === 'ready') return entry.track;
  if (entry?.status === 'failed') return null;
  loadRecordingCursorTrack(url);
  if (onReady) tracks.get(url).listeners.add(onReady);
  return null;
}

// ── Plan ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// The helper's shape ids → our art (smartZoomCursors). App-specific pictures keep their id (drawn from the PNG).
const SHAPE_ART = {
  arrow: 'arrow',
  pointingHand: 'pointingHand',
  iBeam: 'iBeam',
  iBeamVertical: 'iBeamVertical',
  crosshair: 'crosshair',
  openHand: 'openHand',
  closedHand: 'closedHand',
  resizeLeftRight: 'resizeLeftRight',
  columnResize: 'resizeLeftRight',
  resizeUpDown: 'resizeUpDown',
  rowResize: 'resizeUpDown',
  operationNotAllowed: 'notAllowed',
};
const artFor = (id) => (typeof id === 'string' && id.startsWith('custom-') ? id : SHAPE_ART[id] || 'arrow');

// clip.recordingMeta (clicks, the light path) + the full track (the hand's whole path and its shapes) → a take.
function takeFor(meta, full) {
  const take = takeFromEventTrack(meta, (Number(meta?.durationSec) || 0) * 1000);
  if (!take) return null;
  if (full) {
    const n = Math.min(full.t.length, full.x.length, full.y.length);
    const s = Array.isArray(full.s) && full.s.length >= n ? full.s : null;
    take.moves = { t: full.t.slice(0, n), x: full.x.slice(0, n), y: full.y.slice(0, n), s: s ? s.slice(0, n) : new Array(n).fill(0) };
    take.shapes = (Array.isArray(full.shapes) && full.shapes.length ? full.shapes : [{ id: 'arrow' }]).map((sh) => artFor(sh?.id));
    if (full.screen?.width > 0 && full.screen?.height > 0) {
      take.width = full.screen.width;
      take.height = full.screen.height;
    }
  }
  return take;
}

const plans = new Map(); // key → plan (a handful at most: one per recording × look)
export function recordingCursorPlan(clip, item, full) {
  const s = recordingCursorSettings(item);
  const key = `${clip.id}|${clip.recordingTrackUrl || ''}|${full ? 'full' : 'light'}|${JSON.stringify(s)}`;
  let plan = plans.get(key);
  if (plan) return plan;
  const take = takeFor(clip.recordingMeta, full);
  if (!take || !take.moves.t.length) return null;
  plan = buildCursorPlan({ take, settings: s });
  plan.look = s;
  plan.images = full?.images || {};
  if (plans.size > 24) plans.clear();
  plans.set(key, plan);
  return plan;
}

// ── The sprite ───────────────────────────────────────────────────────────────────────────────────────────────────
const _now = {};
const _at = {};

// The cursor at source time `tMs`, laid out in the picture's pixels (texW × texH, top-left origin): the samples to
// draw (one, or a short trail for motion blur) and their bounding box. null = nothing to draw.
export function recordingCursorFrame(plan, tMs, texW, texH) {
  const c = evalCursor(plan, tMs, _now);
  if (!(c.opacity > 0.002)) return null;
  const look = plan.look;
  const perPoint = texW / Math.max(1, plan.width);
  const size = Math.max(4, (Number(look.size) || 1.5) * 24 * perPoint) * c.scale;
  // Motion blur: the cursor over the last half frame at 60 fps (8 ms × motionBlur), as a short trail of samples.
  const exposure = 8 * (Number.isFinite(look.motionBlur) ? look.motionBlur : 1);
  let samples = [{ x: c.x * texW, y: c.y * texH, a: c.opacity, angle: c.angle, scale: 1 }];
  if (exposure > 0.5) {
    const p0 = evalCursor(plan, tMs - exposure, _at);
    const dist = Math.hypot((p0.x - c.x) * texW, (p0.y - c.y) * texH);
    const n = Math.min(12, Math.floor(dist / Math.max(1.5, size * 0.06)));
    if (n >= 2) {
      samples = [];
      for (let i = 0; i < n; i += 1) {
        const t = tMs - exposure * (1 - i / (n - 1));
        const p = i === n - 1 ? c : evalCursor(plan, t, _at);
        samples.push({ x: p.x * texW, y: p.y * texH, a: p.opacity / n, angle: p.angle, scale: p.scale / c.scale });
      }
    }
  }
  const reach = size * 1.15 + 6; // the art (24-unit box from its hotspot either way), its shadow and a click ring
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of samples) {
    x0 = Math.min(x0, p.x - reach); y0 = Math.min(y0, p.y - reach);
    x1 = Math.max(x1, p.x + reach); y1 = Math.max(y1, p.y + reach);
  }
  if (x1 < 0 || y1 < 0 || x0 > texW || y0 > texH) return null; // wholly outside the picture (an Area take)
  return { shape: c.shape, ring: c.ring, size, samples, box: { x0, y0, x1, y1 } };
}

// A cheap fingerprint of what the sprite would paint (unchanged → no repaint, no upload).
export function recordingCursorKey(frame) {
  if (!frame) return '';
  let k = `${frame.shape}|${frame.size.toFixed(2)}|${frame.ring.toFixed(3)}`;
  for (const p of frame.samples) k += `|${p.x.toFixed(2)},${p.y.toFixed(2)},${p.a.toFixed(3)},${p.angle.toFixed(1)},${p.scale.toFixed(3)}`;
  return k;
}

// Paint the frame onto a 2D canvas whose top-left sits at picture pixel (ox, oy).
export function paintRecordingCursor(ctx, frame, ox, oy, images = {}) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const pic = images[frame.shape] || null;
  const many = frame.samples.length > 1;
  ctx.globalCompositeOperation = many ? 'lighter' : 'source-over'; // a trail = the average of its samples
  for (const p of frame.samples) {
    const x = p.x - ox;
    const y = p.y - oy;
    const size = frame.size * p.scale;
    if (pic) {
      drawCustomCursor(ctx, pic, x, y, size, p);
    } else if (frame.shape === 'iBeamVertical') {
      drawCursorArt(ctx, 'iBeam', x, y, size, (p.angle || 0) + 90, p.a);
    } else {
      drawCursorArt(ctx, frame.shape, x, y, size, p.angle, p.a);
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  if (frame.ring >= 0) {
    const last = frame.samples[frame.samples.length - 1];
    drawCursorRing(ctx, last.x - ox, last.y - oy, frame.size, frame.ring);
  }
}

// An app's own cursor picture, at its logged size (points) and hotspot, scaled like our art.
function drawCustomCursor(ctx, pic, x, y, size, p) {
  const img = pic.img;
  const k = size / 24; // our art: `size` px per 24 points
  const wPt = pic.size?.w || img.naturalWidth / 2;
  const hPt = pic.size?.h || img.naturalHeight / 2;
  const hx = pic.hotspot?.x ?? 0;
  const hy = pic.hotspot?.y ?? 0;
  ctx.save();
  ctx.globalAlpha = p.a;
  ctx.translate(x, y);
  if (p.angle) ctx.rotate((p.angle * Math.PI) / 180);
  ctx.drawImage(img, -hx * k, -hy * k, wPt * k, hPt * k);
  ctx.restore();
}
