/*
 * The one place that decides GLSL-or-TSL — §4's keystone.
 *
 * Every ported family shipped as a standalone `*Nodes.js` module with no caller,
 * which is exactly what let each one be verified against its GLSL twin in
 * isolation. This is where they get wired in: one function per material, each
 * returning the GLSL original or the node twin according to `selectedBackend()`.
 *
 * WHY A REGISTRY RATHER THAN A BRANCH AT EACH CALL SITE:
 *
 *   The call sites are spread across Player.jsx and a dozen layer modules. A
 *   backend check at each one is a check that can be FORGOTTEN at one of them,
 *   and the failure is silent — a WebGL ShaderMaterial handed to WebGPURenderer
 *   does not throw, it draws nothing, so one missed site reads as "that layer
 *   effect stopped working" rather than "the swap is incomplete".
 *
 *   It also gives the port a single completeness check: `unportedOnWebGpu()`
 *   below enumerates what has NO twin, so the answer to "what still breaks on
 *   WebGPU" is code, not memory.
 *
 * WHAT HAS NO TWIN, AND CANNOT HAVE ONE. Two features arrive as GLSL that would
 * have to be compiled at RUNTIME — custom adjustment effects, and transition
 * packages authored for the classic renderer. There is no runtime GLSL→TSL
 * compiler, so these cannot render on WebGPU at all. They are listed here, not
 * silently skipped, because the product decision about them is still open and
 * whoever makes it should be able to read the list.
 */
import {
  getActiveVideoRendererGeneration,
  loadWebGpuBackend,
  selectedBackend,
} from './videoRenderer.js';
import { resetNodeSdk } from './transitionPackageSdk.js';

const usesNodes = () => selectedBackend() === 'webgpu';

/*
 * THE REGISTRY SUPPLIES TWINS ONLY. It does not own the GLSL side.
 *
 * The first cut statically imported all six GLSL modules so that `materials.*`
 * could return either implementation synchronously. That made every consumer of
 * this registry depend on the GLSL modules' whole import graph — a leaf module
 * that draws sprites pulling in the adjustment-effect stack to ask one question.
 * Bundling hides the cost, but the coupling is real and points the wrong way:
 * the registry's job is to offer a TWIN, not to own the original.
 *
 * So each accessor returns the node twin, or NULL on WebGL — and the caller
 * keeps the GLSL it already had:
 *
 *     const material = makeMaterial.clip() ?? createClipMaterial();
 *
 * This is strictly better than the alternative. The WebGL path is not merely
 * "unchanged", it is UNTOUCHED — it never enters this file. Only the node
 * modules load here, lazily, so `three/webgpu` stays out of the WebGL bundle.
 * And a missing init still throws loudly on WebGPU rather than silently handing
 * a ShaderMaterial to WebGPURenderer, which draws nothing.
 */
let nodeImpl = null;
let nodeLoadPromise = null;
let sdkNodesImpl = null;

async function loadNodeModules() {
  if (nodeImpl) return;
  if (!nodeLoadPromise) {
    nodeLoadPromise = Promise.all([
      import('./clipShaderNodes.js'), import('./layerMaskNodes.js'), import('./warpNodes.js'),
      import('./adjustmentEffectNodes.js'), import('./transitionPackageNodes.js'),
      import('./runningGlowNodes.js'), import('./autoFillNodes.js'), import('./mockupFrameNodes.js'),
      import('./motionBlurNodes.js'), import('./particleNodes.js'), import('./model3dGrowFillNodes.js'),
      import('./compositeNodes.js'), import('./repetileNodes.js'), import('./model3dNodes.js'),
      import('./motionTrailNodes.js'), import('./echoNodes.js'), import('./timeshiftNodes.js'),
      import('./rigDeformNodes.js'),
      import('./chromaKeyNodes.js'), import('./depthScanNodes.js'),
      import('./silhouetteFramingNodes.js'),
      import('./backdropBlurNodes.js'),
      import('./glassNodes.js'),
      import('./blendCompositeNodes.js'),
      import('./transitionPackageSdkNodes.js'),
      import('three/tsl'),
    ]).then(([clip, mask, warp, adj, pkg, glow, af, mf, mb, part, grow, comp,
      rep, m3d, trail, echo, ts, rig, ck, scn, sf, bd, glass, bc, sdkNodes, tsl]) => {
      sdkNodesImpl = sdkNodes;
      tslImpl = tsl;
      nodeImpl = { clip, mask, warp, adj, pkg, glow, af, mf, mb, part, grow, comp, rep, m3d, trail, echo, ts, rig, ck, scn, sf, bd, glass, bc };
    }).catch((err) => {
      nodeLoadPromise = null;
      throw err;
    });
  }
  await nodeLoadPromise;
}

/**
 * The real-3D model effects' TSL twin (model3dFxNodes.js), loaded on FIRST USE
 * rather than with the rest at backend init: a project without a 3D effect on a
 * model never pays for it. Resolves to null on WebGL, where model3dFx.js keeps
 * its own GLSL. Lives here because this file is the one door `three/webgpu`
 * may come through.
 */
let modelFxNodesPromise = null;
export function loadModelFxNodes() {
  if (!usesNodes()) return Promise.resolve(null);
  if (!modelFxNodesPromise) {
    modelFxNodesPromise = import('./model3dFxNodes.js').catch((err) => {
      modelFxNodesPromise = null;
      throw err;
    });
  }
  return modelFxNodesPromise;
}

/**
 * The WebGPU half of an effect package's proof (effectProof.js): the renderer
 * class and the effect node builder, for a private device. Loaded only when a
 * package with TSL shading is checked — on a WebGL session too, because a
 * package written for both engines is proven on both — and through this door,
 * like every other `three/webgpu` load.
 */
export function loadPackageProofNodes() {
  return Promise.all([import('three/webgpu'), import('three/tsl'), import('./adjustmentEffectNodes.js')])
    .then(([webgpu, tsl, adj]) => ({ THREE: webgpu, TSL: tsl, adj }));
}

/**
 * Load everything the WebGPU backend needs. A no-op on WebGL, so it is safe (and
 * correct) to await unconditionally from renderer setup.
 *
 * THE ONE PLACE `three/webgpu` ENTERS THE APP, and the reason it is one place.
 * That build is a second 1.9 MB copy of three; anything importing it statically
 * puts it in the editor's chunk for every user, WebGL projects included. So the
 * three modules that need it — the node materials, the renderer class, and the
 * transition SDK's TSL half — all load HERE, behind `usesNodes()`, and nothing
 * else may import it directly.
 *
 * The Player already gates its whole synchronous build pass on this promise
 * (`materialsReady`), which is what makes a dynamic load safe: by the time any
 * material, renderer or package instance is constructed, all of it has landed.
 */
export async function initMaterialBackend() {
  if (!usesNodes()) return;
  const generation = getActiveVideoRendererGeneration();
  // Code loading is shared and immutable; adapter readiness belongs to this
  // renderer generation and is deliberately not shared with a later switch.
  await Promise.all([loadNodeModules(), loadWebGpuBackend('webgpu')]);
  if (usesNodes() && getActiveVideoRendererGeneration() === generation) {
    sdkNodesImpl.installTransitionSdkNodes();
  }
}

/** Synchronise the mutable package SDK during the teardown gap between Players. */
export function activateMaterialBackendForRenderer(backend) {
  if (backend !== 'webgpu') {
    resetNodeSdk();
    return;
  }
  // First WebGPU activation installs after the lazy modules land. Later
  // activations can reinstall synchronously before the new Player mounts.
  sdkNodesImpl?.installTransitionSdkNodes();
}

/**
 * Node modules cannot be unloaded once the user has opted into WebGPU, but no
 * WebGL session may retain the WebGPU Three.js namespace installed into the
 * transition SDK. Called only in the teardown gap between two Player mounts.
 * A cold WebGL start does not import any WebGPU/TSL module.
 */
export function resetMaterialBackendForWebGl() {
  activateMaterialBackendForRenderer('webgl');
}

/*
 * The TSL builders, for the handful of app-side node expressions that are not a
 * material — currently the scene background. Kept behind the registry rather
 * than imported at the call site so `three/tsl` (which pulls the same 1.9 MB
 * build) has exactly one entry point, the one above.
 */
let tslImpl = null;

/**
 * The scene background as a node, or null on WebGL where `scene.background`
 * needs no help. WebGPU's default background node samples with `screenUV.flipY()`
 * assuming an upload flip that canvases do not get, so the plate mirrors; this
 * samples plain `screenUV` instead and the caller turns `texture.flipY` off.
 */
export function backgroundTextureNode(texture) {
  if (!usesNodes() || !tslImpl) return null;
  return tslImpl.texture(texture, tslImpl.screenUV);
}

/** True when materials can be created for the CURRENTLY selected backend. */
export const materialBackendReady = () => !usesNodes() || nodeImpl !== null;

/** The node modules, or null on WebGL (where the caller keeps its own GLSL). */
function nodes() {
  if (!usesNodes()) return null;
  if (!nodeImpl) {
    throw new Error('materialFactory: initMaterialBackend() must be awaited before creating materials on WebGPU');
  }
  return nodeImpl;
}

/**
 * Sync accessors. Each returns the GLSL original or the node twin; the caller
 * cannot tell which, and must not care.
 */
export const materials = {
  clip: () => {
    const n = nodes();
    return n ? n.clip.createClipNodeMaterial() : null;
  },
  /** Chroma Key: the three fullscreen passes, { key, choke, out }. */
  chromaKey: () => {
    const n = nodes();
    return n ? n.ck.createChromaKeyNodeMaterials() : null;
  },
  /** Silhouette framing: a keyed layer's border + shadows, { distH, distV, compose }. */
  silhouetteFraming: () => {
    const n = nodes();
    return n ? n.sf.createSilhouetteFramingNodeMaterials() : null;
  },
  /** Depth Scan: one fullscreen pass over the isolate, sampling the depth map. */
  depthScan: () => {
    const n = nodes();
    return n ? n.scn.createDepthScanNodeMaterial() : null;
  },
  layerMask: () => {
    const n = nodes();
    return n ? n.mask.createLayerMaskNodeMaterial() : null;
  },
  adjustmentMaskMix: () => {
    const n = nodes();
    return n ? n.mask.createAdjustmentMaskMixNodeMaterial() : null;
  },
  runningGlow: () => {
    const n = nodes();
    return n ? n.glow.createRunningGlowNodeMaterials() : null;
  },
  autoFill: () => {
    const n = nodes();
    return n ? n.af.createAutoFillNodeMaterial() : null;
  },
  /*
   * The crop pass autofillField.js runs before the bake. Its twin was written
   * and verified with the rest of row 12b but never added here — which is
   * exactly the gap verify_backend_coverage.js now scans for: a twin nothing
   * can reach is indistinguishable, at runtime, from a twin that was never
   * written.
   */
  autoFillCrop: () => {
    const n = nodes();
    return n ? n.af.createAutoFillCropNodeMaterial() : null;
  },
  motionBlur: () => {
    const n = nodes();
    return n ? n.mb.createMotionBlurNodeMaterial() : null;
  },
  motionBlurMix: () => {
    const n = nodes();
    return n ? n.mb.createMotionBlurMixNodeMaterial() : null;
  },
  /**
   * The export path's pair. Null on WebGL, where motionBlur.js keeps its own
   * GLSL literals — this registry does not need to own a material that already
   * has exactly one caller and no second implementation to choose between.
   */
  motionBlurAccumulate: () => {
    const n = nodes();
    return n ? n.mb.createMotionBlurAccumulateNodeMaterial() : null;
  },
  motionBlurBlit: () => {
    const n = nodes();
    return n ? n.mb.createMotionBlurBlitNodeMaterial() : null;
  },
  /**
   * WebGPU-only twins. On WebGL these have no counterpart to choose between —
   * the GLSL material is built inside the app's own pass factory — so the
   * accessor returns null and the caller keeps what the pass already made.
   */
  mockupFrame: () => {
    const n = nodes();
    return n ? n.mf.createMockupFrameNodeMaterial() : null;
  },
  particles: (proto) => {
    const n = nodes();
    return n ? n.part.createParticleNodeMaterial(proto) : null;
  },
  modelGrowFill: (gu, srcMat, renderer) => {
    const n = nodes();
    return n ? n.grow.createModelGrowFillNodeMaterial(gu, srcMat, renderer) : null;
  },

  /*
   * THE COMPOSITING PASSES — the plumbing between effects, not effects.
   *
   * These were missed by the whole port for a structural reason worth keeping
   * written down: the migration matrix is organised by EFFECT, and none of these
   * is one, so no lab covered them and no row flagged them. They were found by
   * an app-level A/B showing an opaque region that no module-level sweep could
   * see — because a GLSL ShaderMaterial on WebGPURenderer draws NOTHING, and in
   * the composite path "nothing" is an opaque region rather than a missing one.
   */
  // `opts.flipTexture` makes the copy a storage identity on WebGPU — see
  // createBlitNodeMaterial; only the sequence plate copy asks for it.
  blit: (opts) => {
    const n = nodes();
    return n ? n.comp.createBlitNodeMaterial(opts) : null;
  },
  // Cover-fitted copy of an UPLOADED picture onto a chain plate (Copy Color
  // Profile's off-screen reference) — see createPictureCopyNodeMaterial.
  pictureCopy: () => {
    const n = nodes();
    return n ? n.comp.createPictureCopyNodeMaterial() : null;
  },
  overBlit: () => {
    const n = nodes();
    return n ? n.comp.createOverBlitNodeMaterial() : null;
  },
  adjustment: () => {
    const n = nodes();
    return n ? n.comp.createAdjustmentNodeMaterial() : null;
  },
  mix: () => {
    const n = nodes();
    return n ? n.comp.createMixNodeMaterial() : null;
  },
  // `opts.flipTexture`: sample the camera-rendered inputs flipped — see createMaskCompositeNodeMaterial.
  maskComposite: (opts) => {
    const n = nodes();
    return n ? n.comp.createMaskCompositeNodeMaterial(opts) : null;
  },
  // `opts.flipTexture` selects the consumer-read orientation — see
  // createTrackMatteNodeMaterial; Player keeps one material of each.
  trackMatte: (opts) => {
    const n = nodes();
    return n ? n.comp.createTrackMatteNodeMaterial(opts) : null;
  },
  depthStamp: () => {
    const n = nodes();
    return n ? n.comp.createDepthStampNodeMaterial() : null;
  },
  depthComposite: () => {
    const n = nodes();
    return n ? n.comp.createDepthCompositeNodeMaterial() : null;
  },
  /*
   * Two more pipeline passes that the effect-shaped matrix never listed:
   * matteClip keeps a layer effect inside the layer's own silhouette, and the
   * camera DOF pass is built inside Player.jsx itself.
   */
  matteClip: (opts) => {
    const n = nodes();
    return n ? n.comp.createMatteClipNodeMaterial(opts) : null;
  },
  cameraDof: () => {
    const n = nodes();
    return n ? n.comp.createCameraDofNodeMaterial() : null;
  },
  // Per-pixel DOF for a camera-baked 3D pass (reads the pass's depth).
  cameraDofDepth: () => {
    const n = nodes();
    return n ? n.comp.createCameraDofDepthNodeMaterial() : null;
  },
  /** Backdrop Blur (shape layers): the separable blur pass and the coverage mix. */
  backdropBlur: () => {
    const n = nodes();
    return n ? n.bd.createBackdropBlurNodeMaterial() : null;
  },
  // `opts.flipMatte` selects the matte-read orientation — see
  // createBackdropMixNodeMaterial; Player keeps one material of each.
  backdropMix: (opts) => {
    const n = nodes();
    return n ? n.bd.createBackdropMixNodeMaterial(opts) : null;
  },
  /** Glass (shape layers): the one refraction pass (glassEffect.js / glassNodes.js). */
  glass: () => {
    const n = nodes();
    return n ? n.glass.createGlassNodeMaterial() : null;
  },
  // The destination-reading blend pass (overlay, soft light, hue…). `opts.flipLayer`
  // selects the plate-read orientation — see createBlendCompositeNodeMaterial;
  // Player keeps one material of each.
  blendComposite: (opts) => {
    const n = nodes();
    return n ? n.bc.createBlendCompositeNodeMaterial(opts) : null;
  },
  /** Repetile bypasses the camera: its vertex stage writes clip space itself. */
  repetile: () => {
    const n = nodes();
    return n ? n.rep.createRepetileNodeMaterial() : null;
  },
  /**
   * The 3D path's universal tone pass. renderModelLayer ALWAYS ends with it, so
   * without a twin the model, rig-scene and flat-plate outputs are all cleared —
   * this one gates the whole 3D path rather than one effect.
   */
  modelTonePass: () => {
    const n = nodes();
    return n ? n.m3d.createModelTonePassNodeMaterial() : null;
  },
  rigContactPasses: () => {
    const n = nodes();
    return n ? n.m3d.createRigContactNodeMaterials() : {};
  },
  rigShadowFilter: (light) => {
    const n = nodes();
    return n && (light.isDirectionalLight || light.isSpotLight) ? n.m3d.rigSoftShadowFilter : null;
  },
  /**
   * The flat shadow plate. Its GLSL side is an onBeforeCompile splice, which
   * WebGPU never calls — so the twin rebuilds the same result from the node
   * pipeline rather than translating anything.
   */
  shadowPlate: () => {
    const n = nodes();
    return n ? n.m3d.createShadowPlateNodeMaterial() : null;
  },

  /*
   * Motion Trail's FIVE passes. The coverage ledger had this module down as two
   * factories because four of them are built through one shared `shader()`
   * helper — a scan that counts construction SITES undercounts wherever a
   * module funnels its materials through one.
   */
  motionTrail: () => {
    const n = nodes();
    return n ? n.trail.createMotionTrailNodeMaterial() : null;
  },
  trailWarp: () => {
    const n = nodes();
    return n ? n.trail.createTrailWarpNodeMaterial() : null;
  },
  trailAcc: () => {
    const n = nodes();
    return n ? n.trail.createTrailAccNodeMaterial() : null;
  },
  trailErode: () => {
    const n = nodes();
    return n ? n.trail.createTrailErodeNodeMaterial() : null;
  },
  trailCompose: () => {
    const n = nodes();
    return n ? n.trail.createTrailComposeNodeMaterial() : null;
  },

  /*
   * Echo's ONE material (echoMaterial.js). Its tap pass is trailWarp and its output pass is
   * trailCompose — a temporal effect that reuses two of Motion Trail's five
   * passes only has one place where its two backends can drift.
   */
  echoAcc: () => {
    const n = nodes();
    return n ? n.echo.createEchoAccNodeMaterial() : null;
  },

  /*
   * TimeShift's two (timeshiftMaterial.js). It owns both because neither has an
   * equivalent anywhere else: nothing in the tree writes one tile of an atlas,
   * and nothing else reads a ring with a per-pixel offset.
   */
  timeshiftRecord: () => {
    const n = nodes();
    return n ? n.ts.createTimeShiftRecordNodeMaterial() : null;
  },
  timeshiftStreak: () => {
    const n = nodes();
    return n ? n.ts.createTimeShiftStreakNodeMaterial() : null;
  },

  /** Rig tool / Puppet Pin: the bake's crop, the deform warp, and the copy back. */
  rigCrop: () => {
    const n = nodes();
    return n ? n.rig.createRigCropNodeMaterial() : null;
  },
  rigWarp: () => {
    const n = nodes();
    return n ? n.rig.createRigWarpNodeMaterial() : null;
  },
  rigCopy: () => {
    const n = nodes();
    return n ? n.rig.createRigCopyNodeMaterial() : null;
  },
};

/**
 * The warps are the awkward shape: on WebGL each material is built INSIDE its
 * own pass factory, so the swap replaces the material on the pass the app
 * already made rather than choosing a factory up front. Bezier and mesh warp
 * carry two, because they draw their two facings as two meshes so the fold can
 * be ordered explicitly.
 */
export function swapWarpMaterialForBackend(kind, pass) {
  const n = nodes();
  if (!n) return pass;
  const w = n.warp;
  if (kind === 'bezierWarp' || kind === 'meshWarp') {
    const n = kind === 'bezierWarp'
      ? w.createBezierWarpNodeMaterials() : w.createMeshWarpNodeMaterials();
    pass.material = n.material;
    pass.backMaterial = n.backMaterial;
    pass.front.material = n.material;
    pass.back.material = n.backMaterial;
    return pass;
  }
  const make = {
    bend: w.createBendNodeMaterial,
    regionDistort: w.createRegionDistortNodeMaterial,
    cornerPin: w.createCornerPinNodeMaterial,
    droste: w.createDrosteNodeMaterial,
    pryzm: w.createPryzmNodeMaterial,
  }[kind];
  if (!make) throw new Error(`swapWarpMaterialForBackend: unknown warp "${kind}"`);
  // BOTH handles. The pass object carries `material` as its uniform surface —
  // every caller writes `pass.material.uniforms.*` — while `mesh.material` is
  // what actually draws. Setting only the mesh puts the twin on screen and
  // leaves every uniform write going to the orphaned GLSL material, so the warp
  // renders with its constructor defaults and never moves.
  const mat = make();
  pass.material = mat;
  pass.mesh.material = mat;
  return pass;
}

/**
 * Adjustment / overlay effects. This one takes an ID rather than being a fixed
 * material, and the two sides disagree about what they need: the GLSL factory
 * wants the effect object AND its code (because `custom` compiles that code),
 * while the node factory only ever needs the id — there is no runtime compile.
 * That asymmetry IS the unported feature, made concrete: an effect whose body
 * arrives as a string has nothing to look up.
 */
export function createEffectMaterialForBackend(effect, code, pass = 'main', flips = null) {
  const n = nodes();
  if (!n) return null;                      // WebGL: the caller keeps createEffectMaterial
  const id = typeof effect === 'string' ? effect : effect?.id;
  if (id === 'custom') {
    /*
     * NOT REACHED IN NORMAL OPERATION — `webGpuUnsupportedEffect()` below is
     * what callers ask first, and it short-circuits this. This is the backstop,
     * and it exists because of what used to be here.
     *
     * This branch called `createCustomEffectNodeMaterial(code)`, which compiles
     * `code` with `new Function`. That could never work, and not for a subtle
     * reason: a custom effect's `code` is GLSL — `validateCustomEffect()`
     * REQUIRES it to declare `void mainImage(...)` — while `compileUserTsl()`
     * requires JavaScript. The two demands cannot both be met, so on WebGPU the
     * only reachable outcome was a syntax error thrown mid-frame.
     *
     * Severing it also settles the raw-eval question: `tslUserShader.js` builds
     * user TSL with `new Function`, and the migration decision on record is that
     * user-supplied TSL must never be eval'd raw. It now has no production
     * caller — it keeps its lab and its test as the prototype it is.
     */
    const entry = WEBGPU_UNPORTED.find((e) => e.key === 'customEffect');
    throw new Error(`${entry.feature}: ${entry.why}`);
  }
  // An installed package (Effects SDK) brings its own node functions on the def.
  const mat = n.adj.createEffectNodeMaterial(id, pass, flips, typeof effect === 'object' && effect?.isLocal ? effect : null);
  if (!mat) {
    throw new Error(`no TSL body for adjustment effect "${id}" — the port is incomplete, not the feature`);
  }
  return mat;
}

/** Re-export: multipass cache key for structural flip maps (lab 08c). */
export function effectFlipCacheKey(flips) {
  const n = nodeImpl;
  if (!n?.adj?.effectFlipCacheKey) return '';
  return n.adj.effectFlipCacheKey(flips);
}

/** The built-in transition packages, by id. */
export function createTransitionPackageMaterialForBackend(id) {
  const n = nodes();
  if (!n) return null;   // the GLSL side builds these in its own pass
  const make = {
    louver: n.pkg.createLouverNodeMaterial,
    circleWipe: n.pkg.createCircleWipeNodeMaterial,
    pixelBlocks: n.pkg.createPixelBlocksNodeMaterial,
    carousel: n.pkg.createCarouselNodeMaterial,
    cameraWhip: n.pkg.createCameraWhipNodeMaterial,
    zoomRuler: n.pkg.createZoomRulerNodeMaterial,
    glowStack: n.pkg.createGlowStackNodeMaterial,
    gradientMap: n.pkg.createGradientMapNodeMaterial,
  }[id];
  if (!make) {
    throw new Error(`transition package "${id}" ships its own GLSL and cannot render on WebGPU`);
  }
  return make();
}

/**
 * THE CATALOGUE: what has no WebGPU implementation, and cannot have one, because
 * the feature compiles GLSL supplied at RUNTIME.
 *
 * Exported as data rather than hidden behind the function below so the preflight
 * that DETECTS these in a project (webgpuPreflight.js) can describe what it found
 * using these exact words. `key` is what the two sides agree on; the prose lives
 * here only, so a reworded entry cannot drift out of sync with the check.
 *
 * `test` stays as the one-line summary of the predicate. It is documentation of
 * the rule — the executable form is the matching `key` in the preflight's walk.
 */
/*
 * NOT ON THIS LIST, AND DELIBERATELY SO: custom shader backgrounds.
 *
 * They were listed here, and the listing was WRONG — measured, not argued. A
 * hand-written GLSL background renders on WebGPU BYTE-IDENTICALLY to WebGL
 * (0 differing bytes, max delta 2, full-frame). It never touches this backend
 * at all: `backgroundLayer.drawEditorBackground` rasterises the shader through
 * `shaderBackground.drawShaderToContext`, which owns its OWN WebGL context, and
 * the compositor only ever samples the resulting canvas as a texture. A canvas
 * is a canvas whichever renderer reads it.
 *
 * (Which also means `utils/shaderBackgroundNodes.js` — the TSL port of all 14
 * presets — has no caller and is not needed by this path.)
 *
 * The reason it LOOKED unported is a real bug that hid behind it: no background
 * of ANY kind drew on WebGPU, because the Player's background effect ran before
 * the scene existed and never retried. Fixed at that effect's dependencies. If
 * a background ever appears missing again, check that before assuming GLSL.
 */
export const WEBGPU_UNPORTED = Object.freeze([
  Object.freeze({
    key: 'customEffect',
    feature: 'custom adjustment effect',
    why: 'the effect body is GLSL supplied at runtime and compiled per project',
    test: "effect.id === 'custom'",
  }),
  Object.freeze({
    key: 'glslTransitionPackage',
    feature: 'transition package built for the classic renderer',
    why: 'its shading is GLSL, which no WebGPU renderer compiles',
    test: "pkg.renderer === 'webgl'",
  }),
]);

/**
 * Why this effect cannot render on the CURRENT backend, or null if it can.
 *
 * Asked BEFORE building a material, so an effect with no WebGPU implementation
 * becomes a skipped layer with a readable reason instead of an exception in the
 * middle of a frame. The Player already has that path — a custom effect that
 * fails to compile is cached as `{material: null, error}` and skipped — so this
 * reuses it rather than inventing a second failure mode.
 *
 * Returns a STRING (the reason) rather than a boolean, because the caller shows
 * it to a person.
 */
export function webGpuUnsupportedEffect(def) {
  if (!usesNodes()) return null;
  // Installed packages answer for themselves: see localEffectEngineReason.
  if (def?.isLocal) return null;
  if (def?.isCustom) {
    const entry = WEBGPU_UNPORTED.find((e) => e.key === 'customEffect');
    return `${entry.feature}: ${entry.why}`;
  }
  /*
   * AN UNPORTED EFFECT IS A SKIPPED LAYER, NOT A DEAD EDITOR.
   *
   * `createEffectNodeMaterial()` returns null for an id with no TSL body, and
   * the caller below turns that into a throw. That throw was not contained: it
   * escaped the Player's material resolution and the editor failed to load
   * outright — so a project containing ONE unported effect had no editor at all.
   * With roughly half the catalogue still unported, that is the difference
   * between "this effect does not render yet" and "the application is broken".
   *
   * Reported by NAME so the gap is legible rather than mysterious, and so the
   * list of what still needs porting can be read off a running editor.
   */
  const id = typeof def === 'string' ? def : def?.id;
  const n = nodeImpl;
  if (!id || !n?.adj?.hasEffectNodeBody) return null;
  /*
   * A DECLARATIVE effect has no single-pass body by design — its implementation
   * lives in PASS_BODIES, keyed per pass. Checking only the single-pass table
   * declared the whole def.passes family unsupported, so the Player skipped them
   * before ever asking for a pass: a fully ported multi-pass effect still
   * rendered as nothing. Ask both tables.
   */
  const supported = n.adj.hasEffectNodeBody(id)
    || (n.adj.hasEffectPassBody && n.adj.hasEffectPassBody(id, 'main'));
  if (!supported) {
    return `"${id}" has no WebGPU implementation yet — the port is incomplete, not the feature`;
  }
  return null;
}

/*
 * AN INSTALLED EFFECT RUNS ON THE ENGINES IT WAS WRITTEN FOR.
 *
 * An effect package's shading is GLSL (WebGL), TSL (WebGPU) or both, and nothing
 * translates between them. On an engine it has no shading for it would draw
 * nothing, so the chain skips it and this names why — for both engines, unlike
 * webGpuUnsupportedEffect, which only ever speaks on WebGPU.
 */
const ENGINE_NAME = { webgl: 'WebGL', webgpu: 'WebGPU' };
export function localEffectEngineReason(def) {
  const renderers = Array.isArray(def?.renderers) && def.renderers.length ? def.renderers : (def?.renderer ? [def.renderer] : []);
  if (!def?.isLocal || !renderers.length || def.renderer === 'both') return null;
  const active = usesNodes() ? 'webgpu' : 'webgl';
  if (renderers.includes(active)) return null;
  return `"${def.name}" is written for ${ENGINE_NAME[renderers[0]]}, and the editor renders with ${ENGINE_NAME[active]}.`;
}

/**
 * What is unavailable in THIS session — empty on WebGL, since nothing is
 * unavailable there. Answers "what can the renderer I am running not do",
 * which is the question a startup diagnostic asks.
 *
 * For "could this PROJECT switch to WebGPU", which must answer while still on
 * WebGL, use `scanProjectForWebGpu()` — it reads the catalogue above directly.
 */
export function unportedOnWebGpu() {
  if (!usesNodes()) return [];
  return WEBGPU_UNPORTED.map((e) => ({ ...e }));
}
