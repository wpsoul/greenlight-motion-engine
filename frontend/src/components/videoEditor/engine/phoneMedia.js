/*
 * Phone mode's media (./phoneMode.js): pictures at the size they are drawn, decoded ahead of the playhead and dropped
 * when unused past a budget; the scenes the playhead left given back (their videos and buffers), and the text, shape and
 * mask plates of layers away from it. An
 * upload keeps no copy of the picture on the CPU side.
 *
 * Engine fields used: imageTextureCache, imageTextureLoads, videoTextureCache, passFrame, sequenceStates,
 * sequenceFrameStamp, textTextureCache, maskPlateCache, maskCoverageStamp, maskCoverageByItem, phonePictureEdge.
 */
import * as THREE from 'three';
import { getTimelineLayout } from '../speedUtils';
import { perfRegistry } from '../perfRegistry';
import { SEQUENCE_MAX_DEPTH, isContainerClip } from '../types';
import { disposeSequenceState } from './channelStates';
import { PHONE_LOOK_AHEAD_S, PHONE_PICTURE_BUDGET, PHONE_PICTURE_EDGE, PHONE_PLATE_REACH_S, PHONE_SEQUENCE_KEEP_MS } from './phoneMode';

const DECODES_AT_ONCE = 2;   // a full-size decode is the worst moment for a picture: never many at the same time
const LOOK_EVERY_MS = 300;
const PLATES_EVERY_MS = 1000;
const layouts = new WeakMap();
const noop = () => {};

function layoutOf(channel) {
  let layout = layouts.get(channel.items);
  if (!layout) { layout = getTimelineLayout(channel.items, { unsnapped: channel.unsnapped }); layouts.set(channel.items, layout); }
  return layout;
}

// Every clip on screen between t0 and t1, inside sequences too (their time mapped by the item's start and trim: close
// enough for what to load next, a retimed scene only shifts it).
export function eachClipBetween(channels, clips, t0, t1, visit, offset = 0, depth = 0) {
  if (depth > SEQUENCE_MAX_DEPTH) return;
  const byId = clips instanceof Map ? clips : new Map((clips || []).filter(Boolean).map((c) => [c.id, c]));
  for (const channel of channels || []) {
    const layout = layoutOf(channel);
    channel.items.forEach((item, i) => {
      const entry = layout[i], clip = byId.get(item.clipId);
      if (!entry || !clip) return;
      const start = entry.startTime + offset, end = entry.endTime + offset;
      if (end < t0 || start > t1) return;
      visit(clip, item);
      if (isContainerClip(clip)) eachClipBetween(clip.sequence.channels, clip.sequence.clips, t0, t1, visit, start - (Number(item.trimStart) || 0), depth + 1);
    });
  }
}

export function clipsBetween(channels, clips, t0, t1) {
  const out = new Set();
  eachClipBetween(channels, clips, t0, t1, (clip) => out.add(clip));
  return [...out];
}

const queue = [];
let decoding = 0;
function pump() {
  while (decoding < DECODES_AT_ONCE && queue.length) {
    decoding += 1;
    queue.shift()().finally(() => { decoding -= 1; pump(); });
  }
}

// A bitmap can be freed the moment it is drawn; an <img>'s pixels stay in the browser's decoded-image cache. What a bitmap
// cannot read (an SVG) goes through an <img>.
async function decodePicture(key) {
  try {
    const image = await createImageBitmap(await (await fetch(key)).blob());
    return { image, width: image.width, height: image.height, free: () => image.close() };
  } catch {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = key;
    await image.decode();
    return { image, width: image.naturalWidth, height: image.naturalHeight, free: () => { image.src = ''; } };
  }
}

// The picture at most PHONE_PICTURE_EDGE long (engine.phonePictureEdge: a real render's size), in place of the texture
// loader. userData.fullW / fullH: the file's size, whose exact aspect the layer fits to.
export function phonePictureTexture(engine, key, onLoad) {
  const texture = new THREE.Texture();
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.userData.used = engine.passFrame;
  engine.imageTextureCache.set(key, texture);
  let settle = null;
  engine.imageTextureLoads.set(key, new Promise((resolve) => { settle = resolve; }));
  const done = () => { engine.imageTextureLoads.delete(key); settle?.(); };
  queue.push(async () => {
    if (engine.imageTextureCache.get(key) !== texture) { done(); return; }
    try {
      const picture = await decodePicture(key);
      const w = picture.width, h = picture.height;
      const k = Math.min(1, (engine.phonePictureEdge || PHONE_PICTURE_EDGE) / Math.max(w, h, 1));
      const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(picture.image, 0, 0, cw, ch);
      picture.free();
      texture.image = canvas;
      texture.userData.fullW = w; texture.userData.fullH = h; texture.userData.bytes = cw * ch * 4;
      // uploaded: the GPU's copy is the only one (a size is all the layer still reads from .image)
      texture.onUpdate = () => { texture.onUpdate = null; texture.image = { width: cw, height: ch }; };
      texture.needsUpdate = true;
      done();
      onLoad();
    } catch {
      done();
    }
  });
  pump();
  return texture;
}

// After a frame: past the budget, the pictures unused the longest go. A picture still in use is never one of them, even
// when the scene on screen alone is past the budget.
export function trimPhonePictures(engine, isPinned) {
  const list = [...engine.imageTextureCache.entries()].filter(([, t]) => t.userData.bytes);
  let total = list.reduce((sum, [, t]) => sum + t.userData.bytes, 0);
  if (total <= PHONE_PICTURE_BUDGET) return;
  list.sort((a, b) => a[1].userData.used - b[1].userData.used);
  for (const [key, texture] of list) {
    if (total <= PHONE_PICTURE_BUDGET) break;
    if (texture.userData.used >= engine.passFrame - 2 || isPinned(engine, texture)) continue;
    total -= texture.userData.bytes;
    engine.imageTextureCache.delete(key);
    texture.dispose();
  }
}

export function dropPhonePictures(engine) {
  for (const [key, texture] of engine.imageTextureCache.entries()) {
    if (!texture.userData.bytes) continue;
    engine.imageTextureCache.delete(key);
    texture.dispose();
  }
}

// Now and then: the pictures of what starts within PHONE_LOOK_AHEAD_S, so a scene's pictures are there when it does.
export function lookAheadPictures(engine, env, get) {
  const now = performance.now();
  if (now - (engine.phoneLookAt || 0) < LOOK_EVERY_MS) return;
  engine.phoneLookAt = now;
  const t = engine.currentTime;
  eachClipBetween(env.channels, env.clipsMap, t, t + PHONE_LOOK_AHEAD_S, (clip) => {
    if (clip.mediaType === 'image' && clip.url) get(engine, clip.url, noop);
  });
}

const release = (plate) => {
  try { plate.texture.dispose(); plate.release?.(); } catch { /* no-op */ }
  if (plate.canvas) { plate.canvas.width = 0; plate.canvas.height = 0; }   // now, not when it is collected
};

// Now and then: the text, shape and mask plates of layers away from the playhead. Each paints itself again if it comes back.
export function sweepPhonePlates(engine, env) {
  const now = performance.now();
  if (now - (engine.phonePlatesAt || 0) < PLATES_EVERY_MS) return;
  engine.phonePlatesAt = now;
  const near = new Set(), t = engine.currentTime;
  eachClipBetween(env.channels, env.clipsMap, t - PHONE_PLATE_REACH_S, t + PHONE_PLATE_REACH_S, (clip, item) => near.add(item.id));
  for (const [id, plate] of engine.textTextureCache.entries()) {
    if (near.has(id)) continue;
    release(plate);
    engine.textTextureCache.delete(id);
  }
  for (const [key, plate] of engine.maskPlateCache.entries()) {
    const id = key.slice(0, key.indexOf(':'));
    if (near.has(id)) continue;
    release(plate);
    engine.maskPlateCache.delete(key);
    engine.maskCoverageStamp.delete(id);
    engine.maskCoverageByItem.delete(id);
  }
}

// After a frame: a scene the playhead left PHONE_SEQUENCE_KEEP_MS ago gives its videos and buffers back. It builds itself
// again if the playhead returns.
export function sweepPhoneSequences(engine) {
  const now = performance.now();
  for (const [id, st] of engine.sequenceStates.entries()) {
    if (st._frameStamp === engine.sequenceFrameStamp || st._seenAt == null) { st._seenAt = now; continue; }
    if (now - st._seenAt < PHONE_SEQUENCE_KEEP_MS) continue;
    for (const cs of st.channelStates.values()) {
      for (const video of [cs.videos.a, cs.videos.b]) {
        const entry = engine.videoTextureCache.get(video);
        if (!entry) continue;
        try { entry.texture.dispose(); } catch { /* no-op */ }
        engine.videoTextureCache.delete(video);
      }
    }
    disposeSequenceState(st);
    engine.sequenceStates.delete(id);
  }
}

// What a film asks of a phone at its busiest second, even with everything above: estimates per kind, in MB. heavy past
// what is safe in a tab (a phone gives one roughly 1–1.5 GB, the page itself takes a good part of it).
const COST_MB = { image: 3, video: 16, sequence: 4, text: 2, shape: 1 };
const HEAVY_MB = 300;
const PREPARE_SPEED = 4;   // seconds a phone needs to render one second of a heavy film (a rough figure for the card)
export function phoneFilmCost(channels, clips, duration) {
  let peak = 0;
  for (let t = 0; t <= duration; t += 1) {
    let mb = 0;
    const seen = new Set();
    eachClipBetween(channels, clips, t, t + 1, (clip, item) => { if (!seen.has(item.id)) { seen.add(item.id); mb += COST_MB[clip.mediaType] || 0; } });
    peak = Math.max(peak, mb);
  }
  return { peakMB: peak, heavy: peak > HEAVY_MB, minutes: Math.max(1, Math.round((duration * PREPARE_SPEED) / 60)) };
}

export function phoneStats(engine) {
  let bytes = 0, pictures = 0;
  for (const t of engine.imageTextureCache.values()) if (t.userData.bytes) { bytes += t.userData.bytes; pictures += 1; }
  const plateBytes = (cache) => [...cache.values()].reduce((n, e) => n + (e.canvas ? e.canvas.width * e.canvas.height * 4 : 0), 0);
  return {
    pictures, pictureMB: Math.round(bytes / 1048576), sequences: engine.sequenceStates.size,
    plates: engine.textTextureCache.size + engine.maskPlateCache.size,
    plateMB: Math.round((plateBytes(engine.textTextureCache) + plateBytes(engine.maskPlateCache)) / 1048576),
    videoTextures: engine.videoTextureCache.size, renderSize: `${engine.renderer?.domElement?.width}x${engine.renderer?.domElement?.height}`,
    cachedFrames: perfRegistry.renderCache?.cachedFrames || 0,
  };
}
