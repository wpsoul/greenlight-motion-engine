// Text Animation (the split In/Out, Leading Highlight and Caret of a text layer) is
// gone; Advanced Animations (textAnimators) does all of it. A stored project, a
// pasted layer or an agent's JSON may still carry it: such a state is converted
// ONCE, before it is normalized (the sanitizer no longer knows those fields).
//
// This module only DETECTS it — a few field reads per text item, once per load,
// never per frame. The converter (textAnimatorConvert.js + the engine and preset
// catalogue it builds with) is imported only when something is found, so a project
// without Text Animation never loads it.

// A text item that still uses Text Animation, or the layout Split By gave it.
export function itemHasLegacyTextAnimation(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.textSplitEnabled === true || item.textHighlightEnabled === true || item.textCaretEnabled === true) return true;
  if (item.textSplitMode === 'lines' || item.textSplitMode === 'symbols') return true;
  const pk = item.propertyKeyframes;
  return !!(pk && typeof pk === 'object' && (pk.textRevealProgress || pk.textHighlightColor));
}

// Every channel list of an editor state: the timeline (template `channels`, or
// every undo step of `historyState.history`), and the nested ones of its sequence
// and grid clips.
function forEachChannelList(state, fn) {
  if (!state || typeof state !== 'object') return;
  if (Array.isArray(state.channels)) fn(state.channels);
  const history = state.historyState?.history;
  if (Array.isArray(history)) {
    for (const entry of history) {
      // v2: an entry is a channel list; v1: a flat item list.
      if (Array.isArray(entry) && entry.some((x) => Array.isArray(x?.items))) fn(entry);
      else if (Array.isArray(entry)) fn([{ items: entry }]);
    }
  }
  for (const clip of Array.isArray(state.clips) ? state.clips : []) {
    if (clip?.sequence && typeof clip.sequence === 'object') forEachChannelList(clip.sequence, fn);
  }
}

export function stateHasLegacyTextAnimation(state) {
  let found = false;
  forEachChannelList(state, (channels) => {
    if (found) return;
    for (const ch of channels) {
      for (const item of Array.isArray(ch?.items) ? ch.items : []) {
        if (itemHasLegacyTextAnimation(item)) { found = true; return; }
      }
    }
  });
  return found;
}

// The state with every legacy text item converted (a new object; the input is not
// touched). Resolves to the SAME object when there is nothing to convert, without
// loading the converter. `migrated` = items rewritten (0 = untouched).
export async function migrateLegacyTextAnimation(state) {
  if (!stateHasLegacyTextAnimation(state)) return { state, migrated: 0 };
  const { migrateStateTextAnimation } = await import('./legacyTextAnimationMigrate.js');
  return migrateStateTextAnimation(state);
}

// Items on their own (paste, layer presets), each converted as on a timeline of
// `videoSize`. Same contract: nothing legacy → the same array, nothing loaded.
export async function migrateLegacyTextItems(items, videoSize) {
  if (!Array.isArray(items) || !items.some(itemHasLegacyTextAnimation)) return items;
  const { migrateTextItems } = await import('./legacyTextAnimationMigrate.js');
  return migrateTextItems(items, videoSize);
}

// The layer clipboard (clipboard.js: { kind: 've-items', entries: [{ item, clip }] }),
// copied sequences included.
export function clipboardHasLegacyTextAnimation(payload) {
  return Array.isArray(payload?.entries) && payload.entries.some((e) => (
    itemHasLegacyTextAnimation(e?.item) || (e?.clip?.sequence && stateHasLegacyTextAnimation(e.clip.sequence))
  ));
}

export async function migrateLegacyClipboard(payload, videoSize) {
  if (!clipboardHasLegacyTextAnimation(payload)) return payload;
  const { migrateTextItems, migrateStateTextAnimation } = await import('./legacyTextAnimationMigrate.js');
  const items = migrateTextItems(payload.entries.map((e) => e?.item), videoSize);
  return {
    ...payload,
    entries: payload.entries.map((e, i) => ({
      ...e,
      item: items[i],
      clip: e?.clip?.sequence ? { ...e.clip, sequence: migrateStateTextAnimation(e.clip.sequence, videoSize).state } : e?.clip,
    })),
  };
}
