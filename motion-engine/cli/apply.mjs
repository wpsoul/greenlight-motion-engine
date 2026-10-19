// greenlight-motion apply — atomic, validated edit batches for a project (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md,
// Part 4 / Stage 4). An agent writes WHAT to change as a list of edits; every edit is checked against the project
// (the thing it names exists, a value keeps its type, ids stay unique, references still resolve), and either the
// whole batch applies or nothing does. Errors name the edit, the selector and a fix.
//
//   { "op": "set",      "item": "it1", "path": "textContent", "value": "Launch day" }
//   { "op": "set",      "clip": "c2", "path": "url", "value": "assets/photo.png" }
//   { "op": "set",      "channel": "ch1", "path": "visible", "value": false }
//   { "op": "set",      "project": true, "path": "videoSize.w", "value": 1080 }
//   { "op": "unset",    "item": "it1", "path": "propertyKeyframes.opacity" }
//   { "op": "keyframe", "item": "it1", "track": "translateX", "at": 50, "value": 120, "easing": "Power2.easeOut" }
//   { "op": "add",      "to": "clips", "value": { "id": "c9", "mediaType": "image", "url": "assets/a.png", … } }
//   { "op": "add",      "to": "channels", "value": { "id": "ch9", "items": [ … ] }, "at": 0 }
//   { "op": "add",      "to": { "channel": "ch1" }, "value": { "id": "it9", "clipId": "c9", … } }       (an item)
//   { "op": "add",      "to": { "item": "it1", "list": "effects" }, "value": { "id": "bloom", "eid": "fx-1" } }
//   { "op": "add",      "to": "sounds", "value": { "sfx": "standard-swoosh", "on": "it1", "at": "peak" } }
//   { "op": "remove",   "item": "it9" } | { "channel": "ch9" } | { "clip": "c9" } | { "sound": 0 }
//   { "op": "remove",   "effect": "fx-1", "item": "it1" }
//   { "op": "move",     "channel": "ch9", "to": 0 }                                (stack order: 0 = bottom)
//
// Items are found in every channel, nested sequences and grids included. `path` is a dot path; a number segment
// indexes an array. Pure: no files, no browser — the CLI reads and writes project.json around it.

export class EditError extends Error {
  constructor(index, message, hint) {
    super(`edit ${index + 1}: ${message}`);
    this.index = index;
    this.hint = hint || '';
  }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// every channel list in the project: the top level and each sequence / grid clip's own
function channelLists(project) {
  const lists = [{ owner: null, channels: project.channels || [] }];
  for (const clip of project.clips || []) walkClip(clip, lists);
  return lists;
}
function walkClip(clip, lists) {
  const seq = clip?.sequence;
  if (!seq) return;
  lists.push({ owner: clip.id, channels: seq.channels || [] });
  for (const inner of seq.clips || []) walkClip(inner, lists);
}
function allClips(project, out = []) {
  for (const clip of project.clips || []) {
    out.push(clip);
    const walk = (c) => { for (const inner of c?.sequence?.clips || []) { out.push(inner); walk(inner); } };
    walk(clip);
  }
  return out;
}
function allItems(project) {
  const out = [];
  for (const { channels } of channelLists(project)) {
    for (const ch of channels) for (const it of ch.items || []) out.push({ item: it, channel: ch });
  }
  return out;
}
const ids = (list) => list.map((x) => x.id).filter(Boolean);
const near = (want, have) => {
  const pick = have.filter((h) => h.toLowerCase().includes(String(want).toLowerCase().slice(0, 3)));
  return (pick.length ? pick : have).slice(0, 12).join(', ') || 'none';
};

function findItem(project, id, i) {
  const hit = allItems(project).find((x) => x.item.id === id);
  if (!hit) throw new EditError(i, `there is no item "${id}"`, `items: ${near(id, allItems(project).map((x) => x.item.id))}`);
  return hit;
}
function findChannel(project, id, i) {
  for (const { channels } of channelLists(project)) {
    const ch = channels.find((c) => c.id === id);
    if (ch) return { channel: ch, list: channels };
  }
  throw new EditError(i, `there is no channel "${id}"`, `channels: ${near(id, channelLists(project).flatMap((l) => ids(l.channels)))}`);
}
function findClip(project, id, i) {
  const clip = allClips(project).find((c) => c.id === id);
  if (!clip) throw new EditError(i, `there is no clip "${id}"`, `clips: ${near(id, ids(allClips(project)))}`);
  return clip;
}

// the object an edit addresses
function holder(project, e, i) {
  if (e.item != null) return findItem(project, e.item, i).item;
  if (e.clip != null) return findClip(project, e.clip, i);
  if (e.channel != null) return findChannel(project, e.channel, i).channel;
  if (e.sound != null) {
    const s = (project.sounds || [])[Number(e.sound)];
    if (!s) throw new EditError(i, `there is no sound ${e.sound}`, `the project has ${(project.sounds || []).length} sound cue(s), numbered from 0`);
    return s;
  }
  if (e.project) return project;
  throw new EditError(i, 'the edit names nothing to change', 'add one of: "item", "clip", "channel", "sound" or "project": true');
}

const splitPath = (p, i) => {
  if (typeof p !== 'string' || !p.trim()) throw new EditError(i, 'missing "path"', 'a dot path inside the target, e.g. "textContent" or "propertyKeyframes.opacity"');
  return p.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s));
};
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

function setPath(obj, segs, value, i, label) {
  let cur = obj;
  for (let k = 0; k < segs.length - 1; k += 1) {
    const s = segs[k];
    if (FORBIDDEN.has(s)) throw new EditError(i, `"${s}" is not a valid path segment`);
    if (cur[s] == null) {
      if (typeof s === 'number') throw new EditError(i, `${label}: index ${s} does not exist`, `the list has ${Array.isArray(cur) ? cur.length : 0} entries`);
      cur[s] = typeof segs[k + 1] === 'number' ? [] : {};
    } else if (typeof cur[s] !== 'object') {
      throw new EditError(i, `${label}: "${segs.slice(0, k + 1).join('.')}" is a ${kind(cur[s])}, not an object`, 'set the whole value one level up instead');
    }
    cur = cur[s];
  }
  const last = segs[segs.length - 1];
  if (FORBIDDEN.has(last)) throw new EditError(i, `"${last}" is not a valid path segment`);
  const old = cur[last];
  // a value keeps its kind: a number stays a number, a string a string (null/undefined may become anything)
  if (old != null && value != null && kind(old) !== kind(value)) {
    throw new EditError(i, `${label}: "${segs.join('.')}" holds a ${kind(old)}, the edit gives a ${kind(value)}`,
      kind(old) === 'number' ? 'give a number (no quotes, no unit)' : `give a ${kind(old)}`);
  }
  cur[last] = value;
}
function unsetPath(obj, segs, i, label) {
  let cur = obj;
  for (let k = 0; k < segs.length - 1; k += 1) {
    cur = cur?.[segs[k]];
    if (cur == null) return; // nothing there: already unset
  }
  if (Array.isArray(cur) && typeof segs[segs.length - 1] === 'number') cur.splice(segs[segs.length - 1], 1);
  else if (isObj(cur)) delete cur[segs[segs.length - 1]];
  else throw new EditError(i, `${label}: cannot unset inside a ${kind(cur)}`);
}

function addEdit(project, e, i) {
  const v = e.value;
  if (!isObj(v)) throw new EditError(i, '"value" must be an object', 'the new clip / channel / item / effect / sound');
  const at = (list) => (Number.isInteger(e.at) ? Math.max(0, Math.min(list.length, e.at)) : list.length);
  if (e.to === 'clips') {
    if (!v.id) throw new EditError(i, 'a new clip needs an "id"');
    if (allClips(project).some((c) => c.id === v.id)) throw new EditError(i, `a clip "${v.id}" already exists`, 'pick a new id');
    project.clips = project.clips || [];
    project.clips.splice(at(project.clips), 0, v);
  } else if (e.to === 'channels') {
    if (!v.id) throw new EditError(i, 'a new channel needs an "id"');
    if (channelLists(project).some((l) => l.channels.some((c) => c.id === v.id))) throw new EditError(i, `a channel "${v.id}" already exists`, 'pick a new id');
    if (v.items != null && !Array.isArray(v.items)) throw new EditError(i, 'a channel\'s "items" is a list');
    project.channels = project.channels || [];
    project.channels.splice(at(project.channels), 0, { name: v.id, visible: true, items: [], ...v });
  } else if (e.to === 'sounds') {
    project.sounds = project.sounds || [];
    project.sounds.splice(at(project.sounds), 0, v);
  } else if (isObj(e.to) && e.to.channel != null) {
    if (!v.id) throw new EditError(i, 'a new item needs an "id"');
    if (allItems(project).some((x) => x.item.id === v.id)) throw new EditError(i, `an item "${v.id}" already exists`, 'pick a new id');
    const { channel } = findChannel(project, e.to.channel, i);
    channel.items = channel.items || [];
    channel.items.splice(at(channel.items), 0, v);
  } else if (isObj(e.to) && e.to.item != null) {
    const list = e.to.list || 'effects';
    if (!['effects', 'layerEffects'].includes(list)) throw new EditError(i, `items keep effects in "effects" or "layerEffects", not "${list}"`);
    if (!v.id) throw new EditError(i, 'an effect needs its type "id"', 'see: npx greenlight-motion schema effects');
    const { item } = findItem(project, e.to.item, i);
    item[list] = item[list] || [];
    if (v.eid && [...(item.effects || []), ...(item.layerEffects || [])].some((x) => x?.eid === v.eid)) {
      throw new EditError(i, `item "${item.id}" already has an effect "${v.eid}"`, 'effect "eid"s are unique per item');
    }
    item[list].splice(at(item[list]), 0, v);
  } else {
    throw new EditError(i, 'unknown "to"', '"clips", "channels", "sounds", { "channel": id } or { "item": id, "list": "effects" | "layerEffects" }');
  }
}

function removeEdit(project, e, i) {
  if (e.effect != null) {
    const { item } = findItem(project, e.item, i);
    for (const list of ['effects', 'layerEffects']) {
      const k = (item[list] || []).findIndex((x) => x?.eid === e.effect);
      if (k >= 0) { item[list].splice(k, 1); return; }
    }
    throw new EditError(i, `item "${item.id}" has no effect "${e.effect}"`,
      `its effects: ${[...(item.effects || []), ...(item.layerEffects || [])].map((x) => x?.eid).filter(Boolean).join(', ') || 'none'}`);
  }
  if (e.item != null) {
    const { channel } = findItem(project, e.item, i);
    channel.items = channel.items.filter((x) => x.id !== e.item);
  } else if (e.channel != null) {
    const { list, channel } = findChannel(project, e.channel, i);
    list.splice(list.indexOf(channel), 1);
  } else if (e.clip != null) {
    const clip = findClip(project, e.clip, i);
    const users = allItems(project).filter((x) => x.item.clipId === clip.id).map((x) => x.item.id);
    if (users.length) throw new EditError(i, `clip "${clip.id}" is still used by ${users.join(', ')}`, 'remove or re-point those items first, in the same batch');
    const drop = (list) => {
      const k = list.indexOf(clip);
      if (k >= 0) { list.splice(k, 1); return true; }
      return list.some((c) => c?.sequence?.clips && drop(c.sequence.clips));
    };
    drop(project.clips || []);
  } else if (e.sound != null) {
    holder(project, e, i);
    project.sounds.splice(Number(e.sound), 1);
  } else {
    throw new EditError(i, 'the edit names nothing to remove', '"item", "channel", "clip", "sound" or "effect" (+ "item")');
  }
}

function keyframeEdit(project, e, i) {
  const { item } = findItem(project, e.item, i);
  if (typeof e.track !== 'string' || !e.track) throw new EditError(i, 'missing "track"', 'e.g. "translateX", "opacity", "rotate", "scale", "fx:<eid>:<param>"');
  const pos = Number(e.at);
  if (!Number.isFinite(pos) || pos < 0 || pos > 100) throw new EditError(i, '"at" is the position in the layer, 0–100 (%)', 'convert a time t (s) as 100 × (t − layer start) / layer length');
  if (e.value == null) throw new EditError(i, 'missing "value"');
  item.propertyKeyframes = item.propertyKeyframes || {};
  const track = item.propertyKeyframes[e.track] = item.propertyKeyframes[e.track] || [];
  const key = { position: pos, value: String(e.value), easing: e.easing || 'Linear' };
  const k = track.findIndex((x) => Math.abs(Number(x.position) - pos) < 1e-6);
  if (k >= 0) track[k] = { ...track[k], ...key };
  else track.push(key);
  track.sort((a, b) => Number(a.position) - Number(b.position));
}

function moveEdit(project, e, i) {
  const { list, channel } = findChannel(project, e.channel, i);
  const to = Number(e.to);
  if (!Number.isInteger(to)) throw new EditError(i, '"to" is the new stack position (0 = bottom)');
  list.splice(list.indexOf(channel), 1);
  list.splice(Math.max(0, Math.min(list.length, to)), 0, channel);
}

// what must still hold after the whole batch
function problems(project) {
  const out = [];
  const clipIds = new Set(ids(allClips(project)));
  const items = allItems(project);
  const seen = new Map();
  for (const { item, channel } of items) {
    if (!item.id) out.push({ message: `an item in channel "${channel.id}" has no id`, hint: 'give every item an "id"' });
    else if (seen.has(item.id)) out.push({ message: `two items are called "${item.id}"`, hint: 'item ids must be unique' });
    seen.set(item.id, true);
    if (item.clipId != null && !clipIds.has(item.clipId)) {
      out.push({ message: `item "${item.id}" plays clip "${item.clipId}", which does not exist`, hint: `clips: ${near(item.clipId, [...clipIds])}` });
    }
    const parent = item.keyframeParenting?.parentItemId;
    if (parent && !items.some((x) => x.item.id === parent)) {
      out.push({ message: `item "${item.id}" follows parent "${parent}", which does not exist`, hint: 'unset keyframeParenting or add the parent' });
    }
  }
  const chanIds = channelLists(project).flatMap((l) => ids(l.channels));
  const dup = chanIds.find((c, k) => chanIds.indexOf(c) !== k);
  if (dup) out.push({ message: `two channels are called "${dup}"`, hint: 'channel ids must be unique' });
  (project.sounds || []).forEach((s, k) => {
    if (s?.on && !seen.has(s.on)) out.push({ message: `sound ${k} is anchored on item "${s.on}", which does not exist`, hint: 'point "on" at an item id or use "time"' });
  });
  for (const f of project.template?.fields || []) {
    for (const t of f.targets || []) {
      if (t.itemId && !seen.has(t.itemId)) out.push({ message: `template field "${f.key}" targets item "${t.itemId}", which does not exist`, hint: 'fix the target or remove the field' });
      if (t.clipId && !clipIds.has(t.clipId)) out.push({ message: `template field "${f.key}" targets clip "${t.clipId}", which does not exist`, hint: 'fix the target or remove the field' });
    }
  }
  return out;
}

/**
 * Apply `edits` to a COPY of `project`. Returns { project, summary } or throws EditError (the first bad edit, or the
 * references the batch would break — then `.problems` lists them all). The input project is never changed.
 */
export function applyEdits(project, edits) {
  if (!Array.isArray(edits)) throw new EditError(-1, 'the edits must be a JSON list', '[{ "op": "set", … }, …]');
  const next = structuredClone(project);
  const summary = [];
  edits.forEach((e, i) => {
    if (!isObj(e)) throw new EditError(i, 'an edit is an object');
    const label = e.item != null ? `item "${e.item}"` : e.clip != null ? `clip "${e.clip}"` : e.channel != null ? `channel "${e.channel}"` : e.sound != null ? `sound ${e.sound}` : 'project';
    switch (e.op) {
      case 'set': setPath(holder(next, e, i), splitPath(e.path, i), e.value, i, label); break;
      case 'unset': unsetPath(holder(next, e, i), splitPath(e.path, i), i, label); break;
      case 'add': addEdit(next, e, i); break;
      case 'remove': removeEdit(next, e, i); break;
      case 'keyframe': keyframeEdit(next, e, i); break;
      case 'move': moveEdit(next, e, i); break;
      default: throw new EditError(i, `unknown op "${e.op}"`, 'set | unset | add | remove | keyframe | move');
    }
    summary.push(`${e.op} ${e.path ? `${label}.${e.path}` : e.to ? `→ ${typeof e.to === 'string' ? e.to : JSON.stringify(e.to)}` : label}`);
  });
  const left = problems(next);
  if (left.length) {
    const err = new EditError(edits.length - 1, `the batch would leave ${left.length} broken reference(s): ${left[0].message}`, left[0].hint);
    err.problems = left;
    throw err;
  }
  return { project: next, summary };
}
