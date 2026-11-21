/*
 * (hdr3) An HDR render's frames as the file holds them: 10-bit Y'CbCr 4:2:0, BT.2020 non-constant luminance, limited range, PQ or HLG
 * placed as BT.2408 places SDR white (1.0 of the frames' light = 203 cd/m²; HLG for a 1000 cd/m² display, gamma 1.2).
 *
 * Why the page makes them itself: 4:2:0 keeps one chroma pair for four pixels, and a decoder rebuilds each pixel's colour from its own
 * Y' and its neighbours' chroma. In PQ (non-constant luminance) that moves light between pixels at every colour edge: a saturated blue
 * glint's edge came out of the round-1 files at 1440-1554 cd/m² where 841 was meant, the pink desk's clover glint at 1281-1298 where
 * 1000 was meant. Luma adjustment (Ström et al., "Luma Adjustment for High Dynamic Range Video", DCC 2016; the fix in the HDR reference
 * encoders) picks each pixel's Y' code so that the light a decoder rebuilds from it and from the chroma it will actually get (the
 * downsampled, quantized pair, upsampled bilinearly from its siting) has the luminance meant. On top: no component may decode above the
 * 1000 cd/m² peak, with that chroma nor with the chroma a decoder that repeats each sample has (a PQ file's MaxCLL is the light the
 * frames were meant to have, so nothing is decoded brighter than it).
 *
 * The chroma: siting type 0 (HEVC's default: horizontally on the even column, vertically between the two rows), downsampled [1 2 1]/4
 * across and [1 1]/2 down from the R'G'B' the transfer gives each pixel. The decoder assumed: bilinear from that siting.
 *
 * This file is the arithmetic, once in JS (the reference the unit tests hold the GPU to, and the decoder they check with) and once as
 * the WGSL compute passes hdrEncode.js runs on the render's own GPU.
 */

// BT.2020 non-constant luminance
export const KR = 0.2627;
export const KB = 0.0593;
export const KG = 1 - KR - KB;
const CB_DIV = 2 * (1 - KB); // 1.8814
const CR_DIV = 2 * (1 - KR); // 1.4746
// BT.709 primaries in BT.2020 (BT.2087)
export const M709_TO_2020 = [
  [0.627403895934699, 0.329283038377884, 0.043313065687417],
  [0.069097289358232, 0.919540395075459, 0.011362315566309],
  [0.016391438875150, 0.088013307877226, 0.895595253247624],
];
// SDR white in the frames' light (1.0), cd/m²; the HDR view's peak; HLG's display peak
export const WHITE_NITS = 203;
export const PEAK_NITS = 1000;
export const LIGHT_PEAK = PEAK_NITS / WHITE_NITS;
const HLG_PEAK_NITS = 1000;
const HLG_GAMMA = 1.2;

const PQ = { m1: 2610 / 16384, m2: (2523 / 4096) * 128, c1: 3424 / 4096, c2: (2413 / 4096) * 32, c3: (2392 / 4096) * 32 };
/** Normalized linear light (1 = 10000 cd/m²) to the PQ signal. */
export function pqOetf(y) {
  const p = Math.max(0, Math.min(1, y)) ** PQ.m1;
  return ((PQ.c1 + PQ.c2 * p) / (1 + PQ.c3 * p)) ** PQ.m2;
}
/** The PQ signal to normalized linear light (1 = 10000 cd/m²). */
export function pqEotf(e) {
  const p = Math.max(0, Math.min(1, e)) ** (1 / PQ.m2);
  return (Math.max(p - PQ.c1, 0) / (PQ.c2 - PQ.c3 * p)) ** (1 / PQ.m1);
}
const HLG = { a: 0.17883277, b: 0.28466892, c: 0.55991073 };
/** Scene light (0..1) to the HLG signal. */
export function hlgOetf(e) {
  const x = Math.max(0, Math.min(1, e));
  return x <= 1 / 12 ? Math.sqrt(3 * x) : HLG.a * Math.log(12 * x - HLG.b) + HLG.c;
}
/** The HLG signal to scene light (0..1). */
export function hlgInverse(s) {
  const x = Math.max(0, Math.min(1, s));
  return x <= 0.5 ? (x * x) / 3 : (Math.exp((x - HLG.c) / HLG.a) + HLG.b) / 12;
}
export const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/**
 * (hdr3) The float composite's numbers to light. The stack holds each pixel's SDR display value up to white (1.0) and its light above
 * white (hdrComposite.js: the Scene's plate is encoded so), so a channel at or below 1 is a display value and one above is light already.
 */
export const hybridToLight = (v) => (!(v > 0) ? 0 : v <= 1 ? srgbToLinear(v) : v);

/** One pixel of light (BT.709, 1 = SDR white) to the signal's R'G'B' and the luminance a decoder must rebuild (in the transfer's own
 *  linear units: 1 = 10000 cd/m² for PQ, scene light for HLG). Light past the peak is brought down as a whole, its hue kept. */
export function primeOf(r, g, b, transfer = 'pq') {
  r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
  const top = Math.max(r, g, b);
  if (top > LIGHT_PEAK) { const k = LIGHT_PEAK / top; r *= k; g *= k; b *= k; }
  const M = M709_TO_2020;
  let R = Math.max(0, M[0][0] * r + M[0][1] * g + M[0][2] * b);
  let G = Math.max(0, M[1][0] * r + M[1][1] * g + M[1][2] * b);
  let B = Math.max(0, M[2][0] * r + M[2][1] * g + M[2][2] * b);
  const most = Math.max(R, G, B);
  if (transfer === 'hlg') {
    const s = WHITE_NITS / HLG_PEAK_NITS;
    R *= s; G *= s; B *= s;
    const yd = KR * R + KG * G + KB * B;
    const k = yd > 0 ? yd ** (1 / HLG_GAMMA - 1) : 0;
    R = Math.min(1, R * k); G = Math.min(1, G * k); B = Math.min(1, B * k);
    return { p: [hlgOetf(R), hlgOetf(G), hlgOetf(B)], target: KR * R + KG * G + KB * B, most };
  }
  const s = WHITE_NITS / 10000;
  R *= s; G *= s; B *= s;
  return { p: [pqOetf(R), pqOetf(G), pqOetf(B)], target: KR * R + KG * G + KB * B, most };
}

const yCode = (v) => Math.max(64, Math.min(940, Math.round(64 + 876 * v)));
const cCode = (v) => Math.max(64, Math.min(960, Math.round(512 + 896 * v)));

/** What a decoder rebuilds from a Y' code and dequantized chroma: { lum, most } in the transfer's linear units. */
export function rebuild(code, cb, cr, transfer = 'pq') {
  const y = (code - 64) / 876;
  const R1 = Math.max(0, Math.min(1, y + CR_DIV * cr));
  const B1 = Math.max(0, Math.min(1, y + CB_DIV * cb));
  const G1 = Math.max(0, Math.min(1, (y - KR * (y + CR_DIV * cr) - KB * (y + CB_DIV * cb)) / KG));
  const f = transfer === 'hlg' ? hlgInverse : pqEotf;
  const R = f(R1), G = f(G1), B = f(B1);
  return { lum: KR * R + KG * G + KB * B, most: Math.max(R, G, B), rgb: [R, G, B] };
}

/** The Y' code for a target luminance given the chroma the decoder will have (luma adjustment), capped so no component decodes past
 *  `cap` (transfer's linear units; Infinity: no cap) with that chroma, nor with `alt` ([cb, cr]: the chroma a decoder that repeats each
 *  sample would have instead). */
export function adjustLuma(target, cb, cr, transfer = 'pq', cap = Infinity, alt = null) {
  let lo = 64, hi = 941;
  if (rebuild(64, cb, cr, transfer).lum > target) hi = 65;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rebuild(mid, cb, cr, transfer).lum <= target) lo = mid; else hi = mid;
  }
  let code = lo;
  if (lo < 940 && Math.abs(rebuild(lo + 1, cb, cr, transfer).lum - target) < Math.abs(rebuild(lo, cb, cr, transfer).lum - target)) code = lo + 1;
  const over = (c) => rebuild(c, cb, cr, transfer).most > cap || (!!alt && rebuild(c, alt[0], alt[1], transfer).most > cap);
  if (Number.isFinite(cap) && over(code)) {
    let a = 64, b = code;
    while (b - a > 1) {
      const mid = (a + b) >> 1;
      if (!over(mid)) a = mid; else b = mid;
    }
    code = a;
  }
  return code;
}

/** The chroma a decoder that repeats each chroma sample over its 2 x 2 block has at luma pixel (x, y). */
export function repeatedChroma(cbCodes, crCodes, cw, x, y) {
  const k = (y >> 1) * cw + (x >> 1);
  return [(cbCodes[k] - 512) / 896, (crCodes[k] - 512) / 896];
}

/** The chroma a decoder has at luma pixel (x, y): bilinear from siting type 0. `cb` / `cr` codes, cw × ch. */
export function upsampledChroma(cbCodes, crCodes, cw, ch, x, y) {
  const u = x / 2, v = (y - 0.5) / 2;
  const i0 = Math.floor(u), j0 = Math.floor(v);
  const fu = u - i0, fv = v - j0;
  const ci = (i) => Math.max(0, Math.min(cw - 1, i)), cj = (j) => Math.max(0, Math.min(ch - 1, j));
  const at = (p, i, j) => p[cj(j) * cw + ci(i)];
  const bil = (p) => (at(p, i0, j0) * (1 - fu) + at(p, i0 + 1, j0) * fu) * (1 - fv) + (at(p, i0, j0 + 1) * (1 - fu) + at(p, i0 + 1, j0 + 1) * fu) * fv;
  return [(bil(cbCodes) - 512) / 896, (bil(crCodes) - 512) / 896];
}

/** The PQ peak a component may decode to, in PQ's linear units. */
export const PQ_CAP = PEAK_NITS / 10000;

/**
 * The reference encoder (the unit tests' and the GPU's yardstick): `light` rgba floats (BT.709 light, 1 = SDR white, rows top first),
 * w × h; `hybrid`: the float composite's numbers (hybridToLight first). Returns { planes: Uint16Array (Y, then Cb, then Cr, the sides
 * padded to even with black), width, height (padded), light: { max, mean } (CTA-861.3 in SDR whites: the brightest BT.2020 component,
 * the frame mean of each pixel's brightest) }.
 */
export function encodeYuv420(light, w, h, { transfer = 'pq', hybrid = false, adjust = true } = {}) {
  const W = w + (w & 1), H = h + (h & 1), cw = W / 2, chh = H / 2;
  const prime = new Float64Array(W * H * 4);
  let most = 0, sum = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let r = 0, g = 0, b = 0;
      if (x < w && y < h) {
        const i = (y * w + x) * 4;
        r = light[i]; g = light[i + 1]; b = light[i + 2];
        if (hybrid) { r = hybridToLight(r); g = hybridToLight(g); b = hybridToLight(b); }
      }
      const q = primeOf(r, g, b, transfer);
      if (x < w && y < h) { if (q.most > most) most = q.most; sum += q.most; }
      const o = (y * W + x) * 4;
      prime[o] = q.p[0]; prime[o + 1] = q.p[1]; prime[o + 2] = q.p[2]; prime[o + 3] = q.target;
    }
  }
  const planes = new Uint16Array(W * H + 2 * cw * chh);
  const cbC = planes.subarray(W * H, W * H + cw * chh), crC = planes.subarray(W * H + cw * chh);
  for (let j = 0; j < chh; j += 1) {
    for (let i = 0; i < cw; i += 1) {
      let cb = 0, cr = 0;
      for (const [dx, wx] of [[-1, 0.25], [0, 0.5], [1, 0.25]]) {
        for (const dy of [0, 1]) {
          const x = Math.max(0, Math.min(W - 1, 2 * i + dx)), y = 2 * j + dy;
          const o = (y * W + x) * 4;
          const Y1 = KR * prime[o] + KG * prime[o + 1] + KB * prime[o + 2];
          cb += wx * 0.5 * ((prime[o + 2] - Y1) / CB_DIV);
          cr += wx * 0.5 * ((prime[o] - Y1) / CR_DIV);
        }
      }
      cbC[j * cw + i] = cCode(cb); crC[j * cw + i] = cCode(cr);
    }
  }
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 4;
      if (!adjust) {
        planes[y * W + x] = yCode(KR * prime[o] + KG * prime[o + 1] + KB * prime[o + 2]);
        continue;
      }
      const [cb, cr] = upsampledChroma(cbC, crC, cw, chh, x, y);
      planes[y * W + x] = adjustLuma(prime[o + 3], cb, cr, transfer, transfer === 'pq' ? PQ_CAP : Infinity, repeatedChroma(cbC, crC, cw, x, y));
    }
  }
  const n = w * h;
  return { planes, width: W, height: H, light: { max: most, mean: n ? sum / n : 0 } };
}

/** The decoder the luma adjustment assumes (bilinear chroma from siting type 0): the frame back as BT.2020 light per pixel, in the
 *  transfer's linear units, rgb interleaved. For the tests. */
export function decodeYuv420(planes, W, H, transfer = 'pq') {
  const cw = W / 2, chh = H / 2;
  const cbC = planes.subarray(W * H, W * H + cw * chh), crC = planes.subarray(W * H + cw * chh);
  const out = new Float64Array(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const [cb, cr] = upsampledChroma(cbC, crC, cw, chh, x, y);
      const { rgb } = rebuild(planes[y * W + x], cb, cr, transfer);
      out.set(rgb, (y * W + x) * 3);
    }
  }
  return out;
}

/**
 * The same encoder as WGSL compute passes (hdrEncode.js): `prime` per pixel, `chroma` per chroma sample, `luma` per pixel, `pack` per
 * output word (two 16-bit samples, Y plane then Cb then Cr, as ffmpeg's yuv420p10le holds them). Workgroups 16 × 16 (pack: 256).
 */
export const YUV_WGSL = /* wgsl */ `
struct P {
  w: u32, h: u32, W: u32, H: u32,
  cw: u32, ch: u32, transfer: u32, hybrid: u32,
  words: u32, adjust: u32, pad0: u32, pad1: u32,
};
@group(0) @binding(0) var<uniform> P_: P;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> prime: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> chroma: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> ycode: array<u32>;
@group(0) @binding(5) var<storage, read_write> outw: array<u32>;
@group(0) @binding(6) var<storage, read_write> stats: array<vec2<f32>>;

const KR: f32 = ${KR};
const KB: f32 = ${KB};
const KG: f32 = ${KG};
const CBD: f32 = ${CB_DIV};
const CRD: f32 = ${CR_DIV};
const PEAK: f32 = ${LIGHT_PEAK};
const M1: f32 = ${PQ.m1}; const M2: f32 = ${PQ.m2}; const C1: f32 = ${PQ.c1}; const C2: f32 = ${PQ.c2}; const C3: f32 = ${PQ.c3};
const HA: f32 = ${HLG.a}; const HB: f32 = ${HLG.b}; const HC: f32 = ${HLG.c};
const PQCAP: f32 = ${PQ_CAP};

fn pqOetf(y: f32) -> f32 {
  let p = pow(clamp(y, 0.0, 1.0), M1);
  return pow((C1 + C2 * p) / (1.0 + C3 * p), M2);
}
fn pqEotf(e: f32) -> f32 {
  let p = pow(clamp(e, 0.0, 1.0), 1.0 / M2);
  return pow(max(p - C1, 0.0) / (C2 - C3 * p), 1.0 / M1);
}
fn hlgOetf(e: f32) -> f32 {
  let x = clamp(e, 0.0, 1.0);
  if (x <= 1.0 / 12.0) { return sqrt(3.0 * x); }
  return HA * log(12.0 * x - HB) + HC;
}
fn hlgInv(s: f32) -> f32 {
  let x = clamp(s, 0.0, 1.0);
  if (x <= 0.5) { return x * x / 3.0; }
  return (exp((x - HC) / HA) + HB) / 12.0;
}
fn toLin(v: f32) -> f32 {
  if (!(v > 0.0)) { return 0.0; }
  if (v <= 0.04045) { return v / 12.92; }
  return pow((v + 0.055) / 1.055, 2.4);
}
fn hyb(v: f32) -> f32 {
  if (!(v > 0.0)) { return 0.0; }
  if (v <= 1.0) { return toLin(v); }
  return v;
}

// per pixel of the padded frame: R'G'B' and the luminance to rebuild; each workgroup's brightest component and its sum (in SDR whites)
var<workgroup> wgMax: array<f32, 256>;
var<workgroup> wgSum: array<f32, 256>;
@compute @workgroup_size(16, 16)
fn primeMain(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  var most = 0.0;
  if (g.x < P_.W && g.y < P_.H) {
    var c = vec3<f32>(0.0);
    let inside = g.x < P_.w && g.y < P_.h;
    if (inside) {
      let t = textureLoad(src, vec2<i32>(i32(g.x), i32(g.y)), 0).rgb;
      if (P_.hybrid == 1u) { c = vec3<f32>(hyb(t.r), hyb(t.g), hyb(t.b)); }
      else { c = vec3<f32>(select(0.0, t.r, t.r > 0.0), select(0.0, t.g, t.g > 0.0), select(0.0, t.b, t.b > 0.0)); }
    }
    let top = max(c.r, max(c.g, c.b));
    if (top > PEAK) { c = c * (PEAK / top); }
    var R = max(0.0, 0.627403895934699 * c.r + 0.329283038377884 * c.g + 0.043313065687417 * c.b);
    var G = max(0.0, 0.069097289358232 * c.r + 0.919540395075459 * c.g + 0.011362315566309 * c.b);
    var B = max(0.0, 0.016391438875150 * c.r + 0.088013307877226 * c.g + 0.895595253247624 * c.b);
    if (inside) { most = max(R, max(G, B)); }
    var o: vec4<f32>;
    if (P_.transfer == 1u) {
      let s = ${WHITE_NITS / HLG_PEAK_NITS};
      R = R * s; G = G * s; B = B * s;
      let yd = KR * R + KG * G + KB * B;
      var k = 0.0;
      if (yd > 0.0) { k = pow(yd, ${1 / HLG_GAMMA - 1}); }
      R = min(1.0, R * k); G = min(1.0, G * k); B = min(1.0, B * k);
      o = vec4<f32>(hlgOetf(R), hlgOetf(G), hlgOetf(B), KR * R + KG * G + KB * B);
    } else {
      let s = ${WHITE_NITS / 10000};
      R = R * s; G = G * s; B = B * s;
      o = vec4<f32>(pqOetf(R), pqOetf(G), pqOetf(B), KR * R + KG * G + KB * B);
    }
    prime[g.y * P_.W + g.x] = o;
  }
  wgMax[li] = most;
  wgSum[li] = most;
  workgroupBarrier();
  var step = 128u;
  loop {
    if (step == 0u) { break; }
    if (li < step) {
      wgMax[li] = max(wgMax[li], wgMax[li + step]);
      wgSum[li] = wgSum[li] + wgSum[li + step];
    }
    workgroupBarrier();
    step = step / 2u;
  }
  if (li == 0u) { stats[wg.y * nw.x + wg.x] = vec2<f32>(wgMax[0], wgSum[0]); }
}

fn cCode(v: f32) -> f32 { return clamp(round(512.0 + 896.0 * v), 64.0, 960.0); }

// per chroma sample: [1 2 1]/4 across (cosited on the even column), [1 1]/2 down (between the two rows), quantized
@compute @workgroup_size(16, 16)
fn chromaMain(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P_.cw || g.y >= P_.ch) { return; }
  var cb = 0.0;
  var cr = 0.0;
  for (var dx = -1; dx <= 1; dx = dx + 1) {
    let wx = select(0.25, 0.5, dx == 0);
    let x = u32(clamp(i32(2u * g.x) + dx, 0, i32(P_.W) - 1));
    for (var dy = 0u; dy < 2u; dy = dy + 1u) {
      let p = prime[(2u * g.y + dy) * P_.W + x];
      let y1 = KR * p.r + KG * p.g + KB * p.b;
      cb = cb + wx * 0.5 * ((p.b - y1) / CBD);
      cr = cr + wx * 0.5 * ((p.r - y1) / CRD);
    }
  }
  chroma[g.y * P_.cw + g.x] = vec2<f32>(cCode(cb), cCode(cr));
}

fn rebuild(code: f32, cb: f32, cr: f32) -> vec2<f32> {
  let y = (code - 64.0) / 876.0;
  let r1 = clamp(y + CRD * cr, 0.0, 1.0);
  let b1 = clamp(y + CBD * cb, 0.0, 1.0);
  let g1 = clamp((y - KR * (y + CRD * cr) - KB * (y + CBD * cb)) / KG, 0.0, 1.0);
  var R: f32; var G: f32; var B: f32;
  if (P_.transfer == 1u) { R = hlgInv(r1); G = hlgInv(g1); B = hlgInv(b1); }
  else { R = pqEotf(r1); G = pqEotf(g1); B = pqEotf(b1); }
  return vec2<f32>(KR * R + KG * G + KB * B, max(R, max(G, B)));
}

fn chromaAt(i: i32, j: i32) -> vec2<f32> {
  let ii = u32(clamp(i, 0, i32(P_.cw) - 1));
  let jj = u32(clamp(j, 0, i32(P_.ch) - 1));
  return chroma[jj * P_.cw + ii];
}

// per pixel: the Y' code whose rebuilt luminance is nearest the one meant, under the chroma the decoder will have; no component past the peak
@compute @workgroup_size(16, 16)
fn lumaMain(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P_.W || g.y >= P_.H) { return; }
  let p = prime[g.y * P_.W + g.x];
  if (P_.adjust == 0u) {
    ycode[g.y * P_.W + g.x] = u32(clamp(round(64.0 + 876.0 * (KR * p.r + KG * p.g + KB * p.b)), 64.0, 940.0));
    return;
  }
  let u = f32(g.x) / 2.0;
  let v = (f32(g.y) - 0.5) / 2.0;
  let i0 = i32(floor(u));
  let j0 = i32(floor(v));
  let fu = u - floor(u);
  let fv = v - floor(v);
  let c = (chromaAt(i0, j0) * (1.0 - fu) + chromaAt(i0 + 1, j0) * fu) * (1.0 - fv) + (chromaAt(i0, j0 + 1) * (1.0 - fu) + chromaAt(i0 + 1, j0 + 1) * fu) * fv;
  let cb = (c.x - 512.0) / 896.0;
  let cr = (c.y - 512.0) / 896.0;
  let want = p.a;
  var lo = 64.0;
  var hi = 941.0;
  if (rebuild(64.0, cb, cr).x > want) { hi = 65.0; }
  for (var k = 0; k < 11; k = k + 1) {
    if (hi - lo <= 1.0) { break; }
    let mid = floor((lo + hi) * 0.5);
    if (rebuild(mid, cb, cr).x <= want) { lo = mid; } else { hi = mid; }
  }
  var code = lo;
  if (lo < 940.0) {
    let a = rebuild(lo, cb, cr).x;
    let b = rebuild(lo + 1.0, cb, cr).x;
    if (abs(b - want) < abs(a - want)) { code = lo + 1.0; }
  }
  // the cap holds for a decoder that repeats each chroma sample too
  let n = chroma[(g.y / 2u) * P_.cw + (g.x / 2u)];
  let cbn = (n.x - 512.0) / 896.0;
  let crn = (n.y - 512.0) / 896.0;
  if (P_.transfer == 0u && (rebuild(code, cb, cr).y > PQCAP || rebuild(code, cbn, crn).y > PQCAP)) {
    var a = 64.0;
    var b = code;
    for (var k = 0; k < 11; k = k + 1) {
      if (b - a <= 1.0) { break; }
      let mid = floor((a + b) * 0.5);
      if (rebuild(mid, cb, cr).y <= PQCAP && rebuild(mid, cbn, crn).y <= PQCAP) { a = mid; } else { b = mid; }
    }
    code = a;
  }
  ycode[g.y * P_.W + g.x] = u32(code);
}

fn sampleAt(s: u32) -> u32 {
  let ny = P_.W * P_.H;
  let nc = P_.cw * P_.ch;
  if (s < ny) { return ycode[s]; }
  if (s < ny + nc) { return u32(chroma[s - ny].x); }
  if (s < ny + 2u * nc) { return u32(chroma[s - ny - nc].y); }
  return 0u;
}

// per output word: two 16-bit samples, little end first
@compute @workgroup_size(256)
fn packMain(@builtin(global_invocation_id) g: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let k = g.y * nw.x * 256u + g.x;
  if (k >= P_.words) { return; }
  outw[k] = (sampleAt(2u * k) & 0xffffu) | ((sampleAt(2u * k + 1u) & 0xffffu) << 16u);
}
`;
