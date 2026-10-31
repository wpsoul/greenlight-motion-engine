/*
 * GreenLight Motion Engine — motion data for agents (`npx greenlight-motion trace`, plan Stage 4).
 *
 * The exact values the engine animates, frame by frame, for every keyframed layer — what an agent would
 * otherwise measure from a render with OpenCV. Per layer: where it sits on the timeline, each animated
 * track sampled at `fps` through the editor's own evaluator (evaluatePropertyTrack: the same easing
 * curves the render uses), and its moments: start, end, the fastest instant (the `peak` a sound cue can
 * anchor to) and when each track settles.
 */
import { getTimelineLayout } from '../components/videoEditor/speedUtils';
import { evaluatePropertyTrack } from '../components/videoEditor/gsapTransitions';
import { isColorTrackKey } from '../components/videoEditor/keyframeProps';
import { peakMotionTime } from './soundCues';

const round = (v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v);

/**
 * Every layer with where it plays on the WHOLE timeline: the top level and, inside each sequence (a scene of a scene
 * script, a nested comp), its own layers moved by where the sequence plays (up to 4 deep). A layer that never shows
 * inside its sequence's span is skipped. visit({ item, clip, at: { startTime, endTime }, parent, depth })
 */
export function walkLayers(project, visit) {
  const byClip = new Map((project.clips || []).map((c) => [c.id, c]));
  const walk = (channels, offset, lo, hi, depth, parent) => {
    for (const ch of channels || []) {
      const list = ch?.items || [];
      if (!list.length) continue;
      const layout = getTimelineLayout(list, { unsnapped: ch.unsnapped });
      list.forEach((item, i) => {
        const own = layout[i];
        if (!own) return;
        const at = { startTime: offset + own.startTime, endTime: offset + own.endTime };
        if (at.endTime <= lo || at.startTime >= hi) return;
        const clip = byClip.get(item.clipId);
        visit({ item, clip, at, parent, depth });
        if (clip?.sequence && depth < 4) {
          walk(clip.sequence.channels, at.startTime - (Number(item.trimStart) || 0), Math.max(lo, at.startTime), Math.min(hi, at.endTime), depth + 1, item.id);
        }
      });
    }
  };
  walk(project.channels, 0, -Infinity, Infinity, 0, null);
}

/**
 * Track-matte sources on screen while no layer uses them. The engine hides a matte source only while a layer that
 * uses it is on screen; outside those times it draws as an ordinary layer (a white disc over the picture).
 * [{ source, consumers, from, to }]
 */
export function matteGaps(project) {
  const spans = new Map();
  const uses = new Map();
  walkLayers(project, ({ item, at }) => {
    spans.set(item.id, at);
    const src = item.trackMatte?.sourceId;
    if (src) (uses.get(src) || uses.set(src, []).get(src)).push({ id: item.id, ...at });
  });
  const out = [];
  for (const [src, cons] of uses) {
    const s = spans.get(src);
    if (!s) continue;
    let gaps = [[s.startTime, s.endTime]];
    for (const c of cons) {
      gaps = gaps.flatMap(([a, b]) => (c.endTime <= a || c.startTime >= b ? [[a, b]]
        : [[a, Math.max(a, c.startTime)], [Math.min(b, c.endTime), b]])).filter(([a, b]) => b - a > 1 / 60);
    }
    for (const [a, b] of gaps) out.push({ source: src, consumers: cons.map((c) => c.id), from: round(a), to: round(b) });
  }
  return out;
}

/** { fps, duration, layers: [{ id, name, type, parent, start, end, tracks: { key: [v…] }, times: [t…], moments }] } —
 *  every keyframed layer, the ones inside sequences (a scene script's scenes) included */
export function traceProject(project, { fps = 30, items = null } = {}) {
  const want = items ? new Set(items) : null;
  const layers = [];
  let duration = 0;
  walkLayers(project, ({ item, clip, at, parent, depth }) => {
    if (!depth) duration = Math.max(duration, at.endTime);
    const kf = item.propertyKeyframes || {};
    const keys = Object.keys(kf).filter((k) => Array.isArray(kf[k]) && kf[k].length);
    if (!keys.length || (want && !want.has(item.id))) return;
    const span = at.endTime - at.startTime;
    const n = Math.max(1, Math.round(span * fps));
    const times = Array.from({ length: n + 1 }, (_, s) => round(at.startTime + (s / n) * span));
    const tracks = {};
    const settles = {};
    for (const key of keys) {
      const color = isColorTrackKey(key);
      const vals = times.map((_, s) => round(evaluatePropertyTrack(kf[key], (s / n) * 100, color)));
      tracks[key] = vals;
      if (!color) {
        const last = vals[vals.length - 1];
        let s = vals.length - 1;
        while (s > 0 && Math.abs(vals[s - 1] - last) < 1e-3) s -= 1;
        settles[key] = times[s];
      }
    }
    const peak = peakMotionTime({ item, start: at.startTime, end: at.endTime });
    layers.push({
      id: item.id,
      name: item.name || clip?.name || item.id,
      type: clip?.mediaType || 'layer',
      ...(parent ? { parent } : {}),
      start: round(at.startTime),
      end: round(at.endTime),
      times,
      tracks,
      moments: { start: round(at.startTime), end: round(at.endTime), peak: peak == null ? null : round(peak), settles },
    });
  });
  return { fps, duration: round(duration), layers };
}
