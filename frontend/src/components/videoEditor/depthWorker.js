// Comlink worker that turns one still image into a depth map, off the main
// thread. Monocular depth estimation (Depth Anything V2 small) runs through
// Transformers.js on ONNX Runtime Web — WebGPU when the renderer exposes it,
// WASM+SIMD otherwise.
//
// Both the library and the model are fetched at first use rather than bundled
// or shipped in the installer (~60 MB, and Windows Defender has previously
// flagged large bundled binary payloads). They load through the backend's
// model cache (transformersRuntime.js → /api/model-cache): external CDN
// first, R2 mirror fallback, persisted in app data across reinstalls and
// revalidated upstream every ~90 days. The resulting depth map is stored in
// the project — the network is needed only the first time a user generates
// one, never at render time.

import * as Comlink from 'comlink';
import { loadTransformers } from './transformersRuntime';

const MODEL_ID = 'onnx-community/depth-anything-v2-small';

let depther = null;
let backend = null;

async function ensurePipeline(onProgress) {
  if (depther) return depther;
  const { pipeline } = await loadTransformers();

  const seen = {};
  const progressCallback = (p) => {
    if (p?.status !== 'progress' || !p.total) return;
    seen[p.file] = { loaded: p.loaded, total: p.total };
    let loaded = 0;
    let total = 0;
    for (const f of Object.values(seen)) { loaded += f.loaded; total += f.total; }
    if (total > 0) onProgress?.({ stage: 'model', pct: Math.round((loaded / total) * 100) });
  };

  try {
    if (!navigator.gpu) throw new Error('WebGPU unavailable');
    depther = await pipeline('depth-estimation', MODEL_ID, {
      device: 'webgpu', dtype: 'fp16', progress_callback: progressCallback,
    });
    backend = 'webgpu';
  } catch {
    // fp16 on WASM is not a supported combination — q8 is the quantised build
    // meant for it, and it is what keeps CPU inference to a few seconds.
    depther = await pipeline('depth-estimation', MODEL_ID, {
      device: 'wasm', dtype: 'q8', progress_callback: progressCallback,
    });
    backend = 'wasm';
  }
  return depther;
}

// Encode a single-channel depth field as a small greyscale PNG data URI. The map
// is downscaled to `maxEdge` first: the parallax field is low-frequency, and a
// full-resolution map would add hundreds of KB to every project autosave.
async function encodeDepthPng(depth, maxEdge) {
  const srcW = depth.width;
  const srcH = depth.height;
  const rgba = new Uint8ClampedArray(srcW * srcH * 4);
  for (let i = 0; i < srcW * srcH; i++) {
    const v = depth.data[i];
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  const full = new OffscreenCanvas(srcW, srcH);
  full.getContext('2d').putImageData(new ImageData(rgba, srcW, srcH), 0, 0);

  const k = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const outW = Math.max(1, Math.round(srcW * k));
  const outH = Math.max(1, Math.round(srcH * k));
  let canvas = full;
  if (k < 1) {
    canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(full, 0, 0, outW, outH);
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  return { w: outW, h: outH, data: `data:image/png;base64,${btoa(binary)}` };
}

function resampleFloatPlane(src, srcW, srcH, outW, outH) {
  if (srcW === outW && srcH === outH) return Float32Array.from(src);
  const dst = new Float32Array(outW * outH);
  for (let y = 0; y < outH; y += 1) {
    const sy = Math.min(srcH - 1, Math.max(0, ((y + 0.5) * srcH) / outH - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < outW; x += 1) {
      const sx = Math.min(srcW - 1, Math.max(0, ((x + 0.5) * srcW) / outW - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const fx = sx - x0;
      const a = Number(src[y0 * srcW + x0]) || 0;
      const b = Number(src[y0 * srcW + x1]) || 0;
      const c = Number(src[y1 * srcW + x0]) || 0;
      const d = Number(src[y1 * srcW + x1]) || 0;
      dst[y * outW + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return dst;
}

const api = {
  // onProgress must be a Comlink.proxy() from the caller.
  async generate(imageUrl, maxEdge, onProgress) {
    const notify = onProgress ? (p) => { onProgress(p); } : undefined;
    const pipe = await ensurePipeline(notify);
    notify?.({ stage: 'infer', pct: 0 });
    const started = Date.now();
    const out = await pipe(imageUrl);
    if (!out?.depth?.data) throw new Error('The depth model returned no depth map.');
    const map = await encodeDepthPng(out.depth, maxEdge || 384);
    notify?.({ stage: 'infer', pct: 100 });
    return { ...map, backend, ms: Date.now() - started };
  },

  /** Return unquantized depth float plane resized to maxEdge (even dims) using the cached ONNX pipeline. */
  async estimateRaw(imageUrl, maxEdge, onProgress) {
    const notify = onProgress ? (p) => { onProgress(p); } : undefined;
    const pipe = await ensurePipeline(notify);
    const out = await pipe(imageUrl);
    const rawTensor = out?.predicted_depth;
    let srcData = null;
    let srcW = 0;
    let srcH = 0;
    if (rawTensor?.data && Array.isArray(rawTensor.dims) && rawTensor.dims.length >= 2) {
      srcH = rawTensor.dims[rawTensor.dims.length - 2];
      srcW = rawTensor.dims[rawTensor.dims.length - 1];
      srcData = rawTensor.data;
    } else if (out?.depth?.data) {
      srcW = out.depth.width;
      srcH = out.depth.height;
      srcData = out.depth.data;
    } else {
      throw new Error('The depth model returned no depth data.');
    }
    const edge = maxEdge || 384;
    const k = Math.min(1, edge / Math.max(srcW, srcH));
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    const outW = even(srcW * k);
    const outH = even(srcH * k);
    const data = resampleFloatPlane(srcData, srcW, srcH, outW, outH);
    return Comlink.transfer({ w: outW, h: outH, data, backend }, [data.buffer]);
  },
};

Comlink.expose(api);
