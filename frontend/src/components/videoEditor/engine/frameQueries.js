/*
 * What a frame asks and waits for (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 28e1 — moved verbatim out of
 * Player.jsx with tests/engine-extraction/tools/stage9_reshape_step.py): the raster budget and the renderer's texture
 * limits, the Scene Rig active at a time (with its keyframes applied), the motion-template and background pictures to
 * load first, whether the project holds 3D or GPU-particle layers, and the particle plates a rendered frame settles
 * before it is read. The envs a React-free driver builds (step 28e) hold these as plain functions.
 */
import { PARTICLE_MEDIA_TYPE } from '../../../sim/particles/schema.js';
import { evaluatePropertyTrack } from '../gsapTransitions';
import { isMotionVideoUrl, prepareMotionVideo } from '../motionTemplates';
import { getMotionImage } from '../motionTemplates/mtl';
import { resolveTextureBudgetBytes } from '../previewDeviceTier.js';
import { createTextureBudget, FALLBACK_MAX_TEXTURE_DIM, MAX_CANVAS_AREA } from '../rasterDensity';
import { applyRigKeyframes, isRigColorTrackKey, isRigTrackKey, resolveRigAt, RIG_MEDIA_TYPE } from '../rig3d';
import { PREVIEW_TIER } from './previewMedia';

export function getRasterBudget(engine) {
  if (!engine.rasterBudget) {
    // Electron's report keeps today's autoBudgetBytes path; a browser has no
    // such report and takes the tier's figure (512 MB desktop — the same value
    // as before — or the RAM-derived tablet budget, A8).
    const sys = (typeof window !== 'undefined' && window.electronAPI?.systemMemory) || null;
    engine.rasterBudget = createTextureBudget(resolveTextureBudgetBytes({ systemMemory: sys, tier: PREVIEW_TIER }));
  }
  return engine.rasterBudget;
}

export function getRasterCaps(engine) {
  return ({
    maxDim: engine.renderer?.capabilities?.maxTextureSize || FALLBACK_MAX_TEXTURE_DIM,
    maxArea: MAX_CANVAS_AREA,
  });
}

export function activeRigAt(engine, time) {
  const entry = resolveRigAt(engine.rigEntries, time);
  if (!entry?.rig) return null;
  const tracks = entry.propertyKeyframes;
  if (!tracks) return entry.rig;
  const span = Math.max(1e-6, entry.endTime - entry.startTime);
  // Clamped, not wrapped: outside the clip the rig holds its end pose, matching the
  // "nothing goes dark because of where the playhead is" rule resolveRigAt encodes.
  const pct = Math.max(0, Math.min(1, (time - entry.startTime) / span)) * 100;
  const values = {};
  let any = false;
  for (const [key, track] of Object.entries(tracks)) {
    if (!isRigTrackKey(key)) continue;
    const v = evaluatePropertyTrack(track, pct, isRigColorTrackKey(key));
    if (v !== undefined) { values[key] = v; any = true; }
  }
  return any ? applyRigKeyframes(entry.rig, values) : entry.rig;
}

export function awaitMotionImages(engine, env) {
  const urls = [...env.motionImageUrls, ...env.backgroundUrls, ...env.shapeBackgroundUrls];
  if (urls.length === 0) return Promise.resolve();
  return Promise.all(urls.map((url) => (
    isMotionVideoUrl(url) ? prepareMotionVideo(url) : getMotionImage(url).ready
  )));
}

export function hasModel3dLayers(engine, env) {
  return env.channels.some((ch) => (ch.items || []).some((item) => {
    const type = env.clipsMap.get(item.clipId)?.mediaType;
    return type === 'model3d' || type === RIG_MEDIA_TYPE;
  }));
}

export async function pumpParticlePlates(engine) {
  const mod = engine.particle;
  if (!mod?.pumpParticleGpu) return false;
  try { return (await mod.pumpParticleGpu()) > 0; } catch { return false; }
}

export async function settleParticlePlates(engine) {
  const mod = engine.particle;
  if (!mod) return;
  /*
   * ONCE PER SESSION: THE ENGINE CHUNK AND THE ADAPTER PROBE.
   *
   * Before those land, ensureParticleGpu returns null WITHOUT creating
   * anything — so the "is a runtime still starting?" question below answers
   * "no" for the uninteresting reason, the loop breaks immediately, and the
   * frame is captured with nothing drawn. That is the whole of "the first
   * exported still of a big particle layer is blank". After the probe has
   * resolved this costs nothing, which is why it is gated rather than always
   * paid: an export renders this per frame.
   */
  if (mod.particleGpuProbed && !mod.particleGpuProbed()) {
    try { await mod.probeParticleGpu?.(); } catch { /* no engine here */ }
    engine.renderFrame();     // now the layer can actually ask for a runtime
  }
  for (let guard = 0; guard < 3; guard += 1) {
    let pending = false;
    try { pending = !!mod.particleGpuPending?.(); } catch { pending = false; }
    if (!pending) break;
    try { await mod.particleGpuSettled?.(); } catch { /* no runtime */ }
    engine.renderFrame();
  }
  if (await pumpParticlePlates(engine)) engine.renderFrame();
}

export function hasParticleLayers(engine, env) {
  return env.channels.some((ch) => (ch.items || []).some(
    (item) => env.clipsMap.get(item.clipId)?.mediaType === PARTICLE_MEDIA_TYPE && item.particleSystem
  ));
}
