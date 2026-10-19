/*
 * Layer outlines for the path effects (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 19 — moved verbatim out of
 * Player.jsx: the module-level helpers with tests/engine-extraction/tools/move_module_decls.py, the callback with
 * convert_leaf.py). Neon Glow / Lines Draw run along a layer's OUTLINE: a shape's own path, a text/motion canvas's or a
 * picture's traced alpha, an SVG silhouette, or what a Layer Mask leaves visible — baked into a float LUT texture the
 * chain binds to uLUT, cached by content.
 *
 *   resolveLayerPathFx(engine, item, clip, kf, layerMesh)   this layer's path data for the chain, or null
 * Also exported for the Player's own shape plates: getShapeTextureLayout, getShapeSvgImage, MAX_SHAPE_TEXTURE_DIM.
 */
import * as THREE from 'three';
import { getAdjustmentEffect } from '../adjustmentEffects';
import { hashAlphaSource, sampleAlphaOutline } from '../alphaOutline';
import { getItemCornerRadii, getItemShadows } from '../clipShader';
import { SHAPE_PATH_KF_KEY, isStrokeShape, resolveLineSettings, sampleShapePathPolyline, shapeBoxSize, shapeCornerRadii, shapePathBounds, strokeReach as lineStrokeReach, unitOutlineFromShape, withShapeSizeKeyframes } from '../shapePath';
import { PATH_FX_SAMPLES, djb2, mediaContentFrac } from './canvasHelpers';
import { maskVisibleShape as maskVisibleShapeInEngine } from './layerMasks';

export const MAX_SHAPE_TEXTURE_DIM = 4096;

// Decoded custom-SVG images for shape layers, keyed by their (data-)URL. Loaded
// lazily in the live preview (frames drawn before decode finishes just skip the
// shape and the RAF loop picks it up once ready). Stills and exports can't skip:
// they preload every project SVG and wait on `awaitShapeSvgImages()` so a layer
// that starts mid-timeline is drawn on its first frame instead of ~1s late.
export const shapeSvgImageCache = new Map(); // url -> { img, ready, failed, promise }

export function getShapeSvgImage(url) {
  let entry = shapeSvgImageCache.get(url);
  if (!entry) {
    const img = new Image();
    entry = { img, ready: false, failed: false, promise: null };
    entry.promise = new Promise((resolve) => {
      img.onload = () => {
        const done = () => { entry.ready = true; resolve(entry); };
        if (typeof img.decode === 'function') img.decode().then(done, done);
        else done();
      };
      // A broken URI must not hang a still/export waiting on it.
      img.onerror = () => { entry.failed = true; resolve(entry); };
    });
    img.src = url;
    shapeSvgImageCache.set(url, entry);
  }
  return entry;
}

// `density` is the adaptive raster density (rasterDensity.js): >1 when the camera
// magnifies this layer, so the plate is drawn at the resolution it actually occupies
// on screen instead of being stretched from composition scale. `maxRasterDim` is the
// hardware per-axis cap; it defaults to MAX_SHAPE_TEXTURE_DIM so callers that only
// want the LOGICAL layout (the path-FX cache / gizmo at the second call site) are
// byte-for-byte unchanged.
//
// plateWidth/plateHeight are LOGICAL and must stay that way — the plane's world size
// and the fx cache key both read them. Only rasterWidth/rasterHeight carry density.
export function getShapeTextureLayout(item, compositionWidth, compositionHeight, {
  pathPoints = null,
  line = null,
  density = 1,
  maxRasterDim = MAX_SHAPE_TEXTURE_DIM,
} = {}) {
  const { width, height } = shapeBoxSize(item, compositionWidth, compositionHeight);
  const points = (item.shapeType === 'path' || item.shapeType === 'line') ? pathPoints : null;
  // Same rule the drawer uses — a Line is never closed, whatever the path says.
  const closed = item.shapeType !== 'line' && item.shapePath?.closed !== false;
  // Whatever is stroked hangs outside the outline. For a stroked shape that's
  // half the line width (which may be keyframed, hence `line`) PLUS whatever its
  // cap and join push past the curve; otherwise it's the card border, which is
  // always joined round and so never reaches past half its width.
  const strokeReach = isStrokeShape(item)
    ? lineStrokeReach(line || resolveLineSettings(item), points, closed, width, height)
    : (item.borderStyle === 'none' ? 0 : Math.max(0, Number(item.borderWidth) || 0) / 2);
  let padX = Math.ceil(strokeReach + 2);
  let padY = Math.ceil(strokeReach + 2);
  // A hand-edited path may reach outside its own box. Pad SYMMETRICALLY by the
  // worst overflow: the draw and the mesh both assume the shape is centred on the
  // plate, and the transform gizmo assumes the same of the layer.
  if (points && points.length >= 2) {
    const bounds = shapePathBounds(points, closed);
    if (bounds) {
      const overX = Math.max(0, -0.5 - bounds.minX, bounds.maxX - 0.5) * width;
      const overY = Math.max(0, -0.5 - bounds.minY, bounds.maxY - 0.5) * height;
      padX = Math.max(padX, Math.ceil(overX + strokeReach + 2));
      padY = Math.max(padY, Math.ceil(overY + strokeReach + 2));
    }
  }
  for (const shadow of getItemShadows(item)) {
    if (!shadow || shadow.inset) continue;
    const blurReach = Math.max(0, Number(shadow.blur) || 0) * 2;
    const spread = Math.max(0, Number(shadow.spread) || 0);
    padX = Math.max(padX, Math.ceil(Math.abs(Number(shadow.x) || 0) + blurReach + spread + 2));
    padY = Math.max(padY, Math.ceil(Math.abs(Number(shadow.y) || 0) + blurReach + spread + 2));
  }
  const plateWidth = Math.max(1, width + padX * 2);
  const plateHeight = Math.max(1, height + padY * 2);
  const maxPlate = Math.max(plateWidth, plateHeight);
  // Legacy guard, unchanged: an oversized plate is rasterized BELOW 1x so it still
  // fits a texture. Adaptive density then rides on top, and the hardware cap clamps
  // the product — so density can never talk the plate past what the GPU can hold.
  const fitScale = Math.min(1, MAX_SHAPE_TEXTURE_DIM / maxPlate);
  const wantDensity = Number.isFinite(density) && density > 0 ? density : 1;
  const rasterScale = Math.min(fitScale * wantDensity, Math.max(1, maxRasterDim) / maxPlate);
  return {
    shapeWidth: width,
    shapeHeight: height,
    pathPoints: points || null,
    line,
    plateWidth,
    plateHeight,
    rasterScale,
    rasterWidth: Math.max(1, Math.round(plateWidth * rasterScale)),
    rasterHeight: Math.max(1, Math.round(plateHeight * rasterScale)),
  };
}

// ── Neon Path Glow geometry (def.usesPath) ──────────────────────────────────
// The shape's outline baked GPU-readable: PATH_FX_SAMPLES positions at equal arc
// length in PLATE uv (0..1 across the padded plate, y up to match fxLocal), as a
// float N×1 DataTexture the chain binds to uLUT. Keyed by geometry content, so a
// static shape bakes once; a morphing shapePath keyframe re-bakes only while the
// interpolated points actually change, and the LRU keeps the churn bounded.
export const pathFxTexCache = new Map();

let _pathFxSeq = 0;

export function pathFxCacheKey(points, closed, rx, ry) {
  let s = `${closed ? 'c' : 'o'}:${rx.toFixed(5)}:${ry.toFixed(5)}`;
  for (const p of points) {
    s += `|${p.x},${p.y}`;
    if (p.hIn) s += `,${p.hIn.x},${p.hIn.y}`;
    if (p.hOut) s += `,${p.hOut.x},${p.hOut.y}`;
  }
  return s;
}

// Custom-SVG outlines: the SVG's longest geometry element sampled at equal arc
// length by the browser's own getPointAtLength, with group transforms applied
// through getCTM. Sampled once per URL into viewBox-fraction space (0..1); the
// aspect-fit mapping into the shape box happens where the texture is baked.
// Loading is async (fetch + a brief off-screen live tree), so frames before the
// sample set is ready just bypass the effect — same contract as the SVG image.
export const shapeSvgOutlineCache = new Map(); // url -> { status, frac, closed }

export function sampleSvgOutlineFractions(text, n) {
  let doc = null;
  try { doc = new DOMParser().parseFromString(text, 'image/svg+xml'); } catch { return null; }
  const svg = doc?.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== 'svg') return null;
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;';
  const live = document.importNode(svg, true);
  // Force viewport == viewBox so getCTM maps user space straight into viewBox px
  // (display:none would void the CTM, hence the off-screen visibility trick).
  let vw = 0;
  let vh = 0;
  let minX = 0;
  let minY = 0;
  const vb = live.viewBox && live.viewBox.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) {
    vw = vb.width; vh = vb.height; minX = vb.x; minY = vb.y;
  } else {
    vw = parseFloat(live.getAttribute('width')) || 100;
    vh = parseFloat(live.getAttribute('height')) || 100;
    live.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
  }
  live.setAttribute('width', String(vw));
  live.setAttribute('height', String(vh));
  holder.appendChild(live);
  document.body.appendChild(holder);
  try {
    let best = null;
    let bestLen = 0;
    for (const el of live.querySelectorAll('path, polygon, polyline, rect, circle, ellipse, line')) {
      let len = 0;
      try { len = typeof el.getTotalLength === 'function' ? el.getTotalLength() : 0; } catch { len = 0; }
      if (Number.isFinite(len) && len > bestLen) { best = el; bestLen = len; }
    }
    if (!best || !(bestLen > 0)) return null;
    let m = null;
    try { m = best.getCTM(); } catch { m = null; }
    const tag = best.nodeName.toLowerCase();
    let closed = tag === 'rect' || tag === 'circle' || tag === 'ellipse' || tag === 'polygon';
    if (tag === 'path') closed = /[zZ]\s*$/.test((best.getAttribute('d') || '').trim());
    const frac = new Float32Array(n * 2);
    const denom = closed ? n : n - 1;
    let first = null;
    let last = null;
    for (let i = 0; i < n; i += 1) {
      let p = null;
      try { p = best.getPointAtLength((bestLen * i) / denom); } catch { return null; }
      const x = m ? m.a * p.x + m.c * p.y + m.e : p.x - minX;
      const y = m ? m.b * p.x + m.d * p.y + m.f : p.y - minY;
      frac[i * 2] = x / vw;
      frac[i * 2 + 1] = y / vh;
      if (i === 0) first = { x, y };
      last = { x, y };
    }
    // A path without a trailing Z can still visually close on itself.
    if (!closed && first && last) {
      if (Math.hypot(first.x - last.x, first.y - last.y) < Math.max(vw, vh) * 0.005) closed = true;
    }
    return { frac, closed };
  } finally {
    holder.remove();
  }
}

export function getShapeSvgOutline(url) {
  if (!url || typeof url !== 'string') return null;
  let entry = shapeSvgOutlineCache.get(url);
  if (!entry) {
    entry = { status: 'loading', frac: null, closed: true };
    shapeSvgOutlineCache.set(url, entry);
    (async () => {
      try {
        const text = await (await fetch(url)).text();
        const res = sampleSvgOutlineFractions(text, PATH_FX_SAMPLES);
        if (res) { entry.frac = res.frac; entry.closed = res.closed; entry.status = 'ready'; }
        else entry.status = 'failed';
      } catch { entry.status = 'failed'; }
    })();
    if (shapeSvgOutlineCache.size > 24) {
      const first = shapeSvgOutlineCache.keys().next().value;
      if (first !== url) shapeSvgOutlineCache.delete(first);
    }
  }
  return entry.status === 'ready' ? entry : null;
}

// Neon Glow "Relax Points" (bake-side param): iterative 1-2-1 low-pass over the
// baked LUT samples, run per contour (the z channel flags contour starts) so
// smoothing never drags one glyph toward its neighbour through a bridge
// segment. Traced contours are closed loops and wrap; an open shape path keeps
// its end points pinned. Mutates `data` in place before the texture upload.
export function relaxPathLutSamples(data, n, relax, closed) {
  // Fixed pass count with slider-scaled strength: continuous response across the
  // whole range, and 100% (8 full 1-2-1 passes) rounds a traced glyph without
  // collapsing its loop — more passes melt letters into droplets.
  const strength = Math.max(0, Math.min(100, Number(relax) || 0)) / 100;
  if (strength <= 0) return;
  const iters = 8;
  const lam = 0.5 * strength;
  const starts = [];
  for (let i = 0; i < n; i += 1) if (data[i * 4 + 2] > 0.5) starts.push(i);
  if (starts.length === 0) starts.push(0);
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  for (let k = 0; k < starts.length; k += 1) {
    const s0 = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : n;
    const m = e - s0;
    if (m < 4) continue;
    // Multi-contour runs come from the alpha tracer, whose contours are each a
    // closed loop regardless of the run-level flag.
    const wrap = closed || starts.length > 1;
    for (let it = 0; it < iters; it += 1) {
      for (let i = 0; i < m; i += 1) { px[i] = data[(s0 + i) * 4]; py[i] = data[(s0 + i) * 4 + 1]; }
      for (let i = 0; i < m; i += 1) {
        if (!wrap && (i === 0 || i === m - 1)) continue;
        const a = (i - 1 + m) % m;
        const b = (i + 1) % m;
        data[(s0 + i) * 4] = px[i] + lam * ((px[a] + px[b]) / 2 - px[i]);
        data[(s0 + i) * 4 + 1] = py[i] + lam * ((py[a] + py[b]) / 2 - py[i]);
      }
    }
  }
}

// The chain's LUT is baked once per layer, so Relax Points reads as the max
// across the enabled path effects that carry it.
export function pathFxRelaxAmount(item) {
  let relax = 0;
  const list = Array.isArray(item?.effects) ? item.effects : [];
  for (const eff of list) {
    if (!eff || eff.enabled === false) continue;
    if (!getAdjustmentEffect(eff.id)?.usesPath) continue;
    const v = Number(eff.params?.pathRelax);
    if (Number.isFinite(v)) relax = Math.max(relax, v);
  }
  return Math.max(0, Math.min(100, relax));
}

export function getShapePathFxData(rawItem, kf, compW, compH, relax = 0) {
  if (!rawItem) return null;
  // the outline follows a keyframed size exactly like the drawn plate does
  const item = withShapeSizeKeyframes(rawItem, kf);
  const type = item.shapeType || 'rectangle';
  const isPathShape = type === 'path' || type === 'line';
  const isSvgShape = type === 'custom' || type === 'vector';
  let points = null;
  let closed = true;
  let svgOutline = null;
  let svgFit = null;
  if (isSvgShape) {
    // The outline comes from the SVG source itself; the mapping mirrors the
    // draw's aspect-fit (contain) of the decoded image into the shape box.
    svgOutline = getShapeSvgOutline(item.shapeSvgUrl);
    const imgEntry = item.shapeSvgUrl ? getShapeSvgImage(item.shapeSvgUrl) : null;
    if (!svgOutline || !imgEntry?.ready) return null;
    closed = svgOutline.closed;
    const dims = shapeBoxSize(item, compW, compH);
    const iw = imgEntry.img.naturalWidth || imgEntry.img.width || 1;
    const ih = imgEntry.img.naturalHeight || imgEntry.img.height || 1;
    const k = Math.min(dims.width / iw, dims.height / ih);
    svgFit = { dw: Math.max(1, iw * k), dh: Math.max(1, ih * k) };
  } else if (isPathShape) {
    // Same precedence as the draw: a keyframed `shapePath` morph wins over the
    // item's static points for this frame.
    points = item.shapePath?.points || null;
    const morphed = kf ? kf[SHAPE_PATH_KF_KEY] : null;
    if (Array.isArray(morphed) && morphed.length >= 2) points = morphed;
    closed = type !== 'line' && item.shapePath?.closed !== false;
  } else {
    const dims = shapeBoxSize(item, compW, compH);
    points = unitOutlineFromShape(item, {
      width: dims.width,
      height: dims.height,
      radii: shapeCornerRadii(item, dims.width, dims.height),
    });
  }
  if (!isSvgShape && (!Array.isArray(points) || points.length < 2)) return null;
  // The same layout the raster used this frame, so the unit→plate mapping agrees
  // with the drawn pixels (stroke padding, path overflow, shadow reach).
  const layout = getShapeTextureLayout(item, compW, compH, {
    pathPoints: isPathShape ? points : null,
    line: isStrokeShape(item) ? resolveLineSettings(item, kf) : null,
  });
  const rx = layout.shapeWidth / layout.plateWidth;
  const ry = layout.shapeHeight / layout.plateHeight;
  // For SVG shapes the drawn box is the aspect-fit rect, not the full shape box.
  const fw = svgFit ? svgFit.dw / layout.plateWidth : rx;
  const fh = svgFit ? svgFit.dh / layout.plateHeight : ry;
  const baseKey = isSvgShape
    ? `svg:${djb2(item.shapeSvgUrl)}:${closed ? 'c' : 'o'}:${fw.toFixed(5)}:${fh.toFixed(5)}`
    : pathFxCacheKey(points, closed, rx, ry);
  // Relax 0 keeps the exact pre-feature key, so untouched projects rebake nothing.
  const key = relax > 0 ? `${baseKey}:rx${Math.round(relax)}` : baseKey;
  let entry = pathFxTexCache.get(key);
  if (!entry) {
    const data = new Float32Array(PATH_FX_SAMPLES * 4);
    if (isSvgShape) {
      const frac = svgOutline.frac;
      for (let i = 0; i < PATH_FX_SAMPLES; i += 1) {
        // viewBox fraction (y down) → plate uv (y up, fxLocal space). One
        // contour, so z (contour start) and w (its first index) both stay 0.
        data[i * 4] = 0.5 + (frac[i * 2] - 0.5) * fw;
        data[i * 4 + 1] = 0.5 - (frac[i * 2 + 1] - 0.5) * fh;
      }
    } else {
      const samples = sampleShapePathPolyline(points, closed, PATH_FX_SAMPLES);
      if (!samples) return null;
      for (let i = 0; i < PATH_FX_SAMPLES; i += 1) {
        // Unit box (y down, canvas convention) → plate uv (y up, fxLocal space).
        data[i * 4] = 0.5 + samples[i * 2] * rx;
        data[i * 4 + 1] = 0.5 - samples[i * 2 + 1] * ry;
      }
    }
    relaxPathLutSamples(data, PATH_FX_SAMPLES, relax, closed);
    const texture = new THREE.DataTexture(data, PATH_FX_SAMPLES, 1, THREE.RGBAFormat, THREE.FloatType);
    // NEAREST on purpose: float-linear filtering is an optional GL extension,
    // so the shader lerps adjacent samples by hand instead.
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    entry = { texture };
    pathFxTexCache.set(key, entry);
    if (pathFxTexCache.size > 12) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [k, v] of pathFxTexCache) {
        if (k === key) continue;
        if ((v.lastUsed ?? 0) < oldest) { oldest = v.lastUsed ?? 0; oldestKey = k; }
      }
      if (oldestKey) {
        try { pathFxTexCache.get(oldestKey).texture.dispose(); } catch { /* no-op */ }
        pathFxTexCache.delete(oldestKey);
      }
    }
  }
  entry.lastUsed = ++_pathFxSeq;
  return {
    texture: entry.texture,
    count: PATH_FX_SAMPLES,
    closed,
    plateWidth: layout.plateWidth,
    plateHeight: layout.plateHeight,
  };
}

// ── Non-shape outline sources (Neon Glow on text / media layers) ────────────
// Text and motion layers trace the alpha of their OWN canvas (the same one the
// mesh textures from, so the trace matches the drawn pixels exactly); images
// trace their decoded file's alpha; video and anything else falls back to the
// media content rect. Traced coordinates are source-space fractions; the fit
// mapping into the quad happens where the texture is baked.

// Decoded-image outlines, keyed by url. Loaded lazily like the SVG outlines;
// frames before decode finishes just bypass the effect.
export const imageOutlineCache = new Map(); // url -> { status, res }

export function getImageAlphaOutline(url) {
  if (!url || typeof url !== 'string') return null;
  let entry = imageOutlineCache.get(url);
  if (!entry) {
    entry = { status: 'loading', res: null };
    imageOutlineCache.set(url, entry);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try { entry.res = sampleAlphaOutline(img, PATH_FX_SAMPLES); entry.status = 'ready'; }
      catch { entry.status = 'failed'; }
    };
    img.onerror = () => { entry.status = 'failed'; };
    img.src = url;
    if (imageOutlineCache.size > 24) {
      const first = imageOutlineCache.keys().next().value;
      if (first !== url) imageOutlineCache.delete(first);
    }
  }
  // 'failed' reports as an opaque-rect fallback rather than a dead effect.
  if (entry.status === 'failed') return { frac: null, closed: true, hasAlpha: false };
  return entry.status === 'ready' ? entry.res : null;
}

// Canvas-backed outlines (text / motion templates), keyed by item id and
// invalidated by a cheap content hash — animated text re-traces only on frames
// where its raster actually changed.
export const canvasOutlineCache = new Map(); // itemId -> { hash, res }

export function getCanvasAlphaOutline(itemId, canvas) {
  const hash = hashAlphaSource(canvas);
  if (!hash) return null;
  let entry = canvasOutlineCache.get(itemId);
  if (!entry || entry.hash !== hash) {
    entry = { hash, res: sampleAlphaOutline(canvas, PATH_FX_SAMPLES) };
    canvasOutlineCache.set(itemId, entry);
    if (canvasOutlineCache.size > 24) {
      const first = canvasOutlineCache.keys().next().value;
      if (first !== itemId) canvasOutlineCache.delete(first);
    }
  }
  return entry.res ? { ...entry.res, hash } : null;
}

// The media content rect (fit-contain letterbox area) as a rounded-rect
// outline, sampled at equal arc length straight in quad uv (y down).
export function sampleRoundedRectQuad(cw, ch, radiusPx, plateW, plateH, n) {
  const wPx = Math.max(1, cw * plateW);
  const hPx = Math.max(1, ch * plateH);
  const r = Math.max(0, Math.min(radiusPx, Math.min(wPx, hPx) / 2));
  // Dense clockwise polyline in local px (origin = content rect top-left).
  const pts = [];
  const arc = (cx, cy, a0, a1) => {
    for (let i = 1; i <= 8; i += 1) {
      const a = a0 + ((a1 - a0) * i) / 8;
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  };
  pts.push(r, 0, wPx - r, 0);
  if (r > 0) arc(wPx - r, r, -Math.PI / 2, 0);
  pts.push(wPx, hPx - r);
  if (r > 0) arc(wPx - r, hPx - r, 0, Math.PI / 2);
  pts.push(r, hPx);
  if (r > 0) arc(r, hPx - r, Math.PI / 2, Math.PI);
  pts.push(0, r);
  if (r > 0) arc(r, r, Math.PI, Math.PI * 1.5);
  // Equal-arc resample of the closed polyline.
  const m = pts.length / 2;
  let total = 0;
  const segLen = new Array(m);
  for (let i = 0; i < m; i += 1) {
    const j = (i + 1) % m;
    segLen[i] = Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);
    total += segLen[i];
  }
  const out = new Float32Array(n * 2);
  const x0 = 0.5 - cw / 2;
  const y0 = 0.5 - ch / 2;
  let seg = 0;
  let acc = 0;
  for (let s = 0; s < n; s += 1) {
    const target = (total * s) / n;
    while (seg < m - 1 && acc + segLen[seg] < target) { acc += segLen[seg]; seg += 1; }
    const j = (seg + 1) % m;
    const f = segLen[seg] > 1e-6 ? Math.max(0, Math.min(1, (target - acc) / segLen[seg])) : 0;
    out[s * 2] = x0 + (pts[seg * 2] + (pts[j * 2] - pts[seg * 2]) * f) / plateW;
    out[s * 2 + 1] = y0 + (pts[seg * 2 + 1] + (pts[j * 2 + 1] - pts[seg * 2 + 1]) * f) / plateH;
  }
  return out;
}

// Shared texture bake: `fill(data)` writes PATH_FX_SAMPLES quad-uv (y up)
// samples into the RGBA float row; the result is content-keyed and LRU-bounded
// in the same cache the shape bake uses.
export function getOrBakePathTexture(key, fill) {
  let entry = pathFxTexCache.get(key);
  if (!entry) {
    const data = new Float32Array(PATH_FX_SAMPLES * 4);
    if (!fill(data)) return null;
    const texture = new THREE.DataTexture(data, PATH_FX_SAMPLES, 1, THREE.RGBAFormat, THREE.FloatType);
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    entry = { texture };
    pathFxTexCache.set(key, entry);
    if (pathFxTexCache.size > 12) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [k, v] of pathFxTexCache) {
        if (k === key) continue;
        if ((v.lastUsed ?? 0) < oldest) { oldest = v.lastUsed ?? 0; oldestKey = k; }
      }
      if (oldestKey) {
        try { pathFxTexCache.get(oldestKey).texture.dispose(); } catch { /* no-op */ }
        pathFxTexCache.delete(oldestKey);
      }
    }
  }
  entry.lastUsed = ++_pathFxSeq;
  return entry.texture;
}

// Keyframed RATE integration (Neon Glow's Speed, Grow Fill, Repetile scroll,
// Layer Mask's Grow) lives in gsapTransitions.js beside the keyframe evaluator
// it samples — see `integratePathRate` there for why a rate track must be
// integrated rather than multiplied.

export function resolveLayerPathFx(engine, item, clip, kf, layerMesh) {
  const mediaType = clip?.mediaType;
  const { w: compW, h: compH } = engine.videoSize;
  const relax = pathFxRelaxAmount(item);
  if (mediaType === 'shape') return getShapePathFxData(item, kf, compW, compH, relax);
  const u = layerMesh?.material?.uniforms;
  const canvasSize = u?.uCanvasSize?.value;
  const mediaSize = u?.uResolution?.value;
  if (!canvasSize || !(canvasSize.x > 1) || !(canvasSize.y > 1)) return null;
  // Content rect fractions inside the quad — the same maths as the shader's
  // fit-contain branch, so traced points land on the drawn pixels.
  let { cw, ch } = mediaSize ? mediaContentFrac(layerMesh) : { cw: 1, ch: 1 };
  let outline = null;
  let sourceKey = null;
  // A masked layer runs its light along what the mask leaves visible. That
  // outline is traced in the layer BOX (the coverage plate's space), so it
  // maps onto the quad with no fit.
  const masked = maskVisibleShapeInEngine(engine, item, clip, layerMesh, { outline: true });
  if (masked?.outline?.frac) {
    outline = masked.outline;
    sourceKey = `mask:${item.id}:${masked.key}`;
    cw = 1;
    ch = 1;
  } else if (mediaType === 'text' || mediaType === 'motion') {
    const canvas = engine.textTextureCache.get(item.id)?.canvas;
    if (!canvas) return null;
    outline = getCanvasAlphaOutline(item.id, canvas);
    if (!outline) return null;
    sourceKey = `cv:${item.id}:${outline.hash}`;
  } else if (mediaType === 'image') {
    outline = getImageAlphaOutline(clip.proxyUrl || clip.url);
    if (!outline) return null; // still decoding
    sourceKey = `img:${djb2(clip.proxyUrl || clip.url)}`;
  }
  const fit = `${cw.toFixed(4)}:${ch.toFixed(4)}:${Math.round(canvasSize.x)}x${Math.round(canvasSize.y)}`;
  let texture = null;
  let closed = true;
  if (outline && outline.frac) {
    closed = outline.closed;
    const frac = outline.frac;
    const breaks = outline.breaks || null;
    const relaxKey = relax > 0 ? `:rx${Math.round(relax)}` : '';
    texture = getOrBakePathTexture(`${sourceKey}:${fit}${relaxKey}`, (data) => {
      let contourStart = 0;
      for (let i = 0; i < PATH_FX_SAMPLES; i += 1) {
        // Source fraction (y down) → quad uv (y up, fxLocal space). z flags a
        // contour's first sample; w carries that contour's first index, which
        // is how the shader closes each glyph ring onto itself instead of
        // bridging across the gap to the next glyph.
        if (breaks && breaks[i]) contourStart = i;
        data[i * 4] = 0.5 + (frac[i * 2] - 0.5) * cw;
        data[i * 4 + 1] = 1 - (0.5 + (frac[i * 2 + 1] - 0.5) * ch);
        data[i * 4 + 2] = breaks && breaks[i] ? 1 : 0;
        data[i * 4 + 3] = contourStart;
      }
      relaxPathLutSamples(data, PATH_FX_SAMPLES, relax, closed);
      return true;
    });
  } else {
    // Media rect (with the item's corner radii): video, opaque images, and
    // any media kind without a CPU-readable alpha.
    const radii = getItemCornerRadii(item);
    const radius = Math.max(0, ...radii.map((r) => (Number.isFinite(Number(r)) ? Number(r) : 0)));
    texture = getOrBakePathTexture(`rect:${fit}:${Math.round(radius)}`, (data) => {
      const quad = sampleRoundedRectQuad(cw, ch, radius, canvasSize.x, canvasSize.y, PATH_FX_SAMPLES);
      if (!quad) return false;
      for (let i = 0; i < PATH_FX_SAMPLES; i += 1) {
        // One contour: z (contour start) and w (its first index) stay 0.
        data[i * 4] = quad[i * 2];
        data[i * 4 + 1] = 1 - quad[i * 2 + 1];
      }
      return true;
    });
  }
  if (!texture) return null;
  return {
    texture,
    count: PATH_FX_SAMPLES,
    closed,
    plateWidth: canvasSize.x,
    plateHeight: canvasSize.y,
  };
}

