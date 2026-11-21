/*
 * (hdr3) An HDR render's frames made into the file's own 10-bit Y'CbCr 4:2:0 on the render's GPU (hdrYuv.js: the arithmetic and the
 * WGSL), with luma adjustment, so the backend hands them to x265 as they are. Four compute passes over a frame of light (rgba half floats,
 * BT.709, 1 = SDR white; or the float composite's numbers, `hybrid`): R'G'B' and the luminance meant (with each workgroup's light for
 * MaxCLL / MaxFALL), the chroma, each pixel's Y' code, and the planes packed as ffmpeg's yuv420p10le. One read-back of the planes
 * (6.2 MB at 1080p, where the planar half floats were 12.4 MB) and of the light.
 *
 * Made only for an HDR MP4 render with the Scene's light (ProRes 4444 is 4:4:4 and keeps the planar half floats); dispose() gives back
 * every buffer.
 */

import { YUV_WGSL } from './hdrYuv.js';

/* global GPUBufferUsage, GPUMapMode, GPUTextureUsage, GPUShaderStage */

/**
 * `engine.renderer` must be WebGPU. `width` × `height`: the render's size (the planes are padded to even sides with black).
 * `transfer`: 'pq' | 'hlg'. Returns { encodeTexture(target, { hybrid }), encodeData(rgbaHalf, { hybrid }), dispose(), stats() }; each
 * encode answers { data: Uint8Array (the frame as yuv420p10le), width, height (padded), light: { max, mean } }.
 */
export function createHdrEncoder(engine, { width, height, transfer = 'pq' }) {
  const device = engine.renderer?.backend?.device;
  if (!device) return null;
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  const W = w + (w & 1), H = h + (h & 1), cw = W / 2, ch = H / 2;
  const samples = W * H + 2 * cw * ch;
  const words = Math.ceil(samples / 2);
  const gx = Math.ceil(W / 16), gy = Math.ceil(H / 16);
  const statsCount = gx * gy;
  const packGroups = Math.ceil(words / 256);
  const packX = Math.min(packGroups, 65535), packY = Math.ceil(packGroups / packX);

  const module = device.createShaderModule({ code: YUV_WGSL });
  const C = GPUShaderStage.COMPUTE;
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: C, buffer: { type: 'uniform' } },
      { binding: 1, visibility: C, texture: { sampleType: 'unfilterable-float' } },
      ...[2, 3, 4, 5, 6].map((binding) => ({ binding, visibility: C, buffer: { type: 'storage' } })),
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipe = (entryPoint) => device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
  const pipes = { prime: pipe('primeMain'), chroma: pipe('chromaMain'), luma: pipe('lumaMain'), pack: pipe('packMain') };

  const S = GPUBufferUsage.STORAGE;
  const buf = (size, usage) => device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage });
  const b = {
    params: buf(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
    prime: buf(W * H * 16, S),
    chroma: buf(cw * ch * 8, S),
    ycode: buf(W * H * 4, S),
    out: buf(words * 4, S | GPUBufferUsage.COPY_SRC),
    stats: buf(statsCount * 8, S | GPUBufferUsage.COPY_SRC),
    readOut: buf(words * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
    readStats: buf(statsCount * 8, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
  };
  const params = (hybrid) => new Uint32Array([w, h, W, H, cw, ch, transfer === 'hlg' ? 1 : 0, hybrid ? 1 : 0, words, 1, 0, 0]);
  let upload = null; // the GPUTexture a frame of light from the page goes into (encodeData)
  const groups = new Map(); // a bind group per source texture
  const ms = { encode: 0, n: 0 };
  let disposed = false;

  const groupFor = (texture) => {
    let g = groups.get(texture);
    if (!g) {
      g = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: b.params } },
          { binding: 1, resource: texture.createView() },
          { binding: 2, resource: { buffer: b.prime } },
          { binding: 3, resource: { buffer: b.chroma } },
          { binding: 4, resource: { buffer: b.ycode } },
          { binding: 5, resource: { buffer: b.out } },
          { binding: 6, resource: { buffer: b.stats } },
        ],
      });
      groups.set(texture, g);
    }
    return g;
  };

  async function run(texture, hybrid) {
    if (disposed) return null;
    const t0 = performance.now();
    device.queue.writeBuffer(b.params, 0, params(hybrid));
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setBindGroup(0, groupFor(texture));
    pass.setPipeline(pipes.prime); pass.dispatchWorkgroups(gx, gy);
    pass.setPipeline(pipes.chroma); pass.dispatchWorkgroups(Math.ceil(cw / 16), Math.ceil(ch / 16));
    pass.setPipeline(pipes.luma); pass.dispatchWorkgroups(gx, gy);
    pass.setPipeline(pipes.pack); pass.dispatchWorkgroups(packX, packY);
    pass.end();
    enc.copyBufferToBuffer(b.out, 0, b.readOut, 0, words * 4);
    enc.copyBufferToBuffer(b.stats, 0, b.readStats, 0, statsCount * 8);
    device.queue.submit([enc.finish()]);
    await Promise.all([b.readOut.mapAsync(GPUMapMode.READ, 0, words * 4), b.readStats.mapAsync(GPUMapMode.READ, 0, statsCount * 8)]);
    // the planes as the file takes them (samples * 2 bytes; the last word's upper half is padding when the count is odd)
    const data = new Uint8Array(samples * 2);
    data.set(new Uint8Array(b.readOut.getMappedRange(0, words * 4)).subarray(0, samples * 2));
    b.readOut.unmap();
    const st = new Float32Array(b.readStats.getMappedRange(0, statsCount * 8));
    let max = 0, sum = 0;
    for (let i = 0; i < st.length; i += 2) { if (st[i] > max) max = st[i]; sum += st[i + 1]; }
    b.readStats.unmap();
    ms.encode += performance.now() - t0;
    ms.n += 1;
    return { data, width: W, height: H, light: { max, mean: sum / (w * h) } };
  }

  return {
    width: W,
    height: H,
    /** A float render target (three) of the render's size, already drawn: its frame encoded. */
    encodeTexture(target, { hybrid = false } = {}) {
      const gpuTexture = engine.renderer.backend?.get?.(target.texture)?.texture;
      if (!gpuTexture) throw new Error('the HDR frame could not be encoded (no WebGPU texture)');
      if (target.width !== w || target.height !== h) throw new Error(`the HDR frame is ${target.width}x${target.height}, the render ${w}x${h}`);
      return run(gpuTexture, hybrid);
    },
    /** A frame of light from the page (rgba half floats, rows top first, the render's size) encoded. */
    encodeData(half, { hybrid = false } = {}) {
      if (!half || half.length !== w * h * 4) throw new Error('the HDR frame has the wrong size');
      if (!upload) {
        upload = device.createTexture({ size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      }
      device.queue.writeTexture({ texture: upload }, half, { bytesPerRow: w * 8 }, { width: w, height: h });
      return run(upload, hybrid);
    },
    /** ms a frame the encode took (dispatch, read-back, light). */
    stats: () => ({ encode: ms.n ? Math.round((ms.encode / ms.n) * 10) / 10 : 0 }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const x of Object.values(b)) x.destroy();
      upload?.destroy();
      groups.clear();
    },
  };
}
