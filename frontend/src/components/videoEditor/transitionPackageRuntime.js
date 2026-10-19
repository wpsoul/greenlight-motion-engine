import * as THREE from 'three';
import * as sdk from './transitionPackageSdk';

function layerFrame(mesh, material, texture, bounds, empty = false, pictureBounds = null, contentBounds = null) {
  return Object.freeze({
    mesh,
    material,
    // `texture` is the fully composed layer plate (fit, filters, item transforms).
    // `sourceTexture` remains available for effects that intentionally want the
    // undecorated media sample.
    texture: texture || null,
    sourceTexture: material?.uniforms?.uTexture?.value || null,
    opacity: material?.uniforms?.uOpacity?.value ?? 1,
    // Where this clip actually sits inside that full-frame plate, in NDC through
    // the same neutral camera the plate was captured with. Packages that want to
    // work at the LAYER's size instead of the whole composition read this; null
    // when it cannot be trusted (see meshScreenBounds).
    bounds,
    // The same box minus the clip's own letterbox/pillarbox bars: where the
    // PICTURE is. A package that folds or clamps at the image edge reads this —
    // the bars are not image, and mirroring at the plane's edge doubles them
    // into a dark seam. null when it cannot be trusted (see meshPictureBounds).
    pictureBounds,
    // The box the layer's CONTENT occupies, as the selection gizmo shows it: a
    // text layer draws on a frame-sized plate, so its `bounds` is the frame while
    // this is the laid-out block (layerContentBox). Every other layer fills its
    // plate and reports `bounds` here.
    contentBounds: contentBounds || bounds,
    // True on the side a layer entrance/exit does not have. The texture is a
    // real (cleared, alpha-0) target so the two-texture shader path still binds,
    // but a package that draws a backdrop or measures a box must know there is
    // nothing there — see the `slot` note on the frame.
    empty,
  });
}

const _boundsCorner = new THREE.Vector3();

// NDC axis-aligned box of one clip plane. The capture meshes are posed in
// neutral space (copyMeshFrame drops the channel group's own transform), so this
// lines up 1:1 with the captured plate's uv. Returns null rather than a wrong
// box: a corner behind the camera projects to nonsense, and callers must be able
// to fall back to the full frame.
function meshScreenBounds(mesh, camera) {
  const geometry = mesh?.geometry;
  if (!geometry || !camera) return null;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return null;
  mesh.updateWorldMatrix(false, false);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 8; i += 1) {
    _boundsCorner.set(
      (i & 1) ? box.max.x : box.min.x,
      (i & 2) ? box.max.y : box.min.y,
      (i & 4) ? box.max.z : box.min.z,
    );
    _boundsCorner.applyMatrix4(mesh.matrixWorld).project(camera);
    if (!Number.isFinite(_boundsCorner.x) || !Number.isFinite(_boundsCorner.y)) return null;
    if (_boundsCorner.x < minX) minX = _boundsCorner.x;
    if (_boundsCorner.x > maxX) maxX = _boundsCorner.x;
    if (_boundsCorner.y < minY) minY = _boundsCorner.y;
    if (_boundsCorner.y > maxY) maxY = _boundsCorner.y;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (!(width > 1e-4) || !(height > 1e-4) || width > 40 || height > 40) return null;
  return Object.freeze({ minX, minY, maxX, maxY, width, height });
}

// The picture's half-window in the clip shader's transformedUv: fit-contain
// letterboxes the spare axis, the same test clipShader.js makes (an ABSOLUTE
// 0.01 aspect tolerance). A mirror-tiled clip has no bars to leave out.
function pictureWindow(uniforms) {
  const res = uniforms.uResolution?.value;
  const canvas = uniforms.uCanvasSize?.value;
  const half = { x: 0.5, y: 0.5 };
  if (!res || !canvas || Number(uniforms.uMirrorTile?.value) > 0.5) return half;
  if (!(res.x > 0 && res.y > 0 && canvas.x > 0 && canvas.y > 0)) return half;
  const mediaAR = res.x / res.y;
  const canvasAR = canvas.x / canvas.y;
  if (Math.abs(mediaAR - canvasAR) <= 0.01) return half;
  if (mediaAR > canvasAR) half.y = 0.5 * (canvasAR / mediaAR);
  else half.x = 0.5 * (mediaAR / canvasAR);
  return half;
}

/*
 * NDC box of the PICTURE inside one clip plane — meshScreenBounds minus the
 * clip shader's letterbox/pillarbox bars. Walks the clip shader's own chain
 * backwards (fit-contain window → uUvScale/uUvOffset → plane expansion → vUv)
 * and projects the resulting sub-rect like the plane itself. A 1344×768 clip
 * in a 16:9 frame carries ~0.8% opaque black bars on both sides, and an edge
 * fill that folds at the plane's edge doubles them into a dark seam.
 *
 * null when the box cannot be trusted: a turned plane is no longer an
 * axis-aligned rect in NDC, and callers keep folding at the plane's edge.
 */
function meshPictureBounds(mesh, camera) {
  const uniforms = mesh?.material?.uniforms;
  const geometry = mesh?.geometry;
  if (!uniforms || !geometry || !camera) return null;
  const turn = mesh.quaternion;
  if (Math.abs(turn.x) + Math.abs(turn.y) + Math.abs(turn.z) > 1e-5) return null;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return null;
  const win = pictureWindow(uniforms);
  const scale = uniforms.uUvScale?.value;
  const offset = uniforms.uUvOffset?.value;
  const canvas = uniforms.uCanvasSize?.value;
  const expand = Math.max(0, Number(uniforms.uPlaneExpand?.value) || 0);
  const range = (axis) => {
    const s = Number(scale?.[axis] ?? 1) || 1;
    const o = Number(offset?.[axis] ?? 0) || 0;
    const a = (0.5 - win[axis] - o) / s;
    const b = (0.5 + win[axis] - o) / s;
    const size = Number(canvas?.[axis]) || 0;
    const e = expand > 0.5 && size > 0 ? (size + 2 * expand) / size : 1;
    const lo = 0.5 + (Math.min(a, b) - 0.5) / e;
    const hi = 0.5 + (Math.max(a, b) - 0.5) / e;
    return [Math.max(0, Math.min(1, lo)), Math.max(0, Math.min(1, hi))];
  };
  const [u0, u1] = range('x');
  const [v0, v1] = range('y');
  if (!(u1 - u0 > 1e-4) || !(v1 - v0 > 1e-4)) return null;
  mesh.updateWorldMatrix(false, false);
  const z = (box.min.z + box.max.z) / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 4; i += 1) {
    const u = (i & 1) ? u1 : u0;
    const v = (i & 2) ? v1 : v0;
    _boundsCorner.set(
      box.min.x + u * (box.max.x - box.min.x),
      box.min.y + v * (box.max.y - box.min.y),
      z,
    );
    _boundsCorner.applyMatrix4(mesh.matrixWorld).project(camera);
    if (!Number.isFinite(_boundsCorner.x) || !Number.isFinite(_boundsCorner.y)) return null;
    if (_boundsCorner.x < minX) minX = _boundsCorner.x;
    if (_boundsCorner.x > maxX) maxX = _boundsCorner.x;
    if (_boundsCorner.y < minY) minY = _boundsCorner.y;
    if (_boundsCorner.y > maxY) maxY = _boundsCorner.y;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (!(width > 1e-4) || !(height > 1e-4) || width > 40 || height > 40) return null;
  return Object.freeze({ minX, minY, maxX, maxY, width, height });
}

// NDC box of a sub-rect of one clip plane, given in box uv (y up) — the text
// block inside a text layer's frame-sized plate. null when it cannot be trusted,
// like meshScreenBounds.
function meshSubRectBounds(mesh, camera, rect) {
  const geometry = mesh?.geometry;
  if (!geometry || !camera || !Array.isArray(rect) || rect.length !== 4) return null;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return null;
  mesh.updateWorldMatrix(false, false);
  const z = (box.min.z + box.max.z) / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 4; i += 1) {
    const u = (i & 1) ? rect[2] : rect[0];
    const v = (i & 2) ? rect[3] : rect[1];
    _boundsCorner.set(
      box.min.x + u * (box.max.x - box.min.x),
      box.min.y + v * (box.max.y - box.min.y),
      z,
    );
    _boundsCorner.applyMatrix4(mesh.matrixWorld).project(camera);
    if (!Number.isFinite(_boundsCorner.x) || !Number.isFinite(_boundsCorner.y)) return null;
    if (_boundsCorner.x < minX) minX = _boundsCorner.x;
    if (_boundsCorner.x > maxX) maxX = _boundsCorner.x;
    if (_boundsCorner.y < minY) minY = _boundsCorner.y;
    if (_boundsCorner.y > maxY) maxY = _boundsCorner.y;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (!(width > 1e-4) || !(height > 1e-4) || width > 40 || height > 40) return null;
  return Object.freeze({ minX, minY, maxX, maxY, width, height });
}

function copyMeshFrame(source, target) {
  target.geometry = source.geometry;
  target.material = source.material;
  target.position.copy(source.position);
  target.quaternion.copy(source.quaternion);
  target.scale.copy(source.scale);
  target.visible = source.visible;
  target.renderOrder = source.renderOrder;
  target.frustumCulled = false;
}

function ensureCaptureTargets(entry, renderer) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const width = Math.max(1, size.x);
  const height = Math.max(1, size.y);
  if (!entry.capture) {
    const camera = entry.camera;
    const previousScene = new THREE.Scene();
    const currentScene = new THREE.Scene();
    const previousMesh = new THREE.Mesh();
    const currentMesh = new THREE.Mesh();
    previousScene.add(previousMesh);
    currentScene.add(currentMesh);
    entry.capture = {
      camera,
      previousScene,
      currentScene,
      previousMesh,
      currentMesh,
      previousTarget: sdk.createRenderTarget(width, height),
      currentTarget: sdk.createRenderTarget(width, height),
    };
    // Debug-level: the perf gate pairs this with the release line below.
    console.debug(`[transitions] allocated capture targets of ${entry.type}:${entry.slot} (${width}×${height})`);
  } else {
    sdk.resizeRenderTarget(entry.capture.previousTarget, width, height);
    sdk.resizeRenderTarget(entry.capture.currentTarget, width, height);
  }
  return entry.capture;
}

/*
 * Which clip mesh feeds each capture lane.
 *
 * A cross transition fills both: the outgoing clip and the incoming one. A
 * layer entrance or exit has only ONE plate — the item being drawn always sits
 * on channelState.currMesh — so it takes the lane that matches its role and the
 * other lane renders EMPTY. Empty means the target is cleared to alpha 0, not
 * that it is skipped: leaving the previous frame's contents there would feed a
 * package the stale plate of an unrelated clip, which is worse than nothing.
 */
function captureSources(channelState, slot) {
  if (slot === 'in') return { previous: null, current: channelState.currMesh };
  // An exit is the OUTGOING lane, so the layer takes `previous` — that is the
  // slot a two-clip package animates away from the camera.
  if (slot === 'out') return { previous: channelState.currMesh, current: null };
  return { previous: channelState.prevMesh, current: channelState.currMesh };
}

function captureInputFrames(entry, channelState, renderer, slot, contentBoxes) {
  const capture = ensureCaptureTargets(entry, renderer);
  const sources = captureSources(channelState, slot);
  // The empty lane still needs valid geometry/material on its capture mesh (the
  // scene is rendered either way); `visible = false` is what makes it draw
  // nothing, and the render still clears the target.
  copyMeshFrame(sources.previous || channelState.currMesh, capture.previousMesh);
  copyMeshFrame(sources.current || channelState.currMesh, capture.currentMesh);
  if (!sources.previous) capture.previousMesh.visible = false;
  if (!sources.current) capture.currentMesh.visible = false;
  sdk.renderToTarget(renderer, {
    scene: capture.previousScene,
    camera: capture.camera,
    target: capture.previousTarget,
  });
  sdk.renderToTarget(renderer, {
    scene: capture.currentScene,
    camera: capture.camera,
    target: capture.currentTarget,
  });
  // After the renders: renderToTarget is what refreshes the camera's world
  // inverse, and project() needs it current.
  capture.previousBounds = sources.previous ? meshScreenBounds(capture.previousMesh, capture.camera) : null;
  capture.currentBounds = sources.current ? meshScreenBounds(capture.currentMesh, capture.camera) : null;
  capture.previousPicture = capture.previousBounds ? meshPictureBounds(capture.previousMesh, capture.camera) : null;
  capture.currentPicture = capture.currentBounds ? meshPictureBounds(capture.currentMesh, capture.camera) : null;
  capture.previousContent = capture.previousBounds && contentBoxes?.previous
    ? meshSubRectBounds(capture.previousMesh, capture.camera, contentBoxes.previous) : null;
  capture.currentContent = capture.currentBounds && contentBoxes?.current
    ? meshSubRectBounds(capture.currentMesh, capture.camera, contentBoxes.current) : null;
  capture.sources = sources;
  return capture;
}

/*
 * MEMORY DISCIPLINE (user audit, 2026-09-11): an entry holds the package's
 * instance (its loaded assets, materials, scene) AND two full-frame capture
 * targets. The targets are the bulk, and they are only read inside
 * captureInputFrames, so an entry that has not rendered for a moment gives them
 * back and re-allocates them synchronously on its next frame (a plain
 * WebGLRenderTarget, no async, so no blank frame — unlike re-creating the
 * INSTANCE, whose createInstance may be async and would draw nothing while
 * pending, mid-playback or mid-export). Instances themselves are only evicted
 * when the project no longer references their package (pruneTransitionPackageInstances),
 * or when a newer revision supersedes them — never by LRU, because a timeline
 * with many packages would thrash them through that async gap.
 */
const CAPTURE_IDLE_MS = 1500;

function releaseCaptureTargets(entry) {
  const capture = entry?.capture;
  if (!capture) return false;
  try { capture.previousTarget?.dispose?.(); } catch { /* best effort */ }
  try { capture.currentTarget?.dispose?.(); } catch { /* best effort */ }
  entry.capture = null;
  // Debug-level: the perf gate listens for this line to prove the release.
  console.debug(`[transitions] released capture targets of ${entry.type}:${entry.slot}`);
  return true;
}

// Give back the capture targets of every entry on this channel that has not
// rendered for CAPTURE_IDLE_MS. Called from the render path and from the hide
// path, so a channel that stopped transitioning altogether also releases them.
// Player's idle sweep (paused editor) calls this for every channel, so a
// channel that stopped transitioning releases its captures without a render.
export function releaseIdleTransitionCaptures(channelState, now = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
  releaseIdleCaptures(channelState, now);
}

function releaseIdleCaptures(channelState, now) {
  for (const entry of channelState?.transitionPackageInstances?.values?.() || []) {
    if (entry.capture && !entry.disposed && now - (entry.lastRenderAt || 0) > CAPTURE_IDLE_MS) {
      releaseCaptureTargets(entry);
    }
  }
}

function disposeEntry(entry) {
  if (!entry || entry.disposed) return;
  entry.disposed = true;
  try { entry.instance?.dispose?.(); } catch (error) {
    console.warn('[transitions] Package dispose failed:', error?.message || error);
  }
  try { sdk.disposeObject3D(entry.root); } catch { /* best effort */ }
  try { entry.capture?.previousTarget?.dispose?.(); } catch { /* best effort */ }
  try { entry.capture?.currentTarget?.dispose?.(); } catch { /* best effort */ }
  entry.capture?.previousScene?.clear?.();
  entry.capture?.currentScene?.clear?.();
  entry.root?.parent?.remove?.(entry.root);
}

function queueEntryRender(entry, requestRender) {
  if (!entry || entry.disposed || entry.renderRequested) return;
  entry.renderRequested = true;
  queueMicrotask(() => {
    entry.renderRequested = false;
    if (!entry.disposed) requestRender?.();
  });
}

function createEntry({ channelState, preset, renderer, camera, width, height, requestRender, slot = 'cross' }) {
  const root = new THREE.Group();
  root.name = `transition-package:${preset.id || preset.type}:${slot}`;
  root.visible = false;
  // Channels share one scene, stacked by z 0.1 apart with depth testing off, so
  // stacking is purely the transparent painter sort. A renderOrder on this group
  // would become three.js groupOrder for every package mesh and sort BEFORE
  // depth — hoisting the transition above unrelated higher channels. Sit just
  // above this channel's clip planes (prev z 0, curr z 0.01) and stay inside
  // its z band instead.
  root.position.z = 0.02;
  channelState.group.add(root);
  const entry = {
    key: `${preset.type}:${preset.rev || 'builtin'}:${slot}`,
    type: preset.type,
    rev: preset.rev,
    slot,
    root,
    instance: null,
    pending: null,
    error: null,
    width,
    height,
    disposed: false,
    camera,
    capture: null,
    renderRequested: false,
  };
  /*
   * A PACKAGE IS BUILT FOR ONE RENDERER, AND THIS IS WHERE THAT IS ENFORCED.
   *
   * Its shading is GLSL or TSL, and each draws on exactly one engine while the
   * other quietly draws nothing. Refusing here — before createInstance runs —
   * turns "the transition is blank" into a sentence naming both engines, and it
   * catches the packages whose materials the SDK never sees (a hand-built
   * ShaderMaterial), which its own guards cannot.
   *
   * Only a package that DECLARES an engine, or whose shading entry point
   * declared it by being called, is refused; `renderer: null` means no claim,
   * and no claim is not evidence of a mismatch.
   */
  const wants = preset.renderer;
  if ((wants === 'webgpu' || wants === 'webgl') && wants !== (renderer?.isWebGPURenderer ? 'webgpu' : 'webgl')) {
    const engine = (name) => (name === 'webgpu' ? 'WebGPU' : 'the classic');
    entry.error = new Error(`"${preset.name || preset.type}" is built for ${engine(wants)} renderer, `
      + `and this project renders on ${engine(wants === 'webgpu' ? 'webgl' : 'webgpu')} one.`);
    console.warn(`[transitions] ${entry.error.message}`);
    return entry;
  }
  const scheduleRender = () => queueEntryRender(entry, requestRender);
  const initContext = Object.freeze({
    runtimeVersion: sdk.RUNTIME_VERSION,
    THREE,
    sdk,
    renderer,
    camera,
    root,
    width,
    height,
    assets: Object.freeze({ ...(preset.assetMap || {}) }),
    requestRender: scheduleRender,
  });
  const acceptInstance = (instance, repaint = true) => {
    if (entry.disposed) {
      try { instance?.dispose?.(); } catch { /* best effort */ }
      return null;
    }
    if (!instance || typeof instance.render !== 'function') {
      throw new Error('createInstance() must return an object with render(frame).');
    }
    entry.instance = instance;
    entry.pending = null;
    if (repaint) scheduleRender();
    return instance;
  };
  try {
    const created = preset.createInstance(initContext);
    if (created && typeof created.then === 'function') {
      entry.pending = Promise.resolve(created).then(acceptInstance).catch((error) => {
        entry.error = error;
        entry.pending = null;
        console.warn(`[transitions] Package "${preset.name || preset.type}" failed to initialize:`, error?.message || error);
        requestRender?.();
        return null;
      });
    } else {
      // The caller renders this synchronous instance immediately after inserting
      // the entry into its cache. Do not repaint recursively during construction.
      acceptInstance(created, false);
    }
  } catch (error) {
    entry.error = error;
    console.warn(`[transitions] Package "${preset.name || preset.type}" failed to initialize:`, error?.message || error);
  }
  return entry;
}

export function hideTransitionPackageInstances(channelState) {
  for (const entry of channelState?.transitionPackageInstances?.values?.() || []) {
    if (entry.root) entry.root.visible = false;
  }
  releaseIdleCaptures(channelState, performance.now());
}

// Drop every instance whose package the project no longer references. `isLive`
// receives (type, slot) and answers whether any transition in the project still
// uses that package in that role; the Player calls this when the project's
// transition set changes. Nothing is evicted on a time basis — see the memory
// note above disposeEntry.
export function pruneTransitionPackageInstances(channelState, isLive) {
  const map = channelState?.transitionPackageInstances;
  if (!map || typeof isLive !== 'function') return 0;
  let dropped = 0;
  for (const [key, entry] of [...map.entries()]) {
    let live = true;
    try { live = !!isLive(entry.type, entry.slot); } catch { live = true; }
    if (live) continue;
    disposeEntry(entry);
    map.delete(key);
    dropped += 1;
  }
  return dropped;
}

// Bytes held by this channel's capture targets right now (for gates and logs).
export function transitionPackageCaptureBytes(channelState) {
  let bytes = 0;
  for (const entry of channelState?.transitionPackageInstances?.values?.() || []) {
    for (const target of [entry.capture?.previousTarget, entry.capture?.currentTarget]) {
      if (target?.width && target?.height) bytes += target.width * target.height * 4;
    }
  }
  return bytes;
}

// True while a package is actively drawing this channel's transition. Packages
// typically hide BOTH clip planes and show their own root instead, so "is a
// clip mesh visible" checks (depth probes, focus probes) need this to know the
// channel is still showing content at the clip planes' pose.
export function hasVisibleTransitionPackageInstances(channelState) {
  for (const entry of channelState?.transitionPackageInstances?.values?.() || []) {
    if (entry.root?.visible) return true;
  }
  return false;
}

export function renderTransitionPackage({
  channelState,
  preset,
  renderer,
  camera,
  width,
  height,
  progress,
  rawProgress,
  duration,
  options,
  media,
  isPlaying,
  exporting,
  requestRender,
  // 'cross' animates between two clips; 'in' / 'out' drive one layer's entrance
  // or exit, where the opposite lane is empty (see captureSources).
  slot = 'cross',
  // { previous, current }: each lane's content rect in box uv (layerContentBox),
  // null for a layer that fills its plate. Feeds the frame's contentBounds.
  contentBoxes = null,
}) {
  if (!channelState || !preset || typeof preset.createInstance !== 'function') return false;
  if (!channelState.transitionPackageInstances) channelState.transitionPackageInstances = new Map();
  // One instance per slot: a clip can legitimately run the same package as its
  // cross transition and as its exit, and they must not share uniform state.
  const key = `${preset.type}:${preset.rev || 'builtin'}:${slot}`;
  let entry = channelState.transitionPackageInstances.get(key);
  if (!entry) {
    for (const [oldKey, oldEntry] of channelState.transitionPackageInstances) {
      // Only a superseded REVISION of this package in this same slot is stale.
      // The other slots' instances belong to other transitions on this channel.
      if (oldEntry.type === preset.type && oldEntry.slot === slot && oldKey !== key) {
        disposeEntry(oldEntry);
        channelState.transitionPackageInstances.delete(oldKey);
      }
    }
    entry = createEntry({ channelState, preset, renderer, camera, width, height, requestRender, slot });
    channelState.transitionPackageInstances.set(key, entry);
  }
  entry.root.visible = true;
  const now = performance.now();
  entry.lastRenderAt = now;
  releaseIdleCaptures(channelState, now);
  if (!entry.instance || entry.error) return true;
  if (entry.width !== width || entry.height !== height) {
    entry.width = width;
    entry.height = height;
    try { entry.instance.resize?.({ width, height, renderer, camera }); }
    catch (error) { entry.error = error; }
  }
  if (entry.error) return true;
  const capture = captureInputFrames(entry, channelState, renderer, slot, contentBoxes);
  // The material behind each lane, which is how a package reads the layer's own
  // opacity and undecorated sample. It follows the clip, not the lane name.
  const previousMaterial = slot === 'out' ? channelState.currMaterial : channelState.prevMaterial;
  const currentMaterial = channelState.currMaterial;
  // The empty lane still hands over a mesh (a package hides both to draw its
  // own output) and a texture (cleared, alpha 0), but no material — so
  // `opacity` and `sourceTexture` read as "nothing", not as the layer's.
  const emptyMesh = channelState.prevMesh;
  const frame = Object.freeze({
    progress,
    rawProgress,
    timeSec: rawProgress * duration,
    duration,
    options: Object.freeze({ ...options }),
    width,
    height,
    renderer,
    camera,
    root: entry.root,
    slot,
    previous: capture.sources.previous
      ? layerFrame(capture.sources.previous, previousMaterial,
        capture.previousTarget.texture, capture.previousBounds, false, capture.previousPicture, capture.previousContent)
      : layerFrame(emptyMesh, null, capture.previousTarget.texture, null, true),
    current: capture.sources.current
      ? layerFrame(capture.sources.current, currentMaterial, capture.currentTarget.texture,
        capture.currentBounds, false, capture.currentPicture, capture.currentContent)
      : layerFrame(emptyMesh, null, capture.currentTarget.texture, null, true),
    media,
    isPlaying: !!isPlaying,
    exporting: !!exporting,
    requestRender: () => queueEntryRender(entry, requestRender),
  });
  try {
    const result = entry.instance.render(frame);
    if (result && typeof result.then === 'function') {
      throw new Error('render(frame) must be synchronous and deterministic; perform async loading in createInstance().');
    }
  } catch (error) {
    entry.error = error;
    console.warn(`[transitions] Package "${preset.name || preset.type}" render failed:`, error?.message || error);
  }
  return true;
}

export function disposeTransitionPackageInstances(channelState) {
  for (const entry of channelState?.transitionPackageInstances?.values?.() || []) disposeEntry(entry);
  channelState?.transitionPackageInstances?.clear?.();
}

// Export may encounter a package for the first time on the exact frame where its
// overlap starts. Wait for async package initialization, then let Player repaint
// that same frame before it is handed to the encoder. Preview remains non-blocking.
export async function waitForTransitionPackageInstances(channelStates, timeoutMs = 30000) {
  const pending = [];
  for (const channelState of channelStates || []) {
    for (const entry of channelState?.transitionPackageInstances?.values?.() || []) {
      if (entry.pending) pending.push(entry.pending);
    }
  }
  if (!pending.length) return false;
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Transition package initialization exceeded ${timeoutMs}ms.`)), timeoutMs);
  });
  try {
    await Promise.race([Promise.all(pending), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
  return true;
}
