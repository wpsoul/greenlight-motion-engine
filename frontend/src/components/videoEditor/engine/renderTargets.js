/*
 * The compositor's scratch render targets, allocated the first frame that needs them and resized to the drawing
 * buffer (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 11 — moved verbatim out of the Player,
 * `xRef.current` → `engine.x`). The first of the render loop's leaf moves: none of these reads a prop.
 *
 *   ensureAdjustmentTargets(engine, w, h)          adjustment-layer ping-pong (engine.adjustmentRT)
 *   ensureSequenceAdjTargets(engine, w, h)         the same inside a sequence (engine.sequenceAdjRT)
 *   ensureLayerFxTargets(engine, w, h, pyramid)    one layer's effect chain (engine.overlayFxRT)
 *   ensureDepthProbeTarget(engine, w, h)           depth re-draw of an isolated layer (engine.depthProbeRT)
 *   ensurePryzmSource(engine, w, h)                Pryzm's mipmapped source (engine.pryzmSrc)
 */
import * as THREE from 'three';

// ── Adjustment-layer compositing ──
// Lazily allocate/resize the ping-pong render targets to the drawing buffer.
export function ensureAdjustmentTargets(engine, w, h) {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  let rt = engine.adjustmentRT;
  if (!rt) {
    const make = (depth = false) => new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      // Only the ping-pong pair the stack accumulates into carries depth; the scratch
      // targets are single-pass blits that never test it.
      depthBuffer: depth,
      stencilBuffer: false,
    });
    rt = { a: make(true), b: make(true), c: make(), d: make(), e: make(), f: make() };
    engine.adjustmentRT = rt;
    return rt;
  }
  if (rt.a.width !== width || rt.a.height !== height) {
    rt.a.setSize(width, height);
    rt.b.setSize(width, height);
    rt.c.setSize(width, height);
    rt.d.setSize(width, height);
    rt.e.setSize(width, height);
    rt.f.setSize(width, height);
  }
  return rt;
}

export function ensureSequenceAdjTargets(engine, w, h) {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  let rt = engine.sequenceAdjRT;
  if (!rt) {
    const make = () => new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    rt = { a: make(), b: make(), c: make(), d: make(), e: make(), f: make() };
    engine.sequenceAdjRT = rt;
    return rt;
  }
  if (rt.a.width !== width || rt.a.height !== height) {
    rt.a.setSize(width, height);
    rt.b.setSize(width, height);
    rt.c.setSize(width, height);
    rt.d.setSize(width, height);
    rt.e.setSize(width, height);
    rt.f.setSize(width, height);
  }
  return rt;
}

// rt.a/rt.b ping-pong the chain, rt.c holds the isolate (also the matte and must survive the whole chain), rt.d the
// DOF result and rt.e/rt.f the glow. Allocated the first frame a chain actually runs, and the three pyramid targets
// only if the stack contains Aura Blur — six idle full-frame targets is ~50 MB at 1080p that most projects never need.
export function ensureLayerFxTargets(engine, w, h, needPyramid) {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  const make = () => new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  let rt = engine.overlayFxRT;
  if (!rt) {
    rt = { a: make(), b: make(), c: make(), d: null, e: null, f: null };
    engine.overlayFxRT = rt;
  }
  if (needPyramid && !rt.d) {
    rt.d = make(); rt.e = make(); rt.f = make();
  }
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const target = rt[key];
    if (target && (target.width !== width || target.height !== height)) target.setSize(width, height);
  }
  return rt;
}

// Colour is never read, but three needs a colour attachment to complete the framebuffer.
export function ensureDepthProbeTarget(engine, w, h) {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  let target = engine.depthProbeRT;
  if (!target) {
    target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    target.depthTexture = new THREE.DepthTexture(width, height);
    target.depthTexture.type = THREE.UnsignedIntType;
    target.depthTexture.minFilter = THREE.NearestFilter;
    target.depthTexture.magFilter = THREE.NearestFilter;
    engine.depthProbeRT = target;
    return target;
  }
  if (target.width !== width || target.height !== height) target.setSize(width, height);
  return target;
}

// Sized to the plate, not the box: the pass samples in FRAME uv (the layer is a sub-rect of a full-frame isolate),
// so the chain has to cover the frame.
export function ensurePryzmSource(engine, w, h) {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  let target = engine.pryzmSrc;
  if (target && (target.width !== width || target.height !== height)) {
    target.dispose();
    target = null;
  }
  if (!target) {
    target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: true,
    });
    // WebGLRenderTarget copies the option onto the texture, but the WebGPU
    // RenderTarget does not read it from there — set it on both so the chain
    // is actually built on either backend.
    target.texture.generateMipmaps = true;
    target.texture.minFilter = THREE.LinearMipmapLinearFilter;
    engine.pryzmSrc = target;
  }
  return target;
}
