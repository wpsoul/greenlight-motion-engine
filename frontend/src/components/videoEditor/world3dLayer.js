/*
 * The Scene layer's bridge to the world renderer.
 *
 * The world runs on its own GPU device with its own three (src/world3d/host.js, prebuilt into public/world3d). Each frame
 * it paints one canvas, the picture over its depth; this module turns that into what the compositor already understands
 * from a model pass: a colour plate and a real depth texture in the compositor's near/far. Keyframes, parents, the camera
 * and every gizmo stay the editor's; only the picture comes from elsewhere.
 *
 * Nothing here loads unless a project's Rig asks for the world, and a machine that cannot run it stays on the Rig's own
 * passes: a refusal costs the new renderer, never the layer.
 */
import * as THREE from 'three';
import { materials as makeMaterial } from './materialFactory';
import { cameraProxyFromPose } from './projectCamera';
import { getCameraDofSettings } from './projectCamera';
import { normalizeRig, resolveRigAt } from './rig3d';
import { WORLD_UNITS, worldCamera, worldLens, worldLiveValues, worldMatrix, worldSceneFromRig, worldSteer } from './world3dScene.js';
import { resolveActiveIndex } from './engine/compositeHelpers';
import { PARTICLE_MEDIA_TYPE } from '../../sim/particles/schema';
import { rigUsesWorld } from './rig3d';
import { isAutoFillEnabled } from './autoFillLayer';
import { isModelFxOverlay } from './model3dFxCatalog';

const hostUrl = () => new URL('world3d/world3d.js', document.baseURI).href;
const weightsUrl = (size = 'small') => new URL(`world3d/rt_hdr_calb_cnrm_${size}.tza`, document.baseURI).href;

/** The world's near and far, in world units; WorldRenderer's camera uses the same pair. */
const WORLD_NEAR = 0.02, WORLD_FAR = 200;

const state = { load: null, loadShown: false, loadTimer: null, loadListeners: new Set(),
  host: null, loading: null, failed: null,
  key: null, building: false, ready: false,
  // builtKey is the scene the world holds; generation counts project switches (worldProjectChanged), taken when a build starts
  builtKey: null, builtGeneration: 0, generation: 0,
  plateGeneration: -1, // the generation whose frame the plate holds; -1 is none
  poseKey: null, final: false, filming: false, filmedPose: null, traceOptions: null, touched: 0, pumping: false, fresh: false,
  plate: null,        // { texture, target, material, scene, width, height, camera }
  sceneError: null, sceneWarnings: [], listeners: new Set(),
};

if (import.meta.env?.DEV && typeof window !== 'undefined') window.__world3d = state;

export const isWorldRig = rigUsesWorld;

/** What the last scene build said, for a server still: an agent cannot see the Scene panel, and a failed op leaves the old picture.
 *  `inspect` adds each object's bounds and ground gap, the pairs that touch, and what the scene's camera has in frame. */
export function worldSceneReport({ inspect = false } = {}) {
  if (!state.key) return null;
  const report = { built: state.ready, error: state.sceneError, warnings: state.sceneWarnings };
  if (inspect && state.ready) report.inspect = state.host.inspect();
  return report;
}

// The layer's own colour filters, keyed or not. The world has no way to apply them, so a filtered model keeps its own pass.
const isPlainPicture = (item) => (item?.filterBlur || 0) === 0 && !item?.filterHueRotate && !item?.filterGrayscale && !item?.filterSepia && !item?.filterInvert
  && [item?.filterBrightness, item?.filterContrast, item?.filterSaturation].every((v) => v == null || v === 100);

/** Real-3D effects and Grow Fill run inside a model's own pass, on its own surfaces. Such a layer keeps that pass, and takes its place in
 *  the world by depth, so nothing a project already has goes missing when it joins one. */
export const modelKeepsOwnPass = (item) => isAutoFillEnabled(item) || !!item?.effects?.some?.((e) => isModelFxOverlay(e) || !e?.muted)
  || !isPlainPicture(item);

/** How far a loading scene has got, in the player bar. Most builds are over in a moment, so nothing shows for the first 400 ms: an edit must not flicker. */
function reportLoad(next) {
  state.load = next;
  if (!next) {
    clearTimeout(state.loadTimer);
    state.loadTimer = null;
    state.loadShown = false;
  } else if (!state.loadShown) {
    state.loadTimer ??= setTimeout(() => {
      state.loadTimer = null;
      state.loadShown = !!state.load;
      for (const f of state.loadListeners) f(state.load);
    }, 400);
    return;
  }
  for (const f of state.loadListeners) f(next);
}

export function watchWorldLoad(listener) {
  state.loadListeners.add(listener);
  listener(state.loadShown ? state.load : null);
  return () => state.loadListeners.delete(listener);
}

/** Why the Scene's last build failed, as it changes. Returns the unsubscribe. */
export function watchWorldError(listener) {
  state.listeners.add(listener);
  listener(state.sceneError);
  return () => state.listeners.delete(listener);
}
export const worldFailed = () => state.failed;
export const worldInUse = () => state.ready;

// The compositor may be on either backend: the world brings its own device, and a canvas crosses to both.
const canRun = () => !state.failed && typeof navigator !== 'undefined' && !!navigator.gpu;

/** GLSL twin of compositeNodes.createWorldPlateNodeMaterial. */
function createWorldPlateMaterial({ worldNear, worldFar, worldUnits }) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,      // gl_FragDepth does not exist in ES 1.00 (clipShader.js, createDepthStampMaterial)
    uniforms: { uHandoff: { value: null }, uShadow: { value: 0 }, uNear: { value: 1 }, uFar: { value: 100000 } },
    vertexShader: `
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`,
    fragmentShader: `
precision highp float;
uniform sampler2D uHandoff;
uniform float uNear, uFar, uShadow;
in vec2 vUv;
out vec4 fragColor;
void main() {
  // A canvas uploads top row first, so here the picture is the half at high v.
  fragColor = texture(uHandoff, vec2(vUv.x, 0.5 + vUv.y * 0.5));
  vec4 packed = texture(uHandoff, vec2(vUv.x, vUv.y * 0.5));
  fragColor.a = packed.b;   // a canvas drops alpha, so coverage comes in the depth band
  bool empty = packed.r >= 0.999 && packed.g >= 0.999;
  // The shadows alone: what has coverage and no surface.
  if (uShadow > 0.5 && !empty) fragColor = vec4(0.0);
  if (empty) { gl_FragDepth = 1.0; return; }
  float encoded = (floor(packed.r * 255.0 + 0.5) + packed.g) / 255.0;
  float distance = ${worldNear.toFixed(4)} * pow(${(worldFar / worldNear).toFixed(4)}, encoded) / ${worldUnits.toFixed(6)};
  // Past the compositor's far plane is still a surface: a world that fills the frame stands there, and a depth of 1 means nothing here.
  gl_FragDepth = min(uFar * (distance - uNear) / ((uFar - uNear) * distance), 0.99999);
}
`,
    // Always, not off: with the test off GL drops the depth writes too.
    depthTest: true, depthFunc: THREE.AlwaysDepth, depthWrite: true, transparent: false, toneMapped: false,
  });
}

function requestHost(engine, W, H) {
  if (state.loading) return state.loading;
  reportLoad({ stage: 'starting' });
  state.loading = import(/* @vite-ignore */ hostUrl())
    .then((m) => m.createWorldHost({ width: W, height: H, oidnWeights: weightsUrl(), oidnWeightsLarge: weightsUrl('large'), guestUrl: new URL('world3d/world3d-eval.js', document.baseURI).href, rigidUrl: new URL('world3d/world3d-rigid.js', document.baseURI).href }))
    .then((host) => { state.host = host; if (!engine.exporting && !engine.isPlaying) engine.renderFrame?.(); })
    .catch((e) => { state.failed = e; console.warn('[world3d] staying on the Rig passes:', e); });
  return state.loading;
}

// What a layer on the timeline asks the world for. Built once per model, since a shape's arrays do not change with time.
function collectModels(engine, env, time, mod) {
  const models = [], materials = {}, parts = [], particles = [];
  for (const channel of env.channels) {
    if (channel.visible === false || channel.cameraLocked || !channel.items?.length) continue;
    const layout = env.layoutMap.get(channel.id);
    const index = layout ? resolveActiveIndex(layout, time) : -1;
    if (index < 0) continue;
    const item = channel.items[index];
    const clip = env.clipsMap.get(item?.clipId);
    // Particles the user asked to see as objects: the same solver, lit and shadowed by the set, and traced in Final.
    if (clip?.mediaType === PARTICLE_MEDIA_TYPE && item.particleLook === '3d' && item.particleSystem) {
      const r = item.particleSystem.render || {};
      const opaque = (r.colorOverLife || []).reduce((best, k) => (parseInt(k.color.slice(7, 9) || 'ff', 16) > parseInt(best.slice(7, 9) || '00', 16) ? k.color : best), '#ffffff00');
      particles.push({
        id: item.id, name: channel.name, look: '3d', system: item.particleSystem, scale: WORLD_UNITS,
        size: (r.size?.start ?? 9) * WORLD_UNITS * 0.5, palette: [opaque.slice(0, 7)], start: layout[index].startTime, duration: layout[index].duration,
      });
      continue;
    }
    if (clip?.mediaType !== 'model3d' || !mod.getModelObject(item.id) || modelKeepsOwnPass(item)) continue;
    const url = mod.resolveModelUrlFor(item, clip);
    const physics = item.model3dConfig?.physics;
    const rigid = physics === 'falls' ? { rigid: true } : physics === 'solid' ? { rigid: { fixed: true } } : {};
    if (url && !url.startsWith('model-primitive:')) {
      models.push(mod.isSplatUrl(url) ? { id: item.id, name: channel.name, splat: url, ...rigid } : { id: item.id, name: channel.name, url, ...rigid });
      continue;
    }
    (mod.modelBakedParts(item.id) || []).forEach((p, i) => {
      const id = `${item.id}:${i}`;
      materials[id] = { ...p.material, doubleSided: true };
      // `rev` stands for the arrays, which the rebuild key cannot see: a cube swapped for a sphere changes nothing else in the scene.
      models.push({ id, name: channel.name, baked: id, material: id, rev: `${url}|${JSON.stringify(item.model3dConfig?.primitive ?? null)}|${p.position.length}`, ...rigid });
      parts.push({ id, itemId: item.id, part: p });
    });
  }
  return { models, materials, parts, particles };
}

async function readWithProgress(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load ${url}`);
  const total = Number(r.headers.get('content-length')) || 0;
  if (!total || !r.body) return r.arrayBuffer();
  const chunks = [], reader = r.body.getReader();
  let done = 0;
  for (;;) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    chunks.push(value);
    done += value.length;
    reportLoad({ stage: 'geometry', done, total });
  }
  const bytes = new Uint8Array(done);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  return bytes.buffer;
}

/** Finished geometry an object keeps in a file of its own, so a converted scene does not sit in the project file. */
async function loadMeshFile(object) {
  const { url, position, normal, uv, index, indexType } = object.mesh;
  state.meshFiles ||= new Map();
  if (!state.meshFiles.has(url)) state.meshFiles.set(url, readWithProgress(url));
  const bytes = await state.meshFiles.get(url);
  const view = ([at, size], Type) => new Type(bytes, at, size / Type.BYTES_PER_ELEMENT);
  return {
    position: view(position, Float32Array), normal: normal && view(normal, Float32Array), uv: uv && view(uv, Float32Array),
    index: view(index, indexType === 'uint16' ? Uint16Array : Uint32Array),
    // Scattered copies of one mesh come as a list of matrices in the same file.
    matrix: object.mesh.placements ? view(object.mesh.placements, Float32Array) : object.matrix,
  };
}

async function buildScene(engine, scene, parts, backdrop) {
  const { host } = state;
  // Placement arrives with each frame's pose, so the arrays themselves stand at the origin.
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (backdrop) host.setBaked('backdrop', { ...backdrop, matrix: IDENTITY });
  for (const { id, part } of parts) host.setBaked(id, { ...part, matrix: IDENTITY });
  await Promise.all([
    ...scene.objects.filter((o) => o.model).map((o) => host.loadModel(o.model)),
    ...scene.objects.filter((o) => o.splat).map((o) => host.loadSplat(o.splat)),
    ...scene.objects.filter((o) => o.mesh).map(async (o) => { host.setBaked(o.baked, await loadMeshFile(o)); }),
    ...(scene.env.hdri ? [host.loadHdri(scene.env.hdri)] : []),
  ]);
  host.world.onProgress = (stage, done, total) => reportLoad({ stage, done, total });
  state.sceneWarnings = (await host.setScene(scene)) || [];
  reportLoad({ stage: 'frame' });
  state.poseKey = null;
  // A new splat order lands a few frames after the camera stopped, and a long jump in time solves a little per frame, so a paused
  // frame has to be drawn again to show them.
  host.world.onRepaint = () => {
    state.poseKey = null;
    const e = state.engine;
    if (e && !e.exporting && !e.isPlaying) e.renderFrame?.();
  };
}

function ensurePlate(width, height, renderer) {
  const { host } = state;
  let p = state.plate;
  // Tied to the compositor it was made for: a node material reaching WebGLRenderer takes the page down, and the switch keeps this module.
  if (p && p.width === width && p.height === height && p.renderer === renderer) return p;
  if (p) { p.target.dispose(); p.shadowTarget.dispose(); p.texture.dispose(); p.material.dispose(); p.shadowMaterial.dispose(); }
  const handoff = new THREE.CanvasTexture(host.canvas);
  handoff.colorSpace = THREE.NoColorSpace;
  handoff.magFilter = handoff.minFilter = THREE.NearestFilter;
  handoff.generateMipmaps = false;
  handoff.premultiplyAlpha = false;
  const depthTexture = new THREE.DepthTexture(width, height);
  const target = new THREE.RenderTarget(width, height, { depthBuffer: true, depthTexture, type: THREE.UnsignedByteType });
  target.texture.colorSpace = THREE.NoColorSpace;
  const units = { worldNear: WORLD_NEAR, worldFar: WORLD_FAR, worldUnits: WORLD_UNITS };
  const material = makeMaterial.worldPlate(units) ?? createWorldPlateMaterial(units);
  material.uniforms.uHandoff.value = handoff;
  const scene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);
  const shadowTarget = new THREE.RenderTarget(width, height, { depthBuffer: true, type: THREE.UnsignedByteType });
  shadowTarget.texture.colorSpace = THREE.NoColorSpace;
  const shadowMaterial = makeMaterial.worldPlate(units) ?? createWorldPlateMaterial(units);
  shadowMaterial.uniforms.uHandoff.value = handoff;
  shadowMaterial.uniforms.uShadow.value = 1;
  const shadowScene = new THREE.Scene();
  const shadowQuad = new THREE.Mesh(quad.geometry, shadowMaterial);
  shadowQuad.frustumCulled = false;
  shadowScene.add(shadowQuad);
  p = state.plate = { renderer, texture: handoff, target, material, scene, shadowTarget, shadowMaterial, shadowScene, width, height, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
  return p;
}

/**
 * Called once per frame, after every model is posed and before any channel draws. Returns true when this frame's Scene
 * layer will come from the world.
 */
export function prepareWorldFrame(engine, env, time) {
  state.engine = engine;       // a switch of compositor brings a new one, and the world outlives it
  engine.worldFrameReady = false;
  engine.worldShadowTexture = null;
  const rig = engine.activeRigAt?.(time);
  if (!isWorldRig(rig) || !canRun()) return false;
  const mod = engine.model3d;
  const { w: W, h: H } = engine.videoSize;
  if (!state.host) { requestHost(engine, W, H); return false; }
  if (!mod?.cycloramaArrays) return false;

  const { models, materials, parts, particles } = collectModels(engine, env, time, mod);
  const backdrop = mod.cycloramaArrays(rig, H);
  const options = { W, H, models, materials, particles, backdrop: !!backdrop };
  const { look, exposure = 1, ...structure } = worldSceneFromRig(rig, options);
  const scene = { ...structure, look, exposure };
  // Film settings change a shader's numbers, so a slider must not rebuild the world. Nor does a Rig's key: it moves the lights, the
  // environment and the backdrop's paint on every frame, which the world takes in place, so the key is the Rig as it rests.
  const resting = resolveRigAt(engine.rigEntries, time)?.rig;
  const keyed = !!resting && resting !== rig;
  const restingScene = keyed ? worldSceneFromRig(resting, options) : null;
  if (restingScene) { delete restingScene.look; delete restingScene.exposure; }
  const key = JSON.stringify(restingScene || structure);
  const lookKey = JSON.stringify([look, exposure]);
  if (lookKey !== state.lookKey && state.ready) {
    state.lookKey = lookKey;
    state.host.world.setExposure(exposure);
    state.host.world.setLook(look);
  }
  // The values at the playhead, while a key moves them and once more after it stops, to put the resting ones back. Unkeyed, nothing.
  const live = keyed || state.liveKey ? worldLiveValues(scene) : null;
  const liveKey = live && JSON.stringify(live);
  let rebuild = key !== state.key;
  if (!rebuild && live && liveKey !== state.liveKey && state.ready && !state.building) {
    if (state.host.world.relight(live)) state.liveKey = keyed ? liveKey : null;
    else rebuild = true;     // lights of another kind: a panel narrowed into a focused one
  }
  if (rebuild && !state.building) {
    state.building = true;
    state.key = key;
    state.lookKey = lookKey;
    state.liveKey = keyed ? liveKey : null;
    const generation = state.generation;
    buildScene(engine, scene, parts, backdrop)
      .then(() => { state.ready = true; state.sceneError = null; state.builtKey = key; state.builtGeneration = generation; })
      .catch((e) => {
        // The scene is wrong, not the renderer: say so on the Scene, keep the Rig's own passes, and try again on the next edit.
        state.ready = false;
        reportLoad(null);
        state.sceneError = String(e?.message || e);
        console.warn('[world3d] scene failed:', e);
      })
      .finally(() => { state.building = false; if (state.releasing) { releaseWorld(); return; } for (const f of state.listeners) f(state.sceneError); if (!engine.isPlaying) engine.renderFrame?.(); });
  }
  // While an edit rebuilds, the last picture stays. Another project's world is not this one: it neither shows nor traces, and the
  // loading notice stands in until this project's scene is built.
  if (state.ready && state.builtKey !== key && state.builtGeneration !== state.generation) {
    state.host.world.setTrace(false);
    if (!state.load) reportLoad({ stage: 'objects' });
    return false;
  }
  if (!state.ready) return false;

  const { host } = state;
  const buf = engine.renderer.getDrawingBufferSize(new THREE.Vector2());
  const width = Math.max(1, Math.round(engine.exporting ? W : (buf.x || W))), height = Math.max(1, Math.round(engine.exporting ? H : (buf.y || H)));
  host.world.setSize(width, height);

  const locked = engine.worldActive;
  const proxy = !locked && engine.cameraPose ? cameraProxyFromPose(engine.cameraPose, W, H) : null;
  // A scene that names its own camera films from it, keys included. Delete it to hand the shot to the Camera layer.
  const ownCamera = !!rig.scene?.camera;
  host.world.freeCamera = !ownCamera;
  const rest = (H * 0.5) / Math.tan((28 * Math.PI) / 180 / 2);
  const camera = ownCamera ? null : worldCamera(proxy, rest);
  const steer = ownCamera && proxy ? worldSteer(proxy, rest) : null;
  const objects = {};
  for (const m of models) {
    if (m.url || m.splat) { const e = mod.modelWorldMatrix(m.id); if (e) objects[m.id] = worldMatrix(e); }
  }
  for (const { id, itemId, part } of parts) {
    const e = mod.modelWorldMatrix(itemId);
    if (e) objects[id] = worldMatrix(new THREE.Matrix4().fromArray(e).multiply(new THREE.Matrix4().fromArray(part.matrix)).elements);
  }
  // Screens and clips: the editor's side keeps playing them, and the world wears the result.
  const nodePoses = {};
  for (const m of models) {
    if (!m.url) continue;
    host.world.setScreens(m.id, mod.modelScreensForWorld(m.id));
    const pose = mod.modelNodePose(m.id);
    if (pose) nodePoses[m.id] = pose;
  }
  // Moving nothing must not cost a frame, or a resting trace would start over on every repaint.
  if (backdrop) objects.backdrop = worldMatrix(backdrop.matrix);
  const D = (H * 0.5) / Math.tan((28 * Math.PI) / 180 / 2);
  const lens = ownCamera ? null : worldLens(getCameraDofSettings(engine.cameraPose, D), W, camera.fov, W / H);
  const poseKey = JSON.stringify([camera, steer, objects, lens, time]);
  if (poseKey !== state.poseKey) {
    state.poseKey = poseKey;
    state.touched = performance.now();
    host.world.setPose({ camera, steer, objects, lens, time, nodePoses });
  }
  host.world.setPlaying(!!engine.isPlaying);
  // Off in the preview unless the Scene asks, and always in a render: speed is for the person watching.
  host.world.setRasterShadows(rig.render?.draftShadows === true || !!engine.exporting);
  host.world.trace.exposure = (rig.render?.exposure ?? 1) * normalizeRig(rig).env.exposure;
  // Final 3D waits until hands stop: scrubbing stays in Draft, and the trace comes back right after.
  // A render's traced frame stays until the pose moves on: more repaints follow it before the frame is read.
  const filming = state.filming || state.filmedPose === poseKey;
  host.world.setTrace(filming || (state.final && !engine.isPlaying && !engine.exporting && performance.now() - state.touched > 180));
  // A WebGPU canvas is blank again once it has been shown, so the plate only reads frames drawn in this same task.
  // A new compositor has an empty plate, and the canvas keeps nothing once it has been shown.
  state.fresh = host.world.needsFrame() || engine.exporting || filming || state.plate?.renderer !== engine.renderer;
  engine.worldTracing = host.world.traceWanted;
  if (state.fresh) {
    // A render draws at once. The preview waits while a new world's shaders are built, keeping its last picture, and the notice
    // stays until the first frame is really there.
    const atOnce = engine.exporting || filming || typeof window.__videoRender !== 'undefined';
    // Paused, the preview also settles: a few shifted frames averaged, so detail finer than a pixel stops breaking into dots.
    if (host.world.frame({ wait: !atOnce, settle: !atOnce }) === false) state.fresh = false;
    else if (state.load?.stage === 'frame') reportLoad(null);
  }
  // Until this world draws its first frame, the plate still holds another project's picture (or none): it stays out of the frame.
  if (!state.fresh && state.plateGeneration !== state.generation) return false;
  // A rebuilt scene asks for a few frames and the first still shows the old shadows. Final's pump draws the rest; in Draft nothing else would.
  if (!state.final && !state.drawing && !engine.isPlaying && !engine.exporting && host.world.needsFrame()) {
    state.drawing = true;
    requestAnimationFrame(() => { state.drawing = false; if (!engine.isPlaying && !engine.exporting) engine.renderFrame?.(); });
  }
  engine.worldFrameReady = true;
  return true;
}

/** The Scene layer's picture, in the shape a model pass hands back. */
export function worldLayerResult(engine) {
  const { host } = state;
  const { width, height } = host.world;
  const p = ensurePlate(width, height, engine.renderer);
  if (state.fresh) {
    state.fresh = false;
    state.plateGeneration = state.generation;
    const r = engine.renderer;
    p.material.uniforms.uNear.value = engine.camera?.near ?? 1;
    p.material.uniforms.uFar.value = engine.camera?.far ?? 100000;
    p.texture.needsUpdate = true;
    const before = r.getRenderTarget(), autoClear = r.autoClear;
    r.autoClear = true;
    r.setRenderTarget(p.target);
    r.render(p.scene, p.camera);
    if (host.world.hasCatcher) {
      r.setRenderTarget(p.shadowTarget);
      r.render(p.shadowScene, p.camera);
    }
    r.setRenderTarget(before);
    r.autoClear = autoClear;
  }
  const range = host.world.viewRange();
  return {
    texture: p.target.texture, depthTexture: p.target.depthTexture,
    // A catcher's shadow has no surface to stand at, so the stack gets it last, as a plain overlay.
    shadowTexture: host.world.hasCatcher ? p.shadowTarget.texture : null,
    viewDistance: range ? ((range.near + range.far) / 2) / WORLD_UNITS : (engine.videoSize.h * 0.5) / Math.tan((14 * Math.PI) / 180),
    viewRange: range ? { near: range.near / WORLD_UNITS, far: range.far / WORLD_UNITS } : null,
  };
}

/** Whether a model on this frame is drawn by the world, so its own pass stays out of the way. */
export const worldDrawsModels = (engine) => engine.worldFrameReady === true;

// How long a Final stays warm after it is turned off: long enough to flip back and compare, and the tracer then gives its memory back.
const TRACER_REST_MS = 30000;

/** Another project opened in the editor. Its Scene is another world, so the last one must not stay on screen while this one builds. */
export function worldProjectChanged() {
  state.generation += 1;
  // The preview still holds the last world's frame, and nothing else draws until the new scene is built: draw it again without it.
  const e = state.engine;
  if (state.ready && e && !e.isPlaying && !e.exporting) e.renderFrame?.();
}

/** Gives back everything the world holds, its GPU device included. Leaving the editor ends here; the next Scene loads it again. */
export function releaseWorld() {
  if (state.building) { state.releasing = true; return; }
  state.releasing = false;
  clearTimeout(state.tracerRest);
  const { host, plate } = state;
  if (plate) { plate.target.dispose(); plate.shadowTarget.dispose(); plate.texture.dispose(); plate.material.dispose(); plate.shadowMaterial.dispose(); }
  state.plate = null; state.plateGeneration = -1;
  state.meshFiles = null;
  state.key = null; state.lookKey = null; state.liveKey = null; state.poseKey = null; state.builtKey = null;
  state.ready = false; state.final = false; state.engine = null;
  state.host = null; state.loading = null;
  reportLoad(null);
  host?.dispose();
}

/** Draft 3D or Final 3D, from the toggle in the player bar. While Final is on, this keeps asking for frames until it is done. */
export function setWorldFinal(engine, on, options) {
  state.final = !!on;
  const w = state.host?.world;
  // Final on pause is a still: the radiance cache is on unless the options say false
  if (options) { state.traceOptions = options; w?.setTraceOptions({ ...options, radianceCache: options.radianceCache !== false }); }
  clearTimeout(state.tracerRest);
  if (!on) {
    w?.setTrace(false);
    w?.invalidate();
    state.tracerRest = setTimeout(() => { if (!state.final) state.host?.world.releaseTracer(); }, TRACER_REST_MS);
  }
  state.touched = 0;
  if (!engine.isPlaying) engine.renderFrame?.();
  if (state.pumping || !on) return;
  state.pumping = true;
  const pump = () => {
    if (!state.final) { state.pumping = false; return; }
    const world = state.host?.world;
    // A trace waits for hands to stop, and only a repaint can see that they have: a moved camera asks for a few frames, then nothing would.
    if (world && !engine.isPlaying && !engine.exporting && (world.needsFrame() || !world.traceWanted) && !world.gpuBusy) engine.renderFrame?.();
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
}

/** Everything a first frame needs has landed: the bundle, the models, the environment. For a render, which cannot show a late frame. */
export async function worldSettled(engine, timeoutMs = 60000) {
  const t0 = performance.now();
  if (state.loading) await state.loading;
  while (state.building && performance.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 30));
  return !!state.host && state.ready;
}

/** One frame of a render, traced to its samples. Returns true when the caller should repaint to pick up the result. */
export async function settleWorldFrame(engine) {
  const rig = engine.activeRigAt?.(engine.currentTime);
  if (!isWorldRig(rig) || !canRun()) return false;
  const wasReady = engine.worldFrameReady;
  await worldSettled(engine);
  if (!state.host || !state.ready) return false;
  // A render lands on every frame exactly, however far the fluid has to step to get there.
  const volumes = state.host.world.volumes?.length > 0 || state.host.world.matter?.length > 0 || !!state.host.world.rigid || state.host.world.baked?.length > 0;
  if (volumes) await state.host.world.settleVolumes(state.host.world.time);
  // Only a render traces: a thumbnail of the preview must not cost a path trace.
  const rendering = engine.exporting || typeof window.__videoRender !== 'undefined';
  if (rig.render?.mode !== 'final' || !rendering) return !wasReady || volumes;
  const w = state.host.world;
  state.filming = true;
  w.setBatch(true);
  const { mode: _mode, exposure: _exposure, ...trace } = rig.render;
  // The radiance cache, unless render.radianceCache is false: on the owner's desk move, 32 samples with it match 64 without at 2.2 times
  // the speed, with no more flicker (tests/world3d-lab/s4, RESULTS.md S4.25).
  w.setTraceOptions({ ...trace, radianceCache: trace.radianceCache !== false });
  w.setTrace(true);
  const t0 = performance.now();
  for (;;) {
    await w.idle();
    w.frame({ wait: false });
    await new Promise((r) => setTimeout(r, 0));
    if (await w.traceDone()) break;
    if (performance.now() - t0 > 600000) throw new Error('world3d: a frame took over ten minutes');
  }
  w.setBatch(false);
  // the editor's own Final, after a render in this tab, takes its own setting back
  w.trace.radianceCache = state.traceOptions?.radianceCache !== false;
  state.filming = false;
  state.filmedPose = state.poseKey;
  return true;
}

/** What the player bar says, in words. Never on the picture. */
export async function worldStatus() {
  const w = state.host?.world;
  if (!state.final || !w?.traceWanted) return null;
  const done = await w.traceDone();
  return { done, spp: Math.round(w.spp || 0), target: w.trace.spp, seconds: (performance.now() - (w.traceStart || 0)) / 1000 };
}

/** How far along the view the world's surface lies at (x, y) in the frame, in the compositor's pixels. Null over nothing. */
export function worldDepthAt(x, y) {
  if (!state.ready || !state.host) return null;
  const hit = state.host.world.pick(x, y);
  return hit ? hit.distance / WORLD_UNITS : null;
}

export const worldHost = () => state.host;
