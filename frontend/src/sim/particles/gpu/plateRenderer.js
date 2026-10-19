/*
 * The Tier 2 PLATE: a particle renderer that owns its own GPU device, its own
 * canvas, and nothing else. Phase 1 of
 * PLANS/VIDEO_EDITOR_PARTICLE_GPU_SCALE_PLAN.md.
 *
 * WHY ITS OWN DEVICE. The compositor's device is created in videoRenderer.js,
 * and that request is the one place a particle change could stop the whole
 * editor from starting: raise a limit it cannot meet and requestDevice()
 * rejects, taking the editor with it. Owning a second device makes every limit
 * and feature this engine wants free to ask for — a refusal degrades particles
 * and nothing else — and keeps videoRenderer.js untouched.
 *
 * The cost of that isolation is one canvas-to-texture hand-off per frame.
 * Phase 0 measured it at 0.6-0.7 ms on WebGPU and 0.2-0.3 ms on WebGL, FLAT in
 * particle count (it is a fixed-size image copy), against a 16.7 ms frame. See
 * tests/particles-gpu-scale/.
 *
 * WHAT THIS MODULE IS NOT. It does not simulate, it does not emit, and it does
 * not know what a particle system is. It takes a buffer of instances laid out
 * as drawWgsl.js documents and paints them. Keeping it that dumb is what lets
 * the A/B in tests/particles-gpu-scale/run_shader_ab.js drive it directly and
 * prove the pixels against the shipping GLSL.
 *
 * THE INSTANCE COUNT IS NEVER READ BACK. draw() takes an indirect argument
 * buffer whose instanceCount lane the derive pass filled with an atomic. The
 * CPU submits a draw for a number of particles it does not know — which is what
 * removes the per-frame readback that capped the old engine at ~20k.
 *
 * A leaf module: no three, no React, no DOM beyond a canvas.
 */

import { DRAW_WGSL, DRAW_U_FLOATS, DRAW_U_BYTES, INST_FLOATS, INST_BYTES } from './drawWgsl.js';

export { INST_FLOATS, INST_BYTES, DRAW_U_FLOATS };

/** Uniform slot offsets, in floats, into the block drawWgsl.js declares. */
export const U_MV = 0, U_PROJ = 16, U_SCALARS = 32, U_IGNITE_COLOR = 48;
/** Scalar lane order at U_SCALARS — the same order the WGSL struct declares. */
export const SCALAR_KEYS = [
  'sizeStart', 'sizeEnd', 'stretch', 'scale',
  'twinkle', 'aspect', 'opacity', 'sprite',
  'useMap', 'tint', 'colorFromSource', 'colorFromSpeed',
  'igniteMode',
];

let devicePromise = null;

/**
 * The engine's private device. Cached across runtimes — several particle layers
 * share one device and one set of pipelines, the way gpuEngine.js already
 * shares its own.
 *
 * The limits below are requested but NOT required: every one is clamped to what
 * the adapter offers, and the fallback path asks for none at all. A machine that
 * cannot grant them still gets particles, just a smaller ceiling — which is the
 * whole point of not sharing the compositor's device.
 */
export function plateDevice() {
  if (devicePromise) return devicePromise;
  devicePromise = (async () => {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const want = (name, ceiling) => Math.min(adapter.limits[name] ?? 0, ceiling);
    let device = null;
    try {
      device = await adapter.requestDevice({
        requiredLimits: {
          maxStorageBufferBindingSize: want('maxStorageBufferBindingSize', 1 << 30),
          maxBufferSize: want('maxBufferSize', 1 << 30),
        },
      });
    } catch {
      // Limits refused: take the defaults. The pool chunks to fit them.
      device = await adapter.requestDevice().catch(() => null);
    }
    if (device) {
      device.lost.then(() => { devicePromise = null; PIPES.delete(device); });
      device.__adapterLimits = adapter.limits;
    }
    return device;
  })().catch(() => null);
  return devicePromise;
}

/** Drop the cached device — for tests, and after a deliberate teardown. */
export function resetPlateDevice() { devicePromise = null; }

const PIPES = new WeakMap();

/**
 * Both blend modes, compiled once per device. Alpha is premultiplied `over`
 * (src ONE, dst ONE_MINUS_SRC_ALPHA) and additive is (ONE, ONE) — transcribed
 * from the ShaderMaterial in particleLayer.js, which is the readable statement
 * of that state and must stay the only one.
 */
async function pipelinesFor(device, format) {
  const cached = PIPES.get(device);
  if (cached && cached.format === format) return cached;

  const module = device.createShaderModule({ code: DRAW_WGSL });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) {
    throw new Error('particle draw WGSL: ' + errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join(' | '));
  }

  const bgl = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ] });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  const make = (dstFactor) => device.createRenderPipeline({
    layout,
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format, blend: {
      color: { srcFactor: 'one', dstFactor },
      alpha: { srcFactor: 'one', dstFactor },
    } }] },
    // A four-vertex strip per instance — see drawWgsl.js's corner() for why.
    // DoubleSide in the original: a billboard has no back face, and a winding
    // flip from the stretch basis must never make a particle invisible.
    primitive: { topology: 'triangle-strip', cullMode: 'none' },
  });

  const pipes = { format, bgl, alpha: make('one-minus-src-alpha'), additive: make('one') };
  PIPES.set(device, pipes);
  return pipes;
}

const RAMP_W = 256;

/**
 * One plate. `width`/`height` are the layer's render size; the canvas is the
 * texture the compositor will sample.
 */
export async function createPlateRenderer({ device, width, height, canvas = null }) {
  const d = device || await plateDevice();
  if (!d) return null;

  const cv = canvas || (typeof document !== 'undefined'
    ? document.createElement('canvas')
    : new OffscreenCanvas(Math.max(1, width), Math.max(1, height)));
  cv.width = Math.max(1, Math.round(width));
  cv.height = Math.max(1, Math.round(height));

  const ctx = cv.getContext('webgpu');
  if (!ctx) return null;
  // rgba8unorm rather than the preferred canvas format: the compositor samples
  // this as a plain texture, and bgra8unorm would swap the channels on the way
  // in on some platforms. Premultiplied to match the shader's own output and
  // every other layer plate in the editor.
  const format = 'rgba8unorm';
  ctx.configure({ device: d, format, alphaMode: 'premultiplied' });

  const pipes = await pipelinesFor(d, format);

  const uArray = new Float32Array(DRAW_U_FLOATS);
  const uBuffer = d.createBuffer({ size: DRAW_U_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  const mkTex = (w, h) => d.createTexture({
    size: [w, h], format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  // Ramps are 256x1 LUTs; the artwork starts as a 1x1 transparent stand-in so a
  // bind group is always complete — a null texture is not a thing WebGPU allows,
  // and the useMap uniform is what actually decides whether it is read.
  let rampTex = mkTex(RAMP_W, 1);
  let ramp2Tex = mkTex(RAMP_W, 1);
  let artTex = mkTex(1, 1);
  d.queue.writeTexture({ texture: artTex }, new Uint8Array(4), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1]);

  const sampler = d.createSampler({
    magFilter: 'linear', minFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
  });

  let bindGroup = null;
  let boundInst = null;

  /*
   * ONE BIND GROUP PER INSTANCE BUFFER, CACHED.
   *
   * A chunked pool draws once per slab, each from its own instance buffer, and
   * rebuilding the bind group between them would allocate one per slab per
   * frame. They are immutable and there are at most a handful, so they are kept.
   */
  const bindCache = new Map();
  const bindFor = (instBuffer) => {
    let g = bindCache.get(instBuffer);
    if (!g) { rebind(instBuffer); g = bindGroup; bindCache.set(instBuffer, g); }
    return g;
  };

  const rebind = (instBuffer) => {
    bindGroup = d.createBindGroup({ layout: pipes.bgl, entries: [
      { binding: 0, resource: { buffer: uBuffer } },
      { binding: 1, resource: { buffer: instBuffer } },
      { binding: 2, resource: rampTex.createView() },
      { binding: 3, resource: ramp2Tex.createView() },
      { binding: 4, resource: artTex.createView() },
      { binding: 5, resource: sampler },
    ] });
    boundInst = instBuffer;
  };

  const api = {
    canvas: cv,
    device: d,
    format,

    resize(w, h) {
      const nw = Math.max(1, Math.round(w));
      const nh = Math.max(1, Math.round(h));
      if (cv.width === nw && cv.height === nh) return false;
      cv.width = nw; cv.height = nh;
      ctx.configure({ device: d, format, alphaMode: 'premultiplied' });
      return true;
    },

    /** `px` is 256*4 bytes of RGBA — the same LUT the GLSL path uploads. */
    setRamp(which, px) {
      const tex = which === 2 ? ramp2Tex : rampTex;
      d.queue.writeTexture({ texture: tex }, px, { bytesPerRow: RAMP_W * 4, rowsPerImage: 1 }, [RAMP_W, 1]);
    },

    /** The layer artwork, or null to release it. Rebuilds the bind group. */
    setArt(px, w, h) {
      artTex.destroy();
      if (!px) {
        artTex = mkTex(1, 1);
        d.queue.writeTexture({ texture: artTex }, new Uint8Array(4), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1]);
      } else {
        artTex = mkTex(w, h);
        d.queue.writeTexture({ texture: artTex }, px, { bytesPerRow: w * 4, rowsPerImage: h }, [w, h]);
      }
      bindGroup = null;
    },

    /**
     * Paint one frame. `mv` and `proj` are column-major mat4 elements — three's
     * `.elements` order, passed through unchanged. `scalars` is keyed by
     * SCALAR_KEYS; anything missing keeps its previous value.
     */
    /**
     * `slabs` is [{ inst, args }] — one entry for an unchunked pool, several
     * when the pool had to be split to fit the adapter's binding limit. They are
     * drawn in ONE render pass: the pass clears once and every slab adds to it,
     * which is both correct for additive blending and a great deal cheaper than
     * a pass each. `instBuffer`/`indirectBuffer` remain as the single-slab form
     * the tests use.
     */
    draw({ instBuffer, count, indirectBuffer, slabs, mv, proj, scalars, igniteColor, blend = 'alpha' }) {
      const list = slabs && slabs.length ? slabs : (instBuffer ? [{ inst: instBuffer, args: indirectBuffer }] : []);
      // `indirectBuffer` is the preferred path: the derive pass wrote the
      // instance count into its lane 1 and the CPU never learned it. `count` is
      // the explicit fallback, used by the tests and by any caller that already
      // knows the number.
      if (!list.length || (!list[0].args && count <= 0)) {
        // Still clear: a layer that emptied must not keep showing its last frame.
        const enc0 = d.createCommandEncoder();
        const p0 = enc0.beginRenderPass({ colorAttachments: [{
          view: ctx.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] });
        p0.end();
        d.queue.submit([enc0.finish()]);
        return 0;
      }
      if (mv) uArray.set(mv, U_MV);
      if (proj) uArray.set(proj, U_PROJ);
      if (scalars) {
        for (let i = 0; i < SCALAR_KEYS.length; i++) {
          const v = scalars[SCALAR_KEYS[i]];
          if (v !== undefined) uArray[U_SCALARS + i] = v;
        }
      }
      if (igniteColor) uArray.set(igniteColor, U_IGNITE_COLOR);
      d.queue.writeBuffer(uBuffer, 0, uArray);

      const enc = d.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [{
        view: ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(blend === 'additive' ? pipes.additive : pipes.alpha);
      for (const sl of list) {
        pass.setBindGroup(0, bindFor(sl.inst));
        if (sl.args) pass.drawIndirect(sl.args, 0);
        else pass.draw(4, count);
      }
      pass.end();
      d.queue.submit([enc.finish()]);
      return count || -1;
    },

    /** Resolves when the GPU has finished the frames submitted so far. Export
     *  awaits this; the preview does not, and is one frame stale as a result. */
    settle() { return d.queue.onSubmittedWorkDone(); },

    destroy() {
      rampTex.destroy(); ramp2Tex.destroy(); artTex.destroy();
      uBuffer.destroy();
      bindGroup = null;
      bindCache.clear();
    },
  };
  return api;
}
