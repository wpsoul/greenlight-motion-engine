// The converting half of legacyTextAnimation.js — imported only when a state or an
// item list actually carries Text Animation (its own chunk, with the converter).
import { migrateItem } from './textAnimatorConvert.js';
import { getTimelineDuration } from './speedUtils.js';
import { resolveTextFontSize } from './types.js';
import { itemHasLegacyTextAnimation } from './legacyTextAnimation.js';

function makeConverter(videoSize, stats) {
  // Undo steps repeat the same item (shared in memory, equal on disk): one
  // conversion per object, and equal items convert to equal results anyway.
  const done = new WeakMap();
  return (item) => {
    if (!itemHasLegacyTextAnimation(item)) return item;
    if (done.has(item)) return done.get(item);
    const span = Math.max(0.05, (Number(item.trimEnd) || 0) - (Number(item.trimStart) || 0));
    const { item: out, changed, notes } = migrateItem(item, {
      clipSec: getTimelineDuration(span, item.speedPoints),
      fontPx: resolveTextFontSize(item, videoSize?.h),
    });
    if (changed) stats.migrated += 1;
    for (const n of notes) stats.notes.add(n);
    done.set(item, out);
    return out;
  };
}

const mapChannels = (channels, fn) => channels.map((ch) => (
  ch && Array.isArray(ch.items) ? { ...ch, items: ch.items.map(fn) } : ch
));

// `videoSize` = the composition the items are laid out in (a nested sequence has none
// of its own).
export function migrateStateTextAnimation(state, videoSize = state?.videoSize) {
  const stats = { migrated: 0, notes: new Set() };
  const convert = makeConverter(videoSize, stats);
  const walk = (st) => {
    if (!st || typeof st !== 'object') return st;
    const out = { ...st };
    if (Array.isArray(st.channels)) out.channels = mapChannels(st.channels, convert);
    const history = st.historyState?.history;
    if (Array.isArray(history)) {
      out.historyState = {
        ...st.historyState,
        history: history.map((entry) => {
          if (!Array.isArray(entry)) return entry;
          // v2: a channel list; v1: a flat item list.
          return entry.some((x) => Array.isArray(x?.items)) ? mapChannels(entry, convert) : entry.map(convert);
        }),
      };
    }
    if (Array.isArray(st.clips)) {
      out.clips = st.clips.map((c) => (c?.sequence && typeof c.sequence === 'object' ? { ...c, sequence: walk(c.sequence) } : c));
    }
    return out;
  };
  const next = walk(state);
  if (stats.notes.size) console.info('[Text Animation → Advanced Animations]', [...stats.notes].join(' · '));
  return { state: stats.migrated ? next : state, migrated: stats.migrated };
}

export function migrateTextItems(items, videoSize) {
  const stats = { migrated: 0, notes: new Set() };
  return items.map(makeConverter(videoSize, stats));
}
