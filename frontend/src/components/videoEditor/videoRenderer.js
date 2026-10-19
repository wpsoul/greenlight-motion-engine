/*
 * The editor's renderer, behind one seam.
 *
 * This is step 1 of html/webgpu-migration/PORT-PLAN.md §4. The renderer choice
 * lives here rather than inline in Player.jsx so the swap is one call site, and
 * so the two rules that make the swap honest live in one place:
 *
 *   1. AVAILABILITY IS AN ADAPTER REQUEST, NOT A PROPERTY. `navigator.gpu` is
 *      truthy on machines where WebGPU cannot actually run (a VM, a blocklisted
 *      driver). Only `await navigator.gpu.requestAdapter()` answers the question,
 *      and it answers it with `null` rather than by throwing.
 *
 *   2. NEVER SILENTLY DEGRADE. `WebGPURenderer` installs its own WebGL2 fallback
 *      backend unconditionally (three.webgpu.js — the constructor overwrites any
 *      `getFallback` you pass), and taking it costs nothing louder than a
 *      console warning. A pipeline that "works" on that fallback is a WebGL
 *      pipeline wearing a WebGPU name: every measurement taken on it is a lie,
 *      and every WebGPU-specific bug it hides comes back on a user's machine.
 *      So after init we assert the backend we actually got and throw if it is
 *      not WebGPU.
 *
 * Both renderers are CONSTRUCTED synchronously — the caller (Player.jsx's init
 * effect) has to hold one and register teardown in a single synchronous pass,
 * and building a `WebGPURenderer` touches no GPU: `init()` does. What is async
 * is readiness, and on WebGPU `render()` THROWS before it, so nothing may paint
 * until `ready` resolves.
 */
import * as THREE from 'three';
import { getPreviewTier } from './previewDeviceTier.js';
import { notePerfRenderer } from './perfRegistry.js';
/*
 * `three/webgpu` IS NOT IMPORTED HERE — it is 1.9 MB of source, and a static
 * import puts it in the editor's chunk for every user, including the ones whose
 * projects will only ever run on WebGL. Loaded on demand by
 * `loadWebGpuBackend()` below instead, which the app awaits exactly where it
 * already waits for the node modules (materialFactory's initMaterialBackend).
 */
let WebGPURenderer = null;
let webGpuModulePromise = null;

/*
 * The adapter `loadWebGpuBackend()` already proved works, handed to `ready` so
 * it does not ask twice. Cleared once consumed — an adapter is not guaranteed to
 * outlive a device request, and a stale one must never be reused silently.
 */
let preflight = null;
let preflightPromise = null;

/**
 * Load the WebGPU renderer class. A no-op on WebGL and idempotent, so it is safe
 * (and correct) to await unconditionally before building a renderer.
 *
 * Separate from `createVideoRenderer` because that one is SYNCHRONOUS by design:
 * the Player builds its scenes, materials and targets in one synchronous pass
 * around it, and making the constructor async would mean unpicking that pass.
 * The load therefore happens earlier, at the same await the node modules use.
 */
export async function loadWebGpuBackend(backend) {
  if (backend !== 'webgpu') return;
  if (!WebGPURenderer) {
    if (!webGpuModulePromise) {
      webGpuModulePromise = import('three/webgpu')
        .then((mod) => {
          WebGPURenderer = mod.WebGPURenderer;
          return WebGPURenderer;
        })
        .catch((err) => {
          webGpuModulePromise = null;
          throw err;
        });
    }
    await webGpuModulePromise;
  }
  /*
   * AND THE ADAPTER CHECK, HERE, BEFORE ANYTHING IS CONSTRUCTED.
   *
   * It used to live only in `ready`, which runs AFTER `new WebGPURenderer()`.
   * That ordering is what made a machine without WebGPU fail impolitely: three's
   * constructor installs a fallback that `init()` invokes on failure, and the
   * fallback asks the canvas for a WebGL2 context it cannot have (the canvas was
   * already configured for WebGPU), so the first thing the user saw was
   * `Cannot read properties of null (reading 'getSupportedExtensions')` from
   * inside three — a stack trace instead of a sentence.
   *
   * Asking first means the answer arrives before a canvas has been claimed, on
   * the one promise the Player already gates its whole build pass on. No
   * renderer is built, nothing throws from inside a library, and the editor
   * shows WEBGPU_REQUIRED_MESSAGE.
   *
   * The adapter is KEPT: `ready` needs one to create the device, and requesting
   * a second one is both wasted work and a second chance to fail differently.
   */
  const generation = activeRendererGeneration;
  if (!preflightPromise || preflightPromise.generation !== generation) {
    const promise = probeWebGpuAdapter();
    preflightPromise = { generation, promise };
  }
  const pending = preflightPromise;
  const probe = await pending.promise;
  if (!probe.ok) {
    if (preflightPromise === pending) preflightPromise = null;
    if (activeRendererGeneration === generation) preflight = null;
    throw unavailable(probe.reason);
  }
  /*
   * A renderer switch can finish while requestAdapter() is outstanding. Never
   * hand that late adapter to a later session: the session that requested it no
   * longer exists, and a fresh WebGPU activation must prove itself again.
   */
  if (activeRenderer === 'webgpu' && activeRendererGeneration === generation) {
    preflight = { generation, probe };
  }
  if (preflightPromise === pending) preflightPromise = null;
}


/**
 * What the user is told when WebGPU was asked for and cannot run. It names
 * WebGPU on purpose — this path is reachable on real hardware (a Windows guest
 * in Parallels has no WebGPU at all), and "something went wrong" plus a stack
 * trace is not an acceptable thing to show there.
 */
export const WEBGPU_REQUIRED_MESSAGE =
  'This video editor needs WebGPU, and this computer cannot provide it. '
  + 'That usually means the graphics driver is too old or is blocked, or the app is '
  + 'running inside a virtual machine. Updating the graphics driver, or running on the '
  + 'host machine rather than in a VM, is what fixes it.';

/**
 * Is WebGPU actually usable here? Resolves to `{ ok, adapter, info, reason }`.
 * Never throws — a missing `navigator.gpu`, a rejected request and a null
 * adapter are all just "no".
 */
export async function probeWebGpuAdapter() {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return { ok: false, adapter: null, info: null, reason: 'navigator.gpu is not present' };
  }
  try {
    // `undefined` powerPreference lets the browser pick; asking for
    // 'high-performance' on a machine with only an integrated GPU is a way to
    // get null back from an adapter that would have worked.
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return { ok: false, adapter: null, info: null, reason: 'requestAdapter() returned null' };
    }
    // `info` is the modern spelling; older Chromiums expose requestAdapterInfo().
    let info = adapter.info || null;
    if (!info && typeof adapter.requestAdapterInfo === 'function') {
      try { info = await adapter.requestAdapterInfo(); } catch { info = null; }
    }
    return { ok: true, adapter, info, reason: null };
  } catch (err) {
    return { ok: false, adapter: null, info: null, reason: String(err?.message || err) };
  }
}

/** One line naming the adapter, for the log and for `info_sink` on the backend. */
export function describeAdapter(info) {
  if (!info) return 'unknown adapter';
  const parts = [info.vendor, info.architecture, info.device, info.description]
    .filter((p) => typeof p === 'string' && p.trim());
  return parts.length ? parts.join(' · ') : 'unknown adapter';
}

const WEBGL_PARAMS = {
  antialias: false,
  /*
   * PRESERVATION IS A TIER DECISION (previewDeviceTier, plan A4). On a desktop
   * immediate-mode GPU keeping the drawing buffer is free; on Apple/Adreno/Mali
   * tile-based GPUs it forces a full framebuffer resolve + reload EVERY frame, so
   * the touch tier turns it off. Desktop stays `true` — the value below is only
   * the fallback and is overridden per renderer in createVideoRenderer.
   *
   * Turning it off has a contract: every reader of the drawing buffer
   * (captureFrame, captureFrameAtTime, the exporter's VideoFrame(canvas)) must
   * read in the SAME TASK as its last render, because the buffer is cleared once
   * the frame is composited. The Player keeps that contract — each of those paths
   * ends with a synchronous renderFrame immediately before the read.
   */
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
  // ALPHA IS REQUIRED, and it matters more on WebGPU than it ever did on WebGL.
  // three configures the WebGPU canvas context's alphaMode from this flag;
  // without it the context is OPAQUE, so an alpha-0 clear resolves to black
  // instead of to nothing. The export path renders transparent frames (alpha
  // PNG mode), so the whole background came out solid black — 125,333 opaque
  // black pixels against WebGL's 10,352 lit pixels on transparency.
  alpha: true,
};

function unavailable(detail) {
  const err = new Error(`${WEBGPU_REQUIRED_MESSAGE} (${detail})`);
  err.userMessage = WEBGPU_REQUIRED_MESSAGE;
  /*
   * The TECHNICAL reason, carried separately so the UI can show it.
   *
   * It was computed and then thrown away: the overlay printed the friendly
   * paragraph alone, which reads identically whether `navigator.gpu` is absent,
   * an adapter request came back null, or three quietly took its WebGL2
   * fallback. Those have completely different causes and fixes, and a screenshot
   * of the friendly text cannot tell them apart — which is exactly the position
   * the first packaged build put us in.
   */
  err.detail = String(detail);
  return err;
}

/**
 * Build the editor's renderer. Returns `{ renderer, backendName, ready }`, the
 * renderer already constructed and configured, and `ready` resolving when it can
 * actually draw. On WebGL that is immediately; on WebGPU it is after `init()`.
 *
 * `ready` REJECTS — it never resolves onto a lesser renderer — when WebGPU was
 * asked for and either no adapter exists or the WebGL2 fallback was taken.
 */
export function createVideoRenderer({ canvas, backend = 'webgl', width, height }) {
  const params = { ...WEBGL_PARAMS, preserveDrawingBuffer: getPreviewTier().preserveDrawingBuffer };
  notePerfRenderer({ backend: backend === 'webgpu' ? 'webgpu' : 'webgl', preserveDrawingBuffer: params.preserveDrawingBuffer });
  if (backend !== 'webgpu') {
    const renderer = new THREE.WebGLRenderer({ canvas, ...params });
    configureRenderer(renderer, width, height);
    return { renderer, backendName: 'webgl', ready: Promise.resolve(renderer) };
  }

  if (!WebGPURenderer) {
    // Reachable only from a caller that skipped the load — a lab harness, or a
    // new call site. Name the fix rather than failing on `new null()`.
    throw new Error('videoRenderer: await loadWebGpuBackend(\'webgpu\') before creating a WebGPU renderer '
      + '(the app does this inside initMaterialBackend()).');
  }
  const renderer = new WebGPURenderer({ canvas, ...params });
  /*
   * DISARM THREE'S FALLBACK. Rule 2 of this file's header, enforced instead of
   * asserted after the fact.
   *
   * `WebGPURenderer`'s constructor hands the base Renderer a `getFallback` that
   * builds a WebGLBackend, and `Renderer.init()` calls it whenever the WebGPU
   * backend fails to initialise. On this canvas that fallback cannot work — the
   * canvas already holds a `webgpu` context, so `getContext('webgl2')` returns
   * null and the fallback dies inside three with a TypeError, replacing the real
   * reason with a useless one. With no fallback, `init()` rejects with the
   * ACTUAL failure, which the catch below turns into a sentence.
   *
   * `_getFallback` is private API — the same category as `backend.parameters`
   * below and `_nodes` in the export loop. Re-verify on a three upgrade; the
   * assertion after `init()` is what catches it if this ever stops working.
  */
  if ('_getFallback' in renderer) renderer._getFallback = null;
  configureRenderer(renderer, width, height);
  const rendererGeneration = activeRendererGeneration;
  const ready = (async () => {
    const cached = preflight?.generation === rendererGeneration ? preflight.probe : null;
    const probe = cached || await probeWebGpuAdapter();
    if (preflight?.generation === rendererGeneration) preflight = null;
    if (!probe.ok) throw unavailable(probe.reason);
    if (activeRenderer !== 'webgpu' || activeRendererGeneration !== rendererGeneration) {
      throw unavailable('the renderer session changed during adapter initialization');
    }
    /*
     * WE CREATE THE DEVICE, NOT THREE — and this is not an optimisation.
     *
     * three's `WebGPUBackend.init()` asks for its own adapter with
     * `{ powerPreference, featureLevel: 'compatibility' }`. `featureLevel`
     * postdates Chromium 130, which is what Electron 33 ships, and the WebGPU
     * spec says an unrecognised feature level returns NULL rather than ignoring
     * the option. three reads that null as "WebGPU is unavailable", throws, and
     * takes its WebGL2 fallback — with nothing but a console warning.
     *
     * The result was an editor that refused to start in the packaged app on a
     * machine whose GPU is entirely capable, while the SAME code ran fine in
     * Chrome (new enough to know `featureLevel`). Measured in Electron 33:
     *
     *   requestAdapter({})                                  -> adapter + device OK
     *   requestAdapter({powerPreference:'high-performance'}) -> adapter + device OK
     *   requestAdapter({featureLevel:'compatibility'})       -> NULL
     *   requestAdapter(three's exact combo)                  -> NULL
     *
     * `init()` skips its whole adapter/device dance when `parameters.device` is
     * already set, so handing it the device from the adapter we ALREADY probed
     * sidesteps the unsupported option entirely. Assigned on the backend rather
     * than passed to the constructor because construction stays synchronous
     * here (see the header) and `init()` is the first point that reads it.
     *
     * This is version-sensitive glue, not a permanent design: once the app's
     * Electron is new enough to understand `featureLevel`, three's own path
     * works and this can go. It is harmless there in the meantime — the device
     * is the same one three would have created.
     */
    let device;
    try {
      /*
       * Do NOT request every adapter feature. Chromium documents that some
       * optional features are mutually exclusive (texture-compression-bc vs
       * etc2 vs astc, plus experimental flags). Asking for the whole set is
       * how a capable GPU fails requestDevice() and the editor never starts.
       * Three.js with a pre-created device uses that device as-is, so we only
       * enable the features this compositor actually benefits from.
       */
      const OPTIONAL = [
        'float32-filterable', 'float32-blendable', 'shader-f16',
        'rg11b10ufloat-renderable', 'bgra8unorm-storage', 'timestamp-query',
        'depth32float-stencil8', 'depth-clip-control', 'dual-source-blending',
        'indirect-first-instance', 'clip-distances',
      ];
      const requiredFeatures = OPTIONAL.filter((name) => probe.adapter.features.has(name));
      const compression = ['texture-compression-bc', 'texture-compression-astc', 'texture-compression-etc2']
        .find((name) => probe.adapter.features.has(name));
      if (compression) requiredFeatures.push(compression);
      try {
        device = await probe.adapter.requestDevice({ requiredFeatures });
      } catch (first) {
        device = await probe.adapter.requestDevice();
        console.warn('[ve] WebGPU device created without optional features:', first?.message || first);
      }
      if (renderer.backend?.parameters) renderer.backend.parameters.device = device;
    } catch (err) {
      throw unavailable(`could not create a WebGPU device (${err?.message || err})`);
    }
    if (activeRenderer !== 'webgpu' || activeRendererGeneration !== rendererGeneration) {
      try { device?.destroy(); } catch { /* no-op */ }
      throw unavailable('the renderer session changed during device initialization');
    }
    try {
      await renderer.init();
    } catch (err) {
      // Everything three can fail at — device lost, canvas configuration, a
      // shader stage the driver rejects — arrives here as one sentence plus the
      // real reason underneath it, instead of as a library stack trace.
      throw unavailable(`WebGPU initialisation failed (${err?.message || err})`);
    }
    // THE assertion, kept as the backstop for the fallback being disarmed above:
    // if a three upgrade routes around `_getFallback`, this still refuses to
    // return a WebGL2 renderer wearing the WebGPU name.
    if (renderer.backend?.isWebGPUBackend !== true) {
      throw unavailable('three fell back to its WebGL2 backend after init');
    }
    if (activeRenderer !== 'webgpu' || activeRendererGeneration !== rendererGeneration) {
      try { renderer.dispose(); } catch { /* no-op */ }
      throw unavailable('the renderer session changed during backend initialization');
    }
    /*
     * World View draws real MeshStandardMaterial geometry straight to the canvas
     * and selects Three's CustomToneMapping slot around that draw. On WebGL the
     * curve gets there by patching ShaderChunk (worldView.js does it at module
     * load); node materials never touch ShaderChunk, so the WebGPU equivalent is
     * to register the same curve in the renderer's node library under the same
     * constant. World View's own code is identical on both backends as a result.
     *
     * Awaited init first: the library exists from construction, but registering
     * after init keeps this on the one path that has already asserted the
     * backend is really WebGPU.
     */
    const { installVideoEditorToneMappingNode } = await import('./threeDisplayTransformNodes.js');
    installVideoEditorToneMappingNode(renderer, THREE.CustomToneMapping);
    console.warn('[ve] WebGPU backend live — ' + describeAdapter(probe.info));
    return renderer;
  })();

  return { renderer, backendName: 'webgpu', ready };
}

// Settings that are identical on both backends and safe to apply before init.
function configureRenderer(renderer, width, height) {
  if (width > 0 && height > 0) {
    renderer.setSize(width, height, false);
    notePerfRenderer({ w: width, h: height });
  }
  renderer.setPixelRatio(1);
  // Kept LINEAR on both: the display transform is applied by the pipeline's own
  // curve, which already sRGB-encodes. See PORT-PLAN §4.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(0x000000, 1);
  // Set exactly once, here, and never touched again — changing it after startup
  // re-keys every program in the app. (The long-form reasoning lives at the
  // Player's init effect, which is where it used to be set.)
  // WebGL runs BASIC because the rig's soft shadows (rigSoftShadows.js, installed
  // when model3dLayer loads) replace BASIC's lookup with PCSS — they need raw depth,
  // which PCF's comparison sampler cannot give. Nothing draws a shadow before that
  // module loads, since every shadowed pass lives in it. WebGPU keeps three's PCF.
  renderer.shadowMap.type = renderer.isWebGLRenderer ? THREE.BasicShadowMap : THREE.PCFShadowMap;
}

/**
 * Which backend the editor builds. WebGL is the explicit shipping default;
 * WebGPU is a global opt-in from App Settings.
 *
 * The default stayed WebGL for as long as a WebGPU renderer could not run the
 * app's GLSL `ShaderMaterial`s at all. Every shader family now has a TSL twin
 * behind materialFactory.js, and `tests/webgpu-migration` (`npm run gate`) is
 * the evidence: each family diffed against the GLSL original it replaces.
 *
 * BOTH PIPELINES ARE SUPPORTED, AND WEBGL IS THE DEFAULT FOR NOW.
 *
 * The product runs two complete pipelines side by side: WebGL + hand-written
 * GLSL (the default today) and WebGPU + TSL nodes (app-wide, opt-in). This
 * is deliberate, not a transitional accident — WebGPU is where the app is
 * going, and WebGL is what ships until the TSL side has coverage matching the
 * whole feature surface.
 *
 * WHAT THAT REQUIRES OF THE CODE: a clean division, so removing WebGL later is
 * a deletion rather than a rewrite. The seam is this file plus
 * materialFactory.js, and the rule is one-directional — the registry offers TSL
 * twins and returns null on WebGL, so the GLSL path never enters it and can be
 * dropped without touching the node modules. Nothing else in the editor may
 * branch on the backend; anything that needs to belongs behind that seam.
 *
 * `?veRenderer=webgl|webgpu` remains the diagnostic override for bisecting a
 * difference and for the lab pairs' ground truth.
 *
 * WHAT DOES NOT HAPPEN HERE: a fallback. If WebGPU cannot run, `createVideoRenderer`
 * REJECTS and the editor says so in words — it never quietly returns 'webgl',
 * because a pipeline silently running on the other backend makes every
 * measurement taken on it a lie (see this file's header, rule 2).
 *
 * Three features cannot render on WebGPU at all, because they compile GLSL
 * supplied at runtime. They are detected in the open project, by name, in
 * webgpuPreflight.js — which is what makes flipping this default safe to do
 * before those features are removed.
 */
/*
 * The backend owned by the CURRENT renderer session.
 *
 * This deliberately does not read localStorage. The global preference changes
 * while an existing Player may still be drawing; letting every material factory
 * observe that write immediately mixes WebGPU materials into the old WebGL
 * renderer (or vice versa). VideoEditor first unmounts the complete Player,
 * waits for its cleanup, then activates the new value before mounting a fresh
 * session. Query parameters still win because test/render pages choose their
 * backend before a Player exists.
 */
let activeRenderer = 'webgl';
let activeRendererGeneration = 0;

/** Activate a backend only after the previous Player session has been disposed. */
export function activateVideoRenderer(value) {
  activeRenderer = value === 'webgpu' ? 'webgpu' : 'webgl';
  activeRendererGeneration += 1;
  // Any adapter retained by the previous renderer session is stale by design.
  preflight = null;
  preflightPromise = null;
  return activeRenderer;
}

/** The backend owned by the currently mounted Player session. */
export function getActiveVideoRenderer() {
  return activeRenderer;
}

/** Monotonic identity for cancelling work started by an older renderer session. */
export function getActiveVideoRendererGeneration() {
  return activeRendererGeneration;
}

function rendererFromQuery() {
  if (typeof window !== 'undefined') {
    try {
      const param = new URLSearchParams(window.location.search).get('veRenderer');
      if (param === 'webgpu' || param === 'webgl') return param;
    } catch { /* not addressable */ }
  }
  return null;
}

/** Resolve the app preference plus the explicit URL override used by probes. */
export function resolveVideoRenderer(value) {
  const override = rendererFromQuery();
  if (override) return override;
  return value === 'webgpu' ? 'webgpu' : 'webgl';
}

export function selectedBackend() {
  // No window: nothing is being rendered, and no node module should load.
  // materialFactory reads this to decide whether to import `three/webgpu` at
  // all, so a non-browser import of a leaf module must not drag it in.
  if (typeof window === 'undefined') return 'webgl';
  const override = rendererFromQuery();
  if (override) return override;
  if (activeRenderer === 'webgpu') return 'webgpu';
  /*
   * BACK TO WEBGL — THE CUTOVER WAS PREMATURE, AND THIS IS THE RECORD OF WHY.
   *
   * The default was flipped to 'webgpu' on the strength of a green verification
   * gate. The gate was green and the editor was still broken, because the gate
   * exercised roughly a dozen features and the editor has dozens. Real use found
   * in minutes what it could not:
   *
   *   * A SYSTEMIC Y-FLIP across effects that sample a render target — neon
   *     glow, aura blur, layer mask, gradient sweep, Louver Flip, Circular Wipe.
   *     Two instances of this were found and fixed one at a time (the adjustment
   *     layer, then the layer mask) without recognising that both were the same
   *     defect and that it therefore applied everywhere else too.
   *   * Adjustment effects with NO TSL body at all — `fastCameraWiggle`,
   *     `extract`, `lightRays` — which throw and take the whole editor down.
   *   * A WGSL compile error: `smoothstep called with 'low' (1.0) not less than
   *     'high'`. GLSL tolerates a reversed smoothstep; WGSL rejects it at
   *     compile time, so the pipeline is invalid and nothing draws. (3D Carousel
   *     panel edges used that pattern — fixed in 10.0.36.)
   *   * 3D models wrong near the camera.
   *
   * WebGPU remains fully reachable through the global App Settings control or
   * `?veRenderer=webgpu`, so the work continues against it. What changes is that
   * the DEFAULT no longer ships broken.
   *
   * The bar for flipping this again is coverage that matches the feature
   * surface: every adjustment effect having a TSL body verified to RUN, every
   * render-target consumer verified for orientation, and every transition
   * package driven through the app. Not a green gate — a green gate that is
   * known to be measuring the whole product.
   */
  return 'webgl';
}
