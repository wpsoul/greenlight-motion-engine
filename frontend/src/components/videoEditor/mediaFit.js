// Media fit geometry shared by the clip shader's callers and analysis workers.
//
// Ordinary video/image media is CONTAIN-fit inside the layer quad: the whole
// source stays visible and the spare axis is letterboxed. Keeping these helpers
// dependency-free lets Web Workers and plain Node tests use exactly the same
// mapping as the renderer.

const num = (value, fallback = 0) => (
  Number.isFinite(Number(value)) ? Number(value) : fallback
);

/** The media's drawn content size inside a contain-fit layer quad. */
export function contentRectInQuad(quadW, quadH, mediaW, mediaH) {
  let w = Math.max(1e-6, num(quadW, 1));
  let h = Math.max(1e-6, num(quadH, 1));
  const mw = num(mediaW, 0);
  const mh = num(mediaH, 0);
  if (mw > 0 && mh > 0) {
    const mediaAR = mw / mh;
    const quadAR = w / h;
    // Match clipShader.js's tolerance so analysis and painted pixels take the
    // same branch for almost-equal aspect ratios.
    if (Math.abs(mediaAR - quadAR) > 0.01) {
      if (mediaAR > quadAR) h *= quadAR / mediaAR;
      else w *= mediaAR / quadAR;
    }
  }
  return { w, h };
}

/** Composition pixels occupied by one full unit of source-normalised X/Y. */
export function containedSourceScale(quadW, quadH, sourceAspect) {
  const aspect = num(sourceAspect, 0);
  if (!(aspect > 0)) {
    return {
      kx: Math.max(1e-6, num(quadW, 1)),
      ky: Math.max(1e-6, num(quadH, 1)),
    };
  }
  const content = contentRectInQuad(quadW, quadH, aspect, 1);
  return { kx: content.w, ky: content.h };
}

/** Layer-quad UV -> source-frame UV through the contain/letterbox mapping. */
export function layerUvToContainedSourceUv(u, v, quadW, quadH, sourceAspect) {
  const boxW = Math.max(1e-6, num(quadW, 1));
  const boxH = Math.max(1e-6, num(quadH, 1));
  const { kx, ky } = containedSourceScale(boxW, boxH, sourceAspect);
  return {
    x: 0.5 + (num(u, 0.5) - 0.5) * (boxW / kx),
    y: 0.5 + (num(v, 0.5) - 0.5) * (boxH / ky),
  };
}

/** A layer-quad UV rectangle expressed in source-frame UV. */
export function layerUvRectToContainedSourceRect(rect, quadW, quadH, sourceAspect) {
  if (!rect) return null;
  const u0 = Math.min(num(rect.u0, 0), num(rect.u1, 0));
  const u1 = Math.max(num(rect.u0, 0), num(rect.u1, 0));
  const v0 = Math.min(num(rect.v0, 0), num(rect.v1, 0));
  const v1 = Math.max(num(rect.v0, 0), num(rect.v1, 0));
  const a = layerUvToContainedSourceUv(u0, v0, quadW, quadH, sourceAspect);
  const b = layerUvToContainedSourceUv(u1, v1, quadW, quadH, sourceAspect);
  return {
    x: a.x,
    y: a.y,
    w: Math.max(0.004, b.x - a.x),
    h: Math.max(0.004, b.y - a.y),
  };
}
