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

/** { fps, duration, layers: [{ id, name, type, start, end, tracks: { key: [v…] }, times: [t…], moments }] } */
export function traceProject(project, { fps = 30, items = null } = {}) {
  const byClip = new Map((project.clips || []).map((c) => [c.id, c]));
  const want = items ? new Set(items) : null;
  const layers = [];
  let duration = 0;
  for (const ch of project.channels || []) {
    const list = ch?.items || [];
    if (!list.length) continue;
    const layout = getTimelineLayout(list, { unsnapped: ch.unsnapped });
    list.forEach((item, i) => {
      const at = layout[i];
      if (!at) return;
      duration = Math.max(duration, at.endTime);
      const kf = item.propertyKeyframes || {};
      const keys = Object.keys(kf).filter((k) => Array.isArray(kf[k]) && kf[k].length);
      if (!keys.length || (want && !want.has(item.id))) return;
      const clip = byClip.get(item.clipId);
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
        start: round(at.startTime),
        end: round(at.endTime),
        times,
        tracks,
        moments: { start: round(at.startTime), end: round(at.endTime), peak: peak == null ? null : round(peak), settles },
      });
    });
  }
  return { fps, duration: round(duration), layers };
}
