/*
 * The drawn cursor of a cursor-free screen recording (recordingCursor.js), stamped INTO the recording's picture.
 *
 * setupMesh hands over the video's texture; this returns a pooled target holding that picture with the cursor drawn
 * on it, at the picture's own size: one copy of the frame, then the cursor sprite (a small 2D canvas, motion trail
 * included) stamped at its spot. Everything downstream (masks, mockups, Overlay effects, transitions, the camera, the
 * export's motion blur) sees a recording that simply has a cursor in it, exactly like a Chromium take.
 *
 * Cost: nothing for any other layer (setupMesh only calls in for a recording whose picture has no cursor). For such a
 * recording, one full-picture copy plus a sprite, and only when the picture or the cursor changed since the last
 * frame; a cursor that is hidden (idle fade) or outside an Area take hands the plain video texture back.
 * Both passes use the compositor's picture copy (GLSL / TSL twins), so the copy and the stamp share one orientation
 * on either backend.
 */
import * as THREE from 'three';
import { materials as makeMaterial } from '../materialFactory';
import { createPictureCopyMaterial } from '../clipShader';
import { ensurePassTarget } from './passPool';
import {
  drawsRecordingCursor, paintRecordingCursor, recordingCursorFrame, recordingCursorKey, recordingCursorPlan,
  recordingCursorTrackNow,
} from '../recordingCursor';

// WebGPU: the clip material reads this target flipped, like the compositor's other plates (checked on the app path by
// tests/recording-cursor/verify_app.mjs on both backends).
export const RECORDING_CURSOR_FLIP_ON_WEBGPU = false;

const passesByRenderer = new WeakMap(); // renderer → { copy, stamp, copyScene, stampScene }
const statesByEngine = new WeakMap();   // engine → Map(itemId → state)
const SPRITE_MAX = 1024;
const IDLE_DISPOSE_MS = 5000;

function passesFor(renderer) {
  let p = passesByRenderer.get(renderer);
  if (p) return p;
  const geo = new THREE.PlaneGeometry(2, 2);
  const copy = makeMaterial.pictureCopy() ?? createPictureCopyMaterial();
  // The sprite canvas is straight alpha (a texture upload un-premultiplies the 2D canvas); the picture under it is
  // opaque and stays so.
  const stamp = makeMaterial.pictureCopy() ?? createPictureCopyMaterial();
  stamp.transparent = true;
  stamp.blending = THREE.CustomBlending;
  stamp.blendEquation = THREE.AddEquation;
  stamp.blendSrc = THREE.SrcAlphaFactor;
  stamp.blendDst = THREE.OneMinusSrcAlphaFactor;
  stamp.blendSrcAlpha = THREE.OneFactor;
  stamp.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  stamp.needsUpdate = true;
  const copyScene = new THREE.Scene();
  copyScene.add(new THREE.Mesh(geo, copy));
  const stampScene = new THREE.Scene();
  stampScene.add(new THREE.Mesh(geo, stamp));
  p = { copy, stamp, copyScene, stampScene };
  passesByRenderer.set(renderer, p);
  return p;
}

function statesFor(engine) {
  let m = statesByEngine.get(engine);
  if (!m) { m = new Map(); statesByEngine.set(engine, m); m.sweptAt = 0; }
  return m;
}

function disposeState(st) {
  for (const e of st.sprites.values()) { try { e.texture.dispose(); } catch { /* ignore */ } }
  st.sprites.clear();
}

// Drop the sprites of recordings that stopped drawing (removed, cursor switched off, scrolled off the timeline).
function sweep(states, now) {
  if (now - states.sweptAt < 1000) return;
  states.sweptAt = now;
  for (const [id, st] of states) {
    if (now - st.seen > IDLE_DISPOSE_MS) { disposeState(st); states.delete(id); }
  }
}

function spriteFor(st, w, h) {
  const key = `${w}x${h}`;
  let e = st.sprites.get(key);
  if (!e) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    e = { canvas, ctx: canvas.getContext('2d'), texture, painted: '' };
    st.sprites.set(key, e);
  }
  return e;
}

// A power of two that holds `n`, so a moving cursor reuses a few canvases instead of resizing one.
const bucket = (n) => { let b = 64; while (b < n && b < SPRITE_MAX) b *= 2; return b; };

/**
 * → the texture to draw this recording with: a target holding the picture with the cursor on it, or null (draw the
 * video texture as it is: not a cursor-free recording, or nothing to draw right now).
 * `sourceSec` is the picture's time in the recording.
 */
export function bakeRecordingCursor(engine, item, clip, videoTexture, sourceSec) {
  if (!drawsRecordingCursor(clip, item)) return null;
  const renderer = engine.renderer;
  const img = videoTexture?.image;
  if (!renderer || !img || !engine.orthoCamera || !Number.isFinite(sourceSec)) return null;
  const texW = img.videoWidth || img.width;
  const texH = img.videoHeight || img.height;
  if (!(texW > 0 && texH > 0)) return null;

  const full = recordingCursorTrackNow(clip.recordingTrackUrl, () => engine.renderFrame?.());
  const plan = recordingCursorPlan(clip, item, full);
  if (!plan) return null;
  const frame = recordingCursorFrame(plan, sourceSec * 1000, texW, texH);
  if (!frame) return null;

  const now = performance.now();
  const states = statesFor(engine);
  sweep(states, now);
  let st = states.get(item.id);
  if (!st) { st = { sprites: new Map(), key: '', tex: null, ver: -1, target: null, w: 0, h: 0, seen: now }; states.set(item.id, st); }
  st.seen = now;

  const target = ensurePassTarget(engine, `reccur:${item.id}`, texW, texH, false);
  if (!target) return null;
  const key = recordingCursorKey(frame);
  // The same picture and the same cursor: the target already holds this frame.
  if (st.key === key && st.tex === videoTexture && st.ver === videoTexture.version && st.target === target
    && st.w === texW && st.h === texH) return target.texture;

  // The sprite: a canvas kept inside the picture (WebGPU refuses a viewport past the target), its top-left at
  // picture pixel (ox, oy), top-left origin.
  const box = frame.box;
  const sw = Math.min(texW, bucket(Math.ceil(box.x1 - box.x0)));
  const sh = Math.min(texH, bucket(Math.ceil(box.y1 - box.y0)));
  const ox = Math.max(0, Math.min(texW - sw, Math.floor(box.x0)));
  const oy = Math.max(0, Math.min(texH - sh, Math.floor(box.y0)));
  const sprite = spriteFor(st, sw, sh);
  const paintedKey = `${key}@${ox},${oy}`;
  if (sprite.painted !== paintedKey) {
    paintRecordingCursor(sprite.ctx, frame, ox, oy, plan.images);
    sprite.texture.needsUpdate = true;
    sprite.painted = paintedKey;
  }

  const p = passesFor(renderer);
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  try {
    // 1. The picture (opaque, every pixel written: no clear).
    p.copy.uniforms.uTexture.value = videoTexture;
    p.copy.uniforms.uUvScale.value.set(1, 1);
    p.copy.uniforms.uUvOffset.value.set(0, 0);
    target.viewport.set(0, 0, texW, texH);
    renderer.setRenderTarget(target);
    renderer.render(p.copyScene, engine.orthoCamera);
    // 2. The cursor, over it (the viewport is bottom-up on both backends).
    p.stamp.uniforms.uTexture.value = sprite.texture;
    p.stamp.uniforms.uUvScale.value.set(1, 1);
    p.stamp.uniforms.uUvOffset.value.set(0, 0);
    target.viewport.set(ox, texH - oy - sh, sw, sh);
    renderer.setRenderTarget(target);
    renderer.render(p.stampScene, engine.orthoCamera);
  } finally {
    target.viewport.set(0, 0, texW, texH);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }
  st.key = key;
  st.tex = videoTexture;
  st.ver = videoTexture.version;
  st.target = target;
  st.w = texW;
  st.h = texH;
  return target.texture;
}
