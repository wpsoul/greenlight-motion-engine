/*
 * One declarative multi-pass effect (`def.passes`): walk the passes, writing each intermediate into a pooled target
 * and binding it by name to whichever later pass asks for it. Only the `main` pass writes the effect's output, into
 * `write`. Moved out of runEffectChain so a second caller — the text-animation Deep Glow (textDeepGlow.js), which
 * runs the Deep Glow passes over a text plate — walks exactly the same code.
 *
 * WebGPU: each buffer is a handle `{ tex, isRT, flip? }`. Quad-written plates — the chain input and every pass
 * target — sample upright under plain UV (measured across the catalogue). The ONE exception is the camera-rendered
 * isolate, which lands on the opposite V axis and needs the structural flipY, exactly like matteClip's uMatte.
 * Materials are cached per resolved flip map because flipY is fixed at TSL construction.
 *
 * Returns false when a pass could not get a material or a target (the caller then treats the effect as skipped).
 */
import { applyEffectUniforms } from '../adjustmentEffects';
import { getEffectMaterial as getEffectMaterialInEngine } from './effectMaterials';
import { boxAabb } from './layerHelpers';
import { ensurePassTarget as ensurePassTargetInEngine } from './passPool';

export function runDeclarativePasses(engine, { def, eff, effForUniforms, params, setCtx, uniformCtx, read, write, buffers }) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  const scene = engine.effectScene;
  const mesh = engine.effectMesh;
  if (!renderer || !orthoCamera || !scene || !mesh) return false;
  let autoSlot = 0;
  for (const pass of def.passes) {
    if (!pass.main && pass.skipIf && pass.skipIf(params, setCtx)) {
      buffers[pass.target] = buffers[pass.alias] ?? null;
      continue;
    }
    const bind = { uSource: buffers.source };
    // `inputs` may be a function of the params: Fast Blur reads whichever
    // pyramid level this frame's Blurriness picked.
    const passInputs = typeof pass.inputs === 'function' ? pass.inputs(params, setCtx) : pass.inputs;
    for (const [uniform, buffer] of Object.entries(passInputs || {})) {
      bind[uniform] = buffers[buffer] ?? null;
    }
    // The flip map resolves from the BOUND HANDLES, not the pass def's
    // names: a skipped pass aliases its target straight to the matte plate
    // (longShadow with Softness 0 reads the isolate as `sB`), so only the
    // texture's provenance says which axis a binding is on.
    const flips = {};
    for (const [uniform, handle] of Object.entries(bind)) {
      if (handle?.flip) flips[uniform] = true;
    }
    // Which bound samplers share ONE texture, as a pattern (uniform → index
    // of the first sampler holding the same texture). A pass material is
    // built per pattern: on WebGPU a material first built while two of its
    // samplers held one texture (a skipIf alias) kept reading that texture
    // through both after the alias ended — ASCII's edge votes came back as
    // the cell plate. Measured; the porting guide's "key on the resolved
    // binding" rule (§7).
    const shared = new Map();
    const variant = Object.keys(bind).sort().map((uniform) => {
      const tex = bind[uniform]?.tex ?? null;
      if (!shared.has(tex)) shared.set(tex, shared.size);
      return `${uniform}:${shared.get(tex)}`;
    }).join(',');
    const passMat = getEffectMaterialInEngine(engine, eff, `pass:${pass.key}`,
      Object.keys(flips).length ? flips : null, variant);
    if (!passMat) return false;
    // Per-pass resolution (the roadmap's `pass.scale`): a downsampled pass
    // renders into a smaller target, and its uResolution must be THAT size
    // (fragments derive uv from gl_FragCoord). Later passes just sample the
    // texture by uv, so mixed sizes compose transparently.
    // `scale` may be per axis ([sx, sy]: Fast Blur halves only the axes it
    // blurs) and a function of the params (the pyramid level).
    const rawScale = pass.main ? 1
      : (typeof pass.scale === 'function' ? pass.scale(params, setCtx) : (pass.scale || 1));
    const sx = Array.isArray(rawScale) ? rawScale[0] : rawScale;
    const sy = Array.isArray(rawScale) ? rawScale[1] : rawScale;
    // pass.size = a FIXED target (Copy Color Profile's 4×1 stats strip),
    // independent of the plate; its uResolution is that size too. A function
    // sizes it from the params (ASCII's one texel per character) and keeps ONE
    // pool slot that resizes in place, so an animated Cell Size never piles up
    // a target per size.
    const dynamicSize = !pass.main && typeof pass.size === 'function';
    const fixedRaw = pass.main ? null : (dynamicSize ? pass.size(params, setCtx) : pass.size);
    const fixed = Array.isArray(fixedRaw) ? fixedRaw : null;
    const pw = fixed ? Math.max(1, Math.round(fixed[0])) : Math.max(1, Math.round(read.width * sx));
    const ph = fixed ? Math.max(1, Math.round(fixed[1])) : Math.max(1, Math.round(read.height * sy));
    applyEffectUniforms(passMat, effForUniforms,
      sx === 1 && sy === 1 && !fixed ? uniformCtx : { ...uniformCtx, width: pw, height: ph });
    if (pass.set) {
      const slots = pass.set(params, setCtx);
      for (const [slot, value] of Object.entries(slots)) passMat.uniforms.uParams.value[Number(slot)] = value;
    }
    // pass.region names a buffer whose projected box bounds the pass's
    // sampling: its frame-uv AABB (inset by params.inset %) lands in
    // uParams[24..27]. A buffer without a box means the whole frame.
    if (pass.region) {
      const aabb = boxAabb(buffers[pass.region]?.box || null, Number(params.inset) || 0);
      const up = passMat.uniforms.uParams.value;
      up[24] = aabb[0]; up[25] = aabb[1]; up[26] = aabb[2]; up[27] = aabb[3];
    }
    // uSource is what the main pass's uMix bypass fades back to; an explicit
    // `inputs.uSource` (the choker) overrides it below.
    if (passMat.uniforms.uSource) passMat.uniforms.uSource.value = bind.uSource?.tex ?? buffers.source.tex;
    for (const [uniform, handle] of Object.entries(bind)) {
      if (uniform === 'uSource') continue;
      if (passMat.uniforms[uniform]) passMat.uniforms[uniform].value = handle?.tex ?? null;
    }
    let target;
    if (pass.main) {
      target = write;
    } else {
      // poolSlot lets a chain reuse two targets as a ping-pong (the jump-flood
      // steps); unnamed passes get their own auto slot. The key carries scale,
      // filtering and precision so unlike targets never fight over one allocation.
      const slot = pass.poolSlot != null ? `s${pass.poolSlot}` : `a${autoSlot++}`;
      const sizeKey = dynamicSize ? 'dyn' : (fixed ? `${pw}x${ph}` : `${sx}x${sy}`);
      target = ensurePassTargetInEngine(engine,
        `${slot}:${sizeKey}:${pass.nearest ? 'n' : 'l'}${pass.hdr ? ':h' : ''}`,
        pw, ph, !!pass.nearest, !!pass.hdr
      );
      if (!target) return false;
    }
    mesh.material = passMat;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, orthoCamera);
    if (!pass.main) buffers[pass.target] = { tex: target.texture, isRT: true };
  }
  return true;
}
