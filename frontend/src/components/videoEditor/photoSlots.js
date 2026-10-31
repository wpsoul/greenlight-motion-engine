/*
 * Photo slots — pictures people may replace with their own photos (Export for agents' Photo slots strip,
 * html/INTERFACE/photo-slots-lab variant B; the SLOT badges on the timeline). A slot is only a MARK on an ordinary
 * picture layer, `item.photoSlot`, so undo, copy and delete carry it with the layer and the renderer never sees it:
 *
 *   item.photoSlot = { fill: 'cover' | 'fit',     cover the layer's box (edges may be cut) or show all of the photo
 *                      focus: [x, y],              0–1 inside the photo: the point a Cover crop keeps in view
 *                      takes: 'image' | 'media',   a photo, or a photo or a video
 *                      series: true | false,       in the project's series (numbered in play order) or on its own
 *                      note: '…' }                 what belongs here, for the agent
 *   project photoSlotSettings = { label: 'Photos', ifFewer: 'reuse' | 'keep' }   the series' name, and what slots
 *                      with no photo of their own show when people bring fewer photos than slots (omitted while default)
 *
 * The box is the layer's own frame (its position and size), so moving or resizing the layer moves the slot.
 */
import { getTimelineLayout } from './speedUtils.js';

export const DEFAULT_PHOTO_SLOT_SETTINGS = Object.freeze({ label: 'Photos', ifFewer: 'reuse' });
const NOTE_MAX = 300;
const LABEL_MAX = 40;
const clamp01 = (v, d) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : d);

/** A layer's slot mark, cleaned; null when it is not a slot. */
export function sanitizePhotoSlot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const focus = Array.isArray(raw.focus) ? raw.focus : [];
  return {
    fill: raw.fill === 'fit' ? 'fit' : 'cover',
    focus: [clamp01(focus[0], 0.5), clamp01(focus[1], 0.5)],
    takes: raw.takes === 'media' ? 'media' : 'image',
    series: raw.series !== false,
    note: typeof raw.note === 'string' ? raw.note.slice(0, NOTE_MAX) : '',
  };
}

/** The project's series settings, cleaned (always an object). */
export function sanitizePhotoSlotSettings(raw) {
  const label = typeof raw?.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, LABEL_MAX) : DEFAULT_PHOTO_SLOT_SETTINGS.label;
  return { label, ifFewer: raw?.ifFewer === 'keep' ? 'keep' : 'reuse' };
}

export const isDefaultPhotoSlotSettings = (s) => s.label === DEFAULT_PHOTO_SLOT_SETTINGS.label && s.ifFewer === DEFAULT_PHOTO_SLOT_SETTINGS.ifFewer;

/** A picture's slot when it is first made one: a vector picture or a logo fits and stands on its own, a photo
 *  covers its box and joins the series. */
export function defaultPhotoSlot(clip, item) {
  const url = String(clip?.url || '').split('?')[0].toLowerCase();
  const name = `${item?.customName || ''} ${item?.name || ''} ${clip?.name || ''}`.toLowerCase();
  const art = /\.svg$/.test(url) || /\blogo\b/.test(name);
  return { fill: art ? 'fit' : 'cover', focus: [0.5, 0.5], takes: 'image', series: !art, note: '' };
}

/** The picture layers of CHANNELS (top level) in the order they start playing: [{ item, clip, start, channelId }]. */
export function pictureLayers(channels, clips) {
  const byId = new Map((clips || []).map((c) => [c.id, c]));
  const out = [];
  (channels || []).forEach((ch, chIndex) => {
    const items = Array.isArray(ch?.items) ? ch.items : [];
    const layout = getTimelineLayout(items, { unsnapped: ch.unsnapped });
    items.forEach((item, i) => {
      const clip = byId.get(item?.clipId);
      if (clip?.mediaType !== 'image') return;
      out.push({ item, clip, start: layout[i]?.startTime ?? 0, channelId: ch.id, chIndex });
    });
  });
  // play order; at the same moment the upper track first (the timeline lists the last channel on top)
  return out.sort((a, b) => (a.start - b.start) || (b.chIndex - a.chIndex));
}

/** The slots of CHANNELS in play order: [{ item, clip, start, slot, n?, of? }] — n / of number the series. */
export function photoSlotLayers(channels, clips, slotOf = (item) => sanitizePhotoSlot(item?.photoSlot)) {
  const list = pictureLayers(channels, clips).map((p) => ({ ...p, slot: slotOf(p.item) })).filter((p) => p.slot);
  const series = list.filter((p) => p.slot.series);
  series.forEach((p, i) => { p.n = i + 1; p.of = series.length; });
  return list;
}

/** item id → { text, title } for the timeline's SLOT badges. */
export function photoSlotBadges(channels, clips, settings) {
  const label = sanitizePhotoSlotSettings(settings).label;
  const out = new Map();
  for (const p of photoSlotLayers(channels, clips)) {
    const where = p.n ? ` ${p.n} of ${p.of} in “${label}”` : ' on its own';
    out.set(p.item.id, {
      text: p.n ? `SLOT ${p.n}` : 'SLOT',
      title: `Photo slot${where} — people can put their own photo here (set in Export for agents). Deleting this layer removes the slot.`,
    });
  }
  return out;
}

/** Where a picture layer sits in a W×H frame at rest (its static Position and Scale): { x, y, w, h } in px. An
 *  estimate for showing the slot's box — keyframes, rotation and 3D are left out. PLATE is the picture's drawn size
 *  at Scale 1 (imagePlate.js), or null for the frame. */
export function layerBoxAtRest(item, frameW, frameH, plate) {
  const zoom = Number(item?.zoom) > 0 ? Number(item.zoom) : 1;
  const sx = zoom * (Number(item?.scaleX) > 0 ? Number(item.scaleX) : 1);
  const sy = zoom * (Number(item?.scaleY) > 0 ? Number(item.scaleY) : 1);
  const w = (plate?.width || frameW) * sx;
  const h = (plate?.height || frameH) * sy;
  const cx = frameW / 2 + ((Number(item?.panX) || 0) / 100) * frameW;
  const cy = frameH / 2 + ((Number(item?.panY) || 0) / 100) * frameH;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}
