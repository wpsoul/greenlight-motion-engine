/*
 * The 3D model / rig runtime and the particle runtime, loaded on first need (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md,
 * Stage 9 step 8 — moved verbatim out of the Player, `xRef.current` → `engine.x`).
 *
 * A project with no model, rig or particle layer never loads either module. The preview asks for the 3D module from
 * the first frame that draws a model or a rig and repaints when it lands (requestModel3dModule); an export gets one
 * pass per frame, so its paths await it before their first frame (ensureModel3dModule / ensureParticleModule).
 *
 * Engine fields: model3d (the loaded module), model3dLoading, model3dModule (its promise), particle, particleModule.
 *
 *   requestModel3dModule(engine, onLoaded)     preview: start the import once; onLoaded repaints
 *   ensureModel3dModule(engine)                → the module (awaitable)
 *   ensureParticleModule(engine, onBake)       → the particle runtime; onBake repaints when an off-thread bake lands
 *   disposeEngine3d(engine)                    with the renderer: every model / plate / rig / particle resource
 */

export function requestModel3dModule(engine, onLoaded) {
  if (!engine.model3dLoading) {
    engine.model3dLoading = true;
    import('../model3dLayer').then((m) => {
      engine.model3d = m;
      // The frame that triggered this import drew nothing for the layer;
      // redraw now that the module can actually render it.
      onLoaded?.();
    }).catch(() => {});
  }
}

/**
 * The 3D model / rig module, the same way: preview imports it from the first frame
 * that draws a model or a rig and repaints, but an export gets one pass per frame,
 * so its opening frames came out without the set.
 */
export async function ensureModel3dModule(engine) {
  if (engine.model3d) return engine.model3d;
  engine.model3dLoading = true;
  if (!engine.model3dModule) {
    engine.model3dModule = import('../model3dLayer').then((m) => {
      engine.model3d = m;
      return m;
    });
  }
  return engine.model3dModule;
}

/**
 * The particle runtime, imported on first need and shared by every caller.
 *
 * Preview can afford to miss a frame and repaint; an export cannot, so the
 * export paths await this before their first frame rather than discovering the
 * module halfway through an encode.
 */
export async function ensureParticleModule(engine, onBake) {
  if (engine.particle) return engine.particle;
  if (!engine.particleModule) {
    engine.particleModule = Promise.all([
      import('../particleLayer'),
      import('../../../sim/particles/client.js'),
    ]).then(([layer, client]) => {
      engine.particle = { ...layer, ...client };
      // An off-thread bake finishes after the frame that asked for it has been
      // drawn from the previous cache. Repaint when the real one lands.
      client.setParticleBakeListener?.(() => onBake?.());
      return engine.particle;
    });
  }
  return engine.particleModule;
}

export function disposeEngine3d(engine) {
  try { engine.model3d?.disposeAllModelLayers?.(); } catch { /* no-op */ }
  try { engine.model3d?.disposeAllPlateLayers?.(); } catch { /* no-op */ }
  try { engine.model3d?.disposeRigLayer?.(); } catch { /* no-op */ }
  try { engine.model3d?.disposeSharedWorld?.(); } catch { /* no-op */ }
  // Instanced geometry, shader, ramp texture and render target per solver, plus
  // the simulation caches — none of which survive a renderer teardown.
  try { engine.particle?.disposeAllParticleLayers?.(); } catch { /* no-op */ }
  try { engine.particle?.disposeAllParticleCaches?.(); } catch { /* no-op */ }
  // The Tier 2 pools live on a PRIVATE device, so a renderer teardown does
  // not take them with it — they have to be released by name.
  try { engine.particle?.disposeAllParticleGpu?.(); } catch { /* no-op */ }
}
