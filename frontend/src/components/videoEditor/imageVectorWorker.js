// Comlink worker for raster → editable bezier outline.
//
// Everything runs here: decode, mask, trace, curve fit. No engine download and no
// network at all — the previous VTracer/WASM build had to fetch and cache a
// binary on first use, and still lost badly to this on the bench
// (html/image-vectorize.html). The image never leaves the device either way.

import * as Comlink from 'comlink';
import { traceRaster, TRACE_DEFAULTS, TRACE_DETAIL } from './rasterTracer';

const api = {
  async vectorize(imageUrl, maxEdge, options, onProgress) {
    const notify = onProgress ? (p) => onProgress(p) : undefined;
    notify?.({ stage: 'decode', pct: 5 });

    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error('Could not read the selected image.');
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const scale = Math.min(1, (maxEdge || 1024) / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      const rgba = ctx.getImageData(0, 0, width, height).data;

      const detail = TRACE_DETAIL[options?.detail] || TRACE_DETAIL.medium;
      const opts = { ...TRACE_DEFAULTS, ...detail, ...(options?.overrides || {}) };
      const PCT = { mask: 25, trace: 55, fit: 80 };
      const result = traceRaster(rgba, width, height, opts, (stage) => {
        notify?.({ stage, pct: PCT[stage] || 50 });
      });
      notify?.({ stage: 'fit', pct: 100 });
      return { ...result, sourceWidth: width, sourceHeight: height };
    } finally {
      bitmap.close();
    }
  },
};

Comlink.expose(api);
