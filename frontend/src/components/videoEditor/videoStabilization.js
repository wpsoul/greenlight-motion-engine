/*
 * Video Stabilization — the exact local-path solve from
 * html/video-stabilizer-lab-v2.html, expressed as a standalone layer effect.
 *
 * This module is deliberately unaware of camera layers and Motion Tracking.
 * Its input is an adjacent-frame camera path; its output is one source-image
 * warp per decoded frame. Player applies that warp while sampling the video
 * texture, before the layer's authored transform, effects and transitions.
 */

export const VIDEO_STABILIZATION_VERSION = 2;

export const VIDEO_STABILIZATION_DEFAULTS = Object.freeze({
  radius: 8,
  strength: 0.88,
  maxCrop: 1.18,
  adaptive: true,
  position: true,
  rotation: true,
  scale: false,
});

export const VIDEO_STABILIZATION_ANALYSIS_DEFAULTS = Object.freeze({
  fps: 23.976,
  analysisWidth: 640,
  featureBudget: 480,
  robustFlowGate: 2.2,
  subjectGuard: true,
});

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const finite = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const rms = (a) => (a.length ? Math.sqrt(mean(a.map((x) => x * x))) : 0);
export const stabilizationMedian = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);

export const stabilizationIdentity = () => ({ s: 1, th: 0, tx: 0, ty: 0 });

export function stabilizationApply(m, x, y) {
  const c = Math.cos(m.th) * m.s;
  const s = Math.sin(m.th) * m.s;
  return [c * x - s * y + m.tx, s * x + c * y + m.ty];
}

export function stabilizationCompose(A, B) {
  const c = Math.cos(A.th) * A.s;
  const s = Math.sin(A.th) * A.s;
  return {
    s: A.s * B.s,
    th: A.th + B.th,
    tx: c * B.tx - s * B.ty + A.tx,
    ty: s * B.tx + c * B.ty + A.ty,
  };
}

export function stabilizationInverse(A) {
  const z = 1 / A.s;
  const th = -A.th;
  const c = Math.cos(th) * z;
  const s = Math.sin(th) * z;
  return { s: z, th, tx: -(c * A.tx - s * A.ty), ty: -(s * A.tx + c * A.ty) };
}

export const packStabilizationTransform = (m) => [m.s, m.th, m.tx, m.ty];
export const unpackStabilizationTransform = (p) => ({
  s: finite(p?.[0], 1),
  th: finite(p?.[1], 0),
  tx: finite(p?.[2], 0),
  ty: finite(p?.[3], 0),
});

export function sanitizeVideoStabilizationOptions(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    radius: Math.round(clamp(finite(r.radius, VIDEO_STABILIZATION_DEFAULTS.radius), 2, 20)),
    strength: clamp(finite(r.strength, VIDEO_STABILIZATION_DEFAULTS.strength), 0, 1),
    maxCrop: clamp(finite(r.maxCrop, VIDEO_STABILIZATION_DEFAULTS.maxCrop), 1.02, 1.35),
    adaptive: r.adaptive !== false,
    position: r.position !== false,
    rotation: r.rotation !== false,
    scale: r.scale === true,
  };
}

export function sanitizeVideoStabilizationAnalysisOptions(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    fps: clamp(finite(r.fps, 23.976), 1, 120),
    analysisWidth: Math.round(clamp(finite(r.analysisWidth, 640), 320, 1280)),
    featureBudget: Math.round(clamp(finite(r.featureBudget, 480), 120, 720) / 40) * 40,
    robustFlowGate: clamp(finite(r.robustFlowGate, 2.2), 0.8, 4),
    subjectGuard: r.subjectGuard !== false,
  };
}

const paramsFromSim = (m, width, height) => {
  const p = stabilizationApply(m, width / 2, height / 2);
  return { cx: p[0], cy: p[1], th: m.th, ls: Math.log(Math.max(1e-6, m.s)) };
};

const simFromParams = (p, width, height) => {
  const z = Math.exp(p.ls);
  const c = Math.cos(p.th) * z;
  const s = Math.sin(p.th) * z;
  return {
    s: z,
    th: p.th,
    tx: p.cx - (c * width / 2 - s * height / 2),
    ty: p.cy - (s * width / 2 + c * height / 2),
  };
};

function unwrap(arr) {
  for (let i = 1; i < arr.length; i += 1) {
    while (arr[i].th - arr[i - 1].th > Math.PI) arr[i].th -= Math.PI * 2;
    while (arr[i].th - arr[i - 1].th < -Math.PI) arr[i].th += Math.PI * 2;
  }
  return arr;
}

function smoothParams(arr, radius) {
  if (radius <= 0 || arr.length < 3) return arr.map((p) => ({ ...p }));
  const keys = ['cx', 'cy', 'th', 'ls'];
  const sig = Math.max(0.6, radius / 2.35);
  const weights = [];
  for (let k = -radius; k <= radius; k += 1) weights.push(Math.exp(-0.5 * (k / sig) ** 2));
  const span = Math.min(arr.length - 1, Math.max(3, radius * 2));
  const line = (i0, i1, key, j) => {
    const tm = (i0 + i1) / 2;
    const vm = mean(arr.slice(i0, i1 + 1).map((p) => p[key]));
    let nu = 0;
    let de = 0;
    for (let i = i0; i <= i1; i += 1) {
      nu += (i - tm) * (arr[i][key] - vm);
      de += (i - tm) ** 2;
    }
    return vm + (de ? nu / de : 0) * (j - tm);
  };
  const at = (j, key) => (j < 0
    ? line(0, span, key, j)
    : j >= arr.length
      ? line(arr.length - 1 - span, arr.length - 1, key, j)
      : arr[j][key]);
  return arr.map((_, i) => {
    const out = { cx: 0, cy: 0, th: 0, ls: 0 };
    let sw = 0;
    for (let k = -radius; k <= radius; k += 1) {
      const w = weights[k + radius];
      for (const key of keys) out[key] += at(i + k, key) * w;
      sw += w;
    }
    for (const key of keys) out[key] /= sw;
    return out;
  });
}

const lerpParams = (a, b, t) => ({
  cx: a.cx + (b.cx - a.cx) * t,
  cy: a.cy + (b.cy - a.cy) * t,
  th: a.th + (b.th - a.th) * t,
  ls: a.ls + (b.ls - a.ls) * t,
});

const blendSim = (m, t, width, height) => simFromParams(lerpParams(
  { cx: width / 2, cy: height / 2, th: 0, ls: 0 },
  paramsFromSim(m, width, height),
  t,
), width, height);

const scaleAbout = (z, width, height) => ({
  s: z,
  th: 0,
  tx: width / 2 * (1 - z),
  ty: height / 2 * (1 - z),
});

function coversAt(warp, z, width, height) {
  const inv = stabilizationInverse(warp);
  const cx = width / 2;
  const cy = height / 2;
  for (const p of [[0, 0], [width, 0], [width, height], [0, height]]) {
    const x = cx + (p[0] - cx) / z;
    const y = cy + (p[1] - cy) / z;
    const q = stabilizationApply(inv, x, y);
    if (q[0] < -0.01 || q[1] < -0.01 || q[0] > width + 0.01 || q[1] > height + 0.01) return false;
  }
  return true;
}

function requiredZoom(warp, width, height) {
  if (coversAt(warp, 1, width, height)) return 1;
  if (!coversAt(warp, 3, width, height)) return 3;
  let lo = 1;
  let hi = 3;
  for (let i = 0; i < 24; i += 1) {
    const m = (lo + hi) / 2;
    if (coversAt(warp, m, width, height)) hi = m;
    else lo = m;
  }
  return hi;
}

function accelRms(params) {
  const a = [];
  for (let i = 1; i < params.length - 1; i += 1) {
    a.push(Math.hypot(
      params[i + 1].cx - 2 * params[i].cx + params[i - 1].cx,
      params[i + 1].cy - 2 * params[i].cy + params[i - 1].cy,
    ));
  }
  return rms(a);
}

function localFlowJitter(flow, warps, width, height) {
  if (!flow?.length) return 0;
  const cells = new Map();
  for (let f = 1; f < flow.length; f += 1) {
    const packed = flow[f];
    if (!Array.isArray(packed) || packed.length < 4) continue;
    const frameCells = new Map();
    for (let i = 0; i + 3 < packed.length; i += 4) {
      const ax = packed[i];
      const ay = packed[i + 1];
      const bx = packed[i + 2];
      const by = packed[i + 3];
      const key = `${clamp(Math.floor(ax / (width / 8)), 0, 7)}:${clamp(Math.floor(ay / (height / 5)), 0, 4)}`;
      const p = stabilizationApply(warps[f - 1], ax, ay);
      const q = stabilizationApply(warps[f], bx, by);
      const bucket = frameCells.get(key) || [];
      bucket.push([q[0] - p[0], q[1] - p[1]]);
      frameCells.set(key, bucket);
    }
    for (const [key, bucket] of frameCells) {
      const row = cells.get(key) || new Array(flow.length - 1).fill(null);
      row[f - 1] = [
        stabilizationMedian(bucket.map((v) => v[0])),
        stabilizationMedian(bucket.map((v) => v[1])),
      ];
      cells.set(key, row);
    }
  }
  const changes = [];
  for (const row of cells.values()) {
    for (let i = 1; i < row.length; i += 1) {
      if (row[i] && row[i - 1]) changes.push(Math.hypot(
        row[i][0] - row[i - 1][0],
        row[i][1] - row[i - 1][1],
      ));
    }
  }
  return rms(changes);
}

const unpackFit = (fit) => ({
  fit: unpackStabilizationTransform(fit),
  inliers: Math.max(0, Math.round(finite(fit?.[4], 0))),
  med: finite(fit?.[5], 99),
  p90: finite(fit?.[6], 99),
  tracks: Math.max(0, Math.round(finite(fit?.[7], 0))),
  cells: Math.max(0, Math.round(finite(fit?.[8], 0))),
  held: finite(fit?.[9], 0) >= 0.5,
});

/** Re-run only the lab's live post-solve controls; no pixels are decoded. */
export function computeVideoStabilization({ path: packedPath, fits: packedFits = [], flow = [], width, height, options }) {
  const W = Math.max(1, finite(width, 640));
  const H = Math.max(1, finite(height, 360));
  const opts = sanitizeVideoStabilizationOptions(options);
  const path = (packedPath || []).map(unpackStabilizationTransform);
  const fits = (packedFits || []).map(unpackFit);
  if (!path.length) return null;

  const raw = unwrap(path.map((m) => paramsFromSim(m, W, H)));
  const filtered = smoothParams(raw, opts.radius);
  const desired = raw.map((p, i) => {
    const q = lerpParams(p, filtered[i], opts.strength);
    if (!opts.position) { q.cx = p.cx; q.cy = p.cy; }
    if (!opts.rotation) q.th = p.th;
    if (!opts.scale) q.ls = p.ls;
    return q;
  });
  const smooth = desired.map((p) => simFromParams(p, W, H));
  const tilde = smooth.map((m, i) => stabilizationCompose(m, stabilizationInverse(path[i])));
  const ps = tilde.map((m) => paramsFromSim(m, W, H));
  const mp = {
    cx: mean(ps.map((p) => p.cx)),
    cy: mean(ps.map((p) => p.cy)),
    th: mean(ps.map((p) => p.th)),
    ls: mean(ps.map((p) => p.ls)),
  };
  let ref = 0;
  let best = Infinity;
  const diag = Math.hypot(W, H) / 2;
  ps.forEach((p, i) => {
    const d = Math.hypot(p.cx - mp.cx, p.cy - mp.cy)
      + Math.abs(p.th - mp.th) * diag + Math.abs(p.ls - mp.ls) * diag;
    if (d < best) { best = d; ref = i; }
  });
  const norm = stabilizationInverse(tilde[ref]);
  let warps = tilde.map((w) => stabilizationCompose(norm, w));

  const validP90 = fits.filter((x) => !x.held && Number.isFinite(x.p90)).map((x) => x.p90);
  const typicalP90 = stabilizationMedian(validP90) || 1;
  const rawQuality = warps.map((_, f) => {
    const near = [fits[f - 1], fits[f]].filter(Boolean);
    if (!near.length) return 1;
    const p90 = Math.max(...near.map((x) => x.p90 || typicalP90));
    const support = Math.min(...near.map((x) => x.inliers / Math.max(1, x.tracks)));
    const good = typicalP90 * 1.55;
    const bad = typicalP90 * 2.8;
    const parallax = 1 - 0.32 * clamp((p90 - good) / Math.max(0.01, bad - good), 0, 1);
    const tracking = 0.9 + 0.1 * clamp((support - 0.8) / 0.16, 0, 1);
    return Math.min(parallax, tracking);
  });
  const valley = rawQuality.map((_, i) => Math.min(...rawQuality.slice(Math.max(0, i - 1), Math.min(rawQuality.length, i + 2))));
  const quality = valley.map((_, i) => {
    let sum = 0;
    let sw = 0;
    for (let k = -2; k <= 2; k += 1) {
      const j = clamp(i + k, 0, valley.length - 1);
      const w = 3 - Math.abs(k);
      sum += valley[j] * w;
      sw += w;
    }
    return sum / sw;
  });
  warps = warps.map((w, i) => blendSim(w, quality[i], W, H));

  const cap = opts.maxCrop;
  const cropAlpha = warps.map(() => 1);
  const alpha = [...quality];
  if (opts.adaptive) {
    for (let f = 0; f < warps.length; f += 1) {
      if (requiredZoom(warps[f], W, H) <= cap) continue;
      let lo = 0;
      let hi = 1;
      for (let k = 0; k < 20; k += 1) {
        const m = (lo + hi) / 2;
        if (requiredZoom(blendSim(warps[f], m, W, H), W, H) <= cap) lo = m;
        else hi = m;
      }
      cropAlpha[f] = lo;
    }
    const safe = cropAlpha.map((_, i) => Math.min(...cropAlpha.slice(Math.max(0, i - 2), Math.min(cropAlpha.length, i + 3))));
    for (let f = 0; f < warps.length; f += 1) {
      cropAlpha[f] = Math.min(cropAlpha[f], mean(safe.slice(Math.max(0, f - 2), Math.min(safe.length, f + 3))));
    }
    warps = warps.map((w, i) => blendSim(w, cropAlpha[i], W, H));
    for (let f = 0; f < alpha.length; f += 1) alpha[f] *= cropAlpha[f];
  }

  const zoomReq = warps.map((w) => requiredZoom(w, W, H));
  const zoom = Math.min(cap, Math.max(1, Math.max(...zoomReq) * 1.002));
  const final = warps.map((w) => stabilizationCompose(scaleAbout(zoom, W, H), w));
  const after = unwrap(warps.map((w, i) => paramsFromSim(stabilizationCompose(w, path[i]), W, H)));
  const beforeAccel = accelRms(raw);
  const afterAccel = accelRms(after);
  const localBefore = localFlowJitter(flow, path.map(() => stabilizationIdentity()), W, H);
  const localAfter = localFlowJitter(flow, warps, W, H);
  return {
    warps: final.map(packStabilizationTransform),
    metrics: {
      ref,
      zoom,
      zoomReq,
      alpha,
      quality,
      beforeAccel,
      afterAccel,
      jitterCut: beforeAccel > 1e-6 ? clamp(1 - afterAccel / beforeAccel, 0, 1) : 0,
      adaptiveFrames: cropAlpha.filter((a) => a < 0.995).length,
      qualityFrames: quality.filter((a) => a < 0.97).length,
      localBefore,
      localAfter,
      localShakeCut: localBefore > 1e-6 ? clamp(1 - localAfter / localBefore, 0, 1) : 0,
      support: fits.length ? stabilizationMedian(fits.map((x) => x.inliers / Math.max(1, x.tracks))) : 0,
      residual: fits.length ? stabilizationMedian(fits.filter((x) => !x.held).map((x) => x.p90)) : 0,
      heldFrames: fits.filter((x) => x.held).length,
    },
  };
}

export function createVideoStabilization(analysis, options, analysisOptions) {
  const cleanOptions = sanitizeVideoStabilizationOptions(options);
  const result = computeVideoStabilization({ ...analysis, options: cleanOptions });
  if (!result) return null;
  return {
    version: VIDEO_STABILIZATION_VERSION,
    enabled: true,
    options: cleanOptions,
    analysisOptions: sanitizeVideoStabilizationAnalysisOptions(analysisOptions),
    analysis: {
      width: analysis.width,
      height: analysis.height,
      fps: analysis.fps,
      startTime: analysis.startTime,
      endTime: analysis.endTime,
      frames: analysis.frames,
      path: analysis.path,
      fits: analysis.fits,
      flow: analysis.flow,
    },
    result,
  };
}

export function retuneVideoStabilization(stabilization, patch) {
  // Runtime values have already passed createVideoStabilization() or the
  // project-load sanitizer. Re-sanitizing here would run the full solve once,
  // then run it a second time below for every tick of a dragged control.
  const s = stabilization;
  if (!s || Number(s.version) !== VIDEO_STABILIZATION_VERSION || !s.analysis) return null;
  const options = sanitizeVideoStabilizationOptions({ ...s.options, ...(patch || {}) });
  const result = computeVideoStabilization({ ...s.analysis, options });
  return result ? { ...s, options, result } : null;
}

const cleanPackedTransforms = (rows, limit) => (Array.isArray(rows) ? rows.slice(0, limit).map((row) => [
  finite(row?.[0], 1), finite(row?.[1], 0), finite(row?.[2], 0), finite(row?.[3], 0),
]) : []);

export function sanitizeVideoStabilization(raw) {
  if (!raw || typeof raw !== 'object' || Number(raw.version) !== VIDEO_STABILIZATION_VERSION) return null;
  const a = raw.analysis && typeof raw.analysis === 'object' ? raw.analysis : null;
  if (!a) return null;
  const frames = Math.round(clamp(finite(a.frames, 0), 0, 43200));
  const width = Math.round(clamp(finite(a.width, 0), 1, 4096));
  const height = Math.round(clamp(finite(a.height, 0), 1, 4096));
  const path = cleanPackedTransforms(a.path, frames);
  if (frames < 2 || path.length !== frames) return null;
  const fits = Array.isArray(a.fits) ? a.fits.slice(0, Math.max(0, frames - 1)).map((row) => [
    finite(row?.[0], 1), finite(row?.[1], 0), finite(row?.[2], 0), finite(row?.[3], 0),
    Math.max(0, Math.round(finite(row?.[4], 0))), finite(row?.[5], 99), finite(row?.[6], 99),
    Math.max(0, Math.round(finite(row?.[7], 0))), Math.max(0, Math.round(finite(row?.[8], 0))),
    finite(row?.[9], 0) >= 0.5 ? 1 : 0,
  ]) : [];
  const flow = Array.from({ length: frames }, (_, i) => {
    const row = a.flow?.[i];
    if (!Array.isArray(row)) return [];
    const n = Math.min(row.length - (row.length % 4), 720 * 4);
    return row.slice(0, n).map((v) => finite(v, 0));
  });
  const analysis = {
    width,
    height,
    fps: clamp(finite(a.fps, 24), 1, 120),
    startTime: Math.max(0, finite(a.startTime, 0)),
    endTime: Math.max(0, finite(a.endTime, 0)),
    frames,
    path,
    fits,
    flow,
  };
  const options = sanitizeVideoStabilizationOptions(raw.options);
  const computed = computeVideoStabilization({ ...analysis, options });
  if (!computed) return null;
  return {
    version: VIDEO_STABILIZATION_VERSION,
    enabled: raw.enabled !== false,
    options,
    analysisOptions: sanitizeVideoStabilizationAnalysisOptions(raw.analysisOptions),
    analysis,
    // Recompute from sanitized analysis so malformed or stale warps never reach
    // the renderer, and saved controls always agree with the visible result.
    result: computed,
  };
}

/**
 * True when this item carries a solved, enabled stabilization — i.e. when its
 * preview is frame-critical, because the correction is indexed per source frame
 * and a picture one frame off shows a warp that ADDS motion rather than removing
 * it. Kept next to the sampler so both agree on what "stabilized" means.
 */
export function hasVideoStabilization(item) {
  const s = item?.videoStabilization;
  return !!s && s.enabled !== false && Array.isArray(s.result?.warps) && s.result.warps.length > 0;
}

export function sampleVideoStabilization(stabilization, sourceTime) {
  if (!stabilization || stabilization.enabled === false) return null;
  const a = stabilization.analysis;
  const warps = stabilization.result?.warps;
  if (!a || !Array.isArray(warps) || !warps.length) return null;
  const f = clamp(Math.floor((finite(sourceTime, a.startTime) - a.startTime) * a.fps + 1e-4), 0, warps.length - 1);
  return { ...unpackStabilizationTransform(warps[f]), frame: f, width: a.width, height: a.height };
}

/** Pixel-space inverse affine coefficients consumed by clipShader. */
export function inverseVideoStabilizationSample(sample) {
  if (!sample) return null;
  const inv = stabilizationInverse(sample);
  const c = Math.cos(inv.th) * inv.s;
  const s = Math.sin(inv.th) * inv.s;
  return { a: c, b: -s, c: s, d: c, tx: inv.tx, ty: inv.ty, width: sample.width, height: sample.height };
}
