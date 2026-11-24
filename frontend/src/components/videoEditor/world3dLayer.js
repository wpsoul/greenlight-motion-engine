/*
 * The Scene layer's bridge to the world renderer.
 *
 * The world runs on its own GPU device with its own three (src/world3d/host.js, prebuilt into public/world3d). Each frame
 * it paints one canvas, the picture over its depth; this module turns that into what the compositor already understands
 * from a model pass: a colour plate and a real depth texture in the compositor's near/far. Keyframes, parents, the camera
 * and every gizmo stay the editor's; only the picture comes from elsewhere.
 *
 * Nothing here loads unless a project's Rig asks for the world. The Scene draws only on the WebGPU engine (the owner's call,
 * 2026-11-09): on the WebGL engine, or on a computer with no WebGPU at all, nothing loads either, and the Scene and what the world
 * would draw give way to a notice that says why (watchWorldBlock, WorldNeedsWebGpu.jsx). Exports of a Scene render on WebGPU
 * whatever the preview runs (VideoProjectRenderPage.jsx).
 */
import * as THREE from 'three';
import { materials as makeMaterial } from './materialFactory';
import { cameraProxyFromPose } from './projectCamera';
import { cameraLayerShot } from './cameraLayerShot';
import { travel } from '../../world3d/cameraPath.js';
import { getCameraDofSettings } from './projectCamera';
import { normalizeRig, resolveRigAt, sceneTimeAt, shutterEntries, sphericalFromVector } from './rig3d';
import { findBlockingMuteRigAt } from './rigAiVideo.js';
import { WORLD_UNITS, worldCamera, worldLens, worldLiveValues, worldMatrix, worldSceneFromRig, worldSteer } from './world3dScene.js';
import { resolveActiveIndex } from './engine/compositeHelpers';
import { liveSceneSurfaces } from './liveLayers';
import { envStrengthShadowed } from '../../world3d/schema/envStrength.js';
import { rigUsesWorld } from './rig3d';
import { isAutoFillEnabled, resolveAutoFillParams } from './autoFillLayer';
import { isModelFxOverlay, isWorldModelFx, LEAVES_WORLD_FX_IDS, modelLeavesWorldAt, NOT_IN_WORLD_FX_IDS } from './model3dFxCatalog';
import { flatLettersViewMatrix, glyphArrays, glyphIdOf, lettersOnParent, worldFlatLetters, worldParentOf, worldTextLayers, worldTextLetters } from './world3dText';
import { sampleField } from '../../world3d/keys.js';
import { hasAudioClocks, placeAudioClocks, timelineAudioItems, withWorldClocks } from '../../world3d/audioClock.js';
import { meshStoreKey } from '../../world3d/meshKey.js';
// (physcam) the camera as a device: its auto-exposure's meter and filter, the picture-only fields taken in place
import { AE_STEP, aeAt, aeGrid, aeSpec, splitCameraFilm, withDevice } from '../../world3d/render/deviceCamera.js';
import { physicalExposure } from '../../world3d/render/exposure.js';
import { TRACE_UNSET, PREP_WAIT_MS, finalFrameBudgetMs, finalTraceOptions } from './finalTrace.js';
import { shutterClockIn, shutterExposureAt, shutterGraphsIn, shutterLiveValues, shutterRigIn, shutterTimes } from './worldShutter.js';
import { hasLayerFilters, worldFxEffects, worldFxList } from './world3dFx';
import { getItemKeyframeValues, integratePathRate, itemHasKeyframes } from './gsapTransitions';
import { posterizedTimeInClip } from './posterizeTime';
import { sceneObjectMatrix } from './modelPose';
import { heldModelMatrix, orderModelPoses } from './handPose';
import { createScenePoser } from './scenePose.js';
import { probeWebGpuAdapter, selectedBackend } from './videoRenderer.js';
import { browserHandoffClock, createWorldHandoff } from './worldHandoff.js';
import { getTrackMatte, worldMaskKey } from './trackMatte';
import { frameFaultPlan, noticeWatch } from './worldFrameGuard.js';
import { localPrs } from './keyframeParenting';
import { isText3dLayer } from './text3d.js';
import { alignShutterLetters } from './shutterLetters.js';
import { detectStripeCorruption, emptyKind, frameFaultOn, pixelSpread } from './frameGuard.js';
import { readTargetPixels } from './readTargetPixels';
import { subjectBounds } from '../../world3d/multiView.js';

// Where the world's files are (world3d.js, its eval / rigid / sim bundles and the denoiser weights): world3d/ next to the page in the
// app. A host that loads the engine from somewhere else (the motion engine from a CDN, a chat frame whose page has no address of its
// own) says where they are (setWorldBase), before the first Scene loads.
let worldBase = null;
export function setWorldBase(url) {
  worldBase = url ? String(url).replace(/\/?$/, '/') : null;
}
export const worldFileUrl = (name) => new URL(name, worldBase || new URL('world3d/', document.baseURI).href).href;
const hostUrl = () => worldFileUrl('world3d.js');
// (motion3d) A host whose world is a plugin of its own (the motion engine: greenlight-motion-3d, from a folder the page names or the CDN)
// finds out where it is, once, when the first Scene needs the world (motionEngine/world3dPlugin.js). The app has none: world3d/ next to
// the page, as before.
let worldResolver = null;
export function setWorldResolver(fn) {
  worldResolver = typeof fn === 'function' ? fn : null;
}
const weightsUrl = (size = 'small') => worldFileUrl(`rt_hdr_calb_cnrm_${size}.tza`);

/** The world camera's near and far until it says otherwise, in world units: its planes follow its set (WorldRenderer #fitClip), and the
 *  plate reads them each frame. */
const WORLD_NEAR = 0.02, WORLD_FAR = 200;

// The headless render page (App.jsx routes it by its path): nobody watches it, and all it draws is taken away. Its window.__videoRender
// is withdrawn and published again on every new project, and a frame drawn in between must not take it for the preview.
const RENDER_PAGE = typeof window !== 'undefined' && window.location?.pathname === '/video-render';

const state = { load: null, loadShown: false, loadTimer: null, loadListeners: new Set(),
  host: null, loading: null, failed: null,
  key: null, building: false, ready: false,
  builds: 0, // world loads and scene builds started, counting up (worldBuildsStarted)
  // builtKey is the scene the world holds, builtItems the model layers in it (builtNodes: each one's objects there); generation counts
  // project switches (worldProjectChanged),
  // taken when a build starts
  builtKey: null, builtItems: null, builtNodes: null, hidden: null, builtGeneration: 0, generation: 0,
  plateGeneration: -1, // the generation whose finished frame the plate holds; -1 is none
  previewGeneration: -1, previewMeta: null, solidPreview: null, // loading preview (background / unstyled clay) while a fresh or switched Scene builds
  poseKey: null, posed: null, final: false, filming: false, filmedPose: null, traceOptions: null, touched: 0, pumping: false, fresh: false,
  plate: null,        // { texture, target, material, scene, width, height, camera }
  // (badframes) while a render's frames are checked (worldGuardSampling): the plate's sample drawn and its read started as the plate fills
  guardSampling: false, plateSampleRead: null,
  sceneError: null, sceneWarnings: [], listeners: new Set(),
  // Why the Scene cannot draw here (watchWorldBlock): the engine the Player was built on, this computer's WebGPU (asked once, kept for
  // the page's life), and the reason when it has none.
  engineBackend: null, probe: null, unavailable: null, block: null, blockListeners: new Set(),
  // (engine100) frames in a row the preview could not draw, the timer that draws again, and the loading notice's 20 s watch
  frameFaults: 0, faultTimer: null, noticeWatch: null,
  // (hdr2) an HDR render's float composite of the frame just drawn (worldReplay): the world draws nothing, and its layer shows `texture`
  replay: null,
  // (multiview) temporary diagnostic camera override `{ at, target, up, fov }` in world metres for multi-angle still checks, and whether
  // those captures film a Final Scene in Draft (filmsFinal)
  diagnosticCamera: null, diagnosticDraft: false,
  // (audio clocks) the timeline's items with sound, listed for the timeline they were read from (prepareWorldFrame placeClocks), and the model
  // module the world's built scene was handed to
  audioItems: null, sceneSourceFor: null,
};
// (multiview) a Scene filmed in Final: not while diagnostic views are drawn in Draft (setWorldDiagnosticView), which needs no rebuild
const filmsFinal = (rig) => rig?.render?.mode === 'final' && !state.diagnosticDraft
  && rig?.prerenderLook !== 'clay' && rig?.prerenderLook !== 'blocking';
const rigWantsNoWorldText = (env) => (env?.channels || []).some(
  (ch) => ch?.kind === 'rig' && (ch.items || []).some((it) => it?.rig?.excludeWorldText),
);
// (engine100) a notice that shows one stage for 20 s says so once, with what the world is waiting on; a world built and waiting on its
// first picture is asked for a frame, in case nothing else will (worldFrameGuard.js)
state.noticeWatch = noticeWatch({ onStuck: (stage, ms) => {
  const w = state.host?.world;
  console.warn(`[world3d] the 3D Scene's loading notice (${stage}${stage === 'frame' ? ': Preparing the picture' : ''}) has shown for ${Math.round(ms / 1000)} s`, JSON.stringify({
    ready: state.ready, building: state.building, builds: state.builds, faults: state.frameFaults,
    world: w ? { builds: w.builds, prepared: w.prepared, preparing: !!w.preparing, envVisPending: !!w.envVisPending, envVisPendingKey: w.envVisPendingKey ?? null,
      traceWanted: !!w.traceWanted, json: !!w.json } : null,
  }));
  const engine = state.engine;
  if (stage === 'frame' && state.ready && !state.building && engine && !engine.isPlaying && !engine.exporting) engine.renderFrame?.();
} });

if (import.meta.env?.DEV && typeof window !== 'undefined') window.__world3d = state;

export const isWorldRig = rigUsesWorld;
// (filmbugs) the Scene layers this frame's world is drawn from: a sub-frame of a render's motion blur keeps the frame's own (rig3d.js shutterEntries)
const rigEntriesOf = (engine) => shutterEntries(engine?.rigEntries, engine?.shutterFrameTime);
/** (filmbugs) Whether a Scene layer is on the timeline at `time` (a sub-frame: at its frame's own time): only then is the world's picture in
 *  the frame. Past a Scene layer's clip the Rig is held for the lights of the model layers (activeRigAt), but its channel draws nothing: a
 *  render traced the world there all the same, under an end card or a page that hid it or over the bare background (the Pulse film's end
 *  card with no Scene under it: 16 traces a frame for a picture nobody saw, flagged black), and a farm job sent those frames to the pods. */
export function worldSceneOn(engine, time) {
  const at = Number.isFinite(engine?.shutterFrameTime) ? engine.shutterFrameTime : time;
  return (engine?.rigEntries || []).some((e) => at >= e.startTime - 1e-6 && at <= e.endTime + 1e-6);
}
const renderingNow = (engine) => !!engine.exporting || typeof window.__videoRender !== 'undefined';
/** (audio clocks) A Rig's scene as the editor reads its objects' places and poses its rigs: with the clocks the world baked, so a layer riding
 *  an object an audio clock drives moves as the object does in the world. The scene itself when it has no audio clock. */
const worldClocksScene = (scene) => withWorldClocks(scene, state.host?.scene);
const builtScene = () => state.host?.scene ?? null;

// A render's frame reads the world's canvas only as its first read since a rendering update (worldHandoff.js).
const worldHandoff = createWorldHandoff(browserHandoffClock());
/** Before a still's kept repaint: waits, when the canvas was read since the last rendering update, for that update (`update`:
 *  worldHandoff.watch, started while the frame settled) and then for any read made meanwhile. True when it waited. */
async function worldHandoffReady(update) {
  if (!worldHandoff.needs()) return false;
  await update;
  await worldHandoff.fresh();
  return true;
}

// (lookfix) The trace options a render's Final frame takes (the keys rig.render leaves out at their defaults, the radiance cache, Steady), the
// frame's time limit and the prep's wait: finalTrace.js, which the render farm's pods read too.
export { finalFrameBudgetMs };

/** What a Final had to get going again (WorldRenderer's "Stall" second line: pixels put back into the trace, a sample count measured
 *  again, a denoise pass started again, the denoiser left out), for a render's report: `n` is the running count, `since` an earlier `n`
 *  to get only what came after it. */
export function worldRecoveries(since = 0) {
  const w = state.host?.world;
  return { n: w?.recoveryN || 0, events: (w?.recoveries || []).filter((e) => e.n > since).map((e) => e.detail) };
}

/** (renderpro) What failed in this world, machine-readable: { code, kind, message } (the backend's render_pro.ERROR_CODES): the scene
 *  build (geometry or material), an object drawn grey for want of its material, the GPU (memory, a buffer past the device's largest, the
 *  device lost, other errors it raised), the denoiser (failed to load, a pass started again). Empty when all is well. */
export function worldErrors() {
  const out = [];
  if (state.sceneError) {
    const msg = String(state.sceneError);
    const material = /material|texture|graph|procedural|shader/i.test(msg) && !/\bop\b|node|graph\[/i.test(msg);
    const file = /load|fetch|404|not found|missing/i.test(msg) && /\.(glb|gltf|obj|ply|splat|ksplat|spz|blend|hdr|exr|png|jpe?g|webp)\b/i.test(msg);
    // an op that made more than the page can hold (a sphere of 6000 rings: "Invalid array length")
    const big = /invalid array length|array buffer allocation failed|out of memory|maximum call stack/i.test(msg);
    out.push({ code: big ? 'SCENE_TOO_BIG' : file ? 'GEOMETRY_MISSING_FILE' : material ? 'MATERIAL_FAILED' : 'GEOMETRY_FAILED', kind: material ? 'material' : 'geometry',
      message: big ? `${msg.slice(0, 400)}: the object is too big to build here; lower its segments, rings, subdivision levels or copies` : msg.slice(0, 600) });
  }
  for (const w of state.sceneWarnings || []) {
    if (/material ".*" is not defined/.test(String(w))) out.push({ code: 'MATERIAL_UNDEFINED', kind: 'material', message: String(w) });
  }
  const world = state.host?.world;
  if (world) {
    const fatal = world.gpuFatal?.(0);
    if (fatal) out.push({ code: fatal.code, kind: 'gpu', message: fatal.message });
    for (const g of world.gpuErrors || []) {
      if (fatal && (/OutOfMemory/i.test(g.type) || fatal.message.includes(g.message))) continue;
      out.push({ code: 'GPU_VALIDATION', kind: 'gpu', message: `${g.type}: ${g.message}`.slice(0, 600), ...(g.count > 1 ? { count: g.count } : {}) });
    }
    for (const r of world.recoveries || []) {
      if (r.kind === 'denoise-load' || r.kind === 'denoise-again') out.push({ code: 'DENOISER_FAILED', kind: 'denoiser', message: String(r.detail) });
    }
  }
  return out;
}

/** (simgaps) What went wrong while the Scene's sims ran (sim/world/worldSims.js runWarnings): a grid's memory that ran out at its most,
 *  drops of spray left out. For a render's report; [] when nothing did. */
export function worldRunWarnings() {
  try { return state.host?.world?.simWorld?.runWarnings || []; } catch { return []; }
}

/** What the last scene build said, for a server still: an agent cannot see the Scene panel, and a failed op leaves the old picture.
 *  `inspect` adds each object's bounds and ground gap, the pairs that touch, and what the scene's camera has in frame. */
/** (bottlefix) The caustic pass's specks in the frame drawn last (WorldRenderer causticSpecks): null where the pass did not run. */
export async function worldCausticSpecks() {
  const w = state.ready ? state.host?.world : null;
  return w?.causticSpecks ? w.causticSpecks() : null;
}

export function worldSceneReport({ inspect = false, critique = false, objects = null, time: timelineTime = null } = {}) {
  if (!state.key) return null;
  // the poses' reports are kept by the Scene's own time (rig3d.js sceneTimeAt)
  const time = Number.isFinite(timelineTime) ? sceneTimeAt(state.engine?.rigEntries, timelineTime) : timelineTime;
  // (simgaps) and what went wrong while the sims ran to this frame (a grid's memory out at its most, drops of spray left out)
  const notes = [state.passNote, state.envNote, ...worldRunWarnings()].filter(Boolean);
  const report = { built: state.ready, error: state.sceneError, warnings: notes.length ? [...(state.sceneWarnings || []), ...notes] : state.sceneWarnings };
  // (renderpro) the same, machine-readable: { code, kind, message } for what failed (the backend's render_pro.ERROR_CODES)
  const errors = worldErrors();
  if (errors.length) report.errors = errors;
  if (inspect && state.ready) report.inspect = state.host.inspect();
  // (physcam) the scene camera's auto-exposure on this frame: the stops it added (log2 of its gain) and how many meter samples it read
  if (state.meter?.now && state.ready) {
    const g = state.host.world.aeGain ?? 1;
    const m = state.meter;
    const trace = inspect ? [] : null;
    const e = Number.isFinite(time) ? aeAt(time, m.now.spec, (k) => m.samples.get(k) || null, trace) : null;
    // (filmbugs) what this frame was drawn with (meterDrawn), not the world's gain now; left out when the frame was not drawn here
    const drawn = Number.isFinite(time) ? m.drawnAt?.get(Math.round(time * 1e4)) : null;
    report.autoExposure = { stops: +(e ?? Math.log2(g)).toFixed(4), samples: m.samples.size, ...(Number.isFinite(drawn) ? { drawnWith: +drawn.toFixed(4) } : {}),
      // with `inspect`: the meter's steps over the window before this frame (Scene seconds, the stops it wanted, the stops it had)
      ...(trace?.length ? { steps: trace.map((r) => [+r.t.toFixed(3), +r.target.toFixed(3), +r.e.toFixed(3)]) } : {}) };
  }
  // (pose) a posed model layer's warnings (a clip, morph or bone its file does not have), and with `inspect` what its file offers and what
  // its constraints reached this frame (model3dLayer.js modelPoseReport)
  const mod = state.engine?.model3d;
  if (mod?.modelIsPosed) {
    const ids = [...(state.builtNodes?.keys() || [])].filter((id) => mod.modelIsPosed(id));
    const reports = new Map(ids.map((id) => [id, mod.modelPoseReport(id, time)]));
    const extra = ids.flatMap((id) => (reports.get(id)?.warnings || []).map((w) => `model layer "${id}": ${w.message}`));
    if (extra.length) report.warnings = [...(report.warnings || []), ...extra];
    if (inspect && ids.length) report.poses = Object.fromEntries(reports);
  }
  // (rigging) Scene objects with a skeleton: what binding found (joints, the landmarks it placed from the shape, the checks) and, posed,
  // what their pose warned about and reached; a model layer's skeleton is in its pose report
  const world = state.ready ? state.host?.world : null;
  if (world?.rigs?.size) {
    const posed = state.scenePoser;
    const extra = [];
    for (const id of world.rigs.keys()) for (const w of posed?.report(id, time)?.warnings || []) extra.push(`scene object "${id}": ${w.message}`);
    if (extra.length) report.warnings = [...(report.warnings || []), ...extra];
    if (inspect) {
      report.skeletons = Object.fromEntries([...world.rigs.entries()].map(([id, r]) => [id, { joints: r.joints.map((j) => ({ name: j.name, parent: j.parent >= 0 ? r.joints[j.parent].name : null, at: j.at })), landmarks: r.landmarks, found: r.found, report: r.report, warnings: r.warnings }]));
      for (const id of posed?.ids() || []) (report.poses ||= {})[id] = posed.report(id, time);
    }
  }
  // `critique`: what the shot shows object by object and where the lights stand (world3d/critique.js); the server adds the picture's numbers
  if (critique && state.ready && state.host.critique) {
    try { report.critique = state.host.critique({ objects }); } catch (error) { report.critique = { error: String(error?.message || error) }; }
  }
  if (critique && state.ready && state.host.world?.simWorld?.report) {
    report.sims = state.host.world.simWorld.report;
  }
  return report;
}

/** (agentsims) "ops[2].snippet line 4: …", "… (snippet body line 3): …" → { line, message }; any other message as it is. */
const simError = (m) => {
  const s = String(m);
  const line = s.match(/snippet line (\d+): /)?.[1] ?? s.match(/body line (\d+)/)?.[1];
  return line ? { line: Number(line), message: s } : { message: s };
};

/**
 * (agentsims) An agent's check of one of the Scene's sims (/api/world3d/sim-check, the render page's simCheck): what its build said
 * (errors with the line of the agent's body they are on, warnings, the gate on a device of its own, the stage order and budgets), then,
 * when it runs, each set's numbers over its first `frames` (sim/world/worldSims.js check) and the cost of a frame. Draws nothing itself.
 */
export async function worldSimCheck({ id = null, seconds = null, every = null, bounds = null, watch = [] } = {}) {
  const world = state.ready ? state.host?.world : null;
  if (!world) return { ok: false, stage: 'scene', errors: [{ message: state.sceneError ? `the Scene did not build: ${state.sceneError}` : 'no 3D Scene is built on this page' }] };
  const sims = world.simWorld;
  const report = sims?.report || [];
  const entry = id ? report.find((r) => r.id === id) : report[0];
  if (!entry) return { ok: false, stage: 'scene', errors: [{ message: id ? `the Scene has no sim "${id}" (it has ${report.map((r) => `"${r.id}"`).join(', ') || 'none'})` : 'the Scene has no sims' }] };
  const out = { id: entry.id, key: entry.key, warnings: entry.warnings, order: entry.order, budgets: entry.budgets, ...(entry.gate ? { gate: entry.gate } : {}) };
  if (entry.errors.length) {
    const stage = entry.gate && !entry.gate.ok ? entry.gate.stage : entry.errors.some((e) => /WGSL|snippet body line/.test(e)) ? 'wgsl' : 'compile';
    return { ...out, ok: false, stage, errors: entry.errors.map(simError) };
  }
  // `seconds` of its clip after its pre-roll (all of it when not given)
  const item = sims.items.find((x) => x.id === entry.id);
  const frames = item && Number.isFinite(seconds) ? Math.round((item.plan.clip.preroll + seconds) * item.plan.fps) : null;
  const run = await sims.check(entry.id, { frames, every, bounds, watch: Array.isArray(watch) ? watch.filter((a) => typeof a === 'string').slice(0, 16) : [] });
  if (!run) return { ...out, ok: false, stage: 'run', errors: [{ message: `sim "${entry.id}" built but did not start (see warnings)` }] };
  const lastRow = run.series[run.series.length - 1];
  const sum = (k) => Object.values(lastRow.sets).reduce((s, x) => s + (x[k] || 0), 0);
  const problems = [];
  if (sum('nonFinite')) problems.push({ message: `${sum('nonFinite')} particles are NaN or infinite at frame ${lastRow.frame}` });
  if (sum('faulted')) problems.push({ message: `${sum('faulted')} particles had a step of the program give NaN or infinity (each such step dropped)` });
  // (it ran: a NaN is a problem of the program, reported at stage "run"; the scene never saw it)
  return { ...out, ok: !problems.length, stage: problems.length ? 'run' : 'passed', errors: problems, ...run };
}

// The layer's blur, keyed or not: it moves the picture, so the world cannot lay it on the object in place.
const isBlurred = (item) => (item?.filterBlur || 0) > 0 || item?.propertyKeyframes?.blur?.length > 0;

// The layer's own colour filters (static values) and blur.
const isPlainPicture = (item) => (item?.filterBlur || 0) === 0 && !item?.filterHueRotate && !item?.filterGrayscale && !item?.filterSepia && !item?.filterInvert
  && [item?.filterBrightness, item?.filterContrast, item?.filterSaturation].every((v) => v == null || v === 100);

/** 3D Text in a world Scene (world3dText.js): the world lays effects, colour filters and Grow Fill on model layers only, so a text layer
 *  that carries any of them keeps its own pass, where they run as always, and takes its place in the world by depth. */
export const textKeepsOwnPass = (item) => isAutoFillEnabled(item) || !!item?.effects?.some?.((e) => isModelFxOverlay(e) || e?.enabled !== false)
  || !isPlainPicture(item);

/** The blur, a flat effect and the six that move the picture off the surface (LEAVES_WORLD_FX_IDS, while one is live) run inside a model's
 *  own pass, on its own picture. Such a layer keeps that pass, and takes its place in the world by depth, so nothing a project already has
 *  goes missing when it joins one; out of the world it casts no shadow and Final does not trace it. The world's own effects (WORLD_FX_IDS),
 *  the layer's other colour filters and Grow Fill (the object's own material there) keep the model in the world; the effects not offered
 *  there (NOT_IN_WORLD_FX_IDS) count for nothing. `at()` is this frame's liveness context for the six (modelFxLiveAt), asked for only
 *  when the layer carries one of them. */
export const modelKeepsOwnPass = (item, at = null) => isBlurred(item)
  || !!item?.effects?.some?.((e) => !isWorldModelFx(e) && !NOT_IN_WORLD_FX_IDS.has(e?.id) && !LEAVES_WORLD_FX_IDS.has(e?.id)
    && (isModelFxOverlay(e) || e?.enabled !== false))
  || (!!at && !!item?.effects?.some?.((e) => LEAVES_WORLD_FX_IDS.has(e?.id)) && modelLeavesWorldAt(item, at()));

/** A model layer's effect liveness context at `time`, read on the layer's own clock as its pass reads it (channelRender: Posterize Time,
 *  keyframes at that progress, the master Amount), so the world and the model's own pass agree on which frames it leaves the world. */
export function modelFxLiveAt(item, { startTime, duration }, time) {
  const clipNow = posterizedTimeInClip(item, time - startTime, duration);
  const kf = itemHasKeyframes(item) ? getItemKeyframeValues(item, Math.max(0, Math.min(1, clipNow / duration))) : null;
  return { kf, time: Math.max(0, clipNow), duration, master: Number.isFinite(kf?.effectAmount) ? Math.max(0, Math.min(1, kf.effectAmount)) : 1 };
}

/** How far a loading scene has got, in the player bar. Most builds are over in a moment, so nothing shows for the first 400 ms: an edit must not flicker. */
function reportLoad(next, now = false) {
  // (robust) after a lost device the notice says so until the Scene is drawn again (recoverLostPreview)
  if (next && state.recoverNotice) next = { ...next, recovering: true };
  if (!next) state.recoverNotice = false;
  state.noticeWatch.note(next);
  state.load = next;
  if (!next) {
    clearTimeout(state.loadTimer);
    state.loadTimer = null;
    state.loadShown = false;
  } else if (now) {
    clearTimeout(state.loadTimer);
    state.loadTimer = null;
    state.loadShown = true;
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

// The world brings its own device, and its picture crosses to the WebGPU compositor as a canvas.
const onWebGpu = (engine) => engine?.renderer?.isWebGPURenderer === true;

/** Whether a Scene on this frame gives way to the notice: the editor is on WebGL, or this computer has no WebGPU. Then the world never
 *  loads, the Scene layer draws nothing, and neither do the models and 3D Text the world would hold (channelRender.js). */
export const worldBlockedOn = (engine) => !onWebGpu(engine) || !!state.unavailable;

function blockNow() {
  if (state.unavailable) return { kind: 'no-webgpu', reason: state.unavailable };
  return (state.engineBackend || selectedBackend()) === 'webgpu' ? null : { kind: 'engine' };
}

function publishBlock() {
  const next = blockNow();
  if (next?.kind === state.block?.kind && next?.reason === state.block?.reason) return;
  state.block = next;
  for (const f of state.blockListeners) f(next);
}

/** Whether this computer can run WebGPU at all: an adapter request, asked once a Scene is open (a 2D project never asks). */
function probeWebGpu() {
  state.probe ??= probeWebGpuAdapter().then((probe) => {
    if (!probe.ok) { state.unavailable = probe.reason || 'no adapter'; publishBlock(); }
    return probe;
  });
  return state.probe;
}

/** The engine the Player was just built on ('webgl' or 'webgpu'), so the Scene panel's notice follows a switch. */
export function setWorldEngine(backend) {
  state.engineBackend = backend === 'webgpu' ? 'webgpu' : 'webgl';
  publishBlock();
}

/** Why a Scene cannot draw here, as it changes: null, { kind: 'engine' } (the editor is on WebGL) or { kind: 'no-webgpu', reason }
 *  (this computer has no WebGPU). On WebGL the first call asks for an adapter, to tell the two apart. Returns the unsubscribe. */
export function watchWorldBlock(listener) {
  state.blockListeners.add(listener);
  state.block = blockNow();
  listener(state.block);
  if ((state.engineBackend || selectedBackend()) !== 'webgpu') probeWebGpu();
  return () => state.blockListeners.delete(listener);
}

function requestHost(engine, W, H) {
  if (state.loading) return state.loading;
  state.builds += 1;
  reportLoad({ stage: 'starting' });
  const repaint = () => { if (!engine.exporting && !engine.isPlaying) engine.renderFrame?.(); };
  const gpu = typeof navigator !== 'undefined' && !!navigator.gpu;
  const where = gpu && worldResolver ? Promise.resolve().then(worldResolver) : null;
  state.loading = (gpu ? (where ? where.then(() => import(/* @vite-ignore */ hostUrl())) : import(/* @vite-ignore */ hostUrl())) : Promise.reject(new Error('navigator.gpu is not present')))
    .then((m) => m.createWorldHost({ width: W, height: H, oidnWeights: weightsUrl(), oidnWeightsLarge: weightsUrl('large'), nativeOidnUrl: '/api/world3d/oidn', guestUrl: worldFileUrl('world3d-eval.js'), rigidUrl: worldFileUrl('world3d-rigid.js'), simUrl: worldFileUrl('world3d-sim.js'), texGraphUrl: worldFileUrl('world3d-texgraph.js') }))
    .then((host) => {
      state.host = host;
      // (robust) the preview's world lost its GPU device: loaded again on a new one (recoverLostPreview)
      host.world.onDeviceLost = () => recoverLostPreview(host);
      // (robust) a world made while Final is on (after a lost device) takes the player bar's Final options at once
      if (state.final && state.traceOptions) host.world.setTraceOptions({ ...TRACE_UNSET, ...state.traceOptions, radianceCache: state.traceOptions.radianceCache !== false });
      repaint();
    })
    .catch(async (e) => {
      reportLoad(null);
      // No WebGPU on this computer says so where the Scene would draw (watchWorldBlock); any other failure keeps the Rig's own passes.
      if (!(await probeWebGpu()).ok) { repaint(); return; }
      state.failed = e;
      console.warn('[world3d] staying on the Rig passes:', e);
    });
  return state.loading;
}

// What a layer on the timeline asks the world for. Built once per model, since a shape's arrays do not change with time. `fx` is each
// model's live effects this frame, for the world to lay on its object, and `grow` its Grow Fill, for the object's material; neither enters
// the scene, so an effect never rebuilds the world.
function collectModels(engine, env, time, mod) {
  const models = [], materials = {}, parts = [], fx = [], grow = [];
  const blockingMuted = findBlockingMuteRigAt(env.channels, (ch) => env.layoutMap.get(ch.id), time);
  for (const channel of env.channels) {
    if (channel.visible === false || channel.cameraLocked || !channel.items?.length) continue;
    const layout = env.layoutMap.get(channel.id);
    const index = layout ? resolveActiveIndex(layout, time) : -1;
    if (index < 0) continue;
    const item = channel.items[index];
    const clip = env.clipsMap.get(item?.clipId);
    if (clip?.mediaType !== 'model3d' || (blockingMuted && item.aiRole !== 'composite') || !mod.getModelObject(item.id) || modelKeepsOwnPass(item, () => modelFxLiveAt(item, layout[index], time))) continue;
    const url = mod.resolveModelUrlFor(item, clip);
    const physics = item.model3dConfig?.physics;
    const rigid = physics === 'falls' ? { rigid: true } : physics === 'solid' ? { rigid: { fixed: true } } : {};
    // Clip time and keyframes as the layer's own pass reads them (prePoseWorldModels).
    const wantsFx = item.effects?.some?.(isWorldModelFx) || hasLayerFilters(item);
    const growing = isAutoFillEnabled(item);
    let at = null;
    if (wantsFx || growing) {
      const { startTime, duration } = layout[index];
      const clipNow = Math.max(0, time - startTime);
      at = { clipNow, duration, kfNow: itemHasKeyframes(item) ? getItemKeyframeValues(item, duration > 0 ? Math.min(1, clipNow / duration) : 0) : null };
    }
    const live = wantsFx ? worldFxEffects(item, at.kfNow, at.clipNow, at.duration) : [];
    // Grow Fill's progress as its own pass reads it (channelRender): Start Fill plus the integrated Grow Speed.
    let growFill = null;
    if (growing) {
      const params = resolveAutoFillParams(item, at.kfNow);
      const grown = integratePathRate(item, 'afSpeed', params.afSpeed, at.clipNow, at.duration);
      growFill = { params, progress01: Math.min(1, Math.max(0, (params.afProgress + grown) / 100)) };
    }
    if (url && !url.startsWith('model-primitive:')) {
      // (rigging) a file's skeleton made in the project goes with it: the world binds its own copy the same way
      const skeleton = item.model3dConfig?.skeleton && typeof item.model3dConfig.skeleton === 'object' ? { skeleton: item.model3dConfig.skeleton } : {};
      const skinning = item.model3dConfig?.skinning ? { skinning: item.model3dConfig.skinning } : {};
      models.push(mod.isSplatUrl(url) ? { id: item.id, name: channel.name, splat: url, ...rigid } : { id: item.id, name: channel.name, url, ...rigid, ...skeleton, ...skinning });
      // A splat has no surface for a mask; its effects need a pass of their own in the world first.
      if (live.length && !mod.isSplatUrl(url)) fx.push({ itemId: item.id, objects: [item.id], effects: live });
      if (growFill && !mod.isSplatUrl(url)) grow.push({ itemId: item.id, growFill, objects: [item.id], parts: false });
      continue;
    }
    const ids = [];
    (mod.modelBakedParts(item.id) || []).forEach((p, i) => {
      const id = `${item.id}:${i}`;
      materials[id] = { ...p.material, doubleSided: true };
      // `rev` stands for the arrays, which the rebuild key cannot see: a cube swapped for a sphere changes nothing else in the scene.
      models.push({ id, name: channel.name, baked: id, material: id, rev: `${url}|${JSON.stringify(item.model3dConfig?.primitive ?? null)}|${p.position.length}`, ...rigid });
      parts.push({ id, itemId: item.id, part: p });
      ids.push(id);
    });
    // A shape's parts are one object to its effects: one mask, one frame.
    if (live.length && ids.length) fx.push({ itemId: item.id, objects: ids, effects: live });
    if (growFill && ids.length) grow.push({ itemId: item.id, growFill, objects: ids, parts: true });
  }
  return { models, materials, parts, fx, grow };
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

/** Camera and backdrop pose for loading previews (background + unstyled clay), matching `poseWorld` so there is no jump when Draft lands. */
function initialPreviewPose(engine, time, rig, backdrop, excludeIds) {
  const { w: W, h: H } = engine.videoSize;
  const sceneT = sceneTimeAt(rigEntriesOf(engine), time);
  const locked = engine.worldActive;
  const proxy = !locked && engine.cameraPose ? cameraProxyFromPose(engine.cameraPose, W, H) : null;
  const ownCamera = !!rig?.scene?.camera;
  const rest = (H * 0.5) / Math.tan((28 * Math.PI) / 180 / 2);
  const camera = ownCamera ? null : worldCamera(proxy, rest);
  const steer = ownCamera && proxy ? worldSteer(proxy, rest) : null;
  const objects = backdrop ? { backdrop: worldMatrix(backdrop.matrix) } : {};
  return { camera, steer, freeCamera: !ownCamera, time: sceneT, objects, excludeIds };
}

/** Copies a loading preview frame (sky/background or unstyled clay) from the world canvas into the compositor plate and repaints. */
function commitLoadingPreview(engine, generation, meta) {
  if (!meta || generation !== state.generation || state.plateGeneration === generation || state.releasing || !state.host || !engine?.renderer) return;
  const p = ensurePlate(meta.width, meta.height, engine.renderer);
  const r = engine.renderer;
  const bands = meta.bands || 2;
  const m = p.material;
  m.uniforms.uHandoff.value = p.texture;
  m.uniforms.uNear.value = engine.camera?.near ?? 1;
  m.uniforms.uFar.value = engine.camera?.far ?? 100000;
  m.uniforms.uPicY.value.set(1 / bands, (bands - 1) / bands);
  m.uniforms.uBandY.value.set(1 / bands, (bands - 2) / bands);
  m.uniforms.uMaskY.value.set(1 / bands, 0);
  const worldNear = meta.near || WORLD_NEAR, worldFar = meta.far || WORLD_FAR;
  m.uniforms.uWorldNear.value = worldNear;
  m.uniforms.uWorldRatio.value = worldFar / worldNear;
  m.uniforms.uK1.value = 0;
  const tanHalf = Math.tan(((meta.fov || 28) * Math.PI) / 360);
  m.uniforms.uLens.value.set(2 * tanHalf * (meta.width / Math.max(1, meta.height)), 2 * tanHalf);
  if (m.uniforms.uSoften) {
    m.uniforms.uSoften.value = 0;
    m.uniforms.uBlack.value = 0;
    m.uniforms.uGrain.value = 0;
    m.uniforms.uSharpen.value = 0;
    m.uniforms.uBlackTint.value.set(1, 1, 1);
    m.uniforms.uTexel.value.set(1 / Math.max(1, meta.width), 1 / Math.max(1, bands * meta.height));
  }
  p.texture.needsUpdate = true;
  const before = r.getRenderTarget(), autoClear = r.autoClear;
  const slicing = meta.slicing || null;
  const slices = slicing ? slicing.n : 1;
  try {
    for (let k = 0; k < slices; k += 1) {
      if (slicing) {
        if (k > 0) { state.host.world.drawPreviewSlice?.(k); p.texture.needsUpdate = true; }
        const tall = bands * slicing.band;
        const sv = meta.height / tall, o = 1 - (meta.height - k * slicing.rows + slicing.pad) / tall;
        m.uniforms.uPicY.value.set(sv, o);
        m.uniforms.uBandY.value.set(sv, o - 1 / bands);
        m.uniforms.uMaskY.value.set(sv, o - 2 / bands);
        if (m.uniforms.uTexel) m.uniforms.uTexel.value.set(1 / Math.max(1, meta.width), 1 / tall);
        const a = k * slicing.rows, b = Math.min(meta.height, (k + 1) * slicing.rows);
        p.sliceGeometry ??= p.fullGeometry.clone();
        const pos = p.sliceGeometry.attributes.position, uvs = p.sliceGeometry.attributes.uv;
        for (const [i, top] of [[0, true], [1, true], [2, false], [3, false]]) {
          const row = top ? a : b;
          pos.setY(i, 1 - (2 * row) / meta.height);
          uvs.setY(i, 1 - row / meta.height);
        }
        pos.needsUpdate = true; uvs.needsUpdate = true;
        for (const mesh of p.meshes) mesh.geometry = p.sliceGeometry;
      }
      r.autoClear = k === 0;
      r.setRenderTarget(p.target);
      r.render(p.scene, p.camera);
    }
  } finally {
    if (slicing) for (const mesh of p.meshes) mesh.geometry = p.fullGeometry;
    r.setRenderTarget(before);
    r.autoClear = autoClear;
  }
  const range = meta.viewRange || null;
  state.previewGeneration = generation;
  state.previewMeta = {
    viewDistance: range ? ((range.near + range.far) / 2) / WORLD_UNITS : (engine.videoSize.h * 0.5) / Math.tan((14 * Math.PI) / 180),
    viewRange: range ? { near: range.near / WORLD_UNITS, far: range.far / WORLD_UNITS } : null,
  };
  if (!engine.isPlaying && !engine.exporting) engine.renderFrame?.();
}

/** Tiny reusable 2x2 solid display-colour texture for frame-0 background before the world bundle or HDRI finishes loading. */
function solidBackgroundTexture(r8, g8, b8, fullW, fullH) {
  const key = `${r8},${g8},${b8}`;
  if (!state.solidPreview) {
    const data = new Uint8Array([r8, g8, b8, 255, r8, g8, b8, 255, r8, g8, b8, 255, r8, g8, b8, 255]);
    const tex = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.colorSpace = THREE.NoColorSpace;
    tex.magFilter = tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    state.solidPreview = { key, texture: tex };
  } else if (state.solidPreview.key !== key) {
    const data = new Uint8Array([r8, g8, b8, 255, r8, g8, b8, 255, r8, g8, b8, 255, r8, g8, b8, 255]);
    state.solidPreview.texture.image.data.set(data);
    state.solidPreview.texture.needsUpdate = true;
    state.solidPreview.key = key;
  }
  state.solidPreview.texture.userData.fullW = fullW;
  state.solidPreview.texture.userData.fullH = fullH;
  return state.solidPreview.texture;
}

/**
 * What the Scene layer shows while a fresh or switched 3D Scene is still loading (editor preview only; never on exports/stills):
 * first the rendered background or unstyled clay preview plate if available, else the scene's solid background colour on frame 0
 * (leaving cyclorama scenes to `renderRigLayer` and transparent-sky scenes transparent).
 */
export function worldLoadingPreview(engine, rig) {
  if (!engine || renderingNow(engine) || engine.worldFrameReady || !isWorldRig(rig) || rig?.muteBlocking === true || worldBlockedOn(engine) || state.failed) return null;
  if (state.previewGeneration === state.generation && state.plate?.renderer === engine.renderer) {
    return {
      texture: state.plate.target.texture,
      depthTexture: state.plate.target.depthTexture,
      viewDistance: state.previewMeta?.viewDistance ?? null,
      viewRange: state.previewMeta?.viewRange ?? null,
    };
  }
  if (rig.cyclorama?.shape && rig.cyclorama.shape !== 'none') return null;
  const { w: W, h: H } = engine.videoSize || { w: 1920, h: 1080 };
  const env = rig.scene?.env;
  const bg = env?.background;
  if (typeof bg === 'string' && bg !== 'env' && bg !== 'none') {
    const c = new THREE.Color();
    try { c.set(bg); } catch { return null; }
    const srgb = { r: 0, g: 0, b: 0 };
    c.getRGB(srgb, THREE.SRGBColorSpace);
    return {
      texture: solidBackgroundTexture(Math.round(srgb.r * 255), Math.round(srgb.g * 255), Math.round(srgb.b * 255), W, H),
      depthTexture: null, viewDistance: null, viewRange: null,
    };
  }
  if ((bg === 'env' || bg === undefined) && env?.opaque && Array.isArray(env?.flat) && env.flat.length >= 3) {
    const exp = (Number.isFinite(rig.exposure) ? rig.exposure : 1) * (Number.isFinite(env.intensity) ? env.intensity : 1);
    const toByte = (v) => {
      const lin = Math.max(0, Number(v) || 0) * exp;
      const mapped = lin / (1 + lin);
      const s = mapped <= 0.0031308 ? 12.92 * mapped : 1.055 * (mapped ** (1 / 2.4)) - 0.055;
      return Math.max(0, Math.min(255, Math.round(s * 255)));
    };
    return { texture: solidBackgroundTexture(toByte(env.flat[0]), toByte(env.flat[1]), toByte(env.flat[2]), W, H), depthTexture: null, viewDistance: null, viewRange: null };
  }
  return null;
}

async function buildScene(engine, scene, parts, backdrop, { generation = state.generation, time = 0, rig = null, excludeIds = null } = {}) {
  const { host } = state;
  if (!state.load) reportLoad({ stage: 'objects' });
  // Placement arrives with each frame's pose, so the arrays themselves stand at the origin.
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (backdrop) host.setBaked('backdrop', { ...backdrop, matrix: IDENTITY });
  for (const { id, part } of parts) host.setBaked(id, { ...part, matrix: IDENTITY });
  const wantsPreview = !renderingNow(engine) && state.plateGeneration !== generation;
  const previewPose = wantsPreview ? initialPreviewPose(engine, time, rig, backdrop, excludeIds) : null;
  const hdriPromise = scene.env.hdri && !scene.env.sky ? host.loadHdri(scene.env.hdri) : Promise.resolve();
  let clayStarted = false;
  const bgPreview = wantsPreview ? hdriPromise.then(async () => {
    if (clayStarted || generation !== state.generation || state.plateGeneration === generation || state.releasing) return;
    const meta = await host.renderPreviewBackground?.(scene, previewPose);
    if (!clayStarted && meta) commitLoadingPreview(engine, generation, meta);
  }).catch(() => {}) : Promise.resolve();
  await Promise.all([
    ...(scene.objects || []).filter((o) => o.model).map((o) => host.loadModel(o.model)),
    ...[...new Set((scene.objects || []).flatMap((o) => [o.splat, ...(Array.isArray(o.graph) ? o.graph.filter((n) => n?.op === 'splat' && typeof n.source === 'string').map((n) => n.source) : [])]).filter(Boolean))].map((u) => host.loadSplat(u)),
    // (audio clocks) each song once, however many clocks read it
    ...[...new Set(Object.values(scene.clocks || {}).map((c) => c?.audio?.url).filter(Boolean))].map((u) => host.loadAudio?.(u)).filter(Boolean),
    // (screensharp) kept by where the geometry is in its file (meshKey.js), not by `baked`: converted models all name theirs m0_0, …
    ...(scene.objects || []).filter((o) => o.mesh).map(async (o) => { host.setBaked(meshStoreKey(o), await loadMeshFile(o)); }),
    hdriPromise,
  ]);
  clayStarted = true;
  await bgPreview;
  host.world.onProgress = (stage, done, total) => reportLoad({ stage, done, total });
  // (mblur2) a render with motion blur: the sims' Draft draws are built taking the time drawn (reserveWorldMotion)
  if (state.shiftWanted) host.world.wantMotionShift?.();
  state.sceneWarnings = (await host.setScene(scene, wantsPreview
    ? { preview: previewPose, onPreview: (meta) => commitLoadingPreview(engine, generation, meta) }
    : undefined)) || [];
  // (mblur) a render with motion blur: the trace's kernels are built with the shutter's code from the first (reserveWorldMotion)
  if (state.motionWanted) host.world.reserveMotion?.();
  reportLoad({ stage: 'frame' });
  state.poseKey = null;
  state.posed = null;
  // A new splat order lands a few frames after the camera stopped, and a long jump in time solves a little per frame, so a paused
  // frame has to be drawn again to show them.
  host.world.onRepaint = () => {
    state.poseKey = null;
    const e = state.engine;
    if (e && !e.exporting && !e.isPlaying) e.renderFrame?.();
  };
}

/** (octane2) The masks the project's world mattes ask the world for (a layer's `trackMatte` with `objects` or `materials`), from every item on
 *  the timeline in a fixed order, so the same sets are asked on every frame and the first frame of a render already has them. Three at most. */
function worldMaskSets(env) {
  const keys = [], sets = [];
  for (const ch of env?.channels || []) {
    for (const item of ch?.items || []) {
      const matte = getTrackMatte(item);
      const key = worldMaskKey(matte);
      if (!key || keys.includes(key) || keys.length >= 3) continue;
      keys.push(key);
      sets.push({ objects: matte.objects || [], materials: matte.materials || [] });
    }
  }
  return { keys, sets };
}

function ensurePlate(width, height, renderer) {
  const { host } = state;
  let p = state.plate;
  // Tied to the compositor it was made for: a rebuilt one (a lost device, a remount) gets its own, and the switch keeps this module.
  if (p && p.width === width && p.height === height && p.renderer === renderer) return p;
  if (p) { p.target.dispose(); p.shadowTarget.dispose(); p.texture.dispose(); p.material.dispose(); p.shadowMaterial.dispose(); for (const m of p.masks || []) { m.target.dispose(); m.material.dispose(); } }
  const handoff = new THREE.CanvasTexture(host.canvas);
  handoff.colorSpace = THREE.NoColorSpace;
  handoff.magFilter = handoff.minFilter = THREE.NearestFilter;
  handoff.generateMipmaps = false;
  handoff.premultiplyAlpha = false;
  const depthTexture = new THREE.DepthTexture(width, height);
  const target = new THREE.RenderTarget(width, height, { depthBuffer: true, depthTexture, type: THREE.UnsignedByteType });
  target.texture.colorSpace = THREE.NoColorSpace;
  const units = { worldNear: WORLD_NEAR, worldFar: WORLD_FAR, worldUnits: WORLD_UNITS };
  // The node material: the Scene draws only on the WebGPU compositor (worldBlockedOn keeps WebGL from getting here).
  const plateMaterial = () => {
    const m = makeMaterial.worldPlate(units);
    if (!m) throw new Error('A 3D Scene draws only on the WebGPU engine.');
    return m;
  };
  const material = plateMaterial();
  material.uniforms.uHandoff.value = handoff;
  const scene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);
  const shadowTarget = new THREE.RenderTarget(width, height, { depthBuffer: true, type: THREE.UnsignedByteType });
  shadowTarget.texture.colorSpace = THREE.NoColorSpace;
  const shadowMaterial = plateMaterial();
  shadowMaterial.uniforms.uHandoff.value = handoff;
  shadowMaterial.uniforms.uShadow.value = 1;
  const shadowScene = new THREE.Scene();
  const shadowQuad = new THREE.Mesh(quad.geometry, shadowMaterial);
  shadowQuad.frustumCulled = false;
  shadowScene.add(shadowQuad);
  p = state.plate = { renderer, texture: handoff, target, material, scene, shadowTarget, shadowMaterial, shadowScene, width, height, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    // (leftovers-tile) the quads that draw it, and the one a sliced handoff draws each slice's rows with (worldLayerResult)
    meshes: [quad, shadowQuad], fullGeometry: quad.geometry, sliceGeometry: null,
    // (octane2) a world matte's mask k: the same quad drawing the canvas's third band as premultiplied white (made on first use)
    masks: [], maskOf(k) {
      if (!this.masks[k]) {
        const m = plateMaterial();
        m.uniforms.uHandoff.value = handoff;
        m.uniforms.uMask.value = k + 1;
        const t = new THREE.RenderTarget(width, height, { depthBuffer: true, type: THREE.UnsignedByteType });
        t.texture.colorSpace = THREE.NoColorSpace;
        const sc = new THREE.Scene();
        const q = new THREE.Mesh(quad.geometry, m);
        q.frustumCulled = false;
        sc.add(q);
        this.meshes.push(q);
        this.masks[k] = { material: m, target: t, scene: sc };
      }
      return this.masks[k];
    } };
  return p;
}

/**
 * Called once per frame, after every model is posed and before any channel draws. Returns true when this frame's Scene
 * layer will come from the world.
 */
export function prepareWorldFrame(engine, env, time) {
  state.engine = engine;       // a switch of compositor brings a new one, and the world outlives it
  engine.worldFrameReady = false;
  engine.worldTakesText = false;
  engine.worldTextItems = null;
  state.deferred = null;
  engine.worldCameraProxy = null;
  // (camlayer) the world films the Scene's layer through its own lens, Draft included: the compositor leaves it unblurred
  engine.worldLensOwn = false;
  engine.worldLook = null;
  engine.worldShadowTexture = null;
  engine.worldLightWrap = 0;
  // (octane2) the masks the timeline's world mattes ask for, known before the world draws
  const masks = worldMaskSets(env);
  engine.worldMaskKeys = masks.keys;
  state.maskSets = masks.sets;
  const rig = engine.activeRigAt?.(time);
  if (!isWorldRig(rig) || worldBlockedOn(engine) || state.failed) {
    if (!state.building && !state.loading && state.load && state.load.stage !== 'final') reportLoad(null);
    return false;
  }
  // (filmbugs) a render's frame with no Scene layer on the timeline: no world picture in it, none drawn or traced (worldSceneOn)
  if (renderingNow(engine) && !worldSceneOn(engine, time)) return false;
  // (filmbugs) a held frame (worldHold): the world's picture of the frame's own time, traced once with its shutter, stays as drawn while the
  // 2D layers over it are drawn at their sub-frames' times: nothing is posed, metered, drawn or traced
  if (state.hold) {
    engine.worldLensOwn = true;
    const h = state.hold;
    engine.worldCameraProxy = h.cameraProxy; engine.worldLook = h.look; engine.worldLightWrap = h.lightWrap;
    state.fresh = false;
    engine.worldFrameReady = true;
    return true;
  }
  // (enginebugs) a Rig environment strength the Scene's own replaces does nothing: the still's warnings say so (envStrength.js)
  state.envNote = envStrengthShadowed(resolveRigAt(rigEntriesOf(engine), time)?.rig || rig);
  const mod = engine.model3d;
  const { w: W, h: H } = engine.videoSize;
  if (!state.host) { requestHost(engine, W, H); return false; }
  if (!mod?.cycloramaArrays) return false;
  // (audio clocks) a model layer's pose reads Scene objects with the clocks the world baked: handed over once per model module
  if (state.sceneSourceFor !== mod) { mod.setWorldSceneSource?.(builtScene); state.sceneSourceFor = mod; }
  // (mblur5) the Scene layer this frame lays the world out for (a render's shutter takes its poses of it: worldShowsSceneAt)
  state.sceneItem = resolveRigAt(rigEntriesOf(engine), time)?.itemId ?? null;

  const { models, materials, parts, fx, grow } = collectModels(engine, env, time, mod);
  const backdrop = mod.cycloramaArrays(rig, H);
  const options = { W, H, models, materials, backdrop: !!backdrop };
  // (mblur3) for the Rig's keyed lights at the other times of a shutter (shutterLive)
  state.liveOptions = options;
  // (the Rig as it rests too: a scene's own environment follows the Rig's environment keys from it, world3dScene.js)
  const blockingMuted = findBlockingMuteRigAt(env.channels, (ch) => env.layoutMap.get(ch.id), time);
  const sceneRigInput = blockingMuted ? { ...rig, muteBlocking: true } : rig;
  const { look: sceneLook, exposure = 1, ...structure } = worldSceneFromRig(sceneRigInput, { ...options, resting: resolveRigAt(rigEntriesOf(engine), time)?.rig });
  // (audio clocks) a clock on a clip or on the timeline reads the item it names where that item plays: its start, trim and speed, on the
  // Scene's own clock (the timeline's less its item's start, rig3d.js sceneTimeAt). The items are listed again only when the timeline changes.
  const placeClocks = (sc) => {
    if (!hasAudioClocks(sc) || typeof env?.clipsMap?.get !== 'function') return;
    const a = state.audioItems;
    if (!a || a.channels !== env.channels || a.clipsMap !== env.clipsMap || a.layoutMap !== env.layoutMap) {
      state.audioItems = { channels: env.channels, clipsMap: env.clipsMap, layoutMap: env.layoutMap,
        items: timelineAudioItems(env.channels, env.clipsMap, (ch) => env.layoutMap?.get(ch.id)), clips: [...env.clipsMap.values()] };
    }
    const { items, clips } = state.audioItems;
    sc.clocks = placeAudioClocks(sc.clocks, { items, clips, sceneStart: resolveRigAt(rigEntriesOf(engine), time)?.startTime ?? 0 });
  };
  placeClocks(structure);
  // (vfx) a Scene filmed into footage with the footage's softness lays the footage's grain on where its picture joins the footage, after
  // that softness (compositeNodes.js): the world's own pass then films without it, or the blur would take most of it away
  const plateGrain = Number(sceneLook?.soften) > 0 && Number(sceneLook?.grain) > 0 ? Math.min(2, Number(sceneLook.grain)) : 0;
  const look = plateGrain > 0 ? { ...sceneLook, grain: 0 } : sceneLook;
  // (vfx) and the footage's light wrapped onto the objects' edges where the world's picture joins it (adjustmentComposite.js)
  engine.worldLightWrap = Math.min(1, Math.max(0, Number(sceneLook?.wrap) || 0));
  const scene = { ...structure, look, exposure };
  // Film settings change a shader's numbers, so a slider must not rebuild the world. Nor does a Rig's key: it moves the lights, the
  // environment and the backdrop's paint on every frame, which the world takes in place, so the key is the Rig as it rests.
  const restingRaw = resolveRigAt(rigEntriesOf(engine), time)?.rig;
  const resting = blockingMuted && restingRaw ? { ...restingRaw, muteBlocking: true } : restingRaw;
  const keyed = !!restingRaw && restingRaw !== rig;
  const restingScene = keyed ? worldSceneFromRig(resting, options) : null;
  if (restingScene) { delete restingScene.look; delete restingScene.exposure; placeClocks(restingScene); }
  // (physcam) the camera's picture-only fields (its device, auto-exposure, noise, compensation, distortion, ISO, shutter) are taken in place
  // (WorldRenderer.setCameraFilm below), never a rebuild
  const key = JSON.stringify(withoutCameraFilm(restingScene || structure));
  const film = structure.camera ? splitCameraFilm(structure.camera).film : null;
  const filmKey = JSON.stringify(film);
  const lookKey = JSON.stringify([look, exposure]);
  if (lookKey !== state.lookKey && state.ready) {
    state.lookKey = lookKey;
    state.host.world.setExposure(exposure);
    state.host.world.setLook(look);
  }
  // (vfx34) the footage's softness and black level, for the compositor's plate (compositeNodes.js createWorldPlateNodeMaterial)
  state.plateLook = { soften: Math.min(3, Math.max(0, Number(look?.soften) || 0)), black: Math.min(0.15, Math.max(0, Number(look?.black) || 0)), grain: plateGrain,
    sharpen: Math.min(1, Math.max(0, Number(look?.sharpen) || 0)),
    blackTint: Array.isArray(look?.blackTint) && look.blackTint.length === 3 ? look.blackTint.map((v) => Math.min(2, Math.max(0, Number(v) || 0))) : [1, 1, 1],
    seed: Math.floor((Number(time) || 0) * 60) % 4096 };
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
    state.builds += 1;
    state.key = key;
    state.lookKey = lookKey;
    state.filmKey = filmKey;
    state.liveKey = keyed ? liveKey : null;
    const generation = state.generation;
    const items = new Set([...models.filter((m) => m.url || m.splat).map((m) => m.id), ...parts.map((p) => p.itemId)]);
    const nodes = new Map(models.filter((m) => m.url || m.splat).map((m) => [m.id, [m.id]]));
    for (const p of parts) nodes.set(p.itemId, [...(nodes.get(p.itemId) || []), p.id]);
    // who films the shot, known before the build (poseWorld says it again on every frame): a texture graph sizes its bakes for that camera
    state.host.world.freeCamera = !rig.scene?.camera;
    // (sceneswitch) and the frame it is built for: the project's own size, as a world made for this project starts (createWorldHost W x H).
    // A world left at the previous project's frame (Keyboard pillows, portrait) built the next one's shaders and Draft measures at that
    // size and resized after: the night desk after the clover film came out 0.1 level off its fresh picture everywhere
    state.host.world.setSize(Math.max(1, Math.round(W)), Math.max(1, Math.round(H)));
    const excludeIds = new Set([...nodes.values()].flat());
    buildScene(engine, scene, parts, backdrop, { generation, time, rig, excludeIds })
      .then(() => { state.ready = true; state.sceneError = null; state.builtKey = key; state.builtItems = items; state.builtNodes = nodes; state.builtGeneration = generation; })
      .catch((e) => {
        // The scene is wrong, not the renderer: say so on the Scene, keep the Rig's own passes, and try again on the next edit.
        state.ready = false;
        state.previewGeneration = -1;
        state.previewMeta = null;
        reportLoad(null);
        state.sceneError = String(e?.message || e);
        console.warn('[world3d] scene failed:', e);
      })
      .finally(() => {
        state.building = false;
        // (robust) a world given back during its build (a lost device): the preview draws again, on a new one
        if (state.releasing) { releaseWorld(); if (state.recoverAfter) { state.recoverAfter = false; if (!engine.isPlaying) engine.renderFrame?.(); } return; }
        for (const f of state.listeners) f(state.sceneError);
        if (!engine.isPlaying) engine.renderFrame?.();
      });
  }
  // While an edit rebuilds, the last picture stays. Another project's world is not this one: it neither shows nor traces, and the
  // loading notice stands in until this project's scene is built.
  if (state.ready && state.builtKey !== key && state.builtGeneration !== state.generation) {
    state.host.world.setTrace(false);
    if (!state.load) reportLoad({ stage: 'objects' });
    return false;
  }
  if (!state.ready) return false;
  engine.worldLensOwn = true;
  // (physcam) the camera's picture-only fields, changed on a world built with others
  if (filmKey !== state.filmKey && !state.building && state.builtKey === key) {
    state.filmKey = filmKey;
    state.host.world.setCameraFilm?.(film);
  }
  // (physcam) the scene camera's auto-exposure at this time, from its meter's samples on the Scene's clock (meterExposure)
  meterExposure(engine, env, time, rig);
  // A model that has left the world (one of the six live) is still in the scene the world holds while it rebuilds without it: it goes
  // from that one at once, so its own pass never draws it beside the world's copy. Final waits for the rebuild (drawWorldFrame).
  const now = new Set([...models.filter((m) => m.url || m.splat).map((m) => m.id), ...parts.map((p) => p.itemId)]);
  state.hidden = [...(state.builtNodes || [])].filter(([item]) => !now.has(item)).flatMap(([, ids]) => ids);
  state.host.world.setHidden?.(state.hidden);
  // A model out of the world (one of the six, a blur, a flat effect) is filmed through this world's curve and Look at its exposure, so it
  // looks as it did in the world (model3dLayer.js, opts.worldLook). The exposure is the one the world's picture was last drawn with:
  // Final's trace has its own (drawWorldFrame updates it).
  engine.worldLook = worldLookFor(state.host.world, rig, look, exposure);
  // 3D Text lays its letters out while its channel draws (world3dText.js), so a frame with letters in the world is posed and drawn once
  // every channel has (finishWorldFrame). The preview does it once this world has a picture of its own to fall back on. A world bundle
  // built before letters could stand in it keeps them in their own pass; flat text (textInWorld) needs one that takes cards.
  const textLayers = state.host.world.setLetters && !rigWantsNoWorldText(env)
    ? worldTextLayers(env, time, { keepsOwnPass: textKeepsOwnPass, activeIndex: resolveActiveIndex }).filter((l) => !l.flat || state.host.world.setFlatLetters)
    : [];
  if (textLayers.length && (state.plateGeneration === state.generation || engine.exporting || state.filming || RENDER_PAGE)) {
    sizeWorld(engine);           // the Scene layer takes the plate's targets while the channels draw
    // A model out of the world draws its own pass while the channels draw: a Scene that films from its own camera is posed now, so that
    // pass films from where the world will (engine.worldCameraProxy). drawWorldFrame then finds the pose already set.
    if (rig.scene?.camera) poseWorld(engine, time, rig, models, parts, backdrop);
    state.fresh = false;
    state.deferred = { time, rig, models, parts, backdrop, fx, grow, letters: new Map(), flat: new Map() };
    engine.worldTakesText = true;
    // The flat layers whose letters the world takes this frame: their channels lay out cards instead of painting the plate (layerMesh.js).
    const flat = textLayers.filter((l) => l.flat);
    engine.worldTextItems = flat.length ? new Map(flat.map((l) => [l.itemId, l.item])) : null;
    engine.worldFrameReady = true;
    return true;
  }
  // Letters from an earlier frame leave with their layer.
  if (state.lettersShown?.size && state.host.world.setLetters) {
    for (const id of state.lettersShown) state.host.world.setLetters(`t:${id}`, null);
    state.lettersShown = null;
  }
  if (state.flatShown?.size) {
    for (const id of state.flatShown) state.host.world.setFlatLetters(`f:${id}`, null);
    state.flatShown = null;
  }
  return drawWorldFrame(engine, time, rig, models, parts, backdrop, fx, grow);
}

/** (physcam) The scene with its camera's picture-only fields left out: what a change of builds the world again. */
function withoutCameraFilm(scene) {
  return scene?.camera ? { ...scene, camera: splitCameraFilm(scene.camera).rest } : scene;
}

/** (physcam) The meter's samples the preview draws a frame at most (a jump along the timeline measures the rest over the next frames); a
 *  render draws every one its frame needs. */
const METER_PER_FRAME = 8;

/** (physcam) The scene camera's auto-exposure (`camera.autoExposure`, deviceCamera.js) for the frame at `time`. Its meter samples the set
 *  on a fixed grid of the Scene's clock: each sample is the whole world posed at that time as the frame there would be (the Scene's own
 *  keys, the model layers, the Rig's keyed lights, as worldDraftBlur poses a shutter's times), drawn small by WorldRenderer.meterView and
 *  read back. The exposure at `time` is then deviceCamera.js aeAt over the samples before it: a frame alone measures them first, a frame
 *  inside a render finds most of them measured by the frames before, and both get the same number. The samples hold while the project
 *  stands still (the Scene as built, its Rig, the channels, the frame's size). A camera with none takes the gain back off. */
function meterExposure(engine, env, time, rig) {
  const world = state.host?.world;
  const cam = rig?.scene?.camera;
  const spec = cam && world?.meterView ? aeSpec(cam) : null;
  if (!spec) {
    if (state.meter) { state.meter = null; world?.setCameraGain?.(null); }
    return;
  }
  const entry = resolveRigAt(rigEntriesOf(engine), time);
  const s = sceneTimeAt(rigEntriesOf(engine), time);
  const start = Number(entry?.startTime) || 0;
  const epoch = [state.builtKey, state.builtGeneration, entry?.rig, env?.channels, engine.videoSize.w, engine.videoSize.h];
  if (!state.meter || state.meter.epoch.some((v, i) => v !== epoch[i])) state.meter = { epoch, samples: new Map(), pending: new Map(), last: state.meter?.last ?? null };
  const m = state.meter;
  m.now = { s, spec, env, time, rig, start };
  const rendering = engine.exporting || typeof window.__videoRender !== 'undefined';
  // the meter reads Draft's whole light: once this build's sky behind walls and the walls' own light are measured (WorldRenderer
  // envVisReady), in Draft and Final alike, so a frame alone and a frame inside a render read the same light
  const lightReady = !world.meterLightReady || world.meterLightReady();
  if (!lightReady) world.envVisReady?.();
  const missing = lightReady ? meterMissing(m, s, spec) : [];
  if (missing.length) meterSamples(engine, env, time, rig, m, spec, start, rendering ? missing : missing.slice(0, METER_PER_FRAME), rendering);
  const e = aeAt(s, spec, (k) => m.samples.get(k) || null);
  if (e != null) m.last = e;
  // while the preview's samples are still being read, the last exposure it had (a render waits for them: meterSettle)
  world.setCameraGain(e ?? m.last ?? null);
  meterDrawn(m, s, world);
}

/** (filmbugs) The exposure a frame of the Scene's clock `s` was drawn with (log2 of the world's gain), kept for the scene report: a still
 *  draws the playhead's frame again after its capture, so the world's gain at report time was another frame's (a Draft still at 4.0 s
 *  reported the gain of 0 s, 1.2691, beside its right 1.7904). */
function meterDrawn(m, s, world) {
  const g = world?.aeGain;
  if (!m || !Number.isFinite(s) || !(g > 0)) return;
  m.drawnAt ||= new Map();
  m.drawnAt.delete(Math.round(s * 1e4));
  m.drawnAt.set(Math.round(s * 1e4), Math.log2(g));
  if (m.drawnAt.size > 64) m.drawnAt.delete(m.drawnAt.keys().next().value);
}

/** (physcam) Draws the meter's samples `ks` (grid steps of the Scene's clock): the world posed at each one's time (worldDraftBlur's poses:
 *  the Scene's keys and rigged objects, the model layers, the Rig's keyed lights and backdrop), its view drawn and its read-back kept; then
 *  the frame's own models and lights put back, and its pose drawn again by poseWorld. Each sample keeps the log2 of the exposure that the
 *  Rig and the camera's own ISO, shutter and aperture give its time (the meter reads the scene's light before any exposure). */
function meterSamples(engine, env, time, rig, m, spec, start, ks, rendering) {
  const world = state.host.world;
  const { w: W, h: H } = engine.videoSize;
  const rest = (H * 0.5) / Math.tan((28 * Math.PI) / 180 / 2);
  const rigAt = worldRigIn(engine, time);
  const clock = worldClockIn(engine, time);
  const proxy = !engine.worldActive && engine.cameraPose ? cameraProxyFromPose(engine.cameraPose, W, H) : null;
  const steer = proxy ? worldSteer(proxy, rest) : null;
  const rigged = !!world.rigInfo && Array.isArray(rig.scene?.objects) && rig.scene.objects.some((o) => o?.skeleton && o?.pose);
  const cam = withDevice(rig.scene.camera);
  let live = null;
  try { live = shutterLive(engine, world, time, rigAt); } catch { live = null; }
  world.meterPosing = true;
  try {
    for (const k of ks) {
      const t = start + k * AE_STEP;
      const sk = clock(t);
      const models = env ? worldModelsAt(engine, env, t, rigAt, clock) : null;
      if (live) { try { live.at(t); } catch { live = null; } }
      let nodePoses = {};
      if (rigged) {
        state.scenePoser ||= createScenePoser();
        nodePoses = state.scenePoser.pose(worldClocksScene(rig.scene), sk, (id) => world.rigInfo(id)).nodePoses;
      }
      world.setPose({ camera: null, steer, objects: withBackdropAt(engine, rigAt, t, models?.objects), lens: null, time: sk,
        nodePoses: { ...(models?.nodePoses || {}), ...nodePoses }, ...(models?.morphs ? { morphs: models.morphs } : {}) });
      const camScene = worldClocksScene(rig.scene);
      const physical = physicalExposure({ ...cam, iso: sampleField(cam, 'iso', sk, camScene), shutter: sampleField(cam, 'shutter', sk, camScene), fStop: sampleField(cam, 'fStop', sk, camScene) }) ?? 1;
      // the Rig's own exposure and its environment's (the world's base exposure, world3dScene.js), times the camera's own
      const rigT = rigAt(t);
      const rigExposure = Number.isFinite(rigT?.exposure) && rigT.exposure > 0 ? rigT.exposure : 1;
      const base = Math.log2(Math.max(1e-6, rigExposure * exposureAt(rigAt, t) * physical));
      const read = world.meterView(spec.metering).then((bins) => {
        m.pending.delete(k);
        if (bins && state.meter === m) m.samples.set(k, { bins, base });
        if (!rendering && state.meter === m && !m.pending.size) world.onRepaint?.();
      }, (e) => { m.pending.delete(k); console.warn('[world3d] the auto-exposure\'s meter could not be read', e?.message || e); });
      m.pending.set(k, read);
    }
  } finally {
    world.meterPosing = false;
    // the frame's own: its models back at its time and its lights; its pose comes back with poseWorld
    if (env) { try { worldModelsAt(engine, env, time, rigAt, clock); } catch { /* the frame poses them again */ } }
    live?.done();
    state.poseKey = null;
  }
}

/** (physcam) The grid steps the exposure at Scene time `s` needs that are neither measured nor being read. */
function meterMissing(m, s, spec) {
  const { k0, k1 } = aeGrid(s, spec);
  const missing = [];
  for (let k = k0; k <= k1 + 1; k += 1) if (!m.samples.has(k) && !m.pending.has(k)) missing.push(k);
  return missing;
}

/** (physcam) A render's frame waits for its auto-exposure: the light the meter reads measured (envVisReady), the samples its frame still
 *  lacks drawn (then the frame is drawn again at its own time: the samples' poses moved the world), all of them read back, and the
 *  exposure taken. True when the frame has to be drawn again with it. */
async function meterSettle(engine) {
  const m = state.meter, world = state.host?.world;
  if (!m?.now || !world) return false;
  if (world.meterLightReady && !world.meterLightReady()) await world.envVisReady?.();
  if (state.meter !== m) return false;
  const { s, spec, env, time, rig, start } = m.now;
  const missing = meterMissing(m, s, spec);
  if (missing.length) {
    meterSamples(engine, env, time, rig, m, spec, start, missing, true);
    engine.renderFrame?.();
    await worldSettled(engine);
  }
  if (m.pending.size) await Promise.all([...m.pending.values()]);
  if (state.meter !== m) return false;
  const before = world.aeGain ?? 1;
  const e = aeAt(s, spec, (k) => m.samples.get(k) || null);
  if (e == null) return missing.length > 0;
  m.last = e;
  world.setCameraGain(e);
  meterDrawn(m, s, world);
  return missing.length > 0 || (world.aeGain ?? 1) !== before;
}

/** (physcam) What the auto-exposure did over a stretch of the Scene's clock, for a check or a picture of it: each grid step's metered
 *  target and exposure (log2), from the samples measured so far. Null without an auto-exposure. */
export function worldExposureTrace(s) {
  const m = state.meter;
  if (!m?.now) return null;
  const trace = [];
  const e = aeAt(Number.isFinite(s) ? s : m.now.s, m.now.spec, (k) => m.samples.get(k) || null, trace);
  return { e, gain: state.host?.world?.aeGain ?? 1, trace, samples: m.samples.size };
}

/** How the world lights and films its picture, for a model's own pass to do the same (model3dLayer.js, opts.worldLook): the curve's
 *  Look and the exposure the picture was last drawn at; the environment as strong as the world has it; in Draft, the light raster makes
 *  of the environment's brightest region (envKey.js) and the world's contact shadows (GTAO); in Final, which traces the environment
 *  itself and fades GTAO out, the full environment, `aoAmount` as the world fades it, and the light the set's floor bounces up, the one
 *  part of Final's bounce light a raster pass can stand in for (worldBounce). */
function worldLookFor(world, rig, look, exposure) {
  const final = world.traced?.value > 0.5;
  const out = {
    lookOf: look, contrast: look?.contrast ?? 1.25, saturation: look?.saturation ?? 1.3,
    exposure: Number.isFinite(world.exposure?.value) ? world.exposure.value : exposure,
    aoAmount: Number.isFinite(world.aoAmount?.value) ? world.aoAmount.value : 1,
  };
  const envIntensity = final ? world.traceEnvIntensity : world.rasterEnvIntensity;
  if (Number.isFinite(envIntensity)) out.envIntensity = envIntensity;
  if (final) {
    const bounce = worldBounce(rig);
    if (bounce) out.bounce = bounce;
    return out;
  }
  const k = world.envKeyLight;
  if (k?.intensity > 0) {
    const d = new THREE.Vector3(k.position.x - k.target.position.x, k.position.y - k.target.position.y, k.position.z - k.target.position.z);
    const { az, elev } = sphericalFromVector(d.x, d.y, d.z);
    out.envKey = { lid: 'world-env-key', type: 'directional', name: 'Environment key', az, elev, dist: 3000, intensity: k.intensity,
      color: `#${new THREE.Color().setRGB(k.color.r, k.color.g, k.color.b).getHexString()}`, castShadow: false, on: true };
  }
  return out;
}

/** The light the set's floor bounces up: its colour times what the Rig's suns lay on it (intensity × the sine of their height), as a light
 *  from below only. Null when the set has no floor of its own colour. */
function worldBounce(rawRig) {
  const rig = normalizeRig(rawRig);
  const m = rig.cyclorama?.material;
  if (!rig.cyclorama || rig.cyclorama.shape === 'none' || !m || (m.mode && m.mode !== 'solid')) return null;
  const onFloor = rig.lights.filter((l) => l.type === 'directional' && l.on !== false)
    .reduce((sum, l) => sum + l.intensity * Math.max(0, Math.sin((l.elev * Math.PI) / 180)), 0);
  if (!(onFloor > 0)) return null;
  return { lid: 'world-bounce', type: 'hemisphere', name: 'Floor bounce', color: '#000000', groundColor: m.color || '#d8d8d8', intensity: onFloor, castShadow: false, on: true };
}

/** The size the world draws at: the video's in a render. The preview draws at the screen's pixels, but under Final no more than the
 *  video's: zoomed in, every sample paid for the zoomed pixels, a 4K trace for a 1080p video. */
const worldSize = (engine) => {
  const { w: W, h: H } = engine.videoSize;
  if (engine.exporting) return { width: Math.max(1, Math.round(W)), height: Math.max(1, Math.round(H)) };
  const buf = engine.renderer.getDrawingBufferSize(new THREE.Vector2());
  const x = buf.x || W, y = buf.y || H;
  const k = state.final ? Math.min(1, W / x, H / y) : 1;
  return { width: Math.max(1, Math.round(x * k)), height: Math.max(1, Math.round(y * k)) };
};

const sizeWorld = (engine) => {
  const { width, height } = worldSize(engine);
  state.host.world.setSize(width, height);
};

/** Every object and the shot where they stand at `time`, set on the world only when they moved. A Scene that films from its own camera
 *  hands that camera to the models' own passes too (engine.worldCameraProxy). Returns the pose's key. */
function poseWorld(engine, time, rig, models, parts, backdrop) {
  const mod = engine.model3d;
  // the Scene's own clock (rig3d.js sceneTimeAt): its keys, camera, sims and videos run from its clip's start, not the timeline's
  const sceneT = sceneTimeAt(rigEntriesOf(engine), time);
  const { w: W, h: H } = engine.videoSize;
  const { host } = state;
  const locked = engine.worldActive;
  const proxy = !locked && engine.cameraPose ? cameraProxyFromPose(engine.cameraPose, W, H) : null;
  // A scene that names its own camera films from it, keys included. Delete it to hand the shot to the Camera layer.
  const ownCamera = !!rig.scene?.camera;
  const diag = state.diagnosticCamera ? diagnosticPose(state.diagnosticCamera) : null;
  host.world.freeCamera = diag ? true : !ownCamera;
  const rest = (H * 0.5) / Math.tan((28 * Math.PI) / 180 / 2);
  const camera = diag || (ownCamera ? null : worldCamera(proxy, rest));
  const steer = diag ? null : (ownCamera && proxy ? worldSteer(proxy, rest) : null);
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
  // (pose) a posed model's morph weights and the Scene objects it holds; what it holds is placed among `objects` (held by a bone,
  // blended from where the object stands by the attach's weight). The pose's own numbers sign the key: an edit while paused re-poses.
  let morphs = null, poseSig = 0;
  const held = new Map();
  for (const m of models) {
    if (!m.url) continue;
    host.world.setScreens(m.id, mod.modelScreensForWorld(m.id));
    const pose = mod.modelNodePose(m.id);
    if (pose) nodePoses[m.id] = pose;
    const w = mod.modelMorphWeights?.(m.id);
    if (w) (morphs ||= {})[m.id] = w;
    if (!mod.modelIsPosed?.(m.id)) continue;
    poseSig = signFloats(poseSig, pose);
    poseSig = signFloats(poseSig, w);
    for (const [id, a] of mod.modelAttachments(m.id) || []) held.set(id, a);
  }
  // (rigging) Scene objects with a skeleton and a pose: posed here through the same pipeline, the world takes their joints' matrices
  if (host.world.rigInfo && rig.scene && Array.isArray(rig.scene.objects) && rig.scene.objects.some((o) => o?.skeleton && o?.pose)) {
    state.scenePoser ||= createScenePoser();
    const posed = state.scenePoser.pose(worldClocksScene(rig.scene), sceneT, (id) => host.world.rigInfo(id));
    for (const [id, arr] of Object.entries(posed.nodePoses)) { nodePoses[id] = arr; poseSig = signFloats(poseSig, arr); }
    for (const [id, a] of posed.attachments) held.set(id, a);
  }
  // once held, an object's node is placed from here for good (its own keys through sceneObjectMatrix): the world stops reading them for it
  for (const id of state.heldIds || []) if (!held.has(id)) held.set(id, { matrix: null, weight: 0 });
  if (held.size) state.heldIds = new Set(held.keys());
  for (const [id, a] of held) {
    const own = sceneObjectMatrix(worldClocksScene(rig.scene), id, sceneT);
    if (own) {
      objects[id] = heldMatrix(worldClocksScene(rig.scene), id, own, a, sceneT);
      poseSig = signFloats(poseSig, objects[id]);
      continue;
    }
    if (objects[id]) {
      objects[id] = heldModelMatrix(objects[id], a, WORLD_UNITS);
      poseSig = signFloats(poseSig, objects[id]);
      continue;
    }
    const modelParts = parts.filter((p) => p.itemId === id);
    if (modelParts.length) {
      const e = mod.modelWorldMatrix(id);
      if (e) {
        const heldBase = new THREE.Matrix4().fromArray(heldModelMatrix(worldMatrix(e), a, WORLD_UNITS));
        for (const { id: partId, part } of modelParts) {
          objects[partId] = heldBase.clone().multiply(new THREE.Matrix4().fromArray(part.matrix)).elements;
          poseSig = signFloats(poseSig, objects[partId]);
        }
      }
    }
  }
  // The Scene's own surfaces that show a layer of the timeline or a video (a material's `screen`, a card of kind "layer"): drawn here
  // when their source shows another picture, worn by the world (liveLayers.js). A scene with none costs one lookup.
  const live = liveSceneSurfaces(rig.scene, time, sceneT);
  if (live) host.world.setLiveSurfaces?.(live);
  // Moving nothing must not cost a frame, or a resting trace would start over on every repaint.
  if (backdrop) objects.backdrop = worldMatrix(backdrop.matrix);
  const D = (H * 0.5) / Math.tan((28 * Math.PI) / 180 / 2);
  // (multiview) a diagnostic view films sharp through the renderer's `pinhole`: a lens here would be written into the scene's own camera
  const lens = diag || ownCamera ? null : worldLens(getCameraDofSettings(engine.cameraPose, D), W, camera.fov, W / H);
  // (smallfix) a sub-frame of the export's motion blur (engine.shutterFrameTime, exporter.js): the objects' `visible` keys at the frame's time
  // (enginebugs) on the Scene's own clock, as the world reads its keys
  const visibleAt = Number.isFinite(engine.shutterFrameTime) ? sceneTimeAt(rigEntriesOf(engine), engine.shutterFrameTime) : null;
  const poseKey = JSON.stringify([camera, steer, objects, lens, time, sceneT, poseSig, ...(visibleAt != null ? [visibleAt] : [])]);
  // the pose the world holds: a repaint asked for by the world clears state.poseKey (so the next frame poses again), never this
  state.posed = poseKey;
  if (poseKey !== state.poseKey) {
    state.poseKey = poseKey;
    state.touched = performance.now();
    host.world.setPose({ camera, steer, objects, lens, time: sceneT, nodePoses, pinhole: !!diag, ...(morphs ? { morphs } : null), ...(visibleAt != null ? { visibleAt } : null) });
  }
  // A Scene that films from its own camera films a model's own pass from it too (a model out of the world, by one of the six, a blur or
  // a flat effect), so the model stands where the world would show it. The world's units are the editor's px times WORLD_UNITS.
  if (ownCamera) {
    const c = host.world.camera;
    engine.worldCameraProxy = { position: new THREE.Vector3(c.position.x, c.position.y, c.position.z).divideScalar(WORLD_UNITS),
      quaternion: new THREE.Quaternion(c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w), fov: c.fov,
      // (cameras) a lens shift slides the model's frame with the world's
      ...(c.shift?.[0] || c.shift?.[1] ? { shift: [c.shift[0], c.shift[1]] } : {}),
      // (gaps1) an orthographic camera films the model's pass orthographic too: its frame's height, px
      ...(c.isOrthographicCamera && c.orthoHeight > 0 ? { ortho: c.orthoHeight / (c.zoom || 1) / WORLD_UNITS } : {}) };
  }
  return poseKey;
}

/** (pose) A cheap signature of a float array, folded into `h` (FNV-1a over rounded values). */
function signFloats(h, a) {
  if (!a) return h;
  for (let i = 0; i < a.length; i += 1) h = Math.imul(h ^ Math.round(a[i] * 1e5), 16777619) >>> 0;
  return h;
}

/**
 * (pose) A Scene object held by a model's bone (`attach`), as the matrix its node takes in the world (local to its Scene parent): the bone's
 * frame from the editor (px, unit scale) in metres, times the object's own scale, blended from where the object stands by the weight.
 */
const _hp = new THREE.Vector3(), _hq = new THREE.Quaternion(), _hs = new THREE.Vector3(), _op = new THREE.Vector3(), _oq = new THREE.Quaternion(), _os = new THREE.Vector3();
function heldMatrix(scene, id, own, a, time) {
  const out = own.clone();
  if (a.matrix && a.weight > 0) {
    own.decompose(_op, _oq, _os);
    const m = new THREE.Matrix4().fromArray(a.matrix);
    m.decompose(_hp, _hq, _hs);
    _hp.multiplyScalar(WORLD_UNITS);
    out.compose(_op.lerp(_hp, a.weight), _oq.slerp(_hq, a.weight), _os);
  }
  const parentId = scene.objects?.find((o) => o?.id === id)?.parent;
  const parent = parentId ? sceneObjectMatrix(scene, parentId, time) : null;
  if (parent) out.premultiply(parent.invert());
  return out.toArray();
}

/** (engine100) The world's frame, guarded in the preview: a frame that throws keeps the last picture and is drawn again by itself
 *  (frameFault), where it went up through the editor ("The Video Editor could not be loaded") and, with nothing left to ask for a frame,
 *  kept the loading notice for good. A render is not caught: it stops with its error rather than wait. */
function drawWorldFrame(engine, ...args) {
  const rendering = engine.exporting || state.filming || RENDER_PAGE || typeof window.__videoRender !== 'undefined';
  if (rendering) return drawWorldFrameNow(engine, ...args);
  try {
    const drawn = drawWorldFrameNow(engine, ...args);
    // (a frame really drawn ends the episode: one kept back while a rebuild prepares does not)
    if (state.frameFaults && state.fresh) { console.info(`[world3d] the 3D Scene draws again after ${state.frameFaults} frame(s) that could not be drawn`); state.frameFaults = 0; }
    return drawn;
  } catch (e) {
    frameFault(engine, e);
    return false;
  }
}

/** A preview frame that threw: the last picture stays, and the frame is drawn again after frameFaultPlan's delay; the sixth in a row
 *  builds the scene anew first (its lights, materials and shaders), so a state left broken by the build before goes with it. */
function frameFault(engine, e) {
  state.fresh = false;
  engine.worldFrameReady = false;
  state.frameFaults += 1;
  const plan = frameFaultPlan(state.frameFaults);
  if (plan.log) console.warn(`[world3d] the 3D Scene's frame could not be drawn (${state.frameFaults} in a row); drawing it again in ${plan.delay} ms${plan.rebuild ? ', the scene built anew first' : ''}`, e);
  if (plan.rebuild) state.key = null;
  clearTimeout(state.faultTimer);
  state.faultTimer = setTimeout(() => {
    state.faultTimer = null;
    const en = state.engine;
    if (en && !en.isPlaying && !en.exporting) en.renderFrame?.();
  }, plan.delay);
}

// ── (farm1) a render whose Final Scene frames were traced on a render farm (RunPod pods, backend/render_farm.py) ─────────────────────────
// Each farm frame is the pod world's whole canvas (the picture over its depth band, WorldRenderer.readHandoff) for one timeline frame, as
// a PNG beside a JSON of what the plate reads with it (the camera's clip planes and field of view, the view range, a catcher). While a
// render has them (setWorldFarm), a Final Scene frame here is not traced: its PNG goes onto a canvas and the plate draws that canvas
// exactly as it draws the world's own (worldLayerResult), so the 2D layers, the audio and the encode are a home render's.
// (farmparity) The pod's side is this same page (VideoProjectRenderPage.jsx farmFrames → exporter.js `farmPod`): the project rendered as a
// home render renders it, and each Final frame's world canvas read whole (worldFarmHandoff) instead of composited and encoded.
/** (farmparity) The world's whole canvas of the frame just rendered (WorldRenderer.readHandoff: the picture over its depth band, the masks
 *  below while world mattes ask, and what the plate reads with it), for a render farm pod to send home. Throws when the world did not draw
 *  this frame's Scene. */
export async function worldFarmHandoff(engine) {
  const world = state.host?.world;
  if (!world || !state.ready || !engine.worldFrameReady || state.farm) throw new Error('[FARM_NO_WORLD] the 3D Scene did not draw this frame');
  return world.readHandoff();
}
/** A render's farm frames: { base: URL prefix of `<n>.png` / `<n>.json`, fps, runs? }, or null when the render traces at home. `runs`
 *  (farmfix): the [first, last] runs of frames the farm traced (its plan's), so no frame past them is asked for. */
export function setWorldFarm(source) {
  const runs = Array.isArray(source?.runs) && source.runs.length ? source.runs.map((r) => [Number(r?.[0]), Number(r?.[1])]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)) : null;
  state.farm = source && source.base ? { base: String(source.base), fps: Math.max(1, Number(source.fps) || 30), cache: new Map(), runs } : null;
  state.farmFrame = null;
}
const farmFrameNumber = (time) => Math.round(time * state.farm.fps);
// (lookfix) the farm frame a render's frame at `time` shows: a sub-frame of its motion blur (exporter.js accumulation, engine.shutterFrameTime)
// shows its frame's, whose pod traced the whole shutter
const farmFrameAt = (engine, time) => farmFrameNumber(Number.isFinite(engine.shutterFrameTime) ? engine.shutterFrameTime : time);
/** Frame `n`'s picture: a canvas holding the PNG's bytes as they are (no colour conversion, no premultiplying: the PNG is opaque, as the
 *  world's canvas is), its size and bands, and its meta. Fetched once; the next frames are asked for meanwhile. */
function farmFrameLoad(n) {
  const farm = state.farm;
  if (farm.cache.has(n)) return farm.cache.get(n);
  const p = (async () => {
    const [png, meta] = await Promise.all([fetch(`${farm.base}${n}.png`), fetch(`${farm.base}${n}.json`)]);
    if (!png.ok || !meta.ok) throw new Error(`[FARM_FRAME_MISSING] the render farm's frame ${n} is not here (${png.status})`);
    const info = await meta.json();
    const bitmap = await createImageBitmap(await png.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return { n, canvas, width: canvas.width, height: canvas.height, bands: Number(info.bands) || 2, meta: info.meta || {} };
  })();
  farm.cache.set(n, p);
  p.catch(() => farm.cache.delete(n));
  return p;
}
// (filmbugs) a frame the farm traced: its timeline's active Scene renders in Final (farm.js farmPlan's runs: rigAtTime over the same layout)
const farmTraced = (engine, time) => { const e = resolveRigAt(engine.rigEntries, time); return isWorldRig(e?.rig) && e.rig.render?.mode === 'final' && time >= e.startTime - 1e-6 && time <= e.endTime + 1e-6; };
async function farmFrameSettle(engine) {
  const n = farmFrameAt(engine, engine.currentTime);
  for (const [k] of state.farm.cache) if (k < n) state.farm.cache.delete(k);
  let frame;
  try { frame = await farmFrameLoad(n); } catch (e) { throw Object.assign(e, { finalStall: true }); }
  // the next ones, while this one composites: only frames the farm traced (a Final Scene's); (filmbugs) the frames after the last of a
  // Final Scene (a flat shot over a Draft Scene, the end) are home frames, which the farm never had: asking for them was a 404 each
  // (farmfix) and only frames the farm has (its plan's runs, when the render gave them): the frame at the film's end time is past the
  // film's last frame, and was asked for after the last one (a 404 each composite)
  const farmHas = (k) => !state.farm.runs || state.farm.runs.some(([a, b]) => k >= a && k <= b);
  for (let k = 1; k <= 3; k += 1) if (farmHas(n + k) && farmTraced(engine, (n + k) / state.farm.fps)) farmFrameLoad(n + k).catch(() => {});
  if (frame.width !== state.host.world.width || frame.height !== state.host.world.height * frame.bands) {
    throw Object.assign(new Error(`[FARM_FRAME_SIZE] farm frame ${n} is ${frame.width}×${frame.height}; this render's Scene draws at ${state.host.world.width}×${state.host.world.height}`), { finalStall: true });
  }
  state.farmFrame = frame;
  return true;
}

/** The world's frame: every object posed, the shot, the effects on its objects, and the picture drawn when anything changed. */
function drawWorldFrameNow(engine, time, rig, models, parts, backdrop, fx = [], grow = []) {
  const mod = engine.model3d;
  const { w: W, h: H } = engine.videoSize;
  const { host } = state;
  const { width, height } = worldSize(engine);
  host.world.setSize(width, height);
  // (farm1) a farm frame stands in for this Final frame's trace: the world is posed (its camera and size as here) but draws nothing
  if (state.farm && rig.render?.mode === 'final') {
    poseWorld(engine, time, rig, models, parts, backdrop);
    host.world.setTrace(false);
    const here = !!state.farmFrame && state.farmFrame.n === farmFrameAt(engine, time);
    // (farmparity) the farm frame was traced, through the pod world's own lens (a Camera layer's depth of field included): the compositor
    // leaves the Scene's layer unblurred, as it leaves a frame traced here (adjustmentComposite.js cocForChannel). It blurred it a second
    // time: a keyed Camera layer's focus pull came home twice as soft (pink desk's flat title, farm vs local 2.0 levels, p99 10)
    engine.worldTracing = here;
    state.fresh = here;
    if (!here) return false;
    engine.worldFrameReady = true;
    return true;
  }
  // (filmbugs) a home frame of a farm render (a Draft Scene, an empty one under a flat shot): the plate draws this world's own picture. The
  // last farm frame stayed in state.farmFrame and the plate drew it again (worldLayerResult): the Final Scene before a flat shot held, greyed
  // by the Draft Scene's plate, all through the shot (the Pulse film's three html shots)
  if (state.farm) state.farmFrame = null;
  const poseKey = poseWorld(engine, time, rig, models, parts, backdrop);
  // Laid on the picture after the trace, so a slider moved under Final draws the frame again and the trace goes on.
  host.world.setObjectFx?.(worldFxList(fx, mod.modelFxFrame, H));
  // A file's meshes take their arrivals in traversal order; a shape's parts are one mesh each, in the same order.
  host.world.setGrowFill?.(grow.map((g) => {
    const d = mod.modelGrowFillForWorld(g.itemId, g.growFill);
    if (!d) return null;
    const objects = g.parts ? g.objects.map((object, i) => ({ object, arrivals: [d.meshes[i]] })) : [{ object: g.objects[0], arrivals: d.meshes }];
    return { id: g.itemId, key: d.key, values: d.values, ramps: d.ramps, objects };
  }).filter(Boolean));
  host.world.setPlaying(!!engine.isPlaying);
  // (octane2) what the Scene shows (render.passes) and the masks the timeline's world mattes ask for
  host.world.setPasses?.(rig.render?.passes, state.maskSets);
  const shown = rig.render?.passes?.show;
  state.passNote = !filmsFinal(rig) && ['diffuse', 'specular', 'emission'].includes(shown)
    ? `render.passes.show "${shown}" is a light pass, which only Final traces: Draft shows the picture (set render.mode "final")` : null;
  // Off in the preview unless the Scene asks, and always in a render: speed is for the person watching. The render page has nobody
  // watching, and its stills are taken away like its renders: there they stay on.
  host.world.setRasterShadows(rig.render?.draftShadows === true || !!engine.exporting || RENDER_PAGE);
  // On the render page a Final Scene's every kept frame is traced (settleWorldFrame) and its warm-up only loads: no Draft is drawn for it
  // (WorldRenderer.setDraftUnused).
  host.world.setDraftUnused?.(RENDER_PAGE && filmsFinal(rig));
  // (engine100b) Final's own exposure over Draft's: the render's alone. The environment's exposure is in the film's already (the scene's
  // exposure, worldSceneFromRig: the Rig's times its environment's), and taken here again it was squared in Final (env exposure 2: Final
  // 4x, Draft 2x), as the Motion Engine's player never did
  host.world.trace.exposure = rig.render?.exposure ?? 1;
  // Final 3D waits until hands stop: scrubbing stays in Draft, and the trace comes back right after.
  // A render's traced frame stays until the pose moves on: more repaints follow it before the frame is read.
  // Only a Final render's own repaints: a Draft render later in the same page, at a pose a Final frame once had, is drawn, not that trace.
  const filming = state.filming || (state.filmedPose === poseKey && filmsFinal(rig));
  // (robust) a preview Final stopped on a GPU failure (worldStatus) traces nothing until Final is turned on again
  host.world.setTrace(filming || (state.final && !state.finalFailed && !state.finalStarting && !engine.isPlaying && !engine.exporting && performance.now() - state.touched > 180 && !state.hidden?.length));
  // A WebGPU canvas is blank again once it has been shown, so the plate only reads frames drawn in this same task.
  // A new compositor has an empty plate, and the canvas keeps nothing once it has been shown.
  state.fresh = host.world.needsFrame() || engine.exporting || filming || state.plate?.renderer !== engine.renderer;
  // (hdr2) the float composite of the frame just drawn draws no frame of the world's: its layer shows the plate it holds (worldReplay)
  if (state.replay && state.plate?.renderer === engine.renderer) state.fresh = false;
  engine.worldTracing = host.world.traceWanted;
  let drew = null;
  if (state.fresh) {
    // A render draws at once. The preview waits while a new world's shaders are built, keeping its last picture, and the notice
    // stays until the first frame is really there.
    const atOnce = engine.exporting || filming || typeof window.__videoRender !== 'undefined';
    // Paused, the preview also settles: a few shifted frames averaged, so detail finer than a pixel stops breaking into dots.
    // (badframes) the guard's tests: the Scene's GPU device lost now, or its frame never reaching the canvas (frameGuard.frameFaultOn)
    // (three reports no loss for a device destroyed on purpose: the world is told, as a real loss tells it)
    if (engine.exporting && frameFaultOn('loseWorldDevice') && !host.world.deviceLost) {
      host.world.renderer.backend?.device?.destroy?.();
      host.world.deviceLost = { reason: 'unknown', message: 'lost on purpose (frame guard test)', at: performance.now() };
    }
    // (robust) and the preview's: `__glFrameFaults.loseWorldDevice` set in an editor page loses the preview's device on its next frame
    if (!engine.exporting && !RENDER_PAGE && globalThis.__glFrameFaults?.loseWorldDevice > 0 && !host.world.deviceLost) {
      globalThis.__glFrameFaults.loseWorldDevice -= 1;
      (globalThis.__glFrameFaults.fired ||= []).push('loseWorldDevice');
      host.world.renderer.backend?.device?.destroy?.();
      host.world.deviceLost = { reason: 'unknown', message: 'lost on purpose (frame guard test)', at: performance.now() };
      const lost = state.host;
      setTimeout(() => recoverLostPreview(lost), 0);
      return false;
    }
    if (engine.exporting && frameFaultOn('blankWorld')) { host.world.renderer.setRenderTarget(null); host.world.renderer.clear(); drew = undefined; }
    else drew = host.world.frame({ wait: !atOnce, settle: !atOnce });
    if (drew === false) state.fresh = false;
    else if (state.load && state.load.stage !== 'final') reportLoad(null);
  }
  // ... as this frame drew it: Final's trace has its own exposure, environment and no contact shadows (worldLookFor).
  if (engine.worldLook) engine.worldLook = worldLookFor(host.world, rig, engine.worldLook.lookOf, engine.worldLook.exposure);
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

/** A 3D Text layer's letters on a frame the world holds back for them (prepareWorldFrame): its run and quad transform, as the 3D pass
 *  would have filmed them. A flat layer's (`flat`: { opacity }, the layer's own) are its cards (layerMesh.js buildTextWorldRun). False
 *  when this frame's world takes no text. */
export function handWorldText(engine, item, run, transform, flat = null) {
  const d = state.deferred;
  if (!d || !engine.worldTakesText) return false;
  // (animtools) a layer riding a Scene object (`worldParent`): that object's place at this frame
  const parent = parentMatrixAt(engine, worldClocksScene(d.rig?.scene) || state.host?.scene, item, d.time);
  if (flat) {
    if (!state.host?.world.setFlatLetters) return false;
    d.flat.set(item.id, { run, transform, opacity: flat.opacity ?? 1, parent });
    return true;
  }
  if (!engine.model3d?.glyphGeometry) return false;
  d.letters.set(item.id, { run, transform, parent });
  return true;
}

/** Where flat letters stand when the world films from a camera of its own (`scene.camera`): the editor's camera, which films the flat
 *  layer, carried onto the world's (world3dText.js flatLettersViewMatrix), so every letter lands where the flat layer draws it, at the
 *  depth of what the Scene's camera looks at. Column-major, world units; null when the world films from the editor's camera already. */
function flatLettersView(engine, rig) {
  if (!rig.scene?.camera) return null;
  const { w: W, h: H } = engine.videoSize;
  const rest = (H * 0.5) / Math.tan((28 * Math.PI) / 180 / 2);
  const proxy = !engine.worldActive && engine.cameraPose ? cameraProxyFromPose(engine.cameraPose, W, H) : null;
  const world = state.host.world;
  const c = world.camera;
  // how far the Scene's camera stands from what it looks at, as the world placed it this frame (WorldRenderer.applyTime)
  const cam = world.json?.camera || rig.scene.camera;
  const t = Number.isFinite(world.time) ? world.time : 0;
  const at = sampleField(cam, 'at', t, world.json || rig.scene) || [0, 1, 3], target = sampleField(cam, 'target', t, world.json || rig.scene) || [0, 0, 0];
  const reach = Array.isArray(at) && Array.isArray(target) ? Math.hypot(target[0] - at[0], target[1] - at[1], target[2] - at[2]) : 0;
  return flatLettersViewMatrix(
    { position: proxy ? proxy.position.toArray().map((v) => v * WORLD_UNITS) : [0, 0, rest * WORLD_UNITS], quaternion: proxy ? proxy.quaternion.toArray() : [0, 0, 0, 1], fov: proxy?.fov ?? 28 },
    { position: [c.position.x, c.position.y, c.position.z], quaternion: [c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w], fov: c.fov, reach, ortho: !!c.isOrthographicCamera },
    rest * WORLD_UNITS);
}

/** One 3D Text layer's letters for the world (world3dText.js worldTextLetters) from its run and quad transform, its glyph meshes (the 3D
 *  pass's, model3dLayer.js glyphGeometry) kept in `glyphs` by the world's id for them. */
function letterLayer(engine, run, transform, glyphs, parent = null) {
  const mod = engine.model3d;
  const { w: W, h: H } = engine.videoSize;
  const s = run.settings || {};
  const glyphOf = (g) => {
    const built = mod.glyphGeometry(g.font, g.ch, Math.max(0, s.depth) / 100, Math.max(0, s.bevel) / 100, s.bevelSegments, g.fv || 0);
    const id = glyphIdOf(built?.geometry);
    if (id) glyphs.set(id, built.geometry);
    return id;
  };
  // (animtools) a layer riding a Scene object (`worldParent`): its letters in that object's space
  const layer = lettersOnParent(worldTextLetters(run, transform, { W, H, finishes: mod.TEXT3D_FINISH, glyphOf }), parent);
  layer.glyph = (key) => glyphArrays(glyphs.get(key));
  return layer;
}

/** (animtools) The world matrix (column-major, metres) of the Scene object a layer rides (`worldParent`) at timeline time `time`, as the
 *  world poses it there (modelPose.js sceneObjectMatrix: its keys, drives and path, through its parents); null when it rides none or the
 *  Scene has no such object. */
function parentMatrixAt(engine, scene, item, time) {
  const id = worldParentOf(item);
  if (!id || !scene) return null;
  const m = sceneObjectMatrix(scene, id, sceneTimeAt(rigEntriesOf(engine), time));
  return m ? m.elements.slice() : null;
}

/** (mblur5) Whether the world takes this top-level channel's 3D Text as letters of its own on a frame of a render (they move in the world:
 *  a Text Animator, the layer's keys, its parent or track are the world's motion, posed at each time of a shutter, worldMotionBlur's
 *  `textAt`): a 3D Text layer, not locked to the camera, with no effect that keeps it in its own pass, in a world that takes letters. */
export function worldTakesLetters(engine, channel, item, clip) {
  return !!state.host?.world?.setLetters && !!engine.model3d?.glyphGeometry && !worldBlockedOn(engine) && !channel?.cameraLocked
    && isText3dLayer(item, clip) && !textKeepsOwnPass(item);
}

/** (mblur5) The 3D Text letters the world takes at each of `times` (and the frame's own `time`), lined up across them (shutterLetters.js):
 *  Map(time -> Map(layer id -> letters)), null when no 3D Text stands in the world. `textAt(channel, t)` lays a channel's letters out at
 *  `t` (channelRender.js text3dRunAt). Throws when the trace cannot take them (a layer that starts, ends or crosses into another clip, a
 *  letter that changes its glyph inside the shutter): the frame is then rendered as sub-frames. (mblur6) A letter that fades or changes
 *  colour there: `looks` 'tint' (Final) hands each time the letter's brightest look and its tint at that time, 'own' (Draft) its own look. */
function shutterLetters(engine, env, textAt, time, times, looks = 'tint') {
  if (!textAt || !env?.channels || !state.host?.world?.setLetters || !engine.model3d?.glyphGeometry || rigWantsNoWorldText(env)) return null;
  const layersAt = (t) => worldTextLayers(env, t, { keepsOwnPass: textKeepsOwnPass, activeIndex: resolveActiveIndex }).filter((l) => !l.flat);
  const own = layersAt(time);
  const all = [...new Set([time, ...times])].sort((a, b) => a - b);
  const sign = (list) => list.map((l) => `${l.channelId}:${l.itemId}`).join('|');
  const ownSign = sign(own);
  for (const t of all) if (sign(layersAt(t)) !== ownSign) throw new Error('letters: a 3D Text layer starts or ends inside the shutter');
  if (!own.length) return null;
  const glyphs = new Map();
  const frames = all.map((t) => {
    const at = new Map();
    for (const l of own) {
      const channel = env.channels.find((c) => c.id === l.channelId);
      const r = channel ? textAt(channel, t) : null;
      if (!r?.run || r.item?.id !== l.itemId) throw new Error('letters: a 3D Text layer cannot be laid out alone at a time of the shutter');
      // (animtools) riding a Scene object: where that object is at this time of the shutter
      at.set(`t:${l.itemId}`, letterLayer(engine, r.run, r.transform, glyphs, parentMatrixAt(engine, state.host?.scene, r.item, t)));
    }
    return at;
  });
  const lined = alignShutterLetters(frames, all.indexOf(time), { looks });
  return new Map(all.map((t, k) => [t, lined[k]]));
}

/** (mblur5) The world's letters as `letters` (shutterLetters) has them at `t`. */
function setShutterLetters(world, letters, t) {
  const at = letters?.get(t);
  if (at) for (const [id, layer] of at) world.setLetters(id, layer);
}

/** The frame prepareWorldFrame held back: the letters every 3D Text channel handed over, then the pose and the picture, into the plate
 *  the Scene layer has already handed to the stack. Layers that handed nothing this frame leave the world. */
export function finishWorldFrame(engine) {
  const d = state.deferred;
  state.deferred = null;
  if (!d || !state.host || !state.ready) return;
  const world = state.host.world;
  const { w: W, h: H } = engine.videoSize;
  const glyphs = new Map();
  for (const [id, { run, transform, parent }] of d.letters) {
    // (mblur5) on a frame whose shutter the world posed its letters across (worldMotionBlur / worldDraftBlur), the frame's own letters as
    // lined up there: the same meshes the trace moves
    const layer = state.motionLetters?.get(`t:${id}`) || letterLayer(engine, run, transform, glyphs, parent);
    world.setLetters(`t:${id}`, layer);
  }
  for (const id of state.lettersShown || []) if (!d.letters.has(id)) world.setLetters(`t:${id}`, null);
  state.lettersShown = new Set(d.letters.keys());
  if (d.flat.size || state.flatShown?.size) {
    const view = d.flat.size ? flatLettersView(engine, d.rig) : null;
    // (animtools) a flat layer riding a Scene object stands in that object's space (not carried onto the Scene's camera)
    for (const [id, { run, transform, opacity, parent }] of d.flat) world.setFlatLetters(`f:${id}`, worldFlatLetters(run, transform, { W, H, opacity, view: parent || view }));
    for (const id of state.flatShown || []) if (!d.flat.has(id)) world.setFlatLetters(`f:${id}`, null);
    state.flatShown = new Set(d.flat.keys());
  }
  drawWorldFrame(engine, d.time, d.rig, d.models, d.parts, d.backdrop, d.fx, d.grow);
  if (!state.fresh) return;
  const res = worldLayerResult(engine);
  // The Scene layer took its distance while the channels drew, before this frame's shot and letters: depth of field reads it now.
  for (const [id, tex] of engine.modelDepthTex) {
    if (tex !== res.depthTexture) continue;
    engine.modelDepth.set(id, res.viewDistance);
    if (res.viewRange) engine.modelDepthRange.set(id, res.viewRange);
    else engine.modelDepthRange.delete(id);
  }
}

/** The Scene layer's picture, in the shape a model pass hands back. */
export function worldLayerResult(engine) {
  const { host } = state;
  const { width, height } = host.world;
  const p = ensurePlate(width, height, engine.renderer);
  // (farm1) this frame's farm frame, when the render has one for it (drawWorldFrameNow): its canvas and what the pod's world drew it with
  const farm = state.farm && state.farmFrame && state.fresh ? state.farmFrame : null;
  const fm = farm?.meta || null;
  if (state.fresh) {
    state.fresh = false;
    state.plateGeneration = state.generation;
    state.previewGeneration = -1;
    state.previewMeta = null;
    const r = engine.renderer;
    p.material.uniforms.uNear.value = engine.camera?.near ?? 1;
    p.material.uniforms.uFar.value = engine.camera?.far ?? 100000;
    // (vfx) a solved wide lens (the Camera layer's camLensK1): the world's pinhole picture bent the way the footage is (compositeNodes.js)
    const k1 = Number(engine.cameraPose?.camLensK1) || 0;
    const tanHalf = Math.tan((((fm && Number.isFinite(fm.fov) ? fm.fov : null) ?? (host.world.camera?.fov || 28)) * Math.PI) / 360);
    // (octane2) the canvas's bands: picture over depth, and the masks below them while world mattes ask
    const bands = farm ? farm.bands : (host.world.handoffBands || 2);
    const keys = engine.worldMaskKeys || [];
    const maskMats = bands > 2 ? keys.map((_, k) => p.maskOf(k).material) : [];
    if (farm) {
      // the farm frame's canvas stands in for the world's: the same texture settings as the handoff (ensurePlate)
      if (!state.farmTexture) {
        const t = new THREE.CanvasTexture(farm.canvas);
        t.colorSpace = THREE.NoColorSpace;
        t.magFilter = t.minFilter = THREE.NearestFilter;
        t.generateMipmaps = false;
        t.premultiplyAlpha = false;
        state.farmTexture = t;
      }
      state.farmTexture.image = farm.canvas;
      state.farmTexture.needsUpdate = true;
    }
    for (const m of [p.material, p.shadowMaterial, ...maskMats]) {
      m.uniforms.uHandoff.value = farm ? state.farmTexture : p.texture;
      m.uniforms.uPicY.value.set(1 / bands, (bands - 1) / bands);
      m.uniforms.uBandY.value.set(1 / bands, (bands - 2) / bands);
      m.uniforms.uMaskY.value.set(1 / bands, 0);
    }
    // (polish1) the world camera's clip planes as this frame drew them (they follow the set: WorldRenderer #fitClip)
    const worldNear = (fm && fm.near) || host.world.camera?.near || WORLD_NEAR, worldFar = (fm && fm.far) || host.world.camera?.far || WORLD_FAR;
    for (const m of [p.material, p.shadowMaterial, ...maskMats]) {
      m.uniforms.uWorldNear.value = worldNear;
      m.uniforms.uWorldRatio.value = worldFar / worldNear;
      m.uniforms.uK1.value = k1;
      m.uniforms.uLens.value.set(2 * tanHalf * (width / Math.max(1, height)), 2 * tanHalf);
      // (vfx34) the plate's softness (px of the world's frame) and black; the handoff canvas is the picture over its depth band
      if (m.uniforms.uSoften) {
        m.uniforms.uSoften.value = state.plateLook?.soften || 0;
        m.uniforms.uBlack.value = state.plateLook?.black || 0;
        m.uniforms.uGrain.value = state.plateLook?.grain || 0;
        m.uniforms.uGrainSeed.value = state.plateLook?.seed || 0;
        m.uniforms.uSharpen.value = state.plateLook?.sharpen || 0;
        m.uniforms.uBlackTint.value.fromArray(state.plateLook?.blackTint || [1, 1, 1]);
        m.uniforms.uTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, bands * height));
      }
    }
    if (!farm) {
      p.texture.needsUpdate = true;
      // the world's canvas is read now (worldHandoff.js)
      worldHandoff.read();
    }
    const before = r.getRenderTarget(), autoClear = r.autoClear;
    // (leftovers-tile) a picture too tall for the canvas over its depth comes in slices (WorldRenderer #planHandoff): the canvas holds one
    // slice's rows of each band at a time (with `pad` rows of its neighbours), the world draws each in turn (drawHandoffSlice) and each
    // is read into its own rows of the plate's targets
    const slicing = farm ? null : (host.world.slicing || null);
    const catcher = farm ? !!fm?.hasCatcher : host.world.hasCatcher;
    const slices = slicing ? slicing.n : 1;
    const maskTextures = new Map();
    for (let k = 0; k < slices; k += 1) {
      if (slicing) {
        if (k > 0) { host.world.drawHandoffSlice(k); p.texture.needsUpdate = true; }
        const tall = bands * slicing.band;
        // a frame row y (from the top) is canvas row y - (k·rows - pad) of each band: v = s·v_frame + o, the bands one band's height apart
        const sv = height / tall, o = 1 - (height - k * slicing.rows + slicing.pad) / tall;
        for (const m of [p.material, p.shadowMaterial, ...maskMats]) {
          m.uniforms.uPicY.value.set(sv, o);
          m.uniforms.uBandY.value.set(sv, o - 1 / bands);
          m.uniforms.uMaskY.value.set(sv, o - 2 / bands);
          if (m.uniforms.uTexel) m.uniforms.uTexel.value.set(1 / Math.max(1, width), 1 / tall);
        }
      }
      r.autoClear = k === 0;
      // each pass draws only the slice's rows (the shadows' target is the other way up: its rows mirrored)
      const rowsOf = (flip) => {
        if (!slicing) return;
        const a = k * slicing.rows, b = Math.min(height, (k + 1) * slicing.rows);
        p.sliceGeometry ??= p.fullGeometry.clone();
        const [r0, r1] = flip ? [height - b, height - a] : [a, b];
        const pos = p.sliceGeometry.attributes.position, uvs = p.sliceGeometry.attributes.uv;
        // PlaneGeometry(2, 2): top-left, top-right, bottom-left, bottom-right
        for (const [i, top] of [[0, true], [1, true], [2, false], [3, false]]) {
          const row = top ? r0 : r1;
          pos.setY(i, 1 - (2 * row) / height);
          uvs.setY(i, 1 - row / height);
        }
        pos.needsUpdate = true; uvs.needsUpdate = true;
        for (const mesh of p.meshes) mesh.geometry = p.sliceGeometry;
      };
      rowsOf(false);
      r.setRenderTarget(p.target);
      r.render(p.scene, p.camera);
      if (catcher) {
        rowsOf(true);
        r.setRenderTarget(p.shadowTarget);
        r.render(p.shadowScene, p.camera);
        rowsOf(false);
      }
      // (octane2) each world matte's mask, as the Scene's own picture lands (the compositor swaps it in for the matte, adjustmentComposite.js)
      if (bands > 2) {
        keys.forEach((key, j) => {
          const mk = p.maskOf(j);
          r.setRenderTarget(mk.target);
          r.render(mk.scene, p.camera);
          maskTextures.set(key, mk.target.texture);
        });
      }
    }
    if (slicing) for (const mesh of p.meshes) mesh.geometry = p.fullGeometry;
    // (badframes) the guard's tests: the compositor's copy of the Scene's picture blanked (frameGuard.frameFaultOn)
    if (engine.exporting && frameFaultOn('blankPlate')) {
      const clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
      r.setRenderTarget(p.target);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.setClearColor(clear, alpha);
    }
    state.maskTextures = maskTextures;
    r.setRenderTarget(before);
    r.autoClear = autoClear;
    // (badframes) the guard's sample of what the compositor reads, drawn and sent for reading now: the copy runs in the GPU's queue ahead
    // of the frame's compositing, so the check after the frame finds it read instead of waiting on the GPU itself
    state.plateSampleRead = state.guardSampling && !farm ? { plate: p, generation: state.generation, read: readPlateSample(r, p) } : null;
    // (farm1) the plate reads the world's own canvas again unless the next frame is a farm frame too
    if (farm) for (const m of [p.material, p.shadowMaterial, ...maskMats]) m.uniforms.uHandoff.value = p.texture;
    state.plateFarm = farm ? { hasCatcher: !!fm?.hasCatcher, linearCover: !!fm?.linearCover, viewRange: fm?.viewRange || null } : null;
  }
  engine.worldMaskTextures = state.maskTextures || null;
  const pf = state.farm ? state.plateFarm : null;
  const range = pf ? pf.viewRange : host.world.viewRange();
  return {
    // (hdr2) the float composite's own plate, the world's light past white, in place of the SDR picture (worldReplay)
    texture: state.replay?.texture || p.target.texture, depthTexture: p.target.depthTexture,
    // A catcher's shadow has no surface to stand at, so the stack gets it last, as a plain overlay.
    shadowTexture: (pf ? pf.hasCatcher : host.world.hasCatcher) ? p.shadowTarget.texture : null,
    // (mblur3) a frame whose coverage is the share of a shutter it spends on each pixel (traced moving over a see-through sky): the stack
    // takes it in linear light (adjustmentComposite compositeWithDepth)
    linearCover: pf ? pf.linearCover : !!host.world.linearCover,
    viewDistance: range ? ((range.near + range.far) / 2) / WORLD_UNITS : (engine.videoSize.h * 0.5) / Math.tan((14 * Math.PI) / 180),
    viewRange: range ? { near: range.near / WORLD_UNITS, far: range.far / WORLD_UNITS } : null,
  };
}

/** Whether a model on this frame is drawn by the world, so its own pass stays out of the way. */
export const worldDrawsModels = (engine) => engine.worldFrameReady === true;

// ── (badframes) What the frame guard (frameGuard.js) asks the world about the frame just drawn ──────────────────────────────────────────
// The Scene's picture as the compositor read it (the plate's target): a SAMPLE x SAMPLE point grid of it drawn on the GPU and read back
// (4 KB). Only when every point is one value is the world asked what it drew in view, and then the whole plate is read, so a picture that
// is honestly near-empty (a small object on a plain sky) is never taken for a blank read.
const PLATE_SAMPLE = 32;
let plateSample = null;
function plateSampler(renderer) {
  if (plateSample?.renderer === renderer) return plateSample;
  plateSample?.dispose();
  const target = new THREE.RenderTarget(PLATE_SAMPLE, PLATE_SAMPLE, { depthBuffer: false, type: THREE.UnsignedByteType });
  target.texture.colorSpace = THREE.NoColorSpace;
  const material = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: false, blending: THREE.NoBlending, depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  plateSample = { renderer, target, material, scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    dispose() { target.dispose(); material.dispose(); quad.geometry.dispose(); } };
  return plateSample;
}

/** The plate's sample drawn and its read sent (the GPU copies it in queue order, after what the plate holds now): a promise of its
 *  bytes, or of null when the read failed. */
function readPlateSample(r, p) {
  const s = plateSampler(r);
  // (a new plate is a new texture: the material is built again only then)
  if (s.material.map !== p.target.texture) { s.material.map = p.target.texture; s.material.needsUpdate = true; }
  const before = r.getRenderTarget(), autoClear = r.autoClear;
  try {
    r.autoClear = true;
    r.setRenderTarget(s.target);
    r.render(s.scene, s.camera);
  } finally {
    r.setRenderTarget(before);
    r.autoClear = autoClear;
  }
  return readTargetPixels(r, s.target, PLATE_SAMPLE, PLATE_SAMPLE).catch(() => null);
}

/** (badframes) A render whose frames the guard checks turns this on for its length: each plate fill then sends its sample's read at once
 *  (worldLayerResult), so the check costs a tiny draw and a 4 KB copy in the GPU's queue and no wait. Off, nothing is drawn or read. */
export function worldGuardSampling(on) {
  state.guardSampling = !!on;
  if (!on) state.plateSampleRead = null;
}

/** The frame guard's facts about the Scene on the frame just drawn, or null when the frame holds no world picture of this project (no
 *  Scene, a farm frame, an HDR replay): `plate` { kind (frameGuard.emptyKind of the picture as read; null = it shows something), objects
 *  (what the world drew in view: shown objects in the camera's frustum, +1 for an opaque background) }, `final` { finished,
 *  minSpp, spp, why } for a Final Scene in a render, `gpuReset` when the world's own device was lost since `since` (performance.now()),
 *  and `error` when the picture could not be read back. */
export async function worldFrameFacts(engine, { since = 0, time = null, stripeCorrupt = false } = {}) {
  const { host } = state;
  if (!host || !state.ready || !engine.worldFrameReady || state.farm || state.replay) return null;
  const world = host.world;
  const out = {};
  if (world.deviceLost && world.deviceLost.at >= since) {
    out.gpuReset = `the 3D Scene's GPU device was lost (${world.deviceLost.reason || 'unknown'}: ${world.deviceLost.message})`;
    return out;
  }
  // (filmbugs) the Scene of the frame kept (`time`: the frame's own time). After a frame drawn from motion blur's sub-frames the playhead
  // stands on the last sub-frame, which past a cut belongs to the next Scene layer: a Draft frame on a cut into a Final Scene was judged
  // as that Final Scene's ("the trace was off for the kept picture", three times, the render stopped)
  const rig = engine.activeRigAt?.(Number.isFinite(time) ? time : engine.currentTime);
  const rendering = engine.exporting || typeof window.__videoRender !== 'undefined';
  if (rendering && filmsFinal(rig)) {
    const finished = !!world.traceWanted && !!world.traceFinished && !world.traceDirty && (world.traced?.value ?? 0) > 0.5;
    out.final = { finished, minSpp: Number.isFinite(world.minSpp) ? world.minSpp : null, spp: world.trace?.spp ?? null,
      why: finished ? null : !world.traceWanted ? 'the trace was off for the kept picture' : world.traceDirty ? 'the trace started over before the picture was kept' : 'the trace had not finished' };
  }
  const p = state.plate;
  if (p && p.renderer === engine.renderer && state.plateGeneration === state.generation) {
    const r = engine.renderer;
    // the sample sent as the plate filled (a render, worldGuardSampling), else drawn and read now (a still)
    const sent = state.plateSampleRead;
    let sample = sent && sent.plate === p && sent.generation === state.generation ? await sent.read : null;
    if (!sample) sample = await readPlateSample(r, p);
    // (a read that fails is the frame's fault: drawn again, then a sentence)
    if (!sample) { out.error = "the 3D Scene's picture could not be read back for the frame check"; return out; }
    let kind = emptyKind(pixelSpread(sample));
    let objects = 0;
    if (kind) {
      const view = world.objectsInView?.() || { objects: 0, background: false };
      objects = view.objects + (view.background ? 1 : 0);
      // every sampled point one value and something in view: the whole plate decides (a near-empty picture is not a blank read)
      if (objects > 0) kind = emptyKind(pixelSpread(await readTargetPixels(r, p.target, p.width, p.height)));
    }
    let corrupt = null;
    let corruptSample = null;
    const stripeFault = stripeCorrupt || frameFaultOn('stripeCorrupt');
    if (!kind || stripeFault) {
      const sampleCorrupt = detectStripeCorruption(sample, PLATE_SAMPLE, PLATE_SAMPLE);
      if (sampleCorrupt || stripeFault) {
        const fullPixels = await readTargetPixels(r, p.target, p.width, p.height).catch(() => null);
        corrupt = fullPixels ? detectStripeCorruption(fullPixels, p.width, p.height) : sampleCorrupt;
        if (corrupt && !stripeFault) {
          if (fullPixels?.length) {
            const nPx = Math.floor(fullPixels.length / 4);
            const take = Math.min(nPx, 1024);
            const step = Math.max(1, Math.floor(nPx / take));
            const snap = new Uint8Array(Math.ceil(nPx / step) * 4);
            for (let pi = 0, oi = 0; pi < nPx && oi + 3 < snap.length; pi += step, oi += 4) {
              const si = pi * 4;
              snap[oi] = fullPixels[si]; snap[oi + 1] = fullPixels[si + 1]; snap[oi + 2] = fullPixels[si + 2]; snap[oi + 3] = fullPixels[si + 3];
            }
            corruptSample = snap;
          } else if (sample?.length) {
            corruptSample = new Uint8Array(sample);
          }
        }
        if (stripeFault) corrupt = { ...(corrupt || { axis: 'horizontal', ratio: 1, score: 1 }), injected: true };
      }
    }
    out.plate = { kind, objects, ...(corrupt ? { corrupt } : {}), ...(corruptSample ? { sample: corruptSample } : {}) };
  }
  return out;
}

// ── (hdrscene) An HDR render of the Scene alone: the world's own light past its tone pass (hdrScene.js) ─────────────────────────────────
/** A render asks for the world's own light on every frame it draws (`on`), or is done with it. The world makes its float target only
 *  while asked (WorldRenderer.setHdrOut); a world that loads later takes the ask on its first frame (worldHdrFrame). */
export function worldHdrOut(on, { alpha = false } = {}) {
  state.hdrOut = on ? { alpha: !!alpha } : null;
  state.host?.world?.setHdrOut?.(!!on, { alpha: !!alpha });
}

/** The frame just drawn, through the world's HDR view: { data: rgba half floats, width, height } or null (no world frame in it, a world
 *  bundle without the HDR view, or 2D layers the world drew over its picture). */
export async function worldHdrFrame(engine) {
  const world = state.host?.world;
  if (!state.hdrOut || !world?.setHdrOut || !state.ready || !engine.worldFrameReady) return null;
  if (!world.hdrOut) world.setHdrOut(true, state.hdrOut);
  return world.hdrPixels();
}

/**
 * (hdr2) An HDR render composites the frame just drawn a second time, in float (hdrComposite.js): while `replay` is set the world draws
 * no frame of its own (that frame's pose, trace and plate stay as drawn) and its layer shows `replay.texture` (its HDR plate) instead of
 * the SDR picture, or the SDR picture when there is none. Null ends it.
 */
export function worldReplay(replay) {
  state.replay = replay || null;
}

/**
 * (filmbugs) Holds the frame just drawn while a render draws the 2D layers over it at the sub-frames of its motion blur (exporter.js): the
 * world's picture of the frame's own time, traced ONCE with its own shutter (worldMotionBlur), stays as drawn; nothing is posed, metered or
 * traced again until `false`. A Final Scene under moving 2D layers (titles, an end card fading in) was traced again at each of the 16
 * sub-frames: 3–5 min a frame for the Pulse film's end-card dissolve, 52 s instead of 2.6 for moving titles over a Final Scene. Returns
 * whether the frame is held: not when the world drew no frame of its own here, or took 3D Text letters this frame (those move with their
 * layers, frame by frame).
 */
export function worldHold(on, engine = state.engine) {
  if (!on) { state.hold = null; return false; }
  const p = state.plate;
  if (!engine || !state.ready || !engine.worldFrameReady || state.farm || state.replay || engine.worldTakesText
    || !p || p.renderer !== engine.renderer || state.plateGeneration !== state.generation) return false;
  state.hold = { cameraProxy: engine.worldCameraProxy, look: engine.worldLook, lightWrap: engine.worldLightWrap };
  return true;
}

/** (hdr2) The plate the frame just drawn handed to the compositor: its SDR picture (premultiplied display values over the world's
 *  depth), its size, and whether it came in slices (a picture taller than the canvas). Null before the world's first frame. */
export function worldPlate(engine) {
  const p = state.plate;
  if (!p || p.renderer !== engine.renderer || state.plateGeneration !== state.generation) return null;
  return { texture: p.target.texture, width: p.width, height: p.height, sliced: !!state.host?.world?.slicing };
}

/** The frame's SDR picture as the world's tone pass left it, for the check that the compositor shows nothing else. */
export async function worldSdrPixels() {
  return state.host?.world?.ldrPixels?.() ?? null;
}

/** Whether the scene the world holds now has this model layer in it. A model that comes back into the world (one of the six no longer
 *  live) is not there until the rebuild lands, so its own pass draws it till then. */
export const worldHolds = (itemId) => !!state.builtItems?.has(itemId);

// How long a Final stays warm after it is turned off: long enough to flip back and compare, and the tracer then gives its memory back.
const TRACER_REST_MS = 30000;

/** Another project opened in the editor. Its Scene is another world, so the last one must not stay on screen while this one builds.
 *  (sceneswitch) `redraw: false` when the editor says so as it takes the next project's state in (VideoEditor applyEditorStateNow), before
 *  any frame has it: its next frame draws that state anyway, and one drawn now would still have the project left. */
export function worldProjectChanged({ redraw = true } = {}) {
  state.generation += 1;
  // The preview still holds the last world's frame, and nothing else draws until the new scene is built: draw it again without it.
  const e = state.engine;
  if (redraw && state.ready && e && !e.isPlaying && !e.exporting) e.renderFrame?.();
}

// ── (bugsB) the Scene's geometry as clay, for the 3D view ──────────────────────────────────────────────────────────────────────────────

/**
 * (bugsB) What the editor's 3D view (worldView.js setWorldClay, lazily loaded) needs to show a world Scene's own geometry as untextured
 * clay, or null while the Scene is not built: the world's object nodes (their meshes' arrays are read, not copied), the model layers' node
 * ids it leaves out (the 3D view shows their own geometry already), a key that changes with each build, and the map from world metres to
 * the editor's 3D space (px), so the clay stands as the shot sees it (worldToEditor). The meshes themselves are made in the 3D view's own
 * module: nothing of it is in the editor's main chunk or runs while the view is closed.
 */
export function worldClaySource(engine, rig, time) {
  const world = state.host?.world;
  if (!state.ready || !world?.nodes?.size || !isWorldRig(rig)) return null;
  const exclude = new Set([...(state.builtNodes?.values() || [])].flat());
  return { key: `${world.builds}|${state.builtKey?.length || 0}|${exclude.size}`, nodes: world.nodes, exclude, toEditor: worldToEditor(engine, rig, world, time) };
}

/** (bugsB) The field of view of the shot a Scene films from its own camera (the world camera's, Camera layer zoom included), for the 3D
 *  view's camera frustum; null when the editor's camera films. */
export function worldViewShotFov(rig) {
  const c = state.host?.world?.camera;
  return rig?.scene?.camera && state.ready && Number.isFinite(c?.fov) && !c.isOrthographicCamera ? c.fov : null;
}

/** World metres to the editor's 3D space (px), column-major: the inverse of flatLettersView's map (world3dText.js flatLettersViewMatrix)
 *  without the lens squeeze, i.e. world = c0 + q0 · ((x − rest ẑ) · U · s) with c0, q0 the Scene camera before the Camera layer steers it. */
function worldToEditor(engine, rig, world, time) {
  const { h: H } = engine.videoSize;
  const rest = (H * 0.5) / Math.tan((28 * Math.PI) / 180 / 2);
  const cam = rig.scene?.camera ? (world.json?.camera || rig.scene.camera) : null;
  if (!cam || world.camera?.isOrthographicCamera) return new THREE.Matrix4().makeScale(1 / WORLD_UNITS, 1 / WORLD_UNITS, 1 / WORLD_UNITS).elements;
  const t = Number.isFinite(time) ? sceneTimeAt(rigEntriesOf(engine), time) : (world.time || 0);
  const at = sampleField(cam, 'at', t, world.json || rig.scene) || [0, 1, 3], target = sampleField(cam, 'target', t, world.json || rig.scene) || [0, 0, 0];
  const dx = target[0] - at[0], dy = target[1] - at[1], dz = target[2] - at[2];
  const reach = Math.hypot(dx, dy, dz) || 1;
  const up = cam.up || (Math.abs(dy) / reach > 0.999 ? [0, 0, -1] : [0, 1, 0]);
  const eye = new THREE.Vector3(...at);
  // three's lookAt for a camera: -z toward the target
  const basis = new THREE.Matrix4().lookAt(eye, new THREE.Vector3(...target), new THREE.Vector3(...up));
  const camToWorld = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(basis)).setPosition(eye);
  const s = reach / (rest * WORLD_UNITS);
  return new THREE.Matrix4().makeTranslation(0, 0, rest)
    .multiply(new THREE.Matrix4().makeScale(1 / (WORLD_UNITS * s), 1 / (WORLD_UNITS * s), 1 / (WORLD_UNITS * s)))
    .multiply(camToWorld.invert()).elements;
}

/** (badframes) A world whose GPU device was lost draws nothing any more: it is given back, and the next frame loads it again on a new device
 *  (settleWorldFrame builds its scene for a kept frame). True when it was. */
export function releaseLostWorld() {
  if (!state.host?.world?.deviceLost) return false;
  console.warn("[world3d] the 3D Scene's GPU device was lost: the world is loaded again on a new one");
  releaseWorld();
  return true;
}

/** (robust) The editor's preview lost the world's GPU device (macOS takes it from a page whose work keeps the screen from the GPU; a driver
 *  reset; another app): before, the preview stayed blank or frozen until the editor was opened again. The world is given back and loaded
 *  again on a new device, its frame drawn again, with a short notice; Final goes on if it was on. A render draws its own frames again
 *  (its frame guard: exporter releaseLostWorld), so this is the preview's only. `host`: the world that lost it (a later one is left alone). */
export function recoverLostPreview(host = state.host) {
  const engine = state.engine;
  if (!host || host !== state.host || !host.world?.deviceLost) return false;
  if (RENDER_PAGE || engine?.exporting || state.filming || typeof window !== 'undefined' && typeof window.__videoRender !== 'undefined') return false;
  const final = state.final;
  state.lostDevices = (state.lostDevices || 0) + 1;
  console.warn(`[world3d] the preview's GPU device was lost (${host.world.deviceLost.reason || 'unknown'}: ${host.world.deviceLost.message}): the 3D Scene is loaded again on a new one`);
  if (state.building) state.recoverAfter = true;
  releaseWorld();
  // the player bar's toggle still says Final: the new world traces as the old one did
  state.final = final;
  state.recoverNotice = true;
  reportLoad({ stage: 'recovering' }, true);
  if (engine && !engine.isPlaying) engine.renderFrame?.();
  return true;
}

/** Gives back everything the world holds, its GPU device included. Leaving the editor ends here; the next Scene loads it again. */
export function releaseWorld() {
  if (state.building) { state.releasing = true; return; }
  state.releasing = false;
  clearTimeout(state.tracerRest);
  const { host, plate } = state;
  if (plate) { plate.target.dispose(); plate.shadowTarget.dispose(); plate.texture.dispose(); plate.material.dispose(); plate.shadowMaterial.dispose(); }
  state.plate = null; state.plateGeneration = -1;
  state.previewGeneration = -1; state.previewMeta = null;
  state.solidPreview?.texture?.dispose(); state.solidPreview = null;
  state.farmTexture?.dispose(); state.farmTexture = null; state.farmFrame = null; state.plateFarm = null;
  state.meshFiles = null;
  state.lettersShown = null; state.flatShown = null; state.deferred = null;
  state.meter = null;
  state.key = null; state.lookKey = null; state.liveKey = null; state.poseKey = null; state.posed = null; state.builtKey = null; state.builtItems = null; state.builtNodes = null; state.hidden = null;
  state.ready = false; state.final = false; state.engine = null; state.finalFailed = null;
  state.host = null; state.loading = null;
  reportLoad(null);
  host?.dispose();
}

/** The player bar's own Final options (spp, bounces, denoise, ...) once its Final has been turned on in this page, else null: the
 *  Render dialog says where they differ from the render's `rig.render` (renderProfile.js traceDifferences). */
export const worldPreviewTrace = () => (state.finalSeen ? state.traceOptions : null);

/** Draft 3D or Final 3D, from the toggle in the player bar. While Final is on, this keeps asking for frames until it is done. */
export function setWorldFinal(engine, on, options) {
  const starting = !!on && !state.final;
  state.final = !!on;
  if (on) state.finalSeen = true;
  const w = state.host?.world;
  // Final on pause is a still: the radiance cache is on unless the options say false
  // (renderpro) the keys a render may have set and these options leave out go back to their defaults, not the render's
  if (options) { state.traceOptions = options; w?.setTraceOptions({ ...TRACE_UNSET, ...options, radianceCache: options.radianceCache !== false }); }
  clearTimeout(state.tracerRest);
  // The tracer's first sample can take many seconds on a big scene (geometry, textures, shaders), and building it holds the page for
  // some of them: the badge is shown at once and painted, and only then may the trace start (prepareWorldFrame), so it is seen.
  if (starting && (!state.load || state.load.stage === 'final')) {
    reportLoad({ stage: 'final' }, true);
    state.finalStarting = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      state.finalStarting = false;
      if (state.final && !engine.isPlaying) engine.renderFrame?.();
    }));
  }
  if (!on) state.finalStarting = false;
  // (robust) turned off, a Final the GPU stopped may be tried again
  if (!on) state.finalFailed = null;
  if (!on && state.load?.stage === 'final') reportLoad(null);
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

/** The world's loads and scene builds started so far (counting up), and whether one is under way: a render page's warm-up
 *  (renderPrime.js) tells from them that a frame it drew asked the world for nothing new. */
export const worldBuildsStarted = () => state.builds;
export const worldBusy = () => state.building || (!!state.loading && !state.host && !state.failed);

/** Everything a first frame needs has landed: the bundle, the models, the environment. For a render, which cannot show a late frame. */
export async function worldSettled(engine, timeoutMs = 60000) {
  const t0 = performance.now();
  if (state.loading) await state.loading;
  while (state.building && performance.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 30));
  return !!state.host && state.ready;
}

/** (robust) One frame of a render traced to its samples on world `w` with the trace options `options`: the render holds the world
 *  (`filming`, batch) while it traces, and gives it back on every way out (restoreAfterTrace). Throws the frame's `[CODE]` error (a GPU
 *  failure, TRACE_STALLED) with `finalStall`. */
async function traceRenderFrame(w, options) {
  // (robust) a GPU that cannot trace Final at all (a software adapter) is refused before any work, by name; Draft still draws
  const refused = w.finalRefused?.();
  if (refused) { const error = new Error(`[${refused.code}] ${refused.message}`); error.finalStall = true; error.code = refused.code; throw error; }
  state.filming = true;
  w.setBatch(true);
  // (robust) the render's hold on the world (filming, batch, its trace options) is given back on EVERY way out of the trace: a frame that
  // threw (TRACE_STALLED, a GPU error, a lost device, the exporter cancelling) left `filming` set, and the editor's preview traced Final
  // from then on whatever its toggle said (restoreAfterTrace)
  try {
    // (renderpro) keys rig.render leaves out take their defaults, not what the editor's preview Final last set in this page; the radiance
    // cache, Steady and the soft light carried (lookfix: finalTrace.js, the same options a render farm's pod traces with)
    w.setTraceOptions(options);
    w.setTrace(true);
    const t0 = performance.now();
    const limit = finalFrameBudgetMs(w.trace.spp, w.width, w.height);
    for (;;) {
      await w.idle();
      w.frame({ wait: false });
      await new Promise((r) => setTimeout(r, 0));
      // (renderpro) the GPU ran out of memory, a buffer passed the device's largest, or the device was lost: this trace can never end, so
      // the render stops now with the cause (machine-readable `[CODE]`), not after the frame's whole time limit. (robust) A GPU program
      // this GPU did not compile, and a trace whose counts come back with no sample, too
      const gpu = w.gpuFatal?.(t0);
      if (gpu) {
        const error = new Error(`[${gpu.code}] ${gpu.message}`);
        error.finalStall = true;
        error.code = gpu.code;
        throw error;
      }
      if (await w.traceDone()) break;
      if (performance.now() - t0 > limit) {
        // the exporter stops the render on this one (finalStall), where any other frame error only skips the frame
        const error = new Error(`[TRACE_STALLED] A Final 3D Scene frame did not finish tracing in ${Math.round(limit / 60000)} min (${w.trace.spp} samples at `
          + `${w.width}×${w.height}). Lower the Scene's samples or the video size, or render it in Draft.`);
        error.finalStall = true;
        throw error;
      }
    }
  } finally {
    restoreAfterTrace(w);
  }
}

/** (robust) A render's Final trace is over, however it ended: the world goes back to the editor's own Final (batch off, its radiance
 *  cache setting, no soft light carried) and the editor is no longer filming. */
function restoreAfterTrace(w) {
  try {
    w.setBatch(false);
    // the editor's own Final, after a render in this tab, takes its own setting back
    w.trace.radianceCache = state.traceOptions?.radianceCache !== false;
    w.trace.softReuse = false;
  } finally {
    state.filming = false;
  }
}

/** (robust) A render stops at once on a GPU program of the world's that this GPU did not compile (WorldRenderer.programsChecked: every
 *  program made so far has had its compilation read): the `[GPU_PROGRAM_FAILED]` error, named, as a Final frame's fatal GPU error is. */
async function stopOnFailedProgram(w) {
  if (!(await w?.programsChecked?.())) return;
  const gpu = w.gpuFatal?.(0);
  if (!gpu) return;
  const error = new Error(`[${gpu.code}] ${gpu.message}`);
  error.finalStall = true;
  error.code = gpu.code;
  throw error;
}

/** One frame of a render, traced to its samples. Returns true when the caller should repaint to pick up the result. `prime`: a warm-up's
 *  capture (renderWarmup) that only has to load and draw: the world is settled as for Draft and a Final Scene is not traced. */
export async function settleWorldFrame(engine, options = {}) {
  // (robust) a render's frame waits on the world in many places (its build, its meter, the sky behind its walls, its sims, the canvas's
  // read, the trace): a GPU failure that can never pass (a program this GPU did not compile, a Final it cannot trace) ends the wait at
  // once with its name, wherever the frame is waiting, never after the frame's whole time limit (a lost device is the frame guard's)
  if (!renderingNow(engine)) return settleWorldFrameNow(engine, options);
  let timer = null;
  const fatal = new Promise((resolve, reject) => {
    const look = () => { const e = permanentWorldFailure(state.host?.world); if (e) reject(e); else timer = setTimeout(look, 250); };
    timer = setTimeout(look, 250);
  });
  try {
    return await Promise.race([settleWorldFrameNow(engine, options), fatal]);
  } finally {
    clearTimeout(timer);
  }
}

/** (robust) The error a render stops with for a GPU failure of the world that can never pass, or null: a program this GPU did not
 *  compile (or one invalid for what the device refused it), a Final this GPU cannot trace. Not a lost device (drawn again on a new one). */
function permanentWorldFailure(w) {
  if (!w || !(w.programErrors?.length || w.envUnsupported || (w.traceWanted && w.finalRefused?.()))) return null;
  const g = w.gpuFatal?.(0);
  if (!g || g.code === 'GPU_DEVICE_LOST') return null;
  return Object.assign(new Error(`[${g.code}] ${g.message}`), { finalStall: true, code: g.code });
}

async function settleWorldFrameNow(engine, { fps = null, prime = false, handoff: redraw = false } = {}) {
  // (filmbugs) a held frame's picture is traced already (worldHold)
  if (state.hold) return false;
  const rig = engine.activeRigAt?.(engine.currentTime);
  // (robust) a render whose Scene's world could not start (no adapter it can use, its bundle not loaded) stops with why, instead of
  // frames without the Scene
  if (isWorldRig(rig) && state.failed && !worldBlockedOn(engine) && renderingNow(engine) && worldSceneOn(engine, engine.currentTime)) {
    const msg = String(state.failed?.message || state.failed);
    throw Object.assign(new Error(/^\[[A-Z_]+\]/.test(msg) ? msg : `[GPU_UNAVAILABLE] The 3D Scene could not start here: ${msg.slice(0, 400)}`), { finalStall: true, code: state.failed?.code || 'GPU_UNAVAILABLE' });
  }
  if (!isWorldRig(rig) || worldBlockedOn(engine) || state.failed) return false;
  if (renderingNow(engine) && !worldSceneOn(engine, engine.currentTime)) return false;
  const wasReady = engine.worldFrameReady;
  // A model that left the world this frame, or came back (one of the six live or no longer), rebuilt it: the frame was drawn on the old
  // scene. Drawn again once the new one is there, it is posed before anything settles or traces it, and the caller's repaint is its second
  // frame, past the first one's old shadows.
  const rebuilt = state.building;
  // A still's kept repaint must be the world canvas's first read since a rendering update (worldHandoff.js): the update is waited for
  // while this frame settles. Not an exported frame (`fps`): exports never needed it, and it cost ~8 ms a frame.
  // (badframes) an exported frame the frame guard sent back (`handoff`) waits as a still does
  const handoff = (engine.exporting || typeof window.__videoRender !== 'undefined') && !prime && (!fps || redraw) ? worldHandoff.watch() : null;
  await worldSettled(engine);
  // (badframes) a world loaded during a kept frame (one given back after its device was lost, releaseLostWorld): its scene is built by a
  // frame's draw, and nothing else draws during a render, so this frame asks for it and waits
  if (!prime && state.host && !state.ready && !state.building && !state.sceneError) {
    engine.renderFrame();
    await worldSettled(engine);
  }
  // (rigai) an AI video's @video1 prerender is the Scene and nothing else: a Scene that did not build would encode the empty background
  // and send it to a paid model as the shot, so that render stops with why. Other renders keep the Rig's own passes, as before.
  if (rig?.prerenderLook && state.sceneError && !state.ready && renderingNow(engine)) {
    throw Object.assign(new Error(`[GEOMETRY_FAILED] The 3D Scene did not build for the AI video prerender: ${String(state.sceneError).slice(0, 400)}`), { finalStall: true, code: 'GEOMETRY_FAILED' });
  }
  if (!state.host || !state.ready) return false;
  // (gaps1) a render whose picture the world's GPU cannot draw (its canvas is the picture over its depth, twice as tall): every target
  // would be invalid and the Scene black. Stop the render with the reason, as a frame that never finishes tracing stops it.
  const tooBig = engine.exporting ? state.host.world.sizeError?.() : null;
  if (tooBig) { const error = new Error(tooBig); error.finalStall = true; error.code = 'GPU_TEXTURE_LIMIT'; throw error; }
  // (farm1) a render whose Final frames came from a render farm: nothing is traced or simulated here, the frame's farm picture is loaded
  if (state.farm && rig.render?.mode === 'final' && (engine.exporting || typeof window.__videoRender !== 'undefined')) {
    if (rebuilt && wasReady) engine.renderFrame();
    if (prime) return !wasReady || rebuilt;
    return farmFrameSettle(engine);
  }
  if (rebuilt && wasReady) engine.renderFrame();
  // (physcam) the auto-exposure's samples this frame drew are read, and its exposure taken, before it settles or traces
  const exposed = !prime && await meterSettle(engine);
  // (night run 2026-11-10) a Draft render waits for this build's measure of the sky behind its walls (WorldRenderer.envVisReady), so its
  // frame has it; a set that closes nothing has it at once
  const sky = !filmsFinal(rig) && !!(await state.host.world.envVisReady?.());
  // A render lands on every frame exactly, however far the fluid has to step to get there.
  // (enginebugs2) and a 3D Text layer's letters whose Scene material is baked on each glyph (#letterMaterial, an object-space graph):
  // until their bakes land the letters wear their own colours, and a still taken meanwhile (a fresh render page, which hands the letters
  // over on the frame before this) showed some of them undressed: 2 fresh pages in 3 gave another picture of the clover title than a warm one
  const volumes = state.host.world.volumes?.length > 0 || !!state.host.world.rigid || state.host.world.baked?.length > 0
    || !!state.host.world.simWorld || state.host.world.graphKeyed?.length > 0 || state.host.world.letterPending?.size > 0;
  if (volumes) await state.host.world.settleVolumes(state.host.world.time);
  // Only a render traces: a thumbnail of the preview must not cost a path trace.
  const rendering = engine.exporting || typeof window.__videoRender !== 'undefined';
  // A render's warm-up of a Final Scene starts the tracer's own start in workers (WorldRenderer.prepareTrace: BVHs, tangents, the
  // environment's tables) while the page goes on warming up; the first trace below waits for it and the tracer reads what they made.
  if (prime && filmsFinal(rig) && rendering) state.host.world.prepareTrace?.();
  // (robust) a GPU program of this world that this GPU did not compile (a tracer kernel, a material, a pass): the render stops now with
  // its name, in Draft as in Final, never after a frame's whole time limit (the warm-up's capture too: it built the programs)
  if (rendering) await stopOnFailedProgram(state.host.world);
  // A still's next repaint is the frame that is kept: the world's canvas must not have been read since the last rendering update, or that
  // read's picture is what the compositor gets (worldHandoff.js). Waited for first, so the caller repaints after it.
  if (!filmsFinal(rig) || !rendering || prime) return (!!handoff && await worldHandoffReady(handoff)) || !wasReady || rebuilt || volumes || sky || exposed;
  const w = state.host.world;
  // (gaps1) a Final picture with more pixels than the path tracer's per-pixel buffers hold: say so before it fails inside the tracer
  const traceTooBig = w.traceSizeError?.();
  if (traceTooBig) { const error = new Error(traceTooBig); error.finalStall = true; error.code = 'GPU_BUFFER_LIMIT'; throw error; }
  // (at most PREP_WAIT_MS: a render must end, and past it the tracer builds what the workers have not yet made, as it always did)
  if (!w.pt) {
    let timer;
    await Promise.race([w.prepareTrace?.(), new Promise((resolve) => { timer = setTimeout(resolve, PREP_WAIT_MS); })]);
    clearTimeout(timer);
  }
  // A Final frame waits out the canvas's read BEFORE its trace, while the GPU is free (about one rendering update): the trace reads no
  // plate, so the caller's repaint after it is the canvas's first read since an update. (Waiting after the trace, with the GPU still
  // busy, made the night desk's Final stills ~0.2 s slower.)
  if (handoff) await worldHandoffReady(handoff);
  await traceRenderFrame(w, finalTraceOptions(rig.render, fps));
  // The pose this trace was made at, which the world still holds. A repaint the world asked for meanwhile (sims or volumes behind
  // the frame's time on its first draw, which settleVolumes has since answered) cleared state.poseKey: the caller's repaints would then
  // pose the world again, which restarts the trace, and a still came back as the Draft picture.
  if (state.posed) state.poseKey = state.posed;
  state.filmedPose = state.poseKey;
  // (badframes) the guard's tests: the kept repaint does not show the finished trace (as when a repaint restarted it)
  if (frameFaultOn('finalUnfinished')) { state.filmedPose = null; w.traceDirty = true; }
  return true;
}

/** (mblur) Motion blur inside Final's trace, for one frame of a render whose shutter sees only the Scene's world move (the exporter checks
 *  the rest): the world is posed at the frame's time and at the shutter's steps (`window` seconds centred on `time`, clamped to 0 ..
 *  `maxTime`; the Camera layer's pose at each from `cameraPoseAt`), and handed those poses (WorldRenderer.setMotionBlur), so the frame's
 *  one trace gives every sample its own time in the shutter. The models the world draws keep their pose of the frame (the exporter
 *  sends a frame where one moves the old way). True when the trace takes the frame (or nothing in the world moves after all); false
 *  when it cannot (what moves changes shape, runs by itself, gives light or is drawn over the trace): the caller accumulates sub-frames
 *  as before. The caller renders the frame next (its own pose comes back) and clears this after it (clearWorldMotion). */
export function worldMotionBlur(engine, { time, window, maxTime = Infinity, cameraPoseAt, env = null, textAt = null }) {
  const world = state.host?.world;
  const rig = engine.activeRigAt?.(time);
  state.motionLetters = null;
  if (!isWorldRig(rig) || !filmsFinal(rig) || !world?.setMotionBlur || !state.ready || state.building || state.failed
    || worldBlockedOn(engine) || state.builtGeneration !== state.generation || !world.motionBlurPossible() || !worldShowsSceneAt(engine, time)) return false;
  const { w: W, h: H } = engine.videoSize;
  const ownCamera = !!rig.scene?.camera;
  const rest = (H * 0.5) / Math.tan((28 * Math.PI) / 180 / 2);
  // (mblur2) the Scene's rigged objects posed at each time too (their joints: a character's limbs move inside the shutter)
  const rigged = !!world.rigInfo && Array.isArray(rig.scene?.objects) && rig.scene.objects.some((o) => o?.skeleton && o?.pose);
  const K = world.motionSteps;
  // (lookfix) the shutter's times, Scene, clock, keyed lights, exposure and graphs: worldShutter.js, which a render farm's pod poses with too
  const stepTimes = shutterTimes(time, window, K, maxTime);
  // (mblur5) the 3D Text letters the world takes, laid out at each time (their Text Animators, the layer's keys, its parent): each letter
  // traced moving as any object. One that changes its glyph there cannot be: the frame is then rendered as sub-frames. (mblur6) One that
  // fades or changes colour is traced with its tint at each time
  let letters = null;
  try {
    letters = shutterLetters(engine, env, textAt, time, stepTimes);
  } catch (e) {
    console.warn('[world3d] motion blur in the trace: the shutter could not be posed', e?.message || e);
    return false;
  }
  // (mblur3) the Rig's own keys on its lights (colour, strength, where they stand) at each time: the world relit there. (mblur5) The frame's
  // own Scene layer's Rig all through the shutter (worldRigIn), and its own clock (worldClockIn)
  const rigAt = worldRigIn(engine, time);
  const clock = worldClockIn(engine, time);
  const live = shutterLive(engine, world, time, rigAt);
  const poseAt = (t, deform = false) => {
    const pose = cameraPoseAt?.(t) || null;
    const proxy = pose ? cameraProxyFromPose(pose, W, H) : null;
    let nodePoses = {};
    if (rigged) {
      state.scenePoser ||= createScenePoser();
      nodePoses = state.scenePoser.pose(worldClocksScene(rig.scene), clock(t), (id) => world.rigInfo(id)).nodePoses;
    }
    // (mblur3) the model layers the world draws, posed at that time (their keys, clips and poses)
    const models = env ? worldModelsAt(engine, env, t, rigAt, clock) : null;
    live?.at(t);
    // (mblur2) and the Camera layer's lens at that time (its focus pulls and zooms), as poseWorld sets it
    const camera = ownCamera ? null : worldCamera(proxy, rest);
    const lens = ownCamera ? null : worldLens(getCameraDofSettings(pose, rest), W, camera.fov, W / H);
    // (smallfix) the objects' `visible` keys read at the frame's time across its whole shutter: a switch is never blurred
    // (enginebugs) both on the Scene's own clock; (mblur5) the frame's own Scene's (worldClockIn)
    world.setPose({ camera, steer: ownCamera && proxy ? worldSteer(proxy, rest) : null, objects: withBackdropAt(engine, rigAt, t, models?.objects), lens, time: clock(t),
      nodePoses: { ...(models?.nodePoses || {}), ...nodePoses }, ...(models?.morphs ? { morphs: models.morphs } : {}), visibleAt: clock(time) });
    setShutterLetters(world, letters, t);
    // (mblur2) the deforming meshes' vertices at the shutter's ends and the frame's own time
    return world.captureMotion({ deform });
  };
  let verdict = false;
  try {
    const center = poseAt(time, true);
    const steps = [];
    for (let k = 0; k < K; k += 1) steps.push(poseAt(stepTimes[k], k === 0 || k === K - 1));
    // (mblur2) and the shutter's seconds: a sim's particles move by their own velocities through them; (mblur3) and the frame's time, about
    // which the physics' bodies fly; (engine100b) and the exposure the Rig's keys give each step, over the frame's
    const exposures = stepTimes.map((t) => shutterExposureAt(rigAt, t) / shutterExposureAt(rigAt, time));
    // (mblur6) and the Rig's keys on a texture graph's numbers: the graphs at each share of the shutter, baked as their mean (before: the frame
    // went to 16 sub-frames)
    verdict = world.setMotionBlur(center, steps, { seconds: window, time: clock(time), exposures, graphsAt: rigGraphsAt(engine, time, window, rigAt) });
  } catch (e) {
    console.warn('[world3d] motion blur in the trace: the shutter could not be posed', e?.message || e);
    world.setMotionBlur(null);
    verdict = false;
  }
  live?.done();
  // (mblur5) the frame drawn next stands its letters as lined up for the shutter (finishWorldFrame), until clearWorldMotion
  if (verdict !== false && letters) {
    state.motionLetters = letters.get(time) || null;
    setShutterLetters(world, letters, time);
  }
  // the frame's own pose comes back with the caller's render (poseWorld sets it again)
  state.poseKey = null;
  return verdict !== false;
}

/** (mblur5) The Rig of the Scene layer showing at `time`, at any time `t` of that frame's shutter: its keys at `t`, and past the layer's ends
 *  the Rig as its nearer end has it (as activeRigAt holds a Rig outside its clip). A shutter that crosses a cut into another Scene layer
 *  (another environment map or backdrop shape: what no key changes) keeps the frame's own Scene for its whole length, as each frame of an
 *  edit shows its own shot: traced once, where it was 16 sub-frames of the two Scenes laid over each other (and the world built again for
 *  each). */
export function worldRigIn(engine, time) {
  return shutterRigIn(engine.rigEntries, time, (t) => engine.activeRigAt?.(t));
}

/** (mblur5) The Scene's own clock (rig3d.js sceneTimeAt: seconds from its clip's start, held at 0 before it and at its length after it) of
 *  the Scene layer showing at `time`, at any time `t` of that frame's shutter. Past a cut it keeps counting on the frame's own Scene's clock
 *  (held at its end), not on the next layer's, which starts again from 0: its objects' keys, sims and bodies stay where its own shot has
 *  them. `t` itself with no Scene layer. */
export function worldClockIn(engine, time) {
  return shutterClockIn(engine.rigEntries, time);
}

/** (mblur5) Whether the world was last laid out for the Scene layer showing at `time` (prepareWorldFrame). At a cut, a shutter's poses
 *  must be taken of the frame's own Scene: primeWorldFrame builds it first. */
const worldShowsSceneAt = (engine, time) => (resolveRigAt(engine.rigEntries, time)?.itemId ?? null) === (state.sceneItem ?? null);

/** (mblur5) Before a render's frame whose shutter the world takes (worldMotionBlur / worldDraftBlur): on the first frame of another Scene
 *  layer (a cut), the world is laid out for it and built (a frame drawn, not traced), so the shutter's poses are this Scene's and not the
 *  last frame's. In Draft, a keyed texture graph that changes inside the shutter (`window` seconds) is baked as its mean before the
 *  pictures are drawn (Final's trace bakes it as the frame settles). Nothing otherwise. */
export async function primeWorldFrame(engine, time, window = 0) {
  const rig = engine.activeRigAt?.(time);
  if (!state.host || !isWorldRig(rig)) return;
  if (!worldShowsSceneAt(engine, time)) {
    const was = engine.currentTime;
    engine.currentTime = time;
    try {
      engine.renderFrame?.();
      await worldSettled(engine);
    } finally {
      engine.currentTime = was;
    }
  }
  // (on the Scene's own clock, as the world reads its graphs' times); (mblur6) the Rig's keys on their numbers too
  const at = worldClockIn(engine, time)(time);
  if (window > 0 && !filmsFinal(rig) && state.ready && !state.building) {
    const graphsAt = rigGraphsAt(engine, time, window);
    if (!graphsAt || state.host.world.rigGraphsTakeable?.(graphsAt)) await state.host.world.shutterGraphs?.(at - window / 2, at + window / 2, graphsAt);
  }
}

/** (mblur6) The Rig's keys on its texture graphs' numbers (`sc:g~<material>:<param>`) across the shutter of the frame at `time` (`window`
 *  seconds centred on it), on the frame's own Scene layer (worldRigIn): (u) => the graphs' numbers at a share u (0..1) of the shutter (as
 *  worldLiveValues gives them: { material id: graph }), or null when they hold still across it (its opening, middle and close). */
function rigGraphsAt(engine, time, window, rigAt = worldRigIn(engine, time)) {
  return shutterGraphsIn(rigAt, resolveRigAt(rigEntriesOf(engine), time)?.rig, state.liveOptions, time, window);
}

/** (engine100b) The exposure the Rig's keys give a world Scene's film at time `t`: its environment's (the one exposure a Rig keys; the film
 *  takes it times the Rig's own, worldSceneFromRig; Final then times its render's own, trace.exposure). 1 for anything else. */
const exposureAt = shutterExposureAt;

/** (engine100b) `objects` with the Rig's backdrop where its keys have it at time `t` (its place, turn and scale: the mesh's pose, as poseWorld
 *  gives it), so a keyed backdrop moves through the shutter as any object does; as it is when the Rig has none. */
function withBackdropAt(engine, rigAt, t, objects) {
  const rig = rigAt(t);
  const b = rig ? engine.model3d?.cycloramaArrays?.(rig, engine.videoSize.h) : null;
  return b ? { ...(objects || {}), backdrop: worldMatrix(b.matrix) } : (objects || {});
}

/** (mblur3) The model layers the world draws, posed at time `t` (their own keys, GLB clips and poses, as prePoseWorldModels poses a frame,
 *  without their screens), as the world takes them (poseWorld's objects, node poses and morph weights). A model the physics holds (Physics)
 *  is the solver's: its start is not moved (that would start its fall again), its flight is the bodies' (WorldRenderer #motionBodies). */
function worldModelsAt(engine, env, t, rigAt = (u) => engine.activeRigAt?.(u), clock = (u) => sceneTimeAt(rigEntriesOf(engine), u)) {
  const mod = engine.model3d;
  const rig = rigAt(t);
  if (!mod?.poseModelLayer || !mod.modelWorldMatrix || !rig || engine.worldActive) return null;
  const { w, h } = engine.videoSize;
  const pending = [];
  for (const channel of env.channels) {
    if (channel.visible === false || channel.cameraLocked || !channel.items?.length) continue;
    const layout = env.layoutMap.get(channel.id);
    const index = layout ? resolveActiveIndex(layout, t) : -1;
    if (index < 0) continue;
    const item = channel.items[index];
    const clip = env.clipsMap.get(item?.clipId);
    if (clip?.mediaType !== 'model3d' || !worldHolds(item.id)) continue;
    const at = layout[index];
    const inClip = t - at.startTime;
    const progress = at.duration > 0 ? Math.max(0, Math.min(1, inClip / at.duration)) : 0;
    const kf = itemHasKeyframes(item) ? getItemKeyframeValues(item, progress) : null;
    // (enginebugs2) turned as the world turns its objects, as the frame's own pose (channelRender.js prePoseWorldModels);
    // (mblur5b) on the frame's own Scene clock (`clock`, held at that Scene's end past a cut)
    pending.push({ item, clip, prs: localPrs(item, kf, w, h, { sceneTurn: true }), sceneTurn: true, W: w, H: h, time: Math.max(0, inClip), sceneTime: clock(t), rig, frameToken: null, screens: false, env });
  }
  if (!pending.length) return null;
  mod.clearHeldModelMatrices?.();
  for (const opts of orderModelPoses(pending, env.channels)) mod.poseModelLayer(opts);
  const { models, parts } = collectModels(engine, env, t, mod);
  const held = new Map();
  for (const m of models) {
    for (const [id, a] of mod.modelAttachments?.(m.id) || []) held.set(id, a);
  }
  const objects = {}, nodePoses = {};
  let morphs = null;
  for (const m of models) {
    if (m.rigid || !(m.url || m.splat)) continue;
    const e = mod.modelWorldMatrix(m.id);
    if (e) objects[m.id] = held.has(m.id) ? heldModelMatrix(worldMatrix(e), held.get(m.id), WORLD_UNITS) : worldMatrix(e);
    if (!m.url) continue;
    const pose = mod.modelNodePose(m.id);
    if (pose) nodePoses[m.id] = pose;
    const weights = mod.modelMorphWeights?.(m.id);
    if (weights) (morphs ||= {})[m.id] = weights;
  }
  const rigidParts = new Set(models.filter((m) => m.rigid && m.baked).map((m) => m.id));
  for (const { id, itemId, part } of parts) {
    if (rigidParts.has(id)) continue;
    const e = mod.modelWorldMatrix(itemId);
    if (e) {
      const base = held.has(itemId)
        ? new THREE.Matrix4().fromArray(heldModelMatrix(worldMatrix(e), held.get(itemId), WORLD_UNITS))
        : new THREE.Matrix4().fromArray(worldMatrix(e));
      objects[id] = base.multiply(new THREE.Matrix4().fromArray(part.matrix)).elements;
    }
  }
  return { objects, nodePoses, morphs };
}

/** (mblur3) The Rig's keyed lights over a shutter: `at(t)` relights the world as the Rig's keys have its lights at `t` (their colour, strength,
 *  place: WorldRenderer.relight, in place), `done()` puts the frame's own back. (mblur4) And its environment (strength, turn, an Ambient's
 *  tint) and its backdrop's paint. Null when the Rig has no keys. (mblur6) A texture graph's keyed numbers stay the frame's own here: the
 *  world bakes their shutter's mean (rigGraphsAt). */
function shutterLive(engine, world, time, rigAt = (t) => engine.activeRigAt?.(t)) {
  // (mblur5) the frame's own Scene layer's, as it rests: a time past a cut keeps it (worldRigIn)
  const resting = resolveRigAt(rigEntriesOf(engine), time)?.rig;
  const valuesAt = shutterLiveValues(rigAt, resting, state.liveOptions);
  const own = valuesAt(time);
  if (!own || !world.relight) return null;
  // (mblur4) the environment (its strength, turn, an Ambient's tint) and the backdrop's paint are relit at each time too: the trace reads the
  // map and the paint at each sample's time. Its opacity keyed is not (the walk's alpha reads the middle's)
  // (engine100b) and its opacity: Draft relights each of its draws with it (WorldRenderer.relight), the trace reads it at each path's time
  // (tracerMotion.js mbPaintAlpha)
  // (mblur5) A shadow catcher's tint and strength keyed under the shutter no longer send the frame to the sub-frames: the frame's catcher is
  // the shutter's mean of them (laid over the shutter's mean of the shadow, #catcherMaskMotion: exact while either holds still).
  // (mblur6) Nor do the Rig's keys on a texture graph's numbers: each time is relit with the frame's own graph (a bake a time would only be
  // thrown away), and the world bakes the graphs as the shutter's mean (rigGraphsAt, WorldRenderer.setMotionBlur's `graphsAt`)
  const caught = new Map();
  return {
    at(t) {
      const v = valuesAt(t);
      if (!v) throw new Error('the Rig keys more than its lights under the shutter');
      if (!world.relight({ ...v, graphs: own.graphs })) throw new Error('the Rig keys its lights into others under the shutter');
      caught.set(t, v.catchers);
    },
    done() {
      const mean = meanCatchers(own.catchers, [...caught.values()]);
      try {
        if (world.relight(mean ? { ...own, catchers: mean } : own)) state.liveKey = JSON.stringify(own); else state.liveKey = null;
      } catch { state.liveKey = null; }
      // (the frame drawn next keeps that mean, its own values being the Rig's at its time; the one after relights: clearWorldMotion)
      if (mean) state.liveMean = true;
    },
  };
}

/** (mblur5) The shutter's mean of a catcher keyed under it (`list`: the catchers at each time, as worldLiveValues gives them): its strength,
 *  light and tint (the tint in linear light), null when none changes. */
function meanCatchers(own, list) {
  if (!own || !list.length || list.every((c) => JSON.stringify(c) === JSON.stringify(own))) return null;
  const out = {};
  for (const [id, c0] of Object.entries(own)) {
    const all = list.map((c) => c?.[id]).filter((c) => c && typeof c === 'object');
    if (!all.length || typeof c0 !== 'object') { out[id] = c0; continue; }
    const avg = (k, d) => all.reduce((sum, c) => sum + (Number.isFinite(c[k]) ? c[k] : d), 0) / all.length;
    const tint = new THREE.Color(0, 0, 0), one = new THREE.Color();
    for (const c of all) tint.add(one.set(c.tint || '#000000').multiplyScalar(1 / all.length));
    out[id] = { ...c0, tint: `#${tint.getHexString()}`, strength: avg('strength', 1), ...(c0.light !== undefined ? { light: avg('light', 0) } : {}) };
  }
  return out;
}

/** (mblur5) Draft's pictures of a shutter stand at most this many pixels apart on the screen (a fast spin's banded copies, cloverref), and
 *  at most this many are drawn a frame. */
const DRAFT_DRAW_SPACING = 2;
const DRAFT_DRAWS_MAX = 64;

/** (mblur2) Motion blur of a Draft Scene in light, for one frame of a render whose shutter sees only the Scene's world move (the exporter
 *  checks the rest): the world is drawn at each of `samples` times across the shutter (`window` seconds centred on `time`, as the
 *  sub-frames would be), each draw's light added into the shutter's average before the film look (WorldRenderer.frame's `shutter`), as
 *  Final's trace averages light; the caller then renders the frame, whose world films that average (held until clearWorldDraftBlur).
 *  Draft and Final then blur alike: the same times, light averaged, then filmed once. False when the world cannot (a Scene over other
 *  layers, gas, splats, effects on objects, catchers: WorldRenderer.draftShutterPossible): the caller averages sub-frames as before. */
export function worldDraftBlur(engine, { time, window, samples, maxTime = Infinity, cameraPoseAt, env = null, textAt = null }) {
  const world = state.host?.world;
  const rig = engine.activeRigAt?.(time);
  state.motionLetters = null;
  if (!isWorldRig(rig) || filmsFinal(rig) || !world?.draftShutterPossible || !state.ready || state.building || state.failed
    || worldBlockedOn(engine) || state.builtGeneration !== state.generation || !world.draftShutterPossible() || !worldShowsSceneAt(engine, time)) return false;
  const { w: W, h: H } = engine.videoSize;
  const ownCamera = !!rig.scene?.camera;
  const rest = (H * 0.5) / Math.tan((28 * Math.PI) / 180 / 2);
  const rigged = !!world.rigInfo && Array.isArray(rig.scene?.objects) && rig.scene.objects.some((o) => o?.skeleton && o?.pose);
  const base = Math.max(2, Math.min(32, Math.round(samples || 16)));
  const K = world.motionSteps;
  const stepTimes = Array.from({ length: K }, (_, k) => Math.max(0, Math.min(maxTime, time - window / 2 + (window * k) / (K - 1))));
  // (mblur5) the 3D Text letters the world takes, laid out at the shutter's steps (and below, at each draw's time too), as Final's
  let letters = null;
  try { letters = shutterLetters(engine, env, textAt, time, stepTimes, 'own'); } catch (e) {
    console.warn('[world3d] Draft motion blur in light: the shutter could not be drawn', e?.message || e);
    return false;
  }
  // (mblur3) the Rig's keyed lights relit at each time, the model layers posed there, the physics' bodies where they fly then; (mblur5) the
  // frame's own Scene layer's Rig and clock all through the shutter (worldRigIn, worldClockIn)
  const rigAt = worldRigIn(engine, time);
  const clock = worldClockIn(engine, time);
  let live = null;
  try { live = shutterLive(engine, world, time, rigAt); } catch { return false; }
  // (mblur6) the Rig's keys on a texture graph's numbers: its mean baked before the draws (primeWorldFrame), unless they change which maps it
  // makes (a rebuild): then sub-frames
  const graphsAt = rigGraphsAt(engine, time, window, rigAt);
  if (graphsAt && !world.rigGraphsTakeable?.(graphsAt)) return false;
  const poseAt = (t) => {
    const pose = cameraPoseAt?.(t) || null;
    const proxy = pose ? cameraProxyFromPose(pose, W, H) : null;
    let nodePoses = {};
    if (rigged) {
      state.scenePoser ||= createScenePoser();
      nodePoses = state.scenePoser.pose(worldClocksScene(rig.scene), clock(t), (id) => world.rigInfo(id)).nodePoses;
    }
    const models = env ? worldModelsAt(engine, env, t, rigAt, clock) : null;
    live?.at(t);
    const camera = ownCamera ? null : worldCamera(proxy, rest);
    const lens = ownCamera ? null : worldLens(getCameraDofSettings(pose, rest), W, camera.fov, W / H);
    world.setPose({ camera, steer: ownCamera && proxy ? worldSteer(proxy, rest) : null, objects: withBackdropAt(engine, rigAt, t, models?.objects), lens, time: clock(t),
      nodePoses: { ...(models?.nodePoses || {}), ...nodePoses }, ...(models?.morphs ? { morphs: models.morphs } : {}), shutter: true, visibleAt: clock(time) });
    setShutterLetters(world, letters, t);
  };
  // the world at the frame's own time and at the shutter's steps (with the vertices of what changes shape at its own time and the ends)
  const capture = () => {
    poseAt(time);
    const center = world.captureMotion({ deform: true });
    const steps = [];
    for (let k = 0; k < K; k += 1) {
      poseAt(stepTimes[k]);
      steps.push(world.captureMotion({ deform: k === 0 || k === K - 1 }));
    }
    return { center, steps };
  };
  try {
    sizeWorld(engine);
    // (mblur5) the shutter's poses first: how far the picture moves across it says how many pictures Draft draws (the Blur level's, more
    // when two of them would stand more than DRAFT_DRAW_SPACING pixels apart: a fast spin drew as banded copies), and over a see-through
    // sky the held average's depth holds them
    let shot = capture();
    const travel = world.shutterTravel ? world.shutterTravel(shot.center, shot.steps) : 0;
    const n = Math.max(base, Math.min(DRAFT_DRAWS_MAX, Math.ceil(travel / DRAFT_DRAW_SPACING)));
    const drawTimes = Array.from({ length: n }, (_, i) => Math.max(0, Math.min(maxTime, time - window / 2 + (window * (i + 0.5)) / n)));
    // (and the letters at each draw's time, lined up with the steps' again: the coverage's poses taken again with them)
    if (letters) {
      letters = shutterLetters(engine, env, textAt, time, [...stepTimes, ...drawTimes], 'own');
      if (world.setDraftMotion) shot = capture();
    }
    // (mblur6) past DRAFT_DRAWS_MAX the pictures stand more than DRAFT_DRAW_SPACING apart: each one is smeared along each pixel's motion over
    // its share of the shutter (WorldRenderer.setDraftStreak), so the copies join into one streak at any travel, for the price of one plain
    // draw of the world and a gather a picture
    const streak = travel / n > DRAFT_DRAW_SPACING && !!world.setDraftStreak;
    if (streak) world.setDraftStreak(shot);
    if (Array.isArray(globalThis.__world3dMotionLog)) globalThis.__world3dMotionLog.push({ time, verdict: 'draft', why: `${n} draws, ${travel.toFixed(1)} px${streak ? ', streaked' : ''}`, objects: [] });
    // (engine100b) each draw's light weighed by the exposure the Rig's keys give its time, over the frame's (the frame films with its own)
    const e0 = exposureAt(rigAt, time);
    for (let i = 0; i < n; i += 1) {
      const t = drawTimes[i];
      poseAt(t);
      world.frame({ shutter: { i, n, gain: exposureAt(rigAt, t) / e0, ...(streak ? { streak: { u0: i / n, u1: (i + 1) / n } } : {}) } });
    }
    if (streak) world.setDraftStreak(null);
    world.holdShutter(true);
    // over a sky the layers below show through, the held picture's depth holds every pose of the shutter (as Final's moving frames)
    if (world.setDraftMotion) world.setDraftMotion(shot.center, shot.steps);
    // (mblur6) and the unlit cards and flat letters over it at each time of the shutter, averaged (a camera that moves, cards that move)
    world.setDrawnShutter?.(shot.center, shot.steps);
  } catch (e) {
    console.warn('[world3d] Draft motion blur in light: the shutter could not be drawn', e?.message || e);
    world.holdShutter?.(false);
    world.setDraftStreak?.(null);
    live?.done();
    state.poseKey = null;
    return false;
  }
  live?.done();
  // (mblur5) the frame drawn next stands its letters as lined up for the shutter (finishWorldFrame), until clearWorldDraftBlur
  if (letters) {
    state.motionLetters = letters.get(time) || null;
    setShutterLetters(world, letters, time);
  }
  // the frame's own pose comes back with the caller's render (poseWorld sets it again)
  state.poseKey = null;
  return true;
}

/** (mblur2) The frame worldDraftBlur averaged is rendered: the world draws its frames again. */
export function clearWorldDraftBlur() {
  state.motionLetters = null;
  state.host?.world?.holdShutter?.(false);
}

/** (mblur) A render with motion blur and a Final Scene starts (true) or ends (false): the world makes room for the shutter's poses before
 *  its first trace, so the first moving frame does not build the tracer's scene and kernels a second time (WorldRenderer.reserveMotion).
 *  The frames that do not move trace exactly as without it. */
export function reserveWorldMotion(on, { trace = true } = {}) {
  state.motionWanted = !!on && trace;
  // (mblur2) and, for any Scene (Draft too), sims drawn at the time drawn: the returned promise resolves once the world has them
  state.shiftWanted = !!on;
  if (on && state.ready && trace) state.host?.world?.reserveMotion?.();
  return on && state.ready ? (state.host?.world?.wantMotionShift?.() || Promise.resolve()) : Promise.resolve();
}

/** (mblur) The frame worldMotionBlur prepared is rendered: the world's next frames are traced still again. */
export function clearWorldMotion() {
  state.motionLetters = null;
  // (mblur5) a shutter's mean of a keyed catcher held for its frame: the next frame relights from its own values
  if (state.liveMean) { state.liveMean = false; state.liveKey = 'shutter mean'; }
  state.host?.world?.setMotionBlur?.(null);
}

/** Whether what this project's world runs by itself (bodies, a .blend's baked playback) moves between two times, for the export's motion
 *  blur (worldMotion.js). Null until the world is built. (mblur5) `time`: the frame whose shutter it is: both times on its own Scene's
 *  clock (worldClockIn; a shutter past a cut does not jump to the next Scene's). */
export function worldMovesBetween(t0, t1, time = (t0 + t1) / 2) {
  if (!state.ready || !state.host || state.builtGeneration !== state.generation) return null;
  const clock = state.engine ? worldClockIn(state.engine, time) : (t) => t;
  return state.host.world.movesBetween?.(clock(t0), clock(t1)) ?? null;
}

/** What the player bar says, in words. Never on the picture. */
export async function worldStatus() {
  const w = state.host?.world;
  // Final traces only on pause: playing hides its start badge
  if (state.engine?.isPlaying && state.load?.stage === 'final') reportLoad(null);
  // (robust) the preview's Final stopped on a GPU failure: said in the player bar until Final is turned off
  if (state.final && state.finalFailed) return { failed: state.finalFailed, done: false, spp: 0, target: w?.trace?.spp ?? 0, seconds: 0 };
  if (!state.final || !w?.traceWanted) return null;
  const done = await w.traceDone();
  // (robust) a GPU program this GPU did not compile, a trace with no sample, memory or a buffer past the GPU's: the preview stops tracing
  // and says so at once (a lost device is drawn again on a new one instead: recoverLostPreview)
  const fatal = w.gpuFatal?.(w.traceStart || 0);
  if (fatal && fatal.code !== 'GPU_DEVICE_LOST') {
    state.finalFailed = { code: fatal.code, message: fatal.message };
    console.warn(`[world3d] Final 3D stopped in the preview: [${fatal.code}] ${fatal.message}`);
    w.setTrace(false);
    w.invalidate?.();
    if (state.load?.stage === 'final') reportLoad(null);
    if (state.engine && !state.engine.isPlaying) state.engine.renderFrame?.();
    return { failed: state.finalFailed, done: false, spp: 0, target: w.trace.spp, seconds: 0 };
  }
  const spp = Math.round(w.spp || 0);
  // Final's notice (WorldLoadBadge) is for its start only: gone at the first sample, as the samples count in the player bar. A trace
  // whose first sample lands before the notice would show (a camera nudge on a tracer already built) never shows one.
  if (done || spp > 0) { if (state.load?.stage === 'final') reportLoad(null); }
  else if (!state.load) reportLoad({ stage: 'final' });
  // the time to the finished picture once it is there, not the time since the trace began
  return { done, spp, target: w.trace.spp, seconds: ((done && w.traceEnd ? w.traceEnd : performance.now()) - (w.traceStart || 0)) / 1000 };
}

/** How far along the view the world's surface lies at (x, y) in the frame, in the compositor's pixels. Null over nothing. */
export function worldDepthAt(x, y) {
  if (!state.ready || !state.host) return null;
  const hit = state.host.world.pick(x, y);
  return hit ? hit.distance / WORLD_UNITS : null;
}

export const worldHost = () => state.host;

/** The world posed at `time` (its objects, the Scene's own camera, the lens), for a measurement of a still after the capture: the capture
 *  puts the playhead back and draws that frame again, so the world stands where the user was, not in the still. Nothing is drawn.
 *  Returns what puts it back. A world filmed from the Camera layer keeps that camera where it is. */
export function worldPoseAt(timelineTime, project = null) {
  const world = state.ready ? state.host?.world : null;
  const prev = world?.time;
  const time = Number.isFinite(timelineTime) ? sceneTimeAt(state.engine?.rigEntries, timelineTime) : NaN;
  if (!world || !Number.isFinite(time) || !Number.isFinite(prev)) return () => {};
  // (camlayer) the Camera layer's camera at that time too (`project`: { channels, clips, videoSize }): applyTime poses only a Scene camera
  const c = world.camera;
  const was = world.freeCamera && project?.channels ? { p: c.position.toArray(), q: c.quaternion.toArray(), up: c.up.toArray(), fov: c.fov } : null;
  const shot = was ? cameraLayerShot(project, [timelineTime])[0] : null;
  if (Math.abs(prev - time) < 1e-6 && !shot) return () => {};
  // a measurement must never cost the still: if the world cannot be posed, it is measured where it stands
  try {
    world.applyTime(time);
    if (shot) {
      c.position.fromArray(shot.at);
      c.up.fromArray(shot.up);
      c.lookAt(...shot.target);
      c.fov = shot.fov;
      c.updateProjectionMatrix();
      c.updateMatrixWorld();
    }
  } catch { return () => {}; }
  return () => {
    try {
      world.applyTime(prev);
      if (was) { c.position.fromArray(was.p); c.up.fromArray(was.up); c.quaternion.fromArray(was.q); c.fov = was.fov; c.updateProjectionMatrix(); c.updateMatrixWorld(); }
    } catch { /* the next frame poses it again */ }
  };
}

/** What the world shows at (u, v) of the frame (0..1, v down), and how far along the view it stands in the compositor's pixels: what a
 *  flat layer at that depth would be hidden by (worldLayerCritique.js). Null over nothing, or before the world has a frame. */
export function worldPickAt(u, v) {
  if (!state.ready || !state.host) return null;
  const hit = state.host.world.pick(u, v);
  return hit ? { id: hit.id, distance: hit.distance / WORLD_UNITS } : null;
}

/** (enginebugs) Whether the world's picture covers the whole frame (an opaque environment or a colour background, WorldRenderer's
 *  backgroundSolid): what a layer under the Scene then shows of itself is nothing. False before the world has a frame. */
export function worldCoversFrame() {
  return !!(state.ready && state.host?.world?.backgroundSolid?.value > 0.5);
}

/** The Scene's own camera (keys included), the time it stands at, and each object's box: what a check of the camera's move over the
 *  whole clip needs (world3d/cameraPath.js), with no render. Null when the world films from the editor's camera (a Camera layer moves
 *  it then) or has no frame yet. */
export function worldCameraFacts() {
  if (!state.ready || !state.host) return null;
  const camera = state.host.scene?.camera;
  if (!camera || state.host.world.freeCamera) return null;
  return { camera, ...worldObjectFacts() };
}

/** (camlayer) Who filmed the world's last frame and from where: { films: 'scene' | 'cameraLayer', at, target, up, fov }, metres and degrees
 *  (target one metre along the line of sight). Null before the world has a frame. */
export function worldViewReport() {
  if (!state.ready || !state.host?.world?.posed) return null;
  const c = state.host.world.camera;
  c.updateMatrixWorld();
  const e = c.matrixWorld.elements, r4 = (v) => Math.round(v * 1e4) / 1e4;
  const at = [c.position.x, c.position.y, c.position.z];
  return { films: state.host.world.freeCamera ? 'cameraLayer' : 'scene', at: at.map(r4), target: [at[0] - e[8], at[1] - e[9], at[2] - e[10]].map(r4),
    up: [e[4], e[5], e[6]].map(r4), fov: r4(c.fov), ...(c.isOrthographicCamera ? { ortho: true } : {}) };
}

/** (camlayer) Each object's box where it rests and how far its keys carry it at another Scene time (`shift(t)`), the Scene's time now and
 *  whether the editor's Camera layer films it (`freeCamera`): what a check of a move over the clip needs, with no render. */
export function worldObjectFacts() {
  if (!state.ready || !state.host) return null;
  // where each object rests (inspect's boxes), and how far its `at` keys, or a parent's, carry it at another time
  const scene = state.host.scene;
  const byId = new Map((scene?.objects || []).map((o) => [o.id, o]));
  const objects = (state.host.inspect().objects || []).map(({ id, bbox }) => ({ id, bbox, shift: (t) => travel(byId.get(id), byId, t, scene) }));
  return { now: state.host.world.time || 0, aspect: state.host.world.camera?.aspect || 16 / 9, objects, scene, freeCamera: !!state.host.world.freeCamera };
}

function diagnosticPose(view) {
  if (!view?.at || !view?.target) return null;
  const eye = new THREE.Vector3(...view.at);
  const tgt = new THREE.Vector3(...view.target);
  const up = new THREE.Vector3(...(view.up || [0, 1, 0]));
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(eye, tgt, up));
  return { position: [eye.x, eye.y, eye.z], quaternion: q.toArray(), fov: view.fov ?? 32 };
}

/** Temporarily override the world camera with `{ at, target, up, fov }` (in metres/degrees) for diagnostic still angles; `draft`: a Final
 *  Scene is filmed in Draft meanwhile (filmsFinal). Null restores both. The pose films sharp without touching the scene's camera
 *  (poseWorld: WorldRenderer.setPose `pinhole`), so its depth of field is the same in every later still and render of the page. */
export function setWorldDiagnosticView(cam = null, { draft = false } = {}) {
  state.diagnosticCamera = cam ? { ...cam } : null;
  state.diagnosticDraft = !!draft;
  state.poseKey = null;
}

/** The box `{ min, max, ids }` (metres) the diagnostic views frame, over the objects as they stand now: the `objects` named, or the
 *  Scene's subject without its set (world3d/multiView.js subjectBounds: no backdrop, floors, walls, rooms or objects hidden by their
 *  `visible` keys). Null before the Scene is built or when nothing has a box. */
export function worldSubjectBounds({ objects = null } = {}) {
  if (!state.ready || !state.host) return null;
  const r = state.host.inspect?.() || {};
  return subjectBounds(r.objects, { named: objects, hidden: (r.hiddenByKeys || []).map((h) => h.id) });
}

/** (simcritique) For a still's critique: every set's numbers (worldSims.probes: live, dead, NaN, faulted, max speed, bounds, the bricks
 *  wanted past a pool) of the sims in their clip at timeline `time`, each row with its frame's own clip time `t` (the pre-roll negative).
 *  The sims are stepped back to that time first: the capture drew the page's own frame again after the still. Null with no sims. */
export async function worldSimProbes(timelineTime) {
  const sims = state.ready ? state.host?.world?.simWorld : null;
  if (!sims?.items?.length) return null;
  const t = sceneTimeAt(state.engine?.rigEntries, Math.max(0, Number(timelineTime) || 0));
  await sims.settleAt(t);
  const shown = new Set(sims.items.filter((it) => sims.showing(it, t)).map((it) => it.id));
  const rows = (await state.host.simProbes()).filter((row) => shown.has(row.sim));
  return rows.map((row) => {
    const plan = sims.items.find((x) => x.id === row.sim)?.plan;
    return plan && Number.isFinite(row.frame) ? { ...row, t: +(row.frame / plan.fps - plan.clip.preroll).toFixed(4) } : row;
  });
}

/** (Track 6.5) Pre-tonemap linear HDR snapshot from the active WorldRenderer (`256x144` floats). */
export async function worldLinearHdrFrame() {
  return state.ready && state.host?.world?.readLinearHdrFrame ? state.host.world.readLinearHdrFrame() : null;
}

export function worldReleaseHdrScope() {
  state.host?.world?.disposeScopeReadback?.();
}
