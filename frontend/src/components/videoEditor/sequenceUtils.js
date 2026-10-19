// Helpers for "Sequence" clips (CapCut-style compound clips): grouping a timeline
// selection into one nested clip, dissolving it back, and walking/remapping the
// nested payloads. A sequence clip looks like:
//   { id, mediaType: 'sequence', duration, sequence: { clips: [...], channels: [...] } }
// and nests recursively (a nested clip may itself be a sequence).
import { getTimelineLayout } from './speedUtils';
import { remapParentingIds, repairParentingReferences } from './keyframeParenting';
import { remapTrackMatteIds, repairTrackMatteReferences } from './trackMatte';
import { remapMotionFollowIds } from './motionTracking';
import { TransitionType, isContainerClip } from './types';
import { CAMERA_CHANNEL_KIND } from './projectCamera';

const EPS = 1e-4;

/**
 * Channels the timeline's "Clean" button sweeps: the ones holding nothing.
 *
 * Grouping into a grid or a sequence, deleting layers and ejecting members all
 * leave a row behind that holds nothing and means nothing. Two rows are spared:
 * the camera channel (it is the project camera, empty or not) and the last one
 * standing, so a project always has somewhere to drop a clip.
 */
export function emptyChannelIds(channels) {
  const list = Array.isArray(channels) ? channels : [];
  const ids = list
    .filter((ch) => !ch.items?.length && ch.kind !== CAMERA_CHANNEL_KIND)
    .map((ch) => ch.id);
  // Never take every channel — drop the last candidate rather than the timeline.
  return ids.length >= list.length ? ids.slice(0, Math.max(0, list.length - 1)) : ids;
}

function createId() {
  return crypto.randomUUID();
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Nesting depth of a clip: 0 for plain clips, 1 for a container of plain clips,
// etc. Counts EVERY container kind (sequence and grid alike) — they each cost one
// offscreen render pass, which is what SEQUENCE_MAX_DEPTH bounds.
export function sequenceDepth(clip) {
  if (!isContainerClip(clip)) return 0;
  let maxChild = 0;
  for (const c of clip.sequence.clips || []) {
    maxChild = Math.max(maxChild, sequenceDepth(c));
  }
  return 1 + maxChild;
}

// All clip defs reachable from `clips`, including those nested inside containers
// (sequences and grids). Used wherever the editor needs to touch every media URL
// (validation, proxy hydration, render warm-up) — a container kind missing here
// exports blank cells while the preview looks perfect.
export function flattenClips(clips) {
  const out = [];
  const walk = (list) => {
    for (const clip of list || []) {
      if (!clip) continue;
      out.push(clip);
      if (isContainerClip(clip)) walk(clip.sequence.clips);
    }
  };
  walk(clips);
  return out;
}

// Fresh ids for every clip/channel/item in a sequence payload (recursively), so the
// same preset can be inserted twice without id collisions. Returns a new payload.
export function remapSequenceIds(sequence) {
  const payload = deepClone(sequence || { clips: [], channels: [] });
  const remapLevel = (level) => {
    const clipIdMap = new Map();
    for (const clip of level.clips || []) {
      const newId = createId();
      clipIdMap.set(clip.id, newId);
      clip.id = newId;
      if (isContainerClip(clip)) remapLevel(clip.sequence);
    }
    // Parenting links other items by id, so the remap has to happen in two passes:
    // mint every new id first, then rewrite the references to point at the copies.
    const itemIdMap = new Map();
    for (const ch of level.channels || []) {
      for (const item of ch.items || []) {
        if (item?.id) itemIdMap.set(item.id, createId());
      }
    }
    for (const ch of level.channels || []) {
      ch.id = createId();
      ch.items = (ch.items || []).map((item) => {
        const next = remapMotionFollowIds(remapTrackMatteIds(remapParentingIds(item, itemIdMap), itemIdMap), itemIdMap);
        next.id = itemIdMap.get(item.id) || createId();
        next.clipId = clipIdMap.get(item.clipId) || item.clipId;
        return next;
      });
    }
  };
  remapLevel(payload);
  return payload;
}

// Layout entries for the selected items across all channels.
// Returns [{ item, channel, channelIndex, itemIndex, startTime, endTime }].
// Exported for gridUtils, which groups the same selection by a different rule.
export function collectSelectionEntries(channels, selectedIds) {
  const wanted = new Set(selectedIds);
  const entries = [];
  channels.forEach((channel, channelIndex) => {
    const layout = getTimelineLayout(channel.items, { unsnapped: channel.unsnapped });
    channel.items.forEach((item, itemIndex) => {
      if (!wanted.has(item.id)) return;
      const l = layout[itemIndex];
      if (!l) return;
      entries.push({ item, channel, channelIndex, itemIndex, startTime: l.startTime, endTime: l.endTime });
    });
  });
  return entries;
}

// Group the selected items into a single sequence clip + timeline item.
// `makeItem(clipId, duration)` must return a fresh timeline item with editor defaults
// (VideoEditor passes its own makeTimelineItem so item defaults stay in one place).
// Returns { seqClip, seqItem, newChannels } or { error }.
export function buildSequenceFromSelection({ channels, clips, selectedIds, makeItem, name = 'Sequence' }) {
  const entries = collectSelectionEntries(channels, selectedIds);
  if (entries.length < 1) return { error: 'Nothing selected' };

  const seqStart = Math.min(...entries.map((e) => e.startTime));
  const seqEnd = Math.max(...entries.map((e) => e.endTime));
  const duration = Math.max(0.1, seqEnd - seqStart);

  const clipById = new Map(clips.map((c) => [c.id, c]));

  // Build inner channels: one per source channel that holds selected items,
  // preserving z-order and kind. Inner channels are free-positioned so every
  // item keeps its exact visual timing — except a contiguous snapped run that
  // starts exactly at the sequence start, which stays snapped so the cross
  // transitions inside it keep working.
  const byChannel = new Map();
  for (const e of entries) {
    if (!byChannel.has(e.channelIndex)) byChannel.set(e.channelIndex, []);
    byChannel.get(e.channelIndex).push(e);
  }

  const innerChannels = [];
  const innerClipIds = new Set();
  for (const channelIndex of [...byChannel.keys()].sort((a, b) => a - b)) {
    const chEntries = byChannel.get(channelIndex).sort((a, b) => a.itemIndex - b.itemIndex);
    const srcChannel = chEntries[0].channel;

    let keepSnapped = false;
    if (!srcChannel.unsnapped) {
      const indices = chEntries.map((e) => e.itemIndex);
      const contiguous = indices.every((idx, i) => i === 0 || idx === indices[i - 1] + 1);
      keepSnapped = contiguous && Math.abs(chEntries[0].startTime - seqStart) < EPS;
    }

    const items = chEntries.map((e) => {
      innerClipIds.add(e.item.clipId);
      const copy = deepClone(e.item);
      if (keepSnapped) {
        delete copy.freeStart;
        return copy;
      }
      copy.freeStart = Math.max(0, e.startTime - seqStart);
      // Cross transitions are inert on free-positioned channels.
      copy.transition = TransitionType.NONE;
      return copy;
    });

    innerChannels.push({
      id: createId(),
      name: srcChannel.name,
      visible: true,
      unsnapped: !keepSnapped,
      ...(srcChannel.kind ? { kind: srcChannel.kind } : {}),
      items,
    });
  }

  // Parenting is scoped to one editing level: a link survives grouping only when
  // BOTH layers came inside. Anything pointing at a layer left behind is detached
  // here rather than becoming a stale cross-level id.
  const scopedInnerChannels = repairTrackMatteReferences(repairParentingReferences(innerChannels));

  const innerClips = [...innerClipIds]
    .map((id) => clipById.get(id))
    .filter(Boolean)
    .map(deepClone);

  const seqClip = {
    id: createId(),
    source: 'REMOTE',
    mediaType: 'sequence',
    url: '',
    proxyUrl: null,
    thumbnailUrl: null,
    name,
    duration,
    sequence: { clips: innerClips, channels: scopedInnerChannels },
  };

  const seqItem = { ...makeItem(seqClip.id, duration) };

  // Place the sequence item on the topmost affected channel if it's free-positioned;
  // otherwise insert a new free channel at that z position.
  const selectedIdSet = new Set(selectedIds);
  const topmostIndex = Math.min(...byChannel.keys());
  const stripped = channels.map((ch) => ({
    ...ch,
    items: ch.items.filter((item) => !selectedIdSet.has(item.id)),
  }));

  let newChannels;
  if (stripped[topmostIndex]?.unsnapped) {
    seqItem.freeStart = seqStart;
    newChannels = stripped.map((ch, i) =>
      i === topmostIndex
        ? { ...ch, items: [...ch.items, seqItem].sort((a, b) => (a.freeStart ?? 0) - (b.freeStart ?? 0)) }
        : ch
    );
  } else {
    seqItem.freeStart = seqStart;
    const holder = {
      id: createId(),
      name,
      visible: true,
      unsnapped: true,
      items: [seqItem],
    };
    newChannels = [...stripped.slice(0, topmostIndex), holder, ...stripped.slice(topmostIndex)];
  }

  return { seqClip, seqItem, newChannels };
}

function isFlatSpeed(speedPoints) {
  return !Array.isArray(speedPoints) || speedPoints.every((p) => Math.abs((p?.y ?? 1) - 1) < EPS);
}

// Dissolve a CONTAINER item (sequence or grid) back into the parent timeline,
// preserving visual timing. Only supported when the container item plays at flat
// speed (the UI disables the button otherwise). Returns { newChannels,
// mergedClips } or { error }.
//
// Ungrouping a grid needs nothing extra: the grid supplies its members' PRS at
// render time and never writes to their stored panX/zoom/rotate, so restoring the
// items restores exactly the transforms they had before they went in.
export function ungroupSequence({ channels, clips, seqItemId }) {
  let seqChannelIndex = -1;
  let seqItem = null;
  let seqItemStart = 0;
  channels.forEach((channel, channelIndex) => {
    const layout = getTimelineLayout(channel.items, { unsnapped: channel.unsnapped });
    channel.items.forEach((item, itemIndex) => {
      if (item.id === seqItemId) {
        seqChannelIndex = channelIndex;
        seqItem = item;
        seqItemStart = layout[itemIndex]?.startTime ?? 0;
      }
    });
  });
  if (!seqItem) return { error: 'Sequence item not found' };

  const seqClip = clips.find((c) => c.id === seqItem.clipId);
  if (!isContainerClip(seqClip)) return { error: 'Not a container clip' };
  if (!isFlatSpeed(seqItem.speedPoints)) return { error: 'Ungroup requires flat speed on this layer' };

  const trimStart = seqItem.trimStart ?? 0;
  const trimEnd = seqItem.trimEnd ?? seqClip.duration;

  // Merge inner clip defs into the parent's clips. On id collision with a different
  // def, remap the inner clip to a new id.
  const parentClipById = new Map(clips.map((c) => [c.id, c]));
  const mergedClips = [...clips];
  const clipIdRemap = new Map();
  for (const innerClip of seqClip.sequence.clips) {
    const existing = parentClipById.get(innerClip.id);
    if (!existing) {
      mergedClips.push(deepClone(innerClip));
    } else if (JSON.stringify(existing) !== JSON.stringify(innerClip)) {
      const copy = deepClone(innerClip);
      copy.id = createId();
      clipIdRemap.set(innerClip.id, copy.id);
      mergedClips.push(copy);
    }
  }

  const flat = [{ x: 0, y: 1 }, { x: 1, y: 1 }];
  const restoredChannels = [];
  // Restored items get fresh ids, so parenting has to be rewired to the copies.
  // Minted up front (before any item is built) because a child can be restored
  // before its parent. A link whose parent falls outside the trim window is
  // dropped by remapParentingIds — its target never makes it back to the timeline.
  const itemIdRemap = new Map();
  for (const innerChannel of seqClip.sequence.channels) {
    const layout = getTimelineLayout(innerChannel.items, { unsnapped: innerChannel.unsnapped });
    innerChannel.items.forEach((innerItem, i) => {
      const l = layout[i];
      if (!l) return;
      if (Math.min(l.endTime, trimEnd) - Math.max(l.startTime, trimStart) < 0.05) return;
      if (innerItem?.id) itemIdRemap.set(innerItem.id, createId());
    });
  }
  for (const innerChannel of seqClip.sequence.channels) {
    const layout = getTimelineLayout(innerChannel.items, { unsnapped: innerChannel.unsnapped });
    const items = [];
    innerChannel.items.forEach((innerItem, i) => {
      const l = layout[i];
      if (!l) return;
      const visibleStart = Math.max(l.startTime, trimStart);
      const visibleEnd = Math.min(l.endTime, trimEnd);
      if (visibleEnd - visibleStart < 0.05) return; // fully outside the trim window

      const copy = remapMotionFollowIds(remapTrackMatteIds(remapParentingIds(deepClone(innerItem), itemIdRemap), itemIdRemap), itemIdRemap);
      copy.id = itemIdRemap.get(innerItem.id) || createId();
      copy.clipId = clipIdRemap.get(copy.clipId) || copy.clipId;
      copy.transition = TransitionType.NONE;

      // Clip boundary items to the sequence trim window (linear source mapping,
      // same approach as sliceItemAtRange — speed resets to flat when sliced).
      if (visibleStart > l.startTime + EPS || visibleEnd < l.endTime - EPS) {
        const span = copy.trimEnd - copy.trimStart;
        const srcAt = (t) => copy.trimStart + ((t - l.startTime) / l.duration) * span;
        copy.trimStart = srcAt(visibleStart);
        copy.trimEnd = srcAt(visibleEnd);
        copy.speedPoints = flat;
      }

      copy.freeStart = Math.max(0, seqItemStart + (visibleStart - trimStart));
      items.push(copy);
    });
    if (!items.length) continue;
    restoredChannels.push({
      id: createId(),
      name: innerChannel.name,
      visible: true,
      unsnapped: true,
      ...(innerChannel.kind ? { kind: innerChannel.kind } : {}),
      items: items.sort((a, b) => (a.freeStart ?? 0) - (b.freeStart ?? 0)),
    });
  }

  const withoutSeq = channels.map((ch) => ({
    ...ch,
    items: ch.items.filter((item) => item.id !== seqItemId),
  }));
  const newChannels = [
    ...withoutSeq.slice(0, seqChannelIndex),
    ...restoredChannels,
    ...withoutSeq.slice(seqChannelIndex),
  ];

  return { newChannels, mergedClips };
}

// Drop clip defs no timeline item references (at the current level). Run at save
// time to clean up orphans left by undoing a group/ungroup (clips aren't part of
// the undo history).
export function collectReferencedClipIds(channels) {
  const ids = new Set();
  for (const ch of channels || []) {
    for (const item of ch.items || []) ids.add(item.clipId);
  }
  return ids;
}
