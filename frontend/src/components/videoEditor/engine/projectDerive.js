/*
 * The project data the editor derives from its props (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 28e2 —
 * moved verbatim out of the Player's useMemos with tests/engine-extraction/tools/stage9_derive.py): the clip map,
 * each channel's timeline layout, the transition sound cues, the parent index, the Scene Rig entries, the fonts and
 * the pictures a frame needs loaded. Pure functions of the project — the Player memoizes each on its old dependency
 * list, a React-free driver calls them when the project changes.
 */
import { clampTransitionSoundCue, createTransitionSoundCues } from '../advancedTransitions';
import { collectBackgroundUrls } from '../backgroundLayer';
import { buildParentIndex } from '../keyframeParenting';
import { RIG_MEDIA_TYPE } from '../rig3d';
import { getTimelineLayout } from '../speedUtils';
import { SEQUENCE_MAX_DEPTH, isContainerClip } from '../types';

export function deriveClipsMap({ clips }) {
  const map = new Map();
  for (const clip of clips) map.set(clip.id, clip);
  return map;
}

export function deriveLayoutMap({ channels }) {
  const map = new Map();
  for (const channel of channels) map.set(channel.id, getTimelineLayout(channel.items, { unsnapped: channel.unsnapped }));
  return map;
}

export function deriveTransitionSoundCues({ channels, clipsMap, layoutMap, transitionRegistryRevision }) {
  void transitionRegistryRevision;
  const cues = [];
  const isFlatSpeed = (pts) => !Array.isArray(pts)
    || pts.every((p) => Math.abs((p?.y ?? 1) - 1) < 1e-4);
  const collect = (chs, cmap, layoutFor, offsetTime, depth, winStart, winEnd, idPrefix) => {
    for (const channel of chs) {
      if (channel.visible === false) continue;
      const layout = layoutFor(channel);
      if (!layout) continue;
      for (let i = 0; i < channel.items.length; i++) {
        const item = channel.items[i];
        const itemLayout = layout[i];
        const clip = cmap.get(item.clipId);
        if (!itemLayout || !clip) continue;

        for (const raw of createTransitionSoundCues(item, itemLayout, offsetTime, idPrefix)) {
          const cue = clampTransitionSoundCue(raw, winStart, winEnd);
          if (cue) cues.push(cue);
        }

        if (!isContainerClip(clip) || depth >= SEQUENCE_MAX_DEPTH) continue;
        if (!isFlatSpeed(item.speedPoints)) continue;
        const seqStart = offsetTime + itemLayout.startTime;
        const seqEnd = offsetTime + itemLayout.endTime;
        const innerCmap = new Map(clip.sequence.clips.map((c) => [c.id, c]));
        const innerLayouts = new Map(clip.sequence.channels.map((ch) => [
          ch.id,
          getTimelineLayout(ch.items, { unsnapped: ch.unsnapped }),
        ]));
        collect(
          clip.sequence.channels,
          innerCmap,
          (ch) => innerLayouts.get(ch.id),
          seqStart - (item.trimStart || 0),
          depth + 1,
          Math.max(winStart, seqStart),
          Math.min(winEnd, seqEnd),
          `${idPrefix}${item.id}/`,
        );
      }
    }
  };
  collect(channels, clipsMap, (ch) => layoutMap.get(ch.id), 0, 0, -Infinity, Infinity, '');
  return cues;
}

export function deriveParentIndex({ channels, layoutMap, clipsMap = null }) {
  return buildParentIndex(channels, (ch) => layoutMap.get(ch.id), clipsMap ? (item) => clipsMap.get(item.clipId) : null);
}

export function deriveTextFontLoadRequest({ channels, clipsMap }) {
  const families = [];
  const weights = [];
  for (const channel of channels) {
    for (const item of channel.items) {
      const clip = clipsMap.get(item.clipId);
      if (clip?.mediaType === 'motion') {
        // Motion templates draw text on canvas with the param font — load it
        // like text-clip fonts so preview/export don't fall back mid-render.
        const params = item.motionParams || {};
        if (params.fontFamily) families.push(params.fontFamily);
        if (Number.isFinite(Number(params.fontWeight))) weights.push(Number(params.fontWeight));
        continue;
      }
      if (clip?.mediaType !== 'text') continue;
      if (item.textFontFamily) families.push(item.textFontFamily);
      if (Number.isFinite(Number(item.textFontWeight))) {
        weights.push(Number(item.textFontWeight));
      }
    }
  }
  return {
    families: [...new Set(families)],
    weights: [...new Set(weights)],
  };
}

export function deriveMotionImageUrls({ channels, clipsMap }) {
  const urls = [];
  for (const channel of channels) {
    for (const item of channel.items) {
      const clip = clipsMap.get(item.clipId);
      if (clip?.mediaType !== 'motion') continue;
      for (const value of Object.values(item.motionParams || {})) {
        if (!Array.isArray(value)) continue;
        for (const url of value) {
          if (typeof url === 'string' && (url.startsWith('http') || url.startsWith('/') || url.startsWith('data:'))) {
            urls.push(url);
          }
        }
      }
    }
  }
  return [...new Set(urls)];
}

export function deriveBackgroundUrls({ background, videoWidth, videoHeight }) {
  return collectBackgroundUrls(background, videoWidth, videoHeight);
}

export function deriveShapeBackgroundUrls({ channels, clipsMap, videoHeight, videoWidth }) {
  const urls = [];
  const walk = (levelChannels, levelClipsMap, depth) => {
    if (depth > SEQUENCE_MAX_DEPTH) return;
    for (const channel of levelChannels) {
      for (const item of channel.items) {
        const clip = levelClipsMap.get(item.clipId);
        const shapeBg = clip?.mediaType === 'shape' ? item.shapeBackground : null;
        if (shapeBg?.type === 'image' || shapeBg?.type === 'pattern') {
          urls.push(...collectBackgroundUrls(shapeBg, videoWidth, videoHeight));
        }
        if (isContainerClip(clip)) {
          walk(
            clip.sequence.channels,
            new Map(clip.sequence.clips.map((nestedClip) => [nestedClip.id, nestedClip])),
            depth + 1
          );
        }
      }
    }
  };
  walk(channels, clipsMap, 0);
  return [...new Set(urls)];
}

export function deriveRigEntries({ channels, clipsMap, layoutMap }) {
  const out = [];
  for (const channel of channels) {
    const layout = layoutMap.get(channel.id);
    if (!layout) continue;
    channel.items.forEach((item, i) => {
      if (clipsMap.get(item.clipId)?.mediaType !== RIG_MEDIA_TYPE || !item.rig || !layout[i]) return;
      out.push({
        startTime: layout[i].startTime,
        endTime: layout[i].endTime,
        rig: item.rig,
        // The `sc:` / `scc:` tracks, kept beside the rig so the animated value can
        // be resolved per frame. The RAW rig above stays untouched: a light drag in
        // the 3D view writes back to it, and writing back to a keyframed snapshot
        // would bake the animation into the resting pose.
        propertyKeyframes: item.propertyKeyframes || null,
        item,
        itemId: item.id,
      });
    });
  }
  return out;
}
