import * as THREE from 'three';
import { materials as makeMaterial } from './materialFactory';
import { selectedBackend } from './videoRenderer';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
// Custom-uploaded environments may be .exr; three's own loader handles both formats
// into the same equirectangular float texture the PMREM step expects.
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { cameraProxyFromPose } from './projectCamera';
import { resolveModelUrl, modelScreenTarget, isPrimitiveUrl, PRIMITIVE_DEFAULT_COLOR } from './model3dPresets';
import { buildPrimitiveScene, loadPrimitiveFont } from './model3dPrimitives';
import { setModelFootprint, clearModelFootprint } from './model3dFootprint';
import { applyModelGrowFill, removeModelGrowFill } from './model3dGrowFill';
import { notifyModelAssetLoaded } from './model3dEvents';
import { createModelTonePassMaterial } from './model3dTonePass';
import { glyphGeometry, clearGlyphGeometries } from './text3dGlyphs';
import { makeShadowPlateMaterial } from './model3dShadowPlate';
import {
  normalizeRig, vectorFromSpherical, candelaIntensity, areaLuminance, lightTarget, AREA_SHADOW_SHARE,
  cycSizePx, resolveEnvUrl, cycSurfaceColor, legacyRigLights,
} from './rig3d';
// Importing installs the PCSS shadow lookup (a ShaderChunk edit) — only projects
// that draw 3D ever load this module, so nothing else pays for it.
import { PCSS_INSTALLED, pcssRadiusFor, lightSpread, autoShadowBias } from './rigSoftShadows';
import { fitDirectionalShadow } from './rigShadowFit';
import { createRigContactShadows } from './rigContactShadows';
// The Mockup builder's screen fit maths, shared rather than reimplemented so a screen
// looks identical in both features.
import { createCanvasSurface, drawMediaToCanvas } from '../mockupGenerator/screenTexture';
// Frame-exact video for screens: the same decoder lanes motion templates and layer mattes
// use, settled by the preview pump and by every export/still (motionMediaPending).
import { requestVideoFrame, isSupportedMotionVideo, getMotionVideoSource } from './motionTemplates/motionVideo';

/*
 * 3D model layers — real geometry standing in the editor's world, filmed by the
 * project camera.
 *
 * Everything three-specific about models lives here so Player.jsx gains a call site,
 * not a subsystem. Three rules from MODEL_3D_LAYERS_PLAN.md shape the whole module:
 *
 *   1. A model is filmed through a FORWARD camera derived from the pose
 *      (cameraProxyFromPose), never through the channel rig. The rig's zoom is
 *      `scale(zoom, zoom, 1)` — a lens zoom, exact for flat content but a depth-axis
 *      squash when applied to a solid. The forward camera folds that zoom into an
 *      effective FOV instead, which is the same image for planes and the correct one
 *      for solids.
 *   2. The model renders ALONE into its own depth-buffered target. Every clip material
 *      in the comp is depthTest/depthWrite:false and the accumulation targets carry no
 *      depth attachment — depth order there *is* channel order. A solid needs
 *      self-occlusion, so it gets its own pass.
 *   3. Downstream the result is an ordinary layer texture. Opacity, blend modes,
 *      filters, masks, adjustment layers, glow, DOF and motion blur treat it exactly
 *      as they treat a video frame. Nothing in the composite loop learns what a model
 *      is — the single exception is the view-space distance handed back for DOF, which
 *      a flat identity quad cannot carry.
 *
 * Colour discipline: the model pass renders linear HDR into a half-float target and
 * this module tone-maps it into an LDR texture itself. `renderer.toneMapping` and
 * `renderer.outputColorSpace` are NEVER touched — both are global material-recompile
 * triggers on a renderer shared with the whole compositor, and the comp deliberately
 * runs pass-through (LinearSRGBColorSpace).
 */

// ── Asset cache ─────────────────────────────────────────────────────────────
// url → { status, promise, scene, animations, error }. One parse per asset no matter
// how many layers reference it; each layer clones its own instance below.
const assets = new Map();
let gltfLoader = null;
let objLoader = null;

function getLoaders() {
  if (!gltfLoader) gltfLoader = new GLTFLoader();
  if (!objLoader) objLoader = new OBJLoader();
  return { gltfLoader, objLoader };
}

export function modelExt(url) {
  const m = /\.(glb|gltf|obj)(\?.*)?$/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : null;
}

function loadAsset(url) {
  const hit = assets.get(url);
  if (hit) return hit;
  const ext = modelExt(url);
  const entry = { status: 'loading', promise: null, scene: null, animations: [], error: null };
  assets.set(url, entry);

  // Procedural shapes are built here, synchronously — except Text before its font
  // has arrived, which settles like any other async asset.
  if (isPrimitiveUrl(url)) {
    const built = buildPrimitiveScene(url);
    if (built) {
      entry.status = 'ready';
      entry.scene = built;
      entry.promise = Promise.resolve(entry);
      return entry;
    }
    entry.promise = loadPrimitiveFont().then(() => {
      entry.scene = buildPrimitiveScene(url);
      entry.status = entry.scene ? 'ready' : 'error';
      if (!entry.scene) entry.error = 'Could not build this shape.';
      notifyModelAssetLoaded();
      return entry;
    }, () => {
      entry.status = 'error';
      entry.error = 'Could not load the font for this text.';
      notifyModelAssetLoaded();
      return entry;
    });
    return entry;
  }

  const { gltfLoader: gl, objLoader: ol } = getLoaders();
  entry.promise = new Promise((resolve) => {
    const fail = (err) => {
      entry.status = 'error';
      // A .gltf resolves its .bin/textures RELATIVE to itself; through the media API
      // those siblings are usually absent, which reads as a corrupt file. Say so
      // rather than leaving an empty layer with no explanation.
      entry.error = ext === 'gltf'
        ? 'Could not load this .gltf. It may reference separate .bin/texture files — re-export as a self-contained .glb.'
        : (err?.message || 'Could not load this model.');
      resolve(entry);
      notifyModelAssetLoaded();
    };
    if (ext === 'obj') {
      ol.load(url, (obj) => {
        // OBJ carries no PBR data, so give every mesh a standard material and let the
        // environment light it.
        obj.traverse((n) => {
          if (n.isMesh) n.material = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.55, metalness: 0.05 });
        });
        entry.status = 'ready';
        entry.scene = obj;
        resolve(entry);
        notifyModelAssetLoaded();
      }, undefined, fail);
    } else if (ext === 'glb' || ext === 'gltf') {
      gl.load(url, (gltf) => {
        entry.status = 'ready';
        entry.scene = gltf.scene || gltf.scenes?.[0] || null;
        entry.animations = Array.isArray(gltf.animations) ? gltf.animations : [];
        if (!entry.scene) return fail(new Error('This glTF contains no scene.'));
        resolve(entry);
        notifyModelAssetLoaded();
        return undefined;
      }, undefined, fail);
    } else {
      fail(new Error('Unsupported model format. Use .glb, .gltf or .obj.'));
    }
  });
  return entry;
}

/** Kick off a parse without waiting — used by the render page's warm-up. */
export function preloadModel(url) {
  return url ? loadAsset(url).promise : Promise.resolve(null);
}

/**
 * Wait until every model-related lazy resource that has STARTED loading is
 * settled: parsed assets, environment HDR/PMREM entries, screen artwork.
 * The render page primes one frame (which kicks all of these off through the
 * real pipeline) and then gates on this — otherwise a heavy model fades in
 * texture-by-texture over the first exported frames.
 */
export function modelResourcesPending() {
  // A layer carrying a real-3D effect waits for the effects module (and, on
  // WebGPU, its node twin): exported frames must not render it plain.
  if (fxModulePromise && !fxModule) return true;
  if (fxModule?.modelFxPending()) return true;
  for (const a of assets.values()) if (a.status === 'loading') return true;
  for (const e of envCache.values()) if (e.status === 'loading') return true;
  for (const s of screenImages.values()) if (s && !s.ready && !s.error) return true;
  return false;
}

export async function modelResourcesSettled(timeoutMs = 15000) {
  const started = Date.now();
  while (modelResourcesPending() && Date.now() - started <= timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

/**
 * Warm a screen artwork image. A screen texture only starts loading the first time a
 * frame asks for it, so without this the opening frames of an export render the screen
 * black — the same class of bug as an un-warmed video decoder.
 */
export function preloadScreen(url) {
  if (!url || isVideoUrl(url)) return Promise.resolve(null);
  const entry = screenImage(url);
  if (entry?.ready) return Promise.resolve(entry.image);
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (entry?.ready || Date.now() - started > 10000) resolve(entry?.image || null);
      else setTimeout(tick, 50);
    };
    tick();
  });
}

// ── Environment ─────────────────────────────────────────────────────────────
// PMREM output is keyed by HDR name and shared by every layer using it: the texture is
// read-only and identical, and building one costs a render.
const envCache = new Map();

// After a GPU context loss+restore, three re-uploads image-backed textures
// lazily — but a PMREM environment is BAKED into a render target, so it comes
// back empty while the cache still says 'ready'. The visible symptom: models
// keep rendering (the three directional lights survive) but environment
// intensity/rotation stop having any effect, and renders (a fresh context)
// look different from the preview. The Player calls this on
// 'webglcontextrestored' so every environment re-bakes.
export function handleModelContextRestored() {
  envCache.clear();
  for (const entry of instances.values()) {
    entry.envKey = null;
    if (entry.scene) entry.scene.environment = null;
  }
  // The rig's scene holds a PMREM environment on exactly the same terms, so it has
  // to forget it here too — otherwise preview (restored context) and export (fresh
  // context) light the cyclorama differently and neither looks obviously wrong.
  if (sharedWorld) {
    sharedWorld.envKey = null;
    sharedWorld.scene.environment = null;
  }
  // The contact capture is reused while nothing near the floor moves; its targets
  // came back empty.
  rigInstance?.contacts?.invalidate();
}

/*
 * The PMREM bake belongs to the BACKEND, not to this module's `three` import.
 *
 * `import * as THREE from 'three'` resolves to the WebGL core build — vite has
 * no alias, so the core build and `three/webgpu` are two separate copies of
 * three in one bundle. Core's PMREMGenerator projects the equirect and runs its
 * blur chain with GLSL `ShaderMaterial`s, and WebGPURenderer has no node class
 * for those: it logs `NodeMaterial: Material "ShaderMaterial" is not
 * compatible.` and draws NOTHING. The generator still returns a perfectly valid
 * — and perfectly empty — texture, so the cache goes 'ready' and every model is
 * lit as if it had no environment at all. Measured on the shipped
 * iphone_17_pro_max.glb + potsdamer_platz_1k.hdr, the result is bit-identical to
 * `environment: null` (mean luma 7.7 either way, against 21.4 through the node
 * generator) — which is what "3D models render untextured on WebGPU" was.
 *
 * Every lab under html/webgpu-migration mapped BOTH "three" and "three/webgpu"
 * onto three.webgpu.js, so an app module importing 'three' silently got the node
 * build there and R17 measured a PMREM the app never actually runs. Any other
 * core-three helper that draws with a ShaderMaterial has the same trap.
 */
let nodePmremClass = null;
async function makePmremGenerator(renderer) {
  if (selectedBackend() !== 'webgpu') return new THREE.PMREMGenerator(renderer);
  if (!nodePmremClass) ({ PMREMGenerator: nodePmremClass } = await import('three/webgpu'));
  return new nodePmremClass(renderer);
}

/**
 * PMREM for one environment URL. Keyed by the URL, not by a bare preset name, so an
 * uploaded `/media/...` HDRI and a bundled `/hdr/<preset>.hdr` can never collide —
 * and so the same map requested through two spellings still bakes once.
 *
 * `.exr` goes through EXRLoader, `.hdr` through RGBELoader. Both produce an
 * equirectangular float texture, so the PMREM step below is identical.
 *
 * DESIGN RULE, and it is load-bearing: every environment control must be RENDER-TIME
 * (environmentIntensity, environmentRotation) and never bake-time. The moment a
 * control changes what PMREM produces, this key becomes a content hash and one HDRI
 * fans out into N baked render targets. An env "tint" belongs on a hemisphere light.
 */
export function environmentForUrl(renderer, url) {
  if (!url) return { status: 'none', texture: null, promise: null };
  const hit = envCache.get(url);
  if (hit) return hit;
  const entry = { status: 'loading', texture: null, promise: null };
  envCache.set(url, entry);
  const Loader = /\.exr(\?.*)?$/i.test(url) ? EXRLoader : RGBELoader;
  entry.promise = new Promise((resolve) => {
    new Loader().load(
      url,
      async (hdr) => {
        try {
          const pmrem = await makePmremGenerator(renderer);
          // Core's compile step is sync and returns undefined; the node
          // generator's is async. Awaiting covers both.
          await pmrem.compileEquirectangularShader?.();
          const rt = pmrem.fromEquirectangular(hdr);
          entry.texture = rt.texture;
          entry.status = 'ready';
          hdr.dispose();
          pmrem.dispose();
        } catch (err) {
          // Without this the async callback's rejection would leave the cache
          // entry stuck at 'loading' forever, and every caller polls status.
          entry.status = 'error';
        }
        resolve(entry);
        notifyModelAssetLoaded();
      },
      undefined,
      () => { entry.status = 'error'; resolve(entry); }
    );
  });
  return entry;
}

// Legacy per-model entry point: a bare preset NAME. Kept so model3dConfig.env.hdr
// keeps working untouched for every project that predates the Rig layer.
export function environmentFor(renderer, name) {
  return environmentForUrl(renderer, `/hdr/${name || 'potsdamer_platz_1k'}.hdr`);
}


// ── Fit ─────────────────────────────────────────────────────────────────────
// Model units are arbitrary. Normalise from the bounding box so a freshly dropped
// asset lands at a sane on-screen size, in world units == composition pixels.
export function computeFit(box, config, W, H) {
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const fit = config?.fit || 'height';
  const value = Number.isFinite(config?.fitValue) ? config.fitValue : 60;

  let scale;
  if (fit === 'unit') {
    scale = value;
  } else if (fit === 'width') {
    scale = size.x > 1e-6 ? ((value / 100) * W) / size.x : 1;
  } else {
    scale = size.y > 1e-6 ? ((value / 100) * H) / size.y : 1;
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;

  // Pivot: the bbox centre, the floor of the bbox for objects that sit on a surface,
  // or the asset's own origin — which keeps a GLB exported in scene coordinates
  // (Blender → GLEA) exactly where its scene put it, whatever its rest pose.
  // Offsets are pre-scale (applied to the inner group), so scaling stays uniform.
  const anchor = config?.anchor === 'base' || config?.anchor === 'origin' ? config.anchor : 'center';
  const offset = anchor === 'origin'
    ? new THREE.Vector3(0, 0, 0)
    : new THREE.Vector3(-center.x, anchor === 'base' ? -box.min.y : -center.y, -center.z);
  return { scale, offset, size, center, anchor };
}

// ── Screen artwork ──────────────────────────────────────────────────────────
// Artwork on a device's screen, using the SAME pipeline as the Mockup builder: the
// media is drawn into a canvas shaped like the screen (createCanvasSurface) with a
// cover/contain fit (drawMediaToCanvas), so it is never stretched to the screen's
// aspect. Everything the mockup's screen options expose — scale, offset, rotation,
// padding, fit mode, corner radius — is honoured because it is literally the same
// drawing function.
//
// Video screens are driven by the PLAYHEAD, not by video.play(): the frame must be a
// pure function of time or preview and the deterministic export would disagree.
const screenImages = new Map();

function screenImage(url) {
  if (!url) return null;
  let entry = screenImages.get(url);
  if (entry) return entry;
  entry = { image: null, ready: false };
  screenImages.set(url, entry);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => { entry.image = img; entry.ready = true; notifyModelAssetLoaded(); };
  img.onerror = () => { entry.ready = true; };
  img.src = url;
  return entry;
}

function releaseScreenVideo(entry) {
  const v = entry?.screenVideo;
  if (!v) return;
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* detached */ }
  entry.screenVideo = null;
  entry.screenVideoUrl = null;
}

function ensureScreenVideo(entry, url) {
  if (entry.screenVideoUrl === url) return entry.screenVideo;
  releaseScreenVideo(entry);
  if (!url) return null;
  const v = document.createElement('video');
  v.src = url;
  v.crossOrigin = 'anonymous';
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  entry.screenVideo = v;
  entry.screenVideoUrl = url;
  return v;
}

// A video by its file's extension, or by what a data: URL says it is: the GreenLight Motion page hands the engine its
// files as data: URLs (and blob: URLs with a `#media.<ext>` hint, motionEngine/assets.js), which have no extension.
const isVideoUrl = (url) => {
  const s = String(url || '');
  return /^data:video\//i.test(s) || /\.(mp4|webm|mov|m4v|ogg)(\?.*)?$/i.test(s);
};

/**
 * Paint this layer's screen for the current frame.
 * `time` is clip-local seconds, which is what a video screen seeks to.
 */
// Draw one frame of screen media into its surface. 'stretch' fills the surface (and so
// the mesh's own UV rectangle) exactly — what a GLB authored around a screen texture
// expects; cover/contain keep the media's aspect inside the surface.
function drawScreenMedia(surface, media, opts) {
  if (opts.fitMode === 'stretch') {
    const { ctx, canvas } = surface;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(media, 0, 0, canvas.width, canvas.height);
    return;
  }
  drawMediaToCanvas(surface.ctx, surface.canvas, media, opts);
}

// `entry` is a model instance (its preset device screen) or one of its screen SLOTS
// (model3dConfig.screens) — both carry `root` plus the screen* bookkeeping fields.
function applyScreen(entry, target, screen, time) {
  const url = screen?.url || null;
  const key = target
    ? `${target.node || ''}|${target.material || ''}|${url || ''}|${target.aspect || ''}|${target.planarUv ? 1 : 0}|${target.shading || ''}|${target.mirrorX ? 1 : 0}|${target.rotate || 0}|${target.gltfUv ? (target.flipY ? 'f' : 'g') : ''}`
    : `||${url || ''}`;

  // Structure change (different mesh or different media) — rebuild the material.
  if (entry.screenKey !== key) {
    entry.screenKey = key;
    for (const [mesh, original] of entry.screenOriginals || []) {
      if (mesh.material && mesh.material !== original) mesh.material.dispose?.();
      mesh.material = original;
    }
    // Restore planar-UV aliases (never dispose them — their heavy attribute
    // buffers are the cached asset's shared originals).
    for (const [mesh, geo] of entry.screenGeomOriginals || []) mesh.geometry = geo;
    entry.screenGeomOriginals = null;
    entry.screenOriginals = null;
    entry.screenSurface = null;
    releaseScreenVideo(entry);
    if (!target) return;

    entry.screenOriginals = new Map();
    entry.screenGeomOriginals = new Map();
    const nameOf = (n) => (Array.isArray(n.material) ? n.material[0]?.name : n.material?.name);

    // Some authored display meshes carry unusable UVs (mapping their two halves
    // mirrored into the same texture space, say). `planarUv`
    // rebuilds the UVs as a planar projection over the mesh's two largest
    // axes — an ALIASED geometry that shares every heavy buffer and swaps only
    // the uv attribute, so the cached asset stays untouched.
    const planarUvGeometry = (srcGeo) => {
      const pos = srcGeo.attributes.position;
      const box = new THREE.Box3().setFromBufferAttribute(pos);
      const size = new THREE.Vector3();
      box.getSize(size);
      const axes = ['x', 'y', 'z'].sort((a, b) => size[b] - size[a]);
      // v runs along the LARGER of the two in-plane extents (a display is
      // taller than wide in portrait, wider than tall in landscape — either
      // way the long side is the artwork's vertical only for portrait, so
      // anchor on aspect: u gets the axis closer to the screen's width).
      const [a0, a1] = axes;
      const aspect = target.aspect || 1;
      const wantULarger = aspect >= 1; // landscape screens: u along the long side
      const uAxis = wantULarger ? a0 : a1;
      const vAxis = wantULarger ? a1 : a0;
      const ax = uAxis;
      const ay = vAxis;
      const uv = new Float32Array(pos.count * 2);
      const p = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i);
        uv[i * 2] = (p[ax] - box.min[ax]) / Math.max(size[ax], 1e-9);
        uv[i * 2 + 1] = (p[ay] - box.min[ay]) / Math.max(size[ay], 1e-9);
      }
      const g = new THREE.BufferGeometry();
      for (const [name2, attr] of Object.entries(srcGeo.attributes)) g.setAttribute(name2, attr);
      if (srcGeo.index) g.setIndex(srcGeo.index);
      g.groups = srcGeo.groups;
      g.boundingBox = srcGeo.boundingBox;
      g.boundingSphere = srcGeo.boundingSphere;
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      return g;
    };

    // No artwork chosen: the authored GLBs ship with a wallpaper baked onto the
    // display, which reads as "a screen I never uploaded". Blank it to a plain
    // black panel (the mockup builder's IMacModel does the same) until the user
    // sets artwork.
    if (!url) {
      entry.root.traverse((node) => {
        if (!node.isMesh) return;
        const matName = nameOf(node);
        if ((target.node && node.name === target.node) || (target.material && matName === target.material)) {
          entry.screenOriginals.set(node, node.material);
          node.material = new THREE.MeshBasicMaterial({
            color: 0x000000, toneMapped: false, side: THREE.DoubleSide,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
          });
          node.material.userData.glScreen = true;
          node.material.userData.glDepthBias = SCREEN_DEPTH_BIAS;
        }
      });
      return;
    }

    const surface = createCanvasSurface(target.aspect || 0.47, 1);
    if (!surface) return;
    // Per-device UV fixes, mirrored from the mockup builder's components: these screens
    // are authored with flipped or rotated winding.
    surface.texture.center.set(0.5, 0.5);
    surface.texture.repeat.x = target.mirrorX ? -1 : 1;
    surface.texture.rotation = target.rotate || 0;
    // A custom model's screen uses the mesh's own glTF UVs, whose origin is the
    // image's TOP-left (GLTFLoader loads every texture with flipY off).
    if (target.gltfUv) surface.texture.flipY = !!target.flipY;
    entry.screenSurface = surface;

    entry.root.traverse((node) => {
      if (!node.isMesh) return;
      const matName = nameOf(node);
      if ((target.node && node.name === target.node) || (target.material && matName === target.material)) {
        entry.screenOriginals.set(node, node.material);
        if (target.planarUv) {
          entry.screenGeomOriginals.set(node, node.geometry);
          node.geometry = planarUvGeometry(node.geometry);
        }
        // 'lit' screens take the set's light, shadows and reflections and still glow
        // with their media (a panel, a poster); the default is a self-lit display.
        node.material = target.shading === 'lit'
          ? new THREE.MeshStandardMaterial({
            map: surface.texture, emissiveMap: surface.texture, emissive: 0xffffff, emissiveIntensity: 0.85,
            roughness: 0.38, metalness: 0, side: THREE.DoubleSide,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
          })
          : new THREE.MeshBasicMaterial({
            map: surface.texture, color: 0xffffff, toneMapped: false,
            // Some authored display meshes are wound facing INTO the device —
            // single-sided they back-face cull from the
            // very direction the screen is meant to be seen from.
            side: THREE.DoubleSide,
            // The display is often COPLANAR with the bezel ring / island parts
            // — without a depth bias they z-fight and the
            // artwork "mixes" with chassis pixels at grazing angles.
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
          });
        node.material.userData.glDepthBias = SCREEN_DEPTH_BIAS;
        // A self-lit screen shows display-referred media: its pixels skip the scene's
        // tone curve (renderScreenMask + the tone pass). A 'lit' one is part of the scene.
        if (target.shading !== 'lit') node.material.userData.glScreen = true;
        return;
      }
      // The glass pane in front of the screen is opaque as authored and would hide
      // the artwork entirely — fade it. CLONE the material rather than mutating:
      // these materials are SHARED with the parsed asset (and often with chassis
      // meshes — a front pane can share its material name with the body), so an
      // in-place edit bleeds into other parts and other layers of the same model.
      const glass = target.glass;
      if (glass && ((glass.node && node.name === glass.node) || (glass.material && matName === glass.material))) {
        entry.screenOriginals.set(node, node.material);
        const faded = (Array.isArray(node.material) ? node.material : [node.material]).map((mat) => {
          if (!mat) return mat;
          const clone = mat.clone();
          clone.transparent = true;
          clone.opacity = Number.isFinite(glass.opacity) ? glass.opacity : 0.15;
          return clone;
        });
        node.material = Array.isArray(node.material) ? faded : faded[0];
      }
    });
  }

  const surface = entry.screenSurface;
  if (!surface || !url) return;

  // A preset-level `inset` shrinks the drawn artwork inside the mesh (the iMac's
  // screen mesh is its ENTIRE front panel), and `insetFill` paints the revealed
  // border — the chassis colour — after the draw.
  const inset = Number.isFinite(target.inset) ? target.inset : 0;
  const opts = {
    scale: Number.isFinite(screen.scale) ? screen.scale : 1,
    offsetX: Number.isFinite(screen.offsetX) ? screen.offsetX : 0,
    offsetY: Number.isFinite(screen.offsetY) ? screen.offsetY : 0,
    rotation: Number.isFinite(screen.rotation) ? screen.rotation : 0,
    padding: Math.min(0.45, (Number.isFinite(screen.padding) ? screen.padding : 0) + inset),
    fitMode: screen.fitMode === 'contain' || screen.fitMode === 'stretch' ? screen.fitMode : 'cover',
    borderRadius: Number.isFinite(screen.borderRadius) ? screen.borderRadius : 0,
  };
  const paintInsetRing = () => {
    if (!(inset > 0) || !target.insetFill) return;
    const { ctx, canvas } = surface;
    const px = inset * canvas.width;
    const py = inset * canvas.height;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.rect(px, py, canvas.width - px * 2, canvas.height - py * 2);
    ctx.fillStyle = target.insetFill;
    ctx.fill('evenodd');
    ctx.restore();
  };

  if (isVideoUrl(url)) {
    // Seek by the playhead so the same frame comes out in preview and in export.
    // `offset` shifts the media against the layer clock; videos loop unless told not to.
    const clipT = Math.max(0, (Number(time) || 0) + (Number(screen.offset) || 0));
    const wrap = (dur) => {
      if (!(dur > 0)) return clipT;
      return screen.loop === false ? Math.min(clipT, dur - 1e-3) : Math.min(dur - 1e-3, clipT % dur);
    };
    if (isSupportedMotionVideo(url)) {
      // MP4/MOV: a WebCodecs decoder lane. The request is synchronous and flags the
      // frame as pending until it is decoded; the preview pump and every export /
      // still settle it and repaint (motionMediaPending), so the screen is frame-exact.
      const src = getMotionVideoSource(url);
      const frame = requestVideoFrame(url, wrap(src.loaded ? src.duration : 0), entry.laneKey || `scr:${url}`);
      if (!frame) return;
      drawScreenMedia(surface, frame, opts);
      paintInsetRing();
      surface.texture.needsUpdate = true;
      entry.screenDrawn = null;   // a video redraws every frame
      return;
    }
    // Other containers (WebM): a seeked <video> element — best effort.
    const v = ensureScreenVideo(entry, url);
    if (!v || !v.videoWidth) return;
    const want = wrap(v.duration || 0);
    if (Math.abs(v.currentTime - want) > 0.02 && !v.seeking) v.currentTime = want;
    drawScreenMedia(surface, v, opts);
    paintInsetRing();
    surface.texture.needsUpdate = true;
    entry.screenDrawn = null;   // a video redraws every frame
    return;
  }

  const img = screenImage(url);
  if (!img?.image) return;
  // Still artwork only needs redrawing when its options change.
  const sig = `${url}|${JSON.stringify(opts)}|${inset}`;
  if (entry.screenDrawn === sig) return;
  entry.screenDrawn = sig;
  drawScreenMedia(surface, img.image, opts);
  paintInsetRing();
  surface.texture.needsUpdate = true;
}

// Restore everything a screen (or screen slot) swapped in.
function releaseScreenState(state) {
  if (!state) return;
  for (const [mesh, original] of state.screenOriginals || []) {
    if (mesh.material && mesh.material !== original) mesh.material.dispose?.();
    mesh.material = original;
  }
  for (const [mesh, geo] of state.screenGeomOriginals || []) mesh.geometry = geo;
  state.screenOriginals = null;
  state.screenGeomOriginals = null;
  state.screenSurface?.texture?.dispose?.();
  state.screenSurface = null;
  state.screenKey = null;
  state.screenDrawn = null;
  releaseScreenVideo(state);
}

/**
 * Media on named meshes / materials of ANY model (model3dConfig.screens) — a slab in
 * a Blender scene showing the live UI, a TV, a poster. Each entry is its own slot with
 * its own material swap, surface and decoder lane; slots that disappear from the
 * config restore the authored materials.
 */
function applyModelScreens(entry, screens, time) {
  const list = Array.isArray(screens) ? screens : [];
  if (!list.length && !entry.screenSlots?.length) return;
  const slots = entry.screenSlots || (entry.screenSlots = []);
  for (let i = 0; i < list.length; i += 1) {
    const s = list[i];
    const slot = slots[i] || (slots[i] = { root: entry.root, laneKey: `scr:${entry.itemId}:${i}` });
    slot.root = entry.root;
    const target = {
      node: s.node || null,
      material: s.material || null,
      aspect: Number.isFinite(s.aspect) && s.aspect > 0 ? s.aspect : 16 / 9,
      planarUv: s.uv === 'planar',
      shading: s.shading === 'lit' ? 'lit' : 'screen',
      mirrorX: !!s.mirrorX,
      gltfUv: true,
      flipY: !!s.flipY,
    };
    applyScreen(slot, target, s, time);
  }
  for (let i = list.length; i < slots.length; i += 1) releaseScreenState(slots[i]);
  slots.length = list.length;
}

// The depth bias a screen is drawn with (polygonOffsetFactor), tuned at a 1080-px
// pass. The factor multiplies the surface's depth slope PER WINDOW PIXEL, so the same
// factor pulls a screen further toward the camera the fewer pixels the pass has: the
// Draft preview plays at 0.75 and a page model filmed at a grazing angle came forward
// by several px there — over cards and layers lying 2–3 px above it, which then
// flickered in and out of the page in playback and never did in a full-size render.
// Scaled to the pass height, the bias stays the same size in the scene at every size.
const SCREEN_DEPTH_BIAS = -2;
function scaleScreenDepthBias(entry, passHeight) {
  const k = Math.max(0.1, (Number(passHeight) || 1080) / 1080);
  entry.root?.traverse((node) => {
    if (!node.isMesh) return;
    for (const m of Array.isArray(node.material) ? node.material : [node.material]) {
      if (Number.isFinite(m?.userData?.glDepthBias)) setDepthBiasFactor(m, m.userData.glDepthBias * k);
    }
  });
  setDepthBiasFactor(MASK_SCREEN, SCREEN_DEPTH_BIAS * k);
}
// WebGL reads polygon offset as draw state. WebGPU bakes it into the render pipeline,
// and three keys pipelines on a number only as zero / non-zero — a new factor reused
// the old pipeline — so the factor joins the material's cache key there.
function setDepthBiasFactor(m, factor) {
  if (m.polygonOffsetFactor === factor) return;
  m.polygonOffsetFactor = factor;
  if (selectedBackend() !== 'webgpu') return;
  if (!m.userData.glBiasKeyed) {
    const base = m.customProgramCacheKey.bind(m);
    m.customProgramCacheKey = () => `${base()}|bias:${m.polygonOffsetFactor}`;
    m.userData.glBiasKeyed = true;
  }
  m.needsUpdate = true;
}

// ── Screen coverage mask ────────────────────────────────────────────────────
// Which pixels of this model's pass show a self-lit screen, depth-tested against the
// whole model so whatever stands in front still hides it. The tone pass gives those
// pixels the media's own colour instead of the scene curve (model3dTonePass.js).
const MASK_DEPTH = new THREE.MeshBasicMaterial({ color: 0x000000 });
const MASK_SCREEN = new THREE.MeshBasicMaterial({
  color: 0xffffff, side: THREE.DoubleSide, depthFunc: THREE.LessEqualDepth,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
});

function screenMeshesOf(entry) {
  const out = [];
  entry.root?.traverse((node) => {
    if (node.isMesh && node.visible && node.material?.userData?.glScreen) out.push(node);
  });
  return out;
}

function renderScreenMask(renderer, entry, scene, cam, meshes) {
  const { width, height } = entry.hdr;
  const samples = entry.hdr.samples || 0;
  if (!entry.screenMask || entry.screenMask.width !== width || entry.screenMask.height !== height
      || (entry.screenMask.samples || 0) !== samples) {
    entry.screenMask?.dispose();
    entry.screenMask = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, samples,
    });
  }
  renderer.setRenderTarget(entry.screenMask);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  // Translucent parts (a contact-shadow blob, a faded glass pane) never hide a screen.
  const hidden = [];
  scene.traverse((o) => {
    if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && o.visible && !meshes.includes(o)) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.some((m) => m?.transparent)) { o.visible = false; hidden.push(o); }
    }
  });
  const prevOverride = scene.overrideMaterial;
  // 1) the model's depth, 2) the screens alone, white, against that depth
  scene.overrideMaterial = MASK_DEPTH;
  renderer.render(scene, cam);
  scene.overrideMaterial = null;
  scene.traverse((o) => {
    if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && o.visible && !meshes.includes(o)) { o.visible = false; hidden.push(o); }
  });
  const originals = meshes.map((m) => m.material);
  for (const m of meshes) m.material = MASK_SCREEN;
  renderer.render(scene, cam);
  meshes.forEach((m, i) => { m.material = originals[i]; });
  for (const o of hidden) o.visible = true;
  scene.overrideMaterial = prevOverride;
  return entry.screenMask.texture;
}

// ── Per-layer instances ─────────────────────────────────────────────────────
// item.id → its own clone, mixer, scene and lights. Cloned (never shared) so two
// layers using the same asset can hold different poses and animation times.
const instances = new Map();
// Ordinary image/video/text/shape layers promoted to real 3D geometry. Kept apart
// from model instances because these own their geometry and baked artwork texture.
const plateInstances = new Map();

// ── Lights ──────────────────────────────────────────────────────────────────
//
// A rig definition (rig3d.js) instantiated per pass. A light at a known position
// shades a surface identically regardless of what else is in its scene, so this
// gives genuinely unified lighting WITHOUT merging every model into one scene —
// only shadow maps need shared geometry, and those come with Phase 3.
//
// The legacy `model3dConfig.lights = { key, fill, rim }` block is accepted by
// normalizeRig, which reproduces the three historical directions exactly. That is
// the whole backward-compatibility story: nothing else in this module knows the old
// shape any more.
//
// THE RULE THAT MUST NOT BE "OPTIMISED" LATER: a light that is switched off keeps
// its object and gets intensity 0. NUM_DIR_LIGHTS and friends are shader #defines,
// so changing the light COUNT recompiles every material in the scene — on a
// 200-material asset that is a visible stall. Never implement on/off as
// add/remove, and don't pre-allocate a fixed 8 either: unused lights cost shading
// time on every fragment forever.

const D2R_LIGHT = Math.PI / 180;

// Area lights shade through linearly transformed cosines, which need two lookup
// tables per backend: WebGL reads them as UniformsLib entries, WebGPU from
// RectAreaLightNode. Without them a RectAreaLight draws nothing (or throws in a node
// build), so until the tables exist an area light stands in as a directional.
const areaLtc = { webgl: false, webgpu: null };
function areaLightsReady() {
  if (selectedBackend() !== 'webgpu') {
    if (!areaLtc.webgl) {
      RectAreaLightUniformsLib.init();
      areaLtc.webgl = true;
    }
    return true;
  }
  if (areaLtc.webgpu === true) return true;
  if (areaLtc.webgpu === null) {
    areaLtc.webgpu = Promise.all([
      import('three/webgpu'),
      import('three/examples/jsm/lights/RectAreaLightTexturesLib.js'),
    ]).then(([{ RectAreaLightNode }, { RectAreaLightTexturesLib }]) => {
      RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
      areaLtc.webgpu = true;
    }).catch((error) => {
      console.warn('[model3d] area light tables failed to load; area lights stay directional', error);
      areaLtc.webgpu = false;
    });
  }
  return false;
}

function makeLightObject(type) {
  switch (type) {
    case 'point': return new THREE.PointLight(0xffffff, 1);
    case 'spot': return new THREE.SpotLight(0xffffff, 1);
    case 'area': {
      if (areaLightsReady()) return new THREE.RectAreaLight(0xffffff, 1, 1, 1);
      const standIn = new THREE.DirectionalLight(0xffffff, 1);
      standIn.userData.areaStandIn = true;
      return standIn;
    }
    case 'ambient': return new THREE.AmbientLight(0xffffff, 1);
    case 'hemisphere': return new THREE.HemisphereLight(0xffffff, 0x3a2f26, 1);
    default: return new THREE.DirectionalLight(0xffffff, 1);
  }
}

/**
 * An area light: the lit rectangle itself (RectAreaLight — broad, soft highlights,
 * no shadow) plus, when it casts, a companion directional from the same place that
 * carries AREA_SHADOW_SHARE of the light and the shadow map.
 */
function applyAreaLight(obj, light, level, companion) {
  const p = vectorFromSpherical(light.az, light.elev, light.dist);
  const t = lightTarget(light);
  const d = Math.max(1, Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z));
  const share = companion ? AREA_SHADOW_SHARE : 0;
  obj.position.set(p.x, p.y, p.z);
  if (obj.isRectAreaLight) {
    obj.width = light.width;
    obj.height = light.height;
    // Lights look down -Z, so this faces the lit side at the target.
    obj.lookAt(t.x, t.y, t.z);
    obj.intensity = areaLuminance(level * (1 - share), d, light.width, light.height);
  } else {
    obj.target.position.set(t.x, t.y, t.z);
    obj.target.updateMatrixWorld();
    obj.intensity = level * (1 - share);
  }
  if (companion) {
    companion.color.set(light.color);
    companion.position.set(p.x, p.y, p.z);
    companion.target.position.set(t.x, t.y, t.z);
    companion.target.updateMatrixWorld();
    companion.intensity = level * share;
  }
}

function applyLight(obj, light, companion = null) {
  obj.color.set(light.color);
  // `on` is presentation only — see the rule above.
  const level = light.on === false ? 0 : light.intensity;
  if (light.type === 'area') {
    applyAreaLight(obj, light, level, companion);
    return;
  }
  if (light.type === 'ambient') {
    obj.intensity = level;
    return;
  }
  if (light.type === 'hemisphere') {
    obj.groundColor.set(light.groundColor);
    obj.intensity = level;
    return;
  }
  const p = vectorFromSpherical(light.az, light.elev, light.dist);
  obj.position.set(p.x, p.y, p.z);
  // A directional light's position is only a DIRECTION (it aims at the origin), so
  // its distance changes nothing about the shading — which is exactly why the
  // legacy three-light look survives being restated in spherical terms.
  //
  // Point and spot are different: three r155+ treats their intensity as candela
  // with 1/d² falloff, and one world unit here is one composition pixel. At 3000 px
  // an un-normalised intensity of 1 delivers ~10⁻⁷ of what the user expects.
  obj.intensity = (light.type === 'point' || light.type === 'spot')
    ? candelaIntensity(level, light.dist, light.type === 'point' ? light.decay : 2)
    : level;
  if (light.type === 'point') {
    obj.distance = light.range || 0;
    obj.decay = light.decay;
  }
  if (light.type === 'spot') {
    obj.angle = light.angle * D2R_LIGHT;
    obj.penumbra = light.penumbra;
    obj.target.position.set(light.targetX, light.targetY, light.targetZ);
    obj.target.updateMatrixWorld();
  }
}

/** A live light set attached to one scene, keyed by rig `lid`. */
function makeLightRig(scene) {
  return { scene, byLid: new Map() };
}

/**
 * Bring a scene's lights in line with a rig definition. Objects are created and
 * disposed ONLY when a `lid` appears/disappears or changes `type`; everything else
 * is written in place, so the steady state costs a handful of number assignments
 * per frame and never touches the shader program cache.
 */
function addLightObject(scene, obj) {
  // A light must be visible to EVERY pass camera, and to the shadow map. three
  // collects a light only when light.layers.test(camera.layers) — so with the
  // shared world's per-object private layers, a light left on layer 0 would be
  // dropped from every pass and the whole set would go black.
  obj.layers.enableAll();
  if (obj.target) obj.target.layers.enableAll();
  scene.add(obj);
  if (obj.target) scene.add(obj.target);
  return obj;
}

function removeLightObject(scene, obj) {
  if (!obj) return;
  scene?.remove(obj);
  if (obj.target) scene?.remove(obj.target);
  obj.dispose?.();
}

function releaseHeldLight(scene, held) {
  removeLightObject(scene, held.obj);
  removeLightObject(scene, held.shadowObj);
  held.shadowObj = null;
}

function syncLightsToScene(rigLights, lights) {
  const { scene, byLid } = rigLights;
  const seen = new Set();
  for (const light of lights) {
    seen.add(light.lid);
    let held = byLid.get(light.lid);
    // An area light that started as a directional stand-in (its lookup tables were
    // still loading) becomes the real thing as soon as they are there.
    const upgrade = held && held.type === 'area' && held.obj.userData.areaStandIn && areaLightsReady();
    if (held && (held.type !== light.type || upgrade)) {
      releaseHeldLight(scene, held);
      held = null;
    }
    if (!held) {
      held = { type: light.type, obj: addLightObject(scene, makeLightObject(light.type)), shadowObj: null };
      byLid.set(light.lid, held);
    }
    // A casting area light's shadow lives on a companion directional. Created and
    // removed only with castShadow, which is not animatable — the count changes when
    // the user flips that switch, never per frame.
    const wantCompanion = light.type === 'area' && light.castShadow === true;
    if (wantCompanion && !held.shadowObj) {
      held.shadowObj = addLightObject(scene, new THREE.DirectionalLight(0xffffff, 0));
    } else if (!wantCompanion && held.shadowObj) {
      removeLightObject(scene, held.shadowObj);
      held.shadowObj = null;
    }
    // Remembered so the shadow setup can read castShadow / angle / shadowMapSize
    // without re-deriving them from the scene objects.
    held.light = light;
    applyLight(held.obj, light, held.shadowObj);
  }
  for (const [lid, held] of [...byLid]) {
    if (seen.has(lid)) continue;
    releaseHeldLight(scene, held);
    byLid.delete(lid);
  }
}

function disposeLightRig(rigLights) {
  if (!rigLights) return;
  for (const held of rigLights.byLid.values()) releaseHeldLight(rigLights.scene, held);
  rigLights.byLid.clear();
}

// ── Cyclorama ───────────────────────────────────────────────────────────────
//
// The backdrop the set stands on: a floor, a curved sweep and a back wall built as
// ONE geometry so there is no seam to catch a highlight. Cached on a signature of
// shape + size, because rebuilding a lathe every frame is the easiest way to make
// the rig unusable — the same reason its dimensions are not keyframable.

// Each shape is a REAL solid, not a variation on one plate. The first version of
// this builder extruded a single YZ profile along X, which gave three distinct
// geometries for nine shape names — `corner`, `room`, `cylinder` and `dome` all
// silently rendered as the plain swept cyclorama, and `disc` as a rectangle. The
// shape selector looked like it did nothing, because for five of its nine entries
// it did nothing.
//
// The 3D pass scene is Y-UP — established by rendering a mesh at a known height and
// seeing which end of the frame it lands on, not by reading the 2D layer code, whose
// `py` runs the other way. Every builder here is therefore plain y-up with no flip.

const CYC_ARC_SEG = 16;      // quarter-round fillet subdivisions
const CYC_RADIAL_SEG = 48;   // cylinder / dome / disc

// One mesh's worth of raw arrays, so the shapes below can compose without needing
// three's BufferGeometryUtils (an extra example-module import for a merge we can do
// in a dozen lines).
function cycMeshData() {
  return { pos: [], nrm: [], idx: [] };
}

function cycVert(md, x, y, z, nx, ny, nz) {
  md.pos.push(x, y, z);
  md.nrm.push(nx, ny, nz);
  return md.pos.length / 3 - 1;
}

function cycQuad(md, a, b, c, d) {
  md.idx.push(a, b, c, a, c, d);
}

/**
 * A triangle fan from `centre` around `ring`, wound to face UP — the same way
 * cycRect(up=1) is wound.
 *
 * This exists because hand-winding fans is exactly where the disc went wrong: it was
 * pushed in the opposite order to the quads, so after the single mirror-correction at
 * the end of the builder it faced DOWN and back-face culling dropped it entirely.
 * A flat disc renders as nothing at all in that state, with no error anywhere.
 */
function cycFanUp(md, centre, ring) {
  for (let i = 0; i < ring.length - 1; i += 1) md.idx.push(centre, ring[i], ring[i + 1]);
}

/** A flat rectangle at height `y`, spanning x and z, facing `up` (+1) or down. */
function cycRect(md, y, x0, x1, z0, z1, up = 1) {
  const a = cycVert(md, x0, y, z0, 0, up, 0);
  const b = cycVert(md, x1, y, z0, 0, up, 0);
  const c = cycVert(md, x1, y, z1, 0, up, 0);
  const d = cycVert(md, x0, y, z1, 0, up, 0);
  if (up > 0) cycQuad(md, a, d, c, b); else cycQuad(md, a, b, c, d);
}

/** A vertical wall in the XY plane at depth `z`, facing `nz`. */
function cycWallXY(md, z, x0, x1, y0, y1, nz) {
  const a = cycVert(md, x0, y0, z, 0, 0, nz);
  const b = cycVert(md, x1, y0, z, 0, 0, nz);
  const c = cycVert(md, x1, y1, z, 0, 0, nz);
  const d = cycVert(md, x0, y1, z, 0, 0, nz);
  if (nz > 0) cycQuad(md, a, b, c, d); else cycQuad(md, a, d, c, b);
}

/** A vertical wall in the ZY plane at `x`, facing `nx`. */
function cycWallZY(md, x, z0, z1, y0, y1, nx) {
  const a = cycVert(md, x, y0, z0, nx, 0, 0);
  const b = cycVert(md, x, y0, z1, nx, 0, 0);
  const c = cycVert(md, x, y1, z1, nx, 0, 0);
  const d = cycVert(md, x, y1, z0, nx, 0, 0);
  if (nx > 0) cycQuad(md, a, d, c, b); else cycQuad(md, a, b, c, d);
}

/**
 * The cyclorama sweep itself: a floor running back to `zBack`, a quarter-round
 * fillet of radius r, then a wall rising to `h`. Extruded along x from x0 to x1.
 * This is the shape the whole feature is named after — no seam for a highlight to
 * catch, which is exactly why it is one continuous strip and not three planes.
 */
function cycSweep(md, x0, x1, zFront, zBack, h, r) {
  const prof = [];
  prof.push({ y: 0, z: zFront, ny: 1, nz: 0 });
  prof.push({ y: 0, z: zBack + r, ny: 1, nz: 0 });
  for (let i = 1; i <= CYC_ARC_SEG; i += 1) {
    const a = (i / CYC_ARC_SEG) * (Math.PI / 2);
    prof.push({
      y: r - Math.cos(a) * r,
      z: zBack + r - Math.sin(a) * r,
      ny: Math.cos(a),
      nz: Math.sin(a),
    });
  }
  prof.push({ y: Math.max(h, r), z: zBack, ny: 0, nz: 1 });

  const ring = prof.map((p) => [
    cycVert(md, x0, p.y, p.z, 0, p.ny, p.nz),
    cycVert(md, x1, p.y, p.z, 0, p.ny, p.nz),
  ]);
  for (let i = 0; i < ring.length - 1; i += 1) {
    cycQuad(md, ring[i][0], ring[i][1], ring[i + 1][1], ring[i + 1][0]);
  }
}

/** A lathe around the Y axis: floor disc plus an upright wall, open at the top. */
function cycCylinder(md, radius, h, closedTop = false) {
  const centre = cycVert(md, 0, 0, 0, 0, 1, 0);
  const floorRing = [];
  const lowRing = [];
  const highRing = [];
  for (let i = 0; i <= CYC_RADIAL_SEG; i += 1) {
    const a = (i / CYC_RADIAL_SEG) * Math.PI * 2;
    const sx = Math.sin(a);
    const cz = Math.cos(a);
    const x = sx * radius;
    const z = cz * radius;
    floorRing.push(cycVert(md, x, 0, z, 0, 1, 0));
    // Wall normals point INWARD: you stand inside a cyclorama, not outside it.
    lowRing.push(cycVert(md, x, 0, z, -sx, 0, -cz));
    highRing.push(cycVert(md, x, h, z, -sx, 0, -cz));
  }
  cycFanUp(md, centre, floorRing);
  for (let i = 0; i < CYC_RADIAL_SEG; i += 1) {
    cycQuad(md, lowRing[i], lowRing[i + 1], highRing[i + 1], highRing[i]);
  }
  if (closedTop) cycRect(md, h, -radius, radius, -radius, radius, -1);
}

/** An inward-facing hemisphere sitting on the ground plane. */
function cycDome(md, radius, h) {
  const RINGS = 12;
  const grid = [];
  for (let j = 0; j <= RINGS; j += 1) {
    const phi = (j / RINGS) * (Math.PI / 2);      // 0 = horizon, PI/2 = zenith
    const row = [];
    for (let i = 0; i <= CYC_RADIAL_SEG; i += 1) {
      const th = (i / CYC_RADIAL_SEG) * Math.PI * 2;
      const cx = Math.sin(th) * Math.cos(phi);
      const cy = Math.sin(phi);
      const cz = Math.cos(th) * Math.cos(phi);
      // Squashed to `h` so the dome honours the height field instead of being a
      // perfect hemisphere that ignores it.
      row.push(cycVert(md, cx * radius, cy * h, cz * radius, -cx, -cy, -cz));
    }
    grid.push(row);
  }
  for (let j = 0; j < RINGS; j += 1) {
    for (let i = 0; i < CYC_RADIAL_SEG; i += 1) {
      cycQuad(md, grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]);
    }
  }
  // Floor, so a dome is a room and not a lampshade.
  const centre = cycVert(md, 0, 0, 0, 0, 1, 0);
  const ring = [];
  for (let i = 0; i <= CYC_RADIAL_SEG; i += 1) {
    const th = (i / CYC_RADIAL_SEG) * Math.PI * 2;
    ring.push(cycVert(md, Math.sin(th) * radius, 0, Math.cos(th) * radius, 0, 1, 0));
  }
  cycFanUp(md, centre, ring);
}

/**
 * Make every triangle wind to agree with the normals its own vertices declare.
 *
 * The DECLARED NORMAL IS THE SOURCE OF TRUTH — each builder says which way a surface
 * faces, and this reconciles the index order to match. Hand-winding was where this
 * code went wrong three separate times (the disc faced down and vanished; the
 * cylinder and dome wound outward while declaring inward normals, so the camera
 * standing inside them saw culled back faces). The failure is always silent: a
 * back-facing surface renders as nothing at all, which reads as "the shape selector
 * does nothing" rather than as an error.
 *
 * Runs once per geometry rebuild, behind the shape+size cache, so it costs nothing
 * per frame.
 */
function cycFixWinding(md) {
  const { pos, nrm, idx } = md;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    // Geometric face normal, against the average of the three declared ones.
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    const dx = nrm[a] + nrm[b] + nrm[c];
    const dy = nrm[a + 1] + nrm[b + 1] + nrm[c + 1];
    const dz = nrm[a + 2] + nrm[b + 2] + nrm[c + 2];
    if (fx * dx + fy * dy + fz * dz < 0) {
      const swap = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = swap;
    }
  }
}

function buildCycGeometry(shape, w, h, d, curve) {
  const hw = w / 2;
  const hd = d / 2;
  const r = Math.max(1, Math.min(h, d) * Math.max(0.01, curve));
  const md = cycMeshData();

  switch (shape) {
    case 'floor':
      cycRect(md, 0, -hw, hw, -hd, hd, 1);
      break;

    case 'disc': {
      // A real circle, not a square. The radius follows the SHORTER of width/depth
      // so a disc always fits inside the footprint the numbers describe.
      const radius = Math.min(hw, hd);
      const centre = cycVert(md, 0, 0, 0, 0, 1, 0);
      const ring = [];
      for (let i = 0; i <= CYC_RADIAL_SEG; i += 1) {
        const a = (i / CYC_RADIAL_SEG) * Math.PI * 2;
        ring.push(cycVert(md, Math.sin(a) * radius, 0, Math.cos(a) * radius, 0, 1, 0));
      }
      cycFanUp(md, centre, ring);
      break;
    }

    case 'wall':
      cycWallXY(md, -hd, -hw, hw, 0, h, 1);
      break;

    case 'corner':
      // Floor, back wall and ONE side wall, both joined to the floor by a fillet —
      // the L-shaped infinity corner, which is a different set from a plain cyc.
      cycSweep(md, -hw, hw, hd, -hd, h, r);
      cycWallZY(md, -hw, -hd, hd, 0, h, 1);
      break;

    case 'room':
      // An inward-facing box: floor, four walls, no ceiling (a ceiling would cut the
      // camera off the moment it tilts up).
      cycRect(md, 0, -hw, hw, -hd, hd, 1);
      cycWallXY(md, -hd, -hw, hw, 0, h, 1);
      cycWallXY(md, hd, -hw, hw, 0, h, -1);
      cycWallZY(md, -hw, -hd, hd, 0, h, 1);
      cycWallZY(md, hw, -hd, hd, 0, h, -1);
      break;

    case 'cylinder':
      cycCylinder(md, Math.min(hw, hd), h);
      break;

    case 'dome':
      cycDome(md, Math.min(hw, hd), h);
      break;

    case 'cyc':
    default:
      cycSweep(md, -hw, hw, hd, -hd, h, r);
      break;
  }

  cycFixWinding(md);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(md.pos, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(md.nrm, 3));
  geom.setIndex(md.idx);
  geom.computeBoundingSphere();
  return geom;
}

function syncCyclorama(holder, cyc, compH) {
  const shape = cyc?.shape || 'none';
  if (shape === 'none') {
    if (holder.mesh) holder.mesh.visible = false;
    return;
  }
  const { width, height, depth } = cycSizePx(cyc, compH);
  const sig = `${shape}|${width.toFixed(1)}|${height.toFixed(1)}|${depth.toFixed(1)}|${cyc.curve}`;
  if (!holder.mesh || holder.sig !== sig) {
    holder.mesh?.geometry?.dispose();
    const geom = buildCycGeometry(shape, width, height, depth, cyc.curve);
    if (!holder.mesh) {
      // FrontSide, not DoubleSide: every shape above is wound so its lit face points
      // at the subject, and back-face culling is what lets the camera sit outside a
      // room or behind a wall without the set closing over the shot. DoubleSide also
      // made the closed shapes self-shadow from their own far side.
      holder.mat = new THREE.MeshStandardMaterial({ side: THREE.FrontSide });
      holder.mesh = new THREE.Mesh(geom, holder.mat);
      holder.scene.add(holder.mesh);
    } else {
      holder.mesh.geometry = geom;
    }
    holder.sig = sig;
  }
  const m = cyc.material || {};
  const matMode = m.mode === 'shadowCatcher' ? 'shadowCatcher' : 'solid';
  if (holder.matMode !== matMode) {
    holder.mat?.dispose();
    holder.mat = matMode === 'shadowCatcher'
      ? new THREE.ShadowMaterial({ transparent: true })
      : new THREE.MeshStandardMaterial({ side: THREE.FrontSide });
    holder.mesh.material = holder.mat;
    holder.matMode = matMode;
  }
  holder.mesh.visible = true;
  // "Shadows only" has its own tint (black until set), never the Solid colour.
  holder.mat.color.set(cycSurfaceColor(m));
  if (holder.mat.isMeshStandardMaterial) {
    holder.mat.roughness = Number.isFinite(m.roughness) ? m.roughness : 0.8;
    holder.mat.metalness = Number.isFinite(m.metalness) ? m.metalness : 0;
  }
  holder.mat.opacity = Number.isFinite(m.opacity) ? m.opacity : (matMode === 'shadowCatcher' ? 0.55 : 1);
  holder.mat.transparent = matMode === 'shadowCatcher' || holder.mat.opacity < 1;
  const D2R_C = Math.PI / 180;
  // WHERE THE SET'S FLOOR SITS, and it needs stating because "0" alone is ambiguous.
  // The rig origin is the SUBJECT's position — the middle of the frame — so a floor
  // built at y = 0 sits at the camera's own eye level: edge-on, and therefore
  // invisible. `Floor` and `Disc` rendered as literally nothing for exactly that
  // reason. The set's floor is defined as 0.42 of a composition height BELOW the
  // subject, which puts the ground just under it rather than off the bottom edge, and
  // `cyc.y` moves it from there. Every shape shares this, so changing shape never
  // also moves the ground.
  const floorY = -compH * 0.42;
  holder.mesh.position.set(cyc.x || 0, floorY + (cyc.y || 0), cyc.z || 0);
  holder.mesh.rotation.set((cyc.rotX || 0) * D2R_C, (cyc.rotY || 0) * D2R_C, (cyc.rotZ || 0) * D2R_C);
  holder.mesh.scale.setScalar(cyc.scale || 1);
}

// Until a Rig layer exists (plan phase 2) the rig comes from the layer's own
// model3dConfig. normalizeRig accepts the legacy `{ key, fill, rim }` intensities
// and yields the identical three directionals.
function rigLightsForConfig(config) {
  return normalizeRig({ lights: config?.lights }).lights;
}

/**
 * The live instance for one model item, creating it once the asset has parsed.
 * Returns { ready, error, entry } — never throws, so a missing asset degrades to an
 * empty layer plus a message rather than taking the frame down.
 */
export function ensureModelInstance(item, clip) {
  // A preset layer loads the bundled device; a custom one loads the uploaded asset.
  const url = resolveModelUrl(item, clip);
  let entry = instances.get(item.id);
  if (!url) {
    // A source can become empty while the picker is open. Retire the previous
    // instance immediately; otherwise it remains in the shared world casting
    // shadows even though the compositor correctly shows no model plate.
    if (entry) disposeModelLayer(item.id);
    return { ready: false, error: 'This model layer has no asset.', entry: null };
  }
  if (entry && entry.url !== url) {
    // Retire the previous asset BEFORE the replacement finishes loading. Keeping it
    // until `ready` made model switching appear to do nothing on large presets.
    disposeInstance(entry);
    instances.delete(item.id);
    clearModelFootprint(item.id);
    entry = null;
  }
  const asset = loadAsset(url);
  if (asset.status === 'error') return { ready: false, error: asset.error, entry: null };
  if (asset.status !== 'ready') return { ready: false, error: null, entry: null };
  if (!entry) {
    const root = cloneSkinned(asset.scene);
    // Two nested groups: the inner one carries fit offset + scale (so the pivot maths
    // stays independent of the layer transform), the outer is what Player poses.
    const inner = new THREE.Group();
    inner.add(root);
    const outer = new THREE.Group();
    outer.add(inner);

    const scene = new THREE.Scene();
    scene.add(outer);
    // Lights are not created here: renderModelLayer syncs them from the rig every
    // frame (syncLightsToScene), so there is exactly one place that decides what
    // this scene is lit by.
    const lightRig = makeLightRig(scene);

    // A shape's colour is per layer: the shared asset's tintable materials are
    // cloned for this instance (geometry stays shared, like any cloned asset).
    const tintMaterials = [];
    if (isPrimitiveUrl(url)) {
      root.traverse((n) => {
        if (!n.isMesh || !n.material?.userData?.tint) return;
        n.material = n.material.clone();
        n.material.userData.tint = true;
        tintMaterials.push(n.material);
      });
    }

    const box = new THREE.Box3().setFromObject(root);
    entry = {
      tintMaterials,
      itemId: item.id,
      url,
      scene,
      root,
      inner,
      outer,
      lightRig,
      box,
      mixer: asset.animations.length ? new THREE.AnimationMixer(root) : null,
      animations: asset.animations,
      actions: new Map(),
      envKey: null,
    };
    instances.set(item.id, entry);
  }
  return { ready: true, error: null, entry };
}

/** Names of the glTF animation clips this layer's asset carries. */
export function modelAnimationNames(clip, item = null) {
  const url = item ? resolveModelUrl(item, clip) : clip?.url;
  const asset = url ? assets.get(url) : null;
  return asset?.status === 'ready' ? asset.animations.map((a) => a.name) : [];
}

// ── Contact shadow ──────────────────────────────────────────────────────────
// A soft blob under the model, sized to its footprint. Cheap, stable under a moving
// camera, and — crucially — entirely local to this pass: no shadow map, so the shared
// renderer's global shadow state is never touched.
let shadowTexture = null;

function contactShadowTexture() {
  if (shadowTexture) return shadowTexture;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  shadowTexture = new THREE.CanvasTexture(c);
  return shadowTexture;
}

function applyContactShadow(entry, shadow) {
  const on = shadow?.enabled === true;
  if (!on) {
    if (entry.shadowMesh) entry.shadowMesh.visible = false;
    return;
  }
  if (!entry.shadowMesh) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: contactShadowTexture(),
        transparent: true,
        // It MUST write depth: the compositor merges a model pass by that pass's
        // own depth and drops every pixel left at the far plane, so a shadow with
        // no depth never reached the preview or an export. Its clear area cannot
        // block anything — the merge also drops pixels under 2% alpha.
        depthWrite: true,
        toneMapped: false,
        color: 0x000000,
      })
    );
    mesh.rotation.x = -Math.PI / 2;
    entry.shadowMesh = mesh;
    // Under the model but inside the fit/anchor group, so it scales with the object.
    entry.inner.add(mesh);
  }
  const box = entry.box;
  const sizeV = new THREE.Vector3();
  box.getSize(sizeV);
  const centerV = new THREE.Vector3();
  box.getCenter(centerV);
  // `blur` widens the patch rather than blurring pixels — the gradient is already soft.
  const spread = 1.35 + (Number.isFinite(shadow.blur) ? shadow.blur : 1) * 0.45;
  entry.shadowMesh.visible = true;
  entry.shadowMesh.scale.set(Math.max(sizeV.x, 1e-3) * spread, Math.max(sizeV.z, sizeV.x * 0.05, 1e-3) * spread, 1);
  entry.shadowMesh.position.set(centerV.x, box.min.y + 0.001, centerV.z);
  entry.shadowMesh.material.opacity = Number.isFinite(shadow.opacity) ? shadow.opacity : 0.35;
  // Created after joinWorld tagged the subtree, so it would sit on layer 0 only and
  // the private-layer pass camera of a rig world would never draw it.
  entry.shadowMesh.layers.mask = entry.inner.layers.mask;
}

// ── Ground occlusion on the model itself (WebGL) ────────────────────────────
// Light reaching a model's last few centimetres above the floor is mostly blocked
// by the floor. Without this, a rounded bottom edge catches the bright floor and the
// object reads as hovering. One shared uniform set: the floor is a property of the
// rig, the same for every model. WebGPU never calls onBeforeCompile, so there the
// material renders as its plain base — exactly as before this existed.
const GROUND_AO = {
  uGroundAoY: { value: 0 },
  uGroundAoFade: { value: 1 },
  uGroundAoOn: { value: 0 },
};
const GROUND_AO_LIT = new Set(['MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshLambertMaterial', 'MeshPhongMaterial']);
function groundAoCompile(shader) {
  shader.uniforms.uGroundAoY = GROUND_AO.uGroundAoY;
  shader.uniforms.uGroundAoFade = GROUND_AO.uGroundAoFade;
  shader.uniforms.uGroundAoOn = GROUND_AO.uGroundAoOn;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vGroundAoY;')
    .replace('#include <project_vertex>', '#include <project_vertex>\n\tvGroundAoY = ( modelMatrix * vec4( transformed, 1.0 ) ).y;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vGroundAoY;\nuniform float uGroundAoY;\nuniform float uGroundAoFade;\nuniform float uGroundAoOn;')
    .replace('#include <aomap_fragment>', `#include <aomap_fragment>
	float gaoH = max( vGroundAoY - uGroundAoY, 0.0 ) / max( uGroundAoFade, 1e-3 );
	float gaoInd = mix( 1.0, mix( 0.3, 1.0, smoothstep( 0.0, 1.0, gaoH ) ), uGroundAoOn );
	float gaoDir = mix( 1.0, mix( 0.6, 1.0, smoothstep( 0.0, 0.47, gaoH ) ), uGroundAoOn );
	reflectedLight.indirectDiffuse *= gaoInd;
	reflectedLight.indirectSpecular *= gaoInd;
	reflectedLight.directDiffuse *= gaoDir;
	reflectedLight.directSpecular *= gaoDir;`);
}
function applyGroundAO(root) {
  root.traverse((n) => {
    if (!n.isMesh) return;
    for (const mat of [].concat(n.material || [])) {
      if (!mat || mat.userData?.__groundAO || !GROUND_AO_LIT.has(mat.type)) continue;
      // Never stack on another injection (Grow Fill swaps in its own clones).
      if (Object.prototype.hasOwnProperty.call(mat, 'onBeforeCompile')) continue;
      mat.onBeforeCompile = groundAoCompile;
      if (!Object.prototype.hasOwnProperty.call(mat, 'customProgramCacheKey')) mat.customProgramCacheKey = () => 'ground-ao-v1';
      mat.userData.__groundAO = true;
      mat.needsUpdate = true;
    }
  });
}

// ── Render targets ──────────────────────────────────────────────────────────
// Two per model layer: a half-float HDR target WITH depth (so the model occludes
// itself — the whole reason it renders alone), and an LDR target holding the
// tone-mapped result the compositor consumes as an ordinary layer texture.
function ensureTargets(entry, width, height) {
  const wantSamples = selectedBackend() === 'webgpu' ? 0 : 4;
  if (entry.hdr && entry.hdr.width === width && entry.hdr.height === height
      && (entry.hdr.samples || 0) === wantSamples) return entry;
  entry.hdr?.dispose();
  entry.ldr?.dispose();
  entry.hdr = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    stencilBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    // The model is the only geometry in the comp that shows raw polygon edges; without
    // MSAA on this offscreen target every silhouette is a staircase, no matter what the
    // main canvas does. Three resolves both the colour and the depth texture on read.
    // WebGPU: MSAA + depthTexture on an offscreen HalfFloat target has produced
    // blank/black plates on real devices (R17 left MSAA depth unproven). Keep the
    // lit pass; drop samples there until the resolve path is verified.
    samples: wantSamples,
  });
  // Sampleable depth, so the compositor can occlude 2D layers against the model's real
  // surface instead of against its flat silhouette. Only meaningful because the pass
  // camera is given the compositor's own near/far below — depth values from a different
  // projection would compare as noise.
  entry.hdr.depthTexture = new THREE.DepthTexture(width, height);
  entry.hdr.depthTexture.type = THREE.UnsignedIntType;
  entry.hdr.depthTexture.minFilter = THREE.NearestFilter;
  entry.hdr.depthTexture.magFilter = THREE.NearestFilter;
  entry.ldr = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  return entry;
}

// Exposure + ACES + sRGB encode, done here rather than by flipping renderer state.
// Premultiplied-safe: the model's coverage lives in alpha and colour is scaled by it
// on the way out, matching what a video texture contributes to the accumulation buffer.

let toneMesh = null;
let toneScene = null;
let toneCamera = null;

function ensureTonePass() {
  if (toneMesh) return { toneMesh, toneScene, toneCamera };
  const material = makeMaterial.modelTonePass() ?? createModelTonePassMaterial();
  toneMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  toneScene = new THREE.Scene();
  toneScene.add(toneMesh);
  toneCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return { toneMesh, toneScene, toneCamera };
}

function disposeTonePass() {
  try { toneMesh?.geometry?.dispose(); } catch { /* no-op */ }
  try { toneMesh?.material?.dispose(); } catch { /* no-op */ }
  toneScene?.clear();
  toneMesh = null;
  toneScene = null;
  toneCamera = null;
}

// ── Flat animated shadow plates ─────────────────────────────────────────────
// The clip shader remains the single authority for fitting, crop, filters, text
// rasterisation, shape drawing and text animation. We bake that already-configured
// material every frame and put it on one permanently flat, alpha-tested plane. The
// plane can cast and receive Rig shadows but never gains thickness or a new material
// look, so the ordinary layer remains the visual authority.

function makePlateEntry(itemId) {
  const scene = new THREE.Scene();
  const outer = new THREE.Group();
  scene.add(outer);
  const sourceScene = new THREE.Scene();
  const sourceMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
  sourceScene.add(sourceMesh);
  return {
    itemId,
    scene,
    outer,
    mesh: null,
    plateMaterial: null,
    sourceScene,
    sourceMesh,
    sourceCamera: new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 2),
    sourceSizeKey: '',
    plateSizeKey: '',
    bake: null,
    hdr: null,
    ldr: null,
    camera: null,
  };
}

function ensurePlateEntry(itemId) {
  let entry = plateInstances.get(itemId);
  if (!entry) {
    entry = makePlateEntry(itemId);
    plateInstances.set(itemId, entry);
  }
  return entry;
}

function ensurePlateBakeTarget(entry, width, height) {
  const maxEdge = 1536;
  const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
  const w = Math.max(2, Math.round(width * scale));
  const h = Math.max(2, Math.round(height * scale));
  if (!entry.bake || entry.bake.width !== w || entry.bake.height !== h) {
    entry.bake?.dispose();
    entry.bake = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    // Raw, deliberately. The clip shader's output is already display-referred, and
    // the plate material samples this through a hand-declared sampler — three
    // decodes nothing there, so tagging it sRGB only made the tone pass encode a
    // second time. Display-referred in, display-referred out.
    entry.bake.texture.colorSpace = THREE.NoColorSpace;
  }
  return entry.bake;
}

function posePlateSource(entry, sourceMaterial, plateWidth, plateHeight) {
  const sizeKey = `${plateWidth.toFixed(3)}|${plateHeight.toFixed(3)}`;
  if (entry.sourceSizeKey !== sizeKey) {
    entry.sourceMesh.geometry?.dispose();
    entry.sourceMesh.geometry = new THREE.PlaneGeometry(plateWidth, plateHeight);
    entry.sourceSizeKey = sizeKey;
  }
  entry.sourceMesh.material = sourceMaterial;
  entry.sourceMesh.position.set(0, 0, 0);
  entry.sourceMesh.rotation.set(0, 0, 0);
  // WebGPU: the clip material draws a camera render the other way up from what
  // three's render-target sampling expects, so an unmirrored bake put the picture
  // UPSIDE DOWN on its plane — artwork, alpha cut-outs and the shadow it casts
  // alike (all three read the bake through the same texture). Mirroring the source
  // quad stores it upright for every reader; three fixes the winding.
  entry.sourceMesh.scale.set(1, selectedBackend() === 'webgpu' ? -1 : 1, 1);
  const cam = entry.sourceCamera;
  cam.left = -plateWidth / 2;
  cam.right = plateWidth / 2;
  cam.top = plateHeight / 2;
  cam.bottom = -plateHeight / 2;
  cam.position.set(0, 0, 1);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
}

function drawPlateSource(renderer, entry, target) {
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(entry.sourceScene, entry.sourceCamera);
}


function syncPlateObject(renderer, entry, opts, plateWidth, plateHeight) {
  const { item, sourceMaterial } = opts;
  const shadows = item?.shadowPlate || {};
  posePlateSource(entry, sourceMaterial, plateWidth, plateHeight);
  const bake = ensurePlateBakeTarget(entry, plateWidth, plateHeight);
  drawPlateSource(renderer, entry, bake);

  if (!entry.plateMaterial) {
    entry.plateMaterial = makeMaterial.shadowPlate() ?? makeShadowPlateMaterial();
  }
  const material = entry.plateMaterial;
  if (material.map !== bake.texture) {
    material.map = bake.texture;
    material.needsUpdate = true;
  }
  material.userData.receiveShadow = shadows.receiveShadow === true;
  material.userData.plateUniforms.uPlate.value = bake.texture;
  material.userData.plateUniforms.uReceiveShadow.value = shadows.receiveShadow === true ? 1 : 0;

  const sizeKey = `${plateWidth.toFixed(3)}|${plateHeight.toFixed(3)}`;
  if (!entry.mesh) {
    entry.mesh = new THREE.Mesh(new THREE.PlaneGeometry(plateWidth, plateHeight), material);
    entry.outer.add(entry.mesh);
    entry.plateSizeKey = sizeKey;
  } else if (entry.plateSizeKey !== sizeKey) {
    entry.mesh.geometry?.dispose();
    entry.mesh.geometry = new THREE.PlaneGeometry(plateWidth, plateHeight);
    entry.plateSizeKey = sizeKey;
  }
  entry.mesh.material = material;
  setShadowFlags(entry.outer, shadows.castShadow === true, shadows.receiveShadow === true);
}

// ── The pass ────────────────────────────────────────────────────────────────
const _box = new THREE.Box3();
const _center = new THREE.Vector3();
const _viewCenter = new THREE.Vector3();
const _spillNdc = new THREE.Vector3();
const _viewCorner = new THREE.Vector3();

// ── Transparent depth ────────────────────────────────────────────────────────
// A transparent mesh (a contact-shadow card, a decal, glass) blends its colour
// without writing depth, as it must inside the model, so the pass's depth has no
// surface there: no occlusion against other layers, and camera DOF took its pixels
// for spill at the model's centre depth (a soft shadow card drew as a black disc in
// front of lettering it lies under). The pass therefore also hands back a SECOND
// depth: opaque and transparent surfaces together, each transparent one where it is
// actually visible (alpha >= TRANSPARENT_DEPTH_ALPHA). It is drawn into its own
// target after the colour pass, so colour and blending are untouched and the
// opaque depth stays what it was. The compositor reads the difference: a pixel where
// this depth is nearer than the opaque one is a transparent card in front, and
// composites at the card's depth WITHOUT writing it (adjustmentComposite.js).
const TRANSPARENT_DEPTH_ALPHA = 0.02;
const _depthHidden = [];
const _depthSwapped = [];

// One cached unlit twin per material that only reads alpha: colour writes off,
// depth on. A transparent material is alpha-tested at TRANSPARENT_DEPTH_ALPHA; an
// opaque one keeps its own alpha test (none, unless it cuts out), so its depth
// matches the colour pass's. No polygon offset: on WebGPU a slope-scaled bias on a
// card seen edge-on threw it far in front of everything (the compositor nudges a
// card toward the camera itself, in proportion to its distance).
function depthTwin(material) {
  const transparent = !!material.transparent;
  const key = transparent ? 'glDepthTwinT' : 'glDepthTwinO';
  let twin = material.userData[key];
  if (!twin) {
    twin = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true });
    material.userData[key] = twin;
  }
  const alphaTest = transparent ? Math.max(material.alphaTest || 0, TRANSPARENT_DEPTH_ALPHA) : (material.alphaTest || 0);
  const map = alphaTest > 0 ? (material.map || null) : null;
  const alphaMap = alphaTest > 0 ? (material.alphaMap || null) : null;
  if (twin.map !== map || twin.alphaMap !== alphaMap || twin.vertexColors !== !!material.vertexColors
    || twin.side !== material.side || twin.alphaTest !== alphaTest) {
    twin.map = map;
    twin.alphaMap = alphaMap;
    twin.vertexColors = !!material.vertexColors;
    twin.side = material.side;
    twin.alphaTest = alphaTest;
    twin.needsUpdate = true;
  }
  twin.opacity = alphaTest > 0 && Number.isFinite(material.opacity) ? material.opacity : 1;
  return twin;
}

function ensureTransparentDepthTarget(entry) {
  const { width, height } = entry.hdr;
  if (entry.tdepth && (entry.tdepth.width !== width || entry.tdepth.height !== height)) {
    entry.tdepth.dispose();
    entry.tdepth = null;
  }
  if (!entry.tdepth) {
    entry.tdepth = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
    });
    entry.tdepth.depthTexture = new THREE.DepthTexture(width, height);
    entry.tdepth.depthTexture.type = THREE.UnsignedIntType;
    entry.tdepth.depthTexture.minFilter = THREE.NearestFilter;
    entry.tdepth.depthTexture.magFilter = THREE.NearestFilter;
  }
  return entry.tdepth;
}

/** The pass's opaque + transparent depth, or null when it has no transparent mesh. */
function renderTransparentDepth(renderer, entry, scene, cam) {
  const isTransparent = (m) => !!(m?.transparent && m.visible !== false);
  let any = false;
  const meshes = [];
  entry.outer.traverseVisible((o) => {
    if (!o.isMesh) return;
    meshes.push(o);
    if (!o.userData.glScreen && (Array.isArray(o.material) ? o.material.some(isTransparent) : isTransparent(o.material))) any = true;
  });
  if (!any) {
    if (entry.tdepth) { entry.tdepth.dispose(); entry.tdepth = null; }
    return null;
  }
  const target = ensureTransparentDepthTarget(entry);
  const keep = new Set(meshes);
  // Only the twins draw: everything else this camera would film is hidden.
  scene.traverseVisible((o) => {
    if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && !keep.has(o) && cam.layers.test(o.layers)) _depthHidden.push(o);
  });
  for (const o of _depthHidden) o.visible = false;
  for (const o of meshes) {
    _depthSwapped.push(o, o.material);
    o.material = Array.isArray(o.material) ? o.material.map((x) => (x ? depthTwin(x) : x)) : depthTwin(o.material);
  }
  const background = scene.background;
  scene.background = null;
  try {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, cam);
  } finally {
    scene.background = background;
    for (let i = 0; i < _depthSwapped.length; i += 2) _depthSwapped[i].material = _depthSwapped[i + 1];
    for (const o of _depthHidden) o.visible = true;
    _depthSwapped.length = 0;
    _depthHidden.length = 0;
  }
  return target.depthTexture;
}

// The box's span along the camera's view axis — its nearest and farthest corner,
// clamped to the near plane. Per-pixel DOF reads each pixel's depth; this bounds
// what that depth can be, so the compositor can skip a pass that no CoC reaches
// and knows how far a blurred foreground may spread (modelDof.js).
function boxViewRange(box, cam) {
  let near = Infinity;
  let far = -Infinity;
  for (let i = 0; i < 8; i++) {
    _viewCorner.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    ).applyMatrix4(cam.matrixWorldInverse);
    const d = -_viewCorner.z;
    if (d < near) near = d;
    if (d > far) far = d;
  }
  if (!Number.isFinite(near) || !Number.isFinite(far)) return null;
  cam.getWorldPosition(_viewCorner);
  // The world box and eye too: the compositor orders models by whose box is on the
  // camera's side of whose (compositeSortDepth.js orderByBoxes).
  return {
    near: Math.max(cam.near, near), far: Math.max(cam.near, far),
    box: [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z],
    eye: [_viewCorner.x, _viewCorner.y, _viewCorner.z],
  };
}

/**
 * Bring one flat layer's plate object up to date and put it in the shared world:
 * re-bake this frame's artwork, pose the plate at the layer's transform, and hand
 * back the private layer the pass camera would film it on.
 *
 * This is EVERYTHING a casting plate needs — its shadow comes from the world's one
 * shadow map, which is rendered from the scene, not from this layer's own pass. It
 * is therefore exported on its own: a layer that only casts (or only occludes) is
 * never filmed, so it stays an ordinary quad in the compositor and keeps its exact
 * position, its blend mode and its per-layer effects.
 *
 * Returns null when there is nothing to sync.
 */
export function syncPlateLayer(renderer, opts) {
  const { item, sourceMaterial, W, H } = opts;
  if (!item?.id || !sourceMaterial || !renderer) return null;
  ensureShadowType(renderer);
  const plateWidth = Math.max(1, Number(opts.plateWidth) || W || 1);
  const plateHeight = Math.max(1, Number(opts.plateHeight) || H || 1);
  const entry = ensurePlateEntry(item.id);

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevClearAlpha = renderer.getClearAlpha();
  const prevBlend = {
    blending: sourceMaterial.blending,
    blendSrc: sourceMaterial.blendSrc,
    blendDst: sourceMaterial.blendDst,
    blendEquation: sourceMaterial.blendEquation,
    blendSrcAlpha: sourceMaterial.blendSrcAlpha,
    blendDstAlpha: sourceMaterial.blendDstAlpha,
    blendEquationAlpha: sourceMaterial.blendEquationAlpha,
  };

  try {
    renderer.autoClear = false;
    // A layer blend mode describes how the FINISHED 3D object meets the stack. The
    // local artwork bake itself must always be ordinary over transparent.
    sourceMaterial.blending = THREE.NormalBlending;
    sourceMaterial.blendSrc = THREE.SrcAlphaFactor;
    sourceMaterial.blendDst = THREE.OneMinusSrcAlphaFactor;
    sourceMaterial.blendEquation = THREE.AddEquation;
    sourceMaterial.blendSrcAlpha = null;
    sourceMaterial.blendDstAlpha = null;
    sourceMaterial.blendEquationAlpha = null;

    syncPlateObject(renderer, entry, opts, plateWidth, plateHeight);

    const rig = normalizeRig(opts.rig || {});
    const world = ensureSharedWorld();
    const scene = world.scene;
    const passLayer = joinWorld(world, `p:${item.id}`, entry.outer, entry.scene);

    const envUrl = opts.rig ? resolveEnvUrl(rig.env) : null;
    const env = envUrl ? environmentForUrl(renderer, envUrl) : null;
    if (env?.status === 'ready' && (world.envKey !== envUrl || scene.environment !== env.texture)) {
      scene.environment = env.texture;
      world.envKey = envUrl;
    } else if (world.envKey !== envUrl || !envUrl) {
      scene.environment = null;
      world.envKey = envUrl;
    }
    scene.environmentIntensity = opts.rig ? rig.env.intensity : 1;
    scene.environmentRotation?.set?.(
      ((opts.rig ? rig.env.rotX : 0) * Math.PI) / 180,
      ((opts.rig ? rig.env.rotY : 0) * Math.PI) / 180,
      ((opts.rig ? rig.env.rotZ : 0) * Math.PI) / 180
    );
    syncLightsToScene(world.lightRig, rig.lights);

    // The layer's transform, in the SAME world units and the same frame as a model's
    // `prs` — the caller decomposes the compositor mesh's world matrix, so channel
    // stacking and layer parenting arrive here already folded in.
    const transform = opts.transform || {};
    const p = transform.position || {};
    const q = transform.quaternion || {};
    const s = transform.scale || {};
    entry.outer.position.set(Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0);
    if ([q.x, q.y, q.z, q.w].every(Number.isFinite)) {
      entry.outer.quaternion.set(q.x, q.y, q.z, q.w);
    } else {
      entry.outer.quaternion.identity();
    }
    // Z stays 1. The plate has no thickness, so a z-scale can only ever misreport
    // its bounds to the shadow-frustum fit and to the DOF probe.
    entry.outer.scale.set(
      Number.isFinite(s.x) && s.x !== 0 ? s.x : 1,
      Number.isFinite(s.y) && s.y !== 0 ? s.y : 1,
      1
    );
    scene.updateMatrixWorld(true);
    return { entry, world, scene, rig, passLayer };
  } finally {
    Object.assign(sourceMaterial, prevBlend);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(prevClear, prevClearAlpha);
  }
}

/**
 * Film a plate that has to be RE-LIT: its own pixels are darkened by the scene's
 * shadow map, which only the shared world can do. The returned texture is
 * full-frame and already shot through the project camera, the same contract as
 * renderModelLayer — and the same cost, which is why nothing but receiving a
 * shadow sends a layer down here.
 */
export function renderPlateLayer(renderer, opts) {
  const { item, sourceMaterial, pose, W, H, width, height } = opts;
  if (!item?.id || !sourceMaterial || !renderer) {
    return { texture: null, depthTexture: null, viewDistance: null };
  }
  ensureShadowType(renderer);
  const entry = ensurePlateEntry(item.id);
  ensureTargets(entry, Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevClearAlpha = renderer.getClearAlpha();

  try {
    renderer.autoClear = false;
    const synced = syncPlateLayer(renderer, opts);
    if (!synced) return { texture: null, depthTexture: null, viewDistance: null };
    const { world, scene, rig, passLayer } = synced;

    const proxy = pose ? cameraProxyFromPose(pose, W, H) : null;
    const cam = entry.camera || (entry.camera = new THREE.PerspectiveCamera(28, 1, 1, 100000));
    const D = proxyDistance(W, H);
    if (proxy) {
      cam.position.copy(proxy.position);
      cam.quaternion.copy(proxy.quaternion);
      cam.fov = proxy.fov;
    } else {
      cam.position.set(0, 0, D);
      cam.quaternion.identity();
      cam.fov = 28;
    }
    cam.aspect = W / H;
    cam.layers.set(passLayer);
    cam.near = Number.isFinite(opts.near) && opts.near > 0 ? opts.near : Math.max(1, D * 0.001);
    cam.far = Number.isFinite(opts.far) && opts.far > cam.near ? opts.far : D * 20;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    _box.setFromObject(entry.outer);
    _box.getCenter(_center);
    _viewCenter.copy(_center).applyMatrix4(cam.matrixWorldInverse);
    const viewDistance = -_viewCenter.z;
    const viewRange = boxViewRange(_box, cam);

    const sh = prepareWorldShadows(world, rig, opts.frameToken ?? 0, H, pcssActive, cam);
    renderer.setRenderTarget(entry.hdr);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    withWorldShadows(renderer, sh, world, scene, cam, () => renderer.render(scene, cam));

    const { toneMesh: tm, toneScene: ts, toneCamera: tc } = ensureTonePass();
    tm.material.uniforms.uTexture.value = entry.hdr.texture;
    tm.material.uniforms.uResolution.value.set(entry.ldr.width, entry.ldr.height);
    tm.material.uniforms.uExposure.value = 1;
    if (tm.material.uniforms.uScreenMaskOn) tm.material.uniforms.uScreenMaskOn.value = 0;
    // The plate carries the layer's own finished artwork, not rendered radiance, so
    // no display transform runs over it: switching on "receive shadow" must not
    // change the layer's colour, only darken it where a shadow lands.
    tm.material.uniforms.uDisplay.value = 0;
    renderer.setRenderTarget(entry.ldr);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(ts, tc);
    tm.material.uniforms.uDisplay.value = 1;

    return {
      texture: entry.ldr.texture,
      // The plate's real surface, for the compositor's depth test. Transparent
      // pixels never stamp: the material discards them before it writes depth.
      depthTexture: item.shadowPlate?.occludes === true ? entry.hdr.depthTexture : null,
      viewDistance,
      viewRange,
      error: null,
    };
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(prevClear, prevClearAlpha);
  }
}

// ── 3D Text (text3d.js) ─────────────────────────────────────────────────────
// A text layer drawn as real extruded letters. The 2D text code lays the letters
// out and animates them exactly as before (layerMesh.js), and hands this pass a
// RUN: per letter its font, character, colour, alpha and a plate-space matrix
// (the Text Animators' real 3D transform, Text on Path pose included). Here every
// letter is a mesh of shared glyph geometry (text3dGlyphs.js), placed on the layer
// by the compositor quad's own world transform — the promotePlateMesh contract —
// lit by the Rig (shared world: shadows on the set) or its own studio light, and
// filmed through the project camera like a model.

const text3dInstances = new Map();

// Light without a Rig: the model's own three directionals at preset strengths,
// plus an environment for reflections.
// Studio matches a model's own default light (key 1, fill 0.45, rim 0.35), so a
// red letter beside a red model reads as the same red.
const TEXT3D_LIGHTING = {
  studio: { env: 'studio_small_03_1k', key: 1, fill: 0.45, rim: 0.5 },
  soft: { env: 'studio_small_03_1k', key: 0.55, fill: 0.6, rim: 0.2 },
  dramatic: { env: 'dikhololo_night_1k', key: 2, fill: 0.06, rim: 1.3 },
};

// Plastic's lacquer stays light: clearcoat reflects the environment on top of the
// colour, and a heavy coat washes a toy red to pink (more so on WebGL).
const TEXT3D_FINISH = {
  plastic: { roughness: 0.32, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.2, opacity: 1 },
  matte: { roughness: 0.85, metalness: 0, clearcoat: 0, clearcoatRoughness: 0, opacity: 1 },
  metal: { roughness: 0.22, metalness: 1, clearcoat: 0, clearcoatRoughness: 0, opacity: 1 },
  glass: { roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, opacity: 0.55 },
};

function makeText3dEntry(itemId) {
  const scene = new THREE.Scene();
  const outer = new THREE.Group();
  // Plate px (x right, y DOWN, z AWAY) → the layer's local frame (y UP, z toward
  // the viewer), centred on the plate. Set per frame from the run's plate size.
  const plate = new THREE.Group();
  plate.matrixAutoUpdate = false;
  outer.add(plate);
  scene.add(outer);
  return {
    itemId, scene, outer, plate, lightRig: makeLightRig(scene),
    meshes: [], hdr: null, ldr: null, camera: null, envKey: null,
  };
}

const _t3dFace = new THREE.Color();
const _t3dSide = new THREE.Color();
const cssFirstColour = (css) => {
  const m = String(css || '').match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/i);
  return m ? m[0] : (css || '#ffffff');
};

function syncText3dLetters(entry, run) {
  const s = run.settings;
  const finish = TEXT3D_FINISH[s.material] || TEXT3D_FINISH.plastic;
  const depth = Math.max(0, s.depth) / 100;
  const bevel = Math.max(0, s.bevel) / 100;
  const palette = Array.isArray(s.palette) && s.palette.length ? s.palette : null;
  let n = 0;
  for (const g of run.glyphs) {
    const built = glyphGeometry(g.font, g.ch, depth, bevel, s.bevelSegments, g.fv || 0);
    if (!built) continue;
    let mesh = entry.meshes[n];
    if (!mesh) {
      mesh = new THREE.Mesh(built.geometry, [new THREE.MeshPhysicalMaterial(), new THREE.MeshPhysicalMaterial()]);
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      entry.plate.add(mesh);
      entry.meshes.push(mesh);
    }
    if (mesh.geometry !== built.geometry) mesh.geometry = built.geometry;
    mesh.visible = true;
    const m = g.m;
    mesh.matrix.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]);
    _t3dFace.set(s.faceColor || (palette ? palette[g.index % palette.length] : cssFirstColour(g.color)));
    if (s.sideColor) _t3dSide.set(s.sideColor);
    else _t3dSide.copy(_t3dFace).multiplyScalar(1 - Math.min(0.95, Math.max(0, s.sideShade / 100)));
    const opacity = Math.max(0, Math.min(1, (g.alpha ?? 1) * finish.opacity));
    const [cap, side] = mesh.material;
    for (const [mat, col] of [[cap, _t3dFace], [side, _t3dSide]]) {
      mat.color.copy(col);
      mat.roughness = finish.roughness;
      mat.metalness = finish.metalness;
      mat.clearcoat = finish.clearcoat;
      mat.clearcoatRoughness = finish.clearcoatRoughness;
      const transparent = opacity < 0.999;
      if (mat.transparent !== transparent) { mat.transparent = transparent; mat.needsUpdate = true; }
      mat.opacity = opacity;
      mat.depthWrite = !transparent;
    }
    n += 1;
  }
  for (let i = n; i < entry.meshes.length; i += 1) entry.meshes[i].visible = false;
  return n;
}

/**
 * Film one 3D Text layer. `opts` is renderPlateLayer's (item, transform, pose, rig,
 * W, H, width, height, near, far, frameToken) plus `run` = { plateW, plateH,
 * settings, glyphs: [{ font, ch, color, alpha, index, m }] }. Returns the
 * full-frame texture (premultiplied), its depth and view distance — the same
 * contract as renderModelLayer.
 */
export function renderText3dLayer(renderer, opts) {
  const { item, run, pose, W, H, width, height } = opts;
  const none = { texture: null, depthTexture: null, viewDistance: null };
  if (!item?.id || !run || !renderer) return none;
  ensureShadowType(renderer);
  let entry = text3dInstances.get(item.id);
  if (!entry) { entry = makeText3dEntry(item.id); text3dInstances.set(item.id, entry); }
  ensureTargets(entry, Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevClearAlpha = renderer.getClearAlpha();
  try {
    renderer.autoClear = false;
    const s = run.settings;
    const rig = opts.rig ? normalizeRig(opts.rig) : null;
    const world = rig ? ensureSharedWorld() : null;
    const passLayer = joinWorld(world, `t:${item.id}`, entry.outer, entry.scene);
    const scene = world ? world.scene : entry.scene;
    const look = TEXT3D_LIGHTING[s.light] || TEXT3D_LIGHTING.studio;
    if (world) {
      const envUrl = resolveEnvUrl(rig.env);
      const shared = envUrl ? environmentForUrl(renderer, envUrl) : null;
      if (shared?.status === 'ready' && (world.envKey !== envUrl || scene.environment !== shared.texture)) {
        scene.environment = shared.texture;
        world.envKey = envUrl;
      } else if (world.envKey !== envUrl || !envUrl) {
        scene.environment = null;
        world.envKey = envUrl;
      }
      scene.environmentIntensity = rig.env.intensity;
    } else {
      const env = environmentFor(renderer, look.env);
      if (env.status === 'ready' && (entry.envKey !== look.env || scene.environment !== env.texture)) {
        scene.environment = env.texture;
        entry.envKey = look.env;
      } else if (entry.envKey !== look.env) {
        scene.environment = null;
        entry.envKey = look.env;
      }
      scene.environmentIntensity = Number.isFinite(s.envIntensity) ? s.envIntensity : 1;
    }
    syncLightsToScene(world ? world.lightRig : entry.lightRig,
      rig ? rig.lights : legacyRigLights({ key: look.key, fill: look.fill, rim: look.rim }));

    const count = syncText3dLetters(entry, run);
    if (!count) return none;
    if (world) setShadowFlags(entry.outer, true, true, true);

    // The layer, placed by the compositor quad's world transform. The quad's scale
    // carries the plate's width over the comp's (wide nowrap text); taken out here
    // so letters keep their proportions — 1 plate px = 1 world px × the layer zoom.
    const t = opts.transform || {};
    const p = t.position || {};
    const q = t.quaternion || {};
    const sc = t.scale || {};
    const plateW = Math.max(1, Number(run.plateW) || W);
    const plateH = Math.max(1, Number(run.plateH) || H);
    const zx = (Number.isFinite(sc.x) && sc.x !== 0 ? sc.x : 1) * (W / plateW);
    const zy = (Number.isFinite(sc.y) && sc.y !== 0 ? sc.y : 1) * (H / plateH);
    entry.outer.position.set(Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0);
    if ([q.x, q.y, q.z, q.w].every(Number.isFinite)) entry.outer.quaternion.set(q.x, q.y, q.z, q.w);
    else entry.outer.quaternion.identity();
    entry.outer.scale.set(zx, zy, (Math.abs(zx) + Math.abs(zy)) / 2);
    entry.plate.matrix.set(1, 0, 0, -plateW / 2, 0, -1, 0, plateH / 2, 0, 0, -1, 0, 0, 0, 0, 1);
    scene.updateMatrixWorld(true);

    const proxy = pose ? cameraProxyFromPose(pose, W, H) : null;
    const cam = entry.camera || (entry.camera = new THREE.PerspectiveCamera(28, 1, 1, 100000));
    const D = proxyDistance(W, H);
    if (proxy) {
      cam.position.copy(proxy.position);
      cam.quaternion.copy(proxy.quaternion);
      cam.fov = proxy.fov;
    } else {
      cam.position.set(0, 0, D);
      cam.quaternion.identity();
      cam.fov = 28;
    }
    cam.aspect = W / H;
    cam.layers.set(passLayer);
    cam.near = Number.isFinite(opts.near) && opts.near > 0 ? opts.near : Math.max(1, D * 0.001);
    cam.far = Number.isFinite(opts.far) && opts.far > cam.near ? opts.far : D * 20;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    _box.setFromObject(entry.plate);
    _box.getCenter(_center);
    _viewCenter.copy(_center).applyMatrix4(cam.matrixWorldInverse);
    const viewDistance = -_viewCenter.z;
    const viewRange = boxViewRange(_box, cam);

    const sh = world ? prepareWorldShadows(world, rig, opts.frameToken ?? 0, H, pcssActive, cam) : null;
    renderer.setRenderTarget(entry.hdr);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    if (world) withWorldShadows(renderer, sh, world, scene, cam, () => renderer.render(scene, cam));
    else renderer.render(scene, cam);

    const { toneMesh: tm, toneScene: ts, toneCamera: tc } = ensureTonePass();
    tm.material.uniforms.uTexture.value = entry.hdr.texture;
    tm.material.uniforms.uResolution.value.set(entry.ldr.width, entry.ldr.height);
    tm.material.uniforms.uExposure.value = 1;
    if (tm.material.uniforms.uScreenMaskOn) tm.material.uniforms.uScreenMaskOn.value = 0;
    renderer.setRenderTarget(entry.ldr);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(ts, tc);
    return { texture: entry.ldr.texture, depthTexture: entry.hdr.depthTexture, viewDistance, viewRange, error: null };
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(prevClear, prevClearAlpha);
  }
}

function disposeText3dInstance(entry) {
  if (!entry) return;
  entry.outer.userData.__disposed = true;
  entry.outer.removeFromParent();
  releaseWorldLayer(sharedWorld, `t:${entry.itemId}`);
  // Geometry is shared through the glyph cache; only this layer's materials go.
  for (const mesh of entry.meshes) for (const m of mesh.material) m.dispose();
  entry.hdr?.dispose();
  entry.ldr?.dispose();
}

export function disposeText3dLayer(itemId) {
  const entry = text3dInstances.get(itemId);
  if (!entry) return;
  disposeText3dInstance(entry);
  text3dInstances.delete(itemId);
}

export function disposeAllText3dLayers() {
  for (const entry of text3dInstances.values()) disposeText3dInstance(entry);
  text3dInstances.clear();
  clearGlyphGeometries();
}

export function pruneText3dLayers(keepIds) {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds || []);
  for (const id of [...text3dInstances.keys()]) {
    if (!keep.has(id)) disposeText3dLayer(id);
  }
}

/**
 * Render one model layer.
 *
 * @param renderer  the shared WebGLRenderer (its state is saved and restored)
 * @param opts.item / opts.clip      the timeline item and its clip
 * @param opts.pose                  the project-camera pose for this frame, or null
 *                                   for a neutral camera (camera-locked channels, the
 *                                   world view, and a sequence's inner render — whose
 *                                   output already travels through the sequence clip)
 * @param opts.prs                   resolved position/rotation/scale for the layer
 * @param opts.W / opts.H            composition size in pixels (world units)
 * @param opts.width / opts.height   render-target size (may include supersampling)
 * @param opts.time                  clip-local seconds, for glTF animation
 * @returns { texture, viewDistance } or null when the model is not renderable yet.
 *          `viewDistance` is the bounding-box centre's positive distance along the
 *          camera's -Z: the compositor's DOF probe reads a plane's world z, which for
 *          a model's identity quad would always be 0.
 */
// ── The shared world scene, and real shadow maps ────────────────────────────
//
// Every 3D object still renders in its OWN pass — that is what keeps per-layer
// opacity, blend modes, masks, effects and depth-of-field working. What the shared
// scene buys is the one thing separate scenes cannot give: a shadow map that
// contains every caster, so a model can drop a shadow onto the cyclorama and onto
// another model.
//
// The mechanism is three's own layer culling, used in two directions:
//
//   * the SHADOW prepass uses a camera on layer 0, so every world member contributes
//     even though Three filters shadow casters against the render camera's layers;
//   * the COLOUR pass culls with object.layers.test(camera.layers) — each pass
//     camera is set to one private layer, so it draws only its own object.
//
// Everything is additionally on layer 0, which is the "belongs to the world" bit.
//
// ONLY WHEN A RIG EXISTS. With no rig layer each model keeps its own scene and its
// own `model3dConfig.env`, exactly as before — which is also why the golden fixtures
// (none of which carry a rig) are untouched by any of this. Collapsing those into
// one scene would make two models with different HDRs unrepresentable, the single
// regression most likely to reach existing projects.

const WORLD_PRIVATE_LAYERS = 31;   // three has 32; 0 is the shared "in the world" bit
const CYC_FLOOR_SHAPES = new Set(['cyc', 'floor', 'corner', 'room', 'cylinder', 'dome', 'disc']);
let sharedWorld = null;

function ensureSharedWorld() {
  if (sharedWorld) return sharedWorld;
  const scene = new THREE.Scene();
  sharedWorld = {
    scene,
    lightRig: makeLightRig(scene),
    layerFor: new Map(),   // member key -> private layer index
    usedLayers: new Set(),
    envKey: null,
    shadowToken: -1,
    shadowRevision: -1,
    revision: 0,
    casters: 0,
    shadowProbe: null,
  };
  return sharedWorld;
}

function worldLayerFor(world, key) {
  const held = world.layerFor.get(key);
  if (held != null) return held;
  for (let i = 1; i <= WORLD_PRIVATE_LAYERS; i += 1) {
    if (world.usedLayers.has(i)) continue;
    world.usedLayers.add(i);
    world.layerFor.set(key, i);
    return i;
  }
  // Out of layers (32 3D objects in one comp). Sharing the last one makes two
  // objects draw in each other's pass — wrong, but VISIBLE, which is the failure
  // mode to prefer over silently vanishing.
  world.layerFor.set(key, WORLD_PRIVATE_LAYERS);
  return WORLD_PRIVATE_LAYERS;
}

function releaseWorldLayer(world, key) {
  if (!world || !key) return;
  const layer = world.layerFor.get(key);
  if (layer == null) return;
  world.layerFor.delete(key);
  world.revision += 1;
  // Layer 31 can be shared after the private-layer budget is exhausted. Only make
  // a slot reusable when no remaining world member still owns it.
  if (![...world.layerFor.values()].includes(layer)) world.usedLayers.delete(layer);
}

/** Put a whole subtree on layer 0 + one private layer. Traverses, so it is called
 *  only when the assignment CHANGES — three tests layer membership per descendant,
 *  and a 200-mesh asset re-tagged every frame is real time for nothing. */
function setWorldLayer(root, layer) {
  root.traverse((o) => { o.layers.set(0); if (layer > 0) o.layers.enable(layer); });
}

/**
 * Join (or leave) the shared world, returning the private layer to film it on.
 * `home` is the scene the object lives in when there is no rig.
 */
function joinWorld(world, key, root, home) {
  // While the world view has borrowed this object (attachModelToScene), leave its
  // parent alone — re-parenting mid-borrow would pull the geometry out of the very
  // scene the 3D view is drawing.
  if (root.userData.__borrowed) return root.userData.__worldLayer || 0;
  if (!world) {
    if (root.userData.__worldLayer != null) {
      setWorldLayer(root, 0);
      root.userData.__worldLayer = null;
      if (sharedWorld) sharedWorld.revision += 1;
    }
    if (root.parent !== home) home.add(root);
    return 0;
  }
  if (root.parent !== world.scene) {
    world.scene.add(root);
    world.revision += 1;
  }
  const layer = worldLayerFor(world, key);
  if (root.userData.__worldLayer !== layer) {
    setWorldLayer(root, layer);
    root.userData.__worldLayer = layer;
    world.revision += 1;
  }
  return layer;
}

// BasicShadowMap is only right WITH the PCSS lookup installed. If a three upgrade
// ever changes the chunk so the install fails, fall back to PCF once (one re-key of
// every program) rather than drawing raw, unfiltered depth-test shadows. WebGPU
// runs its own PCF and is untouched.
let pcssActive = false;
const shadowTypeChecked = new WeakSet();
function ensureShadowType(renderer) {
  if (!renderer?.shadowMap) return;
  pcssActive = renderer.isWebGLRenderer && PCSS_INSTALLED && renderer.shadowMap.type === THREE.BasicShadowMap;
  if (shadowTypeChecked.has(renderer)) return;
  shadowTypeChecked.add(renderer);
  if (renderer.shadowMap.type === THREE.BasicShadowMap) {
    if (PCSS_INSTALLED) pcssActive = true;
    else renderer.shadowMap.type = THREE.PCFShadowMap;
  }
}

/**
 * Shadow-casting setup for the frame.
 *
 * Two rules that are not optional:
 *
 *  1. `shadowMap.type` is in the program cache key UNCONDITIONALLY (three.module.js
 *     :7888), so it is set ONCE at renderer init and never touched again. Changing
 *     it later re-keys every program in the app.
 *  2. The shadow maps are rendered ONCE per frame, not once per pass. With
 *     autoUpdate off, `needsUpdate = true` on the frame's first 3D pass makes three
 *     render them during that pass and clear the flag itself; every later pass in
 *     the same frame reuses them. A comp with a cyclorama and four models is 5
 *     passes — without this it would be 5 shadow renders.
 *
 * The caster cap exists because each shadowed light is a full extra scene render.
 *
 * 3. The map is FITTED to the frame's camera (rigShadowFit.js), so it is refitted
 *    exactly when it is re-rendered: on the frame's first pass, when the world's
 *    membership changes, and on the rig pass (`force`), which re-renders it anyway.
 *    `view` is the pass camera. Every pass of a frame normally shares one; a pass
 *    with a different one (a camera-locked model) refits and re-renders for itself.
 */
function prepareWorldShadows(world, rig, frameToken, compH = 1080, pcss = pcssActive, view = null, force = false) {
  const wantShadows = rig?.shadows?.mode === 'map';
  const maxCasters = Math.max(0, Math.min(4, rig?.shadows?.maxCasters ?? 2));

  // A pass filmed by a different camera than the one the map was fitted to (a
  // camera-locked model next to project-camera ones) refits and re-renders.
  let viewChanged = false;
  if (view) {
    const key = shadowViewKey(view);
    if (key !== world.fitViewKey) {
      world.fitView = (world.fitView || new THREE.PerspectiveCamera()).copy(view);
      world.fitViewKey = key;
      viewChanged = true;
    }
  }
  // Layers are prepared lazily in channel order. A new model/shape can therefore
  // join AFTER an earlier text pass already rendered this frame's shadow map. Treat
  // world membership as part of the cache key so the later cyclorama pass refreshes
  // with every caster present instead of freezing the first layer only.
  const first = world.shadowToken !== frameToken || world.shadowRevision !== world.revision || viewChanged;
  world.shadowToken = frameToken;
  world.shadowRevision = world.revision;
  // The map this frame's passes read was fitted when it was rendered; refitting
  // without re-rendering would point every lookup at the wrong texels.
  if (!first && !force) return { enabled: world.casters > 0, first: false };

  // World bounds, for the fallback frusta below. Recomputed per fit because models
  // move; it is one Box3 over the scene, not per-mesh work.
  _box.makeEmpty();
  _box.expandByObject(world.scene);
  _box.getCenter(_center);
  const radius = _box.isEmpty() ? 1000 : Math.max(1, _box.getSize(_worldSize).length() * 0.5);
  // Receivers can be enormous (a studio dome is 24 composition heights, a page ten
  // metres long). Only the part the camera sees is fitted — see rigShadowFit.js.
  const casterBounds = new THREE.Box3();
  const receiverBounds = new THREE.Box3();
  world.scene.traverseVisible((mesh) => {
    if (!mesh.isMesh || !mesh.geometry || !(mesh.castShadow || mesh.receiveShadow)) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    _meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
    if (mesh.castShadow) casterBounds.union(_meshBox);
    if (mesh.receiveShadow) receiverBounds.union(_meshBox);
  });
  world.hasPlates = [...world.layerFor.keys()].some((k) => k.startsWith('p:'));

  let casters = 0;
  for (const held of world.lightRig.byLid.values()) {
    // An area light casts through its companion directional (see applyAreaLight).
    const obj = held.shadowObj || held.obj;
    if (!obj.shadow) continue;                       // ambient / hemisphere / area without a shadow
    const want = wantShadows && held.light?.castShadow === true && casters < maxCasters;
    if (obj.castShadow !== want) obj.castShadow = want;
    if (!want) continue;
    casters += 1;

    const sh = obj.shadow;
    const dist = Math.max(1, obj.position.length());
    // 1024 was visibly coarse on a 1080p composition once a large model shadow
    // crossed a plate. Treat 2048 as the runtime quality floor; authored 4096 maps
    // remain honoured for high-resolution export.
    const size = Math.max(2048, Math.min(4096, held.light.shadowMapSize || 2048));
    if (obj.isDirectionalLight) {
      // DirectionalLightShadow defaults to an OrthographicCamera(-5, 5, 5, -5) — a
      // TEN PIXEL box around a scene thousands of pixels wide. Left alone the shadow
      // map is entirely, silently empty, which is the single most likely way this
      // feature would have looked "done" and shipped broken.
      const r = radius * 1.15;
      sh.camera.left = -r; sh.camera.right = r;
      sh.camera.top = r; sh.camera.bottom = -r;
      sh.camera.near = Math.max(1, dist - radius * 2);
      sh.camera.far = dist + radius * 3;
      sh.updateMatrices(obj);
      const fit = fitDirectionalShadow({
        lightView: sh.camera.matrixWorldInverse,
        view: world.fitView || null,
        receivers: receiverBounds,
        casters: casterBounds,
        pad: Math.max(compH * 0.02, lightSpread(held.light.shadowSoftness, compH).capWorld * 1.5),
        mapSize: size,
      });
      if (fit) {
        sh.camera.left = fit.left; sh.camera.right = fit.right;
        sh.camera.bottom = fit.bottom; sh.camera.top = fit.top;
        sh.camera.near = fit.near; sh.camera.far = fit.far;
      }
    } else if (obj.isSpotLight) {
      sh.camera.fov = Math.min(170, (held.light.angle || 32) * 2);
      sh.camera.near = Math.max(1, dist - radius);
      sh.camera.far = dist + radius * 2;
      sh.camera.aspect = 1;
    } else {
      sh.camera.near = Math.max(1, radius * 0.01);
      sh.camera.far = dist + radius * 2;
    }
    if (sh.mapSize.x !== size) {
      sh.mapSize.set(size, size);
      sh.map?.dispose();
      sh.map = null;
    }
    sh.camera.updateProjectionMatrix();
    const nodeFilter = pcss ? null : makeMaterial.rigShadowFilter(obj);
    sh.filterNode = nodeFilter;
    // Acne is SCALE-dependent: a constant offset that looks right at 1080p stripes
    // the whole set at 4K or on a large set, and a fixed one cannot follow a map
    // fitted per frame. Offsets are therefore set in TEXELS of this map (the light's
    // shadowBias / shadowNormalBias, or automatic when unset) and converted here.
    const texelWorld = obj.isDirectionalLight
      ? (sh.camera.right - sh.camera.left) / size
      : (2 * dist * (obj.isSpotLight ? Math.tan(Math.max(1e-3, obj.angle)) : 1)) / size;
    const auto = autoShadowBias({ planeBias: !!(pcss || nodeFilter), plates: world.hasPlates });
    const depthTexels = Number.isFinite(held.light.shadowBias) ? held.light.shadowBias : auto.depth;
    const normalTexels = Number.isFinite(held.light.shadowNormalBias) ? held.light.shadowNormalBias : auto.normal;
    sh.normalBias = texelWorld * normalTexels;
    sh.bias = -shadowDepthUnits(obj, sh.camera, texelWorld * depthTexels, dist);
    if (pcss || nodeFilter) {
      // Soft shadows (rigSoftShadows.js): the radius uniform carries the light's
      // size and penumbra growth, measured against this fitted frustum.
      sh.radius = pcssRadiusFor(obj, {
        softness: held.light.shadowSoftness ?? 1, compH, mapSize: size, subjectDist: dist,
      });
    } else {
      // r183's old PCFSoft mode is only an alias for PCF, but PCF still honours
      // each light's radius. A softness of 1 is a visibly smooth four-pixel
      // penumbra; 0 remains hard.
      sh.radius = Math.max(0, Math.min(40, (held.light.shadowSoftness ?? 1) * 4));
    }
  }
  world.casters = casters;
  return { enabled: casters > 0, first: true };
}

/** The shared world's shadow setup as last fitted — for verification harnesses. */
export function worldShadowStats() {
  if (!sharedWorld) return null;
  const lights = [];
  for (const [lid, held] of sharedWorld.lightRig.byLid) {
    const obj = held.shadowObj || held.obj;
    if (!obj.shadow || !obj.castShadow) continue;
    const c = obj.shadow.camera;
    lights.push({
      lid, type: held.type, mapSize: obj.shadow.mapSize.x,
      left: c.left, right: c.right, bottom: c.bottom, top: c.top, near: c.near, far: c.far,
      bias: obj.shadow.bias, normalBias: obj.shadow.normalBias, radius: obj.shadow.radius,
    });
  }
  return { casters: sharedWorld.casters, fitted: !!sharedWorld.fitView, lights };
}

/** A world-px offset along the light, in the shadow map's own depth units. */
function shadowDepthUnits(light, cam, worldOffset, subjectDist) {
  const near = Math.max(1e-3, cam.near);
  const far = Math.max(near + 1e-3, cam.far);
  if (light.isDirectionalLight) return worldOffset / Math.max(1e-3, cam.far - cam.near);
  // Perspective depth (spot, and the point cube's per-face depth) is not linear:
  // linearised at the subject's distance, where the shadows that matter are.
  const z = Math.max(near, Math.min(far, subjectDist));
  return (worldOffset * far * near) / ((far - near) * z * z);
}

/** Identity of a pass camera's view, for refitting when it changes mid-frame. */
function shadowViewKey(cam) {
  let key = '';
  for (const v of cam.matrixWorld.elements) key += `${v.toFixed(3)},`;
  for (const v of cam.projectionMatrix.elements) key += `${v.toFixed(6)},`;
  return key;
}

const _worldSize = new THREE.Vector3();
const _meshBox = new THREE.Box3();

/**
 * Build the shared shadow map without leaking every world object into this layer's
 * colour pass.
 *
 * Three's WebGLShadowMap checks `object.layers.test(camera.layers)`, where `camera`
 * is the camera supplied to renderer.render — not the light's shadow camera. Our
 * ordinary pass camera is deliberately private (one layer, one output texture), so
 * asking that render to refresh shadows can only ever capture its own object. A
 * tiny discarded colour render with layer 0 enabled gives the shadow stage every
 * caster; the real render immediately afterwards restores the private layer and
 * reuses the completed map.
 */
function primeWorldShadowMap(renderer, world, scene, camera) {
  if (!world.shadowProbe) {
    world.shadowProbe = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: false,
      stencilBuffer: false,
    });
    world.shadowProbe.texture.name = 'Shared world shadow prepass';
  }

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevClearAlpha = renderer.getClearAlpha();
  const prevEnabled = renderer.shadowMap.enabled;
  const prevAuto = renderer.shadowMap.autoUpdate;
  const prevNeedsUpdate = renderer.shadowMap.needsUpdate;
  const prevLayerMask = camera.layers.mask;

  try {
    camera.layers.set(0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.autoClear = false;
    renderer.setRenderTarget(world.shadowProbe);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
  } finally {
    camera.layers.mask = prevLayerMask;
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(prevClear, prevClearAlpha);
    renderer.shadowMap.enabled = prevEnabled;
    renderer.shadowMap.autoUpdate = prevAuto;
    renderer.shadowMap.needsUpdate = prevNeedsUpdate;
  }
}

/** Cast/receive flags on one object's subtree. Cheap, and only on change.
 *  `skipBlended`: a mesh whose every material is blended without an alpha cut-out
 *  (glTF BLEND — depth write off, alphaTest 0) does not cast. three's depth pass
 *  ignores such alpha entirely, so a soft contact-shadow card or a glow would cast
 *  its whole rectangle onto the set. */
function setShadowFlags(root, cast, receive, skipBlended = false) {
  if (root.userData.__shCast === cast && root.userData.__shRecv === receive && root.userData.__shBlend === skipBlended) return;
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = cast && !(skipBlended && isBlendedCard(o));
    o.receiveShadow = receive;
  });
  root.userData.__shCast = cast;
  root.userData.__shRecv = receive;
  root.userData.__shBlend = skipBlended;
}

function isBlendedCard(mesh) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return mats.length > 0 && mats.every((m) => m && m.transparent && m.depthWrite === false && !(m.alphaTest > 0));
}

/**
 * The share of the set's light that casting lights carry — how dark a full shadow
 * is on a surface that only SHOWS shadows (a "Shadows only" cyclorama, a self-lit
 * screen). Fill lights and the HDR still reach a shadowed spot, so a fully blocked
 * key must not turn it pure black.
 */
function castingLightShare(rig) {
  let total = Math.max(0, rig?.env?.intensity || 0), casting = 0;
  // Read from the rig itself, in the order prepareWorldShadows hands out the caster
  // slots — a screen pass can run before this frame's shadow setup.
  let slots = Math.max(0, Math.min(4, rig?.shadows?.maxCasters ?? 2));
  for (const light of rig?.lights || []) {
    if (!light.on) continue;
    const energy = Math.max(0, light.intensity || 0);
    total += energy;
    if (light.castShadow !== true || light.type === 'ambient' || light.type === 'hemisphere' || slots <= 0) continue;
    slots -= 1;
    // An area light's companion carries only its share of the light.
    casting += light.type === 'area' ? energy * AREA_SHADOW_SHARE : energy;
  }
  return total > 0 ? casting / total : 1;
}

/**
 * Rig shadows on self-lit screens (model3dConfig.screens[].receiveShadow).
 *
 * A self-lit screen shows its media's own colours — no light, so no shadow either:
 * a page or a UI a character walks on looked as if he floated over it. An opted-in
 * screen gets a coplanar ShadowMaterial twin that darkens it by the casting lights'
 * share where a shadow lands, and by nothing anywhere else, so its colours stay the
 * media's own. Lit screens take shadows through their lighting already.
 */
function syncScreenShadows(entry, config, world, rig) {
  const list = Array.isArray(config.screens) ? config.screens : [];
  const on = !!world && config.receiveShadow !== false;
  const want = new Set();
  if (on) {
    (entry.screenSlots || []).forEach((slot, i) => {
      const s = list[i];
      if (!s || s.receiveShadow !== true || s.shading === 'lit') return;
      for (const mesh of slot.screenOriginals?.keys() || []) want.add(mesh);
    });
  }
  const held = entry.screenShadows || (entry.screenShadows = new Map());
  for (const [mesh, overlay] of held) {
    if (want.has(mesh) && overlay.parent === mesh) continue;
    overlay.removeFromParent();
    held.delete(mesh);
  }
  if (!want.size) return;
  if (!entry.screenShadowMat) {
    entry.screenShadowMat = new THREE.ShadowMaterial({
      color: 0x000000, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
  }
  entry.screenShadowMat.opacity = castingLightShare(rig);
  for (const mesh of want) {
    let overlay = held.get(mesh);
    if (!overlay) {
      overlay = new THREE.Mesh(mesh.geometry, entry.screenShadowMat);
      overlay.name = 'Screen shadow';
      overlay.castShadow = false;
      overlay.raycast = () => {};
      // Part of the screen, not a see-through part of the model: it must not switch
      // on the transparent-depth pass (renderTransparentDepth) for the whole model.
      overlay.userData.glScreen = true;
      mesh.add(overlay);
      held.set(mesh, overlay);
    }
    // A planar-UV screen swaps its geometry; the twin follows it.
    if (overlay.geometry !== mesh.geometry) overlay.geometry = mesh.geometry;
    overlay.receiveShadow = true;
    overlay.layers.mask = mesh.layers.mask;
    overlay.visible = mesh.visible;
  }
}

/** Wrap ONLY the scene render — never the tone pass, and always restored. */
function withShadows(renderer, on, needsUpdate, draw) {
  if (!on) { draw(); return; }
  const prevEnabled = renderer.shadowMap.enabled;
  const prevAuto = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = false;
  if (needsUpdate) renderer.shadowMap.needsUpdate = true;
  try {
    draw();
  } finally {
    renderer.shadowMap.enabled = prevEnabled;
    renderer.shadowMap.autoUpdate = prevAuto;
  }
}

/** Prime with every layer, then draw only this pass's private colour layer. */
function withWorldShadows(renderer, shadowState, world, scene, camera, draw, forcePrime = false) {
  if (!shadowState?.enabled || !world) {
    draw();
    return;
  }
  if (shadowState.first || forcePrime) primeWorldShadowMap(renderer, world, scene, camera);
  // The prepass has already populated the maps. Never let the private colour camera
  // overwrite them with one caster immediately afterwards.
  const prevNeedsUpdate = renderer.shadowMap.needsUpdate;
  renderer.shadowMap.needsUpdate = false;
  try {
    withShadows(renderer, true, false, draw);
  } finally {
    renderer.shadowMap.needsUpdate = prevNeedsUpdate;
  }
}

/**
 * Lend the cyclorama's real geometry to another scene — the 3D world view.
 *
 * Without this the world view showed the rig layer the way it shows any 2D layer:
 * its COMPOSITED OUTPUT painted on a flat full-frame quad. A curved studio backdrop
 * came out as a rectangle with a gradient on it, which is worse than useless for
 * judging depth while framing a camera move — the one job that view has.
 *
 * Same contract and the same refcounted-lighting discipline as attachModelToScene:
 * returns a detach closure, or null when there is nothing to lend.
 */
export function attachCycloramaToScene(scene) {
  const mesh = rigInstance?.cyc?.mesh;
  if (!mesh || !scene || mesh.parent === scene || !mesh.visible) return null;
  const home = mesh.parent || sharedWorld?.scene || null;
  // Borrowed, so the rig pass leaves its parent alone for the duration.
  mesh.userData.__borrowed = true;

  let lent = worldLightRigs.get(scene);
  if (!lent) {
    lent = {
      rig: makeLightRig(scene),
      refs: 0,
      exposure: 1,
      prevEnv: scene.environment,
      prevIntensity: scene.environmentIntensity,
      prevRotation: scene.environmentRotation?.clone?.() || null,
    };
    worldLightRigs.set(scene, lent);
  }
  lent.refs += 1;
  scene.add(mesh);
  // The world view has to be lit by the SAME rig the render uses, or the set looks
  // like a different set in the two places it is shown.
  if (sharedWorld) {
    const defs = [...sharedWorld.lightRig.byLid.values()].map((h) => h.light).filter(Boolean);
    if (defs.length) syncLightsToScene(lent.rig, defs);
    if (sharedWorld.scene.environment) {
      scene.environment = sharedWorld.scene.environment;
      scene.environmentIntensity = sharedWorld.scene.environmentIntensity;
    }
  }

  return () => {
    mesh.userData.__borrowed = false;
    if (!mesh.userData.__disposed && home) home.add(mesh); else mesh.removeFromParent();
    const held = worldLightRigs.get(scene);
    if (!held) return;
    held.refs -= 1;
    if (held.refs > 0) return;
    disposeLightRig(held.rig);
    scene.environment = held.prevEnv;
    scene.environmentIntensity = held.prevIntensity;
    if (held.prevRotation) scene.environmentRotation?.copy?.(held.prevRotation);
    worldLightRigs.delete(scene);
  };
}

/** Keep the real-geometry 3D editor view on the same project rig as the camera
 * render. Borrowing lasts while the view is open, but rig controls are live and
 * keyframeable, so a one-time copy at attach cannot be correct. */
export function syncBorrowedWorldRig(scene, rawRig) {
  const lent = scene ? worldLightRigs.get(scene) : null;
  if (!lent) return rawRig ? normalizeRig(rawRig).env.exposure : 1;
  // A project without a Scene Rig still borrows the first model's legacy light rig.
  // Its exposure was captured at attach time and must drive World View too.
  if (!rawRig) return Number.isFinite(lent.exposure) && lent.exposure > 0 ? lent.exposure : 1;
  const rig = normalizeRig(rawRig);
  lent.exposure = rig.env.exposure;
  syncLightsToScene(lent.rig, rig.lights);
  scene.environment = sharedWorld?.scene?.environment || null;
  scene.environmentIntensity = rig.env.intensity;
  scene.environmentRotation?.set?.(
    (rig.env.rotX * Math.PI) / 180,
    (rig.env.rotY * Math.PI) / 180,
    (rig.env.rotZ * Math.PI) / 180
  );
  return lent.exposure;
}

/** The live cyclorama mesh, for the world view's gizmo/selection box. */
export function getCycloramaObject() {
  const mesh = rigInstance?.cyc?.mesh;
  return mesh && mesh.visible ? mesh : null;
}

export function disposeSharedWorld() {
  if (sharedWorld) {
    disposeLightRig(sharedWorld.lightRig);
    sharedWorld.shadowProbe?.dispose();
    sharedWorld.scene.clear();
    sharedWorld = null;
  }
  // Unlike parsed assets, this fullscreen pass owns a backend-specific material
  // and must never survive into a renderer of the other kind.
  disposeTonePass();
}

// ── Real-3D effects (model3dFx.js), loaded on first use ─────────────────────
// A layer with no 3D effect never imports the module; one that has one draws
// plain for the frame that started the import and repaints when it lands.
let fxModule = null;
let fxModulePromise = null;
function modelFxModule() {
  if (fxModule) return fxModule;
  if (!fxModulePromise) {
    fxModulePromise = import('./model3dFx')
      .then((m) => { fxModule = m; notifyModelAssetLoaded(); })
      .catch(() => { fxModulePromise = null; });
  }
  return null;
}

/**
 * What the model's held pose was made from (entry.pose). Records this call's inputs and
 * says whether they are the held ones. Per frame: a new frameToken always poses again,
 * so an edit between frames can never reuse a stale pose.
 */
function samePoseInputs(entry, frameToken, config, prs, rig, W, H, time) {
  const held = entry.poseInputs || (entry.poseInputs = []);
  let i = 0;
  let same = frameToken != null;
  const keep = (v) => { if (held[i] !== v) { held[i] = v; same = false; } i += 1; };
  keep(frameToken); keep(config); keep(time); keep(W); keep(H);
  keep(prs?.px); keep(prs?.py); keep(prs?.pz); keep(prs?.rx); keep(prs?.ry); keep(prs?.rz);
  keep(prs?.sx); keep(prs?.sy); keep(prs?.sz);
  keep(rig?.cyclorama?.shape); keep(rig?.cyclorama?.y);
  return same;
}

/**
 * Where a model is this frame: fit + anchor, the layer transform, its glTF animation
 * and rig-floor placement. Everything a shadow map needs to see the model, and
 * nothing that draws.
 *
 * With a Rig a model is posed twice a frame — the prepass (poseModelLayer) for the
 * shared shadow map, then its own pass — with the same inputs: the second call gets
 * the held pose instead of evaluating the mixer and the floor bounding box again.
 */
function poseModel(entry, item, config, prs, rig, W, H, time, frameToken) {
  if (samePoseInputs(entry, frameToken, config, prs, rig, W, H, time) && entry.pose) return entry.pose;
  entry.pose = null;
  // Fit + anchor on the inner group.
  const fit = computeFit(entry.box, config, W, H);
  entry.inner.position.copy(fit.offset).multiplyScalar(fit.scale);
  entry.inner.scale.setScalar(fit.scale);
  // Publish the fitted footprint so the transform gizmo can size its selection box —
  // the only thing outside this module that needs to know how big a model draws.
  setModelFootprint(item.id, fit.size.x * fit.scale, fit.size.y * fit.scale);

  // Layer transform on the outer group. `prs` is the canonical shape the shared
  // evaluator hands every render path (keyframeParenting.localPrs): px/py/pz in world
  // pixels, rx/ry/rz already in RADIANS with the editor's sign convention, sx/sy/sz.
  // Unlike a plane layer — whose z-scale is meaningless and pinned to 1 — a solid
  // scales on all three axes, so it uses sz too.
  const base = config.baseRotation || { x: 0, y: 0, z: 0 };
  const D2R = Math.PI / 180;
  entry.outer.position.set(prs?.px || 0, prs?.py || 0, prs?.pz || 0);
  entry.outer.rotation.set(
    (prs?.rx || 0) - (base.x || 0) * D2R,
    (prs?.ry || 0) - (base.y || 0) * D2R,
    (prs?.rz || 0) - (base.z || 0) * D2R,
    'XYZ'
  );
  const sx = Number.isFinite(prs?.sx) && prs.sx > 0 ? prs.sx : 1;
  const sy = Number.isFinite(prs?.sy) && prs.sy > 0 ? prs.sy : sx;
  const sz = Number.isFinite(prs?.sz) && prs.sz > 0 ? prs.sz : sx;
  entry.outer.scale.set(sx, sy, sz);

  // Animation, sampled by ABSOLUTE time. A delta-driven mixer is a function of frame
  // pacing, which would make export frames drift from preview and scrubbing
  // irreproducible. Before the floor box, so the box is THIS frame's animated pose
  // (sampled after it, one pose lagged the animation by a frame).
  applyModelAnimation(entry, config.animation, time);

  // A model is part of the set, so by default its lowest rendered point rests on
  // the cyclorama floor. Evaluate the real geometry after fit, rotation and scale;
  // preset assets have wildly different pivots, which is why a fixed offset made
  // some devices float. `prs.py` remains a lift above the set, and "Free" in the
  // inspector restores unconstrained placement.
  if (rig && config.placeOnRigFloor !== false && CYC_FLOOR_SHAPES.has(rig.cyclorama?.shape)) {
    entry.outer.updateMatrixWorld(true);
    _box.setFromObject(entry.root);
    if (Number.isFinite(_box.min.y)) {
      const floorY = -H * 0.42 + (rig.cyclorama?.y || 0);
      entry.outer.position.y += floorY + (prs?.py || 0) - _box.min.y;
    }
  }
  entry.pose = { fit, sx, sy, sz };
  return entry.pose;
}

/**
 * Pose a model for this frame WITHOUT drawing it (engine: before the channel loop).
 *
 * The Rig's shadow map is rendered once per frame, by the frame's first 3D pass.
 * Each model used to be posed only in its own pass, so a model on a later channel
 * was still in LAST frame's pose when that map was made: in playback its shadow on
 * everything drawn before it trailed it by a frame. Same opts as renderModelLayer;
 * only meaningful with a rig.
 */
export function poseModelLayer(opts) {
  const { item, clip, prs, W, H, time } = opts;
  if (!opts.rig) return;
  const { ready, entry } = ensureModelInstance(item, clip);
  if (!ready || !entry) return;
  const rig = normalizeRig(opts.rig);
  const world = ensureSharedWorld();
  joinWorld(world, `m:${item.id}`, entry.outer, entry.scene);
  const config = item?.model3dConfig || {};
  setShadowFlags(entry.outer, config.castShadow !== false, config.receiveShadow !== false, true);
  poseModel(entry, item, config, prs, rig, W, H, time, opts.frameToken);
  entry.lastFrameToken = opts.frameToken ?? 0;
}

export function renderModelLayer(renderer, opts) {
  const { item, clip, pose, prs, W, H, width, height, time } = opts;
  const { ready, entry, error } = ensureModelInstance(item, clip);
  if (!ready || !entry) return { texture: null, viewDistance: null, error };
  ensureShadowType(renderer);
  // Which models contribute to this frame’s shared contact capture.
  entry.lastFrameToken = opts.frameToken ?? 0;

  const config = item?.model3dConfig || {};
  ensureTargets(entry, Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));

  // With a Rig layer the model joins the SHARED world, so its shadow lands on the
  // cyclorama and on every other model. Without one it keeps its own scene and its
  // own environment — the fallback that makes the whole rig feature additive.
  const rig = opts.rig ? normalizeRig(opts.rig) : null;
  const world = rig ? ensureSharedWorld() : null;
  const passLayer = joinWorld(world, `m:${item.id}`, entry.outer, entry.scene);
  const scene = world ? world.scene : entry.scene;

  // Environment: applied once ready. Until then the three lights carry the frame, so a
  // model is visible (if flatter) rather than black while the HDR streams in.
  //
  // In the shared world the RIG's environment is authoritative — one set, one
  // environment, which is the point of the feature. Per-model `env.hdr` is honoured
  // only on the legacy path, where each model still owns its scene.
  if (world) {
    const envUrl = resolveEnvUrl(rig.env);
    const shared = envUrl ? environmentForUrl(renderer, envUrl) : null;
    if (shared?.status === 'ready' && (world.envKey !== envUrl || scene.environment !== shared.texture)) {
      scene.environment = shared.texture;
      world.envKey = envUrl;
    } else if (world.envKey !== envUrl || !envUrl) {
      // Do not show the previously selected HDR while its replacement is loading.
      // On reflective presets that stale light reads like a baked-in texture.
      scene.environment = null;
      world.envKey = envUrl;
    }
    scene.environmentIntensity = rig.env.intensity;
    scene.environmentRotation?.set?.(
      (rig.env.rotX * Math.PI) / 180,
      (rig.env.rotY * Math.PI) / 180,
      (rig.env.rotZ * Math.PI) / 180
    );
  } else {
    const envName = config.env?.hdr || 'potsdamer_platz_1k';
    const env = environmentFor(renderer, envName);
    // Identity-checked EVERY frame (not just on name change): a rebuilt env cache
    // (context restore) mints a new texture that must reach every entry's scene,
    // or intensity/rotation silently stop doing anything.
    if (env.status === 'ready' && (entry.envKey !== envName || scene.environment !== env.texture)) {
      scene.environment = env.texture;
      entry.envKey = envName;
    } else if (entry.envKey !== envName) {
      scene.environment = null;
      entry.envKey = envName;
    }
    scene.environmentIntensity = Number.isFinite(config.env?.intensity) ? config.env.intensity : 1;
    scene.environmentRotation?.set?.(0, ((config.env?.rotation || 0) * Math.PI) / 180, 0);
  }

  // Lights, from the rig definition. Written EVERY frame and immediately before
  // this pass draws, which is what keeps per-layer looks independent while the
  // objects themselves are reused — and it is the discipline the shared world scene
  // depends on, since scene.environment and the light set are scene-level in three
  // but per-layer here.
  // A project Rig layer lights every model in the scene; without one the layer's own
  // model3dConfig does, exactly as it always has.
  syncLightsToScene(world ? world.lightRig : entry.lightRig, rig ? rig.lights : rigLightsForConfig(config));
  // Models are real solids and participate when a shared Rig world exists, unless
  // the layer opts out (model3dConfig.castShadow / receiveShadow, both default on).
  // Blended cards inside a model (a baked contact-shadow blob, a glow) never cast.
  if (world) setShadowFlags(entry.outer, config.castShadow !== false, config.receiveShadow !== false, true);
  // Ground occlusion joins with the world: a model on its own (no rig) has no floor.
  if (world && !entry.groundAO) { applyGroundAO(entry.root); entry.groundAO = true; }
  const hasRigFloor = !!(rig && CYC_FLOOR_SHAPES.has(rig.cyclorama?.shape));
  // Remembered for the world view, which borrows this model's geometry into a
  // scene of its own and has to light it the same way (attachModelToScene).
  entry.lastConfig = config;

  // Screen artwork on a preset device, if it has a screen and the user set one.
  if (!entry.laneKey) entry.laneKey = `scr:${entry.itemId}:device`;
  applyScreen(entry, modelScreenTarget(item), config.screen || null, time);
  // Media on named meshes of any model (model3dConfig.screens).
  applyModelScreens(entry, config.screens, time);
  // Screen depth bias at this pass's size (see SCREEN_DEPTH_BIAS).
  scaleScreenDepthBias(entry, entry.hdr.height);
  // Self-lit screens that opt in still take the rig's shadows (screens[].receiveShadow).
  syncScreenShadows(entry, config, world && rig?.shadows?.mode === 'map' ? world : null, rig);
  // A procedural shape's colour (model3dConfig.primitive.color).
  if (entry.tintMaterials?.length) {
    const tintColor = config.primitive?.color || PRIMITIVE_DEFAULT_COLOR;
    if (entry.tintColor !== tintColor) {
      for (const m of entry.tintMaterials) m.color.set(tintColor);
      entry.tintColor = tintColor;
    }
  }

  // Standalone layers retain their optional blob. A rig owns all floor contacts,
  // including free-positioned models, so no model pass writes a translucent floor
  // plane into the depth compositor (the source of invisible/white contact plates).
  applyContactShadow(entry, hasRigFloor ? { enabled: false } : config.shadow);

  // Fit, layer transform, floor placement and animation (poseModel).
  const { fit, sx, sy, sz } = poseModel(entry, item, config, prs, rig, W, H, time, opts.frameToken);
  if (rig) {
    // Shared by every model's injected material — the floor is the rig's.
    GROUND_AO.uGroundAoY.value = -H * 0.42 + (rig.cyclorama?.y || 0);
    GROUND_AO.uGroundAoFade.value = H * 0.075;
    GROUND_AO.uGroundAoOn.value = rig.shadows?.mode !== 'off' && CYC_FLOOR_SHAPES.has(rig.cyclorama?.shape) ? 1 : 0;
  } else {
    GROUND_AO.uGroundAoOn.value = 0;
  }

  // Grow Fill in REAL 3D: per-vertex surface arrival attribute + injected
  // materials (model3dGrowFill.js). null cleanly restores the originals.
  applyModelGrowFill(entry, opts.growFill || null, renderer);

  scene.updateMatrixWorld(true);

  // Pass camera: the forward pose, with camZoom folded into an effective FOV.
  const proxy = pose ? cameraProxyFromPose(pose, W, H) : null;
  const cam = entry.camera || (entry.camera = new THREE.PerspectiveCamera(28, 1, 1, 100000));
  // In the shared world this camera films ONLY this model's private layer, so the
  // pass still returns one object's pixels even though the scene holds the whole set.
  if (world) cam.layers.set(passLayer); else cam.layers.set(0);
  const D = proxyDistance(W, H);
  if (proxy) {
    cam.position.copy(proxy.position);
    cam.quaternion.copy(proxy.quaternion);
    cam.fov = proxy.fov;
  } else {
    cam.position.set(0, 0, D);
    cam.quaternion.identity();
    cam.fov = 28;
  }
  cam.aspect = W / H;
  // The compositor's near/far, so this pass's depth buffer is directly comparable with
  // the depth the rest of the frame is tested against. Falls back to a sane pair when
  // the caller doesn't care (the standalone harnesses).
  cam.near = Number.isFinite(opts.near) && opts.near > 0 ? opts.near : Math.max(1, D * 0.001);
  cam.far = Number.isFinite(opts.far) && opts.far > cam.near ? opts.far : D * 20;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);

  // View-space distance of the model's bounding-box centre, for DOF.
  _box.setFromObject(entry.outer);
  _box.getCenter(_center);
  _viewCenter.copy(_center).applyMatrix4(cam.matrixWorldInverse);
  const viewDistance = -_viewCenter.z;
  const viewRange = boxViewRange(_box, cam);

  // ── Draw. The renderer is shared, so every piece of state touched here is saved
  // and restored; the composite loop runs with autoClear = false and depends on it.
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevClearAlpha = renderer.getClearAlpha();

  const sh = world ? prepareWorldShadows(world, rig, opts.frameToken ?? 0, H, pcssActive, cam) : null;

  renderer.autoClear = false;
  renderer.setRenderTarget(entry.hdr);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  // Shadows wrap ONLY this call — never the tone pass below, which is an unlit
  // full-screen triangle and would gain a program variant for nothing.
  if (world) {
    withWorldShadows(renderer, sh, world, scene, cam, () => renderer.render(scene, cam));
  } else {
    renderer.render(scene, cam);
  }

  // Real-3D effects run HERE, on the lit HDR picture, while the camera, the depth
  // buffer and the scene still know the surface (model3dFx.js). Nothing live →
  // the module is never touched and the tone pass reads the HDR target as always.
  let toneSource = entry.hdr.texture;
  let spillDepth = -1;
  if (opts.fx3d?.length) {
    const fx = modelFxModule();
    // The model's normalised max extent (1.0 in the effects' model space) in
    // composition px — what turns an effect's px sizes into surface units.
    const fitPx = Math.max(fit.size.x, fit.size.y, fit.size.z) * fit.scale * Math.max(sx, sy, sz);
    // The tone pass's exposure below, for effects that judge the DISPLAYED light (Bloom's threshold).
    const exposure = rig ? rig.env.exposure : (Number.isFinite(config.env?.exposure) ? config.env.exposure : 1);
    const out = fx ? fx.runModelFx(renderer, entry, { scene, cam, list: opts.fx3d, time: opts.time || 0, W, H, viewDistance, fitPx, exposure }) : null;
    if (out) toneSource = out;
    // Light the effects put PAST the silhouette has no surface depth, and the
    // compositor's depth pass drops such pixels (nothing of a plain model lives
    // there). Hand it the depth of the model's centre for them instead — the
    // same rule an ordinary layer's spilled glow follows.
    if (out && entry.fx?.spill) {
      _spillNdc.copy(_viewCenter).applyMatrix4(cam.projectionMatrix);
      const z = cam.coordinateSystem === THREE.WebGPUCoordinateSystem ? _spillNdc.z : _spillNdc.z * 0.5 + 0.5;
      spillDepth = Math.min(1, Math.max(0, z));
    }
  } else if (entry.fx && fxModule) {
    fxModule.releaseModelFx(entry);
  }

  // Opaque + transparent depth, for the compositor and DOF (see renderTransparentDepth).
  const transparentDepthTexture = renderTransparentDepth(renderer, entry, scene, cam);

  // Self-lit screens keep their media's own colours (see renderScreenMask).
  const screenMeshes = screenMeshesOf(entry);
  const screenMask = screenMeshes.length ? renderScreenMask(renderer, entry, scene, cam, screenMeshes) : null;
  if (!screenMeshes.length && entry.screenMask) { entry.screenMask.dispose(); entry.screenMask = null; }

  const { toneMesh: tm, toneScene: ts, toneCamera: tc } = ensureTonePass();
  tm.material.uniforms.uTexture.value = toneSource;
  tm.material.uniforms.uResolution.value.set(entry.ldr.width, entry.ldr.height);
  if (tm.material.uniforms.uScreenMask) {
    tm.material.uniforms.uScreenMask.value = screenMask;
    tm.material.uniforms.uScreenMaskOn.value = screenMask ? 1 : 0;
  }
  // The rig owns exposure once there is one; otherwise the layer's own env does.
  tm.material.uniforms.uExposure.value = rig
    ? rig.env.exposure
    : (Number.isFinite(config.env?.exposure) ? config.env.exposure : 1);
  renderer.setRenderTarget(entry.ldr);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(ts, tc);

  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  renderer.setClearColor(prevClear, prevClearAlpha);

  return {
    texture: entry.ldr.texture, depthTexture: entry.hdr.depthTexture, transparentDepthTexture,
    viewDistance, viewRange, spillDepth, error: null,
  };
}

// ── The Rig layer's own pass ────────────────────────────────────────────────
//
// The cyclorama is drawn HERE, as one layer of its own, and NOT inside each model's
// pass. It looked cheaper to fold it in — the model then stands on it inside a single
// scene — but that version was wrong in two ways that only show up with a real
// project on the timeline:
//
//   * with no model layer, nothing drew the cyclorama at all, even though the rig
//     clip is on the timeline and the panel shows its size and colour;
//   * with TWO model layers it was drawn twice and composited twice, so the backdrop
//     came out at double coverage where the two passes overlapped.
//
// As its own layer it draws exactly once, and it occludes correctly because it hands
// back a depth texture: the compositor already sorts channels by view depth and cuts
// them against a 3D layer's real surface (stampModelDepth), which is the same
// mechanism a model layer relies on.
//
// One instance, not one per item: the rig is a project singleton.
let rigInstance = null;

function ensureRigInstance() {
  if (rigInstance) return rigInstance;
  // The cyclorama lives in the SHARED world, not in a scene of its own: that is what
  // puts it in the same shadow map as every model, so a model's shadow lands on it.
  // Its own pass films it through a private layer, so it still returns one object's
  // pixels for the compositor.
  const world = ensureSharedWorld();
  rigInstance = {
    cyc: { scene: world.scene, mesh: null, mat: null, sig: null },
    camera: null,
    hdr: null,
    ldr: null,
  };
  return rigInstance;
}

export function disposeRigLayer() {
  if (!rigInstance) return;
  rigInstance.contacts?.dispose();
  if (rigInstance.cyc.mesh) {
    rigInstance.cyc.mesh.userData.__disposed = true;
    rigInstance.cyc.mesh.removeFromParent();
  }
  rigInstance.cyc.mesh?.geometry?.dispose();
  rigInstance.cyc.mat?.dispose();
  rigInstance.hdr?.dispose();
  rigInstance.ldr?.dispose();
  releaseWorldLayer(sharedWorld, 'cyc');
  rigInstance = null;
}

/**
 * Draw the rig's cyclorama as a layer.
 *
 * Same contract as renderModelLayer: `{ texture, depthTexture, viewDistance }`, so
 * the compositor treats it exactly as it treats a model — full opacity, blend mode,
 * mask, effects and depth-of-field all work on the returned texture.
 *
 * Returns a null texture when the rig has no cyclorama (`shape: 'none'`), which is
 * the default: a rig added only for its lights must not put a plate on screen.
 */
export function renderRigLayer(renderer, opts) {
  const { rig, pose, W, H, width, height } = opts;
  ensureShadowType(renderer);
  const norm = normalizeRig(rig || {});
  const cyc = norm.cyclorama;
  if (!cyc || cyc.shape === 'none') {
    // `syncCyclorama` is normally what hides the existing mesh. Returning before it
    // left the last shape alive in the 3D world view after choosing None.
    if (rigInstance?.cyc) syncCyclorama(rigInstance.cyc, cyc, H);
    return { texture: null, depthTexture: null, viewDistance: null };
  }

  const entry = ensureRigInstance();
  const world = ensureSharedWorld();
  const scene = world.scene;
  ensureTargets(entry, Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));

  // Environment, URL-keyed. Identity-checked every frame for the same reason the
  // model path is: a context restore mints a new texture that has to reach this
  // scene, or intensity and rotation silently stop doing anything.
  const envUrl = resolveEnvUrl(norm.env);
  const env = envUrl ? environmentForUrl(renderer, envUrl) : null;
  if (env?.status === 'ready' && (world.envKey !== envUrl || scene.environment !== env.texture)) {
    scene.environment = env.texture;
    world.envKey = envUrl;
  } else if (world.envKey !== envUrl || !envUrl) {
    scene.environment = null;
    world.envKey = envUrl;
  }
  scene.environmentIntensity = norm.env.intensity;
  // Full 3 axes, not the Y-only call the legacy per-model path uses. Render-time
  // state on the scene — it does not touch the PMREM bake, so the cache key stays
  // one string.
  scene.environmentRotation?.set?.(
    (norm.env.rotX * Math.PI) / 180,
    (norm.env.rotY * Math.PI) / 180,
    (norm.env.rotZ * Math.PI) / 180
  );

  syncLightsToScene(world.lightRig, norm.lights);
  syncCyclorama(entry.cyc, cyc, H);
  // The backdrop RECEIVES but does not CAST: a cyclorama casting into its own
  // shadow map is self-shadowing acne and nothing else, and it is also the one
  // surface a caster cap should never be spent on.
  const cycMat = norm.cyclorama.material || {};
  setShadowFlags(
    entry.cyc.mesh,
    cycMat.mode === 'shadowCatcher' ? false : cycMat.castShadow === true,
    cycMat.receiveShadow !== false
  );
  const passLayer = joinWorld(world, 'cyc', entry.cyc.mesh, scene);
  scene.updateMatrixWorld(true);
  if (CYC_FLOOR_SHAPES.has(cyc.shape)) {
    if (!entry.contacts) entry.contacts = createRigContactShadows(makeMaterial.rigContactPasses());
    entry.cyc.mesh.add(entry.contacts.mesh);
    const roots = [...instances.values()]
      .filter((model) => model.outer.parent === scene && model.lastFrameToken >= (opts.frameToken ?? 0) - 1)
      .map((model) => model.root);
    entry.contacts.update(renderer, scene, entry.cyc.mesh, roots, {
      H, mode: norm.shadows.mode, layer: passLayer,
      opacity: cycMat.receiveShadow === false ? 0 : (cycMat.opacity ?? 1),
      color: cycMat.mode === 'shadowCatcher' ? cycSurfaceColor(cycMat) : '#000000',
    });
  } else if (entry.contacts) entry.contacts.mesh.visible = false;

  const proxy = pose ? cameraProxyFromPose(pose, W, H) : null;
  const cam = entry.camera || (entry.camera = new THREE.PerspectiveCamera(28, 1, 1, 100000));
  const D = proxyDistance(W, H);
  if (proxy) {
    cam.position.copy(proxy.position);
    cam.quaternion.copy(proxy.quaternion);
    cam.fov = proxy.fov;
  } else {
    cam.position.set(0, 0, D);
    cam.quaternion.identity();
    cam.fov = 28;
  }
  cam.aspect = W / H;
  cam.layers.set(passLayer);
  cam.near = Number.isFinite(opts.near) && opts.near > 0 ? opts.near : Math.max(1, D * 0.001);
  // A cyclorama is thousands of pixels deep, so it needs the compositor's own far
  // plane rather than a model's tighter default — clipped at the back it reads as a
  // hole in the set.
  cam.far = Number.isFinite(opts.far) && opts.far > cam.near ? opts.far : D * 20;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);

  _box.setFromObject(entry.cyc.mesh);
  _box.getCenter(_center);
  _viewCenter.copy(_center).applyMatrix4(cam.matrixWorldInverse);
  const viewDistance = -_viewCenter.z;
  const viewRange = boxViewRange(_box, cam);

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevClearAlpha = renderer.getClearAlpha();

  // Refitted here because this pass re-renders the map anyway (forcePrime below).
  const sh = prepareWorldShadows(world, norm, opts.frameToken ?? 0, H, pcssActive, cam, true);
  if (cycMat.mode === 'shadowCatcher') {
    // ShadowMaterial otherwise turns a fully blocked key into pure black even
    // when fill lights and the HDR still illuminate the ground. Estimate the
    // fraction of illumination that can be blocked; authored strength stays a
    // multiplier, with contact occlusion supplying the tight ambient grounding.
    let total = Math.max(0, norm.env.intensity || 0), casting = 0;
    for (const { obj, shadowObj, light } of world.lightRig.byLid.values()) {
      if (!light.on) continue;
      const energy = Math.max(0, light.intensity || 0);
      total += energy;
      // An area light's companion carries only its share of the light.
      if ((shadowObj || obj).castShadow) casting += shadowObj ? energy * AREA_SHADOW_SHARE : energy;
    }
    entry.cyc.mat.opacity = (cycMat.opacity ?? 1) * (total > 0 ? casting / total : 1);
  }

  renderer.autoClear = false;
  renderer.setRenderTarget(entry.hdr);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  // The rig pass is the final shared-world pass in the stack. Prime again here so
  // animated model/shape transforms authored earlier in this frame reach the
  // cyclorama immediately rather than one frame later.
  withWorldShadows(renderer, sh, world, scene, cam, () => renderer.render(scene, cam), true);

  const { toneMesh: tm, toneScene: ts, toneCamera: tc } = ensureTonePass();
  tm.material.uniforms.uTexture.value = entry.hdr.texture;
  tm.material.uniforms.uResolution.value.set(entry.ldr.width, entry.ldr.height);
  tm.material.uniforms.uExposure.value = norm.env.exposure;
  if (tm.material.uniforms.uScreenMaskOn) tm.material.uniforms.uScreenMaskOn.value = 0;
  renderer.setRenderTarget(entry.ldr);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(ts, tc);

  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  renderer.setClearColor(prevClear, prevClearAlpha);

  return {
    texture: entry.ldr.texture,
    // A shadow catcher is intentionally invisible except for shadow coverage. Its
    // physical surface must not become an invisible wall in the 2D compositor.
    depthTexture: cycMat.mode === 'shadowCatcher' ? null : entry.hdr.depthTexture,
    viewDistance,
    viewRange,
    error: null,
  };
}

// The camera distance the comp's PerspectiveCamera sits at (FOV 28 over a composition
// H pixels tall). Kept local so this module never has to import Player.
function proxyDistance(W, H) {
  return (H * 0.5) / Math.tan((28 * Math.PI) / 180 / 2);
}

/** Drive the mixer to an absolute clip-local time, honouring speed/offset/loop. */
// A clip's local time for this playhead, by the layer's loop mode. 'once' stops a hair
// before the end: three wraps an action that sits EXACTLY on its duration back to frame 0.
function modelClipTime(t, dur, mode) {
  if (!(dur > 0)) return 0;
  if (mode === 'loop') return ((t % dur) + dur) % dur;
  if (mode === 'pingpong') {
    const cycle = ((t % (dur * 2)) + dur * 2) % (dur * 2);
    return cycle <= dur ? cycle : dur * 2 - cycle;
  }
  return Math.max(0, Math.min(dur - 1e-4, t));
}

export function applyModelAnimation(entry, animation, time) {
  if (!entry?.mixer || !entry.animations.length) return;
  const name = animation?.clip || null;
  // '*' plays EVERY clip at once — a scene exported with one action per object
  // (Blender's glTF exporter) animates as a whole, each clip on its own length.
  const clipDefs = name === '*'
    ? entry.animations
    : (name ? entry.animations.filter((a) => a.name === name).slice(0, 1) : []);
  if (!clipDefs.length) {
    for (const a of entry.activeActions || []) a.stop();
    entry.activeActions = null;
    if (entry.activeAction) { entry.activeAction.stop(); entry.activeAction = null; }
    return;
  }
  const want = clipDefs.map((clipDef) => {
    let action = entry.actions.get(clipDef.name);
    if (!action) {
      action = entry.mixer.clipAction(clipDef);
      entry.actions.set(clipDef.name, action);
    }
    return action;
  });
  for (const a of entry.activeActions || []) if (!want.includes(a)) a.stop();
  if (entry.activeAction && !want.includes(entry.activeAction)) entry.activeAction.stop();
  for (const action of want) if (!action.isRunning()) { action.reset(); action.play(); }
  entry.activeActions = want;
  entry.activeAction = want[0];

  const speed = Number.isFinite(animation?.speed) ? animation.speed : 1;
  const offset = Number.isFinite(animation?.offset) ? animation.offset : 0;
  const mode = animation?.loop || 'loop';
  const t = (Number(time) || 0) * speed + offset;
  // The pose must be a pure function of the playhead: every action is placed at its
  // own clip time and the mixer is evaluated once, never advanced by a delta.
  for (const action of want) action.time = modelClipTime(t, action.getClip().duration || 0, mode);
  entry.mixer.update(0);
}

// ── World view ──────────────────────────────────────────────────────────────
// The 3D view renders the editor's shared scene, where a model layer is represented
// by the flat quad carrying its rendered image. That billboard is exactly the wrong
// thing to judge depth against while framing a camera move, so world view borrows the
// REAL geometry instead.
//
// `outer` is moved rather than cloned — an Object3D has one parent, and a second copy
// would double the memory of an already heavy asset. Its lights come along (a
// MeshStandardMaterial with no light and no environment renders black) and the caller
// gets a function that puts everything back exactly as it was.
/** The layer's real geometry group, for the 3D view's gizmo and selection box. */
export function getModelObject(itemId) {
  return instances.get(itemId)?.outer || null;
}

/** Same, for a flat plate that is filmed before the compositor sees it. */
export function getPlateObject(itemId) {
  return plateInstances.get(itemId)?.outer || null;
}

/**
 * Lend a filmed plate's real plane to the 3D view, for exactly the reason a model
 * is lent: the quad the compositor holds is a full-frame billboard standing at the
 * origin, so leaving it there would show the layer in the wrong place, at the wrong
 * size, already carrying the project camera's perspective.
 *
 * No light rig is borrowed. The plate's own material paints the artwork and reads
 * the shadow mask; it does not need the scene to be lit to be visible.
 */
export function attachPlateToScene(itemId, scene) {
  const entry = plateInstances.get(itemId);
  if (!entry || !scene || entry.outer.parent === scene) return null;
  const home = entry.outer.parent || entry.scene;
  entry.outer.userData.__borrowed = true;
  scene.add(entry.outer);
  return () => {
    entry.outer.userData.__borrowed = false;
    if (!entry.outer.userData.__disposed && home) home.add(entry.outer);
    else entry.outer.removeFromParent();
  };
}

// ── Grow Fill seed picking / projection ─────────────────────────────────────
// The model plate fills the frame 1:1 (its camera already carries the project
// pose), so frame uv ↔ this pass's NDC directly. Seeds are stored ROOT-LOCAL,
// which survives layer transforms, fit modes and comp resizes.
const _seedRaycaster = new THREE.Raycaster();
const _seedNdc = new THREE.Vector2();
const _seedVec = new THREE.Vector3();

/** Raycast a preview click (frame uv, y down) onto the model surface.
 *  Returns a root-local point { x, y, z } or null on a miss. */
export function pickModelSurface(itemId, u, vDown) {
  const entry = instances.get(itemId);
  if (!entry?.camera || !entry.outer) return null;
  _seedNdc.set(u * 2 - 1, 1 - vDown * 2);
  _seedRaycaster.setFromCamera(_seedNdc, entry.camera);
  const hits = _seedRaycaster.intersectObject(entry.outer, true);
  const hit = hits.find((h) => h.object?.isMesh && h.object !== entry.shadowMesh);
  if (!hit) return null;
  const p = entry.root.worldToLocal(hit.point.clone());
  return { x: p.x, y: p.y, z: p.z };
}

/** Project a root-local seed point back to frame uv (y down) for the overlay's
 *  markers. Returns { x, y } in 0..1 or null while the pass hasn't run yet. */
export function projectModelPoint(itemId, point) {
  const entry = instances.get(itemId);
  if (!entry?.camera || !entry.root) return null;
  _seedVec.set(Number(point?.x) || 0, Number(point?.y) || 0, Number(point?.z) || 0);
  entry.root.localToWorld(_seedVec);
  _seedVec.project(entry.camera);
  if (!Number.isFinite(_seedVec.x) || Math.abs(_seedVec.z) > 1) return null;
  return { x: _seedVec.x * 0.5 + 0.5, y: 1 - (_seedVec.y * 0.5 + 0.5) };
}

// The world view borrows every model's real geometry into ONE scene. Its lighting
// therefore has to be lent once, not once per model: the previous version handed
// over each instance's own three lights, so two model layers lit the world view
// with 2x the rig and it read visibly brighter than the render. Three models, 3x.
//
// This rig belongs to the borrowing scene, not to any instance — it is created on
// the first attach and torn down when the last model goes home.
const worldLightRigs = new WeakMap();   // borrowing scene → { rig, refs }

export function attachModelToScene(itemId, scene) {
  const entry = instances.get(itemId);
  if (!entry || !scene || entry.outer.parent === scene) return null;
  const home = entry.outer.parent || entry.scene;

  let lent = worldLightRigs.get(scene);
  if (!lent) {
    lent = {
      rig: makeLightRig(scene),
      refs: 0,
      exposure: Number.isFinite(entry.lastConfig?.env?.exposure) ? entry.lastConfig.env.exposure : 1,
      prevEnv: scene.environment,
      prevIntensity: scene.environmentIntensity,
      prevRotation: scene.environmentRotation?.clone?.() || null,
    };
    worldLightRigs.set(scene, lent);
  }
  lent.refs += 1;

  entry.outer.userData.__borrowed = true;
  scene.add(entry.outer);
  // One rig for the whole borrowing scene, lit from the FIRST model to arrive.
  // Re-syncing on every attach would instead make it the last, which flips the
  // world view's brightness whenever attach order changes (channel reorder, a clip
  // scrolling into range) for no reason the user could predict. With several models
  // carrying different rigs there is no single right answer until the Rig layer
  // makes lighting a project-level thing — stable beats arbitrary until then.
  if (lent.refs === 1) {
    syncLightsToScene(lent.rig, rigLightsForConfig(entry.lastConfig || {}));
    lent.exposure = Number.isFinite(entry.lastConfig?.env?.exposure) ? entry.lastConfig.env.exposure : 1;
  }
  if (entry.scene.environment) {
    scene.environment = entry.scene.environment;
    scene.environmentIntensity = entry.scene.environmentIntensity;
  }

  return () => {
    entry.outer.userData.__borrowed = false;
    if (!entry.outer.userData.__disposed && home) home.add(entry.outer);
    else entry.outer.removeFromParent();
    const held = worldLightRigs.get(scene);
    if (!held) return;
    held.refs -= 1;
    if (held.refs > 0) return;
    // Last model home: take the borrowed lighting with it, or the next thing to
    // use this scene inherits a rig nobody owns.
    disposeLightRig(held.rig);
    scene.environment = held.prevEnv;
    scene.environmentIntensity = held.prevIntensity;
    if (held.prevRotation) scene.environmentRotation?.copy?.(held.prevRotation);
    worldLightRigs.delete(scene);
  };
}

// ── Disposal ────────────────────────────────────────────────────────────────
// Dispose ONLY what this instance owns.
//
// SkeletonUtils.clone copies the node graph but SHARES geometries and materials with
// the parsed asset in the cache. Walking the clone and disposing those destroys the
// shared originals, so every later instance of that asset — including the one created
// a moment later when the user switches device — renders nothing. That was the
// "switching model stops working" bug.
function disposeInstance(entry) {
  if (!entry) return;
  entry.outer.userData.__disposed = true;
  entry.outer.removeFromParent();
  releaseWorldLayer(sharedWorld, `m:${entry.itemId}`);
  entry.hdr?.dispose();
  entry.ldr?.dispose();
  entry.tdepth?.dispose();
  entry.tdepth = null;
  entry.screenMask?.dispose();
  entry.screenMask = null;
  // Real-3D effect targets (surface buffers, ping-pong, halo pyramid).
  if (entry.fx) fxModule?.releaseModelFx(entry);
  entry.mixer?.stopAllAction();
  // Grow Fill's injected materials + aliased geometries (restores originals).
  removeModelGrowFill(entry);
  // Materials we created to replace an authored one (screen artwork).
  for (const [mesh, original] of entry.screenOriginals || []) {
    if (mesh.material && mesh.material !== original) mesh.material.dispose?.();
    mesh.material = original;
  }
  entry.screenOriginals = null;
  // Screen-shadow twins share the screen's geometry; only their material is ours.
  for (const overlay of entry.screenShadows?.values() || []) overlay.removeFromParent();
  entry.screenShadows = null;
  entry.screenShadowMat?.dispose();
  entry.screenShadowMat = null;
  // The contact shadow's plane and material are ours alone.
  if (entry.shadowMesh) {
    entry.shadowMesh.geometry?.dispose?.();
    entry.shadowMesh.material?.dispose?.();
    entry.shadowMesh.parent?.remove(entry.shadowMesh);
    entry.shadowMesh = null;
  }
  entry.screenSurface = null;
  // A shape's per-layer materials are ours; its geometry belongs to the asset.
  for (const m of entry.tintMaterials || []) m.dispose();
  entry.tintMaterials = null;

  // Lights are ours: they were created by syncLightsToScene, not cloned from the
  // shared asset, so unlike geometry and materials they must be disposed here.
  disposeLightRig(entry.lightRig);
  releaseScreenVideo(entry);
  // Media slots on named meshes (model3dConfig.screens).
  for (const slot of entry.screenSlots || []) releaseScreenState(slot);
  entry.screenSlots = null;
}

function disposePlateInstance(entry) {
  if (!entry) return;
  entry.outer.userData.__disposed = true;
  entry.outer.removeFromParent();
  releaseWorldLayer(sharedWorld, `p:${entry.itemId}`);
  entry.mesh?.geometry?.dispose();
  entry.plateMaterial?.dispose();
  entry.sourceMesh?.geometry?.dispose();
  entry.bake?.dispose();
  entry.hdr?.dispose();
  entry.ldr?.dispose();
}

/** Drop one layer's instance — clip deleted, channel deleted, project switched. */
export function disposeModelLayer(itemId) {
  clearModelFootprint(itemId);
  const entry = instances.get(itemId);
  if (!entry) return;
  disposeInstance(entry);
  instances.delete(itemId);
}

/** Drop every instance still alive, keeping the parsed-asset and env caches. */
export function disposeAllModelLayers() {
  for (const [id, entry] of instances.entries()) {
    clearModelFootprint(id);
    disposeInstance(entry);
  }
  instances.clear();
}

/** Retain only the listed item ids; everything else is disposed. */
export function pruneModelLayers(keepIds) {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds || []);
  for (const id of [...instances.keys()]) {
    if (!keep.has(id)) disposeModelLayer(id);
  }
}

/** Drop one promoted ordinary layer. */
export function disposePlateLayer(itemId) {
  const entry = plateInstances.get(itemId);
  if (!entry) return;
  disposePlateInstance(entry);
  plateInstances.delete(itemId);
}

export function disposeAllPlateLayers() {
  for (const entry of plateInstances.values()) disposePlateInstance(entry);
  plateInstances.clear();
}

export function prunePlateLayers(keepIds) {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds || []);
  for (const id of [...plateInstances.keys()]) {
    if (!keep.has(id)) disposePlateLayer(id);
  }
}

/** Triangle count of a layer's asset — the panel warns above a threshold. */
export function modelTriangleCount(clip, item = null) {
  const url = item ? resolveModelUrl(item, clip) : clip?.url;
  const asset = url ? assets.get(url) : null;
  if (asset?.status !== 'ready' || !asset.scene) return 0;
  let tris = 0;
  asset.scene.traverse((n) => {
    if (!n.isMesh || !n.geometry) return;
    const g = n.geometry;
    tris += g.index ? g.index.count / 3 : (g.attributes?.position?.count || 0) / 3;
  });
  return Math.round(tris);
}

/** The url a layer actually loads — preset or custom. Re-exported so the panel can ask
 *  about the resolved asset without duplicating the resolution rules. */
export function resolveModelUrlFor(item, clip) {
  return resolveModelUrl(item, clip);
}

export function modelAssetState(url) {
  const a = url ? assets.get(url) : null;
  return a ? { status: a.status, error: a.error } : { status: 'idle', error: null };
}

// ── Stand-alone rig stage (Scene Looks previews) ────────────────────────────

/** Ground occlusion values for the NEXT draw — the uniforms are shared, so a caller
 *  rendering its own set (the look previews) sets them right before its render. */
export function setGroundOcclusion(floorY, compH, on = true) {
  GROUND_AO.uGroundAoY.value = floorY;
  GROUND_AO.uGroundAoFade.value = compH * 0.075;
  GROUND_AO.uGroundAoOn.value = on ? 1 : 0;
}

/** Inject ground occlusion into every lit material under `root` (WebGL). */
export function groundOcclude(root) {
  applyGroundAO(root);
}

const AO_CORE = 0.5; // the texture's solid core, as a fraction of its width
let aoTexture = null;
function contactOcclusionTexture() {
  if (aoTexture) return aoTexture;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  const core = size * AO_CORE;
  const o = (size - core) / 2;
  g.filter = `blur(${Math.round(size * 0.075)}px)`;
  g.fillStyle = '#000';
  g.beginPath();
  if (g.roundRect) g.roundRect(o, o, core, core, core * 0.22); else g.rect(o, o, core, core);
  g.fill();
  aoTexture = new THREE.CanvasTexture(c);
  return aoTexture;
}

/** The contact-occlusion texture and the fraction of it that is solid core. */
export function contactOcclusionMap() {
  return { texture: contactOcclusionTexture(), core: AO_CORE };
}

/**
 * The rig's set — lights, cyclorama, shadow setup — built by the SAME code that
 * lights the editor, in a scene of its own, around whatever subject the caller adds.
 * It is what makes a look's preview exactly what applying the look gives. Nothing
 * here touches the shared world.
 *
 * `pcss` must match the renderer the stage is drawn with (BasicShadowMap ⇒ true).
 */
export function createRigStage({ compH = 1080, pcss = PCSS_INSTALLED } = {}) {
  const scene = new THREE.Scene();
  const world = {
    scene,
    lightRig: makeLightRig(scene),
    layerFor: new Map(),
    usedLayers: new Set(),
    revision: 0,
    shadowToken: -1,
    shadowRevision: -1,
    casters: 0,
    hasPlates: false,
  };
  const cyc = { scene, mesh: null, mat: null, sig: null };
  let token = 0;
  return {
    scene,
    floorY: -compH * 0.42,
    apply(rigRaw) {
      const rig = normalizeRig(rigRaw || {});
      syncCyclorama(cyc, rig.cyclorama, compH);
      if (cyc.mesh) {
        // Same rule as renderRigLayer: the set receives unless told not to.
        cyc.mesh.receiveShadow = rig.cyclorama.material?.receiveShadow !== false;
        cyc.mesh.castShadow = false;
      }
      syncLightsToScene(world.lightRig, rig.lights);
      token += 1;
      world.revision += 1;
      scene.updateMatrixWorld(true);
      prepareWorldShadows(world, rig, token, compH, pcss);
      return rig;
    },
    dispose() {
      for (const held of world.lightRig.byLid.values()) {
        held.obj.shadow?.map?.dispose();
        held.shadowObj?.shadow?.map?.dispose();
      }
      disposeLightRig(world.lightRig);
      cyc.mesh?.geometry?.dispose();
      cyc.mat?.dispose();
      scene.clear();
    },
  };
}
