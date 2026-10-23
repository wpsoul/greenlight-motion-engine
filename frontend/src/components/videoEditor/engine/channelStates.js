/*
 * Channel states and sequence states (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 5 — moved verbatim out
 * of the Player, `xRef.current` → `engine.x`).
 *
 * A channel state is one timeline channel's Three.js side: its group (z-stacked by channel order) under a camera
 * rig, the two cross-transition planes and their clip materials, its two <video> buffers, and the transition
 * package instances and media it owns. A sequence state is a sequence (compound) clip's offscreen side: a private
 * scene with one channel state per inner channel, plus a render target sized to the drawing buffer that the
 * outer channel composites like a regular texture.
 *
 *   engine.channelStates   Map channel id → channel state (top level)
 *   engine.sequenceStates  Map sequence ITEM id → sequence state
 *
 *   syncChannelStates(engine, channels, { soundEnabled, onRemoved })   create / drop / z-order the top level
 *   ensureSequenceState(engine, itemId, seqClip) / disposeSequenceState(st)
 *   pruneSequenceStates(engine, channels, clipsMap)   drop sequence states whose items are gone at every level
 *   resizeChannelStates(engine, w, h)                  a new video size
 *   disposeChannelStates(engine)                       with the renderer: every channel and sequence state
 */
import * as THREE from 'three';
import { materials as makeMaterial } from '../materialFactory';
import { createClipMaterial } from '../clipShader';
import { forgetPerfVideo } from '../perfRegistry.js';
import { applyMute } from '../audioDriftSync';
import { disposeTransitionPackageInstances } from '../transitionPackageRuntime';
import { getTimelineLayout } from '../speedUtils';
import { buildParentIndex } from '../keyframeParenting';
import { SEQUENCE_MAX_DEPTH, isContainerClip } from '../types';
import { createVideoElement, mediaActivation } from './previewMedia';
import { getPerspectiveDistance } from './compositeHelpers';

const DEFAULT_W = 1280;
const DEFAULT_H = 720;

// Channels stack toward the camera, Z_STEP apart, so they sort. Under the perspective camera that depth also
// MAGNIFIED: channel N drew D / (D − Z_STEP·N) larger than placed (0.5 % at 100 channels, 2 % at 430), pushing
// every off-centre layer outward. Each channel group is scaled back by (D − z) / D about the frame centre, so a
// flat layer lands at exactly its position and size wherever it sits in the stack.
const Z_STEP = 0.1;
function stackChannel(cs, z, videoH) {
  cs.group.position.z = z;
  const d = getPerspectiveDistance(videoH || DEFAULT_H);
  cs.group.scale.setScalar(d > z ? (d - z) / d : 1);
}

export function createChannelState(soundEnabled, W = DEFAULT_W, H = DEFAULT_H) {
  const group = new THREE.Group();
  // Project-camera rig: the parent of `group`, carrying the inverse of the camera
  // pose. Only TOP-LEVEL channels are mounted through it — a sequence's inner
  // channels reparent `group` straight into their own scene, so the camera move is
  // applied exactly once (on the sequence clip's plane) instead of twice.
  const rig = new THREE.Group();
  rig.add(group);

  const planeGeo = new THREE.PlaneGeometry(W, H);

  const prevMaterial = makeMaterial.clip() ?? createClipMaterial();
  const currMaterial = makeMaterial.clip() ?? createClipMaterial();
  const prevMesh = new THREE.Mesh(planeGeo, prevMaterial);
  const currMesh = new THREE.Mesh(planeGeo, currMaterial);

  prevMesh.visible = false;
  currMesh.visible = false;
  prevMesh.position.z = 0;
  currMesh.position.z = 0.01;

  group.add(prevMesh, currMesh);

  return {
    group,
    rig,
    planeGeo,
    prevMesh,
    currMesh,
    prevMaterial,
    currMaterial,
    videos: { a: createVideoElement(soundEnabled, true), b: createVideoElement(soundEnabled, true) },
    // User transition packages may add alpha-video/image objects above the two
    // cross-transition planes. Entries are created lazily from the package's
    // Full executable transition packages own a Three.js root and lifecycle
    // instance per installed module revision. Media sources are decoded by Player
    // so preview and WebCodecs export feed the same exact textures to package GLSL.
    transitionPackageInstances: new Map(),
    transitionPackageMedia: new Map(),
    // Last texture successfully shown on this channel — a backstop so a clip
    // boundary can never fall through to a black frame while we have anything to show.
    lastGoodTexture: null,
  };
}

export function disposeChannelState(cs) {
  disposeTransitionPackageInstances(cs);
  cs.prevMaterial.dispose();
  cs.currMaterial.dispose();
  cs.planeGeo.dispose();
  cs.group.clear();
  cs.rig?.clear();
  cs.lastGoodTexture = null; // owned by the texture caches; just drop the reference
  for (const video of [cs.videos.a, cs.videos.b]) {
    forgetPerfVideo(video);
    try {
      video.pause();
      video.src = '';
      video.load();
    } catch { /* no-op */ }
  }
  for (const media of cs.transitionPackageMedia?.values?.() || []) {
    forgetPerfVideo(media.video);
    try { media.video?.pause(); } catch { /* no-op */ }
    try { if (media.video) { media.video.src = ''; media.video.load(); } } catch { /* no-op */ }
  }
  cs.transitionPackageMedia?.clear?.();
}

// `onRemoved(id)` after a channel's state is disposed — the caller's own per-channel resources (its audio element).
export function syncChannelStates(engine, channels, { soundEnabled, onRemoved }) {
  const scene = engine.scene;
  if (!scene) return;
  const { w: W, h: H } = engine.videoSize;
  const nextIds = new Set(channels.map((ch) => ch.id));

  for (const channel of channels) {
    if (!engine.channelStates.has(channel.id)) {
      const cs = createChannelState(soundEnabled, W, H);
      engine.channelStates.set(channel.id, cs);
    }
    const cs = engine.channelStates.get(channel.id);
    // MUTE-ONLY. Project sound off, or (touch tier) no gesture has activated the
    // element yet (mediaActivation; desktop canUnmute is always true), silences
    // both buffers. Whether a buffer SOUNDS is its clip's call — renderChannel
    // applies item.muted / volume / project sound to the owning buffers every
    // frame. This runs at the top of every renderFrame, so unmuting here as well
    // flipped a muted clip's buffer false → true once per frame, and Chromium
    // runs a playing <video>'s clock ~2.4x fast under that (Electron 44 too);
    // the master clock follows the media clock forward, so the playhead raced
    // and stalled over muted clips (tests/ve-playhead-rate/).
    if (!soundEnabled || !mediaActivation.canUnmute(cs.videos.a)) applyMute(cs.videos.a, true);
    if (!soundEnabled || !mediaActivation.canUnmute(cs.videos.b)) applyMute(cs.videos.b, true);
    // Top-level channels hang off the scene through their camera rig.
    if (cs.group.parent !== cs.rig) cs.rig.add(cs.group);
    if (!cs.rig.parent) scene.add(cs.rig);
  }

  for (const [id, cs] of engine.channelStates.entries()) {
    if (nextIds.has(id)) continue;
    if (cs.rig.parent) cs.rig.parent.remove(cs.rig);
    if (cs.group.parent) cs.group.parent.remove(cs.group);
    disposeChannelState(cs);
    engine.channelStates.delete(id);
    onRemoved?.(id);
  }

  // Ensure z-order matches channel array order
  let zBase = 0;
  for (const channel of channels) {
    const cs = engine.channelStates.get(channel.id);
    if (cs) {
      stackChannel(cs, zBase, engine.videoSize?.h);
      zBase += Z_STEP;
    }
  }
}

// Each visible sequence item owns a private scene (one channel state per inner
// channel, same z-stacking as the top level) plus a render target sized to the
// drawing buffer. renderSequenceFrame renders the inner timeline at the mapped
// local time and hands the RT texture back to renderChannel/setupMesh.
export function ensureSequenceState(engine, itemId, seqClip) {
  const renderer = engine.renderer;
  if (!renderer) return null;
  let st = engine.sequenceStates.get(itemId);
  if (!st) {
    st = {
      scene: new THREE.Scene(),
      channelStates: new Map(),
      clipsMap: new Map(),
      layouts: new Map(),
      parentIndex: new Map(),
      clipsKey: null,
      layoutKey: null,
      rt: null,
    };
    engine.sequenceStates.set(itemId, st);
  }
  if (st.clipsKey !== seqClip.sequence.clips) {
    st.clipsKey = seqClip.sequence.clips;
    st.clipsMap = new Map(seqClip.sequence.clips.map((c) => [c.id, c]));
  }
  const seqChannels = seqClip.sequence.channels;
  if (st.layoutKey !== seqChannels) {
    st.layoutKey = seqChannels;
    st.layouts = new Map(seqChannels.map((ch) => [ch.id, getTimelineLayout(ch.items, { unsnapped: ch.unsnapped })]));
    // Parenting is scoped to one editing level, so a sequence gets its own index
    // over its inner channels — a link can never reach out of (or into) a sequence.
    st.parentIndex = buildParentIndex(seqChannels, (ch) => st.layouts.get(ch.id), (item) => st.clipsMap.get(item.clipId));
    const nextIds = new Set(seqChannels.map((ch) => ch.id));
    for (const [id, cs] of st.channelStates.entries()) {
      if (nextIds.has(id)) continue;
      if (cs.group.parent) cs.group.parent.remove(cs.group);
      disposeChannelState(cs);
      st.channelStates.delete(id);
    }
    const { w: W, h: H } = engine.videoSize;
    let zBase = 0;
    for (const ch of seqChannels) {
      let cs = st.channelStates.get(ch.id);
      if (!cs) {
        // Muting is re-applied per frame by renderChannel's item-volume logic.
        cs = createChannelState(true, W, H);
        st.channelStates.set(ch.id, cs);
        st.scene.add(cs.group);
      }
      stackChannel(cs, zBase, H);
      zBase += Z_STEP;
    }
  }
  const sizeVec = renderer.getDrawingBufferSize(new THREE.Vector2());
  const width = Math.max(1, Math.round(sizeVec.x));
  const height = Math.max(1, Math.round(sizeVec.y));
  if (!st.rt) {
    st.rt = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    });
  } else if (st.rt.width !== width || st.rt.height !== height) {
    st.rt.setSize(width, height);
  }
  return st;
}

export function disposeSequenceState(st) {
  for (const cs of st.channelStates.values()) {
    if (cs.group.parent) cs.group.parent.remove(cs.group);
    disposeChannelState(cs);
  }
  st.channelStates.clear();
  if (st.gridGuide) {
    st.gridGuide.parent?.remove(st.gridGuide);
    st.gridGuide.geometry.dispose();
    st.gridGuide.material.dispose();
    st.gridGuide = null;
  }
  try { st.rt?.dispose(); } catch { /* no-op */ }
}

// Drop sequence states whose items no longer exist at any level.
export function pruneSequenceStates(engine, channels, clipsMap) {
  if (!engine.sequenceStates.size) return;
  const live = new Set();
  const walk = (chs, cmap, depth) => {
    if (depth > SEQUENCE_MAX_DEPTH) return;
    for (const ch of chs) {
      for (const it of ch.items) {
        const c = cmap.get(it.clipId);
        if (isContainerClip(c)) {
          live.add(it.id);
          walk(c.sequence.channels, new Map(c.sequence.clips.map((cc) => [cc.id, cc])), depth + 1);
        }
      }
    }
  };
  walk(channels, clipsMap, 0);
  for (const [id, st] of engine.sequenceStates.entries()) {
    if (live.has(id)) continue;
    disposeSequenceState(st);
    engine.sequenceStates.delete(id);
  }
}

// A new video size: the top-level planes get geometry at the new size; sequence states hold geometry sized to the
// old frame — drop their contents so they rebuild lazily at the new size on the next frame.
export function resizeChannelStates(engine, videoWidth, videoHeight) {
  for (const cs of engine.channelStates.values()) {
    const oldGeo = cs.planeGeo;
    const newGeo = new THREE.PlaneGeometry(videoWidth, videoHeight);
    cs.prevMesh.geometry = newGeo;
    cs.currMesh.geometry = newGeo;
    cs.planeGeo = newGeo;
    oldGeo.dispose();
  }

  for (const st of engine.sequenceStates.values()) {
    for (const cs of st.channelStates.values()) {
      if (cs.group.parent) cs.group.parent.remove(cs.group);
      disposeChannelState(cs);
    }
    st.channelStates.clear();
    st.layoutKey = null;
    try { st.rt?.dispose(); } catch { /* no-op */ }
    st.rt = null;
  }
}

// With the renderer: every top-level channel state and every sequence (compound clip) offscreen state.
export function disposeChannelStates(engine) {
  const channelStates = engine.channelStates;
  for (const cs of channelStates.values()) {
    disposeChannelState(cs);
  }
  channelStates.clear();
  // Dispose sequence (compound clip) offscreen states
  for (const st of engine.sequenceStates.values()) {
    for (const cs of st.channelStates.values()) disposeChannelState(cs);
    try { st.rt?.dispose(); } catch { /* no-op */ }
  }
  engine.sequenceStates.clear();
}
