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

/** The picture layers of CHANNELS (top level) in the order they start playing: [{ item, clip, start, channelId }].
 *  { deep: true } also walks into sequence clips (any depth): an inner picture starts at its sequence item's start +
 *  its own start inside (minus the item's in-point) and carries `container` = { itemId, clipId } — the TOP-LEVEL item
 *  that plays it — and `path` (the sequence items above it, outermost first). Inside an Essential template only its
 *  photo-slot layers are listed (essential.recipe.slots): the builder's other copies of a picture are not slots. */
export function pictureLayers(channels, clips, { deep = false } = {}) {
  const out = [];
  const walk = (chans, clipList, offset, container, path, seen) => {
    const byId = new Map((clipList || []).map((c) => [c.id, c]));
    (chans || []).forEach((ch, chIndex) => {
      const items = Array.isArray(ch?.items) ? ch.items : [];
      const layout = getTimelineLayout(items, { unsnapped: ch.unsnapped });
      items.forEach((item, i) => {
        const clip = byId.get(item?.clipId);
        const start = offset + (layout[i]?.startTime ?? 0);
        if (clip?.mediaType === 'image') {
          if (container?.only && !container.only.has(item.id)) return;
          out.push({ item, clip, start, channelId: ch.id, chIndex, depth: path.length, ...(container ? { container: { itemId: container.itemId, clipId: container.clipId }, path } : {}) });
        } else if (deep && clip?.mediaType === 'sequence' && clip.sequence && !seen.has(clip.id) && path.length < 4) {
          const rec = clip.essential?.recipe;
          const only = rec && rec.slots && typeof rec.editId === 'string'
            ? new Set(Object.values(rec.slots).map((sl) => sl && sl.itemId).filter(Boolean)) : null;
          const top = container || { itemId: item.id, clipId: clip.id };
          walk(clip.sequence.channels, clip.sequence.clips, start - (Number(item.trimStart) || 0), { ...top, only }, [...path, item.id], new Set([...seen, clip.id]));
        } else if (deep && clip?.mediaType === 'grid' && clip.sequence && container?.only && !seen.has(clip.id) && path.length < 4) {
          // a Grid a script template made (PLANS/ESSENTIAL_TEMPLATES.md §13): its members are the template's slots too
          walk(clip.sequence.channels, clip.sequence.clips, start - (Number(item.trimStart) || 0), container, [...path, item.id], new Set([...seen, clip.id]));
        }
      });
    });
  };
  walk(channels, clips, 0, null, [], new Set());
  // play order; at the same moment the upper track first (the timeline lists the last channel on top), outer first
  return out.sort((a, b) => (a.start - b.start) || (a.depth - b.depth) || (b.chIndex - a.chIndex));
}

/** The slots of CHANNELS in play order: [{ item, clip, start, slot, n?, of? }] — n / of number the series. */
export function photoSlotLayers(channels, clips, slotOf = (item) => sanitizePhotoSlot(item?.photoSlot), { deep = false } = {}) {
  const list = pictureLayers(channels, clips, { deep }).map((p) => ({ ...p, slot: slotOf(p.item) })).filter((p) => p.slot);
  const series = list.filter((p) => p.slot.series);
  series.forEach((p, i) => { p.n = i + 1; p.of = series.length; });
  return list;
}

/** item id → { text, title } for the timeline's SLOT badges. Slots inside a sequence (an Essential template's photo
 *  slots) badge the top-level item that plays them: "SLOTS 3–8". */
export function photoSlotBadges(channels, clips, settings) {
  const label = sanitizePhotoSlotSettings(settings).label;
  const out = new Map();
  const inner = new Map();   // container item id → [slot layers]
  for (const p of photoSlotLayers(channels, clips, undefined, { deep: true })) {
    if (p.container) { if (!inner.has(p.container.itemId)) inner.set(p.container.itemId, []); inner.get(p.container.itemId).push(p); continue; }
    const where = p.n ? ` ${p.n} of ${p.of} in “${label}”` : ' on its own';
    out.set(p.item.id, {
      text: p.n ? `SLOT ${p.n}` : 'SLOT',
      title: `Photo slot${where} — people can put their own photo here (set in Export for agents). Deleting this layer removes the slot.`,
    });
  }
  for (const [itemId, list] of inner) {
    const ns = list.map((p) => p.n).filter(Boolean);
    const lo = ns.length ? Math.min(...ns) : 0, hi = ns.length ? Math.max(...ns) : 0;
    const text = list.length === 1 ? (lo ? `SLOT ${lo}` : 'SLOT') : (lo ? `SLOTS ${lo}–${hi}` : `${list.length} SLOTS`);
    out.set(itemId, {
      text,
      title: `${list.length === 1 ? 'A photo slot' : `${list.length} photo slots`} inside this sequence${lo ? ` (${lo === hi ? lo : `${lo}–${hi}`} of ${list[0].of} in “${label}”)` : ''} — people can put their own photos there (set in Export for agents).`,
    });
  }
  return out;
}

/**
 * Write photo-slot marks (item id → mark, or null = not a slot) on picture layers at any depth → { channels, clips,
 * changed }: top-level layers in place; a layer inside a sequence through a NEW version of that sequence (and of every
 * sequence above it), so it is one history step and undo restores the old clips. Inside an Essential template the
 * marks are written on its layers and the template is rebuilt (`rebuild(clip) → clip`: its recipe.slots takes them,
 * and the photo is fitted again around a moved focus point). createId names the new versions of plain sequences.
 */
export function writePhotoSlotMarks(channels, clips, marks, { rebuild = null, createId } = {}) {
  const ids = new Set(Object.keys(marks || {}));
  const added = [];
  let changed = false;
  const setMark = (it) => {
    if (!ids.has(it.id)) return it;
    const slot = marks[it.id];
    if (slot) { if (JSON.stringify(slot) === JSON.stringify(it.photoSlot)) return it; changed = true; return { ...it, photoSlot: slot }; }
    if (!it.photoSlot) return it;
    changed = true;
    const { photoSlot: _dropped, ...rest } = it;
    return rest;
  };
  // a sequence clip with the marks written inside it (null when nothing inside changed)
  const intoSequence = (clip, depth, inTemplate = false) => {
    if (!clip?.sequence || depth > 4) return null;
    const before = changed;
    changed = false;
    const innerClips = clip.sequence.clips || [];
    const template = inTemplate || !!clip.essential?.recipe?.editId;
    let innerAdded = [];
    const chans = (clip.sequence.channels || []).map((ch) => ({ ...ch, items: (ch.items || []).map((it) => {
      const c = innerClips.find((x) => x.id === it.clipId);
      // a Grid inside a script template (§13) holds slots too
      if (c?.mediaType === 'sequence' || (c?.mediaType === 'grid' && template)) {
        const nc = intoSequence(c, depth + 1, template);
        if (nc) { innerAdded.push(nc); changed = true; return { ...it, clipId: nc.id }; }
      }
      return setMark(it);
    }) }));
    const mine = changed;
    changed = before || mine;
    if (!mine) return null;
    // a Grid inside a template keeps its id (ids there are the template's own; the template gets a new version)
    const keepId = inTemplate && clip.mediaType === 'grid';
    let next = { ...clip, sequence: { clips: [...innerAdded.filter((n) => !innerClips.some((x) => x.id === n.id)), ...innerClips.map((x) => innerAdded.find((n) => n.id === x.id) || x)], channels: chans } };
    delete next.prerender;
    if (next.essential?.recipe?.editId && typeof rebuild === 'function') next = rebuild(next);
    else if (!keepId) next = { ...next, id: createId() };
    return next;
  };
  const byId = new Map((clips || []).map((c) => [c.id, c]));
  const nextChannels = (channels || []).map((ch) => ({ ...ch, items: (ch.items || []).map((it) => {
    const c = byId.get(it.clipId);
    if (c?.mediaType === 'sequence') {
      const nc = intoSequence(c, 1);
      if (nc) { added.push(nc); return { ...it, clipId: nc.id }; }
    }
    return setMark(it);
  }) }));
  return { channels: nextChannels, clips: added, changed: changed || added.length > 0 };
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
