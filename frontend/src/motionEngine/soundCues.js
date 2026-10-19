/*
 * GreenLight Motion Engine — sound cues: sounds anchored to EVENTS, not to seconds (plan Part 7).
 *
 *   "sounds": [
 *     { "sfx": "standard-swoosh", "on": "title", "at": "peak" },          // its loudest point on the title's fastest moment
 *     { "sfx": "cinematic-transition-13", "on": "logo", "at": "end", "gain": -3 },
 *     { "sfx": "data-1", "on": "badge", "at": "start" },
 *     { "sfx": "selection-data-click", "time": 1.2 }                      // or an absolute time
 *   ]
 *
 * `sfx` is a sound of the library (sfx.js: the owner's accepted sounds from GreenLight Dash's Sound Library).
 *
 * `on` an item id, `at` "start" | "end" | "peak" (the fastest moment of its keyframed motion) | seconds from
 * its start; `align` "sync" (default: the sound's loudest moment, sfx.js) | "start" | "end"; `offset` seconds;
 * `gain` dB (≤ 0; the editor caps volume at 100 %). Retiming the layer moves its sounds with it. A sound that
 * would run past the last picture is cut there: sounds never make the video longer.
 *
 * materializeSoundCues(project) turns cues into ordinary audio clips + items on their own unsnapped channels
 * (no two overlapping on one), each clip's `url` = `asset:sounds/<file>` — the page's ASSETS provide the file (the
 * CLI copies it from GreenLight Dash's library), GreenLight Dash points it at its library — so the editor's own audio
 * path previews, mixes and exports them. A library file that peaks above CUE_HEADROOM_DB is turned down to it.
 */
import { SOUNDS, soundRef, CUE_HEADROOM_DB } from './sfx';
import { getTimelineLayout } from '../components/videoEditor/speedUtils';
import { evaluatePropertyTrack } from '../components/videoEditor/gsapTransitions';

export const SFX_CHANNEL_PREFIX = 'sfx-cues-';
const MOTION_TRACKS = ['xPercent', 'yPercent', 'translateX', 'translateY', 'translateZ', 'x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate', 'rotation', 'rotateX', 'rotateY', 'rotateZ', 'zoom', 'opacity', 'blur'];

function placedItems(channels) {
  const out = new Map();
  for (const ch of channels || []) {
    const items = ch?.items || [];
    if (!items.length) continue;
    const layout = getTimelineLayout(items, { unsnapped: ch.unsnapped });
    items.forEach((it, i) => { if (layout[i]) out.set(it.id, { item: it, start: layout[i].startTime, end: layout[i].endTime }); });
  }
  return out;
}

/** The time of an item's fastest change: every motion track sampled at 240 Hz, each normalized by its own range. */
export function peakMotionTime({ item, start, end }) {
  const kf = item?.propertyKeyframes || {};
  const tracks = MOTION_TRACKS.filter((k) => Array.isArray(kf[k]) && kf[k].length > 1);
  if (!tracks.length || end <= start) return null;
  const steps = Math.max(8, Math.round((end - start) * 240));
  const speed = new Float32Array(steps);
  for (const key of tracks) {
    const vals = new Float32Array(steps + 1);
    let lo = Infinity; let hi = -Infinity;
    for (let s = 0; s <= steps; s += 1) {
      const v = Number(evaluatePropertyTrack(kf[key], (s / steps) * 100, false));
      vals[s] = Number.isFinite(v) ? v : 0;
      lo = Math.min(lo, vals[s]); hi = Math.max(hi, vals[s]);
    }
    const range = hi - lo;
    if (!(range > 1e-9)) continue;
    for (let s = 0; s < steps; s += 1) speed[s] = Math.max(speed[s], Math.abs(vals[s + 1] - vals[s]) / range);
  }
  let best = -1; let at = -1;
  for (let s = 0; s < steps; s += 1) if (speed[s] > best) { best = speed[s]; at = s; }
  if (best <= 0) return null;
  return start + ((at + 0.5) / steps) * (end - start);
}

function anchorTime(cue, placed) {
  if (Number.isFinite(Number(cue.time))) return Number(cue.time);
  const p = placed.get(cue.on);
  if (!p) return null;
  const at = cue.at ?? 'start';
  if (at === 'start') return p.start;
  if (at === 'end') return p.end;
  if (at === 'peak') return peakMotionTime(p) ?? p.start;
  if (Number.isFinite(Number(at))) return p.start + Number(at);
  return null;
}

/** Cue problems an agent should fix (unknown sound, missing layer, bad values). */
export function checkSoundCues(project) {
  const problems = [];
  const placed = placedItems(project?.channels);
  (Array.isArray(project?.sounds) ? project.sounds : []).forEach((cue, i) => {
    const where = `sounds[${i}]`;
    if (!cue || typeof cue !== 'object') { problems.push(`${where}: not an object`); return; }
    if (!SOUNDS[cue.sfx]) problems.push(`${where}: no sound "${cue.sfx}" in the library (npx greenlight-motion schema sounds lists its ${Object.keys(SOUNDS).length})`);
    if (cue.time == null && !placed.has(cue.on)) problems.push(`${where}: no item "${cue.on}" (set "on" to an item id, or "time")`);
    if (cue.at != null && !['start', 'end', 'peak'].includes(cue.at) && !Number.isFinite(Number(cue.at))) problems.push(`${where}: "at" must be start, end, peak or seconds`);
    if (cue.align != null && !['sync', 'start', 'end'].includes(cue.align)) problems.push(`${where}: "align" must be sync, start or end`);
    if (cue.gain != null && !(Number(cue.gain) <= 0)) problems.push(`${where}: "gain" is dB and at most 0`);
  });
  return problems;
}

/**
 * The project with its cues as audio layers: { project, refs, placed: [...] } — `refs` lists the sound files the
 * cues play (the page's ASSETS provide them).
 * A project without cues comes back as is. Runs again cleanly on its own output (old cue layers are replaced).
 */
export function materializeSoundCues(project) {
  const cues = Array.isArray(project?.sounds) ? project.sounds : [];
  const keepChannels = (project.channels || []).filter((c) => !String(c.id || '').startsWith(SFX_CHANNEL_PREFIX));
  const keepClips = (project.clips || []).filter((c) => !String(c.id || '').startsWith('sfx-cue-'));
  if (!cues.length) return { project: { ...project, channels: keepChannels, clips: keepClips }, refs: [], placed: [] };
  const placed = placedItems(keepChannels);
  // a sound never makes the video longer: one that runs past the last picture is cut there
  let contentEnd = 0;
  for (const p of placed.values()) contentEnd = Math.max(contentEnd, p.end);
  const refs = new Set();
  const lanes = [];     // per channel: the time it is free from
  const newClips = [];
  const out = [];
  cues.forEach((cue, i) => {
    const spec = SOUNDS[cue?.sfx];
    const anchor = spec ? anchorTime(cue, placed) : null;
    if (!spec || anchor == null) return;
    const ref = soundRef(cue.sfx);
    refs.add(ref);
    const point = cue.align === 'start' ? 0 : cue.align === 'end' ? spec.duration : spec.sync;
    let start = anchor - point + (Number(cue.offset) || 0);
    let trimStart = 0;
    if (start < 0) { trimStart = Math.min(spec.duration - 0.01, -start); start = 0; }
    const trimEnd = Math.min(spec.duration, trimStart + Math.max(0, contentEnd - start));
    if (trimEnd - trimStart < 0.02) return;
    const end = start + (trimEnd - trimStart);
    const clipId = `sfx-cue-${i}`;
    newClips.push({ id: clipId, mediaType: 'audio', name: `${spec.label} (cue)`, duration: spec.duration, url: ref, source: 'REMOTE' });
    // the cue's own gain, plus whatever keeps a hot library file under CUE_HEADROOM_DB
    const gain = Math.min(0, Number(cue.gain) || 0) + Math.min(0, CUE_HEADROOM_DB - (Number(spec.level) || 0));
    out.push({
      end,
      item: {
        id: `sfx-cue-item-${i}`, clipId, trimStart, trimEnd, freeStart: start,
        ...(gain < 0 ? { volume: Math.round(100 * 10 ** (gain / 20)) } : {}),
      },
      at: anchor,
      sound: cue.sfx,
    });
  });
  // channels in time order: no two sounds overlap on one
  for (const o of [...out].sort((a, b) => a.item.freeStart - b.item.freeStart)) {
    let lane = lanes.findIndex((free) => free <= o.item.freeStart + 1e-6);
    if (lane < 0) { lanes.push(0); lane = lanes.length - 1; }
    lanes[lane] = o.end;
    o.lane = lane;
  }
  const channels = [...keepChannels];
  lanes.forEach((_free, lane) => {
    const items = out.filter((o) => o.lane === lane).map((o) => o.item).sort((a, b) => a.freeStart - b.freeStart);
    channels.push({ id: `${SFX_CHANNEL_PREFIX}${lane + 1}`, name: `Sound cues ${lane + 1}`, unsnapped: true, items });
  });
  return {
    project: { ...project, channels, clips: [...keepClips, ...newClips] },
    refs: [...refs],
    placed: out.map((o) => ({ sound: o.sound, anchor: o.at, start: o.item.freeStart, lane: o.lane + 1 })),
  };
}
