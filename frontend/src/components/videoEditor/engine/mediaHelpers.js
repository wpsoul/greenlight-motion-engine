/*
 * Media timing constants and the source → timeline time mapping the media clock and the render loop share
 * (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 28b — moved verbatim out of Player.jsx with
 * tests/engine-extraction/tools/move_module_decls.py, which the Player imports back).
 */
import { isWebKitEngine } from '../audioDriftSync';
import { mapTimelineToSource } from '../speedUtils';
import { isContainerClip, SEQUENCE_MAX_DEPTH } from '../types';
import { getShapeSvgImage, shapeSvgImageCache } from './pathFx';
import { PREVIEW_TIER } from './previewMedia';

// After a paused seek's `seeked`, how long to wait for a frame callback before
// treating the landed frame as presented anyway (see syncVideo).
export const SEEKED_FRAME_GRACE_MS = 120;

// How early an IDLE channel stages its upcoming clips. A cold re-source measures
// 300-400ms for a small local file and far more for big remote ones, so idle
// channels (whose buffers are all free) prepare much earlier than the 1.5s
// same-channel window allows.
// From the device tier: 4 s on desktop (today's constant), 2 s on a tablet/phone,
// where six channels each warming two buffers over Wi‑Fi starve the one on screen.
// JUMP HOLD — a playhead jump WHILE PLAYING on a WebKit tablet/phone (touch tier
// only; desktop and Chromium keep today's path). WebKit answers a seek on a
// PLAYING sounding video by showing the new frame ~100 ms later and then running
// 0.5 s behind the clock for the rest of the clip, and the WebKit seek policy
// deliberately leaves drift under 1 s alone (every correction costs another
// stall). Measured standalone: seek-while-playing → 0.49–0.52 s behind; pause →
// seek → play → 0.16–0.25 s; and a PAUSED seek lands in ~44 ms inside the editor.
// So on such a jump every playing element is paused, the owning buffers seek
// while paused, the master clock HOLDS at the target until they have landed (or
// JUMP_HOLD_MAX_MS), and then everything restarts on the same frame through the
// normal start path (volume gate included) — picture and sound come up together.
export const JUMP_HOLD = PREVIEW_TIER.touch && isWebKitEngine;

export function mapSourceToTimeline(points, normalizedSource) {
  if (!points || points.length < 2) return normalizedSource;
  const target = Math.max(0, Math.min(1, normalizedSource));
  let low = 0;
  let high = 1;
  for (let i = 0; i < 12; i += 1) {
    const mid = (low + high) * 0.5;
    const sourceAtMid = mapTimelineToSource(points, mid);
    if (sourceAtMid < target) low = mid;
    else high = mid;
  }
  return (low + high) * 0.5;
}

// ── Apply mesh transform from item properties + keyframes ──

export function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

// Wait for every custom-shape SVG that has been requested (by a render pass or by
// preloadShapeSvgs) and is still decoding. Resolves true when it actually waited,
// so the caller knows a repaint is worth doing.
export async function awaitShapeSvgImages(timeoutMs = 8000) {
  const pending = [];
  for (const entry of shapeSvgImageCache.values()) {
    if (!entry.ready && !entry.failed && entry.promise) pending.push(entry.promise);
  }
  if (!pending.length) return false;
  let timer = null;
  await Promise.race([
    Promise.all(pending),
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  return true;
}

// Request the SVG of every custom/vector shape in a timeline (sequence and grid
// members included) so it starts decoding before the first frame is captured.
export function preloadShapeSvgs(channels, clipsMap, depth = 0) {
  if (depth > SEQUENCE_MAX_DEPTH || !Array.isArray(channels)) return;
  for (const ch of channels) {
    for (const it of ch?.items || []) {
      const clip = clipsMap?.get?.(it?.clipId);
      if (!clip) continue;
      if (clip.mediaType === 'shape' && (it.shapeType === 'custom' || it.shapeType === 'vector') && it.shapeSvgUrl) {
        getShapeSvgImage(it.shapeSvgUrl);
      }
      if (isContainerClip(clip) && Array.isArray(clip.sequence?.channels)) {
        const inner = new Map((clip.sequence.clips || []).map((c) => [c.id, c]));
        preloadShapeSvgs(clip.sequence.channels, inner, depth + 1);
      }
    }
  }
}

export const JUMP_HOLD_MAX_MS = 900;
