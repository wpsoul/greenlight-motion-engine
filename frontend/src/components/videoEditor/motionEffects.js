/*
 * Motion Effects — ported from html/motion-effects-lookdev.html (the look-dev
 * prototype is the source of truth for every constant in here; tune there first).
 *
 * These are the first effects to use the DECLARATIVE MULTI-PASS form: a descriptor
 * may carry `passes: [{ key, target, inputs, fragment, main?, set?, skipIf?, alias? }]`
 * instead of a single `fragment`, and Player.runEffectChain walks them, binding each
 * pass's named inputs to earlier pass targets from a scratch pool. Buffers available
 * to `inputs`: 'source' (this effect's input) and 'matte' (the isolated layer's alpha
 * in layer scope; the effect's own input in adjustment scope), plus any earlier
 * pass's `target`. The pass marked `main` writes the effect's output and is the only
 * one crossfaded by uMix, so mix 0 stays an exact bypass however many passes ran.
 *
 * `set(params, { ref })` writes pass-internal scalars into uParams[24..27] — the same
 * reserved slots the blur pyramid uses. ref = height / 1080, the reference scale every
 * px-authored radius is expressed in.
 */

// Lines Draw speed profiles (leaf module — no cycle: → easingCurves → types).
import { LINES_DRAW_PROFILE_OPTIONS } from './linesDrawProfiles.js';

// mode 0 = premultiplied RGBA, 1 = .r only, 2 = alpha only (as vec4(a))
const BLUR_FX = /* glsl */ `
vec4 fx(vec2 uv){
  float r = uParams[26];
  float mode = uParams[27];
  if (r < 0.01) return texture2D(uTexture, uv);
  vec2 step_ = vec2(uParams[24], uParams[25]) / uResolution;
  float taps = uQuality < 0.75 ? 12.0 : 20.0;
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i < 41; i++){
    float fi = float(i) - 20.0;
    if (abs(fi) > taps) continue;
    float t = fi / taps;
    float w = exp(-2.2 * t * t);
    vec2 suv = uv + step_ * (t * r);
    vec4 s = sampleClamped(uTexture, suv);
    if (mode > 0.5 && mode < 1.5) s = vec4(s.r);
    else if (mode > 1.5) s = vec4(s.a);
    acc += s * w;
    ws += w;
  }
  return acc / max(ws, 1e-4);
}
`;

// Separable box morphology on alpha. 26 = radius px, 27 = +1 erode / -1 dilate.
const MORPH_FX = /* glsl */ `
vec4 fx(vec2 uv){
  vec4 c = texture2D(uTexture, uv);
  float r = uParams[26];
  if (r < 0.01) return c;
  vec2 step_ = vec2(uParams[24], uParams[25]) / uResolution;
  float erode = uParams[27];
  // Tap count follows the radius so the step stays sub-pixel: a fixed count turns a
  // wide dilation into a staircase (the same lesson as the separable gaussians).
  float taps = clamp(r * (uQuality < 0.75 ? 0.5 : 1.0), 6.0, 24.0);
  if (erode > 0.0){
    float acc = 1.0;
    for (int i = 0; i < 49; i++){
      float fi = float(i) - 24.0;
      if (abs(fi) > taps) continue;
      vec2 suv = uv + step_ * (fi / taps * r);
      float a = (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0)
        ? 0.0 : texture2D(uTexture, suv).a;
      acc = min(acc, a);
    }
    return vec4(c.rgb, acc);
  }
  // Dilate: the winning sample carries its COLOUR with it. Growing alpha alone left
  // the new band with the transparent source's rgb (which unpremultiplies to black),
  // so a grown matte came back as a black fringe patched with ghost glyph fragments.
  vec4 best = c;
  for (int i = 0; i < 49; i++){
    float fi = float(i) - 24.0;
    if (abs(fi) > taps) continue;
    vec2 suv = uv + step_ * (fi / taps * r);
    vec4 sm = (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0)
      ? vec4(0.0) : texture2D(uTexture, suv);
    if (sm.a > best.a) best = sm;
  }
  return best;
}
`;

// Jump-flood coordinate packing (Animated Outline Bands). Coordinates are
// packed 16-bit across two RGBA8 channels (hi = floor(v·255)/255, lo =
// fract(v·255)) so WebGL1 needs no float targets; vec4(1.0) is the "no seed
// yet" sentinel — it decodes past 1.0, which no real coordinate can.
const JFA_LIB = /* glsl */ `
vec4 jfaEnc(vec2 uv){
  vec2 q = clamp(uv, 0.0, 1.0) * 255.0;
  return vec4(floor(q.x) / 255.0, fract(q.x), floor(q.y) / 255.0, fract(q.y));
}
vec2 jfaDec(vec4 e){
  return vec2(floor(e.x * 255.0 + 0.5) + e.y, floor(e.z * 255.0 + 0.5) + e.w) / 255.0;
}
`;

// Preset ramps, in the CSS-gradient form the picker reads and writes.
const RAMPS = {
  midnightMint: 'linear-gradient(90deg, #05121f 0%, #1b6f6a 45%, #7dd3c0 78%, #f4fff9 100%)',
  thermal: 'linear-gradient(90deg, #000010 0%, #5b0b8a 25%, #e0355a 50%, #ffb020 75%, #fffbe6 100%)',
  sunsetMetal: 'linear-gradient(90deg, #1a1026 0%, #7b3fa0 35%, #ff7a3c 60%, #ffd98a 85%, #2b1a33 100%)',
  infrared: 'linear-gradient(90deg, #04030a 0%, #1946c8 40%, #12d1b0 62%, #f3ec4a 82%, #ff2d2d 100%)',
  candyChrome: 'linear-gradient(90deg, #0b0c18 0%, #5468ff 20%, #ff8ad4 45%, #ffe9a8 70%, #0b0c18 100%)',
  blueprint: 'linear-gradient(90deg, #06183a 0%, #12417e 55%, #7fb2ff 80%, #eaf3ff 100%)',
  // Outline Bands ramps — colour across the band field, near edge → far.
  bandsDefault: 'linear-gradient(90deg, #7dd3c0 0%, #2f7cff 60%, #10131c 100%)',
  bandsTopo: 'linear-gradient(90deg, #c9b48a 0%, #7a8a6a 50%, #33413f 100%)',
  bandsSonar: 'linear-gradient(90deg, #63ffc9 0%, #0a2e24 100%)',
  bandsEnergy: 'linear-gradient(90deg, #ffffff 0%, #b95cff 40%, #1a0b2e 100%)',
  bandsSticker: 'linear-gradient(90deg, #ffffff 0%, #ff5c8a 100%)',
  bandsBlueprint: 'linear-gradient(90deg, #7fb2ff 0%, #12417e 100%)',
  bandsHeat: 'linear-gradient(90deg, #fffbe6 0%, #ffb020 40%, #e0355a 75%, #5b0b8a 100%)',
};

/* ── Edge Detect (ported from html/edge-detect-lab.html) ──────────────────────
   Four detectors write one single-channel edge mask; thickness, color, glow and
   animation are one shared pipeline over that mask and never know which detector
   ran. The lab's Backdrop group is deliberately GONE: a chain effect composites
   over its own layer, so the backdrop IS the source, shown at sourceLevel 0-100%.

   Pool discipline: every pass carries an explicit poolSlot so the whole graph
   (up to 16 declared passes, at most ~9 executed) lives in 6 full-res targets
   plus 2 half-res glow targets. Slots 1 (blurred luma), 3 (second DoG blur),
   4 (gradient field) and 5 (raw mask) stay live until the pass that consumes
   them; slots 0 and 2 ping-pong the transients (blur intermediates, Canny
   linking, dilation). */

// Pre-blur sigma: XDoG owns its own blur pair, the other detectors share preBlur.
const edSigA = (p) => (Math.round(p.method) === 2 ? p.dogSigma : p.preBlur);

// Gradient field. Operators are normalized so |gx|,|gy| <= 1 exactly, then packed
// *0.5+0.5 into RG with magnitude/sqrt2 in B — the pass pool is RGBA8, so signed
// values must ride in 0..1. Border taps clamp to the edge pixel (not to zero):
// a zero border would draw the frame outline as an edge in adjustment scope.
const ED_GRAD_FX = /* glsl */ `
vec2 edClampUv(vec2 q, vec2 px){ return clamp(q, px * 0.5, vec2(1.0) - px * 0.5); }
float edL(vec2 q, vec2 px){ return luma(texture2D(uTexture, edClampUv(q, px)).rgb); }
vec4 fx(vec2 uv){
  vec2 px = 1.0 / uResolution;
  float tl = edL(uv + vec2(-px.x,  px.y), px);
  float tc = edL(uv + vec2( 0.0,   px.y), px);
  float tr = edL(uv + vec2( px.x,  px.y), px);
  float ml = edL(uv + vec2(-px.x,  0.0), px);
  float mr = edL(uv + vec2( px.x,  0.0), px);
  float bl = edL(uv + vec2(-px.x, -px.y), px);
  float bc = edL(uv + vec2( 0.0,  -px.y), px);
  float br = edL(uv + vec2( px.x, -px.y), px);
  float op = uParams[1];
  vec2 w = op < 0.5 ? vec2(0.25, 0.5) : (op < 1.5 ? vec2(0.1875, 0.625) : vec2(1.0 / 3.0, 1.0 / 3.0));
  float gx = w.x * (tr - tl) + w.y * (mr - ml) + w.x * (br - bl);
  float gy = w.x * (tl - bl) + w.y * (tc - bc) + w.x * (tr - br);
  float mag = length(vec2(gx, gy)) * 0.70710678;
  return vec4(gx * 0.5 + 0.5, gy * 0.5 + 0.5, mag, 1.0);
}
`;

// The four detectors, one fragment. uTexture = gradient field, uTexture1 = the
// pre-blurred source, uTexture2 = the second (wider) DoG blur. Canny here is
// NMS + double threshold; the weak/strong resolution is the link passes' job.
const ED_EDGE_FX = /* glsl */ `
vec2 edClampUv(vec2 q, vec2 px){ return clamp(q, px * 0.5, vec2(1.0) - px * 0.5); }
float edLA(vec2 q){ return luma(texture2D(uTexture1, q).rgb); }
float edTanh(float x){
  float t = exp(2.0 * clamp(x, -8.0, 8.0));
  return (t - 1.0) / (t + 1.0);
}
vec4 fx(vec2 uv){
  vec2 px = 1.0 / uResolution;
  float method = uParams[0];
  float th = uParams[2] / 100.0 * 0.7;
  float e = 0.0;
  if (method < 0.5){
    // Gradient: magnitude through a soft knee.
    float mag = texture2D(uTexture, uv).b * 1.41421356;
    float k = uParams[3] / 100.0;
    e = smoothstep(th * (1.0 - k), th * (1.0 + k) + 0.003, mag);
  } else if (method < 1.5){
    // Canny: keep a pixel only if it beats both neighbours ALONG its own
    // gradient direction, then split survivors strong (1) / weak (0.5).
    vec4 g = texture2D(uTexture, uv);
    float m = g.b;
    if (m >= 1e-4){
      vec2 dn = normalize(g.rg * 2.0 - 1.0);
      vec2 sp = floor(dn + 0.5);
      float m1 = texture2D(uTexture, edClampUv(uv + sp * px, px)).b;
      float m2 = texture2D(uTexture, edClampUv(uv - sp * px, px)).b;
      if (m >= m1 && m > m2 - 1e-6){
        float mm = m * 1.41421356;
        float lo = th * uParams[4] / 100.0;
        e = mm >= th ? 1.0 : (mm >= lo ? 0.5 : 0.0);
      }
    }
  } else if (method < 2.5){
    // XDoG: tone reducer whose survivors are strokes — keeps hatching/shading.
    float a = edLA(uv);
    float b = luma(texture2D(uTexture2, uv).rgb);
    float S = (1.0 + uParams[5]) * a - uParams[5] * b;
    float eps = uParams[7] * 0.002;
    float T = S >= eps ? 1.0 : 1.0 + edTanh(uParams[6] * (S - eps));
    e = clamp(1.0 - T, 0.0, 1.0);
  } else {
    // Contour bands: level sets of the luminance. Compare only the right and
    // upper neighbour so the line is one pixel, not two.
    float bands = max(floor(uParams[8] + 0.5), 2.0);
    float q  = floor(clamp(edLA(uv), 0.0, 0.9999) * bands);
    float qr = floor(clamp(edLA(edClampUv(uv + vec2(px.x, 0.0), px)), 0.0, 0.9999) * bands);
    float qu = floor(clamp(edLA(edClampUv(uv + vec2(0.0, px.y), px)), 0.0, 0.9999) * bands);
    e = (abs(qr - q) > 0.5 || abs(qu - q) > 0.5) ? 1.0 : 0.0;
  }
  return vec4(e);
}
`;

// Canny hysteresis by iteration: a weak pixel touching a strong one becomes
// strong; each pass grows chains by one pixel. uParams[27] = 1 on the final
// pass, which deletes whatever weak pixels were never rescued.
const ED_LINK_FX = /* glsl */ `
vec4 fx(vec2 uv){
  vec2 px = 1.0 / uResolution;
  float v = texture2D(uTexture, uv).r;
  if (v > 0.25 && v < 0.75){
    float mx = 0.0;
    for (int dy = -1; dy <= 1; dy++){
      for (int dx = -1; dx <= 1; dx++){
        vec2 q = clamp(uv + px * vec2(float(dx), float(dy)), px * 0.5, vec2(1.0) - px * 0.5);
        mx = max(mx, texture2D(uTexture, q).r);
      }
    }
    if (mx > 0.75) v = 1.0;
    else if (uParams[27] > 0.5) v = 0.0;
  }
  return vec4(v);
}
`;

// Composite. uTexture1 = final mask, uTexture2 = half-res glow, uTexture3 = the
// gradient field (Direction-hue coloring reads the edge ANGLE per pixel).
const ED_MAIN_FX = /* glsl */ `
vec3 edHue(float h){
  vec3 p3 = abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0);
  return clamp(p3 - 1.0, 0.0, 1.0);
}
float edVN(vec2 p3){
  vec2 i = floor(p3), f = fract(p3);
  vec2 u2 = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u2.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u2.x), u2.y);
}
vec4 fx(vec2 uv){
  vec4 src = texture2D(uSource, uv);
  vec3 srcC = unpremult(src);
  float srcLum = luma(srcC);

  float anim = uParams[15];
  // Speed scales the animation clock: time-driven modes multiply uTime, the
  // progress-driven sweeps (Draw On / Scanner) complete in 1/speed of the clip.
  float spd = max(uParams[18], 0.01);
  // The sweep coordinate lives in the LAYER's own box, so a draw-on rides the
  // layer; adjustment scope collapses fxLocal to the frame.
  vec2 p = fxLocal(uv);
  float ang = radians(uParams[16]);
  vec2 axis = vec2(cos(ang), sin(ang));
  float asp = fxAspect();
  float span = 0.5 * (abs(axis.x) * asp + abs(axis.y)) + 1e-5;
  float sweep = dot((p - 0.5) * vec2(asp, 1.0), axis) / (2.0 * span) + 0.5;

  // Line boil re-samples the mask through a time-stepped noise field, so the
  // strokes wobble hand-drawn without the detector rerunning.
  vec2 euv = uv;
  if (anim > 4.5){
    float bt = floor(uTime * 8.0 * spd);
    float n1 = edVN(p * 14.0 + bt * 7.13);
    float n2 = edVN(p * 14.0 + 91.7 - bt * 3.31);
    euv = uv + (vec2(n1, n2) - 0.5) * (3.5 / uResolution);
  }
  float eRaw = texture2D(uTexture1, euv).r;
  if (uParams[11] > 0.5) eRaw = 1.0 - eRaw;
  float e = clamp(eRaw * uParams[9] / 100.0, 0.0, 1.0);
  float g = texture2D(uTexture2, euv).r * uParams[13] / 100.0;

  float show = 1.0;
  float scan = 0.0;
  if (anim > 0.5 && anim < 1.5){
    float s2 = uParams[17] / 100.0 + 0.02;
    float pp = mix(-s2, 1.0 + s2, clamp(uProgress * spd, 0.0, 1.0));
    show = 1.0 - smoothstep(pp - s2, pp + s2, sweep);
  } else if (anim > 1.5 && anim < 2.5){
    float s = sweep - (clamp(uProgress * spd, 0.0, 1.0) * 1.1 - 0.05);
    show = s < 0.0 ? 1.0 : 0.0;
    scan = exp(-abs(s) * 90.0);
  } else if (anim > 2.5 && anim < 3.5){
    // Quantised playhead tick, not a clock: export renders the same flicker.
    float f = hash21(vec2(floor(uTime * 24.0 * spd), 7.0));
    show = 0.45 + 0.55 * f * f;
  } else if (anim > 3.5 && anim < 4.5){
    g *= 0.55 + 0.45 * sin(uTime * 3.5 * spd);
  }
  e *= show;
  g *= show;

  vec3 col;
  float cm = uParams[10];
  if (cm < 0.5) col = uColors[0];
  else if (cm < 1.5) col = clamp(pow(srcC, vec3(0.6)) * 1.25, 0.0, 1.0);
  else if (cm < 2.5){
    vec2 gv = texture2D(uTexture3, uv).rg * 2.0 - 1.0;
    col = edHue(fract(atan(gv.y, gv.x) / 6.2831853 + 0.5));
  } else col = mix(uColors[1], uColors[0], smoothstep(0.15, 0.85, srcLum));
  vec3 gcol = (cm > 1.5 && cm < 2.5) ? col : uColors[0];

  // The lab's Backdrop group, reduced to one number: the original source under
  // the edges at 0-100%. Premultiplied scale, so alpha dims with it and 0 is
  // genuinely transparent in layer scope.
  float srcLevel = uParams[12] / 100.0;
  vec4 base = src * srcLevel;
  // Ahead of the scanner line the untouched original stays; behind it converts.
  if (anim > 1.5 && anim < 2.5) base = mix(src, base, show);

  float blend = uParams[14];
  vec3 edgeC = col * e;
  vec3 rgb;
  float a;
  if (blend < 0.5){
    rgb = edgeC + base.rgb * (1.0 - e);
    a = e + base.a * (1.0 - e);
  } else if (blend < 1.5){
    rgb = base.rgb + edgeC;
    a = base.a + e;
  } else {
    rgb = vec3(1.0) - (vec3(1.0) - base.rgb) * (vec3(1.0) - edgeC);
    a = base.a + e * (1.0 - base.a);
  }
  rgb += gcol * g;
  a += g * 0.8;
  rgb += scan * (gcol * 0.85 + 0.15);
  a += scan * 0.5;
  return vec4(clamp(rgb, 0.0, 1.0), clamp(a, 0.0, 1.0));
}
`;

export const MOTION_EFFECTS = [
  {
    id: 'turbulentDisplace',
    name: 'Turbulent Displace',
    group: 'Distortion',
    scopes: ['layer', 'adjustment'],
    animated: true,
    layerMatte: 'expand',
    params: [
      { key: 'amountX', slot: 0, label: 'Amount X', min: -300, max: 300, step: 1, default: 46, suffix: 'px' },
      { key: 'amountY', slot: 1, label: 'Amount Y', min: -300, max: 300, step: 1, default: 46, suffix: 'px' },
      { key: 'size', slot: 2, label: 'Size', min: 5, max: 500, step: 1, default: 150, suffix: 'px' },
      { key: 'complexity', slot: 3, label: 'Complexity', min: 1, max: 6, step: 1, default: 3 },
      { key: 'evolution', slot: 4, label: 'Evolution', min: 0, max: 1440, step: 1, default: 0, suffix: '\u00b0' },
      { key: 'evolutionSpeed', slot: 5, label: 'Evo Speed', min: 0, max: 3, step: 0.05, default: 0.6, suffix: 'x' },
      { key: 'turbulence', slot: 6, label: 'Turbulence', type: 'select', default: 0, options: [
        { value: 0, label: 'Smooth' }, { value: 1, label: 'Billow' },
        { value: 2, label: 'Ridged' }, { value: 3, label: 'Swirl' }] },
      { key: 'direction', slot: 7, label: 'Direction', min: 0, max: 360, step: 1, default: 0, suffix: '\u00b0' },
      { key: 'pinEdges', slot: 8, label: 'Pin Edges', min: 0, max: 100, step: 1, default: 32, suffix: '%' },
      // 'Imported' from the prototype needs a media picker and a third texture unit;
      // procedural and luminance cover the design uses.
      { key: 'map', slot: 9, label: 'Map', type: 'select', default: 0, options: [
        { value: 0, label: 'Procedural' }, { value: 1, label: 'Luminance' }] },
      { key: 'seed', slot: 10, label: 'Seed', min: 0, max: 99, step: 1, default: 7 },
    ],
    colorPresets: [
      { name: 'Liquid Type', colors: [], params: { amountX: 34, amountY: 52, size: 190, complexity: 3, evolutionSpeed: 0.5, turbulence: 0, direction: 0, pinEdges: 28, seed: 7 } },
      { name: 'Heat Haze', colors: [], params: { amountX: 12, amountY: 22, size: 70, complexity: 4, evolutionSpeed: 1.4, turbulence: 0, direction: 90, pinEdges: 40, seed: 21 } },
      { name: 'Soft Flag', colors: [], params: { amountX: 8, amountY: 74, size: 420, complexity: 2, evolutionSpeed: 0.35, turbulence: 0, direction: 0, pinEdges: 55, seed: 3 } },
      { name: 'Electric Edge', colors: [], params: { amountX: 26, amountY: 26, size: 34, complexity: 5, evolutionSpeed: 2.4, turbulence: 2, direction: 0, pinEdges: 20, seed: 44 } },
      { name: 'Underwater', colors: [], params: { amountX: 60, amountY: 44, size: 240, complexity: 3, evolutionSpeed: 0.5, turbulence: 3, direction: 0, pinEdges: 34, seed: 12 } },
      { name: 'Paper Breathing', colors: [], params: { amountX: 16, amountY: 16, size: 320, complexity: 2, evolutionSpeed: 0.18, turbulence: 1, direction: 0, pinEdges: 46, seed: 9 } },
    ],
    fragment: /* glsl */ `
float tdVal(vec2 p, float seed){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i + seed);
  float b = hash21(i + vec2(1.0, 0.0) + seed);
  float c = hash21(i + vec2(0.0, 1.0) + seed);
  float d = hash21(i + vec2(1.0, 1.0) + seed);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float tdFbm(vec2 p, float seed, float oct, float type){
  float v = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 6; i++){
    if (float(i) >= oct) break;
    float n = tdVal(p, seed + float(i) * 19.7);
    if (type > 0.5 && type < 1.5) n = abs(n * 2.0 - 1.0);            // billow
    else if (type > 1.5 && type < 2.5) n = 1.0 - abs(n * 2.0 - 1.0); // ridged
    v += n * amp;
    norm += amp;
    p = p * 2.03 + 7.1;
    amp *= 0.5;
  }
  return v / max(norm, 1e-4);
}
vec2 tdField(vec2 uv){
  // Noise is sampled in the layer's own pixel grid, so the turbulence is printed
  // on the artwork and travels with it instead of being a field it slides through.
  float ref = fxRes().y / 1080.0;
  float size = max(uParams[2], 2.0) * ref;
  float oct = max(1.0, floor(uParams[3] + 0.5));
  if (uQuality < 0.75) oct = max(1.0, oct - 2.0);   // preview: fewer octaves, same timing
  float type = uParams[6];
  float seed = uParams[10] * 13.37;
  float evo = uParams[4] + uTime * uParams[5] * 90.0;
  vec2 eo = vec2(0.37, -0.61) * (evo / 360.0) * 2.0;
  vec2 p = fxCoord(uv) / size + eo;

  vec2 d;
  if (type > 2.5){
    // Swirl = curl of a scalar potential, so the field is divergence free and
    // the source rotates instead of smearing.
    float e = 0.55;
    float n1 = tdFbm(p + vec2(0.0, e), seed, oct, 0.0);
    float n2 = tdFbm(p - vec2(0.0, e), seed, oct, 0.0);
    float n3 = tdFbm(p + vec2(e, 0.0), seed, oct, 0.0);
    float n4 = tdFbm(p - vec2(e, 0.0), seed, oct, 0.0);
    d = vec2(n1 - n2, -(n3 - n4)) * 3.2;
  } else {
    d = vec2(
      tdFbm(p, seed, oct, type) - 0.5,
      tdFbm(p + 41.7, seed + 91.3, oct, type) - 0.5
    ) * 2.0;
  }

  float mapMode = uParams[9];
  if (mapMode > 0.5 && mapMode < 1.5){
    // Luminance map: displace along the gradient of the source's own brightness.
    vec2 px = 1.5 / uResolution;
    float lx = luma(unpremult(texture2D(uTexture, uv + vec2(px.x, 0.0))))
             - luma(unpremult(texture2D(uTexture, uv - vec2(px.x, 0.0))));
    float ly = luma(unpremult(texture2D(uTexture, uv + vec2(0.0, px.y))))
             - luma(unpremult(texture2D(uTexture, uv - vec2(0.0, px.y))));
    d = vec2(lx, ly) * 5.0;
  } else if (mapMode > 1.5){
    d = (texture2D(uTexture3, uv).rg - 0.5) * 2.0;
  }

  d = rot2(radians(uParams[7])) * d;
  vec2 disp = d * vec2(uParams[0], uParams[1]) * ref;

  float pin = clamp(uParams[8] / 100.0, 0.0, 1.0);
  if (pin > 0.001){
    float e = 0.5 * pin;
    vec2 lp = fxLocal(uv);
    disp *= smoothstep(0.0, e, lp.x) * smoothstep(0.0, e, 1.0 - lp.x)
          * smoothstep(0.0, e, lp.y) * smoothstep(0.0, e, 1.0 - lp.y);
  }
  return disp;
}
vec4 fx(vec2 uv){
  return sampleClamped(uTexture, uv + fxDir(tdField(uv) / fxRes()));
}
`,
  },

  {
    id: 'alphaChoker',
    name: 'Alpha Choker + Feather',
    group: 'Matte',
    // Layer-only by design: it reshapes a layer's own matte, which an adjustment
    // layer (whose input is the opaque below-stack) has nothing to do with.
    scopes: ['layer'],
    animated: false,
    layerMatte: 'expand',
    params: [
      { key: 'choke', slot: 0, label: 'Choke', min: -50, max: 50, step: 0.5, default: 0, suffix: 'px' },
      { key: 'feather', slot: 1, label: 'Feather', min: 0, max: 60, step: 0.5, default: 4, suffix: 'px' },
      { key: 'featherBias', slot: 2, label: 'Feather Bias', min: -100, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'edgeContrast', slot: 3, label: 'Edge Contrast', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'decontaminate', slot: 4, label: 'Decontaminate', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'matteView', slot: 5, label: 'Matte View', type: 'select', default: 0, options: [
        { value: 0, label: 'Off' }, { value: 1, label: 'Matte' }, { value: 2, label: 'Edge delta' }] },
    ],
    colorPresets: [
      { name: 'Clean Cutout', colors: [], params: { choke: 1.5, feather: 1.5, featherBias: 20, edgeContrast: 65, decontaminate: 45, matteView: 0 } },
      { name: 'Soft Sticker', colors: [], params: { choke: -9, feather: 4, featherBias: 45, edgeContrast: 80, decontaminate: 60, matteView: 0 } },
      { name: 'Ink Spread', colors: [], params: { choke: -22, feather: 16, featherBias: 30, edgeContrast: 25, decontaminate: 85, matteView: 0 } },
      { name: 'Tight Type', colors: [], params: { choke: 3.5, feather: 0.5, featherBias: 0, edgeContrast: 90, decontaminate: 20, matteView: 0 } },
      { name: 'Mist Edge', colors: [], params: { choke: -4, feather: 34, featherBias: -35, edgeContrast: 0, decontaminate: 30, matteView: 0 } },
    ],
    passes: [
      { key: 'morphX', target: 'cA', inputs: { uTexture: 'source' }, fragment: MORPH_FX,
        skipIf: (p) => Math.abs(p.choke) < 0.05, alias: 'source',
        set: (p, ctx) => ({ 24: 1, 25: 0, 26: Math.abs(p.choke) * ctx.ref, 27: p.choke > 0 ? 1 : -1 }) },
      { key: 'morphY', target: 'cB', inputs: { uTexture: 'cA' }, fragment: MORPH_FX,
        skipIf: (p) => Math.abs(p.choke) < 0.05, alias: 'cA',
        set: (p, ctx) => ({ 24: 0, 25: 1, 26: Math.abs(p.choke) * ctx.ref, 27: p.choke > 0 ? 1 : -1 }) },
      { key: 'featherX', target: 'cC', inputs: { uTexture: 'cB' }, fragment: BLUR_FX,
        skipIf: (p) => p.feather < 0.05, alias: 'cB',
        set: (p, ctx) => ({ 24: 1, 25: 0, 26: p.feather * ctx.ref, 27: 2 }) },
      { key: 'featherY', target: 'cD', inputs: { uTexture: 'cC' }, fragment: BLUR_FX,
        skipIf: (p) => p.feather < 0.05, alias: 'cC',
        set: (p, ctx) => ({ 24: 0, 25: 1, 26: p.feather * ctx.ref, 27: 2 }) },
      { key: 'main', target: 'out', main: true, inputs: { uSource: 'source', uTexture1: 'cD', uTexture2: 'cB' }, fragment: /* glsl */ `
vec4 fx(vec2 uv){
  vec4 s = texture2D(uSource, uv);
  float m = clamp(texture2D(uTexture1, uv).a, 0.0, 1.0);

  float bias = clamp(uParams[2] / 100.0, -1.0, 1.0);
  m = pow(m, exp(-bias * 1.6));
  float ec = clamp(uParams[3] / 100.0, 0.0, 1.0);
  if (ec > 0.001){
    float w = mix(0.5, 0.015, ec);
    m = mix(m, smoothstep(0.5 - w, 0.5 + w, m), ec);
  }

  // Where the matte grew there is no source colour, so take it from the colour-
  // dilated plate (cB) — the nearest real pixel, carried outward by the morphology.
  vec4 grown = texture2D(uTexture2, uv);
  vec3 col = s.a > 0.02 ? unpremult(s) : unpremult(grown);
  float dec = clamp(uParams[4] / 100.0, 0.0, 1.0);
  // Where the matte grew past the original alpha there is no colour to keep, so
  // pull it inward along the matte gradient. The same march replaces spill-
  // contaminated edge colour with genuinely interior colour. One short tap was
  // not enough to reach past a wide fringe, so march until a solid sample lands.
  float ref = uResolution.y / 1080.0;
  vec2 px = 1.0 / uResolution;
  float span = max(2.0, (abs(uParams[0]) + uParams[1]) * ref);
  float gx = texture2D(uTexture1, uv + vec2(px.x, 0.0) * span).a
           - texture2D(uTexture1, uv - vec2(px.x, 0.0) * span).a;
  float gy = texture2D(uTexture1, uv + vec2(0.0, px.y) * span).a
           - texture2D(uTexture1, uv - vec2(0.0, px.y) * span).a;
  vec2 g = vec2(gx, gy);
  float glen = length(g);
  if (glen > 1e-4 && dec > 0.001){
    vec2 inward = g / glen;
    vec3 clean = col;
    float found = 0.0;
    for (int i = 1; i <= 5; i++){
      float dist = span + float(i) / 5.0 * (6.0 + dec * 46.0) * ref;
      vec4 inner = texture2D(uSource, clamp(uv + inward * px * dist, vec2(0.001), vec2(0.999)));
      if (found < 0.5 && inner.a > 0.9){ clean = unpremult(inner); found = 1.0; }
    }
    float wgt = clamp(dec * clamp(s.a, 0.0, 1.0), 0.0, 1.0) * found;
    col = mix(col, clean, wgt);
  }

  float view = uParams[5];
  if (view > 0.5 && view < 1.5) return vec4(vec3(m), 1.0);
  if (view > 1.5) return vec4(vec3(clamp(abs(m - s.a) * 3.0, 0.0, 1.0)), 1.0);
  return premult(col, m);
}
` },
    ],
  },

  // AE's Extract, ported from html/extract-lab.html. A RANGE key: pick a channel,
  // keep the values inside [black, white], feather the two ends with their own
  // softness, optionally invert. Everything under "matte shaping" is what AE makes
  // you stack extra effects for. The panel draws a live histogram of this effect's
  // INPUT with the four range handles on it (usesHistogram, below).
  {
    id: 'extract',
    name: 'Extract (Histogram Key)',
    group: 'Matte',
    scopes: ['layer', 'adjustment'],
    animated: false,
    layerMatte: 'clip',
    // Names the params the histogram widget reads and drags. The panel renders the
    // scope's real input into a probe target to build the bins — see HistogramField.
    usesHistogram: {
      channel: 'exChannel',
      black: 'exBlack',
      blackSoft: 'exBlackSoft',
      white: 'exWhite',
      whiteSoft: 'exWhiteSoft',
    },
    params: [
      { key: 'exChannel', slot: 0, label: 'Channel', type: 'select', primary: true, default: 0, options: [
        { value: 0, label: 'Luminance' }, { value: 1, label: 'Red' }, { value: 2, label: 'Green' },
        { value: 3, label: 'Blue' }, { value: 4, label: 'Alpha' }, { value: 5, label: 'Max RGB' },
        { value: 6, label: 'Saturation' }] },
      { key: 'exBlack', slot: 1, label: 'Black Point', min: 0, max: 255, step: 1, default: 0 },
      { key: 'exBlackSoft', slot: 2, label: 'Black Softness', min: 0, max: 255, step: 1, default: 0 },
      { key: 'exWhite', slot: 3, label: 'White Point', min: 0, max: 255, step: 1, default: 255 },
      { key: 'exWhiteSoft', slot: 4, label: 'White Softness', min: 0, max: 255, step: 1, default: 0 },
      { key: 'exInvert', slot: 5, label: 'Extraction', type: 'select', default: 0, options: [
        { value: 0, label: 'Keep the range' }, { value: 1, label: 'Remove the range' }] },
      { key: 'exGamma', slot: 6, label: 'Alpha Gamma', min: -100, max: 100, step: 1, default: 0 },
      { key: 'exBlur', slot: 7, label: 'Matte Blur', min: 0, max: 40, step: 0.5, default: 0, suffix: 'px' },
      { key: 'exChoke', slot: 8, label: 'Choke', min: -100, max: 100, step: 1, default: 0 },
      { key: 'exEdge', slot: 9, label: 'Edge Contrast', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'exBoost', slot: 12, label: 'Unpremult Boost', min: 0, max: 200, step: 1, default: 0, suffix: '%' },
      { key: 'exTintAmt', slot: 11, label: 'Tint Amount', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'exTint', type: 'color', label: 'Tint', default: '#7dd3c0' },
      { key: 'exKeepAlpha', slot: 13, label: 'Source Alpha', type: 'select', default: 1, options: [
        { value: 1, label: 'Multiply (keep cutout)' }, { value: 0, label: 'Ignore' }] },
      { key: 'exView', slot: 10, label: 'Matte View', type: 'select', default: 0, options: [
        { value: 0, label: 'Off' }, { value: 1, label: 'Matte' }, { value: 2, label: 'Channel' }] },
    ],
    colorPresets: [
      { name: 'Smoke off Black', colors: [], params: { exChannel: 0, exBlack: 18, exBlackSoft: 62, exWhite: 255, exWhiteSoft: 0, exInvert: 0, exGamma: 10, exBlur: 0, exChoke: 0, exEdge: 0, exBoost: 0, exView: 0 } },
      { name: 'Type off Plate', colors: [], params: { exChannel: 0, exBlack: 96, exBlackSoft: 30, exWhite: 255, exWhiteSoft: 0, exInvert: 0, exGamma: 20, exBlur: 0.5, exChoke: 10, exEdge: 55, exView: 0 } },
      { name: 'Highlights Only', colors: [], params: { exChannel: 0, exBlack: 205, exBlackSoft: 34, exWhite: 255, exWhiteSoft: 0, exInvert: 0, exGamma: -20, exBlur: 0, exChoke: 0, exEdge: 0, exView: 0 } },
      { name: 'Fire Core', colors: [], params: { exChannel: 5, exBlack: 178, exBlackSoft: 46, exWhite: 255, exWhiteSoft: 0, exInvert: 0, exGamma: 0, exBoost: 40, exView: 0 } },
      { name: 'Drop the Darks', colors: [], params: { exChannel: 0, exBlack: 0, exBlackSoft: 0, exWhite: 128, exWhiteSoft: 54, exInvert: 0, exBlur: 1, exChoke: 6, exEdge: 40, exView: 0 } },
      { name: 'Midtone Band', colors: [], params: { exChannel: 0, exBlack: 90, exBlackSoft: 30, exWhite: 175, exWhiteSoft: 30, exInvert: 0, exView: 0 } },
      { name: 'Punch a Hole', colors: [], params: { exChannel: 0, exBlack: 150, exBlackSoft: 40, exWhite: 255, exWhiteSoft: 0, exInvert: 1, exGamma: 0, exView: 0 } },
    ],
    passes: [
      // 1. the key itself, written as a plain matte so the blur can be separable
      { key: 'key', target: 'cA', inputs: { uTexture: 'source' }, fragment: /* glsl */ `
vec4 fx(vec2 uv){
  vec4 s = texture2D(uTexture, uv);
  vec3 c = unpremult(s);
  float m = uParams[0];
  float v;
  if (m < 0.5) v = luma(c);
  else if (m < 1.5) v = c.r;
  else if (m < 2.5) v = c.g;
  else if (m < 3.5) v = c.b;
  else if (m < 4.5) v = s.a;
  else if (m < 5.5) v = max(max(c.r, c.g), c.b);
  else {
    float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
    v = mx <= 0.0001 ? 0.0 : (mx - mn) / mx;
  }
  float bp = uParams[1] / 255.0, bs = uParams[2] / 255.0;
  float wp = uParams[3] / 255.0, ws = uParams[4] / 255.0;
  // Both ends are INCLUSIVE. (1.0 - step(wp, v)) would drop a fully saturated
  // pixel whenever the white point sits at 255, which is the default.
  float lo = bs < 0.002 ? step(bp, v) : smoothstep(bp, bp + bs, v);
  float hi = ws < 0.002 ? step(v, wp) : 1.0 - smoothstep(wp - ws, wp, v);
  float a = clamp(lo * hi, 0.0, 1.0);
  if (uParams[5] > 0.5) a = 1.0 - a;
  if (uParams[13] > 0.5) a *= clamp(s.a, 0.0, 1.0);
  return vec4(a);
}
` },
      // 2/3. separable blur of the matte (mode 2 = alpha only), skipped at radius 0
      { key: 'blurX', target: 'cB', inputs: { uTexture: 'cA' }, fragment: BLUR_FX,
        skipIf: (p) => p.exBlur < 0.05, alias: 'cA',
        set: (p, ctx) => ({ 24: 1, 25: 0, 26: p.exBlur * ctx.ref, 27: 2 }) },
      { key: 'blurY', target: 'cC', inputs: { uTexture: 'cB' }, fragment: BLUR_FX,
        skipIf: (p) => p.exBlur < 0.05, alias: 'cB',
        set: (p, ctx) => ({ 24: 0, 25: 1, 26: p.exBlur * ctx.ref, 27: 2 }) },
      // 4. shape the matte, then apply it
      { key: 'main', target: 'out', main: true, inputs: { uSource: 'source', uTexture1: 'cC' }, fragment: /* glsl */ `
vec4 fx(vec2 uv){
  vec4 s = texture2D(uSource, uv);
  float a = clamp(texture2D(uTexture1, uv).a, 0.0, 1.0);

  // Choke re-thresholds the (blurred) matte — with no blur there is no soft band
  // to slide the pivot through, so choke only bites once Matte Blur is up.
  float choke = uParams[8] / 100.0;
  float edge = clamp(uParams[9] / 100.0, 0.0, 1.0);
  if (abs(choke) > 0.002 || edge > 0.002){
    float piv = clamp(0.5 + choke * 0.48, 0.02, 0.98);
    float soft = mix(0.5, 0.012, edge);
    a = smoothstep(clamp(piv - soft, 0.0, 1.0), clamp(piv + soft, 0.0, 1.0), a);
  }
  float g = uParams[6] / 100.0;
  if (abs(g) > 0.002) a = pow(clamp(a, 0.0, 1.0), exp(-g * 1.6));
  a = clamp(a, 0.0, 1.0);

  float view = uParams[10];
  if (view > 0.5 && view < 1.5) return vec4(vec3(a), 1.0);
  if (view > 1.5){
    vec3 c = unpremult(s);
    float m = uParams[0];
    float v = m < 0.5 ? luma(c) : m < 1.5 ? c.r : m < 2.5 ? c.g : m < 3.5 ? c.b
            : m < 4.5 ? s.a : m < 5.5 ? max(max(c.r, c.g), c.b)
            : (max(max(c.r, c.g), c.b) <= 0.0001 ? 0.0
               : (max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b)) / max(max(c.r, c.g), c.b));
    return vec4(vec3(v), 1.0);
  }

  vec3 col = unpremult(s);
  // Thin smoke/fire keeps its colour but arrives dim once the plate's black is
  // gone; the boost lifts it back toward the value it had at full coverage.
  float boost = clamp(uParams[12] / 100.0, 0.0, 2.0);
  if (boost > 0.002 && a > 0.004) col = mix(col, col / max(a, 0.02), min(boost, 1.0)) * (1.0 + max(0.0, boost - 1.0));
  float tamt = clamp(uParams[11] / 100.0, 0.0, 1.0);
  if (tamt > 0.002) col = mix(col, uColor, tamt);
  return premult(clamp(col, 0.0, 8.0), a);
}
` },
    ],
  },

  {
    id: 'colorama',
    name: 'Colorama (Gradient Map)',
    group: 'Color',
    scopes: ['layer', 'adjustment'],
    animated: true,
    layerMatte: 'clip',
    // Names the gradient param whose stops become the uLUT ramp.
    usesRamp: 'ramp',
    params: [
      // 5–7 exist only on a 3D model rendering in 3D (model3dFx.js): the inspector
      // hides them elsewhere and turning the entry flat resets them.
      { key: 'input', slot: 0, label: 'Input', type: 'select', default: 0, options: [
        { value: 0, label: 'Luminance' }, { value: 1, label: 'Red' }, { value: 2, label: 'Green' },
        { value: 3, label: 'Blue' }, { value: 4, label: 'Alpha' },
        { value: 5, label: 'Height', model3d: true }, { value: 6, label: 'Depth', model3d: true },
        { value: 7, label: 'Facing', model3d: true }] },
      { key: 'phase', slot: 1, label: 'Phase', min: 0, max: 1, step: 0.005, default: 0.05 },
      { key: 'cycle', slot: 2, label: 'Cycle', min: -2, max: 2, step: 0.01, default: 0, suffix: '/s' },
      { key: 'repeat', slot: 3, label: 'Repeat', min: 1, max: 8, step: 1, default: 1, suffix: 'x' },
      { key: 'interpolation', slot: 4, label: 'Interpolation', type: 'select', default: 0, options: [
        { value: 0, label: 'Linear' }, { value: 1, label: 'Smooth' }, { value: 2, label: 'Constant' }] },
      { key: 'preserveLuma', slot: 5, label: 'Preserve Luma', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'preserveAlpha', slot: 6, label: 'Preserve Alpha', type: 'select', default: 1, options: [
        { value: 1, label: 'Yes' }, { value: 0, label: 'No (opaque)' }] },
      { key: 'dither', slot: 7, label: 'Dither', min: 0, max: 100, step: 1, default: 25, suffix: '%' },
      // How the mapped colour meets the pixel it came from. Normal replaces it —
      // what Colorama has always done — so 0 keeps every saved effect identical;
      // the rest composite the ramp against the original, which is how you tint a
      // shot without flattening its detail. Mix still sets how much lands.
      { key: 'blend', slot: 8, label: 'Blend Mode', type: 'select', default: 0, options: [
        { value: 0, label: 'Normal' }, { value: 1, label: 'Multiply' }, { value: 2, label: 'Screen' },
        { value: 3, label: 'Overlay' }, { value: 4, label: 'Soft Light' }, { value: 5, label: 'Add' },
        { value: 6, label: 'Difference' }] },
      // How much of the untouched picture is left in — AE's "Blend With Original".
      // 0 = the blend as computed, 100 = the source frame. It sits beside Blend
      // Mode because that is where you decide the look, and it keyframes on its
      // own track; the card's Mix row reaches the same place from the chain side.
      { key: 'original', slot: 9, label: 'Original', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      // The shared GradientPicker owns the ramp: any number of stops, dragged
      // where you want them, with the same colour popover as every other gradient
      // in the app. Baked to a 256x1 uLUT texture by applyEffectUniforms.
      { key: 'ramp', type: 'gradient', label: 'Gradient', default: RAMPS.midnightMint },
    ],
    colorPresets: [
      { name: 'Midnight Mint', colors: ['#05121f', '#1b6f6a', '#7dd3c0', '#b8ead9', '#f4fff9'], params: { phase: 0.05, cycle: 0, repeat: 1, preserveLuma: 0, dither: 25, ramp: RAMPS.midnightMint } },
      { name: 'Thermal', colors: ['#000010', '#5b0b8a', '#e0355a', '#ffb020', '#fffbe6'], params: { phase: 0.05, cycle: 0, repeat: 1, preserveLuma: 0, dither: 30, ramp: RAMPS.thermal } },
      { name: 'Sunset Metal', colors: ['#1a1026', '#7b3fa0', '#ff7a3c', '#ffd98a', '#2b1a33'], params: { phase: 0.05, cycle: 0, repeat: 1, preserveLuma: 25, dither: 20, ramp: RAMPS.sunsetMetal } },
      { name: 'Infrared', colors: ['#04030a', '#1946c8', '#12d1b0', '#f3ec4a', '#ff2d2d'], params: { phase: 0.05, cycle: 0, repeat: 1, preserveLuma: 0, dither: 35, ramp: RAMPS.infrared } },
      { name: 'Candy Chrome', colors: ['#0b0c18', '#5468ff', '#ff8ad4', '#ffe9a8', '#0b0c18'], params: { phase: 0.05, cycle: 0, repeat: 1, preserveLuma: 40, dither: 20, ramp: RAMPS.candyChrome } },
      { name: 'Blueprint', colors: ['#06183a', '#12417e', '#7fb2ff', '#c8dfff', '#eaf3ff'], params: { phase: 0.05, cycle: 0, repeat: 1, preserveLuma: 0, dither: 15, interpolation: 2, ramp: RAMPS.blueprint } },
    ],
    fragment: /* glsl */ `
vec4 fx(vec2 uv){
  vec4 s = texture2D(uTexture, uv);
  vec3 c = unpremult(s);
  float mode = uParams[0];
  float v = luma(c);
  if (mode > 0.5 && mode < 1.5) v = c.r;
  else if (mode > 1.5 && mode < 2.5) v = c.g;
  else if (mode > 2.5 && mode < 3.5) v = c.b;
  else if (mode > 3.5) v = s.a;

  // Ordered-ish deterministic dither: position only, so a frame always renders
  // identically in preview and export.
  float d = (hash21(fxCoord(uv)) - 0.5) * clamp(uParams[7] / 100.0, 0.0, 1.0) * 0.024;
  float x = fract(v * max(uParams[3], 0.01) + uParams[1] + uTime * uParams[2] + d);
  vec3 g = texture2D(uLUT, vec2(x, 0.5)).rgb;

  float pl = clamp(uParams[5] / 100.0, 0.0, 1.0);
  if (pl > 0.001){
    vec3 relit = g * (luma(c) / max(luma(g), 1e-3));
    g = mix(g, clamp(relit, 0.0, 1.0), pl);
  }
  // Blend with the original. Normal (0) returns the ramp itself; the others
  // composite it against the source colour this pixel was mapped from.
  float bm = uParams[8];
  if (bm > 0.5){
    vec3 b = g;
    if (bm < 1.5)      g = c * b;
    else if (bm < 2.5) g = 1.0 - (1.0 - c) * (1.0 - b);
    else if (bm < 3.5) g = mix(2.0 * c * b, 1.0 - 2.0 * (1.0 - c) * (1.0 - b), step(0.5, c));
    else if (bm < 4.5) g = mix(2.0 * c * b + c * c * (1.0 - 2.0 * b),
                               sqrt(max(c, 0.0)) * (2.0 * b - 1.0) + 2.0 * c * (1.0 - b),
                               step(0.5, b));
    else if (bm < 5.5) g = min(c + b, vec3(1.0));
    else               g = abs(c - b);
    g = clamp(g, 0.0, 1.0);
  }

  // Fade back toward the source colour this pixel started as.
  float ob = clamp(uParams[9] / 100.0, 0.0, 1.0);
  if (ob > 0.001) g = mix(g, c, ob);

  float a = uParams[6] > 0.5 ? s.a : 1.0;
  return premult(g, a);
}
`,
  },

  {
    id: 'halftone',
    name: 'Halftone / Engraving',
    group: 'Print',
    scopes: ['layer', 'adjustment'],
    animated: true,
    layerMatte: 'clip',
    params: [
      { key: 'pattern', slot: 0, label: 'Pattern', type: 'select', default: 0, options: [
        { value: 0, label: 'Dots' }, { value: 1, label: 'Lines' }, { value: 2, label: 'Crosshatch' },
        { value: 3, label: 'CMYK' }, { value: 4, label: 'Engraving' }] },
      { key: 'cellSize', slot: 1, label: 'Cell Size', min: 2, max: 80, step: 0.5, default: 14, suffix: 'px' },
      { key: 'angle', slot: 2, label: 'Angle', min: 0, max: 180, step: 1, default: 22, suffix: '\u00b0' },
      { key: 'contrast', slot: 3, label: 'Contrast', min: 20, max: 300, step: 5, default: 125, suffix: '%' },
      { key: 'channelRotation', slot: 4, label: 'Channel Rot', min: 0, max: 90, step: 1, default: 22, suffix: '\u00b0' },
      { key: 'misregistration', slot: 5, label: 'Misregister', min: 0, max: 20, step: 0.25, default: 0, suffix: 'px' },
      { key: 'edgeDetail', slot: 6, label: 'Edge Detail', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'patternDrift', slot: 7, label: 'Pattern Drift', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'ink', type: 'color', colorSlot: 0, label: 'Ink', default: '#0b0d12' },
      { key: 'paper', type: 'color', colorSlot: 1, label: 'Paper', default: '#f4f1e8' },
    ],
    colorPresets: [
      { name: 'Newspaper', colors: ['#14161c', '#e9e4d6'], params: { pattern: 0, cellSize: 9, angle: 45, contrast: 130, misregistration: 0, edgeDetail: 0, patternDrift: 0 } },
      { name: 'CMYK Print', colors: ['#0b0d12', '#fbf8f2'], params: { pattern: 3, cellSize: 12, angle: 15, contrast: 120, channelRotation: 22, misregistration: 1.5, edgeDetail: 0, patternDrift: 0 } },
      { name: 'Banknote', colors: ['#123024', '#efe9d5'], params: { pattern: 4, cellSize: 7, angle: 30, contrast: 165, misregistration: 0, edgeDetail: 55, patternDrift: 0 } },
      { name: 'Manga Speed', colors: ['#0a0a0c', '#ffffff'], params: { pattern: 1, cellSize: 6, angle: 74, contrast: 210, misregistration: 0, edgeDetail: 70, patternDrift: 32 } },
      { name: 'Risograph', colors: ['#2b3ad6', '#fdf3e3'], params: { pattern: 0, cellSize: 16, angle: 12, contrast: 105, misregistration: 5, edgeDetail: 0, patternDrift: 0 } },
      { name: 'LED Dots', colors: ['#5cff9d', '#05070a'], params: { pattern: 0, cellSize: 22, angle: 0, contrast: 150, misregistration: 0, edgeDetail: 0, patternDrift: 0 } },
    ],
    fragment: /* glsl */ `
float htLum(vec2 uv){
  vec4 s = texture2D(uTexture, uv);
  float l = luma(unpremult(s));
  float ct = max(uParams[3], 0.0) / 100.0;
  return clamp((l - 0.5) * ct + 0.5, 0.0, 1.0);
}
float htEdge(vec2 uv){
  vec2 px = 1.4 / uResolution;
  float l = htLum(uv);
  float dx = abs(htLum(uv + vec2(px.x, 0.0)) - htLum(uv - vec2(px.x, 0.0)));
  float dy = abs(htLum(uv + vec2(0.0, px.y)) - htLum(uv - vec2(0.0, px.y)));
  return clamp((dx + dy) * 3.0, 0.0, 1.0) * clamp(uParams[6] / 100.0, 0.0, 1.0) * (0.4 + l);
}
float htDots(vec2 fc, float ang, float cell, float ink, float aa){
  vec2 p = rot2(ang) * fc;
  vec2 f = fract(p / cell) - 0.5;
  float r = length(f) * 2.0;
  float rad = sqrt(clamp(ink, 0.0, 1.0)) * 1.06;
  return smoothstep(rad + aa, rad - aa, r);
}
float htLines(vec2 fc, float ang, float cell, float ink, float aa, float wobble){
  vec2 p = rot2(ang) * fc;
  float w = wobble > 0.0 ? sin(p.x / cell * 6.2831853) * cell * 0.16 : 0.0;
  float d = abs(fract((p.y + w) / cell) - 0.5) * 2.0;
  return smoothstep(clamp(ink, 0.0, 1.0) + aa, clamp(ink, 0.0, 1.0) - aa, d);
}
vec4 fx(vec2 uv){
  vec4 s = texture2D(uTexture, uv);
  float pattern = uParams[0];
  // The screen is printed on the layer: cells are measured in the layer's own
  // pixels and the grid is phased from its box, so the dots stay put on the
  // artwork while it moves.
  float ref = fxRes().y / 1080.0;
  float cell = max(uParams[1], 1.5) * ref;
  float ang = radians(uParams[2]);
  float aa = clamp(2.6 / cell, 0.02, 0.45);
  float drift = clamp(uParams[7] / 100.0, 0.0, 1.0);
  vec2 fc = fxCoord(uv) + vec2(sin(uTime * 0.63), cos(uTime * 0.47)) * drift * cell * 2.0;
  float mis = uParams[5] * ref;
  vec3 paper = uColors[1];
  vec3 ink = uColors[0];

  if (pattern > 2.5 && pattern < 3.5){
    // CMYK: one screen per channel, each with its own angle + misregistration.
    float rotStep = radians(uParams[4]);
    vec3 col = paper;
    for (int ch = 0; ch < 4; ch++){
      float fch = float(ch);
      float a2 = ang + rotStep * fch;
      vec2 off = vec2(cos(a2 * 2.3), sin(a2 * 1.7)) * mis;
      vec4 sm = sampleClamped(uTexture, uv + fxDir(off / fxRes()));
      vec3 cm = unpremult(sm);
      float ct = max(uParams[3], 0.0) / 100.0;
      cm = clamp((cm - 0.5) * ct + 0.5, 0.0, 1.0);
      float k = 1.0 - max(cm.r, max(cm.g, cm.b));
      float ik = max(1.0 - k, 1e-3);
      vec3 cmy = clamp((vec3(1.0 - k) - cm) / ik, 0.0, 1.0);
      float amt = ch == 0 ? cmy.x : (ch == 1 ? cmy.y : (ch == 2 ? cmy.z : k));
      float cov = htDots(fc + off, a2 + fch * 0.4, cell, amt, aa);
      vec3 inkc = ch == 0 ? vec3(0.05, 0.72, 0.92)
                : (ch == 1 ? vec3(0.90, 0.10, 0.52)
                : (ch == 2 ? vec3(0.98, 0.86, 0.06) : vec3(0.06)));
      col *= mix(vec3(1.0), inkc, cov);
    }
    return premult(col, s.a);
  }

  float l = htLum(uv);
  float amt = clamp(1.0 - l + htEdge(uv), 0.0, 1.0);
  float cov;
  if (pattern < 0.5){
    cov = htDots(fc, ang, cell, amt, aa);
  } else if (pattern < 1.5){
    cov = htLines(fc, ang, cell, amt, aa, 0.0);
  } else if (pattern < 2.5){
    float a1 = htLines(fc, ang, cell, amt * 0.92, aa, 0.0);
    float a2 = htLines(fc, ang + 1.5708, cell, max(amt - 0.42, 0.0) * 0.92, aa, 0.0);
    cov = max(a1, a2);
  } else {
    cov = htLines(fc, ang, cell, amt, aa, 1.0);
  }
  if (mis > 0.01){
    // Off-register second impression, tinted toward the ink's complement.
    vec2 off = vec2(cos(ang + 1.1), sin(ang + 1.1)) * mis;
    float cov2 = pattern < 0.5 ? htDots(fc + off, ang, cell, amt, aa)
                               : htLines(fc + off, ang, cell, amt, aa, pattern > 3.5 ? 1.0 : 0.0);
    vec3 col = mix(paper, vec3(1.0) - ink, cov2 * 0.5);
    col = mix(col, ink, cov);
    return premult(col, s.a);
  }
  return premult(mix(paper, ink, cov), s.a);
}
`,
  },

  /*
   * ── Motion Effects II ─────────────────────────────────────────────────────
   * Ported from html/motion-effects-next-lookdev.html; these are recorded as
   * shipped in PLANS/EFFECTS_REMAINING_ROADMAP.md. New runner
   * facilities these use: `pass.scale` (downsampled targets), `pass.nearest` +
   * `pass.poolSlot` (the jump-flood ping-pong). Deferred vs the prototype:
   * Directional Smear's Follow Motion (needs the runner to hand over the
   * layer's transform velocity) and Vector Field Warp's imported map (needs a
   * media picker + third texture unit, same as Turbulent Displace's).
   */

  {
    id: 'directionalSmear',
    name: 'Directional Smear',
    group: 'Motion',
    scopes: ['layer', 'adjustment'],
    animated: false,
    layerMatte: 'expand',
    params: [
      { key: 'length', slot: 0, label: 'Length', min: 0, max: 600, step: 1, default: 208, suffix: 'px' },
      { key: 'direction', slot: 1, label: 'Direction', min: 0, max: 360, step: 1, default: 64, suffix: '°' },
      { key: 'centerBias', slot: 2, label: 'Center Bias', min: -100, max: 100, step: 1, default: 72, suffix: '%' },
      { key: 'falloff', slot: 3, label: 'Falloff', min: 5, max: 300, step: 5, default: 20, suffix: '%' },
      { key: 'samples', slot: 4, label: 'Samples', min: 8, max: 64, step: 1, default: 24 },
      { key: 'highlightBoost', slot: 5, label: 'Highlight Boost', min: 0, max: 200, step: 1, default: 74, suffix: '%' },
      { key: 'edgeRepeat', slot: 6, label: 'Edge Repeat', type: 'select', default: 0, options: [
        { value: 0, label: 'Transparent' }, { value: 1, label: 'Clamp' }, { value: 2, label: 'Mirror' }] },
    ],
    colorPresets: [
      { name: 'Whip Right', colors: [], params: { length: 260, direction: 0, centerBias: 80, falloff: 70, samples: 40, highlightBoost: 0, edgeRepeat: 0 } },
      { name: 'Vertical Launch', colors: [], params: { length: 340, direction: 90, centerBias: 90, falloff: 55, samples: 44, highlightBoost: 20, edgeRepeat: 0 } },
      { name: 'Soft Drag', colors: [], params: { length: 90, direction: 0, centerBias: 0, falloff: 160, samples: 28, highlightBoost: 0, edgeRepeat: 1 } },
      { name: 'Highlight Streak', colors: [], params: { length: 220, direction: 25, centerBias: 0, falloff: 60, samples: 48, highlightBoost: 160, edgeRepeat: 0 } },
      { name: 'Anime Speed', colors: [], params: { length: 420, direction: 0, centerBias: 70, falloff: 40, samples: 56, highlightBoost: 60, edgeRepeat: 0 } },
      { name: 'Reverse Pull', colors: [], params: { length: 300, direction: 180, centerBias: 85, falloff: 45, samples: 40, highlightBoost: 30, edgeRepeat: 0 } },
    ],
    fragment: /* glsl */ `
vec4 smearTap(vec2 uv, float mode){
  if (mode < 0.5) return sampleClamped(uTexture, uv);            // transparent
  if (mode < 1.5) return texture2D(uTexture, clamp(uv, 0.0, 1.0)); // clamp
  // Mirror tiles in the LAYER's box, so the wrap seam rides the artwork.
  vec2 m = abs(fract(fxLocal(uv) * 0.5) * 2.0 - 1.0);
  return texture2D(uTexture, fxFrame(m));
}
vec4 fx(vec2 uv){
  float ref = fxRes().y / 1080.0;
  float len = uParams[0] * ref;
  if (len < 0.5) return texture2D(uTexture, uv);
  // Direction is authored in the layer's own frame — fxDir keeps the streak
  // stuck to a rotated layer instead of always smearing screen-horizontal.
  vec2 dir = vec2(cos(radians(uParams[1])), sin(radians(uParams[1])));
  float bias = clamp(uParams[2] / 100.0, -1.0, 1.0);
  float fall = max(uParams[3] / 100.0, 0.05);
  float taps = max(5.0, floor(uParams[4] * (uQuality < 0.75 ? 0.5 : 1.0)));
  float boost = uParams[5] / 100.0;
  float edgeMode = uParams[6];
  float t0 = -(0.5 + 0.5 * bias);
  float t1 =  (0.5 - 0.5 * bias);
  float span = max(max(abs(t0), abs(t1)), 1e-3);
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i < 64; i++){
    if (float(i) >= taps) break;
    float k = float(i) / (taps - 1.0);
    float t = mix(t0, t1, k);
    float w = pow(max(1.0 - abs(t) / span, 0.0), 1.0 / fall);
    vec4 s = smearTap(uv + fxDir(dir * (t * len) / fxRes()), edgeMode);
    if (boost > 0.001){
      float l = luma(unpremult(s)) * s.a;
      w *= 1.0 + boost * l * l * 3.0;   // bright pixels drag longer streaks
    }
    acc += s * w;
    ws += w;
  }
  vec4 res = acc / max(ws, 1e-4);
  res.rgb = min(res.rgb, vec3(res.a)); // premultiplied invariant
  return res;
}
`,
  },

  {
    // Ported from html/fast-camera-wiggle-lab.html (the lab is the source of truth
    // for every constant). Camera-shake for shot cuts: fBm noise drives a screen
    // affine (offset / roll / zoom pulse), and because that transform is KNOWN the
    // shutter blur is exact — K sub-frame transforms across the shutter window are
    // sampled and averaged in this one pass. No velocity buffer, no frame history.
    // Amount is the master; keyframe it to spike at a cut and decay.
    id: 'fastCameraWiggle',
    name: 'Fast Camera Wiggle',
    group: 'Motion',
    scopes: ['layer', 'adjustment'],
    animated: true,
    layerMatte: 'expand',
    params: [
      { key: 'amount', slot: 0, label: 'Amount', min: 0, max: 2000, step: 1, default: 140, suffix: '%' },
      { key: 'frequency', slot: 1, label: 'Frequency', min: 0.1, max: 40, step: 0.1, default: 1, suffix: 'Hz' },
      { key: 'roughness', slot: 2, label: 'Roughness', min: 15, max: 90, step: 1, default: 62, suffix: '%' },
      { key: 'xWeight', slot: 3, label: 'X Weight', min: 0, max: 200, step: 1, default: 100, suffix: '%' },
      { key: 'yWeight', slot: 4, label: 'Y Weight', min: 0, max: 200, step: 1, default: 65, suffix: '%' },
      { key: 'rotation', slot: 5, label: 'Rotation', min: 0, max: 180, step: 0.5, default: 7, suffix: '°' },
      { key: 'zoomPulse', slot: 6, label: 'Zoom Pulse', min: 0, max: 60, step: 1, default: 6, suffix: '%' },
      { key: 'seed', slot: 7, label: 'Seed', min: 0, max: 99, step: 1, default: 7 },
      { key: 'shutter', slot: 8, label: 'Shutter', min: 0, max: 720, step: 5, default: 270, suffix: '°' },
      { key: 'samples', slot: 9, label: 'Samples', min: 4, max: 64, step: 1, default: 24 },
      { key: 'phase', slot: 10, label: 'Blur Phase', type: 'select', default: 0, options: [
        { value: 0, label: 'Trailing' }, { value: 1, label: 'Centered' }] },
      { key: 'edges', slot: 11, label: 'Edges', type: 'select', default: 0, options: [
        { value: 0, label: 'Mirror' }, { value: 1, label: 'Zoom to Cover' }, { value: 2, label: 'Transparent' }] },
    ],
    colorPresets: [
      { name: 'Subtle Handheld', colors: [], params: { amount: 18, frequency: 2.6, roughness: 50, xWeight: 100, yWeight: 80, rotation: 1.2, zoomPulse: 1, seed: 7, shutter: 180, samples: 16, phase: 0, edges: 0 } },
      { name: 'Fast Cut', colors: [], params: { amount: 140, frequency: 11, roughness: 62, xWeight: 100, yWeight: 65, rotation: 7, zoomPulse: 6, seed: 7, shutter: 270, samples: 24, phase: 0, edges: 0 } },
      { name: 'Impact', colors: [], params: { amount: 320, frequency: 8, roughness: 55, xWeight: 100, yWeight: 110, rotation: 14, zoomPulse: 16, seed: 7, shutter: 360, samples: 32, phase: 0, edges: 1 } },
      { name: 'Whip Chaos', colors: [], params: { amount: 620, frequency: 17, roughness: 70, xWeight: 160, yWeight: 50, rotation: 28, zoomPulse: 10, seed: 7, shutter: 430, samples: 44, phase: 0, edges: 1 } },
      { name: 'Earthquake MAX', colors: [], params: { amount: 2000, frequency: 24, roughness: 75, xWeight: 130, yWeight: 130, rotation: 60, zoomPulse: 28, seed: 7, shutter: 540, samples: 64, phase: 0, edges: 0 } },
    ],
    fragment: /* glsl */ `
// Bounded-input hash (Hoskins): the lattice index is wrapped at 8192 cells BEFORE
// hashing, so precision never collapses at large uTime x frequency. The wrap is
// seamless — the segment into cell 0 interpolates like any other segment.
float fcwHash(float n){
  n = fract(n * 0.1031 + 0.113);
  n *= n + 33.33;
  n *= n + n;
  return fract(n);
}
float fcwNoise(float t, float seed){
  float i = floor(t), f = fract(t);
  float u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = fcwHash(mod(i, 8192.0) + seed);
  float b = fcwHash(mod(i + 1.0, 8192.0) + seed);
  return mix(a, b, u) * 2.0 - 1.0;
}
float fcwFbm(float t, float seed, float rough){
  float amp = 1.0, f = 1.0, sum = 0.0, norm = 0.0;
  float oct = uQuality < 0.75 ? 2.0 : 4.0;
  for (int o = 0; o < 4; o++){
    if (float(o) >= oct) break;
    sum += amp * fcwNoise(t * f, seed + float(o) * 101.3);
    norm += amp;
    amp *= rough;
    f *= 2.17; // irrational-ish lacunarity: octave periods never align
  }
  return sum / max(norm, 1e-4);
}
vec4 fcwSample(vec2 uv, float edge){
  if (edge < 0.5){
    // Mirror tiles in the LAYER's box (frame in adjustment scope), so the wrap
    // seam rides the artwork. The +0.5 phase keeps [0,1] an identity — without
    // it the whole image samples flipped.
    vec2 m = abs(fract(fxLocal(uv) * 0.5 + 0.5) * 2.0 - 1.0);
    return texture2D(uTexture, fxFrame(m));
  }
  if (edge < 1.5) return texture2D(uTexture, clamp(uv, 0.0, 1.0)); // zoom to cover
  return sampleClamped(uTexture, uv);                              // transparent
}
vec4 fx(vec2 uv){
  float amount = uParams[0] / 100.0;
  if (amount <= 0.0001) return texture2D(uTexture, uv);
  float freq = max(uParams[1], 0.01);
  float rough = clamp(uParams[2] / 100.0, 0.05, 0.95);
  float xw = uParams[3] / 100.0;
  float yw = uParams[4] / 100.0;
  float rotAmt = radians(uParams[5]) * amount;
  float zoomAmt = (uParams[6] / 100.0) * amount;
  float seed = uParams[7] * 13.7;
  float shutter = uParams[8];
  float phase = uParams[10];
  float edge = uParams[11];

  // 0.10 frame-heights of excursion at amount 100 — matches the lab's BASE_OFF.
  float base = 0.10 * amount;
  float offX = base * xw;
  float offY = base * yw;

  // Zoom-to-cover: scale from the amplitude BOUND (not the instantaneous offset,
  // which would pump the zoom with the noise). Same formula as the lab, cap 4x.
  float cover = 1.0;
  if (edge > 0.5 && edge < 1.5){
    float aspect0 = uResolution.x / max(uResolution.y, 1.0);
    float fxw = min(0.45, offX / aspect0);
    float fyh = min(0.45, offY);
    float sOff = max(1.0 / (1.0 - 2.0 * fxw), 1.0 / (1.0 - 2.0 * fyh));
    float r = min(1.5707, abs(rotAmt));
    float sRot = abs(cos(r)) + aspect0 * abs(sin(r));
    float zMin = max(0.3, 1.0 - zoomAmt);
    cover = min(4.0, sOff * sRot / zMin) * 1.02;
  }

  float taps = clamp(floor(uParams[9] + 0.5), 4.0, 64.0);
  if (uQuality < 0.75) taps = max(2.0, floor(taps * 0.5));
  if (shutter < 0.5) taps = 1.0;
  float shutterT = (shutter / 360.0) / 30.0; // 30fps reference, like the lab

  float aspect = uResolution.x / max(uResolution.y, 1.0);
  // Pivot on the layer's own centre (frame centre in adjustment scope), so an
  // off-centre layer shakes in place instead of orbiting the frame.
  vec2 pivot = uFxOrigin;
  vec2 p = (uv - pivot) * vec2(aspect, 1.0);

  // Stratified per-pixel jitter of the tap times turns shutter banding into
  // noise — each pixel samples the true wiggle path at its own phases.
  float j = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);

  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i < 64; i++){
    if (float(i) >= taps) break;
    float f = taps > 1.5 ? (float(i) + j * 0.999) / taps : 0.0;
    float ts = uTime - shutterT * (phase > 0.5 ? (f - 0.5) : f);
    // Per-axis frequency multipliers decorrelate the axes; roll and zoom drift
    // slower than position, which is what reads as a handheld camera.
    float dx = offX * fcwFbm(ts * freq, seed + 11.0, rough);
    float dy = offY * fcwFbm(ts * freq * 1.13, seed + 37.0, rough);
    float rr = rotAmt * fcwFbm(ts * freq * 0.71, seed + 71.0, rough);
    float zz = max(0.15, 1.0 + zoomAmt * fcwFbm(ts * freq * 0.53, seed + 93.0, rough));
    vec2 q = p - vec2(dx, dy);
    float ct = cos(rr), st = sin(rr);
    q = vec2(q.x * ct + q.y * st, -q.x * st + q.y * ct) / (zz * cover);
    vec2 suv = q / vec2(aspect, 1.0) + pivot;
    acc += fcwSample(suv, edge);
    ws += 1.0;
  }
  vec4 res = acc / max(ws, 1e-4);
  res.rgb = min(res.rgb, vec3(res.a)); // premultiplied invariant
  return res;
}
`,
  },

  {
    id: 'lightRays',
    name: 'Light Rays',
    group: 'Light',
    scopes: ['layer', 'adjustment'],
    animated: true,
    layerMatte: 'expand',
    params: [
      { key: 'source', slot: 0, label: 'Source', type: 'select', default: 0, options: [
        { value: 0, label: 'Alpha' }, { value: 1, label: 'Luminance' }, { value: 2, label: 'Highlights' },
        { value: 3, label: 'Behind', model3d: true }] },
      { key: 'originX', slot: 1, label: 'Origin X', min: -0.5, max: 1.5, step: 0.01, default: 0.5 },
      { key: 'originY', slot: 2, label: 'Origin Y', min: -0.5, max: 1.5, step: 0.01, default: 0.85 },
      { key: 'length', slot: 3, label: 'Length', min: 0, max: 100, step: 1, default: 55, suffix: '%' },
      { key: 'density', slot: 4, label: 'Density', min: 0.25, max: 2, step: 0.05, default: 1, suffix: 'x' },
      { key: 'decay', slot: 5, label: 'Decay', min: 0, max: 100, step: 1, default: 55, suffix: '%' },
      { key: 'threshold', slot: 6, label: 'Threshold', min: 0, max: 100, step: 1, default: 40, suffix: '%' },
      { key: 'exposure', slot: 7, label: 'Exposure', min: 0, max: 300, step: 5, default: 120, suffix: '%' },
      { key: 'sourceLevel', slot: 8, label: 'Source Level', min: 0, max: 100, step: 1, default: 100, suffix: '%' },
      { key: 'flicker', slot: 9, label: 'Flicker', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'softness', label: 'Softness', min: 0, max: 40, step: 1, default: 6, suffix: 'px' },
      { key: 'rayColor', type: 'color', label: 'Ray Color', default: '#ffe9c4' },
    ],
    colorPresets: [
      { name: 'Logo Sunrise', colors: ['#ffd98a'], params: { source: 0, originX: 0.5, originY: 1.1, length: 70, density: 1, decay: 45, threshold: 40, exposure: 150, sourceLevel: 100, flicker: 0, softness: 8, rayColor: '#ffd98a' } },
      { name: 'Soft Window', colors: ['#eaf2ff'], params: { source: 2, originX: 0.18, originY: 1.2, length: 85, density: 0.8, decay: 30, threshold: 62, exposure: 90, sourceLevel: 100, flicker: 0, softness: 22, rayColor: '#eaf2ff' } },
      { name: 'Scanner Beam', colors: ['#63ffc9'], params: { source: 0, originX: 0.5, originY: 0.5, length: 30, density: 1.6, decay: 80, threshold: 40, exposure: 220, sourceLevel: 70, flicker: 35, softness: 0, rayColor: '#63ffc9' } },
      { name: 'Volumetric Neon', colors: ['#b95cff'], params: { source: 1, originX: 0.5, originY: 0.5, length: 55, density: 1.2, decay: 60, threshold: 30, exposure: 180, sourceLevel: 100, flicker: 12, softness: 10, rayColor: '#b95cff' } },
      { name: 'White Stage', colors: ['#ffffff'], params: { source: 0, originX: 0.5, originY: -0.3, length: 90, density: 1, decay: 25, threshold: 40, exposure: 130, sourceLevel: 100, flicker: 0, softness: 14, rayColor: '#ffffff' } },
      { name: 'Ember Rays', colors: ['#ff8a3c'], params: { source: 2, originX: 0.5, originY: 0.9, length: 60, density: 1.4, decay: 70, threshold: 55, exposure: 200, sourceLevel: 95, flicker: 20, softness: 4, rayColor: '#ff8a3c' } },
    ],
    passes: [
      // The bright + march + soften passes run at HALF resolution (pass.scale):
      // ray accumulation is soft by construction, and full-res intermediates at
      // 4K are what the roadmap's per-pass-resolution rule exists to avoid.
      { key: 'bright', target: 'rA', scale: 0.5, inputs: { uTexture: 'source', uTexture1: 'matte' }, fragment: /* glsl */ `
vec4 fx(vec2 uv){
  vec4 s = texture2D(uTexture, uv);
  float m = texture2D(uTexture1, uv).a;
  float mode = uParams[0];
  float th = uParams[6] / 100.0;
  vec3 col = unpremult(s);
  float lvl;
  if (mode < 0.5){                       // Alpha: the silhouette emits
    lvl = m;
    col = mix(vec3(1.0), col, clamp(s.a, 0.0, 1.0));
  } else if (mode < 1.5){                // Luminance
    lvl = smoothstep(th, 1.0, luma(col)) * s.a;
  } else {                               // Highlights only
    lvl = smoothstep(max(th, 0.55), 1.0, luma(col)) * s.a;
  }
  return premult(col, lvl);
}
` },
      { key: 'march', target: 'rB', scale: 0.5, inputs: { uTexture: 'rA' }, fragment: /* glsl */ `
vec4 fx(vec2 uv){
  // Origin is authored in the layer's box, so the light source rides the layer.
  vec2 origin = fxFrame(vec2(uParams[1], uParams[2]));
  float lenN = uParams[3] / 100.0;
  float density = max(uParams[4], 0.25);
  float decay = uParams[5] / 100.0;
  float taps = floor((uQuality < 0.75 ? 24.0 : 48.0) * min(density, 1.0) + 0.5);
  taps = max(taps, 8.0);
  vec2 delta = uv - origin;
  // Deterministic per-pixel jitter hides banding between taps.
  float jitter = (hash21(gl_FragCoord.xy) - 0.5) / taps;
  vec4 acc = vec4(0.0);
  float w = 1.0, ws = 0.0;
  for (int i = 0; i < 48; i++){
    if (float(i) >= taps) break;
    float t = (float(i) / taps + jitter) * lenN;
    acc += sampleClamped(uTexture, uv - delta * t) * w;
    ws += w;
    w *= mix(1.0, 0.82, decay);
  }
  return acc / max(ws, 1e-4);
}
` },
      { key: 'softX', target: 'rC', scale: 0.5, inputs: { uTexture: 'rB' }, fragment: BLUR_FX,
        skipIf: (p) => p.softness < 0.5, alias: 'rB',
        set: (p, ctx) => ({ 24: 1, 25: 0, 26: p.softness * ctx.ref * 0.5, 27: 0 }) },
      { key: 'softY', target: 'rD', scale: 0.5, inputs: { uTexture: 'rC' }, fragment: BLUR_FX,
        skipIf: (p) => p.softness < 0.5, alias: 'rC',
        set: (p, ctx) => ({ 24: 0, 25: 1, 26: p.softness * ctx.ref * 0.5, 27: 0 }) },
      { key: 'main', target: 'out', main: true, inputs: { uTexture1: 'rD' }, fragment: /* glsl */ `
vec4 fx(vec2 uv){
  vec4 src = texture2D(uSource, uv);
  vec4 rays = texture2D(uTexture1, uv);
  float expo = uParams[7] / 100.0;
  float flick = uParams[9] / 100.0;
  if (flick > 0.001){
    // Quantised playhead tick, not a clock: export renders the same flicker.
    float f = hash21(vec2(floor(uTime * 24.0), 7.0));
    expo *= 1.0 - flick * 0.65 * f;
  }
  vec3 rc = unpremult(rays) * uColor;
  float ra = clamp(rays.a * expo, 0.0, 2.0);
  float srcLevel = uParams[8] / 100.0;
  vec3 col = unpremult(src) * srcLevel + rc * ra;
  col = clamp(col, 0.0, 1.0);
  float outA = clamp(src.a * srcLevel + ra, 0.0, 1.0);
  return premult(col, outA);
}
` },
    ],
  },

  {
    id: 'longShadow',
    name: 'Long Shadow / Faux Extrude',
    group: 'Graphic',
    // Layer-only: it reads the isolated alpha and paints OUTSIDE the source
    // bounds, which an adjustment layer's opaque below-stack has no room for.
    scopes: ['layer'],
    animated: false,
    layerMatte: 'expand',
    params: [
      { key: 'length', slot: 0, label: 'Length', min: 0, max: 800, step: 2, default: 260, suffix: 'px' },
      { key: 'direction', slot: 1, label: 'Direction', min: 0, max: 360, step: 1, default: 225, suffix: '°' },
      { key: 'style', slot: 2, label: 'Style', type: 'select', default: 0, options: [
        { value: 0, label: 'Solid' }, { value: 1, label: 'Steps' },
        { value: 2, label: 'Gradient' }, { value: 3, label: 'Ribbon' }] },
      { key: 'fade', slot: 3, label: 'Fade', min: 0, max: 100, step: 1, default: 35, suffix: '%' },
      { key: 'perspective', slot: 4, label: 'Perspective', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'stepCount', slot: 5, label: 'Step Count', min: 2, max: 24, step: 1, default: 6 },
      { key: 'sourceLevel', slot: 6, label: 'Source Level', min: 0, max: 100, step: 1, default: 100, suffix: '%' },
      { key: 'composite', slot: 7, label: 'Composite', type: 'select', default: 0, options: [
        { value: 0, label: 'Behind' }, { value: 1, label: 'Over' }] },
      { key: 'softness', label: 'Softness', min: 0, max: 40, step: 1, default: 0, suffix: 'px' },
      { key: 'startColor', type: 'color', colorSlot: 0, label: 'Start Color', default: '#12151d' },
      { key: 'endColor', type: 'color', colorSlot: 1, label: 'End Color', default: '#2d1b4e' },
    ],
    colorPresets: [
      { name: 'Poster Block', colors: ['#101319', '#101319'], params: { length: 320, direction: 225, style: 0, fade: 0, perspective: 0, stepCount: 6, sourceLevel: 100, composite: 0, softness: 0, startColor: '#101319', endColor: '#101319' } },
      { name: 'Sunset Extrude', colors: ['#ff6b4a', '#3a1b5e'], params: { length: 380, direction: 245, style: 2, fade: 30, perspective: 20, stepCount: 6, sourceLevel: 100, composite: 0, softness: 0, startColor: '#ff6b4a', endColor: '#3a1b5e' } },
      { name: 'Isometric', colors: ['#1a2436', '#1a2436'], params: { length: 210, direction: 210, style: 0, fade: 0, perspective: 0, stepCount: 6, sourceLevel: 100, composite: 0, softness: 0, startColor: '#1a2436', endColor: '#1a2436' } },
      { name: 'Hard Steps', colors: ['#ffd166', '#e0355a'], params: { length: 300, direction: 225, style: 1, fade: 45, perspective: 0, stepCount: 5, sourceLevel: 100, composite: 0, softness: 0, startColor: '#ffd166', endColor: '#e0355a' } },
      { name: 'Soft Ribbon', colors: ['#7dd3c0', '#2f7cff'], params: { length: 420, direction: 250, style: 3, fade: 55, perspective: 30, stepCount: 10, sourceLevel: 100, composite: 0, softness: 10, startColor: '#7dd3c0', endColor: '#2f7cff' } },
      { name: 'Infinite Shadow', colors: ['#0c0e14', '#0c0e14'], params: { length: 800, direction: 235, style: 2, fade: 80, perspective: 45, stepCount: 6, sourceLevel: 100, composite: 0, softness: 4, startColor: '#0c0e14', endColor: '#0c0e14' } },
    ],
    passes: [
      { key: 'softX', target: 'sA', inputs: { uTexture: 'matte' }, fragment: BLUR_FX,
        skipIf: (p) => p.softness < 0.5, alias: 'matte',
        set: (p, ctx) => ({ 24: 1, 25: 0, 26: p.softness * ctx.ref, 27: 2 }) },
      { key: 'softY', target: 'sB', inputs: { uTexture: 'sA' }, fragment: BLUR_FX,
        skipIf: (p) => p.softness < 0.5, alias: 'sA',
        set: (p, ctx) => ({ 24: 0, 25: 1, 26: p.softness * ctx.ref, 27: 2 }) },
      { key: 'main', target: 'out', main: true, inputs: { uTexture1: 'sB' }, fragment: /* glsl */ `
vec4 fx(vec2 uv){
  vec4 src = texture2D(uSource, uv);
  float ref = fxRes().y / 1080.0;
  float len = uParams[0] * ref;
  // Direction rides the layer: a rotated title keeps its extrusion angle.
  vec2 dir = vec2(cos(radians(uParams[1])), sin(radians(uParams[1])));
  float style = uParams[2];
  float fade = uParams[3] / 100.0;
  float persp = uParams[4] / 100.0;
  float stepCount = max(uParams[5], 2.0);
  float srcLevel = uParams[6] / 100.0;
  float over = uParams[7];
  float taps = uQuality < 0.75 ? 32.0 : 64.0;

  // March away from the light: nearest occluder distance + total coverage.
  // uTexture1 is the matte, pre-blurred when Softness > 0.
  float cov = 0.0;
  float nearest = 1.0;
  for (int i = 1; i <= 64; i++){
    if (float(i) > taps) break;
    float t = float(i) / taps;
    float d = t * len * (1.0 + persp * t * 1.6);
    float a = sampleClamped(uTexture1, uv - fxDir(dir * d / fxRes())).a;
    cov = max(cov, a);
    if (a > 0.5) nearest = min(nearest, t);
  }

  float shA = cov;
  vec3 shCol;
  if (style < 0.5){                                 // Solid
    shCol = uColors[0];
    shA *= 1.0 - nearest * fade;
  } else if (style < 1.5){                          // Steps
    float q = floor(nearest * stepCount) / stepCount;
    shCol = mix(uColors[0], uColors[1], q);
    shA *= 1.0 - q * fade;
  } else if (style < 2.5){                          // Gradient
    shCol = mix(uColors[0], uColors[1], nearest);
    shA *= 1.0 - nearest * fade;
  } else {                                          // Ribbon
    float band = fract(nearest * stepCount);
    shCol = mix(uColors[0], uColors[1], step(0.5, band));
    shA *= 1.0 - nearest * fade;
  }
  shA = clamp(shA, 0.0, 1.0);

  vec4 shadow = premult(clamp(shCol, 0.0, 1.0), shA);
  vec4 face = src * srcLevel;
  // Behind keeps the face readable (default); Over is for reveal moments.
  if (over > 0.5) return shadow + face * (1.0 - shadow.a);
  return face + shadow * (1.0 - face.a);
}
` },
    ],
  },

  {
    id: 'outlineBands',
    name: 'Animated Outline Bands',
    group: 'Graphic',
    scopes: ['layer', 'adjustment'],
    animated: true,
    layerMatte: 'expand',
    usesRamp: 'ramp',
    params: [
      { key: 'source', slot: 0, label: 'Source', type: 'select', default: 0, options: [
        { value: 0, label: 'Alpha' }, { value: 1, label: 'Luminance' }, { value: 2, label: 'Edges' }] },
      { key: 'threshold', slot: 1, label: 'Threshold', min: 0, max: 100, step: 1, default: 50, suffix: '%' },
      { key: 'spacing', slot: 2, label: 'Spacing', min: 4, max: 200, step: 1, default: 46, suffix: 'px' },
      { key: 'width', slot: 3, label: 'Width', min: 4, max: 100, step: 1, default: 26, suffix: '%' },
      { key: 'offset', slot: 4, label: 'Offset', min: -200, max: 200, step: 1, default: 0, suffix: 'px' },
      { key: 'travelSpeed', slot: 5, label: 'Travel Speed', min: -300, max: 300, step: 2, default: -40, suffix: 'px/s' },
      { key: 'side', slot: 6, label: 'Side', type: 'select', default: 0, options: [
        { value: 0, label: 'Outside' }, { value: 1, label: 'Inside' }, { value: 2, label: 'Both' }] },
      { key: 'bandCount', slot: 7, label: 'Band Count', min: 1, max: 24, step: 1, default: 7 },
      { key: 'coreLevel', slot: 8, label: 'Core Level', min: 0, max: 100, step: 1, default: 100, suffix: '%' },
      { key: 'sourceLevel', slot: 9, label: 'Source Level', min: 0, max: 100, step: 1, default: 100, suffix: '%' },
      { key: 'ramp', type: 'gradient', label: 'Band Gradient', default: RAMPS.bandsDefault },
    ],
    colorPresets: [
      { name: 'Topographic', colors: ['#c9b48a', '#7a8a6a', '#33413f'], params: { source: 0, spacing: 30, width: 14, travelSpeed: 0, side: 0, bandCount: 16, coreLevel: 100, sourceLevel: 100, ramp: RAMPS.bandsTopo } },
      { name: 'Sonar Scan', colors: ['#63ffc9', '#0a2e24'], params: { source: 0, spacing: 70, width: 10, travelSpeed: 120, side: 0, bandCount: 8, coreLevel: 100, sourceLevel: 100, ramp: RAMPS.bandsSonar } },
      { name: 'Energy Shell', colors: ['#ffffff', '#b95cff', '#1a0b2e'], params: { source: 0, spacing: 24, width: 40, travelSpeed: -80, side: 0, bandCount: 5, coreLevel: 100, sourceLevel: 100, ramp: RAMPS.bandsEnergy } },
      { name: 'Sticker Pulse', colors: ['#ffffff', '#ff5c8a'], params: { source: 0, spacing: 40, width: 55, travelSpeed: 60, side: 0, bandCount: 2, coreLevel: 100, sourceLevel: 100, ramp: RAMPS.bandsSticker } },
      { name: 'Blueprint Lines', colors: ['#7fb2ff', '#12417e'], params: { source: 2, threshold: 30, spacing: 22, width: 12, travelSpeed: 0, side: 2, bandCount: 12, coreLevel: 30, sourceLevel: 30, ramp: RAMPS.bandsBlueprint } },
      { name: 'Heat Contours', colors: ['#fffbe6', '#ffb020', '#e0355a'], params: { source: 1, threshold: 45, spacing: 34, width: 30, travelSpeed: 24, side: 2, bandCount: 10, coreLevel: 60, sourceLevel: 60, ramp: RAMPS.bandsHeat } },
    ],
    passes: [
      // Occupancy mask. Alpha reads the matte (the layer's silhouette); Luminance
      // and Edges read the effect input — the adjustment scope's useful modes,
      // since its "matte" is the opaque below-stack.
      { key: 'mask', target: 'obM', inputs: { uTexture: 'source', uTexture1: 'matte' }, fragment: /* glsl */ `
vec4 fx(vec2 uv){
  float mode = uParams[0];
  float th = uParams[1] / 100.0;
  float m;
  if (mode < 0.5){
    m = step(0.5, texture2D(uTexture1, uv).a);
  } else if (mode < 1.5){
    vec4 s = texture2D(uTexture, uv);
    m = step(th, luma(unpremult(s)) * s.a);
  } else {
    vec2 px = 1.4 / uResolution;
    float c = luma(unpremult(texture2D(uTexture, uv)));
    float dx = abs(luma(unpremult(texture2D(uTexture, uv + vec2(px.x, 0.0)))) - c);
    float dy = abs(luma(unpremult(texture2D(uTexture, uv + vec2(0.0, px.y)))) - c);
    m = step(th * 0.25, dx + dy);
  }
  return vec4(m);
}
` },
      { key: 'seed', target: 'j0', nearest: true, inputs: { uTexture: 'obM' }, fragment: JFA_LIB + /* glsl */ `
vec4 fx(vec2 uv){
  vec2 px = 1.0 / uResolution;
  float c = texture2D(uTexture, uv).r;
  // A pixel is an edge seed when any 4-neighbour differs from it.
  float n = texture2D(uTexture, uv + vec2(px.x, 0.0)).r
          + texture2D(uTexture, uv - vec2(px.x, 0.0)).r
          + texture2D(uTexture, uv + vec2(0.0, px.y)).r
          + texture2D(uTexture, uv - vec2(0.0, px.y)).r;
  bool edge = (c > 0.5) ? (n < 3.5) : (n > 0.5);
  return edge ? jfaEnc(uv) : vec4(1.0);
}
` },
      // Jump flood at descending steps, ping-ponging two NEAREST pool slots.
      ...[1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1].map((step, i) => ({
        key: `jf${step}`,
        target: `j${i + 1}`,
        nearest: true,
        poolSlot: (i % 2) + 1,
        inputs: { uTexture: `j${i}` },
        fragment: JFA_LIB + /* glsl */ `
vec4 fx(vec2 uv){
  vec2 px = uParams[26] / uResolution;
  vec4 best = texture2D(uTexture, uv);
  vec2 bp = jfaDec(best);
  float bd = bp.x > 1.001 ? 1e9 : length((uv - bp) * uResolution);
  for (int dy = -1; dy <= 1; dy++){
    for (int dx = -1; dx <= 1; dx++){
      if (dx == 0 && dy == 0) continue;
      vec2 suv = uv + vec2(float(dx), float(dy)) * px;
      if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
      vec4 cand = texture2D(uTexture, suv);
      vec2 cp = jfaDec(cand);
      if (cp.x > 1.001) continue;
      float d = length((uv - cp) * uResolution);
      if (d < bd){ bd = d; best = cand; }
    }
  }
  return best;
}
`,
        set: () => ({ 26: step }),
      })),
      { key: 'main', target: 'out', main: true, inputs: { uTexture1: 'j11', uTexture2: 'obM' }, fragment: JFA_LIB + /* glsl */ `
vec4 fx(vec2 uv){
  vec4 src = texture2D(uSource, uv);
  // Band distances are plate-space by nature (distance FROM the silhouette),
  // so the 1080p reference uses the plate, not the layer box.
  float ref = uResolution.y / 1080.0;
  vec2 near = jfaDec(texture2D(uTexture1, uv));
  if (near.x > 1.001) return src;                    // no edges in frame
  float dist = length((uv - near) * uResolution);
  float inside = texture2D(uTexture2, uv).r;

  float side = uParams[6];
  float sideOk = side < 0.5 ? (1.0 - inside)
               : side < 1.5 ? inside
               : 1.0;
  float spacing = max(uParams[2] * ref, 2.0);
  float count = max(uParams[7], 1.0);
  float travel = uParams[4] * ref + uTime * uParams[5] * ref;
  float reach = step(dist, spacing * count);

  float band = fract((dist + travel) / spacing);
  float width = clamp(uParams[3] / 100.0, 0.02, 1.0);
  float aa = clamp(1.4 / spacing, 0.01, 0.3);
  float line = smoothstep(width * 0.5 + aa, width * 0.5 - aa, abs(band - 0.5));

  vec3 col = texture2D(uLUT, vec2(clamp(dist / (spacing * count), 0.0, 1.0), 0.5)).rgb;
  float bandA = line * sideOk * reach;

  float core = uParams[8] / 100.0;
  float srcLevel = uParams[9] / 100.0;
  vec4 base = src * mix(srcLevel, core, inside);
  vec4 bands = premult(col, bandA);
  return bands + base * (1.0 - bands.a);
}
` },
    ],
  },

  {
    id: 'lensPrism',
    name: 'Lens Prism',
    group: 'Optical',
    scopes: ['layer', 'adjustment'],
    animated: true,
    layerMatte: 'expand',
    params: [
      { key: 'amount', slot: 0, label: 'Amount', min: 0, max: 120, step: 1, default: 34, suffix: 'px' },
      { key: 'direction', slot: 1, label: 'Direction', min: 0, max: 360, step: 1, default: 35, suffix: '°' },
      { key: 'dispersion', slot: 2, label: 'Dispersion', min: 0, max: 100, step: 1, default: 60, suffix: '%' },
      { key: 'spectrumWidth', slot: 3, label: 'Spectrum Width', min: 5, max: 100, step: 1, default: 50, suffix: '%' },
      { key: 'refraction', slot: 4, label: 'Refraction', min: 0, max: 100, step: 1, default: 65, suffix: '%' },
      { key: 'edgeBias', slot: 5, label: 'Edge Bias', min: 0, max: 100, step: 1, default: 70, suffix: '%' },
      { key: 'rotation', slot: 6, label: 'Rotation', min: -180, max: 180, step: 1, default: 0, suffix: '°/s' },
      { key: 'sourceLevel', slot: 7, label: 'Source Level', min: 0, max: 100, step: 1, default: 100, suffix: '%' },
      { key: 'edgeWidth', label: 'Edge Width', min: 4, max: 120, step: 1, default: 40, suffix: 'px' },
    ],
    colorPresets: [
      { name: 'Crystal Edge', colors: [], params: { amount: 30, direction: 35, dispersion: 70, spectrumWidth: 45, refraction: 80, edgeBias: 95, rotation: 0, sourceLevel: 100, edgeWidth: 34 } },
      { name: 'Spectrum Sweep', colors: [], params: { amount: 55, direction: 0, dispersion: 85, spectrumWidth: 70, refraction: 30, edgeBias: 20, rotation: 40, sourceLevel: 100, edgeWidth: 60 } },
      { name: 'Soft Prism', colors: [], params: { amount: 18, direction: 90, dispersion: 45, spectrumWidth: 35, refraction: 50, edgeBias: 50, rotation: 0, sourceLevel: 100, edgeWidth: 80 } },
      { name: 'Diamond Light', colors: [], params: { amount: 70, direction: 130, dispersion: 100, spectrumWidth: 90, refraction: 90, edgeBias: 85, rotation: 12, sourceLevel: 90, edgeWidth: 26 } },
      { name: 'Anamorphic', colors: [], params: { amount: 90, direction: 0, dispersion: 30, spectrumWidth: 25, refraction: 10, edgeBias: 0, rotation: 0, sourceLevel: 100, edgeWidth: 50 } },
      { name: 'Ghost Glass', colors: [], params: { amount: 44, direction: 210, dispersion: 55, spectrumWidth: 55, refraction: 70, edgeBias: 60, rotation: -20, sourceLevel: 70, edgeWidth: 70 } },
    ],
    passes: [
      { key: 'heightX', target: 'pA', inputs: { uTexture: 'matte' }, fragment: BLUR_FX,
        set: (p, ctx) => ({ 24: 1, 25: 0, 26: Math.max(1, p.edgeWidth * ctx.ref), 27: 2 }) },
      { key: 'heightY', target: 'pB', inputs: { uTexture: 'pA' }, fragment: BLUR_FX,
        set: (p, ctx) => ({ 24: 0, 25: 1, 26: Math.max(1, p.edgeWidth * ctx.ref), 27: 1 }) },
      { key: 'main', target: 'out', main: true, inputs: { uTexture: 'source', uTexture1: 'pB' }, fragment: /* glsl */ `
vec3 prismSpectral(float t){
  // Smooth 7-tap spectrum approximation, red → violet.
  vec3 c = vec3(1.0) - pow(abs(vec3(t) - vec3(0.75, 0.5, 0.25)) * 2.4, vec3(2.0));
  return clamp(c, 0.0, 1.0);
}
vec4 fx(vec2 uv){
  vec4 src = texture2D(uSource, uv);
  float ref = uResolution.y / 1080.0;
  vec2 px = vec2(max(2.0, 10.0 * ref)) / uResolution;
  float hx = texture2D(uTexture1, uv + vec2(px.x, 0.0)).r
           - texture2D(uTexture1, uv - vec2(px.x, 0.0)).r;
  float hy = texture2D(uTexture1, uv + vec2(0.0, px.y)).r
           - texture2D(uTexture1, uv - vec2(0.0, px.y)).r;
  vec3 n = normalize(vec3(-hx * 5.0, -hy * 5.0, 1.0));

  float amount = uParams[0] * ref;
  float disp = uParams[2] / 100.0;
  float specW = max(uParams[3] / 100.0, 0.05);
  float refr = uParams[4] / 100.0;
  float edgeBias = uParams[5] / 100.0;
  float ang = radians(uParams[1]) + uTime * radians(uParams[6]);
  vec2 axis = vec2(cos(ang), sin(ang));
  vec2 dirv = normalize(mix(axis, n.xy + axis * 0.15, refr) + 1e-5);
  // Edge Bias gates the effect onto sloped areas (silhouette edges).
  float slope = clamp((1.0 - n.z) * 3.0, 0.0, 1.0);
  float gate = mix(1.0, slope, edgeBias);
  float off = amount * gate;
  if (off < 0.25) return src;

  // Spectral taps spread SYMMETRICALLY about the source position — dispersion
  // fans the wavelengths along the prism axis while refraction pushes the
  // whole bundle along the surface normal. Shifting every tap by the full
  // offset instead reads as a displaced ghost, not an optical edge.
  vec3 acc = vec3(0.0);
  vec3 wsum = vec3(0.0);
  float aSum = 0.0;
  for (int i = 0; i < 7; i++){
    float k = float(i) / 6.0;
    float d = (k - 0.5) * 2.0;
    vec2 suv = uv + (dirv * (off * disp * specW * d) + n.xy * (off * refr * 0.7)) / uResolution;
    vec4 s = sampleClamped(uTexture, suv);
    vec3 w = prismSpectral(k);
    acc += unpremult(s) * w * s.a;
    wsum += w;
    aSum += s.a;
  }
  vec3 col = acc / max(wsum, vec3(1e-4));
  float aAvg = aSum / 7.0;
  float srcLevel = uParams[7] / 100.0;
  vec3 outCol = clamp(mix(unpremult(src) * srcLevel, col, gate), 0.0, 1.0);
  float outA = mix(src.a * srcLevel, aAvg, gate);
  return premult(outCol, outA);
}
` },
    ],
  },

  {
    // Port of html/motion-effects-next-lookdev.html "SDF Lens Blur" (itself a port
    // of github.com/guilanier/codrops-sdf-lensblur applied to raster content): a
    // soft travelling circle — the demo's fill(sdCircle) math verbatim — mixes the
    // sharp input against a ½-res separable blur, so edges melt exactly where the
    // lens passes. The demo's damped mouse becomes deterministic lens paths; a
    // pointer would break the scrub/export agreement every effect here lives by.
    id: 'sdfLensBlur',
    name: 'SDF Lens Blur',
    group: 'Optical',
    scopes: ['layer', 'adjustment'],
    animated: true,
    layerMatte: 'expand',
    params: [
      { key: 'blur', slot: 0, label: 'Blur', min: 0, max: 120, step: 1, default: 48, suffix: 'px' },
      { key: 'lensSize', slot: 1, label: 'Lens Size', min: 5, max: 120, step: 1, default: 30, suffix: '%' },
      { key: 'lensEdge', slot: 2, label: 'Lens Edge', min: 1, max: 100, step: 1, default: 50, suffix: '%' },
      { key: 'mode', slot: 3, label: 'Mode', type: 'select', default: 0, options: [
        { value: 0, label: 'Blur in lens' }, { value: 1, label: 'Focus in lens' }] },
      { key: 'lensPath', slot: 4, label: 'Lens Path', type: 'select', default: 0, options: [
        { value: 0, label: 'Orbit' }, { value: 1, label: 'Figure 8' },
        { value: 2, label: 'Sweep' }, { value: 3, label: 'Manual' }] },
      { key: 'lensSpeed', slot: 5, label: 'Lens Speed', min: -180, max: 180, step: 1, default: 45, suffix: '°/s' },
      { key: 'pathRadius', slot: 6, label: 'Path Radius', min: 0, max: 60, step: 1, default: 26, suffix: '%' },
      { key: 'lensX', slot: 7, label: 'Lens X', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'lensY', slot: 8, label: 'Lens Y', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'magnify', slot: 9, label: 'Magnify', min: 0, max: 40, step: 1, default: 0, suffix: '%' },
    ],
    colorPresets: [
      { name: 'Passing Lens', colors: [], params: { blur: 48, lensSize: 30, lensEdge: 50, mode: 0, lensPath: 0, lensSpeed: 45, pathRadius: 26, lensX: 0.5, lensY: 0.5, magnify: 0 } },
      { name: 'Focus Spot', colors: [], params: { blur: 70, lensSize: 34, lensEdge: 60, mode: 1, lensPath: 1, lensSpeed: 60, pathRadius: 24, lensX: 0.5, lensY: 0.5, magnify: 0 } },
      { name: 'Sweep Defocus', colors: [], params: { blur: 90, lensSize: 45, lensEdge: 70, mode: 0, lensPath: 2, lensSpeed: 80, pathRadius: 40, lensX: 0.5, lensY: 0.5, magnify: 0 } },
      { name: 'Magnifier', colors: [], params: { blur: 16, lensSize: 26, lensEdge: 30, mode: 1, lensPath: 0, lensSpeed: 30, pathRadius: 22, lensX: 0.5, lensY: 0.5, magnify: 25 } },
      { name: 'Soft Drift', colors: [], params: { blur: 36, lensSize: 60, lensEdge: 90, mode: 0, lensPath: 0, lensSpeed: 20, pathRadius: 18, lensX: 0.5, lensY: 0.5, magnify: 0 } },
      { name: 'Manual Spot', colors: [], params: { blur: 60, lensSize: 32, lensEdge: 55, mode: 0, lensPath: 3, lensSpeed: 0, pathRadius: 0, lensX: 0.5, lensY: 0.5, magnify: 0 } },
    ],
    passes: [
      // Max-radius blur at half res; the main pass mixes it in by the lens mask.
      { key: 'blurX', target: 'lA', scale: 0.5, inputs: { uTexture: 'source' }, fragment: BLUR_FX,
        skipIf: (p) => p.blur < 0.5, alias: 'source',
        set: (p, ctx) => ({ 24: 1, 25: 0, 26: p.blur * ctx.ref * 0.5, 27: 0 }) },
      { key: 'blurY', target: 'lB', scale: 0.5, inputs: { uTexture: 'lA' }, fragment: BLUR_FX,
        skipIf: (p) => p.blur < 0.5, alias: 'lA',
        set: (p, ctx) => ({ 24: 0, 25: 1, 26: p.blur * ctx.ref * 0.5, 27: 0 }) },
      { key: 'main', target: 'out', main: true, inputs: { uTexture: 'source', uTexture1: 'lB' }, fragment: /* glsl */ `
float sdlCircle(vec2 st, vec2 c){ return length(st - c) * 2.0; }
float sdlFill(float x, float size, float edge){
  return 1.0 - smoothstep(size - edge, size + edge, x);
}
vec4 fx(vec2 uv){
  // The demo's coord(): min-side-normalised, centred at 0.5 — built in the
  // LAYER's box so the lens rides a moving layer; identity in adjustment scope.
  float ar = fxAspect();
  vec2 asp = ar > 1.0 ? vec2(ar, 1.0) : vec2(1.0, 1.0 / ar);
  vec2 st = (fxLocal(uv) - 0.5) * asp + 0.5;

  // Deterministic lens path; the demo's mouse damping becomes path smoothness.
  float ang = radians(uParams[5]) * uTime;
  vec2 c = vec2(uParams[7], uParams[8]);
  float rad = uParams[6] / 100.0;
  float path = uParams[4];
  vec2 lens;
  if (path < 0.5)      lens = c + vec2(cos(ang), sin(ang)) * rad;             // Orbit
  else if (path < 1.5) lens = c + vec2(sin(ang), sin(ang * 2.0) * 0.5) * rad; // Figure 8
  else if (path < 2.5) lens = vec2(c.x + (abs(fract(ang * 0.15915494) * 2.0 - 1.0) * 2.0 - 1.0) * rad, c.y); // Sweep
  else                 lens = c;                                              // Manual
  vec2 lp = (lens - 0.5) * asp + 0.5;

  // The demo's lens: fill(sdCircle(st, mouse), circleSize, circleEdge).
  float lensRaw = sdlFill(sdlCircle(st, lp), uParams[1] / 100.0, max(uParams[2] / 100.0, 1e-3));
  float lensV = uParams[3] > 0.5 ? 1.0 - lensRaw : lensRaw;

  // Magnify bulges the sampling toward the lens centre (loupe refraction). It
  // follows the physical lens even in Focus mode, hence lensRaw; the bulge is
  // built in st space and mapped back so it stays circular at any aspect.
  float mag = uParams[9] / 100.0;
  vec2 suv = uv;
  if (mag > 0.001){
    vec2 stM = mix(st, lp + (st - lp) / (1.0 + mag), lensRaw);
    suv = fxFrame((stM - 0.5) / asp + 0.5);
  }
  vec4 sharp = sampleClamped(uTexture, suv);
  vec4 soft = sampleClamped(uTexture1, suv);
  return mix(sharp, soft, clamp(lensV, 0.0, 1.0));
}
` },
    ],
  },

  {
    id: 'kaleidoscope',
    name: 'Kaleidoscope / Polar Repeat',
    group: 'Pattern',
    scopes: ['layer', 'adjustment'],
    animated: true,
    layerMatte: 'expand',
    params: [
      { key: 'segments', slot: 0, label: 'Segments', min: 1, max: 24, step: 1, default: 6 },
      { key: 'rotation', slot: 1, label: 'Rotation', min: 0, max: 360, step: 1, default: 0, suffix: '°' },
      { key: 'centerX', slot: 2, label: 'Center X', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'centerY', slot: 3, label: 'Center Y', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'zoom', slot: 4, label: 'Zoom', min: 20, max: 300, step: 1, default: 100, suffix: '%' },
      { key: 'mirror', slot: 5, label: 'Mirror', type: 'select', default: 1, options: [
        { value: 1, label: 'On' }, { value: 0, label: 'Off' }] },
      { key: 'spiral', slot: 6, label: 'Spiral', min: -100, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'radialOffset', slot: 7, label: 'Radial Offset', min: -50, max: 50, step: 1, default: 0, suffix: '%' },
      { key: 'edgeMode', slot: 8, label: 'Edge Mode', type: 'select', default: 1, options: [
        { value: 1, label: 'Mirror tile' }, { value: 0, label: 'Clamp' }] },
      { key: 'autoRotate', slot: 9, label: 'Auto Rotate', min: -90, max: 90, step: 1, default: 0, suffix: '°/s' },
    ],
    colorPresets: [
      { name: 'Sixfold', colors: [], params: { segments: 6, rotation: 0, centerX: 0.5, centerY: 0.5, zoom: 100, mirror: 1, spiral: 0, radialOffset: 0, edgeMode: 1, autoRotate: 0 } },
      { name: 'Diamond Mirror', colors: [], params: { segments: 4, rotation: 45, centerX: 0.5, centerY: 0.5, zoom: 130, mirror: 1, spiral: 0, radialOffset: 0, edgeMode: 1, autoRotate: 0 } },
      { name: 'Infinite Bloom', colors: [], params: { segments: 10, rotation: 0, centerX: 0.5, centerY: 0.5, zoom: 80, mirror: 1, spiral: 22, radialOffset: -8, edgeMode: 1, autoRotate: 6 } },
      { name: 'Spiral Fan', colors: [], params: { segments: 8, rotation: 0, centerX: 0.5, centerY: 0.5, zoom: 110, mirror: 0, spiral: 60, radialOffset: 0, edgeMode: 1, autoRotate: -12 } },
      { name: 'Fashion Wheel', colors: [], params: { segments: 12, rotation: 15, centerX: 0.5, centerY: 0.42, zoom: 160, mirror: 1, spiral: 0, radialOffset: 10, edgeMode: 1, autoRotate: 10 } },
      { name: 'Slow Mandala', colors: [], params: { segments: 16, rotation: 0, centerX: 0.5, centerY: 0.5, zoom: 90, mirror: 1, spiral: -14, radialOffset: 0, edgeMode: 1, autoRotate: 3 } },
    ],
    fragment: /* glsl */ `
vec4 fx(vec2 uv){
  float seg = max(uParams[0], 1.0);
  if (seg < 1.5) return texture2D(uTexture, uv);    // exact bypass at 1
  // The fold happens in the LAYER's own box — a kaleidoscoped layer folds its
  // artwork about its own centre; an adjustment layer folds the frame.
  float ar = fxAspect();
  vec2 c = vec2(uParams[2], uParams[3]);
  vec2 p = (fxLocal(uv) - c) * vec2(ar, 1.0);
  float r = length(p);
  float a = atan(p.y, p.x) + radians(uParams[1]) + uTime * radians(uParams[9]);
  float wedge = 6.2831853 / seg;
  float cell = fract(a / wedge);
  if (uParams[5] > 0.5){
    // Mirror alternate segments: seamless edges instead of hard wrap lines.
    cell = abs(cell * 2.0 - 1.0);
    a = cell * wedge * 0.5;
  } else {
    a = cell * wedge;
  }
  a += r * uParams[6] / 100.0 * 6.0;                // spiral: angle by radius
  r *= 1.0 / max(uParams[4] / 100.0, 0.05);
  r += uParams[7] / 100.0;                          // radial offset
  vec2 q = vec2(cos(a), sin(a)) * r / vec2(ar, 1.0) + c;
  vec2 lq = uParams[8] > 0.5
    ? abs(fract(q * 0.5) * 2.0 - 1.0)               // mirror tile
    : clamp(q, 0.0, 1.0);                           // clamp
  return texture2D(uTexture, fxFrame(lq));
}
`,
  },

  {
    id: 'crtMatrix',
    name: 'CRT Pixel Matrix',
    group: 'Display',
    scopes: ['layer', 'adjustment'],
    animated: true,
    layerMatte: 'expand',
    params: [
      { key: 'display', slot: 0, label: 'Display', type: 'select', default: 0, options: [
        { value: 0, label: 'CRT' }, { value: 1, label: 'RGB Stripe' }, { value: 2, label: 'Aperture Grille' },
        { value: 3, label: 'LED' }, { value: 4, label: 'LCD' }] },
      { key: 'cellSize', slot: 1, label: 'Cell Size', min: 2, max: 40, step: 0.5, default: 19, suffix: 'px' },
      { key: 'scanStrength', slot: 2, label: 'Scan Strength', min: 0, max: 100, step: 1, default: 31, suffix: '%' },
      { key: 'subpixel', slot: 3, label: 'Subpixel', min: 0, max: 100, step: 1, default: 55, suffix: '%' },
      { key: 'beamSoftness', slot: 4, label: 'Beam Softness', min: 0, max: 100, step: 1, default: 40, suffix: '%' },
      { key: 'curvature', slot: 5, label: 'Curvature', min: 0, max: 100, step: 1, default: 25, suffix: '%' },
      { key: 'glow', slot: 6, label: 'Glow', min: 0, max: 100, step: 1, default: 35, suffix: '%' },
      { key: 'flicker', slot: 7, label: 'Flicker', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'rollingBar', slot: 8, label: 'Rolling Bar', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'moire', slot: 9, label: 'Moiré', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
    ],
    colorPresets: [
      { name: 'Broadcast CRT', colors: [], params: { display: 0, cellSize: 5, scanStrength: 65, subpixel: 55, beamSoftness: 40, curvature: 25, glow: 35, flicker: 8, rollingBar: 0, moire: 0 } },
      { name: 'Arcade', colors: [], params: { display: 2, cellSize: 6, scanStrength: 80, subpixel: 80, beamSoftness: 20, curvature: 40, glow: 55, flicker: 0, rollingBar: 0, moire: 0 } },
      { name: 'LED Wall', colors: [], params: { display: 3, cellSize: 16, scanStrength: 0, subpixel: 100, beamSoftness: 0, curvature: 0, glow: 45, flicker: 0, rollingBar: 0, moire: 0 } },
      { name: 'LCD Macro', colors: [], params: { display: 4, cellSize: 22, scanStrength: 20, subpixel: 100, beamSoftness: 10, curvature: 0, glow: 10, flicker: 0, rollingBar: 0, moire: 0 } },
      { name: 'Stadium Board', colors: [], params: { display: 3, cellSize: 26, scanStrength: 0, subpixel: 100, beamSoftness: 0, curvature: 0, glow: 65, flicker: 4, rollingBar: 0, moire: 0 } },
      { name: 'Soft Terminal', colors: [], params: { display: 0, cellSize: 4, scanStrength: 40, subpixel: 30, beamSoftness: 70, curvature: 12, glow: 25, flicker: 5, rollingBar: 22, moire: 0 } },
    ],
    passes: [
      // Base look at full res; the bloom (bright → blur) runs at HALF res and is
      // skipped entirely when Glow is 0 — the composite's glow weight is 0 then,
      // so the aliased stand-in texture contributes nothing.
      { key: 'base', target: 'cA', inputs: { uTexture: 'source' }, fragment: /* glsl */ `
vec2 crtCurve(vec2 uv, float k){
  if (k < 0.001) return uv;
  vec2 p = uv * 2.0 - 1.0;
  p *= 1.0 + k * 0.18 * dot(p, p);
  return p * 0.5 + 0.5;
}
vec4 fx(vec2 uv){
  float display = uParams[0];
  // The matrix is printed on the LAYER: cells live in the layer's own pixel
  // grid (like the halftone screen), so the pattern rides the artwork.
  float ref = fxRes().y / 1080.0;
  float cell = max(uParams[1] * ref, 2.0);
  float curved = uParams[5] / 100.0;
  vec2 cuv = crtCurve(fxLocal(uv), curved);
  if (cuv.x < 0.0 || cuv.x > 1.0 || cuv.y < 0.0 || cuv.y > 1.0) return vec4(0.0);

  // One sample per cell (the "pixel"), softened toward the raw image by beam.
  vec2 fc = cuv * fxRes();
  vec2 cellUv = (floor(fc / cell) + 0.5) * cell / fxRes();
  float beam = uParams[4] / 100.0;
  vec4 sHard = texture2D(uTexture, fxFrame(cellUv));
  vec4 sSoft = texture2D(uTexture, fxFrame(cuv));
  vec4 s = mix(sHard, sSoft, beam * beam);
  float moire = uParams[9] / 100.0;
  if (moire > 0.001){
    // Slight cell-size detune so the matrix beats against the picture.
    float mc = cell * (1.0 + moire * 0.07);
    vec2 mUv = (floor(fc / mc) + 0.5) * mc / fxRes();
    s = mix(s, texture2D(uTexture, fxFrame(mUv)), 0.5 * moire);
  }
  vec3 col = unpremult(s);

  vec2 f = fract(fc / cell);
  float sub = uParams[3] / 100.0;
  vec3 mask = vec3(1.0);
  float aa = clamp(2.0 / cell, 0.04, 0.4);

  if (display < 0.5){                               // CRT: triads + scanline
    float band = floor(f.x * 3.0);
    mask = band < 0.5 ? vec3(1.0, 0.12, 0.12)
         : band < 1.5 ? vec3(0.12, 1.0, 0.12) : vec3(0.12, 0.12, 1.0);
    float scan = 0.5 + 0.5 * sin((cuv.y * fxRes().y / cell) * 6.2831853);
    col *= mix(1.0, 0.45 + 0.55 * scan, uParams[2] / 100.0);
  } else if (display < 1.5){                        // RGB stripe
    float band = floor(f.x * 3.0);
    mask = band < 0.5 ? vec3(1.0, 0.06, 0.06)
         : band < 1.5 ? vec3(0.06, 1.0, 0.06) : vec3(0.06, 0.06, 1.0);
    float gap = smoothstep(0.0, aa, f.y) * smoothstep(1.0, 1.0 - aa, f.y);
    mask *= mix(1.0, gap, uParams[2] / 100.0);
  } else if (display < 2.5){                        // Aperture grille: no rows
    float band = floor(f.x * 3.0);
    mask = band < 0.5 ? vec3(1.0, 0.10, 0.10)
         : band < 1.5 ? vec3(0.10, 1.0, 0.10) : vec3(0.10, 0.10, 1.0);
    float wire = step(0.965, f.y) * uParams[2] / 100.0;   // damper wire
    mask *= 1.0 - wire * 0.8;
  } else if (display < 3.5){                        // LED wall: round emitters
    float d = length(f - 0.5) * 2.0;
    float dot_ = smoothstep(0.9, 0.9 - aa * 3.0, d);
    mask = vec3(dot_);
    col = pow(col, vec3(0.9));                      // LEDs run hot
  } else {                                          // LCD macro: RGB wells
    float band = floor(f.x * 3.0);
    vec3 well = band < 0.5 ? vec3(1.0, 0.04, 0.04)
              : band < 1.5 ? vec3(0.04, 1.0, 0.04) : vec3(0.04, 0.04, 1.0);
    float bx = fract(f.x * 3.0);
    float win = smoothstep(0.06, 0.06 + aa, bx) * smoothstep(0.94, 0.94 - aa, bx)
              * smoothstep(0.08, 0.08 + aa, f.y) * smoothstep(0.92, 0.92 - aa, f.y);
    mask = mix(vec3(0.02), well, win);
  }

  col *= mix(vec3(1.0), mask * 1.9, sub);           // ×1.9 restores mean level

  float roll = uParams[8] / 100.0;
  if (roll > 0.001){
    float bar = fract(cuv.y * 0.7 + uTime * 0.35);
    col *= 1.0 - roll * 0.5 * smoothstep(0.15, 0.0, abs(bar - 0.5) - 0.28);
  }
  float flick = uParams[7] / 100.0;
  if (flick > 0.001){
    col *= 1.0 - flick * 0.3 * hash21(vec2(floor(uTime * 60.0), 3.0));
  }
  return premult(clamp(col, 0.0, 1.0), s.a);
}
` },
      { key: 'bright', target: 'cB', scale: 0.5, inputs: { uTexture: 'cA' },
        skipIf: (p) => p.glow < 0.5, alias: 'cA', fragment: /* glsl */ `
vec4 fx(vec2 uv){
  vec4 s = texture2D(uTexture, uv);
  float l = luma(unpremult(s)) * s.a;
  return s * smoothstep(0.55, 1.0, l);
}
` },
      { key: 'blurX', target: 'cC', scale: 0.5, inputs: { uTexture: 'cB' }, fragment: BLUR_FX,
        skipIf: (p) => p.glow < 0.5, alias: 'cB',
        set: (p, ctx) => ({ 24: 1, 25: 0, 26: Math.max(2, p.cellSize * ctx.ref * 1.2), 27: 0 }) },
      { key: 'blurY', target: 'cD', scale: 0.5, inputs: { uTexture: 'cC' }, fragment: BLUR_FX,
        skipIf: (p) => p.glow < 0.5, alias: 'cC',
        set: (p, ctx) => ({ 24: 0, 25: 1, 26: Math.max(2, p.cellSize * ctx.ref * 1.2), 27: 0 }) },
      { key: 'main', target: 'out', main: true, inputs: { uTexture1: 'cA', uTexture2: 'cD' }, fragment: /* glsl */ `
vec4 fx(vec2 uv){
  vec4 base = texture2D(uTexture1, uv);
  vec4 glow = texture2D(uTexture2, uv);
  float g = uParams[6] / 100.0;
  vec3 col = unpremult(base) * base.a + unpremult(glow) * glow.a * g * 1.4;
  float a = clamp(base.a + glow.a * g, 0.0, 1.0);
  return premult(clamp(col / max(a, 1e-4), 0.0, 1.0), a);
}
` },
    ],
  },

  {
    id: 'vectorFieldWarp',
    name: 'Vector Field Warp',
    group: 'Distortion',
    scopes: ['layer', 'adjustment'],
    animated: true,
    layerMatte: 'expand',
    params: [
      // 'Imported Map' from the prototype needs a media picker + third texture
      // unit — deferred, same as Turbulent Displace's imported map.
      { key: 'field', slot: 0, label: 'Field', type: 'select', default: 0, options: [
        { value: 0, label: 'Flow' }, { value: 1, label: 'Vortex' }, { value: 2, label: 'Attract' },
        { value: 3, label: 'Repel' }, { value: 4, label: 'Directional' }] },
      { key: 'strength', slot: 1, label: 'Strength', min: 0, max: 400, step: 2, default: 90, suffix: 'px' },
      { key: 'scale', slot: 2, label: 'Scale', min: 20, max: 800, step: 5, default: 220, suffix: 'px' },
      { key: 'centerX', slot: 3, label: 'Center X', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'centerY', slot: 4, label: 'Center Y', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'direction', slot: 5, label: 'Direction', min: 0, max: 360, step: 1, default: 0, suffix: '°' },
      { key: 'rotation', slot: 6, label: 'Rotation', min: -100, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'evolution', slot: 7, label: 'Evolution', min: 0, max: 720, step: 2, default: 60, suffix: '°/s' },
      { key: 'advectionSteps', slot: 8, label: 'Advection Steps', min: 1, max: 12, step: 1, default: 6 },
      { key: 'turbulence', slot: 9, label: 'Turbulence', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'pinEdges', slot: 10, label: 'Pin Edges', min: 0, max: 100, step: 1, default: 30, suffix: '%' },
    ],
    colorPresets: [
      { name: 'Magnetic Pull', colors: [], params: { field: 2, strength: 160, scale: 220, centerX: 0.5, centerY: 0.5, direction: 0, rotation: 30, evolution: 0, advectionSteps: 8, turbulence: 18, pinEdges: 30 } },
      { name: 'Liquid Vortex', colors: [], params: { field: 1, strength: 220, scale: 220, centerX: 0.5, centerY: 0.5, direction: 0, rotation: 0, evolution: 40, advectionSteps: 10, turbulence: 25, pinEdges: 25 } },
      { name: 'Silk Flow', colors: [], params: { field: 0, strength: 80, scale: 340, centerX: 0.5, centerY: 0.5, direction: 0, rotation: 0, evolution: 90, advectionSteps: 8, turbulence: 0, pinEdges: 40 } },
      { name: 'Black Hole', colors: [], params: { field: 2, strength: 380, scale: 160, centerX: 0.5, centerY: 0.5, direction: 0, rotation: 80, evolution: 20, advectionSteps: 12, turbulence: 10, pinEdges: 15 } },
      { name: 'Wind Tunnel', colors: [], params: { field: 4, strength: 130, scale: 120, centerX: 0.5, centerY: 0.5, direction: 0, rotation: 0, evolution: 160, advectionSteps: 4, turbulence: 55, pinEdges: 35 } },
      { name: 'Paint Drag', colors: [], params: { field: 0, strength: 200, scale: 150, centerX: 0.5, centerY: 0.5, direction: 0, rotation: 0, evolution: 24, advectionSteps: 12, turbulence: 40, pinEdges: 30 } },
    ],
    fragment: /* glsl */ `
float vfVal(vec2 p, float seed){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i + seed);
  float b = hash21(i + vec2(1.0, 0.0) + seed);
  float c = hash21(i + vec2(0.0, 1.0) + seed);
  float d = hash21(i + vec2(1.0, 1.0) + seed);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float vfFbm(vec2 p, float seed){
  float v = 0.0, amp = 0.5;
  for (int i = 0; i < 4; i++){
    v += vfVal(p, seed + float(i) * 19.7) * amp;
    p = p * 2.03 + 7.1;
    amp *= 0.5;
  }
  return v;
}
vec2 vfCurl(vec2 p, float seed){
  float e = 0.45;
  float n1 = vfFbm(p + vec2(0.0, e), seed);
  float n2 = vfFbm(p - vec2(0.0, e), seed);
  float n3 = vfFbm(p + vec2(e, 0.0), seed);
  float n4 = vfFbm(p - vec2(e, 0.0), seed);
  return vec2(n1 - n2, -(n3 - n4)) * 2.6;
}
vec2 vfField(vec2 uv){
  // The field lives in the layer's own coordinates (like Turbulent Displace),
  // so it is printed on the artwork and travels with it.
  float type = uParams[0];
  float ar = fxAspect();
  vec2 c = vec2(uParams[3], uParams[4]);
  vec2 rel = (fxLocal(uv) - c) * vec2(ar, 1.0);
  float scale = max(uParams[2], 8.0) * (fxRes().y / 1080.0);
  float evo = uTime * radians(uParams[7]);
  vec2 p = fxCoord(uv) / scale + vec2(evo * 0.6, -evo * 0.4);
  vec2 d;
  if (type < 0.5){                                   // Flow: curl noise
    d = vfCurl(p, 3.7);
  } else if (type < 1.5){                            // Vortex
    vec2 t = vec2(-rel.y, rel.x);
    d = normalize(t + 1e-5) * smoothstep(0.9, 0.05, length(rel));
    d = rot2(evo) * d;
  } else if (type < 2.5){                            // Attract
    d = -normalize(rel + 1e-5) * smoothstep(0.9, 0.0, length(rel));
  } else if (type < 3.5){                            // Repel
    d = normalize(rel + 1e-5) * smoothstep(0.9, 0.0, length(rel));
  } else {                                           // Directional
    float a = radians(uParams[5]) + evo * uParams[6] / 100.0;
    d = vec2(cos(a), sin(a));
  }
  float turb = uParams[9] / 100.0;
  if (turb > 0.001) d += vfCurl(p * 1.7 + 31.0, 9.1) * turb;
  float rotAmt = uParams[6] / 100.0;
  if (type < 3.5 && type > 0.5) d = rot2(rotAmt * 1.5) * d;
  return d;
}
vec4 fx(vec2 uv){
  float ref = fxRes().y / 1080.0;
  float strength = uParams[1] * ref;
  if (strength < 0.25) return texture2D(uTexture, uv);
  float steps = max(floor(uParams[8] * (uQuality < 0.75 ? 0.5 : 1.0) + 0.5), 1.0);
  vec2 p = uv;
  // Multi-step advection: each step re-reads the field at the moved position,
  // which is what turns a straight offset into a curved flow line.
  for (int i = 0; i < 12; i++){
    if (float(i) >= steps) break;
    p -= fxDir(vfField(p) * (strength / steps) / fxRes());
  }
  float pin = clamp(uParams[10] / 100.0, 0.0, 1.0);
  if (pin > 0.001){
    float e = 0.5 * pin;
    vec2 lp = fxLocal(uv);
    float k = smoothstep(0.0, e, lp.x) * smoothstep(0.0, e, 1.0 - lp.x)
            * smoothstep(0.0, e, lp.y) * smoothstep(0.0, e, 1.0 - lp.y);
    p = mix(uv, p, k);
  }
  return sampleClamped(uTexture, p);
}
`,
  },

  {
    id: 'pixelStretch',
    name: 'Pixel Stretch',
    group: 'Glitch',
    scopes: ['layer', 'adjustment'],
    animated: true,
    layerMatte: 'expand',
    params: [
      { key: 'direction', slot: 0, label: 'Direction', type: 'select', default: 1, options: [
        { value: 0, label: 'Horizontal' }, { value: 1, label: 'Vertical' }, { value: 2, label: 'Radial' }] },
      { key: 'thresholdLow', slot: 1, label: 'Threshold Low', min: 0, max: 100, step: 1, default: 35, suffix: '%' },
      { key: 'thresholdHigh', slot: 2, label: 'Threshold High', min: 0, max: 100, step: 1, default: 100, suffix: '%' },
      { key: 'span', slot: 3, label: 'Span', min: 10, max: 800, step: 5, default: 240, suffix: 'px' },
      { key: 'jitter', slot: 4, label: 'Jitter', min: 0, max: 100, step: 1, default: 40, suffix: '%' },
      { key: 'bandSize', slot: 5, label: 'Band Size', min: 1, max: 24, step: 1, default: 3, suffix: 'px' },
      { key: 'animate', slot: 6, label: 'Animate Threshold', min: 0, max: 100, step: 1, default: 0, suffix: '%/s' },
      { key: 'flip', slot: 7, label: 'Flip', type: 'select', default: 0, options: [
        { value: 0, label: 'Forward' }, { value: 1, label: 'Reverse' }] },
    ],
    colorPresets: [
      { name: 'Highlight Pull', colors: [], params: { direction: 1, thresholdLow: 55, thresholdHigh: 100, span: 320, jitter: 45, bandSize: 3, animate: 0, flip: 0 } },
      { name: 'Shadow Sort', colors: [], params: { direction: 1, thresholdLow: 0, thresholdHigh: 38, span: 260, jitter: 30, bandSize: 2, animate: 0, flip: 1 } },
      { name: 'Vertical Data', colors: [], params: { direction: 1, thresholdLow: 30, thresholdHigh: 85, span: 500, jitter: 70, bandSize: 1, animate: 8, flip: 0 } },
      { name: 'Radial Burst', colors: [], params: { direction: 2, thresholdLow: 40, thresholdHigh: 100, span: 380, jitter: 55, bandSize: 4, animate: 0, flip: 1 } },
      { name: 'Fashion Glitch', colors: [], params: { direction: 0, thresholdLow: 45, thresholdHigh: 92, span: 200, jitter: 85, bandSize: 6, animate: 14, flip: 0 } },
      { name: 'Fine Threads', colors: [], params: { direction: 1, thresholdLow: 50, thresholdHigh: 100, span: 700, jitter: 90, bandSize: 1, animate: 0, flip: 0 } },
    ],
    // Deliberate naming (the roadmap's honest split): exact pixel SORTING is not
    // a WebGL1 fragment operation — this is the realtime STRETCH approximation.
    // Pixels inside the luminance band hold the colour from where their run
    // entered it, and runs drag their colour past their own end, fading with
    // distance — which is what reads as sorting at motion speeds.
    fragment: /* glsl */ `
float psLum(vec2 uv){
  vec4 s = texture2D(uTexture, uv);
  return luma(unpremult(s)) * s.a;
}
vec4 fx(vec2 uv){
  float ref = fxRes().y / 1080.0;
  float dirMode = uParams[0];
  vec2 d;
  float lane;
  float ar = fxAspect();
  vec2 lp = fxLocal(uv);
  if (dirMode < 0.5){ d = vec2(1.0, 0.0); lane = lp.y; }
  else if (dirMode < 1.5){ d = vec2(0.0, 1.0); lane = lp.x; }
  else {
    vec2 rel = (lp - 0.5) * vec2(ar, 1.0);
    d = normalize(rel + 1e-5);
    lane = atan(rel.y, rel.x) / 6.2831853 + 0.5;
  }
  if (uParams[7] > 0.5) d = -d;

  float animate = uTime * uParams[6] / 100.0;
  float lo = clamp(uParams[1] / 100.0 + sin(animate * 6.2831853) * uParams[6] / 600.0, 0.0, 1.0);
  float hi = clamp(uParams[2] / 100.0, 0.0, 1.0);

  // Quantise the perpendicular coordinate into lanes, jitter span per lane —
  // the ragged thread lengths that make sorting read as sorting.
  float band = max(uParams[5] * ref, 1.0);
  float laneId = floor(lane * fxRes().y / band);
  float jit = 1.0 - uParams[4] / 100.0 * hash21(vec2(laneId, 17.0));
  float span = uParams[3] * ref * jit;

  float taps = uQuality < 0.75 ? 24.0 : 48.0;
  vec2 stepv = fxDir(d * (span / taps) / fxRes());
  float l = psLum(uv);

  if (l >= lo && l <= hi){
    // Inside the band: hold the colour from where this run entered it.
    vec2 origin = uv;
    for (int i = 1; i <= 48; i++){
      if (float(i) > taps) break;
      vec2 suv = uv - stepv * float(i);
      if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
      float sl = psLum(suv);
      if (sl < lo || sl > hi) break;
      origin = suv;
    }
    return texture2D(uTexture, origin);
  }

  // Outside the band: the streak EXTENSION — a run upstream drags its colour
  // past its own end, fading with distance. Without it the effect only
  // re-shuffles the run interior and uniform-bright content barely changes.
  for (int i = 1; i <= 48; i++){
    if (float(i) > taps) break;
    vec2 suv = uv - stepv * float(i);
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
    float sl = psLum(suv);
    if (sl >= lo && sl <= hi){
      float fade = 1.0 - float(i) / taps;
      vec4 s = texture2D(uTexture, suv);
      vec4 cur = texture2D(uTexture, uv);
      return mix(cur, s, fade);
    }
  }
  return texture2D(uTexture, uv);
}
`,
  },

  {
    // Neon Glow — a neon light (hot core + 1/d halo, the neonCursor grade) runs
    // along the LAYER'S OWN OUTLINE, auto-animated by Speed within Trim bounds.
    // Layer scope only: the Player bakes an outline polyline per media type —
    // a shape's real path points, a text/motion layer's traced glyph contours
    // (concatenated left→right, bridges between glyphs intended), an image's
    // traced alpha silhouette, or the media content rect — into uLUT (N×1
    // float, quad-uv points, y up), and hands the pre-integrated run phase in.
    //
    // Reserved uParams: 24 = sample count, 25 = closed, 26/27 = plate px.
    // Runner state (set per effect instance by runEffectChain, NOT authored):
    // 20 = phase (loops), 21 = moving, 22 = hue angle (radians). Speed and Hue
    // Cycle are RATES — their keyframe tracks are INTEGRATED by the Player so a
    // ramp accelerates the light smoothly instead of teleporting it; that is
    // why the shader never reads slots 0/7 for motion.
    id: 'neonGlow',
    name: 'Neon Glow',
    group: 'Glow',
    scopes: ['layer'],
    animated: true,
    layerMatte: 'expand',
    usesPath: true,
    // PRO like Running Glow: free to design and preview, paywalled at render —
    // containsProOverlayEffect in adjustmentEffects.js is the gate.
    pro: true,
    params: [
      { key: 'pathSpeed', slot: 0, label: 'Speed', min: -3, max: 3, step: 0.05, default: 0.35, suffix: 'x' },
      { key: 'pathTrimStart', slot: 1, label: 'Trim Start', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'pathTrimEnd', slot: 2, label: 'Trim End', min: 0, max: 100, step: 1, default: 100, suffix: '%' },
      { key: 'pathTrail', slot: 3, label: 'Trail', min: 1, max: 100, step: 1, default: 40, suffix: '%' },
      { key: 'pathCoreSize', slot: 4, label: 'Core Size', min: 0.5, max: 60, step: 0.5, default: 3, suffix: 'px' },
      { key: 'pathGlowRadius', slot: 5, label: 'Glow Radius', min: 0, max: 200, step: 1, default: 30, suffix: 'px' },
      { key: 'pathIntensity', slot: 6, label: 'Intensity', min: 10, max: 400, step: 5, default: 100, suffix: '%' },
      { key: 'pathHueCycle', slot: 7, label: 'Hue Cycle', min: -360, max: 360, step: 5, default: 0, suffix: '°/s' },
      { key: 'pathSourceLevel', slot: 8, label: 'Layer Opacity', min: 0, max: 100, step: 2, default: 100, suffix: '%' },
      // Bake-side (static: no uParams slot, not keyframable): extra Laplacian
      // smoothing of the baked outline points. Traced text/image contours carry
      // pixel-staircase noise that makes the running light jiggle; relaxing the
      // LUT calms it (high values round glyphs into a looser neon wire).
      { key: 'pathRelax', label: 'Relax Points', min: 0, max: 100, step: 5, default: 0, suffix: '%', static: true },
      { key: 'pathColor1', type: 'color', label: 'Glow Color', default: '#ff00ff' },
    ],
    colorPresets: [
      { name: 'Neon Magenta', colors: ['#ff00ff'], params: { pathSpeed: 0.35, pathTrail: 40, pathCoreSize: 3, pathGlowRadius: 30, pathIntensity: 100, pathHueCycle: 0 } },
      { name: 'Cyan Pulse', colors: ['#22d3ee'], params: { pathSpeed: 0.5, pathTrail: 25, pathCoreSize: 2.5, pathGlowRadius: 45, pathIntensity: 140, pathHueCycle: 0 } },
      { name: 'Ember Trace', colors: ['#ff7a3c'], params: { pathSpeed: 0.2, pathTrail: 60, pathCoreSize: 4, pathGlowRadius: 24, pathIntensity: 90, pathHueCycle: 0 } },
      { name: 'Spectrum Run', colors: ['#ff2d7d'], params: { pathSpeed: 0.35, pathTrail: 35, pathCoreSize: 3, pathGlowRadius: 36, pathIntensity: 120, pathHueCycle: 90 } },
      { name: 'Full Ring', colors: ['#ff00ff'], params: { pathSpeed: 0, pathTrail: 100, pathCoreSize: 3, pathGlowRadius: 34, pathIntensity: 110, pathHueCycle: 0 } },
    ],
    fragment: /* glsl */ `
// One baked outline sample. xy = point in plate uv, z = 1 on the FIRST sample of
// a contour, w = the index of that contour's first sample (so a glyph ring can
// close back onto itself). NEAREST texture — float linear filtering is an
// optional GL extension — so every blend between samples is done here by hand.
vec4 ngSample(float i) {
  float n = uParams[24];
  return texture2D(uLUT, vec2((mod(i, n) + 0.5) / n, 0.5));
}

vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  float n = uParams[24];
  // No baked outline (nothing traceable this frame) or no layer box → exact
  // bypass, never a frame-wide smear.
  if (n < 2.0 || uFxLayer < 0.5) return src;
  bool pathClosed = uParams[25] > 0.5;
  vec2 platePx = vec2(max(uParams[26], 1.0), max(uParams[27], 1.0));

  // The trimmed run range, as arc fractions. A degenerate/inverted trim keeps
  // a sliver rather than vanishing under a half-dragged slider.
  float s = clamp(min(uParams[1], uParams[2]) / 100.0, 0.0, 1.0);
  float e = clamp(max(uParams[2] / 100.0, s + 0.005), 0.0, 1.0);
  float span = max(e - s, 0.005);
  bool fullClosed = pathClosed && span >= 0.999;

  // Head from the pre-integrated phase (slot 20); no motion at all parks it at
  // Trim End so a static lit segment is still authorable.
  float phase = uParams[20];
  float head = uParams[21] < 0.5
    ? e
    : (fullClosed ? fract(phase) : s + fract(phase) * span);
  float trail = clamp(uParams[3] / 100.0, 0.01, 1.0);
  float trailLen = trail * span;
  bool fullLoop = fullClosed && trail >= 0.995;

  // The lit run lives in baked-SEGMENT index space: segment j joins sample j to
  // sample j+1, so the window is one contiguous index range and the light is the
  // exact baked outline clipped to it.
  //
  // It used to be a RESAMPLED window instead — 24 points read at equal arc
  // spacing, threaded with beziers. On a shape that is fine, but a text layer's
  // outline is a dozen glyph contours concatenated, so those 24 points spread
  // over several letters and every one of them SNAPPED across a whole letter gap
  // as it crossed a bridge: the light read as a scribble that trembled the
  // entire time it ran. Walking the real segments removes both the scribble and
  // the tremble — nothing is resampled, so nothing can jump.
  float segTotal = pathClosed ? n : (n - 1.0);
  float a1 = head * segTotal;
  float a0 = a1 - trailLen * segTotal;
  if (fullLoop) a0 = a1 - segTotal;
  if (!fullClosed) {
    // An untrimmed run grows out of Trim Start, so keep a sliver rather than
    // collapsing to nothing on the frame the head sits exactly on it.
    a0 = max(a0, s * segTotal);
    a1 = min(a1, e * segTotal);
    a0 = min(a0, a1 - 1e-4);
  }

  vec2 pos = fxLocal(uv) * platePx;
  float dist = 1e6;

  // n + 2 covers a full lap plus the two part-segments the clip leaves at each
  // end; a shorter trail simply breaks out early.
  const int NG_MAX = 258;
  float first = floor(a0);
  vec4 sa = ngSample(first);
  for (int k = 0; k < NG_MAX; k++) {
    float j = first + float(k);
    if (j >= a1) break;
    vec4 sb = ngSample(j + 1.0);
    // A sample flagged as a contour start begins the NEXT glyph, so the segment
    // arriving there is a bridge across a letter gap. Close the ring we are on
    // instead — back onto its own first sample — which is that glyph's real
    // last edge, and the reason a lit contour has no seam.
    vec2 q1 = sb.z > 0.5 ? ngSample(sa.w).xy : sb.xy;
    float lo = max(j, a0) - j;
    float hi = min(j + 1.0, a1) - j;
    if (hi > lo) {
      vec2 c0 = mix(sa.xy, q1, lo) * platePx;
      vec2 c1 = mix(sa.xy, q1, hi) * platePx;
      vec2 pa = pos - c0;
      vec2 ba = c1 - c0;
      float hseg = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
      dist = min(dist, length(pa - ba * hseg));
    }
    sa = sb;
  }
  dist = max(dist, 0.0);

  float coreR = uParams[4];
  float glowR = uParams[5];
  float inten = uParams[6] / 100.0;
  float srcLevel = uParams[8] / 100.0;

  // The neonCursor grade verbatim, with alpha from the brightest channel so a
  // dark glow colour doesn't stamp an opaque black halo over what's behind.
  vec3 gcol = clamp(hueShift(uColor, uParams[22]), 0.0, 1.0);
  float core = 10.0 * smoothstep(coreR, 0.0, dist);
  float glow = glowR / max(dist, 1e-3) * inten;
  vec3 raw = vec3(core) + glow * gcol;
  vec3 col = pow(1.0 - exp(-raw), vec3(0.4545));
  float aRaw = core + glow * max(gcol.r, max(gcol.g, gcol.b));
  float a = pow(1.0 - exp(-aRaw), 0.4545);

  // Premultiplied "halo over face": the bright core occludes the layer under
  // it, the faint halo lets it show through. rgb stays <= alpha, so webm-alpha
  // export can't fringe.
  vec4 face = src * srcLevel;
  vec4 halo = vec4(min(col * a, vec3(a)), a);
  return halo + face * (1.0 - halo.a);
}
`,
  },

  {
    // Lines Draw — the makio-meshline "follow" trail ported onto the layer's own
    // outline (tuned in html/lines-draw-lab.html; the lab is the source of truth
    // for every constant). Up to three tapered ribbons chase a head that runs
    // along the baked outline; their width AND visible length are driven by the
    // head's SPEED — the meshline accumulation. Speed comes from the derivative
    // of an eased lap progress (AE Smooth by default, the graph editor's exact
    // bezier), so the trail blooms on sprints and collapses to a dot at stops.
    //
    // Shares Neon Glow's entire path infrastructure (usesPath → baked uLUT +
    // slots 24-27). Runner state, computed per instance by linesDrawRunnerState
    // in the Player (deterministic — a pure function of clip time, so range
    // renders cold-start exactly): 20 = head phase (closed outlines wrap via
    // fract, open ones ping-pong Player-side), 23 = speed-derived width factor
    // 0..1 SIGNED with the travel direction. Slots 1/5/6/13 (lap, gain, min
    // width, smooth window) are runner inputs the shader never reads.
    id: 'linesDraw',
    name: 'Lines Draw',
    group: 'Glow',
    scopes: ['layer'],
    animated: true,
    layerMatte: 'expand',
    usesPath: true,
    // PRO like Neon Glow: free to design and preview, paywalled at render.
    pro: true,
    params: [
      { key: 'ldProfile', slot: 0, label: 'Speed Profile', type: 'select', default: 0, primary: true,
        options: LINES_DRAW_PROFILE_OPTIONS },
      // Travel mode is runner-side (slot unused by the shader): one-direction
      // laps restart at the start — with eased profiles the trail has already
      // collapsed there, so the restart reads as a clean re-draw.
      { key: 'ldDirection', slot: 16, label: 'Direction', type: 'select', default: 0, primary: true,
        options: [
          { value: 0, label: 'Forward' },
          { value: 1, label: 'Backward' },
          { value: 2, label: 'Ping-Pong' },
        ] },
      { key: 'ldLapDur', slot: 1, label: 'Lap Duration', min: 0.2, max: 10, step: 0.1, default: 2, suffix: 's' },
      { key: 'ldLines', slot: 2, label: 'Lines', min: 1, max: 8, step: 1, default: 4 },
      { key: 'ldTrail', slot: 3, label: 'Trail', min: 5, max: 100, step: 1, default: 35, suffix: '%' },
      { key: 'ldWidth', slot: 4, label: 'Max Width', min: 1, max: 60, step: 0.5, default: 14, suffix: 'px' },
      { key: 'ldSpeedGain', slot: 5, label: 'Speed Gain', min: 0.1, max: 3, step: 0.05, default: 1, suffix: 'x' },
      { key: 'ldMinWidth', slot: 6, label: 'Min Width', min: 0, max: 40, step: 1, default: 6, suffix: '%' },
      { key: 'ldSmooth', slot: 13, label: 'Width Smooth', min: 0.02, max: 0.5, step: 0.01, default: 0.12, suffix: 's' },
      { key: 'ldTaper', slot: 7, label: 'End Taper', min: 0.02, max: 0.5, step: 0.01, default: 0.12 },
      { key: 'ldSpread', slot: 8, label: 'Line Spread', min: 0, max: 60, step: 1, default: 16, suffix: 'px' },
      { key: 'ldLag', slot: 14, label: 'Line Lag', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'ldRound', slot: 15, label: 'Path Smooth', min: 0, max: 8, step: 0.1, default: 1.5, suffix: '%' },
      { key: 'ldGlow', slot: 9, label: 'Glow Radius', min: 0, max: 120, step: 1, default: 20, suffix: 'px' },
      { key: 'ldIntensity', slot: 10, label: 'Intensity', min: 10, max: 400, step: 5, default: 100, suffix: '%' },
      { key: 'ldHeadBright', slot: 11, label: 'Head Bright', min: 0, max: 100, step: 1, default: 30, suffix: '%' },
      { key: 'ldSourceLevel', slot: 12, label: 'Layer Opacity', min: 0, max: 100, step: 2, default: 100, suffix: '%' },
      { key: 'ldColor1', type: 'color', colorSlot: 0, label: 'Color 1', default: '#00ff88' },
      { key: 'ldColor2', type: 'color', colorSlot: 1, label: 'Color 2', default: '#88ff00' },
      { key: 'ldColor3', type: 'color', colorSlot: 2, label: 'Color 3', default: '#44ff88' },
    ],
    colorPresets: [
      { name: 'Makio', colors: ['#00ff88', '#88ff00', '#44ff88'], params: {} },
      { name: 'Studio', colors: ['#f2c94c', '#6fcf97', '#5b7bfa'], params: {} },
      { name: 'Aurora', colors: ['#63e6b1', '#3f7bff', '#ff4fd8'], params: {} },
      { name: 'Sunset', colors: ['#ff5f3c', '#ffb03a', '#ff2f7e'], params: {} },
      { name: 'Ember', colors: ['#ff7a3c', '#ffc93f', '#ff3d2e'], params: {} },
      { name: 'Ice', colors: ['#9bd8ff', '#3f7bff', '#e6f7ff'], params: {} },
      { name: 'Mono', colors: ['#ffffff', '#d8dee1', '#aeb7ba'], params: {} },
    ],
    fragment: /* glsl */ `
// Arc-length fraction → quad-uv position from the baked outline in uLUT
// (Neon Glow's sampler, same NEAREST + hand-lerp reasoning).
vec2 ldPointAt(float t) {
  float n = uParams[24];
  float fi = uParams[25] > 0.5 ? fract(t) * n : clamp(t, 0.0, 1.0) * (n - 1.0);
  float i0 = floor(fi);
  float f = fi - i0;
  float i1 = i0 + 1.0;
  if (uParams[25] > 0.5) {
    i0 = mod(i0, n);
    i1 = mod(i1, n);
  } else {
    i0 = min(i0, n - 1.0);
    i1 = min(i1, n - 1.0);
  }
  vec2 p0 = texture2D(uLUT, vec2((i0 + 0.5) / n, 0.5)).xy;
  vec2 p1 = texture2D(uLUT, vec2((i1 + 0.5) / n, 0.5)).xy;
  return mix(p0, p1, f);
}

// The lab's widthCallback: taper both ends toward 0.12 over the edge fraction.
float ldTaper(float t) {
  float e = clamp(uParams[7], 0.02, 0.5);
  float w = 1.0;
  if (t < e) w = mix(0.12, 1.0, t / e);
  if (t > 1.0 - e) w = min(w, mix(0.12, 1.0, (1.0 - t) / e));
  return w;
}

vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  float n = uParams[24];
  if (n < 2.0 || uFxLayer < 0.5) return src;
  bool closed = uParams[25] > 0.5;
  vec2 platePx = vec2(max(uParams[26], 1.0), max(uParams[27], 1.0));

  // Signed runner aux: |value| = speed width factor, sign = travel direction
  // along the arc — the trail must stay BEHIND the head on the return leg of a
  // ping-ponging open outline (and through overshoot-profile backtracks).
  float auxRaw = uParams[23];
  float widthF = clamp(abs(auxRaw), 0.0, 1.0);
  float dirS = auxRaw < 0.0 ? -1.0 : 1.0;
  float phase = uParams[20];
  float head = closed ? fract(phase) : clamp(phase, 0.0, 1.0);
  // Width AND visible length both ride the speed factor — the accumulation.
  // No floor beyond the head nub: at a stop the followers have fully caught up
  // and the trail is a dot, exactly like the lab.
  float trail = clamp(uParams[3] / 100.0, 0.02, 1.0) * max(widthF, 0.02);
  float maxW = uParams[4];
  float K = clamp(uParams[2], 1.0, 8.0);
  float spread = uParams[8];
  float lagFrac = uParams[14] / 100.0;
  float glowR = uParams[9];
  float inten = uParams[10] / 100.0;
  float headBright = uParams[11] / 100.0;

  vec2 pos = fxLocal(uv) * platePx;
  const int LD_N = 20;
  vec2 pts[LD_N];
  vec3 lit = vec3(0.0);
  float aRaw = 0.0;

  // Path resampling radius, as an arc fraction: each window sample averages
  // three taps (t-d, t, t+d), a low-pass over the baked outline that rounds
  // REAL polyline corners with radius ~ d x path length. Floored at half a
  // window step so window-sampling corners stay cut even at Path Smooth 0.
  float roundFrac = uParams[15] / 100.0;

  for (int k = 0; k < 8; k++) {
    if (float(k) >= K) break;
    float hk = head - dirS * trail * lagFrac * float(k);
    // The lab's per-line offsets: a FIXED spatial ring around the head, so at
    // a stop every line collapses to ITS OWN point (not one shared pinch).
    // Radius jitter echoes the lab's random(-0.1, 0.1).
    float ang = 6.2831853 * float(k) / max(K, 1.0) + 0.9;
    float rr = K < 1.5 ? 0.0 : spread * (1.0 + 0.25 * sin(float(k) * 12.9898));
    vec2 offVec = vec2(cos(ang), sin(ang)) * rr;
    float d = max(roundFrac, trail * 0.5 / float(LD_N - 1));

    for (int i = 0; i < LD_N; i++) {
      // i = LD_N-1 is the head; the window extends opposite the direction of
      // travel.
      float t = hk - dirS * trail * (1.0 - float(i) / float(LD_N - 1));
      float ta = closed ? t - d : clamp(t - d, 0.0, 1.0);
      float tb = closed ? t : clamp(t, 0.0, 1.0);
      float tc = closed ? t + d : clamp(t + d, 0.0, 1.0);
      vec2 p = ldPointAt(ta) * 0.25 + ldPointAt(tb) * 0.5 + ldPointAt(tc) * 0.25;
      pts[i] = p * platePx + offVec;
    }

    // Signed distance to the variable-width ribbon: per-segment distance minus
    // the taper-interpolated half width at the closest point.
    float best = 1e6;
    float bestFrac = 0.0;
    for (int i = 0; i < LD_N - 1; i++) {
      vec2 pa = pos - pts[i];
      vec2 ba = pts[i + 1] - pts[i];
      float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
      float d = length(pa - ba * h);
      float fr = (float(i) + h) / float(LD_N - 1);
      float wHere = max(0.5 * maxW * widthF * ldTaper(fr), 0.3);
      float m = d - wHere;
      if (m < best) { best = m; bestFrac = fr; }
    }

    // Colours cycle 1→2→3 across the fan, like the lab's palette cycling.
    float km = mod(float(k), 3.0);
    vec3 lineCol = km < 0.5 ? uColors[0] : (km < 1.5 ? uColors[1] : uColors[2]);
    // Brighten toward the head (the lab's lighter-white overlay on the head third).
    float hb = headBright * smoothstep(0.55, 1.0, bestFrac);
    vec3 fillCol = clamp(lineCol + hb, 0.0, 1.0);
    float fill = smoothstep(1.0, -1.0, best);
    float glow = glowR / max(best, 1.0) * inten * 0.12;
    lit += fillCol * fill * 2.0 + lineCol * glow;
    aRaw += fill * 2.0 + glow * max(lineCol.r, max(lineCol.g, lineCol.b));
  }

  // Neon Glow's tonemap + premultiplied "halo over face" composite, so the
  // ribbons occlude where solid and let the layer show through the glow skirt.
  vec3 col = pow(1.0 - exp(-lit), vec3(0.4545));
  float a = pow(1.0 - exp(-aRaw), 0.4545);
  float srcLevel = uParams[12] / 100.0;
  vec4 face = src * srcLevel;
  vec4 halo = vec4(min(col * a, vec3(a)), a);
  return halo + face * (1.0 - halo.a);
}
`,
  },

  {
    id: 'edgeDetect',
    name: 'Edge Detect',
    group: 'Graphic',
    scopes: ['layer', 'adjustment'],
    animated: true,
    layerMatte: 'expand',
    params: [
      { key: 'method', slot: 0, label: 'Detector', type: 'select', default: 0, options: [
        { value: 0, label: 'Gradient' }, { value: 1, label: 'Thin Line (Canny)' },
        { value: 2, label: 'Ink Sketch (XDoG)' }, { value: 3, label: 'Contour Bands' }] },
      { key: 'operator', slot: 1, label: 'Operator', type: 'select', default: 1, options: [
        { value: 0, label: 'Sobel' }, { value: 1, label: 'Scharr' }, { value: 2, label: 'Prewitt' }] },
      { key: 'preBlur', label: 'Pre-blur', min: 0, max: 6, step: 0.1, default: 1, suffix: 'px' },
      { key: 'threshold', slot: 2, label: 'Threshold', min: 0, max: 100, step: 0.5, default: 12, suffix: '%' },
      { key: 'knee', slot: 3, label: 'Edge Softness', min: 0, max: 100, step: 1, default: 35, suffix: '%' },
      { key: 'lowRatio', slot: 4, label: 'Low Ratio', min: 10, max: 95, step: 1, default: 40, suffix: '%' },
      { key: 'linkIter', label: 'Edge Linking', min: 0, max: 4, step: 1, default: 2 },
      { key: 'dogSigma', label: 'Detail Size', min: 0.4, max: 4, step: 0.05, default: 1, suffix: 'px' },
      { key: 'dogK', label: 'Scale Ratio', min: 1.2, max: 3, step: 0.05, default: 1.6, suffix: 'x' },
      { key: 'dogTau', slot: 5, label: 'Sharpen', min: 0, max: 40, step: 0.5, default: 15 },
      { key: 'dogPhi', slot: 6, label: 'Ink Hardness', min: 2, max: 80, step: 1, default: 25 },
      { key: 'dogEps', slot: 7, label: 'Ink Level', min: -20, max: 20, step: 0.5, default: 0 },
      { key: 'bands', slot: 8, label: 'Bands', min: 2, max: 24, step: 1, default: 8 },
      { key: 'thickness', label: 'Thickness', min: 0, max: 8, step: 1, default: 0, suffix: 'px' },
      { key: 'gain', slot: 9, label: 'Intensity', min: 0, max: 300, step: 1, default: 100, suffix: '%' },
      { key: 'colorMode', slot: 10, label: 'Edge Color', type: 'select', default: 0, options: [
        { value: 0, label: 'Flat Color' }, { value: 1, label: 'Source Color' },
        { value: 2, label: 'Direction Hue' }, { value: 3, label: 'Duo Ramp' }] },
      { key: 'invert', slot: 11, label: 'Invert Mask', type: 'select', default: 0, options: [
        { value: 0, label: 'Off' }, { value: 1, label: 'On' }] },
      { key: 'sourceLevel', slot: 12, label: 'Source Level', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
      { key: 'glowInt', slot: 13, label: 'Glow', min: 0, max: 300, step: 1, default: 80, suffix: '%' },
      { key: 'glowRad', label: 'Glow Radius', min: 2, max: 40, step: 0.5, default: 12, suffix: 'px' },
      { key: 'blend', slot: 14, label: 'Blend', type: 'select', default: 0, options: [
        { value: 0, label: 'Normal' }, { value: 1, label: 'Add' }, { value: 2, label: 'Screen' }] },
      { key: 'animMode', slot: 15, label: 'Animate', type: 'select', default: 0, options: [
        { value: 0, label: 'None' }, { value: 1, label: 'Draw On' }, { value: 2, label: 'Scanner' },
        { value: 3, label: 'Flicker' }, { value: 4, label: 'Glow Pulse' }, { value: 5, label: 'Line Boil' }] },
      { key: 'animSpeed', slot: 18, label: 'Anim Speed', min: 0.1, max: 4, step: 0.05, default: 1, suffix: 'x' },
      { key: 'sweepAngle', slot: 16, label: 'Sweep Direction', min: -180, max: 180, step: 1, default: 0, suffix: '°' },
      { key: 'sweepSoft', slot: 17, label: 'Sweep Softness', min: 0, max: 40, step: 1, default: 10, suffix: '%' },
      { key: 'edgeColor', type: 'color', colorSlot: 0, label: 'Edge Color', default: '#ffffff' },
      { key: 'edgeColor2', type: 'color', colorSlot: 1, label: 'Duo Color B', default: '#3d8dff' },
    ],
    colorPresets: [
      { name: 'Neon Wire', colors: ['#4de3ff', '#3d8dff'], params: { method: 1, operator: 1, preBlur: 1, threshold: 12, knee: 35, lowRatio: 40, linkIter: 2, dogSigma: 1, dogK: 1.6, dogTau: 15, dogPhi: 25, dogEps: 0, bands: 8, thickness: 1, gain: 100, colorMode: 0, invert: 0, sourceLevel: 0, glowInt: 150, glowRad: 16, blend: 0, animMode: 0, animSpeed: 1, sweepAngle: -35, sweepSoft: 10, edgeColor: '#4de3ff', edgeColor2: '#3d8dff' } },
      { name: 'Outline Pop', colors: ['#ffffff', '#3d8dff'], params: { method: 0, operator: 1, preBlur: 1, threshold: 15, knee: 25, lowRatio: 40, linkIter: 2, dogSigma: 1, dogK: 1.6, dogTau: 15, dogPhi: 25, dogEps: 0, bands: 8, thickness: 2, gain: 100, colorMode: 0, invert: 0, sourceLevel: 100, glowInt: 120, glowRad: 10, blend: 1, animMode: 0, animSpeed: 1, sweepAngle: 0, sweepSoft: 10, edgeColor: '#ffffff', edgeColor2: '#3d8dff' } },
      { name: 'Ink Sketch', colors: ['#1a1614', '#3d8dff'], params: { method: 2, operator: 1, preBlur: 1, threshold: 12, knee: 35, lowRatio: 40, linkIter: 2, dogSigma: 1, dogK: 1.6, dogTau: 15, dogPhi: 25, dogEps: -3, bands: 8, thickness: 0, gain: 100, colorMode: 0, invert: 0, sourceLevel: 10, glowInt: 0, glowRad: 12, blend: 0, animMode: 0, animSpeed: 1, sweepAngle: 0, sweepSoft: 10, edgeColor: '#1a1614', edgeColor2: '#3d8dff' } },
      { name: 'HUD Scanner', colors: ['#ffb04d', '#3d8dff'], params: { method: 1, operator: 1, preBlur: 1, threshold: 10, knee: 35, lowRatio: 40, linkIter: 2, dogSigma: 1, dogK: 1.6, dogTau: 15, dogPhi: 25, dogEps: 0, bands: 8, thickness: 0, gain: 100, colorMode: 0, invert: 0, sourceLevel: 35, glowInt: 110, glowRad: 8, blend: 0, animMode: 0, animSpeed: 1, sweepAngle: 0, sweepSoft: 10, edgeColor: '#ffb04d', edgeColor2: '#3d8dff' } },
      { name: 'Topographic', colors: ['#e8c76a', '#3d8dff'], params: { method: 3, operator: 1, preBlur: 2.5, threshold: 12, knee: 35, lowRatio: 40, linkIter: 2, dogSigma: 1, dogK: 1.6, dogTau: 15, dogPhi: 25, dogEps: 0, bands: 12, thickness: 0, gain: 100, colorMode: 0, invert: 0, sourceLevel: 0, glowInt: 45, glowRad: 6, blend: 0, animMode: 0, animSpeed: 1, sweepAngle: 0, sweepSoft: 10, edgeColor: '#e8c76a', edgeColor2: '#3d8dff' } },
      { name: 'Prism Flow', colors: ['#ffffff', '#3d8dff'], params: { method: 0, operator: 1, preBlur: 1, threshold: 11, knee: 60, lowRatio: 40, linkIter: 2, dogSigma: 1, dogK: 1.6, dogTau: 15, dogPhi: 25, dogEps: 0, bands: 8, thickness: 1, gain: 100, colorMode: 2, invert: 0, sourceLevel: 0, glowInt: 160, glowRad: 16, blend: 0, animMode: 0, animSpeed: 1, sweepAngle: 0, sweepSoft: 10, edgeColor: '#ffffff', edgeColor2: '#3d8dff' } },
      { name: 'Electric Ghost', colors: ['#9fd8ff', '#3d8dff'], params: { method: 1, operator: 1, preBlur: 1, threshold: 10, knee: 35, lowRatio: 40, linkIter: 4, dogSigma: 1, dogK: 1.6, dogTau: 15, dogPhi: 25, dogEps: 0, bands: 8, thickness: 0, gain: 100, colorMode: 0, invert: 0, sourceLevel: 55, glowInt: 150, glowRad: 18, blend: 2, animMode: 0, animSpeed: 1, sweepAngle: 0, sweepSoft: 10, edgeColor: '#9fd8ff', edgeColor2: '#3d8dff' } },
    ],
    passes: [
      // Pre-blur (XDoG uses its own sigma; radius ≈ 2.2σ for BLUR_FX's window).
      { key: 'blurX', target: 'bA', poolSlot: 0, inputs: { uTexture: 'source' }, fragment: BLUR_FX,
        skipIf: (p) => edSigA(p) < 0.05, alias: 'source',
        set: (p, ctx) => ({ 24: 1, 25: 0, 26: edSigA(p) * 2.2 * ctx.ref, 27: 0 }) },
      { key: 'blurY', target: 'bB', poolSlot: 1, inputs: { uTexture: 'bA' }, fragment: BLUR_FX,
        skipIf: (p) => edSigA(p) < 0.05, alias: 'bA',
        set: (p, ctx) => ({ 24: 0, 25: 1, 26: edSigA(p) * 2.2 * ctx.ref, 27: 0 }) },
      // The second, wider Gaussian of the DoG pair.
      { key: 'blur2X', target: 'b2A', poolSlot: 2, inputs: { uTexture: 'source' }, fragment: BLUR_FX,
        skipIf: (p) => Math.round(p.method) !== 2, alias: 'bB',
        set: (p, ctx) => ({ 24: 1, 25: 0, 26: p.dogSigma * p.dogK * 2.2 * ctx.ref, 27: 0 }) },
      { key: 'blur2Y', target: 'b2B', poolSlot: 3, inputs: { uTexture: 'b2A' }, fragment: BLUR_FX,
        skipIf: (p) => Math.round(p.method) !== 2, alias: 'b2A',
        set: (p, ctx) => ({ 24: 0, 25: 1, 26: p.dogSigma * p.dogK * 2.2 * ctx.ref, 27: 0 }) },
      // Gradient field — needed by Gradient/Canny, and by Direction-hue coloring
      // regardless of detector.
      { key: 'grad', target: 'grd', poolSlot: 4, inputs: { uTexture: 'bB' }, fragment: ED_GRAD_FX,
        skipIf: (p) => (Math.round(p.method) === 2 || Math.round(p.method) === 3) && Math.round(p.colorMode) !== 2,
        alias: 'bB' },
      { key: 'edge', target: 'edg', poolSlot: 5,
        inputs: { uTexture: 'grd', uTexture1: 'bB', uTexture2: 'b2B' }, fragment: ED_EDGE_FX },
      // Canny hysteresis: up to four one-pixel growth steps, then the resolve
      // pass promotes rescued weak pixels and deletes the rest.
      { key: 'lk1', target: 'lA', poolSlot: 0, inputs: { uTexture: 'edg' }, fragment: ED_LINK_FX,
        skipIf: (p) => Math.round(p.method) !== 1 || Math.round(p.linkIter) < 1, alias: 'edg',
        set: () => ({ 27: 0 }) },
      { key: 'lk2', target: 'lB', poolSlot: 2, inputs: { uTexture: 'lA' }, fragment: ED_LINK_FX,
        skipIf: (p) => Math.round(p.method) !== 1 || Math.round(p.linkIter) < 2, alias: 'lA',
        set: () => ({ 27: 0 }) },
      { key: 'lk3', target: 'lC', poolSlot: 0, inputs: { uTexture: 'lB' }, fragment: ED_LINK_FX,
        skipIf: (p) => Math.round(p.method) !== 1 || Math.round(p.linkIter) < 3, alias: 'lB',
        set: () => ({ 27: 0 }) },
      { key: 'lk4', target: 'lD', poolSlot: 2, inputs: { uTexture: 'lC' }, fragment: ED_LINK_FX,
        skipIf: (p) => Math.round(p.method) !== 1 || Math.round(p.linkIter) < 4, alias: 'lC',
        set: () => ({ 27: 0 }) },
      // poolSlot 3 is free here: the DoG blur pair that owns it never runs on
      // the Canny path, and every link step writes 0/2 — reading lA or lC while
      // writing 0 would be a same-target feedback loop.
      { key: 'res', target: 'msk', poolSlot: 3, inputs: { uTexture: 'lD' }, fragment: ED_LINK_FX,
        skipIf: (p) => Math.round(p.method) !== 1, alias: 'lD',
        set: () => ({ 27: 1 }) },
      // Thickness: separable dilation. The mask rides all four channels, so the
      // alpha-keyed morph grows it and the colour channels come along.
      { key: 'dilX', target: 'dlA', poolSlot: 2, inputs: { uTexture: 'msk' }, fragment: MORPH_FX,
        skipIf: (p) => p.thickness < 0.5, alias: 'msk',
        set: (p, ctx) => ({ 24: 1, 25: 0, 26: p.thickness * ctx.ref, 27: -1 }) },
      { key: 'dilY', target: 'dlB', poolSlot: 0, inputs: { uTexture: 'dlA' }, fragment: MORPH_FX,
        skipIf: (p) => p.thickness < 0.5, alias: 'dlA',
        set: (p, ctx) => ({ 24: 0, 25: 1, 26: p.thickness * ctx.ref, 27: -1 }) },
      // Glow: half-res separable blur of the finished mask.
      { key: 'glowX', target: 'glA', poolSlot: 0, scale: 0.5, inputs: { uTexture: 'dlB' }, fragment: BLUR_FX,
        skipIf: (p) => p.glowInt < 0.5, alias: 'dlB',
        set: (p, ctx) => ({ 24: 1, 25: 0, 26: p.glowRad * ctx.ref * 0.5, 27: 0 }) },
      { key: 'glowY', target: 'glB', poolSlot: 1, scale: 0.5, inputs: { uTexture: 'glA' }, fragment: BLUR_FX,
        skipIf: (p) => p.glowInt < 0.5, alias: 'glA',
        set: (p, ctx) => ({ 24: 0, 25: 1, 26: p.glowRad * ctx.ref * 0.5, 27: 0 }) },
      { key: 'main', target: 'out', main: true,
        inputs: { uTexture1: 'dlB', uTexture2: 'glB', uTexture3: 'grd' }, fragment: ED_MAIN_FX },
    ],
  },
];
